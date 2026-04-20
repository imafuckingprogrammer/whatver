import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ═══════════════════════════════════════════════════════════════════════════
// DOM PARSER — Cheap model to structure messy DOM
// ═══════════════════════════════════════════════════════════════════════════

const PARSER_PROMPT = `You are a DOM parser. Convert raw browser elements into clean, structured output for an AI agent.

INPUT: Raw element strings like:
>"Some long text content here..."
[1]btn"Click me"
[2]input[email]"Email"=value

OUTPUT: JSON with this exact structure:
{
  "sections": [
    { "name": "header", "elements": ["[1]a'Logo'", "[2]btn'Menu'"] },
    { "name": "main form", "elements": ["[3]input'Email'", "[4]input'Password'", "[5]btn'Submit'"] }
  ],
  "content": {
    "5": "Full text content if it was truncated..."
  },
  "summary": "Login page with email/password form"
}

RULES:
1. Group related elements into logical sections (nav, form, sidebar, card, footer)
2. Simplify element format: [index]type'label' — drop flags unless critical
3. Skip noise: decorative text, script content, repeated items (keep first + count)
4. Truncate text >40 chars in elements, store full version in "content" map
5. "summary" = one line describing what this page/section is for
6. Keep interactive elements, drop pure text unless it's a heading or important message`;

interface ParsedDOM {
  sections: Array<{ name: string; elements: string[] }>;
  content: Record<string, string>;
  summary: string;
}

