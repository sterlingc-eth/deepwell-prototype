/* DeepWell Help widget (round 28). Vanilla, same-origin only (POST /api/support), no eval, no inline handlers.
   The launcher is built at load; the panel is built on first open. Nothing is stored server-side. */
(function () {
  'use strict';
  if (window.__dwHelp || !document.body) return;
  window.__dwHelp = true;
  var API = '/api/support', MAX = 600, TURNS = 12, KEY = 'dwh.v1', SURFACE = 'public';
  var NS = 'http://www.w3.org/2000/svg';
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var mobileMQ = window.matchMedia ? matchMedia('(max-width: 560px)') : { matches: false };
  var DEFAULT_SUGG = ['How much does DeepWell cost?', 'Is there a free trial?', 'How does DeepWell work?', 'Is my data secure?'];
  var GREETING = "Hi, I'm the DeepWell Support Assistant, an AI. Ask me about plans and pricing, how setup works, the phone app or security.";

  var st = { open: false, built: false, busy: false, msgs: [], turns: 0, handoffShown: false, lastUser: '' };
  var root, launcher, tip, scrim, panel, log, ta, sendBtn, count, chipsEl, lastFocus;

  /* sessionStorage can be edited by the visitor (or poisoned by another script): trust only a validated shape, never the raw JSON */
  function cap(t, n) { t = String(t).slice(0, n); var c = t.charCodeAt(t.length - 1); return c >= 0xd800 && c <= 0xdbff ? t.slice(0, -1) : t; }
  function sane(v) {
    if (!v || typeof v !== 'object') return null;
    var n = Number(v.turns), out = { tip: v.tip ? 1 : 0, turns: isFinite(n) && n > 0 ? Math.min(Math.floor(n), TURNS) : 0, msgs: [] };
    if (Array.isArray(v.msgs)) v.msgs.slice(-30).forEach(function (m) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.text !== 'string') return;
      var src = Array.isArray(m.sources) ? m.sources.filter(function (x) { return x && typeof x.title === 'string'; }).slice(0, 3).map(function (x) { return { title: cap(x.title, 100) }; }) : undefined;
      out.msgs.push({ role: m.role, text: cap(m.text, 2000), sources: src && src.length ? src : undefined });
    });
    return out;
  }
  function store(get, val) {
    try { if (get) return sane(JSON.parse(sessionStorage.getItem(KEY) || 'null')); sessionStorage.setItem(KEY, JSON.stringify(val)); } catch (e) { /* private mode */ }
    return null;
  }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function attr(n, o) { for (var k in o) n.setAttribute(k, o[k]); return n; }

  /* ---------- launcher ---------- */
  function mark() {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 100 100'); s.setAttribute('aria-hidden', 'true');
    [12, 26, 40].forEach(function (r) {
      var c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', 50); c.setAttribute('cy', 50); c.setAttribute('r', r); s.appendChild(c);
    });
    return s;
  }
  function pulse(ms) {
    if (reduce || st.open) return;
    launcher.classList.add('dwh-pulse');
    setTimeout(function () { launcher.classList.remove('dwh-pulse'); }, ms);
  }
  function initLauncher() {
    root = el('div', 'dwh-root');
    launcher = attr(el('button', 'dwh-launcher'), { type: 'button', 'aria-label': 'Open DeepWell Help', 'aria-expanded': 'false', 'aria-haspopup': 'dialog' });
    launcher.appendChild(mark());
    launcher.addEventListener('click', function () { st.open ? close() : open(); });
    root.appendChild(launcher);
    document.body.appendChild(root);
    if (window.matchMedia && matchMedia('(max-width: 900px)').matches) { /* keep the launcher off the footer links */
      var host = document.querySelector('footer') || document.body;
      host.style.paddingBottom = 'calc(' + (getComputedStyle(host).paddingBottom || '0px') + ' + 76px)';
    }
    pulse(20000);
    setInterval(function () { pulse(2800 * 2); }, 45000);
    var seen = store(true);
    if (!(seen && seen.tip) && !mobileMQ.matches) setTimeout(showTip, 6000);
  }
  function showTip() {
    if (st.open || tip) return;
    tip = el('div', 'dwh-tip');
    var go = el('button', '', 'Questions? Ask us'); go.type = 'button';
    var x = attr(el('button', 'dwh-tip-x', '×'), { type: 'button', 'aria-label': 'Dismiss' });
    go.addEventListener('click', open);
    x.addEventListener('click', hideTip);
    tip.appendChild(go); tip.appendChild(x); root.appendChild(tip);
  }
  function hideTip() {
    if (tip) { tip.remove(); tip = null; }
    var s = store(true) || {}; s.tip = 1; store(false, s);
  }

  /* ---------- rendering ---------- */
  var TOKEN = /(\*\*[^*]+\*\*|https?:\/\/[^\s)<]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
  function trimUrl(u) { var m = u.match(/[.,;:!?]+$/); return m ? [u.slice(0, -m[0].length), m[0]] : [u, '']; }
  function rich(parent, text) {
    String(text).split('\n').forEach(function (line) {
      var p = el('p');
      line.split(TOKEN).forEach(function (part, i) {
        if (!part) return;
        if (i % 2 === 0) { p.appendChild(document.createTextNode(part)); return; }
        if (part.slice(0, 2) === '**') { p.appendChild(el('strong', '', part.slice(2, -2))); return; }
        var a = el('a'), tail = '';
        if (part.indexOf('@') > 0 && part.indexOf('http') !== 0) { a.href = 'mailto:' + part; a.textContent = part; }
        else {
          var t = trimUrl(part); tail = t[1]; a.textContent = t[0];
          try { var u = new URL(t[0]); if (u.protocol !== 'https:' && u.protocol !== 'http:') throw 0; a.href = u.href; }
          catch (e) { p.appendChild(document.createTextNode(part)); return; }
          a.target = '_blank'; a.rel = 'noopener noreferrer';
        }
        p.appendChild(a); if (tail) p.appendChild(document.createTextNode(tail));
      });
      parent.appendChild(p);
    });
  }
  function scroll() { log.scrollTop = log.scrollHeight; }
  function clearChips() { if (chipsEl) { chipsEl.remove(); chipsEl = null; } }
  function addMsg(role, text, sources) {
    var row = el('div', 'dwh-m ' + (role === 'user' ? 'u' : 'a'));
    if (role !== 'user') { var av = attr(el('img', 'dwh-av'), { src: '/support/logo-mark.svg', alt: '', width: 24, height: 24 }); row.appendChild(av); }
    var b = el('div', 'dwh-b'); rich(b, text);
    if (sources && sources.length) b.appendChild(el('p', 'dwh-src', 'From: ' + sources.map(function (s) { return s.title; }).join(', ')));
    row.appendChild(b); log.appendChild(row); scroll();
    return row;
  }
  function chips(list) {
    clearChips();
    if (!list || !list.length) return;
    chipsEl = el('div', 'dwh-chips');
    list.slice(0, 4).forEach(function (q) {
      var c = attr(el('button', 'dwh-chip', q), { type: 'button' });
      c.addEventListener('click', function () { send(q); });
      chipsEl.appendChild(c);
    });
    log.appendChild(chipsEl); scroll();
  }
  function typing(on) {
    var t = log.querySelector('.dwh-typing-row');
    if (!on) { if (t) t.remove(); return; }
    if (t) return;
    var row = el('div', 'dwh-m a dwh-typing-row');
    row.appendChild(attr(el('img', 'dwh-av'), { src: '/support/logo-mark.svg', alt: '', width: 24, height: 24 }));
    var b = el('div', 'dwh-b dwh-typing'); b.setAttribute('aria-label', 'Assistant is typing');
    b.appendChild(el('i')); b.appendChild(el('i')); b.appendChild(el('i'));
    row.appendChild(b); log.appendChild(row); scroll();
  }
  function persist() { var s = store(true) || {}; s.msgs = st.msgs.slice(-30); s.turns = st.turns; store(false, s); }
  function push(role, text, sources) { st.msgs.push({ role: role, text: text, sources: sources || undefined }); persist(); }

  /* ---------- panel ---------- */
  function build() {
    scrim = el('div', 'dwh-scrim'); scrim.addEventListener('click', close);
    panel = attr(el('div', 'dwh-panel'), { role: 'dialog', 'aria-label': 'DeepWell Help', id: 'dwh-panel' });
    launcher.setAttribute('aria-controls', 'dwh-panel');
    var handle = el('div', 'dwh-handle'); handle.setAttribute('aria-hidden', 'true');
    var head = el('div', 'dwh-head');
    head.appendChild(attr(el('img'), { src: '/support/logo-mark.svg', alt: '', width: 28, height: 28 }));
    head.appendChild(el('h2', 'dwh-title', 'DeepWell Help'));
    var x = attr(el('button', 'dwh-x', '×'), { type: 'button', 'aria-label': 'Close help' });
    x.addEventListener('click', close); head.appendChild(x);
    log = attr(el('div', 'dwh-log'), { role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' });
    var form = el('form', 'dwh-in');
    count = el('span', 'dwh-count'); count.hidden = true;
    ta = attr(el('textarea'), { rows: 1, maxlength: MAX, 'aria-label': 'Your question', placeholder: 'Ask a question', enterkeyhint: 'send' });
    sendBtn = attr(el('button', 'dwh-btn', 'Send'), { type: 'submit' });
    form.appendChild(count); form.appendChild(ta); form.appendChild(sendBtn);
    var note = el('div', 'dwh-note', 'AI assistant. It answers questions about DeepWell only.');
    panel.appendChild(handle); panel.appendChild(head); panel.appendChild(log); panel.appendChild(form); panel.appendChild(note);
    root.appendChild(scrim); root.appendChild(panel);
    form.addEventListener('submit', function (e) { e.preventDefault(); send(ta.value); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(ta.value); }
    });
    ta.addEventListener('input', grow);
    panel.addEventListener('keydown', trap);
    drag(handle); drag(head);
    if (window.visualViewport) { visualViewport.addEventListener('resize', fit); visualViewport.addEventListener('scroll', fit); }
    var saved = store(true);
    st.turns = (saved && saved.turns) || 0;
    if (saved && saved.msgs && saved.msgs.length) {
      st.msgs = saved.msgs; st.msgs.forEach(function (m) { addMsg(m.role, m.text, m.sources); });
      chips(DEFAULT_SUGG.slice(0, 3));
    } else { greet(); }
    st.built = true;
  }
  function greet() {
    addMsg('assistant', GREETING); chips(DEFAULT_SUGG);
    fetch(API + '?starter=1&surface=' + SURFACE, { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j || st.msgs.length || st.turns) return;
      var first = log.querySelector('.dwh-m .dwh-b'); if (first && j.greeting) { first.textContent = ''; rich(first, j.greeting); }
      if (j.suggestions && j.suggestions.length) chips(j.suggestions);
    }).catch(function () { /* built-in copy stays */ });
  }
  function grow() {
    ta.style.height = 'auto';
    var max = parseFloat(getComputedStyle(ta).lineHeight) * 4 + 22 || 104;
    ta.style.height = Math.min(ta.scrollHeight, max) + 'px';
    var n = ta.value.length; count.hidden = n < 500; count.textContent = n + '/' + MAX; count.classList.toggle('warn', n >= MAX - 20);
  }
  function fit() {
    if (!st.open || !panel) return;
    if (!mobileMQ.matches || !window.visualViewport) { panel.style.height = panel.style.bottom = panel.style.maxHeight = ''; return; }
    var v = visualViewport, off = Math.max(0, window.innerHeight - v.height - v.offsetTop);
    panel.style.bottom = off + 'px';
    panel.style.maxHeight = Math.min(v.height - 8, window.innerHeight * 0.85) + 'px';
    panel.style.height = panel.style.maxHeight;
  }
  function drag(h) {
    var y0 = null;
    h.addEventListener('pointerdown', function (e) { if (mobileMQ.matches && e.target.tagName !== 'BUTTON') { y0 = e.clientY; try { h.setPointerCapture(e.pointerId); } catch (x) { /* ok */ } } });
    h.addEventListener('pointermove', function (e) { if (y0 != null && e.clientY > y0) panel.style.transform = 'translateY(' + (e.clientY - y0) + 'px)'; });
    function end(e) { if (y0 == null) return; var d = e.clientY - y0; y0 = null; panel.style.transform = ''; if (d > 80) close(); }
    h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
  }
  function focusables() {
    return [].filter.call(panel.querySelectorAll('button, a[href], input, textarea, [tabindex]:not([tabindex="-1"])'), function (n) {
      return !n.disabled && !n.closest('[hidden]') && n.getClientRects().length && !n.classList.contains('dwh-hp');
    });
  }
  function trap(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    var f = focusables(); if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function open() {
    if (st.open) return;
    hideTip(); lastFocus = document.activeElement; st.open = true;
    if (!st.built) build(); else panel.hidden = false;
    scrim.hidden = false;
    launcher.classList.remove('dwh-pulse'); launcher.setAttribute('aria-expanded', 'true');
    launcher.setAttribute('aria-label', 'Close DeepWell Help');
    if (mobileMQ.matches) { panel.setAttribute('aria-modal', 'true'); launcher.classList.add('dwh-hide'); } else panel.removeAttribute('aria-modal');
    fit(); scroll();
    setTimeout(function () { ta.focus(); }, 30);
  }
  function close() {
    if (!st.open) return;
    st.open = false; panel.hidden = true; scrim.hidden = true;
    launcher.classList.remove('dwh-hide'); launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-label', 'Open DeepWell Help');
    (launcher || lastFocus).focus();
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && st.open) close(); });

  /* ---------- chat ---------- */
  function history() { return st.msgs.slice(-10).map(function (m) { return { role: m.role === 'user' ? 'user' : 'assistant', text: cap(m.text, MAX) }; }); }
  function busy(on) { st.busy = on; sendBtn.disabled = on; ta.setAttribute('aria-busy', on ? 'true' : 'false'); }
  function fail(text) { typing(false); addMsg('assistant', text); busy(false); }
  function send(raw) {
    var text = cap(String(raw || '').trim(), MAX);
    if (!text || st.busy) return;
    clearChips(); removeForm();
    if (st.turns >= TURNS) { addMsg('assistant', "We've covered a lot. To keep going, I'll pass this to the team."); handoffForm(); return; }
    var hist = history();
    addMsg('user', text); push('user', text); st.lastUser = text; st.turns++;
    ta.value = ''; grow(); busy(true); typing(true);
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 30000);
    fetch(API, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, signal: ctl ? ctl.signal : undefined,
      body: JSON.stringify({ message: text, history: hist, surface: SURFACE, page: location.pathname, turn: st.turns })
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { s: r.status, j: j }; }); })
      .then(function (o) {
        clearTimeout(timer);
        if (o.s === 429) return fail('You are sending messages quickly. Please wait ' + (o.j.retryAfterSec || 60) + ' seconds and try again.');
        if (o.s !== 200 || !o.j.reply) return fail(o.j.error || "Something went wrong on our side. Please email support@deepwelltechnology.com and we'll help.");
        typing(false); busy(false);
        addMsg('assistant', o.j.reply, o.j.sources); push('assistant', o.j.reply, o.j.sources);
        if (o.j.handoff && o.j.handoff.offered) offerHandoff();
        chips(o.j.suggestions);
        if (!o.j.handoff) ta.focus();
      }).catch(function () { clearTimeout(timer); fail("I couldn't reach the server. Please try again, or email support@deepwelltechnology.com."); });
  }

  /* ---------- hand-off ---------- */
  function removeForm() { var f = log.querySelector('.dwh-form-h, .dwh-offer'); if (f) f.remove(); }
  function offerHandoff() {
    removeForm();
    var b = attr(el('button', 'dwh-chip dwh-offer', 'Send this to the team'), { type: 'button' });
    b.style.marginLeft = '32px'; b.addEventListener('click', function () { b.remove(); handoffForm(); });
    log.appendChild(b); scroll();
  }
  function field(label, node) { var l = el('label', '', label); l.appendChild(node); return l; }
  function handoffForm() {
    removeForm();
    var f = el('form', 'dwh-form-h'); f.noValidate = true;
    var email = attr(el('input'), { type: 'email', autocomplete: 'email', required: 'required', maxlength: 254, inputmode: 'email' });
    var name = attr(el('input'), { type: 'text', autocomplete: 'name', maxlength: 80 });
    var msg = attr(el('textarea'), { maxlength: 1500 }); msg.value = st.lastUser;
    var hp = attr(el('input'), { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
    var hpw = el('div', 'dwh-hp'); hpw.appendChild(hp);
    var err = el('div', 'dwh-err'); err.setAttribute('role', 'alert');
    var go = attr(el('button', 'dwh-btn', 'Send to the team'), { type: 'submit' });
    f.appendChild(field('Your email (required)', email)); f.appendChild(field('Your name (optional)', name));
    f.appendChild(field('What do you need help with?', msg)); f.appendChild(hpw); f.appendChild(err); f.appendChild(go);
    f.addEventListener('submit', function (e) {
      e.preventDefault(); err.textContent = '';
      var em = email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) { err.textContent = 'Please enter a valid email so we can reply.'; email.focus(); return; }
      if (!msg.value.trim()) { err.textContent = 'Please add a short message.'; msg.focus(); return; }
      go.disabled = true;
      fetch(API, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'handoff', email: em, name: name.value.trim(), message: msg.value.trim(), website: hp.value, surface: SURFACE, page: location.pathname, transcript: history().slice(-TURNS) })
      }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { s: r.status, j: j }; }); })
        .then(function (o) {
          if (o.s === 200 && o.j.ok) { f.remove(); var t = 'Sent — we\'ll reply to ' + em + '.'; addMsg('assistant', t); push('assistant', t); ta.focus(); return; }
          err.textContent = o.s === 429 ? 'Too many requests today. Please email support@deepwelltechnology.com.' : (o.j.error || 'That did not send. Please email support@deepwelltechnology.com.'); go.disabled = false;
        }).catch(function () { err.textContent = 'That did not send. Please email support@deepwelltechnology.com.'; go.disabled = false; });
    });
    log.appendChild(f); scroll(); email.focus();
  }

  initLauncher();
})();
