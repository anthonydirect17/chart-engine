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

test('account types: Apply its rules, a trailing type never sets My floor (ChartBridge trails a floor only in a group); My daily from it', () => {
  const t = GC.cleanTypes({ types: [row({ daily_loss: 1000 })] }).types[0];   // 50,000, drawdown 2,000 end of day, floor stops at 50,100
  for (const dt of ['eod', 'intraday']) {
    const l = GC.typeLimits(Object.assign({}, t, { drawdownType: dt }));
    assert.deepEqual(l, { trailing: true, floor: null, floorHow: GC.TRAILING_FLOOR_WORDS, daily: '1000', dailyHow: 'its daily loss limit' });
  }
  assert.equal(GC.TRAILING_FLOOR_WORDS, 'A trailing floor is tracked only in a group: put this account in a group (a one-account group is fine) so ChartBridge trails it from its highest close.');
  /* the question: My floor stays as it is (re-sent unchanged), why, and My daily */
  assert.equal(GC.applyWords(GC.typeLimits(t), { floor: 48500, daily: 700 }),
    'My floor stays as it is ($48,500). A trailing floor is tracked only in a group: put this account in a group (a one-account group is fine) so ChartBridge trails it from its highest close. My daily $1,000 (its daily loss limit).');
  assert.match(GC.applyWords(GC.typeLimits(t), { floor: null, daily: null }), /^My floor stays as it is \(none\)\. A trailing floor/);
  /* what is sent: My floor exactly as it was, whatever the type says */
  const sent = (own) => { const l = GC.typeLimits(t); return GC.limitsMessage('Sim101', l.floor !== null ? l.floor : GC.moneyBox(own), l.daily, 'c1').msg; };
  assert.deepEqual(sent(48500), { type: 'accountLimits', cid: 'c1', account: 'Sim101', floor: 48500, dailyLoss: 1000 });
  assert.deepEqual(sent(null), { type: 'accountLimits', cid: 'c1', account: 'Sim101', floor: 0, dailyLoss: 1000 }, 'none stays none');
  assert.equal(GC.typeLimits(Object.assign({}, t, { drawdownType: null })).floor, null, 'no drawdown type: no floor from it either');
  assert.match(GC.applyWords(GC.typeLimits(Object.assign({}, t, { drawdownType: null })), { floor: 47000 }), /^My floor stays as it is \(\$47,000\): it has no drawdown type, so no floor is taken from it\./);
});

test('account types: Apply its rules, a static type: account size less the drawdown; My daily as the type\'s, saying what it replaces', () => {
  const t = GC.cleanTypes({ types: [row({ drawdown_type: 'static', lock_at: null, daily_loss: 1000 })] }).types[0];
  assert.deepEqual(GC.typeLimits(t), { trailing: false, floor: '48000', daily: '1000', dailyHow: 'its daily loss limit', floorHow: 'a static drawdown: account size $50,000 less the drawdown $2,000' });
  assert.equal(GC.applyWords(GC.typeLimits(t), { floor: 47000, daily: 700 }), 'My floor $48,000 (a static drawdown: account size $50,000 less the drawdown $2,000), My daily $1,000 (its daily loss limit).');
  const nd = GC.typeLimits(Object.assign({}, t, { dailyLoss: null }));
  assert.equal(nd.daily, ''); assert.equal(nd.dailyHow, 'it has no daily loss limit');
  assert.match(GC.applyWords(nd, { floor: null, daily: 700 }), /My daily none \(it has no daily loss limit; it replaces your \$700\)\.$/);
  assert.match(GC.applyWords(nd, { floor: null, daily: null }), /My daily none \(it has no daily loss limit\)\.$/);
  assert.match(GC.typeLimits(Object.assign({}, t, { size: null })).error, /has no account size and drawdown/);
  assert.ok(GC.typeLimits(null).error);
});

