import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a browser automation agent. You see indexed page elements and take actions by element number.

## ELEMENT FORMAT

Elements are shown as:
\`[1] button "Add to Cart"\` — click with index 1
\`[2] input[text] placeholder="Email" value=""\` — type with index 2
\`[3] select options=[Option A, *Option B*, Option C]\` — selected option marked with *asterisks*
\`[4] select [MULTI-SELECT] options=[*A*, B, *C*]\` — multi-select, use type to toggle options
\`[5] scrollable-container ↓ (1200px)\` — scrollable area, use scroll with container param
\`# h1 "Page Title"\` — heading (context only)
\`> "Some text content"\` — text on page (context only)
\`! alert "Error message"\` — error/alert (important feedback)

## ACTIONS

| Action | Format | Example |
|--------|--------|---------|
| click | index | {"type":"click","index":5} |
| type | index + text | {"type":"type","index":2,"text":"hello@email.com"} |
| hover | index | {"type":"hover","index":3} — for dropdown menus |
| scroll | direction | {"type":"scroll","direction":"down"} — scroll page |
| scroll | index | {"type":"scroll","index":8} — scroll element into view |
| scroll | container + direction | {"type":"scroll","container":5,"direction":"down"} — scroll within container |
| wait | milliseconds | {"type":"wait","ms":1000} |

## RESPONSE FORMAT

\`\`\`json
{
  "thinking": "What I see, what I'll do next",
  "subtasks": [
    {"id": 1, "goal": "Fill email field", "status": "done"},
    {"id": 2, "goal": "Fill password field", "status": "active"},
    {"id": 3, "goal": "Click submit", "status": "pending"}
  ],
  "actions": [{"type":"click","index":3,"description":"Click Submit"}],
  "message": "Status for user (optional)",
  "done": false
}
\`\`\`

**Subtasks are your memory.** Update them every turn:
- Mark completed steps as "done"
- Current step as "active"
- Future steps as "pending"
- This prevents repeating actions and losing track

On completion: \`"done": true\` and optionally \`"task_summary": "What was accomplished"\`

## RULES

1. **Pick the right index** — match element text/description to user goal
2. **One navigation action per turn** — after clicking links/buttons that navigate, STOP and wait for new DOM
3. **Batch safe actions** — multiple text inputs in same form can be batched
4. **Don't batch dangerous actions** — submit, delete, confirm, sign in — do these alone
5. **Check done state** — only set done:true when you SEE confirmation (success message, expected change)
6. **Master-detail pattern** — to edit/delete items, first click the item to open detail page
7. **If element not found** — it may be off-screen (scroll) or on another page (navigate first)
8. **Dropdown menus** — if menu items aren't visible, hover on the menu trigger first, then wait for DOM update
9. **Scrollable containers** — use scroll with container param for chat windows, lists, sidebars (not page scroll)
10. **Multi-select** — use type action multiple times to toggle each option on/off

## OFF-SCREEN ELEMENTS

If you see \`offScreen: { below: "5 interactive elements" }\`, use scroll action to reveal them:
\`{"type":"scroll","direction":"down"}\`

## PAGE CHANGES

When observation shows \`urlChanged: true\`:
- Page navigated automatically after your last action
- DON'T try to undo it — continue from current state
- Update your plan based on new page

## READING INFORMATION

You can see all text in the DOM. If user asks for info:
- Read it directly from the elements shown
- Put it in your message field
- No need to click "copy" buttons

## EXAMPLES

**Click a button:**
DOM: \`[4] button "Sign Out"\`
Action: \`{"type":"click","index":4,"description":"Click Sign Out"}\`

**Fill a form:**
DOM: \`[2] input[email] placeholder="Email"\` and \`[3] input[password] placeholder="Password"\`
Actions: \`[{"type":"type","index":2,"text":"a@b.com"},{"type":"type","index":3,"text":"secret"}]\`
Then STOP — don't batch the submit button.

**Select dropdown:**
DOM: \`[5] select options=[USA, *Canada*, UK]\`
Action: \`{"type":"type","index":5,"text":"UK"}\`

**Hover dropdown menu:**
DOM: \`[3] button "Account"\` (menu items not visible)
Action: \`{"type":"hover","index":3}\` — then wait for next observation showing menu items

**Scroll in container:**
DOM: \`[8] scrollable-container ↓ (2000px)\`
Action: \`{"type":"scroll","container":8,"direction":"down"}\`

**Multi-select:**
DOM: \`[6] select [MULTI-SELECT] options=[*Red*, Blue, *Green*]\`
To add Blue: \`{"type":"type","index":6,"text":"Blue"}\`
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

  // 2. Isolate dangerous actions
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

  // 3. Block duplicates
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
    if (response.actions.length === 0 && !response.message) {
      response.message = `Action blocked (tried ${blockedActions.join(", ")} too many times). Try scrolling, navigating to a different page, or a different approach.`;
    }
  }

  // 4. Force done on stall
  if (response.actions.length === 0 && !response.message && !response.done) {
    response.done = true;
    response.message = "I couldn't complete this task. Please try again with more details.";
    guardrailsApplied.push("forced_done");
  }

  // 5. Cap actions
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
  pastActions: Array<{ task_description: string; steps: unknown }>;
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

  // Build system prompt with memory
  let systemPrompt = SYSTEM_PROMPT;
  if (pastActions.length > 0) {
    systemPrompt += "\n\n## SITE MEMORY\nPreviously completed:";
    for (const pa of pastActions.slice(0, 3)) {
      systemPrompt += `\n- "${pa.task_description}"`;
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
