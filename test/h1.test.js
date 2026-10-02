'use strict';
// Chart 1.15.0 (H1): the pure parts and the engine on a stand-in canvas. The room presets, the corner readout (its text
// place, clear of the labels), the 4h, 1D and 1W timestamps (PROTOCOL "Higher-timeframe bars"), the days of history per
// timeframe, the Zone (two corners, click-click or drag, on the tick, drawn behind the candles), the drawing tools never
// taking an order click on a host's chart, the press on an order while editing is off, the compact labels (short text,
// the full label's hit areas, the full one on hover), round-trip P&L for the Account panel's Fills, the Quote board's
// math, and the feed passing htf through.
const test = require('node:test');
const assert = require('node:assert/strict');
const CE = require('../src/chart-engine.js');
const { LivePrefs: LP } = require('../live/live.js');
const W = require('../live/workspace.js');
const F = require('../live/feed.js');
const U = CE.util;

const et = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s || 0) / 1000;   // New York wall clock stored as UTC
function memStorage() { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; }

/* ---------------- room right (Anthony's review of 1.14.0) */
test('room right: the workspace offers 80, 120 and 160 px, 120 until one is picked; a value saved before is kept', () => {
  assert.deepEqual(LP.ROOMS_WS, [80, 120, 160]);
  assert.equal(LP.DEFAULT_ROOM_WS, 120);
  const s = memStorage(), p = LP.create(s);
  assert.equal(p.roomSaved(), false, 'nothing picked');
  assert.equal(p.settings().room, 80, 'the single chart page keeps its 1.14.0 default (frozen)');
  p.setSetting('room', 160);
  assert.equal(LP.create(s).roomSaved(), true);
  assert.equal(LP.create(s).settings().room, 160, 'Anthony\'s 160 is kept');
  p.setSetting('room', 120);
  assert.equal(LP.create(s).settings().room, 120, '120 is a value kept');
  p.setSetting('room', 40);
  assert.equal(LP.create(s).settings().room, 40, 'an older pick (40) is kept as it was');
  p.setSetting('room', 121);
  assert.equal(LP.create(s).roomSaved(), false, 'not a value: as if none was picked');
});

/* ---------------- days of history per timeframe (Anthony's ruling 1) */
test('days of 1-minute history: 1 hour 30, 15 minute 10, every other 5', () => {
  assert.equal(LP.daysFor('h1'), 30);
  assert.equal(LP.daysFor('m15'), 10);
  for (const tf of ['s15', 's30', 'm1', 'm5', 'range', 'h4', 'd1', 'w1', 'junk', undefined, '__proto__']) assert.equal(LP.daysFor(tf), 5, String(tf));
  assert.ok(Math.max(...Object.values(LP.HISTORY_DAYS)) <= 60, 'ChartBridge caps days at 60');
  assert.deepEqual(LP.TFS, W.TFS, 'the page and the workspace list the same bars');
  assert.deepEqual(W.HTF_TFS, ['h4', 'd1', 'w1']);
  assert.equal(W.tfLabel('h4'), '4 hour'); assert.equal(W.tfLabel('d1'), '1 day'); assert.equal(W.tfLabel('w1'), '1 week');
});

/* ---------------- 4h, 1D and 1W timestamps (nt8/PROTOCOL.md "Higher-timeframe bars") */
test('htf: a 4h bar starts at 18, 22, 02, 06, 10 or 14 ET, from the 18:00 session open', () => {
  const cases = [
    [et(2026, 10, 1, 18, 0), et(2026, 10, 1, 18, 0)], [et(2026, 10, 1, 21, 59, 59.9), et(2026, 10, 1, 18, 0)],
    [et(2026, 10, 1, 22, 0), et(2026, 10, 1, 22, 0)], [et(2026, 10, 2, 1, 30), et(2026, 10, 1, 22, 0)],
    [et(2026, 10, 2, 2, 0), et(2026, 10, 2, 2, 0)], [et(2026, 10, 2, 9, 31), et(2026, 10, 2, 6, 0)],
    [et(2026, 10, 2, 10, 0), et(2026, 10, 2, 10, 0)], [et(2026, 10, 2, 16, 59, 59), et(2026, 10, 2, 14, 0)],
  ];
  for (const [t, start] of cases) assert.equal(U.htfStart(t, '4h'), start, U.fmtFull(t));
  for (const h of [18, 22, 2, 6, 10, 14]) assert.equal(U.tod(U.htfStart(et(2026, 10, 2, h, 7), '4h')), h * 3600);
  assert.equal(U.htfEnd(et(2026, 10, 2, 14, 0), '4h'), et(2026, 10, 2, 17, 0), 'the last of a session runs to the 17:00 close');
  assert.equal(U.htfEnd(et(2026, 10, 2, 10, 0), '4h'), et(2026, 10, 2, 14, 0));
  assert.equal(U.htfEnd(et(2026, 10, 1, 22, 0), '4h'), et(2026, 10, 2, 2, 0));
});

