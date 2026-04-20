import { Router, type Request, type Response } from "express";
import { supabase } from "../lib/supabase";
import { runAgent, type LLMMessage, type PlanStep } from "../lib/agent";

const router = Router();

// ════════════════════════════════════════════════════════════════════════════
// POST /api/chat — main endpoint
// ════════════════════════════════════════════════════════════════════════════

interface ChatRequest {
  siteKey: string;
  visitorId: string;
  conversationId?: string;
  message?: string;
  dom: string;
  turnType: "new" | "observation";
  observation?: string;
  currentUrl?: string;
}

router.post("/", async (req: Request, res: Response) => {
  const {
    siteKey,
    visitorId,
    conversationId: inputConvId,
    message,
    dom,
    turnType,
    observation,
    currentUrl,
  } = req.body as ChatRequest;

  if (!siteKey || !visitorId || !dom) {
    res.status(400).json({ error: "siteKey, visitorId, and dom required" });
    return;
  }

  if (turnType === "new" && !message?.trim()) {
    res.status(400).json({ error: "message required for new task" });
    return;
  }

  try {
    // 1. Verify site
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
    let goal: string;

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

      conversationId = newConv.id;
      goal = message!.trim();

      await supabase.from("messages").insert({
        conversation_id: conversationId,
        role: "user",
        content: goal,
        metadata: { type: "goal" },
      });

      console.log(`\n[chat] ═══════════════════════════════════════════`);
      console.log(`[chat] NEW TASK: "${goal.slice(0, 50)}"`);
    } else {
      // Verify conversation
      const { data: conv } = await supabase
        .from("conversations")
        .select("id")
        .eq("id", conversationId)
        .eq("site_id", site.id)
        .single();

      if (!conv) {
        res.status(403).json({ error: "Conversation not found" });
        return;
      }

      // Get original goal
      const { data: goalMsg } = await supabase
        .from("messages")
        .select("content")
        .eq("conversation_id", conversationId)
        .eq("role", "user")
        .order("created_at", { ascending: true })
        .limit(1)
        .single();

      goal = goalMsg?.content ?? "Complete the task";

      // Store observation
      if (observation) {
        await supabase.from("messages").insert({
          conversation_id: conversationId,
          role: "user",
          content: `[OBS] ${observation}`,
          metadata: { type: "observation", url: currentUrl },
        });
      }

      console.log(`[chat] OBS: "${observation?.slice(0, 50)}" @ ${currentUrl?.slice(0, 30)}`);
    }

    // 3. Load history
    const { data: historyRows } = await supabase
      .from("messages")
      .select("role, content, metadata")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    const allRows = historyRows ?? [];

    // Extract previous plan from most recent assistant response
    let previousPlan: PlanStep[] = [];
    for (let i = allRows.length - 1; i >= 0; i--) {
      const row = allRows[i];
      if (row.role === "assistant") {
        try {
          const parsed = JSON.parse(row.content);
          if (Array.isArray(parsed.plan) && parsed.plan.length > 0) {
            previousPlan = parsed.plan;
            break;
          }
        } catch {
          // Skip malformed
        }
      }
    }

    // Build LLM history (last 10 messages for context)
    const recentRows = allRows.slice(-10);
    const history: LLMMessage[] = [];

    for (const row of recentRows) {
      if (row.role === "user") {
        const content = row.content as string;
        if (!content.startsWith("[OBS]")) {
          history.push({ role: "user", content });
        }
      } else if (row.role === "assistant") {
        history.push({ role: "assistant", content: row.content });
      }
    }

    const planSummary = previousPlan.length > 0
      ? previousPlan.map(p => `${p.status[0]}:${p.task.slice(0,12)}`).join(" ")
      : "none";
    console.log(`[chat] goal="${goal.slice(0, 35)}" plan=[${planSummary}] dom=${dom.length}c`);

    // 4. Call agent (pass observation so it knows what actions just executed)
    const response = await runAgent(history, dom, goal, previousPlan, observation);

    // 5. Store response
    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: JSON.stringify(response),
      metadata: {
        action_count: response.actions.length,
        plan_count: response.plan.length,
        done: response.done,
      },
    });

    // 6. Return to widget
    res.json({
      conversationId,
      thinking: response.thinking,
      plan: response.plan,
      actions: response.actions,
      speak: response.speak,
      done: response.done,
    });

  } catch (err) {
    console.error("[chat] error:", err);
    res.status(500).json({
      error: "Agent error",
      actions: [{ type: "complete", result: "Something went wrong. Please try again." }],
      speak: "Error occurred.",
      done: true,
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/chat/history
// ════════════════════════════════════════════════════════════════════════════

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

    const formatted: Array<{
      type: "user" | "agent" | "step";
      content?: string;
    }> = [];

    let lastWasComplete = false;

    for (const m of messages ?? []) {
      if (m.role === "user") {
        const content = m.content as string;
        if (!content.startsWith("[OBS]")) {
          formatted.push({ type: "user", content });
        }
      } else if (m.role === "assistant") {
        try {
          const parsed = JSON.parse(m.content as string);

          // Check for completion
          if (parsed.done) {
            const completeAction = parsed.actions?.find((a: {type: string}) => a.type === "complete");
            if (completeAction) {
              formatted.push({ type: "agent", content: completeAction.result || "Done!" });
              lastWasComplete = true;
            }
          } else if (parsed.speak) {
            formatted.push({ type: "step", content: parsed.speak });
            lastWasComplete = false;
          }
        } catch {
          // Skip
        }
      }
    }

    res.json({ messages: formatted, isComplete: lastWasComplete });

  } catch (err) {
    console.error("[chat/history] error:", err);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

export default router;
