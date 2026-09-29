'use strict';
// VolumeProfile (compute core, unreleased): rows in whole ticks, row grouping, POC tie-break, the CBOT value area,
// the 18:00 ET session reset (also on DST dates), history then live with nothing counted twice, and the cost.
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const CE = require('../src/chart-engine.js');
const BB = require('../live/bar-builder.js');
const { VolumeProfile } = CE;
const U = CE.util;

const SESSION = 18 * 3600;
const et = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s || 0) / 1000;   // wall clock stored as UTC
const T0 = et(2026, 9, 29, 10, 0);                                                   // Tuesday 10:00 ET, mid-session
/** A profile from [price, volume] pairs, one trade each, all in one session. */
function profileOf(pairs, opts) {
  const vp = new VolumeProfile(opts);
  pairs.forEach(([p, v], i) => vp.add(T0 + i, p, v));
  return vp;
}
const table = vp => vp.rows().map(r => [r.price, r.volume]);

test('VolumeProfile is exported like the engine\'s other public pieces', () => {
  assert.equal(typeof CE.VolumeProfile, 'function');
  const vp = new CE.VolumeProfile();
  assert.equal(vp.tick, 0.25);
  assert.equal(vp.rowTicks, 1);
  assert.equal(vp.valueAreaShare, 0.7);
  assert.equal(vp.sessionStart, SESSION);
});

test('empty profile: no rows, no POC, no value area', () => {
  const vp = new VolumeProfile();
  assert.deepEqual(vp.rows(), []);
  assert.equal(vp.total, 0);
  assert.equal(vp.trades, 0);
  assert.equal(vp.empty, true);
  assert.equal(vp.poc(), null);
  assert.equal(vp.valueArea(), null);
  assert.equal(vp.low, null);
  assert.equal(vp.high, null);
  assert.equal(vp.volumeAt(21440.25), 0);
});

test('single trade: POC, VAH and VAL are that price', () => {
  const vp = profileOf([[21440.25, 7]]);
  assert.deepEqual(table(vp), [[21440.25, 7]]);
  assert.deepEqual(vp.poc(), { price: 21440.25, high: 21440.25, volume: 7 });
  const va = vp.valueArea();
  assert.equal(va.val, 21440.25);
  assert.equal(va.vah, 21440.25);
  assert.equal(va.volume, 7);
  assert.equal(vp.low, 21440.25);
  assert.equal(vp.high, 21440.25);
});

test('rows are whole ticks: 21440.25 and 21440.75 are exact, empty ticks between are rows of 0', () => {
  const vp = profileOf([[21440.25, 3], [21440.75, 5], [21440.25, 2], [21441, 1]]);
  // hand-worked: 21440.25 -> 3 + 2 = 5, 21440.50 -> 0 (no trade), 21440.75 -> 5, 21441.00 -> 1
  assert.deepEqual(table(vp), [[21440.25, 5], [21440.5, 0], [21440.75, 5], [21441, 1]]);
  assert.equal(vp.total, 11);
  assert.equal(vp.trades, 4);
  assert.equal(vp.volumeAt(21440.75), 5);
  assert.equal(vp.volumeAt(21440.5), 0);
  assert.equal(vp.volumeAt(21439), 0);
});

test('prices with float noise land on their tick; prices are rebuilt from whole ticks', () => {
  const vp = profileOf([[21440.250000000004, 1], [21440.249999999996, 1], [21440.25, 1]]);
  assert.deepEqual(table(vp), [[21440.25, 3]]);
  // a 0.1 tick: 0.1 + 0.2 is 0.30000000000000004 in floats; the row is 3 ticks and prints as 0.3
  const fx = new VolumeProfile({ tick: 0.1 });
  fx.add(T0, 0.1 + 0.2, 4);
  fx.add(T0 + 1, 1.1 + 2.2, 1);                        // 3.3000000000000003
  assert.equal(fx.rows()[0].price, 0.3);
  assert.equal(fx.rows()[fx.rows().length - 1].price, 3.3);
  assert.equal(fx.volumeAt(0.3), 4);
  assert.equal(fx.volumeAt(3.3), 1);
});

