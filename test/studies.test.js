'use strict';
// The studies (1.34.0, Anthony 2026-10-20: "add some more indicator options. Like EMA's SMA's - maybe RSI"; his picks EMA,
// SMA, Bollinger Bands and RSI): the math against values worked out by hand, the chart's kept values against a whole
// computation as bars come, nothing drawn with too few bars, the lower pane split with the delta pane, and the menu's
// entries, options and colors. Made-up bars only, never market data.
const test = require('node:test');
const assert = require('node:assert/strict');
const CE = require('../src/chart-engine.js');
const { LivePrefs: LP } = require('../live/live.js');
const U = CE.util;

const near = (a, b, eps, msg) => {
  if (a === null || b === null) { assert.equal(a, b, msg); return; }
  assert.ok(Math.abs(a - b) <= (eps || 1e-9), (msg || '') + ': ' + a + ' vs ' + b);
};
const nearAll = (got, want, eps, msg) => { assert.equal(got.length, want.length, msg); got.forEach((v, i) => near(v, want[i], eps, (msg || '') + ' [' + i + ']')); };
const C = [1, 2, 3, 4, 5, 4, 3, 4, 5, 6];

test('SMA: the average of the last len closes, none before len bars', () => {
  nearAll(U.smaSeries(C, 3), [null, null, 2, 3, 4, 13 / 3, 4, 11 / 3, 4, 5]);
  nearAll(U.smaSeries(C, 1), C);
  assert.deepEqual(U.smaSeries(C, 11), C.map(() => null), 'not enough bars: nothing');
  assert.deepEqual(U.smaSeries([], 3), []);
});

test('EMA: seeded with the SMA of the first len closes, then prev + (close - prev) x 2 / (len + 1)', () => {
  // len 3: k = 0.5, so every value is exact: 2 (the seed), 3, 4, 4, 3.5, 3.75, 4.375, 5.1875
  assert.deepEqual(U.emaSeries(C, 3), [null, null, 2, 3, 4, 4, 3.5, 3.75, 4.375, 5.1875]);
  // the textbook form alpha x close + (1 - alpha) x prev, worked out separately, on a longer made-up series
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const c = []; let p = 20000; for (let i = 0; i < 600; i++) { p += Math.round((rnd() - 0.5) * 16) * 0.25; c.push(p); }
  for (const len of [5, 9, 21, 200]) {
    const a = 2 / (len + 1), want = [];
    for (let i = 0; i < c.length; i++) {
      if (i < len - 1) want.push(null);
      else if (i === len - 1) want.push(c.slice(0, len).reduce((s, x) => s + x, 0) / len);
      else want.push(a * c[i] + (1 - a) * want[i - 1]);
    }
    nearAll(U.emaSeries(c, len), want, 1e-7, 'EMA ' + len);
  }
  assert.deepEqual(U.emaSeries([1, 2], 3), [null, null], 'not enough bars: nothing');
});

test('Bollinger Bands: SMA(len) plus and minus dev population standard deviations over the same closes', () => {
  const b = U.bollinger(C, 4, 2);
  assert.deepEqual(b.slice(0, 3), [null, null, null]);
  // bar 3: closes 1 2 3 4, mean 2.5, variance (2.25 + 0.25 + 0.25 + 2.25) / 4 = 1.25
  near(b[3].mid, 2.5); near(b[3].up, 2.5 + 2 * Math.sqrt(1.25)); near(b[3].lo, 2.5 - 2 * Math.sqrt(1.25));
  // bar 5: closes 3 4 5 4, mean 4, variance (1 + 0 + 1 + 0) / 4 = 0.5
  near(b[5].mid, 4); near(b[5].up, 4 + 2 * Math.sqrt(0.5)); near(b[5].lo, 4 - 2 * Math.sqrt(0.5));
  const flat = U.bollinger([7, 7, 7], 3, 2.5)[2];
  assert.deepEqual([flat.mid, flat.up, flat.lo], [7, 7, 7], 'no spread: the bands on the basis');
  near(U.bollinger(C, 4, 1.5)[5].up, 4 + 1.5 * Math.sqrt(0.5), 1e-12, 'the deviations');
});

