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
 *   live-indicators-v2  { <paneId>: { ind: { <id>: { on, shown, pin } }, recent: [ids], restore: [ids] | null } }
 *                       the Indicators menu per chart pane (1.6.0): on = on this chart, shown = drawn (hidden keeps it on
 *                       the chart), pin = a chip on the pane's strip; the last 5 used; what Hide all hid, for Restore
 *   live-indicator-options-v1  { <paneId>: { vp: { session: 'full' | 'rth' }, delta: { show: 'cum' | 'bar' } } } an
 *                       indicator's own options, per pane (INDICATOR_OPTIONS, 1.6.0; the volume profile's hours, and
 *                       since 1.7.0 what the delta pane shows)
 *   live-pane-heights-v1  { <paneId>: { delta: 0.2 } } the delta pane's share of the chart height, per pane (1.7.0)
 *   live-bracket-v1     { MNQ: { stop, target }, ... } (format unchanged since 1.3.0)
 * The 1.3 keys live-settings-v1 and live-range-v1, and 1.4 to 1.5.3's live-indicators-v1 ({ <paneId>: { volume, vwap,
 * levels, fills, ib } }), are read once, when the new keys do not exist yet, and left in place.
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
/*
 * The indicators (1.6.0 menu). `id` is also the chart layer (fills: the fill marks). Listed in the order the menu's
 * "On this chart" group and the chip strip show them. `sw` is the CSS color of the swatch; `short` is the chip text and
 * `letter` the chip on a narrow pane; `alias` holds the short names search matches; `opt` is the read-only setting the
 * gear shows (only what the chart really does; the account whose fills are marked is the one account picker's).
 */
const INDICATORS = [
  { id: 'volume', name: 'Volume bars', short: 'VOL', letter: 'V', cat: 'volume', sw: 'var(--text3)', alias: 'vol volume bars',
    opt: 'Bottom 16% of the plot, in the candle colors' },
  { id: 'vwap', name: 'VWAP', short: 'VWAP', letter: 'W', cat: 'price', sw: 'var(--vwap-sw)', alias: 'vwap',
    opt: 'Session VWAP from 18:00 ET; its color is in Colors' },
  { id: 'levels', name: 'Levels', short: 'LEVELS', letter: 'L', cat: 'price', sw: 'var(--info)',
    alias: 'levels pdh pdl onh onl prior day high low close pc overnight vah val value area',
    opt: 'Prior day high, low, close and value area; overnight high and low' },
  { id: 'ib', name: 'Initial balance', short: 'IB', letter: 'I', cat: 'price', sw: 'var(--ib-sw)', alias: 'ib ibh ibl initial balance 1h',
    opt: '1 hour, locks 10:30 ET' },
  { id: 'vp', name: 'Volume profile', short: 'PROFILE', letter: 'P', cat: 'volume', sw: 'var(--vp-sw)',
    alias: 'vp volume profile poc vah val value area',
    opt: 'Traded volume per price at the right edge: 1-tick rows, the point of control and the 70% value area' },
  { id: 'delta', name: 'Cumulative delta', short: 'DELTA', letter: 'D', cat: 'volume', sw: 'var(--delta-sw)',
    alias: 'delta cd cvd cumulative order flow',
    opt: 'Market buys minus market sells from 18:00 ET, in a pane below the chart; each trade\'s side comes from ChartBridge 0.3.4. Drag the line above the pane (or focus it and use the arrow keys) to resize it.' },
  { id: 'fills', name: 'Fills', short: 'FILLS', letter: 'F', cat: 'trades', sw: 'var(--profit)', alias: 'fills executions trades',
    opt: 'Past fills and trade marks of the account picked (side and size at the fill price). Hiding them never hides the open trade: its entry fills, the position line, working orders and stop and target lines stay.' },
];
/* Listed in the menu, tagged "coming" and not selectable until they exist (none since the volume profile, 1.6.0, and
   the cumulative delta, 1.7.0). */
const COMING = [];
const CATEGORIES = [{ id: 'price', name: 'Price' }, { id: 'volume', name: 'Volume' }, { id: 'trades', name: 'Trades' }];
const IND_IDS = INDICATORS.map(x => x.id);
const RECENT_MAX = 5;
/* The chip strip holds at most 6 pinned indicators (Anthony, 2026-09-29). Read through the exported object, so a
   smoke test can lower it. */
let api = null;
const pinMax = () => (api ? api.PIN_MAX : 6);
/* What the page showed before any choice was made (1.3), plus the 1-hour Initial Balance (1.5.3); the main pane
   starts here, each on the chart, shown and pinned to the chip strip. */
const DEFAULT_INDICATORS = { volume: true, vwap: true, levels: true, fills: true, ib: true, vp: false, delta: true };   // the profile: off on every pane; the delta pane (1.7.0): on for the main pane (Anthony)
/* A new pane (the grid, next step) starts with no indicators on; Anthony picks them per pane (2026-09-29). */
const NEW_PANE_INDICATORS = { volume: false, vwap: false, levels: false, fills: false, ib: false, vp: false, delta: false };
/* The main pane's own five up to 1.5.3, which a pane saved by 1.4 to 1.5.3 lists (paneFromV1). */
const V1_LISTED = ['volume', 'vwap', 'levels', 'fills', 'ib'];
/*
 * Options an indicator has besides on and off, each a list of allowed values with the default first (set in its gear
 * panel). The volume profile: the full session from 18:00 ET, or RTH 9:30 to 16:00 ET, 13:00 on NYSE early closes
 * (Anthony's ruling 2026-09-29). The delta pane (1.7.0): the running cumulative as candles ('cum'), or each bar's own
 * buys minus sells around zero ('bar') (Anthony's ruling 2026-09-30).
 */
const INDICATOR_OPTIONS = { vp: { session: ['full', 'rth'] }, delta: { show: ['cum', 'bar'] } };
/* The delta pane's height (1.7.0), a share of the chart height, per pane: the default and the least and most kept,
   read from the engine (PANE_RATIO, PANE_RATIO_MIN, PANE_RATIO_MAX; review N8), which also keeps both panes at least a
   few rows tall. The engine loads before this file (live/EMBED.md); in Node it is required. */
const ENGINE = typeof self !== 'undefined' && self.ChartEngine ? self.ChartEngine : require('../src/chart-engine.js');
const PANE_HEIGHTS = { delta: { def: ENGINE.PANE_RATIO, min: ENGINE.PANE_RATIO_MIN, max: ENGINE.PANE_RATIO_MAX } };
/* On by default without a chip (review N5): the main pane's strip keeps the five chips of 1.6.0, so an indicator added
   (the volume profile) still gets the sixth; pinning the delta pane gives it one like any other. */
const UNPINNED_BY_DEFAULT = ['delta'];
const MAIN_PANE = 'main';

const KEYS = { settings: 'live-settings-v2', range: 'live-range-v2', indicators: 'live-indicators-v2', bracket: 'live-bracket-v1', indicatorOptions: 'live-indicator-options-v1',
  paneHeights: 'live-pane-heights-v1' };
const OLD = { settings: 'live-settings-v1', range: 'live-range-v1', indicators: 'live-indicators-v1' };

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

/* The 1.4 to 1.5.3 per-pane flags (live-indicators-v1): known ids only, booleans only, the rest from `base`. */
function cleanIndicators(v, base) {
  const out = Object.assign({}, base || NEW_PANE_INDICATORS);
  if (v && typeof v === 'object') for (const k of Object.keys(out)) if (typeof v[k] === 'boolean') out[k] = v[k];
  return out;
}

const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
/* An indicator's options: the saved values that are allowed, the defaults for the rest ({} for an unknown id).
   Only own properties count (review S5): 'toString' or '__proto__' is never an indicator, an option or a value. */
function cleanIndicatorOptions(id, v) {
  const spec = own(INDICATOR_OPTIONS, id) ? INDICATOR_OPTIONS[id] : {}, out = {};
  for (const k of Object.keys(spec)) out[k] = own(v, k) && spec[k].includes(v[k]) ? v[k] : spec[k][0];
  return out;
}
/** Whether `value` is an allowed value of option `key` of indicator `id` (own properties only). */
function indicatorOptionAllowed(id, key, value) {
  return own(INDICATOR_OPTIONS, id) && own(INDICATOR_OPTIONS[id], key) && INDICATOR_OPTIONS[id][key].includes(value);
}

/*
 * One pane's indicator state (1.6.0): { ind: { <id>: { on, shown, pin } }, recent: [ids], restore: [ids] | null }.
 *   on      on this chart (listed under "On this chart"); off means it waits in its group with a + to add it
 *   shown   drawn; a hidden one stays on the chart with everything it had (the switch, a chip, Hide all)
 *   pin     a chip on the pane's strip (only while it is on the chart); one added gets a chip while the strip has
 *           fewer than 6 (pinMax), and pinning by hand is refused when it is full
 *   recent  the last 5 used from the menu, newest first
 *   restore what Hide all hid, so Restore brings back that same mix (cleared by any other show or hide)
 * The functions below never change the state they are given; they return a new one.
 */
const isList = v => Array.isArray(v);
function defaultPane(paneId) {
  const main = paneId === MAIN_PANE, ind = {};
  for (const id of IND_IDS) { const on = main && DEFAULT_INDICATORS[id]; ind[id] = { on, shown: true, pin: on && !UNPINNED_BY_DEFAULT.includes(id) }; }
  return { ind, recent: [], restore: null };
}
function cleanIdList(v, max) {
  if (!isList(v)) return [];
  const out = [];
  for (const id of v) if (IND_IDS.includes(id) && !out.includes(id)) out.push(id);
  return max ? out.slice(0, max) : out;
}
function cleanPane(v, paneId) {
  const out = defaultPane(paneId);
  if (!v || typeof v !== 'object' || isList(v)) return out;
  const ind = v.ind && typeof v.ind === 'object' && !isList(v.ind) ? v.ind : {};
  for (const id of IND_IDS) {
    const x = ind[id];
    if (!x || typeof x !== 'object') continue;
    for (const f of ['on', 'shown', 'pin']) if (typeof x[f] === 'boolean') out.ind[id][f] = x[f];
  }
  out.recent = cleanIdList(v.recent, RECENT_MAX);
  out.restore = isList(v.restore) ? cleanIdList(v.restore) : null;
  /* 1.7.0 (Anthony): a main pane saved before the delta pane existed has no delta key, so it gets the delta pane on,
     with no chip (review N5). Saved after Hide all (nothing shown, a Restore mix kept), it comes back as it was: the
     delta pane hidden with the rest, and Restore brings back the old mix with the delta pane (review N6). An explicit
     entry (off, hidden, pinned) is kept as it is. */
  if (paneId === MAIN_PANE && !(own(ind, 'delta') && ind.delta && typeof ind.delta === 'object')) {
    const hiddenAll = !!out.restore && out.restore.length > 0 && !IND_IDS.some(id => id !== 'delta' && out.ind[id].on && out.ind[id].shown);
    out.ind.delta = { on: true, shown: !hiddenAll, pin: false };
    if (hiddenAll && !out.restore.includes('delta')) out.restore = out.restore.concat('delta');
  }
  return out;
}
/*
 * A pane saved by 1.4 to 1.5.3 (live-indicators-v1), carried over so every indicator draws exactly as before; an
 * explicit off stays off. The main pane listed all five as its own, so each stays on the chart: the ones that were
 * off are hidden (one click brings one back, as before) and all five are pinned. Any other pane started empty, so
 * only the ones that were on are on its chart (pinned); an off there is off, as on a new pane. The volume profile is
 * read like the others: a 1.5.3 save never has a vp key, so it starts off after upgrading from 1.5.3; a save from the
 * unreleased profile test build that had it on keeps it on (shown and pinned, the main pane's sixth chip). The delta
 * pane (1.7.0) is on for the main pane, shown, with no chip (review N5); off on every other pane.
 */
