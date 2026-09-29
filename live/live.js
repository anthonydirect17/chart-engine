/*
 * Live chart page: connects to ChartBridge (NinjaTrader 8 add-on) and drives chart-engine.
 * Protocol: nt8/PROTOCOL.md. With ChartBridge 0.2 (protocol v1) the page is read only. With protocol v2 it
 * can trade, but only after ChartBridge enables it (trading = true in config.txt, this page signed in with
 * the session token) and only while the Armed switch is on. Armed is off after every page load.
 */
/*
 * Saved choices (LivePrefs), in this browser's localStorage. This block also loads in Node, for tests with a
 * stand-in storage; the page code below runs only in a browser. It lives in live.js because nt8/install.ps1
 * copies a fixed list of page files.
 *
 * Every read and write is wrapped: storage can be missing or throw (private windows, blocked site data).
 * Every write changes one field and reads the key fresh first, so two chart tabs never undo each other's
 * choices (before 1.4.0 each tab wrote its whole in-memory copy back, which put NQ's range back to 20 when
 * another tab saved).
 *
 * Keys (versioned):
 *   live-settings-v2    { root, tf, glide, rangeMode }
 *   live-range-v2       { NQ: 40, ... } range bar size in ticks, per instrument root; only roots set by hand
 *   live-indicators-v1  { <paneId>: { volume, vwap, levels, fills } } indicators on each chart pane
 *   live-bracket-v1     { MNQ: { stop, target }, ... } (format unchanged since 1.3.0)
 * The 1.3 keys live-settings-v1 and live-range-v1 are read once, when the new keys do not exist yet, and left
 * in place.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = { LivePrefs: factory() };
  else root.LivePrefs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const ROOTS = ['MNQ', 'NQ', 'MES', 'ES'];
const TFS = ['s15', 's30', 'm1', 'm5', 'm15', 'h1', 'range'];
const GLIDES = ['smooth', 'fast', 'off'];
const RANGE_MODES = ['nt', 'traded'];
const DEFAULT_RANGE = { MNQ: 20, NQ: 20, MES: 8, ES: 8 };
const RANGE_MIN = 1, RANGE_MAX = 400;
const INDICATORS = [
  { id: 'volume', name: 'Volume' },
  { id: 'vwap', name: 'VWAP' },
  { id: 'levels', name: 'Levels' },
  { id: 'fills', name: 'Fills' },
];
/* What the page showed before any choice was made (1.3); the main pane starts here. */
const DEFAULT_INDICATORS = { volume: true, vwap: true, levels: true, fills: true };
/* A new pane (the grid, next step) starts from this clean set, never from another pane's choices. */
const NEW_PANE_INDICATORS = DEFAULT_INDICATORS;
const MAIN_PANE = 'main';

const KEYS = { settings: 'live-settings-v2', range: 'live-range-v2', indicators: 'live-indicators-v1', bracket: 'live-bracket-v1' };
const OLD = { settings: 'live-settings-v1', range: 'live-range-v1' };

/** A whole number of ticks from 1 to 400, or null when the text is not one (half typed, empty, 0, 4.5). */
function parseRange(v) {
  if (typeof v === 'string') { v = v.trim(); if (!/^\d+$/.test(v)) return null; }
  const n = +v;
  return Number.isInteger(n) && n >= RANGE_MIN && n <= RANGE_MAX ? n : null;
}
/** For a committed entry (Enter or leaving the box): clamp into 1 to 400; null when it is not a number at all. */
function clampRange(v) {
  const n = Math.round(+v);
  if (v === '' || v === null || v === undefined || !isFinite(n)) return null;
  return Math.max(RANGE_MIN, Math.min(RANGE_MAX, n));
}

function cleanIndicators(v, base) {
  const out = Object.assign({}, base || NEW_PANE_INDICATORS);
  if (v && typeof v === 'object') for (const k of Object.keys(out)) if (typeof v[k] === 'boolean') out[k] = v[k];
  return out;
}