test('RSI: Wilder\'s, the first averages simple over len changes, then (prev x (len - 1) + this) / len', () => {
  // changes +1 +1 +1 +1 -1 -1 +1 +1 +1; len 3
  const r = U.rsiSeries(C, 3);
  assert.deepEqual(r.slice(0, 3), [null, null, null], 'the first at bar len');
  near(r[3], 100, 0, 'gains only');
  near(r[4], 100);
  near(r[5], 100 - 100 / (1 + 2));                               // g 2/3, l 1/3
  near(r[6], 100 - 100 / (1 + 0.8));                             // g 4/9, l 5/9
  near(r[7], 100 - 100 / (1 + 17 / 10));                         // g 17/27, l 10/27
  assert.deepEqual(U.rsiSeries([5, 5, 5, 5], 2), [null, null, 50, 50], 'no change at all: 50');
  assert.deepEqual(U.rsiSeries([5, 4, 3], 2), [null, null, 0], 'losses only: 0');
  assert.deepEqual(U.rsiSeries([1, 2, 3], 3), [null, null, null], 'not enough bars: nothing');
  for (const v of U.rsiSeries(Array.from({ length: 300 }, (x, i) => 100 + Math.sin(i / 7) * 5 + (i % 3)), 14)) assert.ok(v === null || (v >= 0 && v <= 100));
});

/* ---- the chart on a stand-in canvas (as test/delta.test.js) */
function stubChart(nBars) {
  const ops = [], children = [];
  class Path2D { constructor() { this.rects = []; } rect(x, y, w, h) { this.rects.push([x, y, w, h]); } moveTo() {} lineTo() {} closePath() {} arc() {} }
  let path = 0;
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return s => ({ width: String(s).length * 7 });
      if (k === 'beginPath') return () => { path = 0; };
      if (k === 'lineTo') return () => { path++; };
      if (k === 'fill') return p => ops.push({ op: 'fill', color: t.fillStyle, path: p });
      if (k === 'fillRect') return (x, y, w, h) => ops.push({ op: 'rect', color: t.fillStyle, r: [x, y, w, h] });
      if (k === 'fillText') return (s, x, y) => ops.push({ op: 'text', s: String(s), x, y });
      if (k === 'stroke') return () => ops.push({ op: 'stroke', color: t.strokeStyle, segs: path, dash: t._dash || [] });
      if (k === 'setLineDash') return d => { t._dash = d; };
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const W = 1366, H = 700, box = { width: W, height: H };
  const element = () => {
    const attrs = {};
    return {
      handlers: {}, style: {}, dataset: {}, hidden: false, textContent: '', tabIndex: -1, className: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener(type, fn) { this.handlers[type] = fn; }, removeEventListener(type) { delete this.handlers[type]; },
      appendChild(c) { children.push(c); return c; }, remove() {}, setAttribute(k, v) { attrs[k] = String(v); }, getAttribute: k => attrs[k], hasAttribute() { return false; },
      getContext: () => ctx, focus() {}, setPointerCapture() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: box.width, height: box.height, right: box.width, bottom: box.height }),
    };
  };
  let frameFn = null;
  global.document = { createElement: element, getElementById: () => null, head: { appendChild() {} } };
  global.window = { devicePixelRatio: 1 };
  global.requestAnimationFrame = fn => { frameFn = fn; return 1; };
  global.cancelAnimationFrame = () => { frameFn = null; };
  global.Path2D = Path2D;
  global.ResizeObserver = class { constructor(fn) { fn([]); } observe() {} disconnect() {} };
  delete require.cache[require.resolve('../src/chart-engine.js')];
  const E = require('../src/chart-engine.js');
  const T0 = Date.UTC(2026, 9, 19, 10, 0) / 1000, bars = [];
  for (let i = 0; i < nBars; i++) { const c = 20000 + Math.round(Math.sin(i / 9) * 40 + (i % 5)) * 0.25; bars.push({ t: T0 + i * 60, o: c - 0.5, h: c + 1, l: c - 1, c, v: 100, vw: c }); }
  const chart = E.create(element(), { clock: () => bars[bars.length - 1].t + 30 });
  chart.setBars(bars);
  let ts = 1000;
  const frame = () => { ops.length = 0; const f = frameFn; frameFn = null; if (f) f(ts += 16); };
  const settle = () => { for (let i = 0; i < 40; i++) frame(); };
  const redraw = () => { chart.setLayers({}); frame(); };
  return { E, chart, ops, bars, T0, W, H, frame, settle, redraw, divider: children.find(c => c.className === 'ce-divider') };
}
const ALL_ON = { ema: true, sma: true, bands: true, rsi: true };
/* What a whole computation gives at every bar, from the closes. */
function whole(closes, st) {
  return {
    ema: st.ema.map(len => (len ? U.emaSeries(closes, len) : closes.map(() => null))),
    sma: st.sma.map(len => (len ? U.smaSeries(closes, len) : closes.map(() => null))),
    bands: U.bollinger(closes, st.bands.len, st.bands.dev), rsi: U.rsiSeries(closes, st.rsi.len),
  };
}
function sameAsWhole(chart, closes, label) {
  const st = chart.getStudies(), w = whole(closes, st);
  for (let i = 0; i < closes.length; i++) {
    const a = chart.studiesAt(i);
    for (let k = 0; k < 3; k++) { assert.equal(a.ema[k], w.ema[k][i], label + ' ema' + k + ' @' + i); assert.equal(a.sma[k], w.sma[k][i], label + ' sma' + k + ' @' + i); }
    assert.deepEqual(a.bands, w.bands[i], label + ' bands @' + i);
    assert.equal(a.rsi, w.rsi[i], label + ' rsi @' + i);
  }
}

