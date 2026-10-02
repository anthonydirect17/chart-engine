/*!
 * chart-engine 1.15.0
 * Anthony's trading chart: a Canvas 2D candlestick engine with eased zoom, a smooth price axis,
 * live-growing candles, levels, VWAP and trade marks. No dependencies.
 *
 * Works as a plain <script> (defines window.ChartEngine) or as a CommonJS module (Node tests).
 * Times are exchange wall-clock seconds stored as if they were UTC (see util.zoneSeconds), so
 * nothing downstream needs time-zone math.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChartEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const VERSION = '1.15.0';
const DAY = 86400;

/* ---------------------------------------------------------------- time */
const tod = t => ((t % DAY) + DAY) % DAY;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = n => (n < 10 ? '0' : '') + n;
const fmtHM = t => { const s = tod(t); return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s % 3600 / 60)); };
const fmtHMS = t => fmtHM(t) + ':' + pad(Math.floor(tod(t) % 60));
/* A time as exactly as it is kept (1.7.0, where the delta pane counts from): "21:40" on a whole minute, "18:00:15" on a
   whole second, else with tenths ("18:05:00.3", floored), so a start inside the 18:00 minute never reads "18:00". */
const fmtExact = t => { const ms = Math.round(tod(t) * 1000) % 60000; return ms === 0 ? fmtHM(t) : ms % 1000 === 0 ? fmtHMS(t) : fmtHMS(t) + '.' + Math.floor(ms % 1000 / 100); };
const fmtDay = t => { const d = new Date(t * 1000); return DOW[d.getUTCDay()] + ' ' + d.getUTCDate(); };
const fmtMD = t => { const d = new Date(t * 1000); return MON[d.getUTCMonth()] + ' ' + d.getUTCDate(); };
const fmtDate = t => { const d = new Date(t * 1000); return DOW[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); };
const fmtFull = t => { const d = new Date(t * 1000); return DOW[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + '  ' + fmtHM(t); };

/** Trading day a bar belongs to, when sessions start at `sessionStart` seconds after midnight the day before. */
function tradeDay(t, sessionStart) {
  const s = sessionStart || 0;
  return s ? Math.floor((t + DAY - s) / DAY) : Math.floor(t / DAY);
}

const zoneFormatters = {};
/** Unix seconds -> wall-clock seconds in `timeZone`, stored as if UTC. */
function zoneSeconds(unix, timeZone) {
  const tz = timeZone || 'America/New_York';
  let f = zoneFormatters[tz];
  if (!f) {
    f = zoneFormatters[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }
  const p = {};
  for (const part of f.formatToParts(new Date(Math.floor(unix) * 1000))) p[part.type] = part.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000 + (unix - Math.floor(unix));
}

/* ---------------------------------------------------------------- numbers */
function fmtPrice(p, precision) {
  const dp = precision === undefined ? 2 : precision;
  const neg = p < 0; const s = Math.abs(p).toFixed(dp);
  const dot = s.indexOf('.');
  let a = dot < 0 ? s : s.slice(0, dot); const b = dot < 0 ? '' : s.slice(dot);
  a = a.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + a + b;
}
const fmtVolume = v => v >= 10000 ? (v / 1000).toFixed(1) + 'K' : String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const roundTo = (p, tick) => tick ? Math.round(p / tick) * tick : p;

/* ---------------------------------------------------------------- orders and position (1.3.0) */
const KIND_ABBR = { market: 'MKT', limit: 'LMT', stop: 'STP', stopLimit: 'STL' };
/** Short order label: "BUY LMT 2"; bracket legs read "SELL TGT 2" and "SELL STP 2". Qty is what is left to fill. */
function orderLabel(ord) {
  if (ord.plan) return (ord.plan.role === 'stop' ? 'SL plan -' : 'TP plan +') + Math.abs(ord.plan.ticks) + 't';   // 1.13.0: a planned stop or target
  const side = ord.side === 'sell' ? 'SELL' : 'BUY';
  const kind = ord.role === 'target' ? 'TGT' : ord.role === 'stop' ? 'STP' : (KIND_ABBR[ord.kind] || String(ord.kind || '').toUpperCase());
  const left = Math.max(0, (+ord.qty || 0) - (+ord.filled || 0));
  return side + ' ' + kind + ' ' + left;
}
/** The short label (1.15.0, Anthony from his two-monitor setup: the labels were too big and covered price), drawn on a
    host's chart with the full label (orderLabel) on hover: "TGT 1", "STP 1" (a bracket leg; its side is its color),
    "BUY LMT 1" (an entry), planned "SL -12t" / "TP +24t". */
function orderLabelShort(ord) {
  if (ord.plan) return (ord.plan.role === 'stop' ? 'SL -' : 'TP +') + Math.abs(ord.plan.ticks) + 't';
  const left = Math.max(0, (+ord.qty || 0) - (+ord.filled || 0));
  if (ord.role === 'target') return 'TGT ' + left;
  if (ord.role === 'stop') return 'STP ' + left;
  return (ord.side === 'sell' ? 'SELL' : 'BUY') + ' ' + (KIND_ABBR[ord.kind] || String(ord.kind || '').toUpperCase()) + ' ' + left;
}
/** The position's short label parts (1.15.0): ["L1", "+4.50", "+$90"]: the side's letter and size, points per contract,
    whole dollars for the position (none without a point value). */
function positionShort(qty, pnl, precision) {
  const out = [(qty > 0 ? 'L' : 'S') + Math.abs(qty), fmtSigned(pnl.points, precision)];
  if (pnl.dollars !== null && pnl.dollars !== undefined) { const d = Math.round(pnl.dollars); out.push((d < 0 ? '-' : d > 0 ? '+' : '') + '$' + fmtPrice(Math.abs(d), 0)); }
  return out;
}
/** Open P&L of a signed position (long > 0): points per contract, and dollars for the whole position. */
function openPnl(qty, avgPrice, last, pointValue) {
  if (!qty || !isFinite(avgPrice) || !isFinite(last)) return { points: 0, dollars: null };
  const points = (last - avgPrice) * Math.sign(qty);
  const dollars = pointValue > 0 ? (last - avgPrice) * qty * pointValue : null;
  return { points, dollars };
}
/* ---------------------------------------------------------------- fill marks (1.3.1) */
/**
 * Fills merged for drawing: one mark per bar, side and price (to the tick), with the summed qty, so a
 * 3-lot target filled as three 1-lot executions reads "3", not "1". `indexOf(t)` gives the bar index.
 * Sorted by bar; within a bar sells come first, lowest price first, then buys, highest price first,
 * which is the order their labels stack away from the price (sells up, buys down).
 */
function groupFills(list, indexOf, tick) {
  const byKey = new Map(), out = [];
  for (const f of list || []) {
    const i = indexOf(f.t), side = f.side === 'buy' ? 'buy' : 'sell';
    const key = i + '|' + side + '|' + (tick ? Math.round(f.price / tick) : f.price);
    const m = byKey.get(key);
    if (m) m.qty += +f.qty || 0;
    else { const g = { i, side, price: f.price, qty: +f.qty || 0 }; byKey.set(key, g); out.push(g); }
  }
  return out.sort((a, b) => a.i - b.i || (a.side === b.side ? (a.side === 'sell' ? a.price - b.price : b.price - a.price) : a.side === 'sell' ? -1 : 1));
}
/**
 * Label rows for marks from groupFills: `y` is the tip (the fill price), `ly` the label's middle, `s` the
 * triangle half width. A label sits beside its triangle (buys below the price, sells above) and, when it
 * would overlap another label on the same bar (closer than `gap` px), steps away by `gap` until clear.
 */
function stackFillLabels(marks, yOf, s, gap) {
  const out = []; let bar = null, placed = [];
  for (const m of marks) {
    if (m.i !== bar) { bar = m.i; placed = []; }
    const dir = m.side === 'buy' ? 1 : -1, y = yOf(m.price);
    let ly = y + dir * s;
    if (m.qty) {
      for (let k = 0; k <= 2 * placed.length && placed.some(p => Math.abs(p - ly) < gap); k++) ly += dir * gap;
      placed.push(ly);
    }
    out.push({ m, y, ly });
  }
  return out;
}

/** "+$14.00", "-$1,250.50" */
function fmtMoney(v) { return (v < 0 ? '-' : v > 0 ? '+' : '') + '$' + fmtPrice(Math.abs(v), 2); }
/** "+3.50 pt" style signed number. */
function fmtSigned(v, precision) { return (v > 0 ? '+' : v < 0 ? '-' : '') + fmtPrice(Math.abs(v), precision); }

/** Grid step: 1, 2, 2.5 or 5 times a power of ten, at least `raw`, and a whole number of ticks. */
function niceStep(raw, tick) {
  if (!(raw > 0)) return tick || 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    let s = m * p;
    if (tick) s = Math.max(tick, Math.round(s / tick) * tick);
    if (s >= raw - 1e-12) return s;
  }
  return 10 * p;
}

/* ---------------------------------------------------------------- color */
function parseColor(c) {
  c = String(c).trim();
  let m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) { const h = m[1]; return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16), a: 1 }; }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
  if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  return null;
}
const toHex = ({ r, g, b }) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
function rgba(color, alpha) { const c = parseColor(color); return c ? 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + alpha + ')' : color; }
function luminance(color) {
  const c = typeof color === 'string' ? parseColor(color) : color;
  const ch = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}
function contrast(a, b) { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }
/** Dark or white text, whichever reads better on `fill`. */
function readableOn(fill) { return contrast(fill, '#080B10') >= contrast(fill, '#FFFFFF') ? '#080B10' : '#FFFFFF'; }
/**
 * The same hue, moved just enough to read as text on `bg` (WCAG 4.5 by default): lightened on a dark ground,
 * darkened on a light one (1.5.3; before, always lightened, which is the same on the dark grounds). `toward` ('#FFFFFF'
 * or '#000000') picks the direction instead; buildTheme passes its ground's, so all of a theme moves the same way.
 * When even white or black cannot reach `min` (a mid-grey ground), it gives that end.
 */
function legible(color, bg, min, toward) {
  const c = parseColor(color), g = parseColor(bg); if (!c || !g) return color;
  const to = toward ? (parseColor(toward).r > 127 ? WHITE : BLACK) : readableOn(g) === '#FFFFFF' ? WHITE : BLACK;
  return shift(c, g, min || 4.5, to).hex;
}
const WHITE = '#FFFFFF', BLACK = '#000000';
/* `color` moved toward white or black in 5% steps until it reads at `min` on `bg`, checked as drawn (whole RGB
   steps): { hex, k (how far it went), ok (whether it got there; else it is white or black) }. */
function shift(color, bg, min, to, step) {
  const c = typeof color === 'string' ? parseColor(color) : color, g = typeof bg === 'string' ? parseColor(bg) : bg;
  const t = to === WHITE ? 255 : 0, dk = step || 0.05;
  for (let k = 0; k <= 1.0001; k += dk) {
    const m = parseColor(toHex({ r: c.r + (t - c.r) * k, g: c.g + (t - c.g) * k, b: c.b + (t - c.b) * k }));
    if (contrast(m, g) >= min) return { hex: toHex(m), k, ok: true };
  }
  return { hex: to, k: 1, ok: false };
}
/** `color` itself when it already reads at `min` on `bg`, else legible(color, bg, min). */
function onGround(color, bg, min, toward) { const c = parseColor(color); return c && contrast(c, parseColor(bg)) >= min ? color : legible(color, bg, min, toward); }
/**
 * A colored mark on a chosen ground (1.5.3): the color itself when it reads at `min`, else moved toward white or
 * black, whichever gets there with the smaller change (so it keeps as much of its hue as it can); when neither
 * gets there, whichever end reads better.
 */
function markOnGround(color, bg, min, to, step) {
  const c = parseColor(color), g = parseColor(bg);
  if (!c || !g) return color;
  if (contrast(c, g) >= min) return color;
  const a = shift(c, g, min, to || WHITE, step), b = shift(c, g, min, (to || WHITE) === WHITE ? BLACK : WHITE, step);
  if (a.ok && b.ok) return b.k < a.k ? b.hex : a.hex;
  if (a.ok || b.ok) return a.ok ? a.hex : b.hex;
  return contrast(parseColor(b.hex), g) > contrast(parseColor(a.hex), g) ? b.hex : a.hex;
}
const rgbDist = (a, b) => { const x = parseColor(a), y = parseColor(b); return Math.hypot(x.r - y.r, x.g - y.g, x.b - y.b); };
/* Two colors a trader must tell apart (bull and bear, buy and sell, profit and loss, IB high and low): a visible
   lightness step (1.25:1 between them) or a clear color difference (RGB distance 60; the default buy and sell
   are 219 apart, bull and bear 121). */
const PAIR = { contrast: 1.25, dist: 60, split: 3.5, ordered: 1.5 };
function distinct(a, b) { return contrast(a, b) >= PAIR.contrast || rgbDist(a, b) >= PAIR.dist; }
/**
 * A pair of marks on a chosen ground (1.5.3), each reading at `min`, that stay apart when they were apart to begin
 * with. First each on its own (markOnGround). If that brings them together (a mid-grey ground sends both to white),
 * the one that sits further from the ground is pushed further (a higher floor) until they part; if that cannot part
 * them, the lighter one goes toward white and the darker toward black (each still reading at min(min, 4)). With
 * `ordered`, the first must also end up lighter than the second, by 1.5:1 where the ground allows and 1.25:1 at the
 * least (the IB high is the brighter line; every preset gets 1.5:1).
 * Returns [a, b] as drawn.
 */
function pairOnGround(a, b, bg, min, to, ordered) {
  if (!ordered) return pairTry(a, b, bg, min, to, false, 0).pair;
  // the IB pair: 1.5:1 apart where the ground allows (every preset does), else the 1.25:1 of the other pairs
  const strong = pairTry(a, b, bg, min, to, true, PAIR.ordered);
  return strong.ok ? strong.pair : pairTry(a, b, bg, min, to, true, PAIR.contrast).pair;
}
function pairTry(a, b, bg, min, to, ordered, sep) {
  const swap = !ordered && luminance(parseColor(a)) < luminance(parseColor(b));
  const L = swap ? b : a, D = swap ? a : b;                       // L is (meant to be) the lighter one
  const wanted = ordered || distinct(L, D);
  const ok = (x, y) => (!wanted || distinct(x, y)) && (!ordered || (luminance(parseColor(x)) > luminance(parseColor(y)) && contrast(x, y) >= sep));
  const out = (x, y, good) => ({ pair: swap ? [y, x] : [x, y], ok: good });
  let l = markOnGround(L, bg, min, to), d = markOnGround(D, bg, min, to);
  if (ok(l, d)) return out(l, d, true);
  l = markOnGround(L, bg, min, to, 0.01); d = markOnGround(D, bg, min, to, 0.01);   // in finer steps, no overshoot
  if (ok(l, d)) return out(l, d, true);
  const g = parseColor(bg), towardWhite = (to || WHITE) === WHITE;
  for (let f = min * 1.04; f <= 21; f *= 1.04) {                   // push the far one (lighter on a dark ground)
    const r = shift(parseColor(towardWhite ? L : D), g, f, to || WHITE, 0.01);
    if (!r.ok) break;
    if (towardWhite) l = r.hex; else d = r.hex;
    if (ok(l, d)) return out(l, d, true);
  }
  const sl = shift(parseColor(L), g, min, WHITE, 0.01).hex, sd = shift(parseColor(D), g, min, BLACK, 0.01).hex;
  const need = Math.min(min, PAIR.split) - 0.02;
  if (contrast(sl, bg) >= need && contrast(sd, bg) >= need && ok(sl, sd)) return out(sl, sd, true);
  return out(markOnGround(L, bg, min, to), markOnGround(D, bg, min, to), false);
}
/* The IB high and low as drawn (1.5.3; 1.9.0 with colors set in the IB gear, Anthony: the IB high stays the brighter).
   pairOnGround's ordered pair; if even that leaves the high not the brighter by 1.25:1 (a high picked darker than a
   very light low), the high moves toward white and the low toward black, a step at a time, until it is. */
function ibPair(hi, lo, bg, to) {
  const ordered = (a, b) => luminance(parseColor(a)) > luminance(parseColor(b)) && contrast(a, b) >= PAIR.contrast;
  const [h, l] = pairOnGround(hi, lo, bg, FLOOR.text, to, true);
  if (ordered(h, l)) return [h, l];
  for (let k = 0.05; k < 1; k += 0.05) { const a = mix(h, WHITE, k), b = mix(l, BLACK, k); if (ordered(a, b)) return [a, b]; }
  return [WHITE, BLACK];
}
/** Mix of two colors, k = 0 gives `a`, 1 gives `b`, as #RRGGBB. */
function mix(a, b, k) {
  const x = parseColor(a), y = parseColor(b);
  return toHex({ r: x.r + (y.r - x.r) * k, g: x.g + (y.g - x.g) * k, b: x.b + (y.b - x.b) * k });
}
const sameColor = (a, b) => { const x = parseColor(a), y = parseColor(b); return !!x && !!y && x.r === y.r && x.g === y.g && x.b === y.b && x.a === y.a; };

/* ---------------------------------------------------------------- theme */
const DEFAULT_THEME = {
  bg: '#080B10', rth: '#0B1016', grid: 'rgba(42,54,69,0.30)', axisLine: '#18212C', divider: '#2A3645',
  cross: '#5B6B80', axisText: '#8392A5', axisTextStrong: '#E6EDF5',
  tagFill: '#141C26', tagBorder: '#2A3645', tagText: '#F2F6FA',
  up: '#4B9CD3',            // Carolina blue: bull candles
  down: '#6D28D9',          // deep purple: bear candles
  volumeAlpha: 0.26,
  vwap: '#B69CFF',
  long: '#3DDC97', short: '#FF7A7A',     // trade side (house style: green/red only for sides and P&L)
  profit: '#3DDC97', loss: '#FF7A7A',    // trade result
  exit: '#F2F6FA', live: '#F2F6FA',
  drawing: '#D8CCFF',                    // trend lines and horizontal lines
  // volume profile (1.6.0): rows a tint of the ground, value area a step stronger, POC in the value-level gold;
  // 1.14.0 (Anthony: too dark on the dark ground) brighter: rows 1.31:1 on the ground, value area 1.74:1 (were 1.15, 1.40)
  vpRow: '#19212C', vpValue: '#212C3B', vpPoc: '#E0B45A',
  // chart signals (G1c, Anthony: his NinjaTrader cyan and yellow toned to the house palette, not pure #00FFFF and
  // #FFFF00): a softer cyan and a warm yellow for the absorption bars' bodies and the divergence arrows, each with a
  // slightly brighter shade for the 1 px outline (CHART_STYLE --sig-bull, --sig-bull-line, --sig-bear, --sig-bear-line)
  sigBull: '#38DCE8', sigBullLine: '#9CF1F7', sigBear: '#F3D84A', sigBearLine: '#FFEC8F',
  fontMono: '"IBM Plex Mono", ui-monospace, Consolas, monospace',
  fontCond: '"IBM Plex Sans Condensed", "IBM Plex Sans", system-ui, sans-serif',
};
const PRESETS = [
  { id: 'carolina', name: 'Carolina / purple', up: '#4B9CD3', down: '#6D28D9' },
  { id: 'mint', name: 'Mint / coral', up: '#4FD1A5', down: '#F0717A' },
  { id: 'house', name: 'House green / red', up: '#3DDC97', down: '#FF7A7A' },
];
/* ibHigh / ibLow (1.5.3, Anthony): the IB high a brighter shade of the orchid base, the low the base itself. */
const LEVEL_COLORS = { prior: '#9AA8B8', overnight: '#7FB2FF', value: '#E0B45A', close: '#8392A5', ibHigh: '#F7C6EC', ibLow: '#E58BD2' };
/* Chart grounds for the Colors panel (1.5.3). The first is the default and keeps the locked look exactly. */
const BACKGROUNDS = [
  { id: 'dark', name: 'Dark', bg: '#080B10' },
  { id: 'black', name: 'Black', bg: '#000000' },
  { id: 'slate', name: 'Blue-grey', bg: '#1B2433' },
  { id: 'light', name: 'Light', bg: '#F5F7FA' },
];
/*
 * Contrast floors on a chosen ground (1.5.3): text 4.5 (WCAG AA), strong text and tag text 7, lines and marks 3,
 * candle bodies 2.5 (the default bear purple reads at 2.77 on the default ground, which Anthony approved).
 * On a ground where even white or black cannot reach a floor (mid-grey), the best of the two is used.
 */
const FLOOR = { text: 4.5, strong: 7, line: 3, candle: 2.5, cross: 3, divider: 1.4, grid: 1.12 };
/*
 * Neutral colors on any other ground: a mix from the ground toward an ink (the house near-white on a dark ground,
 * the house near-black on a light one), in about the same steps as the default palette, then pushed further until
 * it reads at its floor. Keys the caller set to something other than the default are left as set.
 */
const NEUTRAL_MIX = [
  ['rth', 0.025, 0], ['grid', 0.06, FLOOR.grid], ['axisLine', 0.09, 0], ['divider', 0.2, FLOOR.divider],
  ['cross', 0.4, FLOOR.cross], ['axisText', 0.57, FLOOR.text], ['axisTextStrong', 0.95, FLOOR.strong],
  ['tagFill', 0.07, 0], ['tagBorder', 0.2, FLOOR.divider], ['exit', 1, FLOOR.text], ['live', 1, FLOOR.text],
  ['vpRow', 0.075, 0], ['vpValue', 0.14, 0],
];

/**
 * The theme the chart draws with, built once per change (never per frame). On the default ground every color is
 * exactly the house palette. On any other ground (1.5.3) the neutrals are derived from it and every colored mark
 * (candles, VWAP, trade sides, results, drawings) keeps its hue but is moved until it reads on the ground.
 * `ground` is 'default', 'dark' or 'light'; the page styles its legend from text2, legendBg and the rest.
 */
function buildTheme(partial) {
  const src = Object.assign({}, DEFAULT_THEME, partial || {});
  const T = Object.assign({}, src);
  if (!parseColor(T.bg)) T.bg = DEFAULT_THEME.bg;
  const custom = !sameColor(T.bg, DEFAULT_THEME.bg);
  T.text2 = '#9AA8B8'; T.legendBg = rgba(T.bg, 0.78); T.ground = 'default';
  let to;                                                  // which way colors move to read: white, or black
  if (custom) {
    const dark = readableOn(T.bg) === '#FFFFFF', ink = dark ? '#F2F6FA' : '#080B10';
    to = dark ? '#FFFFFF' : '#000000';
    T.ground = dark ? 'dark' : 'light';
    for (const [k, amount, floor] of NEUTRAL_MIX) {
      if (sameColor(src[k], DEFAULT_THEME[k])) T[k] = floor ? onGround(mix(T.bg, ink, amount), T.bg, floor, to) : mix(T.bg, ink, amount);
    }
    if (sameColor(src.tagText, DEFAULT_THEME.tagText)) T.tagText = onGround(ink, T.tagFill, FLOOR.strong, to);
    T.text2 = onGround(mix(T.bg, ink, 0.65), T.bg, FLOOR.text, to);
    [T.up, T.down] = pairOnGround(T.up, T.down, T.bg, FLOOR.candle, to);
    [T.profit, T.loss] = pairOnGround(T.profit, T.loss, T.bg, FLOOR.text, to);
    T.vwap = markOnGround(T.vwap, T.bg, FLOOR.line, to); T.drawing = markOnGround(T.drawing, T.bg, FLOOR.line, to);
    T.vpPoc = markOnGround(T.vpPoc, T.vpValue, FLOOR.line, to);   // the POC row sits among the value-area rows
    // the signals keep their hue and move only as far as needed: bodies and arrows as candle bodies, outlines as lines
    T.sigBull = markOnGround(T.sigBull, T.bg, FLOOR.candle, to); T.sigBear = markOnGround(T.sigBear, T.bg, FLOOR.candle, to);
    T.sigBullLine = markOnGround(T.sigBullLine, T.bg, FLOOR.line, to); T.sigBearLine = markOnGround(T.sigBearLine, T.bg, FLOOR.line, to);
  }
  /* Trade sides (buy / long green, sell / short red) keep their color on every ground (review, 1.5.3): where one
     does not read on the ground, marks get an outline (lines 3:1) and text a halo (4.5:1) in the house near-black
     or near-white, whichever stands out more from the ground. On the default ground none is needed. */
  T.sideInk = contrast(T.bg, '#080B10') >= contrast(T.bg, '#F2F6FA') ? '#080B10' : '#F2F6FA';
  T.ring = {}; T.halo = {};
  for (const k of ['long', 'short']) {
    const c = contrast(parseColor(T[k]), parseColor(T.bg));
    T.ring[k] = c >= FLOOR.line ? null : T.sideInk;
    T.halo[k] = c >= FLOOR.text ? null : T.sideInk;
  }
  T.upVol = rgba(T.up, T.volumeAlpha); T.downVol = rgba(T.down, T.volumeAlpha);
  T.upOnTag = readableOn(T.up); T.downOnTag = readableOn(T.down);
  T.upText = legible(T.up, T.bg, 4.5, to); T.downText = legible(T.down, T.bg, 4.5, to);
  T.vwapText = legible(T.vwap, T.bg, 4.5, to);
  T.vpPocText = legible(T.vpPoc, T.bg, 4.5, to);
  T.to = to || '#FFFFFF';
  return T;
}

/**
 * CSS colors for a page's own chrome (toolbar, order bar, menus, status line) on any ground but the default, keyed by
 * the live page's CSS variable names; null on the default ground, where the page keeps its house style exactly.
 * 1.5.3 (Anthony: with a light chart the toolbar and status line go light too); 1.9.0 (Anthony: the top bar matches
 * every ground, "white chart, white top bar", Black a black one, Blue-grey a blue-grey one). A dark ground takes the
 * house dark chrome lifted by the same steps over it; a light ground raised surfaces a mix toward the house near-black.
 * On a mid ground (CHROME_MID) the chrome's ground is the chart's moved just enough. Every text color reads at the
 * chart's floors on the surface it sits on that reads worst (text 7:1, secondary text and accents 4.5:1). Built once
 * per theme change, never per frame.
 */
const HOUSE_CHROME = {
  bg: '#080B10', s2: '#0F151D', s3: '#141C26', line: '#18212C', lineStrong: '#2A3645', panel: '#0B1016',
  tint: '#1A1230', border: '#3B2A6B', text: '#E6EDF5', head: '#F2F6FA', text2: '#9AA8B8', text3: '#8392A5',
  accentText: '#B69CFF', accentSoft: '#D8CCFF', loss: '#FF7A7A', profit: '#3DDC97',
};
const HOUSE_AMBER = '#E0B45A', HOUSE_BUY = '#3DDC97', HOUSE_SELL = '#FF7A7A';
/* A mid ground: black or white text reads under 9:1 on it (about the 1.5.3 rule for a light chrome, 9:1 against the
   house near-black). There the chrome's ground is the chart's, lightened or darkened just enough to reach it, so its
   text and the Buy and Sell labels keep their colors apart and reading. */
const CHROME_MID = 9;
function chromeColors(T) {
  if (!T || T.ground === 'default' || !parseColor(T.bg)) return null;
  const light = T.ground === 'light', end = light ? BLACK : WHITE;
  const bg = contrast(T.bg, end) >= CHROME_MID ? T.bg : shift(parseColor(T.bg), parseColor(end), CHROME_MID, light ? WHITE : BLACK, 0.01).hex;
  let S;
  if (light) {
    const ink = '#080B10';
    S = { s2: mix(bg, ink, 0.05), s3: mix(bg, ink, 0.10), line: mix(bg, ink, 0.12), lineStrong: mix(bg, ink, 0.24), panel: bg,
      tint: mix(bg, '#6D28D9', 0.10), border: mix(bg, '#6D28D9', 0.45), text: T.axisTextStrong, head: T.tagText, text2: T.text2,
      text3: T.axisText, accentText: '#6D28D9', accentSoft: '#6D28D9', loss: T.loss, profit: T.profit };
  } else {
    // the house dark surfaces, each the same step above the chosen ground as above the house ground
    const g = parseColor(bg), h0 = parseColor(HOUSE_CHROME.bg), cl = x => Math.max(0, Math.min(255, x));
    const lift = k => { const h = parseColor(HOUSE_CHROME[k]); return toHex({ r: cl(g.r + h.r - h0.r), g: cl(g.g + h.g - h0.g), b: cl(g.b + h.b - h0.b) }); };
    S = Object.assign({}, HOUSE_CHROME);
    for (const k of ['s2', 's3', 'line', 'lineStrong', 'panel', 'tint', 'border']) S[k] = lift(k);
  }
  const armedBar = mix(bg, HOUSE_AMBER, 0.07);                     // the bar while Armed: the amber tint over the ground
  const worstOf = list => list.reduce((a, b) => contrast(b, end) < contrast(a, end) ? b : a);
  const worst = worstOf([bg, S.s2, S.s3, armedBar]), tinted = worstOf([S.tint, S.s2, armedBar]);   // accents sit on the tint and the bar
  const on = (c, min, surface) => legible(c, surface || worst, min, end);
  const v = {
    '--bg': bg, '--s2': S.s2, '--s3': S.s3, '--line': S.line, '--line-strong': S.lineStrong,
    '--text': on(S.text, FLOOR.strong), '--head': on(S.head, FLOOR.strong),
    '--text2': on(S.text2, FLOOR.text), '--text3': on(S.text3, FLOOR.text),
    '--accent-tint': S.tint, '--accent-border': S.border,
    '--accent-text': on(S.accentText, FLOOR.text, tinted), '--accent-soft': on(S.accentSoft, FLOOR.text, tinted),
    '--crimson-word': on('#E0445E', FLOOR.text, bg), '--info': on('#7FB2FF', FLOOR.text), '--warn': on(HOUSE_AMBER, FLOOR.text),
    '--loss': on(S.loss, FLOOR.text), '--profit': on(S.profit, FLOOR.text), '--panel': S.panel,
    '--scheme': light ? 'light' : 'dark',
  };
  /* The order bar follows the page chrome (1.9.0, Anthony: "white chart, white top bar"). Its Buy and Sell keep a tint
     of the house green and red, and their text reads on the strongest of those tints (hover, over the bar or the Armed
     bar). The house amber tints the bar while Armed; the switch and the pill are ground-colored text on --warn. */
  for (const [side, house] of [['buy', HOUSE_BUY], ['sell', HOUSE_SELL]]) {
    const hover = worstOf([mix(S.s2, house, 0.16), mix(armedBar, house, 0.16)]), text = legible(on(house, FLOOR.text), hover, FLOOR.text, end);
    v['--' + side] = text; v['--' + side + '-edge'] = rgba(text, 0.55);
    v['--' + side + '-tint'] = rgba(house, 0.08); v['--' + side + '-hover'] = rgba(house, 0.16);
  }
  v['--warn-tint'] = rgba(HOUSE_AMBER, 0.07);
  const dim = obarDim(v);
  v['--obar-off'] = String(dim.off); v['--obar-disabled'] = String(dim.disabled);
  // the Colors button and panel (mountThemePanel reads these, falling back to the dark house colors)
  Object.assign(v, {
    '--ce-text': v['--text'], '--ce-text2': v['--text2'], '--ce-muted': v['--text3'], '--ce-s2': S.s2, '--ce-s3': S.s3,
    '--ce-line': v['--line-strong'], '--ce-line-soft': v['--line'], '--ce-panel': S.panel, '--ce-accent': v['--accent-text'],
    '--ce-tint': S.tint, '--ce-tint-border': S.border, '--ce-tint-text': v['--accent-soft'], '--ce-bad': v['--loss'],
    '--ce-shadow': light ? '0 12px 32px rgba(8,11,16,.18)' : '0 12px 32px rgba(0,0,0,.45)', '--ce-scheme': light ? 'light' : 'dark',
  });
  return v;
}
/*
 * The order bar's dimmed controls (1.9.0, review R2): Buy, Sell, Flatten and Cancel all while disarmed (.is-off), and
 * every control while trading is off (:disabled), fade with an opacity, 0.45 and 0.4 on the house bar. On another
 * ground the opacity is raised in 0.05 steps until every one of them reads at least as well as it does on the house
 * bar (with 0.02 to spare for the browser's rounding), measured as drawn: the text and its button's own surface, both
 * faded over what is behind them. obarDims lists them as [text, own surface, behind]; the tints are the house bar's
 * (Buy MKT and Sell MKT 8%, a picked side 10%) or the page's (8% both).
 */
