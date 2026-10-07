'use strict';
// The Account page and the Quote board's quote-only markets (chart 1.16.0, live/accounts.js; Anthony's spec, chart page
// section 1, items 14, 15 and 20): the formats, the limit percent, round trips with gross and net, the copier's rows, The
// Desk's rows, and the page's v3 messages (exactly the contract's, nothing with a switch off). Made-up accounts only
// (Sim101, EVAL-A, EVAL-B, FUNDED-C, SIM-F1, SIM-F2) and sample prices.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const AC = require('../live/accounts.js');
const W = require('../live/workspace.js');

/* ---------------- item 20: the Quote board */
test('32nds: whole points, an apostrophe, two digits of 32nds; ZN (tick 1/64) adds 0 or 5 for the half', () => {
  assert.equal(AC.fmt32(118.46875, 1 / 32), "118'15");          // ZB, Anthony's example
  assert.equal(AC.fmt32(104.109375, 1 / 64), "104'035");        // ZN, Anthony's example: 104 and 3.5/32
  assert.equal(AC.fmt32(104.125, 1 / 64), "104'040");
  assert.equal(AC.fmt32(104, 1 / 64), "104'000");
  assert.equal(AC.fmt32(118, 1 / 32), "118'00");
  assert.equal(AC.fmt32(118.03125, 1 / 32), "118'01");
  assert.equal(AC.fmt32(110.984375, 1 / 64), "110'315");        // 31.5/32
  assert.equal(AC.fmt32(112.5, 1 / 32), "112'16");
  assert.equal(AC.fmt32(-0.015625, 1 / 64), "-0'005");           // a change of half a 32nd
  assert.equal(AC.fmt32(0, 1 / 64), "0'000");
  assert.equal(AC.fmt32(104.109376, 1 / 64), "104'035", 'float noise is taken to the nearest 64th');
  assert.equal(AC.fmt32(NaN, 1 / 32), '');
});
test('quote prices: 32nds for priceFormat "32nds", else the tick\'s decimals with separators; changes signed', () => {
  const ZN = { root: 'ZN', tick: 0.015625, priceFormat: '32nds' }, ZB = { root: 'ZB', tick: 0.03125, priceFormat: '32nds' };
  assert.equal(AC.priceText(104.109375, ZN), "104'035");
  assert.equal(AC.priceText(118.46875, ZB), "118'15");
  assert.equal(AC.priceText(46210, { tick: 1, priceFormat: 'decimal' }), '46,210');           // YM
  assert.equal(AC.priceText(2251.3, { tick: 0.1, priceFormat: 'decimal' }), '2,251.3');        // RTY
  assert.equal(AC.priceText(31.005, { tick: 0.005, priceFormat: 'decimal' }), '31.005');       // SI
  assert.equal(AC.priceText(1.17255, { tick: 0.00005, priceFormat: 'decimal' }), '1.17255');   // 6E
  assert.equal(AC.priceText(74.01, { tick: 0.01 }), '74.01');                                    // CL, no priceFormat: decimal
  assert.equal(AC.changeText(0.140625, ZN), "+0'045");
  assert.equal(AC.changeText(-0.15625, ZB), "-0'05");
  assert.equal(AC.changeText(0, ZN), "0'000");
  assert.equal(AC.changeText(-12, { tick: 1 }), '-12');
  assert.equal(AC.changeText(null, ZN), '');
  assert.deepEqual([0.25, 0.1, 1, 0.005, 0.00005, 0.015625].map(AC.decimalsOf), [2, 1, 0, 3, 5, 6]);
});
test('Quote board rows: NQ and ES, then the quote-only markets hello lists, in Anthony\'s order; nothing else', () => {
  const hello = ['MNQ', 'NQ', 'MES', 'ES'].map(root => ({ root, quoteOnly: false }))
    .concat(['ZB', 'GC', 'YM', '6E', 'CL', 'ZN', 'RTY', 'SI'].map(root => ({ root, quoteOnly: true })));
  assert.deepEqual(AC.quoteRoots(hello, ['NQ', 'ES']), ['NQ', 'ES', 'YM', 'RTY', 'GC', 'SI', 'CL', '6E', 'ZN', 'ZB']);
  assert.deepEqual(AC.quoteRoots(hello.slice(0, 4), ['NQ', 'ES']), ['NQ', 'ES'], 'an older ChartBridge (no quote-only markets): NQ and ES only');
  assert.deepEqual(AC.quoteRoots({ ZB: { root: 'ZB', quoteOnly: true }, ZF: { root: 'ZF', quoteOnly: true }, YM: { root: 'YM', quoteOnly: 'yes' } }, ['NQ', 'ES']), ['NQ', 'ES', 'ZB', 'ZF'],
    'quoteOnly must be true; a quote-only market not in the list comes after');
  assert.deepEqual(W.QUOTE_ROOTS, ['NQ', 'ES']);
  assert.ok(!W.ROOTS.some(r => AC.QUOTE_ONLY.includes(r)), 'the order ticket and the charts never offer a quote-only market');
});

