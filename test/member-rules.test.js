'use strict';
// Chart 1.33.0 and ChartBridge 0.6.5 (Anthony 2026-10-19, PRIORITY): a group of accounts of different types and sizes, each member
// with its own rules. The page's pure parts (live/groups.js GroupsCore: the rules from The Desk, the seed floor, the form's checks,
// the messages, the risk words), the fake bridge's mirror of ChartBridgeGroups.cs (test/fake-groups.mjs, the same numbers and words
// as nt8/check/GroupsHarness.cs MemberRules), and the source checks. Made-up accounts, types and money only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const GC = require('../live/groups.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

/* three made-up Lucid types as The Desk's GET /api/account-types sends them, cleaned */
const TYPES = GC.cleanTypes({ types: [
  { id: 'lucid-flex-150k-eval', firm: 'Lucid', name: 'LucidFlex 150K Eval', account_type: 'eval', account_size: 150000, daily_loss: null, drawdown: 4500, drawdown_type: 'eod', lock_at: 150100, profit_target: 9000, consistency_pct: 50, max_nq: 10, max_mnq: 100, status: 'checked', version: 2 },
  { id: 'lucid-flex-50k-eval', firm: 'Lucid', name: 'LucidFlex 50K Eval', account_type: 'eval', account_size: 50000, daily_loss: null, drawdown: 2000, drawdown_type: 'eod', lock_at: 50100, profit_target: 3000, consistency_pct: 50, max_nq: 4, max_mnq: 40, status: 'checked', version: 2 },
  { id: 'lucid-daily-25k-eval', firm: 'Lucid', name: 'LucidDaily 25K Eval', account_type: 'eval', account_size: 25000, daily_loss: 500, drawdown: 1000, drawdown_type: 'intraday', lock_at: 25100, profit_target: 1250, consistency_pct: null, max_nq: 2, max_mnq: 20, status: 'not_checked', version: 1 },
  { id: 'half-type', firm: 'Other', name: 'Half 50K', account_size: 50000, drawdown: null, drawdown_type: 'eod', status: 'not_checked', version: 0 },
] }).types;
const at = (id, name) => ({ id, firm: 'Lucid', name, version: 2, status: 'checked' });
const deskRow = o => Object.assign({ daily_loss_limit: null, trailing_drawdown: null, account_size: null, source: {}, seedFloor: null, seedDate: null, seedBalance: null, accountType: null }, o);

test('1.33.0 deskRules: an account\'s rules come from its type on The Desk, no picking or typing', () => {
  const r = GC.deskRules(deskRow({ accountType: at('lucid-flex-150k-eval', 'LucidFlex 150K Eval') }), TYPES);
  assert.deepEqual(r.rules, { size: 150000, dailyLoss: 0, drawdown: 4500, lockAt: 150100, target: 9000, consistency: 50, drawdownType: 'eod', maxMinis: 10, maxMicros: 100, typeId: 'lucid-flex-150k-eval' });
  assert.equal(r.from, 'Lucid LucidFlex 150K Eval');
  assert.deepEqual(r.overrides, []);
  const d = GC.deskRules(deskRow({ accountType: at('lucid-daily-25k-eval', 'LucidDaily 25K Eval') }), TYPES);
  assert.equal(d.rules.drawdownType, 'intraday'); assert.equal(d.rules.dailyLoss, 500); assert.equal(d.rules.lockAt, 25100);
  assert.equal(d.from, 'Lucid LucidDaily 25K Eval (not checked)', 'a type not checked says so');
});

test('1.33.0 deskRules: a number set on the account itself on The Desk wins over its type (source "account")', () => {
  const row = deskRow({ accountType: at('lucid-flex-50k-eval', 'LucidFlex 50K Eval'), daily_loss_limit: 1200, trailing_drawdown: 2500, account_size: 50000,
    source: { daily_loss_limit: 'account', trailing_drawdown: 'account', account_size: 'type' } });
  const r = GC.deskRules(row, TYPES);
  assert.equal(r.rules.dailyLoss, 1200); assert.equal(r.rules.drawdown, 2500); assert.equal(r.rules.size, 50000);
  assert.deepEqual(r.overrides, ['daily loss $1,200', 'drawdown $2,500'], 'only the account\'s own numbers are named; a type number (source "type") is the type\'s');
  const p = GC.deskRules(deskRow({ accountType: at('lucid-flex-50k-eval', 'x'), daily_loss_limit: 900, source: { daily_loss_limit: 'prop' } }), TYPES);
  assert.equal(p.rules.dailyLoss, 0, 'a number from the prop tracker (source "prop") does not override the type');
});

