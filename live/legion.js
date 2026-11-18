/*
 * Legion, the app for bots and agents (plan step 3.2, the lock of 2026-11-15, topic 6; Anthony 2026-11-16: "the entire
 * automation system, as its own stand alone page (app) not attached to my trading charts"). Its own page, legion.html, served by
 * ChartBridge on each trading PC from its www folder like the chart page, behind the same PIN (pin.js), on the window's own
 * connections. The Imperial look of the Legion mockup (version 8): cut corners, gold and bronze, no purple, Roman numerals.
 *
 * Five tabs, each with Stop all automation in the one header above them (law 9.3):
 *   I    Castra     home: running now, Needs you, last night, today. Its content is not built yet (said on the tab).
 *   II   Cohorts    the prop account groups, the roster, the traders. Today: the chart page's Legion tab (live/fleet.js), moved
 *                   here whole, and Praetorian's Agent side (live/agent.js, your personal account), as they were.
 *   III  Colosseum  the league's live check, one leaderboard. Today: the chart page's Colosseum (live/league.js), moved here whole.
 *   IV   Ludus      Pipeline, Board, Builder, Seeds, Agents and the build page. Not built yet (said on the tab).
 *   V    Go live    a build's live check and the GO with its size. Not built yet (said on the tab).
 * The chart page keeps Chart, the Bot tab and the bot strip.
 *
 * STOP ALL AUTOMATION. One button in the header of every tab. It asks first in the page (two buttons, no browser dialog), takes a
 * real click on Yes only (OrderTicket.realClick, the page's one rule), never in the first ARM_MS after it opens (a double click
 * answers nothing) and never after CONFIRM_MS by the clock; Escape and Cancel close it. Then one message to ChartBridge, which does
 * the whole of it itself, so a page closed a moment later never leaves it half done:
 *   - stopAllAutomation (the ChartBridge that knows it, STOPALL_MIN): every bot and agent on a prop account, found by ChartBridge's
 *     own rule AND by the account ledger The Desk serves (each account it types eval or funded), so an account NinjaTrader lists
 *     as a simulator is still covered (law 9.3, item 113). Each such trader: the kill switch on, Shadow, its own flatten. A trader
 *     that also trades your personal account loses its prop seats for the session (no new entry there, its own flatten there) and
 *     keeps the personal one. Your personal account, the chart's Bot tab and the copier are never touched.
 *   - agentKillAllProp, with an older ChartBridge (0.6.17 to the one before STOPALL_MIN): ChartBridge's reviewed Kill all, by its
 *     own prop rule only. The header says so plainly: the ledger's accounts are not covered until the newer ChartBridge.
 * The header's connection may send those two messages and no other (LegionCore.stopMaySend, put in front of the connection).
 *
 * Two parts, as fleet.js: LegionCore (pure: Node tests, test/legion.test.js) and, in a browser, LegionApp (the page).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LegionCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* the five tabs, in Anthony's order, each with its Roman numeral (the mockup's nav) */
const TABS = Object.freeze([
  Object.freeze({ id: 'castra', name: 'Castra', rn: 'I' }),
  Object.freeze({ id: 'cohorts', name: 'Cohorts', rn: 'II' }),
  Object.freeze({ id: 'colosseum', name: 'Colosseum', rn: 'III' }),
  Object.freeze({ id: 'ludus', name: 'Ludus', rn: 'IV' }),
  Object.freeze({ id: 'golive', name: 'Go live', rn: 'V' }),
]);
const TAB_IDS = TABS.map(t => t.id);
/* the addresses the chart page used for the tabs that moved here, and where each lands (a bookmark or The Desk's Agent Stats
   link keeps working: ?tab=league&day= opens the Colosseum on that day) */
const OLD_TABS = Object.freeze({ legion: ['cohorts', 'legion'], fleet: ['cohorts', 'legion'], league: ['colosseum', ''], agent: ['cohorts', 'praetorian'], praetorian: ['cohorts', 'praetorian'] });
const COHORT_SUBS = ['legion', 'praetorian'];

/** Roman numerals 1 to 3999 (the mockup's cohort and station numbers); '' for anything else. */
function roman(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 1 || n > 3999 || Math.floor(n) !== n) return '';
  const t = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
}

