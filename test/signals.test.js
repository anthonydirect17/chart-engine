'use strict';
// Absorption bars, CVD divergence arrows and large-order bubbles. Pure logic only (made-up numbers, never market data).
const test = require('node:test');
const assert = require('node:assert/strict');
const CE = require('../src/chart-engine.js');
const { LivePrefs: LP } = require('../live/live.js');
const W = require('../live/workspace.js');

const day = 20000;
const at = (h, m, s) => day * 86400 + h * 3600 + m * 60 + (s || 0);

function runAbsorb(opt, list, leaveOpen) {
  const abs = new CE.Absorption(Object.assign({ floorAt: () => 50, coveredFrom: -Infinity }, opt));
  abs.onBar = t => { const b = list.find(x => x.t === t); if (b) abs.close(b); };
  const last = list.length - 1;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    for (const pr of b.prints) abs.add(b.t + pr.dt, pr.price, pr.v, pr.side, b.t);
    if (i === last && !leaveOpen) abs.close(b);
  }
  return abs;
}
const quiet = (i, v) => ({ t: 1000 + i * 60, o: 100, h: 101, l: 99, c: 100, v: v == null ? 10 : v, prints: [{ dt: 0.1, price: 100, v: v == null ? 10 : v, side: -1 }] });

test('large-print floors match the tape, including 16:15 exclusive', () => {
  const floors = { NQ: { rth: 60, eth: 30 }, ES: { rth: 100, eth: 50 }, MNQ: { rth: 100, eth: 50 }, MES: { rth: 100, eth: 50 } };
  const times = [at(9, 29, 59), at(9, 30, 0), at(10, 30, 0), at(16, 14, 59), at(16, 15, 0), at(18, 0, 0), at(0, 0, 0)];
  for (const root of ['NQ', 'ES', 'MNQ', 'MES']) {
    for (const t of times) {
      assert.equal(CE.largeFloor(root, t, null), W.floorAt(root, t, W.cleanFloors(null)), root + ' ' + t);
      assert.equal(CE.largeFloor(root, t, floors), W.floorAt(root, t, W.cleanFloors(floors)), root + ' saved ' + t);
    }
  }
  assert.equal(CE.largeFloor('NQ', at(10, 0), null), 50);
  assert.equal(CE.largeFloor('NQ', at(18, 0), null), 25);
  assert.equal(CE.largeFloor('NQ', at(16, 14, 59), null), 50);
  assert.equal(CE.largeFloor('NQ', at(16, 15, 0), null), 25);
});

test('absorption: 500 ms same-side same-price prints add up, and the close rule paints bull or bear', () => {
  const opt = { lookback: 2, volumeMult: 1.8, rejection: 0.35, windowMs: 500 };
  const prior = [quiet(0), quiet(1), quiet(2)];
  const bull = { t: 1000 + 3 * 60, o: 99, h: 101, l: 99, c: 101, v: 100, prints: [
    { dt: 0.01, price: 100, v: 20, side: 1 },
    { dt: 0.2, price: 100, v: 20, side: 1 },
    { dt: 0.5, price: 100, v: 20, side: 1 },
  ] };
  let abs = runAbsorb(opt, prior.concat(bull));
  assert.deepEqual(abs.bodies.map(m => m.kind + ':' + m.paint), ['bull:body']);
  // 501 ms later is a new cluster, so 30 + 30 does not qualify
  const split = { t: 1000 + 3 * 60, o: 99, h: 101, l: 99, c: 101, v: 100, prints: [
    { dt: 0.01, price: 100, v: 30, side: 1 },
    { dt: 0.512, price: 100, v: 30, side: 1 },
  ] };
  abs = runAbsorb(opt, [quiet(0), quiet(1), quiet(2), split]);
  assert.equal(abs.bodies.length, 0);
  // a different price is not added in
  const otherPx = { t: 1000 + 3 * 60, o: 99, h: 101, l: 99, c: 101, v: 100, prints: [
    { dt: 0.01, price: 100, v: 30, side: 1 },
    { dt: 0.2, price: 101, v: 30, side: 1 },
  ] };
  abs = runAbsorb(opt, [quiet(0), quiet(1), quiet(2), otherPx]);
  assert.equal(abs.bodies.length, 0);
  // the latest qualifying event sets the direction: a sell after the buys, close at the low
  const bear = { t: 1000 + 3 * 60, o: 101, h: 101, l: 99, c: 99, v: 100, prints: [
    { dt: 0.01, price: 100, v: 60, side: 1 },
    { dt: 0.7, price: 99, v: 50, side: -1 },
  ] };
  abs = runAbsorb(opt, [quiet(0), quiet(1), quiet(2), bear]);
  assert.deepEqual(abs.bodies.map(m => m.kind), ['bear']);
  // a doji does not paint
  const doji = { t: 1000 + 3 * 60, o: 100, h: 100, l: 100, c: 100, v: 100, prints: [{ dt: 0.1, price: 100, v: 60, side: 1 }] };
  abs = runAbsorb(opt, [quiet(0), quiet(1), quiet(2), doji]);
  assert.equal(abs.bodies.length, 0);
});

