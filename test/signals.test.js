'use strict';
// Chart signals (G1c): absorption bars (Anthony's AbsorptionTradeCombo), delta divergence arrows (his
// DeltaDivergenceSignal v1.0) and large-order bubbles, on hand-built bars and trades. Made-up numbers only, never market
// data.
const test = require('node:test');
const assert = require('node:assert/strict');
const CE = require('../src/chart-engine.js');
const { LivePrefs: LP } = require('../live/live.js');

const et = (h, mi, s) => Date.UTC(2026, 9, 1, h, mi, 0) / 1000 + (s || 0);   // Thursday 1 Oct 2026, New York wall clock
const bar = (t, o, h, l, c, v) => ({ t, o, h, l, c, v });
/* 21 quiet bars of volume 100 a minute apart from t0, then the bar under test (so CurrentBar is 21, LookbackPeriod + 1). */
function history(t0, n) { const out = []; for (let i = 0; i < (n || 21); i++) out.push(bar(t0 + i * 60, 100, 101, 99, 100, 100)); return out; }
const floor100 = () => 100;
function abs(settings) { return new CE.Absorption({ settings, floorAt: floor100, tick: 0.25 }); }

/* ---------------------------------------------------------------- absorption: the rule (absorptionAt) */
test('absorption: the three conditions on one bar, as AbsorptionTradeCombo judges it', () => {
  const S = CE.ABSORPTION_DEFAULTS, t0 = et(10, 0);
  assert.deepEqual(S, { LookbackPeriod: 20, VolumeMultiplier: 1.8, RejectionZone: 0.35, AggregationWindowMs: 500, TickTolerance: 0 });
  const bars = history(t0);
  const buy = { fired: true, bull: true, vol: 120 }, sell = { fired: true, bull: false, vol: 120 };
  // volume 180 = 1.8 x the average of the 20 before it (100); close in the top 35% (ratio 0.65 counts)
  bars.push(bar(t0 + 21 * 60, 100, 110, 100, 106.5, 180));
  assert.equal(CE.absorptionAt(bars, 21, buy, S), 1, 'bullish: spike, close ratio 0.65, a large buy');
  assert.equal(CE.absorptionAt(bars, 21, sell, S), 0, 'the large trade must be a buy for a bullish bar');
  assert.equal(CE.absorptionAt(bars, 21, { fired: false, bull: true, vol: 0 }, S), 0, 'no large trade: nothing');
  bars[21].v = 179;
  assert.equal(CE.absorptionAt(bars, 21, buy, S), 0, 'volume 1.79 x the average is no spike');
  bars[21].v = 180; bars[21].c = 106.25;
  assert.equal(CE.absorptionAt(bars, 21, buy, S), 0, 'close ratio 0.625: not in the top 35%');
  // bearish: close in the bottom 35% with a large sell
  bars[21] = bar(t0 + 21 * 60, 108, 110, 100, 103.5, 200);
  assert.equal(CE.absorptionAt(bars, 21, sell, S), -1, 'bearish: ratio 0.35, a large sell');
  assert.equal(CE.absorptionAt(bars, 21, buy, S), 0, 'a large buy on a bearish close: nothing');
  bars[21].c = 103.75;
  assert.equal(CE.absorptionAt(bars, 21, sell, S), 0, 'ratio 0.375: not in the bottom 35%');
  // no range, too few bars before it
  bars[21] = bar(t0 + 21 * 60, 100, 100, 100, 100, 500);
  assert.equal(CE.absorptionAt(bars, 21, buy, S), 0, 'a bar with no range is never judged');
  bars[21] = bar(t0 + 21 * 60, 100, 110, 100, 110, 500);
  assert.equal(CE.absorptionAt(bars, 20, buy, S), 0, 'CurrentBar 20 < LookbackPeriod + 1: not yet');
  assert.equal(CE.absorptionAt(bars, 21, buy, S), 1);
  // the settings are the file's own: a shorter lookback, a lower multiplier, a narrower zone
  const S2 = Object.assign({}, S, { LookbackPeriod: 5, VolumeMultiplier: 1.2, RejectionZone: 0.1 });
  const b2 = history(t0, 6).concat(bar(t0 + 6 * 60, 100, 110, 100, 108, 130));
  assert.equal(CE.absorptionAt(b2, 6, buy, S2), 0, 'ratio 0.8 is not in the top 10%');
  b2[6].c = 109; assert.equal(CE.absorptionAt(b2, 6, buy, S2), 1, 'ratio 0.9 is');
});