const DIM = { off: 0.45, disabled: 0.4 };
function obarDims(v, sideTint, segTint) {
  const bar = v['--s2'], armedBar = mix(v['--bg'], HOUSE_AMBER, 0.07);
  const tint = (house, k, under) => mix(under, house, k);
  // [text, its own surface, behind it]: Buy MKT, Sell MKT, Flatten and Cancel all (.btn), on the bar
  const off = [[v['--buy'], tint(HOUSE_BUY, sideTint, bar), bar], [v['--sell'], tint(HOUSE_SELL, sideTint, bar), bar], [v['--text'], bar, bar]];
  const disabled = [];
  for (const [under, arm] of [[bar, [v['--text2'], v['--bg']]], [armedBar, [v['--bg'], v['--warn']]]]) {
    disabled.push([v['--buy'], tint(HOUSE_BUY, sideTint, under), under], [v['--sell'], tint(HOUSE_SELL, sideTint, under), under],
      [v['--text'], bar, under],                                 // Flatten, Cancel all
      [arm[0], arm[1], under], [arm[0], arm[1], arm[1]],         // the Armed switch, off or on (its label faded on it too)
      [v['--text'], v['--bg'], under],                           // Qty and the bracket boxes
      [v['--text2'], bar, under],                                // the Shift+click side buttons (in their bar-colored group)
      [v['--buy'], tint(HOUSE_BUY, segTint, bar), under], [v['--sell'], tint(HOUSE_SELL, segTint, bar), under]);   // a side picked
  }
  return { off, disabled };
}
const fadedContrast = ([fg, surface, under], a) => contrast(mix(under, fg, a), mix(under, surface, a));
const HOUSE_DIMS = (() => {
  const h = obarDims({ '--bg': HOUSE_CHROME.bg, '--s2': HOUSE_CHROME.s2, '--text': HOUSE_CHROME.text, '--text2': HOUSE_CHROME.text2,
    '--buy': HOUSE_BUY, '--sell': HOUSE_SELL, '--warn': HOUSE_AMBER }, 0.08, 0.10);
  return { off: h.off.map(x => fadedContrast(x, DIM.off)), disabled: h.disabled.map(x => fadedContrast(x, DIM.disabled)) };
})();
function obarDim(v) {
  const d = obarDims(v, 0.08, 0.08), out = {};                     // the page sets --buy-tint and --sell-tint at 8%
  for (const k of ['off', 'disabled']) {
    let a = DIM[k];
    while (a < 1 && !d[k].every((x, i) => fadedContrast(x, a) >= HOUSE_DIMS[k][i] + 0.02)) a = Math.min(1, Math.round((a + 0.05) * 100) / 100);
    out[k] = a;
  }
  return out;
}
/** Every CSS variable chromeColors() can set, so a page can clear them when the ground goes back to the default. */
const CHROME_VARS = Object.keys(chromeColors({ ground: 'light', bg: '#F5F7FA', axisTextStrong: '#333333', tagText: '#111111', text2: '#555555', axisText: '#666666', loss: '#AA0000', profit: '#006600' }));

/* ---------------------------------------------------------------- data helpers */
/** Roll bars up into `barSeconds` buckets (bars must be sorted, finer than the target). */
function aggregate(bars, barSeconds) {
  const out = []; let cur = null;
  for (const b of bars) {
    const bt = Math.floor(b.t / barSeconds) * barSeconds;
    if (!cur || cur.t !== bt) { cur = { t: bt, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, vw: b.vw }; out.push(cur); }
    else { if (b.h > cur.h) cur.h = b.h; if (b.l < cur.l) cur.l = b.l; cur.c = b.c; cur.v += b.v || 0; cur.vw = b.vw; }
  }
  return out;
}
/** The `barSeconds` bar that holds the newest fine bar, rebuilt from the fine bars (for live updates). */
function foldLast(bars, barSeconds) {
  const b = bars[bars.length - 1]; const bt = Math.floor(b.t / barSeconds) * barSeconds;
  let i = bars.length - 1, h = -Infinity, l = Infinity, v = 0, o = b.o;
  while (i >= 0 && bars[i].t >= bt) { const x = bars[i]; if (x.h > h) h = x.h; if (x.l < l) l = x.l; v += x.v || 0; o = x.o; i--; }
  return { t: bt, o, h, l, c: b.c, v, vw: b.vw };
}
/** Adds a session VWAP (`vw`) to each bar, restarting at each session start. Mutates and returns bars. */
function addSessionVwap(bars, sessionStart) {
  let day = null, pv = 0, vol = 0;
  for (const b of bars) {
    const d = tradeDay(b.t, sessionStart);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const v = b.v || 0; pv += (b.h + b.l + b.c) / 3 * v; vol += v;
    b.vw = vol > 0 ? pv / vol : b.c;
  }
  return bars;
}
/**
 * Today's reference levels from intraday bars: prior regular-session high, low and close, overnight
 * high and low, and the prior session's 70% value area. `asOf` is the time "today" is judged from.
 */
function sessionLevels(bars, opts) {
  const o = Object.assign({ sessionStart: 18 * 3600, rthStart: 34200, rthEnd: 57600, tick: 0.25, valueArea: 0.7, binSize: 1 }, opts || {});
  if (!bars.length) return null;
  const asOf = o.asOf !== undefined ? o.asOf : bars[bars.length - 1].t;
  const today = tradeDay(asOf, o.sessionStart);
  const inRth = t => { const s = tod(t); return s >= o.rthStart && s < o.rthEnd; };
  let prevDay = -Infinity;
  for (const b of bars) { const d = tradeDay(b.t, o.sessionStart); if (d < today && d > prevDay) prevDay = d; }
  const prth = bars.filter(b => tradeDay(b.t, o.sessionStart) === prevDay && inRth(b.t));
  const on = bars.filter(b => tradeDay(b.t, o.sessionStart) === today && !inRth(b.t) && b.t <= asOf && (tod(b.t) < o.rthStart || tod(b.t) >= o.sessionStart));
  const res = { pdh: null, pdl: null, pc: null, onh: null, onl: null, vah: null, val: null, poc: null };
  if (prth.length) {
    res.pdh = Math.max(...prth.map(b => b.h)); res.pdl = Math.min(...prth.map(b => b.l)); res.pc = prth[prth.length - 1].c;
    const bins = new Map(); let total = 0; const bs = o.binSize;
    for (const b of prth) {
      const lo = Math.floor(b.l / bs), hi = Math.floor(b.h / bs), n = hi - lo + 1, v = b.v || 0;
      for (let k = lo; k <= hi; k++) bins.set(k, (bins.get(k) || 0) + v / n);
      total += v;
    }
    const keys = [...bins.keys()].sort((a, b) => a - b);
    if (keys.length && total > 0) {
      let poc = 0; keys.forEach((k, i) => { if (bins.get(k) > bins.get(keys[poc])) poc = i; });
      let lo = poc, hi = poc, acc = bins.get(keys[poc]);
      while (acc < total * o.valueArea && (lo > 0 || hi < keys.length - 1)) {
        const up = hi < keys.length - 1 ? bins.get(keys[hi + 1]) : -1;
        const dn = lo > 0 ? bins.get(keys[lo - 1]) : -1;
        if (up >= dn) { hi++; acc += up; } else { lo--; acc += dn; }
      }
      res.poc = roundTo(keys[poc] * bs, o.tick); res.vah = roundTo((keys[hi] + 1) * bs, o.tick); res.val = roundTo(keys[lo] * bs, o.tick);
    }
  }
  if (on.length) { res.onh = Math.max(...on.map(b => b.h)); res.onl = Math.min(...on.map(b => b.l)); }
  return res;
}
/* LEVEL_COLORS with the valid #RRGGBB entries of `colors` over it (1.9.0: the page's indicator colors). */
function levelColors(colors) {
  const out = Object.assign({}, LEVEL_COLORS);
  if (colors) for (const k of Object.keys(LEVEL_COLORS)) if (/^#[0-9a-f]{6}$/i.test(colors[k])) out[k] = colors[k].toUpperCase();
  return out;
}
/** sessionLevels() result -> level lines in the house style, or in `colors` ({ prior, overnight, value, close }). Each
    line has a `key` (pdh, pdl, pc, onh, onl, vah, val, poc) so a page can switch it on or off. 1.14.0 (Anthony): the
    prior day's value area is named "PD VAH" / "PD VAL", and its point of control "PD POC" is drawn too (the value-area
    color, a dash-dot 8/3/2/3 no other level uses). */
const PD_POC_DASH = [8, 3, 2, 3];
function levelLines(lv, colors) {
  if (!lv) return [];
  const C = levelColors(colors);
  const L = [
    ['pdh', 'PDH', lv.pdh, C.prior, [6, 4]], ['vah', 'PD VAH', lv.vah, C.value, [3, 4]], ['poc', 'PD POC', lv.poc, C.value, PD_POC_DASH],
    ['onh', 'ONH', lv.onh, C.overnight, [6, 4]], ['pc', 'Prior close', lv.pc, C.close, [2, 3]],
    ['onl', 'ONL', lv.onl, C.overnight, [6, 4]], ['val', 'PD VAL', lv.val, C.value, [3, 4]],
    ['pdl', 'PDL', lv.pdl, C.prior, [6, 4]],
  ];
  return L.filter(x => x[2] !== null && x[2] !== undefined).map(([key, name, price, color, dash]) => ({ key, name, price, color, dash: dash.slice() }));
}

/* ---------------------------------------------------------------- initial balance (1.5.3) */
/** Good Friday of `year` as a day number: Easter Sunday (anonymous Gregorian algorithm) less two days. */
function goodFriday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d4 = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d4 - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const em = Math.floor((h + l - 7 * m + 114) / 31), ed = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, em - 1, ed) / 1000 / DAY - 2;
}
/*
 * US stock market (NYSE) full-day closures, for the Initial Balance: CME equity index futures still trade on most of
 * these days (to an early halt), but there is no 9:30 open, so there is no IB. Rules as the NYSE publishes them:
 * New Year's Day (Sunday -> Monday; on a Saturday it is not moved to the Friday before), Martin Luther King Jr. Day,
 * Washington's Birthday, Good Friday, Memorial Day, Juneteenth (from 2022), Independence Day, Labor Day,
 * Thanksgiving and Christmas (Saturday -> Friday, Sunday -> Monday). Unscheduled closures (a national day of
 * mourning) are not known in advance and are not here. Early-close days (the day after Thanksgiving, Christmas Eve,
 * July 3) open at 9:30 as usual and do have an IB.
 */
const holidayCache = new Map();
function nyseHolidays(year) {
  let set = holidayCache.get(year);
  if (set) return set;
  const D = (m, d) => Date.UTC(year, m - 1, d) / 1000 / DAY;
  const dow = day => new Date(day * DAY * 1000).getUTCDay();
  const nth = (m, wd, n) => { let d = D(m, 1); while (dow(d) !== wd) d++; return d + 7 * (n - 1); };
  const lastWd = (m, wd) => { let d = D(m + 1, 1) - 1; while (dow(d) !== wd) d--; return d; };
  const observed = d => dow(d) === 6 ? d - 1 : dow(d) === 0 ? d + 1 : d;
  const days = [
    dow(D(1, 1)) === 6 ? null : observed(D(1, 1)),
    nth(1, 1, 3), nth(2, 1, 3), goodFriday(year), lastWd(5, 1),
    year >= 2022 ? observed(D(6, 19)) : null,
    observed(D(7, 4)), nth(9, 1, 1), nth(11, 4, 4), observed(D(12, 25)),
  ];
  set = new Set(days.filter(x => x !== null));
  holidayCache.set(year, set);
  return set;
}
/** Whether the calendar day holding bar time `t` has a regular stock market session (a weekday, not an NYSE holiday). */
function rthDay(t) {
  const day = Math.floor(t / DAY), date = new Date(day * DAY * 1000), wd = date.getUTCDay();
  return wd !== 0 && wd !== 6 && !nyseHolidays(date.getUTCFullYear()).has(day);
}
/** Whether trading day d (tradeDay's number: the calendar day the session ends on) has no stock market session. */
function closedDay(d) { return !rthDay(d * DAY + 43200); }
/** Whether a trading day strictly between days a and b has no stock market session (at most 10 days looked at). */
function closedBetween(a, b) { for (let x = a + 1; x < b && x <= a + 10; x++) if (closedDay(x)) return true; return false; }
/*
 * NYSE early closes (13:00 ET), by the NYSE's rules: the day after Thanksgiving; Christmas Eve when it is a Monday to
 * Thursday (on a Friday it is the observed Christmas holiday, on a weekend there is none); July 3 when it is a Monday
 * to Thursday (on a Friday it is the observed Independence Day). For example 2024: Jul 3, Nov 29, Dec 24; 2026:
 * Nov 27, Dec 24. Unscheduled early closes are not known in advance and are not here. (1.6.0, volume profile.)
 */
const earlyCloseCache = new Map();
function nyseEarlyCloses(year) {
  let set = earlyCloseCache.get(year);
  if (set) return set;
  const D = (m, d) => Date.UTC(year, m - 1, d) / 1000 / DAY;
  const dow = day => new Date(day * DAY * 1000).getUTCDay();
  let thanks = D(11, 1); while (dow(thanks) !== 4) thanks++; thanks += 21;
  const days = [thanks + 1];
  for (const d of [D(7, 3), D(12, 24)]) if (dow(d) >= 1 && dow(d) <= 4) days.push(d);
  set = new Set(days);
  earlyCloseCache.set(year, set);
  return set;
}
/** The stock market's close on the calendar day holding `t`, in seconds after midnight ET: 57600 (16:00), 46800 (13:00)
    on an NYSE early-close day, or null when there is no regular session (a weekend or an NYSE holiday). */
function rthClose(t) {
  if (!rthDay(t)) return null;
  const day = Math.floor(t / DAY);
  return nyseEarlyCloses(new Date(day * DAY * 1000).getUTCFullYear()).has(day) ? 46800 : 57600;
}
/*
 * CME Globex equity index futures (NQ, MNQ, ES and so on), for the volume profile's loads (1.6.1, review 2 S5): Globex
 * trades on most NYSE holidays, so "the stock market is closed" is not "CME is closed". The days with no Globex
 * session at all: New Year's Day, Good Friday and Christmas, on the days the NYSE observes them (cmeClosures). On the
 * other NYSE holidays (Martin Luther King Jr. Day, Presidents Day, Memorial Day, Juneteenth, Independence Day, Labor
 * Day, Thanksgiving) Globex trades from 18:00 the evening before and halts at 13:00 ET; on an NYSE early close day
 * it halts at 13:15 ET. Unscheduled changes are not known in advance and are not here.
 */
const cmeClosureCache = new Map();
function cmeClosures(year) {
  let set = cmeClosureCache.get(year);
  if (set) return set;
  const hol = nyseHolidays(year), D = (m, d) => Date.UTC(year, m - 1, d) / 1000 / DAY;
  const days = [D(1, 1), D(1, 2), goodFriday(year), D(12, 24), D(12, 25), D(12, 26)].filter(d => hol.has(d));
  set = new Set(days);
  cmeClosureCache.set(year, set);
  return set;
}
/** Whether trading day d (tradeDay's number, sessions from 18:00 ET) has a CME Globex session: Monday to Friday, not a CME closure. */
function cmeSessionDay(d) {
  const date = new Date(d * DAY * 1000), wd = date.getUTCDay();
  return wd !== 0 && wd !== 6 && !cmeClosures(date.getUTCFullYear()).has(d);
}
/**
 * Whether CME Globex equity index futures are closed at exchange wall-clock time t: the 17:00 to 18:00 ET break every
 * day, Friday 17:00 to Sunday 18:00, a day with no Globex session (cmeClosures), and after the halt on an NYSE holiday
 * (13:00 ET) or an NYSE early close (13:15 ET) until 18:00.
 */
function cmeClosed(t) {
  const s = tod(t);
  if (s >= 61200 && s < 64800) return true;
  if (!cmeSessionDay(tradeDay(t, 64800))) return true;
  const day = Math.floor(t / DAY), date = new Date(day * DAY * 1000), wd = date.getUTCDay(), y = date.getUTCFullYear();
  if (wd === 0 || wd === 6 || s >= 64800) return false;          // Sunday evening, or any evening's new session
  if (nyseHolidays(y).has(day)) return s >= 46800;
  if (nyseEarlyCloses(y).has(day)) return s >= 47700;
  return false;
}

/**
 * Today's Initial Balance: the high and low of the first hour of regular trading, 9:30:00 up to (not including)
 * 10:30:00 ET, for the trading day `opts.asOf` falls in (sessions start at `sessionStart`, 18:00 for CME).
 *
 * `data` is sorted, oldest first: bars { t, h, l } of `opts.barSeconds` each (60 for 1-minute bars; t is the bar's
 * start), or trades [t, price, ...] with barSeconds 0. A bar must lie wholly inside the window or wholly outside it:
 * one that straddles 9:30 or 10:30 (a 1-hour bar from 9:00, for example) could carry prices from outside the hour,
 * so the answer is then 'inexact' and no values are given. 1-minute bars never straddle (both edges are whole
 * minutes), and give exactly what the trades inside them give. Range bars have no fixed length: pass the 1-minute
 * bars or the trades instead.
 *
 * Coverage (1.5.3 review): the data must reach back before 9:30 within today's session (a bar from the 18:00 start
 * on that ends at or before 9:30, or a trade from today's session before 9:30), or `opts.from`, the time from which
 * the data is known complete, must be at or before 9:30; otherwise 'uncovered'. Yesterday's bars do not count. With
 * bars, every slot of the hour up to the one in progress must be there (9:30, 9:31, ... for 1-minute bars): one
 * missing means trades may be missing, so the answer is 'gap'. (A hole in a list of trades cannot be seen.)
 *
 * Returns { state, high, low, start, end }: state 'closed' (a weekend or an NYSE holiday: no regular session),
 * 'before' (earlier than 9:30), 'forming' (9:30 to 10:30; high and low so far, null before the first trade),
 * 'locked' (from 10:30:00), 'empty' (no trades in the hour), 'uncovered', 'gap' or 'inexact'. high and low are null
 * in every state but 'forming' and 'locked'.
 */
function initialBalance(data, opts) {
  const o = Object.assign({ sessionStart: 18 * 3600, start: 34200, end: 37800, barSeconds: 60, from: undefined }, opts || {});
  const list = data || [];
  const n = list.length;
  const tick = n && Array.isArray(list[0]);
  const w = tick ? 0 : o.barSeconds;
  const tAt = i => tick ? list[i][0] : list[i].t;
  const asOf = o.asOf !== undefined ? o.asOf : n ? tAt(n - 1) : 0;
  const day = tradeDay(asOf, o.sessionStart);
  const start = day * DAY + o.start, end = day * DAY + o.end;
  const res = { state: 'before', high: null, low: null, start, end };
  if (!rthDay(start)) { res.state = 'closed'; return res; }
  if (asOf < start) return res;
  // first bar ending after 9:30 (bars), or first trade at or after 9:30 (trades)
  const after = i => w > 0 ? tAt(i) + w > start : tAt(i) >= start;
  let lo = 0, hi = n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (after(mid)) hi = mid; else lo = mid + 1; }
  if (lo < n && tAt(lo) < start) { res.state = 'inexact'; return res; }          // a bar across 9:30
  const sessionFrom = o.sessionStart ? (day - 1) * DAY + o.sessionStart : day * DAY;
  const covered = o.from !== undefined ? o.from <= start : lo > 0 && tAt(lo - 1) >= sessionFrom;
  if (!covered) { res.state = 'uncovered'; return res; }
  let H = -Infinity, L = Infinity, next = start, count = 0;
  for (let i = lo; i < n; i++) {
    const t = tAt(i);
    if (t >= end || t > asOf) break;                                            // nothing after the hour, or after asOf
    if (t < start || t + w > end) { res.state = 'inexact'; return res; }
    if (w > 0 && t > next) { res.state = 'gap'; return res; }                   // a missing bar inside the hour
    if (w > 0) next = t + w;
    const h = tick ? list[i][1] : list[i].h, l = tick ? list[i][1] : list[i].l;
    if (h > H) H = h;
    if (l < L) L = l;
    count++;
  }
  const locked = asOf >= end;
  // every finished slot up to now must be there (the slot in progress may not have a trade yet)
  if (w > 0 && count && next < Math.min(end, Math.floor((asOf - start) / w) * w + start)) { res.state = 'gap'; return res; }
  if (H === -Infinity) {
    // nothing in the hour: if nothing came after 9:30 at all, the data stopped (minutes missing), else no trades
    const late = asOf >= start + Math.max(w, 60);
    res.state = !late ? 'forming' : lo >= n ? 'gap' : 'empty';
    return res;
  }
  res.state = locked ? 'locked' : 'forming'; res.high = H; res.low = L;
  return res;
}
/* The forming IB's dash: long dashes, unlike the prior-day and overnight 6/4, value area 3/4 and prior close 2/3. */
const IB_FORMING_DASH = [12, 5];
/**
 * initialBalance() result -> level lines "IBH" and "IBL", drawn from 9:30 (`from`) to the right edge: long dashes
 * while forming, solid once locked. The high is the brighter orchid (Anthony, 1.5.3); `tone` keeps it the brighter
 * one on any ground. `colors` ({ ibHigh, ibLow }, 1.9.0) replaces the house orchids.
 */
function ibLines(ib, colors) {
  if (!ib || ib.high === null || ib.low === null || (ib.state !== 'forming' && ib.state !== 'locked')) return [];
  const dash = ib.state === 'forming' ? IB_FORMING_DASH.slice() : [], C = levelColors(colors);
  return [
    { key: 'ibh', name: 'IBH', price: ib.high, color: C.ibHigh, dash, layer: 'ib', from: ib.start, tone: 'high' },
    { key: 'ibl', name: 'IBL', price: ib.low, color: C.ibLow, dash: dash.slice(), layer: 'ib', from: ib.start, tone: 'low' },
  ];
}

/* ---------------------------------------------------------------- volume profile geometry (1.6.0) */
/* The volume profile's width (Anthony's ruling 2026-09-29 leaves the size to us): the largest row (the POC) reaches
   this share of the plot width, measured from the plot's right edge; every other row is scaled to it. */
const VP_WIDTH = 0.25;
/* The POC bar's least height in CSS px (review): a 1-tick row can be under a pixel, and a hairline POC read as a level
   line. Centred on its row; it may cover a part of the rows next to it, and is drawn after them. */
const VP_POC_MIN = 2;
/**
 * The rectangles of a volume profile, in device pixels: horizontal bars anchored to the right edge of the plot.
 * `c` is VolumeProfile.columns(); `v` is the view { lo, hi (prices at the bottom and top of the plot), plotW, plotH
 * (CSS px), dpr, width (share of plotW, default VP_WIDTH) }. Calls emit(kind, x, y, w, h) once per bar, top to
 * bottom, kind 0 for a row outside the value area, 1 inside it, 2 for the POC. Only rows in view are visited.
 * A row is the height of its price span (a 1-tick row covers price - tick/2 to price + tick/2, like the axis), rounded
 * to whole device pixels; a gap of one pixel separates rows 4 px or taller. Rows thinner than a pixel share it: the
 * bar there is as long as the largest of them and takes the strongest kind (POC, then value area), so the POC always
 * shows, and the POC bar is at least VP_POC_MIN CSS px tall, centred on its row. Rows of volume 0 draw nothing.
 * Returns the number of bars.
 */
function profileRects(c, v, emit) {
  if (!c || !(c.max > 0) || !(v.hi > v.lo) || !(v.plotH > 0)) return 0;
  const n = c.volumes.length, dpr = v.dpr || 1, k = v.plotH * dpr / (v.hi - v.lo);
  const right = Math.round(v.plotW * dpr), maxW = v.plotW * dpr * (v.width === undefined ? VP_WIDTH : v.width);
  const base = c.low - c.tick / 2;                                  // the bottom edge of row 0
  const i0 = Math.max(0, Math.floor((v.lo - base) / c.step) - 1), i1 = Math.min(n - 1, Math.ceil((v.hi - base) / c.step));
  let count = 0, py = 0, ph = 0, pv = 0, pk = 0, open = false;
  const pocH = Math.max(1, Math.round(VP_POC_MIN * dpr));
  const flush = () => {
    if (!open || !(pv > 0)) return;
    const w = Math.max(1, Math.round(pv / c.max * maxW));
    let y = py, h = ph >= 4 ? ph - 1 : ph;
    if (pk === 2 && h < pocH) { y = Math.round(py + ph / 2 - pocH / 2); h = pocH; }   // the POC never thinner than 2 CSS px
    emit(pk, right - w, y, w, h); count++;
  };
  for (let i = i1; i >= i0; i--) {
    let top = Math.round((v.hi - (base + (i + 1) * c.step)) * k), bot = Math.round((v.hi - (base + i * c.step)) * k);
    const vol = c.volumes[i], kind = i === c.poc ? 2 : i >= c.vaLow && i <= c.vaHigh ? 1 : 0;
    if (open && bot <= py + ph) { if (vol > pv) pv = vol; if (kind > pk) pk = kind; continue; }   // inside the pixel row above
    if (open && top < py + ph) top = py + ph;
    if (bot <= top) bot = top + 1;
    flush();
    py = top; ph = bot - top; pv = vol; pk = kind; open = true;
  }
  flush();
  return count;
}

/* ---------------------------------------------------------------- delta pane geometry (1.7.0) */
/* The delta pane below the plot: its share of the chart's height at first (Anthony: about 20%), the least and most a
   drag or a saved height can give it, and the least height in CSS px of the pane and of the price plot above it, so
   neither can collapse to nothing (on a chart too short for both, the pane gets 30% of it). PANE_GAP is the band
   between the two (the divider, which the pointer drags and the arrow keys move). */
const PANE_RATIO = 0.2, PANE_RATIO_MIN = 0.08, PANE_RATIO_MAX = 0.6, PANE_MIN = 48, PRICE_MIN = 120, PANE_GAP = 4;

/* ---------------------------------------------------------------- DOM styles */
const CSS = `
.ce-host{position:relative;overflow:hidden;outline:none}
.ce-host:focus-visible{box-shadow:inset 0 0 0 2px #B69CFF}
.ce-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:crosshair;user-select:none;-webkit-user-select:none}
.ce-live{position:absolute;top:4px;left:0;z-index:3;width:24px;height:22px;padding:0;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;color:#B69CFF;background:#1A1230;border:1px solid #3B2A6B;border-radius:6px;cursor:pointer}
.ce-live[hidden]{display:none}
.ce-live svg{width:12px;height:12px;display:block}
.ce-live:hover{color:#fff;border-color:#B69CFF}
.ce-lock{position:absolute;bottom:3px;z-index:3;width:24px;height:20px;padding:0;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;color:#7F8C9C;background:transparent;border:1px solid transparent;border-radius:5px;cursor:pointer}
.ce-lock svg{width:12px;height:12px;display:block}
.ce-lock:hover{color:#E6EDF5;border-color:#2A3645}
.ce-lock[aria-pressed="true"]{color:#B69CFF;background:#1A1230;border-color:#3B2A6B}
.ce-lock:focus-visible{outline:2px solid #B69CFF;outline-offset:1px}
.ce-live:focus-visible{outline:2px solid #B69CFF;outline-offset:2px}
.ce-theme{position:relative;display:inline-block}
.ce-theme-btn{font:500 12px "IBM Plex Sans",system-ui,sans-serif;color:var(--ce-text,#E6EDF5);background:var(--ce-s2,#0F151D);border:1px solid var(--ce-line,#2A3645);border-radius:8px;padding:4px 12px 4px 8px;min-height:30px;cursor:pointer;display:inline-flex;align-items:center;gap:8px}
.ce-theme-btn:hover{background:var(--ce-s3,#141C26)}
.ce-theme-btn:focus-visible,.ce-theme-panel button:focus-visible,.ce-theme-panel input:focus-visible{outline:2px solid var(--ce-accent,#B69CFF);outline-offset:2px}
.ce-sw2{display:inline-flex;gap:2px}.ce-sw2 i{width:8px;height:14px;border-radius:2px;display:block}
.ce-theme-panel{color-scheme:var(--ce-scheme,dark);position:absolute;top:calc(100% + 6px);right:0;z-index:20;width:268px;max-width:calc(100vw - 32px);box-sizing:border-box;background:var(--ce-panel,#0B1016);border:1px solid var(--ce-line,#2A3645);border-radius:12px;padding:12px;display:grid;gap:10px;box-shadow:var(--ce-shadow,0 12px 32px rgba(0,0,0,.45));font:13px "IBM Plex Sans",system-ui,sans-serif;color:var(--ce-text,#E6EDF5)}
.ce-theme-panel[hidden]{display:none}
.ce-theme-panel.ce-left{right:auto;left:0}
.ce-lbl{font:600 10px "IBM Plex Sans Condensed","IBM Plex Sans",sans-serif;letter-spacing:.12em;text-transform:uppercase;color:var(--ce-muted,#8392A5)}
.ce-presets{display:grid;gap:6px}
.ce-preset{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:var(--ce-s2,#0F151D);border:1px solid var(--ce-line-soft,#18212C);border-radius:8px;padding:6px 8px;color:var(--ce-text,#E6EDF5);font:500 12px "IBM Plex Sans",system-ui,sans-serif;cursor:pointer;min-height:32px}
.ce-preset[aria-pressed="true"]{border-color:var(--ce-tint-border,#3B2A6B);background:var(--ce-tint,#1A1230);color:var(--ce-tint-text,#D8CCFF)}
.ce-row{display:grid;grid-template-columns:64px 36px minmax(0,1fr);gap:8px;align-items:center}
.ce-row input[type=color]{width:36px;height:28px;padding:0;border:1px solid var(--ce-line,#2A3645);border-radius:6px;background:var(--ce-s2,#0F151D);cursor:pointer}
.ce-row input[type=text]{width:100%;box-sizing:border-box;min-width:0;background:var(--ce-s2,#0F151D);border:1px solid var(--ce-line,#2A3645);border-radius:6px;color:var(--ce-text,#E6EDF5);font:500 12px "IBM Plex Mono",ui-monospace,monospace;padding:5px 7px;min-height:28px}
.ce-reset{justify-self:start;background:transparent;border:1px solid var(--ce-line,#2A3645);border-radius:8px;color:var(--ce-text2,#9AA8B8);font:500 12px "IBM Plex Sans",system-ui,sans-serif;padding:4px 10px;min-height:30px;cursor:pointer}
.ce-note{font-size:11px;color:var(--ce-muted,#8392A5);line-height:1.4}
.ce-slot{display:grid;gap:10px}.ce-slot:empty{display:none}
.ce-grounds{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.ce-ground{display:flex;align-items:center;gap:8px;background:var(--ce-s2,#0F151D);border:1px solid var(--ce-line-soft,#18212C);border-radius:8px;padding:5px 8px;color:var(--ce-text,#E6EDF5);font:500 12px "IBM Plex Sans",system-ui,sans-serif;cursor:pointer;min-height:32px;text-align:left}
.ce-ground[aria-pressed="true"]{border-color:var(--ce-tint-border,#3B2A6B);background:var(--ce-tint,#1A1230);color:var(--ce-tint-text,#D8CCFF)}
.ce-ground:focus-visible{outline:2px solid var(--ce-accent,#B69CFF);outline-offset:2px}
.ce-ground i{width:16px;height:16px;border-radius:4px;flex:none;box-shadow:inset 0 0 0 1px rgba(154,168,184,.45)}
.ce-row input[type=text][aria-invalid="true"]{border-color:var(--ce-bad,#FF7A7A);box-shadow:inset 0 0 0 1px var(--ce-bad,#FF7A7A)}
.ce-divider{position:absolute;left:0;right:0;height:10px;z-index:2;cursor:row-resize;touch-action:none;outline:none}
.ce-divider[hidden]{display:none}
.ce-divider:hover,.ce-divider.is-drag,.ce-divider:focus-visible{background:linear-gradient(transparent 1px,rgba(182,156,255,.55) 1px,rgba(182,156,255,.55) 3px,transparent 3px)}
.ce-divider:focus-visible{box-shadow:inset 0 0 0 2px #B69CFF}
`;
function injectStyle() {
  if (typeof document === 'undefined' || document.getElementById('ce-style')) return;
  const s = document.createElement('style'); s.id = 'ce-style'; s.textContent = CSS; document.head.appendChild(s);
}

/* ---------------------------------------------------------------- the chart */
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/* ---------------------------------------------------------------- display helpers (1.14.0, Anthony's list) */
/** The empty room right of the last bar, in bars: `roomPx` CSS px at this bar spacing (so it stays the same on screen at
    any zoom), or the fixed bar count `bars` when no room in px is set (the engine's rightOffset, as before 1.14.0). */
function roomBars(roomPx, spacing, bars) {
  return roomPx === null || roomPx === undefined || !isFinite(roomPx) || !(spacing > 0) ? bars : Math.max(0, roomPx) / spacing;
}
/** The price scale the auto-fit eases to: the candles' low and high (mn, mx), widened to take in every price of
    `extra` (working orders, bracket legs, planned stop and target lines: they stay on screen), at least 8 ticks, with
    8% free at the top and 8% at the bottom (20% with the volume bars under the candles). `topPx` (1.14.0, Anthony: the
    high ran into the legend on the smaller panels): at least this many px free at the top (the legend's height and a
    few px; at most 45% of the plot). null when there is nothing. */