function paneFromV1(v1, paneId) {
  const main = paneId === MAIN_PANE;
  const flags = cleanIndicators(v1, main ? DEFAULT_INDICATORS : NEW_PANE_INDICATORS);
  const out = defaultPane(paneId);
  for (const id of IND_IDS) {
    const listed = main && V1_LISTED.includes(id);                 // the main pane's own five (never the volume profile)
    out.ind[id] = listed ? { on: true, shown: flags[id], pin: true } : { on: flags[id], shown: true, pin: flags[id] };
  }
  /* 1.7.0: the main pane gets the delta pane on (Anthony), like a 1.6.0 save without it, with no chip (review N5) */
  if (main) out.ind.delta = { on: true, shown: true, pin: false };
  return out;
}
function copyPane(st) {
  const ind = {};
  for (const id of IND_IDS) ind[id] = Object.assign({}, st.ind[id]);
  return { ind, recent: st.recent.slice(), restore: st.restore ? st.restore.slice() : null };
}
const touch = (st, id) => { st.recent = [id].concat(st.recent.filter(x => x !== id)).slice(0, RECENT_MAX); };
const pinnedCount = st => IND_IDS.filter(id => st.ind[id].on && st.ind[id].pin).length;
/* On the chart and shown (in a copy): one that was off gets a chip while the strip has room. */
function putOn(n, id) {
  const x = n.ind[id];
  if (!x.on) { x.pin = pinnedCount(n) < pinMax(); x.on = true; }
  x.shown = true;
}
const Pane = {
  /** Chips on the strip now (pinned and on the chart), and whether it is full. */
  pinned(st) { return pinnedCount(st); },
  pinFull(st) { return pinnedCount(st) >= pinMax(); },
  /** Drawn or not, per indicator: what the chart shows. */
  drawn(st) { const out = {}; for (const id of IND_IDS) out[id] = !!(st.ind[id].on && st.ind[id].shown); return out; },
  /** { shown, hidden, on } counts for the button ("shown/on") and the menu. */
  counts(st) {
    let shown = 0, on = 0;
    for (const id of IND_IDS) if (st.ind[id].on) { on++; if (st.ind[id].shown) shown++; }
    return { shown, on, hidden: on - shown };
  },
  /*
   * The changes, each with a fixed result (review S1): the page works out what a click means from what it shows, then
   * applies the same absolute change to its own state and to the state read fresh from storage, so a tab never saves
   * the opposite of what it shows when another tab changed the same pane.
   */
  /** Put it on the chart, shown (a chip while the strip has room; one already on keeps its chip). A recent use. */
  add(st, id, recent) {
    if (!IND_IDS.includes(id)) return st;
    const n = copyPane(st);
    putOn(n, id);
    if (recent !== false) touch(n, id);
    n.restore = null;
    return n;
  },
  /** Show or hide one that is on the chart (a chip, or the menu's switch with `recent`). */
  setShown(st, id, shown, recent) {
    if (!IND_IDS.includes(id) || !st.ind[id].on) return st;
    const n = copyPane(st);
    n.ind[id].shown = !!shown; n.restore = null;
    if (recent) touch(n, id);
    return n;
  },
  /** Hide these (Hide all) and remember them for Restore. */
  hideIds(st, ids) {
    const list = cleanIdList(ids).filter(id => st.ind[id].on);
    if (!list.length) return st;
    const n = copyPane(st);
    for (const id of list) n.ind[id].shown = false;
    n.restore = list;
    return n;
  },
  /** Show these again (Restore). */
  showIds(st, ids) {
    const n = copyPane(st);
    for (const id of cleanIdList(ids)) putOn(n, id);              // shown here means shown after a reload too (review 2, N7)
    n.restore = null;
    return n;
  },
  /** What the switch, +, a Recent button mean now: add it when it is not on the chart, else show or hide it. */
  toggleOp(st, id) {
    if (!IND_IDS.includes(id)) return x => x;
    if (!st.ind[id].on || !st.ind[id].shown) return x => Pane.add(x, id);   // showing writes on and shown, whatever another tab did
    return x => Pane.setShown(x, id, false, true);
  },
  /** What Hide all means now: hide the shown ones, or with none shown bring back what it hid (Restore). */
  hideAllOp(st) {
    const ids = IND_IDS.filter(id => st.ind[id].on && st.ind[id].shown);
    if (ids.length) return x => Pane.hideIds(x, ids);
    const back = st.restore ? st.restore.filter(id => st.ind[id].on) : [];
    if (back.length) return x => Pane.showIds(x, back);
    return x => x;
  },
  toggle(st, id) { return Pane.toggleOp(st, id)(st); },
  hideAll(st) { return Pane.hideAllOp(st)(st); },
  /** The x: take it off the chart (added again, it gets a chip again while the strip has room). */
  remove(st, id) {
    if (!IND_IDS.includes(id)) return st;
    const n = copyPane(st);
    n.ind[id].on = false; n.ind[id].shown = true;
    if (n.restore) { n.restore = n.restore.filter(x => x !== id); if (!n.restore.length) n.restore = null; }
    return n;
  },
  /** Pin or unpin; pinning one that is on the chart while the strip is full is refused (the same state comes back). */
  pin(st, id, pinned) {
    if (!IND_IDS.includes(id)) return st;
    const v = pinned === undefined ? !st.ind[id].pin : !!pinned;
    if (v && !st.ind[id].pin && st.ind[id].on && pinnedCount(st) >= pinMax()) return st;
    const n = copyPane(st);
    n.ind[id].pin = v;
    return n;
  },
  /** The footer button's label: "Hide all (n)", or "Restore" when Hide all left nothing shown. */
  hideLabel(st) {
    const c = Pane.counts(st);
    return c.shown ? 'Hide all (' + c.shown + ')' : st.restore && st.restore.some(id => st.ind[id].on) ? 'Restore' : 'Hide all (0)';
  },
};

