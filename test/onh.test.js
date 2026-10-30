'use strict';
// ONH and ONL go live then lock, the way the IB does (chart 1.40.0, Sunday 11-01 item 14): the overnight high and low from
// the session's 18:00 ET start up to 9:30:00 ET, live while forming, locked at 9:30, drawn from 18:00 as IBH and IBL are.
// Known answers for forming and locked, the lock at exactly 9:30:00, the Sunday 18:00 open, DST weekends, CME closures,
// NYSE-only holidays, a page loaded mid-session, history against live parity, and no line rather than a wrong one.
// Times are bar time (New York wall clock stored as if UTC), as everywhere in chart-engine. Made-up prices.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CE = require('../src/chart-engine.js');
const BB = require('../live/bar-builder.js');
const U = CE.util;

const S = 18 * 3600;
const et = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s || 0) / 1000;

function trades(t0, t1, step, seed, p0) {
  let s = seed || 7, p = p0 || 25000;
  const rnd = () => (s = (s * 48271) % 2147483647) / 2147483647;
  const out = [];
  for (let t = t0; t < t1; t += step) {
    if (U.cmeClosed(t)) continue;                                   // no trades in the 17:00 break, over a weekend
    p = Math.round((p + (rnd() - 0.5) * 3) / 0.25) * 0.25; out.push([+t.toFixed(3), p, 1 + Math.floor(rnd() * 4)]);
  }
  return out;
}
function minuteBars(list) { const b = new BB.BarBuilder({ mode: 'time', seconds: 60, sessionStart: S }); for (const [t, p, v] of list) b.add(t, p, v); return b.bars; }
function history(list) { return minuteBars(list).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })); }
/* The answer by hand: max and min of the trades from 18:00:00 the evening before up to, not including, 9:30:00. */
function truth(list, start, end, asOf) {
  const inside = list.filter(x => x[0] >= start && x[0] < end && x[0] <= asOf).map(x => x[1]);
  return inside.length ? { high: Math.max(...inside), low: Math.min(...inside) } : null;
}
const hl = on => ({ high: on.high, low: on.low });

test('forming overnight: the high and low so far from 18:00, long dashes from 18:00', () => {
  const ticks = trades(et(2026, 9, 28, 10, 0), et(2026, 9, 29, 3, 0), 2, 11);   // Monday 10:00 to Tuesday 3:00
  const asOf = et(2026, 9, 29, 3, 0);
  const on = U.overnightRange(minuteBars(ticks), { asOf });
  assert.equal(on.state, 'forming');
  assert.equal(on.start, et(2026, 9, 28, 18, 0));
  assert.equal(on.end, et(2026, 9, 29, 9, 30));
  assert.deepEqual(hl(on), truth(ticks, on.start, on.end, asOf));
  const L = U.onLines(on);
  assert.deepEqual(L.map(x => [x.key, x.name, x.color, x.from]), [['onh', 'ONH', CE.LEVEL_COLORS.overnight, on.start], ['onl', 'ONL', CE.LEVEL_COLORS.overnight, on.start]]);
  assert.deepEqual(L[0].dash, [12, 5], 'the IB\'s forming dash');
  assert.deepEqual(L[1].dash, [12, 5]);
  assert.notEqual(L[0].dash, L[1].dash, 'each line its own dash array');
  assert.equal(L[0].layer, undefined, 'shown with Levels');
  // the same trades as trades give the same answer
  assert.deepEqual(hl(U.overnightRange(ticks, { asOf, barSeconds: 0 })), hl(on));
});

test('locked at exactly 9:30:00: a trade at 9:29:59.999 counts, one at 9:30:00 does not; solid from then to 18:00', () => {
  const base = trades(et(2026, 9, 28, 12, 0), et(2026, 9, 29, 9, 29), 3, 5);
  const edge = base.concat([[et(2026, 9, 29, 9, 29, 59.999), 26000, 1], [et(2026, 9, 29, 9, 30, 0), 27000, 1], [et(2026, 9, 29, 9, 31), 20000, 1]]);
  const bars = minuteBars(edge);
  const before = U.overnightRange(bars, { asOf: et(2026, 9, 29, 9, 29, 59.5) });
  assert.equal(before.state, 'forming');
  assert.equal(before.high, 26000);
  const at = U.overnightRange(bars, { asOf: et(2026, 9, 29, 9, 30, 0) });
  assert.equal(at.state, 'locked');
  assert.equal(at.high, 26000, '9:30:00 is not overnight');
  assert.equal(at.low, truth(edge, at.start, at.end, at.end).low, 'the 9:31 low of 20000 is RTH');
  assert.deepEqual(U.onLines(at).map(x => x.dash), [[], []], 'solid once locked');
  const late = U.overnightRange(bars, { asOf: et(2026, 9, 29, 17, 59) });
  assert.equal(late.state, 'locked', 'locked all day until 18:00');
  assert.deepEqual(hl(late), hl(at));
  // 18:00: the next session's overnight forms from nothing
  const next = U.overnightRange(bars, { asOf: et(2026, 9, 29, 18, 0) });
  assert.equal(next.state, 'forming');
  assert.equal(next.start, et(2026, 9, 29, 18, 0));
  assert.equal(next.high, null);
  assert.deepEqual(U.onLines(next), [], 'no line before the first overnight trade');
});

