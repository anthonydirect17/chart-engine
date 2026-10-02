// Chart 1.14.0, the display round (Anthony's list of 2026-10-01): the pure parts. The room right of price, the price
// scale that keeps orders on screen (zoom to brackets) and no longer sized by the VWAP, the bar countdown, the ATR, the
// change from the prior settlement, the grid and room settings, the Time and Sales categories and their colors, the
// shared feed carrying q and the settlement, and the page's clock following the PC's (item 9). No browser.
const test = require('node:test');
const assert = require('node:assert');
const CE = require('../src/chart-engine.js');
const { LivePrefs: LP } = require('../live/live.js');
const W = require('../live/workspace.js');
const F = require('../live/feed.js');
const U = CE.util;

function memStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

test('room right of price: px at any zoom, the old bar count when none is set', () => {
  assert.strictEqual(U.roomBars(80, 8, 8), 10, '80 px at 8 px a bar is 10 bars');
  assert.strictEqual(U.roomBars(80, 0.8, 8), 100, 'zoomed out: still 80 px on screen (100 bars)');
  assert.strictEqual(U.roomBars(80, 40, 8), 2, 'zoomed in: 2 bars');
  assert.strictEqual(U.roomBars(0, 7, 8), 0, 'none');
  assert.strictEqual(U.roomBars(null, 7, 8), 8, 'not set: rightOffset bars, as before 1.14.0');
  assert.strictEqual(U.roomBars(undefined, 7, 8), 8);
  assert.strictEqual(U.roomBars(-5, 7, 8), 0, 'never negative');
  assert.strictEqual(U.roomBars(80, 0, 8), 8, 'no spacing yet: the bar count');
});

test('zoom to brackets: the scale takes in every order price, with the same margins as the candles', () => {
  const H = 500, tick = 0.25;
  const bare = U.fitRange(100, 110, null, H, tick, false);
  // 8% free at the top and the bottom: 10 points over 84% of 500 px
  const ppp = H * 0.84 / 10;
  assert.ok(Math.abs(bare.hi - (110 + H * 0.08 / ppp)) < 1e-9 && Math.abs(bare.lo - (100 - H * 0.08 / ppp)) < 1e-9);
  const withStop = U.fitRange(100, 110, [95, 112.5], H, tick, false);
  assert.ok(withStop.lo < 95 && withStop.hi > 112.5, 'a stop below and a target above are on screen');
  const span = 112.5 - 95, p2 = H * 0.84 / span;
  assert.ok(Math.abs(withStop.lo - (95 - H * 0.08 / p2)) < 1e-9, 'the stop sits at the bottom margin, as a low would');
  assert.deepStrictEqual(U.fitRange(100, 110, [105, NaN, null, undefined], H, tick, false), bare, 'orders inside the candles, or junk, change nothing');
  const vol = U.fitRange(100, 110, [95], H, tick, true);
  assert.ok(vol.lo < withStop.lo, 'with the volume bars: 20% free at the bottom');
  assert.strictEqual(U.fitRange(Infinity, -Infinity, null, H, tick, false), null, 'nothing to fit');
  const one = U.fitRange(100, 100, null, H, tick, false);
  assert.ok(one.hi > 100 && one.lo < 100, 'a flat price still has room above and below');
});

test('bar countdown: time left in the bar as the price tag shows it', () => {
  assert.strictEqual(U.fmtRemain(23), '0:23');
  assert.strictEqual(U.fmtRemain(22.2), '0:23', 'rounded up: a bar never shows 0:00 early');
  assert.strictEqual(U.fmtRemain(245), '4:05');
  assert.strictEqual(U.fmtRemain(3723), '1:02:03');
  assert.strictEqual(U.fmtRemain(2 * 86400 + 4 * 3600), '2d 04h');
  assert.strictEqual(U.fmtRemain(-3), '0:00', 'past the close: 0:00, never negative');
  assert.strictEqual(U.barRemain(36000, 60, 36000 + 37), '0:23', 'a 1 minute bar at 10:00:37');
  assert.strictEqual(U.barRemain(36000, 300, 36000 + 1), '4:59');
  assert.strictEqual(U.barRemain(36000, 3600, 36000 + 600), '50:00');
});