test('chart: the kept values and the forming bar worked out again equal a whole computation, tick by tick and bar by bar', () => {
  const { chart, bars, settle, frame } = stubChart(400);
  chart.setLayers(ALL_ON); chart.setStudies({ ema: [9, 21, 55] }); settle();
  const closes = bars.map(b => b.c);
  sameAsWhole(chart, closes, 'loaded');
  // ticks on the forming bar, then new bars: the same as everything worked out again (exactly, the same arithmetic)
  let t = bars[bars.length - 1].t;
  for (let k = 0; k < 30; k++) {
    const last = closes[closes.length - 1], c = last + (k % 3 - 1) * 0.75;
    if (k % 4 === 3) { t += 60; closes.push(c); } else closes[closes.length - 1] = c;
    chart.update({ t, o: c, h: c + 1, l: c - 1, c, v: 10 });
    frame();
    sameAsWhole(chart, closes, 'tick ' + k);
  }
  // an option changed: all again
  chart.setStudies({ sma: [10, 0, 34], bands: { len: 10, dev: 1.5 }, rsi: { len: 7, lo: 20, hi: 80 } }); frame();
  sameAsWhole(chart, closes, 'options');
  // the bars replaced (a history load, another bar type): all again from the new bars
  const fresh = closes.slice(0, 250).map((c, i) => ({ t: bars[0].t + i * 300, o: c, h: c + 2, l: c - 2, c: c + (i % 7) * 0.25, v: 5 }));
  chart.setBars(fresh); frame();
  sameAsWhole(chart, fresh.map(b => b.c), 'replaced');
});

test('chart: nothing drawn until there are enough bars, and only the studies whose layer is on', () => {
  const { chart, ops, redraw } = stubChart(15);
  chart.setLayers({ ema: true, sma: true, bands: true }); redraw();
  const T = chart.colors(), strokes = c => ops.filter(o => o.op === 'stroke' && o.color === c);
  assert.ok(strokes(T.ema1).length === 1 && strokes(T.ema1)[0].segs > 0, 'EMA 9 drawn with 15 bars');
  assert.equal(strokes(T.ema2)[0].segs, 0, 'EMA 21 has no point with 15 bars');
  assert.ok(strokes(T.sma1).every(s => s.segs === 0) && strokes(T.sma2).every(s => s.segs === 0), 'SMA 20 and 50: nothing');
  assert.ok(strokes(T.bands).every(s => s.segs === 0), 'Bollinger 20: nothing');
  assert.ok(!ops.some(o => o.op === 'fill' && typeof o.color === 'string' && o.color.startsWith('rgba(') && o.color.endsWith(',0.07)')), 'no fill');
  assert.equal(chart.studiesAt(14).ema[1], null);
  chart.setStudies({ ema: [9, 0, 0] }); chart.setLayers({ ema: false, sma: false, bands: false }); redraw();
  assert.equal(strokes(T.ema1).length, 0, 'off: not drawn');
  assert.equal(chart.studiesAt(0), null, 'none on: none worked out');
  // the RSI's pane says nothing with too few bars
  chart.setLayers({ rsi: true }); chart.setStudies({ rsi: { len: 14 } }); redraw();
  assert.ok(chart.rsiPane().value !== null, '15 bars: an RSI 14 at the newest');
  chart.setStudies({ rsi: { len: 21 } }); redraw();
  assert.equal(chart.rsiPane().value, null);
  assert.ok(ops.some(o => o.op === 'text' && o.s === 'RSI 21'), 'its title');
  assert.ok(!ops.some(o => o.op === 'stroke' && o.color === T.rsi && o.segs > 0), 'no line');
});

