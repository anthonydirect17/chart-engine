'use strict';
// Chart 1.29.0 (ChartBridge 0.6.2, SPEC CE-2): a hero stood down on a group, Clear stand-down on the board, and league seats
// (one Sim account; PROVING n of 100). The pure parts: AgentCore's league picker and account change, boardRows' stand-down and
// league rows, the clear message; AgentHelper.proving; the page's wiring; the fake bridge's keys against ChartBridge's.
// Made-up agents (demo, demotwo), accounts (SIM-A, SIM-B, EVAL-A, Sim101), builds, kinds and whys: sample data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AH = require('../live/agent-helper.js');
const AC = require('../live/agent-core.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const ACCOUNTS = { type: 'accounts', list: [
  { name: 'SIM-A', sim: true, tradable: true, state: 'active' }, { name: 'SIM-B', sim: true, tradable: true, state: 'active' },
  { name: 'EVAL-A', sim: false, tradable: true, state: 'active' }, { name: 'Sim101', sim: true, tradable: false, state: 'active' } ] };
const GROUPS = { type: 'groups', list: [{ id: 'g1', name: 'Group A', members: ['SIM-A', 'SIM-B'], accountType: 'eval' }], error: null };
const agent = o => Object.assign({ type: 'agent', agent: 'demo', name: 'Sample Hero A', build: 'sample-build-1', enabled: true, connected: true, mode: 'shadow', account: 'SIM-B', sim: true,
  rules: { roots: ['MNQ'], maxQty: { MNQ: 20 }, entryFrom: '09:45', entryUntil: '15:00', flatAt: '15:55', maxExpireSec: 1800, maxTrades: null, maxLosses: null }, killed: false, standDown: null, owns: false, league: false, standDowns: [] }, o || {});

test('league seats in the picker: a Sim account offered, a LIVE one listed with the reason, another\'s account with why', () => {
  const others = { bot: { enabled: true, account: 'SIM-A' }, copier: null, agents: [] };
  const ch = AC.pickerChoices(ACCOUNTS, GROUPS, agent(), others).filter(c => c.kind === 'league');
  assert.deepEqual(ch.map(c => [c.value, c.ok]), [['league:SIM-A', false], ['league:SIM-B', true], ['league:EVAL-A', false]], 'Sim first; Sim101 is not tradable now: not listed');
  assert.equal(ch[0].text, 'League seat: SIM-A (SIM), the bot\'s account');
  assert.equal(ch[1].text, 'League seat: SIM-B (SIM)', 'his own account as a league seat: offered (a change)');
  assert.equal(ch[2].text, 'League seat: EVAL-A (LIVE), cannot be: a league seat is a Sim account only (EVAL-A is LIVE)');
  const now = AC.pickerChoices(ACCOUNTS, GROUPS, agent({ league: true }), others);
  assert.ok(now.find(c => c.value === 'league:SIM-B').current && /, now$/.test(now.find(c => c.value === 'league:SIM-B').text));
  assert.ok(!now.find(c => c.value === 'SIM-B').current && now.find(c => c.value === 'SIM-B').ok, 'the plain account is a change back (no longer a league seat)');
});

test('league: the account change message, never LIVE, never a group; the strip\'s league', () => {
  const a = agent({ account: 'SIM-A' }), ch = AC.pickerChoices(ACCOUNTS, GROUPS, a, { agents: [a] });
  const r = AC.accountChange(a, 'league:SIM-B', ch, { roots: ['MNQ'] }, 'c1');
  assert.deepEqual(r, { msg: { type: 'agentAccount', cid: 'c1', agent: 'demo', account: 'SIM-B', league: true, keepMode: 'shadow' }, live: false, confirm: '', mode: 'shadow' });
  assert.equal(AC.accountChange(a, 'league:EVAL-A', ch, {}).error, 'A league seat is a Sim account only: EVAL-A is LIVE.');
  assert.match(AC.accountChange(a, 'league:Sim101', ch, {}).error, /Sim101 is not tradable in ChartBridge now/);
  const plain = AC.accountChange(a, 'SIM-B', ch, {}, 'c2');
  assert.equal(plain.msg.league, undefined, 'a plain account: no league key');
  const acc = AC.agentAccount(agent({ league: true }));
  assert.deepEqual([acc.value, acc.label, acc.league], ['league:SIM-B', 'League seat: SIM-B', true]);
  assert.equal(AC.agentAccount(agent()).value, 'SIM-B');
});

test('PROVING n of 100 from the helper\'s liveN, read only', () => {
  assert.equal(AH.proving({ build: 'x', liveN: 37 }).text, 'PROVING 37 of 100');
  assert.equal(AH.proving({ build: 'x' }).text, 'PROVING (live trades not reported)');
  assert.equal(AH.proving(null).n, null);
  assert.equal(AH.PROVING_OF, 100);
});

