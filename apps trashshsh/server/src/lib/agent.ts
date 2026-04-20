import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — Layer 2: LLM Planner
// ═══════════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are a browser automation agent. You see indexed page elements and execute actions by element number.

## ELEMENT FORMAT (compact)

Interactive elements: \`[index]tag"label"=value[flags]\`
- \`[1]btn"Add to Cart"\` — button, click with index 1
- \`[2]input[email]"Email"=john@...[req]\` — email input, required, has value
- \`[3]sel"Country"(*USA*|Canada|UK)\` — select dropdown, USA selected
- \`[4]input[checkbox]"Newsletter"[OFF]\` — unchecked checkbox
- \`[5]a"Settings"(->settings)\` — link to /settings
- \`[6]scroll↓\` — scrollable container, can scroll down

**Flags:** ON/OFF (checkbox/radio), open/closed (expandable), disabled, req (required)
**Validation:** \`!message\` means validation error: \`[3]input"Email"[req] !Please enter valid email\`
**Alerts:** \`!err"message"\` or \`!ok"message"\` — success/error notifications
**Headings:** \`#1"Title"\` (h1), \`#2"Section"\` (h2), \`#3"Subsection"\` (h3)
**Text:** \`>"Some visible content"\`

## ACTIONS

Return actions as JSON array. Each action needs:
- type: "click" | "type" | "scroll" | "hover" | "wait"
- index: element number (required for click/type/hover)
- text: string for type actions
- direction: "up" | "down" for page scroll
- container: element number for container scroll
- description: REQUIRED — human-readable description of what this does

{"type":"click","index":5,"description":"Click Settings button"}
{"type":"type","index":2,"text":"hello@email.com","description":"Enter email address"}
{"type":"scroll","direction":"down","description":"Scroll page down"}
{"type":"scroll","container":6,"direction":"down","description":"Scroll list container"}
{"type":"hover","index":3,"description":"Hover to open dropdown"}
{"type":"wait","ms":1000,"description":"Wait for animation"}

## RESPONSE FORMAT (JSON)

{
  "thinking": "Brief analysis of current state and what to do next",
  "subtasks": [{"id":1,"goal":"...","status":"done|active|pending"}],
  "actions": [...],
  "message": "Optional message to show user",
  "done": false
}

On completion: \`"done":true\` with optional \`"task_summary":"Brief description of what was accomplished"\`

**Subtasks = your memory.** Update status every turn. This prevents repeating work.

## CRITICAL RULES

### Navigation Safety
1. **ONE CLICK PER TURN for navigation** — After clicking any link or navigation button, STOP and wait for observation. The page will change and all element indices will be invalid!
2. **Indices change after navigation** — Element [2] on page A is NOT element [2] on page B. Always wait for new DOM after any click that might navigate.

### Action Batching
3. **Batch ONLY form inputs** — Multiple type() in same form = OK. Multiple click() = NEVER batch.
4. **Dangerous actions ALONE** — submit/delete/confirm/sign/pay — execute one at a time, alone.

### EXACT MATCHING (Critical for destructive actions)
5. **When deleting/modifying a named item, match the EXACT full name only.** If user says "delete site10", only target an element labeled exactly "site10" — never "newsite10", "site100", or "mysite10". If no exact match exists, report it — NEVER act on partial matches.

### VERIFY AFTER DESTRUCTIVE ACTIONS
6. **After delete/confirm/submit, look for success indicators.** After a destructive action, check the next observation for:
   - Success message (!ok"..." or similar)
   - Absence of the deleted item
   - Confirmation toast/alert
   If you see confirmation, mark that subtask DONE immediately. Don't keep looking for what you just deleted.

### Completion
7. **Only done:true when you SEE success** — confirmation message, expected change visible, or task objectively complete
8. **Validation errors first** — if you see \`!error message\`, fix that field before submitting

### Disabled/Hidden Elements
9. **[disabled] elements can't be clicked** — find an alternative or report the issue
10. **Scroll to reveal** — if element might be off-screen, scroll first

## KEY PATTERNS

**Delete flow (CRITICAL):**
1. Find the EXACT item (exact name match only)
2. Click delete button (alone) → STOP, wait for confirmation dialog
3. See confirm dialog → click confirm (alone) → STOP, wait for result
4. See success message or item gone → done:true

**Form with validation error:**
\`[2]input[email]"Email"=bad[req] !Please include @\`
→ Fix: {"type":"type","index":2,"text":"valid@email.com","description":"Fix email format"}

**Multi-page navigation:**
Turn 1: See \`[2]a"Item 1"\` → [{click, index:2, description:"Navigate to Item 1"}] then STOP
Turn 2: New page! See \`[5]btn"Delete"\` → [{click, index:5, description:"Click delete"}] then STOP
Turn 3: See \`[8]btn"Confirm"\` → [{click, index:8, description:"Confirm deletion"}] then STOP
Turn 4: See \`!ok"Deleted successfully"\` → done:true
`;

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface AgentAction {
  type: "click" | "type" | "scroll" | "hover" | "wait";
  index?: number;
  text?: string;
  direction?: "up" | "down";
  container?: number;
  ms?: number;
  description: string; // Now required
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
  urlChanged?: boolean;
  previousUrl?: string | null;
}