function create(storage) {
  const raw = {
    get(k) { try { const s = storage && storage.getItem(k); return s === null || s === undefined ? null : JSON.parse(s); } catch (e) { return null; } },
    set(k, v) { try { if (storage) storage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    has(k) { try { return !!storage && storage.getItem(k) !== null; } catch (e) { return false; } },
  };
  const obj = k => { const v = raw.get(k); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
  /* read fresh, change one field, write back */
  const patch = (k, field, value) => { const cur = obj(k); cur[field] = value; return raw.set(k, cur); };

  /* one-time carry-over from the 1.3 keys */
  function migrate() {
    if (!raw.has(KEYS.settings)) {
      const s = obj(OLD.settings), next = {};
      if (ROOTS.includes(s.root)) next.root = s.root;
      if (TFS.includes(s.tf)) next.tf = s.tf;
      if (GLIDES.includes(s.glide)) next.glide = s.glide;
      raw.set(KEYS.settings, next);
      if (!raw.has(KEYS.indicators) && s.layers) raw.set(KEYS.indicators, { [MAIN_PANE]: cleanIndicators(s.layers, DEFAULT_INDICATORS) });
    }
    if (!raw.has(KEYS.range)) {
      const r = obj(OLD.range), next = {};
      for (const root of ROOTS) { const n = parseRange(r[root]); if (n !== null) next[root] = n; }
      raw.set(KEYS.range, next);
    }
  }
  migrate();

  return {
    raw,
    /** { root, tf, glide, rangeMode } with defaults for anything missing or unknown. */
    settings() {
      const s = obj(KEYS.settings);
      return {
        root: ROOTS.includes(s.root) ? s.root : 'MNQ',
        tf: TFS.includes(s.tf) ? s.tf : 'm1',
        glide: GLIDES.includes(s.glide) ? s.glide : 'smooth',
        rangeMode: RANGE_MODES.includes(s.rangeMode) ? s.rangeMode : 'nt',
      };
    },
    setSetting(field, value) { return patch(KEYS.settings, field, value); },
    /** Range bar size in ticks for a root: the saved one, else the default. */
    range(root) { const n = parseRange(obj(KEYS.range)[root]); return n !== null ? n : (DEFAULT_RANGE[root] || 20); },
    setRange(root, ticks) { const n = parseRange(ticks); if (n === null || !ROOTS.includes(root)) return false; return patch(KEYS.range, root, n); },
    /** Indicators on a pane: the saved set, the 1.3 set for the main pane, else the clean set for a new pane. */
    indicators(paneId) {
      const all = obj(KEYS.indicators);
      return cleanIndicators(all[paneId], paneId === MAIN_PANE ? DEFAULT_INDICATORS : NEW_PANE_INDICATORS);
    },
    setIndicators(paneId, set) { return patch(KEYS.indicators, paneId, cleanIndicators(set, paneId === MAIN_PANE ? DEFAULT_INDICATORS : NEW_PANE_INDICATORS)); },
    bracket(root) { return obj(KEYS.bracket)[root]; },
    setBracket(root, b) { return patch(KEYS.bracket, root, b); },
  };
}

/** Runs fn after `ms` of quiet; flush() runs a waiting call now (on commit, or when the page is closing). */
function debounce(fn, ms) {
  let timer = null, args = null;
  const run = () => { timer = null; const a = args; args = null; if (a) fn.apply(null, a); };
  const d = function () { args = arguments; if (timer) clearTimeout(timer); timer = setTimeout(run, ms); };
  d.flush = () => { if (timer) { clearTimeout(timer); run(); } };
  d.cancel = () => { if (timer) clearTimeout(timer); timer = null; args = null; };
  return d;
}

return { create, debounce, parseRange, clampRange, cleanIndicators, KEYS, OLD, ROOTS, TFS, GLIDES, RANGE_MODES, DEFAULT_RANGE, INDICATORS, DEFAULT_INDICATORS, NEW_PANE_INDICATORS, MAIN_PANE, RANGE_MIN, RANGE_MAX };
});

if (typeof document !== 'undefined') (() => {
'use strict';
const CE = window.ChartEngine, U = CE.util, BB = window.BarBuilder, BarBuilder = BB.BarBuilder, OT = window.OrderTicket, LP = window.LivePrefs;
const $ = id => document.getElementById(id);
const SESSION = 18 * 3600;
const ROOTS = LP.ROOTS;
const TF = {
  s15: { mode: 'time', sec: 15, label: '15s' }, s30: { mode: 'time', sec: 30, label: '30s' },
  m1: { mode: 'time', sec: 60, label: '1m' }, m5: { mode: 'time', sec: 300, label: '5m' },
  m15: { mode: 'time', sec: 900, label: '15m' }, h1: { mode: 'time', sec: 3600, label: '1h' },
  range: { mode: 'range', sec: 30, label: 'Range' },
};
const GLIDE = { smooth: { candle: 55, fit: 120, follow: 110 }, fast: { candle: 20, fit: 60, follow: 60 }, off: { candle: 0, fit: 0, follow: 0 } };

/* Saved choices: read once here, written one field at a time as they change (LivePrefs above). */
const prefs = LP.create((() => { try { return window.localStorage; } catch (e) { return null; } })());
const PANE = LP.MAIN_PANE;                       // one pane today; the grid (next step) adds more pane ids
const S = Object.assign(prefs.settings(), { layers: prefs.indicators(PANE) });
const ranges = {};
for (const r of ROOTS) ranges[r] = prefs.range(r);
const saveSetting = k => prefs.setSetting(k, S[k]);
const store = {                                  // single-value keys (fill account, drawings), try/catch inside
  get(k, d) { const v = prefs.raw.get(k); return v === null ? d : v; },
  set(k, v) { prefs.raw.set(k, v); },
};

/* exchange clock: New York wall time as bar-time seconds; the offset is refreshed every minute */
let etOffset = U.zoneSeconds(Date.now() / 1000) - Date.now() / 1000;
setInterval(() => { etOffset = U.zoneSeconds(Date.now() / 1000) - Date.now() / 1000; }, 60000);
const etNow = () => Date.now() / 1000 + etOffset;
const nowMs = () => (performance.timeOrigin || Date.now() - performance.now()) + performance.now();

const chart = CE.create($('chart'), {
  barSeconds: 60, precision: 2, tick: 0.25,
  session: { start: SESSION, rthStart: 34200, rthEnd: 57600 },
  layers: { volume: S.layers.volume, vwap: S.layers.vwap, levels: S.layers.levels, trades: false },
  motion: GLIDE[S.glide], clock: etNow,
});

window.liveChart = chart;            // for tests and the console; order actions still go through the checks below

/* ---------------- per-instrument data */
const D = { root: null, name: null, tick: 0.25, ready: false, hist: [], ticks: [], m1: null, cur: null, day: null, tickHours: 0, tickFrom: Infinity };
/* Seconds and range bars are built from ticks; minute and hour bars only need 1-minute history (fast load).
   Range bars need the backfill to reach back to a session start (see rangeHistoryFrom in bar-builder.js). */
const ticksWanted = () => TF[S.tf].mode === 'range' ? BB.rangeTickHours(etNow(), SESSION) : TF[S.tf].sec < 60 ? 8 : 0;
const ticksMissing = () => TF[S.tf].mode === 'range' ? D.tickFrom > BB.rangeHistoryFrom(etNow(), SESSION) : TF[S.tf].sec < 60 && D.tickHours === 0;
let instruments = {};
const fills = new Map();            // id -> fill, all instruments
let fillAccount = store.get('live-fill-account-v1', '');   // '' = all accounts
const accountsSeen = new Set();
let ticksSeen = 0;
const delays = { feed: [], local: [] };

function resetData(root) {
  D.root = root; D.name = root; D.ready = false; D.hist = []; D.ticks = []; D.m1 = null; D.cur = null; D.day = null;
  const inst = instruments[root];
  if (inst) { D.name = inst.name; D.tick = inst.tick || 0.25; }
  chart.setPriceFormat({ precision: precisionOf(), tick: D.tick });
  chart.setBars([], { barSeconds: TF[S.tf].sec });
  chart.setLevels([]);
  chart.setDrawings(store.get('live-drawings-v1-' + root, []));
  applyMarkers();
  renderTrading();
  legendKey = '';
}

function tfSeconds() { return TF[S.tf].sec; }

/* Build the chart's bars for the current timeframe from 1m history + ticks. */
function rebuild() {
  if (!D.ready) return;
  const tf = TF[S.tf];
  chart.setBarSeconds(tf.sec);
  if (tf.mode === 'time' && tf.sec >= 60) {
    D.cur = null;
    const bars = tf.sec === 60 ? D.m1.bars : U.aggregate(D.m1.bars, tf.sec);
    chart.setBars(bars, { barSeconds: tf.sec });
    chart.setCountdown(null);
  } else {
    D.cur = tf.mode === 'range'
      ? new BarBuilder({ mode: 'range', rangeTicks: ranges[D.root], rangeMode: S.rangeMode, tick: D.tick, sessionStart: SESSION })
      : new BarBuilder({ mode: 'time', seconds: tf.sec, tick: D.tick, sessionStart: SESSION });
    const from = tf.mode === 'range' ? BB.rangeStartIndex(D.ticks, D.tickFrom, SESSION) : 0;
    for (let i = from; i < D.ticks.length; i++) { const k = D.ticks[i]; D.cur.add(k[0], k[1], k[2]); }
    chart.setBars(D.cur.bars, { barSeconds: tf.sec });
    if (tf.mode === 'range') chart.setCountdown(() => { const r = D.cur && D.cur.rangeLeft(); return r ? '▲' + r.up + ' ▼' + r.down : ''; });
    else chart.setCountdown(null);
    if (!D.ticks.length) setStatus('No tick history came back from NinjaTrader, so ' + tf.label + ' bars start with the next live tick.', 'warn');
  }
  updateLevels();
  applyMarkers();
  legendKey = '';
}

function updateLevels() {
  if (!D.m1 || !D.m1.bars.length) return;
  const lv = U.sessionLevels(D.m1.bars, { asOf: etNow(), sessionStart: SESSION, tick: D.tick });
  chart.setLevels(U.levelLines(lv));
  D.day = U.tradeDay(etNow(), SESSION);
}

function onReady() {
  // With ticks: 1m history up to the start of the current minute, and the forming minute rebuilt from
  // ticks. Without ticks: keep NinjaTrader's forming minute and let live ticks continue it.
  const cutoff = D.tickHours > 0 ? Math.floor(etNow() / 60) * 60 : Infinity;
  const seen = new Map();
  for (const b of D.hist) if (b.t < cutoff) seen.set(b.t, b);
  const hist = [...seen.values()].sort((a, b) => a.t - b.t);
  D.m1 = new BarBuilder({ mode: 'time', seconds: 60, tick: D.tick, sessionStart: SESSION });
  D.m1.seed(hist);
  if (D.tickHours > 0) {
    const lastHist = hist.length ? hist[hist.length - 1].t + 60 : -Infinity;
    for (const k of D.ticks) if (k[0] >= Math.max(cutoff, lastHist)) D.m1.add(k[0], k[1], k[2]);
  }
  D.ready = true;
  rebuild();
  setConn('live');
  $('notice').hidden = true;
}

function onTick(m) {
  if (m.root !== D.root || !D.ready) return;
  const t = m.t, p = m.p, v = m.v || 0;
  D.ticks.push([t, p, v]);
  if (D.ticks.length > 2500000) { D.ticks.splice(0, 500000); D.tickFrom = D.ticks[0][0] + 0.001; }   // the first session left is partial now
  ticksSeen++;
  const r1 = D.m1.add(t, p, v);
  const tf = TF[S.tf];
  if (tf.mode === 'time' && tf.sec >= 60) chart.update(tf.sec === 60 ? r1.bar : U.foldLast(D.m1.bars, tf.sec));
  else if (D.cur) { const ch = D.cur.add(t, p, v).changed; for (let i = 0; i < ch.length; i++) chart.update(ch[i]); }   // a finished range bar, phantom bars, the new bar
  const now = nowMs();
  pushDelay(delays.feed, m.rx - m.u);
  pushDelay(delays.local, now - m.rx);
  if (r1.isNew && U.tradeDay(t, SESSION) !== D.day) updateLevels();
}

function pushDelay(arr, v) { if (isFinite(v)) { arr.push(v); if (arr.length > 300) arr.shift(); } }
function median(arr) { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

/* ---------------- fills */
function addFill(f) {
  if (!f || !f.id) return;
  fills.set(f.account + '|' + f.id, { t: f.t, price: f.p, side: f.side, qty: f.qty, root: f.root, name: f.name, account: f.account });
  if (f.account && !accountsSeen.has(f.account)) { accountsSeen.add(f.account); syncAccounts(); }
}
/* Account dropdown: All accounts, or one account (Anthony, 2026-09-29). Accounts with fills come first. */
function syncAccounts(listed) {
  if (listed) for (const a of listed) accountsSeen.add(a);
  const sel = $('fillAcct');
  const withFills = new Set([...fills.values()].map(f => f.account));
  const names = [...accountsSeen].sort((a, b) => (withFills.has(b) - withFills.has(a)) || a.localeCompare(b));
  if (fillAccount && !accountsSeen.has(fillAccount)) names.unshift(fillAccount);   // keep a saved choice even before it reconnects
  sel.replaceChildren(new Option('All accounts', ''), ...names.map(n => new Option(withFills.has(n) ? n : n + ' (no fills yet)', n)));
  sel.value = fillAccount;
}
function applyMarkers() {
  const list = S.layers.fills ? [...fills.values()].filter(f => f.root === D.root && (!fillAccount || f.account === fillAccount)) : [];
  chart.setMarkers(list);
  const lastFill = list.sort((a, b) => a.t - b.t)[list.length - 1];
  const el = $('lgFill');
  if (lastFill) {
    el.className = lastFill.side === 'buy' ? 'buy' : 'sell';
    el.textContent = 'Last fill ' + lastFill.side.toUpperCase() + ' ' + lastFill.qty + ' @ ' + U.fmtPrice(lastFill.price, precisionOf()) + ' ' + U.fmtHM(lastFill.t) + (lastFill.account ? ' · ' + lastFill.account : '');
  } else { el.textContent = ''; }
}
/* decimals needed to show every tick exactly: 0.25 -> 2, 0.1 -> 1, 1 -> 0 */
function decimalsOf(tick) {
  const s = String(tick);
  if (s.includes('e-')) return +s.split('e-')[1];
  return (s.split('.')[1] || '').length;
}
const precisionOf = () => Math.min(8, decimalsOf(D.tick));

/* ---------------- connection */
let ws = null, wsTries = 0, everConnected = false;
const wsUrl = (() => {
  const onBridge = location.protocol.startsWith('http') && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(location.host);
  return onBridge ? 'ws://' + location.host + '/ws' : 'ws://localhost:8765/ws';
})();

function connect() {
  setConn('connecting');
  try { ws = new WebSocket(wsUrl); } catch (e) { scheduleReconnect(); return; }
  ws.onopen = () => { wsTries = 0; everConnected = true; setStatus('', ''); };
  ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } handle(m); };
  ws.onclose = () => { ws = null; D.ready = false; setConn('offline'); tradingLost('Not connected to ChartBridge.'); scheduleReconnect(); };
  ws.onerror = () => { /* onclose follows */ };
}
function scheduleReconnect() {
  wsTries++;
  const wait = Math.min(5000, 500 * wsTries);
  if (!everConnected || wsTries > 2) showNotice(everConnected ? 'Lost ChartBridge' : 'Waiting for ChartBridge',
    'Trying ' + wsUrl + ' again. Check that NinjaTrader is running and ChartBridge compiled (messages appear in New > NinjaScript Output).');
  setTimeout(connect, wait);
}
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function subscribe(root) {
  resetData(root);
  setConn('loading');
  D.tickHours = ticksWanted();
  D.tickFrom = D.tickHours > 0 ? etNow() - D.tickHours * 3600 : Infinity;
  send({ type: 'subscribe', root, days: 5, tickHours: D.tickHours });
}

function handle(m) {
  switch (m.type) {
    case 'hello':
      instruments = {};
      for (const i of m.instruments || []) instruments[i.root] = i;
      $('lgSrc').textContent = 'NinjaTrader via ChartBridge ' + (m.version || '');
      syncAccounts(m.accounts || []);
      subscribe(S.root);
      if (m.trading) { applyTrading(m.trading); signIn(); }   // protocol v2; ChartBridge 0.2 has no trading field
      break;
    case 'history':
      if (m.root !== D.root) return;
      if (m.name) { D.name = m.name; $('lgName').textContent = m.name; }
      for (const b of m.bars) D.hist.push({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] });
      setStatus('Loading ' + D.root + ' history: ' + D.hist.length.toLocaleString() + ' minutes', '');
      break;
    case 'ticks':
      if (m.root !== D.root) return;
      for (const k of m.ticks) D.ticks.push(k);
      setStatus('Loading ' + D.root + ' ticks: ' + D.ticks.length.toLocaleString(), '');
      break;
    case 'ready':
      if (m.root !== D.root) return;
      setStatus('', '');
      onReady();
      break;
    case 'tick': onTick(m); break;
    case 'execs': for (const f of m.list || []) addFill(f); syncAccounts(); applyMarkers(); break;
    case 'exec': addFill(m); applyMarkers(); break;
    case 'status': if (m.level === 'error') alertLoud(m.text); else setStatus(m.text, m.level); break;
    case 'trading': applyTrading(m); if (!TR.signInStarted) signIn(); break;
    case 'orders': TR.orders.clear(); for (const o of m.list || []) if (served(o.root)) TR.orders.set(o.id, o); renderTrading(); break;
    case 'order': onOrder(m); break;
    case 'position': TR.positions.set(m.account + '|' + m.root, { qty: +m.qty || 0, avgPrice: +m.avgPrice || 0 }); renderTrading(); break;
    case 'reject': flash('Refused by ChartBridge: ' + m.reason, 'error'); renderTrading(); break;
  }
}

/* ---------------- trading (protocol v2) */
const TR = {
  v2: false, enabled: false, reason: '', accounts: [], maxQty: {}, signInStarted: false,
  armed: false,                        // never saved: Armed is off after every page load
  account: '', side: 'buy',
  orders: new Map(),                   // id -> latest order message (working ones; finished ones are dropped)
  positions: new Map(),                // 'account|root' -> { qty, avgPrice }
};
const brackets = {};
for (const r of ROOTS) brackets[r] = OT.cleanBracket(prefs.bracket(r));
const sameAction = OT.repeatGuard(400);
let cidSeq = 0;
const newCid = () => 'p' + Date.now().toString(36) + '-' + (++cidSeq);

const served = r => !Object.keys(instruments).length || !!instruments[r];
/* Clickjacking guard: never trade from inside another page's frame (ChartBridge also sends X-Frame-Options DENY). */
const FRAMED = (() => { try { return window.top !== window.self; } catch (e) { return true; } })();
const FRAMED_REASON = 'This chart is inside another page (a frame), so it cannot trade. Open ' + location.href + ' directly in its own tab.';

/* Sign in: read the session token from GET /session (same origin as this page) and send auth. */
function signIn() {
  TR.signInStarted = true;
  if (FRAMED) { applyTrading({ enabled: false, reason: FRAMED_REASON }); return; }
  const sock = ws;
  fetch('/session', { cache: 'no-store' })
    .then(r => r.ok ? r.text() : Promise.reject(new Error('GET /session answered ' + r.status)))
    .then(body => {
      let token = null;
      try { const j = JSON.parse(body); token = typeof j === 'string' ? j : j && j.token; } catch (e) { token = body.trim(); }
      if (!token) throw new Error('no token in GET /session');
      if (sock === ws) send({ type: 'auth', token });
    })
    .catch(e => {
      if (sock !== ws) return;
      applyTrading({ enabled: false, reason: 'Could not sign in to ChartBridge (' + e.message + '). Open the chart from ChartBridge itself to trade.' });
    });
}
function applyTrading(t) {
  TR.v2 = true;
  TR.enabled = !!t.enabled && !FRAMED;
  TR.reason = FRAMED ? FRAMED_REASON : t.enabled ? '' : (t.reason || 'Trading is not enabled in ChartBridge.');
  TR.accounts = Array.isArray(t.accounts) ? t.accounts.slice() : [];
  TR.maxQty = t.maxQty || {};
  TR.account = OT.defaultAccount(TR.accounts, TR.account);
  if (!TR.enabled) setArmed(false);
  syncTradeAccounts();
  renderTrading();
}
function tradingLost(reason) {
  TR.signInStarted = false;
  if (!TR.v2) return;
  TR.enabled = false; TR.reason = reason; TR.orders.clear(); TR.positions.clear();
  setArmed(false); renderTrading();
}
function onOrder(o) {
  if (!served(o.root)) return;
  const prev = TR.orders.get(o.id) || null;
  const ev = OT.orderEvent(o, prev, p => U.fmtPrice(p, precisionOf()));
  if (OT.isWorking(o)) TR.orders.set(o.id, o); else TR.orders.delete(o.id);
  if (ev) flash(ev.text, ev.level === 'error' ? 'error' : '');
  renderTrading();
}

const lastPrice = () => (D.m1 && D.m1.last ? D.m1.last.c : null);
const capNow = () => OT.maxQtyFor(TR, D.root);
const qtyNow = () => Number($('oQty').value === '' ? NaN : +$('oQty').value);

/* Everything that sends an order action goes through here: trading enabled, Armed on, connected, data loaded. */
function ready() {
  if (FRAMED) { flash(FRAMED_REASON, 'error'); return false; }
  if (!TR.enabled) { flash(TR.reason || 'Trading is not enabled.', 'error'); return false; }
  if (!TR.armed) { flash('Armed is off: nothing was sent. Turn Armed on to trade.', 'warn'); return false; }
  if (!ws || ws.readyState !== 1) { flash('Not connected to ChartBridge: nothing was sent.', 'error'); return false; }
  if (!D.ready || !TR.account) { flash('Still loading: nothing was sent.', 'warn'); return false; }
  return true;
}
function sendOrder(side, kind, price) {
  if (!ready()) return;
  const qty = qtyNow(), bad = OT.checkQty(qty, capNow(), D.root);
  if (bad) { flash('Not sent: ' + bad, 'error'); return; }
  if (!sameAction.call(null, [side, kind, price, qty].join('|'), performance.now())) { flash('Ignored a repeat click within 0.4 s.', 'warn'); return; }
  const msg = { type: 'order', cid: newCid(), account: TR.account, root: D.root, side, kind, qty };
  if (kind !== 'market') msg.price = price;
  const b = brackets[D.root], pos = TR.positions.get(TR.account + '|' + D.root);
  const reduces = !OT.bracketAllowed(side, pos && pos.qty);          // ChartBridge refuses a bracket on a reducing order
  if ((b.stop > 0 || b.target > 0) && !reduces) msg.bracket = { stop: b.stop, target: b.target };   // JSON numbers, 0 = none
  send(msg);
  flash('Sent ' + side.toUpperCase() + ' ' + (kind === 'market' ? 'MKT' : kind === 'limit' ? 'LMT' : 'STP') + ' ' + qty + ' ' + D.root +
    (kind === 'market' ? '' : ' @ ' + U.fmtPrice(price, precisionOf())) + (msg.bracket ? ' with bracket ' + b.stop + ' / ' + b.target + ' ticks' : reduces && (b.stop > 0 || b.target > 0) ? ' (no bracket: it reduces the position)' : '') + ' · ' + TR.account, '');
}
function workingHere() { return [...TR.orders.values()].filter(o => o.account === TR.account && o.root === D.root && OT.isWorking(o)); }

/* Cancel all: one cancel per order (a bracket leg takes its pair), at most 8 a second (ChartBridge allows 10). */
function cancelAll() {
  if (!ready()) return;
  const pos = TR.positions.get(TR.account + '|' + D.root);
  const ids = OT.cancelAllIds([...TR.orders.values()], TR.account, D.root, pos ? pos.qty : 0);
  const keptNote = ids.kept ? ' Kept ' + ids.kept + ' order' + (ids.kept > 1 ? 's' : '') + ' protecting the open position (cancel those one by one, or Flatten).' : '';
  if (!ids.length) { flash('Nothing to cancel on ' + TR.account + ' ' + D.root + '.' + keptNote, ''); return; }
  ids.forEach((id, i) => setTimeout(() => { if (TR.armed) send({ type: 'cancel', id }); }, Math.floor(i / 8) * 1100));
  flash('Cancelling ' + ids.length + ' order' + (ids.length > 1 ? 's' : '') + ' on ' + TR.account + ' ' + D.root + '.' + keptNote, '');
}

function setArmed(on) {
  const v = !!on && TR.enabled;
  TR.armed = v;
  const btn = $('armBtn');
  btn.setAttribute('aria-checked', String(v));
  $('armText').textContent = v ? 'ARMED: one click trades' : 'Armed off';
  $('obar').classList.toggle('armed', v);
  document.body.classList.toggle('is-armed', v);
  $('armPill').hidden = !v;
  document.title = v ? 'ARMED · Live Chart' : 'Live Chart';
  chart.setOrderEditing(v);
  renderTrading();
}
function syncTradeAccounts() {
  const sel = $('oAcct');
  sel.replaceChildren(...TR.accounts.map(a => new Option(a, a)));
  sel.value = TR.account;
}
/* Order bar, order lines, position line; also run on every instrument switch and order message. */
function renderTrading() {
  if (!TR.v2) return;
  const bar = $('obar'); bar.hidden = false;
  const on = TR.enabled, root = D.root || S.root, cap = OT.maxQtyFor(TR, root);
  for (const el of bar.querySelectorAll('button, input, select')) el.disabled = !on;
  const q = $('oQty'); q.max = String(cap);
  if (!q.value) q.value = '1';
  for (const id of ['buyMkt', 'sellMkt', 'flattenBtn', 'cancelAllBtn']) $(id).classList.toggle('is-off', !TR.armed);   // dimmed while disarmed; a click says why
  $('oOff').textContent = on ? '' : 'Trading off: ' + TR.reason;
  $('oOff').hidden = on;
  for (const b of $('sideSeg').children) b.setAttribute('aria-pressed', String(b.dataset.v === TR.side));
  const br = brackets[root] || { stop: 0, target: 0 };
  if (document.activeElement !== $('bStop')) $('bStop').value = br.stop;
  if (document.activeElement !== $('bTarget')) $('bTarget').value = br.target;
  $('bStop').setAttribute('aria-label', 'Bracket stop for ' + root + ' in ticks, 0 for none');
  $('bTarget').setAttribute('aria-label', 'Bracket target for ' + root + ' in ticks, 0 for none');
  $('statusRo').textContent = on ? 'Trading through ChartBridge. Live CME data is for this screen only.' : 'Read only. Orders are placed in NinjaTrader. Live CME data is for this screen only.';
  chart.setOrders(on ? workingHere() : []);
  const pos = on ? TR.positions.get(TR.account + '|' + root) : null;
  const inst = instruments[root] || {};
  chart.setPosition(pos && pos.qty ? pos : null, { pointValue: inst.pointValue || 0 });
  renderPositionInfo();
}
/* Position and other accounts in the bar (P&L refreshes with the status line). */
function renderPositionInfo() {
  const el = $('oPos'), other = $('oOther'), legsEl = $('oLegs');
  if (!TR.v2 || !TR.enabled) { el.textContent = ''; other.textContent = ''; legsEl.textContent = ''; return; }
  const root = D.root, pos = TR.positions.get(TR.account + '|' + root), dp = precisionOf();
  if (pos && pos.qty) {
    const pnl = U.openPnl(pos.qty, pos.avgPrice, lastPrice(), (instruments[root] || {}).pointValue || 0);
    const cls = pnl.points > 0 ? 'profit' : pnl.points < 0 ? 'loss' : '';
    el.innerHTML = '';
    const side = document.createElement('span'); side.className = pos.qty > 0 ? 'long' : 'short'; side.textContent = (pos.qty > 0 ? 'LONG ' : 'SHORT ') + Math.abs(pos.qty);
    const res = document.createElement('span'); res.className = cls; res.textContent = U.fmtSigned(pnl.points, dp) + ' pt' + (pnl.dollars !== null ? ' ' + U.fmtMoney(pnl.dollars) : '');
    el.append(side, ' @ ' + U.fmtPrice(pos.avgPrice, dp) + ' ', res);
  } else el.textContent = 'Flat';
  /* stop and target coverage, from the working orders already here (a filled-in-pieces entry has one pair per fill) */
  const legs = pos && pos.qty ? OT.legSummary(TR.orders.values(), TR.account, root, pos.qty) : null;
  legsEl.textContent = legs ? legs.text : '';
  legsEl.classList.toggle('uncovered', !!(legs && legs.stopsShort));
  legsEl.title = legs ? legs.stopLegs + ' stop and ' + legs.targetLegs + ' target order' + (legs.stopLegs + legs.targetLegs === 1 ? '' : 's') + ' working' + (legs.stopsShort ? '. Stops cover less than the position.' : '') : '';
  let n = 0, p = 0;
  for (const o of TR.orders.values()) if (o.root === root && o.account !== TR.account && OT.isWorking(o)) n++;
  for (const [k, v] of TR.positions) if (v.qty && k.endsWith('|' + root) && !k.startsWith(TR.account + '|')) p++;
  other.textContent = n || p ? 'Other accounts on ' + root + ': ' + [n ? n + ' order' + (n > 1 ? 's' : '') : '', p ? p + ' position' + (p > 1 ? 's' : '') : ''].filter(Boolean).join(', ') : '';
}

/* ---------------- UI */
function setConn(state) {
  const pill = $('connPill');
  const map = { connecting: ['CONNECTING', ''], loading: ['LOADING', ''], live: ['LIVE', 'live'], offline: ['OFFLINE', 'bad'] };
  const [text, cls] = map[state] || map.connecting;
  pill.textContent = text; pill.className = 'pill' + (cls ? ' ' + cls : '');
}
function setStatus(text, level) { clearTimeout(flashTimer); const el = $('statusMsg'); el.textContent = text || ''; el.className = 'msg' + (level ? ' ' + level : ''); }
/* Error-level status from ChartBridge (for example a bracket leg rejected: the position may have no stop) stays
   on screen until dismissed. The newest three are kept. */
const alerts = [];
function alertLoud(text) {
  alerts.push(new Date().toLocaleTimeString() + '  ' + text); while (alerts.length > 3) alerts.shift();
  $('alertText').textContent = alerts.join('\n'); $('alertBar').hidden = false;
}
$('alertClose').addEventListener('click', () => { alerts.length = 0; $('alertBar').hidden = true; });
/* Order messages show for a while, then clear (errors stay longer). */
let flashTimer = 0;
function flash(text, level) { setStatus(text, level); const t = text; flashTimer = setTimeout(() => { if ($('statusMsg').textContent === t) setStatus('', ''); }, level === 'error' ? 12000 : 6000); }
function showNotice(title, text) { $('noticeTitle').textContent = title; $('noticeText').textContent = text; $('notice').hidden = false; }

let legendKey = '';
chart.on('legend', e => {
  const { bar: b, prev, forming } = e;
  const key = [b.t, b.o, b.h, b.l, b.c, b.v, forming, S.tf, S.layers.vwap].join('|');
  if (key === legendKey) return;
  legendKey = key;
  const dp = precisionOf(), fmt = p => U.fmtPrice(p, dp);
  const chg = prev ? b.c - prev.c : 0, pct = prev ? chg / prev.c * 100 : 0;
  $('lgTf').textContent = S.tf === 'range' ? 'Range ' + (ranges[D.root] || '') + 't' + (S.rangeMode === 'traded' ? ' traded' : '') : TF[S.tf].label;
  $('lgTime').textContent = U.fmtFull(b.t) + (forming ? ' · forming' : '');
  $('lgO').textContent = fmt(b.o); $('lgH').textContent = fmt(b.h); $('lgL').textContent = fmt(b.l); $('lgC').textContent = fmt(b.c);
  const chgEl = $('lgChg');
  chgEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(dp) + ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)';
  chgEl.className = chg > 0 ? 'up' : chg < 0 ? 'down' : 'dim';
  $('lgV').textContent = U.fmtVolume(b.v);
  $('lgVwWrap').hidden = !S.layers.vwap;
  $('lgVw').textContent = b.vw !== undefined ? fmt(U.roundTo(b.vw, D.tick)) : '-';
});
chart.on('drawings', list => store.set('live-drawings-v1-' + D.root, list));
chart.on('tool', t => { $('toolTrend').setAttribute('aria-pressed', String(t === 'trend')); $('toolHline').setAttribute('aria-pressed', String(t === 'hline')); });