test('chart: the bands\' basis is dashed and its fill faint; the MAs solid, each in its own color', () => {
  const { chart, ops, redraw } = stubChart(300);
  chart.setLayers({ ema: true, sma: true, bands: true }); redraw();
  const T = chart.colors(), one = c => ops.find(o => o.op === 'stroke' && o.color === c);
  for (const k of ['ema1', 'ema2', 'sma1', 'sma2', 'sma3']) assert.ok(one(T[k]) && one(T[k]).segs > 50 && !one(T[k]).dash.length, k);
  assert.equal(ops.filter(o => o.op === 'stroke' && o.color === T.ema3).length, 0, 'EMA line 3 off by default');
  assert.deepEqual(one(T.bandsBasis).dash, [4, 3]);
  assert.equal(ops.filter(o => o.op === 'stroke' && o.color === T.bands).length, 2, 'the upper and lower band');
  assert.ok(ops.some(o => o.op === 'fill' && o.color === U.rgba(T.bandsFill, 0.07)), 'the fill');
  chart.setStudies({ bands: { basis: false, fill: false } }); redraw();
  assert.ok(!one(T.bandsBasis) && !ops.some(o => o.op === 'fill' && o.color === U.rgba(T.bandsFill, 0.07)), 'basis and fill off');
  // setStudies keeps what is allowed only
  chart.setStudies({ ema: [0, -3, 'x'], sma: [2.5, 1001, 30], bands: { len: 1, dev: 0 }, rsi: { len: 0, lo: 80, hi: 20 } });
  assert.deepEqual(chart.getStudies(), { ema: [0, 21, 0], sma: [20, 50, 30], bands: { len: 20, dev: 2, basis: false, fill: false }, rsi: { len: 14, lo: 30, hi: 70 } });
});

test('chart: the lower pane: the delta on top and the RSI under it, PANE_GAP apart and the height split evenly; alone, either takes it all', () => {
  const { E, chart, redraw, H, divider } = stubChart(200);
  const area = H - 26;
  chart.setLayers({ rsi: true }); redraw();
  let r = chart.rsiPane(), d = chart.deltaPane();
  assert.ok(r.on && !d.on && r.height > 100 && Math.abs(r.height - area * E.PANE_RATIO) <= 1, 'RSI alone: the whole lower pane, ' + r.height + ' px');
  assert.equal(r.top, d.plotHeight + E.PANE_GAP);
  assert.equal(r.top + r.height, area);
  assert.equal(divider.hidden, false);
  assert.ok(/^Lower pane height/.test(divider.getAttribute('aria-label')), 'not "Delta pane": ' + divider.getAttribute('aria-label'));
  assert.ok(r.value >= 0 && r.value <= 100);
  assert.ok(Math.abs(chart.rsiToY(100) - (r.top + 8)) < 1e-9 && Math.abs(chart.rsiToY(0) - (r.top + r.height - 8)) < 1e-9, 'a fixed 0 to 100 scale');
  chart.setLayers({ delta: true }); redraw();
  r = chart.rsiPane(); d = chart.deltaPane();
  assert.ok(r.on && d.on);
  assert.equal(d.top, d.plotHeight + E.PANE_GAP, 'the delta on top');
  assert.equal(r.top, d.top + d.height + E.PANE_GAP, 'the RSI under it, PANE_GAP apart');
  assert.equal(r.top + r.height, area, 'down to the time axis');
  assert.ok(Math.abs(r.height - d.height) <= 1, 'split evenly: ' + d.height + ' and ' + r.height);
  assert.ok(Math.abs(chart.deltaToY(d.lo) - (d.top + d.height)) < 1e-6, 'deltaToY in the delta\'s own part');
  chart.setLayers({ rsi: false }); redraw();
  d = chart.deltaPane(); r = chart.rsiPane();
  assert.ok(d.on && !r.on && r.height === 0 && Math.abs(d.height - area * E.PANE_RATIO) <= 1, 'the delta alone takes it all back');
  assert.ok(/^Delta pane height/.test(divider.getAttribute('aria-label')));
  chart.setLayers({ delta: false }); redraw();
  assert.equal(divider.hidden, true);
  assert.equal(chart.deltaPane().plotHeight, area, 'neither: the chart takes the height back');
});