test('the board: a stand-down under its hero (amber, with Clear), one for a hero not shown, the file unreadable, a league row', () => {
  const at = Date.UTC(2026, 9, 16, 14, 42);
  const sd = { group: 'g1', why: 'sample: live mean below the exam mean by more than 2 SE', kind: 'edge watch', at };
  const demo = agent({ account: null, group: { id: 'g1', name: 'Group A' }, seats: [{ account: 'SIM-A' }, { account: 'SIM-B' }], standDowns: [sd], standDown: 'build sample-build-1 stands down on group Group A (...)' });
  const two = agent({ agent: 'demotwo', name: 'Sample Hero B', build: 'sample-build-2', account: 'Sim101', league: true });
  const status = { agents: { demo: { on: true, runningBuild: 'sample-build-1' }, demotwo: { on: true, runningBuild: 'sample-build-2' } },
    builds: [{ build: 'sample-build-1', hero: 'Sample Hero A', tier: 'Good' }, { build: 'sample-build-2', hero: null, liveN: 12 }] };
  const msg = { type: 'agentStandDowns', list: [{ build: 'sample-build-1', group: 'g1', name: 'Group A', why: sd.why, kind: sd.kind, at },
    { build: 'sample-build-9', group: 'g1', name: 'Group A', why: 'sample: three eval blows in a row', kind: 'blow streak', at }], error: null };
  const M = AC.boardRows({ agents: [demo, two], groups: GROUPS, accounts: ACCOUNTS, standDowns: msg, status, reach: 'ok', AH });
  assert.deepEqual(M.heroes[0].standDowns, [{ build: 'sample-build-1', group: 'g1', name: 'Group A', kind: 'edge watch', why: sd.why, at, when: 'Oct 16, 10:42 ET' }]);
  assert.equal(M.heroes[0].standDown, 'build sample-build-1 stands down on group Group A (...)');
  assert.deepEqual(M.standDowns.map(s => [s.build, s.group, s.kind]), [['sample-build-9', 'g1', 'blow streak']], 'a hero not shown on any row keeps his own amber row');
  assert.equal(M.sdError, '');
  assert.equal(M.heroes[0].league, false, 'a group is never a league seat');
  assert.equal(M.heroes[1].league, true);
  assert.equal(M.heroes[1].proving.text, 'PROVING 12 of 100');
  assert.equal(M.heroes[1].sub, 'SIM · league seat (Sim only)');
  const bad = AC.boardRows({ agents: [], groups: GROUPS, standDowns: { type: 'agentStandDowns', list: [], error: 'agent-standdowns.txt has a line ChartBridge does not understand: ...' } });
  assert.match(bad.sdError, /^agent-standdowns\.txt has a line/);
  assert.equal(AC.sdWhen(null), '');
});

test('Clear stand-down: the message, one click, never from the agent', () => {
  assert.deepEqual(AC.standDownClearMsg('sample-build-1', 'g1'), { type: 'agentStandDownClear', build: 'sample-build-1', group: 'g1' });
  assert.equal(AC.standDownClearMsg('', 'g1'), null);
  assert.equal(AC.standDownClearMsg('sample-build-1', 'Group A'), null);
  const page = read('live/agent.js');
  assert.match(page, /case 'agentStandDowns': S\.standDowns = m; renderBoard\(\); return;/);
  assert.match(page, /else if \(k === 'bSdClear'\) \{ const m = AC\.standDownClearMsg\(act\.dataset\.build, act\.dataset\.gid\); if \(m && sendAgent\(m, 'sdClear'\)\)/, 'one click, through the signed-in send (cid, gate 7 at ChartBridge)');
  assert.match(page, /data-act="bSdClear"/);
  assert.ok(!/confirm\(/.test(page), 'never a browser confirm()');
});

test('the fake bridge\'s keys are ChartBridge 0.6.2\'s', () => {
  const cs = read('nt8/ChartBridgeAgents.cs'), fake = read('test/fake-v3.mjs');
  assert.match(cs, /\{ "agentStandDownClear", new\[\] \{ "type", "cid", "build", "group" \} \}/);
  assert.match(fake, /agentStandDownClear: \['type', 'cid', 'build', 'group'\]/);
  assert.match(cs, /\{ "agentAccount", new\[\] \{ "type", "cid", "agent", "account", "group", "keepMode", "league" \} \}/);
  assert.match(fake, /agentAccount: \['type', 'cid', 'agent', 'account', 'group', 'keepMode', 'league'\]/);
  assert.match(cs, /\{ "standDown", new\[\] \{ "type", "group", "kind", "why" \} \}/, 'the agent channel: raise only');
});