/* Search: every word typed must be found in the name, the chip text or a short name ("vw", "ib", "pdh", "vol"). */
function searchIndicators(q) {
  const words = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return INDICATORS.concat(COMING).filter(d => {
    const hay = (d.name + ' ' + d.short + ' ' + d.alias).toLowerCase();
    return words.every(w => hay.includes(w));
  });
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
      if (!raw.has(OLD.indicators) && !raw.has(KEYS.indicators) && s.layers) raw.set(OLD.indicators, { [MAIN_PANE]: cleanIndicators(s.layers, DEFAULT_INDICATORS) });
    }
    if (!raw.has(KEYS.range)) {
      const r = obj(OLD.range), next = {};
      for (const root of ROOTS) { const n = parseRange(r[root]); if (n !== null) next[root] = n; }
      raw.set(KEYS.range, next);
    }
    /* 1.6.0: each pane saved by 1.4 to 1.5.3 carried over once (paneFromV1); panes never saved keep their defaults.
       A damaged live-indicators-v2 is carried over from v1 again rather than read as the defaults (review N3). */
    const v2 = raw.get(KEYS.indicators);
    if (!v2 || typeof v2 !== 'object' || isList(v2)) {             // none yet, or damaged (not JSON): carry v1 over (again)
      const v1 = raw.get(OLD.indicators);
      if (v1 && typeof v1 === 'object' && !isList(v1)) {
        const next = {};
        for (const paneId of Object.keys(v1)) if (paneId && v1[paneId] && typeof v1[paneId] === 'object' && !isList(v1[paneId])) next[paneId] = paneFromV1(v1[paneId], paneId);
        raw.set(KEYS.indicators, next);
      }
    }
  }
  migrate();
  const paneOk = paneId => typeof paneId === 'string' && !!paneId && !Object.prototype.hasOwnProperty.call(Object.prototype, paneId);

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
    /** One pane's indicator state (see Pane above): the saved one, else the pane's default. */
    pane(paneId) { return cleanPane(paneOk(paneId) ? obj(KEYS.indicators)[paneId] : null, paneId); },
    /** Drawn or not per indicator on a pane. */
    indicators(paneId) { return Pane.drawn(this.pane(paneId)); },
    /**
     * Change one pane: read the key fresh, apply `fn` (one of the Pane functions) to that pane's saved state and write it
     * back, so a change made in another tab (another pane, or another indicator on this one) is never undone.
     */
    updatePane(paneId, fn) {
      if (!paneOk(paneId) || typeof fn !== 'function') return false;
      const all = obj(KEYS.indicators);
      all[paneId] = fn(cleanPane(all[paneId], paneId));
      return raw.set(KEYS.indicators, all);
    },
    /** One indicator's options on one pane, e.g. indicatorOptions('main', 'vp') -> { session: 'full' }. */
    indicatorOptions(paneId, id) {
      const all = obj(KEYS.indicatorOptions), pane = own(all, paneId) ? all[paneId] : null;
      return cleanIndicatorOptions(id, own(pane, id) ? pane[id] : null);
    },
    /** Set one option of one indicator on one pane (read fresh, only that field written); false when not allowed. */
    setIndicatorOption(paneId, id, key, value) {
      if (!indicatorOptionAllowed(id, key, value) || typeof paneId !== 'string' || !paneId) return false;
      // fresh objects with no prototype, filled from own properties only: a pane id such as '__proto__' is a plain
      // key here, never Object.prototype (review S5)
      const all = Object.assign(Object.create(null), obj(KEYS.indicatorOptions));
      const saved = own(all, paneId) && all[paneId] && typeof all[paneId] === 'object' && !Array.isArray(all[paneId]) ? all[paneId] : null;
      const pane = Object.assign(Object.create(null), saved);
      pane[id] = Object.assign(cleanIndicatorOptions(id, own(pane, id) ? pane[id] : null), { [key]: value });
      all[paneId] = pane;
      return raw.set(KEYS.indicatorOptions, all);
    },
    /** The delta pane's height on one pane (1.7.0): its saved share of the chart height, else the default (0.2). */
    paneHeight(paneId, id) {
      if (!own(PANE_HEIGHTS, id)) return null;
      const all = obj(KEYS.paneHeights), pane = own(all, paneId) ? all[paneId] : null, v = own(pane, id) ? pane[id] : null, lim = PANE_HEIGHTS[id];
      return typeof v === 'number' && isFinite(v) && v >= lim.min && v <= lim.max ? v : lim.def;
    },
    /** Save it (read fresh, only this pane's field written; kept between the least and most); false when not allowed. */
    setPaneHeight(paneId, id, ratio) {
      if (!own(PANE_HEIGHTS, id) || typeof paneId !== 'string' || !paneId || typeof ratio !== 'number' || !isFinite(ratio)) return false;
      const lim = PANE_HEIGHTS[id], all = Object.assign(Object.create(null), obj(KEYS.paneHeights));   // no prototype: '__proto__' is a plain key
      const saved = own(all, paneId) && all[paneId] && typeof all[paneId] === 'object' && !Array.isArray(all[paneId]) ? all[paneId] : null;
      const pane = Object.assign(Object.create(null), saved);
      pane[id] = Math.round(Math.min(lim.max, Math.max(lim.min, ratio)) * 1000) / 1000;
      all[paneId] = pane;
      return raw.set(KEYS.paneHeights, all);
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

api = { create, debounce, parseRange, clampRange, cleanIndicators, cleanIndicatorOptions, indicatorOptionAllowed, INDICATOR_OPTIONS, PANE_HEIGHTS, cleanPane, defaultPane, paneFromV1, Pane, searchIndicators, KEYS, OLD, ROOTS, TFS, GLIDES, RANGE_MODES,
  DEFAULT_RANGE, INDICATORS, COMING, CATEGORIES, RECENT_MAX, PIN_MAX: 6, DEFAULT_INDICATORS, NEW_PANE_INDICATORS, MAIN_PANE, RANGE_MIN, RANGE_MAX };
return api;
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
/* The "/" key opens the Indicators menu of the chart under the mouse (1.6.0): each mounted chart notes when the pointer
   is over it. */
let hoverRoot = null;
const mountedRoots = new Set();
/* Charts on one page that share a storage prefix follow each other's account pick (review 2, N6). */
const accountPeers = new Set();

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
  <div class="obar-ground"><section class="obar" id="${p}obar" aria-label="Order entry" hidden>
    <button type="button" class="arm" id="${p}armBtn" role="switch" aria-checked="false" title="Armed: one click trades, no confirmation. Off after every page load."><span class="knob" aria-hidden="true"></span><span id="${p}armText">Armed off</span></button>
    <label class="ofield"><span class="glabel">Account</span><select class="acct-sel acct-main" id="${p}oAcct" aria-label="Account: orders go to it and the chart marks its fills" title="Orders go to this account, and the chart marks its fills"></select></label>
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
  </section></div>
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

    <div class="group acct-pick" id="${p}acctWrap" hidden>
      <label class="glabel" for="${p}acctPick">Account</label>
      <select class="acct-sel acct-compact" id="${p}acctPick" title="The chart marks this account's fills"></select>
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

    <div class="group ind-group">
      <div class="ind" id="${p}indWrap" data-pane="${esc(o.paneId)}">
        <button type="button" class="btn ind-btn" id="${p}indBtn" aria-expanded="false" aria-controls="${p}indPanel" aria-haspopup="dialog" title="Indicators on this chart (/ with the mouse over the chart)">Indicators <span class="ind-count" id="${p}indCount"></span><span class="ind-caret" aria-hidden="true"></span></button>
        <div class="ind-panel" id="${p}indPanel" role="dialog" aria-label="Indicators on this chart" hidden>
          <div class="ind-head"><span class="ind-title">Indicators</span><span class="ind-sum" id="${p}indSum"></span></div>
          <div class="ind-search">
            <label class="visually-hidden" for="${p}indQ">Search indicators</label>
            <input id="${p}indQ" type="text" placeholder="Search: vwap, ib, pdh, profile" autocomplete="off" spellcheck="false" data-f="q">
            <kbd aria-hidden="true" title="Press / with the mouse over the chart to open this menu">/</kbd>
          </div>
          <div class="visually-hidden" id="${p}indLive" role="status" aria-live="polite"></div>
          <div class="ind-body" id="${p}indBody"></div>
          <div class="ind-sep"></div>
          <div class="ind-foot"><button type="button" class="btn" id="${p}indHideAll" data-f="hideall"></button></div>
        </div>
      </div>
      <div class="ind-chips" id="${p}indChips" role="group" aria-label="Pinned indicators: click to show or hide"></div>
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
      <div class="lg3" id="${p}lgRow3"><span id="${p}lgVwWrap">VWAP <span class="vw" id="${p}lgVw">-</span></span><span id="${p}lgVp" hidden>POC <span class="vpc" id="${p}lgPoc">-</span> · VA <span id="${p}lgVal">-</span> to <span id="${p}lgVah">-</span></span><span id="${p}lgDelta" hidden><span id="${p}lgDl">Delta</span> <span class="dv" id="${p}lgDv">-</span><span class="dunk" id="${p}lgDu" hidden></span></span><span id="${p}lgFill"></span></div>
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
    <span class="ibnote" id="${p}vpNote" hidden></span>
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
  let IS = prefs.pane(PANE);                            // this pane's indicators (LivePrefs.Pane): on the chart, shown, pinned
  const S = Object.assign(prefs.settings(), { layers: LP.Pane.drawn(IS), options: { vp: prefs.indicatorOptions(PANE, 'vp'), delta: prefs.indicatorOptions(PANE, 'delta') } });   // layers: what is drawn
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
    layers: { volume: S.layers.volume, vwap: S.layers.vwap, levels: S.layers.levels, ib: S.layers.ib, vp: S.layers.vp, delta: S.layers.delta, trades: false },
    motion: GLIDE[S.glide], clock: etNow,
  });
  chart.setDeltaView({ mode: S.options.delta.show, ratio: prefs.paneHeight(PANE, 'delta') });   // the delta pane (1.7.0), per pane

  if (PAGE) window.liveChart = chart;  // for tests and the console; order actions still go through the checks below

  /* ---------------- per-instrument data */
  const D = { root: null, name: null, tick: 0.25, ready: false, hist: [], ticks: new BB.TickStore(), m1: null, cur: null, day: null, tickHours: 0, tickFrom: Infinity, trimmed: false,
    lv: [], ib: null, ibKey: '', vp: null, liveFrom: null, delta: null, sides: null,
    // the delta pane (1.7.0): the number of tick backfill trades (the store's trades before the first live one), and the
    // window the current delta was built with ({ from, by, why, journal })
    backfill: 0, deltaCov: null };
  let bridgeVersion = '';                                      // ChartBridge's version from hello (the delta pane's first hint)
  /* Seconds and range bars are built from ticks; minute and hour bars only need 1-minute history (fast load).
     Range bars need the backfill to reach back to a session start (see rangeHistoryFrom in bar-builder.js). */
  // The delta pane loads nothing of its own (Anthony, round 4): every view asks for the ticks it asked for before 1.7.0.
  const ticksWanted = () => TF[S.tf].mode === 'range' ? BB.rangeTickHours(etNow(), SESSION) : TF[S.tf].sec < 60 ? 8 : 0;
  const ticksMissing = () => TF[S.tf].mode === 'range' ? BB.rangeNeedsReload(D.tickFrom, etNow(), SESSION, D.trimmed) : TF[S.tf].sec < 60 && D.tickHours === 0;
  let instruments = {};
  const fills = new Map();            // id -> fill, all instruments
  /* The account (1.6.0, Anthony: one picker for both). On a trading page the order bar's Account picker is the only
     one; with no order bar (a mounted chart, or ChartBridge 0.2) a compact one sits in the toolbar. The chart marks the
     fills of that account only. While trading is on, the account is the order account (TR.account, chosen exactly as
     before 1.6.0); otherwise it is `viewAccount`, the last one picked, saved in live-account-v1. The 1.5 fills choice
     (live-fill-account-v1) is read once when there is none yet; its "All accounts" is gone and means none chosen. */
  let viewAccount = (() => {
    const v = store.get('live-account-v1', null);
    if (typeof v === 'string' && v) return v;
    const old = store.get('live-fill-account-v1', '');
    return typeof old === 'string' ? old : '';
  })();
  const accountsSeen = new Set();
  let helloSeen = false;                                       // ChartBridge has said which accounts it knows
  let ticksSeen = 0;
  const delays = { feed: [], local: [] };

  function resetData(root) {
    D.root = root; D.name = root; D.ready = false; D.hist = []; D.ticks = new BB.TickStore(); D.m1 = null; D.cur = null; D.day = null; D.trimmed = false;
    D.lv = []; D.ib = null; D.ibKey = ''; ibNote(null);
    D.vp = null; D.liveFrom = null; chart.setProfile(null); vpNote(); vpLegend();
    D.backfill = 0; D.deltaCov = null;
    deltaJob = null; D.delta = null; D.sides = null; chart.setDelta(null); deltaView(); deltaLegend(true);   // a build of the old load stops
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
    let rangeFrom;                                        // where the range bars start, handed to the delta (review 2 N2)
    chart.setBarSeconds(tf.sec);
    if (tf.mode === 'time' && tf.sec >= 60) {
      D.cur = null;
      const bars = tf.sec === 60 ? D.m1.bars : U.aggregate(D.m1.bars, tf.sec);
      chart.setBars(bars, { barSeconds: tf.sec });
      chart.setCountdown(null);
    } else {
      D.cur = tf.mode === 'range' ? rangeBuilder() : new BarBuilder({ mode: 'time', seconds: tf.sec, tick: D.tick, sessionStart: SESSION });
      const from = rangeFrom = tf.mode === 'range' ? BB.rangeStartIndex(D.ticks, D.tickFrom, SESSION) : 0;
      D.ticks.feed(D.cur, from);
      const partial = tf.mode === 'range' ? BB.partialStart(D.ticks, from, SESSION) : null;
      if (partial !== null) setStatus('Range bars start at ' + U.fmtHM(partial) + ' ET: NinjaTrader sent less tick history than asked, so bars until the next 18:00 session may differ from NinjaTrader\'s.', '');
      chart.setBars(D.cur.bars, { barSeconds: tf.sec });
      if (tf.mode === 'range') chart.setCountdown(() => { const r = D.cur && D.cur.rangeLeft(); return r ? '▲' + r.up + ' ▼' + r.down : ''; });
      else chart.setCountdown(null);
      if (!D.ticks.length) setStatus('No tick history came back from NinjaTrader, so ' + tf.label + ' bars start with the next live tick.', 'warn');
    }
    deltaStart({ rangeFrom: tf.mode === 'range' ? rangeFrom : undefined });   // the delta pane, from the same store, in slices (review S5)
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
   * The 1-hour Initial Balance (1.5.3): today's high and low from 9:30:00 up to 10:30:00 ET, "IBH" and "IBL" drawn
   * from 9:30, long dashes until 10:30:00, then solid. Always from the 1-minute bars (D.m1), whatever the chart
   * shows: every view holds them (history, then built from the live trades), a 1-minute bar never straddles 9:30 or
   * 10:30, and its high and low are exactly those of the trades inside it, so the IB is the same on 1m, seconds,
   * 15m, 1h and Range bars, live or after a reload, here and in a mounted chart. Nothing is drawn when it cannot be
   * exact (no bar of today's session before 9:30, or a minute of the hour missing) or there is no regular session
   * (weekend, NYSE holiday); the status line says which.
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
    uncovered: 'Initial balance not shown: the history does not reach back before 9:30 ET today, so the first hour may be incomplete.',
    gap: 'Initial balance not shown: minutes are missing between 9:30 and 10:30 ET, so it could be wrong. A reload fetches the history again.',
    inexact: 'Initial balance not shown: the bars do not line up with 9:30 and 10:30 ET.',
    empty: 'Initial balance not shown: no trades yet between 9:30 and 10:30 ET.',
  };
  /* A quiet note on the status line, only while the IB indicator is on and the IB cannot be shown for a reason. */
  function ibNote(ib) {
    const el = $('ibNote'); if (!el) return;
    let text = ib && S.layers.ib ? IB_NOTES[ib.state] || '' : '';
    if (ib && S.layers.ib && ib.state === 'closed') {                     // a holiday gets a note (naming the day), a weekend none
      const wd = new Date(ib.start * 1000).getUTCDay();
      text = wd === 0 || wd === 6 ? '' : 'Initial balance: no stock market session on ' + U.fmtDate(ib.start) + ' (NYSE holiday).';
    }
    el.textContent = text; el.hidden = !text;
  }

  /*
   * The volume profile (1.6.0; Anthony's ruling 2026-09-29): the 'vp' indicator, off by default, drawn
   * by the engine at the right edge of the plot behind the candles, 1-tick rows, POC and 70% value area highlighted.
   * The option S.options.vp.session picks the full session from 18:00 ET ('full') or RTH 9:30 to 16:00 ET ('rth').
   * Built from the TickStore when the indicator is on at `ready`, when it is switched on, and when the option
   * changes (the store holds every trade the page got: the backfill, then each live tick), then fed each live tick
   * right after the store's push in onTick, so it holds exactly what the store holds (VolumeProfile in the engine
   * has the notes, and the backfill seam that is not settled). It holds the trading day of the clock: the timer
   * below moves it to the new session at 18:00 ET even before the first trade. It does not depend on the view, so
   * changing bars keeps it. While it is off there is no profile at all.
   * Views that load no tick history (1m and longer, when the page subscribed on one: tickHours 0) have only the
   * live trades since `ready`, so the profile starts at the first live trade; a quiet note on the status line says
   * so, and says when the tick history does not reach back to 18:00 (or 9:30 for RTH).
   */
  function vpBuild() {
    D.vp = null;
    if (S.layers.vp && D.ready) {
      const now = etNow();
      const vp = new CE.VolumeProfile({ tick: D.tick, sessionStart: SESSION, rth: S.options.vp.session === 'rth' });
      D.ticks.feed(vp, 0, vp.startOf(now));
      vp.advance(now);
      D.vp = vp;
    }
    chart.setProfile(D.vp);
    vpNote(); vpLegend();
  }
  /* The quiet note while the profile is on and cannot show the whole session (or RTH) for a reason. */
  function vpNote() {
    const el = $('vpNote'); if (!el) return;
    let text = '';
    if (S.layers.vp && D.ready && D.vp) {
      const now = etNow(), need = D.vp.startOf(now), rth = D.vp.rth, from = rth ? '9:30' : '18:00';
      // every trade is known from here on: the tick backfill's start (later when NinjaTrader sent less than asked,
      // or the page dropped its oldest ticks), or with no tick history (tickHours 0) the moment the page went live
      const t0 = D.ticks.length ? D.ticks.time(0) : Infinity;
      const coveredFrom = D.tickHours > 0 ? Math.max(D.tickFrom, D.trimmed || t0 - 600 > D.tickFrom ? t0 : -Infinity) : D.liveFrom;
      if (rth && !U.rthDay(need)) {
        const wd = new Date(need * 1000).getUTCDay();
        text = wd === 0 || wd === 6 ? '' : 'Volume profile (RTH): no stock market session on ' + U.fmtDate(need) + ' (NYSE holiday).';
      } else if (rth && now < need) text = 'Volume profile (RTH) starts at 9:30 ET.';
      else if (coveredFrom > need) {
        const at = U.fmtHM(Math.min(coveredFrom, now));
        text = D.tickHours > 0 ? 'Volume profile from ' + at + ' ET: the tick history does not reach back to ' + from + ' ET.'
          : 'Volume profile from ' + at + ' ET: this view loads no tick history, so it counts the live trades from then on.';
      }
    }
    if (el.textContent !== text) el.textContent = text;
    el.hidden = !text;
  }
  /* "POC <price> · VA <val> to <vah>" in the legend while the profile is on and has trades; redone once per change. */
  let vpLegendVer = -1;
  function vpLegend() {
    const el = $('lgVp'); if (!el) return;
    const cols = S.layers.vp && D.vp ? D.vp.columns() : null;
    el.hidden = !cols;
    if (!cols || cols.version === vpLegendVer) return;
    vpLegendVer = cols.version;
    const va = D.vp.valueArea(), dp = precisionOf();
    $('lgPoc').textContent = U.fmtPrice(D.vp.poc().price, dp); $('lgVal').textContent = U.fmtPrice(va.val, dp); $('lgVah').textContent = U.fmtPrice(va.vah, dp);
    el.title = 'Volume profile, ' + (D.vp.rth ? 'RTH 9:30 to 16:00 ET' : 'full session from 18:00 ET') + ': point of control and 70% value area';
  }
  /*
   * The cumulative delta pane (1.7.0; Anthony's rulings 2026-09-30): market buys minus market sells, the side of each
   * trade from ChartBridge 0.3.4 (`s` on every trade; the page never works one out), as candles of the running value
   * from 18:00 ET (or each bar's own delta, the "Show" option) in a pane below the chart, drawn by the engine on the
   * chart's own bars (ChartEngine.CumulativeDelta has the rules). On by default on the main pane.
   * Built from the TickStore with the bars (rebuild: a reload, a bar type or size change) or on its own when it is
   * shown, then each live trade is added after the bar builders in onTick, told which bar it made, so it holds exactly
   * the trades the store holds and the bars the chart shows, with no rebuild per trade. Hidden, there is no core.
   * ChartBridge 0.3.3 or older sends no sides: the pane draws nothing but "Delta needs ChartBridge 0.3.4 on this PC".
   * Whether a load has sides is read from its first trade (backfill or live); before any trade, from hello's version.
   * It counts only trades with a measured side, from the start of that window (deltaCoverage): a session that started
   * before it counts from its first complete bar, and the pane's title and the legend say since when ("since 10:04 ET
   * (page opened)").
   * Nothing is added to the status line, so the chart's height stays as in 1.6.0 on every view.
   */
  const OLD_BRIDGE = 'Delta needs ChartBridge 0.3.4 on this PC';
  /* true: trades carry sides; false: this ChartBridge sends none; null: not known yet (no trade, no version). */
  function bridgeSides() {
    if (D.sides !== null) return D.sides;
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(bridgeVersion || '');
    return m ? (+m[1] * 1e6 + +m[2] * 1e3 + +m[3]) >= 3004 : null;
  }
  /*
   * The delta's window (1.7.0; Anthony, round 4: "Delta is a tool I use WHILE trading, not for historical look backs"):
   * only trades whose side was measured count. Those are the live trades, and the backfill trades inside ChartBridge's
   * quote window: ChartBridge 0.3.4.1 asks NinjaTrader for historical quotes only for its last `quoteHours` of the
   * backfill (0 by default), and gives every trade before that a tick-rule side (`sm` 3), which is never counted. So:
   *   - the backfill's measured window starts at its first trade with a measured side (`sm` 1 or 2,
   *     TickStore.firstMeasured); from just after it every trade is held (the backfill is one run up to ChartBridge's
   *     seam, then every live trade) and counted, labelled "since HH:MM ET";
   *   - with none (quoteHours 0, the default), the window opens with the page: from just after the first live trade, or
   *     from the moment the page went live (this PC's clock at `ready`) when that is earlier, so a page open across 18:00
   *     in the break counts the new session from 18:00. That moment counts LIVE_MARGIN (5 s) later, or the PC clock's lag
   *     behind the data's plus CLOCK_SLACK (2 s) when that is more: each live tick's `u` (the data's UTC time) minus this
   *     page's clock, or minus `rx`, is at most that lag, and a tick showing more lag than the delta was built with
   *     builds it again with the later start (onTick). Labelled "since HH:MM ET (page opened)", or with no bracket for a
   *     count that began with a switch of instrument;
   *   - after a trim, not before the store's first trade.
   * The count (K below) then lives across every later load of the same instrument (round 5, review 4 B1).
   * Bars that started before the window are left out whole (on 5m and longer, the trades of the bar holding the start
   * count by their own time, round 5 S1); each session counts from 0 at 18:00 ET.
   */
  const LIVE_MARGIN = 5, CLOCK_SLACK = 2;
  let clockAhead = -Infinity, clockAheadUsed = 0;         // the data's clock ahead of this PC's (s): measured, and in whole seconds as used
  const liveLate = () => Math.max(LIVE_MARGIN, clockAheadUsed + CLOCK_SLACK);
  /*
   * The count (round 5, review 4 B1: "losing the count because the page reconnected is wrong"): the trades counted since
   * the count began, per instrument, kept outside the store that every load (resetData) replaces. It begins at the first
   * `ready` of an instrument (the page's opening, or a switch of instrument) with the window above and the backfill's
   * measured trades in it, then takes every live trade of that instrument, also those that arrive while a later load of
   * it is on its way. A later load of the same instrument (a ChartBridge reconnect, a view that needs more ticks) builds
   * the delta from it, so the count and its "since ... (page opened)" stay as they were. Its trades are dropped at each
   * 18:00 ET (the count starts again at 0 there anyway), and the oldest 500,000 when it passes 2.5 million, like the
   * store: at most one session of one instrument. A switch of instrument starts a new count. Trades that came in neither
   * live nor with a measured side (while a reconnect was down, or held by ChartBridge during a reload and sent only in
   * the new backfill with tick-rule sides) are not in it, by the measured-sides rule.
   */
  const K = { root: null, opened: false, started: false, load: 0, open: false, openWhy: '', liveFrom: null, firstT: null, fixedFrom: -Infinity,
    floor: -Infinity, trimmed: false, day: null, trades: new BB.TickStore(), base: null };
  // K.base: the backfill's measured trades, { store, from, to }: on the count's first load the store itself (nothing
  // copied), and before a later load only this session's part of it, copied once (countKeepBase), so no store is held twice
  let loadSeq = 0;
  function countReset(root) {
    K.root = root; K.started = false; K.trades = new BB.TickStore(); K.base = null; K.day = null; K.firstT = null; K.floor = -Infinity; K.trimmed = false;
    K.openWhy = K.opened ? '' : 'page opened';         // "(page opened)" only for the page's first instrument
    K.opened = true;
  }
  /* The window from this load's store (the count's first load, or before it begins). */
  function storeCoverage() {
    const live = D.liveFrom === null ? Infinity : D.liveFrom + liveLate();
    const n = D.ticks.length, k = D.ticks.firstMeasured(0, Math.min(D.backfill, n));
    let cov;
    if (k < Math.min(D.backfill, n)) cov = { from: D.ticks.time(k) + 1e-6, index: k, by: 'store', why: '' };   // the backfill's measured window
    else {                                                                    // none: from the page's opening
      const b = Math.min(D.backfill, n), first = b < n ? D.ticks.time(b) + 1e-6 : Infinity;
      cov = live < first ? { from: live, index: b, by: 'live', why: K.openWhy } : { from: first, index: b, by: 'first', why: K.openWhy };
    }
    if (D.trimmed && n && D.ticks.time(0) + 1e-6 > cov.from) cov = { from: D.ticks.time(0) + 1e-6, index: cov.index, by: 'store', why: '' };
    return cov;
  }
  /* The count begins (onReady, before the first build): its window, and the backfill's measured trades in it. */
  function countStart() {
    const cov = storeCoverage();
    K.started = true; K.load = loadSeq; K.open = cov.by !== 'store'; K.liveFrom = D.liveFrom; K.fixedFrom = cov.from;
    K.base = cov.index < D.backfill ? { store: D.ticks, from: cov.index, to: D.backfill } : null;
    if (K.base) K.day = U.tradeDay(D.ticks.time(D.backfill - 1), SESSION);
  }
  /* Before a later load of the count's instrument replaces the store: keep only this session's measured backfill trades. */
  function countKeepBase() {
    const b = K.base;
    if (!b || b.store !== D.ticks) return;
    const kept = new BB.TickStore(), start = BB.sessionStartOf(etNow(), SESSION);
    for (let i = b.from; i < b.to; i++) { const t = b.store.time(i); if (t >= start) kept.push(t, b.store.price(i), b.store.volume(i), b.store.side(i), b.store.method(i)); }
    K.base = kept.length ? { store: kept, from: 0, to: kept.length } : null;
  }
  /* The store dropped its oldest n trades (onTick): the count's part of it moves with it. */
  function countStoreTrimmed(n) {
    const b = K.base;
    if (!b || b.store !== D.ticks) return;
    b.from -= n; b.to -= n;
    if (b.from < 0) { b.from = 0; K.floor = Math.max(K.floor, D.ticks.time(0) + 1e-6); K.trimmed = true; }
    if (b.to <= 0) K.base = null;
  }
  /* A live trade of the count's instrument; true when the count's trades were dropped (a new session, or the cap). */
  function countAdd(m) {
    const t = m.t, day = U.tradeDay(t, SESSION);
    let dropped = false;
    if (K.day !== null && day > K.day && (K.trades.length || K.base)) { K.trades = new BB.TickStore(); K.base = null; dropped = true; }   // 18:00 ET: a new session from 0
    if (K.day === null || day > K.day) K.day = day;
    if (K.firstT === null) K.firstT = t;
    K.trades.push(t, m.p, m.v || 0, m.s, m.sm);
    if (K.trades.length > 2500000) { K.trades.dropFirst(500000); K.base = null; K.floor = K.trades.time(0) + 1e-6; K.trimmed = true; dropped = true; }
    return dropped;
  }
  /* The window a build counts from: the count's, when it began on an earlier load of this instrument, else this store's. */
  function deltaCoverage() {
    if (!(K.started && K.root === D.root && K.load !== loadSeq)) return storeCoverage();
    const live = K.liveFrom + liveLate(), first = K.firstT !== null ? K.firstT + 1e-6 : Infinity;
    let cov = !K.open ? { from: K.fixedFrom, by: 'store', why: '' } : live < first ? { from: live, by: 'live', why: K.openWhy } : { from: first, by: 'first', why: K.openWhy };
    if (K.floor > cov.from) cov = { from: K.floor, by: 'store', why: '' };
    cov.journal = true; cov.index = 0;
    return cov;
  }
  const rangeBuilder = () => new BarBuilder({ mode: 'range', rangeTicks: ranges[D.root], rangeMode: S.rangeMode, tick: D.tick, sessionStart: SESSION });
  /* The delta is kept while it is on the chart, shown or hidden (review S5: showing it again is then at once; a trade
     costs O(1)); not when it is off the chart or this ChartBridge sends no sides. */
  const deltaWanted = () => IS.ind.delta.on && D.ready && bridgeSides() !== false;
  /* Feeds a range bar builder and the delta core together: each trade goes to the delta with the bar it made. */
  const pairFeed = (builder, cd) => ({ addQuiet(t, p, v, s, sm) { builder.addQuiet(t, p, v); const b = builder.bars; cd.add(t, v, s, b[b.length - 1].t, sm); } });
  /*
   * Build the delta from the store in slices of at most DELTA_SLICE_MS, one task each, so no frame waits on it (review
   * S5: 1.8 million trades took one 150 to 380 ms task). Time bars bucket by themselves; range bars go through a new
   * builder fed the same trades from the same place, which makes the same bars as the chart's. Live trades keep going
   * into the store meanwhile and the build reads on to its end; only then is the delta handed to the chart (never a
   * half-built value shown as the current one) and fed trade by trade in onTick. A new load, bar type or trim starts over.
   */
  const DELTA_SLICE_MS = 8, DELTA_SLICE_TRADES = 20000, SCAN_STEP = 4096;
  /*
   * A hidden tab: Chrome runs a chain of setTimeout(0) tasks there at most once a second (after 5 minutes, once a minute),
   * so a build started while the tab is hidden (a reconnect) goes slowly and the pane stays empty until the tab is shown,
   * when it finishes at once. Accepted (review 2 N3): nothing shows while hidden. live-first's yieldTask (rAF, or a
   * MessageChannel when hidden) is the better tool after that merge.
   * opts.keep: the delta on the chart stays (and keeps its live trades) until the new one is complete, for a rebuild of
   * a delta that is already right in everything but its start (the clock check, live-first's grown history), so the
   * pane never goes blank. opts.rangeFrom: where the chart's range bars start (rebuild just found it), so the store is
   * not scanned twice; otherwise the scan runs in the slices too (review 2 N2: after a trim it walks the rest of the
   * older session, up to 46 ms for 2.1 million trades).
   */
  let deltaJob = null;
  function deltaStart(opts) {
    const o = opts || {};
    deltaJob = null;
    if (!deltaWanted()) { deltaSet(null); return; }
    const tf = TF[S.tf], range = tf.mode === 'range';
    const cov = deltaCoverage();
    const cd = new CE.CumulativeDelta({ sessionStart: SESSION, seconds: range ? 0 : tf.sec, coveredFrom: cov.from, byTime: !range && tf.sec >= 300 });
    let job;
    if (cov.journal) {
      // from the count (a later load of the same instrument): its trades on this load's bars, a range trade on the chart's
      // range bar holding its time (range bars are built from this load's store)
      const bars = () => D.cur ? D.cur.bars : [];
      const barAt = t => { const b = bars(); let lo = 0, hi = b.length - 1, r = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (b[mid].t <= t) { r = mid; lo = mid + 1; } else hi = mid - 1; } return r < 0 ? t : b[r].t; };
      job = deltaJob = { cd, cov, feed: range ? { addQuiet: (t, p, v, s2, sm) => cd.add(t, v, s2, barAt(t), sm) } : cd,
        segs: (K.base ? [{ st: K.base.store, i: K.base.from, end: K.base.to }] : []).concat({ st: K.trades, i: 0, end: null }) };
    } else {
      // counted from the window's first trade by its place in the store (never a backfill trade before it, whatever its
      // time); range bars are still built from their session's start, the trades before the window only into the bars
      const builder = range ? rangeBuilder() : null;
      job = deltaJob = { cd, cov, store: D.ticks, feed: range ? pairFeed(builder, cd) : cd, pre: range ? { addQuiet: (t, p, v) => builder.addQuiet(t, p, v) } : null,
        i: range ? (o.rangeFrom === undefined ? null : o.rangeFrom) : cov.index, scan: 0, from: D.tickFrom };
    }
    if (!o.keep || !D.delta) deltaSet(null);
    const slice = () => {
      if (destroyed || job !== deltaJob) return;
      const t0 = performance.now();
      if (job.i === null) {                                 // BB.rangeStartIndex, a slice at a time
        const n = D.ticks.length;
        let j = job.scan;
        while (j < n && BB.sessionStartOf(D.ticks.time(j), SESSION) < job.from) if ((++j & (SCAN_STEP - 1)) === 0 && performance.now() - t0 >= DELTA_SLICE_MS) break;
        job.scan = j;
        if (j < n && BB.sessionStartOf(D.ticks.time(j), SESSION) < job.from) { later(slice, 0); return; }
        job.i = j < n ? j : 0;                              // no session start covered: from the first trade, as the chart
      }
      if (job.segs) {                                       // the count: its kept backfill part, then its live trades (to their end)
        for (;;) {
          const g = job.segs[0], end = () => g.end === null ? g.st.length : g.end;
          do g.i = g.st.feedSides(job.feed, g.i, null, Math.min(end(), g.i + DELTA_SLICE_TRADES));
          while (g.i < end() && performance.now() - t0 < DELTA_SLICE_MS);
          if (g.i < end()) { later(slice, 0); return; }
          if (g.end === null) break;
          job.segs.shift();
        }
      } else {
        const st = D.ticks;
        do job.i = job.i < job.cov.index ? st.feedSides(job.pre, job.i, null, Math.min(job.cov.index, job.i + DELTA_SLICE_TRADES))
          : st.feedSides(job.feed, job.i, null, job.i + DELTA_SLICE_TRADES);
        while (job.i < st.length && performance.now() - t0 < DELTA_SLICE_MS);
        if (job.i < st.length) { later(slice, 0); return; }
      }
      deltaJob = null;
      D.deltaCov = job.cov;
      deltaSet(job.cd);
    };
    slice();                                                // a small store is done at once
  }
  /* Off the chart: no delta at all. */
  function deltaStop() { deltaJob = null; deltaSet(null); }
  function deltaSet(cd) { D.delta = cd; chart.setDelta(cd); deltaView(); deltaLegend(true); }
  const deltaBuilding = () => deltaJob !== null;
  /* The pane's note (only for a ChartBridge that sends no sides, and then nothing else is drawn in it), and why a
     session may count from later than 18:00, for its title. */
  const deltaWhy = () => D.deltaCov ? D.deltaCov.why : '';
  function deltaView() { chart.setDeltaView({ note: S.layers.delta && D.ready && bridgeSides() === false ? OLD_BRIDGE : '', reason: deltaWhy() }); }
  /* "Delta +12,345" in the legend (the bar under the crosshair, else the newest), "Bar delta" in bar mode, the start
     when the session counts from later than 18:00, and the unknown sides (they add nothing) when there are any. */
  let legendBarT = null, deltaLegendKey = '';
  /* Written only when it changes (a trade changes the value, rarely the rest), so the legend lays out no more than before. */
  const put = (el, k, v) => { if (el[k] !== v) el[k] = v; };
  function deltaLegend(force) {
    const el = $('lgDelta'); if (!el) return;
    const cd = S.layers.delta ? D.delta : null, old = S.layers.delta && D.ready && bridgeSides() === false;
    put(el, 'hidden', !cd && !old);
    if (old) {                                                     // no sides from this ChartBridge: say so, no number
      if (deltaLegendKey === 'old') return;
      deltaLegendKey = 'old';
      const v = /(\d+\.\d+\.\d+)/.exec(bridgeVersion || '');
      $('lgDl').textContent = OLD_BRIDGE; $('lgDv').textContent = ''; $('lgDu').hidden = true;
      el.title = 'This ChartBridge' + (v ? ' (' + v[1] + ')' : '') + ' sends no buy or sell side with its trades, so the delta pane stays empty. Delta is never estimated.';
      return;
    }
    if (!cd) { deltaLegendKey = ''; return; }
    const bar = S.options.delta.show === 'bar', b = legendBarT === null ? cd.last : cd.at(legendBarT), ses = b ? cd.sessionOf(b) : cd.session;
    const v = b ? (bar ? b.c - b.o : b.c) : null;
    const key = [cd.version, legendBarT, bar, v].join('|');
    if (!force && key === deltaLegendKey) return;
    deltaLegendKey = key;
    put($('lgDl'), 'textContent', (bar ? 'Bar delta' : 'Delta') + (!bar && ses && ses.partial ? ' since ' + U.fmtExact(ses.from) : ''));
    const dv = $('lgDv');
    put(dv, 'textContent', v === null ? '-' : U.fmtSigned(v, 0));
    put(dv, 'className', 'dv' + (v > 0 ? ' up' : v < 0 ? ' down' : ''));
    const unk = ses ? ses.unknown : 0, du = $('lgDu');
    put(du, 'hidden', !(unk > 0));
    put(du, 'textContent', unk > 0 ? ' · ' + U.fmtPrice(unk, 0) + ' unknown' : '');
    put(el, 'title', (bar ? 'Bar delta: each bar\'s market buys minus market sells' : 'Cumulative delta: market buys minus market sells since ' +
      (ses && ses.partial ? U.fmtExact(ses.from) + ' ET' + (deltaWhy() ? ' (' + deltaWhy() + ')' : '') : '18:00 ET')) + '. Sides from ChartBridge; unknown sides add nothing.');
  }
  /*
   * An indicator's option (LivePrefs INDICATOR_OPTIONS), saved per pane: setIndicatorOption('vp', 'session', 'rth').
   * Returns false for an option or value that does not exist. The volume profile is rebuilt from the store.
   * Always saved, also when the tab already shows that value: another tab may have saved the other one since (review
   * S2), and a click is saved as what this tab shows, on a fresh read (only this pane's field is written).
   */
  function setIndicatorOption(id, key, value) {
    if (!LP.indicatorOptionAllowed(id, key, value)) return false;   // own properties only: 'toString' is not an option
    prefs.setIndicatorOption(PANE, id, key, value);
    if (S.options[id][key] !== value) {
      S.options[id][key] = value;
      if (id === 'vp') { vpLegendVer = -1; vpBuild(); }
      if (id === 'delta') { chart.setDeltaView({ mode: value }); deltaLegend(true); }   // the same core, drawn the other way
    }
    syncIndicators();
    return true;
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
    D.liveFrom = etNow();
    D.backfill = D.ticks.length;
    if (!K.started || K.root !== D.root) countStart();   // the count begins with this instrument's first load (round 5)
    rebuild();
    vpBuild();
    setConn('live');
    $('notice').hidden = true;
  }

  function onTick(m) {
    // the count takes every live trade of its instrument, also one that arrives while a later load of it is on its way
    const countDropped = K.started && m.root === K.root && countAdd(m);
    if (m.root !== D.root || !D.ready) return;
    const t = m.t, p = m.p, v = m.v || 0;
    D.ticks.push(t, p, v, m.s, m.sm);                  // columns, not one array per trade (TickStore, bar-builder.js); the side since 1.7.0
    if (D.vp) D.vp.add(t, p, v);                       // the volume profile holds what the store holds (vpBuild)
    let deltaFed = false;
    if (D.sides === null) {                            // the first trade of a load with no backfill says whether sides come
      const before = bridgeSides();
      D.sides = typeof m.s === 'number';
      if (bridgeSides() !== before && IS.ind.delta.on) { deltaStart(); deltaFed = true; }   // built from the store, this trade in it
    }
    if (D.ticks.length > 2500000) {                      // the first session left is partial now
      D.ticks.dropFirst(500000); D.tickFrom = D.ticks.time(0) + 0.001; D.trimmed = true; D.backfill = Math.max(0, D.backfill - 500000); countStoreTrimmed(500000);
      if (deltaBuilding()) { deltaStart(); deltaFed = true; }   // the store (or the count's part of it) moved under a build: start it over
    }
    if (countDropped && deltaBuilding() && deltaJob.cov.journal) { deltaStart(); deltaFed = true; }   // the count moved under a build
    // how far the data's clock runs ahead of this PC's (review 2 S1): when it is more than the delta was built with and
    // that delta counted from the moment the page went live, build it again with the later start (it holds this trade)
    const ahead = typeof m.u === 'number' && isFinite(m.u) ? Math.max(m.u - Date.now(), typeof m.rx === 'number' && isFinite(m.rx) ? m.u - m.rx : -Infinity) / 1000 : -Infinity;
    if (ahead > clockAhead) {
      clockAhead = ahead;
      if (ahead > clockAheadUsed) {
        const before = liveLate();
        clockAheadUsed = Math.ceil(ahead);               // whole seconds, so a creeping measure rebuilds rarely
        const cov = deltaJob ? deltaJob.cov : D.delta ? D.deltaCov : null;
        if (liveLate() > before && cov && cov.by === 'live') { deltaStart({ keep: true }); deltaFed = true; }
      }
    }
    // the first live trade after a build that counted from the moment the page went live (plus its margin): every trade
    // from just after it is held, so count from there, a few seconds earlier (round 5: on 5m and longer they show)
    if (!deltaFed) {
      const cov = deltaJob ? deltaJob.cov : D.delta ? D.deltaCov : null;
      if (cov && cov.by === 'live' && t + 1e-6 < cov.from) { deltaStart({ keep: true }); deltaFed = true; }
    }
    ticksSeen++;
    const r1 = D.m1.add(t, p, v);
    const tf = TF[S.tf];
    let barT;                                          // the start of the chart bar this trade made (for the delta pane)
    if (tf.mode === 'time' && tf.sec >= 60) { chart.update(tf.sec === 60 ? r1.bar : U.foldLast(D.m1.bars, tf.sec)); barT = Math.floor(r1.bar.t / tf.sec) * tf.sec; }
    else if (D.cur) { const r = D.cur.add(t, p, v), ch = r.changed; for (let i = 0; i < ch.length; i++) chart.update(ch[i]); barT = r.bar.t; }   // a finished range bar, phantom bars, the new bar
    if (D.delta && !deltaFed) D.delta.add(t, v, m.s, barT, m.sm);   // one trade, one bar: never a rebuild per trade
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
  /* Accounts known to this chart (ChartBridge's list and any with fills), those with fills first. */
  function knownAccounts() {
    const withFills = new Set([...fills.values()].map(f => f.account));
    const names = [...accountsSeen].sort((a, b) => (withFills.has(b) - withFills.has(a)) || a.localeCompare(b));
    if (viewAccount && !accountsSeen.has(viewAccount)) names.unshift(viewAccount);   // keep a saved choice even before it reconnects
    return { names, withFills };
  }
  const tradeMode = () => TRADING && TR.v2 && TR.enabled;
  const orderBarShown = () => TRADING && TR.v2;
  /** The account whose fills are marked (and, while trading, the order account). */
  function account() {
    if (tradeMode()) return TR.account;
    return viewAccount || OT.defaultAccount(knownAccounts().names, '');
  }
  /* Both pickers from the state; the fills follow. */
  function syncAccounts(listed) {
    if (listed) for (const a of listed) accountsSeen.add(a);
    if (tradeMode() && TR.account) viewAccount = TR.account;       // trading off later keeps showing the same account
    const { names, withFills } = knownAccounts(), cur = account();
    const label = n => !accountsSeen.has(n) ? (helloSeen ? n + ' (no longer listed)' : n) : withFills.has(n) ? n : n + ' (no fills yet)';
    const opts = () => names.length ? names.map(n => new Option(label(n), n)) : [new Option('No accounts yet', '')];
    /* the toolbar picker: only with no order bar; on the trading page not before ChartBridge's hello says which (review 2, N4) */
    const noToolbarPicker = orderBarShown() || (TRADING && !helloSeen);
    if ($('acctWrap').hidden !== noToolbarPicker) { $('acctWrap').hidden = noToolbarPicker; fitChips(); }   // the toolbar changed
    if (orderBarShown()) {                                         // say what the picker does now (review 2, S2)
      const t = tradeMode() ? 'Orders go to this account, and the chart marks its fills' : 'Trading is off: this only picks whose fills the chart marks';
      $('oAcct').title = t; $('oAcct').setAttribute('aria-label', 'Account. ' + t);
    }
    if (!orderBarShown()) { $('acctPick').replaceChildren(...opts()); $('acctPick').value = cur; $('acctPick').disabled = !names.length; }
    else if (tradeMode()) syncTradeAccounts();                    // trading: the accounts ChartBridge allows, as before
    else { $('oAcct').replaceChildren(...opts()); $('oAcct').value = cur; $('oAcct').disabled = !names.length; }
    applyMarkers();
  }
  function pickViewAccount(v) {
    viewAccount = v;
    store.set('live-account-v1', v);
    syncAccounts();
    for (const peer of accountPeers) if (peer.prefix === PREFIX && peer.follow !== followAccount) peer.follow(v);
  }
  /* Another chart with this prefix (on this page, or in another tab) picked an account: show the same. While trading
     the order account is not changed; only the account shown after trading goes off is. */
  function followAccount(v) {
    if (typeof v !== 'string' || v === viewAccount || destroyed) return;
    viewAccount = v;
    syncAccounts();
  }
  accountPeers.add({ prefix: PREFIX, follow: followAccount });
  cleanups.push(() => { for (const peer of accountPeers) if (peer.follow === followAccount) accountPeers.delete(peer); });
  listen(window, 'storage', e => {
    if (e.key !== PREFIX + 'live-account-v1') return;
    try { followAccount(JSON.parse(e.newValue)); } catch (err) { /* not ours */ }
  });
  /* Fills of the account picked, on this instrument. With Fills hidden (its switch, a chip or Hide all) past fills go,
     but the open trade never does: its entry fills stay (OrderTicket.openEntryFills, checked against the position
     ChartBridge reports while trading), and the position line, working orders and stop and target lines are not
     indicators at all. */
  function applyMarkers() {
    const acc = account();
    const mine = acc ? [...fills.values()].filter(f => f.root === D.root && f.account === acc) : [];
    let list = mine;
    if (!S.layers.fills) {
      const pos = tradeMode() ? TR.positions.get(acc + '|' + D.root) : null;
      list = OT.openEntryFills(mine, pos ? pos.qty : undefined);
    }
    chart.setMarkers(list);
    const lastFill = list.slice().sort((a, b) => a.t - b.t)[list.length - 1];
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
    loadSeq++;
    if (root !== K.root) countReset(root);             // a new instrument: a new count; the same one keeps its count (round 5)
    else countKeepBase();
    resetData(root);
    setConn('loading');
    D.tickHours = ticksWanted();
    D.tickFrom = D.tickHours > 0 ? etNow() - D.tickHours * 3600 : Infinity;
    send({ type: 'subscribe', root, days: 5, tickHours: D.tickHours });
  }

  function handle(m) {
    switch (m.type) {
      case 'hello':
        helloSeen = true;
        instruments = {};
        for (const i of m.instruments || []) instruments[i.root] = i;
        $('lgSrc').textContent = 'NinjaTrader via ChartBridge ' + (m.version ? m.version + ' ' : '') + '· chart ' + CE.VERSION;
        bridgeVersion = typeof m.version === 'string' ? m.version : '';
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
        if (D.sides === null && m.ticks && m.ticks.length) { const x = m.ticks[0]; D.sides = typeof x[3] === 'number'; }   // 0.3.4: [t, p, v, s, sm]
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
      case 'position': TR.positions.set(m.account + '|' + m.root, { qty: +m.qty || 0, avgPrice: +m.avgPrice || 0 }); renderTrading(); applyMarkers(); break;
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
    renderTrading();
    syncAccounts();
  }
  function tradingLost(reason) {
    TR.signInStarted = false;
    if (!TR.v2) return;
    TR.enabled = false; TR.reason = reason; TR.orders.clear(); TR.positions.clear();
    setArmed(false); renderTrading(); syncAccounts();
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
    sel.disabled = !TR.accounts.length;                            // enabled again after a trading-off spell with no accounts (review 2, S1)
  }
  /* Order bar, order lines, position line; also run on every instrument switch and order message. */
  function renderTrading() {
    if (!TRADING || !TR.v2) return;
    const bar = $('obar'); bar.hidden = false;
    const on = TR.enabled, root = D.root || S.root, cap = OT.maxQtyFor(TR, root);
    for (const el of bar.querySelectorAll('button, input, select')) if (el !== $('oAcct')) el.disabled = !on;   // the account picker works with trading off too (it drives the fills)
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
    vpLegend();
    legendBarT = e.hovering ? e.bar.t : null; deltaLegend();
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
  /* the delta pane's height, dragged or keyed on its divider: saved per pane when the move ends (1.7.0) */
  chart.on('paneResize', e => { if (e && e.done) prefs.setPaneHeight(PANE, 'delta', e.ratio); });
  chart.on('tool', t => { $('toolTrend').setAttribute('aria-pressed', String(t === 'trend')); $('toolHline').setAttribute('aria-pressed', String(t === 'hline')); });

  const themePanel = CE.mountThemePanel(chart, $('colorsHost'), {
    storageKey: PREFIX + 'live-colors-v1',
    onChange: () => {
      const T = chart.colors(), st = rootEl.style;
      st.setProperty('--vwap-sw', T.vwapText); st.setProperty('--up-text', T.upText); st.setProperty('--down-text', T.downText);
      // the legend sits on the chart, so it follows the chart's ground (1.5.3); the toolbar and status line stay dark
      st.setProperty('--chart-bg', T.bg); st.setProperty('--lg-bg', T.legendBg); st.setProperty('--lg-head', T.tagText);
      st.setProperty('--lg-text2', T.text2); st.setProperty('--lg-dim', T.axisText); st.setProperty('--lg-buy', T.long); st.setProperty('--lg-sell', T.short);
      // buy and sell keep their green and red; where they do not read on the ground, a halo in the house ink (1.5.3)
      const halo = ink => ink ? '0 0 2px ' + ink + ', 0 0 1px ' + ink + ', 0 0 1px ' + ink : 'none';
      st.setProperty('--lg-buy-halo', halo(T.halo.long)); st.setProperty('--lg-sell-halo', halo(T.halo.short));
      rootEl.dataset.ground = T.ground;
      // a light ground takes the toolbar, menus and status line light too (Anthony, 1.5.3); dark grounds keep the house style
      const chrome = U.chromeColors(T);
      for (const k of U.CHROME_VARS) { if (chrome) st.setProperty(k, chrome[k]); else st.removeProperty(k); }
      st.setProperty('--ib-sw', chrome ? U.markOnGround(CE.LEVEL_COLORS.ibHigh, T.bg, CE.FLOOR.text, T.to) : CE.LEVEL_COLORS.ibHigh);
      // the volume profile: its menu swatch as the IB's (on the page chrome), the legend's POC on the chart ground
      st.setProperty('--vp-sw', chrome ? U.markOnGround(CE.DEFAULT_THEME.vpPoc, T.bg, CE.FLOOR.text, T.to) : CE.DEFAULT_THEME.vpPoc);
      st.setProperty('--vp-poc', T.vpPocText);
      st.setProperty('--delta-sw', T.upText);                       // the delta pane's swatch: the bull candle color, readable here
      deltaLegendKey = '';
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

  /*
   * Indicators (1.6.0, Anthony's menu "E2"): one menu per chart pane, saved per pane id (LivePrefs.Pane).
   * The menu: a search box (focused on open), the last 5 used, "On this chart" (a show or hide switch that keeps
   * everything, the swatch, the name, a pin for the chip strip, a gear with the one open settings panel, an x to take it
   * off), then the groups, folded, one open at a time, each with a + to add, and Hide all / Restore. The chip strip next
   * to the button holds the pinned ones: one click shows or hides; on a narrow pane each chip is one letter.
   */
  const IND = LP.INDICATORS, ALL_DEFS = IND.concat(LP.COMING);
  const defOf = id => ALL_DEFS.find(d => d.id === id);
  const M = { q: '', cat: null, gear: null, returnTo: null, note: '' };   // menu state that is not saved
  const SVG = {
    plus: '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M5 1v8M1 5h8"/></svg>',
    pin: '<svg width="13" height="13" viewBox="0 0 14 14" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M7 1.5l1.7 3.5 3.8.5-2.8 2.6.7 3.8L7 10.1 3.6 11.9l.7-3.8L1.5 5.5l3.8-.5z"/></svg>',
    gear: '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M2 4h6M11 4h1M2 10h1M6 10h6"/><circle cx="9.5" cy="4" r="1.5"/><circle cx="4.5" cy="10" r="1.5"/></svg>',
    x: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8"/></svg>',
  };

  /* Draw what the state says: only the layers that changed are handed to the chart. */
  function applyIndicators() {
    const drawn = LP.Pane.drawn(IS);
    for (const k of Object.keys(drawn)) {
      if (drawn[k] === S.layers[k]) continue;
      S.layers[k] = drawn[k];
      if (k === 'fills') applyMarkers(); else chart.setLayers({ [k]: drawn[k] });
      if (k === 'ib') ibNote(D.ib);
      if (k === 'vp') vpBuild();                                   // built from the tick store when shown, dropped when not
    }
    // the delta pane (1.7.0): kept while on the chart, shown or hidden, so the chip or the switch shows it at once
    // (review S5); made from the store when it comes onto the chart, never with a reload (round 4)
    if (deltaWanted() && !D.delta && !deltaBuilding()) deltaStart();
    else if (!IS.ind.delta.on && (D.delta || deltaBuilding())) deltaStop();
    else { deltaView(); deltaLegend(true); }
    legendKey = '';
    syncIndicators();
  }
  /* One change, here and in storage (read fresh there, so another tab's choices are kept). `fn` runs twice, so it
     must be absolute: what a click means is worked out from IS first (Pane.toggleOp, hideAllOp; review S1). */
  function changeIndicators(fn) {
    IS = fn(IS);
    prefs.updatePane(PANE, fn);
    applyIndicators();
  }

  function rowHtml(d) {
    const st = IS.ind[d.id], coming = !!d.coming, on = !coming && st.on, shown = on && st.shown, pinned = !coming && st.pin, open = M.gear === d.id;
    const name = esc(d.name), setId = p + 'indSet-' + d.id;
    const lead = coming ? '<span class="ind-lead" aria-hidden="true"></span>'
      : on ? `<button type="button" class="ind-switch" data-act="toggle" data-id="${d.id}" data-f="sw:${d.id}" aria-pressed="${shown}" aria-label="${shown ? 'Hide' : 'Show'} ${name}" title="${shown ? 'Hide' : 'Show'}; its settings are kept"><span class="knob" aria-hidden="true"></span></button>`
      : `<button type="button" class="ind-add" data-act="toggle" data-id="${d.id}" data-f="add:${d.id}" aria-label="Add ${name} to this chart" title="Add to this chart">${SVG.plus}</button>`;
    /* the pin only on rows on this chart (Anthony); the gear wherever there is something to read */
    const tools = coming ? '<span class="ind-ic-sp" aria-hidden="true"></span>'
      : (on ? `<button type="button" class="ind-ic ind-pin" data-act="pin" data-id="${d.id}" data-f="pin:${d.id}" aria-pressed="${pinned}" aria-label="${pinned ? 'Unpin ' + name + ' from' : 'Pin ' + name + ' to'} the chip strip" title="${pinned ? 'Unpin from' : 'Pin to'} the chip strip">${SVG.pin}</button>` : '') +
        `<button type="button" class="ind-ic" data-act="gear" data-id="${d.id}" data-f="gear:${d.id}" aria-expanded="${open}"${open ? ` aria-controls="${setId}"` : ''} aria-label="${name} settings" title="Settings">${SVG.gear}</button>`;
    const x = on ? `<button type="button" class="ind-ic" data-act="remove" data-id="${d.id}" data-f="x:${d.id}" aria-label="Take ${name} off this chart" title="Take off this chart">${SVG.x}</button>` : '';
    const set = open && !coming ? `<div class="ind-set" id="${setId}" data-id="${d.id}"><div class="ind-set-line"><span class="ind-set-sw" style="--sw: ${d.sw}" aria-hidden="true"></span><span class="ind-set-t">${esc(d.opt)}</span></div>${optionsHtml(d.id)}</div>` : '';
    return `<div class="ind-item${coming ? ' is-coming' : ''}${shown ? ' is-shown' : ''}" data-id="${d.id}"><div class="ind-row">${lead}` +
      `<span class="sw" style="--sw: ${shown ? d.sw : 'var(--line-strong)'}" aria-hidden="true"></span><span class="ind-name">${name}</span>` +
      (coming ? '<span class="ind-tag">coming</span>' : '') + tools + x + `</div>${set}</div>`;
  }
  /* An indicator's real options in its gear panel (LivePrefs INDICATOR_OPTIONS): today the volume profile's hours. */
  const OPTION_TEXT = { vp: { session: { label: 'Hours', values: { full: ['Session', 'Every trade from 18:00 ET'], rth: ['RTH', '9:30 to 16:00 ET (13:00 on NYSE early closes)'] } } },
    delta: { show: { label: 'Show', values: { cum: ['Cumulative', 'Candles of buys minus sells, from 0 at 18:00 ET'], bar: ['Bar delta', 'Each bar\'s own buys minus sells, above or below zero'] } } } };
  function optionsHtml(id) {
    if (!Object.prototype.hasOwnProperty.call(LP.INDICATOR_OPTIONS, id)) return '';
    return Object.keys(LP.INDICATOR_OPTIONS[id]).map(k => {
      const t = OPTION_TEXT[id][k], cur = S.options[id][k], lblId = p + 'indOpt-' + id + '-' + k;
      const btns = LP.INDICATOR_OPTIONS[id][k].map(v => `<button type="button" data-act="opt" data-id="${id}" data-k="${k}" data-v="${v}" data-f="opt:${id}:${k}:${v}" aria-pressed="${v === cur}" title="${esc(t.values[v][1])}">${esc(t.values[v][0])}</button>`).join('');
      return `<div class="ind-set-opt"><span class="glabel" id="${lblId}">${esc(t.label)}</span><span class="seg sans ind-opt" role="group" aria-labelledby="${lblId}">${btns}</span><span class="ind-set-note">${esc(t.values[cur][1])}</span></div>`;
    }).join('');
  }
  function renderMenu() {
    const body = $('indBody'), c = LP.Pane.counts(IS);
    $('indSum').textContent = c.on ? c.shown + ' shown' + (c.hidden ? ', ' + c.hidden + ' hidden' : '') : 'none on this chart';
    const hide = $('indHideAll'), label = LP.Pane.hideLabel(IS);
    hide.textContent = label;
    hide.disabled = label === 'Hide all (0)';
    hide.title = label === 'Restore' ? 'Show again the ones Hide all hid' : 'Hide every indicator on this chart, settings kept. The open trade, working orders and stop and target lines always stay.';
    const focusKey = document.activeElement && body.contains(document.activeElement) ? document.activeElement.dataset.f : null;
    let html = M.note ? `<div class="ind-note">${esc(M.note)}</div>` : '';
    const q = M.q.trim();
    if (q) {
      const found = LP.searchIndicators(q);
      html += `<div class="ind-cap">${found.length ? 'Results' : 'No match'}</div>` + found.map(rowHtml).join('');
    } else {
      if (IS.recent.length) html += '<div class="ind-recent"><span class="ind-cap-in">Recent</span>' + IS.recent.map(id => {
        const d = defOf(id), shown = IS.ind[id].on && IS.ind[id].shown;
        return `<button type="button" class="ind-rec" data-act="toggle" data-id="${id}" data-f="rec:${id}" aria-pressed="${shown}" aria-label="${esc(d.name)}" title="${esc(d.name)}: click to ${IS.ind[id].on ? (shown ? 'hide' : 'show') : 'add'}">${esc(d.short)}</button>`;
      }).join('') + '</div>';
      html += '<div class="ind-cap">On this chart</div>';
      const onChart = IND.filter(d => IS.ind[d.id].on);
      html += onChart.length ? onChart.map(rowHtml).join('') : '<div class="ind-empty">Nothing on this chart yet: add one from a group below.</div>';
      html += '<div class="ind-sep"></div>';
      for (const cat of LP.CATEGORIES) {
        const all = ALL_DEFS.filter(d => d.cat === cat.id), open = M.cat === cat.id;
        html += `<button type="button" class="ind-cat" data-act="cat" data-id="${cat.id}" data-f="cat:${cat.id}" aria-expanded="${open}"><span class="ind-caret${open ? ' is-open' : ''}" aria-hidden="true"></span><span class="ind-cat-name">${esc(cat.name)}</span><span class="ind-cat-n">${all.length}</span></button>`;
        if (open) {
          const rows = all.filter(d => d.coming || !IS.ind[d.id].on);
          html += rows.length ? rows.map(rowHtml).join('') : '<div class="ind-empty">All on this chart</div>';
        }
      }
      html += '<div class="ind-coming">Coming: time and sales</div>';
    }
    body.innerHTML = html;
    /* one live region, changed only when its text changes, so a screen reader hears the result count and notes once */
    const said = M.note || (q ? (() => { const n = LP.searchIndicators(q).length; return n ? n + (n === 1 ? ' match' : ' matches') : 'No match'; })() : '');
    if ($('indLive').textContent !== said) $('indLive').textContent = said;
    if (focusKey) {                                                 // keep the keyboard where it was
      const alt = { 'sw:': 'add:', 'add:': 'sw:', 'x:': 'add:', 'rec:': 'rec:' };
      let el = body.querySelector(`[data-f="${focusKey}"]`);
      if (!el) for (const k of Object.keys(alt)) if (focusKey.startsWith(k)) el = body.querySelector(`[data-f="${alt[k] + focusKey.slice(k.length)}"]`);
      (el || $('indQ')).focus();
    }
  }
  function renderChips() {
    const strip = $('indChips'), pinned = IND.filter(d => IS.ind[d.id].on && IS.ind[d.id].pin);
    strip.classList.toggle('is-empty', !pinned.length);
    strip.innerHTML = pinned.map(d => {
      const shown = IS.ind[d.id].shown;
      return `<button type="button" class="ind-chip" data-id="${d.id}" aria-pressed="${shown}" aria-label="${esc(d.name)}" title="${esc(d.name)}: ${shown ? 'shown, click to hide' : 'hidden, click to show'}">` +
        `<span class="sw" style="--sw: ${shown ? d.sw : 'var(--line-strong)'}" aria-hidden="true"></span><span class="ind-chip-t" aria-hidden="true">${esc(d.short)}</span><span class="ind-chip-l" aria-hidden="true">${esc(d.letter)}</span></button>`;
    }).join('');
    fitChips();
  }
  /* The strip never wraps and never moves the toolbar (review N4): it always keeps room for a full strip of one-letter
     chips (6), so pinning or unpinning cannot change the toolbar's lines, and chips show their names only when that
     fits without adding a toolbar line; otherwise each is one letter. */
  function fitChips() {
    const strip = $('indChips'), bar = strip.closest('.bar');
    const room = Math.min(LP.PIN_MAX * 30 + (LP.PIN_MAX - 1) * 4, Math.max(0, bar.clientWidth - $('indWrap').offsetWidth - 8));
    strip.style.setProperty('--chip-room', room + 'px');
    strip.classList.add('is-narrow');
    const h = bar.offsetHeight;
    strip.classList.remove('is-narrow');
    if (bar.offsetHeight > h || strip.scrollWidth > strip.clientWidth + 1) strip.classList.add('is-narrow');
  }
  function syncIndicators() {
    const c = LP.Pane.counts(IS);
    $('indCount').textContent = c.shown + '/' + c.on;
    $('indBtn').setAttribute('aria-label', 'Indicators, ' + c.shown + ' shown of ' + c.on + ' on this chart');
    renderChips();
    if (!$('indPanel').hidden) renderMenu();
  }
  const STRIP_FULL = () => 'The chip strip holds ' + LP.PIN_MAX + ': unpin one to pin another.';
  function indAction(act, id) {
    M.note = '';
    if (act === 'toggle') {
      const adding = !IS.ind[id].on, full = LP.Pane.pinFull(IS);
      if (adding && full) M.note = LP.INDICATORS.find(d => d.id === id).name + ' added without a chip. ' + STRIP_FULL();
      changeIndicators(LP.Pane.toggleOp(IS, id));
    } else if (act === 'remove') { if (M.gear === id) M.gear = null; changeIndicators(st => LP.Pane.remove(st, id)); }
    else if (act === 'pin') {
      const v = !IS.ind[id].pin;
      if (v && LP.Pane.pinFull(IS)) { M.note = STRIP_FULL(); renderMenu(); return; }   // refused: the strip is full
      changeIndicators(st => LP.Pane.pin(st, id, v));
    }
    else if (act === 'gear') { M.gear = M.gear === id ? null : id; renderMenu(); }
    else if (act === 'cat') { M.cat = M.cat === id ? null : id; renderMenu(); }
  }
  let openMenu;
  {
    const wrap = $('indWrap'), btn = $('indBtn'), panel = $('indPanel'), q = $('indQ');
    /* The panel stays inside the chart's own element (a pane can be narrow, and a host may clip it). */
    /* It opens below the order bar when there is one, so the Armed switch, the account and the position readout stay
       in view (review N5); its list scrolls inside when the space is short. */
    const place = () => {
      const r = rootEl.getBoundingClientRect(), b = btn.getBoundingClientRect(), w = wrap.getBoundingClientRect();
      const ob = $('obar'), below = ob && !ob.hidden ? ob.getBoundingClientRect().bottom : b.bottom;
      panel.style.top = Math.round(below - w.top + 6) + 'px';
      panel.style.maxWidth = Math.max(220, Math.floor(r.right - b.left - 8)) + 'px';
      panel.style.maxHeight = Math.max(200, Math.floor(Math.min(r.bottom, window.innerHeight) - below - 14)) + 'px';
    };
    openMenu = (v, from) => {
      if (v === !panel.hidden) { if (v) q.focus(); return; }
      panel.hidden = !v; btn.setAttribute('aria-expanded', String(v));
      if (v) {
        M.returnTo = from && from !== document.body && !wrap.contains(from) ? from : btn;
        M.cat = null; M.q = ''; q.value = ''; M.note = '';            // groups folded and a clean search on every open (Anthony)
        place(); renderMenu(); q.focus(); q.select();
      } else { M.gear = null; M.note = ''; M.q = ''; q.value = ''; $('indLive').textContent = ''; }   // reopening shows the normal view (review S2)
    };
    const close = refocus => {
      if (panel.hidden) return;
      openMenu(false);
      if (refocus) { const to = M.returnTo && M.returnTo.isConnected ? M.returnTo : btn; to.focus(); }
    };
    btn.addEventListener('click', () => { if (panel.hidden) openMenu(true, btn); else close(false); });
    q.addEventListener('input', () => { M.q = q.value; renderMenu(); });
    q.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || !M.q.trim()) return;                 // Enter adds or shows the first match, never hides it
      const first = LP.searchIndicators(M.q).find(d => !d.coming);
      if (!first) return;
      e.preventDefault();
      if (!IS.ind[first.id].on) indAction('toggle', first.id);
      else if (!IS.ind[first.id].shown) { M.note = ''; changeIndicators(st => LP.Pane.add(st, first.id)); }
    });
    panel.addEventListener('click', e => {
      const b = e.target.closest('button[data-act]');
      if (!b || !panel.contains(b)) return;
      if (b.dataset.act === 'opt') { M.note = ''; setIndicatorOption(b.dataset.id, b.dataset.k, b.dataset.v); return; }   // saved per pane, as it is
      indAction(b.dataset.act, b.dataset.id);
    });
    $('indHideAll').addEventListener('click', () => { M.note = ''; changeIndicators(LP.Pane.hideAllOp(IS)); });
    $('indChips').addEventListener('click', e => {
      const b = e.target.closest('button[data-id]'); if (!b) return;
      const id = b.dataset.id, v = !IS.ind[id].shown;          // decided once, from what this chart shows
      changeIndicators(v ? st => LP.Pane.add(st, id, false) : st => LP.Pane.setShown(st, id, false));   // a chip is not a recent use
    });
    listen(document, 'pointerdown', e => { if (!panel.hidden && !wrap.contains(e.target)) close(false); });
    wrap.addEventListener('keydown', e => {
      if (panel.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && panel.contains(e.target) && e.target.tagName !== 'SELECT') {
        const list = [...panel.querySelectorAll('input, button, select')].filter(el => !el.disabled && el.offsetParent !== null);
        const i = list.indexOf(e.target);
        if (i < 0) return;
        e.preventDefault();
        const next = list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length];
        if (next) next.focus();
      }
    });
    wrap.addEventListener('focusout', e => { if (!panel.hidden && e.relatedTarget && !wrap.contains(e.relatedTarget)) openMenu(false); });
    /* "/" opens this chart's menu only when the focus is inside this chart, or on the page itself (nothing focused) with
       the mouse over this chart (or it is the only chart). Never while typing in a box (order quantity, bracket ticks,
       range size), never while anything outside the chart has the focus (a host's dialog or fields), never with Ctrl,
       Alt or Cmd, and the PIN pad stops every key before it gets here. */
    listen(document, 'keydown', e => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || destroyed) return;
      const a = document.activeElement;
      if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
      const onBody = !a || a === document.body || a === document.documentElement;
      if (!onBody && !rootEl.contains(a)) return;                   // the focus is elsewhere (a host dialog, another chart)
      const mine = !onBody || (hoverRoot ? hoverRoot === rootEl : mountedRoots.size === 1);
      if (!mine) return;
      e.preventDefault();
      openMenu(true, a);
    });
    rootEl.addEventListener('pointerenter', () => { hoverRoot = rootEl; });
    rootEl.addEventListener('pointerleave', () => { if (hoverRoot === rootEl) hoverRoot = null; });
    mountedRoots.add(rootEl);
    cleanups.push(() => { mountedRoots.delete(rootEl); if (hoverRoot === rootEl) hoverRoot = null; });
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => { fitChips(); if (!panel.hidden) place(); });
      ro.observe(rootEl);
      ro.observe(rootEl.querySelector('.bar'));                  // the toolbar's own width (a host resizing the pane)
      cleanups.push(() => ro.disconnect());
    }
  }
  $('acctPick').addEventListener('change', e => pickViewAccount(e.target.value));
  $('toolTrend').addEventListener('click', () => chart.setTool(chart.getTool() === 'trend' ? null : 'trend'));
  $('toolHline').addEventListener('click', () => chart.setTool(chart.getTool() === 'hline' ? null : 'hline'));
  $('clearDraw').addEventListener('click', () => chart.clearDrawings());
  $('resetBtn').addEventListener('click', () => chart.reset());
  if (PIN) { $('pinBtn').hidden = !PIN.active(); $('pinBtn').addEventListener('click', () => PIN.openChange()); }
  syncButtons();
  syncAccounts();

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
      if (!tradeMode()) { pickViewAccount(e.target.value); return; }   // trading off: it only picks whose fills are marked
      TR.account = e.target.value;
      if (TR.armed) { setArmed(false); flash('Armed turned off: the account changed.', 'warn'); }
      renderTrading();
      viewAccount = TR.account; store.set('live-account-v1', TR.account);
      applyMarkers();
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
    $('dFeed').textContent = f === null ? '-' : Math.round(f) + ' ms' + (f < 0 ? ' (PC clock behind)' : '');
    $('dLocal').textContent = l === null ? '-' : (l < 1 ? '<1' : Math.round(l)) + ' ms';
    const s = chart.stats();
    $('fps').textContent = s.idle ? 'idle' : s.fps + ' fps · ' + s.drawMs.toFixed(1) + ' ms/frame';
    $('ticksSeen').textContent = ticksSeen.toLocaleString() + ' live ticks';
    renderPositionInfo();
    // the clock crossing 9:30, 10:30 or 18:00, with or without trades; also while offline, when minutes missing
    // since the drop hide the IB (a 'gap') rather than leave a stale one up
    if (D.m1) updateIB(false);
    // the volume profile moves to the new session at 18:00 ET on the clock, before its first trade
    if (D.vp && D.vp.advance(etNow())) vpLegend();
    vpNote(); vpLegend();
  }, 500);

  if (document.fonts && document.fonts.load) {
    Promise.all([document.fonts.load('500 11px "IBM Plex Mono"'), document.fonts.load('600 10px "IBM Plex Sans Condensed"'), document.fonts.load('600 11px "IBM Plex Mono"')]).then(() => { if (!destroyed) { chart.setLayers({}); fitChips(); } }, () => {});
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
  return { destroy, chart, element: rootEl, paneId: PANE, setIndicatorOption, indicatorOptions: id => Object.assign({}, Object.prototype.hasOwnProperty.call(S.options, id) ? S.options[id] : {}) };
}

window.ChartLive = { mount, EMBED_PREFIX };
/* The standalone page: behind ChartBridge's PIN (live/pin.js) when ChartBridge has one, nothing started until unlocked. */
if (SCRIPT && SCRIPT.getAttribute('data-mount') === 'page') {
  if (window.ChartBridgePin) window.ChartBridgePin.gate().then(() => start(document.body, {}, true));
  else start(document.body, {}, true);
}
})();