test('absorption: the latest large print sets direction, the largest size is kept, and a new bar starts clean', () => {
  const opt = { lookback: 2, floorAt: () => 50 };
  const prior = [quiet(0), quiet(1), quiet(2)];
  const both = { t: 1000 + 3 * 60, o: 101, h: 101, l: 99, c: 99, v: 200, prints: [
    { dt: 0.1, price: 100, v: 80, side: 1 },
    { dt: 0.4, price: 99, v: 55, side: -1 },
  ] };
  const abs = runAbsorb(opt, prior.concat(both));
  assert.deepEqual(abs.largeTrade(both.t), { dir: 'sell', size: 80 });
  assert.deepEqual(abs.bodies.map(m => m.kind), ['bear']);
  // same bar, same side, inside 500 ms: one cluster, not cut up on the later tick
  const grown = new CE.Absorption(Object.assign({ coveredFrom: -Infinity }, opt));
  grown.add(5000.1, 100, 30, 1, 5000);
  grown.add(5000.3, 100, 30, 1, 5000);
  assert.deepEqual(grown.largeTrade(5000), { dir: 'buy', size: 60 });
  // the open cluster does not move onto the next bar
  const span = new CE.Absorption(Object.assign({ coveredFrom: -Infinity }, opt));
  span.add(6000.1, 100, 60, 1, 6000);
  span.add(6000.3, 100, 20, 1, 6060);
  assert.deepEqual(span.largeTrade(6000), { dir: 'buy', size: 60 });
  assert.equal(span.largeTrade(6060), null);
});

test('absorption: outline while the three hold, body only if they still hold at the close, and nothing before the page opened', () => {
  const opt = { lookback: 2, floorAt: () => 50 };
  const list = [quiet(0), quiet(1), quiet(2), { t: 1000 + 3 * 60, o: 99, h: 101, l: 99, c: 101, v: 100, prints: [{ dt: 0.1, price: 101, v: 60, side: 1 }] }];
  const abs = new CE.Absorption(Object.assign({ coveredFrom: -Infinity }, opt));
  abs.onBar = t => { const b = list.find(x => x.t === t); if (b) abs.close(b); };
  for (const b of list.slice(0, 3)) for (const pr of b.prints) abs.add(b.t + pr.dt, pr.price, pr.v, pr.side, b.t);
  abs.close(list[2]);
  const live = list[3];
  abs.add(live.t + 0.1, 101, 60, 1, live.t);
  assert.equal(abs.see(live).paint, 'outline');
  assert.equal(abs.see(live).kind, 'bull');
  live.c = 100; // close back to the middle: the rejection is gone
  assert.equal(abs.see(live), null);
  assert.equal(abs.close(live), null);
  assert.equal(abs.bodies.length, 0);
  // a bar that started before the page opened is not painted, even when the three would hold
  const early = runAbsorb(Object.assign({}, opt, { coveredFrom: list[3].t + 1 }), list);
  assert.equal(early.bodies.length, 0);
});

