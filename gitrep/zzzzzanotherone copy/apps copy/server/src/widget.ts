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
  var MAX_LOOPS = 12;

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
  // DOM DISTILLATION — interactive elements only (~3-5k tokens vs 40k+ for full page)
  // ═══════════════════════════════════════════════════════════════════════════
  function distillDOM() {
    var foldH = window.innerHeight;
    var items = [];

    // ── 0. PAGE CONTEXT (always first) ────────────────────────────────────────
    var pageInfo = {
      role: 'page',
      url: window.location.href,
      path: window.location.pathname,
      title: document.title || '(no title)',
      domain: window.location.hostname
    };
    items.push({ entry: pageInfo, visible: true, position: 'visible', priority: 100 });

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

    // ── 1. VISIBLE HEADINGS (page context — max 3) ────────────────────────────
    var headingCount = 0;
    var headings = document.querySelectorAll('h1, h2');
    for (var i = 0; i < headings.length && headingCount < 3; i++) {
      var h = headings[i];
      if (h === host || host.contains(h) || !isVisible(h)) continue;
      var hText = h.textContent.trim();
      if (hText && hText.length > 2) {
        items.push({
          entry: { role: 'heading', tag: h.tagName.toLowerCase(), text: hText.slice(0, 60) },
          visible: true, position: getPosition(h), priority: 30
        });
        headingCount++;
      }
    }

    // ── 2. VISIBLE ALERTS/TOASTS (role="alert" or role="status" only) ─────────
    var alertEls = document.querySelectorAll('[role=\"alert\"], [role=\"status\"]');
    for (var i = 0; i < alertEls.length && i < 2; i++) {
      var a = alertEls[i];
      if (a === host || host.contains(a) || !isVisible(a)) continue;
      var text = a.textContent.trim();
      if (text && text.length > 2 && text.length < 120) {
        items.push({
          entry: { role: 'alert', text: text.slice(0, 80) },
          visible: true, position: getPosition(a), priority: 50
        });
      }
    }

    // ── 3. VISIBLE TEXT (so agent can "read" the page) ────────────────────────
    var textEls = document.querySelectorAll('p, li, td, th, figcaption, blockquote, [class*=\"message\"], [class*=\"description\"]');
    var textCount = 0;
    for (var i = 0; i < textEls.length && textCount < 10; i++) {
      var t = textEls[i];
      if (t === host || host.contains(t) || !isVisible(t)) continue;
      if (t.closest('button, a, select, nav')) continue; // skip if inside interactive
      var pos = getPosition(t);
      if (pos !== 'visible') continue; // only visible text
      var txt = t.textContent.trim();
      if (txt.length >= 10 && txt.length <= 200) {
        items.push({
          entry: { role: 'text', text: txt.slice(0, 120) },
          visible: true, position: pos, priority: 10
        });
        textCount++;
      }
    }

    // ── 4. INTERACTIVE ELEMENTS (the core — this is what the agent acts on) ──
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
      var position = getPosition(el);
      var rawText = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100);

      var entry = { tag: tag, position: position };
      if (!visible) entry.hidden = true;

      // Basic attributes
      if (el.id) entry.id = el.id;
      if (el.getAttribute('name')) entry.name = el.getAttribute('name');
      if (el.getAttribute('type')) entry.type = el.getAttribute('type');
      if (el.getAttribute('role')) entry.role = el.getAttribute('role');
      if (el.getAttribute('href')) entry.href = el.getAttribute('href').slice(0, 60);
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
          if (el.value) entry.value = el.value.slice(0, 50);
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
        if (el.value) entry.value = el.value.slice(0, 80);
      }

      // ── SELECT ──
      if (tag === 'select') {
        entry.options = [];
        for (var j = 0; j < el.options.length && j < 12; j++) {
          var opt = el.options[j];
          entry.options.push({
            value: opt.value,
            text: opt.text.slice(0, 40),
            selected: opt.selected
          });
        }
        if (el.options.length > 12) {
          entry.moreOptions = el.options.length - 12;
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

    // ── FILTER: only what's visible on screen (like human vision) ─────────────
    var visible = items.filter(function (x) {
      return x.position === 'visible' && x.visible !== false;
    });

    // Count what's off-screen so agent knows it can scroll
    var belowCount = items.filter(function (x) { return x.position === 'below'; }).length;
    var aboveCount = items.filter(function (x) { return x.position === 'above'; }).length;

    // Add scroll hint if there's more content
    if (belowCount > 0 || aboveCount > 0) {
      visible.unshift({
        entry: { role: 'scroll-hint', above: aboveCount, below: belowCount },
        visible: true, position: 'visible', priority: 80
      });
    }

    // Return only visible elements — agent scrolls to see more
    return visible.slice(0, 60).map(function (x) { return x.entry; });
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

    // Standard CSS selector
    try { return document.querySelector(selector); } catch (e) { return null; }
  }

  function clickElement(selector) {
    var el = findEl(selector);
    console.log('[agent] clickElement:', selector, '->', el);
    if (!el) return false;
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

  function pressKey(key, selector) {
    var target = selector ? findEl(selector) : document.activeElement || document.body;
    if (!target) target = document.body;

    var keyMap = {
      'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
      'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
      'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
      'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
      'Space': { key: ' ', code: 'Space', keyCode: 32 }
    };

    var keyInfo = keyMap[key] || { key: key, code: 'Key' + key.toUpperCase(), keyCode: key.charCodeAt(0) };

    var eventOptions = {
      key: keyInfo.key,
      code: keyInfo.code,
      keyCode: keyInfo.keyCode,
      which: keyInfo.keyCode,
      bubbles: true,
      cancelable: true
    };

    target.dispatchEvent(new KeyboardEvent('keydown', eventOptions));
    target.dispatchEvent(new KeyboardEvent('keypress', eventOptions));
    target.dispatchEvent(new KeyboardEvent('keyup', eventOptions));

    // Special handling for Enter on forms
    if (key === 'Enter' && target.form) {
      target.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }

    console.log('[agent] pressKey:', key, 'on', selector || 'active element');
    return true;
  }

  function navigateTo(url) {
    console.log('[agent] navigateTo:', url);
    window.location.href = url;
    return true;
  }

  function waitFor(selector, timeout, callback) {
    var start = Date.now();
    function check() {
      var el = findEl(selector);
      if (el) {
        console.log('[agent] waitFor: found', selector);
        callback(true);
      } else if (Date.now() - start > timeout) {
        console.log('[agent] waitFor: timeout', selector);
        callback(false);
      } else {
        setTimeout(check, 100);
      }
    }
    check();
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
    scrollInContainer: scrollInContainer, pressKey: pressKey, navigateTo: navigateTo,
    distillDOM: distillDOM };

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
    '      </svg></button></div></div>',
  ].join('');
  shadow.appendChild(wrap);

  var btn   = shadow.getElementById('btn');
  var panel = shadow.getElementById('panel');
  var msgs  = shadow.getElementById('msgs');
  var inp   = shadow.getElementById('inp');
  var snd   = shadow.getElementById('snd');
  var empty = shadow.getElementById('empty');

  // ── UI helpers ───────────────────────────────────────────────────────────
  function scrollBottom() { msgs.scrollTop = msgs.scrollHeight; }

  function setLoading(on) {
    isLoading = on;
    snd.disabled = on || inp.value.trim() === '';
  }

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
  // ── Smart wait: detect when page settles (DOM stops changing) ────────────
  function waitForPageSettle(callback) {
    var startUrl = window.location.href;
    var settled = false;
    var changeTimer = null;
    var maxTimer = null;

    function done() {
      if (settled) return;
      settled = true;
      if (observer) observer.disconnect();
      if (changeTimer) clearTimeout(changeTimer);
      if (maxTimer) clearTimeout(maxTimer);
      callback();
    }

    // Only watch for STRUCTURAL changes (elements added/removed)
    // Ignore attribute changes (animations, carousels, live updates)
    var observer = new MutationObserver(function (mutations) {
      var significant = false;
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        // Only care if actual nodes were added or removed
        if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
          significant = true;
          break;
        }
      }
      // Reset timer when new elements appear (page still loading)
      if (significant) {
        if (changeTimer) clearTimeout(changeTimer);
        changeTimer = setTimeout(done, 300);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false  // Ignore attribute changes (animations, etc.)
    });

    // Start the settle timer
    changeTimer = setTimeout(done, 300);

    // Max wait 2 seconds
    maxTimer = setTimeout(done, 2000);
  }

  function executeActions(actions, onComplete) {
    if (!actions || actions.length === 0) { onComplete(); return; }
    showOverlay();
    var idx = 0;

    function next() {
      if (idx >= actions.length) {
        hideOverlay();
        // Simple short delay, agent controls longer waits with wait/waitFor actions
        setTimeout(onComplete, 300);
        return;
      }
      var action = actions[idx++];
      var pill = showActionPill(action.description || 'Acting...');
      highlightEl(action.selector);

      setTimeout(function () {
        try {
          if      (action.type === 'click')  { clickElement(action.selector); }
          else if (action.type === 'type')   { typeInElement(action.selector, action.text || ''); }
          else if (action.type === 'scroll') {
            if (action.container) { scrollInContainer(action.container, action.direction || 'down'); }
            else if (action.selector) { scrollToElement(action.selector); }
            else                 { scrollPage(action.direction || 'down'); }
          }
          else if (action.type === 'hover')  { hoverElement(action.selector); }
          else if (action.type === 'keypress') { pressKey(action.key, action.selector); }
          else if (action.type === 'navigate') { navigateTo(action.url); }
          else if (action.type === 'wait') {
            // Agent-controlled wait
            var waitMs = action.ms || 1000;
            resolveActionPill(pill, action.description || 'Waited');
            setTimeout(next, waitMs);
            return; // Don't fall through to normal next()
          }
          else if (action.type === 'waitFor') {
            // Wait for element to appear
            waitFor(action.selector, action.timeout || 3000, function () {
              resolveActionPill(pill, action.description || 'Done');
              setTimeout(next, 100);
            });
            return; // Don't fall through to normal next()
          }
        } catch (e) { console.error('[agent widget] action error:', action, e); }
        resolveActionPill(pill, action.description || 'Done');
        setTimeout(next, 300);
      }, 80);
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
      // Has actions → execute, then continue if not done
      executeActions(actions, function () {
        if (data.done) { setLoading(false); loopCount = 0; }
        else           { sendContinuation(); }
      });
    } else {
      // No actions → conversation turn complete (like Claude Code)
      // Agent answered a question or is waiting for user input
      setLoading(false);
      loopCount = 0;
    }
  }

  // ── continuation ─────────────────────────────────────────────────────────
  function sendContinuation() {
    if (++loopCount > MAX_LOOPS) {
      appendMessage('err', 'Taking too long \u2014 please try again.');
      setLoading(false); loopCount = 0; return;
    }
    showTyping();
    fetch(serverOrigin + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteKey: siteKey, visitorId: visitorId,
        conversationId: conversationId,
        isActionResult: true, dom: distillDOM(),
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
})();`;
}