/* ---------------------------------------------------------------- absorption: the tape and the bars */
/* Feed trades [t, p, v, s] into bar `barT` of `bars` (the bar's volume, high, low and close follow, as the page's builder). */
function feed(a, bars, trades) {
  for (const [t, p, v, s] of trades) {
    let b = bars[bars.length - 1];
    if (!b || t >= b.t + 60) { b = bar(Math.floor(t / 60) * 60, p, p, p, p, 0); bars.push(b); }
    b.h = Math.max(b.h, p); b.l = Math.min(b.l, p); b.c = p; b.v += v;
    a.add(t, p, v, s, b.t, bars);
  }
}
test('absorption: prints of one side at one price within 500 ms add up to a large trade, others do not', () => {
  const t0 = et(10, 0), T = t0 + 21 * 60;
  const run = trades => { const a = abs(), bars = history(t0); a.add(t0 - 1, 100, 1, 1, t0 - 60, bars); feed(a, bars, trades); return a.track; };
  assert.equal(run([[T, 100, 60, 1], [T + 0.4, 100, 40, 1]]).fired, true, '60 + 40 within 400 ms: 100');
  assert.deepEqual(run([[T, 100, 60, 1], [T + 0.4, 100, 40, 1]]), { fired: true, bull: true, vol: 100 });
  assert.equal(run([[T, 100, 60, 1], [T + 0.5, 100, 40, 1]]).fired, true, 'exactly 500 ms after the first: still in');
  assert.equal(run([[T, 100, 60, 1], [T + 0.501, 100, 40, 1]]).fired, false, '501 ms after the first: a new order');
  assert.equal(run([[T, 100, 60, 1], [T + 0.1, 100.25, 40, 1]]).fired, false, 'another price (TickTolerance 0): a new order');
  assert.equal(run([[T, 100, 60, 1], [T + 0.1, 100, 40, -1]]).fired, false, 'the other side: a new order');
  assert.equal(run([[T, 100, 60, 1], [T + 0.1, 100, 5, 0], [T + 0.2, 100, 40, 1]]).fired, true, 'an unknown side in between is left out, as the file\'s trade between bid and ask');
  assert.equal(run([[T, 100, 99, -1]]).fired, false, '99 alone: under the floor');
  assert.deepEqual(run([[T, 100, 150, -1]]), { fired: true, bull: false, vol: 150 }, 'one print of 150: a large sell');
  // the window counts from the order's first print, not the last
  assert.equal(run([[T, 100, 30, 1], [T + 0.3, 100, 30, 1], [T + 0.6, 100, 40, 1]]).fired, false, '30 + 30 + 40 over 600 ms: the third starts a new order');
  // once it reaches the floor it counts, and the next print starts a new order (the file's flush in OnBarUpdate)
  assert.deepEqual(run([[T, 100, 100, 1], [T + 0.1, 100, 80, 1]]), { fired: true, bull: true, vol: 100 }, '100 then 80: the 80 is a new order, under the floor');
  // TickTolerance from the settings
  const a = new CE.Absorption({ settings: { TickTolerance: 1 }, floorAt: floor100, tick: 0.25 }), bars = history(t0);
  a.add(t0 - 1, 100, 1, 1, t0 - 60, bars); feed(a, bars, [[T, 100, 60, 1], [T + 0.1, 100.25, 40, 1]]);
  assert.equal(a.track.fired, true, 'TickTolerance 1: one tick away still adds up');
});

