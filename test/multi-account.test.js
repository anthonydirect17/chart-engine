// Chart 1.37.0 (ChartBridge 0.6.7): the Multi-Account panel's pure parts (live/multi-account.js MultiAccountCore), the panel in the
// workspace's layouts, the Account page without its Copier tab, the room right's Custom widths, the engine's lines and labels and the
// canvas on whole device pixels (the source), and ChartBridge 0.6.7's bench in its source. Made-up accounts and money only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const MC = require('../live/multi-account.js');
const W = require('../live/workspace.js');
const CE = require('../src/chart-engine.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

/* made-up accounts: Lucid's SIM-A, SIM-B (own rules), SIM-D on the bench, SIM-E Lucid in no group, SIM-G no type, SIM-H another firm */
const rules = dd => ({ own: true, drawdown: dd, size: 50000, drawdownType: 'eod' });
const S = {
  accounts: [
    { name: 'SIM-A', sim: true, group: 'g1', roomFloor: 4400, rules: rules(4500), positions: [] },
    { name: 'SIM-B', sim: true, group: 'g1', roomFloor: 1500, rules: rules(2000), positions: [{ root: 'MNQ', qty: 2 }] },
    { name: 'SIM-D', sim: true, group: 'g1', roomFloor: 640, rules: rules(2000), positions: [] },
    { name: 'SIM-C', sim: false, group: 'g1', roomFloor: null, rules: { own: false, drawdown: 2000 }, positions: [] },
    { name: 'SIM-E', sim: true, group: null, roomFloor: 2000, rules: null, positions: [] },
    { name: 'SIM-G', sim: true, group: null, roomFloor: null, rules: null, positions: [] },
    { name: 'SIM-H', sim: true, group: 'g2', roomFloor: 2500, rules: rules(2500), positions: [] },
  ],
  desk: new Map([
    ['SIM-A', { firm: 'Lucid', accountType: { id: 't150', firm: 'Lucid', name: '150K Flex eval' } }],
    ['SIM-B', { firm: 'Lucid', accountType: { id: 't50', firm: 'Lucid', name: '50K Flex eval' } }],
    ['SIM-D', { firm: 'Lucid', accountType: { id: 't50', firm: 'Lucid', name: '50K Flex eval' } }],
    ['SIM-C', { firm: 'Lucid', accountType: null }],
    ['SIM-E', { firm: 'Lucid', accountType: { id: 't50', firm: 'Lucid', name: '50K Flex eval' } }],
    ['SIM-G', { firm: 'Lucid', accountType: null }],
    ['SIM-H', { firm: 'Apex', accountType: { id: 'a50', firm: 'Apex', name: '50K eval' } }],
  ]),
};
const g1 = { id: 'g1', name: 'Lucid', riskPct: 5, members: ['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D'], benched: ['SIM-D'], side: null };

test('1.37.0 lanes: members by the bench flag, the firm\'s accounts in no group on the bench, each chip\'s own dollars, the sums', () => {
  const L = MC.lanes(g1, S, [{ account: 'SIM-A', state: 'working' }]);
  assert.equal(L.firm, 'Lucid');
  assert.deepEqual(L.active.map(c => c.name), ['SIM-A', 'SIM-B', 'SIM-C']);
  assert.deepEqual(L.bench.map(c => c.name), ['SIM-D', 'SIM-E', 'SIM-G'], 'benched members first, then the firm\'s accounts in no group; never another firm\'s (SIM-H)');
  const a = L.active[0], b = L.active[1], c = L.active[2];
  assert.equal(a.risk, 225, '5% of SIM-A\'s own $4,500');
  assert.equal(b.risk, 100);
  assert.equal(c.risk, null, 'no rules of its own: no risk, no type');
  assert.ok(c.notype && !a.notype);
  assert.equal(a.busy, '1 working order'); assert.equal(b.busy, 'long 2 MNQ');
  assert.equal(L.risk, 325);
  assert.equal(MC.sumText(L), '3 accounts · $325 at risk a trade');
  assert.equal(MC.benchText(L), '1 sitting out, 2 not in the group');
  assert.equal(L.flat, false);
  assert.ok(L.bench.find(x => x.name === 'SIM-E').member === false && L.bench.find(x => x.name === 'SIM-G').notype === true);
  assert.equal(L.bench[0].room, 640);
  assert.equal(MC.lanes(Object.assign({}, g1, { members: ['SIM-D'], benched: ['SIM-D'] }), S, []).flat, true);
});

test('1.37.0 moves: refused (with why) unless a member, typed to go in, and flat with nothing working', () => {
  const L = MC.lanes(g1, S, [{ account: 'SIM-A', state: 'working' }]), c = n => L.active.concat(L.bench).find(x => x.name === n);
  assert.match(MC.moveWhy(c('SIM-B'), false, 'Lucid'), /^SIM-B is in a trade or has working orders \(long 2 MNQ\)\. It moves once it is flat with no working orders\.$/);
  assert.match(MC.moveWhy(c('SIM-E'), true, 'Lucid'), /^SIM-E is not in Lucid: put it in the group on the Accounts tab/);
  assert.match(MC.moveWhy(c('SIM-C'), true, 'Lucid'), /has no account type on The Desk/);
  assert.equal(MC.moveWhy(c('SIM-D'), true, 'Lucid'), '');
  assert.deepEqual(MC.benchMessage('SIM-D', false, 'c1'), { type: 'memberBench', cid: 'c1', account: 'SIM-D', benched: false });
});

test('1.37.0 group settings and New group: name, Type and risk only to ChartBridge 0.6.7; an older one gets its own rules back', () => {
  const groups = [g1, { id: 'g2', name: 'Apex' }];
  assert.deepEqual(MC.saveMessage(g1, { name: 'Lucid Flex', accountType: 'funded' }, groups, 'c', true).msg, { type: 'groupSave', cid: 'c', group: 'g1', name: 'Lucid Flex', accountType: 'funded' });
  assert.deepEqual(MC.saveMessage(g1, { riskPct: 4 }, groups, 'c', true).msg, { type: 'groupSave', cid: 'c', group: 'g1', name: 'Lucid', riskPct: 4 });
  assert.deepEqual(MC.saveMessage(null, { name: 'Tradeify', accountType: 'eval', riskPct: 5 }, groups, 'c', true).msg, { type: 'groupSave', cid: 'c', name: 'Tradeify', accountType: 'eval', riskPct: 5 });
  assert.match(MC.saveMessage(null, { name: 'apex' }, groups, 'c', true).error, /A group named apex is there already/);
  assert.match(MC.saveMessage(g1, { name: '' }, groups, 'c', true).error, /1 to 30/);
  const old = Object.assign({}, g1, { size: 50000, drawdown: 2000, drawdownType: 'eod', target: 3000, lockAt: 50100, dailyLoss: null, consistency: null });
  assert.deepEqual(MC.saveMessage(old, { riskPct: 6 }, groups, 'c', false).msg, { type: 'groupSave', cid: 'c', group: 'g1', name: 'Lucid', noHedge: true, dailyLoss: 0, drawdown: 2000, drawdownType: 'eod', target: 3000, size: 50000, lockAt: 50100, consistency: 0, riskPct: 6 });
  assert.match(MC.saveMessage(null, { name: 'New' }, groups, 'c', false).error, /needs ChartBridge 0\.6\.7/);
  assert.deepEqual(MC.parseRisk('5'), { value: 5 }); assert.deepEqual(MC.parseRisk('2.5%'), { value: 2.5 });
  for (const bad of ['0', '101', '', 'x', '1.234']) assert.ok(MC.parseRisk(bad).error, bad);
  assert.ok(MC.benchOn({ benched: [] }, '') && !MC.benchOn({}, '0.6.6') && MC.benchOn({}, '0.6.7') && MC.verAtLeast('0.7.0', '0.6.7'));
});

test('1.37.0 the workspace: the Multi-Account panel (one a layout), an old layout loads as it was', () => {
  const l = W.cleanLayout({ panels: [{ id: 'm1', type: 'multi', x: 0, y: 0, w: 6, h: 3 }, { id: 'm2', type: 'multi', x: 6, y: 0, w: 6, h: 3 }, { id: 'c1', type: 'chart', root: 'MNQ', tf: 'm1', x: 0, y: 3, w: 6, h: 3 }] });
  assert.deepEqual(l.panels.map(p => p.type), ['multi', 'chart'], 'one Multi-Account panel a layout');
  const old = W.cleanLayout({ panels: [{ id: 'b1', type: 'bot', x: 0, y: 0, w: 2, h: 1 }, { id: 'a1', type: 'accounts', x: 2, y: 0, w: 6, h: 3 }] });
  assert.deepEqual(old.panels.map(p => p.type), ['accounts'], 'a 1.35.0 layout still loads (its Bot panel dropped as in 1.36.0)');
  const html = read('live/index.html');
  assert.ok(html.includes('data-add="multi"') && html.includes('src="multi-account.js"') && html.includes('href="multi-account.css"'));
  assert.ok(!html.includes('id="wsGroupsCol"') && !html.includes('id="wsGroupNew"'), 'Settings has no Account groups column (made and set on the panel)');
  const files = JSON.parse(read('nt8/install-files.json'));
  assert.ok(JSON.stringify(files).includes('live/multi-account.js') && JSON.stringify(files).includes('live/multi-account.css'));
  const acc = read('live/accounts.js');
  assert.match(acc, /const TABS = \[\n  \{ id: 'acc'[^\n]*\n  \{ id: 'trd', name: 'Today\\'s trades', short: 'Trades' \}, \{ id: 'log', name: 'Log', short: 'Log' \},\n\];/, 'the Account page has no Copier tab');
  assert.match(acc, /const only = host\.only === 'cop';/);
  const ma = read('live/multi-account.js');
  assert.match(ma, /const no = F\.joinRefusal\(name, g\)/, 'the chip\'s join asks the Accounts tab\'s own checks');
  assert.match(ma, /window\.AccountsCore\.keptChange\(why\)\) \{ if \(p\.chip\) P\.chipWhy\.delete\(p\.chip\); say\('Done, with a warning: ' \+ why, true\); continue; \}/,
    'review N2: a change ChartBridge made but could not save yet shows as done with a warning, never as refused');
  assert.match(ma, /const plan = F\.joinPlan\(name, g, acc\);/, 'and its own plan (rules from the type, the highest close)');
  assert.match(ma, /F\.accountGroup\(j\.account, j\.group, box \? box\.value : '', j\.rules, c2\)/, 'Put in sends the Accounts tab\'s accountGroup');
  assert.doesNotMatch(read('live/groups.js'), /mountSettings/, 'the Settings group dialog is gone');
});

test('1.37.0 the chart: room right Custom (40 to 600 px) and the gap drag, the lighter lines, see-through labels, the canvas on whole device pixels', () => {
  const src = read('src/chart-engine.js');
  assert.equal(CE.util.ROOM_MIN, 40); assert.equal(CE.util.ROOM_MAX, 600);
  assert.equal(CE.util.LINE_SOFT, 0.6); assert.equal(CE.util.LABEL_SOFT, 0.55);
  assert.match(src, /hline\(y, T\.exit, null, hot \? 1 : LINE_SOFT, hot \? 1\.5 : 1\);/, 'the position line 1 px at 60%, full and 1.5 px while hot');
  assert.match(src, /if \(see && !\(od && od\.id === hid\) && !labelNear\(x, top, w\) && candlesBehind\(x, top, w\)\) alpha \*= LABEL_SOFT;/);
  assert.match(src, /W = cw \/ dpr; H = chh \/ dpr;/, 'the canvas sized in whole device pixels');
  assert.match(src, /snapCheck\(now\);/);
  assert.match(src, /emit\('room', o\.room\)/);
});

test('ChartBridge 0.6.7: the bench flag, never blocking an exit, the group\'s own rules optional, no hedging always on', () => {
  const g = read('nt8/ChartBridgeGroups.cs'), a = read('nt8/ChartBridgeAgents.cs');
  assert.match(read('nt8/ChartBridge.cs'), /public const string Version = "0\.6\.[78]";/);
  assert.match(g, /\(p\.Length != 3 && !\(p\.Length == 4 && p\[3\] == "benched"\)\)/, 'a member line may carry benched');
  assert.match(g, /Append\(s\.Benched\.Contains\(kv\.Key\) \? "\\tbenched" : ""\)/, 'written only for a benched member');
  assert.match(g, /if \(g\.Benched\.Contains\(name\)\) \{ s\.Out = BenchedOut; continue; \}/, 'a group entry skips a benched member');
  assert.match(g, /g\.NoHedge = true;/);
  assert.match(g, /BenchBusyWhy/);
  assert.doesNotMatch(g.slice(g.indexOf('public static string EntryCheck('), g.indexOf('private static List<ChartBridgeOrders.GroupHolding> Holdings(')), /Benched/, 'the one-direction check (and so every exit) never reads the bench');
  assert.match(a, /benchNow\.Contains\(seats\[i\]\) \|\| benchFresh\.Contains\(seats\[i\]\) \? "benched"/, 'an agent\'s benched seat sits out');
  assert.ok(a.includes(',\\"benched\\":[" + string.Join(","'), 'welcome names the benched seats');
});