export async function parseDOM(rawElements: string[], pageInfo?: { url?: string; title?: string }): Promise<ParsedDOM> {
  const input = [
    pageInfo?.url ? `URL: ${pageInfo.url}` : "",
    pageInfo?.title ? `Title: ${pageInfo.title}` : "",
    "Elements:",
    ...rawElements,
  ].filter(Boolean).join("\n");

  try {
    const result = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 800,
      messages: [
        { role: "system", content: PARSER_PROMPT },
        { role: "user", content: input },
      ],
    });

    const usage = result.usage;
    console.log(`[parser] ${usage?.prompt_tokens || 0} in / ${usage?.completion_tokens || 0} out`);

    const parsed = JSON.parse(result.choices[0]?.message?.content || "{}");

    // Log parsed structure
    console.log(`[parser] summary: "${parsed.summary || "none"}"`);
    if (parsed.sections) {
      for (const s of parsed.sections) {
        console.log(`[parser]   [${s.name}] ${s.elements?.length || 0} elements`);
      }
    }
    return {
      sections: Array.isArray(parsed.sections) ? parsed.sections : [],
      content: typeof parsed.content === "object" ? parsed.content : {},
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
    };
  } catch (err) {
    console.error("[parser] error:", err);
    // Fallback: return raw elements as single section
    return {
      sections: [{ name: "page", elements: rawElements.slice(0, 30) }],
      content: {},
      summary: "Parse failed, showing raw elements",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN AGENT — Decision maker with clean DOM
// ═══════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are a browser automation agent. You see a structured view of the page and execute actions. Respond with JSON only.

## Page View
You receive parsed DOM organized into sections with a summary. Element format: [index]type'label'

## Actions
{"type":"click","index":N} — click element
{"type":"type","index":N,"text":"..."} — type in input (clears first)
{"type":"scroll","direction":"down"} — scroll page
{"type":"scroll","index":N} — scroll element into view
{"type":"hover","index":N} — hover to reveal dropdown
{"type":"wait","ms":1000} — wait for loading
{"type":"getContent","index":N} — fetch full text of truncated element (rarely needed)

## Response Format
{"think":"...","actions":[...],"message":"...","done":false}

- think: 1-2 sentence reasoning
- actions: what to do (max 5)
- message: tell user what you're doing (required)
- done: true only when task COMPLETE and VERIFIED

## Rules
1. After clicking links/buttons that navigate, STOP and wait for new page
2. Verify completion before done:true — look for success messages
3. If action fails, try DIFFERENT approach — don't repeat
4. Fill all form fields before clicking submit
5. Read the page summary to understand context`;

export interface AgentAction {
  type: "click" | "type" | "scroll" | "hover" | "wait" | "getContent";
  index?: number;
  text?: string;
  direction?: "up" | "down";
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
  parsedDOM?: ParsedDOM;
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
  progress?: string[];
  contentMap?: Record<string, string>; // For getContent responses
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
    contentMap = {},
  } = params;

  const domData = dom as DOMData;
  const pageContext = domData?.page || null;
  const rawElements: string[] = Array.isArray(domData?.elements) ? domData.elements : [];
  const offScreen = domData?.offScreen || null;

  // Step 1: Parse DOM with cheap model
  const parsedDOM = await parseDOM(rawElements, {
    url: pageContext?.url,
    title: pageContext?.title,
  });

  // Step 2: Build prompt for main agent
  let systemPrompt = SYSTEM_PROMPT;
  if (siteMemory.length > 0) {
    systemPrompt += "\n\n## Site Memory";
    for (const mem of siteMemory.slice(0, 2)) {
      systemPrompt += `\n"${mem.task}": ${mem.steps.slice(0, 4).join(" → ")}`;
    }
  }

  let content = "";

  // Page context
  if (pageContext) {
    content += `**PAGE:** ${pageContext.url}\n`;
    if (pageContext.urlChanged) {
      content += `*(navigated from ${pageContext.previousUrl})*\n`;
    }
  }

  // Page summary from parser
  if (parsedDOM.summary) {
    content += `**SUMMARY:** ${parsedDOM.summary}\n`;
  }

  // Goal
  if (originalGoal) {
    content += `**GOAL:** ${originalGoal}\n`;
  }

  // Progress
  if (progress.length > 0) {
    content += `**DONE:** ${progress.join(" → ")}\n`;
  }

  // Action results
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

  // Content map responses (from getContent calls)
  if (Object.keys(contentMap).length > 0) {
    content += "\n**CONTENT:**\n";
    for (const [idx, text] of Object.entries(contentMap)) {
      content += `[${idx}]: "${text.slice(0, 200)}${text.length > 200 ? "..." : ""}"\n`;
    }
  }

  // User message
  if (!isActionResult && userMessage) {
    content += `\n**USER:** ${userMessage}\n`;
  }

  // Off-screen hints
  if (offScreen) {
    const hints = [];
    if (offScreen.above) hints.push(`↑ ${offScreen.above} above`);
    if (offScreen.below && offScreen.below.length > 0) {
      hints.push(`↓ ${offScreen.below.join(", ")}`);
    }
    if (hints.length > 0) {
      content += `**OFF-SCREEN:** ${hints.join(" | ")}\n`;
    }
  }

  // Structured DOM sections
  content += "\n**SECTIONS:**\n";
  for (const section of parsedDOM.sections) {
    content += `[${section.name}]\n`;
    content += section.elements.join("\n") + "\n\n";
  }

  // Step 3: Call main agent
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    temperature: 0.2,
    max_tokens: 400,
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const usage = completion.usage;
  console.log(`[agent] ${usage?.prompt_tokens || 0} in / ${usage?.completion_tokens || 0} out`);

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
      parsedDOM,
    };
  }

  const result: AgentResult = {
    thinking: typeof parsed.think === "string" ? parsed.think :
              typeof parsed.thinking === "string" ? parsed.thinking : "",
    actions: Array.isArray(parsed.actions) ? (parsed.actions as AgentAction[]).slice(0, 5) : [],
    message: typeof parsed.message === "string" && parsed.message ? parsed.message : null,
    done: Boolean(parsed.done),
    parsedDOM,
  };

  // Log
  const actionSummary = result.actions.map((a) => `${a.type}(${a.index ?? ""})`).join(", ");
  console.log(`[agent] actions: ${actionSummary || "none"} | done: ${result.done}`);
  if (result.message) console.log(`[agent] says: "${result.message.slice(0, 50)}"`);

  return result;
}