/* ---- the menu's entries, options and colors (LivePrefs) */
test('registry: the four are off by default on every pane, also on one saved before they existed', () => {
  for (const id of ['ema', 'sma', 'bands', 'rsi']) {
    assert.equal(LP.DEFAULT_INDICATORS[id], false, id); assert.equal(LP.NEW_PANE_INDICATORS[id], false, id);
    assert.deepEqual(LP.defaultPane('main').ind[id], { on: false, shown: true, pin: false });
    const old = LP.cleanPane({ ind: { vwap: { on: true, shown: true, pin: true } }, recent: [], restore: null }, 'main');
    assert.equal(old.ind[id].on, false, 'a 1.33 save: ' + id + ' off');
    assert.equal(LP.cleanPane(null, 'pane-3').ind[id].on, false);
  }
  const d = id => LP.INDICATORS.find(x => x.id === id);
  assert.deepEqual(['ema', 'sma', 'bands', 'rsi'].map(id => [d(id).name, d(id).code, d(id).short, d(id).letter, d(id).cat]),
    [['EMA', 'EM', 'EMA', 'E', 'price'], ['SMA', 'SM', 'SMA', 'S', 'price'], ['Bollinger Bands', 'BO', 'BANDS', 'O', 'price'], ['RSI', 'RS', 'RSI', 'R', 'momentum']]);
  assert.equal(new Set(LP.INDICATORS.map(x => x.code)).size, LP.INDICATORS.length, 'the slim header\'s codes: all different');
  assert.equal(new Set(LP.INDICATORS.map(x => x.letter)).size, LP.INDICATORS.length);
  assert.ok(LP.CATEGORIES.some(c => c.id === 'momentum' && c.name === 'Momentum'));
  for (const id of ['ema', 'sma', 'bands', 'rsi']) assert.ok(!/[\u2013\u2014]/.test(d(id).opt + d(id).alias), 'no en or em dash');
});

test('registry: the options, the default first, and saved values cleaned', () => {
  const O = LP.INDICATOR_OPTIONS, L = ['5', '8', '9', '10', '12', '13', '20', '21', '26', '34', '50', '55', '89', '100', '144', '200'];
  assert.deepEqual(O.ema.len1, ['9'].concat(L.filter(v => v !== '9')), 'the first line: no off');
  assert.deepEqual(O.ema.len2, ['21', 'off'].concat(L.filter(v => v !== '21')));
  assert.deepEqual(O.ema.len3, ['off'].concat(L));
  assert.deepEqual(O.sma.len1, ['20'].concat(L.filter(v => v !== '20')));
  assert.deepEqual(O.sma.len2, ['50', 'off'].concat(L.filter(v => v !== '50')));
  assert.deepEqual(O.sma.len3, ['200', 'off'].concat(L.filter(v => v !== '200')));
  for (const id of ['ema', 'sma']) for (const k of ['len1', 'len2', 'len3']) assert.equal(new Set(O[id][k]).size, O[id][k].length, id + ' ' + k + ': no value twice');
  assert.deepEqual(O.bands, { len: ['20', '10', '14', '30', '50'], dev: ['2', '1.5', '2.5', '3'], basis: ['on', 'off'], fill: ['on', 'off'] });
  assert.deepEqual(O.rsi, { len: ['14', '2', '5', '7', '9', '21', '28'], levels: ['30/70', '20/80', '25/75', '40/60'] });
  assert.deepEqual(LP.cleanIndicatorOptions('ema', { len1: 'off', len2: '7', len3: '200', junk: 1 }), { len1: '9', len2: '21', len3: '200' });
  assert.deepEqual(LP.cleanIndicatorOptions('rsi', { len: 14, levels: '20/80' }), { len: '14', levels: '20/80' }, 'strings only');
  assert.equal(LP.indicatorOptionAllowed('sma', 'len3', 'off'), true);
  assert.equal(LP.indicatorOptionAllowed('sma', 'len1', 'off'), false);
  // what the chart is told
  const opts = Object.fromEntries(Object.keys(O).map(id => [id, LP.cleanIndicatorOptions(id, null)]));
  assert.deepEqual(LP.studiesOf(opts), CE.STUDY_DEFAULTS, 'the defaults are the engine\'s');
  opts.ema.len2 = 'off'; opts.bands.fill = 'off'; opts.bands.dev = '1.5'; opts.rsi.levels = '25/75';
  const s = LP.studiesOf(opts);
  assert.deepEqual([s.ema, s.bands.fill, s.bands.dev, s.rsi.lo, s.rsi.hi], [[9, 0, 0], false, 1.5, 25, 75]);
  // per pane, saved and read back
  const store = new Map(), p = LP.create({ getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) });
  assert.equal(p.setIndicatorOption('pane-2', 'ema', 'len3', '200'), true);
  assert.equal(p.setIndicatorOption('pane-2', 'ema', 'len1', 'off'), false);
  assert.deepEqual(p.indicatorOptions('pane-2', 'ema'), { len1: '9', len2: '21', len3: '200' });
  assert.deepEqual(p.indicatorOptions('main', 'ema'), { len1: '9', len2: '21', len3: 'off' });
});

