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
 *   live-settings-v2    { root, tf, glide, rangeMode, grid, room } (grid 'off' | 'on' and room, the px right of the last
 *                       bar (0, 40, 80, 160), 1.14.0)
 *   live-range-v2       { NQ: 40, ... } range bar size in ticks, per instrument root; only roots set by hand
 *   live-indicators-v2  { <paneId>: { ind: { <id>: { on, shown, pin } }, recent: [ids], restore: [ids] | null } }
 *                       the Indicators menu per chart pane (1.6.0): on = on this chart, shown = drawn (hidden keeps it on
 *                       the chart), pin = a chip on the pane's strip; the last 5 used; what Hide all hid, for Restore
 *   live-indicator-options-v1  { <paneId>: { vp: { session: 'full' | 'rth' }, delta: { show: 'cum' | 'bar' } } } an
 *                       indicator's own options, per pane (INDICATOR_OPTIONS, 1.6.0; the volume profile's hours, and
 *                       since 1.7.0 what the delta pane shows)
 *   live-pane-heights-v1  { <paneId>: { delta: 0.2 } } the delta pane's share of the chart height, per pane (1.7.0)
 *   live-bracket-v1     { MNQ: { stop, target }, ... } (format unchanged since 1.3.0)
 *   live-bracket-presets-v1  [{ name, stop, target }] the saved bracket presets (1.10.0), ticks, at most 12; cleaned on
 *                       read by OrderTicket.cleanBracketPresets
 *   live-bracket-sel-v1 { MNQ: 'custom' | '1:1' | '1:1.5' | '1:2' | 'p:<preset name>', ... } the preset picked per root
 *   live-bracket-unit-v1  't' | 'pt' the bracket boxes in ticks or points (1.10.0; stored in ticks always)
 *   live-qty-v1         { MNQ: 2, ... } the qty picked last per root, 1 to 9 (1.10.0)
 *   live-hotkeys-v1     { buy, sell, be, close, flattenAll } the trading hotkeys set in Settings (1.11.0), each a combo
 *                       such as "Alt+B" or ''; none by default; cleaned on read by OrderTicket.cleanHotkeys
 *   live-indicator-colors-v1  { vwap, prior, overnight, value, close, ibHigh, ibLow, vpPoc } the indicators' colors as set
 *                       in their gears (1.9.0); only colors set by hand. The VWAP color the Colors panel kept in
 *                       live-colors-v1 up to 1.8 is copied in once, on page start, when this key has no VWAP.
 *   live-signals-v1     { abs: { <root>: { <chart type>: { LookbackPeriod, VolumeMultiplier, RejectionZone,
 *                       AggregationWindowMs } } }, div: { SwingLookback, MinBarsBetweenSwings, MinDivergencePct },
 *                       auto: { <root>: true } } the chart signals' settings (G1c): absorption per instrument and chart type
 *                       ('range:40', 'm1', ...; the same defaults for every one), the divergence's, and the bubbles' Auto
 *                       floor per instrument; only what was set by hand
 *   live-tape-floors-v1 { <root>: { rth, eth } } the large-print floors (the workspace's Time and Sales floors, 1.12.0), also
 *                       the bubbles' and the absorption bars' large trade (G1c); only those set by hand
 *   live-legend-v1      { <paneId>: false } a chart's header text switched off (1.14.0, Anthony); on unless set off
 *   live-color-presets-v1  { chart: [{ id, name, colors: { up, down, bg }, ind }], indicator: [{ id, name, colors }] }
 *                       the named presets (1.9.0), through presetStore below so a store shared by every PC can replace
 *                       it; a chart preset's optional `ind` is the id of the indicator preset it brings with it
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
/* 1.14.0 (Anthony): grid lines off by default; the room right of the last bar in CSS px (the same on screen at every zoom) */
const GRIDS = ['off', 'on'];
const ROOMS = [0, 40, 80, 160];
const DEFAULT_ROOM = 80;
const DEFAULT_RANGE = { MNQ: 20, NQ: 20, MES: 8, ES: 8 };
const RANGE_MIN = 1, RANGE_MAX = 400;
/*
 * The indicators (1.6.0 menu). `id` is also the chart layer (fills: the fill marks). Listed in the order the menu's
 * "On this chart" group and the chip strip show them. `sw` is the CSS color of the swatch; `short` is the chip text and
 * `letter` the chip on a narrow pane; `alias` holds the short names search matches; `opt` is the read-only setting the
 * gear shows (only what the chart really does; the account whose fills are marked is the one account picker's).
 */
const INDICATORS = [
  { id: 'volume', name: 'Volume bars', code: 'VO', short: 'VOL', letter: 'V', cat: 'volume', sw: 'var(--text3)', alias: 'vol volume bars',
    opt: 'Bottom 16% of the plot, in the candle colors' },
  { id: 'vwap', name: 'VWAP', code: 'VW', short: 'VWAP', letter: 'W', cat: 'price', sw: 'var(--vwap-sw)', alias: 'vwap',
    opt: 'Volume weighted average price: the full session from 18:00 ET, or RTH only from 09:30 ET' },
  /* 1.14.0 (Anthony): the Initial Balance is part of Levels (its own indicator and chip retired), and every level line
     has its own switch in the gear (live-indicator-options-v1 `levels`) */
  { id: 'levels', name: 'Levels', code: 'LV', short: 'LEVELS', letter: 'L', cat: 'price', sw: 'var(--info)',
    alias: 'levels pdh pdl onh onl prior day high low close pc overnight vah val poc value area ib ibh ibl initial balance 1h',
    opt: 'The prior session\'s high, low and close, its value area high, low and point of control (PD VAH, PD VAL, PD POC), the overnight high and low, and today\'s 1 hour Initial Balance (locks 10:30 ET)' },
  { id: 'vp', name: 'Volume profile', code: 'VP', short: 'PROFILE', letter: 'P', cat: 'volume', sw: 'var(--vp-sw)',
    alias: 'vp volume profile poc vah val value area',
    opt: 'Traded volume per price at the right edge: 1-tick rows, the point of control and the 70% value area' },
  { id: 'delta', name: 'Cumulative delta', code: 'CD', short: 'DELTA', letter: 'D', cat: 'volume', sw: 'var(--delta-sw)',
    alias: 'delta cd cvd cumulative order flow divergence',
    opt: 'Market buys minus market sells from 18:00 ET, in a pane below the chart; each trade\'s side comes from ChartBridge 0.3.4. Drag the line above the pane (or focus it and use the arrow keys) to resize it.' },
  { id: 'bubbles', name: 'Large-order bubbles', code: 'BB', short: 'BUBBLES', letter: 'B', cat: 'volume', sw: 'var(--up-text)',
    alias: 'bubbles bb large orders prints big trades block',
    opt: 'Circles at large trades from the page\'s opening: same side prints within 100 ms added up, from the floor up, at the trade price on its bar. The area grows with the square root of the size; buys in the bull color, sells in the bear color.' },
  { id: 'fills', name: 'Fills', code: 'FL', short: 'FILLS', letter: 'F', cat: 'trades', sw: 'var(--profit)', alias: 'fills executions trades',
    opt: 'Past fills and trade marks of the account picked (side and size at the fill price). Hiding them never hides the open trade: its entry fills, the position line, working orders and stop and target lines stay.' },
  /* nochip (G1c, Anthony): no chip on the strip and never counted toward it */
  { id: 'absorption', name: 'Absorption bars', code: 'AB', short: 'ABSORB', letter: 'A', cat: 'signals', sw: 'var(--sig-bull)', nochip: true,
    alias: 'absorption absorb combo large trade spike rejection signals bars cyan yellow',
    opt: 'Anthony\'s AbsorptionTradeCombo, from the page\'s opening: a large trade, a volume spike and a rejection close on one bar. Bullish (a large buy, the close in the top of the bar) paints cyan, bearish (a large sell, the close in the bottom) yellow, at the close; an outline while the bar forms.' },
];
/* code: the 2-letter chip in a host's slim header (the workspace, E2a; Anthony approved VO VW LV IB VP CD FL). */
/* Listed in the menu, tagged "coming" and not selectable until they exist (none since the volume profile, 1.6.0, and
   the cumulative delta, 1.7.0). */
const COMING = [];
const CATEGORIES = [{ id: 'price', name: 'Price' }, { id: 'volume', name: 'Volume' }, { id: 'trades', name: 'Trades' }, { id: 'signals', name: 'Signals' }];
/* No chip, never counted toward the strip (the absorption bars, G1c). */
const NOCHIP = INDICATORS.filter(d => d.nochip).map(d => d.id);
const IND_IDS = INDICATORS.map(x => x.id);
const RECENT_MAX = 5;
/* The chip strip holds at most 6 pinned indicators (Anthony, 2026-09-29). Read through the exported object, so a
   smoke test can lower it. */
let api = null;
const pinMax = () => (api ? api.PIN_MAX : 10);
/* What the page showed before any choice was made (1.3), plus the 1-hour Initial Balance (1.5.3); the main pane
   starts here, each on the chart, shown and pinned to the chip strip. */
const DEFAULT_INDICATORS = { volume: true, vwap: true, levels: true, fills: true, vp: false, delta: true, bubbles: false, absorption: false };   // the profile: off on every pane; the delta pane (1.7.0): on for the main pane (Anthony)
/* A new pane (the grid, next step) starts with no indicators on; Anthony picks them per pane (2026-09-29). */
const NEW_PANE_INDICATORS = { volume: false, vwap: false, levels: false, fills: false, vp: false, delta: false, bubbles: false, absorption: false };
/* The main pane's own five up to 1.5.3, which a pane saved by 1.4 to 1.5.3 lists (paneFromV1); the IB is part of Levels
   since 1.14.0 (migrateIb). */
const V1_LISTED = ['volume', 'vwap', 'levels', 'fills'];
/* The level lines, each with its own switch in the Levels gear (1.14.0, Anthony), in the gear's order: the key, the
   engine's line key (levelLines, ibLines) and the gear's name. */
const LEVEL_LINES = [
  { k: 'pdh', name: 'PDH' }, { k: 'pdl', name: 'PDL' }, { k: 'pc', name: 'Prior close' }, { k: 'onh', name: 'ONH' }, { k: 'onl', name: 'ONL' },
  { k: 'vah', name: 'PD VAH' }, { k: 'val', name: 'PD VAL' }, { k: 'poc', name: 'PD POC' }, { k: 'ibh', name: 'IBH' }, { k: 'ibl', name: 'IBL' },
];
const ONOFF = ['on', 'off'];
/*
 * Options an indicator has besides on and off, each a list of allowed values with the default first (set in its gear
 * panel). The volume profile: the full session from 18:00 ET, or RTH 9:30 to 16:00 ET, 13:00 on NYSE early closes
 * (Anthony's ruling 2026-09-29). The delta pane (1.7.0): the running cumulative as candles ('cum'), or each bar's own
 * buys minus sells around zero ('bar') (Anthony's ruling 2026-09-30).
 */
const INDICATOR_OPTIONS = {
  vp: { session: ['full', 'rth'], dpoc: ONOFF, dvah: ONOFF, dval: ONOFF },          // 1.14.0: the developing POC, VAH and VAL lines
  delta: { show: ['cum', 'bar'], div: ['off', 'on'] },                             // div: the divergence arrows (G1c), off until switched on
  vwap: { session: ['full', 'rth'] },                                              // 1.14.0: from 18:00 ET, or RTH only from 09:30 ET
  levels: Object.fromEntries(LEVEL_LINES.map(L => [L.k, ONOFF])),                  // 1.14.0: each level line on or off
};
/* The delta pane's height (1.7.0), a share of the chart height, per pane: the default and the least and most kept,
   read from the engine (PANE_RATIO, PANE_RATIO_MIN, PANE_RATIO_MAX; review N8), which also keeps both panes at least a
   few rows tall. The engine loads before this file (live/EMBED.md); in Node it is required. */
const ENGINE = typeof self !== 'undefined' && self.ChartEngine ? self.ChartEngine : require('../src/chart-engine.js');
const PANE_HEIGHTS = { delta: { def: ENGINE.PANE_RATIO, min: ENGINE.PANE_RATIO_MIN, max: ENGINE.PANE_RATIO_MAX } };
/* On by default without a chip (review N5): the main pane's strip keeps the five chips of 1.6.0, so an indicator added
   (the volume profile) still gets the sixth; pinning the delta pane gives it one like any other. */
const UNPINNED_BY_DEFAULT = ['delta'];
const MAIN_PANE = 'main';

/*
 * The indicators' own colors (1.9.0, Anthony: indicator colors are their own preset group, "so I can set colors for
 * indicators on a white chart vs a dark chart"), each set in its indicator's gear. Defaults are the engine's house
 * colors. The volume bars and the delta pane keep the candle colors, and the fills the house trade-side green and red.
 */
const INDICATOR_COLORS = [
  { key: 'vwap', id: 'vwap', name: 'Line', def: ENGINE.DEFAULT_THEME.vwap },
  { key: 'prior', id: 'levels', name: 'Prior day high and low', def: ENGINE.LEVEL_COLORS.prior },
  { key: 'overnight', id: 'levels', name: 'Overnight high and low', def: ENGINE.LEVEL_COLORS.overnight },
  { key: 'value', id: 'levels', name: 'PD VAH, PD VAL and PD POC', def: ENGINE.LEVEL_COLORS.value },
  { key: 'close', id: 'levels', name: 'Prior close', def: ENGINE.LEVEL_COLORS.close },
  { key: 'ibHigh', id: 'levels', name: 'IB high', def: ENGINE.LEVEL_COLORS.ibHigh },
  { key: 'ibLow', id: 'levels', name: 'IB low', def: ENGINE.LEVEL_COLORS.ibLow },
  // 1.14.0 (Anthony): the profile's rows and value area too, brighter by default
  { key: 'vpRow', id: 'vp', name: 'Profile rows', def: ENGINE.DEFAULT_THEME.vpRow },
  { key: 'vpValue', id: 'vp', name: 'Value area rows', def: ENGINE.DEFAULT_THEME.vpValue },
  { key: 'vpPoc', id: 'vp', name: 'Point of control', def: ENGINE.DEFAULT_THEME.vpPoc },
  // the signals (G1c): the absorption bars' bodies and outlines; the divergence arrows use the same pair
  { key: 'sigBull', id: 'absorption', name: 'Bullish (cyan)', def: ENGINE.DEFAULT_THEME.sigBull },
  { key: 'sigBullLine', id: 'absorption', name: 'Bullish outline', def: ENGINE.DEFAULT_THEME.sigBullLine },
  { key: 'sigBear', id: 'absorption', name: 'Bearish (yellow)', def: ENGINE.DEFAULT_THEME.sigBear },
  { key: 'sigBearLine', id: 'absorption', name: 'Bearish outline', def: ENGINE.DEFAULT_THEME.sigBearLine },
];
/* Colors added after indicator presets were first saved (G1c): a preset saved before has none of them and takes the
   defaults, so no saved preset is lost. */
const IND_COLOR_LATER = ['sigBull', 'sigBullLine', 'sigBear', 'sigBearLine', 'vpRow', 'vpValue'];
const IND_COLOR_KEYS = INDICATOR_COLORS.map(c => c.key);
const HEX = /^#[0-9a-f]{6}$/i;
/** The allowed colors of `v` (#RRGGBB, upper case) for `keys`; the rest left out. */
function cleanColors(v, keys) {
  const out = {};
  if (v && typeof v === 'object') for (const k of keys) if (own(v, k) && typeof v[k] === 'string' && HEX.test(v[k])) out[k] = v[k].toUpperCase();
  return out;
}
/* The two preset groups: a chart preset is the bar colors and the chart background, an indicator preset every
   indicator color. */
const PRESET_GROUPS = { chart: ['up', 'down', 'bg'], indicator: IND_COLOR_KEYS };
const PRESET_MAX = 24, PRESET_NAME_MAX = 40;
/** A preset name as kept: trimmed, inner spaces as one, at most 40 characters; '' when nothing is left. */
function presetName(v) { return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, PRESET_NAME_MAX).trim() : ''; }

const KEYS = { settings: 'live-settings-v2', range: 'live-range-v2', indicators: 'live-indicators-v2', bracket: 'live-bracket-v1', indicatorOptions: 'live-indicator-options-v1',
  paneHeights: 'live-pane-heights-v1', indicatorColors: 'live-indicator-colors-v1', presets: 'live-color-presets-v1', colors: 'live-colors-v1',
  bracketPresets: 'live-bracket-presets-v1', bracketSel: 'live-bracket-sel-v1', bracketUnit: 'live-bracket-unit-v1', qty: 'live-qty-v1',
  hotkeys: 'live-hotkeys-v1', signals: 'live-signals-v1', floors: 'live-tape-floors-v1', legend: 'live-legend-v1' };
/*
 * The chart signals' settings (G1c), by the NinjaScript files' own names, each kept inside the file's [Range]:
 * AbsorptionTradeCombo per instrument and chart type (Anthony: Range 40 and 1 minute first, every other type the same
 * defaults), DeltaDivergenceSignal one set. Whole numbers where the file has an int.
 */
const ABS_SPEC = { LookbackPeriod: { min: 5, max: 200, int: true }, VolumeMultiplier: { min: 1, max: 10 }, RejectionZone: { min: 0.1, max: 0.5 },
  AggregationWindowMs: { min: 50, max: 5000, int: true } };
const DIV_SPEC = { SwingLookback: { min: 2, max: 15, int: true }, MinBarsBetweenSwings: { min: 2, max: 30, int: true }, MinDivergencePct: { min: 0.01, max: 0.5 } };
const FLOOR_MAX = 100000;
/** A setting's value as kept: a number inside its range (a whole one where it must be), else null. */
function cleanSpec(spec, v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !isFinite(n) || n < spec.min || n > spec.max || (spec.int && !Number.isInteger(n))) return null;
  return n;
}
/** The chart type the absorption settings are kept for: 'range:40' for Range 40, else the bars ('m1', 's15', ...). */
const chartType = (tf, range) => tf === 'range' ? 'range:' + range : String(tf);
const cleanFloor = v => { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return Number.isInteger(n) && n >= 1 && n <= FLOOR_MAX ? n : null; };
/** The large-print floors for every root (the workspace's Time and Sales ones): saved ones where valid, else the defaults. */
function cleanLargeFloors(v) {
  const out = {};
  for (const r of ROOTS) {
    const sv = own(v, r) ? v[r] : null, d = ENGINE.LARGE_FLOORS[r];
    const rth = own(sv, 'rth') ? cleanFloor(sv.rth) : null, eth = own(sv, 'eth') ? cleanFloor(sv.eth) : null;
    out[r] = { rth: rth !== null ? rth : d.rth, eth: eth !== null ? eth : d.eth };
  }
  return out;
}
const BRACKET_SELS = ['custom', '1:1', '1:1.5', '1:2'];
/** A bracket preset pick as kept: Custom, a ratio, or 'p:' and a saved preset's name (1 to 24 characters); else Custom. */
function cleanBracketSel(v) {
  if (BRACKET_SELS.includes(v)) return v;
  return typeof v === 'string' && /^p:\S/.test(v) && v.length <= 26 ? v : 'custom';
}
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
  for (const id of IND_IDS) { const on = main && DEFAULT_INDICATORS[id]; ind[id] = { on, shown: true, pin: on && !UNPINNED_BY_DEFAULT.includes(id) && !NOCHIP.includes(id) }; }
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
    if (NOCHIP.includes(id)) out.ind[id].pin = false;
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
  /* the 1.5.3 IB as it was, for migrateIb (1.14.0: part of Levels) */
  const ibFlag = v1 && typeof v1.ib === 'boolean' ? v1.ib : main;
  out.ind.ib = main ? { on: true, shown: ibFlag, pin: true } : { on: ibFlag, shown: true, pin: ibFlag };
  return out;
}
/*
 * 1.14.0 (Anthony): the Initial Balance is part of Levels (its own indicator and chip retired). A pane saved before keeps
 * what it showed: the IB on and shown means its two lines on in Levels (Levels off before: on now with only the IB lines,
 * pinned if either was); the IB off or hidden means its lines off. `rawPane` is the pane as saved, `levelOpts` its saved
 * level options. Returns { pane, levels } (the pane without `ib`, Recent and Restore naming Levels instead, and the level
 * options to save), or null when there is nothing to carry over.
 */
