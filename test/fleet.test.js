// The Fleet tab's core (live/fleet.js FleetCore): the traders and the prop accounts from ChartBridge's own messages, the day's
// profit stop mark as ChartBridge 0.6.19 computes it, and when Kill all may be sent. Made-up accounts and traders.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../live/fleet.js');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const accounts = {
  type: 'accounts', personalNamed: true, list: [
    { name: 'MINE-1', sim: false, connection: 'connected', personal: true, prop: false, pnlToday: 40, positions: [] },
    { name: 'EVAL-A', sim: false, connection: 'connected', personal: false, prop: true, group: 'g1', pnlToday: 310, roomFloor: 3140, targetLeft: 1860,
      rules: { size: 50000, target: 3000, consistency: 40, own: false }, positions: [{ root: 'MNQ', name: 'MNQ 12-26', qty: 4, avgPrice: 25000 }], why: {} },
    { name: 'EVAL-B', sim: false, connection: 'connected', personal: false, prop: true, group: 'g1', pnlToday: 1200, roomFloor: 2380, targetLeft: 520,
      rules: { size: 50000, target: 3000, consistency: 40, own: false }, positions: [], why: {} },
    { name: 'FUND-A', sim: false, connection: 'connected', personal: false, prop: true, group: 'g2', pnlToday: -155.5, roomFloor: null, targetLeft: null,
      rules: { size: 50000, target: null, consistency: null, own: false }, positions: [], why: { roomFloor: 'no intraday high is known for this account' } },
    { name: 'LOOSE-1', sim: false, connection: 'disconnected', personal: false, prop: true, group: null, pnlToday: null, positions: [], rules: null },
    { name: 'NOTYPE-1', sim: false, connection: 'connected', personal: false, prop: true, group: 'g3', pnlToday: 0, roomFloor: 1000, targetLeft: 1250,
      rules: { size: 25000, target: 1250, consistency: 40 }, positions: [] },
    { name: 'Sim101', sim: true, connection: 'connected', personal: false, prop: false, pnlToday: 0, positions: [] },
  ] };
const groups = { type: 'groups', list: [
  { id: 'g1', name: 'Evals', accountType: 'eval', target: 3000, consistency: 40, members: ['EVAL-A', 'EVAL-B'] },
  { id: 'g2', name: 'Funded', accountType: 'funded', members: ['FUND-A'] },
  { id: 'g3', name: 'New', accountType: null, members: ['NOTYPE-1'] }] };
const agent = (id, more) => Object.assign({ type: 'agent', agent: id, name: id, build: 'b1', enabled: true, connected: true, mode: 'auto', account: 'EVAL-A', sim: false,
  rules: { roots: ['NQ', 'MNQ'], entryFrom: '09:40', entryUntil: '15:00', flatAt: '15:55' }, pnlToday: 0, trades: 0, losses: 0, killed: false, standDown: null, owns: false, lastBeatMs: 400 }, more || {});

test('fleet: the day stop mark is the smaller of the plan\'s value and the consistency share of the target, and a funded account has only the plan\'s', () => {
  const r = { target: 3000, consistency: 40 };
  assert.deepStrictEqual(F.dayMark(r, 'eval', 0), { mark: 1200, from: '40% of the $3,000 target' });
  assert.deepStrictEqual(F.dayMark(r, 'eval', 2000), { mark: 1200, from: '40% of the $3,000 target' });
  assert.deepStrictEqual(F.dayMark(r, 'eval', 900), { mark: 900, from: "the plan's day stop" });
  assert.deepStrictEqual(F.dayMark(r, '', 0), { mark: 1200, from: '40% of the $3,000 target' }, 'no Type is not funded: the mark applies (ChartBridgeAgents.DayMark)');
  assert.strictEqual(F.dayMark(r, 'funded', 0), null);
  assert.deepStrictEqual(F.dayMark(r, 'funded', 2000), { mark: 2000, from: "the plan's day stop" });
  assert.strictEqual(F.dayMark({ target: 3000, consistency: null }, 'eval', 0), null);
  assert.strictEqual(F.dayMark(null, 'eval', 0), null);
  assert.deepStrictEqual(F.dayMark({ target: 1250, consistency: 50 }, 'eval', 0), { mark: 625, from: '50% of the $1,250 target' });
  // the C# it mirrors: the same condition and the same rounding
  const cs = read('nt8', 'ChartBridgeAgents.cs');
  assert.match(cs, /if \(stage != "funded" && n != null && n\.R != null && n\.R\.Consistency > 0 && n\.R\.Target > 0\)/);
  assert.match(cs, /double c = Math\.Round\(n\.R\.Consistency \/ 100\.0 \* n\.R\.Target, 2\);/);
});

