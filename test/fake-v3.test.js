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
  // archive: only a gone account, only with confirm
  assert.match(reasonOf(d.act({ type: 'accountArchive', account: 'EVAL-A', confirm: true })), /not gone/);
  d.desk.setConnection('FUNDED-C', 'disabled'); d.advance(1100); d.desk.checkGone(); d.take();
  assert.match(reasonOf(d.act({ type: 'accountArchive', account: 'FUNDED-C', confirm: false })), /confirm: true/);
  d.act({ type: 'accountArchive', account: 'FUNDED-C', confirm: true });
  const msg = d.desk.accountsMsg();
  assert.ok(!msg.list.some(x => x.name === 'FUNDED-C')); assert.equal(msg.archived[0].name, 'FUNDED-C');
  assert.ok(d.desk.log.some(l => l.who === 'FUNDED-C' && /archived/.test(l.what)));
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
