'use strict';
// Chart 1.49.0: Legion's trader desk (live/legion-desk.js): the Agent and Bot desks behind Praetorian's gate turned round
// (AgentCore.legionLink, live/agent-core.js). The same tests and breaks as Praetorian's gate (test/praetorian.test.js).
// Made-up traders and accounts only: MINE-1 personal, PROP-1 and PROP-2 prop, SIM-A Sim, LIVE-X a live account not told.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AC = require('../live/agent-core.js');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const accounts = o => Object.assign({ type: 'accounts', personalNamed: true, list: [
  { name: 'SIM-A', sim: true, tradable: true }, { name: 'LIVE-X', tradable: true }, { name: 'PROP-1', prop: true, tradable: true }, { name: 'PROP-2', prop: true, tradable: true },
  { name: 'MINE-1', personal: true, tradable: true }] }, o || {});
const groups = { type: 'groups', list: [{ id: 'g1', name: 'Evals', members: ['PROP-1', 'PROP-2'] }, { id: 'g2', name: 'Prop and Sim', members: ['PROP-1', 'SIM-A'] },
  { id: 'g3', name: 'Mixed', members: ['PROP-1', 'MINE-1'] }, { id: 'g4', name: 'Sims', members: ['SIM-A'] }, { id: 'g5', name: 'Empty', members: [] }, { id: 'g6', name: 'Unknown', members: ['LIVE-X'] }] };
const agent = o => Object.assign({ type: 'agent', agent: 'demo', name: 'Demo Agent', mode: 'shadow', enabled: true, connected: true, account: 'PROP-1' }, o || {});
const gateWith = (...msgs) => { const g = AC.legionGate(); for (const m of msgs) g.hear(m); return g; };
const AGENT_MSGS = id => [
  { type: 'agentMode', agent: id, mode: 'auto' }, { type: 'agentMode', agent: id, mode: 'copilot' }, { type: 'agentKill', agent: id, on: false },
  { type: 'agentRules', agent: id, maxTrades: 2 }, { type: 'agentAnswer', agent: id, id: 'p1', answer: 'accept' }, { type: 'agentAccount', agent: id, account: null, keepMode: 'shadow' }];
const BOT_MSGS = [{ type: 'botMode', mode: 'auto' }, { type: 'botKill', on: false }, { type: 'botRails', maxTrades: 1 }, { type: 'botAnswer', id: 'p1', answer: 'accept' }, { type: 'botAccount', account: null }];

test('a trader on a prop account, a prop group (or prop and Sim) or None: everything the Agent desk sends goes', () => {
  for (const a of [agent(), agent({ account: null, group: { id: 'g1', name: 'Evals' }, seats: [{ account: 'PROP-1' }, { account: 'PROP-2' }] }),
    agent({ account: null, group: { id: 'g2', name: 'Prop and Sim' }, seats: [{ account: 'PROP-1' }, { account: 'SIM-A' }] }), agent({ account: null })]) {
    const g = gateWith(accounts(), groups, a);
    for (const m of AGENT_MSGS('demo')) assert.equal(g.check(m), '', JSON.stringify(a.group || a.account) + ' ' + m.type);
    assert.equal(g.check({ type: 'agentAccount', agent: 'demo', account: 'PROP-2', keepMode: 'shadow' }), '');
    assert.equal(g.check({ type: 'agentAccount', agent: 'demo', group: 'g1', keepMode: 'shadow' }), '', 'a lane\'s trader gets its group here');
    assert.equal(g.check({ type: 'agentAccount', agent: 'demo', group: 'g2', keepMode: 'shadow' }), '');
  }
});

test('the targets: a prop account, a prop group or None; never personal, Sim alone, a league seat, a mixed or unknown group', () => {
  const g = gateWith(accounts(), groups, agent({ account: null }));
  assert.match(g.check({ type: 'agentAccount', agent: 'demo', account: 'MINE-1', keepMode: 'shadow' }), /MINE-1 is not a prop account: it is set up from Praetorian/);
  assert.match(g.check({ type: 'agentAccount', agent: 'demo', account: 'SIM-A', keepMode: 'shadow' }), /SIM-A is not a prop account/);
  assert.match(g.check({ type: 'agentAccount', agent: 'demo', account: 'LIVE-X', keepMode: 'shadow' }), /LIVE-X is not a prop account/);
  assert.match(g.check({ type: 'agentAccount', agent: 'demo', account: 'SIM-A', league: true, keepMode: 'shadow' }), /a league seat is a Sim account/);
  assert.match(g.check({ type: 'agentAccount', agent: 'demo', group: 'g3', keepMode: 'shadow' }), /group Mixed holds your personal account/);
  assert.match(g.check({ type: 'agentAccount', agent: 'demo', group: 'g4', keepMode: 'shadow' }), /group Sims is Sim accounts only/);
  assert.match(g.check({ type: 'agentAccount', agent: 'demo', group: 'g5', keepMode: 'shadow' }), /group Empty has no accounts/);
  assert.match(g.check({ type: 'agentAccount', agent: 'demo', group: 'g6', keepMode: 'shadow' }), /group Unknown holds an account the page cannot tell/);
  assert.match(g.check({ type: 'agentAccount', agent: 'demo', group: 'nope', keepMode: 'shadow' }), /there is no group nope/);
  for (const m of [{}, { account: '' }, { account: undefined }, { account: 0 }, { group: '' }, { group: null }, { league: false, account: 'PROP-1' }])
    assert.notEqual(g.check(Object.assign({ type: 'agentAccount', agent: 'demo', keepMode: 'shadow' }, m)), '', 'agentAccount ' + JSON.stringify(m));
});

