'use strict';
// The cumulative delta pane (1.7.0; Anthony's rulings 2026-09-30): the compute core (ChartEngine.CumulativeDelta), the
// trade sides in the page's TickStore, the page's own feeding path (backfill, then live trades) against a rebuild from
// the store, and the pane on a stand-in canvas. Made-up trades only, never market data.
const test = require('node:test');
const assert = require('node:assert/strict');
const CE = require('../src/chart-engine.js');
const BB = require('../live/bar-builder.js');
const U = CE.util;
const S18 = 18 * 3600;

const et = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, 0) / 1000 + (s || 0);
/* The real (unix) time at which New York's wall clock reads `wall` (seconds stored as if UTC), checked exactly. */
function unixAt(wall) {
  let u = wall - (U.zoneSeconds(wall) - wall);
  u = wall - (U.zoneSeconds(u) - u);
  assert.equal(U.zoneSeconds(u), wall, 'a New York wall time that exists: ' + new Date(wall * 1000).toISOString());
  return u;
}
let seed = 12345;
const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
const pick = a => a[Math.floor(rnd() * a.length)];
const brief = b => [b.t, b.o, b.h, b.l, b.c, b.buy, b.sell, b.unknown];

test('core: one candle per time bar: open is the cumulative at its start (0 at the session start), high, low and close the running extremes and last', () => {
  const cd = new CE.CumulativeDelta({ seconds: 15 });
  const T = et(2026, 9, 29, 10, 0);
  for (const [s, v, side] of [[1, 3, 1], [5, 5, -1], [9, 1, 1], [16, 2, -1], [20, 7, 0], [29, 10, 1], [46, 1, 1]]) assert.equal(cd.add(T + s, v, side), true);
  assert.deepEqual(cd.bars.map(brief), [
    [T, 0, 3, -2, -1, 4, 5, 0],
    [T + 15, -1, 7, -3, 7, 10, 2, 7],
    [T + 45, 7, 8, 7, 8, 1, 0, 0],                               // 10:00:30 had no trade: no candle for it
  ]);
  assert.deepEqual(cd.bars.map(b => b.c - b.o), [-1, 8, 1], 'bar delta: buys minus sells in each bar');
  const ses = cd.session;
  assert.deepEqual([ses.buy, ses.sell, ses.unknown, ses.unknownTrades, ses.trades, ses.partial], [15, 7, 7, 1, 7, false]);
  assert.equal(cd.last.c, ses.buy - ses.sell, 'the last close is the session\'s buys minus sells');
  assert.equal(cd.at(T + 15).c, 7);
  assert.equal(cd.at(T + 30), null);
  assert.equal(cd.lowerBound(T + 30), 2);
  // a late trade (earlier than the newest bar) folds into the newest bar, as the bar builders do
  cd.add(T + 40, 2, -1);
  assert.deepEqual(brief(cd.last), [T + 45, 7, 8, 6, 6, 1, 2, 0]);
});

test('core: range bars (both styles) through the page\'s bar builder: every candle is the running sum of the trades in its bar', () => {
  for (const rangeMode of ['nt', 'traded']) {
    const T = et(2026, 9, 29, 9, 0);
    const trades = [];
    let p = 20000, t = T;
    for (let i = 0; i < 6000; i++) {
      const r = rnd(), steps = r < 0.004 ? 9 + Math.floor(rnd() * 8) : r < 0.5 ? 0 : 1;   // now and then a jump: phantom bars
      p += (rnd() < 0.5 ? -1 : 1) * steps * 0.25; t += 0.002 + rnd() * 0.8;
      trades.push([+t.toFixed(3), p, 1 + Math.floor(rnd() * 4), pick([1, 1, -1, -1, 0]), pick([2, 3])]);
    }
    const bb = new BB.BarBuilder({ mode: 'range', rangeTicks: 8, rangeMode, tick: 0.25, sessionStart: S18 });
    const cd = new CE.CumulativeDelta({});
    for (const [tt, pp, v, s, sm] of trades) { const r = bb.add(tt, pp, v); cd.add(tt, v, s, r.bar.t, sm); }
    // the same by hand: each trade in the last bar that started at or before it
    const bars = bb.bars, want = new Map();
    let cum = 0, k = 0;
    for (const [tt, , v, s] of trades) {
      while (k + 1 < bars.length && bars[k + 1].t <= tt) k++;
      let w = want.get(bars[k].t);
      if (!w) { w = { t: bars[k].t, o: cum, h: cum, l: cum, c: cum }; want.set(bars[k].t, w); }
      cum += s === 1 ? v : s === -1 ? -v : 0;
      w.h = Math.max(w.h, cum); w.l = Math.min(w.l, cum); w.c = cum;
    }
    assert.ok(bars.length > 60 && (rangeMode === 'nt' ? want.size < bars.length : want.size === bars.length), rangeMode + ': ' + bars.length + ' bars, ' + want.size + ' with trades (NinjaTrader style: the rest phantom)');
    assert.deepEqual(cd.bars.map(b => [b.t, b.o, b.h, b.l, b.c]), [...want.values()].map(w => [w.t, w.o, w.h, w.l, w.c]), rangeMode);
    const times = new Set(bars.map(b => b.t));
    assert.ok(cd.bars.every(b => times.has(b.t)), 'every candle sits on a price bar');
  }
});

