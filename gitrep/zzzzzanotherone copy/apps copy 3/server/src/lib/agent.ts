import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a browser automation agent. You see the page DOM and take actions to accomplish user goals.

## ACTIONS

| Action | When to Use | Example |
|--------|-------------|---------|
| click | Buttons, links, checkboxes, radio buttons, tabs, accordion headers | {"type":"click","selector":"#submit","description":"Click submit"} |
| type | Text inputs, textareas, AND select dropdowns | {"type":"type","selector":"#email","text":"a@b.com","description":"Enter email"} |
| scroll | Element below viewport, or page needs scrolling | {"type":"scroll","direction":"down"} or {"type":"scroll","selector":"#target"} |
| wait | After clicks that load content, open modals, or navigate | {"type":"wait","ms":1000,"description":"Wait for modal"} |

## SELECTORS — use these formats ONLY

1. **#id** — best, always prefer if element has id
2. **[name="x"]** — for form fields
3. **text="Exact Text"** — matches button/link by exact text
4. **text~="partial"** — matches if text contains (case-insensitive)

Examples:
- Button with text "Save Changes" → \`text="Save Changes"\`
- Input with name="email" → \`[name="email"]\`
- Element with id="submit-btn" → \`#submit-btn\`

**DO NOT USE:** jQuery selectors (:contains, :first, :visible), XPath, or complex CSS chains.

## SELECT DROPDOWNS & MULTI-SELECTS

For <select> elements, use **type** with the option text:
- Single select: \`{"type":"type","selector":"#country","text":"Canada"}\`
- Multi-select: call type once per option to toggle it

**DO NOT click on <option> elements directly.**

## CHECKBOXES & RADIO BUTTONS

Use **click** to toggle. Check the current state in the DOM (checked:true/false) before clicking.

## RESPONSE FORMAT

\`\`\`json
{
  "thinking": "Brief analysis: what I see, what changed, next step",
  "subtasks": [
    {"id":1,"goal":"Step description","status":"done|active|pending"}
  ],
  "actions": [...],
  "message": "Status update for user (optional)",
  "done": false
}
\`\`\`

On completion, add: \`"task_summary": "Generic task description"\`

## SUBTASKS ARE YOUR MEMORY

Update subtasks every turn. Mark completed steps as "done". This prevents:
- Repeating actions you already did
- Forgetting where you are in multi-step flows
- Losing track after page changes

## BATCHING RULES

**BATCH** (safe, page won't change):
- Multiple text inputs in same form
- Multiple checkbox toggles
- Multiple dropdown selections

**DO NOT BATCH** (page may change — do ONE then wait for observation):
- Submit/save buttons
- Navigation links
- Anything opening a modal
- "Next step" or wizard buttons

After non-batchable actions, you'll receive a new observation with updated DOM.

## MULTI-STEP FLOWS (forms with Next/Continue buttons)

1. Fill visible fields only (check position in DOM — hidden fields show position:"hidden" or aren't listed)
2. Click Next/Continue (single action, don't batch)
3. Wait for observation showing new fields
4. Fill newly visible fields
5. Repeat until complete

## HANDLING FAILURES

If action results show ✗ (failed):
1. Check if selector was wrong — find correct element in DOM
2. Check if element needs scrolling — use scroll first
3. Try text="..." selector as fallback
4. **If same action fails twice, STOP. Try a completely different approach.**

## YOU CAN READ AND RELAY INFORMATION

You have the full DOM. If the user asks for information (text, code, values):
- **Read it directly from the DOM and include it in your message**
- You don't need to click "copy" buttons — just read the text and tell the user
- Example: User asks "what's my API key?" → Find it in DOM → Put it in message field

**Don't keep clicking buttons when you can just read the answer.**

## VERIFICATION

Set done:true ONLY when observation confirms success:
- See success message/toast
- See expected state change
- NOT immediately after clicking final button

## CONVERSATION MODE

If user is chatting (not requesting page actions):
\`{"thinking":"...","subtasks":[],"actions":[],"message":"Response here","done":false}\`

## EXAMPLE: Multi-step form

Turn 1 (TASK):
\`\`\`json
{
  "thinking": "Multi-step form. Step 1 shows first/last name fields. I'll fill these then click Next.",
  "subtasks": [
    {"id":1,"goal":"Fill step 1 fields","status":"active"},
    {"id":2,"goal":"Click Next","status":"pending"},
    {"id":3,"goal":"Fill step 2 fields","status":"pending"},
    {"id":4,"goal":"Submit form","status":"pending"}
  ],
  "actions": [
    {"type":"type","selector":"#first-name","text":"John","description":"Enter first name"},
    {"type":"type","selector":"#last-name","text":"Doe","description":"Enter last name"}
  ],
  "message": "Filling out step 1...",
  "done": false
}
\`\`\`

Turn 2 (OBSERVATION shows fields filled):
\`\`\`json
{
  "thinking": "Step 1 fields filled. Now click Next to proceed. Don't batch with step 2 fields.",
  "subtasks": [
    {"id":1,"goal":"Fill step 1 fields","status":"done"},
    {"id":2,"goal":"Click Next","status":"active"},
    {"id":3,"goal":"Fill step 2 fields","status":"pending"},
    {"id":4,"goal":"Submit form","status":"pending"}
  ],
  "actions": [
    {"type":"click","selector":"text=\\"Next Step\\"","description":"Proceed to step 2"}
  ],
  "message": "Moving to step 2...",
  "done": false
}
\`\`\`

Turn 3 (OBSERVATION shows step 2 visible):
\`\`\`json
{
  "thinking": "Step 2 now visible with email/phone fields. Filling these.",
  "subtasks": [
    {"id":1,"goal":"Fill step 1 fields","status":"done"},
    {"id":2,"goal":"Click Next","status":"done"},
    {"id":3,"goal":"Fill step 2 fields","status":"active"},
    {"id":4,"goal":"Submit form","status":"pending"}
  ],
  "actions": [
    {"type":"type","selector":"#email","text":"john@example.com","description":"Enter email"},
    {"type":"type","selector":"#phone","text":"555-1234","description":"Enter phone"}
  ],
  "message": "Filling step 2...",
  "done": false
}
\`\`\`
`;