/* ---------------- item 15: the limit percent */
const A = o => Object.assign({ name: 'EVAL-A', pnlToday: 0, roomDrawdown: null, roomDailyLoss: null }, o);
test('limits: the room used to the closer of the daily loss and the trailing drawdown; amber at 70 percent, red at 90', () => {
  // ChartBridge reports both rooms, The Desk both limits: drawdown 600 of 2,000 left (70 percent used) is the closer
  let s = AC.limitState(A({ pnlToday: -300, roomDrawdown: 600, roomDailyLoss: 700 }), { daily_loss_limit: 1000, trailing_drawdown: 2000 });
  assert.equal(s.closer, 'dd'); assert.equal(Math.round(s.pct * 100), 70); assert.equal(s.level, 'amber');
  s = AC.limitState(A({ pnlToday: -300, roomDrawdown: 199, roomDailyLoss: 700 }), { daily_loss_limit: 1000, trailing_drawdown: 2000 });
  assert.equal(s.level, 'red'); assert.equal(s.closer, 'dd');
  s = AC.limitState(A({ pnlToday: -300, roomDrawdown: 1500, roomDailyLoss: 700 }), { daily_loss_limit: 1000, trailing_drawdown: 2000 });
  assert.equal(s.closer, 'dl'); assert.equal(Math.round(s.pct * 100), 30); assert.equal(s.level, '');
  // the daily loss from The Desk only: room = limit less today's loss
  s = AC.limitState(A({ pnlToday: -720 }), { daily_loss_limit: 1000 });
  assert.equal(s.dl.from, 'desk'); assert.equal(s.dl.room, 280); assert.equal(Math.round(s.pct * 100), 72); assert.equal(s.level, 'amber');
  s = AC.limitState(A({ pnlToday: -905 }), { daily_loss_limit: 1000 }); assert.equal(s.level, 'red');
  s = AC.limitState(A({ pnlToday: -699.99 }), { daily_loss_limit: 1000 }); assert.equal(s.level, '', 'under 70 percent');
  s = AC.limitState(A({ pnlToday: 250 }), { daily_loss_limit: 1000 }); assert.equal(s.pct, 0, 'a winning day uses none of the daily loss');
  // ChartBridge's daily room with no Desk limit: the limit is the room plus today's loss
  s = AC.limitState(A({ pnlToday: -800, roomDailyLoss: 200 }), null); assert.equal(s.dl.limit, 1000); assert.equal(s.level, 'amber');
  // a room at or below 0 is red whatever is known
  s = AC.limitState(A({ roomDrawdown: 0 }), null); assert.equal(s.level, 'red'); assert.equal(s.pct, 1);
  // the drawdown's room without its full limit: no percent of its own, the other's percent is used
  s = AC.limitState(A({ pnlToday: -750, roomDrawdown: 200 }), { daily_loss_limit: 1000 });
  assert.equal(s.closer, 'dd'); assert.equal(s.dd.pct, null); assert.equal(Math.round(s.pct * 100), 75); assert.equal(s.level, 'amber');
  // The Desk's trailing drawdown alone: no room (no high-water mark), never estimated
  s = AC.limitState(A({ pnlToday: -500 }), { trailing_drawdown: 2000 }); assert.equal(s.dd.room, null); assert.equal(s.pct, null); assert.equal(s.level, '');
  s = AC.limitState(A({}), null); assert.equal(s.level, ''); assert.equal(s.dl, null); assert.equal(s.dd, null);
  assert.equal(AC.limitText(AC.limitState(A({ pnlToday: -300, roomDrawdown: 600, roomDailyLoss: 700 }), { daily_loss_limit: 1000, trailing_drawdown: 2000 })), 'DD $600.00 · DL $700.00 (70% used)');
  assert.equal(AC.AMBER, 0.7); assert.equal(AC.RED, 0.9);
});