test('row grouping: 4 ticks per row on NQ makes whole-point rows', () => {
  const vp = profileOf([[21440, 1], [21440.25, 2], [21440.75, 4], [21441, 8], [21441.75, 16], [21442.25, 32]], { rowTicks: 4 });
  // hand-worked: row 21440.00-21440.75 = 1 + 2 + 4 = 7; row 21441.00-21441.75 = 8 + 16 = 24; row 21442.00-21442.75 = 32
  assert.deepEqual(vp.rows(), [
    { price: 21440, high: 21440.75, volume: 7 },
    { price: 21441, high: 21441.75, volume: 24 },
    { price: 21442, high: 21442.75, volume: 32 },
  ]);
  assert.equal(vp.volumeAt(21440.5), 7);
  assert.equal(vp.low, 21440);
  assert.equal(vp.high, 21442.75);
  // POC 32 (21442); 70% of 63 = 44.1: up has no rows, down pair 24 + 7 = 31 -> 63. VAL 21440, VAH 21442.75
  assert.equal(vp.poc().price, 21442);
  assert.deepEqual([vp.valueArea().val, vp.valueArea().vah, vp.valueArea().volume], [21440, 21442.75, 63]);
});

test('row grouping rounds down below zero too (floor, not truncation)', () => {
  const vp = profileOf([[-0.25, 1], [-1, 1], [-1.25, 1], [0, 1]], { rowTicks: 4 });
  // ticks -1 and -4 are in row -1 (-1.00 to -0.25), tick -5 in row -2 (-2.00 to -1.25), tick 0 in row 0
  assert.deepEqual(vp.rows().map(r => [r.price, r.high, r.volume]), [[-2, -1.25, 1], [-1, -0.25, 2], [0, 0.75, 1]]);
});

test('bad options are refused, not quietly replaced', () => {
  assert.throws(() => new VolumeProfile({ rowTicks: 0 }), RangeError);
  assert.throws(() => new VolumeProfile({ rowTicks: 1.5 }), RangeError);
  assert.throws(() => new VolumeProfile({ tick: 0 }), RangeError);
  assert.throws(() => new VolumeProfile({ valueArea: 0 }), RangeError);
  assert.throws(() => new VolumeProfile({ valueArea: 1.2 }), RangeError);
  assert.throws(() => profileOf([[1, 1]]).valueArea(70), RangeError);   // a share, not a percent
});

test('bad trades are left out and counted', () => {
  const vp = new VolumeProfile();
  vp.add(T0, NaN, 1); vp.add(T0, 100, 0); vp.add(T0, 100, -2); vp.add(NaN, 100, 1); vp.add(T0, 100, Infinity);
  vp.add(T0, 100, 2);
  vp.add(T0, 1e12, 1);                                 // a stray price: the profile would need over a million rows
  assert.deepEqual([vp.trades, vp.total, vp.skipped], [1, 2, 6]);
  assert.deepEqual(table(vp), [[100, 2]]);
  vp.reset();
  vp.add(T0, 100, 0); vp.add(T0, 100, 2);
  assert.equal(vp.skipped, 1);
  assert.deepEqual(table(vp), [[100, 2]]);
});

test('POC tie-break: the tied row closest to the middle of the profile', () => {
  // 100.00, 100.50 and 101.00 all hold 10; the middle of 100.00..101.00 is 100.50
  assert.equal(profileOf([[100, 10], [100.25, 5], [100.5, 10], [100.75, 5], [101, 10]]).poc().price, 100.5);
  // 100.00 and 100.75 hold 9; the middle is 100.50, so 100.75 (1 tick away) beats 100.00 (2 ticks away)
  assert.equal(profileOf([[100, 9], [100.25, 1], [100.5, 1], [100.75, 9], [101, 1]]).poc().price, 100.75);
  // 100.25 and 100.75 hold 9, both 1 tick from the middle (100.50): the lower one
  assert.equal(profileOf([[100, 3], [100.25, 9], [100.5, 1], [100.75, 9], [101, 3]]).poc().price, 100.25);
  // two rows only, tied: both half a row from the middle, so the lower
  assert.equal(profileOf([[200, 4], [200.25, 4]]).poc().price, 200);
  // no tie: the most volume wins wherever it is
  assert.equal(profileOf([[100, 11], [100.25, 5], [100.5, 10], [100.75, 5], [101, 10]]).poc().price, 100);
});

