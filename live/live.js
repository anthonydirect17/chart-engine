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
 *   live-indicator-options-v1  { <paneId>: { vp: { session: 'full' | 'rth' } } } an indicator's own options, per pane
 *                       (INDICATOR_OPTIONS, 1.6.0; the volume profile's hours)
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
  { id: 'fills', name: 'Fills', short: 'FILLS', letter: 'F', cat: 'trades', sw: 'var(--profit)', alias: 'fills executions trades',
    opt: 'Past fills and trade marks of the account picked (side and size at the fill price). Hiding them never hides the open trade: its entry fills, the position line, working orders and stop and target lines stay.' },
];
/* Listed in the menu, tagged "coming" and not selectable until they exist (none since the volume profile, 1.6.0). */
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
const DEFAULT_INDICATORS = { volume: true, vwap: true, levels: true, fills: true, ib: true, vp: false };   // the profile: off on every pane
/* A new pane (the grid, next step) starts with no indicators on; Anthony picks them per pane (2026-09-29). */
const NEW_PANE_INDICATORS = { volume: false, vwap: false, levels: false, fills: false, ib: false, vp: false };
/*
 * Options an indicator has besides on and off, each a list of allowed values with the default first (set in its gear
 * panel). The volume profile: the full session from 18:00 ET, or RTH 9:30 to 16:00 ET, 13:00 on NYSE early closes
 * (Anthony's ruling 2026-09-29).
 */
const INDICATOR_OPTIONS = { vp: { session: ['full', 'rth'] } };
const MAIN_PANE = 'main';

const KEYS = { settings: 'live-settings-v2', range: 'live-range-v2', indicators: 'live-indicators-v2', bracket: 'live-bracket-v1', indicatorOptions: 'live-indicator-options-v1' };
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
  for (const id of IND_IDS) { const on = main && DEFAULT_INDICATORS[id]; ind[id] = { on, shown: true, pin: on }; }
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
  return out;
}
/*
 * A pane saved by 1.4 to 1.5.3 (live-indicators-v1), carried over so every indicator draws exactly as before; an
 * explicit off stays off. The main pane listed all five as its own, so each stays on the chart: the ones that were
 * off are hidden (one click brings one back, as before) and all five are pinned. Any other pane started empty, so
 * only the ones that were on are on its chart (pinned); an off there is off, as on a new pane. The volume profile is
 * read like the others: a 1.5.3 save never has a vp key, so it starts off after upgrading from 1.5.3; a save from the
 * unreleased profile test build that had it on keeps it on (shown and pinned, the main pane's sixth chip).
 */
