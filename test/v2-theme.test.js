'use strict';
// House style V2, black and gold (chart 1.39.0). Anthony 2026-10-24: "lets unify everything. I really liked the black gold
// look you showed and I think it should live through our entire system"; candles: "You can add a black and gold pre-set,
// thats fine, but I change them - this is more of an overall theme change"; motion: "smooth everywhere where possible as far
// as we can go", with the limits: a live value shows its true value the instant it changes (never eased, faded in or counted
// up), no motion delays an action, nothing moves while an order is dragged, and reduced motion means no movement.
// Checked here: the Black and gold preset's contrast on every ground, the default candles untouched, no V1 purple or crimson
// left in the page chrome, and the motion limits as the stylesheets and the motion kit write them. test/v2-smoke.mjs checks
// the same limits in a real page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CE = require('../src/chart-engine.js');
const U = CE.util, F = CE.FLOOR;
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const GOLD = CE.PRESETS.find(p => p.id === 'gold');

test('the candle presets: the three of before unchanged and first, Black and gold added; the default candles unchanged', () => {
  assert.deepEqual(CE.PRESETS.map(p => [p.id, p.name, p.up, p.down]), [
    ['carolina', 'Carolina / purple', '#4B9CD3', '#6D28D9'],
    ['mint', 'Mint / coral', '#4FD1A5', '#F0717A'],
    ['house', 'House green / red', '#3DDC97', '#FF7A7A'],
    ['gold', 'Black and gold', '#D4B06A', '#7A7468']]);
  assert.equal(CE.DEFAULT_THEME.up, '#4B9CD3');
  assert.equal(CE.DEFAULT_THEME.down, '#6D28D9');
  assert.equal(CE.DEFAULT_THEME.volumeAlpha, 0.26);
  // the theme never changes a candle color on the default ground: the default, every preset, any color picked
  for (const c of [{}, ...CE.PRESETS.map(p => ({ up: p.up, down: p.down })), { up: '#123456', down: '#ABCDEF' }]) {
    const T = U.buildTheme(c), want = Object.assign({ up: CE.DEFAULT_THEME.up, down: CE.DEFAULT_THEME.down }, c);
    assert.equal(T.up, want.up); assert.equal(T.down, want.down);
    assert.equal(T.upVol, U.rgba(want.up, 0.26)); assert.equal(T.downVol, U.rgba(want.down, 0.26));
  }
});

test('Black and gold: candles, wicks and volume fit V2 and pass every contrast rule of CHART_STYLE.md on the V2 ground', () => {
  const T = U.buildTheme({ up: GOLD.up, down: GOLD.down });
  assert.equal(T.ground, 'default');
  const c = (a, b) => +U.contrast(a, b).toFixed(2);
  // candle bodies (the wick is the body's color, 1 device pixel) at the candle floor, on the ground and the RTH ground
  for (const g of [T.bg, T.rth]) { assert.ok(c(T.up, g) >= F.candle, 'bull on ' + g); assert.ok(c(T.down, g) >= F.candle, 'bear on ' + g); }
  assert.deepEqual([c(T.up, T.bg), c(T.down, T.bg)], [9.91, 4.39]);
  // bull and bear apart (pairOnGround's rule: 1.25:1 or an RGB distance of 60), the bull the brighter
  assert.ok(U.distinct(T.up, T.down) && c(T.up, T.down) >= CE.PAIR.contrast, 'apart: ' + c(T.up, T.down));
  assert.ok(U.luminance(T.up) > U.luminance(T.down));
  // text drawn in a candle color (the delta, the legend, the bubbles) at 4.5:1 as drawn, the last price tag readable
  assert.ok(c(T.upText, T.bg) >= F.text - 0.02 && c(T.downText, T.bg) >= F.text - 0.02);
  assert.ok(c(T.upOnTag, T.up) >= F.text && c(T.downOnTag, T.down) >= F.text, 'tag text on the candle-colored tag');
  // the volume bars: the candle colors at 26%, visible on the ground
  for (const v of [T.upVol, T.downVol]) { const p = U.parseColor(v); assert.equal(p.a, 0.26); }
  // over the volume profile's rows the gold preset reads better than the default candles (the floor there is open)
  const D = U.buildTheme();
  assert.ok(c(T.down, T.vpValue) > c(D.down, D.vpValue) && c(T.down, T.vpRow) > c(D.down, D.vpRow));
  // on every other ground (the presets and a sweep) the pair keeps its floor and stays apart, as every preset does
  const grounds = CE.BACKGROUNDS.map(b => b.bg).concat(['#FFFFFF', '#777777', '#B0102A', '#123456', '#E8E0C8']);
  for (let v = 0; v < 256; v += 5) { const h = v.toString(16).padStart(2, '0'); grounds.push('#' + h + h + h); }
  for (const bg of grounds) {
    const G = U.buildTheme({ bg, up: GOLD.up, down: GOLD.down });
    const cap = Math.min(U.contrast('#FFFFFF', bg), U.contrast('#000000', bg)) >= F.candle ? F.candle : Math.min(F.candle, CE.PAIR.split);
    assert.ok(U.contrast(G.up, bg) >= cap - 0.02 && U.contrast(G.down, bg) >= cap - 0.02, bg + ' candles at their floor');
    assert.ok(U.distinct(G.up, G.down), bg + ' bull and bear apart: ' + G.up + ' ' + G.down);
  }
});

