/*
 * AgentDesk: the Agent tab (chart page 1.17.0; ChartBridge 0.5.0's agent channel, contract AGENT_CHANNEL v1,
 * docs/AGENT_TAB.md). Where Anthony watches and controls his AI trading agents (Manrae is the first; the tab serves any
 * number). The logic is live/agent-core.js (AgentCore); this file draws it. The look starts from the Manrae training
 * viewer (Anthony 2026-10-08: "looks great and is a great foundation"): mono labels in lavender, purple lines, the
 * decision panel's quote blocks and confidence meter, the log's colored kinds.
 *
 *   const desk = AgentDesk.create({ v3, headers, feed, storage, els: { tab, view }, ... });
 *
 * The workspace (live/index.html) creates one; the agent-only window (live/agent.html, for a third monitor) creates one with
 * { popout: true }. No connection of its own: the window's one v3 connection (o.v3, live/accounts.js createFeed), its
 * messages through v3.listen, its own few through v3.post.
 *
 * Safety (contract: AI is never in the order path):
 *   - The page never builds an order for an agent. Accept sends `agentAnswer` with the proposal's id; ChartBridge places the
 *     entry from the plan's own numbers, inside the agent's rules. The mode, the kill switch, the rules, the account and the
 *     answers are the only agent messages this page sends, and ChartBridge checks every one.
 *   - Kill: on in one click, always; release and Auto ask a second click within 4 s (as the Bot tab). A LIVE account asks once
 *     in the page, never with a browser dialog. Nothing here moves: no motion on the kill switch, the mode, Accept and Reject,
 *     the position or the P&L.
 */