test('1.33.0 deskRules: nothing to take the rules from gives the reason (the page shows the full form)', () => {
  assert.equal(GC.deskRules(deskRow({}), TYPES).error, 'no account type on The Desk');
  assert.equal(GC.deskRules(null, TYPES).error, 'no account type on The Desk');
  assert.match(GC.deskRules(deskRow({ accountType: at('gone-type', 'Gone 50K') }), TYPES).error, /is not on The Desk's list now/);
  assert.match(GC.deskRules(deskRow({ accountType: { id: 'half-type', firm: 'Other', name: 'Half 50K' } }), TYPES).error, /has no drawdown size/);
});

test('1.33.0 seedHigh: the highest close prefilled from The Desk\'s seed floor plus the drawdown, else none', () => {
  const rules = { drawdown: 2000 };
  assert.deepEqual(GC.seedHigh(deskRow({ seedFloor: 49234.5, seedDate: '2026-10-17' }), rules), { value: 51234.5, date: '2026-10-17', words: 'The Desk\'s seed floor $49,234.50 (2026-10-17) plus the drawdown $2,000' });
  assert.equal(GC.seedHigh(deskRow({}), rules), null, 'The Desk has no seed for it: asked as now');
  assert.equal(GC.seedHigh(deskRow({ seedFloor: 49000 }), null), null);
});

test('1.33.0 rulesCheck and memberRulesMessage: ChartBridge\'s checks, with the max size', () => {
  const f = GC.rulesForm({ size: 25000, dailyLoss: 500, drawdown: 1000, drawdownType: 'intraday', lockAt: 25100, target: 1250, maxMinis: 2, maxMicros: 20, typeId: 'lucid-daily-25k-eval' });
  assert.deepEqual(f, { size: '25000', dailyLoss: '500', drawdown: '1000', drawdownType: 'intraday', lockAt: '25100', target: '1250', consistency: '', maxMinis: '2', maxMicros: '20', typeId: 'lucid-daily-25k-eval' });
  assert.deepEqual(GC.memberRulesMessage('SIM-C', f, 'c1').msg, { type: 'memberRules', cid: 'c1', account: 'SIM-C', size: 25000, dailyLoss: 500, drawdown: 1000, drawdownType: 'intraday', lockAt: 25100, target: 1250, consistency: 0, maxMinis: 2, maxMicros: 20, typeId: 'lucid-daily-25k-eval' });
  for (const [change, field, words] of [[{ drawdown: '25000' }, 'drawdown', /less than the account size/], [{ drawdownType: 'static' }, 'lockAt', /trailing drawdown only/], [{ lockAt: '24000' }, 'lockAt', /above the starting floor/],
    [{ maxMinis: '1001' }, 'maxMinis', /whole contracts from 1 to 1000/], [{ maxMicros: '2.5' }, 'maxMicros', /whole contracts/], [{ size: '' }, 'size', /more than \$0/]]) {
    const r = GC.rulesCheck(Object.assign({}, f, change));
    assert.equal(r.field, field, JSON.stringify(change)); assert.match(r.error, words);
  }
  assert.equal(GC.rulesCheck(Object.assign({}, f, { maxMinis: '', maxMicros: '' })).rules.maxMinis, 0, 'empty is none');
});

test('1.33.0 joinMessage: the rules go with the join; without them (an older ChartBridge) the 1.26.0 message exactly', () => {
  const r = GC.deskRules(deskRow({ accountType: at('lucid-flex-50k-eval', 'LucidFlex 50K Eval') }), TYPES).rules;
  assert.deepEqual(GC.joinMessage('SIM-B', 'g1', '51000', 'j', 'Highest close so far', r).msg, { type: 'accountGroup', cid: 'j', account: 'SIM-B', group: 'g1', size: 50000, dailyLoss: 0, drawdown: 2000, drawdownType: 'eod', lockAt: 50100, target: 3000, consistency: 50, maxMinis: 4, maxMicros: 40, typeId: 'lucid-flex-50k-eval', highClose: 51000 });
  assert.deepEqual(GC.joinMessage('SIM-B', 'g1', '', 'j').msg, { type: 'accountGroup', cid: 'j', account: 'SIM-B', group: 'g1' });
  assert.deepEqual(GC.joinMessage('SIM-B', null, '', 'j', 'x', r).msg, { type: 'accountGroup', cid: 'j', account: 'SIM-B', group: null }, 'None never carries rules');
});

test('1.33.0 the groups message: perMember, riskPct and ownRules from ChartBridge 0.6.5; an older one is one rule set', () => {
  const g = { id: 'g1', name: 'Lucid', noHedge: true, drawdown: 2000, drawdownType: 'eod', size: 50000, members: ['SIM-A', 'SIM-B'], holders: [] };
  const old = GC.cleanGroups({ list: [g] })[0];
  assert.equal(old.perMember, false); assert.equal(old.riskPct, null);
  const now = GC.cleanGroups({ list: [Object.assign({}, g, { riskPct: 10, ownRules: ['SIM-A'] })] })[0];
  assert.equal(now.perMember, true); assert.equal(now.riskPct, 10); assert.deepEqual(now.ownRules, ['SIM-A']);
  assert.equal(GC.perMemberVersion('0.6.5'), true); assert.equal(GC.perMemberVersion('0.6.4'), false); assert.equal(GC.perMemberVersion('0.7.0'), true); assert.equal(GC.perMemberVersion(''), false);
});

test('1.33.0 the display: each member\'s rules in a line with its max size, and the risk dollars of each (10% of its max loss)', () => {
  const r = GC.deskRules(deskRow({ accountType: at('lucid-flex-150k-eval', 'x') }), TYPES).rules;
  assert.equal(GC.summary(r), '$150,000 · daily none · drawdown $4,500 end of day, stops at $150,100 · target $9,000 · consistency 50% · max 10 minis / 100 micros');
  assert.equal(GC.maxText({ maxMinis: 0, maxMicros: 40 }), 'max - minis / 40 micros');
  assert.equal(GC.summary({ size: 50000, drawdown: 2000, drawdownType: 'eod' }), '$50,000 · daily none · drawdown $2,000 end of day · target none', 'a group\'s line as before (no max)');
  const g = { riskPct: 10 };
  assert.equal(GC.riskDollars(g, { drawdown: 2000 }), 200, '10% of a 50K\'s max loss of $2,000');
  assert.equal(GC.riskDollars(g, { drawdown: 4500 }), 450, '10% of a 150K\'s $4,500');
  assert.equal(GC.riskDollars({ riskPct: null }, { drawdown: 4500 }), null, 'off');
  assert.equal(GC.riskText(g), 'risk 10% of each account\'s max loss'); assert.equal(GC.riskText({}), 'risk off');
  const msg = GC.groupMessage(Object.assign(GC.formOf(null), { name: 'Lucid', riskPct: '10' }), [], null, 'c').msg;
  assert.equal(msg.riskPct, 10);
  assert.equal('riskPct' in GC.groupMessage(Object.assign(GC.formOf(null), { name: 'Lucid' }), [], null, 'c').msg, false, 'no box (an older ChartBridge): no key');
  assert.match(GC.groupMessage(Object.assign(GC.formOf(null), { name: 'Lucid', riskPct: '101' }), [], null, 'c').error, /Risk: a percent/);
});

/* ---------------- the fake bridge mirrors ChartBridge 0.6.5 (the harness's numbers and words) */
async function fakeDesk(o) {
  const V = await import('./fake-v3.mjs');
  const out = [], conn = { origin: 'http://localhost:8765', authed: false, actions: [], v3: true };
  const accts = [{ name: 'SIM-A', sim: true, balance: 150500 }, { name: 'SIM-B', sim: true, balance: 50500 }, { name: 'SIM-C', sim: true, balance: 25000 }, { name: 'SIM-D', sim: true, balance: 50000 }];
  let clock = 1000000;
  const desk = new V.OrderDeskV3(Object.assign({ config: { trading: true, tradeAccounts: accts.map(a => a.name), maxQty: { MNQ: 5 }, port: 8765 }, instruments: { MNQ: { name: 'MNQ 12-26', tick: 0.25, pointValue: 2 } },
    knownAccounts: accts.map(a => a.name), token: 'tok', switches: { accountChecks: true }, accountList: accts, graceMs: 1000, send: (c, m) => out.push(m), conns: () => [conn], now: () => clock, barTime: () => clock / 1000,
    groupsSeed: [{ name: 'Lucid', size: 50000, drawdown: 2000, drawdownType: 'eod', dailyLoss: 1000, target: 3000, lockAt: 50100, members: [] }] }, o || {}));
  desk.tick('MNQ', 25400); desk.auth(conn, 'tok'); out.length = 0;
  const act = m => { clock += 150; out.length = 0; desk.handle(conn, m, JSON.stringify(m)); return out.slice(); };
  const entry = n => desk.accountsMsg().list.find(a => a.name === n);
  return { desk, act, entry, reject: r => (r.find(m => m.type === 'reject') || {}).reason || null };
}
const R = (size, dl, dd, type, lk, tg, extra) => Object.assign({ size, dailyLoss: dl, drawdown: dd, drawdownType: type, lockAt: lk, target: tg }, extra || {});

test('fake 0.6.5: three accounts of three types in one group, each with its own floor, daily room and target', async () => {
  const f = await fakeDesk();
  const join = (a, high, rules) => f.act(Object.assign({ type: 'accountGroup', cid: 'j', account: a, group: 'g1' }, high ? { highClose: high } : {}, rules || {}));
  assert.equal(f.reject(join('SIM-A', 151000, R(150000, 0, 4500, 'eod', 150100, 9000, { consistency: 50, maxMinis: 10, maxMicros: 100, typeId: 'lucid-flex-150k-eval' }))), null);
  assert.equal(f.reject(join('SIM-B', 51000, R(50000, 0, 2000, 'eod', 50100, 3000, { maxMinis: 4, maxMicros: 40 }))), null);
  assert.equal(f.reject(join('SIM-C', null, R(25000, 500, 1000, 'intraday', 25100, 1250, { maxMinis: 2, maxMicros: 20 }))), null);
  const a = f.entry('SIM-A'), b = f.entry('SIM-B'), c = f.entry('SIM-C');
  assert.deepEqual([a.floor, a.roomDaily, a.targetLeft], [146500, null, 8500], 'SIM-A: 151000-4500, no daily loss, 159000-150500');
  assert.equal(a.why.roomDaily, 'SIM-A\'s rules in Lucid have no daily loss limit', 'the harness\'s words');
  assert.deepEqual([b.floor, b.targetLeft], [49000, 2500]);
  assert.deepEqual([c.floor, c.roomDaily, c.targetLeft], [24000, 500, 1250], 'SIM-C: its own size 25000 (not the group\'s 50000) seeds its high');
  assert.deepEqual(c.rules, { size: 25000, dailyLoss: 500, drawdown: 1000, drawdownType: 'intraday', lockAt: 25100, target: 1250, consistency: null, maxMinis: 2, maxMicros: 20, typeId: null, own: true });
  const g = f.desk.groupsMsg().list[0];
  assert.deepEqual([g.riskPct, g.ownRules], [null, ['SIM-A', 'SIM-B', 'SIM-C']]);
  assert.deepEqual(Object.keys(g).slice(-5), ['side', 'holders', 'riskPct', 'ownRules', 'tradeOut'], 'after holders, as ChartBridge writes them');
});

test('fake 0.6.5: the refusals in ChartBridge\'s words, memberRules later, leaving and joining with no rules', async () => {
  const f = await fakeDesk();
  const j = r => f.reject(f.act(Object.assign({ type: 'accountGroup', cid: 'j', account: 'SIM-C', group: 'g1' }, r)));
  assert.equal(j({ size: 150000 }), 'dailyLoss is needed');
  assert.equal(j({ size: 150000, dailyLoss: 0, drawdown: 4500, lockAt: 0, target: 0 }), 'drawdownType is needed');
  assert.equal(j(R(150000, 0, 150000, 'eod', 0, 0)), 'the drawdown must be less than the account size');
  assert.equal(j(R(150000, 0, 4500, 'eod', 145000, 0)), 'floor stops at must be above the starting floor (145500)');
  assert.equal(j(R(150000, 0, 4500, 'eod', 0, 0, { maxMinis: 1001 })), 'maxMinis must be a whole number of contracts from 0 (none) to 1000');
  assert.equal(f.reject(f.act(Object.assign({ type: 'accountGroup', cid: 'j', account: 'SIM-C', group: null }, R(150000, 0, 4500, 'eod', 0, 0)))), 'rules go with joining a group only');
  assert.match(f.reject(f.act(Object.assign({ type: 'memberRules', cid: 'r', account: 'SIM-C' }, R(150000, 0, 4500, 'eod', 0, 0)))), /^SIM-C is in no group/);
  assert.equal(f.reject(f.act({ type: 'accountGroup', cid: 'j', account: 'SIM-B', group: 'g1', highClose: 53000 })), null);
  assert.equal(f.entry('SIM-B').rules.own, false, 'joined with no rules: the group\'s');
  assert.equal(f.entry('SIM-B').floor, 50100);
  assert.equal(f.reject(f.act(Object.assign({ type: 'memberRules', cid: 'r', account: 'SIM-B' }, R(50000, 1000, 2500, 'eod', 0, 3000)))), null);
  assert.deepEqual([f.entry('SIM-B').floor, f.entry('SIM-B').rules.own], [50500, true], 'its high kept (53000), its new drawdown 2500, no lock');
  f.act({ type: 'accountGroup', cid: 'j', account: 'SIM-B', group: null });
  f.act({ type: 'accountGroup', cid: 'j', account: 'SIM-B', group: 'g1' });
  assert.equal(f.entry('SIM-B').rules.own, false, 'leaving drops its rules');
  assert.equal(f.reject(f.act({ type: 'groupSave', cid: 's', group: 'g1', name: 'Lucid', noHedge: true, dailyLoss: 1000, drawdown: 2000, drawdownType: 'eod', target: 3000, size: 50000, lockAt: 50100, riskPct: 101 })), 'riskPct must be a percent of each member\'s max loss from 0 (off) to 100, at most 2 decimals');
  f.act({ type: 'groupSave', cid: 's', group: 'g1', name: 'Lucid', noHedge: true, dailyLoss: 1000, drawdown: 2000, drawdownType: 'eod', target: 3000, size: 50000, lockAt: 50100, riskPct: 10 });
  assert.equal(f.desk.groupsMsg().list[0].riskPct, 10);
  f.act({ type: 'groupSave', cid: 's', group: 'g1', name: 'Lucid', noHedge: true, dailyLoss: 1000, drawdown: 2000, drawdownType: 'eod', target: 3000, size: 50000, lockAt: 50100 });
  assert.equal(f.desk.groupsMsg().list[0].riskPct, 10, 'absent keeps it');
});

test('fake: a ChartBridge before 0.6.5 (groupRules false) knows none of it, as its key lists say', async () => {
  const f = await fakeDesk({ groupRules: false });
  assert.equal(f.reject(f.act(Object.assign({ type: 'accountGroup', cid: 'j', account: 'SIM-C', group: 'g1' }, R(25000, 500, 1000, 'intraday', 0, 0)))), 'Unknown key "size" in accountGroup.');
  assert.equal(f.reject(f.act(Object.assign({ type: 'memberRules', cid: 'r', account: 'SIM-C' }, R(25000, 500, 1000, 'intraday', 0, 0)))), 'Unknown message type memberRules.');
  const g = f.desk.groupsMsg().list[0];
  assert.equal('riskPct' in g, false); assert.equal(GC.cleanGroups({ list: [g] })[0].perMember, false, 'the page then asks as 1.26.0 did');
  f.act({ type: 'accountGroup', cid: 'j', account: 'SIM-C', group: 'g1' });
  assert.equal('rules' in f.entry('SIM-C'), false);
});

test('ChartBridge 0.6.5 source: rules lines, the old file kept as written, only a group entry reads the risk percent', () => {
  const g = read('nt8/ChartBridgeGroups.cs');
  assert.match(g, /else if \(p\[0\] == "rules"\)/);
  assert.doesNotMatch(g, /why = kv\.Value \+ " gives rules to an account in no group"/, '0.6.6: a rules line for an account in no group is read (its own firm rules), never a reason to refuse the file');
  assert.match(g, /if \(g\.RiskPct > 0 \|\| g\.Extra\.Length > 0\) b\.Append\('\\t'\)\.Append\(PctText\(g\.RiskPct\)\);/, 'risk off: the group line as 0.6.4 writes it');
  assert.match(g, /public Rules RulesOf\(string account, Group g\) \{ Rules r; return account != null && Own\.TryGetValue\(account, out r\) \? r\.Clone\(\) : g\.Default\(\); \}/, 'no rules line: the group\'s rules (migration)');
  for (const f of ['ChartBridgeCopier.cs', 'ChartBridgeAgents.cs', 'ChartBridgeBot.cs']) assert.doesNotMatch(read('nt8/' + f), /RiskPct|riskPct|MaxMinis|MaxMicros/, f + ': the copier, the agents and the bot never read the risk percent or the max size');
  assert.match(g, /if \(g\.RiskPct <= 0\) \{ err = "group " \+ g\.Name \+ " has no risk percent/, 'a group entry only with the risk percent on');
  for (const f of ['nt8/ChartBridgeGroups.cs', 'live/groups.js', 'live/accounts.js', 'test/fake-groups.mjs', 'nt8/check/GroupsHarness.cs']) assert.doesNotMatch(read(f), /[\u2013\u2014]/, f + ': no em or en dashes');
});

/* ---------------- 0.6.5 (Anthony 2026-10-19): trade the group from the ticket, each member sized from the group's risk percent */
test('groupSize: each guard, in ChartBridge\'s order and words (the harness\'s numbers)', async () => {
  const { groupSize } = await import('./fake-groups.mjs');
  const base = { riskPct: 10, drawdown: 4500, stopTicks: 20, tickValue: 5, maxLeft: 10, maxWords: '10 minis; it holds or has working 0 in mini equivalents, every instrument', cap: 9, capWords: 'maxQty.NQ in config.txt', held: 0, roomFloor: 4000, hasDaily: false, roomDaily: null, openRisk: 0 };
  const g = o => groupSize(Object.assign({}, base, o));
  assert.deepEqual(g({}), { size: 4, budget: 450, why: null }, '10% of $4,500 = $450 / ($100 a contract) = 4');
  assert.equal(g({ stopTicks: 4 }).size, 9, '22 by risk, its max 10, the cap 9 (maxQty, the hard ceiling)');
  assert.deepEqual(g({ stopTicks: 4, maxLeft: 2 }).size, 2, 'its max size');
  assert.equal(g({ stopTicks: 4, held: 4, maxLeft: 6 }).size, 5, 'an add: what it holds counts against the cap');
  assert.equal(g({ stopTicks: 4, held: 10, maxLeft: 0, maxWords: '10 minis; it holds or has working 10 in mini equivalents, every instrument' }).why, 'it is at its max size (10 minis; it holds or has working 10 in mini equivalents, every instrument)');
  assert.equal(g({ stopTicks: 4, maxLeft: -1, held: 9 }).why, 'it is at the cap of 9 (maxQty.NQ in config.txt; it holds or has working 9)');
  assert.deepEqual(g({ roomFloor: 150 }), { size: 1, budget: 450, why: null }, 'the room to its floor $150: 1 contract of $100');
  assert.equal(g({ roomFloor: 80 }).why, 'its room to the floor $80 is less than one contract\'s stop ($100)');
  assert.equal(g({ hasDaily: true, roomDaily: 80 }).why, 'its daily room $80 is less than one contract\'s stop ($100)');
  assert.equal(g({ roomFloor: null, floorWhy: 'the account is not connected' }).why, 'its room to the floor is not known (the account is not connected)');
  assert.equal(g({ hasDaily: true, roomDaily: null, dailyWhy: 'x' }).why, 'its daily room is not known (x)');
  assert.equal(g({ drawdown: 2000, stopTicks: 50 }).why, 'its risk $200 (10% of its max loss $2,000) is less than one contract\'s stop ($250 at 50 ticks)', 'rounds to 0');
  assert.equal(g({ riskPct: 10, drawdown: 2000, stopTicks: 40, tickValue: 0.5, maxLeft: 40, cap: 100 }).size, 10, 'micros: $200 / ($20 a contract) = 10');
});

async function geDesk(o) {
  const V = await import('./fake-v3.mjs');
  const out = [], conn = { origin: 'http://localhost:8765', authed: false, actions: [], v3: true };
  const accts = [{ name: 'SIM-A', sim: true, balance: 150500 }, { name: 'SIM-B', sim: true, balance: 50500 }, { name: 'SIM-C', sim: true, balance: 25000 }, { name: 'SIM-D', sim: true, balance: 50000 }];
  let clock = 1000000;
  const desk = new V.OrderDeskV3(Object.assign({ config: { trading: true, tradeAccounts: accts.map(a => a.name), maxQty: { NQ: 9, MNQ: 9 }, port: 8765 },
    instruments: { NQ: { name: 'NQ 12-26', tick: 0.25, pointValue: 20 }, MNQ: { name: 'MNQ 12-26', tick: 0.25, pointValue: 2 } },
    knownAccounts: accts.map(a => a.name), token: 'tok', switches: { accountChecks: true }, accountList: accts, graceMs: 1000, send: (c, m) => out.push(m), conns: () => [conn], now: () => clock, barTime: () => clock / 1000,
    groupsSeed: [{ name: 'Lucid', size: 50000, drawdown: 2000, drawdownType: 'eod', target: 3000, riskPct: 10, members: ['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D'], highClose: 0,
      rules: { 'SIM-A': { size: 150000, drawdown: 4500, drawdownType: 'eod', lockAt: 150100, target: 9000, maxMinis: 10, maxMicros: 100 },
        'SIM-B': { size: 50000, drawdown: 2000, drawdownType: 'eod', lockAt: 50100, target: 3000, maxMinis: 4, maxMicros: 40 },
        'SIM-C': { size: 25000, dailyLoss: 500, drawdown: 1000, drawdownType: 'intraday', lockAt: 25100, target: 1250, maxMinis: 2, maxMicros: 20 } } }] }, o || {}));
  desk.gr.peaks.set('SIM-A', 151000); desk.gr.peaks.set('SIM-B', 51000);
  desk.tick('NQ', 25000); desk.tick('MNQ', 25000); desk.auth(conn, 'tok'); out.length = 0;
  const act = m => { clock += 150; out.length = 0; desk.handle(conn, m, JSON.stringify(m)); return out.slice(); };
  return { desk, act, reject: r => (r.find(m => m.type === 'reject') || {}).reason || null };
}
const GE = (type, o) => Object.assign({ type, cid: 'ge', group: 'g1', root: 'NQ', side: 'buy', kind: 'market', bracket: { stop: 20, target: 40 } }, o || {});
const sizesOf = r => (r.find(m => m.type === 'groupPreview' || m.type === 'groupPlaced') || { members: [] }).members.map(s => s.size).join(',');

test('fake 0.6.5 groupPreview and groupOrder: the harness\'s sizes, guards, refusals and placing', async () => {
  const f = await geDesk();
  const pv = f.act(GE('groupPreview'));
  assert.deepEqual(pv[0], { type: 'groupPreview', cid: 'ge', group: 'g1', name: 'Lucid', root: 'NQ', side: 'buy', kind: 'market', stopTicks: 20, riskPct: 10, members: [
    { account: 'SIM-A', size: 4, risk: 400, budget: 450, out: null }, { account: 'SIM-B', size: 2, risk: 200, budget: 200, out: null },
    { account: 'SIM-C', size: 1, risk: 100, budget: 100, out: null }, { account: 'SIM-D', size: 2, risk: 200, budget: 200, out: null }] });
  assert.equal(sizesOf(f.act(GE('groupPreview', { bracket: { stop: 4, target: 8 } }))), '9,4,2,9', 'the cap 9 (SIM-A, SIM-D), the max size (SIM-B 4, SIM-C 2)');
  const zero = f.act(GE('groupPreview', { bracket: { stop: 50, target: 0 } }))[0].members[1];
  assert.equal(zero.out, 'its risk $200 (10% of its max loss $2,000) is less than one contract\'s stop ($250 at 50 ticks)');
  assert.equal(f.reject(f.act(GE('groupPreview', { bracket: { stop: 0, target: 40 } }))), 'a group entry needs a stop: each member is sized from its stop loss (set the bracket\'s stop)');
  assert.equal(f.reject(f.act(GE('groupPreview', { bracket: undefined }))), 'a group entry needs a stop: each member is sized from its stop loss (set the bracket\'s stop)');
  assert.equal(f.reject(f.act(GE('groupOrder', { sizes: 'SIM-A:5,SIM-B:2,SIM-C:1,SIM-D:2' }))), 'the sizes changed since the preview (SIM-A 5 confirmed, 4 now): nothing was sent; look again and send');
  assert.equal(f.desk.orders.size, 0, 'nothing placed by a preview or a refusal');
  const placed = f.act(GE('groupOrder', { sizes: 'SIM-A:4,SIM-B:2,SIM-C:1,SIM-D:2' })), gp = placed.find(m => m.type === 'groupPlaced');
  assert.equal(gp.placed, 4);
  const entries = [...f.desk.orders.values()].filter(o => o.role === 'entry' || o.qty);
  assert.deepEqual(['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D'].map(a => entries.filter(o => o.account === a && o.root === 'NQ').reduce((t, o) => t + (o.role === 'entry' || !o.role ? o.qty : 0), 0) || (f.desk.positions.get(a + '|NQ') || {}).qty), [4, 2, 1, 2], 'each member\'s own entry at its own size');
  f.desk.gr.list.get('g1').riskPct = 0;
  assert.equal(f.reject(f.act(GE('groupPreview'))), 'group Lucid has no risk percent: set Risk % of max loss in Settings, Account groups');
});

test('fake: a ChartBridge before 0.6.5 knows no group entry', async () => {
  const f = await geDesk({ groupRules: false });
  assert.equal(f.reject(f.act(GE('groupPreview'))), 'Unknown message type groupPreview.');
  assert.equal(f.reject(f.act(GE('groupOrder', { sizes: '1' }))), 'Unknown message type groupOrder.');
});

/* ---------------- Anthony's answers of 2026-10-19: a strategy with a group entry (2), the cumulative room cap (4) */
test('groupSize answer 4: all the open stop risk on that side comes off both rooms first (the harness\'s numbers)', async () => {
  const { groupSize } = await import('./fake-groups.mjs');
  const base = { riskPct: 10, drawdown: 2000, stopTicks: 20, tickValue: 5, maxLeft: 4, maxWords: '4 minis', cap: 9, capWords: 'maxQty.NQ in config.txt', held: 0, roomFloor: 650, hasDaily: false, roomDaily: null, openRisk: 0 };
  const g = o => groupSize(Object.assign({}, base, o));
  assert.equal(g({}).size, 2, 'flat: room 650 / $100 holds 6, its risk 2');
  assert.equal(g({ openRisk: 500 }).size, 1, 'long 1 with its stop $500 away: (650 - 500) / 100 = 1');
  assert.equal(g({ openRisk: 700 }).why, 'its room to the floor $650 less its open stop risk $700 is less than one contract\'s stop ($100)');
  assert.equal(g({ openRisk: null, openWhy: 'it holds 4 NQ with no working stop for 4 of them' }).why, 'its open stop risk is not known (it holds 4 NQ with no working stop for 4 of them)');
  assert.equal(g({ hasDaily: true, roomDaily: 300, openRisk: 250 }).why, 'its daily room $300 less its open stop risk $250 is less than one contract\'s stop ($100)');
});

test('fake answers 2 and 4: a strategy\'s stop sizes the group, and a held position\'s stop risk caps the room', async () => {
  const f = await geDesk({ switches: { accountChecks: true, strategies: true } });
  const strat = { name: 'Scalp', stop: 20, t1: 40, t1Share: 100 };
  const pv = f.act(GE('groupPreview', { bracket: undefined, strategy: strat }));
  assert.equal(sizesOf(pv), '4,2,1,2', 'the strategy\'s stop of 20 ticks sizes as a bracket stop of 20');
  assert.equal(f.reject(f.act(GE('groupPreview', { strategy: strat }))), 'bracket and strategy on one order are refused: send one of them');
  const placed = f.act(GE('groupOrder', { bracket: undefined, strategy: strat, sizes: 'SIM-A:4,SIM-B:2,SIM-C:1,SIM-D:2' })).find(m => m.type === 'groupPlaced');
  assert.equal(placed.placed, 4, 'each member\'s own strategy entry');
  /* answer 4: SIM-A holds a position with no working stop: its open stop risk is not known */
  const g = await geDesk();
  g.desk.positions.set('SIM-A|NQ', { qty: 4, avgPrice: 25000 });
  const out = g.act(GE('groupPreview'))[0].members[0];
  assert.equal(out.out, 'its open stop risk is not known (it holds 4 NQ with no working stop for 4 of them)');
});

/* ---------------- the review of d7c8e50: the fake mirrors each fix */
test('fake review 1, 2, 5: working entries at their stops, both sides, names with the sizes, and a second entry sees the first', async () => {
  const f = await geDesk();
  f.desk.acct.get('SIM-B').balance = 49250;   // SIM-B's room to its floor: 250
  const pv = f.act(GE('groupPreview'))[0].members;
  assert.equal(pv[1].size, 2, 'room 250, $100 a contract: its risk 2');
  assert.equal(f.reject(f.act(GE('groupOrder', { sizes: 'SIM-B:2,SIM-A:4,SIM-C:1,SIM-D:2' }))), 'the group\'s accounts changed since the preview (SIM-A, SIM-B, SIM-C, SIM-D now, SIM-B, SIM-A, SIM-C, SIM-D confirmed): nothing was sent; look again and send', 'review 2');
  const one = f.act(GE('groupOrder', { sizes: 'SIM-A:4,SIM-B:2,SIM-C:1,SIM-D:2' })).find(m => m.type === 'groupPlaced');
  assert.equal(one.placed, 4);
  assert.equal(f.reject(f.act(GE('groupOrder', { sizes: 'SIM-A:4,SIM-B:2,SIM-C:1,SIM-D:2' }))), 'the sizes changed since the preview (SIM-B 2 confirmed, 0 now): nothing was sent; look again and send', 'review 1b: the second sees the first (its $200 stop risk)');
  const g = await geDesk();
  g.desk.acct.get('SIM-B').balance = 49650;   // room 650
  g.act({ type: 'order', cid: 'w', account: 'SIM-B', root: 'NQ', side: 'buy', kind: 'limit', qty: 1, price: 24900, bracket: { stop: 100, target: 0 } });
  assert.equal(g.act(GE('groupPreview'))[0].members[1].size, 1, 'review 1a: a resting entry\'s $500 stop risk: (650 - 500) / 100 = 1');
  const h = await geDesk();
  h.desk.positions.set('SIM-B|NQ', { qty: -1, avgPrice: 25000 });
  h.desk.newOrder({ account: 'SIM-B', root: 'NQ', side: 'buy', kind: 'stop', qty: 1, price: 25025, role: 'stop' });
  h.desk.acct.get('SIM-B').balance = 49650;
  assert.equal(h.act(GE('groupPreview'))[0].members[1].size, 1, 'review 5: a short\'s buy stop $500 away counts for a buy entry');
});

test('fake review 3, 4, 6, 7: mini equivalents, the bot\'s account left out, a stop-limit strategy, the bracket cap', async () => {
  const f = await geDesk();
  f.desk.positions.set('SIM-B|MNQ', { qty: 30, avgPrice: 25000 });
  f.desk.newOrder({ account: 'SIM-B', root: 'MNQ', side: 'sell', kind: 'stop', qty: 30, price: 24995, role: 'stop' });
  assert.equal(f.act(GE('groupPreview'))[0].members[1].size, 1, '30 MNQ is 3 of its 4 minis: 1 NQ left');
  f.desk.positions.set('SIM-B|MNQ', { qty: 40, avgPrice: 25000 });
  [...f.desk.orders.values()].find(o => o.account === 'SIM-B' && o.root === 'MNQ').qty = 40;
  assert.equal(f.act(GE('groupPreview'))[0].members[1].out, 'it is at its max size (4 minis / 40 micros; it holds or has working 4 in mini equivalents, every instrument)');
  const b = await geDesk({ botAccount: 'SIM-D' });
  assert.equal(b.act(GE('groupPreview'))[0].members[3].out, 'SIM-D is the bot\'s account');
  assert.deepEqual(b.desk.groupsMsg().list[0].tradeOut, [{ account: 'SIM-D', why: 'SIM-D is the bot\'s account' }], 'review 4: named for the page');
  const s = await geDesk({ switches: { accountChecks: true, strategies: true } });
  const pv = s.act(GE('groupPreview', { bracket: undefined, strategy: { name: 'S', stop: 20, stopLimit: 4, t1: 40, t1Share: 100 } }))[0];
  assert.equal(pv.stopTicks, 24); assert.equal(pv.members[0].size, 3, 'review 6: 450 / (24 x $5) = 3');
  const c = await geDesk({ config: { trading: true, tradeAccounts: ['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D'], maxQty: { NQ: 9 }, port: 8765, maxBracketTicks: 50 } });
  assert.equal(c.reject(c.act(GE('groupPreview', { bracket: { stop: 60, target: 0 } }))), 'bracket ticks must be from 0 to 50 (maxBracketTicks in config.txt)', 'review 7');
});

test('fake re-review 1 and 2: an adding side OCO entry counts, a closing side OCO set is one exit; 0.6.6: each kind against its own max', async () => {
  const f = await geDesk();
  f.desk.positions.set('SIM-B|NQ', { qty: 1, avgPrice: 25000 });
  f.desk.newOrder({ account: 'SIM-B', root: 'NQ', side: 'sell', kind: 'stop', qty: 1, price: 24990, role: 'entry', oco: 'x1' });
  f.desk.newOrder({ account: 'SIM-B', root: 'NQ', side: 'sell', kind: 'limit', qty: 1, price: 25040, role: 'entry', oco: 'x1' });
  assert.equal(f.act(GE('groupPreview'))[0].members[1].size, 2, 'the typed stop and target on the long: one exit');
  f.desk.newOrder({ account: 'SIM-B', root: 'NQ', side: 'buy', kind: 'limit', qty: 1, price: 24950, role: 'entry', oco: 'y1' });
  assert.equal(f.act(GE('groupPreview'))[0].members[1].out, 'its open stop risk is not known (a working buy limit 1 NQ has no stop ChartBridge knows)');
  /* ChartBridge 0.6.6 (Anthony 2026-10-20): micros against maxMicros, minis against maxMinis (was: the smaller in mini equivalents) */
  const { firmMaxLeft } = await import('./fake-groups.mjs');
  assert.equal(firmMaxLeft(4, 20, 'NQ', 2), 2, '4 minis / 20 micros holding 2 NQ: 2 NQ left (was 0)');
  assert.equal(firmMaxLeft(4, 20, 'MNQ', 2), 0, 'and no MNQ: the 2 NQ are its 20 micros');
  assert.equal(firmMaxLeft(2, 40, 'MNQ', 0), 40, '2 minis / 40 micros, flat: 40 MNQ (was 20)');
  assert.equal(firmMaxLeft(2, 40, 'MNQ', 2.5), 15);
  assert.equal(firmMaxLeft(4, 0, 'MNQ', 1.5), 25, 'only minis set: micros convert, 10 to a mini');
  assert.equal(firmMaxLeft(0, 30, 'NQ', 0), 3, 'only micros set: minis convert');
  assert.equal(firmMaxLeft(0, 0, 'NQ', 0), -1, 'no max');
});
