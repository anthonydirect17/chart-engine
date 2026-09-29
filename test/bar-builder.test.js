'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const BB = require('../live/bar-builder.js');
const CE = require('../src/chart-engine.js');
const { BarBuilder } = BB;

const et = (h, m, s) => Date.UTC(2026, 8, 29, h, m, s || 0) / 1000;

test('time bars bucket ticks by start time', () => {
  const b = new BarBuilder({ mode: 'time', seconds: 15 });
  b.add(et(10, 0, 1), 100, 1);
  b.add(et(10, 0, 14), 101, 2);
  const r = b.add(et(10, 0, 15), 99.5, 1);
  assert.equal(r.isNew, true);
  assert.equal(b.bars.length, 2);
  assert.deepEqual([b.bars[0].t, b.bars[0].o, b.bars[0].h, b.bars[0].l, b.bars[0].c, b.bars[0].v], [et(10, 0, 0), 100, 101, 100, 101, 3]);
  assert.equal(b.bars[1].t, et(10, 0, 15));
});

test('late ticks fold into the newest bar, never rewrite an older one', () => {
  const b = new BarBuilder({ mode: 'time', seconds: 60 });
  b.add(et(10, 1, 0), 100, 1);
  b.add(et(10, 0, 59), 102, 1);
  assert.equal(b.bars.length, 1);
  assert.equal(b.bars[0].h, 102);
});

test('traded prices only: range bars close when the span would exceed the range and never invent prices', () => {
  const b = new BarBuilder({ mode: 'range', rangeMode: 'traded', rangeTicks: 4, tick: 0.25 });   // 1 point
  const prices = [100, 100.25, 100.75, 101, 101.25, 100.5, 99.75, 99.5];
  prices.forEach((p, i) => b.add(et(10, 0, i), p, 1));
  for (const bar of b.bars) {
    assert.ok(bar.h - bar.l <= 1 + 1e-9, 'span ' + (bar.h - bar.l));
    assert.ok(prices.includes(bar.o) && prices.includes(bar.c));
  }
  assert.equal(b.bars[0].h, 101);                 // 100 .. 101 is exactly 4 ticks
  assert.equal(b.bars[1].o, 101.25);               // the breakout tick opens the next bar
  for (let i = 1; i < b.bars.length; i++) assert.ok(b.bars[i].t > b.bars[i - 1].t);
  const left = b.rangeLeft();
  assert.ok(left.up >= 0 && left.down >= 0);
});

test('range bars keep strictly increasing times even inside one second', () => {
  const b = new BarBuilder({ mode: 'range', rangeTicks: 1, tick: 0.25 });
  const t = et(10, 0, 0);
  [100, 100.5, 101, 101.5].forEach(p => b.add(t, p, 1));
  for (let i = 1; i < b.bars.length; i++) assert.ok(b.bars[i].t > b.bars[i - 1].t);
});

test('session VWAP restarts at 18:00 ET and seeds from history', () => {
  const b = new BarBuilder({ mode: 'time', seconds: 60 });
  b.seed([{ t: et(16, 58), o: 10, h: 10, l: 10, c: 10, v: 100 }]);
  b.add(et(18, 0, 5), 20, 1);
  b.add(et(18, 0, 30), 30, 1);
  assert.equal(b.bars[0].vw, 10);
  assert.equal(b.last.vw, 25);
});

/* ---------------- range bars: known answers (B2). Range 4 ticks of 0.25 = 1.00 point. */
const row = b => [b.o, b.h, b.l, b.c, b.v];
const SEQ = [
  [et(16, 0, 0), 100.00, 1],
  [et(16, 0, 1), 100.50, 2],
  [et(16, 0, 2), 100.25, 3],
  [et(16, 0, 3), 101.75, 4],    // up past 101.00 by 3 ticks
  [et(16, 0, 4), 104.50, 5],    // a jump of more than two ranges
  [et(16, 0, 5), 104.00, 6],
  [et(16, 0, 6), 102.25, 7],    // down past the range; lands exactly one range down
  [et(16, 0, 7), 102.25, 8],
  [et(18, 0, 0), 110.00, 9],    // new session (18:00 ET): a gap of 7.75 points
  [et(18, 0, 1), 109.00, 10],
  [et(18, 0, 2), 108.75, 11],   // one tick past the range, bar closed on its low already
];
const build = (mode, seq) => { const b = new BarBuilder({ mode: 'range', rangeMode: mode, rangeTicks: 4, tick: 0.25 }); for (const [t, p, v] of seq || SEQ) b.add(t, p, v); return b; };