test('core: the cumulative starts again at 0 at 18:00 ET, over a weekend and on both DST changes (New York wall clock)', () => {
  for (const [label, fri, sun, mon] of [['DST starts (8 Mar 2026)', [2026, 3, 6], [2026, 3, 8], [2026, 3, 9]], ['DST ends (1 Nov 2026)', [2026, 10, 30], [2026, 11, 1], [2026, 11, 2]], ['no change', [2026, 9, 25], [2026, 9, 27], [2026, 9, 28]]]) {
    const cd = new CE.CumulativeDelta({ seconds: 60 });
    const add = (wall, v, s) => { const u = unixAt(wall); assert.equal(cd.add(U.zoneSeconds(u), v, s), true); return u; };
    const F = w => et(...fri, ...w), Su = w => et(...sun, ...w), M = w => et(...mon, ...w);
    add(F([16, 58, 0]), 5, 1); add(F([16, 59, 30]), 2, -1);          // Friday's session, up to the 17:00 close
    const u18 = add(Su([18, 0, 0]), 4, -1);                          // Sunday 18:00: the new week's first session
    add(Su([23, 10, 0]), 6, 1);
    // across 2:00 on the Monday morning: a trade every 10 minutes of real time
    for (let k = 0; k < 12; k++) { const u = unixAt(M([1, 0, 0])) + k * 600; cd.add(U.zoneSeconds(u), 1, 1); }
    add(M([17, 59, 59.999]), 3, 1);                                   // the last trade of Monday's session (Sunday 18:00 on)
    add(M([18, 0, 0]), 2, -1);                                        // Monday 18:00: a new session
    const ses = cd.sessions;
    assert.equal(ses.length, 3, label);
    assert.deepEqual(ses.map(x => x.start % 86400), [S18, S18, S18], label + ': every session starts at 18:00 New York time');
    assert.deepEqual(ses.map(x => U.fmtHM(x.start) + ' ' + new Date(x.start * 1000).getUTCDay()), ['18:00 4', '18:00 0', '18:00 1'], label + ': Thursday, Sunday, Monday evenings');
    assert.deepEqual(ses.map(x => cd.bars[x.first].o), [0, 0, 0], label + ': each opens at 0');
    assert.deepEqual(ses.map(x => x.buy - x.sell), [3, -4 + 6 + 12 + 3, -2], label + ': the session sums');
    assert.equal(cd.bars[ses[1].last].c, ses[1].buy - ses[1].sell);
    assert.equal(cd.bars[ses[1].first].t, Su([18, 0, 0]));
    // the same instant a second earlier is the old session: 17:59:59 on the Monday is Sunday's session
    assert.equal(U.tradeDay(M([17, 59, 59.999]), S18), ses[1].day);
    assert.equal(cd.startOf(Su([18, 0, 0])), Su([18, 0, 0]));
    // the real clock: the Sunday session starts 5 hours after midnight UTC in winter, 4 in summer; the wall clock is the same
    const offset = (u18 - Su([18, 0, 0])) / 3600;
    assert.ok(offset === 4 || offset === 5, label + ': ' + offset);
  }
  // a session on the clock's side: 17:59:59.999 and 18:00:00.000 on an ordinary evening
  const cd = new CE.CumulativeDelta({ seconds: 15 });
  cd.add(et(2026, 9, 29, 17, 59, 59.999), 5, 1); cd.add(et(2026, 9, 29, 18, 0, 0), 5, -1);
  assert.deepEqual(cd.bars.map(b => [U.fmtHM(b.t), b.o, b.c]), [['17:59', 0, 5], ['18:00', 0, -5]]);
});

