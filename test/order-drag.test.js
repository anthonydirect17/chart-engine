// Order drag release (review N4): the engine's own pointer handlers, run in Node on a minimal stand-in DOM.
// A drag sends orderMove only when released inside the plot at a price on screen; released anywhere else it is
// cancelled, the line goes back, and nothing is sent.
const test = require('node:test');
const assert = require('node:assert/strict');

const W = 900, H = 500;                                    // chart size; the plot is W - 78 by H - 26
function stubDom() {
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return s => ({ width: String(s).length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k === 'getLineDash') return () => [];
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const element = () => {
    const handlers = {};
    return {
      handlers, style: {}, dataset: {}, hidden: false, textContent: '', tabIndex: -1,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener(type, fn) { handlers[type] = fn; }, removeEventListener(type) { delete handlers[type]; },
      appendChild(c) { this.child = this.child || []; this.child.push(c); return c; }, remove() {},
      setAttribute() {}, hasAttribute() { return false; }, getContext: () => ctx, focus() {}, setPointerCapture() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H }),
    };
  };
  let frameFn = null;
  global.document = { createElement: element, getElementById: () => null, head: { appendChild() {} } };
  global.window = { devicePixelRatio: 1 };
  global.requestAnimationFrame = fn => { frameFn = fn; return 1; };
  global.cancelAnimationFrame = () => {};
  global.Path2D = class { moveTo() {} lineTo() {} rect() {} closePath() {} arc() {} };
  const container = element();
  return { container, frames(n) { let t = 1000; for (let i = 0; i < n; i++) { t += 16; const f = frameFn; frameFn = null; f(t); } } };
}

function setup() {
  const dom = stubDom();
  delete require.cache[require.resolve('../src/chart-engine.js')];
  const CE = require('../src/chart-engine.js');
  const bars = [];
  for (let i = 0; i < 120; i++) { const c = 25000 + Math.sin(i / 9) * 20; bars.push({ t: 1790000000 + i * 60, o: c - 1, h: c + 3, l: c - 3, c, v: 100 }); }
  const chart = CE.create(dom.container, { clock: () => bars[bars.length - 1].t + 30, motion: { zoom: 0, fit: 0, candle: 0, follow: 0 } });
  chart.setBars(bars);
  chart.setOrders([{ id: 'T1', account: 'Sim101', root: 'MNQ', side: 'sell', kind: 'limit', role: 'target', price: 25005, qty: 1, state: 'working' }]);
  chart.setOrderEditing(true);
  dom.frames(5);
  const cv = dom.container.child[0];
  const moves = [];
  chart.on('orderMove', e => moves.push(e));
  const ev = (type, x, y) => ({ type, pointerId: 1, clientX: x, clientY: y, button: 0, buttons: 1, shiftKey: false, pointerType: 'mouse', timeStamp: 0, preventDefault() {} });
  const handle = () => chart.orderHandles().find(h => h.id === 'T1');
  /* press the order label, move up 40 px inside the plot, release at (x, y) */
  const drag = (upX, upY) => {
    const h = handle(), x = h.box.x + h.box.w / 2, y = h.box.y + h.box.h / 2;
    cv.handlers.pointerdown(ev('pointerdown', x, y));
    cv.handlers.pointermove(ev('pointermove', x, y - 20));
    cv.handlers.pointermove(ev('pointermove', x, y - 40));
    if (upY !== undefined) cv.handlers.pointermove(ev('pointermove', upX, upY));
    cv.handlers.pointerup(ev('pointerup', upX === undefined ? x : upX, upY === undefined ? y - 40 : upY));
    dom.frames(2);
  };
  return { chart, moves, drag, handle, dom };
}

test('order drag released inside the plot at a price on screen sends orderMove', () => {
  const { moves, drag } = setup();
  drag();
  assert.equal(moves.length, 1);
  assert.equal(moves[0].id, 'T1');
  assert.ok(moves[0].price > 25005, 'moved up: ' + moves[0].price);
  assert.equal(Math.round(moves[0].price / 0.25) * 0.25, moves[0].price, 'on the tick grid');
});

test('order drag released above the chart (over the toolbar) is cancelled: nothing sent, the line goes back', () => {
  const { moves, drag, handle } = setup();
  const y0 = handle().box.y;
  drag(300, -120);
  assert.equal(moves.length, 0);
  assert.ok(Math.abs(handle().box.y - y0) < 0.5, 'label back at its price');
});

test('order drag released over the price axis, the time axis or below the chart sends nothing', () => {
  for (const [x, y] of [[W - 30, 200], [300, H - 10], [300, H + 80], [-40, 200]]) {
    const { moves, drag } = setup();
    drag(x, y);
    assert.equal(moves.length, 0, 'released at ' + x + ',' + y);
  }
});