function migrateIb(rawPane, levelOpts) {
  if (!rawPane || typeof rawPane !== 'object' || isList(rawPane) || !rawPane.ind || typeof rawPane.ind !== 'object' || !own(rawPane.ind, 'ib')) return null;
  const ind = Object.assign({}, rawPane.ind), ib = ind.ib && typeof ind.ib === 'object' ? ind.ib : {};
  delete ind.ib;
  const ibShown = ib.on === true && ib.shown !== false;
  const lv = ind.levels && typeof ind.levels === 'object' ? ind.levels : null;
  const lvShown = !!lv && lv.on === true && lv.shown !== false;
  const levels = Object.assign({}, levelOpts && typeof levelOpts === 'object' && !isList(levelOpts) ? levelOpts : {});
  if (ibShown) {
    levels.ibh = 'on'; levels.ibl = 'on';
    if (!lvShown) {
      for (const L of LEVEL_LINES) if (L.k !== 'ibh' && L.k !== 'ibl') levels[L.k] = 'off';
      ind.levels = { on: true, shown: true, pin: !!(lv && lv.pin === true) || ib.pin === true };
    }
  } else { levels.ibh = 'off'; levels.ibl = 'off'; }
  const fix = list => (isList(list) ? list.map(x => (x === 'ib' ? 'levels' : x)).filter((x, i, a) => a.indexOf(x) === i) : list);
  return { pane: Object.assign({}, rawPane, { ind, recent: fix(rawPane.recent), restore: fix(rawPane.restore) }), levels };
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
  if (!x.on) { x.pin = !NOCHIP.includes(id) && pinnedCount(n) < pinMax(); x.on = true; }
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
    if (!IND_IDS.includes(id) || NOCHIP.includes(id)) return st;   // no chip for it, ever
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
    /* 1.14.0: the IB folded into Levels, once per pane saved before (migrateIb); the options first, so a write cut short
       is done again at the next start */
    const v2i = raw.get(KEYS.indicators);
    if (v2i && typeof v2i === 'object' && !isList(v2i)) {
      const allOpts = obj(KEYS.indicatorOptions);
      let moved = false;
      for (const paneId of Object.keys(v2i)) {
        const po = own(allOpts, paneId) && allOpts[paneId] && typeof allOpts[paneId] === 'object' && !isList(allOpts[paneId]) ? allOpts[paneId] : {};
        const m = migrateIb(v2i[paneId], po.levels);
        if (!m) continue;
        v2i[paneId] = m.pane; allOpts[paneId] = Object.assign({}, po, { levels: m.levels }); moved = true;
      }
      if (moved) { raw.set(KEYS.indicatorOptions, allOpts); raw.set(KEYS.indicators, v2i); }
    }
    /* 1.9.0 (review R1): the VWAP color the Colors panel kept in live-colors-v1 up to 1.8, copied once into the
       indicator colors, before the Colors panel (which no longer holds VWAP) writes that key again without it */
    const ic = cleanColors(obj(KEYS.indicatorColors), IND_COLOR_KEYS), oldVwap = cleanColors(obj(KEYS.colors), ['vwap']);
    if (!ic.vwap && oldVwap.vwap) raw.set(KEYS.indicatorColors, Object.assign(ic, oldVwap));
  }
  migrate();
  const paneOk = paneId => typeof paneId === 'string' && !!paneId && !Object.prototype.hasOwnProperty.call(Object.prototype, paneId);
  /* the indicator colors set by hand; before the first one, the VWAP color the Colors panel kept up to 1.8 */
  const savedIndColors = () => raw.has(KEYS.indicatorColors) ? cleanColors(obj(KEYS.indicatorColors), IND_COLOR_KEYS) : cleanColors(obj(KEYS.colors), ['vwap']);

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
        grid: GRIDS.includes(s.grid) ? s.grid : 'off',
        room: ROOMS.includes(s.room) ? s.room : DEFAULT_ROOM,
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
    /** Every indicator color (INDICATOR_COLORS): the one set by hand, else the house default. */
    indicatorColors() {
      const s = savedIndColors(), out = {};
      for (const c of INDICATOR_COLORS) out[c.key] = s[c.key] || c.def;
      return out;
    },
    /** Set indicator colors ({ key: '#RRGGBB' }, read fresh, only these written); false when none is allowed. */
    setIndicatorColors(colors) {
      const set = cleanColors(colors, IND_COLOR_KEYS);
      if (!Object.keys(set).length) return false;
      return raw.set(KEYS.indicatorColors, Object.assign(savedIndColors(), set));
    },
    /** The absorption settings for a root and chart type (G1c): the file's defaults for anything not set by hand. */
    absorptionSettings(root, type) {
      const all = obj(KEYS.signals), a = own(all, 'abs') && own(all.abs, root) && own(all.abs[root], type) ? all.abs[root][type] : null, out = {};
      for (const k of Object.keys(ABS_SPEC)) { const v = own(a, k) ? cleanSpec(ABS_SPEC[k], a[k]) : null; out[k] = v !== null ? v : ENGINE.ABSORPTION_DEFAULTS[k]; }
      return out;
    },
    /** Set one absorption setting for a root and chart type (read fresh, only that field written); false when not allowed. */
    setAbsorptionSetting(root, type, key, value) {
      const n = own(ABS_SPEC, key) ? cleanSpec(ABS_SPEC[key], value) : null;
      if (n === null || !ROOTS.includes(root) || typeof type !== 'string' || !/^(range:\d{1,3}|[a-z]\d{1,2})$/.test(type)) return false;
      const all = obj(KEYS.signals), abs = own(all, 'abs') && all.abs && typeof all.abs === 'object' && !isList(all.abs) ? all.abs : {};
      const r = own(abs, root) && abs[root] && typeof abs[root] === 'object' && !isList(abs[root]) ? abs[root] : {};
      const t = own(r, type) && r[type] && typeof r[type] === 'object' && !isList(r[type]) ? r[type] : {};
      t[key] = n; r[type] = t; abs[root] = r; all.abs = abs;
      return raw.set(KEYS.signals, all);
    },
    /** The divergence settings (G1c): DeltaDivergenceSignal's defaults for anything not set by hand. */
    divergenceSettings() {
      const all = obj(KEYS.signals), d = own(all, 'div') ? all.div : null, out = {};
      for (const k of Object.keys(DIV_SPEC)) { const v = own(d, k) ? cleanSpec(DIV_SPEC[k], d[k]) : null; out[k] = v !== null ? v : ENGINE.DIVERGENCE_DEFAULTS[k]; }
      return out;
    },
    setDivergenceSetting(key, value) {
      const n = own(DIV_SPEC, key) ? cleanSpec(DIV_SPEC[key], value) : null;
      if (n === null) return false;
      const all = obj(KEYS.signals), d = own(all, 'div') && all.div && typeof all.div === 'object' && !isList(all.div) ? all.div : {};
      d[key] = n; all.div = d;
      return raw.set(KEYS.signals, all);
    },
    /** The bubbles' Auto floor (the session's top 1%) for a root: off unless switched on. */
    bubbleAuto(root) { const all = obj(KEYS.signals); return own(all, 'auto') && own(all.auto, root) && all.auto[root] === true; },
    setBubbleAuto(root, on) {
      if (!ROOTS.includes(root)) return false;
      const all = obj(KEYS.signals), a = own(all, 'auto') && all.auto && typeof all.auto === 'object' && !isList(all.auto) ? all.auto : {};
      if (on) a[root] = true; else delete a[root];
      all.auto = a;
      return raw.set(KEYS.signals, all);
    },
    /** The large-print floors { <root>: { rth, eth } } (the workspace's Time and Sales floors, one key for both). */
    largeFloors() { return cleanLargeFloors(obj(KEYS.floors)); },
    /** Set one floor ('rth' or 'eth') of one root, a whole number 1 to 100000 (read fresh, only that one written). */
    setLargeFloor(root, which, value) {
      const n = cleanFloor(value);
      if (n === null || !ROOTS.includes(root) || (which !== 'rth' && which !== 'eth')) return false;
      const all = obj(KEYS.floors), r = own(all, root) && all[root] && typeof all[root] === 'object' && !isList(all[root]) ? all[root] : {};
      r[which] = n; all[root] = r;
      return raw.set(KEYS.floors, all);
    },
    /** Whether a chart pane shows its header text (1.14.0): on unless switched off. */
    legendShown(paneId) { return !(paneOk(paneId) && obj(KEYS.legend)[paneId] === false); },
    setLegendShown(paneId, on) {
      if (!paneOk(paneId)) return false;
      const all = Object.assign(Object.create(null), obj(KEYS.legend));
      if (on) delete all[paneId]; else all[paneId] = false;
      return raw.set(KEYS.legend, all);
    },
    bracket(root) { return obj(KEYS.bracket)[root]; },
    /** The qty picked last for a root (1.10.0): a whole number 1 to 9, else 1. */
    qty(root) { const v = obj(KEYS.qty)[root]; return Number.isInteger(v) && v >= 1 && v <= 9 ? v : 1; },
    setQty(root, n) { if (!ROOTS.includes(root) || !Number.isInteger(n) || n < 1 || n > 9) return false; return patch(KEYS.qty, root, n); },
    /** The bracket preset picked for a root (1.10.0): see cleanBracketSel. */
    bracketSel(root) { return cleanBracketSel(obj(KEYS.bracketSel)[root]); },
    setBracketSel(root, v) { if (!ROOTS.includes(root)) return false; return patch(KEYS.bracketSel, root, cleanBracketSel(v)); },
    /** The bracket boxes' unit (1.10.0): 't' (ticks, the default) or 'pt' (points). */
    bracketUnit() { return raw.get(KEYS.bracketUnit) === 'pt' ? 'pt' : 't'; },
    setBracketUnit(u) { return raw.set(KEYS.bracketUnit, u === 'pt' ? 'pt' : 't'); },
    /** Set one bracket field ('stop' or 'target', whole ticks 0 to 100000; the page caps what it sends by ChartBridge's
        version, 200 before 0.3.7) for one root; the other field is kept. */
    setBracketField(root, field, ticks) {
      if (!ROOTS.includes(root) || (field !== 'stop' && field !== 'target') || !Number.isInteger(ticks) || ticks < 0 || ticks > 100000) return false;
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

/*
 * Named color presets (1.9.0), behind one small interface so a store shared by every PC (Anthony's choice; which
 * store is still to be decided) can replace this browser's storage without changing the page:
 *   list()                     -> Promise of { chart: [preset], indicator: [preset] }
 *   save(group, name, colors, ind) -> Promise of { lists, preset, replaced }; a preset of that name (any case) is
 *                              replaced. `ind` (chart presets only): the id of an indicator preset to bring with it,
 *                              refused when that preset is gone; none drops the link of a preset replaced
 *   rename(group, id, name)    -> Promise of { lists, preset }
 *   remove(group, id)          -> Promise of { lists }
 *   shared                     true when every PC sees the same presets
 * A preset is { id, name, colors } (a chart preset may add `ind`, its linked indicator preset's id; a link to one
 * deleted since is ignored); `colors` holds every key of its group (PRESET_GROUPS). Each call reads the store
 * fresh and changes one preset, so two tabs never undo each other's. A refused call rejects with an Error whose
 * message the page shows as it is.
 */
function cleanPresets(v) {
  const out = { chart: [], indicator: [] };
  for (const g of Object.keys(PRESET_GROUPS)) {
    const list = v && typeof v === 'object' && isList(v[g]) ? v[g] : [], names = new Set(), ids = new Set();
    for (const p of list) {
      if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id || ids.has(p.id)) continue;
      const name = presetName(p.name), colors = cleanColors(p.colors, PRESET_GROUPS[g]);
      if (g === 'indicator') for (const k of IND_COLOR_LATER) if (!colors[k]) colors[k] = INDICATOR_COLORS.find(c => c.key === k).def.toUpperCase();
      if (!name || names.has(name.toLowerCase()) || Object.keys(colors).length !== PRESET_GROUPS[g].length) continue;
      names.add(name.toLowerCase()); ids.add(p.id);
      const q = { id: p.id, name, colors };
      if (g === 'chart' && typeof p.ind === 'string' && p.ind && p.ind.length <= 64) q.ind = p.ind;   // its indicator preset
      out[g].push(q);
      if (out[g].length >= PRESET_MAX) break;
    }
  }
  return out;
}
function localPresetStore(storage) {
  const read = () => { try { const s = storage && storage.getItem(KEYS.presets); return cleanPresets(s ? JSON.parse(s) : null); } catch (e) { return cleanPresets(null); } };
  const write = v => { try { if (!storage) return false; storage.setItem(KEYS.presets, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const fail = m => Promise.reject(new Error(m));
  const done = (all, extra) => write(all) ? Promise.resolve(Object.assign({ lists: all }, extra)) : fail('Not saved: this browser blocks site storage.');
  const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const taken = (list, name, id) => list.some(p => p.id !== id && p.name.toLowerCase() === name.toLowerCase());
  return {
    shared: false,
    list() { return Promise.resolve(read()); },
    save(group, name, colors, ind) {
      if (!own(PRESET_GROUPS, group)) return fail('Unknown preset group.');
      const n = presetName(name), c = cleanColors(colors, PRESET_GROUPS[group]);
      if (!n) return fail('Type a name for the preset first.');
      if (Object.keys(c).length !== PRESET_GROUPS[group].length) return fail('Not saved: a color is missing.');
      const all = read(), list = all[group], same = list.find(p => p.name.toLowerCase() === n.toLowerCase());
      if (group === 'chart' && ind && !all.indicator.some(p => p.id === ind)) return fail('That indicator preset is gone (deleted in another window).');
      const link = group === 'chart' && ind ? ind : null;          // the chart preset's indicator preset; none drops it
      if (same) { same.name = n; same.colors = c; if (link) same.ind = link; else delete same.ind; return done(all, { preset: same, replaced: true }); }
      if (list.length >= PRESET_MAX) return fail('This group holds ' + PRESET_MAX + ' presets: delete one to save another.');
      const p = { id: newId(), name: n, colors: c };
      if (link) p.ind = link;
      list.push(p);
      return done(all, { preset: p, replaced: false });
    },
    rename(group, id, name) {
      if (!own(PRESET_GROUPS, group)) return fail('Unknown preset group.');
      const n = presetName(name), all = read(), p = all[group].find(x => x.id === id);
      if (!p) return fail('That preset is gone (deleted in another window).');
      if (!n) return fail('Type a name for the preset first.');
      if (taken(all[group], n, id)) return fail('Another preset is already called ' + n + '.');
      p.name = n;
      return done(all, { preset: p });
    },
    remove(group, id) {
      if (!own(PRESET_GROUPS, group)) return fail('Unknown preset group.');
      const all = read();
      all[group] = all[group].filter(p => p.id !== id);
      return done(all, {});
    },
  };
}

/*
 * The page's clock (1.14.0, Anthony's item 9): the browser's monotonic clock (performance.now()) on a wall-clock base. The
 * base starts at performance.timeOrigin (the page load), and check() moves it to the PC's clock (Date.now()) whenever the
 * two differ by more than 50 ms, as ChartBridge re-anchors its own every 5 s: after Windows time sync steps the PC clock
 * the page follows within 5 s instead of showing a false "local -99 ms (PC clock behind)" until it reloads. now() stays
 * one addition (the live tick path's cost is unchanged), and every user of it (the local delay, the ticket link's
 * stamps) reads the same clock. Options: perfNow, wallNow (functions), origin (the first base), slackMs (50), everyMs (5000).
 */
const CLOCK_SLACK_MS = 50, CLOCK_EVERY_MS = 5000;
function pageClock(o) {
  const opt = o || {};
  const perf = opt.perfNow, wall = opt.wallNow;
  const slack = isFinite(opt.slackMs) ? +opt.slackMs : CLOCK_SLACK_MS, every = isFinite(opt.everyMs) ? +opt.everyMs : CLOCK_EVERY_MS;
  let base = typeof opt.origin === 'number' && isFinite(opt.origin) && opt.origin > 0 ? opt.origin : wall() - perf();
  let timer = null, steps = 0;
  const now = () => base + perf();
  /** Re-anchor when the page's clock and the PC's differ by more than slackMs: returns the step taken in ms (0: none). */
  function check() {
    const d = wall() - now();
    if (!(Math.abs(d) > slack)) return 0;
    base += d; steps++;
    return d;
  }
  return {
    now, check, everyMs: every, slackMs: slack,
    get steps() { return steps; },
    start(setIntervalFn) { if (timer === null) timer = (setIntervalFn || setInterval)(check, every); return this; },
    stop(clearIntervalFn) { if (timer !== null) (clearIntervalFn || clearInterval)(timer); timer = null; },
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

api = { pageClock, CLOCK_SLACK_MS, CLOCK_EVERY_MS, ABS_SPEC, DIV_SPEC, cleanSpec, chartType, cleanLargeFloors, NOCHIP, IND_COLOR_LATER, create, debounce, orderAccount, cleanBracketSel, BRACKET_SELS, localPresetStore, cleanPresets, presetName, cleanColors, INDICATOR_COLORS, IND_COLOR_KEYS, PRESET_GROUPS, PRESET_MAX, PRESET_NAME_MAX, parseRange, clampRange, cleanIndicators, cleanIndicatorOptions, indicatorOptionAllowed, INDICATOR_OPTIONS, PANE_HEIGHTS, cleanPane, defaultPane, paneFromV1, Pane, searchIndicators, KEYS, OLD, ROOTS, TFS, GLIDES, RANGE_MODES, GRIDS, ROOMS, DEFAULT_ROOM,
  DEFAULT_RANGE, INDICATORS, COMING, CATEGORIES, RECENT_MAX, PIN_MAX: 10, LEVEL_LINES, migrateIb, DEFAULT_INDICATORS, NEW_PANE_INDICATORS, MAIN_PANE, RANGE_MIN, RANGE_MAX };
return api;
});


/*
 * ChartLive: the live chart as a mountable piece. The standalone page (live/single.html, served by ChartBridge) and a
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
/* One clock for the whole page (every chart, the workspace, the ticket link's stamps): it follows Windows clock fixes. */
const PAGE_CLOCK = window.ChartLivePageClock || (window.ChartLivePageClock = LP.pageClock({ perfNow: () => performance.now(), wallNow: () => Date.now(), origin: performance.timeOrigin }).start());
const EMBED_PREFIX = 'embed:';            // storage prefix when a host passes none (live/EMBED.md)
let mountCount = 0;
/* The "/" key opens the Indicators menu of the chart under the mouse (1.6.0): each mounted chart notes when the pointer
   is over it. */
let hoverRoot = null;
const mountedRoots = new Set();
/* Charts on one page that share a storage prefix follow each other's account pick (review 2, N6). */
const accountPeers = new Set();
/* Charts on one page that share a storage prefix take a change of the signals' settings or floors at once (G1c). */
const signalPeers = new Set();

/*
 * Trading hotkeys (1.11.0): the one keydown handler, so a later page with several charts can use it for its execution
 * chart. `o.keys()` gives the hotkeys in use ({ buy: 'Alt+B', ... }), `o.actions` the function each one calls (the very
 * functions the order bar's buttons call), `o.root` the chart's element, `o.busy()` whether a menu or dialog of the
 * page is open. Nothing fires while the focus is in a box (input, textarea, select, editable), while a menu or dialog is
 * open, while the focus is outside this chart (a host's own fields), on a key the chart reads as its own, or after
 * another handler took the key. A hotkey that matches calls preventDefault, so the browser does not act on it too;
 * a held key's repeats (e.repeat) never fire an action.
 */
function hotkeyHandler(o) {
  return e => {
    if (e.defaultPrevented || e.isComposing) return;
    const id = OT.hotkeyAction(o.keys(), OT.hotkeyCombo(e));
    if (!id || typeof o.actions[id] !== 'function') return;
    const a = document.activeElement;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) {
      // Close and Flatten all say why nothing happened (1.12.0, the 1.11.0 review); the box keeps the key
      if ((id === 'close' || id === 'flattenAll') && !e.repeat && typeof o.ignored === 'function' && o.root.contains(a) && !o.busy()) o.ignored(id);
      return;
    }
    const onBody = !a || a === document.body || a === document.documentElement;
    if (!onBody && !o.root.contains(a)) return;
    if (o.busy() || OT.isChartKey(e)) return;
    e.preventDefault();
    if (e.repeat) return;
    o.actions[id]();
  };
}

/* A Close or Flatten all key pressed while a box has the focus fires nothing and says so (1.12.0). */
const HOTKEY_IN_BOX = 'Hotkey ignored: a box has the focus.';

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
    <button type="button" class="arm" id="${p}armBtn" role="switch" aria-checked="false" title="Armed: one click trades, no confirmation. Off after every page load."><span class="knob" aria-hidden="true"></span><span class="arm-text"><span id="${p}armText">Armed off</span><span class="arm-room" aria-hidden="true">ARMED: one click trades</span></span></button>
    <label class="ofield"><span class="glabel">Account</span><select class="acct-sel acct-main" id="${p}oAcct" aria-label="Account: orders go to it and the chart marks its fills" title="Orders go to this account, and the chart marks its fills"></select></label>
    <label class="ofield"><span class="glabel">Qty</span><select class="acct-sel oqty" id="${p}oQty" aria-label="Order quantity">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => '<option value="' + n + '">' + n + '</option>').join('')}</select><span class="ounit" id="${p}oQtyCap"></span></label>
    <span class="ofield">
      <button type="button" class="obtn buy" id="${p}buyMkt">Buy MKT</button>
      <button type="button" class="obtn sell" id="${p}sellMkt">Sell MKT</button>
    </span>
    <span class="ofield bfield"><span class="glabel">Bracket</span>
      <select class="acct-sel bpre" id="${p}bPreset" aria-label="Bracket preset" title="Bracket preset: a ratio links the target to the stop"></select>
      <span class="bsave" id="${p}bSaveBox" hidden><input class="oin bname" id="${p}bSaveName" type="text" maxlength="24" spellcheck="false" autocomplete="off" aria-label="Name for the bracket preset"><button type="button" class="btn" id="${p}bSaveOk">Save</button><button type="button" class="btn" id="${p}bSaveNo" aria-label="Do not save">x</button></span>
      <input class="oin" id="${p}bStop" type="number" min="0" max="200" step="1" inputmode="decimal" aria-label="Bracket stop in ticks, 0 for none" title="Stop, from the fill (0 = none)">
      <input class="oin" id="${p}bTarget" type="number" min="0" max="200" step="1" inputmode="decimal" aria-label="Bracket target in ticks, 0 for none" title="Target, from the fill (0 = none)">
      <span class="seg sans bunit" id="${p}bUnit" role="group" aria-label="Bracket stop and target in ticks or points"><button type="button" data-v="t" title="Ticks">t</button><button type="button" data-v="pt" title="Points">pt</button></span>
      <span class="nostop" id="${p}bNoStop" title="The stop is 0: an order sent now has no stop" hidden>NO STOP</span></span>
    <span class="ofield">
      <button type="button" class="btn" id="${p}flattenBtn" title="Cancel every working order on this account and instrument, then close the position at market">Flatten</button>
      <button type="button" class="btn" id="${p}beBtn" title="Move the stop to break-even">B/E</button>
      <button type="button" class="btn" id="${p}cancelAllBtn" title="Cancel every working order on this account and instrument">Cancel all</button>
    </span>
    <span class="ostate"><span class="oinfo" id="${p}oPos"></span><span class="oinfo olegs" id="${p}oLegs"></span><span class="oinfo dim oother" id="${p}oOther"></span><span class="oinfo acct-note" id="${p}oAcctNote" role="status"></span><span class="oinfo acct-note batch-note" id="${p}oCancel" role="status"></span><span class="ooff" id="${p}oOff"></span></span>
  </section></div>
