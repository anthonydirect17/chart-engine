/*!
 * chart-engine 1.6.1
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

const VERSION = '1.6.1';
const DAY = 86400;

/* ---------------------------------------------------------------- time */
const tod = t => ((t % DAY) + DAY) % DAY;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = n => (n < 10 ? '0' : '') + n;
const fmtHM = t => { const s = tod(t); return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s % 3600 / 60)); };
const fmtHMS = t => fmtHM(t) + ':' + pad(Math.floor(tod(t) % 60));
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
  const side = ord.side === 'sell' ? 'SELL' : 'BUY';
  const kind = ord.role === 'target' ? 'TGT' : ord.role === 'stop' ? 'STP' : (KIND_ABBR[ord.kind] || String(ord.kind || '').toUpperCase());
  const left = Math.max(0, (+ord.qty || 0) - (+ord.filled || 0));
  return side + ' ' + kind + ' ' + left;
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
  // volume profile (1.6.0): rows a tint of the ground, value area a step stronger, POC in the value-level gold
  vpRow: '#141C26', vpValue: '#212C3B', vpPoc: '#E0B45A',
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
  ['vpRow', 0.07, 0], ['vpValue', 0.14, 0],
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
 * CSS colors for a page's own chrome (toolbar, menus, status line) on a light ground (1.5.3, Anthony: with a light
 * chart the toolbar and status line go light too), keyed by the live page's CSS variable names; null on the default
 * and dark grounds, where the page keeps its dark house style. Every text color reads at the chart's floors on the
 * darkest surface it sits on (text 7:1, secondary text 4.5:1, accents 4.5:1). Built once per theme change.
 */