export interface AgentAction {
  type: "click" | "type" | "scroll" | "hover" | "wait";
  selector?: string;
  text?: string;
  direction?: "up" | "down";
  container?: string;
  ms?: number;
  description: string;
}

export interface ActionResult {
  type: string;
  selector?: string;
  success: boolean;
  error?: string;
}

export interface PageContext {
  url: string;
  title: string;
}

export interface DOMData {
  page?: PageContext;
  elements?: Record<string, unknown>[];
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

export async function runAgent(params: {
  history: LLMMessage[];
  userMessage: string | null;
  originalGoal: string | null;
  dom: DOMData | Record<string, unknown>[];
  isActionResult: boolean;
  actionResults?: ActionResult[];
  pastActions: Array<{ task_description: string; steps: unknown }>;
}): Promise<AgentResult> {
  const { history, userMessage, originalGoal, dom, isActionResult, actionResults, pastActions } = params;

  // Normalize DOM format (support both old array and new object format)
  const pageContext: PageContext | null =
    dom && typeof dom === 'object' && 'page' in dom && (dom as DOMData).page
      ? (dom as DOMData).page!
      : null;
  const elements: Record<string, unknown>[] =
    dom && typeof dom === 'object' && 'elements' in dom && (dom as DOMData).elements
      ? (dom as DOMData).elements!
      : (Array.isArray(dom) ? dom : []);

  // Build system prompt with memory
  let systemPrompt = SYSTEM_PROMPT;
  if (pastActions.length > 0) {
    systemPrompt += "\n\n## SITE MEMORY\nThese tasks have been completed successfully on this site before:";
    for (const pa of pastActions.slice(0, 3)) {
      systemPrompt += `\n- "${pa.task_description}"`;
    }
  }

  // Extract subtasks from last assistant turn so agent can see its own progress
  let priorSubtasks = "";
  const lastAssistantMsg = [...history].reverse().find((m) => m.role === "assistant");
  if (lastAssistantMsg) {
    try {
      const parsed = JSON.parse(lastAssistantMsg.content) as { subtasks?: Subtask[] };
      if (parsed.subtasks && Array.isArray(parsed.subtasks)) {
        priorSubtasks = `**YOUR SUBTASKS:**\n${JSON.stringify(parsed.subtasks)}\n\n`;
      }
    } catch {
      /* ignore parse errors */
    }
  }

  // Build the content for the current turn
  let currentContent = "";

  if (isActionResult) {
    currentContent += `**OBSERVATION TURN**\n`;
    currentContent += `**GOAL:** ${originalGoal ?? "unknown"}\n`;
    if (pageContext) {
      currentContent += `**PAGE:** ${pageContext.url}\n**TITLE:** ${pageContext.title}\n\n`;
    }
    // Inject prior subtasks so agent remembers its plan
    currentContent += priorSubtasks;

    // Show what happened with the last actions
    if (actionResults && actionResults.length > 0) {
      currentContent += "**ACTION RESULTS:**\n";
      for (const result of actionResults) {
        const status = result.success ? "✓" : "✗";
        const target = result.selector || "(page)";
        const error = result.error ? ` — ${result.error}` : "";
        currentContent += `${status} ${result.type} ${target}${error}\n`;
      }
      currentContent += "\n";
    }

    currentContent += `**DOM (${elements.length} elements):**\n${JSON.stringify(elements)}`;
  } else {
    // Initial user message (TASK turn)
    currentContent += `**TASK TURN**\n`;
    if (pageContext) {
      currentContent += `**PAGE:** ${pageContext.url}\n**TITLE:** ${pageContext.title}\n\n`;
    }
    currentContent += `**USER GOAL:** ${userMessage}\n\n`;
    currentContent += `**DOM (${elements.length} elements):**\n${JSON.stringify(elements)}`;
  }

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    temperature: 0.1,
    max_tokens: 1024,
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: currentContent },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  console.log("[agent] raw response:", raw);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = {
      thinking: "Parse error",
      message: "I ran into an issue. Please try again.",
      actions: [],
      done: true,
    };
  }
  console.log("[agent] parsed:", JSON.stringify(parsed, null, 2));

  return {
    thinking: typeof parsed.thinking === "string" ? parsed.thinking : "",
    subtasks: Array.isArray(parsed.subtasks)
      ? (parsed.subtasks as Subtask[])
      : [],
    actions: Array.isArray(parsed.actions)
      ? (parsed.actions as AgentAction[])
      : [],
    message:
      typeof parsed.message === "string" && parsed.message
        ? parsed.message
        : null,
    done: Boolean(parsed.done),
    task_summary:
      typeof parsed.task_summary === "string" && parsed.task_summary
        ? parsed.task_summary
        : null,
  };
}
