'use strict';
// Protocol v3 (ChartBridge 0.4.0, nt8/PROTOCOL.md "Protocol v3"): the fake's reference behaviour (test/fake-v3.mjs), the
// fixtures (test/fixtures/protocol-v3.json) and the fake server's --v3. Made-up accounts and a made-up bot only.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'protocol-v3.json'), 'utf8'));
const INSTR = { MNQ: { name: 'MNQ 12-26', tick: 0.25, pointValue: 2 }, NQ: { name: 'NQ 12-26', tick: 0.25, pointValue: 20 },
  YM: { name: 'YM 12-26', tick: 1, pointValue: 5, quoteOnly: true, priceFormat: 'decimal', decimals: 0 } };
const ALL_ON = { accountChecks: true, orderTypes: true, strategies: true, merge: true, cancelFromList: true, copier: true, bot: true };

async function makeDesk(o) {
  o = o || {};
  const V = await import('./fake-v3.mjs');
  let clock = 1000000;
  const out = [];
  const conn = { origin: 'http://localhost:8765', authed: false, actions: [], v3: true };
  const desk = new V.OrderDeskV3({
    config: Object.assign({ trading: true, tradeAccounts: ['Sim101', 'EVAL-A'], maxQty: { MNQ: 5, NQ: 2 }, port: 8765 }, o.config || {}),
    instruments: INSTR, knownAccounts: V.V3_ACCOUNTS.map(a => a.name), token: 'tok', switches: Object.assign({}, ALL_ON, o.switches || {}),
    accountList: V.V3_ACCOUNTS, graceMs: 1000, send: (c, m) => out.push(m), conns: () => [conn], now: () => clock, barTime: () => clock / 1000,
  });
  desk.tick('MNQ', 25400); desk.tick('NQ', 25400); desk.tick('YM', 46200);
  desk.auth(conn, 'tok'); out.length = 0;
  const d = {
    V, desk, conn, out,
    advance(ms) { clock += ms; },
    take(type) { const r = out.filter(m => !type || m.type === type); out.length = 0; return r; },
    act(m) { clock += 150; desk.handle(conn, m, JSON.stringify(m)); return d.take(); },
    order(f) { return d.act(Object.assign({ type: 'order', cid: 'c' + Math.random().toString(36).slice(2, 7), account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'market', qty: 1 }, f)); },
    tick(p, root) { clock += 600; desk.tick(root || 'MNQ', p); return d.take(); },
    working(account) { return [...desk.orders.values()].filter(x => (x.state === 'working' || x.state === 'partFilled') && (!account || x.account === account)); },
  };
  return d;
}
const reasonOf = msgs => { const r = msgs.find(m => m.type === 'reject'); return r ? r.reason : null; };

test('allocation: largest remainder, a tie to the later target, never more than q; bond formats', async () => {
  const { allocate, formatPrice } = await import('./fake-v3.mjs');
  assert.deepEqual(allocate(3, [33, 33, 34]), [1, 1, 1]);
  assert.deepEqual(allocate(1, [50, 50]), [0, 1]);
  assert.deepEqual(allocate(5, [50, 30, 20]), [2, 2, 1]);
  assert.deepEqual(allocate(2, [34, 33, 33]), [1, 0, 1]);
  for (let q = 1; q <= 20; q++) assert.equal(allocate(q, [20, 30, 50]).reduce((a, b) => a + b, 0), q);
  assert.equal(formatPrice(104.109375, '32nds', 1 / 64), "104'035");    // ZN: half 32nds with a 1/64 tick
  assert.equal(formatPrice(104.125, '32nds', 1 / 64), "104'040");
  assert.equal(formatPrice(118.46875, '32nds', 1 / 32), "118'15");      // ZB
  assert.equal(formatPrice(1.17255, 'decimal', 0.00005), '1.17255');
});

test('fixtures: every page message passes the strict v3 keys; every strategy passes its rules; both directions present', async () => {
  const { checkKeysV3, checkStrategy, BOT_KEYS } = await import('./fake-v3.mjs');
  for (const [name, m] of Object.entries(FIX.pageToServer)) {
    assert.equal(checkKeysV3(m, JSON.stringify(m)), null, name);
    if (m.strategy) assert.equal(checkStrategy(m.strategy, 0), null, name);
  }
  for (const [name, m] of Object.entries(FIX.botToServer)) for (const k of Object.keys(m)) assert.ok(BOT_KEYS[m.type].includes(k), name + ' ' + k);
  for (const t of ['accounts', 'managed', 'merge', 'copier', 'copierEvent', 'bot', 'botSignal', 'botProposal'])
    assert.ok(Object.values(FIX.serverToPage).some(m => m.type === t), 'serverToPage has ' + t);
  for (const t of ['welcome', 'tick', 'botState', 'answer', 'reject']) assert.ok(Object.values(FIX.serverToBot).some(m => m.type === t), 'serverToBot has ' + t);
  const text = JSON.stringify(FIX);
  assert.doesNotMatch(text, /[–—]/, 'no en or em dashes');
  // as ChartBridge 0.4.0 built it ("0.4.0 hardening and markets" wins): quoteOnly and priceFormat after pointValue, before
  // the settlement; no tapeStats switch; /diag's health, pages, markets and tape
  for (const i of FIX.serverToPage['hello.v3'].instruments) {
    assert.deepEqual(Object.keys(i).slice(0, 6), ['root', 'name', 'tick', 'pointValue', 'quoteOnly', 'priceFormat'], i.root);
    assert.ok(['decimal', '32nds'].includes(i.priceFormat) && !('format' in i) && !('decimals' in i), i.root);
    assert.equal(i.priceFormat === '32nds', i.root === 'ZN' || i.root === 'ZB', i.root);
  }
  // the bot's welcome as ChartBridgeBot.cs WelcomeJson builds it: its own root only, five fields
  assert.deepEqual(FIX.serverToBot.welcome.instruments.map(i => Object.keys(i)), [['root', 'name', 'tick', 'pointValue', 'quoteOnly']]);
  assert.ok(!('tapeStats' in FIX.config) && !FIX.serverToPage['hello.v3'].features.includes('quoteOnly'));
  assert.deepEqual(Object.keys(FIX.diag).slice(0, 4), ['health', 'pages', 'markets', 'tape']);
});

test('strict v3 keys: unknown keys, a list, booleans where none belong and bracket with strategy are refused', async () => {
  const d = await makeDesk();
  assert.match(reasonOf(d.act({ type: 'accountTrade', account: 'EVAL-A', on: 'yes' })), /on must be true or false/);
  assert.match(reasonOf(d.act({ type: 'accountTrade', account: 'EVAL-A', on: true, extra: 1 })), /Unknown key "extra"/);
  assert.match(reasonOf(d.act({ type: 'merge', account: 'Sim101', root: ['MNQ'] })), /nested object or list/);
  assert.match(reasonOf(d.order({ qty: true })), /cannot be true or false/);
  assert.match(reasonOf(d.order({ bracket: { stop: 8, target: 8 }, strategy: { name: 'x', stop: 8 } })), /bracket or a strategy, not both/);
  assert.match(reasonOf(d.order({ strategy: { name: 'x', stop: 8, nested: { a: 1 } } })), /Unknown key "nested" in strategy/);
});

