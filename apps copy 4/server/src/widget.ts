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
  var previousSnapshot = null;  // For DOM diff between turns
  var emptyTurnCount = 0;       // For stall detection

  // Compute what changed between DOM snapshots
  function computeDiff(before, after) {
    if (!before) return null;
    var changes = [];

    // URL change
    if (before.page && after.page && before.page.url !== after.page.url) {
      // Extract path without regex (simpler in template string context)
      var beforeParts = before.page.url.split('/').slice(3);
      var afterParts = after.page.url.split('/').slice(3);
      var beforePath = '/' + beforeParts.join('/');
      var afterPath = '/' + afterParts.join('/');
      changes.push('navigated: ' + beforePath + ' -> ' + afterPath);
    }

    // Element changes
    var beforeSet = new Set(before.elements || []);
    var afterSet = new Set(after.elements || []);

    var appeared = [];
    var removed = [];

    (after.elements || []).forEach(function(el) {
      // Check if element starts with [number] (interactive element)
      if (!beforeSet.has(el) && el.charAt(0) === '[' && el.charAt(1) >= '0' && el.charAt(1) <= '9') {
        appeared.push(el.slice(0, 45));
      }
    });

    (before.elements || []).forEach(function(el) {
      // Check if element starts with [number] (interactive element)
      if (!afterSet.has(el) && el.charAt(0) === '[' && el.charAt(1) >= '0' && el.charAt(1) <= '9') {
        removed.push(el.slice(0, 45));
      }
    });

    if (appeared.length > 0) {
      changes.push('appeared: ' + appeared.slice(0, 3).join(', ') +
                   (appeared.length > 3 ? ' +' + (appeared.length - 3) + ' more' : ''));
    }

    if (removed.length > 0) {
      changes.push('removed: ' + removed.slice(0, 2).join(', ') +
                   (removed.length > 2 ? ' +' + (removed.length - 2) + ' more' : ''));
    }

    // New alerts/errors
    (after.elements || []).forEach(function(el) {
      if ((el.startsWith('!err') || el.startsWith('!status') || el.startsWith('!ok')) && !beforeSet.has(el)) {
        changes.push('alert: ' + el);
      }
    });

    return changes.length > 0 ? changes.join('\\n') : 'no visible change';
  }

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
  // WAIT FOR STABLE — smarter stability detection
  // ═══════════════════════════════════════════════════════════════════════════
  function waitForStable(minStable, maxWait, expectNavigation) {
    minStable = minStable || 400;
    maxWait = maxWait || 5000;
    var initialUrl = window.location.href;

    // After navigation, wait longer for new page to fully render
    if (expectNavigation) {
      minStable = Math.max(minStable, 800);
      maxWait = Math.max(maxWait, 7000);
    }

    return new Promise(function(resolve) {
      var start = Date.now();
      var lastChange = Date.now();
      var mutationCount = 0;

      var observer = new MutationObserver(function(mutations) {
        lastChange = Date.now();
        mutationCount += mutations.length;
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });

      // Track fetch requests
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

      // Track XHR too
      var pendingXHR = 0;
      var origXHROpen = XMLHttpRequest.prototype.open;
      var origXHRSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function() {
        return origXHROpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function() {
        var xhr = this;
        pendingXHR++;
        lastChange = Date.now();
        xhr.addEventListener('loadend', function() {
          pendingXHR--;
          lastChange = Date.now();
        });
        return origXHRSend.apply(this, arguments);
      };

      function check() {
        var now = Date.now();

        // URL changed = navigation happened, reset timer
        if (window.location.href !== initialUrl) {
          console.log('[agent] URL changed during wait, resetting stability timer');
          lastChange = Date.now();
          initialUrl = window.location.href;
          mutationCount = 0;
        }

        var timeSinceLastChange = now - lastChange;
        var noPendingRequests = pendingFetches === 0 && pendingXHR === 0;
        var stable = timeSinceLastChange >= minStable && noPendingRequests;
        var timeout = now - start >= maxWait;

        if (stable || timeout) {
          observer.disconnect();
          window.fetch = origFetch;
          XMLHttpRequest.prototype.open = origXHROpen;
          XMLHttpRequest.prototype.send = origXHRSend;
          console.log('[agent] waitForStable:', stable ? 'stable' : 'timeout',
            (now - start) + 'ms,', mutationCount, 'mutations');
          resolve();
        } else {
          setTimeout(check, 100);
        }
      }

      // Start checking after initial delay
      setTimeout(check, expectNavigation ? 300 : 150);
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
  // DOM DISTILLATION — Capture what's actually rendered (like human eyes)
  // Walks TEXT NODES directly - no guessing which tags have content
  // ═══════════════════════════════════════════════════════════════════════════
  function distillDOM() {
    var viewportH = window.innerHeight;
    var viewportW = window.innerWidth;
    var currentUrl = window.location.href;
    var urlChanged = lastUrl !== currentUrl;
    lastUrl = currentUrl;

    elementMap = {};
    var index = 1;
    var lines = [];

    var pageContext = {
      url: currentUrl,
      title: document.title || '',
      urlChanged: urlChanged,
      previousUrl: urlChanged ? lastUrl : null
    };

    // ── Helpers ──────────────────────────────────────────────────────────────
    function inViewport(rect) {
      return rect.bottom > 0 && rect.top < viewportH && rect.right > 0 && rect.left < viewportW;
    }

    function isRendered(el) {
      if (!el || el === host || host.contains(el)) return false;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      var cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (parseFloat(cs.opacity) === 0) return false;
      return true;
    }

    function isInViewport(el) {
      if (!isRendered(el)) return false;
      return inViewport(el.getBoundingClientRect());
    }

    // Get position of a range (for text nodes)
    function getTextNodeRect(textNode) {
      var range = document.createRange();
      range.selectNodeContents(textNode);
      return range.getBoundingClientRect();
    }

    // Get a human-readable label for an element (for off-screen summary)
    function getElementLabel(el) {
      var tag = el.tagName;

      // Headings - return quoted text
      if (tag === 'H1' || tag === 'H2' || tag === 'H3') {
        var hText = (el.textContent || '').trim().slice(0, 30);
        return hText ? '"' + hText + '"' : null;
      }

      // Buttons/links - return text or aria-label
      if (tag === 'BUTTON' || tag === 'A' || el.getAttribute('role') === 'button') {
        var btnText = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 25);
        if (btnText) return '"' + btnText + '"';
        var ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return '"' + ariaLabel.slice(0, 25) + '"';
        return null;
      }

      // Nav/form landmarks
      if (tag === 'NAV' || el.getAttribute('role') === 'navigation') return '[nav]';
      if (tag === 'FORM') {
        var formLabel = el.getAttribute('aria-label') || el.getAttribute('name');
        return formLabel ? '[form: ' + formLabel.slice(0, 15) + ']' : '[form]';
      }

      return null;
    }

    // Get summary of elements above/below viewport (helps LLM know what to scroll to)
    function getOffscreenSummary() {
      var above = [];
      var below = [];

      var LANDMARK_SELECTOR = 'h1, h2, h3, button, a[href], [role="button"], nav, form';
      var landmarks = document.querySelectorAll(LANDMARK_SELECTOR);

      for (var i = 0; i < landmarks.length; i++) {
        var el = landmarks[i];
        if (host.contains(el)) continue;
        if (!isRendered(el)) continue;

        var rect = el.getBoundingClientRect();
        var label = getElementLabel(el);
        if (!label) continue;

        if (rect.bottom < 0) {
          // Above viewport
          if (above.length < 5) above.push(label);
        } else if (rect.top > viewportH) {
          // Below viewport
          if (below.length < 8) below.push(label);
        }
      }

      if (above.length === 0 && below.length === 0) return null;

      return {
        above: above.length > 0 ? above.join(', ') : null,
        below: below.length > 0 ? below.join(', ') : null
      };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // DOCUMENT-ORDER DOM WALK
    // Single pass preserves spatial proximity - text near buttons stays near them
    // ═══════════════════════════════════════════════════════════════════════
    var seenText = {};
    var seenElements = new Set();

    // Interactive element detection
    var INTERACTIVE_TAGS = { BUTTON: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1 };
    var INTERACTIVE_ROLES = { button: 1, link: 1, checkbox: 1, tab: 1, menuitem: 1, switch: 1, combobox: 1 };

    function isInteractive(el) {
      var tag = el.tagName;
      if (INTERACTIVE_TAGS[tag]) return true;
      if (tag === 'A' && el.hasAttribute('href')) return true;
      var role = el.getAttribute('role');
      if (role && INTERACTIVE_ROLES[role]) return true;
      if (el.hasAttribute('onclick')) return true;
      return false;
    }

    // Format text node based on semantic context
    function formatTextNode(parent, text) {
      var parentTag = parent.tagName;
      if (parentTag === 'H1') return '#1"' + text.slice(0, 80) + '"';
      if (parentTag === 'H2') return '#2"' + text.slice(0, 80) + '"';
      if (parentTag === 'H3') return '#3"' + text.slice(0, 60) + '"';
      if (parentTag === 'H4') return '#4"' + text.slice(0, 60) + '"';
      if (parent.getAttribute('role') === 'alert' || parent.closest('[role="alert"]')) {
        return '!err"' + text.slice(0, 80) + '"';
      }
      if (parent.getAttribute('role') === 'status' || parent.closest('[role="status"]')) {
        return '!status"' + text.slice(0, 80) + '"';
      }
      return '>"' + text.slice(0, 100) + '"';
    }

    // Format interactive element with all its metadata
    function formatInteractiveElement(el, idx) {
      var tag = el.tagName;
      var role = el.getAttribute('role');
      var desc = '[' + idx + ']';

      // Tag type
      if (tag === 'BUTTON' || role === 'button') desc += 'btn';
      else if (tag === 'A') desc += 'a';
      else if (tag === 'INPUT') desc += 'input';
      else if (tag === 'TEXTAREA') desc += 'txt';
      else if (tag === 'SELECT') desc += 'sel';
      else desc += tag.toLowerCase();

      // Input type
      if (tag === 'INPUT' && el.type && el.type !== 'text') {
        desc += '[' + el.type + ']';
      }

      // Text/label
      var elText = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
      var label = el.getAttribute('aria-label') || el.getAttribute('title') || el.placeholder;

      if (elText) {
        desc += '"' + elText + '"';
      } else if (label) {
        desc += '"' + label + '"';
      } else if (tag === 'A' && el.href) {
        var path = (el.getAttribute('href') || '').split('?')[0].split('#')[0];
        if (path && path.length < 25) desc += '(->' + path + ')';
      } else if (el.querySelector('img[alt]')) {
        desc += '"' + el.querySelector('img[alt]').alt.slice(0, 25) + '"';
      }

      // Current value
      if ((tag === 'INPUT' || tag === 'TEXTAREA') && el.value) {
        desc += '=' + el.value.slice(0, 20);
      }

      // State flags
      var flags = [];
      if (el.type === 'checkbox' || el.type === 'radio' || role === 'checkbox') {
        flags.push(el.checked ? 'ON' : 'OFF');
      }
      if (el.getAttribute('aria-expanded')) {
        flags.push(el.getAttribute('aria-expanded') === 'true' ? 'open' : 'closed');
      }
      if (el.disabled) flags.push('disabled');
      if (el.required) flags.push('req');
      if (flags.length) desc += '[' + flags.join(',') + ']';

      // Validation
      if (el.validationMessage && !el.checkValidity()) {
        desc += ' !' + el.validationMessage.slice(0, 25);
      }

      // Select options
      if (tag === 'SELECT' && el.options.length) {
        var opts = [];
        for (var o = 0; o < Math.min(el.options.length, 4); o++) {
          var opt = el.options[o];
          opts.push(opt.selected ? '*' + opt.text.slice(0, 10) + '*' : opt.text.slice(0, 10));
        }
        if (el.options.length > 4) opts.push('+' + (el.options.length - 4));
        desc += '(' + opts.join('|') + ')';
      }

      return desc;
    }

    // Single document-order walker for both text and elements
    var walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(node) {
          // Skip our widget entirely
          if (host.contains(node)) return NodeFilter.FILTER_REJECT;

          if (node.nodeType === Node.TEXT_NODE) {
            var text = node.textContent.trim();
            if (!text) return NodeFilter.FILTER_REJECT;
            var parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            var pTag = parent.tagName;
            if (pTag === 'SCRIPT' || pTag === 'STYLE' || pTag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }

          // Element nodes - always accept to walk children
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    var node;
    while ((node = walker.nextNode()) && index <= 60) {
      if (node.nodeType === Node.TEXT_NODE) {
        // Process text node
        var rect = getTextNodeRect(node);
        if (!inViewport(rect)) continue;

        var text = node.textContent.trim();
        if (text.length < 2 || seenText[text]) continue;

        var parent = node.parentElement;
        if (!isRendered(parent)) continue;

        // Skip text inside interactive elements - it gets captured with the element
        if (parent.closest('button, a, input, textarea, select, [role="button"]')) continue;

        seenText[text] = true;
        lines.push(formatTextNode(parent, text));

      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // Process element node
        var el = node;
        if (!isInteractive(el)) continue;
        if (seenElements.has(el)) continue;
        if (!isInViewport(el)) continue;
        if (el.getAttribute('aria-hidden') === 'true') continue;
        if (el.type === 'hidden') continue;

        seenElements.add(el);
        elementMap[index] = buildSelector(el);
        lines.push(formatInteractiveElement(el, index));
        index++;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 3: Images with alt text (visible content)
    // ═══════════════════════════════════════════════════════════════════════
    var images = document.querySelectorAll('img[alt]');
    for (var m = 0; m < images.length; m++) {
      var img = images[m];
      if (!isInViewport(img)) continue;
      var alt = img.alt.trim();
      if (alt && !seenText[alt]) {
        seenText[alt] = true;
        lines.push('[img]"' + alt.slice(0, 40) + '"');
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4: Scroll indicators
    // ═══════════════════════════════════════════════════════════════════════
    var pageCanScrollDown = document.documentElement.scrollHeight - window.scrollY - viewportH > 50;
    var pageCanScrollUp = window.scrollY > 50;
    if (pageCanScrollDown || pageCanScrollUp) {
      var dir = pageCanScrollDown && pageCanScrollUp ? '↕' : (pageCanScrollDown ? '↓' : '↑');
      lines.push('[page]scroll' + dir);
    }

    // Scrollable containers
    var scrollables = document.querySelectorAll('div, section, main, ul, ol');
    for (var s = 0; s < scrollables.length && index <= 65; s++) {
      var container = scrollables[s];
      if (!isInViewport(container)) continue;
      var cs = window.getComputedStyle(container);
      var isScrollable = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
                         container.scrollHeight > container.clientHeight + 50;
      if (isScrollable) {
        var cSelector = buildSelector(container);
        elementMap[index] = cSelector;
        var cDown = container.scrollHeight - container.scrollTop - container.clientHeight > 10;
        var cUp = container.scrollTop > 10;
        var cDir = cDown && cUp ? '↕' : (cDown ? '↓' : '↑');
        lines.push('[' + index + ']scroll' + cDir);
        index++;
        break; // Usually only care about one scrollable container
      }
    }

    return {
      page: pageContext,
      elements: lines,
      offScreen: getOffscreenSummary()
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

  // Debug: Ctrl+Shift+D copies DOM snapshot to clipboard
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      var snapshot = distillDOM();
      var output = '=== AGENT DOM SNAPSHOT ===\\n';
      output += 'URL: ' + snapshot.page.url + '\\n';
      output += 'Title: ' + snapshot.page.title + '\\n';
      if (snapshot.offScreen) {
        if (snapshot.offScreen.above) output += 'Above viewport: ' + snapshot.offScreen.above + '\\n';
        if (snapshot.offScreen.below) output += 'Below viewport: ' + snapshot.offScreen.below + '\\n';
      }
      output += '\\n=== ELEMENTS ===\\n';
      output += snapshot.elements.join('\\n');

      navigator.clipboard.writeText(output).then(function() {
        console.log('[agent] DOM snapshot copied to clipboard (' + snapshot.elements.length + ' elements)');
        // Brief visual feedback
        var notice = document.createElement('div');
        notice.textContent = 'DOM copied! (' + snapshot.elements.length + ' elements)';
        notice.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#10b981;color:white;padding:8px 16px;border-radius:6px;z-index:999999;font:14px system-ui;';
        document.body.appendChild(notice);
        setTimeout(function() { notice.remove(); }, 2000);
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTION EXECUTION
  // ═══════════════════════════════════════════════════════════════════════════

  // Detect if an action will likely cause navigation (page change)
  function willLikelyNavigate(action) {
    if (action.type !== 'click') return false;

    var el = getElementByIndex(action.index);
    if (!el) return false;

    // A tag with real href navigates
    if (el.tagName === 'A') {
      var href = el.getAttribute('href') || '';
      if (href && !href.startsWith('javascript:') && !href.startsWith('#')) return true;
    }

    // Submit button
    if (el.type === 'submit') return true;

    // Default button in form (no type = submit)
    if (el.tagName === 'BUTTON' && el.closest('form') && !el.type) return true;

    // Fallback to description heuristics
    var desc = (action.description || '').toLowerCase();
    return ['submit', 'checkout', 'pay', 'sign in', 'sign up', 'log in', 'delete', 'confirm', 'save'].some(function(w) {
      return desc.includes(w);
    });
  }

  // Filter actions to stop at first navigation-likely action
  function filterActionsForExecution(actions) {
    var execute = [];
    for (var i = 0; i < actions.length; i++) {
      execute.push(actions[i]);
      if (willLikelyNavigate(actions[i])) {
        if (actions.length - i - 1 > 0) {
          console.log('[agent] deferred', (actions.length - i - 1), 'actions after navigation click');
        }
        break;
      }
    }
    return execute;
  }

  function executeActions(actions, onComplete) {
    if (!actions || actions.length === 0) { onComplete([]); return; }

    // First: filter to stop at navigation-likely actions
    var preFiltered = filterActionsForExecution(actions);

    // Duplicate detection
    var filtered = [];
    for (var f = 0; f < preFiltered.length; f++) {
      var actionKey = preFiltered[f].type + ':' + (preFiltered[f].index || '');
      var recentCount = 0;
      for (var c = executedActions.length - 1; c >= Math.max(0, executedActions.length - 6); c--) {
        if (executedActions[c] === actionKey) recentCount++;
      }
      if (recentCount < 2) {
        filtered.push(preFiltered[f]);
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

      // IMPORTANT: Check navigation likelihood BEFORE executing action
      // After click, the element may be gone from DOM
      var mightNavigate = willLikelyNavigate(action);

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

        // mightNavigate was computed BEFORE action (element might be gone now)
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
      emptyTurnCount = 0;  // Reset on actions
      executeActions(actions, function (actionResults) {
        if (data.done) { setLoading(false); loopCount = 0; emptyTurnCount = 0; }
        else           { sendContinuation(actionResults); }
      });
    } else {
      if (data.done) {
        emptyTurnCount = 0;
        setLoading(false);
        loopCount = 0;
      } else if (data.reply) {
        // Message but no actions - agent might be asking a clarifying question
        // Stop and let user respond, don't auto-continue
        emptyTurnCount = 0;
        setLoading(false);
        loopCount = 0;
      } else {
        // No actions and no message - definite stall
        appendMessage('err', 'Agent stalled.');
        setLoading(false);
        loopCount = 0;
        emptyTurnCount = 0;
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

    // Wait for page to stabilize before capturing DOM
    // This prevents sending stale DOM that changes immediately after
    waitForStable(300, 2000, false).then(function() {
      if (stopped) return;

      // Capture new DOM and compute diff from previous
      var currentSnapshot = distillDOM();
      var diff = previousSnapshot ? computeDiff(previousSnapshot, currentSnapshot) : null;
      previousSnapshot = currentSnapshot;

      fetch(serverOrigin + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteKey: siteKey,
          visitorId: visitorId,
          conversationId: conversationId,
          isActionResult: true,
          actionResults: actionResults || [],
          dom: currentSnapshot,
          diff: diff,
          stepCount: loopCount,
          maxSteps: MAX_LOOPS,
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
    emptyTurnCount = 0;
    setLoading(true);
    showTyping();

    // Capture initial snapshot for diff computation in subsequent turns
    var currentSnapshot = distillDOM();
    previousSnapshot = currentSnapshot;

    fetch(serverOrigin + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteKey: siteKey, visitorId: visitorId,
        conversationId: conversationId,
        message: text, dom: currentSnapshot,
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
