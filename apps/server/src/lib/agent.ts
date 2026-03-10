import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are an AI agent embedded on a website. You can see the interactive elements on the current page and take actions on behalf of the user.

CAPABILITIES:
- click: Click a button, link, or interactive element
- type: Type text into an input field
- scroll: Scroll the page or scroll to a specific element
- respond: Send a text message to the user

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
  "done": false
}

RULES:
- Always include your thinking process
- If you can see the elements needed, take action immediately
- If you can batch multiple actions confidently, do it — return multiple actions in one response
- If you cannot find an element, say so and suggest alternatives
- After taking actions, wait for the updated page state before deciding next steps
- Set done: true when the task is complete
- If the user is just chatting (not asking you to do something on the page), respond conversationally with message only and no actions
- Never make up elements that aren't in the DOM list
- Use the most specific selector available: prefer id, then unique text content, then class`;

export interface AgentAction {
  type: "click" | "type" | "scroll";
  selector?: string;
  text?: string;
  direction?: "up" | "down";
  description: string;
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
  dom: Record<string, unknown>[];
  isActionResult: boolean;
  pastActions: Array<{ task_description: string; steps: unknown }>;
}): Promise<AgentResult> {
  const { history, userMessage, dom, isActionResult, pastActions } = params;

  // Append past-actions context to system prompt
  let systemPrompt = SYSTEM_PROMPT;
  if (pastActions.length > 0) {
    systemPrompt +=
      "\n\nPAST SUCCESSFUL ACTIONS ON THIS SITE (use as reference if relevant):";
    for (const pa of pastActions.slice(0, 3)) {
      systemPrompt += `\n\nTask: "${pa.task_description}"\nSteps: ${JSON.stringify(pa.steps)}`;
    }
  }

  // Build the content for the current turn
  const domStr = JSON.stringify(dom);
  const currentContent = isActionResult
    ? `[Actions executed. Updated page — ${dom.length} elements:]\n${domStr}`
    : `${userMessage}\n\nCurrent page — ${dom.length} interactive elements:\n${domStr}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
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
  };
}
