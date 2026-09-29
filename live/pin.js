/*
 * ChartBridgePin: the 4-digit PIN on ChartBridge's own page (ChartBridge 0.3.2; nt8/PROTOCOL.md, "PIN").
 * Only the standalone page loads this file (live/index.html); ChartLive.mount never uses it, so a host page such as
 * The Desk never sees the pad and never needs ChartBridge's PIN.
 *
 *   ChartBridgePin.gate()        -> promise, resolved once the page is unlocked (or ChartBridge has no PIN: 0.3.1
 *                                   and older answer 404). Shows "Set a PIN" when none is set on this PC.
 *   ChartBridgePin.wsUrl(base)   -> promise of the WebSocket URL with ?unlock=<token>. Asked on every connect. It asks
 *                                   for the PIN again only when ChartBridge answers that this page's unlock no longer
 *                                   holds (pin.txt deleted or replaced). When ChartBridge does not answer (restarting,
 *                                   F5), the page keeps its unlock and reconnects with it: a restart never locks it.
 *   ChartBridgePin.headers()     -> { 'X-ChartBridge-Unlock': token } for GET /session.
 *   ChartBridgePin.openChange()  -> the Change PIN dialog (current PIN, new PIN twice).
 *   ChartBridgePin.active()      -> true once unlocked against a ChartBridge that has the PIN.
 *
 * The unlock lives in this closure only: never localStorage, sessionStorage, cookies or the URL bar. A reload asks
 * for the PIN again. A wrong PIN is refused and that is all: nothing is counted and nothing is ever blocked.
 */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  const HEADER = 'X-ChartBridge-Unlock';
  let token = null;                 // the unlock: memory only
  let supported = true;             // false against a ChartBridge without the PIN
  let ui = null;                    // the open overlay: { el, kind, close() }

  /* ---------------- ChartBridge: POST, same origin, small JSON bodies */
  async function call(path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers[HEADER] = token;
    const r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body || {}), cache: 'no-store', credentials: 'same-origin' });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    return { status: r.status, body: j && typeof j === 'object' ? j : {} };
  }
  /* 'none' (no PIN set), 'set' (locked), 'unlocked', 'unsupported' (older ChartBridge) or 'error'; throws when
     ChartBridge does not answer at all. */
  async function status() {
    const r = await call('/pin/status', {});
    if (r.status === 404) return 'unsupported';
    if (r.status !== 200) return 'error';
    return !r.body.set ? 'none' : r.body.unlocked ? 'unlocked' : 'set';
  }

  /* ---------------- gate: the first unlock, and asking again when ChartBridge says the unlock is gone */
  function gate() { return new Promise(done => runGate(done)); }
  function runGate(done) {
    status().then(s => {
      if (s === 'unsupported') { supported = false; close(); done(); }
      else if (s === 'unlocked') { close(); done(); }
      else if (s === 'none') showSet(done);
      else if (s === 'set') showUnlock(done);
      else { showWaiting('ChartBridge refused the PIN check. Open http://localhost:8765/ in its own tab.'); later(() => runGate(done)); }
    }, () => { showWaiting(''); later(() => runGate(done)); });
  }
  let retryTimer = 0;
  const later = fn => { clearTimeout(retryTimer); retryTimer = setTimeout(fn, 2000); };

  function wsUrl(base) {
    const withUnlock = () => token ? base + (base.indexOf('?') < 0 ? '?' : '&') + 'unlock=' + encodeURIComponent(token) : base;
    if (!supported) return Promise.resolve(base);
    return new Promise(resolve => {
      status().then(s => {
        if (s === 'none' || s === 'set') { token = null; runGate(() => resolve(withUnlock())); }   // ChartBridge says this unlock is gone
        else resolve(withUnlock());
      }, () => resolve(withUnlock()));                                                        // not answering: keep the unlock
    });
  }
  const headers = () => token ? { [HEADER]: token } : {};
  const active = () => supported && !!token;

  /* ---------------- the overlay */
  const LOGO = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#FFE4EA" stroke-width="2" aria-hidden="true"><path d="M7 4v16M17 4v16"/><rect x="4.5" y="8" width="5" height="7" rx="1"/><rect x="14.5" y="6" width="5" height="9" rx="1"/></svg>';
  const BACK = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M9 5h11v14H9l-6-7z"/><path d="M12.5 9.5l5 5M17.5 9.5l-5 5"/></svg>';

  function close() {
    if (!ui) return;
    const u = ui; ui = null;
    u.close();
  }

  function build(kind, opaque) {
    close();
    const el = document.createElement('div');
    el.className = 'cb-pin' + (opaque ? '' : ' cb-pin-over');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'cbPinTitle');
    el.innerHTML = `
  <div class="cb-pin-card" tabindex="-1">
    <div class="cb-pin-brand"><div class="cb-pin-logo">${LOGO}</div><div class="cb-pin-brandtext"><span class="cb-pin-word">The Desk</span><span class="cb-pin-page">Live chart</span></div></div>
    <h1 class="cb-pin-title" id="cbPinTitle"></h1>
    <p class="cb-pin-sub" id="cbPinSub"></p>
    <div class="cb-pin-dots" id="cbPinDots" role="status" aria-live="polite"><span></span><span></span><span></span><span></span></div>
    <p class="cb-pin-msg" id="cbPinMsg" role="alert"></p>
    <div class="cb-pin-keys" id="cbPinKeys" role="group" aria-label="PIN keypad">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button type="button" class="cb-pin-key" data-k="${n}">${n}</button>`).join('')}
      <button type="button" class="cb-pin-key cb-pin-fn" data-k="clear">Clear</button>
      <button type="button" class="cb-pin-key" data-k="0">0</button>
      <button type="button" class="cb-pin-key cb-pin-fn" data-k="back" aria-label="Delete the last digit">${BACK}</button>
    </div>
    <div class="cb-pin-foot" id="cbPinFoot"></div>
  </div>`;
    document.body.appendChild(el);
    const $ = id => el.querySelector('#' + id);
    const u = { el, kind, $, onKey: null, close: null };
    const keydown = e => { if (ui === u && u.onKey) u.onKey(e); };
    document.addEventListener('keydown', keydown, true);            // first, so the chart's own keys never see them
    u.close = () => { document.removeEventListener('keydown', keydown, true); el.remove(); };
    ui = u;
    return u;
  }

  function showWaiting(text) {
    if (ui && ui.kind === 'waiting') { ui.$('cbPinMsg').textContent = text; return; }
    const u = build('waiting', true);
    u.$('cbPinTitle').textContent = 'Waiting for ChartBridge';
    u.$('cbPinSub').textContent = 'Start NinjaTrader with ChartBridge compiled; this page goes on by itself.';
    u.$('cbPinDots').hidden = true; u.$('cbPinKeys').hidden = true;
    u.$('cbPinMsg').textContent = text;
  }

  /* A PIN flow: one or more 4-digit steps, then submit(values) -> { ok } or { msg, step }. Digits type from the pad
     (click or touch) or the keyboard (0-9, Backspace, Delete clears, Escape clears or cancels). */
  function flow(kind, opts) {
    const u = build(kind, !opts.cancel);
    const steps = opts.steps;
    let step = 0, digits = '', values = [], busy = false;
    const dots = u.$('cbPinDots'), msg = u.$('cbPinMsg'), card = u.el.querySelector('.cb-pin-card');
    const foot = u.$('cbPinFoot');
    if (opts.cancel) {
      foot.innerHTML = '<button type="button" class="cb-pin-link" id="cbPinCancel">Cancel</button>';
      u.$('cbPinCancel').addEventListener('click', () => { if (!busy) close(); });
    } else if (opts.hint) {
      foot.textContent = opts.hint;
    }
    function render() {
      u.$('cbPinTitle').textContent = steps[step].title;
      u.$('cbPinSub').textContent = steps[step].sub || '';
      [...dots.children].forEach((d, i) => d.classList.toggle('on', i < digits.length));
      dots.setAttribute('aria-label', digits.length + ' of 4 digits entered');
      u.el.classList.toggle('cb-pin-busy', busy);
      for (const b of u.$('cbPinKeys').children) b.disabled = busy;
    }
    function say(text, level) { msg.textContent = text || ''; msg.className = 'cb-pin-msg' + (level ? ' ' + level : ''); }
    function shake() {
      card.classList.remove('cb-pin-shake'); void card.offsetWidth; card.classList.add('cb-pin-shake');
    }
    async function finish() {
      busy = true; say('Checking...', ''); render();
      let r;
      try { r = await opts.submit(values); } catch (e) { r = { msg: 'ChartBridge is not answering. Try again in a moment.', step }; }
      if (ui !== u) return;
      busy = false;
      if (r.ok) { close(); return; }
      if (r.switchTo) { r.switchTo(r.msg); return; }
      back(r);
    }
    function back(r) { values = values.slice(0, r.step); step = r.step; digits = ''; say(r.msg, 'bad'); shake(); render(); card.focus(); }
    async function type(k) {
      if (busy) return;
      if (k === 'back') { digits = digits.slice(0, -1); render(); return; }
      if (k === 'clear') { digits = ''; render(); return; }
      if (!/^[0-9]$/.test(k) || digits.length >= 4) return;
      digits += k;
      if (digits.length === 1 && msg.classList.contains('bad')) say('', '');
      render();
      if (digits.length < 4) return;
      values[step] = digits;
      const check = steps[step].check ? steps[step].check(values) : null;
      if (check) { back(check); return; }
      if (steps[step].verify) {                                  // checked with ChartBridge before the next step
        busy = true; say('Checking...', ''); render();
        let r;
        try { r = await steps[step].verify(values); } catch (e) { r = { msg: 'ChartBridge is not answering. Try again in a moment.', step }; }
        if (ui !== u) return;
        busy = false; say('', '');
        if (r) { back(r); return; }
      }
      if (step < steps.length - 1) { step++; digits = ''; say('', ''); render(); return; }
      finish();
    }
    u.$('cbPinKeys').addEventListener('click', e => { const b = e.target.closest('button[data-k]'); if (b) type(b.dataset.k); });
    u.onKey = e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      let k = null;
      if (/^[0-9]$/.test(e.key)) k = e.key;
      else if (e.key === 'Backspace') k = 'back';
      else if (e.key === 'Delete') k = 'clear';
      else if (e.key === 'Escape') { if (opts.cancel && !busy) { e.preventDefault(); e.stopPropagation(); close(); return; } k = 'clear'; }
      else if (e.key === 'Tab') return;                        // move between the keys
      else if (e.key === 'Enter' || e.key === ' ') { if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#cbPinKeys, #cbPinFoot')) return; }
      e.stopPropagation();
      if (k) { e.preventDefault(); type(k); }
    };
    if (opts.msg) say(opts.msg, opts.msgLevel || 'bad');
    render();
    card.focus();
    return u;
  }

  const HINT = 'Forgot it? Delete pin.txt in Documents\\NinjaTrader 8\\ChartBridge on this PC, then reload.';

  function showUnlock(done, note) {
    flow('unlock', {
      steps: [{ title: 'Enter PIN', sub: 'ChartBridge on this PC' }],
      hint: HINT, msg: note,
      submit: async v => {
        const r = await call('/pin/unlock', { pin: v[0] });
        if (r.status === 200 && r.body.token) { token = r.body.token; done(); return { ok: true }; }
        if (r.status === 409) return { switchTo: m => showSet(done, 'No PIN is set on this PC any more. Set a new one.') };
        return { msg: r.status === 403 ? 'Wrong PIN. Try again.' : 'ChartBridge refused: ' + (r.body.reason || r.status), step: 0 };
      },
    });
  }

  function showSet(done, note) {
    flow('set', {
      steps: [
        { title: 'Set a PIN', sub: 'Four digits for ChartBridge on this PC. This page asks for it each time it opens.' },
        { title: 'Enter it again', sub: 'The same four digits, to be sure.', check: v => v[0] !== v[1] ? { msg: 'The two PINs did not match. Start again.', step: 0 } : null },
      ],
      msg: note, msgLevel: 'note',
      submit: async v => {
        const r = await call('/pin/set', { pin: v[0] });
        if (r.status === 200 && r.body.token) { token = r.body.token; done(); return { ok: true }; }
        if (r.status === 409) return { switchTo: () => showUnlock(done, 'A PIN is already set on this PC. Enter it.') };
        return { msg: 'ChartBridge refused: ' + (r.body.reason || r.status), step: 0 };
      },
    });
  }

  function openChange() {
    if (!active() || (ui && ui.kind !== 'change')) return;
    flow('change', {
      cancel: true,
      steps: [
        { title: 'Current PIN', sub: 'To change this PC\'s ChartBridge PIN.', verify: async v => {
          const r = await call('/pin/unlock', { pin: v[0] });             // a check only; the change itself needs it again
          return r.status === 200 ? null : { msg: r.status === 403 ? 'The current PIN is wrong. Try again.' : 'ChartBridge refused: ' + (r.body.reason || r.status), step: 0 };
        } },
        { title: 'New PIN', sub: 'Four new digits.' },
        { title: 'New PIN again', sub: 'The same four digits, to be sure.', check: v => v[1] !== v[2] ? { msg: 'The new PINs did not match. Enter the new PIN again.', step: 1 } : null },
      ],
      submit: async v => {
        const r = await call('/pin/change', { pin: v[0], newPin: v[1] });
        if (r.status === 200 && r.body.token) { token = r.body.token; flashDone(); return { ok: true }; }
        if (r.status === 403) return { msg: 'The current PIN is wrong. Try again.', step: 0 };
        return { msg: 'ChartBridge refused: ' + (r.body.reason || r.status), step: 0 };
      },
    });
  }
  function flashDone() {
    const t = document.createElement('div');
    t.className = 'cb-pin-toast'; t.setAttribute('role', 'status'); t.textContent = 'PIN changed. Open pages stay unlocked.';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  window.ChartBridgePin = { gate, wsUrl, headers, openChange, active };
})();