test('ATR: NinjaTrader\'s (the first period averaged, then Wilder\'s smoothing), closed bars only', () => {
  const bars = [{ h: 2, l: 1, c: 1.5 }, { h: 3, l: 1.5, c: 2 }, { h: 2.5, l: 2, c: 2.2 }, { h: 9, l: 8, c: 8.5 }];
  assert.strictEqual(U.atr(bars, 2, 2), 1.25, 'TR 1 and 1.5 (the bar\'s own range), averaged');
  assert.strictEqual(U.atr(bars, 2, 3), 0.875, 'then (1 * 1.25 + 0.5) / 2');
  // a gap: the true range runs from the previous close (2.2) to the high (9)
  assert.strictEqual(U.atr(bars, 2, 4), (0.875 + 6.8) / 2);
  assert.strictEqual(U.atr(bars, 5, 4), null, 'fewer bars than the period: none');
  assert.strictEqual(U.atr(bars, 1, 1), 1, 'period 1: the last true range');
  assert.strictEqual(U.atr([], 14), null);
  // the same on a flat run: every bar 4 ticks
  const flat = Array.from({ length: 30 }, (_, i) => ({ h: 101, l: 100, c: 100.5 }));
  assert.strictEqual(U.atr(flat, 14), 1);
});

test('% change from the prior settlement: blank, never estimated, when there is none', () => {
  assert.ok(Math.abs(U.pctFrom(20100, 20000) - 0.5) < 1e-12);
  assert.ok(Math.abs(U.pctFrom(19900, 20000) + 0.5) < 1e-12);
  assert.strictEqual(U.pctFrom(20000, null), null);
  assert.strictEqual(U.pctFrom(20000, undefined), null);
  assert.strictEqual(U.pctFrom(20000, 0), null);
  assert.strictEqual(U.pctFrom(null, 20000), null);
  assert.strictEqual(U.pctFrom(NaN, 20000), null);
});

test('settings: grid lines off and 80 px of room by default, only the listed values kept', () => {
  const s = memStorage();
  const p = LP.create(s);
  assert.strictEqual(p.settings().grid, 'off');
  assert.strictEqual(p.settings().room, 80);
  p.setSetting('grid', 'on'); p.setSetting('room', 160);
  assert.strictEqual(LP.create(s).settings().grid, 'on');
  assert.strictEqual(LP.create(s).settings().room, 160);
  for (const bad of ['yes', true, 1]) { p.setSetting('grid', bad); assert.strictEqual(LP.create(s).settings().grid, 'off'); }
  for (const bad of [81, '80', -40, null]) { p.setSetting('room', bad); assert.strictEqual(LP.create(s).settings().room, 80); }
  assert.deepStrictEqual(LP.ROOMS, [0, 40, 80, 160]);
  p.setSetting('glide', 'fast');
  assert.strictEqual(LP.create(s).settings().room, 80, 'one field at a time');
});

test('Time and Sales categories: each its own class, a side when q is unknown', () => {
  assert.strictEqual(W.tapeClass(2, 1), 'q2');
  assert.strictEqual(W.tapeClass(1, 1), 'q1');
  assert.strictEqual(W.tapeClass(0, -1), 'q0', 'between the quote: the category, whatever the side (tick rule)');
  assert.strictEqual(W.tapeClass(-1, -1), 'qm1');
  assert.strictEqual(W.tapeClass(-2, -1), 'qm2');
  assert.strictEqual(W.tapeClass(-128, 1), 'buy', 'no q (ChartBridge before 0.3.8): by side, as before');
  assert.strictEqual(W.tapeClass(undefined, -1), 'sell');
  assert.strictEqual(W.tapeClass(null, 0), '', 'unknown side: plain');
  assert.strictEqual(W.tapeClass(3, 1), 'buy', 'out of range is unknown');
  assert.deepStrictEqual(W.TAPE_CATS.map(c => c.q), [2, 1, 0, -1, -2]);
});

test('Time and Sales colors: house defaults, the brighter pair outside the quote, one color written at a time', () => {
  const d = W.cleanTapeColors(null);
  assert.deepStrictEqual(Object.keys(d), ['above', 'ask', 'mid', 'bid', 'below']);
  const lum = h => CE.util.luminance(CE.util.parseColor(h));
  assert.ok(lum(d.above) > lum(d.ask), 'above the ask brighter than at the ask');
  assert.ok(lum(d.below) > lum(d.bid), 'below the bid brighter than at the bid');
  for (const k of Object.keys(d)) assert.ok(CE.util.contrast(d[k], '#0B0F15') >= 4.5, k + ' reads on the panel');
  const s = memStorage();
  assert.ok(W.setTapeColor(s, 'ask', '#00ff00'));
  assert.ok(W.setTapeColor(s, 'bid', '#FF0000'));
  assert.deepStrictEqual(JSON.parse(s.getItem(W.KEYS.tapeColors)), { ask: '#00FF00', bid: '#FF0000' }, 'only what was set by hand');
  assert.strictEqual(W.readTapeColors(s).ask, '#00FF00');
  assert.strictEqual(W.readTapeColors(s).above, d.above);
  assert.ok(!W.setTapeColor(s, 'ask', 'green'), 'not a hex: refused');
  assert.ok(!W.setTapeColor(s, 'nope', '#000000'));
  assert.ok(W.setTapeColor(s, 'ask', null), 'null: back to the default');
  assert.strictEqual(W.readTapeColors(s).ask, d.ask);
  assert.ok(W.resetTapeColors(s));
  assert.deepStrictEqual(W.readTapeColors(s), d);
  s.setItem(W.KEYS.tapeColors, '{junk');
  assert.deepStrictEqual(W.readTapeColors(s), d, 'junk reads as the defaults');
  const throws = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepStrictEqual(W.readTapeColors(throws), d);
  assert.strictEqual(W.setTapeColor(throws, 'ask', '#000000'), false);
});

