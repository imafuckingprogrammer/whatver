/**
 * Embeddable AI Agent Widget
 * Plan-based agent with action batching
 */
export function getWidgetScript(): string {
  return `(function() {
  'use strict';

  // ════════════════════════════════════════════════════════════════════════════
  // SETUP
  // ════════════════════════════════════════════════════════════════════════════

  var script = document.currentScript || (function() {
    var scripts = document.querySelectorAll('script[src*="/embed/"]');
    return scripts[scripts.length - 1];
  })();
  if (!script) return;

  var SERVER = script.src.replace(/\\/embed\\/.+$/, '');
  var SITE_KEY = (script.src.match(/\\/embed\\/([^.]+)\\.js/) || [])[1];
  if (!SITE_KEY) return;

  // Session state
  var visitorId = sessionStorage.getItem('_ag_vid_' + SITE_KEY) ||
    ('v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  sessionStorage.setItem('_ag_vid_' + SITE_KEY, visitorId);
  var conversationId = sessionStorage.getItem('_ag_cid_' + SITE_KEY) || null;

  // Runtime state
  var MAX_TURNS = 20;
  var elementMap = {};
  var running = false;
  var turn = 0;
  var lastUrl = location.href;

  // ════════════════════════════════════════════════════════════════════════════
  // OVERLAY & HIGHLIGHT
  // ════════════════════════════════════════════════════════════════════════════

  var style = document.createElement('style');
  style.textContent = '@keyframes ag-pulse{0%,100%{box-shadow:inset 0 0 0 3px rgba(124,58,237,0.4)}50%{box-shadow:inset 0 0 0 3px rgba(124,58,237,0.8)}}';
  document.head.appendChild(style);

  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483640;pointer-events:none;opacity:0;transition:opacity 0.3s';
  document.body.appendChild(overlay);

  function showOverlay() {
    overlay.style.opacity = '1';
    overlay.style.animation = 'ag-pulse 2s ease-in-out infinite';
  }
  function hideOverlay() {
    overlay.style.opacity = '0';
    overlay.style.animation = 'none';
  }

  function highlightEl(el) {
    if (!el) return;
    el.style.outline = '2px solid #8b5cf6';
    el.style.outlineOffset = '3px';
    el.style.transition = 'outline 0.2s';
    setTimeout(function() {
      el.style.outline = '';
      el.style.outlineOffset = '';
      el.style.transition = '';
    }, 600);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // WIDGET HOST
  // ════════════════════════════════════════════════════════════════════════════

  var widgetHost = document.createElement('div');
  widgetHost.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;font-family:system-ui,-apple-system,sans-serif';
  document.body.appendChild(widgetHost);

  // ════════════════════════════════════════════════════════════════════════════
  // DOM EXTRACTION
  // ════════════════════════════════════════════════════════════════════════════

  function extractDOM() {
    var vw = window.innerWidth, vh = window.innerHeight;
    var currentUrl = location.href;
    var urlChanged = lastUrl !== currentUrl;
    if (urlChanged) {
      console.log('[agent] URL changed: ' + lastUrl + ' -> ' + currentUrl);
      lastUrl = currentUrl;
    }

    elementMap = {};
    var idx = 1;
    var lines = [];

    // Page context - CRITICAL for agent to know where it is
    lines.push('URL: ' + currentUrl);
    lines.push('TITLE: ' + (document.title || 'Untitled'));
    if (urlChanged) lines.push('>>> PAGE JUST CHANGED <<<');
    lines.push('');

    // Helpers
    function inViewport(rect) {
      return rect.width > 0 && rect.height > 0 &&
             rect.bottom > 0 && rect.top < vh &&
             rect.right > 0 && rect.left < vw;
    }

    function isVisible(el) {
      if (!el || el === widgetHost || widgetHost.contains(el)) return false;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      var cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0;
    }

    function isInView(el) {
      if (!isVisible(el)) return false;
      return inViewport(el.getBoundingClientRect());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 1: Walk ALL visible text nodes
    // ─────────────────────────────────────────────────────────────────────────
    var seenText = {};
    var textWalker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(node) {
          if (widgetHost.contains(node)) return NodeFilter.FILTER_REJECT;
          var text = (node.textContent || '').trim();
          if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;
          var parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          var tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    var textNode;
    while ((textNode = textWalker.nextNode())) {
      var range = document.createRange();
      range.selectNodeContents(textNode);
      var rect = range.getBoundingClientRect();
      if (!inViewport(rect)) continue;

      var text = textNode.textContent.trim();
      if (seenText[text]) continue;

      var parent = textNode.parentElement;
      if (!isVisible(parent)) continue;
      if (parent.closest('button, a, input, textarea, select, [role="button"]')) continue;

      seenText[text] = true;
      var tag = parent.tagName;

      if (tag === 'H1') lines.push('#1 ' + text.slice(0, 80));
      else if (tag === 'H2') lines.push('#2 ' + text.slice(0, 70));
      else if (tag === 'H3') lines.push('#3 ' + text.slice(0, 60));
      else if (parent.closest('[role="alert"]')) lines.push('!ALERT: ' + text.slice(0, 60));
      else if (parent.closest('[role="status"]')) lines.push('STATUS: ' + text.slice(0, 60));
      else if (text.length > 3) lines.push('> ' + text.slice(0, 80));
    }

    lines.push('');
    lines.push('ELEMENTS:');

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 2: Capture interactive elements
    // ─────────────────────────────────────────────────────────────────────────
    var INTERACTIVE = 'button, a[href], input:not([type="hidden"]), textarea, select, ' +
                      '[role="button"], [role="link"], [role="checkbox"], [role="tab"], ' +
                      '[role="menuitem"], [role="switch"], [onclick]';

    var elements = document.querySelectorAll(INTERACTIVE);
    for (var i = 0; i < elements.length && idx <= 50; i++) {
      var el = elements[i];
      if (!isInView(el)) continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;

      var elTag = el.tagName;
      var role = el.getAttribute('role');
      elementMap[idx] = el;

      var line = '[' + idx + ']';

      // Type
      if (elTag === 'BUTTON' || role === 'button') line += 'button';
      else if (elTag === 'A') line += 'link';
      else if (elTag === 'INPUT') line += 'input[' + (el.type || 'text') + ']';
      else if (elTag === 'TEXTAREA') line += 'textarea';
      else if (elTag === 'SELECT') line += 'select';
      else line += elTag.toLowerCase();

      // Label
      var label = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 35) ||
                  el.getAttribute('aria-label') ||
                  el.getAttribute('title') ||
                  el.placeholder || '';
      if (label) line += '"' + label + '"';

      // Value
      if ((elTag === 'INPUT' || elTag === 'TEXTAREA') && el.value) {
        line += '="' + el.value.slice(0, 20) + '"';
      }

      // State
      var flags = [];
      if (el.type === 'checkbox' || el.type === 'radio') {
        flags.push(el.checked ? 'ON' : 'OFF');
      }
      if (el.disabled) flags.push('disabled');
      if (el.required) flags.push('req');
      if (flags.length) line += '[' + flags.join(',') + ']';

      // Select options
      if (elTag === 'SELECT' && el.options.length) {
        var opts = [];
        for (var o = 0; o < Math.min(el.options.length, 4); o++) {
          var opt = el.options[o];
          if (opt.selected) opts.push('*' + opt.text.slice(0, 12) + '*');
          else opts.push(opt.text.slice(0, 12));
        }
        if (el.options.length > 4) opts.push('+' + (el.options.length - 4));
        line += '(' + opts.join('|') + ')';
      }

      lines.push(line);
      idx++;
    }

    // Scroll hint
    if (document.documentElement.scrollHeight > vh + window.scrollY + 100) {
      lines.push('');
      lines.push('[scroll down for more content]');
    }

    return lines.join('\\n');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ACTION EXECUTION
  // ════════════════════════════════════════════════════════════════════════════

  function executeAction(action) {
    var el = elementMap[action.index];
    var vh = window.innerHeight;

    if (action.type === 'click') {
      if (!el) return { ok: false, msg: 'Element ' + action.index + ' not found', nav: false };
      highlightEl(el);
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Delay click to allow scroll to complete
      return new Promise(function(resolve) {
        setTimeout(function() {
          try {
            el.focus();
            el.click();
            var label = (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 25);
            var isNav = el.tagName === 'A' || el.closest('a') || el.type === 'submit';
            resolve({ ok: true, msg: 'Clicked "' + label + '"', nav: isNav });
          } catch (e) {
            console.log('[agent] Click failed:', e);
            resolve({ ok: false, msg: 'Click failed - element may have changed', nav: true });
          }
        }, 150);
      });
    }

    if (action.type === 'type') {
      if (!el) return { ok: false, msg: 'Element ' + action.index + ' not found', nav: false };
      highlightEl(el);
      el.focus();
      var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, action.text || '');
      else el.value = action.text || '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, msg: 'Typed "' + (action.text || '').slice(0, 20) + '"', nav: false };
    }

    if (action.type === 'select') {
      if (!el) return { ok: false, msg: 'Element ' + action.index + ' not found', nav: false };
      highlightEl(el);
      var found = false;
      var searchText = (action.value || action.text || '').toLowerCase();
      for (var i = 0; i < el.options.length; i++) {
        if (el.options[i].text.toLowerCase().includes(searchText)) {
          el.selectedIndex = i;
          found = true;
          break;
        }
      }
      if (found) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, msg: 'Selected "' + el.options[el.selectedIndex].text + '"', nav: false };
      }
      return { ok: false, msg: 'Option not found', nav: false };
    }

    if (action.type === 'scroll') {
      var dir = action.direction === 'up' ? -1 : 1;
      window.scrollBy({ top: dir * Math.round(vh * 0.7), behavior: 'smooth' });
      return { ok: true, msg: 'Scrolled ' + (action.direction || 'down'), nav: false };
    }

    if (action.type === 'hover') {
      if (!el) return { ok: false, msg: 'Element ' + action.index + ' not found', nav: false };
      highlightEl(el);
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return { ok: true, msg: 'Hovered', nav: false };
    }

    if (action.type === 'complete') {
      return { ok: true, msg: action.result || 'Done', nav: false, complete: true };
    }

    return { ok: false, msg: 'Unknown action: ' + action.type, nav: false };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // WAIT FOR STABILITY
  // ════════════════════════════════════════════════════════════════════════════

  function waitForStable(minWait, maxWait) {
    minWait = minWait || 600;
    maxWait = maxWait || 4000;
    var startUrl = location.href;

    return new Promise(function(resolve) {
      var start = Date.now();
      var lastChange = Date.now();

      var observer = new MutationObserver(function() {
        lastChange = Date.now();
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });

      function check() {
        var now = Date.now();
        var elapsed = now - start;
        var stable = now - lastChange;

        // URL changed = navigation, reset and wait longer
        if (location.href !== startUrl) {
          console.log('[agent] URL changed during wait');
          startUrl = location.href;
          lastChange = now;
          start = now; // Reset timer for new page
        }

        if (stable >= minWait || elapsed >= maxWait) {
          observer.disconnect();
          resolve();
        } else {
          setTimeout(check, 100);
        }
      }

      setTimeout(check, 200);
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // WIDGET UI
  // ════════════════════════════════════════════════════════════════════════════

  var shadow = widgetHost.attachShadow({ mode: 'closed' });
  shadow.innerHTML = \`
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .fab { width: 52px; height: 52px; border-radius: 50%; border: none; cursor: pointer;
        background: #18181b; display: flex; align-items: center; justify-content: center;
        box-shadow: 0 4px 20px rgba(0,0,0,0.4); transition: transform 0.15s; }
      .fab:hover { transform: scale(1.05); }
      .fab svg { stroke: #a1a1aa; fill: none; }
      .panel { position: absolute; bottom: 64px; right: 0; width: 380px; height: 520px;
        background: #09090b; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px;
        display: none; flex-direction: column; overflow: hidden; }
      .panel.open { display: flex; }
      .hdr { padding: 14px 16px; background: #111; border-bottom: 1px solid rgba(255,255,255,0.08);
        color: #e4e4e7; font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; flex-shrink: 0; }
      .dot.active { background: #8b5cf6; animation: pulse 1.5s infinite; }
      @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.5 } }
      .msgs { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
      .msg { max-width: 85%; padding: 10px 14px; border-radius: 12px; font-size: 13px; line-height: 1.5; animation: fadeIn 0.2s; }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
      .msg.user { align-self: flex-end; background: #27272a; color: #e4e4e7; }
      .msg.agent { align-self: flex-start; background: #18181b; color: #e4e4e7; }
      .msg.step { align-self: flex-start; color: #a1a1aa; font-size: 12px; padding: 6px 0;
        display: flex; align-items: center; gap: 8px; }
      .msg.step::before { content: ''; width: 16px; height: 16px; border-radius: 50%;
        border: 2px solid #8b5cf6; border-top-color: transparent; animation: spin 0.8s linear infinite; }
      .msg.step.done::before { border: none; background: #22c55e;
        background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 16 16' fill='white' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M6.5 11.5L3 8l1-1 2.5 2.5L11 5l1 1-5.5 5.5z'/%3E%3C/svg%3E");
        animation: none; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .msg.typing { align-self: flex-start; display: flex; gap: 4px; padding: 12px 16px; background: #18181b; border-radius: 12px; }
      .msg.typing span { width: 6px; height: 6px; background: #52525b; border-radius: 50%; animation: bounce 1s infinite; }
      .msg.typing span:nth-child(2) { animation-delay: 0.15s; }
      .msg.typing span:nth-child(3) { animation-delay: 0.3s; }
      @keyframes bounce { 0%,60%,100% { transform: translateY(0) } 30% { transform: translateY(-6px) } }
      .ftr { padding: 12px; border-top: 1px solid rgba(255,255,255,0.08); display: flex; gap: 8px; }
      .inp { flex: 1; background: #18181b; border: 1px solid rgba(255,255,255,0.1); border-radius: 10px;
        padding: 10px 12px; color: #e4e4e7; font-size: 13px; outline: none; resize: none; }
      .inp::placeholder { color: #52525b; }
      .snd { width: 36px; height: 36px; border-radius: 8px; border: none; cursor: pointer;
        background: #e4e4e7; display: flex; align-items: center; justify-content: center; }
      .snd:disabled { background: #27272a; cursor: default; }
      .snd svg { stroke: #18181b; fill: none; }
      .snd:disabled svg { stroke: #52525b; }
    </style>
    <button class="fab" id="fab">
      <svg width="22" height="22" viewBox="0 0 24 24" stroke-width="1.75" stroke-linecap="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    </button>
    <div class="panel" id="panel">
      <div class="hdr"><div class="dot" id="dot"></div>Agent</div>
      <div class="msgs" id="msgs"></div>
      <div class="ftr">
        <textarea class="inp" id="inp" placeholder="What do you need?" rows="1"></textarea>
        <button class="snd" id="snd" disabled>
          <svg width="16" height="16" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>
          </svg>
        </button>
      </div>
    </div>
  \`;

  var fab = shadow.getElementById('fab');
  var panel = shadow.getElementById('panel');
  var msgs = shadow.getElementById('msgs');
  var inp = shadow.getElementById('inp');
  var snd = shadow.getElementById('snd');
  var dot = shadow.getElementById('dot');

  fab.onclick = function() {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) inp.focus();
  };

  function setActive(on) {
    if (on) { dot.classList.add('active'); showOverlay(); }
    else { dot.classList.remove('active'); hideOverlay(); }
  }

  function addMsg(type, content) {
    var div = document.createElement('div');
    div.className = 'msg ' + type;
    div.textContent = content || '';
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div;
  }

  function showTyping() {
    var div = document.createElement('div');
    div.className = 'msg typing';
    div.id = 'typing';
    div.innerHTML = '<span></span><span></span><span></span>';
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function hideTyping() {
    var t = shadow.getElementById('typing');
    if (t) t.remove();
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MAIN LOOP
  // ════════════════════════════════════════════════════════════════════════════

  async function runLoop(task) {
    if (running) return;
    running = true;
    turn = 0;
    setActive(true);

    var currentStepEl = null;
    var lastObservation = '';

    try {
      while (turn < MAX_TURNS) {
        turn++;

        // Wait for page stability BEFORE extracting DOM
        console.log('[agent] Turn ' + turn + ' - waiting for stability...');
        await waitForStable(600, 4000);

        var dom = extractDOM();
        console.log('[agent] Turn ' + turn + ', DOM ' + dom.length + ' chars, URL: ' + location.href);

        showTyping();

        var body = {
          siteKey: SITE_KEY,
          visitorId: visitorId,
          conversationId: conversationId,
          dom: dom,
          currentUrl: location.href,
          turnType: turn === 1 ? 'new' : 'observation',
        };

        if (turn === 1) {
          body.message = task;
        } else {
          body.observation = lastObservation || 'action executed';
        }

        var res = await fetch(SERVER + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        hideTyping();

        if (!res.ok) {
          console.error('[agent] HTTP error:', res.status);
          throw new Error('HTTP ' + res.status);
        }

        var data = await res.json();

        if (data.conversationId) {
          conversationId = data.conversationId;
          sessionStorage.setItem('_ag_cid_' + SITE_KEY, conversationId);
        }

        // Handle new format: actions array
        var actions = data.actions || (data.action ? [data.action] : []);
        var speak = data.speak || '';
        var done = data.done;

        console.log('[agent] Actions:', actions.map(function(a) { return a.type + '(' + (a.index || '') + ')'; }).join(', '));
        console.log('[agent] Done:', done);

        // Check for completion first
        if (done) {
          if (currentStepEl) currentStepEl.classList.add('done');
          var completeAction = actions.find(function(a) { return a.type === 'complete'; });
          var result = completeAction ? completeAction.result : 'Task completed!';
          addMsg('agent', result);
          break;
        }

        // No actions = agent is confused, break to avoid infinite loop
        if (actions.length === 0) {
          console.log('[agent] No actions returned, ending loop');
          if (currentStepEl) currentStepEl.classList.add('done');
          addMsg('agent', speak || 'I\\'m not sure what to do next.');
          break;
        }

        // Show step indicator
        if (currentStepEl) currentStepEl.classList.add('done');
        currentStepEl = addMsg('step', speak || actions[0].type + '...');

        // Execute actions (batching safe ones)
        var observations = [];
        var hitNavigation = false;

        for (var i = 0; i < actions.length; i++) {
          var action = actions[i];

          if (action.type === 'complete') {
            if (currentStepEl) currentStepEl.classList.add('done');
            addMsg('agent', action.result || 'Done!');
            running = false;
            setActive(false);
            return;
          }

          console.log('[agent] Executing: ' + action.type + '(' + (action.index || '') + ')');
          var result = await executeAction(action);
          console.log('[agent] Result:', result.msg);
          observations.push(result.msg);

          // If this action might cause navigation, stop and wait
          if (result.nav) {
            console.log('[agent] Navigation likely, stopping batch');
            hitNavigation = true;
            break;
          }

          // Small delay between batched actions
          if (i < actions.length - 1) {
            await new Promise(function(r) { setTimeout(r, 200); });
          }
        }

        lastObservation = observations.join('; ');

        // If we hit navigation, wait longer before next turn
        if (hitNavigation) {
          console.log('[agent] Waiting for navigation to complete...');
          await waitForStable(800, 5000);
        }
      }

      if (turn >= MAX_TURNS) {
        if (currentStepEl) currentStepEl.classList.add('done');
        addMsg('agent', 'I took too many steps. Please try a simpler request.');
      }

    } catch (err) {
      console.error('[agent] Error:', err);
      hideTyping();
      if (currentStepEl) currentStepEl.classList.add('done');
      addMsg('agent', 'Something went wrong: ' + (err.message || 'Unknown error'));
    }

    running = false;
    setActive(false);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // INPUT HANDLING
  // ════════════════════════════════════════════════════════════════════════════

  inp.oninput = function() { snd.disabled = !inp.value.trim() || running; };

  inp.onkeydown = function(e) {
    if (e.key === 'Enter' && !e.shiftKey && !snd.disabled) {
      e.preventDefault();
      send();
    }
  };

  snd.onclick = send;

  function send() {
    var text = inp.value.trim();
    if (!text || running) return;

    // New task = new conversation
    conversationId = null;
    sessionStorage.removeItem('_ag_cid_' + SITE_KEY);

    addMsg('user', text);
    inp.value = '';
    snd.disabled = true;
    runLoop(text);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // HISTORY RESTORATION
  // ════════════════════════════════════════════════════════════════════════════

  async function loadHistory() {
    if (!conversationId) return;

    try {
      var res = await fetch(SERVER + '/api/chat/history?siteKey=' + SITE_KEY + '&conversationId=' + conversationId);
      if (!res.ok) return;

      var data = await res.json();
      (data.messages || []).forEach(function(m) {
        if (m.type === 'user') addMsg('user', m.content);
        else if (m.type === 'agent') addMsg('agent', m.content);
        else if (m.type === 'step') {
          var el = addMsg('step', m.content);
          el.classList.add('done');
        }
      });
    } catch (err) {
      console.log('[agent] History load failed:', err);
    }
  }

  loadHistory();

})();`;
}