test('htf: a 1D bar is its trading day at 00:00 (Sunday 18:00 belongs to Monday); a 1W bar is its Monday', () => {
  assert.equal(U.htfStart(et(2026, 10, 2, 9, 30), '1D'), et(2026, 10, 2, 0, 0), 'Friday morning: Friday');
  assert.equal(U.htfStart(et(2026, 10, 1, 18, 0), '1D'), et(2026, 10, 2, 0, 0), 'Thursday 18:00: Friday\'s session');
  assert.equal(U.htfStart(et(2026, 10, 1, 17, 59), '1D'), et(2026, 10, 1, 0, 0));
  assert.equal(U.htfStart(et(2026, 10, 4, 18, 0), '1D'), et(2026, 10, 5, 0, 0), 'Sunday 18:00: Monday');
  assert.equal(U.htfEnd(et(2026, 10, 2, 0, 0), '1D'), et(2026, 10, 2, 17, 0), 'the 17:00 close');
  assert.equal(U.htfStart(et(2026, 10, 4, 18, 0), '1W'), et(2026, 10, 5, 0, 0), 'Sunday 18:00 opens the week of Monday 5 Oct');
  for (const d of [5, 6, 7, 8, 9]) assert.equal(U.htfStart(et(2026, 10, d, 11, 0), '1W'), et(2026, 10, 5, 0, 0), 'Oct ' + d);
  assert.equal(U.htfStart(et(2026, 10, 2, 16, 59), '1W'), et(2026, 9, 28, 0, 0), 'Friday 2 Oct: the week of Monday 28 Sep');
  assert.equal(new Date(U.htfStart(et(2027, 1, 1, 10, 0), '1W') * 1000).getUTCDay(), 1, 'always a Monday');
  assert.equal(U.htfEnd(et(2026, 10, 5, 0, 0), '1W'), et(2026, 10, 9, 17, 0), 'Friday 17:00');
  assert.equal(U.HTF_SECONDS['4h'], 14400); assert.equal(U.HTF_SECONDS['1D'], 86400); assert.equal(U.HTF_SECONDS['1W'], 604800);
  assert.ok(Number.isNaN(U.htfStart(et(2026, 10, 2, 9, 0), '2h')));
});

test('htf: the same starts as the fake ChartBridge (its own HtfStart), over two months of minutes', () => {
  // the fake's formula (test/fake-bridge.mjs), written apart from the engine's
  const fake = (tf, t) => {
    const day = Math.floor((t + 21600) / 86400);
    if (tf === '4h') { const open = day * 86400 - 21600; return open + Math.floor((t - open) / 14400) * 14400; }
    if (tf === '1D') return day * 86400;
    const dow = ((day + 4) % 7 + 7) % 7;
    return (day - (dow + 6) % 7) * 86400;
  };
  for (let t = et(2026, 8, 1, 0, 0); t < et(2026, 10, 1, 0, 0); t += 37 * 60 + 13) for (const tf of ['4h', '1D', '1W']) assert.equal(U.htfStart(t, tf), fake(tf, t), tf + ' ' + U.fmtFull(t));
});

