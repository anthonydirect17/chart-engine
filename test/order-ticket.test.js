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

test('legSummary: a 2-lot filled in two pieces has two stop and target pairs that cover 2 of 2', () => {
  const leg = (id, role, kind, qty, extra) => Object.assign({ id, account: 'Sim101', root: 'MNQ', side: 'sell', role, kind, qty, filled: 0, state: 'working', oco: 'O' + id.slice(-1) }, extra);
  const orders = [leg('s1', 'stop', 'stop', 1), leg('t1', 'target', 'limit', 1), leg('s2', 'stop', 'stop', 1), leg('t2', 'target', 'limit', 1)];
  const r = OT.legSummary(orders, 'Sim101', 'MNQ', 2);
  assert.equal(r.text, 'stops cover 2 of 2, targets cover 2 of 2');
  assert.deepEqual([r.stopLegs, r.targetLegs, r.stopsShort], [2, 2, false]);
  // one pair gone: stops short of the position
  const short = OT.legSummary(orders.slice(0, 2), 'Sim101', 'MNQ', 2);
  assert.equal(short.text, 'stops cover 1 of 2, targets cover 1 of 2');
  assert.equal(short.stopsShort, true);
  // a stop part filled counts only what is left; other accounts, roots, sides and finished orders do not count
  const mixed = [
    leg('s1', 'stop', 'stop', 3, { filled: 1, state: 'partFilled' }),
    leg('s2', 'stop', 'stop', 5, { account: 'DEMO-EVAL' }),
    leg('s3', 'stop', 'stop', 5, { root: 'ES' }),
    leg('s4', 'stop', 'stop', 5, { side: 'buy' }),
    leg('s5', 'stop', 'stop', 5, { state: 'filled' }),
    leg('s6', 'other', 'stop', 1),                    // a stop placed in NinjaTrader
    leg('t1', 'other', 'limit', 2),                   // a limit placed in NinjaTrader acts as a target
    leg('m1', 'other', 'market', 2),                  // a market order is neither
  ];
  const m = OT.legSummary(mixed, 'Sim101', 'MNQ', 3);
  assert.equal(m.text, 'stops cover 3 of 3, targets cover 2 of 3');
  assert.equal(m.stopsShort, false);
  // short position: the buys protect it
  const sh = OT.legSummary([leg('b1', 'stop', 'stop', 1, { side: 'buy' })], 'Sim101', 'MNQ', -2);
  assert.equal(sh.text, 'stops cover 1 of 2, targets cover 0 of 2');
  assert.equal(sh.stopsShort, true);
  assert.equal(OT.legSummary(orders, 'Sim101', 'MNQ', 0), null);
});

test('legSummary: more stops or targets than the position is a warning (a fill would reverse it)', () => {
  const leg = (id, role, kind, qty, extra) => Object.assign({ id, account: 'Sim101', root: 'MNQ', side: 'sell', role, kind, qty, filled: 0, state: 'working' }, extra);
  // long 2 with two pairs, then 1 closed by hand: long 1 with 2 stops and 2 targets working
  const two = [leg('s1', 'stop', 'stop', 1), leg('t1', 'target', 'limit', 1), leg('s2', 'stop', 'stop', 1), leg('t2', 'target', 'limit', 1)];
  const over = OT.legSummary(two, 'Sim101', 'MNQ', 1);
  assert.equal(over.level, 'warn');
  assert.deepEqual([over.stopsOver, over.targetsOver, over.stopsShort], [true, true, false]);
  assert.equal(over.text, 'stops cover 2 of 1, targets cover 2 of 1 · stops 1, targets 1 over the position: a fill would reverse it');
  // stops exactly right, one target too many
  const t = OT.legSummary([leg('s1', 'stop', 'stop', 2), leg('t1', 'target', 'limit', 3)], 'Sim101', 'MNQ', 2);
  assert.equal(t.level, 'warn');
  assert.equal(t.text, 'stops cover 2 of 2, targets cover 3 of 2 · targets 1 over the position: a fill would reverse it');
  // short of the position is the error, and wins over a target that is over
  const s = OT.legSummary([leg('s1', 'stop', 'stop', 1), leg('t1', 'target', 'limit', 3)], 'Sim101', 'MNQ', 2);
  assert.equal(s.level, 'error');
  // covered exactly: no level, no note
  const ok = OT.legSummary([leg('s1', 'stop', 'stop', 2), leg('t1', 'target', 'limit', 2)], 'Sim101', 'MNQ', 2);
  assert.equal(ok.level, '');
  assert.equal(ok.text, 'stops cover 2 of 2, targets cover 2 of 2');
});