test('account types: "floor stops at" ignored at or below the starting floor, on a static drawdown, and in this browser\'s copy too', () => {
  const at = o => GC.cleanTypes({ types: [row(o)] }).types[0].lockAt;
  assert.equal(at({}), 50100);
  assert.equal(at({ lock_at: 48000 }), null, 'at the starting floor');
  assert.equal(at({ lock_at: 47000 }), null, 'below it');
  assert.equal(at({ drawdown_type: 'static', lock_at: 50100 }), null);
  const st = memStore(); GC.writeTypesCache(st, { v: 1, types: [row({ lock_at: 47000 })] });
  assert.equal(GC.readTypesCache(st).types[0].lockAt, null);
  /* a type object from elsewhere: typeForm and rulesDiffer check again */
  const raw = { id: 'x', firm: 'F', name: 'N', size: 50000, drawdown: 2000, drawdownType: 'eod', lockAt: 47000, accountType: 'eval' };
  assert.equal(GC.typeForm(raw).lockAt, '');
  assert.deepEqual(GC.rulesDiffer({ size: 50000, drawdown: 2000, drawdownType: 'eod', lockAt: null, accountType: 'eval' }, raw), []);
});

test('account types: a type with no Type set keeps the group\'s own (not filled, not a difference)', () => {
  const t = GC.cleanTypes({ types: [row({ account_type: '' })] }).types[0];
  const g = { size: 50000, dailyLoss: null, drawdown: 2000, drawdownType: 'eod', lockAt: 50100, target: 3000, consistency: 50, accountType: 'funded' };
  assert.deepEqual(GC.rulesDiffer(g, t), []);
  assert.equal(GC.typeForm(t).accountType, '');
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'live', 'groups.js'), 'utf8'), /if \(v\.accountType\) \$d\('accountType'\)\.value = v\.accountType;/);
});

test('groups: the join question for an intraday group asks the highest balance so far (intraday); ChartBridge reads it as before', () => {
  assert.equal(GC.highWord({ drawdownType: 'intraday' }), 'highest balance so far (intraday)');
  assert.equal(GC.highWord({ drawdownType: 'eod' }), 'highest close so far');
  assert.equal(GC.highWord(null), 'highest close so far');
  assert.equal(GC.joinMessage('SIM-A', 'g2', 'x', 'c', 'Highest balance so far (intraday)').error, 'Highest balance so far (intraday): dollars above $0, or empty.');
  assert.deepEqual(GC.joinMessage('SIM-A', 'g2', '51000', 'c', 'Highest balance so far (intraday)').msg, { type: 'accountGroup', cid: 'c', account: 'SIM-A', group: 'g2', highClose: 51000 }, 'the same highClose key: ChartBridge seeds both highs from it');
  const cs = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'nt8', 'ChartBridgeGroups.cs'), 'utf8');
  assert.match(cs, /mk\.PeakEod = Math\.Round\(seed, 2\); mk\.PeakIntraday = Math\.Round\(seed, 2\);/, 'ChartBridge 0.6.2 starts the intraday high from the same number');
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

test('account types (review nits): a static Apply names a stricter My floor it replaces; an account gone sends nothing', () => {
  const t = GC.cleanTypes({ types: [row({ drawdown_type: 'static', lock_at: null, daily_loss: 1000 })] }).types[0];   // floor 48,000
  const l = GC.typeLimits(t);
  assert.equal(GC.applyWords(l, { floor: 49000, daily: null }), 'My floor $48,000 (a static drawdown: account size $50,000 less the drawdown $2,000; it replaces your $49,000), My daily $1,000 (its daily loss limit).', 'a higher floor of his own is named, never lowered quietly');
  assert.ok(!/replaces/.test(GC.applyWords(l, { floor: 47000, daily: null })), 'a lower floor of his own: nothing to warn about');
  assert.ok(!/replaces/.test(GC.applyWords(l, { floor: 48000, daily: null })), 'the same floor');
  /* what is sent */
  assert.deepEqual(GC.applySend(l, { name: 'Sim101', myFloor: 49000 }), { floor: '48000', daily: '1000' });
  const tr = GC.typeLimits(Object.assign({}, t, { drawdownType: 'eod' }));
  assert.deepEqual(GC.applySend(tr, { name: 'Sim101', myFloor: 49000 }), { floor: '49000', daily: '1000' }, 'trailing: his own floor again');
  assert.deepEqual(GC.applySend(tr, { name: 'Sim101', myFloor: null }), { floor: '', daily: '1000' }, 'none stays none');
  for (const gone of [undefined, null]) assert.deepEqual(GC.applySend(tr, gone), { error: 'the account is not on ChartBridge\'s list now' }, 'an account gone: nothing sent, never an empty floor');
  assert.ok(GC.applySend({ error: 'x' }, { myFloor: 1 }).error);
  assert.match(GC.applySend({ error: 'Its type is not on The Desk\'s list now.' }, null).error, /now\.$/, 'an error ending in a full stop gets no second one (apply-yes adds one only when missing)');
  assert.match(fs.readFileSync(path.join(ROOT, 'live', 'accounts.js'), 'utf8'), /const x = GroupsCore\.applySend\(l, acc\);\s*if \(x\.error\) \{ host\.note\('Not sent: ' \+ x\.error \+ \(\/\[\.!\?\]\$\/\.test\(x\.error\) \? '' : '\.'\), true\); render\(\); return; \}\s*if \(F\.accountLimits\(id, x\.floor, x\.daily\)\)/, 'apply-yes sends only what applySend gives');
});