/* ---------------- item 14: Today's trades */
const PV = r => ({ MNQ: 2, NQ: 20, ES: 50, MES: 5 }[r] || 0);
const DAY = 20368 * 86400;          // a trading day, bar time (New York wall clock as seconds)
const f = (id, root, side, qty, p, hhmm, account) => ({ id, account: account || 'EVAL-A', root, side, qty, p, t: DAY + hhmm });
test('round trips: flat to flat by average price, gross dollars, every contract counted for commission', () => {
  const fills = [f('a', 'MNQ', 'buy', 2, 25000, 34200), f('b', 'MNQ', 'buy', 1, 25003, 34260), f('c', 'MNQ', 'sell', 2, 25010, 34500), f('d', 'MNQ', 'sell', 1, 25004, 34560)];
  const t = AC.roundTrips(fills, PV, {});
  assert.equal(t.length, 1);
  assert.equal(t[0].side, 'long'); assert.equal(t[0].qty, 3); assert.equal(t[0].entry, 25001); assert.equal(t[0].exit, 25008);
  assert.equal(t[0].gross, 42);                                  // (25008 - 25001) * 3 * $2
  assert.equal(t[0].contracts, 6); assert.equal(t[0].open, false); assert.equal(t[0].closeT, DAY + 34560);
  assert.equal(AC.netOf(t[0], r => (r === 'MNQ' ? 0.62 : null)), 38.28);            // 42 - 6 x 0.62
  assert.equal(AC.netOf(t[0], null), null, 'no commission from The Desk: no net');
  assert.equal(AC.netOf(t[0], () => null), null);
  // a short, then a fill that turns the position: two trips, the turning fill's contracts split
  const t2 = AC.roundTrips([f('a', 'NQ', 'sell', 1, 25010, 34200), f('b', 'NQ', 'buy', 3, 25000, 34300), f('c', 'NQ', 'sell', 2, 25005, 34400)], PV, {});
  assert.equal(t2.length, 2);
  assert.equal(t2[0].side, 'short'); assert.equal(t2[0].gross, 200); assert.equal(t2[0].contracts, 2);
  assert.equal(t2[1].side, 'long'); assert.equal(t2[1].qty, 2); assert.equal(t2[1].gross, 200); assert.equal(t2[1].contracts, 4);
  // a position from before today: its first trip's price is unknown (gross null), never guessed
  const t3 = AC.roundTrips([f('a', 'MNQ', 'sell', 1, 25010, 34200)], PV, { MNQ: 1 });
  assert.equal(t3[0].gross, null); assert.equal(t3[0].open, false);
  // still open: the closed part so far
  const t4 = AC.roundTrips([f('a', 'ES', 'buy', 2, 6000, 34200), f('b', 'ES', 'sell', 1, 6002, 34300)], PV, {});
  assert.equal(t4[0].open, true); assert.equal(t4[0].gross, 100); assert.equal(t4[0].closeT, null);
});
test('Today\'s trades: per account (from 18:00 ET), gross and net side by side, the session date for The Desk\'s Review', () => {
  const fills = [
    f('a', 'MNQ', 'buy', 1, 25000, 34200), f('b', 'MNQ', 'sell', 1, 25005, 34300),
    f('c', 'MNQ', 'sell', 1, 25010, 35000), f('d', 'MNQ', 'buy', 1, 25012, 35100),
    f('e', 'ES', 'buy', 1, 6000, 36000, 'Sim101'), f('g', 'ES', 'sell', 1, 6001, 36100, 'Sim101'),
    f('old', 'MNQ', 'buy', 1, 24000, -86400 + 34200),              // yesterday: not today's
    f('eve', 'MNQ', 'buy', 1, 25000, -86400 + 65000), f('eve2', 'MNQ', 'sell', 1, 25001, -86400 + 65100),   // 18:03 the evening before: today's session
  ];
  const rate = acct => (acct === 'EVAL-A' ? r => ({ MNQ: 0.5 }[r] ?? null) : null);
  const g = AC.tradesToday(fills, DAY + 40000, PV, () => 0, rate);
  assert.deepEqual(g.map(x => x.account), ['EVAL-A', 'Sim101']);
  const a = g[0];
  assert.equal(a.trips.length, 3, 'the evening trip belongs to this session');
  assert.equal(a.gross, 10 - 4 + 2);                              // +$10, -$4, +$2
  assert.equal(a.net, 8 - 3 * 2 * 0.5);
  assert.equal(a.trips[0].openT, DAY + 35000, 'newest first');
  assert.equal(a.fills.length, 6); assert.ok(!a.fills.some(x => x.id === 'old'));
  assert.equal(a.day, AC.dayText(AC.tradeDayOf(DAY + 40000)));
  assert.equal(g[1].gross, 50); assert.equal(g[1].net, null, 'no commission for Sim101: net is not shown');
  // the position now tells the start: long 1 now after one buy today means flat before
  const g2 = AC.tradesToday([f('a', 'MNQ', 'buy', 1, 25000, 34200)], DAY + 40000, PV, () => 1, null);
  assert.equal(g2[0].trips[0].open, true); assert.equal(g2[0].trips[0].entry, 25000);
  const g3 = AC.tradesToday([f('a', 'MNQ', 'sell', 1, 25000, 34200)], DAY + 40000, PV, () => 0, null);
  assert.equal(g3[0].trips[0].gross, null, 'flat now after a sell: it was long 1 from before, P&L unknown');
  assert.equal(AC.reviewUrl('http://localhost:8800/', '2026-10-07'), 'http://localhost:8800/#/futures/review/2026-10-07');
  assert.equal(AC.reviewUrl('javascript:alert(1)', '2026-10-07'), 'http://localhost:8800/#/futures/review/2026-10-07', 'only an http(s) Desk address');
});
test('The Desk\'s rows (GET /api/chart-accounts): numbers above 0 or null, the optional commission per root; bad shapes give none', () => {
  const m = AC.cleanDesk({ accounts: [
    { account: 'EVAL-A', firm: 'Firm A', archived: false, daily_loss_limit: 1000, trailing_drawdown: 2000, account_size: 50000, source: {}, commission: { MNQ: 0.62, NQ: 1.84, bad: 3, ES: -1 } },
    { account: 'EVAL-B', daily_loss_limit: null, trailing_drawdown: 'x', archived: true }, { account: '' }, null, 7] });
  assert.deepEqual([...m.keys()], ['EVAL-A', 'EVAL-B']);
  assert.deepEqual(m.get('EVAL-A').commission, { MNQ: 0.62, NQ: 1.84 });
  assert.equal(m.get('EVAL-B').daily_loss_limit, null); assert.equal(m.get('EVAL-B').trailing_drawdown, null);
  assert.equal(m.get('EVAL-B').archived, true); assert.equal(m.get('EVAL-B').commission, null);
  for (const bad of [null, {}, { accounts: 'x' }, []]) assert.equal(AC.cleanDesk(bad).size, 0);
});

