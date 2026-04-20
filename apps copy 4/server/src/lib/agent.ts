import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a browser automation agent. You see indexed page elements and take actions by element number.

## ELEMENT FORMAT (compact)

Interactive elements: \`[index]tag"label"=value[flags] hint\`
- \`[1]btn"Add to Cart"\` — button, click with index 1
- \`[2]input[email]"Email"=john@...[req]\` — email input, required, has value
- \`[3]sel"Country"(*USA*|Canada|UK)\` — select dropdown, USA selected
- \`[4]input[checkbox]"Newsletter"[OFF]\` — unchecked checkbox
- \`[5]btn(menuitem)"Settings"[open]\` — button with role=menuitem, expanded
- \`[6]scroll↓1200px\` — scrollable container, can scroll down

**Flags:** ON/OFF (checkbox/radio), open/closed (expandable), pressed, selected, disabled, req (required), readonly
**Validation hint:** \`!message\` after flags means validation error: \`[3]input[email]"Email"[req] !Please enter valid email\`
**Alerts:** \`!err"message"\` or \`!ok"message"\` or \`!status"message"\`
**Headings:** \`#1"Page Title"\` (h1), \`#2"Section"\` (h2)
**Text:** \`>"Some content on page"\`

## ACTIONS

{"type":"click","index":5} — click element
{"type":"type","index":2,"text":"hello@email.com"} — type in input
{"type":"hover","index":3} — hover (for dropdowns)
{"type":"scroll","direction":"down"} — scroll page
{"type":"scroll","index":8} — scroll element into view
{"type":"scroll","container":5,"direction":"down"} — scroll within container
{"type":"wait","ms":1000} — wait

## RESPONSE FORMAT (JSON)

Respond with valid JSON:
{"thinking":"...","subtasks":[{"id":1,"goal":"...","status":"done|active|pending"}],"actions":[...],"message":"...","done":false}

**Subtasks = your memory.** Update every turn: done/active/pending. Prevents repeating actions.
On completion: \`"done":true\` + optional \`"task_summary":"..."\`

## CRITICAL RULES

1. **ONE CLICK PER TURN for links/navigation** — After ANY click on a link (\`a\`) or navigation button, you MUST stop and wait for the next observation. The page will change and all indices will be different!
   - WRONG: \`"actions":[{"type":"click","index":2},{"type":"click","index":5}]\` (clicking multiple links)
   - RIGHT: \`"actions":[{"type":"click","index":2}]\` (one link, then wait)

2. **Indices change after navigation** — When you click a link and the page changes, element [2] on the old page is NOT element [2] on the new page. You must wait for the new DOM.

3. **Match index to goal** — read element labels/text carefully before clicking

4. **Batch ONLY form inputs** — Multiple type() actions in the same form = OK. Multiple click() actions = NEVER batch.

5. **Dangerous actions alone** — submit/delete/confirm/sign/pay — execute one at a time

6. **Check for confirmation** — only done:true when you SEE success message or expected change

7. **Validation errors** — if you see \`!error message\`, fix that field first

8. **Disabled elements** — [disabled] can't be clicked, find alternative

9. **Off-screen elements** — scroll to reveal them first

10. **Dropdowns** — hover first if menu items not visible

11. **Step budget** — Check your step count in the observation header. Plan efficiently within your budget.

12. **Check WHAT CHANGED** — After actions, the diff tells you exactly what happened. If expected change didn't appear, something went wrong — investigate before continuing.

13. **Element not found = re-observe** — If you can't find an element after 2 attempts, ask the user for help instead of looping. The element may not exist or may be off-screen.

## KEY PATTERNS

**Form with validation error:**
\`[2]input[email]"Email"=bad[req] !Please include @\`
→ Fix the field: {"type":"type","index":2,"text":"valid@email.com"}

**Expandable menu:**
\`[3]btn"Account"[closed]\`
→ Click to expand, wait for DOM update showing menu items

**Multi-select:**
\`[6]sel"Colors"(*Red*|Blue|*Green*)\` — Red and Green selected
→ Toggle Blue: {"type":"type","index":6,"text":"Blue"}

**Multi-page navigation (CRITICAL):**
Goal: "Delete the first item"
- Turn 1: See \`[2]a"Item 1"\` → actions:[{click,index:2}] then STOP
- Turn 2: New page! See \`[5]btn"Delete"\` → actions:[{click,index:5}] then STOP
- Turn 3: See \`!ok"Deleted"\` → done:true
NEVER batch multiple link clicks! Each navigation = new DOM = new indices.
`;

