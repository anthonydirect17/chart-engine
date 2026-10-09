/*
 * AgentDesk: the Agent tab (chart page 1.17.0; ChartBridge 0.5.0's agent channel, contract AGENT_CHANNEL v1,
 * docs/AGENT_TAB.md). Where Anthony watches and controls his AI trading agents (Manrae is the first; the tab serves any
 * number). The logic is live/agent-core.js (AgentCore); this file draws it. The look is board F of Anthony's mockups
 * (2026-10-08, "love it, lets build F into the real agent tab"): a blue-black ground, cyan panels, Chakra Petch and JetBrains
 * Mono, purple and red only on a few buttons, chips and words, and one slow light that circles the panels where the agent's
 * attention is, in a colour that says what he is doing (AgentCore.lightState). Every stream row is a button that opens his
 * full record of that decision in a drawer over the right column.
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
 *     in the page, never with a browser dialog.
 *   - Motion (docs/MOTION.md R3): only the border light and the panels' glow move or fade. The kill switch, the mode, Accept and
 *     Reject, the position, the P&L, the price and the chart change at once (data-no-motion; no transition, no count-up). The
 *     light is pure CSS (no per-frame script), drawn again only when a message arrives; the Motion switch (Full, Off; kept in
 *     this browser) and the system's reduced motion stop it, and the glow stays, still. The ChartMotion kit is not used here.
 *   - Keys: no keydown handler on the document. Escape closes the drawer only from inside it; the trading hotkeys work as
 *     everywhere (a stream row is a button, not a box).
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
const KEYS = { chosen: 'live-agent-chosen-v1', chart: 'live-agent-chart-v1', fills: 'live-agent-fills-v1', feed: 'live-agent-feed-v1' };   // the Motion switch: AgentCore.MOTION_KEY
const FILTERS = [['all', 'All'], ['plans', 'Plans'], ['notes', 'Notes'], ['thinking', 'Thinking'], ['lesson', 'Lessons']];
let drawerSeq = 0;
/* a panel the light may circle: its light, drawn only while the panel is lit: the line (four 3 px strips along the border) and
   its halo (four soft strips across it), each turning one small conic gradient on the compositor (live/agent.css) */