test('legSummary: MIT, LIT and other kinds are not counted, and the summary says so', () => {
  const leg = (id, kind, qty) => ({ id, account: 'Sim101', root: 'MNQ', side: 'sell', role: 'other', kind, qty, filled: 0, state: 'working' });
  const r = OT.legSummary([leg('s', 'stop', 1), leg('mit', 'other', 1), leg('lit', 'other', 1), leg('m', 'market', 1)], 'Sim101', 'MNQ', 1);
  assert.equal(r.notCounted, 2);
  assert.equal(r.stops, 1);
  assert.equal(r.targets, 0);
  assert.equal(r.text, 'stops cover 1 of 1, targets cover 0 of 1 · 2 other orders (MIT, LIT) not counted');
});

test('openEntryFills (1.6.0): the fills of the trade still open, so hiding Fills never hides the live trade', () => {
  const f = (t, side, qty) => ({ t, side, qty, price: 100 + t });
  const ids = list => list.map(x => x.t);
  assert.deepEqual(ids(OT.openEntryFills([])), []);
  assert.deepEqual(ids(OT.openEntryFills([f(1, 'buy', 2)])), [1]);
  assert.deepEqual(ids(OT.openEntryFills([f(1, 'buy', 2), f(2, 'sell', 2)])), [], 'flat: nothing open');
  assert.deepEqual(ids(OT.openEntryFills([f(1, 'buy', 2), f(2, 'sell', 2), f(3, 'sell', 1), f(4, 'sell', 1)])), [3, 4], 'the next trade only');
  assert.deepEqual(ids(OT.openEntryFills([f(1, 'buy', 1), f(2, 'buy', 1), f(3, 'sell', 1)])), [1, 2], 'scaled out: the entries stay');
  assert.deepEqual(ids(OT.openEntryFills([f(1, 'buy', 1), f(2, 'sell', 3)])), [2], 'turned over: the reversing fill opens the new trade');
  assert.deepEqual(ids(OT.openEntryFills([f(2, 'sell', 2), f(1, 'buy', 2)])), [], 'sorted by time first');
  // the position ChartBridge reports is the check
  assert.deepEqual(ids(OT.openEntryFills([f(1, 'buy', 2)], 2)), [1]);
  assert.deepEqual(ids(OT.openEntryFills([f(1, 'buy', 2)], 0)), [], 'reported flat');
  assert.deepEqual(ids(OT.openEntryFills([f(1, 'buy', 2)], -1)), [], 'the other side: fills missing, show none');
  assert.deepEqual(ids(OT.openEntryFills([f(1, 'buy', 0), { t: 2, side: 'x', qty: 1 }, null])), []);
});

