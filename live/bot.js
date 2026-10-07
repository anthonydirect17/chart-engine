/*
 * BotDesk: the Bot tab, the bot strip, the bot's pop-ups and its ghost marks (chart page 1.16.0; ChartBridge 0.4.0's bot
 * channel, nt8/PROTOCOL.md "Bot channel"; Anthony's addenda 2 to 4). The logic is live/bot-core.js (BotCore); this file
 * draws it. The workspace (live/index.html) creates one; the bot-only window (live/bot.html, for a third monitor) creates
 * one with { popout: true }.
 *
 *   const desk = BotDesk.create({ wsUrl, headers, feed, storage, els: { tab, view, strip, notes }, ... });
 *
 * Its own connection to ChartBridge (as the order ticket has its own): hello, then `client` v3, then the sign-in (GET
 * /session, `auth`). Everything shows only when ChartBridge says `trading.switches.bot` is true; with it off the Bot tab
 * says the bot channel is off on this PC and offers nothing (no strip, no pop-ups, no ghost marks).
 *
 * Safety (BUILD_RULES; PROTOCOL.md "Bot channel"):
 *   - The page never builds an order for the bot. Accept sends `botAnswer` with the proposal's id; ChartBridge places the
 *     order from the proposal's own parameters. The kill switch, the mode, the rails and the answers are the only bot
 *     messages this page sends, and ChartBridge checks every one.
 *   - Rails are tighten-only on the page as well (`botRails`, BotCore.railsChange); ChartBridge refuses a loosening.
 *   - Motion (live/motion.js, docs/MOTION.md) is used for the Bot tab and the Library only. R3: the kill switch, the
 *     mode, Accept and Reject, the position and P&L figures and the pop-ups are marked data-no-motion and are never
 *     animated. R4: a click or a key during a scene finishes it at once and still acts (the kit's rule). The chart in the
 *     Bot tab is a normal ChartLive chart: motion never touches it.
 */