/* Chart 1.32.0 (Anthony 2026-10-19: "far to many accounts for just a drop down"; Firm > Plan > Size, "firms I actually trade
   first"): the picker's pure parts in GroupsCore. Real firm names, made-up ids. */
const ty = (id, firm, name, o) => Object.assign({ id, firm, name, status: 'not_checked', version: 1 }, o || {});
const SAMPLE = [ty('t-tc100', 'Topstep', 'Trading Combine 100K'), ty('t-tc50', 'Topstep', 'Trading Combine 50K', { status: 'checked' }), ty('t-xf50', 'Topstep', 'Express Funded 50K'),
  ty('l-f50f', 'Lucid', 'LucidFlex 50K Funded'), ty('l-f50e', 'Lucid', 'LucidFlex 50K Eval'), ty('l-f25e', 'Lucid', 'LucidFlex 25K Eval'), ty('l-p100', 'Lucid', 'LucidPro 100K Eval'),
  ty('b-m25o', 'Bulenox', 'Master 25K Option 2 EOD'), ty('b-m25f', 'Bulenox', 'Master 25K Funded'), ty('b-m25q', 'Bulenox', 'Master 25K Qualified'), ty('b-m25t', 'Bulenox', 'Master 25K Test'),
  ty('b-leg', 'Bulenox', 'Legacy plan'), ty('f-d50', 'FundedNext', 'Direct 50K Account'), ty('a-50', 'Apex', 'PA 50K Sim-Funded'), ty('a-50e', 'Apex', 'PA 50K Evaluation')];

test('type picker (1.32.0): a name splits into plan, size and rest; no size token is plan Other with the whole name', () => {
  assert.deepEqual(GC.typeParts(ty('x', 'Lucid', 'LucidFlex 50K Eval')), { plan: 'LucidFlex', size: 50, sizeText: '50K', rest: 'Eval', short: '50K Eval' });
  assert.deepEqual(GC.typeParts(ty('x', 'Topstep', 'Trading Combine 50K')), { plan: 'Trading Combine', size: 50, sizeText: '50K', rest: '', short: '50K' });
  assert.deepEqual(GC.typeParts(ty('x', 'Bulenox', 'Master 25K Option 2 EOD')), { plan: 'Master', size: 25, sizeText: '25K', rest: 'Option 2 EOD', short: '25K Option 2 EOD' });
  assert.deepEqual(GC.typeParts(ty('x', 'FundedNext', 'Direct 50K Account')), { plan: 'Direct', size: 50, sizeText: '50K', rest: 'Account', short: '50K Account' });
  assert.equal(GC.typeParts(ty('x', 'Apex', 'Rally 100k Sim-Funded')).size, 100, 'a lower case k is a size too');
  assert.equal(GC.typeParts(ty('x', 'Apex', 'Static 2.5K Eval')).size, 2.5);
  assert.equal(GC.typeParts(ty('x', 'Apex', 'Plan 50K2 Eval')).plan, 'Other', '"50K2" is not a size token');
  assert.equal(GC.typeParts(ty('x', 'Apex', 'Two Plans 50K Eval 100K')).plan, 'Two Plans', 'the first size token splits');
  for (const n of ['Legacy plan', '50K Flex, no DLL', 'Express Funded']) assert.deepEqual(GC.typeParts(ty('x', 'Lucid', n)), { plan: 'Other', size: null, sizeText: '', rest: n, short: n }, n);
  assert.deepEqual(GC.typeParts(null), { plan: 'Other', size: null, sizeText: '', rest: '', short: '' });
});