test('accounts: tradeAccounts pre-checked on first start; checkmarks gate entries; exits always work; Gone after the grace', async () => {
  const d = await makeDesk();
  assert.deepEqual(d.desk.accounts.sort(), ['EVAL-A', 'Sim101']);
  assert.match(reasonOf(d.order({ account: 'EVAL-B' })), /not checked for trading/);
  d.act({ type: 'accountTrade', account: 'EVAL-B', on: true });
  assert.ok(d.desk.accounts.includes('EVAL-B'));
  d.order({ account: 'EVAL-B' });
  assert.equal(d.desk.pos('EVAL-B', 'MNQ').qty, 1);
  d.act({ type: 'accountTrade', account: 'EVAL-B', on: false });
  assert.match(reasonOf(d.order({ account: 'EVAL-B' })), /not checked/);
  assert.equal(reasonOf(d.act({ type: 'flatten', account: 'EVAL-B', root: 'MNQ' })), null, 'Flatten on an unchecked account still works');
  assert.equal(d.desk.pos('EVAL-B', 'MNQ').qty, 0);
  // Gone: lost for the grace, then entries wait and a warning; the checkmark is kept (0.4.2)
  d.desk.setConnection('EVAL-A', 'lost'); d.take();
  d.advance(500); d.desk.checkGone();
  assert.equal(d.desk.acct.get('EVAL-A').state, 'active', 'still inside the grace');
  d.advance(600); d.desk.checkGone();
  const a = d.desk.acct.get('EVAL-A');
  assert.equal(a.state, 'gone'); assert.equal(a.trade, true); assert.equal(a.goneWhy, 'disconnected');
  assert.equal(d.desk.accountsMsg().list.find(x => x.name === 'EVAL-A').tradable, false, 'Gone: not tradable');
  assert.match(d.take('status')[0].text, /EVAL-A is gone \(disconnected for 1 s\): entries wait until it is back; its checkmark is kept/);
  assert.match(reasonOf(d.order({ account: 'EVAL-A' })), /gone: entries wait until it is back/);
  assert.match(reasonOf(d.act({ type: 'accountTrade', account: 'EVAL-A', on: true })), /gone/);
  d.desk.setConnection('EVAL-A', 'connected');
  assert.equal(d.desk.acct.get('EVAL-A').state, 'active'); assert.equal(d.desk.acct.get('EVAL-A').trade, true, 'back with its checkmark (0.4.2)');
  assert.ok(d.desk.accounts.includes('EVAL-A'), 'back: tradable again, nothing to tick');
  assert.match(d.take('status').pop().text, /EVAL-A is back \(connected\): its checkmark is kept/);
  // Hide (ChartBridge 0.5.1): any flat account that is not the bot's or the copier's, only with confirm
  assert.match(reasonOf(d.act({ type: 'accountArchive', account: 'Sim101', confirm: true })), /Sim101 is the bot's account \(the Bot tab\): it cannot be hidden/);
  assert.equal(d.desk.accountsMsg().list.find(x => x.name === 'Sim101').canHide, false);
  d.order({ account: 'EVAL-A', kind: 'limit', price: 25000 - 50 });
  assert.match(reasonOf(d.act({ type: 'accountArchive', account: 'EVAL-A', confirm: true })), /EVAL-A has a position or working orders: only a flat account can be hidden/);
  d.desk.setConnection('FUNDED-C', 'disabled'); d.advance(1100); d.desk.checkGone(); d.take();
  assert.match(reasonOf(d.act({ type: 'accountArchive', account: 'FUNDED-C', confirm: false })), /confirm: true/);
  d.act({ type: 'accountArchive', account: 'FUNDED-C', confirm: true });
  const msg = d.desk.accountsMsg();
  assert.ok(!msg.list.some(x => x.name === 'FUNDED-C')); assert.equal(msg.archived[0].name, 'FUNDED-C');
  assert.ok(d.desk.log.some(l => l.who === 'FUNDED-C' && /archived/.test(l.what)));
  // Show (0.5.1): back, active and unchecked
  assert.match(reasonOf(d.act({ type: 'accountUnarchive', account: 'EVAL-B' })), /EVAL-B is not archived/);
  assert.match(reasonOf(d.act({ type: 'accountUnarchive', account: 'FUNDED-C', confirm: true })), /Unknown key "confirm"/);
  assert.equal(reasonOf(d.act({ type: 'accountUnarchive', account: 'FUNDED-C' })), null);
  const shown = d.desk.accountsMsg().list.find(x => x.name === 'FUNDED-C');
  assert.ok(shown && shown.trade === false && shown.state === 'active' && !d.desk.accountsMsg().archived.length);
  d.act({ type: 'accountArchive', account: 'FUNDED-C', confirm: true });
  const acc = msg.list.find(x => x.name === 'Sim101');
  for (const k of ['sim', 'connection', 'trade', 'tradable', 'state', 'balance', 'pnlToday', 'positions', 'roomDrawdown', 'roomDrawdownWhy', 'roomDailyLoss', 'roomDailyLossWhy']) assert.ok(k in acc, k);
  assert.equal(acc.roomDailyLoss, null); assert.match(acc.roomDailyLossWhy, /does not report/);
});

test('accountChecks off: gate 2 is tradeAccounts and the checkmark is refused', async () => {
  const d = await makeDesk({ switches: { accountChecks: false } });
  assert.match(reasonOf(d.act({ type: 'accountTrade', account: 'EVAL-B', on: true })), /accountTrade is off/);
  assert.match(reasonOf(d.order({ account: 'EVAL-B' })), /not allowed to trade/);
});

test('order types: stop-limit (offset or price) and MIT, each on the grid and the right side; off by switch', async () => {
  const d = await makeDesk();
  d.order({ cid: 'sl', kind: 'stopLimit', price: 25402.5, limitOffset: 2 });
  const sl = d.working().find(o => o.cid === 'sl');
  assert.equal(sl.limitPrice, 25403);
  assert.match(reasonOf(d.order({ kind: 'stopLimit', price: 25398, limitOffset: 2 })), /buy stop must be above/);
  assert.match(reasonOf(d.order({ kind: 'stopLimit', price: 25402, limitOffset: 2, limitPrice: 25403 })), /exactly one of/);
  assert.match(reasonOf(d.order({ side: 'sell', kind: 'stopLimit', price: 25398, limitPrice: 25399 })), /limit must be at or below its stop/);
  assert.match(reasonOf(d.order({ kind: 'limit', price: 25399, limitOffset: 1 })), /stopLimit order only/);
  assert.match(reasonOf(d.order({ kind: 'mit', price: 25400 })), /trigger at once/);
  assert.match(reasonOf(d.order({ kind: 'mit', price: 25401 })), /buy limit above/);
  d.order({ cid: 'mit', kind: 'mit', price: 25399 });
  const mit = d.working().find(o => o.cid === 'mit');
  assert.equal(mit.kind, 'mit');
  d.tick(25399);
  assert.equal(mit.state, 'filled');
  d.tick(25403);                                          // the stop-limit triggers and fills inside its limit
  assert.equal(sl.state, 'filled');
  d.act({ type: 'change', id: d.working()[0] ? d.working()[0].id : 'none', price: 1 });
  const e = await makeDesk({ switches: { orderTypes: false } });
  assert.match(reasonOf(e.order({ kind: 'mit', price: 25399 })), /orderTypes = off in config.txt/);
});

test('quote-only roots: every order is refused with the plain reason', async () => {
  const d = await makeDesk();
  assert.equal(reasonOf(d.order({ root: 'YM' })), 'YM is quote only: ChartBridge shows its prices on the Quote board and refuses every order for it (quoteRoots in config.txt)');
  assert.equal(reasonOf(d.act({ type: 'flatten', account: 'Sim101', root: 'YM' })), 'YM is quote only: ChartBridge shows its prices on the Quote board and refuses every order for it (quoteRoots in config.txt)');
  assert.equal(reasonOf(d.act({ type: 'merge', account: 'Sim101', root: 'YM' })), 'YM is quote only: ChartBridge shows its prices on the Quote board and refuses every order for it (quoteRoots in config.txt)');
});

test('strategies: a pair per target bucket per fill, breakeven then trailing, never back; plan refused', async () => {
  const d = await makeDesk();
  const s = { name: 'Scalp 3T', stop: 16, t1: 8, t1Share: 34, t2: 16, t2Share: 33, t3: 32, t3Share: 33, beAfter: 8, bePlus: 1, trailAfter: 12, trailBy: 8, trailStep: 2 };
  const msgs = d.order({ cid: 'st', qty: 3, strategy: s });
  assert.equal(reasonOf(msgs), null);
  const legs = d.working('Sim101');
  assert.equal(legs.length, 6, '3 stops and 3 targets');
  const stops = legs.filter(o => o.role === 'stop');
  assert.deepEqual(stops.map(o => o.qty), [1, 1, 1]);
  assert.deepEqual(stops.map(o => o.price), [25396, 25396, 25396]);
  assert.deepEqual(legs.filter(o => o.role === 'target').map(o => o.price), [25402, 25404, 25408]);
  assert.equal(new Set(legs.map(o => o.oco)).size, 3, 'each bucket its own OCO pair');
  const x = [...d.desk.managed.values()][0];
  assert.equal(x.state, 'active');
  d.tick(25402);                                         // 8 ticks: breakeven at entry + 1 (T1 fills)
  assert.deepEqual(d.working('Sim101').filter(o => o.role === 'stop').map(o => o.price), [25400.25, 25400.25]);
  d.tick(25403);                                         // 12 ticks: the trail starts at best - 8 = 25401
  assert.deepEqual(d.working('Sim101').filter(o => o.role === 'stop').map(o => o.price), [25401, 25401]);
  d.tick(25403.25);                                      // one tick better: under the 2-tick step, no move
  assert.deepEqual(d.working('Sim101').filter(o => o.role === 'stop').map(o => o.price), [25401, 25401]);
  d.tick(25402);                                         // back down: the stop never moves back
  assert.deepEqual(d.working('Sim101').filter(o => o.role === 'stop').map(o => o.price), [25401, 25401]);
  assert.match(reasonOf(d.order({ qty: 1, strategy: { name: 'bad', stop: 8, t1: 8, t1Share: 60, t2: 16, t2Share: 30 } })), /add up to 90/);
  assert.match(reasonOf(d.order({ qty: 1, strategy: { name: 'bad', stop: 8, beAfter: 8 } })), /go together/);
  d.order({ cid: 'rest', kind: 'limit', price: 25390, qty: 1, strategy: { name: 'R', stop: 8 } });
  const rest = d.working('Sim101').find(o => o.cid === 'rest');
  assert.match(reasonOf(d.act({ type: 'plan', id: rest.id, stopTicks: 12 })), /cancel it and place it again/);
  d.desk.simulateRestart(true);
  assert.equal(x.state, 'unmanaged');
  assert.match(d.take('status')[0].text, /could not be resumed/);
});

test('merge: grows the first pair (one target); refused while an entry works or with the first stop through the market', async () => {
  const d = await makeDesk();
  d.order({ qty: 1, bracket: { stop: 8, target: 16 } });
  d.tick(25401);
  d.order({ qty: 1, bracket: { stop: 8, target: 16 } });
  d.advance(2100);
  d.order({ cid: 'w', kind: 'limit', price: 25380, qty: 1 });
  assert.match(reasonOf(d.act({ type: 'merge', cid: 'm0', account: 'Sim101', root: 'MNQ' })), /entry is working/);
  d.act({ type: 'cancel', id: d.working('Sim101').find(o => o.cid === 'w').id });
  const out = d.act({ type: 'merge', cid: 'm1', account: 'Sim101', root: 'MNQ' });
  const r = out.find(m => m.type === 'merge');
  assert.equal(r.result, 'merged');
  assert.deepEqual(r.stop, { price: 25398, qty: 2 });
  assert.deepEqual(r.targets, [{ price: 25404, qty: 2 }]);
  const legs = d.working('Sim101');
  assert.deepEqual(legs.map(o => [o.role, o.qty, o.price]), [['stop', 2, 25398], ['target', 2, 25404]]);
  assert.equal(d.desk.merges.ok, 1);
  assert.match(reasonOf(d.act({ type: 'merge', account: 'Sim101', root: 'MNQ' })), /1 stop and target pair/);
  // first stop through the market
  const e = await makeDesk();
  e.order({ qty: 1, bracket: { stop: 8, target: 16 } }); e.tick(25401); e.order({ qty: 1, bracket: { stop: 40, target: 16 } }); e.advance(2100);
  e.desk.last.MNQ = 25397;                                  // a trade below the first stop without filling it (the fake's matching is per trade)
  assert.match(reasonOf(e.act({ type: 'merge', account: 'Sim101', root: 'MNQ' })), /already through the market/);
});

test('merge with a 3-target strategy: one stop with no OCO, targets at the first leg\'s prices, the stop shrinks as targets fill', async () => {
  const d = await makeDesk();
  const s = { name: 'Three', stop: 16, t1: 8, t1Share: 34, t2: 16, t2Share: 33, t3: 32, t3Share: 33 };
  d.order({ qty: 1, strategy: s });                         // 1 contract: T3 only (the tie goes to the later target... 34/33/33 gives T1)
  d.tick(25399);
  d.order({ qty: 2, strategy: s });
  d.advance(2100);
  const r = d.act({ type: 'merge', account: 'Sim101', root: 'MNQ' }).find(m => m.type === 'merge');
  assert.equal(r.result, 'merged');
  assert.deepEqual(r.stop, { price: 25396, qty: 3 });
  assert.deepEqual(r.targets, [{ price: 25402, qty: 1 }, { price: 25404, qty: 1 }, { price: 25408, qty: 1 }]);
  const stops = d.working('Sim101').filter(o => o.role === 'stop');
  assert.equal(stops.length, 1); assert.equal(stops[0].oco, null); assert.equal(stops[0].qty, 3);
  d.tick(25402);                                           // T1 fills: the stop shrinks to 2
  assert.equal(stops[0].qty - stops[0].filled, 2);
  const f = await makeDesk();
  f.order({ qty: 1, bracket: { stop: 8, target: 16 } }); f.tick(25401); f.order({ qty: 1, bracket: { stop: 8, target: 16 } }); f.advance(2100);
  f.desk.do_merge({ account: 'Sim101', root: 'MNQ', cid: 'x' }, f.conn, 2);
  assert.equal(f.take('merge')[0].result, 'restored');
  assert.equal(f.working('Sim101').length, 4, 'the original brackets stay');
});

test('cancel from the Working orders tab: off by switch; on, any watched account (an exit action)', async () => {
  const d = await makeDesk({ switches: { cancelFromList: false } });
  const o = d.desk.placeElsewhere({ account: 'EVAL-B', root: 'MNQ', side: 'buy', kind: 'limit', qty: 1, price: 25390 });
  assert.match(reasonOf(d.act({ type: 'cancel', id: o.id, from: 'list' })), /cancelFromList/);
  const e = await makeDesk();
  const p = e.desk.placeElsewhere({ account: 'EVAL-B', root: 'MNQ', side: 'buy', kind: 'limit', qty: 1, price: 25390 });
  assert.equal(reasonOf(e.act({ type: 'cancel', id: p.id, from: 'list' })), null);
  assert.equal(p.state, 'cancelled');
});

test('switches (Anthony 2026-10-07: no switches): every v3 switch on by default; an off line (false) turns just that one off', async () => {
  const V = await import('./fake-v3.mjs');
  const base = { config: { trading: true, tradeAccounts: ['Sim101'], maxQty: {}, port: 8765 }, instruments: INSTR, knownAccounts: ['Sim101'], token: 'tok',
    accountList: [{ name: 'Sim101', sim: true }], send: () => {}, conns: () => [], now: () => 1, barTime: () => 1 };
  assert.deepEqual(new V.OrderDeskV3(base).sw, ALL_ON, 'no switches named: every one on');
  const off = new V.OrderDeskV3(Object.assign({}, base, { switches: { merge: false, copier: false } })).sw;
  assert.deepEqual(off, Object.assign({}, ALL_ON, { merge: false, copier: false }));
  const d = await makeDesk({ switches: { merge: false } });
  assert.match(reasonOf(d.act({ type: 'merge', account: 'Sim101', root: 'MNQ' })), /merge = off in config\.txt/);
});

test('copier: a real (not Sim) follower is copied through every gate; a leader entry gives each follower a market entry and a stop at the leader\'s stop price', async () => {
  const d = await makeDesk({ config: { maxQty: { MNQ: 5, NQ: 2 } } });
  assert.equal(reasonOf(d.act({ type: 'copierFollower', account: 'EVAL-A', on: false, qty: 1, size: 'micro', lossLimit: null })), null, 'a real account may be a follower (no Sim lock)');
  assert.equal(d.desk.copierMsg().simOnly, false);
  assert.equal(d.desk.copierMsg().followers.find(f => f.account === 'EVAL-A').sim, false, 'shown not Sim (the page marks it LIVE)');
  assert.match(reasonOf(d.act({ type: 'copierFollower', account: 'Sim101', on: true, qty: 1, size: 'micro', lossLimit: null })), /Sim101 is the bot's account/, 'the bot\'s account is never a follower');
  for (const n of ['SIM-F1', 'SIM-F2']) d.act({ type: 'accountTrade', account: n, on: true });
  d.act({ type: 'copierFollower', account: 'SIM-F1', on: true, qty: 3, size: 'micro', lossLimit: null });
  d.act({ type: 'copierFollower', account: 'SIM-F2', on: true, qty: 3, size: 'mini', lossLimit: null });
  d.order({ cid: 'L0', root: 'NQ', bracket: { stop: 8, target: 16 } });
  assert.equal(d.desk.pos('SIM-F1', 'MNQ').qty, 0, 'stood down after a start: nothing copied');
  d.act({ type: 'flatten', account: 'Sim101', root: 'NQ' });
  d.act({ type: 'copierRearm' });
  assert.equal(d.desk.copier.armed, true);
  assert.match(reasonOf(d.order({ root: 'NQ' })), /needs a stop on every leader entry/);
  d.order({ cid: 'L1', root: 'NQ', bracket: { stop: 8, target: 16 } });
  assert.equal(d.desk.pos('SIM-F1', 'MNQ').qty, 3);
  assert.equal(d.desk.pos('SIM-F2', 'NQ').qty, 0, 'SIM-F2 at its position limit (3 NQ over the cap of 2): skipped');
  assert.equal(d.desk.copier.followers.get('SIM-F2').skipped, 'position limit');
  const fstop = d.working('SIM-F1').find(o => o.role === 'stop');
  const lstop = d.working('Sim101').find(o => o.role === 'stop');
  assert.equal(fstop.price, lstop.price); assert.equal(fstop.qty, 3);
  // review 2 (ChartBridgeV3.OrderBy): a v3 page sees by "copier" on the follower's orders; the leader's own orders and a v2 page, none
  assert.equal(d.desk.orderMsg(fstop, true).by, 'copier'); assert.ok(!('by' in d.desk.orderMsg(fstop, false))); assert.ok(!('by' in d.desk.orderMsg(lstop, true)));
  d.act({ type: 'change', id: lstop.id, price: lstop.price + 1 });
  assert.equal(fstop.price, lstop.price, 'the follower stop moves with the leader\'s');
  d.tick(25404, 'NQ');                                   // the leader's target fills: followers flat (never cross zero)
  assert.equal(d.desk.pos('Sim101', 'NQ').qty, 0);
  assert.equal(d.desk.pos('SIM-F1', 'MNQ').qty, 0);
  assert.equal(d.working('SIM-F1').length, 0);
  // a real follower that is on and tradable is copied like any other; unchecked (gate 2), it is skipped
  d.act({ type: 'copierFollower', account: 'EVAL-A', on: true, qty: 1, size: 'micro', lossLimit: null });
  d.tick(25404, 'MNQ');                                  // the micro at the mini's price (the follower's stop sits at the leader's)
  d.order({ cid: 'L2', root: 'NQ', bracket: { stop: 8, target: 16 } });
  assert.equal(d.desk.pos('EVAL-A', 'MNQ').qty, 1, 'EVAL-A (real, checked) copied like any follower');
  assert.ok(d.working('EVAL-A').some(o => o.role === 'stop' && o.copier), 'and gets its stop at the leader\'s price');
  d.act({ type: 'flatten', account: 'Sim101', root: 'NQ' });
  d.act({ type: 'accountTrade', account: 'EVAL-A', on: false });
  d.order({ cid: 'L3', root: 'NQ', bracket: { stop: 8, target: 16 } });
  assert.equal(d.desk.copier.followers.get('EVAL-A').skipped, 'not checked for trading', 'unchecked: skipped (the gates still apply)');
  d.act({ type: 'flatten', account: 'Sim101', root: 'NQ' });
  // mass disconnect: the leader dropping stands it down
  d.desk.setConnection('Sim101', 'lost');
  assert.equal(d.desk.copier.armed, false); assert.match(d.desk.copier.standDownWhy, /leader/);
  assert.match(reasonOf(d.act({ type: 'copierRearm' })), /not connected/);
});

test('bot: copilot proposal accepted is placed from its own parameters on Sim101; withdraw is "not answered"; rails and heartbeat', async () => {
  const d = await makeDesk();
  d.act({ type: 'botMode', mode: 'copilot' });
  d.desk.botMessage({ type: 'botHello', name: 'Demo' });
  d.desk.botMessage({ type: 'signal', id: 'p1', action: 'fired', side: 'sell', kind: 'market', stopTicks: 12, targetTicks: 24, reason: 'Sample' });
  const pr = d.take('botProposal')[0];
  assert.equal(pr.state, 'open'); assert.equal(pr.qty, 1); assert.equal(pr.account, 'Sim101');
  d.act({ type: 'botSeen', id: 'p1', at: 1791380820450 });
  d.act({ type: 'botAnswer', id: 'p1', answer: 'accept', at: 1791380821200 });
  assert.equal(d.desk.pos('Sim101', 'MNQ').qty, -1);
  assert.equal(d.working('Sim101').filter(o => o.role === 'stop').length, 1, 'the bot entry has its stop');
  assert.match(reasonOf(d.act({ type: 'botAnswer', id: 'p1', answer: 'accept', at: 1 })), /accepted/);
  d.desk.botMessage({ type: 'signal', id: 'p2', action: 'fired', side: 'buy', kind: 'market', stopTicks: 12, targetTicks: null, reason: 'Sample' });
  d.desk.botMessage({ type: 'withdraw', id: 'p2', reason: 'gone' });
  assert.equal(d.desk.bot.proposals.get('p2').state, 'not answered');
  // auto: Sim101 only, 1 contract; the kill switch cancels unfilled entries and keeps the position
  d.act({ type: 'botMode', mode: 'auto' });
  d.desk.botMessage({ type: 'signal', id: 'a1', action: 'fired', side: 'sell', kind: 'limit', price: 25500, stopTicks: 8, targetTicks: 8, reason: 'Sample' });
  assert.ok(d.working('Sim101').some(o => o.by === 'bot' && o.role === 'entry'));
  d.act({ type: 'botKill', on: true });
  assert.ok(!d.working('Sim101').some(o => o.by === 'bot' && o.role === 'entry'));
  assert.equal(d.desk.pos('Sim101', 'MNQ').qty, -1, 'never flattens by itself');
  d.desk.botMessage({ type: 'signal', id: 'a2', action: 'fired', side: 'buy', kind: 'market', stopTicks: 8, targetTicks: 8, reason: 'Sample' });
  assert.equal(d.desk.bot.lastSignal.result, 'refused: the kill switch is on');
  d.act({ type: 'botKill', on: false });
  d.desk.bot.trades = 5;
  d.desk.botMessage({ type: 'signal', id: 'a3', action: 'fired', side: 'buy', kind: 'market', stopTicks: 8, targetTicks: 8, reason: 'Sample' });
  assert.match(d.desk.bot.lastSignal.result, /5 trades today/);
  assert.match(d.desk.botMessage({ type: 'signal', id: 'x', action: 'fired', extra: 1 }), /Unknown key/);
  d.desk.bot.trades = 0;
  d.desk.botMessage({ type: 'signal', id: 'a4', action: 'fired', side: 'sell', kind: 'limit', price: 25500, stopTicks: 8, targetTicks: 8, reason: 'Sample' });
  d.advance(5100); d.desk.everySecond();
  assert.equal(d.desk.bot.connected, false);
  assert.ok(!d.working('Sim101').some(o => o.by === 'bot' && o.role === 'entry'), 'heartbeat lost: unfilled entries cancelled');
  assert.equal(d.desk.bot.stats.heartbeatLost, 1);
});

test('bot: the account Anthony chooses (botAccount): Sim or LIVE, every gate, never a copier follower or leader, only when flat', async () => {
  const d = await makeDesk();
  d.desk.botMessage({ type: 'botHello', name: 'Demo' });
  assert.equal(d.desk.botMsg().account, 'Sim101'); assert.equal(d.desk.botMsg().sim, true);
  assert.match(reasonOf(d.act({ type: 'botAccount', account: 'NOPE-1' })), /not in NinjaTrader/);
  assert.match(reasonOf(d.act({ type: 'botAccount', account: 'FUNDED-C' })), /FUNDED-C is not checked for trading.*the bot needs it tradable/, 'not tradable: refused');
  assert.match(reasonOf(d.act({ type: 'botAccount', account: 'EVAL-A', extra: 1 })), /unknown key|Unknown key/i);
  d.act({ type: 'copierFollower', account: 'SIM-F1', on: true, qty: 1, size: 'micro', lossLimit: null });
  d.act({ type: 'accountTrade', account: 'SIM-F1', on: true });
  assert.match(reasonOf(d.act({ type: 'botAccount', account: 'SIM-F1' })), /SIM-F1 is a copier follower/, 'a follower that is on: refused');
  // LIVE allowed
  d.act({ type: 'botMode', mode: 'copilot' });
  d.desk.botMessage({ type: 'signal', id: 'q1', action: 'fired', side: 'sell', kind: 'market', stopTicks: 12, targetTicks: 24, reason: 'Sample' });
  assert.equal(reasonOf(d.act({ type: 'botAccount', account: 'EVAL-A' })), null);
  assert.equal(d.desk.bot.proposals.get('q1').state, 'not answered', 'an open proposal expires when the account changes');
  const b = d.desk.botMsg();
  assert.equal(b.account, 'EVAL-A'); assert.equal(b.sim, false, 'EVAL-A is LIVE');
  assert.equal(d.desk.welcomeMsg().account, 'EVAL-A'); assert.equal(d.desk.welcomeMsg().sim, false);
  assert.match(reasonOf(d.act({ type: 'copierFollower', account: 'EVAL-A', on: true, qty: 1, size: 'micro', lossLimit: null })), /EVAL-A is the bot's account/, 'the other way: refused');
  d.act({ type: 'botMode', mode: 'auto' });
  assert.equal(d.desk.bot.mode, 'auto', 'auto on a LIVE account');
  const before = d.desk.pos('EVAL-A', 'MNQ').qty;
  d.desk.botMessage({ type: 'signal', id: 'a1', action: 'fired', side: 'buy', kind: 'market', stopTicks: 8, targetTicks: 8, reason: 'Sample' });
  assert.equal(d.desk.pos('EVAL-A', 'MNQ').qty, before + 1, 'auto placed 1 contract on EVAL-A');
  assert.equal(d.desk.pos('Sim101', 'MNQ').qty, 0, 'nothing on Sim101');
  assert.match(reasonOf(d.act({ type: 'botAccount', account: 'Sim101' })), /Sim101 is the copier's leader/, 'the copier\'s leader: refused');
  assert.match(reasonOf(d.act({ type: 'botAccount', account: 'EVAL-A' })), /choose its account when it is flat/, 'with a position: refused');
  d.act({ type: 'botMode', mode: 'copilot' });
  d.desk.botMessage({ type: 'signal', id: 'q2', action: 'fired', side: 'sell', kind: 'market', stopTicks: 12, targetTicks: 24, reason: 'Sample' });
  const pr = d.desk.bot.proposals.get('q2');
  assert.equal(pr.account, 'EVAL-A'); assert.equal(pr.sim, false, 'the proposal names the account and its mark');
});

/* ---------------- the fake server with --v3 */
function wsConnect(port, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: Object.assign({ Host: 'localhost:' + port, Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') }, headers || {}) });
    req.on('upgrade', (res, sock, head) => {
      const msgs = [], waiters = []; let buf = Buffer.alloc(0);
      const onData = d => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (buf.length < 2) break;
          let len = buf[1] & 0x7f, q = 2;
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); q = 4; } else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); q = 10; }
          if (buf.length < q + len) break;
          msgs.push(JSON.parse(buf.slice(q, q + len).toString('utf8'))); buf = buf.slice(q + len); for (const w of waiters.splice(0)) w();
        }
      };
      sock.on('data', onData); sock.on('error', () => {}); if (head && head.length) onData(head);
      const send = obj => {
        const data = Buffer.from(JSON.stringify(obj)), mask = crypto.randomBytes(4);
        const h = data.length < 126 ? Buffer.from([0x81, 0x80 | data.length]) : Buffer.from([0x81, 0x80 | 126, data.length >> 8, data.length & 255]);
        sock.write(Buffer.concat([h, mask, Buffer.from(data.map((b, i) => b ^ mask[i & 3]))]));
      };
      const next = async (type, ms) => {
        const end = Date.now() + (ms || 3000);
        for (;;) { const i = msgs.findIndex(m => m.type === type); if (i >= 0) return msgs.splice(i, 1)[0]; if (Date.now() > end) return null; await new Promise(r => { waiters.push(r); setTimeout(r, 50); }); }
      };
      resolve({ send, next, close: () => sock.destroy() });
    });
    req.on('response', res => { res.resume(); reject(new Error('WebSocket refused: ' + res.statusCode)); });
    req.on('error', reject); req.end();
  });
}
function post(port, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', agent: false, headers: Object.assign({ Host: 'localhost:' + port, Origin: 'http://localhost:' + port,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {}) }, res => {
      let t = ''; res.on('data', x => t += x); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
function get(port, p, unlock) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: Object.assign({ Host: 'localhost:' + port }, unlock ? { 'X-ChartBridge-Unlock': unlock } : {}) }, res => {
      let body = ''; res.on('data', x => body += x); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('server --v3: hello lists v3 and quote-only roots; client gets accounts; auth names the switches; /bot needs its secret', async () => {
  const port = 18900 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, [path.join(__dirname, 'fake-bridge.mjs'), String(port), '--v3', '--trading', '--test-controls', '--test-pin=5820', '--gone-grace-ms=300'], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => child.stdout.once('data', r));
  try {
    const own = 'http://localhost:' + port;
    const unlock = (await post(port, '/pin/unlock', { pin: '5820' })).json.token;
    const token = JSON.parse((await get(port, '/session', unlock)).body).token;
    const a = await wsConnect(port, '/ws?unlock=' + encodeURIComponent(unlock), { Origin: own });
    const hello = await a.next('hello');
    assert.ok(hello.features.includes('v3') && !hello.features.includes('quoteOnly'), 'quote-only markets are told per instrument, not as a feature');
    const zn = hello.instruments.find(i => i.root === 'ZN');
    assert.equal(zn.quoteOnly, true); assert.equal(zn.priceFormat, '32nds'); assert.equal(zn.tick, 0.015625);
    assert.deepEqual(Object.keys(zn).slice(0, 6), ['root', 'name', 'tick', 'pointValue', 'quoteOnly', 'priceFormat'], 'ChartBridge 0.4.0\'s field order');
    assert.ok(!('format' in zn) && !('decimals' in zn));
    assert.equal(hello.instruments.find(i => i.root === 'MNQ').quoteOnly, false);
    assert.equal(hello.instruments.find(i => i.root === 'MNQ').priceFormat, 'decimal');
    a.send({ type: 'client', v: 3 });
    const acc = await a.next('accounts');
    assert.deepEqual(acc.list.map(x => x.name), ['EVAL-A', 'EVAL-B', 'FUNDED-C', 'SIM-F1', 'SIM-F2', 'Sim101']);
    a.send({ type: 'auth', token });
    const t = await a.next('trading');
    assert.equal(t.enabled, true); assert.equal(t.switches.merge, true); assert.equal(t.switches.copier, true);
    const orders = await a.next('orders');
    assert.ok(orders.list.some(o => o.account === 'FUNDED-C'), 'a v3 page sees every watched account\'s working orders');
    assert.ok(await a.next('copier')); assert.ok(await a.next('bot'));
    a.send({ type: 'order', cid: 'q1', account: 'Sim101', root: 'GC', side: 'buy', kind: 'market', qty: 1 });
    assert.equal((await a.next('reject')).reason, 'GC is quote only: ChartBridge shows its prices on the Quote board and refuses every order for it (quoteRoots in config.txt)');
    // a proposal on demand, answered from the page
    const id = (await post(port, '/test/bot-proposal?side=buy&kind=market&stop=12&target=24', undefined)).json.id;
    const pr = await a.next('botProposal');
    assert.equal(pr.id, id); assert.equal(pr.state, 'open');
    a.send({ type: 'botAnswer', cid: 'b1', id, answer: 'reject', at: Date.now() });
    let p2; do { p2 = await a.next('botProposal'); } while (p2 && p2.state === 'open');
    assert.equal(p2.state, 'rejected');
    // EVAL-B was seeded lost: Gone after the grace
    await new Promise(r => setTimeout(r, 1500));
    const v3 = (await post(port, '/test/v3')).json;
    assert.equal(v3.accounts.list.find(x => x.name === 'EVAL-B').state, 'gone');
    const diag = JSON.parse((await get(port, '/diag')).body);
    // /diag as ChartBridge 0.4.0 built it ("0.4.0 hardening and markets", "/diag additions"); no tapeStats switch
    for (const k of ['health', 'pages', 'markets', 'tape', 'merges', 'copier', 'bot']) assert.ok(k in diag, 'diag ' + k);
    for (const k of ['memory', 'threads', 'pages', 'errors']) assert.ok(k in diag.health, 'diag health.' + k);
    for (const k of ['seenFills', 'books', 'heapBytes', 'gcGen0', 'lastSweepUtcMs']) assert.ok(k in diag.health.memory, 'health.memory.' + k);
    for (const k of ['poolWorkersFree', 'poolIoMax', 'pageSendThreads']) assert.ok(k in diag.health.threads, 'health.threads.' + k);
    for (const k of ['connects', 'closes', 'notKeepingUp', 'sendErrors', 'sendMs']) assert.ok(k in diag.health.pages, 'health.pages.' + k);
    assert.ok(diag.pages.length >= 1 && diag.pages.every(p => p.sendMs && 'p95' in p.sendMs));
    assert.deepEqual(Object.keys(diag.markets.ZN), ['contract', 'quoteOnly', 'tick', 'tableTick', 'priceFormat', 'settlesBy', 'resolvedBy']);
    assert.equal(diag.markets.ZB.priceFormat, '32nds'); assert.equal(diag.markets.MNQ.quoteOnly, false);
    assert.equal(typeof diag.tape.failed, 'number');
    const mnq = diag.tape.roots.MNQ;
    assert.ok(mnq && 'late' in mnq && 'last' in mnq && mnq.session && /^\d{4}-\d\d-\d\d 18:00$/.test(mnq.session.from), JSON.stringify(mnq && mnq.session));
    const slot = mnq.session.slots[0];
    for (const k of ['at', 'prints', 'perSec', 'peakPerSec', 'gapMs', 'sameMsU', 'sameMsRx', 'jumpTicks', 'delayMs']) assert.ok(k in slot, 'tape slot ' + k);
    assert.deepEqual(Object.keys(slot.jumpTicks), ['0', '1', '2', '3+']); assert.deepEqual(Object.keys(slot.delayMs), ['p50', 'p95', 'below0']);
    assert.ok(!('tapeStats' in diag) && !('memory' in diag) && !('send' in diag));
    // the bot channel: no Origin, the secret, one at a time
    const secret = (await post(port, '/test/bot-secret')).json.secret;
    await assert.rejects(wsConnect(port, '/bot', {}), /403/);
    await assert.rejects(wsConnect(port, '/bot', { 'X-ChartBridge-Bot': secret, Origin: own }), /403/, 'a browser page never reaches /bot');
    const bot = await wsConnect(port, '/bot', { 'X-ChartBridge-Bot': secret });
    await assert.rejects(wsConnect(port, '/bot', { 'X-ChartBridge-Bot': secret }), /409/);
    bot.send({ type: 'botHello', name: 'Demo Opening Fade' });
    const w = await bot.next('welcome');
    assert.equal(w.account, 'Sim101'); assert.deepEqual(w.rails, { maxQty: 1, maxTrades: 5, maxLosses: 3 });
    assert.ok(await bot.next('tick'), 'the bot reads live ticks');
    bot.send({ type: 'signal', id: 's1', action: 'skipped', reason: 'Sample: range too small' });
    let sg; do { sg = await a.next('botSignal', 3000); } while (sg && sg.id !== 's1');
    assert.equal(sg && sg.id, 's1'); assert.equal(sg.result, 'skipped');
    a.close(); bot.close();
  } finally { child.kill(); }
});