test('fleet: traders: mode, account and its kind, window, the two entry switches, the day stop, and who is on duty', () => {
  const list = [
    agent('germanicus', { rules: { entryFrom: '09:40', entryUntil: '15:00', flatAt: '15:55', marketEntry: true, noTarget: true }, dayStop: 900, owns: true }),
    agent('manrae', { account: 'MINE-1' }),
    agent('shadow1', { mode: 'shadow', account: 'EVAL-B' }),
    agent('downed', { account: 'EVAL-B', standDown: "the day's profit stop is reached on EVAL-B" }),
    agent('killed1', { account: 'EVAL-B', killed: true }),
    agent('away', { account: 'EVAL-B', connected: false }),
    agent('nowhere', { account: null }),
    agent('grp', { account: null, group: { id: 'g1', name: 'Evals' }, seats: [{ account: 'EVAL-A' }, { account: 'EVAL-B' }] }),
    agent('simmer', { account: 'Sim101' }),
  ];
  const t = Object.fromEntries(F.traders(list, accounts, '0.6.19').map(x => [x.id, x]));
  assert.deepStrictEqual(Object.keys(t), ['away', 'downed', 'germanicus', 'grp', 'killed1', 'manrae', 'nowhere', 'shadow1', 'simmer'], 'in id order');
  const g = t.germanicus;
  assert.deepStrictEqual([g.modeText, g.kind, g.onDuty, g.accountText, g.window, g.flatAt], ['Auto', 'prop', true, 'EVAL-A', '09:40 to 15:00', '15:55']);
  assert.deepStrictEqual([g.marketEntry, g.noTarget, g.switchesKnown, g.dayStop, g.dayStopKnown, g.status], [true, true, true, 900, true, 'In a trade']);
  assert.deepStrictEqual([t.manrae.kind, t.manrae.onDuty, t.manrae.marketEntry, t.manrae.noTarget, t.manrae.dayStop], ['personal', false, false, false, null], 'Auto on the personal account is not the Prop Business on duty');
  assert.strictEqual(t.shadow1.onDuty, false);
  assert.deepStrictEqual([t.downed.onDuty, t.downed.tone, t.downed.status], [false, 'standDown', "Stood down: the day's profit stop is reached on EVAL-B"]);
  assert.deepStrictEqual([t.killed1.onDuty, t.killed1.tone], [false, 'killed']);
  assert.deepStrictEqual([t.away.onDuty, t.away.tone], [false, 'lost']);
  assert.deepStrictEqual([t.nowhere.kind, t.nowhere.accountText, t.nowhere.onDuty], ['none', 'None', false]);
  assert.deepStrictEqual([t.grp.kind, t.grp.accountText, t.grp.onDuty], ['prop', 'Group Evals: EVAL-A, EVAL-B', true]);
  assert.deepStrictEqual([t.simmer.kind, t.simmer.onDuty], ['sim', false]);
  // an older ChartBridge: the switches and the day stop are said to be not known, never shown as off or none
  const old = F.traders(list, accounts, '0.6.17').find(x => x.id === 'germanicus');
  assert.deepStrictEqual([old.switchesKnown, old.dayStopKnown], [false, false]);
  // no personal account picked: nothing is prop, nobody is on duty
  const none = F.traders(list, Object.assign({}, accounts, { personalNamed: false, list: accounts.list.map(a => Object.assign({}, a, { prop: false, personal: false })) }), '0.6.19');
  assert.ok(none.every(x => !x.onDuty));
  assert.strictEqual(F.dutyLine(F.traders(list, accounts, '0.6.19')), 'On duty: germanicus, grp (more than one trader in Auto on prop accounts)');
  assert.strictEqual(F.dutyLine(F.traders([list[0]], accounts, '0.6.19')), 'On duty: germanicus, Auto on EVAL-A');
  assert.strictEqual(F.dutyLine(F.traders([list[1]], accounts, '0.6.19')), 'Nobody on duty: no trader is in Auto on prop accounts');
  assert.strictEqual(F.dutyLine([]), 'No traders yet');
});