test('large prints: the tape reads the bubbles\' floors (one key) by the signals\' own rule', () => {
  const s = memStorage();
  const p = LP.create(s);
  const f = p.largeFloors();
  const at = (root, sec) => CE.largeFloorAt(f[root], sec);
  assert.strictEqual(at('NQ', 10 * 3600), 50, 'NQ in regular hours');
  assert.strictEqual(at('NQ', 20 * 3600), 25, 'NQ overnight');
  assert.strictEqual(at('ES', 9 * 3600 + 30 * 60), 100, '09:30 is RTH');
  assert.strictEqual(at('ES', 16 * 3600 + 15 * 60), 50, '16:15 is overnight');
  assert.strictEqual(at('MNQ', 12 * 3600), 100); assert.strictEqual(at('MES', 3 * 3600), 50);
  p.setLargeFloor('NQ', 'rth', 40);
  assert.strictEqual(JSON.parse(s.getItem('live-tape-floors-v1')).NQ.rth, 40, 'the same key the workspace\'s Time and Sales used');
  assert.strictEqual(W.readFloors(s).NQ.rth, 40);
});

/* the shared feed (live/feed.js): q and the settlement reach a panel that joins later */
class FakeWS {
  constructor() { this.sent = []; this.readyState = 0; FakeWS.all.push(this); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; if (this.onopen) this.onopen({}); }
  msg(m) { if (this.onmessage) this.onmessage({ data: JSON.stringify(m) }); }
}
FakeWS.all = [];
const wait = (ms = 5) => new Promise(r => setTimeout(r, ms));
function panel(h, root, need) {
  const p = { got: [] };
  const s = h.open(root);
  s.onmessage = ev => { const m = ev.message; p.got.push(m); if (m.type === 'hello') s.send(JSON.stringify(Object.assign({ type: 'subscribe', root }, need))); };
  return p;
}

test('the feed keeps each trade\'s Time and Sales category, so a tape that joins later colors it the same', async () => {
  FakeWS.all = [];
  const h = F.create({ wsUrl: 'ws://x/ws', WebSocket: FakeWS });
  const HELLO = { type: 'hello', version: '0.3.8', instruments: [{ root: 'MNQ', tick: 0.25, settlement: 20000, settlementDate: '2026-10-01' }], accounts: [], features: ['liveFirst', 'profile'] };
  panel(h, 'MNQ', { days: 1, tickHours: 2, liveFirst: true, sub: 1 });
  await wait();
  const ws = FakeWS.all[0]; ws.open(); ws.msg(HELLO); await wait();
  const sub = ws.sent[0].sub;
  ws.msg({ type: 'ticks', root: 'MNQ', sub, ticks: [[1, 10, 1], [2, 10.25, 2, null, null, 1], [3, 10.5, 3, 1, 2, 2]], done: true });
  ws.msg({ type: 'ready', root: 'MNQ', sub });
  ws.msg({ type: 'tick', root: 'MNQ', t: 4, p: 10.25, v: 4, s: -1, sm: 2, q: -1, u: 1, rx: 2 });
  ws.msg({ type: 'tick', root: 'MNQ', t: 5, p: 10.25, v: 5, s: -1, sm: 3, u: 1, rx: 2 });   // no q: unknown
  ws.msg({ type: 'tick', root: 'MNQ', t: 6, p: 10, v: 6, q: 0 });                           // 0.3.8 with no side
  ws.msg({ type: 'settlement', root: 'MNQ', p: 20100.25, date: '2026-10-02' });
  // a tape (no ticks) and a tick chart join later: the live trades replayed, the backfill rebuilt from the columns
  const tape = panel(h, 'MNQ', { days: 1, tickHours: 0 });
  const chart = panel(h, 'MNQ', { days: 1, tickHours: 2, liveFirst: true, sub: 2 });
  await wait(20);
  const hello = tape.got.find(m => m.type === 'hello');
  assert.strictEqual(hello.instruments[0].settlement, 20100.25, 'the later panel\'s hello has the new settlement');
  assert.strictEqual(hello.instruments[0].settlementDate, '2026-10-02');
  const ticks = tape.got.filter(m => m.type === 'tick');
  assert.deepStrictEqual(ticks.map(m => m.q), [-1, undefined, 0], 'q replayed as it came, none where none came');
  assert.deepStrictEqual(ticks.map(m => m.s), [-1, -1, undefined]);
  const rows = chart.got.filter(m => m.type === 'ticks').flatMap(m => m.ticks);
  assert.deepStrictEqual(rows, [[1, 10, 1], [2, 10.25, 2, null, null, 1], [3, 10.5, 3, 1, 2, 2]], 'the backfill rows as ChartBridge 0.3.8 sent them');
  h.close();
});