(function () {
'use strict';
if (typeof window === 'undefined' || typeof document === 'undefined' || !window.BotCore) return;
const BC = window.BotCore;
const MO = () => window.ChartMotion || null;
const VERSION = '1.0.0';

const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isNum = v => typeof v === 'number' && isFinite(v);
/** write a DOM property only when it changed (M7) */
const put = (el, k, v) => { if (el && el[k] !== v) el[k] = v; };
const attr = (el, k, v) => { if (!el) return; const s = v === null || v === undefined ? null : String(v); if (s === null) { if (el.hasAttribute(k)) el.removeAttribute(k); } else if (el.getAttribute(k) !== s) el.setAttribute(k, s); };
const tog = (el, cls, on) => { if (el && el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on); };
const TF_NAMES = { s15: '15 sec', s30: '30 sec', m1: '1 min', m5: '5 min', m15: '15 min' };
const MICRO = { MNQ: 'micro', MES: 'micro', NQ: 'mini', ES: 'mini' };
const FAMILY = { MNQ: 'NQ', NQ: 'NQ', MES: 'ES', ES: 'ES' };
const DESK_KEY = 'live-desk-url-v1', CHART_KEY = 'live-bot-chart-v1';
const DESK_DEFAULT = 'http://localhost:8800';

function create(o) {
  o = o || {};
  const els = o.els || {};
  const storage = o.storage || { getItem: () => null, setItem: () => {} };
  const log = BC.createLog(storage), days = BC.createDayTypes(storage);
  const props = BC.createProposals();
  const popout = !!o.popout;

  /* ---------------- state */
  const S = {
    sock: null, tries: 0, timer: 0, fastAt: 0, destroyed: false,
    v3: null, version: '', instruments: {}, trading: null, signedIn: false, on: false,
    accounts: null, bot: null, layout: '', shown: popout, cidSeq: 0,
    orders: new Map(), botIds: new Set(), pending: new Map(),    // pending: cid -> { kind, id }
    library: { state: 'idle', bots: [], problems: [], text: '' }, libAt: 0,
    keys: { accept: '', reject: '', notes: [], from: '' },
    killConfirm: 0, autoConfirm: 0, railsEdit: false, panelTab: 'today', detail: null,
    chart: null, chartRoot: '', chartTf: 'm1', contract: '',
  };
  let opts = BC.readOptions(storage);

  /* ---------------- the DOM: built once, then written only where it changed */
  const view = els.view, strip = els.strip, tabBtn = els.tab;
  const notes = els.notes || (() => { const d = document.createElement('div'); d.className = 'bt-notes'; d.setAttribute('aria-live', 'polite'); document.body.appendChild(d); return d; })();
  const propBox = (() => { const d = document.createElement('div'); d.className = 'bt-props'; d.setAttribute('data-no-motion', ''); d.setAttribute('role', 'region'); d.setAttribute('aria-label', 'Copilot proposals'); document.body.appendChild(d); return d; })();
  const q = sel => view ? view.querySelector(sel) : null;
  if (view) build();

  function build() {
    view.classList.add('bt-view', 'motion-atmo');
    view.innerHTML =
      '<div class="bt-off" data-k="off" hidden><div class="bt-off-card"><span class="bt-cap">Bot</span><p data-k="offText"></p></div></div>' +
      '<div class="bt-grid" data-k="grid" hidden>' +
      /* the Library */
      '<aside class="bt-piece bt-lib" aria-label="Library">' +
        '<div class="bt-ph" data-in="0,.3"><span class="bt-t">Library</span><span class="bt-r"><span class="bt-pill">1 slot</span></span></div>' +
        '<div class="bt-pb bt-scroll">' +
          '<div class="bt-slot" data-in=".04,.32" data-k="slot"></div>' +
          '<div data-k="shelves"></div>' +
          '<p class="bt-foot" data-in=".4,.7">New builds appear here only after they are frozen in Bot-Lab. Click one to open it full screen.</p>' +
        '</div>' +
      '</aside>' +
      /* the chart: a normal live chart, never animated */
      '<section class="bt-piece bt-chartp" aria-label="Bot chart">' +
        '<div class="bt-ph" data-in=".02,.3"><span class="bt-t" data-k="chartName">Chart</span>' +
          '<select class="ws-sel bt-tf" data-k="tf" aria-label="Bars">' + Object.keys(TF_NAMES).map(k => '<option value="' + k + '">' + TF_NAMES[k] + '</option>').join('') + '</select>' +
          '<span class="chart-live ws-lv" data-k="ind"></span>' +
          '<span class="bt-r"><span class="bt-pill bt-legend" title="The bot\'s trades today: triangles in, dots out; its working entry, stop and target as lines">Bot trades</span>' +
          (popout ? '' : '<button type="button" class="ws-btn bt-pop" data-act="popout" title="Open the Bot tab in its own window (for a third monitor)">Pop out</button>') + '</span></div>' +
        '<div class="bt-chart" data-k="chart" data-no-motion></div>' +
      '</section>' +
      /* the bot panel */
      '<aside class="bt-piece bt-panel" aria-label="Bot panel">' +
        '<div class="bt-ph" data-in=".04,.32"><span class="bt-t">Bot panel</span><span class="bt-r"><span class="bt-onoff" data-k="onoff"></span><span class="bt-badge" data-k="ev" hidden></span></span></div>' +
        '<div class="bt-pb bt-panelb">' +
          '<div class="bt-sec" data-no-motion><span class="bt-cap">Mode</span>' +
            '<div class="bt-modes" role="group" aria-label="Bot mode" data-k="modes">' + BC.MODES.map(m => '<button type="button" data-mode="' + m + '" aria-pressed="false">' + BC.MODE_NAME[m] + '</button>').join('') + '</div>' +
            '<p class="bt-why" data-k="modeWhy" hidden></p></div>' +
          '<div class="bt-kv" data-in=".1,.38">' +
            '<span class="k">Bot</span><span class="v" data-k="name">-</span>' +
            '<span class="k">Account</span><span class="v mono" data-k="account">Sim101</span>' +
            '<span class="k">Size</span><span class="v" data-k="size" title="ChartBridge\'s botRoot in config.txt; at most 1 contract (a rail)">-</span>' +
            '<span class="k">Status</span><span class="v" data-k="status">-</span>' +
            '<span class="k">Heartbeat</span><span class="v mono" data-k="beat">-</span>' +
          '</div>' +
          '<div class="bt-kv bt-money" data-no-motion>' +
            '<span class="k">Position</span><span class="v mono" data-k="pos">-</span>' +
            '<span class="k">Today</span><span class="v mono" data-k="pnl">-</span>' +
          '</div>' +
          '<div class="bt-sec" data-in=".16,.44"><span class="bt-cap">Rails <span class="bt-capn">ChartBridge enforces them</span></span>' +
            '<div class="bt-rail" data-k="railT"><div class="top"><span>Trades</span><span class="mono" data-k="railTText">-</span></div><div class="bt-meter"><i data-grow=".2,.6"></i></div></div>' +
            '<div class="bt-rail" data-k="railL"><div class="top"><span>Losing trades</span><span class="mono" data-k="railLText">-</span></div><div class="bt-meter"><i data-grow=".24,.64"></i></div></div>' +
            '<div class="bt-rails-edit" data-k="railsEdit" hidden><label>Trades <input type="number" min="1" step="1" inputmode="numeric" data-k="railTIn"></label>' +
              '<label>Losing trades <input type="number" min="1" step="1" inputmode="numeric" data-k="railLIn"></label>' +
              '<button type="button" class="ws-btn primary" data-act="railsSave">Tighten</button><button type="button" class="ws-btn" data-act="railsCancel">Cancel</button></div>' +
            '<div class="bt-row"><button type="button" class="ws-btn bt-small" data-act="railsOpen" data-k="railsOpen">Tighten the rails</button><span class="bt-why" data-k="railsWhy"></span></div>' +
          '</div>' +
          '<button type="button" class="bt-kill" data-no-motion data-act="kill" data-k="kill">Kill switch</button>' +
          '<div class="bt-sec" data-in=".22,.5"><span class="bt-cap">Day type <span class="bt-capn">every call logged</span></span>' +
            '<div class="bt-dtype" role="group" aria-label="Day type" data-k="dtype">' + BC.DAY_TYPES.map(t => '<button type="button" data-dt="' + t + '" aria-pressed="false">' + t + '</button>').join('') + '</div>' +
            '<p class="bt-why" data-k="dtWhy"></p></div>' +
          '<div class="bt-tabs" role="tablist" data-in=".26,.56">' +
            '<button type="button" role="tab" data-ptab="today" aria-selected="true">Today</button><button type="button" role="tab" data-ptab="log" aria-selected="false">Log</button><button type="button" role="tab" data-ptab="options" aria-selected="false">Options</button></div>' +
          '<div class="bt-tabb" data-k="tabBody" data-no-motion></div>' +
        '</div>' +
      '</aside>' +
      '</div>';
  }

  /* ---------------- the connection: hello, client v3, sign in */
  const sendRaw = m => { try { if (S.sock && S.sock.readyState === 1) { S.sock.send(JSON.stringify(m)); return true; } } catch (e) { /* closed */ } return false; };
  const cid = () => 'bt' + (++S.cidSeq).toString(36) + Math.random().toString(36).slice(2, 6);
  function connect() {
    S.timer = 0;
    if (S.destroyed) return;
    let sock;
    Promise.resolve().then(() => (typeof o.wsUrl === 'function' ? o.wsUrl() : o.wsUrl)).then(url => {
      if (S.destroyed) return;
      try { sock = new WebSocket(url); } catch (e) { retry(); return; }
      S.sock = sock;
      sock.onopen = () => { if (sock === S.sock) S.tries = 0; };
      sock.onmessage = ev => { if (sock !== S.sock) return; let m; try { m = JSON.parse(ev.data); } catch (e) { return; } onMessage(m); };
      sock.onclose = () => { if (sock !== S.sock) return; S.sock = null; lost(); retry(); };
      sock.onerror = () => { /* onclose follows */ };
    }, retry);
  }
  function retry() {
    if (S.destroyed) return;
    S.tries++;
    const now = Date.now(), fast = S.tries === 1 && now - S.fastAt > 5000;
    if (fast) S.fastAt = now;
    S.timer = setTimeout(connect, fast ? 0 : Math.min(5000, 500 * S.tries));
  }
  function lost() {
    S.signedIn = false; S.trading = null; S.orders.clear();
    for (const p of props.clear()) dropProposal(p.id);
    S.pending.clear();
    render();
  }
  function signIn() {
    if (S.framed) return;
    const sock = S.sock;
    const h = typeof o.headers === 'function' ? o.headers() : {};
    fetch('/session', { cache: 'no-store', headers: h || {} })
      .then(r => (r.ok ? r.text() : Promise.reject(new Error('GET /session answered ' + r.status))))
      .then(body => {
        let token = null;
        try { const j = JSON.parse(body); token = typeof j === 'string' ? j : j && j.token; } catch (e) { token = body.trim(); }
        if (token && sock === S.sock) sendRaw({ type: 'auth', token });
      })
      .catch(() => { if (sock === S.sock) setTimeout(() => { if (sock === S.sock && !S.signedIn) signIn(); }, 3000); });
  }
  function onMessage(m) {
    switch (m && m.type) {
      case 'hello': {
        S.version = typeof m.version === 'string' ? m.version : '';
        S.instruments = {};
        for (const i of m.instruments || []) if (i && i.root) S.instruments[i.root] = i;
        S.v3 = Array.isArray(m.features) && m.features.includes('v3');
        if (S.v3) { sendRaw({ type: 'client', v: 3 }); signIn(); }
        render();
        return;
      }
      case 'trading': {
        S.trading = m; S.signedIn = !!m.enabled;
        const was = S.on;
        S.on = BC.botSwitchOn(m);
        if (S.on && !was) loadLibrary();
        render();
        return;
      }
      case 'accounts': S.accounts = m; renderPanel(); return;
      case 'bot': onBot(m); return;
      case 'botSignal': onSignal(m); return;
      case 'botProposal': onProposal(m); return;
      case 'orders': S.orders.clear(); for (const x of m.list || []) noteOrder(x); renderChartLines(); return;
      case 'order': noteOrder(m); renderChartLines(); return;
      case 'exec': onExec(m); return;
      case 'execs': for (const x of m.list || []) onExec(x, true); renderTrips(); return;
      case 'reject': onReject(m); return;
      case 'status': if (S.on && m.level === 'warn' && typeof m.text === 'string' && /^Bot\b/.test(m.text)) notice({ kind: 'status', level: 'amber', text: m.text }); return;
    }
  }

  /* ---------------- the bot's own orders and fills (its lines on the Bot tab's chart, its marks) */
  const isBotOrder = x => !!x && (x.by === 'bot' || S.botIds.has(x.id) || (x.parent && S.botIds.has(x.parent)) || (typeof x.name === 'string' && /^CB#[0-9a-f]+ bot\b/.test(x.name)));
  function noteOrder(x) {
    if (!x || typeof x.id !== 'string' || !isBotOrder(x)) return;
    S.botIds.add(x.id);
    if (x.state === 'working' || x.state === 'partFilled') S.orders.set(x.id, x); else S.orders.delete(x.id);
  }
  function onExec(f, quiet) {
    if (!f || typeof f.order !== 'string' || !S.botIds.has(f.order)) return;
    log.add({ k: 'fill:' + f.id, kind: 'fill', at: isNum(f.u) && f.u > 0 ? f.u : Date.now(), text: (f.side === 'buy' ? 'Bought ' : 'Sold ') + f.qty + ' ' + (f.root || '') + ' at ' + fmtPx(f.p),
      extra: { side: f.side, qty: f.qty, p: f.p, t: f.t, root: f.root } });
    if (!quiet) { renderTrips(); renderPanelTab(); }
  }
  function botFills() { return log.list().filter(e => e.kind === 'fill' && e.extra).map(e => e.extra).sort((a, b) => a.t - b.t); }
  function trips() { return BC.trips(botFills()); }

  /* ---------------- the bot's status */
  function onBot(m) {
    const prev = S.bot;
    S.bot = m;
    if (S.on && prev) for (const n of BC.noticesFrom(prev, m, BC.fmtUsd)) { notice(n); log.add({ k: 'n:' + n.kind + ':' + Date.now(), kind: 'notice', text: n.text, level: n.level }); }
    if (prev && prev.mode !== m.mode) log.add({ k: 'mode:' + Date.now(), kind: 'mode', text: 'Mode: ' + (BC.MODE_NAME[m.mode] || m.mode) });
    if (prev && (prev.maxTrades !== m.maxTrades || prev.maxLosses !== m.maxLosses)) log.add({ k: 'rails:' + Date.now(), kind: 'rails', text: 'Rails: ' + m.maxTrades + ' trades, ' + m.maxLosses + ' losing trades' });
    render();
  }
  function onSignal(s) {
    if (!s || typeof s.id !== 'string') return;
    const line = BC.signalLine(s);
    log.add({ k: 'sig:' + s.id, kind: 'signal', at: isNum(s.at) ? s.at : Date.now(), text: line.title + ': ' + line.why, extra: { id: s.id, at: s.at, action: s.action, side: s.side, kind: s.kind, price: s.price, stopTicks: s.stopTicks, targetTicks: s.targetTicks, reason: s.reason, result: s.result } });
    if (S.on && s.result !== 'proposed') notice({ kind: 'signal', level: /^refused/.test(s.result || '') ? 'amber' : '', text: (S.bot && S.bot.name ? S.bot.name + ': ' : '') + line.title + (line.why ? '. ' + line.why : '') });
    renderPanelTab();
  }

  /* ---------------- copilot proposals: shown wherever Anthony is, answered with one key or a button */
  const propEls = new Map();
  function onProposal(p) {
    const r = props.update(p);
    if (p && typeof p.id === 'string') logProposal(p);
    if (!S.on) return;
    if (r.act === 'show') showProposal(r.p);
    else if (r.act === 'update') updateProposal(r.p);
    else if (r.act === 'end') endProposal(r.p, r.why);
  }
  function logProposal(p) {
    const react = isNum(p.seenAt) && isNum(p.answeredAt) ? ' in ' + ((p.answeredAt - p.seenAt) / 1000).toFixed(1) + ' s' : '';
    const words = { open: 'proposed', accepted: 'accepted' + react, rejected: 'rejected' + react, withdrawn: 'not answered', 'not answered': 'not answered' }[p.state] || p.state;
    log.add({ k: 'prop:' + p.id, kind: 'proposal', at: isNum(p.at) ? p.at : Date.now(), text: 'Proposal ' + sideWord(p.side) + ' ' + (p.qty || 1) + ' ' + (p.root || '') + ': ' + words, extra: { id: p.id, state: p.state, seenAt: p.seenAt, answeredAt: p.answeredAt } });
    renderPanelTab();
  }
  const sideWord = s => (s === 'buy' ? 'Buy' : s === 'sell' ? 'Sell' : '');
  const tickOf = r => { const i = S.instruments[r]; return i && +i.tick > 0 ? +i.tick : 0.25; };
  const decOf = r => { const s = String(tickOf(r)), i = s.indexOf('.'); return i < 0 ? 0 : Math.min(6, s.length - i - 1); };
  const fmtPx = (p, r) => (isNum(p) ? p.toFixed(decOf(r || botRoot())).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '-');
  function propHtml(p) {
    const r = p.root || botRoot(), t = tickOf(r), dir = p.side === 'buy' ? 1 : -1;
    const px = isNum(p.price) ? p.price : null;
    const stop = isNum(p.stopTicks) ? (px !== null ? fmtPx(px - dir * p.stopTicks * t, r) + ' (' + p.stopTicks + ' ticks)' : p.stopTicks + ' ticks') : 'none';
    const tgt = isNum(p.targetTicks) ? (px !== null ? fmtPx(px + dir * p.targetTicks * t, r) + ' (' + p.targetTicks + ' ticks)' : p.targetTicks + ' ticks') : 'none';
    const kc = k => (k ? ' <span class="bt-keycap">' + esc(k) + '</span>' : '');
    return '<div class="bt-prop-h"><span class="bt-cap">Copilot · ' + esc((S.bot && S.bot.name) || 'Bot') + '</span><span class="mono bt-age" data-k="age"></span></div>' +
      '<div class="bt-prop-big mono"><span class="' + (p.side === 'buy' ? 'pos' : 'neg') + '">' + sideWord(p.side) + '</span> ' + esc(p.qty || 1) + ' ' + esc(r) + ' ' + esc(p.kind || '') + (px !== null ? ' ' + fmtPx(px, r) : '') + '</div>' +
      '<div class="bt-prop-why">' + esc(p.reason || '') + '</div>' +
      '<div class="bt-prop-legs mono">Stop ' + esc(stop) + ' · Target ' + esc(tgt) + '</div>' +
      '<div class="bt-prop-note">' + esc(p.account || 'Sim101') + '. ChartBridge places it from these numbers if you accept. Unanswered, it is never sent: it ends as not answered when the bot withdraws it.</div>' +
      '<div class="bt-prop-btns"><button type="button" class="bt-acc" data-ans="accept">Accept' + kc(S.keys.accept) + '</button><button type="button" class="bt-rej" data-ans="reject">Reject' + kc(S.keys.reject) + '</button></div>' +
      '<div class="bt-prop-msg" data-k="msg" role="status"></div>';
  }
  function showProposal(p) {
    if (propEls.has(p.id)) return;
    const el = document.createElement('div');
    el.className = 'bt-prop';
    el.dataset.id = p.id;
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-label', 'Copilot proposal: ' + sideWord(p.side) + ' ' + (p.qty || 1) + ' ' + (p.root || ''));
    el.innerHTML = propHtml(p);
    propBox.prepend(el);
    propEls.set(p.id, { el, p, shownAt: Date.now() });
    // botSeen the moment it shows (PROTOCOL.md: "the page sends botSeen the moment it shows it"); not rate counted
    const seen = props.shown(p.id, Date.now());
    if (seen) sendRaw(seen);
    beep('');
    ageTick();
  }
  function updateProposal(p) { const x = propEls.get(p.id); if (x) x.p = p; else showProposal(p); }
  function endProposal(p, why) {
    const x = propEls.get(p.id);
    const text = why === 'accepted' ? 'Accepted: ChartBridge placed it on ' + (p.account || 'Sim101') + '.' : why === 'rejected' ? 'Rejected.' : 'Not answered: the bot withdrew it; nothing was sent.';
    if (!x) { if (why === 'not answered') notice({ kind: 'proposal', level: '', text: 'Copilot proposal ' + sideWord(p.side).toLowerCase() + ' ' + (p.root || '') + ': not answered' }); return; }
    // an expired proposal disappears and says "not answered" (Anthony, addendum 3); the others say how they ended
    x.el.classList.add('bt-ended');
    for (const b of x.el.querySelectorAll('button')) b.disabled = true;
    put(x.el.querySelector('[data-k="msg"]'), 'textContent', text);
    x.ended = true;
    setTimeout(() => dropProposal(p.id), why === 'not answered' ? 2500 : 1200);
    notice({ kind: 'proposal', level: why === 'not answered' ? 'amber' : '', text: 'Copilot: ' + text });
  }
  function dropProposal(id) { const x = propEls.get(id); if (x) { x.el.remove(); propEls.delete(id); } }
  propBox.addEventListener('click', e => {
    const b = e.target.closest('button[data-ans]'); if (!b) return;
    const card = b.closest('.bt-prop');
    answer(card && card.dataset.id, b.dataset.ans);
  });
  function answer(id, ans) {
    const x = propEls.get(id);
    if (!x || x.ended) return false;
    const c = cid();
    const r = props.answer(id, ans, Date.now(), c);
    const msgEl = x.el.querySelector('[data-k="msg"]');
    if (r.error) { put(msgEl, 'textContent', r.error); return false; }
    if (!sendRaw(r.msg)) { props.refused(id); put(msgEl, 'textContent', 'Not sent: not connected to ChartBridge.'); return false; }
    S.pending.set(c, { kind: 'answer', id });
    for (const btn of x.el.querySelectorAll('button')) btn.disabled = true;
    put(msgEl, 'textContent', (ans === 'accept' ? 'Accept' : 'Reject') + ' sent. Waiting for ChartBridge.');
    return true;
  }
  function onReject(m) {
    const x = m && m.cid ? S.pending.get(m.cid) : null;
    if (!x) return;
    S.pending.delete(m.cid);
    const why = 'Refused by ChartBridge: ' + (m.reason || '');
    if (x.kind === 'answer') {
      props.refused(x.id);
      const pe = propEls.get(x.id);
      if (pe && !pe.ended) { for (const b of pe.el.querySelectorAll('button')) b.disabled = false; put(pe.el.querySelector('[data-k="msg"]'), 'textContent', why); }
    } else if (x.kind === 'rails') { railsWhy(why); }
    else if (x.kind === 'mode') { modeWhy(why); }
    else notice({ kind: 'refused', level: 'amber', text: why });
    log.add({ k: 'ref:' + m.cid, kind: 'notice', text: why, level: 'amber' });
    renderPanelTab();
  }
  /* the age line on each open proposal, once a second while one is shown */
  let ageTimer = 0;
  function ageTick() {
    clearTimeout(ageTimer); ageTimer = 0;
    if (!propEls.size) return;
    for (const x of propEls.values()) put(x.el.querySelector('[data-k="age"]'), 'textContent', ((Date.now() - x.shownAt) / 1000).toFixed(0) + ' s');
    ageTimer = setTimeout(ageTick, 1000);
  }
  /* one key: The Desk's `accept` and `reject` hotkeys (no default; the buttons always work) */
  function onKey(e) {
    if (!propEls.size || e.repeat || !(S.keys.accept || S.keys.reject)) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const combo = window.OrderTicket && window.OrderTicket.hotkeyCombo ? window.OrderTicket.hotkeyCombo(e) : '';
    if (!combo) return;
    const ans = combo === S.keys.accept ? 'accept' : combo === S.keys.reject ? 'reject' : '';
    if (!ans) return;
    const open = [...propEls.values()].filter(x => !x.ended).sort((a, b) => a.shownAt - b.shownAt)[0];
    if (!open) return;
    e.preventDefault(); e.stopPropagation();
    answer(open.p.id, ans);
  }
  document.addEventListener('keydown', onKey, true);
  function loadKeys() {
    let base = '';
    try { base = storage.getItem(DESK_KEY) || ''; } catch (e) { base = ''; }
    if (!/^https?:\/\/[^\s/]+$/.test(base)) base = DESK_DEFAULT;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = setTimeout(() => { if (ctl) ctl.abort(); }, 3000);
    fetch(base + '/api/chart-hotkeys', { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('answered ' + r.status))))
      .then(doc => {
        const k = BC.answerKeys(doc, typeof o.tradingKeys === 'function' ? o.tradingKeys() : {}, window.OrderTicket ? window.OrderTicket.hotkeyRefused : null);
        S.keys = Object.assign(k, { from: 'desk' });
      })
      .catch(() => { S.keys = { accept: '', reject: '', notes: [], from: 'none' }; })
      .then(() => { clearTimeout(t); renderPanelTab(); });
  }

  /* ---------------- corner notices: a signal, an entry or exit, a limit, a stand-down, the heartbeat (sound optional) */
  function notice(n) {
    if (!S.on) return;
    const d = document.createElement('div');
    d.className = 'bt-note' + (n.level ? ' ' + n.level : '');
    d.setAttribute('role', n.level === 'red' ? 'alert' : 'status');
    d.innerHTML = '<span class="bt-cap">' + esc({ signal: 'Signal', entry: 'Entry', exit: 'Exit', limit: 'Limit', standDown: 'Stand-down', heartbeat: 'Heartbeat', kill: 'Kill switch', proposal: 'Copilot', status: 'ChartBridge', refused: 'Refused' }[n.kind] || 'Bot') + '</span><span>' + esc(n.text) + '</span>';
    d.addEventListener('click', () => d.remove());
    notes.prepend(d);
    while (notes.children.length > 4) notes.lastChild.remove();
    setTimeout(() => d.remove(), n.level === 'red' ? 12000 : 6000);
    beep(n.level);
  }
  let audio = null;
  function beep(level) {
    if (!opts.sound) return;
    try {
      const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
      audio = audio || new C();
      const t = audio.currentTime, osc = audio.createOscillator(), g = audio.createGain();
      osc.frequency.value = level === 'red' ? 520 : level === 'amber' ? 700 : 880;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.07, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      osc.connect(g); g.connect(audio.destination); osc.start(t); osc.stop(t + 0.22);
    } catch (e) { /* no sound */ }
  }

  /* ---------------- the Library (GET /bot-library, docs/BOT_LIBRARY.md) */
  function loadLibrary() {
    S.library = { state: 'loading', bots: [], problems: [], text: '' };
    renderLibrary();
    const h = typeof o.headers === 'function' ? o.headers() : {};
    fetch('/bot-library', { cache: 'no-store', headers: h || {} })
      .then(r => {
        if (r.status === 404) return { none: true };
        if (!r.ok) return Promise.reject(new Error('ChartBridge answered ' + r.status));
        return r.text().then(t => BC.parseLibrary(t));
      })
      .then(res => {
        if (res.none && !res.problems) S.library = { state: 'none', bots: [], problems: [], text: '' };
        else if (!res.ok) S.library = { state: 'error', bots: [], problems: res.problems, text: res.problems[0] || 'The library file could not be read.' };
        else S.library = { state: res.none ? 'none' : 'ok', bots: res.bots, problems: res.problems, text: '' };
      }, e => { S.library = { state: 'error', bots: [], problems: [], text: 'The library could not be read (' + e.message + ').' }; })
      .then(() => { S.libAt = Date.now(); renderLibrary(); renderPanel(); if (S.shown) playLibrary(); });
  }
  const loadedEntry = () => (S.library.state === 'ok' && S.bot ? BC.slotEntry(S.library.bots, S.bot.name) : null);
  function entryHtml(b, i) {
    const ev = b.evidence, cls = b.shelf === 'research' ? 'rs' : BC.evidenceLevel(ev) >= 2 ? 'l2' : '';
    const st = b.stats, loaded = loadedEntry() === b;
    return '<button type="button" class="bt-entry' + (loaded ? ' loaded' : '') + '" data-entry="' + i + '" data-id="' + esc(b.id) + '">' +
      '<span class="nm">' + esc(b.name) + '</span><span class="bt-badge ' + cls + '">' + esc(b.shelf === 'research' ? 'Research' : ev) + '</span>' +
      '<span class="sn">' + esc(b.sentence) + '</span>' +
      '<canvas class="bt-thumb" data-thumb="' + i + '" aria-hidden="true"></canvas>' +
      '<span class="st"><span>' + st.trades + ' trades</span><span>' + BC.fmtPct(st.winRate) + ' won</span><span>' + BC.fmtR(st.avgR) + ' avg</span></span>' +
      (loaded ? '<span class="bt-inslot">In the slot now</span>' : '') + '</button>';
  }
  function renderLibrary() {
    if (!view) return;
    const box = q('[data-k="shelves"]'), L = S.library;
    let html;
    if (L.state === 'loading' || L.state === 'idle') html = '<p class="bt-empty">Reading the library...</p>';
    else if (L.state === 'none') html = '<p class="bt-empty" data-k="libNone">No frozen builds on this PC. Builds frozen in Bot-Lab show here once ChartBridge has their library file.</p>';
    else if (L.state === 'error') html = '<p class="bt-empty warn" data-k="libErr">' + esc(L.text) + '</p>';
    else {
      const sh = BC.shelves(L.bots), idx = b => L.bots.indexOf(b);
      html = '<div class="bt-shelf-h" data-in=".06,.34"><span class="bt-cap">Ready · L1 or higher</span><span class="bt-faint">' + sh.ready.length + '</span></div>' +
        '<div class="bt-shelf" data-shelf="ready">' + (sh.ready.map(b => entryHtml(b, idx(b))).join('') || '<p class="bt-empty">None.</p>') + '</div>' +
        '<div class="bt-shelf-h" data-in=".2,.48"><span class="bt-cap">Research · shadow only</span><span class="bt-faint">' + sh.research.length + '</span></div>' +
        '<div class="bt-shelf" data-shelf="research">' + (sh.research.map(b => entryHtml(b, idx(b))).join('') || '<p class="bt-empty">None.</p>') + '</div>' +
        (L.problems.length ? '<p class="bt-empty warn" title="' + esc(L.problems.join('\n')) + '">' + L.problems.length + ' ' + (L.problems.length === 1 ? 'entry was' : 'entries were') + ' left out: ' + esc(L.problems[0]) + '</p>' : '');
    }
    if (box.dataset.html !== html) {
      box.dataset.html = html; box.innerHTML = html;
      const entries = [...box.querySelectorAll('.bt-entry')];
      if (MO()) MO().stagger(entries, { start: 0.08, step: 0.05, span: 0.32, attr: 'in' });
      for (const c of box.querySelectorAll('canvas[data-thumb]')) {
        const b = L.bots[+c.dataset.thumb];
        c._draw = p => drawCurve(c, b.equity, p, false);
        c.setAttribute('data-in', c.closest('.bt-entry').getAttribute('data-in') || '0,1');
        c._draw(1);
      }
    }
    renderSlot();
  }
  function renderSlot() {
    const slot = q('[data-k="slot"]'); if (!slot) return;
    const b = S.bot, e = loadedEntry();
    const html = !b || !b.connected ? '<span class="bt-dot off"></span><span>Slot 1: no bot program connected</span>' :
      '<span class="bt-dot"></span><span>Slot 1: <b>' + esc(b.name || 'Bot') + '</b> in ' + esc(BC.MODE_NAME[b.mode] || b.mode) + (e ? '' : S.library.state === 'ok' ? ' <span class="bt-faint">(not in the library)</span>' : '') + '</span>';
    if (slot.dataset.html !== html) { slot.dataset.html = html; slot.innerHTML = html; }
  }
  function drawCurves() {
    if (!view) return;
    for (const c of view.querySelectorAll('canvas[data-thumb], canvas[data-k="eqbig"]')) if (typeof c._draw === 'function') c._draw(1);
  }
  let resizeT = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { const M = MO(); if (!M || !M.running()) drawCurves(); }, 120); });
  function playLibrary() { const M = MO(); const lib = q('.bt-lib'); if (M && lib) M.scene(lib, { ms: 900 }); }

  /* ---------------- the full-screen entry: large equity curve, tiles, rule card, settings, live record, conditions */
  function openDetail(i) {
    const b = S.library.bots[i]; if (!b) return;
    closeDetail();
    const st = b.stats, research = b.shelf === 'research';
    const tile = (label, v, dec, pre, suf, sign, k) => '<div class="bt-tile" data-in="' + (0.1 + k * 0.04).toFixed(2) + ',' + (0.4 + k * 0.04).toFixed(2) + '"><div class="v mono">' +
      (isNum(v) ? '<span data-count="' + v + '" data-dec="' + dec + '"' + (sign ? ' data-sign="1"' : '') + (pre ? ' data-pre="' + pre + '"' : '') + (suf ? ' data-suf="' + esc(suf) + '"' : '') + ' data-in="' + (0.12 + k * 0.04).toFixed(2) + ',' + (0.62 + k * 0.04).toFixed(2) + '">' + esc((MO() ? MO().formatNumber(v, { dec, sign, prefix: pre, suffix: suf }) : v)) + '</span>' : '-') +
      '</div><div class="l">' + esc(label) + '</div></div>';
    const tiles = [tile('Trades', st.trades, 0, '', '', false, 0), tile('Won', isNum(st.winRate) ? st.winRate * 100 : null, 1, '', '%', false, 1), tile('Average', st.avgR, 2, '', ' R', true, 2),
      tile('Profit factor', st.profitFactor, 2, '', '', false, 3), tile('Worst drawdown', st.worstDrawdownR, 1, '', ' R', false, 4), tile('Days traded', st.days, 0, '', '', false, 5)].join('');
    const settings = Object.keys(b.settings).map(k => '<span class="k">' + esc(k) + '</span><span class="v mono">' + esc(String(b.settings[k])) + '</span>').join('') || '<span class="k">None</span><span></span>';
    const rules = BC.ruleLines(b.ruleCard).map(l => '<li>' + esc(l) + '</li>').join('');
    const loaded = loadedEntry() === b;
    const d = document.createElement('div');
    d.className = 'bt-detail';
    d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-label', b.name);
    d.innerHTML = '<div class="bt-dcard motion-atmo">' +
      '<div class="bt-dhead"><span class="stamp bt-stamp' + (research ? ' rs' : '') + '">' + esc(b.evidence) + ' · ' + (research ? 'Research' : 'Ready') + '</span>' +
        '<div class="bt-dtitle" data-in="0,.3"><h2>' + esc(b.name) + '</h2><p>' + esc(b.sentence) + '</p></div>' +
        '<button type="button" class="ws-btn bt-close" data-act="close">Close <span class="bt-keycap">Esc</span></button></div>' +
      '<div class="bt-dbody"><div class="bt-dcol">' +
        '<div class="bt-box" data-in=".05,.35"><h3>Equity curve <span class="bt-faint">frozen test record, in R</span></h3><div class="bt-eqbig"><canvas data-k="eqbig" data-in=".08,.9" aria-label="Equity curve of the frozen test record"></canvas></div></div>' +
        '<div class="bt-box" data-in=".2,.5"><h3>Conditions it works best in <span class="bt-faint">frozen test record · trades in each cell · faded under ' + BC.THIN + ' trades</span></h3>' + condHtml(b) + '</div>' +
      '</div><div class="bt-dcol">' +
        '<div class="bt-tiles">' + tiles + '</div>' +
        '<div class="bt-box" data-in=".3,.6"><h3>Rule card</h3><ol class="bt-rules">' + rules + '</ol></div>' +
        '<div class="bt-box" data-in=".36,.66"><h3>Settings</h3><div class="bt-kv">' + settings + '</div></div>' +
        '<div class="bt-box" data-in=".42,.72" data-no-motion><h3>Live record since loaded</h3><div class="bt-kv">' + liveRecordHtml(b, loaded) + '</div></div>' +
        (b.frozen ? '<p class="bt-faint" data-in=".46,.76">Frozen ' + esc(b.frozen) + ' in Bot-Lab. The library is read only: the bot program on this PC chooses what runs in the slot.</p>' : '') +
      '</div></div></div>';
    (view || document.body).appendChild(d);
    S.detail = { el: d, i };
    const card = d.querySelector('.bt-dcard'), cv = d.querySelector('[data-k="eqbig"]');
    cv._draw = p => drawCurve(cv, b.equity, p, true);
    cv._draw(1);
    d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-act="close"]')) closeDetail(); });
    d.querySelector('[data-act="close"]').focus({ preventScroll: true });
    const M = MO();
    if (M) M.scene(card, { ms: 1300 });
  }
  function closeDetail() { if (S.detail) { S.detail.el.remove(); S.detail = null; } }
  function liveRecordHtml(b, loaded) {
    if (!loaded) return '<span class="k">In the slot</span><span class="v">No</span>';
    const bot = S.bot || {}, sigs = log.list().filter(e => e.kind === 'signal').length;
    return '<span class="k">In the slot</span><span class="v">Yes, in ' + esc(BC.MODE_NAME[bot.mode] || '-') + '</span>' +
      '<span class="k">Signals today</span><span class="v mono">' + sigs + '</span>' +
      '<span class="k">Trades today</span><span class="v mono">' + (isNum(bot.trades) ? bot.trades : '-') + ' (Sim101)</span>' +
      '<span class="k">Result today</span><span class="v mono ' + (bot.pnlToday > 0 ? 'pos' : bot.pnlToday < 0 ? 'neg' : '') + '">' + esc(BC.fmtUsd(bot.pnlToday) || '-') + '</span>';
  }
  function condHtml(b) {
    const C = b.conditions;
    const tod = BC.timeOfDayRow(C.timeOfDay);
    const maxR = Math.max(0.05, ...tod.map(c => Math.abs(c.avgR)));
    const todHtml = tod.length ? '<div class="bt-tod" style="grid-template-columns:repeat(' + tod.length + ',minmax(0,1fr))">' + tod.map((c, i) => {
      const h = Math.max(3, Math.round(Math.abs(c.avgR) / maxR * 100)), a = (0.24 + i * 0.02).toFixed(2), z = (0.5 + i * 0.02).toFixed(2);
      return '<div class="b' + (BC.thinCell(c) ? ' thin' : '') + '" title="' + esc(c.key + ' ET: ' + BC.fmtR(c.avgR) + ' average, ' + BC.fmtPct(c.winRate) + ' won, ' + c.trades + ' trades') + '">' +
        '<div class="bar ' + (c.avgR >= 0 ? 'up' : 'dn') + '" data-grow="' + a + ',' + z + '" style="height:' + h + '%"></div><div class="n mono">' + c.trades + '</div></div>';
    }).join('') + '</div><div class="bt-tod-axis" style="grid-template-columns:repeat(' + tod.length + ',minmax(0,1fr))">' + tod.map((c, i) => '<span>' + (i % 3 === 0 ? esc(c.key.replace(/^0/, '')) : '') + '</span>').join('') + '</div>'
      : '<p class="bt-empty">No time-of-day cells in the file.</p>';
    const hb = (list, k0) => (list.length ? list.map((c, i) => {
      const m = Math.max(0.05, ...list.map(x => Math.abs(x.avgR))), w = Math.max(2, Math.round(Math.abs(c.avgR) / m * 50)), a = (k0 + i * 0.03).toFixed(2), z = (k0 + 0.3 + i * 0.03).toFixed(2);
      return '<div class="bt-hb' + (BC.thinCell(c) ? ' thin' : '') + '" title="' + esc(BC.fmtPct(c.winRate) + ' won') + '"><span class="lb">' + esc(c.key) + '</span>' +
        '<span class="track"><i class="' + (c.avgR >= 0 ? 'up' : 'dn') + '" data-grow="' + a + ',' + z + '" style="width:' + w + '%;' + (c.avgR >= 0 ? 'left:50%' : 'right:50%;transform-origin:right center') + '"></i></span>' +
        '<span class="val mono"><span class="' + (c.avgR > 0 ? 'pos' : c.avgR < 0 ? 'neg' : '') + '">' + esc(BC.fmtR(c.avgR) || '0 R') + '</span> ' + c.trades + '</span></div>';
    }).join('') : '<p class="bt-empty">None in the file.</p>');
    return '<div class="bt-cond"><div><span class="bt-cap">Time of day <span class="bt-capn">30 minutes, ET</span></span>' + todHtml + '</div>' +
      '<div><span class="bt-cap">Day type</span>' + hb(C.dayType, 0.3) + '</div>' +
      '<div><span class="bt-cap">Volatility band</span>' + hb(C.volBand, 0.36) + '</div>' +
      '<div><span class="bt-cap">Level type and side</span>' + hb(C.levelSide, 0.42) + '</div></div>';
  }
  /* an equity curve drawn up to progress p (0 to 1): a line with a soft fill, and for the large one its axis */
  let colors = null;
  function css() {
    if (colors) return colors;
    const s = getComputedStyle(document.documentElement), g = (k, d) => (s.getPropertyValue(k) || '').trim() || d;
    colors = { pos: g('--ws-buy', '#3DDC97'), neg: g('--ws-sell', '#FF5C7A'), line: g('--ws-line', '#18212C'), muted: g('--ws-muted', '#7F8C9C'), mono: g('--ws-mono', 'monospace') };
    return colors;
  }
  function drawCurve(c, eq, p, big) {
    const M = MO();
    const f = M ? M.fitCanvas(c) : (() => { const r = c.getBoundingClientRect(); c.width = Math.max(1, r.width); c.height = Math.max(1, r.height); return { ctx: c.getContext('2d'), w: c.width, h: c.height }; })();
    const ctx = f.ctx, w = f.w, h = f.h;
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const pts = BC.thinEquity(eq, big ? 600 : 120);
    if (pts.length < 2) return;
    const K = css();
    const padL = big ? 44 : 2, padR = big ? 10 : 4, padT = big ? 10 : 4, padB = big ? 20 : 3;
    const lo = Math.min(0, ...pts), hi = Math.max(0, ...pts), span = hi - lo || 1;
    const X = i => padL + (w - padL - padR) * i / (pts.length - 1), Y = v => padT + (h - padT - padB) * (1 - (v - lo) / span);
    if (big) {
      ctx.font = '500 10px ' + K.mono; ctx.fillStyle = K.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      const step = niceStep(span / 4);
      for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
        const y = Y(v);
        ctx.strokeStyle = K.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(padL, Math.round(y) + 0.5); ctx.lineTo(w - padR, Math.round(y) + 0.5); ctx.stroke();
        ctx.fillText((Math.round(v * 10) / 10) + ' R', padL - 6, y);
      }
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText('first trade', padL, h - 4);
      ctx.textAlign = 'right'; ctx.fillText(eq.length + ' trades', w - padR, h - 4);
    } else {
      ctx.strokeStyle = K.line; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(0, Math.round(Y(0)) + 0.5); ctx.lineTo(w, Math.round(Y(0)) + 0.5); ctx.stroke(); ctx.setLineDash([]);
    }
    const n = Math.max(2, Math.ceil(pts.length * Math.max(0, Math.min(1, p))));
    const col = pts[pts.length - 1] >= 0 ? K.pos : K.neg;
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = X(i), y = Y(pts[i]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    const lx = X(n - 1);
    ctx.save();
    ctx.lineTo(lx, Y(lo)); ctx.lineTo(X(0), Y(lo)); ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
    grad.addColorStop(0, hexA(col, big ? 0.28 : 0.22)); grad.addColorStop(1, hexA(col, 0));
    ctx.fillStyle = grad; ctx.fill();
    ctx.restore();
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = X(i), y = Y(pts[i]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.strokeStyle = col; ctx.lineWidth = big ? 1.8 : 1.4; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(lx, Y(pts[n - 1]), big ? 3.5 : 2.2, 0, Math.PI * 2); ctx.fill();
  }
  const niceStep = x => { const e = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1e-6)))), m = x / e; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e; };
  function hexA(hex, a) { const m = /^#?([0-9a-f]{6})$/i.exec(hex); if (!m) return 'rgba(61,220,151,' + a + ')'; const n = parseInt(m[1], 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; }

  /* ---------------- the panel */
  const botRoot = () => (S.bot && S.bot.root) || 'MNQ';
  function render() {
    const off = !S.on;
    if (tabBtn) {
      put(tabBtn, 'hidden', S.v3 !== true && !S.shown);           // a ChartBridge that speaks v3 has a Bot tab
      attr(tabBtn, 'aria-pressed', String(S.shown));
      tog(tabBtn, 'bt-alert', S.on && !!S.bot && (BC.rails(S.bot).level === 'red' || !!S.bot.standDown || !!S.bot.killed || (S.bot.enabled && !S.bot.connected)));
      attr(tabBtn, 'title', off ? 'Bot: the bot channel is off on this PC' : 'Bot tab');
    }
    if (view) {
      const offEl = q('[data-k="off"]'), grid = q('[data-k="grid"]');
      put(offEl, 'hidden', !off); put(grid, 'hidden', off);
      put(q('[data-k="offText"]'), 'textContent', offText());
      if (off) { unmountChart(); closeDetail(); } else if (S.shown) mountChart();
    }
    if (off) { for (const id of [...propEls.keys()]) dropProposal(id); }
    renderPanel(); renderStrip(); renderGhosts(); renderChartLines();
  }
  function offText() {
    if (S.v3 === null) return 'Connecting to ChartBridge...';
    if (S.v3 === false) return 'This ChartBridge (' + (S.version || 'an older one') + ') has no bot channel. The bot channel comes with ChartBridge 0.4.0.';
    if (!S.trading) return 'Signing in to ChartBridge...';
    if (!S.trading.enabled) return 'Trading is not enabled in ChartBridge on this PC, so the bot channel is off.';
    return 'The bot channel is off on this PC (bot in ChartBridge\'s config.txt). Nothing here works until it is turned on.';
  }
  function renderPanel() {
    if (!view || !S.on) return;
    const b = S.bot || {}, e = loadedEntry(), allowed = BC.modesAllowed({ entry: e, simTradable: BC.simTradable(S.accounts, S.trading) });
    const on = !!(b.enabled && b.connected);
    const oo = q('[data-k="onoff"]');
    put(oo, 'textContent', !b.enabled ? 'Off' : b.killed ? 'Killed' : b.connected ? 'On' : 'Lost');
    put(oo, 'className', 'bt-onoff ' + (!b.enabled ? 'off' : b.killed || !b.connected ? 'bad' : 'ok'));
    const ev = q('[data-k="ev"]');
    put(ev, 'hidden', !e);
    if (e) { put(ev, 'textContent', e.shelf === 'research' ? 'Research' : e.evidence); put(ev, 'className', 'bt-badge ' + (e.shelf === 'research' ? 'rs' : BC.evidenceLevel(e.evidence) >= 2 ? 'l2' : '')); }
    for (const btn of q('[data-k="modes"]').children) {
      const m = btn.dataset.mode, a = allowed[m];
      attr(btn, 'aria-pressed', String(b.mode === m));
      put(btn, 'disabled', !a.ok || !S.signedIn);
      attr(btn, 'title', a.ok ? (m === 'auto' ? 'ChartBridge places the bot\'s signals on Sim101 by itself' : m === 'copilot' ? 'Each signal is a proposal: you accept or reject it' : 'Signals are shown and logged; no orders') : a.why);
      put(btn, 'textContent', m === 'auto' && S.autoConfirm > Date.now() ? 'Confirm' : BC.MODE_NAME[m]);
    }
    const research = e && e.shelf === 'research';
    const why = q('[data-k="modeWhy"]');
    if (!why.dataset.refused) { put(why, 'hidden', !research); put(why, 'textContent', research ? 'A Research build runs in Shadow only.' : ''); }
    put(q('[data-k="name"]'), 'textContent', b.name || (b.enabled ? 'No bot program connected' : '-'));
    put(q('[data-k="account"]'), 'textContent', b.account || 'Sim101');
    put(q('[data-k="size"]'), 'textContent', (b.root || botRoot()) + ' (' + (MICRO[b.root || botRoot()] || 'contract') + '), 1 contract');
    put(q('[data-k="status"]'), 'textContent', BC.statusText(b));
    const beat = q('[data-k="beat"]');
    put(beat, 'textContent', on && isNum(b.lastBeatMs) ? (b.lastBeatMs / 1000).toFixed(1) + ' s ago' : b.enabled ? 'none' : '-');
    put(beat, 'className', 'v mono ' + (!on ? 'neg' : b.lastBeatMs > 2500 ? 'warn' : 'pos'));
    // position and P&L: instant (R3), never counted up
    put(q('[data-k="pos"]'), 'textContent', BC.positionText(b.position, p => fmtPx(p)));
    const pnl = q('[data-k="pnl"]');
    put(pnl, 'textContent', isNum(b.pnlToday) ? BC.fmtUsd(b.pnlToday) : '-');
    put(pnl, 'className', 'v mono ' + (b.pnlToday > 0 ? 'pos' : b.pnlToday < 0 ? 'neg' : ''));
    const r = BC.rails(b);
    for (const [k, x] of [['T', r.trades], ['L', r.losses]]) {
      const box = q('[data-k="rail' + k + '"]');
      put(q('[data-k="rail' + k + 'Text"]'), 'textContent', x.text);
      const bar = box.querySelector('i');
      const w = (x.pct * 100).toFixed(1) + '%';
      if (bar.style.width !== w) bar.style.width = w;
      put(bar, 'className', x.level === 'ok' ? '' : x.level);
      tog(box, 'amber', x.level === 'amber'); tog(box, 'red', x.level === 'red');
    }
    put(q('[data-k="railsOpen"]'), 'disabled', !S.signedIn || !isNum(b.maxTrades));
    put(q('[data-k="railsEdit"]'), 'hidden', !S.railsEdit);
    const kill = q('[data-k="kill"]');
    put(kill, 'textContent', b.killed ? (S.killConfirm > Date.now() ? 'Release: click again' : 'Kill switch on · Release') : 'Kill switch');
    tog(kill, 'on', !!b.killed);
    put(kill, 'disabled', !S.signedIn);
    attr(kill, 'aria-pressed', String(!!b.killed));
    const cur = days.current();
    for (const btn of q('[data-k="dtype"]').children) attr(btn, 'aria-pressed', String(btn.dataset.dt === cur));
    const calls = days.calls();
    put(q('[data-k="dtWhy"]'), 'textContent', calls.length ? 'Called ' + cur + ' at ' + BC.etClock(calls[calls.length - 1].at) + ' ET (' + calls.length + (calls.length === 1 ? ' call' : ' calls') + ' today, all in the Log)' : 'No call yet today.');
    renderSlot();
    if (S.library.state === 'ok') for (const btn of q('[data-k="shelves"]').querySelectorAll('.bt-entry')) tog(btn, 'loaded', btn.dataset.id === (e && e.id));
    renderPanelTab();
  }
  function renderPanelTab() {
    if (!view || !S.on) return;
    for (const b of view.querySelectorAll('[data-ptab]')) attr(b, 'aria-selected', String(b.dataset.ptab === S.panelTab));
    const box = q('[data-k="tabBody"]');
    let html = '';
    if (S.panelTab === 'today') html = todayHtml();
    else if (S.panelTab === 'log') html = logHtml();
    else html = optionsHtml();
    if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
  }
  function todayHtml() {
    const list = log.list(), props2 = new Map(list.filter(e => e.kind === 'proposal' && e.extra).map(e => [e.extra.id, e.extra]));
    const sigs = list.filter(e => e.kind === 'signal' && e.extra).reverse();
    const tr = trips();
    let html = '';
    if (tr.length) {
      const r = botRoot(), pv = (S.instruments[r] && +S.instruments[r].pointValue) || 0;
      html += '<div class="bt-cap">Trades today</div>' + tr.slice().reverse().map(t => {
        const pts = t.tOut === null ? null : (t.pOut - t.pIn) * t.dir;
        return '<div class="bt-sig"><span class="mono t">' + esc(etFromChart(t.tIn)) + '</span><span><b>' + (t.dir > 0 ? 'Long' : 'Short') + ' ' + t.qty + '</b> in ' + fmtPx(t.pIn) + (t.tOut === null ? ', open' : ', out ' + fmtPx(t.pOut)) + '</span>' +
          '<span class="mono ' + (pts > 0 ? 'pos' : pts < 0 ? 'neg' : '') + '">' + (pts === null ? '' : esc(BC.fmtUsd(pts * pv * t.qty))) + '</span></div>';
      }).join('');
    }
    html += '<div class="bt-cap">Signals today</div>';
    if (!sigs.length) return html + '<p class="bt-empty">No signal yet today.</p>';
    return html + sigs.map(e => {
      const s = e.extra, line = BC.signalLine(s), p = props2.get(s.id);
      let title = line.title;
      if (p) {
        const react = isNum(p.seenAt) && isNum(p.answeredAt) ? ' in ' + ((p.answeredAt - p.seenAt) / 1000).toFixed(1) + ' s' : '';
        title = (s.side === 'buy' ? 'Long' : 'Short') + ' · ' + ({ open: 'waiting for you', accepted: 'accepted' + react, rejected: 'rejected' + react, withdrawn: 'not answered', 'not answered': 'not answered' }[p.state] || p.state);
      }
      return '<div class="bt-sig ' + line.tone + '"><span class="mono t">' + esc(line.time) + '</span><span><b>' + esc(title) + '</b><span class="why">' + esc(line.why) + '</span></span><span></span></div>';
    }).join('');
  }
  function etFromChart(t) { const s = ((Math.floor(t) % 86400) + 86400) % 86400; return String(Math.floor(s / 3600)).padStart(2, '0') + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0'); }
  function logHtml() {
    const list = log.list().filter(e => e.kind !== 'fill').concat(days.calls().map(c => ({ at: c.at, kind: 'daytype', text: 'Day type called: ' + c.type, level: '' }))).sort((a, b) => b.at - a.at);
    if (!list.length) return '<p class="bt-empty">Nothing logged yet today.</p>';
    return list.slice(0, 200).map(e => '<div class="bt-log ' + esc(e.level || '') + '"><span class="mono t">' + esc(BC.etClockSec(e.at)) + '</span><span class="kd">' + esc(e.kind) + '</span><span>' + esc(e.text) + '</span></div>').join('');
  }
  function optionsHtml() {
    const M = MO(), less = M ? M.reduced() : true;
    const k = S.keys;
    const keys = k.accept || k.reject ? 'Accept ' + (k.accept ? '<span class="bt-keycap">' + esc(k.accept) + '</span>' : 'none') + ', Reject ' + (k.reject ? '<span class="bt-keycap">' + esc(k.reject) + '</span>' : 'none') + ' (The Desk\'s hotkeys)' :
      k.from === 'desk' ? 'None set on The Desk: Accept and Reject are buttons only.' : k.from === 'none' ? 'The Desk could not be reached for the keys: Accept and Reject are buttons only.' : 'Reading The Desk\'s hotkeys...';
    return '<div class="bt-opt"><span>Sound with a notice</span><span class="ws-seg" role="group"><button type="button" data-opt="sound" data-v="off" aria-pressed="' + !opts.sound + '">Off</button><button type="button" data-opt="sound" data-v="on" aria-pressed="' + opts.sound + '">On</button></span></div>' +
      '<div class="bt-opt"><span>Motion</span><span class="ws-seg" role="group"><button type="button" data-opt="motion" data-v="full" aria-pressed="' + !less + '">Full</button><button type="button" data-opt="motion" data-v="less" aria-pressed="' + less + '">Less</button></span></div>' +
      '<p class="bt-help">Less motion shows every scene in its final state. The kill switch, Accept and Reject, the position and P&amp;L never move either way.</p>' +
      '<div class="bt-opt"><span>Copilot keys</span><span>' + keys + '</span></div>' + (k.notes && k.notes.length ? '<p class="bt-help warn">' + esc(k.notes.join('; ')) + '</p>' : '') +
      '<p class="bt-help">Ghost marks: the bot\'s trades, faint, on your own charts. Switch them on per chart from the chart\'s ⋯ menu (off by default).</p>' +
      (popout ? '' : '<div class="bt-opt"><span>This tab in its own window</span><button type="button" class="ws-btn" data-act="popout">Pop out</button></div>');
  }

  /* ---------------- actions */
  function sendBot(m, kind) {
    const c = cid(); m.cid = c;
    if (!S.signedIn || !sendRaw(m)) { notice({ kind: 'refused', level: 'amber', text: 'Not sent: not signed in to ChartBridge.' }); return false; }
    S.pending.set(c, { kind });
    setTimeout(() => S.pending.delete(c), 15000);
    return true;
  }
  function modeWhy(t) { const w = q('[data-k="modeWhy"]'); if (!w) return; w.dataset.refused = '1'; put(w, 'hidden', false); put(w, 'textContent', t); setTimeout(() => { delete w.dataset.refused; renderPanel(); }, 6000); }
  function railsWhy(t) { put(q('[data-k="railsWhy"]'), 'textContent', t); }
  function onViewClick(e) {
    const t = e.target;
    const mode = t.closest('[data-mode]'), dt = t.closest('[data-dt]'), act = t.closest('[data-act]'), ent = t.closest('.bt-entry'), pt = t.closest('[data-ptab]'), op = t.closest('[data-opt]');
    if (mode && !mode.disabled) {
      const m = mode.dataset.mode;
      if (S.bot && S.bot.mode === m) return;
      if (m === 'auto' && !(S.autoConfirm > Date.now())) { S.autoConfirm = Date.now() + 4000; renderPanel(); setTimeout(renderPanel, 4100); return; }
      S.autoConfirm = 0;
      if (sendBot({ type: 'botMode', mode: m }, 'mode')) log.add({ k: 'askmode:' + Date.now(), kind: 'mode', text: 'Asked for ' + BC.MODE_NAME[m] });
      return;
    }
    if (dt) {
      const r = days.call(dt.dataset.dt);
      put(q('[data-k="dtWhy"]'), 'textContent', r.error || '');
      renderPanel();
      return;
    }
    if (pt) { S.panelTab = pt.dataset.ptab; if (S.panelTab === 'options' && !S.keys.from) loadKeys(); renderPanelTab(); return; }
    if (op) {
      if (op.dataset.opt === 'sound') { BC.setOption(storage, 'sound', op.dataset.v === 'on'); opts = BC.readOptions(storage); if (opts.sound) beep(''); }
      else if (op.dataset.opt === 'motion' && MO()) { MO().setReducedMotion(op.dataset.v === 'less'); if (typeof o.onMotion === 'function') o.onMotion(); }
      renderPanelTab();
      return;
    }
    if (ent) { openDetail(+ent.dataset.entry); return; }
    if (!act) return;
    const a = act.dataset.act;
    if (a === 'kill') {
      // R3: instant. On: one click, always. Release: a second click within 4 s (it lets the bot trade again).
      const b = S.bot || {};
      if (!b.killed) { if (sendBot({ type: 'botKill', on: true }, 'kill')) log.add({ k: 'kill:' + Date.now(), kind: 'kill', text: 'Kill switch pressed', level: 'red' }); return; }
      if (!(S.killConfirm > Date.now())) { S.killConfirm = Date.now() + 4000; renderPanel(); setTimeout(renderPanel, 4100); return; }
      S.killConfirm = 0;
      if (sendBot({ type: 'botKill', on: false }, 'kill')) log.add({ k: 'kill:' + Date.now(), kind: 'kill', text: 'Kill switch released' });
      renderPanel();
    } else if (a === 'railsOpen') {
      const b = S.bot || {};
      S.railsEdit = true; railsWhy('');
      q('[data-k="railTIn"]').max = b.maxTrades; q('[data-k="railTIn"]').value = b.maxTrades;
      q('[data-k="railLIn"]').max = b.maxLosses; q('[data-k="railLIn"]').value = b.maxLosses;
      renderPanel();
      q('[data-k="railTIn"]').focus();
    } else if (a === 'railsCancel') { S.railsEdit = false; railsWhy(''); renderPanel(); }
    else if (a === 'railsSave') {
      const r = BC.railsChange(S.bot, { maxTrades: q('[data-k="railTIn"]').value, maxLosses: q('[data-k="railLIn"]').value });
      if (r.error) { railsWhy(r.error); return; }
      if (sendBot(r.msg, 'rails')) { S.railsEdit = false; railsWhy('Sent. ChartBridge holds the tighter rails until 18:00 ET.'); log.add({ k: 'askrails:' + Date.now(), kind: 'rails', text: 'Asked to tighten: ' + r.msg.maxTrades + ' trades, ' + r.msg.maxLosses + ' losing trades' }); }
      renderPanel();
    } else if (a === 'popout') popOut();
  }
  function popOut() {
    const w = window.open('bot.html', 'chartbridge-bot', 'popup=yes,width=1480,height=900');
    if (w) { try { w.focus(); } catch (e) { /* another window */ } } else notice({ kind: 'status', level: 'amber', text: 'The browser blocked the new window: allow pop-ups for this page.' });
  }
  if (view) {
    view.addEventListener('click', onViewClick);
    view.addEventListener('change', e => {
      if (e.target.closest('[data-k="tf"]')) { S.chartTf = TF_NAMES[e.target.value] ? e.target.value : 'm1'; try { storage.setItem(CHART_KEY, JSON.stringify({ tf: S.chartTf })); } catch (er) { /* blocked */ } if (S.chart) S.chart.setView({ tf: S.chartTf }); renderChartHead(); }
    });
    view.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.closest('.bt-rails-edit input')) { e.preventDefault(); q('[data-act="railsSave"]').click(); } });
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.detail) { e.preventDefault(); closeDetail(); } });

  /* ---------------- the Bot tab's chart: a normal live chart on the window's feed (never animated) */
  try { const v = JSON.parse(storage.getItem(CHART_KEY)); if (v && TF_NAMES[v.tf]) S.chartTf = v.tf; } catch (e) { /* none */ }
  const chartHost = {
    pressOff: () => 'The Bot tab\'s chart is for watching: it takes no orders. Its lines are the bot\'s own working orders.',
    place: () => {}, move: () => {}, cancel: () => {},
  };
  function mountChart() {
    if (!view || S.chart || !window.ChartLive || !o.feed) return;
    const body = q('[data-k="chart"]');
    S.chartRoot = botRoot();
    S.chart = window.ChartLive.mount(body, {
      feed: o.feed, paneId: 'bot', storagePrefix: o.storagePrefix || '', toolbar: false, compact: true, trade: chartHost,
      view: { root: S.chartRoot, tf: S.chartTf },
      onStatus: s => { if (s.state === 'live') { S.contract = typeof s.contract === 'string' ? s.contract : ''; renderChartHead(); } },
    });
    q('[data-k="ind"]').append(S.chart.indicators, S.chart.chips);
    if (S.chart.badge) q('[data-k="ind"]').append(S.chart.badge);
    q('[data-k="tf"]').value = S.chartTf;
    renderChartHead(); renderChartLines(true); renderTrips();
  }
  function unmountChart() {
    if (!S.chart) return;
    const c = S.chart; S.chart = null;
    try { c.destroy(); c.indicators.remove(); c.chips.remove(); if (c.badge) c.badge.remove(); } catch (e) { /* gone */ }
  }
  function renderChartHead() { if (view) put(q('[data-k="chartName"]'), 'textContent', (S.contract && S.contract.split(' ')[0] === S.chartRoot ? S.contract : S.chartRoot || botRoot()) + ' · ' + TF_NAMES[S.chartTf]); }
  let linesSig = '';
  function renderChartLines(force) {
    if (!S.chart) { linesSig = ''; return; }
    if (S.chartRoot !== botRoot()) { unmountChart(); if (S.shown && S.on) mountChart(); return; }
    const sig = JSON.stringify([[...S.orders.values()], S.bot && S.bot.position, S.bot && S.bot.account]);
    if (sig === linesSig && force !== true) return;
    linesSig = sig;
    const r = S.chartRoot, list = [...S.orders.values()].filter(x => x.root === r && x.account === ((S.bot && S.bot.account) || 'Sim101'));
    const OT = window.OrderTicket, out = [];
    for (const x of list) { out.push(x); if (OT && OT.plannedLines && x.planned) { try { for (const l of OT.plannedLines(x, tickOf(r)).lines) out.push(l); } catch (e) { /* older order-ticket.js */ } } }
    const pos = S.bot && S.bot.position && S.bot.position.qty ? { qty: S.bot.position.qty, avgPrice: S.bot.position.avgPrice } : null;
    S.chart.setTrade({ root: r, account: (S.bot && S.bot.account) || 'Sim101', live: false, orders: out, position: pos, pointValue: (S.instruments[r] && +S.instruments[r].pointValue) || 0, qty: 1 });
  }
  function renderTrips() {
    const tr = S.on ? trips() : [];
    if (S.chart && S.chart.chart) { S.chart.chart.setLayers({ trades: true }); S.chart.chart.setTrades(tr); }
    renderGhosts(tr);
  }

  /* ---------------- ghost marks: the bot's trades, faint, on Anthony's own charts (per chart, off by default) */
  let ghostSig = '';
  function renderGhosts(tr, force) {
    if (typeof o.charts !== 'function') return;
    const on = BC.readGhosts(storage), list = S.on ? (tr || trips()) : [];
    const charts = o.charts();
    // written only when something changed (the `bot` message comes once a second)
    const sig = JSON.stringify([on, list, S.on, botRoot(), charts.map(c => c && c.id + ':' + c.root)]);
    if (sig === ghostSig && !force) return;
    ghostSig = sig;
    const ghosts = list.map(t => Object.assign({}, t, { ghost: true }));
    for (const c of charts) {
      if (!c || !c.chart) continue;
      const want = S.on && on[c.id] === true && FAMILY[c.root] === FAMILY[botRoot()];
      if (want) { c.chart.setLayers({ trades: true }); c.chart.setTrades(ghosts); c.ghost = true; }
      else if (c.chart.__btGhost) { c.chart.setTrades([]); c.chart.setLayers({ trades: false }); }
      c.chart.__btGhost = want;
    }
  }

  /* ---------------- the bot strip (Main tab only): one thin line per bot */
  function renderStrip() {
    if (!strip) return;
    const show = S.on && !!S.bot && !S.shown && S.layout === 'Main';
    put(strip, 'hidden', !show);
    if (!show) return;
    const m = BC.stripModel(S.bot, p => fmtPx(p));
    const meter = r => '<span class="bt-smeter"><i class="' + (r.level === 'ok' ? '' : r.level) + '" style="width:' + (r.pct * 100).toFixed(1) + '%"></i></span>';
    const html = '<button type="button" class="bt-sline ' + m.level + ' st-' + m.state + '" data-act="strip" title="Open the Bot tab">' +
      '<span class="bt-dot' + (m.state === 'on' ? '' : m.state === 'off' ? ' off' : ' bad') + '"></span><span class="nm">' + esc(m.name) + '</span>' +
      '<span class="bt-mode">' + esc(m.mode) + '</span><span class="mono">' + esc(m.position) + '</span>' +
      '<span class="mono ' + m.pnlTone + '">' + esc(m.pnl) + '</span><span class="bt-last">' + esc(m.last) + '</span>' +
      '<span class="lim ' + m.trades.level + '">Trades ' + meter(m.trades) + '<span class="mono">' + esc(m.trades.text) + '</span></span>' +
      '<span class="lim ' + m.losses.level + '">Losses ' + meter(m.losses) + '<span class="mono">' + esc(m.losses.text) + '</span></span>' +
      (m.state !== 'on' ? '<span class="bt-state">' + esc({ off: 'Off', killed: 'Kill switch on', standDown: 'Stood down', lost: 'Heartbeat lost' }[m.state]) + '</span>' : '') +
      '<span class="bt-go">Bot tab ›</span></button>';
    if (strip.dataset.html !== html) { strip.dataset.html = html; strip.innerHTML = html; }
  }
  if (strip) strip.addEventListener('click', e => { if (e.target.closest('[data-act="strip"]')) showTab(true); });

  /* ---------------- the tab */
  function showTab(on) {
    on = !!on || popout;
    if (on === S.shown) return;
    S.shown = on;
    if (typeof o.onTab === 'function') o.onTab(on);
    render();
    if (on && S.on) {
      if (S.library.state === 'idle' || Date.now() - S.libAt > 60000) loadLibrary();
      if (!play()) drawCurves();
    } else closeDetail();
  }
  if (tabBtn) tabBtn.addEventListener('click', () => showTab(!S.shown));
  /** The entrance scene (motion kit): the Library, the panel's pieces and the chart's header rise in; the chart, the
      kill switch, the mode, position and P&L do not move (R3). A click or key during it finishes it and acts (R4). */
  function play() {
    const M = MO(), grid = q('[data-k="grid"]');
    if (!M || !grid || grid.hidden) return null;
    return M.scene(grid, { ms: 1100 });
  }

  /* ---------------- heartbeat line: once a second while the tab or the strip shows (the `bot` message comes as often) */
  /* (the `bot` message arrives once a second from ChartBridge while the bot is connected: render() covers it) */

  if (popout) S.shown = true;
  connect();
  render();
  if (!popout) setTimeout(loadKeys, 1500); else loadKeys();

  const api = {
    VERSION,
    showTab, shown: () => S.shown, on: () => S.on,
    layoutChanged(name) { S.layout = String(name || ''); if (S.shown && !popout) showTab(false); renderStrip(); },
    /** the chart menu's ghost switch (workspace.js): whether it is offered and on, and to flip it */
    ghostOffered: () => S.on,
    ghostOn: id => BC.readGhosts(storage)[id] === true,
    setGhost(id, on) { BC.setGhost(storage, id, on); renderGhosts(null, true); },
    chartsChanged() { renderGhosts(null, true); },
    replay: () => play(),
    answer: (id, ans) => answer(id, ans),
    /* read only, for the tests and the console */
    state: () => ({ on: S.on, v3: S.v3, signedIn: S.signedIn, shown: S.shown, bot: S.bot, library: { state: S.library.state, n: S.library.bots.length, problems: S.library.problems.slice() },
      proposals: [...propEls.keys()], keys: Object.assign({}, S.keys), dayType: days.current(), dayCalls: days.calls().length, log: log.list().length, trips: trips(), chart: !!S.chart, detail: !!S.detail }),
    chart: () => (S.chart ? S.chart.chart : null),
    destroy() { S.destroyed = true; clearTimeout(S.timer); if (S.sock) { const s = S.sock; S.sock = null; try { s.close(); } catch (e) { /* closed */ } } unmountChart(); document.removeEventListener('keydown', onKey, true); propBox.remove(); },
  };
  window.addEventListener('storage', e => {
    if (e.key === BC.KEYS.log || e.key === BC.KEYS.dayType) { renderPanel(); renderTrips(); }
    else if (e.key === BC.KEYS.ghost) renderGhosts();
    else if (e.key === BC.KEYS.options) { opts = BC.readOptions(storage); renderPanelTab(); }
  });
  return api;
}

window.BotDesk = { create, VERSION };
})();
