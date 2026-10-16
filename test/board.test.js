'use strict';
// Chart 1.28.0 (ChartBridge 0.6.1, SPEC CE-1, DECISION 2026-10-15k): a group's Type and default hero (Settings, the Agent tab's
// picker) and the Agent tab's heroes-on-duty board. The pure parts: AgentHelper's tiers, fit, preselect and Assign hero,
// AgentCore.boardRows, GroupsCore's groupSave shapes, the fake bridge's groupSave and agentAccount {group}, and the page's
// wiring (Kill all through the existing agentKill per agent; Assign hero through agentAccount {group} and the helper's POST /on).
// Made-up agents (demo, demotwo, demothree), accounts (Sim101, SIM-A, SIM-B, SIM-C), builds and money: sample data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AH = require('../live/agent-helper.js');
const AC = require('../live/agent-core.js');
const GC = require('../live/groups.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

/* the PC helper's GET /status: rows with a tier and rows without (the Bot-Lab side that fills them comes later) */
const STATUS = {
  agents: { demo: { on: true, running: true, runningBuild: 'sample-a', build: 'sample-a', hero: 'Sample Hero A' }, demotwo: { on: true, running: true, runningBuild: 'sample-b', hero: 'Sample Hero B' },
    demothree: { on: false, running: false, build: 'sample-c', hero: null } },
  builds: [
    { build: 'sample-a', hero: 'Sample Hero A', tier: 'Good', edge: 0.1, examEdge: 0.12, liveEdge: 0.08, liveN: 40, standingAt: '2026-10-15', standingNote: 'sample standing' },
    { build: 'sample-b', hero: 'Sample Hero B', tier: 'acceptable', edge: 0.05 },
    { build: 'sample-c', hero: 'Sample Hero C' },                 // no tier: "tier unknown"
    { build: 'sample-d', hero: 'Sample Hero D', tier: 'Not ready' },
    { build: 'sample-e', hero: null, shadowOk: true, tier: 'Great' },   // not a hero
  ],
};

test('tiers: the chip, every tier against every Type (shown only), tier unknown with why', () => {
  assert.deepEqual(AH.tierChip(STATUS.builds[0], 'ok'), { text: 'Good +0.10R', tone: 'top', title: 'Good, edge +0.10R: exam edge +0.12R; live edge +0.08R over 40 trades; standing of 2026-10-15; sample standing' });
  assert.equal(AH.tierChip(STATUS.builds[1]).text, 'Acceptable +0.05R');
  assert.equal(AH.tierChip(STATUS.builds[1]).tone, 'ok');
  assert.equal(AH.tierChip(STATUS.builds[3]).tone, 'no');
  assert.deepEqual(AH.tierChip(STATUS.builds[2], 'ok'), { text: 'tier unknown', tone: 'unknown', title: 'Tier unknown (no rating on this PC yet)' });
  assert.equal(AH.tierChip(null, 'down').title, 'Tier unknown (the PC helper is not answering)');
  assert.equal(AH.tierChip({ build: 'x', tier: 'Legendary' }, 'ok').text, 'tier unknown', 'a word that is not a tier: unknown');
  const fit = (t, type) => AH.tierFit(t, type);
  for (const t of ['Good', 'Great', 'Exceptional']) for (const type of ['eval', 'funded']) assert.deepEqual(fit(t, type), { warn: '', note: '' }, t + ' fits ' + type);
  assert.deepEqual(fit('Acceptable', 'eval'), { warn: '', note: 'Acceptable: at most 3 evals at once' });
  assert.deepEqual(fit('Acceptable', 'funded'), { warn: 'Acceptable: evals only; funded only when no Good or better hero is on duty', note: '' });
  for (const type of ['eval', 'funded', '']) assert.equal(fit('Not ready', type).warn, 'Not ready: gym and Sim only', 'Not ready fits nothing (' + (type || 'type not set') + ')');
  assert.deepEqual(fit('', 'eval'), { warn: 'tier unknown', note: '' });
  assert.deepEqual(fit('Acceptable', ''), { warn: '', note: 'type not set' }, 'no Type: no fit warning, "type not set"');
  assert.deepEqual(fit('', null), { warn: '', note: 'type not set' });
});

test('Settings: every hero listed for every group, with its fit warning; a build that is not a hero is never offered', () => {
  const funded = AH.heroOptions(STATUS, 'funded', 'ok');
  assert.deepEqual(funded.map(o => o.build), ['sample-a', 'sample-b', 'sample-c', 'sample-d'], 'no filter by tier');
  assert.equal(funded[0].label, 'Sample Hero A (sample-a) · Good +0.10R');
  assert.equal(funded[1].label, 'Sample Hero B (sample-b) · Acceptable +0.05R · Acceptable: evals only; funded only when no Good or better hero is on duty');
  assert.equal(funded[2].label, 'Sample Hero C (sample-c) · tier unknown');
  assert.equal(funded[3].fit.warn, 'Not ready: gym and Sim only');
  assert.equal(AH.heroOptions(STATUS, 'eval', 'ok')[1].fit.note, 'Acceptable: at most 3 evals at once');
  assert.deepEqual(AH.heroOptions(STATUS, '', 'ok').map(o => o.fit.warn), ['', '', '', 'Not ready: gym and Sim only']);
  assert.deepEqual(AH.heroOptions(null, 'eval', 'down'), [], 'the helper not answering: none listed (Settings keeps the saved one)');
});

test('the Agent tab picker: on a group every hero is listed with its warning, and the default hero is preselected', () => {
  const one = AH.pickerRows(STATUS, 'auto', true);
  assert.deepEqual(one.map(r => r.label), ['Sample Hero A (sample-a)', 'Sample Hero B (sample-b)', 'Sample Hero C (sample-c)', 'Sample Hero D (sample-d)'], 'one account: the labels as 1.27.0');
  const grp = AH.pickerRows(STATUS, 'auto', true, { accountType: 'funded' });
  assert.equal(grp.length, 4, 'no hero is filtered out');
  assert.equal(grp[1].label, 'Sample Hero B (sample-b), Acceptable: evals only; funded only when no Good or better hero is on duty');
  assert.equal(grp[1].warn, 'Acceptable: evals only; funded only when no Good or better hero is on duty');
  assert.equal(grp[0].warn, '');
  assert.match(grp[0].title, /Good, edge \+0\.10R/);
  assert.equal(AH.pickerRows(STATUS, 'shadow', true, { accountType: '' }).length, 5, 'Shadow on Sim: the builds over the bar too, as before');
  // preselect: picked here, else running, else the group's default hero, else the last build, else the first
  const rows = AH.pickerRows(STATUS, 'auto', true, { accountType: 'eval' });
  assert.equal(AH.preselect(rows, '', { build: 'sample-a' }, 'sample-c'), 'sample-c', 'the group\'s default hero over the last build');
  assert.equal(AH.preselect(rows, 'sample-d', null, 'sample-c'), 'sample-d', 'he picked another: kept');
  assert.equal(AH.preselect(rows, '', { runningBuild: 'sample-b' }, 'sample-c'), 'sample-b', 'he runs one: that one');
  assert.equal(AH.preselect(rows, '', { build: 'sample-a' }, 'not-here'), 'sample-a', 'a default hero the helper does not offer: the last build');
  assert.equal(AH.preselect(rows, '', null, ''), 'sample-a');
  assert.equal(AH.preselect([], 'x', null, 'y'), '');
});

/* the agents, groups and accounts as ChartBridge sends them (made-up) */
const groups = { type: 'groups', list: [
  { id: 'g1', name: 'Group A', members: ['SIM-A', 'SIM-B'], dailyLoss: 1000, accountType: 'funded', hero: 'sample-b' },
  { id: 'g2', name: 'Group B', members: ['SIM-C'], dailyLoss: null, accountType: null, hero: 'sample-c' },
  { id: 'g3', name: 'Group C', members: [], accountType: 'eval', hero: null }] };
const accounts = { type: 'accounts', list: [
  { name: 'SIM-A', sim: true, tradable: true, roomDaily: 800, roomFloor: 1500 }, { name: 'SIM-B', sim: true, tradable: true, roomDaily: 600, roomFloor: 2100 },
  { name: 'SIM-C', sim: true, tradable: true, roomDaily: null, roomFloor: null, why: { roomDaily: 'group Group B has no daily loss limit' } },
  { name: 'Sim101', sim: true, tradable: true, roomDaily: null, roomFloor: null, why: { roomDaily: 'no group and no daily limit of its own (the Accounts tab)' } }] };
const agentsNow = () => [
  { agent: 'demo', name: 'Sample Hero B', build: 'sample-b x', connected: true, mode: 'auto', account: null, sim: true, group: { id: 'g1', name: 'Group A' },
    seats: [{ account: 'SIM-A', position: { root: 'MNQ', qty: 3 } }, { account: 'SIM-B', position: { root: 'MNQ', qty: 2 } }] },
  { agent: 'demotwo', name: 'Sample Hero A', build: 'sample-a x', connected: true, mode: 'shadow', account: 'Sim101', sim: true, position: { root: 'MNQ', qty: -1 }, killed: true },
  { agent: 'demothree', name: '', build: '', connected: false, mode: 'shadow', account: null, sim: false },
];

test('the board: a group hero row, a single account row, a slot on None and Off left out, a NO HERO row per free group', () => {
  const st = JSON.parse(JSON.stringify(STATUS));
  st.agents.demo.runningBuild = 'sample-b'; st.agents.demo.hero = 'Sample Hero B'; st.agents.demotwo.runningBuild = 'sample-a'; st.agents.demotwo.hero = 'Sample Hero A';
  const M = AC.boardRows({ agents: agentsNow(), groups, accounts, status: st, reach: 'ok', rOf: a => (a.agent === 'demo' ? 1.4 : null), AH });
  assert.deepEqual(M.heroes.map(r => r.agent), ['demo', 'demotwo'], 'demothree is on None and Off: no row');
  const g = M.heroes[0];
  assert.equal(g.kind, 'group'); assert.equal(g.where, 'Group A'); assert.equal(g.sub, 'leads 2 accounts: SIM-A, SIM-B · Funded');
  assert.equal(g.name, 'Sample Hero B'); assert.equal(g.build, 'sample-b');
  assert.equal(g.chip.text, 'Acceptable +0.05R');
  assert.equal(g.fit.warn, 'Acceptable: evals only; funded only when no Good or better hero is on duty', 'the fit for the group\'s Type, shown');
  assert.equal(g.position, 'LONG 5 MNQ', 'a group: summed over its seats'); assert.equal(g.posTone, 'pos');
  assert.equal(g.rText, '+1.40 R'); assert.equal(g.modeName, 'Auto');
  assert.deepEqual([g.room.pct, g.room.daily, g.room.limit, g.room.floor], [60, 600, 1000, 1500], 'the tightest seat: daily 600 of 1,000 (SIM-B), floor 1,500 (SIM-A)');
  assert.equal(g.room.text, 'daily room $600.00 of $1,000.00 (SIM-B), floor $1,500.00 away (SIM-A)');
  const s = M.heroes[1];
  assert.equal(s.kind, 'account'); assert.equal(s.where, 'Sim101'); assert.equal(s.sub, 'SIM · one account');
  assert.equal(s.chip.text, 'Good +0.10R'); assert.deepEqual(s.fit, { warn: '', note: '' }, 'one account: no group Type, no fit line');
  assert.equal(s.position, 'SHORT 1 MNQ'); assert.equal(s.rText, 'not reported'); assert.equal(s.killed, true);
  assert.equal(s.room.text, 'room not reported: no group and no daily limit of its own (the Accounts tab)');
  assert.deepEqual(M.noHero, [{ id: 'g2', name: 'Group B', members: ['SIM-C'], accountType: null, hero: 'sample-c', heroName: 'Sample Hero C' },
    { id: 'g3', name: 'Group C', members: [], accountType: 'eval', hero: null, heroName: '' }]);
  // a slot on None that is on (the helper says so) has a row: None, nothing trades
  const on3 = JSON.parse(JSON.stringify(st)); on3.agents.demothree.on = true;
  const M3 = AC.boardRows({ agents: agentsNow(), groups, accounts, status: on3, reach: 'ok', AH });
  const h3 = M3.heroes.find(r => r.agent === 'demothree');
  assert.equal(h3.where, 'None'); assert.equal(h3.room.text, 'None: nothing trades'); assert.equal(h3.chip.text, 'tier unknown');
});

test('the board: helper rows without a tier, and the helper not answering', () => {
  const bare = { agents: STATUS.agents, builds: STATUS.builds.map(r => ({ build: r.build, hero: r.hero, shadowOk: r.shadowOk })) };
  const M = AC.boardRows({ agents: agentsNow(), groups, accounts, status: bare, reach: 'ok', AH });
  assert.deepEqual(M.heroes.map(r => [r.chip.text, r.chip.title]), [['tier unknown', 'Tier unknown (no rating on this PC yet)'], ['tier unknown', 'Tier unknown (no rating on this PC yet)']]);
  assert.equal(M.heroes[0].fit.warn, 'tier unknown', 'a group with a Type and no tier: the warning says so');
  const D = AC.boardRows({ agents: agentsNow(), groups, accounts, status: null, reach: 'down', AH });
  assert.deepEqual(D.heroes.map(r => r.agent), ['demo', 'demotwo'], 'no helper: the agents ChartBridge says are connected or on an account');
  assert.equal(D.heroes[0].chip.title, 'Tier unknown (the PC helper is not answering)');
  assert.equal(D.heroes[0].name, 'Sample Hero B', 'his hello\'s name');
  assert.equal(D.heroes[0].build, 'sample-b', 'the build from his hello');
  assert.deepEqual(AC.boardRows({}), { heroes: [], noHero: [] });
});

test('Assign hero: a free slot (None and Off), the default hero, a pick when there is none, no free slot', () => {
  const rows = AH.pickerRows(STATUS, 'shadow', true, { accountType: '' }).filter(r => r.hero);
  assert.deepEqual(AH.freeSlot(agentsNow(), STATUS, 'ok'), { agent: 'demothree' });
  assert.deepEqual(AH.assignStart(groups.list[1], agentsNow(), STATUS, 'ok', rows), { agent: 'demothree', build: 'sample-c', need: '' }, 'Group B: its default hero');
  assert.deepEqual(AH.assignStart(Object.assign({}, groups.list[1], { hero: null }), agentsNow(), STATUS, 'ok', rows), { agent: 'demothree', build: '', need: 'pick' }, 'no default hero: he picks a build');
  assert.deepEqual(AH.assignStart(Object.assign({}, groups.list[1], { hero: 'not-on-this-pc' }), agentsNow(), STATUS, 'ok', rows).need, 'pick', 'a default hero the helper does not have: he picks');
  assert.match(AH.assignStart(groups.list[2], agentsNow(), STATUS, 'ok', rows).error, /has no accounts/);
  const busy = JSON.parse(JSON.stringify(STATUS)); busy.agents.demothree.on = true;
  assert.equal(AH.assignStart(groups.list[1], agentsNow(), busy, 'ok', rows).error, 'No free agent (an agent id on None and Off): add an agent id to config.txt (agents = ...); ChartBridge never writes config.txt.');
  const onAcc = agentsNow(); onAcc[2].account = 'SIM-C';
  assert.match(AH.freeSlot(onAcc, STATUS, 'ok').error, /add an agent id to config\.txt/, 'an agent on an account is not free');
  assert.match(AH.freeSlot(agentsNow(), null, 'down').error, /not answering/);
  // the job: wait for ChartBridge to put him on the group, then On; give up after 10 s
  const job = { agent: 'demothree', group: 'g2', groupName: 'Group B', build: 'sample-c', until: 10000 };
  assert.equal(AH.assignStep(job, agentsNow()[2], 5000).action, '');
  assert.equal(AH.assignStep(job, Object.assign(agentsNow()[2], { group: { id: 'g2', name: 'Group B' } }), 6000).action, 'on');
  assert.deepEqual(AH.assignStep(job, agentsNow()[2], 10001), { action: 'giveup', line: 'ChartBridge did not put agent demothree on Group B within 10 s: nothing was started.' });
  // the agentAccount it sends is the existing one, with group and keepMode shadow (every start is Shadow)
  const slot = agentsNow()[2], choices = AC.pickerChoices(accounts, groups, slot, { agents: agentsNow() });
  const r = AC.accountChange(slot, 'group:g2', choices, { askedMode: 'shadow' });
  assert.deepEqual(r.msg, { type: 'agentAccount', agent: 'demothree', group: 'g2', keepMode: 'shadow' });
  assert.equal(r.confirm, '', 'a Sim group: no question');
});

test('the page: Kill all is the existing agentKill per agent; Assign hero is agentAccount {group} then the helper\'s POST /on in Shadow', () => {
  const js = read('live/agent.js');
  assert.match(js, /function killAll\(\) \{[\s\S]*?for \(const a of list\) if \(sendAgent\(AC\.killMsg\(a\.agent, true\), 'kill'\)\) n\+\+;/);
  assert.match(js, /AC\.accountChange\(a, 'group:' \+ gid, choicesFor\(a\), Object\.assign\(ctxNow\(a\), \{ askedMode: 'shadow' \}\)\)/);
  assert.match(js, /await HC\.on\(j\.agent, j\.build, 'shadow', /);
  assert.ok(!/config\.txt'?\)?\s*=/.test(js) && !/writeFile|POST \/config/.test(js), 'the page never writes config.txt');
  const kill = AC.killMsg('demo', true);
  assert.deepEqual(kill, { type: 'agentKill', agent: 'demo', on: true });
  // only messages of the contract leave the board (no new message type)
  const sends = [...js.matchAll(/type: '(agent[A-Za-z]+)'/g)].map(m => m[1]);
  for (const t of sends) assert.ok(['agentMode', 'agentKill', 'agentSeen', 'agentAnswer', 'agentAccount', 'agentRules'].includes(t), t);
});

test('Settings: groupSave carries accountType and hero in the shapes ChartBridge 0.6.1 checks; the switch and Rename keep them', () => {
  const f = { name: 'Group B', size: '50000', dailyLoss: '', drawdown: '2500', drawdownType: 'intraday', lockAt: '', target: '', noHedge: true };
  assert.deepEqual(GC.groupMessage(Object.assign({}, f, { accountType: 'funded', hero: 'sample-b' }), [], null, 'c').msg,
    { type: 'groupSave', cid: 'c', name: 'Group B', noHedge: true, dailyLoss: 0, drawdown: 2500, drawdownType: 'intraday', target: 0, size: 50000, lockAt: 0, consistency: 0, accountType: 'funded', hero: 'sample-b' });
  const none = GC.groupMessage(Object.assign({}, f, { accountType: '', hero: '' }), []).msg;
  assert.equal(none.accountType, '-'); assert.equal(none.hero, '-');
  assert.equal(GC.groupMessage(f, []).msg.accountType, undefined, 'a form without them: absent (ChartBridge keeps the group\'s)');
  assert.equal(GC.groupMessage(Object.assign({}, f, { accountType: 'live' }), []).field, 'accountType');
  for (const h of ['two words', '-x', 'a'.repeat(65), 'a/b']) assert.equal(GC.groupMessage(Object.assign({}, f, { hero: h }), []).field, 'hero', h);
  assert.equal(GC.groupMessage(Object.assign({}, f, { hero: 'b'.repeat(64) }), []).msg.hero, 'b'.repeat(64));
  const g = GC.cleanGroups({ list: [{ id: 'g1', name: 'Group A', accountType: 'eval', hero: 'sample-a', members: [] }, { id: 'g2', name: 'Group B', accountType: 'nope', hero: 'bad name', members: [] }, { id: 'g3', name: 'Old', members: [] }] });
  assert.deepEqual(g.map(x => [x.accountType, x.hero]), [['eval', 'sample-a'], [null, null], [null, null]], 'a 0.6.0 groups message (no fields): not set, none');
  const saved = GC.saveFrom(g[0], { noHedge: false }, 'c2');
  assert.ok(!('accountType' in saved) && !('hero' in saved), 'the No hedging switch and Rename send no Type or hero: ChartBridge keeps them');
  assert.equal(GC.typeText(g[0]), 'Evals'); assert.equal(GC.typeText(g[2]), 'type not set');
  assert.equal(GC.heroText(g[0], b => (b === 'sample-a' ? 'Sample Hero A' : '')), 'hero Sample Hero A');
  assert.equal(GC.heroText(g[0]), 'hero sample-a'); assert.equal(GC.heroText(g[2]), 'no hero');
  assert.ok(read('nt8/ChartBridgeGroups.cs').includes('HeroRx = new Regex("' + GC.HERO_RX.source + '")'), 'the page checks the hero as ChartBridge does');
});

test('the fake bridge: groupSave accountType and hero (absent keeps, - clears, shapes refused); agentAccount {group} seats his members', async () => {
  const { OrderDeskV3 } = await import('./fake-v3.mjs');
  const sent = [], conn = { authed: true, v3: true, origin: 'http://localhost:8765' };
  const desk = new OrderDeskV3({ config: { trading: true, tradeAccounts: ['SIM-A', 'SIM-B'], maxQty: { MNQ: 5 }, allowOrigins: [] }, instruments: { MNQ: { name: 'MNQ 12-26', tick: 0.25, pointValue: 2 } },
    knownAccounts: ['SIM-A', 'SIM-B'], token: 't', send: (c, m) => sent.push(m), conns: () => [conn], barTime: () => 0, now: () => 0,
    accountList: [{ name: 'SIM-A', balance: 50000, sim: true }, { name: 'SIM-B', balance: 50000, sim: true }], ownOrigin: 'http://localhost:8765', agents: ['demo'] });
  desk.origin = () => 'http://localhost:8765';
  const say = m => { const before = sent.length; desk.handle(conn, m, JSON.stringify(m)); return sent.slice(before); };
  const base = { type: 'groupSave', name: 'Group A', noHedge: true, dailyLoss: 1000, drawdown: 2000, drawdownType: 'eod', target: 0, size: 50000, lockAt: 0 };
  let r = say(Object.assign({ cid: 'a' }, base, { accountType: 'funded', hero: 'sample-a' }));
  let g = r.find(m => m.type === 'groups').list[0];
  assert.deepEqual([g.accountType, g.hero], ['funded', 'sample-a']);
  r = say(Object.assign({ cid: 'b', group: 'g1' }, base));
  g = r.find(m => m.type === 'groups').list[0];
  assert.deepEqual([g.accountType, g.hero], ['funded', 'sample-a'], 'absent: kept');
  r = say(Object.assign({ cid: 'c', group: 'g1' }, base, { accountType: '-', hero: '-' }));
  g = r.find(m => m.type === 'groups').list[0];
  assert.deepEqual([g.accountType, g.hero], [null, null], '- clears');
  assert.match(say(Object.assign({ cid: 'd', group: 'g1' }, base, { accountType: 'evals' }))[0].reason, /accountType must be eval, funded or -/);
  assert.match(say(Object.assign({ cid: 'e', group: 'g1' }, base, { hero: 'two words' }))[0].reason, /hero must be a build name/);
  say({ type: 'accountGroup', cid: 'f', account: 'SIM-A', group: 'g1' }); say({ type: 'accountGroup', cid: 'g', account: 'SIM-B', group: 'g1' });
  r = say({ type: 'agentAccount', cid: 'h', agent: 'demo', group: 'g1', keepMode: 'shadow' });
  const a = r.find(m => m.type === 'agent');
  assert.ok(a && a.group.id === 'g1' && a.account === null && a.seats.map(x => x.account).join() === 'SIM-A,SIM-B' && a.mode === 'shadow', JSON.stringify(r));
  assert.match(say({ type: 'agentAccount', cid: 'i', agent: 'demo', group: 'g9' })[0].reason, /no group g9/);
});

/* ======================================================================== fix round 1 */
test('fix round 1: a slot seated on a group but Off says so, offers Start in Shadow, and its group still shows no hero on duty', () => {
  const st = JSON.parse(JSON.stringify(STATUS));
  st.agents.demo = { on: false, running: false, build: null, hero: null };   // the helper refused On, or the wait ran out
  const ag = agentsNow(); ag[0].connected = false; ag[0].build = '';
  const M = AC.boardRows({ agents: ag, groups, accounts, status: st, reach: 'ok', AH });
  const r = M.heroes.find(x => x.agent === 'demo');
  assert.ok(r, 'still a row: it has a group');
  assert.equal(r.on, false);
  assert.equal(r.off, 'Off: not started (nothing trades)');
  assert.equal(r.startBuild, 'sample-b', 'no build of his own: the group\'s default hero');
  assert.equal(r.noHeroOn, true, 'its group keeps the no hero marker while its only agent is Off');
  assert.ok(!M.noHero.some(g => g.id === 'g1'), 'no second NO HERO row (Assign would take another slot)');
  const s = M.heroes.find(x => x.agent === 'demotwo');
  assert.deepEqual([s.off, s.noHeroOn], ['', false], 'an agent that is on: no warning');
  st.agents.demo.build = 'sample-a';
  assert.equal(AC.boardRows({ agents: ag, groups, accounts, status: st, reach: 'ok', AH }).heroes[0].startBuild, 'sample-a', 'his last build first');
  const js = read('live/agent.js');
  assert.match(js, /async function boardStart\(id, build\) \{[\s\S]*?await HC\.on\(id, build, 'shadow', a\.sim === true\);/, 'Start in Shadow is the helper\'s existing POST /on, in Shadow');
  assert.match(js, /set None on his desk to free the slot/);
});

test('fix round 1: a free slot whose kill switch is off first; a killed one only when no other is free (the Kill is never undone)', () => {
  const st = JSON.parse(JSON.stringify(STATUS));
  st.agents.demofour = { on: false, running: false };
  const ag = agentsNow(); ag[2].killed = true;
  ag.push({ agent: 'demofour', connected: false, mode: 'shadow', account: null, killed: false });
  assert.deepEqual(AH.freeSlot(ag, st, 'ok'), { agent: 'demofour' });
  assert.deepEqual(AH.freeSlot(agentsNow().map(a => Object.assign(a, { killed: a.agent === 'demothree' })), STATUS, 'ok'), { agent: 'demothree', killed: true });
  const rows = AH.pickerRows(STATUS, 'shadow', true, {}).filter(r => r.hero);
  assert.equal(AH.assignStart(groups.list[1], agentsNow().map(a => Object.assign(a, { killed: true })), STATUS, 'ok', rows).killed, true);
  const js = read('live/agent.js');
  assert.match(js, /His kill switch is on: nothing trades until you release it on his desk \(two clicks\)\./, 'the success line says so');
  assert.ok(!/killMsg\([^)]*false\)[^\n]*assign/i.test(js), 'Assign never releases a Kill');
});

test('fix round 1: at Continue the free slot is asked again; when it no longer holds nothing is sent', () => {
  const free = agentsNow()[2];
  assert.equal(AH.slotFree(free, STATUS, 'ok'), '');
  assert.equal(AH.slotFree(Object.assign({}, free, { connected: true }), STATUS, 'ok'), 'agent demothree is connected now');
  assert.equal(AH.slotFree(Object.assign({}, free, { account: 'SIM-C' }), STATUS, 'ok'), 'agent demothree is no longer on None');
  assert.equal(AH.slotFree(Object.assign({}, free, { group: { id: 'g2' } }), STATUS, 'ok'), 'agent demothree is no longer on None');
  const on = JSON.parse(JSON.stringify(STATUS)); on.agents.demothree.on = true;
  assert.equal(AH.slotFree(free, on, 'ok'), 'agent demothree is On in the helper now');
  assert.equal(AH.slotFree(free, null, 'down'), 'the PC helper is not answering, so his Off cannot be checked');
  const js = read('live/agent.js');
  assert.match(js, /else if \(k === 'bYes'\) \{ if \(B\.ask\) \{ const x = B\.ask; const ag = agents\.get\(x\.agent\); const why = AH\.slotFree\(ag \|\| \{ agent: x\.agent \}, H\.status, H\.reach\); if \(!ag \|\| why\) \{ B\.ask = null; boardSay\('Nothing was sent: '/);
});

test('fix round 1: the room\'s why comes from the tightest seat, not the first', () => {
  const accs = { list: [
    { name: 'SIM-A', roomDaily: null, roomFloor: 3000, why: { roomDaily: 'the first seat\'s reason' } },
    { name: 'SIM-B', roomDaily: null, roomFloor: 900, why: { roomDaily: 'SIM-B started mid-session' } }] };
  const r = AC.boardRoom(['SIM-A', 'SIM-B'], accs, null);
  assert.equal(r.text, 'daily room not reported (SIM-B started mid-session), floor $900.00 away (SIM-B)');
  const none = AC.boardRoom(['SIM-A', 'SIM-B'], { list: [{ name: 'SIM-A', roomDaily: null, roomFloor: null }, { name: 'SIM-B', roomDaily: null, roomFloor: null, why: { roomFloor: 'SIM-B is not connected' } }] }, null);
  assert.equal(none.text, 'room not reported: SIM-B is not connected', 'nothing known: a seat that says why');
});