test('fleet: prop accounts only: stage, progress, cushion, today, the day stop mark and why the runner would size it 0', () => {
  const list = [agent('germanicus', { dayStop: 900 }), agent('other', { account: 'FUND-A', dayStop: 2000 })];
  const rows = F.propAccounts(accounts, groups, list);
  assert.deepStrictEqual(rows.map(r => r.name), ['EVAL-A', 'EVAL-B', 'FUND-A', 'LOOSE-1', 'NOTYPE-1'], 'the personal account and the Sim account are not here');
  const a = Object.fromEntries(rows.map(r => [r.name, r]));
  assert.deepStrictEqual([a['EVAL-A'].stageText, a['EVAL-A'].group, a['EVAL-A'].progressText, a['EVAL-A'].cushion, a['EVAL-A'].today], ['Eval', 'Evals', '$1,140 of $3,000', 3140, 310]);
  assert.deepStrictEqual([a['EVAL-A'].mark, a['EVAL-A'].markText, a['EVAL-A'].done, a['EVAL-A'].position, a['EVAL-A'].traders], [900, "$310 of $900 (the plan's day stop)", false, 'Long 4 MNQ', ['germanicus']]);
  assert.deepStrictEqual([a['EVAL-B'].mark, a['EVAL-B'].markText, a['EVAL-B'].done, a['EVAL-B'].position, a['EVAL-B'].traders], [1200, '$1,200 of $1,200 (40% of the $3,000 target)', true, 'Flat', []]);
  assert.deepStrictEqual([a['FUND-A'].stageText, a['FUND-A'].progressText, a['FUND-A'].cushion, a['FUND-A'].cushionWhy, a['FUND-A'].today, a['FUND-A'].mark], ['Funded', 'no target in its rules', null, 'no intraday high is known for this account', -155.5, 2000]);
  assert.strictEqual(a['FUND-A'].markText, "-$155.50 of $2,000 (the plan's day stop)");
  assert.deepStrictEqual([a['LOOSE-1'].stageText, a['LOOSE-1'].position, a['LOOSE-1'].today, a['LOOSE-1'].markText], ['No type', 'Not connected', null, 'none']);
  assert.match(a['LOOSE-1'].sizeNote, /In no group: the runner sizes it 0/);
  assert.match(a['NOTYPE-1'].sizeNote, /Its group has no Type \(eval or funded\): the runner sizes it 0/);
  assert.strictEqual(a['NOTYPE-1'].mark, 500, 'no Type is not funded: the consistency mark applies');
  assert.strictEqual(a['EVAL-A'].sizeNote, '');
  // a funded account with no plan value has no mark
  assert.strictEqual(F.propAccounts(accounts, groups, []).find(r => r.name === 'FUND-A').markText, 'none (funded, and no plan value)');
  assert.deepStrictEqual(F.propAccounts(null, null, null), []);
});

