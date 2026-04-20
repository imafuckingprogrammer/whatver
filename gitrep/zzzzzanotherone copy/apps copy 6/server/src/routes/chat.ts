import { Router, type Request, type Response } from "express";
import { supabase } from "../lib/supabase";
import { runAgent, type LLMMessage, type AgentAction, type ActionResult } from "../lib/agent";

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
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    const formatted: Array<{ role: string; content?: string }> = [];

    for (const m of messages ?? []) {
      if (m.role === "user") {
        formatted.push({ role: "user", content: m.content as string });
      } else if (m.role === "assistant") {
        try {
          const parsed = JSON.parse(m.content as string) as { message?: string };
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
  page?: { url: string; title: string; pageType?: string };
  elements?: string[];
  offScreen?: { above?: number; below?: string[] } | null;
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

    const resultSummary =
      actionResults.length > 0
        ? actionResults.map((r) => `${r.success ? "✓" : "✗"}${r.type}`).join(" ")
        : "";

    const incomingContent = isActionResult
      ? `[${resultSummary} | ${elementCount} els]`
      : message!.trim();

    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: isActionResult ? "action" : "user",
      content: incomingContent,
      metadata: { dom_count: elementCount, url: pageUrl },
    });

    // 5. Build LLM history — keep first user message + recent context
    const MAX_RECENT = 14;
    const rows = historyRows ?? [];
    const firstUserIdx = rows.findIndex((r) => r.role === "user");
    const firstUser = firstUserIdx >= 0 ? rows[firstUserIdx] : null;
    const recentStart = Math.max(0, rows.length - MAX_RECENT);

    const llmHistory: LLMMessage[] = [];

    // Always include original goal if it would be cut off
    if (firstUser && firstUserIdx < recentStart) {
      llmHistory.push({
        role: "user",
        content: `[GOAL] ${firstUser.content as string}`,
      });
    }

    // Add recent messages
    for (let i = recentStart; i < rows.length; i++) {
      if (i === firstUserIdx && firstUserIdx < recentStart) continue;
      const row = rows[i];
      const role = row.role as string;

      if (role === "user" || role === "action") {
        llmHistory.push({ role: "user", content: row.content as string });
      } else if (role === "assistant") {
        // Extract just what we need from assistant responses
        try {
          const parsed = JSON.parse(row.content as string) as {
            think?: string;
            actions?: AgentAction[];
            message?: string;
            done?: boolean;
          };
          // Compact format for history
          const summary = [
            parsed.think ? `Think: ${parsed.think.slice(0, 100)}` : "",
            parsed.actions?.length ? `Actions: ${parsed.actions.map((a) => a.type).join(", ")}` : "",
            parsed.message ? `Said: "${parsed.message.slice(0, 80)}"` : "",
            parsed.done ? "[DONE]" : "",
          ]
            .filter(Boolean)
            .join(" | ");

          llmHistory.push({ role: "assistant", content: summary || "[no response]" });
        } catch {
          llmHistory.push({ role: "assistant", content: row.content as string });
        }
      }
    }

    // 6. Load site memory (past successful tasks)
    const { data: pastActions } = await supabase
      .from("agent_actions")
      .select("task_description, steps")
      .eq("site_id", site.id)
      .eq("success", true)
      .order("created_at", { ascending: false })
      .limit(2);

    const siteMemory = (pastActions ?? []).map((pa) => ({
      task: pa.task_description as string,
      steps: pa.steps as string[],
    }));

    // Get original goal
    const originalGoal =
      (historyRows ?? []).find((r) => r.role === "user")?.content ??
      (isActionResult ? null : message?.trim() ?? null);

    // Extract progress: what has the agent accomplished so far?
    // Pull unique "message" values from assistant turns (these describe completed steps)
    const progress: string[] = [];
    const seenProgress = new Set<string>();
    for (const row of rows) {
      if (row.role === "assistant") {
        try {
          const parsed = JSON.parse(row.content as string) as {
            message?: string;
            actions?: AgentAction[];
          };
          // Only count as progress if there were actions (not just thinking)
          if (parsed.message && parsed.actions && parsed.actions.length > 0) {
            const step = parsed.message.slice(0, 50);
            if (!seenProgress.has(step)) {
              seenProgress.add(step);
              progress.push(step);
            }
          }
        } catch { /* ignore */ }
      }
    }

    // Log turn info
    console.log("\n[chat] ═══════════════════════════════════════════════════════");
    console.log("[chat]", isActionResult ? "OBSERVATION" : "NEW TASK");
    console.log("[chat] goal:", (originalGoal || "").slice(0, 50));
    if (progress.length > 0) console.log("[chat] progress:", progress.join(" → "));
    console.log("[chat] dom:", elementCount, "elements");
    if (dom?.page?.pageType) console.log("[chat] page:", dom.page.pageType);
    console.log("[chat] history:", llmHistory.length, "msgs");
    console.log("[chat] ═══════════════════════════════════════════════════════");

    // 7. Call agent
    const agentResult = await runAgent({
      history: llmHistory,
      userMessage: isActionResult ? null : message!.trim(),
      originalGoal,
      dom: dom ?? {},
      isActionResult,
      actionResults,
      siteMemory,
      progress,
    });

    // 8. Store response
    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: JSON.stringify({
        think: agentResult.thinking,
        actions: agentResult.actions,
        message: agentResult.message,
        done: agentResult.done,
      }),
      metadata: {
        done: agentResult.done,
        action_count: agentResult.actions.length,
      },
    });

    // 9. Save successful task completion
    if (agentResult.done && originalGoal) {
      const allActions: AgentAction[] = rows
        .filter((r) => r.role === "assistant")
        .flatMap((r) => {
          try {
            const p = JSON.parse(r.content as string) as { actions?: AgentAction[] };
            return p.actions ?? [];
          } catch {
            return [];
          }
        })
        .concat(agentResult.actions);

      // Build readable recipe
      const recipe = allActions
        .slice(0, 8)
        .map((a) => `${a.type}${a.index ? `(${a.index})` : ""}${a.text ? `: "${a.text.slice(0, 20)}"` : ""}`);

      if (recipe.length > 0) {
        await supabase.from("agent_actions").insert({
          site_id: site.id,
          task_description: originalGoal.slice(0, 200),
          steps: recipe,
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