test('the Sunday 18:00 open: Monday\'s overnight runs from Sunday 18:00; Friday\'s bars only prove the history reaches back', () => {
  const fri = trades(et(2026, 10, 9, 9, 30), et(2026, 10, 9, 17, 0), 5, 3, 24000);
  const sun = trades(et(2026, 10, 11, 18, 0), et(2026, 10, 12, 9, 45), 4, 9, 24100);
  const all = fri.concat(sun), bars = minuteBars(all);
  const asOf = et(2026, 10, 11, 23, 0);
  const on = U.overnightRange(bars, { asOf });
  assert.equal(on.state, 'forming');
  assert.equal(on.start, et(2026, 10, 11, 18, 0));
  assert.deepEqual(hl(on), truth(sun, on.start, on.end, asOf), 'Friday\'s prices never count');
  const locked = U.overnightRange(bars, { asOf: et(2026, 10, 12, 10, 0) });
  assert.equal(locked.state, 'locked');
  assert.deepEqual(hl(locked), truth(sun, locked.start, locked.end, locked.end));
  // the weekend itself: no Globex session, no line
  for (const t of [et(2026, 10, 9, 18, 30), et(2026, 10, 10, 12, 0), et(2026, 10, 11, 17, 30)]) {
    const w = U.overnightRange(bars, { asOf: t });
    assert.equal(w.state, 'closed', new Date(t * 1000).toISOString());
    assert.deepEqual(U.onLines(w), []);
  }
  // Friday 17:00 to 18:00 is still Friday's trading day: its locked overnight
  assert.equal(U.overnightRange(bars, { asOf: et(2026, 10, 9, 17, 30) }).state, 'uncovered', 'Friday\'s own overnight is not in this history');
});

test('DST: the Sunday the clocks change (8 March and 1 November 2026) opens at 18:00 New York time as any other', () => {
  for (const [sunday, monday] of [[[2026, 3, 8], [2026, 3, 9]], [[2026, 11, 1], [2026, 11, 2]]]) {
    const fri = [sunday[0], sunday[1], sunday[2] - 2];
    const ticks = trades(et(...fri, 15, 0), et(...fri, 17, 0), 10, 4).concat(trades(et(...sunday, 18, 0), et(...monday, 10, 0), 3, 8, 24500));
    const bars = minuteBars(ticks);
    const on = U.overnightRange(bars, { asOf: et(...monday, 9, 30) });
    assert.equal(on.state, 'locked');
    assert.equal(on.start, et(...sunday, 18, 0));
    assert.equal(on.end, et(...monday, 9, 30));
    assert.equal(on.end - on.start, 15.5 * 3600, 'always 15.5 hours of wall clock');
    assert.deepEqual(hl(on), truth(ticks, on.start, on.end, on.end));
  }
});

test('holidays: no Globex session (Christmas, Good Friday, New Year\'s Day) is no line; an NYSE-only holiday has its overnight', () => {
  // Christmas Friday 25 December 2026: the trading day has no session
  const xmas = U.overnightRange(minuteBars(trades(et(2026, 12, 23, 9, 0), et(2026, 12, 24, 13, 0), 5, 2)), { asOf: et(2026, 12, 25, 3, 0) });
  assert.equal(xmas.state, 'closed');
  assert.deepEqual(U.onLines(xmas), []);
  assert.equal(U.overnightRange([], { asOf: et(2027, 1, 1, 6, 0) }).state, 'closed', 'New Year\'s Day 2027');
  assert.equal(U.overnightRange([], { asOf: et(2026, 4, 3, 6, 0) }).state, 'closed', 'Good Friday 2026');
  // Thanksgiving (NYSE closed, Globex trades from 18:00 the evening before): an overnight as on any day, locked at 9:30
  const ticks = trades(et(2026, 11, 25, 9, 30), et(2026, 11, 26, 11, 0), 4, 6);
  const tg = U.overnightRange(minuteBars(ticks), { asOf: et(2026, 11, 26, 10, 0) });
  assert.equal(tg.state, 'locked');
  assert.deepEqual(hl(tg), truth(ticks, tg.start, tg.end, tg.end));
});