function fitRange(mn, mx, extra, plotH, tick, volume, topPx) {
  if (extra) for (let i = 0; i < extra.length; i++) { const p = extra[i]; if (isFinite(p) && p !== null) { if (p > mx) mx = p; if (p < mn) mn = p; } }
  if (!(mx >= mn) || !(plotH > 0)) return null;
  const minRange = (tick || Math.abs(mx) * 1e-4 || 1) * 8;
  const range = Math.max(mx - mn, minRange), mt = Math.min(0.45, Math.max(0.08, (topPx > 0 ? topPx : 0) / plotH)), mb = volume ? 0.2 : 0.08;
  const ppp = plotH * (1 - mt - mb) / range;
  return { hi: mx + plotH * mt / ppp, lo: mn - plotH * mb / ppp };
}
/** Time left in a bar, from whole seconds: "0:23", "4:05", "1:02:03", "2d 04h" (the price tag's countdown). */
function fmtRemain(remain) {
  remain = Math.max(0, Math.ceil(remain));
  if (remain >= DAY) return Math.floor(remain / DAY) + 'd ' + pad(Math.floor(remain % DAY / 3600)) + 'h';
  if (remain >= 3600) return Math.floor(remain / 3600) + ':' + pad(Math.floor(remain % 3600 / 60)) + ':' + pad(remain % 60);
  return Math.floor(remain / 60) + ':' + pad(remain % 60);
}
/** The time left in the bar that opened at `t` (bar time, exchange seconds) of `barSeconds`, at exchange time `now`. */
const barRemain = (t, barSeconds, now) => fmtRemain(t + barSeconds - now);
/**
 * The average true range of the closed bars (`bars[0..count-1]`, oldest first; the forming bar is left out), as
 * NinjaTrader's ATR: the true range of each bar (its high minus low, or to the previous close when that is further), the
 * first `period` averaged, then Wilder's smoothing ((period - 1) * ATR + TR) / period. null with fewer than `period` bars.
 */
function atr(bars, period, count) {
  const n = count === undefined ? bars.length : Math.min(count, bars.length);
  period = Math.max(1, Math.round(period || 14));
  if (n < period) return null;
  let sum = 0, a = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i], pc = i ? bars[i - 1].c : b.c;
    const tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    if (i < period) { sum += tr; if (i === period - 1) a = sum / period; }
    else a = ((period - 1) * a + tr) / period;
  }
  return a;
}
/**
 * The VWAP of 1-minute bars anchored at a time of day (1.14.0, the VWAP gear's "RTH only"): from `from` (09:30 ET) up to
 * `to` (16:00 ET) each trading day, each bar's typical price (high + low + close) / 3 times its volume, as addSessionVwap
 * works out the session's from 18:00 ET from bars. Returns { t, vw }: each bar's end time (t + barSeconds) and the VWAP as
 * of that end, for the bars inside the window only (sorted). vwapAt(series, time) reads it at a time (null outside).
 */
function rthVwap(bars, opts) {
  const o = Object.assign({ from: 34200, to: 57600, barSeconds: 60, sessionStart: 18 * 3600 }, opts || {});
  const t = [], vw = [];
  let day = null, pv = 0, vol = 0;
  for (const b of bars || []) {
    const s = tod(b.t);
    if (s < o.from || s >= o.to) continue;
    const d = tradeDay(b.t, o.sessionStart);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const v = b.v || 0; pv += (b.h + b.l + b.c) / 3 * v; vol += v;
    t.push(b.t + o.barSeconds); vw.push(vol > 0 ? pv / vol : b.c);
  }
  return { t, vw, from: o.from, to: o.to, sessionStart: o.sessionStart };
}
/** rthVwap() kept up to date as bars come (review D2: not every bar again each second): `series` from an earlier call
    (or null) and the same bars array grown or its last bar changed. The closed bars are added once; only the last bar
    (the forming one) is worked out again. Starts over when the bars are not the ones it saw (a reload, another view).
    Returns the series, the same as rthVwap(bars, opts) would. */
function rthVwapUpdate(series, bars, opts) {
  const o = Object.assign({ from: 34200, to: 57600, barSeconds: 60, sessionStart: 18 * 3600 }, opts || {});
  bars = bars || [];
  let S = series;
  const same = S && S.from === o.from && S.to === o.to && S.sessionStart === o.sessionStart && S.done <= bars.length &&
    (S.done === 0 || (bars[S.done - 1] && bars[S.done - 1].t === S.lastT));
  if (!same) S = { t: [], vw: [], from: o.from, to: o.to, sessionStart: o.sessionStart, done: 0, lastT: null, day: null, pv: 0, vol: 0, tail: false };
  if (S.tail) { S.t.pop(); S.vw.pop(); S.tail = false; }
  const add = (b, keep) => {
    const sec = tod(b.t);
    if (sec < o.from || sec >= o.to) return;
    const d = tradeDay(b.t, o.sessionStart);
    let pv = S.pv, vol = S.vol;
    if (d !== S.day) { pv = 0; vol = 0; }
    const v = b.v || 0; pv += (b.h + b.l + b.c) / 3 * v; vol += v;
    S.t.push(b.t + o.barSeconds); S.vw.push(vol > 0 ? pv / vol : b.c);
    if (keep) { S.day = d; S.pv = pv; S.vol = vol; } else S.tail = true;
  };
  for (; S.done < bars.length - 1; S.done++) add(bars[S.done], true);      // the closed bars, once
  S.lastT = S.done > 0 ? bars[S.done - 1].t : null;
  if (bars.length) add(bars[bars.length - 1], false);                     // the last bar, again each time
  return S;
}
/** The anchored VWAP of rthVwap() at `time` (a bar's end): the value of the last bar ending at or before it in the same
    window of the same day, or null outside the window or before its first bar. */
function vwapAt(series, time) {
  const T = series.t;
  let lo = 0, hi = T.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (T[m] <= time + 1e-3) { k = m; lo = m + 1; } else hi = m - 1; }
  if (k < 0) return null;
  const end = time - 1e-3, s = tod(end);                                       // a millisecond before the bar's end
  if (s < series.from || s >= series.to) return null;                         // outside RTH (a bar ending at 16:00 is in)
  if (tradeDay(T[k] - 1e-3, series.sessionStart) !== tradeDay(end, series.sessionStart)) return null;
  return series.vw[k];
}
/** A large-order bubble's radius in CSS px (1.14.0, Anthony from WORK: "bubble size must show the order size"): the area
    follows the size against the floor, so radius = 4.8 px x sqrt(size / floor): 4.8 px at the floor, 6.8 at twice it,
    9.6 at four times, 15.2 at ten times, 27 px at most (about 32 times the floor). */
const BUBBLE_R_MIN = 4.8, BUBBLE_R_MAX = 27;
function bubbleRadius(size, floor) {
  const f = floor > 0 ? floor : 1, k = size > 0 ? size / f : 1;
  return Math.min(BUBBLE_R_MAX, BUBBLE_R_MIN * Math.sqrt(Math.max(1, k)));
}
/** The percent change of `price` from `base` (the prior settlement), or null when either is missing (never estimated). */
function pctFrom(price, base) {
  return typeof price === 'number' && typeof base === 'number' && isFinite(price) && isFinite(base) && base > 0 ? (price - base) / base * 100 : null;
}

/* ---------------------------------------------------------------- higher-timeframe bars (1.15.0, ChartBridge 0.3.7 htf) */
/* NinjaTrader's own 4h, 1D and 1W bars, stamped as nt8/PROTOCOL.md "Higher-timeframe bars" says (bar-time seconds, New
   York wall clock): a 4h bar starts at 18:00, 22:00, 02:00, 06:00, 10:00 or 14:00 ET (the last of a session runs to the
   17:00 close); a 1D bar is its trading day at 00:00 (the date the session ends on: Sunday 18:00 belongs to Monday); a 1W
   bar is the Monday of its week at 00:00. */
const HTF_SECONDS = { '4h': 4 * 3600, '1D': DAY, '1W': 7 * DAY };
const HTF_SESSION = 18 * 3600, HTF_CLOSE = 17 * 3600;
/** The start of the htf bar (`tf` '4h', '1D' or '1W') a trade at bar time `t` belongs to. */
function htfStart(t, tf) {
  if (tf === '4h') return Math.floor((t - 2 * 3600) / (4 * 3600)) * 4 * 3600 + 2 * 3600;   // 18:00 is 2 h past a multiple of 4 h
  const d = tradeDay(t, HTF_SESSION);
  if (tf === '1D') return d * DAY;
  if (tf === '1W') return (d - ((d + 3) % 7)) * DAY;               // day 0 (1970-01-01) was a Thursday: Monday is 3 days before
  return NaN;
}
/** When the htf bar that starts at `start` ends: 4 h on (the 14:00 bar at the 17:00 close), the trading day's 17:00, the
    week's Friday 17:00 (an early close on a holiday is not known here). */
function htfEnd(start, tf) {
  if (tf === '4h') return tod(start) === 14 * 3600 ? start + 3 * 3600 : start + 4 * 3600;
  if (tf === '1D') return start + HTF_CLOSE;
  if (tf === '1W') return start + 4 * DAY + HTF_CLOSE;
  return NaN;
}
/**
 * Where the corner readout goes (1.15.0, Anthony: "a small, quiet readout in one corner of each chart"): `w` x `h` CSS px at
 * the bottom right of the plot, 6 px in, moved up past each box it would overlap (order labels, the VWAP's marker); when
 * that runs past `top` (the legend's room), the top right instead, moved down past the boxes. null when neither is free.
 */
function cornerPlace(plotW, plotH, w, h, boxes, top) {
  const x = plotW - 6 - w, lim = Math.max(0, top || 0), list = (boxes || []).filter(Boolean);
  const hit = y => list.find(b => x < b.x + b.w + 3 && x + w + 3 > b.x && y < b.y + b.h + 3 && y + h + 3 > b.y);
  if (x < 0 || plotH < h + 12) return null;
  for (let y = plotH - 6 - h, k = 0; y >= lim && k < 40; k++) { const b = hit(y); if (!b) return { x, y }; y = b.y - 4 - h; }
  for (let y = lim + 6, k = 0; y + h <= plotH - 6 && k < 40; k++) { const b = hit(y); if (!b) return { x, y }; y = b.y + b.h + 4; }
  return null;
}