/** The tab and the Cohorts side an address names: { tab, sub }. Unknown or none: Castra, the home tab. */
function tabFrom(search) {
  let q;
  try { q = new URLSearchParams(typeof search === 'string' ? search : ''); } catch (e) { q = new URLSearchParams(''); }
  const t = String(q.get('tab') || '').toLowerCase(), s = String(q.get('sub') || '').toLowerCase();
  if (TAB_IDS.includes(t)) return { tab: t, sub: t === 'cohorts' && COHORT_SUBS.includes(s) ? s : t === 'cohorts' ? 'legion' : '' };
  if (Object.prototype.hasOwnProperty.call(OLD_TABS, t)) return { tab: OLD_TABS[t][0], sub: OLD_TABS[t][1] };
  return { tab: 'castra', sub: '' };
}

/** The address for a tab (kept on a reload): the page's own query, with tab (and sub on Cohorts) set and nothing else changed. */
function tabSearch(search, tab, sub) {
  let q;
  try { q = new URLSearchParams(typeof search === 'string' ? search : ''); } catch (e) { q = new URLSearchParams(''); }
  q.set('tab', TAB_IDS.includes(tab) ? tab : 'castra');
  if (tab === 'cohorts' && COHORT_SUBS.includes(sub)) q.set('sub', sub); else q.delete('sub');
  if (tab !== 'colosseum') q.delete('day');                      // a past league day belongs to the Colosseum only
  return '?' + q.toString();
}

/* ---------------- Stop all automation */
const KILL_MIN = '0.6.17';       // ChartBridge's Kill all for the prop accounts (agentKillAllProp)
/* The ChartBridge that knows stopAllAutomation and agentFlattenOff. This branch does not bump ChartBridge's version (the release
   that carries it names the number and sets this to it); until then no installed ChartBridge reports it, and the page uses Kill
   all as above: the careful side. */
const STOPALL_MIN = '0.6.25';
const CONFIRM_MS = 8000;         // the question stays this long (compared at the Yes, by the clock)
const ARM_MS = 600;              // and takes no answer for this long after it opens: a double click answers nothing
const ANSWER_WAIT_MS = 5000;     // a Stop all sent and not answered in this long is said, marked bad
const QUESTION = 'Flatten and stop every bot and agent on your prop accounts? Your personal account, the chart\'s Bot tab and the copier are not touched.';

/** a.b.c at least min.b.c (ChartBridge's versions; anything else is not) */
function atLeast(v, min) {
  const p = s => (typeof s === 'string' && /^\d+\.\d+\.\d+$/.test(s) ? s.split('.').map(Number) : null);
  const a = p(v), b = p(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/**
 * What the header's Stop all can do now: { kind, ok, why, note }. kind 'stopAll' (the ledger too), 'killAll' (ChartBridge's own
 * prop rule only) or '' (nothing can be sent: why says so). note: a plain line beside the button ('' when there is nothing to say).
 */
function stopPlan(version, connected, signedIn) {
  if (!connected) return { kind: '', ok: false, why: 'Not connected to ChartBridge: nothing can be sent. Stop each trader in NinjaTrader.', note: '' };
  if (!signedIn) return { kind: '', ok: false, why: 'Not signed in to ChartBridge (trading is off in its config.txt, or this window is not unlocked): nothing can be sent.', note: '' };
  if (atLeast(version, STOPALL_MIN)) return { kind: 'stopAll', ok: true, why: '', note: '' };
  if (atLeast(version, KILL_MIN)) return { kind: 'killAll', ok: true, why: '', note: 'This ChartBridge (' + version + ') stops by its own prop rule only (every live account but your personal one), not by the account ledger. The next ChartBridge reads the ledger too.' };
  return { kind: '', ok: false, why: 'This ChartBridge (' + (version || 'version not known') + ') has no Stop all: stop each trader in NinjaTrader.', note: '' };
}

/** The one message a press sends, with exactly its keys. */
function stopMsg(kind, cid) {
  if (typeof cid !== 'string' || !cid) return null;
  if (kind === 'stopAll') return { type: 'stopAllAutomation', cid };
  if (kind === 'killAll') return { type: 'agentKillAllProp', cid };
  return null;
}

/** The header's gate: true only for one of the two messages, with exactly the keys type and cid (a plain string). */
function stopMaySend(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  if (m.type !== 'stopAllAutomation' && m.type !== 'agentKillAllProp') return false;
  const k = Object.keys(m);
  return k.length === 2 && k.includes('type') && k.includes('cid') && typeof m.cid === 'string' && m.cid.length > 0 && m.cid.length <= 64;
}

/** Is this ChartBridge message the answer to a Stop all? ChartBridge answers a press with one status line (warn) whose text
 *  starts with its own words, or with a reject carrying the press's cid. -> { text, bad } or null. */
function stopAnswer(m, cid) {
  if (!m || typeof m !== 'object') return null;
  if (m.type === 'reject' && cid && m.cid === cid) return { text: 'Not done: ' + String(m.reason || 'ChartBridge refused it'), bad: true };
  if (m.type === 'status' && typeof m.text === 'string' && /^(Stop all automation|Kill all \(prop accounts\))/.test(m.text)) {
    return { text: m.text.slice(0, 2000), bad: /NOT STOPPED|FAILED|could NOT/.test(m.text) };
  }
  return null;
}

/**
 * The question's state at a click: 'yes' (send), 'early' (inside ARM_MS: nothing, the question stays), 'late' (past CONFIRM_MS:
 * the question closes, nothing sent), 'key' (Yes by the keyboard: refused), 'none' (no question open).
 */
function stopClick(askedAt, now, real) {
  if (!askedAt) return 'none';
  const age = now - askedAt;
  if (age > CONFIRM_MS) return 'late';
  if (!real) return 'key';
  if (age < ARM_MS) return 'early';
  return 'yes';
}

return Object.freeze({ TABS, TAB_IDS, OLD_TABS, COHORT_SUBS, roman, tabFrom, tabSearch, KILL_MIN, STOPALL_MIN, CONFIRM_MS, ARM_MS, ANSWER_WAIT_MS, QUESTION,
  atLeast, stopPlan, stopMsg, stopMaySend, stopAnswer, stopClick });
});