test('type picker (1.32.0): firms in use first, then A to Z; plans A to Z; by size, then Eval before Funded, then the rest A to Z', () => {
  const used = GC.usedFirms([{ accountType: { id: 't-tc50', firm: 'Topstep', name: 'x' } }, { accountType: null }, {}, null, { accountType: { id: 'l-f50e', firm: 'Lucid' } }, { accountType: { id: 'l-p100', firm: 'Lucid' } }]);
  assert.deepEqual(used.sort(), ['Lucid', 'Topstep']);
  /* Anthony 2026-10-19: a firm The Desk gives on a chart-accounts row (its firm field) is in use too, type set or not */
  assert.deepEqual(GC.usedFirms([{ firm: 'FundedNext', accountType: null }, { firm: ' Bulenox ' }, { firm: '' }, { firm: null }, { firm: 3 }, { firm: 'Lucid', accountType: { firm: 'Topstep' } }]).sort(), ['Bulenox', 'FundedNext', 'Lucid', 'Topstep']);
  assert.deepEqual(GC.typeTree(SAMPLE, GC.usedFirms([{ firm: 'fundednext', accountType: null }])).map(f => f.firm).slice(0, 2), ['FundedNext', 'Apex'], 'a row\'s firm puts it first, without case');
  const tree = GC.typeTree(SAMPLE, used);
  assert.deepEqual(tree.map(f => f.firm + (f.used ? '*' : '')), ['Lucid*', 'Topstep*', 'Apex', 'Bulenox', 'FundedNext']);
  const plans = firm => tree.find(f => f.firm === firm).plans.map(p => p.plan);
  assert.deepEqual(plans('Topstep'), ['Express Funded', 'Trading Combine']);
  assert.deepEqual(plans('Bulenox'), ['Master', 'Other']);
  const ids = (firm, plan) => tree.find(f => f.firm === firm).plans.find(p => p.plan === plan).types.map(x => x.t.id);
  assert.deepEqual(ids('Topstep', 'Trading Combine'), ['t-tc50', 't-tc100'], 'by the size number, not as text');
  assert.deepEqual(ids('Lucid', 'LucidFlex'), ['l-f25e', 'l-f50e', 'l-f50f']);
  assert.deepEqual(ids('Bulenox', 'Master'), ['b-m25t', 'b-m25o', 'b-m25f', 'b-m25q'], 'Eval, Challenge or Test first; Funded, Qualified, Sim-Funded or Account last; the rest between, each A to Z');
  assert.deepEqual(ids('Apex', 'PA'), ['a-50e', 'a-50']);
  assert.deepEqual(GC.typeTree(SAMPLE, []).map(f => f.firm), ['Apex', 'Bulenox', 'FundedNext', 'Lucid', 'Topstep'], 'none in use: A to Z');
  assert.deepEqual(GC.typeTree(SAMPLE, ['lucid']).map(f => f.firm)[0], 'Lucid', 'a firm in use matches without case');
  assert.equal([0, 1, 2].map(i => ['Eval', 'Option 2 EOD', 'Sim-Funded'].map(GC.stageRank)[i]).join(), '0,1,2');
  assert.equal(GC.stageRank('Challenge'), 0); assert.equal(GC.stageRank('Qualified'), 2); assert.equal(GC.stageRank('Account'), 2); assert.equal(GC.stageRank(''), 1);
});

test('type picker (1.32.0): only the last select or Not set sends; Firm and Plan move the picker without sending', () => {
  const tree = GC.typeTree(SAMPLE, ['Lucid']);
  const s0 = GC.cascadeStart(tree, 'l-f50e');
  assert.deepEqual(s0, { firm: 'Lucid', plan: 'LucidFlex', id: 'l-f50e' });
  assert.deepEqual(GC.cascadeStart(tree, ''), { firm: '', plan: '', id: '' });
  /* Firm: nothing sent; a firm with one plan takes it; back to the account's own firm, its own plan */
  let r = GC.cascadePick(tree, s0, 'firm', 'Topstep');
  assert.deepEqual(r, { state: { firm: 'Topstep', plan: '', id: 'l-f50e' }, send: undefined });
  r = GC.cascadePick(tree, r.state, 'plan', 'Trading Combine');
  assert.deepEqual(r, { state: { firm: 'Topstep', plan: 'Trading Combine', id: 'l-f50e' }, send: undefined });
  assert.deepEqual(GC.cascadePick(tree, r.state, 'firm', 'FundedNext'), { state: { firm: 'FundedNext', plan: 'Direct', id: 'l-f50e' }, send: undefined });
  assert.deepEqual(GC.cascadePick(tree, r.state, 'firm', 'Lucid'), { state: { firm: 'Lucid', plan: 'LucidFlex', id: 'l-f50e' }, send: undefined });
  /* the last select sends its type; the placeholder or the type already chosen sends nothing */
  assert.deepEqual(GC.cascadePick(tree, r.state, 'type', 't-tc100'), { state: { firm: 'Topstep', plan: 'Trading Combine', id: 't-tc100' }, send: 't-tc100' });
  assert.equal(GC.cascadePick(tree, r.state, 'type', '').send, undefined);
  assert.equal(GC.cascadePick(tree, s0, 'type', 'l-f50e').send, undefined);
  /* Not set (on the Firm select) sends null once a type is set; with none set it only resets the picker */
  assert.deepEqual(GC.cascadePick(tree, r.state, 'firm', ''), { state: { firm: '', plan: '', id: '' }, send: null });
  assert.deepEqual(GC.cascadePick(tree, { firm: 'Topstep', plan: '', id: '' }, 'firm', ''), { state: { firm: '', plan: '', id: '' }, send: undefined });
  assert.equal(GC.cascadePick(tree, s0, 'other', 'x').send, undefined);
});

