'use strict';
// Smoothness guards for the live chart (1.5.1). Found with test/perf-live.mjs on 1.4.x and 1.5.0 (CHANGELOG 1.5.1):
//  - the frame loop stopped for good when a tick was handled after a frame began and that frame's time stamp was
//    over 166 ms old (after the long task that builds 33 hours of range bars): the live price ring got a negative
//    radius, arc() threw, and the next frame was never asked for;
//  - 33 hours of ticks were kept as about 2 million small arrays, some 150 MB of heap for the garbage collector.
// Bounds are generous (a slow CI machine passes); what they catch is a stopped loop, ticks back on the heap, or
// per-tick or per-frame work that grows with the history held.
const test = require('node:test');
const assert = require('node:assert/strict');
const v8 = require('node:v8');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const BB = require('../live/bar-builder.js');

/* A stand-in DOM whose canvas throws like Chrome's on a negative arc radius. Frames run by hand. */
function stubDom() {
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'arc') return (x, y, r) => { if (r < 0) throw new RangeError("Failed to execute 'arc' on 'CanvasRenderingContext2D': The radius provided (" + r + ') is negative.'); };
      if (k === 'measureText') return s => ({ width: String(s).length * 7 });
      if (k === 'getLineDash') return () => [];
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const element = () => ({
    handlers: {}, style: {}, dataset: {}, hidden: false, textContent: '', tabIndex: -1,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, fn) { this.handlers[type] = fn; }, removeEventListener(type) { delete this.handlers[type]; },
    appendChild(c) { return c; }, remove() {}, setAttribute() {}, hasAttribute() { return false; },
    getContext: () => ctx, focus() {}, setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1400, height: 800, right: 1400, bottom: 800 }),
  });
  let frameFn = null;
  global.document = { createElement: element, getElementById: () => null, head: { appendChild() {} } };
  global.window = { devicePixelRatio: 1 };
  global.requestAnimationFrame = fn => { frameFn = fn; return 1; };
  global.cancelAnimationFrame = () => { frameFn = null; };
  global.Path2D = class { moveTo() {} lineTo() {} rect() {} closePath() {} arc() {} };
  return {
    ctx, container: element(),
    /** run the waiting frame with time stamp `ts`; returns whether another frame was asked for */
    frame(ts) { const f = frameFn; frameFn = null; assert.ok(f, 'a frame is waiting'); f(ts); return frameFn !== null; },
  };
}
function engine() {
  const dom = stubDom();
  delete require.cache[require.resolve('../src/chart-engine.js')];
  return { dom, CE: require('../src/chart-engine.js') };
}
const barsOf = n => {
  const out = [];
  for (let i = 0; i < n; i++) { const c = 25000 + Math.sin(i / 9) * 20; out.push({ t: 1790000000 + i * 60, o: c - 1, h: c + 3, l: c - 3, c, v: 100, vw: c }); }
  return out;
};

test('a tick handled after a frame began, with a stale frame time stamp, never stops the chart', () => {
  const { dom, CE } = engine();
  const bars = barsOf(200);
  const chart = CE.create(dom.container, { clock: () => bars[bars.length - 1].t + 30 });
  chart.setBars(bars);
  let ts = performance.now();
  for (let i = 0; i < 5; i++) assert.ok(dom.frame(ts += 16));
  // A long task (building a day and a half of range bars) ran; a tick came in after it, then the frame that was
  // due before it runs with a time stamp 300 ms older than the tick. 1.4.x and 1.5.0 threw here and stopped.
  const last = bars[bars.length - 1];
  chart.update(Object.assign({}, last, { c: last.c + 1, h: Math.max(last.h, last.c + 1) }));
  assert.doesNotThrow(() => assert.ok(dom.frame(performance.now() - 300), 'the next frame is asked for'));
  for (let i = 0; i < 40; i++) assert.ok(dom.frame(performance.now() + i * 16));
  assert.equal(chart.stats().idle, false, 'still drawing');
});

