import { Router, type Request, type Response } from "express";
import { supabase } from "../lib/supabase";
import { runAgent, type LLMMessage, type AgentAction } from "../lib/agent";

const router = Router();

// ── GET conversation history ─────────────────────────────────────────────────
router.get("/history", async (req: Request, res: Response) => {
  const { siteKey, conversationId } = req.query;

  if (!siteKey || !conversationId) {
    res.status(400).json({ error: "siteKey and conversationId required" });
    return;
  }

  try {
    // Verify site exists
    const { data: site } = await supabase
      .from("sites")
      .select("id")
      .eq("site_key", siteKey)
      .single();

    if (!site) {
      res.status(404).json({ error: "Site not found" });
      return;
    }

    // Verify conversation belongs to site
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

    // Fetch messages
    const { data: messages } = await supabase
      .from("messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    // Format for widget display
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

          // Add actions as completed pills
          if (parsed.actions && parsed.actions.length > 0) {
            const actionDescs = parsed.actions
              .map((a) => a.description)
              .filter(Boolean) as string[];
            if (actionDescs.length > 0) {
              formatted.push({ role: "actions", actions: actionDescs.map((d) => ({ description: d })) });
            }
          }

          // Add message if present
          if (parsed.message) {
            formatted.push({ role: "assistant", content: parsed.message });
          }
        } catch {
          // Skip malformed entries
        }
      }
    }

    res.json({ messages: formatted });
  } catch (err) {
    console.error("[chat/history] error:", err);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

interface ActionResult {
  type: string;
  selector?: string;
  success: boolean;
  error?: string;
}

interface DOMData {
  page?: { url: string; title: string };
  elements?: Record<string, unknown>[];
}

interface ChatRequest {
  siteKey: string;
  visitorId: string;
  message?: string;
  dom?: DOMData | Record<string, unknown>[];
  conversationId?: string;
  isActionResult?: boolean;
  actionResults?: ActionResult[];
}

router.post("/", async (req: Request, res: Response) => {
  const {
    siteKey,
    visitorId,
    message,
    dom = [],
    conversationId: inputConvId,
    isActionResult = false,
    actionResults = [],
  } = req.body as Partial<ChatRequest>;

  // ── validation ───────────────────────────────────────────────────────────
  if (!siteKey || !visitorId) {
    res.status(400).json({ error: "siteKey and visitorId are required" });
    return;
  }
  if (!isActionResult && (!message || !message.trim())) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  try {
    // 1. Look up site ────────────────────────────────────────────────────────
    const { data: site } = await supabase
      .from("sites")
      .select("id")
      .eq("site_key", siteKey)
      .single();

    if (!site) {
      res.status(404).json({ error: "Site not found" });
      return;
    }

    // 2. Get or create conversation ──────────────────────────────────────────
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
      // Verify the conversation belongs to this site — prevents cross-site injection
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

    // 3. Load history BEFORE storing the new message ─────────────────────────
    const { data: historyRows } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    // 4. Store the incoming message ──────────────────────────────────────────
    // Handle both old (array) and new (object with page/elements) DOM formats
    const domElements = Array.isArray(dom) ? dom : (dom?.elements ?? []);
    const pageUrl = !Array.isArray(dom) && dom?.page?.url ? dom.page.url : null;

    // Build meaningful observation string for action results (Problem 1 fix)
    // The model needs to know what happened: which actions succeeded/failed
    const actionSummary =
      actionResults && actionResults.length > 0
        ? actionResults
            .map((r) => {
              const icon = r.success ? "✓" : "✗";
              const target = r.selector ? ` ${r.selector}` : "";
              const err = r.error ? ` (${r.error})` : "";
              return `${icon}${r.type}${target}${err}`;
            })
            .join(" | ")
        : "no actions";

    const incomingContent = isActionResult
      ? `[OBSERVATION: ${actionSummary} | ${domElements.length} elements${pageUrl ? ` | ${pageUrl}` : ""}]`
      : message!.trim();

    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: isActionResult ? "action" : "user",
      content: incomingContent,
      metadata: { dom_count: domElements.length, url: pageUrl },
    });

    // 5. Build LLM history from DB rows ──────────────────────────────────────
    // action-result rows become user turns so the model sees them as
    // environment feedback, not as user speech.
    const llmHistory: LLMMessage[] = [];
    for (const row of historyRows ?? []) {
      const role = row.role as string;
      if (role === "user" || role === "action") {
        llmHistory.push({ role: "user", content: row.content as string });
      } else if (role === "assistant") {
        llmHistory.push({ role: "assistant", content: row.content as string });
      }
    }

    // 6. Load past successful actions for this site (agent memory) ───────────
    const { data: pastActions } = await supabase
      .from("agent_actions")
      .select("task_description, steps")
      .eq("site_id", site.id)
      .eq("success", true)
      .order("created_at", { ascending: false })
      .limit(3);

    // 6b. Find the original user goal (first user message in conversation)
    const originalGoal =
      (historyRows ?? []).find((r) => r.role === "user")?.content ??
      (isActionResult ? null : message?.trim() ?? null);

    // 7. Call the LLM ────────────────────────────────────────────────────────
    const agentResult = await runAgent({
      history: llmHistory,
      userMessage: isActionResult ? null : message!.trim(),
      originalGoal,
      dom,
      isActionResult,
      actionResults,
      pastActions: pastActions ?? [],
    });

    // 8. Store the assistant response ────────────────────────────────────────
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
      },
    });

    // 9. On completion, persist the action sequence as site memory ────────────
    if (agentResult.done) {
      const rows = historyRows ?? [];
      // Prefer agent-generated summary (generalized, reusable);
      // fall back to first user message if the agent didn't provide one
      const taskDescription =
        agentResult.task_summary ??
        rows.find((r) => r.role === "user")?.content ??
        (isActionResult ? "" : message!.trim());

      // Collect all actions taken across every prior assistant turn
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

      if (taskDescription && allActions.length > 0) {
        await supabase.from("agent_actions").insert({
          site_id: site.id,
          task_description: taskDescription,
          steps: allActions,
          success: true,
        });
      }
    }

    // 10. Return to the widget ───────────────────────────────────────────────
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
      reply: "Something went wrong on my end. Please try again.",
      actions: [],
      done: true,
    });
  }
});

export default router;
