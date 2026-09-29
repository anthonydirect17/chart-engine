'use strict';
// The 1-hour Initial Balance (1.5.3): known answers for the forming phase, the lock at exactly 10:30:00, DST dates,
// straddling bars, history against live parity, missing coverage, weekends and NYSE holidays.
// Times are bar time (New York wall clock stored as if UTC), as everywhere in chart-engine.
const test = require('node:test');
const assert = require('node:assert/strict');
const CE = require('../src/chart-engine.js');
const BB = require('../live/bar-builder.js');
const U = CE.util;

const S = 18 * 3600;
const et = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s || 0) / 1000;
const TUE = [2026, 9, 29];                                   // a regular Tuesday
const at = (h, mi, s) => et(...TUE, h, mi, s);

/* Seeded trades [t, price, volume] every `step` seconds from t0 to t1 (exclusive), a random walk in whole ticks. */
function trades(t0, t1, step, seed, p0) {
  let s = seed || 7, p = p0 || 25000;
  const rnd = () => (s = (s * 48271) % 2147483647) / 2147483647;
  const out = [];
  for (let t = t0; t < t1; t += step) { p = Math.round((p + (rnd() - 0.5) * 3) / 0.25) * 0.25; out.push([+t.toFixed(3), p, 1 + Math.floor(rnd() * 4)]); }
  return out;
}
/* 1-minute bars from trades, the way the live page builds them (BarBuilder, mode time, 60 s). */
function minuteBars(list) { const b = new BB.BarBuilder({ mode: 'time', seconds: 60, sessionStart: S }); for (const [t, p, v] of list) b.add(t, p, v); return b.bars; }
/* NinjaTrader-style history: 1-minute OHLC from the same trades, stamped at the bar start (ChartBridge converts). */
function history(list) { return minuteBars(list).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })); }
/* The answer by hand: max and min of trades from 9:30:00 up to, not including, 10:30:00. */
function truth(list, day) {
  const a = (day || at(0, 0)) + 34200, b = a + 3600;
  const inside = list.filter(x => x[0] >= a && x[0] < b).map(x => x[1]);
  return inside.length ? { high: Math.max(...inside), low: Math.min(...inside) } : null;
}
const hl = ib => ({ high: ib.high, low: ib.low });

test('forming: between 9:30 and 10:30 the IB follows the trades so far, in long dashes from 9:30', () => {
  const ticks = trades(at(8, 0), at(10, 0), 1.5, 11);
  const ib = U.initialBalance(minuteBars(ticks), { asOf: at(10, 0) });
  assert.equal(ib.state, 'forming');
  assert.deepEqual(hl(ib), truth(ticks));
  assert.equal(ib.start, at(9, 30)); assert.equal(ib.end, at(10, 30));
  const lines = U.ibLines(ib);
  assert.deepEqual(lines.map(l => l.name), ['IBH', 'IBL'], 'no "(forming)" suffix: the dash says it (review)');
  assert.deepEqual(lines.map(l => l.price), [ib.high, ib.low]);
  for (const l of lines) {
    assert.deepEqual(l.dash, CE.IB_FORMING_DASH); assert.equal(l.layer, 'ib'); assert.equal(l.from, at(9, 30), 'drawn from 9:30 (Anthony)');
    // a dash of its own: not the prior-day / overnight 6/4, the value area 3/4 or the prior close 2/3
    for (const other of U.levelLines({ pdh: 1, onh: 1, vah: 1, pc: 1 })) assert.notDeepEqual(l.dash, other.dash);
  }
  assert.deepEqual(lines.map(l => l.color), [CE.LEVEL_COLORS.ibHigh, CE.LEVEL_COLORS.ibLow]);
  assert.ok(U.luminance(CE.LEVEL_COLORS.ibHigh) > U.luminance(CE.LEVEL_COLORS.ibLow), 'the IB high is the brighter shade (Anthony)');
  assert.equal(CE.LEVEL_COLORS.ibLow, '#E58BD2', 'orchid stays the base');
  // a new high at 10:05 moves the forming line up
  const more = ticks.concat(trades(at(10, 0), at(10, 5), 1.5, 12, ib.low + 1).map(x => [x[0], Math.max(ib.low, Math.min(x[1], ib.high)), x[2]]), [[at(10, 5), ib.high + 5, 1]]);
  const ib2 = U.initialBalance(minuteBars(more), { asOf: at(10, 5, 1) });
  assert.equal(ib2.high, ib.high + 5);
  assert.equal(ib2.low, ib.low);
});

