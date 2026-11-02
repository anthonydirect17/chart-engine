'use strict';
// Fit stop and target (Unreleased, Anthony 2026-11-02: "an option to have the chart zoom out to fit the stop and target like
// it is now, but an option to toggle that off as well, maybe near the lock on the bottom right"): the engine's option and
// toggle on a stand-in canvas (on, the default: the scale takes in the stop and target; off: the scale fits the candles only
// and each line off it is a marker at the plot's right edge, at the top or bottom, with its price), and the per chart setting
// kept the way the price scale lock is (on unless switched off, so a layout saved before it fits as it always did).
const test = require('node:test');
const assert = require('node:assert/strict');
const { LivePrefs: LP } = require('../live/live.js');

const et = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s || 0) / 1000;   // New York wall clock stored as UTC
const W = 1078, H = 626, AXIS = 78, PLOT_W = W - AXIS;

function memStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

/* The chart on a stand-in canvas and DOM (as test/vp-draw.test.js): 200 one-minute bars between about 97 and 103. */
function stubChart(options) {
  const ops = [];
  class Path2D { constructor() { this.rects = []; } rect(x, y, w, h) { this.rects.push([x, y, w, h]); } moveTo() {} lineTo() {} closePath() {} arc() {} }
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return s => ({ width: String(s).length * 7 });
      if (k === 'fillText') return (s, x, y) => ops.push({ op: 'text', s: String(s), x, y, color: t.fillStyle });
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const made = [];
  const element = () => made[made.push({
    handlers: {}, style: {}, dataset: {}, attrs: {}, hidden: false, textContent: '', tabIndex: -1,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, fn) { this.handlers[type] = fn; }, removeEventListener(type) { delete this.handlers[type]; },
    appendChild(c) { return c; }, remove() {}, setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; }, hasAttribute() { return false; },
    getContext: () => ctx, focus() {}, setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H }),
  }) - 1];
  let frameFn = null;
  global.document = { createElement: element, getElementById: () => null, head: { appendChild() {} } };
  global.window = { devicePixelRatio: 1 };
  global.requestAnimationFrame = fn => { frameFn = fn; return 1; };
  global.cancelAnimationFrame = () => { frameFn = null; };
  global.Path2D = Path2D;
  delete require.cache[require.resolve('../src/chart-engine.js')];
  const E = require('../src/chart-engine.js');
  const bars = [];
  const T0 = et(2026, 9, 29, 10, 0);
  for (let i = 0; i < 200; i++) { const c = 100 + Math.sin(i / 9) * 2; bars.push({ t: T0 + i * 60, o: c - 0.5, h: c + 1, l: c - 1, c, v: 100, vw: c }); }
  const chart = E.create(element(), Object.assign({ clock: () => bars[bars.length - 1].t + 30, motion: { zoom: 0, fit: 0, candle: 0, follow: 0, friction: 0 } }, options || {}));
  chart.setBars(bars);
  let ts = 1000;
  const frame = () => { ops.length = 0; const f = frameFn; frameFn = null; if (f) f(ts += 16); };
  const frames = k => { for (let i = 0; i < (k || 6); i++) frame(); };
  return { E, chart, ops, bars, made, frame, frames };
}
/* A long position's stop above the view's candles' top and target below (or the other way): far off the candles */
const STOP = { id: 's1', side: 'sell', kind: 'stop', price: 120, qty: 1, role: 'stop' };
const TGT = { id: 't1', side: 'sell', kind: 'limit', price: 80, qty: 1, role: 'target' };

test('fit on (the default): the price scale takes in the stop and the target, no edge markers', () => {
  const { chart, frames } = stubChart();
  assert.equal(chart.fitOrders(), true, 'on by default');
  chart.setOrders([STOP, TGT]); frames();
  const ps = chart.priceScale();
  assert.ok(ps.hi >= 120 && ps.lo <= 80, 'both lines inside the scale: ' + ps.lo + ' to ' + ps.hi);
  assert.ok(chart.priceToY(120) >= 0 && chart.priceToY(80) <= ps.plotHeight);
  assert.deepEqual(chart.orderEdges(), [], 'nothing off the scale, no marker');
});

test('fit off: the scale fits the candles only, exactly as with no orders; each line off it a marker at the right edge with its price', () => {
  const ref = stubChart({ fitOrders: false }); ref.frames();
  const want = ref.chart.priceScale();
  const { chart, frame, frames, ops } = stubChart({ fitOrders: false });
  assert.equal(chart.fitOrders(), false, 'the option turns it off');
  chart.setOrders([STOP, TGT]); frames();
  const ps = chart.priceScale();
  assert.deepEqual([ps.lo, ps.hi], [want.lo, want.hi], 'the same scale as the candles alone');
  assert.ok(ps.hi < 110 && ps.lo > 90, 'the stop and target not taken in');
  const e = chart.orderEdges();
  assert.equal(e.length, 2, JSON.stringify(e));
  const [top, bot] = e;
  assert.deepEqual([top.id, top.up, top.price, top.text], ['s1', true, 120, 'STP 120.00'], 'the stop above: at the top');
  assert.deepEqual([bot.id, bot.up, bot.price, bot.text], ['t1', false, 80, 'TGT 80.00'], 'the target below: at the bottom');
  for (const m of e) assert.equal(m.x + m.w, PLOT_W - 6, 'right-aligned 6 px in from the price axis, as the VWAP marker');
  assert.equal(top.y, 4, 'top edge, 4 px in');
  assert.equal(bot.y + bot.h, ps.plotHeight - 4, 'bottom edge, 4 px in');
  chart.redraw(); frame();
  assert.ok(ops.some(o => o.op === 'text' && o.s === 'STP 120.00') && ops.some(o => o.op === 'text' && o.s === 'TGT 80.00'), 'both drawn');
  // on screen: no marker, the line as ever
  chart.setOrders([Object.assign({}, STOP, { price: 101 }), TGT]); frames();
  assert.deepEqual(chart.orderEdges().map(m => m.id), ['t1'], 'a line in view has no marker');
});

