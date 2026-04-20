# Learnings from Current System

Things we built that are worth keeping or adapting for the rebuild.

---

## Priority 1: Keep These

### 1. Shadow DOM Widget Isolation
**File:** `widget.ts`
The widget uses a closed shadow DOM to prevent CSS conflicts with host pages. This is critical for a universal embed.

```javascript
var shadow = host.attachShadow({ mode: 'closed' });
```

Keep this pattern. The entire widget UI lives inside shadow DOM.

### 2. Element Index Map
**File:** `widget.ts`
Instead of passing selectors to the LLM, we assign numeric indices and maintain a map. This is cleaner than `plan.md` suggests.

```javascript
var elementMap = {};  // index → selector
elementMap[index] = buildSelector(el);
```

LLM says `click(3)`, we look up `elementMap[3]` and execute. This:
- Reduces tokens (index vs full selector)
- Decouples LLM from DOM details
- Handles stale references gracefully

**Adapt for rebuild:** Keep the index map. The LLM works with indices, not selectors.

### 3. Selector Building (Fallback Chain)
**File:** `widget.ts` → `buildSelector()`
We built a reliable selector generation order:
1. `#id` (best)
2. `[name="..."]` (forms)
3. `text="Exact Text"` (unique button/link text)
4. `[placeholder="..."]` (inputs)
5. `[data-ag-id="..."]` (fallback marker we inject)

This handles most real-world pages. Keep this logic.

### 4. Session-Scoped State
**File:** `widget.ts`
Visitor ID and conversation ID persist in `sessionStorage` per site:

```javascript
var VID_KEY = '_ag_vid_' + siteKey;
var CID_KEY = '_ag_cid_' + siteKey;
```

This lets conversations survive page navigation within a session. Essential for multi-page tasks.

### 5. Visual Feedback During Actions
**File:** `widget.ts`
- Page overlay dims during agent actions (shows user something is happening)
- Element highlight before click (purple outline)
- Action pills with spinner → checkmark

Users trust the agent more when they can see it working.

---

## Priority 2: Simplify These

### 6. MutationObserver Stability Detection
**File:** `widget.ts` → `waitForStable()`
We track DOM mutations + pending fetch/XHR to know when page is "settled."

**Current (over-engineered):**
- Intercepts `window.fetch` and `XMLHttpRequest`
- Tracks pending request counts
- Variable timeouts based on "expected navigation"

**For rebuild:** Simplify to just MutationObserver. The plan.md approach is right:
```javascript
function waitForChange(timeout = 2000) {
  return new Promise(resolve => {
    let timer;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => { observer.disconnect(); resolve(); }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve(); }, timeout);
  });
}
```

### 7. Action Execution
**File:** `widget.ts`
We have solid action executors:
- `clickElement(idx)` - handles scroll-into-view, focus, click
- `typeInElement(idx, text)` - handles React's value setter hack
- `selectOption(el, value)` - fuzzy match on option text
- `hoverElement(idx)` - for dropdowns
- `scrollPage(direction)` / `scrollToElement(idx)`

**For rebuild:** Keep these but expose as the three tools from plan.md:
- `findElement()` → use our selector/index system
- `doAction(type, target, value)` → dispatch to our executors
- `waitForChange()` → simplified MutationObserver

### 8. React Input Handling
**File:** `widget.ts` → `typeInElement()`
React hijacks input value setters. We work around it:

```javascript
var descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
if (descriptor && descriptor.set) {
  descriptor.set.call(el, text);
}
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
```

This is essential for React/Vue/Angular sites. Keep it.

---

## Priority 3: Discard These

### Guardrails System
**File:** `agent.ts` → `validateResponse()`, `isDangerousAction()`
- Single click enforcement
- Dangerous action isolation
- Duplicate blocking
- Subtask preservation

**Why discard:** The LLM should decide this, not hardcoded rules. If we need safety, ask the LLM to emit a `confirm` action type. Guardrails made the system unpredictable.

### Subtask Tracking
**File:** `agent.ts`, `chat.ts`
We had the LLM maintain subtasks with status (done/active/pending). It forgot them constantly, we patched them back in, created race conditions.

**Why discard:** The plan.md loop doesn't need this. Each turn is: here's the DOM, here's the goal, what's the next single action? Stateless is better.

### Site Memory / Recipes
**File:** `chat.ts`
We stored successful task completions with action sequences ("recipes") and fed them to future requests.

**Why discard:** Recipes are brittle (DOM changes, indices change). If we want memory later, store high-level patterns, not action sequences.

### Complex History Compression
**File:** `chat.ts`
We kept first user message, compressed middle, kept last N messages, injected "omitted" markers.

**Why discard:** With 500-800 token DOM snapshots, we don't need complex compression. Just keep recent history and enforce max turns.

### Off-Screen Hints
**File:** `widget.ts` → `getOffScreenHints()`
We told the LLM what was below the fold: "15 elements (3 btn, 5 input): Submit, Email..."

**Why discard:** Plan.md says viewport only. If the LLM needs something off-screen, it scrolls. Simpler.

### Page Type Classification
**File:** `widget.ts` → `classifyPage()`
We detected auth/checkout/cart/search/form pages and told the LLM.

**Why discard:** Didn't help much. The DOM elements themselves tell the story.

---

## Key Insights

### What Caused Our Bugs

1. **Context explosion** — We sent too much: full DOM, off-screen hints, page type, subtasks, memory. The LLM lost focus.

2. **Guardrails fighting the model** — We'd block actions, force done states, preserve subtasks the model forgot. This created unpredictable behavior.

3. **No clear completion signal** — `done: true` was a field in a big JSON blob. Model would say done prematurely or never.

4. **Observation lag** — We'd execute multiple actions then observe. By then the DOM had changed multiple times.

### What Plan.md Gets Right

1. **Tiny context** — 500-800 tokens DOM. That's it.

2. **Single action per turn** — No batching, no "execute these 5 things." One action, observe, decide.

3. **Explicit completion** — `action: "complete"` is a first-class action type, not a flag.

4. **Hard turn limit** — 10-15 turns max. No infinite loops.

5. **Separation of concerns** — Browser does DOM parsing/execution. LLM does planning. Never mix.

---

## Rebuild Checklist

When building the new system, verify:

- [ ] DOM extraction is under 800 tokens
- [ ] LLM returns ONE action per call
- [ ] `complete` action stops the loop
- [ ] Max 12 turns enforced
- [ ] No guardrails - trust the model
- [ ] Shadow DOM isolation
- [ ] Session state persists across pages
- [ ] React input hack included
- [ ] User sees visual feedback (overlay, highlights)

---

## Token Budget Comparison

| Component | Current | Plan.md Target |
|-----------|---------|----------------|
| System prompt | ~1200 tokens | ~400 tokens |
| DOM snapshot | ~800-2000 tokens | 500-800 tokens |
| History (10 turns) | ~3000 tokens | ~1500 tokens |
| **Per-turn total** | ~5000+ tokens | ~2500 tokens |

That's a 50%+ reduction, which directly improves both cost and accuracy.