/* ---------------- the corner readout (Anthony's item 9) */
test('corner readout: the bottom right of the plot, moved up past the labels and the VWAP marker, else the top right', () => {
  assert.deepEqual(U.cornerPlace(1000, 600, 150, 16, [], 0), { x: 844, y: 578 }, 'bottom right, 6 px in');
  const label = { x: 900, y: 570, w: 94, h: 18 };
  const a = U.cornerPlace(1000, 600, 150, 16, [label], 0);
  assert.ok(a.y + 16 + 3 <= label.y, 'above a label at the bottom right: ' + a.y);
  const many = [];
  for (let y = 40; y < 600; y += 20) many.push({ x: 900, y, w: 94, h: 18 });
  assert.equal(U.cornerPlace(1000, 600, 150, 16, many, 30), null, 'nowhere free: none (the labels win)');
  const up = U.cornerPlace(1000, 600, 150, 16, [{ x: 800, y: 300, w: 200, h: 300 }], 40);
  assert.deepEqual(up, { x: 844, y: 280 }, 'moved up past a tall box');
  assert.deepEqual(U.cornerPlace(1000, 600, 150, 16, [{ x: 800, y: 60, w: 200, h: 540 }], 40), { x: 844, y: 40 }, 'at most up to the header\'s room');
  assert.equal(U.cornerPlace(100, 600, 150, 16, [], 0), null, 'a plot narrower than the text');
  assert.equal(U.cornerPlace(1000, 20, 150, 16, [], 0), null, 'a plot too short');
  // left of the labels is never used: they sit at the right edge, the readout keeps the corner
  const off = U.cornerPlace(1000, 600, 150, 16, [{ x: 100, y: 570, w: 80, h: 18 }], 0);
  assert.deepEqual(off, { x: 844, y: 578 }, 'a box elsewhere does not move it');
});

/* ---------------- short labels (Anthony's item 13) */
test('compact labels: the short text; the full one is today\'s', () => {
  assert.equal(U.orderLabelShort({ side: 'sell', role: 'target', kind: 'limit', qty: 1 }), 'TGT 1');
  assert.equal(U.orderLabelShort({ side: 'sell', role: 'stop', kind: 'stop', qty: 2, filled: 1 }), 'STP 1', 'what is left to fill');
  assert.equal(U.orderLabelShort({ side: 'buy', kind: 'limit', qty: 1 }), 'BUY LMT 1');
  assert.equal(U.orderLabelShort({ side: 'sell', kind: 'stop', qty: 3 }), 'SELL STP 3');
  assert.equal(U.orderLabelShort({ plan: { role: 'stop', ticks: 12 } }), 'SL -12t');
  assert.equal(U.orderLabelShort({ plan: { role: 'target', ticks: 24 } }), 'TP +24t');
  assert.equal(U.orderLabel({ side: 'sell', role: 'target', qty: 1 }), 'SELL TGT 1', 'the full label as before');
  assert.equal(U.orderLabel({ plan: { role: 'stop', ticks: 12 } }), 'SL plan -12t');
  assert.deepEqual(U.positionShort(1, { points: 4.5, dollars: 90 }, 2), ['L1', '+4.50', '+$90']);
  assert.deepEqual(U.positionShort(-2, { points: -3.25, dollars: -1300.4 }, 2), ['S2', '-3.25', '-$1,300']);
  assert.deepEqual(U.positionShort(1, { points: 0, dollars: null }, 2), ['L1', '0.00'], 'no point value: no dollars');
});

/* ---------------- the Account panel's Fills: flat-to-flat trades */
test('round trips: a trade per flat-to-flat run, P&L in dollars on the fill that goes flat, reversals split', () => {
  const pv = r => (r === 'NQ' ? 20 : 2);
  const f = (id, t, root, side, qty, p) => ({ id, t, root, side, qty, p });
  const r = W.roundTrips([
    f('a', 100, 'NQ', 'buy', 1, 31024.75), f('b', 200, 'NQ', 'sell', 1, 31032.5),            // +7.75 x $20 = +155
    f('c', 300, 'MNQ', 'sell', 2, 31023.5), f('d', 400, 'MNQ', 'buy', 3, 31029.0),             // short 2 closed -5.5 x 2 x $2 = -22, long 1 opened
    f('e', 500, 'MNQ', 'sell', 1, 31030.0),                                                     // +1 x $2 = +2
    f('g', 600, 'NQ', 'buy', 1, 31049.25),                                                      // open
  ], pv);
  assert.deepEqual(r.byFill.get('b'), { pnl: 155, open: false });
  assert.deepEqual(r.byFill.get('d'), { pnl: -22, open: false });
  assert.deepEqual(r.byFill.get('e'), { pnl: 2, open: false });
  assert.deepEqual(r.byFill.get('g'), { pnl: null, open: true }, 'the last fill of a trade still open');
  assert.equal(r.byFill.has('a'), false);
  assert.equal(r.trades, 3);
  assert.equal(r.realized, 135);
  assert.equal(r.unknown, 0);
});

