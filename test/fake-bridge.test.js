'use strict';
// The fake bridge's order entry (test/fake-orders.mjs) is the reference for ChartBridge protocol v2:
// every safety gate refused with its reason, the matching engine, brackets, flatten, and (through the
// real fake server) the Origin and session token checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const INSTR = { MNQ: { name: 'MNQ 12-26', tick: 0.25, pointValue: 2 }, ES: { name: 'ES 12-26', tick: 0.25, pointValue: 50 } };
const KNOWN = ['Sim101', 'DEMO-EVAL', 'DEMO-OTHER', 'Playback101', 'Backtest'];

async function makeDesk(cfg) {
  const { OrderDesk } = await import('./fake-orders.mjs');
  let clock = 1000000;
  const out = [];
  const conn = { origin: 'http://localhost:8765', authed: false, actions: [] };
  const desk = new OrderDesk({
    config: Object.assign({ trading: true, tradeAccounts: ['Sim101', 'DEMO-EVAL'], maxQty: { MNQ: 5 }, port: 8765 }, cfg || {}),
    instruments: INSTR, knownAccounts: KNOWN, token: 'tok-123',
    send: (c, m) => out.push(m), conns: () => [conn], now: () => clock, barTime: () => clock / 1000,
  });
  desk.tick('MNQ', 25400); desk.tick('ES', 6500);
  const d = {
    desk, conn, out,
    advance(ms) { clock += ms; },
    take(type) { const r = out.filter(m => !type || m.type === type); out.length = 0; return r; },
    auth() { desk.auth(conn, 'tok-123'); return d.take(); },
    act(m) { clock += 150; desk.handle(conn, m); return d.take(); },   // 150 ms apart: under the rate limit
    order(f) { return d.act(Object.assign({ type: 'order', cid: 'c' + Math.random().toString(36).slice(2, 7), account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'market', qty: 1 }, f)); },
    working() { return [...desk.orders.values()].filter(o => o.state === 'working' || o.state === 'partFilled'); },
    pos(account, root) { return desk.pos(account || 'Sim101', root || 'MNQ'); },
    tick(p, root) { desk.tick(root || 'MNQ', p); return d.take(); },
  };
  return d;
}
const reasonOf = msgs => { const r = msgs.find(m => m.type === 'reject'); return r ? r.reason : null; };

test('gate 1: trading off in config.txt refuses auth and every order', async () => {
  const d = await makeDesk({ trading: false });
  const t = d.auth().find(m => m.type === 'trading');
  assert.equal(t.enabled, false);
  assert.match(t.reason, /Trading is off/);
  assert.deepEqual(t.accounts, []);
  assert.match(reasonOf(d.order({})), /Trading is off/);
  assert.equal(d.desk.orders.size, 0);
});

test('hello carries trading disabled until auth; auth answers trading, orders and positions', async () => {
  const d = await makeDesk();
  const h = d.desk.helloTrading(d.conn);
  assert.equal(h.enabled, false); assert.match(h.reason, /not signed in/);
  assert.match(reasonOf(d.order({})), /not signed in/);           // an order before auth
  const msgs = d.auth();
  assert.deepEqual(msgs.map(m => m.type), ['trading', 'orders']);
  assert.deepEqual(msgs[0], { type: 'trading', enabled: true, accounts: ['Sim101', 'DEMO-EVAL'], maxQty: { '*': 1, MNQ: 5 } });
});