test('a trader on your personal account, Sim, a mixed group, a league seat or an unknown account: only the stops get through', () => {
  const cases = [
    [agent({ account: 'MINE-1' }), /trades your personal account: it is set up from Praetorian/],
    [agent({ account: 'SIM-A' }), /trades a Sim account/],
    [agent({ account: 'LIVE-X' }), /trades an account the page cannot tell/],
    [agent({ account: 'SIM-A', league: true }), /league seat/],
    [agent({ account: null, group: { id: 'g3', name: 'Mixed' }, seats: [{ account: 'PROP-1' }, { account: 'MINE-1' }] }), /trades your personal account/],
    [agent({ account: null, group: { id: 'g4', name: 'Sims' }, seats: [{ account: 'SIM-A' }] }), /trades a Sim account/],
  ];
  for (const [a, rx] of cases) {
    const g = gateWith(accounts(), groups, a);
    for (const m of AGENT_MSGS('demo')) { const why = g.check(m); assert.match(why, /^Not sent from Legion: /, m.type); assert.match(why, rx, m.type); }
    assert.equal(g.check({ type: 'agentKill', agent: 'demo', on: true }), '', 'kill switch ON: a stop');
    assert.equal(g.check({ type: 'agentMode', agent: 'demo', mode: 'shadow' }), '', 'Shadow: a stop');
    assert.equal(g.check({ type: 'agentSeen', agent: 'demo', id: 'p1' }), '');
  }
});

test('the page cannot tell: no pick, no accounts message, an undescribed trader, other types, the exact values', () => {
  const noPick = gateWith(accounts({ personalNamed: false }), groups, agent());
  assert.match(noPick.check({ type: 'agentMode', agent: 'demo', mode: 'auto' }), /no personal account is picked yet, so no account is prop/);
  assert.match(gateWith(groups, agent()).check({ type: 'agentMode', agent: 'demo', mode: 'auto' }), /has not listed its accounts yet/);
  const g = gateWith(accounts(), groups, agent());
  assert.match(g.check({ type: 'agentMode', agent: 'other', mode: 'auto' }), /has not described trader other yet/);
  assert.match(g.check({ type: 'agentMode', agent: 'other', mode: 'shadow' }), /has not described trader other yet/, 'Shadow only for a described trader');
  for (const t of ['accountGroup', 'memberBench', 'groupSave', 'groupDelete', 'agentKillAllProp', 'agentPick', 'order', 'flatten', 'cancel', 'accountPersonal', 'orderSeen', 'Seen'])
    assert.match(g.check({ type: t, agent: 'demo' }), new RegExp('it does not send ' + t), t);
  for (const on of [1, 'yes', 'true', {}, [true]]) {
    const p = gateWith(accounts(), groups, agent({ account: 'MINE-1' }), { type: 'bot', account: 'MINE-1' });
    assert.notEqual(p.check({ type: 'agentKill', agent: 'demo', on }), '', 'agentKill on ' + JSON.stringify(on));
    assert.notEqual(p.check({ type: 'botKill', on }), '', 'botKill on ' + JSON.stringify(on));
  }
  for (const mode of ['Shadow', 'SHADOW', ' shadow', 'auto']) assert.notEqual(gateWith(accounts(), groups, agent({ account: 'MINE-1' })).check({ type: 'agentMode', agent: 'demo', mode }), '', mode);
  assert.equal(g.check(null), 'Not a message.');
});