test('round trips: scaling in and out (average price), a part closed of a trade still open, the order of fills', () => {
  const f = (id, t, side, qty, p) => ({ id, t, root: 'MNQ', side, qty, p });
  const r = W.roundTrips([f('3', 30, 'sell', 1, 105), f('1', 10, 'buy', 1, 100), f('2', 20, 'buy', 1, 102), f('4', 40, 'sell', 1, 104)], () => 2);
  assert.deepEqual(r.byFill.get('4'), { pnl: (105 - 101) * 2 + (104 - 101) * 2, open: false }, 'average 101');
  const open = W.roundTrips([f('1', 10, 'buy', 2, 100), f('2', 20, 'sell', 1, 103)], () => 2);
  assert.equal(open.trades, 0);
  assert.equal(open.realized, 6, 'the part closed counts in realized');
  assert.deepEqual(open.byFill.get('2'), { pnl: null, open: true });
});

test('round trips: a position from before today makes that first trade unknown (never guessed)', () => {
  const f = (id, t, side, qty, p) => ({ id, t, root: 'NQ', side, qty, p });
  const r = W.roundTrips([f('1', 10, 'sell', 1, 100), f('2', 20, 'buy', 1, 90), f('3', 30, 'sell', 1, 95)], () => 20, { NQ: 1 });
  assert.deepEqual(r.byFill.get('1'), { pnl: null, open: false }, 'long 1 from yesterday closed: its entry is not here');
  assert.equal(r.unknown, 1);
  assert.equal(r.realized, null, 'the day\'s realized is unknown then');
  assert.deepEqual(r.byFill.get('3'), { pnl: 100, open: false }, 'the next trade is whole');
  assert.equal(W.roundTrips([], () => 1).trades, 0);
  assert.equal(W.roundTrips([null, { id: 'x', side: 'hold', qty: 1, p: 1, t: 1 }], () => 1).trades, 0, 'junk ignored');
});

test('fills today: from 18:00 ET the day before, on the account asked for', () => {
  const now = et(2026, 10, 2, 10, 0);
  const list = [{ id: 1, account: 'Sim101', t: et(2026, 10, 1, 17, 59) }, { id: 2, account: 'Sim101', t: et(2026, 10, 1, 18, 0) },
    { id: 3, account: 'Sim101', t: et(2026, 10, 2, 9, 0) }, { id: 4, account: 'Other', t: et(2026, 10, 2, 9, 0) }];
  assert.deepEqual(W.fillsToday(list, 'Sim101', now).map(x => x.id), [2, 3]);
});

/* ---------------- the Quote board */
test('quote board: change and percent from the prior settlement, blank without one; the session\'s high and low', () => {
  const q = W.quoteChange(31053.75, 30760.5);
  assert.equal(q.chg, 293.25);
  assert.equal(q.pct.toFixed(2), '0.95');
  assert.deepEqual(W.quoteChange(31053.75, null), { chg: null, pct: null }, 'no settlement: blank, never estimated');
  assert.deepEqual(W.quoteChange(null, 30760.5), { chg: null, pct: null });
  assert.equal(W.fmtSignedNum(293.25, 2), '+293.25'); assert.equal(W.fmtSignedNum(-1204.5, 2), '-1,204.50'); assert.equal(W.fmtSignedNum(null, 2), '');
  assert.equal(W.fmtUsd(412.5), '+$412.50'); assert.equal(W.fmtUsd(-22), '-$22.00'); assert.equal(W.fmtUsd(0), '$0.00'); assert.equal(W.fmtUsd(null), '');
  const now = et(2026, 10, 2, 10, 0);
  const bars = [{ t: et(2026, 10, 1, 17, 59), h: 999, l: 1 }, { t: et(2026, 10, 1, 18, 0), h: 105, l: 100 }, { t: et(2026, 10, 2, 9, 30), h: 110, l: 99 }];
  assert.deepEqual(W.sessionRange(bars, now), { high: 110, low: 99 }, 'yesterday\'s session left out');
  assert.deepEqual(W.sessionRange([], now), { high: null, low: null });
});