const EDGES = ['t', 'r', 'b', 'l'];
const LIGHT_HTML = '<div class="ag-light" aria-hidden="true">' + EDGES.map(e => '<i class="ag-edge e-' + e + '"><b></b><b></b></i>').join('') +
  EDGES.map(e => '<i class="ag-edge ag-h e-' + e + '"><b></b><b></b></i>').join('') + '</div>';

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
    killConfirm: 0, autoConfirm: 0, rulesEdit: false, acctEdit: false, acctAsk: '', acctAskMode: '', feedFilter: 'all', rows: null,
    chart: null, chartRoot: '', chartTf: 'm1', contract: '',
    motion: AC.motionPref(storage), drawer: '', exits: new Map(), lightSig: '', lightColor: '', lightSlot: 0,
  };
  { const v = readJson(KEYS.chart); if (v && TF_NAMES[v.tf]) S.chartTf = v.tf; }
  { const v = readJson(KEYS.feed); if (v && FILTERS.some(f => f[0] === v.filter)) S.feedFilter = v.filter; }

  /* ---------------- the DOM: built once, written only where it changed */
  const view = els.view, tabBtn = els.tab;
  const DRAWER_ID = 'agDrawer' + (++drawerSeq);
  const q = sel => (view ? view.querySelector(sel) : null);
  /* the Bot tab's corner (its proposals): hidden while this tab is shown. An agent's proposal is never a card outside this
     tab: off it, one line in the corner counts them (cornerLine), each name opening this tab on that agent */
  const propBox = document.querySelector('.bt-props');
  const cornerLine = view && !popout ? (() => { const d = document.createElement('div'); d.className = 'ag-cornerline'; d.setAttribute('role', 'region'); d.setAttribute('aria-label', 'Agent proposals open'); d.hidden = true; document.body.appendChild(d); return d; })() : null;
  const notes = document.querySelector('.bt-notes') || (() => { const d = document.createElement('div'); d.className = 'ag-notes'; d.setAttribute('aria-live', 'polite'); document.body.appendChild(d); return d; })();
  if (view) build();

  function build() {
    view.classList.add('ag-view');
    view.innerHTML =
      '<div class="ag-off" data-k="off" hidden><div class="ag-off-card"><span class="ag-ttl">Agents</span><p data-k="offText"></p>' +
        '<div class="ag-others" data-k="others" data-where="off" aria-label="Proposals open elsewhere"></div></div></div>' +
      /* narrower than 1100 px: ChartBridge's line and the notices, pinned at the top in a band of their own (agent.css) */
      '<div class="ag-tray" data-k="tray" aria-label="ChartBridge and notices"></div>' +
      '<div class="ag-main" data-k="main" hidden>' +
      /* the strip: who, how it is, what it holds */
      '<header class="ag-strip ag-panel" data-k="strip" data-no-motion>' +
        '<span class="ag-badge" data-k="initials" aria-hidden="true"></span>' +
        '<span class="ag-brand"><span class="ag-name" data-k="name"></span> <span class="ag-desk">// AGENT DESK</span></span><span class="ag-chip ag-build" data-k="build" title="The build the agent runs, as it says in its hello"></span>' +
        '<span class="ag-conn" data-k="conn"><i></i><span data-k="connText"></span></span>' +
        '<span class="ag-chip ag-mode" data-k="modeChip"></span>' +
        '<span class="ag-kv"><span class="ag-lbl">Account</span><span class="mono" data-k="sAccount"></span> <span class="bt-acct ag-mark" data-k="sMark"></span></span>' +
        '<span class="ag-kv"><span class="ag-lbl">Position</span><span class="mono" data-k="sPos"></span></span>' +
        '<span class="ag-chip ag-owns" data-k="sOwns" hidden title="The owner lock: while the agent has a position or a working entry here, ChartBridge refuses every new entry from anyone else. Your Flatten, cancels and stop or target moves always work."></span>' +
        '<span class="ag-chip ag-bad" data-k="sState" hidden></span>' +
        '<span class="ag-fill"></span>' +
        '<label class="ag-pick" data-k="pickWrap" hidden><span class="ag-lbl" data-k="pickN">Agents</span><select class="ag-sel" data-k="pick" aria-label="Agent shown"></select></label>' +
        '<span class="ag-motion" role="group" aria-label="Motion of the light" title="The light around the panels: Full moves it, Off keeps it still (kept in this browser). Your system\'s reduced motion keeps it still too."><span class="ag-lbl">Motion</span>' +
          '<button type="button" data-motion="full" aria-pressed="true">Full</button><button type="button" data-motion="off" aria-pressed="false">Off</button></span>' +
        (popout ? '' : '<button type="button" class="ws-btn ag-popbtn" data-act="popout" title="Open the Agent tab in its own window (for a third monitor)">Pop out</button>') +
      '</header>' +
      '<div class="ag-grid" data-k="grid">' +
      /* left: control, his account, his rules */
      '<aside class="ag-col ag-left ag-panel" data-panel="acct" aria-label="Agent controls">' + LIGHT_HTML + '<div class="ag-scroll">' +
        '<div class="ag-sec" data-no-motion><div class="ag-sechead"><span class="ag-ttl">Mode</span><span class="ag-lbl" data-k="modeAcct"></span></div>' +
          '<div class="ag-modes" role="group" aria-label="Agent mode" data-k="modes">' + AC.MODES.map(m => '<button type="button" data-mode="' + m + '" aria-pressed="false">' + AC.MODE_NAME[m] + '</button>').join('') + '</div>' +
          '<p class="ag-why" data-k="modeWhy" hidden></p>' +
          '<button type="button" class="ag-kill" data-act="kill" data-k="kill">Kill switch</button>' +
          '<div class="ag-pgrid"><span>Status</span><span data-k="status">-</span><span>Heartbeat</span><span class="mono" data-k="beat">-</span><span>Last plan</span><span data-k="last">-</span></div>' +
        '</div>' +
        '<div class="ag-sec" data-no-motion><div class="ag-sechead"><span class="ag-ttl">His account</span></div>' +
          '<div class="ag-pgrid"><span>Trades on</span><span><span class="mono" data-k="account">Sim101</span> <span class="bt-acct ag-mark" data-k="accountMark"></span></span></div>' +
          '<div class="ag-room" data-k="room"></div>' +
          '<div class="ag-edit" data-k="acctEdit" hidden><select class="ag-sel" data-k="acctSel" aria-label="The agent\'s account"></select>' +
            '<button type="button" class="ag-btn primary" data-act="acctSave">Set</button><button type="button" class="ag-btn" data-act="acctCancel">Cancel</button></div>' +
          '<div class="ag-ask" data-k="acctAsk" role="alertdialog" aria-label="Trade a LIVE account" hidden><span data-k="acctAskText"></span>' +
            '<button type="button" class="ag-btn ag-live-go" data-act="acctYes">Continue</button><button type="button" class="ag-btn" data-act="acctNo">Cancel</button></div>' +
          '<div class="ag-row"><button type="button" class="ag-btn" data-act="acctOpen" data-k="acctOpen" title="Any account ChartBridge says is tradable, except the bot\'s, the copier\'s and another agent\'s; only while the agent is flat">Change account</button></div>' +
          '<p class="ag-why" data-k="acctWhy"></p>' +
        '</div>' +
        '<div class="ag-sec"><div class="ag-sechead"><span class="ag-ttl">Rules</span></div>' +
          '<div class="ag-pgrid ag-rules" data-k="rules"></div>' +
          '<div class="ag-rform" data-k="rulesEdit" hidden>' +
            '<div class="ag-rroots" data-k="rRoots"></div>' +
            '<label><span>New entries from</span><input class="ag-in" data-r="entryFrom" maxlength="5" inputmode="numeric" placeholder="09:45" aria-label="New entries from, New York time"></label>' +
            '<label><span>New entries until</span><input class="ag-in" data-r="entryUntil" maxlength="5" inputmode="numeric" placeholder="15:00" aria-label="New entries until, New York time"></label>' +
            '<label><span>Flat at</span><input class="ag-in" data-r="flatAt" maxlength="5" inputmode="numeric" placeholder="15:55" aria-label="Flat at, New York time"></label>' +
            '<label><span>Entry lives, s</span><input class="ag-in" type="number" min="60" max="1800" step="1" data-r="maxExpireSec" aria-label="An entry lives at most, seconds (60 to 1800)"></label>' +
            '<label><span>Trades a day</span><input class="ag-in" type="number" min="0" max="50" step="1" data-r="maxTrades" aria-label="Trades a day, 0 for no limit"></label>' +
            '<label><span>Losing trades</span><input class="ag-in" type="number" min="0" max="20" step="1" data-r="maxLosses" aria-label="Losing trades before it stands down, 0 for no limit"></label>' +
            '<p class="ag-help">New York time · 0 = no limit</p>' +
            '<div class="ag-row"><button type="button" class="ag-btn primary" data-act="rulesSave">Set</button><button type="button" class="ag-btn" data-act="rulesCancel">Cancel</button></div>' +
          '</div>' +
          '<div class="ag-row"><button type="button" class="ag-btn" data-act="rulesOpen" data-k="rulesOpen">Change the rules</button></div>' +
          '<p class="ag-why" data-k="rulesWhy"></p>' +
        '</div>' +
      '</div></aside>' +
      /* centre: what he is doing now, then the chart (a normal live chart: never animated, takes no orders) */
      '<section class="ag-col ag-centre" aria-label="What the agent is doing, and its chart">' +
        '<div class="ag-panel ag-pipe" data-panel="pipe">' + LIGHT_HTML +
          '<div class="ag-pipehead"><span class="ag-k2">What he is doing now</span><span class="ag-said" data-k="said" role="status"></span></div>' +
          '<ol class="ag-steps" data-k="steps">' + AC.STEPS.map((x, i) => '<li class="ag-step t-' + x[0] + '" data-step="' + i + '"><span class="ag-node mono">' + (i + 1) + '</span><span class="ag-stepname">' + x[1] + '</span></li>').join('') + '</ol>' +
        '</div>' +
        '<div class="ag-panel ag-chartpanel" data-panel="chart">' + LIGHT_HTML +
          '<div class="ag-charthead"><span class="ag-ttl" data-k="chartName" title="The agent\'s trades today: triangles in, dots out; its working entry, stop and target as lines. ChartBridge marks the agent\'s orders, so your own orders on its account do not show here.">Chart</span>' +
            '<select class="ag-sel ag-small" data-k="chartRoot" aria-label="Root"></select>' +
            '<select class="ag-sel ag-small" data-k="tf" aria-label="Bars">' + Object.keys(TF_NAMES).map(k => '<option value="' + k + '">' + TF_NAMES[k] + '</option>').join('') + '</select>' +
            '<span class="chart-live ws-lv" data-k="ind"></span>' +
            '<span class="ag-fill"></span>' +
            '<span class="ag-cposwrap"><span class="ag-cpos mono" data-k="cPos" data-no-motion></span><span class="ag-cpnl mono" data-k="cPnl" data-no-motion title="Open P&L: NinjaTrader\'s for the agent\'s account, else from the chart\'s last price"></span></span>' +
            '</div>' +
          '<div class="ag-chart" data-k="chart" data-no-motion><div class="ag-over" data-k="over"></div></div>' +
        '</div>' +
      '</section>' +
      /* right: the proposal (the shown agent's own, in its slot; the others only counted, in one line under it), then his
         stream; his decision's drawer slides over both */
      '<aside class="ag-col ag-right" aria-label="Proposals and his stream">' +
        '<div class="ag-panel ag-proppanel" data-panel="prop" data-no-motion>' + LIGHT_HTML +
          '<div class="ag-sechead"><span class="ag-k2">Proposal · copilot</span><span class="ag-lbl" data-k="propCount"></span></div>' +
          '<div class="ag-slot" data-k="slot"><div class="ag-plist" data-k="plist"></div><p class="ag-empty" data-k="pempty">None open</p></div>' +
          '<div class="ag-others" data-k="others" aria-label="Other proposals open"></div></div>' +
        '<div class="ag-panel ag-feedwrap" data-panel="stream">' + LIGHT_HTML +
          '<div class="ag-loghead"><span class="ag-k2">His stream</span><span class="ag-lbl" data-k="feedCount"></span></div>' +
          '<div class="ag-filters" role="tablist" data-k="filters">' + FILTERS.map(f => '<button type="button" role="tab" data-filter="' + f[0] + '" aria-selected="false">' + f[1] + '</button>').join('') + '</div>' +
          '<div class="ag-feed" data-k="feed"></div></div>' +
        '<section class="ag-drawer" data-k="drawer" id="' + DRAWER_ID + '" role="dialog" aria-label="His decision" hidden></section>' +
      '</aside>' +
      '</div>' +
      /* the footer: today's dollars, trades, losses, his session as a trail */
      '<footer class="ag-panel ag-foot" data-panel="pnl">' + LIGHT_HTML +
        '<div class="ag-footrow">' +
          '<div class="ag-big" data-no-motion><span class="mono ag-today" data-k="sPnl">-</span><span class="ag-lbl" data-k="todayNote">Today</span></div>' +
          '<div class="ag-big" data-no-motion><span class="mono ag-count" data-k="sTrades">0</span><span class="ag-lbl">Trades</span></div>' +
          '<div class="ag-big" data-no-motion><span class="mono ag-count ag-losses" data-k="sLosses">0</span><span class="ag-lbl">Losses</span></div>' +
          '<div class="ag-trail" data-k="trail" aria-label="His session"></div>' +
        '</div>' +
        '</footer>' +
      '</div>';
  }

  /* ---------------- the window's v3 connection */
  const V3 = o.v3 || null;
  const sendRaw = m => !!V3 && V3.post(m);
  const cid = () => 'ag' + (++S.cidSeq).toString(36) + Math.random().toString(36).slice(2, 6);
  function lost() {
    S.signedIn = false; S.trading = null; S.orders.clear(); ledger.clear(); unclaimed.clear();
    agents.clear(); feed.clear();
    for (const p of props.clear()) { const x = cards.get(keyOf(p.agent, p.id)); if (x) removeCard(x); }
    botProps.clear();
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
      case 'accounts': S.accounts = m; renderPanel(); renderLive(); return;
      case 'bot': S.bot = m; return;
      case 'botProposal': botProps.update(m); renderOthers(); return;   // counted under the proposal while the tab is shown
      case 'copier': S.copier = m; return;
      case 'agent': onAgent(m); return;
      case 'agentProposal': onProposal(m); return;
      case 'agentPlan': if (feed.plan(m)) { renderFeed(); renderStrip(); renderLive(); } return;
      case 'agentNote': if (feed.note(m)) { renderFeed(); renderLive(); } return;
      case 'orders': S.orders.clear(); for (const x of m.list || []) noteOrder(x); reclaim(); renderChartLines(); renderPanel(); renderLive(); return;
      case 'order': noteOrder(m); reclaim(); renderChartLines(); renderPanel(); renderLive(); return;
      case 'exec': onExec(m); return;
      case 'execs': for (const x of m.list || []) onExec(x, true); renderTrips(); renderFeed(); renderLive(); return;
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
    /* a flat exit this window saw: the light shows how it went, then goes back to the tracker */
    const qa = r.prev && r.prev.position && isNum(r.prev.position.qty) ? r.prev.position.qty : 0, qb = m.position && isNum(m.position.qty) ? m.position.qty : 0;
    if (qa && !qb) {
      const list = S.exits.get(m.agent) || [];
      list.push({ at: Date.now(), pnl: isNum(r.prev.pnlToday) && isNum(m.pnlToday) ? Math.round((m.pnlToday - r.prev.pnlToday) * 100) / 100 : null });
      S.exits.set(m.agent, list.slice(-20));
    }
    render();
  }
  function choose(id, quiet) {
    if (S.chosen === id) return;
    S.chosen = id; S.othersQuiet = true; S.rulesEdit = false; S.acctEdit = false; S.acctAsk = ''; S.killConfirm = 0; S.autoConfirm = 0; S.drawer = ''; S.lightSig = '';
    for (const k of ['rulesWhy', 'acctWhy']) put(q('[data-k="' + k + '"]'), 'textContent', '');
    writeJson(KEYS.chosen, id);
    placeCards();
    seenNow();
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
  function reclaim() { let any = false; for (const f of [...unclaimed.values()]) if (claim(f)) { unclaimed.delete(f.id); keepFill(f); any = true; } if (any) { renderTrips(); renderFeed(); renderLive(); } }
  function claim(f) { for (const a of agents.list()) if (ledgerOf(a.agent).claim(f)) { f.agent = a.agent; return true; } return false; }
  function onExec(f, quiet) {
    if (!f || typeof f.id !== 'string') return;
    if (!claim(f)) { unclaimed.set(f.id, f); if (unclaimed.size > 500) unclaimed.delete(unclaimed.keys().next().value); return; }
    keepFill(f);
    if (!quiet) { renderTrips(); renderFeed(); renderLive(); }
  }
  function fillsDay() { const v = readJson(KEYS.fills), day = BC.tradeDay(Date.now()); return v && v.day === day && Array.isArray(v.list) ? v : { day, list: [] }; }
  function keepFill(f) {
    const v = fillsDay();
    if (v.list.some(x => x.id === f.id)) return;
    v.list.push({ id: f.id, agent: f.agent, side: f.side, qty: f.qty, p: f.p, t: f.t, u: isNum(f.u) ? f.u : null, root: f.root, account: f.account });
    if (v.list.length > 400) v.list.splice(0, v.list.length - 400);
    writeJson(KEYS.fills, v);
  }
  function trips() { const a = cur(); if (!a) return []; return BC.trips(fillsDay().list.filter(x => x.agent === a.agent && x.root === S.chartRoot).sort((x, y) => x.t - y.t)); }
  /* the agent's fills today and its closed trades, on the clock (each fill's `u`, UTC ms), for the stream and the trail */
  const pointValue = r => (S.instruments[r] && +S.instruments[r].pointValue > 0 ? +S.instruments[r].pointValue : 0);
  function dayTrades(id) {
    const fills = fillsDay().list.filter(x => x.agent === id && isNum(x.u)), exits = [];
    for (const r of [...new Set(fills.map(f => f.root))]) {
      const list = fills.filter(f => f.root === r).map(f => Object.assign({}, f, { t: f.u })).sort((x, y) => x.t - y.t);
      for (const t of BC.trips(list)) {
        if (t.tOut === null) continue;
        const pv = pointValue(r);
        exits.push({ root: r, dir: t.dir, qty: t.qty, pIn: t.pIn, pOut: t.pOut, tIn: t.tIn, tOut: t.tOut, at: t.tOut, pnl: pv ? Math.round((t.pOut - t.pIn) * t.dir * t.qty * pv * 100) / 100 : null });
      }
    }
    return { fills, exits };
  }

  /* ---------------- proposals: a card only in the tab, for the agent shown; counted everywhere else */
  const cards = new Map();                     // agent|id -> { inline, p, shownAt, ended }
  const botProps = BC.createProposals();       // the bot's, only to count them under the proposal (live/bot.js shows and answers them)
  const keyOf = (a, id) => a + '|' + id;
  function onProposal(p) {
    const r = props.update(p);
    if (r.act === 'show') { showProposal(r.p); renderChartLines(); }
    else if (r.act === 'update') { const x = cards.get(keyOf(p.agent, p.id)); if (x) x.p = p; else showProposal(p); }
    else if (r.act === 'end') endProposal(r.p, r.why);
    renderPanel(); renderFeed(); renderLive(); renderOthers();
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
        '<span>Open until</span><span>' + (isNum(p.expiresAt) ? esc(AC.etClockSec(p.expiresAt)) + ' ET' : '-') + '</span>' +
        '<span>Account</span><span>' + esc(acc.name) + ' ' + markHtml(acc.mark) + '</span></div>' +
      /* the foot: ChartBridge's words (a refusal, the last 5 s, "Waiting for ChartBridge") right above Accept and Reject, so both
         stay in sight together while the proposal's words scroll (the foot is sticky in the tab) */
      '<div class="ag-prop-foot"><div class="ag-prop-msg" data-k="msg" role="status"></div>' +
      '<div class="ag-prop-btns"><button type="button" class="ag-acc" data-agans="accept" data-no-motion>Accept' + kc(S.keys.accept) + '</button><button type="button" class="ag-rej" data-agans="reject" data-no-motion>Reject' + kc(S.keys.reject) + '</button></div></div>';
  }
  function makeCard(p) {
    const el = document.createElement('div');
    el.className = 'ag-prop inline';
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
    const x = { inline: makeCard(p), p, shownAt: Date.now(), ended: false };
    for (const y of [...cards.values()]) if (y.p.agent === p.agent && y.ended) removeCard(y);   // its agent's ended ones make way
    cards.set(k, x);
    placeCards();
    if (p.agent === S.chosen && q('[data-k="slot"]')) q('[data-k="slot"]').scrollTop = 0;   // the new proposal from its top
    seenNow();
    tick();
  }
  /* Each card in its place (Anthony, 2026-10-08): the agent shown in the tab has its proposals in the tab's slot, a box of a
     fixed height at the top of the proposal panel, reserved whenever the tab is shown ("None open" in it when it is empty),
     so its arrival, ending and going move nothing and its Accept and Reject are always in sight. No other proposal shows on
     the tab as a card: the corner (the Bot tab's, with the bot's proposals, or this window's own) is hidden while the tab is
     shown (hideBox), and one line of a fixed height under the slot counts what is open elsewhere, each name a link to the
     tab where it is answered (renderOthers). Off the tab no agent's proposal is a card anywhere (the re-review of c47a8a1:
     two agents' cards and the bot's ran the corner over the top bar): one line in the corner counts them, each name opening
     the tab on that agent, and the copilot keys answer an agent's proposal only in the tab. The slot is written only when
     its cards changed: a button taken out of the page loses its focus and a press held on it (review of fc3101a). */
  const mineNow = () => [...cards.values()].filter(x => x.p.agent === S.chosen);
  /* "None open" in the slot while the shown agent has nothing there (the slot keeps its height either way) */
  function placeEmpty() { put(q('[data-k="pempty"]'), 'hidden', !!q('[data-k="plist"] .ag-prop')); }
  function placeCards() {
    setTimeout(placeDrawer, 0);                                // a proposal came or went: the drawer keeps clear of it (setTimeout passes no argument)
    const list = q('[data-k="plist"]');
    const mine = mineNow(), want = mine.map(x => x.inline);
    if (list && (list.children.length !== want.length || want.some((el, i) => list.children[i] !== el))) list.replaceChildren(...want);
    const n = mine.filter(x => !x.ended).length;
    put(q('[data-k="propCount"]'), 'textContent', n ? n + ' open' : '');
    hideBox(); placeEmpty(); renderOthers();
  }
  /* the Bot tab's corner, hidden while the tab is shown: no proposal but the shown agent's is a card on the tab. While agents
     are known (and the tab is not shown) the corner keeps the room of the agents' line under it (agent.css body.ag-agents),
     so that line coming and going moves none of the bot's cards. */
  function hideBox() {
    if (propBox) tog(propBox, 'ag-hide', !!(S.shown && view));
    if (cornerLine) tog(document.body, 'ag-agents', agents.size() > 0 && !S.shown);
  }
  /* The line under the slot: how many proposals are open elsewhere, by whose ("Bot: 1 proposal · Second Demo: 2"), each name a
     button to where they are answered (the Bot tab; another agent in this tab). It keeps its one line's height with nothing
     open ("No other proposals"), has no Accept or Reject, and never moves: a count that rises is marked at once, still, for
     8 s (R3: no motion). */
  const UP_MS = 8000;
  const lineIn = { up: new Map(), last: new Map() }, lineOut = { up: new Map(), last: new Map() };   // the tab's line, the corner's
  let othersTimer = 0;
  /* open proposals by whose: the bot's (with `bot`), then each agent's but `but`'s, in the agents' order */
  function openCounts(bot, but) {
    const out = [], by = new Map();
    if (bot && BC.botSwitchOn(S.trading)) { const n = botProps.open().length; if (n) out.push({ key: 'bot', name: 'Bot', n }); }
    for (const x of cards.values()) if (!x.ended && x.p.agent !== but) by.set(x.p.agent, (by.get(x.p.agent) || 0) + 1);
    for (const id of [...agents.ids().filter(i => by.has(i)), ...[...by.keys()].filter(i => !agents.get(i))]) out.push({ key: 'agent:' + id, id, name: AC.agentName(agents.get(id) || { agent: id }), n: by.get(id) });
    return out;
  }
  const otherCounts = () => openCounts(true, S.chosen);
  /* a line's words: "Name: 1 proposal · Name: 2", each name a button (data-goto), a risen count marked (st: its counts) */
  function lineHtml(list, st, now, quiet, title) {
    const seen = new Set(list.map(x => x.key));
    for (const x of list) { if (!quiet && x.n > (st.last.get(x.key) || 0)) st.up.set(x.key, now + UP_MS); st.last.set(x.key, x.n); }
    for (const k of [...st.last.keys()]) if (!seen.has(k)) { st.last.delete(k); st.up.delete(k); }
    if (quiet) st.up.clear();
    const bot = typeof o.openBot === 'function';
    return list.map((x, i) => {
      const up = (st.up.get(x.key) || 0) > now;
      const name = x.key === 'bot' && !bot ? '<span class="ag-oname" title="Answered on the Bot tab of the workspace">' + esc(x.name) + '</span>'
        : '<button type="button" class="ag-olink" data-goto="' + esc(x.key) + '" title="' + esc(title(x)) + '">' + esc(x.name) + '</button>';
      return '<span class="ag-oitem' + (up ? ' up' : '') + '" data-key="' + esc(x.key) + '" data-n="' + x.n + '">' + name + ': <span class="mono">' + x.n + '</span>' + (i ? '' : x.n === 1 ? ' proposal' : ' proposals') + '</span>';
    }).join('<span class="ag-osep" aria-hidden="true"> · </span>');
  }
  /* write a line, keeping the focus on its name if it had it */
  function writeLine(el, html) {
    const had = el.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.goto : '';
    setHtml(el, html);
    if (had) { const b = el.querySelector('[data-goto="' + CSS.escape(had) + '"]'); if (b && document.activeElement !== b) b.focus({ preventScroll: true }); }
  }
  function renderOthers() {
    if (!view) return;
    clearTimeout(othersTimer); othersTimer = 0;
    const now = Date.now(), quiet = !!S.othersQuiet, list = otherCounts();
    S.othersQuiet = false;
    const html = lineHtml(list, lineIn, now, quiet, x => (x.key === 'bot' ? 'Open the Bot tab: its proposals are answered there' : 'Show ' + x.name + ' in this tab: its proposals are answered here then')) || '<span class="ag-onone">No other proposals</span>';
    for (const el of view.querySelectorAll('[data-k="others"]')) {
      writeLine(el, html);
      put(el, 'hidden', el.dataset.where === 'off' && !list.length);   // the "no agents" card says it only when there is some
    }
    /* the corner's line, off the tab: every agent's open proposals (the bot's are its own cards there) */
    if (cornerLine) {
      const all = openCounts(false, ''), on = !S.shown && all.length > 0;
      writeLine(cornerLine, lineHtml(all, lineOut, now, false, x => 'Open the Agent tab on ' + x.name + ': its proposals are answered there'));
      put(cornerLine, 'hidden', !on);
    }
    const next = Math.min(...[...lineIn.up.values(), ...lineOut.up.values()].filter(t => t > now));
    if (isFinite(next)) othersTimer = setTimeout(renderOthers, next - now + 20);
  }
  /* a name in a line: the Bot tab (the workspace's), or that agent shown in this tab (the tab opened from the corner) */
  function goTo(key) {
    if (key === 'bot') { if (typeof o.openBot === 'function') o.openBot(); return; }
    const id = key.slice(6);
    if (!key.startsWith('agent:') || !agents.get(id)) return;
    if (S.chosen !== id) { choose(id); unmountChart(); }
    if (S.shown) render(); else showTab(true);
  }
  if (cornerLine) cornerLine.addEventListener('click', e => { const b = e.target.closest('button[data-goto]'); if (b) goTo(b.dataset.goto); });
  /* agentSeen the moment it shows, in a window Anthony can see (as the Bot tab's botSeen): only in the tab, for the agent
     shown (elsewhere it is only counted); the keys count its time on screen from then */
  function seenNow() {
    if (document.visibilityState === 'hidden' || !S.shown || !view) return;
    const at = Date.now();
    for (const x of cards.values()) {
      if (x.ended || x.p.agent !== S.chosen) continue;
      const seen = props.shown(x.p.agent, x.p.id, at);
      if (seen) { x.shownAt = at; sendRaw(seen); }
    }
  }
  document.addEventListener('visibilitychange', seenNow);
  const both = (x, fn) => fn(x.inline);
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
  function dropProposal(agent, id) { const x = cards.get(keyOf(agent, id)); if (x) removeCard(x); }
  function removeCard(x) {
    x.inline.remove(); cards.delete(keyOf(x.p.agent, x.p.id)); placeCards();
  }
  function onCardClick(e) {
    const b = e.target.closest('button[data-agans]'); if (!b) return;
    const card = b.closest('.ag-prop');
    if (card) answer(card.dataset.agent, card.dataset.id, b.dataset.agans);
  }
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
    renderLive();
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
  /* the router's view of this tab: only while the tab is shown (an agent's proposal is a card nowhere else, so off the tab
     the keys answer the bot's alone, as 1.16.0), every proposal not ended (an answered one waiting for ChartBridge stays the
     key's target), and the agent shown: the keys then answer its proposals only, never the bot's or another agent's (not
     shown on the tab); open on its "no agents" card (true), none at all */
  const unroute = ROUTER.add('agents', { kind: 'agents',
    open: () => (S.shown && view ? [...cards.values()] : []).filter(x => !x.ended).map(x => ({ id: x.p.agent + ':' + x.p.id, agent: x.p.agent, shownAt: x.shownAt, answered: !!props.answered(x.p.agent, x.p.id),
      expiresAt: x.p.expiresAt, answer: ans => answer(x.p.agent, x.p.id, ans) })),
    focus: () => (S.shown && view ? (cur() ? S.chosen : true) : '') });
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
      renderLive();
    } else if (x.kind === 'rules') rulesWhy(why, 'refused');
    else if (x.kind === 'account') put(q('[data-k="acctWhy"]'), 'textContent', why);
    else if (x.kind === 'mode' || x.kind === 'kill') modeWhy(why);
    else notice({ kind: 'refused', level: 'amber', text: why });
  }
  function onStatus(m) {
    if (!m || typeof m.text !== 'string' || (m.level !== 'info' && document.getElementById('wsAlert'))) return;   // warn and error: the workspace's own line shows them
    const id = AC.statusAgent(m.text, agents.ids());          // "agent <id>" anywhere, in any case (ChartBridge 0.5.0 as built)
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
    placeCards(); placeNotes();
    renderStrip(); renderPanel(); renderFeed(); renderChartLines(); renderLive();
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
    if (!why.dataset.refused) { put(why, 'hidden', !(S.autoConfirm > now)); put(why, 'textContent', S.autoConfirm > now ? 'Click Confirm within 4 s: Auto on ' + acc.name + (acc.mark === 'LIVE' ? ', a LIVE account.' : '.') : ''); tog(why, 'live', acc.mark === 'LIVE'); }
    const kill = q('[data-k="kill"]');
    put(kill, 'textContent', a.killed ? (S.killConfirm > now ? 'Release: click again' : 'Kill switch on · Release') : 'Kill switch');
    tog(kill, 'on', !!a.killed); put(kill, 'disabled', !S.signedIn); attr(kill, 'aria-pressed', String(!!a.killed));
    put(q('[data-k="status"]'), 'textContent', AC.statusText(a));
    const beat = q('[data-k="beat"]'); put(beat, 'textContent', AC.beatText(a)); put(beat, 'className', 'mono ' + (!a.connected ? 'neg' : a.lastBeatMs > 2500 ? 'warn' : 'pos'));
    put(q('[data-k="account"]'), 'textContent', acc.name);
    renderRoom(a);
    const work = AC.workingEntries(S.orders.values(), a).length > 0, open = props.open(a.agent).length;
    const can = AC.rulesChangeable(a, { workingEntry: work, openProposals: open });
    put(q('[data-k="acctOpen"]'), 'disabled', !S.signedIn || !can.ok);
    attr(q('[data-k="acctOpen"]'), 'title', can.ok ? 'Any account ChartBridge says is tradable, except the bot\'s, the copier\'s and another agent\'s; only while the agent is flat' : can.why.replace('change its rules', 'choose its account'));
    /* the 0.5.2 re-review: the question names the mode the agent had when it opened, and is never redrawn with another one; the
       mode changed meanwhile (another page): it closes with a note, nothing sent, and Set asks again */
    if (S.acctAsk) { const stale = AC.askStale(S.acctAskMode, a); if (stale) { S.acctAsk = ''; S.acctAskMode = ''; put(q('[data-k="acctWhy"]'), 'textContent', stale); } }
    put(q('[data-k="acctEdit"]'), 'hidden', !S.acctEdit || !!S.acctAsk);
    put(q('[data-k="acctAsk"]'), 'hidden', !S.acctAsk);
    if (S.acctAsk) put(q('[data-k="acctAskText"]'), 'textContent', AC.liveQuestion(Object.assign({}, a, { mode: S.acctAskMode }), S.acctAsk, S.version));   // keepMode: the mode this question names
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

  /* ---------------- his stream: notes, plans, fills and exits, newest first; each row a button that opens his record */
  const hashOf = t => { let h = 5381; const x = String(t); for (let i = 0; i < x.length; i++) h = ((h << 5) + h + x.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  /* every row of the shown agent (all of them, whatever the filter), by key: { key, type, at, m, end, waiting, proposal } */
  function streamRows(a) {
    const rows = [];
    for (const x of feed.items(a.agent, 'all')) {
      if (x.type === 'note') rows.push({ key: 'n' + x.m.at + x.m.kind + hashOf(x.m.text), type: 'note', at: x.at, m: x.m });
      else {
        const m = x.m, card = cards.get(keyOf(m.agent, m.id)), end = S.propEnds.find(e => e.agent === m.agent && e.id === m.id) || null;
        rows.push({ key: 'p' + hashOf(m.id + '|' + m.at + '|' + m.result), type: 'plan', at: x.at, m, end, waiting: !!(card && !card.ended), proposal: props.get(m.agent, m.id) });
      }
    }
    const t = dayTrades(a.agent);
    for (const f of t.fills) rows.push({ key: 'f' + hashOf(f.id), type: 'fill', at: f.u, m: Object.assign({ at: f.u }, f) });
    for (const e of t.exits) rows.push({ key: 'x' + e.root + e.tOut, type: 'exit', at: e.tOut, m: e });
    return rows.sort((x, y) => y.at - x.at);
  }
  const inFilter = (r, f) => f === 'all' ? true : f === 'plans' ? r.type === 'plan' : f === 'notes' ? r.type === 'note' : r.type === 'note' && r.m.kind === f;
  function rowText(r) {
    const m = r.m;
    if (r.type === 'note') return m.text.length > 160 ? m.text.slice(0, 160) + '...' : m.text;
    if (r.type === 'fill') return (m.side === 'buy' ? 'Bought ' : 'Sold ') + m.qty + ' ' + m.root + ' at ' + fmtPx(m.p, m.root);
    if (r.type === 'exit') return 'Out of ' + (m.dir > 0 ? 'long ' : 'short ') + m.qty + ' ' + m.root + (isNum(m.pnl) ? ', ' + (AC.fmtUsd(m.pnl) || '$0.00') : '');
    const line = AC.planLine(m);
    let res = line.result;
    if (m.result === 'proposed') res = r.end ? r.end.state + r.end.react : r.waiting ? 'waiting for you' : 'proposed';
    return line.title + ': ' + res;
  }
  function rowHtml(r) {
    const t = AC.rowTone(r), sel = S.drawer === r.key;
    const label = t.tag + ' at ' + AC.etClockSec(r.at) + ': ' + (sel ? 'close his record' : 'open his record');
    return '<button type="button" class="ag-rowb t-' + t.tone + (r.type === 'note' && r.m.kind === 'status' ? ' sys' : '') + (sel ? ' sel' : '') + '" data-row="' + esc(r.key) + '" aria-expanded="' + sel + '" aria-controls="' + DRAWER_ID + '" aria-label="' + esc(label) + '">' +
      '<span class="ag-t mono">' + esc(AC.etClockSec(r.at)) + '</span><span class="ag-tag">' + esc(t.tag) + '</span>' +
      '<span class="ag-tx' + (r.type === 'note' && r.m.kind === 'notebook' ? ' mono' : '') + '">' + esc(rowText(r)) + '</span><span class="ag-chev" aria-hidden="true">›</span></button>';
  }
  function renderFeed() {
    if (!view) return;
    const a = cur(); if (!a) return;
    for (const b of q('[data-k="filters"]').querySelectorAll('[data-filter]')) attr(b, 'aria-selected', String(b.dataset.filter === S.feedFilter));
    const rows = streamRows(a), shown = rows.filter(r => inFilter(r, S.feedFilter));
    S.rows = new Map(rows.map(r => [r.key, r]));
    const c = feed.counts(a.agent);
    put(q('[data-k="feedCount"]'), 'textContent', c.notes + (c.notes === 1 ? ' note' : ' notes') + ' · ' + c.plans + (c.plans === 1 ? ' plan' : ' plans'));
    const box = q('[data-k="feed"]');
    const had = box.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.row : '';
    setHtml(box, shown.length ? shown.map(rowHtml).join('') : '<p class="ag-empty">' + (a.connected ? 'Nothing yet' : 'Nothing yet · not connected') + '</p>');
    if (had) { const b = box.querySelector('[data-row="' + CSS.escape(had) + '"]'); if (b && document.activeElement !== b) b.focus({ preventScroll: true }); }
    renderDrawer();
  }

  /* ---------------- the decision drawer: his full record of one row, over the right column, in that decision's colour */
  function openDrawer(key) {
    S.drawer = S.drawer === key ? '' : key;                  // the same row again closes it
    renderFeed();
    if (S.drawer) { placeDrawer(true); const x = q('[data-k="drawer"] [data-act="drawerClose"]'); if (x) x.focus({ preventScroll: true }); }
  }
  function closeDrawer() {
    const key = S.drawer;
    if (!key) return;
    S.drawer = '';
    renderFeed();
    const b = q('[data-k="feed"] [data-row="' + CSS.escape(key) + '"]');
    if (b) b.focus({ preventScroll: true });
  }
  function renderDrawer() {
    const d = q('[data-k="drawer"]'); if (!d) return;
    const r = S.drawer && S.rows ? S.rows.get(S.drawer) : null;
    if (S.drawer && !r) S.drawer = '';                         // its row is gone (another agent, a new day)
    if (!r) { put(d, 'hidden', true); setHtml(d, ''); placeDrawer(); return; }   // closed: the stream's rows start at its top again
    const x = AC.decisionRecord(r, { fmtPx, tick: tickOf });
    const html = '<div class="ag-dhead"><div><div class="ag-lbl">' + esc(x.time) + ' · ' + esc(x.tag) + '</div><div class="ag-dtitle">' + esc(x.title) + '</div></div>' +
      '<button type="button" class="ag-dclose" data-act="drawerClose" aria-label="Close his decision">Close</button></div>' +
      (x.words ? '<div class="ag-dsec"><div class="ag-lbl">In his words</div><div class="ag-dquote' + (x.pre ? ' pre mono' : '') + '">' + esc(x.words) + '</div></div>' : '') +
      (x.facts.length ? '<div class="ag-dsec"><div class="ag-lbl">The facts</div>' + x.facts.map(f => '<div class="ag-fact"><span>' + esc(f[0]) + '</span><span class="mono">' + esc(f[1]) + '</span></div>').join('') + '</div>' : '') +
      '<div class="ag-dmore" aria-hidden="true">more below</div>';
    put(d, 'className', 'ag-drawer t-' + x.tone + (d.classList.contains('ag-more') ? ' ag-more' : ''));
    setHtml(d, html);
    put(d, 'hidden', false);
    placeDrawer();
  }
  /* where the drawer sits over the right column: never over an open proposal (its Accept and Reject stay in sight), and
     above the last part of the stream when there is room, so the row it shows stays in sight and a second click on it
     closes it. Worked out when it opens, when a proposal comes or goes and when the column changes size (no timer). */
  function placeDrawer(reveal) {
    const d = q('[data-k="drawer"]'), col = q('.ag-right'), prop = q('[data-panel="prop"]'), feedBox = q('[data-k="feed"]');
    if (!d || d.hidden || !col) { if (feedBox && feedBox.style.paddingTop) feedBox.style.paddingTop = ''; return; }
    const H = col.clientHeight, open = [...cards.values()].some(x => x.p.agent === S.chosen && !x.ended);
    const top = open && prop ? prop.offsetTop + prop.offsetHeight + 8 : 0;
    let bottom = Math.max(150, Math.round(H * 0.38));
    if (H - top - bottom < 220) bottom = 0;
    d.style.top = top + 'px'; d.style.bottom = bottom + 'px';
    const row = feedBox && S.drawer ? feedBox.querySelector('[data-row="' + CSS.escape(S.drawer) + '"]') : null;
    /* the stream's rows start below the drawer while it is open, so even the newest row (or a short list) can be in sight */
    const fr = feedBox ? feedBox.getBoundingClientRect() : null, dr = d.getBoundingClientRect();
    const under = fr && bottom ? Math.max(0, Math.round(dr.bottom + 4 - fr.top)) : 0;
    if (feedBox) feedBox.style.paddingTop = under ? under + 'px' : '';
    if (reveal === true && row && bottom) {                    // on opening or a new size: the row in sight, below the drawer
      const rr = row.getBoundingClientRect(), from = Math.max(fr.top, dr.bottom + 4);
      if (rr.top < from || rr.bottom > fr.bottom) feedBox.scrollTop += rr.top - from;
    }
    moreBelow();
  }
  /* "more below" while the drawer holds more than it shows (its scroll, no timer) */
  function moreBelow() { const d = q('[data-k="drawer"]'); if (d) tog(d, 'ag-more', !d.hidden && d.scrollTop + d.clientHeight < d.scrollHeight - 2); }
  /* While the tab is shown, what floats over the page sits over its chart, the one part of the tab with no control of its own
     (the chart takes no orders): the corner notices (the page's, or the Bot tab's when it is there) stack in its lower left,
     above its time axis, and the workspace's ChartBridge line (its warnings and errors, until dismissed) lies across its top.
     So neither covers a control, the rules, the proposal, its Accept and Reject, the stream or the footer at any size (a
     phone too: they scroll with the chart), and a ChartBridge line coming or going moves nothing in the tab (it pushed the
     whole tab down 46 px before). Both go back where the page keeps them when the tab closes. Moved only when needed. */
  const alertsEl = popout ? null : document.getElementById('wsAlerts');
  const alertsHome = alertsEl ? { parent: alertsEl.parentNode, next: alertsEl.nextSibling } : null;
  /* Narrower than 1100 px the chart sits far down the tab (the review of 7bca487: the line at 989 px at 1000 x 800, 1299 px on
     a phone), so there both are pinned at the top instead, in a band of a fixed height above the tab's scrolling part (the
     tray): always in sight, covering nothing, and their coming and going moves nothing. */
  const NARROW = typeof matchMedia === 'function' ? matchMedia('(max-width: 1100px)') : null;
  function placeNotes() {
    const over = view ? q(NARROW && NARROW.matches ? '[data-k="tray"]' : '[data-k="over"]') : null, main = view ? q('[data-k="main"]') : null;
    const inTab = !!(S.shown && over && main && !main.hidden);
    const host = inTab ? over : document.body;
    if (notes.parentElement !== host) host.appendChild(notes);
    tog(notes, 'ag-in-tab', inTab);
    if (alertsEl) {
      if (inTab && alertsEl.parentElement !== over) over.prepend(alertsEl);
      else if (!inTab && alertsEl.parentElement !== alertsHome.parent) alertsHome.parent.insertBefore(alertsEl, alertsHome.next && alertsHome.next.parentNode === alertsHome.parent ? alertsHome.next : null);
      tog(alertsEl, 'ag-in-tab', inTab);
    }
  }
  if (view && NARROW) { if (NARROW.addEventListener) NARROW.addEventListener('change', placeNotes); else if (NARROW.addListener) NARROW.addListener(placeNotes); }
  let resizeObs = null;
  if (view && typeof ResizeObserver === 'function') {
    resizeObs = new ResizeObserver(() => placeDrawer(true));   // a new size: the open row back in sight
    for (const el of [q('.ag-right'), q('[data-panel="prop"]')]) if (el) resizeObs.observe(el);
  }

  /* ---------------- the light, the tracker, the chart's position and the footer: worked out again on each message */
  /* the open P&L: NinjaTrader's unrealized for the agent's own account (when it holds nothing else there), else from the chart's
     last price on the position's root; null when neither is known (never estimated further) */
  function openPnl(a) {
    const pos = a && a.position; if (!pos || !isNum(pos.qty) || !pos.qty) return null;
    const accs = S.accounts && Array.isArray(S.accounts.list) ? S.accounts.list : [], acc = accs.find(x => x && x.name === AC.agentAccount(a).name);
    if (acc && isNum(acc.unrealized) && (!Array.isArray(acc.positions) || acc.positions.every(p => p && p.root === pos.root))) return acc.unrealized;
    const c = S.chart && S.chartRoot === pos.root && S.chart.chart && typeof S.chart.chart.bars === 'function' ? S.chart.chart.bars() : null;
    const last = c && c.length ? c[c.length - 1].c : null, pv = pointValue(pos.root);
    return isNum(last) && isNum(pos.avgPrice) && pv ? Math.round((last - pos.avgPrice) * pos.qty * pv * 100) / 100 : null;
  }
  function lightNow(a) {
    const open = props.open(a.agent).map(p => Object.assign({}, p, { answered: props.answered(p.agent, p.id) }));
    const items = feed.items(a.agent, 'all');
    return AC.lightState({ agent: a, notes: items.filter(x => x.type === 'note').map(x => x.m), plans: items.filter(x => x.type === 'plan').map(x => x.m), open,
      ends: S.propEnds.filter(e => e.agent === a.agent), workingEntry: AC.workingEntries(S.orders.values(), a).length > 0,
      exits: S.exits.get(a.agent) || [], openPnl: openPnl(a), now: Date.now() });
  }
  function renderLive() {
    if (!view) return;
    const a = cur(); if (!a) return;
    const L = lightNow(a), main = q('[data-k="main"]');
    /* the light: its colour on the tab (a registered colour, so the change fades), the lit panels, its lap */
    const sig = [L.phase, L.tone, L.panels.join(','), L.lapMs, L.step, L.said].join('|');
    if (sig !== S.lightSig) {
      S.lightSig = sig;
      /* the colour goes only on what draws with it (agent.css: not inherited), so a change restyles a few elements */
      if (L.color !== S.lightColor) {
        S.lightSlot = S.lightColor ? 1 - S.lightSlot : 0; S.lightColor = L.color;
        for (const p of view.querySelectorAll('.ag-panel[data-panel]')) p.style.setProperty('--ag-to', L.color);   // the glow fades to it (--ag-pc)
        for (const l of view.querySelectorAll('.ag-light')) { l.style.setProperty('--ag-c' + S.lightSlot, L.color); tog(l, 'ag-c1', S.lightSlot === 1); }   // the light crossfades: the new colour in its other copy
        q('[data-k="said"]').style.setProperty('--ag-tone', L.color);   // the tracker's words: at once
      }
      main.style.setProperty('--ag-lap', L.lapMs + 'ms');
      attr(main, 'data-phase', L.phase); attr(main, 'data-tone', L.tone);
      for (const el of view.querySelectorAll('.ag-panel[data-panel]')) tog(el, 'lit', L.panels.includes(el.dataset.panel));
      put(q('[data-k="said"]'), 'textContent', L.said);
      for (const li of q('[data-k="steps"]').children) { const i = +li.dataset.step; tog(li, 'done', L.step >= 0 && i < L.step); tog(li, 'now', i === L.step); attr(li, 'aria-current', i === L.step ? 'step' : null); }
    }
    /* the chart's header: the position and its open P&L, at once (R3) */
    const pos = a.position && isNum(a.position.qty) && a.position.qty ? a.position : null, op = pos ? openPnl(a) : null;
    put(q('[data-k="cPos"]'), 'textContent', pos ? AC.positionText(pos, (p, r) => fmtPx(p, r)).toLowerCase() : 'flat');
    const cp = q('[data-k="cPnl"]'); put(cp, 'textContent', pos ? (op === null ? '-' : AC.fmtUsd(op) || '$0.00') : '');
    put(cp, 'className', 'ag-cpnl mono' + (op === null ? '' : op >= 0 ? ' pos' : ' neg'));
    renderFoot(a, pos, op);
  }
  function renderFoot(a, pos, op) {
    const m = AC.stripModel(a, S.orders.values(), (p, r) => fmtPx(p, r));
    const pnl = q('[data-k="sPnl"]'); put(pnl, 'textContent', m.pnl); put(pnl, 'className', 'mono ag-today ' + m.pnlTone);
    put(q('[data-k="todayNote"]'), 'textContent', pos ? 'Today · open ' + (op === null ? '-' : AC.fmtUsd(op) || '$0.00') : 'Today');
    const of = (el, t) => { const i = String(t).indexOf(' of '); setHtml(el, i < 0 ? esc(t) : esc(t.slice(0, i)) + ' <small>of ' + esc(t.slice(i + 4)) + '</small>'); };
    of(q('[data-k="sTrades"]'), m.trades); of(q('[data-k="sLosses"]'), m.losses);
    renderTrail(a);
  }
  /* his session as a light trail, entryFrom to flatAt: his fills (F in, X out, green or red by the trade's result) */
  function renderTrail(a) {
    const t = dayTrades(a.agent), exitAt = new Map(t.exits.map(e => [e.tOut, e]));
    const ev = [];
    for (const f of t.fills) {
      const x = exitAt.get(f.u);
      ev.push(x ? { at: f.u, mark: 'X', tone: isNum(x.pnl) && x.pnl < 0 ? 'no' : 'bridge', title: 'Out of ' + x.qty + ' ' + x.root + ' at ' + fmtPx(x.pOut, x.root) + (isNum(x.pnl) ? ', ' + (AC.fmtUsd(x.pnl) || '$0.00') : '') }
        : { at: f.u, mark: 'F', tone: 'bridge', title: (f.side === 'buy' ? 'Bought ' : 'Sold ') + f.qty + ' ' + f.root + ' at ' + fmtPx(f.p, f.root) });
    }
    const T = AC.sessionTrail(a.rules, Date.now(), ev), now = T.nowPct === null ? 0 : T.nowPct;
    setHtml(q('[data-k="trail"]'), '<div class="ag-track"><div class="ag-base"></div><div class="ag-done" style="width:' + now + '%"></div>' +
      T.hours.map((h, i) => '<span class="ag-hour mono' + (i && i < T.hours.length - 1 ? ' mid' : '') + '" style="left:' + h.pct + '%">' + esc(h.label) + '</span>').join('') +
      '<span class="ag-head" style="left:' + now + '%" title="Now"></span>' +            // under the marks: a fill a moment ago still shows
      T.marks.map(x => '<span class="ag-ev t-' + x.tone + ' mono" style="left:' + x.pct + '%" title="' + esc(x.title) + '">' + esc(x.mark) + '</span>').join('') + '</div>');
  }
  /* his account's room (the Account page's figures: ChartBridge's, else The Desk's limits; never estimated) */
  function renderRoom(a) {
    const name = AC.agentAccount(a).name, accs = S.accounts && Array.isArray(S.accounts.list) ? S.accounts.list : [], acc = accs.find(x => x && x.name === name) || null;
    const lim = V3 && typeof V3.limit === 'function' ? V3.limit(name) : acc && window.AccountsCore ? window.AccountsCore.limitState(acc, null) : null;
    const lines = AC.roomLines(acc, lim);
    setHtml(q('[data-k="room"]'), '<div class="ag-lbl">Room left</div>' + lines.map(l => '<div class="ag-roomline" data-no-motion><div class="ag-roomrow"><span>' + esc(l.label) + '</span><span class="mono ag-hot">' +
      (l.room !== null ? esc(AC.fmtUsd(l.room).replace(/^\+/, '')) + (l.limit ? ' <small>of ' + esc(AC.fmtUsd(l.limit).replace(/^\+/, '')) + '</small>' : '') : '<small' + (l.said ? ' title="' + esc(l.said) + '"' : '') + '>' + esc(l.why) + '</small>') + '</span></div>' +
      (l.leftPct !== null ? '<div class="ag-meter2' + (l.key === 'dl' ? ' pu' : '') + '"><i style="width:' + l.leftPct + '%"></i></div>' : '') + '</div>').join(''));
  }
  /* the Motion switch: Full moves the light, Off keeps it still (the glow stays); the system's reduced motion keeps it still too */
  function renderMotion() {
    if (!view) return;
    tog(view, 'ag-still', S.motion === 'off');
    for (const b of view.querySelectorAll('button[data-motion]')) attr(b, 'aria-pressed', String(b.dataset.motion === S.motion));
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
  /* a short "Sent." under a button, gone after a few seconds unless something else was written there since */
  function sentLine(k, t) {
    const el = q('[data-k="' + k + '"]'); if (!el) return;
    put(el, 'textContent', t);
    setTimeout(() => { if (el.textContent === t) put(el, 'textContent', ''); }, 6000);
  }
  function others() { return { bot: S.bot, copier: S.copier, agents: agents.list() }; }
  function ctxNow(a) { return { workingEntry: AC.workingEntries(S.orders.values(), a).length > 0, openProposals: props.open(a.agent).length, roots: servedRoots(), version: S.version, askedMode: S.acctAsk ? S.acctAskMode : a.mode }; }
  function sendAccount(name) {
    const a = cur(); if (!a) return;
    const r = AC.accountChange(a, name, AC.accountChoices(S.accounts, a, others()), ctxNow(a));
    if (r.error) { put(q('[data-k="acctWhy"]'), 'textContent', r.error); return; }
    if (sendAgent(r.msg, 'account')) { S.acctEdit = false; S.acctAsk = ''; sentLine('acctWhy', r.msg.keepMode ? 'Sent: its mode (' + AC.MODE_NAME[r.msg.keepMode] + ') is kept.' : 'Sent: it goes to Shadow (ChartBridge before 0.5.2).'); }
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
    if (sendAgent(r.msg, 'rules')) { S.rulesEdit = false; rulesWhy(''); sentLine('rulesWhy', 'Sent.'); }
    renderPanel();
  }
  function onViewClick(e) {
    const t = e.target, a = cur();
    const mode = t.closest('[data-mode]'), act = t.closest('[data-act]'), flt = t.closest('[data-filter]'), row = t.closest('button[data-row]'), mo = t.closest('button[data-motion]');
    const go = t.closest('button[data-goto]');
    if (go) { goTo(go.dataset.goto); return; }
    if (flt) { S.feedFilter = flt.dataset.filter; writeJson(KEYS.feed, { filter: S.feedFilter }); renderFeed(); return; }
    if (row) { openDrawer(row.dataset.row); return; }
    if (mo) { S.motion = AC.setMotionPref(storage, mo.dataset.motion); renderMotion(); return; }
    if (act && act.dataset.act === 'drawerClose') { closeDrawer(); return; }
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
      // instant on, always; release with a second click within 4 s (it lets the agent trade again). A click within 1 s of a
      // kill-on is the same press (a double click): nothing more is sent, and it never arms the release either
      if (AC.killOnRepeat(S.killOnAt, Date.now())) return;
      if (!a.killed) { S.killOnAt = Date.now(); sendAgent(AC.killMsg(a.agent, true), 'kill'); return; }
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
      if (!list.some(c => c.ok)) put(q('[data-k="acctWhy"]'), 'textContent', 'No other account is free and tradable: check one on the Accounts tab.');
      renderPanel(); sel.focus();
    } else if (k === 'acctCancel' || k === 'acctNo') { S.acctEdit = false; S.acctAsk = ''; put(q('[data-k="acctWhy"]'), 'textContent', ''); renderPanel(); }
    else if (k === 'acctSave') {
      const name = q('[data-k="acctSel"]').value;
      const r = AC.accountChange(a, name, AC.accountChoices(S.accounts, a, others()), ctxNow(a));
      if (r.error) { put(q('[data-k="acctWhy"]'), 'textContent', r.error); return; }
      if (r.live) { S.acctAsk = name; S.acctAskMode = a.mode; put(q('[data-k="acctWhy"]'), 'textContent', ''); renderPanel();   // the mode recorded once, as the question opens
        const y = q('[data-act="acctYes"]'); if (y) y.focus(); return; }   // asked once, in the page
      sendAccount(name);
    } else if (k === 'acctYes') {
      if (!S.acctAsk) return;
      const stale = AC.askStale(S.acctAskMode, a);   // checked again at the click (an agent message may not have redrawn yet)
      if (stale) { S.acctAsk = ''; S.acctAskMode = ''; put(q('[data-k="acctWhy"]'), 'textContent', stale); renderPanel(); return; }
      sendAccount(S.acctAsk);
    }
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
    /* Escape closes the drawer only while the focus is inside it: no keydown handler on the document, so the page's order
       hotkeys and its own Escape (menus, dialogs) are never touched */
    const dr = q('[data-k="drawer"]');
    if (dr) dr.addEventListener('scroll', moreBelow, { passive: true });
    if (dr) dr.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.defaultPrevented && !e.isComposing) { e.preventDefault(); closeDrawer(); } });
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
    placeNotes();
    seenNow();
  }
  if (tabBtn) tabBtn.addEventListener('click', () => showTab(!S.shown));

  if (popout) S.shown = true;
  renderMotion();
  const unlisten = V3 ? V3.listen({ message: onMessage, closed: () => lost() }) : () => {};
  render();
  placeNotes();
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
    /** the agent that owns (account, root) by ChartBridge's owner lock, or '' (the order ticket refuses a resting order there) */
    ownerOf: (account, root) => AC.pairOwner(agents.list(), S.orders.values(), account, root),
    answer: (agent, id, ans) => answer(agent, id, ans),
    /* read only, for the tests and the console */
    state: () => ({ v3: S.v3, version: S.version, signedIn: S.signedIn, shown: S.shown, chosen: S.chosen, agents: agents.list().map(a => Object.assign({}, a)),
      proposals: [...cards.values()].map(x => ({ agent: x.p.agent, id: x.p.id, ended: !!x.ended })),
      others: otherCounts().map(x => ({ key: x.key, name: x.name, n: x.n })), corner: cornerLine && !cornerLine.hidden ? cornerLine.textContent : '', offText: AC.offText(offCtx()),
      feed: S.chosen ? feed.counts(S.chosen) : { notes: 0, plans: 0 }, light: cur() ? lightNow(cur()) : null, drawer: S.drawer, motion: S.motion, chart: !!S.chart, chartRoot: S.chartRoot, orders: [...S.orders.values()].map(x => ({ id: x.id, by: x.by, role: x.role, root: x.root })), trips: trips() }),
    chart: () => (S.chart ? S.chart.chart : null),
    destroy() { unlisten(); unroute(); unmountChart(); if (resizeObs) resizeObs.disconnect(); clearTimeout(othersTimer); S.shown = false; placeNotes(); if (propBox) propBox.classList.remove('ag-hide'); document.body.classList.remove('ag-agents'); if (cornerLine) cornerLine.remove(); clearTimeout(timer); },
  };
  return api;
}

window.AgentDesk = { create, VERSION };
})();
