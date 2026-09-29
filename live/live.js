/*
 * Live chart page: connects to ChartBridge (NinjaTrader 8 add-on) and drives chart-engine.
 * Protocol: nt8/PROTOCOL.md. With ChartBridge 0.2 (protocol v1) the page is read only. With protocol v2 it
 * can trade, but only after ChartBridge enables it (trading = true in config.txt, this page signed in with
 * the session token) and only while the Armed switch is on. Armed is off after every page load.
 * ChartBridge 0.3.2 locks this page with a 4-digit PIN (live/pin.js): the page boot waits for the unlock, and only
 * the page (never ChartLive.mount) passes the unlock on its WebSocket URL and GET /session.
 */
/*
 * Saved choices (LivePrefs), in this browser's localStorage. This block also loads in Node, for tests with a
 * stand-in storage; the page code below runs only in a browser. It lives in live.js because nt8/install.ps1
 * copies a fixed list of page files.
 *
 * Every read and write is wrapped: storage can be missing or throw (private windows, blocked site data).
 * Every write changes one field (one setting, one root's range, one indicator on one pane, one bracket stop or
 * target) and reads the key fresh first, so two chart tabs never undo each other's choices (before 1.4.0 each
 * tab wrote its whole in-memory copy back, which put NQ's range back to 20 when another tab saved).
 *
 * Keys (versioned):
 *   live-settings-v2    { root, tf, glide, rangeMode }
 *   live-range-v2       { NQ: 40, ... } range bar size in ticks, per instrument root; only roots set by hand
 *   live-indicators-v1  { <paneId>: { volume, vwap, levels, fills, ib } } indicators on each chart pane (ib: 1.5.3)
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
  { id: 'ib', name: 'IB 1h' },
];
/* What the page showed before any choice was made (1.3), plus the 1-hour Initial Balance (1.5.3); the main pane
   starts here. A main pane saved before 1.5.3 has no ib choice yet and gets this default too. */
const DEFAULT_INDICATORS = { volume: true, vwap: true, levels: true, fills: true, ib: true };
/* A new pane (the grid, next step) starts with no indicators on; Anthony picks them per pane (2026-09-29). */
const NEW_PANE_INDICATORS = { volume: false, vwap: false, levels: false, fills: false, ib: false };
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
    /** Turn one indicator on or off on one pane; the pane's other indicators are read fresh, not overwritten. */
    setIndicator(paneId, id, on) {
      if (!INDICATORS.some(x => x.id === id) || typeof paneId !== 'string' || !paneId) return false;
      const all = obj(KEYS.indicators);
      const cur = cleanIndicators(all[paneId], paneId === MAIN_PANE ? DEFAULT_INDICATORS : NEW_PANE_INDICATORS);
      cur[id] = !!on; all[paneId] = cur;
      return raw.set(KEYS.indicators, all);
    },
    bracket(root) { return obj(KEYS.bracket)[root]; },
    /** Set one bracket field ('stop' or 'target', whole ticks 0 to 200) for one root; the other field is kept. */
    setBracketField(root, field, ticks) {
      if (!ROOTS.includes(root) || (field !== 'stop' && field !== 'target') || !Number.isInteger(ticks) || ticks < 0 || ticks > 200) return false;
      const all = obj(KEYS.bracket);
      const cur = all[root] && typeof all[root] === 'object' && !Array.isArray(all[root]) ? all[root] : {};
      cur[field] = ticks; all[root] = cur;
      return raw.set(KEYS.bracket, all);
    },
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


/*
 * ChartLive: the live chart as a mountable piece. The standalone page (live/index.html, served by ChartBridge) and a
 * host page such as The Desk run this same code:
 *   ChartLive.mount(container, { wsUrl, trading, paneId, storagePrefix, onStatus, brand })  ->  { destroy(), chart, element, paneId }
 * live/EMBED.md lists the files a host loads and what each option does. Everything a chart needs is kept inside
 * the element it creates in `container` (class chart-live, element ids prefixed per mount); the only listeners on
 * document or window are removed again by destroy(), with the timers and the WebSocket.
 * The standalone page boots with <script src="live.js" data-mount="page">: its own ids, trading when ChartBridge
 * allows it, and the storage keys it has always used.
 */