/* ---------------- 1.10.0 order bar essentials */
test('breakEvenPrice: the average on the tick grid, rounded toward safety', () => {
  assert.equal(OT.breakEvenPrice(21000.25, 1, 0.25), 21000.25);      // on the grid: kept, long
  assert.equal(OT.breakEvenPrice(21000.25, -2, 0.25), 21000.25);     // and short
  assert.equal(OT.breakEvenPrice(21000.125, 2, 0.25), 21000.25);     // long: up to the next tick
  assert.equal(OT.breakEvenPrice(21000.125, -2, 0.25), 21000);       // short: down
  assert.equal(OT.breakEvenPrice(21000.01, 1, 0.25), 21000.25);
  assert.equal(OT.breakEvenPrice(21000.24, -1, 0.25), 21000);
  assert.equal(OT.breakEvenPrice(5432.1 + 0.15, 1, 0.25), 5432.25);  // float noise near the grid does not jump a tick
  assert.equal(OT.breakEvenPrice(21000.250000001, 1, 0.25), 21000.25);
  assert.equal(OT.breakEvenPrice(21000.1, 0, 0.25), null);           // flat
  assert.equal(OT.breakEvenPrice(null, 1, 0.25), null);
  assert.equal(OT.breakEvenPrice(0, 1, 0.25), null);
  assert.equal(OT.breakEvenPrice(21000, 1, 0), null);
});

test('breakEvenLegs: ChartBridge stop legs on the closing side only; NinjaTrader stops counted, never moved', () => {
  const o = (id, x) => Object.assign({ id, account: 'Sim101', root: 'MNQ', state: 'working', side: 'sell', kind: 'stop', role: 'stop', price: 20990 }, x);
  const orders = [
    o('s1'), o('s2', { state: 'partFilled', price: 20995 }),
    o('t1', { role: 'target', kind: 'limit', price: 21020 }),            // a target: never
    o('n1', { role: 'other' }), o('n2', { role: 'other', kind: 'stopLimit' }), o('n3', { role: 'other', kind: 'limit', price: 21030 }),
    o('b1', { side: 'buy' }),                                             // the opening side: never
    o('e1', { account: 'DEMO-EVAL' }), o('r1', { root: 'NQ' }),          // another account or root: never
    o('x1', { state: 'cancelled' }), o('x2', { state: 'filled' }),       // not working: never
    o('a1', { price: 21000.25 }), o('a2', { price: 21001 }),             // already at break-even or past it: left
  ];
  assert.deepEqual(OT.breakEvenLegs(orders, 'Sim101', 'MNQ', 2, 21000.25), { ids: ['s1', 's2'], done: 2, other: 2 });
  assert.deepEqual(OT.breakEvenLegs(orders, 'Sim101', 'MNQ', 2, null), { ids: ['s1', 's2', 'a1', 'a2'], done: 0, other: 2 });
  assert.deepEqual(OT.breakEvenLegs(orders, 'Sim101', 'MNQ', 0, 21000), { ids: [], done: 0, other: 0 });
  // short: the buy stops close it; one already at or under break-even is left
  const short = [o('s1', { side: 'buy', price: 21010 }), o('s2', { side: 'buy', price: 20999.75 }), o('s3', { side: 'buy', price: 21000 }), o('n1', { side: 'buy', role: 'other' }), o('k1')];
  assert.deepEqual(OT.breakEvenLegs(short, 'Sim101', 'MNQ', -1, 21000), { ids: ['s1'], done: 2, other: 1 });
});

test('breakEvenAllowed: only with the last price past break-even on the profitable side', () => {
  assert.equal(OT.breakEvenAllowed(1, 21000.25, 21001), true);
  assert.equal(OT.breakEvenAllowed(1, 21000.25, 21000.25), false);   // at it: not past
  assert.equal(OT.breakEvenAllowed(1, 21000.25, 20999), false);
  assert.equal(OT.breakEvenAllowed(-1, 21000, 20999.75), true);
  assert.equal(OT.breakEvenAllowed(-1, 21000, 21000), false);
  assert.equal(OT.breakEvenAllowed(-1, 21000, 21001), false);
  assert.equal(OT.breakEvenAllowed(1, 21000, null), false);          // no price: nothing
  assert.equal(OT.breakEvenAllowed(1, null, 21001), false);
  assert.equal(OT.breakEvenAllowed(0, 21000, 21001), false);
});

