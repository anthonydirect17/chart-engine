/*
 * ChartKit: the shared visual kit for Anthony's trading apps (docs/KIT.md): colours, type, components and the light.
 * One dependency-free file next to live/kit.css. Load it as a plain <script> (it sets window.ChartKit), from an ES module
 * (`import './kit.js'` then `window.ChartKit`), or from Node (`require('./live/kit.js')`, for the tests). Nothing touches
 * a page when it loads in Node, and nothing runs per frame anywhere: the light is a pure CSS animation.
 *
 * THE LIGHT (Anthony's rules, 2026-10-08):
 *   L1 Outside the Agent tab (.kit-agent) the light runs only while in a trade (pace 'trade'), only around the panel
 *      showing that trade, and only on its border.
 *   L2 Never on the order ticket, order lines, Flatten or the copier. An element marked data-no-light, or inside one, or
 *      inside the chart itself (.chart-live), a ticket (.tk, tk-* classes), Flatten (.ws-flat) or the copier
 *      (.apg-cop-top, .apg-cop-g, data-copier) refuses to light, with a console note. So does a panel that holds a
 *      ticket or the copier, and any button, link, field, chip or number (.kit-btn, .kit-chip, .kit-num, .kit-big).
 *   L3 Rule R3 of docs/MOTION.md holds: numbers, prices, P&L and buttons never animate or ease. Only the border light and
 *      the panel glow fade between colours.
 *
 *   ChartKit.light(panelEl, { on: true, color: 'profit', pace: 'trade' });   // true when lit, false when off or refused
 *   ChartKit.light(panelEl, { on: false });
 *   ChartKit.armed(panelEl, true);                                         // the soft purple armed outline
 *   ChartKit.setMotion('off');                                             // 'full' or 'off', remembered
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.ChartKit = factory(root);
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (glob) {
'use strict';

const VERSION = '1.0.0';
const STORAGE_KEY = 'kit-motion-v1';
/** Seconds per lap of the light: deciding (the Agent tab) and in a trade. */
const LAP = Object.freeze({ decide: 13, trade: 9 });

/* L2: what never lights. INSIDE is checked on the element and every parent; HOLDS on everything under the element. */
const NO_LIGHT = '[data-no-light], .chart-live, .tk, [class^="tk-"], [class*=" tk-"], .ws-flat, .apg-cop-top, .apg-cop-g, [data-copier]';
const HOLDS_ORDERS = '.tk, [class^="tk-"], [class*=" tk-"], .apg-cop-top, .apg-cop-g, [data-copier]';
const NOT_A_PANEL = 'button, a, input, select, textarea, .kit-btn, .kit-chip, .kit-num, .kit-big';

/* The tokens, as kit.css has them on .kit (test/kit.test.js keeps the two the same). The money colours, the candle
   colours and three purples are the chart's locked palette (test/theme.test.js LOCKED). */
const TOKENS = Object.freeze({
  ground: '#010307',
  panel: 'rgba(0,6,12,.74)',
  'drawer-bg': 'rgba(1,5,11,.97)',
  cyan: '#5df2ff',
  hot: '#e8feff',
  text: '#c9e7ec',
  dim: '#7fb6c0',
  line: 'rgba(93,242,255,.20)',
  'line-soft': 'rgba(93,242,255,.10)',
  tint: 'rgba(93,242,255,.08)',
  meter: '#5df2ff',
  'purple-deep': '#6d28d9',
  purple: '#7b5cff',
  'purple-soft': '#b69cff',
  'purple-text': '#d8ccff',
  danger: '#ff3b5c',
  'danger-text': '#ffd0d8',
  profit: '#3ddc97',
  loss: '#ff7a7a',
  'profit-text': '#c9f7e3',
  'loss-text': '#ffd6d6',
  'candle-up': '#4b9cd3',
  'candle-down': '#6d28d9',
  'sig-screen': '#5df2ff',
  'sig-eyes': '#8f7bff',
  'sig-judgment': '#c81fe0',
  'sig-checks': '#ffd23f',
  'sig-go': '#3dff9a',
  'sig-pass': '#ff8a2a',
  'sig-danger': '#ff3b5c',
  armed: '#9b7bff',
  'armed-line': 'rgba(155,123,255,.32)',
  off: '#3a4a55',
});

/* What each surface changes (kit.css: .kit-trading, .kit-desk, .kit-agent). The desk is also the plain .kit. */
const VARIANTS = Object.freeze({
  trading: Object.freeze({ hot: '#dfe8ef', text: '#b7c6d1', dim: '#7d8fa0', line: 'rgba(120,146,166,.20)', 'line-soft': 'rgba(120,146,166,.14)', tint: 'rgba(120,146,166,.08)', meter: '#7d8fa0' }),
  desk: Object.freeze({}),
  agent: Object.freeze({ line: 'rgba(93,242,255,.26)' }),
});