test('the workspace keeps an Account panel and a Quote board in its layouts (no instrument)', () => {
  assert.deepEqual(W.cleanPanel({ id: 'a', type: 'account', root: 'NQ', x: 10, y: 3, w: 2, h: 2 }), { id: 'a', type: 'account', x: 10, y: 3, w: 2, h: 2 });
  assert.deepEqual(W.cleanPanel({ id: 'q', type: 'quotes', x: 10, y: 5, w: 2, h: 1 }), { id: 'q', type: 'quotes', x: 10, y: 5, w: 2, h: 1 });
  assert.deepEqual(W.cleanPanel({ id: 'c', type: 'chart', root: 'MNQ', tf: 'h4', x: 0, y: 0, w: 2, h: 1 }), { id: 'c', type: 'chart', root: 'MNQ', tf: 'h4', x: 0, y: 0, w: 2, h: 1 });
  assert.equal(W.cleanPanel({ id: 'c', type: 'chart', tf: 'h4', x: 0, y: 0, w: 2, h: 1 }), null, 'a chart still needs its instrument');
});

/* ---------------- the feed: htf passes, read only; a load says its days */
test('feed: a panel\'s htf request goes out on its instrument\'s line; the answer reaches every panel there; days in the load', async () => {
  const sent = [], socks = [];
  class WS { constructor() { this.readyState = 0; socks.push(this); } send(d) { sent.push(JSON.parse(d)); } close() {} }
  const h = F.create({ wsUrl: 'ws://x', WebSocket: WS });
  const got = [];
  const v = h.open('MNQ');
  v.onmessage = ev => { got.push(ev.message); if (ev.message.type === 'hello') v.send(JSON.stringify({ type: 'subscribe', root: 'MNQ', days: 30, tickHours: 0 })); };
  await new Promise(r => setTimeout(r, 0));
  const ws = socks[0]; ws.readyState = 1; ws.onopen({});
  ws.onmessage({ data: JSON.stringify({ type: 'hello', version: '0.3.8', instruments: [{ root: 'MNQ' }], features: ['htf'] }) });
  await new Promise(r => setTimeout(r, 0));
  v.send(JSON.stringify({ type: 'htf', root: 'MNQ', tf: '4h', id: 3 }));
  v.send(JSON.stringify({ type: 'order', root: 'MNQ' }));
  assert.deepEqual(sent.map(m => m.type), ['subscribe', 'htf'], 'htf goes out; an order never leaves a panel');
  assert.equal(sent[0].days, 30);
  ws.onmessage({ data: JSON.stringify({ type: 'htf', root: 'MNQ', tf: '4h', id: 3, bars: [[1, 2, 3, 1, 2, 5]], error: null }) });
  ws.onmessage({ data: JSON.stringify({ type: 'history', root: 'MNQ', bars: [[60, 1, 1, 1, 1, 1]], done: true }) });
  assert.ok(got.some(m => m.type === 'htf' && m.id === 3), 'the answer reaches the panel');
  const hist = got.find(m => m.type === 'history');
  assert.equal(hist.load.days, 30, 'the load says how many days it holds');
  h.close();
});