test('divergence: hollow, then solid, then removed, and a swing before the page opened does not count', () => {
  const px = [10, 10, 10, 10, 12, 10, 10, 10, 10, 14, 11, 11];
  const delta = [10, 20, 30, 40, 100, 110, 120, 130, 140, 80, 80, 80];
  const bars = px.map((h, i) => ({ t: 5000 + i * 60, h, l: h - 1 }));
  const atD = t => delta[(t - 5000) / 60];
  const opt = { swing: 2, minBars: 3, minPct: 0.10, from: bars[0].t };
  let marks = CE.divergenceMarks(bars, atD, Object.assign({ to: 10 }, opt));
  assert.deepEqual(marks, [{ t: bars[9].t, kind: 'bear', hollow: true }], 'hollow at the new high');
  marks = CE.divergenceMarks(bars, atD, Object.assign({ to: 12 }, opt));
  assert.deepEqual(marks, [{ t: bars[9].t, kind: 'bear', hollow: false }], 'solid once the swing confirms');
  const taken = bars.map(b => Object.assign({}, b));
  taken[10] = { t: bars[10].t, h: 15, l: 14 };
  marks = CE.divergenceMarks(taken, atD, Object.assign({ to: 12 }, opt));
  assert.ok(!marks.some(m => m.t === bars[9].t), 'a later bar took the high before confirmation');
  assert.deepEqual(marks, [{ t: bars[10].t, kind: 'bear', hollow: true }], 'the newer high can have its own hollow arrow');
  // equal high does not take it, but the bar is then not a swing, so the hollow goes when the window ends
  const tied = bars.map(b => Object.assign({}, b));
  tied[10] = { t: bars[10].t, h: 14, l: 13 };
  const tiedDelta = t => ((t - 5000) / 60 === 10 ? 200 : delta[(t - 5000) / 60]);
  assert.equal(CE.divergenceMarks(tied, tiedDelta, Object.assign({ to: 11 }, opt)).some(m => m.hollow && m.t === bars[9].t), true);
  assert.equal(CE.divergenceMarks(tied, tiedDelta, Object.assign({ to: 12 }, opt)).length, 0, 'the window ended and the bar was not a swing');
  // bars before the page opened can be neighbors, but the first swing has to be after the open
  const late = CE.divergenceMarks(bars, atD, Object.assign({}, opt, { from: bars[9].t, to: 12 }));
  assert.equal(late.length, 0);
});

test('divergence pass: price uses MinDivergencePct * 0.01, delta uses MinDivergencePct', () => {
  const highs = [10, 10, 10, 10, 21000, 10, 10, 10, 10, 21000.25, 10, 10];
  const bars = highs.map((h, i) => ({ t: 8000 + i * 60, h, l: h - 1 }));
  const opt = { swing: 2, minBars: 3, minPct: 0.10, from: bars[0].t, to: 12 };
  const at = delta => t => delta[(t - 8000) / 60];
  // priceDiff is far under 0.001. A 5% delta drop does not pass. A 10% drop does.
  assert.equal(CE.divergenceMarks(bars, at([0, 0, 0, 0, 1000, 1000, 1000, 1000, 1000, 950, 950, 950]), opt).length, 0);
  const hit = CE.divergenceMarks(bars, at([0, 0, 0, 0, 1000, 1000, 1000, 1000, 1000, 900, 900, 900]), opt);
  assert.deepEqual(hit.map(m => m.kind + (m.hollow ? ':h' : ':s')), ['bear:s']);
  // priceDiff of 0.001 passes even when the delta change is tiny
  const wide = highs.map((h, i) => ({ t: 8000 + i * 60, h: i === 4 ? 10000 : i === 9 ? 10010 : h, l: 1 }));
  const byPrice = CE.divergenceMarks(wide, at([0, 0, 0, 0, 1000, 1000, 1000, 1000, 1000, 999, 999, 999]), opt);
  assert.equal(byPrice.some(m => m.t === wide[9].t && m.kind === 'bear' && !m.hollow), true);
});

