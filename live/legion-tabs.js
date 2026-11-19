/*
 * LegionTabs (plan step 3.2): the tabs that moved from the chart page into Legion, mounted on Legion's page with the same
 * modules and the same gates the chart page gave them (live/workspace.js until this step). Nothing in them is rewritten:
 *   - Cohorts, "The cohorts": the chart page's Legion tab (FleetView, live/fleet.js) whole: the lanes (the Multi-Account panel on
 *     FleetCore.laneFeed, one fixed group), the roster, the traders and Legion's trader desk (live/legion-desk.js), Legion Live
 *     (a real chart, the Account page's own rows). Its connection is the one the chart page made: listen, and post only what
 *     FleetCore.maySend passes.
 *   - Cohorts, "Praetorian": the chart page's Agent tab for your personal account (AgentDesk, live/agent.js), embedded, behind
 *     Praetorian's gate (AgentCore.praetorianLink), as the chart page and agent.html hand it.
 *   - Colosseum: the chart page's Colosseum (LeagueView, live/league.js) whole: The Desk's GET /api/chart-league, and the watch box
 *     on a listen-only connection (no post at all).
 * "Flatten and turn him off" on either desk is one ChartBridge command (agentFlattenOff, sent by live/agent.js) when ChartBridge knows it, so a closed
 * page never leaves it half done; with an older ChartBridge the desk says where to flatten (this page has no order ticket and sends no order of its own).
 * The chart page keeps Chart, the Bot tab and the bot strip.
 */