export interface AgentAction {
  type: "click" | "type" | "scroll" | "hover" | "wait";
  index?: number;
  text?: string;
  direction?: "up" | "down";
  container?: number; // For scrolling within a container
  ms?: number;
  description?: string;
}

export interface ActionResult {
  type: string;
  index?: number;
  success: boolean;
  error?: string | null;
  hint?: string | null; // Helpful suggestion when action fails
}

export interface PageContext {
  url: string;
  title: string;
  urlChanged?: boolean;
  previousUrl?: string | null;
}

export interface DOMData {
  page?: PageContext;
  elements?: string[];
  offScreen?: { above?: string; below?: string } | null;
}

export interface Subtask {
  id: number;
  goal: string;
  status: "done" | "active" | "pending";
}

export interface AgentResult {
  thinking: string;
  subtasks: Subtask[];
  actions: AgentAction[];
  message: string | null;
  done: boolean;
  task_summary: string | null;
}

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// GUARDRAILS
// ═══════════════════════════════════════════════════════════════════════════

function validateResponse(
  response: AgentResult,
  previousSubtasks: Subtask[]
): { result: AgentResult; guardrailsApplied: string[] } {
  const guardrailsApplied: string[] = [];

  // 1. Preserve subtasks if agent forgot them (USEFUL - memory)
  if (response.subtasks.length === 0 && previousSubtasks.length > 0) {
    response.subtasks = previousSubtasks;
    guardrailsApplied.push("preserved_subtasks");
  }

  // 2. Force done on stall (no actions and no message) - prevents infinite empty loops
  if (response.actions.length === 0 && !response.message && !response.done) {
    response.done = true;
    response.message = "I couldn't complete this task. Please try again with more details.";
    guardrailsApplied.push("forced_done");
  }

  return { result: response, guardrailsApplied };
}