`;
  const armPill = o.trading ? `<span class="pill armed" id="${p}armPill" hidden>ARMED</span>` : '';
  /* Settings (1.11.0): the trading hotkeys. Only on the trading page; a mounted chart has none. */
  /* 1.14.0 (Anthony: the single chart page gets the workspace's cleanup): the general controls (Glide, Range style, grid
     lines, the room right of price, ChartBridge's PIN) live in Settings, with the versions; the drawing tools and Reset
     view in a small menu, as in a workspace chart's header. A host's chart (no trading) keeps its toolbar as it was. */
  const seg = (id, label, list) => `<div class="seg sans" id="${p}${id}" role="group" aria-labelledby="${p}${id}Label">${list.map(([v, t]) => `<button type="button" data-v="${v}">${t}</button>`).join('')}</div>`;
  const rangeModeSel = `<select class="acct-sel range-mode" id="${p}rangeMode" title="NinjaTrader: every bar is exactly the range, like NinjaTrader's Range bars (a jump is filled with bars at prices that may not have traded). Traded prices only: a jump opens the next bar at the traded price, so a bar can end short of the range.">
          <option value="nt">NinjaTrader</option><option value="traded">Traded prices only</option></select>`;
  const settings = !o.trading ? '' : `
    <div class="set-wrap" id="${p}setWrap">
      <button type="button" class="btn set-btn" id="${p}setBtn" aria-expanded="false" aria-controls="${p}setPanel" aria-haspopup="dialog" title="Settings: the chart, trading hotkeys, PIN">Settings <span class="ind-caret" aria-hidden="true"></span></button>
      <div class="set-panel" id="${p}setPanel" role="dialog" aria-label="Settings" hidden>
        <div class="ind-head"><span class="ind-title">Settings</span></div>
        <div class="ind-cap" id="${p}chartCap">Chart</div>
        <div class="set-rows" role="group" aria-labelledby="${p}chartCap">
          <div class="set-row"><span class="set-name" id="${p}glideSegLabel">Glide</span>${seg('glideSeg', 'Glide', [['smooth', 'Smooth'], ['fast', 'Fast'], ['off', 'Off']])}</div>
          <div class="set-row"><label class="set-name" for="${p}rangeMode">Range style</label>${rangeModeSel}</div>
          <div class="set-row"><span class="set-name" id="${p}gridSegLabel">Grid lines</span>${seg('gridSeg', 'Grid lines', [['off', 'Off'], ['on', 'On']])}</div>
          <div class="set-row"><span class="set-name" id="${p}roomSegLabel" title="Empty space right of the last bar, kept at every zoom; Jump to live and End keep it">Room right</span>${seg('roomSeg', 'Room right', [['0', 'None'], ['40', '40 px'], ['80', '80 px'], ['160', '160 px']])}</div>
        </div>
        <div class="ind-cap" id="${p}hkCap">Hotkeys</div>
        <div class="hk-list" id="${p}hkList" role="group" aria-labelledby="${p}hkCap">${OT.HOTKEY_ACTIONS.map(a => `
          <div class="hk-row" data-hk="${a.id}">
            <label class="hk-name" for="${p}hk-${a.id}">${esc(a.name)}</label>
            <input class="hk-in" id="${p}hk-${a.id}" data-hk="${a.id}" type="text" readonly autocomplete="off" spellcheck="false" placeholder="None" aria-describedby="${p}hkNote-${a.id}">
            <button type="button" class="btn hk-clear" data-hk-clear="${a.id}" aria-label="Clear the ${esc(a.name)} hotkey">Clear</button>
            <span class="hk-note" id="${p}hkNote-${a.id}" role="status"></span>
          </div>`).join('')}
        </div>
        <p class="hk-foot">Click a box, then press the keys. Each does what its button does: Buy MKT and Sell MKT with the Qty and bracket shown, B/E, and Close (the Flatten button) on this account and instrument; Flatten all flattens every instrument with a position or a working order on this account. Buy, Sell and B/E need Armed; Close and Flatten all work with Armed off, like the Flatten button. Never while typing in a box or with a menu open. Saved in this browser.</p>${o.pin ? `
        <div class="set-row set-pin" id="${p}pinRow" hidden><span class="set-name">ChartBridge PIN</span><button type="button" class="btn" id="${p}pinBtn" title="Change this PC's ChartBridge PIN">Change PIN</button></div>` : ''}
        <p class="set-ver" id="${p}setVer"></p>
      </div>
    </div>`;
  /* the drawing tools and Reset view (the page): a small menu, as in a workspace chart's header */
  const more = !o.trading ? '' : `
    <div class="more-wrap" id="${p}moreWrap">
      <button type="button" class="btn more-btn" id="${p}moreBtn" aria-haspopup="menu" aria-expanded="false" aria-controls="${p}moreMenu" aria-label="Drawing tools and Reset view" title="Drawing tools, Reset view">⋯</button>
      <div class="more-menu" id="${p}moreMenu" role="menu" aria-label="Drawing tools and view" hidden>
        <button type="button" role="menuitem" id="${p}toolTrend" aria-pressed="false" title="Trend line: click two points or drag">Trend line</button>
        <button type="button" role="menuitem" id="${p}toolHline" aria-pressed="false" title="Horizontal line: click a price">Price line</button>
        <button type="button" role="menuitem" id="${p}clearDraw" title="Remove all drawings on this instrument">Clear drawings</button>
        <button type="button" role="menuitem" id="${p}resetBtn">Reset view</button>
      </div>
    </div>`;
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
      <span class="range-box" id="${p}rangeBox" hidden><label class="range-box" for="${p}rangeTicks"><input id="${p}rangeTicks" type="number" min="1" max="400" step="1" inputmode="numeric"><span id="${p}rangeUnit">ticks</span></label>${o.trading ? '' : `
        <label class="glabel" for="${p}rangeMode">Range style</label>
        ${rangeModeSel}`}</span>
    </div>

    <div class="group ind-group${o.trading ? ' codes-group' : ''}">
      <div class="ind" id="${p}indWrap" data-pane="${esc(o.paneId)}">
        <button type="button" class="btn ind-btn" id="${p}indBtn" aria-expanded="false" aria-controls="${p}indPanel" aria-haspopup="dialog" title="Indicators on this chart (/ with the mouse over the chart)">Indicators <span class="ind-count" id="${p}indCount"></span><span class="ind-caret" aria-hidden="true"></span></button>
        <div class="ind-panel${o.sideGears ? ' side-gears' : ''}" id="${p}indPanel" role="dialog" aria-label="Indicators on this chart" hidden>
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
      <div class="ind-chips${o.trading ? ' codes' : ''}" id="${p}indChips" role="group" aria-label="Pinned indicators: click to show or hide"></div>
      <button type="button" class="btn lg-tog" id="${p}lgTog" aria-pressed="true" title="Header text on this chart: on (click to turn it off)" aria-label="Header text on this chart">Aa</button>
    </div>
${o.trading ? more : `
    <div class="group" role="group" aria-label="Drawing tools">
      <button type="button" class="btn" id="${p}toolTrend" aria-pressed="false" title="Trend line: click two points or drag">Trend line</button>
      <button type="button" class="btn" id="${p}toolHline" aria-pressed="false" title="Horizontal line: click a price">Price line</button>
      <button type="button" class="btn" id="${p}clearDraw" title="Remove all drawings on this instrument">Clear</button>
    </div>

    <div class="group">
      <span class="glabel" id="${p}glideSegLabel">Glide</span>
      <div class="seg sans" id="${p}glideSeg" role="group" aria-labelledby="${p}glideSegLabel">
        <button type="button" data-v="smooth">Smooth</button>
        <button type="button" data-v="fast">Fast</button>
        <button type="button" data-v="off">Off</button>
      </div>
    </div>`}

    <span id="${p}colorsHost"></span>
${settings}${o.trading ? '' : `
    <button type="button" class="btn" id="${p}resetBtn">Reset view</button>`}
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

  <main class="stage">${o.trading ? `
  <div class="alert nostop-ask" id="${p}noStopAsk" role="alertdialog" aria-modal="false" aria-labelledby="${p}noStopTitle" aria-describedby="${p}noStopText" hidden>
    <span class="alert-title" id="${p}noStopTitle">No stop: send anyway?</span><span class="alert-text" id="${p}noStopText"></span>
    <span class="nostop-btns"><button type="button" class="btn" id="${p}noStopCancel">Cancel</button><button type="button" class="btn nostop-send" id="${p}noStopSend">Send</button></span>
  </div>` : ''}
    <div class="chart-box" id="${p}chart" aria-label="Live candlestick chart. Arrow keys pan, plus and minus zoom, End jumps to live, A fits the price axis, Delete removes the selected drawing."></div>
    <div class="legend" id="${p}legend">
      <div class="lg1"><b id="${p}lgName">MNQ</b><span class="tfbadge" id="${p}lgTf">1m</span><span class="dim" id="${p}lgSrc">NinjaTrader via ChartBridge · chart ${esc(CE.VERSION)}</span><span class="pill" id="${p}connPill">CONNECTING</span>${armPill}<span class="lg-bub" id="${p}lgBub" hidden></span><span class="lg-ro" id="${p}lgBar" hidden></span><span class="lg-ro" id="${p}lgAtr" hidden></span></div>
      <div class="lg2"><span class="dim" id="${p}lgTime">--:--</span><span>O <span id="${p}lgO">-</span></span><span>H <span id="${p}lgH">-</span></span><span>L <span id="${p}lgL">-</span></span><span>C <span id="${p}lgC">-</span></span><span id="${p}lgChg">-</span><span class="lg-ro" id="${p}lgSet" hidden></span><span class="lg-br" aria-hidden="true"></span><span>Vol <span id="${p}lgV">-</span></span></div>
      <div class="lg3" id="${p}lgRow3"><span id="${p}lgVwWrap">VWAP <span class="vw" id="${p}lgVw">-</span></span><span id="${p}lgVp" hidden>POC <span class="vpc" id="${p}lgPoc">-</span> · VA <span id="${p}lgVal">-</span> to <span id="${p}lgVah">-</span><span class="vpday" id="${p}lgVpDay"></span></span><span id="${p}lgDelta" hidden><span id="${p}lgDl">Delta</span> <span class="dv" id="${p}lgDv">-</span><span class="dunk" id="${p}lgDu" hidden></span></span><span id="${p}lgFill"></span></div>
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
 *   presetStore    where the Colors panel's named presets live (1.9.0): an object with LivePrefs.localPresetStore's
 *                  interface (list, save, rename, remove, shared). Default: this browser's storage, under the prefix.
 * Added for the workspace (live/index.html, E2a); each is optional and changes nothing when left out:
 *   feed           a ChartFeed hub (live/feed.js): the chart takes its instrument's data from the window's one connection
 *                  for that instrument instead of opening its own WebSocket (wsUrl is then not needed).
 *   view           { root, tf, range }: the chart's own instrument, bars and range size. The chart starts on them and
 *                  never saves them under the prefix (the host keeps them, onView tells it of a change).
 *   onView         called with { root, tf, range } when the chart's instrument, bars or range size change.
 *   toolbar        false: the chart's toolbar is not shown; the host shows its own header with the chart's Indicators
 *                  button (the returned `indicators` element) and calls setView, chart.setTool, chart.reset.
 *   onColors       called after the Colors panel or an indicator gear changed a color (the host refreshes its other charts).
 *   compact        true: for a small panel. The legend is at most 2 lines (no source line, no LIVE pill, no bar time; the
 *                  prices by importance) and the status line shows only while it carries a note (no delays, fps, ticks).
 * The returned object then also has setView(view), view(), refreshSettings() (Glide and Range style read again from
 * storage), refreshColors() (the colors read again from storage), `indicators` and `colors` (the Indicators and Colors
 * elements, for a host to place).
 * A mounted chart is always read only, whatever the options say: no GET /session, no auth, no order messages ever,
 * no order bar, no Armed switch, no Shift+click orders, no draggable order lines. Only the standalone page
 * (data-mount="page") can trade, and only when ChartBridge allows it.
 */
function mount(container, options) { return start(container, options || {}, false); }

function start(container, opt, PAGE) {
  if (!container || container.nodeType !== 1) throw new Error('ChartLive.mount needs a container element');
  const FEED = !PAGE && opt.feed && typeof opt.feed.open === 'function' ? opt.feed : null;   // the window's shared data (live/feed.js)
  if (!PAGE && !opt.wsUrl && !FEED) throw new Error('ChartLive.mount needs options.wsUrl');
  const VIEW = !PAGE && opt.view && typeof opt.view === 'object' ? opt.view : null;           // the host keeps root, tf and range
  const SLIM = !PAGE && opt.toolbar === false;                                               // the host shows its own header
  const COMPACT = !PAGE && opt.compact === true;                                             // a small panel: 2-line legend, notes only
  const onView = typeof opt.onView === 'function' ? opt.onView : null;
  const onColors = typeof opt.onColors === 'function' ? opt.onColors : null;
  const TRADING = PAGE;                          // trading only on ChartBridge's own page, never through mount()
  const PANE = typeof opt.paneId === 'string' && opt.paneId ? opt.paneId : LP.MAIN_PANE;
  const PREFIX = typeof opt.storagePrefix === 'string' ? opt.storagePrefix : PAGE ? '' : EMBED_PREFIX;
  const onStatus = typeof opt.onStatus === 'function' ? opt.onStatus : null;
  const PIN = PAGE ? window.ChartBridgePin || null : null;   // the page's PIN lock (live/pin.js); never on a mounted chart
  const WS_URL = opt.wsUrl || (PIN ? () => PIN.wsUrl(pageWsUrl()) : pageWsUrl());
  const p = PAGE ? '' : 'chart-live-' + (++mountCount) + '-';

  /* ---------------- this chart's element, lookups, and everything destroy() undoes */
  const rootEl = document.createElement('div');
  rootEl.className = 'chart-live' + (SLIM ? ' slim' : '') + (COMPACT ? ' compact' : '');
  rootEl.innerHTML = markup(p, { trading: TRADING, brand: opt.brand !== undefined ? !!opt.brand : PAGE, paneId: PANE, pin: !!PIN, sideGears: TRADING || SLIM });
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
  const S = Object.assign(prefs.settings(), { layers: LP.Pane.drawn(IS), options: { vp: prefs.indicatorOptions(PANE, 'vp'), delta: prefs.indicatorOptions(PANE, 'delta'), vwap: prefs.indicatorOptions(PANE, 'vwap'), levels: prefs.indicatorOptions(PANE, 'levels') } });   // layers: what is drawn
  const ranges = {};
  for (const r of ROOTS) ranges[r] = prefs.range(r);
  if (VIEW) {                                            // the host's own view: nothing of it is saved here
    if (ROOTS.includes(VIEW.root)) S.root = VIEW.root;
    if (LP.TFS.includes(VIEW.tf)) S.tf = VIEW.tf;
    const n = LP.parseRange(VIEW.range);
    if (n !== null) ranges[S.root] = n;
  }
  const saveSetting = k => { if (!(VIEW && (k === 'root' || k === 'tf'))) prefs.setSetting(k, S[k]); };
  const saveRange = (root, n) => { if (!VIEW) prefs.setRange(root, n); };
  const viewChanged = () => { if (onView) { try { onView({ root: S.root, tf: S.tf, range: ranges[S.root] }); } catch (e) { setTimeout(() => { throw e; }); } } };
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
  const nowMs = PAGE_CLOCK.now;                        // 1.14.0: follows the PC's clock (LivePrefs.pageClock)

  let IC = prefs.indicatorColors();                    // the indicators' colors (1.9.0), set in their gears
  const AXIS_W = 78;                                   // the price axis width (the engine's default), so the page knows where the plot ends
  const chart = CE.create($('chart'), {
    barSeconds: 60, precision: 2, tick: 0.25, axisWidth: AXIS_W,
    session: { start: SESSION, rthStart: 34200, rthEnd: 57600 },
    layers: { volume: S.layers.volume, vwap: S.layers.vwap, levels: S.layers.levels, ib: S.layers.levels, vp: S.layers.vp, delta: S.layers.delta, trades: false,
      absorption: S.layers.absorption, bubbles: S.layers.bubbles, divergence: S.layers.delta && S.options.delta.div === 'on' },
    grid: S.grid === 'on', room: S.room,                 // 1.14.0: grid lines (off by default) and the room right of price
    motion: GLIDE[S.glide], clock: etNow, theme: { vwap: IC.vwap, vpPoc: IC.vpPoc, vpRow: IC.vpRow, vpValue: IC.vpValue, sigBull: IC.sigBull, sigBullLine: IC.sigBullLine, sigBear: IC.sigBear, sigBearLine: IC.sigBearLine },
  });
  chart.setDeltaView({ mode: S.options.delta.show, ratio: prefs.paneHeight(PANE, 'delta') });   // the delta pane (1.7.0), per pane

  if (PAGE) window.liveChart = chart;  // for tests and the console; order actions still go through the checks below
  if (PAGE) window.liveData = () => D;  // the page's data, for tests and the console (read it; changing it breaks the chart)

  /* ---------------- per-instrument data */
  const D = { root: null, name: null, tick: 0.25, ready: false, hist: [], ticks: new BB.TickStore(), m1: null, cur: null, day: null, tickHours: 0, tickFrom: Infinity, trimmed: false,
    lv: [], lvSrc: null, ib: null, ibKey: '', vp: null, liveFrom: null, delta: null, sides: null,
    // the delta pane (1.7.0): the number of tick backfill trades (the store's trades before the first live one), and the
    // window the current delta was built with ({ from, by, why, journal })
    backfill: 0, deltaCov: null,
    sub: 0, window: false, table: null, vpTable: null, sync: null };   // served window and session table (1.8.0): see "Served window" below
  /* The chart signals' objects (G1c, see sigReplay below): what the chart draws, made again with the bars. */
  // version: a counter the page bumps on any change of what is drawn (the chart redraws when it moves)
  const SIG = { absorption: null, bubbles: null, divergence: null, cd: null, version: 0, job: null, rangeFrom: undefined };
  const sigSum = () => (SIG.absorption ? SIG.absorption.version : 0) + (SIG.bubbles ? SIG.bubbles.version : 0) + (SIG.divergence ? SIG.divergence.version : 0);
  let sigFloors = prefs.largeFloors();
  let bridgeVersion = '';                                      // ChartBridge's version from hello (the delta pane's first hint)
  /* Seconds and range bars are built from ticks; minute and hour bars only need 1-minute history (fast load).
     Range bars need the backfill to reach back to a session start (see rangeHistoryFrom in bar-builder.js).
     With ChartBridge 0.3.5 (hello "liveFirst") seconds and range views get ChartBridge's served window instead: the last
     rangeHours of trades (its config, default 2), whatever tickHours says (any number above 0 asks for it). */
  const tickView = () => TF[S.tf].mode === 'range' || TF[S.tf].sec < 60;
  const WINDOW_TICK_HOURS = 2;
  const viewTicksWanted = () => LIVE_FIRST ? (tickView() ? WINDOW_TICK_HOURS : 0) : TF[S.tf].mode === 'range' ? BB.rangeTickHours(etNow(), SESSION) : TF[S.tf].sec < 60 ? 8 : 0;
  const viewTicksMissing = () => LIVE_FIRST ? tickView() && D.tickHours === 0
    : TF[S.tf].mode === 'range' ? BB.rangeNeedsReload(D.tickFrom, etNow(), SESSION, D.trimmed) : TF[S.tf].sec < 60 && D.tickHours === 0;
  // The delta pane loads nothing of its own (Anthony, round 4): it counts live trades from the page's open, on any view.
  /* Each rule for ticks as its own function; the load asks for the most any of them wants (another rule joins as one
     more term of the max). 1.6.1 loads no tick history beyond the view's (as 1.6.0; Anthony 2026-09-30, after ChartBridge's
     big loads froze NinjaTrader during RTH); the volume profile's whole session, and the last session's after a weekend
     load, come from ChartBridge 0.3.5's session table (vpBuild). */
  const ticksWanted = () => viewTicksWanted();
  const ticksMissing = () => viewTicksMissing();
  /* The last price seen per instrument, kept across loads: click-to-place orders work while a view loads (1.8.0). */
  const lastSeen = {};                                   // root -> { p, at }: a price older than LAST_SEEN_MS is not used
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
    D.lv = []; D.lvSrc = null; D.ib = null; D.ibKey = ''; ibNote(null);
    D.vp = null; D.liveFrom = null; chart.setProfile(null); vpNote(); vpLegend();
    D.window = false; D.table = null; D.sync = null; rangeNote();
    D.backfill = 0; D.deltaCov = null;
    deltaJob = null; D.delta = null; D.sides = null; chart.setDelta(null); deltaView(); deltaLegend(true);   // a build of the old load stops
    if (SIG.job || SIG.absorption || SIG.bubbles || SIG.divergence) { SIG.job = null; SIG.absorption = SIG.bubbles = SIG.divergence = SIG.cd = null; SIG.version++; }   // made again with the bars
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
    D.sync = null; rangeNote();                          // a range view's proven point (buildWindow)
    if (tf.mode === 'time' && tf.sec >= 60) {
      D.cur = null;
      const bars = tf.sec === 60 ? D.m1.bars : U.aggregate(D.m1.bars, tf.sec);
      chart.setBars(bars, { barSeconds: tf.sec });
      chart.setCountdown(null);
    } else if (D.window) {
      buildWindow(tf);
      rangeFrom = 0;                                     // the window's range bars are built from its first trade (the delta's too)
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
    sigRebuild(tf.mode === 'range' ? rangeFrom : undefined);   // the chart signals on the new bars (G1c), range bars from where the chart's start
    updateLevels();
    applyMarkers();
    vwapApply();                                         // RTH only VWAP (1.14.0): from the new bars
    legendKey = '';
    readouts();
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
    let text = D.ready && D.sync && D.sync.bar < 0
      ? 'Range bars start where they are proven to match NinjaTrader\'s: after a swing of more than the range each way, or at the next 18:00 ET session.' : '';
    // review 3 S-C: the VWAP of a served-window view never goes silently: after a feed drop it is kept (the table's sums and
    // the page's trades) and says what it misses; with no table from 18:00 it is not drawn and says why
    const T = D.table;
    if (!text && D.ready && D.window && tickView() && S.layers.vwap && T && T.day === U.tradeDay(etNow(), SESSION)) {
      if (T.drop && T.coveredFrom <= T.from + 1) text = 'VWAP and ' + (TF[S.tf].mode === 'range' ? 'range bars after ' + U.fmtHM(T.drop.at) + ' ET miss' : 'bars miss') + ' the trades while the data connection was down (' + U.fmtHM(T.drop.at) + ' ET).';
      else if (!T.whole) text = /^(wanted|queued|asked|failed once)/.test(T.backfill) ? 'VWAP: shown once ChartBridge has loaded this session from 18:00 ET (building).'
        : /^waiting/.test(T.backfill) ? 'VWAP not shown yet: loading this session waits for NinjaTrader, which has not answered an earlier tick request.'
        : 'VWAP not shown: ChartBridge has this session\'s trades only since ' + U.fmtHM(T.coveredFrom) + ' ET.';
    }
    if (el.textContent !== text) el.textContent = text;
    el.hidden = !text;
  }
  /* The session VWAP's start for a build fed from store index `from`: the session table's price times volume and volume
     (every trade of its session up to the table's store index `at`), less the trades of that session in [from, at), or
     plus those in [at, from). null while the table is not whole, or unknown. Whole ticks, so the sums are exact. */
  function vwapSeed(from) {
    const T = D.table;
    if (!T || !(T.whole || (T.drop && T.coveredFrom <= T.from + 1))) return null;   // after a feed drop: every trade seen (the note says what is missing)
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
    D.lvSrc = lv;
    D.lv = U.levelLines(lv, IC);
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
    chart.setLevels(levelsOn(D.lv.concat(U.ibLines(ib, IC))));
    ibNote(ib);
  }
  /* The level lines switched on in the Levels gear (1.14.0: each line on its own; the IB's two are Levels' too). */
  const levelsOn = list => list.filter(L => !L.key || S.options.levels[L.key] !== 'off');
  const ibShown = () => !!S.layers.levels && (S.options.levels.ibh !== 'off' || S.options.levels.ibl !== 'off');
  /* New indicator colors (a gear, an indicator preset, Default colors): the chart's VWAP and profile colors, the level
     and IB lines as they are, and the swatches. Nothing is computed again from the bars. */
  function applyIndicatorColors() {
    chart.setTheme({ vwap: IC.vwap, vpPoc: IC.vpPoc, vpRow: IC.vpRow, vpValue: IC.vpValue, sigBull: IC.sigBull, sigBullLine: IC.sigBullLine, sigBear: IC.sigBear, sigBearLine: IC.sigBearLine });
    if (D.lvSrc) D.lv = U.levelLines(D.lvSrc, IC);
    if (D.m1) chart.setLevels(levelsOn(D.lv.concat(U.ibLines(D.ib, IC))));
    paintColors();
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
    let text = ib && ibShown() ? IB_NOTES[ib.state] || '' : '';
    if (ib && ibShown() && ib.state === 'closed') {                     // a holiday gets a note (naming the day), a weekend none
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
  /* The end of the trading the profile counts (review 3 S-B: a drop after it misses nothing): the RTH close (16:00, 13:00 on
     an early close) for RTH, else 17:00 ET, the session's close. */
  const vpEnd = need => D.vp && D.vp.rth ? Math.floor(need / 86400) * 86400 + (U.rthClose(need) || 57600) : need + 23 * 3600;
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
      else if (D.vpTable && D.vpTable.drop && D.vpTable.drop.at >= need && D.vpTable.drop.at < vpEnd(need)) text = 'Volume profile missing trades: the data connection was down at ' + U.fmtHM(D.vpTable.drop.at) + ' ET, and the trades while it was down are not in it.';
      else if (partial && D.vpTable) {                 // 1.8.0: ChartBridge's table: its one backfill still to come (building), or none (since)
        const T = D.vpTable, building = /^(wanted|queued|asked|failed once)/.test(T.backfill);
        text = building ? 'Volume profile building, from ' + fromText + ' ET: ChartBridge started after ' + from + ' ET and loads the session once, in the background.'
          : /^waiting/.test(T.backfill) ? 'Volume profile since ' + fromText + ' ET: loading this session waits for NinjaTrader, which has not answered an earlier tick request.'   // review 4 S2
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
    floor: -Infinity, day: null, trades: new BB.TickStore(), base: null, lastT: null, gap: false, missed: 0 };
  // K.base: the backfill's measured trades, { store, from, to }: on the count's first load the store itself (nothing
  // copied), and before a later load only this session's part of it, copied once (countKeepBase), so no store is held twice
  let loadSeq = 0;
  function countReset(root) {
    K.root = root; K.started = false; K.trades = new BB.TickStore(); K.base = null; K.day = null; K.firstT = null; K.floor = -Infinity;
    K.lastT = null; K.gap = false; K.missed = 0;
    K.openWhy = K.opened ? '' : 'page opened';         // "(page opened)" only for the page's first instrument
    K.opened = true;
  }
  /* The window from this load's store (the count's first load, or before it begins). */
  function storeCoverage() {
    const live = D.liveFrom === null ? Infinity : D.liveFrom + liveLate();
    const n = D.ticks.length, k = D.ticks.firstMeasured(0, Math.min(D.backfill, n));
    let cov;
    if (k < Math.min(D.backfill, n)) cov = { from: D.ticks.time(k), index: k, by: 'store', why: '' };   // the backfill's measured window, from its first trade on
    else {                                                                    // none: from the page's opening
      const b = Math.min(D.backfill, n), first = b < n ? D.ticks.time(b) : Infinity;   // the first live trade counts (round 6)
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
    if (b.from < 0) { b.from = 0; K.floor = Math.max(K.floor, D.ticks.time(0) + 1e-6); }
    if (b.to <= 0) K.base = null;
  }
  /*
   * A live trade of the count's instrument; true when the count's trades were dropped (a new session, or the cap).
   * The seconds the count missed (round 6): a later load of the instrument (a reconnect, a bridge restart, a view that
   * needs more ticks) leaves a hole, the trades between the last one counted before it and the first of the new load
   * (ChartBridge holds a page's trades during a load and sends the ones its backfill holds only there, with tick-rule
   * sides under quoteHours 0). Its length on the trades' own clock, from the last trade before it (the hole can be no
   * longer), in this session only; the label shows the session's total from 1 s ("missed 32 s").
   */
  function countAdd(m) {
    const t = m.t, day = U.tradeDay(t, SESSION);
    let dropped = false;
    if (K.day !== null && day > K.day && (K.trades.length || K.base)) { K.trades = new BB.TickStore(); K.base = null; dropped = true; }   // 18:00 ET: a new session from 0
    if (K.day !== null && day > K.day && K.missed) { K.missed = 0; deltaView(); }   // the new session's title drops the old gap
    if (K.day === null || day > K.day) K.day = day;
    if (K.firstT === null) K.firstT = t;
    if (K.gap && D.ready && D.root === K.root) {         // the first trade of the new load
      K.gap = false;
      if (K.lastT !== null) { const hole = t - Math.max(K.lastT, BB.sessionStartOf(t, SESSION)); if (hole > 0) { K.missed += hole; deltaView(); deltaLegend(true); } }
    }
    if (K.lastT === null || t > K.lastT) K.lastT = t;
    K.trades.push(t, m.p, m.v || 0, m.s, m.sm);
    if (K.trades.length > 2500000) { K.trades.dropFirst(500000); K.base = null; K.floor = K.trades.time(0) + 1e-6; dropped = true; sigCountTrimmed(500000); }
    return dropped;
  }
  const countMissed = () => K.started && K.root === D.root ? K.missed : 0;
  /* The window a build counts from: the count's, when it began on an earlier load of this instrument, else this store's. */
  function deltaCoverage() {
    if (!(K.started && K.root === D.root && K.load !== loadSeq)) return storeCoverage();
    const live = K.liveFrom + liveLate(), first = K.firstT !== null ? K.firstT : Infinity;
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
      // from the count (a later load of the same instrument): its trades on this load's bars; on range bars by their order
      // in this load's store, as the chart's range bars were built (BB.RangeReplay, round 6), never by their time
      const segs = (K.base ? [{ st: K.base.store, i: K.base.from, end: K.base.to }] : []).concat({ st: K.trades, i: 0, end: null });
      job = deltaJob = range ? { cd, cov, segs, replay: null, i: o.rangeFrom === undefined ? null : o.rangeFrom, scan: 0, from: D.tickFrom }
        : { cd, cov, feed: cd, segs };
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
      if (job.replay !== undefined) {                       // the count on range bars
        if (!job.replay) job.replay = new BB.RangeReplay(D.ticks, job.i, job.segs, rangeBuilder(), (t, v, s2, barT, sm) => job.cd.add(t, v, s2, barT, sm));
        let done;
        do done = job.replay.step(DELTA_SLICE_TRADES);
        while (!done && performance.now() - t0 < DELTA_SLICE_MS);
        if (!done) { later(slice, 0); return; }
      } else if (job.segs) {                                // the count: its kept backfill part, then its live trades (to their end)
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
  function deltaSet(cd) { D.delta = cd; chart.setDelta(cd); deltaView(); deltaLegend(true); if (typeof sigDivergence === 'function') sigDivergence(false); }
  const deltaBuilding = () => deltaJob !== null;
  /* The pane's note (only for a ChartBridge that sends no sides, and then nothing else is drawn in it), and why a
     session may count from later than 18:00, for its title. */
  const deltaWhy = () => D.deltaCov ? D.deltaCov.why : '';
  function deltaView() { chart.setDeltaView({ note: S.layers.delta && D.ready && bridgeSides() === false ? OLD_BRIDGE : '', reason: deltaWhy(), missed: countMissed() }); }
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
    const missed = !bar && ses && ses === cd.session && countMissed() >= 1 ? Math.round(countMissed()) : 0;   // round 6
    const key = [cd.version, legendBarT, bar, v, missed].join('|');
    if (!force && key === deltaLegendKey) return;
    deltaLegendKey = key;
    const since = !bar && ses && (ses.partial || missed) ? U.fmtExact(ses.partial ? ses.from : ses.start) : '';
    put($('lgDl'), 'textContent', (bar ? 'Bar delta' : 'Delta') + (since ? ' since ' + since : '') + (missed ? ', missed ' + missed + ' s' : ''));
    const dv = $('lgDv');
    put(dv, 'textContent', v === null ? '-' : U.fmtSigned(v, 0));
    put(dv, 'className', 'dv' + (v > 0 ? ' up' : v < 0 ? ' down' : ''));
    const unk = ses ? ses.unknown : 0, du = $('lgDu');
    put(du, 'hidden', !(unk > 0));
    put(du, 'textContent', unk > 0 ? ' · ' + U.fmtPrice(unk, 0) + ' unknown' : '');
    put(el, 'title', (bar ? 'Bar delta: each bar\'s market buys minus market sells' : 'Cumulative delta: market buys minus market sells since ' +
      (ses && ses.partial ? U.fmtExact(ses.from) + ' ET' + (deltaWhy() ? ' (' + deltaWhy() + ')' : '') : '18:00 ET') + (missed ? ', missing ' + missed + ' s the page was reloading or reconnecting' : '')) +
      '. Sides from ChartBridge; unknown sides add nothing.');
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
      if (id === 'vp' && key === 'session') { vpLegendVer = -1; vpBuild(); }
      if (id === 'vp' && key !== 'session') profileLines();               // the developing POC, VAH and VAL (1.14.0)
      if (id === 'levels') { if (D.m1) chart.setLevels(levelsOn(D.lv.concat(U.ibLines(D.ib, IC)))); ibNote(D.ib); }
      if (id === 'vwap') { vwapApply(); legendKey = ''; }
      if (id === 'delta' && key === 'show') { chart.setDeltaView({ mode: value }); deltaLegend(true); }   // the same core, drawn the other way
      if (id === 'delta' && key === 'div') sigApply();               // the divergence arrows (G1c)
    }
    syncIndicators();
    return true;
  }


  /*
   * Chart signals (G1c): absorption bars, large-order bubbles and the delta pane's divergence arrows (ChartEngine's
   * Absorption, LargePrints and DeltaDivergence, ported from Anthony's NinjaScript files). Fed the live trades of this
   * instrument with their sides as they come (onTick, one trade at a time: never a loop over history per trade), so
   * they count from the page's opening only. A rebuild (another bar type or size, a reload) or a change of settings
   * replays the count's live trades (K above: every live trade of this instrument since the page opened, kept across
   * loads) in slices, as the delta build does; the divergence is worked out again from the bars when the bars or the
   * delta core change, once per bar close after that.
   * Settings: the absorption's per instrument and chart type, the divergence's, the bubbles' Auto (live-signals-v1),
   * the large-print floors (live-tape-floors-v1, the workspace's Time and Sales floors; RTH 09:30 to 16:15 ET).
   */
  const sigType = () => LP.chartType(S.tf, ranges[S.root]);
  const sigFloorAt = root => { const f = sigFloors[root]; return f ? t => CE.largeFloorAt(f, t) : () => Infinity; };
  const sigWanted = () => ({ abs: !!IS.ind.absorption.on, bub: !!IS.ind.bubbles.on, div: !!IS.ind.delta.on && S.options.delta.div === 'on' });
  const SIG_GEARS = ['absorption', 'bubbles', 'delta'];
  const newAbsorption = () => new CE.Absorption({ settings: prefs.absorptionSettings(D.root, sigType()), floorAt: sigFloorAt(D.root), tick: D.tick });
  const newBubbles = () => new CE.LargePrints({ floorAt: sigFloorAt(D.root), auto: prefs.bubbleAuto(D.root), tick: D.tick, sessionStart: SESSION });
  chart.setSignals(SIG);
  /* Start over from the count's live trades: `what` names the ones to make again ({ abs, bub }); the others keep going. */
  function sigReplay(what) {
    const want = sigWanted(), was = SIG.job;
    SIG.job = null;
    // a replay still going for the other one is stopped here, so it starts again with this one
    const doAbs = what.abs || !!(was && was.abs && was.abs === SIG.absorption), doBub = what.bub || !!(was && was.bub && was.bub === SIG.bubbles);
    if (doAbs) SIG.absorption = want.abs && D.root ? newAbsorption() : null;
    if (doBub) SIG.bubbles = want.bub && D.root ? newBubbles() : null;
    SIG.version++;
    const abs = doAbs ? SIG.absorption : null, bub = doBub ? SIG.bubbles : null;
    if (!abs && !bub) return;
    if (!(K.started && K.root === D.root && D.ready)) return;
    // range bars: each counted trade in the bar it made, by its order in the store, as the delta pane does (BB.RangeReplay),
    // so a rebuild paints the bars that live trading painted; time bars bucket by time
    const range = TF[S.tf].mode === 'range' && SIG.rangeFrom !== undefined;
    const seg = { st: K.trades, i: 0, end: null }, from = D.tickFrom;
    const job = SIG.job = { abs, bub, seg, replay: null };
    const take = (t, p, v, s, barT) => {
      if (job.abs && barT !== undefined) job.abs.add(t, p, v, s, barT, chart.bars());
      if (job.bub) job.bub.add(t, p, v, s, barT);          // the bar it traded in (1.14.0): a bubble never straddles bars
    };
    const sink = { addQuiet(t, p, v, s) { const bars = chart.bars(), i = CE.barIndexAt(bars, t); take(t, p, v, s, i >= 0 ? bars[i].t : undefined); } };
    if (range) job.replay = new BB.RangeReplay(D.ticks, SIG.rangeFrom, [seg], rangeBuilder(), (t, v, s2, barT) => take(t, seg.st.price(seg.i), v, s2, barT));
    const slice = () => {
      if (destroyed || SIG.job !== job) return;
      // the count dropped its trades (18:00 ET), or the store was trimmed under a range replay: again
      if (seg.st !== K.trades || (job.replay && D.tickFrom !== from)) { sigReplay({ abs: !!job.abs, bub: !!job.bub }); return; }
      const t0 = performance.now();
      if (job.replay) {
        let done;
        do done = job.replay.step(DELTA_SLICE_TRADES);
        while (!done && performance.now() - t0 < DELTA_SLICE_MS);
        SIG.version++;
        if (!done) { later(slice, 0); return; }
      } else {
        do seg.i = seg.st.feedSides(sink, seg.i, null, seg.i + DELTA_SLICE_TRADES);
        while (seg.i < seg.st.length && performance.now() - t0 < DELTA_SLICE_MS);
        SIG.version++;
        if (seg.i < seg.st.length) { later(slice, 0); return; }
      }
      SIG.job = null; SIG.version++;                       // through: live trades from here on
    };
    slice();
  }
  /* The count dropped its oldest n trades (countAdd): a replay reading it keeps its place. */
  function sigCountTrimmed(n) { const j = SIG.job; if (j && j.seg.st === K.trades) j.seg.i = Math.max(0, j.seg.i - n); }
  /* The divergence: made again when its settings, the bars or the delta core change; then one step per bar close. */
  const divWanted = () => S.options.delta.div === 'on' && IS.ind.delta.on;
  function sigDivergence(force) {
    const want = divWanted() && !!D.delta;
    if (!want) { if (SIG.divergence) { SIG.divergence = null; SIG.cd = null; SIG.version++; } return; }
    if (force || !SIG.divergence || SIG.cd !== D.delta) { SIG.divergence = new CE.DeltaDivergence({ settings: prefs.divergenceSettings() }); SIG.cd = D.delta; SIG.version++; }
    const bars = chart.bars(), dv = SIG.divergence;
    if (bars === dv.bars && dv.next >= bars.length - 1) return;   // no bar closed since: nothing to do
    const cd = D.delta, cb = cd.bars, v0 = dv.version;
    dv.update(bars, i => {                                 // the delta at the close of bar i, carried over a bar with no trade
      const t = bars[i].t, k = cd.lowerBound(t);
      if (k < cb.length && cb[k].t === t) return cb[k].c;
      const j = k - 1;
      return j >= 0 && U.tradeDay(cb[j].t, SESSION) === U.tradeDay(t, SESSION) ? cb[j].c : null;
    });
    if (dv.version !== v0) SIG.version++;
  }
  /* On new bars (a load, another bar type or size): the absorption bars again; the bubbles only after a new load (they
     are kept by time, whatever the bars); the divergence from the bars. */
  function sigRebuild(rangeFrom) { SIG.rangeFrom = rangeFrom; sigReplay({ abs: true, bub: !SIG.bubbles }); sigDivergence(true); }
  /* One live trade, after the chart and the delta core took it (onTick). */
  function sigTrade(t, p, v, s, barT) {
    const job = SIG.job, v0 = sigSum();
    if (SIG.absorption && !(job && job.abs === SIG.absorption)) SIG.absorption.add(t, p, v, s, barT, chart.bars());
    if (SIG.bubbles && !(job && job.bub === SIG.bubbles)) SIG.bubbles.add(t, p, v, s, barT);
    if (sigSum() !== v0) SIG.version++;                    // the versions only grow: any change moves the sum
    if (SIG.divergence || divWanted()) sigDivergence(false);
  }
  /* The signals' layers on the chart: the absorption bars and bubbles as drawn, the arrows with the delta pane. */
  function sigLayers() {
    const div = !!S.layers.delta && S.options.delta.div === 'on';
    chart.setLayers({ absorption: !!S.layers.absorption, bubbles: !!S.layers.bubbles, divergence: div });
  }
  /* What is on the chart changed: make what is wanted and drop what is not (kept while hidden, as the delta pane). */
  function sigApply() {
    const want = sigWanted(), what = { abs: want.abs !== !!SIG.absorption, bub: want.bub !== !!SIG.bubbles };
    if (what.abs || what.bub) sigReplay(what);
    sigDivergence(false);
    sigLayers();
  }
  /* Settings read again (another chart or window changed them, or this one did): replay only what they change. */
  function sigRefresh(render) {
    if (destroyed) return;
    const f = prefs.largeFloors(), floorsNew = JSON.stringify(f) !== JSON.stringify(sigFloors);
    sigFloors = f;
    const want = sigWanted(), a = SIG.absorption, b = SIG.bubbles;
    const absNew = want.abs && (!a || floorsNew || JSON.stringify(a.s) !== JSON.stringify(Object.assign({}, CE.ABSORPTION_DEFAULTS, prefs.absorptionSettings(D.root, sigType()))));
    const bubNew = want.bub && (!b || floorsNew || b.auto !== prefs.bubbleAuto(D.root));
    if (absNew || bubNew) sigReplay({ abs: absNew, bub: bubNew });
    if (want.div && SIG.divergence && JSON.stringify(SIG.divergence.s) !== JSON.stringify(prefs.divergenceSettings())) sigDivergence(true);
    if (render !== false && !$('indPanel').hidden && M.gear && SIG_GEARS.includes(M.gear)) renderMenu();
  }
  /* Charts on this page with this prefix follow a change made in one of them at once; other windows by the storage
     event. The workspace's own floors (its Settings and tape gears) call refreshSettings, and hear of a change made
     here through the window event 'chartlive-floors'. */
  signalPeers.add({ prefix: PREFIX, refresh: sigRefresh });
  cleanups.push(() => { for (const peer of signalPeers) if (peer.refresh === sigRefresh) signalPeers.delete(peer); });
  const sigChanged = floors => {
    sigRefresh(false);                                     // this chart's gear shows what was typed already
    for (const peer of signalPeers) if (peer.prefix === PREFIX && peer.refresh !== sigRefresh) peer.refresh();
    if (floors) { try { window.dispatchEvent(new CustomEvent('chartlive-floors', { detail: { prefix: PREFIX } })); } catch (e) { /* old browser */ } }
  };
  listen(window, 'storage', e => { if (e.key === PREFIX + LP.KEYS.signals || e.key === PREFIX + LP.KEYS.floors) sigRefresh(); });

  /* readyAt (ms): when the shared feed's load became ready, for a chart that joins it later (live/feed.js); else now */
  function onReady(readyAt) {
    const nowEt = typeof readyAt === 'number' && isFinite(readyAt) && readyAt > 0 ? readyAt / 1000 + etOffset : etNow();
    // With ticks: 1m history up to the start of the current minute, and the forming minute rebuilt from
    // ticks. Without ticks: keep NinjaTrader's forming minute and let live ticks continue it.
    const cutoff = D.tickHours > 0 ? Math.floor(nowEt / 60) * 60 : Infinity;
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
    D.liveFrom = nowEt;
    if (D.m1.last) lastSeen[D.root] = { p: D.m1.last.c, at: nowMs() };
    D.backfill = D.ticks.length;
    if (!K.started || K.root !== D.root) countStart();   // the count begins with this instrument's first load (round 5)
    rebuild();
    vpBuild();
    setConn('live');
    $('notice').hidden = true;
  }

  function onTick(m) {
    if (m.root === D.root) lastSeen[m.root] = { p: m.p, at: nowMs() };   // ChartBridge holds live trades during a load: this is the price when it began
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
    // Over 2.5 million trades the trades of earlier sessions go (the first session left is partial now); the current
    // session's never do, so range bars built from the store stay all day (1.8.0; BB.trimCount).
    const drop = D.ticks.length > TRIM_CAP ? BB.trimCount(D.ticks, etNow(), SESSION, TRIM_CAP, TRIM_HARD, 500000) : 0;
    if (drop > 0) {
      D.ticks.dropFirst(drop); D.tickFrom = D.ticks.time(0) + 0.001; D.trimmed = true;
      if (D.table) D.table.at = Math.max(0, D.table.at - drop);
      D.backfill = Math.max(0, D.backfill - drop); countStoreTrimmed(drop);
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
      if (cov && cov.by === 'live' && t < cov.from) { deltaStart({ keep: true }); deltaFed = true; }
    }
    ticksSeen++;
    const r1 = D.m1.add(t, p, v);
    const tf = TF[S.tf];
    let barT;                                          // the start of the chart bar this trade made (for the delta pane)
    if (tf.mode === 'time' && tf.sec >= 60) { chart.update(tf.sec === 60 ? r1.bar : U.foldLast(D.m1.bars, tf.sec)); barT = Math.floor(r1.bar.t / tf.sec) * tf.sec; }
    else if (D.cur) {
      const n0 = D.cur.bars.length, r = D.cur.add(t, p, v), ch = r.changed;
      if (D.sync && D.sync.bar < 0) { if (D.sync.rs.step(t, p)) { D.sync.bar = n0; showRange(); } }   // the first proven range bar
      else for (let i = 0; i < ch.length; i++) chart.update(ch[i]);   // a finished range bar, phantom bars, the new bar
      barT = r.bar.t;
    }
    if (D.delta && !deltaFed) D.delta.add(t, v, m.s, barT, m.sm);   // one trade, one bar: never a rebuild per trade
    sigTrade(t, p, v, m.s, barT);                      // the chart signals (G1c): O(1) a trade, a step per bar close
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
    if (HOST && HT.account) return HT.account;                    // a host's chart: the host's order account (the workspace's ticket)
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
  // 1.14.0: Glide, Range style, grid lines and the room right of price changed in another tab or the workspace
  listen(window, 'storage', e => { if (e.key === PREFIX + LP.KEYS.settings) refreshSettings(); });
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
      const pos = tradeMode() ? TR.positions.get(acc + '|' + D.root) : HOST && HT.root === D.root ? HT.position : null;
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
    if (FEED) { openSocket(''); return; }               // the window's connection for this instrument (live/feed.js)
    let url;
    try { url = typeof WS_URL === 'function' ? WS_URL() : WS_URL; } catch (e) { scheduleReconnect(); return; }
    if (url && typeof url.then === 'function') url.then(u => { if (!destroyed && seq === connectSeq) openSocket(u); }, () => { if (!destroyed && seq === connectSeq) scheduleReconnect(); });
    else openSocket(url);
  }
  function openSocket(url) {
    lastUrl = url ? String(url) : '';
    let sock;
    try { sock = FEED ? FEED.open(S.root) : new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
    ws = sock;
    sock.onopen = () => { if (sock !== ws) return; wsTries = 0; everConnected = true; setStatus('', ''); };
    // the shared feed hands the message over parsed (once for every chart of the instrument)
    sock.onmessage = ev => { if (sock !== ws) return; let m = ev.message; if (!m) { try { m = JSON.parse(ev.data); } catch (e) { return; } } handle(m); };
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
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));   // order actions go through TradeCore, which counts them
  }
  function subscribe(root) {
    loadSeq++;
    if (root !== K.root) countReset(root);             // a new instrument: a new count; the same one keeps its count (round 5)
    else if (K.started) { countKeepBase(); K.gap = true; }   // and notes the seconds it misses (round 6)
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
  /* The shared feed's load can hold more than this chart asked for (another chart of the instrument needs ticks): the
     chart takes it as it is, as if it had asked for it (the tick hours, the served window, where the ticks begin). */
  function adoptLoad(l) {
    if (!l || typeof l !== 'object') return;
    D.tickHours = +l.tickHours > 0 ? +l.tickHours : 0;
    D.window = !!l.window && D.tickHours > 0;
    D.tickFrom = typeof l.tickFrom === 'number' && isFinite(l.tickFrom) ? l.tickFrom / 1000 + etOffset : Infinity;
  }

  function handle(m) {
    switch (m.type) {
      case 'hello':
        helloSeen = true;
        LIVE_FIRST = Array.isArray(m.features) && m.features.includes('liveFirst');
        PROFILE = Array.isArray(m.features) && m.features.includes('profile');
        instruments = {};
        for (const i of m.instruments || []) instruments[i.root] = i;
        readSettlements(m.instruments); readouts();
        $('lgSrc').textContent = 'NinjaTrader via ChartBridge ' + (m.version ? m.version + ' ' : '') + '· chart ' + CE.VERSION;
        bridgeVersion = typeof m.version === 'string' ? m.version : '';
        syncVersion();
        syncAccounts(m.accounts || []);
        subscribe(S.root);
        if (T) T.hello(m);                                 // protocol v2 (m.trading): sign in; ChartBridge 0.2 has no trading field
        break;
      case 'history':
        if (m.root !== D.root || stale(m)) return;
        if (m.load) adoptLoad(m.load);
        if (m.name) { D.name = m.name; $('lgName').textContent = m.name; }
        for (const b of m.bars) D.hist.push({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] });
        setStatus('Loading ' + D.root + ' history: ' + D.hist.length.toLocaleString() + ' minutes', '');
        break;
      case 'ticks':
        if (m.root !== D.root || stale(m)) return;
        if (m.load) adoptLoad(m.load);
        D.ticks.pushAll(m.ticks);
        // 0.3.4: [t, p, v, s, sm]. ChartBridge 0.3.5's served window sends [t, p, v] (no side) though its live trades carry
        // sides: then the first live trade says (onTick)
        if (D.sides === null && m.ticks && m.ticks.length && !D.window) { const x = m.ticks[0]; D.sides = typeof x[3] === 'number'; }
        setStatus('Loading ' + D.root + ' ticks: ' + D.ticks.length.toLocaleString(), '');
        break;
      case 'ready':
        if (m.root !== D.root || stale(m)) return;
        if (m.load) adoptLoad(m.load);
        setStatus('', '');
        onReady(m.readyAt);
        break;
      case 'profile':
        // with this load's id before its "ready"; without one when the table's backfill made it whole (only once live)
        if (m.root !== D.root || (m.sub !== undefined && m.sub !== null ? stale(m) : !D.ready)) return;
        onProfile(m);
        break;
      case 'tick': onTick(m); break;
      case 'settlement': if (typeof m.root === 'string') { settlements[m.root] = { p: typeof m.p === 'number' ? m.p : null, date: m.date || '' }; readouts(); } break;   // 0.3.7: the prior settlement changed
      case 'execs': for (const f of m.list || []) addFill(f); syncAccounts(); applyMarkers(); break;
      case 'exec': addFill(m); applyMarkers(); break;
      /* 1.13.0: a warning (for example a mistyped maxTicksAway in config.txt, which means NO limit) stays on screen
         until dismissed, as in the workspace; other notes go to the status line */
      case 'status': if (m.level === 'error') alertLoud(m.text); else if (m.level === 'warn' && m.text && !COMPACT) alertLoud(m.text, true); else setStatus(m.text, m.level); break;
    }
    if (T) T.message(m);                               // trading, orders, order, position, reject (live/trade.js)
  }

  /* ---------------- trading (protocol v2). The order logic is TradeCore's (live/trade.js, 1.12.0): the 1.11.0 code moved
     out of this file unchanged, so the workspace's order ticket calls the very same functions. None of it runs on a
     read-only chart (TRADING false); a chart mounted with `trade` (the workspace) hands its order clicks and drags to the
     host, which sends them through its own TradeCore (HOST, below). */
  const TC = window.TradeCore;
  const served = r => !Object.keys(instruments).length || !!instruments[r];
  /* Clickjacking guard: never trade from inside another page's frame (ChartBridge also sends X-Frame-Options DENY). */
  const FRAMED = (() => { try { return window.top !== window.self; } catch (e) { return true; } })();
  const FRAMED_REASON = 'This chart is inside another page (a frame), so it cannot trade. Open ' + location.href + ' directly in its own tab.';
  /* The last price: the chart's, or while a view loads the last one seen for the instrument (1.8.0: orders keep working). */
  const LAST_SEEN_MS = 10000;                           // review 3 N-2: an older price (another instrument's visit, a long load) is unknown
  const lastPrice = () => {
    if (D.m1 && D.m1.last) return D.m1.last.c;
    const x = lastSeen[D.root];
    return x && nowMs() - x.at < LAST_SEEN_MS ? x.p : null;
  };
  const qtyNow = () => Number($('oQty').value === '' ? NaN : +$('oQty').value);
  const tickOf = root => (instruments[root] && instruments[root].tick) || (root === D.root ? D.tick : 0) || 0.25;
  let BAR = null;                                        // the order bar's controls (TradeCore.wire), on the trading page
  const T = !TRADING ? null : TC.create({
    LP, prefs, pin: PIN, framed: FRAMED, framedReason: FRAMED_REASON, fetch: (u, o) => fetch(u, o),
    send: obj => ws.send(JSON.stringify(obj)), open: () => !!ws && ws.readyState === 1, sock: () => ws,
    root: () => D.root, lastPrice, qty: qtyNow, pickerAccount: () => $('oAcct').value, wantedAccount: () => viewAccount,
    tick: tickOf, served, fmt: p => U.fmtPrice(p, precisionOf()), flash, later, destroyed: () => destroyed,
    changed: () => renderTrading(), armed: armedUi,
    applied: (pick, cameOn) => { syncAccounts(); if (TR.enabled && TR.account && (cameOn || pick.missed)) accountNote(pick, cameOn); },
    lost: was => { if (was) lastOrderAccount = was; clearAccountNote(); },   // it named an account and "Armed is off" (review S2)
    syncAccounts: () => syncAccounts(), batch: () => { if (BAR) BAR.renderBatch(); }, unsent: () => { if (BAR) BAR.renderUnsent(); },
    positionChanged: () => applyMarkers(),
    confirmNoStop: (root, go) => askNoStop(root, go),
    dropNoStop: () => { if (noStopGo || !$('noStopAsk').hidden) closeNoStop(false); },
  });
  const TR = T ? T.TR : { v2: false, enabled: false, reason: '', accounts: [], maxQty: {}, signInStarted: false, armed: false, account: '', orders: new Map(), positions: new Map() };
  /* A host's chart (ChartLive.mount's `trade`, the workspace): the host says what to show (its order account's working
     orders and position on this chart's instrument) and whether the chart is live for orders (the ticket's instrument
     while Armed); the chart hands it Shift+click, Shift+right click, Ctrl+click, drags and the x. The host sends them
     through its TradeCore with every check, or forwards them to the window that has the ticket. The chart itself still
     sends only subscribe and ping. */
  const HOST = !TRADING && opt.trade && typeof opt.trade.place === 'function' && typeof opt.trade.move === 'function' && typeof opt.trade.cancel === 'function' ? opt.trade : null;
  const HT = { root: '', live: false, account: '', orders: [], position: null, pointValue: 0, qty: 1 };
  const armedHere = () => TRADING ? TR.armed : HT.live && HT.root === D.root;

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
  function clearAccountNote() { if (!TRADING) return; noteSeq++; $('oAcctNote').textContent = ''; $('oAcctNote').title = ''; $('oAcct').classList.remove('acct-flash', 'warn'); }
  function tradingLost(reason) { if (T) T.lost(reason); }

  /*
   * Selling by mouse button (1.10.0): Shift + right click, or Ctrl + left click, on the plot sells at the price, a limit
   * or a stop by the last price as with Shift+click. Only while Armed and with no drawing tool, never on an order's label
   * or tag (those drag or cancel the order), and only for a click that does not move; the keys must still be held at the
   * release. Such a press is kept from the chart (no pan, no drawing picked). Ctrl and Shift together send nothing. The
   * browser's menu never opens anywhere on the chart on this page (plot, price and time axes, delta pane). `lastUp`:
   * the keys of the last release, read by orderPlace. On a host's chart (the workspace) "Armed" is the host's: the chart
   * is live for orders.
   */
  const BOTH_KEYS = 'Ctrl and Shift together: nothing was sent. Shift+click buys; Shift+right click or Ctrl+click sells.';
  let lastUp = null;
  function setupSellClicks(sell) {
    const host = $('chart'), cv = host.querySelector('canvas');
    host.addEventListener('contextmenu', e => e.preventDefault());   // the whole chart: plot, axes, delta pane (Anthony 2026-10-01)
    if (!cv) return;
    const plotAt = e => {
      const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      return x >= 0 && x < r.width - AXIS_W && y >= 0 && y < chart.deltaPane().plotHeight ? { x, y } : null;
    };
    const inR = (r, pt) => !!r && pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h;
    const onOrder = pt => chart.orderHandles().some(h => inR(h.box, pt) || inR(h.xbox, pt) || inR(h.tag, pt));
    let press = null;
    host.addEventListener('pointerdown', e => {
      if (e.target !== cv || e.pointerType === 'touch') return;
      if (!((e.button === 0 && e.ctrlKey) || (e.button === 2 && e.shiftKey))) return;
      if (!armedHere() || chart.getTool()) return;
      const pt = plotAt(e);
      if (!pt || onOrder(pt)) return;
      e.stopPropagation();                                         // the chart never sees it: no pan, no drawing picked
      press = { id: e.pointerId, button: e.button, x: e.clientX, y: e.clientY, moved: false };
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }, true);
    host.addEventListener('pointermove', e => {
      if (press && e.pointerId === press.id && Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) > 2) press.moved = true;
    }, true);
    const up = e => {
      if (e.target === cv) lastUp = { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, button: e.button };
      if (!press || e.pointerId !== press.id) return;
      const pr = press; press = null;
      e.stopPropagation();
      if (e.type === 'pointercancel' || pr.moved) return;
      const pt = plotAt(e);
      if (!pt) return;
      if (!(pr.button === 0 ? e.ctrlKey : e.shiftKey)) return;    // let go of the key first: nothing, like Shift+click
      if (e.ctrlKey && e.shiftKey) { flash(BOTH_KEYS, 'warn'); return; }
      if (!armedHere()) return;
      sell(U.roundTo(chart.yToPrice(pt.y), D.tick));
    };
    host.addEventListener('pointerup', up, true);
    host.addEventListener('pointercancel', up, true);
  }

  /* NO STOP (1.13.0, Anthony): the first order with no stop after the page loads asks here, in the page; Send sends it
     (and no later one asks), Cancel or Escape sends nothing. A strip over the top of the chart (it takes no room, so
     the chart never resizes; F2 re-review), never modal (F2 review): the
     Flatten button, Close and Flatten all work while it is open and close it (dropNoStop), its order not sent. Cancel
     has the focus, so Enter never sends an order with no stop. */
  let noStopGo = null;
  function askNoStop(root, go) {
    noStopGo = go;
    $('noStopText').textContent = 'The ' + root + ' order has no stop (the bracket stop is 0). Send it anyway? Later orders with no stop go without asking until the page is loaded again.';
    // 1.14.0 (coordinator, layout only): under the legend, so the ARMED pill and the connection pill stay in view
    const lg = $('legend'), st = lg.parentElement;
    $('noStopAsk').style.setProperty('--ns-top', Math.round(lg.getBoundingClientRect().bottom - st.getBoundingClientRect().top + 6) + 'px');
    $('noStopAsk').hidden = false;
    $('noStopCancel').focus();
    return true;
  }
  function closeNoStop(send) {
    const go = noStopGo; noStopGo = null;
    if (document.activeElement && $('noStopAsk').contains(document.activeElement)) document.activeElement.blur();
    $('noStopAsk').hidden = true;
    if (send && go) go();
  }
  if (TRADING) {
    $('noStopSend').addEventListener('click', () => closeNoStop(true));
    $('noStopCancel').addEventListener('click', () => { closeNoStop(false); flash('Not sent: no stop. Set the bracket stop, or send again and choose Send.', 'warn'); });
    listen(document, 'keydown', e => { if (e.key === 'Escape' && !$('noStopAsk').hidden) { e.preventDefault(); closeNoStop(false); flash('Not sent: no stop.', 'warn'); } });
  }
  /* setArmed's page part: the switch, the bar, the chart's border and ARMED pill, order editing on the chart. */
  function armedUi(v) {
    const btn = $('armBtn');
    btn.setAttribute('aria-checked', String(v));
    $('armText').textContent = v ? 'ARMED: one click trades' : 'Armed off';
    $('obar').classList.toggle('armed', v);
    rootEl.classList.toggle('is-armed', v);
    $('armPill').hidden = !v;
    chart.setOrderEditing(v);
  }
  function syncTradeAccounts() { if (BAR) BAR.syncTradeAccounts(); }
  /* Order bar, order lines, position line; also run on every instrument switch and order message. */
  function renderTrading() {
    if (HOST) { renderHost(); return; }
    if (!TRADING || !TR.v2 || !BAR) return;
    BAR.render();
    const on = TR.enabled, root = D.root || S.root;
    // the tab title and the ARMED pill name the account (review S5): two tabs on two accounts are by design now
    if (PAGE) document.title = on && TR.account ? (TR.armed ? 'ARMED · ' : '') + root + ' · ' + TR.account + (TR.armed ? '' : ' · Live Chart') : 'Live Chart';
    $('armPill').textContent = 'ARMED' + (TR.account ? ' · ' + TR.account : '');
    $('statusRo').textContent = on ? 'Trading through ChartBridge. Live CME data is for this screen only.' : 'Read only. Orders are placed in NinjaTrader. Live CME data is for this screen only.';
    chart.setOrders(on ? T.chartOrders(TR.account, D.root) : []);   // with each resting entry's planned stop and target (0.3.8)
    const pos = on ? TR.positions.get(TR.account + '|' + root) : null;
    const inst = instruments[root] || {};
    chart.setPosition(pos && pos.qty ? pos : null, { pointValue: inst.pointValue || 0 });
  }
  /* A host's chart: its lines as the host said, only for the instrument it said them for (a switch clears them until the
     host speaks again); live for orders only then. */
  let hostLive = false;
  function renderHost() {
    const mine = !!HT.root && HT.root === D.root;
    const live = mine && HT.live;
    if (live !== hostLive) { hostLive = live; rootEl.classList.toggle('is-armed', live); chart.setOrderEditing(live); }
    chart.setOrders(mine ? HT.orders : []);
    chart.setPosition(mine && HT.position && HT.position.qty ? HT.position : null, { pointValue: HT.pointValue });
  }
  /** For the host: { root, live, account, orders, position, pointValue, qty }; null clears. */
  function setTrade(t) {
    if (!HOST || destroyed) return;
    const x = t && typeof t === 'object' ? t : {};
    HT.root = typeof x.root === 'string' ? x.root : '';
    HT.live = !!x.live;
    HT.orders = Array.isArray(x.orders) ? x.orders : [];
    HT.position = x.position && +x.position.qty ? x.position : null;
    HT.pointValue = +x.pointValue || 0;
    HT.qty = Number.isInteger(x.qty) ? x.qty : 1;
    const acct = typeof x.account === 'string' ? x.account : '';
    const acctNew = acct !== HT.account;
    HT.account = acct;
    renderHost();
    if (acctNew) syncAccounts(); else applyMarkers();
  }

  /* ---------------- UI */
  function setConn(state) {
    const pill = $('connPill');
    const map = { connecting: ['CONNECTING', ''], loading: ['LOADING', ''], live: ['LIVE', 'live'], offline: ['OFFLINE', 'bad'] };
    const [text, cls] = map[state] || map.connecting;
    pill.textContent = text; pill.className = 'pill' + (cls ? ' ' + cls : '');
    syncVersion();
    if (onStatus) { try { onStatus({ state: map[state] ? state : 'connecting', paneId: PANE, root: D.root || S.root, attempt: wsTries }); } catch (e) { setTimeout(() => { throw e; }); } }
  }
  /* 1.14.0 (Anthony): the versions, quietly: the LIVE pill's tooltip and the foot of Settings */
  const versionText = () => 'chart ' + CE.VERSION + ' · ChartBridge ' + (bridgeVersion || '-');
  function syncVersion() {
    const t = versionText();
    put($('connPill'), 'title', t);
    if ($('setVer')) put($('setVer'), 'textContent', t);
  }
  function setStatus(text, level) { clearTimeout(flashTimer); const el = $('statusMsg'); el.textContent = text || ''; el.className = 'msg' + (level ? ' ' + level : ''); syncNote(); }
  /* compact (a host's small panel): the status line shows only while it carries a note (live.css .has-note) */
  let noteOn = false;
  function syncNote() {
    if (!COMPACT) return;
    const on = !!$('statusMsg').textContent || ['ibNote', 'vpNote', 'rangeNote'].some(k => !$(k).hidden && !!$(k).textContent);
    if (on !== noteOn) { noteOn = on; rootEl.classList.toggle('has-note', on); }
  }
  /* Error-level status from ChartBridge (for example a bracket leg rejected: the position may have no stop) stays
     on screen until dismissed. The newest three are kept. */
  const alerts = [];
  let alertErr = false;
  function alertLoud(text, warn) {
    alerts.push(new Date().toLocaleTimeString() + '  ' + text); while (alerts.length > 3) alerts.shift();
    if (!warn) alertErr = true;
    $('alertText').textContent = alerts.join('\n'); $('alertBar').hidden = false;
    $('alertBar').classList.toggle('warn', !alertErr);                // red once an error is in it
  }
  $('alertClose').addEventListener('click', () => { alerts.length = 0; alertErr = false; $('alertBar').hidden = true; });
  /* Order messages show for a while, then clear (errors stay longer). */
  let flashTimer = 0;
  function flash(text, level) { setStatus(text, level); const t = text; flashTimer = setTimeout(() => { if ($('statusMsg').textContent === t) setStatus('', ''); }, level === 'error' ? 12000 : 6000); }
  function showNotice(title, text) { $('noticeTitle').textContent = title; $('noticeText').textContent = text; $('notice').hidden = false; }

  let legendKey = '';
  chart.on('legend', e => {
    if (!!e.hovering !== lgHover) { lgHover = !!e.hovering; rootEl.classList.toggle('lg-hover', lgHover); }   // the short header's hover line (1.14.0)
    vpLegend();
    legendBarT = e.hovering ? e.bar.t : null; deltaLegend();
    const { bar: b, prev, forming } = e;
    const key = [b.t, b.o, b.h, b.l, b.c, b.v, forming, S.tf, S.layers.vwap, S.options.vwap.session, vwapVer].join('|');
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
    const vwv = vwapFor(b, e.index);                    // 1.14.0: the session's, or RTH only (the VWAP gear)
    $('lgVw').textContent = vwv !== undefined && vwv !== null ? fmt(U.roundTo(vwv, D.tick)) : '-';   // null: not known yet (served window), or outside RTH
  });
  chart.on('drawings', list => store.set(drawingsKey(D.root), list));

  /* ---------------- readouts (1.14.0, Anthony's item 5), in the legend: the time left in the bar (Range bars: the ticks
     left up and down), the ATR of the chart's own closed bars (ATR_PERIOD, NinjaTrader's ATR) and the last price's change
     from the prior settlement (ChartBridge 0.3.7: hello and "settlement"; blank when ChartBridge gives none, never
     estimated). Once a second, on the second, and when the view or ChartBridge's settlement changes; never on the tick path. */
  const ATR_PERIOD = 14;
  const settlements = {};                                // root -> { p, date } from ChartBridge
  function readSettlements(list) { for (const i of list || []) if (i && typeof i.root === 'string') settlements[i.root] = { p: typeof i.settlement === 'number' ? i.settlement : null, date: i.settlementDate || '' }; }
  function readouts() {
    if (destroyed) return;
    const b = D.ready ? chart.lastBar() : null, dp = precisionOf();
    let bar = '';
    if (b) {
      if (S.tf === 'range') { const r = D.cur && D.cur.rangeLeft(); bar = r ? 'Bar ▲' + r.up + ' ▼' + r.down + 't' : ''; }
      else bar = 'Bar ' + U.barRemain(b.t, TF[S.tf].sec, etNow());
    }
    put($('lgBar'), 'textContent', bar); put($('lgBar'), 'hidden', !bar);
    const a = b ? chart.atr(ATR_PERIOD) : null, at = a === null ? '' : 'ATR(' + ATR_PERIOD + ') ' + U.fmtPrice(U.roundTo(a, Math.pow(10, -dp)), dp);
    put($('lgAtr'), 'textContent', at); put($('lgAtr'), 'hidden', !at);
    const st = settlements[D.root], pct = b && st ? U.pctFrom(b.c, st.p) : null, el = $('lgSet');
    const txt = pct === null ? '' : (pct >= 0 ? '+' : '') + pct.toFixed(2) + '% vs settle';
    put(el, 'textContent', txt); put(el, 'hidden', !txt);
    put(el, 'className', 'lg-ro' + (pct > 0 ? ' up' : pct < 0 ? ' down' : ''));
  }
  later(() => { readouts(); every(readouts, 1000); }, 1000 - Date.now() % 1000 + 5);   // on the second, as the price tag's countdown

  /* The VWAP gear's hours (1.14.0, Anthony): the session's from 18:00 ET (each bar's own vw, as always) or RTH only, from
     09:30 to 16:00 ET, worked out from the 1-minute bars (every view holds them) as the session's is from history, and
     read at each bar's end (a bar ending outside RTH has none, so the line breaks). Made again once a second while it
     is on (a few thousand bars, never per trade) and with the bars. */
  let vwapSeries = null, vwapVer = 0;
  function barEnd(b, i) {
    const bs = chart.bars(), now = etNow();
    if (S.tf === 'range') return i >= 0 && i < bs.length - 1 ? bs[i + 1].t : now;
    return Math.min(b.t + TF[S.tf].sec, now);
  }
  function vwapFor(b, i) {
    if (S.options.vwap.session !== 'rth') return b.vw;
    return vwapSeries ? U.vwapAt(vwapSeries, barEnd(b, i)) : null;
  }
  function vwapApply() {
    if (S.options.vwap.session === 'rth' && D.m1 && D.m1.bars.length) {
      vwapSeries = U.rthVwap(D.m1.bars, { sessionStart: SESSION }); vwapVer++;
      chart.setVwapSource((t, i) => { const bs = chart.bars(); return bs[i] ? U.vwapAt(vwapSeries, barEnd(bs[i], i)) : null; });
    } else { vwapSeries = null; chart.setVwapSource(null); }
  }
  every(() => { if (S.options.vwap.session === 'rth' && S.layers.vwap) vwapApply(); }, 1000);
  /* the developing POC, VAH and VAL lines (1.14.0, the VP gear) */
  function profileLines() { const o = S.options.vp; chart.setProfileLines({ poc: o.dpoc === 'on', vah: o.dvah === 'on', val: o.dval === 'on' }); }
  profileLines();

  /* The header text (1.14.0, Anthony): switched off per chart (live-legend-v1, the Aa toggle beside Indicators): no text at
     all, not even on hover, and the price scale takes the room back. A small panel (a compact chart under 700 px wide or
     400 px tall) shows a short header: one quiet line (the name, bars, last price and change, the indicators' values),
     the bar's open, high, low and volume (and the hovered bubble) on a second line only while the crosshair is over it. */
  let lgHover = false, lgOn = prefs.legendShown(PANE);
  function applyLegendShown() {
    rootEl.classList.toggle('lg-off', !lgOn);
    const b = $('lgTog');
    b.setAttribute('aria-pressed', String(lgOn));
    b.title = 'Header text on this chart: ' + (lgOn ? 'on (click to turn it off)' : 'off (click to turn it on)');
    fitTop();
  }
  function setLegendShown(on) { lgOn = !!on; prefs.setLegendShown(PANE, lgOn); applyLegendShown(); }
  $('lgTog').addEventListener('click', () => setLegendShown(!lgOn));
  listen(window, 'storage', e => { if (e.key === PREFIX + LP.KEYS.legend) { const v = prefs.legendShown(PANE); if (v !== lgOn) { lgOn = v; applyLegendShown(); } } });
  function shortHeader() {
    if (!COMPACT) return;
    const r = rootEl.getBoundingClientRect(), sh = r.width < 700 || r.height < 400;
    if (rootEl.classList.contains('short') !== sh) rootEl.classList.toggle('short', sh);
  }
  if (COMPACT && typeof ResizeObserver === 'function') { const ro2 = new ResizeObserver(shortHeader); ro2.observe(rootEl); cleanups.push(() => ro2.disconnect()); }

  /* The bubble under the mouse (1.14.0, Anthony from WORK: no numbers on the chart, the size on hover), in the legend's
     top line: "Bubble Buy 142 @ 31,120.25 08:44:05.3". The chart hit-tests on mouse moves only. */
  const two = n => (n < 10 ? '0' : '') + n;
  const fmtTenths = t => { const sec = U.tod(t), w = Math.floor(sec); return two(Math.floor(w / 3600)) + ':' + two(Math.floor(w / 60) % 60) + ':' + two(w % 60) + '.' + Math.floor((sec - w) * 10 + 1e-6); };
  chart.on('bubble', b => {
    const el = $('lgBub');
    if (!b) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = 'Bubble ' + (b.side > 0 ? 'Buy ' : 'Sell ') + U.fmtVolume(Math.round(b.v)) + ' @ ' + U.fmtPrice(U.roundTo(b.p, D.tick), precisionOf()) + ' ' + fmtTenths(b.t);
    el.className = 'lg-bub ' + (b.side > 0 ? 'up' : 'down');
    el.hidden = false;
  });
  /* The price scale keeps the legend's height free at its top (1.14.0, Anthony: on the smaller panels the high ran under
     the legend's lines), eased in with the 120 ms re-fit; told again whenever the legend's height changes. */
  /* (the hover line of a short header is left out: the scale does not jump as the mouse comes and goes; with the header
     text off there is nothing to keep free) */
  const fitTop = () => { const lg = $('legend'); if (!lg || destroyed || lgHover) return; chart.setFitTop(lgOn && lg.offsetHeight ? lg.offsetTop + lg.offsetHeight + 8 : 0); };   // 8 px: the eased re-fit never brings a new high into the header
  if (typeof ResizeObserver === 'function') { const ro = new ResizeObserver(fitTop); ro.observe($('legend')); cleanups.push(() => ro.disconnect()); }
  applyLegendShown(); shortHeader();
  /* A drawing error (1.5.1): the chart keeps running; say so on the status line until a clean frame clears it. */
  const DRAW_ERR = 'Chart drawing error: ';
  chart.on('error', e => {
    if (e) setStatus(DRAW_ERR + e.message + '. The chart keeps running; reload the page if this stays.', 'error');
    else if ($('statusMsg').textContent.startsWith(DRAW_ERR)) setStatus('', '');
  });
  /* the delta pane's height, dragged or keyed on its divider: saved per pane when the move ends (1.7.0) */
  chart.on('paneResize', e => { if (e && e.done) prefs.setPaneHeight(PANE, 'delta', e.ratio); });
  chart.on('tool', t => { $('toolTrend').setAttribute('aria-pressed', String(t === 'trend')); $('toolHline').setAttribute('aria-pressed', String(t === 'hline')); });

  let PR = null;                                         // the preset groups in the Colors panel, below (1.9.0)
  /* onColors (a host's other charts follow): only for a change made here, never for the start or a refreshColors() */
  let colorsLive = false, colorsQuiet = false;
  const colorsChanged = () => { if (onColors && colorsLive && !colorsQuiet) { try { onColors(); } catch (e) { setTimeout(() => { throw e; }); } } };
  const presetStore = opt.presetStore && typeof opt.presetStore.list === 'function' ? opt.presetStore
    : LP.localPresetStore(prefixedStorage((() => { try { return window.localStorage; } catch (e) { return null; } })(), PREFIX));
  const themePanel = CE.mountThemePanel(chart, $('colorsHost'), {
    storageKey: PREFIX + 'live-colors-v1', vwap: false,
    note: presetStore.shared ? 'Presets are shared by every PC. The colors in use are saved in this browser.' : 'Colors and presets are saved in this browser only.',
    onChange: () => { paintColors(); if (PR) renderPresets(); colorsChanged(); },
  });
  /* The page's colors from the chart's theme and the indicator colors: the legend, the swatches, and on any ground but
     the default the toolbar, the order bar, the menus and the status line (chromeColors). Once per change. */
  function paintColors() {
    const T = chart.colors(), st = rootEl.style;
    st.setProperty('--vwap-sw', T.vwapText); st.setProperty('--up-text', T.upText); st.setProperty('--down-text', T.downText);
    // the legend sits on the chart, so it follows the chart's ground (1.5.3)
    st.setProperty('--chart-bg', T.bg); st.setProperty('--lg-bg', T.legendBg); st.setProperty('--lg-head', T.tagText);
    st.setProperty('--lg-text2', T.text2); st.setProperty('--lg-dim', T.axisText); st.setProperty('--lg-buy', T.long); st.setProperty('--lg-sell', T.short);
    // buy and sell keep their green and red; where they do not read on the ground, a halo in the house ink (1.5.3)
    const halo = ink => ink ? '0 0 2px ' + ink + ', 0 0 1px ' + ink + ', 0 0 1px ' + ink : 'none';
    st.setProperty('--lg-buy-halo', halo(T.halo.long)); st.setProperty('--lg-sell-halo', halo(T.halo.short));
    rootEl.dataset.ground = T.ground;
    // the toolbar, the order bar, menus and status line match the chart's ground (Anthony: 1.5.3 a light one, 1.9.0 every
    // one); the default ground keeps the house style exactly
    const chrome = U.chromeColors(T);
    for (const k of U.CHROME_VARS) { if (chrome) st.setProperty(k, chrome[k]); else st.removeProperty(k); }
    // menu swatches sit on the page chrome: the indicator colors, moved to read there on a light one
    const onChrome = c => chrome ? U.markOnGround(c, chrome['--bg'], CE.FLOOR.text, T.to) : c;
    st.setProperty('--ib-sw', onChrome(IC.ibHigh));
    st.setProperty('--vp-sw', onChrome(IC.vpPoc));
    st.setProperty('--vp-poc', T.vpPocText);                      // the legend's POC, on the chart ground
    st.setProperty('--delta-sw', T.upText);                       // the delta pane's swatch: the bull candle color, readable here
    st.setProperty('--sig-bull', onChrome(T.sigBull)); st.setProperty('--sig-bear', onChrome(T.sigBear));   // the signals (G1c)
    deltaLegendKey = '';
    legendKey = '';
    // a host's slim header holds the Indicators menu and the chips outside this element: their swatches follow too
    if (SLIM) for (const el of [$('indWrap'), $('indChips')]) for (const k of ['--vwap-sw', '--up-text', '--down-text', '--ib-sw', '--vp-sw', '--delta-sw', '--vp-poc', '--sig-bull', '--sig-bear']) el.style.setProperty(k, st.getPropertyValue(k));
  }

  /*
   * Color presets (1.9.0, Anthony: "Bar colors and chart color should be a preset. Indicator colors should have their
   * own preset group"). Two groups in the Colors panel: chart presets (bull, bear and the chart background) and
   * indicator presets (every indicator color, each set in its gear). Pick one to use it; save the colors in use under a
   * name (a name already there replaces that preset); rename; delete, after a second click. The presets come from
   * presetStore; the colors in use stay this browser's (live-colors-v1, live-indicator-colors-v1).
   * A chart preset can remember one indicator preset (1.9.0, Anthony: "link the groups"): the chart group's save row has
   * "Indicator colors: None / <each indicator preset>", set at first to the indicator preset holding the colors in use
   * (else None). The chart preset keeps that preset's id; picking it applies both. A save never makes or changes an
   * indicator preset, and a re-save sets the link only as the select says. A link to one deleted since is ignored.
   */
  const PR_GROUPS = [
    { g: 'chart', title: 'Chart presets', hint: 'Bar colors and the chart background.', place: 'Name this chart look' },
    { g: 'indicator', title: 'Indicator presets', hint: 'Every indicator\'s colors, set in its gear in the Indicators menu.', place: 'Name these indicator colors' },
  ];
  const PR_SVG = {
    edit: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M2 10l.6-2.4L8.2 2 10 3.8 4.4 9.4z"/></svg>',
    x: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8"/></svg>',
  };
  // indSel: the save row's indicator preset as chosen by hand ('' None, an id), or null to follow the colors in use
  PR = { lists: { chart: [], indicator: [] }, note: { chart: '', indicator: '' }, edit: null, confirm: null, indSel: null };
  const prCurrent = g => { if (g !== 'chart') return Object.assign({}, IC); const c = themePanel.get(); return { up: c.up, down: c.down, bg: c.bg }; };
  const prSame = (g, colors) => { const cur = prCurrent(g); return LP.PRESET_GROUPS[g].every(k => cur[k] === colors[k]); };
  const prSwatch = (g, c) => g === 'chart'
    ? `<span class="pr-sw" style="background:${c.bg}" aria-hidden="true"><i style="background:${c.up}"></i><i style="background:${c.down}"></i></span>`
    : `<span class="pr-sw pr-sw-ind" aria-hidden="true">${['vwap', 'prior', 'ibHigh', 'vpPoc'].map(k => `<i style="background:${c[k]}"></i>`).join('')}</span>`;
  const prSel = f => '[data-f="' + CSS.escape(f) + '"]';
  themePanel.slot.innerHTML = PR_GROUPS.map(G => `<div class="pr-group" data-g="${G.g}" role="group" aria-labelledby="${p}pr-${G.g}">` +
    `<div class="ce-lbl" id="${p}pr-${G.g}">${G.title}</div><div class="ce-note">${G.hint}</div><div class="pr-list"></div>` +
    `<div class="pr-save"><input type="text" class="pr-name-in" maxlength="${LP.PRESET_NAME_MAX}" placeholder="${G.place}" aria-label="${G.place}" spellcheck="false" autocomplete="off">` +
    `<button type="button" class="pr-btn" data-act="save">Save</button></div>` +
    (G.g === 'chart' ? `<label class="pr-inc"><span>Indicator colors</span><select class="pr-ind" data-f="ind" title="The indicator preset this chart preset brings with it"></select></label>` : '') +
    `<div class="pr-note" role="status"></div></div>`).join('');

  function prRow(g, pr) {
    const name = esc(pr.name), id = esc(pr.id);
    if (PR.edit && PR.edit.g === g && PR.edit.id === pr.id)
      return `<div class="pr-row is-edit" data-id="${id}"><input type="text" class="pr-edit" data-f="edit:${id}" value="${esc(PR.edit.text)}" maxlength="${LP.PRESET_NAME_MAX}" aria-label="New name for ${name}" spellcheck="false" autocomplete="off">` +
        `<button type="button" class="pr-btn" data-act="rename-ok" data-f="renok:${id}">Save</button><button type="button" class="pr-btn quiet" data-act="cancel" data-f="cancel:${id}">Cancel</button></div>`;
    if (PR.confirm && PR.confirm.g === g && PR.confirm.id === pr.id)
      return `<div class="pr-row is-confirm" data-id="${id}"><span class="pr-ask">Delete ${name}?</span>` +
        `<button type="button" class="pr-btn bad" data-act="delete-ok" data-f="delok:${id}">Delete</button><button type="button" class="pr-btn quiet" data-act="cancel" data-f="cancel:${id}">Keep</button></div>`;
    const ip = prLinked(pr), use = 'Use ' + name + (ip ? ', with the indicator preset ' + esc(ip.name) : '');
    return `<div class="pr-row" data-id="${id}"><button type="button" class="pr-pick" data-act="pick" data-f="pick:${id}" aria-pressed="${prSame(g, pr.colors)}" title="${use}">${prSwatch(g, pr.colors)}<span class="pr-n">${name}</span></button>` +
      `<button type="button" class="pr-ic" data-act="rename" data-f="ren:${id}" aria-label="Rename ${name}" title="Rename">${PR_SVG.edit}</button>` +
      `<button type="button" class="pr-ic" data-act="delete" data-f="del:${id}" aria-label="Delete ${name}" title="Delete">${PR_SVG.x}</button></div>`;
  }
  /* Save, or Replace when the name typed is a preset's already */
  function prLabel(box) {
    const n = LP.presetName(box.querySelector('.pr-name-in').value).toLowerCase(), save = box.querySelector('[data-act="save"]');
    const same = n ? PR.lists[box.dataset.g].find(x => x.name.toLowerCase() === n) : null;
    save.textContent = same ? 'Replace' : 'Save';
    save.title = same ? 'Replace ' + same.name + ' with the colors in use' : 'Save the colors in use as a preset';
  }
  function renderPresets() {
    for (const box of themePanel.slot.querySelectorAll('.pr-group')) {
      const g = box.dataset.g, a = document.activeElement, focus = a && box.contains(a) ? a.dataset.f : null;
      box.querySelector('.pr-list').innerHTML = PR.lists[g].length ? PR.lists[g].map(pr => prRow(g, pr)).join('') : '<div class="pr-empty">None saved yet.</div>';
      box.querySelector('.pr-note').textContent = PR.note[g];
      prLabel(box);
      const sel = box.querySelector('.pr-ind');
      if (sel) {
        const opts = '<option value="">None</option>' + PR.lists.indicator.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
        if (sel.dataset.opts !== opts) { sel.innerHTML = opts; sel.dataset.opts = opts; }
        const held = PR.lists.indicator.find(x => prSame('indicator', x.colors));
        const chosen = PR.indSel !== null && (PR.indSel === '' || PR.lists.indicator.some(x => x.id === PR.indSel));
        sel.value = chosen ? PR.indSel : held ? held.id : '';
      }
      if (focus && !box.contains(document.activeElement)) (box.querySelector(prSel(focus)) || box.querySelector('.pr-name-in')).focus();
    }
  }
  const prFocusRow = (box, id) => { const b = box.querySelector(prSel('pick:' + id)); (b || box.querySelector('.pr-name-in')).focus(); };
  /* One store call: the lists it returns, cleaned first (a shared store hands over what another PC wrote: presets of a
     bad shape, a bad color or no name are left out), and a note (what was done, or why it was refused). */
  const prName = r => (r && r.preset && LP.presetName(r.preset.name)) || 'the preset';
  function prRun(g, call, said) {
    return Promise.resolve(call).then(r => { PR.lists = LP.cleanPresets(r && r.lists); PR.note[g] = said(r || {}); },
      e => {                                                    // refused: nothing was written; list what the store holds
        PR.note[g] = e && e.message ? String(e.message) : 'Not saved.';
        return presetStore.list().then(lists => { PR.lists = LP.cleanPresets(lists); }, () => {});
      })
      .then(() => { if (!destroyed) renderPresets(); });
  }
  /* a chart preset's indicator preset, while it is still there */
  const prLinked = pr => pr.ind ? PR.lists.indicator.find(x => x.id === pr.ind) || null : null;
  function prSave(box) {
    const g = box.dataset.g, input = box.querySelector('.pr-name-in'), sel = box.querySelector('.pr-ind');
    const ind = g === 'chart' && sel && sel.value ? PR.lists.indicator.find(x => x.id === sel.value) || { id: sel.value } : null;
    prRun(g, presetStore.save(g, input.value, prCurrent(g), ind ? ind.id : undefined), r => {
      input.value = ''; PR.indSel = null;
      return (r.replaced ? 'Replaced ' : 'Saved ') + prName(r) + (ind && ind.name ? ', with the indicator preset ' + ind.name : '') + '.';
    });
  }
  function prRename(box, pr) {
    const g = box.dataset.g;
    prRun(g, presetStore.rename(g, pr.id, PR.edit ? PR.edit.text : ''), r => { PR.edit = null; return 'Renamed to ' + r.preset.name + '.'; })
      .then(() => { if (!PR.edit) prFocusRow(box, pr.id); });
  }
  function prPick(g, pr) {
    PR.note[g] = 'Using ' + pr.name + '.';
    if (g === 'chart') {
      const ip = prLinked(pr);                                      // its indicator preset too, when it is still there
      if (ip) { PR.note.chart = 'Using ' + pr.name + ', with ' + ip.name + '.'; PR.note.indicator = 'Using ' + ip.name + '.'; setIndicatorColors(ip.colors); }
      themePanel.set({ up: pr.colors.up, down: pr.colors.down, bg: pr.colors.bg });   // painted and listed again by onChange
      return;
    }
    setIndicatorColors(pr.colors);
    renderPresets();
  }
  const prRefresh = () => presetStore.list().then(lists => { PR.lists = LP.cleanPresets(lists); }, e => {
    PR.note.chart = PR.note.indicator = 'Presets not reachable' + (e && e.message ? ': ' + e.message : '.');
  }).then(() => { if (!destroyed) renderPresets(); });
  themePanel.slot.addEventListener('click', e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const box = b.closest('.pr-group'), g = box.dataset.g, row = b.closest('.pr-row'), id = row ? row.dataset.id : null;
    const pr = id ? PR.lists[g].find(x => x.id === id) : null, act = b.dataset.act;
    PR.note[g] = '';
    if (act === 'save') { prSave(box); return; }
    if (act === 'cancel') { PR.edit = PR.confirm = null; renderPresets(); prFocusRow(box, id); return; }
    if (!pr) { renderPresets(); return; }
    if (act === 'pick') prPick(g, pr);
    else if (act === 'rename') {
      PR.edit = { g, id, text: pr.name }; PR.confirm = null; renderPresets();
      const inp = box.querySelector('.pr-edit'); if (inp) { inp.focus(); inp.select(); }
    } else if (act === 'rename-ok') prRename(box, pr);
    else if (act === 'delete') { PR.confirm = { g, id }; PR.edit = null; renderPresets(); const k = box.querySelector('[data-act="delete-ok"]'); if (k) k.focus(); }
    else if (act === 'delete-ok') { PR.confirm = null; prRun(g, presetStore.remove(g, id), () => 'Deleted ' + pr.name + '.').then(() => box.querySelector('.pr-name-in').focus()); }
  });
  themePanel.slot.addEventListener('input', e => {
    const t = e.target;
    if (t.classList.contains('pr-ind')) PR.indSel = t.value;
    else if (t.classList.contains('pr-name-in')) prLabel(t.closest('.pr-group'));
    else if (t.classList.contains('pr-edit') && PR.edit) PR.edit.text = t.value;
  });
  /* Enter saves; Escape leaves a rename or a delete question without closing the panel */
  themePanel.slot.addEventListener('keydown', e => {
    const t = e.target, box = t.closest && t.closest('.pr-group'); if (!box) return;
    const row = t.closest('.pr-row'), id = row ? row.dataset.id : null;
    if (e.key === 'Enter' && t.classList.contains('pr-name-in')) { e.preventDefault(); prSave(box); }
    else if (e.key === 'Enter' && t.classList.contains('pr-edit')) {
      e.preventDefault();
      const pr = PR.lists[box.dataset.g].find(x => x.id === id); if (pr) prRename(box, pr);
    } else if (e.key === 'Escape' && row && (row.classList.contains('is-edit') || row.classList.contains('is-confirm'))) {
      e.preventDefault(); e.stopPropagation();
      PR.edit = PR.confirm = null; renderPresets(); prFocusRow(box, id);
    }
  });
  themePanel.element.querySelector('.ce-theme-btn').addEventListener('click', () => {
    if (!themePanel.isOpen()) return;
    PR.edit = PR.confirm = null; PR.note.chart = PR.note.indicator = ''; PR.indSel = null;
    prRefresh();                                              // another tab (or PC) may have changed them
  });
  prRefresh();

  /* Indicator colors (1.9.0): set in the gears and by an indicator preset; saved one change at a time, read fresh. */
  function setIndicatorColors(colors) {
    const set = LP.cleanColors(colors, LP.IND_COLOR_KEYS);
    if (!Object.keys(set).length) return;
    IC = Object.assign({}, IC, set);
    prefs.setIndicatorColors(set);
    applyIndicatorColors();
    if (PR && themePanel.isOpen()) renderPresets();
    colorsChanged();
  }

  function syncButtons() {
    for (const b of $('symSeg').children) b.setAttribute('aria-pressed', String(b.dataset.v === S.root));
    for (const b of $('tfSeg').children) b.setAttribute('aria-pressed', String(b.dataset.v === S.tf));
    for (const b of $('glideSeg').children) b.setAttribute('aria-pressed', String(b.dataset.v === S.glide));
    if ($('gridSeg')) for (const b of $('gridSeg').children) b.setAttribute('aria-pressed', String(b.dataset.v === S.grid));
    if ($('roomSeg')) for (const b of $('roomSeg').children) b.setAttribute('aria-pressed', String(+b.dataset.v === S.room));
    syncIndicators();
    $('rangeBox').hidden = S.tf !== 'range';
    if (document.activeElement !== $('rangeTicks')) $('rangeTicks').value = ranges[S.root];
    $('rangeTicks').setAttribute('aria-label', 'Range bar size for ' + S.root + ' in ticks');
    $('rangeMode').value = S.rangeMode;
  }
  $('symSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.dataset.v === S.root) return;
    S.root = b.dataset.v; saveSetting('root'); syncButtons();
    if (TR.armed) { T.setArmed(false); flash('Armed turned off: the instrument changed.', 'warn'); }
    subscribe(S.root);
    viewChanged();
  });
  $('tfSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.dataset.v === S.tf) return;
    S.tf = b.dataset.v; saveSetting('tf'); syncButtons();
    if (ticksMissing()) subscribe(S.root);      // the tick backfill does not reach back far enough for this view: fetch it
    else rebuild();
    viewChanged();
  });

  /* Range size, per root. The chart rebuilds only when the size is committed (Enter, the arrows, or leaving the box),
     never on a half-typed number (a slow "1" on the way to "12"). While typing, a whole number 1 to 400 is saved a
     moment after the last key, so a reload keeps it; anything else ("450", empty) drops that and puts the committed
     size back in storage. A page closed or reloaded mid-typing saves the box with the same rule as Enter
     (450 becomes 400), never a stale prefix. */
  let rangeTyped = null;                                   // { root, n }: typed, saved, not committed
  const rangeTypedSave = LP.debounce(() => { if (rangeTyped) saveRange(rangeTyped.root, rangeTyped.n); }, 350);
  function rangeTypedDrop() {
    rangeTypedSave.cancel();
    if (rangeTyped) { saveRange(rangeTyped.root, ranges[rangeTyped.root]); rangeTyped = null; }
  }
  function commitRange(root, n) {                          // n from clampRange; null puts the committed size back
    rangeTypedSave.cancel(); rangeTyped = null;
    if (n === null) { saveRange(root, ranges[root]); return false; }
    saveRange(root, n);
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
    if (changed) viewChanged();
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
  /* grid lines and the room right of price (1.14.0, the page's Settings; the workspace's Settings for its charts) */
  if ($('gridSeg')) $('gridSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !LP.GRIDS.includes(b.dataset.v)) return;
    S.grid = b.dataset.v; chart.setGrid(S.grid === 'on'); saveSetting('grid'); syncButtons();
  });
  if ($('roomSeg')) $('roomSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !LP.ROOMS.includes(+b.dataset.v)) return;
    S.room = +b.dataset.v; chart.setRoom(S.room); saveSetting('room'); syncButtons();
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
      if (k === 'fills') applyMarkers(); else chart.setLayers(k === 'levels' ? { levels: drawn[k], ib: drawn[k] } : { [k]: drawn[k] });   // the IB is Levels' (1.14.0)
      if (k === 'levels') ibNote(D.ib);
      if (k === 'vp') vpBuild();                                   // built from the tick store when shown, dropped when not
    }
    // the delta pane (1.7.0): kept while on the chart, shown or hidden, so the chip or the switch shows it at once
    // (review S5); made from the store when it comes onto the chart, never with a reload (round 4)
    if (deltaWanted() && !D.delta && !deltaBuilding()) deltaStart();
    else if (!IS.ind.delta.on && (D.delta || deltaBuilding())) deltaStop();
    else { deltaView(); deltaLegend(true); }
    sigApply();                                                    // the chart signals (G1c): made when added, dropped when off
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
      : (on && !d.nochip ? `<button type="button" class="ind-ic ind-pin" data-act="pin" data-id="${d.id}" data-f="pin:${d.id}" aria-pressed="${pinned}" aria-label="${pinned ? 'Unpin ' + name + ' from' : 'Pin ' + name + ' to'} the chip strip" title="${pinned ? 'Unpin from' : 'Pin to'} the chip strip">${SVG.pin}</button>`
        : on ? '<span class="ind-ic-sp" aria-hidden="true" title="No chip: it stays off the strip"></span>' : '') +
        `<button type="button" class="ind-ic" data-act="gear" data-id="${d.id}" data-f="gear:${d.id}" aria-expanded="${open}"${open ? ` aria-controls="${setId}"` : ''} aria-label="${name} settings" title="Settings">${SVG.gear}</button>`;
    const x = on ? `<button type="button" class="ind-ic" data-act="remove" data-id="${d.id}" data-f="x:${d.id}" aria-label="Take ${name} off this chart" title="Take off this chart">${SVG.x}</button>` : '';
    const set = open && !coming ? `<div class="ind-set" id="${setId}" data-id="${d.id}"><div class="ind-set-line"><span class="ind-set-sw" style="--sw: ${d.sw}" aria-hidden="true"></span><span class="ind-set-t">${esc(d.opt)}</span></div>${optionsHtml(d.id)}${signalsHtml(d.id)}${colorsHtml(d.id)}</div>` : '';
    return `<div class="ind-item${coming ? ' is-coming' : ''}${shown ? ' is-shown' : ''}" data-id="${d.id}"><div class="ind-row">${lead}` +
      `<span class="sw" style="--sw: ${shown ? d.sw : 'var(--line-strong)'}" aria-hidden="true"></span><span class="ind-name">${name}</span>` +
      (coming ? '<span class="ind-tag">coming</span>' : '') + tools + x + `</div>${set}</div>`;
  }
  /* An indicator's real options in its gear panel (LivePrefs INDICATOR_OPTIONS): today the volume profile's hours. */
  /* on / off switches shown as a group of toggles (1.14.0): each a line of its own (Levels: the prior session's and the IB;
     the profile: its developing POC, VAH and VAL) */
  const TOG = (name, what) => ({ toggle: name, label: name, values: { on: ['On', what + ': shown'], off: ['Off', what + ': not shown'] } });
  const TOGGLE_GROUP = { levels: ['Lines', 'Each line on or off; the prior session\'s levels, the overnight high and low, and today\'s Initial Balance'],
    vp: ['Developing', 'The current session\'s point of control and value area, drawn as they build'] };
  const OPTION_TEXT = { vp: { session: { label: 'Hours', values: { full: ['Session', 'Every trade from 18:00 ET'], rth: ['RTH', '9:30 to 16:00 ET (13:00 on NYSE early closes)'] } },
      dpoc: TOG('dPOC', 'The developing point of control'), dvah: TOG('dVAH', 'The developing value area high'), dval: TOG('dVAL', 'The developing value area low') },
    vwap: { session: { label: 'Hours', values: { full: ['Full session', 'From 18:00 ET (the default)'], rth: ['RTH only', 'From 09:30 ET to 16:00 ET; none outside regular hours'] } } },
    levels: Object.fromEntries(LP.LEVEL_LINES.map(L => [L.k, TOG(L.name, L.name)])),
    delta: { show: { label: 'Show', values: { cum: ['Cumulative', 'Candles of buys minus sells, from 0 at 18:00 ET'], bar: ['Bar delta', 'Each bar\'s own buys minus sells, above or below zero'] } },
      div: { label: 'Show divergences', values: { off: ['Off', 'No divergence arrows'], on: ['On', 'Arrows at swings where price and delta disagree (Anthony\'s DeltaDivergenceSignal), from the page\'s opening'] } } } };
  /*
   * The signals' own settings in their gears (G1c), each a number box with the NinjaScript file's name for it and its
   * range: the absorption bars' per instrument and chart type, the divergence's (with Show divergences on), and the
   * large-print floors with the bubbles' Auto. A box applies as it is typed when it holds an allowed value (saved, the
   * signals replayed); leaving it puts the value in use back.
   */
  const SIG_TEXT = {
    LookbackPeriod: ['Lookback period', 'bars', 'Bars averaged for the volume spike (LookbackPeriod)'],
    VolumeMultiplier: ['Volume multiplier', 'x', 'The bar\'s volume against that average (VolumeMultiplier)'],
    RejectionZone: ['Rejection zone', 'of bar', 'The close in the top or bottom of the bar\'s range (RejectionZone)'],
    AggregationWindowMs: ['Aggregation window', 'ms', 'Same side prints at one price within this, added up (AggregationWindowMs)'],
    SwingLookback: ['Swing lookback', 'bars', 'Bars each side that confirm a swing (SwingLookback)'],
    MinBarsBetweenSwings: ['Min bars between swings', 'bars', 'MinBarsBetweenSwings'],
    MinDivergencePct: ['Min divergence', '', 'Price apart by this times 1% or delta by this share of the earlier swing\'s (MinDivergencePct)'],
  };
  const sigStep = spec => spec.int ? '1' : spec.max <= 1 ? '0.01' : '0.1';
  function numRow(group, key, spec, value) {
    const t = SIG_TEXT[key], id = p + 'sig-' + group + '-' + key;
    return `<div class="ind-num"><label class="ind-num-n" for="${id}" title="${esc(t[2])}">${esc(t[0])}</label>` +
      `<input class="ind-hex ind-num-in" id="${id}" type="number" inputmode="decimal" min="${spec.min}" max="${spec.max}" step="${sigStep(spec)}" value="${value}" data-sig="${group}:${key}" data-f="sig:${group}:${key}" title="${esc(t[2])}, ${spec.min} to ${spec.max}">` +
      `<span class="ind-num-u">${esc(t[1])}</span></div>`;
  }
  const typeLabel = () => S.tf === 'range' ? 'Range ' + ranges[S.root] : TF[S.tf].label;
  function floorsHtml() {
    const f = sigFloors[S.root], id = p + 'sigFloor-';
    return `<div class="ind-num ind-num-2"><span class="ind-num-n">Large trade, ${esc(S.root)}</span>` +
      `<label class="ind-num-l" for="${id}rth">RTH</label><input class="ind-hex ind-num-in" id="${id}rth" type="number" inputmode="numeric" min="1" max="100000" step="1" value="${f.rth}" data-sig="floor:rth" data-f="sig:floor:rth" title="${esc(S.root)} large trade floor, 09:30 to 16:15 ET">` +
      `<label class="ind-num-l" for="${id}eth">Overnight</label><input class="ind-hex ind-num-in" id="${id}eth" type="number" inputmode="numeric" min="1" max="100000" step="1" value="${f.eth}" data-sig="floor:eth" data-f="sig:floor:eth" title="${esc(S.root)} large trade floor, the rest of the session"></div>`;
  }
  /* A signal's number box: an allowed value is saved and applied at once; anything else is marked and kept as typed. */
  function sigInput(el) {
    const [g, k] = el.dataset.sig.split(':'), v = el.value;
    const ok = g === 'abs' ? prefs.setAbsorptionSetting(S.root, sigType(), k, v) : g === 'div' ? prefs.setDivergenceSetting(k, v) : g === 'floor' ? prefs.setLargeFloor(S.root, k, v) : false;
    if (!ok) { el.setAttribute('aria-invalid', 'true'); return; }
    el.removeAttribute('aria-invalid');
    sigChanged(g === 'floor');
  }
  /* Leaving a box: the value in use back in it. */
  function sigShown(el) {
    const [g, k] = el.dataset.sig.split(':');
    el.removeAttribute('aria-invalid');
    el.value = g === 'abs' ? prefs.absorptionSettings(S.root, sigType())[k] : g === 'div' ? prefs.divergenceSettings()[k] : sigFloors[S.root][k];
  }
  function signalsHtml(id) {
    if (id === 'absorption') {
      const a = prefs.absorptionSettings(S.root, sigType());
      return `<div class="ind-nums"><div class="ind-cap-in">${esc(S.root)}, ${esc(typeLabel())}</div>` +
        Object.keys(LP.ABS_SPEC).map(k => numRow('abs', k, LP.ABS_SPEC[k], a[k])).join('') + floorsHtml() +
        '<span class="ind-set-note">Each instrument and bar type keeps its own. The floors are the bubbles\' and Time and Sales\' too.</span></div>';
    }
    if (id === 'bubbles') {
      const auto = prefs.bubbleAuto(S.root), lbl = p + 'sigAuto';
      return `<div class="ind-nums">${floorsHtml()}` +
        `<div class="ind-set-opt"><span class="glabel" id="${lbl}">Floor</span><span class="seg sans ind-opt" role="group" aria-labelledby="${lbl}">` +
        `<button type="button" data-act="sigauto" data-v="off" data-f="sigauto:off" aria-pressed="${!auto}" title="The RTH and overnight floors above">Fixed</button>` +
        `<button type="button" data-act="sigauto" data-v="on" data-f="sigauto:on" aria-pressed="${auto}" title="The session's top 1% of trade sizes">Auto</button></span>` +
        `<span class="ind-set-note">${auto ? 'Auto: the session\'s top 1% of sizes' + (SIG.bubbles && SIG.bubbles.autoFloor !== null ? ' (now ' + SIG.bubbles.autoFloor + ')' : ', the fixed floor until 200 have traded') : 'The floors above, for ' + esc(S.root)}</span></div></div>`;
    }
    if (id === 'delta' && S.options.delta.div === 'on') {
      const d = prefs.divergenceSettings();
      return '<div class="ind-nums">' + Object.keys(LP.DIV_SPEC).map(k => numRow('div', k, LP.DIV_SPEC[k], d[k])).join('') +
        '<span class="ind-set-note">Cyan below a bullish swing, yellow above a bearish one; hollow until the swing is confirmed (the colors are the absorption bars\').</span></div>';
    }
    return '';
  }
  function optionsHtml(id) {
    if (!Object.prototype.hasOwnProperty.call(LP.INDICATOR_OPTIONS, id)) return '';
    const keys = Object.keys(LP.INDICATOR_OPTIONS[id]), togs = keys.filter(k => OPTION_TEXT[id][k].toggle);
    const tg = !togs.length ? '' : (() => {
      const lblId = p + 'indTog-' + id, g = TOGGLE_GROUP[id];
      return `<div class="ind-set-opt ind-togs-row"><span class="glabel" id="${lblId}" title="${esc(g[1])}">${esc(g[0])}</span><span class="ind-togs" role="group" aria-labelledby="${lblId}">` +
        togs.map(k => { const on = S.options[id][k] === 'on', t = OPTION_TEXT[id][k];
          return `<button type="button" class="ind-tog" data-act="opt" data-id="${id}" data-k="${k}" data-v="${on ? 'off' : 'on'}" data-f="tog:${id}:${k}" aria-pressed="${on}" title="${esc(t.values[on ? 'on' : 'off'][1])}; click to turn it ${on ? 'off' : 'on'}">${esc(t.toggle)}</button>`; }).join('') + '</span></div>';
    })();
    return keys.filter(k => !OPTION_TEXT[id][k].toggle).map(k => {
      const t = OPTION_TEXT[id][k], cur = S.options[id][k], lblId = p + 'indOpt-' + id + '-' + k;
      const btns = LP.INDICATOR_OPTIONS[id][k].map(v => `<button type="button" data-act="opt" data-id="${id}" data-k="${k}" data-v="${v}" data-f="opt:${id}:${k}:${v}" aria-pressed="${v === cur}" title="${esc(t.values[v][1])}">${esc(t.values[v][0])}</button>`).join('');
      return `<div class="ind-set-opt"><span class="glabel" id="${lblId}">${esc(t.label)}</span><span class="seg sans ind-opt" role="group" aria-labelledby="${lblId}">${btns}</span><span class="ind-set-note">${esc(t.values[cur][1])}</span></div>`;
    }).join('') + tg;
  }
  /* An indicator's colors in its gear panel (1.9.0): a picker and a hex box each, and Default colors. Every chart on
     this page and its storage prefix shares them, as the Colors panel's; an indicator preset saves them all. */
  function colorsHtml(id) {
    const list = LP.INDICATOR_COLORS.filter(c => c.id === id);
    if (!list.length) return '';
    const who = esc(defOf(id).name);
    return '<div class="ind-colors">' + list.map(c => {
      const lbl = p + 'indCol-' + c.key;
      return `<div class="ind-color"><span class="ind-color-n" id="${lbl}">${esc(c.name)}</span>` +
        `<input type="color" data-ck="${c.key}" data-f="col:${c.key}" value="${IC[c.key].toLowerCase()}" aria-labelledby="${lbl}" title="${who}: ${esc(c.name)}">` +
        `<input type="text" class="ind-hex" data-hk="${c.key}" data-f="hex:${c.key}" value="${IC[c.key]}" maxlength="7" spellcheck="false" autocomplete="off" aria-label="${who} ${esc(c.name)} hex"></div>`;
    }).join('') +
      `<div class="ind-colors-foot"><button type="button" class="ind-rec" data-act="coldef" data-id="${id}" data-f="coldef:${id}">Default colors</button>` +
      '<span class="ind-set-note">Save them all as an indicator preset in Colors.</span></div></div>';
  }
  /* A hex box: #RRGGBB, #RGB, the # may be left out (as the Colors panel's). */
  const hexOf = text => {
    let v = String(text).trim(); if (v[0] !== '#') v = '#' + v;
    if (/^#[0-9a-f]{3}$/i.test(v)) v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    return /^#[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : null;
  };
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
    /* 1.14.0 (no scrolling, ever): on the page and in the workspace the open gear's settings show in a card beside the
       menu (live.css .side-gears), not under its row, so the menu keeps its height and fits the screen */
    $('indPanel').classList.toggle('has-gear', !!body.querySelector('.ind-set'));
    /* one live region, changed only when its text changes, so a screen reader hears the result count and notes once */
    const said = M.note || (q ? (() => { const n = LP.searchIndicators(q).length; return n ? n + (n === 1 ? ' match' : ' matches') : 'No match'; })() : '');
    if ($('indLive').textContent !== said) $('indLive').textContent = said;
    if (!$('indPanel').hidden && placeMenu) placeMenu();       // its size changed: placed again so it stays on screen
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
        `<span class="sw" style="--sw: ${shown ? d.sw : 'var(--line-strong)'}" aria-hidden="true"></span>` +
        (SLIM || TRADING ? `<span class="ind-chip-c" aria-hidden="true">${esc(d.code)}</span>` : `<span class="ind-chip-t" aria-hidden="true">${esc(d.short)}</span><span class="ind-chip-l" aria-hidden="true">${esc(d.letter)}</span>`) + '</button>';
    }).join('') + '<button type="button" class="ind-chip-more" aria-haspopup="true" aria-expanded="false" hidden></button><div class="ind-chip-list" role="group" aria-label="More pinned indicators" hidden></div>';
    fitChips();
  }
  /* In a host's slim header (toolbar: false) the strip has the room the header leaves: 2-letter chips, and those that do
     not fit go behind a "+N" chip that opens a small list of them (the same chips). The header never wraps or scrolls.
     1.14.0: with up to ten chips, a host's own toolbar does the same once its one-letter chips do not fit either. */
  let chipListOpen = false;
  function unlistChips() {
    const strip = $('indChips'), more = strip.querySelector('.ind-chip-more'), list = strip.querySelector('.ind-chip-list');
    if (!more || !list) return;
    for (const c of [...list.children]) strip.insertBefore(c, more);
    more.hidden = true;
  }
  function fitSlimChips() {
    const strip = $('indChips'), more = strip.querySelector('.ind-chip-more'), list = strip.querySelector('.ind-chip-list');
    if (!more || !list) return;
    unlistChips();
    const over = () => strip.scrollWidth > strip.clientWidth + 1;
    if (over()) {
      more.hidden = false;
      const shown = [...strip.querySelectorAll(':scope > .ind-chip[data-id]')];
      let n = 0;
      do { const c = shown.pop(); if (!c) break; list.insertBefore(c, list.firstChild); n++; more.textContent = '+' + n; } while (over());
      more.setAttribute('aria-label', n + ' more pinned ' + (n === 1 ? 'indicator' : 'indicators'));
      more.title = [...list.children].map(c => c.getAttribute('aria-label')).join(', ');
    }
    showChipList(chipListOpen && !more.hidden);
  }
  function showChipList(v) {
    const strip = $('indChips'), more = strip.querySelector('.ind-chip-more'), list = strip.querySelector('.ind-chip-list');
    if (!more || !list) return;
    chipListOpen = v;
    list.hidden = !v; more.setAttribute('aria-expanded', String(v));
    if (!v) return;
    const r = more.getBoundingClientRect();                 // fixed: the header strip clips its overflow
    list.style.top = Math.round(r.bottom + 4) + 'px';
    list.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - list.offsetWidth - 8, r.left))) + 'px';
  }
  /* The strip never wraps and never moves the toolbar (review N4): it always keeps room for a full strip of one-letter
     chips (6), so pinning or unpinning cannot change the toolbar's lines, and chips show their names only when that
     fits without adding a toolbar line; otherwise each is one letter. */
  function fitChips() {
    if (SLIM || TRADING) { fitSlimChips(); return; }       // the page (1.14.0): the workspace's 2-letter chips, the rest behind "+N"
    const strip = $('indChips'), bar = strip.closest('.bar');
    unlistChips();
    const most = Math.min(LP.PIN_MAX, IND.filter(d => !d.nochip && !d.coming).length);   // room for every chip there can be
    const room = Math.min(most * 30 + (most - 1) * 4, Math.max(0, bar.clientWidth - $('indWrap').offsetWidth - 8));
    strip.style.setProperty('--chip-room', room + 'px');
    strip.classList.add('is-narrow');
    const h = bar.offsetHeight;
    strip.classList.remove('is-narrow');
    if (bar.offsetHeight > h || strip.scrollWidth > strip.clientWidth + 1) strip.classList.add('is-narrow');
    if (strip.scrollWidth > strip.clientWidth + 1) fitSlimChips();   // one letter each still too wide: the rest behind "+N"
    else showChipList(false);
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
    else if (act === 'coldef') {
      const set = {}; for (const c of LP.INDICATOR_COLORS) if (c.id === id) set[c.key] = c.def;
      setIndicatorColors(set);
      renderMenu();
    }
    else if (act === 'cat') { M.cat = M.cat === id ? null : id; renderMenu(); }
  }
  let openMenu, placeMenu = null;
  {
    const wrap = $('indWrap'), btn = $('indBtn'), panel = $('indPanel'), q = $('indQ');
    /* The panel stays inside the chart's own element (a pane can be narrow, and a host may clip it). */
    /* It opens below the order bar when there is one, so the Armed switch, the account and the position readout stay
       in view (review N5); its list scrolls inside when the space is short. */
    const place = () => {
      /* 1.14.0 (no scrolling, ever): on the page and in the workspace the menu is placed where it fits whole: below the
         order bar when it fits there (the Armed switch, the account and the position readout stay in view, review N5),
         else below the button, else as high as it must; moved left to stay on screen. Only a menu taller than the window
         scrolls its list. */
      if (SLIM || TRADING) {
        const b = btn.getBoundingClientRect(), w = wrap.getBoundingClientRect(), ob = $('obar');
        const below = !SLIM && ob && !ob.hidden ? ob.getBoundingClientRect().bottom : b.bottom, room = window.innerHeight - 8;
        panel.style.maxWidth = Math.max(220, Math.floor(window.innerWidth - 16)) + 'px';
        panel.style.maxHeight = '';
        const h = panel.offsetHeight;
        let top = below + 6;
        if (top + h > room) top = b.bottom + 6;
        if (top + h > room) top = Math.max(8, room - h);
        panel.style.top = Math.round(top - w.top) + 'px';
        if (top + h > room) panel.style.maxHeight = Math.floor(room - top) + 'px';
        panel.style.left = '0px';
        const card = panel.querySelector('.ind-set'), extra = card && panel.classList.contains('has-gear') ? card.offsetWidth + 8 : 0;   // the gear's card beside it
        const over = panel.getBoundingClientRect().right + extra - (window.innerWidth - 8);
        if (over > 0) panel.style.left = -Math.ceil(Math.min(over, w.left - 8)) + 'px';
        panel.classList.remove('gear-left');
        if (extra) {                                             // the card on the left when the right has no room; up as needed
          card.style.top = '';
          if (card.getBoundingClientRect().right > window.innerWidth - 8) panel.classList.add('gear-left');
          const cb = card.getBoundingClientRect().bottom - (window.innerHeight - 8);
          if (cb > 0) card.style.top = Math.round(-1 - cb) + 'px';
        }
        return;
      }
      const r = rootEl.getBoundingClientRect(), b = btn.getBoundingClientRect(), w = wrap.getBoundingClientRect();
      const ob = $('obar'), below = ob && !ob.hidden ? ob.getBoundingClientRect().bottom : b.bottom;   // a host's chart with its toolbar: inside the chart, as before
      panel.style.top = Math.round(below - w.top + 6) + 'px';
      panel.style.maxWidth = Math.max(220, Math.floor(r.right - b.left - 8)) + 'px';
      panel.style.maxHeight = Math.max(200, Math.floor(Math.min(r.bottom, window.innerHeight) - below - 14)) + 'px';
    };
    placeMenu = place;
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
      if (b.dataset.act === 'sigauto') { prefs.setBubbleAuto(S.root, b.dataset.v === 'on'); sigChanged(false); renderMenu(); return; }
      indAction(b.dataset.act, b.dataset.id);
    });
    /* a color picker or hex box in a gear: applied as it changes, the menu is not drawn again (a picker stays open) */
    panel.addEventListener('input', e => {
      if (e.target.dataset.sig && panel.contains(e.target)) { sigInput(e.target); return; }
      const t = e.target, k = t.dataset.ck || t.dataset.hk;
      if (!k || !panel.contains(t)) return;
      const v = t.dataset.ck ? t.value.toUpperCase() : hexOf(t.value);
      if (!v) { t.setAttribute('aria-invalid', 'true'); return; }
      t.removeAttribute('aria-invalid');
      setIndicatorColors({ [k]: v });
      const other = panel.querySelector(t.dataset.ck ? `input[data-hk="${k}"]` : `input[data-ck="${k}"]`);
      if (other) other.value = t.dataset.ck ? v : v.toLowerCase();
    });
    panel.addEventListener('change', e => {
      if (e.target.dataset.sig && panel.contains(e.target)) { sigShown(e.target); return; }
      const t = e.target, k = t.dataset.hk;
      if (k && panel.contains(t)) { t.removeAttribute('aria-invalid'); t.value = IC[k]; }   // leaving the box puts the color in use back
    });
    $('indHideAll').addEventListener('click', () => { M.note = ''; changeIndicators(LP.Pane.hideAllOp(IS)); });
    $('indChips').addEventListener('click', e => {
      if (e.target.closest('.ind-chip-more')) { showChipList(!chipListOpen); return; }
      const b = e.target.closest('button[data-id]'); if (!b) return;
      const id = b.dataset.id, v = !IS.ind[id].shown;          // decided once, from what this chart shows
      changeIndicators(v ? st => LP.Pane.add(st, id, false) : st => LP.Pane.setShown(st, id, false));   // a chip is not a recent use
    });
    listen(document, 'pointerdown', e => { if (!panel.hidden && !wrap.contains(e.target)) close(false); });
    listen(document, 'pointerdown', e => { if (chipListOpen && !$('indChips').contains(e.target)) showChipList(false); });
    listen(document, 'keydown', e => { if (chipListOpen && e.key === 'Escape') { e.preventDefault(); showChipList(false); const m = $('indChips').querySelector('.ind-chip-more'); if (m) m.focus(); } });
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
      if (!onBody && !rootEl.contains(a) && !wrap.contains(a)) return;   // the focus is elsewhere (a host dialog, another chart)
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
      if (SLIM || TRADING) ro.observe($('indChips'));            // in the host's header (or the page's line): the room it has
      cleanups.push(() => ro.disconnect());
    }
  }
  $('acctPick').addEventListener('change', e => pickViewAccount(e.target.value));
  $('toolTrend').addEventListener('click', () => { chart.setTool(chart.getTool() === 'trend' ? null : 'trend'); openMore(false); });
  $('toolHline').addEventListener('click', () => { chart.setTool(chart.getTool() === 'hline' ? null : 'hline'); openMore(false); });
  $('clearDraw').addEventListener('click', () => { chart.clearDrawings(); openMore(false); });
  $('resetBtn').addEventListener('click', () => { chart.reset(); openMore(false); });
  if (PIN && $('pinBtn')) { $('pinRow').hidden = !PIN.active(); $('pinBtn').addEventListener('click', () => { if ($('setPanel')) $('setPanel').hidden = true; PIN.openChange(); }); }
  /* the page's small menu (1.14.0): the drawing tools and Reset view; Escape or a click outside closes it */
  function openMore(v) {
    const menu = $('moreMenu'); if (!menu) return;
    menu.hidden = !v; $('moreBtn').setAttribute('aria-expanded', String(v));
    if (v) fitPop(menu, $('moreWrap'));
  }
  /* A popover under its toolbar button (Settings, the small menu): right-aligned with the button, moved sideways just
     enough to stay on screen (1.14.0: the toolbar is one line, so the button can sit anywhere along it) */
  function fitPop(panel, wrap) {
    panel.classList.remove('set-left'); panel.style.left = ''; panel.style.right = '';
    const r = panel.getBoundingClientRect(), w = wrap.getBoundingClientRect();
    const shift = r.left < 8 ? 8 - r.left : r.right > window.innerWidth - 8 ? window.innerWidth - 8 - r.right : 0;
    if (shift) { panel.style.right = 'auto'; panel.style.left = Math.round(r.left + shift - w.left) + 'px'; }
  }
  if ($('moreBtn')) {
    // a window resized while one is open: kept on screen (the toolbar may have wrapped)
    listen(window, 'resize', () => { for (const [pn, w] of [['setPanel', 'setWrap'], ['moreMenu', 'moreWrap']]) if ($(pn) && !$(pn).hidden) fitPop($(pn), $(w)); });
    $('moreBtn').addEventListener('click', () => openMore($('moreMenu').hidden));
    listen(document, 'pointerdown', e => { if (!$('moreMenu').hidden && !$('moreWrap').contains(e.target)) openMore(false); });
    listen(document, 'keydown', e => { if (e.key === 'Escape' && !$('moreMenu').hidden && !e.defaultPrevented) { e.preventDefault(); openMore(false); $('moreBtn').focus(); } });
  }
  syncButtons();
  syncAccounts();

  /* order bar and order actions on the chart: only on a trading chart (a read-only one has no order bar at all) */
  const KIND_TEXT = { limit: 'LMT', stop: 'STP' };
  const qtyShown = () => HOST ? HT.qty : qtyNow();
  /* Shift held over the chart (1.10.0): a click buys here, a right click sells; the preview shows the buy and says what
     the right click would place. */
  const previewAt = price => {
    const qty = qtyShown(), last = lastPrice();
    return { side: 'buy', kind: OT.placeKind('buy', price, last), qty: isFinite(qty) ? qty : 0, note: 'click · right click: SELL ' + KIND_TEXT[OT.placeKind('sell', price, last)] };
  };
  if (TRADING) {
    /* The order bar's controls (live/trade.js, shared with the workspace's order ticket): Armed, Account, Qty, Buy and
       Sell MKT, the bracket, Flatten, B/E, Cancel all, the state row. */
    BAR = TC.wire($, T, {
      U, LP, prefix: PREFIX, root: () => D.root || S.root, flash, render: () => renderTrading(), listen,
      pickViewAccount, clearAccountNote, tick: tickOf, lastPrice, pointValue: r => (instruments[r] || {}).pointValue || 0, precision: precisionOf,
      accountPicked: a => { viewAccount = a; store.set('live-account-v1', a); saveTabAccount(a); applyMarkers(); },
    });

    /* Trading hotkeys (1.11.0, Anthony 2026-10-01): set in Settings, none by default; each calls what its button calls. */
    const HKKEY = LP.KEYS.hotkeys;
    let HK = OT.cleanHotkeys(prefs.raw.get(HKKEY));
    const readHotkeys = () => { HK = OT.cleanHotkeys(prefs.raw.get(HKKEY)); return HK; };
    const setPanel = $('setPanel'), setWrap = $('setWrap');
    const hkNote = (id, text, level) => { const el = $('hkNote-' + id); el.textContent = text; el.className = 'hk-note' + (level ? ' ' + level : ''); };
    const renderHotkeys = () => { for (const a of OT.HOTKEY_ACTIONS) $('hk-' + a.id).value = HK[a.id]; };
    const openSettings = v => {
      if (v) { readHotkeys(); renderHotkeys(); for (const a of OT.HOTKEY_ACTIONS) hkNote(a.id, '', ''); }
      setPanel.hidden = !v; $('setBtn').setAttribute('aria-expanded', String(v));
      if (v) fitPop(setPanel, setWrap);
    };
    /* Save one action's hotkey (or '' to clear it): read fresh, so another tab's keys are kept; a combo another action
       took meanwhile is refused. Never saved when storage is blocked. */
    const saveHotkey = (id, combo) => {
      const next = Object.assign({}, readHotkeys());
      if (combo) {
        const other = OT.HOTKEY_ACTIONS.find(a => a.id !== id && next[a.id] === combo);
        if (other) { renderHotkeys(); hkNote(id, combo + ' is already ' + other.name + '. Clear it there first.', 'warn'); return; }
      }
      next[id] = combo;
      if (!prefs.raw.set(HKKEY, next)) { renderHotkeys(); hkNote(id, 'Not saved: this browser blocks site storage.', 'error'); return; }
      HK = OT.cleanHotkeys(next); renderHotkeys();
      hkNote(id, combo ? 'Saved.' : 'Cleared.', '');
    };
    $('setBtn').addEventListener('click', () => openSettings(setPanel.hidden));
    listen(document, 'pointerdown', e => { if (!setPanel.hidden && !setWrap.contains(e.target)) openSettings(false); });
    /* Escape closes Settings (but not from a key box, which reads Escape as a key and says it is kept) */
    listen(document, 'keydown', e => {
      if (setPanel.hidden || e.key !== 'Escape' || e.defaultPrevented) return;
      const a = document.activeElement, onBody = !a || a === document.body || a === document.documentElement;
      if (!onBody && !setWrap.contains(a)) return;
      e.preventDefault(); openSettings(false); $('setBtn').focus();
    });
    setWrap.addEventListener('keydown', e => {
      if (setPanel.hidden) return;
      const id = e.target.classList && e.target.classList.contains('hk-in') ? e.target.dataset.hk : '';
      if (!id) return;
      /* the capture box: every key press is read as a hotkey, never typed and never acted on (plain Tab still moves on) */
      const tab = e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey;
      if (!tab) { e.preventDefault(); e.stopPropagation(); }
      if (e.repeat) return;
      const r = OT.hotkeyFromEvent(e, readHotkeys(), id);
      if (r.error) { hkNote(id, r.error, r.held ? '' : 'warn'); return; }
      saveHotkey(id, r.combo);
    });
    setPanel.addEventListener('click', e => {
      const b = e.target.closest('button[data-hk-clear]');
      if (b) saveHotkey(b.dataset.hkClear, '');
    });
    /* another tab set or cleared a hotkey */
    listen(window, 'storage', e => { if (e.key === PREFIX + HKKEY) { readHotkeys(); renderHotkeys(); } });
    listen(document, 'keydown', hotkeyHandler({
      keys: () => HK, root: rootEl,
      busy: () => destroyed || !setPanel.hidden || !$('moreMenu').hidden || !$('indPanel').hidden || themePanel.isOpen() || !!document.querySelector('.cb-pin'),   // the NO STOP question is not modal
      actions: { buy: () => T.sendOrder('buy', 'market', null), sell: () => T.sendOrder('sell', 'market', null), be: T.breakEven, close: () => T.flattenHere(), flattenAll: T.flattenAll },
      ignored: () => flash(HOTKEY_IN_BOX, 'warn'),
    }));

    /* chart: drag an order label to move it, x to cancel, Shift+click to place (all only while Armed) */
    chart.setOrderPreview(previewAt);
    /* Shift+click by mouse button (1.10.0, Anthony): Shift + left click buys at the price (the chart's own Shift+click,
       orderPlace), Shift + right click or Ctrl + left click sells. Both keys at once are unclear: nothing is sent. */
    chart.on('orderPlace', e => {
      if (lastUp && lastUp.ctrlKey) { flash(BOTH_KEYS, 'warn'); return; }
      T.sendOrder('buy', OT.placeKind('buy', e.price, lastPrice()), e.price);
    });
    setupSellClicks(price => T.sendOrder('sell', OT.placeKind('sell', price, lastPrice()), price));
    /* a planned stop or target line (ids "o5:sl", "o5:tp", 0.3.8): its drag sets the distance, its x removes it, "+SL" /
       "+TP" on the entry adds it */
    chart.on('orderMove', e => (OT.planIdOf(e.id) ? T.planMove(e.id, e.price, e.from) : T.moveOrder(e.id, e.price)));
    chart.on('orderCancel', e => (OT.planIdOf(e.id) ? T.planRemove(e.id) : T.cancelOrder(e.id)));
    chart.on('orderPlanAdd', e => T.planAdd(e.id, e.which));
  } else if (HOST) {
    /* A host's chart (the workspace): the same mouse rules, handed to the host with this chart's instrument and the kind
       this chart's own price gives (a limit or a stop, as on the single chart page; null with no price yet). */
    const call = (fn, a) => { try { fn.apply(HOST, a); } catch (e) { setTimeout(() => { throw e; }); } };
    const kindAt = (side, price) => { const last = lastPrice(); return last > 0 ? OT.placeKind(side, price, last) : null; };
    chart.setOrderPreview(previewAt);
    chart.on('orderPlace', e => {
      if (lastUp && lastUp.ctrlKey) { flash(BOTH_KEYS, 'warn'); return; }
      if (armedHere()) call(HOST.place, ['buy', e.price, D.root, kindAt('buy', e.price)]);
    });
    setupSellClicks(price => call(HOST.place, ['sell', price, D.root, kindAt('sell', price)]));
    chart.on('orderMove', e => { if (armedHere()) call(HOST.move, [e.id, e.price, D.root, e.from]); else renderHost(); });
    chart.on('orderCancel', e => { if (armedHere()) call(HOST.cancel, [e.id, D.root]); });
    chart.on('orderPlanAdd', e => { if (armedHere() && typeof HOST.planAdd === 'function') call(HOST.planAdd, [e.id, e.which, D.root]); });
  }

  /* Anything typed but not yet saved is saved when the page is closed, reloaded or hidden, and on destroy(). */
  const saveWaiting = () => {
    const box = $('rangeTicks');
    if (document.activeElement === box) {                  // mid-typing: save what Enter would commit
      const n = LP.clampRange(box.value);
      rangeTypedSave.cancel(); rangeTyped = null;
      saveRange(S.root, n === null ? ranges[S.root] : n);
    }
    if (T) T.flushBrackets();
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
    if (BAR) BAR.renderPositionInfo();
    // the clock crossing 9:30, 10:30 or 18:00, with or without trades; also while offline, when minutes missing
    // since the drop hide the IB (a 'gap') rather than leave a stale one up
    if (D.m1) updateIB(false);
    // the full-session profile moves to the new session at 18:00 ET on the clock on weekday evenings; over a weekend
    // or a holiday it keeps the last session until the next session's first trade, and RTH never moves on the clock
    // (1.6.1, the engine's keep)
    if (D.vp && D.vp.advance(etNow())) vpLegend();
    vpNote(); vpLegend(); rangeNote(); syncNote();
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
    rangeTypedSave.cancel(); if (T) T.cancelBrackets();
    for (const undo of cleanups.splice(0).reverse()) undo();
    const sock = ws; ws = null; connectSeq++;
    if (sock) { sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null; try { sock.close(); } catch (e) { /* already closed */ } }
    themePanel.destroy();
    chart.destroy();
    if (PAGE && window.liveChart === chart) { delete window.liveChart; delete window.liveData; }
    rootEl.remove();
  }
  /* ---------------- for a host (the workspace): the view, the general settings and the colors (see mount above) */
  function setView(v) {
    if (destroyed || !v || typeof v !== 'object') return;
    const root = ROOTS.includes(v.root) ? v.root : S.root, tf = LP.TFS.includes(v.tf) ? v.tf : S.tf;
    const n = v.range === undefined || v.range === null ? null : LP.parseRange(v.range);
    const rootNew = root !== S.root, tfNew = tf !== S.tf, rangeNew = n !== null && n !== ranges[root];
    if (!rootNew && !tfNew && !rangeNew) return;
    if (n !== null) { ranges[root] = n; saveRange(root, n); }
    S.root = root; S.tf = tf;
    if (rootNew) saveSetting('root');
    if (tfNew) saveSetting('tf');
    syncButtons();
    if (rootNew) {
      if (TR.armed) { T.setArmed(false); flash('Armed turned off: the instrument changed.', 'warn'); }
      subscribe(S.root);
    } else if (tfNew && ticksMissing()) subscribe(S.root);
    else if (tfNew || (rangeNew && S.tf === 'range')) rebuild();
    viewChanged();
  }
  function refreshSettings() {
    if (destroyed) return;
    const s = prefs.settings();
    if (s.glide !== S.glide) { S.glide = s.glide; chart.setMotion(GLIDE[S.glide]); }
    if (s.rangeMode !== S.rangeMode) { S.rangeMode = s.rangeMode; if (S.tf === 'range') rebuild(); }
    if (s.grid !== S.grid) { S.grid = s.grid; chart.setGrid(S.grid === 'on'); }
    if (s.room !== S.room) { S.room = s.room; chart.setRoom(S.room); }
    syncButtons();
    sigRefresh();                                          // the signals' settings and the large-print floors (G1c)
  }
  function refreshColors() {
    if (destroyed) return;
    colorsQuiet = true;
    try {
      const ic = prefs.indicatorColors();
      if (LP.IND_COLOR_KEYS.some(k => ic[k] !== IC[k])) { IC = ic; applyIndicatorColors(); }
      let saved = null;
      try { saved = JSON.parse(window.localStorage.getItem(PREFIX + 'live-colors-v1')); } catch (e) { saved = null; }
      const cur = themePanel.get(), diff = {};
      for (const k of ['up', 'down', 'bg']) {
        const v = saved && typeof saved[k] === 'string' && /^#[0-9a-f]{6}$/i.test(saved[k]) ? saved[k].toUpperCase() : CE.DEFAULT_THEME[k];
        if (v && v !== cur[k]) diff[k] = v;
      }
      if (Object.keys(diff).length) themePanel.set(diff);
      else if (PR) renderPresets();
    } finally { colorsQuiet = false; }
  }
  colorsLive = true;
  return { destroy, chart, element: rootEl, paneId: PANE, setIndicatorOption, indicatorOptions: id => Object.assign({}, Object.prototype.hasOwnProperty.call(S.options, id) ? S.options[id] : {}),
    setView, view: () => ({ root: S.root, tf: S.tf, range: ranges[S.root] }), refreshSettings, refreshColors, setTrade,
    indicators: $('indWrap'), chips: $('indChips'), colors: themePanel.element,
    /** The header text toggle (1.14.0), for a host to place beside Indicators; legendShown() / setLegendShown(on). */
    legendToggle: $('lgTog'), legendShown: () => lgOn, setLegendShown,
    /** For a host that shows one status line for all its charts: this chart's delays (medians, ms) and frame rate. */
    stats: () => ({ root: D.root, feed: median(delays.feed), local: median(delays.local), chart: chart.stats() }) };
}

window.ChartLive = { mount, EMBED_PREFIX, hotkeyHandler, HOTKEY_IN_BOX };
/* The standalone page: behind ChartBridge's PIN (live/pin.js) when ChartBridge has one, nothing started until unlocked. */
if (SCRIPT && SCRIPT.getAttribute('data-mount') === 'page') {
  /* The order logic is live/trade.js (1.12.0). A page loaded while the PC updater writes the files can have this live.js
     with an older single.html that does not load it: it is fetched here before the page starts. */
  const withTrade = window.TradeCore ? Promise.resolve() : new Promise(res => {
    const sc = document.createElement('script');
    sc.src = new URL('trade.js', SCRIPT.src).href; sc.onload = res; sc.onerror = res;
    document.head.appendChild(sc);
  });
  const boot = () => { if (!window.TradeCore) { document.body.textContent = 'The page files are being updated (trade.js is missing). Reload this page when flat.'; return; } start(document.body, {}, true); };
  withTrade.then(() => { if (window.ChartBridgePin) window.ChartBridgePin.gate().then(boot); else boot(); });
}
})();