CE.mountThemePanel(chart, $('colorsHost'), {
  storageKey: 'live-colors-v1',
  onChange: () => {
    const T = chart.colors(), st = document.documentElement.style;
    st.setProperty('--vwap-sw', T.vwapText); st.setProperty('--up-text', T.upText); st.setProperty('--down-text', T.downText);
    legendKey = '';
  },
});

function syncButtons() {
  for (const b of $('symSeg').children) b.setAttribute('aria-pressed', String(b.dataset.v === S.root));
  for (const b of $('tfSeg').children) b.setAttribute('aria-pressed', String(b.dataset.v === S.tf));
  for (const b of $('glideSeg').children) b.setAttribute('aria-pressed', String(b.dataset.v === S.glide));
  syncIndicators();
  $('rangeBox').hidden = S.tf !== 'range';
  if (document.activeElement !== $('rangeTicks')) $('rangeTicks').value = ranges[S.root];
  $('rangeTicks').setAttribute('aria-label', 'Range bar size for ' + S.root + ' in ticks');
  $('rangeMode').value = S.rangeMode;
}
$('symSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.dataset.v === S.root) return;
  S.root = b.dataset.v; saveSetting('root'); syncButtons();
  if (TR.armed) { setArmed(false); flash('Armed turned off: the instrument changed.', 'warn'); }
  subscribe(S.root);
});
$('tfSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.dataset.v === S.tf) return;
  S.tf = b.dataset.v; saveSetting('tf'); syncButtons();
  if (ticksMissing()) subscribe(S.root);      // the tick backfill does not reach back far enough for this view: fetch it
  else rebuild();
});

