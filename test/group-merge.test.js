'use strict';
// Chart 1.43.0 (Anthony 2026-11-04, "merge on the chart"): on a group ticket, a MARKET entry fills each account at its own price and
// ChartBridge places each account's bracket from its own fill, so the members' stops (and targets) can sit a tick apart. Stops, and
// separately targets, of one role, side and kind within OT.GROUP_MERGE_TICKS (2) of each other draw as ONE line: clusters that
// never span more than 2 ticks (a chain of 1 tick gaps never grows into one long line), the line at the price nearest the entry,
// its quantity the sum, the range and each account's own price in its tooltip, its label's ticks and dollars the sum of each
// member's own risk; a drag, the x and a planned line's drag act on every member. A fake clock and connection; made-up accounts
// and prices.
const test = require('node:test');
const assert = require('node:assert/strict');
const OT = require('../live/order-ticket.js');
const { LivePrefs: LP } = require('../live/live.js');
const TC = require('../live/trade.js');

/* ---------------- the clustering rule (live/order-ticket.js) */
const at = ticks => ({ price: 25000 + ticks * 0.25 });
const spans = cs => cs.map(c => Math.max(...c.items.map(x => Math.round(x.price / 0.25))) - Math.min(...c.items.map(x => Math.round(x.price / 0.25))));

test('1.43.0: the merge distance is a named constant, 2 ticks', () => {
  assert.equal(OT.GROUP_MERGE_TICKS, 2);
});

test('1.43.0: clustering: 1 tick apart one line, 2 ticks one line, 3 ticks two lines', () => {
  assert.equal(OT.mergeLevels([at(0), at(1)], 0.25, 'high').length, 1, '1 tick apart');
  assert.equal(OT.mergeLevels([at(0), at(2)], 0.25, 'high').length, 1, '2 ticks apart');
  assert.equal(OT.mergeLevels([at(0), at(3)], 0.25, 'high').length, 2, '3 ticks apart');
  assert.equal(OT.mergeLevels([at(0), at(0), at(0)], 0.25, 'low').length, 1, 'one price: one line, as before');
});

test('1.43.0: clustering is transitive-safe: a chain of 1 tick gaps spanning 4 ticks gives at least two lines, none over 2 ticks', () => {
  for (const end of ['high', 'low']) {
    const cs = OT.mergeLevels([at(0), at(1), at(2), at(3), at(4)], 0.25, end);
    assert.ok(cs.length >= 2, end + ': ' + cs.length + ' lines');
    assert.ok(spans(cs).every(s => s <= OT.GROUP_MERGE_TICKS), end + ': every line spans at most 2 ticks: ' + spans(cs));
    assert.equal(cs.reduce((n, c) => n + c.items.length, 0), 5, 'every price in one line');
  }
  /* a long chain: still never more than 2 ticks a line */
  const chain = Array.from({ length: 40 }, (_, i) => at(i));
  assert.ok(spans(OT.mergeLevels(chain, 0.25, 'high')).every(s => s <= 2));
});

test('1.43.0: the walk starts at the end nearest the entry and the line sits at its first price', () => {
  /* a sell stop (under a long): the highest is nearest the entry; ticks 0,1,2,3,4 from the top: {4,3,2} {1,0} */
  const hi = OT.mergeLevels([at(0), at(1), at(2), at(3), at(4)], 0.25, 'high');
  assert.deepEqual(hi.map(c => c.price), [25001, 25000.25]);
  assert.deepEqual(hi[0].items.map(x => x.price), [25000.5, 25000.75, 25001], 'the members in the order given');
  const lo = OT.mergeLevels([at(0), at(1), at(2), at(3), at(4)], 0.25, 'low');
  assert.deepEqual(lo.map(c => c.price), [25000, 25000.75]);
  assert.equal(OT.mergeEnd({ role: 'stop', side: 'sell' }), 'high', 'a sell stop: the highest is nearest the entry');
  assert.equal(OT.mergeEnd({ role: 'stop', side: 'buy' }), 'low', 'a buy stop: the lowest');
  assert.equal(OT.mergeEnd({ role: 'target', side: 'sell' }), 'low', 'a sell target: the lowest');
  assert.equal(OT.mergeEnd({ role: 'target', side: 'buy' }), 'high', 'a buy target: the highest');
  assert.equal(OT.mergeEnd({ role: null, side: 'sell', plan: { role: 'stop' } }), 'high', 'a buy entry\'s planned stop');
  assert.equal(OT.mergeEnd({ role: null, side: 'sell', plan: { role: 'target' } }), 'low', 'a buy entry\'s planned target');
});

