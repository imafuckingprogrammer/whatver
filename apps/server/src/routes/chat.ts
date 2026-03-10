import { Router, type Request, type Response } from "express";
import { supabase } from "../lib/supabase";
import { runAgent, type LLMMessage, type AgentAction } from "../lib/agent";

const router = Router();

interface ChatRequest {
  siteKey: string;
  visitorId: string;
  message?: string;
  dom?: Record<string, unknown>[];
  conversationId?: string;
  isActionResult?: boolean;
}

router.post("/", async (req: Request, res: Response) => {
  const {
    siteKey,
    visitorId,
    message,
    dom = [],
    conversationId: inputConvId,
    isActionResult = false,
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
    }

    // 3. Load history BEFORE storing the new message ─────────────────────────
    const { data: historyRows } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    // 4. Store the incoming message ──────────────────────────────────────────
    const incomingContent = isActionResult
      ? `[Actions completed — ${dom.length} elements now on page]`
      : message!.trim();

    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: isActionResult ? "action" : "user",
      content: incomingContent,
      metadata: { dom_count: dom.length },
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

    // 7. Call the LLM ────────────────────────────────────────────────────────
    const agentResult = await runAgent({
      history: llmHistory,
      userMessage: isActionResult ? null : message!.trim(),
      dom,
      isActionResult,
      pastActions: pastActions ?? [],
    });

    // 8. Store the assistant response ────────────────────────────────────────
    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: JSON.stringify({
        thinking: agentResult.thinking,
        actions: agentResult.actions,
        message: agentResult.message,
        done: agentResult.done,
      }),
      metadata: {
        done: agentResult.done,
        action_count: agentResult.actions.length,
      },
    });

    // 9. On completion, persist the action sequence as site memory ────────────
    if (agentResult.done) {
      const rows = historyRows ?? [];
      const taskDescription =
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