/* ======================================================================== the agent channel (ChartBridge 0.5.0, contract
   AGENT_CHANNEL v1): the fake's reference behaviour. The agent is the made-up "Demo Agent" (id demo); SIM-AG1 is a made-up
   Sim account for it to take. */
async function makeAgentDesk(o) {
  o = o || {};
  const V = await import('./fake-v3.mjs');
  let clock = o.at || Date.UTC(2026, 9, 8, 14, 0, 0);          // 10:00 New York, inside Manrae's default window
  const out = [], toAgent = [];
  const conn = { origin: 'http://localhost:8765', authed: false, actions: [], v3: true };
  const agentConn = { agentConn: true };
  const desk = new V.OrderDeskV3({
    config: { trading: true, tradeAccounts: ['Sim101', 'EVAL-A', 'SIM-AG1', 'SIM-AG2'], maxQty: { MNQ: 20, NQ: 2 }, port: 8765 },
    instruments: INSTR, knownAccounts: V.V3_ACCOUNTS.map(a => a.name).concat(['SIM-AG1', 'SIM-AG2']), token: 'tok', switches: Object.assign({}, ALL_ON, o.switches || {}),
    accountList: V.V3_ACCOUNTS.concat([{ name: 'SIM-AG1', sim: true, balance: 50000 }, { name: 'SIM-AG2', sim: true, balance: 50000 }]), graceMs: 1000,
    send: (c, m) => (c === agentConn ? toAgent : out).push(m), conns: () => [conn], now: () => clock, barTime: () => clock / 1000,
    agents: o.agents || ['demo'], agentAccounts: o.accounts || { demo: 'SIM-AG1' }, agentAnyTime: !!o.anyTime,
  });
  desk.tick('MNQ', 25400); desk.tick('NQ', 25400); desk.tick('YM', 46200);
  desk.auth(conn, 'tok'); out.length = 0;
  const d = {
    V, desk, conn, out, toAgent, agentConn,
    advance(ms) { clock += ms; for (const a of desk.agents.values()) if (a.conn === agentConn) a.lastBeat = clock; },   // the agent keeps beating
    silent(ms) { clock += ms; },                                                                                          // the agent says nothing
    now: () => clock,
    take(type) { const r = out.filter(m => !type || m.type === type); out.length = 0; return r; },
    agentTake(type) { const r = toAgent.filter(m => !type || m.type === type); toAgent.length = 0; return r; },
    act(m) { clock += 150; desk.handle(conn, m, JSON.stringify(m)); return d.take(); },
    hello(id) { desk.agentConnect(id || 'demo', agentConn); return desk.agentMessage(id || 'demo', { type: 'agentHello', name: 'Demo Agent', build: 'sample-build-1' }); },
    say(m, id) { clock += 120; return desk.agentMessage(id || 'demo', m, JSON.stringify(m)); },
    plan(f, id) {
      const m = Object.assign({ type: 'plan', id: 'p' + Math.random().toString(36).slice(2, 7), root: 'MNQ', side: 'buy', kind: 'limit', price: 25399, qty: 2, stopTicks: 16, targetTicks: 32, expireSec: 600, riskDollars: 16,
        setup: 'Sample pullback', reason: 'Sample: a made-up reason', confidence: 0.6 }, f || {});
      return { id: m.id, why: d.say(m, id) };
    },
    tick(p, root) { clock += 600; desk.tick(root || 'MNQ', p); return d.take(); },
    working(account) { return [...desk.orders.values()].filter(x => (x.state === 'working' || x.state === 'partFilled') && (!account || x.account === account)); },
  };
  return d;
}