/* ---------------- the group ticket's lines (live/trade.js), as test/group-ticket.test.js's rig */
function rig() {
  let clock = 5000; const timers = []; let tid = 0;
  const store = new Map();
  const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const R = { sent: [], notes: [], root: 'NQ', last: 25000 };
  const groups = [{ id: 'g1', name: 'Lucid', perMember: true, riskPct: 10, members: ['SIM-A', 'SIM-B', 'SIM-C'], tradeOut: [] }];
  const env = {
    LP, prefs: LP.create(storage), fetch: () => Promise.resolve({ ok: true, text: () => Promise.resolve('{"token":"t"}') }),
    send: m => R.sent.push(JSON.parse(JSON.stringify(m))), open: () => true, sock: () => R,
    root: () => R.root, lastPrice: () => R.last, qty: () => 1, pickerAccount: () => core.TR.account, wantedAccount: () => 'group:g1',
    tick: () => 0.25, served: () => true, fmt: p => p.toFixed(2), flash: (t, l) => R.notes.push((l ? l + ': ' : '') + t),
    later: (fn, ms) => { timers.push({ id: ++tid, at: clock + ms, fn }); return tid; },
    changed: () => {}, armed: () => {}, applied: () => {}, lost: () => {}, syncAccounts: () => {}, batch: () => {}, unsent: () => {}, armBlocked: () => '', destroyed: () => false, now: () => clock,
    groups: () => groups, confirmGroup: () => false, strategy: () => null,
  };
  const core = TC.create(env);
  R.core = core;
  R.advance = ms => { const end = clock + ms; for (;;) { timers.sort((a, b) => a.at - b.at || a.id - b.id); const t = timers[0]; if (!t || t.at > end) break; timers.shift(); clock = t.at; t.fn(); } clock = end; };
  core.applyTrading({ enabled: true, accounts: ['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D'], maxQty: { NQ: 9 } });
  return R;
}
const order = (id, account, role, side, kind, price, qty, extra) => Object.assign({ type: 'order', id, account, root: 'NQ', role, side, kind, price, qty, filled: 0, state: 'working' }, extra || {});
/* a group MARKET entry: each account filled at its own price, its bracket (80 ticks stop, 160 target) from its own fill */
function filled(R, fills) {
  const list = [];
  fills.forEach(([a, qty, p], i) => {
    R.core.message({ type: 'position', account: a, root: 'NQ', qty, avgPrice: p });
    list.push(order('s' + i, a, 'stop', 'sell', 'stop', p - 20, qty), order('t' + i, a, 'target', 'sell', 'limit', p + 40, qty));
  });
  R.core.message({ type: 'orders', list });
}

test('1.43.0: two accounts 1 tick apart: one stop line and one target line; the quantity the sum, the label as today', () => {
  const R = rig();
  filled(R, [['SIM-A', 4, 25000], ['SIM-B', 2, 25000.25]]);
  const lines = R.core.chartOrders('group:g1', 'NQ');
  assert.equal(lines.length, 2, 'one stop line, one target line: ' + lines.map(l => l.id).join(' '));
  const stop = lines.find(l => l.role === 'stop'), tgt = lines.find(l => l.role === 'target');
  assert.equal(stop.qty, 6); assert.equal(stop.group, 'Lucid ×2', 'the label "STP 6 · Lucid ×2", as today');
  assert.equal(stop.price, 24980.25, 'the stop line at the stop nearest the entry (the higher, under a long)');
  assert.equal(tgt.price, 25040, 'the target line at the target nearest the entry (the lower, over a long)');
  assert.equal(stop.groupTip, 'Group Lucid: SELL STP 24980.00 to 24980.25, the line at 24980.25 (the nearest the entry)\nSIM-A SELL STP 4 @ 24980.00\nSIM-B SELL STP 2 @ 24980.25',
    'the range, then each account\'s order with its own price');
  assert.deepEqual(stop.parts, [{ price: 24980, qty: 4, from: 25000 }, { price: 24980.25, qty: 2, from: 25000.25 }], 'each member\'s own order and fill, for the risk label');
  assert.deepEqual(stop.members, ['s0', 's1']);
});

test('1.43.0: 2 ticks apart one line; 3 ticks apart two lines, each at its own price, as before', () => {
  const R = rig();
  filled(R, [['SIM-A', 1, 25000], ['SIM-B', 1, 25000.5]]);
  assert.equal(R.core.chartOrders('group:g1', 'NQ').filter(l => l.role === 'stop').length, 1, '2 ticks apart');
  R.core.message({ type: 'orders', list: [order('a', 'SIM-A', 'stop', 'sell', 'stop', 24980, 1), order('b', 'SIM-B', 'stop', 'sell', 'stop', 24980.75, 1)] });
  const two = R.core.chartOrders('group:g1', 'NQ');
  assert.equal(two.length, 2, '3 ticks apart');
  assert.deepEqual(two.map(l => [l.price, l.qty, l.group]), [[24980, 1, 'Lucid ×1'], [24980.75, 1, 'Lucid ×1']]);
  assert.ok(!/ to /.test(two[0].groupTip), 'one price: no range in the tooltip');
});

test('1.43.0: a chain of 1 tick gaps over 4 ticks gives at least two lines, none over 2 ticks', () => {
  const R = rig();
  R.core.message({ type: 'orders', list: [order('a', 'SIM-A', 'stop', 'sell', 'stop', 24980, 1), order('b', 'SIM-B', 'stop', 'sell', 'stop', 24980.25, 1), order('c', 'SIM-C', 'stop', 'sell', 'stop', 24980.5, 1),
    order('d', 'SIM-A', 'stop', 'sell', 'stop', 24980.75, 1), order('e', 'SIM-B', 'stop', 'sell', 'stop', 24981, 1)] });
  const lines = R.core.chartOrders('group:g1', 'NQ');
  assert.ok(lines.length >= 2, lines.length + ' lines');
  for (const l of lines) { const ps = l.parts.map(p => p.price); assert.ok(Math.max(...ps) - Math.min(...ps) <= 0.5 + 1e-9, l.id + ' spans ' + ps.join(', ')); }
  assert.equal(lines.reduce((n, l) => n + l.qty, 0), 5);
});