test('core: unknown sides (0) and trades with no side add nothing; both are counted', () => {
  const cd = new CE.CumulativeDelta({ seconds: 60 });
  const T = et(2026, 9, 29, 11, 0);
  cd.add(T + 1, 10, 1, undefined, 2);
  cd.add(T + 2, 4, 0, undefined, 0);                              // unknown
  cd.add(T + 3, 6, undefined);                                    // no side at all (an older ChartBridge)
  cd.add(T + 4, 3, null);
  cd.add(T + 5, 2, -1, undefined, 3);                             // by the tick rule
  const b = cd.last, ses = cd.session;
  assert.deepEqual([b.o, b.h, b.l, b.c, b.buy, b.sell, b.unknown, b.n], [0, 10, 0, 8, 10, 2, 13, 5]);
  assert.deepEqual([ses.unknown, ses.unknownTrades, ses.missing, ses.byRule], [13, 3, 2, 2]);
  const v0 = cd.version;
  for (const bad of [[NaN, 1, 1], [T + 6, 0, 1], [T + 6, -3, 1], ['1', 1, 1], [T + 6, '2', 1], [T + 6, Infinity, 1], [Infinity, 1, 1]]) assert.equal(cd.add(...bad), false, JSON.stringify(bad));
  assert.deepEqual([cd.skipped, cd.version, cd.trades], [7, v0, 5], 'left out and counted, nothing else changed');
});

test('core: bar delta per bar is buys minus sells of its trades; the last close of each session is that session\'s buys minus sells', () => {
  const cd = new CE.CumulativeDelta({ seconds: 300 });
  const trades = [];
  let t = et(2026, 9, 28, 16, 0);
  for (let i = 0; i < 20000; i++) { t += rnd() * 12; trades.push([t, 1 + Math.floor(rnd() * 9), pick([1, -1, -1, 1, 1, 0])]); }
  for (const [tt, v, s] of trades) cd.add(tt, v, s);
  const per = new Map();
  for (const [tt, v, s] of trades) { const k = Math.floor(tt / 300) * 300; per.set(k, (per.get(k) || 0) + (s === 1 ? v : s === -1 ? -v : 0)); }
  assert.deepEqual(cd.bars.map(b => b.c - b.o), cd.bars.map(b => per.get(b.t)));
  assert.deepEqual(cd.bars.map(b => b.buy - b.sell), cd.bars.map(b => per.get(b.t)));
  assert.ok(cd.sessions.length >= 2, 'the trades span ' + cd.sessions.length + ' sessions');
  for (const ses of cd.sessions) {
    const sum = trades.filter(([tt]) => U.tradeDay(tt, S18) === ses.day).reduce((a, [, v, s]) => a + (s === 1 ? v : s === -1 ? -v : 0), 0);
    assert.equal(cd.bars[ses.last].c, sum);
    assert.equal(ses.buy - ses.sell, sum);
    assert.equal(cd.bars[ses.first].o, 0);
  }
});

