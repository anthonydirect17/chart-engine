'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const OT = require('../live/order-ticket.js');

test('placeKind: better than the market is a limit, worse is a stop', () => {
  assert.equal(OT.placeKind('buy', 25390, 25400), 'limit');
  assert.equal(OT.placeKind('buy', 25410, 25400), 'stop');
  assert.equal(OT.placeKind('buy', 25400, 25400), 'limit');
  assert.equal(OT.placeKind('sell', 25410, 25400), 'limit');
  assert.equal(OT.placeKind('sell', 25390, 25400), 'stop');
  assert.equal(OT.placeKind('sell', 25400, 25400), 'limit');
  assert.equal(OT.placeKind('buy', 25410, null), 'limit');
});

test('maxQtyFor and checkQty', () => {
  const t = { maxQty: { '*': 1, MNQ: 5 } };
  assert.equal(OT.maxQtyFor(t, 'MNQ'), 5);
  assert.equal(OT.maxQtyFor(t, 'ES'), 1);
  assert.equal(OT.maxQtyFor({}, 'ES'), 1);
  assert.equal(OT.maxQtyFor({ maxQty: { '*': 3 } }, 'NQ'), 3);
  assert.equal(OT.checkQty(5, 5, 'MNQ'), null);
  assert.equal(OT.checkQty(9, 5, 'MNQ'), 'Qty 9 is over the MNQ cap of 5.');
  assert.match(OT.checkQty(0, 5), /at least 1/);
  assert.match(OT.checkQty(1.5, 5), /whole number/);
  assert.match(OT.checkQty(NaN, 5), /whole number/);
});

test('cleanBracket keeps whole ticks from 0 to 200', () => {
  assert.deepEqual(OT.cleanBracket({ stop: '40', target: 80.4 }), { stop: 40, target: 80 });
  assert.deepEqual(OT.cleanBracket({ stop: -3, target: 999 }), { stop: 0, target: 200 });
  assert.deepEqual(OT.cleanBracket(null), { stop: 0, target: 0 });
  assert.deepEqual(OT.cleanBracket({ stop: 'x' }), { stop: 0, target: 0 });
});

test('defaultAccount prefers the current choice, then Sim101, then the first allowed', () => {
  assert.equal(OT.defaultAccount(['DEMO-EVAL', 'Sim101'], 'DEMO-EVAL'), 'DEMO-EVAL');
  assert.equal(OT.defaultAccount(['DEMO-EVAL', 'Sim101'], 'GONE'), 'Sim101');
  assert.equal(OT.defaultAccount(['DEMO-EVAL'], ''), 'DEMO-EVAL');
  assert.equal(OT.defaultAccount([], ''), '');
});

test('cancelAllIds: working orders for the account and root, one per OCO pair', () => {
  const orders = [
    { id: 'a', state: 'working', account: 'Sim101', root: 'MNQ', oco: null },
    { id: 'b', state: 'working', account: 'Sim101', root: 'MNQ', oco: 'O1' },
    { id: 'c', state: 'working', account: 'Sim101', root: 'MNQ', oco: 'O1' },
    { id: 'd', state: 'partFilled', account: 'Sim101', root: 'MNQ', oco: null },
    { id: 'e', state: 'filled', account: 'Sim101', root: 'MNQ', oco: null },
    { id: 'f', state: 'working', account: 'DEMO-EVAL', root: 'MNQ', oco: null },
    { id: 'g', state: 'working', account: 'Sim101', root: 'ES', oco: null },
  ];
  assert.deepEqual([...OT.cancelAllIds(orders, 'Sim101', 'MNQ', 0)], ['a', 'b', 'd']);
});

test('cancelAllIds: with a position open, orders on the closing side are kept (the stop and target)', () => {
  const orders = [
    { id: 'entry', state: 'working', account: 'Sim101', root: 'MNQ', side: 'buy', oco: null },
    { id: 'stop', state: 'working', account: 'Sim101', root: 'MNQ', side: 'sell', role: 'stop', oco: 'O1' },
    { id: 'target', state: 'working', account: 'Sim101', root: 'MNQ', side: 'sell', role: 'target', oco: 'O1' },
    { id: 'ntStop', state: 'working', account: 'Sim101', root: 'MNQ', side: 'sell', role: 'other', oco: null },
  ];
  const long = OT.cancelAllIds(orders, 'Sim101', 'MNQ', 2);
  assert.deepEqual([...long], ['entry']);
  assert.equal(long.kept, 3);
  const short = OT.cancelAllIds(orders, 'Sim101', 'MNQ', -1);
  assert.deepEqual([...short], ['stop', 'ntStop']);
  assert.equal(short.kept, 1);
  assert.deepEqual([...OT.cancelAllIds(orders, 'Sim101', 'MNQ', 0)], ['entry', 'stop', 'ntStop']);
});

test('orderEvent: one line per change worth showing', () => {
  const f = p => p.toFixed(2);
  const base = { id: '1', account: 'Sim101', root: 'MNQ', name: 'MNQ 12-26', side: 'buy', kind: 'limit', qty: 2, filled: 0, price: 25400, avgFill: null, state: 'working', role: 'entry' };
  assert.deepEqual(OT.orderEvent(base, null, f), { text: 'Working BUY LMT 2 @ 25400.00 · Sim101', level: 'info' });
  assert.equal(OT.orderEvent(base, base, f), null);
  assert.match(OT.orderEvent(Object.assign({}, base, { price: 25401 }), base, f).text, /^Moved BUY LMT 2 @ 25401.00/);
  assert.match(OT.orderEvent(Object.assign({}, base, { state: 'partFilled', filled: 1, avgFill: 25400 }), base, f).text, /^Part filled BUY 1 of 2 @ 25400.00/);
  assert.equal(OT.orderEvent(Object.assign({}, base, { state: 'filled', filled: 2, avgFill: 25400 }), base, f).text, 'Filled BUY 2 MNQ 12-26 @ 25400.00 · Sim101');
  assert.match(OT.orderEvent(Object.assign({}, base, { state: 'cancelled' }), base, f).text, /^Cancelled BUY LMT 2/);
  assert.deepEqual(OT.orderEvent(Object.assign({}, base, { state: 'rejected', text: 'NinjaTrader rejected it (Order exceeds max position)' }), base, f), { text: 'Rejected: BUY LMT 2 @ 25400.00: NinjaTrader rejected it (Order exceeds max position) · Sim101', level: 'error' });
  assert.match(OT.orderEvent(Object.assign({}, base, { role: 'target', side: 'sell' }), null, f).text, /^Working SELL TGT 2/);
});

test('bracketAllowed: flat, or the same side as the position', () => {
  assert.equal(OT.bracketAllowed('buy', 0), true);
  assert.equal(OT.bracketAllowed('sell', undefined), true);
  assert.equal(OT.bracketAllowed('buy', 2), true);
  assert.equal(OT.bracketAllowed('sell', 2), false);
  assert.equal(OT.bracketAllowed('buy', -1), false);
  assert.equal(OT.bracketAllowed('sell', -1), true);
});

test('repeatGuard ignores the same action within the window only', () => {
  const g = OT.repeatGuard(400);
  assert.equal(g('buy', 1000), true);
  assert.equal(g('buy', 1200), false);
  assert.equal(g('sell', 1300), true);
  assert.equal(g('sell', 1800), true);
});