test('the page\'s clock follows the PC\'s clock fixes (item 9): re-anchored when off by more than 50 ms', () => {
  let perf = 1000, wall = 1700000000000;
  const c = LP.pageClock({ perfNow: () => perf, wallNow: () => wall, origin: wall - perf });
  assert.strictEqual(c.now(), wall, 'starts on the PC\'s clock');
  perf += 5000; wall += 5000;
  assert.strictEqual(c.check(), 0, 'in step: nothing moves');
  assert.strictEqual(c.now(), wall);
  // Windows time sync steps the PC clock back 99 ms: the page's clock is 99 ms ahead until it checks
  wall -= 99;
  assert.strictEqual(c.now() - wall, 99);
  assert.strictEqual(c.check(), -99, 'one step of -99 ms');
  assert.strictEqual(c.now(), wall, 'on the PC\'s clock again: no false "local -99 ms"');
  assert.strictEqual(c.steps, 1);
  // a drift inside the 50 ms slack is left alone (no jitter every 5 s)
  wall += 30;
  assert.strictEqual(c.check(), 0);
  assert.strictEqual(wall - c.now(), 30);
  wall += 25;                                        // 55 ms now: re-anchored
  assert.strictEqual(c.check(), 55);
  assert.strictEqual(c.now(), wall);
  // forward steps too, and the time keeps running on the monotonic clock between checks
  wall += 2000;
  assert.strictEqual(c.check(), 2000);
  perf += 10; wall += 10;
  assert.strictEqual(c.now(), wall);
  // every 5 s, on the interval it is given
  let every = 0, fn = null;
  c.start((f, ms) => { fn = f; every = ms; return 7; });
  assert.strictEqual(every, 5000);
  wall -= 500; fn();
  assert.strictEqual(c.now(), wall, 'the interval re-anchors');
  let cleared = null; c.stop(id => { cleared = id; });
  assert.strictEqual(cleared, 7);
  // no origin: starts from the wall clock
  const d = LP.pageClock({ perfNow: () => 5, wallNow: () => 1000 });
  assert.strictEqual(d.now(), 1000);
  assert.strictEqual(LP.CLOCK_SLACK_MS, 50); assert.strictEqual(LP.CLOCK_EVERY_MS, 5000);
});

test('the ticket link\'s stamps and its move deadline never read a stepped clock (review D2)', async () => {
  const TL = require('../live/ticket-link.js');
  const saved = global.self;
  try {
    global.self = { ChartLivePageClock: { now: () => 42 } };            // a page clock re-anchored per window: not used
    assert.ok(Math.abs(TL.browserNow() - Date.now()) < 50, 'cross-window stamps are Date.now()');
  } finally { if (saved === undefined) delete global.self; else global.self = saved; }
  // move(): the deadline counts its own waits; a clock that jumps back 10 s does not keep it going
  let t = 1e6, n = 0;
  const timers = [];
  const link = TL.create({ wid: 'A', channel: { post() {}, onmessage: null }, locks: { request: (name, o, fn) => Promise.resolve(fn(null)) },
    now: () => (t -= 10000), setTimeout: (fn, ms) => { timers.push(fn); return timers.length; }, clearTimeout() {} });
  const m = link.move();
  for (let k = 0; k < 200 && timers.length; k++) { const f = timers.shift(); n++; f(); await new Promise(r => setImmediate(r)); }
  assert.equal(await m, 'busy');
  assert.ok(n >= 25 && n <= 35, 'about ' + TL.MOVE_MS + ' ms of 50 ms waits, whatever the clock did: ' + n + ' tries');
});