test('agents: strict page keys (flat, agentKill on only bool) and the agent\'s own strict parser', async () => {
  const { checkKeysV3, checkAgentMessage, AGENT_KEYS } = await import('./fake-v3.mjs');
  const ok = m => checkKeysV3(m, JSON.stringify(m));
  assert.equal(ok({ type: 'agentMode', cid: 'c', agent: 'demo', mode: 'copilot' }), null);
  assert.equal(ok({ type: 'agentKill', agent: 'demo', on: true }), null);
  assert.equal(ok({ type: 'agentSeen', agent: 'demo', id: 'p1', at: 1 }), null);
  assert.equal(ok({ type: 'agentAnswer', cid: 'c', agent: 'demo', id: 'p1', answer: 'accept', at: 1 }), null);
  assert.equal(ok({ type: 'agentAccount', agent: 'demo', account: 'SIM-AG1' }), null);
  assert.equal(ok({ type: 'agentRules', agent: 'demo', roots: 'NQ,MNQ', maxQtyNQ: 2, maxQtyMNQ: 20, entryFrom: '09:45', entryUntil: '15:00', flatAt: '15:55', maxExpireSec: 1800, maxTrades: 0, maxLosses: 0 }), null);
  assert.match(ok({ type: 'agentRules', agent: 'demo', maxQty: { NQ: 2 } }), /Unknown key "maxQty"/);
  assert.match(ok({ type: 'agentRules', agent: 'demo', roots: ['NQ'] }), /nested/);
  assert.match(ok({ type: 'agentMode', agent: 'demo', mode: true }), /cannot be true or false/);
  assert.match(ok({ type: 'agentKill', agent: 'demo', on: 1 }), /on must be true or false/);
  assert.equal(checkAgentMessage({ type: 'note', kind: 'look', text: 'x'.repeat(1000) }), null);
  assert.match(checkAgentMessage({ type: 'note', kind: 'look', text: 'x'.repeat(1001) }), /1,000/);
  assert.match(checkAgentMessage({ type: 'plan', id: 'x'.repeat(201) }), /200/);
  assert.match(checkAgentMessage({ type: 'plan', id: 'a', account: 'Sim101' }), /Unknown key "account"/, 'an agent never names an account');
  assert.match(checkAgentMessage({ type: 'beat', x: { y: 1 } }), /Unknown key|nested/);
  assert.match(checkAgentMessage({ type: 'note', kind: 'look', text: 'a\u0001b' }), /plain string/);
  assert.match(checkAgentMessage({ type: 'note', kind: 'look', text: 'a' }, '{"type":"note","kind":"look","text":"a\\nb"}'), /backslash/);
  assert.match(checkAgentMessage({ type: 'note', kind: 'look', text: 'b' }, '{"type":"note","kind":"look","text":"a","text":"b"}'), /twice/);
  assert.match(checkAgentMessage({ type: 'order' }), /Unknown message type/);
  assert.deepEqual(Object.keys(AGENT_KEYS).sort(), ['agentHello', 'beat', 'flatten', 'note', 'plan', 'skip', 'subscribe', 'withdraw']);
});

