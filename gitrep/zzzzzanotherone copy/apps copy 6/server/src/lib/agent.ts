import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a browser automation agent. You see indexed page elements and execute actions. Respond with JSON only.

## Element Format
\`[index]type"label"=value[flags]\`
- \`[1]btn"Submit"\` — button
- \`[2]input[email]"Email"=john@...[req]\` — required email field with value
- \`[3]a"Products"(->\/products)\` — link with href
- \`[4]sel"Country"(*USA*|Canada)\` — select, USA selected
- Flags: ON/OFF (checkbox), open/closed (expandable), disabled, req

## Actions
\`{"type":"click","index":N}\` — click element
\`{"type":"type","index":N,"text":"..."}\` — type in input (clears first)
\`{"type":"scroll","direction":"down"}\` — scroll page
\`{"type":"scroll","index":N}\` — scroll element into view
\`{"type":"hover","index":N}\` — hover to reveal dropdown
\`{"type":"wait","ms":1000}\` — wait for animations/loading

## Response Format
\`{"think":"...","actions":[...],"message":"...","done":false}\`

- **think**: Your reasoning (1-2 sentences)
- **actions**: Array of actions to execute
- **message**: What to tell the user (optional unless done)
- **done**: true only when task is COMPLETE and VERIFIED

## Rules
1. After clicking a link or submit button, STOP — wait for the new page
2. Verify completion before done:true — look for success messages or expected changes
3. If an action fails, try a DIFFERENT approach — don't repeat the same thing
4. Fill forms before submitting — batch type() actions, then separate click()
5. Match element text to your intent — read labels carefully before acting
`;

export interface AgentAction {
  type: "click" | "type" | "scroll" | "hover" | "wait";
  index?: number;
  text?: string;
  direction?: "up" | "down";
  container?: number;
  ms?: number;
}

export interface ActionResult {
  type: string;
  index?: number;
  success: boolean;
  error?: string | null;
  hint?: string | null;
}

export interface PageContext {
  url: string;
  title: string;
  pageType?: string;
  urlChanged?: boolean;
  previousUrl?: string | null;
}

export interface DOMData {
  page?: PageContext;
  elements?: string[];
  offScreen?: { above?: number; below?: string[] } | null;
}

export interface AgentResult {
  thinking: string;
  actions: AgentAction[];
  message: string | null;
  done: boolean;
}

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export async function runAgent(params: {
  history: LLMMessage[];
  userMessage: string | null;
  originalGoal: string | null;
  dom: DOMData | Record<string, unknown>;
  isActionResult: boolean;
  actionResults?: ActionResult[];
  siteMemory?: Array<{ task: string; steps: string[] }>;
  progress?: string[]; // What steps have been completed so far
}): Promise<AgentResult> {
  const {
    history,
    userMessage,
    originalGoal,
    dom,
    isActionResult,
    actionResults,
    siteMemory = [],
    progress = [],
  } = params;

  const domData = dom as DOMData;
  const pageContext = domData?.page || null;
  const elements: string[] = Array.isArray(domData?.elements) ? domData.elements : [];
  const offScreen = domData?.offScreen || null;

  // Build system prompt with site memory (if any)
  let systemPrompt = SYSTEM_PROMPT;
  if (siteMemory.length > 0) {
    systemPrompt += "\n\n## Past Successes on This Site";
    for (const mem of siteMemory.slice(0, 2)) {
      systemPrompt += `\n"${mem.task}": ${mem.steps.slice(0, 4).join(" → ")}`;
    }
  }

  // Build current turn content
  let content = "";

  // Page context header
  if (pageContext) {
    content += `**PAGE:** ${pageContext.url}`;
    if (pageContext.pageType) content += ` [${pageContext.pageType}]`;
    content += `\n**TITLE:** ${pageContext.title}\n`;
    if (pageContext.urlChanged) {
      content += `*(page just changed from ${pageContext.previousUrl})*\n`;
    }
  }

  // Goal reminder
  if (originalGoal) {
    content += `**GOAL:** ${originalGoal}\n`;
  }

  // Progress so far (persists even when history truncates)
  if (progress.length > 0) {
    content += `**DONE:** ${progress.join(" → ")}\n`;
  }

  // Action results (if this is a continuation)
  if (isActionResult && actionResults && actionResults.length > 0) {
    content += "\n**RESULTS:**\n";
    for (const r of actionResults) {
      const status = r.success ? "✓" : "✗";
      const detail = r.index !== undefined ? `(${r.index})` : "";
      const err = r.error ? ` — ${r.error}` : "";
      const hint = r.hint ? ` [${r.hint}]` : "";
      content += `${status} ${r.type}${detail}${err}${hint}\n`;
    }
  }

  // New user message
  if (!isActionResult && userMessage) {
    content += `\n**USER:** ${userMessage}\n`;
  }

  // Off-screen hints
  if (offScreen) {
    const hints = [];
    if (offScreen.above) hints.push(`↑ ${offScreen.above} elements above`);
    if (offScreen.below && offScreen.below.length > 0) {
      hints.push(`↓ below: ${offScreen.below.join(", ")}`);
    }
    if (hints.length > 0) {
      content += `\n**OFF-SCREEN:** ${hints.join(" | ")}\n`;
    }
  }

  // DOM elements
  content += `\n**DOM:**\n${elements.join("\n")}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    temperature: 0.2,
    max_tokens: 600,
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";

  // Logging
  const usage = completion.usage;
  console.log(
    `[agent] ${usage?.prompt_tokens || 0} in / ${usage?.completion_tokens || 0} out`
  );

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("[agent] JSON parse failed:", raw.slice(0, 100));
    return {
      thinking: "Failed to parse response",
      actions: [],
      message: "Something went wrong. Please try again.",
      done: true,
    };
  }

  const result: AgentResult = {
    thinking: typeof parsed.think === "string" ? parsed.think :
              typeof parsed.thinking === "string" ? parsed.thinking : "",
    actions: Array.isArray(parsed.actions) ? (parsed.actions as AgentAction[]).slice(0, 5) : [],
    message: typeof parsed.message === "string" && parsed.message ? parsed.message : null,
    done: Boolean(parsed.done),
  };

  // Log what we got
  const actionSummary = result.actions.map((a) => `${a.type}(${a.index ?? ""})`).join(", ");
  console.log(`[agent] actions: ${actionSummary || "none"} | done: ${result.done}`);

  return result;
}