/* ---------------- the copier's rows */
test('Copier rows: every Sim account but the leader (a saved follower\'s settings, else off), never a real account to send', () => {
  const accounts = [{ name: 'EVAL-A', sim: false }, { name: 'SIM-F1', sim: true, connection: 'connected' }, { name: 'SIM-F2', sim: true }, { name: 'Sim101', sim: true }];
  const copier = { leader: { account: 'Sim101' }, followers: [{ account: 'SIM-F2', sim: true, on: true, qty: 3, size: 'mini', lossLimit: 500, root: 'NQ', skipped: 'position limit', slippageTicks: 2 },
    { account: 'EVAL-B', sim: false, on: true, qty: 1, size: 'micro', lossLimit: null }] };
  const rows = AC.followerRows(accounts, copier);
  assert.deepEqual(rows.map(r => r.account), ['EVAL-B', 'SIM-F1', 'SIM-F2']);
  assert.deepEqual(['on', 'qty', 'size', 'lossLimit'].map(k => rows[1][k]), [false, 1, 'micro', null], 'a Sim account not yet a follower: off, 1, micro, no loss limit');
  assert.deepEqual(['on', 'qty', 'size', 'lossLimit', 'skipped', 'slippageTicks'].map(k => rows[2][k]), [true, 3, 'mini', 500, 'position limit', 2]);
  assert.equal(rows[0].sim, false); assert.match(rows[0].skipped, /not a Sim account/);
  assert.ok(!rows.some(r => r.account === 'Sim101'), 'the leader is never a follower');
  assert.ok(!rows.some(r => r.account === 'EVAL-A'), 'a real account is not offered');
  const ok = AC.followerMessage({ account: 'SIM-F1', on: true, qty: 2, size: 'micro', lossLimit: null }, 'c1');
  assert.deepEqual(ok.msg, { type: 'copierFollower', cid: 'c1', account: 'SIM-F1', on: true, qty: 2, size: 'micro', lossLimit: null });
  assert.deepEqual(AC.followerMessage({ account: 'SIM-F1', on: false, qty: 9, size: 'mini', lossLimit: '750' }).msg.lossLimit, 750);
  for (const bad of [{ qty: 0 }, { qty: 10 }, { qty: 1.5 }, { size: 'big' }, { lossLimit: 0 }, { lossLimit: 12.5 }, { lossLimit: 'x' }])
    assert.ok(AC.followerMessage(Object.assign({ account: 'SIM-F1', on: true, qty: 1, size: 'micro', lossLimit: null }, bad)).error, JSON.stringify(bad));
});