test('NinjaTrader range bars: exact range, phantom bars, next bar one tick on, session break (known answer)', () => {
  const b = build('nt');
  assert.deepEqual(b.bars.map(row), [
    [100.00, 101.00, 100.00, 101.00, 6],     // finished at exactly low + range, closed on its high (101 never traded)
    [101.25, 102.25, 101.25, 102.25, 4],     // opened one tick above; set to its full range when 104.50 traded
    [102.50, 103.50, 102.50, 103.50, 0],     // phantom bar: exactly the range, no volume
    [103.75, 104.50, 103.50, 103.50, 11],    // 104.50's bar; closed on its low at high - range when 102.25 traded
    [103.25, 103.25, 102.25, 102.25, 15],    // down bar, full range at once; stays open until a trade goes past it
    [110.00, 110.00, 109.00, 109.00, 19],    // new session: opens at the first trade, no bars fill the gap
    [108.75, 108.75, 108.75, 108.75, 11],
  ]);
  // the trade's own bar keeps the trade's time; the phantom bar sits 1 ms before it, after the previous trade
  assert.deepEqual(b.bars.map(x => x.t), [et(16, 0, 0), et(16, 0, 3), et(16, 0, 4) - 0.001, et(16, 0, 4), et(16, 0, 6), et(18, 0, 0), et(18, 0, 2)]);
  for (const bar of b.bars.slice(0, -1)) {
    assert.equal(bar.h - bar.l, 1, 'finished bar spans exactly the range: ' + row(bar));
    assert.ok(bar.c === bar.h || bar.c === bar.l, 'closes on its high or low');
  }
});

test('traded prices only: the same trades (known answer)', () => {
  const b = build('traded');
  assert.deepEqual(b.bars.map(row), [
    [100.00, 100.50, 100.00, 100.25, 6],     // short of the range: 101.75 jumped over the boundary
    [101.75, 101.75, 101.75, 101.75, 4],
    [104.50, 104.50, 104.00, 104.00, 11],
    [102.25, 102.25, 102.25, 102.25, 15],
    [110.00, 110.00, 109.00, 109.00, 19],
    [108.75, 108.75, 108.75, 108.75, 11],
  ]);
});

test('NinjaTrader range bars: a jump down of several ranges', () => {
  const b = build('nt', [[et(10, 0, 0), 200, 1], [et(10, 0, 1), 200.5, 1], [et(10, 0, 2), 197.25, 3]]);
  assert.deepEqual(b.bars.map(row), [
    [200.00, 200.50, 199.50, 199.50, 2],     // low set to high - range, closed there
    [199.25, 199.25, 198.25, 198.25, 0],     // phantom
    [198.00, 198.00, 197.25, 197.25, 3],     // the trade's bar gets its volume
  ]);
});

test('the result lists every bar a trade touched, so the chart can follow bar by bar', () => {
  const b = new BarBuilder({ mode: 'range', rangeTicks: 4, tick: 0.25 });
  b.add(et(10, 0, 0), 100, 1); b.add(et(10, 0, 1), 100.5, 1);
  const r = b.add(et(10, 0, 2), 103.25, 2);
  assert.equal(r.isNew, true);
  assert.deepEqual(r.changed.map(row), [[100, 101, 100, 101, 2], [101.25, 102.25, 101.25, 102.25, 0], [102.5, 103.25, 102.5, 103.25, 2]]);
  assert.equal(r.bar, b.last);
  assert.deepEqual(b.add(et(10, 0, 3), 103, 1).changed.map(row), [[102.5, 103.25, 102.5, 103, 3]]);
});

/* The chart gets bars one update at a time (chart.update: same time replaces the last bar, a later one is added).
   Built live, tick by tick, it must end up with exactly the bars a rebuild from the same ticks gives. */
