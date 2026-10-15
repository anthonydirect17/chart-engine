'use strict';
// live/groups.js (chart 1.26.0, ChartBridge 0.5.8): the pure parts of the account groups, and the fake bridge's groups
// (test/fake-groups.mjs) against the contract (nt8/PROTOCOL.md "Prop groups and account state (0.5.8)"). Made-up names and
// money only (Lucid, Apex, SIM-A, EVAL-A).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const GC = require('../live/groups.js');
const AC = require('../live/accounts.js');

const lucid = { id: 'g1', name: 'Lucid', noHedge: true, dailyLoss: 1000, drawdown: 2000, drawdownType: 'eod', target: 3000, size: 50000, lockAt: 50100, members: ['SIM-A', 'SIM-B'], side: null, holders: [] };

test('groups: money words and boxes', () => {
  assert.equal(GC.usd(50000), '$50,000');
  assert.equal(GC.usd(1000.5), '$1,000.50');
  assert.equal(GC.usd(null), '');
  assert.equal(GC.parseMoney(''), 0);
  assert.equal(GC.parseMoney('$50,000'), 50000);
  assert.equal(GC.parseMoney(' 1000.55 '), 1000.55);
  assert.ok(Number.isNaN(GC.parseMoney('1000.555')) && Number.isNaN(GC.parseMoney('-5')) && Number.isNaN(GC.parseMoney('5e3')) && Number.isNaN(GC.parseMoney('abc')));
  assert.equal(GC.moneyBox(null), ''); assert.equal(GC.moneyBox(48000), '48000');
});

test('groups: the rules line, the members and the side in words', () => {
  assert.equal(GC.summary(lucid), '$50,000 · daily $1,000 · drawdown $2,000 end of day, stops at $50,100 · target $3,000');
  assert.equal(GC.summary(Object.assign({}, lucid, { dailyLoss: null, target: null, lockAt: null, drawdownType: 'static' })), '$50,000 · daily none · drawdown $2,000 static · target none');
  assert.equal(GC.membersText(lucid), '2 accounts');
  assert.equal(GC.sideText(lucid), 'flat');
  assert.equal(GC.sideText(Object.assign({}, lucid, { side: 'long', holders: [{ account: 'SIM-A', root: 'MNQ', side: 'long', what: 'position', qty: 2 }, { account: 'SIM-B', root: 'NQ', side: 'long', what: 'entry', qty: 1 }] })),
    'long (SIM-A +2 MNQ; SIM-B buy 1 NQ working)');
  assert.match(GC.sideText(Object.assign({}, lucid, { side: 'mixed', holders: [] })), /^long and short/);
});

test('groups: the rules dialog checks as ChartBridge does, and builds groupSave with every field', () => {
  const f = { name: 'Apex', size: '50,000', dailyLoss: '', drawdown: '2500', drawdownType: 'intraday', lockAt: '', target: '3000', noHedge: true };
  const r = GC.groupMessage(f, [lucid], null, 'c1');
  assert.deepEqual(r.msg, { type: 'groupSave', cid: 'c1', name: 'Apex', noHedge: true, dailyLoss: 0, drawdown: 2500, drawdownType: 'intraday', target: 3000, size: 50000, lockAt: 0 });
  const bad = (change, field, words) => { const x = GC.groupMessage(Object.assign({}, f, change), [lucid], null); assert.equal(x.field, field, JSON.stringify(x)); assert.match(x.error, words); };
  bad({ name: '' }, 'name', /1 to 30/);
  bad({ name: 'x'.repeat(31) }, 'name', /1 to 30/);
  bad({ name: 'LUCID' }, 'name', /is there already/);
  bad({ name: 'Say "hi"' }, 'name', /plain/);
  bad({ size: '' }, 'size', /more than \$0/);
  bad({ drawdown: '50000' }, 'drawdown', /less than the account size/);
  bad({ dailyLoss: '10.123' }, 'dailyLoss', /2 decimals/);
  bad({ drawdownType: 'static', lockAt: '50100' }, 'lockAt', /trailing drawdown only/);
  bad({ lockAt: '47500' }, 'lockAt', /above the starting floor \(\$47,500\)/);
  bad({ drawdownType: 'daily' }, 'drawdownType', /end of day, intraday or static/);
  assert.equal(GC.groupMessage(Object.assign({}, f, { name: 'Lucid' }), [lucid], 'g1').msg.group, 'g1', 'its own name is fine when editing it');
  // Rename and the switch send the whole group (the contract asks every field)
  assert.deepEqual(GC.saveFrom(lucid, { name: 'Lucid Flex' }, 'c2'), { type: 'groupSave', cid: 'c2', group: 'g1', name: 'Lucid Flex', noHedge: true, dailyLoss: 1000, drawdown: 2000, drawdownType: 'eod', target: 3000, size: 50000, lockAt: 50100 });
  assert.equal(GC.saveFrom(Object.assign({}, lucid, { dailyLoss: null, target: null, lockAt: null }), { noHedge: false }).dailyLoss, 0);
  assert.deepEqual(GC.formOf(lucid), { name: 'Lucid', size: '50000', dailyLoss: '1000', drawdown: '2000', drawdownType: 'eod', lockAt: '50100', target: '3000', noHedge: true });
});