function create(container, options) {
  if (!container) throw new Error('ChartEngine.create needs a container element');
  const opt = options || {};
  const o = {
    barSeconds: opt.barSeconds || 60,
    precision: opt.precision !== undefined ? opt.precision : 2,
    tick: opt.tick !== undefined ? opt.tick : 0.25,
    rightOffset: opt.rightOffset !== undefined ? opt.rightOffset : 8,
    room: opt.room !== undefined && opt.room !== null && isFinite(opt.room) ? Math.max(0, +opt.room) : null,   // 1.14.0: room right in CSS px
    grid: opt.grid !== false,                                                                           // 1.14.0: grid lines (the live page: off by default)
    fitOrders: opt.fitOrders !== false,                                                                 // 1.14.0: the auto-fit keeps orders on screen
    fitTop: opt.fitTop > 0 ? +opt.fitTop : 0,                                                          // 1.14.0: px kept free at the top (the page's legend)
    barSpacing: opt.barSpacing || 7,
    minSpacing: opt.minSpacing || 0.6,
    maxSpacing: opt.maxSpacing || 48,
    axisWidth: opt.axisWidth || 78,
    timeAxisHeight: opt.timeAxisHeight || 26,
    session: Object.assign({ start: 18 * 3600, rthStart: 34200, rthEnd: 57600 }, opt.session || {}),
    layers: Object.assign({ volume: true, vwap: true, levels: true, trades: true, ib: true, vp: false, delta: false, absorption: false, bubbles: false, divergence: false }, opt.layers || {}),
    motion: Object.assign({ zoom: 75, fit: 120, candle: 55, follow: 110, friction: 325 }, opt.motion || {}),
    clock: opt.clock || (() => zoneSeconds(Date.now() / 1000, opt.timeZone || 'America/New_York')),
    liveButton: opt.liveButton !== false,
    lockButton: opt.lockButton !== undefined ? opt.lockButton !== false : opt.liveButton !== false,
    unit: opt.unit !== undefined ? opt.unit : 'pt',
    pointValue: opt.pointValue || 0,
    compactLabels: opt.compactLabels === true,                                                        // 1.15.0: short order labels, the full one on hover
    toolOrders: opt.toolOrders === true,                                                              // 1.15.0: Shift and Ctrl clicks place orders while a tool is armed
    spacedDays: opt.spacedDays === true,                                                              // 1.15.0: day labels never drawn over each other (4h, 1h)
  };
  injectStyle();
  const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const approach = (cur, tgt, dt, tau) => (REDUCED || tau <= 0) ? tgt : tgt + (cur - tgt) * Math.exp(-dt / tau);

  container.classList.add('ce-host');
  if (!container.hasAttribute('tabindex')) container.tabIndex = 0;
  if (opt.ariaLabel) container.setAttribute('aria-label', opt.ariaLabel);
  const cv = document.createElement('canvas'); cv.className = 'ce-canvas'; container.appendChild(cv);
  const ctx = cv.getContext('2d', { alpha: false });
  let liveBtn = null;
  if (o.liveButton) {
    /* 1.14.0 (Anthony): a small icon at the top of the price scale, not a pill over the plot; placed each frame where no
       price, order or level tag is (placeLive) */
    liveBtn = document.createElement('button'); liveBtn.type = 'button'; liveBtn.className = 'ce-live';
    liveBtn.title = 'Jump to live (End)'; liveBtn.setAttribute('aria-label', 'Jump to live (End)');
    liveBtn.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2.25 7.25 6 2 9.75z" fill="currentColor"/><rect x="8.25" y="2.25" width="1.75" height="7.5" rx=".5" fill="currentColor"/></svg>';
    liveBtn.hidden = true; container.appendChild(liveBtn);
  }
  /* 1.14.0 (Anthony, review D2): the price scale lock, in the corner under the price axis (no layout room, never over a
     tag): locked, a price zoom set by hand is kept (the auto-fit does not take over near the edge, nor on scrolling back
     to the live edge) until it is unlocked, End or Jump to live */
  let lockBtn = null, scaleLocked = false;
  if (o.lockButton) {
    lockBtn = document.createElement('button'); lockBtn.type = 'button'; lockBtn.className = 'ce-lock';
    lockBtn.style.right = Math.round((o.axisWidth - 24) / 2) + 'px';
    container.appendChild(lockBtn);
  }
  function syncLock() {
    if (!lockBtn) return;
    lockBtn.setAttribute('aria-pressed', String(scaleLocked));
    const t = scaleLocked ? 'Price scale locked: a zoom set by hand is kept (click to unlock; End or Jump to live also fit it again)' : 'Lock the price scale: keep a zoom set by hand as price moves';
    lockBtn.title = t; lockBtn.setAttribute('aria-label', scaleLocked ? 'Price scale locked' : 'Lock the price scale');
    lockBtn.innerHTML = scaleLocked
      ? '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="5.25" width="8" height="5.75" rx="1" fill="currentColor"/><path d="M3.75 5.5V3.75a2.25 2.25 0 0 1 4.5 0V5.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>'
      : '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="5.25" width="8" height="5.75" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3.75 5.5V3.75a2.25 2.25 0 0 1 4.4-.7" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
  }
  syncLock();
  /* The divider between the plot and the delta pane (1.7.0): drag it, or focus it and use the arrow keys. */
  const divEl = document.createElement('div');
  divEl.className = 'ce-divider'; divEl.hidden = true; divEl.tabIndex = 0;
  divEl.setAttribute('role', 'separator'); divEl.setAttribute('aria-orientation', 'horizontal');
  divEl.setAttribute('aria-label', 'Delta pane height: drag, or use the up and down arrow keys');
  divEl.setAttribute('aria-valuemin', String(Math.round(PANE_RATIO_MIN * 100))); divEl.setAttribute('aria-valuemax', String(Math.round(PANE_RATIO_MAX * 100)));
  container.appendChild(divEl);

  let themeSrc = Object.assign({}, DEFAULT_THEME, opt.theme || {});   // the colors as chosen; T is what draws
  let T = buildTheme(themeSrc), themeBuilds = 1;
  let bars = [], levels = [], trades = [], markers = [], paused = false, countdownFn = null;
  /* The volume profile (1.6.0): a VolumeProfile the page keeps feeding; drawn while the 'vp' layer is on. The
     bars are built by profileRects once per change of the profile, the view or the size, and kept as three lists of
     rectangles (rest, value area, POC) that each frame fills with fillRect. */
  let profile = null, vpBars = null, vpBuilds = 0;
  /* The delta pane (1.7.0): a CumulativeDelta the page keeps feeding, drawn in a pane below the plot while the 'delta'
     layer is on, on the plot's own bars, so it shares their x axis, scrolling, zoom and crosshair. `pane` is its view:
     mode 'cum' (candles of the running cumulative) or 'bar' (each bar's own delta around zero), the share of the
     chart's height it asks for, a note drawn instead of anything else (the page's "Delta needs ChartBridge 0.3.4 on
     this PC"), and its own eased value scale. */
  let delta = null;
  /* Chart signals (G1c): { absorption (an Absorption), bubbles (a LargePrints), divergence (a DeltaDivergence), version }
     the page keeps feeding; each drawn while its layer is on (the arrows with the delta pane). */
  let signals = null, sigVer = -1;
  const pane = { mode: 'cum', ratio: PANE_RATIO, note: '', reason: '', missed: 0, title: '', lo: -1, hi: 1, init: false, ver: -1, drag: null, tkey: '', tclosed: null, cid: 0, cc: null, widths: new Map() };
  /* Levels as drawn: on a ground other than the default each level's color is moved until its name reads (1.5.3).
     Rebuilt when the levels or the theme change, never per frame. A level with `layer` ('ib') shows with that layer,
     the rest with 'levels'. */
  let levelsShown = [];
  function shadeLevels() {
    levelsShown = levels.map(L => Object.assign({}, L, { color: T.ground === 'default' ? L.color : markOnGround(L.color || T.axisText, T.bg, FLOOR.text, T.to) }));
    // the IB high stays the brighter of the pair on every ground, and with the page's own colors (1.9.0): on the default
    // ground its colors are drawn as they are unless the high is not the brighter
    const hi = levelsShown.find(L => L.tone === 'high'), lo = levelsShown.find(L => L.tone === 'low');
    if (!hi || !lo) return;
    const h0 = levels[levelsShown.indexOf(hi)].color, l0 = levels[levelsShown.indexOf(lo)].color;
    if (T.ground === 'default' && parseColor(h0) && parseColor(l0) && luminance(parseColor(h0)) > luminance(parseColor(l0)) && contrast(h0, l0) >= PAIR.contrast) return;
    if (parseColor(h0) && parseColor(l0)) [hi.color, lo.color] = ibPair(h0, l0, T.bg, T.to);
  }
  const levelOn = L => !!o.layers[L.layer || 'levels'];
  let drawings = [], tool = null, selectedId = null, dd = null, draft = null;
  /* 1.15.0: the corner readout (the page's text, drawn at the plot's bottom right, cornerPlace) and the order label under
     the mouse (a host's compact labels show the full one on hover) */
  let cornerText = '', cornerShort = '', cornerAt = null, labelHover = null;
  // working orders and the position (1.3.0): shown always; moved, cancelled and placed only while editing is on
  let orders = [], position = null, orderEditing = false, orderPreview = null, shiftHeld = false;
  let od = null, xDown = null, addDown = null, orderHits = [];
  const pendingMoves = new Map();          // order id -> price asked for, until the next setOrders
  const listeners = { bubble: [], legend: [], live: [], drawings: [], tool: [], orderMove: [], orderCancel: [], orderPlace: [], orderPlanAdd: [], orderPressOff: [], error: [], paneResize: [], scaleLock: [] };
  const emit = (ev, arg) => { for (const fn of listeners[ev]) { try { fn(arg); } catch (e) { setTimeout(() => { throw e; }); } } };

  const AXIS_W = o.axisWidth, TIME_H = o.timeAxisHeight;
  let dpr = 1, W = 0, H = 0, plotW = 0, plotH = 0;
  /* With the delta pane: the price plot is 0 to plotH, the pane paneTop to paneTop + paneH, the time axis from timeY.
     With no pane the time axis starts at plotH, as it always did. */
  let paneTop = 0, paneH = 0, timeY = 0;
  const paneOn = () => !!o.layers.delta;
  const V = {
    spacing: o.barSpacing, logS: Math.log(o.barSpacing), logT: Math.log(o.barSpacing), right: 0,
    follow: true, anchor: null, kin: null, auto: true, lo: 0, hi: 1, init: false, edgeKey: '',
  };
  const disp = { c: 0, h: 0, l: 0, n: -1 };
  let hover = null, drag = null, dirty = true, flash = 0, pulseT0 = -1e9, lastSec = -1, hoverIdx = null;
  const pointers = new Map(); let pinch = null;
  let wasLive = true, legendKey = '';

  const last = () => bars.length - 1;
  const indexAt = x => V.right - (plotW - x) / V.spacing;
  const xOf = i => plotW - (V.right - i) * V.spacing;
  const yOf = p => (V.hi - p) / (V.hi - V.lo) * plotH;
  const crisp = (v, lw) => { const d = Math.round(v * dpr); return (lw % 2 ? d + 0.5 : d) / dpr; };
  /* Trade side colors keep their hue on every ground; ringOf / haloOf give the outline (marks, lines) or halo (text)
     color a side color needs on this ground, or null (always null on the default ground). */
  const ringOf = col => col === T.long ? T.ring.long : col === T.short ? T.ring.short : null;
  const haloOf = col => col === T.long ? T.halo.long : col === T.short ? T.halo.short : null;
  function inkText(text, x, y, col) {
    const h = haloOf(col);
    if (h) { ctx.strokeStyle = h; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.setLineDash([]); ctx.strokeText(text, x, y); }
    ctx.fillStyle = col; ctx.fillText(text, x, y);
  }
  const roomNow = () => roomBars(o.room, V.spacing, o.rightOffset);
  const followRight = () => last() + roomNow();
  const sessionOf = t => tradeDay(t, o.session.start);
  const isSessionStart = i => i > 0 && o.barSeconds < DAY && sessionOf(bars[i].t) !== sessionOf(bars[i - 1].t);
  const isRTH = t => { if (o.session.rthStart === null || o.session.rthStart === undefined) return false; const s = tod(t); return s >= o.session.rthStart && s < o.session.rthEnd; };
  function idxAtTime(t) {
    if (!bars.length) return -1;
    let lo = 0, hi = bars.length - 1;
    if (t < bars[0].t) return 0;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bars[mid].t <= t) lo = mid; else hi = mid - 1; }
    return lo;
  }
  /* merged fill marks, rebuilt only when the fills, the bars or the tick change (not every frame) */
  let fillCache = { markers: null, bars: null, count: -1, tick: null, marks: [] };
  function fillMarks() {
    const c = fillCache;
    if (c.markers !== markers || c.bars !== bars || c.count !== bars.length || c.tick !== o.tick)
      fillCache = { markers, bars, count: bars.length, tick: o.tick, marks: groupFills(markers, idxAtTime, o.tick) };
    return fillCache.marks;
  }
  /* fractional bar index for any time, extrapolating past either end at barSeconds per bar */
  function idxOfTime(t) {
    const n = bars.length; if (!n) return 0;
    const bs = o.barSeconds;
    if (t <= bars[0].t) return (t - bars[0].t) / bs;
    if (t >= bars[n - 1].t) return n - 1 + (t - bars[n - 1].t) / bs;
    const i = idxAtTime(t), a = bars[i].t, b = bars[i + 1].t;
    return i + (b > a ? (t - a) / (b - a) : 0);
  }
  function timeOfIdx(x) {
    const n = bars.length; if (!n) return 0;
    const bs = o.barSeconds;
    if (x <= 0) return bars[0].t + x * bs;
    if (x >= n - 1) return bars[n - 1].t + (x - (n - 1)) * bs;
    const i = Math.floor(x), f = x - i;
    return bars[i].t + (bars[i + 1].t - bars[i].t) * f;
  }
  const priceAt = y => V.hi - y / plotH * (V.hi - V.lo);
  const genId = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const k = len ? clamp(((px - ax) * dx + (py - ay) * dy) / len, 0, 1) : 0;
    return Math.hypot(px - (ax + k * dx), py - (ay + k * dy));
  }
  function hitDrawing(p) {
    for (let k = drawings.length - 1; k >= 0; k--) {
      const d = drawings[k];
      if (d.type === 'hline') { if (Math.abs(yOf(d.price) - p.y) <= 5) return { d, part: 'body' }; }
      else if (d.type === 'trend') {
        const ax = xOf(idxOfTime(d.a.t)), ay = yOf(d.a.p), bx = xOf(idxOfTime(d.b.t)), by = yOf(d.b.p);
        if (Math.hypot(p.x - ax, p.y - ay) <= 7) return { d, part: 'a' };
        if (Math.hypot(p.x - bx, p.y - by) <= 7) return { d, part: 'b' };
        if (distToSeg(p.x, p.y, ax, ay, bx, by) <= 5) return { d, part: 'body' };
      } else if (d.type === 'zone') {
        /* 1.15.0: a corner resizes it, an edge moves it; the inside only once it is selected, so a pan over a big zone
           stays a pan */
        const r = zoneRect(d), xs = [r.x0, r.x1], ys = [r.y0, r.y1];
        for (const cx of xs) for (const cy of ys) if (Math.hypot(p.x - cx, p.y - cy) <= 7) return { d, part: (cx === r.xa ? 'a' : 'b') + (cy === r.ya ? 'a' : 'b') };
        const inX = p.x >= r.x0 - 5 && p.x <= r.x1 + 5, inY = p.y >= r.y0 - 5 && p.y <= r.y1 + 5;
        const onEdge = (inY && (Math.abs(p.x - r.x0) <= 5 || Math.abs(p.x - r.x1) <= 5)) || (inX && (Math.abs(p.y - r.y0) <= 5 || Math.abs(p.y - r.y1) <= 5));
        if (onEdge || (d.id === selectedId && inX && inY)) return { d, part: 'body' };
      }
    }
    return null;
  }
  /* A zone's rectangle on screen: its corners a and b (xa, ya, xb, yb) and its edges (x0 < x1, y0 < y1). */
  function zoneRect(d) {
    const xa = xOf(idxOfTime(d.a.t)), ya = yOf(d.a.p), xb = xOf(idxOfTime(d.b.t)), yb = yOf(d.b.p);
    return { xa, ya, xb, yb, x0: Math.min(xa, xb), x1: Math.max(xa, xb), y0: Math.min(ya, yb), y1: Math.max(ya, yb) };
  }
  /* order label, close handle or axis tag under the pointer (only while order editing is on; `any`: also while it is off,
     1.15.0, for the note that says why a press does nothing and for a compact label's hover) */
  function hitOrder(p, any) {
    if (!orderEditing && !any) return null;
    const inR = r => r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    for (let k = orderHits.length - 1; k >= 0; k--) if (inR(orderHits[k].xbox)) return { id: orderHits[k].id, part: 'x' };
    for (let k = orderHits.length - 1; k >= 0; k--) for (const a of orderHits[k].adds || []) if (inR(a.box)) return { id: orderHits[k].id, part: 'add', which: a.which };
    for (let k = orderHits.length - 1; k >= 0; k--) if (inR(orderHits[k].box) || inR(orderHits[k].tag)) return { id: orderHits[k].id, part: 'body' };
    return null;
  }
  const orderPrice = ord => {
    if (od && od.id === ord.id) return od.price;
    if (pendingMoves.has(ord.id)) return pendingMoves.get(ord.id);
    // 1.13.0: a planned stop or target is ticks from its entry, so it travels with the entry while that is dragged
    const parent = ord.plan ? orders.find(x => x.id === ord.plan.parent) : null;
    return parent ? roundTo(orderPrice(parent) + ord.plan.offset * o.tick, o.tick) : ord.price;
  };
  const cloneDrawing = d => JSON.parse(JSON.stringify(d));
  function drawingsChanged() { emit('drawings', drawings.map(cloneDrawing)); }
  function setToolInternal(t) { if (tool !== t) { tool = t; draft = null; emit('tool', tool); } dirty = true; }
  function finishDraft() {
    const d = draft; draft = null;
    if (!d) return;
    const sameT = Math.abs(d.a.t - d.b.t) < 1e-6, sameP = Math.abs(d.a.p - d.b.p) < 1e-9;
    // a zone (1.15.0) needs two prices and two times; a trend line two different points
    const same = d.type === 'zone' ? sameT || sameP : sameT && sameP;
    if (!same) { drawings.push({ id: d.id, type: d.type === 'zone' ? 'zone' : 'trend', a: d.a, b: d.b }); selectedId = d.id; drawingsChanged(); }
    setToolInternal(null);
  }

  function clampRight() {
    const vis = plotW / V.spacing;
    const lo = Math.min(10, Math.max(0, last())), hi = last() + Math.max(roomNow(), vis * 0.5);
    const r = clamp(V.right, lo, hi);
    const hit = r !== V.right; V.right = r; return hit;
  }
  function setFollowFromPosition() { V.follow = V.right >= followRight() - 0.5; }
  function resetDisp() {
    const b = bars[last()];
    if (b) { disp.c = b.c; disp.h = b.h; disp.l = b.l; }
    disp.n = bars.length;
  }

  function resize() {
    const r = container.getBoundingClientRect();
    dpr = Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    W = Math.max(50, r.width); H = Math.max(50, r.height);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    plotW = Math.max(10, W - AXIS_W); layout();
    clampRight(); dirty = true;
  }
  /* The heights of the plot, the delta pane and the band between them (see PANE_RATIO). */
  function layout() {
    const area = H - TIME_H;
    if (!paneOn()) {
      plotH = Math.max(10, H - TIME_H); paneTop = plotH; paneH = 0; timeY = plotH; divEl.hidden = true;
      return;
    }
    const least = Math.min(PANE_MIN, Math.floor(area * 0.3)), most = Math.max(least, area - PANE_GAP - PRICE_MIN);
    paneH = Math.max(0, Math.round(clamp(area * pane.ratio, least, most)));
    plotH = Math.max(10, area - PANE_GAP - paneH);
    paneTop = plotH + PANE_GAP; timeY = paneTop + paneH;
    divEl.hidden = false;
    // the band starts where the plot ends (its last row, order tags there and the wheel stay the plot's) and stops at
    // the price axis: the 4 px gap and the top 6 px of the pane (review N2)
    divEl.style.top = Math.round(plotH) + 'px'; divEl.style.right = AXIS_W + 'px';
    divEl.setAttribute('aria-valuenow', String(Math.round(pane.ratio * 100)));
    divEl.setAttribute('aria-valuetext', 'Delta pane ' + Math.round(pane.ratio * 100) + '% of the chart height');
  }
  /* A new height for the pane from a drag or a key: kept between PANE_RATIO_MIN and PANE_RATIO_MAX, then to what the
     pixel limits allow, so what is saved is what is seen. Nothing changes and nothing is saved when the pane would not
     move (review N7: a key on a chart too short for the height asked, where the pixel limits hold it, must not save
     that limited height over the one chosen on a larger screen). Returns whether it moved. */
  function setPaneRatio(r, done) {
    const area = H - TIME_H;
    if (!(isFinite(r) && area > 0) || !paneOn()) return false;
    const before = { ratio: pane.ratio, h: paneH };
    pane.ratio = clamp(r, PANE_RATIO_MIN, PANE_RATIO_MAX);
    layout();
    if (paneH === before.h) { pane.ratio = before.ratio; layout(); return false; }
    pane.ratio = Math.round(clamp(paneH / area, PANE_RATIO_MIN, PANE_RATIO_MAX) * 1000) / 1000;
    layout(); clampRight(); dirty = true;
    emit('paneResize', { ratio: pane.ratio, height: paneH, done: !!done });
    return true;
  }

  function autoTarget() {
    const n = last(); if (n < 0) return null;
    const from = Math.max(0, Math.floor(indexAt(0))), to = Math.min(n, Math.ceil(indexAt(plotW)));
    if (to < from) return null;
    let mn = Infinity, mx = -Infinity;
    // 1.14.0 (Anthony): the VWAP no longer sizes the chart (one far from price squashed the candles); it draws off the
    // scale with an edge marker instead
    for (let i = from; i <= to; i++) {
      // the forming bar: its real high and low too (1.14.0), so the scale makes room before the candle eases up to them
      const b = bars[i], h = i === n ? Math.max(disp.h, b.h) : b.h, l = i === n ? Math.min(disp.l, b.l) : b.l;
      if (h > mx) mx = h; if (l < mn) mn = l;
    }
    // 1.14.0 (Anthony, "zoom to brackets"): working orders, the position's stop and target and the planned stop and
    // target lines are always on screen, eased in with the axis re-fit like any other change of the range
    if (o.fitOrders && orders.length) for (let k = 0; k < orders.length; k++) { const p = fitPrice(orders[k]); if (p > mx) mx = p; if (p < mn) mn = p; }
    return fitRange(mn, mx, null, plotH, o.tick, o.layers.volume, o.fitTop);
  }
  /* An order's price for the auto-fit: as confirmed, or as asked for while a move waits for its answer; a planned line
     from its entry's. Never the price under a drag in progress, so the scale holds still under the pointer. */
  function fitPrice(ord) {
    if (pendingMoves.has(ord.id)) return pendingMoves.get(ord.id);
    if (ord.plan) {
      for (let k = 0; k < orders.length; k++) if (orders[k].id === ord.plan.parent) {
        const pp = pendingMoves.has(orders[k].id) ? pendingMoves.get(orders[k].id) : orders[k].price;
        return roundTo(pp + ord.plan.offset * o.tick, o.tick);
      }
    }
    return ord.price;
  }

  /* The delta pane's value range for the bars in view (1.7.0): the lows and highs of the candles, or with bar delta
     each bar's delta and zero; 12% free at the top and bottom. null with nothing to show. */
  function paneTarget() {
    const n = last(); if (n < 0 || !delta || !delta.bars.length) return null;
    const from = Math.max(0, Math.floor(indexAt(0))), to = Math.min(n, Math.ceil(indexAt(plotW)));
    if (to < from) return null;
    // the closed bars' range is kept until the bars in view, the mode or the candles change (review N4); only the
    // newest bar, the one trades still move, is read on every frame
    const key = pane.cid + '|' + from + '|' + to + '|' + pane.mode + '|' + bars.length + '|' + bars[from].t + '|' + delta.bars.length;
    if (pane.tkey !== key) { pane.tkey = key; pane.tclosed = paneTargetScan(from, Math.min(to, n - 1)); }
    let mn = pane.tclosed.mn, mx = pane.tclosed.mx;
    const d = to === n ? delta.last : null, bar = pane.mode === 'bar';
    if (d && d.t === bars[n].t) {
      if (bar) { const v = d.c - d.o; if (v < mn) mn = v; if (v > mx) mx = v; } else { if (d.l < mn) mn = d.l; if (d.h > mx) mx = d.h; }
    }
    if (mn > mx) return null;
    if (bar) { mn = Math.min(0, mn); mx = Math.max(0, mx); }
    const range = Math.max(mx - mn, 4), m = 0.12;
    return { hi: mx + range * m / (1 - 2 * m), lo: mn - range * m / (1 - 2 * m) };
  }
  /* The lows and highs (or bar deltas) of the candles on bars from..to. */
  function paneTargetScan(from, to) {
    const db = delta.bars, bar = pane.mode === 'bar';
    let mn = Infinity, mx = -Infinity;
    if (to < from) return { mn, mx };
    let k = delta.lowerBound(bars[from].t);
    for (let i = from; i <= to && k < db.length; i++) {
      const t = bars[i].t;
      while (k < db.length && db[k].t < t) k++;
      if (k >= db.length || db[k].t !== t) continue;
      const d = db[k];
      if (bar) { const v = d.c - d.o; if (v < mn) mn = v; if (v > mx) mx = v; }
      else { if (d.l < mn) mn = d.l; if (d.h > mx) mx = d.h; }
    }
    return { mn, mx };
  }

  /* one animation step; true while something is still moving */
  function step(dt, now) {
    let moving = false;
    const n = last();
    if (disp.n !== bars.length) resetDisp();
    if (n >= 0) {
      const b = bars[n], eps = (o.tick || 1e-6) * 0.016;
      if (disp.c !== b.c || disp.h !== b.h || disp.l !== b.l) {
        disp.c = approach(disp.c, b.c, dt, o.motion.candle); disp.h = approach(disp.h, b.h, dt, o.motion.candle); disp.l = approach(disp.l, b.l, dt, o.motion.candle);
        if (Math.abs(disp.c - b.c) < eps) disp.c = b.c;
        if (Math.abs(disp.h - b.h) < eps) disp.h = b.h;
        if (Math.abs(disp.l - b.l) < eps) disp.l = b.l;
        moving = true;
      }
    }
    if (V.logS !== V.logT) {
      const atEdge = V.follow && !V.anchor && V.right === followRight();   // room in px (1.14.0): the live edge stays put
      V.logS = approach(V.logS, V.logT, dt, o.motion.zoom);
      if (Math.abs(V.logS - V.logT) < 1e-4) V.logS = V.logT;
      V.spacing = Math.exp(V.logS);
      if (V.anchor && !V.follow) V.right = V.anchor.i + (plotW - V.anchor.x) / V.spacing;
      else if (atEdge) V.right = followRight();
      if (V.logS === V.logT) V.anchor = null;
      clampRight(); moving = true;
    }
    if (V.kin) {
      V.right += V.kin.v * dt;
      V.kin.v *= Math.exp(-dt / o.motion.friction);
      if (clampRight() || Math.abs(V.kin.v * V.spacing) < 0.02) { V.kin = null; setFollowFromPosition(); }
      moving = true;
    } else if (V.follow && !drag && !pinch) {
      const tr = followRight();
      if (V.right !== tr) { V.right = approach(V.right, tr, dt, o.motion.follow); if (Math.abs(V.right - tr) < 1e-3) V.right = tr; moving = true; }
    }
    /* 1.14.0 (Anthony, live on 1.13.0: "price keeps running up into the header"): a price scale zoomed or moved by hand
       stays as set while the price is inside it, but once a new trade takes the forming bar within 12 px of the header
       (or of the bottom) while following live, the auto-fit takes over again, eased as ever. */
    if (n >= 0) {
      const b = bars[n], key = bars.length + '|' + b.h + '|' + b.l + '|' + b.c;
      if (key !== V.edgeKey) {                                   // a new trade (never a change made by hand)
        V.edgeKey = key;
        if (!V.auto && !scaleLocked && V.follow && V.init && !drag && !od && !pinch) {
          const yh = yOf(Math.max(b.h, disp.h)), yl = yOf(Math.min(b.l, disp.l));
          if (yh < (o.fitTop || 0) + 12 || yl > plotH - 12) V.auto = true;
        }
      }
    }
    /* while an order is dragged the price scale holds still (review D2): no easing, no re-fit for a new order or trade,
       so the line stays under the pointer and the price sent is the price drawn; after the drop it eases on as before */
    if (V.auto && !od) {
      const t = autoTarget();
      if (t) {
        if (!V.init) { V.lo = t.lo; V.hi = t.hi; V.init = true; moving = true; }
        else if (V.lo !== t.lo || V.hi !== t.hi) {
          V.lo = approach(V.lo, t.lo, dt, o.motion.fit); V.hi = approach(V.hi, t.hi, dt, o.motion.fit);
          const eps = (V.hi - V.lo) * 1e-5;
          if (Math.abs(V.lo - t.lo) < eps) V.lo = t.lo;
          if (Math.abs(V.hi - t.hi) < eps) V.hi = t.hi;
          moving = true;
        }
      }
    }
    if (flash && now - flash < 400) moving = true;
    if (now - pulseT0 < 500) moving = true;
    if (profile && o.layers.vp && (!vpBars || vpBars.ver !== profile.version)) dirty = true;   // new trades, a new session
    if (signals && signals.version !== sigVer) { sigVer = signals.version; dirty = true; }       // a signal came, grew or went
    if (paneOn() && delta && !pane.note) {
      if (delta.version !== pane.ver) { pane.ver = delta.version; dirty = true; }            // new trades
      const t = paneTarget();
      if (t) {
        if (!pane.init) { pane.lo = t.lo; pane.hi = t.hi; pane.init = true; moving = true; }
        else if (pane.lo !== t.lo || pane.hi !== t.hi) {
          pane.lo = approach(pane.lo, t.lo, dt, o.motion.fit); pane.hi = approach(pane.hi, t.hi, dt, o.motion.fit);
          const eps = (pane.hi - pane.lo) * 1e-5;
          if (Math.abs(pane.lo - t.lo) < eps) pane.lo = t.lo;
          if (Math.abs(pane.hi - t.hi) < eps) pane.hi = t.hi;
          moving = true;
        }
      }
    }
    const sec = Math.floor(o.clock());
    if (sec !== lastSec) { lastSec = sec; dirty = true; }
    return moving;
  }

  /* The developing POC, VAH and VAL of the profile on the chart (1.14.0, Anthony): solid lines across the plot (the prior
     day's levels are dashed), the POC 1.5 px in its gold, the value area's edges 1 px in the secondary text color, each
     named at the left of the profile ("dPOC", "dVAH", "dVAL", 600 10px Condensed). From the profile's columns, which it
     keeps per version: nothing is walked per frame. */
  function drawProfileLines() {
    const c = profile.columns();
    if (!c || c.max <= 0) return;
    const xl = plotW * (1 - VP_WIDTH) - 6;
    ctx.font = '600 10px ' + T.fontCond; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.setLineDash([]);
    const one = (on, row, name, col, w) => {
      if (!on || row === null || row === undefined || row < 0) return;
      const price = c.low + row * c.step, y = crisp(yOf(price), w);
      if (y < -2 || y > plotH + 2) return;
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.globalAlpha = 0.85; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke(); ctx.globalAlpha = 1;
      ctx.fillStyle = col; ctx.fillText(name, xl, y - 2);
    };
    one(profLines.vah, c.vaHigh, 'dVAH', T.text2, 1);
    one(profLines.val, c.vaLow, 'dVAL', T.text2, 1);
    one(profLines.poc, c.poc, 'dPOC', T.vpPocText, 1.5);
  }
  let profLines = { poc: false, vah: false, val: false };
  /* The VWAP drawn (1.14.0): each bar's own (the session's, from 18:00 ET), or the page's source (RTH only from 09:30 ET,
     the VWAP gear), asked for the bars in view only. */
  let vwapSrc = null;
  const vwapOf = i => (vwapSrc ? vwapSrc(bars[i].t, i) : bars[i].vw);
  /* 1.14.0: the VWAP no longer sizes the chart, so it can be off the scale: then a marker at the plot's top or bottom
     right edge says where it is (a small triangle pointing to it and "VWAP 25,512.25" in its color on the legend ground). */
  function vwapEdge(i) {
    const vw = i >= 0 && bars[i] ? vwapOf(i) : null;
    if (vw === undefined || vw === null || !isFinite(vw) || (vw <= V.hi && vw >= V.lo)) return;
    const up = vw > V.hi, text = 'VWAP ' + fmtPrice(vw, o.precision);
    ctx.font = '500 10px ' + T.fontMono; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    const w = Math.ceil(ctx.measureText(text).width) + 22, h = 16, x = plotW - 6 - w, y = up ? 4 : plotH - 4 - h;
    roundRect(x, y, w, h, 3); ctx.fillStyle = T.legendBg; ctx.fill();
    ctx.fillStyle = T.vwap; ctx.beginPath();
    const tx = x + 8, ty = y + h / 2;
    if (up) { ctx.moveTo(tx - 4, ty + 2.5); ctx.lineTo(tx + 4, ty + 2.5); ctx.lineTo(tx, ty - 3); }
    else { ctx.moveTo(tx - 4, ty - 2.5); ctx.lineTo(tx + 4, ty - 2.5); ctx.lineTo(tx, ty + 3); }
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = T.vwapText; ctx.fillText(text, x + w - 5, ty + 0.5);
    vwapMark = { up, x, y, w, h, price: vw };
  }
  let vwapMark = null, atrCache = { key: '', v: null }, posHit = null;
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
  }
  /* The Jump to live icon's place (1.14.0): in the price scale's column, at its top, or lower down at the first place
     clear of every tag drawn there (the last price with its countdown, orders, the position, levels), so it never covers
     a price or an order; it takes no room of its own. */
  let liveAt = null;
  const LIVE_W = 24, LIVE_H = 22;
  function placeLive(tags, pTop) {
    const busy = tags.map(t => { const y0 = clamp(t.y - 9, 0, Math.max(0, plotH - 18)); return [y0, y0 + 18]; });
    if (pTop !== null) busy.push([pTop, pTop + 32]);
    let y = 4;
    for (let k = 0; k < busy.length + 1; k++) {
      const hit = busy.find(r => y < r[1] + 3 && y + LIVE_H > r[0] - 3);
      if (!hit) break;
      y = hit[1] + 4;
    }
    const at = { x: plotW + Math.round((AXIS_W - LIVE_W) / 2), y: Math.round(Math.min(y, Math.max(4, plotH - LIVE_H - 4))), w: LIVE_W, h: LIVE_H };
    const top = at.y + 'px', left = at.x + 'px';
    if (liveBtn.style.top !== top) liveBtn.style.top = top;
    if (liveBtn.style.left !== left) liveBtn.style.left = left;
    return at;
  }
  function axisTag(y, text, fill, fg, border, sub) {
    const h = sub ? 32 : 18;
    const top = clamp(y - (sub ? 9 : h / 2), 0, Math.max(0, plotH - h));
    roundRect(plotW + 2, top, AXIS_W - 4, h, 3);
    ctx.fillStyle = fill; ctx.fill();
    if (border) { ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = '500 11px ' + T.fontMono;
    inkText(text, plotW + 8, top + 9, fg);
    if (sub) { ctx.font = '400 10px ' + T.fontMono; ctx.fillText(sub, plotW + 8, top + 23); }
  }
  function countdown() {
    const n = last(); if (n < 0) return '';
    if (paused) return 'paused';
    if (countdownFn) { try { return String(countdownFn(bars[n]) || ''); } catch (e) { return ''; } }
    return barRemain(bars[n].t, o.barSeconds, o.clock());
  }

  function timeLabels(from, to) {
    const labels = [], bs = o.barSeconds;
    if (to < from) return labels;
    if (bs < DAY) {
      let shownX = -Infinity;
      for (let i = Math.max(from, 1); i <= to; i++) {
        if (!isSessionStart(i)) continue;
        // 1.15.0 (spacedDays, a host's charts): a day label closer than 70 px to the last one shown keeps its divider, not its text
        const x = xOf(i), quiet = o.spacedDays && x - shownX < 70;
        if (!quiet) shownX = x;
        labels.push({ i, x, text: fmtDay(bars[i].t + DAY - (o.session.start || DAY)), strong: true, quiet });
      }
      // Seconds per bar actually on screen (range and tick bars are irregular; gaps count too).
      const eff = to > from ? Math.max(1e-6, (bars[to].t - bars[from].t) / (to - from)) : bs;
      const cands = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 14400, 21600, 43200];
      let s = 0;
      for (const c of cands) if (c >= Math.min(bs, eff) && (c / eff) * V.spacing >= 84) { s = c; break; }
      if (s) {
        for (let i = from; i <= to; i++) {
          // label the bar that crosses a round time (exactly on it for regular bars)
          const k = Math.floor(bars[i].t / s);
          const crosses = i > 0 ? k !== Math.floor(bars[i - 1].t / s) : tod(bars[i].t) % s === 0;
          if (!crosses || isSessionStart(i)) continue;
          const x = xOf(i);
          if (labels.some(l => Math.abs(l.x - x) < 70)) continue;
          labels.push({ i, x, text: s < 60 ? fmtHMS(k * s) : fmtHM(k * s), strong: false });
        }
      }
    } else {
      for (let i = Math.max(from, 1); i <= to; i++) {
        const a = new Date(bars[i - 1].t * 1000), b = new Date(bars[i].t * 1000);
        if (a.getUTCMonth() !== b.getUTCMonth()) labels.push({ i, x: xOf(i), text: b.getUTCMonth() === 0 ? String(b.getUTCFullYear()) : MON[b.getUTCMonth()], strong: true });
      }
      const k = Math.max(1, Math.ceil(84 / V.spacing));
      for (let i = from; i <= to; i++) {
        if (i % k !== 0) continue;
        const x = xOf(i);
        if (labels.some(l => Math.abs(l.x - x) < 70)) continue;
        labels.push({ i, x, text: fmtMD(bars[i].t), strong: false });
      }
    }
    return labels;
  }

  function drawProfile() {
    const ver = profile.version;
    let c = vpBars;
    if (!c || c.ver !== ver || c.lo !== V.lo || c.hi !== V.hi || c.w !== plotW || c.h !== plotH || c.dpr !== dpr) {
      // bars as [x, y, w, h] runs in device pixels, one Int32Array per kind, reused between builds (no garbage)
      const r = vpBars ? vpBars.r : [new Int32Array(1024), new Int32Array(1024), new Int32Array(1024)];
      c = vpBars = { ver, lo: V.lo, hi: V.hi, w: plotW, h: plotH, dpr, r, n: [0, 0, 0] };
      profileRects(profile.columns(), { lo: V.lo, hi: V.hi, plotW, plotH, dpr }, (kind, x, y, w, h) => {
        let k = c.n[kind] * 4;
        if (k + 4 > c.r[kind].length) { const g = new Int32Array(c.r[kind].length * 2); g.set(c.r[kind]); c.r[kind] = g; }
        const a = c.r[kind]; a[k++] = x; a[k++] = y; a[k++] = w; a[k] = h; c.n[kind]++;
      });
      vpBuilds++;
    }
    if (!(c.n[0] + c.n[1] + c.n[2])) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const cols = [T.vpRow, T.vpValue, T.vpPoc];
    for (let kind = 0; kind < 3; kind++) {
      const a = c.r[kind], m = c.n[kind] * 4;
      if (!m) continue;
      ctx.fillStyle = cols[kind];
      for (let k = 0; k < m; k += 4) ctx.fillRect(a[k], a[k + 1], a[k + 2], a[k + 3]);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /*
   * The delta pane (1.7.0), below the plot, drawn after the axes: the plot's own bars in x (the same `from` and `to`),
   * the running delta in y (pane.lo to pane.hi); candles in the candle colors, or with bar delta one bar from zero per
   * bar (up color at or above zero). Bars with no delta (before the page had every trade, or with no trade in them)
   * stay blank. A session whose count starts late gets a dashed line at its first bar, and the title says from when.
   * With a note (the page's "Delta needs ChartBridge 0.3.4 on this PC") only the title and the note are drawn.
   * `cx` is the bar under the pointer (over the plot or the pane), `hy` the pointer's y when it is over the pane.
   */
  /* ---------------- chart signals (G1c) */
  /* The first item of a list sorted by t whose t is at or after t0. */
  const firstAt = (list, t0) => { let lo = 0, hi = list.length; while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].t < t0) lo = m + 1; else hi = m; } return lo; };
  /*
   * Large-order bubbles: a circle centred on the trade's price and its bar, its area growing with the square root of the
   * size (Anthony), so the radius with the size's fourth root: BUBBLE_R0 at the floor (a 12 px circle, wider than a
   * candle body at the default 7 px spacing, so even the smallest reads at a glance), twice that at 16 times the floor,
   * BUBBLE_RMAX at most (256 times the floor; no print covers a screen of candles). Filled in the side's candle color as
   * it reads on this ground (bull for buys, bear for sells) at BUBBLE_FILL, with a crisp ring in the same color at
   * BUBBLE_RING. Drawn over the candles but see-through, so the candle it sits on always shows (a range bar's body spans
   * nearly the whole bar, so a bubble behind it would be hidden); the larger ones first, so a smaller one on a larger one
   * shows. 1.14.0 (Anthony, from WORK): the radius is bubbleRadius (the area follows the size, from 4.8 px at the floor to
   * 27 px), and no size is written on the chart: the bubble under the mouse is told to the page (on('bubble')), which
   * shows it in the legend. Zoomed in past
   * the default spacing, every radius grows with the square root of the spacing, at most BUBBLE_ZOOM times, so a bubble
   * keeps its weight against wider candles.
   */
  const BUBBLE_FILL = 0.32, BUBBLE_RING = 0.92, BUBBLE_ZOOM = 1.6;
  const bubbleZoom = () => clamp(Math.sqrt(V.spacing / o.barSpacing), 1, BUBBLE_ZOOM);
  const bubbleR = b => bubbleRadius(b.v, b.f) * bubbleZoom();     // 1.14.0: the area follows the size (bubbleRadius)
  /* The bubbles of this frame (for their labels after the candles), in pooled objects: no allocation per frame. Their
     colors are made once per theme. */
  const bubbleShown = [], bubblePool = [];
  let bubbleN = 0, bubbleT = null, bubbleCol = null;
  const byRadius = (a, b) => b.r - a.r;
  function bubbleColors() {
    if (bubbleT !== T) {
      bubbleT = T;
      bubbleCol = { upFill: rgba(T.upText, BUBBLE_FILL), upRing: rgba(T.upText, BUBBLE_RING), dnFill: rgba(T.downText, BUBBLE_FILL), dnRing: rgba(T.downText, BUBBLE_RING),
        edge: rgba(T.bg, 0.75) };
    }
    return bubbleCol;
  }
  function drawBubbles(from, to) {
    bubbleN = 0; bubbleShown.length = 0;
    const list = signals && o.layers.bubbles && signals.bubbles ? signals.bubbles.list : null;
    if (!list || !list.length || to < from) return;
    const n = last(), t0 = bars[from].t, t1 = to < n ? bars[to + 1].t : Infinity;
    for (let k = firstAt(list, t0); k < list.length && list[k].t < t1; k++) {
      const b = list[k], i = idxAtTime(b.b !== undefined ? b.b : b.t), y = yOf(b.p), r = bubbleR(b);   // on its own bar (1.14.0)
      if (y < -r || y > plotH + r) continue;
      const s = bubblePool[bubbleN] || (bubblePool[bubbleN] = { b: null, x: 0, y: 0, r: 0, v: 0 });
      s.b = b; s.x = xOf(i); s.y = y; s.r = r; s.v = b.v;
      bubbleShown.push(s); bubbleN++;
    }
    if (!bubbleN) return;
    bubbleShown.sort(byRadius);
    // the ring 1.25 px (whole device pixels), with a hairline of the ground just outside it, so a bubble stays crisp on
    // a candle of its own color as on the bare ground
    const lw = Math.max(1, Math.round(dpr * 1.25)) / dpr, C = bubbleColors(), TAU = Math.PI * 2;
    for (let k = 0; k < bubbleN; k++) {
      const s = bubbleShown[k], up = s.b.side > 0;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, TAU);
      ctx.fillStyle = up ? C.upFill : C.dnFill; ctx.fill();
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r + 0.5 / dpr, 0, TAU);
      ctx.strokeStyle = C.edge; ctx.lineWidth = 1 / dpr; ctx.stroke();
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r - lw / 2, 0, TAU);
      ctx.strokeStyle = up ? C.upRing : C.dnRing; ctx.lineWidth = lw; ctx.stroke();
    }
  }
  /* The bubble under the pointer (1.14.0): the topmost one drawn in the last frame (the smaller ones are drawn last) within
     BUBBLE_SLOP px of its ring. Run on pointer moves only, never per frame. */
  const BUBBLE_SLOP = 3;
  let bubbleHover = null;
  function bubbleAtPoint(p) {
    if (!p || p.x > plotW || p.y > plotH) return null;
    for (let k = bubbleN - 1; k >= 0; k--) {
      const s = bubbleShown[k], dx = p.x - s.x, dy = p.y - s.y, r = s.r + BUBBLE_SLOP;
      if (dx * dx + dy * dy <= r * r) return s.b;
    }
    return null;
  }
  function hoverBubble(p) {
    const b = bubbleAtPoint(p);
    if (b === bubbleHover) return;
    bubbleHover = b;
    emit('bubble', b ? { t: b.t, p: b.p, v: b.v, side: b.side, floor: b.f } : null);
  }
  /*
   * Absorption bars (Anthony's AbsorptionTradeCombo): a painted bar is the whole candle in the signal color with a crisp
   * 1 device pixel outline in its brighter shade around the body; while a bar forms with the three holding, an outline
   * only, one pixel clear of its body. In device pixels, as the candles.
   */
  /* one candle's device-pixel geometry, into a kept object (no closure or object per frame) */
  const absG = { xc: 0, yh: 0, yl: 0, top: 0, bh: 0 };
  function absGeom(i, b, live) {
    const c = live ? disp.c : b.c, h = live ? Math.max(disp.h, b.o, c) : b.h, l = live ? Math.min(disp.l, b.o, c) : b.l;
    const yo = Math.round(yOf(b.o) * dpr), yc = Math.round(yOf(c) * dpr);
    absG.xc = Math.round(xOf(i) * dpr); absG.yh = Math.round(yOf(h) * dpr); absG.yl = Math.round(yOf(l) * dpr);
    absG.top = Math.min(yo, yc); absG.bh = Math.max(1, Math.abs(yc - yo));
    return absG;
  }
  function drawAbsorption(from, to, bodyW, wickW) {
    const A = signals && o.layers.absorption ? signals.absorption : null, n = last();
    if (!A || to < from || n < 0) return;
    const lw = Math.max(1, Math.round(dpr)), list = A.painted;
    for (let k = firstAt(list, bars[from].t); k < list.length && list[k].t <= bars[to].t; k++) {
      const p = list[k], i = idxAtTime(p.t);
      if (bars[i].t !== p.t) continue;
      const g = absGeom(i, bars[i], i === n);
      ctx.fillStyle = p.dir > 0 ? T.sigBull : T.sigBear;
      ctx.fillRect(g.xc - (wickW >> 1), g.yh, wickW, Math.max(1, g.yl - g.yh));
      if (bodyW > wickW) {
        const x0 = g.xc - (bodyW >> 1);
        ctx.fillRect(x0, g.top, bodyW, g.bh);
        if (bodyW > 2 * lw && g.bh > 2 * lw) { ctx.strokeStyle = p.dir > 0 ? T.sigBullLine : T.sigBearLine; ctx.lineWidth = lw; ctx.strokeRect(x0 + lw / 2, g.top + lw / 2, bodyW - lw, g.bh - lw); }
      }
    }
    const f = to === n ? A.forming(bars) : 0;
    if (f) {
      const g = absGeom(n, bars[n], true), w = Math.max(bodyW, wickW), x0 = g.xc - (w >> 1) - lw - lw / 2;
      const top = bodyW > wickW ? g.top : g.yh, h = bodyW > wickW ? g.bh : Math.max(1, g.yl - g.yh);
      ctx.strokeStyle = f > 0 ? T.sigBullLine : T.sigBearLine; ctx.lineWidth = lw;
      ctx.strokeRect(x0, top - lw - lw / 2, w + 3 * lw, h + 3 * lw);
    }
  }
  /*
   * Divergence arrows (Anthony's DeltaDivergenceSignal), in the delta pane only: a small arrow ARROW_GAP px below the
   * bar's delta candle for a bullish divergence and above it for a bearish one, at the swing bar; solid once confirmed,
   * hollow (an outline on the ground) while it waits for its confirmation.
   */
  const ARROW_W = 11, ARROW_HEAD = 6, ARROW_STEM = 5, ARROW_GAP = 4;
  function drawArrows(from, to, top, bottom, yD) {
    const Dv = signals && o.layers.divergence ? signals.divergence : null;
    if (!Dv || !Dv.arrows.length || !delta || to < from) return;
    const n = last(), t0 = bars[from].t, t1 = to < n ? bars[to + 1].t : Infinity, list = Dv.arrows;
    for (let k = firstAt(list, t0); k < list.length && list[k].t < t1; k++) {
      const a = list[k], i = idxAtTime(a.t);
      if (bars[i].t !== a.t) continue;
      const d = delta.at(a.t);
      let hiY, loY;
      if (d) {
        if (pane.mode === 'bar') { const y0 = yD(0), y1 = yD(d.c - d.o); hiY = Math.min(y0, y1); loY = Math.max(y0, y1); }
        else { hiY = yD(d.h); loY = yD(d.l); }
      } else continue;
      const x = Math.round(xOf(i) * dpr) / dpr + (Math.round(dpr) % 2 ? 0.5 / dpr : 0), H = ARROW_HEAD + ARROW_STEM, w = ARROW_W / 2, sw = 1.5;
      // the tip ARROW_GAP px from the candle, kept inside the pane
      const down = a.dir < 0;
      let tip = down ? hiY - ARROW_GAP : loY + ARROW_GAP;
      tip = down ? clamp(tip, top + 2 + H, bottom - 2) : clamp(tip, top + 2, bottom - 2 - H);
      const s = down ? -1 : 1;                              // the tail goes this way from the tip (up for a bearish arrow)
      ctx.beginPath();
      ctx.moveTo(x, tip);
      ctx.lineTo(x + w, tip + s * ARROW_HEAD); ctx.lineTo(x + sw, tip + s * ARROW_HEAD); ctx.lineTo(x + sw, tip + s * H);
      ctx.lineTo(x - sw, tip + s * H); ctx.lineTo(x - sw, tip + s * ARROW_HEAD); ctx.lineTo(x - w, tip + s * ARROW_HEAD);
      ctx.closePath();
      const col = a.dir > 0 ? T.sigBull : T.sigBear, line = a.dir > 0 ? T.sigBullLine : T.sigBearLine;
      if (a.solid) { ctx.fillStyle = col; ctx.fill(); }
      else { ctx.fillStyle = rgba(T.bg, 0.9); ctx.fill(); ctx.strokeStyle = line; ctx.lineWidth = 1.25; ctx.lineJoin = 'miter'; ctx.stroke(); }
    }
  }

  function drawPane(from, to, labels, cx, hy) {
    const top = paneTop, h = paneH, bottom = top + h, n = last();
    const show = !!delta && !pane.note && n >= 0 && to >= from, range = pane.hi - pane.lo || 1;
    const yD = v => top + (pane.hi - v) / range * h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, top, plotW, h); ctx.clip();
    if (o.barSeconds < 3600 && to >= from) {                       // regular trading hours, as in the plot
      ctx.fillStyle = T.rth; let start = -1;
      for (let i = from; i <= to + 1; i++) {
        const on = i <= to && isRTH(bars[i].t);
        if (on && start < 0) start = i;
        if (!on && start >= 0) { const x0 = xOf(start) - V.spacing / 2, x1 = xOf(i - 1) + V.spacing / 2; ctx.fillRect(x0, top, x1 - x0, h); start = -1; }
      }
    }
    ctx.lineWidth = 1 / dpr; ctx.strokeStyle = T.grid; ctx.beginPath();
    if (o.grid) for (const l of labels) if (!l.strong) { const x = crisp(l.x, 1); ctx.moveTo(x, top); ctx.lineTo(x, bottom); }
    ctx.stroke();
    ctx.beginPath(); ctx.strokeStyle = T.divider; ctx.setLineDash([2, 4]);
    for (const l of labels) if (l.strong) { const x = crisp(l.x - V.spacing / 2, 1); ctx.moveTo(x, top); ctx.lineTo(x, bottom); }
    ctx.stroke(); ctx.setLineDash([]);
    let vStep = 1, g0 = 0, g1 = -1;
    if (show) {
      vStep = niceStep(range * 34 / Math.max(1, h), 1); g0 = Math.ceil(pane.lo / vStep); g1 = Math.floor(pane.hi / vStep);
      ctx.strokeStyle = T.grid; ctx.beginPath();
      if (o.grid) for (let k = g0; k <= g1 && k - g0 < 60; k++) if (k) { const y = crisp(yD(k * vStep), 1); ctx.moveTo(0, y); ctx.lineTo(plotW, y); }
      ctx.stroke();
      if (pane.lo <= 0 && pane.hi >= 0) { const y = crisp(yD(0), 1); ctx.strokeStyle = T.divider; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke(); }
      const db = delta.bars;
      // a session that counts from later than its start: a dashed line at its first bar
      ctx.strokeStyle = T.axisText; ctx.setLineDash([3, 3]); ctx.beginPath();
      let marks = 0;
      for (const ses of delta.sessions) {
        if (!ses.partial || ses.from < bars[from].t || ses.from > bars[to].t) continue;
        const i = idxAtTime(ses.from), x = crisp(xOf(i) - V.spacing / 2, 1);
        ctx.moveTo(x, top); ctx.lineTo(x, bottom); marks++;
      }
      if (marks) ctx.stroke();
      ctx.setLineDash([]);
      // candles, or bars from zero, in device pixels, one path per color
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const sp = V.spacing * dpr, wickW = Math.max(1, Math.round(dpr));
      let bodyW = Math.max(wickW, Math.floor(sp * 0.72)); if ((bodyW - wickW) % 2) bodyW -= 1; if (bodyW < wickW) bodyW = wickW;
      const Y = v => Math.round(yD(v) * dpr), barMode = pane.mode === 'bar';
      const candle = (d, i, up, dn) => {
        const xc = Math.round(xOf(i) * dpr);
        if (barMode) {
          const v = d.c - d.o, y0 = Y(0), y1 = Y(v);
          (v >= 0 ? up : dn).rect(xc - (bodyW >> 1), Math.min(y0, y1), bodyW, Math.max(1, Math.abs(y1 - y0)));
        } else {
          const yo = Y(d.o), yc = Y(d.c), yh = Y(d.h), yl = Y(d.l), path = d.c >= d.o ? up : dn;
          path.rect(xc - (wickW >> 1), yh, wickW, Math.max(1, yl - yh));
          if (bodyW > wickW) path.rect(xc - (bodyW >> 1), Math.min(yo, yc), bodyW, Math.max(1, Math.abs(yc - yo)));
        }
      };
      // the closed candles' paths are kept while nothing about them changes (the bars in view, their places, the scale,
      // the size, the mode, the candles); a normal frame with a trade adds only the newest bar's candle (review N4). The
      // plot's width is in it: a bar's x is plotW - (V.right - i) * V.spacing, so a width change that leaves the bars in
      // view and V.right as they were still moves every candle (review 2 S3)
      const ckey = [pane.cid, from, to, n, bars.length, V.right, V.spacing, plotW, pane.lo, pane.hi, top, h, dpr, pane.mode, db.length].join('|');
      let cc = pane.cc;
      if (!cc || cc.key !== ckey) {
        cc = pane.cc = { key: ckey, up: new Path2D(), dn: new Path2D() };
        const end = Math.min(to, n - 1);
        let k = end >= from ? delta.lowerBound(bars[from].t) : db.length;
        for (let i = from; i <= end && k < db.length; i++) {
          const t = bars[i].t;
          while (k < db.length && db[k].t < t) k++;
          if (k >= db.length || db[k].t !== t) continue;
          candle(db[k], i, cc.up, cc.dn);
        }
      }
      ctx.fillStyle = T.up; ctx.fill(cc.up); ctx.fillStyle = T.down; ctx.fill(cc.dn);
      const ld = to === n ? delta.last : null;
      if (ld && ld.t === bars[n].t) {
        const up = new Path2D(), dn = new Path2D();
        candle(ld, n, up, dn);
        ctx.fillStyle = T.up; ctx.fill(up); ctx.fillStyle = T.down; ctx.fill(dn);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawArrows(from, to, top, bottom, yD);                       // divergence arrows (G1c), over the delta candles
    }
    // the crosshair: the bar's line through the pane, and the value line where the pointer is
    if (cx !== null) {
      const x = crisp(xOf(cx), 1);
      ctx.strokeStyle = T.cross; ctx.lineWidth = Math.max(1, Math.round(dpr)) / dpr; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom);
      if (hy !== null) { const y = crisp(hy, 1); ctx.moveTo(0, y); ctx.lineTo(plotW, y); }
      ctx.stroke(); ctx.setLineDash([]);
    }
    // the title, the value of the bar in the legend (under the pointer, else the newest) and from when it counts
    const li = hoverIdx !== null ? hoverIdx : n, lb = show && li >= 0 ? delta.at(bars[li].t) : null;
    const lses = lb ? delta.sessionOf(lb) : null;
    const title = pane.mode === 'bar' ? 'Bar delta' : 'Cumulative delta';
    const val = !show ? '' : lb ? fmtSigned(pane.mode === 'bar' ? lb.c - lb.o : lb.c, 0) : '-';
    // a session counted from later than its start (1.7.0, round 4): "since 10:04 ET", and "(page opened)" when the page's
    // opening is why (setDeltaView reason); and for the newest session the seconds the count missed (round 6), when 1 or
    // more: "since 10:04 ET (page opened), missed 32 s", or "since 18:00 ET, missed 32 s" for a session held from its start
    const missed = pane.missed >= 1 && lses && lses === delta.session ? Math.round(pane.missed) : 0;
    const since = !show ? '' : !delta.bars.length ? 'starts with the next full bar'
      : pane.mode !== 'bar' && lses && (lses.partial || missed) ? 'since ' + fmtExact(lses.partial ? lses.from : lses.start) + ' ET' +
        (lses.partial && pane.reason ? ' (' + pane.reason + ')' : '') + (missed ? ', missed ' + missed + ' s' : '') : '';
    pane.title = [title, val, since, pane.note].filter(Boolean).join(' ');
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    // text widths kept per font and text (the title and the start rarely change; the value's digits are few)
    const width = (font, text) => {
      const k = font + '|' + text;
      let w = pane.widths.get(k);
      if (w === undefined) { if (pane.widths.size > 400) pane.widths.clear(); ctx.font = font; w = ctx.measureText(text).width; pane.widths.set(k, w); }
      return w;
    };
    const f1 = '600 10px ' + T.fontCond, f2 = '500 11px ' + T.fontMono, f3 = '500 10px ' + T.fontCond;
    const w1 = width(f1, title.toUpperCase()), w2 = val ? width(f2, val) + 8 : 0, w3 = since ? width(f3, since) + 8 : 0;
    roundRect(6, top + 4, w1 + w2 + w3 + 12, 18, 4); ctx.fillStyle = T.legendBg; ctx.fill();
    ctx.font = '600 10px ' + T.fontCond; ctx.fillStyle = T.axisText; ctx.fillText(title.toUpperCase(), 12, top + 13.5);
    if (val) { ctx.font = '500 11px ' + T.fontMono; ctx.fillStyle = T.axisTextStrong; ctx.fillText(val, 12 + w1 + 8, top + 13.5); }
    if (since) { ctx.font = '500 10px ' + T.fontCond; ctx.fillStyle = T.axisText; ctx.fillText(since, 12 + w1 + w2 + 8, top + 13.5); }
    if (pane.note) {
      ctx.font = '500 12px ' + T.fontCond; ctx.fillStyle = T.axisTextStrong; ctx.textAlign = 'center';
      ctx.fillText(pane.note, plotW / 2, top + h / 2 + 6);
    }
    ctx.restore();
    if (!show) return;
    // the pane's value axis: round values, the newest bar's value in a tag, the pointer's value
    const tag = (y, text, fill, fg, border) => {
      const th = 18, t0 = clamp(y - th / 2, top, Math.max(top, bottom - th));
      roundRect(plotW + 2, t0, AXIS_W - 4, th, 3); ctx.fillStyle = fill; ctx.fill();
      if (border) { ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.stroke(); }
      ctx.font = '500 11px ' + T.fontMono; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = fg;
      ctx.fillText(text, plotW + 8, t0 + 9);
      return t0 + th / 2;
    };
    const nb = delta.at(bars[n].t), nv = nb ? (pane.mode === 'bar' ? nb.c - nb.o : nb.c) : null, ny = nv === null ? null : yD(nv);
    ctx.font = '400 11px ' + T.fontMono; ctx.fillStyle = T.axisText; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (let k = g0; k <= g1 && k - g0 < 60; k++) {
      const y = yD(k * vStep); if (y < top + 8 || y > bottom - 8 || (ny !== null && Math.abs(y - ny) < 18)) continue;
      ctx.fillText(fmtSigned(k * vStep, 0), plotW + 8, y);
    }
    if (nv !== null && ny >= top - 9 && ny <= bottom + 9) tag(ny, fmtSigned(nv, 0), nv >= 0 ? T.up : T.down, nv >= 0 ? T.upOnTag : T.downOnTag, null);
    if (hy !== null) tag(hy, fmtSigned(Math.round(pane.hi - (hy - top) / h * range), 0), T.tagFill, T.tagText, T.tagBorder);
  }

  function draw(now) {
    const n = last();
    vwapMark = null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);
    const from = Math.max(0, Math.floor(indexAt(-V.spacing))), to = Math.min(n, Math.ceil(indexAt(plotW + V.spacing)));
    const pRange = V.hi - V.lo;

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, plotW, plotH); ctx.clip();

    // regular trading hours: lighter ground on intraday bars
    if (o.barSeconds < 3600 && to >= from) {
      ctx.fillStyle = T.rth; let start = -1;
      for (let i = from; i <= to + 1; i++) {
        const on = i <= to && isRTH(bars[i].t);
        if (on && start < 0) start = i;
        if (!on && start >= 0) { const x0 = xOf(start) - V.spacing / 2, x1 = xOf(i - 1) + V.spacing / 2; ctx.fillRect(x0, 0, x1 - x0, plotH); start = -1; }
      }
    }

    // price grid
    const pStep = niceStep(pRange * 52 / plotH, o.tick);
    const k0 = Math.ceil(V.lo / pStep), k1 = Math.floor(V.hi / pStep);
    ctx.lineWidth = 1 / dpr;
    if (o.grid) {                                                    // 1.14.0: grid lines can be off (the live page's default)
      ctx.strokeStyle = T.grid; ctx.beginPath();
      for (let k = k0; k <= k1 && k - k0 < 400; k++) { const y = crisp(yOf(k * pStep), 1); ctx.moveTo(0, y); ctx.lineTo(plotW, y); }
      ctx.stroke();
    }

    // time grid and session dividers
    const labels = timeLabels(from, to);
    if (o.grid) {
      ctx.beginPath(); ctx.strokeStyle = T.grid;
      for (const l of labels) if (!l.strong) { const x = crisp(l.x, 1); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); }
      ctx.stroke();
    }
    ctx.beginPath(); ctx.strokeStyle = T.divider; ctx.setLineDash([2, 4]);
    for (const l of labels) if (l.strong) { const x = crisp(l.x - V.spacing / 2, 1); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); }
    ctx.stroke(); ctx.setLineDash([]);

    // volume profile: in front of the grid, behind volume, levels and candles
    if (profile && o.layers.vp) drawProfile();
    // zones (1.15.0): a shaded box between two prices and two times, above the grid and behind the candles, as the profile
    if (drawings.length || draft) {
      for (const d of draft ? drawings.concat([draft]) : drawings) {
        if (d.type !== 'zone') continue;
        const r = zoneRect(d), lw = Math.max(1, Math.round(dpr)), col = d.color || T.drawing;
        if (r.x1 < 0 || r.x0 > plotW || r.y1 < 0 || r.y0 > plotH) continue;
        const x0 = crisp(r.x0, lw), x1 = crisp(r.x1, lw), y0 = crisp(r.y0, lw), y1 = crisp(r.y1, lw);
        ctx.fillStyle = rgba(col, d.id === selectedId || d === draft ? 0.16 : 0.10); ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.strokeStyle = col; ctx.globalAlpha = 0.85; ctx.lineWidth = lw / dpr; ctx.setLineDash([]);
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.globalAlpha = 1;
      }
    }

    // volume + candles in device pixels, one path per color
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const sp = V.spacing * dpr, wickW = Math.max(1, Math.round(dpr));
    let bodyW = Math.max(wickW, Math.floor(sp * 0.72)); if ((bodyW - wickW) % 2) bodyW -= 1; if (bodyW < wickW) bodyW = wickW;
    if (o.layers.volume && to >= from) {
      let mv = 1; for (let i = from; i <= to; i++) if ((bars[i].v || 0) > mv) mv = bars[i].v;
      const vh = plotH * 0.16 * dpr, bottom = Math.round(plotH * dpr);
      const vu = new Path2D(), vd = new Path2D();
      const vW = sp >= 3 ? Math.max(1, Math.floor(sp * 0.8)) : Math.max(1, Math.floor(sp * 0.72));
      for (let i = from; i <= to; i++) {
        const b = bars[i], xc = Math.round(xOf(i) * dpr), hgt = Math.max(1, Math.round((b.v || 0) / mv * vh));
        const c = i === n ? disp.c : b.c;
        (c >= b.o ? vu : vd).rect(xc - (vW >> 1), bottom - hgt, vW, hgt);
      }
      ctx.fillStyle = T.upVol; ctx.fill(vu); ctx.fillStyle = T.downVol; ctx.fill(vd);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // levels
    if (levelsShown.length) {
      ctx.font = '600 10px ' + T.fontCond; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      const lw = Math.max(1, Math.round(dpr));
      const vis = levelsShown.filter(L => L.price >= V.lo && L.price <= V.hi && levelOn(L)).sort((a, b) => b.price - a.price);
      const groups = [];
      for (const L of vis) {
        const y = crisp(yOf(L.price), lw), col = L.color || T.axisText;
        // a level with `from` (the IB: 9:30) starts at that bar; the rest run across the whole plot
        const x0 = L.from !== undefined && L.from !== null ? Math.max(0, xOf(idxOfTime(L.from)) - V.spacing / 2) : 0;
        if (x0 >= plotW - 1) continue;
        ctx.strokeStyle = col; ctx.globalAlpha = 0.7; ctx.lineWidth = lw / dpr; ctx.setLineDash(L.dash || [6, 4]);
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(plotW, y); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        const g = groups[groups.length - 1];
        if (g && y - g.y < 12) g.names.push(L.name); else groups.push({ y, names: [L.name], color: col });
      }
      for (const g of groups) { ctx.fillStyle = g.color; ctx.fillText(g.names.join(' · '), plotW - 8, g.y - 3); }
    }

    if (profile && o.layers.vp && (profLines.poc || profLines.vah || profLines.val)) drawProfileLines();

    // VWAP, broken at each session start
    if (o.layers.vwap && to > from) {
      ctx.strokeStyle = T.vwap; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.globalAlpha = 0.9;
      ctx.beginPath(); let pen = false;
      for (let i = from; i <= to; i++) {
        const vw = vwapOf(i);
        if (isSessionStart(i) || vw === undefined || vw === null) { pen = false; if (vw === undefined || vw === null) continue; }
        const x = xOf(i), y = yOf(vw);
        if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke(); ctx.globalAlpha = 1;
      vwapEdge(Math.min(to, n));
    }

    // candles
    if (n >= 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const up = new Path2D(), dn = new Path2D();
      const Y = p => Math.round(yOf(p) * dpr);
      for (let i = from; i <= to; i++) {
        const b = bars[i], live = i === n;
        const c = live ? disp.c : b.c, h = live ? Math.max(disp.h, b.o, c) : b.h, l = live ? Math.min(disp.l, b.o, c) : b.l;
        const xc = Math.round(xOf(i) * dpr), yo = Y(b.o), yc = Y(c), yh = Y(h), yl = Y(l);
        const path = c >= b.o ? up : dn;
        path.rect(xc - (wickW >> 1), yh, wickW, Math.max(1, yl - yh));
        if (bodyW > wickW) path.rect(xc - (bodyW >> 1), Math.min(yo, yc), bodyW, Math.max(1, Math.abs(yc - yo)));
      }
      ctx.fillStyle = T.up; ctx.fill(up); ctx.fillStyle = T.down; ctx.fill(dn);
      drawAbsorption(from, to, bodyW, wickW);                       // absorption bars (G1c): painted over their candles
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    drawBubbles(from, to);                                          // large-order bubbles (G1c): see-through, over the candles

    // trades
    if (o.layers.trades && trades.length && n >= 0) {
      const chips = [];
      for (const tr of trades) {
        const i1 = idxAtTime(tr.tIn), i2 = idxAtTime(tr.tOut);
        if (i2 < from - 2 || i1 > to + 2) continue;
        const x1 = xOf(i1), x2 = xOf(i2), y1 = yOf(tr.pIn), y2 = yOf(tr.pOut);
        const pts = (tr.pOut - tr.pIn) * tr.dir;
        const col = pts > 0 ? T.profit : pts < 0 ? T.loss : T.axisText;
        ctx.strokeStyle = col; ctx.globalAlpha = 0.85; ctx.lineWidth = 1.25; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
        const s = 5.5, d = tr.dir;                                // entry: triangle pointing the trade's way
        const side = d > 0 ? T.long : T.short, ring = ringOf(side);
        ctx.fillStyle = side; ctx.strokeStyle = ring || T.bg; ctx.lineWidth = ring ? 2 : 1.5;
        ctx.beginPath(); ctx.moveTo(x1, y1 - d * s); ctx.lineTo(x1 - s, y1 + d * s * 0.7); ctx.lineTo(x1 + s, y1 + d * s * 0.7); ctx.closePath(); ctx.stroke(); ctx.fill();
        ctx.strokeStyle = T.bg; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x2, y2, 4, 0, Math.PI * 2); ctx.fillStyle = T.exit; ctx.stroke(); ctx.fill();
        if (V.spacing >= 2.5) {
          const txt = tr.label || ((pts > 0 ? '+' : '') + pts.toFixed(o.precision) + (o.unit ? ' ' + o.unit : ''));
          ctx.font = '500 11px ' + T.fontMono; const tw = ctx.measureText(txt).width;
          const lx = x2 + 9; let ly = y2 - 9;
          for (let k = 0; k < 4 && chips.some(r => lx < r.x + r.w && lx + tw + 10 > r.x && ly < r.y + 20 && ly + 18 > r.y - 2); k++) ly += 21;
          chips.push({ x: lx, y: ly, w: tw + 10 });
          roundRect(lx, ly, tw + 10, 18, 4); ctx.fillStyle = rgba(T.bg, 0.88); ctx.fill();
          ctx.strokeStyle = col; ctx.globalAlpha = 0.6; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
          ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(txt, lx + 5, ly + 9.5);
        }
      }
    }

    // fills: buy triangles point up, sell triangles point down, tip at the fill price. Fills on one bar, side
    // and price draw as one mark with the summed qty; labels on one bar stack apart (1.3.1)
    if (markers.length && n >= 0) {
      ctx.font = '500 10px ' + T.fontMono; ctx.textBaseline = 'middle';
      const s = 5, inView = fillMarks().filter(m => m.i >= from - 1 && m.i <= to + 1);
      for (const { m, y, ly } of stackFillLabels(inView, yOf, s, 10)) {
        const x = xOf(m.i), buy = m.side === 'buy', dir = buy ? 1 : -1;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - s, y + dir * s * 1.6); ctx.lineTo(x + s, y + dir * s * 1.6); ctx.closePath();
        const side = buy ? T.long : T.short, ring = ringOf(side);
        ctx.fillStyle = side; ctx.strokeStyle = ring || T.bg; ctx.lineWidth = ring ? 2 : 1.5; ctx.stroke(); ctx.fill();
        if (V.spacing >= 4 && m.qty) { ctx.textAlign = 'left'; inkText(String(m.qty), x + s + 3, ly, side); }
      }
    }

    // drawings: horizontal lines and trend lines
    if (drawings.length || draft) {
      const all = draft ? drawings.concat([draft]) : drawings;
      const handle = (x, y) => { ctx.fillStyle = T.bg; ctx.fillRect(x - 3.5, y - 3.5, 7, 7); ctx.strokeRect(x - 3.5, y - 3.5, 7, 7); };
      for (const d of all) {
        const sel = d.id === selectedId || d === draft, col = d.color || T.drawing;
        ctx.strokeStyle = col; ctx.lineWidth = sel ? 2 : 1.5; ctx.setLineDash([]);
        if (d.type === 'hline') {
          const y = yOf(d.price);
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
          if (sel) { ctx.lineWidth = 1.5; handle(plotW / 2, y); }
        } else if (d.type === 'trend') {
          const ax = xOf(idxOfTime(d.a.t)), ay = yOf(d.a.p), bx = xOf(idxOfTime(d.b.t)), by = yOf(d.b.p);
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
          if (sel) { ctx.lineWidth = 1.5; handle(ax, ay); handle(bx, by); }
        } else if (d.type === 'zone' && sel && d !== draft) {      // the box is drawn behind the candles; its corners on top
          const r = zoneRect(d); ctx.lineWidth = 1.5;
          handle(r.x0, r.y0); handle(r.x1, r.y0); handle(r.x0, r.y1); handle(r.x1, r.y1);
        }
      }
    }

    // working orders, the position and the Shift+click preview: a line across the plot, a label at its
    // right end (with a close handle while editing) and a tag on the price axis (added to the tag stack below)
    const orderTags = [], orderLabels = [];   // labels draw after the last price line, so the live dot never covers them
    orderHits = []; posHit = null;
    const labelBoxes = [];                    // where the labels are (full size), for the corner readout (1.15.0)
    if (n >= 0 && (orders.length || position || orderPreview)) {
      const boxes = [], LH = 18;
      ctx.font = '500 11px ' + T.fontMono; ctx.textBaseline = 'middle';
      const place = (y, w) => {                                  // right-aligned, stepping left past labels it would overlap
        let x = plotW - 6 - w; const top = clamp(y - LH / 2, 0, Math.max(0, plotH - LH));
        for (let k = 0; k < 8; k++) {
          const hit = boxes.find(b => x < b.x + b.w + 4 && x + w + 4 > b.x && Math.abs(b.top - top) < LH + 1);
          if (!hit) break; x = hit.x - 4 - w;
        }
        boxes.push({ x, top, w }); labelBoxes.push({ x, y: top, w, h: LH }); return { x, top };
      };
      const hline = (y, col, dash, alpha, width) => {
        const lw = Math.max(1, Math.round(dpr * (width || 1))), ring = ringOf(col);
        if (ring) {                                              // an outline under a side color that does not read here
          ctx.strokeStyle = ring; ctx.lineWidth = (lw + 2 * Math.max(1, Math.round(dpr))) / dpr; ctx.setLineDash(dash || []); ctx.globalAlpha = alpha;
          ctx.beginPath(); ctx.moveTo(0, crisp(y, lw)); ctx.lineTo(plotW, crisp(y, lw)); ctx.stroke();
        }
        ctx.strokeStyle = col; ctx.lineWidth = lw / dpr; ctx.setLineDash(dash || []); ctx.globalAlpha = alpha;
        ctx.beginPath(); ctx.moveTo(0, crisp(y, lw)); ctx.lineTo(plotW, crisp(y, lw)); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      };
      /* parts: [[text, color], ...]; extras: [[which, text]] cells (1.13.0). 1.15.0: `short` (parts too) is drawn instead on
         a host's chart (compactLabels), smaller and right-aligned in the full label's place, the full label while the
         mouse is over it (`hid`) or it has cells to add; the hit areas, the x and the stacking stay the full label's */
      const label = (y, parts, border, dash, alpha, closer, extras, short, hid) => {
        const gap = 7, widths = parts.map(pt => ctx.measureText(pt[0]).width);
        const ex = (extras || []).map(e => ({ which: e[0], text: e[1], w: ctx.measureText(e[1]).width + 10 }));
        const ew = ex.reduce((a, e) => a + e.w, 0);
        const tw = widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1) + 10, w = tw + ew + (closer ? LH : 0);
        const { x, top } = place(y, w);
        const compact = o.compactLabels && short && !ex.length && (hid === undefined || hid !== labelHover);
        if (compact) {
          const CH = 14;
          orderLabels.push(() => {
            ctx.font = '500 10px ' + T.fontMono; ctx.textBaseline = 'middle';
            const sw = short.map(pt => ctx.measureText(pt[0]).width), cg = 5;
            const ctw = sw.reduce((a, b) => a + b, 0) + cg * (short.length - 1) + 8, cx0 = x + tw - ctw, ct = top + (LH - CH) / 2;
            ctx.globalAlpha = alpha;
            roundRect(cx0, ct, ctw + (closer ? LH : 0), CH, 3); ctx.fillStyle = rgba(T.bg, 0.92); ctx.fill();
            ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]);
            let cx = cx0 + 4; ctx.textAlign = 'left';
            short.forEach((pt, k) => { inkText(pt[0], cx, ct + CH / 2 + 0.5, pt[1]); cx += sw[k] + cg; });
            if (closer) {                                           // the x in the full label's own cell (its hit area)
              const bx = x + tw;
              ctx.strokeStyle = border; ctx.beginPath(); ctx.moveTo(bx + 0.5, ct + 2); ctx.lineTo(bx + 0.5, ct + CH - 2); ctx.stroke();
              const mx = bx + LH / 2, my = ct + CH / 2;
              ctx.strokeStyle = T.tagText; ctx.lineWidth = 1.25; ctx.beginPath();
              ctx.moveTo(mx - 2.75, my - 2.75); ctx.lineTo(mx + 2.75, my + 2.75); ctx.moveTo(mx + 2.75, my - 2.75); ctx.lineTo(mx - 2.75, my + 2.75); ctx.stroke();
            }
            ctx.globalAlpha = 1;
          });
          return { box: { x, y: top, w: tw, h: LH }, xbox: closer ? { x: x + tw, y: top, w: LH, h: LH } : null, adds: [] };
        }
        orderLabels.push(() => {
          ctx.font = '500 11px ' + T.fontMono; ctx.textBaseline = 'middle';
          ctx.globalAlpha = alpha;
          roundRect(x, top, w, LH, 4); ctx.fillStyle = rgba(T.bg, 0.92); ctx.fill();
          ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]);
          let cx = x + 5; ctx.textAlign = 'left';
          parts.forEach((pt, k) => { inkText(pt[0], cx, top + LH / 2 + 0.5, pt[1]); cx += widths[k] + gap; });
          let ex0 = x + tw;
          for (const e of ex) {                                     // an add cell ("+SL"): a divider, then its text
            ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(ex0 + 0.5, top + 3); ctx.lineTo(ex0 + 0.5, top + LH - 3); ctx.stroke();
            inkText(e.text, ex0 + 5, top + LH / 2 + 0.5, T.tagText); ex0 += e.w;
          }
          if (closer) {                                             // close handle: a small x in its own cell
            const bx = x + tw + ew;
            ctx.strokeStyle = border; ctx.beginPath(); ctx.moveTo(bx + 0.5, top + 3); ctx.lineTo(bx + 0.5, top + LH - 3); ctx.stroke();
            const mx = bx + LH / 2, my = top + LH / 2;
            ctx.strokeStyle = T.tagText; ctx.lineWidth = 1.5; ctx.beginPath();
            ctx.moveTo(mx - 3.5, my - 3.5); ctx.lineTo(mx + 3.5, my + 3.5); ctx.moveTo(mx + 3.5, my - 3.5); ctx.lineTo(mx - 3.5, my + 3.5); ctx.stroke();
          }
          ctx.globalAlpha = 1;
        });
        let ax = x + tw;
        const adds = ex.map(e => { const b = { which: e.which, box: { x: ax, y: top, w: e.w, h: LH } }; ax += e.w; return b; });
        return { box: { x, y: top, w: tw, h: LH }, xbox: closer ? { x: x + tw + ew, y: top, w: LH, h: LH } : null, adds };
      };
      // position: neutral line at the average price, open P&L in points and dollars
      if (position && position.qty) {
        const y = yOf(position.avgPrice), long = position.qty > 0;
        if (y >= 0 && y <= plotH) {
          const pnl = openPnl(position.qty, position.avgPrice, bars[n].c, position.pointValue || o.pointValue);
          const pc = pnl.points > 0 ? T.profit : pnl.points < 0 ? T.loss : T.axisText;
          hline(y, T.exit, null, 0.6, 1.5);
          const parts = [[(long ? 'LONG ' : 'SHORT ') + Math.abs(position.qty), long ? T.long : T.short], [fmtSigned(pnl.points, o.precision) + ' pt', pc]];
          if (pnl.dollars !== null) parts.push([fmtMoney(pnl.dollars), pc]);
          const sp = positionShort(position.qty, pnl, o.precision), short = sp.map((t, k) => [t, k ? pc : long ? T.long : T.short]);
          posHit = label(y, parts, T.exit, null, 1, false, null, short, 'position').box;
          orderTags.push({ price: position.avgPrice, style: { fill: T.tagFill, fg: T.exit, border: T.exit } });
        }
      }
      for (const ord of orders) {
        const price = orderPrice(ord), y = yOf(price);
        if (y < 0 || y > plotH) continue;
        const col = ord.side === 'sell' ? T.short : T.long, stop = ord.kind === 'stop' || ord.kind === 'stopLimit';
        const dragging = od && od.id === ord.id;
        if (ord.plan) {                                            // a planned stop or target (1.13.0): fainter, finely dashed
          const parent = orders.find(x => x.id === ord.plan.parent);
          const ticks = parent ? Math.round(Math.abs(price - orderPrice(parent)) / o.tick) : Math.abs(ord.plan.ticks);
          const alpha = pendingMoves.has(ord.id) && !dragging ? 0.4 : 0.7;
          hline(y, col, [2, 4], 0.75 * alpha, dragging ? 1.5 : 1);
          const pl = { plan: { role: ord.plan.role, ticks } };
          const hit = label(y, [[orderLabel(pl), col]], col, [2, 3], alpha, orderEditing, null, [[orderLabelShort(pl), col]], ord.id);
          orderHits.push({ id: ord.id, box: hit.box, xbox: hit.xbox });
          orderTags.push({ price, id: ord.id, style: { fill: T.bg, fg: col, border: col, dash: [2, 3] } });
          continue;
        }
        const dash = stop ? [6, 4] : null;
        const alpha = pendingMoves.has(ord.id) && !dragging ? 0.55 : 1;
        hline(y, col, dash, 0.9 * alpha, dragging ? 1.5 : 1);
        const extras = orderEditing && ord.adds && ord.adds.length ? ord.adds.map(w => [w, w === 'stop' ? '+SL' : '+TP']) : null;
        const hit = label(y, [[orderLabel(ord), col]], col, dash ? [3, 2] : null, alpha, orderEditing, extras, [[orderLabelShort(ord), col]], ord.id);
        orderHits.push({ id: ord.id, box: hit.box, xbox: hit.xbox, adds: hit.adds });
        orderTags.push({ price, id: ord.id, style: stop ? { fill: T.bg, fg: col, border: col, dash: [3, 2] } : { fill: col, fg: readableOn(col), border: null } });
      }
      // Shift+click preview: what one click would place here
      if (orderPreview && orderEditing && shiftHeld && hover && !drag && !od && !tool && hover.x >= 0 && hover.x < plotW && hover.y >= 0 && hover.y < plotH) {
        const price = roundTo(priceAt(hover.y), o.tick);
        let pv = null; try { pv = orderPreview(price); } catch (e) { pv = null; }
        if (pv) {
          const col = pv.side === 'sell' ? T.short : T.long, dash = [2, 3];
          hline(hover.y, col, dash, 0.7, 1);
          label(hover.y, [[orderLabel(pv), col], [pv.note || 'click to place', T.axisText]], col, dash, 0.85, false);
          orderTags.push({ price, style: { fill: T.bg, fg: col, border: col, dash } });
        }
      }
    }

    // last price line and live dot
    let ly = 0, lastCol = T.up, lastTag = T.upOnTag;
    if (n >= 0) {
      const lb = bars[n], lastUp = disp.c >= lb.o;
      lastCol = lastUp ? T.up : T.down; lastTag = lastUp ? T.upOnTag : T.downOnTag;
      ly = yOf(disp.c);
      const plw = Math.max(1, Math.round(dpr));
      ctx.strokeStyle = lastCol; ctx.lineWidth = plw / dpr; ctx.setLineDash([1, 3]); ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.moveTo(0, crisp(ly, plw)); ctx.lineTo(plotW, crisp(ly, plw)); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      const lx = xOf(n);
      if (lx > -10 && lx < plotW + 10) {
        const age = now - pulseT0;
        if (age < 500 && !REDUCED) {
          // A tick handled after this frame began (its time stamp can be well behind the clock after a long task,
          // such as building a day and a half of range bars) counts as age 0: the ring never gets a negative radius.
          const k = Math.max(0, age / 500);
          ctx.beginPath(); ctx.arc(lx, ly, 3 + k * 9, 0, Math.PI * 2);
          ctx.strokeStyle = lastCol; ctx.globalAlpha = 0.5 * (1 - k); ctx.lineWidth = 1.5; ctx.stroke(); ctx.globalAlpha = 1;
        }
        ctx.beginPath(); ctx.arc(lx, ly, 2.5, 0, Math.PI * 2); ctx.fillStyle = T.live; ctx.fill();
      }
    }
    // the corner readout (1.15.0): the page's bar countdown and ATR, quiet, at the plot's bottom right clear of the labels
    // and the VWAP's marker (under the labels if they cover every place)
    cornerAt = null;
    if (cornerText && n >= 0) {
      ctx.font = '500 10px ' + T.fontMono; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      // the short form on a plot too narrow for the whole text (a small panel)
      let text = cornerText, w = Math.ceil(ctx.measureText(text).width) + 10;
      if (w > plotW - 12 && cornerShort) { text = cornerShort; w = Math.ceil(ctx.measureText(text).width) + 10; }
      const h = 16, at = cornerPlace(plotW, plotH, w, h, labelBoxes.concat(vwapMark ? [vwapMark] : []), o.fitTop);
      if (at) {
        roundRect(at.x, at.y, w, h, 4); ctx.fillStyle = T.legendBg; ctx.fill();
        ctx.fillStyle = T.text2; ctx.fillText(text, at.x + 5, at.y + h / 2 + 0.5);
        cornerAt = { x: at.x, y: at.y, w, h, text };
      }
    }
    for (const f of orderLabels) f();

    // crosshair
    let hi = null;
    if (hover && !pinch && hover.x >= 0 && hover.x < plotW && hover.y >= 0 && hover.y < plotH) {
      hi = Math.round(indexAt(hover.x));
      const cx = crisp(xOf(hi), 1), cy = crisp(hover.y, 1);
      ctx.strokeStyle = T.cross; ctx.lineWidth = Math.max(1, Math.round(dpr)) / dpr; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, plotH); ctx.moveTo(0, cy); ctx.lineTo(plotW, cy); ctx.stroke();
      ctx.setLineDash([]);
      if (hi < 0 || hi > n) hi = null;
    }
    ctx.restore();
    // the pointer over the delta pane (1.7.0): the same bar as over the plot, and the bar's line through the plot too
    let paneX = null, paneY = null;
    if (paneOn()) {
      const over = hover && !pinch && hover.x >= 0 && hover.x < plotW;
      if (over && hover.y >= paneTop && hover.y < timeY) {
        paneX = Math.round(indexAt(hover.x)); paneY = hover.y; hi = paneX >= 0 && paneX <= n ? paneX : null;
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, plotW, plotH); ctx.clip();
        const x = crisp(xOf(paneX), 1);
        ctx.strokeStyle = T.cross; ctx.lineWidth = Math.max(1, Math.round(dpr)) / dpr; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); ctx.stroke(); ctx.setLineDash([]);
        ctx.restore();
      } else if (over && hover.y >= 0 && hover.y < plotH) paneX = Math.round(indexAt(hover.x));
    }

    // axes
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = T.bg; ctx.fillRect(plotW, 0, AXIS_W, H); ctx.fillRect(0, timeY, W, TIME_H);
    ctx.strokeStyle = T.axisLine; ctx.lineWidth = Math.max(1, Math.round(dpr)) / dpr;
    ctx.beginPath(); ctx.moveTo(crisp(plotW, 1), 0); ctx.lineTo(crisp(plotW, 1), H); ctx.moveTo(0, crisp(plotH, 1)); ctx.lineTo(W, crisp(plotH, 1));
    if (paneOn()) { ctx.moveTo(0, crisp(paneTop, 1)); ctx.lineTo(W, crisp(paneTop, 1)); ctx.moveTo(0, crisp(timeY, 1)); ctx.lineTo(W, crisp(timeY, 1)); }   // the pane's top, the time axis
    ctx.stroke();

    const tagSrc = levelsShown.filter(levelOn).concat(drawings.filter(d => d.type === 'hline').map(d => ({ price: d.price, color: d.color || T.drawing })), orderTags);
    const tags = tagSrc.filter(L => L.price >= V.lo && L.price <= V.hi).map(L => ({ L, y: yOf(L.price) })).sort((a, b) => a.y - b.y);
    if (n >= 0) {
      // Keep level tags clear of the last price tag (32 px tall): tags priced at or above the last price
      // stack upward from it, the rest stack downward, 19 px apart, so both stay readable.
      const pTop = clamp(ly - 9, 0, Math.max(0, plotH - 32)), pBot = pTop + 32;
      const above = tags.filter(t => t.L.price >= disp.c).reverse(), below = tags.filter(t => t.L.price < disp.c);
      let lim = pTop - 10; for (const t of above) { t.y = Math.min(t.y, lim); lim = t.y - 19; }
      lim = 9; for (let k = above.length - 1; k >= 0; k--) { above[k].y = Math.max(above[k].y, lim); lim = above[k].y + 19; }   // fit under the top edge
      lim = pBot + 10; for (const t of below) { t.y = Math.max(t.y, lim); lim = t.y + 19; }
      lim = plotH - 9; for (let k = below.length - 1; k >= 0; k--) { below[k].y = Math.min(below[k].y, lim); lim = below[k].y - 19; }   // fit above the bottom edge
      tags.sort((a, b) => a.y - b.y);
    } else {
      let prev = -1e9; for (const t of tags) { t.y = Math.max(t.y, prev + 19); prev = t.y; }
      let lim = plotH - 9; for (let k = tags.length - 1; k >= 0; k--) { tags[k].y = Math.min(tags[k].y, lim); lim = tags[k].y - 19; }
    }
    liveAt = liveBtn && !V.follow ? placeLive(tags, n >= 0 ? clamp(ly - 9, 0, Math.max(0, plotH - 32)) : null) : null;
    ctx.font = '400 11px ' + T.fontMono; ctx.fillStyle = T.axisText; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (let k = k0; k <= k1 && k - k0 < 400; k++) {
      const y = yOf(k * pStep); if (y < 8 || y > plotH - 8) continue;
      if (tags.some(t => Math.abs(t.y - y) < 18) || (n >= 0 && Math.abs(ly - y) < 22)) continue;
      if (liveAt && y > liveAt.y - 8 && y < liveAt.y + liveAt.h + 8) continue;     // under the Jump to live icon
      ctx.fillText(fmtPrice(k * pStep, o.precision), plotW + 8, y);
    }
    ctx.textAlign = 'center';
    for (const l of labels) {
      if (l.x < 20 || l.x > plotW - 20 || l.quiet) continue;
      ctx.fillStyle = l.strong ? T.axisTextStrong : T.axisText;
      ctx.font = (l.strong ? '600 11px ' : '400 11px ') + T.fontMono;
      ctx.fillText(l.text, l.x, timeY + TIME_H / 2 + 1);
    }
    for (const t of tags) if (!t.L.style) axisTag(t.y, fmtPrice(t.L.price, o.precision), T.bg, t.L.color || T.axisText, t.L.color || T.axisText, null);
    for (const t of tags) {                                         // order and position tags on top; an order tag is a grab handle too
      const s = t.L.style; if (!s) continue;
      ctx.setLineDash(s.dash || []); axisTag(t.y, fmtPrice(t.L.price, o.precision), s.fill, s.fg, s.border, null); ctx.setLineDash([]);
      if (t.L.id !== undefined) {
        const hit = orderHits.find(h => h.id === t.L.id);
        if (hit) hit.tag = { x: plotW + 2, y: clamp(t.y - 9, 0, Math.max(0, plotH - 18)), w: AXIS_W - 4, h: 18 };
      }
    }

    // last price tag with countdown; flashes on each tick
    if (n >= 0) {
      axisTag(ly, fmtPrice(bars[n].c, o.precision), lastCol, lastTag, null, countdown());
      if (flash) {
        const k = Math.exp(-Math.max(0, now - flash) / 160);
        if (k > 0.02) {
          const top = clamp(ly - 9, 0, Math.max(0, plotH - 32));
          roundRect(plotW + 2, top, AXIS_W - 4, 32, 3);
          ctx.fillStyle = 'rgba(255,255,255,' + (0.38 * k).toFixed(3) + ')'; ctx.fill();
        } else flash = 0;
      }
    }

    if (hover && !pinch && hover.y >= 0 && hover.y < plotH && hover.x >= 0 && hover.x < plotW + AXIS_W) {
      const price = V.hi - hover.y / plotH * pRange;
      axisTag(hover.y, fmtPrice(roundTo(price, o.tick), o.precision), T.tagFill, T.tagText, T.tagBorder, null);
    }
    if (paneOn()) { hoverIdx = hi; drawPane(from, to, labels, paneX, paneY); }
    if (hi !== null) {
      const text = o.barSeconds < DAY ? fmtFull(bars[hi].t) : fmtDate(bars[hi].t);
      ctx.font = '500 11px ' + T.fontMono; const tw = ctx.measureText(text).width + 14;
      const x = clamp(xOf(hi) - tw / 2, 0, Math.max(0, plotW - tw));
      roundRect(x, timeY + 3, tw, TIME_H - 6, 3); ctx.fillStyle = T.tagFill; ctx.fill();
      ctx.strokeStyle = T.tagBorder; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = T.tagText; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + 7, timeY + TIME_H / 2);
    }
    hoverIdx = hi;
  }

  function emitLegend() {
    const n = last(); if (n < 0) return;
    const i = hoverIdx === null ? n : clamp(hoverIdx, 0, n);
    const b = bars[i];
    const key = i + '|' + b.o + '|' + b.h + '|' + b.l + '|' + b.c + '|' + b.v + '|' + bars.length;
    if (key === legendKey) return;
    legendKey = key;
    emit('legend', { index: i, bar: b, prev: i > 0 ? bars[i - 1] : null, forming: i === n, hovering: hoverIdx !== null });
  }

  /* ---------------- input */
  function local(e) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  /* 'pane' (1.7.0) is the delta pane and its axis column, and the band above it: dragging there pans the bars. */
  function zoneOf(p) { return paneOn() && p.y >= plotH && p.y < timeY ? 'pane' : p.x >= plotW ? 'price' : p.y >= timeY ? 'time' : 'plot'; }
  function zoomBy(delta, x) {
    V.kin = null;
    V.logT = clamp(V.logT + delta, Math.log(o.minSpacing), Math.log(o.maxSpacing));
    V.anchor = V.follow ? null : { i: indexAt(x), x };
    dirty = true;
  }
  function setCursor(z, p) {
    if (od) { cv.style.cursor = 'ns-resize'; return; }
    if (dd && dd.mode !== 'draft') { cv.style.cursor = 'grabbing'; return; }
    if (!drag && !tool && !draft && p && orderEditing) { const h = hitOrder(p); if (h) { cv.style.cursor = h.part === 'x' || h.part === 'add' ? 'pointer' : 'ns-resize'; return; } }
    if (tool || draft) { cv.style.cursor = 'crosshair'; return; }
    if (!drag && p && z === 'plot' && drawings.length) { const h = hitDrawing(p); if (h) { cv.style.cursor = h.part === 'body' ? 'move' : 'pointer'; return; } }
    cv.style.cursor = drag ? (drag.zone === 'plot' || drag.zone === 'pane' ? 'grabbing' : drag.zone === 'price' ? 'ns-resize' : 'ew-resize') : z === 'price' ? 'ns-resize' : z === 'time' ? 'ew-resize' : 'crosshair';
  }
  function onWheel(e) {
    e.preventDefault();
    const p = local(e);
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; } else if (e.deltaMode === 2) { dx *= W; dy *= H; }
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    if (Math.abs(dx) > Math.abs(dy)) {                          // sideways trackpad swipe pans 1:1
      V.kin = null; V.anchor = null; V.logT = V.logS;
      V.right += dx / V.spacing; clampRight(); setFollowFromPosition(); dirty = true; return;
    }
    if (p.x >= plotW && zoneOf(p) === 'price') {                 // over the price axis: stretch price
      const f = Math.exp(dy * 0.0015), mid = (V.hi + V.lo) / 2, half = (V.hi - V.lo) / 2 * f;
      V.auto = false; V.lo = mid - half; V.hi = mid + half; dirty = true; return;
    }
    zoomBy(-dy * (e.ctrlKey ? 0.012 : 0.0022), Math.min(p.x, plotW));
  }
  function onDown(e) {
    container.focus({ preventScroll: true });
    const p = local(e);
    pointers.set(e.pointerId, p);
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    V.kin = null; V.anchor = null; V.logT = V.logS;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, logS0: V.logS, i: indexAt((a.x + b.x) / 2) };
      drag = null; dd = null; draft = null; od = null; xDown = null; addDown = null; V.follow = false; return;
    }
    shiftHeld = !!e.shiftKey;
    const primary = e.button === 0 || e.button === undefined;
    /* 1.15.0 (Anthony: the orders are untouched by the drawing tools): on a host's chart (toolOrders) a Shift or Ctrl
       press is an order click whatever tool is armed, exactly as with none; the tool waits for a plain click */
    const toolOn = !!(tool || draft) && !(o.toolOrders && (e.shiftKey || e.ctrlKey));
    // Order lines come first (over drawings): the close handle, or the label / axis tag to drag. Not while a
    // drawing tool is active, so drawing never grabs an order by accident.
    if (primary && orderEditing && !toolOn) {
      const oh = hitOrder(p);
      if (oh && oh.part === 'x') { xDown = oh.id; return; }
      if (oh && oh.part === 'add') { addDown = { id: oh.id, which: oh.which }; return; }
      if (oh) {
        const ord = orders.find(x => x.id === oh.id);
        if (ord) { const p0 = orderPrice(ord); od = { id: ord.id, y0: p.y, price0: p0, price: p0, moved: false }; setCursor('plot', p); dirty = true; return; }
      }
    }
    /* 1.15.0 (Anthony: "Armed is off" said nowhere): a press on an order's label or tag while order editing is off does
       what it always did (a pan), and the page is told once per press, so it can say why nothing moves */
    if (primary && !orderEditing && !toolOn && orders.length) {
      const oh = hitOrder(p, true);
      if (oh) emit('orderPressOff', { id: oh.id });
    }
    if (zoneOf(p) === 'plot' && primary && toolOn) {
      if (draft) { const pb = priceAt(p.y); draft.b = { t: timeOfIdx(indexAt(p.x)), p: draft.type === 'zone' ? roundTo(pb, o.tick) : pb }; finishDraft(); return; }
      if (tool === 'hline') {
        const d = { id: genId(), type: 'hline', price: roundTo(priceAt(p.y), o.tick) };
        drawings.push(d); selectedId = d.id; drawingsChanged(); setToolInternal(null); return;
      }
      if (tool === 'trend') {
        const pt = { t: timeOfIdx(indexAt(p.x)), p: priceAt(p.y) };
        draft = { id: genId(), type: 'trend', a: pt, b: { t: pt.t, p: pt.p }, x0: p.x, y0: p.y };
        dd = { mode: 'draft' }; dirty = true; return;
      }
      if (tool === 'zone') {                                     // 1.15.0: two corners, click-click or drag; prices on the tick
        const pt = { t: timeOfIdx(indexAt(p.x)), p: roundTo(priceAt(p.y), o.tick) };
        draft = { id: genId(), type: 'zone', a: pt, b: { t: pt.t, p: pt.p }, x0: p.x, y0: p.y };
        dd = { mode: 'draft' }; dirty = true; return;
      }
    }
    if (zoneOf(p) === 'plot' && primary) {
      const hit = e.shiftKey || (o.toolOrders && e.ctrlKey) ? null : hitDrawing(p);   // Shift+click is for placing orders, never for drawings
      if (hit) { selectedId = hit.d.id; dd = { d: hit.d, part: hit.part, x0: p.x, y0: p.y, orig: cloneDrawing(hit.d) }; setCursor('plot', p); dirty = true; return; }
      if (selectedId) { selectedId = null; dirty = true; }
    }
    drag = { zone: zoneOf(p), x0: p.x, y0: p.y, right0: V.right, lo0: V.lo, hi0: V.hi, logS0: V.logS, samples: [{ t: e.timeStamp, r: V.right }], moved: false,
      place: orderEditing && !!e.shiftKey && !toolOn && zoneOf(p) === 'plot' && primary };   // Shift+click places an order if the pointer does not move
    hover = e.pointerType === 'mouse' ? p : null;
    setCursor(drag.zone); dirty = true;
  }
  function onMove(e) {
    const p = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2;
      V.logS = V.logT = clamp(pinch.logS0 + Math.log(d / pinch.d0), Math.log(o.minSpacing), Math.log(o.maxSpacing));
      V.spacing = Math.exp(V.logS);
      V.right = pinch.i + (plotW - Math.min(mx, plotW)) / V.spacing; clampRight(); dirty = true; return;
    }
    if (e.shiftKey !== shiftHeld) { shiftHeld = !!e.shiftKey; dirty = true; }
    if (od) {
      od.price = roundTo(od.price0 + (priceAt(p.y) - priceAt(od.y0)), o.tick);
      if (Math.abs(p.y - od.y0) > 2) od.moved = true;
      hover = p; setCursor('plot', p); dirty = true; return;
    }
    if (draft && (dd || e.pointerType === 'mouse')) {
      const pb = priceAt(clamp(p.y, 0, plotH));
      draft.b = { t: timeOfIdx(indexAt(Math.min(p.x, plotW))), p: draft.type === 'zone' ? roundTo(pb, o.tick) : pb };
      hover = p; dirty = true; return;
    }
    if (dd && dd.d) {
      const d = dd.d, org = dd.orig;
      if (d.type === 'hline') d.price = roundTo(org.price + (priceAt(p.y) - priceAt(dd.y0)), o.tick);
      else if (d.type === 'zone' && dd.part !== 'body') {          // 1.15.0: a corner: its time and price, the others stay
        const t = timeOfIdx(indexAt(Math.min(p.x, plotW))), pr = roundTo(priceAt(clamp(p.y, 0, plotH)), o.tick);
        d.a = { t: dd.part[0] === 'a' ? t : org.a.t, p: dd.part[1] === 'a' ? pr : org.a.p };
        d.b = { t: dd.part[0] === 'b' ? t : org.b.t, p: dd.part[1] === 'b' ? pr : org.b.p };
      } else if (d.type === 'zone') {
        const di = indexAt(p.x) - indexAt(dd.x0), dp = roundTo(priceAt(p.y) - priceAt(dd.y0), o.tick);
        d.a = { t: timeOfIdx(idxOfTime(org.a.t) + di), p: org.a.p + dp };
        d.b = { t: timeOfIdx(idxOfTime(org.b.t) + di), p: org.b.p + dp };
      }
      else if (dd.part === 'a' || dd.part === 'b') d[dd.part] = { t: timeOfIdx(indexAt(Math.min(p.x, plotW))), p: priceAt(clamp(p.y, 0, plotH)) };
      else {
        const di = indexAt(p.x) - indexAt(dd.x0), dp = priceAt(p.y) - priceAt(dd.y0);
        d.a = { t: timeOfIdx(idxOfTime(org.a.t) + di), p: org.a.p + dp };
        d.b = { t: timeOfIdx(idxOfTime(org.b.t) + di), p: org.b.p + dp };
      }
      hover = p; dirty = true; return;
    }
    if (e.pointerType === 'mouse' || drag) hover = p;
    if (drag) {
      const dx = p.x - drag.x0, dy = p.y - drag.y0;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      if (drag.zone === 'plot' || drag.zone === 'pane') {           // the delta pane pans the bars only
        V.right = drag.right0 - dx / V.spacing; clampRight();
        if (!V.auto && drag.zone === 'plot') { const sh = dy / plotH * (drag.hi0 - drag.lo0); V.lo = drag.lo0 + sh; V.hi = drag.hi0 + sh; }
        V.follow = false;
        drag.samples.push({ t: e.timeStamp, r: V.right });
        if (drag.samples.length > 12) drag.samples.shift();
      } else if (drag.zone === 'price') {
        const f = Math.exp(dy * 0.006), mid = (drag.hi0 + drag.lo0) / 2, half = (drag.hi0 - drag.lo0) / 2 * f;
        V.auto = false; V.lo = mid - half; V.hi = mid + half;
      } else {
        V.logS = V.logT = clamp(drag.logS0 + dx * 0.006, Math.log(o.minSpacing), Math.log(o.maxSpacing));
        V.spacing = Math.exp(V.logS); clampRight();
      }
    }
    if (!drag && e.pointerType === 'mouse') hoverBubble(p);      // 1.14.0: the bubble under the mouse, for the legend
    if (o.compactLabels) {                                         // 1.15.0: the compact label under the mouse shows in full
      const lh = !drag && e.pointerType === 'mouse' ? hitOrder(p, true) : null, ph = posHit;
      const id = lh ? lh.id : !drag && ph && p.x >= ph.x && p.x <= ph.x + ph.w && p.y >= ph.y && p.y <= ph.y + ph.h ? 'position' : null;
      if (id !== labelHover) { labelHover = id; dirty = true; }
    }
    setCursor(zoneOf(p), p);
    dirty = true;
  }
  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) { pinch = null; setFollowFromPosition(); } return; }
    const cancelled = e.type === 'pointercancel';
    if (addDown) {                                               // an add cell ("+SL", "+TP"): pressed and released on the same one
      const h = cancelled ? null : hitOrder(local(e)), a = addDown; addDown = null;
      if (h && h.part === 'add' && h.id === a.id && h.which === a.which && orderEditing) emit('orderPlanAdd', { id: a.id, which: a.which });
      dirty = true; return;
    }
    if (xDown !== null) {                                        // close handle: pressed and released on the same order
      const h = cancelled ? null : hitOrder(local(e)), id = xDown; xDown = null;
      if (h && h.part === 'x' && h.id === id && orderEditing) emit('orderCancel', { id });
      dirty = true; return;
    }
    if (od) {
      // A move is sent only for a release inside the plot at a price on screen. Released anywhere else (the
      // toolbar, the axes, off the chart), the drag is cancelled: the line goes back and nothing is sent.
      const d = od, p = local(e); od = null;
      const inPlot = p.x >= 0 && p.x < plotW && p.y >= 0 && p.y < plotH;
      const shown = d.price >= Math.min(V.lo, V.hi) && d.price <= Math.max(V.lo, V.hi);
      if (!cancelled && inPlot && shown && d.moved && d.price !== d.price0 && orderEditing) {
        // a planned line also says the entry price it was drawn from (a moved entry may still wait for its answer)
        const ord = orders.find(x => x.id === d.id), par = ord && ord.plan ? orders.find(x => x.id === ord.plan.parent) : null;
        const ev = { id: d.id, price: d.price };
        if (par) ev.from = orderPrice(par);
        pendingMoves.set(d.id, d.price); emit('orderMove', ev);
      }
      setCursor(zoneOf(p), p); dirty = true; return;
    }
    if (dd) {
      const p = local(e);
      if (dd.mode === 'draft') { if (draft && Math.hypot(p.x - draft.x0, p.y - draft.y0) > 4) finishDraft(); }   // drag-to-draw; a click waits for a second click
      else drawingsChanged();
      dd = null; setCursor(zoneOf(p), p); dirty = true; return;
    }
    if (drag && (drag.zone === 'plot' || drag.zone === 'pane') && drag.moved) {
      const s = drag.samples, lastS = s[s.length - 1];
      let first = lastS;
      for (let k = s.length - 1; k >= 0; k--) { if (lastS.t - s[k].t > 90) break; first = s[k]; }
      const dt = lastS.t - first.t;
      const v = dt > 0 ? (lastS.r - first.r) / dt : 0;
      if (e.timeStamp - lastS.t < 60 && Math.abs(v * V.spacing) > 0.2 && !REDUCED) V.kin = { v };
      else setFollowFromPosition();
    }
    if (drag && drag.place && !drag.moved && !cancelled && e.shiftKey && orderEditing) {
      const p = local(e);
      if (zoneOf(p) === 'plot') emit('orderPlace', { price: roundTo(priceAt(p.y), o.tick) });
    }
    drag = null;
    if (e.pointerType !== 'mouse') hover = null;
    setCursor('plot'); dirty = true;
  }
  function onLeave(e) { if (!drag && !od && e.pointerType === 'mouse') { hover = null; hoverBubble(null); labelHover = null; dirty = true; } }
  function onDbl(e) {
    const z = zoneOf(local(e));
    if (z === 'price') V.auto = true;
    else if (z === 'time') V.logT = Math.log(o.barSpacing);
    else api.reset();
    dirty = true;
  }
  function onKey(e) {
    const vis = plotW / V.spacing;
    if (e.key === 'Shift') { if (!shiftHeld) { shiftHeld = true; dirty = true; } return; }
    if (e.key === 'Escape' && (od || xDown !== null || addDown)) { od = null; xDown = null; addDown = null; setCursor('plot'); e.preventDefault(); dirty = true; return; }   // revert the drag
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dist = vis * 0.2 * (e.key === 'ArrowLeft' ? -1 : 1);
      V.follow = false; V.kin = { v: dist / o.motion.friction };
    } else if (e.key === '+' || e.key === '=') zoomBy(0.3, plotW * 0.75);
    else if (e.key === '-' || e.key === '_') zoomBy(-0.3, plotW * 0.75);
    else if (e.key === 'End') { V.kin = null; V.follow = true; V.auto = true; }
    else if (e.key === 'a' || e.key === 'A') V.auto = true;
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { drawings = drawings.filter(d => d.id !== selectedId); selectedId = null; drawingsChanged(); }
    else if (e.key === 'Escape' && (tool || draft || selectedId)) { selectedId = null; setToolInternal(null); }
    else return;
    e.preventDefault(); dirty = true;
  }
  /* The divider (1.7.0): a drag moves it with the pointer, the arrow keys by 2% of the chart height (Page Up and
     Page Down by 10%, Home and End to the largest and smallest pane). Saved by the page on 'paneResize' with done. */
  function onDivDown(e) {
    if (!paneOn()) return;
    e.preventDefault();
    try { divEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    pane.drag = { id: e.pointerId, moved: false }; divEl.classList.add('is-drag');
  }
  function onDivMove(e) {
    if (!pane.drag || e.pointerId !== pane.drag.id) return;
    const y = local(e).y;                                      // the pointer on the gap: the pane starts just under it
    if (setPaneRatio((H - TIME_H - (y + PANE_GAP / 2)) / (H - TIME_H), false)) pane.drag.moved = true;
  }
  function onDivUp(e) {
    if (!pane.drag || e.pointerId !== pane.drag.id) return;
    const moved = pane.drag.moved;
    pane.drag = null; divEl.classList.remove('is-drag');
    if (moved) emit('paneResize', { ratio: pane.ratio, height: paneH, done: true });   // a click alone saves nothing (review N7)
  }
  function onDivKey(e) {
    const steps = { ArrowUp: 0.02, ArrowDown: -0.02, PageUp: 0.1, PageDown: -0.1 };
    let r = null;
    if (Object.prototype.hasOwnProperty.call(steps, e.key)) r = pane.ratio + steps[e.key];
    else if (e.key === 'Home') r = PANE_RATIO_MAX;
    else if (e.key === 'End') r = PANE_RATIO_MIN;
    if (r === null) return;
    e.preventDefault(); e.stopPropagation();                   // not the chart's own keys (End jumps to live)
    setPaneRatio(r, true);
  }
  divEl.addEventListener('pointerdown', onDivDown);
  divEl.addEventListener('pointermove', onDivMove);
  divEl.addEventListener('pointerup', onDivUp);
  divEl.addEventListener('pointercancel', onDivUp);
  divEl.addEventListener('keydown', onDivKey);
  cv.addEventListener('wheel', onWheel, { passive: false });
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointercancel', onUp);
  cv.addEventListener('pointerleave', onLeave);
  cv.addEventListener('dblclick', onDbl);
  container.addEventListener('keydown', onKey);
  const onKeyUp = e => { if (e.key === 'Shift' && shiftHeld) { shiftHeld = false; dirty = true; } };
  container.addEventListener('keyup', onKeyUp);
  if (liveBtn) liveBtn.addEventListener('click', () => api.goLive());
  if (lockBtn) lockBtn.addEventListener('click', () => { api.setScaleLock(!scaleLocked); emit('scaleLock', scaleLocked); });
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(container);
  resize();

  /* ---------------- frame loop */
  let raf = 0, lastFrame = 0, lastDraw = 0, emaInt = 16.7, emaDraw = 1, streak = 0;
  /* Drawing errors: each message is reported (window error and the chart's 'error' event) at most once per 5 s;
     after a clean frame the slate is wiped, so the same fault coming back later is reported again. */
  const reported = new Map();                            // message -> when it was last reported (performance.now)
  let failing = false;
  function frame(now) {
    // The next frame is asked for first, so an error while drawing can never stop the chart for good (up to 1.5.0
    // one throw ended the loop and the chart froze).
    raf = requestAnimationFrame(frame);
    try {
      const dt = lastFrame ? Math.min(64, now - lastFrame) : 16.7;
      lastFrame = now;
      const t0 = performance.now();
      const moving = step(dt, now);
      if (moving || dirty) {
        dirty = false; draw(now);
        const cost = performance.now() - t0;
        emaDraw = emaDraw * 0.92 + cost * 0.08;
        const gap = now - lastDraw;
        if (gap < 40) { emaInt = emaInt * 0.9 + gap * 0.1; streak++; } else streak = 0;
        lastDraw = now;
        emitLegend();
      }
      const live = V.follow;
      if (live !== wasLive) {
        wasLive = live; if (liveBtn) liveBtn.hidden = live;
        if (live && !V.auto && !scaleLocked) { V.auto = true; dirty = true; }   // following live again: the auto-fit takes over (1.14.0), unless locked
        emit('live', live);
      }
      if (failing) { failing = false; reported.clear(); emit('error', null); }   // a clean frame: recovered
    } catch (e) {
      // draw() has one save() (the plot clip); restore() with nothing saved does nothing, so one call balances it.
      // No reset(): the canvas is opaque and would go black. What was drawn before the throw stays on screen.
      ctx.restore();
      dirty = true; failing = true;
      const msg = String(e && e.message), t = performance.now(), at = reported.get(msg);
      if (at === undefined || t - at >= 5000) {
        reported.set(msg, t);
        emit('error', { message: msg, error: e });
        setTimeout(() => { throw e; });
      }
    }
  }
  raf = requestAnimationFrame(frame);

  /* ---------------- public API */
  const api = {
    version: VERSION,
    /** Replace all bars. Keeps the live edge, or the time at the right edge when you have panned away. */
    setBars(next, opts) {
      const wasInit = bars.length > 0;
      let tRight = null;
      if (wasInit && !V.follow) tRight = bars[clamp(Math.floor(indexAt(plotW)), 0, bars.length - 1)].t;
      if (opts && opts.barSeconds) o.barSeconds = opts.barSeconds;
      bars = (next || []).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, vw: b.vw }));
      resetDisp();
      V.kin = null; V.anchor = null; V.logT = V.logS;
      if (tRight === null) { V.follow = true; V.right = followRight(); }
      else V.right = idxAtTime(tRight) + 0.5;
      if (!wasInit) V.init = false;
      clampRight(); legendKey = ''; dirty = true;
    },
    /** Add a newer bar, or update the forming one (same t). The candle grows toward it smoothly. */
    update(bar) {
      const n = bars.length, now = performance.now();
      if (!n || bar.t > bars[n - 1].t) {
        const prevC = n ? bars[n - 1].c : bar.c;
        bars.push({ t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v || 0, vw: bar.vw });
        if (bar.c !== prevC) flash = now;
      } else if (bar.t === bars[n - 1].t) {
        const b = bars[n - 1], prevC = b.c;
        b.o = bar.o; b.h = bar.h; b.l = bar.l; b.c = bar.c; b.v = bar.v || 0; b.vw = bar.vw;
        if (bar.c !== prevC) flash = now;
      } else return;
      pulseT0 = now; dirty = true;
    },
    /** Level lines: [{ name, price, color, dash, layer }]; layer 'ib' shows with the ib layer, the rest with levels. */
    setLevels(list) { levels = (list || []).filter(L => isFinite(L.price)); shadeLevels(); dirty = true; },
    getLevels() { return levels.map(L => Object.assign({}, L)); },
    setTrades(list) { trades = list || []; dirty = true; },
    setLayers(partial) {
      const had = paneOn();
      Object.assign(o.layers, partial || {});
      if (paneOn() !== had) { layout(); clampRight(); pane.init = false; }   // the delta pane came or went (1.7.0)
      pane.widths.clear();                                         // a page redraws this way when its web fonts arrive
      dirty = true;
    },
    getLayers() { return Object.assign({}, o.layers); },
    /**
     * The volume profile to draw (a ChartEngine.VolumeProfile, or null): shown while the 'vp' layer is on, as bars
     * from the right edge of the plot (the POC row VP_WIDTH of the plot width), behind the candles. The chart redraws
     * when profile.version changes, so the caller only adds trades to it.
     */
    setProfile(vp) { profile = vp && typeof vp.columns === 'function' ? vp : null; if (vpBars) vpBars.ver = -1; dirty = true; },
    getProfile() { return profile; },
    /**
     * The cumulative delta to draw (a ChartEngine.CumulativeDelta, or null), in the pane below the plot while the
     * 'delta' layer is on (1.7.0). The chart redraws when delta.version changes, so the caller only adds trades to it.
     */
    setDelta(cd) { delta = cd && typeof cd.lowerBound === 'function' ? cd : null; pane.init = false; pane.ver = -1; pane.cid++; pane.tkey = ''; pane.cc = null; dirty = true; },
    getDelta() { return delta; },
    /**
     * The chart signals to draw (G1c): { absorption: ChartEngine.Absorption, bubbles: ChartEngine.LargePrints,
     * divergence: ChartEngine.DeltaDivergence, version } (any may be null), or null. Each is drawn while its layer is on
     * ('absorption', 'bubbles'; 'divergence' with the delta pane). The chart redraws when `version` changes, so the
     * caller only feeds them trades.
     */
    setSignals(sig) { signals = sig && typeof sig === 'object' ? sig : null; sigVer = -1; dirty = true; },
    getSignals() { return signals; },
    /**
     * The delta pane's view: { mode: 'cum' (candles, the default) or 'bar' (each bar's delta around zero), ratio (its
     * share of the chart's height, PANE_RATIO_MIN to PANE_RATIO_MAX; about 20% by default), note (drawn instead of any
     * delta, '' for none), reason (why a session counts from later than its start, in brackets after "since 21:40 ET",
     * for example 'page opened'), missed (seconds the newest session's count missed; shown from 1 s: "missed 32 s") }. Only
     * the fields given change.
     */
    setDeltaView(v) {
      if (!v) return;
      if (v.mode === 'cum' || v.mode === 'bar') { if (pane.mode !== v.mode) pane.init = false; pane.mode = v.mode; }
      if (typeof v.note === 'string') pane.note = v.note;
      if (typeof v.reason === 'string') pane.reason = v.reason;
      if (typeof v.missed === 'number' && isFinite(v.missed)) pane.missed = Math.max(0, v.missed);
      if (typeof v.ratio === 'number' && isFinite(v.ratio)) { pane.ratio = clamp(v.ratio, PANE_RATIO_MIN, PANE_RATIO_MAX); layout(); clampRight(); }
      dirty = true;
    },
    /** Where the delta pane is and what it shows (CSS px from the top of the chart; title as last drawn): { on, top, height, ratio, mode, note, title, lo, hi, plotHeight }. */
    deltaPane() { return { on: paneOn(), top: paneTop, height: paneH, ratio: pane.ratio, mode: pane.mode, note: pane.note, title: pane.title, lo: pane.lo, hi: pane.hi, plotHeight: plotH }; },
    /** A delta value to y in the pane and back (CSS px from the top of the chart, as last drawn). */
    deltaToY(v) { return paneTop + (pane.hi - v) / ((pane.hi - pane.lo) || 1) * paneH; },
    /** Change colors, e.g. { up, down, vwap, bg }. The theme is built here, once per change. */
    setTheme(partial) { themeSrc = Object.assign({}, themeSrc, partial || {}); T = buildTheme(themeSrc); themeBuilds++; shadeLevels(); pane.widths.clear(); legendKey = ''; dirty = true; },
    /** The colors as chosen (not as moved to read on the ground; colors() has those). */
    getTheme() { const out = {}; for (const k in DEFAULT_THEME) out[k] = themeSrc[k]; return out; },
    /** Derived colors as drawn, e.g. upText / downText for legend text that stays readable, text2, legendBg, ground. */
    colors() { return Object.assign({}, T); },
    setPaused(v) { paused = !!v; dirty = true; },
    /** Glide and other motion time constants in ms, e.g. setMotion({ candle: 0 }) for no candle glide. */
    setMotion(partial) { Object.assign(o.motion, partial || {}); dirty = true; },
    getMotion() { return Object.assign({}, o.motion); },
    setPriceFormat(f) { if (f && f.precision !== undefined) o.precision = f.precision; if (f && f.tick !== undefined) o.tick = f.tick; V.init = false; dirty = true; },
    /** Grid lines on or off (1.14.0; the engine's default is on, the live page's off). */
    setGrid(on) { o.grid = !!on; dirty = true; },
    getGrid() { return o.grid; },
    /** Empty room right of the last bar in CSS px (1.14.0), kept at every zoom; null goes back to rightOffset bars. Jump
        to live and End keep it. */
    setRoom(px) {
      const had = followRight();
      o.room = px === null || px === undefined || !isFinite(px) ? null : Math.max(0, +px);
      if (V.follow && V.right === had) V.right = followRight();   // following: the new room at once, with no glide
      clampRight(); dirty = true;
    },
    /** The developing POC, VAH and VAL lines of the profile (1.14.0): { poc, vah, val } booleans; only those given change. */
    setProfileLines(v) { if (v) { profLines = { poc: v.poc !== undefined ? !!v.poc : profLines.poc, vah: v.vah !== undefined ? !!v.vah : profLines.vah, val: v.val !== undefined ? !!v.val : profLines.val }; dirty = true; } },
    getProfileLines() { return Object.assign({}, profLines); },
    /** The VWAP to draw instead of each bar's own (1.14.0): fn(barTime, index) -> price or null (no line there), or null
        for the bars' own. The page calls it again (or redraw()) when its values change. */
    setVwapSource(fn) { vwapSrc = typeof fn === 'function' ? fn : null; dirty = true; },
    /** Draw the next frame (a page whose own data changed, such as the VWAP source's). */
    redraw() { dirty = true; },
    /** px kept free at the top of the price scale (1.14.0: the page's legend sits there), eased in with the re-fit. */
    setFitTop(px) { const v = px > 0 && isFinite(px) ? +px : 0; if (v !== o.fitTop) { o.fitTop = v; dirty = true; } },
    getFitTop() { return o.fitTop || 0; },
    /** The bubble under the mouse as the page was last told it ({ t, p, v, side, floor } or null). */
    bubbleHover() { return bubbleHover ? { t: bubbleHover.t, p: bubbleHover.p, v: bubbleHover.v, side: bubbleHover.side } : null; },
    /** The bubbles as drawn in the last frame, for tests: [{ x, y, r, v, side }]. */
    bubbles() { const out = []; for (let k = 0; k < bubbleN; k++) { const q = bubbleShown[k]; out.push({ x: q.x, y: q.y, r: q.r, v: q.v, side: q.b.side, t: q.b.t, p: q.b.p }); } return out; },
    /** The room right of the last bar now: { px (as set, or null), bars (at this zoom), gap (CSS px from the last bar's
        center to the price axis, as drawn now) }. */
    room() { const n = last(); return { px: o.room, bars: roomNow(), gap: n >= 0 ? plotW - xOf(n) : null }; },
    /** The price scale's target and where it is now (1.14.0, for tests): { lo, hi, target: { lo, hi } | null, auto }. */
    priceScale() { const t = V.auto ? autoTarget() : null; return { lo: V.lo, hi: V.hi, target: t, auto: V.auto, plotHeight: plotH }; },
    /** The newest bar as drawn now (a copy), or null with no bars (1.14.0, for the page's readouts). */
    lastBar() { const n = last(); return n >= 0 ? Object.assign({}, bars[n]) : null; },
    /** The ATR of the closed bars (every bar but the forming one; util.atr), worked out again only when a bar closes. */
    atr(period) {
      const n = last(), p = Math.max(1, Math.round(period || 14)), b = n >= 1 ? bars[n - 1] : null;
      const key = p + '|' + n + '|' + (b ? b.t + '|' + b.h + '|' + b.l + '|' + b.c : '');
      if (atrCache.key !== key) atrCache = { key, v: n >= 1 ? atr(bars, p, n) : null };
      return atrCache.v;
    },
    /** The VWAP's edge marker as last drawn ({ up, x, y, w, h, price }), or null when the VWAP is on the scale. */
    vwapMarker() { return vwapMark ? Object.assign({}, vwapMark) : null; },
    /** The corner readout (1.15.0): a short quiet text at the plot's bottom right ('' for none), placed clear of the order
        labels and the VWAP's marker, `short` instead on a plot too narrow for it; the page sets it once a second.
        corner() says where it was last drawn and which text, or null. */
    setCorner(text, short) {
      const t = typeof text === 'string' ? text : '', s2 = typeof short === 'string' ? short : '';
      if (t !== cornerText || s2 !== cornerShort) { cornerText = t; cornerShort = s2; dirty = true; }
    },
    corner() { return cornerAt ? Object.assign({}, cornerAt) : null; },
    /** The order label the mouse is over (1.15.0, a host's compact labels: drawn in full while hovered): an order id,
        'position', or null. */
    labelHover() { return labelHover; },
    /** Replace the bar-close countdown under the price tag (e.g. ticks left in a range bar). null restores it. */
    setCountdown(fn) { countdownFn = typeof fn === 'function' ? fn : null; dirty = true; },
    /** Fill markers: [{ t, price, side: 'buy' | 'sell', qty }] */
    setMarkers(list) { markers = (list || []).filter(m => isFinite(m.price) && isFinite(m.t)); dirty = true; },
    /** The fill markers as set (1.6.0, for reading). */
    getMarkers() { return markers.map(m => Object.assign({}, m)); },
    /** Drawing tool: 'hline', 'trend' or null. */
    setTool(t) { setToolInternal(t === 'hline' || t === 'trend' || t === 'zone' ? t : null); },
    getTool() { return tool; },
    setDrawings(list) { drawings = (list || []).filter(d => d && (d.type === 'hline' || d.type === 'trend' || d.type === 'zone')).map(cloneDrawing); selectedId = null; draft = null; dirty = true; },
    getDrawings() { return drawings.map(cloneDrawing); },
    deleteSelected() { if (!selectedId) return false; drawings = drawings.filter(d => d.id !== selectedId); selectedId = null; drawingsChanged(); dirty = true; return true; },
    clearDrawings() { drawings = []; selectedId = null; draft = null; drawingsChanged(); dirty = true; },
    setBarSeconds(sec) { o.barSeconds = sec; dirty = true; },
    /**
     * Working orders: [{ id, side: 'buy' | 'sell', kind: 'limit' | 'stop' | 'market', price, qty, filled, role }].
     * role 'stop' / 'target' marks bracket legs. Replaces the list and drops prices still waiting on a move.
     * 1.13.0: `plan: { parent, offset, role, ticks }` marks a planned stop or target of a resting entry (`parent` its id,
     * `offset` signed ticks from the entry's price, `role` 'stop' or 'target'): drawn fainter and finely dashed, labelled
     * "SL plan -12t" / "TP plan +24t", it follows the entry while that is dragged and is dragged and closed like an
     * order (orderMove with its own id and `from`, the entry price it was drawn from; orderCancel). `adds: ['stop', 'target']` on an entry draws "+SL" / "+TP" cells on
     * its label while editing; a click on one emits orderPlanAdd { id, which }.
     */
    setOrders(list) {
      orders = (list || []).filter(x => x && x.id !== undefined && isFinite(x.price) && x.price !== null)
        .map(x => {
          const y = { id: x.id, side: x.side === 'sell' ? 'sell' : 'buy', kind: x.kind, price: +x.price, qty: +x.qty || 0, filled: +x.filled || 0, role: x.role || null };
          if (x.plan && x.plan.parent !== undefined && isFinite(x.plan.offset)) y.plan = { parent: x.plan.parent, offset: Math.round(+x.plan.offset), role: x.plan.role === 'target' ? 'target' : 'stop', ticks: Math.abs(Math.round(+x.plan.offset)) };
          if (Array.isArray(x.adds)) y.adds = x.adds.filter(w => w === 'stop' || w === 'target');
          return y;
        });
      pendingMoves.clear();
      if (od && !orders.some(x => x.id === od.id)) od = null;
      dirty = true;
    },
    getOrders() { return orders.map(x => Object.assign({}, x)); },
    /** Position line: { qty (long > 0, short < 0), avgPrice } or null. pointValue (here or in options) adds dollars. */
    setPosition(pos, opts) {
      const pv = (opts && opts.pointValue) || (pos && pos.pointValue) || 0;
      position = pos && +pos.qty && isFinite(pos.avgPrice) ? { qty: +pos.qty, avgPrice: +pos.avgPrice, pointValue: pv } : null;
      dirty = true;
    },
    getPosition() { return position ? Object.assign({}, position) : null; },
    /** Order editing on: drag order labels to move, x to cancel, Shift+click to place. Off: orders are display only. */
    setOrderEditing(on) { orderEditing = !!on; if (!orderEditing) { od = null; xDown = null; addDown = null; } dirty = true; },
    /** fn(price) -> { side, kind, qty, note } or null: what Shift+click would place, shown while Shift is held. */
    setOrderPreview(fn) { orderPreview = typeof fn === 'function' ? fn : null; dirty = true; },
    /** Where each order's label, close handle and axis tag were last drawn (CSS px in the chart), for tests and tooltips. */
    orderHandles() { return orderHits.map(h => JSON.parse(JSON.stringify(h))); },
    /** Price to y and back, in CSS px from the top of the chart (as last drawn). */
    priceToY(price) { return yOf(price); },
    /** The x of bar i's centre, CSS px from the left of the chart (as last drawn; G1c, for tests and hosts). */
    barToX(i) { return xOf(i); },
    yToPrice(y) { return priceAt(y); },
    goLive() { V.kin = null; V.follow = true; V.auto = true; dirty = true; },
    /** The price scale lock (1.14.0): locked, a zoom set by hand is kept (no auto-fit near the edge or on scrolling back to
        live) until unlocked (the auto-fit then takes over), End or goLive(). on('scaleLock', locked) after a click on it. */
    setScaleLock(on) { const v = !!on; if (v === scaleLocked) return; scaleLocked = v; if (!v) V.auto = true; syncLock(); dirty = true; },
    scaleLock() { return scaleLocked; },
    reset() { V.auto = true; V.follow = true; V.kin = null; V.anchor = null; V.logT = Math.log(o.barSpacing); dirty = true; },
    isLive() { return V.follow; },
    bars() { return bars; },
    on(ev, fn) { if (listeners[ev]) listeners[ev].push(fn); return () => { const a = listeners[ev]; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }; },
    stats() {
      const now = performance.now();
      return { idle: now - lastDraw > 250 || streak < 3, fps: Math.round(1000 / emaInt), drawMs: emaDraw, themeBuilds, profileBuilds: vpBuilds };
    },
    resize,
    destroy() {
      cancelAnimationFrame(raf); if (ro) ro.disconnect();
      container.removeEventListener('keydown', onKey);
      container.removeEventListener('keyup', onKeyUp);
      cv.remove(); if (liveBtn) liveBtn.remove(); if (lockBtn) lockBtn.remove(); divEl.remove();
      container.classList.remove('ce-host');
    },
  };
  return api;
}