test('a group\'s Clear stand-down: only for a prop group; Praetorian never sends it', () => {
  const g = gateWith(accounts(), groups, agent());
  assert.equal(g.check({ type: 'agentStandDownClear', build: 'sample-build-2', group: 'g1' }), '');
  assert.match(g.check({ type: 'agentStandDownClear', build: 'sample-build-2', group: 'g3' }), /holds your personal account/);
  assert.match(g.check({ type: 'agentStandDownClear', build: 'sample-build-2', group: 'g4' }), /Sim accounts only/);
  assert.notEqual(g.check({ type: 'agentStandDownClear', build: 'sample-build-2' }), '');
  const p = AC.praetorianGate(); p.hear(accounts()); p.hear(agent({ account: 'MINE-1' }));
  assert.match(p.check({ type: 'agentStandDownClear', build: 'sample-build-2', group: 'g1' }), /it does not send agentStandDownClear/);
});

test('the bot: on a prop account or None, every bot message; elsewhere only its kill switch ON', () => {
  for (const acct of ['PROP-1', null]) {
    const g = gateWith(accounts(), { type: 'bot', account: acct, mode: 'shadow' });
    for (const m of BOT_MSGS) assert.equal(g.check(m), '', acct + ' ' + m.type);
    assert.equal(g.check({ type: 'botAccount', account: 'PROP-2' }), '');
    for (const t of ['MINE-1', 'SIM-A', 'LIVE-X']) assert.match(g.check({ type: 'botAccount', account: t }), /is not a prop account/);
  }
  for (const acct of ['MINE-1', 'SIM-A', 'LIVE-X']) {
    const g = gateWith(accounts(), { type: 'bot', account: acct, mode: 'auto' });
    for (const m of BOT_MSGS) assert.match(g.check(m), /^Not sent from Legion: The bot is on /, acct + ' ' + m.type);
    assert.equal(g.check({ type: 'botKill', on: true }), '');
    assert.equal(g.check({ type: 'botMode', mode: 'shadow' }), '', 'the bot\'s Shadow: a stop on both desks (03:30)');
    for (const mode of ['Shadow', ' shadow', 'copilot']) assert.notEqual(g.check({ type: 'botMode', mode }), '', mode);
  }
});

test('Legion\'s gate and Praetorian\'s never both pass the same non-stop message (except for a trader on None)', () => {
  const traders = [agent({ agent: 'p', account: 'PROP-1' }), agent({ agent: 'm', account: 'MINE-1' }), agent({ agent: 's', account: 'SIM-A' }), agent({ agent: 'x', account: 'LIVE-X' }),
    agent({ agent: 'g', account: null, group: { id: 'g1', name: 'Evals' }, seats: [{ account: 'PROP-1' }, { account: 'PROP-2' }] })];
  const L = gateWith(accounts(), groups, ...traders), P = AC.praetorianGate();
  for (const x of [accounts(), groups, ...traders]) P.hear(x);
  for (const tr of traders) for (const m of AGENT_MSGS(tr.agent).filter(x => x.type !== 'agentAccount')) assert.ok(!(L.check(m) === '' && P.check(m) === ''), tr.agent + ' ' + m.type + ': not both');
  for (const acct of ['MINE-1', 'SIM-A', 'PROP-1', 'PROP-2', 'LIVE-X']) {
    const m = { type: 'agentAccount', agent: 'p', account: acct, keepMode: 'shadow' };
    const L2 = gateWith(accounts(), groups, agent({ agent: 'p', account: null })), P2 = AC.praetorianGate(); P2.hear(accounts()); P2.hear(agent({ agent: 'p', account: null }));
    assert.ok(!(L2.check(m) === '' && P2.check(m) === ''), acct + ': one side only');
  }
});

test('the connection drops: everything heard is forgotten; the link has no send, is frozen, and the gate hears first', () => {
  const posted = [], subs = [];
  const AF = { listen: p => { subs.push(p); return () => {}; }, post: x => { posted.push(x); return true; }, send: x => posted.push(x), sendOrder: x => posted.push(x) };
  const link = AC.legionLink(AF);
  assert.deepStrictEqual(Object.keys(link).sort(), ['accountOk', 'botWhy', 'groupOk', 'groups', 'limit', 'listen', 'name', 'named', 'notHere', 'post', 'traderWhy', 'why']);
  assert.ok(Object.isFrozen(link)); assert.equal(link.name, 'Legion'); assert.equal(link.groups, true); assert.equal(link.personal, undefined, 'not Praetorian');
  assert.equal(subs.length, 1);
  for (const x of [accounts(), groups, agent(), { type: 'bot', account: 'PROP-1' }]) subs[0].message(x);
  assert.equal(link.post({ type: 'agentMode', agent: 'demo', mode: 'auto' }), true);
  assert.equal(link.groupOk('g1'), true); assert.equal(link.groupOk('g3'), false);
  subs[0].closed();
  assert.equal(link.post({ type: 'agentMode', agent: 'demo', mode: 'auto' }), false);
  assert.equal(link.post({ type: 'botKill', on: true }), true);
  assert.deepEqual(posted.map(x => x.type), ['agentMode', 'botKill']);
  assert.strictEqual(AC.legionLink(null), null);
});

