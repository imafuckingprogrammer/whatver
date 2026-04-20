# Agent Architecture Refactor

## Status: Complete (Quick Wins Done)

---

## Phase 1: Nuke Guardrails (agent.ts) ✅

- [x] Deleted `isDangerousAction()` function
- [x] Deleted `validateResponse()` function entirely
- [x] Removed `recentActions` and `previousSubtasks` parameters
- [x] Keep only: max 5 actions per response (sanity cap via slice)
- [x] Simplified return type - no more `guardrailsApplied`

## Phase 2: Lean System Prompt (agent.ts) ✅

- [x] Rewrote SYSTEM_PROMPT from 85 lines to ~35 lines
- [x] Removed verbose format documentation
- [x] Reduced to 5 essential rules
- [x] Removed subtasks requirement

## Phase 3: Better DOM Context (widget.ts) ✅

- [x] Added `classifyPage()` - detects auth/checkout/cart/search/form
- [x] Added `getOffScreenHints()` with counts + categories
- [x] Populated `offScreen` field
- [x] Increased element limit from 60 to 80
- [x] Added `pageType` to page context

## Phase 4: Smarter Failure Handling (widget.ts) ✅

- [x] Enhanced error responses with actionable hints
- [x] On element not found: shows what IS available with labels
- [x] Select option not found: shows available options
- [x] Disabled/readonly detection with hints

## Phase 5: Fix Memory/History (chat.ts) ✅

- [x] Removed `recentActions` tracking
- [x] Removed `previousSubtasks` handling
- [x] Increased MAX_RECENT from 8 to 14
- [x] Compress assistant messages to summaries

## Phase 6: Simplify Loop Detection (widget.ts) ✅

- [x] Removed index-based duplicate blocking
- [x] Increased MAX_LOOPS from 20 to 30
- [x] Trust model to self-correct

---

## Quick Wins (Round 2) ✅

| Fix | Status | Impact |
|-----|--------|--------|
| Restore fetch/XHR tracking in waitForStable | ✅ Done | Waits for real stability, not arbitrary timeouts |
| Semantic loop detection | ✅ Done | Tracks `click:btn "Submit"` not `click:5` |
| Richer failure hints | ✅ Done | Shows available elements, options, reasons |
| Better off-screen summary | ✅ Done | `15 elements (3 btn, 5 input): Submit, Email...` |

---

## Files Changed

| File | Before | After | Change |
|------|--------|-------|--------|
| `agent.ts` | 392 lines | 145 lines | -63% |
| `widget.ts` | 1108 lines | ~550 lines | -50% |
| `chat.ts` | 394 lines | 250 lines | -37% |

---

## Token Impact Summary

| Change | Token Delta |
|--------|-------------|
| System prompt | -800 tokens |
| Compressed history | -200 per turn avg |
| Off-screen hints | +15 per turn |
| Failure hints | +30 when failures |
| **Net** | **~-950 tokens typical** |

---

## Bigger Wins (Future)

These require more effort but provide significant intelligence gains:

### 1. Verification Step (High Priority)
After `done:true`, verify task actually completed:
```typescript
if (agentResult.done) {
  const dom = await getLatestDOM();
  const verified = await verifyCompletion(dom, originalGoal);
  if (!verified.confident) {
    // Ask model to double-check
  }
}
```
- **Effort:** 1-2 hours
- **Tokens:** +200-400 (extra LLM call)
- **Impact:** Catches false "done" claims

### 2. Vision Fallback (Medium Priority)
For complex UIs (carousels, modals, canvas), DOM distillation fails:
- Detect sparse/confusing DOM
- Fall back to screenshot + vision model
- Use Set-of-Mark overlay for element selection
- **Effort:** 3-4 hours
- **Tokens:** +1000-2000 (image)
- **Impact:** Handles edge cases DOM can't capture

### 3. Planner/Actor Split (Lower Priority)
Separate high-level planning from action execution:
- Planner: Decomposes task into subtasks
- Actor: Executes individual subtasks
- Validator: Verifies each step
- **Effort:** 4-6 hours
- **Tokens:** +500-800 (multi-agent)
- **Impact:** Better decomposition, error recovery

---

## Architecture Now

```
User Message
    ↓
┌─────────────────────────────────────┐
│ Widget (widget.ts)                  │
│ • classifyPage() → page type        │
│ • distillDOM() → indexed elements   │
│ • getOffScreenHints() → below fold  │
│ • Semantic loop detection           │
│ • Fetch/XHR-aware waitForStable     │
└─────────────────────────────────────┘
    ↓ DOM + context
┌─────────────────────────────────────┐
│ Chat Route (chat.ts)                │
│ • Compressed history (14 msgs)      │
│ • Site memory (past successes)      │
│ • No guardrails, just orchestration │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ Agent (agent.ts)                    │
│ • Lean 35-line prompt               │
│ • GPT-4o, temp 0.2                  │
│ • 5 action max (sanity only)        │
│ • Trusted to self-correct           │
└─────────────────────────────────────┘
    ↓
Actions execute → Results fed back → Loop until done
```

---

## Testing Checklist

- [ ] TypeScript compiles ✅
- [ ] Widget loads on test page
- [ ] Simple task completes (click a button)
- [ ] Multi-step task completes (fill form, submit)
- [ ] Agent recovers from failed action
- [ ] Page type detected correctly
- [ ] Off-screen hints appear in logs
- [ ] Semantic loop detection triggers on real loops
- [ ] No false "stuck" on legitimate retries