/* ---------------- the engine on a stand-in canvas: the Zone, the tools and the orders, the compact labels, the corner */
function stub(opts) {
  const ops = [];
  class Path2D { rect() {} moveTo() {} lineTo() {} closePath() {} arc() {} }
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return s => ({ width: String(s).length * 7 });
      if (k === 'fillRect') return (x, y, w, h) => ops.push({ op: 'rect', color: t.fillStyle, r: [x, y, w, h] });
      if (k === 'strokeRect') return (x, y, w, h) => ops.push({ op: 'strokeRect', color: t.strokeStyle, r: [x, y, w, h] });
      if (k === 'fill') return () => ops.push({ op: 'fill', color: t.fillStyle });
      if (k === 'fillText') return (s, x, y) => ops.push({ op: 'text', s: String(s), x, y, font: t.font });
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
  const bars = [], T0 = et(2026, 9, 29, 10, 0);
  for (let i = 0; i < 200; i++) { const c = 100 + Math.sin(i / 9) * 2; bars.push({ t: T0 + i * 60, o: c - 0.5, h: c + 1, l: c - 1, c, v: 100, vw: c }); }
  const host = element();
  const chart = E.create(host, Object.assign({ clock: () => bars[bars.length - 1].t + 30 }, opts || {}));
  chart.setBars(bars);
  const cv = made.find(m => m.handlers.pointerdown);
  let ts = 1000, id = 1;
  const ev = (x, y, o) => Object.assign({ clientX: x, clientY: y, button: 0, pointerId: id, pointerType: 'mouse', timeStamp: ts, shiftKey: false, ctrlKey: false, preventDefault() {} }, o || {});
  const api = {
    E, chart, ops, bars, host, frame(n) { for (let k = 0; k < (n || 1); k++) { ops.length = 0; const f = frameFn; frameFn = null; if (f) f(ts += 16); } },
    down: (x, y, o) => cv.handlers.pointerdown(ev(x, y, o)), move: (x, y, o) => cv.handlers.pointermove(ev(x, y, o)), up: (x, y, o) => { cv.handlers.pointerup(ev(x, y, o)); id++; },
    click(x, y, o) { api.down(x, y, o); api.up(x, y, o); },
    key: (k, o) => host.handlers.keydown(Object.assign({ key: k, preventDefault() {} }, o || {})),
  };
  api.frame(30);
  return api;
}

test('Zone: two corners (click-click), prices on the tick, one drawing and the tool is off; drawn behind the candles', () => {
  const S = stub();
  const saved = []; S.chart.on('drawings', l => saved.push(l));
  S.chart.setTool('zone');
  assert.equal(S.chart.getTool(), 'zone');
  S.click(300, 200); S.click(600, 350);
  const d = S.chart.getDrawings();
  assert.equal(d.length, 1);
  assert.equal(d[0].type, 'zone');
  for (const p of [d[0].a.p, d[0].b.p]) assert.equal(Math.round(p / 0.25) * 0.25, p, 'on the tick');
  assert.ok(d[0].a.p !== d[0].b.p && d[0].a.t !== d[0].b.t, 'two prices and two times');
  assert.equal(S.chart.getTool(), null, 'one drawing, then the tool is off');
  assert.equal(saved.length, 1, 'saved with the chart\'s drawings');
  S.frame();
  const T = S.chart.colors();
  const zi = S.ops.findIndex(o => o.op === 'strokeRect' && o.color === T.drawing);
  const ci = S.ops.findIndex(o => o.op === 'fill' && (o.color === T.up || o.color === T.down));
  assert.ok(zi >= 0, 'the box is drawn');
  assert.ok(zi < ci, 'behind the candles');
  // saved and loaded again with the other drawings
  S.chart.setDrawings(saved[0].concat([{ id: 'h', type: 'hline', price: 100 }, { id: 'x', type: 'circle' }]));
  assert.deepEqual(S.chart.getDrawings().map(x => x.type), ['zone', 'hline']);
});

test('Zone: drag to draw; a zero-height box is not kept; Escape takes back the tool or a box half made', () => {
  const S = stub();
  S.chart.setTool('zone');
  S.down(300, 200); S.move(400, 260); S.move(500, 330); S.up(500, 330);
  assert.equal(S.chart.getDrawings().length, 1, 'a drag draws one');
  S.chart.setTool('zone');
  S.click(300, 200); S.click(500, 200);
  assert.equal(S.chart.getDrawings().length, 1, 'one price only: no box');
  S.chart.setTool('zone');
  S.click(300, 200); S.key('Escape');
  assert.equal(S.chart.getTool(), null);
  S.click(500, 330);
  assert.equal(S.chart.getDrawings().length, 1, 'the half-made box went with Escape');
  S.chart.setTool('trend'); S.key('Escape');
  assert.equal(S.chart.getTool(), null, 'an armed tool goes with Escape');
});