test('fit off: several lines off one edge stack, the farthest outermost, clear of the VWAP marker', () => {
  const { chart, frames } = stubChart({ fitOrders: false });
  chart.setLayers({ vwap: true });
  chart.setVwapSource(() => 150);                                  // a VWAP far above: its marker at the top
  chart.setOrders([STOP, Object.assign({}, STOP, { id: 's2', price: 130 })]); frames();
  const v = chart.vwapMarker(), e = chart.orderEdges();
  assert.ok(v && v.up, 'the VWAP marker at the top');
  assert.deepEqual(e.map(m => m.id), ['s2', 's1'], 'the farther one first');
  assert.equal(e[0].y, v.y + v.h + 2, 'under the VWAP marker');
  assert.equal(e[1].y, e[0].y + e[0].h + 2, 'then the nearer one');
});

test('the toggle: beside the lock, the same size, on by default; a click turns it off, says so, and the view no longer moves for the orders', () => {
  const { chart, made, frames } = stubChart();
  const lock = made.find(m => m.className === 'ce-lock'), fit = made.find(m => m.className === 'ce-fit');
  assert.ok(lock && fit, 'a lock and a fit toggle');
  assert.equal(lock.style.right, '13px', 'the two centred together in the 78 px corner');
  assert.equal(fit.style.right, '41px', 'the toggle left of the lock, 4 px between');
  assert.deepEqual([fit.attrs['aria-pressed'], fit.attrs['data-fit'], fit.attrs['aria-label']], ['true', 'on', 'Fit stop and target: on']);
  assert.match(fit.title, /^Fit stop and target: on\b/);
  chart.setOrders([STOP, TGT]); frames();
  assert.ok(chart.priceScale().hi >= 120);
  const got = []; chart.on('fitOrders', v => got.push(v));
  fit.handlers.click(); frames();
  assert.deepEqual([chart.fitOrders(), got], [false, [false]], 'a click turns it off and says so');
  assert.deepEqual([fit.attrs['aria-pressed'], fit.attrs['data-fit'], fit.attrs['aria-label']], ['false', 'off', 'Fit stop and target: off']);
  assert.match(fit.title, /^Fit stop and target: off\b/);
  assert.ok(chart.priceScale().hi < 110, 'the scale back to the candles');
  assert.equal(chart.orderEdges().length, 2);
  fit.handlers.click(); frames();
  assert.deepEqual([chart.fitOrders(), got], [true, [false, true]], 'and back on');
  assert.ok(chart.priceScale().hi >= 120 && chart.orderEdges().length === 0);
});

test('setFitOrders: no event (only a click emits); on again fits unless the lock is on; the toggle follows lockButton unless fitButton says, alone it sits centred', () => {
  const { chart, frames } = stubChart();
  const got = []; chart.on('fitOrders', v => got.push(v));
  chart.setOrders([STOP, TGT]);
  chart.setFitOrders(false); frames();
  assert.deepEqual(got, []);
  chart.setScaleLock(true);
  chart.setFitOrders(true); frames();
  assert.equal(chart.fitOrders(), true);
  const alone = stubChart({ lockButton: false, fitButton: true });
  assert.equal(alone.made.find(m => m.className === 'ce-fit').style.right, '27px');
  assert.equal(alone.made.find(m => m.className === 'ce-lock'), undefined);
  const lockOnly = stubChart({ fitButton: false });
  assert.equal(lockOnly.made.find(m => m.className === 'ce-lock').style.right, '27px', 'without the toggle the lock stays where it was');
  assert.equal(stubChart({ lockButton: false }).made.find(m => m.className === 'ce-fit'), undefined, 'no lock asked for: no toggle either, unless fitButton');
  const none = stubChart({ liveButton: false });
  assert.equal(none.made.find(m => m.className === 'ce-fit' || m.className === 'ce-lock'), undefined, 'a host without the corner controls gets neither');
});

test('Fit stop and target: saved per chart, on by default (a layout saved before it fits as it always did)', () => {
  const st = memStorage(), p = LP.create(st);
  assert.equal(LP.KEYS.fitOrders, 'live-fit-orders-v1');
  assert.equal(p.fitOrders('main'), true);
  assert.equal(p.setFitOrders('pane-2', false), true);
  assert.deepEqual([LP.create(st).fitOrders('pane-2'), LP.create(st).fitOrders('main')], [false, true], 'only that chart off');
  assert.deepEqual(JSON.parse(st.getItem('live-fit-orders-v1')), { 'pane-2': false }, 'only what is off is kept');
  p.setFitOrders('pane-2', true);
  assert.equal(LP.create(st).fitOrders('pane-2'), true);
  assert.deepEqual(JSON.parse(st.getItem('live-fit-orders-v1')), {});
  assert.equal(p.setFitOrders('', false), false, 'no pane, nothing saved');
  const odd = memStorage({ 'live-fit-orders-v1': JSON.stringify({ main: 'no', 'pane-3': 0 }) });
  assert.deepEqual([LP.create(odd).fitOrders('main'), LP.create(odd).fitOrders('pane-3')], [true, true], 'anything but false: on');
});