test('core: coverage: bars that started before the page had every trade are left out; a session that started earlier counts from its first complete bar, and says so', () => {
  const T = et(2026, 9, 29, 18, 0);                                // the session's start
  const C = T + 3 * 3600 + 40 * 60 + 7;                            // the page has every trade from 21:40:07
  const cd = new CE.CumulativeDelta({ seconds: 60, coveredFrom: C });
  let t = T + 3 * 3600;
  while (t < T + 5 * 3600) { cd.add(t, 2, 1); t += 20; }
  cd.add(T + 86400 + 5, 3, -1);                                    // the next session: fully covered
  assert.equal(cd.bars[0].t, T + 3 * 3600 + 41 * 60, 'the first candle is the first full minute after 21:40:07');
  assert.equal(cd.bars[0].o, 0, 'and it opens at 0');
  assert.equal(cd.uncovered, 41 * 3, 'the minutes from 21:00 up to 21:41 left out and counted');
  const [a, b] = cd.sessions;
  assert.deepEqual([a.partial, U.fmtHM(a.from), b.partial, b.from - b.start], [true, '21:41', false, 0]);
  // exactly at the start: not partial
  const full = new CE.CumulativeDelta({ seconds: 60, coveredFrom: T });
  full.add(T + 1, 1, 1);
  assert.equal(full.session.partial, false);
  // 'first' (a page with only live trades): the first trade's own bar is left out, the next counts from 0
  const live = new CE.CumulativeDelta({ seconds: 60, coveredFrom: 'first' });
  assert.equal(live.coveredFrom, null);
  live.add(T + 3600 + 30, 5, 1); live.add(T + 3600 + 50, 5, 1); live.add(T + 3660, 2, -1); live.add(T + 3700, 1, 1);
  assert.deepEqual(live.bars.map(brief), [[T + 3660, 0, 0, -2, -1, 1, 2, 0]]);
  assert.deepEqual([live.uncovered, live.session.partial, U.fmtHM(live.session.from)], [2, true, '19:01']);
  // range bars pass their bar's start: a bar that started before the cover is left out whole
  const rb = new CE.CumulativeDelta({ coveredFrom: C });
  rb.add(C + 1, 1, 1, C - 5); rb.add(C + 2, 1, 1, C - 5); rb.add(C + 3, 1, -1, C + 3);
  assert.deepEqual(rb.bars.map(b => [b.t, b.o, b.c]), [[C + 3, 0, -1]]);
});

test('TickStore: the side and method of every trade kept beside it (ChartBridge 0.3.4), none for an older ChartBridge, across block boundaries', () => {
  const s = new BB.TickStore();
  s.pushAll([[1, 100, 2], [2, 100.25, 3, 1, 2], [3, 100, 1, -1, 3], [4, 100, 5, 0, 0], [5, 100, 1, 7, 2], [6, 100, 1, 1, 9], [7, 100, 1, null, null]]);
  s.push(8, 100, 1, -1, 1);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(i => [s.side(i), s.method(i)]), [[undefined, 0], [1, 2], [-1, 3], [0, 0], [0, 0], [1, 0], [undefined, 0], [-1, 1]]);
  assert.deepEqual(s.at(1), [2, 100.25, 3], 'at() still gives [t, p, v]');
  // feedSides hands them on; feed() is unchanged
  const got = [];
  s.feedSides({ addQuiet: (...a) => got.push(a) }, 1, 3);
  assert.deepEqual(got.slice(0, 2), [[3, 100, 1, -1, 3], [4, 100, 5, 0, 0]]);
  const plain = [];
  s.feed({ addQuiet: (...a) => plain.push(a) }, 0);
  assert.deepEqual(plain[1], [2, 100.25, 3]);
  // 140,000 trades, the oldest 70,000 dropped: sides stay with their trades
  const big = new BB.TickStore(), side = i => [1, -1, 0, undefined][i % 4];
  for (let i = 0; i < 140000; i++) big.push(i, 1, 1, side(i), side(i) === undefined ? undefined : 2);
  big.dropFirst(70001);
  assert.equal(big.length, 69999);
  for (const i of [0, 1, 2, 3, 65534, 65535, 65536, 69998]) assert.equal(big.side(i), side(i + 70001), 'trade ' + i);
  assert.equal(big.sides.length, big.blocks.length);
});

/* The page's path (live/live.js): the backfill into the store, the delta built from it at ready (with the range bars in
   one pass), then each live trade pushed to the store, added to the bar builder and to the delta with its bar. */