/* ---------------- the Log and orders */
test('Log lines and order names', () => {
  assert.equal(AC.accountChange({ name: 'EVAL-B', state: 'active', connection: 'connected', trade: true }, { name: 'EVAL-B', state: 'gone', goneWhy: 'disconnected', connection: 'lost', trade: false }),
    'EVAL-B: gone (disconnected): trading is off for it');
  assert.equal(AC.accountChange({ name: 'EVAL-A', state: 'active', connection: 'connected', trade: false }, { name: 'EVAL-A', state: 'active', connection: 'connected', trade: true }), 'EVAL-A: checked for trading');
  assert.equal(AC.accountChange(null, { name: 'EVAL-A' }), null);
  assert.equal(AC.logText({ type: 'reject', cid: 'c1', reason: 'Merge is refused.' }), 'Refused by ChartBridge: Merge is refused.');
  assert.equal(AC.logText({ type: 'copierEvent', account: 'SIM-F1', action: 'enter', text: 'entered 3 MNQ at market', slippageTicks: 2, leaderMs: 14, fillMs: 61 }),
    'Copier SIM-F1: entered 3 MNQ at market (slippage 2 t) (14 ms from the leader, filled in 61 ms)');
  assert.equal(AC.logText({ type: 'status', level: 'warn', text: 'EVAL-B is gone' }), 'Warning: EVAL-B is gone');
  assert.equal(AC.logText({ type: 'tick' }), null);
  assert.equal(AC.orderName({ side: 'buy', kind: 'limit', role: 'entry' }), 'Buy limit');
  assert.equal(AC.orderName({ side: 'sell', kind: 'stop', role: 'stop', by: 'strategy' }), 'Sell stop · strategy');
  assert.equal(AC.orderName({ side: 'sell', kind: 'limit', role: 'target' }), 'Sell target');
  assert.equal(AC.orderName({ side: 'buy', kind: 'stopLimit', role: 'entry', by: 'copier' }), 'Buy stop limit · copier');
  const legs = AC.attachedLegs([{ account: 'EVAL-A', root: 'MNQ', role: 'stop', state: 'working', price: 24980 }, { account: 'EVAL-A', root: 'MNQ', role: 'target', state: 'working', price: 25020 },
    { account: 'EVAL-A', root: 'MNQ', role: 'target', state: 'filled', price: 25010 }, { account: 'EVAL-B', root: 'MNQ', role: 'stop', state: 'working', price: 1 }], 'EVAL-A', 'MNQ');
  assert.deepEqual(legs, { stop: [24980], target: [25020] });
});