test('absorption: two large prints in one bar: the latest gives the direction, the largest the size; the bar\'s first tick resets', () => {
  const t0 = et(10, 0), T = t0 + 21 * 60, a = abs(), bars = history(t0);
  a.add(t0 - 1, 100, 1, 1, t0 - 60, bars);              // the page opened before these bars' start
  feed(a, bars, [[T + 1, 100, 300, 1], [T + 5, 100, 120, -1]]);
  assert.deepEqual(a.track, { fired: true, bull: false, vol: 300 }, 'a buy of 300 then a sell of 120: bearish, 300');
  feed(a, bars, [[T + 9, 99, 5, 1], [T + 30, 104, 5, 1]]);
  // the bar closes at 104 in a range 99 to 104: ratio 1, bullish, but the latest large print was a sell: nothing
  feed(a, bars, [[T + 60, 104, 1, 1]]);
  assert.equal(a.painted.length, 0, 'bullish close, bearish large trade: not painted');
  assert.deepEqual(a.track, { fired: false, bull: false, vol: 0 }, 'the next bar starts with nothing');
  // a sell then a buy: the buy decides
  const b = abs(), bb = history(t0);
  b.add(t0 - 1, 100, 1, 1, t0 - 60, bb);
  feed(b, bb, [[T + 1, 100, 120, -1], [T + 5, 99, 110, 1], [T + 20, 104, 5, 1], [T + 61, 104, 1, 1]]);
  assert.deepEqual(b.painted.map(p => [p.t, p.dir, p.vol]), [[T, 1, 120]], 'painted cyan, the size the largest (120)');
  // the new bar's first tick can itself be a large print: it counts for the new bar only
  const c = abs(), cb = history(t0);
  c.add(t0 - 1, 100, 1, 1, t0 - 60, cb);
  feed(c, cb, [[T + 1, 100, 120, 1], [T + 61, 100, 200, -1]]);
  assert.deepEqual(c.track, { fired: true, bull: false, vol: 200 });
});

test('absorption: the outline while the bar forms, painted at the close only if the three still hold then', () => {
  const t0 = et(10, 0), T = t0 + 21 * 60;
  const a = abs(), bars = history(t0);
  a.add(t0 - 1, 100, 1, 1, t0 - 60, bars);
  feed(a, bars, [[T, 100, 20, 1], [T + 1, 99, 30, 1], [T + 2, 104, 140, 1]]);   // volume 190, range 99 to 104, close 104
  assert.equal(a.forming(bars), 1, 'all three hold now: the cyan outline');
  feed(a, bars, [[T + 30, 100.5, 10, -1]]);                                        // close falls to the middle
  assert.equal(a.forming(bars), 0, 'close ratio 0.3: the outline goes');
  feed(a, bars, [[T + 40, 104, 10, 1]]);
  assert.equal(a.forming(bars), 1, 'back at the top: the outline again');
  feed(a, bars, [[T + 59, 101, 10, -1]]);                                          // the close it ends on
  feed(a, bars, [[T + 60, 101, 1, 1]]);
  assert.equal(a.painted.length, 0, 'at the close the three no longer held: not painted (Anthony, 2026-10-01)');
  // the same bar ending at the top is painted, and the next bar has no outline
  const b = abs(), bb = history(t0);
  b.add(t0 - 1, 100, 1, 1, t0 - 60, bb);
  feed(b, bb, [[T, 100, 20, 1], [T + 1, 99, 30, 1], [T + 2, 104, 140, 1], [T + 60, 104, 1, 1]]);
  assert.deepEqual(b.painted.map(p => [p.t, p.dir]), [[T, 1]]);
  assert.equal(b.forming(bb), 0);
  // bearish, with a reconstructed sell
  const c = abs(), cb = history(t0);
  c.add(t0 - 1, 100, 1, 1, t0 - 60, cb);
  feed(c, cb, [[T, 104, 20, -1], [T + 1, 105, 30, 1], [T + 2, 100, 80, -1], [T + 2.3, 100, 50, -1], [T + 60, 100, 1, -1]]);
  assert.deepEqual(c.painted.map(p => [p.t, p.dir, p.vol]), [[T, -1, 130]], '80 + 50 at one price in 300 ms: a large sell of 130; closed at the low: yellow');
});

test('absorption: from the page\'s opening only, and the settings are the file\'s', () => {
  const t0 = et(10, 0), T = t0 + 21 * 60, a = abs(), bars = history(t0);
  // the first trade the page sees is inside bar T: that bar started before the page opened and is never painted
  feed(a, bars, [[T + 1, 99, 30, 1], [T + 2, 104, 160, 1], [T + 60, 104, 1, 1]]);
  assert.equal(a.painted.length, 0, 'a bar that started before the page opened: never painted');
  feed(a, bars, [[T + 61, 99, 40, 1], [T + 62, 104, 160, 1], [T + 120, 104, 1, 1]]);
  assert.equal(a.painted.length, 1, 'the next bar, whole since the page opened, is');
  // a longer window joins prints the default would not
  const b = new CE.Absorption({ settings: { AggregationWindowMs: 1500 }, floorAt: floor100 }), bb = history(t0);
  b.add(t0 - 1, 100, 1, 1, t0 - 60, bb);
  feed(b, bb, [[T, 100, 60, 1], [T + 1.2, 100, 40, 1]]);
  assert.equal(b.track.fired, true, '1200 ms apart with a 1500 ms window');
});

