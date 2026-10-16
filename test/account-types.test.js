'use strict';
// Chart 1.30.0 (wave 5, Anthony 2026-10-16): account types, the one ledger on The Desk, on the chart page (live/groups.js
// GroupsCore, live/accounts.js cleanDesk): The Desk's list read clean, the labels with "(not checked)", the rules dialog's fill,
// the rules-differ check, Apply its rules, this browser's copy of the list and each group's link to its type, the member
// warning, and the fake Desk (test/fake-desk.mjs) against the spec's API contract. Made-up values and SIM-A style accounts only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const GC = require('../live/groups.js');
const AC = require('../live/accounts.js');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
/* one type as The Desk sends it (every field of the contract); the values are made up for the test */
const row = o => Object.assign({ id: 'lucid-50k-flex', firm: 'Lucid', name: '50K Flex, no DLL', account_type: 'eval', account_size: 50000, daily_loss: null, drawdown: 2000,
  drawdown_type: 'eod', lock_at: 50100, profit_target: 3000, consistency_pct: 50, max_nq: 4, max_mnq: 40, notes: '', sources: [], status: 'not_checked', checked_at: null,
  version: 3, archived: false, created_at: '2026-10-16T12:00:00Z', updated_at: '2026-10-16T12:00:00Z' }, o || {});
const memStore = () => { const m = new Map(); return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };

test('account types: The Desk\'s list read clean, archived and malformed rows left out, sorted by firm then name', () => {
  const c = GC.cleanTypes({ v: 1, asOf: '2026-10-16T18:02:00Z', types: [
    row({ id: 'lucid-150k-daily', name: '150K, daily DLL', daily_loss: 3000, status: 'checked', account_type: 'funded' }),
    row(), row({ id: 'apex-50k', firm: 'Apex', name: '50K' }),
    row({ id: 'old-one', archived: true }), row({ id: 'bad id!' }), row({ id: 'no-firm', firm: '' }), row({ id: 'long-name', name: 'x'.repeat(61) }), null, 'text',
    row({ id: 'lucid-50k-flex', name: 'a second row with the same id' }) ] });
  assert.deepEqual(c.types.map(t => t.id), ['apex-50k', 'lucid-150k-daily', 'lucid-50k-flex']);
  assert.equal(c.asOf, '2026-10-16T18:02:00Z');
  const t = c.types.find(x => x.id === 'lucid-50k-flex');
  assert.deepEqual(t, { id: 'lucid-50k-flex', firm: 'Lucid', name: '50K Flex, no DLL', accountType: 'eval', size: 50000, dailyLoss: null, drawdown: 2000, drawdownType: 'eod', lockAt: 50100,
    target: 3000, consistency: 50, status: 'not_checked', version: 3 });
  assert.equal(GC.cleanTypes({ types: [row({ status: 'Checked' })] }).types[0].status, 'not_checked', 'only "checked" exactly is checked');
  assert.equal(GC.cleanTypes({ types: [row({ drawdown_type: 'weekly', account_type: 'x' })] }).types[0].drawdownType, null);
  assert.equal(GC.cleanTypes({ types: [row({ account_type: 'x' })] }).types[0].accountType, '');
  assert.equal(GC.cleanTypes(null), null); assert.equal(GC.cleanTypes({ types: 'no' }), null); assert.equal(GC.cleanTypes([]), null);
});

test('account types: labels say "(not checked)" until the type is checked', () => {
  const [a, b] = GC.cleanTypes({ types: [row(), row({ id: 'lucid-150k', name: '150K, daily DLL', status: 'checked' })] }).types;
  assert.equal(GC.typeLabel(b), 'Lucid 50K Flex, no DLL (not checked)');
  assert.equal(GC.typeLabel(a), 'Lucid 150K, daily DLL');
});

test('account types: the rules dialog\'s fill (every rule box and the Type, never the name), and what a type lacks', () => {
  const t = GC.cleanTypes({ types: [row()] }).types[0];
  const f = GC.typeForm(t);
  assert.deepEqual(f, { size: '50000', dailyLoss: '', drawdown: '2000', drawdownType: 'eod', lockAt: '50100', target: '3000', consistency: '50', accountType: 'eval', missing: [] });
  assert.ok(!('name' in f), 'Anthony names his groups himself');
  /* the fill passes the dialog's own checks, so Save sends the groupSave ChartBridge takes */
  const r = GC.groupMessage(Object.assign({ name: 'My Lucid', noHedge: true, hero: '' }, f), [], 'g1', 'c1');
  assert.deepEqual(r.msg, { type: 'groupSave', cid: 'c1', group: 'g1', name: 'My Lucid', noHedge: true, dailyLoss: 0, drawdown: 2000, drawdownType: 'eod', target: 3000, size: 50000, lockAt: 50100, consistency: 50, accountType: 'eval', hero: '-' });
  const st = GC.typeForm(GC.cleanTypes({ types: [row({ drawdown_type: 'static', lock_at: 50100, account_size: null, account_type: '' })] }).types[0]);
  assert.equal(st.lockAt, '', 'no floor stop on a static drawdown');
  assert.equal(st.accountType, '');
  assert.deepEqual(st.missing, ['account size']);
  assert.deepEqual(GC.typeForm(GC.cleanTypes({ types: [row({ drawdown: null, drawdown_type: null })] }).types[0]).missing, ['drawdown size', 'drawdown type']);
});