test('bubble radius grows with the square root of size, and groups and floors follow the clock', () => {
  assert.equal(CE.bubbleRadius(50), 5);
  assert.equal(CE.bubbleRadius(50 * 16), 10);
  const book = new CE.LargeBubbles({ coveredFrom: 0, floorAt: t => CE.largeFloor('NQ', t, null) });
  const t = at(10, 30);
  book.add(t, 100, 30, 1);
  book.add(t + 0.05, 102, 30, 1);
  book.flush();
  assert.equal(book.marks.length, 1);
  assert.equal(book.marks[0].size, 60);
  assert.equal(book.marks[0].side, 'buy');
  assert.ok(Math.abs(book.marks[0].price - 101) < 1e-9);
  const apart = new CE.LargeBubbles({ coveredFrom: 0, floorAt: () => 50 });
  apart.add(t, 100, 30, 1);
  apart.add(t + 0.15, 100, 30, 1);
  apart.flush();
  assert.equal(apart.marks.length, 0, '150 ms is two clusters, each under the floor');
  const overnight = new CE.LargeBubbles({ coveredFrom: 0, floorAt: tt => CE.largeFloor('NQ', tt, null) });
  overnight.add(at(18, 0), 100, 25, -1);
  overnight.flush();
  assert.equal(overnight.marks.length, 1);
  assert.equal(overnight.marks[0].side, 'sell');
  const auto = new CE.LargeBubbles({ coveredFrom: 0, auto: true, floorAt: () => 50 });
  auto.add(t, 100, 60, 1);
  auto.flush();
  assert.equal(auto.marks.length, 1, 'under 20 trades the numeric floor stands, and the bubble is kept');
  for (let i = 0; i < 18; i++) auto.add(t + 1 + i, 100, 10, 1);
  auto.recompute();
  assert.equal(auto.autoFloor, null);
  auto.add(t + 30, 100, 10, 1);
  auto.recompute();
  assert.ok(auto.autoFloor >= 10);
  assert.equal(auto.marks.length, 1, 'the bubble that already qualified stays');
  auto.add(t + 40, 100, 1, 1);
  auto.flush();
  assert.equal(auto.marks.length, 1, 'a print under the new floor is not a bubble');
});

test('absorption takes no chip, and signal settings are per chart', () => {
  const P = LP.Pane;
  let st = P.add(LP.defaultPane('main'), 'vp');
  assert.equal(P.pinFull(st), true);
  st = P.add(st, 'absorb');
  assert.equal(st.ind.absorb.on, true);
  assert.equal(st.ind.absorb.pin, false);
  assert.equal(P.pinned(st), 6);
  assert.equal(P.pin(st, 'absorb', true).ind.absorb.pin, false);
  assert.deepEqual(LP.searchIndicators('vol').map(d => d.id), ['volume', 'vp']);
  const s = { getItem: () => null, setItem() {}, m: new Map() };
  // real storage stand-in
  const mem = new Map();
  const store = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); } };
  const p = LP.create(store);
  assert.equal(LP.signalChartKey('NQ', 'm1'), 'NQ|m1');
  assert.equal(LP.signalChartKey('NQ', 'range', 40), 'NQ|range:40');
  assert.deepEqual(p.absorbSpec('NQ', 'm1'), CE.ABSORB_SPEC && { lookback: 20, volumeMult: 1.8, rejection: 0.35, windowMs: 500 });
  assert.equal(p.setAbsorbSpec('NQ', 'm1', null, { lookback: 12 }), true);
  assert.equal(p.absorbSpec('NQ', 'range', 40).lookback, 20, 'a 40 range chart keeps the default');
  assert.equal(p.absorbSpec('NQ', 'm1').lookback, 12);
  assert.equal(p.divergence('main').on, false);
  assert.equal(p.setDivergence('main', { on: true, swing: 2 }), true);
  assert.deepEqual([p.divergence('main').on, p.divergence('main').swing], [true, 2]);
  assert.equal(p.setTapeFloor('NQ', 'rth', 60), true);
  assert.equal(p.tapeFloors().NQ.rth, 60);
  assert.equal(p.tapeFloors().NQ.eth, 25);
  assert.equal(s && p.bubbleAuto('NQ'), false);
  assert.equal(p.setBubbleAuto('NQ', true), true);
  assert.equal(LP.create(store).bubbleAuto('NQ'), true);
});
