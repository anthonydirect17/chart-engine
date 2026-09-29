/*!
 * chart-engine 1.2.1
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

const VERSION = '1.2.1';
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
/** The same hue, lightened just enough to read as text on `bg` (WCAG 4.5 by default). */
function legible(color, bg, min) {
  const target = min || 4.5; const c = parseColor(color); if (!c) return color;
  for (let k = 0; k <= 1.0001; k += 0.05) {
    const m = { r: c.r + (255 - c.r) * k, g: c.g + (255 - c.g) * k, b: c.b + (255 - c.b) * k };
    if (contrast(m, parseColor(bg)) >= target) return toHex(m);
  }
  return '#FFFFFF';
}

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
  fontMono: '"IBM Plex Mono", ui-monospace, Consolas, monospace',
  fontCond: '"IBM Plex Sans Condensed", "IBM Plex Sans", system-ui, sans-serif',
};
const PRESETS = [
  { id: 'carolina', name: 'Carolina / purple', up: '#4B9CD3', down: '#6D28D9' },
  { id: 'mint', name: 'Mint / coral', up: '#4FD1A5', down: '#F0717A' },
  { id: 'house', name: 'House green / red', up: '#3DDC97', down: '#FF7A7A' },
];
const LEVEL_COLORS = { prior: '#9AA8B8', overnight: '#7FB2FF', value: '#E0B45A', close: '#8392A5' };

function buildTheme(partial) {
  const T = Object.assign({}, DEFAULT_THEME, partial || {});
  T.upVol = rgba(T.up, T.volumeAlpha); T.downVol = rgba(T.down, T.volumeAlpha);
  T.upOnTag = readableOn(T.up); T.downOnTag = readableOn(T.down);
  T.upText = legible(T.up, T.bg); T.downText = legible(T.down, T.bg);
  T.vwapText = legible(T.vwap, T.bg);
  return T;
}

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