(function () {
'use strict';
if (typeof window === 'undefined' || typeof document === 'undefined') return;
const $ = id => document.getElementById(id);

/* the Account page's rows-only mount reads the feed and sends nothing: every function but the reading ones answers false
   without calling the feed (the chart page's readOnlyFeed, the review of 97, F8) */
const FEED_READS = new Set(['account', 'limit', 'groupOf', 'rulesOf', 'typeOf', 'level', 'listen', 'joinRefusal', 'joinPlan', 'joinWords', 'readTypes', 'readFloors', 'firmMins', 'rateOf']);
function readOnlyFeed(feed) {
  const out = {};
  for (const k of Object.keys(feed)) {
    const d = Object.getOwnPropertyDescriptor(feed, k);
    if (d.get) Object.defineProperty(out, k, { enumerable: true, get: () => feed[k] });
    else if (typeof feed[k] !== 'function') Object.defineProperty(out, k, { enumerable: true, get: () => feed[k] });
    else out[k] = FEED_READS.has(k) ? (...a) => feed[k](...a) : () => false;
  }
  return Object.freeze(out);
}
function fitPanel(v, classes) {
  if (typeof ResizeObserver !== 'function' || !v || !v.el) return () => {};
  const ro = new ResizeObserver(list => { for (const e of list) { const r = e.contentRect, k = classes(r.width, r.height); for (const c of Object.keys(k)) v.el.classList.toggle(c, !!k[c]); } });
  ro.observe(v.el);
  return () => ro.disconnect();
}
const U = window.ChartEngine && window.ChartEngine.util ? window.ChartEngine.util : null;
const etNowSec = () => (U && typeof U.zoneSeconds === 'function' ? U.zoneSeconds(Date.now() / 1000) : Date.now() / 1000);

function mount(env) {
  const { AF, hub, store, PREFIX, PIN, realClick, hooks, mounted, guard, say } = env;
  const headers = () => (PIN ? PIN.headers() : {});
  const note = (t, w) => { if (w) say(t, true); };
  /* the redraw loop of the panels mounted from here (the chart page's renderAccountPages): each second, and at each change */
  const panels = new Map();
  let raf = 0;
  const redraw = () => { if (raf || !panels.size) return; raf = requestAnimationFrame(() => { raf = 0; for (const p of panels.values()) { try { p.render(); } catch (e) { /* its own */ } } }); };
  setInterval(redraw, 1000);
  hooks.message.push(m => { if (!m) redraw(); });
  /* no price lines on this page: the rows read ChartBridge's own figures (pnlToday, room); an open position's price is on the chart page */
  const quoteSubs = new Set(), watchQuote = () => () => {}, quoteOf = () => null;
  const host = { watchQuote, quoteOf, quoteSubs, fitPanel, note, now: etNowSec };

  /* ---------------- Cohorts: the chart page's Legion tab */
  let fleet = null, legionDesk = null;
  guard('the cohorts', () => {
    if (!window.FleetView || !$('flView')) return;
    const FC = window.FleetCore;
    const gate = FC && Object.isFrozen(FC) ? FC.maySend : null;
    const legionLink = AF && gate ? { listen: part => AF.listen(part), post: m => gate(m) === true && AF.post(m) === true } : null;
    const AH = window.AgentHelper;
    const helper = AH && typeof AH.createClient === 'function' && typeof fetch === 'function' ? AH.createClient({ fetch: (u, i) => fetch(u, i), headers }) : null;
    const lanes = new Map();
    $('flView').innerHTML = '';
    fleet = window.FleetView.create({ view: $('flView'), tab: null, v3: legionLink, realClick, headers,
      helperStatus: helper ? () => helper.status() : null,
      liveChart: el => (window.ChartLive && hub ? window.ChartLive.mount(el, { feed: hub, paneId: 'legion', storagePrefix: PREFIX, toolbar: false, compact: true, view: { root: 'MNQ', tf: 'm1' } }) : null),
      accountRows: (el, key, filter) => {
        if (!AF || !window.AccountsPage || !el || typeof filter !== 'function' || panels.has(key)) return null;
        const body = document.createElement('div'); el.appendChild(body);
        const ap = window.AccountsPage.mount({ el, body, head: document.createElement('div') }, Object.assign({ feed: readOnlyFeed(AF), rows: { filter } }, host));
        panels.set(key, ap); redraw();
        return { destroy: () => { if (panels.get(key) === ap) { panels.delete(key); ap.destroy(); } } };
      },
      sessionStart: () => { const n = etNowSec(); return n - ((((n - 18 * 3600) % 86400) + 86400) % 86400); },
      /* a lane: the Multi-Account panel showing one group, on the narrow feed (FleetCore.laneFeed), never the whole feed */
      lanePanel: (el, key, opts) => {
        if (!FC || !AF || !window.MultiAccount || !el || !opts || typeof opts.group !== 'string' || !opts.group || typeof opts.locked !== 'function' || panels.has(key)) return null;
        const feed = FC.laneFeed(AF, opts.locked, opts.group, opts.otherLocked);
        const AC = window.AccountsCore;
        const ma = window.MultiAccount.mount(el, { feed, panelId: key, note, group: opts.group, locked: opts.locked,
          working: () => [...feed.S.orders.values()].filter(o => (AC && typeof AC.isWorking === 'function' ? AC.isWorking(o) : true)) });
        panels.set(key, ma); lanes.set(key, ma); redraw();
        return { panel: ma, refused: feed.refused, feed, destroy: () => { if (panels.get(key) === ma) { panels.delete(key); lanes.delete(key); ma.destroy(); } } };
      },
      traderDesk: el => (window.LegionDesk && typeof window.LegionDesk.mount === 'function' && el
        ? (legionDesk = window.LegionDesk.mount(el, { v3: AF, feed: hub, headers, storage: store, storagePrefix: PREFIX }))
        : null),
      onTab: () => {} });
    mounted.cohorts = true;
  });

  /* ---------------- Cohorts: Praetorian, the Agent tab for your personal account */
  let praetorian = null;
  guard('Praetorian', () => {
    if (!window.AgentDesk || !$('agView')) return;
    const AC = window.AgentCore;
    const link = AF && AC && typeof AC.praetorianLink === 'function' ? AC.praetorianLink(AF) : null;   // no gate: no connection (the careful side)
    $('agView').innerHTML = '';
    praetorian = window.AgentDesk.create({ embedded: true, keyPrefix: '', keys: false, v3: link, headers, feed: hub, storage: store, storagePrefix: PREFIX,
      els: { view: $('agView') } });
    mounted.praetorian = true;
  });

  /* ---------------- Castra and the cohort model (plan step 3.3): read only but for the cohort model's drag and drop (PUT to The Desk, never to
     ChartBridge). Both read The Desk through the one address (AccountsPage.deskBase); what only this PC knows (the traders, the prop accounts'
     room to the floor and day) is read from FleetView's own state, once a second at most: never a second reader. */
  const deskBase = () => window.AccountsPage.deskBase((u, o) => fetch(u, o));
  let liveAt = 0, liveCache = null;
  const fleetLive = () => {
    if (!fleet) return null;
    const t = Date.now();
    if (t - liveAt < 800) return liveCache;
    liveAt = t;
    try { const s = fleet.state(); liveCache = s.connected ? { traders: s.traders, accounts: s.accounts, heard: !!(s.arm && s.arm.state !== 'unknown') } : null;    /* heard: the traders are known (ChartBridge's replay after sign-in is done); with accounts but no traders every cohort would read not in Auto */ } catch (e) { liveCache = null; }
    return liveCache;
  };
  const openTab = id => { const b = document.querySelector('[data-lx-tab="' + id + '"]'); if (b) b.click(); };
  let castra = null;
  guard('Castra', () => {
    if (!window.LegionCastra || !$('cxView')) return;
    $('cxView').innerHTML = '';
    castra = window.LegionCastra.mount($('cxView'), { fetch: (u, o) => fetch(u, o), deskBase, live: fleetLive, go: openTab });
    mounted.castra = !!castra;
  });
  let cohortModel = null;
  guard('the cohort model', () => {
    if (!window.LegionCohorts || !$('chView')) return;
    /* the Drone sky's providers: the Agent desks' glances (Praetorian's and the trader desk's), the league's day (read by the view), and no price
       line on this page (no quote: the sky says "not reported" for an open trade's R; an open position's price is on the chart page) */
    const glancesOf = d => (d && typeof d.glances === 'function' ? d.glances() : []);
    const sky = { agents: () => glancesOf(praetorian).concat(glancesOf(legionDesk && legionDesk.agent)).map(g => ({ a: g.agent, g })),
      nowMs: () => etNowSec() * 1000, zoneSec: ms => (U && typeof U.zoneSeconds === 'function' ? U.zoneSeconds(ms / 1000) : ms / 1000),
      last: () => null, pv: r => ({ MNQ: 2, NQ: 20 }[r] || null), bars: () => null, mine: () => [], bot: () => null,
      openLeague: () => openTab('colosseum'), openAgent: () => {}, openBot: () => {} };
    $('chView').innerHTML = '';
    cohortModel = window.LegionCohorts.mount($('chView'), { fetch: (u, o) => fetch(u, o), deskBase, live: fleetLive, sky });
    mounted.cohortModel = !!cohortModel;
  });

  /* ---------------- Colosseum: the chart page's Colosseum */
  let league = null;
  guard('the Colosseum', () => {
    if (!window.LeagueView || !$('lgView')) return;
    const watch = AF ? Object.freeze({ listen: part => AF.listen(part) }) : null;   // listen only: nothing on the Colosseum can send
    $('lgView').innerHTML = '';
    league = window.LeagueView.create({ view: $('lgView'), tab: null, feed: hub, storagePrefix: PREFIX, watch,
      deskBase: () => window.AccountsPage.deskBase((u, o) => fetch(u, o)), fetch: (u, o) => fetch(u, o),
      /* a past day in the address (?tab=colosseum&day=YYYY-MM-DD; The Desk's Agent Stats links), so a reload keeps it */
      onDay: d => { try { const u = new URL(location.href); if (d) u.searchParams.set('day', d); else u.searchParams.delete('day'); history.replaceState(null, '', u.pathname + '?' + u.searchParams.toString() + u.hash); } catch (e) { /* file: */ } },
      onTab: () => {} });
    mounted.colosseum = true;
  });

  /* ---------------- Ludus (plan step 3.4): Pipeline, Board, Builder, Seeds, Agents and the build page (live/ludus.js), read only:
     The Desk's reads through its one address (AccountsPage.deskBase), the PC helper's builds, one trade on chart-engine's own chart.
     No connection to ChartBridge is handed to it. */
  let ludus = null;
  guard('the Ludus', () => {
    if (!window.LudusView || !$('ldView')) return;
    const AH = window.AgentHelper;
    $('ldView').innerHTML = '';
    ludus = window.LudusView.mount($('ldView'), { fetch: (u, o) => fetch(u, o), deskBase: () => window.AccountsPage.deskBase((u, o) => fetch(u, o)),
      helper: AH && typeof AH.createClient === 'function' && typeof fetch === 'function' ? AH.createClient({ fetch: (u, i) => fetch(u, i), headers }) : null,
      chart: window.ChartEngine || null });
    mounted.ludus = !!ludus;
  });

  /* each part is shown only while its tab (and side) is: a hidden one reads nothing and acknowledges nothing */
  let dayAsked = false;
  hooks.tab.push((tab, sub) => {
    if (fleet) guard('the cohorts', () => fleet.showTab(tab === 'cohorts' && sub === 'legion'));
    if (praetorian) guard('Praetorian', () => praetorian.showTab(tab === 'cohorts' && sub === 'praetorian'));
    if (ludus) guard('the Ludus', () => ludus.show(tab === 'ludus'));
    if (castra) guard('Castra', () => castra.show(tab === 'castra'));
    if (cohortModel) guard('the cohort model', () => cohortModel.show(tab === 'cohorts' && sub === 'legion'));
    if (league) guard('the Colosseum', () => {
      if (tab !== 'colosseum') { league.showTab(false); return; }
      if (!dayAsked) { dayAsked = true; league.openDay(new URLSearchParams(location.search).get('day')); }   // a day checked first: a past one read only
      else league.showTab(true);
    });
  });
  window.LegionTabs.state = () => ({ cohorts: fleet ? fleet.state() : null, praetorian: praetorian ? praetorian.state() : null, colosseum: league ? league.state() : null, ludus: ludus ? ludus.state() : null, castra: castra ? castra.state() : null, cohortModel: cohortModel ? cohortModel.state() : null });
  window.LegionTabs.parts = { fleet, praetorian, league, ludus, castra, cohortModel };
}

window.LegionTabs = { mount, readOnlyFeed };
})();
