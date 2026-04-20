import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Minimal, token-efficient prompt
const SYSTEM = `You are a browser automation agent. You see a page and take ONE action.

ACTIONS (respond with JSON):
{"a":"click","s":"#btn"} - click element
{"a":"fill","s":"#input","v":"text"} - fill input
{"a":"done","m":"message"} - task complete

SELECTORS: #id, [name=x], text="Button Text"

RULES:
- One action at a time
- After each action you see the new page
- When task is complete, use done with a message
- If element not found, try different selector
- Be efficient, don't repeat failed actions

Respond with ONLY the JSON action, nothing else.`;

export interface AgentRequest {
  goal: string;
  page: string;
  history: string[];
}

export interface AgentAction {
  a: "click" | "fill" | "done";
  s?: string;
  v?: string;
  m?: string;
}

export async function getNextAction(req: AgentRequest): Promise<AgentAction> {
  // Build compact context
  let userMsg = `GOAL: ${req.goal}\n\n`;

  if (req.history.length > 0) {
    userMsg += `DONE:\n${req.history.map(h => '- ' + h).join('\n')}\n\n`;
  }

  userMsg += `PAGE:\n${req.page}`;

  console.log("[agent] Context:", userMsg.slice(0, 300) + (userMsg.length > 300 ? "..." : ""));

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    max_tokens: 100,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: userMsg }
    ]
  });

  const raw = completion.choices[0]?.message?.content?.trim() || "{}";
  console.log("[agent] Response:", raw);

  // Parse JSON from response (handle markdown code blocks)
  let json = raw;
  const codeMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeMatch) json = codeMatch[1].trim();

  // Also try to extract JSON object directly
  const jsonMatch = json.match(/\{[\s\S]*\}/);
  if (jsonMatch) json = jsonMatch[0];

  try {
    return JSON.parse(json) as AgentAction;
  } catch {
    console.error("[agent] Failed to parse:", raw);
    return { a: "done", m: "I encountered an error. Please try again." };
  }
}