function pagePath(view, trades, split) {
  const store = new BB.TickStore();
  store.pushAll(trades.slice(0, split));                           // the backfill, [t, p, v, s, sm]
  const mk = () => view === 'range' ? new BB.BarBuilder({ mode: 'range', rangeTicks: 12, rangeMode: 'nt', tick: 0.25, sessionStart: S18 })
    : new BB.BarBuilder({ mode: 'time', seconds: 60, tick: 0.25, sessionStart: S18 });
  const cur = mk(), cd = new CE.CumulativeDelta({ seconds: view === 'range' ? 0 : 300, coveredFrom: -Infinity });
  if (view === 'range') store.feedSides({ addQuiet(t, p, v, s, sm) { cur.addQuiet(t, p, v); cd.add(t, v, s, cur.bars[cur.bars.length - 1].t, sm); } }, 0);
  else { store.feed(cur, 0); store.feedSides(cd, 0); }
  for (const [t, p, v, s, sm] of trades.slice(split)) {             // live
    store.push(t, p, v, s, sm);
    const r = cur.add(t, p, v);
    cd.add(t, v, s, view === 'range' ? r.bar.t : Math.floor(r.bar.t / 300) * 300, sm);
  }
  return { store, cur, cd };
}
test('the page\'s path: backfill then live trades hold exactly what the store holds: the same as a rebuild from the store, and the totals are the store\'s sums', () => {
  const trades = [];
  let t = et(2026, 9, 29, 16, 40), p = 20000;
  for (let i = 0; i < 30000; i++) { t += 0.01 + rnd() * 3; p += (rnd() < 0.5 ? -0.25 : 0.25) * (rnd() < 0.5 ? 0 : 1); trades.push([+t.toFixed(3), p, 1 + Math.floor(rnd() * 6), pick([1, -1, 0, 1, -1]), pick([2, 3])]); }
  for (const view of ['range', 'time']) {
    const { store, cd } = pagePath(view, trades, 21000);
    const again = new CE.CumulativeDelta({ seconds: view === 'range' ? 0 : 300 });
    if (view === 'range') { const b = new BB.BarBuilder({ mode: 'range', rangeTicks: 12, rangeMode: 'nt', tick: 0.25, sessionStart: S18 }); store.feedSides({ addQuiet(tt, pp, v, s, sm) { b.addQuiet(tt, pp, v); again.add(tt, v, s, b.bars[b.bars.length - 1].t, sm); } }, 0); }
    else store.feedSides(again, 0);
    assert.deepEqual(cd.bars, again.bars, view + ': live path equals a rebuild');
    assert.deepEqual(cd.sessions, again.sessions);
    // the store's own sums, per session
    const sums = new Map();
    for (let i = 0; i < store.length; i++) {
      const d = U.tradeDay(store.time(i), S18), x = sums.get(d) || { buy: 0, sell: 0, unknown: 0 }, v = store.volume(i), s = store.side(i);
      if (s === 1) x.buy += v; else if (s === -1) x.sell += v; else x.unknown += v;
      sums.set(d, x);
    }
    assert.equal(cd.sessions.length, sums.size, 'the trades cross 18:00: two sessions');
    for (const ses of cd.sessions) {
      const x = sums.get(ses.day);
      assert.deepEqual([ses.buy, ses.sell, ses.unknown], [x.buy, x.sell, x.unknown], view + ': session totals are the store\'s');
      assert.equal(cd.bars[ses.last].c, x.buy - x.sell);
    }
    assert.equal(cd.trades, store.length, 'every trade in the store counted once');
  }
});