test('an error while drawing is reported once and the frame loop carries on', async () => {
  const { dom, CE } = engine();
  const chart = CE.create(dom.container, {});
  chart.setBars(barsOf(50));
  const thrown = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = fn => { try { fn(); } catch (e) { thrown.push(e.message); } return 0; };
  try {
    let fail = true;
    dom.ctx.fillRect = () => { if (fail) throw new Error('boom'); };
    let ts = 1000;
    for (let i = 0; i < 5; i++) { chart.setLayers({}); assert.ok(dom.frame(ts += 16), 'frame ' + i + ' asked for the next'); }
    assert.deepEqual(thrown, ['boom'], 'reported once');
    fail = false;
    for (let i = 0; i < 5; i++) assert.ok(dom.frame(ts += 16));
  } finally { global.setTimeout = realSetTimeout; }
});

test('per frame cost does not grow with the bars held (1,000 vs 40,000 range bars)', () => {
  const cost = n => {
    const { dom, CE } = engine();
    const bars = barsOf(n);
    const chart = CE.create(dom.container, { clock: () => bars[bars.length - 1].t + 30 });
    chart.setBars(bars);
    let ts = 1000, best = Infinity;
    for (let rep = 0; rep < 5; rep++) {
      const t0 = performance.now();
      for (let i = 0; i < 200; i++) {
        const b = bars[bars.length - 1];
        chart.update({ t: b.t + 60 * (i % 2), o: b.c, h: b.c + 1, l: b.c - 1, c: b.c + (i % 3) * 0.25, v: 5, vw: b.c });
        dom.frame(ts += 16);
      }
      best = Math.min(best, (performance.now() - t0) / 200);
    }
    return best;
  };
  const small = cost(1000), big = cost(40000);
  assert.ok(big < Math.max(small * 4, 0.5), 'ms per frame: ' + small.toFixed(3) + ' with 1,000 bars, ' + big.toFixed(3) + ' with 40,000');
});

/* seeded NQ-like trades: mostly 0 or 1 tick apart, a jump of 8 to 16 ticks now and then */
function trades(n, t0) {
  let seed = 11, p = 25000, t = t0;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    t += 0.05; const u = rnd();
    p += (u < 0.0005 ? 8 + Math.floor(rnd() * 9) : u < 0.5 ? 0 : 1) * (rnd() < 0.5 ? -0.25 : 0.25);
    out[i] = [+t.toFixed(3), p, 1 + (i % 4)];
  }
  return out;
}
const T0 = Date.UTC(2026, 8, 28, 18, 0) / 1000;             // a session start (18:00 ET, as bar time)

test('2 million ticks: the tick store keeps them off the JavaScript heap, and a live tick costs the same as with none', () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const N = 2000000, all = trades(N + 60000, T0);
  const backfill = all.slice(0, N), live = all.slice(N);
  gc(); const heap0 = v8.getHeapStatistics().used_heap_size;
  const store = new BB.TickStore();
  for (let i = 0; i < N; i += 20000) store.pushAll(backfill.slice(i, i + 20000));   // chunked, as ChartBridge sends them
  gc(); const heapMB = (v8.getHeapStatistics().used_heap_size - heap0) / 1048576;
  assert.equal(store.length, N);
  assert.deepEqual(store.at(N - 1), backfill[N - 1]);
  assert.ok(heapMB < 16, 'JavaScript heap for 2 million ticks: ' + heapMB.toFixed(1) + ' MB (as [t, p, v] arrays it is about 150)');

  /* per live tick, the page's onTick work: store the trade, the 1-minute builder, the Range 40 builder */
  const perTick = (history) => {
    const s = new BB.TickStore(); s.pushAll(history);
    const m1 = new BB.BarBuilder({ mode: 'time', seconds: 60, tick: 0.25, sessionStart: 18 * 3600 });
    const cur = new BB.BarBuilder({ mode: 'range', rangeTicks: 40, rangeMode: 'nt', tick: 0.25, sessionStart: 18 * 3600 });
    s.feed(m1, 0); s.feed(cur, 0);
    let best = Infinity, sink = 0;
    for (let rep = 0; rep < 5; rep++) {
      const t0 = performance.now();
      for (let i = rep * 12000; i < (rep + 1) * 12000; i++) {
        const k = live[i];
        s.push(k[0], k[1], k[2]);
        sink += m1.add(k[0], k[1], k[2]).bar.c;
        sink += cur.add(k[0], k[1], k[2]).changed.length;
      }
      best = Math.min(best, (performance.now() - t0) / 12000 * 1000);
    }
    assert.ok(sink > 0);
    return best;
  };
  const none = perTick(backfill.slice(0, 20000)), full = perTick(backfill);
  assert.ok(full < 5, 'microseconds per live tick with 2 million held: ' + full.toFixed(3));
  assert.ok(full < Math.max(none * 4, 1), 'microseconds per live tick: ' + none.toFixed(3) + ' with 20,000 held, ' + full.toFixed(3) + ' with 2 million');
});

