import { Router, type Request, type Response } from "express";
import { supabase } from "../lib/supabase";
import {
  runAgent,
  summarizeTurn,
  type HistoryEntry,
  type AgentAction,
  type ActionResult,
  type Subtask,
  type DOMSnapshot,
} from "../lib/agent";

const router = Router();

// BUG FIX #4: MAX_LOOPS = 10 (was 20)
const MAX_HISTORY_ENTRIES = 10;

// ═══════════════════════════════════════════════════════════════════════════════
// GET /history — Load conversation history for widget
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

    // Validate conversation belongs to site
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
      .select("role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    const formatted: Array<{
      role: string;
      content?: string | null;
      actions?: Array<{ description: string }>;
    }> = [];

    for (const m of messages ?? []) {
      if (m.role === "user") {
        formatted.push({ role: "user", content: m.content as string });
      } else if (m.role === "assistant") {
        try {
          const parsed = JSON.parse(m.content as string) as {
            message?: string;
            actions?: Array<{ description?: string }>;
          };

          if (parsed.actions && parsed.actions.length > 0) {
            const actionDescs = parsed.actions
              .map((a) => a.description)
              .filter(Boolean) as string[];
            if (actionDescs.length > 0) {
              formatted.push({
                role: "actions",
                actions: actionDescs.map((d) => ({ description: d })),
              });
            }
          }

          if (parsed.message) {
            formatted.push({ role: "assistant", content: parsed.message });
          }
        } catch {
          // Skip malformed
        }
      }
    }

    res.json({ messages: formatted });
  } catch (err) {
    console.error("[chat/history] error:", err);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST / — Main chat endpoint
// ═══════════════════════════════════════════════════════════════════════════════

interface ChatRequest {
  siteKey: string;
  visitorId: string;
  message?: string;
  dom?: DOMSnapshot;
  conversationId?: string;
  isActionResult?: boolean;
  actionResults?: ActionResult[];
}

router.post("/", async (req: Request, res: Response) => {
  const {
    siteKey,
    visitorId,
    message,
    dom,
    conversationId: inputConvId,
    isActionResult = false,
    actionResults = [],
  } = req.body as Partial<ChatRequest>;

  if (!siteKey || !visitorId) {
    res.status(400).json({ error: "siteKey and visitorId required" });
    return;
  }
  if (!isActionResult && (!message || !message.trim())) {
    res.status(400).json({ error: "message required" });
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
    let conversationId: string | null = inputConvId ?? null;

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

    // 3. Load messages from DB
    const { data: dbMessages } = await supabase
      .from("messages")
      .select("role, content, metadata")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    const rows = dbMessages ?? [];

    // 4. Extract original goal (BUG FIX #5: Always preserve)
    let originalGoal: string | null = null;
    for (const row of rows) {
      if (row.role === "user") {
        originalGoal = row.content as string;
        break;
      }
    }
    // If this is the first message, it's the goal
    if (!originalGoal && !isActionResult && message) {
      originalGoal = message.trim();
    }

    // 5. Store incoming message (compact format)
    const pageUrl = dom?.page?.url ?? null;
    const elementCount = dom?.elements?.length ?? 0;

    const actionSummary =
      actionResults.length > 0
        ? actionResults
            .map((r) => `${r.success ? "OK" : "FAIL"}:${r.type}(${r.index ?? ""})`)
            .join(" ")
        : "no actions";

    const incomingContent = isActionResult
      ? `[OBS: ${actionSummary} | ${elementCount} els | ${pageUrl ?? "?"}]`
      : message!.trim();

    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: isActionResult ? "observation" : "user",
      content: incomingContent,
      metadata: { dom_count: elementCount, url: pageUrl },
    });

    // 6. Build compact history (BUG FIX #1: NO DOM in history)
    const history: HistoryEntry[] = [];

    // BUG FIX #5: Skip first user message (we pass it separately as originalGoal)
    let skippedFirst = false;

    for (const row of rows) {
      const role = row.role as string;

      if (role === "user" && !skippedFirst) {
        skippedFirst = true;
        continue; // Don't include first user message in history
      }

      if (role === "user") {
        history.push({ role: "user", content: row.content as string });
      } else if (role === "observation") {
        history.push({ role: "observation", content: row.content as string });
      } else if (role === "assistant") {
        // Parse and summarize assistant response (NO DOM)
        try {
          const parsed = JSON.parse(row.content as string);
          const summary = summarizeTurn(
            parsed,
            (row.metadata as { actionResults?: ActionResult[] })?.actionResults ?? []
          );
          history.push({ role: "assistant", content: summary });
        } catch {
          history.push({ role: "assistant", content: "[parse error]" });
        }
      }
    }

    // Prune history from middle (BUG FIX #5: Always keep beginning, trim middle)
    if (history.length > MAX_HISTORY_ENTRIES) {
      const keep = Math.floor(MAX_HISTORY_ENTRIES / 2);
      const start = history.slice(0, keep);
      const end = history.slice(-keep);
      const omitted = history.length - MAX_HISTORY_ENTRIES;

      history.length = 0;
      history.push(...start);
      history.push({
        role: "observation",
        content: `[${omitted} turns omitted]`,
      });
      history.push(...end);

      console.log(`[chat] PRUNED: kept ${keep} start + ${keep} end, omitted ${omitted}`);
    }

    // 7. Get recent actions and subtasks for guardrails
    const recentActions: string[] = [];
    let previousSubtasks: Subtask[] = [];

    for (const row of rows.slice().reverse()) {
      if (row.role === "assistant") {
        try {
          const parsed = JSON.parse(row.content as string) as {
            actions?: AgentAction[];
            subtasks?: Subtask[];
          };

          // Get subtasks from most recent turn
          if (previousSubtasks.length === 0 && parsed.subtasks) {
            previousSubtasks = parsed.subtasks;
          }

          // Collect recent actions
          if (parsed.actions && recentActions.length < 10) {
            for (const a of parsed.actions) {
              if (recentActions.length < 10) {
                recentActions.push(`${a.type}:${a.index ?? ""}`);
              }
            }
          }
        } catch {
          /* ignore */
        }
      }
    }

    // 8. Load site memory (past successful tasks)
    const { data: pastActions } = await supabase
      .from("agent_actions")
      .select("task_description, steps")
      .eq("site_id", site.id)
      .eq("success", true)
      .order("created_at", { ascending: false })
      .limit(3);

    const siteMemory = (pastActions ?? []).map((pa) => ({
      task: pa.task_description as string,
      steps: (pa.steps as string[]) ?? [],
    }));

    // Build DOM snapshot
    const domSnapshot: DOMSnapshot = {
      page: dom?.page ?? { url: "", title: "" },
      elements: dom?.elements ?? [],
    };

    console.log("\n[chat] ═══════════════════════════════════════════════════════");
    console.log("[chat] TURN:", isActionResult ? "OBSERVATION" : "NEW TASK");
    console.log("[chat] GOAL:", (originalGoal ?? "").slice(0, 60));
    console.log("[chat] DOM:", elementCount, "elements");
    if (isActionResult && actionResults.length > 0) {
      console.log("[chat] RESULTS:", actionSummary);
    }
    console.log("[chat] HISTORY:", history.length, "entries (compact, no DOM)");
    console.log("[chat] ═══════════════════════════════════════════════════════");

    // 9. Call agent
    const { result: agentResult, guardrailsApplied } = await runAgent({
      history,
      originalGoal: originalGoal ?? message?.trim() ?? "unknown",
      dom: domSnapshot,
      actionResults: isActionResult ? actionResults : undefined,
      siteMemory,
      recentActions,
      previousSubtasks,
    });

    if (guardrailsApplied.length > 0) {
      console.log("[chat] GUARDRAILS:", guardrailsApplied.join(", "));
    }

    // 10. Store assistant response
    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: JSON.stringify({
        thinking: agentResult.thinking,
        subtasks: agentResult.subtasks,
        actions: agentResult.actions,
        message: agentResult.message,
        done: agentResult.done,
      }),
      metadata: {
        done: agentResult.done,
        action_count: agentResult.actions.length,
        subtask_count: agentResult.subtasks.length,
        guardrails: guardrailsApplied.length > 0 ? guardrailsApplied : null,
        actionResults: isActionResult ? actionResults : null,
      },
    });

    // 11. Save successful task recipe
    if (agentResult.done) {
      const taskDescription =
        agentResult.task_summary ?? originalGoal ?? message?.trim() ?? "";

      // Collect all action descriptions from conversation
      const allActions: AgentAction[] = rows
        .filter((r) => r.role === "assistant")
        .flatMap((r) => {
          try {
            const p = JSON.parse(r.content as string) as { actions?: AgentAction[] };
            return p.actions ?? [];
          } catch {
            return [];
          }
        });

      // Add current turn's actions
      allActions.push(...agentResult.actions);

      // Build recipe from descriptions
      const recipe = allActions
        .filter((a) => a.description)
        .map((a) => {
          if (a.type === "type" && a.text) {
            return `type "${a.text.slice(0, 20)}" in ${a.description}`;
          }
          return `${a.type}: ${a.description}`;
        })
        .slice(0, 8);

      if (taskDescription && recipe.length > 0) {
        await supabase.from("agent_actions").insert({
          site_id: site.id,
          task_description: taskDescription,
          steps: recipe,
          success: true,
        });
      }
    }

    // 12. Return to widget
    res.json({
      conversationId,
      reply: agentResult.message,
      actions: agentResult.actions,
      done: agentResult.done,
    });
  } catch (err) {
    console.error("[chat] error:", err);
    res.status(500).json({
      error: "Agent error",
      reply: "Something went wrong. Please try again.",
      actions: [],
      done: true,
    });
  }
});

export default router;