/* ---------------------------------------------------------------- bubbles */
test('bubbles: same side prints within 100 ms add up; listed from the floor; the floor by time of day', () => {
  const lp = new CE.LargePrints({ floorAt: t => CE.largeFloorAt({ rth: 100, eth: 50 }, t), tick: 0.25 });
  const T = et(10, 0);
  lp.add(T, 100, 60, 1); lp.add(T + 0.05, 100.25, 40, 1);
  assert.equal(lp.list.length, 1, '60 + 40 within 50 ms: one bubble of 100');
  assert.deepEqual(lp.list[0], { t: T, p: 100.0, v: 100, side: 1, f: 100 }, 'at the volume-weighted price on the tick (100.10 -> 100.00)');
  lp.add(T + 0.09, 100.25, 50, 1);
  assert.equal(lp.list[0].v, 150, 'it grows while the group lasts');
  lp.add(T + 0.101, 100, 90, 1); lp.add(T + 0.15, 100, 9, 1);
  assert.equal(lp.list.length, 1, '101 ms after the first print: a new group (99, under the floor)');
  lp.add(T + 1, 100, 70, -1); lp.add(T + 1.02, 100, 30, 1);
  assert.equal(lp.list.length, 1, 'a print of the other side starts a new group');
  lp.add(T + 2, 100, 70, -1); lp.add(T + 2.02, 100, 3, 0); lp.add(T + 2.05, 100, 30, -1);
  assert.equal(lp.list.length, 2, 'an unknown side is left out and does not break the group');
  assert.equal(lp.list[1].side, -1);
  // the floor by the time of the group's first print: RTH 09:30 to 16:15 ET, overnight the rest
  assert.equal(CE.largeFloorAt({ rth: 100, eth: 50 }, et(9, 29, 59)), 50);
  assert.equal(CE.largeFloorAt({ rth: 100, eth: 50 }, et(9, 30)), 100);
  assert.equal(CE.largeFloorAt({ rth: 100, eth: 50 }, et(16, 14, 59)), 100);
  assert.equal(CE.largeFloorAt({ rth: 100, eth: 50 }, et(16, 15)), 50);
  const n = new CE.LargePrints({ floorAt: t => CE.largeFloorAt({ rth: 100, eth: 50 }, t) });
  n.add(et(20, 0), 100, 60, -1);
  assert.deepEqual(n.list.map(b => [b.v, b.f]), [[60, 50]], 'overnight 60 is large (floor 50)');
  const r = new CE.LargePrints({ floorAt: t => CE.largeFloorAt({ rth: 100, eth: 50 }, t) });
  r.add(et(10, 0), 100, 60, -1);
  assert.equal(r.list.length, 0, 'in RTH 60 is not');
  assert.deepEqual(CE.LARGE_FLOORS, { NQ: { rth: 50, eth: 25 }, ES: { rth: 100, eth: 50 }, MNQ: { rth: 100, eth: 50 }, MES: { rth: 100, eth: 50 } });
});

test('bubbles: Auto takes the session\'s top 1% of group sizes, once it has enough groups', () => {
  const lp = new CE.LargePrints({ floorAt: () => 100, auto: true });
  let T = et(10, 0);
  for (let i = 0; i < CE.LargePrints.AUTO_MIN - 1; i++) { lp.add(T, 100, 1 + (i % 10), i % 2 ? 1 : -1); T += 0.2; }
  assert.equal(lp.floor(T), 100, 'too few groups yet: the fixed floor');
  for (let i = 0; i < 300; i++) { lp.add(T, 100, i % 100 === 0 ? 40 : 1 + (i % 10), i % 2 ? 1 : -1); T += 0.2; }
  const f = lp.floor(T);
  assert.ok(f >= 9 && f <= 40, 'the top 1% of these sizes: ' + f);
  assert.ok(lp.list.every(b => b.v >= f && b.f === f), 'only groups of the session\'s top 1% were listed since');
  lp.add(T, 100, f, 1);
  const lastB = lp.list[lp.list.length - 1];
  assert.deepEqual([lastB.t, lastB.v, lastB.f], [T, f, f], 'a group of that size is shown');
});