/* ---------------- the page's messages: exactly the contract's; nothing with a switch off */
async function loadFeed() {
  const file = require.resolve('../live/accounts.js');
  delete require.cache[file];
  const core = require(file);
  const sent = [], socks = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 1; socks.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
    send(t) { sent.push(JSON.parse(t)); }
    close() { this.readyState = 3; }
    deliver(m) { this.onmessage({ data: JSON.stringify(m) }); }
  }
  const saved = { window: global.window, document: global.document, WebSocket: global.WebSocket };
  global.window = { AccountsCore: core }; global.document = {}; global.WebSocket = FakeSocket;
  delete require.cache[file];
  require(file);
  const page = global.window.AccountsPage;
  Object.assign(global, saved);
  for (const k of Object.keys(saved)) if (saved[k] === undefined) delete global[k];
  const notes = [];
  const fetches = [];
  const viaOrders = [];                                   // what went on the order ticket's connection (env.orderSend)
  const feed = page.createFeed({
    wsUrl: () => 'ws://localhost:8765/ws', pin: null, framed: false, changed: () => {}, note: t => notes.push(t),
    orderSend: m => { viaOrders.push(m); sent.push(m); return true; },
    fetch: u => { fetches.push(u); return Promise.resolve(u === '/session' ? { ok: true, text: () => Promise.resolve('{"token":"tok"}') }
      : u === '/diag' ? { ok: true, json: () => Promise.resolve({ desk: { deskUrl: 'http://localhost:8800' } }) }
      : { ok: true, json: () => Promise.resolve({ accounts: [{ account: 'EVAL-A', daily_loss_limit: 1000, trailing_drawdown: 2000 }] }) }); },
  });
  return { feed, page, sent, socks, notes, fetches, viaOrders, FakeSocket, settle: () => new Promise(r => setTimeout(r, 5)) };
}
test('the Account page\'s connection: client v3 right after hello, then auth; its actions are exactly the contract\'s messages', async () => {
  const V = await import('./fake-v3.mjs');
  const F = await loadFeed();
  const G = global.WebSocket; global.WebSocket = F.FakeSocket;
  try {
    F.feed.start(['liveFirst', 'v3']);
    await F.settle();
    assert.equal(F.socks.length, 1);
    const s = F.socks[0];
    s.deliver({ type: 'hello', version: '0.4.0', instruments: [{ root: 'MNQ', tick: 0.25, pointValue: 2, quoteOnly: false, priceFormat: 'decimal' }], features: ['v3'] });
    await F.settle();
    assert.deepEqual(F.sent[0], { type: 'client', v: 3 }, 'client first, right after hello');
    assert.deepEqual(F.sent[1], { type: 'auth', token: 'tok' });
    assert.ok(F.fetches.includes('/diag') && F.fetches.includes('http://localhost:8800/api/chart-accounts'), 'The Desk\'s limits, at the address ChartBridge knows');
    assert.equal(F.feed.S.desk.get('EVAL-A').daily_loss_limit, 1000);
    // every switch off (the default): no message at all
    s.deliver({ type: 'trading', enabled: true, accounts: ['Sim101'], maxQty: {}, switches: { accountChecks: false, orderTypes: false, strategies: false, merge: false, cancelFromList: false, copier: false, bot: false } });
    F.sent.length = 0;
    const tryAll = () => [F.feed.accountTrade('EVAL-A', true), F.feed.accountArchive('EVAL-B'), F.feed.cancelFromList('o14'), F.feed.copierSet({ mode: 'orders' }),
      F.feed.copierFollower({ account: 'SIM-F1', on: true, qty: 1, size: 'micro', lossLimit: null }), F.feed.copierRearm()];
    assert.ok(tryAll().every(x => !x)); assert.equal(F.sent.length, 0, 'with every switch off nothing is sent');
    // a switch not strictly true is off
    s.deliver({ type: 'trading', enabled: true, accounts: [], maxQty: {}, switches: { accountChecks: 'true', cancelFromList: 1, copier: null } });
    assert.ok(tryAll().every(x => !x)); assert.equal(F.sent.length, 0);
    // trading off (not signed in): switches mean nothing
    s.deliver({ type: 'trading', enabled: false, reason: 'off', switches: { accountChecks: true, cancelFromList: true, copier: true } });
    assert.ok(tryAll().every(x => !x)); assert.equal(F.sent.length, 0);
    // every switch on: each action is one message with the contract's keys only (gate 8 extended, the fake's checker)
    s.deliver({ type: 'trading', enabled: true, accounts: [], maxQty: {}, switches: { accountChecks: true, orderTypes: true, strategies: true, merge: true, cancelFromList: true, copier: true, bot: true } });
    assert.ok(tryAll().every(Boolean));
    assert.deepEqual(F.sent.map(m => m.type), ['accountTrade', 'accountArchive', 'cancel', 'copierSet', 'copierFollower', 'copierRearm']);
    for (const m of F.sent) assert.equal(V.checkKeysV3(m, JSON.stringify(m)), null, JSON.stringify(m));
    assert.equal(F.sent[1].confirm, true, 'Archive always carries confirm: true (sent only after the page\'s own confirm)');
    assert.equal(F.sent[2].from, 'list');
    assert.deepEqual(F.viaOrders, [F.sent[2]], 'cancel from the list goes on the order ticket\'s connection (the one order path), nothing else does');
    // its refusal comes back on that connection: the host hands it here (takeReject), said in the window and the Log
    F.notes.length = 0;
    assert.equal(F.feed.takeReject({ type: 'reject', cid: F.sent[2].cid, reason: 'No working order o14.' }), true);
    assert.deepEqual(F.notes, ['Refused by ChartBridge: No working order o14.']);
    assert.equal(F.feed.takeReject({ type: 'reject', cid: 'someone-else', reason: 'x' }), false, 'another part\'s refusal is not taken');
    assert.ok(F.sent.every(m => typeof m.cid === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(m.cid)));
    // a refusal of the page's own message: the window's note and the Log
    F.notes.length = 0;
    s.deliver({ type: 'reject', cid: F.sent[3].cid, reason: 'The leader has a position.' });
    assert.deepEqual(F.notes, ['Refused by ChartBridge: The leader has a position.']);
    assert.match(F.feed.S.log[0].text, /The leader has a position/);
    // accounts: the limit level of an account (EVAL-A: The Desk's daily loss 1,000; 905 lost today)
    s.deliver({ type: 'accounts', list: [{ name: 'EVAL-A', sim: false, connection: 'connected', trade: true, tradable: true, state: 'active', pnlToday: -905, roomDrawdown: null, roomDailyLoss: null, positions: [] }], archived: [] });
    assert.equal(F.feed.level('EVAL-A'), 'red'); assert.equal(F.feed.level('NOPE'), '');
    s.deliver({ type: 'accounts', list: [{ name: 'EVAL-A', sim: false, connection: 'lost', trade: false, tradable: false, state: 'gone', goneWhy: 'disconnected', pnlToday: -100, positions: [] }], archived: [] });
    assert.match(F.feed.S.log[0].text, /EVAL-A: gone \(disconnected\)/);
    // a dropped connection: the controls go until ChartBridge names the switches again; the other parts are told
    const heard = [];
    const off = F.feed.listen({ message: m => heard.push(m.type), closed: () => heard.push('(closed)') });
    s.deliver({ type: 'bot', enabled: true });
    assert.equal(F.feed.post({ type: 'botKill', cid: 'b1', on: true }), true, 'another part posts on the same connection');
    assert.deepEqual(F.sent[F.sent.length - 1], { type: 'botKill', cid: 'b1', on: true });
    s.onclose();
    assert.ok(Object.values(F.feed.S.switches).every(x => x === false));
    assert.deepEqual(heard, ['bot', '(closed)']);
    assert.equal(F.feed.post({ type: 'botKill', cid: 'b2', on: true }), false, 'nothing sent while closed');
    off();
  } finally { F.feed.stop(); global.WebSocket = G; if (G === undefined) delete global.WebSocket; }
});
test('an older ChartBridge (hello without "v3"): no connection is opened, the page says what it needs', async () => {
  const F = await loadFeed();
  F.feed.start(['liveFirst', 'profile', 'settlement', 'htf', 'weekProfile']);
  await F.settle();
  assert.equal(F.socks.length, 0);
  assert.equal(F.feed.S.v3, false); assert.match(F.feed.S.reason, /ChartBridge 0\.4\.0 or newer/);
  F.feed.stop();
});