test('agents: agentHello first, welcome then agentState; every start in shadow; a page that signs in gets everything', async () => {
  const d = await makeAgentDesk();
  d.desk.agentConnect('demo', d.agentConn);
  assert.equal(d.say({ type: 'note', kind: 'look', text: 'x' }), 'send agentHello first');
  assert.equal(d.say({ type: 'agentHello', name: 'Demo Agent', build: 'sample-build-1' }), null);
  const [w, st] = d.agentTake();
  assert.equal(w.type, 'welcome'); assert.equal(st.type, 'agentState');
  assert.deepEqual(Object.keys(w), ['type', 'version', 'agent', 'mode', 'account', 'sim', 'rules', 'instruments']);
  assert.equal(w.agent, 'demo'); assert.equal(w.mode, 'shadow'); assert.equal(w.account, 'SIM-AG1'); assert.equal(w.sim, true);
  assert.deepEqual(w.rules, { roots: ['NQ', 'MNQ'], maxQty: { NQ: 2, MNQ: 20 }, entryFrom: '09:45', entryUntil: '15:00', flatAt: '15:55', maxExpireSec: 1800, maxTrades: null, maxLosses: null }, 'roots a list, as built');
  assert.deepEqual(w.instruments.map(i => i.root), ['NQ', 'MNQ']);
  assert.deepEqual(Object.keys(st), ['type', 'mode', 'killed', 'standDown', 'trades', 'losses', 'pnlToday', 'owns']);
  const ag = d.take('agent').pop();
  assert.deepEqual(Object.keys(ag), ['type', 'agent', 'name', 'build', 'enabled', 'connected', 'mode', 'account', 'sim', 'rules', 'position', 'pnlToday', 'trades', 'losses', 'killed', 'standDown', 'owns', 'lastBeatMs', 'lastPlan']);
  assert.equal(ag.name, 'Demo Agent'); assert.equal(ag.build, 'sample-build-1'); assert.equal(ag.connected, true);
  for (const k of ['look', 'thinking', 'lesson', 'notebook', 'status']) d.say({ type: 'note', kind: k, text: 'Sample ' + k });
  const notes = d.take('agentNote');
  assert.equal(notes.length, 5); assert.deepEqual(Object.keys(notes[0]), ['type', 'agent', 'at', 'kind', 'text']);
  d.say({ type: 'skip', id: 's1', setup: 'Sample breakout', reason: 'Sample: no level' });
  assert.equal(d.take('agentPlan')[0].result, 'skipped');
  d.act({ type: 'agentMode', agent: 'demo', mode: 'copilot' });
  const pr = d.plan();
  assert.equal(pr.why, null);
  // a second page signs in: every agent, its open proposals, its notes and plans
  const c2 = { origin: 'http://localhost:8765', authed: false, actions: [], v3: true }, got = [];
  const send0 = d.desk.send; d.desk.send = (c, m) => (c === c2 ? got.push(m) : send0(c, m));
  d.desk.auth(c2, 'tok');
  d.desk.send = send0;
  const types = got.map(m => m.type);
  assert.ok(types.includes('agent') && types.includes('agentProposal'));
  assert.equal(got.filter(m => m.type === 'agentNote').length, 5);
  assert.equal(got.filter(m => m.type === 'agentPlan').length, 2);
});