test('colors: one per line, distinct from each other and from the VWAP, none green, red or crimson, each reading on a white chart', () => {
  const keys = ['ema1', 'ema2', 'ema3', 'sma1', 'sma2', 'sma3', 'bands', 'bandsBasis', 'rsi', 'rsiLevels'];
  const byId = id => LP.INDICATOR_COLORS.filter(c => c.id === id).map(c => c.key);
  assert.deepEqual([byId('ema'), byId('sma'), byId('bands'), byId('rsi')], [['ema1', 'ema2', 'ema3'], ['sma1', 'sma2', 'sma3'], ['bands', 'bandsBasis', 'bandsFill'], ['rsi', 'rsiLevels']]);
  const D = CE.DEFAULT_THEME;
  for (const k of byId('ema').concat(byId('sma'), byId('bands'), byId('rsi'))) {
    assert.equal(LP.INDICATOR_COLORS.find(c => c.key === k).def, D[k], k + ': the engine\'s house color');
    assert.ok(LP.IND_COLOR_LATER.includes(k), k + ': an indicator preset saved before keeps working');
  }
  const lines = ['ema1', 'ema2', 'ema3', 'sma1', 'sma2', 'sma3', 'bands'];
  assert.ok(U.distinct(D.rsi, D.vwap), 'the RSI a step lighter than the VWAP');
  // on the house grounds every line of the plot stays apart from the others and from the VWAP, as moved to read there
  for (const bg of ['#080B10', '#000000', '#1B2433', '#F5F7FA', '#FFFFFF']) {
    const T = U.buildTheme({ bg }), all = lines.concat('bandsBasis', 'vwap');
    for (const a of all) for (const b of all) if (a < b) assert.ok(U.distinct(T[a], T[b]), a + ' and ' + b + ' apart on ' + bg + ': ' + T[a] + ' ' + T[b]);
    assert.ok(U.distinct(T.rsi, T.rsiLevels), 'the RSI apart from its levels on ' + bg);
  }
  for (const a of lines) {
    assert.ok(U.distinct(D[a], D.vwap), a + ' apart from the VWAP');
    for (const b of lines) if (a < b) assert.ok(U.distinct(D[a], D[b]), a + ' apart from ' + b);
    for (const no of [D.long, D.short, '#9F1239', '#E0445E']) assert.ok(U.distinct(D[a], no), a + ' is not a trade side or crimson');
    const c = U.parseColor(D[a]);
    assert.ok(!(c.g > c.r + 40 && c.g > c.b + 40), a + ' is not green');
  }
  for (const bg of ['#080B10', '#F5F7FA', '#FFFFFF', '#000000', '#1B2433']) {
    const T = U.buildTheme({ bg });
    for (const k of keys) assert.ok(U.contrast(T[k], bg) >= CE.FLOOR.line - 0.01 || bg === '#080B10', k + ' on ' + bg + ': ' + U.contrast(T[k], bg).toFixed(2));
  }
  for (const k of keys) assert.ok(U.contrast(D[k], '#080B10') >= CE.FLOOR.line, k + ' on the house ground: ' + U.contrast(D[k], '#080B10').toFixed(2));
  // an indicator preset saved by 1.33 (none of the studies' colors) is kept, with their defaults
  const old = Object.fromEntries(LP.INDICATOR_COLORS.filter(c => !keys.includes(c.key) && c.key !== 'bandsFill').map(c => [c.key, c.def]));
  const kept = LP.cleanPresets({ chart: [], indicator: [{ id: 'p1', name: 'Mine', colors: old }] }).indicator;
  assert.equal(kept.length, 1);
  assert.equal(kept[0].colors.ema1, D.ema1.toUpperCase());
});