test('1.43.0: mixed sides, roles and kinds never merge, even a tick apart', () => {
  const R = rig();
  R.core.message({ type: 'orders', list: [
    order('a', 'SIM-A', 'stop', 'sell', 'stop', 24980, 1), order('b', 'SIM-B', 'stop', 'buy', 'stop', 24980.25, 1),           // sides
    order('c', 'SIM-C', 'target', 'sell', 'stop', 24980, 1),                                                                      // roles
    order('d', 'SIM-A', 'stop', 'sell', 'stopLimit', 24980.25, 1),                                                               // kinds
    order('e', 'SIM-B', 'target', 'sell', 'limit', 25040, 1), order('f', 'SIM-C', 'target', 'sell', 'limit', 25040.25, 1)] });   // these two merge
  const lines = R.core.chartOrders('group:g1', 'NQ');
  assert.equal(lines.length, 5, lines.map(l => l.id).join(' '));
  assert.deepEqual(lines.map(l => l.members.join('+')).sort(), ['a', 'b', 'c', 'd', 'e+f']);
});

test('1.43.0: a group\'s entries still merge only at one price', () => {
  const R = rig();
  R.core.message({ type: 'orders', list: [order('e1', 'SIM-A', 'entry', 'buy', 'limit', 24990, 1), order('e2', 'SIM-B', 'entry', 'buy', 'limit', 24990.25, 1)] });
  assert.equal(R.core.chartOrders('group:g1', 'NQ').length, 2);
});

test('1.43.0: a drag of a merged line sends one change per member, every one to the price dropped at; the x cancels each', () => {
  const R = rig();
  R.core.setArmed(true);
  filled(R, [['SIM-A', 4, 25000], ['SIM-B', 2, 25000.25], ['SIM-C', 1, 25000.5]]);
  const stop = R.core.chartOrders('group:g1', 'NQ').find(l => l.role === 'stop');
  assert.equal(stop.qty, 7); assert.equal(stop.group, 'Lucid ×3'); assert.equal(stop.price, 24980.5);
  assert.match(stop.groupTip, /^Group Lucid: SELL STP 24980\.00 to 24980\.50, the line at 24980\.50 \(the nearest the entry\)\nSIM-A SELL STP 4 @ 24980\.00\nSIM-B SELL STP 2 @ 24980\.25\nSIM-C SELL STP 1 @ 24980\.50$/);
  R.sent.length = 0;
  R.core.moveOrder(stop.id, 24985);
  assert.deepEqual(R.sent.map(m => [m.type, m.id, m.price]), [['change', 's0', 24985], ['change', 's1', 24985], ['change', 's2', 24985]], 'every member\'s stop to the one price');
  R.advance(2000);
  assert.equal(R.notes.pop(), 'Group stops to 24985.00: SIM-A, SIM-B, SIM-C moved.', 'each member\'s result on the ticket, as before');
  const moved = R.core.chartOrders('group:g1', 'NQ').find(l => l.role === 'stop');
  assert.equal(moved.movePending, 24985, 'drawn at the dropped price while the moves wait');
  assert.ok(moved.parts.every(p => p.price === 24985), 'every member at the dropped price for the risk label');
  R.sent.length = 0;
  R.core.cancelOrder(R.core.chartOrders('group:g1', 'NQ').find(l => l.role === 'target').id);
  assert.deepEqual(R.sent.map(m => m.type + ' ' + m.id), ['cancel t0', 'cancel t1', 'cancel t2'], 'the x cancels each member\'s order');
});

test('1.43.0: planned lines merge too: a drag sends `plan` to each member entry, to the one price', () => {
  const R = rig();
  R.core.setArmed(true);
  const entry = (id, a, stopTicks) => order(id, a, 'entry', 'buy', 'limit', 24990, 1, { planned: { stopTicks, targetTicks: null } });
  R.core.message({ type: 'orders', list: [entry('e1', 'SIM-A', 8), entry('e2', 'SIM-B', 9), entry('e3', 'SIM-C', 12)] });
  const lines = R.core.chartOrders('group:g1', 'NQ'), plans = lines.filter(l => l.plan);
  assert.equal(plans.length, 2, '8 and 9 ticks merge, 12 stays apart: ' + plans.map(l => l.id).join(' '));
  const m = plans.find(l => l.qty === 2);
  assert.equal(m.price, 24988, 'the planned stop nearest the entry');
  assert.equal(m.plan.offset, -8, 'drawn from the entry line at that offset');
  assert.deepEqual(m.parts, [{ price: 24988, qty: 1, from: 24990 }, { price: 24987.75, qty: 1, from: 24990 }]);
  assert.match(m.groupTip, /^Group Lucid: planned stops 24987\.75 to 24988\.00, the line at 24988\.00/);
  R.sent.length = 0;
  R.core.planMove(m.id, 24986, 24990);
  assert.deepEqual(R.sent.map(x => [x.type, x.id, x.stopTicks]), [['plan', 'e1', 16], ['plan', 'e2', 16]], 'each member entry, 16 ticks: the one price');
  R.sent.length = 0;
  R.core.planRemove(m.id);
  assert.deepEqual(R.sent.map(x => [x.id, x.stopTicks]), [['e1', null], ['e2', null]], 'its x removes each');
});

test('1.43.0: a single-account ticket is unchanged: its own orders, a tick apart, stay separate lines with no parts', () => {
  const R = rig();
  R.core.message({ type: 'orders', list: [order('a', 'SIM-A', 'stop', 'sell', 'stop', 24980, 1), order('b', 'SIM-A', 'stop', 'sell', 'stop', 24980.25, 1)] });
  const lines = R.core.chartOrders('SIM-A', 'NQ');
  assert.deepEqual(lines.map(l => l.id), ['a', 'b']);
  assert.ok(lines.every(l => l.parts === undefined && l.group === undefined));
});

