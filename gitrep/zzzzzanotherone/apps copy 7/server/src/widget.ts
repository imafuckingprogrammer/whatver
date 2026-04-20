/**
 * Returns the self-contained widget JavaScript served as /embed/:siteKey.js.
 * The script derives siteKey and server origin from its own <script src> URL.
 * Isolation: closed Shadow DOM — zero CSS bleed in either direction.
 */
export function getWidgetScript(): string {
  return `(function () {
  'use strict';

  // ── locate self ──────────────────────────────────────────────────────────
  var scriptEl = document.currentScript;
  if (!scriptEl) {
    var all = document.querySelectorAll('script[src]');
    for (var i = 0; i < all.length; i++) {
      if (/\\/embed\\/.+\\.js/.test(all[i].src)) { scriptEl = all[i]; break; }
    }
  }
  if (!scriptEl) return;

  var serverOrigin = scriptEl.src.replace(/\\/embed\\/.+$/, '');
  var siteKey = (scriptEl.src.match(/\\/embed\\/(.+?)\\.js/) || [])[1];
  if (!siteKey) return;

  // ── visitor id (session-scoped) ──────────────────────────────────────────
  var VID_KEY = '_ag_vid_' + siteKey;
  var visitorId = sessionStorage.getItem(VID_KEY);
  if (!visitorId) {
    visitorId = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    sessionStorage.setItem(VID_KEY, visitorId);
  }

  // ── conversation id (persists across page loads in same session) ─────────
  var CID_KEY = '_ag_cid_' + siteKey;
  var conversationId = sessionStorage.getItem(CID_KEY);

  // ── state ────────────────────────────────────────────────────────────────
  var isOpen    = false;
  var isLoading = false;
  var msgCount  = 0;
  var loopCount = 0;
  var MAX_LOOPS = 20;
  var lastUrl   = window.location.href;
  var executedActions = []; // Track recent actions for duplicate detection

  // ── shadow host ──────────────────────────────────────────────────────────
  var host = document.createElement('div');
  host.style.cssText = [
    'position:fixed',
    'bottom:24px',
    'right:24px',
    'z-index:2147483647',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
  ].join(';');
  document.body.appendChild(host);

  var shadow = host.attachShadow({ mode: 'closed' });

  // ── page overlay (on document.body — covers the page while agent acts) ───
  var agOverlay = document.createElement('div');
  agOverlay.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'width:100%', 'height:100%',
    'background:rgba(0,0,0,0.18)', 'z-index:2147483640', 'pointer-events:none',
    'opacity:0', 'transition:opacity .2s',
  ].join(';');
  document.body.appendChild(agOverlay);

  function showOverlay() { agOverlay.style.opacity = '1'; }
  function hideOverlay() { agOverlay.style.opacity = '0'; }

  // ═══════════════════════════════════════════════════════════════════════════
  // WAIT FOR STABLE — smart DOM stability detection
  // ═══════════════════════════════════════════════════════════════════════════
  function waitForStable(minStable, maxWait, expectNavigation) {
    minStable = minStable || 350;
    maxWait = maxWait || 4000;

    // If we expect navigation (after clicking links/buttons), wait longer initially
    // and also watch for URL changes
    var initialUrl = window.location.href;
    if (expectNavigation) {
      minStable = Math.max(minStable, 500);
      maxWait = Math.max(maxWait, 5000);
    }

    return new Promise(function(resolve) {
      var start = Date.now();
      var lastChange = Date.now();
      var urlChanged = false;

      // Track DOM mutations
      var observer = new MutationObserver(function() {
        lastChange = Date.now();
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });

      // Track network activity (fetch)
      var pendingFetches = 0;
      var origFetch = window.fetch;
      window.fetch = function() {
        pendingFetches++;
        lastChange = Date.now();
        return origFetch.apply(this, arguments).finally(function() {
          pendingFetches--;
          lastChange = Date.now();
        });
      };

      function check() {
        var now = Date.now();

        // Check for URL change (navigation happened)
        if (window.location.href !== initialUrl) {
          urlChanged = true;
          lastChange = Date.now(); // Reset - new page needs time to load
          initialUrl = window.location.href; // Track new URL
        }

        var stable = (now - lastChange >= minStable) && pendingFetches === 0;
        var timeout = now - start >= maxWait;

        if (stable || timeout) {
          observer.disconnect();
          window.fetch = origFetch;
          console.log('[agent] waitForStable:', stable ? 'stable' : 'timeout', (now - start) + 'ms', urlChanged ? '(navigated)' : '');
          resolve();
        } else {
          setTimeout(check, 80);
        }
      }

      // Start checking after initial delay
      setTimeout(check, expectNavigation ? 200 : 100);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DOM DISTILLATION — comprehensive view of the page
  // ═══════════════════════════════════════════════════════════════════════════
  function distillDOM() {
    var foldH = window.innerHeight;
    var items = [];
    var currentUrl = window.location.href;
    var urlChanged = lastUrl !== currentUrl;
    var pageContext = {
      url: currentUrl,
      title: document.title || '',
      urlChanged: urlChanged,
      previousUrl: urlChanged ? lastUrl : null
    };
    // Update lastUrl for next comparison
    lastUrl = currentUrl;

    // Helper: check if element is visible
    function isVisible(el) {
      var rect = el.getBoundingClientRect();
      var cs = window.getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' &&
        parseFloat(cs.opacity || '1') > 0 && (rect.width > 0 || rect.height > 0);
    }

    // Helper: get position relative to viewport
    function getPosition(el) {
      var rect = el.getBoundingClientRect();
      return rect.bottom < 0 ? 'above' : rect.top > foldH ? 'below' : 'visible';
    }

    // Helper: find label for an input
    function getLabel(el) {
      // Check for aria-label first
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
      // Check for associated label element
      if (el.id) {
        var label = document.querySelector('label[for=\"' + el.id + '\"]');
        if (label) return label.textContent.trim().slice(0, 50);
      }
      // Check for parent label
      var parentLabel = el.closest('label');
      if (parentLabel) {
        var text = parentLabel.textContent.replace(el.value || '', '').trim();
        if (text) return text.slice(0, 50);
      }
      // Check for nearby label (previous sibling or parent's previous child)
      var prev = el.previousElementSibling;
      if (prev && prev.tagName === 'LABEL') return prev.textContent.trim().slice(0, 50);
      return null;
    }

    // Helper: get selected options from a select element
    function getSelectedOptions(sel) {
      var selected = [];
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].selected) {
          selected.push(sel.options[i].text);
        }
      }
      return selected;
    }

    // ── 1. HEADINGS (page structure) ─────────────────────────────────────────
    var headings = document.querySelectorAll('h1, h2, h3');
    for (var i = 0; i < headings.length; i++) {
      var h = headings[i];
      if (h === host || host.contains(h) || !isVisible(h)) continue;
      items.push({
        entry: {
          tag: h.tagName.toLowerCase(),
          text: h.textContent.trim().slice(0, 100),
          position: getPosition(h),
          role: 'heading'
        },
        visible: true,
        position: getPosition(h)
      });
    }

    // ── 2. ERROR MESSAGES & ALERTS ───────────────────────────────────────────
    var alerts = document.querySelectorAll('[role=\"alert\"], [role=\"status\"], [aria-live], .error, .alert, .message, [class*=\"error\"], [class*=\"alert\"]');
    for (var i = 0; i < alerts.length; i++) {
      var a = alerts[i];
      if (a === host || host.contains(a) || !isVisible(a)) continue;
      var text = a.textContent.trim();
      if (text && text.length > 0 && text.length < 200) {
        items.push({
          entry: {
            tag: a.tagName.toLowerCase(),
            text: text.slice(0, 150),
            position: getPosition(a),
            role: 'alert',
            id: a.id || undefined,
            classes: a.className.toString().slice(0, 50)
          },
          visible: true,
          position: getPosition(a)
        });
      }
    }

    // ── 3. INTERACTIVE ELEMENTS ──────────────────────────────────────────────
    var INTERACTIVE = [
      'button', 'a[href]', 'input:not([type=\"hidden\"])', 'textarea', 'select',
      '[role=\"button\"]', '[role=\"link\"]', '[role=\"checkbox\"]', '[role=\"tab\"]',
      '[role=\"radio\"]', '[role=\"menuitem\"]', '[role=\"switch\"]', '[onclick]',
      '[contenteditable=\"true\"]'
    ].join(',');

    var nodeList = document.querySelectorAll(INTERACTIVE);
    for (var i = 0; i < nodeList.length; i++) {
      var el = nodeList[i];
      if (el === host || host.contains(el)) continue;

      var tag = el.tagName.toLowerCase();
      var visible = isVisible(el);

      // Skip hidden elements entirely — model shouldn't try to interact with them
      if (!visible) continue;

      var position = getPosition(el);
      var rawText = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);

      var entry = { tag: tag, position: position };

      // Basic attributes
      if (el.id) entry.id = el.id;
      if (el.getAttribute('name')) entry.name = el.getAttribute('name');
      if (el.getAttribute('type')) entry.type = el.getAttribute('type');
      if (el.getAttribute('role')) entry.role = el.getAttribute('role');
      if (el.getAttribute('href')) entry.href = el.getAttribute('href').slice(0, 100);
      if (el.getAttribute('placeholder')) entry.placeholder = el.getAttribute('placeholder');
      if (el.hasAttribute('disabled')) entry.disabled = true;
      if (el.hasAttribute('readonly')) entry.readonly = true;
      if (el.getAttribute('aria-expanded')) entry.expanded = el.getAttribute('aria-expanded') === 'true';

      // Text content (for buttons, links)
      if (rawText && tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
        entry.text = rawText;
      }

      // Label (for inputs)
      var label = getLabel(el);
      if (label) entry.label = label;

      // ── INPUT-SPECIFIC STATE ──
      if (tag === 'input') {
        var inputType = el.type.toLowerCase();

        // Checkbox / Radio: capture checked state
        if (inputType === 'checkbox' || inputType === 'radio') {
          entry.checked = el.checked;
        }
        // Text-like inputs: capture current value
        else if (['text', 'email', 'password', 'tel', 'url', 'search', 'number'].indexOf(inputType) !== -1) {
          if (el.value) entry.value = el.value.slice(0, 100);
        }
        // Range: capture current value
        else if (inputType === 'range') {
          entry.value = el.value;
          entry.min = el.min;
          entry.max = el.max;
        }
        // Date/time inputs
        else if (['date', 'time', 'datetime-local'].indexOf(inputType) !== -1) {
          if (el.value) entry.value = el.value;
        }
      }

      // ── TEXTAREA ──
      if (tag === 'textarea') {
        if (el.value) entry.value = el.value.slice(0, 200);
      }

      // ── SELECT ──
      if (tag === 'select') {
        // Add hint so model knows to use type, not click
        entry.hint = el.multiple ? 'use type action with option text to toggle selection' : 'use type action with option text to select';
        entry.options = [];
        for (var j = 0; j < el.options.length && j < 10; j++) {
          var opt = el.options[j];
          entry.options.push({
            value: opt.value,
            text: opt.text.slice(0, 50),
            selected: opt.selected
          });
        }
        if (el.options.length > 10) {
          entry.moreOptions = el.options.length - 10;
        }
        if (el.multiple) {
          entry.multiple = true;
          entry.selectedOptions = getSelectedOptions(el);
        }
      }

      // ── ARIA STATES ──
      if (el.getAttribute('aria-checked')) {
        entry.checked = el.getAttribute('aria-checked') === 'true';
      }
      if (el.getAttribute('aria-selected')) {
        entry.selected = el.getAttribute('aria-selected') === 'true';
      }
      if (el.getAttribute('aria-pressed')) {
        entry.pressed = el.getAttribute('aria-pressed') === 'true';
      }

      items.push({ entry: entry, visible: visible, position: position });
    }

    // ── 4. IMPORTANT TEXT CONTENT (near forms, instructions) ─────────────────
    var textEls = document.querySelectorAll('p, li, span, label, td, th, dt, dd, figcaption, code, pre');
    var textElIndex = 0;
    for (var i = 0; i < textEls.length && items.length < 180; i++) {
      var t = textEls[i];
      if (t === host || host.contains(t) || !isVisible(t)) continue;
      // Skip if it's inside an already-captured interactive element
      if (t.closest('button, a, select')) continue;
      var text = t.textContent.trim();
      var isCode = t.tagName.toLowerCase() === 'code' || t.tagName.toLowerCase() === 'pre';
      // Only capture meaningful text (not too short)
      if (text.length >= 10) {
        // Build stable selector for this element
        var stableSelector = null;
        if (t.id) {
          stableSelector = '#' + t.id;
        } else {
          // Create a data attribute for stable reference
          var refId = '_agref_' + textElIndex++;
          t.setAttribute('data-ag-ref', refId);
          stableSelector = '[data-ag-ref=\"' + refId + '\"]';
        }

        // Truncate long content — agent can use read action to get full text
        var TRUNCATE_THRESHOLD = isCode ? 150 : 100;
        var truncated = text.length > TRUNCATE_THRESHOLD;
        var displayText = truncated ? text.slice(0, TRUNCATE_THRESHOLD) + '...' : text;

        var entry = {
          tag: t.tagName.toLowerCase(),
          text: displayText,
          position: getPosition(t),
          role: isCode ? 'code' : 'text'
        };

        // Add truncation metadata so agent knows it can request full content
        if (truncated) {
          entry.truncated = true;
          entry.fullLength = text.length;
          entry.selector = stableSelector;
        }

        items.push({
          entry: entry,
          visible: true,
          position: getPosition(t)
        });
      }
    }

    // ── SORT: prioritize visible, in-view elements ───────────────────────────
    items.sort(function (a, b) {
      var score = function (x) {
        var s = 0;
        if (x.visible) s += 4;
        if (x.position === 'visible') s += 2;
        else if (x.position === 'below') s += 1;
        // Prioritize interactive over text
        if (x.entry.role !== 'text' && x.entry.role !== 'heading') s += 2;
        return s;
      };
      return score(b) - score(a);
    });

    return {
      page: pageContext,
      elements: items.slice(0, 200).map(function (x) { return x.entry; })
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTION EXECUTORS
  // ═══════════════════════════════════════════════════════════════════════════
  function findEl(selector) {
    if (!selector) return null;

    // Handle text="Exact Text" or text='Exact Text' selector
    var exactMatch = selector.match(/^text=["'](.+)["']$/);
    if (exactMatch) {
      var searchText = exactMatch[1];
      var allEls = document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]');
      for (var i = 0; i < allEls.length; i++) {
        var elText = (allEls[i].textContent || '').trim();
        if (elText === searchText) return allEls[i];
      }
      return null;
    }

    // Handle text~="partial text" or text~='partial text' selector (case-insensitive)
    var partialMatch = selector.match(/^text~=["'](.+)["']$/);
    if (partialMatch) {
      var searchLower = partialMatch[1].toLowerCase();
      var allEls2 = document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"], label, span, div, p');
      for (var j = 0; j < allEls2.length; j++) {
        var elText2 = (allEls2[j].textContent || '').toLowerCase();
        if (elText2.indexOf(searchLower) !== -1) return allEls2[j];
      }
      return null;
    }

    // Handle jQuery-style :contains() selector (models often try this)
    var containsMatch = selector.match(/^(.+):contains\(['"](.+)['"]\)$/);
    if (containsMatch) {
      var baseSelector = containsMatch[1];
      var containsText = containsMatch[2].toLowerCase();
      try {
        var candidates = document.querySelectorAll(baseSelector);
        for (var k = 0; k < candidates.length; k++) {
          var cText = (candidates[k].textContent || '').toLowerCase();
          if (cText.indexOf(containsText) !== -1) return candidates[k];
        }
      } catch (e) { /* ignore */ }
      return null;
    }

    // Standard CSS selector
    try { return document.querySelector(selector); } catch (e) { return null; }
  }

  function clickElement(selector) {
    var el = findEl(selector);
    console.log('[agent] clickElement:', selector, '->', el);
    if (!el) return false;

    // Special handling: clicking an <option> should select it in the parent <select>
    if (el.tagName.toLowerCase() === 'option') {
      var selectEl = el.closest('select');
      if (selectEl) {
        if (selectEl.multiple) {
          // Multi-select: toggle this option
          el.selected = !el.selected;
        } else {
          // Single select: set selectedIndex
          for (var i = 0; i < selectEl.options.length; i++) {
            if (selectEl.options[i] === el) {
              selectEl.selectedIndex = i;
              break;
            }
          }
        }
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[agent] clickElement: selected option in', selectEl.name || selectEl.id);
        return true;
      }
    }

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus(); el.click();
    return true;
  }

  function typeInElement(selector, text) {
    var el = findEl(selector);
    if (!el) return false;
    el.focus();

    // Handle select elements
    if (el.tagName.toLowerCase() === 'select') {
      return selectOption(el, text);
    }

    var proto = el.tagName.toLowerCase() === 'textarea'
      ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) { descriptor.set.call(el, text); } else { el.value = text; }
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function selectOption(selectEl, value) {
    var options = selectEl.options;
    var found = false;
    var lowerValue = value.toLowerCase();

    // Handle multi-select: toggle the matching option
    if (selectEl.multiple) {
      for (var i = 0; i < options.length; i++) {
        if (options[i].value === value || options[i].text.toLowerCase().indexOf(lowerValue) !== -1) {
          options[i].selected = !options[i].selected;
          found = true;
          console.log('[agent] multiSelect toggle:', value, '->', options[i].selected);
          break;
        }
      }
    } else {
      // Single select: try matching by value first
      for (var i = 0; i < options.length; i++) {
        if (options[i].value === value) {
          selectEl.selectedIndex = i;
          found = true;
          break;
        }
      }

      // If not found by value, try matching by text (case-insensitive)
      if (!found) {
        for (var j = 0; j < options.length; j++) {
          if (options[j].text.toLowerCase().indexOf(lowerValue) !== -1) {
            selectEl.selectedIndex = j;
            found = true;
            break;
          }
        }
      }
      if (found) {
        console.log('[agent] selectOption:', value, '-> index', selectEl.selectedIndex);
      }
    }

    if (found) {
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return found;
  }

  function scrollToElement(selector) {
    var el = findEl(selector);
    if (!el) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  }

  function scrollPage(direction) {
    window.scrollBy({ top: (direction === 'down' ? 1 : -1) * window.innerHeight * 0.7, behavior: 'smooth' });
    return true;
  }

  function hoverElement(selector) {
    var el = findEl(selector);
    if (!el) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    console.log('[agent] hoverElement:', selector);
    return true;
  }

  function scrollInContainer(containerSelector, direction) {
    var container = findEl(containerSelector);
    if (!container) return false;
    var amount = container.clientHeight * 0.7;
    container.scrollBy({ top: (direction === 'down' ? 1 : -1) * amount, behavior: 'smooth' });
    console.log('[agent] scrollInContainer:', containerSelector, direction);
    return true;
  }

  // Read full text content from an element (for truncated content)
  function readElement(selector) {
    var el = findEl(selector);
    if (!el) return { success: false, error: 'element not found', text: null };
    var text = el.textContent.trim();
    console.log('[agent] readElement:', selector, '-> length:', text.length);
    return { success: true, error: null, text: text };
  }

  // ── element highlight (outlines target on the page before acting) ────────
  function highlightEl(selector) {
    if (!selector) return;
    var el = findEl(selector);
    if (!el) return;
    var prevOutline    = el.style.outline;
    var prevOffset     = el.style.outlineOffset;
    var prevShadow     = el.style.boxShadow;
    var prevTransition = el.style.transition;
    el.style.transition   = 'outline .1s,box-shadow .1s';
    el.style.outline      = '2px solid rgba(139,92,246,.75)';
    el.style.outlineOffset = '2px';
    el.style.boxShadow    = '0 0 0 4px rgba(139,92,246,.12)';
    setTimeout(function () {
      el.style.outline      = prevOutline;
      el.style.outlineOffset = prevOffset;
      el.style.boxShadow    = prevShadow;
      el.style.transition   = prevTransition;
    }, 950);
  }

  window.__agentActions = { clickElement: clickElement, typeInElement: typeInElement,
    scrollToElement: scrollToElement, scrollPage: scrollPage, hoverElement: hoverElement,
    scrollInContainer: scrollInContainer, readElement: readElement, distillDOM: distillDOM };

  // ── CSS ──────────────────────────────────────────────────────────────────
  var styleEl = document.createElement('style');
  styleEl.textContent = [
    '*{box-sizing:border-box;margin:0;padding:0;}',
    '.btn{width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;',
    '  background:#18181b;border:1px solid rgba(255,255,255,0.1);',
    '  display:flex;align-items:center;justify-content:center;',
    '  box-shadow:0 4px 20px rgba(0,0,0,0.5),0 1px 0 rgba(255,255,255,0.06) inset;',
    '  position:relative;z-index:2;transition:background .18s,box-shadow .18s,transform .14s;}',
    '.btn:hover{background:#222226;box-shadow:0 6px 28px rgba(0,0,0,0.6);}',
    '.btn:active{transform:scale(0.93);}',
    '.btn .ic{position:absolute;transition:opacity .18s,transform .22s;}',
    '.btn .ic-chat{opacity:1;transform:scale(1) rotate(0);}',
    '.btn .ic-close{opacity:0;transform:scale(0.5) rotate(-60deg);}',
    '.btn.open .ic-chat{opacity:0;transform:scale(0.5) rotate(60deg);}',
    '.btn.open .ic-close{opacity:1;transform:scale(1) rotate(0);}',
    '.panel{position:absolute;bottom:64px;right:0;width:368px;height:540px;',
    '  background:#0c0c0e;border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;',
    '  box-shadow:0 16px 64px rgba(0,0,0,0.7),0 1px 0 rgba(255,255,255,0.05) inset;',
    '  display:flex;flex-direction:column;',
    '  opacity:0;transform:translateY(12px) scale(0.96);pointer-events:none;',
    '  transition:opacity .22s cubic-bezier(.16,1,.3,1),transform .22s cubic-bezier(.16,1,.3,1);}',
    '.panel.open{opacity:1;transform:translateY(0) scale(1);pointer-events:all;}',
    '.hdr{padding:14px 16px;flex-shrink:0;background:#111114;',
    '  border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:10px;}',
    '.hdr-dot{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 7px rgba(34,197,94,.55);flex-shrink:0;}',
    '.hdr-name{color:#f4f4f5;font-size:13px;font-weight:500;letter-spacing:-.01em;}',
    '.hdr-status{color:#52525b;font-size:11px;margin-left:auto;}',
    '.msgs{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:8px;}',
    '.msgs::-webkit-scrollbar{width:3px;}',
    '.msgs::-webkit-scrollbar-track{background:transparent;}',
    '.msgs::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:3px;}',
    '.empty{flex:1;display:flex;align-items:center;justify-content:center;}',
    '.empty p{color:#3f3f46;font-size:13px;}',
    '.msg{display:flex;flex-direction:column;max-width:82%;animation:fi .16s ease;}',
    '@keyframes fi{from{opacity:0;transform:translateY(5px);}to{opacity:1;transform:translateY(0);}}',
    '.msg.u{align-self:flex-end;align-items:flex-end;}',
    '.msg.a{align-self:flex-start;align-items:flex-start;}',
    '.msg.err{align-self:center;}',
    // action step pills — spinner while executing, checkmark when done
    '.msg.act{align-self:flex-start;max-width:90%;}',
    '.msg.act .bbl{display:flex;align-items:center;gap:5px;',
    '  background:rgba(255,255,255,0.02);color:#71717a;font-size:11.5px;',
    '  padding:4px 10px 4px 8px;border-radius:20px;border:1px solid rgba(255,255,255,0.05);}',
    '.msg.act.done .bbl{color:#3f3f46;border-color:rgba(255,255,255,0.04);}',
    '.spin{width:10px;height:10px;border-radius:50%;flex-shrink:0;',
    '  border:1.5px solid rgba(255,255,255,0.08);border-top-color:#52525b;',
    '  animation:rot .65s linear infinite;}',
    '@keyframes rot{to{transform:rotate(360deg);}}',
    '.bbl{padding:9px 13px;font-size:13px;line-height:1.55;word-break:break-word;white-space:pre-wrap;color:#e4e4e7;}',
    '.msg.u .bbl{background:#27272a;border:1px solid rgba(255,255,255,0.07);border-radius:13px 13px 3px 13px;}',
    '.msg.a .bbl{background:#18181b;border:1px solid rgba(255,255,255,0.06);border-radius:13px 13px 13px 3px;}',
    '.msg.err .bbl{background:transparent;color:#71717a;font-size:12px;padding:2px 0;}',
    '.typing{align-self:flex-start;}',
    '.typing .bbl{display:flex;gap:4px;align-items:center;padding:12px 16px;}',
    '.dot{width:5px;height:5px;border-radius:50%;background:#3f3f46;animation:bns 1.2s ease infinite;}',
    '.dot:nth-child(2){animation-delay:.15s;}',
    '.dot:nth-child(3){animation-delay:.3s;}',
    '@keyframes bns{0%,60%,100%{transform:translateY(0);}30%{transform:translateY(-5px);}}',
    '.ftr{padding:10px 12px;flex-shrink:0;background:#0c0c0e;',
    '  border-top:1px solid rgba(255,255,255,0.06);display:flex;gap:8px;align-items:flex-end;}',
    '.inp{flex:1;background:#18181b;border:1px solid rgba(255,255,255,0.09);',
    '  border-radius:10px;padding:9px 12px;color:#e4e4e7;font-size:13px;font-family:inherit;',
    '  line-height:1.45;outline:none;resize:none;min-height:38px;max-height:120px;',
    '  overflow-y:auto;transition:border-color .15s;}',
    '.inp::placeholder{color:#3f3f46;}',
    '.inp:focus{border-color:rgba(255,255,255,0.18);}',
    '.snd{width:36px;height:36px;flex-shrink:0;border:none;border-radius:9px;cursor:pointer;',
    '  background:#e4e4e7;display:flex;align-items:center;justify-content:center;',
    '  transition:background .14s,transform .12s;}',
    '.snd:hover:not(:disabled){background:#fff;}',
    '.snd:active:not(:disabled){transform:scale(0.91);}',
    '.snd:disabled{background:#27272a;cursor:default;}',
    '.snd:disabled path{fill:#52525b;}',
    '.stop{display:none;width:36px;height:36px;flex-shrink:0;border:none;border-radius:9px;cursor:pointer;',
    '  background:#dc2626;align-items:center;justify-content:center;transition:background .14s,transform .12s;}',
    '.stop.show{display:flex;}',
    '.stop:hover{background:#b91c1c;}',
    '.stop:active{transform:scale(0.91);}',
  ].join('\\n');
  shadow.appendChild(styleEl);

  // ── markup ───────────────────────────────────────────────────────────────
  var wrap = document.createElement('div');
  wrap.innerHTML = [
    '<button class="btn" id="btn" aria-label="Open chat">',
    '  <svg class="ic ic-chat" width="22" height="22" viewBox="0 0 24 24" fill="none">',
    '    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"',
    '      stroke="#a1a1aa" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    '  <svg class="ic ic-close" width="18" height="18" viewBox="0 0 24 24" fill="none">',
    '    <path d="M18 6 6 18M6 6l12 12" stroke="#a1a1aa" stroke-width="2" stroke-linecap="round"/></svg>',
    '</button>',
    '<div class="panel" id="panel" role="dialog" aria-label="Chat">',
    '  <div class="hdr"><div class="hdr-dot"></div>',
    '    <span class="hdr-name">Agent</span><span class="hdr-status">Online</span></div>',
    '  <div class="msgs" id="msgs">',
    '    <div class="empty" id="empty"><p>How can I help you?</p></div></div>',
    '  <div class="ftr">',
    '    <textarea class="inp" id="inp" placeholder="Message..." rows="1"></textarea>',
    '    <button class="snd" id="snd" disabled aria-label="Send">',
    '      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">',
    '        <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"',
    '          stroke="#09090b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    '      </svg></button>',
    '    <button class="stop" id="stop" aria-label="Stop">',
    '      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">',
    '        <rect x="4" y="4" width="16" height="16" rx="2" fill="#fff"/>',
    '      </svg></button></div></div>',
  ].join('');
  shadow.appendChild(wrap);

  var btn   = shadow.getElementById('btn');
  var panel = shadow.getElementById('panel');
  var msgs  = shadow.getElementById('msgs');
  var inp   = shadow.getElementById('inp');
  var snd   = shadow.getElementById('snd');
  var stop  = shadow.getElementById('stop');
  var empty = shadow.getElementById('empty');
  var stopped = false;

  // ── UI helpers ───────────────────────────────────────────────────────────
  function scrollBottom() { msgs.scrollTop = msgs.scrollHeight; }

  function setLoading(on) {
    isLoading = on;
    snd.disabled = on || inp.value.trim() === '';
    if (on) {
      stop.classList.add('show');
      stopped = false;
    } else {
      stop.classList.remove('show');
    }
  }

  stop.addEventListener('click', function () {
    stopped = true;
    removeTyping();
    hideOverlay();
    appendMessage('err', 'Stopped by user.');
    setLoading(false);
    loopCount = 0;
  });

  function appendMessage(role, text) {
    if (msgCount === 0) empty.style.display = 'none';
    msgCount++;
    var row = document.createElement('div');
    row.className = 'msg ' + role;
    var bbl = document.createElement('div');
    bbl.className = 'bbl';
    bbl.textContent = text;
    row.appendChild(bbl);
    msgs.appendChild(row);
    scrollBottom();
  }

  function showTyping() {
    var row = document.createElement('div');
    row.className = 'msg typing'; row.id = '_typing';
    row.innerHTML = '<div class="bbl"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
    msgs.appendChild(row);
    scrollBottom();
  }

  function removeTyping() {
    var t = shadow.getElementById('_typing');
    if (t) t.remove();
  }

  // ── action pill helpers ──────────────────────────────────────────────────
  function showActionPill(description) {
    if (msgCount === 0) empty.style.display = 'none';
    msgCount++;
    var row = document.createElement('div');
    row.className = 'msg act';
    var bbl = document.createElement('div');
    bbl.className = 'bbl';
    var spinEl = document.createElement('div');
    spinEl.className = 'spin';
    bbl.appendChild(spinEl);
    bbl.appendChild(document.createTextNode('\u00a0' + (description || 'Acting...')));
    row.appendChild(bbl);
    msgs.appendChild(row);
    scrollBottom();
    return row;
  }

  function resolveActionPill(row, description) {
    row.classList.add('done');
    var bbl = row.querySelector('.bbl');
    if (!bbl) return;
    bbl.innerHTML = '';
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '10'); svg.setAttribute('height', '10');
    svg.setAttribute('viewBox', '0 0 10 10');
    svg.style.cssText = 'flex-shrink:0;display:inline-block;vertical-align:middle;';
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M1.5 5l2.5 2.5 4.5-4.5');
    path.setAttribute('stroke', '#3f3f46');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('fill', 'none');
    svg.appendChild(path);
    bbl.appendChild(svg);
    bbl.appendChild(document.createTextNode('\u00a0' + (description || 'Done')));
  }

  // ── open / close ─────────────────────────────────────────────────────────
  function toggle() {
    isOpen = !isOpen;
    btn.classList.toggle('open', isOpen);
    panel.classList.toggle('open', isOpen);
    btn.setAttribute('aria-label', isOpen ? 'Close chat' : 'Open chat');
    if (isOpen) setTimeout(function () { inp.focus(); }, 240);
  }

  btn.addEventListener('click', toggle);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen) toggle();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTION EXECUTION — real-time feed with spinner → checkmark per step
  // ═══════════════════════════════════════════════════════════════════════════
  function executeActions(actions, onComplete) {
    if (!actions || actions.length === 0) { onComplete([]); return; }

    // ── DUPLICATE DETECTION: Filter out recently executed actions ───────────
    var filtered = [];
    for (var f = 0; f < actions.length; f++) {
      var actionKey = actions[f].type + ':' + (actions[f].selector || '');
      var recentCount = 0;
      // Check last 6 actions
      for (var c = executedActions.length - 1; c >= Math.max(0, executedActions.length - 6); c--) {
        if (executedActions[c] === actionKey) recentCount++;
      }
      if (recentCount < 2) {
        filtered.push(actions[f]);
        executedActions.push(actionKey);
        // Keep executedActions bounded
        if (executedActions.length > 20) executedActions.shift();
      } else {
        console.log('[agent] blocked duplicate action:', actionKey, '(attempted', recentCount, 'times)');
      }
    }

    if (filtered.length === 0 && actions.length > 0) {
      // All actions were duplicates — likely stuck in a loop
      console.log('[agent] all actions blocked as duplicates — breaking loop');
      onComplete([{ type: 'blocked', success: false, error: 'repeated actions detected — loop broken' }]);
      return;
    }

    showOverlay();
    var idx = 0;
    var results = [];
    var startUrl = window.location.href; // Track URL at start

    function next() {
      if (stopped) {
        hideOverlay();
        return;
      }
      // HARD CONSTRAINT: If URL changed, abort remaining actions immediately
      // This prevents redundant actions after navigation (delete -> redirect)
      if (window.location.href !== startUrl) {
        console.log('[agent] URL changed during execution, aborting remaining actions');
        hideOverlay();
        // Wait for new page to stabilize before returning
        waitForStable(400, 2000).then(function() { onComplete(results); });
        return;
      }
      if (idx >= filtered.length) {
        hideOverlay();
        // Wait for DOM to stabilize before returning results
        waitForStable(300, 1500).then(function() { onComplete(results); });
        return;
      }
      var action = filtered[idx++];
      var pill = showActionPill(action.description || 'Acting...');
      highlightEl(action.selector);

      // Brief pause so browser paints the spinner before the action fires
      setTimeout(function () {
        var success = false;
        var error = null;

        try {
          if (action.type === 'click') {
            success = clickElement(action.selector);
            if (!success) error = 'element not found';
          }
          else if (action.type === 'type') {
            success = typeInElement(action.selector, action.text || '');
            if (!success) error = 'element not found';
          }
          else if (action.type === 'scroll') {
            if (action.container) {
              success = scrollInContainer(action.container, action.direction || 'down');
              if (!success) error = 'container not found';
            }
            else if (action.selector) {
              success = scrollToElement(action.selector);
              if (!success) error = 'element not found';
            }
            else {
              success = scrollPage(action.direction || 'down');
            }
          }
          else if (action.type === 'hover') {
            success = hoverElement(action.selector);
            if (!success) error = 'element not found';
          }
          else if (action.type === 'wait') {
            // Wait action — agent-controlled pause
            var waitMs = (action.ms && action.ms > 0 && action.ms <= 5000) ? action.ms : 800;
            success = true;
            results.push({ type: 'wait', selector: null, success: true, error: null });
            resolveActionPill(pill, action.description || 'Waiting...');
            console.log('[agent] wait:', waitMs, 'ms');
            setTimeout(next, waitMs);
            return;
          }
          else if (action.type === 'read') {
            // Read action — get full text content
            var readResult = readElement(action.selector);
            success = readResult.success;
            error = readResult.error;
            results.push({
              type: 'read',
              selector: action.selector,
              success: success,
              error: error,
              text: readResult.text
            });
            resolveActionPill(pill, action.description || 'Read content');
            setTimeout(next, 100);
            return;
          }
        } catch (e) {
          console.error('[agent widget] action error:', action, e);
          error = e.message || 'execution error';
        }

        results.push({
          type: action.type,
          selector: action.selector || null,
          success: success,
          error: error
        });

        resolveActionPill(pill, action.description || 'Done');

        // Detect if this click might cause navigation
        var mightNavigate = action.type === 'click' && (function() {
          var s = ((action.selector || '') + ' ' + (action.description || '')).toLowerCase();
          return s.includes('sign') || s.includes('log') || s.includes('submit') ||
                 s.includes('next') || s.includes('continue') || s.includes('go') ||
                 s.includes('nav') || s.includes('link') || s.includes('confirm') ||
                 s.includes('delete') || s.includes('create') || s.includes('save');
        })();

        // Wait for DOM to stabilize after action before proceeding
        // Use longer wait if click might cause navigation
        waitForStable(mightNavigate ? 500 : 250, mightNavigate ? 4000 : 2000, mightNavigate).then(next);
      }, 60);
    }
    next();
  }

  // ── response handler ─────────────────────────────────────────────────────
  function handleResponse(data) {
    removeTyping();

    if (data.conversationId) {
      conversationId = data.conversationId;
      sessionStorage.setItem(CID_KEY, conversationId);
    }

    if (data.reply) appendMessage('a', data.reply);

    var actions = data.actions || [];

    if (actions.length > 0) {
      executeActions(actions, function (actionResults) {
        if (data.done) { setLoading(false); loopCount = 0; }
        else           { sendContinuation(actionResults); }
      });
    } else {
      if (data.done) {
        setLoading(false);
        loopCount = 0;
      } else {
        // No actions but not done — agent wants to continue observing
        // If there's a message, it's communicating mid-task; continue the loop
        // If no message either, something went wrong — show error
        if (data.reply) {
          // Agent sent a message, give it another turn to continue
          sendContinuation([]);
        } else {
          // No actions, not done, no message — agent stalled
          appendMessage('err', 'Agent stalled — please try again.');
          setLoading(false);
          loopCount = 0;
        }
      }
    }
  }

  // ── continuation ─────────────────────────────────────────────────────────
  function sendContinuation(actionResults) {
    if (stopped) return;
    if (++loopCount > MAX_LOOPS) {
      appendMessage('err', 'Taking too long \u2014 please try again.');
      setLoading(false); loopCount = 0; return;
    }
    showTyping();
    fetch(serverOrigin + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteKey: siteKey,
        visitorId: visitorId,
        conversationId: conversationId,
        isActionResult: true,
        actionResults: actionResults || [],
        dom: distillDOM(),
      }),
    })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(handleResponse)
      .catch(function (err) {
        removeTyping();
        appendMessage('err', 'Something went wrong. Please try again.');
        setLoading(false); loopCount = 0;
        console.error('[agent widget]', err);
      });
  }

  // ── send (user message) ──────────────────────────────────────────────────
  inp.addEventListener('input', function () {
    inp.style.height = 'auto';
    inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
    snd.disabled = isLoading || inp.value.trim() === '';
  });

  inp.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!snd.disabled) send(); }
  });

  snd.addEventListener('click', send);

  function send() {
    var text = inp.value.trim();
    if (!text || isLoading) return;

    appendMessage('u', text);
    inp.value = ''; inp.style.height = 'auto';
    loopCount = 0;
    executedActions = []; // Reset duplicate tracking for new task
    setLoading(true);
    showTyping();

    fetch(serverOrigin + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteKey: siteKey, visitorId: visitorId,
        conversationId: conversationId,
        message: text, dom: distillDOM(),
        isActionResult: false,
      }),
    })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(handleResponse)
      .catch(function (err) {
        removeTyping();
        appendMessage('err', 'Something went wrong. Please try again.');
        setLoading(false);
        console.error('[agent widget]', err);
      });
  }

  // ── show completed action pill (for history) ────────────────────────────────
  function showCompletedPill(description) {
    if (msgCount === 0) empty.style.display = 'none';
    msgCount++;
    var row = document.createElement('div');
    row.className = 'msg act done';
    var bbl = document.createElement('div');
    bbl.className = 'bbl';
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '10'); svg.setAttribute('height', '10');
    svg.setAttribute('viewBox', '0 0 10 10');
    svg.style.cssText = 'flex-shrink:0;display:inline-block;vertical-align:middle;';
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M1.5 5l2.5 2.5 4.5-4.5');
    path.setAttribute('stroke', '#3f3f46');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('fill', 'none');
    svg.appendChild(path);
    bbl.appendChild(svg);
    bbl.appendChild(document.createTextNode('\u00a0' + (description || 'Done')));
    row.appendChild(bbl);
    msgs.appendChild(row);
  }

  // ── load conversation history on init ─────────────────────────────────────
  function loadHistory() {
    if (!conversationId) return;

    fetch(serverOrigin + '/api/chat/history?siteKey=' + encodeURIComponent(siteKey) + '&conversationId=' + encodeURIComponent(conversationId))
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data.messages && data.messages.length > 0) {
          empty.style.display = 'none';
          data.messages.forEach(function (m) {
            if (m.role === 'user') {
              appendMessage('u', m.content);
            } else if (m.role === 'assistant') {
              appendMessage('a', m.content);
            } else if (m.role === 'actions' && m.actions) {
              m.actions.forEach(function (a) {
                showCompletedPill(a.description);
              });
            }
          });
          scrollBottom();
        }
      })
      .catch(function (err) {
        console.log('[agent widget] could not load history:', err);
      });
  }

  // Load history if we have a conversation
  loadHistory();
})();`;
}