test('before 9:30 nothing is shown for today; at 9:30 before the first trade still nothing', () => {
  const ticks = trades(at(4, 0), at(9, 29, 59), 2, 3);
  const before = U.initialBalance(minuteBars(ticks), { asOf: at(9, 29, 59.999) });
  assert.equal(before.state, 'before');
  assert.deepEqual(U.ibLines(before), []);
  const open = U.initialBalance(minuteBars(ticks), { asOf: at(9, 30, 0.2) });
  assert.equal(open.state, 'forming');
  assert.equal(open.high, null);
  assert.deepEqual(U.ibLines(open), []);
  // yesterday's IB is never carried into today: at 20:00 the session is tomorrow's, before its 9:30
  const day = trades(at(9, 0), at(16, 0), 5, 9);
  assert.equal(U.initialBalance(minuteBars(day), { asOf: at(20, 0), sessionStart: S }).state, 'before');
  assert.equal(U.initialBalance(minuteBars(day), { asOf: at(17, 59, 59), sessionStart: S }).state, 'locked');   // still today until 18:00
});

test('the lock at exactly 10:30:00: a trade at 10:29:59.999 counts, one at 10:30:00.000 does not', () => {
  const base = trades(at(9, 0), at(10, 29), 2, 5);
  const ref = truth(base);
  const edge = [[at(10, 29, 59.999), ref.high + 10, 1], [at(10, 30, 0), ref.high + 20, 1], [at(10, 30, 0.5), ref.low - 20, 1]];
  const all = base.concat(edge);
  const want = { high: ref.high + 10, low: ref.low };
  // from the trades themselves and from the 1-minute bars built from them
  for (const [name, data, bs] of [['trades', all, 0], ['1m bars', minuteBars(all), 60]]) {
    const forming = U.initialBalance(data, { asOf: at(10, 29, 59.999), barSeconds: bs });
    assert.equal(forming.state, 'forming', name);
    assert.deepEqual(hl(forming), want, name + ' at 10:29:59.999');
    const locked = U.initialBalance(data, { asOf: at(10, 30, 0), barSeconds: bs });
    assert.equal(locked.state, 'locked', name);
    assert.deepEqual(hl(locked), want, name + ' at 10:30:00.000');
    assert.deepEqual(hl(U.initialBalance(data, { asOf: at(15, 0), barSeconds: bs })), want, name + ' later in the day');
  }
  const lines = U.ibLines(U.initialBalance(minuteBars(all), { asOf: at(10, 30) }));
  assert.deepEqual(lines.map(l => l.name), ['IBH', 'IBL']);
  for (const l of lines) assert.deepEqual(l.dash, [], 'solid once locked');
});

test('DST: the window is 9:30 to 10:30 New York time on both sides of each change', () => {
  // Trades stamped in real UTC, converted like ChartBridge does (zoneSeconds, America/New_York)
  const cases = [
    [2026, 3, 6, 5],     // Friday, EST (UTC-5)
    [2026, 3, 9, 4],     // Monday after DST began (Sunday March 8), EDT (UTC-4)
    [2026, 10, 30, 4],   // Friday, EDT
    [2026, 11, 2, 5],    // Monday after DST ended (Sunday November 1), EST
  ];
  for (const [y, mo, d, off] of cases) {
    const utc = (h, mi, s) => Date.UTC(y, mo - 1, d, h + off, mi, s || 0) / 1000;   // New York h:mi as real UTC
    const list = [
      [utc(9, 29, 59), 100], [utc(9, 30, 0), 50], [utc(10, 0, 0), 60], [utc(10, 29, 59.5), 70], [utc(10, 30, 0), 999],
      // 9:30 UTC-4 is 8:30 EST: a fixed offset would take this trade in during winter
      [Date.UTC(y, mo - 1, d, 13, 45) / 1000, off === 5 ? 1 : 55],
    ];
    for (let u = utc(8, 0); u < utc(11, 0); u += 20) list.push([u + 7, 60]);    // a trade every 20 s: no missing minute
    list.forEach(x => { x[0] = U.zoneSeconds(x[0]); x[2] = 1; });
    list.sort((a, b) => a[0] - b[0]);
    const asOf = U.zoneSeconds(utc(11, 0));
    const ib = U.initialBalance(list, { asOf, barSeconds: 0 });
    assert.equal(ib.state, 'locked', y + '-' + mo + '-' + d);
    assert.deepEqual(hl(ib), { high: 70, low: 50 }, y + '-' + mo + '-' + d);
    assert.deepEqual(hl(U.initialBalance(minuteBars(list), { asOf })), { high: 70, low: 50 }, y + '-' + mo + '-' + d + ' from 1m bars');
  }
  // the Sunday evening session of the DST change belongs to Monday's trading day
  assert.equal(U.initialBalance([[et(2026, 3, 8, 18, 0), 1, 1]], { asOf: et(2026, 3, 8, 19, 0), barSeconds: 0 }).start, et(2026, 3, 9, 9, 30));
});