/* ---------------- the risk label (src/chart-engine.js, on a stand-in canvas) */
const U = require('../src/chart-engine.js').util;
test('1.43.0: partsRisk: the sum of each member\'s own risk, its ticks that sum per contract (a half away from zero)', () => {
  const parts = [{ price: 24980, qty: 4, from: 25000 }, { price: 24980.25, qty: 2, from: 25000.25 }, { price: 24980.5, qty: 1, from: 25000.5 }];
  const r = U.partsRisk(parts, null, q => q.from, 1, 0.25);
  assert.deepEqual(r, { points: -140, ticks: -80, qty: 7 }, 'every member 80 ticks from its own fill: -140 points, $2,800 on NQ');
  const d = U.partsRisk(parts, 24985, q => q.from, 1, 0.25);
  assert.equal(d.points, (24985 - 25000) * 4 + (24985 - 25000.25) * 2 + (24985 - 25000.5) * 1, 'dragged: every member at the line\'s price');
  assert.equal(d.ticks, -61, '-60.57 ticks a contract: -61');
  assert.deepEqual(U.partsRisk([{ price: 99.5, qty: 1, from: 100 }, { price: 99.75, qty: 1, from: 100 }], null, q => q.from, 1, 0.25), { points: -0.75, ticks: -2, qty: 2 }, '-1.5 ticks rounds to -2, never shown smaller');
  assert.equal(U.partsRisk([{ price: 1, qty: 1 }], null, () => undefined, 1, 0.25), null, 'nothing to measure from: not known');
});