function paneFromV1(v1, paneId) {
  const main = paneId === MAIN_PANE;
  const flags = cleanIndicators(v1, main ? DEFAULT_INDICATORS : NEW_PANE_INDICATORS);
  const out = defaultPane(paneId);
  for (const id of IND_IDS) {
    const listed = main && DEFAULT_INDICATORS[id];                 // the main pane's own five (never the volume profile)
    out.ind[id] = listed ? { on: true, shown: flags[id], pin: true } : { on: flags[id], shown: true, pin: flags[id] };
  }
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

/*
 * The order account when trading comes on (1.6.1, Anthony's ruling 2026-09-30: "the account I was using", not
 * Sim101). `allowed` is ChartBridge's list of trade accounts now; `wanted` is the account this tab is on: after a page
 * load the last one picked on this PC (live-account-v1 under the storage prefix), after a reconnect that keeps the
 * page the one it was on. It is used only when ChartBridge allows it now; otherwise Sim101 (or the first allowed, as
 * before), and `missed` names the account that could not be used, for the note "Last account ... not available".
 * Nothing about Armed is here: Armed is never saved and is off after every load and every reconnect.
 */
function orderAccount(allowed, wanted) {
  const list = Array.isArray(allowed) ? allowed.filter(a => typeof a === 'string' && a) : [];
  const want = typeof wanted === 'string' ? wanted : '';
  if (want && list.includes(want)) return { account: want, missed: '' };
  const account = list.includes('Sim101') ? 'Sim101' : list[0] || '';
  return { account, missed: want && want !== account ? want : '' };
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

api = { create, debounce, orderAccount, parseRange, clampRange, cleanIndicators, cleanIndicatorOptions, indicatorOptionAllowed, INDICATOR_OPTIONS, cleanPane, defaultPane, paneFromV1, Pane, searchIndicators, KEYS, OLD, ROOTS, TFS, GLIDES, RANGE_MODES,
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
    <span class="ostate"><span class="oinfo" id="${p}oPos"></span><span class="oinfo olegs" id="${p}oLegs"></span><span class="oinfo dim oother" id="${p}oOther"></span><span class="oinfo acct-note" id="${p}oAcctNote" role="status"></span><span class="oinfo acct-note batch-note" id="${p}oCancel" role="status"></span><span class="ooff" id="${p}oOff"></span></span>
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
  </div>${o.trading ? `
  <div class="alert warn" id="${p}unsentBar" role="alert" hidden>
    <span class="alert-title">Cancel all</span><span class="alert-text" id="${p}unsentText"></span>
    <button type="button" class="btn" id="${p}unsentClose">Dismiss</button>
  </div>` : ''}

  <main class="stage">
    <div class="chart-box" id="${p}chart" aria-label="Live candlestick chart. Arrow keys pan, plus and minus zoom, End jumps to live, A fits the price axis, Delete removes the selected drawing."></div>
    <div class="legend" id="${p}legend">
      <div class="lg1"><b id="${p}lgName">MNQ</b><span class="tfbadge" id="${p}lgTf">1m</span><span class="dim" id="${p}lgSrc">NinjaTrader via ChartBridge · chart ${esc(CE.VERSION)}</span><span class="pill" id="${p}connPill">CONNECTING</span>${armPill}</div>
      <div class="lg2"><span class="dim" id="${p}lgTime">--:--</span><span>O <span id="${p}lgO">-</span></span><span>H <span id="${p}lgH">-</span></span><span>L <span id="${p}lgL">-</span></span><span>C <span id="${p}lgC">-</span></span><span id="${p}lgChg">-</span><span>Vol <span id="${p}lgV">-</span></span></div>
      <div class="lg3" id="${p}lgRow3"><span id="${p}lgVwWrap">VWAP <span class="vw" id="${p}lgVw">-</span></span><span id="${p}lgVp" hidden>POC <span class="vpc" id="${p}lgPoc">-</span> · VA <span id="${p}lgVal">-</span> to <span id="${p}lgVah">-</span><span class="vpday" id="${p}lgVpDay"></span></span><span id="${p}lgFill"></span></div>
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
    <span class="ibnote" id="${p}rangeNote" hidden></span>
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
  const S = Object.assign(prefs.settings(), { layers: LP.Pane.drawn(IS), options: { vp: prefs.indicatorOptions(PANE, 'vp') } });   // layers: what is drawn
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
    layers: { volume: S.layers.volume, vwap: S.layers.vwap, levels: S.layers.levels, ib: S.layers.ib, vp: S.layers.vp, trades: false },
    motion: GLIDE[S.glide], clock: etNow,
  });

  if (PAGE) window.liveChart = chart;  // for tests and the console; order actions still go through the checks below
  if (PAGE) window.liveData = () => D;  // the page's data, for tests and the console (read it; changing it breaks the chart)

  /* ---------------- per-instrument data */
  const D = { root: null, name: null, tick: 0.25, ready: false, hist: [], ticks: new BB.TickStore(), m1: null, cur: null, day: null, tickHours: 0, tickFrom: Infinity, trimmed: false,
    lv: [], ib: null, ibKey: '', vp: null, liveFrom: null,
    sub: 0, window: false, table: null, vpTable: null, sync: null };   // served window and session table (1.8.0): see "Served window" below
  /* Seconds and range bars are built from ticks; minute and hour bars only need 1-minute history (fast load).
     Range bars need the backfill to reach back to a session start (see rangeHistoryFrom in bar-builder.js).
     With ChartBridge 0.3.5 (hello "liveFirst") seconds and range views get ChartBridge's served window instead: the last
     rangeHours of trades (its config, default 2), whatever tickHours says (any number above 0 asks for it). */
  const tickView = () => TF[S.tf].mode === 'range' || TF[S.tf].sec < 60;
  const WINDOW_TICK_HOURS = 2;
  const viewTicksWanted = () => LIVE_FIRST ? (tickView() ? WINDOW_TICK_HOURS : 0) : TF[S.tf].mode === 'range' ? BB.rangeTickHours(etNow(), SESSION) : TF[S.tf].sec < 60 ? 8 : 0;
  const viewTicksMissing = () => LIVE_FIRST ? tickView() && D.tickHours === 0
    : TF[S.tf].mode === 'range' ? BB.rangeNeedsReload(D.tickFrom, etNow(), SESSION, D.trimmed) : TF[S.tf].sec < 60 && D.tickHours === 0;
  /* Each rule for ticks as its own function; the load asks for the most any of them wants (another rule joins as one
     more term of the max). 1.6.1 loads no tick history beyond the view's (as 1.6.0; Anthony 2026-09-30, after ChartBridge's
     big loads froze NinjaTrader during RTH); the volume profile's whole session, and the last session's after a weekend
     load, come from ChartBridge 0.3.5's session table (vpBuild). */
  const ticksWanted = () => viewTicksWanted();
  const ticksMissing = () => viewTicksMissing();
  /* The last price seen per instrument, kept across loads: click-to-place orders work while a view loads (1.8.0). */
  const lastSeen = {};
  let instruments = {};
  const fills = new Map();            // id -> fill, all instruments
  /* The account (1.6.0, Anthony: one picker for both). On a trading page the order bar's Account picker is the only
     one; with no order bar (a mounted chart, or ChartBridge 0.2) a compact one sits in the toolbar. The chart marks the
     fills of that account only. While trading is on, the account is the order account (TR.account); otherwise it is
     `viewAccount`, the last one picked, saved in live-account-v1. The 1.5 fills choice (live-fill-account-v1) is read
     once when there is none yet; its "All accounts" is gone and means none chosen.
     On the trading page (1.6.1, Anthony's ruling 2026-09-30) `viewAccount` is also the account this tab is on: when
     trading comes on (after a load, a PIN entry or a reconnect) the order account is that one if ChartBridge allows it
     now, else Sim101 with a note (LivePrefs.orderAccount, applyTrading). After a load it is the last one picked on
     this PC; the 1.5 fills choice is never an order account, so the trading page does not read it. Each trading tab
     keeps its own account while open: a pick in another tab is saved (the next load starts on it) but never changes
     this tab (followAccount). Armed is never saved: it is off after every load and every reconnect. */
  /* The account this trading tab was on survives a reload of that tab (sessionStorage, review S1): a reload comes back
     on it, a new tab on the last one picked on this PC. Written by every pick in this tab, never by a fallback. */
  const tabStore = (() => { if (!TRADING) return null; try { return prefixedStorage(window.sessionStorage, PREFIX); } catch (e) { return null; } })();
  const TAB_KEY = 'live-account-tab-v1';
  const tabAccount = () => { try { const v = tabStore && JSON.parse(tabStore.getItem(TAB_KEY)); return typeof v === 'string' && v ? v : ''; } catch (e) { return ''; } };
  const saveTabAccount = v => { try { if (tabStore) tabStore.setItem(TAB_KEY, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };
  const restored = { account: '', from: '' };                  // what a load started on, for the note: 'tab' or 'pc'
  let viewAccount = (() => {
    if (TRADING && tabAccount()) { restored.account = tabAccount(); restored.from = 'tab'; return restored.account; }
    const v = store.get('live-account-v1', null);
    if (typeof v === 'string' && v) { if (TRADING) { restored.account = v; restored.from = 'pc'; } return v; }
    if (TRADING) return '';
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
    D.window = false; D.table = null; D.sync = null; rangeNote();
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
    D.sync = null; rangeNote();                          // a range view's proven point (buildWindow)
    if (tf.mode === 'time' && tf.sec >= 60) {
      D.cur = null;
      const bars = tf.sec === 60 ? D.m1.bars : U.aggregate(D.m1.bars, tf.sec);
      chart.setBars(bars, { barSeconds: tf.sec });
      chart.setCountdown(null);
    } else if (D.window) {
      buildWindow(tf);
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

  /*
   * Served window (1.8.0, ChartBridge 0.3.5; nt8/PROTOCOL.md "Served window"). A seconds or range view starts with the last
   * rangeHours of trades (2 by default), which ChartBridge keeps for the session: a reload or a second page gets the same
   * trades, from the same first one. Range bars depend on where the build starts, so the view draws them only from the
   * first bar proven to be NinjaTrader's own (RangeSync in bar-builder.js: a session start, or a swing of more than the
   * range each way), and none before it; once drawn they stay all day (the store keeps the session's trades, onTick).
   * Seconds bars start at the first whole bar. The session VWAP starts from ChartBridge's session table (vwapSeed): its
   * price times volume and volume, less the trades the page holds; while the table is still building there is no VWAP
   * on these views (the table's backfill sends a new "profile" when it is whole, and the view is built again).
   */
  function newBuilder(tf, seed) {
    return tf.mode === 'range'
      ? new BarBuilder({ mode: 'range', rangeTicks: ranges[D.root], rangeMode: S.rangeMode, tick: D.tick, sessionStart: SESSION, vwapSeed: seed })
      : new BarBuilder({ mode: 'time', seconds: tf.sec, tick: D.tick, sessionStart: SESSION, vwapSeed: seed });
  }
  function buildWindow(tf) {
    if (tf.mode === 'time') {
      const t0 = D.ticks.length ? D.ticks.time(0) : Infinity;
      // the first bar the window holds whole: the one after the bar of its first trade
      const from = isFinite(t0) ? D.ticks.indexAt((Math.floor(t0 / tf.sec) + 1) * tf.sec) : 0;
      D.cur = newBuilder(tf, vwapSeed(from));
      D.ticks.feed(D.cur, from);
      chart.setBars(D.cur.bars, { barSeconds: tf.sec });
      chart.setCountdown(null);
    } else {
      const seed = vwapSeed(0), b = newBuilder(tf, seed), sync = { rs: new BB.RangeSync(ranges[D.root], D.tick, SESSION), bar: -1 };
      // the window starts with its session's first trade (the table has no trade of that session before it, a page opened
      // soon after 18:00 ET): the bar it opens is NinjaTrader's (Break at EOD)
      if (seed && seed.vol === 0 && D.ticks.length && U.tradeDay(D.ticks.time(0), SESSION) === seed.day) sync.bar = 0;
      D.cur = b;
      D.sync = sync;
      D.ticks.feed({ addQuiet(t, p, v) { const n0 = b.bars.length; b.addQuiet(t, p, v); if (sync.bar < 0 && sync.rs.step(t, p)) sync.bar = n0; } }, 0);
      showRange();
    }
    if (!D.ticks.length) setStatus('No tick history came back from NinjaTrader, so ' + tf.label + ' bars start with the next live tick.', 'warn');
  }
  /* The range bars from the first proven one (none until one is proven). */
  function showRange() {
    const sync = D.sync, on = sync.bar >= 0;
    chart.setBars(on ? D.cur.bars.slice(sync.bar) : [], { barSeconds: TF[S.tf].sec });
    chart.setCountdown(on ? () => { const r = D.cur && D.cur.rangeLeft(); return r ? '▲' + r.up + ' ▼' + r.down : ''; } : null);
    rangeNote();
  }
  function rangeNote() {
    const el = $('rangeNote'); if (!el) return;
    const text = D.ready && D.sync && D.sync.bar < 0
      ? 'Range bars start where they are proven to match NinjaTrader\'s: after a swing of more than the range each way, or at the next 18:00 ET session.' : '';
    if (el.textContent !== text) el.textContent = text;
    el.hidden = !text;
  }
  /* The session VWAP's start for a build fed from store index `from`: the session table's price times volume and volume
     (every trade of its session up to the table's store index `at`), less the trades of that session in [from, at), or
     plus those in [at, from). null while the table is not whole, or unknown. Whole ticks, so the sums are exact. */
  function vwapSeed(from) {
    const T = D.table;
    if (!T || !T.whole) return null;
    let pv = T.pvTicks, vol = T.vol;
    const lo = Math.min(from, T.at), hi = Math.min(Math.max(from, T.at), D.ticks.length), sign = from < T.at ? -1 : 1;
    for (let i = lo; i < hi; i++) {
      if (U.tradeDay(D.ticks.time(i), SESSION) !== T.day) continue;
      const v = D.ticks.volume(i);
      pv += sign * Math.round(D.ticks.price(i) / T.tick) * v; vol += sign * v;
    }
    return vol >= 0 && pv >= 0 ? { day: T.day, pv: pv * T.tick, vol } : null;
  }
  /* ChartBridge's "profile" (0.3.5): the session's volume at each price per half hour, exactly the trades before the store's
     current end (the ones after come as live ticks). */
  function onProfile(m) {
    const s = m.session, tick = +m.tick > 0 ? +m.tick : D.tick;
    if (!s || !Array.isArray(s.rows)) { D.table = null; return; }
    let pvTicks = 0, vol = 0;
    for (const r of s.rows) { pvTicks += r[1] * r[2]; vol += r[2]; }
    D.table = { from: +s.from, day: U.tradeDay(+s.from + 1, SESSION), whole: s.whole === true, coveredFrom: +s.coveredFrom, rows: s.rows,
      backfill: typeof s.backfill === 'string' ? s.backfill : '', drop: s.drop && +s.drop.at > 0 ? { at: +s.drop.at, why: String(s.drop.why || '') } : null, tick, pvTicks, vol, at: D.ticks.length,
      // the finished session's table (an RTH profile kept overnight and over a weekend, as 1.6.1 keeps it)
      last: m.last && Array.isArray(m.last.rows) ? { from: +m.last.from, day: U.tradeDay(+m.last.from + 1, SESSION), whole: m.last.whole === true, coveredFrom: +m.last.coveredFrom, rows: m.last.rows, backfill: 'done', drop: null } : null };
    if (D.ready) {
      vpBuild();
      if (D.window && tickView()) rebuild();              // the VWAP from the table now (the backfill made it whole)
    }
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
   * has the notes, and the backfill seam that is not settled). It holds the last session with trades and keeps it
   * after that session ends (1.6.1, Anthony's rulings 2026-09-30: the engine's `keep`): the full session over
   * weekends and NYSE holidays until the next session's first trade (on weekday evenings it moves at 18:00), RTH also
   * through the weekday night until the next RTH trade, so a Friday can be reviewed over the weekend. The legend
   * names the session's day, "(Fri)". Built from the store by VolumeProfile.fromStore: the last trade's session, or a
   * day earlier while that holds nothing (RTH: back to the last RTH in the store; the full session over a weekend or a
   * holiday). It holds only the ticks the view loaded (1.6.1 loads no more than 1.6.0) and the live ones. The IB keeps
   * its own rule (none on weekends and holidays). It does not depend on the view, so changing bars keeps it. While it
   * is off there is no profile at all.
   * Views that load no tick history (1m and longer, when the page subscribed on one: tickHours 0) have only the
   * live trades since `ready`, so the profile starts at the first live trade; a quiet note on the status line says
   * so, and says when the tick history does not reach back to 18:00 (or 9:30 for RTH).
   */
  function vpBuild() {
    D.vp = null; D.vpTable = null;
    if (S.layers.vp && D.ready) {
      const opts = { tick: D.tick, sessionStart: SESSION, rth: S.options.vp.session === 'rth', keep: true };
      let vp = CE.VolumeProfile.fromStore(D.ticks, opts);   // the last session with trades, kept until the next one's first
      // 1.8.0: ChartBridge's session table (or, with nothing of its session counted yet, the last session's: an RTH profile
      // kept overnight), unless the page's own trades are of a later session (it was open across 18:00)
      const tv = vpFromTable(opts);
      if (tv && !tv.vp.empty && !(vp.day !== null && vp.day > tv.vp.day)) { vp = tv.vp; D.vpTable = tv.table; }
      D.vp = vp;
      D.vp = vp;
    }
    chart.setProfile(D.vp);
    vpNote(); vpLegend();
  }
  /* ChartBridge's table as a profile (1.8.0): its rows (a row's time is the start of its half hour of New York time, and
     9:30, 13:00 and 16:00 are half hour edges, so RTH takes exactly its rows too), then the trades the store got after it.
     When that counts nothing (an RTH profile before today's 9:30), the last session's table, kept as 1.6.1 keeps it. */
  function vpFromTable(opts) {
    const T = D.table;
    if (!T) return null;
    const make = tab => {
      const v = new CE.VolumeProfile(opts);
      for (const r of tab.rows) v.add(r[0], +(r[1] * T.tick).toFixed(10), r[2]);
      D.ticks.feed(v, T.at, v.startOfDay(tab.day));
      return v;
    };
    let v = make(T), tab = T;
    if (v.empty && T.last) { v = make(T.last); tab = T.last; }
    return { vp: v, table: tab };
  }
  /* What the profile holds against what its session needs: the session held (kept after it ends), or while there is
     none yet the clock's; and from when every trade is known: the tick backfill's start (later when NinjaTrader sent
     less than asked, or the page dropped its oldest ticks; earlier when it sent more), or with no tick history
     (tickHours 0) the moment the page went live. */
  function vpCover() {
    const now = etNow(), held = !D.vp.empty, need = D.vp.day !== null ? D.vp.startOfDay(D.vp.day) : D.vp.startOf(now);
    const t0 = D.ticks.length ? D.ticks.time(0) : Infinity;
    /* The first tick later than asked means NinjaTrader sent less, except when the ticks were asked from before the
       session's start and the first tick is the session's first trade: stamped a few ms after 18:00:00.000 (or 9:30),
       with nothing traded before it after a halt or the break (review 2 S4). Checked against the 1-minute bars the
       page loaded (review 3 S3): none with volume between the start and the first tick's minute, and that minute's
       ticks hold its bar's volume (2% for rounding). With no bar to check against, only within 5 s of the start. */
    const sessionFirst = !D.trimmed && D.tickFrom <= need && t0 >= need && openWhole(need, t0);
    const tab = D.vpTable;                             // 1.8.0: from ChartBridge's table, it says itself from when it is whole
    const coveredFrom = tab ? (tab.whole ? Math.min(tab.from, need) : tab.coveredFrom) : D.tickHours > 0 ? (sessionFirst ? Math.min(D.tickFrom, need) : Math.max(Math.min(D.tickFrom, t0), D.trimmed || t0 - 600 > D.tickFrom ? t0 : -Infinity)) : D.liveFrom;
    const partial = held && coveredFrom > need, t = Math.min(coveredFrom, now), hm = U.fmtHM(t);
    // where the ticks start, to the second when that is in the session's first minute ("from 18:00:45", review 3 S3)
    const fromText = partial && hm === U.fmtHM(need) ? hm + ':' + String(Math.floor(U.tod(t) % 60)).padStart(2, '0') : hm;
    return { now, held, need, coveredFrom, partial, fromText };
  }
  let openChecked = { key: '', whole: false };
  function openWhole(need, t0) {
    const key = need + '|' + t0 + '|' + D.hist.length;
    if (openChecked.key === key) return openChecked.whole;
    const m0 = Math.floor(t0 / 60) * 60;
    let bar0 = null, before = false;
    for (const b of D.hist) { if (b.t >= need && b.t < m0 && b.v > 0) before = true; if (b.t === m0) bar0 = b; }
    let whole;
    if (!bar0) whole = t0 <= need + 5;
    else if (before) whole = false;
    else { let v = 0; for (let i = 0; i < D.ticks.length && D.ticks.time(i) < m0 + 60; i++) v += D.ticks.volume(i); whole = v >= bar0.v * 0.98; }
    openChecked = { key, whole };
    return whole;
  }
  /* The quiet note while the profile is on and cannot show the whole session (or RTH) for a reason. */
  function vpNote() {
    const el = $('vpNote'); if (!el) return;
    let text = '';
    if (S.layers.vp && D.ready && D.vp) {
      const { now, held, need, coveredFrom, partial, fromText } = vpCover(), rth = D.vp.rth, from = rth ? '9:30' : '18:00';
      /* nothing counted yet: a small note, never an error, and never advice to reload (1.6.1 loads no tick history
         beyond the view's: the last session after a load comes with chart 1.8.0's session table) */
      if (!held && rth) {
        const next = U.rthDay(need) && now < need ? ' The next starts at 9:30 ET.' : '';
        const open = U.rthClose(now) !== null && U.tod(now) >= 34200 && U.tod(now) < U.rthClose(now);
        text = D.tickHours === 0 ? 'Volume profile (RTH): this view loads no tick history, so it counts the RTH trades from ' + (open ? 'now' : 'the next 9:30 ET') + ' on.'
          : 'Volume profile (RTH): the last RTH session is not in the tick history this view loaded.' + next;
      }
      else if (!held) text = D.tickHours === 0 ? 'Volume profile from ' + U.fmtHM(Math.min(coveredFrom, now)) + ' ET: this view loads no tick history, so it counts the live trades from then on.'
        : 'Volume profile: no trades of the last session in the tick history this view loaded.';
      else if (D.vpTable && D.vpTable.drop && D.vpTable.drop.at >= need) text = 'Volume profile missing trades: the data connection dropped at ' + U.fmtHM(D.vpTable.drop.at) + ' ET, and the trades while it was down are not in it.';
      else if (partial && D.vpTable) {                 // 1.8.0: ChartBridge's table: its one backfill still to come (building), or none (since)
        const T = D.vpTable, building = /^(wanted|queued|asked|failed once)/.test(T.backfill);
        text = building ? 'Volume profile building, from ' + fromText + ' ET: ChartBridge started after ' + from + ' ET and loads the session once, in the background.'
          : 'Volume profile since ' + fromText + ' ET: ChartBridge started after ' + from + ' ET' + (/^none \(not in profileRoots/.test(T.backfill) ? ' and this instrument is not in its profileRoots.' : ' and could not load the session' + (T.backfill ? ' (' + T.backfill + ').' : '.'));
      }
      else if (partial) {                              // the session held is only partly in the tick history
        text = D.tickHours > 0 ? 'Volume profile from ' + fromText + ' ET: the tick history does not reach back to ' + from + ' ET.'
          : 'Volume profile from ' + fromText + ' ET: this view loads no tick history, so it counts the live trades from then on.';
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
    const va = D.vp.valueArea(), dp = precisionOf(), day = D.vp.day * 86400;
    $('lgPoc').textContent = U.fmtPrice(D.vp.poc().price, dp); $('lgVal').textContent = U.fmtPrice(va.val, dp); $('lgVah').textContent = U.fmtPrice(va.vah, dp);
    // the session's trading day, "(Fri)", and "(Fri from 16:00)" when the ticks start after the session did (review B1)
    const cover = vpCover();
    $('lgVpDay').textContent = ' (' + U.fmtDay(day).split(' ')[0] + (cover.partial ? ' from ' + cover.fromText : '') + ')';
    el.title = 'Volume profile of ' + U.fmtDate(day) + ', ' + (D.vp.rth ? 'RTH 9:30 to 16:00 ET' : 'full session from 18:00 ET the day before') +
      ': point of control and 70% value area. Kept after the session ends until the next session\'s first trade.';
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
    if (D.m1.last) lastSeen[D.root] = D.m1.last.c;
    rebuild();
    vpBuild();
    setConn('live');
    $('notice').hidden = true;
  }

  function onTick(m) {
    if (m.root === D.root) lastSeen[m.root] = m.p;       // the last price, also while a view loads (click-to-place, review N4)
    if (m.root !== D.root || !D.ready) return;
    const t = m.t, p = m.p, v = m.v || 0;
    D.ticks.push(t, p, v);                             // columns, not one array per trade (TickStore, bar-builder.js)
    if (D.vp) D.vp.add(t, p, v);                       // the volume profile holds what the store holds (vpBuild)
    // Over 2.5 million trades the trades of earlier sessions go (the first session left is partial now); the current
    // session's never do, so range bars built from the store stay all day (1.8.0; BB.trimCount).
    const drop = D.ticks.length > TRIM_CAP ? BB.trimCount(D.ticks, etNow(), SESSION, TRIM_CAP, TRIM_HARD, 500000) : 0;
    if (drop > 0) {
      D.ticks.dropFirst(drop); D.tickFrom = D.ticks.time(0) + 0.001; D.trimmed = true;
      if (D.table) D.table.at = Math.max(0, D.table.at - drop);
    }
    ticksSeen++;
    const r1 = D.m1.add(t, p, v);
    const tf = TF[S.tf];
    if (tf.mode === 'time' && tf.sec >= 60) chart.update(tf.sec === 60 ? r1.bar : U.foldLast(D.m1.bars, tf.sec));
    else if (D.cur) {
      const n0 = D.cur.bars.length, ch = D.cur.add(t, p, v).changed;
      if (D.sync && D.sync.bar < 0) { if (D.sync.rs.step(t, p)) { D.sync.bar = n0; showRange(); } }   // the first proven range bar
      else for (let i = 0; i < ch.length; i++) chart.update(ch[i]);   // a finished range bar, phantom bars, the new bar
    }
    const now = nowMs();
    pushDelay(delays.feed, m.rx - m.u);
    pushDelay(delays.local, now - m.rx);
    if (r1.isNew && U.tradeDay(t, SESSION) !== D.day) updateLevels();
    else if (D.ib && t >= D.ib.start && t < D.ib.end && (D.ib.high === null || p > D.ib.high || p < D.ib.low)) updateIB(false);
  }

  const TRIM_CAP = 2500000, TRIM_HARD = 8000000;       // trades; 8 million is some 190 MB, far above a busy session
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
      const t = tradeMode() ? 'Orders go to this account, and the chart marks its fills' : 'Trading is off: this picks whose fills the chart marks, and the account orders go to when trading comes back on';
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
    if (TRADING) { saveTabAccount(v); if (TR.v2) clearAccountNote(); }   // the note named the account before (review S2)
    syncAccounts();
    for (const peer of accountPeers) if (peer.prefix === PREFIX && peer.follow !== followAccount) peer.follow(v);
  }
  /* Another chart with this prefix (on this page, or in another tab) picked an account: show the same. Never on the
     trading page (1.6.1): there it is the account this tab trades, and each tab keeps its own while open. */
  function followAccount(v) {
    if (TRADING || typeof v !== 'string' || v === viewAccount || destroyed) return;
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
  /* ChartBridge 0.3.5 lists "liveFirst" and "profile" in hello's `features`. Only then does the page send its subscribe id,
     ask for the served window on seconds and range views, and ask for the session table ("profile"); ChartBridge 0.3.4 and
     older, and The Desk's relay (which passes no `features`), get the subscribe of 1.6.0. */
  let LIVE_FIRST = false, PROFILE = false, subSeq = 0;
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
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); if (ORDER_ACTIONS.includes(obj.type)) actionSent(); }
  }
  const ORDER_ACTIONS = ['order', 'change', 'cancel', 'flatten'];   // what ChartBridge counts, 10 a second at most
  function subscribe(root) {
    resetData(root);
    setConn('loading');
    D.tickHours = ticksWanted();
    D.tickFrom = D.tickHours > 0 ? etNow() - D.tickHours * 3600 : Infinity;
    const msg = { type: 'subscribe', root, days: 5, tickHours: D.tickHours };
    D.sub = LIVE_FIRST || PROFILE ? ++subSeq : 0;
    if (D.sub) msg.sub = D.sub;
    if (LIVE_FIRST && D.tickHours > 0) { msg.liveFirst = true; D.window = true; }
    if (PROFILE) msg.profile = true;
    send(msg);
  }
  /* A message of an older subscribe of this page (ChartBridge 0.3.5 echoes the page's id; one already on its way when the
     page subscribed again can still arrive). Only checked when the page sent an id. */
  const stale = m => D.sub > 0 && m.sub !== undefined && m.sub !== null && +m.sub !== D.sub;

  function handle(m) {
    switch (m.type) {
      case 'hello':
        helloSeen = true;
        LIVE_FIRST = Array.isArray(m.features) && m.features.includes('liveFirst');
        PROFILE = Array.isArray(m.features) && m.features.includes('profile');
        instruments = {};
        for (const i of m.instruments || []) instruments[i.root] = i;
        $('lgSrc').textContent = 'NinjaTrader via ChartBridge ' + (m.version ? m.version + ' ' : '') + '· chart ' + CE.VERSION;
        syncAccounts(m.accounts || []);
        subscribe(S.root);
        if (m.trading && TRADING) { applyTrading(m.trading); signIn(); }   // protocol v2; ChartBridge 0.2 has no trading field
        break;
      case 'history':
        if (m.root !== D.root || stale(m)) return;
        if (m.name) { D.name = m.name; $('lgName').textContent = m.name; }
        for (const b of m.bars) D.hist.push({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] });
        setStatus('Loading ' + D.root + ' history: ' + D.hist.length.toLocaleString() + ' minutes', '');
        break;
      case 'ticks':
        if (m.root !== D.root || stale(m)) return;
        D.ticks.pushAll(m.ticks);
        setStatus('Loading ' + D.root + ' ticks: ' + D.ticks.length.toLocaleString(), '');
        break;
      case 'ready':
        if (m.root !== D.root || stale(m)) return;
        setStatus('', '');
        onReady();
        break;
      case 'profile':
        // with this load's id before its "ready"; without one when the table's backfill made it whole (only once live)
        if (m.root !== D.root || (m.sub !== undefined && m.sub !== null ? stale(m) : !D.ready)) return;
        onProfile(m);
        break;
      case 'tick': onTick(m); break;
      case 'execs': for (const f of m.list || []) addFill(f); syncAccounts(); applyMarkers(); break;
      case 'exec': addFill(m); applyMarkers(); break;
      case 'status': if (m.level === 'error') alertLoud(m.text); else setStatus(m.text, m.level); break;
    }
    if (TRADING) switch (m.type) {
      case 'trading': applyTrading(m); if (!TR.signInStarted) signIn(); break;
      case 'orders': TR.orders.clear(); for (const o of m.list || []) if (served(o.root)) TR.orders.set(o.id, o); unsentCheck(); renderTrading(); break;
      case 'order': onOrder(m); break;
      case 'position': TR.positions.set(m.account + '|' + m.root, { qty: +m.qty || 0, avgPrice: +m.avgPrice || 0 }); renderTrading(); applyMarkers(); break;
      case 'reject': if (!onRefused(m)) flash('Refused by ChartBridge: ' + m.reason, 'error'); renderTrading(); break;
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
    // a Cancel all under way stops for what ChartBridge would refuse: all of it while trading is off, and the orders of
    // an account no longer on its list (review 2 S1; they cannot be cancelled from the page then)
    if (!TR.enabled) batchStop(() => true, 'trading went off (' + TR.reason.replace(/\.$/, '') + ')');
    else batchStop(e => !TR.accounts.includes(e.account), 'the account is no longer a trade account in ChartBridge');
    const was = TR.account, cameOn = TR.enabled && !was;           // trading comes on: a load, a PIN entry, a reconnect
    const pick = LP.orderAccount(TR.accounts, TR.enabled ? viewAccount : '');
    TR.account = TR.enabled ? pick.account : '';                   // no order account while trading is off
    if (cameOn || !TR.enabled || TR.account !== was) setArmed(false);   // Armed always starts off; never restored
    renderTrading();
    syncAccounts();
    if (TR.enabled && TR.account && (cameOn || pick.missed)) accountNote(pick, cameOn);
  }
  /* Trading came on, or the account in use is no longer allowed: say which account orders go to and make the picker
     stand out for a moment (1.6.1, Anthony trades account to account). The picker already shows it (syncAccounts). */
  let sessionsOn = 0, noteSeq = 0, lastOrderAccount = '';
  function accountNote(pick, cameOn) {
    const sel = $('oAcct'), el = $('oAcctNote'), seq = ++noteSeq;
    const first = cameOn && ++sessionsOn === 1;
    // the account before: what the load started on, or the order account before trading went off (review N3)
    const before = first ? restored.account : lastOrderAccount;
    const text = pick.missed ? 'Last account ' + pick.missed + ' not available, on ' + pick.account + '.'
      : before && pick.account !== before ? 'On ' + pick.account + ' (picked while trading was off). Armed is off.'
      : !first ? 'Still on ' + pick.account + '. Armed is off.'
      : 'On ' + pick.account + (!before ? '' : restored.from === 'tab' ? tabWording() : ', the last account picked') + '. Armed is off.';
    el.textContent = text; el.title = text; el.classList.toggle('warn', !!pick.missed);
    sel.classList.remove('acct-flash', 'warn'); void sel.offsetWidth;   // restart the highlight
    sel.classList.add('acct-flash'); sel.classList.toggle('warn', !!pick.missed);
    later(() => { if (seq === noteSeq) sel.classList.remove('acct-flash', 'warn'); }, 3600);
    later(() => { if (seq === noteSeq) { el.textContent = ''; el.title = ''; } }, pick.missed ? 15000 : 8000);
  }
  /* Where the tab's account came from (review 2 N3): a reload of this tab, a copy opened from another tab (window.open
     copies sessionStorage), or another way of reaching the page in this tab's session (a duplicated tab, typing the
     address again). */
  function tabWording() {
    let nav = '';
    try { const e = performance.getEntriesByType('navigation')[0]; nav = e ? e.type : ''; } catch (e) { /* not supported */ }
    if (nav === 'reload') return ', the account this tab was on';
    let opened = false;
    try { opened = !!window.opener; } catch (e) { opened = true; }
    return opened ? ', the account of the tab that opened this one' : ', the account this tab\'s session was on';
  }
  function clearAccountNote() { noteSeq++; $('oAcctNote').textContent = ''; $('oAcctNote').title = ''; $('oAcct').classList.remove('acct-flash', 'warn'); }
  function tradingLost(reason) {
    TR.signInStarted = false;
    if (!TR.v2) return;
    batchStop(() => true, 'the connection to ChartBridge dropped');   // before the orders are cleared: count what was still working
    TR.enabled = false; TR.reason = reason; TR.orders.clear(); TR.positions.clear();
    if (TR.account) lastOrderAccount = TR.account;
    TR.account = '';                                               // the tab's account stays in viewAccount (syncAccounts)
    clearAccountNote();                                            // it named an account and "Armed is off" (review S2)
    setArmed(false); renderTrading(); syncAccounts();
  }
  function onOrder(o) {
    if (!served(o.root)) return;
    const prev = TR.orders.get(o.id) || null;
    const ev = OT.orderEvent(o, prev, p => U.fmtPrice(p, precisionOf()));
    if (OT.isWorking(o)) TR.orders.set(o.id, o); else TR.orders.delete(o.id);
    if (ev) flash(ev.text, ev.level === 'error' ? 'error' : '');
    if (!OT.isWorking(o) && unsent.delete(o.id)) renderUnsent();
    renderTrading();
  }

  /* The last price: the chart's, or while a view loads the last one seen for the instrument (1.8.0: orders keep working). */
  const lastPrice = () => (D.m1 && D.m1.last ? D.m1.last.c : lastSeen[D.root] !== undefined ? lastSeen[D.root] : null);
  const capNow = () => OT.maxQtyFor(TR, D.root);
  const qtyNow = () => Number($('oQty').value === '' ? NaN : +$('oQty').value);

  /* Everything that sends an order action goes through here: trading enabled, Armed on, connected, data loaded. */
  function ready() {
    if (!TRADING) return false;
    if (FRAMED) { flash(FRAMED_REASON, 'error'); return false; }
    if (!TR.enabled) { flash(TR.reason || 'Trading is not enabled.', 'error'); return false; }
    if (!TR.armed) { flash('Armed is off: nothing was sent. Turn Armed on to trade.', 'warn'); return false; }
    if (!ws || ws.readyState !== 1) { flash('Not connected to ChartBridge: nothing was sent.', 'error'); return false; }
    if (!TR.account) { flash('No account yet: nothing was sent.', 'warn'); return false; }   // 1.8.0: never blocked by a view loading
    if ($('oAcct').value !== TR.account) { syncAccounts(); flash('Nothing was sent: the account shown was not the order account. The picker is back on ' + TR.account + '; click again to act on ' + TR.account + '.', 'error'); return false; }
    return true;
  }
  function sendOrder(side, kind, price) {
    if (!ready()) return;
    // a price order needs the last price to be a limit or a stop (OT.placeKind): until one is known, only market orders
    if (kind !== 'market' && !(lastPrice() > 0)) { flash('No price yet: nothing was sent. Market orders and Flatten work.', 'warn'); return; }
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

  /*
   * Cancel all (review 2 S1, S2, N1; review 3 S1, S4, N1): one cancel per order id (a bracket leg takes its pair), sent
   * while fewer than 6 order actions of any kind (orders, changes, cancels, Flatten) went out in the last 1.1 s:
   * ChartBridge refuses more than 10 a second, and this leaves Anthony 4 for his own clicks (Flatten above all). The
   * ids are the working orders of the account and instrument shown at Anthony's click, after ready(). From then on
   * the rest go out by id whatever Armed, the picker or the instrument show: Anthony asked for those cancels, a cancel
   * only takes an order away, and each goes to that order's own account. Nothing is locked while they go out: Armed,
   * the picker, the instrument and Flatten all work. Each click is its own queue and the newest click goes first, so a
   * Cancel all on the account shown never waits behind an earlier one on another account (review 3 S1). The state
   * row says "Cancelling on EVAL-1 MNQ: 12 left" until the last one is sent, in the warning color while that account
   * or instrument is not the one shown. Each send skips an id that is no longer working (filled, cancelled, or taken
   * by Flatten). A Cancel all adds only the ids not queued and not cancelled in the last 5 s (a second click sends
   * nothing new); a cancel ChartBridge refused can be sent again at once (review 3 N1). It stops only for what
   * ChartBridge would refuse: the connection drops, trading goes off, or the account leaves ChartBridge's list. Then a
   * note that stays until Anthony dismisses it, or until those orders are no longer working, names the account, the
   * instrument and how many cancels were not sent.
   */
  const CANCEL_CHUNK = 6, CANCEL_GAP = 1100, CANCEL_AGAIN = 5000;
  let batch = null;                                                // { groups: [{ account, root, queue: [id] }] (oldest click first), timer }
  const unsent = new Map();                                        // id -> { account, root, why }: for the note
  let flattenMiss = '';                                            // a refused Flatten that was not sent again: for the note
  const actionTimes = [];                                          // when the last order actions went out (any kind)
  function actionSent() { actionTimes.push(performance.now()); if (actionTimes.length > 64) actionTimes.shift(); }
  const cancelSent = new Map();                                    // id -> when its cancel went out (a second click sends it again only after 5 s)
  const inCancelAll = id => batchItems().some(e => e.id === id) || (cancelSent.has(id) && performance.now() - cancelSent.get(id) < CANCEL_AGAIN);
  const batchItems = () => batch ? batch.groups.flatMap(g => g.queue.map(id => ({ id, account: g.account, root: g.root }))) : [];
  function cancelAll() {
    if (!ready()) return;
    const account = TR.account, root = D.root, pos = TR.positions.get(account + '|' + root), now = performance.now();
    const ids = OT.cancelAllIds([...TR.orders.values()], account, root, pos ? pos.qty : 0);
    const keptNote = ids.kept ? ' Kept ' + ids.kept + ' order' + (ids.kept > 1 ? 's' : '') + ' protecting the open position (cancel those one by one, or Flatten).' : '';
    if (!ids.length) { flash('Nothing to cancel on ' + account + ' ' + root + '.' + keptNote, ''); return; }
    for (const [id, t] of cancelSent) if (t < now - CANCEL_AGAIN) cancelSent.delete(id);
    const queued = new Set(batchItems().map(e => e.id));
    const fresh = ids.filter(id => !queued.has(id) && !cancelSent.has(id));
    const left = ids.filter(id => queued.has(id)).length;
    if (!fresh.length) { flash((left ? 'Still cancelling on ' + account + ' ' + root + ': ' + left + ' left.' : 'Those cancels went out a moment ago.') + ' Nothing new to send.' + keptNote, 'warn'); return; }
    const running = !!batch;
    if (!batch) batch = { groups: [], timer: false };
    batch.groups.push({ account, root, queue: fresh });            // the newest click goes first (cancelPump)
    flash((running ? 'Added ' + fresh.length + ' to the cancels under way, first in line, on ' : 'Cancelling ' + fresh.length + ' order' + (fresh.length > 1 ? 's' : '') + ' on ') + account + ' ' + root + '.' + keptNote, '');
    cancelPump();                                                  // as many as the pace allows now, the rest in turn
  }
  function cancelPump() {
    const b = batch;
    if (!b) return;
    const now = performance.now();
    while (actionTimes.length && actionTimes[0] <= now - CANCEL_GAP) actionTimes.shift();
    for (;;) {
      while (b.groups.length && !b.groups[b.groups.length - 1].queue.length) b.groups.pop();
      if (!b.groups.length || actionTimes.length >= CANCEL_CHUNK) break;
      if (!ws || ws.readyState !== 1 || !TR.enabled) { batchStop(() => true, 'the connection to ChartBridge dropped'); return; }
      const id = b.groups[b.groups.length - 1].queue.shift();      // the newest click's first
      if (!TR.orders.has(id)) continue;                            // no longer working: nothing to send
      send({ type: 'cancel', id });                                // counted in actionTimes by send
      cancelSent.set(id, now);
    }
    if (!b.groups.length) batch = null;
    else if (!b.timer) { b.timer = true; later(() => { b.timer = false; if (batch === b) cancelPump(); }, Math.max(20, actionTimes[0] + CANCEL_GAP - now)); }
    renderBatch();
  }
  /* Take cancels out of the batch. With `why`, those still working go to the note (not sent); without it (Flatten,
     the x) they are taken care of another way. */
  function batchStop(match, why) {
    if (!batch) return;
    let out = 0;
    for (const g of batch.groups) {
      const keep = [];
      for (const id of g.queue) {
        const e = { id, account: g.account, root: g.root };
        if (!match(e)) { keep.push(id); continue; }
        out++;
        if (why && TR.orders.has(id)) unsent.set(id, { account: g.account, root: g.root, why });
      }
      g.queue = keep;
    }
    if (!out) return;
    if (why) renderUnsent();
    batch.groups = batch.groups.filter(g => g.queue.length);
    if (!batch.groups.length) batch = null;
    renderBatch();
  }
  const countBy = (list, key) => { const g = new Map(); for (const e of list) { const k = key(e); g.set(k, (g.get(k) || 0) + 1); } return g; };
  /* The batch line in the state row: in the warning color while cancels go out for an account or instrument that is
     not the one shown (review 3 S2). */
  function renderBatch() {
    const el = $('oCancel'), items = batchItems(), g = countBy(items.slice().reverse(), e => e.account + ' ' + e.root);
    const text = g.size ? 'Cancelling on ' + [...g].map(([k, n]) => k + ': ' + n + ' left').join(', ') + ' (6 a second).' : '';
    if (el.textContent !== text) { el.textContent = text; el.title = text; }
    el.classList.toggle('away', items.some(e => e.account !== TR.account || e.root !== D.root));
  }
  /* The note for cancels (or a Flatten) that were not sent: it stays until dismissed, or until those orders are no
     longer working. */
  function renderUnsent() {
    const g = countBy(unsent.values(), e => e.account + ' ' + e.root + '|' + e.why);
    $('unsentBar').hidden = !g.size && !flattenMiss;
    $('unsentText').textContent = [flattenMiss].concat(!g.size ? [] : [...g].map(([k, n]) => {
      const [where, why] = k.split('|');
      return n + ' cancel' + (n > 1 ? 's' : '') + ' on ' + where + (n > 1 ? ' were' : ' was') + ' not sent: ' + why + '.';
    }).concat('Those orders may still be working. Check them, then Cancel all again on that account and instrument (or in NinjaTrader).')).filter(Boolean).join('\n');
  }
  /* After a full orders list: an unsent cancel whose order is no longer working needs no note. The orders of an account
     ChartBridge no longer allows are not in that list, so those stay. */
  function unsentCheck() {
    let changed = false;
    for (const [id, e] of unsent) if (TR.accounts.includes(e.account) && !TR.orders.has(id)) { unsent.delete(id); changed = true; }
    if (changed) renderUnsent();
  }
  /*
   * Flatten is never blocked (review 3 S4). It goes out at once, and takes its account and instrument off a Cancel all
   * under way (ChartBridge's Flatten cancels those itself, so no "No working order" follows). If ChartBridge refuses it
   * for the rate (more than 10 order actions a second), it is sent once more 1.1 s later, while the same account and
   * instrument are still shown and trading is on; otherwise the note says it was not sent. A second Flatten finds the
   * account flat, so sending it twice is harmless.
   */
  const RATE_REFUSAL = /order actions/i;
  let lastFlatten = null;                                          // { account, root, at, again }
  function sendFlatten(account, root, again) {
    send({ type: 'flatten', account, root });
    batchStop(e => e.account === account && e.root === root);
    lastFlatten = { account, root, at: performance.now(), again: !!again };
  }
  /* A refusal from ChartBridge. Returns true when handled here (a Flatten or a Cancel all's cancel sent again), else the
     page shows it. */
  const requeued = new Set();                                      // batch cancels already sent again once after a rate refusal
  function onRefused(m) {
    const wasBatch = typeof m.id === 'string' && cancelSent.has(m.id);
    if (typeof m.id === 'string') cancelSent.delete(m.id);         // a refused cancel can go again at once (review 3 N1)
    /* A Cancel all's cancel refused for the rate (the page keeps 6 in 1.1 s, but a busy PC can deliver two of its
       seconds close together): it goes again once, first in line, at the pace. */
    const o = wasBatch && TR.orders.get(m.id);
    if (o && RATE_REFUSAL.test(m.reason || '') && !requeued.has(m.id)) {
      requeued.add(m.id);
      if (!batch) batch = { groups: [], timer: false };
      batch.groups.push({ account: o.account, root: o.root, queue: [m.id] });
      flash('ChartBridge refused a cancel for the rate (more than 10 order actions a second): it goes again in turn.', 'warn');
      cancelPump();
      return true;
    }
    const f = lastFlatten;
    if (m.id || m.cid || !f || f.again || !RATE_REFUSAL.test(m.reason || '') || performance.now() - f.at > 3000) return false;
    lastFlatten = null;
    const where = f.account + ' ' + f.root;
    flash('ChartBridge refused Flatten for ' + where + ' (more than 10 order actions a second): sending it again in 1 s.', 'warn');
    later(() => {
      if (ws && ws.readyState === 1 && TR.enabled && TR.account === f.account && D.root === f.root) {
        sendFlatten(f.account, f.root, true);
        flash('Flatten sent again for ' + where + '.', 'warn');
      } else {
        flattenMiss = 'Flatten for ' + where + ' was refused by ChartBridge (more than 10 order actions a second) and not sent again: ' +
          (!ws || ws.readyState !== 1 || !TR.enabled ? 'trading went off.' : 'the account or instrument shown changed.') + ' The position may still be open. Flatten again.';
        renderUnsent();
      }
    }, CANCEL_GAP);
    return true;
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
    chart.setOrderEditing(v);
    renderTrading();
  }
  function syncTradeAccounts() {
    const sel = $('oAcct');
    sel.replaceChildren(...TR.accounts.map(a => new Option(a, a)));
    sel.value = TR.account;
    sel.disabled = !TR.accounts.length;                            // enabled again after a trading-off spell with no accounts (review 2, S1); never locked by a Cancel all (review 2 S1)
  }
  /* Order bar, order lines, position line; also run on every instrument switch and order message. */
  function renderTrading() {
    if (!TRADING || !TR.v2) return;
    const bar = $('obar'); bar.hidden = false;
    const on = TR.enabled, root = D.root || S.root, cap = OT.maxQtyFor(TR, root);
    for (const el of bar.querySelectorAll('button, input, select')) if (el !== $('oAcct')) el.disabled = !on;   // the account picker works with trading off too (it drives the fills); nothing is locked by a Cancel all (review 2 S1)
    // the tab title and the ARMED pill name the account (review S5): two tabs on two accounts are by design now
    if (PAGE) document.title = on && TR.account ? (TR.armed ? 'ARMED · ' : '') + root + ' · ' + TR.account + (TR.armed ? '' : ' · Live Chart') : 'Live Chart';
    $('armPill').textContent = 'ARMED' + (TR.account ? ' · ' + TR.account : '');
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
    renderBatch();                                                 // its color follows the account and instrument shown
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
    /* Other accounts on this instrument, by name (review S3): a live trade on another account is never only a count.
       In the warning color while one has a position; on one line (cut short, the whole text in its tooltip). */
    const others = new Map(), of = a => others.get(a) || others.set(a, { pos: 0, n: 0 }).get(a);
    for (const [k, v] of TR.positions) { const a = k.slice(0, k.lastIndexOf('|')); if (v.qty && k.endsWith('|' + root) && a !== TR.account) of(a).pos = v.qty; }
    for (const o of TR.orders.values()) if (o.root === root && o.account !== TR.account && OT.isWorking(o)) of(o.account).n++;
    const parts = [...others].map(([a, x]) => a + ': ' + [x.pos ? (x.pos > 0 ? 'LONG ' : 'SHORT ') + Math.abs(x.pos) : '', x.n ? x.n + ' order' + (x.n > 1 ? 's' : '') : ''].filter(Boolean).join(', '));
    other.textContent = parts.length ? 'Other accounts on ' + root + ': ' + parts.join(' · ') : '';
    other.title = other.textContent;
    other.classList.toggle('live', [...others.values()].some(x => x.pos));
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
    $('lgVw').textContent = b.vw !== undefined && b.vw !== null ? fmt(U.roundTo(b.vw, D.tick)) : '-';   // null: not known yet (served window)
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
  const OPTION_TEXT = { vp: { session: { label: 'Hours', values: { full: ['Session', 'Every trade from 18:00 ET'], rth: ['RTH', '9:30 to 16:00 ET (13:00 on NYSE early closes)'] } } } };
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
      html += '<div class="ind-coming">Coming: cumulative delta, time and sales</div>';
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
      if (TR.armed) clearAccountNote();                            // it said "Armed is off" (review S2)
      flash(TR.armed ? 'Armed: one click places an order on ' + TR.account + ', with no confirmation.' : 'Armed off.', TR.armed ? 'warn' : '');
    });
    $('oAcct').addEventListener('change', e => {
      if (!tradeMode()) { pickViewAccount(e.target.value); return; }   // trading off: it only picks whose fills are marked
      TR.account = e.target.value;
      clearAccountNote();
      if (TR.armed) { setArmed(false); flash('Armed turned off: the account changed.', 'warn'); }
      renderTrading();
      viewAccount = TR.account; store.set('live-account-v1', TR.account); saveTabAccount(TR.account);
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
      sendFlatten(TR.account, D.root);                             // takes its orders off a Cancel all; sent again once if refused for the rate
      flash('Flatten sent for ' + TR.account + ' ' + D.root + ': cancel its orders, close the position at market.', '');
    }));
    $('cancelAllBtn').addEventListener('click', pointerOnly(cancelAll));
    $('unsentClose').addEventListener('click', () => { unsent.clear(); flattenMiss = ''; renderUnsent(); });

    /* chart: drag an order label to move it, x to cancel, Shift+click to place (all only while Armed) */
    chart.setOrderPreview(previewAt);
    chart.on('orderPlace', e => sendOrder(TR.side, OT.placeKind(TR.side, e.price, lastPrice()), e.price));
    const notShown = id => { const o = TR.orders.get(id); if (o && o.account === TR.account) return false; flash(o ? 'Not sent: that order is not on ' + TR.account + '.' : 'Not sent: that order is no longer working.', o ? 'error' : 'warn'); renderTrading(); return true; };
    chart.on('orderMove', e => {
      if (!ready()) { renderTrading(); return; }
      if (notShown(e.id)) return;
      /* An order in a Cancel all under way (queued, or its cancel just sent) is not moved: Cancel all wins and cancels
         it (Anthony 2026-09-30), and no change goes out that could cross its cancel. The line goes back. */
      if (inCancelAll(e.id)) { renderTrading(); flash('Not moved: order ' + e.id + ' is in the Cancel all under way, which cancels it.', 'warn'); return; }
      send({ type: 'change', id: e.id, price: e.price });
      flash('Moving order ' + e.id + ' to ' + U.fmtPrice(e.price, precisionOf()), '');
    });
    chart.on('orderCancel', e => {
      if (!ready()) return;
      if (notShown(e.id)) return;
      send({ type: 'cancel', id: e.id });
      batchStop(x => x.id === e.id);                               // sent now, not again with a Cancel all under way
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
    // the clock crossing 9:30, 10:30 or 18:00, with or without trades; also while offline, when minutes missing
    // since the drop hide the IB (a 'gap') rather than leave a stale one up
    if (D.m1) updateIB(false);
    // the full-session profile moves to the new session at 18:00 ET on the clock on weekday evenings; over a weekend
    // or a holiday it keeps the last session until the next session's first trade, and RTH never moves on the clock
    // (1.6.1, the engine's keep)
    if (D.vp && D.vp.advance(etNow())) vpLegend();
    vpNote(); vpLegend(); rangeNote();
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
    if (PAGE && window.liveChart === chart) { delete window.liveChart; delete window.liveData; }
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