test('a bar that straddles 9:30 or 10:30 never leaks prices from outside the hour', () => {
  // the IB high is 100 inside the hour; price runs to 110 at 10:30:05 and 90 at 9:29
  const list = trades(at(9, 0), at(11, 0), 3, 21, 95).map(([t, p, v]) => [t, Math.max(92, Math.min(100, p)), v]);
  list.push([at(10, 30, 5), 110, 1], [at(9, 29, 10), 90, 1]);
  list.sort((a, b) => a[0] - b[0]);
  const want = truth(list);
  assert.ok(want.high <= 100 && want.low >= 92);
  const m1 = minuteBars(list);
  assert.deepEqual(hl(U.initialBalance(m1, { asOf: at(11, 0) })), want, '1-minute bars');
  // 5- and 15-minute bars start on 9:30 and 10:30 too: exact
  for (const tf of [300, 900]) assert.deepEqual(hl(U.initialBalance(U.aggregate(m1, tf), { asOf: at(11, 0), barSeconds: tf })), want, tf + ' s bars');
  // 1-hour bars (9:00 to 10:00, 10:00 to 11:00) straddle both edges: refused, never a wrong number
  const h1 = U.initialBalance(U.aggregate(m1, 3600), { asOf: at(11, 0), barSeconds: 3600 });
  assert.equal(h1.state, 'inexact'); assert.equal(h1.high, null); assert.deepEqual(U.ibLines(h1), []);
  // 40-minute bars from 8:50: 8:50 to 9:30 ends on the edge (fine), 10:10 to 10:50 crosses 10:30 (refused)
  const b40 = [{ t: at(8, 50), h: 1, l: 1 }, { t: at(9, 30), h: 2, l: 2 }, { t: at(10, 10), h: 3, l: 3 }];
  assert.equal(U.initialBalance(b40, { asOf: at(11, 0), barSeconds: 2400 }).state, 'inexact');
  assert.equal(U.initialBalance(b40.slice(0, 2), { asOf: at(10, 5), barSeconds: 2400 }).state, 'forming');
  // a range bar opened at 10:25 and still open at 10:30:05 holds 110: bars as drawn would say IBH 110
  const rt = [];
  for (let m = 0; m < 85; m++) rt.push([at(9, 0) + m * 60, 60, 1]);                // 9:00 to 10:24 at 60, every minute
  rt.push([at(10, 25), 95, 1]);                                                     // a new range bar opens at 10:25
  for (let m = 26; m < 45; m++) rt.push([at(10, m, 20), 97, 1]);
  rt.push([at(10, 29), 100, 1], [at(10, 30, 5), 110, 1]);
  rt.sort((a, b) => a[0] - b[0]);
  const range = new BB.BarBuilder({ mode: 'range', rangeTicks: 80, rangeMode: 'traded', tick: 0.25, sessionStart: S });
  for (const [t, p, v] of rt) range.add(t, p, v);
  const drawn = range.bars.filter(b => b.t >= at(9, 30) && b.t < at(10, 30));
  assert.equal(drawn.length, 1); assert.equal(drawn[0].h, 110, 'the range bar from 10:25 straddles 10:30');
  assert.deepEqual(hl(U.initialBalance(minuteBars(rt), { asOf: at(11, 0) })), { high: 100, low: 60 }, 'the 1-minute bars give the hour only');
  // seconds bars (15 s and 30 s, built from ticks like the page does) agree too
  for (const sec of [15, 30]) {
    const b = new BB.BarBuilder({ mode: 'time', seconds: sec, sessionStart: S }); for (const [t, p, v] of list) b.add(t, p, v);
    assert.deepEqual(hl(U.initialBalance(b.bars, { asOf: at(11, 0), barSeconds: sec })), want, sec + ' s bars');
  }
});