test('groups: G2 (b) the highest close prefill, accountGroup and accountLimits', () => {
  assert.equal(GC.highCloseDefault(lucid, { balance: 49500 }), 50000);
  assert.equal(GC.highCloseDefault(lucid, { balance: 51240.5 }), 51240.5);
  assert.deepEqual(GC.joinMessage('SIM-A', 'g1', '51,240.50', 'c').msg, { type: 'accountGroup', cid: 'c', account: 'SIM-A', group: 'g1', highClose: 51240.5 });
  assert.deepEqual(GC.joinMessage('SIM-A', 'g1', '').msg, { type: 'accountGroup', account: 'SIM-A', group: 'g1' }, 'empty: no highClose (ChartBridge takes the prefill rule)');
  assert.deepEqual(GC.joinMessage('SIM-A', null, '5').msg, { type: 'accountGroup', account: 'SIM-A', group: null }, 'None never carries highClose');
  assert.match(GC.joinMessage('SIM-A', 'g1', 'x').error, /Highest close/);
  assert.deepEqual(GC.limitsMessage('SIM-D', '45,000', '').msg, { type: 'accountLimits', account: 'SIM-D', floor: 45000, dailyLoss: 0 });
  assert.equal(GC.limitsMessage('SIM-D', 'x', '').field, 'floor');
});

test('groups: cleanGroups keeps the contract\'s shape and drops anything malformed', () => {
  const out = GC.cleanGroups({ type: 'groups', list: [lucid, { id: 'bad', name: 'X' }, null, { id: 'g2', name: 'Apex', side: 'sideways', members: ['A', 3] }], error: null });
  assert.equal(out.length, 2);
  assert.equal(out[1].side, null);
  assert.deepEqual(out[1].members, ['A']);
  assert.deepEqual(GC.cleanGroups(null), []);
});

test('accounts: limitState prefers ChartBridge 0.5.8\'s roomFloor, roomDaily and targetLeft; old fields as before', () => {
  const a = { name: 'SIM-A', pnlToday: -600, roomDrawdown: null, roomDailyLoss: null, group: 'g1', floor: 49000, roomFloor: 1700, roomDaily: 400, targetLeft: 2500, src: { roomFloor: 'computed' } };
  const s = AC.limitState(a, null, lucid);
  assert.equal(s.cb, true); assert.equal(s.closer, 'dl'); assert.equal(s.dl.limit, 1000); assert.equal(s.dd.limit, 2000);
  assert.equal(Math.round(s.pct * 100), 60); assert.equal(s.level, '');
  assert.equal(AC.limitText(s), '$400.00 daily · $1,700.00 to floor · $2,500.00 to target (60% used)');
  const red = AC.limitState(Object.assign({}, a, { roomDaily: 50 }), null, lucid);
  assert.equal(red.level, 'red');
  assert.equal(AC.limitState(Object.assign({}, a, { roomFloor: -1 }), null, lucid).level, 'red', 'at or below 0: red');
  // a personal account with its own daily limit
  const p = AC.limitState({ name: 'SIM-D', roomFloor: 2200, roomDaily: 300, myDailyLoss: 500, targetLeft: null, src: { roomFloor: 'computed' } }, null, null);
  assert.equal(p.dl.limit, 500); assert.equal(Math.round(p.pct * 100), 40);
  // an older ChartBridge: exactly as 1.25
  assert.equal(AC.limitText(AC.limitState({ roomDrawdown: 1740.5, roomDailyLoss: 820, pnlToday: -180 }, null)), 'DD $1,740.50 · DL $820.00 (18% used)');
});