/* ---- the pane on a stand-in canvas (as test/vp-draw.test.js) */
function stubChart(opts) {
  const ops = [], children = [];
  class Path2D { constructor() { this.rects = []; } rect(x, y, w, h) { this.rects.push([x, y, w, h]); } moveTo() {} lineTo() {} closePath() {} arc() {} }
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return s => ({ width: String(s).length * 7 });
      if (k === 'fill') return p => ops.push({ op: 'fill', color: t.fillStyle, path: p });
      if (k === 'fillRect') return (x, y, w, h) => ops.push({ op: 'rect', color: t.fillStyle, r: [x, y, w, h] });
      if (k === 'fillText') return (s, x, y) => ops.push({ op: 'text', s: String(s), x, y });
      if (k === 'stroke') return () => ops.push({ op: 'stroke', color: t.strokeStyle });
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const W = 1078, H = 626;
  const element = () => {
    const attrs = {};
    return {
      handlers: {}, style: {}, dataset: {}, hidden: false, textContent: '', tabIndex: -1, className: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener(type, fn) { this.handlers[type] = fn; }, removeEventListener(type) { delete this.handlers[type]; },
      appendChild(c) { children.push(c); return c; }, remove() {}, setAttribute(k, v) { attrs[k] = String(v); }, getAttribute: k => attrs[k], hasAttribute() { return false; },
      getContext: () => ctx, focus() {}, setPointerCapture() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H }),
    };
  };
  let frameFn = null;
  global.document = { createElement: element, getElementById: () => null, head: { appendChild() {} } };
  global.window = { devicePixelRatio: 1 };
  global.requestAnimationFrame = fn => { frameFn = fn; return 1; };
  global.cancelAnimationFrame = () => { frameFn = null; };
  global.Path2D = Path2D;
  delete require.cache[require.resolve('../src/chart-engine.js')];
  const E = require('../src/chart-engine.js');
  const T0 = et(2026, 9, 29, 10, 0);
  const bars = [];
  for (let i = 0; i < 200; i++) { const c = 100 + Math.sin(i / 9) * 2; bars.push({ t: T0 + i * 60, o: c - 0.5, h: c + 1, l: c - 1, c, v: 100, vw: c }); }
  const chart = E.create(element(), Object.assign({ clock: () => bars[bars.length - 1].t + 30 }, opts || {}));
  chart.setBars(bars);
  const cd = new E.CumulativeDelta({ seconds: 60 });
  for (let i = 0; i < 200 * 20; i++) cd.add(T0 + i * 3, 1 + (i % 4), Math.floor(i / 50) % 3 === 0 ? -1 : i % 7 < 4 ? 1 : -1);   // runs of selling now and then
  let ts = 1000;
  const frame = () => { ops.length = 0; const f = frameFn; frameFn = null; if (f) f(ts += 16); };
  const settle = () => { for (let i = 0; i < 60; i++) frame(); };
  const redraw = () => { chart.setLayers({}); frame(); };         // one frame drawn whatever changed
  return { E, chart, ops, bars, cd, T0, W, H, frame, settle, redraw, canvas: children.find(c => c.getContext && c.handlers.pointermove), divider: children.find(c => c.className === 'ce-divider') };
}
const inPane = (r, pane) => r[1] >= pane.top - 0.5 && r[1] + r[3] <= pane.top + pane.height + 0.5;

test('chart: the delta pane sits below the plot only with the delta layer (about 20% of the chart), shares its bars, and draws candles in the candle colors', () => {
  const { chart, ops, cd, redraw, settle, H, divider } = stubChart();
  chart.setDelta(cd);
  settle();
  assert.equal(chart.getLayers().delta, false, 'off by default in the engine (the page turns it on)');
  assert.deepEqual([chart.deltaPane().on, chart.deltaPane().height, chart.deltaPane().plotHeight], [false, 0, H - 26]);
  assert.equal(divider.hidden, true);
  const off = ops.length;
  chart.setLayers({ delta: true }); settle(); redraw();
  const pane = chart.deltaPane(), area = H - 26;
  assert.ok(pane.on && Math.abs(pane.height - area * 0.2) <= 1, 'about 20% of the chart: ' + pane.height + ' of ' + area);
  assert.equal(pane.top, pane.plotHeight + 4, 'right under the plot');
  assert.equal(pane.top + pane.height, area, 'down to the time axis');
  assert.equal(divider.hidden, false);
  const T = chart.colors();
  const fills = ops.filter(o => o.op === 'fill' && o.path && (o.color === T.up || o.color === T.down));
  const paneFills = fills.filter(f => f.path.rects.length && f.path.rects.every(r => inPane(r, pane)));
  assert.equal(paneFills.length, 2, 'one path per color in the pane (the plot\'s candles are the other two)');
  assert.ok(paneFills[0].path.rects.length + paneFills[1].path.rects.length > 100, 'candles: a wick and a body per bar');
  assert.ok(fills.filter(f => !paneFills.includes(f)).every(f => f.path.rects.every(r => r[1] + r[3] <= pane.plotHeight + 0.5)), 'the plot\'s candles stay above it');
  assert.ok(ops.some(o => o.op === 'text' && o.s === 'CUMULATIVE DELTA'), 'its title');
  assert.equal(pane.title, 'Cumulative delta ' + U.fmtSigned(cd.last.c, 0), 'the newest bar\'s cumulative in the title');
  assert.ok(ops.some(o => o.op === 'text' && o.s === U.fmtSigned(cd.last.c, 0) && o.x > 1000), 'and in a tag on its axis');
  // the value scale fits the candles in view, with room at the top and bottom
  let lo = Infinity, hi = -Infinity;
  for (const b of cd.bars.slice(-150)) { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); }
  assert.ok(pane.lo < lo && pane.hi > hi, JSON.stringify([pane.lo, pane.hi, lo, hi]));
  assert.ok(off >= 0);
  // taken off again: the plot gets its height back
  chart.setLayers({ delta: false }); redraw();
  assert.deepEqual([chart.deltaPane().on, chart.deltaPane().plotHeight, divider.hidden], [false, area, true]);
});