test('history against live: the same IB from the backfill, from live trades, and after a reload, whenever the page loaded', () => {
  const list = trades(at(6, 0), at(12, 0), 0.7, 42);
  const want = truth(list);
  // live only: every 1-minute bar built from trades as they came
  assert.deepEqual(hl(U.initialBalance(minuteBars(list), { asOf: at(12, 0) })), want);
  // the trades themselves
  assert.deepEqual(hl(U.initialBalance(list, { asOf: at(12, 0), barSeconds: 0 })), want);
  // a page loaded at any minute (in and around the hour): NinjaTrader's 1-minute history up to that minute, then
  // live trades from there, as onReady() seeds D.m1; and the reload later in the day (all history)
  for (let cut = at(9, 20); cut <= at(10, 40); cut += 60) {
    const m1 = new BB.BarBuilder({ mode: 'time', seconds: 60, sessionStart: S });
    m1.seed(history(list.filter(x => x[0] < cut)));
    for (const [t, p, v] of list) if (t >= cut) m1.add(t, p, v);
    const ib = U.initialBalance(m1.bars, { asOf: at(12, 0) });
    assert.deepEqual(hl(ib), want, 'loaded at ' + U.fmtHM(cut));
    // and while forming, from the same load
    const mid = U.initialBalance(m1.bars.filter(b => b.t < at(10, 0)), { asOf: at(10, 0) });
    assert.deepEqual(hl(mid), truth(list.filter(x => x[0] < at(10, 0))), 'forming, loaded at ' + U.fmtHM(cut));
  }
});

test('missing coverage: history starting after 9:30 shows nothing rather than a wrong IB', () => {
  const list = trades(at(9, 45), at(11, 0), 2, 8);
  const ib = U.initialBalance(minuteBars(list), { asOf: at(11, 0) });
  assert.equal(ib.state, 'uncovered'); assert.equal(ib.high, null); assert.deepEqual(U.ibLines(ib), []);
  // starting exactly at 9:30 cannot prove nothing traded just before: also refused
  assert.equal(U.initialBalance(minuteBars(trades(at(9, 30), at(11, 0), 2, 8)), { asOf: at(11, 0) }).state, 'uncovered');
  assert.equal(U.initialBalance(trades(at(9, 30, 0.5), at(11, 0), 2, 8), { asOf: at(11, 0), barSeconds: 0 }).state, 'uncovered');
  // one bar ending at 9:30 (the 9:29 bar) is enough, and so is `from` at or before 9:30
  assert.equal(U.initialBalance(minuteBars(trades(at(9, 29), at(11, 0), 2, 8)), { asOf: at(11, 0) }).state, 'locked');
  assert.equal(U.initialBalance(minuteBars(trades(at(9, 30), at(11, 0), 2, 8)), { asOf: at(11, 0), from: at(9, 30) }).state, 'locked');
  assert.equal(U.initialBalance(minuteBars(trades(at(9, 0), at(11, 0), 2, 8)), { asOf: at(11, 0), from: at(9, 31) }).state, 'uncovered');
  // no data at all
  assert.equal(U.initialBalance([], { asOf: at(11, 0) }).state, 'uncovered');
  // covered, but nothing traded in the hour
  const quiet = trades(at(8, 0), at(9, 20), 5, 2).concat(trades(at(10, 45), at(11, 0), 5, 2));
  assert.equal(U.initialBalance(minuteBars(quiet), { asOf: at(11, 0) }).state, 'empty');
});

