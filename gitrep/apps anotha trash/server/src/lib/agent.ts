import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — Focused, minimal. DOM comes separately in the current turn.
// ═══════════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are a browser agent. You receive a compressed DOM and execute ONE action per turn.

ELEMENT FORMAT: [index]tag"label"=value[flags]
Examples: [1]btn"Submit" | [2]input[email]"Email"=test@...[req] | [3]a"Settings" | #1"Page Title" | >"visible text"

ACTIONS (pick ONE per turn):
- {"action":"click","index":N,"description":"what this clicks"}
- {"action":"type","index":N,"value":"text","description":"what field this fills"}
- {"action":"scroll","direction":"up|down","description":"why scrolling"}
- {"action":"complete","result":"what was accomplished"} — use when task is DONE

RESPONSE FORMAT:
{"thinking":"1 sentence","action":{...},"message":"optional user-facing message"}

RULES:
1. ONE action per turn. After click, STOP — indices change when page updates.
2. description is REQUIRED on every action.
3. Only use "complete" when you SEE confirmation (success message, expected state change).
4. If stuck after 3 attempts on same element, complete with failure explanation.`;

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface AgentAction {
  action: "click" | "type" | "scroll" | "complete";
  index?: number;
  value?: string;
  direction?: "up" | "down";
  description: string;
  result?: string; // For complete action
}

export interface AgentResponse {
  thinking: string;
  action: AgentAction | null;
  message: string | null;
}

export interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}

export interface DOMSnapshot {
  url: string;
  title: string;
  elements: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT — Single function, clean interface
// ═══════════════════════════════════════════════════════════════════════════════

export async function runAgent(params: {
  goal: string;
  history: HistoryEntry[]; // Just goal + action/result pairs, NO DOM
  dom: DOMSnapshot;
  turn: number;
}): Promise<AgentResponse> {
  const { goal, history, dom, turn } = params;

  // Build current turn context — DOM only appears HERE, never in history
  const currentContext = `TURN ${turn}/10 | PAGE: ${dom.url} | TITLE: ${dom.title}

DOM:
${dom.elements.join("\n")}

GOAL: ${goal}`;

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  // Add history (clean: just goal + action summaries + observations)
  for (const entry of history) {
    messages.push({ role: entry.role, content: entry.content });
  }

  // Add current turn with fresh DOM
  messages.push({ role: "user", content: currentContext });

  // Token estimate logging
  const estimatedTokens = messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
  console.log(`[agent] turn=${turn} tokens≈${estimatedTokens} elements=${dom.elements.length}`);

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    temperature: 0.1,
    max_tokens: 400,
    messages,
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  console.log("[agent] response:", raw.slice(0, 200));

  // Parse and validate
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      thinking: "Failed to parse response",
      action: { action: "complete", description: "Parse error", result: "Something went wrong." },
      message: "Something went wrong. Please try again.",
    };
  }

  const action = parsed.action as Record<string, unknown> | null;

  // Enforce description requirement
  if (action && !action.description) {
    action.description = `${action.action || "unknown"} on element ${action.index || "?"}`;
  }

  return {
    thinking: (parsed.thinking as string) || "",
    action: action as AgentAction | null,
    message: (parsed.message as string) || null,
  };
}
