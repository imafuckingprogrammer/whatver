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

function isDangerousAction(action: AgentAction): boolean {
  const desc = (action.description || "").toLowerCase();
  return (
    desc.includes("submit") ||
    desc.includes("delete") ||
    desc.includes("confirm") ||
    desc.includes("sign") ||
    desc.includes("log") ||
    desc.includes("save") ||
    desc.includes("checkout") ||
    desc.includes("pay")
  );
}

function validateResponse(
  response: AgentResult,
  recentActions: string[],
  previousSubtasks: Subtask[]
): { result: AgentResult; guardrailsApplied: string[] } {
  const guardrailsApplied: string[] = [];

  // 1. Preserve subtasks if agent forgot them
  if (response.subtasks.length === 0 && previousSubtasks.length > 0) {
    response.subtasks = previousSubtasks;
    guardrailsApplied.push("preserved_subtasks");
  }

  // 2. Enforce ONE CLICK per turn (navigation safety)
  // Multiple clicks are dangerous because the page may change after the first one
  const clickActions = response.actions.filter((a) => a.type === "click");
  if (clickActions.length > 1) {
    // Keep only the first click, plus any non-click actions before it
    const firstClickIdx = response.actions.findIndex((a) => a.type === "click");
    const beforeClick = response.actions.slice(0, firstClickIdx);
    const theClick = response.actions[firstClickIdx];
    response.actions = [...beforeClick, theClick];
    guardrailsApplied.push("single_click_enforced");
    console.log(`[guardrail] enforced single click - had ${clickActions.length} clicks`);
  }

  // 3. Isolate dangerous actions (submit/delete/etc go alone)
  const dangerousIdx = response.actions.findIndex(
    (a) => a.type === "click" && isDangerousAction(a)
  );
  if (dangerousIdx !== -1 && response.actions.length > 1) {
    const safe = response.actions.slice(0, dangerousIdx);
    if (safe.length > 0) {
      response.actions = safe;
      guardrailsApplied.push("deferred_dangerous");
    } else {
      response.actions = [response.actions[dangerousIdx]];
      guardrailsApplied.push("isolated_dangerous");
    }
  }

  // 4. Block duplicates
  const originalCount = response.actions.length;
  const blockedActions: string[] = [];
  response.actions = response.actions.filter((a) => {
    const key = `${a.type}:${a.index || ""}`;
    const count = recentActions.filter((r) => r === key).length;
    if (count >= 2) {
      console.log("[guardrail] blocked duplicate:", key);
      blockedActions.push(key);
      return false;
    }
    return true;
  });
  if (response.actions.length < originalCount) {
    guardrailsApplied.push("blocked_duplicates");
  }

  // 5. Force done when ALL actions were blocked (agent is stuck)
  if (response.actions.length === 0 && originalCount > 0) {
    // Agent tried to do something but we blocked everything - it's stuck
    response.done = true;
    response.message = `I got stuck trying the same action repeatedly (${blockedActions.join(", ")}). The element might not be what I expected, or the page changed. Please try rephrasing your request.`;
    guardrailsApplied.push("forced_done_stuck");
    console.log("[guardrail] forcing done - agent stuck on blocked actions");
  }

  // 6. Force done on stall (no actions and no message)
  if (response.actions.length === 0 && !response.message && !response.done) {
    response.done = true;
    response.message = "I couldn't complete this task. Please try again with more details.";
    guardrailsApplied.push("forced_done");
  }

  // 7. Cap actions
  if (response.actions.length > 5) {
    response.actions = response.actions.slice(0, 5);
    guardrailsApplied.push("capped_actions");
  }

  return { result: response, guardrailsApplied };
}

export async function runAgent(params: {
  history: LLMMessage[];
  userMessage: string | null;
  originalGoal: string | null;
  dom: DOMData | Record<string, unknown>[];
  isActionResult: boolean;
  actionResults?: ActionResult[];
  pastActions: Array<{ task_description: string; steps: string[] | unknown }>;
  recentActions?: string[];
  previousSubtasks?: Subtask[];
}): Promise<{ result: AgentResult; guardrailsApplied: string[] }> {
  const {
    history,
    userMessage,
    originalGoal,
    dom,
    isActionResult,
    actionResults,
    pastActions,
    recentActions = [],
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
    content += `**OBSERVATION**\n`;
    content += `**GOAL:** ${originalGoal || "unknown"}\n`;

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
    model: "gpt-4o",
    response_format: { type: "json_object" },
    temperature: 0.1,
    max_tokens: 800,
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
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
  const validated = validateResponse(rawResult, recentActions, previousSubtasks);

  if (validated.guardrailsApplied.length > 0) {
    console.log("[agent] GUARDRAILS:", validated.guardrailsApplied.join(", "));
  }

  return validated;
}