test('TickStore: push, pushAll, dropFirst across blocks, feed with a from index and a time floor', () => {
  const s = new BB.TickStore(), ref = trades(200000, T0);
  s.pushAll(ref.slice(0, 1000));
  for (let i = 1000; i < ref.length; i++) s.push(ref[i][0], ref[i][1], ref[i][2]);
  assert.equal(s.length, ref.length);
  s.dropFirst(70000); ref.splice(0, 70000);                   // more than one block
  s.dropFirst(3); ref.splice(0, 3);
  assert.equal(s.length, ref.length);
  for (const i of [0, 1, 65535, 65536, 99999, ref.length - 1]) {
    assert.deepEqual(s.at(i), ref[i]);
    assert.equal(s.time(i), ref[i][0]); assert.equal(s.price(i), ref[i][1]); assert.equal(s.volume(i), ref[i][2]);
  }
  const got = [];
  s.feed({ add: (t, p, v) => got.push([t, p, v]) }, 10, ref[500][0]);
  assert.deepEqual(got, ref.slice(500));
  assert.equal(s.at(ref.length), undefined);
  s.dropFirst(1e9);
  assert.equal(s.length, 0); assert.equal(s.blocks.length, 0);
  s.push(1, 2); assert.deepEqual(s.at(0), [1, 2, 0]);
});

test('rangeStartIndex and partialStart read a TickStore the same as a list', () => {
  const S = 18 * 3600, list = trades(5000, T0 - 100);        // starts 100 s before the session
  const store = new BB.TickStore(); store.pushAll(list);
  assert.equal(BB.rangeStartIndex(store, T0, S), BB.rangeStartIndex(list, T0, S));
  assert.ok(BB.rangeStartIndex(store, T0, S) > 0);
  const from = BB.rangeStartIndex(store, T0, S);
  assert.equal(BB.partialStart(store, from, S), BB.partialStart(list, from, S));
  assert.equal(BB.partialStart(store, 0, S, 60), BB.partialStart(list, 0, S, 60));
  assert.equal(BB.partialStart(store, store.length, S), null);
});

test('range fast path: the same bars and results as the full path, on trades with jumps, same-instant trades and session breaks', () => {
  class Full extends BB.BarBuilder { _step(t, p, v) { this._fast = null; return super._step(t, p, v); } }   // never takes the fast path
  let seed = 5; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (const o of [{ rangeTicks: 40 }, { rangeTicks: 4 }, { rangeTicks: 20, sessionStart: 0 }]) {
    const opts = Object.assign({ mode: 'range', rangeMode: 'nt', tick: 0.25, sessionStart: 18 * 3600 }, o);
    const fast = new BB.BarBuilder(opts), full = new Full(opts), fed = new BB.BarBuilder(opts), store = new BB.TickStore();
    let t = T0 - 7200, p = 25000;
    for (let i = 0; i < 150000; i++) {
      const u = rnd(); t += u < 0.0005 ? 5 * 3600 : u < 0.2 ? 0 : rnd() * 0.4;
      if (u > 0.9995) t -= 0.3;                                 // a late trade now and then
      p += (rnd() < 0.001 ? 8 + Math.floor(rnd() * 20) : rnd() < 0.5 ? 0 : 1) * (rnd() < 0.5 ? -0.25 : 0.25);
      const v = 1 + Math.floor(rnd() * 5);
      assert.deepEqual(fast.add(t, p, v), full.add(t, p, v));
      store.push(t, p, v);
    }
    store.feed(fed, 0);
    assert.deepEqual(fast.bars, full.bars);
    assert.deepEqual(fed.bars, full.bars);
    assert.ok(full.bars.length > 20);
  }
});