(function () {
'use strict';
if (typeof window === 'undefined' || typeof document === 'undefined' || !window.AgentCore || !window.BotCore) return;
const AC = window.AgentCore, BC = window.BotCore;
const VERSION = '1.0.0';

const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isNum = v => typeof v === 'number' && isFinite(v);
const put = (el, k, v) => { if (el && el[k] !== v) el[k] = v; };
const attr = (el, k, v) => { if (!el) return; const s = v === null || v === undefined ? null : String(v); if (s === null) { if (el.hasAttribute(k)) el.removeAttribute(k); } else if (el.getAttribute(k) !== s) el.setAttribute(k, s); };
const tog = (el, cls, on) => { if (el && el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on); };
const setHtml = (el, html) => { if (el && el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; } };
const TF_NAMES = { s15: '15 sec', s30: '30 sec', m1: '1 min', m5: '5 min', m15: '15 min' };
const KEYS = { chosen: 'live-agent-chosen-v1', chart: 'live-agent-chart-v1', fills: 'live-agent-fills-v1', feed: 'live-agent-feed-v1' };
const FILTERS = [['all', 'All'], ['plans', 'Plans'], ['notes', 'Notes'], ['thinking', 'Thinking'], ['lesson', 'Lessons']];

function create(o) {
  o = o || {};
  const els = o.els || {};
  const storage = o.storage || { getItem: () => null, setItem: () => {} };
  const popout = !!o.popout;
  const agents = AC.createAgents(), props = AC.createProposals(), feed = AC.createFeed();
  const readJson = k => { try { return JSON.parse(storage.getItem(k)); } catch (e) { return null; } };
  const writeJson = (k, v) => { try { storage.setItem(k, JSON.stringify(v)); } catch (e) { /* blocked */ } };

  const S = {
    v3: null, version: '', instruments: {}, trading: null, signedIn: false, accounts: null, bot: null, copier: null,
    chosen: String(readJson(KEYS.chosen) || ''), shown: popout, layout: '', cidSeq: 0,
    orders: new Map(), pending: new Map(), propEnds: [],
    keys: { accept: '', reject: '', notes: [], from: '' },
    killConfirm: 0, autoConfirm: 0, rulesEdit: false, acctEdit: false, acctAsk: '', feedFilter: 'all', openThink: new Set(),
    chart: null, chartRoot: '', chartTf: 'm1', contract: '',
  };
  { const v = readJson(KEYS.chart); if (v && TF_NAMES[v.tf]) S.chartTf = v.tf; }
  { const v = readJson(KEYS.feed); if (v && FILTERS.some(f => f[0] === v.filter)) S.feedFilter = v.filter; }

  /* ---------------- the DOM: built once, written only where it changed */
  const view = els.view, tabBtn = els.tab;
  const q = sel => (view ? view.querySelector(sel) : null);
  /* the corner proposals (wherever Anthony is) share the Bot tab's corner when it is there, so the two never overlap */
  const propBox = document.querySelector('.bt-props') || (() => { const d = document.createElement('div'); d.className = 'ag-props'; d.setAttribute('role', 'region'); d.setAttribute('aria-label', 'Agent proposals'); document.body.appendChild(d); return d; })();
  const notes = document.querySelector('.bt-notes') || (() => { const d = document.createElement('div'); d.className = 'ag-notes'; d.setAttribute('aria-live', 'polite'); document.body.appendChild(d); return d; })();
  if (view) build();

  function build() {
    view.classList.add('ag-view');
    view.innerHTML =
      '<div class="ag-off" data-k="off" hidden><div class="ag-off-card"><span class="ag-ttl">Agents</span><p data-k="offText"></p></div></div>' +
      '<div class="ag-main" data-k="main" hidden>' +
      /* the strip: who, how it is, what it holds */
      '<div class="ag-strip" data-k="strip" data-no-motion>' +
        '<span class="ag-badge" data-k="initials" aria-hidden="true"></span>' +
        '<span class="ag-name" data-k="name"></span><span class="ag-chip ag-build" data-k="build" title="The build the agent runs, as it says in its hello"></span>' +
        '<span class="ag-conn" data-k="conn"><i></i><span data-k="connText"></span></span>' +
        '<span class="ag-chip ag-mode" data-k="modeChip"></span>' +
        '<span class="ag-kv"><span class="ag-lbl">Account</span><span class="mono" data-k="sAccount"></span> <span class="bt-acct ag-mark" data-k="sMark"></span></span>' +
        '<span class="ag-kv"><span class="ag-lbl">Position</span><span class="mono" data-k="sPos"></span></span>' +
        '<span class="ag-kv"><span class="ag-lbl">Today</span><span class="mono" data-k="sPnl"></span></span>' +
        '<span class="ag-kv"><span class="ag-lbl">Trades</span><span class="mono" data-k="sTrades"></span></span>' +
        '<span class="ag-kv"><span class="ag-lbl">Losses</span><span class="mono" data-k="sLosses"></span></span>' +
        '<span class="ag-chip ag-owns" data-k="sOwns" hidden title="The owner lock: while the agent has a position or a working entry here, ChartBridge refuses every new entry from anyone else. Your Flatten, cancels and stop or target moves always work."></span>' +
        '<span class="ag-chip ag-bad" data-k="sState" hidden></span>' +
        '<span class="ag-fill"></span>' +
        '<label class="ag-pick" data-k="pickWrap" hidden><span class="ag-lbl" data-k="pickN">Agents</span><select class="ag-sel" data-k="pick" aria-label="Agent shown"></select></label>' +
        (popout ? '' : '<button type="button" class="ws-btn ag-popbtn" data-act="popout" title="Open the Agent tab in its own window (for a third monitor)">Pop out</button>') +
      '</div>' +
      '<div class="ag-grid" data-k="grid">' +
      /* left: control */
      '<aside class="ag-col ag-left" aria-label="Agent controls">' +
        '<div class="ag-sec" data-no-motion><div class="ag-sechead"><span class="ag-ttl">Mode</span><span class="ag-lbl" data-k="modeAcct"></span></div>' +
          '<div class="ag-modes" role="group" aria-label="Agent mode" data-k="modes">' + AC.MODES.map(m => '<button type="button" data-mode="' + m + '" aria-pressed="false">' + AC.MODE_NAME[m] + '</button>').join('') + '</div>' +
          '<p class="ag-why" data-k="modeWhy" hidden></p>' +
          '<button type="button" class="ag-kill" data-act="kill" data-k="kill">Kill switch</button>' +
          '<div class="ag-pgrid"><span>Status</span><span data-k="status">-</span><span>Heartbeat</span><span class="mono" data-k="beat">-</span><span>Last plan</span><span data-k="last">-</span></div>' +
        '</div>' +
        '<div class="ag-sec" data-no-motion><div class="ag-sechead"><span class="ag-ttl">Account</span><span class="ag-lbl">its own, never shared</span></div>' +
          '<div class="ag-pgrid"><span>Trades on</span><span><span class="mono" data-k="account">Sim101</span> <span class="bt-acct ag-mark" data-k="accountMark"></span></span></div>' +
          '<div class="ag-edit" data-k="acctEdit" hidden><select class="ag-sel" data-k="acctSel" aria-label="The agent\'s account"></select>' +
            '<button type="button" class="ag-btn primary" data-act="acctSave">Set</button><button type="button" class="ag-btn" data-act="acctCancel">Cancel</button></div>' +
          '<div class="ag-ask" data-k="acctAsk" role="alertdialog" aria-label="Trade a LIVE account" hidden><span data-k="acctAskText"></span>' +
            '<button type="button" class="ag-btn ag-live-go" data-act="acctYes">Continue</button><button type="button" class="ag-btn" data-act="acctNo">Cancel</button></div>' +
          '<div class="ag-row"><button type="button" class="ag-btn" data-act="acctOpen" data-k="acctOpen" title="Any account ChartBridge says is tradable, except the bot\'s, the copier\'s and another agent\'s; only while the agent is flat">Change account</button></div>' +
          '<p class="ag-why" data-k="acctWhy"></p>' +
        '</div>' +
        '<div class="ag-sec"><div class="ag-sechead"><span class="ag-ttl">Rules</span><span class="ag-lbl">ChartBridge enforces them</span></div>' +
          '<div class="ag-pgrid" data-k="rules"></div>' +
          '<div class="ag-rform" data-k="rulesEdit" hidden>' +
            '<div class="ag-rroots" data-k="rRoots"></div>' +
            '<label><span>New entries from</span><input class="ag-in" data-r="entryFrom" maxlength="5" inputmode="numeric" placeholder="09:45" aria-label="New entries from, New York time"></label>' +
            '<label><span>New entries until</span><input class="ag-in" data-r="entryUntil" maxlength="5" inputmode="numeric" placeholder="15:00" aria-label="New entries until, New York time"></label>' +
            '<label><span>Flat at</span><input class="ag-in" data-r="flatAt" maxlength="5" inputmode="numeric" placeholder="15:55" aria-label="Flat at, New York time"></label>' +
            '<label><span>Entry lives, s</span><input class="ag-in" type="number" min="60" max="1800" step="1" data-r="maxExpireSec" aria-label="An entry lives at most, seconds (60 to 1800)"></label>' +
            '<label><span>Trades a day</span><input class="ag-in" type="number" min="0" max="50" step="1" data-r="maxTrades" aria-label="Trades a day, 0 for no limit"></label>' +
            '<label><span>Losing trades</span><input class="ag-in" type="number" min="0" max="20" step="1" data-r="maxLosses" aria-label="Losing trades before it stands down, 0 for no limit"></label>' +
            '<p class="ag-help">New York time. 0 is no limit. Sizes up to ChartBridge\'s ceiling: 2 for NQ and ES, 20 for MNQ and MES.</p>' +
            '<div class="ag-row"><button type="button" class="ag-btn primary" data-act="rulesSave">Set</button><button type="button" class="ag-btn" data-act="rulesCancel">Cancel</button></div>' +
          '</div>' +
          '<div class="ag-row"><button type="button" class="ag-btn" data-act="rulesOpen" data-k="rulesOpen">Change the rules</button></div>' +
          '<p class="ag-why" data-k="rulesWhy"></p>' +
        '</div>' +
      '</aside>' +
      /* centre: the chart, a normal live chart (never animated) */
      '<section class="ag-col ag-centre" aria-label="Agent chart">' +
        '<div class="ag-charthead"><span class="ag-ttl" data-k="chartName">Chart</span>' +
          '<select class="ag-sel ag-small" data-k="chartRoot" aria-label="Root"></select>' +
          '<select class="ag-sel ag-small" data-k="tf" aria-label="Bars">' + Object.keys(TF_NAMES).map(k => '<option value="' + k + '">' + TF_NAMES[k] + '</option>').join('') + '</select>' +
          '<span class="chart-live ws-lv" data-k="ind"></span>' +
          '<span class="ag-fill"></span><span class="ag-legend" title="The agent\'s trades today: triangles in, dots out; its working entry, stop and target as lines. ChartBridge marks the agent\'s orders, so your own orders on its account do not show here.">AGENT TRADES</span></div>' +
        '<div class="ag-chart" data-k="chart" data-no-motion></div>' +
      '</section>' +
      /* right: proposals, then the feed */
      '<aside class="ag-col ag-right" aria-label="Proposals, notes and plans">' +
        '<div class="ag-sec" data-no-motion><div class="ag-sechead"><span class="ag-ttl">Proposals</span><span class="ag-lbl" data-k="propCount"></span></div>' +
          '<div class="ag-plist" data-k="plist"></div><p class="ag-empty" data-k="pempty">None open. In Copilot each plan comes here for you to accept or reject.</p></div>' +
        '<div class="ag-feedwrap"><div class="ag-loghead"><span class="ag-ttl">Notes and plans</span><span class="ag-lbl" data-k="feedCount"></span></div>' +
          '<div class="ag-filters" role="tablist" data-k="filters">' + FILTERS.map(f => '<button type="button" role="tab" data-filter="' + f[0] + '" aria-selected="false">' + f[1] + '</button>').join('') + '</div>' +
          '<div class="ag-feed" data-k="feed"></div></div>' +
      '</aside>' +
      '</div></div>';
  }

  /* ---------------- the window's v3 connection */
  const V3 = o.v3 || null;
  const sendRaw = m => !!V3 && V3.post(m);
  const cid = () => 'ag' + (++S.cidSeq).toString(36) + Math.random().toString(36).slice(2, 6);
  function lost() {
    S.signedIn = false; S.trading = null; S.orders.clear(); ledger.clear(); unclaimed.clear();
    agents.clear(); feed.clear();
    for (const p of props.clear()) dropProposal(p.agent, p.id);
    S.pending.clear();
    render();
  }
  function onMessage(m) {
    switch (m && m.type) {
      case 'hello':
        S.version = typeof m.version === 'string' ? m.version : '';
        S.instruments = {};
        for (const i of m.instruments || []) if (i && i.root) S.instruments[i.root] = i;
        S.v3 = Array.isArray(m.features) && m.features.includes('v3');
        render(); return;
      case 'trading': S.trading = m; S.signedIn = !!m.enabled; render(); return;
      case 'accounts': S.accounts = m; renderPanel(); return;
      case 'bot': S.bot = m; return;
      case 'copier': S.copier = m; return;
      case 'agent': onAgent(m); return;
      case 'agentProposal': onProposal(m); return;
      case 'agentPlan': if (feed.plan(m)) { renderFeed(); renderStrip(); } return;
      case 'agentNote': if (feed.note(m)) renderFeed(); return;
      case 'orders': S.orders.clear(); for (const x of m.list || []) noteOrder(x); reclaim(); renderChartLines(); renderPanel(); return;
      case 'order': noteOrder(m); reclaim(); renderChartLines(); renderPanel(); return;
      case 'exec': onExec(m); return;
      case 'execs': for (const x of m.list || []) onExec(x, true); renderTrips(); return;
      case 'reject': onReject(m); return;
      case 'status': onStatus(m); return;
    }
  }

  /* ---------------- the agents */
  const cur = () => agents.get(S.chosen);
  function onAgent(m) {
    const r = agents.update(m);
    if (!r) return;
    const want = AC.pickAgent(agents.ids(), S.chosen);
    if (want !== S.chosen) choose(want, true);
    if (r.prev) for (const n of AC.noticesFrom(r.prev, r.next, (p, root) => fmtPx(p, root))) notice(n);
    if (r.prev && (r.prev.account !== m.account)) renderTrips();
    render();
  }
  function choose(id, quiet) {
    if (S.chosen === id) return;
    S.chosen = id; S.rulesEdit = false; S.acctEdit = false; S.acctAsk = ''; S.killConfirm = 0; S.autoConfirm = 0;
    for (const k of ['rulesWhy', 'acctWhy']) put(q('[data-k="' + k + '"]'), 'textContent', '');
    writeJson(KEYS.chosen, id);
    placeCards();
    if (!quiet) render();
  }

  /* ---------------- the agents' own orders and fills: `by: "agent:<id>"` (AgentCore.isAgentMark); a fill is claimed against
     those orders' filled contracts (BotCore.botFillLedger with the agent's mark), kept for the trading day on this PC */
  const ledgers = new Map();
  const ledgerOf = id => { if (!ledgers.has(id)) ledgers.set(id, BC.botFillLedger(AC.isAgentMark)); return ledgers.get(id); };
  const ledger = { clear: () => ledgers.clear() };
  const unclaimed = new Map();
  function noteOrder(x) {
    if (!x || typeof x.id !== 'string') return;
    const id = AC.agentOfOrder(x), a = id ? agents.get(id) : null;
    if (a) ledgerOf(id).order(x, a);
    if (id && (x.state === 'working' || x.state === 'partFilled')) S.orders.set(x.id, x); else S.orders.delete(x.id);
  }
  function reclaim() { let any = false; for (const f of [...unclaimed.values()]) if (claim(f)) { unclaimed.delete(f.id); keepFill(f); any = true; } if (any) renderTrips(); }
  function claim(f) { for (const a of agents.list()) if (ledgerOf(a.agent).claim(f)) { f.agent = a.agent; return true; } return false; }
  function onExec(f, quiet) {
    if (!f || typeof f.id !== 'string') return;
    if (!claim(f)) { unclaimed.set(f.id, f); if (unclaimed.size > 500) unclaimed.delete(unclaimed.keys().next().value); return; }
    keepFill(f);
    if (!quiet) renderTrips();
  }
  function fillsDay() { const v = readJson(KEYS.fills), day = BC.tradeDay(Date.now()); return v && v.day === day && Array.isArray(v.list) ? v : { day, list: [] }; }
  function keepFill(f) {
    const v = fillsDay();
    if (v.list.some(x => x.id === f.id)) return;
    v.list.push({ id: f.id, agent: f.agent, side: f.side, qty: f.qty, p: f.p, t: f.t, root: f.root, account: f.account });
    if (v.list.length > 400) v.list.splice(0, v.list.length - 400);
    writeJson(KEYS.fills, v);
  }
  function trips() { const a = cur(); if (!a) return []; return BC.trips(fillsDay().list.filter(x => x.agent === a.agent && x.root === S.chartRoot).sort((x, y) => x.t - y.t)); }

  /* ---------------- proposals: in the tab for the agent shown, in the corner everywhere else */
  const cards = new Map();                     // agent|id -> { inline, corner, p, shownAt, ended }
  const keyOf = (a, id) => a + '|' + id;
  function onProposal(p) {
    const r = props.update(p);
    if (r.act === 'show') { showProposal(r.p); renderChartLines(); }
    else if (r.act === 'update') { const x = cards.get(keyOf(p.agent, p.id)); if (x) x.p = p; else showProposal(p); }
    else if (r.act === 'end') endProposal(r.p, r.why);
    renderPanel(); renderFeed();
  }
  const sideWord = s => (s === 'buy' ? 'Buy' : s === 'sell' ? 'Sell' : '');
  const tickOf = r => { const i = S.instruments[r]; return i && +i.tick > 0 ? +i.tick : 0.25; };
  const decOf = r => { const s = String(tickOf(r)), i = s.indexOf('.'); return i < 0 ? 0 : Math.min(6, s.length - i - 1); };
  const fmtPx = (p, r) => (isNum(p) ? p.toFixed(decOf(r || 'MNQ')).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '-');
  const markHtml = m => (m ? '<span class="bt-acct ag-mark ' + (m === 'LIVE' ? 'live' : 'sim') + '" data-no-motion>' + esc(m) + '</span>' : '');
  const confHtml = c => (isNum(c) ? '<span class="ag-cm"><span class="ag-meter"><b style="width:' + Math.max(0, Math.min(100, c * 100)).toFixed(0) + '%"></b></span><span class="mono">' + c.toFixed(2) + '</span></span>' : '-');
  function entryText(p) {
    const r = p.root;
    return p.kind === 'stopLimit' ? 'stop-limit ' + fmtPx(p.price, r) + ', limit ' + fmtPx(p.limitPrice, r) : 'limit ' + fmtPx(p.price, r);
  }
  function propHtml(p) {
    const a = agents.get(p.agent) || { agent: p.agent }, r = p.root, lp = AC.legPrices(p, tickOf(r));
    const acc = { name: p.account || AC.agentAccount(a).name, mark: AC.accountMark(p.sim) };   // no sim: LIVE, as an unknown account anywhere
    const kc = k => (k ? ' <span class="bt-keycap">' + esc(k) + '</span>' : '');
    return '<div class="ag-prop-h"><span class="ag-ttl" title="Copilot proposal from ' + esc(AC.agentName(a)) + '">' + esc(AC.agentName(a)) + '</span><span class="ag-lbl ag-id">' + esc(p.agent) + '</span>' + markHtml(acc.mark) + '<span class="ag-fill"></span><span class="ag-lbl" title="Open until the plan\'s own expiry">ends in</span> <span class="mono ag-cd" data-k="cd">-</span></div>' +
      '<div class="ag-prop-big mono"><span class="' + (p.side === 'buy' ? 'pos' : 'neg') + '">' + sideWord(p.side) + ' ' + esc(p.qty) + ' ' + esc(r) + '</span> <span class="ag-soft">' + esc(entryText(p)) + '</span></div>' +
      '<div class="ag-prop-setup"><span class="ag-chip">' + esc(p.setup || 'no setup name') + '</span><span class="ag-lbl">confidence</span>' + confHtml(p.confidence) + '</div>' +
      '<div class="ag-quote">' + esc(p.reason || '') + '</div>' +
      '<div class="ag-pgrid mono">' +
        '<span>Stop</span><span>' + esc(p.stopTicks) + ' ticks' + (lp.stop !== null ? ' (' + fmtPx(lp.stop, r) + ')' : '') + '</span>' +
        '<span>Target</span><span>' + esc(p.targetTicks) + ' ticks' + (lp.target !== null ? ' (' + fmtPx(lp.target, r) + ')' : '') + '</span>' +
        '<span>Risk</span><span>' + esc(AC.fmtUsd(p.riskDollars).replace(/^\+/, '') || '-') + (isNum(p.stopTicks) && isNum(p.targetTicks) && p.stopTicks ? ', reward ' + (p.targetTicks / p.stopTicks).toFixed(2) + ' to 1' : '') + '</span>' +
        '<span>Open until</span><span>' + (isNum(p.expiresAt) ? esc(AC.etClockSec(p.expiresAt)) + ' ET' : '-') + '</span></div>' +
      '<div class="ag-prop-note"><b class="mono">' + esc(acc.name) + '</b> ' + markHtml(acc.mark) + ' ChartBridge places it on this account from these numbers if you accept, inside ' + esc(AC.agentName(a)) + '\'s rules. Unanswered, it is never sent.</div>' +
      '<div class="ag-prop-btns"><button type="button" class="ag-acc" data-agans="accept">Accept' + kc(S.keys.accept) + '</button><button type="button" class="ag-rej" data-agans="reject">Reject' + kc(S.keys.reject) + '</button></div>' +
      '<div class="ag-prop-msg" data-k="msg" role="status"></div>';
  }
  function makeCard(p, where) {
    const el = document.createElement('div');
    el.className = 'ag-prop ' + where;
    el.dataset.agent = p.agent; el.dataset.id = p.id;
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('data-no-motion', '');
    el.setAttribute('aria-label', 'Copilot proposal from ' + AC.agentName(agents.get(p.agent) || { agent: p.agent }) + ': ' + sideWord(p.side) + ' ' + p.qty + ' ' + p.root);
    el.innerHTML = propHtml(p);
    return el;
  }
  function showProposal(p) {
    const k = keyOf(p.agent, p.id);
    if (cards.has(k)) return;
    const x = { inline: makeCard(p, 'inline'), corner: makeCard(p, 'corner'), p, shownAt: Date.now(), ended: false };
    cards.set(k, x);
    propBox.prepend(x.corner);
    placeCards();
    seenNow();
    tick();
  }
  /* each card in its place: the agent shown in the tab has its proposals in the tab (no corner card); every other one is in the corner */
  function placeCards() {
    const list = q('[data-k="plist"]'), inTab = S.shown && !!view;
    const mine = [...cards.values()].filter(x => x.p.agent === S.chosen).sort((a, b) => a.shownAt - b.shownAt);
    if (list) list.replaceChildren(...mine.map(x => x.inline));
    for (const x of cards.values()) put(x.corner, 'hidden', inTab && x.p.agent === S.chosen);
    put(q('[data-k="pempty"]'), 'hidden', mine.length > 0);
    put(q('[data-k="propCount"]'), 'textContent', mine.filter(x => !x.ended).length ? mine.filter(x => !x.ended).length + ' open' : '');
  }
  /* agentSeen the moment it shows, in a window Anthony can see (as the Bot tab's botSeen) */
  function seenNow() {
    if (document.visibilityState === 'hidden') return;
    const at = Date.now();
    for (const x of cards.values()) {
      if (x.ended) continue;
      const seen = props.shown(x.p.agent, x.p.id, at);
      if (seen) { x.shownAt = at; sendRaw(seen); }
    }
  }
  document.addEventListener('visibilitychange', seenNow);
  const both = (x, fn) => { fn(x.inline); fn(x.corner); };
  function setMsg(x, t) { both(x, el => put(el.querySelector('[data-k="msg"]'), 'textContent', t)); }
  function endProposal(p, why) {
    const x = cards.get(keyOf(p.agent, p.id)), a = agents.get(p.agent);
    const react = isNum(p.seenAt) && isNum(p.answeredAt) ? ' in ' + ((p.answeredAt - p.seenAt) / 1000).toFixed(1) + ' s' : '';
    S.propEnds.push({ agent: p.agent, id: p.id, at: Date.now(), state: why, react, side: p.side, qty: p.qty, root: p.root });
    if (S.propEnds.length > 100) S.propEnds.shift();
    const text = AC.endText(why, AC.agentName(a), p.account);
    notice({ kind: 'proposal', level: why === 'accepted' || why === 'rejected' ? '' : 'amber', text: AC.agentName(a) + ': ' + text });
    renderFeed();
    if (!x) return;
    x.ended = true;
    both(x, el => { el.classList.add('ag-ended'); for (const b of el.querySelectorAll('button')) b.disabled = true; });
    setMsg(x, text);
    setTimeout(() => dropProposal(p.agent, p.id), why === 'accepted' || why === 'rejected' ? 1500 : 3000);
  }
  function dropProposal(agent, id) { const k = keyOf(agent, id), x = cards.get(k); if (x) { x.inline.remove(); x.corner.remove(); cards.delete(k); placeCards(); } }
  function onCardClick(e) {
    const b = e.target.closest('button[data-agans]'); if (!b) return;
    const card = b.closest('.ag-prop');
    if (card) answer(card.dataset.agent, card.dataset.id, b.dataset.agans);
  }
  propBox.addEventListener('click', onCardClick);
  if (view) view.addEventListener('click', onCardClick);
  function answer(agent, id, ans) {
    const x = cards.get(keyOf(agent, id));
    if (!x || x.ended) return false;
    const c = cid(), r = props.answer(agent, id, ans, Date.now(), c);
    if (r.error) { setMsg(x, r.error); return false; }
    if (!sendRaw(r.msg)) { props.refused(agent, id); setMsg(x, 'Not sent: not connected to ChartBridge.'); return false; }
    S.pending.set(c, { kind: 'answer', agent, id });
    both(x, el => { for (const btn of el.querySelectorAll('button')) btn.disabled = true; });
    setMsg(x, (ans === 'accept' ? 'Accept' : 'Reject') + ' sent. Waiting for ChartBridge.');
    return true;
  }
  /* the countdowns, twice a second while a proposal is shown; Accept closes 5 s before expiresAt */
  let timer = 0;
  function tick() {
    clearTimeout(timer); timer = 0;
    if (!cards.size && !(S.killConfirm > Date.now()) && !(S.autoConfirm > Date.now())) return;
    const now = Date.now();
    for (const x of cards.values()) {
      if (x.ended) continue;
      const cd = AC.countdown(x.p.expiresAt, now), answered = props.answered(x.p.agent, x.p.id);
      both(x, el => {
        const t = el.querySelector('[data-k="cd"]');
        put(t, 'textContent', cd.text); tog(t, 'late', cd.ms !== null && cd.ms < 60000);
        const acc = el.querySelector('[data-agans="accept"]');
        if (!answered) put(acc, 'disabled', cd.late);
      });
      if (cd.late && !answered) setMsg(x, cd.over ? 'Expired: waiting for ChartBridge to close it.' : 'Under 5 s left: too late to accept. Reject still goes.');
    }
    timer = setTimeout(tick, 500);
  }
  /* one handler for the copilot key across the Bot tab and every agent (AgentCore.copilotRouter): the oldest open proposal */
  const ROUTER = AC.copilotRouter(document);
  /* the router's view of this tab: every proposal not ended (an answered one waiting for ChartBridge stays the key's target),
     and the agent shown while the tab is open (the keys then answer its proposals only) */
  const unroute = ROUTER.add('agents', { kind: 'agents',
    open: () => [...cards.values()].filter(x => !x.ended).map(x => ({ id: x.p.agent + ':' + x.p.id, agent: x.p.agent, shownAt: x.shownAt, answered: !!props.answered(x.p.agent, x.p.id),
      expiresAt: x.p.expiresAt, answer: ans => answer(x.p.agent, x.p.id, ans) })),
    focus: () => (S.shown && !popout && cur() ? S.chosen : '') });
  function loadKeys() {
    if (typeof o.copilotKeys !== 'function') { S.keys = { accept: '', reject: '', notes: [], from: 'window' }; return; }
    const doc = o.copilotKeys();
    if (!doc) { S.keys = { accept: '', reject: '', notes: [], from: 'none' }; return; }
    S.keys = Object.assign(BC.answerKeys(doc, typeof o.tradingKeys === 'function' ? o.tradingKeys() : {}, window.OrderTicket ? window.OrderTicket.hotkeyRefused : null), { from: 'desk' });
  }

  /* ---------------- refusals and ChartBridge's words */
  function onReject(m) {
    const x = m && m.cid ? S.pending.get(m.cid) : null;
    if (!x) return;
    S.pending.delete(m.cid);
    const why = 'Refused by ChartBridge: ' + (m.reason || '');
    if (x.kind === 'answer') {
      props.refused(x.agent, x.id);
      const c = cards.get(keyOf(x.agent, x.id));
      if (c && !c.ended) { both(c, el => { for (const b of el.querySelectorAll('button')) b.disabled = false; }); setMsg(c, why); }
    } else if (x.kind === 'rules') rulesWhy(why, 'refused');
    else if (x.kind === 'account') put(q('[data-k="acctWhy"]'), 'textContent', why);
    else if (x.kind === 'mode' || x.kind === 'kill') modeWhy(why);
    else notice({ kind: 'refused', level: 'amber', text: why });
  }
  function onStatus(m) {
    if (!m || typeof m.text !== 'string' || (m.level !== 'info' && document.getElementById('wsAlert'))) return;   // warn and error: the workspace's own line shows them
    const id = agents.ids().find(i => new RegExp('^(Agent )?' + i + '\\b').test(m.text));
    if (id) notice({ kind: 'status', level: m.level === 'error' ? 'red' : m.level === 'warn' ? 'amber' : '', text: m.text });
  }
  function notice(n) {
    if (!agents.size()) return;
    const d = document.createElement('div');
    d.className = 'ag-note' + (n.level ? ' ' + n.level : '');
    d.setAttribute('role', n.level === 'red' ? 'alert' : 'status');
    d.innerHTML = '<span class="ag-ttl">' + esc({ entry: 'Entry', exit: 'Exit', standDown: 'Stand-down', heartbeat: 'Heartbeat', kill: 'Kill switch', proposal: 'Copilot', status: 'ChartBridge', refused: 'Refused', account: 'Account', mode: 'Mode' }[n.kind] || 'Agent') + '</span><span>' + esc(n.text) + '</span>';
    d.addEventListener('click', () => d.remove());
    notes.prepend(d);
    while (notes.children.length > 4) notes.lastChild.remove();
    setTimeout(() => d.remove(), n.level === 'red' ? 12000 : 6000);
  }

  /* ---------------- drawing */
  function render() {
    const a = cur(), off = !a;
    if (tabBtn) {
      put(tabBtn, 'hidden', S.v3 !== true && !S.shown);           // a ChartBridge that speaks v3 has an Agent tab (it says what it lacks)
      tog(document.body, 'ag-has-tab', !tabBtn.hidden);
      attr(tabBtn, 'aria-pressed', String(S.shown));
      const bad = agents.list().some(x => x.killed || x.standDown || (x.enabled !== false && !x.connected && x.name));
      tog(tabBtn, 'ag-alert', bad);
      tog(tabBtn, 'ag-waiting', !S.shown && [...cards.values()].some(x => !x.ended));
      attr(tabBtn, 'title', off ? 'Agents: ' + AC.offText(offCtx()) : 'Agent tab: ' + agents.size() + (agents.size() === 1 ? ' agent' : ' agents'));
    }
    if (view) {
      put(q('[data-k="off"]'), 'hidden', !off); put(q('[data-k="main"]'), 'hidden', off);
      put(q('[data-k="offText"]'), 'textContent', AC.offText(offCtx()));
      if (off) unmountChart(); else if (S.shown) mountChart();
    }
    placeCards();
    renderStrip(); renderPanel(); renderFeed(); renderChartLines();
  }
  const offCtx = () => ({ v3: S.v3, version: S.version, trading: S.trading, agents: agents.size() });
  function renderStrip() {
    if (!view) return;
    const a = cur(); if (!a) return;
    const list = agents.list(), pick = q('[data-k="pick"]');
    put(q('[data-k="pickWrap"]'), 'hidden', list.length < 2);
    put(q('[data-k="pickN"]'), 'textContent', list.length + ' agents');
    const opts = list.map(x => '<option value="' + esc(x.agent) + '">' + esc(AC.agentName(x)) + (AC.agentName(x) !== x.agent ? ' (' + esc(x.agent) + ')' : '') + '</option>').join('');
    if (pick.dataset.html !== opts) { pick.dataset.html = opts; pick.innerHTML = opts; }
    put(pick, 'value', S.chosen);
    const m = AC.stripModel(a, S.orders.values(), (p, r) => fmtPx(p, r));
    put(q('[data-k="initials"]'), 'textContent', m.name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'AG');
    put(q('[data-k="name"]'), 'textContent', m.name);
    const b = q('[data-k="build"]'); put(b, 'textContent', m.build); put(b, 'hidden', !m.build);
    const conn = q('[data-k="conn"]');
    put(conn, 'className', 'ag-conn ' + (m.state === 'on' ? 'ok' : m.state === 'off' ? 'off' : 'bad'));
    put(q('[data-k="connText"]'), 'textContent', m.connected ? 'CONNECTED · ' + m.beat : a.name ? 'NOT CONNECTED' : 'NO AGENT PROGRAM YET');
    const mc = q('[data-k="modeChip"]'); put(mc, 'textContent', m.mode.toUpperCase()); put(mc, 'className', 'ag-chip ag-mode m-' + (a.mode || ''));
    put(q('[data-k="sAccount"]'), 'textContent', m.account);
    for (const k of ['sMark', 'accountMark']) { const el = q('[data-k="' + k + '"]'); put(el, 'textContent', m.accountMark); put(el, 'className', 'bt-acct ag-mark' + (m.accountMark === 'LIVE' ? ' live' : m.accountMark ? ' sim' : '')); put(el, 'hidden', !m.accountMark); }
    put(q('[data-k="sPos"]'), 'textContent', m.position);
    const pnl = q('[data-k="sPnl"]'); put(pnl, 'textContent', m.pnl); put(pnl, 'className', 'mono ' + m.pnlTone);
    put(q('[data-k="sTrades"]'), 'textContent', m.trades);
    put(q('[data-k="sLosses"]'), 'textContent', m.losses);
    const ow = q('[data-k="sOwns"]'); put(ow, 'hidden', !m.owns); put(ow, 'textContent', m.owns.toUpperCase());
    const st = q('[data-k="sState"]');
    const stText = m.killed ? 'KILLED' : m.standDown ? 'STOOD DOWN: ' + m.standDown : '';
    put(st, 'hidden', !stText); put(st, 'textContent', stText); attr(st, 'title', stText || null);
    put(q('[data-k="last"]'), 'textContent', m.last);
  }
  function renderPanel() {
    if (!view) return;
    const a = cur(); if (!a) return;
    const acc = AC.agentAccount(a), tradable = AC.accountTradable(S.accounts, S.trading, acc.name), allowed = AC.modesAllowed({ tradable, account: acc.name });
    const now = Date.now();
    for (const btn of q('[data-k="modes"]').children) {
      const m = btn.dataset.mode, x = allowed[m];
      attr(btn, 'aria-pressed', String(a.mode === m));
      put(btn, 'disabled', !x.ok || !S.signedIn);
      attr(btn, 'title', x.ok ? (m === 'auto' ? 'ChartBridge places ' + AC.agentName(a) + '\'s plans on ' + acc.name + (acc.mark ? ' (' + acc.mark + ')' : '') + ' by itself, inside its rules' : m === 'copilot' ? 'Each plan is a proposal for ' + acc.name + ': you accept or reject it' : 'Plans are shown and logged; nothing is placed') : x.why);
      put(btn, 'textContent', m === 'auto' && S.autoConfirm > now ? 'Confirm' : AC.MODE_NAME[m]);
    }
    const ma = q('[data-k="modeAcct"]'); put(ma, 'textContent', acc.name + (acc.mark ? ' · ' + acc.mark : ''));
    const why = q('[data-k="modeWhy"]');
    if (!why.dataset.refused) { put(why, 'hidden', !(S.autoConfirm > now)); put(why, 'textContent', S.autoConfirm > now ? 'Click Confirm within 4 s: Auto lets ChartBridge place ' + AC.agentName(a) + '\'s plans on ' + acc.name + (acc.mark === 'LIVE' ? ', a LIVE account.' : '.') : ''); tog(why, 'live', acc.mark === 'LIVE'); }
    const kill = q('[data-k="kill"]');
    put(kill, 'textContent', a.killed ? (S.killConfirm > now ? 'Release: click again' : 'Kill switch on · Release') : 'Kill switch');
    tog(kill, 'on', !!a.killed); put(kill, 'disabled', !S.signedIn); attr(kill, 'aria-pressed', String(!!a.killed));
    put(q('[data-k="status"]'), 'textContent', AC.statusText(a));
    const beat = q('[data-k="beat"]'); put(beat, 'textContent', AC.beatText(a)); put(beat, 'className', 'mono ' + (!a.connected ? 'neg' : a.lastBeatMs > 2500 ? 'warn' : 'pos'));
    put(q('[data-k="account"]'), 'textContent', acc.name);
    const work = AC.workingEntries(S.orders.values(), a).length > 0, open = props.open(a.agent).length;
    const can = AC.rulesChangeable(a, { workingEntry: work, openProposals: open });
    put(q('[data-k="acctOpen"]'), 'disabled', !S.signedIn || !can.ok);
    attr(q('[data-k="acctOpen"]'), 'title', can.ok ? 'Any account ChartBridge says is tradable, except the bot\'s, the copier\'s and another agent\'s; only while the agent is flat' : can.why.replace('change its rules', 'choose its account'));
    put(q('[data-k="acctEdit"]'), 'hidden', !S.acctEdit || !!S.acctAsk);
    put(q('[data-k="acctAsk"]'), 'hidden', !S.acctAsk);
    if (S.acctAsk) put(q('[data-k="acctAskText"]'), 'textContent', AC.liveQuestion(a, S.acctAsk));
    setHtml(q('[data-k="rules"]'), AC.rulesLines(a.rules).map(([k, v]) => '<span>' + esc(k) + '</span><span class="mono">' + esc(v) + '</span>').join('') || '<span>Rules</span><span>not known yet</span>');
    const ro = q('[data-k="rulesOpen"]');
    put(ro, 'disabled', !S.signedIn || !can.ok);
    attr(ro, 'title', can.ok ? 'Only while the agent is flat with no working entry and no open proposal' : can.why);
    put(q('[data-k="rulesEdit"]'), 'hidden', !S.rulesEdit);
    /* why the rules cannot change now, under the button (written here: data-auto), unless ChartBridge's own words are there */
    const rw = q('[data-k="rulesWhy"]');
    if (!can.ok) {
      if (S.rulesEdit) S.rulesEdit = false, put(q('[data-k="rulesEdit"]'), 'hidden', true);
      if (rw.dataset.kind !== 'refused') { put(rw, 'textContent', can.why); rw.dataset.kind = 'auto'; }
    } else if (rw.dataset.kind === 'auto') { put(rw, 'textContent', ''); rw.dataset.kind = ''; }
    put(ro, 'hidden', S.rulesEdit);                             // the form has its own Set and Cancel
  }
  const servedRoots = () => AC.RULE_ROOTS.filter(r => S.instruments[r] && !S.instruments[r].quoteOnly);

  /* ---------------- the feed (the training viewer's log and decision panel, newest first) */
  function noteHtml(m, key) {
    const t = '<span class="ag-t mono">' + esc(AC.etClockSec(m.at)) + '</span>';
    const k = '<span class="ag-k k-' + esc(m.kind) + '">' + esc((AC.NOTE_NAME[m.kind] || m.kind).toUpperCase()) + '</span>';
    if (m.kind === 'thinking') {
      const open = S.openThink.has(key);
      return '<details class="ag-item ag-think" data-key="' + esc(key) + '"' + (open ? ' open' : '') + '><summary>' + t + k + '<span class="ag-tx">' + esc(m.text.slice(0, 140)) + (m.text.length > 140 ? '...' : '') + '</span></summary>' +
        '<div class="ag-prose ag-quote">' + esc(m.text) + '</div></details>';
    }
    if (m.kind === 'notebook') return '<div class="ag-item">' + t + k + '<div class="ag-nb mono">' + esc(m.text) + '</div></div>';
    return '<div class="ag-item' + (m.kind === 'status' ? ' sys' : '') + '">' + t + k + '<span class="ag-tx ag-prose">' + esc(m.text) + '</span></div>';
  }
  function planHtml(m) {
    const line = AC.planLine(m), skip = m.action === 'skip';
    const t = '<span class="ag-t mono">' + esc(isNum(m.at) ? AC.etClockSec(m.at) : '') + '</span>';
    const k = '<span class="ag-k ' + (skip ? 'k-skip' : 'k-plan') + '">' + (skip ? 'SKIP' : 'PLAN') + '</span>';
    /* a proposal's outcome on its plan: waiting while open here, how it ended when this window saw it, else "proposed" */
    let res = line.result.split(':')[0], tone = line.tone;
    if (m.result === 'proposed') {
      const open = cards.get(keyOf(m.agent, m.id)), end = S.propEnds.find(e => e.agent === m.agent && e.id === m.id);
      res = end ? end.state + end.react : open && !open.ended ? 'waiting for you' : 'proposed';
      if (end && end.state !== 'accepted') tone = 'shadow';
    }
    const chip = '<span class="ag-chip ag-res ' + tone + '">' + esc(res.toUpperCase()) + '</span>';
    if (skip) return '<div class="ag-item">' + t + k + '<span class="ag-tx"><b>' + esc(line.title) + '</b> ' + chip + '<span class="ag-prose ag-sub">' + esc(m.reason || '') + '</span></span></div>';
    const r = m.root, lp = AC.legPrices(m, tickOf(r));
    return '<div class="ag-item ag-plan">' + t + k + '<span class="ag-tx"><b class="' + (m.side === 'buy' ? 'pos' : m.side === 'sell' ? 'neg' : '') + '">' + esc(line.title) + '</b> ' + chip +
      (/^refused: /.test(line.result) ? '<span class="ag-sub warn">' + esc(line.result) + '</span>' : '') + '</span>' +
      '<span class="ag-detail"><span class="ag-pgrid mono">' +
        '<span>Entry</span><span>' + esc(entryText(m)) + '</span>' +
        '<span>Stop</span><span>' + esc(m.stopTicks) + ' ticks' + (lp.stop !== null ? ' (' + fmtPx(lp.stop, r) + ')' : '') + '</span>' +
        '<span>Target</span><span>' + esc(m.targetTicks) + ' ticks' + (lp.target !== null ? ' (' + fmtPx(lp.target, r) + ')' : '') + '</span>' +
        '<span>Risk</span><span>' + esc(AC.fmtUsd(m.riskDollars).replace(/^\+/, '') || '-') + ', lives ' + esc(AC.durationText(m.expireSec)) + '</span>' +
        '<span>Confidence</span><span>' + confHtml(m.confidence) + '</span></span>' +
      '<span class="ag-quote ag-prose">' + esc(m.reason || '') + '</span></span></div>';
  }
  function renderFeed() {
    if (!view) return;
    const a = cur(); if (!a) return;
    for (const b of q('[data-k="filters"]').children) attr(b, 'aria-selected', String(b.dataset.filter === S.feedFilter));
    const f = S.feedFilter;
    const items = feed.items(a.agent, f === 'all' ? 'all' : f).map(x => ({ at: x.at, html: x.type === 'note' ? noteHtml(x.m, x.m.at + ':' + x.m.kind) : planHtml(x.m) }));
    items.sort((x, y) => y.at - x.at);
    const c = feed.counts(a.agent);
    put(q('[data-k="feedCount"]'), 'textContent', c.notes + (c.notes === 1 ? ' note' : ' notes') + ' · ' + c.plans + (c.plans === 1 ? ' plan' : ' plans'));
    const box = q('[data-k="feed"]');
    setHtml(box, items.length ? items.map(x => x.html).join('') : '<p class="ag-empty">' + (a.connected ? 'Nothing yet. Its looks, thinking, plans and lessons show here as they come.' : 'Nothing yet today. ' + AC.agentName(a) + ' is not connected.') + '</p>');
  }
  /* the words under Change the rules: kind 'refused' (ChartBridge's own, kept until the next try), 'auto' (why it cannot change
     now, written by renderPanel), or '' (this page's: an error before sending, or "Sent.") */
  function rulesWhy(t, kind) { const w = q('[data-k="rulesWhy"]'); if (!w) return; w.dataset.kind = kind || ''; put(w, 'textContent', t); }
  function modeWhy(t) { const w = q('[data-k="modeWhy"]'); if (!w) return; w.dataset.refused = '1'; put(w, 'hidden', false); put(w, 'textContent', t); setTimeout(() => { delete w.dataset.refused; renderPanel(); }, 6000); }

  /* ---------------- actions */
  function sendAgent(m, kind) {
    if (!m) return false;
    const c = cid();
    m = Object.assign({ type: m.type, cid: c }, m);            // the contract's order: type, cid, then the message's own keys
    if (!S.signedIn || !sendRaw(m)) { notice({ kind: 'refused', level: 'amber', text: 'Not sent: not signed in to ChartBridge.' }); return false; }
    S.pending.set(c, { kind });
    setTimeout(() => S.pending.delete(c), 15000);
    return true;
  }
  function others() { return { bot: S.bot, copier: S.copier, agents: agents.list() }; }
  function ctxNow(a) { return { workingEntry: AC.workingEntries(S.orders.values(), a).length > 0, openProposals: props.open(a.agent).length, roots: servedRoots() }; }
  function sendAccount(name) {
    const a = cur(); if (!a) return;
    const r = AC.accountChange(a, name, AC.accountChoices(S.accounts, a, others()), ctxNow(a));
    if (r.error) { put(q('[data-k="acctWhy"]'), 'textContent', r.error); return; }
    if (sendAgent(r.msg, 'account')) { S.acctEdit = false; S.acctAsk = ''; put(q('[data-k="acctWhy"]'), 'textContent', 'Sent. ChartBridge keeps it (agent-' + a.agent + '-account.txt) until you change it again, and puts ' + AC.agentName(a) + ' in Shadow: choose its mode again when you are ready.'); }
    renderPanel();
  }
  function openRules() {
    const a = cur(); if (!a) return;
    const f = AC.rulesForm(a.rules), served = servedRoots();
    q('[data-k="rRoots"]').innerHTML = AC.RULE_ROOTS.map(r => {
      const on = served.includes(r);
      return '<label class="ag-rroot' + (on ? '' : ' off') + '" title="' + (on ? r + ': at most ' + AC.CEILING[r] + ' (ChartBridge\'s ceiling)' : r + ' is not traded on this ChartBridge') + '"><input type="checkbox" data-root="' + r + '"' + (f.roots.includes(r) ? ' checked' : '') + (on ? '' : ' disabled') + '>' +
        '<span class="mono">' + r + '</span><input class="ag-in ag-qty" type="number" min="1" max="' + AC.CEILING[r] + '" step="1" data-qty="' + r + '" value="' + esc(f.maxQty[r]) + '"' + (on ? '' : ' disabled') + ' aria-label="' + r + ' size at most (1 to ' + AC.CEILING[r] + ')"><span class="ag-lbl">max ' + AC.CEILING[r] + '</span></label>';
    }).join('');
    for (const k of ['entryFrom', 'entryUntil', 'flatAt', 'maxExpireSec', 'maxTrades', 'maxLosses']) q('[data-r="' + k + '"]').value = f[k];
    S.rulesEdit = true; rulesWhy('');
    renderPanel();
    const first = q('[data-k="rRoots"] input'); if (first) first.focus();
  }
  function saveRules() {
    const a = cur(); if (!a) return;
    const form = { roots: [...q('[data-k="rRoots"]').querySelectorAll('input[data-root]')].filter(x => x.checked).map(x => x.dataset.root), maxQty: {} };
    for (const x of q('[data-k="rRoots"]').querySelectorAll('input[data-qty]')) form.maxQty[x.dataset.qty] = x.value;
    for (const k of ['entryFrom', 'entryUntil', 'flatAt', 'maxExpireSec', 'maxTrades', 'maxLosses']) form[k] = q('[data-r="' + k + '"]').value;
    const r = AC.rulesChange(a, form, ctxNow(a));
    if (r.error) { rulesWhy(r.error); return; }
    if (sendAgent(r.msg, 'rules')) { S.rulesEdit = false; rulesWhy('Sent. ChartBridge keeps them (agent-' + a.agent + '-rules.txt) and tells ' + AC.agentName(a) + '.'); }
    renderPanel();
  }
  function onViewClick(e) {
    const t = e.target, a = cur();
    const mode = t.closest('[data-mode]'), act = t.closest('[data-act]'), flt = t.closest('[data-filter]');
    if (flt) { S.feedFilter = flt.dataset.filter; writeJson(KEYS.feed, { filter: S.feedFilter }); renderFeed(); return; }
    if (!a) return;
    if (mode && !mode.disabled) {
      const m = mode.dataset.mode;
      if (a.mode === m) return;
      if (m === 'auto') {
        // a second click within 4 s confirms; one under 400 ms after the first is the same double-click and is ignored
        const step = BC.confirmStep(S.autoConfirm ? { at: S.autoAt, until: S.autoConfirm } : null, Date.now());
        if (step === 'ignore') return;
        if (step === 'arm') { S.autoConfirm = Date.now() + AC.CONFIRM_MS; S.autoAt = Date.now(); renderPanel(); tick(); setTimeout(renderPanel, AC.CONFIRM_MS + 100); return; }
      }
      S.autoConfirm = 0;
      sendAgent(AC.modeMsg(a.agent, m), 'mode');
      renderPanel();
      return;
    }
    if (!act) return;
    const k = act.dataset.act;
    if (k === 'kill') {
      // instant on, always; release with a second click within 4 s (it lets the agent trade again)
      if (!a.killed) { sendAgent(AC.killMsg(a.agent, true), 'kill'); return; }
      const step = BC.confirmStep(S.killConfirm ? { at: S.killAt, until: S.killConfirm } : null, Date.now());
      if (step === 'ignore') return;
      if (step === 'arm') { S.killConfirm = Date.now() + AC.CONFIRM_MS; S.killAt = Date.now(); renderPanel(); setTimeout(renderPanel, AC.CONFIRM_MS + 100); return; }
      S.killConfirm = 0;
      sendAgent(AC.killMsg(a.agent, false), 'kill');
      renderPanel();
    } else if (k === 'acctOpen') {
      S.acctEdit = true; S.acctAsk = ''; put(q('[data-k="acctWhy"]'), 'textContent', '');
      const sel = q('[data-k="acctSel"]'), list = AC.accountChoices(S.accounts, a, others());
      sel.replaceChildren(...list.map(c => { const op = new Option(c.name + ' (' + c.mark + ')' + (c.current ? ', now' : c.why ? ', ' + c.why : c.tradable ? '' : ', not tradable'), c.name); op.disabled = !c.ok && !c.current; return op; }));
      sel.value = AC.agentAccount(a).name;
      if (!list.some(c => c.ok)) put(q('[data-k="acctWhy"]'), 'textContent', 'No other account is free and tradable in ChartBridge now: check one on the Accounts tab (never the bot\'s, the copier\'s or another agent\'s).');
      renderPanel(); sel.focus();
    } else if (k === 'acctCancel' || k === 'acctNo') { S.acctEdit = false; S.acctAsk = ''; put(q('[data-k="acctWhy"]'), 'textContent', ''); renderPanel(); }
    else if (k === 'acctSave') {
      const name = q('[data-k="acctSel"]').value;
      const r = AC.accountChange(a, name, AC.accountChoices(S.accounts, a, others()), ctxNow(a));
      if (r.error) { put(q('[data-k="acctWhy"]'), 'textContent', r.error); return; }
      if (r.live) { S.acctAsk = name; renderPanel(); const y = q('[data-act="acctYes"]'); if (y) y.focus(); return; }   // asked once, in the page
      sendAccount(name);
    } else if (k === 'acctYes') { if (S.acctAsk) sendAccount(S.acctAsk); }
    else if (k === 'rulesOpen') openRules();
    else if (k === 'rulesCancel') { S.rulesEdit = false; rulesWhy(''); renderPanel(); }
    else if (k === 'rulesSave') saveRules();
    else if (k === 'popout') popOut();
  }
  function popOut() {
    const w = window.open('agent.html', 'chartbridge-agent', 'popup=yes,width=1500,height=920');
    if (w) { try { w.focus(); } catch (e) { /* another window */ } } else notice({ kind: 'status', level: 'amber', text: 'The browser blocked the new window: allow pop-ups for this page.' });
  }
  if (view) {
    view.addEventListener('click', onViewClick);
    view.addEventListener('change', e => {
      if (e.target.closest('[data-k="pick"]')) { choose(e.target.value); unmountChart(); render(); return; }
      if (e.target.closest('[data-k="tf"]')) { S.chartTf = TF_NAMES[e.target.value] ? e.target.value : 'm1'; writeJson(KEYS.chart, { tf: S.chartTf }); if (S.chart) S.chart.setView({ tf: S.chartTf }); renderChartHead(); return; }
      if (e.target.closest('[data-k="chartRoot"]')) { S.wantRoot = e.target.value; unmountChart(); if (S.shown) mountChart(); }
    });
    view.addEventListener('toggle', e => { const d = e.target; if (d && d.matches && d.matches('details[data-key]')) { if (d.open) S.openThink.add(d.dataset.key); else S.openThink.delete(d.dataset.key); const box = q('[data-k="feed"]'); if (box) box.dataset.html = ''; } }, true);
    view.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.closest('.ag-rform input')) { e.preventDefault(); saveRules(); } });
  }

  /* ---------------- the Agent tab's chart: a normal live chart on the window's feed, never animated, takes no orders */
  const chartHost = { pressOff: () => 'The Agent tab\'s chart is for watching: it takes no orders. Its lines are the agent\'s own working orders.', place: () => {}, move: () => {}, cancel: () => {} };
  /* the chart's root: the one picked here, else the position's, else a working entry's, else the agent's first root */
  function rootFor(a) {
    const roots = (AC.parseRules(a && a.rules) || { roots: [] }).roots.filter(r => S.instruments[r] || !Object.keys(S.instruments).length);
    if (S.wantRoot && roots.includes(S.wantRoot)) return S.wantRoot;
    if (a && a.position && a.position.root) return a.position.root;
    const w = a ? AC.workingEntries(S.orders.values(), a)[0] : null;
    if (w) return w.root;
    const p = a ? props.open(a.agent)[0] : null;
    if (p && p.root) return p.root;
    return a && a.lastPlan && roots.includes(a.lastPlan.root) ? a.lastPlan.root : roots[0] || 'MNQ';
  }
  function mountChart() {
    if (!view || S.chart || !window.ChartLive || !o.feed || !cur()) return;
    const body = q('[data-k="chart"]');
    S.chartRoot = rootFor(cur());
    S.chart = window.ChartLive.mount(body, {
      feed: o.feed, paneId: 'agent', storagePrefix: o.storagePrefix || '', toolbar: false, compact: true, trade: chartHost,
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
    const c = S.chart; S.chart = null; linesSig = '';
    try { c.destroy(); c.indicators.remove(); c.chips.remove(); if (c.badge) c.badge.remove(); } catch (e) { /* gone */ }
  }
  function renderChartHead() {
    if (!view) return;
    put(q('[data-k="chartName"]'), 'textContent', (S.contract && S.contract.split(' ')[0] === S.chartRoot ? S.contract : S.chartRoot || 'MNQ') + ' · ' + TF_NAMES[S.chartTf]);
    const a = cur(), roots = (AC.parseRules(a && a.rules) || { roots: [] }).roots, sel = q('[data-k="chartRoot"]');
    const html = roots.map(r => '<option value="' + esc(r) + '">' + esc(r) + '</option>').join('');
    if (sel.dataset.html !== html) { sel.dataset.html = html; sel.innerHTML = html; }
    put(sel, 'value', S.chartRoot); put(sel, 'hidden', roots.length < 2);
  }
  let linesSig = '';
  function renderChartLines(force) {
    if (!S.chart) { linesSig = ''; return; }
    const a = cur();
    if (!a) return;
    if (S.chartRoot !== rootFor(a)) { unmountChart(); if (S.shown) mountChart(); return; }
    const r = S.chartRoot, list = [...S.orders.values()].filter(x => x.root === r && AC.isAgentMark(x, a));
    const pos = a.position && a.position.root === r && a.position.qty ? { qty: a.position.qty, avgPrice: a.position.avgPrice } : null;
    const sig = JSON.stringify([list, pos, a.account, r]);
    if (sig === linesSig && force !== true) return;
    linesSig = sig;
    const OT = window.OrderTicket, out = [];
    for (const x of list) { out.push(x); if (OT && OT.plannedLines && x.planned) { try { for (const l of OT.plannedLines(x, tickOf(r)).lines) out.push(l); } catch (e) { /* older order-ticket.js */ } } }
    S.chart.setTrade({ root: r, account: a.account || 'Sim101', live: false, orders: out, position: pos, pointValue: (S.instruments[r] && +S.instruments[r].pointValue) || 0, qty: 1 });
    renderChartHead();
  }
  function renderTrips() { if (S.chart && S.chart.chart) { S.chart.chart.setLayers({ trades: true }); S.chart.chart.setTrades(trips()); } }

  /* ---------------- the tab */
  function showTab(on) {
    on = !!on || popout;
    if (on === S.shown) return;
    S.shown = on;
    if (typeof o.onTab === 'function') o.onTab(on);
    if (!on) unmountChart();
    render();
    seenNow();
  }
  if (tabBtn) tabBtn.addEventListener('click', () => showTab(!S.shown));

  if (popout) S.shown = true;
  const unlisten = V3 ? V3.listen({ message: onMessage, closed: () => lost() }) : () => {};
  render();
  loadKeys();

  const api = {
    VERSION,
    /** the workspace's hello (its order connection's): with an older ChartBridge the v3 connection never opens, so the tab
        says what it lacks from this one */
    hello(m) {
      if (m && Array.isArray(m.features) && m.features.includes('v3')) return;
      S.v3 = false; S.version = m && typeof m.version === 'string' ? m.version : ''; render();
    },
    keysChanged() {
      loadKeys();
      for (const x of cards.values()) if (!x.ended) both(x, el => {
        const n = el.querySelector('[data-k="msg"]'), t = n ? n.textContent : '';
        el.innerHTML = propHtml(x.p);
        if (t) put(el.querySelector('[data-k="msg"]'), 'textContent', t);
        if (props.answered(x.p.agent, x.p.id)) for (const b of el.querySelectorAll('button')) b.disabled = true;   // answered: waiting for ChartBridge
      });
      tick();
    },
    showTab, shown: () => S.shown,
    /** agents are known: the copilot keys work for them too */
    on: () => agents.size() > 0,
    layoutChanged(name) { S.layout = String(name || ''); if (S.shown && !popout) showTab(false); },
    choose: id => { choose(id); unmountChart(); render(); },
    answer: (agent, id, ans) => answer(agent, id, ans),
    /* read only, for the tests and the console */
    state: () => ({ v3: S.v3, version: S.version, signedIn: S.signedIn, shown: S.shown, chosen: S.chosen, agents: agents.list().map(a => Object.assign({}, a)),
      proposals: [...cards.values()].map(x => ({ agent: x.p.agent, id: x.p.id, ended: !!x.ended, corner: !x.corner.hidden })), offText: AC.offText(offCtx()),
      feed: S.chosen ? feed.counts(S.chosen) : { notes: 0, plans: 0 }, chart: !!S.chart, chartRoot: S.chartRoot, orders: [...S.orders.values()].map(x => ({ id: x.id, by: x.by, role: x.role, root: x.root })), trips: trips() }),
    chart: () => (S.chart ? S.chart.chart : null),
    destroy() { unlisten(); unroute(); unmountChart(); propBox.removeEventListener('click', onCardClick); for (const x of cards.values()) x.corner.remove(); clearTimeout(timer); },
  };
  return api;
}

window.AgentDesk = { create, VERSION };
})();
