# Build Tracker

## Status: REBUILD v2 COMPLETE

## Goal
Rebuild agent system from scratch based on plan.md architecture.
Three files: agent.ts, chat.ts, widget.ts.

## Final Line Counts (v2 Rebuild)
| File | Old | New |
|------|-----|-----|
| agent.ts | 392 | 87 |
| chat.ts | 394 | 274 |
| widget.ts | 1108 | 520 |
| **Total** | 1894 | **881** |

53% reduction. Clean API contract between widget and server.

## Architecture

```
User: "delete site10"
    ↓
Widget extracts DOM → "url:...\n[1]btn\"Submit\"\n[2]a\"Settings\"..."
    ↓
POST /api/chat {
  siteKey, visitorId, conversationId,
  message: "delete site10",
  dom: "...",
  turnType: "new"
}
    ↓
chat.ts stores message → calls agent.ts
    ↓
agent.ts: GPT-4o returns { type: "click", index: 3 }
    ↓
chat.ts stores action → returns to widget
    ↓
Widget executes click, waits for settle
    ↓
POST /api/chat {
  turnType: "observation",
  observation: "clicked \"Delete\"",
  dom: "..."
}
    ↓
Loop until { type: "complete", result: "Done!" } or turn 15
```

## Files to Create

### 1. agent.ts (~50 lines)
- [ ] Simple system prompt (~400 tokens max)
- [ ] Single function: runAgent(history, dom) → action
- [ ] NO guardrails, NO subtasks
- [ ] Returns: { action, index?, text?, result?, message? }

### 2. chat.ts (~100 lines)
- [ ] POST / - main endpoint
- [ ] GET /history - for widget reload
- [ ] Store messages in Supabase
- [ ] Call agent, return action

### 3. widget.ts (~200 lines)
- [ ] extractDOM() - viewport only, indexed elements
- [ ] doAction(action) - click/type/scroll/hover
- [ ] waitForChange() - MutationObserver
- [ ] Main loop with max 12 turns
- [ ] Shadow DOM UI
- [ ] Session state persistence

## System Prompt Design

```
You are a browser automation agent. You see a DOM snapshot and execute ONE action per turn.

ELEMENTS: [index]type"label"=value
- [1]btn"Submit" - button
- [2]input"Email"=test@... - input with value
- [3]a"Settings" - link

ACTIONS (return ONE as JSON):
{action:"click", index:N}
{action:"type", index:N, text:"..."}
{action:"scroll", direction:"down"}
{action:"complete", result:"Done! Subscription canceled."}

RULES:
1. One action per turn
2. Use "complete" when task is done or impossible
3. Click navigates - indices will change, observe before next action
```

~250 tokens. Clean.

## Key Decisions

1. **Keep element indices** - cleaner than semantic fuzzy matching
2. **No subtasks** - stateless per turn
3. **No guardrails** - trust the model
4. **Max 12 turns** - hard stop
5. **Viewport only** - scroll to find more
6. **"complete" action** - explicit termination

## Progress

- [x] agent.ts — 78 lines, ~300 token system prompt
- [x] chat.ts — 215 lines, minimal history (last 6 msgs)
- [x] widget.ts — 390 lines (incl CSS), clean loop
- [x] TypeScript compiles
- [ ] Test basic flow
- [ ] Verify token counts in practice

## Notes

- Current widget.ts is 1100 lines. New one should be ~200.
- Current agent.ts is 392 lines. New one should be ~50.
- Current chat.ts is 394 lines. New one should be ~100.
- Total reduction: 1886 → 350 lines (81% less code)

## Questions to Resolve During Build

1. Do we need conversation history or just current goal + DOM?
   → Keep minimal history (last 6 messages) for multi-step context

2. How much DOM detail?
   → Buttons, inputs, links, selects, headings. Text content truncated.

3. Error handling in actions?
   → Return observation: "element not found" etc.

---

## What's Included Now

- [x] Shadow DOM isolation
- [x] Element index map (clean lookup)
- [x] React input hack (value setter)
- [x] Session storage (visitorId, conversationId)
- [x] MutationObserver wait
- [x] Max turns limit (12)
- [x] Simple typing indicator

## From mine.md — Maybe Add Later

- [ ] Element highlight before click
- [ ] Page overlay during actions
- [ ] Action pills with spinner → checkmark
- [ ] Selector building (id/name/text fallbacks) — current version stores element refs directly
- [ ] History reload on page navigation
- [ ] Stop button

## Potential Issues to Watch

1. **Element refs vs selectors** — We store element refs directly in elementMap. After navigation, these become stale. Current approach relies on extractDOM() being called each turn, which resets the map. Should work but watch for edge cases.

2. **No visible text extraction** — We only capture interactive elements + headings. If the agent needs to read page content (e.g., "what's my balance?"), it won't see the number. May need to add key text.

3. **No scroll containers** — We only handle page scroll, not scrollable divs. Most sites are fine but some dashboards use internal scroll.