/* frames that throw inside the plot clip: counts save/restore/reset, collects 'error' events, controls the clock */
function failingChart() {
  const { dom, CE } = engine();
  const calls = { save: 0, restore: 0, reset: 0 };
  let fail = null;
  dom.ctx.save = () => { calls.save++; };
  dom.ctx.restore = () => { calls.restore++; };
  dom.ctx.reset = () => { calls.reset++; };
  dom.ctx.fill = () => { if (fail) throw new Error(fail); };           // candles fill inside the clipped section
  const chart = CE.create(dom.container, {});
  chart.setBars(barsOf(50));
  const events = [], thrown = [];
  chart.on('error', e => events.push(e && e.message));
  const realNow = performance.now, realSetTimeout = global.setTimeout;
  let clock = 1000;
  performance.now = () => clock;
  global.setTimeout = fn => { try { fn(); } catch (e) { thrown.push(e.message); } return 0; };
  let ts = 1000;
  return {
    calls, events, thrown,
    set fail(v) { fail = v; },
    frames(n, stepMs) { for (let i = 0; i < n; i++) { clock += stepMs || 16; chart.setLayers({}); dom.frame(ts += stepMs || 16); } },
    done() { performance.now = realNow; global.setTimeout = realSetTimeout; },
  };
}

test('a drawing error never blanks the opaque canvas: no reset(), save and restore stay balanced, an error event fires', () => {
  const c = failingChart();
  try {
    c.fail = 'bad price';
    c.frames(3);
    assert.equal(c.calls.reset, 0, 'reset() would turn the opaque canvas black');
    assert.equal(c.calls.save, c.calls.restore, 'save/restore balanced: ' + JSON.stringify(c.calls));
    assert.deepEqual(c.events, ['bad price']);
    assert.deepEqual(c.thrown, ['bad price']);
    c.fail = null;
    c.frames(2);
    assert.deepEqual(c.events, ['bad price', null], 'a clean frame reports the recovery');
    assert.equal(c.calls.save, c.calls.restore);
  } finally { c.done(); }
});

test('drawing errors: at most once per 5 s per message, alternating errors do not flood, a recurrence after recovery is reported', () => {
  const c = failingChart();
  try {
    c.fail = 'A';
    c.frames(60);                                   // about 1 s of failing frames
    assert.deepEqual(c.thrown, ['A']);
    c.frames(1, 5000);                              // 5 s later, still failing: reported again
    assert.deepEqual(c.thrown, ['A', 'A']);
    c.fail = null; c.frames(1);                     // recovered
    c.fail = 'A'; c.frames(1);                      // the same fault again, right away: reported
    assert.deepEqual(c.thrown, ['A', 'A', 'A']);
    c.fail = null; c.frames(1);
    for (let i = 0; i < 60; i++) { c.fail = i % 2 ? 'B' : 'C'; c.frames(1); }   // two faults alternating
    assert.deepEqual(c.thrown.slice(3), ['C', 'B']);
    assert.deepEqual(c.events.filter(Boolean).length, c.thrown.length, 'every report is also an error event');
  } finally { c.done(); }
});

test('TickStore.feed with a time floor skips a tick whose time is NaN, like the array loop before it', () => {
  const s = new BB.TickStore();
  s.push(NaN, 25000, 1); s.push(T0 + 1, 25000.25, 2);
  const got = [];
  s.feed({ add: (t) => got.push(t) }, 0, T0);
  assert.deepEqual(got, [T0 + 1]);
});