test('account types: a group\'s rules differ from its type\'s current version (none and 0 alike, cents rounded)', () => {
  const t = GC.cleanTypes({ types: [row()] }).types[0];
  const g = { id: 'g1', name: 'My Lucid', size: 50000, dailyLoss: null, drawdown: 2000, drawdownType: 'eod', lockAt: 50100, target: 3000, consistency: 50, accountType: 'eval', members: [] };
  assert.deepEqual(GC.rulesDiffer(g, t), []);
  assert.deepEqual(GC.rulesDiffer(Object.assign({}, g, { dailyLoss: 0 }), t), [], 'none and 0 are the same');
  assert.deepEqual(GC.rulesDiffer(g, Object.assign({}, t, { version: 9, status: 'checked' })), [], 'a check-only write (a new version, the same values) is not a difference');
  assert.deepEqual(GC.rulesDiffer(Object.assign({}, g, { size: 50000.0, drawdown: 2000.004 }), t), [], 'dollars as floats, compared to the cent');
  assert.deepEqual(GC.rulesDiffer(Object.assign({}, g, { drawdown: 2500, accountType: 'funded' }), t), ['drawdown size', 'Type']);
  assert.deepEqual(GC.rulesDiffer(Object.assign({}, g, { accountType: null }), Object.assign({}, t, { accountType: '' })), [], 'Type not set on both');
  assert.deepEqual(GC.rulesDiffer(Object.assign({}, g, { drawdownType: 'static', lockAt: null }), Object.assign({}, t, { drawdownType: 'static' })), [], 'a static type\'s floor stop is not compared');
  assert.deepEqual(GC.rulesDiffer(null, t), []); assert.deepEqual(GC.rulesDiffer(g, null), []);
});

test('account types: Apply its rules gives My floor (the starting floor) and My daily, as the accountLimits message', () => {
  const t = GC.cleanTypes({ types: [row({ daily_loss: 1000 })] }).types[0];
  assert.deepEqual(GC.typeLimits(t), { floor: '48000', daily: '1000' });
  assert.deepEqual(GC.limitsMessage('Sim101', '48000', '1000', 'c1').msg, { type: 'accountLimits', cid: 'c1', account: 'Sim101', floor: 48000, dailyLoss: 1000 });
  assert.deepEqual(GC.typeLimits(Object.assign({}, t, { dailyLoss: null })), { floor: '48000', daily: '' }, 'no daily limit: My daily empty (none)');
  assert.match(GC.typeLimits(Object.assign({}, t, { size: null })).error, /has no account size and drawdown/);
  assert.ok(GC.typeLimits(null).error);
});

test('account types: this browser\'s copy of the list (the cache), and a page that works without storage', () => {
  const st = memStore(), desk = { v: 1, asOf: '2026-10-16T18:02:00Z', types: [row(), row({ id: 'old', archived: true })] };
  assert.equal(GC.readTypesCache(st), null);
  assert.equal(GC.writeTypesCache(st, desk, 1760637720000), true);
  const c = GC.readTypesCache(st);
  assert.deepEqual(c.types.map(t => t.id), ['lucid-50k-flex']);
  assert.equal(c.asOf, '2026-10-16T18:02:00Z'); assert.equal(c.savedAt, 1760637720000);
  st.setItem(GC.TYPES_CACHE_KEY, '{not json'); assert.equal(GC.readTypesCache(st), null);
  st.setItem(GC.TYPES_CACHE_KEY, JSON.stringify({ v: 2, desk })); assert.equal(GC.readTypesCache(st), null, 'another version of the copy is not read');
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(GC.readTypesCache(broken), null); assert.equal(GC.writeTypesCache(broken, desk), false);
  assert.equal(GC.readTypesCache(null), null); assert.equal(GC.writeTypesCache(null, desk), false);
  assert.equal(GC.asOfText('2026-10-16T18:02:00Z'), 'Oct 16 14:02 ET');
  assert.equal(GC.asOfText(''), '');
});

test('account types: each group\'s link (type and version) kept by group id; bad entries dropped; removed with null', () => {
  const st = memStore();
  assert.deepEqual(GC.readLinks(st), {});
  assert.equal(GC.saveLink(st, 'g1', { id: 'lucid-50k-flex', version: 3, label: 'Lucid 50K Flex, no DLL' }), true);
  GC.saveLink(st, 'g2', { id: 'apex-50k', version: 1 });
  assert.deepEqual(GC.readLinks(st), { g1: { id: 'lucid-50k-flex', version: 3, label: 'Lucid 50K Flex, no DLL' }, g2: { id: 'apex-50k', version: 1, label: 'apex-50k' } });
  GC.saveLink(st, 'g2', null);
  assert.deepEqual(Object.keys(GC.readLinks(st)), ['g1']);
  st.setItem(GC.LINKS_KEY, JSON.stringify({ g1: { id: 'ok', version: 1 }, x9: { id: 'ok', version: 1 }, g2: { id: 'bad id', version: 1 }, g3: { id: 'ok', version: -1 } }));
  assert.deepEqual(Object.keys(GC.readLinks(st)), ['g1']);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(GC.readLinks(broken), {}); assert.equal(GC.saveLink(broken, 'g1', { id: 'a', version: 1 }), false);
});