test('type picker (1.32.0): the three selects as data (short labels, "(not checked)" on the last, the whole name in the titles, a type gone)', () => {
  const tree = GC.typeTree(SAMPLE, ['Topstep']);
  const v = GC.cascadeView(tree, GC.cascadeStart(tree, 't-tc50'));
  assert.deepEqual(v.firm.options.map(o => o.label), ['Not set', 'Topstep', 'Apex', 'Bulenox', 'FundedNext', 'Lucid']);
  assert.equal(v.firm.value, 'Topstep'); assert.equal(v.plan.value, 'Trading Combine'); assert.equal(v.type.value, 't-tc50');
  assert.deepEqual(v.plan.options.map(o => o.label), ['Express Funded', 'Trading Combine']);
  assert.deepEqual(v.type.options.map(o => [o.label, o.title]), [['50K', 'Topstep Trading Combine 50K'], ['100K (not checked)', 'Topstep Trading Combine 100K (not checked)']]);
  /* Not set: Plan and Size are placeholders; a firm chosen: "Plan" until one is; a plan chosen without its type: "Size" */
  const n = GC.cascadeView(tree, { firm: '', plan: '', id: '' });
  assert.equal(n.firm.value, ''); assert.deepEqual(n.plan.options.map(o => o.label), ['Plan']); assert.deepEqual(n.type.options.map(o => o.label), ['Size']);
  const b = GC.cascadeView(tree, { firm: 'Bulenox', plan: '', id: 't-tc50' });
  assert.deepEqual(b.plan.options.map(o => o.label), ['Plan', 'Master', 'Other']); assert.equal(b.plan.value, '');
  const m = GC.cascadeView(tree, { firm: 'Bulenox', plan: 'Master', id: 't-tc50' });
  assert.equal(m.type.value, ''); assert.equal(m.type.options[0].label, 'Size');
  assert.deepEqual(GC.cascadeView(tree, { firm: 'Bulenox', plan: 'Other', id: '' }).type.options.map(o => o.label), ['Size', 'Legacy plan (not checked)'], 'plan Other: the whole name');
  /* a saved type no longer on The Desk's list: shown where it was, "(not on The Desk's list now)", as before */
  const gone = { firm: 'Lucid', name: 'LucidFlex 150K Eval' }, gs = GC.cascadeStart(tree, 'l-old', gone);
  assert.deepEqual(gs, { firm: 'Lucid', plan: 'LucidFlex', id: 'l-old' });
  const g = GC.cascadeView(tree, gs, gone);
  assert.equal(g.type.value, 'l-old');
  assert.equal(g.type.options.find(o => o.value === 'l-old').label, '150K Eval (not on The Desk\'s list now)');
  assert.equal(g.type.options.find(o => o.value === 'l-old').title, 'Lucid LucidFlex 150K Eval (not on The Desk\'s list now)');
  const gf = GC.cascadeView(tree, GC.cascadeStart(tree, 'x-old', { firm: 'Elite', name: 'Old 50K' }), { firm: 'Elite', name: 'Old 50K' });
  assert.equal(gf.firm.value, 'Elite'); assert.ok(gf.firm.options.some(o => o.value === 'Elite'), 'a firm no longer on the list is still shown');
  assert.equal(gf.plan.value, 'Old'); assert.equal(gf.type.value, 'x-old');
});