test('the pickers on Legion: groups that pass its gate offered, a personal or Sim account listed as not on Legion', () => {
  const list = AC.pickerChoices(accounts(), groups, agent({ account: null }), { agents: [] });
  const out = AC.prChoices(list, n => AC.lgAccountOk(n, accounts()), { name: 'Legion', groupOk: id => AC.lgGroupWhy(id, groups, accounts()) === '', notHere: 'set up from Praetorian' });
  const by = v => out.find(c => c.value === v);
  assert.equal(by('group:g1').ok, list.find(c => c.value === 'group:g1').ok, 'a prop group as the desk had it');
  assert.equal(by('group:g3').ok, false); assert.match(by('group:g3').text, /not on Legion/);
  assert.equal(by('MINE-1').ok, false); assert.match(by('MINE-1').text, /not on Legion: set up from Praetorian/);
  assert.equal(by('SIM-A').ok, false);
  assert.equal(by('PROP-1').ok, list.find(c => c.value === 'PROP-1').ok);
  for (const c of out) if (c.ok) assert.ok(list.find(x => x.value === c.value).ok, 'never offers what the desk did not');
  /* Praetorian's picker is unchanged by the options */
  assert.deepEqual(AC.prChoices(list, n => n === 'MINE-1' || n === 'SIM-A').map(c => c.ok), AC.prChoices(list, n => n === 'MINE-1' || n === 'SIM-A', undefined).map(c => c.ok));
});

test('the desk file: both desks reused with keys off, the bot card kept inside, the Legion link and never the feed', () => {
  const src = read('live/legion-desk.js');
  assert.match(src, /const link = AC && typeof AC\.legionLink === 'function' && o\.v3 \? AC\.legionLink\(o\.v3, o\.onHear\) : null;/);
  assert.match(src, /const common = \{ popout: true, keys: false, v3: link,/);
  assert.match(src, /window\.BotDesk\.create\(Object\.assign\(\{\}, common, \{ floating: false,/);
  assert.doesNotMatch(src, /v3: o\.v3|\.post\(|\.send\(|sendOrder|agentKillAllProp/, 'no direct send of any kind');
  const ag = read('live/agent.js'), bt = read('live/bot.js');
  assert.match(ag, /const unroute = o\.keys === false \? \(\) => \{\} : ROUTER\.add\('agents'/);
  assert.match(bt, /const unroute = ROUTER && o\.keys !== false \? ROUTER\.add\('bot'/);
  assert.match(bt, /if \(!ROUTER && o\.keys !== false\) document\.addEventListener\('chart-copilot-key', onCopilotKey\);/);
  assert.match(bt, /if \(o\.floating !== false\) document\.body\.appendChild\(d\); return d; \}\)\(\);/, 'floating false: never on the page\'s body');
  assert.match(bt, /if \(o\.floating === false && view && propBox\.parentElement !== view\) view\.appendChild\(propBox\);/, 'placed in the desk\'s own view, after it is drawn');
  for (const f of ['live/legion-desk.js', 'test/legion-desk.test.js']) assert.ok(!/[\u2013\u2014]/.test(read(f)), f + ': no en or em dash');
});

test('deliberate breaks of Legion\'s gate a test missed at first: the pick, an empty group key with None, a drop', () => {
  /* a row flagged prop is prop only when a personal account is picked (ChartBridge 0.6.16 says both) */
  const noPick = gateWith(accounts({ personalNamed: false }), groups, { type: 'bot', account: null });
  assert.notEqual(noPick.check({ type: 'botAccount', account: 'PROP-1' }), '', 'no pick: PROP-1 is not prop yet');
  assert.equal(AC.lgAccountOk('PROP-1', accounts({ personalNamed: undefined })), false);
  /* a group key, even null or empty, is a group, never None */
  const g = gateWith(accounts(), groups, agent({ account: null }));
  for (const grp of [null, '', 0, false]) assert.notEqual(g.check({ type: 'agentAccount', agent: 'demo', group: grp, account: null, keepMode: 'shadow' }), '', 'group ' + JSON.stringify(grp) + ' with account null');
  /* a drop forgets the groups too: accounts heard again before the groups do not bring the old groups back */
  const d = gateWith(accounts(), groups, agent());
  assert.equal(d.groupOk('g1'), true);
  d.lost(); d.hear(accounts());
  assert.equal(d.groupOk('g1'), false, 'no groups heard since the drop');
  assert.deepEqual(d.state(), { agents: 0, bot: false, accounts: true, groups: false, personalNamed: true });
});
