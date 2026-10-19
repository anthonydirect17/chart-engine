'use strict';
// Trade colour (1.31.1): an optional `pts` on a trade (its signed result in points) decides the line and chip colour and the
// default chip text; without it the colour comes from (pOut - pIn) * dir exactly as before. Drawn on a stand-in canvas.
const test = require('node:test');
const assert = require('node:assert/strict');

const et = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s || 0) / 1000;   // New York wall clock stored as UTC

/* ---- the chart on a stand-in canvas */
function stubChart() {
  const ops = [];
  class Path2D { constructor() { this.rects = []; } rect(x, y, w, h) { this.rects.push([x, y, w, h]); } moveTo() {} lineTo() {} closePath() {} arc() {} }
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return s => ({ width: String(s).length * 7 });
      if (k === 'fill') return p => ops.push({ op: 'fill', color: t.fillStyle, path: p });
      if (k === 'fillRect') return (x, y, w, h) => ops.push({ op: 'rect', color: t.fillStyle, r: [x, y, w, h], transform: t.__tf });
      if (k === 'setTransform') return (a, b, c, d, e, f) => { t.__tf = a; };
      if (k === 'stroke') return () => ops.push({ op: 'stroke', color: t.strokeStyle });
      if (k === 'fillText') return s => ops.push({ op: 'text', s: String(s) });
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const made = [];
  const element = () => made[made.push({
    handlers: {}, style: {}, dataset: {}, hidden: false, textContent: '', tabIndex: -1,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, fn) { this.handlers[type] = fn; }, removeEventListener(type) { delete this.handlers[type]; },
    appendChild(c) { return c; }, remove() {}, setAttribute() {}, hasAttribute() { return false; },
    getContext: () => ctx, focus() {}, setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1078, height: 626, right: 1078, bottom: 626 }),
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
  const chart = E.create(element(), { clock: () => bars[bars.length - 1].t + 30 });
  chart.setBars(bars);
  let ts = 1000;
  return { E, chart, ops, bars, T0, made, frame() { ops.length = 0; const f = frameFn; frameFn = null; if (f) f(ts += 16); } };
}


/** The ops drawn for one trade: its dotted line's stroke colour and its chip text and colour. */
function drawTrade(trade) {
  const { chart, ops, T0, frame } = stubChart();
  chart.setLayers({ vwap: false, levels: false, volume: false });
  chart.setTrades([{ tIn: T0 + 150 * 60 + 20, tOut: T0 + 180 * 60 + 10, dir: 1, ...trade }]);
  frame();
  const T = chart.colors();
  const texts = ops.filter(o => o.op === 'text').map(o => o.s);
  const strokes = ops.filter(o => o.op === 'stroke').map(o => o.color);
  return { T, texts, strokes };
}

test('a trade with no pts: the colour and chip come from first to last as before', () => {
  const won = drawTrade({ pIn: 100, pOut: 101.5 });
  assert.ok(won.texts.includes('+1.50 pt'), won.texts.join('|'));
  assert.ok(won.strokes.includes(won.T.profit) && !won.strokes.includes(won.T.loss));
  const lost = drawTrade({ pIn: 100, pOut: 99, label: '#1 -1.00 pt' });
  assert.ok(lost.texts.includes('#1 -1.00 pt'));
  assert.ok(lost.strokes.includes(lost.T.loss) && !lost.strokes.includes(lost.T.profit));
});

test('pts decides the colour: long 1 at 100, add 2 at 110, out 3 at 105 is a loser drawn red', () => {
  // first to last says +5; the trade's average says (105 - 106.67) = -1.67
  const r = drawTrade({ pIn: 100, pOut: 105, pts: -5 / 3, label: '#1 -1.67 pt' });
  assert.ok(r.texts.includes('#1 -1.67 pt'));
  assert.ok(r.strokes.includes(r.T.loss), 'the line and chip are the loss colour');
  assert.ok(!r.strokes.includes(r.T.profit), 'never the profit colour');
  // without a label the chip shows pts
  assert.ok(drawTrade({ pIn: 100, pOut: 105, pts: -5 / 3 }).texts.includes('-1.67 pt'));
  // and the other way round: first to last says a loss, the average a win
  const w = drawTrade({ pIn: 110, pOut: 105, pts: 2, dir: 1 });
  assert.ok(w.strokes.includes(w.T.profit) && !w.strokes.includes(w.T.loss) && w.texts.includes('+2.00 pt'));
  // pts that is not a finite number is ignored
  const bad = drawTrade({ pIn: 100, pOut: 101, pts: NaN });
  assert.ok(bad.strokes.includes(bad.T.profit) && bad.texts.includes('+1.00 pt'));
  const zero = drawTrade({ pIn: 100, pOut: 101, pts: 0 });
  assert.ok(!zero.strokes.includes(zero.T.profit) && !zero.strokes.includes(zero.T.loss), 'a scratch is neither');
});