test('bracket ratios: target = round(stop x ratio), capped like any bracket', () => {
  assert.deepEqual(OT.BRACKET_RATIOS.map(r => r.id), ['1:1', '1:1.5', '1:2']);
  assert.equal(OT.ratioOf('1:1.5'), 1.5);
  assert.equal(OT.ratioOf('custom'), null);
  assert.equal(OT.ratioOf('p:12/24t'), null);
  assert.deepEqual(OT.ratioBracket(12, 1), { stop: 12, target: 12 });
  assert.deepEqual(OT.ratioBracket(15, 1.5), { stop: 15, target: 23 });   // 22.5 rounds up
  assert.deepEqual(OT.ratioBracket(13, 1.5), { stop: 13, target: 20 });   // 19.5 rounds up
  assert.deepEqual(OT.ratioBracket(12, 2), { stop: 12, target: 24 });
  assert.deepEqual(OT.ratioBracket(0, 2), { stop: 0, target: 0 });
  assert.deepEqual(OT.ratioBracket(120, 2), { stop: 120, target: 200 });  // the 200-tick cap, as cleanBracket
  assert.deepEqual(OT.ratioBracket('40', 2), { stop: 40, target: 80 });
  assert.deepEqual(OT.ratioBracket(300, 1), { stop: 200, target: 200 });
});

test('cleanBracketPresets: bad shapes dropped, names 1 to 24, at most 12, never throws', () => {
  assert.deepEqual(OT.cleanBracketPresets(null), []);
  assert.deepEqual(OT.cleanBracketPresets({ name: 'x', stop: 1, target: 2 }), []);
  assert.deepEqual(OT.cleanBracketPresets('[]'), []);
  const list = OT.cleanBracketPresets([
    { name: '12/24t', stop: 12, target: 24 },
    null, 5, 'x', [1, 2], {},
    { name: '', stop: 1, target: 2 }, { name: '   ', stop: 1, target: 2 }, { name: 7, stop: 1, target: 2 },
    { name: 'str', stop: '12', target: 24 }, { name: 'nan', stop: NaN, target: 24 }, { name: 'inf', stop: 8, target: Infinity }, { name: 'none', stop: 8 },
    { name: '12/24T', stop: 1, target: 1 },                               // the same name in another case: kept once
    { name: '  wide   gap  ', stop: 8.6, target: 400 },                   // ticks rounded and capped
    { name: 'x'.repeat(30), stop: 4, target: 8 },                         // cut to 24
    { name: 'neg', stop: -5, target: 10 },
  ]);
  assert.deepEqual(list, [
    { name: '12/24t', stop: 12, target: 24 },
    { name: 'wide gap', stop: 9, target: 200 },
    { name: 'x'.repeat(24), stop: 4, target: 8 },
    { name: 'neg', stop: 0, target: 10 },
  ]);
  const many = Array.from({ length: 20 }, (_, i) => ({ name: 'p' + i, stop: i, target: 2 * i }));
  const kept = OT.cleanBracketPresets(many);
  assert.equal(kept.length, 12);
  assert.equal(kept[11].name, 'p11');
  const weird = [{ get name() { return 'a'; }, stop: 1, target: 2 }, Object.create(null)];
  assert.doesNotThrow(() => OT.cleanBracketPresets(weird));
  assert.equal(OT.bracketPresetName('  a   b '), 'a b');
  assert.equal(OT.defaultPresetName(12, 24), '12/24t');
});

test('qtyOptions: 1 to 9, the ones over the cap off', () => {
  assert.deepEqual(OT.qtyOptions(5).map(o => o.n + (o.ok ? '+' : '-')).join(), '1+,2+,3+,4+,5+,6-,7-,8-,9-');
  assert.deepEqual(OT.qtyOptions(1).filter(o => o.ok).map(o => o.n), [1]);
  assert.equal(OT.qtyOptions(20).every(o => o.ok), true);
  assert.equal(OT.qtyOptions(9).length, 9);
});