test('chart: with the delta layer off, handing it a delta changes nothing that is drawn', () => {
  const a = stubChart(), log = [];
  a.settle(); a.redraw(); log.push(JSON.stringify(a.ops.map(o => [o.op, o.color, o.r, o.s, o.path && o.path.rects])));
  const b = stubChart();
  b.chart.setDelta(b.cd); b.chart.setDeltaView({ mode: 'bar', ratio: 0.4, note: 'x' });
  b.settle(); b.redraw(); log.push(JSON.stringify(b.ops.map(o => [o.op, o.color, o.r, o.s, o.path && o.path.rects])));
  assert.ok(log[0].length > 1000);
  assert.equal(log[1], log[0]);
});

test('chart: Bar delta draws one bar from zero per bar; a note (an older ChartBridge) draws nothing else', () => {
  const { chart, ops, cd, redraw, settle } = stubChart();
  chart.setDelta(cd); chart.setLayers({ delta: true }); chart.setDeltaView({ mode: 'bar' });
  settle(); redraw();
  const pane = chart.deltaPane(), T = chart.colors();
  assert.ok(pane.lo <= 0 && pane.hi >= 0, 'zero is in view');
  const paneFills = ops.filter(o => o.op === 'fill' && (o.color === T.up || o.color === T.down) && o.path && o.path.rects.length && o.path.rects.every(r => inPane(r, pane)));
  const rects = paneFills.flatMap(f => f.path.rects), zero = Math.round(chart.deltaToY(0));
  assert.ok(rects.length > 100 && rects.every(r => Math.abs(r[1] - zero) <= 1 || Math.abs(r[1] + r[3] - zero) <= 1), 'every bar starts at the zero line');
  assert.equal(pane.title, 'Bar delta ' + U.fmtSigned(cd.last.c - cd.last.o, 0));
  chart.setDeltaView({ note: 'Delta needs ChartBridge 0.3.4 on this PC' }); redraw();
  const after = chart.deltaPane();
  assert.equal(ops.filter(o => o.op === 'fill' && o.path && o.path.rects.length && o.path.rects.every(r => inPane(r, after))).length, 0, 'no bars');
  assert.ok(ops.some(o => o.op === 'text' && o.s === 'Delta needs ChartBridge 0.3.4 on this PC'), 'the note');
  assert.ok(!ops.some(o => o.op === 'text' && /^[+-]?\d/.test(o.s) && o.x > 1000 && o.y > after.top), 'no number on its axis');
});