test('a page loaded mid-session: from the history alone when it reaches back before 18:00, else no line (never a wrong one)', () => {
  const ticks = trades(et(2026, 9, 28, 9, 30), et(2026, 9, 29, 4, 0), 2, 13);
  const asOf = et(2026, 9, 29, 4, 0);
  const hist = history(ticks);
  const on = U.overnightRange(hist, { asOf });
  assert.equal(on.state, 'forming');
  assert.deepEqual(hl(on), truth(ticks, on.start, on.end, asOf));
  // history then live: the same answer as the live page built from every trade
  const cut = ticks.findIndex(x => x[0] >= et(2026, 9, 29, 1, 0));
  const b = new BB.BarBuilder({ mode: 'time', seconds: 60, sessionStart: S });
  b.seed(history(ticks.slice(0, cut)));
  for (const [t, p, v] of ticks.slice(cut)) b.add(t, p, v);
  assert.deepEqual(hl(U.overnightRange(b.bars, { asOf })), hl(on), 'history plus live trades: the same high and low');
  // the history starts after 18:00: the start of the overnight is not seen
  const short = hist.filter(x => x.t >= et(2026, 9, 28, 20, 0));
  const un = U.overnightRange(short, { asOf });
  assert.equal(un.state, 'uncovered');
  assert.deepEqual(U.onLines(un), []);
  assert.equal(U.overnightRange(short, { asOf, from: et(2026, 9, 28, 18, 0) }).state, 'forming', 'unless the data is known complete from 18:00');
  // ChartBridge says the data connection was down in the window: trades may be missing, no line
  assert.equal(U.overnightRange(hist, { asOf, dropAt: et(2026, 9, 29, 2, 0) }).state, 'gap');
  assert.equal(U.overnightRange(hist, { asOf, dropAt: et(2026, 9, 28, 15, 0) }).state, 'forming', 'a drop before 18:00 is not this overnight\'s');
  // a bar across 18:00 or 9:30 cannot be split: no values
  const hour = [{ t: et(2026, 9, 28, 17, 30), o: 1, h: 2, l: 1, c: 1 }, { t: et(2026, 9, 28, 18, 30), o: 1, h: 2, l: 1, c: 1 }];
  assert.equal(U.overnightRange(hour, { asOf, barSeconds: 3600 }).state, 'inexact');
  // locked with no trade in the window
  const none = U.overnightRange(hist.filter(x => x.t < et(2026, 9, 28, 18, 0) || x.t >= et(2026, 9, 29, 9, 30)), { asOf: et(2026, 9, 29, 10, 0) });
  assert.equal(none.state, 'empty');
  assert.deepEqual(U.onLines(none), []);
  assert.deepEqual(U.onLines(null), []);
});

test('onLines takes the page\'s overnight color; sessionLevels and levelLines are as they were', () => {
  const on = { state: 'locked', high: 102, low: 98, start: et(2026, 9, 28, 18, 0) };
  assert.deepEqual(U.onLines(on, { overnight: '#abcdef' }).map(x => x.color), ['#ABCDEF', '#ABCDEF']);
  assert.deepEqual(U.onLines(on, { overnight: 'blue' }).map(x => x.color), [CE.LEVEL_COLORS.overnight, CE.LEVEL_COLORS.overnight]);
  const L = U.levelLines({ pdh: 104, pdl: 96, pc: 100, onh: 103, onl: 97, vah: null, val: null, poc: null });
  assert.deepEqual(L.find(x => x.key === 'onh').dash, [6, 4], 'levelLines keeps its own 6/4 for a caller that passes onh');
});

test('the live page: ONH and ONL from overnightRange, live on trades and the clock, out of the full-width levels', () => {
  const live = fs.readFileSync(path.join(__dirname, '..', 'live', 'live.js'), 'utf8');
  assert.match(live, /if \(lv\) \{ lv\.onh = null; lv\.onl = null; \}/, 'the prior session\'s lines no longer carry ONH and ONL');
  assert.match(live, /U\.overnightRange\(D\.m1\.bars, \{ asOf: etNow\(\), sessionStart: SESSION, barSeconds: 60, dropAt \}\)/);
  assert.match(live, /D\.on\.state === 'forming' && t >= D\.on\.start && t < D\.on\.end && \(D\.on\.high === null \|\| p > D\.on\.high \|\| p < D\.on\.low\)\) updateON\(false\)/, 'a new high or low moves them');
  assert.match(live, /if \(D\.m1\) \{ updateON\(false\); updateIB\(false\); \}/, 'the clock locks them at 9:30');
  assert.match(live, /D\.lv\.concat\(U\.onLines\(D\.on, IC\), U\.ibLines\(D\.ib, IC\)\)/);
  for (const f of ['live/live.js', 'src/chart-engine.js', 'CHART_STYLE.md', 'test/onh.test.js'])
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), /[\u2013\u2014]/, f + ': no em or en dashes');
});