test('Zone: dragged by an edge, a corner resized, selected and deleted like the other drawings', () => {
  const S = stub();
  S.chart.setTool('zone'); S.click(300, 200); S.click(600, 350);
  const z0 = S.chart.getDrawings()[0];
  S.frame();
  const y0 = S.chart.priceToY(Math.max(z0.a.p, z0.b.p));
  S.down(450, y0); S.move(450, y0 + 40); S.up(450, y0 + 40);
  const z1 = S.chart.getDrawings()[0];
  const dp = Math.max(z1.a.p, z1.b.p) - Math.max(z0.a.p, z0.b.p);
  assert.ok(dp < 0, 'moved down by its top edge');
  assert.equal(Math.round(dp / 0.25) * 0.25, dp, 'by whole ticks');
  // the bottom-right corner
  S.frame();
  const bx = S.chart.barToX(0) + 0, br = { x: Math.max(...[z1.a.t, z1.b.t].map(t => t)), p: Math.min(z1.a.p, z1.b.p) };
  const ry = S.chart.priceToY(br.p);
  S.down(600, ry); S.move(650, ry + 30); S.up(650, ry + 30);
  const z2 = S.chart.getDrawings()[0];
  assert.ok(Math.min(z2.a.p, z2.b.p) < Math.min(z1.a.p, z1.b.p), 'a corner: its price moved');
  assert.equal(Math.max(z2.a.p, z2.b.p), Math.max(z1.a.p, z1.b.p), 'the opposite corner stays');
  void bx;
  assert.ok(S.chart.deleteSelected(), 'selected by the drag, deleted');
  assert.equal(S.chart.getDrawings().length, 0);
});

test('tools and orders: on a host\'s chart a Shift click places the order whatever tool is armed (no drawing); on the page as before', () => {
  for (const host of [true, false]) {
    const S = stub(host ? { toolOrders: true } : {});
    const placed = []; S.chart.on('orderPlace', e => placed.push(e));
    S.chart.setOrderEditing(true);
    for (const t of ['zone', 'hline', 'trend']) {
      S.chart.setTool(t);
      S.click(400, 300, { shiftKey: true });
      if (host) { assert.equal(S.chart.getTool(), t, 'the tool stays armed'); S.chart.setTool(null); }
    }
    if (host) {
      assert.equal(placed.length, 3, 'three Shift clicks, three orders');
      assert.equal(S.chart.getDrawings().length, 0, 'no drawing');
      S.chart.setTool('hline'); S.click(400, 300);
      assert.equal(S.chart.getDrawings().length, 1, 'a plain click draws');
      assert.equal(placed.length, 3, 'and places nothing');
    } else assert.equal(placed.length, 0, 'the single chart page (frozen): a tool takes the click, as in 1.14.0');
  }
});

test('a press on an order while editing is off: the page is told once per press, and it pans as before', () => {
  const S = stub({ compactLabels: true });
  const told = []; S.chart.on('orderPressOff', e => told.push(e));
  S.chart.setOrders([{ id: 'o1', side: 'sell', kind: 'stop', price: 99, qty: 1, role: 'stop' }]);
  S.frame();
  const h = S.chart.orderHandles()[0];
  S.down(h.box.x + 5, h.box.y + 5); S.move(h.box.x - 20, h.box.y + 5); S.move(h.box.x - 60, h.box.y + 5); S.up(h.box.x - 60, h.box.y + 5);
  assert.deepEqual(told, [{ id: 'o1' }], 'once, not per move');
  S.chart.setOrderEditing(true);
  S.frame();
  const h2 = S.chart.orderHandles()[0];
  S.down(h2.box.x + 5, h2.box.y + 5); S.up(h2.box.x + 5, h2.box.y + 5);
  assert.equal(told.length, 1, 'never while editing is on');
  S.chart.setOrderEditing(false);
  S.down(10, 10); S.up(10, 10);
  assert.equal(told.length, 1, 'not for a press elsewhere');
});