export async function runAgent(params: {
  history: LLMMessage[];
  userMessage: string | null;
  originalGoal: string | null;
  dom: DOMData | Record<string, unknown>[];
  diff?: string | null;
  stepCount?: number;
  maxSteps?: number;
  isActionResult: boolean;
  actionResults?: ActionResult[];
  pastActions: Array<{ task_description: string; steps: string[] | unknown }>;
  previousSubtasks?: Subtask[];
}): Promise<{ result: AgentResult; guardrailsApplied: string[] }> {
  const {
    history,
    userMessage,
    originalGoal,
    dom,
    diff,
    stepCount,
    maxSteps,
    isActionResult,
    actionResults,
    pastActions,
    previousSubtasks = [],
  } = params;

  // Parse DOM data
  const domData = dom as DOMData;
  const pageContext = domData?.page || null;
  const elements: string[] = Array.isArray(domData?.elements) ? domData.elements : [];
  const offScreen = domData?.offScreen || null;

  // Build system prompt with memory (actual recipes, not just task names)
  let systemPrompt = SYSTEM_PROMPT;
  if (pastActions.length > 0) {
    systemPrompt += "\n\n## SITE MEMORY\nPrevious successful tasks on this site:";
    for (const pa of pastActions.slice(0, 2)) {
      systemPrompt += `\n\n**"${pa.task_description}"**`;
      const steps = pa.steps as string[];
      if (Array.isArray(steps) && steps.length > 0) {
        systemPrompt += `\nSteps: ${steps.slice(0, 5).join(" → ")}`;
      }
    }
  }

  // Build current turn content
  let content = "";

  if (isActionResult) {
    // Include step budget in header for agent awareness
    const stepInfo = stepCount && maxSteps ? ` — Step ${stepCount}/${maxSteps}` : "";
    content += `**OBSERVATION${stepInfo}**\n`;
    content += `**GOAL:** ${originalGoal || "unknown"}\n\n`;

    // WHAT CHANGED - critical for agent to understand action effects
    if (diff) {
      content += `**WHAT CHANGED:**\n${diff}\n\n`;
    }

    if (pageContext) {
      if (pageContext.urlChanged) {
        content += `**PAGE CHANGED:** ${pageContext.previousUrl} → ${pageContext.url}\n`;
      } else {
        content += `**PAGE:** ${pageContext.url}\n`;
      }
      content += `**TITLE:** ${pageContext.title}\n\n`;
    }

    // Include previous subtasks so agent remembers its plan
    if (previousSubtasks.length > 0) {
      content += `**YOUR SUBTASKS:** ${JSON.stringify(previousSubtasks)}\n\n`;
    }

    if (actionResults && actionResults.length > 0) {
      content += "**RESULTS:**\n";
      for (const r of actionResults) {
        const status = r.success ? "✓" : "✗";
        const err = r.error ? ` — ${r.error}` : "";
        const hint = r.hint ? ` [HINT: ${r.hint}]` : "";
        content += `${status} ${r.type}(${r.index || ""})${err}${hint}\n`;
      }
      content += "\n";
    }
  } else {
    content += `**TASK**\n`;
    if (pageContext) {
      content += `**PAGE:** ${pageContext.url}\n`;
      content += `**TITLE:** ${pageContext.title}\n\n`;
    }
    content += `**USER GOAL:** ${userMessage}\n\n`;
  }

  // Add elements
  let offScreenHint = "";
  if (offScreen) {
    const parts = [];
    if (offScreen.above) parts.push(`↑ ${offScreen.above}`);
    if (offScreen.below) parts.push(`↓ ${offScreen.below}`);
    if (parts.length > 0) offScreenHint = ` (${parts.join(", ")} — scroll to see)`;
  }

  content += `**DOM${offScreenHint}:**\n${elements.join("\n")}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-5.4-mini",
    response_format: { type: "json_object" },
    temperature: 0.1,
    max_completion_tokens: 1200,
    messages: [
      { role: "system", content: systemPrompt },
      ...history.slice(-8),  // Truncate to last 8 messages to prevent unbounded growth
      { role: "user", content },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";

  // Token tracking
  const usage = completion.usage;
  console.log(
    "\n[agent] TOKENS:",
    `${usage?.prompt_tokens || 0} in + ${usage?.completion_tokens || 0} out = ${usage?.total_tokens || 0}`
  );
  console.log("[agent] RESPONSE:", raw.slice(0, 150).replace(/\n/g, " "));

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {
      thinking: "Parse error",
      message: "Something went wrong. Please try again.",
      actions: [],
      done: true,
    };
  }

  const rawResult: AgentResult = {
    thinking: typeof parsed.thinking === "string" ? parsed.thinking : "",
    subtasks: Array.isArray(parsed.subtasks) ? (parsed.subtasks as Subtask[]) : [],
    actions: Array.isArray(parsed.actions) ? (parsed.actions as AgentAction[]) : [],
    message: typeof parsed.message === "string" && parsed.message ? parsed.message : null,
    done: Boolean(parsed.done),
    task_summary: typeof parsed.task_summary === "string" ? parsed.task_summary : null,
  };

  // Log actions
  const actionSummary = rawResult.actions
    .map((a) => `${a.type}(${a.index || ""})`)
    .join(", ");
  console.log("[agent] ACTIONS:", actionSummary || "none");
  console.log("[agent] SUBTASKS:", rawResult.subtasks.length);
  console.log("[agent] DONE:", rawResult.done ? "YES" : "no");

  // Apply guardrails
  const validated = validateResponse(rawResult, previousSubtasks);

  if (validated.guardrailsApplied.length > 0) {
    console.log("[agent] GUARDRAILS:", validated.guardrailsApplied.join(", "));
  }

  return validated;
}
