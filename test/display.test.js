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

test('the ticket link\'s stamps read the page\'s clock when there is one', () => {
  const TL = require('../live/ticket-link.js');
  const saved = global.self;
  try {
    global.self = { ChartLivePageClock: { now: () => 42 } };
    assert.strictEqual(TL.browserNow(), 42, 'the same clock as the local delay');
    global.self = {};
    assert.ok(Math.abs(TL.browserNow() - Date.now()) < 1000, 'no page clock (Node): the browser\'s own');
  } finally { if (saved === undefined) delete global.self; else global.self = saved; }
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