test('chart: the divider: arrow keys, Page Up and Down, Home and End resize the pane within its limits, a drag moves it; each end says so once', () => {
  const { chart, settle, divider, canvas, H } = stubChart();
  const got = [];
  chart.on('paneResize', e => got.push(e));
  chart.setLayers({ delta: true }); chart.setDeltaView({ ratio: 0.2 }); settle();
  const key = k => { let stopped = false; divider.handlers.keydown({ key: k, preventDefault() {}, stopPropagation() { stopped = true; } }); return stopped; };
  assert.equal(key('ArrowUp'), true, 'the key is the divider\'s, not the chart\'s');
  assert.equal(chart.deltaPane().ratio, 0.22);
  key('PageDown'); assert.equal(chart.deltaPane().ratio, 0.12);
  key('Home'); assert.equal(chart.deltaPane().ratio, 0.6);
  assert.ok(chart.deltaPane().plotHeight >= CE.PRICE_MIN, 'the plot keeps its least height');
  key('End'); assert.equal(chart.deltaPane().ratio, 0.08);
  assert.ok(chart.deltaPane().height >= CE.PANE_MIN, 'the pane keeps its least height: ' + chart.deltaPane().height);
  assert.equal(key('x'), false, 'other keys are left alone');
  assert.deepEqual(got.map(e => e.done), [true, true, true, true]);
  assert.equal(divider.getAttribute('aria-valuenow'), '8');
  // a drag: the divider follows the pointer, the pane's top just under it
  divider.handlers.pointerdown({ pointerId: 7, clientX: 300, clientY: 400, preventDefault() {} });
  divider.handlers.pointermove({ pointerId: 7, clientX: 300, clientY: 300 });
  divider.handlers.pointermove({ pointerId: 7, clientX: 300, clientY: 350 });
  assert.equal(got[got.length - 1].done, false);
  divider.handlers.pointerup({ pointerId: 7, clientX: 300, clientY: 350 });
  const area = H - 26, r = got[got.length - 1];
  assert.equal(r.done, true);
  assert.ok(Math.abs(chart.deltaPane().top - 352) <= 1, 'the pane starts under the pointer: ' + chart.deltaPane().top);
  assert.ok(Math.abs(r.ratio - (area - 352) / area) < 0.003, r.ratio);
  // no dragging past the limits
  divider.handlers.pointerdown({ pointerId: 8, clientX: 300, clientY: 350, preventDefault() {} });
  divider.handlers.pointermove({ pointerId: 8, clientX: 300, clientY: -500 });
  divider.handlers.pointerup({ pointerId: 8, clientX: 300, clientY: -500 });
  assert.equal(chart.deltaPane().ratio, 0.6);
  assert.ok(canvas, 'the canvas is there');
});

test('chart: one crosshair: the pointer over the pane picks the plot\'s bar under it (legend and time tag), and a drag there pans the bars', () => {
  const { chart, ops, cd, frame, settle, canvas, bars } = stubChart();
  chart.setDelta(cd); chart.setLayers({ delta: true }); settle();
  const pane = chart.deltaPane(), legends = [];
  chart.on('legend', e => legends.push(e));
  canvas.handlers.pointermove({ pointerType: 'mouse', pointerId: 1, clientX: 600, clientY: pane.top + pane.height / 2, timeStamp: 1 });
  frame();
  const e = legends[legends.length - 1];
  assert.ok(e && e.hovering && e.index < bars.length - 1, 'the legend follows the bar under the pointer: ' + (e && e.index));
  assert.ok(ops.some(o => o.op === 'text' && o.s === U.fmtFull(bars[e.index].t)), 'the time tag under the axis');
  const b = cd.at(bars[e.index].t);
  assert.ok(chart.deltaPane().title.startsWith('Cumulative delta ' + U.fmtSigned(b.c, 0)), 'the pane\'s title shows that bar: ' + chart.deltaPane().title);
  const live0 = chart.isLive();
  canvas.handlers.pointerdown({ pointerType: 'mouse', pointerId: 1, clientX: 600, clientY: pane.top + 30, button: 0, timeStamp: 10 });
  canvas.handlers.pointermove({ pointerType: 'mouse', pointerId: 1, clientX: 700, clientY: pane.top + 30, timeStamp: 20 });
  canvas.handlers.pointerup({ pointerType: 'mouse', pointerId: 1, clientX: 700, clientY: pane.top + 30, timeStamp: 400, type: 'pointerup' });
  assert.equal(live0, true);
  assert.equal(chart.isLive(), false, 'dragged back in time, like the plot');
});

test('chart: live trades redraw the pane with no rebuild: the chart only reads the delta it was given', () => {
  const { chart, cd, frame, settle, T0 } = stubChart();
  chart.setDelta(cd); chart.setLayers({ delta: true }); settle();
  const calls = { add: 0 }, orig = cd.add.bind(cd);
  cd.add = (...a) => { calls.add++; return orig(...a); };
  const bars0 = cd.bars, n0 = cd.bars.length, v0 = cd.version;
  for (let i = 0; i < 30; i++) frame();
  assert.deepEqual([calls.add, cd.version, cd.bars === bars0, cd.bars.length], [0, v0, true, n0], 'frames never change the delta');
  cd.add(T0 + 199 * 60 + 50, 40, 1);
  frame();
  assert.equal(chart.deltaPane().title, 'Cumulative delta ' + U.fmtSigned(cd.last.c, 0), 'one trade, redrawn');
});