/* ---------------------------------------------------------------- DOM styles */
const CSS = `
.ce-host{position:relative;overflow:hidden;outline:none}
.ce-host:focus-visible{box-shadow:inset 0 0 0 2px #B69CFF}
.ce-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:crosshair;user-select:none;-webkit-user-select:none}
.ce-live{position:absolute;right:90px;bottom:38px;z-index:3;font:600 12px "IBM Plex Sans",system-ui,sans-serif;color:#B69CFF;background:#1A1230;border:1px solid #3B2A6B;border-radius:999px;padding:5px 12px;min-height:30px;cursor:pointer}
.ce-live:hover{color:#fff}
.ce-live:focus-visible{outline:2px solid #B69CFF;outline-offset:2px}
.ce-theme{position:relative;display:inline-block}
.ce-theme-btn{font:500 12px "IBM Plex Sans",system-ui,sans-serif;color:#E6EDF5;background:#0F151D;border:1px solid #2A3645;border-radius:8px;padding:4px 12px 4px 8px;min-height:30px;cursor:pointer;display:inline-flex;align-items:center;gap:8px}
.ce-theme-btn:hover{background:#141C26}
.ce-theme-btn:focus-visible,.ce-theme-panel button:focus-visible,.ce-theme-panel input:focus-visible{outline:2px solid #B69CFF;outline-offset:2px}
.ce-sw2{display:inline-flex;gap:2px}.ce-sw2 i{width:8px;height:14px;border-radius:2px;display:block}
.ce-theme-panel{position:absolute;top:calc(100% + 6px);right:0;z-index:20;width:268px;max-width:calc(100vw - 32px);box-sizing:border-box;background:#0B1016;border:1px solid #2A3645;border-radius:12px;padding:12px;display:grid;gap:10px;box-shadow:0 12px 32px rgba(0,0,0,.45);font:13px "IBM Plex Sans",system-ui,sans-serif;color:#E6EDF5}
.ce-theme-panel[hidden]{display:none}
.ce-lbl{font:600 10px "IBM Plex Sans Condensed","IBM Plex Sans",sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#8392A5}
.ce-presets{display:grid;gap:6px}
.ce-preset{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:#0F151D;border:1px solid #18212C;border-radius:8px;padding:6px 8px;color:#E6EDF5;font:500 12px "IBM Plex Sans",system-ui,sans-serif;cursor:pointer;min-height:32px}
.ce-preset[aria-pressed="true"]{border-color:#3B2A6B;background:#1A1230;color:#D8CCFF}
.ce-row{display:grid;grid-template-columns:64px 36px minmax(0,1fr);gap:8px;align-items:center}
.ce-row input[type=color]{width:36px;height:28px;padding:0;border:1px solid #2A3645;border-radius:6px;background:#0F151D;cursor:pointer}
.ce-row input[type=text]{width:100%;box-sizing:border-box;min-width:0;background:#0F151D;border:1px solid #2A3645;border-radius:6px;color:#E6EDF5;font:500 12px "IBM Plex Mono",ui-monospace,monospace;padding:5px 7px;min-height:28px}
.ce-reset{justify-self:start;background:transparent;border:1px solid #2A3645;border-radius:8px;color:#9AA8B8;font:500 12px "IBM Plex Sans",system-ui,sans-serif;padding:4px 10px;min-height:30px;cursor:pointer}
.ce-note{font-size:11px;color:#8392A5;line-height:1.4}
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
    layers: Object.assign({ volume: true, vwap: true, levels: true, trades: true }, opt.layers || {}),
    motion: Object.assign({ zoom: 75, fit: 120, candle: 55, follow: 110, friction: 325 }, opt.motion || {}),
    clock: opt.clock || (() => zoneSeconds(Date.now() / 1000, opt.timeZone || 'America/New_York')),
    liveButton: opt.liveButton !== false,
    unit: opt.unit !== undefined ? opt.unit : 'pt',
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

  let T = buildTheme(opt.theme);
  let bars = [], levels = [], trades = [], markers = [], paused = false, countdownFn = null;
  let drawings = [], tool = null, selectedId = null, dd = null, draft = null;
  const listeners = { legend: [], live: [], drawings: [], tool: [] };
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
    ctx.fillText(text, plotW + 8, top + 9);
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
    if (o.layers.levels && levels.length) {
      ctx.font = '600 10px ' + T.fontCond; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      const lw = Math.max(1, Math.round(dpr));
      const vis = levels.filter(L => L.price >= V.lo && L.price <= V.hi).sort((a, b) => b.price - a.price);
      const groups = [];
      for (const L of vis) {
        const y = crisp(yOf(L.price), lw), col = L.color || T.axisText;
        ctx.strokeStyle = col; ctx.globalAlpha = 0.7; ctx.lineWidth = lw / dpr; ctx.setLineDash(L.dash || [6, 4]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
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
        ctx.fillStyle = d > 0 ? T.long : T.short; ctx.strokeStyle = T.bg; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x1, y1 - d * s); ctx.lineTo(x1 - s, y1 + d * s * 0.7); ctx.lineTo(x1 + s, y1 + d * s * 0.7); ctx.closePath(); ctx.stroke(); ctx.fill();
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

    // fills: buy triangles point up, sell triangles point down, tip at the fill price
    if (markers.length && n >= 0) {
      ctx.font = '500 10px ' + T.fontMono; ctx.textBaseline = 'middle';
      for (const m of markers) {
        const i = idxAtTime(m.t); if (i < from - 1 || i > to + 1) continue;
        const x = xOf(i), y = yOf(m.price), s = 5, buy = m.side === 'buy', dir = buy ? 1 : -1;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - s, y + dir * s * 1.6); ctx.lineTo(x + s, y + dir * s * 1.6); ctx.closePath();
        ctx.fillStyle = buy ? T.long : T.short; ctx.strokeStyle = T.bg; ctx.lineWidth = 1.5; ctx.stroke(); ctx.fill();
        if (V.spacing >= 4 && m.qty) { ctx.fillStyle = buy ? T.long : T.short; ctx.textAlign = 'left'; ctx.fillText(String(m.qty), x + s + 3, y + dir * s); }
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
          const k = age / 500;
          ctx.beginPath(); ctx.arc(lx, ly, 3 + k * 9, 0, Math.PI * 2);
          ctx.strokeStyle = lastCol; ctx.globalAlpha = 0.5 * (1 - k); ctx.lineWidth = 1.5; ctx.stroke(); ctx.globalAlpha = 1;
        }
        ctx.beginPath(); ctx.arc(lx, ly, 2.5, 0, Math.PI * 2); ctx.fillStyle = T.live; ctx.fill();
      }
    }

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

    const tagSrc = (o.layers.levels ? levels : []).concat(drawings.filter(d => d.type === 'hline').map(d => ({ price: d.price, color: d.color || T.drawing })));
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
    for (const t of tags) axisTag(t.y, fmtPrice(t.L.price, o.precision), T.bg, t.L.color || T.axisText, t.L.color || T.axisText, null);

    // last price tag with countdown; flashes on each tick
    if (n >= 0) {
      axisTag(ly, fmtPrice(bars[n].c, o.precision), lastCol, lastTag, null, countdown());
      if (flash) {
        const k = Math.exp(-(now - flash) / 160);
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
    if (dd && dd.mode !== 'draft') { cv.style.cursor = 'grabbing'; return; }
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
      drag = null; dd = null; draft = null; V.follow = false; return;
    }
    if (zoneOf(p) === 'plot' && (e.button === 0 || e.button === undefined)) {
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
      const hit = hitDrawing(p);
      if (hit) { selectedId = hit.d.id; dd = { d: hit.d, part: hit.part, x0: p.x, y0: p.y, orig: cloneDrawing(hit.d) }; setCursor('plot', p); dirty = true; return; }
      if (selectedId) { selectedId = null; dirty = true; }
    }
    drag = { zone: zoneOf(p), x0: p.x, y0: p.y, right0: V.right, lo0: V.lo, hi0: V.hi, logS0: V.logS, samples: [{ t: e.timeStamp, r: V.right }], moved: false };
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
    drag = null;
    if (e.pointerType !== 'mouse') hover = null;
    setCursor('plot'); dirty = true;
  }
  function onLeave(e) { if (!drag && e.pointerType === 'mouse') { hover = null; dirty = true; } }
  function onDbl(e) {
    const z = zoneOf(local(e));
    if (z === 'price') V.auto = true;
    else if (z === 'time') V.logT = Math.log(o.barSpacing);
    else api.reset();
    dirty = true;
  }
  function onKey(e) {
    const vis = plotW / V.spacing;
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
  if (liveBtn) liveBtn.addEventListener('click', () => api.goLive());
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(container);
  resize();

  /* ---------------- frame loop */
  let raf = 0, lastFrame = 0, lastDraw = 0, emaInt = 16.7, emaDraw = 1, streak = 0;
  function frame(now) {
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
    raf = requestAnimationFrame(frame);
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
    setLevels(list) { levels = (list || []).filter(L => isFinite(L.price)); dirty = true; },
    setTrades(list) { trades = list || []; dirty = true; },
    setLayers(partial) { Object.assign(o.layers, partial || {}); dirty = true; },
    getLayers() { return Object.assign({}, o.layers); },
    setTheme(partial) { T = buildTheme(Object.assign({}, api.getTheme(), partial || {})); legendKey = ''; dirty = true; },
    getTheme() { const out = {}; for (const k in DEFAULT_THEME) out[k] = T[k]; return out; },
    /** Derived colors, e.g. upText / downText for legend text that stays readable. */
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
    /** Drawing tool: 'hline', 'trend' or null. */
    setTool(t) { setToolInternal(t === 'hline' || t === 'trend' ? t : null); },
    getTool() { return tool; },
    setDrawings(list) { drawings = (list || []).filter(d => d && (d.type === 'hline' || d.type === 'trend')).map(cloneDrawing); selectedId = null; draft = null; dirty = true; },
    getDrawings() { return drawings.map(cloneDrawing); },
    deleteSelected() { if (!selectedId) return false; drawings = drawings.filter(d => d.id !== selectedId); selectedId = null; drawingsChanged(); dirty = true; return true; },
    clearDrawings() { drawings = []; selectedId = null; draft = null; drawingsChanged(); dirty = true; },
    setBarSeconds(sec) { o.barSeconds = sec; dirty = true; },
    goLive() { V.kin = null; V.follow = true; dirty = true; },
    reset() { V.auto = true; V.follow = true; V.kin = null; V.anchor = null; V.logT = Math.log(o.barSpacing); dirty = true; },
    isLive() { return V.follow; },
    bars() { return bars; },
    on(ev, fn) { if (listeners[ev]) listeners[ev].push(fn); return () => { const a = listeners[ev]; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }; },
    stats() {
      const now = performance.now();
      return { idle: now - lastDraw > 250 || streak < 3, fps: Math.round(1000 / emaInt), drawMs: emaDraw };
    },
    resize,
    destroy() {
      cancelAnimationFrame(raf); if (ro) ro.disconnect();
      container.removeEventListener('keydown', onKey);
      cv.remove(); if (liveBtn) liveBtn.remove();
      container.classList.remove('ce-host');
    },
  };
  return api;
}

/* ---------------------------------------------------------------- color settings panel */
/**
 * A "Colors" button with a small panel: presets, bull / bear / VWAP pickers, reset.
 * Choices are saved in this browser under `storageKey` and applied on load.
 * `onChange(colors)` runs on load and after every change.
 */
function mountThemePanel(chart, host, options) {
  const opt = Object.assign({ storageKey: 'chart-engine-colors-v1', label: 'Colors' }, options || {});
  injectStyle();
  const FIELDS = [['up', 'Bull'], ['down', 'Bear'], ['vwap', 'VWAP']];
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
      FIELDS.map(([k, name]) => '<label class="ce-row" for="' + uid + '-' + k + '"><span>' + name + '</span>' +
        '<input type="color" id="' + uid + '-' + k + '" data-k="' + k + '">' +
        '<input type="text" data-hex="' + k + '" aria-label="' + name + ' hex" maxlength="7" spellcheck="false"></label>').join('') +
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
  }
  function apply(partial) { cur = Object.assign({}, cur, clean(Object.assign({}, cur, partial))); chart.setTheme(cur); store(cur); sync(); changed(); }
  for (const inp of wrap.querySelectorAll('input[type=color]')) inp.addEventListener('input', () => apply({ [inp.dataset.k]: inp.value }));
  for (const inp of wrap.querySelectorAll('input[data-hex]')) inp.addEventListener('input', () => {
    let v = inp.value.trim(); if (v[0] !== '#') v = '#' + v;
    if (/^#[0-9a-f]{6}$/i.test(v)) apply({ [inp.dataset.hex]: v });
  });
  wrap.querySelector('.ce-reset').addEventListener('click', () => apply(defaults));
  const open = v => { panel.hidden = !v; btn.setAttribute('aria-expanded', String(v)); };
  btn.addEventListener('click', () => open(panel.hidden));
  document.addEventListener('pointerdown', e => { if (!wrap.contains(e.target)) open(false); });
  wrap.addEventListener('keydown', e => { if (e.key === 'Escape') { open(false); btn.focus(); } });
  sync(); changed();
  return { element: wrap, get: () => Object.assign({}, cur), set: apply, close: () => open(false) };
}

return {
  VERSION, create, mountThemePanel, DEFAULT_THEME, PRESETS, LEVEL_COLORS,
  util: {
    DAY, tod, tradeDay, zoneSeconds, fmtHM, fmtDay, fmtDate, fmtFull, fmtPrice, fmtVolume, roundTo, niceStep,
    parseColor, rgba, luminance, contrast, readableOn, legible, buildTheme,
    aggregate, foldLast, addSessionVwap, sessionLevels, levelLines,
  },
};
});