test('panels resize from any edge or corner: whole cells, the opposite edges stay put, at least 2 x 1, inside the grid', () => {
  const m = W.metrics(12 * 100 + 11 * 6 + 12, 6 * 100 + 5 * 6 + 12);   // 100 px cells, 6 px gaps
  const p = { x: 4, y: 2, w: 4, h: 2 };
  assert.deepStrictEqual(W.snapResizeEdge(p, 'se', 106, 106, m), { x: 4, y: 2, w: 5, h: 3 }, 'the corner it always had');
  assert.deepStrictEqual(W.snapResizeEdge(p, 'se', 106, 106, m), W.snapResize(p, 106, 106, m), 'the same as before 1.14.0');
  assert.deepStrictEqual(W.snapResizeEdge(p, 'w', -212, 50, m), { x: 2, y: 2, w: 6, h: 2 }, 'left edge out: x and w, the right edge kept; dy ignored');
  assert.deepStrictEqual(W.snapResizeEdge(p, 'w', 1000, 0, m), { x: 6, y: 2, w: 2, h: 2 }, 'left edge in: never under 2 wide');
  assert.deepStrictEqual(W.snapResizeEdge(p, 'n', 0, -106, m), { x: 4, y: 1, w: 4, h: 3 }, 'top edge up');
  assert.deepStrictEqual(W.snapResizeEdge(p, 'n', 0, -1000, m), { x: 4, y: 0, w: 4, h: 4 }, 'never past the top');
  assert.deepStrictEqual(W.snapResizeEdge(p, 'n', 0, 1000, m), { x: 4, y: 3, w: 4, h: 1 }, 'at least 1 tall');
  assert.deepStrictEqual(W.snapResizeEdge(p, 'e', 1000, 0, m), { x: 4, y: 2, w: 8, h: 2 }, 'to the grid edge');
  assert.deepStrictEqual(W.snapResizeEdge(p, 's', 0, 1000, m), { x: 4, y: 2, w: 4, h: 4 });
  assert.deepStrictEqual(W.snapResizeEdge(p, 'nw', -106, -106, m), { x: 3, y: 1, w: 5, h: 3 });
  assert.deepStrictEqual(W.snapResizeEdge(p, 'ne', 106, -106, m), { x: 4, y: 1, w: 5, h: 3 });
  assert.deepStrictEqual(W.snapResizeEdge(p, 'sw', -106, 106, m), { x: 3, y: 2, w: 5, h: 3 });
  assert.deepStrictEqual(W.snapResizeEdge(p, 'w', -40, 0, m), p, 'under half a cell: no change (snapped)');
  assert.deepStrictEqual(W.snapResizeEdge(p, '', 500, 500, m), p, 'no edge: nothing moves');
  // overlap is still refused by fits()
  const other = { id: 'b', x: 0, y: 2, w: 3, h: 2 };
  assert.ok(!W.fits(W.snapResizeEdge(p, 'w', -212, 0, m), [other], 'a'), 'growing over a neighbour is refused');
  assert.ok(W.fits(W.snapResizeEdge(p, 'w', -106, 0, m), [other], 'a'), 'up to it is fine');
});

test('bubble size shows the order size: the area follows size / floor (Anthony, from WORK)', () => {
  const r = k => U.bubbleRadius(k * 50, 50);
  assert.ok(Math.abs(r(1) - 4.8) < 1e-9, 'the floor: 4.8 px');
  assert.ok(Math.abs(r(2) - 4.8 * Math.SQRT2) < 1e-9 && r(2) / r(1) > 1.4, 'twice the floor: clearly bigger (6.8 px)');
  assert.ok(Math.abs(r(4) - 9.6) < 1e-9, 'four times: twice the radius (9.6 px)');
  assert.ok(Math.abs(r(10) - 4.8 * Math.sqrt(10)) < 1e-9 && r(10) > 15, 'ten times: stands out (15.2 px)');
  assert.ok(Math.abs((r(10) / r(1)) ** 2 - 10) < 1e-9, 'the area grows with the size');
  assert.ok(r(30) > 26 && r(30) < 27, 'about 30 times: near the cap (26.3 px)');
  assert.strictEqual(r(40), 27, 'over the cap: 27 px');
  assert.strictEqual(r(1000), 27);
  assert.strictEqual(U.bubbleRadius(10, 50), 4.8, 'under the floor (a group that started at it): never smaller');
  assert.strictEqual(U.bubbleRadius(100, 0), U.BUBBLE_R_MAX, 'no floor: as a floor of 1');
});

test('the price scale keeps the legend free at the top (the high never under the legend)', () => {
  const H = 300, tick = 0.25;
  const bare = U.fitRange(100, 110, null, H, tick, false);
  const legend = U.fitRange(100, 110, null, H, tick, false, 60);   // a 2-line legend and its margin: 60 px
  const yOf = (f, p) => (f.hi - p) / (f.hi - f.lo) * H;
  assert.ok(Math.abs(yOf(bare, 110) - H * 0.08) < 1e-9, 'without: 8% (24 px) above the high');
  assert.ok(Math.abs(yOf(legend, 110) - 60) < 1e-9, 'with: the high 60 px down, below the legend');
  assert.ok(Math.abs(yOf(legend, 100) - (H - H * 0.08)) < 1e-9, 'the bottom margin unchanged');
  assert.deepStrictEqual(U.fitRange(100, 110, null, H, tick, false, 10), bare, 'a smaller room than 8%: 8%');
  const huge = U.fitRange(100, 110, null, H, tick, false, 1000);
  assert.ok(Math.abs(yOf(huge, 110) - H * 0.45) < 1e-9, 'never more than 45% of the plot');
  const both = U.fitRange(100, 110, [90], H, tick, false, 60);
  assert.ok(Math.abs(yOf(both, 110) - 60) < 1e-9 && yOf(both, 90) < H, 'with orders (zoom to brackets) too');
});