/* The tokens used as text, each with the smallest size it is used at (px). 4.5:1 on the ground below 24 px, 3:1 above. */
const TEXT = Object.freeze({
  hot: 11, text: 11, dim: 11, cyan: 11, purple: 13, 'purple-soft': 11, 'purple-text': 11, danger: 11, 'danger-text': 11,
  profit: 11, loss: 11, 'profit-text': 11, 'loss-text': 11,
  'sig-screen': 10, 'sig-eyes': 10, 'sig-judgment': 10, 'sig-checks': 10, 'sig-go': 10, 'sig-pass': 10, 'sig-danger': 10,
});

/** The light's colours by name. Any #rgb or #rrggbb also works. */
const COLORS = Object.freeze({
  screen: TOKENS['sig-screen'], cyan: TOKENS.cyan, eyes: TOKENS['sig-eyes'], judgment: TOKENS['sig-judgment'],
  checks: TOKENS['sig-checks'], go: TOKENS['sig-go'], pass: TOKENS['sig-pass'], caution: TOKENS['sig-pass'],
  danger: TOKENS['sig-danger'], profit: TOKENS.profit, loss: TOKENS.loss, armed: TOKENS.armed,
});

/* ---------------------------------------------------------------- colour maths (pure, for the gallery and the tests) */
/** '#5df2ff' or 'rgba(0,6,12,.74)' to { r, g, b, a } (0..255, alpha 0..1); null when it is neither. */
function parseColor(s) {
  s = String(s || '').trim().toLowerCase();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (m) {
    const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  return null;
}
/** A colour laid over another (alpha over an opaque base). Returns { r, g, b, a: 1 }. */
function over(top, base) {
  const t = typeof top === 'string' ? parseColor(top) : top, b = typeof base === 'string' ? parseColor(base) : base;
  return { r: t.r * t.a + b.r * (1 - t.a), g: t.g * t.a + b.g * (1 - t.a), b: t.b * t.a + b.b * (1 - t.a), a: 1 };
}
/** WCAG relative luminance of an opaque colour. */
function luminance(c) {
  c = typeof c === 'string' ? parseColor(c) : c;
  const ch = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}
/** WCAG contrast ratio of two colours (a translucent first colour is laid over the second). */
function contrast(fg, bg) {
  let f = typeof fg === 'string' ? parseColor(fg) : fg;
  const b = typeof bg === 'string' ? parseColor(bg) : bg;
  if (f.a < 1) f = over(f, b);
  const l1 = luminance(f), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
/** The tokens of one surface: 'trading', 'desk' or 'agent'. */
function tokens(variant) { return Object.assign({}, TOKENS, VARIANTS[variant] || {}); }

/** A light colour: a name from COLORS or a hex colour; null when it is neither. */
function resolveColor(c) {
  if (c == null || c === '') return COLORS.screen;
  const k = String(c).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(COLORS, k)) return COLORS[k];
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(k) ? k : null;
}

/* ---------------------------------------------------------------- the page side */
/** Builds a kit on its own page (the tests pass fakes); the exported one uses the browser's. Nothing is read or written
 *  until a call needs it, so requiring the file in Node touches nothing. */
function create(env) {
  env = env || {};
  const docOf = () => (env.document !== undefined ? env.document : (glob && glob.document) || null);
  const storage = () => { try { return env.storage !== undefined ? env.storage : (glob && glob.localStorage) || null; } catch (e) { return null; } };
  const out = () => env.console || (glob && glob.console) || null;
  const mq = () => {
    try {
      const mm = env.matchMedia || (glob && glob.matchMedia ? glob.matchMedia.bind(glob) : null);
      return mm ? mm('(prefers-reduced-motion: reduce)') : null;
    } catch (e) { return null; }
  };
  const noted = typeof WeakMap === 'function' ? new WeakMap() : null;

  const closest = (el, sel) => { try { return el && el.closest ? el.closest(sel) : null; } catch (e) { return null; } };
  const find = (el, sel) => { try { return el && el.querySelector ? el.querySelector(sel) : null; } catch (e) { return null; } };
  const matches = (el, sel) => { try { return !!(el && el.matches && el.matches(sel)); } catch (e) { return false; } };
  const hasClass = (el, c) => { try { return !!(el && el.classList && el.classList.contains(c)); } catch (e) { return false; } };
  const setClass = (el, c, on) => { if (hasClass(el, c) !== !!on) el.classList.toggle(c, !!on); };

  function note(el, why) {
    if (noted) { if (noted.get(el) === why) return; noted.set(el, why); }
    const c = out();
    try { if (c && c.warn) c.warn('ChartKit: no light here. ' + why); } catch (e) { /* no console */ }
  }

  /** Why an element may not light at this pace ('' when it may). Pure reading; writes nothing. */
  function whyNoLight(el, pace) {
    if (!el || !el.classList) return 'Not an element.';
    if (closest(el, NO_LIGHT)) return 'It is the order ticket, an order line, Flatten or the copier, or inside one (or marked data-no-light).';
    if (find(el, HOLDS_ORDERS)) return 'It holds the order ticket or the copier.';
    if (matches(el, NOT_A_PANEL) || /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(String(el.tagName || '').toUpperCase())) return 'The light goes around panels, never on a button, a field, a chip or a number.';
    if (pace !== 'trade' && !closest(el, '.kit-agent')) return 'Outside the Agent tab the light runs only while in a trade (pace: trade).';
    return '';
  }

  /** The light's two layers (orbit and blurred halo), made once and kept. */
  function layers(el) {
    const kids = el.children ? Array.from(el.children) : [];
    if (kids.some(k => hasClass(k, 'kit-orbit')) && kids.some(k => hasClass(k, 'kit-halo'))) return;
    const doc = el.ownerDocument || docOf();
    const span = cls => { const s = doc.createElement('span'); s.className = cls; s.setAttribute('aria-hidden', 'true'); return s; };
    const halo = span('kit-halo');
    halo.appendChild(span('kit-orbit'));
    const orbit = span('kit-orbit');
    el.insertBefore(halo, el.firstChild || null);
    el.insertBefore(orbit, halo);
  }

  /** The light around a panel: { on, color, pace }. Returns true when lit; false when off or refused (with a console
   *  note). Writes only what changed, so calling it on every P&L update is cheap. Turning it off is never refused. */
  function light(el, o) {
    o = o || {};
    if (!el || !el.classList) return false;
    if (o.on === false) { setClass(el, 'kit-lit', false); return false; }
    const pace = o.pace === 'trade' ? 'trade' : 'decide';
    let why = whyNoLight(el, pace);
    const color = resolveColor(o.color);
    if (!why && !color) why = 'Unknown colour ' + JSON.stringify(o.color) + '.';
    if (why) { note(el, why); setClass(el, 'kit-lit', false); return false; }
    layers(el);
    try { if (el.style.getPropertyValue('--kit-pc') !== color) el.style.setProperty('--kit-pc', color); } catch (e) { /* no style */ }
    setClass(el, 'kit-pace-trade', pace === 'trade');
    setClass(el, 'kit-pace-decide', pace !== 'trade');
    setClass(el, 'kit-lit', true);
    return true;
  }

  /** True while the light is on around this element. */
  function lit(el) { return hasClass(el, 'kit-lit'); }

  /** The armed outline: a soft, glowing purple border. Goes with the light. Returns the new state. */
  function armed(el, on) {
    if (!el || !el.classList) return false;
    setClass(el, 'kit-armed', !!on);
    return !!on;
  }

  let setting = null;   // 'full' or 'off' once read or set
  function readSetting() {
    if (setting) return setting;
    try { const s = storage(); setting = s && s.getItem(STORAGE_KEY) === 'off' ? 'off' : 'full'; } catch (e) { setting = 'full'; }
    return setting;
  }
  function markRoot() {
    try { const d = docOf(); if (d && d.documentElement && d.documentElement.classList) d.documentElement.classList.toggle('kit-motion-off', setting === 'off'); } catch (e) { /* no page */ }
  }
  /** The page's motion setting: 'full' (the default) or 'off'. */
  function motion() { return readSetting(); }
  /** Sets motion 'full' or 'off' (class kit-motion-off on <html>: the light stops circling; the glow stays), saved in
   *  localStorage under STORAGE_KEY unless { save: false }. Returns the setting. */
  function setMotion(v, o) {
    setting = v === 'off' ? 'off' : 'full';
    if (!o || o.save !== false) {
      try { const s = storage(); if (s) { if (setting === 'off') s.setItem(STORAGE_KEY, 'off'); else s.removeItem(STORAGE_KEY); } } catch (e) { /* storage blocked */ }
    }
    markRoot();
    return setting;
  }
  /** True when the light does not circle: the page setting, the motion kit's Less motion (motion-off on <html>), or
   *  the system's reduced motion. */
  function reduced() {
    if (readSetting() === 'off') return true;
    try { const d = docOf(); if (d && d.documentElement && d.documentElement.classList.contains('motion-off')) return true; } catch (e) { /* no page */ }
    const m = mq();
    return !!(m && m.matches);
  }
  /** Puts a saved 'off' on <html>. The browser build calls it once at load; Node never does. */
  function init() { if (readSetting() === 'off') markRoot(); }

  return {
    VERSION, STORAGE_KEY, LAP, NO_LIGHT, HOLDS_ORDERS, NOT_A_PANEL, TOKENS, VARIANTS, TEXT, COLORS,
    parseColor, over, luminance, contrast, tokens, resolveColor,
    light, lit, whyNoLight, armed, motion, setMotion, reduced, init,
    create,
  };
}

const kit = create();
try { if (glob && glob.document && glob.document.documentElement) kit.init(); } catch (e) { /* not a page */ }
return kit;
});