/* Range size, per root. Saved as it is typed (a whole number 1 to 400; anything else waits), a moment after the
   last key; Enter or leaving the box commits at once. A size still waiting is saved if the page is closed or
   reloaded first. */
let rangePending = null;
const saveRange = () => { if (rangePending) { prefs.setRange(rangePending.root, rangePending.n); rangePending = null; } };
const rangeSettled = LP.debounce(() => { saveRange(); if (S.tf === 'range') rebuild(); }, 350);
function setRange(n) {
  if (n === null) return false;
  if (ranges[S.root] !== n) { ranges[S.root] = n; rangePending = { root: S.root, n }; return true; }
  return false;
}
$('rangeTicks').addEventListener('input', e => { if (setRange(LP.parseRange(e.target.value))) rangeSettled(); });
$('rangeTicks').addEventListener('change', e => {
  setRange(LP.clampRange(e.target.value));
  e.target.value = ranges[S.root];
  rangeSettled.cancel();
  if (rangePending) { saveRange(); if (S.tf === 'range') rebuild(); }
});
$('rangeMode').addEventListener('change', e => {
  if (!LP.RANGE_MODES.includes(e.target.value)) return;
  S.rangeMode = e.target.value; saveSetting('rangeMode');
  if (S.tf === 'range') rebuild();
});
$('glideSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.glide = b.dataset.v; chart.setMotion(GLIDE[S.glide]); saveSetting('glide'); syncButtons();
});