test('value area, hand-worked: exactly 70 of 100 is enough', () => {
  // rows 100.00:5 100.25:10 100.50:20 100.75:40 101.00:15 101.25:5 101.50:5, total 100, 70% = 70
  // POC 100.75 (40). Up pair 101.00 + 101.25 = 20, down pair 100.50 + 100.25 = 30: add down -> 70. Done.
  const vp = profileOf([[100, 5], [100.25, 10], [100.5, 20], [100.75, 40], [101, 15], [101.25, 5], [101.5, 5]]);
  const va = vp.valueArea();
  assert.equal(va.poc.price, 100.75);
  assert.equal(va.val, 100.25);
  assert.equal(va.vah, 100.75);
  assert.equal(va.volume, 70);
  assert.equal(va.share, 0.7);
});

test('value area, hand-worked: pairs, a side with one row left, then the other side', () => {
  // rows 200.00:30 200.25:50 200.50:10 200.75:10 201.00:20, total 120, 70% = 84
  // POC 200.25 (50). Up pair 200.50 + 200.75 = 20; down has one row, 200.00 = 30: add down -> 80.
  // Down is used up; up pair 20 -> 100 >= 84. VAL 200.00, VAH 200.75.
  // (Adding one row at a time would stop at 200.50 with 90: the pairs matter.)
  const va = profileOf([[200, 30], [200.25, 50], [200.5, 10], [200.75, 10], [201, 20]]).valueArea();
  assert.deepEqual([va.val, va.vah, va.volume], [200, 200.75, 100]);
});

test('value area, hand-worked: equal pairs add both', () => {
  // rows 10.00:5 10.25:5 10.50:30 10.75:4 11.00:6, total 50, 70% = 35
  // POC 10.50 (30). Up pair 4 + 6 = 10, down pair 5 + 5 = 10: equal, both -> 50. VAL 10.00, VAH 11.00.
  const va = profileOf([[10, 5], [10.25, 5], [10.5, 30], [10.75, 4], [11, 6]]).valueArea();
  assert.deepEqual([va.val, va.vah, va.volume], [10, 11, 50]);
});

test('value area, hand-worked: ticks with no trades count as rows of 0', () => {
  // rows 50.00:10 50.25:0 50.50:40 50.75:0 51.00:0 51.25:30, total 80, 70% = 56
  // POC 50.50 (40). Up pair 0 + 0 = 0, down pair 0 + 10 = 10: down -> 50. Down used up: up pair 0 -> 50 (VAH 51.00).
  // Up has one row left, 51.25 = 30 -> 80. VAL 50.00, VAH 51.25.
  const va = profileOf([[50, 10], [50.5, 40], [51.25, 30]]).valueArea();
  assert.deepEqual([va.val, va.vah, va.volume], [50, 51.25, 80]);
});

test('value area share is configurable per profile and per call', () => {
  // rows 100.00:5 100.25:10 100.50:20 100.75:40 101.00:15 101.25:5 101.50:5 (total 100)
  const pairs = [[100, 5], [100.25, 10], [100.5, 20], [100.75, 40], [101, 15], [101.25, 5], [101.5, 5]];
  // 40%: POC alone is 40 -> 100.75 to 100.75
  let va = profileOf(pairs, { valueArea: 0.4 }).valueArea();
  assert.deepEqual([va.val, va.vah, va.volume], [100.75, 100.75, 40]);
  const vp = profileOf(pairs);
  // 80%: 40, down 30 -> 70; next up pair 15 + 5 = 20, down has one row, 100.00 = 5: up -> 90. VAL 100.25, VAH 101.25
  va = vp.valueArea(0.8);
  assert.deepEqual([va.val, va.vah, va.volume], [100.25, 101.25, 90]);
  // 100%: the whole profile
  va = vp.valueArea(1);
  assert.deepEqual([va.val, va.vah, va.volume], [100, 101.5, 100]);
  assert.equal(vp.valueArea().share, 0.7);             // the default is untouched
});

