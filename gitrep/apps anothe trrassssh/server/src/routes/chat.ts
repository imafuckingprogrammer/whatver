import { Router, type Request, type Response } from "express";
import { supabase } from "../lib/supabase";
import {
  runAgent,
  type LLMMessage,
  type AgentAction,
  type ActionResult,
  type Subtask,
} from "../lib/agent";

const router = Router();

// ═══════════════════════════════════════════════════════════════════════════
// GET /history - Conversation history for UI display
// ═══════════════════════════════════════════════════════════════════════════
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
      // role "action" is internal, not shown in UI history
    }

    res.json({ messages: formatted });
  } catch (err) {
    console.error("[chat/history] error:", err);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST / - Main chat endpoint
// ═══════════════════════════════════════════════════════════════════════════

interface DOMData {
  page?: { url: string; title: string; urlChanged?: boolean; previousUrl?: string | null };
  elements?: string[];
  offScreen?: { above?: string; below?: string };
}

interface ChatRequest {
  siteKey: string;
  visitorId: string;
  message?: string;
  dom?: DOMData;
  conversationId?: string;
  isActionResult?: boolean;
  actionResults?: ActionResult[];
}

/**
 * BUG 1 FIX: Build compact action summary for DB storage
 * This replaces storing full DOM in history
 */
function buildCompactSummary(
  actionResults: ActionResult[],
  url: string | null,
  elementCount: number
): string {
  const resultStrs = actionResults.map((r) => {
    const status = r.success ? "✓" : "✗";
    return `${status}${r.type}(${r.index || ""})`;
  });
  const resultPart = resultStrs.length > 0 ? resultStrs.join(" ") : "observed";
  const urlPart = url ? ` → ${new URL(url).pathname}` : "";
  return `[RESULT: ${resultPart}${urlPart} | ${elementCount} elements]`;
}

/**
 * BUG 5 FIX: Build LLM history that ALWAYS keeps original goal
 * Prunes from middle, never the start. Max 6 action/result pairs (12 messages)
 */
function buildLLMHistory(
  rows: Array<{ role: string; content: unknown }>,
  MAX_PAIRS: number = 6
): { history: LLMMessage[]; originalGoal: string | null; omittedCount: number } {
  const llmHistory: LLMMessage[] = [];
  let originalGoal: string | null = null;

  // Find first user message (the original goal)
  const firstUserIdx = rows.findIndex((r) => r.role === "user");
  if (firstUserIdx >= 0) {
    originalGoal = rows[firstUserIdx].content as string;
  }

  // Count pairs (action + assistant = 1 pair, or just assistant = 1 pair)
  // We want to keep: [ORIGINAL GOAL] + last N pairs
  const recentRows: Array<{ role: string; content: unknown }> = [];
  let pairCount = 0;

  // Walk backwards collecting pairs
  for (let i = rows.length - 1; i >= 0 && pairCount < MAX_PAIRS; i--) {
    const row = rows[i];
    if (row.role === "assistant") {
      pairCount++;
      recentRows.unshift(row);
      // Check if previous is action
      if (i > 0 && rows[i - 1].role === "action") {
        recentRows.unshift(rows[i - 1]);
        i--; // Skip the action we just added
      }
    } else if (row.role === "action" && i === rows.length - 1) {
      // Trailing action without assistant response yet
      recentRows.unshift(row);
    } else if (row.role === "user" && i !== firstUserIdx) {
      // Additional user messages (rare)
      recentRows.unshift(row);
    }
  }

  // Calculate how many turns were omitted
  const firstIncludedIdx = rows.indexOf(recentRows[0] as (typeof rows)[0]);
  const omittedCount =
    firstIncludedIdx > firstUserIdx + 1
      ? firstIncludedIdx - firstUserIdx - 1
      : 0;

  // Build final history
  // 1. Always include original goal first (if we have one and it would be omitted)
  if (originalGoal && (firstIncludedIdx === -1 || firstIncludedIdx > firstUserIdx)) {
    llmHistory.push({
      role: "user",
      content: `[ORIGINAL GOAL] ${originalGoal}`,
    });

    // 2. If turns were pruned, add a marker
    if (omittedCount > 0) {
      llmHistory.push({
        role: "assistant",
        content: JSON.stringify({
          thinking: `[${omittedCount} turns omitted]`,
          actions: [],
          message: "Continuing...",
          done: false,
        }),
      });
    }
  }

  // 3. Add recent rows (converting to LLM format)
  for (const row of recentRows) {
    // Skip the original goal if we already added it
    if (row === rows[firstUserIdx] && llmHistory.length > 0) continue;

    if (row.role === "user") {
      llmHistory.push({ role: "user", content: row.content as string });
    } else if (row.role === "action") {
      // Action summaries go as user messages (observations)
      llmHistory.push({ role: "user", content: row.content as string });
    } else if (row.role === "assistant") {
      llmHistory.push({ role: "assistant", content: row.content as string });
    }
  }

  return { history: llmHistory, originalGoal, omittedCount };
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

    // 3. Load history from DB
    const { data: historyRows } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    // 4. Store incoming message
    // BUG 1 FIX: Store compact summary for action results, not full DOM
    const pageUrl = dom?.page?.url ?? null;
    const elementCount = dom?.elements?.length ?? 0;

    const incomingContent = isActionResult
      ? buildCompactSummary(actionResults || [], pageUrl, elementCount)
      : message!.trim();

    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: isActionResult ? "action" : "user",
      content: incomingContent,
      metadata: { dom_count: elementCount, url: pageUrl },
    });

    // 5. Build LLM history
    // BUG 5 FIX: Always keep original goal, prune from middle
    const rows = historyRows ?? [];
    const { history: llmHistory, originalGoal, omittedCount } = buildLLMHistory(rows);

    // For new tasks, the goal is the current message
    const effectiveGoal = originalGoal ?? message?.trim() ?? "unknown";

    if (omittedCount > 0) {
      console.log(
        `[chat] PRUNED: kept original + last 6 pairs, omitted ${omittedCount} turns`
      );
    }

    // 6. Load past actions for site memory
    const { data: pastActions } = await supabase
      .from("agent_actions")
      .select("task_description, steps")
      .eq("site_id", site.id)
      .eq("success", true)
      .order("created_at", { ascending: false })
      .limit(3);

    // 7. Get recent actions and previous subtasks for guardrails
    const recentActions: string[] = [];
    let previousSubtasks: Subtask[] = [];

    for (const row of (historyRows ?? []).slice().reverse()) {
      if (row.role === "assistant") {
        try {
          const parsed = JSON.parse(row.content as string) as {
            actions?: AgentAction[];
            subtasks?: Subtask[];
          };

          // Get subtasks from most recent assistant turn
          if (previousSubtasks.length === 0 && parsed.subtasks) {
            previousSubtasks = parsed.subtasks;
          }

          // Collect recent actions (for duplicate detection)
          if (parsed.actions && recentActions.length < 10) {
            for (const a of parsed.actions) {
              if (recentActions.length < 10) {
                recentActions.push(`${a.type}:${a.index || ""}`);
              }
            }
          }
        } catch {
          /* ignore */
        }
      }
    }

    console.log("\n[chat] ═══════════════════════════════════════════════════════");
    console.log("[chat] TURN:", isActionResult ? "OBSERVATION" : "NEW TASK");
    console.log("[chat] GOAL:", effectiveGoal.slice(0, 60));
    console.log("[chat] DOM:", elementCount, "elements");
    if (isActionResult && actionResults?.length) {
      const summary = actionResults
        .map((r) => `${r.success ? "✓" : "✗"}${r.type}(${r.index || ""})`)
        .join(" ");
      console.log("[chat] RESULTS:", summary);
    }
    console.log("[chat] HISTORY:", llmHistory.length, "messages to LLM");
    console.log("[chat] ═══════════════════════════════════════════════════════");

    // 8. Call LLM
    // BUG 1 FIX: runAgent receives compact history, builds current turn with DOM
    const { result: agentResult, guardrailsApplied } = await runAgent({
      llmHistory,
      originalGoal: effectiveGoal,
      dom: dom ?? { elements: [] },
      actionResults: isActionResult ? actionResults : undefined,
      pastActions: pastActions ?? [],
      recentActions,
      previousSubtasks,
    });

    if (guardrailsApplied.length > 0) {
      console.log("[chat] GUARDRAILS:", guardrailsApplied.join(", "));
    }

    // 9. Store response (full JSON for assistant)
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
      },
    });

    // 10. Save successful task completion with useful recipe
    if (agentResult.done) {
      const taskDescription =
        agentResult.task_summary ??
        rows.find((r) => r.role === "user")?.content ??
        (isActionResult ? "" : message!.trim());

      const priorActions: AgentAction[] = rows
        .filter((r) => r.role === "assistant")
        .flatMap((r) => {
          try {
            const p = JSON.parse(r.content as string) as {
              actions?: AgentAction[];
            };
            return p.actions ?? [];
          } catch {
            return [];
          }
        });

      const allActions = [...priorActions, ...agentResult.actions];

      // Build a reusable recipe from action descriptions (not indices)
      const recipe = allActions
        .filter((a) => a.description)
        .map((a) => {
          const desc = a.description || "";
          if (a.type === "type" && a.text) {
            return `type "${a.text.slice(0, 20)}" in ${desc}`;
          }
          return `${a.type}: ${desc}`;
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

    // 11. Return to widget
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