/* Indicators: one menu per chart pane (one pane today), saved per pane id. */
function syncIndicators() {
  let on = 0;
  for (const c of $('indPanel').querySelectorAll('input[data-layer]')) { c.checked = !!S.layers[c.dataset.layer]; if (c.checked) on++; }
  $('indCount').textContent = on + '/' + LP.INDICATORS.length;
}
function setIndicator(k, v) {
  if (!(k in S.layers)) return;
  S.layers[k] = !!v;
  if (k === 'fills') applyMarkers(); else chart.setLayers({ [k]: S.layers[k] });
  legendKey = ''; prefs.setIndicators(PANE, S.layers); syncIndicators();
}
{
  const wrap = $('indWrap'), btn = $('indBtn'), panel = $('indPanel');
  const open = v => {
    panel.hidden = !v; btn.setAttribute('aria-expanded', String(v));
    if (v) { const first = panel.querySelector('input'); if (first) first.focus(); }
  };
  btn.addEventListener('click', () => open(panel.hidden));
  panel.addEventListener('change', e => { const c = e.target.closest('input[data-layer]'); if (c) setIndicator(c.dataset.layer, c.checked); });
  document.addEventListener('pointerdown', e => { if (!panel.hidden && !wrap.contains(e.target)) open(false); });
  wrap.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) { e.preventDefault(); open(false); btn.focus(); } });
  wrap.addEventListener('focusout', e => { if (!panel.hidden && e.relatedTarget && !wrap.contains(e.relatedTarget)) open(false); });
}
$('fillAcct').addEventListener('change', e => {
  fillAccount = e.target.value; store.set('live-fill-account-v1', fillAccount); applyMarkers();
});
$('toolTrend').addEventListener('click', () => chart.setTool(chart.getTool() === 'trend' ? null : 'trend'));
$('toolHline').addEventListener('click', () => chart.setTool(chart.getTool() === 'hline' ? null : 'hline'));
$('clearDraw').addEventListener('click', () => chart.clearDrawings());
$('resetBtn').addEventListener('click', () => chart.reset());
syncButtons();