/* ---------------------------------------------------------------- color settings panel */
/**
 * A "Colors" button with a small panel: presets, bull / bear / VWAP pickers, the chart background (presets and a
 * picker, 1.5.3), reset. Choices are saved in this browser under `storageKey` and applied on load, one color at a
 * time on a fresh read of the key, so two charts or tabs sharing the key never undo each other.
 * `onChange(colors)` runs on load and after every change.
 * 1.9.0: `vwap: false` leaves the VWAP picker out (the live page sets it in the VWAP indicator's gear); `note` replaces
 * the line at the bottom; the returned `slot` is an element before Reset where a host adds its own sections.
 */
function mountThemePanel(chart, host, options) {
  const opt = Object.assign({ storageKey: 'chart-engine-colors-v1', label: 'Colors', vwap: true, note: 'Saved in this browser only.' }, options || {});
  injectStyle();
  const FIELDS = [['up', 'Bull'], ['down', 'Bear'], ['vwap', 'VWAP'], ['bg', 'Ground']].filter(([k]) => k !== 'vwap' || opt.vwap);
  const defaults = {}; for (const [k] of FIELDS) defaults[k] = DEFAULT_THEME[k];
  const load = () => { try { return JSON.parse(localStorage.getItem(opt.storageKey) || 'null'); } catch (e) { return null; } };
  const store = v => { try { localStorage.setItem(opt.storageKey, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };
  const clean = v => { const out = {}; for (const [k] of FIELDS) if (v && /^#[0-9a-f]{6}$/i.test(v[k])) out[k] = v[k].toUpperCase(); return out; };

  let cur = Object.assign({}, defaults, clean(load()));
  chart.setTheme(cur);
  const changed = () => { if (typeof opt.onChange === 'function') opt.onChange(Object.assign({}, cur)); };

  const wrap = document.createElement('div'); wrap.className = 'ce-theme';
  const uid = 'ce' + Math.random().toString(36).slice(2, 8);
  wrap.innerHTML =
    '<button type="button" class="ce-theme-btn" aria-expanded="false" aria-controls="' + uid + '">' +
      '<span class="ce-sw2" aria-hidden="true"><i data-k="up"></i><i data-k="down"></i></span>' + opt.label + '</button>' +
    '<div class="ce-theme-panel" id="' + uid + '" role="dialog" aria-label="Chart colors" hidden>' +
      '<div class="ce-lbl">Presets</div><div class="ce-presets"></div>' +
      '<div class="ce-lbl">Custom</div>' +
      FIELDS.map(([k, name]) => (k === 'bg' ? '<div class="ce-lbl" id="' + uid + '-bglbl">Background</div><div class="ce-grounds" role="group" aria-labelledby="' + uid + '-bglbl"></div>' : '') +
        '<label class="ce-row" for="' + uid + '-' + k + '"><span>' + (k === 'bg' ? 'Any' : name) + '</span>' +
        '<input type="color" id="' + uid + '-' + k + '" data-k="' + k + '"' + (k === 'bg' ? ' aria-label="Background color"' : '') + '>' +
        '<input type="text" data-hex="' + k + '" aria-label="' + (k === 'bg' ? 'Background' : name) + ' hex" maxlength="7" spellcheck="false"></label>').join('') +
      '<div class="ce-slot"></div>' +
      '<button type="button" class="ce-reset">Reset to default</button>' +
      '<div class="ce-note">' + opt.note + '</div>' +
    '</div>';
  host.appendChild(wrap);
  const btn = wrap.querySelector('.ce-theme-btn'), panel = wrap.querySelector('.ce-theme-panel'), slot = wrap.querySelector('.ce-slot');
  const presetsEl = wrap.querySelector('.ce-presets');
  for (const p of PRESETS) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ce-preset'; b.dataset.id = p.id;
    b.innerHTML = '<span class="ce-sw2" aria-hidden="true"><i style="background:' + p.up + '"></i><i style="background:' + p.down + '"></i></span>' + p.name;
    b.addEventListener('click', () => apply({ up: p.up, down: p.down }));
    presetsEl.appendChild(b);
  }
  const groundsEl = wrap.querySelector('.ce-grounds');
  for (const g of BACKGROUNDS) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ce-ground'; b.dataset.bg = g.id;
    b.innerHTML = '<i aria-hidden="true" style="background:' + g.bg + '"></i>' + g.name + (g === BACKGROUNDS[0] ? ' <span class="ce-note">(default)</span>' : '');
    b.addEventListener('click', () => apply({ bg: g.bg }));
    groundsEl.appendChild(b);
  }
  function sync() {
    for (const i of wrap.querySelectorAll('.ce-theme-btn i')) i.style.background = cur[i.dataset.k];
    for (const [k] of FIELDS) {
      wrap.querySelector('input[type=color][data-k="' + k + '"]').value = cur[k].toLowerCase();
      const t = wrap.querySelector('input[data-hex="' + k + '"]'); if (document.activeElement !== t) t.value = cur[k];
    }
    for (const b of presetsEl.children) {
      const p = PRESETS.find(x => x.id === b.dataset.id);
      b.setAttribute('aria-pressed', String(p.up === cur.up && p.down === cur.down));
    }
    for (const b of groundsEl.children) b.setAttribute('aria-pressed', String(BACKGROUNDS.find(x => x.id === b.dataset.bg).bg === cur.bg));
  }
  /* Saves only the fields this change set, on a fresh read, so two charts sharing the key never undo each other. */
  function apply(partial) {
    const set = clean(Object.assign({}, cur, partial)), fields = Object.keys(clean(partial || {}));
    cur = Object.assign({}, cur, set);
    chart.setTheme(cur);
    const saved = Object.assign(clean(load()), ...fields.map(k => ({ [k]: cur[k] })));
    store(saved); sync(); changed();
  }
  for (const inp of wrap.querySelectorAll('input[type=color]')) inp.addEventListener('input', () => apply({ [inp.dataset.k]: inp.value }));
  /* Hex boxes: #RRGGBB, or the #RGB shorthand (1.5.3); the # may be left out. Anything else is marked invalid
     (red border, aria-invalid) and not applied; leaving the box puts the current color back. */
  const hexOf = text => {
    let v = text.trim(); if (v[0] !== '#') v = '#' + v;
    if (/^#[0-9a-f]{3}$/i.test(v)) v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    return /^#[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : null;
  };
  for (const inp of wrap.querySelectorAll('input[data-hex]')) {
    inp.addEventListener('input', () => {
      const v = hexOf(inp.value);
      if (v) { inp.removeAttribute('aria-invalid'); apply({ [inp.dataset.hex]: v }); }
      else inp.setAttribute('aria-invalid', 'true');
    });
    inp.addEventListener('change', () => { inp.removeAttribute('aria-invalid'); inp.value = cur[inp.dataset.hex]; });
  }
  wrap.querySelector('.ce-reset').addEventListener('click', () => apply(defaults));
  /* The panel opens under the button, right-aligned; when that would run off the left edge (the button wrapped to the
     start of a toolbar row), it is left-aligned instead (1.5.3). */
  const open = v => {
    panel.hidden = !v; btn.setAttribute('aria-expanded', String(v));
    if (v) { panel.classList.remove('ce-left'); if (panel.getBoundingClientRect().left < 8) panel.classList.add('ce-left'); }
  };
  btn.addEventListener('click', () => open(panel.hidden));
  const outside = e => { if (!wrap.contains(e.target)) open(false); };
  document.addEventListener('pointerdown', outside);
  wrap.addEventListener('keydown', e => { if (e.key === 'Escape') { open(false); btn.focus(); } });
  sync(); changed();
  return {
    element: wrap, slot, get: () => Object.assign({}, cur), set: apply, close: () => open(false), isOpen: () => !panel.hidden,
    /** Remove the panel and its document listener (for a chart that is taken down, such as an embedded pane). */
    destroy() { document.removeEventListener('pointerdown', outside); wrap.remove(); },
  };
}

/* ---------------------------------------------------------------- volume profile (1.6.0) */
/*
 * VolumeProfile: the session volume profile from trades. The chart draws one with setProfile() and the 'vp' layer
 * (drawProfile below); this class only counts.
 *
 * Input: trades (t, price, v), with t in exchange wall-clock seconds stored as if UTC like every time here.
 * The trades carry no aggressor side (ChartBridge sends [t, p, v] for the backfill and {t, p, v} live, from
 * NinjaTrader's Last events), so there is no buy/sell split per row. Nothing is inferred.
 *
 * Rows: each price is turned into a whole number of ticks once, P = Math.round(price / tick), and rows are whole
 * groups of `rowTicks` ticks, row = floor(P / rowTicks), so a row covers ticks row * rowTicks to
 * row * rowTicks + rowTicks - 1 and rows line up on multiples of rowTicks ticks from zero (rowTicks 4 on NQ:
 * whole points). Volumes live in one Float64Array indexed by row, never in a map keyed by a float price, and
 * prices are only made back from whole ticks for output. Rows with no trades between the lowest and highest
 * row are rows of volume 0 (they are prices inside the profile). A price exactly half way between two ticks
 * goes to the higher tick (Math.round rounds halves up, also below zero: -0.125 goes to 0 at a 0.25 tick).
 * Prices on the tick grid, with or without float noise, are never affected.
 *
 * Session: the profile holds one trading session, the engine's tradeDay(t, sessionStart), the same 18:00 ET
 * boundary as the range bars and the session VWAP. The first trade of a later session (or advance(t)) empties
 * it; a trade from an earlier session than the one held is left out and counted in `skipped`.
 *
 * RTH (option `rth: true`, Anthony's ruling 2026-09-29): only trades inside the regular session of the trading day
 * count, from rthStart (9:30:00.000 ET) up to, not including, rthEnd (16:00:00.000 ET), the same window as the
 * chart's RTH shading and sessionLevels. A trade at 9:29:59.999 or at 16:00:00.000 is out. On an NYSE early-close
 * day (rthClose: the day after Thanksgiving, Christmas Eve, July 3) the window ends at the stock market's 13:00
 * close instead (CME equity index futures trade on to 13:15; those 15 minutes are out). Times are New York wall
 * clock already (ChartBridge converts them), so DST needs nothing here. On a day with no stock market session (a
 * weekend, an NYSE holiday: rthDay, the IB's rule) nothing counts. The session still moves at 18:00 as above, so
 * the RTH profile empties at 18:00 and stays empty until 9:30. Trades outside the window change nothing but the
 * `outside` count (not `skipped`, which is for bad input), and do not change `version`.
 *
 * Keep (option `keep: true`, Anthony's rulings of 2026-09-30; the page uses it): the profile keeps the last session
 * it counted until the next session's first trade, so a Friday can be reviewed over the weekend. The full session: a
 * trading day with no stock market session (closedDay: Saturday, Sunday, an NYSE holiday; the trading day runs from
 * 18:00 ET the evening before) never empties it on the clock (advance does nothing); on a weekday evening the next
 * session starts at 18:00 as in 1.6.0. With `rth`: the RTH profile stays through the weekday night, weekends and
 * holidays until the next RTH trade (9:30 on the next day with a stock market session): trades outside the RTH window
 * never move it and the clock never does (on Labor Day or Thanksgiving Globex trades, but there is no RTH: the RTH of
 * the day before stays). Without `keep` (the default) the session moves as 1.6.0's.
 *
 * Cost: add() is amortised O(1): most trades only add to a row, and a row outside the array grows it to twice
 * the span needed, so the copies add up to O(1) per trade (one add can copy the whole span; a new session
 * clears the old span once). poc() and valueArea() walk the rows once (a session of NQ is a few thousand rows)
 * and both are cached by `version`, so asking again before the next change walks nothing.
 *
 * POC: the row with the most volume. Tie-break (a question for Anthony): of the rows tied for the most volume,
 * the one closest to the middle of the profile (halfway between its lowest and highest row); if two are equally
 * close, the lower one.
 *
 * Value area, the CBOT Market Profile method applied to volume rows:
 *   1. Start with the POC row. The value area must hold at least `valueArea` (default 70%) of the volume.
 *   2. Take the next two rows above the value area and add their volumes; do the same for the next two rows
 *      below. Where fewer than two rows are left on a side, that side's sum is what is left.
 *   3. Add the pair with the larger sum to the value area. If one side has no rows left, add the other side.
 *      If the two sums are equal, add both pairs (a question for Anthony).
 *   4. Repeat 2 and 3 until the value area holds at least that share of the volume.
 * VAH is the top tick of the highest row in the value area and VAL the bottom tick of the lowest.
 *
 * History, then live (how live/live.js wires it, vpBuild and onTick there): the page keeps every trade
 * in its TickStore (live/bar-builder.js). Until ChartBridge sends `ready`, trades come only as the backfill
 * (onTick drops live ticks before then, and ChartBridge holds them back until after `ready`); after it, only as
 * `tick` messages, each pushed to the store once. So, like the range bars: at `ready`, feed the store into a new
 * profile (store.feed(profile, 0), or with minT set to this session's start to skip older sessions), then in
 * onTick call profile.add(t, p, v) right after the store's push. A rebuild is a new profile fed from the store
 * again. The profile then holds exactly what the store holds. That is only as good as the store: ChartBridge
 * cuts the backfill by time and the held live ticks by arrival, so a trade near that seam can come in both and
 * be counted twice (the range bars and the forming minute bar too). Trades carry no id, so the page cannot tell;
 * ChartBridge 0.3.3 settles this seam on its side (nt8/PROTOCOL.md, Backfill and live), with no change here.
 *
 * Open questions for Anthony (the code does one thing today; none of it is settled):
 *   - POC tie-break: closest to the middle of the profile, then the lower (above).
 *   - Equal pairs in the value area: both are added (above). On a flat profile this can take a 70% ask to 90%.
 *   - A price half way between two ticks goes to the higher tick (above).
 *   - Stray prices: a bad print far from the rest (a 0, half the price) is taken like any trade and widens the
 *     profile for the rest of the session. Should prints too far from the profile (say more than some number of
 *     points from its range) be left out? VP_MAX_ROWS does not do this; it only limits memory.
 *   - Prints with volume 0 are left out (they move the range bars, not the profile).
 */
/* A limit on memory only (8 MB of rows, 16 MB of array at most): a trade that would stretch the profile past this
   many rows is left out. It does not catch stray prices: at a 0.25 tick every price from 0 to about 262,000 fits. */
const VP_MAX_ROWS = 1 << 20;
class VolumeProfile {
  constructor(opts) {
    const o = opts || {};
    this.tick = o.tick === undefined ? 0.25 : o.tick;
    this.rowTicks = o.rowTicks === undefined ? 1 : o.rowTicks;
    this.valueAreaShare = o.valueArea === undefined ? 0.7 : o.valueArea;
    this.sessionStart = o.sessionStart === undefined ? 18 * 3600 : o.sessionStart;
    this.rth = !!o.rth;
    this.rthStart = o.rthStart === undefined ? 34200 : o.rthStart;
    this.rthEnd = o.rthEnd === undefined ? 57600 : o.rthEnd;
    this.keep = !!o.keep;
    if (!(this.tick > 0 && isFinite(this.tick))) throw new RangeError('VolumeProfile: tick must be a positive number');
    if (!(Number.isInteger(this.rowTicks) && this.rowTicks >= 1)) throw new RangeError('VolumeProfile: rowTicks must be a whole number of ticks, 1 or more');
    VolumeProfile._share(this.valueAreaShare);
    this._vol = new Float64Array(0); this._base = 0;
    this.reset();
  }
  /**
   * A profile of the last session with trades in `store` (the page's TickStore, or anything with length, time(i) and
   * feed(builder, from, minT), oldest first), made with `opts` (1.6.1; with `keep: true` it is the one the page
   * draws). It feeds from the start of the last trade's session; while that holds nothing (RTH before 9:30, a weekend
   * or a holiday since) from one trading day earlier, at most 7 days back and not before the store's first trade.
   * Empty when the store holds nothing that counts.
   */
  static fromStore(store, opts) {
    let vp = new VolumeProfile(opts);
    const n = store && store.length || 0;
    if (!n) return vp;
    const first = store.time(0);
    let d = tradeDay(store.time(n - 1), vp.sessionStart);
    for (let k = 0; ; k++, d--) {
      const from = vp.startOfDay(d);
      store.feed(vp, 0, from);
      // look further back only while the day just tried has no stock market session, or for RTH (a kept profile's rule)
      if (!vp.empty) return vp;
      if (from <= first || k >= 7 || !(vp.keep && (vp.rth || closedDay(d)))) return new VolumeProfile(opts);   // nothing counts: empty, no day
      vp = new VolumeProfile(opts);
    }
  }
  static _share(p) {
    if (!(p > 0 && p <= 1)) throw new RangeError('VolumeProfile: the value area share must be above 0 and at most 1');
    return p;
  }
  /** Empty the profile (it takes the session of the next trade). */
  reset() { this._clear(); this.day = null; this.skipped = 0; this.outside = 0; }
  _clear() {
    if (this._lo <= this._hi) this._vol.fill(0, this._lo - this._base, this._hi - this._base + 1);
    this._lo = Infinity; this._hi = -Infinity;           // rows used; lo > hi when empty
    this.total = 0; this.trades = 0; this._ver = (this._ver || 0) + 1;
    this._poc = null; this._va = null; this._cols = null;   // caches, each valid while its .ver equals _ver
  }
  /** Changes with every trade taken, every reset and every move to a new session (not on a trade left out). */
  get version() { return this._ver; }
  get empty() { return this.trades === 0; }
  /** Whether trade time t is inside the RTH window (9:30:00.000 up to 16:00:00.000 ET, 13:00:00.000 on an NYSE
      early-close day, on a day with a session). The day's close is looked up once per calendar day. */
  inRth(t) {
    const s = tod(t);
    if (s < this.rthStart || s >= this.rthEnd) return false;
    const day = Math.floor(t / DAY);
    if (this._rthDay !== day) { this._rthDay = day; this._rthClose = rthClose(t); }
    return this._rthClose !== null && s < this._rthClose;
  }
  /**
   * The time from which this profile needs every trade, for the trading day holding t: that session's start
   * (18:00 ET the evening before), or with `rth` that day's 9:30. For coverage notes (was the history long enough).
   */
  startOf(t) { return this.startOfDay(tradeDay(t, this.sessionStart)); }
  /** startOf for trading day d (as in `day`): the session held starts at startOfDay(profile.day). */
  startOfDay(d) {
    if (this.rth) return d * DAY + this.rthStart;
    return this.sessionStart ? (d - 1) * DAY + this.sessionStart : d * DAY;
  }
  _px(n) { return +(n * this.tick).toFixed(10); }
  _row(price) { return Math.floor(Math.round(price / this.tick) / this.rowTicks); }

  /*
   * Grow the array to hold row r: twice the span needed, centred on it. Returns false when the span would pass
   * VP_MAX_ROWS (a memory limit only), and the caller then leaves the trade out.
   */
  _grow(r) {
    const lo = Math.min(this._lo, r), hi = Math.max(this._hi, r), span = hi - lo + 1;
    if (span > VP_MAX_ROWS) return false;
    const cap = Math.max(64, span * 2), base = lo - Math.floor((cap - span) / 2), next = new Float64Array(cap);
    if (this._lo <= this._hi) next.set(this._vol.subarray(this._lo - this._base, this._hi - this._base + 1), this._lo - base);
    this._vol = next; this._base = base;
    return true;
  }

  /**
   * Add one trade. Amortised O(1). Returns true when the trade started a new session (the profile was emptied
   * first). Left out and counted in `skipped`, changing nothing else: a time, price or volume that is not of type
   * number or not finite (null, strings such as '5', booleans, undefined, NaN, Infinity), a volume of 0 or less,
   * a trade from an earlier session than the one held, and a trade that would stretch the profile past
   * VP_MAX_ROWS rows. With `rth`, a trade outside the RTH window is counted in `outside` and changes nothing else
   * (it can still start a new session, which empties the profile).
   */
  add(t, price, v) {
    if (typeof t !== 'number' || typeof price !== 'number' || typeof v !== 'number' ||
        !isFinite(t) || !isFinite(price) || !(v > 0 && v < Infinity)) { this.skipped++; return false; }
    const d = tradeDay(t, this.sessionStart);
    let fresh = false;
    if (d !== this.day) {
      if (this.day !== null && d < this.day) { this.skipped++; return false; }
      // keep: an RTH profile outlives the Globex trades until the next RTH trade (the night, a weekend, a holiday)
      if (this.keep && this.rth && this.day !== null && !this.inRth(t)) { this.outside++; return false; }
      this._clear(); this.day = d; fresh = true;
    }
    if (this.rth && !this.inRth(t)) { this.outside++; return fresh; }
    const r = this._row(price);
    if ((r < this._base || r >= this._base + this._vol.length) && !this._grow(r)) { this.skipped++; return fresh; }
    this._vol[r - this._base] += v;
    this.total += v; this.trades++;
    if (r < this._lo) this._lo = r;
    if (r > this._hi) this._hi = r;
    this._ver++;
    return fresh;
  }
  /** add() with no result, so TickStore.feed(profile, from, minT) builds a profile from the page's ticks. */
  addQuiet(t, price, v) { this.add(t, price, v); }
  /** Add trades as ChartBridge sends them, [[t, p, v], ...]. */
  addAll(list) { for (let i = 0; i < list.length; i++) { const x = list[i]; this.add(x[0], x[1], x[2]); } return this; }
  /**
   * Move to the session holding t with no trade (for example on the clock at 18:00 ET before the first trade of
   * the new session). Returns true when the profile moved to that later session (it is then empty). With `keep` it
   * does nothing on a trading day with no stock market session (a weekend or an NYSE holiday), nor after one
   * until a trade comes: the first trade of the next session moves it (add). On weekday evenings it moves at 18:00.
   */
  advance(t) {
    const d = tradeDay(t, this.sessionStart);
    if (!isFinite(d) || (this.day !== null && d <= this.day)) return false;
    // keep: RTH never moves on the clock; the full session not on a weekend or a holiday, nor after one until the next
    // session's first trade
    if (this.keep && (this.rth || closedDay(d) || (this.day !== null && closedBetween(this.day, d)))) return false;
    this._clear(); this.day = d;
    return true;
  }

  _rowOut(r) {
    const p = r * this.rowTicks, price = this._px(p);
    return { price, high: this.rowTicks === 1 ? price : this._px(p + this.rowTicks - 1), volume: this._vol[r - this._base] };
  }
  /** Lowest and highest traded price (bottom tick of the lowest row, top tick of the highest), or null. */
  get low() { return this.trades ? this._px(this._lo * this.rowTicks) : null; }
  get high() { return this.trades ? this._px(this._hi * this.rowTicks + this.rowTicks - 1) : null; }
  /** Volume of the row holding `price` (0 outside the profile). */
  volumeAt(price) {
    const r = this._row(price);
    return this.trades && r >= this._lo && r <= this._hi ? this._vol[r - this._base] : 0;
  }
  /** Rows from the lowest price up: { price (bottom tick), high (top tick; the same when rowTicks is 1), volume }. */
  rows() {
    const out = [];
    for (let r = this._lo; r <= this._hi; r++) out.push(this._rowOut(r));
    return out;
  }
  _pocRow() {
    if (!this.trades) return null;
    if (this._poc && this._poc.ver === this._ver) return this._poc.row;
    const V = this._vol, b = this._base, mid2 = this._lo + this._hi;   // twice the middle row, to stay in whole numbers
    let best = this._lo, bv = V[best - b], bd = Math.abs(2 * best - mid2);
    for (let r = this._lo + 1; r <= this._hi; r++) {
      const v = V[r - b];
      if (v < bv) continue;
      const dist = Math.abs(2 * r - mid2);
      if (v > bv || dist < bd) { best = r; bv = v; bd = dist; }   // rows run upward, so an equal distance keeps the lower
    }
    this._poc = { ver: this._ver, row: best, out: Object.freeze(this._rowOut(best)) };
    return best;
  }
  /**
   * The point of control: { price, high, volume } of the row with the most volume (tie-break above), or null.
   * Cached by version: the same frozen object until the profile changes.
   */
  poc() { return this._pocRow() === null ? null : this._poc.out; }
  /**
   * The value area by the CBOT method above, for `share` of the volume (default: the profile's valueArea).
   * Returns a frozen { val, vah, volume, share, poc } or null when empty. Cached by version (for the last share
   * asked): the same object until the profile changes.
   */
  valueArea(share) {
    const s = share === undefined ? this.valueAreaShare : VolumeProfile._share(share);
    if (!this.trades) return null;
    const c = this._va;
    if (c && c.ver === this._ver && c.share === s) return c.out;
    const V = this._vol, b = this._base, L = this._lo, H = this._hi, poc = this._pocRow();
    const need = s * this.total * (1 - 1e-12);          // 70% of 100 is 70.00000000000001 in floats: 70 must do
    let lo = poc, hi = poc, acc = V[poc - b];
    while (acc < need && (lo > L || hi < H)) {
      const nUp = Math.min(2, H - hi), nDn = Math.min(2, lo - L);
      let up = 0, dn = 0;
      for (let k = 1; k <= nUp; k++) up += V[hi + k - b];
      for (let k = 1; k <= nDn; k++) dn += V[lo - k - b];
      const takeUp = nUp > 0 && (nDn === 0 || up >= dn), takeDn = nDn > 0 && (nUp === 0 || dn >= up);
      if (takeUp) { hi += nUp; acc += up; }
      if (takeDn) { lo -= nDn; acc += dn; }
    }
    const out = Object.freeze({
      share: s, volume: acc, poc: this._poc.out,
      val: this._px(lo * this.rowTicks), vah: this._px(hi * this.rowTicks + this.rowTicks - 1),
    });
    this._va = { ver: this._ver, share: s, out };
    return out;
  }
  /**
   * Everything the chart draws, in one object cached by version (the rows are walked once per change, never per
   * frame): { version, low (bottom tick of the lowest row), step (price per row), tick, volumes (a Float64Array copy,
   * lowest row first), max (the largest row volume), poc, vaLow, vaHigh (row indexes into volumes, the value area for
   * the profile's own share) }, or null when empty. Read only: the same object is handed out until the next change.
   */
  columns() {
    if (!this.trades) return null;
    if (this._cols && this._cols.version === this._ver) return this._cols;
    const L = this._lo, n = this._hi - L + 1, volumes = this._vol.slice(L - this._base, L - this._base + n);
    let max = 0;
    for (let i = 0; i < n; i++) if (volumes[i] > max) max = volumes[i];
    const va = this.valueArea();
    this._cols = {
      version: this._ver, low: this._px(L * this.rowTicks), step: this.tick * this.rowTicks, tick: this.tick, volumes, max,
      poc: this._pocRow() - L, vaLow: this._row(va.val) - L, vaHigh: this._row(va.vah) - L,
    };
    return this._cols;
  }
}

/* ---------------------------------------------------------------- cumulative delta (1.7.0) */
/**
 * Cumulative delta, the compute core (ChartEngine.CumulativeDelta; Anthony's rulings 2026-09-30).
 *
 * Delta is market buys minus market sells, in contracts. The side of every trade comes from ChartBridge 0.3.4
 * (nt8/PROTOCOL.md, Trade side: the prevailing bid or ask, then the tick rule between them); this code never works a
 * side out. A trade with side 0 (unknown) or with no side at all adds nothing, and is counted (`unknown`, and
 * `missing` for no side at all).
 *
 * One candle per price bar, in the chart's bars: open is the cumulative value at the bar's start (the previous bar's
 * close in the session, 0 at the session's start), high, low and close the extremes and last value of the running
 * cumulative inside the bar (the open included). Bar delta (the bar's own buys minus sells) is close minus open. It
 * starts again at 0 at each session start, 18:00 ET, on the same boundary as the range bars, VWAP and the volume
 * profile (`tradeDay`; times are New York wall clock, so both DST changes are already in them).
 *
 * Bars: the caller names the price bar each trade landed in (`barT`, its start time, as the bar builder made it); with
 * no `barT`, trades are bucketed by `seconds` like the page's time bars (the bar of floor(t / seconds) * seconds, a
 * late trade folded into the newest bar). Range bars must pass `barT`: only the builder knows where a range bar starts.
 *
 * Coverage: the cumulative value is only honest from a moment on which the page has every trade (`coveredFrom`).
 * Trades of a bar that started before it are left out (counted in `uncovered`), so a bar is either complete or not
 * there, and a session that started before it begins at 0 on its first complete bar: `partial` on its session, with
 * `from`, the time it counts from (the chart then says "Cumulative delta +1,234 since 21:40 ET"). With `byTime`
 * (the page's 5m and longer views, round 5), the bar holding `coveredFrom` is not left out: its trades count from
 * `coveredFrom` by their own time, it opens at 0, and the session's `from` is `coveredFrom` itself.
 *
 * Fed like the volume profile: at `ready` from the page's TickStore (TickStore.feedSides, or with a range bar builder
 * beside it), then each live trade right after the store's push, so it holds exactly what the store holds. `add` is
 * O(1); nothing here allocates per trade except one object per new bar.
 */
class CumulativeDelta {
  constructor(opts) {
    const o = opts || {};
    this.sessionStart = o.sessionStart === undefined ? 18 * 3600 : o.sessionStart;
    this.seconds = o.seconds > 0 ? o.seconds : 0;
    this.coveredFrom = typeof o.coveredFrom === 'number' && !isNaN(o.coveredFrom) ? o.coveredFrom : -Infinity;
    this.byTime = !!o.byTime;
    this.reset();
  }
  /** Forget every trade. */
  reset() {
    this.bars = [];            // { t, o, h, l, c, buy, sell, unknown, n, s (index into sessions) }, oldest first
    this.sessions = [];        // { day, start, from, partial, buy, sell, unknown, unknownTrades, missing, byRule, trades, first, last }
    this.skipped = 0; this.uncovered = 0; this.trades = 0;
    this._cum = 0; this._ver = (this._ver || 0) + 1;
  }
  /** Changes with every trade counted and every reset. */
  get version() { return this._ver; }
  get last() { return this.bars.length ? this.bars[this.bars.length - 1] : null; }
  /** The session holding the newest bar, or null. */
  get session() { return this.sessions.length ? this.sessions[this.sessions.length - 1] : null; }
  /** The start (18:00 ET the evening before) of the session holding t. */
  startOf(t) { const d = tradeDay(t, this.sessionStart); return this.sessionStart ? (d - 1) * DAY + this.sessionStart : d * DAY; }
  /**
   * Add one trade: time t, volume v, side s (1 buy, -1 sell, 0 unknown, undefined or null for none), in the price bar
   * starting at barT (see above). sm (how the side was found) is only counted: 3 is the tick rule. Returns true when
   * the trade was counted (unknown sides included). Left out: a time or volume that is not a finite number above 0
   * (`skipped`), a bar older than the newest one's session (`skipped`), a bar that started before coveredFrom
   * (`uncovered`).
   */
  add(t, v, s, barT, sm) {
    if (typeof t !== 'number' || !isFinite(t) || typeof v !== 'number' || !(v > 0 && v < Infinity)) { this.skipped++; return false; }
    const last = this.bars.length ? this.bars[this.bars.length - 1] : null;
    let bt = typeof barT === 'number' && isFinite(barT) ? barT : this.seconds ? Math.floor(t / this.seconds) * this.seconds : t;
    if (last && bt < last.t) bt = last.t;                  // a late trade folds into the newest bar, as the bar builders do
    if (bt < this.coveredFrom && !(this.byTime && t >= this.coveredFrom)) { this.uncovered++; return false; }
    let bar = last;
    if (!bar || bt > bar.t) {
      const day = tradeDay(bt, this.sessionStart);
      let ses = this.sessions.length ? this.sessions[this.sessions.length - 1] : null;
      if (ses && day < ses.day) { this.skipped++; return false; }
      if (!ses || day !== ses.day) {
        const start = this.startOf(bt);
        ses = { day, start, from: bt < this.coveredFrom ? this.coveredFrom : bt, partial: this.coveredFrom > start, buy: 0, sell: 0, unknown: 0, unknownTrades: 0, missing: 0, byRule: 0, trades: 0,
          first: this.bars.length, last: this.bars.length };
        this.sessions.push(ses);
        this._cum = 0;
      }
      bar = { t: bt, o: this._cum, h: this._cum, l: this._cum, c: this._cum, buy: 0, sell: 0, unknown: 0, n: 0, s: this.sessions.length - 1 };
      this.bars.push(bar);
      ses.last = this.bars.length - 1;
    }
    const ses = this.sessions[bar.s];
    if (s === 1) { bar.buy += v; ses.buy += v; this._cum += v; }
    else if (s === -1) { bar.sell += v; ses.sell += v; this._cum -= v; }
    else { bar.unknown += v; ses.unknown += v; ses.unknownTrades++; if (s === undefined || s === null) ses.missing++; }
    if (sm === 3 && (s === 1 || s === -1)) ses.byRule += v;
    const c = this._cum;
    if (c > bar.h) bar.h = c;
    if (c < bar.l) bar.l = c;
    bar.c = c; bar.n++; ses.trades++; this.trades++;
    this._ver++;
    return true;
  }
  /** add() for TickStore.feedSides(delta, from, minT): trades bucketed by `seconds` (time bars). */
  addQuiet(t, p, v, s, sm) { this.add(t, v, s, undefined, sm); }
  /** The index of the bar starting at t, or -1. */
  indexOf(t) {
    const a = this.bars;
    let lo = 0, hi = a.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1, x = a[mid].t; if (x === t) return mid; if (x < t) lo = mid + 1; else hi = mid - 1; }
    return -1;
  }
  /** The first bar starting at or after t (bars.length when none). */
  lowerBound(t) {
    const a = this.bars;
    let lo = 0, hi = a.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid].t < t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  /** The bar starting at t, or null. */
  at(t) { const i = this.indexOf(t); return i < 0 ? null : this.bars[i]; }
  /** The session record of a bar (from at()), or null. */
  sessionOf(bar) { return bar ? this.sessions[bar.s] || null : null; }
}


/* ---------------------------------------------------------------- chart signals (G1c) */
/*
 * Three signals from the trades ChartBridge sides (nt8/PROTOCOL.md "Trade side"; the page never works a side out, and a
 * trade with an unknown side is left out, as the delta pane does). Every one counts from the page's opening only: the
 * page feeds them its live trades (and replays the same trades after a rebuild), never the backfill.
 *
 * Absorption bars: Anthony's NinjaScript AbsorptionTradeCombo (FROM_WORK_2026-10-01_LargeAbsorber.cs), ported as it is
 * except where Anthony ruled otherwise (2026-10-01): it paints at the close only (an outline while the bar forms), never
 * mid-bar for good, and draws no line and no label.
 *   Large trade: a single print of at least the floor, or a reconstructed order: same side prints at the same price
 *   (TickTolerance 0 ticks) inside AggregationWindowMs of the first, added up, credited to the bar as soon as it reaches
 *   the floor (the file's flush in OnBarUpdate on every tick), after which a new order starts. Several in one bar: the
 *   direction is the latest one's, the size the largest (barLargeTradeBull, barLargeTradeVolume); reset on the bar's
 *   first tick.
 *   Volume spike: the bar's volume at least VolumeMultiplier times the average of the LookbackPeriod bars before it.
 *   Rejection: close ratio (close - low) / (high - low); bullish at or above 1 - RejectionZone with a buy as the large
 *   trade, bearish at or below RejectionZone with a sell. All three on the same bar.
 * Delta divergence: Anthony's DeltaDivergenceSignal v1.0 (FROM_WORK_2026-10-01_DeltaD.cs), on the page's own
 * cumulative delta (the delta pane's series), at bar close. A swing high (low) is a bar with SwingLookback bars on each
 * side all strictly lower (higher); it is compared with the previous confirmed swing of its kind when they are at least
 * MinBarsBetweenSwings apart: bearish when the price high is higher and the delta at it lower, bullish when the low is
 * lower and the delta higher, and it counts when the price moved MinDivergencePct * 0.01 of the earlier swing's price
 * or the delta MinDivergencePct of the earlier swing's delta (at least 1). UseL2 is unused in the file and left out.
 * Early arrow (Anthony, 2026-10-01): at the close of a bar that already beats the previous swing (with every condition
 * above holding and the bars before it lower) a hollow arrow; solid when it is confirmed as the swing; gone when a later
 * bar reaches its high (low) first.
 * Large-order bubbles: same side prints within 100 ms of the first, added up; shown from the floor up.
 */
const SIGNAL_RTH = { start: 9 * 3600 + 30 * 60, end: 16 * 3600 + 15 * 60 };   // 09:30 to 16:15 ET (Anthony, 2026-10-01)
/* The large-print floors, RTH / overnight (Anthony, 2026-10-01; the Time and Sales floors of the workspace). */
const LARGE_FLOORS = { NQ: { rth: 50, eth: 25 }, ES: { rth: 100, eth: 50 }, MNQ: { rth: 100, eth: 50 }, MES: { rth: 100, eth: 50 } };
/** The floor in force at exchange time t (New York wall clock): RTH 09:30 up to 16:15, else overnight. */
function largeFloorAt(f, t) { const s = tod(t); return s >= SIGNAL_RTH.start && s < SIGNAL_RTH.end ? f.rth : f.eth; }
/* AbsorptionTradeCombo's defaults, by the file's names. */
const ABSORPTION_DEFAULTS = { LookbackPeriod: 20, VolumeMultiplier: 1.8, RejectionZone: 0.35, AggregationWindowMs: 500, TickTolerance: 0 };
/* DeltaDivergenceSignal's defaults, by the file's names (MarkerOffset is ticks on NinjaTrader's price panel; the pane
   draws its arrows a fixed few pixels from the candle instead). */
const DIVERGENCE_DEFAULTS = { SwingLookback: 5, MinBarsBetweenSwings: 3, MinDivergencePct: 0.10 };
/* The bubbles: same side prints within 100 ms (Anthony). */
const BUBBLE_WINDOW_MS = 100;
/* The index of the bar a trade at time t belongs to: the last bar starting at or before t (-1 before the first). */
function barIndexAt(bars, t) {
  let lo = 0, hi = bars.length - 1;
  if (hi < 0 || t < bars[0].t) return -1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bars[mid].t <= t) lo = mid; else hi = mid - 1; }
  return lo;
}
/* The index of the bar starting exactly at t, or -1 (searched from the newest end, where the page's bars change). */
function barIndexOf(bars, t) {
  for (let i = bars.length - 1, k = 0; i >= 0 && k < 8; i--, k++) { if (bars[i].t === t) return i; if (bars[i].t < t) return -1; }
  const i = barIndexAt(bars, t);
  return i >= 0 && bars[i].t === t ? i : -1;
}