test('account types: a member whose own type is another is warned about; an account with no type is not', () => {
  const g = { id: 'g1', members: ['SIM-A', 'SIM-B', 'SIM-C'] }, link = { id: 'lucid-50k-flex', version: 3 };
  const of = { 'SIM-A': { id: 'lucid-50k-flex' }, 'SIM-B': { id: 'lucid-150k', firm: 'Lucid', name: '150K' }, 'SIM-C': null };
  assert.deepEqual(GC.membersOff(g, link, a => of[a]).map(x => x.account), ['SIM-B']);
  assert.deepEqual(GC.membersOff(g, null, a => of[a]), [], 'no link: nothing to compare');
});

test('account types: The Desk\'s chart-accounts rows carry the account\'s type, or null', () => {
  const m = AC.cleanDesk({ accounts: [
    { account: 'SIM-A', daily_loss_limit: null, trailing_drawdown: 2000, account_size: 50000, accountType: { id: 'lucid-50k-flex', firm: 'Lucid', name: '50K Flex, no DLL', version: 3, status: 'checked' } },
    { account: 'SIM-B', accountType: null }, { account: 'SIM-C', accountType: { id: 'bad id' } }, { account: 'SIM-D', accountType: { id: 'x', status: 'whatever' } }] });
  assert.deepEqual(m.get('SIM-A').accountType, { id: 'lucid-50k-flex', firm: 'Lucid', name: '50K Flex, no DLL', version: 3, status: 'checked' });
  assert.equal(m.get('SIM-B').accountType, null); assert.equal(m.get('SIM-C').accountType, null);
  assert.equal(m.get('SIM-D').accountType.status, 'not_checked');
});

test('account types: the wiring (the page reads and writes only the spec\'s routes; links in this browser, not groups.txt)', () => {
  const acc = read('live/accounts.js'), grp = read('live/groups.js');
  assert.match(acc, /url \+ '\/api\/account-types'/);
  assert.match(acc, /'\/api\/accounts\/' \+ encodeURIComponent\(name\) \+ '\/account-type', \{ method: 'PUT'/);
  assert.match(acc, /body: JSON\.stringify\(\{ account_type: id \|\| null \}\)/);
  assert.ok(!/accountTypeId|typeVersion/.test(grp.split('function groupMessage')[1].split('function saveFrom')[0]), 'groupSave carries no new key (ChartBridge 0.6.2 refuses unknown keys)');
  assert.match(grp, /GC\.saveLink\(st\(\), g\.id, next\)/);
  const compat = JSON.parse(read('live/COMPAT.json'));
  assert.equal(compat.minChartBridge, '0.6.2', 'page only: no ChartBridge change');
});

test('the fake Desk answers the spec\'s account-type routes (GET list, chart-accounts with accountType, PUT, archived, ?all=1)', async () => {
  const { startDesk } = await import('./fake-desk.mjs');
  const port = 18000 + Math.floor(Math.random() * 2000);
  const desk = await startDesk(port, { types: [row(), row({ id: 'old', archived: true })], accounts: [{ account: 'SIM-A', account_type: 'lucid-50k-flex' }] });
  try {
    const base = 'http://127.0.0.1:' + port;
    const j = await (await fetch(base + '/api/account-types')).json();
    assert.equal(j.v, 1); assert.deepEqual(j.types.map(t => t.id), ['lucid-50k-flex']); assert.ok(typeof j.asOf === 'string');
    assert.equal((await (await fetch(base + '/api/account-types?all=1')).json()).types.length, 2);
    const ca = await (await fetch(base + '/api/chart-accounts')).json();
    assert.deepEqual(ca.accounts[0].accountType, { id: 'lucid-50k-flex', firm: 'Lucid', name: '50K Flex, no DLL', version: 3, status: 'not_checked' });
    const put = await fetch(base + '/api/accounts/SIM-B/account-type', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_type: 'lucid-50k-flex' }) });
    assert.equal(put.status, 200);
    const bad = await fetch(base + '/api/accounts/SIM-B/account-type', { method: 'PUT', body: JSON.stringify({ account_type: 'nope' }) });
    assert.equal(bad.status, 404, 'an unknown type: 404'); assert.ok(typeof (await bad.json()).detail === 'string');
    assert.equal((await fetch(base + '/api/accounts/SIM-B/account-type', { method: 'PUT', body: JSON.stringify({ account_type: 'old' }) })).status, 409, 'an archived type: 409');
    desk.editType('lucid-50k-flex', { drawdown: 2500 });
    const t = (await (await fetch(base + '/api/account-types')).json()).types[0];
    assert.equal(t.version, 4); assert.equal(t.drawdown, 2500); assert.equal(t.status, 'not_checked');
  } finally { await desk.close(); }
});
