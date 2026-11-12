'use strict';
// Chart 1.52.0: Legion's trader desk (live/legion-desk.js): the Agent and Bot desks behind Praetorian's gate turned round
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
    [agent({ account: 'LIVE-X' }), /no home: the page cannot tell its account; stop it, then fix its account or group/],
    [agent({ account: 'SIM-A', league: true }), /league seat/],
    [agent({ account: null, group: { id: 'g3', name: 'Mixed' }, seats: [{ account: 'PROP-1' }, { account: 'MINE-1' }] }), /no home: its account mixes kinds; stop it, then fix its account or group/],
    [agent({ account: null, group: { id: 'g4', name: 'Sims' }, seats: [{ account: 'SIM-A' }] }), /no home: its group holds only your personal account or Sim accounts, and Praetorian takes no group/],
    [agent({ account: null, group: { id: 'g6', name: 'Unknown' }, seats: [{ account: 'LIVE-X' }] }), /no home: the page cannot tell an account in its group/],
  ];
  for (const [a, rx] of cases) {
    const g = gateWith(accounts(), groups, a);
    for (const m of AGENT_MSGS('demo')) {
      const why = g.check(m); assert.match(why, /^Not sent from Legion: /, m.type);
      if (m.type === 'agentAccount' && m.account === null && /no home/.test(rx.source)) { assert.match(why, /flatten first/, 'None for a trader with no home: only when flat'); continue; }
      assert.match(why, rx, m.type);
    }
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
  assert.deepStrictEqual(Object.keys(link).sort(), ['accountOk', 'botWhy', 'close', 'groupOk', 'groups', 'limit', 'listen', 'name', 'named', 'noHome', 'notHere', 'post', 'traderWhy', 'why']);
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
  assert.match(src, /const common = \{ embedded: true, keyPrefix: KEY_PREFIX, keys: false, v3: link,/, 'embedded, never popout (popout means "always shown")');
  assert.doesNotMatch(src, /popout/, 'never a pop-out copy');
  assert.match(src, /const KEY_PREFIX = 'legion-';/);
  assert.match(src, /if \(link && typeof link\.close === 'function'\) link\.close\(\);/, 'destroy takes the gate off the feed');
  assert.match(src, /agent\.showTab\(open && current === 'agent'\)/); assert.match(src, /bot\.showTab\(open && current === 'bot'\)/);
  assert.match(src, /let current = SIDES\.includes\(o\.side\) \? o\.side : 'agent', open = o\.shown === true;/, 'closed unless told');
  assert.match(src, /window\.BotDesk\.create\(Object\.assign\(\{\}, common, \{ floating: false,/);
  assert.doesNotMatch(src, /v3: o\.v3|\.post\(|\.send\(|sendOrder|agentKillAllProp/, 'no direct send of any kind');
  const ag = read('live/agent.js'), bt = read('live/bot.js');
  assert.match(ag, /const unroute = o\.keys === false \? \(\) => \{\} : ROUTER\.add\('agents'/);
  assert.match(bt, /const unroute = ROUTER && o\.keys !== false \? ROUTER\.add\('bot'/);
  assert.match(bt, /if \(!ROUTER && o\.keys !== false\) document\.addEventListener\('chart-copilot-key', onCopilotKey\);/);
  assert.match(bt, /if \(o\.floating !== false\) document\.body\.appendChild\(d\); return d; \}\)\(\);/, 'floating false: never on the page\'s body');
  assert.match(bt, /if \(o\.floating === false && view && propBox\.parentElement !== view\) view\.appendChild\(propBox\);/, 'placed in the desk\'s own view, after it is drawn');
  /* the review of 103 (a F-B1, b F3): an embedded copy acknowledges only what is on screen and leaves the page's own things alone */
  assert.match(ag, /const embedded = !popout && !!o\.embedded;/); assert.match(bt, /const embedded = !popout && !!o\.embedded;/);
  assert.match(ag, /if \(embedded && !onScreen\(view\)\) return;/); assert.match(ag, /if \(embedded && \(!onScreen\(x\.inline\) \|\| !inView\(x\.inline\)\)\) continue;/, 'round 2, F3: the agent card in view too');
  for (const src of [ag, bt]) assert.match(src, /el\.checkVisibility\(\{ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true \}\)/, 'round 2, F3: visibility and opacity count');
  assert.match(ag, /paneId: 'agent', storagePrefix: \(o\.storagePrefix \|\| ''\) \+ KP,/, '104-G: the live chart keeps its view under the desk\'s own prefix');
  assert.match(bt, /paneId: 'bot', storagePrefix: \(o\.storagePrefix \|\| ''\) \+ \(embedded && typeof o\.keyPrefix === 'string' \? o\.keyPrefix : ''\),/);
  assert.match(ag, /case 'linkMove':/); assert.match(bt, /case 'linkMove': if \(m\.bot === true/);
  assert.match(bt, /if \(embedded && \(!S\.shown \|\| !onScreen\(x\.el\) \|\| !inView\(x\.el\)\)\) return;/);
  assert.match(ag, /const propBox = embedded \? null : document\.querySelector\('\.bt-props'\);/, 'never hides the page\'s Bot card');
  assert.match(ag, /const cornerLine = view && !popout && !embedded \?/); assert.match(ag, /const alertsEl = popout \|\| embedded \? null :/);
  assert.match(ag, /function placeNotes\(\) \{\s*if \(embedded\) return;/, 'never moves the page\'s notes');
  assert.match(ag, /const K = \{ board: KP \+ KEYS\.board, chosen: KP \+ KEYS\.chosen, chart: KP \+ KEYS\.chart, fills: KEYS\.fills, feed: KP \+ KEYS\.feed, risk: KEYS\.risk \};/);
  assert.ok(!/(read|write)Json\(KEYS\./.test(ag), 'every key through K');
  assert.match(bt, /storage\.getItem\(chartKey\)/); assert.match(bt, /storage\.setItem\(chartKey,/);
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

/* answers B4-2 (the reviews of 102's fixes and 103): items 1, 2, 5 and 6 */
const NON_STOP = id => [{ type: 'agentMode', agent: id, mode: 'auto' }, { type: 'agentMode', agent: id, mode: 'copilot' }, { type: 'agentKill', agent: id, on: false },
  { type: 'agentRules', agent: id, maxTrades: 2 }, { type: 'agentAnswer', agent: id, id: 'p1', answer: 'accept' }];
const STOPS = id => [{ type: 'agentKill', agent: id, on: true }, { type: 'agentMode', agent: id, mode: 'shadow' }, { type: 'agentSeen', agent: id, id: 'p1' }];
const bothGates = (...msgs) => { const L = gateWith(...msgs), P = AC.praetorianGate(); for (const m of msgs) P.hear(m); return [L, P]; };

test('b F1: a group that changes under a group trader refuses at once, before ChartBridge moves his seats', () => {
  const g1 = agent({ account: null, group: { id: 'g1', name: 'Evals' }, seats: [{ account: 'PROP-1' }, { account: 'PROP-2' }] });
  const g = gateWith(accounts(), groups, g1);
  assert.equal(g.check({ type: 'agentMode', agent: 'demo', mode: 'auto' }), '', 'g1 all prop: Legion');
  g.hear({ type: 'groups', list: [{ id: 'g1', name: 'Evals', members: ['PROP-1', 'MINE-1'] }] });   // the seats still say PROP-1, PROP-2
  for (const m of NON_STOP('demo')) assert.match(g.check(m), /no home: its account mixes kinds/, m.type + ': the group as last heard counts');
  for (const m of STOPS('demo')) assert.equal(g.check(m), '', m.type + ' is a stop');
  assert.match(gateWith(accounts(), g1).check({ type: 'agentMode', agent: 'demo', mode: 'auto' }), /has not listed its groups yet/, 'no groups heard: refused');
  const gone = gateWith(accounts(), { type: 'groups', list: [] }, g1);
  assert.match(gone.check({ type: 'agentMode', agent: 'demo', mode: 'auto' }), /there is no group g1/, 'a group no longer there: refused');
  /* the reviewer's browser case, through the link: two clicks on Auto after the change post nothing */
  const posted = [], subs = [];
  const link = AC.legionLink({ listen: p => { subs.push(p); return () => {}; }, post: x => { posted.push(x); return true; } });
  for (const x of [accounts(), groups, g1, { type: 'groups', list: [{ id: 'g1', name: 'Evals', members: ['PROP-1', 'MINE-1'] }] }]) subs[0].message(x);
  assert.equal(link.post({ type: 'agentMode', agent: 'demo', mode: 'auto' }), false); assert.equal(link.post({ type: 'agentMode', agent: 'demo', mode: 'auto' }), false);
  assert.deepEqual(posted, []);
});

test('b F2 and B6 on Legion: every seat counts, a shape the page cannot read is refused, a group with no seats is not None', () => {
  const cases = [
    [agent({ account: 'PROP-1', seats: [{ account: 'MINE-1' }] }), /no home: its account mixes kinds/, 'prop with a leftover personal seat'],
    [agent({ account: 123 }), /cannot tell its accounts \(ChartBridge sent a shape/, 'a number'],
    [agent({ account: { name: 'PROP-1' } }), /cannot tell its accounts/, 'an object'],
    [agent({ account: '' }), /cannot tell its accounts/, 'an empty string'],
    [agent({ account: null, group: true, seats: [{ account: 'PROP-1' }] }), /cannot tell its accounts/, 'group: true'],
    [agent({ account: null, group: { id: 'g1', name: 'Evals' }, seats: [{ account: 'PROP-1' }, { acct: 'MINE-1' }] }), /cannot tell its accounts/, 'a seat with no account'],
    [agent({ account: null, group: { id: 'g1', name: 'Evals' }, seats: [] }), /no home yet: its group has no seats now, so the page cannot tell it; from here you can only stop it/, 'B6: no seats'],
    [agent({ account: null, group: { id: 'g1', name: 'Evals' } }), /group has no seats now/, 'B6: seats left out'],
    [agent({ account: null, group: { id: 'g5', name: 'Empty' }, seats: [] }), /group Empty has no accounts/, 'an empty group'],
  ];
  for (const [a, re, what] of cases) {
    const [L, P] = bothGates(accounts(), groups, a);
    for (const m of NON_STOP('demo')) { assert.match(L.check(m), re, what + ': ' + m.type); assert.notEqual(P.check(m), '', what + ' on Praetorian: ' + m.type); }
    for (const m of STOPS('demo')) { assert.equal(L.check(m), '', what + ': ' + m.type); assert.equal(P.check(m), '', what + ' on Praetorian: ' + m.type); }
  }
  /* answers B4-3, item 3: None with a leftover seat (here on your personal account) is no one's: stops only on BOTH desks */
  const [L1, P1] = bothGates(accounts(), groups, agent({ account: null, seats: [{ account: 'MINE-1', owns: true, position: { root: 'MNQ', qty: 1 } }] }));
  for (const m of NON_STOP('demo').concat([{ type: 'agentAccount', agent: 'demo', account: 'PROP-1', keepMode: 'shadow' }, { type: 'agentAccount', agent: 'demo', account: 'MINE-1', keepMode: 'shadow' }])) {
    assert.match(L1.check(m), /a leftover position on your personal account: stop and flatten it first/, 'Legion ' + m.type);
    assert.match(P1.check(m), /a leftover position on your personal account: stop and flatten it first/, 'Praetorian ' + m.type);
  }
  for (const m of STOPS('demo')) { assert.equal(L1.check(m), '', m.type); assert.equal(P1.check(m), '', m.type); }
  assert.equal(L1.noHome('demo'), '', 'a leftover position is not "no home"');
  const [L2, P2] = bothGates(accounts(), groups, agent({ account: null, seats: [{ account: 'PROP-1', owns: true, position: { root: 'MNQ', qty: 1 } }] }));
  for (const m of NON_STOP('demo')) { assert.match(L2.check(m), /a leftover position on a prop account/, m.type); assert.match(P2.check(m), /a leftover position on a prop account/, m.type); }
  for (const a of [agent({ account: 'PROP-1', seats: [{ account: 'PROP-1' }] }), agent({ account: null, seats: [] }),
    agent({ account: null, group: { id: 'g2', name: 'Prop and Sim' }, seats: [{ account: 'PROP-1' }, { account: 'SIM-A' }] })])
    for (const m of NON_STOP('demo')) assert.equal(gateWith(accounts(), groups, a).check(m), '', JSON.stringify(a) + ' ' + m.type);
});

test('item 5: a trader with no home says so on both desks; either moves him to None, only while ChartBridge says he is flat', () => {
  const flat = { owns: false, position: null };
  const homeless = [
    [agent(Object.assign({ account: null, group: { id: 'g3', name: 'Mixed' }, seats: [{ account: 'PROP-1', owns: false, position: null }, { account: 'MINE-1', owns: false, position: null }] }, flat)), /no home: its account mixes kinds; stop it, then fix its account or group/],
    [agent(Object.assign({ account: null, group: { id: 'g4', name: 'Sims' }, seats: [{ account: 'SIM-A', owns: false, position: null }] }, flat)), /no home: its group holds only your personal account or Sim accounts/],
    [agent(Object.assign({ account: null, group: { id: 'g6', name: 'Unknown' }, seats: [{ account: 'LIVE-X', owns: false, position: null }] }, flat)), /no home: the page cannot tell an account in its group/],
    [agent(Object.assign({ account: 'LIVE-X' }, flat)), /no home: the page cannot tell its account/],
    [agent(Object.assign({ account: 'GONE-9' }, flat)), /no home: the page cannot tell its account/],
    [agent(Object.assign({ account: 'MINE-1', seats: [{ account: 'PROP-1', owns: false, position: null }] }, flat)), /no home: its account mixes kinds/],
  ];
  const none = { type: 'agentAccount', agent: 'demo', account: null, keepMode: 'shadow' };
  for (const [a, re] of homeless) {
    const [L, P] = bothGates(accounts(), groups, a);
    for (const g of [L, P]) {
      for (const m of NON_STOP('demo')) assert.match(g.check(m), re, m.type);
      assert.match(g.traderWhy('demo'), re); assert.match(g.noHome('demo'), /^no home: /);
      assert.equal(g.check(none), '', 'flat: None goes, as a stop');
      for (const m of [{ type: 'agentAccount', agent: 'demo', account: 'PROP-1', keepMode: 'shadow' }, { type: 'agentAccount', agent: 'demo', account: 'MINE-1', keepMode: 'shadow' },
        { type: 'agentAccount', agent: 'demo', group: 'g1', keepMode: 'shadow' }, { type: 'agentAccount', agent: 'demo', account: null, group: 'g1' },
        { type: 'agentAccount', agent: 'demo', account: null, league: true }, { type: 'agentAccount', agent: 'demo', account: 'SIM-A', keepMode: 'shadow' }])
        assert.notEqual(g.check(m), '', 'only None: ' + JSON.stringify(m));
    }
    for (const notFlat of [{ owns: true }, { owns: undefined }, { position: { root: 'MNQ', qty: 1, avgPrice: 1 } }, { owns: 'false' },
      { seats: [{ account: 'PROP-1', owns: true, position: null }] }, { seats: [{ account: 'PROP-1', owns: false, position: { root: 'MNQ', qty: -2 } }] }]) {
      const b = Object.assign({}, a, notFlat);
      const [L2, P2] = bothGates(accounts(), groups, b);
      for (const g of [L2, P2]) if (g.noHome('demo')) assert.match(g.check(none), /flatten first/, JSON.stringify(notFlat));
    }
  }
  /* a trader with a home is not "no home", and the flat rule does not touch his desk's own None */
  for (const a of [agent({ account: 'PROP-1' }), agent({ account: 'MINE-1' }), agent({ account: null }), agent({ account: 'SIM-A' })]) {
    const [L, P] = bothGates(accounts(), groups, a);
    assert.equal(L.noHome('demo'), ''); assert.equal(P.noHome('demo'), '');
  }
  /* not known yet is not "no home": no pick, no accounts message */
  assert.equal(gateWith(accounts({ personalNamed: false }), groups, agent({ account: 'LIVE-X' })).noHome('demo'), '');
  assert.equal(gateWith(groups, agent({ account: 'LIVE-X' })).noHome('demo'), '');
  assert.equal(AC.traderFlat(agent({ owns: false, position: { qty: 0 } })), true);
  assert.equal(AC.traderFlat(agent({ owns: false, seats: 'x' })), false);
});

test('item 6: a move goes only in Shadow; the link sends Shadow first and the move once ChartBridge shows Shadow', () => {
  const posted = [], subs = [];
  const feed = { listen: p => { subs.push(p); return () => { subs.splice(subs.indexOf(p), 1); }; }, post: x => { posted.push(x); return true; } };
  const link = AC.legionLink(feed);
  const hear = m => { for (const s of subs.slice()) s.message(m); };
  hear(accounts()); hear(groups); hear(agent({ mode: 'auto', account: null })); hear({ type: 'bot', account: null, mode: 'auto' });
  const L = gateWith(accounts(), groups, agent({ mode: 'auto', account: null }), { type: 'bot', account: null, mode: 'auto' });
  assert.match(L.check({ type: 'agentAccount', agent: 'demo', account: 'PROP-1', keepMode: 'auto' }), /goes only while the trader is in Shadow/);
  assert.match(L.check({ type: 'botAccount', account: 'PROP-1' }), /the bot changes account only in Shadow/);
  assert.equal(link.why({ type: 'agentAccount', agent: 'demo', account: 'PROP-1', keepMode: 'auto' }), '', 'the link will do it in two steps');
  assert.equal(link.post({ type: 'agentAccount', agent: 'demo', account: 'PROP-1', keepMode: 'auto' }), true);
  assert.deepEqual(posted, [{ type: 'agentMode', agent: 'demo', mode: 'shadow' }], 'Shadow first, nothing else');
  hear(agent({ mode: 'auto', account: null }));
  assert.equal(posted.length, 1, 'still in Auto: the move waits');
  hear(agent({ mode: 'shadow', account: null }));
  assert.deepEqual(posted[1], { type: 'agentAccount', agent: 'demo', account: 'PROP-1', keepMode: 'shadow' }, 'then the move, keeping Shadow');
  hear(agent({ mode: 'shadow', account: null }));
  assert.equal(posted.length, 2, 'once');
  /* a move the gate refuses is never queued, and its Shadow is not sent either */
  assert.equal(link.post({ type: 'agentAccount', agent: 'demo', account: 'MINE-1', keepMode: 'auto' }), false);
  assert.equal(posted.length, 2);
  /* a drop forgets a waiting move */
  hear(agent({ mode: 'auto', account: null }));
  assert.equal(link.post({ type: 'agentAccount', agent: 'demo', account: 'PROP-2', keepMode: 'auto' }), true);
  assert.equal(posted.length, 3);
  for (const s of subs.slice()) s.closed();
  for (const m of [accounts(), groups, agent({ mode: 'shadow', account: null })]) hear(m);
  assert.equal(posted.length, 3, 'forgotten on the drop');
  /* the bot the same */
  hear({ type: 'bot', account: null, mode: 'auto' });
  assert.equal(link.post({ type: 'botAccount', account: 'PROP-1' }), true);
  assert.deepEqual(posted[3], { type: 'botMode', mode: 'shadow' });
  hear({ type: 'bot', account: null, mode: 'shadow' });
  assert.deepEqual(posted[4], { type: 'botAccount', account: 'PROP-1' });
  link.close();
  assert.equal(subs.length, 0, 'close takes the gate off the feed');
});

test('item 6, the reviewer\'s sequence: Legion sets the bot to Auto on None, Praetorian gives it your personal account: it ends in Shadow there', () => {
  const posted = [], subs = [];
  const bridge = { mode: 'shadow', account: null };
  const feed = { listen: p => { subs.push(p); return () => {}; }, post: x => {
    posted.push(x);
    if (x.type === 'botMode') bridge.mode = x.mode;
    if (x.type === 'botAccount') bridge.account = x.account;   // ChartBridge keeps the bot's mode across a change
    setTimeout(() => { for (const s of subs) s.message(Object.assign({ type: 'bot' }, bridge)); }, 0);
    return true; } };
  const legion = AC.legionLink(feed), praet = AC.praetorianLink(feed);
  for (const s of subs) { s.message(accounts()); s.message(groups); s.message(Object.assign({ type: 'bot' }, bridge)); }
  return new Promise(done => setTimeout(() => {
    assert.equal(legion.post({ type: 'botMode', mode: 'auto' }), true, 'None: Legion may set Auto');
    setTimeout(() => {
      assert.equal(bridge.mode, 'auto');
      assert.equal(praet.post({ type: 'botAccount', account: 'MINE-1' }), true);
      setTimeout(() => {
        assert.equal(bridge.account, 'MINE-1'); assert.equal(bridge.mode, 'shadow', 'the mode did not travel');
        assert.deepEqual(posted.map(x => x.type + ':' + (x.mode || x.account)), ['botMode:auto', 'botMode:shadow', 'botAccount:MINE-1']);
        done();
      }, 20);
    }, 10);
  }, 10));
});

/* answers B4-3 (round 2 of 102 and 103) */
const stand = more => {   // a stand-in ChartBridge for one link: it applies Shadow, Auto and moves as ChartBridge does (keepMode rule)
  const posted = [], subs = [];
  const st = Object.assign({ agent: { mode: 'shadow', account: null }, bot: { mode: 'shadow', account: null } }, more || {});
  const say = () => { for (const s of subs) { s.message(agent(Object.assign({}, st.agent, { owns: false, position: null }))); s.message(Object.assign({ type: 'bot' }, st.bot)); } };
  const feed = { listen: p => { subs.push(p); return () => subs.splice(subs.indexOf(p), 1); }, post: x => {
    posted.push(x);
    if (x.type === 'agentMode') st.agent.mode = x.mode;
    if (x.type === 'agentAccount') { st.agent.account = x.account === undefined ? null : x.account; if (x.keepMode !== st.agent.mode) st.agent.mode = 'shadow'; }
    if (x.type === 'botMode') st.bot.mode = x.mode;
    if (x.type === 'botAccount') st.bot.account = x.account;
    return true; } };
  return { posted, subs, st, feed, say, hearAll: (...ms) => { for (const m of ms) for (const s of subs) s.message(m); } };
};

test('round 2, F1 (X18): the reviewer\'s sequence for an AGENT: Legion sets Auto on None, Praetorian gives your personal account: it ends in Shadow there', () => {
  const B = stand();
  const legion = AC.legionLink(B.feed), praet = AC.praetorianLink(B.feed);
  B.hearAll(accounts(), groups); B.say();
  assert.equal(legion.post({ type: 'agentMode', agent: 'demo', mode: 'auto' }), true, 'None: Legion may set Auto');
  B.say(); assert.equal(B.st.agent.mode, 'auto');
  /* Praetorian's gate alone (the line the break removes): a move for a trader in Auto is refused as it is */
  const P = AC.praetorianGate(); P.hear(accounts()); P.hear(agent({ mode: 'auto', account: null }));
  assert.match(P.check({ type: 'agentAccount', agent: 'demo', account: 'MINE-1', keepMode: 'auto' }), /goes only while the trader is in Shadow/);
  assert.equal(P.check({ type: 'agentAccount', agent: 'demo', account: 'MINE-1', keepMode: 'auto' }, true), '', 'and only for that reason');
  assert.equal(praet.post({ type: 'agentAccount', agent: 'demo', account: 'MINE-1', keepMode: 'auto' }), true);
  assert.deepEqual(B.posted.slice(-1)[0], { type: 'agentMode', agent: 'demo', mode: 'shadow' }, 'Shadow first');
  B.say();
  assert.equal(B.st.agent.account, 'MINE-1'); assert.equal(B.st.agent.mode, 'shadow', 'the mode did not travel');
  assert.equal(B.posted.filter(x => x.type === 'agentAccount').length, 1);
});

test('round 2, F1 (X27): a no-home trader in Auto, flat: Shadow goes first, then None', () => {
  const B = stand({ agent: { mode: 'auto', account: 'LIVE-X' } });
  const link = AC.legionLink(B.feed);
  B.hearAll(accounts(), groups); B.say();
  const G = gateWith(accounts(), groups, agent({ mode: 'auto', account: 'LIVE-X', owns: false, position: null }));
  assert.match(G.check({ type: 'agentAccount', agent: 'demo', account: null, keepMode: 'auto' }), /goes only while the trader is in Shadow/, 'the gate: None only in Shadow');
  assert.equal(link.post({ type: 'agentAccount', agent: 'demo', account: null, keepMode: 'auto' }), true);
  assert.deepEqual(B.posted, [{ type: 'agentMode', agent: 'demo', mode: 'shadow' }]);
  B.say();
  assert.deepEqual(B.posted[1], { type: 'agentAccount', agent: 'demo', account: null, keepMode: 'shadow' });
  assert.equal(B.st.agent.account, null); assert.equal(B.st.agent.mode, 'shadow');
});

test('round 2, F1 (X24) and F7: a kept move is forgotten after 10 s, and said; refused after Shadow shows, said too', () => {
  let t = 1000;
  const B = stand({ agent: { mode: 'auto', account: null } });
  const notes = [];
  const link = AC.legionLink(B.feed, null, { now: () => t });
  link.listen({ message: m => { if (m && m.type === 'linkMove') notes.push(m); } });
  B.hearAll(accounts(), groups); B.say();
  assert.equal(link.post({ type: 'agentAccount', agent: 'demo', account: 'PROP-1', keepMode: 'auto' }), true);
  t += 10500;
  B.hearAll(agent({ mode: 'shadow', account: null, owns: false, position: null }));   // Shadow shows only after 10 s
  assert.equal(B.posted.filter(x => x.type === 'agentAccount').length, 0, 'not posted after 10 s');
  assert.equal(notes.length, 1); assert.match(notes[0].text, /^The move was not made: ChartBridge did not show Shadow within 10 s; demo stays in Shadow\.$/);
  assert.equal(notes[0].agent, 'demo');
  /* refused for another reason once Shadow shows: the groups changed meanwhile, so the move is not made, and said */
  B.hearAll(agent({ mode: 'auto', account: null, owns: false, position: null }));
  assert.equal(link.post({ type: 'agentAccount', agent: 'demo', group: 'g1', keepMode: 'auto' }), true);
  B.hearAll({ type: 'groups', list: [{ id: 'g1', name: 'Evals', members: ['PROP-1', 'MINE-1'] }] });
  B.hearAll(agent({ mode: 'shadow', account: null, owns: false, position: null }));
  assert.equal(B.posted.filter(x => x.type === 'agentAccount').length, 0);
  assert.equal(notes.length, 2); assert.match(notes[1].text, /^The move was not made: group Evals holds your personal account; demo stays in Shadow\.$/);
  /* the bot the same */
  B.hearAll({ type: 'bot', account: null, mode: 'auto' });
  assert.equal(link.post({ type: 'botAccount', account: 'PROP-1' }), true);
  t += 20000;
  B.hearAll({ type: 'bot', account: null, mode: 'auto' });
  assert.equal(notes.length, 3); assert.equal(notes[2].bot, true); assert.match(notes[2].text, /the bot stays in Shadow\.$/);
});

test('round 2, F5: every move the link posts keeps Shadow, whatever the desk asked', () => {
  const B = stand();
  const link = AC.legionLink(B.feed);
  B.hearAll(accounts(), groups); B.say();
  assert.equal(link.post({ type: 'agentAccount', agent: 'demo', account: 'PROP-1', keepMode: 'auto' }), true);
  assert.deepEqual(B.posted, [{ type: 'agentAccount', agent: 'demo', account: 'PROP-1', keepMode: 'shadow' }]);
});

test('round 2, F2 on Legion: the bot\'s account: only null is None', () => {
  for (const sh of [{ account: 123 }, { account: { name: 'PROP-1' } }, { account: '' }, { account: true }, {}]) {
    const g = gateWith(accounts(), groups, Object.assign({ type: 'bot', mode: 'shadow' }, sh));
    for (const m of [{ type: 'botMode', mode: 'auto' }, { type: 'botRails', maxTrades: 1 }, { type: 'botAccount', account: 'PROP-1' }, { type: 'botKill', on: false }])
      assert.match(g.check(m), /The bot: the page cannot tell its account/, JSON.stringify(sh) + ' ' + m.type);
    for (const m of [{ type: 'botKill', on: true }, { type: 'botMode', mode: 'shadow' }, { type: 'botSeen', id: 'p1' }]) assert.equal(g.check(m), '', JSON.stringify(sh) + ' ' + m.type);
  }
  const t = (() => { const x = agent(); delete x.account; return x; })();
  assert.match(gateWith(accounts(), groups, t).check({ type: 'agentMode', agent: 'demo', mode: 'auto' }), /cannot tell its accounts/, 'a trader with no account key');
});

test('round 2, F8 and F9: a seat that does not say it owns nothing is not flat; a group not known says "no home yet", never Praetorian', () => {
  assert.equal(AC.traderFlat(agent({ owns: false, seats: [{ account: 'PROP-1', position: null }] })), false, 'owns missing on a seat');
  assert.equal(AC.traderFlat(agent({ owns: false, seats: [{ account: 'PROP-1', owns: false, position: null }] })), true);
  const g1 = agent({ account: null, group: { id: 'g1', name: 'Evals' }, seats: [{ account: 'PROP-1' }] });
  for (const [msgs, re] of [[[accounts(), g1], /no home yet: ChartBridge has not listed its groups yet; from here you can only stop it/],
    [[accounts(), { type: 'groups', list: [] }, g1], /no home yet: there is no group g1 on this ChartBridge; from here you can only stop it/],
    [[accounts(), groups, agent({ account: null, group: { id: 'g5', name: 'Empty' }, seats: [{ account: 'PROP-1' }] })], /no home yet: group Empty has no accounts; from here/]]) {
    const why = gateWith(...msgs).check({ type: 'agentMode', agent: 'demo', mode: 'auto' });
    assert.match(why, re); assert.doesNotMatch(why, /set up from Praetorian/);
  }
});

test('round 2, item 3: a leftover position of two kinds is its own case, never "no home" (no move offered)', () => {
  const a = agent({ account: null, mode: 'auto', owns: false, position: null, seats: [{ account: 'PROP-1', owns: false, position: null }, { account: 'MINE-1', owns: false, position: null }] });
  const [L, P] = bothGates(accounts(), groups, a);
  for (const g of [L, P]) {
    assert.equal(g.noHome('demo'), '', 'not "no home"');
    assert.match(g.traderWhy('demo'), /a leftover position on more than one kind of account: stop and flatten it first/);
    assert.match(g.check({ type: 'agentAccount', agent: 'demo', account: null, keepMode: 'shadow' }), /a leftover position/, 'None is not offered as a no-home move');
  }
});