/**
 * The absorption rule for bar i of `bars` with that bar's large trade (`track`: { fired, bull, vol }): 1 bullish, -1
 * bearish, 0 none. OnBarUpdate of AbsorptionTradeCombo after its flush, line by line: CurrentBar < LookbackPeriod + 1 is
 * none; the average volume of the LookbackPeriod bars before it (none when 0); the spike; the close ratio (none on a bar
 * with no range); the large trade's direction must match.
 */
function absorptionAt(bars, i, track, s) {
  if (!track || !track.fired || i < s.LookbackPeriod + 1 || i >= bars.length) return 0;
  let sum = 0;
  for (let k = 1; k <= s.LookbackPeriod; k++) sum += bars[i - k].v || 0;
  const avg = sum / s.LookbackPeriod;
  if (avg <= 0) return 0;
  const b = bars[i];
  if (!((b.v || 0) >= avg * s.VolumeMultiplier)) return 0;
  const range = b.h - b.l;
  if (range <= 0) return 0;
  const ratio = (b.c - b.l) / range;
  const bull = ratio >= (1.0 - s.RejectionZone), bear = ratio <= s.RejectionZone;
  if (bull && track.bull) return 1;
  if (bear && !track.bull) return -1;
  return 0;
}

/**
 * Absorption bars, fed one trade at a time with the bar it made (`barT`, the bar's start as the page's bar builder made
 * it) and the chart's bars. A bar is judged when a later bar starts (its close): `painted` gets { t, dir, vol } when the
 * three hold then. While a bar forms, `forming(bars)` says whether they hold now (the outline). Bars that started before
 * the first trade fed (the page's opening) are never painted.
 *   opts: { settings (ABSORPTION_DEFAULTS' names), floorAt(t) (the large trade floor at time t), tick }
 */