function walk(n, seed) {
  let x = seed, p = 25000;
  const out = [];
  const rnd = () => (x = (x * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < n; i++) {
    const r = rnd(), step = r < 0.7 ? 1 : r < 0.95 ? 2 + Math.floor(rnd() * 3) : 10 + Math.floor(rnd() * 30);
    p += (rnd() < 0.5 ? -1 : 1) * step * 0.25;
    out.push([et(12, 0, 0) + i * 7.3, p, 1 + Math.floor(rnd() * 4)]);   // about 20 hours: crosses 18:00
  }
  return out;
}
for (const mode of ['nt', 'traded']) {
  test('range bars (' + mode + '): live tick by tick equals a rebuild from history', () => {
    const ticks = walk(10000, 11);
    const live = new BarBuilder({ mode: 'range', rangeMode: mode, rangeTicks: 20, tick: 0.25 });
    const chart = [];
    for (const [t, p, v] of ticks.slice(0, 4000)) live.add(t, p, v);          // backfill
    for (const b of live.bars) chart.push(Object.assign({}, b));
    for (const [t, p, v] of ticks.slice(4000)) {                            // then live
      for (const b of live.add(t, p, v).changed) {
        const last = chart[chart.length - 1];
        if (b.t > last.t) chart.push(Object.assign({}, b));
        else if (b.t === last.t) Object.assign(last, b);
        else assert.fail('update for an older bar');
      }
    }
    const rebuilt = new BarBuilder({ mode: 'range', rangeMode: mode, rangeTicks: 20, tick: 0.25 });
    for (const [t, p, v] of ticks) rebuilt.add(t, p, v);
    assert.deepEqual(chart.map(row), rebuilt.bars.map(row));
    assert.deepEqual(chart.map(b => b.t), rebuilt.bars.map(b => b.t));
    if (mode === 'nt') for (let i = 0; i < rebuilt.bars.length - 1; i++) {
      const b = rebuilt.bars[i], next = rebuilt.bars[i + 1];
      if (BB.tradeDay(next.t, 18 * 3600) !== BB.tradeDay(b.t, 18 * 3600)) continue;   // the last bar of a session can be short
      assert.equal(Math.round((b.h - b.l) / 0.25), 20, 'bar ' + i + ' spans exactly 20 ticks');
    }
  });
}

test('range bars are the same after a reload: built from the session start whatever the backfill window', () => {
  const S = 18 * 3600, ticks = walk(12000, 5);                    // 12:00 ET to about 12:20 ET the next day
  const now = ticks[ticks.length - 1][0];
  const from = BB.rangeHistoryFrom(now, S);
  assert.equal(from, et(18, 0, 0));                               // this session is over 8 hours old
  const build2 = windowStart => {
    const w = ticks.filter(k => k[0] >= windowStart);
    const b = new BarBuilder({ mode: 'range', rangeTicks: 16, tick: 0.25 });
    for (let i = BB.rangeStartIndex(w, windowStart, S); i < w.length; i++) b.add(w[i][0], w[i][1], w[i][2]);
    return b.bars.map(x => [x.t, ...row(x)]);
  };
  const a = build2(from - 3 * 3600), b = build2(from - 17 * 60);  // two reloads, different backfill windows
  assert.ok(a.length > 50);
  assert.deepEqual(a, b);
  assert.equal(a[0][0], ticks.find(k => k[0] >= et(18, 0, 0))[0]);  // starts at the session's first trade
});

test('range backfill reaches a session start: this one, or the one before while this one is young', () => {
  const S = 18 * 3600;
  assert.equal(BB.sessionStartOf(et(10, 0, 0), S), et(18, 0, 0) - 86400);
  assert.equal(BB.sessionStartOf(et(18, 0, 0), S), et(18, 0, 0));
  assert.equal(BB.rangeHistoryFrom(et(15, 0, 0), S), et(18, 0, 0) - 86400);     // 21 h old: this session
  assert.equal(BB.rangeTickHours(et(15, 0, 0), S), 22);
  assert.equal(BB.rangeHistoryFrom(et(20, 0, 0), S), et(18, 0, 0) - 86400);     // 2 h old: the day before too
  assert.equal(BB.rangeTickHours(et(20, 0, 0), S), 27);
  assert.equal(BB.rangeStartIndex([[et(17, 0, 0)], [et(18, 0, 0)], [et(18, 0, 1)]], et(18, 0, 0), S), 1);
  assert.equal(BB.rangeStartIndex([[et(17, 0, 0)], [et(17, 0, 1)]], et(18, 0, 0), S), 0);   // no session start covered
});

/* The engine puts a fill on the last bar whose time is at or before the fill's time (idxAtTime in
   src/chart-engine.js); this is the same rule. */
const barAt = bars => t => { let lo = 0, hi = bars.length - 1; if (t < bars[0].t) return 0; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (bars[m].t <= t) lo = m; else hi = m - 1; } return lo; };

