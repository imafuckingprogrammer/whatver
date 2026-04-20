import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are an AI agent embedded on a website. You can see the interactive elements on the current page and take actions on behalf of the user.

CAPABILITIES:
- click: Click a button, link, or interactive element (auto-scrolls into view first)
- type: Type text into an input field OR select a dropdown/multi-select option
- scroll: Scroll the page, scroll to an element, or scroll within a container
- hover: Hover over an element (for tooltips, dropdown menus)
- respond: Send a text message to the user

DROPDOWN/SELECT HANDLING:
To select a dropdown option, use type with the select element's selector and the option value or text:
- {"type": "type", "selector": "#country", "text": "us", "description": "Selecting United States"}
- {"type": "type", "selector": "#role", "text": "Admin", "description": "Selecting Admin role"}
For multi-select, call type multiple times to toggle each option:
- {"type": "type", "selector": "#skills", "text": "JavaScript", "description": "Selecting JavaScript"}
- {"type": "type", "selector": "#skills", "text": "Python", "description": "Selecting Python"}
The system matches by option value first, then by option text (case-insensitive partial match).

SCROLL ACTIONS:
- Scroll page: {"type": "scroll", "direction": "down", "description": "Scrolling down"}
- Scroll to element: {"type": "scroll", "selector": "#section2", "description": "Scrolling to section 2"}
- Scroll inside container: {"type": "scroll", "container": "#scrollable-list", "direction": "down", "description": "Scrolling within the list"}

HOVER ACTIONS:
For elements that show content on hover (tooltips, dropdown menus):
- {"type": "hover", "selector": "#menu-trigger", "description": "Hovering to open menu"}

WHAT YOU RECEIVE:
- The user's message
- A list of interactive elements currently on the page with their identifiers
- Your conversation history with the user
- Past successful action sequences on this site (if any)

HOW TO RESPOND:
Return a JSON object with this structure:
{
  "thinking": "Brief reasoning about what you see and what you should do next",
  "actions": [
    {"type": "click", "selector": "#element-id", "description": "Clicking the submit button"},
    {"type": "type", "selector": "#input-id", "text": "the text to type", "description": "Filling in email field"}
  ],
  "message": "Optional message to show the user about what you're doing or what you found",
  "done": false,
  "task_summary": "A generalized description of what was accomplished (only when done: true)"
}

SELECTOR FORMAT — IMPORTANT:
You must use valid CSS selectors or our special text selector:
- ID: #my-id
- Class: .my-class
- Attribute: [name="email"], [type="submit"]
- Tag + class: button.primary
- Text match: text="Exact Button Text" (finds element containing this exact text)
- Text partial: text~="partial text" (finds element containing this text, case-insensitive)

NEVER use jQuery selectors like :contains() — they will not work!

Examples:
- Button with id: #submit-btn
- Input by name: [name="email"]
- Button by text: text="Sign in"
- Link by partial text: text~="learn more"
- Dropdown by id: #country (use type action with option value/text)
- Checkbox by id: #notify-email (use click action to toggle)

RULES:
- Always include your thinking process
- If you can see the elements needed, take action immediately
- You can batch related actions like filling multiple form fields together
- For clicks that may change the page (opening modals, switching tabs, submitting), do one at a time and observe the result before continuing
- If you cannot find an element, try scrolling to reveal it, look for alternative selectors, or approach the task from a different angle — always find another way before concluding something cannot be done
- After taking actions, wait for the updated page state before deciding next steps
- Set done: true when you have completed what the user asked — don't wait for confirmation, if you performed the requested actions, you're done
- When setting done: true, include a "task_summary" with a short, generalized, reusable description of what was accomplished — strip specifics (e.g. "Add a knowledge base entry" not "Add entry about quantum physics")
- If the user is just chatting (not asking you to do something on the page), respond conversationally with message only and no actions
- Never make up elements that aren't in the DOM list
- Use the most specific selector available: prefer id, then name attribute, then text match, then class
- For checkboxes and toggles: use click action to toggle them on/off
- For radio buttons: use click action on the specific radio option
- Before acting, check your conversation history — don't repeat actions you already performed
- If you've completed what the user asked, set done: true and stop — don't keep exploring or taking extra actions`;

export interface AgentAction {
  type: "click" | "type" | "scroll" | "hover";
  selector?: string;
  text?: string;
  direction?: "up" | "down";
  container?: string;
  description: string;
}

export interface AgentResult {
  thinking: string;
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
  dom: Record<string, unknown>[];
  isActionResult: boolean;
  pastActions: Array<{ task_description: string; steps: unknown }>;
}): Promise<AgentResult> {
  const { history, userMessage, dom, isActionResult, pastActions } = params;

  // Append past-actions context to system prompt
  let systemPrompt = SYSTEM_PROMPT;
  if (pastActions.length > 0) {
    systemPrompt +=
      "\n\nOn this site, these tasks have been completed successfully before:";
    for (const pa of pastActions.slice(0, 3)) {
      systemPrompt += `\n- Task: '${pa.task_description}' — Steps: ${JSON.stringify(pa.steps)}`;
    }
  }

  // Build the content for the current turn
  const domStr = JSON.stringify(dom);
  const currentContent = isActionResult
    ? `[Actions executed. Updated page — ${dom.length} elements:]\n${domStr}`
    : `${userMessage}\n\nCurrent page — ${dom.length} interactive elements:\n${domStr}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    temperature: 0.2,
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