test('bubbles: a group never straddles bars (Anthony, WORK 59.png: a bubble above a bar whose range did not hold it)', () => {
  const lp = new CE.LargePrints({ floorAt: () => 10, tick: 0.25 });
  // a fast sweep: a range bar closes at 100.04 s and the next opens; same side prints within 100 ms
  lp.add(36000.00, 20000.00, 6, 1, 35990);                 // bar A (from 35990)
  lp.add(36000.03, 20000.25, 6, 1, 35990);                 // still bar A: the group reaches the floor, 12 at 20000.25 vwap
  lp.add(36000.05, 20010.00, 30, 1, 36000.04);             // bar B, 50 ms later: a new group, not merged into A's
  assert.strictEqual(lp.list.length, 2, 'two bubbles, one per bar: ' + JSON.stringify(lp.list));
  const [a, b] = lp.list;
  assert.strictEqual(a.b, 35990, 'the first on bar A');
  assert.ok(a.p >= 20000 && a.p <= 20000.25, 'at bar A\'s prices (' + a.p + ')');
  assert.strictEqual(b.b, 36000.04, 'the second on bar B');
  assert.strictEqual(b.p, 20010, 'at bar B\'s price');
  // "one bar early" (60.png): the group's first print was the last of bar A, its size and price came in bar B; before
  // the fix the bubble sat on A (its first print's time) at B's price
  const e = new CE.LargePrints({ floorAt: () => 10, tick: 0.25 });
  e.add(36000.00, 20000, 1, 1, 35990);                     // A's last print, alone under the floor
  e.add(36000.04, 20005, 20, 1, 36000.04);                 // B's sweep, 40 ms later
  assert.deepStrictEqual(e.list.map(x => [x.b, x.p]), [[36000.04, 20005]], 'on bar B, the bar it traded in, not one bar early');
  // a time bar: a minute boundary splits a group too
  const t = new CE.LargePrints({ floorAt: () => 5, tick: 0.25 });
  t.add(36059.98, 20000, 6, -1, 36000); t.add(36060.02, 19990, 6, -1, 36060);
  assert.deepStrictEqual(t.list.map(x => [x.b, x.p]), [[36000, 20000], [36060, 19990]], 'one bubble per minute bar');
  // without a bar (an older caller): grouped by time and side as before
  const o = new CE.LargePrints({ floorAt: () => 5, tick: 0.25 });
  o.add(1, 100, 3, 1); o.add(1.05, 101, 3, 1);
  assert.strictEqual(o.list.length, 1);
});

/* ---- batch 2 (Anthony, 2026-10-02) */
const etT = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi, 0) / 1000;   // New York wall clock stored as UTC, as the engine keeps it

