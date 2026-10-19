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
  assert.deepEqual(GC.seedHigh(deskRow({ seedFloor: 49234.5, seedDate: '2026-10-17' }), rules), { value: 51234.5, words: 'The Desk\'s seed floor $49,234.50 (2026-10-17) plus the drawdown $2,000' });
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
  assert.deepEqual(Object.keys(g).slice(-4), ['side', 'holders', 'riskPct', 'ownRules'], 'after holders, as ChartBridge writes them');
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

test('ChartBridge 0.6.5 source: rules lines, the old file kept as written, nothing in the order path reads the risk percent', () => {
  const g = read('nt8/ChartBridgeGroups.cs');
  assert.match(g, /else if \(p\[0\] == "rules"\)/);
  assert.match(g, /gives rules to an account in no group/);
  assert.match(g, /if \(g\.RiskPct > 0 \|\| g\.Extra\.Length > 0\) b\.Append\('\\t'\)\.Append\(PctText\(g\.RiskPct\)\);/, 'risk off: the group line as 0.6.4 writes it');
  assert.match(g, /public Rules RulesOf\(string account, Group g\) \{ Rules r; return account != null && Own\.TryGetValue\(account, out r\) \? r\.Clone\(\) : g\.Default\(\); \}/, 'no rules line: the group\'s rules (migration)');
  assert.equal((g.match(/RiskPct/g) || []).length, 8, 'RiskPct only where it is read, written, saved and sent');
  for (const f of ['ChartBridgeOrders.cs', 'ChartBridgeCopier.cs', 'ChartBridgeAgents.cs', 'ChartBridgeBot.cs']) assert.doesNotMatch(read('nt8/' + f), /RiskPct|riskPct|MaxMinis|MaxMicros/, f + ': no order path reads the risk percent or the max size');
  for (const f of ['nt8/ChartBridgeGroups.cs', 'live/groups.js', 'live/accounts.js', 'test/fake-groups.mjs', 'nt8/check/GroupsHarness.cs']) assert.doesNotMatch(read(f), /[\u2013\u2014]/, f + ': no em or en dashes');
});