/* ================================================================================================ the page (browser only) */
(function () {
'use strict';
if (typeof window === 'undefined' || typeof document === 'undefined' || !document.getElementById('lxApp')) return;
const C = window.LegionCore;
const $ = id => document.getElementById(id);
const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PIN = window.ChartBridgePin || null;
const LS = (() => { try { return window.localStorage; } catch (e) { return null; } })();
const store = { getItem: k => { try { return LS ? LS.getItem(k) : null; } catch (e) { return null; } }, setItem: (k, v) => { try { if (LS) LS.setItem(k, v); } catch (e) { /* blocked */ } },
  removeItem: k => { try { if (LS) LS.removeItem(k); } catch (e) { /* blocked */ } } };
const PREFIX = 'legion-';                                   // this page's own browser keys, apart from the chart page's
const onBridge = location.protocol.startsWith('http') && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(location.host);
const BASE_WS = onBridge ? 'ws://' + location.host + '/ws' : 'ws://localhost:8765/ws';
const wsUrl = () => (PIN ? PIN.wsUrl(BASE_WS) : BASE_WS);
const framed = (() => { try { return window.top !== window.self; } catch (e) { return true; } })();
const realClick = window.OrderTicket && typeof window.OrderTicket.realClick === 'function' ? window.OrderTicket.realClick : () => false;   // none: Yes is never taken

/* ---------------- the clock (New York) */
const clockFmt = (() => { try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (e) { return null; } })();
function tick() { const el = $('lxClock'); if (el && clockFmt) el.textContent = clockFmt.format(new Date()); }

/* ---------------- the state the header reads */
const S = { version: '', connected: false, signedIn: false, ask: 0, askTimer: 0, said: '', saidBad: false, pending: '', waitTimer: 0, cidSeq: 0, tab: 'castra', sub: '', mounted: {} };
let AF = null, hub = null, link = null;
const cid = () => 'lx' + (++S.cidSeq).toString(36) + Math.random().toString(36).slice(2, 6);
const plan = () => C.stopPlan(S.version, S.connected, S.signedIn);

function renderHead() {
  const p = plan(), btn = $('lxStop'), ask = $('lxStopAsk'), line = $('lxStopSaid'), conn = $('lxConn');
  if (conn) {
    const t = !S.connected ? 'ChartBridge: not connected' : !S.signedIn ? 'ChartBridge ' + (S.version || '') + ': not signed in' : 'ChartBridge ' + (S.version || '') + ': on';
    if (conn.textContent !== t) conn.textContent = t;
    conn.dataset.state = !S.connected ? 'off' : S.signedIn ? 'on' : 'wait';
  }
  if (btn) {
    btn.disabled = !p.ok && !S.ask;
    const tip = p.ok ? C.QUESTION : p.why;
    if (btn.title !== tip) btn.title = tip;
    btn.setAttribute('aria-expanded', String(!!S.ask));
  }
  if (ask) ask.hidden = !S.ask;
  const words = S.said || (!p.ok ? p.why : p.note);
  if (line) { if (line.textContent !== words) line.textContent = words; line.hidden = !words; line.classList.toggle('bad', !!(S.said ? S.saidBad : !p.ok)); }
}
function say(text, bad) { S.said = String(text || ''); S.saidBad = !!bad; renderHead(); }
function endAsk() { S.ask = 0; clearTimeout(S.askTimer); S.askTimer = 0; }
function openAsk() {
  const p = plan();
  if (!p.ok) { say(p.why, true); return; }
  S.ask = Date.now(); clearTimeout(S.askTimer);
  S.askTimer = setTimeout(() => { if (S.ask && Date.now() - S.ask >= C.CONFIRM_MS) { endAsk(); say('', false); } }, C.CONFIRM_MS + 50);
  say('', false);
  renderHead();
  const no = $('lxStopNo'); if (no) no.focus();
}
function send() {
  const p = plan(), id = cid(), m = C.stopMsg(p.kind, id);
  endAsk();
  if (!p.ok || !m) { say(p.why || 'Nothing was sent.', true); return; }
  if (!link || !link.post(m)) { say('Not sent: the connection to ChartBridge is not open. Stop each trader in NinjaTrader.', true); return; }
  S.pending = id;
  say(p.kind === 'stopAll' ? 'Stop all automation sent: waiting for ChartBridge...' : 'Kill all (prop accounts) sent: waiting for ChartBridge...', false);
  clearTimeout(S.waitTimer);
  S.waitTimer = setTimeout(() => { if (S.pending === id) { S.pending = ''; say('ChartBridge did not answer in ' + C.ANSWER_WAIT_MS / 1000 + ' s: check the traders on Cohorts, or in NinjaTrader.', true); } }, C.ANSWER_WAIT_MS);
}
function onStopClick(e) {
  const t = e.target && e.target.closest ? e.target.closest('button') : null;
  if (!t) return;
  if (t.id === 'lxStop') { if (S.ask) { endAsk(); say('', false); } else openAsk(); return; }
  if (t.id === 'lxStopNo') { endAsk(); say('', false); return; }
  if (t.id !== 'lxStopYes') return;
  const r = C.stopClick(S.ask, Date.now(), realClick(e));
  if (r === 'late') { endAsk(); say('The question closed (8 s): nothing was sent. Press Stop all automation again.', false); return; }
  if (r === 'key') { say('Stop all is confirmed by a click on Yes only, not by keyboard. Cancel and Escape work from the keyboard.', true); return; }
  if (r === 'early') { say('Too soon: read the question, then click Yes.', true); return; }
  if (r === 'yes') send();
}
function onHeadMessage(m) {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'hello') { S.version = typeof m.version === 'string' ? m.version : ''; S.connected = true; }
  if (m.type === 'trading') S.signedIn = !!m.enabled;
  const a = C.stopAnswer(m, S.pending);
  if (a && (S.pending || m.type === 'status')) { if (S.pending) { S.pending = ''; clearTimeout(S.waitTimer); } say(a.text, a.bad); }
  renderHead();
}

/* ---------------- the tabs */
function showTab(tab, sub, keepUrl) {
  if (!C.TAB_IDS.includes(tab)) tab = 'castra';
  S.tab = tab; S.sub = tab === 'cohorts' ? (C.COHORT_SUBS.includes(sub) ? sub : 'legion') : '';
  for (const t of C.TABS) {
    const b = document.querySelector('[data-lx-tab="' + t.id + '"]'), v = $('lx-' + t.id);
    if (b) { b.setAttribute('aria-selected', String(t.id === tab)); b.tabIndex = t.id === tab ? 0 : -1; }
    if (v) v.hidden = t.id !== tab;
  }
  for (const b of document.querySelectorAll('[data-lx-sub]')) b.setAttribute('aria-selected', String(b.dataset.lxSub === S.sub));
  for (const v of document.querySelectorAll('[data-lx-subview]')) v.hidden = v.dataset.lxSubview !== S.sub;
  if (!keepUrl) { try { history.replaceState(null, '', location.pathname + C.tabSearch(location.search, S.tab, S.sub) + location.hash); } catch (e) { /* file: */ } }
  for (const fn of HOOKS.tab) { try { fn(S.tab, S.sub); } catch (e) { failed('the ' + S.tab + ' tab', e); } }
  const t = C.TABS.find(x => x.id === tab);
  document.title = (t ? t.name + ' · ' : '') + 'Legion · Imperium';
}
function onNavKey(e) {
  const b = e.target && e.target.closest ? e.target.closest('[data-lx-tab]') : null;
  if (!b || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const i = C.TAB_IDS.indexOf(b.dataset.lxTab), n = C.TAB_IDS.length;
  const j = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n;
  showTab(C.TAB_IDS[j], ''); const nb = document.querySelector('[data-lx-tab="' + C.TAB_IDS[j] + '"]'); if (nb) nb.focus();
  e.preventDefault();
}

/* ---------------- one part that throws never stops the header or another tab (the chart page's start guard, release 1) */
const FAILED = new Map();
function failed(name, e) {
  if (FAILED.has(name)) return;
  FAILED.set(name, String(e && e.message ? e.message : e));
  try { console.error('Legion: ' + name + ' did not start', e); } catch (x) { /* no console */ }
  const el = $('lxFailed');
  if (el) { el.textContent = [...FAILED.keys()].join(', ') + ' did not start: Stop all automation and the other tabs work; reload this window to try again.'; el.hidden = false; }
}
function guard(name, fn) { try { return fn(); } catch (e) { failed(name, e); return null; } }

/* the parts each tab mounts register here (slice 2: the moved tabs); the header never waits for them */
const HOOKS = { tab: [], message: [] };
window.LegionApp = { hooks: HOOKS, guard, state: () => ({ tab: S.tab, sub: S.sub, version: S.version, connected: S.connected, signedIn: S.signedIn, asking: S.ask > 0, said: S.said, saidBad: S.saidBad, pending: !!S.pending, failed: [...FAILED.keys()], mounted: Object.keys(S.mounted).filter(k => S.mounted[k]) }),
  feeds: () => ({ AF, hub }), store, PREFIX, PIN, realClick };

function start() {
  tick(); setInterval(tick, 1000);
  const nav = $('lxNav');
  if (nav) { nav.addEventListener('click', e => { const b = e.target.closest('[data-lx-tab]'); if (b) showTab(b.dataset.lxTab, ''); }); nav.addEventListener('keydown', onNavKey); }
  for (const b of document.querySelectorAll('[data-lx-sub]')) b.addEventListener('click', () => showTab('cohorts', b.dataset.lxSub));
  const head = $('lxHead'); if (head) head.addEventListener('click', onStopClick);
  const ask = $('lxStopAsk'); if (ask) ask.addEventListener('click', onStopClick);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.ask) { endAsk(); say('', false); e.preventDefault(); } }, true);
  /* the window's two connections, as the chart page and agent.html open them: the chart feed (prices, for a chart inside a tab)
     and the v3 connection (ChartBridge's accounts, groups and traders; every message a tab sends goes through its own gate) */
  guard('the chart feed', () => { hub = window.ChartFeed && typeof window.ChartFeed.create === 'function' ? window.ChartFeed.create({ wsUrl }) : null; });
  guard('the ChartBridge connection', () => {
    AF = window.AccountsPage && typeof window.AccountsPage.createFeed === 'function' ? window.AccountsPage.createFeed({ wsUrl, pin: PIN, framed, fetch: (u, o) => fetch(u, o),
      note: (t, warn) => { if (warn) say(t, true); }, changed: () => { for (const fn of HOOKS.message) { try { fn(null); } catch (e) { /* its own guard */ } } } }) : null;
  });
  /* the header's own link: listen, and post only what stopMaySend passes (the two Stop all messages, exactly their keys) */
  link = AF ? Object.freeze({ post: m => C.stopMaySend(m) === true && AF.post(m) === true }) : null;
  if (AF) AF.listen({ message: m => { onHeadMessage(m); for (const fn of HOOKS.message) { try { fn(m); } catch (e) { /* its own guard */ } } },
    closed: () => { S.connected = false; S.signedIn = false; if (S.ask) endAsk(); renderHead(); } });
  if (window.LegionTabs && typeof window.LegionTabs.mount === 'function') guard('the moved tabs', () => window.LegionTabs.mount({ AF, hub, store, PREFIX, PIN, realClick, hooks: HOOKS, mounted: S.mounted, guard, say }));
  const want = C.tabFrom(location.search);
  showTab(want.tab, want.sub, false);
  renderHead();
  if (AF) AF.startAny();
}
if (PIN) PIN.gate().then(start); else start();
})();
