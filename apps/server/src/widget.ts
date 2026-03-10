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

  // ── state ────────────────────────────────────────────────────────────────
  var isOpen = false;
  var isLoading = false;
  var msgCount = 0;

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

  // ═══════════════════════════════════════════════════════════════════════════
  // DOM DISTILLATION
  // Scans the host page and returns a compact, LLM-readable map of every
  // interactive element. Called just before each chat request so the agent
  // always has a fresh view of the page.
  // ═══════════════════════════════════════════════════════════════════════════
  function distillDOM() {
    var SELECTOR = [
      'button',
      'a[href]',
      'input:not([type="hidden"])',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="menuitem"]',
      '[onclick]',
    ].join(',');

    var nodeList = document.querySelectorAll(SELECTOR);
    var foldH = window.innerHeight;
    var items = [];

    for (var i = 0; i < nodeList.length; i++) {
      var el = nodeList[i];

      // Skip the widget host and everything inside it
      if (el === host || host.contains(el)) continue;

      var tag = el.tagName.toLowerCase();
      var rect = el.getBoundingClientRect();
      var cs   = window.getComputedStyle(el);

      var visible = (
        cs.display !== 'none' &&
        cs.visibility !== 'hidden' &&
        parseFloat(cs.opacity || '1') > 0 &&
        (rect.width > 0 || rect.height > 0)
      );

      var position;
      if (rect.bottom < 0) {
        position = 'above-fold';
      } else if (rect.top > foldH) {
        position = 'below-fold';
      } else {
        position = 'in-view';
      }

      // Raw text — strip extra whitespace, cap at 100 chars
      var rawText = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100);

      var entry = { tag: tag, visible: visible, position: position };

      if (el.id)                              entry.id          = el.id;
      if (rawText)                            entry.text        = rawText;
      if (el.getAttribute('placeholder'))     entry.placeholder = el.getAttribute('placeholder');
      if (el.getAttribute('aria-label'))      entry.ariaLabel   = el.getAttribute('aria-label');
      if (el.getAttribute('type'))            entry.type        = el.getAttribute('type');
      if (el.getAttribute('href'))            entry.href        = el.getAttribute('href');
      if (el.getAttribute('name'))            entry.name        = el.getAttribute('name');
      if (el.getAttribute('role'))            entry.role        = el.getAttribute('role');
      if (el.getAttribute('aria-expanded'))   entry.expanded    = el.getAttribute('aria-expanded');
      if (el.getAttribute('aria-checked'))    entry.checked     = el.getAttribute('aria-checked');
      if (el.getAttribute('disabled') !== null && el.getAttribute('disabled') !== undefined && el.hasAttribute('disabled')) entry.disabled = true;

      // First 3 class names only
      var classes = (el.className || '').toString().split(/\\s+/).filter(Boolean).slice(0, 3).join(' ');
      if (classes) entry.classes = classes;

      // Current value for inputs/selects (useful for knowing form state)
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        var val = el.value;
        if (val && val.length <= 200) entry.value = val;
      }

      items.push({ entry: entry, visible: visible, position: position });
    }

    // Sort: in-view + visible first, then in-view hidden, then out-of-view
    items.sort(function (a, b) {
      var score = function (x) {
        return (x.visible ? 4 : 0) + (x.position === 'in-view' ? 2 : x.position === 'below-fold' ? 1 : 0);
      };
      return score(b) - score(a);
    });

    // Cap at 150 elements to keep the prompt token-efficient
    return items.slice(0, 150).map(function (x) { return x.entry; });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTION EXECUTORS
  // These will be called by the agent loop once the server returns actions.
  // Each returns true on success, false if the target element wasn't found.
  // ═══════════════════════════════════════════════════════════════════════════

  function findEl(selector) {
    try { return document.querySelector(selector); }
    catch (e) { return null; }
  }

  /** Click any element on the page by CSS selector. */
  function clickElement(selector) {
    var el = findEl(selector);
    if (!el) return false;
    el.focus();
    el.click();
    return true;
  }

  /**
   * Type text into an input or textarea.
   * Uses the native value setter so React/Vue synthetic events fire correctly.
   */
  function typeInElement(selector, text) {
    var el = findEl(selector);
    if (!el) return false;
    el.focus();
    // Native setter triggers framework onChange handlers
    var proto = el.tagName.toLowerCase() === 'textarea'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, text);
    } else {
      el.value = text;
    }
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /** Smoothly scroll a specific element into the centre of the viewport. */
  function scrollToElement(selector) {
    var el = findEl(selector);
    if (!el) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  }

  /** Scroll the page up or down by ~70 % of the viewport height. */
  function scrollPage(direction) {
    var delta = window.innerHeight * 0.7;
    window.scrollBy({ top: direction === 'down' ? delta : -delta, behavior: 'smooth' });
    return true;
  }

  // Expose on window so the agent loop (future) can invoke them externally
  window.__agentActions = {
    clickElement:    clickElement,
    typeInElement:   typeInElement,
    scrollToElement: scrollToElement,
    scrollPage:      scrollPage,
    distillDOM:      distillDOM,
  };

  // ── CSS ──────────────────────────────────────────────────────────────────
  var styleEl = document.createElement('style');
  styleEl.textContent = [
    '*{box-sizing:border-box;margin:0;padding:0;}',

    // ── toggle button ──
    '.btn{',
    '  width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;',
    '  background:#18181b;border:1px solid rgba(255,255,255,0.1);',
    '  display:flex;align-items:center;justify-content:center;',
    '  box-shadow:0 4px 20px rgba(0,0,0,0.5),0 1px 0 rgba(255,255,255,0.06) inset;',
    '  position:relative;z-index:2;transition:background .18s,box-shadow .18s,transform .14s;',
    '}',
    '.btn:hover{background:#222226;box-shadow:0 6px 28px rgba(0,0,0,0.6);}',
    '.btn:active{transform:scale(0.93);}',
    '.btn .ic{position:absolute;transition:opacity .18s,transform .22s;}',
    '.btn .ic-chat{opacity:1;transform:scale(1) rotate(0);}',
    '.btn .ic-close{opacity:0;transform:scale(0.5) rotate(-60deg);}',
    '.btn.open .ic-chat{opacity:0;transform:scale(0.5) rotate(60deg);}',
    '.btn.open .ic-close{opacity:1;transform:scale(1) rotate(0);}',

    // ── panel ──
    '.panel{',
    '  position:absolute;bottom:64px;right:0;',
    '  width:368px;height:540px;',
    '  background:#0c0c0e;',
    '  border:1px solid rgba(255,255,255,0.08);',
    '  border-radius:16px;overflow:hidden;',
    '  box-shadow:0 16px 64px rgba(0,0,0,0.7),0 1px 0 rgba(255,255,255,0.05) inset;',
    '  display:flex;flex-direction:column;',
    '  opacity:0;transform:translateY(12px) scale(0.96);',
    '  transition:opacity .22s cubic-bezier(.16,1,.3,1),transform .22s cubic-bezier(.16,1,.3,1);',
    '  pointer-events:none;',
    '}',
    '.panel.open{opacity:1;transform:translateY(0) scale(1);pointer-events:all;}',

    // ── header ──
    '.hdr{',
    '  padding:14px 16px;flex-shrink:0;',
    '  background:#111114;border-bottom:1px solid rgba(255,255,255,0.06);',
    '  display:flex;align-items:center;gap:10px;',
    '}',
    '.hdr-dot{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 7px rgba(34,197,94,.55);flex-shrink:0;}',
    '.hdr-name{color:#f4f4f5;font-size:13px;font-weight:500;letter-spacing:-.01em;}',
    '.hdr-status{color:#52525b;font-size:11px;margin-left:auto;}',

    // ── messages ──
    '.msgs{',
    '  flex:1;overflow-y:auto;padding:16px 14px;',
    '  display:flex;flex-direction:column;gap:8px;',
    '}',
    '.msgs::-webkit-scrollbar{width:3px;}',
    '.msgs::-webkit-scrollbar-track{background:transparent;}',
    '.msgs::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:3px;}',

    // empty state
    '.empty{flex:1;display:flex;align-items:center;justify-content:center;}',
    '.empty p{color:#3f3f46;font-size:13px;}',

    // message rows
    '.msg{display:flex;flex-direction:column;max-width:82%;animation:fi .16s ease;}',
    '@keyframes fi{from{opacity:0;transform:translateY(5px);}to{opacity:1;transform:translateY(0);}}',
    '.msg.u{align-self:flex-end;align-items:flex-end;}',
    '.msg.a{align-self:flex-start;align-items:flex-start;}',
    '.msg.err{align-self:center;}',

    '.bbl{padding:9px 13px;font-size:13px;line-height:1.55;word-break:break-word;white-space:pre-wrap;color:#e4e4e7;}',
    '.msg.u .bbl{background:#27272a;border:1px solid rgba(255,255,255,0.07);border-radius:13px 13px 3px 13px;}',
    '.msg.a .bbl{background:#18181b;border:1px solid rgba(255,255,255,0.06);border-radius:13px 13px 13px 3px;}',
    '.msg.err .bbl{background:transparent;color:#71717a;font-size:12px;padding:2px 0;}',

    // typing indicator
    '.typing{align-self:flex-start;}',
    '.typing .bbl{display:flex;gap:4px;align-items:center;padding:12px 16px;}',
    '.dot{width:5px;height:5px;border-radius:50%;background:#3f3f46;animation:bns 1.2s ease infinite;}',
    '.dot:nth-child(2){animation-delay:.15s;}',
    '.dot:nth-child(3){animation-delay:.3s;}',
    '@keyframes bns{0%,60%,100%{transform:translateY(0);}30%{transform:translateY(-5px);}}',

    // ── footer ──
    '.ftr{',
    '  padding:10px 12px;flex-shrink:0;',
    '  background:#0c0c0e;border-top:1px solid rgba(255,255,255,0.06);',
    '  display:flex;gap:8px;align-items:flex-end;',
    '}',
    '.inp{',
    '  flex:1;background:#18181b;border:1px solid rgba(255,255,255,0.09);',
    '  border-radius:10px;padding:9px 12px;',
    '  color:#e4e4e7;font-size:13px;font-family:inherit;line-height:1.45;',
    '  outline:none;resize:none;min-height:38px;max-height:120px;',
    '  overflow-y:auto;transition:border-color .15s;',
    '}',
    '.inp::placeholder{color:#3f3f46;}',
    '.inp:focus{border-color:rgba(255,255,255,0.18);}',
    '.snd{',
    '  width:36px;height:36px;flex-shrink:0;',
    '  border:none;border-radius:9px;cursor:pointer;',
    '  background:#e4e4e7;display:flex;align-items:center;justify-content:center;',
    '  transition:background .14s,transform .12s;',
    '}',
    '.snd:hover:not(:disabled){background:#fff;}',
    '.snd:active:not(:disabled){transform:scale(0.91);}',
    '.snd:disabled{background:#27272a;cursor:default;}',
    '.snd:disabled path{fill:#52525b;}',
  ].join('\\n');
  shadow.appendChild(styleEl);

  // ── DOM ──────────────────────────────────────────────────────────────────
  var wrap = document.createElement('div');
  wrap.innerHTML = [
    // toggle button
    '<button class="btn" id="btn" aria-label="Open chat">',
    '  <svg class="ic ic-chat" width="22" height="22" viewBox="0 0 24 24" fill="none">',
    '    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"',
    '      stroke="#a1a1aa" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/>',
    '  </svg>',
    '  <svg class="ic ic-close" width="18" height="18" viewBox="0 0 24 24" fill="none">',
    '    <path d="M18 6 6 18M6 6l12 12" stroke="#a1a1aa" stroke-width="2" stroke-linecap="round"/>',
    '  </svg>',
    '</button>',

    // chat panel
    '<div class="panel" id="panel" role="dialog" aria-label="Chat">',

    // header
    '  <div class="hdr">',
    '    <div class="hdr-dot"></div>',
    '    <span class="hdr-name">Agent</span>',
    '    <span class="hdr-status">Online</span>',
    '  </div>',

    // messages
    '  <div class="msgs" id="msgs">',
    '    <div class="empty" id="empty"><p>How can I help you?</p></div>',
    '  </div>',

    // footer
    '  <div class="ftr">',
    '    <textarea class="inp" id="inp" placeholder="Message..." rows="1"></textarea>',
    '    <button class="snd" id="snd" disabled aria-label="Send">',
    '      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">',
    '        <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"',
    '          stroke="#09090b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    '      </svg>',
    '    </button>',
    '  </div>',
    '</div>',
  ].join('');
  shadow.appendChild(wrap);

  // ── element refs ─────────────────────────────────────────────────────────
  var btn   = shadow.getElementById('btn');
  var panel = shadow.getElementById('panel');
  var msgs  = shadow.getElementById('msgs');
  var inp   = shadow.getElementById('inp');
  var snd   = shadow.getElementById('snd');
  var empty = shadow.getElementById('empty');

  // ── UI helpers ───────────────────────────────────────────────────────────
  function scrollBottom() {
    msgs.scrollTop = msgs.scrollHeight;
  }

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
    return row;
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

  // ── toggle open/close ────────────────────────────────────────────────────
  function toggle() {
    isOpen = !isOpen;
    btn.classList.toggle('open', isOpen);
    panel.classList.toggle('open', isOpen);
    btn.setAttribute('aria-label', isOpen ? 'Close chat' : 'Open chat');
    if (isOpen) {
      setTimeout(function () { inp.focus(); }, 240);
    }
  }

  btn.addEventListener('click', toggle);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen) toggle();
  });

  // ── send message ─────────────────────────────────────────────────────────
  inp.addEventListener('input', function () {
    inp.style.height = 'auto';
    inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
    snd.disabled = isLoading || inp.value.trim() === '';
  });

  inp.addEventListener('keydown', function (e) {
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
    snd.disabled = true;

    setLoading(true);
    showTyping();

    var body = JSON.stringify({
      siteKey:  siteKey,
      visitorId: visitorId,
      message:  text,
      dom:      distillDOM(),
    });

    fetch(serverOrigin + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        removeTyping();
        appendMessage('a', data.reply || data.message || '');
      })
      .catch(function (err) {
        removeTyping();
        appendMessage('err', 'Something went wrong. Please try again.');
        console.error('[agent widget]', err);
      })
      .finally(function () {
        setLoading(false);
      });
  }
})();`;
}