test('VWAP anchor: full session from 18:00 ET (the default), RTH only from 09:30 ET, each resetting at its own start', () => {
  // one-minute bars from 17:58 on Monday to 16:02 on Tuesday, every 30 minutes plus the minutes around each anchor
  const bars = [], add = (t, p, v) => bars.push({ t, o: p, h: p + 1, l: p - 1, c: p, v });
  add(etT(2026, 9, 28, 16, 58), 50, 10);                                  // Monday's session, before the break
  for (let m = 0; m <= 22 * 60; m += 30) add(etT(2026, 9, 28, 18, 0) + m * 60, 100 + (m >= 15.5 * 60 ? 20 : 0), 10);
  add(etT(2026, 9, 29, 9, 29), 110, 10); add(etT(2026, 9, 29, 15, 59), 130, 10);
  add(etT(2026, 9, 29, 18, 0), 140, 10);                                   // Wednesday's session starts
  bars.sort((a, b) => a.t - b.t);
  const full = U.addSessionVwap(bars.map(b => Object.assign({}, b)), 18 * 3600);
  const at = t => full.find(b => b.t === t);
  assert.equal(at(etT(2026, 9, 28, 16, 58)).vw, 50, 'Monday alone');
  assert.equal(at(etT(2026, 9, 28, 18, 0)).vw, 100, 'reset at 18:00 ET');
  assert.equal(at(etT(2026, 9, 29, 9, 0)).vw, 100, 'the overnight is in the full-session VWAP');
  assert.ok(at(etT(2026, 9, 29, 15, 30)).vw > 100 && at(etT(2026, 9, 29, 15, 30)).vw < 120, 'and still weighs at 15:30');
  assert.equal(at(etT(2026, 9, 29, 18, 0)).vw, 140, 'reset at the next 18:00');
  const rth = U.rthVwap(bars, { sessionStart: 18 * 3600 });
  const end = t => t + 60;                                                 // read at a bar's end, as the page does
  assert.equal(U.vwapAt(rth, end(etT(2026, 9, 29, 9, 29))), null, 'nothing before 09:30');
  assert.equal(U.vwapAt(rth, end(etT(2026, 9, 29, 9, 30))), 120, 'from 09:30 ET only: the first bar alone (the 09:29 one at 110 is not in)');
  const r1530 = U.vwapAt(rth, end(etT(2026, 9, 29, 15, 30)));
  assert.ok(r1530 > at(etT(2026, 9, 29, 15, 30)).vw, 'without the overnight, RTH only is nearer the late prices');
  assert.ok(U.vwapAt(rth, end(etT(2026, 9, 29, 15, 59))) > r1530, 'the 15:59 bar (ending at 16:00) still in');
  assert.equal(U.vwapAt(rth, end(etT(2026, 9, 29, 18, 0))), null, 'nothing after 16:00');
  assert.equal(U.vwapAt(rth, end(etT(2026, 9, 28, 18, 0))), null, 'nor overnight');
  // a bar between two series points reads the last one at or before it in the same day
  assert.equal(U.vwapAt(rth, end(etT(2026, 9, 29, 9, 45))), 120);
  // the gear: the full session by default, only the two values kept, per chart
  const p = LP.create(memStorage());
  assert.equal(p.indicatorOptions('main', 'vwap').session, 'full');
  assert.equal(p.setIndicatorOption('pane-2', 'vwap', 'session', 'rth'), true);
  assert.equal(p.indicatorOptions('pane-2', 'vwap').session, 'rth');
  assert.equal(p.indicatorOptions('main', 'vwap').session, 'full', 'per chart');
  assert.equal(p.setIndicatorOption('main', 'vwap', 'session', 'eth'), false);
});

test('Levels: each line its own toggle; the IB folded in (migrateIb) and old indicator presets kept', () => {
  assert.deepEqual(LP.LEVEL_LINES.map(L => L.k), ['pdh', 'pdl', 'pc', 'onh', 'onl', 'vah', 'val', 'poc', 'ibh', 'ibl']);
  assert.ok(!LP.INDICATORS.some(d => d.id === 'ib'), 'no IB indicator or chip of its own');
  const p = LP.create(memStorage());
  assert.ok(LP.LEVEL_LINES.every(L => p.indicatorOptions('main', 'levels')[L.k] === 'on'), 'every line on by default');
  assert.equal(p.setIndicatorOption('main', 'levels', 'poc', 'off'), true);
  assert.equal(p.indicatorOptions('main', 'levels').poc, 'off');
  assert.equal(p.indicatorOptions('main', 'levels').pdh, 'on', 'the others unchanged');
  assert.equal(p.setIndicatorOption('main', 'levels', 'poc', 'maybe'), false);
  // migrateIb: IB shown and Levels shown: both IB lines on, the saved choices kept
  const m1 = LP.migrateIb({ ind: { levels: { on: true, shown: true, pin: true }, ib: { on: true, shown: true, pin: true } }, recent: ['ib', 'vwap', 'levels'], restore: null }, { pdh: 'off' });
  assert.deepEqual(m1.levels, { pdh: 'off', ibh: 'on', ibl: 'on' });
  assert.ok(!('ib' in m1.pane.ind));
  assert.deepEqual(m1.pane.recent, ['levels', 'vwap'], 'Recent names Levels once');
  // IB shown, Levels off: Levels on with only the IB lines, pinned as the IB was
  const m2 = LP.migrateIb({ ind: { levels: { on: false, shown: true, pin: false }, ib: { on: true, shown: true, pin: true } } }, null);
  assert.deepEqual(m2.pane.ind.levels, { on: true, shown: true, pin: true });
  assert.deepEqual(Object.entries(m2.levels).filter(([, v]) => v === 'on').map(([k]) => k), ['ibh', 'ibl']);
  // IB hidden or off: its lines off, Levels as it was
  for (const ib of [{ on: true, shown: false, pin: true }, { on: false, shown: true, pin: false }]) {
    const m = LP.migrateIb({ ind: { levels: { on: true, shown: true, pin: true }, ib } }, { vah: 'on' });
    assert.deepEqual(m.levels, { vah: 'on', ibh: 'off', ibl: 'off' });
    assert.deepEqual(m.pane.ind.levels, { on: true, shown: true, pin: true });
  }
  assert.equal(LP.migrateIb({ ind: { levels: { on: true } } }, {}), null, 'nothing to carry over');
  assert.equal(LP.migrateIb(null), null);
  // through the store: a pane saved by 1.13 with the IB, read once, written back without it
  const st = memStorage({ 'live-indicators-v2': JSON.stringify({ 'pane-2': { ind: { levels: { on: false, shown: true, pin: false }, ib: { on: true, shown: true, pin: true } }, recent: ['ib'] } }) });
  const q = LP.create(st);
  assert.equal(q.indicators('pane-2').levels, true);
  assert.deepEqual([q.indicatorOptions('pane-2', 'levels').ibh, q.indicatorOptions('pane-2', 'levels').pdh], ['on', 'off']);
  assert.ok(!('ib' in JSON.parse(st.getItem('live-indicators-v2'))['pane-2'].ind), 'written back without the IB');
  // an indicator preset saved before 1.14.0 (no profile row colors) is kept, the IB colors with it (now in the Levels gear)
  const old = { vwap: '#B69CFF', prior: '#9AA8B8', overnight: '#7FB2FF', value: '#E0B45A', close: '#8392A5', ibHigh: '#F7C6EC', ibLow: '#E58BD2', vpPoc: '#E0B45A',
    sigBull: '#38DCE8', sigBullLine: '#9CF1F7', sigBear: '#F3D84A', sigBearLine: '#FFEC8F' };
  const kept = LP.cleanPresets({ chart: [], indicator: [{ id: 'p1', name: 'Mine', colors: old }] }).indicator;
  assert.equal(kept.length, 1);
  assert.equal(kept[0].colors.ibHigh, '#F7C6EC');
  assert.deepEqual([kept[0].colors.vpRow, kept[0].colors.vpValue], [CE.DEFAULT_THEME.vpRow.toUpperCase(), CE.DEFAULT_THEME.vpValue.toUpperCase()]);
  assert.equal(LP.INDICATOR_COLORS.find(c => c.key === 'ibHigh').id, 'levels');
  assert.deepEqual(LP.INDICATOR_COLORS.filter(c => c.id === 'vp').map(c => c.key), ['vpRow', 'vpValue', 'vpPoc'], 'the profile gear: rows, value area, POC');
});