/* order bar */
$('armBtn').addEventListener('click', () => {
  if (FRAMED) { flash(FRAMED_REASON, 'error'); return; }
  if (!TR.enabled) { flash(TR.reason || 'Trading is not enabled.', 'error'); return; }
  setArmed(!TR.armed);
  flash(TR.armed ? 'Armed: one click places an order on ' + TR.account + ', with no confirmation.' : 'Armed off.', TR.armed ? 'warn' : '');
});
$('oAcct').addEventListener('change', e => {
  TR.account = e.target.value;
  if (TR.armed) { setArmed(false); flash('Armed turned off: the account changed.', 'warn'); }
  renderTrading();
});
$('oQty').addEventListener('change', () => {
  const q = $('oQty'), v = Math.round(+q.value);
  if (isFinite(v) && v >= 1) q.value = String(v);
});
/* Order buttons act on a real mouse or touch click only: a key press (Enter or Space on a focused button,
   e.detail 0) never sends an order, and the button gives up focus after a click. */
const pointerOnly = fn => e => { e.currentTarget.blur(); if (e.detail === 0) { flash('Order buttons work by click only, not by keyboard.', 'warn'); return; } fn(e); };
$('buyMkt').addEventListener('click', pointerOnly(() => sendOrder('buy', 'market', null)));
$('sellMkt').addEventListener('click', pointerOnly(() => sendOrder('sell', 'market', null)));
$('sideSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; TR.side = b.dataset.v; renderTrading(); chart.setOrderPreview(previewAt); });
/* Bracket ticks per root: saved as typed (whole numbers 0 to 200; anything else waits), and at once on Enter or
   leaving the box. Each save writes only this root's bracket. */
const bracketSaved = LP.debounce(root => prefs.setBracket(root, brackets[root]), 350);
for (const [id, k] of [['bStop', 'stop'], ['bTarget', 'target']]) {
  $(id).addEventListener('input', e => {
    const v = e.target.value.trim();
    if (!/^\d+$/.test(v) || +v > OT.MAX_BRACKET_TICKS) return;
    brackets[D.root] = OT.cleanBracket(Object.assign({}, brackets[D.root], { [k]: v }));
    bracketSaved(D.root);
  });
  $(id).addEventListener('change', e => {
    brackets[D.root] = OT.cleanBracket(Object.assign({}, brackets[D.root], { [k]: e.target.value }));
    e.target.value = brackets[D.root][k];
    bracketSaved.cancel();
    prefs.setBracket(D.root, brackets[D.root]);
  });
}
/* Anything typed but not yet saved is saved when the page is closed, reloaded or hidden. */
const saveWaiting = () => { saveRange(); bracketSaved.flush(); };      // the chart still redraws when its timer runs
window.addEventListener('pagehide', saveWaiting);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveWaiting(); });
$('flattenBtn').addEventListener('click', pointerOnly(() => {
  if (!ready()) return;
  if (!sameAction('flatten', performance.now())) return;
  send({ type: 'flatten', account: TR.account, root: D.root });
  flash('Flatten sent for ' + TR.account + ' ' + D.root + ': cancel its orders, close the position at market.', '');
}));
$('cancelAllBtn').addEventListener('click', pointerOnly(cancelAll));

