import { Router, type Request, type Response } from "express";
import { supabase } from "../lib/supabase";
import { runAgent, type LLMMessage, type AgentAction, type ActionResult, type Subtask } from "../lib/agent";

const router = Router();

// ── GET conversation history ─────────────────────────────────────────────────
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
    }

    res.json({ messages: formatted });
  } catch (err) {
    console.error("[chat/history] error:", err);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

interface DOMData {
  page?: { url: string; title: string };
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

    // 3. Load history
    const { data: historyRows } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    // 4. Store incoming message
    const pageUrl = dom?.page?.url ?? null;
    const elementCount = dom?.elements?.length ?? 0;

    const actionSummary =
      actionResults && actionResults.length > 0
        ? actionResults
            .map((r) => `${r.success ? "✓" : "✗"}${r.type}(${r.index || ""})`)
            .join(" ")
        : "no actions";

    const incomingContent = isActionResult
      ? `[OBS: ${actionSummary} | ${elementCount} elements${pageUrl ? ` | ${pageUrl}` : ""}]`
      : message!.trim();

    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: isActionResult ? "action" : "user",
      content: incomingContent,
      metadata: { dom_count: elementCount, url: pageUrl },
    });

    // 5. Build LLM history (keep first + last N)
    const MAX_RECENT = 8;
    const rows = historyRows ?? [];
    const firstUserIdx = rows.findIndex((r) => r.role === "user");
    const firstUser = firstUserIdx >= 0 ? rows[firstUserIdx] : null;
    const recentStart = Math.max(0, rows.length - MAX_RECENT);
    const omitted = recentStart - (firstUserIdx >= 0 ? firstUserIdx + 1 : 0);

    const llmHistory: LLMMessage[] = [];

    // Include first user message if it would be omitted
    if (firstUser && firstUserIdx < recentStart) {
      llmHistory.push({
        role: "user",
        content: `[ORIGINAL GOAL] ${firstUser.content as string}`,
      });

      if (omitted > 0) {
        llmHistory.push({
          role: "assistant",
          content: JSON.stringify({
            thinking: `[${omitted} messages omitted]`,
            actions: [],
            message: "Continuing from where we left off...",
            done: false,
          }),
        });
      }
    }

    // Add recent messages
    for (let i = recentStart; i < rows.length; i++) {
      if (i === firstUserIdx && firstUserIdx < recentStart) continue;
      const row = rows[i];
      const role = row.role as string;
      if (role === "user" || role === "action") {
        llmHistory.push({ role: "user", content: row.content as string });
      } else if (role === "assistant") {
        llmHistory.push({ role: "assistant", content: row.content as string });
      }
    }

    if (omitted > 0) {
      console.log(`[chat] PRUNED: kept first + last ${rows.length - recentStart}, omitted ${omitted}`);
    }

    // 6. Load past actions for site memory
    const { data: pastActions } = await supabase
      .from("agent_actions")
      .select("task_description, steps")
      .eq("site_id", site.id)
      .eq("success", true)
      .order("created_at", { ascending: false })
      .limit(3);

    // Get original goal
    const originalGoal =
      (historyRows ?? []).find((r) => r.role === "user")?.content ??
      (isActionResult ? null : message?.trim() ?? null);

    // Get recent actions and previous subtasks for guardrails
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

          // Collect recent actions
          if (parsed.actions && recentActions.length < 10) {
            for (const a of parsed.actions) {
              if (recentActions.length < 10) {
                recentActions.push(`${a.type}:${a.index || ""}`);
              }
            }
          }
        } catch { /* ignore */ }
      }
    }

    console.log("\n[chat] ═══════════════════════════════════════════════════════");
    console.log("[chat] TURN:", isActionResult ? "OBSERVATION" : "NEW TASK");
    console.log("[chat] GOAL:", (originalGoal || message || "").slice(0, 60));
    console.log("[chat] DOM:", elementCount, "elements");
    if (isActionResult && actionResults?.length) {
      console.log("[chat] RESULTS:", actionSummary);
    }
    console.log("[chat] HISTORY:", llmHistory.length, "messages");
    console.log("[chat] ═══════════════════════════════════════════════════════");

    // 7. Call LLM
    const { result: agentResult, guardrailsApplied } = await runAgent({
      history: llmHistory,
      userMessage: isActionResult ? null : message!.trim(),
      originalGoal,
      dom: dom ?? {},
      isActionResult,
      actionResults,
      pastActions: pastActions ?? [],
      recentActions,
      previousSubtasks,
    });

    if (guardrailsApplied.length > 0) {
      console.log("[chat] GUARDRAILS:", guardrailsApplied.join(", "));
    }

    // 8. Store response
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

    // 9. Save successful task completion with useful recipe
    if (agentResult.done) {
      const taskDescription =
        agentResult.task_summary ??
        rows.find((r) => r.role === "user")?.content ??
        (isActionResult ? "" : message!.trim());

      const priorActions: AgentAction[] = rows
        .filter((r) => r.role === "assistant")
        .flatMap((r) => {
          try {
            const p = JSON.parse(r.content as string) as { actions?: AgentAction[] };
            return p.actions ?? [];
          } catch {
            return [];
          }
        });

      const allActions = [...priorActions, ...agentResult.actions];

      // Build a reusable recipe from action descriptions (not indices)
      const recipe = allActions
        .filter((a) => a.description) // Only actions with descriptions
        .map((a) => {
          const desc = a.description || "";
          if (a.type === "type" && a.text) {
            return `type "${a.text.slice(0, 20)}" in ${desc}`;
          }
          return `${a.type}: ${desc}`;
        })
        .slice(0, 8); // Cap at 8 steps

      if (taskDescription && recipe.length > 0) {
        await supabase.from("agent_actions").insert({
          site_id: site.id,
          task_description: taskDescription,
          steps: recipe, // Store readable recipe, not raw actions
          success: true,
        });
      }
    }

    // 10. Return to widget
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