test('chips: up to ten, the eleventh refused; the header text toggle saved per chart, on by default', () => {
  assert.equal(LP.PIN_MAX, 10);
  let st = LP.defaultPane('main');
  for (const d of LP.INDICATORS) st = LP.Pane.add(st, d.id);
  assert.ok(LP.Pane.pinned(st) <= 10);
  const p = LP.create(memStorage());
  assert.equal(p.legendShown('main'), true, 'on by default');
  assert.equal(p.setLegendShown('pane-3', false), true);
  assert.equal(p.legendShown('pane-3'), false);
  assert.equal(p.legendShown('main'), true, 'per chart');
  assert.equal(p.setLegendShown('pane-3', true), true);
  assert.equal(p.legendShown('pane-3'), true);
  assert.equal(p.setLegendShown('', false), false, 'a pane id is needed');
  assert.equal(p.setLegendShown('__proto__', false), false);
});

test('RTH VWAP kept up to date bar by bar equals the whole computation, and starts over on other bars (review D2)', () => {
  const bars = [];
  let S = null, p = 100;
  const t0 = etT(2026, 9, 28, 9, 0);
  for (let i = 0; i < 1500; i++) {                       // two days of minutes, some trades changing the forming bar
    const t = t0 + i * 60;
    p += ((i * 7919) % 11 - 5) * 0.25;
    bars.push({ t, o: p, h: p + 1, l: p - 1, c: p, v: 1 + (i % 9) });
    for (let k = 0; k < 2; k++) {                          // the forming bar changes, then is read again
      const b = bars[bars.length - 1]; b.c += 0.25; b.h = Math.max(b.h, b.c); b.v += 1;
      S = U.rthVwapUpdate(S, bars, { sessionStart: 18 * 3600 });
      if (i % 97 === 0 || i === 1499) {
        const whole = U.rthVwap(bars, { sessionStart: 18 * 3600 });
        assert.deepEqual([S.t.length, S.vw.length], [whole.t.length, whole.vw.length], 'at bar ' + i);
        for (let j = 0; j < whole.t.length; j++) { assert.equal(S.t[j], whole.t[j]); assert.ok(Math.abs(S.vw[j] - whole.vw[j]) < 1e-9, 'bar ' + i + ' point ' + j); }
      }
    }
  }
  // other bars (a reload, another view): started over, not mixed in
  const other = bars.slice(500).map(b => Object.assign({}, b, { t: b.t + 7 }));
  const S2 = U.rthVwapUpdate(S, other, { sessionStart: 18 * 3600 }), w2 = U.rthVwap(other, { sessionStart: 18 * 3600 });
  assert.deepEqual(S2.t, w2.t);
  assert.ok(S2.vw.every((v, j) => Math.abs(v - w2.vw[j]) < 1e-9));
});