/* chart: drag an order label to move it, x to cancel, Shift+click to place (all only while Armed) */
const previewAt = price => {
  const qty = qtyNow();
  return { side: TR.side, kind: OT.placeKind(TR.side, price, lastPrice()), qty: isFinite(qty) ? qty : 0, note: 'click to place' };
};
chart.setOrderPreview(previewAt);
chart.on('orderPlace', e => sendOrder(TR.side, OT.placeKind(TR.side, e.price, lastPrice()), e.price));
chart.on('orderMove', e => {
  if (!ready()) { renderTrading(); return; }
  send({ type: 'change', id: e.id, price: e.price });
  flash('Moving order ' + e.id + ' to ' + U.fmtPrice(e.price, precisionOf()), '');
});
chart.on('orderCancel', e => {
  if (!ready()) return;
  send({ type: 'cancel', id: e.id });
  flash('Cancelling order ' + e.id, '');
});

/* ---------------- status line */
setInterval(() => {
  const f = median(delays.feed), l = median(delays.local);
  $('dFeed').textContent = f === null ? '-' : Math.round(f) + ' ms' + (f < 0 ? ' (PC clock ahead)' : '');
  $('dLocal').textContent = l === null ? '-' : (l < 1 ? '<1' : Math.round(l)) + ' ms';
  const s = chart.stats();
  $('fps').textContent = s.idle ? 'idle' : s.fps + ' fps · ' + s.drawMs.toFixed(1) + ' ms/frame';
  $('ticksSeen').textContent = ticksSeen.toLocaleString() + ' live ticks';
  renderPositionInfo();
}, 500);

if (document.fonts && document.fonts.load) {
  Promise.all([document.fonts.load('500 11px "IBM Plex Mono"'), document.fonts.load('600 10px "IBM Plex Sans Condensed"')]).then(() => chart.setLayers({}), () => {});
}
connect();
})();