test('value area with grouped rows: VAH is the top tick of the highest row', () => {
  // rowTicks 2: rows 100.00-100.25:10, 100.50-100.75:50, 101.00-101.25:20, total 80, 70% = 56
  // POC row 100.50 (50). Up has one row (20), down one row (10): up -> 70. VAL 100.50, VAH 101.25
  const va = profileOf([[100, 4], [100.25, 6], [100.5, 25], [100.75, 25], [101, 20]], { rowTicks: 2 }).valueArea();
  assert.deepEqual([va.poc.price, va.poc.high, va.val, va.vah, va.volume], [100.5, 100.75, 100.5, 101.25, 70]);
});

test('session: the profile empties exactly at 18:00 ET', () => {
  const vp = new VolumeProfile({ tick: 0.25 });
  assert.equal(vp.add(et(2026, 9, 29, 17, 59, 59) + 0.999, 21440.25, 5), true); // first trade: a session starts
  assert.equal(vp.add(et(2026, 9, 29, 16, 0), 21441, 1), false);
  assert.equal(vp.total, 6);
  const before = vp.day;
  assert.equal(vp.add(et(2026, 9, 29, 18, 0, 0), 21450, 2), true);            // 18:00:00.000 is the new session
  assert.equal(vp.day, before + 1);
  assert.equal(vp.day, U.tradeDay(et(2026, 9, 30, 9, 30), SESSION));          // the same day the engine's VWAP uses
  assert.deepEqual(table(vp), [[21450, 2]]);
  assert.equal(vp.total, 2);
  // a late trade from the session before is left out, never folded in
  assert.equal(vp.add(et(2026, 9, 29, 17, 59, 59) + 0.999, 21440.25, 5), false);
  assert.equal(vp.total, 2);
  assert.equal(vp.skipped, 1);
});

test('session: the 18:00 ET boundary holds on both 2026 DST dates (times made the page\'s way, by zoneSeconds)', () => {
  const Z = unixMs => U.zoneSeconds(unixMs / 1000);                           // ChartBridge sends ET wall clock
  // DST ends Sunday 1 Nov 2026: 18:00 EST is 23:00 UTC
  const nov = new VolumeProfile();
  nov.add(Z(Date.UTC(2026, 10, 1, 21, 0, 0)), 21400, 1);                    // Sunday 1 Nov 16:00 EST
  assert.equal(nov.add(Z(Date.UTC(2026, 10, 1, 22, 0, 0)), 21410, 1), false);     // 17:00 EST (18:00 on summer time)
  assert.equal(nov.add(Z(Date.UTC(2026, 10, 1, 22, 59, 59) + 999), 21420, 1), false);   // 17:59:59.999 EST
  assert.equal(nov.trades, 3);
  assert.equal(nov.add(Z(Date.UTC(2026, 10, 1, 23, 0, 0)), 21430, 4), true);      // 18:00:00 EST: new session
  assert.deepEqual(table(nov), [[21430, 4]]);
  assert.equal(nov.day, U.tradeDay(et(2026, 11, 2, 9, 30), SESSION));
  // DST starts Sunday 8 Mar 2026: 18:00 EDT is 22:00 UTC
  const mar = new VolumeProfile();
  mar.add(Z(Date.UTC(2026, 2, 8, 21, 0, 0)), 21000, 1);                     // Sunday 8 Mar 17:00 EDT
  assert.equal(mar.add(Z(Date.UTC(2026, 2, 8, 21, 59, 59) + 999), 21010, 1), false);   // 17:59:59.999 EDT
  assert.equal(mar.trades, 2);
  assert.equal(mar.add(Z(Date.UTC(2026, 2, 8, 22, 0, 0)), 21020, 3), true);       // Sunday 18:00:00 EDT: new session
  assert.deepEqual(table(mar), [[21020, 3]]);
  assert.equal(mar.day, U.tradeDay(et(2026, 3, 9, 9, 30), SESSION));
});

test('session: advance(t) moves to the new session on the clock, before its first trade', () => {
  const vp = profileOf([[21440, 5]]);
  const v0 = vp.version;
  assert.equal(vp.advance(et(2026, 9, 29, 17, 59, 59)), false);              // same session: nothing happens
  assert.equal(vp.total, 5);
  assert.equal(vp.advance(et(2026, 9, 29, 18, 0)), true);
  assert.equal(vp.total, 0);
  assert.deepEqual(vp.rows(), []);
  assert.notEqual(vp.version, v0);
  assert.equal(vp.add(et(2026, 9, 29, 17, 30), 21440, 5), false);            // the old session's trade is left out
  assert.equal(vp.total, 0);
  assert.equal(vp.add(et(2026, 9, 29, 18, 0, 1), 21460, 2), false);          // same session as advance: not new again
  assert.deepEqual(table(vp), [[21460, 2]]);
});