class Absorption {
  constructor(opts) {
    const o = opts || {};
    this.s = Object.assign({}, ABSORPTION_DEFAULTS, o.settings || {});
    this.floorAt = typeof o.floorAt === 'function' ? o.floorAt : () => Infinity;
    this.tick = o.tick > 0 ? o.tick : 0.25;
    this.reset();
  }
  reset() {
    this.painted = [];                 // { t, dir, vol }, oldest first
    this.firstT = null;                // the first trade fed: bars that started before it are never painted
    this.barT = null;                  // the bar now forming (its start)
    this.track = { fired: false, bull: false, vol: 0 };
    this.agg = { on: false, price: 0, buy: false, vol: 0, t0: 0 };
    this._ver = (this._ver || 0) + 1;
  }
  get version() { return this._ver; }
  /* the file's large-trade credit: the largest size, the latest direction */
  _credit(vol, buy) { const k = this.track; k.vol = Math.max(k.vol, vol); k.bull = buy; k.fired = true; this._ver++; }
  /* the bar at barT closed (a later one started): judge it with the chart's bars as they are now */
  _close(bars) {
    if (this.barT === null || !bars) return;
    const i = barIndexOf(bars, this.barT);
    if (i < 0 || this.firstT === null || bars[i].t < this.firstT) return;
    const dir = absorptionAt(bars, i, this.track, this.s);
    if (dir) { this.painted.push({ t: bars[i].t, dir, vol: this.track.vol }); this._ver++; }
  }
  /**
   * One trade: time t (seconds), price p, volume v, side s (1 buy, -1 sell; anything else is left out, as the file's
   * trade between the bid and the ask), in the bar starting at barT. `bars`: the chart's bars, the trade already in them.
   */
  add(t, p, v, s, barT, bars) {
    if (typeof t !== 'number' || !isFinite(t)) return;
    if (this.firstT === null) this.firstT = t;
    if (typeof barT === 'number' && isFinite(barT)) {
      if (this.barT === null) this.barT = barT;
      else if (barT > this.barT) {                       // the bar closed: judge it, then the new bar's first tick resets
        this._close(bars);
        this.barT = barT;
        if (this.track.fired) this._ver++;
        this.track = { fired: false, bull: false, vol: 0 };
      }
    }
    if (s !== 1 && s !== -1) return;
    const vol = +v || 0, buy = s === 1, floor = this.floorAt(t);
    // OnMarketData: a single large print
    if (vol >= floor) this._credit(vol, buy);
    // tape reconstruction: same side, same price (TickTolerance ticks), inside the window from the order's first print
    const a = this.agg, range = this.s.TickTolerance * this.tick;
    const sameDir = a.on && a.buy === buy, samePrice = a.on && Math.abs(p - a.price) <= range + 1e-9;
    const within = a.on && (t - a.t0) * 1000 <= this.s.AggregationWindowMs;
    if (a.on && sameDir && samePrice && within) { a.vol += vol; a.price = p; }
    else {
      if (a.on && a.vol >= floor) this._credit(a.vol, a.buy);
      a.on = true; a.price = p; a.buy = buy; a.vol = vol; a.t0 = t;
    }
    // OnBarUpdate on every tick: an order that reached the floor counts now, and the next print starts a new one
    if (a.on && a.vol >= floor) { this._credit(a.vol, a.buy); a.on = false; a.vol = 0; a.price = 0; a.buy = false; a.t0 = 0; }
  }
  /** The forming bar's outline: 1 or -1 while the three hold on the newest bar, else 0. */
  forming(bars) {
    if (!bars || !bars.length || this.barT === null || this.firstT === null) return 0;
    const i = bars.length - 1;
    if (bars[i].t !== this.barT || bars[i].t < this.firstT) return 0;
    return absorptionAt(bars, i, this.track, this.s);
  }
}