test('the chart chrome in the default theme is V2 (no V1 blue-grey, purple or crimson), at every floor', () => {
  const T = U.buildTheme();
  const v1 = ['#080B10', '#0B1016', '#18212C', '#2A3645', '#5B6B80', '#8392A5', '#E6EDF5', '#141C26', '#F2F6FA'];
  for (const k of ['bg', 'rth', 'axisLine', 'divider', 'cross', 'axisText', 'axisTextStrong', 'tagFill', 'tagBorder', 'tagText', 'exit', 'live'])
    assert.ok(!v1.includes(T[k].toUpperCase()), k + ' is still V1: ' + T[k]);
  // the engine's own controls (Jump to live, the padlock, the divider, the Colors panel's fallbacks): gold, never purple
  const css = /const CSS = `([\s\S]*?)`;/.exec(read('src/chart-engine.js'))[1];
  assert.doesNotMatch(css, /#B69CFF|#1A1230|#3B2A6B|#D8CCFF|#6D28D9|#7B5CFF|182,156,255/i);
  assert.match(css, /\.ce-live\{[^}]*color:#E2C687/);
  // the chrome on another ground: V2's surfaces lifted, the gold accents at 4.5:1
  for (const bg of ['#000000', '#1B2433', '#F5F7FA']) {
    const v = U.chromeColors(U.buildTheme({ bg }));
    const r = U.parseColor(v['--accent-text']);
    assert.ok(r.r > r.b && r.g > r.b, bg + ' the accent is gold: ' + v['--accent-text']);
  }
});

/* ---------------------------------------------------------------- the page chrome */
const CHROME = ['live/live.css', 'live/workspace.css', 'live/accounts.css', 'live/bot.css', 'live/agents-strip.css', 'live/league.css',
  'live/multi-account.css', 'live/pin.css', 'live/markup.css', 'live/motion.css', 'live/agent.css'];
const V1 = /#6D28D9|#B69CFF|#A98BFF|#1A1230|#3B2A6B|#D8CCFF|#9F1239|#E0445E|#D0314F|#7B5CFF|#2A1F4D|#C8102E|#8B7CF6|rgba\(\s*(109,\s*40,\s*217|123,\s*92,\s*255|182,\s*156,\s*255|91,\s*61,\s*255)/i;

test('no V1 purple or crimson left in the page chrome (the indicator swatches excepted: those colors are unchanged)', () => {
  for (const f of CHROME) {
    const lines = read(f).replace(/\/\*[\s\S]*?\*\//g, '').split('\n');
    for (const l of lines) {
      if (!V1.test(l)) continue;
      // the swatches of indicators whose default color did not change (VWAP, RSI, the bear candle's text)
      const rest = l.replace(/--vwap-sw: #B69CFF;|--rsi-sw: #D8CCFF;/g, '');
      assert.ok(!V1.test(rest), f + ': ' + l.trim());
    }
  }
  for (const f of ['live/live.js', 'live/pin.js', 'live/markup.js', 'live/agents-sky.js'])
    assert.doesNotMatch(read(f), /#FFE4EA|#2A1F4D|#a77bff|rgba\(167,123,255|rgba\(91,61,255|rgba\(200,185,255/i, f);
  // the logo: a black tile with a gold glyph and a gold border glow; the wordmark gold
  assert.match(read('live/live.js'), /stroke="#E2C687"/);
  assert.match(read('live/pin.js'), /stroke="#E2C687"/);
  const live = read('live/live.css');
  assert.match(live, /--crimson: #C9A55C; --crimson-word: #E2C687;/, 'Armed and the wordmark: gold (V1 names kept)');
  assert.match(live, /\.chart-live \.logo \{[^}]*border: 1px solid rgba\(201, 165, 92, \.28\)/);
  // green and red only for P&L and trade side: the room meter's red is the loss red, not crimson
  assert.match(read('live/accounts.css'), /\.apg-bar\.apg-red \{ background: #FF7A7A; \}/);
});

/* ---------------------------------------------------------------- motion */
/* The rules of a stylesheet, as { sel, body, media } (@media blocks opened one level; @keyframes and the like skipped). */
function rules(css, media) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let i = 0, start = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const pre = css.slice(start, open).trim();
    let depth = 1, k = open + 1;
    while (k < css.length && depth) { if (css[k] === '{') depth++; else if (css[k] === '}') depth--; k++; }
    const inner = css.slice(open + 1, k - 1);
    if (/^@media/.test(pre)) out.push(...rules(inner, pre.replace(/^@media\s*/, '')));
    else if (!/^@/.test(pre)) out.push({ sel: pre.replace(/^[;\s]+/, ''), body: inner, media: media || '' });
    i = start = k;
  }
  return out;
}
/* a selector list split on its top-level commas (not those inside :not() or :has()) */
const sels = list => { const out = []; let depth = 0, cur = ''; for (const ch of list) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && !depth) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
const moves = body => /(?:^|;)\s*(transition|animation)(?:-[a-z]+)?\s*:\s*(?!none\b|0s?\b)/.test(body);
/* What holds a live value or fires an order (R3 and V2's limits): the order bar and its buttons, Armed, the ticket, Flatten,
   the chart (its canvas, the engine's controls), the tape, the quote board, the account panel and page, positions and P&L. */
const LIVE = /\.obar|\.obtn|\.arm\b|\.tk|ticket|\.ws-flat|\.chart-live(?![^,]*\.(ind-|ce-theme-panel|pr-pick))|\.ce-canvas|\.tp-|\.gr\b|\.gr-|\.ac-|\.apg|\.qb|\.pos\b|\.pnl|\.ma-|\.as-|\.bt-|\.ag-|\.lg-/;

test('motion: every V2 transition and animation is off with reduced motion, and none is on a live value or an order control', () => {
  for (const f of ['live/live.css', 'live/workspace.css', 'live/markup.css', 'live/pin.css']) {
    const css = read(f), v2 = css.indexOf('V2');
    assert.ok(v2 > 0, f + ' has a V2 part');
    for (const r of rules(css)) {
      if (!moves(r.body)) continue;
      const isV2 = /prefers-reduced-motion:\s*no-preference/.test(r.media);
      if (!isV2) continue;
      // with reduced motion (the system's) none of these applies; with the page's Less motion (motion-off) neither
      for (const s of sels(r.sel)) assert.match(s.trim(), /^:root:not\(\.motion-off\) /, f + ': ' + s.trim() + ' runs with the page\'s Less motion');
      // never on a live value or an order control
      for (const s of sels(r.sel)) assert.doesNotMatch(s.replace(':root:not(.motion-off) ', '').replace(/:not\([^)]*\)/g, ''), LIVE, f + ': motion on a live part: ' + s.trim());
      // a motion never waits to start and never takes the pointer away
      assert.doesNotMatch(r.body, /(transition|animation)-delay|pointer-events:\s*none/, f + ': ' + r.sel);
    }
  }
  // every V2 motion rule sits inside @media (prefers-reduced-motion: no-preference): nothing outside it moves but what
  // moved before 1.39.0 (checked against the rules that animate outside it, which must not name V2's keyframes or ease)
  for (const f of ['live/live.css', 'live/workspace.css', 'live/markup.css', 'live/pin.css']) {
    for (const r of rules(read(f))) if (!/no-preference/.test(r.media)) assert.doesNotMatch(r.body, /animation(?:-name)?\s*:[^;]*\b(v2-[a-z-]+|cb-pin-rise)\b|transition\s*:[^;]*(cubic-bezier\(\.22, 1, \.36, 1\)|var\(--(ws|ms|v2)-ease\))/, f + ': ' + r.sel + ' moves with reduced motion');
  }
  // the order dialogs (the group entry, Flatten every account, Order Strategies) appear at once
  assert.match(read('live/workspace.css'), /\.ws-dialog\[open\]:not\(:has\(\.ws-gq, \.ws-fe, \.ws-sg\)\) \{ animation: v2-rise/);
  // the Armed switch's state: no V2 motion added (its knob's 0.12 s of 1.13.0 is the only motion it has)
  for (const r of rules(read('live/live.css'))) if (/\.arm\b/.test(r.sel) && moves(r.body)) assert.equal(r.sel, '.chart-live .arm .knob::after');
});

test('motion: the chart\'s own feel is unchanged (Anthony trades on it): zoom 75, fit 120, candle 55, follow 110, friction 325 ms', () => {
  assert.match(read('src/chart-engine.js'), /motion: Object\.assign\(\{ zoom: 75, fit: 120, candle: 55, follow: 110, friction: 325 \}, opt\.motion \|\| \{\}\)/);
  assert.match(read('live/live.js'), /const GLIDE = \{ smooth: \{ candle: 55, fit: 120, follow: 110 \}, fast: \{ candle: 20, fit: 60, follow: 60 \}, off: \{ candle: 0, fit: 0, follow: 0 \} \};/);
});

test('motion: the tab ink (ChartMotion.syncInk) follows the chosen tab at once, never takes a click, and is still with reduced motion', () => {
  const M = require('../live/motion.js');
  assert.equal(typeof M.syncInk, 'function');
  // a tiny stand-in DOM: a bar of three tabs, the second chosen
  const mkEl = (cls, attrs, box) => {
    const el = { children: [], classList: null, style: {}, attrs: Object.assign({}, attrs), offsetLeft: box ? box[0] : 0, offsetTop: box ? box[1] : 0, offsetWidth: box ? box[2] : 0, offsetHeight: box ? box[3] : 0,
      getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = String(v); },
      matches(sel) { return sel.split(',').some(s => { const m = /\[([a-z-]+)="([^"]*)"\]/.exec(s.trim()); return m && this.attrs[m[1]] === m[2]; }); },
      closest() { return null; }, querySelector() { return null; },
      insertBefore(n, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? 0 : i, 0, n); n.parentNode = this; } };
    const set = new Set(cls ? cls.split(' ') : []);
    el.classList = { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)), list: set };
    Object.defineProperty(el, 'className', { get: () => [...set].join(' '), set: v => { set.clear(); for (const c of String(v).split(' ').filter(Boolean)) set.add(c); } });
    Object.defineProperty(el, 'firstChild', { get() { return this.children[0] || null; } });
    return el;
  };
  const bar = mkEl('ms-tabs', {}, null);
  bar.ownerDocument = { createElement: () => mkEl('', {}, null) };
  bar.children.push(mkEl('', { 'aria-selected': 'false' }, [4, 2, 50, 20]), mkEl('', { 'aria-selected': 'true' }, [56, 2, 40, 20]), mkEl('', { 'aria-selected': 'false' }, [98, 2, 44, 20]));
  const kit = M.create({ matchMedia: () => ({ matches: false }), storage: { getItem: () => null, setItem() {} }, document: null, raf: null });
  const ink = kit.syncInk(bar, { key: 't' });
  assert.ok(ink && ink.classList.contains('v2-ink'));
  assert.equal(ink.style.transform, 'translate(56px, 2px)'); assert.equal(ink.style.width, '40px');
  assert.ok(bar.classList.contains('has-ink'));
  assert.equal(ink.attrs['aria-hidden'], 'true');
  assert.equal(ink.classList.contains('still'), false, 'it slides');
  // a new choice: the ink goes there in the same call (the tab already acted on its click)
  assert.equal(bar.children[0], ink, 'the ink sits under the tabs, first in the bar');
  bar.children[2].attrs['aria-selected'] = 'false'; bar.children[3].attrs['aria-selected'] = 'true';
  assert.equal(kit.syncInk(bar, { key: 't' }), ink, 'the same ink, moved');
  assert.equal(ink.style.transform, 'translate(98px, 2px)'); assert.equal(ink.style.width, '44px');
  // reduced motion: placed with no transition (class still)
  const calm = M.create({ matchMedia: () => ({ matches: true }), storage: { getItem: () => null, setItem() {} }, document: null, raf: null });
  const bar2 = mkEl('', {}, null); bar2.ownerDocument = bar.ownerDocument;
  bar2.children.push(mkEl('', { 'aria-pressed': 'true' }, [0, 0, 30, 20]));
  assert.ok(calm.syncInk(bar2).classList.contains('still'));
  // the ink never takes the pointer, and its CSS slides only while motion is on
  const css = read('live/motion.css');
  assert.match(css, /\.v2-ink \{[^}]*pointer-events: none;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.v2-ink \{ transition: none; \} \}/);
  assert.match(css, /:root\.motion-off \.v2-ink \{ transition: none; \}/);
  // never on a bar inside a no-motion part (an order surface, data-no-motion)
  const blocked = mkEl('', {}, null); blocked.closest = () => ({}); blocked.ownerDocument = bar.ownerDocument;
  blocked.children.push(mkEl('', { 'aria-selected': 'true' }, [0, 0, 30, 20]));
  assert.equal(kit.syncInk(blocked), null);
});