test('the fake bridge\'s groups (test/fake-groups.mjs): the contract\'s messages, refusals and the one-direction check', async () => {
  const { OrderDeskV3 } = await import('./fake-v3.mjs');
  const sent = [], conn = { authed: true, v3: true, origin: 'http://localhost:8765' };
  const desk = new OrderDeskV3({ config: { trading: true, tradeAccounts: ['EVAL-A', 'EVAL-B'], maxQty: { MNQ: 5 }, allowOrigins: [] }, instruments: { MNQ: { name: 'MNQ 12-26', tick: 0.25, pointValue: 2 } },
    knownAccounts: ['EVAL-A', 'EVAL-B'], token: 't', send: (c, m) => sent.push(m), conns: () => [conn], barTime: () => 0, now: () => 0,
    accountList: [{ name: 'EVAL-A', balance: 50000 }, { name: 'EVAL-B', balance: 50000 }], ownOrigin: 'http://localhost:8765' });
  desk.origin = () => 'http://localhost:8765';
  const say = m => { const before = sent.length; desk.handle(conn, m, JSON.stringify(m)); return sent.slice(before); };
  let r = say({ type: 'groupSave', cid: 'a', name: 'Lucid', noHedge: true, dailyLoss: 1000, drawdown: 2000, drawdownType: 'eod', target: 0, size: 50000, lockAt: 0 });
  const g = r.find(m => m.type === 'groups');
  assert.ok(g && g.list[0].id === 'g1' && g.list[0].target === null && g.error === null, JSON.stringify(r));
  r = say({ type: 'groupSave', cid: 'b', name: 'lucid', noHedge: true, dailyLoss: 0, drawdown: 2000, drawdownType: 'eod', target: 0, size: 50000, lockAt: 0 });
  assert.match(r[0].reason, /is there already/);
  say({ type: 'accountGroup', cid: 'c', account: 'EVAL-A', group: 'g1', highClose: 51000 });
  say({ type: 'accountGroup', cid: 'd', account: 'EVAL-B', group: 'g1' });
  const acc = desk.accountsMsg().list.find(a => a.name === 'EVAL-A');
  assert.equal(acc.group, 'g1'); assert.equal(acc.floor, 49000); assert.equal(acc.roomFloor, 1000); assert.equal(acc.roomDaily, 1000); assert.equal(acc.why.targetLeft, 'group Lucid has no profit target');
  r = say({ type: 'accountLimits', cid: 'e', account: 'EVAL-A', floor: 1, dailyLoss: 0 });
  assert.match(r[0].reason, /its group's rules apply/);
  desk.positions.set('EVAL-A|MNQ', { qty: 2, avgPrice: 25000 });
  assert.match(desk.check_order({ account: 'EVAL-B', root: 'MNQ', side: 'sell', kind: 'market', qty: 1 }), /^Group Lucid is long \(EVAL-A \+2 MNQ\): a sell on EVAL-B would hedge the group; prop firms ban hedged accounts\. Exits and flattens still work\.$/);
  assert.equal(desk.groupEntryCheck({ account: 'EVAL-A', root: 'MNQ', side: 'sell', kind: 'market', qty: 2 }), null, 'an exit of its own position');
  r = say({ type: 'groupDelete', cid: 'f', group: 'g1' });
  assert.equal(desk.accountsMsg().list.find(a => a.name === 'EVAL-A').group, null);
  // the fake's keys are the C#'s
  const cs = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'ChartBridgeGroups.cs'), 'utf8');
  const { GROUP_KEYS } = await import('./fake-groups.mjs');
  for (const [type, keys] of Object.entries(GROUP_KEYS)) assert.ok(cs.includes('{ "' + type + '", new[] { ' + keys.map(k => '"' + k + '"').join(', ') + ' } }'), type);
});
