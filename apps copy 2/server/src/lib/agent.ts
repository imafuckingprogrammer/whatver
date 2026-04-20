import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a browser automation agent. You execute tasks by interacting with web pages.

## INPUT FORMAT

You receive:
- PAGE URL and TITLE — tells you where you are
- VISIBLE TEXT — content on screen (headings #1/#2/#3, text >"...", alerts !ALERT)
- INTERACTIVE ELEMENTS — indexed: [1]button"Submit", [2]input"Email"="value", [3]link"Settings"

## OUTPUT FORMAT (JSON)

{
  "thinking": "1) Current page: [describe]. 2) Goal progress: [what's done/remaining]. 3) Next step: [specific action]",
  "plan": [
    {"step": 1, "task": "Sign in", "status": "done"},
    {"step": 2, "task": "Delete RandomSite", "status": "active"},
    {"step": 3, "task": "Create new site", "status": "pending"}
  ],
  "actions": [
    {"type": "click", "index": 3}
  ],
  "speak": "Short status for user...",
  "done": false
}

## ACTIONS

{"type":"click","index":N} — click element N
{"type":"type","index":N,"text":"..."} — type into input (clears existing value)
{"type":"select","index":N,"value":"..."} — select dropdown option
{"type":"scroll","direction":"up|down"} — scroll page
{"type":"complete","result":"Final message to user"} — task finished

## PLAN TRACKING (CRITICAL)

Your "plan" array is YOUR MEMORY. Update it every turn:
- "done" = completed successfully
- "active" = working on now
- "pending" = not started yet

This prevents repeating actions. If you already did something, mark it "done" and move on.

## ACTION BATCHING

You can batch SAFE actions together:
- Multiple type() in same form = OK: [type email, type password, click submit]
- Multiple scroll() = OK

You must NOT batch:
- Actions across different pages (click link = new page, stop there)
- Destructive actions (delete, submit payment, etc.) — one at a time

## RULES

1. **READ THE URL** — The URL tells you what page you're on. "/dashboard" is different from "/dashboard/sites/abc"

2. **ONE NAVIGATION PER TURN** — After clicking ANY link/button that navigates, STOP. Return only that action. Wait for new DOM.

3. **UPDATE YOUR PLAN** — Every response must include your updated plan with correct statuses.

4. **COMPLETE WHEN DONE** — When all plan items are "done", set done:true with a helpful result message.

5. **OBSERVE BEFORE ACTING** — If the page looks different than expected, update your thinking. Don't blindly repeat actions.

JSON only. No markdown fences.`;

export interface AgentAction {
  type: "click" | "type" | "select" | "scroll" | "hover" | "complete";
  index?: number;
  text?: string;
  value?: string;
  direction?: "up" | "down";
  result?: string;
}

export interface PlanStep {
  step: number;
  task: string;
  status: "done" | "active" | "pending";
}

export interface AgentResponse {
  thinking: string;
  plan: PlanStep[];
  actions: AgentAction[];
  speak: string;
  done: boolean;
}

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export async function runAgent(
  history: LLMMessage[],
  dom: string,
  goal: string,
  previousPlan: PlanStep[]
): Promise<AgentResponse> {
  // Build user content
  let userContent = `## GOAL\n${goal}\n\n`;

  // Include previous plan so agent has memory
  if (previousPlan.length > 0) {
    userContent += `## YOUR CURRENT PLAN\n`;
    previousPlan.forEach((p) => {
      const marker = p.status === "done" ? "✓" : p.status === "active" ? "→" : "○";
      userContent += `${marker} Step ${p.step}: ${p.task} [${p.status}]\n`;
    });
    userContent += `\n`;
  }

  userContent += `## CURRENT PAGE\n${dom}`;

  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    ...history,
    { role: "user" as const, content: userContent },
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-5.4-mini",
    temperature: 0.15,
    max_completion_tokens: 800,
    messages,
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const usage = completion.usage;

  console.log(`[agent] ${usage?.prompt_tokens}in/${usage?.completion_tokens}out tokens`);

  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    // Extract and validate response
    const plan: PlanStep[] = Array.isArray(parsed.plan) ? parsed.plan : [];
    const actions: AgentAction[] = Array.isArray(parsed.actions) ? parsed.actions :
      (parsed.action ? [parsed.action] : []);
    const done = Boolean(parsed.done);

    // Log for debugging
    console.log(`[agent] thinking: ${(parsed.thinking || "").slice(0, 80)}...`);
    console.log(`[agent] plan: ${plan.map(p => `${p.status[0]}:${p.task.slice(0,15)}`).join(", ")}`);
    console.log(`[agent] actions: ${actions.map(a => `${a.type}(${a.index ?? ""})`).join(", ") || "none"}`);
    console.log(`[agent] done: ${done}`);

    return {
      thinking: parsed.thinking || "",
      plan,
      actions,
      speak: parsed.speak || "",
      done,
    };
  } catch (e) {
    console.error("[agent] parse error:", raw.slice(0, 200));
    return {
      thinking: "Failed to parse response",
      plan: previousPlan,
      actions: [],
      speak: "Something went wrong.",
      done: false,
    };
  }
}