test('type picker (1.32.0, "Text + Change"): the Accounts tab shows text and Change; the row sends only on the last select or Not set; Cancel sends nothing; one row', () => {
  const acc = read('live/accounts.js'), grp = read('live/groups.js'), css = read('live/accounts.css');
  /* the select handler: only the open row's selects; Firm and Plan move the picker and return before any send; the last select
     closes the row and sends through the one sendType */
  const h = acc.split("if (a === 'acct-firm' || a === 'acct-plan' || a === 'acct-type') {")[1].split("if (a === 'my-floor'")[0];
  assert.ok(h, 'one change handler for the three selects');
  assert.match(h, /if \(P\.typeEdit !== name \|\| !canTypeNow\(\) \|\| P\.typePending\.has\(name\) \|\| !el\.value\) return;/, 'only the open row, only while The Desk answers; a placeholder sends nothing');
  assert.match(h, /if \(which !== 'type'\) \{\s*P\.typePick = \{ firm: r\.state\.firm, plan: r\.state\.plan \}; render\(\);[^]*?return;\s*\}/, 'Firm and Plan: nothing sent');
  assert.match(h, /P\.typeEdit = ''; P\.typePick = null;\s*if \(r\.send\) sendType\(name, r\.send\); else render\(\);/, 'the last select closes the row and sends its type');
  assert.ok(!/setAccountType|type-clear/.test(h), 'no other send in the handler (Not set is its own button)');
  assert.ok(h.indexOf('sendType(') > h.indexOf("if (which !== 'type')"));
  /* the clicks: Change or Set opens one row (another closes); Cancel closes it, nothing sent; Not set sends null, only with a type */
  const clicks = acc.split("listEl.addEventListener('click'")[1].split("listEl.addEventListener('change'")[0];
  assert.match(clicks, /else if \(a === 'type-edit'\) \{ const open = P\.typeEdit !== id && canTypeNow\(\); P\.typeEdit = open \? id : ''; P\.typePick = null; render\(\);/, 'one row at a time: P.typeEdit holds one account');
  assert.match(clicks, /else if \(a === 'type-cancel'\) \{ P\.typeEdit = ''; P\.typePick = null; render\(\); \}/, 'Cancel sends nothing');
  assert.match(clicks, /else if \(a === 'type-clear'\) \{ const ok = P\.typeEdit === id && canTypeNow\(\) && !P\.typePending\.has\(id\) && !!typeVal\(id\);[^}]*if \(ok\) sendType\(id, ''\); else render\(\); \}/, 'Not set sends null');
  assert.equal(clicks.split('sendType(').length, 2, 'one send among the clicks (Not set)');
  assert.equal(acc.split('F.setAccountType(').length, 2, 'one PUT route as before (sendType)');
  assert.match(acc, /F\.setAccountType\(name, want \|\| null\)/);
  /* the cell: text, Change or Set only while The Desk answers; "Not set" offered in the row only when a type is set */
  assert.match(acc, /const edit = canType && !pend \? `<button type="button" class="ac-btn apg-tedit" data-act="type-edit"/, 'read only while The Desk is not reachable, as before');
  assert.match(acc, /const text = cur \? cur\.name : goneNow \? \(g\.firm \? g\.firm \+ ' ' : ''\) \+ g\.name \+ ' \(not on The Desk\\'s list now\)' : val \? val : 'Not set';/);
  assert.match(acc, /\(val \? `<button type="button" class="ac-btn" data-act="type-clear"/);
  assert.match(acc, /if \(!typesOn \|\| P\.typeEdit !== a\.name \|\| !canType \|\| P\.typePending\.has\(a\.name\)\) return '';/, 'the row shows only for the open account while The Desk answers');
  assert.match(acc, /\+ typeRow\(a\) \+ askApply\(a\) \+ typeWarn\(a\);/);
  /* the rules dialog keeps the three selects; the widths of 1.30.0 again on the Accounts tab */
  assert.match(grp, /const chosen = pick\.id;/, 'the dialog links the type chosen last, not the Size select\'s placeholder');
  assert.match(grp, /if \(r\.send === null\) \{ filled = null; fromIdle\(\); \}\s*else if \(r\.send\) \{ const t = typeById\(r\.send\); if \(t\) fill\(t\); \}/, 'the dialog fills only on the last select');
  assert.match(css, /\.apg-acc-g\.apg-grps\.apg-types \.gr-row \{ grid-template-columns: [^}]* minmax\(0, 2\.4fr\) 116px 128px 152px 44px; \}/);
});