export interface DOMSnapshot {
  page: PageContext;
  elements: string[];
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

// Compact history entry — NO DOM, just what happened
export interface HistoryEntry {
  role: "user" | "assistant" | "observation";
  content: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GUARDRAILS
// ═══════════════════════════════════════════════════════════════════════════════

function isDangerousAction(action: AgentAction): boolean {
  const desc = action.description.toLowerCase();
  return (
    desc.includes("submit") ||
    desc.includes("delete") ||
    desc.includes("confirm") ||
    desc.includes("sign") ||
    desc.includes("log") ||
    desc.includes("save") ||
    desc.includes("checkout") ||
    desc.includes("pay") ||
    desc.includes("remove")
  );
}

function validateAndEnforceRules(
  response: AgentResult,
  recentActions: string[],
  previousSubtasks: Subtask[]
): { result: AgentResult; guardrailsApplied: string[] } {
  const guardrailsApplied: string[] = [];

  // BUG FIX #2: Enforce description field — never let it be empty
  for (const action of response.actions) {
    if (!action.description || action.description.trim() === "") {
      action.description = `${action.type} element ${action.index ?? "page"}`;
      guardrailsApplied.push("description_enforced");
    }
  }

  // Preserve subtasks if agent forgot them
  if (response.subtasks.length === 0 && previousSubtasks.length > 0) {
    response.subtasks = previousSubtasks;
    guardrailsApplied.push("preserved_subtasks");
  }

  // GUARDRAIL: Single click enforcement
  const clickActions = response.actions.filter((a) => a.type === "click");
  if (clickActions.length > 1) {
    const firstClickIdx = response.actions.findIndex((a) => a.type === "click");
    const beforeClick = response.actions.slice(0, firstClickIdx);
    const theClick = response.actions[firstClickIdx];
    response.actions = [...beforeClick, theClick];
    guardrailsApplied.push("single_click_enforced");
    console.log(`[guardrail] enforced single click — had ${clickActions.length} clicks`);
  }

  // GUARDRAIL: Isolate dangerous actions
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

  // GUARDRAIL: Block duplicates
  const originalCount = response.actions.length;
  const blockedActions: string[] = [];
  response.actions = response.actions.filter((a) => {
    const key = `${a.type}:${a.index ?? ""}`;
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

  // GUARDRAIL: Force done when stuck
  if (response.actions.length === 0 && originalCount > 0) {
    response.done = true;
    response.message = `I got stuck trying the same action repeatedly (${blockedActions.join(", ")}). The element might not be what I expected. Please try rephrasing your request.`;
    guardrailsApplied.push("forced_done_stuck");
    console.log("[guardrail] forcing done — agent stuck on blocked actions");
  }

  // GUARDRAIL: Force done on stall
  if (response.actions.length === 0 && !response.message && !response.done) {
    response.done = true;
    response.message = "I couldn't complete this task. Please try again with more details.";
    guardrailsApplied.push("forced_done_stall");
  }

  // GUARDRAIL: Cap actions at 5
  if (response.actions.length > 5) {
    response.actions = response.actions.slice(0, 5);
    guardrailsApplied.push("capped_actions");
  }

  return { result: response, guardrailsApplied };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUN AGENT — Layer 2 LLM Call
// ═══════════════════════════════════════════════════════════════════════════════

export async function runAgent(params: {
  // BUG FIX #1: History contains ONLY compact summaries, NO DOM
  history: HistoryEntry[];
  // BUG FIX #5: Original goal preserved separately, always included
  originalGoal: string;
  // Current DOM snapshot — ONLY place DOM appears
  dom: DOMSnapshot;
  // Action results from last turn (if any)
  actionResults?: ActionResult[];
  // Site memory: past successful tasks
  siteMemory?: Array<{ task: string; steps: string[] }>;
  // For guardrails
  recentActions?: string[];
  previousSubtasks?: Subtask[];
}): Promise<{ result: AgentResult; guardrailsApplied: string[] }> {
  const {
    history,
    originalGoal,
    dom,
    actionResults = [],
    siteMemory = [],
    recentActions = [],
    previousSubtasks = [],
  } = params;

  // Build system prompt with site memory
  let systemPrompt = SYSTEM_PROMPT;
  if (siteMemory.length > 0) {
    systemPrompt += "\n\n## SITE MEMORY\nPrevious successful tasks on this site:";
    for (const mem of siteMemory.slice(0, 2)) {
      systemPrompt += `\n\n**"${mem.task}"**`;
      if (mem.steps.length > 0) {
        systemPrompt += `\nSteps: ${mem.steps.slice(0, 5).join(" → ")}`;
      }
    }
  }

  // Build messages for LLM
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
  ];

  // BUG FIX #5: Always include original goal as first message
  messages.push({
    role: "user",
    content: `[ORIGINAL GOAL] ${originalGoal}`,
  });

  // BUG FIX #1: Add compact history (NO DOM — just summaries)
  for (const entry of history) {
    if (entry.role === "user" || entry.role === "observation") {
      messages.push({ role: "user", content: entry.content });
    } else {
      messages.push({ role: "assistant", content: entry.content });
    }
  }

  // Build current turn content — THIS is where DOM goes
  let currentTurn = "**CURRENT OBSERVATION**\n\n";

  // Page context
  const { page, elements } = dom;
  if (page.urlChanged) {
    currentTurn += `**PAGE CHANGED:** ${page.previousUrl} → ${page.url}\n`;
  } else {
    currentTurn += `**PAGE:** ${page.url}\n`;
  }
  currentTurn += `**TITLE:** ${page.title}\n\n`;

  // Action results from last turn
  if (actionResults.length > 0) {
    currentTurn += "**LAST ACTION RESULTS:**\n";
    for (const r of actionResults) {
      const status = r.success ? "OK" : "FAIL";
      const err = r.error ? ` — ${r.error}` : "";
      const hint = r.hint ? ` [${r.hint}]` : "";
      currentTurn += `${status}: ${r.type}(${r.index ?? ""})${err}${hint}\n`;
    }
    currentTurn += "\n";
  }

  // Subtasks reminder
  if (previousSubtasks.length > 0) {
    currentTurn += `**YOUR SUBTASKS:** ${JSON.stringify(previousSubtasks)}\n\n`;
  }

  // DOM snapshot — the only place DOM appears in the context
  currentTurn += `**DOM (${elements.length} elements):**\n${elements.join("\n")}`;

  messages.push({ role: "user", content: currentTurn });

  // Call LLM
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    temperature: 0.1,
    max_tokens: 800,
    messages,
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";

  // Token logging
  const usage = completion.usage;
  console.log(
    "\n[agent] TOKENS:",
    `${usage?.prompt_tokens ?? 0} in + ${usage?.completion_tokens ?? 0} out = ${usage?.total_tokens ?? 0}`
  );
  console.log("[agent] RAW:", raw.slice(0, 150).replace(/\n/g, " "));

  // Parse response
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

  // Log
  const actionSummary = rawResult.actions
    .map((a) => `${a.type}(${a.index ?? ""})`)
    .join(", ");
  console.log("[agent] ACTIONS:", actionSummary || "none");
  console.log("[agent] SUBTASKS:", rawResult.subtasks.length);
  console.log("[agent] DONE:", rawResult.done ? "YES" : "no");

  // Apply guardrails
  const validated = validateAndEnforceRules(rawResult, recentActions, previousSubtasks);

  if (validated.guardrailsApplied.length > 0) {
    console.log("[agent] GUARDRAILS:", validated.guardrailsApplied.join(", "));
  }

  return validated;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPACT HISTORY BUILDER — converts full turn into summary
// ═══════════════════════════════════════════════════════════════════════════════

export function summarizeTurn(
  agentResult: AgentResult,
  actionResults: ActionResult[]
): string {
  // Create a compact summary of what happened (NO DOM)
  const parts: string[] = [];

  if (agentResult.thinking) {
    parts.push(`Think: ${agentResult.thinking.slice(0, 80)}`);
  }

  if (agentResult.actions.length > 0) {
    const actionDescs = agentResult.actions
      .map((a) => a.description)
      .join(", ");
    parts.push(`Actions: ${actionDescs}`);
  }

  if (actionResults.length > 0) {
    const results = actionResults
      .map((r) => `${r.success ? "OK" : "FAIL"}:${r.type}`)
      .join(", ");
    parts.push(`Results: ${results}`);
  }

  if (agentResult.message) {
    parts.push(`Said: "${agentResult.message.slice(0, 60)}"`);
  }

  return parts.join(" | ");
}