/* Deterministic sample trades: a random walk over two sessions (Monday 12:00 ET to Tuesday 12:00 ET). */
function sampleTrades(n) {
  let s = 12345, p = 85760;                              // ticks of 0.25: 21440.00
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const t0 = et(2026, 9, 28, 12, 0), out = [];
  for (let i = 0; i < n; i++) {
    p += Math.floor(rnd() * 5) - 2;
    out.push([t0 + i * (86400 / n), p * 0.25, 1 + Math.floor(rnd() * 9)]);
  }
  return out;
}
/** The expected profile, counted the slow and obvious way: the last session only, by whole tick, in a Map. */
function reference(trades) {
  const lastDay = U.tradeDay(trades[trades.length - 1][0], SESSION), m = new Map();
  for (const [t, p, v] of trades) if (U.tradeDay(t, SESSION) === lastDay) { const k = Math.round(p / 0.25); m.set(k, (m.get(k) || 0) + v); }
  const lo = Math.min(...m.keys()), hi = Math.max(...m.keys()), rows = [];
  for (let k = lo; k <= hi; k++) rows.push([k * 0.25, m.get(k) || 0]);
  return rows;
}

test('history then live, the page\'s way: nothing counted twice or missed', () => {
  const all = sampleTrades(20000);
  const expected = reference(all);
  const split = 12000;                                   // the backfill ends mid-session; live ticks follow
  // backfill: ChartBridge sends [[t, p, v], ...] chunks into the page's TickStore; at `ready`, feed the store
  const store = new BB.TickStore();
  for (let i = 0; i < split; i += 5000) store.pushAll(all.slice(i, Math.min(split, i + 5000)));
  const vp = new VolumeProfile();
  store.feed(vp, 0);
  // live: each tick goes into the store once and into the profile once (onTick)
  for (let i = split; i < all.length; i++) { const [t, p, v] = all[i]; store.push(t, p, v); vp.add(t, p, v); }
  assert.deepEqual(table(vp), expected);
  assert.equal(vp.total, expected.reduce((a, r) => a + r[1], 0));
  // a rebuild (switching views, a reconnect) makes a new profile from the store: the same numbers
  const again = new VolumeProfile();
  store.feed(again, 0);
  assert.deepEqual(table(again), expected);
  assert.deepEqual(again.valueArea(), vp.valueArea());
  // feeding only from this session's start (minT) skips the older session and gives the same profile
  const fromSession = new VolumeProfile();
  store.feed(fromSession, 0, BB.sessionStartOf(all[all.length - 1][0], SESSION));
  assert.deepEqual(table(fromSession), expected);
  assert.equal(fromSession.trades, vp.trades);
  // and the same as adding every trade directly
  assert.deepEqual(table(new VolumeProfile().addAll(all)), expected);
});

test('cost: 500,000 trades add in O(1) each; POC and value area stay cheap (generous bounds)', () => {
  const n = 500000, trades = sampleTrades(n);
  const oneSession = trades.map(([, p, v], i) => [T0 + i * 0.007, p, v]);   // one session: 10:00 to about 10:58 ET
  const vp = new VolumeProfile();
  let t = performance.now();
  for (let i = 0; i < n; i++) { const x = oneSession[i]; vp.add(x[0], x[1], x[2]); }
  const addMs = performance.now() - t;
  assert.equal(vp.trades, n);
  t = performance.now();
  vp._cache = null; const va = vp.valueArea(); const poc = vp.poc();
  const vaMs = performance.now() - t;
  assert.ok(va.volume >= 0.7 * vp.total && poc.volume > 0);
  assert.ok(addMs < 2000, '500k adds took ' + addMs.toFixed(1) + ' ms');
  assert.ok(vaMs < 50, 'POC and value area took ' + vaMs.toFixed(2) + ' ms');
  // cached until the next trade
  assert.equal(vp.valueArea(), va);
  vp.add(oneSession[0][0], oneSession[0][1], 1);
  assert.notEqual(vp.valueArea(), va);
});