const CHROME_LIGHT = 9;                 // the ground against the house near-black #080B10, for the page chrome to go light
function chromeColors(T) {
  // only a clearly light ground (review B1): on mid grounds the page keeps its dark chrome
  if (!T || T.ground !== 'light' || contrast(parseColor(T.bg), parseColor('#080B10')) < CHROME_LIGHT) return null;
  const bg = T.bg, ink = '#080B10';
  const s2 = mix(bg, ink, 0.05), s3 = mix(bg, ink, 0.10);           // raised surfaces (buttons, hover)
  const tint = mix(bg, '#6D28D9', 0.10), border = mix(bg, '#6D28D9', 0.45);
  const on = (c, min, surface) => legible(c, surface || s3, min, BLACK);
  const v = {
    '--bg': bg, '--s2': s2, '--s3': s3, '--line': mix(bg, ink, 0.12), '--line-strong': mix(bg, ink, 0.24),
    '--text': on(T.axisTextStrong, FLOOR.strong), '--head': on(T.tagText, FLOOR.strong),
    '--text2': on(T.text2, FLOOR.text), '--text3': on(T.axisText, FLOOR.text),
    '--accent-tint': tint, '--accent-border': border,
    '--accent-text': on('#6D28D9', FLOOR.text, tint), '--accent-soft': on('#6D28D9', FLOOR.text, tint),
    '--crimson-word': on('#E0445E', FLOOR.text, bg), '--info': on('#7FB2FF', FLOOR.text), '--warn': on('#E0B45A', FLOOR.text),
    '--loss': on(T.loss, FLOOR.text), '--profit': on(T.profit, FLOOR.text), '--panel': bg,
    '--scheme': 'light',
  };
  // the Colors button and panel (mountThemePanel reads these, falling back to the dark house colors)
  Object.assign(v, {
    '--ce-text': v['--text'], '--ce-text2': v['--text2'], '--ce-muted': v['--text3'], '--ce-s2': s2, '--ce-s3': s3,
    '--ce-line': v['--line-strong'], '--ce-line-soft': v['--line'], '--ce-panel': bg, '--ce-accent': v['--accent-text'],
    '--ce-tint': tint, '--ce-tint-border': border, '--ce-tint-text': on('#6D28D9', FLOOR.text, tint), '--ce-bad': v['--loss'],
    '--ce-shadow': '0 12px 32px rgba(8,11,16,.18)', '--ce-scheme': 'light',
  });
  return v;
}
/** Every CSS variable chromeColors() can set, so a page can clear them when the ground goes dark again. */
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
/** sessionLevels() result -> level lines in the house style. */
function levelLines(lv) {
  if (!lv) return [];
  const L = [
    ['PDH', lv.pdh, LEVEL_COLORS.prior, [6, 4]], ['VAH', lv.vah, LEVEL_COLORS.value, [3, 4]],
    ['ONH', lv.onh, LEVEL_COLORS.overnight, [6, 4]], ['Prior close', lv.pc, LEVEL_COLORS.close, [2, 3]],
    ['ONL', lv.onl, LEVEL_COLORS.overnight, [6, 4]], ['VAL', lv.val, LEVEL_COLORS.value, [3, 4]],
    ['PDL', lv.pdl, LEVEL_COLORS.prior, [6, 4]],
  ];
  return L.filter(x => x[1] !== null && x[1] !== undefined).map(([name, price, color, dash]) => ({ name, price, color, dash }));
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
 * one on any ground.
 */
function ibLines(ib) {
  if (!ib || ib.high === null || ib.low === null || (ib.state !== 'forming' && ib.state !== 'locked')) return [];
  const dash = ib.state === 'forming' ? IB_FORMING_DASH.slice() : [];
  return [
    { name: 'IBH', price: ib.high, color: LEVEL_COLORS.ibHigh, dash, layer: 'ib', from: ib.start, tone: 'high' },
    { name: 'IBL', price: ib.low, color: LEVEL_COLORS.ibLow, dash, layer: 'ib', from: ib.start, tone: 'low' },
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

/* ---------------------------------------------------------------- DOM styles */
const CSS = `
.ce-host{position:relative;overflow:hidden;outline:none}
.ce-host:focus-visible{box-shadow:inset 0 0 0 2px #B69CFF}
.ce-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:crosshair;user-select:none;-webkit-user-select:none}
.ce-live{position:absolute;right:90px;bottom:38px;z-index:3;font:600 12px "IBM Plex Sans",system-ui,sans-serif;color:#B69CFF;background:#1A1230;border:1px solid #3B2A6B;border-radius:999px;padding:5px 12px;min-height:30px;cursor:pointer}
.ce-live:hover{color:#fff}
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
.ce-grounds{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.ce-ground{display:flex;align-items:center;gap:8px;background:var(--ce-s2,#0F151D);border:1px solid var(--ce-line-soft,#18212C);border-radius:8px;padding:5px 8px;color:var(--ce-text,#E6EDF5);font:500 12px "IBM Plex Sans",system-ui,sans-serif;cursor:pointer;min-height:32px;text-align:left}
.ce-ground[aria-pressed="true"]{border-color:var(--ce-tint-border,#3B2A6B);background:var(--ce-tint,#1A1230);color:var(--ce-tint-text,#D8CCFF)}
.ce-ground:focus-visible{outline:2px solid var(--ce-accent,#B69CFF);outline-offset:2px}
.ce-ground i{width:16px;height:16px;border-radius:4px;flex:none;box-shadow:inset 0 0 0 1px rgba(154,168,184,.45)}
.ce-row input[type=text][aria-invalid="true"]{border-color:var(--ce-bad,#FF7A7A);box-shadow:inset 0 0 0 1px var(--ce-bad,#FF7A7A)}
`;
function injectStyle() {
  if (typeof document === 'undefined' || document.getElementById('ce-style')) return;
  const s = document.createElement('style'); s.id = 'ce-style'; s.textContent = CSS; document.head.appendChild(s);
}

/* ---------------------------------------------------------------- the chart */
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

function create(container, options) {
  if (!container) throw new Error('ChartEngine.create needs a container element');
  const opt = options || {};
  const o = {
    barSeconds: opt.barSeconds || 60,
    precision: opt.precision !== undefined ? opt.precision : 2,
    tick: opt.tick !== undefined ? opt.tick : 0.25,
    rightOffset: opt.rightOffset !== undefined ? opt.rightOffset : 8,
    barSpacing: opt.barSpacing || 7,
    minSpacing: opt.minSpacing || 0.6,
    maxSpacing: opt.maxSpacing || 48,
    axisWidth: opt.axisWidth || 78,
    timeAxisHeight: opt.timeAxisHeight || 26,
    session: Object.assign({ start: 18 * 3600, rthStart: 34200, rthEnd: 57600 }, opt.session || {}),
    layers: Object.assign({ volume: true, vwap: true, levels: true, trades: true, ib: true, vp: false }, opt.layers || {}),
    motion: Object.assign({ zoom: 75, fit: 120, candle: 55, follow: 110, friction: 325 }, opt.motion || {}),
    clock: opt.clock || (() => zoneSeconds(Date.now() / 1000, opt.timeZone || 'America/New_York')),
    liveButton: opt.liveButton !== false,
    unit: opt.unit !== undefined ? opt.unit : 'pt',
    pointValue: opt.pointValue || 0,
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
    liveBtn = document.createElement('button'); liveBtn.type = 'button'; liveBtn.className = 'ce-live';
    liveBtn.textContent = 'Jump to live ›'; liveBtn.hidden = true; container.appendChild(liveBtn);
  }

  let themeSrc = Object.assign({}, DEFAULT_THEME, opt.theme || {});   // the colors as chosen; T is what draws
  let T = buildTheme(themeSrc), themeBuilds = 1;
  let bars = [], levels = [], trades = [], markers = [], paused = false, countdownFn = null;
  /* The volume profile (1.6.0): a VolumeProfile the page keeps feeding; drawn while the 'vp' layer is on. The
     bars are built by profileRects once per change of the profile, the view or the size, and kept as three lists of
     rectangles (rest, value area, POC) that each frame fills with fillRect. */
  let profile = null, vpBars = null, vpBuilds = 0;
  /* Levels as drawn: on a ground other than the default each level's color is moved until its name reads (1.5.3).
     Rebuilt when the levels or the theme change, never per frame. A level with `layer` ('ib') shows with that layer,
     the rest with 'levels'. */
  let levelsShown = [];
  function shadeLevels() {
    levelsShown = levels.map(L => Object.assign({}, L, { color: T.ground === 'default' ? L.color : markOnGround(L.color || T.axisText, T.bg, FLOOR.text, T.to) }));
    if (T.ground === 'default') return;
    // the IB high stays the brighter of the pair on every ground
    const hi = levelsShown.find(L => L.tone === 'high'), lo = levelsShown.find(L => L.tone === 'low');
    if (hi && lo) [hi.color, lo.color] = pairOnGround(levels[levelsShown.indexOf(hi)].color, levels[levelsShown.indexOf(lo)].color, T.bg, FLOOR.text, T.to, true);
  }
  const levelOn = L => !!o.layers[L.layer || 'levels'];
  let drawings = [], tool = null, selectedId = null, dd = null, draft = null;
  // working orders and the position (1.3.0): shown always; moved, cancelled and placed only while editing is on
  let orders = [], position = null, orderEditing = false, orderPreview = null, shiftHeld = false;
  let od = null, xDown = null, orderHits = [];
  const pendingMoves = new Map();          // order id -> price asked for, until the next setOrders
  const listeners = { legend: [], live: [], drawings: [], tool: [], orderMove: [], orderCancel: [], orderPlace: [], error: [] };
  const emit = (ev, arg) => { for (const fn of listeners[ev]) { try { fn(arg); } catch (e) { setTimeout(() => { throw e; }); } } };

  const AXIS_W = o.axisWidth, TIME_H = o.timeAxisHeight;
  let dpr = 1, W = 0, H = 0, plotW = 0, plotH = 0;
  const V = {
    spacing: o.barSpacing, logS: Math.log(o.barSpacing), logT: Math.log(o.barSpacing), right: 0,
    follow: true, anchor: null, kin: null, auto: true, lo: 0, hi: 1, init: false,
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
  const followRight = () => last() + o.rightOffset;
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
      }
    }
    return null;
  }
  /* order label, close handle or axis tag under the pointer (only while order editing is on) */
  function hitOrder(p) {
    if (!orderEditing) return null;
    const inR = r => r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    for (let k = orderHits.length - 1; k >= 0; k--) if (inR(orderHits[k].xbox)) return { id: orderHits[k].id, part: 'x' };
    for (let k = orderHits.length - 1; k >= 0; k--) if (inR(orderHits[k].box) || inR(orderHits[k].tag)) return { id: orderHits[k].id, part: 'body' };
    return null;
  }
  const orderPrice = ord => od && od.id === ord.id ? od.price : pendingMoves.has(ord.id) ? pendingMoves.get(ord.id) : ord.price;
  const cloneDrawing = d => JSON.parse(JSON.stringify(d));
  function drawingsChanged() { emit('drawings', drawings.map(cloneDrawing)); }
  function setToolInternal(t) { if (tool !== t) { tool = t; draft = null; emit('tool', tool); } dirty = true; }
  function finishDraft() {
    const d = draft; draft = null;
    if (!d) return;
    const same = Math.abs(d.a.t - d.b.t) < 1e-6 && Math.abs(d.a.p - d.b.p) < 1e-9;
    if (!same) { drawings.push({ id: d.id, type: 'trend', a: d.a, b: d.b }); selectedId = d.id; drawingsChanged(); }
    setToolInternal(null);
  }

  function clampRight() {
    const vis = plotW / V.spacing;
    const lo = Math.min(10, Math.max(0, last())), hi = last() + Math.max(o.rightOffset, vis * 0.5);
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
    plotW = Math.max(10, W - AXIS_W); plotH = Math.max(10, H - TIME_H);
    clampRight(); dirty = true;
  }

  function autoTarget() {
    const n = last(); if (n < 0) return null;
    const from = Math.max(0, Math.floor(indexAt(0))), to = Math.min(n, Math.ceil(indexAt(plotW)));
    if (to < from) return null;
    let mn = Infinity, mx = -Infinity;
    for (let i = from; i <= to; i++) {
      const b = bars[i], h = i === n ? disp.h : b.h, l = i === n ? disp.l : b.l;
      if (h > mx) mx = h; if (l < mn) mn = l;
      if (o.layers.vwap && b.vw !== undefined && b.vw !== null) { if (b.vw > mx) mx = b.vw; if (b.vw < mn) mn = b.vw; }
    }
    const minRange = (o.tick || Math.abs(mx) * 1e-4 || 1) * 8;
    const range = Math.max(mx - mn, minRange), mt = 0.08, mb = o.layers.volume ? 0.2 : 0.08;
    const ppp = plotH * (1 - mt - mb) / range;
    return { hi: mx + plotH * mt / ppp, lo: mn - plotH * mb / ppp };
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
      V.logS = approach(V.logS, V.logT, dt, o.motion.zoom);
      if (Math.abs(V.logS - V.logT) < 1e-4) V.logS = V.logT;
      V.spacing = Math.exp(V.logS);
      if (V.anchor && !V.follow) V.right = V.anchor.i + (plotW - V.anchor.x) / V.spacing;
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
    if (V.auto) {
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
    const sec = Math.floor(o.clock());
    if (sec !== lastSec) { lastSec = sec; dirty = true; }
    return moving;
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
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
    const remain = Math.max(0, Math.ceil(bars[n].t + o.barSeconds - o.clock()));
    if (remain >= DAY) return Math.floor(remain / DAY) + 'd ' + pad(Math.floor(remain % DAY / 3600)) + 'h';
    if (remain >= 3600) return Math.floor(remain / 3600) + ':' + pad(Math.floor(remain % 3600 / 60)) + ':' + pad(remain % 60);
    return Math.floor(remain / 60) + ':' + pad(remain % 60);
  }

  function timeLabels(from, to) {
    const labels = [], bs = o.barSeconds;
    if (to < from) return labels;
    if (bs < DAY) {
      for (let i = Math.max(from, 1); i <= to; i++) if (isSessionStart(i)) labels.push({ i, x: xOf(i), text: fmtDay(bars[i].t + DAY - (o.session.start || DAY)), strong: true });
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

  function draw(now) {
    const n = last();
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
    ctx.lineWidth = 1 / dpr; ctx.strokeStyle = T.grid; ctx.beginPath();
    for (let k = k0; k <= k1 && k - k0 < 400; k++) { const y = crisp(yOf(k * pStep), 1); ctx.moveTo(0, y); ctx.lineTo(plotW, y); }
    ctx.stroke();

    // time grid and session dividers
    const labels = timeLabels(from, to);
    ctx.beginPath(); ctx.strokeStyle = T.grid;
    for (const l of labels) if (!l.strong) { const x = crisp(l.x, 1); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); }
    ctx.stroke();
    ctx.beginPath(); ctx.strokeStyle = T.divider; ctx.setLineDash([2, 4]);
    for (const l of labels) if (l.strong) { const x = crisp(l.x - V.spacing / 2, 1); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); }
    ctx.stroke(); ctx.setLineDash([]);

    // volume profile: in front of the grid, behind volume, levels and candles
    if (profile && o.layers.vp) drawProfile();

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

    // VWAP, broken at each session start
    if (o.layers.vwap && to > from) {
      ctx.strokeStyle = T.vwap; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.globalAlpha = 0.9;
      ctx.beginPath(); let pen = false;
      for (let i = from; i <= to; i++) {
        const vw = bars[i].vw;
        if (isSessionStart(i) || vw === undefined || vw === null) { pen = false; if (vw === undefined || vw === null) continue; }
        const x = xOf(i), y = yOf(vw);
        if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke(); ctx.globalAlpha = 1;
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
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

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
        }
      }
    }

    // working orders, the position and the Shift+click preview: a line across the plot, a label at its
    // right end (with a close handle while editing) and a tag on the price axis (added to the tag stack below)
    const orderTags = [], orderLabels = [];   // labels draw after the last price line, so the live dot never covers them
    orderHits = [];
    if (n >= 0 && (orders.length || position || orderPreview)) {
      const boxes = [], LH = 18;
      ctx.font = '500 11px ' + T.fontMono; ctx.textBaseline = 'middle';
      const place = (y, w) => {                                  // right-aligned, stepping left past labels it would overlap
        let x = plotW - 6 - w; const top = clamp(y - LH / 2, 0, Math.max(0, plotH - LH));
        for (let k = 0; k < 8; k++) {
          const hit = boxes.find(b => x < b.x + b.w + 4 && x + w + 4 > b.x && Math.abs(b.top - top) < LH + 1);
          if (!hit) break; x = hit.x - 4 - w;
        }
        boxes.push({ x, top, w }); return { x, top };
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
      const label = (y, parts, border, dash, alpha, closer) => {   // parts: [[text, color], ...]
        const gap = 7, widths = parts.map(pt => ctx.measureText(pt[0]).width);
        const tw = widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1) + 10, w = tw + (closer ? LH : 0);
        const { x, top } = place(y, w);
        orderLabels.push(() => {
          ctx.font = '500 11px ' + T.fontMono; ctx.textBaseline = 'middle';
          ctx.globalAlpha = alpha;
          roundRect(x, top, w, LH, 4); ctx.fillStyle = rgba(T.bg, 0.92); ctx.fill();
          ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]);
          let cx = x + 5; ctx.textAlign = 'left';
          parts.forEach((pt, k) => { inkText(pt[0], cx, top + LH / 2 + 0.5, pt[1]); cx += widths[k] + gap; });
          if (closer) {                                             // close handle: a small x in its own cell
            const bx = x + tw;
            ctx.strokeStyle = border; ctx.beginPath(); ctx.moveTo(bx + 0.5, top + 3); ctx.lineTo(bx + 0.5, top + LH - 3); ctx.stroke();
            const mx = bx + LH / 2, my = top + LH / 2;
            ctx.strokeStyle = T.tagText; ctx.lineWidth = 1.5; ctx.beginPath();
            ctx.moveTo(mx - 3.5, my - 3.5); ctx.lineTo(mx + 3.5, my + 3.5); ctx.moveTo(mx + 3.5, my - 3.5); ctx.lineTo(mx - 3.5, my + 3.5); ctx.stroke();
          }
          ctx.globalAlpha = 1;
        });
        return { box: { x, y: top, w: tw, h: LH }, xbox: closer ? { x: x + tw, y: top, w: LH, h: LH } : null };
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
          label(y, parts, T.exit, null, 1, false);
          orderTags.push({ price: position.avgPrice, style: { fill: T.tagFill, fg: T.exit, border: T.exit } });
        }
      }
      for (const ord of orders) {
        const price = orderPrice(ord), y = yOf(price);
        if (y < 0 || y > plotH) continue;
        const col = ord.side === 'sell' ? T.short : T.long, stop = ord.kind === 'stop' || ord.kind === 'stopLimit', dash = stop ? [6, 4] : null;
        const dragging = od && od.id === ord.id, alpha = pendingMoves.has(ord.id) && !dragging ? 0.55 : 1;
        hline(y, col, dash, 0.9 * alpha, dragging ? 1.5 : 1);
        const hit = label(y, [[orderLabel(ord), col]], col, dash ? [3, 2] : null, alpha, orderEditing);
        orderHits.push({ id: ord.id, box: hit.box, xbox: hit.xbox });
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

    // axes
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = T.bg; ctx.fillRect(plotW, 0, AXIS_W, H); ctx.fillRect(0, plotH, W, TIME_H);
    ctx.strokeStyle = T.axisLine; ctx.lineWidth = Math.max(1, Math.round(dpr)) / dpr;
    ctx.beginPath(); ctx.moveTo(crisp(plotW, 1), 0); ctx.lineTo(crisp(plotW, 1), H); ctx.moveTo(0, crisp(plotH, 1)); ctx.lineTo(W, crisp(plotH, 1)); ctx.stroke();

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
    ctx.font = '400 11px ' + T.fontMono; ctx.fillStyle = T.axisText; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (let k = k0; k <= k1 && k - k0 < 400; k++) {
      const y = yOf(k * pStep); if (y < 8 || y > plotH - 8) continue;
      if (tags.some(t => Math.abs(t.y - y) < 18) || (n >= 0 && Math.abs(ly - y) < 22)) continue;
      ctx.fillText(fmtPrice(k * pStep, o.precision), plotW + 8, y);
    }
    ctx.textAlign = 'center';
    for (const l of labels) {
      if (l.x < 20 || l.x > plotW - 20) continue;
      ctx.fillStyle = l.strong ? T.axisTextStrong : T.axisText;
      ctx.font = (l.strong ? '600 11px ' : '400 11px ') + T.fontMono;
      ctx.fillText(l.text, l.x, plotH + TIME_H / 2 + 1);
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
    if (hi !== null) {
      const text = o.barSeconds < DAY ? fmtFull(bars[hi].t) : fmtDate(bars[hi].t);
      ctx.font = '500 11px ' + T.fontMono; const tw = ctx.measureText(text).width + 14;
      const x = clamp(xOf(hi) - tw / 2, 0, Math.max(0, plotW - tw));
      roundRect(x, plotH + 3, tw, TIME_H - 6, 3); ctx.fillStyle = T.tagFill; ctx.fill();
      ctx.strokeStyle = T.tagBorder; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = T.tagText; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + 7, plotH + TIME_H / 2);
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
  function zoneOf(p) { return p.x >= plotW ? 'price' : p.y >= plotH ? 'time' : 'plot'; }
  function zoomBy(delta, x) {
    V.kin = null;
    V.logT = clamp(V.logT + delta, Math.log(o.minSpacing), Math.log(o.maxSpacing));
    V.anchor = V.follow ? null : { i: indexAt(x), x };
    dirty = true;
  }
  function setCursor(z, p) {
    if (od) { cv.style.cursor = 'ns-resize'; return; }
    if (dd && dd.mode !== 'draft') { cv.style.cursor = 'grabbing'; return; }
    if (!drag && !tool && !draft && p && orderEditing) { const h = hitOrder(p); if (h) { cv.style.cursor = h.part === 'x' ? 'pointer' : 'ns-resize'; return; } }
    if (tool || draft) { cv.style.cursor = 'crosshair'; return; }
    if (!drag && p && z === 'plot' && drawings.length) { const h = hitDrawing(p); if (h) { cv.style.cursor = h.part === 'body' ? 'move' : 'pointer'; return; } }
    cv.style.cursor = drag ? (drag.zone === 'plot' ? 'grabbing' : drag.zone === 'price' ? 'ns-resize' : 'ew-resize') : z === 'price' ? 'ns-resize' : z === 'time' ? 'ew-resize' : 'crosshair';
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
    if (p.x >= plotW) {                                          // over the price axis: stretch price
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
      drag = null; dd = null; draft = null; od = null; xDown = null; V.follow = false; return;
    }
    shiftHeld = !!e.shiftKey;
    const primary = e.button === 0 || e.button === undefined;
    // Order lines come first (over drawings): the close handle, or the label / axis tag to drag. Not while a
    // drawing tool is active, so drawing never grabs an order by accident.
    if (primary && orderEditing && !tool && !draft) {
      const oh = hitOrder(p);
      if (oh && oh.part === 'x') { xDown = oh.id; return; }
      if (oh) {
        const ord = orders.find(x => x.id === oh.id);
        if (ord) { const p0 = orderPrice(ord); od = { id: ord.id, y0: p.y, price0: p0, price: p0, moved: false }; setCursor('plot', p); dirty = true; return; }
      }
    }
    if (zoneOf(p) === 'plot' && primary) {
      if (draft) { draft.b = { t: timeOfIdx(indexAt(p.x)), p: priceAt(p.y) }; finishDraft(); return; }
      if (tool === 'hline') {
        const d = { id: genId(), type: 'hline', price: roundTo(priceAt(p.y), o.tick) };
        drawings.push(d); selectedId = d.id; drawingsChanged(); setToolInternal(null); return;
      }
      if (tool === 'trend') {
        const pt = { t: timeOfIdx(indexAt(p.x)), p: priceAt(p.y) };
        draft = { id: genId(), type: 'trend', a: pt, b: { t: pt.t, p: pt.p }, x0: p.x, y0: p.y };
        dd = { mode: 'draft' }; dirty = true; return;
      }
      const hit = e.shiftKey ? null : hitDrawing(p);          // Shift+click is for placing orders, never for drawings
      if (hit) { selectedId = hit.d.id; dd = { d: hit.d, part: hit.part, x0: p.x, y0: p.y, orig: cloneDrawing(hit.d) }; setCursor('plot', p); dirty = true; return; }
      if (selectedId) { selectedId = null; dirty = true; }
    }
    drag = { zone: zoneOf(p), x0: p.x, y0: p.y, right0: V.right, lo0: V.lo, hi0: V.hi, logS0: V.logS, samples: [{ t: e.timeStamp, r: V.right }], moved: false,
      place: orderEditing && !!e.shiftKey && !tool && zoneOf(p) === 'plot' && primary };   // Shift+click places an order if the pointer does not move
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
      draft.b = { t: timeOfIdx(indexAt(Math.min(p.x, plotW))), p: priceAt(clamp(p.y, 0, plotH)) };
      hover = p; dirty = true; return;
    }
    if (dd && dd.d) {
      const d = dd.d, org = dd.orig;
      if (d.type === 'hline') d.price = roundTo(org.price + (priceAt(p.y) - priceAt(dd.y0)), o.tick);
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
      if (drag.zone === 'plot') {
        V.right = drag.right0 - dx / V.spacing; clampRight();
        if (!V.auto) { const sh = dy / plotH * (drag.hi0 - drag.lo0); V.lo = drag.lo0 + sh; V.hi = drag.hi0 + sh; }
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
    setCursor(zoneOf(p), p);
    dirty = true;
  }
  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) { pinch = null; setFollowFromPosition(); } return; }
    const cancelled = e.type === 'pointercancel';
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
      if (!cancelled && inPlot && shown && d.moved && d.price !== d.price0 && orderEditing) { pendingMoves.set(d.id, d.price); emit('orderMove', { id: d.id, price: d.price }); }
      setCursor(zoneOf(p), p); dirty = true; return;
    }
    if (dd) {
      const p = local(e);
      if (dd.mode === 'draft') { if (draft && Math.hypot(p.x - draft.x0, p.y - draft.y0) > 4) finishDraft(); }   // drag-to-draw; a click waits for a second click
      else drawingsChanged();
      dd = null; setCursor(zoneOf(p), p); dirty = true; return;
    }
    if (drag && drag.zone === 'plot' && drag.moved) {
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
  function onLeave(e) { if (!drag && !od && e.pointerType === 'mouse') { hover = null; dirty = true; } }
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
    if (e.key === 'Escape' && (od || xDown !== null)) { od = null; xDown = null; setCursor('plot'); e.preventDefault(); dirty = true; return; }   // revert the drag
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dist = vis * 0.2 * (e.key === 'ArrowLeft' ? -1 : 1);
      V.follow = false; V.kin = { v: dist / o.motion.friction };
    } else if (e.key === '+' || e.key === '=') zoomBy(0.3, plotW * 0.75);
    else if (e.key === '-' || e.key === '_') zoomBy(-0.3, plotW * 0.75);
    else if (e.key === 'End') { V.kin = null; V.follow = true; }
    else if (e.key === 'a' || e.key === 'A') V.auto = true;
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { drawings = drawings.filter(d => d.id !== selectedId); selectedId = null; drawingsChanged(); }
    else if (e.key === 'Escape' && (tool || draft || selectedId)) { selectedId = null; setToolInternal(null); }
    else return;
    e.preventDefault(); dirty = true;
  }
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
      if (live !== wasLive) { wasLive = live; if (liveBtn) liveBtn.hidden = live; emit('live', live); }
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
    setLayers(partial) { Object.assign(o.layers, partial || {}); dirty = true; },
    getLayers() { return Object.assign({}, o.layers); },
    /**
     * The volume profile to draw (a ChartEngine.VolumeProfile, or null): shown while the 'vp' layer is on, as bars
     * from the right edge of the plot (the POC row VP_WIDTH of the plot width), behind the candles. The chart redraws
     * when profile.version changes, so the caller only adds trades to it.
     */
    setProfile(vp) { profile = vp && typeof vp.columns === 'function' ? vp : null; if (vpBars) vpBars.ver = -1; dirty = true; },
    getProfile() { return profile; },
    /** Change colors, e.g. { up, down, vwap, bg }. The theme is built here, once per change. */
    setTheme(partial) { themeSrc = Object.assign({}, themeSrc, partial || {}); T = buildTheme(themeSrc); themeBuilds++; shadeLevels(); legendKey = ''; dirty = true; },
    /** The colors as chosen (not as moved to read on the ground; colors() has those). */
    getTheme() { const out = {}; for (const k in DEFAULT_THEME) out[k] = themeSrc[k]; return out; },
    /** Derived colors as drawn, e.g. upText / downText for legend text that stays readable, text2, legendBg, ground. */
    colors() { return Object.assign({}, T); },
    setPaused(v) { paused = !!v; dirty = true; },
    /** Glide and other motion time constants in ms, e.g. setMotion({ candle: 0 }) for no candle glide. */
    setMotion(partial) { Object.assign(o.motion, partial || {}); dirty = true; },
    getMotion() { return Object.assign({}, o.motion); },
    setPriceFormat(f) { if (f && f.precision !== undefined) o.precision = f.precision; if (f && f.tick !== undefined) o.tick = f.tick; V.init = false; dirty = true; },
    /** Replace the bar-close countdown under the price tag (e.g. ticks left in a range bar). null restores it. */
    setCountdown(fn) { countdownFn = typeof fn === 'function' ? fn : null; dirty = true; },
    /** Fill markers: [{ t, price, side: 'buy' | 'sell', qty }] */
    setMarkers(list) { markers = (list || []).filter(m => isFinite(m.price) && isFinite(m.t)); dirty = true; },
    /** The fill markers as set (1.6.0, for reading). */
    getMarkers() { return markers.map(m => Object.assign({}, m)); },
    /** Drawing tool: 'hline', 'trend' or null. */
    setTool(t) { setToolInternal(t === 'hline' || t === 'trend' ? t : null); },
    getTool() { return tool; },
    setDrawings(list) { drawings = (list || []).filter(d => d && (d.type === 'hline' || d.type === 'trend')).map(cloneDrawing); selectedId = null; draft = null; dirty = true; },
    getDrawings() { return drawings.map(cloneDrawing); },
    deleteSelected() { if (!selectedId) return false; drawings = drawings.filter(d => d.id !== selectedId); selectedId = null; drawingsChanged(); dirty = true; return true; },
    clearDrawings() { drawings = []; selectedId = null; draft = null; drawingsChanged(); dirty = true; },
    setBarSeconds(sec) { o.barSeconds = sec; dirty = true; },
    /**
     * Working orders: [{ id, side: 'buy' | 'sell', kind: 'limit' | 'stop' | 'market', price, qty, filled, role }].
     * role 'stop' / 'target' marks bracket legs. Replaces the list and drops prices still waiting on a move.
     */
    setOrders(list) {
      orders = (list || []).filter(x => x && x.id !== undefined && isFinite(x.price) && x.price !== null)
        .map(x => ({ id: x.id, side: x.side === 'sell' ? 'sell' : 'buy', kind: x.kind, price: +x.price, qty: +x.qty || 0, filled: +x.filled || 0, role: x.role || null }));
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
    setOrderEditing(on) { orderEditing = !!on; if (!orderEditing) { od = null; xDown = null; } dirty = true; },
    /** fn(price) -> { side, kind, qty, note } or null: what Shift+click would place, shown while Shift is held. */
    setOrderPreview(fn) { orderPreview = typeof fn === 'function' ? fn : null; dirty = true; },
    /** Where each order's label, close handle and axis tag were last drawn (CSS px in the chart), for tests and tooltips. */
    orderHandles() { return orderHits.map(h => JSON.parse(JSON.stringify(h))); },
    /** Price to y and back, in CSS px from the top of the chart (as last drawn). */
    priceToY(price) { return yOf(price); },
    yToPrice(y) { return priceAt(y); },
    goLive() { V.kin = null; V.follow = true; dirty = true; },
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
      cv.remove(); if (liveBtn) liveBtn.remove();
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
 */
function mountThemePanel(chart, host, options) {
  const opt = Object.assign({ storageKey: 'chart-engine-colors-v1', label: 'Colors' }, options || {});
  injectStyle();
  const FIELDS = [['up', 'Bull'], ['down', 'Bear'], ['vwap', 'VWAP'], ['bg', 'Ground']];
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
      '<button type="button" class="ce-reset">Reset to default</button>' +
      '<div class="ce-note">Saved in this browser only.</div>' +
    '</div>';
  host.appendChild(wrap);
  const btn = wrap.querySelector('.ce-theme-btn'), panel = wrap.querySelector('.ce-theme-panel');
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
    element: wrap, get: () => Object.assign({}, cur), set: apply, close: () => open(false),
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
 * Keep (option `keep: true`, Anthony's ruling 2026-09-30; the page uses it): over weekends and NYSE holidays the
 * profile keeps the last session it counted until the next session's first trade, so a Friday can be reviewed over
 * the weekend. A trading day with no stock market session (closedDay: Saturday, Sunday, an NYSE holiday; the trading
 * day runs from 18:00 ET the evening before) never empties it on the clock (advance does nothing), and with `rth` its
 * trades outside the RTH window never empty it either (on Labor Day or Thanksgiving Globex trades, but there is no
 * RTH: the RTH of the day before stays). On a trading day with a stock market session nothing changes from the
 * default: the next session's first trade (Sunday 18:00, and every weekday 18:00) starts it, and with `rth` the RTH
 * profile is empty overnight until 9:30, as in 1.6.0 (Anthony's ruling covers weekends and holidays only). Without
 * `keep` (the default) the session moves as above. closedFrom(now) says which ticks a kept profile needs.
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
      // look further back only while the day just tried has no stock market session (a kept profile's rule)
      if (!vp.empty || from <= first || k >= 7 || !(vp.keep && closedDay(d))) return vp;
      vp = new VolumeProfile(opts);
    }
  }
  /**
   * While CME Globex is closed (cmeClosed: the 17:00 to 18:00 ET break, Friday 17:00 to Sunday 18:00, a day with no
   * Globex session, and after an NYSE holiday's 13:00 halt), the time from which a kept profile needs every trade:
   * for the full session, the start (18:00 ET the evening before) of the last Globex session, by the CME calendar; with
   * `rth`, 9:30 of the last day with a stock market session, by the NYSE calendar. Null while Globex trades, also on an
   * NYSE holiday before its halt (1.6.1, review 2 S5: the page then loads ticks for the view only, never more).
   * Pure: `now` is exchange wall-clock seconds.
   */
  closedFrom(now) {
    if (!cmeClosed(now)) return null;
    if (this.rth) {
      let day = Math.floor(now / DAY);
      for (let k = 0; k < 12; k++, day--) if (rthDay(day * DAY + 43200) && day * DAY + this.rthStart <= now) return day * DAY + this.rthStart;
      return null;
    }
    let d = tradeDay(now, this.sessionStart);
    for (let k = 0; k < 12 && !cmeSessionDay(d); k++) d--;
    return this.startOfDay(d);
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
      // keep: an RTH profile outlives the Globex trades of a day with no stock market session (a holiday)
      if (this.keep && this.rth && this.day !== null && closedDay(d) && !this.inRth(t)) { this.outside++; return false; }
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
    // keep: on a weekend or a holiday, and after one until the next session's first trade, the clock moves nothing
    if (this.keep && (closedDay(d) || (this.day !== null && closedBetween(this.day, d)))) return false;
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

return {
  VERSION, create, mountThemePanel, DEFAULT_THEME, PRESETS, BACKGROUNDS, LEVEL_COLORS, FLOOR, PAIR, IB_FORMING_DASH, VP_WIDTH, VP_POC_MIN,
  util: {
    DAY, tod, tradeDay, zoneSeconds, fmtHM, fmtDay, fmtDate, fmtFull, fmtPrice, fmtVolume, roundTo, niceStep,
    parseColor, rgba, luminance, contrast, readableOn, legible, onGround, markOnGround, pairOnGround, distinct, mix, buildTheme, chromeColors, CHROME_VARS, CHROME_LIGHT,
    aggregate, foldLast, addSessionVwap, sessionLevels, levelLines, initialBalance, ibLines, rthDay, closedDay, cmeClosed, cmeSessionDay, cmeClosures, nyseHolidays, nyseEarlyCloses, rthClose,
    orderLabel, openPnl, fmtMoney, fmtSigned, groupFills, stackFillLabels, profileRects,
  },
  VolumeProfile,
};
});