/**
 * Large-order bubbles: same side prints within `windowMs` of the group's first print, added up (a print of the other
 * side, or one after the window, starts a new group; unknown sides are left out). A group is listed once it reaches the
 * floor in force at its first print, and grows while it lasts: { t (first print), p (volume-weighted price, on the
 * tick), v, side, f (the floor it was measured against) }, oldest first.
 * Auto (Anthony: "the session's top 1% of trade sizes"): the floor is the 99th percentile of this session's group sizes
 * (from 18:00 ET), once AUTO_MIN groups are in; before that the fixed floor.
 */
class LargePrints {
  constructor(opts) {
    const o = opts || {};
    this.windowMs = o.windowMs > 0 ? o.windowMs : BUBBLE_WINDOW_MS;
    this.floorAt = typeof o.floorAt === 'function' ? o.floorAt : () => Infinity;
    this.auto = !!o.auto;
    this.tick = o.tick > 0 ? o.tick : 0.25;
    this.sessionStart = o.sessionStart === undefined ? 18 * 3600 : o.sessionStart;
    this.max = o.max > 0 ? o.max : 20000;
    this.reset();
  }
  reset() {
    this.list = [];
    this.g = null;
    this.hist = new Map(); this.n = 0; this.day = null; this.autoFloor = null; this.autoAt = 0;
    this._ver = (this._ver || 0) + 1;
  }
  get version() { return this._ver; }
  /** The floor for a group starting at t: the session's top 1% (Auto, once it has enough groups), else the fixed one. */
  floor(t) { return this.auto && this.autoFloor !== null ? this.autoFloor : this.floorAt(t); }
  _closeGroup() {
    const g = this.g; if (!g) return;
    this.g = null;
    const k = Math.round(g.v);
    this.hist.set(k, (this.hist.get(k) || 0) + 1); this.n++;
    if (this.n >= LargePrints.AUTO_MIN && this.n >= this.autoAt) this._percentile();
  }
  /* the smallest size in the session's top 1% of groups; worked out again each time the count grows by a fiftieth */
  _percentile() {
    const keys = [...this.hist.keys()].sort((a, b) => b - a), top = Math.max(1, Math.ceil(this.n * 0.01));
    let c = 0, f = keys.length ? keys[0] : null;
    for (const k of keys) { c += this.hist.get(k); f = k; if (c >= top) break; }
    this.autoFloor = f === null ? null : Math.max(2, f);
    this.autoAt = this.n + Math.max(1, Math.floor(this.n / 50));
  }
  /* `barT` (1.14.0, Anthony's WORK screenshots): the start of the bar the print belongs to. A group never spans two bars:
     a new bar closes it, as a change of side or the window's end does, and the bubble is placed on its bar (`b`), not by
     its first print's time (a sweep that closed a range bar and opened the next within 100 ms put a bubble on the old
     bar at the new bar's price). Without it, groups go by time and side alone, as before. */
  add(t, p, v, s, barT) {
    if (typeof t !== 'number' || !isFinite(t) || (s !== 1 && s !== -1)) return;
    const bar = typeof barT === 'number' && isFinite(barT) ? barT : undefined;
    const day = tradeDay(t, this.sessionStart);
    if (this.day !== day) { if (this.day !== null) { this._closeGroup(); this.hist = new Map(); this.n = 0; this.autoFloor = null; this.autoAt = 0; } this.day = day; }
    const vol = +v || 0;
    let g = this.g;
    if (g && (g.side !== s || (t - g.t) * 1000 > this.windowMs || g.b !== bar)) { this._closeGroup(); g = null; }
    if (!g) g = this.g = { t, side: s, v: 0, pv: 0, f: this.floor(t), item: null, b: bar };
    g.v += vol; g.pv += p * vol;
    if (g.v >= g.f) {
      const price = g.v > 0 ? Math.round(g.pv / g.v / this.tick) * this.tick : p;
      if (!g.item) {
        g.item = { t: g.t, p: price, v: g.v, side: s, f: g.f };
        if (g.b !== undefined) g.item.b = g.b;
        this.list.push(g.item);
        // past the cap, the oldest tenth goes at once (not one splice per new bubble)
        if (this.list.length > this.max) this.list.splice(0, this.list.length - this.max + Math.ceil(this.max / 10));
      } else { g.item.v = g.v; g.item.p = price; }
      this._ver++;
    }
  }
}
LargePrints.AUTO_MIN = 200;

/**
 * Delta divergence (DeltaDivergenceSignal v1.0) on the chart's bars and the page's cumulative delta. `update(bars,
 * valueAt)` takes every bar closed since the last call (all but the newest), oldest first, as the file's OnBarUpdate at
 * bar close; valueAt(i) is the cumulative delta at the close of bar i, or null where the page has none (before the
 * page's opening): a swing there is no swing. A new bars array (a rebuild) starts over from its first bar.
 * `arrows`: { t (the swing bar's start), dir (1 bullish below, -1 bearish above), solid }, oldest first.
 */
class DeltaDivergence {
  constructor(opts) {
    this.s = Object.assign({}, DIVERGENCE_DEFAULTS, (opts && opts.settings) || {});
    this.reset();
  }
  reset() {
    this.arrows = []; this.bars = null; this.next = 0;
    this.hi = null; this.lo = null;            // the last confirmed swing high and low: { p, d, i }
    this.candHi = null; this.candLo = null;    // a hollow arrow waiting for its confirmation: { i, arrow }
    this._ver = (this._ver || 0) + 1;
  }
  get version() { return this._ver; }
  /* the file's pass rule: the price apart by MinDivergencePct * 0.01 as a fraction, or the delta by MinDivergencePct */
  _passes(priceDiff, deltaDiff) { return priceDiff >= this.s.MinDivergencePct * 0.01 || deltaDiff >= this.s.MinDivergencePct; }
  _bear(H, d, last) {
    if (!last || !(H > last.p && d < last.d)) return false;
    return this._passes((H - last.p) / last.p, (last.d - d) / Math.max(Math.abs(last.d), 1));
  }
  _bull(L, d, last) {
    if (!last || !(L < last.p && d > last.d)) return false;
    return this._passes((last.p - L) / last.p, (d - last.d) / Math.max(Math.abs(last.d), 1));
  }
  _drop(arrow) { const k = this.arrows.indexOf(arrow); if (k >= 0) this.arrows.splice(k, 1); this._ver++; }
  update(bars, valueAt) {
    if (!bars) return;
    if (bars !== this.bars) { this.reset(); this.bars = bars; }
    const closed = bars.length - 1;
    while (this.next < closed) this._step(bars, this.next++, valueAt);
  }
  /* bar c just closed (the file's CurrentBar): the swing SwingLookback back is confirmed or not, then the early arrow */
  _step(bars, c, valueAt) {
    const L = this.s.SwingLookback;
    if (c >= L * 2 + 1) this._confirm(bars, c, c - L, valueAt);   // the file: CurrentBar < SwingLookback * 2 + 1, nothing yet
    this._early(bars, c, valueAt);
  }
  _confirm(bars, c, k, valueAt) {
    const L = this.s.SwingLookback;
    let isHigh = true, isLow = true;
    for (let i = 1; i <= L; i++) {
      if (bars[k].h <= bars[k + i].h || bars[k].h <= bars[k - i].h) isHigh = false;
      if (bars[k].l >= bars[k + i].l || bars[k].l >= bars[k - i].l) isLow = false;
    }
    const d = valueAt(k);
    if (isHigh && d !== null && d !== undefined) {
      const H = bars[k].h, last = this.hi;
      const fire = last && k - last.i >= this.s.MinBarsBetweenSwings && this._bear(H, d, last);
      const cand = this.candHi && this.candHi.i === k ? this.candHi : null;
      if (fire) { if (cand) { cand.arrow.solid = true; this._ver++; } else { this.arrows.push({ t: bars[k].t, dir: -1, solid: true }); this._ver++; } }
      else if (cand) this._drop(cand.arrow);
      if (cand) this.candHi = null;
      this.hi = { p: H, d, i: k };
    } else if (this.candHi && this.candHi.i === k) { this._drop(this.candHi.arrow); this.candHi = null; }
    if (isLow && d !== null && d !== undefined) {
      const Lo = bars[k].l, last = this.lo;
      const fire = last && k - last.i >= this.s.MinBarsBetweenSwings && this._bull(Lo, d, last);
      const cand = this.candLo && this.candLo.i === k ? this.candLo : null;
      if (fire) { if (cand) { cand.arrow.solid = true; this._ver++; } else { this.arrows.push({ t: bars[k].t, dir: 1, solid: true }); this._ver++; } }
      else if (cand) this._drop(cand.arrow);
      if (cand) this.candLo = null;
      this.lo = { p: Lo, d, i: k };
    } else if (this.candLo && this.candLo.i === k) { this._drop(this.candLo.arrow); this.candLo = null; }
  }
  /* the early (hollow) arrow at bar c: a waiting one goes when c reaches its high (low); c gets one when it beats the
     last swing with every condition holding and the SwingLookback bars before it lower (higher) */
  _early(bars, c, valueAt) {
    const L = this.s.SwingLookback, b = bars[c];
    if (this.candHi && c > this.candHi.i && b.h >= bars[this.candHi.i].h) { this._drop(this.candHi.arrow); this.candHi = null; }
    if (this.candLo && c > this.candLo.i && b.l <= bars[this.candLo.i].l) { this._drop(this.candLo.arrow); this.candLo = null; }
    if (c < L) return;
    const d = valueAt(c);
    if (d === null || d === undefined) return;
    let leftHigh = true, leftLow = true;
    for (let i = 1; i <= L; i++) { if (b.h <= bars[c - i].h) leftHigh = false; if (b.l >= bars[c - i].l) leftLow = false; }
    const hi = this.hi, lo = this.lo;
    if (!this.candHi && leftHigh && hi && c - hi.i >= this.s.MinBarsBetweenSwings && this._bear(b.h, d, hi)) {
      const arrow = { t: b.t, dir: -1, solid: false };
      this.arrows.push(arrow); this.candHi = { i: c, arrow }; this._ver++;
    }
    if (!this.candLo && leftLow && lo && c - lo.i >= this.s.MinBarsBetweenSwings && this._bull(b.l, d, lo)) {
      const arrow = { t: b.t, dir: 1, solid: false };
      this.arrows.push(arrow); this.candLo = { i: c, arrow }; this._ver++;
    }
  }
}

return {
  VERSION, create, mountThemePanel, DEFAULT_THEME, PRESETS, BACKGROUNDS, LEVEL_COLORS, FLOOR, PAIR, IB_FORMING_DASH, VP_WIDTH, VP_POC_MIN,
  PANE_RATIO, PANE_RATIO_MIN, PANE_RATIO_MAX, PANE_MIN, PRICE_MIN, PANE_GAP,
  util: {
    DAY, tod, tradeDay, zoneSeconds, fmtHM, fmtExact, fmtDay, fmtDate, fmtFull, fmtPrice, fmtVolume, roundTo, niceStep,
    parseColor, rgba, luminance, contrast, readableOn, legible, onGround, markOnGround, pairOnGround, ibPair, distinct, mix, buildTheme, chromeColors, CHROME_VARS,
    obarDims, fadedContrast, OBAR_DIM: { alpha: DIM, house: HOUSE_DIMS },
    aggregate, foldLast, addSessionVwap, sessionLevels, levelLines, initialBalance, ibLines, rthDay, closedDay, cmeClosed, cmeSessionDay, cmeClosures, nyseHolidays, nyseEarlyCloses, rthClose,
    orderLabel, orderLabelShort, positionShort, htfStart, htfEnd, HTF_SECONDS, cornerPlace, openPnl, fmtMoney, fmtSigned, groupFills, stackFillLabels, profileRects,
    roomBars, fitRange, fmtRemain, barRemain, atr, pctFrom, bubbleRadius, BUBBLE_R_MIN, BUBBLE_R_MAX, rthVwap, rthVwapUpdate, vwapAt, PD_POC_DASH,
  },
  VolumeProfile, CumulativeDelta,
  // chart signals (G1c)
  Absorption, LargePrints, DeltaDivergence, absorptionAt, barIndexAt, largeFloorAt, LARGE_FLOORS, SIGNAL_RTH, ABSORPTION_DEFAULTS, DIVERGENCE_DEFAULTS, BUBBLE_WINDOW_MS,
};
});
