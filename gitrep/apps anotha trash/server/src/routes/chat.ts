import { Router, type Request, type Response } from "express";
import { supabase } from "../lib/supabase";
import { runAgent, type HistoryEntry, type DOMSnapshot, type AgentAction } from "../lib/agent";

const router = Router();

// ═══════════════════════════════════════════════════════════════════════════════
// GET /history — Load conversation for widget restore
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/history", async (req: Request, res: Response) => {
  const { siteKey, conversationId } = req.query;

  if (!siteKey || !conversationId) {
    res.status(400).json({ error: "siteKey and conversationId required" });
    return;
  }

  try {
    const { data: site } = await supabase
      .from("sites")
      .select("id")
      .eq("site_key", siteKey)
      .single();

    if (!site) {
      res.status(404).json({ error: "Site not found" });
      return;
    }

    const { data: conv } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .eq("site_id", site.id)
      .single();

    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const { data: messages } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    // Format for widget display
    const formatted: Array<{ role: string; content?: string; action?: { description: string } }> = [];

    for (const m of messages ?? []) {
      if (m.role === "goal") {
        formatted.push({ role: "user", content: m.content as string });
      } else if (m.role === "action") {
        try {
          const parsed = JSON.parse(m.content as string) as AgentAction;
          if (parsed.action === "complete") {
            formatted.push({ role: "assistant", content: parsed.result || "Done" });
          } else {
            formatted.push({ role: "action", action: { description: parsed.description } });
          }
        } catch {
          // Skip malformed
        }
      } else if (m.role === "message") {
        formatted.push({ role: "assistant", content: m.content as string });
      }
    }

    res.json({ messages: formatted });
  } catch (err) {
    console.error("[chat/history] error:", err);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST / — Main agent endpoint
// ═══════════════════════════════════════════════════════════════════════════════

interface ChatRequest {
  siteKey: string;
  visitorId: string;
  conversationId?: string;
  // First turn: user sends goal + initial DOM
  goal?: string;
  dom?: { url: string; title: string; elements: string[] };
  // Subsequent turns: widget sends observation
  observation?: {
    actionResult: { success: boolean; error?: string };
    dom: { url: string; title: string; elements: string[] };
  };
}

router.post("/", async (req: Request, res: Response) => {
  const { siteKey, visitorId, conversationId: inputConvId, goal, dom: initialDom, observation } = req.body as ChatRequest;

  if (!siteKey || !visitorId) {
    res.status(400).json({ error: "siteKey and visitorId required" });
    return;
  }

  const isFirstTurn = !!goal;
  const isContinuation = !!observation;

  if (!isFirstTurn && !isContinuation) {
    res.status(400).json({ error: "goal or observation required" });
    return;
  }

  try {
    // 1. Look up site
    const { data: site } = await supabase
      .from("sites")
      .select("id")
      .eq("site_key", siteKey)
      .single();

    if (!site) {
      res.status(404).json({ error: "Site not found" });
      return;
    }

    // 2. Get or create conversation
    let conversationId = inputConvId ?? null;

    if (!conversationId) {
      const { data: newConv } = await supabase
        .from("conversations")
        .insert({ site_id: site.id, visitor_id: visitorId, status: "active" })
        .select("id")
        .single();

      if (!newConv) {
        res.status(500).json({ error: "Failed to create conversation" });
        return;
      }
      conversationId = newConv.id as string;
    } else {
      // Verify conversation belongs to this site
      const { data: existing } = await supabase
        .from("conversations")
        .select("id")
        .eq("id", conversationId)
        .eq("site_id", site.id)
        .single();

      if (!existing) {
        res.status(403).json({ error: "Conversation not found" });
        return;
      }
    }

    // 3. Load existing messages
    const { data: messageRows } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    const rows = messageRows ?? [];

    // 4. Get the goal (from first message or current request)
    let currentGoal: string;
    if (isFirstTurn) {
      currentGoal = goal!;
      // Store the goal
      await supabase.from("messages").insert({
        conversation_id: conversationId,
        role: "goal",
        content: currentGoal,
      });
    } else {
      // Find existing goal
      const goalRow = rows.find((r) => r.role === "goal");
      if (!goalRow) {
        res.status(400).json({ error: "No goal found for conversation" });
        return;
      }
      currentGoal = goalRow.content as string;

      // Store the observation (compact format, no DOM)
      const obs = observation!;
      const obsContent = obs.actionResult.success
        ? `✓ action completed | now at ${obs.dom.url}`
        : `✗ action failed: ${obs.actionResult.error || "unknown"} | at ${obs.dom.url}`;

      await supabase.from("messages").insert({
        conversation_id: conversationId,
        role: "observation",
        content: obsContent,
      });
    }

    // 5. Build clean history for LLM (NO DOM — just goal + action/result pairs)
    const history: HistoryEntry[] = [];
    let turn = 1;

    for (const row of rows) {
      const role = row.role as string;
      const content = row.content as string;

      if (role === "goal") {
        // Skip — goal goes in the current context
      } else if (role === "action") {
        // Assistant's action
        try {
          const parsed = JSON.parse(content) as AgentAction;
          history.push({
            role: "assistant",
            content: JSON.stringify({ action: parsed }),
          });
        } catch {
          // Skip malformed
        }
        turn++;
      } else if (role === "observation") {
        // Observation from widget
        history.push({ role: "user", content: `OBSERVATION: ${content}` });
      } else if (role === "message") {
        // Agent message to user
        history.push({ role: "assistant", content: `MESSAGE: ${content}` });
      }
    }

    // Add current observation if this is a continuation
    if (isContinuation) {
      const obs = observation!;
      const obsContent = obs.actionResult.success
        ? `✓ action completed`
        : `✗ action failed: ${obs.actionResult.error || "unknown"}`;
      history.push({ role: "user", content: `OBSERVATION: ${obsContent}` });
    }

    // 6. Get DOM for current turn (DOM only appears HERE, never in stored history)
    let dom: DOMSnapshot;
    if (isContinuation) {
      dom = observation!.dom;
    } else if (initialDom) {
      dom = initialDom;
    } else {
      // No DOM provided — can't do much
      res.json({
        conversationId,
        action: null,
        message: "I can see your message, but I need to see the page to help. Please try again.",
        done: true,
      });
      return;
    }

    console.log("\n[chat] ════════════════════════════════════════════════");
    console.log(`[chat] ${isFirstTurn ? "NEW GOAL" : `TURN ${turn}`}: ${currentGoal.slice(0, 50)}`);
    console.log(`[chat] history: ${history.length} entries | elements: ${dom.elements.length}`);
    console.log("[chat] ════════════════════════════════════════════════");

    // 7. Check turn limit
    if (turn > 10) {
      const failAction: AgentAction = {
        action: "complete",
        description: "Turn limit reached",
        result: "I couldn't complete this task in the allowed steps. Please try breaking it into smaller steps.",
      };

      await supabase.from("messages").insert({
        conversation_id: conversationId,
        role: "action",
        content: JSON.stringify(failAction),
      });

      res.json({
        conversationId,
        action: failAction,
        message: failAction.result,
        done: true,
      });
      return;
    }

    // 8. Call LLM
    const agentResult = await runAgent({
      goal: currentGoal,
      history,
      dom,
      turn,
    });

    // 9. Store the action
    if (agentResult.action) {
      await supabase.from("messages").insert({
        conversation_id: conversationId,
        role: "action",
        content: JSON.stringify(agentResult.action),
      });
    }

    // Store message if present
    if (agentResult.message) {
      await supabase.from("messages").insert({
        conversation_id: conversationId,
        role: "message",
        content: agentResult.message,
      });
    }

    const isDone = agentResult.action?.action === "complete";

    // 10. Return to widget
    res.json({
      conversationId,
      action: agentResult.action,
      message: agentResult.message,
      done: isDone,
    });
  } catch (err) {
    console.error("[chat] error:", err);
    res.status(500).json({
      error: "Agent error",
      message: "Something went wrong. Please try again.",
      action: null,
      done: true,
    });
  }
});

export default router;