test('agents: plan checks in the contract\'s order; shadow logs and shows (no answer); a refusal is a reject and an agentPlan', async () => {
  const d = await makeAgentDesk();
  d.hello(); d.take(); d.agentTake();
  let r = d.plan({ id: 'sh1' });
  assert.equal(r.why, null);
  assert.equal(d.take('agentPlan')[0].result, 'shadow');
  assert.equal(d.agentTake('answer').length, 0, 'shadow: the agent gets no answer');
  assert.equal(d.working().filter(o => o.agentId).length, 0, 'shadow places nothing');
  const why = f => d.plan(f).why;
  assert.match(why({ id: 'sh1' }), /was used today/);
  assert.match(why({ root: 'ES', riskDollars: 400 }), /not one of demo's roots/);
  assert.match(why({ kind: 'market' }), /an agent's entry is a limit or a stop-limit/);
  assert.match(why({ kind: 'stop' }), /limit or a stop-limit/);
  assert.match(why({ qty: 21, riskDollars: 168 }), /from 1 to 20/);
  assert.match(why({ root: 'NQ', qty: 3, riskDollars: 240 }), /from 1 to 2/);
  assert.match(why({ stopTicks: 0, riskDollars: 0 }), /whole numbers of 1 or more/);
  assert.match(why({ riskDollars: 17 }), /riskDollars 17 is not/);
  assert.equal(why({ riskDollars: 16.009 }), null, 'within $0.01');
  assert.match(why({ expireSec: 59 }), /expireSec must be from 60 to 1800/);
  assert.match(why({ expireSec: 1801 }), /from 60 to 1800/);
  assert.match(why({ price: 25400.1 }), /tick grid/);
  assert.match(why({ price: 25401 }), /buy limit must be at or below the last trade/);
  assert.match(why({ side: 'sell', price: 25399 }), /sell limit must be at or above/);
  assert.match(why({ kind: 'stopLimit', price: 25399, limitPrice: 25400 }), /stop-limit's price must be above/);
  assert.match(why({ kind: 'stopLimit', price: 25401, limitPrice: 25406.25 }), /from its price to 20 ticks above/);
  assert.match(why({ kind: 'stopLimit', price: 25401, limitPrice: 25400.75 }), /from its price to 20 ticks above/);
  assert.equal(why({ kind: 'stopLimit', price: 25401, limitPrice: 25406 }), null, '20 ticks above: allowed');
  assert.match(why({ kind: 'stopLimit', price: 25401 }), /needs limitPrice/);
  assert.match(why({ limitPrice: 25399 }), /stop-limit plan only/);
  assert.match(why({ confidence: 1.2 }), /confidence/);
  const ref = d.take('agentPlan').pop();
  assert.match(ref.result, /^refused: /);
  assert.equal(d.agentTake('reject').length > 5, true, 'each refusal is a reject to the agent');
  d.act({ type: 'agentKill', agent: 'demo', on: true });
  assert.match(why({}), /the kill switch is on/);
  d.act({ type: 'agentKill', agent: 'demo', on: false });
  // the window: before entryFrom and at entryUntil
  const early = await makeAgentDesk({ at: Date.UTC(2026, 9, 8, 13, 40) });   // 09:40 New York
  early.hello();
  assert.match(early.plan().why, /outside the entry window \(09:45 to 15:00 ET\)/);
  const late = await makeAgentDesk({ at: Date.UTC(2026, 9, 8, 19, 0) });     // 15:00 New York: not before entryUntil
  late.hello();
  assert.match(late.plan().why, /outside the entry window/);
  const any = await makeAgentDesk({ at: Date.UTC(2026, 9, 8, 19, 0), anyTime: true });   // tests and smokes only: no window
  any.hello();
  assert.equal(any.plan().why, null, '--agent-any-time: a plan at 15:00 passes the window');
  // the bot's account is never an agent's
  const shared = await makeAgentDesk({ accounts: { demo: 'Sim101' } });
  shared.hello();
  assert.match(shared.plan().why, /^Sim101 is also the bot's account: choose an account for agent demo on the Agent tab \(an agent never shares an account\)$/);
});

test('agents: copilot proposal lives until the plan\'s own expiry; agentSeen; accept places it from the plan with by agent:demo', async () => {
  const d = await makeAgentDesk();
  d.hello(); d.act({ type: 'agentMode', agent: 'demo', mode: 'copilot' }); d.take(); d.agentTake();
  const { id } = d.plan({ expireSec: 600, price: 25399 });
  const p = d.take('agentProposal')[0];
  assert.deepEqual(Object.keys(p), ['type', 'agent', 'id', 'at', 'account', 'sim', 'root', 'side', 'kind', 'price', 'qty', 'stopTicks', 'targetTicks', 'expireSec', 'riskDollars', 'setup', 'reason', 'confidence', 'expiresAt', 'state', 'seenAt', 'answeredAt']);
  assert.equal(p.expiresAt, p.at + 600000, 'open until the plan\'s entry expiry (ruling 4)');
  assert.equal(d.agentTake('answer')[0].answer, 'proposed');
  assert.match(d.plan().why, /open proposal: one at a time/);
  d.act({ type: 'agentSeen', agent: 'demo', id, at: d.now() });
  assert.ok(d.desk.agents.get('demo').proposals.get(id).seenAt > 0);
  assert.match(reasonOf(d.act({ type: 'agentAnswer', agent: 'demo', id: 'nope', answer: 'accept', at: 1 })), /No proposal nope/);
  assert.match(reasonOf(d.act({ type: 'agentRules', agent: 'demo', roots: 'MNQ', maxQtyMNQ: 5, entryFrom: '09:45', entryUntil: '15:00', flatAt: '15:55', maxExpireSec: 900, maxTrades: 0, maxLosses: 0 })), /open proposal: change its rules when it is flat/);
  d.advance(60000);
  const msgs = d.act({ type: 'agentAnswer', cid: 'a1', agent: 'demo', id, answer: 'accept', at: d.now() });
  assert.equal(msgs.filter(m => m.type === 'agentProposal').pop().state, 'accepted');
  const entry = d.working('SIM-AG1').find(o => o.role === 'entry');
  assert.ok(entry && entry.agentId === 'demo' && entry.price === 25399 && entry.qty === 2 && entry.kind === 'limit', 'placed from the plan\'s own numbers');
  assert.equal(entry.expiresAt, p.expiresAt, 'it works only the time left');
  assert.match(entry.tag, /^CB#nt\d+ ag:demo s16 t32$/);
  const om = msgs.find(m => m.type === 'order' && m.id === entry.id);
  assert.equal(om.by, 'agent:demo', 'v3 pages see by agent:demo');
  assert.deepEqual(d.agentTake('answer').map(x => x.answer), ['accepted', 'placed']);
  // it fills: its legs carry the mark, the trade is counted, the agent owns SIM-AG1 MNQ
  const fills = d.tick(25398.75);
  const legs = fills.filter(m => m.type === 'order' && (m.role === 'stop' || m.role === 'target'));
  assert.ok(legs.length === 2 && legs.every(l => l.by === 'agent:demo'), 'its stop and target are the agent\'s too');
  const ag = d.desk.agentMsg(d.desk.agents.get('demo'));
  assert.equal(ag.trades, 1); assert.equal(ag.owns, true); assert.deepEqual(ag.position, { root: 'MNQ', qty: 2, avgPrice: 25399 });
  assert.ok(d.agentTake('exec').length >= 1, 'the agent gets its own fills');
  // the owner lock: the page's new entry on SIM-AG1 MNQ is refused; an exit passes
  assert.match(reasonOf(d.act({ type: 'order', cid: 'o1', account: 'SIM-AG1', root: 'MNQ', side: 'buy', kind: 'market', qty: 1 })), /^SIM-AG1 MNQ belongs to agent demo: use Flatten, or move its stop or target$/, 'the page\'s words (as built)');
  assert.equal(reasonOf(d.act({ type: 'order', cid: 'o2', account: 'SIM-AG1', root: 'MNQ', side: 'sell', kind: 'market', qty: 1 })), null, 'reducing is an exit');
  assert.equal(reasonOf(d.act({ type: 'flatten', account: 'SIM-AG1', root: 'MNQ' })), null, 'Flatten always works');
  const after = d.desk.agentMsg(d.desk.agents.get('demo'));
  assert.equal(after.position, null); assert.equal(after.owns, false);
  assert.equal(after.losses, 1, 'closed below the entry: a losing trade');
  assert.ok(after.pnlToday < 0);
});

test('agents: reject, withdraw, expiry, under 5 s left, an accept refused at placing', async () => {
  const d = await makeAgentDesk();
  d.hello(); d.act({ type: 'agentMode', agent: 'demo', mode: 'copilot' }); d.take(); d.agentTake();
  let { id } = d.plan();
  d.act({ type: 'agentAnswer', agent: 'demo', id, answer: 'reject', at: d.now() });
  assert.equal(d.desk.agents.get('demo').proposals.get(id).state, 'rejected');
  ({ id } = d.plan());
  d.say({ type: 'withdraw', id, reason: 'Sample: gone' });
  assert.equal(d.desk.agents.get('demo').proposals.get(id).state, 'withdrawn');
  ({ id } = d.plan({ expireSec: 60 }));
  d.advance(61000); d.desk.everySecond();
  assert.equal(d.desk.agents.get('demo').proposals.get(id).state, 'expired', 'ChartBridge\'s own timer');
  assert.ok(d.agentTake('answer').some(a => a.id === id && a.answer === 'expired'));
  ({ id } = d.plan({ expireSec: 60 }));
  d.advance(56000);
  assert.match(reasonOf(d.act({ type: 'agentAnswer', cid: 'z', agent: 'demo', id, answer: 'accept', at: d.now() })), /under 5 s/);
  assert.equal(d.desk.agents.get('demo').proposals.get(id).state, 'expired');
  // accepted, but the market moved through the limit: every check runs again at that moment
  ({ id } = d.plan({ price: 25399 }));
  d.tick(25390);
  assert.match(reasonOf(d.act({ type: 'agentAnswer', cid: 'y', agent: 'demo', id, answer: 'accept', at: d.now() })), /accepted but refused: a buy limit must be at or below/);
  assert.equal(d.desk.agents.get('demo').proposals.get(id).state, 'rejected');
  assert.ok(d.agentTake('answer').some(a => a.id === id && a.answer === 'refused'));
  // leaving copilot expires the open proposals as not answered
  ({ id } = d.plan({ price: 25390 }));
  d.act({ type: 'agentMode', agent: 'demo', mode: 'shadow' });
  assert.equal(d.desk.agents.get('demo').proposals.get(id).state, 'not answered');
});

test('agents: auto places at once; the kill switch and the heartbeat cancel unfilled entries; the agent\'s flatten', async () => {
  const d = await makeAgentDesk();
  d.hello();
  d.act({ type: 'agentMode', agent: 'demo', mode: 'auto' });
  let { id } = d.plan({ price: 25390 });
  assert.equal(d.desk.agents.get('demo').lastPlan.result, 'placed');
  assert.ok(d.working('SIM-AG1').some(o => o.planId === id));
  assert.match(d.plan({ price: 25390 }).why, /working entry: one at a time/);
  d.act({ type: 'agentKill', agent: 'demo', on: true });
  assert.ok(!d.working('SIM-AG1').some(o => o.planId === id), 'the kill switch cancels its unfilled entries');
  assert.equal(d.say({ type: 'flatten' }), 'the kill switch is on');
  d.act({ type: 'agentKill', agent: 'demo', on: false });
  ({ id } = d.plan({ price: 25390 }));
  d.silent(6000); d.desk.everySecond();
  assert.equal(d.desk.agents.get('demo').connected, false, '5 s of silence');
  assert.ok(!d.working('SIM-AG1').some(o => o.planId === id));
  assert.equal(d.desk.agentsDiag().demo.heartbeatLost, 1);
  // back, a fill, then the agent's own flatten (auto only)
  d.hello();
  d.plan({ price: 25400 });
  d.tick(25399.75);
  assert.ok(d.desk.agentMsg(d.desk.agents.get('demo')).position);
  assert.equal(d.say({ type: 'flatten' }), null);
  assert.equal(d.desk.agentMsg(d.desk.agents.get('demo')).position, null);
  assert.ok(!d.working('SIM-AG1').length, 'its legs are gone too');
  d.act({ type: 'agentMode', agent: 'demo', mode: 'copilot' });
  assert.equal(d.say({ type: 'flatten' }), 'flatten is for auto mode only');
  // auto needs the account tradable
  d.act({ type: 'accountTrade', account: 'SIM-AG1', on: false });
  assert.match(reasonOf(d.act({ type: 'agentMode', agent: 'demo', mode: 'auto' })), /auto refused: SIM-AG1 is not tradable now/);
});

test('agents: flat time flattens the agent\'s position itself, with the agent gone; an error every 10 s until flat', async () => {
  const d = await makeAgentDesk({ at: Date.UTC(2026, 9, 8, 18, 0) });   // 14:00 New York
  d.hello(); d.act({ type: 'agentMode', agent: 'demo', mode: 'auto' });
  d.plan({ price: 25400 }); d.tick(25399.75);
  d.desk.agentDrop('demo', 'the agent disconnected');
  assert.ok(d.desk.agentMsg(d.desk.agents.get('demo')).position, 'the heartbeat keeps a position (its stop and target)');
  d.advance(3600000 + 55 * 60000); d.desk.tick('MNQ', 25399.5); d.take();   // 15:55 New York
  d.desk.everySecond();
  const st = d.take('status');
  assert.ok(st.some(s => s.level === 'info' && s.text === 'demo flattened at 15:55 by its rules'), JSON.stringify(st));
  assert.equal(d.desk.agentMsg(d.desk.agents.get('demo')).position, null);
  assert.ok(d.desk.agentsDiag().demo.flattenedAt > 0);
  assert.ok(!d.working('SIM-AG1').length, 'its stop and target cancelled first');
  // not flat 10 s after its flatten (here: a close NinjaTrader leaves unfilled): the NOT FLAT error every 10 s until flat
  const a = d.desk.agents.get('demo');
  a.trade = { root: 'MNQ', pnl: 0 }; a.holdClose = true;
  d.desk.placeElsewhere({ account: 'SIM-AG1', root: 'MNQ', side: 'buy', kind: 'market', qty: 1, price: null }); d.take();
  d.desk.everySecond(); d.take();                                    // a new job (still the flat hours): its close does not fill
  d.advance(5000); d.desk.everySecond();
  assert.equal(d.take('status').filter(s => s.level === 'error').length, 0, 'not before 10 s');
  d.advance(5000); d.desk.everySecond();
  const e1 = d.take('status').filter(s => s.level === 'error');
  assert.equal(e1.length, 1); assert.match(e1[0].text, /^Agent demo: NOT FLAT 10 s after its flatten \(flat time\): MNQ on SIM-AG1 still shows 1; act in NinjaTrader now$/);
  d.advance(4000); d.desk.everySecond();
  assert.equal(d.take('status').filter(s => s.level === 'error').length, 0, 'once every 10 s, not every second');
  d.advance(6000); d.desk.everySecond();
  assert.equal(d.take('status').filter(s => s.level === 'error').length, 1, 'again 10 s later');
  a.holdClose = false; d.advance(3000); d.desk.everySecond();
  assert.equal(d.desk.agentMsg(a).position, null, 'the close goes again and fills: flat, the job ends');
  assert.equal(a.flatJob, null);
});

test('agents: account (section 6) never the bot\'s, the copier\'s or another agent\'s; the bot and the copier refuse an agent\'s', async () => {
  const d = await makeAgentDesk({ agents: ['demo', 'manrae'], accounts: { demo: 'SIM-AG1', manrae: 'SIM-AG2' } });
  const r = m => reasonOf(d.act(Object.assign({ type: 'agentAccount', agent: 'demo' }, m)));
  assert.match(r({ account: 'Sim101' }), /the bot's account/);
  assert.match(r({ account: 'SIM-AG2' }), /agent manrae's account/);
  assert.match(r({ account: 'NOPE' }), /not in NinjaTrader/);
  assert.match(r({ account: 'SIM-AG1' }), /already/);
  assert.match(r({ account: 'EVAL-B' }), /not tradable now/);
  assert.match(reasonOf(d.act({ type: 'agentAccount', agent: 'zed', account: 'EVAL-A' })), /No agent zed/);
  d.act({ type: 'copierFollower', account: 'EVAL-A', on: false, qty: 1, size: 'micro', lossLimit: null });
  assert.match(r({ account: 'EVAL-A' }), /copier follower/, 'a follower, on or off');
  assert.match(reasonOf(d.act({ type: 'botAccount', account: 'SIM-AG1' })), /agent demo's account: the bot trades an account of its own/);
  assert.match(reasonOf(d.act({ type: 'copierFollower', account: 'SIM-AG1', on: true, qty: 1, size: 'micro', lossLimit: null })), /agent demo's account/);
  assert.match(reasonOf(d.act({ type: 'copierSet', leader: 'SIM-AG2' })), /agent manrae's account/);
  // a free Sim account: taken, logged, the agent gets welcome again
  d.desk.acct.get('SIM-F2').trade = true; d.desk.refreshAccounts(); d.desk.copier.followers.delete('SIM-F2');
  d.hello(); d.agentTake();
  assert.equal(r({ account: 'SIM-F2' }), null);
  assert.equal(d.agentTake('welcome')[0].account, 'SIM-F2');
  // the old or the new account holding a position on the agent's roots
  d.desk.placeElsewhere({ account: 'SIM-AG1', root: 'NQ', side: 'buy', kind: 'market', qty: 1, price: null });
  assert.match(r({ account: 'SIM-AG1' }), /SIM-AG1 holds a position or a working order on NQ/);
});

test('agents: rules from the page (sections 3 and 7): every allowed value, saved and sent to the agent in a new welcome', async () => {
  const d = await makeAgentDesk();
  d.hello(); d.agentTake();
  const base = { type: 'agentRules', cid: 'r', agent: 'demo', roots: 'NQ,MNQ', maxQtyNQ: 1, maxQtyMNQ: 10, entryFrom: '09:45', entryUntil: '11:30', flatAt: '12:00', maxExpireSec: 900, maxTrades: 6, maxLosses: 3 };
  const r = o => reasonOf(d.act(Object.assign({}, base, o)));
  assert.match(r({ roots: 'NQ,YM' }), /YM cannot be an agent's root/, 'a valid key set reaches the root check');
  assert.match(r({ roots: 'NQ,NQ' }), /twice/);
  assert.match(r({ roots: 'NQ,MNQ', maxQtyNQ: 3 }), /maxQtyNQ must be a whole number from 1 to 2/);
  assert.match(r({ maxQtyMNQ: 21 }), /from 1 to 20/);
  assert.match(r({ roots: 'MNQ' }), /maxQtyNQ is for a root not in roots/);
  assert.match(r({ entryFrom: '09:29' }), /09:30 or later/);
  assert.match(r({ entryFrom: '9:45' }), /HH:MM/);
  assert.match(r({ entryUntil: '09:45' }), /before entryUntil/);
  assert.match(r({ flatAt: '11:30' }), /after entryUntil/);
  assert.match(r({ flatAt: '16:00' }), /15:59 at the latest/);
  assert.match(r({ maxExpireSec: 59 }), /60 to 1800/);
  assert.match(r({ maxTrades: 51 }), /1 to 50/);
  assert.match(r({ maxLosses: 21 }), /1 to 20/);
  assert.equal(r({}), null);
  const w = d.agentTake('welcome')[0];
  assert.deepEqual(w.rules, { roots: ['NQ', 'MNQ'], maxQty: { NQ: 1, MNQ: 10 }, entryFrom: '09:45', entryUntil: '11:30', flatAt: '12:00', maxExpireSec: 900, maxTrades: 6, maxLosses: 3 });
  assert.equal(d.desk.agentMsg(d.desk.agents.get('demo')).rules.maxTrades, 6);
  assert.equal(r({ maxTrades: 0, maxLosses: 0 }), null);
  assert.equal(d.desk.agentMsg(d.desk.agents.get('demo')).rules.maxTrades, null, '0 is none');
  assert.match(d.plan({ expireSec: 901 }).why, /from 60 to 900/, 'the new rules are in force');
  d.plan({ expireSec: 600 });                                                // a working entry? no: shadow. A position: refused
  d.desk.agents.get('demo').trade = { root: 'MNQ', pnl: 0 };
  assert.match(r({ maxTrades: 4 }), /has a position, a working entry or an open proposal/);
});

test('agents: with no agents in config.txt every agent message is refused and nothing is sent', async () => {
  const d = await makeAgentDesk({ agents: [] });
  assert.match(reasonOf(d.act({ type: 'agentMode', agent: 'demo', mode: 'copilot' })), /no agents on this ChartBridge/);
  assert.equal(d.desk.diag().agents, undefined, '/diag agents only with the channel on');
});

test('server --agents: /agent/<id> needs its secret, no Origin, one at a time; hello says 0.5.0; a v3 page gets the agent', async () => {
  const port = 18990 + Math.floor(Math.random() * 9);
  const child = spawn(process.execPath, [path.join(__dirname, 'fake-bridge.mjs'), String(port), '--v3', '--agents=demo', '--agent-any-time', '--trading', '--test-controls', '--test-pin=5820'], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => child.stdout.once('data', r));
  try {
    const own = 'http://localhost:' + port;
    const unlock = (await post(port, '/pin/unlock', { pin: '5820' })).json.token;
    const token = JSON.parse((await get(port, '/session', unlock)).body).token;
    const a = await wsConnect(port, '/ws?unlock=' + encodeURIComponent(unlock), { Origin: own });
    assert.equal((await a.next('hello')).version, 'fake-0.5.0');
    a.send({ type: 'client', v: 3 }); a.send({ type: 'auth', token });
    const ag = await a.next('agent');
    assert.equal(ag.agent, 'demo'); assert.equal(ag.mode, 'shadow'); assert.equal(ag.account, 'Sim101', 'no account file: Sim101');
    const secret = (await post(port, '/test/agent-secret?agent=demo')).json.secret;
    await assert.rejects(wsConnect(port, '/agent/nobody', { 'X-ChartBridge-Agent': secret }), /404/);
    await assert.rejects(wsConnect(port, '/agent/demo', {}), /403/);
    await assert.rejects(wsConnect(port, '/agent/demo', { 'X-ChartBridge-Agent': secret, Origin: own }), /403/, 'a browser page never reaches /agent');
    assert.equal((await get(port, '/agent/demo')).status, 400, 'not an upgrade');
    const ws = await wsConnect(port, '/agent/demo', { 'X-ChartBridge-Agent': secret });
    await assert.rejects(wsConnect(port, '/agent/demo', { 'X-ChartBridge-Agent': secret }), /409/);
    ws.send({ type: 'beat' });
    assert.equal((await ws.next('reject')).reason, 'send agentHello first');
    ws.send({ type: 'agentHello', name: 'Demo Agent', build: 'sample-build-1' });
    assert.equal((await ws.next('welcome')).agent, 'demo');
    assert.ok(await ws.next('agentState'));
    assert.ok(await ws.next('tick', 4000), 'the agent reads live ticks');
    ws.send({ type: 'note', kind: 'thinking', text: 'Sample: thinking about a made-up level' });
    let n; do { n = await a.next('agentNote', 3000); } while (n && n.kind !== 'thinking');
    assert.equal(n && n.text, 'Sample: thinking about a made-up level');
    const diag = JSON.parse((await get(port, '/diag')).body);
    assert.deepEqual(Object.keys(diag.agents.demo), ['connected', 'mode', 'killed', 'plans', 'proposals', 'placed', 'refused', 'heartbeatLost', 'flattenedAt', 'secretFile']);
    a.close(); ws.close();
  } finally { child.kill(); }
});

/* ---------------- the review of 19e9ef0 (lead's defaults, the C# builder has the same list) */
test('agents review S6a: before agentHello nothing is read, shown or kept; it is no heartbeat', async () => {
  const d = await makeAgentDesk();
  d.desk.agentConnect('demo', d.agentConn);
  const why = d.say({ type: 'plan', id: 'pre1', root: 'MNQ', side: 'buy', kind: 'limit', price: 25399, qty: 2, stopTicks: 16, targetTicks: 32, expireSec: 600, riskDollars: 16, setup: 'Sample', reason: 'Sample', confidence: 0.6, extra: 1 });
  assert.equal(why, 'send agentHello first');
  assert.equal(d.take('agentPlan').length, 0, 'never shown to the pages');
  assert.equal(d.desk.agents.get('demo').lastPlan, null, 'never lastPlan');
  assert.equal(d.say({ type: 'note', kind: 'look', text: 'Sample' }), 'send agentHello first');
  assert.equal(d.take('agentNote').length, 0);
  d.hello();
  assert.equal(d.plan({ id: 'pre1' }).why, null, 'a pre-hello id was never seen');
});

test('agents review S6f: a socket that never says hello, or says nothing, is closed after 5 s', async () => {
  const d = await makeAgentDesk(), closed = [];
  d.desk.closeAgentConn = c => closed.push(c);
  d.desk.agentConnect('demo', d.agentConn);
  d.silent(3000); d.say({ type: 'beat' });              // a beat before hello does not count
  d.silent(2500); d.desk.everySecond();
  assert.equal(closed.length, 1, 'no hello in 5 s: closed');
  assert.equal(d.desk.agents.get('demo').conn, null);
  d.hello(); d.silent(5100); d.desk.everySecond();
  assert.equal(closed.length, 2, '5 s of silence after hello: closed');
  assert.equal(d.desk.agents.get('demo').connected, false);
});

test('agents review S6b: the page cannot take an agent entry\'s stop or target away; other plan changes, moves and leg moves pass', async () => {
  const d = await makeAgentDesk();
  d.hello(); d.act({ type: 'agentMode', agent: 'demo', mode: 'auto' });
  d.plan({ price: 25390 });
  const entry = d.working('SIM-AG1').find(o => o.agentId === 'demo' && o.role === 'entry');
  for (const f of [{ stopTicks: null }, { stopTicks: 0 }, { targetTicks: null }, { targetTicks: 0 }])
    assert.equal(reasonOf(d.act(Object.assign({ type: 'plan', cid: 'x', id: entry.id }, f))), 'an agent\'s entry always has a stop and a target', JSON.stringify(f));
  assert.equal(reasonOf(d.act({ type: 'plan', cid: 'y', id: entry.id, stopTicks: 20, targetTicks: 40 })), null, 'other whole numbers of 1 or more');
  assert.deepEqual(entry.planned, { stopTicks: 20, targetTicks: 40 });
  assert.equal(reasonOf(d.act({ type: 'change', cid: 'z', id: entry.id, price: 25389 })), null, 'the entry price moves');
  d.tick(25388.75);
  const stop = d.working('SIM-AG1').find(o => o.role === 'stop');
  assert.equal(reasonOf(d.act({ type: 'change', cid: 'w', id: stop.id, price: stop.price + 1 })), null, 'a leg moves (an exit)');
  assert.equal(reasonOf(d.act({ type: 'cancel', cid: 'v', id: stop.id })), null, 'a leg cancels (an exit)');
});

test('agents review S6c, S6d: 18:00 ET starts the day over; a rules change never lifts a loss stand-down', async () => {
  const first = await makeAgentDesk({ at: Date.UTC(2026, 9, 8, 21, 0) });   // 17:00 New York; its first second comes after 18:00
  first.hello();
  const f = first.desk.agents.get('demo'); f.trades = 3; f.planIds.add('used');
  first.advance(2 * 3600000); first.desk.everySecond();
  assert.deepEqual([f.trades, f.planIds.has('used')], [0, false], 'the day is known from the start, not from the first second');
  const d = await makeAgentDesk({ at: Date.UTC(2026, 9, 8, 21, 0) });   // 17:00 New York
  d.hello(); d.desk.everySecond();
  const a = d.desk.agents.get('demo');
  a.trades = 3; a.losses = 2; a.pnl = -40; a.planIds.add('used'); a.standDown = '2 losing trades today: no new entries until 18:00 ET';
  d.act({ type: 'agentRules', cid: 'r', agent: 'demo', roots: 'NQ,MNQ', maxQtyNQ: 2, maxQtyMNQ: 20, entryFrom: '09:45', entryUntil: '15:00', flatAt: '15:55', maxExpireSec: 1800, maxTrades: 0, maxLosses: 5 });
  assert.equal(a.standDown, '2 losing trades today: no new entries until 18:00 ET', 'a looser rule never lifts it');
  d.advance(30 * 60000); d.desk.everySecond();                       // 17:30: the same day
  assert.equal(a.trades, 3);
  d.advance(31 * 60000); d.desk.everySecond();                       // 18:01: a new day
  assert.deepEqual([a.trades, a.losses, a.pnl, a.standDown, a.planIds.has('used')], [0, 0, 0, null, false]);
  assert.equal(d.V.tradingDay(Date.UTC(2026, 9, 8, 22, 1)), '2026-10-09');
  assert.equal(d.V.tradingDay(Date.UTC(2026, 9, 8, 21, 59)), '2026-10-08');
});

test('agents review S6h, S6i, S6k: the bot\'s and the copier\'s accounts whatever the switches; a refused id is used; auto refuses a gone account', async () => {
  const off = await makeAgentDesk({ switches: { bot: false, copier: false } });
  const r = m => reasonOf(off.act(Object.assign({ type: 'agentAccount', agent: 'demo' }, m)));
  assert.match(r({ account: 'Sim101' }), /the bot's account/, 'the bot switch off changes nothing');
  off.desk.copier.followers.set('EVAL-A', { account: 'EVAL-A', on: false, qty: 1, size: 'micro', lossLimit: null });
  assert.match(r({ account: 'EVAL-A' }), /copier follower/, 'the copier switch off changes nothing');
  const shared = await makeAgentDesk({ switches: { bot: false }, accounts: { demo: 'Sim101' } });
  shared.hello();
  assert.match(shared.plan().why, /^Sim101 is also the bot's account: choose an account for agent demo on the Agent tab \(an agent never shares an account\)$/);
  const d = await makeAgentDesk();
  d.hello();
  assert.match(d.plan({ id: 'bad1', qty: 99, riskDollars: 792 }).why, /from 1 to 20/);
  assert.match(d.plan({ id: 'bad1' }).why, /plan id bad1 was used today/, 'refused or not, a plan id is used once a day');
  d.desk.acct.get('SIM-AG1').state = 'gone';
  assert.match(reasonOf(d.act({ type: 'agentMode', agent: 'demo', mode: 'auto' })), /auto refused: SIM-AG1 is not tradable now/);
});

test('agents review S2: a refused duplicate never replaces the plan it copies; both are shown', async () => {
  const d = await makeAgentDesk();
  d.hello(); d.act({ type: 'agentMode', agent: 'demo', mode: 'copilot' }); d.take();
  d.plan({ id: 'dup1' });
  assert.match(d.plan({ id: 'dup1', side: 'sell', price: 25401 }).why, /used today/);
  const a = d.desk.agents.get('demo');
  assert.deepEqual(a.plans.map(p => p.id + ':' + p.result.split(':')[0]), ['dup1:proposed', 'dup1:refused']);
  assert.equal(a.lastPlan.result, 'proposed', 'lastPlan stays the plan that was not refused');
  assert.equal(d.take('agentPlan').length, 2, 'both go to the pages');
  assert.equal(a.proposals.get('dup1').state, 'open');
});

test('agents review S5: an account change puts the agent in shadow', async () => {
  const d = await makeAgentDesk();
  d.hello(); d.act({ type: 'agentMode', agent: 'demo', mode: 'auto' });
  d.desk.acct.get('SIM-F2').trade = true; d.desk.refreshAccounts(); d.desk.copier.followers.delete('SIM-F2');
  assert.equal(reasonOf(d.act({ type: 'agentAccount', agent: 'demo', account: 'SIM-F2' })), null);
  assert.equal(d.desk.agentMsg(d.desk.agents.get('demo')).mode, 'shadow');
  assert.equal(d.agentTake('welcome').pop().mode, 'shadow', 'the agent is told');
});

test('agents review V3: the checks run in the contract\'s order (a plan failing two gets the earlier reason); checks 2, 9, 10 and 11', async () => {
  const d = await makeAgentDesk();
  d.hello();
  // two failures each: the earlier check's reason
  assert.match(d.plan({ kind: 'market', qty: 99 }).why, /limit or a stop-limit/, '3 before 4');
  assert.match(d.plan({ qty: 99, riskDollars: 1 }).why, /from 1 to 20/, '4 before 5');
  assert.match(d.plan({ riskDollars: 1, expireSec: 5 }).why, /riskDollars/, '5 before 6');
  assert.match(d.plan({ expireSec: 5, price: 25401 }).why, /expireSec/, '6 before 11');
  d.act({ type: 'agentKill', agent: 'demo', on: true });
  assert.match(d.plan({ root: 'ES', riskDollars: 400 }).why, /kill switch/, '2 before 3');
  d.act({ type: 'agentKill', agent: 'demo', on: false });
  // check 2: the account tradable now
  d.act({ type: 'accountTrade', account: 'SIM-AG1', on: false });
  assert.match(d.plan().why, /SIM-AG1 is not tradable now/);
  d.act({ type: 'accountTrade', account: 'SIM-AG1', on: true });
  // check 9: maxTrades and maxLosses
  const a = d.desk.agents.get('demo');
  a.rules.maxTrades = 2; a.trades = 2;
  assert.match(d.plan().why, /has made 2 trades today/);
  a.rules.maxTrades = null; a.rules.maxLosses = 1; a.losses = 1;
  assert.match(d.plan().why, /1 losing trades today/);
  a.rules.maxLosses = null; a.losses = 0;
  // check 10: the owner lock (the page's own working entry on SIM-AG1 MNQ)
  d.act({ type: 'order', cid: 'o1', account: 'SIM-AG1', root: 'MNQ', side: 'buy', kind: 'limit', qty: 1, price: 25300 });
  assert.match(d.plan().why, /SIM-AG1 MNQ belongs to your own trading until it is flat/);
  d.act({ type: 'cancel', cid: 'o2', id: d.working('SIM-AG1').find(o => o.price === 25300).id });
  // check 11: the last trade over 300 s old
  d.advance(301000);
  assert.match(d.plan().why, /over 300 s old/);
  d.tick(25400);
  assert.equal(d.plan().why, null, 'all checks pass again');
});

/* ---------------- ChartBridge 0.5.0 as built (agent-channel fb15822, nt8/PROTOCOL.md "Agent channel as built"): the fake follows */
test('as built 1: after every agentHello a snapshot: a position per root (flat too) and its own working orders, as a v2 page gets them', async () => {
  const d = await makeAgentDesk();
  d.hello(); d.act({ type: 'agentMode', agent: 'demo', mode: 'auto' });
  d.plan({ price: 25400, qty: 1, riskDollars: 8 }); d.tick(25399.75);       // filled: a position and its two legs
  d.plan({ id: 'more', price: 25390 });                                   // refused (one at a time); nothing more works
  d.agentTake();
  d.hello();                                                              // a second hello: welcome, agentState and the snapshot again
  const got = d.agentTake();
  assert.deepEqual(got.slice(0, 2).map(m => m.type), ['welcome', 'agentState']);
  const pos = got.filter(m => m.type === 'position'), ords = got.filter(m => m.type === 'order');
  assert.deepEqual(pos.map(p => p.root + ':' + p.qty), ['NQ:0', 'MNQ:1'], 'one per root of the agent, a flat one included');
  assert.deepEqual(ords.map(o => o.role).sort(), ['stop', 'target'], 'its own working orders: the legs');
  assert.ok(ords.every(o => o.by === undefined && o.tradable === undefined), 'as a v2 page gets them: no by, no tradable');
});

test('as built 2: the owner lock: a page exit is MARKET only; a resting exit is refused with the page\'s words; the bot "until it is flat"', async () => {
  const d = await makeAgentDesk({ accounts: { demo: 'Sim101' } });
  d.desk.botAccount = 'SIM-F2'; d.desk.copier.leader = 'FUNDED-C'; d.desk.copier.followers.delete('SIM-F2'); d.desk.acct.get('SIM-F2').trade = true; d.desk.refreshAccounts();
  d.hello(); d.act({ type: 'agentMode', agent: 'demo', mode: 'auto' });
  d.plan({ price: 25400 }); d.tick(25399.75);                             // long 2 MNQ on Sim101, owned by demo
  const words = 'Sim101 MNQ belongs to agent demo: use Flatten, or move its stop or target';
  const o = f => reasonOf(d.act(Object.assign({ type: 'order', cid: 'c' + Math.random(), account: 'Sim101', root: 'MNQ', side: 'sell', qty: 1 }, f)));
  assert.equal(o({ kind: 'limit', price: 25420 }), words, 'a resting limit exit could outlive the position');
  assert.equal(o({ kind: 'stop', price: 25380 }), words);
  assert.equal(o({ kind: 'mit', price: 25420 }), words);
  assert.equal(o({ kind: 'market', bracket: { stop: 8, target: 8 } }), words, 'a market order with a bracket is not an exit');
  assert.equal(o({ kind: 'market', qty: 3 }), words, 'more than the position would open one the other way');
  assert.equal(o({ kind: 'market', side: 'buy' }), words, 'adding is an entry');
  assert.equal(o({ kind: 'market' }), null, 'a market order that only reduces is an exit');
  // the bot on the same pair: "until it is flat"
  d.desk.botAccount = 'Sim101'; d.desk.botRoot = 'MNQ';
  assert.match(d.desk.botPlace({ id: 'b', side: 'buy', kind: 'market', stopTicks: 8, targetTicks: 8 }), /Sim101 MNQ belongs to agent demo until it is flat|the bot's account/);
  d.desk._orderSource = 'bot';
  assert.equal(d.desk.agentLockFor('Sim101', 'MNQ', 'bot', { kind: 'market', side: 'sell', qty: 1 }), 'Sim101 MNQ belongs to agent demo until it is flat');
  d.desk._orderSource = null;
});

test('as built 3: refused plans reach the pages at most once a second per agent; the next one shown says how many were held', async () => {
  const d = await makeAgentDesk();
  d.hello(); d.take(); d.agentTake();
  for (let i = 0; i < 4; i++) d.plan({ id: 'r' + i, qty: 99, riskDollars: 792 });   // 4 refusals within 0.5 s
  const shown = d.take('agentPlan');
  assert.equal(shown.length, 1, 'one a second');
  assert.equal(d.agentTake('reject').length, 4, 'every one is still answered to the agent');
  d.advance(1000);
  d.plan({ id: 'r9', qty: 99, riskDollars: 792 });
  const next = d.take('agentPlan')[0];
  assert.match(next.result, /^refused: qty must be a whole number from 1 to 20 \(maxQty\.MNQ\) \(and 3 more refused plans in the second before, not shown\)$/);
  d.advance(1000); d.plan({ id: 'r10', qty: 99, riskDollars: 792 }); d.plan({ id: 'r11', qty: 99, riskDollars: 792 });
  d.advance(1000); d.plan({ id: 'r12', qty: 99, riskDollars: 792 });
  assert.match(d.take('agentPlan').pop().result, /\(and 1 more refused plan in the second before, not shown\)$/, 'one: "plan"');
  assert.equal(d.desk.agentMsg(d.desk.agents.get('demo')).lastPlan.id, 'r12', 'a held one is never lastPlan');
});

test('as built 4: a cancel not confirmed goes again every 3 s, with a status warning from the second try', async () => {
  const d = await makeAgentDesk();
  d.hello(); d.act({ type: 'agentMode', agent: 'demo', mode: 'auto' });
  d.plan({ price: 25390 }); d.take();
  const a = d.desk.agents.get('demo'), entry = d.working('SIM-AG1').find(o => o.agentId === 'demo');
  a.stuckCancels = 2;                                                     // NinjaTrader leaves the first two unconfirmed
  d.act({ type: 'agentKill', agent: 'demo', on: true }); d.take();
  assert.equal(entry.state, 'working', 'the first cancel is not confirmed');
  d.advance(2000); d.desk.everySecond();
  assert.equal(d.take('status').length, 0, 'not before 3 s');
  d.advance(1000); d.desk.everySecond();
  const w = d.take('status');
  assert.equal(w.length, 1); assert.equal(w[0].level, 'warn');
  assert.match(w[0].text, /^Agent demo: the cancel of its entry CB#nt\d+ ag:demo s16 t32 on SIM-AG1 was not confirmed in 3 s \(the kill switch\); ChartBridge sends it again every 3 s until it is done; check NinjaTrader$/);
  assert.equal(entry.state, 'working');
  d.advance(3000); d.desk.everySecond();
  assert.equal(d.take('status').length, 1, 'the third try warns too');
  assert.equal(entry.state, 'cancelled', 'and is confirmed');
});

test('as built 5: the backstop cancels any agent entry while killed, in shadow, stood down or outside its window; a restart is shadow', async () => {
  const d = await makeAgentDesk();
  d.hello(); d.act({ type: 'agentMode', agent: 'demo', mode: 'auto' });
  const a = d.desk.agents.get('demo');
  const place = () => { d.plan({ price: 25390 }); return d.working('SIM-AG1').find(o => o.agentId === 'demo' && o.role === 'entry'); };
  let e = place(); a.mode = 'shadow';                                   // however it came to be working
  d.desk.everySecond();
  assert.equal(e.state, 'cancelled', 'shadow');
  a.mode = 'auto'; e = place(); a.killed = true; d.desk.everySecond();
  assert.equal(e.state, 'cancelled', 'killed');
  a.killed = false; e = place(); a.standDown = 'Sample: stood down'; d.desk.everySecond();
  assert.equal(e.state, 'cancelled', 'stood down');
  a.standDown = null; e = place();
  d.advance(5 * 3600000); d.desk.tick('MNQ', 25400); d.desk.everySecond();   // 15:00 New York: outside the window
  assert.equal(e.state, 'cancelled', 'outside its window');
  // before entryFrom too, and an open proposal expires there
  const m = await makeAgentDesk({ at: Date.UTC(2026, 9, 8, 13, 40) });       // 09:40 New York
  m.hello(); m.desk.agents.get('demo').mode = 'copilot';
  m.desk.agents.get('demo').proposals.set('x', { type: 'agentProposal', agent: 'demo', id: 'x', state: 'open', expiresAt: m.now() + 600000 });
  m.desk.everySecond();
  assert.equal(m.desk.agents.get('demo').proposals.get('x').state, 'expired', 'an open proposal expires outside the window');
  // a restart: every agent in shadow, its pre-restart entry cancelled at the first pass
  const r = await makeAgentDesk();
  r.hello(); r.act({ type: 'agentMode', agent: 'demo', mode: 'auto' });
  r.plan({ price: 25390 });
  const pre = r.working('SIM-AG1').find(o => o.agentId === 'demo');
  r.desk.simulateRestart(false);
  assert.equal(r.desk.agents.get('demo').mode, 'shadow');
  r.desk.everySecond();
  assert.equal(pre.state, 'cancelled', 'a pre-restart entry is cancelled');
});

test('as built 6: the flat hours run to the next entryFrom; an account NinjaTrader no longer lists: NOT FLAT every 10 s, then the flatten goes on', async () => {
  const d = await makeAgentDesk();
  d.hello(); d.act({ type: 'agentMode', agent: 'demo', mode: 'auto' });
  d.plan({ price: 25400 }); d.tick(25399.75);
  const a = d.desk.agents.get('demo');
  d.desk.agentDrop('demo', 'the agent disconnected');
  d.desk.unlisted.add('SIM-AG1');
  d.advance(22 * 3600000); d.desk.tick('MNQ', 25399.5); d.take();       // 08:00 New York the next day: before entryFrom
  d.desk.everySecond();
  const st = d.take('status');
  assert.ok(st.some(s => s.level === 'info' && s.text === 'demo held a position outside its trading hours (15:55 to 09:45): flattened by its rules'), JSON.stringify(st.map(s => s.text)));
  const e1 = st.filter(s => s.level === 'error');
  assert.equal(e1.length, 1);
  assert.equal(e1[0].text, 'Agent demo: NOT FLAT? its flatten (outside its trading hours) waits: SIM-AG1 (account not listed by NinjaTrader); it goes on when the account is back; check NinjaTrader now');
  assert.ok(d.desk.agentMsg(a).position, 'nothing is sent to an account NinjaTrader does not list');
  d.advance(5000); d.desk.everySecond();
  assert.equal(d.take('status').filter(s => s.level === 'error').length, 0);
  d.advance(5000); d.desk.everySecond();
  assert.equal(d.take('status').filter(s => s.level === 'error').length, 1, 'every 10 s');
  d.desk.unlisted.delete('SIM-AG1'); d.advance(1000); d.desk.everySecond();
  assert.equal(d.desk.agentMsg(a).position, null, 'the account is back: flattened');
  assert.equal(a.flatJob, null);
});

test('as built: only a chosen account is the agent\'s; a clash stands the agent down; rules, the skip, placed, checks 3 and 4, execs', async () => {
  // demo sits on its unchosen default Sim101: the bot keeps Sim101, the copier may list it, demo stands down in plain words
  const d = await makeAgentDesk({ accounts: {} });
  d.hello();
  assert.equal(d.desk.agentMsg(d.desk.agents.get('demo')).standDown, 'Sim101 is also the bot\'s account: choose an account for agent demo on the Agent tab (an agent never shares an account)');
  assert.match(reasonOf(d.act({ type: 'agentMode', agent: 'demo', mode: 'auto' })), /auto refused: Sim101 is also the bot's account/);
  d.act({ type: 'botAccount', account: 'EVAL-A' });
  assert.equal(d.desk.botAccount, 'EVAL-A');
  d.act({ type: 'copierSet', leader: 'FUNDED-C' });
  assert.equal(d.desk.agentMsg(d.desk.agents.get('demo')).standDown, null, 'nothing else on Sim101 now: no clash');
  d.act({ type: 'botAccount', account: 'Sim101' });
  assert.equal(d.desk.botAccount, 'Sim101', 'an unchosen default claims Sim101 against nobody');
  // chosen: the bot refuses it
  d.act({ type: 'botAccount', account: 'EVAL-A' });
  d.act({ type: 'agentAccount', agent: 'demo', account: 'SIM-AG1' });
  assert.match(reasonOf(d.act({ type: 'botAccount', account: 'SIM-AG1' })), /agent demo's account/);
  // rules: a chosen root's maxQty left out is its ceiling; a root not chosen takes only 0
  assert.equal(reasonOf(d.act({ type: 'agentRules', agent: 'demo', roots: 'MNQ', maxQtyNQ: 0, entryFrom: '09:45', entryUntil: '15:00', flatAt: '15:55', maxExpireSec: 900, maxTrades: 0, maxLosses: 0 })), null);
  assert.deepEqual(d.desk.agentMsg(d.desk.agents.get('demo')).rules.maxQty, { MNQ: 20 });
  assert.deepEqual(d.desk.agentMsg(d.desk.agents.get('demo')).rules.roots, ['MNQ']);
  d.act({ type: 'agentRules', agent: 'demo', roots: 'NQ,MNQ', entryFrom: '09:45', entryUntil: '15:00', flatAt: '15:55', maxExpireSec: 1800, maxTrades: 0, maxLosses: 0 });
  // the skip carries every plan key; placed says the order and until when; check 3 and 4
  d.hello(); d.take(); d.agentTake();
  d.say({ type: 'skip', id: 'sk', reason: 'Sample' });
  const sk = d.take('agentPlan')[0];
  for (const k of ['root', 'side', 'kind', 'price', 'qty', 'stopTicks', 'targetTicks', 'expireSec', 'riskDollars', 'setup', 'confidence']) assert.equal(sk[k], null, 'skip ' + k);
  d.act({ type: 'agentMode', agent: 'demo', mode: 'auto' });
  d.plan({ id: 'pl', price: 25390 });
  assert.match(d.agentTake('answer').pop().text, /^placed on SIM-AG1 as order NT\d+; it works until \d{4}-\d\d-\d\dT/);
  const off = await makeAgentDesk({ switches: { orderTypes: false } });
  off.hello();
  assert.match(off.plan({ kind: 'stopLimit', price: 25401, limitPrice: 25402 }).why, /stop-limit orders are off/);
  const capped = await makeAgentDesk();
  capped.desk.config.maxQty = { MNQ: 3, NQ: 2 };
  capped.hello();
  assert.match(capped.plan({ qty: 4, riskDollars: 32 }).why, /from 1 to 3/, 'config.txt\'s gate 3 cap holds for agents');
  capped.desk.config.maxBracketTicks = 20;
  assert.match(capped.plan({ targetTicks: 40 }).why, /at most 20 \(maxBracketTicks/);
  // execs: only for its own orders
  const x = await makeAgentDesk();
  x.hello(); x.agentTake();
  x.act({ type: 'order', cid: 'own', account: 'SIM-AG1', root: 'ES', side: 'buy', kind: 'market', qty: 1 });
  assert.equal(x.agentTake('exec').length, 0, 'Anthony\'s fill on its account is not the agent\'s');
});