function stub(base, amp) {
  const ops = [];
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return s => ({ width: String(s).length * 7 });
      if (k === 'fillText') return s => ops.push({ op: 'text', s: String(s) });
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const made = [];
  const element = () => made[made.push({
    handlers: {}, style: {}, dataset: {}, hidden: false, textContent: '', tabIndex: -1,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, fn) { this.handlers[type] = fn; }, removeEventListener(type) { delete this.handlers[type]; },
    appendChild(c) { return c; }, remove() {}, setAttribute() {}, hasAttribute() { return false; },
    getContext: () => ctx, focus() {}, setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1078, height: 626, right: 1078, bottom: 626 }),
  }) - 1];
  let frameFn = null;
  global.document = { createElement: element, getElementById: () => null, head: { appendChild() {} } };
  global.window = { devicePixelRatio: 1 };
  global.requestAnimationFrame = fn => { frameFn = fn; return 1; };
  global.cancelAnimationFrame = () => { frameFn = null; };
  global.Path2D = class { rect() {} moveTo() {} lineTo() {} closePath() {} arc() {} };
  delete require.cache[require.resolve('../src/chart-engine.js')];
  const E = require('../src/chart-engine.js');
  const bars = [], T0 = Date.UTC(2026, 10, 3, 15, 0) / 1000;
  for (let i = 0; i < 200; i++) { const c = (base || 100) + Math.sin(i / 9) * (amp || 2); bars.push({ t: T0 + i * 60, o: c - 0.5, h: c + 1, l: c - 1, c, v: 100, vw: c }); }
  const host = element();
  const chart = E.create(host, { clock: () => bars[bars.length - 1].t + 30, compactLabels: true, motion: { zoom: 0, fit: 0, candle: 0, follow: 0 } });
  chart.setBars(bars);
  const cv = made.find(m => m.handlers.pointerdown);
  let ts = 1000;
  const ev = (x, y) => ({ clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', timeStamp: ts, shiftKey: false, ctrlKey: false, preventDefault() {} });
  const api = {
    chart, texts: () => ops.filter(o => o.op === 'text').map(o => o.s),
    frame(n) { ops.length = 0; for (let k = 0; k < (n || 1); k++) { const f = frameFn; frameFn = null; if (f) f(ts += 16); } },   // every frame's text (a frame with nothing new draws nothing)
    down: (x, y) => cv.handlers.pointerdown(ev(x, y)), move: (x, y) => cv.handlers.pointermove(ev(x, y)), up: (x, y) => cv.handlers.pointerup(ev(x, y)),
  };
  api.frame(30);
  return api;
}

test('1.43.0: a merged line\'s risk label: the sum of each member\'s own risk, live while dragged; a single account\'s as before', () => {
  const S = stub();
  /* MNQ ($2 a point): SIM-A 4 @ 100.00, SIM-B 2 @ 100.25, SIM-C 1 @ 100.50, each stop 4 ticks under its own fill; the group's
     position 7 at the weighted average 100.142857; the merged stop line at 99.50 (the nearest the entry) */
  S.chart.setPosition({ qty: 7, avgPrice: (400 + 200.5 + 100.5) / 7, group: 'Lucid ×3' }, { pointValue: 2 });
  const parts = [{ price: 99, qty: 4, from: 100 }, { price: 99.25, qty: 2, from: 100.25 }, { price: 99.5, qty: 1, from: 100.5 }];
  S.chart.setOrders([{ id: 'G~stop~sell~stop~398', side: 'sell', kind: 'stop', role: 'stop', price: 99.5, qty: 7, group: 'Lucid ×3', parts }]);
  S.chart.setOrderEditing(true);
  S.frame(3);
  assert.ok(S.texts().includes('STP 7 -4t -$14'), 'every member 4 ticks from its own fill: -4t, 7 points, -$14 (the average\'s figure at the line would be -3t -$9): ' + S.texts().filter(t => /STP/.test(t)).join('|'));
  /* dragged to 99.00: every member there: -4 - 2.5 - 1.5 = -8 points, -$16, -4.57 ticks a contract: -5t */
  const h = S.chart.orderHandles().find(x => x.id === 'G~stop~sell~stop~398');
  const x = h.box.x + 8, y = h.box.y + h.box.h / 2, dy = S.chart.priceToY(99) - S.chart.priceToY(99.5);
  S.down(x, y); S.move(x, y + dy / 2); S.move(x, y + dy); S.frame();
  assert.ok(S.texts().some(t => /-5t -\$16/.test(t)), 'live while dragged: ' + S.texts().filter(t => /STP/.test(t)).join('|'));
  S.up(x, y + dy); S.frame();
  /* one account: no parts, the 1.34.0 figure from the position's average */
  S.chart.setPosition({ qty: 2, avgPrice: 100 }, { pointValue: 2 });
  S.chart.setOrders([{ id: 'o1', side: 'sell', kind: 'stop', role: 'stop', price: 99, qty: 2 }]);
  S.frame(2);
  assert.ok(S.texts().includes('STP 2 -4t -$4'), 'a single account, as before (1 point, 2 contracts, $2 a point): ' + S.texts().filter(t => /STP/.test(t)).join('|'));
});

test('1.43.0: a merged planned line\'s label: each member\'s own distance and contracts', () => {
  const S = stub();
  S.chart.setPosition(null, { pointValue: 20 });
  const entry = { id: 'G~entry~buy~limit~400', side: 'buy', kind: 'limit', price: 100, qty: 2, group: 'Lucid ×2' };
  S.chart.setOrders([entry, { id: 'G~entry~buy~limit~400~at392:sl', side: 'sell', kind: 'stop', price: 98, qty: 2, group: 'Lucid ×2', plan: { role: 'stop', parent: entry.id, offset: -8 },
    parts: [{ price: 98, qty: 1, from: 100 }, { price: 97.75, qty: 1, from: 100 }] }]);
  S.chart.setOrderEditing(true);
  S.frame(3);
  assert.ok(S.texts().includes('SL -9t -$85'), 'NQ, 8 and 9 ticks, one contract each: 17 ticks, $85; 8.5 ticks a contract shown as 9 (never smaller): ' + S.texts().filter(t => /SL/.test(t)).join('|'));
});

/* ---------------- the review of 69eebe1 (B1): a merged line's id is sticky, so a drag in progress survives its members changing */
/* the chart wired to the ticket as the page wires it: the group's lines and position set on the engine, a drop sent to TradeCore */
function wired(R) {
  const S = stub(24981, 4), drops = [];
  S.chart.on('orderMove', e => { drops.push(e); R.core.moveOrder(e.id, e.price); });
  S.chart.setOrderEditing(true);
  const sync = () => { S.chart.setPosition(R.core.groupPosition('group:g1', 'NQ'), { pointValue: 20 }); S.chart.setOrders(R.core.chartOrders('group:g1', 'NQ')); S.frame(2); };
  const stopLines = () => R.core.chartOrders('group:g1', 'NQ').filter(l => l.role === 'stop');
  /* press the label of line `id`, move 20 px down; returns the drop (release 40 px down from the press) */
  const press = id => {
    const h = S.chart.orderHandles().find(x => x.id === id);
    assert.ok(h, 'line ' + id + ' drawn');
    const x = h.box.x + 8, y = h.box.y + h.box.h / 2;
    S.down(x, y); S.move(x, y + 10); S.move(x, y + 20); S.frame();
    return () => { S.move(x, y + 40); S.frame(); S.up(x, y + 40); S.frame(); };
  };
  return { S, drops, sync, stopLines, press };
}
const stopOf = (id, a, price, extra) => order(id, a, 'stop', 'sell', 'stop', price, 1, extra);

test('B1: the ids are stable across refreshes with no change, and when an unrelated order changes', () => {
  const R = rig();
  R.core.message({ type: 'position', account: 'SIM-A', root: 'NQ', qty: 2, avgPrice: 25000 });
  R.core.message({ type: 'orders', list: [stopOf('a', 'SIM-A', 24980), stopOf('b', 'SIM-B', 24980.25), stopOf('c', 'SIM-C', 24980.5), order('t', 'SIM-A', 'target', 'sell', 'limit', 25040, 1)] });
  const ids = () => R.core.chartOrders('group:g1', 'NQ').map(l => l.id).join(' ');
  const first = ids();
  assert.equal(first, 'G~stop~sell~stop~99922 G~target~sell~limit~100160', 'the first ids as before: the line price in ticks');
  for (let k = 0; k < 5; k++) assert.equal(ids(), first, 'refresh ' + k);
  R.core.message(order('t', 'SIM-A', 'target', 'sell', 'limit', 25050, 1));
  assert.equal(ids().split(' ')[0], 'G~stop~sell~stop~99922', 'the stop line keeps its id when the target moves');
});

test('B1: a drag survives the lead member\'s order going (its stop, nearest the entry, filled)', () => {
  const R = rig(); R.core.setArmed(true);
  R.core.message({ type: 'orders', list: [stopOf('a', 'SIM-A', 24980), stopOf('b', 'SIM-B', 24980.25), stopOf('c', 'SIM-C', 24980.5)] });
  const W = wired(R); W.sync();
  const id = W.stopLines()[0].id;
  const drop = W.press(id);
  R.core.message(order('c', 'SIM-C', 'stop', 'sell', 'stop', 24980.5, 1, { state: 'filled', filled: 1, avgFill: 24980 }));   // the lead goes mid drag
  W.sync();
  assert.deepEqual(W.stopLines().map(l => [l.id, l.members.join('+'), l.price]), [[id, 'a+b', 24980.25]], 'the line keeps its id, now at the next stop nearest the entry');
  R.sent.length = 0;
  drop();
  assert.equal(W.drops.length, 1, 'the drag was not dropped: the release sent the move');
  assert.equal(W.drops[0].id, id);
  assert.deepEqual(R.sent.map(m => [m.type, m.id]), [['change', 'a'], ['change', 'b']], 'one change per member still there');
  assert.equal(new Set(R.sent.map(m => m.price)).size, 1, 'every one to the price dropped at');
});

test('B1: a drag survives a cascade from a neighbouring cluster', () => {
  const R = rig(); R.core.setArmed(true);
  /* sell stops at 4, 3, 2, 1 and 0 ticks over 24980: lines [4,3,2] and [1,0]; when 4 goes the walk gives [3,2,1] and [0] */
  const px = k => 24980 + k * 0.25;
  R.core.message({ type: 'orders', list: [stopOf('k4', 'SIM-A', px(4)), stopOf('k3', 'SIM-B', px(3)), stopOf('k2', 'SIM-C', px(2)), stopOf('k1', 'SIM-A', px(1)), stopOf('k0', 'SIM-B', px(0))] });
  const W = wired(R); W.sync();
  const before = W.stopLines().map(l => [l.id, l.members.join('+')]);
  assert.deepEqual(before.map(x => x[1]), ['k4+k3+k2', 'k1+k0']);
  const [idHi, idLo] = before.map(x => x[0]);
  const drop = W.press(idLo);
  R.core.message(order('k4', 'SIM-A', 'stop', 'sell', 'stop', px(4), 1, { state: 'filled', filled: 1, avgFill: 24980 }));
  W.sync();
  assert.deepEqual(W.stopLines().map(l => [l.id, l.members.join('+')]), [[idHi, 'k1+k3+k2'], [idLo, 'k0']], 'each new cluster keeps the id its lead had: no line takes another\'s');
  R.sent.length = 0;
  drop();
  assert.equal(W.drops.length, 1, 'the drag was not dropped');
  assert.equal(W.drops[0].id, idLo);
  assert.deepEqual(R.sent.map(m => [m.type, m.id]), [['change', 'k0']], 'the line\'s member moved, to the price dropped at');
});

test('B1: a drag survives a late member arriving nearer the entry (a bracket placed just after the market entry)', () => {
  const R = rig(); R.core.setArmed(true);
  R.core.message({ type: 'orders', list: [stopOf('a', 'SIM-A', 24980), stopOf('b', 'SIM-B', 24980.25)] });
  const W = wired(R); W.sync();
  const id = W.stopLines()[0].id;
  const drop = W.press(id);
  R.core.message(stopOf('c', 'SIM-C', 24980.5));                // the late one, the new nearest the entry
  W.sync();
  assert.deepEqual(W.stopLines().map(l => [l.id, l.members.join('+'), l.price]), [[id, 'a+b+c', 24980.5]], 'most of its members had this id: kept');
  R.sent.length = 0;
  drop();
  assert.equal(W.drops.length, 1, 'the drag was not dropped');
  assert.deepEqual(R.sent.map(m => [m.type, m.id]), [['change', 'a'], ['change', 'b'], ['change', 'c']]);
});

test('B1: no two lines share an id, and a line that went never hands its id to a new one', () => {
  const R = rig();
  R.core.message({ type: 'orders', list: [stopOf('a', 'SIM-A', 24980), stopOf('b', 'SIM-B', 24981)] });
  const [la, lb] = R.core.chartOrders('group:g1', 'NQ');
  R.core.message(order('a', 'SIM-A', 'stop', 'sell', 'stop', 24980, 1, { state: 'filled', filled: 1, avgFill: 24980 }));
  R.core.chartOrders('group:g1', 'NQ');
  R.core.message(stopOf('d', 'SIM-C', 24980));                   // a new stop where the gone line was
  const now2 = R.core.chartOrders('group:g1', 'NQ');
  assert.equal(new Set(now2.map(l => l.id)).size, now2.length);
  assert.ok(now2.some(l => l.id === lb.id), 'b\'s line keeps its id');
  const nd = now2.find(l => l.members.includes('d'));
  assert.notEqual(nd.id, la.id, 'the new line has a new id, not the gone line\'s: ' + nd.id);
  assert.match(nd.id, /^G~stop~sell~stop~99920\.\d+$/);
});

test('B1 (low): while a group move waits, its members stay one line at the price asked for; a refused one leaves it', () => {
  const R = rig(); R.core.setArmed(true);
  R.core.message({ type: 'orders', list: [stopOf('a', 'SIM-A', 24980), stopOf('b', 'SIM-B', 24980.25), stopOf('c', 'SIM-C', 24980.5)] });
  const id = R.core.chartOrders('group:g1', 'NQ')[0].id;
  R.sent.length = 0;
  R.core.moveOrder(id, 24990);
  const cids = Object.fromEntries(R.sent.map(m => [m.id, m.cid]));
  R.core.message(order('a', 'SIM-A', 'stop', 'sell', 'stop', 24990, 1));   // a's answer first, b and c still waiting
  let ls = R.core.chartOrders('group:g1', 'NQ');
  assert.deepEqual(ls.map(l => [l.id, l.members.join('+'), l.price, l.movePending]), [[id, 'a+b+c', 24990, 24990]], 'one line, its id, at the price asked for: no second line');
  assert.ok(ls[0].parts.every(p => p.price === 24990));
  R.core.message({ type: 'reject', cid: cids.c, id: 'c', reason: 'sample: refused' });
  ls = R.core.chartOrders('group:g1', 'NQ');
  assert.deepEqual(ls.map(l => [l.id, l.members.join('+')]), [[id, 'a+b'], ['G~stop~sell~stop~99922.2', 'c']], 'the refused one is drawn where it is, its own line (a new id)');
  R.core.message(order('b', 'SIM-B', 'stop', 'sell', 'stop', 24990, 1));
  ls = R.core.chartOrders('group:g1', 'NQ');
  assert.deepEqual(ls.map(l => [l.id, l.members.join('+'), l.price, l.movePending]), [[id, 'a+b', 24990, undefined], ['G~stop~sell~stop~99922.2', 'c', 24980.5, undefined]], 'all answered: as drawn, the line keeps its id');
});

test('B1: an action forwarded from another window finds the line by the members it drew there', () => {
  const R = rig(); R.core.setArmed(true);
  R.core.message({ type: 'orders', list: [stopOf('a', 'SIM-A', 24980), stopOf('b', 'SIM-B', 24980.25)] });
  R.core.chartOrders('group:g1', 'NQ');
  R.sent.length = 0;
  R.core.moveOrder('G~stop~sell~stop~99999', 24985, ['a', 'b']);   // the other window's id for the line
  assert.deepEqual(R.sent.map(m => [m.type, m.id, m.price]), [['change', 'a', 24985], ['change', 'b', 24985]]);
  R.advance(3000); R.sent.length = 0;
  R.core.moveOrder('G~stop~sell~stop~99999', 24985);
  assert.deepEqual(R.sent, [], 'no members named: not found, as before');
  assert.match(R.notes.pop(), /that group line is no longer there/);
});

/* ---------------- the re-review of f2e06eb (F1): a forwarded action's members are authoritative, never its id */
const stopIds = (R) => R.core.chartOrders('group:g1', 'NQ').filter(l => l.role === 'stop').map(l => [l.id, l.members.join('+')]);

test('F1: the two-window case: the x and a drag forwarded from W2 act on SIM-C\'s stop only, never on W1\'s line of that id', () => {
  const W1 = rig(); W1.core.setArmed(true);
  /* 1. SIM-A's stop at 25000.00 and SIM-B's at 24999.75: one line in W1 */
  W1.core.message({ type: 'orders', list: [stopOf('a', 'SIM-A', 25000), stopOf('b', 'SIM-B', 24999.75)] });
  assert.deepEqual(stopIds(W1), [['G~stop~sell~stop~100000', 'a+b']]);
  /* 2. dragged to 24998.75 in W1: the line keeps its id there */
  W1.core.moveOrder('G~stop~sell~stop~100000', 24998.75);
  W1.core.message(stopOf('a', 'SIM-A', 24998.75)); W1.core.message(stopOf('b', 'SIM-B', 24998.75));
  W1.advance(2000);
  assert.deepEqual(stopIds(W1), [['G~stop~sell~stop~100000', 'a+b']]);
  /* 3. W2 opens: the same line there is ...99995 */
  const W2 = rig();
  W2.core.message({ type: 'orders', list: [stopOf('a', 'SIM-A', 24998.75), stopOf('b', 'SIM-B', 24998.75)] });
  assert.deepEqual(stopIds(W2), [['G~stop~sell~stop~99995', 'a+b']]);
  /* 4. SIM-C's stop arrives at 25000.00: W1 names it ...100000.2, W2 ...100000 */
  for (const R of [W1, W2]) R.core.message(stopOf('c', 'SIM-C', 25000));
  assert.deepEqual(stopIds(W1), [['G~stop~sell~stop~100000', 'a+b'], ['G~stop~sell~stop~100000.2', 'c']]);
  assert.deepEqual(stopIds(W2), [['G~stop~sell~stop~99995', 'a+b'], ['G~stop~sell~stop~100000', 'c']]);
  /* 5. the x on SIM-C's line in W2, forwarded with the members W2 drew on it */
  const w2c = W2.core.chartOrders('group:g1', 'NQ').find(l => l.id === 'G~stop~sell~stop~100000');
  W1.sent.length = 0;
  W1.core.cancelOrder(w2c.id, w2c.members);
  assert.deepEqual(W1.sent.map(m => m.type + ' ' + m.id), ['cancel c'], 'SIM-C\'s stop only, never A\'s and B\'s');
  /* and a drag forwarded from W2 moves SIM-C's stop only */
  W1.sent.length = 0;
  W1.core.moveOrder(w2c.id, 25001, w2c.members);
  assert.deepEqual(W1.sent.map(m => [m.type, m.id, m.price]), [['change', 'c', 25001]]);
  /* the ticket's own window still goes by its id */
  W1.advance(3000); W1.sent.length = 0;
  W1.core.cancelOrder('G~stop~sell~stop~100000');
  assert.deepEqual(W1.sent.map(m => m.type + ' ' + m.id), ['cancel a', 'cancel b'], 'no members: W1\'s own line of that id');
});

test('F1: forwarded members that left the line are still acted on as that window drew them, if they still qualify', () => {
  const R = rig(); R.core.setArmed(true);
  R.core.message({ type: 'orders', list: [stopOf('a', 'SIM-A', 24980), stopOf('b', 'SIM-B', 24980.25), stopOf('c', 'SIM-C', 24980.5)] });
  R.core.chartOrders('group:g1', 'NQ');
  R.core.message(stopOf('b', 'SIM-B', 24990));                   // b moved elsewhere since the other window drew [a, b, c]
  R.core.message(order('c', 'SIM-C', 'stop', 'sell', 'stop', 24980.5, 1, { state: 'filled', filled: 1, avgFill: 24980.5 }));   // c filled
  assert.equal(R.core.chartOrders('group:g1', 'NQ').filter(l => l.role === 'stop').length, 2, 'a and b on two lines here now');
  R.sent.length = 0;
  R.core.cancelOrder('G~stop~sell~stop~99999', ['a', 'b', 'c']);
  assert.deepEqual(R.sent.map(m => m.type + ' ' + m.id), ['cancel a', 'cancel b'], 'a and b as the other window drew them; c no longer working');
  R.sent.length = 0;
  R.core.moveOrder('G~stop~sell~stop~99999', 24985, ['a', 'b', 'c']);
  assert.deepEqual(R.sent.map(m => [m.id, m.price]), [['a', 24985], ['b', 24985]]);
});

test('F1: forwarded members of another account, group, instrument or kind (role, side, kind, planned) are dropped; none left: nothing sent, the ticket says why', () => {
  const R = rig(); R.core.setArmed(true);
  R.core.message({ type: 'orders', list: [stopOf('a', 'SIM-A', 24980), stopOf('d', 'SIM-D', 24980),                    // SIM-D: no member
    Object.assign(stopOf('m', 'SIM-B', 24980), { root: 'MNQ' }),                                                          // another instrument
    order('e1', 'SIM-C', 'entry', 'buy', 'limit', 24990, 1, { planned: { stopTicks: 8, targetTicks: null } })] });
  R.sent.length = 0;
  R.core.cancelOrder('G~stop~sell~stop~99920', ['a', 'd', 'm', 'e1:sl', 'nope']);
  assert.deepEqual(R.sent.map(m => m.type + ' ' + m.id), ['cancel a'], 'only the group\'s working NQ leg');
  R.sent.length = 0;
  R.core.cancelOrder('G~stop~sell~stop~99920', ['d', 'm', 'e1:sl', 'e1']);
  assert.deepEqual(R.sent, [], 'none qualifies (the entry e1 is not a sell stop): nothing sent, never the line of that id here');
  assert.equal(R.notes.pop(), 'warn: Not sent: none of the orders that line showed in the other window is still a working order of group Lucid on NQ.');
  R.sent.length = 0;
  R.core.planRemove('G~entry~buy~limit~99960~at99952:sl', ['a']);   // a leg named for a planned line: another kind
  assert.deepEqual(R.sent, []);
  assert.match(R.notes.pop(), /none of the orders that line showed/);
  R.core.planRemove('G~entry~buy~limit~99960~at99952:sl', ['e1:sl']);
  assert.deepEqual(R.sent.map(m => [m.type, m.id, m.stopTicks]), [['plan', 'e1', null]], 'a planned line\'s own member');
  R.sent.length = 0;
  R.core.cancelOrder('G~stop~sell~stop~99920', []);
  assert.deepEqual(R.sent, [], 'an empty list (the other window no longer had that line): nothing');
});

test('F1: a single-account ticket ignores members', () => {
  const R = rig();
  R.core.message({ type: 'orders', list: [stopOf('a', 'SIM-A', 24980), stopOf('b', 'SIM-A', 24980.25)] });
  R.core.pickAccount('SIM-A'); R.core.setArmed(true);
  R.sent.length = 0;
  R.core.moveOrder('a', 24985, ['b']);
  assert.deepEqual(R.sent.map(m => [m.type, m.id, m.price]), [['change', 'a', 24985]]);
  R.sent.length = 0;
  R.core.cancelOrder('b', ['a']);
  assert.deepEqual(R.sent.map(m => m.type + ' ' + m.id), ['cancel b']);
});

test('F1 (low): members refused before they are sent (Armed off) leave the move\'s line at once', () => {
  const R = rig(); R.core.setArmed(true);
  const list = [];
  for (let k = 0; k < 12; k++) list.push(stopOf('s' + k, ['SIM-A', 'SIM-B', 'SIM-C'][k % 3], 24980 + (k % 2) * 0.25));
  R.core.message({ type: 'orders', list });
  const id = R.core.chartOrders('group:g1', 'NQ')[0].id;
  R.sent.length = 0;
  R.core.moveOrder(id, 24990);
  assert.equal(R.sent.length, 10, '10 a second: two wait');
  let ls = R.core.chartOrders('group:g1', 'NQ');
  assert.deepEqual(ls.map(l => [l.members.length, l.movePending]), [[12, 24990]], 'all 12 at the price asked for while they wait');
  R.core.setArmed(false);
  R.advance(1200);
  ls = R.core.chartOrders('group:g1', 'NQ');
  const held = ls.find(l => l.id === id), left = ls.find(l => l.id !== id);
  assert.equal(held.members.length, 10); assert.equal(held.movePending, 24990);
  const sentIds = new Set(R.sent.filter(m => m.type === 'change').map(m => m.id));
  assert.deepEqual(left.members.slice().sort(), list.map(o => o.id).filter(x => !sentIds.has(x)).sort(), 'the two never sent are drawn where they are');
  assert.equal(left.movePending, undefined);
  assert.ok(left.parts.every(p => p.price !== 24990));
});
