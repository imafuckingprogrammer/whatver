/**
 * Embeddable AI Agent Widget v2
 * Philosophy: Simple, reliable, token-efficient
 */
export function getWidgetScript(): string {
  return `(function() {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // SETUP
  // ═══════════════════════════════════════════════════════════════════════════
  var scriptEl = document.currentScript || (function() {
    var scripts = document.querySelectorAll('script[src*="/embed/"]');
    return scripts[scripts.length - 1];
  })();
  if (!scriptEl) return;

  var serverOrigin = scriptEl.src.replace(/\\/embed\\/.+$/, '');
  var siteKey = (scriptEl.src.match(/\\/embed\\/(.+?)\\.js/) || [])[1];
  if (!siteKey) return;

  var visitorId = sessionStorage.getItem('_vid_' + siteKey);
  if (!visitorId) {
    visitorId = 'v_' + Math.random().toString(36).slice(2);
    sessionStorage.setItem('_vid_' + siteKey, visitorId);
  }
  var conversationId = sessionStorage.getItem('_cid_' + siteKey);

  // ═══════════════════════════════════════════════════════════════════════════
  // WAIT FOR PAGE STABLE - The most important function
  // ═══════════════════════════════════════════════════════════════════════════
  function waitForStable() {
    return new Promise(function(resolve) {
      var start = Date.now();
      var lastActivity = Date.now();
      var maxWait = 5000;
      var stableTime = 500; // Need 500ms of no activity

      // Track DOM mutations
      var observer = new MutationObserver(function() {
        lastActivity = Date.now();
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });

      // Track network
      var pendingFetches = 0;
      var origFetch = window.fetch;
      window.fetch = function() {
        pendingFetches++;
        lastActivity = Date.now();
        return origFetch.apply(this, arguments).finally(function() {
          pendingFetches--;
          lastActivity = Date.now();
        });
      };

      function check() {
        var now = Date.now();
        var timeSinceActivity = now - lastActivity;
        var elapsed = now - start;

        if (pendingFetches === 0 && timeSinceActivity >= stableTime) {
          cleanup();
          resolve();
        } else if (elapsed >= maxWait) {
          cleanup();
          resolve();
        } else {
          setTimeout(check, 100);
        }
      }

      function cleanup() {
        observer.disconnect();
        window.fetch = origFetch;
      }

      setTimeout(check, 200);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OBSERVE - Compact page representation
  // ═══════════════════════════════════════════════════════════════════════════
  function observe() {
    var lines = [];
    lines.push('URL: ' + location.pathname);
    lines.push('TITLE: ' + (document.title || '(none)'));
    lines.push('');

    var seen = new Set();

    // Helper: is element visible?
    function isVisible(el) {
      if (!el.offsetParent && el.tagName !== 'BODY') return false;
      var cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
    }

    // Helper: get best selector
    function getSelector(el) {
      if (el.id) return '#' + el.id;
      if (el.name) return '[name=' + el.name + ']';
      var text = (el.textContent || '').trim().slice(0, 30);
      if (text && !text.includes('\\n')) return 'text="' + text + '"';
      return null;
    }

    // Helper: format element
    function formatEl(el) {
      var tag = el.tagName.toLowerCase();
      var sel = getSelector(el);
      if (!sel || seen.has(sel)) return null;
      seen.add(sel);

      var parts = [];

      // Type
      if (tag === 'button' || el.type === 'submit' || el.role === 'button') {
        parts.push('BTN');
      } else if (tag === 'a') {
        parts.push('LINK');
      } else if (tag === 'input') {
        var t = (el.type || 'text').toUpperCase();
        if (t === 'CHECKBOX') parts.push(el.checked ? 'CHECK[x]' : 'CHECK[ ]');
        else if (t === 'RADIO') parts.push(el.checked ? 'RADIO[x]' : 'RADIO[ ]');
        else parts.push('INPUT');
      } else if (tag === 'textarea') {
        parts.push('TEXTAREA');
      } else if (tag === 'select') {
        parts.push('SELECT');
      } else {
        return null;
      }

      // Selector
      parts.push(sel);

      // Label/text
      var label = el.placeholder || el.getAttribute('aria-label');
      if (!label && el.id) {
        var labelEl = document.querySelector('label[for="' + el.id + '"]');
        if (labelEl) label = labelEl.textContent.trim();
      }
      if (label) parts.push('"' + label.slice(0, 25) + '"');

      // Value for inputs
      if (tag === 'input' || tag === 'textarea') {
        if (el.value) parts.push('val="' + el.value.slice(0, 20) + '"');
      }

      // Select options
      if (tag === 'select') {
        var opts = [];
        for (var i = 0; i < el.options.length && i < 5; i++) {
          var o = el.options[i];
          opts.push((o.selected ? '*' : '') + o.text.slice(0, 15));
        }
        parts.push('opts=[' + opts.join(',') + ']');
      }

      // Disabled
      if (el.disabled) parts.push('(disabled)');

      return parts.join(' ');
    }

    // Collect interactive elements
    var interactive = document.querySelectorAll(
      'button, a[href], input:not([type=hidden]), textarea, select, [role=button], [onclick]'
    );

    for (var i = 0; i < interactive.length; i++) {
      var el = interactive[i];
      if (!isVisible(el)) continue;
      var line = formatEl(el);
      if (line) lines.push(line);
    }

    // Collect headings for context
    var headings = document.querySelectorAll('h1, h2, h3');
    for (var j = 0; j < headings.length; j++) {
      var h = headings[j];
      if (!isVisible(h)) continue;
      var text = h.textContent.trim().slice(0, 40);
      if (text && !seen.has(text)) {
        seen.add(text);
        lines.push(h.tagName + ' "' + text + '"');
      }
    }

    // Collect alerts/errors
    var alerts = document.querySelectorAll('[role=alert], .error, .success, .alert');
    for (var k = 0; k < alerts.length; k++) {
      var a = alerts[k];
      if (!isVisible(a)) continue;
      var alertText = a.textContent.trim().slice(0, 60);
      if (alertText && !seen.has(alertText)) {
        seen.add(alertText);
        lines.push('ALERT "' + alertText + '"');
      }
    }

    return lines.join('\\n');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════
  function findEl(sel) {
    if (!sel) return null;

    // text="..."
    var textMatch = sel.match(/^text="(.+)"$/);
    if (textMatch) {
      var needle = textMatch[1];
      var candidates = document.querySelectorAll('button, a, [role=button], input[type=submit], label, span');
      for (var i = 0; i < candidates.length; i++) {
        if ((candidates[i].textContent || '').trim() === needle) return candidates[i];
      }
      // Partial match fallback
      for (var j = 0; j < candidates.length; j++) {
        if ((candidates[j].textContent || '').includes(needle)) return candidates[j];
      }
      return null;
    }

    try { return document.querySelector(sel); } catch(e) { return null; }
  }

  function doClick(sel) {
    var el = findEl(sel);
    if (!el) return { ok: false, err: 'not found: ' + sel };
    el.scrollIntoView({ block: 'center' });
    el.focus();
    el.click();
    return { ok: true };
  }

  function doFill(sel, value) {
    var el = findEl(sel);
    if (!el) return { ok: false, err: 'not found: ' + sel };

    var tag = el.tagName.toLowerCase();

    if (tag === 'select') {
      // Find option by text
      for (var i = 0; i < el.options.length; i++) {
        if (el.options[i].text.toLowerCase().includes(value.toLowerCase())) {
          el.selectedIndex = i;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true };
        }
      }
      return { ok: false, err: 'option not found' };
    }

    if (el.type === 'checkbox' || el.type === 'radio') {
      if ((value === true || value === 'true') !== el.checked) el.click();
      return { ok: true };
    }

    // Text input
    el.focus();
    var setter = Object.getOwnPropertyDescriptor(
      tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value'
    );
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXECUTE - Run action, wait, return new state
  // ═══════════════════════════════════════════════════════════════════════════
  async function execute(action) {
    var startUrl = location.href;
    var result = {};

    if (action.a === 'click') {
      result = doClick(action.s);
      await waitForStable();
      result.nav = location.href !== startUrl;
    }
    else if (action.a === 'fill') {
      result = doFill(action.s, action.v);
    }
    else if (action.a === 'done') {
      return { done: true, message: action.m };
    }
    else {
      result = { ok: false, err: 'unknown action' };
    }

    // Always include new page state
    result.page = observe();
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UI - Minimal chat widget
  // ═══════════════════════════════════════════════════════════════════════════
  var root = document.createElement('div');
  root.id = '_agent_root';
  root.innerHTML = \`
    <style>
      #_agent_root { position: fixed; bottom: 20px; right: 20px; z-index: 999999; font-family: system-ui, sans-serif; }
      #_agent_btn { width: 50px; height: 50px; border-radius: 50%; border: none; background: #111; color: #fff; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
      #_agent_panel { display: none; position: absolute; bottom: 60px; right: 0; width: 340px; height: 450px; background: #111; border-radius: 12px; overflow: hidden; flex-direction: column; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
      #_agent_panel.open { display: flex; }
      #_agent_hdr { padding: 12px 16px; background: #1a1a1a; color: #fff; font-weight: 500; }
      #_agent_msgs { flex: 1; padding: 12px; overflow-y: auto; }
      .msg { margin: 8px 0; padding: 8px 12px; border-radius: 8px; max-width: 85%; font-size: 14px; line-height: 1.4; }
      .msg.user { background: #333; color: #fff; margin-left: auto; }
      .msg.agent { background: #222; color: #ddd; border: 1px solid #333; }
      .msg.status { background: transparent; color: #666; font-size: 12px; text-align: center; max-width: 100%; }
      #_agent_ftr { padding: 12px; background: #1a1a1a; display: flex; gap: 8px; }
      #_agent_inp { flex: 1; padding: 8px 12px; border: 1px solid #333; border-radius: 8px; background: #222; color: #fff; font-size: 14px; outline: none; }
      #_agent_send { padding: 8px 16px; background: #fff; color: #000; border: none; border-radius: 8px; cursor: pointer; font-weight: 500; }
      #_agent_send:disabled { background: #444; color: #888; }
    </style>
    <button id="_agent_btn">AI</button>
    <div id="_agent_panel">
      <div id="_agent_hdr">Agent</div>
      <div id="_agent_msgs"></div>
      <div id="_agent_ftr">
        <input id="_agent_inp" placeholder="What can I help with?" />
        <button id="_agent_send">Send</button>
      </div>
    </div>
  \`;
  document.body.appendChild(root);

  var btn = root.querySelector('#_agent_btn');
  var panel = root.querySelector('#_agent_panel');
  var msgs = root.querySelector('#_agent_msgs');
  var inp = root.querySelector('#_agent_inp');
  var send = root.querySelector('#_agent_send');
  var running = false;

  btn.onclick = function() { panel.classList.toggle('open'); };

  function addMsg(type, text) {
    var div = document.createElement('div');
    div.className = 'msg ' + type;
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  inp.oninput = function() { send.disabled = running || !inp.value.trim(); };
  inp.onkeydown = function(e) { if (e.key === 'Enter' && !send.disabled) sendMsg(); };
  send.onclick = sendMsg;

  async function sendMsg() {
    var text = inp.value.trim();
    if (!text || running) return;

    addMsg('user', text);
    inp.value = '';
    send.disabled = true;
    running = true;

    // Get initial page state
    await waitForStable();
    var page = observe();

    try {
      await agentLoop(text, page);
    } catch(e) {
      addMsg('status', 'Error: ' + e.message);
    }

    running = false;
    send.disabled = !inp.value.trim();
  }

  async function agentLoop(goal, initialPage) {
    var page = initialPage;
    var history = []; // Track what we've done
    var maxTurns = 25;

    for (var turn = 0; turn < maxTurns; turn++) {
      addMsg('status', 'Thinking...');

      // Call server
      var res = await fetch(serverOrigin + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteKey: siteKey,
          visitorId: visitorId,
          conversationId: conversationId,
          goal: goal,
          page: page,
          history: history.slice(-10) // Last 10 actions only
        })
      });

      var data = await res.json();
      if (data.conversationId) {
        conversationId = data.conversationId;
        sessionStorage.setItem('_cid_' + siteKey, conversationId);
      }

      // Remove "Thinking..." status
      var lastMsg = msgs.lastChild;
      if (lastMsg && lastMsg.textContent === 'Thinking...') lastMsg.remove();

      // Handle response
      var action = data.action;
      if (!action) {
        addMsg('status', 'No action returned');
        break;
      }

      if (action.a === 'done') {
        if (action.m) addMsg('agent', action.m);
        break;
      }

      // Show what we're doing
      var desc = action.a + ' ' + (action.s || action.v || '');
      addMsg('status', desc);
      history.push(desc);

      // Execute
      var result = await execute(action);

      if (!result.ok && result.err) {
        history[history.length - 1] += ' FAILED: ' + result.err;
      }

      // New page state for next turn
      page = result.page;
    }

    if (turn >= maxTurns) {
      addMsg('status', 'Max turns reached');
    }
  }

})();`;
}
