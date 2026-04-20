/**
 * Returns the self-contained widget JavaScript served as /embed/:siteKey.js.
 * Uses INDEXED ELEMENTS approach - elements get numeric IDs, LLM picks numbers.
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
  var executedActions = [];

  // ═══════════════════════════════════════════════════════════════════════════
  // ELEMENT INDEX MAP — maps numeric index to selector
  // This is the key to the indexed element approach
  // ═══════════════════════════════════════════════════════════════════════════
  var elementMap = {};

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

  // ── page overlay ─────────────────────────────────────────────────────────
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
  // WAIT FOR STABLE
  // ═══════════════════════════════════════════════════════════════════════════
  function waitForStable(minStable, maxWait, expectNavigation) {
    minStable = minStable || 350;
    maxWait = maxWait || 4000;
    var initialUrl = window.location.href;
    if (expectNavigation) {
      minStable = Math.max(minStable, 500);
      maxWait = Math.max(maxWait, 5000);
    }
    return new Promise(function(resolve) {
      var start = Date.now();
      var lastChange = Date.now();
      var observer = new MutationObserver(function() { lastChange = Date.now(); });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
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
        if (window.location.href !== initialUrl) {
          lastChange = Date.now();
          initialUrl = window.location.href;
        }
        var stable = (now - lastChange >= minStable) && pendingFetches === 0;
        var timeout = now - start >= maxWait;
        if (stable || timeout) {
          observer.disconnect();
          window.fetch = origFetch;
          resolve();
        } else {
          setTimeout(check, 80);
        }
      }
      setTimeout(check, expectNavigation ? 200 : 100);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUILD SELECTOR — creates a reliable selector for an element
  // ═══════════════════════════════════════════════════════════════════════════
  function buildSelector(el) {
    // 1. ID is best
    if (el.id) return '#' + el.id;

    // 2. Name attribute (for form fields)
    if (el.getAttribute('name')) return '[name="' + el.getAttribute('name') + '"]';

    // 3. Unique text content for buttons/links
    var tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') {
      var text = (el.textContent || '').trim();
      if (text && text.length < 50) {
        // Check if this text is unique
        var matches = document.querySelectorAll(tag + ', [role="button"]');
        var count = 0;
        for (var i = 0; i < matches.length; i++) {
          if ((matches[i].textContent || '').trim() === text) count++;
        }
        if (count === 1) return 'text="' + text + '"';
      }
    }

    // 4. Unique placeholder for inputs
    if (el.getAttribute('placeholder')) {
      var ph = el.getAttribute('placeholder');
      var inputs = document.querySelectorAll('input, textarea');
      var phCount = 0;
      for (var j = 0; j < inputs.length; j++) {
        if (inputs[j].getAttribute('placeholder') === ph) phCount++;
      }
      if (phCount === 1) return '[placeholder="' + ph + '"]';
    }

    // 5. Data attribute marker (fallback)
    var marker = '_ag_' + Math.random().toString(36).slice(2, 8);
    el.setAttribute('data-ag-id', marker);
    return '[data-ag-id="' + marker + '"]';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DOM DISTILLATION — indexed elements approach
  // Returns: { page, elements: ["[1] button 'Add to Cart'", ...], offScreen }
  // ═══════════════════════════════════════════════════════════════════════════
  function distillDOM() {
    var foldH = window.innerHeight;
    var currentUrl = window.location.href;
    var urlChanged = lastUrl !== currentUrl;
    lastUrl = currentUrl;

    // Reset element map for this snapshot
    elementMap = {};
    var index = 1;
    var lines = [];
    var offScreen = { above: 0, below: 0 };

    var pageContext = {
      url: currentUrl,
      title: document.title || '',
      urlChanged: urlChanged,
      previousUrl: urlChanged ? lastUrl : null
    };

    function isVisible(el) {
      var rect = el.getBoundingClientRect();
      var cs = window.getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' &&
        parseFloat(cs.opacity || '1') > 0 && (rect.width > 0 || rect.height > 0);
    }

    function getPosition(el) {
      var rect = el.getBoundingClientRect();
      return rect.bottom < 0 ? 'above' : rect.top > foldH ? 'below' : 'visible';
    }

    function getLabel(el) {
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
      if (el.id) {
        var label = document.querySelector('label[for="' + el.id + '"]');
        if (label) return label.textContent.trim().slice(0, 40);
      }
      var parentLabel = el.closest('label');
      if (parentLabel) {
        var text = parentLabel.textContent.replace(el.value || '', '').trim();
        if (text) return text.slice(0, 40);
      }
      return null;
    }

    // ── INTERACTIVE ELEMENTS (the main content) ─────────────────────────────
    var INTERACTIVE = [
      'button', 'a[href]', 'input:not([type="hidden"])', 'textarea', 'select',
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="tab"]',
      '[role="menuitem"]', '[onclick]'
    ].join(',');

    var nodeList = document.querySelectorAll(INTERACTIVE);
    for (var i = 0; i < nodeList.length && index <= 99; i++) {
      var el = nodeList[i];
      if (el === host || host.contains(el)) continue;
      if (!isVisible(el)) continue;

      var pos = getPosition(el);
      if (pos === 'above') { offScreen.above++; continue; }
      if (pos === 'below') { offScreen.below++; continue; }

      var tag = el.tagName.toLowerCase();
      var text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
      var selector = buildSelector(el);

      // Store in map
      elementMap[index] = selector;

      // Build compact description
      var desc = '[' + index + '] ' + tag;

      // Add type for inputs
      if (tag === 'input' && el.type) {
        desc += '[' + el.type + ']';
      }

      // Add text or label
      if (text && tag !== 'input' && tag !== 'textarea') {
        desc += ' "' + text + '"';
      } else {
        var label = getLabel(el);
        if (label) desc += ' label="' + label + '"';
        if (el.placeholder) desc += ' placeholder="' + el.placeholder + '"';
      }

      // Add current value for inputs
      if ((tag === 'input' || tag === 'textarea') && el.value) {
        desc += ' value="' + el.value.slice(0, 30) + '"';
      }

      // Add checked state
      if (el.type === 'checkbox' || el.type === 'radio') {
        desc += el.checked ? ' [checked]' : ' [unchecked]';
      }

      // Add disabled state
      if (el.disabled) desc += ' [disabled]';

      // Add options for select
      if (tag === 'select') {
        if (el.multiple) desc += ' [MULTI-SELECT]';
        var opts = [];
        for (var j = 0; j < el.options.length && j < 5; j++) {
          var opt = el.options[j];
          opts.push(opt.selected ? '*' + opt.text + '*' : opt.text);
        }
        if (el.options.length > 5) opts.push('...' + (el.options.length - 5) + ' more');
        desc += ' options=[' + opts.join(', ') + ']';
      }

      lines.push(desc);
      index++;
    }

    // ── HEADINGS (for context) ──────────────────────────────────────────────
    var headings = document.querySelectorAll('h1, h2, h3');
    for (var h = 0; h < headings.length; h++) {
      var heading = headings[h];
      if (heading === host || host.contains(heading) || !isVisible(heading)) continue;
      if (getPosition(heading) !== 'visible') continue;
      var hText = heading.textContent.trim().slice(0, 80);
      if (hText) lines.push('# ' + heading.tagName.toLowerCase() + ' "' + hText + '"');
    }

    // ── ALERTS/ERRORS (important feedback) ──────────────────────────────────
    var alerts = document.querySelectorAll('[role="alert"], .error, .alert, [class*="error"]');
    for (var a = 0; a < alerts.length; a++) {
      var alert = alerts[a];
      if (alert === host || host.contains(alert) || !isVisible(alert)) continue;
      var alertText = alert.textContent.trim().slice(0, 100);
      if (alertText && alertText.length > 3) {
        lines.push('! alert "' + alertText + '"');
      }
    }

    // ── SCROLLABLE CONTAINERS (important for infinite scroll, chat, lists) ───
    var allEls = document.querySelectorAll('div, section, ul, ol, nav, aside, main');
    for (var sc = 0; sc < allEls.length && index <= 99; sc++) {
      var container = allEls[sc];
      if (container === host || host.contains(container)) continue;
      if (!isVisible(container)) continue;
      var cs = window.getComputedStyle(container);
      var isScrollable = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
                         container.scrollHeight > container.clientHeight + 50;
      if (isScrollable && getPosition(container) === 'visible') {
        var selector = buildSelector(container);
        elementMap[index] = selector;
        var canScrollDown = container.scrollHeight - container.scrollTop - container.clientHeight > 10;
        var canScrollUp = container.scrollTop > 10;
        var scrollDir = canScrollDown && canScrollUp ? '↑↓' : (canScrollDown ? '↓' : '↑');
        lines.push('[' + index + '] scrollable-container ' + scrollDir + ' (' + Math.round(container.scrollHeight) + 'px)');
        index++;
      }
    }

    // ── TEXT CONTENT (key info) ─────────────────────────────────────────────
    var textEls = document.querySelectorAll('p, li, span, td, th, code');
    var textCount = 0;
    for (var t = 0; t < textEls.length && textCount < 15; t++) {
      var te = textEls[t];
      if (te === host || host.contains(te) || !isVisible(te)) continue;
      if (te.closest('button, a, select')) continue;
      if (getPosition(te) !== 'visible') continue;
      var teText = te.textContent.trim();
      if (teText.length >= 10 && teText.length < 150) {
        lines.push('> "' + teText.slice(0, 100) + '"');
        textCount++;
      }
    }

    // Build off-screen summary
    var offScreenSummary = null;
    if (offScreen.above > 0 || offScreen.below > 0) {
      offScreenSummary = {};
      if (offScreen.above > 0) offScreenSummary.above = offScreen.above + ' interactive elements';
      if (offScreen.below > 0) offScreenSummary.below = offScreen.below + ' interactive elements';
    }

    return {
      page: pageContext,
      elements: lines,
      offScreen: offScreenSummary
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTION EXECUTORS — now use index lookup
  // ═══════════════════════════════════════════════════════════════════════════

  // Resolve index to DOM element
  function getElementByIndex(idx) {
    var selector = elementMap[idx];
    if (!selector) {
      console.log('[agent] index', idx, 'not found in map');
      return null;
    }
    return findEl(selector);
  }

  function findEl(selector) {
    if (!selector) return null;

    // Handle text="Exact Text" selector
    var exactMatch = selector.match(/^text=["'](.+)["']$/);
    if (exactMatch) {
      var searchText = exactMatch[1];
      var allEls = document.querySelectorAll('button, a, [role="button"], input[type="submit"]');
      for (var i = 0; i < allEls.length; i++) {
        var elText = (allEls[i].textContent || '').trim();
        if (elText === searchText) return allEls[i];
      }
      return null;
    }

    try { return document.querySelector(selector); } catch (e) { return null; }
  }

  function clickElement(idx) {
    var el = getElementByIndex(idx);
    console.log('[agent] click(' + idx + ') ->', el ? 'found' : 'NOT FOUND');

    if (!el) {
      // Element not found - DOM may have changed. Suggest what's available.
      var available = Object.keys(elementMap).slice(0, 5).join(', ');
      var hint = available ? 'Available indices: ' + available + '. DOM may have changed - request new observation.' : 'No elements indexed. Page may still be loading.';
      return { success: false, error: 'element ' + idx + ' not found', hint: hint };
    }

    // Special handling for <option>
    if (el.tagName.toLowerCase() === 'option') {
      var selectEl = el.closest('select');
      if (selectEl) {
        for (var i = 0; i < selectEl.options.length; i++) {
          if (selectEl.options[i] === el) {
            selectEl.selectedIndex = i;
            break;
          }
        }
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };
      }
    }

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus();
    el.click();
    return { success: true };
  }

  function typeInElement(idx, text) {
    var el = getElementByIndex(idx);
    if (!el) return { success: false, error: 'element ' + idx + ' not found' };

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
    return { success: true };
  }

  function selectOption(selectEl, value) {
    var options = selectEl.options;
    var found = false;
    var lowerValue = value.toLowerCase();

    // Multi-select: toggle the matching option
    if (selectEl.multiple) {
      for (var i = 0; i < options.length; i++) {
        if (options[i].value === value || options[i].text.toLowerCase().indexOf(lowerValue) !== -1) {
          options[i].selected = !options[i].selected; // Toggle
          found = true;
          console.log('[agent] multi-select toggle:', value, '->', options[i].selected);
          break;
        }
      }
    } else {
      // Single select
      for (var i = 0; i < options.length; i++) {
        if (options[i].value === value || options[i].text.toLowerCase().indexOf(lowerValue) !== -1) {
          selectEl.selectedIndex = i;
          found = true;
          break;
        }
      }
    }

    if (found) {
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { success: found, error: found ? null : 'option not found' };
  }

  function hoverElement(idx) {
    var el = getElementByIndex(idx);
    if (!el) return { success: false, error: 'element ' + idx + ' not found' };
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    console.log('[agent] hover(' + idx + ')');
    return { success: true };
  }

  function scrollInContainer(containerIdx, direction) {
    var container = getElementByIndex(containerIdx);
    if (!container) return { success: false, error: 'container ' + containerIdx + ' not found' };
    var amount = container.clientHeight * 0.7;
    container.scrollBy({ top: (direction === 'down' ? 1 : -1) * amount, behavior: 'smooth' });
    console.log('[agent] scrollInContainer(' + containerIdx + ', ' + direction + ')');
    return { success: true };
  }

  function scrollPage(direction) {
    window.scrollBy({ top: (direction === 'down' ? 1 : -1) * window.innerHeight * 0.7, behavior: 'smooth' });
    return { success: true };
  }

  function scrollToElement(idx) {
    var el = getElementByIndex(idx);
    if (!el) return { success: false, error: 'element ' + idx + ' not found' };
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return { success: true };
  }

  // Highlight element before acting
  function highlightEl(idx) {
    var el = getElementByIndex(idx);
    if (!el) return;
    var prev = el.style.outline;
    el.style.outline = '2px solid rgba(139,92,246,.75)';
    el.style.outlineOffset = '2px';
    setTimeout(function () {
      el.style.outline = prev;
      el.style.outlineOffset = '';
    }, 900);
  }

  window.__agentActions = {
    clickElement: clickElement,
    typeInElement: typeInElement,
    scrollPage: scrollPage,
    scrollToElement: scrollToElement,
    scrollInContainer: scrollInContainer,
    hoverElement: hoverElement,
    distillDOM: distillDOM,
    getElementByIndex: getElementByIndex
  };

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
    if (on) { stop.classList.add('show'); stopped = false; }
    else { stop.classList.remove('show'); }
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
    bbl.appendChild(document.createTextNode(' ' + (description || 'Acting...')));
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
    svg.style.cssText = 'flex-shrink:0;';
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M1.5 5l2.5 2.5 4.5-4.5');
    path.setAttribute('stroke', '#3f3f46');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('fill', 'none');
    svg.appendChild(path);
    bbl.appendChild(svg);
    bbl.appendChild(document.createTextNode(' ' + (description || 'Done')));
  }

  function toggle() {
    isOpen = !isOpen;
    btn.classList.toggle('open', isOpen);
    panel.classList.toggle('open', isOpen);
    if (isOpen) setTimeout(function () { inp.focus(); }, 240);
  }

  btn.addEventListener('click', toggle);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen) toggle();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTION EXECUTION
  // ═══════════════════════════════════════════════════════════════════════════
  function executeActions(actions, onComplete) {
    if (!actions || actions.length === 0) { onComplete([]); return; }

    // Duplicate detection
    var filtered = [];
    for (var f = 0; f < actions.length; f++) {
      var actionKey = actions[f].type + ':' + (actions[f].index || '');
      var recentCount = 0;
      for (var c = executedActions.length - 1; c >= Math.max(0, executedActions.length - 6); c--) {
        if (executedActions[c] === actionKey) recentCount++;
      }
      if (recentCount < 2) {
        filtered.push(actions[f]);
        executedActions.push(actionKey);
        if (executedActions.length > 20) executedActions.shift();
      } else {
        console.log('[agent] blocked duplicate:', actionKey);
      }
    }

    if (filtered.length === 0) {
      onComplete([{ type: 'blocked', success: false, error: 'loop detected' }]);
      return;
    }

    showOverlay();
    var idx = 0;
    var results = [];
    var startUrl = window.location.href;

    function next() {
      if (stopped) { hideOverlay(); return; }
      if (window.location.href !== startUrl) {
        console.log('[agent] URL changed, aborting remaining actions');
        hideOverlay();
        waitForStable(400, 2000).then(function() { onComplete(results); });
        return;
      }
      if (idx >= filtered.length) {
        hideOverlay();
        waitForStable(300, 1500).then(function() { onComplete(results); });
        return;
      }

      var action = filtered[idx++];
      var pill = showActionPill(action.description || 'Acting...');
      if (action.index) highlightEl(action.index);

      setTimeout(function () {
        var result = { type: action.type, index: action.index, success: false, error: null, hint: null };

        try {
          if (action.type === 'click') {
            var clickRes = clickElement(action.index);
            result.success = clickRes.success;
            result.error = clickRes.error;
            result.hint = clickRes.hint || null;
          }
          else if (action.type === 'type') {
            var typeRes = typeInElement(action.index, action.text || '');
            result.success = typeRes.success;
            result.error = typeRes.error;
          }
          else if (action.type === 'scroll') {
            if (action.container) {
              // Scroll within a container element
              var containerRes = scrollInContainer(action.container, action.direction || 'down');
              result.success = containerRes.success;
              result.error = containerRes.error;
            } else if (action.index) {
              // Scroll to bring element into view
              var scrollRes = scrollToElement(action.index);
              result.success = scrollRes.success;
              result.error = scrollRes.error;
            } else {
              // Scroll the page
              var pageRes = scrollPage(action.direction || 'down');
              result.success = pageRes.success;
            }
          }
          else if (action.type === 'hover') {
            var hoverRes = hoverElement(action.index);
            result.success = hoverRes.success;
            result.error = hoverRes.error;
          }
          else if (action.type === 'wait') {
            var waitMs = Math.min(action.ms || 800, 3000);
            result.success = true;
            results.push(result);
            resolveActionPill(pill, action.description || 'Waited');
            setTimeout(next, waitMs);
            return;
          }
        } catch (e) {
          console.error('[agent] action error:', e);
          result.error = e.message || 'error';
        }

        results.push(result);
        resolveActionPill(pill, action.description || 'Done');

        // Detect navigation-likely actions
        var mightNavigate = action.type === 'click' && (function() {
          var desc = (action.description || '').toLowerCase();
          return desc.includes('submit') || desc.includes('sign') || desc.includes('log') ||
                 desc.includes('delete') || desc.includes('confirm') || desc.includes('save');
        })();

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
      } else if (data.reply) {
        sendContinuation([]);
      } else {
        appendMessage('err', 'Agent stalled.');
        setLoading(false);
        loopCount = 0;
      }
    }
  }

  function sendContinuation(actionResults) {
    if (stopped) return;
    if (++loopCount > MAX_LOOPS) {
      appendMessage('err', 'Taking too long.');
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
        appendMessage('err', 'Something went wrong.');
        setLoading(false); loopCount = 0;
        console.error('[agent]', err);
      });
  }

  // ── send ─────────────────────────────────────────────────────────────────
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
    executedActions = [];
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
        appendMessage('err', 'Something went wrong.');
        setLoading(false);
        console.error('[agent]', err);
      });
  }

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
    svg.style.cssText = 'flex-shrink:0;';
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M1.5 5l2.5 2.5 4.5-4.5');
    path.setAttribute('stroke', '#3f3f46');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('fill', 'none');
    svg.appendChild(path);
    bbl.appendChild(svg);
    bbl.appendChild(document.createTextNode(' ' + (description || 'Done')));
    row.appendChild(bbl);
    msgs.appendChild(row);
  }

  function loadHistory() {
    if (!conversationId) return;
    fetch(serverOrigin + '/api/chat/history?siteKey=' + encodeURIComponent(siteKey) + '&conversationId=' + encodeURIComponent(conversationId))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        if (data.messages && data.messages.length > 0) {
          empty.style.display = 'none';
          data.messages.forEach(function (m) {
            if (m.role === 'user') appendMessage('u', m.content);
            else if (m.role === 'assistant') appendMessage('a', m.content);
            else if (m.role === 'actions' && m.actions) {
              m.actions.forEach(function (a) { showCompletedPill(a.description); });
            }
          });
          scrollBottom();
        }
      })
      .catch(function (err) { console.log('[agent] history error:', err); });
  }

  loadHistory();
})();`;
}