test('gate 4: a wrong token or another page (Origin) cannot trade', async () => {
  const d = await makeDesk();
  d.desk.auth(d.conn, 'nope');
  assert.match(d.take('trading')[0].reason, /session token does not match/);
  assert.match(reasonOf(d.order({})), /not signed in/);
  const other = await makeDesk();
  other.conn.origin = 'http://evil.example';
  const t = other.auth()[0];
  assert.equal(t.enabled, false); assert.match(t.reason, /ChartBridge's own page \(http:\/\/localhost:8765\)/);
  other.conn.authed = true;                                           // even if something marked it signed in
  assert.match(reasonOf(other.order({})), /own page/);
});

test('gate 2: account allow-list, never Backtest or Playback, no wildcard', async () => {
  const { allowedAccounts } = await import('./fake-orders.mjs');
  assert.deepEqual(allowedAccounts(['Sim101', 'Playback101', 'Backtest', 'DEMO-*', '*', 'NotThere', ' DEMO-EVAL '], KNOWN), ['Sim101', 'DEMO-EVAL']);
  const d = await makeDesk(); d.auth();
  assert.match(reasonOf(d.order({ account: 'DEMO-OTHER' })), /Account DEMO-OTHER is not allowed/);
  assert.match(reasonOf(d.order({ account: 'Playback101' })), /not allowed/);
  assert.match(reasonOf(d.act({ type: 'flatten', account: 'DEMO-OTHER', root: 'MNQ' })), /not allowed/);
  const none = await makeDesk({ tradeAccounts: ['Backtest'] });
  assert.match(none.auth()[0].reason, /No account is allowed/);
});

test('gate 3: qty cap per root (default 1), and the cap also limits the position a new order could build', async () => {
  const d = await makeDesk(); d.auth();
  assert.match(reasonOf(d.order({ qty: 6 })), /^Qty 6 is over the MNQ cap of 5 \(maxQty\.MNQ in config\.txt\)\.$/);
  assert.match(reasonOf(d.order({ root: 'ES', qty: 2 })), /over the ES cap of 1/);
  assert.match(reasonOf(d.order({ qty: 0 })), /whole number/);
  assert.match(reasonOf(d.order({ qty: 1.5 })), /whole number/);
  assert.equal(reasonOf(d.order({ qty: 3 })), null);                   // long 3
  assert.match(reasonOf(d.order({ qty: 3 })), /could take the MNQ position on Sim101 to 6/);
  assert.equal(reasonOf(d.order({ qty: 2, kind: 'limit', price: 25390 })), null);   // 3 + 2 working = 5
  assert.match(reasonOf(d.order({ qty: 1, kind: 'limit', price: 25380 })), /to 6/);
  assert.equal(reasonOf(d.order({ side: 'sell', qty: 5 })), null);    // selling reduces: allowed
});

test('gate 5: tick grid, maxTicksAway from the last price when config.txt sets it, stops on the right side (orders and changes)', async () => {
  const d = await makeDesk({ maxTicksAway: 200 }); d.auth();
  assert.match(reasonOf(d.order({ kind: 'limit', price: 25390.1 })), /not on the MNQ tick grid/);
  assert.match(reasonOf(d.order({ kind: 'limit', price: 25349.75 })), /201 ticks from the last price 25,400.00; the limit is 200 \(maxTicksAway in config.txt\)/);
  assert.equal(reasonOf(d.order({ kind: 'limit', price: 25350 })), null);           // exactly 200
  assert.match(reasonOf(d.order({ kind: 'stop', price: 25399.75 })), /buy stop must be above/);
  assert.match(reasonOf(d.order({ kind: 'stop', price: 25400 })), /buy stop must be above/);
  assert.match(reasonOf(d.order({ kind: 'stop', side: 'sell', price: 25400.25 })), /sell stop must be below/);
  assert.match(reasonOf(d.order({ kind: 'limit' })), /needs a price/);
  const id = [...d.desk.orders.values()].find(o => o.kind === 'limit').id;
  assert.match(reasonOf(d.act({ type: 'change', id, price: 25300 })), /400 ticks/);
  assert.match(reasonOf(d.act({ type: 'change', id: 'NT999', price: 25390 })), /No working order NT999/);
  const rej = d.act({ type: 'change', id: 'NT999', price: 25390 }).find(m => m.type === 'reject');
  assert.equal(rej.id, 'NT999');
});

test('gate 6: only the roots ChartBridge serves', async () => {
  const d = await makeDesk(); d.auth();
  assert.match(reasonOf(d.order({ root: 'CL' })), /CL is not an instrument ChartBridge serves/);
});

test('gate 7: more than 10 order actions in one second are refused, and the reject carries the cid', async () => {
  const d = await makeDesk({ maxQty: { MNQ: 50 } }); d.auth();
  const res = [];
  for (let i = 0; i < 12; i++) { d.advance(50); d.desk.handle(d.conn, { type: 'order', cid: 'r' + i, account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'limit', qty: 1, price: 25390 }); res.push(d.take('reject')[0] || null); }
  assert.equal(res.slice(0, 10).filter(Boolean).length, 0);
  assert.deepEqual(res[10], { type: 'reject', cid: 'r10', reason: 'More than 10 order actions in one second. Slow down.' });
  d.advance(1100);
  assert.equal(reasonOf(d.order({ kind: 'limit', price: 25390 })), null);
});

test('market order fills at the last price: order, exec and position messages', async () => {
  const d = await makeDesk(); d.auth();
  const msgs = d.order({ cid: 'm1', qty: 2 });
  assert.deepEqual(msgs.map(m => m.type), ['order', 'exec', 'order', 'position']);
  assert.equal(msgs[0].state, 'working'); assert.equal(msgs[0].cid, 'm1'); assert.equal(msgs[0].price, null); assert.ok(!('text' in msgs[0]));
  assert.equal(msgs[1].side, 'buy'); assert.equal(msgs[1].qty, 2); assert.equal(msgs[1].p, 25400); assert.equal(msgs[1].name, 'MNQ 12-26');
  assert.equal(msgs[2].state, 'filled'); assert.equal(msgs[2].avgFill, 25400); assert.equal(msgs[2].role, 'entry');
  assert.deepEqual(msgs[3], { type: 'position', account: 'Sim101', root: 'MNQ', qty: 2, avgPrice: 25400 });
});

test('limit and stop fill when price crosses; a touch fills one contract', async () => {
  const d = await makeDesk(); d.auth();
  d.order({ kind: 'limit', price: 25390, qty: 3 });
  const lim = d.working()[0];
  assert.equal(d.tick(25391).length, 0);
  d.tick(25390);                                                   // touch: 1 of 3
  assert.equal(lim.state, 'partFilled'); assert.equal(lim.filled, 1);
  d.tick(25389.75);                                                // through: the rest, at the limit price
  assert.equal(lim.state, 'filled'); assert.equal(lim.avgFill, 25390);
  assert.deepEqual(d.pos(), { qty: 3, avgPrice: 25390 });
  d.order({ kind: 'stop', side: 'sell', price: 25380, qty: 1 });
  d.tick(25380.25);
  assert.equal(d.working().length, 1);
  const msgs = d.tick(25379.5);                                    // stop triggers: fills at the trade price
  assert.equal(msgs.find(m => m.type === 'exec').p, 25379.5);
  assert.deepEqual(d.pos(), { qty: 2, avgPrice: 25390 });
});

test('gate 3: bracket legs and orders placed elsewhere count toward the cap; an OCO pair counts once', async () => {
  const d = await makeDesk({ maxQty: { MNQ: 2 } }); d.auth();
  assert.equal(reasonOf(d.order({ qty: 2, bracket: { stop: 40, target: 80 } })), null);    // long 2, one OCO pair of 2 (sells)
  assert.equal(reasonOf(d.order({ side: 'sell', qty: 2 })), null);                          // exit: -2 + 2 (pair once) + 2 = 2
  const e = await makeDesk({ maxQty: { MNQ: 2 } }); e.auth();
  assert.equal(reasonOf(e.order({ qty: 2, bracket: { stop: 40, target: 0 } })), null);     // long 2 with a lone sell stop 2
  assert.equal(reasonOf(e.order({ side: 'sell', qty: 1, kind: 'limit', price: 25410 })), null);   // -2 + 2 + 1 = 1
  assert.match(reasonOf(e.order({ side: 'sell', qty: 2, kind: 'limit', price: 25420 })), /to 3/);   // -2 + 3 + 2 = 3
});

test('gate 8: only the protocol keys; a misspelt or null bracket is refused, never sent naked', async () => {
  const d = await makeDesk(); d.auth();
  assert.match(reasonOf(d.order({ brakcet: { stop: 8, target: 16 } })), /Unknown key "brakcet" in order/);
  assert.match(reasonOf(d.order({ bracket: null })), /bracket must be/);
  assert.match(reasonOf(d.order({ bracket: { stop: 8 } })), /Bracket target must be a whole number/);
  assert.match(reasonOf(d.order({ bracket: { stop: 8, target: 16, trail: 4 } })), /Unknown key "trail" in bracket/);
  assert.match(reasonOf(d.order({ qty: [1] })), /nested object or list/);
  assert.match(reasonOf(d.act({ type: 'flatten', account: 'Sim101', root: 'MNQ', all: true })), /Unknown key "all" in flatten/);
  assert.equal(d.desk.orders.size, 0);
  const noCid = d.act({ type: 'order', account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'market', qty: 1 });
  assert.equal(reasonOf(noCid), null);                                   // cid is optional, as in ChartBridge
  const r = d.act({ type: 'cancel', cid: 'k1', id: 'nope' });
  assert.deepEqual([r[0].type, r[0].cid, r[0].id], ['reject', 'k1', 'nope']);   // a reject carries whatever the message had
});

test('bracket: an OCO pair around the fill; target fill cancels the stop', async () => {
  const d = await makeDesk(); d.auth();
  const msgs = d.order({ qty: 2, bracket: { stop: 40, target: 80 } });
  const legs = msgs.filter(m => m.type === 'order' && m.role !== 'entry');
  assert.equal(legs.length, 2);
  const stop = legs.find(m => m.role === 'stop'), target = legs.find(m => m.role === 'target');
  assert.deepEqual([stop.side, stop.kind, stop.qty, stop.price, 'cid' in stop], ['sell', 'stop', 2, 25390, false]);
  assert.deepEqual([target.side, target.kind, target.qty, target.price], ['sell', 'limit', 2, 25420]);
  assert.ok(stop.oco && stop.oco === target.oco);
  const out = d.tick(25420.25);                                    // target traded through
  const last = new Map(out.filter(m => m.type === 'order').map(m => [m.id, m]));
  assert.equal(last.get(target.id).state, 'filled');
  assert.equal(last.get(stop.id).state, 'cancelled');
  assert.deepEqual(out.filter(m => m.type === 'position').pop(), { type: 'position', account: 'Sim101', root: 'MNQ', qty: 0, avgPrice: null });
  assert.equal(d.working().length, 0);
});

test('bracket follows partial fills: each fill increment gets its own OCO pair; OCO partners shrink together', async () => {
  const d = await makeDesk(); d.auth();
  d.order({ kind: 'limit', price: 25390, qty: 3, bracket: { stop: 8, target: 8 } });
  const entry = d.working()[0];
  d.tick(25390);                                                   // 1 filled: a pair for 1
  let legs = d.working().filter(o => o.role !== 'entry');
  assert.deepEqual(legs.map(o => [o.role, o.qty, o.price]).sort(), [['stop', 1, 25388], ['target', 1, 25392]]);
  d.tick(25390.25); d.tick(25390);                                 // 2 filled: a second pair for 1, its own OCO id
  legs = d.working().filter(o => o.role !== 'entry');
  assert.equal(legs.length, 4);
  assert.equal(new Set(legs.map(o => o.oco)).size, 2);
  d.tick(25389.75);                                                // through: the last contract, a third pair
  assert.equal(entry.state, 'filled');
  legs = d.working().filter(o => o.role !== 'entry');
  assert.equal(legs.length, 6);
  assert.deepEqual(d.pos(), { qty: 3, avgPrice: 25390 });
  d.tick(25392);                                                   // all three targets touched (1 each): flat, every stop cancelled
  assert.equal(d.pos().qty, 0);
  assert.equal(d.working().length, 0);
});

test('an OCO partner shrinks with a partial fill of its leg', async () => {
  const d = await makeDesk(); d.auth();
  d.order({ qty: 3, bracket: { stop: 8, target: 8 } });           // market: one fill of 3, one pair of 3
  const stop = d.working().find(o => o.role === 'stop'), target = d.working().find(o => o.role === 'target');
  d.tick(25402);                                                   // target touched: 1 of 3
  assert.equal(target.filled, 1); assert.equal(stop.qty - stop.filled, 2);
  d.tick(25397.75);                                                // stop through: the other 2
  assert.equal(stop.state, 'filled'); assert.equal(target.state, 'cancelled'); assert.equal(d.pos().qty, 0);
});

test('flat position cancels leftover legs; after Flatten a late entry fill still gets its legs, with an alarm', async () => {
  const d = await makeDesk(); d.auth();
  d.order({ qty: 1, bracket: { stop: 8, target: 8 } });
  d.order({ side: 'sell', qty: 1 });                               // closed by hand: the legs are left over, then cancelled
  assert.equal(d.pos().qty, 0);
  assert.equal(d.working().length, 0);
  d.order({ kind: 'limit', price: 25390, qty: 2, bracket: { stop: 8, target: 80 } });   // target above the market (25400), so it rests
  const entry = d.working()[0];
  d.act({ type: 'flatten', account: 'Sim101', root: 'MNQ' });
  entry.state = 'working';                                         // a fill that raced the cancel
  d.take();
  d.desk.fill(entry, 1, 25390);
  const out = d.take();
  assert.equal(d.pos().qty, 1);
  assert.deepEqual(d.working().filter(o => o.role !== 'entry').map(o => o.role).sort(), ['stop', 'target'], 'the open position is protected');
  assert.ok(out.some(m => m.type === 'status' && m.level === 'error' && /AFTER Flatten/.test(m.text)), 'and the page is alarmed');
});

test('a stop level already passed when the fill lands becomes a market exit, with an alarm', async () => {
  const d = await makeDesk(); d.auth();
  d.order({ kind: 'limit', price: 25390, qty: 1, bracket: { stop: 8, target: 16 } });
  const entry = d.working()[0];
  d.desk.last.MNQ = 25387;                                          // price fell through the stop level (25388) first
  d.take();
  d.desk.fill(entry, 1, 25390);
  const out = d.take();
  assert.equal(d.working().filter(o => o.role === 'stop').length, 0, 'no stop placed through the market');
  assert.equal(d.pos().qty, 0, 'the market exit closed it');
  assert.ok(out.some(m => m.type === 'status' && m.level === 'error' && /already passed the stop level/.test(m.text)));
});

test('gate 5: a limit through the market is refused (it would fill at once)', async () => {
  const d = await makeDesk(); d.auth();
  assert.match(reasonOf(d.order({ kind: 'limit', price: 25401 })), /buy limit above the last price/);
  assert.match(reasonOf(d.order({ side: 'sell', kind: 'limit', price: 25399 })), /sell limit below the last price/);
  assert.equal(d.desk.orders.size, 0);
});

test('brackets: JSON whole numbers only, and only on an order that opens or adds', async () => {
  const d = await makeDesk(); d.auth();
  assert.match(reasonOf(d.order({ bracket: { stop: '8', target: 8 } })), /Bracket stop must be a whole number/);
  assert.match(reasonOf(d.order({ bracket: { stop: 8, target: null } })), /Bracket target must be a whole number/);
  assert.match(reasonOf(d.order({ bracket: { stop: 8 } })), /Bracket target/);
  assert.match(reasonOf(d.order({ bracket: { stop: -1, target: 0 } })), /0 or more/);
  assert.match(reasonOf(d.order({ bracket: null })), /must be \{/);
  assert.equal(reasonOf(d.order({ bracket: { stop: 0, target: 0 } })), null);   // long 1, no legs
  assert.equal(d.working().length, 0);
  assert.equal(reasonOf(d.order({ bracket: { stop: 8, target: 8 } })), null);   // adds: long 2
  assert.equal(reasonOf(d.order({ side: 'sell', bracket: { stop: 0, target: 0 } })), null);   // reduces, no bracket: fine
  assert.match(reasonOf(d.order({ side: 'sell', bracket: { stop: 8, target: 8 } })), /^A bracket can only go on an order that opens or adds to a position\.$/);
});

test('0.3.7: no distance limits unless config.txt sets them (maxTicksAway, maxBracketTicks)', async () => {
  const d = await makeDesk({ maxQty: { MNQ: 5 } }); d.auth();
  assert.equal(reasonOf(d.order({ kind: 'limit', price: 25150, bracket: { stop: 500, target: 500 } })), null);   // 1000 ticks away, 500-tick bracket
  const e = d.working().find(o => o.role === 'entry');
  assert.deepEqual(e.planned, { stop: 25025, target: 25275 });
  assert.equal(reasonOf(d.order({ bracket: { stop: 500, target: 1000 } })), null);                              // market: ticks from the fill
  assert.deepEqual(d.working().filter(o => o.role !== 'entry').map(o => o.price).sort(), [25275, 25650]);
  const l = await makeDesk({ maxTicksAway: 400, maxBracketTicks: 300 }); l.auth();
  assert.deepEqual(l.desk.tradingMsg(l.conn).maxTicksAway, 400);
  assert.match(reasonOf(l.order({ kind: 'limit', price: 25150 })), /1000 ticks .* the limit is 400 \(maxTicksAway in config.txt\)/);
  assert.match(reasonOf(l.order({ bracket: { stop: 301, target: 0 } })), /from 0 to 300 ticks \(maxBracketTicks in config.txt\)/);
  assert.match(reasonOf(l.order({ kind: 'limit', price: 25390, stopPrice: 25290 })), /more than 300 ticks from the entry price/);
});

test('0.3.7: a resting entry\'s stop and target are prices; its legs go there at any fill price', async () => {
  const d = await makeDesk({ maxQty: { MNQ: 5 } }); d.auth();
  const placed = d.order({ kind: 'limit', price: 25390, qty: 3, stopPrice: 25380, targetPrice: 25420 });
  const entryMsg = placed.find(m => m.type === 'order' && m.role === 'entry');
  assert.deepEqual(entryMsg.planned, { stop: 25380, target: 25420 }, 'the order event carries the planned prices');
  const entry = d.working()[0];
  d.desk.fill(entry, 1, 25390); d.desk.fill(entry, 1, 25385); d.desk.fill(entry, 1, 25388);   // at the limit, a gap better, another price
  const legs = d.working().filter(o => o.role !== 'entry');
  assert.deepEqual(legs.map(o => o.role + ' ' + o.qty + ' ' + o.price).sort(), ['stop 1 25380', 'stop 1 25380', 'stop 1 25380', 'target 1 25420', 'target 1 25420', 'target 1 25420']);
  // old page: bracket ticks on a limit become prices from its price; on a stop entry slippage does not move them
  d.order({ kind: 'stop', price: 25410, bracket: { stop: 8, target: 16 } });
  const se = d.working().find(o => o.role === 'entry');
  assert.deepEqual(se.planned, { stop: 25408, target: 25414 });
  d.tick(25411);                                                     // the stop triggers: fills at 25411 (slippage)
  assert.equal(se.avgFill, 25411);
  assert.deepEqual(d.working().filter(o => o.parent === se.id).map(o => o.price).sort(), [25408, 25414]);
  // a gap through the planned stop at the fill: the market exit, with its alarm
  const g = await makeDesk(); g.auth();
  g.order({ kind: 'limit', price: 25390, stopPrice: 25380, targetPrice: 25420 });
  g.take();
  g.desk.fill(g.working()[0], 1, 25378);
  const out = g.take();
  assert.equal(g.working().length, 0);
  assert.ok(out.some(m => m.type === 'status' && m.level === 'error' && /passed the stop level 25,380.00 \(filled at 25,378.00\)/.test(m.text)));
  assert.match(reasonOf(g.order({ qty: 1, stopPrice: 25380 })), /market entry's stop and target are ticks from the fill/);
  assert.match(reasonOf(g.order({ kind: 'limit', price: 25390, stopPrice: 25395 })), /buy entry's stop must be below its price 25,390.00/);
  assert.match(reasonOf(g.order({ kind: 'limit', price: 25390, stopPrice: 25380, bracket: { stop: 8, target: 8 } })), /not both/);
});

test('0.3.7: moving a resting entry keeps its planned prices; plan adds, moves and removes them before the fill', async () => {
  const d = await makeDesk({ maxQty: { MNQ: 5 } }); d.auth();
  d.order({ kind: 'limit', price: 25390, qty: 2, stopPrice: 25380, targetPrice: 25420 });
  const e = d.working()[0];
  assert.equal(reasonOf(d.act({ type: 'change', id: e.id, price: 25385 })), null);
  assert.deepEqual(e.planned, { stop: 25380, target: 25420 });
  assert.match(reasonOf(d.act({ type: 'change', id: e.id, price: 25380 })), /cannot move to or past its own planned stop 25,380.00/);
  let r = d.act({ type: 'plan', cid: 'p1', id: e.id, stopPrice: 25370 });
  assert.equal(reasonOf(r), null);
  assert.deepEqual(r.find(m => m.type === 'order').planned, { stop: 25370, target: 25420 });
  assert.match(reasonOf(d.act({ type: 'plan', id: e.id, stopPrice: 25390 })), /stop must be below its price 25,385.00/);
  assert.match(reasonOf(d.act({ type: 'plan', id: e.id, targetPrice: 25420.1 })), /not on the MNQ tick grid/);
  assert.match(reasonOf(d.act({ type: 'plan', id: e.id })), /plan needs stopPrice or targetPrice/);
  assert.match(reasonOf(d.act({ type: 'plan', id: e.id, stopPrice: '25370' })), /stopPrice must be a plain price/);
  assert.match(reasonOf(d.act({ type: 'plan', id: e.id, stop: 25370 })), /Unknown key "stop" in plan/);
  d.desk.fill(e, 1, 25385);                                          // part filled: the first contract's pair
  assert.equal(reasonOf(d.act({ type: 'plan', id: e.id, targetPrice: null })), null);   // remove the target: for what is still to fill
  d.desk.fill(e, 1, 25385);
  const legs = d.working().filter(o => o.parent === e.id).map(o => o.role + ' ' + o.price + ' ' + (o.oco ? 'oco' : 'lone')).sort();
  assert.deepEqual(legs, ['stop 25370 lone', 'stop 25370 oco', 'target 25420 oco'], 'the first pair untouched, the second fill a lone stop');
  const leg = d.working().find(o => o.role === 'stop');
  assert.match(reasonOf(d.act({ type: 'plan', id: leg.id, stopPrice: 25375 })), /Only a ChartBridge entry/);
  d.order({ kind: 'limit', price: 25390 });                          // placed with no bracket: a target added later
  const n = d.working().find(o => o.role === 'entry');
  assert.deepEqual(n.planned, { stop: null, target: null });
  assert.equal(reasonOf(d.act({ type: 'plan', id: n.id, targetPrice: 25400 })), null);
  d.desk.fill(n, 1, 25390);
  assert.deepEqual(d.working().filter(o => o.parent === n.id).map(o => o.role + ' ' + o.price), ['target 25400']);
});

test('stale last price refuses limit and stop prices, not market; stop-limits cannot move', async () => {
  const d = await makeDesk(); d.auth();
  d.advance(299000);
  assert.equal(reasonOf(d.order({ kind: 'limit', price: 25390 })), null);
  d.advance(2000);
  assert.match(reasonOf(d.order({ kind: 'limit', price: 25390 })), /last price for MNQ is stale/);
  const id = d.working()[0].id;
  assert.match(reasonOf(d.act({ type: 'change', id, price: 25391 })), /stale/);
  assert.equal(reasonOf(d.order({ side: 'sell', qty: 1 })), null);
  d.tick(25400);
  const sl = d.desk.placeElsewhere({ account: 'Sim101', root: 'MNQ', side: 'sell', kind: 'stopLimit', qty: 1, price: 25380 });
  assert.match(reasonOf(d.act({ type: 'change', id: sl.id, price: 25381 })), /Only limit and stop market orders can be moved/);
  d.desk.placeElsewhere({ account: 'Sim101', root: 'CL', side: 'sell', kind: 'limit', qty: 1, price: 80 });
  assert.equal(d.take('order').length, 0, 'no order messages for roots ChartBridge does not serve');
});

test('cancel: one bracket leg cancels its pair; change moves a leg; stop side still checked', async () => {
  const d = await makeDesk(); d.auth();
  d.order({ qty: 1, bracket: { stop: 20, target: 40 } });
  const [stop, target] = ['stop', 'target'].map(r => d.working().find(o => o.role === r));
  assert.equal(reasonOf(d.act({ type: 'change', id: target.id, price: 25415 })), null);
  assert.equal(target.price, 25415);
  assert.match(reasonOf(d.act({ type: 'change', id: stop.id, price: 25401 })), /sell stop must be below/);
  const out = d.act({ type: 'cancel', id: stop.id });
  assert.deepEqual(out.map(m => [m.id, m.state]), [[stop.id, 'cancelled'], [target.id, 'cancelled']]);
  assert.match(reasonOf(d.act({ type: 'cancel', id: stop.id })), /No working order/);
});

test('flatten: cancels every working order for the account and root, then closes at market', async () => {
  const d = await makeDesk(); d.auth();
  d.order({ qty: 2, bracket: { stop: 20, target: 40 } });
  d.order({ side: 'sell', kind: 'limit', price: 25450, qty: 1 });
  d.order({ account: 'DEMO-EVAL', kind: 'limit', price: 25390, qty: 1 });    // other account: untouched
  d.order({ root: 'ES', kind: 'limit', price: 6490, qty: 1 });               // other root: untouched
  const out = d.act({ type: 'flatten', account: 'Sim101', root: 'MNQ' });
  const cancelled = out.filter(m => m.type === 'order' && m.state === 'cancelled');
  assert.equal(cancelled.length, 3);
  const close = out.find(m => m.type === 'order' && m.state === 'filled');
  assert.deepEqual([close.side, close.qty, close.role, close.kind], ['sell', 2, 'other', 'market']);
  assert.equal(d.pos().qty, 0);
  assert.deepEqual(d.working().map(o => o.account + ' ' + o.root).sort(), ['DEMO-EVAL MNQ', 'Sim101 ES']);
  assert.equal(reasonOf(d.act({ type: 'flatten', account: 'Sim101', root: 'MNQ' })), null);   // nothing left: no error
});

test('orders placed in NinjaTrader show with role other and can be moved and cancelled', async () => {
  const d = await makeDesk(); d.auth();
  const o = d.desk.placeElsewhere({ account: 'DEMO-EVAL', root: 'MNQ', side: 'sell', kind: 'limit', qty: 1, price: 25420 });
  assert.equal(d.take('order')[0].role, 'other');
  assert.equal(reasonOf(d.act({ type: 'change', id: o.id, price: 25425 })), null);
  assert.equal(reasonOf(d.act({ type: 'cancel', id: o.id })), null);
  assert.equal(o.state, 'cancelled');
  const hidden = d.desk.placeElsewhere({ account: 'DEMO-OTHER', root: 'MNQ', side: 'sell', kind: 'limit', qty: 1, price: 25420 });
  assert.equal(d.take('order').length, 0, 'orders on accounts not allowed are never sent');
  assert.match(reasonOf(d.act({ type: 'cancel', id: hidden.id })), /No working order/);
});

test('a second page signing in gets the working orders and open positions', async () => {
  const d = await makeDesk(); d.auth();
  d.order({ qty: 1, bracket: { stop: 20, target: 0 } });
  const msgs = d.auth();
  const list = msgs.find(m => m.type === 'orders').list;
  assert.deepEqual(list.map(o => [o.role, o.oco]), [['stop', null]]);           // a single leg has no OCO partner
  assert.deepEqual(msgs.find(m => m.type === 'position'), { type: 'position', account: 'Sim101', root: 'MNQ', qty: 1, avgPrice: 25400 });
});

/* ---------------- through the real fake server: GET /session and the WebSocket Origin check */
function wsConnect(port, origin, unlock) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/ws' + (unlock ? '?unlock=' + encodeURIComponent(unlock) : ''), headers: Object.assign({
      Host: 'localhost:' + port, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') }, origin ? { Origin: origin } : {}) });
    req.on('upgrade', (res, sock, head) => {
      const msgs = [], waiters = []; let buf = Buffer.alloc(0);
      const onData = d => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (buf.length < 2) break;
          let len = buf[1] & 0x7f, p = 2;
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); p = 4; }
          else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); p = 10; }
          if (buf.length < p + len) break;
          const m = JSON.parse(buf.slice(p, p + len).toString('utf8')); buf = buf.slice(p + len);
          msgs.push(m); for (const w of waiters.splice(0)) w();
        }
      };
      sock.on('data', onData);
      if (head && head.length) onData(head);                 // bytes that arrived with the 101 response
      const send = obj => {
        const data = Buffer.from(JSON.stringify(obj)), mask = crypto.randomBytes(4);
        const head = data.length < 126 ? Buffer.from([0x81, 0x80 | data.length]) : Buffer.from([0x81, 0x80 | 126, data.length >> 8, data.length & 255]);
        const body = Buffer.from(data.map((b, i) => b ^ mask[i & 3]));
        sock.write(Buffer.concat([head, mask, body]));
      };
      const next = async (type, ms) => {
        const end = Date.now() + (ms || 3000);
        for (;;) {
          const i = msgs.findIndex(m => m.type === type);
          if (i >= 0) return msgs.splice(i, 1)[0];
          if (Date.now() > end) return null;
          await new Promise(r => { waiters.push(r); setTimeout(r, 50); });
        }
      };
      resolve({ send, next, close: () => sock.destroy() });
    });
    req.on('response', res => { res.resume(); reject(new Error('WebSocket refused: ' + res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
}
function get(port, p, host, unlock) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: Object.assign({ Host: host || 'localhost:' + port }, unlock ? { 'X-ChartBridge-Unlock': unlock } : {}) }, res => {
      let body = ''; res.on('data', d => body += d); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}
// POST to a PIN endpoint the way ChartBridge's page does (own Origin, JSON); o overrides method, headers or the raw body
function pinPost(port, p, body, o) {
  o = o || {};
  return new Promise((resolve, reject) => {
    const data = o.raw !== undefined ? o.raw : JSON.stringify(body || {});
    const headers = Object.assign({ Host: 'localhost:' + port, Origin: 'http://localhost:' + port, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, o.headers || {});
    for (const k of Object.keys(headers)) if (headers[k] === null) delete headers[k];
    const req = http.request({ host: '127.0.0.1', port, path: p, method: o.method || 'POST', agent: false, headers }, res => {
      let text = ''; res.on('data', d => text += d);
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    req.on('error', reject);
    if (o.method !== 'GET') req.write(data);
    req.end();
  });
}
const TEST_PIN = '5820';                                  // made-up PINs, tests only
const unlockFor = async (port, pin) => (await pinPost(port, '/pin/unlock', { pin: pin || TEST_PIN })).json.token;

async function startBridge(port, flags) {
  const child = spawn(process.execPath, [path.join(__dirname, 'fake-bridge.mjs'), String(port)].concat(flags), { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => child.stdout.once('data', r));
  return child;
}

test('server: /session is same-origin only, the token is checked, and only ChartBridge\'s own page may trade', async () => {
  const port = 18700 + Math.floor(Math.random() * 200);
  const child = await startBridge(port, ['--trading', '--trade-accounts=Sim101,DEMO-EVAL', '--max-qty=MNQ:5', '--allow-origins=https://desk.example', '--test-pin=' + TEST_PIN]);
  try {
    const pg = await get(port, '/live/');
    assert.equal(pg.headers['x-frame-options'], 'DENY');
    assert.equal(pg.headers['content-security-policy'], "frame-ancestors 'none'");
    assert.equal((await get(port, '/session')).status, 403, '0.3.2: no order sign-in token for a page not unlocked with the PIN');
    const unlock = await unlockFor(port);
    const s = await get(port, '/session', null, unlock);
    assert.equal(s.status, 200);
    assert.equal(s.headers['access-control-allow-origin'], undefined, 'no CORS headers');
    assert.equal(s.headers['cache-control'], 'no-store');
    const token = JSON.parse(s.body).token;
    assert.ok(token.length >= 24);
    assert.equal((await get(port, '/session', 'evil.example')).status, 400, 'a rebound host name gets no token');
    assert.equal((await get(port, '/session', 'evil.example', unlock)).status, 400, 'a rebound host name gets no token, even unlocked');

    const own = 'http://localhost:' + port;
    await assert.rejects(wsConnect(port, own), /refused: 403/, 'the own page\'s WebSocket needs the unlock');
    const a = await wsConnect(port, own, unlock);
    const hello = await a.next('hello');
    assert.equal(hello.trading.enabled, false);
    a.send({ type: 'auth', token: 'wrong' });
    assert.match((await a.next('trading')).reason, /does not match/);
    a.send({ type: 'order', cid: 'a1', account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'market', qty: 1 });
    assert.match((await a.next('reject')).reason, /not signed in/);
    a.send({ type: 'auth', token });
    const t = await a.next('trading');
    assert.equal(t.enabled, true); assert.deepEqual(t.accounts, ['Sim101', 'DEMO-EVAL']); assert.equal(t.maxQty.MNQ, 5);
    assert.ok(await a.next('orders'));
    a.send({ type: 'order', cid: 'a2', account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'market', qty: 1 });
    const filled = await a.next('exec');
    assert.equal(filled.account, 'Sim101');
    a.close();

    // a listed origin (The Desk) and a local program with no Origin header may read, never trade
    for (const origin of ['https://desk.example', 'HTTPS://DESK.EXAMPLE', null]) {
      const b = await wsConnect(port, origin);
      await b.next('hello');
      b.send({ type: 'auth', token });                       // even with the right token
      const tb = await b.next('trading');
      assert.equal(tb.enabled, false, 'origin ' + origin);
      assert.match(tb.reason, /own page/);
      b.send({ type: 'flatten', account: 'Sim101', root: 'MNQ' });
      assert.match((await b.next('reject')).reason, /own page/);
      b.close();
    }
  } finally { child.kill(); }
});

// the WebSocket upgrade status for an Origin (undefined: no header)
function wsStatus(port, origin, unlock) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, agent: false, path: '/ws' + (unlock ? '?unlock=' + encodeURIComponent(unlock) : ''), headers: Object.assign({
      Host: 'localhost:' + port, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') }, origin !== undefined ? { Origin: origin } : {}) });
    req.on('upgrade', (res, sock) => { sock.destroy(); resolve(101); });
    req.on('response', res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
}

test('server (ChartBridge 0.3.1 rule): a browser WebSocket only from ChartBridge\'s own page or allowOrigins', async () => {
  const port = 18600 + Math.floor(Math.random() * 90);
  const child = await startBridge(port, ['--allow-origins=https://desk.example,http://100.88.192.33:8800', '--test-pin=' + TEST_PIN]);
  try {
    const unlock = await unlockFor(port);
    assert.equal(await wsStatus(port, 'http://localhost:' + port), 403, '0.3.2: the own page without the unlock');
    assert.equal(await wsStatus(port, 'http://localhost:' + port, unlock), 101, '0.3.2: the own page with the unlock');
    const want = [['https://desk.example', 101], ['http://100.88.192.33:8800', 101], [undefined, 101],
      ['http://evil.example', 403], ['http://127.0.0.1:' + port, 403], ['https://desk.example.evil.example', 403], ['http://desk.example', 403],
      ['null', 403], ['', 403]];
    for (const [origin, status] of want) assert.equal(await wsStatus(port, origin), status, 'Origin ' + JSON.stringify(origin));
    const diag = JSON.parse((await get(port, '/diag')).body);
    assert.deepEqual(diag.network.allowOrigins, ['http://localhost:' + port, 'https://desk.example', 'http://100.88.192.33:8800']);
    assert.equal(diag.network.loopbackOnly, true);
    assert.equal(diag.network.refusedOrigin, 6);
  } finally { child.kill(); }
});

test('server: trading off by default; --v1 behaves like ChartBridge 0.2 (no trading field, no /session)', async () => {
  const port = 18900 + Math.floor(Math.random() * 90);
  let child = await startBridge(port, ['--test-pin=' + TEST_PIN]);
  try {
    const a = await wsConnect(port, 'http://localhost:' + port, await unlockFor(port));
    const hello = await a.next('hello');
    assert.equal(hello.trading.enabled, false); assert.match(hello.trading.reason, /Trading is off/);
    a.close();
  } finally { child.kill(); }
  await new Promise(r => setTimeout(r, 200));
  child = await startBridge(port + 1, ['--v1', '--trading']);
  try {
    assert.equal((await get(port + 1, '/session')).status, 404);
    assert.equal((await pinPost(port + 1, '/pin/status', {})).status, 404, 'ChartBridge 0.2 has no PIN: the page goes on without one');
    const a = await wsConnect(port + 1, 'http://localhost:' + (port + 1));
    const hello = await a.next('hello');
    assert.equal(hello.trading, undefined);
    a.send({ type: 'auth', token: 'x' });
    assert.equal(await a.next('trading', 500), null);
    a.close();
  } finally { child.kill(); }
});

/* ---------------- ChartBridge 0.3.2: the PIN on ChartBridge's own page (test/fake-pin.mjs, the rules of nt8/ChartBridgePin.cs) */
test('PIN parse: one flat object, the named keys once, 4 ASCII digit strings; anything else refused', async () => {
  const { parseFlat, validPin } = await import('./fake-pin.mjs');
  assert.deepEqual(parseFlat('{"pin":"5820"}', ['pin']), { pin: '5820' });
  assert.deepEqual(parseFlat(' { "newPin" : "1" , "pin":"2" } ', ['pin', 'newPin']), { pin: '2', newPin: '1' });
  assert.deepEqual(parseFlat('{}', []), {});
  for (const bad of ['', '{', '{"pin":5820}', '{"pin":"5820","pin":"5820"}', '{"pin":"5820","x":"1"}', '{"pin":null}', '{"pin":{"a":"1"}}',
    '{"pin":"58\\u0032"}', '{"pin":"5820"} x', '{"pin":"5820",}', '["5820"]', "{'pin':'5820'}", '{"pin":"123456789"}', '{"PIN":"5820"}'])
    assert.equal(parseFlat(bad, ['pin']), null, bad);
  assert.equal(parseFlat('{"pin":"5820"}', ['pin', 'newPin']), null, 'a missing key');
  for (const ok of ['0000', '5820']) assert.ok(validPin(ok));
  for (const no of ['582', '58201', '58a0', ' 582', '٨٥٣١', '', null, 5820]) assert.ok(!validPin(no), String(no));
});

test('server (0.3.2 PIN): set once, unlock, 20 wrong PINs never block the right one, change needs the current PIN', async () => {
  const port = 19100 + Math.floor(Math.random() * 90);
  const child = await startBridge(port, []);
  try {
    assert.deepEqual((await pinPost(port, '/pin/status', {})).json, { set: false, unlocked: false });
    assert.deepEqual(JSON.parse((await get(port, '/diag')).body).pin, { set: false });
    // strict: POST only, own page only (exact), localhost only, JSON only, small bodies, the named keys
    assert.equal((await pinPost(port, '/pin/status', null, { method: 'GET' })).status, 405);
    for (const origin of ['https://desk.example', 'http://LOCALHOST:' + port, 'http://127.0.0.1:' + port, '', null])
      assert.equal((await pinPost(port, '/pin/set', { pin: '5820' }, { headers: { Origin: origin } })).status, 403, 'Origin ' + origin);
    assert.equal((await pinPost(port, '/pin/set', { pin: '5820' }, { headers: { Host: 'evil.example' } })).status, 403);
    assert.equal((await pinPost(port, '/pin/set', { pin: '5820' }, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await pinPost(port, '/pin/set', null, { raw: '{"pin":"5820"' + ' '.repeat(300) + '}' })).status, 413);
    for (const raw of ['{"pin":5820}', '{"pin":"5820","x":"1"}', '{"pin":"58201"}', '{"pin":"٨٥٣١"}'])
      assert.equal((await pinPost(port, '/pin/set', null, { raw })).status, 400, raw);
    assert.equal((await pinPost(port, '/pin/unlock', { pin: '5820' })).status, 409, 'no PIN set yet');
    assert.equal(JSON.parse((await get(port, '/diag')).body).pin.set, false, 'nothing above set a PIN');

    const set = await pinPost(port, '/pin/set', { pin: '5820' });
    assert.equal(set.status, 200); assert.match(set.json.token, /^v1\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
    assert.equal(set.headers['cache-control'], 'no-store'); assert.equal(set.headers['access-control-allow-origin'], undefined);
    assert.equal((await pinPost(port, '/pin/set', { pin: '1397' })).status, 409, 'set once');
    assert.deepEqual((await pinPost(port, '/pin/status', {})).json, { set: true, unlocked: false });
    assert.deepEqual((await pinPost(port, '/pin/status', {}, { headers: { 'X-ChartBridge-Unlock': set.json.token } })).json, { set: true, unlocked: true });

    for (let i = 0; i < 20; i++) {
      const w = await pinPost(port, '/pin/unlock', { pin: i % 2 ? '1397' : '0000' });
      assert.equal(w.status, 403); assert.equal(w.json.reason, 'wrong PIN'); assert.equal(w.json.token, undefined);
    }
    const right = await pinPost(port, '/pin/unlock', { pin: '5820' });
    assert.equal(right.status, 200, 'the right PIN straight after 20 wrong ones');

    assert.equal((await pinPost(port, '/pin/change', { pin: '1397', newPin: '4061' })).status, 403, 'change with a wrong current PIN');
    assert.equal((await pinPost(port, '/pin/change', null, { raw: '{"newPin":"4061"}' })).status, 400, 'change without the current PIN');
    assert.equal((await pinPost(port, '/pin/change', { pin: '5820', newPin: '4061' })).status, 200);
    assert.equal((await pinPost(port, '/pin/unlock', { pin: '5820' })).status, 403, 'the old PIN no longer opens');
    assert.equal((await pinPost(port, '/pin/unlock', { pin: '4061' })).status, 200, 'the new PIN opens');
    assert.equal((await get(port, '/session', null, set.json.token)).status, 200, 'a page unlocked before the change stays unlocked');
    const diag = JSON.parse((await get(port, '/diag')).body);
    assert.deepEqual(diag.pin, { set: true }, '/diag: only whether a PIN is set');
  } finally { child.kill(); }
});

test('server (0.3.2 PIN): a restarted bridge with the same pin file keeps an open page unlocked; deleting the file ends it', async () => {
  const fs = require('node:fs'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-pin-')), file = path.join(dir, 'pin.txt');
  const port = 19200 + Math.floor(Math.random() * 90);
  let child = await startBridge(port, ['--pin-file=' + file, '--test-pin=' + TEST_PIN, '--trading', '--trade-accounts=Sim101']);
  let token;
  try {
    token = await unlockFor(port);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^v1 pbkdf2-sha256 50000 [0-9a-f]{32} [0-9a-f]{64} [0-9a-f]{64}$/m, 'the same pin file format as ChartBridge');
    assert.ok(!text.replace(/[0-9a-f]{32,}/g, '').includes(TEST_PIN), 'the pin file never holds the PIN');
    const before = JSON.parse((await get(port, '/session', null, token)).body).token;
    child.kill();
    await new Promise(r => setTimeout(r, 300));
    child = await startBridge(port, ['--pin-file=' + file, '--trading', '--trade-accounts=Sim101']);   // the restart: same folder, new process
    const s = await get(port, '/session', null, token);
    assert.equal(s.status, 200, 'the token from before the restart signs in');
    assert.notEqual(JSON.parse(s.body).token, before, 'a new order sign-in token after the restart');
    const a = await wsConnect(port, 'http://localhost:' + port, token);
    assert.ok(await a.next('hello'), 'the WebSocket takes the token from before the restart');
    a.close();
    fs.unlinkSync(file);                                                          // the forgotten-PIN recovery
    assert.deepEqual((await pinPost(port, '/pin/status', {}, { headers: { 'X-ChartBridge-Unlock': token } })).json, { set: false, unlocked: false });
    assert.equal((await get(port, '/session', null, token)).status, 403);
    await assert.rejects(wsConnect(port, 'http://localhost:' + port, token), /403/);
    const again = await pinPost(port, '/pin/set', { pin: '7302' });
    assert.equal(again.status, 200, 'a new PIN can be set');
    assert.equal((await get(port, '/session', null, token)).status, 403, 'the old token stays dead (a new secret)');
    assert.equal((await get(port, '/session', null, again.json.token)).status, 200);
  } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('server (0.3.2 PIN): allowOrigins pages, local programs and relay tickets keep 0.3.1 rules; no token in /test/received', async () => {
  const port = 19300 + Math.floor(Math.random() * 90);
  const child = await startBridge(port, ['--allow-origins=https://desk.example', '--test-pin=' + TEST_PIN, '--test-controls']);
  try {
    assert.equal(await wsStatus(port, 'https://desk.example'), 101, 'The Desk (allowOrigins), no PIN');
    assert.equal(await wsStatus(port, undefined), 101, 'a local program (no Origin), no PIN');
    const token = await unlockFor(port);
    assert.equal(await wsStatus(port, 'http://localhost:' + port, token), 101);
    const rec = await (await fetch(`http://127.0.0.1:${port}/test/received`, { method: 'POST' })).json();
    assert.ok(!JSON.stringify(rec).includes(token) && rec.urls.some(u => u.includes('unlock=(hidden)')), 'the unlock token is never kept: ' + JSON.stringify(rec.urls));
  } finally { child.kill(); }
  const port2 = port + 100;
  const relay = await startBridge(port2, ['--tickets', '--test-pin=' + TEST_PIN]);
  try {
    const req = (p, origin) => new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: port2, agent: false, path: p, headers: { Host: 'localhost:' + port2, Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), Origin: origin } });
      r.on('upgrade', (res, sock) => { sock.destroy(); resolve(101); }); r.on('response', res => { res.resume(); resolve(res.statusCode); }); r.on('error', reject); r.end();
    });
    assert.equal(await req('/ws?ticket=t1', 'http://localhost:' + port2), 101, 'a relay ticket stands for the relay (no Origin at ChartBridge): no PIN');
    assert.equal(await req('/ws', 'http://localhost:' + port2), 403, 'no ticket: still refused');
  } finally { relay.kill(); }
});

test('server (0.3.2 PIN, review B1): a pin file that exists but cannot be read is never "no PIN"', async () => {
  const fs = require('node:fs'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-pin-b1-')), file = path.join(dir, 'pin.txt');
  const port = 19500 + Math.floor(Math.random() * 90);
  let child = await startBridge(port, ['--pin-file=' + file, '--test-pin=' + TEST_PIN]);
  try {
    const token = await unlockFor(port);
    const good = fs.readFileSync(file, 'utf8'), torn = good.slice(0, good.length - 40);
    const status = () => pinPost(port, '/pin/status', {}, { headers: { 'X-ChartBridge-Unlock': token } });
    // torn after a good read: the copy in memory keeps open pages working; nothing offers or allows a new PIN
    fs.writeFileSync(file, torn);
    assert.deepEqual((await status()).json, { set: true, unlocked: true });
    assert.equal((await get(port, '/session', null, token)).status, 200);
    assert.equal((await pinPost(port, '/pin/set', { pin: '0000' })).status, 409);
    assert.equal((await pinPost(port, '/pin/unlock', { pin: TEST_PIN })).status, 200);
    assert.equal((await pinPost(port, '/pin/change', { pin: TEST_PIN, newPin: '0000' })).status, 503);
    assert.equal(fs.readFileSync(file, 'utf8'), torn, 'never written over');
    // unreadable (a directory where the file should be): the same
    fs.unlinkSync(file); fs.writeFileSync(file, good); await status();       // good again, then unreadable
    fs.unlinkSync(file); fs.mkdirSync(file);
    assert.deepEqual((await status()).json, { set: true, unlocked: true });
    fs.rmdirSync(file); fs.writeFileSync(file, torn);
    // a restarted bridge with a damaged file has no good copy: 503 everywhere, the file kept, and it recovers when readable
    child.kill(); await new Promise(r => setTimeout(r, 300));
    child = await startBridge(port, ['--pin-file=' + file]);
    const s503 = await status();
    assert.equal(s503.status, 503); assert.match(s503.json.reason, /pin\.txt/);
    for (const [p, b] of [['/pin/set', { pin: '0000' }], ['/pin/unlock', { pin: TEST_PIN }]]) assert.equal((await pinPost(port, p, b)).status, 503, p);
    assert.equal((await get(port, '/session', null, token)).status, 403);
    assert.equal(fs.readFileSync(file, 'utf8'), torn, 'never written over');
    assert.equal(JSON.parse((await get(port, '/diag')).body).pin.set, true);
    fs.writeFileSync(file, good);
    assert.deepEqual((await status()).json, { set: true, unlocked: true }, 'readable again: the old token works, no PIN typed');
    fs.unlinkSync(file);
    assert.deepEqual((await status()).json, { set: false, unlocked: false }, 'deleted: no PIN, at once');
  } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