/* ---------------------------------------------------------------- divergence */
/* bars from [high, low] pairs a minute apart; the delta from a list */
const barsOf = hl => hl.map(([h, l], i) => bar(et(10, 0) + i * 60, (h + l) / 2, h, l, (h + l) / 2, 100));
function runDiv(hl, deltas, settings) {
  const d = new CE.DeltaDivergence({ settings }), bars = barsOf(hl), steps = [];
  for (let n = 1; n <= bars.length; n++) {
    const view = bars.slice(0, n);
    d.bars = view;                                   // the page's bars grow in place: same array, one bar more
    d.update(view, i => deltas[i] === undefined ? null : deltas[i]);
    steps.push(d.arrows.map(a => (a.dir > 0 ? 'bull' : 'bear') + (a.solid ? '' : ' hollow') + '@' + ((a.t - et(10, 0)) / 60)).join(','));
  }
  return { d, steps };
}
test('divergence: swings confirmed by SwingLookback bars each side; bearish: a higher high with a lower delta', () => {
  assert.deepEqual(CE.DIVERGENCE_DEFAULTS, { SwingLookback: 5, MinBarsBetweenSwings: 3, MinDivergencePct: 0.10 });
  // swing high A at bar 6 (110), swing high B at bar 14 (112); delta at A 500, at B 300
  const hl = [[100, 95], [102, 97], [104, 99], [106, 101], [108, 103], [109, 104], [110, 105], [108, 103], [106, 101], [104, 99], [103, 98], [102, 97],
    [106, 100], [109, 103], [112, 106], [110, 104], [108, 102], [106, 100], [104, 98], [102, 96], [101, 95]];
  const deltas = hl.map((_, i) => i === 6 ? 500 : i === 14 ? 300 : 100);
  const { d, steps } = runDiv(hl, deltas);
  assert.equal(steps[14], '', 'bar 14 still forming: nothing');
  assert.equal(steps[15], 'bear hollow@14', 'bar 14 closed above A with a lower delta: a hollow arrow at once');
  assert.equal(steps[19], 'bear hollow@14', 'still waiting for its fifth lower bar');
  assert.equal(steps[20], 'bear@14', 'bar 19 closed, the fifth after it: confirmed, solid');
  assert.deepEqual(d.arrows.map(a => [a.dir, a.solid]), [[-1, true]]);
  // the same with B's delta higher: no divergence
  const up = runDiv(hl, hl.map((_, i) => i === 6 ? 500 : i === 14 ? 700 : 100));
  assert.equal(up.steps[20], '', 'a higher high with a higher delta: none');
});

test('divergence: the pass rule (price 0.10% or delta 10% of the earlier swing\'s, at least 1) and MinBarsBetweenSwings', () => {
  const hl = [[100, 95], [102, 97], [104, 99], [106, 101], [108, 103], [109, 104], [110, 105], [108, 103], [106, 101], [104, 99], [103, 98], [102, 97],
    [106, 100], [109, 103], [110.05, 106], [109, 104], [108, 102], [106, 100], [104, 98], [102, 96], [101, 95]];
  // price 0.045% higher: the delta must carry it (10% of 500 = 50)
  assert.equal(runDiv(hl, hl.map((_, i) => i === 6 ? 500 : i === 14 ? 451 : 100)).steps[20], '', 'delta 9.8% lower: none');
  assert.equal(runDiv(hl, hl.map((_, i) => i === 6 ? 500 : i === 14 ? 450 : 100)).steps[20], 'bear@14', 'delta 10% lower: counts');
  // an earlier swing's delta near 0: at least 1 (a fall of 0.1 is not enough, 0.1 of 1 is)
  assert.equal(runDiv(hl, hl.map((_, i) => i === 6 ? 0.5 : i === 14 ? 0.45 : 100)).steps[20], '', '0.05 lower than 0.5: 0.05 of 1, under 10%');
  assert.equal(runDiv(hl, hl.map((_, i) => i === 6 ? 0.5 : i === 14 ? 0.39 : 100)).steps[20], 'bear@14', '0.11 lower: 0.11 of 1');
  // price alone: 0.11% higher with the delta 1% lower
  const hl2 = hl.map(x => x.slice()); hl2[14] = [110.2, 106];
  assert.equal(runDiv(hl2, hl.map((_, i) => i === 6 ? 500 : i === 14 ? 495 : 100)).steps[20], 'bear@14', 'price 0.18% higher carries it');
  // MinDivergencePct from the settings
  assert.equal(runDiv(hl, hl.map((_, i) => i === 6 ? 500 : i === 14 ? 451 : 100), { MinDivergencePct: 0.05 }).steps[20], 'bear@14');
  // MinBarsBetweenSwings: two swing highs 6 bars apart pass 3 and fail 7
  const near = [[100, 95], [102, 97], [104, 99], [106, 101], [108, 103], [109, 104], [110, 105], [108, 103], [106, 101], [104, 99], [108, 103], [109, 104],
    [112, 106], [110, 104], [108, 102], [106, 100], [104, 98], [102, 96], [101, 95]];
  const nd = near.map((_, i) => i === 6 ? 500 : i === 12 ? 300 : 100);
  assert.equal(runDiv(near, nd).steps[18], 'bear@12', '6 bars apart, MinBarsBetweenSwings 3');
  assert.equal(runDiv(near, nd, { MinBarsBetweenSwings: 7 }).steps[18], '', 'with 7 the swing is too close to compare');
});

