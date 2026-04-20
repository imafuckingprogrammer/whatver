/**
 * Embeddable AI agent widget script.
 * Captures DOM, executes actions, handles agent loop.
 */
export function getWidgetScript(): string {
  return `(function () {
  'use strict';

  // ── Locate self ─────────────────────────────────────────────────────────────
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

  // ── Session IDs ─────────────────────────────────────────────────────────────
  var VID_KEY = '_ag_vid_' + siteKey;
  var visitorId = sessionStorage.getItem(VID_KEY);
  if (!visitorId) {
    visitorId = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    sessionStorage.setItem(VID_KEY, visitorId);
  }

  var CID_KEY = '_ag_cid_' + siteKey;
  var conversationId = sessionStorage.getItem(CID_KEY);

  // ── State ───────────────────────────────────────────────────────────────────
  var isOpen = false;
  var isLoading = false;
  var msgCount = 0;
  var loopCount = 0;
  var MAX_LOOPS = 30;
  var lastUrl = window.location.href;
  var elementMap = {};
  var recentActionSigs = []; // Semantic action signatures for loop detection

  // ── Shadow DOM Host ─────────────────────────────────────────────────────────
  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
  document.body.appendChild(host);
  var shadow = host.attachShadow({ mode: 'closed' });

  // ── Page Overlay ────────────────────────────────────────────────────────────
  var agOverlay = document.createElement('div');
  agOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.18);z-index:2147483640;pointer-events:none;opacity:0;transition:opacity .2s;';
  document.body.appendChild(agOverlay);

  function showOverlay() { agOverlay.style.opacity = '1'; }
  function hideOverlay() { agOverlay.style.opacity = '0'; }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAGE CLASSIFICATION — Semantic context for the agent
  // ═══════════════════════════════════════════════════════════════════════════
  function classifyPage() {
    var url = window.location.href.toLowerCase();
    var title = (document.title || '').toLowerCase();
    var path = window.location.pathname.toLowerCase();

    // Check for specific page types
    var hasPassword = !!document.querySelector('input[type="password"]');
    var hasCart = !!document.querySelector('[class*="cart" i], [id*="cart" i], [data-cart], .shopping-cart');
    var hasCheckout = url.includes('checkout') || path.includes('checkout') || title.includes('checkout');
    var hasPayment = !!document.querySelector('[class*="payment" i], [class*="credit-card" i], input[name*="card"]');
    var hasSearch = !!document.querySelector('input[type="search"], [role="search"], input[name*="search" i]');
    var hasForm = document.querySelectorAll('form input, form textarea').length > 2;

    if (hasPayment || hasCheckout) return 'checkout';
    if (hasPassword) return 'auth';
    if (hasCart) return 'cart';
    if (hasSearch && !hasForm) return 'search';
    if (hasForm) return 'form';
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OFF-SCREEN HINTS — What's above/below the viewport (with counts + categories)
  // ═══════════════════════════════════════════════════════════════════════════
  function getOffScreenHints() {
    var viewportH = window.innerHeight;
    var aboveCount = 0;
    var belowCount = 0;
    var belowButtons = 0;
    var belowInputs = 0;
    var belowLinks = 0;
    var belowSamples = [];

    var important = document.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea, h1, h2, [role="button"]');
    for (var i = 0; i < important.length; i++) {
      var el = important[i];
      if (host.contains(el)) continue;
      var rect = el.getBoundingClientRect();
      var tag = el.tagName.toLowerCase();

      if (rect.bottom < 0) {
        aboveCount++;
      } else if (rect.top > viewportH) {
        belowCount++;
        // Categorize
        if (tag === 'button' || el.getAttribute('role') === 'button') belowButtons++;
        else if (tag === 'input' || tag === 'textarea' || tag === 'select') belowInputs++;
        else if (tag === 'a') belowLinks++;

        // Sample first few meaningful items
        if (belowSamples.length < 4) {
          var text = (el.textContent || '').trim().slice(0, 20);
          var label = el.getAttribute('placeholder') || el.getAttribute('aria-label');
          var sample = text || label || null;
          if (sample && belowSamples.indexOf(sample) === -1) {
            belowSamples.push(sample);
          }
        }
      }
    }

    if (aboveCount === 0 && belowCount === 0) return null;

    // Build descriptive summary
    var belowDesc = null;
    if (belowCount > 0) {
      var parts = [];
      if (belowButtons) parts.push(belowButtons + ' btn');
      if (belowInputs) parts.push(belowInputs + ' input');
      if (belowLinks) parts.push(belowLinks + ' link');
      var summary = belowCount + ' elements';
      if (parts.length) summary += ' (' + parts.join(', ') + ')';
      if (belowSamples.length) summary += ': ' + belowSamples.join(', ');
      belowDesc = summary;
    }

    return {
      above: aboveCount || null,
      below: belowDesc ? [belowDesc] : null
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WAIT FOR STABLE — Monitor DOM + network for stability
  // ═══════════════════════════════════════════════════════════════════════════
  function waitForStable(minStable, maxWait) {
    minStable = minStable || 350;
    maxWait = maxWait || 4000;

    return new Promise(function(resolve) {
      var start = Date.now();
      var lastChange = Date.now();
      var pendingRequests = 0;

      // Track DOM mutations
      var observer = new MutationObserver(function() { lastChange = Date.now(); });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });

      // Track fetch requests
      var origFetch = window.fetch;
      window.fetch = function() {
        pendingRequests++;
        lastChange = Date.now();
        return origFetch.apply(this, arguments).finally(function() {
          pendingRequests--;
          lastChange = Date.now();
        });
      };

      // Track XHR requests
      var origXHRSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function() {
        var xhr = this;
        pendingRequests++;
        lastChange = Date.now();
        xhr.addEventListener('loadend', function() {
          pendingRequests--;
          lastChange = Date.now();
        });
        return origXHRSend.apply(this, arguments);
      };

      function cleanup() {
        observer.disconnect();
        window.fetch = origFetch;
        XMLHttpRequest.prototype.send = origXHRSend;
      }

      function check() {
        var now = Date.now();
        var stable = (now - lastChange) >= minStable && pendingRequests === 0;
        var timeout = (now - start) >= maxWait;

        if (stable || timeout) {
          cleanup();
          resolve();
        } else {
          setTimeout(check, 80);
        }
      }
      setTimeout(check, 100);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUILD SELECTOR — Stable selector for element lookup
  // ═══════════════════════════════════════════════════════════════════════════
  function buildSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.getAttribute('name')) return '[name="' + el.getAttribute('name') + '"]';

    var tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') {
      var text = (el.textContent || '').trim();
      if (text && text.length < 40) {
        var matches = document.querySelectorAll(tag + ', [role="button"]');
        var count = 0;
        for (var i = 0; i < matches.length; i++) {
          if ((matches[i].textContent || '').trim() === text) count++;
        }
        if (count === 1) return 'text="' + text + '"';
      }
    }

    if (el.getAttribute('placeholder')) {
      var ph = el.getAttribute('placeholder');
      var inputs = document.querySelectorAll('input, textarea');
      var phCount = 0;
      for (var j = 0; j < inputs.length; j++) {
        if (inputs[j].getAttribute('placeholder') === ph) phCount++;
      }
      if (phCount === 1) return '[placeholder="' + ph + '"]';
    }

    var marker = '_ag_' + Math.random().toString(36).slice(2, 8);
    el.setAttribute('data-ag-id', marker);
    return '[data-ag-id="' + marker + '"]';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DOM DISTILLATION — Capture visible page state
  // ═══════════════════════════════════════════════════════════════════════════
  function distillDOM() {
    var viewportH = window.innerHeight;
    var viewportW = window.innerWidth;
    var currentUrl = window.location.href;
    var urlChanged = lastUrl !== currentUrl;
    var previousUrl = urlChanged ? lastUrl : null;
    lastUrl = currentUrl;

    elementMap = {};
    var index = 1;
    var lines = [];

    var pageContext = {
      url: currentUrl,
      title: document.title || '',
      pageType: classifyPage(),
      urlChanged: urlChanged,
      previousUrl: previousUrl
    };

    function isVisible(el) {
      if (!el || el === host || host.contains(el)) return false;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      var cs = window.getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0;
    }

    function inViewport(el) {
      if (!isVisible(el)) return false;
      var rect = el.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < viewportH && rect.right > 0 && rect.left < viewportW;
    }

    // ── Step 1: Visible text content (richer for mini to parse) ─────────────────
    var seenText = {};
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function(node) {
        if (host.contains(node)) return NodeFilter.FILTER_REJECT;
        var text = node.textContent.trim();
        if (!text) return NodeFilter.FILTER_REJECT;
        var parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        var tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'CODE' || tag === 'PRE') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    var textNode;
    while ((textNode = walker.nextNode())) {
      var parent = textNode.parentElement;
      if (!isVisible(parent)) continue;
      var rect = (function() {
        var r = document.createRange();
        r.selectNodeContents(textNode);
        return r.getBoundingClientRect();
      })();
      if (rect.bottom < 0 || rect.top > viewportH) continue;

      var text = textNode.textContent.trim();
      if (text.length < 2 || seenText[text]) continue;
      if (parent.closest('button, a, input, textarea, select, [role="button"]')) continue;

      seenText[text] = true;
      var parentTag = parent.tagName;
      var role = parent.getAttribute('role');
      var section = parent.closest('header, nav, main, footer, aside, section, article, form');
      var sectionHint = section ? '(' + section.tagName.toLowerCase() + ')' : '';

      // Richer format: tag + role + section context + longer text
      if (parentTag === 'H1') lines.push('h1' + sectionHint + ':"' + text.slice(0, 100) + '"');
      else if (parentTag === 'H2') lines.push('h2' + sectionHint + ':"' + text.slice(0, 80) + '"');
      else if (parentTag === 'H3') lines.push('h3' + sectionHint + ':"' + text.slice(0, 60) + '"');
      else if (role === 'alert' || parent.closest('[role="alert"]')) {
        lines.push('alert:"' + text.slice(0, 100) + '"');
      } else if (parent.classList.contains('error') || parent.closest('.error, [class*="error"]')) {
        lines.push('error:"' + text.slice(0, 100) + '"');
      } else if (parent.classList.contains('success') || parent.closest('.success, [class*="success"]')) {
        lines.push('success:"' + text.slice(0, 100) + '"');
      } else if (parentTag === 'P') {
        lines.push('p' + sectionHint + ':"' + text.slice(0, 150) + '"');
      } else if (parentTag === 'LI') {
        lines.push('li:"' + text.slice(0, 100) + '"');
      } else if (parentTag === 'LABEL') {
        lines.push('label:"' + text.slice(0, 60) + '"');
      } else if (parentTag === 'SPAN' || parentTag === 'DIV') {
        // Include class hints for ambiguous elements
        var cls = (parent.className || '').toString().slice(0, 30);
        var hint = cls ? '{' + cls + '}' : '';
        lines.push('text' + hint + ':"' + text.slice(0, 120) + '"');
      } else {
        lines.push('text:"' + text.slice(0, 120) + '"');
      }
    }

    // ── Step 2: Interactive elements (richer for mini) ─────────────────────────
    var INTERACTIVE = 'button, a[href], input:not([type="hidden"]), textarea, select, ' +
                      '[role="button"], [role="link"], [role="checkbox"], [role="tab"], ' +
                      '[role="menuitem"], [role="switch"], [role="combobox"], [onclick]';

    var interactives = document.querySelectorAll(INTERACTIVE);
    for (var i = 0; i < interactives.length && index <= 120; i++) {
      var el = interactives[i];
      if (!inViewport(el)) continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;

      var tag = el.tagName;
      var role = el.getAttribute('role');
      elementMap[index] = buildSelector(el);

      // Find parent context (form, nav, header, card, etc.)
      var parentSection = el.closest('form, nav, header, footer, aside, [class*="card"], [class*="modal"], [class*="dialog"], [class*="menu"], [class*="dropdown"]');
      var parentHint = '';
      if (parentSection) {
        var pTag = parentSection.tagName.toLowerCase();
        var pClass = (parentSection.className || '').toString().split(' ')[0];
        parentHint = '(' + (pClass || pTag) + ')';
      }

      var desc = '[' + index + ']';

      // Type with more specificity
      if (tag === 'BUTTON') {
        var btnType = el.type || 'button';
        desc += 'button';
        if (btnType === 'submit') desc += '[submit]';
      } else if (role === 'button') {
        desc += tag.toLowerCase() + '[role=button]';
      } else if (tag === 'A') {
        desc += 'link';
      } else if (tag === 'INPUT') {
        var inputType = el.type || 'text';
        desc += 'input[' + inputType + ']';
      } else if (tag === 'TEXTAREA') {
        desc += 'textarea';
      } else if (tag === 'SELECT') {
        desc += 'select';
      } else {
        desc += tag.toLowerCase();
        if (role) desc += '[role=' + role + ']';
      }

      // Add parent context
      desc += parentHint;

      // Label - be more generous with length
      var elText = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 50);
      var ariaLabel = el.getAttribute('aria-label');
      var title = el.getAttribute('title');
      var placeholder = el.placeholder;
      var name = el.getAttribute('name');

      if (elText) desc += ' "' + elText + '"';
      else if (ariaLabel) desc += ' aria:"' + ariaLabel + '"';
      else if (title) desc += ' title:"' + title + '"';
      else if (placeholder) desc += ' placeholder:"' + placeholder + '"';
      else if (name) desc += ' name:' + name;
      else if (tag === 'A' && el.href) {
        var path = (el.getAttribute('href') || '').split('?')[0].split('#')[0];
        desc += ' href:"' + path.slice(0, 30) + '"';
      }

      // Current value (longer)
      if ((tag === 'INPUT' || tag === 'TEXTAREA') && el.value) {
        desc += ' value="' + el.value.slice(0, 30) + '"';
      }

      // State flags - more verbose
      var flags = [];
      if (el.type === 'checkbox' || el.type === 'radio' || role === 'checkbox') {
        flags.push(el.checked ? 'checked' : 'unchecked');
      }
      if (el.getAttribute('aria-expanded')) {
        flags.push(el.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed');
      }
      if (el.getAttribute('aria-selected') === 'true') flags.push('selected');
      if (el.getAttribute('aria-current')) flags.push('current');
      if (el.disabled) flags.push('disabled');
      if (el.required) flags.push('required');
      if (el.readOnly) flags.push('readonly');
      if (flags.length) desc += ' [' + flags.join(', ') + ']';

      // Validation error
      if (el.validationMessage && !el.checkValidity()) {
        desc += ' ERROR:"' + el.validationMessage.slice(0, 30) + '"';
      }

      // Select options (more)
      if (tag === 'SELECT' && el.options.length) {
        var opts = [];
        for (var o = 0; o < Math.min(el.options.length, 6); o++) {
          var opt = el.options[o];
          opts.push(opt.selected ? '*' + opt.text.slice(0, 15) + '*' : opt.text.slice(0, 15));
        }
        if (el.options.length > 6) opts.push('..+' + (el.options.length - 6) + ' more');
        desc += ' options:(' + opts.join(' | ') + ')';
      }

      lines.push(desc);
      index++;
    }

    // ── Step 3: Scroll indicators ─────────────────────────────────────────────
    var canScrollDown = document.documentElement.scrollHeight - window.scrollY - viewportH > 50;
    var canScrollUp = window.scrollY > 50;
    if (canScrollDown || canScrollUp) {
      var dir = canScrollDown && canScrollUp ? '↕' : (canScrollDown ? '↓' : '↑');
      lines.push('[page]scroll' + dir);
    }

    return {
      page: pageContext,
      elements: lines,
      offScreen: getOffScreenHints()
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTION EXECUTION
  // ═══════════════════════════════════════════════════════════════════════════

  function findEl(selector) {
    if (!selector) return null;
    var textMatch = selector.match(/^text=["'](.+)["']$/);
    if (textMatch) {
      var searchText = textMatch[1];
      var els = document.querySelectorAll('button, a, [role="button"], input[type="submit"]');
      for (var i = 0; i < els.length; i++) {
        if ((els[i].textContent || '').trim() === searchText) return els[i];
      }
      return null;
    }
    try { return document.querySelector(selector); } catch (e) { return null; }
  }

  function getEl(idx) {
    var selector = elementMap[idx];
    if (!selector) return null;
    return findEl(selector);
  }

  // Get semantic label for an element (for loop detection + hints)
  function getElLabel(el) {
    if (!el) return 'unknown';
    var text = (el.textContent || '').trim().slice(0, 25);
    var label = el.getAttribute('aria-label') || el.getAttribute('title') || el.placeholder;
    var tag = el.tagName.toLowerCase();
    if (text) return tag + ' "' + text + '"';
    if (label) return tag + ' "' + label + '"';
    return tag;
  }

  function clickElement(idx) {
    var el = getEl(idx);
    if (!el) {
      // Build helpful context about what IS available
      var availableEls = [];
      for (var k in elementMap) {
        if (availableEls.length >= 5) break;
        var found = findEl(elementMap[k]);
        if (found) availableEls.push('[' + k + ']' + getElLabel(found));
      }
      var hint = availableEls.length
        ? 'Page changed. Now visible: ' + availableEls.join(', ')
        : 'No elements found. Page may still be loading.';
      return { success: false, error: 'element ' + idx + ' gone', hint: hint };
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus();
    el.click();
    return { success: true, label: getElLabel(el) };
  }

  function typeInElement(idx, text) {
    var el = getEl(idx);
    if (!el) {
      return {
        success: false,
        error: 'element ' + idx + ' not found',
        hint: 'Input field gone. Page may have changed.'
      };
    }

    el.focus();

    if (el.tagName.toLowerCase() === 'select') {
      var options = el.options;
      var lowerText = text.toLowerCase();
      for (var i = 0; i < options.length; i++) {
        if (options[i].value === text || options[i].text.toLowerCase().indexOf(lowerText) !== -1) {
          el.selectedIndex = i;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true };
        }
      }
      var availOpts = [];
      for (var j = 0; j < Math.min(options.length, 5); j++) {
        availOpts.push(options[j].text);
      }
      return {
        success: false,
        error: 'option "' + text + '" not found',
        hint: 'Available: ' + availOpts.join(', ')
      };
    }

    if (el.disabled) {
      return { success: false, error: 'element is disabled', hint: 'Find an enabled input.' };
    }

    if (el.readOnly) {
      return { success: false, error: 'element is read-only', hint: 'This field cannot be edited.' };
    }

    var proto = el.tagName.toLowerCase() === 'textarea'
      ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true };
  }

  function hoverElement(idx) {
    var el = getEl(idx);
    if (!el) return { success: false, error: 'element ' + idx + ' not found' };
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return { success: true };
  }

  function scrollPage(direction) {
    window.scrollBy({ top: (direction === 'down' ? 1 : -1) * window.innerHeight * 0.7, behavior: 'smooth' });
    return { success: true };
  }

  function scrollToElement(idx) {
    var el = getEl(idx);
    if (!el) return { success: false, error: 'element ' + idx + ' not found' };
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return { success: true };
  }

  function highlightEl(idx) {
    var el = getEl(idx);
    if (!el) return;
    var prev = el.style.outline;
    el.style.outline = '2px solid rgba(139,92,246,.8)';
    el.style.outlineOffset = '2px';
    setTimeout(function() {
      el.style.outline = prev;
      el.style.outlineOffset = '';
    }, 800);
  }

  // Expose for debugging
  window.__agentActions = { clickElement, typeInElement, scrollPage, scrollToElement, hoverElement, distillDOM, getEl };

  // Debug: show raw DOM and parsed DOM side by side
  window.__agentDebug = function() {
    var dom = distillDOM();
    console.log('\\n[debug] ═══════════════════════════════════════════════════════');
    console.log('[debug] RAW DOM (' + dom.elements.length + ' elements):');
    console.log(JSON.stringify(dom, null, 2));

    // Call parser endpoint to see what GPT-4o-mini returns
    fetch(serverOrigin + '/api/debug-parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        elements: dom.elements,
        url: dom.page?.url,
        title: dom.page?.title
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      console.log('\\n[debug] PARSED DOM (what GPT-4o sees):');
      console.log(JSON.stringify(data.parsed, null, 2));
      console.log('[debug] ═══════════════════════════════════════════════════════\\n');

      // Copy both to clipboard
      var combined = {
        raw: dom,
        parsed: data.parsed
      };
      navigator.clipboard.writeText(JSON.stringify(combined, null, 2)).then(function() {
        console.log('[debug] Both raw + parsed copied to clipboard');
      });
    })
    .catch(function(err) {
      console.error('[debug] Parser error:', err);
    });

    return dom;
  };

  // ── CSS ─────────────────────────────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = \`
    *{box-sizing:border-box;margin:0;padding:0}
    .btn{width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;background:#18181b;border:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(0,0,0,0.5);position:relative;z-index:2;transition:all .15s}
    .btn:hover{background:#222;box-shadow:0 6px 28px rgba(0,0,0,0.6)}
    .btn:active{transform:scale(0.93)}
    .btn .ic{position:absolute;transition:all .18s}
    .btn .ic-chat{opacity:1;transform:scale(1)}
    .btn .ic-close{opacity:0;transform:scale(0.5) rotate(-60deg)}
    .btn.open .ic-chat{opacity:0;transform:scale(0.5) rotate(60deg)}
    .btn.open .ic-close{opacity:1;transform:scale(1) rotate(0)}
    .panel{position:absolute;bottom:64px;right:0;width:368px;height:540px;background:#0c0c0e;border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;box-shadow:0 16px 64px rgba(0,0,0,0.7);display:flex;flex-direction:column;opacity:0;transform:translateY(12px) scale(0.96);pointer-events:none;transition:all .22s cubic-bezier(.16,1,.3,1)}
    .panel.open{opacity:1;transform:translateY(0) scale(1);pointer-events:all}
    .hdr{padding:14px 16px;flex-shrink:0;background:#111114;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:10px}
    .hdr-dot{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 7px rgba(34,197,94,.55)}
    .hdr-name{color:#f4f4f5;font-size:13px;font-weight:500}
    .hdr-status{color:#52525b;font-size:11px;margin-left:auto}
    .msgs{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:8px}
    .msgs::-webkit-scrollbar{width:3px}
    .msgs::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:3px}
    .empty{flex:1;display:flex;align-items:center;justify-content:center}
    .empty p{color:#3f3f46;font-size:13px}
    .msg{display:flex;flex-direction:column;max-width:82%;animation:fi .16s ease}
    @keyframes fi{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
    .msg.u{align-self:flex-end;align-items:flex-end}
    .msg.a{align-self:flex-start;align-items:flex-start}
    .msg.err{align-self:center}
    .msg.act{align-self:flex-start;max-width:90%}
    .msg.act .bbl{display:flex;align-items:center;gap:5px;background:rgba(255,255,255,0.02);color:#71717a;font-size:11.5px;padding:4px 10px;border-radius:20px;border:1px solid rgba(255,255,255,0.05)}
    .msg.act.done .bbl{color:#3f3f46}
    .spin{width:10px;height:10px;border-radius:50%;border:1.5px solid rgba(255,255,255,0.08);border-top-color:#52525b;animation:rot .65s linear infinite}
    @keyframes rot{to{transform:rotate(360deg)}}
    .bbl{padding:9px 13px;font-size:13px;line-height:1.55;word-break:break-word;white-space:pre-wrap;color:#e4e4e7}
    .msg.u .bbl{background:#27272a;border:1px solid rgba(255,255,255,0.07);border-radius:13px 13px 3px 13px}
    .msg.a .bbl{background:#18181b;border:1px solid rgba(255,255,255,0.06);border-radius:13px 13px 13px 3px}
    .msg.err .bbl{background:transparent;color:#71717a;font-size:12px;padding:2px 0}
    .typing{align-self:flex-start}
    .typing .bbl{display:flex;gap:4px;align-items:center;padding:12px 16px}
    .dot{width:5px;height:5px;border-radius:50%;background:#3f3f46;animation:bns 1.2s ease infinite}
    .dot:nth-child(2){animation-delay:.15s}
    .dot:nth-child(3){animation-delay:.3s}
    @keyframes bns{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-5px)}}
    .ftr{padding:10px 12px;flex-shrink:0;background:#0c0c0e;border-top:1px solid rgba(255,255,255,0.06);display:flex;gap:8px;align-items:flex-end}
    .inp{flex:1;background:#18181b;border:1px solid rgba(255,255,255,0.09);border-radius:10px;padding:9px 12px;color:#e4e4e7;font-size:13px;font-family:inherit;line-height:1.45;outline:none;resize:none;min-height:38px;max-height:120px;overflow-y:auto;transition:border-color .15s}
    .inp::placeholder{color:#3f3f46}
    .inp:focus{border-color:rgba(255,255,255,0.18)}
    .snd{width:36px;height:36px;flex-shrink:0;border:none;border-radius:9px;cursor:pointer;background:#e4e4e7;display:flex;align-items:center;justify-content:center;transition:all .14s}
    .snd:hover:not(:disabled){background:#fff}
    .snd:active:not(:disabled){transform:scale(0.91)}
    .snd:disabled{background:#27272a;cursor:default}
    .snd:disabled path{fill:#52525b}
    .stop{display:none;width:36px;height:36px;flex-shrink:0;border:none;border-radius:9px;cursor:pointer;background:#dc2626;align-items:center;justify-content:center;transition:all .14s}
    .stop.show{display:flex}
    .stop:hover{background:#b91c1c}
    .stop:active{transform:scale(0.91)}
  \`;
  shadow.appendChild(style);

  // ── Markup ──────────────────────────────────────────────────────────────────
  var wrap = document.createElement('div');
  wrap.innerHTML = \`
    <button class="btn" id="btn" aria-label="Open chat">
      <svg class="ic ic-chat" width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="#a1a1aa" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/>
      </svg>
      <svg class="ic ic-close" width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M18 6 6 18M6 6l12 12" stroke="#a1a1aa" stroke-width="2" stroke-linecap="round"/>
      </svg>
    </button>
    <div class="panel" id="panel" role="dialog" aria-label="Chat">
      <div class="hdr">
        <div class="hdr-dot"></div>
        <span class="hdr-name">Agent</span>
        <span class="hdr-status">Online</span>
      </div>
      <div class="msgs" id="msgs">
        <div class="empty" id="empty"><p>How can I help?</p></div>
      </div>
      <div class="ftr">
        <textarea class="inp" id="inp" placeholder="Message..." rows="1"></textarea>
        <button class="snd" id="snd" disabled aria-label="Send">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" stroke="#09090b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="stop" id="stop" aria-label="Stop">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <rect x="4" y="4" width="16" height="16" rx="2" fill="#fff"/>
          </svg>
        </button>
      </div>
    </div>
  \`;
  shadow.appendChild(wrap);

  var btn = shadow.getElementById('btn');
  var panel = shadow.getElementById('panel');
  var msgs = shadow.getElementById('msgs');
  var inp = shadow.getElementById('inp');
  var snd = shadow.getElementById('snd');
  var stop = shadow.getElementById('stop');
  var empty = shadow.getElementById('empty');
  var stopped = false;

  // ── UI Helpers ──────────────────────────────────────────────────────────────
  function scrollBottom() { msgs.scrollTop = msgs.scrollHeight; }

  function setLoading(on) {
    isLoading = on;
    snd.disabled = on || inp.value.trim() === '';
    stop.classList.toggle('show', on);
    if (!on) stopped = false;
  }

  stop.addEventListener('click', function() {
    stopped = true;
    removeTyping();
    hideOverlay();
    appendMessage('err', 'Stopped.');
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
    row.className = 'msg typing';
    row.id = '_typing';
    row.innerHTML = '<div class="bbl"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
    msgs.appendChild(row);
    scrollBottom();
  }

  function removeTyping() {
    var t = shadow.getElementById('_typing');
    if (t) t.remove();
  }

  function showActionPill(desc) {
    if (msgCount === 0) empty.style.display = 'none';
    msgCount++;
    var row = document.createElement('div');
    row.className = 'msg act';
    row.innerHTML = '<div class="bbl"><div class="spin"></div> ' + (desc || 'Acting...') + '</div>';
    msgs.appendChild(row);
    scrollBottom();
    return row;
  }

  function resolveActionPill(row, desc) {
    row.classList.add('done');
    var bbl = row.querySelector('.bbl');
    if (bbl) {
      bbl.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" style="flex-shrink:0"><path d="M1.5 5l2.5 2.5 4.5-4.5" stroke="#3f3f46" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg> ' + (desc || 'Done');
    }
  }

  function toggle() {
    isOpen = !isOpen;
    btn.classList.toggle('open', isOpen);
    panel.classList.toggle('open', isOpen);
    if (isOpen) setTimeout(function() { inp.focus(); }, 200);
  }

  btn.addEventListener('click', toggle);
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && isOpen) toggle();
    // Ctrl+Shift+D = debug DOM (shows raw + parsed)
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      window.__agentDebug();
      console.log('[debug] Fetching parsed DOM from server...');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTION EXECUTION LOOP (with semantic loop detection)
  // ═══════════════════════════════════════════════════════════════════════════
  function executeActions(actions, onComplete) {
    if (!actions || actions.length === 0) { onComplete([]); return; }

    showOverlay();
    var idx = 0;
    var results = [];
    var startUrl = window.location.href;

    function next() {
      if (stopped) { hideOverlay(); return; }

      // If URL changed mid-execution, stop and report
      if (window.location.href !== startUrl) {
        hideOverlay();
        waitForStable(400, 3000).then(function() { onComplete(results); });
        return;
      }

      if (idx >= actions.length) {
        hideOverlay();
        waitForStable(300, 2000).then(function() { onComplete(results); });
        return;
      }

      var action = actions[idx++];
      var pill = showActionPill(action.type + (action.index ? ' #' + action.index : ''));
      if (action.index) highlightEl(action.index);

      setTimeout(function() {
        var result = { type: action.type, index: action.index, success: false, error: null, hint: null };
        var actionLabel = null;

        try {
          if (action.type === 'click') {
            var r = clickElement(action.index);
            result.success = r.success;
            result.error = r.error;
            result.hint = r.hint;
            actionLabel = r.label; // semantic label for loop detection
          } else if (action.type === 'type') {
            var el = getEl(action.index);
            actionLabel = el ? getElLabel(el) : null;
            var r = typeInElement(action.index, action.text || '');
            result.success = r.success;
            result.error = r.error;
          } else if (action.type === 'scroll') {
            if (action.index) {
              var r = scrollToElement(action.index);
              result.success = r.success;
              result.error = r.error;
            } else {
              scrollPage(action.direction || 'down');
              result.success = true;
            }
            actionLabel = 'scroll ' + (action.direction || action.index || 'page');
          } else if (action.type === 'hover') {
            var el = getEl(action.index);
            actionLabel = el ? getElLabel(el) : null;
            var r = hoverElement(action.index);
            result.success = r.success;
            result.error = r.error;
          } else if (action.type === 'wait') {
            var ms = Math.min(action.ms || 500, 3000);
            result.success = true;
            results.push(result);
            resolveActionPill(pill, 'waited ' + ms + 'ms');
            setTimeout(next, ms);
            return;
          }
        } catch (e) {
          result.error = e.message || 'error';
        }

        // Semantic loop detection: track action signatures
        if (actionLabel && result.success) {
          var sig = action.type + ':' + actionLabel;
          recentActionSigs.push(sig);
          if (recentActionSigs.length > 12) recentActionSigs.shift();

          // Check for semantic loops (same action 3+ times)
          var sigCount = recentActionSigs.filter(function(s) { return s === sig; }).length;
          if (sigCount >= 3) {
            result.hint = (result.hint || '') + ' [Loop detected: repeated ' + sigCount + 'x]';
          }
        }

        results.push(result);
        resolveActionPill(pill, action.type + (result.success ? '' : ' failed'));
        waitForStable(200, 1500).then(next);
      }, 50);
    }

    next();
  }

  // ── Response Handler ────────────────────────────────────────────────────────
  function handleResponse(data) {
    removeTyping();

    if (data.conversationId) {
      conversationId = data.conversationId;
      sessionStorage.setItem(CID_KEY, conversationId);
    }

    if (data.reply) appendMessage('a', data.reply);

    var actions = data.actions || [];

    if (actions.length > 0) {
      executeActions(actions, function(results) {
        if (data.done) {
          setLoading(false);
          loopCount = 0;
        } else {
          sendContinuation(results);
        }
      });
    } else {
      if (data.done) {
        setLoading(false);
        loopCount = 0;
      } else if (data.reply) {
        // Agent said something but no actions - maybe asking for clarification
        setLoading(false);
        loopCount = 0;
      } else {
        appendMessage('err', 'Agent stalled.');
        setLoading(false);
        loopCount = 0;
      }
    }
  }

  function sendContinuation(actionResults) {
    if (stopped) return;

    loopCount++;
    if (loopCount > MAX_LOOPS) {
      appendMessage('err', 'Taking too long — stopped after ' + MAX_LOOPS + ' turns.');
      setLoading(false);
      loopCount = 0;
      return;
    }

    showTyping();

    waitForStable(250, 2000).then(function() {
      if (stopped) return;

      fetch(serverOrigin + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteKey: siteKey,
          visitorId: visitorId,
          conversationId: conversationId,
          isActionResult: true,
          actionResults: actionResults || [],
          dom: distillDOM()
        })
      })
      .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(handleResponse)
      .catch(function(err) {
        removeTyping();
        appendMessage('err', 'Connection error.');
        setLoading(false);
        loopCount = 0;
        console.error('[agent]', err);
      });
    });
  }

  // ── Send Message ────────────────────────────────────────────────────────────
  inp.addEventListener('input', function() {
    inp.style.height = 'auto';
    inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
    snd.disabled = isLoading || inp.value.trim() === '';
  });

  inp.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!snd.disabled) send();
    }
  });

  snd.addEventListener('click', send);

  function send() {
    var text = inp.value.trim();
    if (!text || isLoading) return;

    appendMessage('u', text);
    inp.value = '';
    inp.style.height = 'auto';
    loopCount = 0;
    recentActionSigs = []; // Reset loop detection for new task
    setLoading(true);
    showTyping();

    fetch(serverOrigin + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteKey: siteKey,
        visitorId: visitorId,
        conversationId: conversationId,
        message: text,
        dom: distillDOM(),
        isActionResult: false
      })
    })
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(handleResponse)
    .catch(function(err) {
      removeTyping();
      appendMessage('err', 'Connection error.');
      setLoading(false);
      console.error('[agent]', err);
    });
  }

  // ── Load History ────────────────────────────────────────────────────────────
  function loadHistory() {
    if (!conversationId) return;
    fetch(serverOrigin + '/api/chat/history?siteKey=' + encodeURIComponent(siteKey) + '&conversationId=' + encodeURIComponent(conversationId))
      .then(function(r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function(data) {
        if (data.messages && data.messages.length > 0) {
          empty.style.display = 'none';
          data.messages.forEach(function(m) {
            if (m.role === 'user') appendMessage('u', m.content);
            else if (m.role === 'assistant') appendMessage('a', m.content);
          });
          scrollBottom();
        }
      })
      .catch(function() {});
  }

  loadHistory();
})();`;
}
