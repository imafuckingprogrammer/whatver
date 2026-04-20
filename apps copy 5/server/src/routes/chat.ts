import { Router, type Request, type Response } from "express";
import { supabase } from "../lib/supabase";
import { runAgent, type LLMMessage, type AgentAction, type ActionResult, type Subtask } from "../lib/agent";

const router = Router();

// ═══════════════════════════════════════════════════════════════════════════
// RATE LIMITING - In-memory sliding window
// ═══════════════════════════════════════════════════════════════════════════
interface RateLimitEntry {
  timestamps: number[];
  blocked: boolean;
  blockUntil: number;
}

const rateLimits = new Map<string, RateLimitEntry>();

// Configuration
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 60; // 60 requests per minute per siteKey
const RATE_LIMIT_BLOCK_DURATION_MS = 5 * 60 * 1000; // 5 minute block on abuse

function checkRateLimit(siteKey: string): { allowed: boolean; remaining: number; retryAfter?: number } {
  const now = Date.now();
  let entry = rateLimits.get(siteKey);

  if (!entry) {
    entry = { timestamps: [], blocked: false, blockUntil: 0 };
    rateLimits.set(siteKey, entry);
  }

  // Check if currently blocked
  if (entry.blocked && now < entry.blockUntil) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil((entry.blockUntil - now) / 1000),
    };
  }

  // Clear block if expired
  if (entry.blocked && now >= entry.blockUntil) {
    entry.blocked = false;
    entry.timestamps = [];
  }

  // Remove timestamps outside the window
  entry.timestamps = entry.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  // Check if over limit
  if (entry.timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    // Block for abuse
    entry.blocked = true;
    entry.blockUntil = now + RATE_LIMIT_BLOCK_DURATION_MS;
    console.log(`[rate-limit] Blocking siteKey ${siteKey} for abuse`);
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil(RATE_LIMIT_BLOCK_DURATION_MS / 1000),
    };
  }

  // Allow request
  entry.timestamps.push(now);
  return {
    allowed: true,
    remaining: RATE_LIMIT_MAX_REQUESTS - entry.timestamps.length,
  };
}

// Cleanup old entries periodically (every 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimits.entries()) {
    // Remove entries that haven't been used in 30 minutes and aren't blocked
    const lastActivity = entry.timestamps[entry.timestamps.length - 1] || 0;
    if (!entry.blocked && now - lastActivity > 30 * 60 * 1000) {
      rateLimits.delete(key);
    }
  }
}, 10 * 60 * 1000);

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

  // Rate limiting
  const rateCheck = checkRateLimit(siteKey);
  if (!rateCheck.allowed) {
    res.status(429).json({
      error: "Rate limit exceeded",
      retryAfter: rateCheck.retryAfter,
      reply: "Too many requests. Please wait a moment and try again.",
      actions: [],
      done: true,
    });
    return;
  }

  // Add rate limit headers
  res.setHeader("X-RateLimit-Remaining", rateCheck.remaining.toString());

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

    // 5. Build LLM history with smart compression
    // Strategy: Keep first message + key discoveries + recent context
    const MAX_RECENT = 10;
    const rows = historyRows ?? [];
    const firstUserIdx = rows.findIndex((r) => r.role === "user");
    const firstUser = firstUserIdx >= 0 ? rows[firstUserIdx] : null;

    const llmHistory: LLMMessage[] = [];

    // Extract key discoveries from middle messages (navigation paths, found elements)
    const keyDiscoveries: string[] = [];
    for (let i = firstUserIdx + 1; i < rows.length - MAX_RECENT; i++) {
      const row = rows[i];
      if (row.role === "assistant") {
        try {
          const parsed = JSON.parse(row.content as string) as {
            thinking?: string;
            message?: string;
            actions?: AgentAction[];
          };

          // Extract navigation discoveries
          if (parsed.thinking) {
            // Look for patterns like "found X", "navigated to Y", "the Z is in"
            const discoveries = parsed.thinking.match(
              /(?:found|discovered|located|navigated to|clicked on|the .{3,30} is (?:in|under|at))[^.!?]{5,60}/gi
            );
            if (discoveries) {
              keyDiscoveries.push(...discoveries.slice(0, 2));
            }
          }

          // Extract successful navigation actions
          if (parsed.actions && parsed.actions.length > 0) {
            const navActions = parsed.actions
              .filter((a) => a.description && (a.type === "click" || a.type === "type"))
              .map((a) => a.description)
              .slice(0, 2);
            keyDiscoveries.push(...(navActions as string[]));
          }
        } catch {
          // Skip malformed
        }
      }
    }

    // Deduplicate and limit discoveries
    const uniqueDiscoveries = [...new Set(keyDiscoveries)].slice(0, 5);

    // Include first user message with discoveries summary
    if (firstUser) {
      let content = `[ORIGINAL GOAL] ${firstUser.content as string}`;

      if (uniqueDiscoveries.length > 0 && rows.length > MAX_RECENT + 2) {
        content += `\n\n[KEY PROGRESS] ${uniqueDiscoveries.join(" → ")}`;
      }

      llmHistory.push({
        role: "user",
        content,
      });

      const recentStart = Math.max(firstUserIdx + 1, rows.length - MAX_RECENT);
      const omitted = recentStart - (firstUserIdx + 1);

      if (omitted > 0) {
        llmHistory.push({
          role: "assistant",
          content: JSON.stringify({
            thinking: `[${omitted} intermediate steps completed]`,
            actions: [],
            message: null,
            done: false,
          }),
        });
      }
    }

    // Add recent messages
    const recentStart = Math.max(firstUserIdx >= 0 ? firstUserIdx + 1 : 0, rows.length - MAX_RECENT);
    for (let i = recentStart; i < rows.length; i++) {
      const row = rows[i];
      const role = row.role as string;
      if (role === "user" || role === "action") {
        llmHistory.push({ role: "user", content: row.content as string });
      } else if (role === "assistant") {
        llmHistory.push({ role: "assistant", content: row.content as string });
      }
    }

    if (rows.length > MAX_RECENT + 2) {
      console.log(`[chat] PRUNED: ${rows.length} → ${llmHistory.length} messages, preserved ${uniqueDiscoveries.length} discoveries`);
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

    // Get previous subtasks for memory preservation
    let previousSubtasks: Subtask[] = [];

    for (const row of (historyRows ?? []).slice().reverse()) {
      if (row.role === "assistant") {
        try {
          const parsed = JSON.parse(row.content as string) as {
            subtasks?: Subtask[];
          };

          // Get subtasks from most recent assistant turn
          if (previousSubtasks.length === 0 && parsed.subtasks) {
            previousSubtasks = parsed.subtasks;
            break;  // Found what we need
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
      diff: req.body.diff || null,
      stepCount: req.body.stepCount,
      maxSteps: req.body.maxSteps,
      isActionResult,
      actionResults,
      pastActions: pastActions ?? [],
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