test('divergence: a hollow arrow goes when a later bar takes the high first; the newer bar gets its own', () => {
  const hl = [[100, 95], [102, 97], [104, 99], [106, 101], [108, 103], [109, 104], [110, 105], [108, 103], [106, 101], [104, 99], [103, 98], [102, 97],
    [106, 100], [111, 105], [110, 104], [112, 106], [110, 104], [108, 102], [106, 100], [104, 98], [102, 96], [101, 95]];
  const deltas = hl.map((_, i) => i === 6 ? 500 : i === 13 ? 300 : i === 15 ? 250 : 100);
  const { steps } = runDiv(hl, deltas);
  assert.equal(steps[14], 'bear hollow@13', 'bar 13 beats A with a lower delta: hollow');
  assert.equal(steps[15], 'bear hollow@13', 'bar 14 is lower: it waits');
  assert.equal(steps[16], 'bear hollow@15', 'bar 15 took the high first: 13\'s arrow goes, 15 gets its own');
  assert.equal(steps[21], 'bear@15', 'confirmed after five lower bars');
  // one that loses its delta edge at the close is never shown; a delta taken by a later swing: removed at confirmation
  const eq = runDiv(hl, hl.map((_, i) => i === 6 ? 500 : i === 13 ? 300 : i === 15 ? 600 : 100));
  assert.equal(eq.steps[16], '', '15 beats 13 but its delta is above A\'s: 13\'s arrow goes and 15 gets none');
});

test('divergence: bullish on swing lows; no delta (before the page opened) is no swing; a rebuild starts over', () => {
  const hl = [[105, 100], [103, 98], [101, 96], [99, 94], [97, 92], [96, 91], [95, 90], [97, 92], [99, 94], [101, 96], [102, 97], [103, 98],
    [99, 93], [96, 90], [93, 88], [95, 90], [97, 92], [99, 94], [101, 96], [103, 98], [104, 99]];
  const deltas = hl.map((_, i) => i === 6 ? -500 : i === 14 ? -300 : -100);
  const { d, steps } = runDiv(hl, deltas);
  assert.equal(steps[15], 'bull hollow@14');
  assert.equal(steps[20], 'bull@14', 'a lower low with a higher delta: bullish, solid once confirmed');
  assert.equal(d.arrows[0].dir, 1);
  // A had no delta (the page opened after it): B has nothing to compare with
  const none = runDiv(hl, hl.map((_, i) => i < 8 ? undefined : i === 14 ? -300 : -100));
  assert.equal(none.steps[20], '', 'two swings after the page opened are needed');
  // a new bars array (a rebuild) works it out again from its first bar
  const bars = barsOf(hl), dv = new CE.DeltaDivergence();
  dv.update(bars, i => deltas[i]);
  assert.deepEqual(dv.arrows.map(a => [a.dir, a.solid]), [[1, true]]);
  const v = dv.version;
  dv.update(bars.slice(), i => deltas[i]);
  assert.deepEqual(dv.arrows.map(a => [a.dir, a.solid]), [[1, true]], 'the same result from a fresh array');
  assert.notEqual(dv.version, v);
});