test('coverage (review S2): yesterday plus today from 9:45, or a hole inside the hour, shows nothing, never a wrong IB', () => {
  const y = et(2026, 9, 28, 0, 0), yesterday = trades(y + 9 * 3600, y + 16 * 3600, 5, 3);
  // yesterday until 16:00, then today only from 9:45: yesterday's bars do not prove today's 9:30 is there
  const late = minuteBars(yesterday.concat(trades(at(9, 45), at(11, 0), 5, 4)));
  const a = U.initialBalance(late, { asOf: at(11, 0) });
  assert.equal(a.state, 'uncovered'); assert.deepEqual(U.ibLines(a), []);
  // today's overnight session covers 9:30: fine
  assert.equal(U.initialBalance(minuteBars(yesterday.concat(trades(at(0, 30), at(11, 0), 5, 4))), { asOf: at(11, 0) }).state, 'locked');
  // a hole from 9:40 to 10:10 inside the hour: 'gap', nothing drawn (the true IB could be anywhere in it)
  const full = trades(at(8, 0), at(11, 0), 5, 6);
  const holed = minuteBars(full.filter(x => x[0] < at(9, 40) || x[0] >= at(10, 10)));
  for (const asOf of [at(10, 15), at(11, 0)]) {
    const g = U.initialBalance(holed, { asOf });
    assert.equal(g.state, 'gap', U.fmtHM(asOf)); assert.equal(g.high, null); assert.deepEqual(U.ibLines(g), []);
  }
  // before the hole the forming IB is fine; one missing minute at 9:30 itself is a gap too
  assert.equal(U.initialBalance(holed, { asOf: at(9, 40) }).state, 'forming');
  assert.equal(U.initialBalance(minuteBars(full.filter(x => x[0] < at(9, 30) || x[0] >= at(9, 31))), { asOf: at(10, 0) }).state, 'gap');
  // the newest finished minutes must be there too: data that stops at 10:05 while the clock says 10:20 (a feed
  // that went quiet or a page that lost its connection) is not a forming IB
  const stopped = minuteBars(full.filter(x => x[0] < at(10, 5)));
  assert.equal(U.initialBalance(stopped, { asOf: at(10, 5, 30) }).state, 'forming');
  assert.equal(U.initialBalance(stopped, { asOf: at(10, 20) }).state, 'gap');
  // data that stopped before 9:30 (offline since 9:20): minutes missing, not "no trades" (review 2)
  const early = minuteBars(full.filter(x => x[0] < at(9, 20)));
  assert.equal(U.initialBalance(early, { asOf: at(9, 45) }).state, 'gap');
  assert.equal(U.initialBalance(early, { asOf: at(10, 45) }).state, 'gap');
  assert.equal(U.initialBalance(early, { asOf: at(9, 30, 30) }).state, 'forming', 'the first minute may still be waiting for a trade');
  // the minute in progress may still be waiting for its first trade
  assert.equal(U.initialBalance(minuteBars(full.filter(x => x[0] < at(10, 5))), { asOf: at(10, 5, 59) }).state, 'forming');
  // trades have no slots: a list of trades is checked for coverage only
  assert.equal(U.initialBalance(full.filter(x => x[0] < at(9, 40) || x[0] >= at(10, 10)), { asOf: at(11, 0), barSeconds: 0 }).state, 'locked');
});

test('weekends and NYSE holidays have no regular session, so no IB, even with Globex trades in the hour', () => {
  const lockedOn = (y, mo, d) => {
    const t0 = et(y, mo, d, 0, 0);
    return U.initialBalance(minuteBars(trades(t0 - 6 * 3600, t0 + 12 * 3600, 5, 4)), { asOf: t0 + 11 * 3600 });
  };
  // Saturday and Sunday (the Sunday evening session belongs to Monday, before its 9:30)
  assert.equal(lockedOn(2026, 10, 3).state, 'closed');
  assert.equal(lockedOn(2026, 10, 4).state, 'closed');
  assert.equal(U.initialBalance(minuteBars(trades(et(2026, 10, 4, 18, 0), et(2026, 10, 4, 21, 0), 5, 4)), { asOf: et(2026, 10, 4, 21, 0) }).state, 'before');
  // NYSE 2026 full closures (Globex trades on most of them to an early halt)
  for (const [mo, d] of [[1, 1], [1, 19], [2, 16], [4, 3], [5, 25], [6, 19], [7, 3], [9, 7], [11, 26], [12, 25]]) {
    const ib = lockedOn(2026, mo, d);
    assert.equal(ib.state, 'closed', '2026-' + mo + '-' + d);
    assert.deepEqual(U.ibLines(ib), []);
  }
  // early-close days open at 9:30 as usual: an IB
  for (const [mo, d] of [[11, 27], [12, 24]]) assert.equal(lockedOn(2026, mo, d).state, 'locked', '2026-' + mo + '-' + d);
  assert.equal(lockedOn(2026, 9, 29).state, 'locked');
});

test('the NYSE holiday rules give the published calendars', () => {
  const list = y => [...U.nyseHolidays(y)].sort((a, b) => a - b).map(d => new Date(d * 86400000).toISOString().slice(5, 10));
  assert.deepEqual(list(2026), ['01-01', '01-19', '02-16', '04-03', '05-25', '06-19', '07-03', '09-07', '11-26', '12-25']);
  assert.deepEqual(list(2027), ['01-01', '01-18', '02-15', '03-26', '05-31', '06-18', '07-05', '09-06', '11-25', '12-24']);
  // New Year's Day 2022 fell on a Saturday: not moved to Friday December 31, 2021 (the market was open)
  assert.deepEqual(list(2022), ['01-17', '02-21', '04-15', '05-30', '06-20', '07-04', '09-05', '11-24', '12-26']);
  assert.ok(!U.nyseHolidays(2021).has(Date.UTC(2021, 11, 31) / 86400000));
  assert.equal(U.rthDay(et(2026, 9, 29, 10, 0)), true);
  assert.equal(U.rthDay(et(2026, 7, 3, 10, 0)), false);
});
