/**
 * Embeddable AI Agent Widget
 *
 * Architecture:
 * 1. DOM Extractor (distillDOM) — extracts interactive elements into compact format
 * 2. Agent Loop — extract → call API → execute action → observe → repeat
 *
 * Key principles:
 * - DOM only sent in current turn, never stored in history
 * - Actions always have descriptions
 * - waitForStable cleans up on ALL exit paths
 * - Max 10 turns per task
 */
export function getWidgetScript(): string {
  return `(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════════

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

  // Session-scoped IDs
  var VID_KEY = '_ag_vid_' + siteKey;
  var CID_KEY = '_ag_cid_' + siteKey;
  var visitorId = sessionStorage.getItem(VID_KEY);
  if (!visitorId) {
    visitorId = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    sessionStorage.setItem(VID_KEY, visitorId);
  }
  var conversationId = sessionStorage.getItem(CID_KEY);

  // ═══════════════════════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════════════════════

  var isOpen = false;
  var isRunning = false;
  var stopped = false;
  var turn = 0;
  var MAX_TURNS = 10;
  var elementMap = {}; // index -> selector

  // ═══════════════════════════════════════════════════════════════════════════════
  // SHADOW DOM HOST
  // ═══════════════════════════════════════════════════════════════════════════════

  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
  document.body.appendChild(host);
  var shadow = host.attachShadow({ mode: 'closed' });

  // Page overlay (dims page during actions)
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.15);z-index:2147483640;pointer-events:none;opacity:0;transition:opacity .2s;';
  document.body.appendChild(overlay);

  function showOverlay() { overlay.style.opacity = '1'; }
  function hideOverlay() { overlay.style.opacity = '0'; }

  // ═══════════════════════════════════════════════════════════════════════════════
  // WAIT FOR STABLE — with proper cleanup on ALL paths
  // ═══════════════════════════════════════════════════════════════════════════════

  function waitForStable(minStable, maxWait) {
    minStable = minStable || 400;
    maxWait = maxWait || 4000;

    return new Promise(function(resolve) {
      var start = Date.now();
      var lastChange = Date.now();
      var observer = null;
      var origFetch = window.fetch;
      var origXHRSend = XMLHttpRequest.prototype.send;
      var pendingRequests = 0;

      // Cleanup function — MUST be called on every exit path
      function cleanup() {
        if (observer) observer.disconnect();
        window.fetch = origFetch;
        XMLHttpRequest.prototype.send = origXHRSend;
      }

      // Mutation observer
      observer = new MutationObserver(function() {
        lastChange = Date.now();
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });

      // Patch fetch
      window.fetch = function() {
        pendingRequests++;
        lastChange = Date.now();
        return origFetch.apply(this, arguments).finally(function() {
          pendingRequests--;
          lastChange = Date.now();
        });
      };

      // Patch XHR
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

      function check() {
        // Stopped by user — cleanup and exit
        if (stopped) {
          cleanup();
          resolve();
          return;
        }

        var now = Date.now();
        var stable = (now - lastChange >= minStable) && (pendingRequests === 0);
        var timeout = (now - start >= maxWait);

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

  // ═══════════════════════════════════════════════════════════════════════════════
  // BUILD SELECTOR — fallback chain: id → name → text → placeholder → marker
  // ═══════════════════════════════════════════════════════════════════════════════

  function buildSelector(el) {
    // 1. ID
    if (el.id) return '#' + CSS.escape(el.id);

    // 2. Name attribute
    var name = el.getAttribute('name');
    if (name) return '[name="' + name + '"]';

    // 3. Unique text for buttons/links
    var tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') {
      var text = (el.textContent || '').trim();
      if (text && text.length < 50) {
        var matches = document.querySelectorAll(tag + ', [role="button"]');
        var count = 0;
        for (var i = 0; i < matches.length; i++) {
          if ((matches[i].textContent || '').trim() === text) count++;
        }
        if (count === 1) return 'text="' + text + '"';
      }
    }

    // 4. Unique placeholder
    var ph = el.getAttribute('placeholder');
    if (ph) {
      var inputs = document.querySelectorAll('input, textarea');
      var phCount = 0;
      for (var j = 0; j < inputs.length; j++) {
        if (inputs[j].getAttribute('placeholder') === ph) phCount++;
      }
      if (phCount === 1) return '[placeholder="' + ph + '"]';
    }

    // 5. Data marker (fallback)
    var marker = '_ag_' + Math.random().toString(36).slice(2, 8);
    el.setAttribute('data-ag-id', marker);
    return '[data-ag-id="' + marker + '"]';
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // DOM DISTILLATION — viewport-filtered, compact format
  // ═══════════════════════════════════════════════════════════════════════════════

  function distillDOM() {
    var viewportH = window.innerHeight;
    var viewportW = window.innerWidth;
    elementMap = {};
    var index = 1;
    var lines = [];

    function inViewport(rect) {
      return rect.bottom > 0 && rect.top < viewportH && rect.right > 0 && rect.left < viewportW;
    }

    function isVisible(el) {
      if (!el || el === host || host.contains(el)) return false;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      var cs = window.getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0;
    }

    // Walk text nodes for visible text
    var seenText = {};
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function(node) {
        if (host.contains(node)) return NodeFilter.FILTER_REJECT;
        var text = node.textContent.trim();
        if (!text) return NodeFilter.FILTER_REJECT;
        var parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        var tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    var textNode;
    while ((textNode = walker.nextNode())) {
      var range = document.createRange();
      range.selectNodeContents(textNode);
      var rect = range.getBoundingClientRect();
      if (!inViewport(rect)) continue;

      var text = textNode.textContent.trim();
      if (text.length < 2 || seenText[text]) continue;

      var parent = textNode.parentElement;
      if (!isVisible(parent)) continue;
      if (parent.closest('button, a, input, textarea, select, [role="button"]')) continue;

      seenText[text] = true;
      var ptag = parent.tagName;

      if (ptag === 'H1') lines.push('#1"' + text.slice(0, 60) + '"');
      else if (ptag === 'H2') lines.push('#2"' + text.slice(0, 50) + '"');
      else if (ptag === 'H3') lines.push('#3"' + text.slice(0, 40) + '"');
      else lines.push('>"' + text.slice(0, 80) + '"');
    }

    // Interactive elements
    var INTERACTIVE = 'button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [onclick]';
    var interactives = document.querySelectorAll(INTERACTIVE);

    for (var i = 0; i < interactives.length && index <= 50; i++) {
      var el = interactives[i];
      if (!isVisible(el)) continue;
      var elRect = el.getBoundingClientRect();
      if (!inViewport(elRect)) continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;

      var selector = buildSelector(el);
      elementMap[index] = selector;

      var desc = '[' + index + ']';
      var etag = el.tagName;
      var role = el.getAttribute('role');

      // Tag
      if (etag === 'BUTTON' || role === 'button') desc += 'btn';
      else if (etag === 'A') desc += 'a';
      else if (etag === 'INPUT') desc += 'input';
      else if (etag === 'TEXTAREA') desc += 'txt';
      else if (etag === 'SELECT') desc += 'sel';
      else desc += etag.toLowerCase();

      // Input type
      if (etag === 'INPUT' && el.type && el.type !== 'text') {
        desc += '[' + el.type + ']';
      }

      // Label/text
      var elText = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 35);
      var label = el.getAttribute('aria-label') || el.getAttribute('title') || el.placeholder;
      if (elText) desc += '"' + elText + '"';
      else if (label) desc += '"' + label + '"';

      // Value
      if ((etag === 'INPUT' || etag === 'TEXTAREA') && el.value) {
        desc += '=' + el.value.slice(0, 15);
      }

      // Flags
      var flags = [];
      if (el.type === 'checkbox' || el.type === 'radio') flags.push(el.checked ? 'ON' : 'OFF');
      if (el.disabled) flags.push('disabled');
      if (el.required) flags.push('req');
      if (flags.length) desc += '[' + flags.join(',') + ']';

      lines.push(desc);
      index++;
    }

    // Scroll indicator
    var canScrollDown = document.documentElement.scrollHeight - window.scrollY - viewportH > 50;
    var canScrollUp = window.scrollY > 50;
    if (canScrollDown || canScrollUp) {
      var dir = canScrollDown && canScrollUp ? '↕' : (canScrollDown ? '↓' : '↑');
      lines.push('[page]scroll' + dir);
    }

    return {
      url: window.location.href,
      title: document.title || '',
      elements: lines
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // ACTION EXECUTORS
  // ═══════════════════════════════════════════════════════════════════════════════

  function findElement(selector) {
    if (!selector) return null;

    // Handle text="..." selector
    var textMatch = selector.match(/^text="(.+)"$/);
    if (textMatch) {
      var searchText = textMatch[1];
      var candidates = document.querySelectorAll('button, a, [role="button"]');
      for (var i = 0; i < candidates.length; i++) {
        if ((candidates[i].textContent || '').trim() === searchText) return candidates[i];
      }
      return null;
    }

    try { return document.querySelector(selector); } catch (e) { return null; }
  }

  function getElement(idx) {
    var selector = elementMap[idx];
    if (!selector) return null;
    return findElement(selector);
  }

  function executeAction(action) {
    var result = { success: false, error: null };

    try {
      if (action.action === 'click') {
        var el = getElement(action.index);
        if (!el) {
          result.error = 'Element ' + action.index + ' not found';
          return result;
        }
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();
        el.click();
        result.success = true;

      } else if (action.action === 'type') {
        var input = getElement(action.index);
        if (!input) {
          result.error = 'Element ' + action.index + ' not found';
          return result;
        }
        input.focus();

        // Handle select
        if (input.tagName === 'SELECT') {
          var value = (action.value || '').toLowerCase();
          for (var i = 0; i < input.options.length; i++) {
            if (input.options[i].text.toLowerCase().indexOf(value) !== -1) {
              input.selectedIndex = i;
              input.dispatchEvent(new Event('change', { bubbles: true }));
              result.success = true;
              return result;
            }
          }
          result.error = 'Option not found';
          return result;
        }

        // Regular input
        var proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(input, action.value || '');
        else input.value = action.value || '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        result.success = true;

      } else if (action.action === 'scroll') {
        var amount = window.innerHeight * 0.7;
        window.scrollBy({ top: action.direction === 'up' ? -amount : amount, behavior: 'smooth' });
        result.success = true;

      } else if (action.action === 'complete') {
        result.success = true;
      }
    } catch (e) {
      result.error = e.message || 'Unknown error';
    }

    return result;
  }

  // Highlight element briefly
  function highlightElement(idx) {
    var el = getElement(idx);
    if (!el) return;
    var prev = el.style.outline;
    el.style.outline = '2px solid rgba(139,92,246,.8)';
    el.style.outlineOffset = '2px';
    setTimeout(function() {
      el.style.outline = prev;
      el.style.outlineOffset = '';
    }, 800);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // CSS
  // ═══════════════════════════════════════════════════════════════════════════════

  var style = document.createElement('style');
  style.textContent = \`
    *{box-sizing:border-box;margin:0;padding:0}
    .fab{width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;background:#18181b;border:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(0,0,0,0.5);transition:transform .15s}
    .fab:hover{transform:scale(1.05)}
    .fab:active{transform:scale(0.95)}
    .fab svg{stroke:#a1a1aa}
    .panel{position:absolute;bottom:64px;right:0;width:360px;height:500px;background:#0c0c0e;border:1px solid rgba(255,255,255,0.08);border-radius:14px;overflow:hidden;box-shadow:0 16px 64px rgba(0,0,0,0.7);display:flex;flex-direction:column;opacity:0;transform:translateY(10px) scale(0.96);pointer-events:none;transition:all .2s ease}
    .panel.open{opacity:1;transform:translateY(0) scale(1);pointer-events:all}
    .header{padding:14px 16px;background:#111114;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:10px}
    .dot{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 6px rgba(34,197,94,.5)}
    .title{color:#f4f4f5;font-size:13px;font-weight:500}
    .msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}
    .msgs::-webkit-scrollbar{width:3px}
    .msgs::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.1);border-radius:3px}
    .empty{flex:1;display:flex;align-items:center;justify-content:center;color:#3f3f46;font-size:13px}
    .msg{max-width:85%;animation:fadeIn .15s ease}
    @keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
    .msg.user{align-self:flex-end}
    .msg.agent{align-self:flex-start}
    .msg.action{align-self:flex-start}
    .bubble{padding:10px 14px;font-size:13px;line-height:1.5;border-radius:12px;word-break:break-word}
    .msg.user .bubble{background:#27272a;color:#e4e4e7;border-bottom-right-radius:4px}
    .msg.agent .bubble{background:#18181b;color:#e4e4e7;border-bottom-left-radius:4px}
    .msg.action .bubble{background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);color:#71717a;font-size:12px;padding:6px 10px;border-radius:20px;display:flex;align-items:center;gap:6px}
    .spinner{width:10px;height:10px;border:1.5px solid rgba(255,255,255,0.1);border-top-color:#52525b;border-radius:50%;animation:spin .6s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .check{width:10px;height:10px}
    .check path{stroke:#3f3f46}
    .typing{align-self:flex-start}
    .typing .bubble{display:flex;gap:4px;padding:12px 16px}
    .typing .dot{width:5px;height:5px;background:#3f3f46;animation:bounce 1.2s ease infinite}
    .typing .dot:nth-child(2){animation-delay:.15s}
    .typing .dot:nth-child(3){animation-delay:.3s}
    @keyframes bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-4px)}}
    .footer{padding:10px 12px;background:#0c0c0e;border-top:1px solid rgba(255,255,255,0.06);display:flex;gap:8px}
    .input{flex:1;background:#18181b;border:1px solid rgba(255,255,255,0.09);border-radius:10px;padding:10px 12px;color:#e4e4e7;font-size:13px;outline:none;resize:none}
    .input::placeholder{color:#3f3f46}
    .input:focus{border-color:rgba(255,255,255,0.18)}
    .send{width:36px;height:36px;border:none;border-radius:9px;cursor:pointer;background:#e4e4e7;display:flex;align-items:center;justify-content:center;transition:transform .12s}
    .send:hover:not(:disabled){background:#fff}
    .send:active:not(:disabled){transform:scale(0.92)}
    .send:disabled{background:#27272a;cursor:default}
    .send:disabled path{stroke:#52525b}
    .stop{display:none;width:36px;height:36px;border:none;border-radius:9px;cursor:pointer;background:#dc2626;align-items:center;justify-content:center}
    .stop.show{display:flex}
    .stop:hover{background:#b91c1c}
  \`;
  shadow.appendChild(style);

  // ═══════════════════════════════════════════════════════════════════════════════
  // MARKUP
  // ═══════════════════════════════════════════════════════════════════════════════

  var container = document.createElement('div');
  container.innerHTML = \`
    <button class="fab" aria-label="Open chat">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke-width="1.75" stroke-linejoin="round"/>
      </svg>
    </button>
    <div class="panel">
      <div class="header"><div class="dot"></div><span class="title">Agent</span></div>
      <div class="msgs"><div class="empty">How can I help?</div></div>
      <div class="footer">
        <textarea class="input" placeholder="Message..." rows="1"></textarea>
        <button class="send" disabled aria-label="Send">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" stroke="#09090b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="stop" aria-label="Stop">
          <svg width="14" height="14" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" fill="#fff"/></svg>
        </button>
      </div>
    </div>
  \`;
  shadow.appendChild(container);

  var fab = container.querySelector('.fab');
  var panel = container.querySelector('.panel');
  var msgsEl = container.querySelector('.msgs');
  var inputEl = container.querySelector('.input');
  var sendBtn = container.querySelector('.send');
  var stopBtn = container.querySelector('.stop');
  var emptyEl = container.querySelector('.empty');

  // ═══════════════════════════════════════════════════════════════════════════════
  // UI HELPERS
  // ═══════════════════════════════════════════════════════════════════════════════

  function scrollToBottom() { msgsEl.scrollTop = msgsEl.scrollHeight; }

  function hideEmpty() { if (emptyEl) { emptyEl.style.display = 'none'; emptyEl = null; } }

  function addMessage(type, text) {
    hideEmpty();
    var row = document.createElement('div');
    row.className = 'msg ' + type;
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    row.appendChild(bubble);
    msgsEl.appendChild(row);
    scrollToBottom();
    return row;
  }

  function addActionPill(description) {
    hideEmpty();
    var row = document.createElement('div');
    row.className = 'msg action';
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = '<div class="spinner"></div><span>' + (description || 'Working...') + '</span>';
    row.appendChild(bubble);
    msgsEl.appendChild(row);
    scrollToBottom();
    return row;
  }

  function resolveActionPill(row, description) {
    var bubble = row.querySelector('.bubble');
    if (!bubble) return;
    bubble.innerHTML = '<svg class="check" viewBox="0 0 10 10"><path d="M1.5 5l2.5 2.5 4.5-4.5" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg><span>' + (description || 'Done') + '</span>';
  }

  function showTyping() {
    hideEmpty();
    var row = document.createElement('div');
    row.className = 'msg typing';
    row.id = '_typing';
    row.innerHTML = '<div class="bubble"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>';
    msgsEl.appendChild(row);
    scrollToBottom();
  }

  function hideTyping() {
    var t = shadow.getElementById('_typing');
    if (t) t.remove();
  }

  function setRunning(on) {
    isRunning = on;
    sendBtn.disabled = on || inputEl.value.trim() === '';
    stopBtn.classList.toggle('show', on);
    if (!on) { stopped = false; hideOverlay(); }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // AGENT LOOP — The core: extract → plan → act → observe → repeat
  // ═══════════════════════════════════════════════════════════════════════════════

  async function runAgentLoop(goal) {
    turn = 0;
    stopped = false;
    setRunning(true);

    // Initial DOM snapshot
    var dom = distillDOM();

    // First turn — send goal + DOM
    showTyping();
    var response = await callAPI({ goal: goal, dom: dom });
    hideTyping();

    if (!response || response.error) {
      addMessage('agent', response?.message || 'Something went wrong.');
      setRunning(false);
      return;
    }

    conversationId = response.conversationId;
    sessionStorage.setItem(CID_KEY, conversationId);

    // Process response
    await processResponse(response);
  }

  async function processResponse(response) {
    if (stopped) { setRunning(false); return; }

    // Show message if present
    if (response.message) {
      addMessage('agent', response.message);
    }

    // Done?
    if (response.done || !response.action) {
      setRunning(false);
      return;
    }

    var action = response.action;

    // Complete action = done
    if (action.action === 'complete') {
      if (action.result) addMessage('agent', action.result);
      setRunning(false);
      return;
    }

    // Execute action
    turn++;
    if (turn > MAX_TURNS) {
      addMessage('agent', 'Taking too long. Please try a simpler request.');
      setRunning(false);
      return;
    }

    showOverlay();
    var pill = addActionPill(action.description);
    if (action.index) highlightElement(action.index);

    // Small delay for visual feedback
    await new Promise(function(r) { setTimeout(r, 100); });

    var result = executeAction(action);
    resolveActionPill(pill, action.description);

    // Wait for page to stabilize
    await waitForStable(350, 3000);

    if (stopped) { setRunning(false); return; }

    // Get fresh DOM
    var dom = distillDOM();
    hideOverlay();

    // Send observation to API
    showTyping();
    var nextResponse = await callAPI({
      observation: {
        actionResult: result,
        dom: dom
      }
    });
    hideTyping();

    if (!nextResponse || nextResponse.error) {
      addMessage('agent', nextResponse?.message || 'Something went wrong.');
      setRunning(false);
      return;
    }

    // Continue loop
    await processResponse(nextResponse);
  }

  async function callAPI(data) {
    try {
      var body = Object.assign({
        siteKey: siteKey,
        visitorId: visitorId,
        conversationId: conversationId
      }, data);

      var resp = await fetch(serverOrigin + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return await resp.json();
    } catch (e) {
      console.error('[agent]', e);
      return { error: true, message: 'Connection error. Please try again.' };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // EVENT HANDLERS
  // ═══════════════════════════════════════════════════════════════════════════════

  fab.addEventListener('click', function() {
    isOpen = !isOpen;
    panel.classList.toggle('open', isOpen);
    if (isOpen) setTimeout(function() { inputEl.focus(); }, 200);
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && isOpen) {
      isOpen = false;
      panel.classList.remove('open');
    }
  });

  inputEl.addEventListener('input', function() {
    sendBtn.disabled = isRunning || inputEl.value.trim() === '';
  });

  inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) send();
    }
  });

  sendBtn.addEventListener('click', send);

  stopBtn.addEventListener('click', function() {
    stopped = true;
    hideTyping();
    hideOverlay();
    addMessage('agent', 'Stopped.');
    setRunning(false);
  });

  function send() {
    var text = inputEl.value.trim();
    if (!text || isRunning) return;

    addMessage('user', text);
    inputEl.value = '';
    runAgentLoop(text);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // LOAD HISTORY ON INIT
  // ═══════════════════════════════════════════════════════════════════════════════

  if (conversationId) {
    fetch(serverOrigin + '/api/chat/history?siteKey=' + encodeURIComponent(siteKey) + '&conversationId=' + encodeURIComponent(conversationId))
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (data && data.messages && data.messages.length > 0) {
          hideEmpty();
          data.messages.forEach(function(m) {
            if (m.role === 'user') addMessage('user', m.content);
            else if (m.role === 'assistant') addMessage('agent', m.content);
            else if (m.role === 'action' && m.action) {
              var pill = addActionPill(m.action.description);
              resolveActionPill(pill, m.action.description);
            }
          });
        }
      })
      .catch(function(e) { console.log('[agent] history load error:', e); });
  }

})();`;
}
