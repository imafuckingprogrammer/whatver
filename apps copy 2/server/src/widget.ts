/**
 * Embeddable AI Agent Widget
 * Clean architecture: Core Loop → Infrastructure → Tools → UI
 */
export function getWidgetScript(): string {
  return `(function() {
  'use strict';

  console.log('[widget] v5 loaded');

  // ════════════════════════════════════════════════════════════════════════════
  // CONFIG
  // ════════════════════════════════════════════════════════════════════════════

  var script = document.currentScript || document.querySelector('script[src*="/embed/"]');
  if (!script) return;

  var SERVER = script.src.replace(/\\/embed\\/.+$/, '');
  var SITE_KEY = (script.src.match(/\\/embed\\/([^.]+)\\.js/) || [])[1];
  if (!SITE_KEY) return;

  var MAX_TURNS = 20;
  var VID_KEY = '_ag_vid_' + SITE_KEY;
  var CID_KEY = '_ag_cid_' + SITE_KEY;

  // ════════════════════════════════════════════════════════════════════════════
  // STATE
  // ════════════════════════════════════════════════════════════════════════════

  var visitorId = sessionStorage.getItem(VID_KEY) ||
    ('v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  sessionStorage.setItem(VID_KEY, visitorId);

  var conversationId = sessionStorage.getItem(CID_KEY) || null;
  var elementMap = {};
  var running = false;

  // ════════════════════════════════════════════════════════════════════════════
  //
  //   INFRASTRUCTURE LAYER
  //   - DOM extraction
  //   - Stability detection
  //   - Network tracking
  //
  // ════════════════════════════════════════════════════════════════════════════

  var pendingRequests = 0;
  var lastActivity = Date.now();

  // Track fetch requests
  var origFetch = window.fetch;
  window.fetch = function() {
    pendingRequests++;
    lastActivity = Date.now();
    return origFetch.apply(this, arguments).finally(function() {
      pendingRequests--;
      lastActivity = Date.now();
    });
  };

  // Track XHR requests
  var origXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function() {
    var xhr = this;
    pendingRequests++;
    lastActivity = Date.now();
    xhr.addEventListener('loadend', function() {
      pendingRequests--;
      lastActivity = Date.now();
    });
    return origXHRSend.apply(this, arguments);
  };

  function waitForStable(minQuiet, maxWait) {
    minQuiet = minQuiet || 500;
    maxWait = maxWait || 5000;
    var startUrl = location.href;

    return new Promise(function(resolve) {
      var start = Date.now();
      var checkCount = 0;

      var observer = new MutationObserver(function() {
        lastActivity = Date.now();
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });

      function check() {
        checkCount++;
        var now = Date.now();
        var elapsed = now - start;
        var quiet = now - lastActivity;
        var idle = pendingRequests === 0;

        // URL changed = reset
        if (location.href !== startUrl) {
          console.log('[stable] URL changed:', startUrl, '->', location.href);
          startUrl = location.href;
          lastActivity = now;
          start = now;
        }

        // Stable when: quiet period AND no pending requests
        if ((quiet >= minQuiet && idle) || elapsed >= maxWait) {
          observer.disconnect();
          console.log('[stable] Done after', elapsed, 'ms, checks:', checkCount, 'pending:', pendingRequests);
          resolve();
        } else {
          if (checkCount % 20 === 0) {
            console.log('[stable] Waiting... elapsed:', elapsed, 'quiet:', quiet, 'pending:', pendingRequests);
          }
          setTimeout(check, 50);
        }
      }

      setTimeout(check, 100);
    });
  }

  function extractDOM() {
    var vw = window.innerWidth, vh = window.innerHeight;
    elementMap = {};
    var idx = 1;
    var lines = [];

    lines.push('URL: ' + location.href);
    lines.push('TITLE: ' + (document.title || ''));
    lines.push('');

    function isVisible(el) {
      if (!el || widgetHost.contains(el)) return false;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      var cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0;
    }

    function inViewport(rect) {
      return rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
    }

    // Text content
    var seen = {};
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function(n) {
        if (widgetHost.contains(n)) return NodeFilter.FILTER_REJECT;
        var t = (n.textContent || '').trim();
        if (!t) return NodeFilter.FILTER_REJECT;
        // Keep numbers (even single digits) and text 2+ chars
        if (t.length < 2 && !/\\d/.test(t)) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (!p || p.tagName === 'SCRIPT' || p.tagName === 'STYLE') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    var node;
    while ((node = walker.nextNode())) {
      var range = document.createRange();
      range.selectNodeContents(node);
      var rect = range.getBoundingClientRect();
      if (!inViewport(rect)) continue;

      var text = node.textContent.trim();
      if (seen[text]) continue;

      var parent = node.parentElement;
      if (!isVisible(parent)) continue;
      if (parent.closest('button, a, input, textarea, select')) continue;

      seen[text] = true;
      var tag = parent.tagName;
      if (tag === 'H1') lines.push('#1 ' + text.slice(0, 80));
      else if (tag === 'H2') lines.push('#2 ' + text.slice(0, 70));
      else if (tag === 'H3') lines.push('#3 ' + text.slice(0, 60));
      else if (/^\\d+$/.test(text)) lines.push('> ' + text + ' (number)');
      else if (text.length > 3) lines.push('> ' + text.slice(0, 80));
    }

    lines.push('');
    lines.push('ELEMENTS:');

    // Interactive elements
    var els = document.querySelectorAll(
      'button, a[href], input:not([type=hidden]), textarea, select, ' +
      '[role=button], [role=link], [role=checkbox], [role=tab], [onclick]'
    );

    for (var i = 0; i < els.length && idx <= 50; i++) {
      var el = els[i];
      if (!isVisible(el)) continue;
      var rect = el.getBoundingClientRect();
      if (!inViewport(rect)) continue;

      elementMap[idx] = el;
      var tag = el.tagName;
      var line = '[' + idx + ']';

      if (tag === 'BUTTON' || el.getAttribute('role') === 'button') line += 'button';
      else if (tag === 'A') line += 'link';
      else if (tag === 'INPUT') line += 'input[' + (el.type || 'text') + ']';
      else if (tag === 'TEXTAREA') line += 'textarea';
      else if (tag === 'SELECT') line += 'select';
      else line += tag.toLowerCase();

      var label = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30) ||
                  el.getAttribute('aria-label') || el.placeholder || '';
      if (label) line += '"' + label + '"';

      if ((tag === 'INPUT' || tag === 'TEXTAREA') && el.value) {
        line += '="' + el.value.slice(0, 20) + '"';
      }

      lines.push(line);
      idx++;
    }

    if (document.documentElement.scrollHeight > vh + 100) {
      lines.push('[more content below]');
    }

    return lines.join('\\n');
  }

  // ════════════════════════════════════════════════════════════════════════════
  //
  //   TOOLS LAYER
  //   - Actions the agent can take
  //   - Each returns { ok, msg, nav }
  //
  // ════════════════════════════════════════════════════════════════════════════

  var tools = {
    click: function(index) {
      console.log('[tool] click(' + index + ') called');
      return new Promise(function(resolve) {
        try {
          var el = elementMap[index];
          if (!el) {
            console.log('[tool] click: element not found');
            resolve({ ok: false, msg: 'Element ' + index + ' not found', nav: false });
            return;
          }

          var label = (el.textContent || '').trim().slice(0, 25);
          var isNav = el.tagName === 'A' || el.type === 'submit' || el.closest('a');
          console.log('[tool] click: found element "' + label + '", isNav=' + isNav);

          try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(e) {
            console.log('[tool] click: scrollIntoView error (ignored):', e.message);
          }
          ui.highlight(el);

          setTimeout(function() {
            console.log('[tool] click: executing click after delay');
            try {
              el.focus();
              el.click();
              console.log('[tool] click: success');
              resolve({ ok: true, msg: 'Clicked "' + label + '"', nav: isNav });
            } catch (e) {
              console.log('[tool] click: click failed:', e.message);
              resolve({ ok: false, msg: 'Click failed', nav: true });
            }
          }, 150);
        } catch (e) {
          console.log('[tool] click: outer error:', e.message);
          resolve({ ok: false, msg: 'Click error: ' + e.message, nav: false });
        }
      });
    },

    type: function(index, text) {
      try {
        var el = elementMap[index];
        if (!el) return { ok: false, msg: 'Element ' + index + ' not found', nav: false };

        el.focus();
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, text || '');
        else el.value = text || '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, msg: 'Typed "' + (text || '').slice(0, 20) + '"', nav: false };
      } catch (e) {
        return { ok: false, msg: 'Type error: ' + e.message, nav: false };
      }
    },

    select: function(index, value) {
      try {
        var el = elementMap[index];
        if (!el) return { ok: false, msg: 'Element ' + index + ' not found', nav: false };

        var search = (value || '').toLowerCase();
        for (var i = 0; i < el.options.length; i++) {
          if (el.options[i].text.toLowerCase().includes(search)) {
            el.selectedIndex = i;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, msg: 'Selected "' + el.options[i].text + '"', nav: false };
          }
        }
        return { ok: false, msg: 'Option not found', nav: false };
      } catch (e) {
        return { ok: false, msg: 'Select error: ' + e.message, nav: false };
      }
    },

    scroll: function(direction) {
      try {
        var amount = direction === 'up' ? -500 : 500;
        window.scrollBy({ top: amount, behavior: 'smooth' });
        return { ok: true, msg: 'Scrolled ' + (direction || 'down'), nav: false };
      } catch (e) {
        return { ok: false, msg: 'Scroll error', nav: false };
      }
    }
  };

  function executeAction(action) {
    if (action.type === 'click') return tools.click(action.index);
    if (action.type === 'type') return tools.type(action.index, action.text);
    if (action.type === 'select') return tools.select(action.index, action.value || action.text);
    if (action.type === 'scroll') return tools.scroll(action.direction);
    if (action.type === 'complete') return { ok: true, msg: action.result || 'Done', nav: false, complete: true };
    return { ok: false, msg: 'Unknown action', nav: false };
  }

  // ════════════════════════════════════════════════════════════════════════════
  //
  //   UI LAYER
  //   - Widget panel
  //   - Messages
  //   - Visual feedback
  //
  // ════════════════════════════════════════════════════════════════════════════

  var widgetHost = document.createElement('div');
  widgetHost.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;font-family:system-ui,sans-serif';
  document.body.appendChild(widgetHost);

  var shadow = widgetHost.attachShadow({ mode: 'closed' });
  shadow.innerHTML = \`
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      .fab{width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;background:#18181b;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(0,0,0,0.4)}
      .fab:hover{transform:scale(1.05)}
      .fab svg{stroke:#a1a1aa;fill:none}
      .panel{position:absolute;bottom:64px;right:0;width:380px;height:520px;background:#09090b;border:1px solid rgba(255,255,255,0.1);border-radius:16px;display:none;flex-direction:column;overflow:hidden}
      .panel.open{display:flex}
      .hdr{padding:14px 16px;background:#111;border-bottom:1px solid rgba(255,255,255,0.08);color:#e4e4e7;font-size:13px;font-weight:500;display:flex;align-items:center;gap:8px}
      .dot{width:8px;height:8px;border-radius:50%;background:#22c55e}
      .dot.active{background:#8b5cf6;animation:pulse 1.5s infinite}
      @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
      .msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
      .msg{max-width:85%;padding:10px 14px;border-radius:12px;font-size:13px;line-height:1.5}
      .msg.user{align-self:flex-end;background:#27272a;color:#e4e4e7}
      .msg.agent{align-self:flex-start;background:#18181b;color:#e4e4e7}
      .msg.step{align-self:flex-start;color:#a1a1aa;font-size:12px;padding:6px 0;display:flex;align-items:center;gap:8px}
      .msg.step::before{content:'';width:16px;height:16px;border-radius:50%;border:2px solid #8b5cf6;border-top-color:transparent;animation:spin 0.8s linear infinite}
      .msg.step.done::before{border:none;background:#22c55e;animation:none}
      @keyframes spin{to{transform:rotate(360deg)}}
      .ftr{padding:12px;border-top:1px solid rgba(255,255,255,0.08);display:flex;gap:8px}
      .inp{flex:1;background:#18181b;border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:10px 12px;color:#e4e4e7;font-size:13px;outline:none;resize:none}
      .inp::placeholder{color:#52525b}
      .snd{width:36px;height:36px;border-radius:8px;border:none;cursor:pointer;background:#e4e4e7;display:flex;align-items:center;justify-content:center}
      .snd:disabled{background:#27272a;cursor:default}
      .snd svg{stroke:#18181b;fill:none}
      .snd:disabled svg{stroke:#52525b}
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

  var ui = {
    fab: shadow.getElementById('fab'),
    panel: shadow.getElementById('panel'),
    msgs: shadow.getElementById('msgs'),
    inp: shadow.getElementById('inp'),
    snd: shadow.getElementById('snd'),
    dot: shadow.getElementById('dot'),

    toggle: function() {
      this.panel.classList.toggle('open');
      if (this.panel.classList.contains('open')) this.inp.focus();
    },

    setActive: function(on) {
      if (on) this.dot.classList.add('active');
      else this.dot.classList.remove('active');
    },

    addMsg: function(type, text) {
      var div = document.createElement('div');
      div.className = 'msg ' + type;
      div.textContent = text || '';
      this.msgs.appendChild(div);
      this.msgs.scrollTop = this.msgs.scrollHeight;
      return div;
    },

    highlight: function(el) {
      if (!el) return;
      try {
        el.style.outline = '2px solid #8b5cf6';
        el.style.outlineOffset = '2px';
        setTimeout(function() {
          try { el.style.outline = ''; el.style.outlineOffset = ''; } catch(e) {}
        }, 500);
      } catch(e) {}
    }
  };

  ui.fab.onclick = function() { ui.toggle(); };

  // ════════════════════════════════════════════════════════════════════════════
  //
  //   CORE LOOP
  //   - Dead simple
  //   - Extract → Plan → Act → Observe → Repeat
  //
  // ════════════════════════════════════════════════════════════════════════════

  async function runLoop(task) {
    console.log('[loop] ═══════════════════════════════════════');
    console.log('[loop] STARTING TASK:', task);

    if (running) {
      console.log('[loop] Already running, aborting');
      return;
    }
    running = true;
    ui.setActive(true);

    var turn = 0;
    var stepEl = null;
    var observation = '';

    try {
      while (turn < MAX_TURNS) {
        turn++;
        console.log('[loop] ─────────────────────────────────────');
        console.log('[loop] TURN', turn, 'of', MAX_TURNS);

        // 1. Wait for page to settle
        console.log('[loop] Waiting for stability...');
        await waitForStable(500, 5000);
        console.log('[loop] Page stable');

        // 2. Extract current state
        var dom = extractDOM();
        console.log('[loop] DOM extracted:', dom.length, 'chars');
        console.log('[loop] URL:', location.href);

        // 3. Call server
        console.log('[loop] Calling server...');
        var response;
        try {
          var body = {
            siteKey: SITE_KEY,
            visitorId: visitorId,
            conversationId: conversationId,
            dom: dom,
            currentUrl: location.href,
            turnType: turn === 1 ? 'new' : 'observation',
            message: turn === 1 ? task : undefined,
            observation: turn === 1 ? undefined : observation
          };

          var res = await fetch(SERVER + '/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });

          console.log('[loop] Server response status:', res.status);

          if (!res.ok) throw new Error('HTTP ' + res.status);
          response = await res.json();
          console.log('[loop] Server response received');
        } catch (e) {
          console.error('[loop] SERVER ERROR:', e);
          ui.addMsg('agent', 'Connection error. Please try again.');
          break;
        }

        // 4. Save conversation
        if (response.conversationId) {
          conversationId = response.conversationId;
          sessionStorage.setItem(CID_KEY, conversationId);
        }

        var actions = response.actions || [];
        var speak = response.speak || '';
        var done = response.done;

        console.log('[loop] Response: done=' + done + ', actions=' + actions.length + ', speak="' + speak.slice(0, 50) + '"');
        console.log('[loop] Actions:', JSON.stringify(actions));

        // 5. Check completion
        if (done) {
          console.log('[loop] DONE flag is true, completing');
          if (stepEl) stepEl.classList.add('done');
          var msg = actions.find(function(a) { return a.type === 'complete'; });
          ui.addMsg('agent', msg ? msg.result : 'Task completed.');
          break;
        }

        // 6. No actions = stuck
        if (actions.length === 0) {
          console.log('[loop] NO ACTIONS, breaking');
          if (stepEl) stepEl.classList.add('done');
          ui.addMsg('agent', speak || 'I\\'m not sure what to do next.');
          break;
        }

        // 7. Show step
        if (stepEl) stepEl.classList.add('done');
        stepEl = ui.addMsg('step', speak || actions[0].type + '...');

        // 8. Execute actions
        console.log('[loop] Executing', actions.length, 'actions');
        var results = [];
        var hitNav = false;

        for (var i = 0; i < actions.length && !hitNav; i++) {
          var action = actions[i];
          console.log('[loop] Executing action', i + 1, ':', action.type, action.index || '');

          try {
            var result = await executeAction(action);
            results.push(result.msg);
            console.log('[loop] Action result:', result.msg, 'nav=' + result.nav);

            if (result.complete) {
              console.log('[loop] Action returned complete');
              if (stepEl) stepEl.classList.add('done');
              ui.addMsg('agent', action.result || 'Done!');
              running = false;
              ui.setActive(false);
              return;
            }

            if (result.nav) {
              console.log('[loop] Navigation detected, will wait');
              hitNav = true;
            }
          } catch (actionErr) {
            console.error('[loop] ACTION ERROR:', actionErr);
            results.push('Error: ' + actionErr.message);
          }
        }

        observation = results.join('; ');
        console.log('[loop] Observation for next turn:', observation);

        // 9. Extra wait after navigation
        if (hitNav) {
          console.log('[loop] Extra wait for navigation...');
          await waitForStable(800, 6000);
          console.log('[loop] Navigation wait complete');
        }

        console.log('[loop] Turn', turn, 'complete, continuing loop');
      }

      if (turn >= MAX_TURNS) {
        console.log('[loop] MAX TURNS reached');
        if (stepEl) stepEl.classList.add('done');
        ui.addMsg('agent', 'Reached max steps. Please try a simpler task.');
      }

    } catch (loopErr) {
      console.error('[loop] FATAL ERROR:', loopErr);
      ui.addMsg('agent', 'Error: ' + loopErr.message);
    }

    console.log('[loop] LOOP ENDED');
    running = false;
    ui.setActive(false);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //
  //   INPUT & HISTORY
  //
  // ════════════════════════════════════════════════════════════════════════════

  ui.inp.oninput = function() {
    ui.snd.disabled = !ui.inp.value.trim() || running;
  };

  ui.inp.onkeydown = function(e) {
    if (e.key === 'Enter' && !e.shiftKey && !ui.snd.disabled) {
      e.preventDefault();
      send();
    }
  };

  ui.snd.onclick = send;

  function send() {
    var text = ui.inp.value.trim();
    if (!text || running) return;

    conversationId = null;
    sessionStorage.removeItem(CID_KEY);

    ui.addMsg('user', text);
    ui.inp.value = '';
    ui.snd.disabled = true;
    runLoop(text);
  }

  async function loadHistory() {
    if (!conversationId) return;
    try {
      var res = await fetch(SERVER + '/api/chat/history?siteKey=' + SITE_KEY + '&conversationId=' + conversationId);
      if (!res.ok) return;
      var data = await res.json();
      (data.messages || []).forEach(function(m) {
        if (m.type === 'user') ui.addMsg('user', m.content);
        else if (m.type === 'agent') ui.addMsg('agent', m.content);
        else if (m.type === 'step') {
          var el = ui.addMsg('step', m.content);
          el.classList.add('done');
        }
      });
    } catch (e) {
      console.log('[history] Load failed:', e);
    }
  }

  loadHistory();

  // Debug shortcut: Ctrl+. = copy DOM to clipboard
  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.key === '.') {
      e.preventDefault();
      var dom = extractDOM();
      try {
        navigator.clipboard.writeText(dom);
        console.log('[debug] ═══════════════════════════════════');
        console.log('[debug] DOM copied! (' + dom.length + ' chars)');
        console.log('[debug] ═══════════════════════════════════');
        console.log(dom);
      } catch(err) {
        console.log('[debug] DOM (clipboard failed):');
        console.log(dom);
      }
    }
  });

})();`;
}
