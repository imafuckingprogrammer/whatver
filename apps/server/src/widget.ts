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
      if (/\/embed\/.+\.js/.test(all[i].src)) { scriptEl = all[i]; break; }
    }
  }
  if (!scriptEl) return;

  var serverOrigin = scriptEl.src.replace(/\/embed\/.+$/, '');
  var siteKey = (scriptEl.src.match(/\/embed\/(.+?)\.js/) || [])[1];
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

  // ═══════════════════════════════════════════════════════════════════════════
  // DOM DISTILLATION
  // ═══════════════════════════════════════════════════════════════════════════
  function distillDOM() {
    var SELECTOR = [
      'button', 'a[href]', 'input:not([type="hidden"])', 'textarea', 'select',
      '[role="button"]', '[role="link"]', '[role="checkbox"]',
      '[role="radio"]', '[role="menuitem"]', '[onclick]',
    ].join(',');

    var nodeList = document.querySelectorAll(SELECTOR);
    var foldH = window.innerHeight;
    var items = [];

    for (var i = 0; i < nodeList.length; i++) {
      var el = nodeList[i];
      if (el === host || host.contains(el)) continue;

      var tag  = el.tagName.toLowerCase();
      var rect = el.getBoundingClientRect();
      var cs   = window.getComputedStyle(el);

      var visible = (
        cs.display !== 'none' &&
        cs.visibility !== 'hidden' &&
        parseFloat(cs.opacity || '1') > 0 &&
        (rect.width > 0 || rect.height > 0)
      );

      var position = rect.bottom < 0 ? 'above-fold' : rect.top > foldH ? 'below-fold' : 'in-view';
      var rawText  = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      var entry    = { tag: tag, visible: visible, position: position };

      if (el.id)                            entry.id          = el.id;
      if (rawText)                          entry.text        = rawText;
      if (el.getAttribute('placeholder'))   entry.placeholder = el.getAttribute('placeholder');
      if (el.getAttribute('aria-label'))    entry.ariaLabel   = el.getAttribute('aria-label');
      if (el.getAttribute('type'))          entry.type        = el.getAttribute('type');
      if (el.getAttribute('href'))          entry.href        = el.getAttribute('href');
      if (el.getAttribute('name'))          entry.name        = el.getAttribute('name');
      if (el.getAttribute('role'))          entry.role        = el.getAttribute('role');
      if (el.getAttribute('aria-expanded')) entry.expanded    = el.getAttribute('aria-expanded');
      if (el.getAttribute('aria-checked'))  entry.checked     = el.getAttribute('aria-checked');
      if (el.hasAttribute('disabled'))      entry.disabled    = true;

      var classes = (el.className || '').toString().split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
      if (classes) entry.classes = classes;

      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        var val = el.value;
        if (val && val.length <= 200) entry.value = val;
      }

      items.push({ entry: entry, visible: visible, position: position });
    }

    items.sort(function (a, b) {
      var score = function (x) {
        return (x.visible ? 4 : 0) + (x.position === 'in-view' ? 2 : x.position === 'below-fold' ? 1 : 0);
      };
      return score(b) - score(a);
    });

    return items.slice(0, 150).map(function (x) { return x.entry; });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTION EXECUTORS
  // ═══════════════════════════════════════════════════════════════════════════
  function findEl(selector) {
    try { return document.querySelector(selector); } catch (e) { return null; }
  }

  function clickElement(selector) {
    var el = findEl(selector);
    if (!el) return false;
    el.focus(); el.click();
    return true;
  }

  function typeInElement(selector, text) {
    var el = findEl(selector);
    if (!el) return false;
    el.focus();
    var proto = el.tagName.toLowerCase() === 'textarea'
      ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) { descriptor.set.call(el, text); } else { el.value = text; }
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
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

  window.__agentActions = { clickElement: clickElement, typeInElement: typeInElement,
    scrollToElement: scrollToElement, scrollPage: scrollPage, distillDOM: distillDOM };

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
    // action step pills
    '.msg.act{align-self:center;max-width:94%;}',
    '.msg.act .bbl{background:rgba(255,255,255,0.03);color:#52525b;font-size:11.5px;',
    '  padding:3px 10px;border-radius:20px;border:1px solid rgba(255,255,255,0.06);}',
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
  ].join('\n');
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

  // ── action execution ─────────────────────────────────────────────────────
  function executeActions(actions, onComplete) {
    if (!actions || actions.length === 0) { onComplete(); return; }
    var idx = 0;
    function next() {
      if (idx >= actions.length) { setTimeout(onComplete, 800); return; }
      var action = actions[idx++];
      try {
        if      (action.type === 'click')  { clickElement(action.selector); }
        else if (action.type === 'type')   { typeInElement(action.selector, action.text || ''); }
        else if (action.type === 'scroll') {
          if (action.selector) { scrollToElement(action.selector); }
          else                 { scrollPage(action.direction || 'down'); }
        }
      } catch (e) { console.error('[agent widget] action error:', action, e); }
      setTimeout(next, 700);
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
      for (var i = 0; i < actions.length; i++) {
        if (actions[i].description) {
          appendMessage('act', '\u2192 ' + actions[i].description);
        }
      }
      executeActions(actions, function () {
        if (data.done) { setLoading(false); loopCount = 0; }
        else           { sendContinuation(); }
      });
    } else {
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