/* ---------------- the page's files and rules */
test('the Account page is a workspace panel: its type, the Add menu, its files installed, no motion on it', () => {
  assert.ok(W.TYPES.includes('accounts'));
  assert.deepEqual(W.cleanPanel({ id: 'ap1', type: 'accounts', x: 0, y: 0, w: 6, h: 3 }), { id: 'ap1', type: 'accounts', x: 0, y: 0, w: 6, h: 3 });
  const html = read('live/index.html');
  assert.match(html, /data-add="accounts">Account page</);
  assert.ok(html.indexOf('src="accounts.js"') > 0 && html.indexOf('src="accounts.js"') < html.indexOf('src="workspace.js"'));
  assert.match(html, /href="accounts\.css"/);
  const www = JSON.parse(read('nt8/install-files.json')).www.map(x => x.from);
  assert.ok(www.includes('live/accounts.js') && www.includes('live/accounts.css'));
  // R3: order surfaces, the Accounts warnings and the copier stay instant
  const js = read('live/accounts.js'), css = read('live/accounts.css');
  assert.doesNotMatch(js, /ChartMotion|requestAnimationFrame|\.animate\(/);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\.apg, \.apg \*, \.ws-limit \{ transition: none !important; animation: none !important; \}$/m, ''), /transition|animation|@keyframes/);
  assert.match(css, /^\.apg, \.apg \*, \.ws-limit \{ transition: none !important; animation: none !important; \}$/m);
  // no account names but the made-up ones, no dashes Anthony reads
  for (const t of [js, css]) assert.doesNotMatch(t, /[–—]/);
  // the order ticket's connection stays v2: only the Account page's own connection sends client v3
  const ws = read('live/workspace.js'), trade = read('live/trade.js'), bot = read('live/bot.js');
  assert.doesNotMatch(ws + trade + bot, /type: 'client'/);
  assert.match(js, /sock\.send\(JSON\.stringify\(\{ type: 'client', v: 3 \}\)\)/);
  // one v3 connection per window, shared: the Bot tab opens no WebSocket of its own, and gets the workspace's one
  assert.doesNotMatch(bot, /new WebSocket\(/);
  assert.match(ws, /window\.BotDesk\.create\(\{ v3: AF,/);
  assert.match(read('live/bot.html'), /src="accounts\.js"/);
  // one source for The Desk's address: ChartBridge's deskUrl (/diag), nothing kept per browser
  for (const t of [ws, bot, read('live/order-strategies.js')]) assert.doesNotMatch(t, /live-desk-url-v1/);
});