test('a fill on a jump trade lands on the bar that holds its price, not on a phantom bar', () => {
  for (const mode of ['nt', 'traded']) {
    const b = build(mode);
    const fills = [
      { t: et(16, 0, 4), price: 104.50, side: 'buy', qty: 1 },       // the jump trade, two ranges up
      { t: et(16, 0, 4) + 0.0005, price: 104.50, side: 'sell', qty: 1 },   // a fill stamped half a ms later
      { t: et(16, 0, 2), price: 100.25, side: 'buy', qty: 2 },        // an ordinary fill before the jump
    ];
    const marks = CE.util.groupFills(fills, barAt(b.bars), 0.25);
    for (const m of marks) {
      const bar = b.bars[m.i];
      assert.ok(m.price >= bar.l && m.price <= bar.h, mode + ': fill at ' + m.price + ' on bar ' + m.i + ' [' + bar.l + ', ' + bar.h + ']');
    }
    assert.equal(marks.find(m => m.side === 'buy' && m.price === 104.5).i, mode === 'nt' ? 3 : 2);   // bar D (after phantom C), or C in traded mode
  }
});

test('bar times: phantom bars sit between the previous trade and the jump trade; same-instant bursts stay within 10 us a bar', () => {
  const b = new BarBuilder({ mode: 'range', rangeTicks: 1, tick: 0.25 });
  const t0 = et(10, 0, 0);
  b.add(t0, 100, 1);
  b.add(t0 + 0.4, 100.25, 1);                 // the previous trade
  const r = b.add(t0 + 0.402, 130, 1);        // 119 ticks up, 2 ms later: about 60 new bars
  const times = r.changed.filter(x => x !== b.bars[0]).map(x => x.t);
  assert.equal(times[times.length - 1], t0 + 0.402);
  assert.ok(times[0] > t0 + 0.4, 'first new bar after the previous trade');
  for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1]);
  // five 120-tick jumps in the same millisecond: strictly increasing, and the last bar at most 10 us per bar ahead
  const c = new BarBuilder({ mode: 'range', rangeTicks: 1, tick: 0.25 });
  const t1 = et(11, 0, 0);
  c.add(t1, 100, 1);
  let made = 0;
  for (let k = 1; k <= 5; k++) made += c.add(t1, 100 + (k % 2 ? 30 : 0), 1).changed.length;
  for (let i = 1; i < c.bars.length; i++) assert.ok(c.bars[i].t > c.bars[i - 1].t, 'strictly increasing at ' + i);
  assert.ok(c.last.t - t1 <= made * 0.00001 + 1e-9, 'ahead by ' + (c.last.t - t1) + ' s for ' + made + ' bars');
});

test('after the tick cap trims, Range reloads only when this session start is no longer covered (review N4)', () => {
  const S = 18 * 3600, now = et(20, 0, 0);                        // this session is 2 h old: normally the day before too
  assert.equal(BB.rangeNeedsReload(et(17, 0, 0) - 86400, now, S, false), false);
  assert.equal(BB.rangeNeedsReload(et(12, 0, 0), now, S, false), true);    // 8 h of seconds-bar ticks: not enough
  assert.equal(BB.rangeNeedsReload(et(12, 0, 0), now, S, true), false);    // trimmed, still reaches 18:00 today
  assert.equal(BB.rangeNeedsReload(et(18, 30, 0), now, S, true), true);    // trimmed past this session's start
});

test('partialStart: the first range tick more than 10 minutes into its session (review N5)', () => {
  const S = 18 * 3600;
  assert.equal(BB.partialStart([[et(18, 0, 3)], [et(18, 1, 0)]], 0, S), null);
  assert.equal(BB.partialStart([[et(17, 0, 0)], [et(18, 0, 3)]], 1, S), null);
  assert.equal(BB.partialStart([[et(2, 14, 0)]], 0, S), et(2, 14, 0));
  assert.equal(BB.partialStart([[et(18, 9, 0)]], 0, S), null);
  assert.equal(BB.partialStart([[et(18, 11, 0)]], 0, S), et(18, 11, 0));
  assert.equal(BB.partialStart([], 0, S), null);
});