if (typeof document !== 'undefined') (() => {
'use strict';
const CE = window.ChartEngine, U = CE.util, BB = window.BarBuilder, BarBuilder = BB.BarBuilder, OT = window.OrderTicket, LP = window.LivePrefs;
const SESSION = 18 * 3600;
const ROOTS = LP.ROOTS;
const TF = {
  s15: { mode: 'time', sec: 15, label: '15s' }, s30: { mode: 'time', sec: 30, label: '30s' },
  m1: { mode: 'time', sec: 60, label: '1m' }, m5: { mode: 'time', sec: 300, label: '5m' },
  m15: { mode: 'time', sec: 900, label: '15m' }, h1: { mode: 'time', sec: 3600, label: '1h' },
  range: { mode: 'range', sec: 30, label: 'Range' },
};
const GLIDE = { smooth: { candle: 55, fit: 120, follow: 110 }, fast: { candle: 20, fit: 60, follow: 60 }, off: { candle: 0, fit: 0, follow: 0 } };
const SCRIPT = document.currentScript;
const EMBED_PREFIX = 'embed:';            // storage prefix when a host passes none (live/EMBED.md)
let mountCount = 0;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* The chart's markup. `p` prefixes every id ('' on the standalone page, so its ids are the ones it always had).
   Read-only mounts get no order bar and no ARMED pill at all. */
function markup(p, o) {
  const brand = !o.brand ? '' : `
    <div class="brand">
      <div class="logo" aria-hidden="true">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#FFE4EA" stroke-width="2"><path d="M7 4v16M17 4v16"/><rect x="4.5" y="8" width="5" height="7" rx="1"/><rect x="14.5" y="6" width="5" height="9" rx="1"/></svg>
      </div>
      <div class="brand-text"><span class="wordmark">The Desk</span><span class="page-name">Live chart</span></div>
    </div>
`;
  const obar = !o.trading ? '' : `
  <section class="obar" id="${p}obar" aria-label="Order entry" hidden>
    <button type="button" class="arm" id="${p}armBtn" role="switch" aria-checked="false" title="Armed: one click trades, no confirmation. Off after every page load."><span class="knob" aria-hidden="true"></span><span id="${p}armText">Armed off</span></button>
    <label class="ofield"><span class="glabel">Account</span><select class="acct-sel" id="${p}oAcct" aria-label="Trade account"></select></label>
    <label class="ofield"><span class="glabel">Qty</span><input class="oin" id="${p}oQty" type="number" min="1" max="1" step="1" value="1" inputmode="numeric" aria-label="Order quantity"></label>
    <span class="ofield">
      <button type="button" class="obtn buy" id="${p}buyMkt">Buy MKT</button>
      <button type="button" class="obtn sell" id="${p}sellMkt">Sell MKT</button>
    </span>
    <span class="ofield"><span class="glabel" id="${p}sideLabel" title="Shift+click a price on the chart places a limit or stop on this side">Shift+click</span>
      <span class="seg sans side-seg" id="${p}sideSeg" role="group" aria-labelledby="${p}sideLabel"><button type="button" data-v="buy">Buy</button><button type="button" data-v="sell">Sell</button></span></span>
    <span class="ofield"><span class="glabel">Bracket</span>
      <input class="oin" id="${p}bStop" type="number" min="0" max="200" step="1" inputmode="numeric" aria-label="Bracket stop in ticks, 0 for none" title="Stop, ticks from the fill (0 = none)">
      <input class="oin" id="${p}bTarget" type="number" min="0" max="200" step="1" inputmode="numeric" aria-label="Bracket target in ticks, 0 for none" title="Target, ticks from the fill (0 = none)">
      <span class="ounit">stop / target ticks</span></span>
    <span class="ofield">
      <button type="button" class="btn" id="${p}flattenBtn" title="Cancel every working order on this account and instrument, then close the position at market">Flatten</button>
      <button type="button" class="btn" id="${p}cancelAllBtn" title="Cancel every working order on this account and instrument">Cancel all</button>
    </span>
    <span class="ostate"><span class="oinfo" id="${p}oPos"></span><span class="oinfo olegs" id="${p}oLegs"></span><span class="oinfo dim" id="${p}oOther"></span><span class="ooff" id="${p}oOff"></span></span>
  </section>
`;
  const armPill = o.trading ? `<span class="pill armed" id="${p}armPill" hidden>ARMED</span>` : '';
  return `
  <header class="bar">${brand}
    <div class="seg" id="${p}symSeg" role="group" aria-label="Instrument">
      <button type="button" data-v="MNQ">MNQ</button>
      <button type="button" data-v="NQ">NQ</button>
      <button type="button" data-v="MES">MES</button>
      <button type="button" data-v="ES">ES</button>
    </div>

    <div class="group">
      <span class="glabel" id="${p}tfLabel">Bars</span>
      <div class="seg" id="${p}tfSeg" role="group" aria-labelledby="${p}tfLabel">
        <button type="button" data-v="s15">15s</button>
        <button type="button" data-v="s30">30s</button>
        <button type="button" data-v="m1">1m</button>
        <button type="button" data-v="m5">5m</button>
        <button type="button" data-v="m15">15m</button>
        <button type="button" data-v="h1">1h</button>
        <button type="button" data-v="range">Range</button>
      </div>
      <span class="range-box" id="${p}rangeBox" hidden><label class="range-box" for="${p}rangeTicks"><input id="${p}rangeTicks" type="number" min="1" max="400" step="1" inputmode="numeric"><span id="${p}rangeUnit">ticks</span></label>
        <label class="glabel" for="${p}rangeMode">Range style</label>
        <select class="acct-sel range-mode" id="${p}rangeMode" title="NinjaTrader: every bar is exactly the range, like NinjaTrader's Range bars (a jump is filled with bars at prices that may not have traded). Traded prices only: a jump opens the next bar at the traded price, so a bar can end short of the range.">
          <option value="nt">NinjaTrader</option><option value="traded">Traded prices only</option></select></span>
    </div>

    <div class="group">
      <div class="ind" id="${p}indWrap" data-pane="${esc(o.paneId)}">
        <button type="button" class="btn ind-btn" id="${p}indBtn" aria-expanded="false" aria-controls="${p}indPanel">Indicators <span class="ind-count" id="${p}indCount"></span><span class="ind-caret" aria-hidden="true"></span></button>
        <div class="ind-panel" id="${p}indPanel" role="group" aria-label="Indicators on this chart" hidden>
          <label class="ind-row"><input type="checkbox" data-layer="volume"><span class="sw" style="--sw: var(--text3)"></span>Volume</label>
          <label class="ind-row"><input type="checkbox" data-layer="vwap"><span class="sw" style="--sw: var(--vwap-sw)"></span>VWAP</label>
          <label class="ind-row"><input type="checkbox" data-layer="levels"><span class="sw" style="--sw: var(--info)"></span>Levels</label>
          <label class="ind-row"><input type="checkbox" data-layer="fills"><span class="sw" style="--sw: var(--profit)"></span>Fills</label>
          <label class="ind-row"><input type="checkbox" data-layer="ib"><span class="sw" style="--sw: var(--ib-sw)"></span>IB 1h</label>
        </div>
      </div>
      <label class="visually-hidden" for="${p}fillAcct">Show fills from</label>
      <select class="acct-sel" id="${p}fillAcct" title="Which account's fills to show"><option value="">All accounts</option></select>
    </div>

    <div class="group" role="group" aria-label="Drawing tools">
      <button type="button" class="btn" id="${p}toolTrend" aria-pressed="false" title="Trend line: click two points or drag">Trend line</button>
      <button type="button" class="btn" id="${p}toolHline" aria-pressed="false" title="Horizontal line: click a price">Price line</button>
      <button type="button" class="btn" id="${p}clearDraw" title="Remove all drawings on this instrument">Clear</button>
    </div>

    <div class="group">
      <span class="glabel" id="${p}glideLabel">Glide</span>
      <div class="seg sans" id="${p}glideSeg" role="group" aria-labelledby="${p}glideLabel">
        <button type="button" data-v="smooth">Smooth</button>
        <button type="button" data-v="fast">Fast</button>
        <button type="button" data-v="off">Off</button>
      </div>
    </div>

    <span id="${p}colorsHost"></span>
    <button type="button" class="btn" id="${p}resetBtn">Reset view</button>${o.pin ? `
    <button type="button" class="btn" id="${p}pinBtn" title="Change this PC's ChartBridge PIN" hidden>PIN</button>` : ''}
  </header>
${obar}
  <div class="alert" id="${p}alertBar" role="alert" hidden>
    <span class="alert-title">ChartBridge</span><span class="alert-text" id="${p}alertText"></span>
    <button type="button" class="btn" id="${p}alertClose">Dismiss</button>
  </div>

  <main class="stage">
    <div class="chart-box" id="${p}chart" aria-label="Live candlestick chart. Arrow keys pan, plus and minus zoom, End jumps to live, A fits the price axis, Delete removes the selected drawing."></div>
    <div class="legend" id="${p}legend">
      <div class="lg1"><b id="${p}lgName">MNQ</b><span class="tfbadge" id="${p}lgTf">1m</span><span class="dim" id="${p}lgSrc">NinjaTrader via ChartBridge · chart ${esc(CE.VERSION)}</span><span class="pill" id="${p}connPill">CONNECTING</span>${armPill}</div>
      <div class="lg2"><span class="dim" id="${p}lgTime">--:--</span><span>O <span id="${p}lgO">-</span></span><span>H <span id="${p}lgH">-</span></span><span>L <span id="${p}lgL">-</span></span><span>C <span id="${p}lgC">-</span></span><span id="${p}lgChg">-</span><span>Vol <span id="${p}lgV">-</span></span></div>
      <div class="lg3" id="${p}lgRow3"><span id="${p}lgVwWrap">VWAP <span class="vw" id="${p}lgVw">-</span></span><span id="${p}lgFill"></span></div>
    </div>
    <div class="notice" id="${p}notice" hidden>
      <h2 id="${p}noticeTitle">Waiting for ChartBridge</h2>
      <p id="${p}noticeText">Start NinjaTrader with the ChartBridge add-on compiled, then this page connects on its own.</p>
    </div>
  </main>

  <footer class="status" aria-live="off">
    <span>feed <b id="${p}dFeed">-</b></span><span class="sep">·</span>
    <span>local <b id="${p}dLocal">-</b></span><span class="sep">·</span>
    <span id="${p}fps">-</span><span class="sep">·</span>
    <span id="${p}ticksSeen">0 ticks</span>
    <span class="ibnote" id="${p}ibNote" hidden></span>
    <span class="msg" id="${p}statusMsg"></span>
    <span class="ro" id="${p}statusRo">Read only. Orders are placed in NinjaTrader. Live CME data is for this screen only.</span>
  </footer>
`;
}

/* Storage that puts `prefix` in front of every key (LivePrefs and the page only use getItem and setItem). */
function prefixedStorage(storage, prefix) {
  if (!storage || !prefix) return storage;
  return { getItem: k => storage.getItem(prefix + k), setItem: (k, v) => storage.setItem(prefix + k, v) };
}
const pageWsUrl = () => {
  const onBridge = location.protocol.startsWith('http') && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(location.host);
  return onBridge ? 'ws://' + location.host + '/ws' : 'ws://localhost:8765/ws';
};

/**
 * Mount a live chart in `container`. Options (live/EMBED.md):
 *   wsUrl          ChartBridge WebSocket URL, or a function returning one (or a promise of one), called for every
 *                  connect and reconnect. Required.
 *   paneId         key for this chart's indicators and drawings (default 'main').
 *   storagePrefix  put in front of every storage key (default 'embed:'; the standalone page uses '').
 *   onStatus       called with { state, paneId, root, attempt } on every connection state change
 *                  (state: 'connecting', 'loading', 'live' or 'offline').
 *   brand          show The Desk logo and "Live chart" in the toolbar (default false).
 * A mounted chart is always read only, whatever the options say: no GET /session, no auth, no order messages ever,
 * no order bar, no Armed switch, no Shift+click orders, no draggable order lines. Only the standalone page
 * (data-mount="page") can trade, and only when ChartBridge allows it.
 */
function mount(container, options) { return start(container, options || {}, false); }

function start(container, opt, PAGE) {
  if (!container || container.nodeType !== 1) throw new Error('ChartLive.mount needs a container element');
  if (!PAGE && !opt.wsUrl) throw new Error('ChartLive.mount needs options.wsUrl');
  const TRADING = PAGE;                          // trading only on ChartBridge's own page, never through mount()
  const PANE = typeof opt.paneId === 'string' && opt.paneId ? opt.paneId : LP.MAIN_PANE;
  const PREFIX = typeof opt.storagePrefix === 'string' ? opt.storagePrefix : PAGE ? '' : EMBED_PREFIX;
  const onStatus = typeof opt.onStatus === 'function' ? opt.onStatus : null;
  const PIN = PAGE ? window.ChartBridgePin || null : null;   // the page's PIN lock (live/pin.js); never on a mounted chart
  const WS_URL = opt.wsUrl || (PIN ? () => PIN.wsUrl(pageWsUrl()) : pageWsUrl());
  const p = PAGE ? '' : 'chart-live-' + (++mountCount) + '-';

  /* ---------------- this chart's element, lookups, and everything destroy() undoes */
  const rootEl = document.createElement('div');
  rootEl.className = 'chart-live';
  rootEl.innerHTML = markup(p, { trading: TRADING, brand: opt.brand !== undefined ? !!opt.brand : PAGE, paneId: PANE, pin: !!PIN });
  container.appendChild(rootEl);
  const els = {};
  for (const el of rootEl.querySelectorAll('[id]')) if (el.id.startsWith(p)) els[el.id.slice(p.length)] = el;
  const $ = id => els[id] || null;
  let destroyed = false;
  const cleanups = [];                                   // document and window listeners, intervals
  const listen = (target, type, fn) => { target.addEventListener(type, fn); cleanups.push(() => target.removeEventListener(type, fn)); };
  const every = (fn, ms) => { const id = setInterval(fn, ms); cleanups.push(() => clearInterval(id)); };
  const timers = new Set();                              // one-off timers (cancel all pacing)
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); };

  /* Saved choices: read once here, written one field at a time as they change (LivePrefs above). */
  const prefs = LP.create(prefixedStorage((() => { try { return window.localStorage; } catch (e) { return null; } })(), PREFIX));
  const S = Object.assign(prefs.settings(), { layers: prefs.indicators(PANE) });
  const ranges = {};
  for (const r of ROOTS) ranges[r] = prefs.range(r);
  const saveSetting = k => prefs.setSetting(k, S[k]);
  /* Drawings are kept per pane and instrument; the main pane keeps the key the standalone page always used. */
  const drawingsKey = root => 'live-drawings-v1-' + (PANE === LP.MAIN_PANE ? '' : PANE + '-') + root;
  const store = {                                  // single-value keys (fill account, drawings), try/catch inside
    get(k, d) { const v = prefs.raw.get(k); return v === null ? d : v; },
    set(k, v) { prefs.raw.set(k, v); },
  };

  /* exchange clock: New York wall time as bar-time seconds; the offset is refreshed every minute */
  let etOffset = U.zoneSeconds(Date.now() / 1000) - Date.now() / 1000;
  every(() => { etOffset = U.zoneSeconds(Date.now() / 1000) - Date.now() / 1000; }, 60000);
  const etNow = () => Date.now() / 1000 + etOffset;
  const nowMs = () => (performance.timeOrigin || Date.now() - performance.now()) + performance.now();

  const chart = CE.create($('chart'), {
    barSeconds: 60, precision: 2, tick: 0.25,
    session: { start: SESSION, rthStart: 34200, rthEnd: 57600 },
    layers: { volume: S.layers.volume, vwap: S.layers.vwap, levels: S.layers.levels, ib: S.layers.ib, trades: false },
    motion: GLIDE[S.glide], clock: etNow,
  });

  if (PAGE) window.liveChart = chart;  // for tests and the console; order actions still go through the checks below

  /* ---------------- per-instrument data */
  const D = { root: null, name: null, tick: 0.25, ready: false, hist: [], ticks: new BB.TickStore(), m1: null, cur: null, day: null, tickHours: 0, tickFrom: Infinity, trimmed: false,
    lv: [], ib: null, ibKey: '' };
  /* Seconds and range bars are built from ticks; minute and hour bars only need 1-minute history (fast load).
     Range bars need the backfill to reach back to a session start (see rangeHistoryFrom in bar-builder.js). */
  const ticksWanted = () => TF[S.tf].mode === 'range' ? BB.rangeTickHours(etNow(), SESSION) : TF[S.tf].sec < 60 ? 8 : 0;
  const ticksMissing = () => TF[S.tf].mode === 'range' ? BB.rangeNeedsReload(D.tickFrom, etNow(), SESSION, D.trimmed) : TF[S.tf].sec < 60 && D.tickHours === 0;
  let instruments = {};
  const fills = new Map();            // id -> fill, all instruments
  let fillAccount = store.get('live-fill-account-v1', '');   // '' = all accounts
  const accountsSeen = new Set();
  let ticksSeen = 0;
  const delays = { feed: [], local: [] };

  function resetData(root) {
    D.root = root; D.name = root; D.ready = false; D.hist = []; D.ticks = new BB.TickStore(); D.m1 = null; D.cur = null; D.day = null; D.trimmed = false;
    D.lv = []; D.ib = null; D.ibKey = ''; ibNote(null);
    const inst = instruments[root];
    if (inst) { D.name = inst.name; D.tick = inst.tick || 0.25; }
    chart.setPriceFormat({ precision: precisionOf(), tick: D.tick });
    chart.setBars([], { barSeconds: TF[S.tf].sec });
    chart.setLevels([]);
    chart.setDrawings(store.get(drawingsKey(root), []));
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
      D.ticks.feed(D.cur, from);
      const partial = tf.mode === 'range' ? BB.partialStart(D.ticks, from, SESSION) : null;
      if (partial !== null) setStatus('Range bars start at ' + U.fmtHM(partial) + ' ET: NinjaTrader sent less tick history than asked, so bars until the next 18:00 session may differ from NinjaTrader\'s.', '');
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
    D.lv = U.levelLines(lv);
    D.day = U.tradeDay(etNow(), SESSION);
    updateIB(true);
  }

  /*
   * The 1-hour Initial Balance (1.5.3): today's high and low from 9:30:00 up to 10:30:00 ET, dashed and "(forming)"
   * until 10:30:00, then solid. Always from the 1-minute bars (D.m1), whatever the chart shows: every view holds
   * them (history, then built from the live trades), a 1-minute bar never straddles 9:30 or 10:30, and its high and
   * low are exactly those of the trades inside it, so the IB is the same on 1m, seconds, 15m, 1h and Range bars,
   * live or after a reload, here and in a mounted chart. Nothing is drawn when it cannot be exact (the history
   * starts after 9:30) or there is no regular session (weekend, NYSE holiday); the status line says which.
   * Run from updateLevels, on a trade inside the hour that makes a new high or low, and twice a second (the clock
   * crossing 9:30, 10:30 or 18:00). Levels are handed to the chart only when something changed.
   */
  function updateIB(force) {
    if (!D.m1) return;
    const ib = U.initialBalance(D.m1.bars, { asOf: etNow(), sessionStart: SESSION, barSeconds: 60 });
    const key = ib.state + '|' + ib.high + '|' + ib.low + '|' + ib.start;
    D.ib = ib;
    if (!force && key === D.ibKey) return;
    D.ibKey = key;
    chart.setLevels(D.lv.concat(U.ibLines(ib)));
    ibNote(ib);
  }
  const IB_NOTES = {
    uncovered: 'IB 1h not shown: the history starts after 9:30 ET, so the first hour is incomplete.',
    inexact: 'IB 1h not shown: the bars do not line up with 9:30 and 10:30 ET.',
    empty: 'IB 1h not shown: no trades between 9:30 and 10:30 ET today.',
    closed: 'IB 1h: no stock market session today (NYSE holiday).',
  };
  /* A quiet note on the status line, only while the IB indicator is on and the IB cannot be shown for a reason. */
  function ibNote(ib) {
    const el = $('ibNote'); if (!el) return;
    let text = ib && S.layers.ib ? IB_NOTES[ib.state] || '' : '';
    if (ib && ib.state === 'closed') { const wd = new Date(ib.start * 1000).getUTCDay(); if (wd === 0 || wd === 6) text = ''; }   // a weekend needs no note
    el.textContent = text; el.hidden = !text;
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
      D.ticks.feed(D.m1, 0, Math.max(cutoff, lastHist));
    }
    D.ready = true;
    rebuild();
    setConn('live');
    $('notice').hidden = true;
  }

  function onTick(m) {
    if (m.root !== D.root || !D.ready) return;
    const t = m.t, p = m.p, v = m.v || 0;
    D.ticks.push(t, p, v);                             // columns, not one array per trade (TickStore, bar-builder.js)
    if (D.ticks.length > 2500000) { D.ticks.dropFirst(500000); D.tickFrom = D.ticks.time(0) + 0.001; D.trimmed = true; }   // the first session left is partial now
    ticksSeen++;
    const r1 = D.m1.add(t, p, v);
    const tf = TF[S.tf];
    if (tf.mode === 'time' && tf.sec >= 60) chart.update(tf.sec === 60 ? r1.bar : U.foldLast(D.m1.bars, tf.sec));
    else if (D.cur) { const ch = D.cur.add(t, p, v).changed; for (let i = 0; i < ch.length; i++) chart.update(ch[i]); }   // a finished range bar, phantom bars, the new bar
    const now = nowMs();
    pushDelay(delays.feed, m.rx - m.u);
    pushDelay(delays.local, now - m.rx);
    if (r1.isNew && U.tradeDay(t, SESSION) !== D.day) updateLevels();
    else if (D.ib && t >= D.ib.start && t < D.ib.end && (D.ib.high === null || p > D.ib.high || p < D.ib.low)) updateIB(false);
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
  /* The URL is asked for again on every connect when wsUrl is a function (a relay needs a new single-use ticket each
     time). A query string is never shown on screen. */
  let ws = null, wsTries = 0, everConnected = false, reconnectTimer = 0, connectSeq = 0, lastUrl = '';
  const shownUrl = u => u ? String(u).split('?')[0] : 'ChartBridge';

  function connect() {
    reconnectTimer = 0;
    if (destroyed) return;
    setConn('connecting');
    const seq = ++connectSeq;
    let url;
    try { url = typeof WS_URL === 'function' ? WS_URL() : WS_URL; } catch (e) { scheduleReconnect(); return; }
    if (url && typeof url.then === 'function') url.then(u => { if (!destroyed && seq === connectSeq) openSocket(u); }, () => { if (!destroyed && seq === connectSeq) scheduleReconnect(); });
    else openSocket(url);
  }
  function openSocket(url) {
    lastUrl = url ? String(url) : '';
    let sock;
    try { sock = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
    ws = sock;
    sock.onopen = () => { if (sock !== ws) return; wsTries = 0; everConnected = true; setStatus('', ''); };
    sock.onmessage = ev => { if (sock !== ws) return; let m; try { m = JSON.parse(ev.data); } catch (e) { return; } handle(m); };
    sock.onclose = () => { if (sock !== ws) return; ws = null; D.ready = false; setConn('offline'); tradingLost('Not connected to ChartBridge.'); scheduleReconnect(); };
    sock.onerror = () => { /* onclose follows */ };
  }
  function scheduleReconnect() {
    if (destroyed) return;
    wsTries++;
    const wait = Math.min(5000, 500 * wsTries);
    if (!everConnected || wsTries > 2) showNotice(everConnected ? 'Lost ChartBridge' : 'Waiting for ChartBridge',
      'Trying ' + shownUrl(lastUrl) + ' again. Check that NinjaTrader is running and ChartBridge compiled (messages appear in New > NinjaScript Output).');
    reconnectTimer = setTimeout(connect, wait);
  }
  /* Read only: nothing but subscribe and ping ever leaves this chart, whatever calls send. */
  const READ_ONLY_TYPES = ['subscribe', 'ping'];
  function send(obj) {
    if (!TRADING && !READ_ONLY_TYPES.includes(obj && obj.type)) return;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }
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
        $('lgSrc').textContent = 'NinjaTrader via ChartBridge ' + (m.version ? m.version + ' ' : '') + '· chart ' + CE.VERSION;
        syncAccounts(m.accounts || []);
        subscribe(S.root);
        if (m.trading && TRADING) { applyTrading(m.trading); signIn(); }   // protocol v2; ChartBridge 0.2 has no trading field
        break;
      case 'history':
        if (m.root !== D.root) return;
        if (m.name) { D.name = m.name; $('lgName').textContent = m.name; }
        for (const b of m.bars) D.hist.push({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] });
        setStatus('Loading ' + D.root + ' history: ' + D.hist.length.toLocaleString() + ' minutes', '');
        break;
      case 'ticks':
        if (m.root !== D.root) return;
        D.ticks.pushAll(m.ticks);
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
    }
    if (TRADING) switch (m.type) {
      case 'trading': applyTrading(m); if (!TR.signInStarted) signIn(); break;
      case 'orders': TR.orders.clear(); for (const o of m.list || []) if (served(o.root)) TR.orders.set(o.id, o); renderTrading(); break;
      case 'order': onOrder(m); break;
      case 'position': TR.positions.set(m.account + '|' + m.root, { qty: +m.qty || 0, avgPrice: +m.avgPrice || 0 }); renderTrading(); break;
      case 'reject': flash('Refused by ChartBridge: ' + m.reason, 'error'); renderTrading(); break;
    }
  }

  /* ---------------- trading (protocol v2); none of this runs on a read-only chart (TRADING false) */
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
    if (!TRADING) return;
    TR.signInStarted = true;
    if (FRAMED) { applyTrading({ enabled: false, reason: FRAMED_REASON }); return; }
    const sock = ws;
    fetch('/session', { cache: 'no-store', headers: PIN ? PIN.headers() : {} })
      .then(r => r.ok ? r.text() : Promise.reject(new Error('GET /session answered ' + r.status)))
      .then(body => {
        let token = null;
        try { const j = JSON.parse(body); token = typeof j === 'string' ? j : j && j.token; } catch (e) { token = body.trim(); }
        if (!token) throw new Error('no token in GET /session');
        if (sock === ws) send({ type: 'auth', token });
      })
      .catch(e => {
        if (sock !== ws) return;
        if (!PIN) { applyTrading({ enabled: false, reason: 'Could not sign in to ChartBridge (' + e.message + '). Open the chart from ChartBridge itself to trade.' }); return; }
        /* With the PIN (0.3.2): ask ChartBridge again in 2 s. Still unlocked: sign in again. The unlock is gone: drop
           the connection, and the reconnect shows the PIN pad. */
        applyTrading({ enabled: false, reason: 'Signing in to ChartBridge for orders again (' + e.message + ')' });
        later(() => {
          if (destroyed || sock !== ws) return;
          PIN.check().then(st => {
            if (destroyed || sock !== ws) return;
            if (st === 'none' || st === 'set') { try { sock.close(); } catch (err) { /* already closed */ } }
            else signIn();
          });
        }, 2000);
      });
  }
  function applyTrading(t) {
    if (!TRADING) return;
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
    if (!TRADING) return false;
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
    ids.forEach((id, i) => later(() => { if (TR.armed) send({ type: 'cancel', id }); }, Math.floor(i / 8) * 1100));
    flash('Cancelling ' + ids.length + ' order' + (ids.length > 1 ? 's' : '') + ' on ' + TR.account + ' ' + D.root + '.' + keptNote, '');
  }

  function setArmed(on) {
    if (!TRADING) return;
    const v = !!on && TR.enabled;
    TR.armed = v;
    const btn = $('armBtn');
    btn.setAttribute('aria-checked', String(v));
    $('armText').textContent = v ? 'ARMED: one click trades' : 'Armed off';
    $('obar').classList.toggle('armed', v);
    rootEl.classList.toggle('is-armed', v);
    $('armPill').hidden = !v;
    if (PAGE) document.title = v ? 'ARMED · Live Chart' : 'Live Chart';
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
    if (!TRADING || !TR.v2) return;
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
    if (!TRADING) return;
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
    legsEl.classList.toggle('uncovered', !!legs && legs.level === 'error');
    legsEl.classList.toggle('over', !!legs && legs.level === 'warn');
    legsEl.title = legs ? legs.stopLegs + ' stop and ' + legs.targetLegs + ' target order' + (legs.stopLegs + legs.targetLegs === 1 ? '' : 's') + ' working' +
      (legs.stopsShort ? '. Stops cover less than the position.' : legs.level === 'warn' ? '. More than the position: if it all fills, the position reverses.' : '') : '';
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
    if (onStatus) { try { onStatus({ state: map[state] ? state : 'connecting', paneId: PANE, root: D.root || S.root, attempt: wsTries }); } catch (e) { setTimeout(() => { throw e; }); } }
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
  chart.on('drawings', list => store.set(drawingsKey(D.root), list));
  /* A drawing error (1.5.1): the chart keeps running; say so on the status line until a clean frame clears it. */
  const DRAW_ERR = 'Chart drawing error: ';
  chart.on('error', e => {
    if (e) setStatus(DRAW_ERR + e.message + '. The chart keeps running; reload the page if this stays.', 'error');
    else if ($('statusMsg').textContent.startsWith(DRAW_ERR)) setStatus('', '');
  });
  chart.on('tool', t => { $('toolTrend').setAttribute('aria-pressed', String(t === 'trend')); $('toolHline').setAttribute('aria-pressed', String(t === 'hline')); });

  const themePanel = CE.mountThemePanel(chart, $('colorsHost'), {
    storageKey: PREFIX + 'live-colors-v1',
    onChange: () => {
      const T = chart.colors(), st = rootEl.style;
      st.setProperty('--vwap-sw', T.vwapText); st.setProperty('--up-text', T.upText); st.setProperty('--down-text', T.downText);
      // the legend sits on the chart, so it follows the chart's ground (1.5.3); the toolbar and status line stay dark
      st.setProperty('--chart-bg', T.bg); st.setProperty('--lg-bg', T.legendBg); st.setProperty('--lg-head', T.tagText);
      st.setProperty('--lg-text2', T.text2); st.setProperty('--lg-dim', T.axisText); st.setProperty('--lg-buy', T.long); st.setProperty('--lg-sell', T.short);
      rootEl.dataset.ground = T.ground;
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

  /* Range size, per root. The chart rebuilds only when the size is committed (Enter, the arrows, or leaving the box),
     never on a half-typed number (a slow "1" on the way to "12"). While typing, a whole number 1 to 400 is saved a
     moment after the last key, so a reload keeps it; anything else ("450", empty) drops that and puts the committed
     size back in storage. A page closed or reloaded mid-typing saves the box with the same rule as Enter
     (450 becomes 400), never a stale prefix. */
  let rangeTyped = null;                                   // { root, n }: typed, saved, not committed
  const rangeTypedSave = LP.debounce(() => { if (rangeTyped) prefs.setRange(rangeTyped.root, rangeTyped.n); }, 350);
  function rangeTypedDrop() {
    rangeTypedSave.cancel();
    if (rangeTyped) { prefs.setRange(rangeTyped.root, ranges[rangeTyped.root]); rangeTyped = null; }
  }
  function commitRange(root, n) {                          // n from clampRange; null puts the committed size back
    rangeTypedSave.cancel(); rangeTyped = null;
    if (n === null) { prefs.setRange(root, ranges[root]); return false; }
    prefs.setRange(root, n);
    if (ranges[root] === n) return false;
    ranges[root] = n;
    return true;
  }
  $('rangeTicks').addEventListener('input', e => {
    const n = LP.parseRange(e.target.value);
    if (n === null) { rangeTypedDrop(); return; }
    rangeTyped = { root: S.root, n };
    rangeTypedSave();
  });
  $('rangeTicks').addEventListener('change', e => {
    const changed = commitRange(S.root, LP.clampRange(e.target.value));
    e.target.value = ranges[S.root];
    if (changed && S.tf === 'range') rebuild();
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

  /* Indicators: one menu per chart pane, saved per pane id. */
  function syncIndicators() {
    let on = 0;
    for (const c of $('indPanel').querySelectorAll('input[data-layer]')) { c.checked = !!S.layers[c.dataset.layer]; if (c.checked) on++; }
    $('indCount').textContent = on + '/' + LP.INDICATORS.length;
  }
  function setIndicator(k, v) {
    if (!(k in S.layers)) return;
    S.layers[k] = !!v;
    if (k === 'fills') applyMarkers(); else chart.setLayers({ [k]: S.layers[k] });
    if (k === 'ib') ibNote(D.ib);
    legendKey = ''; prefs.setIndicator(PANE, k, S.layers[k]); syncIndicators();
  }
  {
    const wrap = $('indWrap'), btn = $('indBtn'), panel = $('indPanel');
    const open = v => {
      panel.hidden = !v; btn.setAttribute('aria-expanded', String(v));
      if (v) { const first = panel.querySelector('input'); if (first) first.focus(); }
    };
    btn.addEventListener('click', () => open(panel.hidden));
    panel.addEventListener('change', e => { const c = e.target.closest('input[data-layer]'); if (c) setIndicator(c.dataset.layer, c.checked); });
    listen(document, 'pointerdown', e => { if (!panel.hidden && !wrap.contains(e.target)) open(false); });
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
  if (PIN) { $('pinBtn').hidden = !PIN.active(); $('pinBtn').addEventListener('click', () => PIN.openChange()); }
  syncButtons();

  /* order bar and order actions on the chart: only on a trading chart (a read-only one has no order bar at all) */
  const bracketSaved = LP.debounce((root, k) => prefs.setBracketField(root, k, brackets[root][k]), 350);
  const previewAt = price => {
    const qty = qtyNow();
    return { side: TR.side, kind: OT.placeKind(TR.side, price, lastPrice()), qty: isFinite(qty) ? qty : 0, note: 'click to place' };
  };
  if (TRADING) {
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
       leaving the box. Each save writes only this one field (stop or target) for this root. */
    for (const [id, k] of [['bStop', 'stop'], ['bTarget', 'target']]) {
      $(id).addEventListener('input', e => {
        const v = e.target.value.trim();
        if (!/^\d+$/.test(v) || +v > OT.MAX_BRACKET_TICKS) return;
        brackets[D.root] = OT.cleanBracket(Object.assign({}, brackets[D.root], { [k]: v }));
        bracketSaved(D.root, k);
      });
      $(id).addEventListener('change', e => {
        brackets[D.root] = OT.cleanBracket(Object.assign({}, brackets[D.root], { [k]: e.target.value }));
        e.target.value = brackets[D.root][k];
        bracketSaved.cancel();
        prefs.setBracketField(D.root, k, brackets[D.root][k]);
      });
    }
    $('flattenBtn').addEventListener('click', pointerOnly(() => {
      if (!ready()) return;
      if (!sameAction('flatten', performance.now())) return;
      send({ type: 'flatten', account: TR.account, root: D.root });
      flash('Flatten sent for ' + TR.account + ' ' + D.root + ': cancel its orders, close the position at market.', '');
    }));
    $('cancelAllBtn').addEventListener('click', pointerOnly(cancelAll));

    /* chart: drag an order label to move it, x to cancel, Shift+click to place (all only while Armed) */
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
  }

  /* Anything typed but not yet saved is saved when the page is closed, reloaded or hidden, and on destroy(). */
  const saveWaiting = () => {
    const box = $('rangeTicks');
    if (document.activeElement === box) {                  // mid-typing: save what Enter would commit
      const n = LP.clampRange(box.value);
      rangeTypedSave.cancel(); rangeTyped = null;
      prefs.setRange(S.root, n === null ? ranges[S.root] : n);
    }
    bracketSaved.flush();
  };
  listen(window, 'pagehide', saveWaiting);
  listen(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') saveWaiting(); });

  /* ---------------- status line */
  every(() => {
    const f = median(delays.feed), l = median(delays.local);
    $('dFeed').textContent = f === null ? '-' : Math.round(f) + ' ms' + (f < 0 ? ' (PC clock ahead)' : '');
    $('dLocal').textContent = l === null ? '-' : (l < 1 ? '<1' : Math.round(l)) + ' ms';
    const s = chart.stats();
    $('fps').textContent = s.idle ? 'idle' : s.fps + ' fps · ' + s.drawMs.toFixed(1) + ' ms/frame';
    $('ticksSeen').textContent = ticksSeen.toLocaleString() + ' live ticks';
    renderPositionInfo();
    if (D.ready) updateIB(false);                  // the clock crossing 9:30, 10:30 or 18:00, with or without trades
  }, 500);

  if (document.fonts && document.fonts.load) {
    Promise.all([document.fonts.load('500 11px "IBM Plex Mono"'), document.fonts.load('600 10px "IBM Plex Sans Condensed"')]).then(() => { if (!destroyed) chart.setLayers({}); }, () => {});
  }
  connect();

  /* ---------------- take it all down: socket, timers, listeners, the chart and its element */
  function destroy() {
    if (destroyed) return;
    try { saveWaiting(); } catch (e) { /* storage blocked */ }
    destroyed = true;
    clearTimeout(reconnectTimer); clearTimeout(flashTimer);
    for (const id of timers) clearTimeout(id);
    timers.clear();
    rangeTypedSave.cancel(); bracketSaved.cancel();
    for (const undo of cleanups.splice(0).reverse()) undo();
    const sock = ws; ws = null; connectSeq++;
    if (sock) { sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null; try { sock.close(); } catch (e) { /* already closed */ } }
    themePanel.destroy();
    chart.destroy();
    if (PAGE && window.liveChart === chart) delete window.liveChart;
    rootEl.remove();
  }
  return { destroy, chart, element: rootEl, paneId: PANE };
}

window.ChartLive = { mount, EMBED_PREFIX };
/* The standalone page: behind ChartBridge's PIN (live/pin.js) when ChartBridge has one, nothing started until unlocked. */
if (SCRIPT && SCRIPT.getAttribute('data-mount') === 'page') {
  if (window.ChartBridgePin) window.ChartBridgePin.gate().then(() => start(document.body, {}, true));
  else start(document.body, {}, true);
}
})();