test('fleet: Kill all is offered only to a ChartBridge that knows it, signed in, with a personal account picked; its message has no other key', () => {
  assert.deepStrictEqual(F.killAllState('0.6.19', accounts, true, true), { ok: true, why: '' });
  assert.match(F.killAllState('0.6.16', accounts, true, true).why, /needs ChartBridge 0\.6\.17 or later \(this one is 0\.6\.16\)/);
  assert.match(F.killAllState('0.6.19', accounts, false, true).why, /Sign in to trading first/);
  assert.match(F.killAllState('0.6.19', Object.assign({}, accounts, { personalNamed: false }), true, true).why, /No personal account is picked yet, so no account is prop/);
  assert.match(F.killAllState('0.6.19', null, true, true).why, /No personal account is picked yet/);
  assert.match(F.killAllState('0.6.19', accounts, true, false).why, /not connected/);
  assert.deepStrictEqual(F.killAllMsg('c1'), { type: 'agentKillAllProp', cid: 'c1' });
  assert.deepStrictEqual(F.killAllMsg(), { type: 'agentKillAllProp' });
  assert.match(read('nt8', 'ChartBridgeAgents.cs'), /\{ "agentKillAllProp", new\[\] \{ "type", "cid" \} \},/, 'ChartBridge takes exactly these keys');
});

test('fleet: dollars', () => {
  assert.deepStrictEqual([F.usd(1200), F.usd(-310), F.usd(310, true), F.usd(0, true), F.usd(155.5), F.usd(null), F.usd(NaN)], ['$1,200', '-$310', '+$310', '$0', '$155.50', '', '']);
});

test('fleet: the tab is wired into the page beside the other three, sends one kind of message, and builds no order', () => {
  const src = read('live', 'fleet.js'), html = read('live', 'index.html'), ws = read('live', 'workspace.js');
  assert.match(html, /<button type="button" class="ws-btn fl-tabbtn" id="wsFleetTab" aria-pressed="false"[^>]* hidden>Fleet<\/button>/, 'hidden until ChartBridge says it knows Kill all');
  assert.match(html, /<section class="fl-view fl-in-ws" id="flView" aria-label="Fleet tab"><\/section>/);
  assert.ok(html.indexOf('<script src="fleet.js"></script>') > 0 && html.indexOf('<script src="fleet.js"></script>') < html.indexOf('<script src="workspace.js"'), 'loaded before workspace.js');
  const files = JSON.parse(read('nt8', 'install-files.json'));
  assert.ok(files.www.some(x => x.from === 'live/fleet.js' && x.to === 'fleet.js') && files.www.some(x => x.from === 'live/fleet.css' && x.to === 'fleet.css'), 'installed on the PCs with the page');
  for (const id of ['wsAgentTab', 'wsLeagueTab', 'wsBotTab']) assert.ok(html.includes('id="' + id + '"'), id + ' is still there: Fleet replaces none of them yet');
  assert.match(ws, /startBot\(\); startAgent\(\); startLeague\(\); startFleet\(\);/);
  assert.strictEqual((ws.match(/fleetView && fleetView\.shown\(\)\) fleetView\.showTab\(false\);/g) || []).length, 5, 'closed by each other tab, a layout tab and a layout change: one view at a time');
  // the only message the view posts is Kill all, and only after the question's Yes
  const posts = src.match(/V3\.post\([^;]*\)/g) || [];
  assert.deepStrictEqual(posts, ['V3.post(C.killAllMsg(S.pending))']);
  assert.match(src, /else if \(b\.dataset\.do === 'yes'\) \{ if \(S\.ask\) killAll\(\); \}/, 'Yes counts only while the question is up');
  assert.match(src, /const st = C\.killAllState\(S\.version, S\.accounts, S\.signedIn, S\.connected\);\s*endAsk\(\);\s*if \(!st\.ok\)/, 'checked again at the moment it is sent');
  for (const word of ["type: 'order'", "type: 'flatten'", "type: 'agentMode'", "type: 'agentRules'", "type: 'agentKill'", 'accountPersonal'])
    assert.ok(!src.includes(word), 'no ' + word + ' in the Fleet tab');
  assert.ok(!/confirm\(|alert\(|prompt\(/.test(src), 'no browser dialog');
  assert.ok(!/[–—]/.test(src + read('live', 'fleet.css')), 'no long dashes');
});