test('compact labels: short text drawn, the full label\'s hit areas and x, the full one while the mouse is over it', () => {
  const orders = [{ id: 'o1', side: 'sell', kind: 'limit', price: 101.5, qty: 1, role: 'target' }, { id: 'o2', side: 'buy', kind: 'limit', price: 98, qty: 2 }];
  const texts = S => S.ops.filter(o => o.op === 'text').map(o => o.s);
  const setUp = S => { S.chart.setOrders(orders); S.chart.setOrderEditing(true); S.chart.setPosition({ qty: 1, avgPrice: 100 }, { pointValue: 2 }); S.frame(); };
  const full = stub(); setUp(full);                              // one stand-in at a time (they share the frame callback)
  const fullHits = full.chart.orderHandles(), fullTexts = texts(full);
  full.move(fullHits[0].box.x + 4, fullHits[0].box.y + 9);
  assert.equal(full.chart.labelHover(), null, 'the single chart page: no hover change (frozen)');
  full.chart.destroy();
  const compact = stub({ compactLabels: true }); setUp(compact);
  assert.ok(fullHits.length === 2, 'two orders');
  assert.deepEqual(compact.chart.orderHandles(), fullHits, 'the same hit areas, x and stacking as the full labels');
  assert.ok(fullTexts.includes('SELL TGT 1') && fullTexts.includes('BUY LMT 2') && fullTexts.includes('LONG 1'));
  assert.ok(texts(compact).includes('TGT 1') && texts(compact).includes('BUY LMT 2') && texts(compact).includes('L1'), texts(compact).join('|'));
  assert.ok(!texts(compact).includes('SELL TGT 1') && !texts(compact).includes('LONG 1'), 'not the full text');
  assert.ok(compact.ops.filter(o => o.op === 'text' && o.s === 'TGT 1').every(o => /10px/.test(o.font)), 'the smaller text');
  const h = compact.chart.orderHandles().find(x => x.id === 'o1');
  compact.move(h.box.x + h.box.w - 4, h.box.y + 9);
  assert.equal(compact.chart.labelHover(), 'o1');
  compact.frame();
  assert.ok(texts(compact).includes('SELL TGT 1') && !texts(compact).includes('TGT 1'), 'the full label on hover');
  compact.move(20, 20);
  assert.equal(compact.chart.labelHover(), null);
});

test('corner readout: drawn at the plot\'s bottom right, clear of an order label there, none when empty', () => {
  const S = stub();
  S.chart.setCorner('Bar 0:23 · ATR(14) 12.50');
  S.frame();
  const c = S.chart.corner();
  assert.ok(c, 'drawn');
  assert.equal(c.text, 'Bar 0:23 · ATR(14) 12.50');
  assert.equal(Math.round(c.x + c.w), 1078 - 78 - 6, 'at the plot\'s right edge, 6 px in (never on the price axis, the padlock or Jump to live)');
  assert.ok(S.ops.some(o => o.op === 'text' && o.s === 'Bar 0:23 · ATR(14) 12.50'));
  const bottom = S.chart.priceToY(S.chart.priceScale().lo) - 10;
  S.chart.setOrders([{ id: 'o1', side: 'sell', kind: 'stop', price: S.chart.yToPrice(bottom), qty: 1, role: 'stop' }]);
  S.frame();
  const h = S.chart.orderHandles()[0], c2 = S.chart.corner();
  assert.ok(c2.y + c2.h <= h.box.y || c2.y >= h.box.y + h.box.h || c2.x + c2.w <= h.box.x, 'clear of the label');
  S.chart.setCorner('Bar 0:23 · ATR(14) 12.50 ' + 'x'.repeat(150), '0:23 · ATR 12.50');
  S.frame();
  assert.equal(S.chart.corner().text, '0:23 · ATR 12.50', 'a plot too narrow for the whole text: the short form');
  S.chart.setCorner('');
  S.frame();
  assert.equal(S.chart.corner(), null);
});
