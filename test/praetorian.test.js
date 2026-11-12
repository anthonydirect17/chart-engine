'use strict';
// Chart 1.48.0 (Anthony 2026-11-11: the Agent and Bot tabs as one tab, Praetorian, "focused on the personal (not prop
// business) accounts"): the gate in live/agent-core.js (praetorianGate). Made-up traders and SIM-A, PROP-1, MINE-1 style accounts only.
const test = require('node:test');
const assert = require('node:assert/strict');
const AC = require('../live/agent-core.js');

const accounts = (o) => Object.assign({ type: 'accounts', personalNamed: true, list: [
  { name: 'SIM-A', sim: true, tradable: true }, { name: 'LIVE-X', tradable: true }, { name: 'PROP-1', prop: true, tradable: true }, { name: 'PROP-2', prop: true, tradable: true }, { name: 'MINE-1', personal: true, tradable: true }] }, o || {});
const agent = o => Object.assign({ type: 'agent', agent: 'demo', name: 'Demo Agent', mode: 'shadow', enabled: true, connected: true, account: 'MINE-1' }, o || {});
const gateWith = (...msgs) => { const g = AC.praetorianGate(); for (const m of msgs) g.hear(m); return g; };

/* every message the two desks post (agent.js, bot.js, agent-core.js, bot-core.js), one each */
const AGENT_MSGS = id => [
  { type: 'agentMode', agent: id, mode: 'auto' }, { type: 'agentMode', agent: id, mode: 'shadow' }, { type: 'agentMode', agent: id, mode: 'copilot' },
  { type: 'agentKill', agent: id, on: false }, { type: 'agentRules', agent: id, maxTrades: 2 }, { type: 'agentAnswer', agent: id, id: 'p1', answer: 'accept' },
  { type: 'agentAccount', agent: id, account: null, keepMode: 'shadow' }];
const BOT_MSGS = [{ type: 'botMode', mode: 'auto' }, { type: 'botKill', on: false }, { type: 'botRails', maxTrades: 1 }, { type: 'botAnswer', id: 'p1', answer: 'accept' }, { type: 'botAccount', account: null }];

test('a trader on your personal account: everything the Agent desk sends goes', () => {
  const g = gateWith(accounts(), agent());
  for (const m of AGENT_MSGS('demo')) assert.equal(g.check(m), '', m.type + ' ' + JSON.stringify(m));
  assert.equal(g.check({ type: 'agentAccount', agent: 'demo', account: 'MINE-1', keepMode: 'shadow' }), '');
});

test('a trader on None: it may be given your personal account or a Sim account, and nothing else', () => {
  const g = gateWith(accounts(), agent({ account: null }));
  assert.equal(g.check({ type: 'agentMode', agent: 'demo', mode: 'auto' }), '', 'on None nothing trades');
  assert.equal(g.check({ type: 'agentAccount', agent: 'demo', account: 'MINE-1', keepMode: 'shadow' }), '');
  assert.match(g.check({ type: 'agentAccount', agent: 'demo', account: 'PROP-1', keepMode: 'shadow' }), /PROP-1 is a prop account: it is run from Legion/);
  assert.equal(g.check({ type: 'agentAccount', agent: 'demo', account: 'SIM-A', keepMode: 'shadow' }), '', 'a Sim account (to confirm)');
  assert.equal(g.check({ type: 'agentAccount', agent: 'demo', account: 'SIM-A', league: true, keepMode: 'shadow' }), '', 'a league seat is a Sim account');
  assert.match(g.check({ type: 'agentAccount', agent: 'demo', account: 'PROP-1', league: true, keepMode: 'shadow' }), /PROP-1 is a prop account/);
  assert.match(g.check({ type: 'agentAccount', agent: 'demo', group: 'g1', keepMode: 'shadow' }), /a group is the prop business/);
  assert.match(g.check({ type: 'agentAccount', agent: 'demo', account: 'LIVE-X', keepMode: 'shadow' }), /LIVE-X is an account the page cannot tell/);
  assert.match(g.check({ type: 'agentAccount', agent: 'demo', account: 'NOPE', keepMode: 'shadow' }), /NOPE is not in ChartBridge's accounts now/);
});

test('a trader on a prop account, a group (even of Sim accounts), or an account the page cannot tell: only its kill switch ON gets through', () => {
  const cases = [
    [agent({ account: 'PROP-1' }), /PROP-1 is a prop account: it is run from Legion/],
    [agent({ account: null, group: { id: 'g1', name: 'Evals' }, seats: [{ account: 'PROP-1' }, { account: 'PROP-2' }] }), /trades a group: groups are the prop business/],
    [agent({ account: null, group: { id: 'g2', name: 'Mine' }, seats: [{ account: 'MINE-1' }] }), /trades a group/],
    [agent({ account: null, group: { id: 'g3', name: 'Sims' }, seats: [{ account: 'SIM-A' }] }), /trades a group/],
    [agent({ account: 'LIVE-X' }), /LIVE-X is an account the page cannot tell/],
    [agent({ account: 'GONE-9' }), /GONE-9 is not in ChartBridge's accounts now/],
  ];
  for (const [a, rx] of cases) {
    const g = gateWith(accounts(), a);
    for (const m of AGENT_MSGS('demo')) { const why = g.check(m); assert.match(why, /^Not sent from Praetorian: /, m.type); assert.match(why, rx, m.type); }
    assert.match(g.check({ type: 'agentAccount', agent: 'demo', account: 'MINE-1', keepMode: 'shadow' }), rx, 'not even to your personal account: the prop trader is moved from Legion');
    assert.equal(g.check({ type: 'agentKill', agent: 'demo', on: true }), '', 'the kill switch ON always goes: it only stops a trader');
    assert.equal(g.check({ type: 'agentSeen', agent: 'demo', id: 'p1' }), '', 'an acknowledgement changes nothing');
  }
});

test('the page cannot tell: no pick, no accounts message yet, a trader not described yet, another type: refused', () => {
  const noPick = gateWith(accounts({ personalNamed: false, list: [{ name: 'MINE-1' }, { name: 'SIM-A', sim: true }] }), agent());
  assert.match(noPick.check({ type: 'agentMode', agent: 'demo', mode: 'auto' }), /MINE-1 is a live account and no personal account is picked yet/);
  assert.equal(gateWith(accounts({ personalNamed: false, list: [{ name: 'SIM-A', sim: true }] }), agent({ account: 'SIM-A' })).check({ type: 'agentMode', agent: 'demo', mode: 'auto' }), '', 'Sim needs no pick');
  const noAcc = gateWith(agent());
  assert.match(noAcc.check({ type: 'agentMode', agent: 'demo', mode: 'auto' }), /has not listed its accounts yet/);
  const g = gateWith(accounts(), agent());
  assert.match(g.check({ type: 'agentMode', agent: 'other', mode: 'auto' }), /has not described trader other yet/);
  for (const t of ['accountGroup', 'memberBench', 'groupSave', 'groupDelete', 'agentKillAllProp', 'agentPick', 'agentStandDownClear', 'order', 'flatten', 'cancel', 'accountPersonal', 'accountLimits'])
    assert.match(g.check({ type: t, agent: 'demo' }), new RegExp('it does not send ' + t), t + ' is refused by name');
  assert.equal(g.check(null), 'Not a message.'); assert.equal(g.check({}), 'Not a message.');
  /* a personal flag on a row is believed only with personalNamed: true (ChartBridge 0.6.16 says both) */
  assert.equal(AC.prIsPersonal('MINE-1', accounts({ personalNamed: undefined })), false);
});

test('the connection drops: everything heard is forgotten, so nothing passes on an old word but a kill switch ON', () => {
  const g = gateWith(accounts(), agent(), { type: 'bot', account: 'MINE-1', mode: 'shadow' });
  assert.equal(g.check({ type: 'agentMode', agent: 'demo', mode: 'auto' }), '');
  g.lost();
  assert.deepEqual(g.state(), { agents: 0, bot: false, accounts: false, personalNamed: false });
  assert.notEqual(g.check({ type: 'agentMode', agent: 'demo', mode: 'auto' }), '');
  assert.notEqual(g.check({ type: 'botMode', mode: 'auto' }), '');
  assert.equal(g.check({ type: 'agentKill', agent: 'demo', on: true }), '');
  assert.equal(g.check({ type: 'botKill', on: true }), '');
  /* a later accounts message that moves the pick: the gate follows ChartBridge, never its own memory */
  g.hear(accounts()); g.hear(agent());
  assert.equal(g.check({ type: 'agentMode', agent: 'demo', mode: 'auto' }), '');
  g.hear(accounts({ list: [{ name: 'MINE-1', prop: true }] }));
  assert.match(g.check({ type: 'agentMode', agent: 'demo', mode: 'auto' }), /MINE-1 is a prop account/);
});

test('the bot slot: on your personal account or None, every bot message; elsewhere only its kill switch ON', () => {
  for (const acct of ['MINE-1', 'SIM-A', null]) {
    const g = gateWith(accounts(), { type: 'bot', account: acct, mode: 'shadow' });
    for (const m of BOT_MSGS) assert.equal(g.check(m), '', acct + ' ' + m.type);
    assert.equal(g.check({ type: 'botAccount', account: 'MINE-1' }), '');
    assert.match(g.check({ type: 'botAccount', account: 'PROP-1' }), /PROP-1 is a prop account/);
    assert.equal(g.check({ type: 'botAccount', account: 'SIM-A' }), '');
    assert.match(g.check({ type: 'botAccount', account: 'LIVE-X' }), /cannot tell/);
  }
  for (const acct of ['PROP-1', 'LIVE-X', 'GONE-9']) {
    const g = gateWith(accounts(), { type: 'bot', account: acct, mode: 'auto' });
    for (const m of BOT_MSGS) assert.match(g.check(m), /^Not sent from Praetorian: The bot: /, acct + ' ' + m.type);
    assert.equal(g.check({ type: 'botKill', on: true }), '');
    assert.equal(g.check({ type: 'botSeen', id: 'p1' }), '');
  }
  assert.match(gateWith(accounts()).check({ type: 'botMode', mode: 'auto' }), /has not described the bot yet/);
});

test('the link the workspace hands both desks: built here and run, it posts only what the gate passes', () => {
  const fs = require('node:fs'), path = require('node:path');
  const ws = fs.readFileSync(path.join(__dirname, '..', 'live', 'workspace.js'), 'utf8');
  const m = /const praetorianLink = (praetorianGate \? Object\.freeze\(\{[\s\S]*?\}\) : null);/.exec(ws);
  assert.ok(m, 'one expression');
  const posted = [], heard = [];
  const AF = { listen: p => { heard.push(p); return () => {}; }, post: x => { posted.push(x); return true; }, send: x => posted.push(['send', x]), sendOrder: x => posted.push(['order', x]), limit: () => ({ level: '' }) };
  const gate = AC.praetorianGate();
  const link = new Function('AF', 'praetorianGate', 'return ' + m[1])(AF, gate);
  assert.deepStrictEqual(Object.keys(link).sort(), ['accountOk', 'botWhy', 'limit', 'listen', 'named', 'personal', 'post', 'traderWhy', 'why'], 'no send, no sendOrder');
  assert.ok(Object.isFrozen(link));
  for (const x of [accounts(), agent({ agent: 'mine', account: 'MINE-1' }), agent({ agent: 'prop', account: 'PROP-1' }), { type: 'bot', account: 'PROP-1', mode: 'auto' }]) gate.hear(x);
  assert.equal(link.post({ type: 'agentMode', agent: 'mine', mode: 'auto' }), true);
  assert.equal(link.post({ type: 'agentMode', agent: 'prop', mode: 'auto' }), false, 'a prop trader: refused before the feed');
  assert.equal(link.post({ type: 'agentKill', agent: 'prop', on: true }), true, 'its kill switch on goes');
  assert.equal(link.post({ type: 'botMode', mode: 'shadow' }), false, 'the bot on a prop account: only its kill switch');
  assert.equal(link.post({ type: 'order', root: 'MNQ' }), false, 'nothing else, by name');
  assert.deepEqual(posted.map(x => x.type + ':' + (x.agent || '')), ['agentMode:mine', 'agentKill:prop']);
  assert.match(link.why({ type: 'agentMode', agent: 'prop', mode: 'auto' }), /PROP-1 is a prop account/);
  assert.equal(link.traderWhy('mine'), ''); assert.match(link.traderWhy('prop'), /prop account/); assert.match(link.botWhy(), /The bot: PROP-1/);
  assert.equal(link.accountOk('MINE-1'), true); assert.equal(link.accountOk('SIM-A'), true); assert.equal(link.accountOk('PROP-1'), false);
  assert.equal(link.named(), true);
  assert.strictEqual(new Function('AF', 'praetorianGate', 'return ' + m[1])(AF, null), null, 'no gate: no connection (the careful side)');
  /* both desks get it, the gate hears first, and it forgets on a drop */
  assert.match(ws, /window\.BotDesk\.create\(\{ v3: praetorianLink,/);
  assert.match(ws, /window\.AgentDesk\.create\(\{ v3: praetorianLink,/);
  assert.ok(ws.indexOf('AF.listen({ message: m => { praetorianGate.hear(m);') < ws.indexOf('function startBot()'), 'the gate listens before the desks are made');
  assert.match(ws, /closed: \(\) => \{ praetorianGate\.lost\(\); syncPraetorian\(\); \}/);
});

test('the pickers on Praetorian: never a choice the desk did not offer; a group never; a prop or unknown account listed, not offered', () => {
  const list = AC.pickerChoices(accounts(), { type: 'groups', list: [{ id: 'g1', name: 'Evals', members: ['PROP-1'] }] }, agent({ account: null }), { agents: [] });
  const out = AC.prChoices(list, n => n === 'MINE-1' || n === 'SIM-A');
  assert.equal(out.length, list.length);
  const by = v => out.find(c => c.value === v);
  assert.equal(by('').ok, list.find(c => c.value === '').ok, 'None as it was');
  assert.equal(by('group:g1').ok, false); assert.match(by('group:g1').text, /groups are the prop business/);
  assert.equal(by('PROP-1').ok, false); assert.match(by('PROP-1').text, /not on Praetorian/);
  assert.equal(by('LIVE-X').ok, false);
  assert.equal(by('MINE-1').ok, list.find(c => c.value === 'MINE-1').ok, 'your personal account as the desk had it');
  assert.equal(by('SIM-A').ok, list.find(c => c.value === 'SIM-A').ok);
  for (const c of out) if (c.ok) assert.ok(list.find(x => x.value === c.value).ok, 'never offers what the desk did not');
  const bots = AC.prBotChoices([{ name: 'MINE-1', tradable: true }, { name: 'PROP-1', tradable: true }], n => n === 'MINE-1');
  assert.deepEqual(bots.map(c => c.tradable), [true, false]); assert.match(bots[1].praetorian, /not on Praetorian/);
});

test('every send path in the two desks says the gate\'s reason, never "not connected"', () => {
  const fs = require('node:fs'), path = require('node:path');
  const ag = fs.readFileSync(path.join(__dirname, '..', 'live', 'agent.js'), 'utf8'), bt = fs.readFileSync(path.join(__dirname, '..', 'live', 'bot.js'), 'utf8');
  assert.match(ag, /const no = refusal\(m\);\n    if \(no\) \{ notice\(\{ kind: 'refused', level: 'amber', text: no \}\); return false; \}/, 'sendAgent');
  assert.match(ag, /const no = refusal\(r\.msg\);\n    if \(no\) \{ props\.refused\(agent, id\); setMsg\(x, no\); return false; \}/, 'an answer');
  assert.match(ag, /const no = refusal\(m\); if \(no\) \{ boardSay\(no\); return; \}/, 'the board\'s assign');
  assert.match(ag, /const held = heldWhy\(id\); if \(held\) \{ boardSay\('Nothing was started from Praetorian: '/, 'the board\'s Start in Shadow (the helper)');
  assert.match(ag, /async function helperOn\(a\) \{[^]*?const held = heldWhy\(a\.agent\); if \(held\)/, 'On (the helper)');
  assert.match(ag, /async function helperSave\(a\) \{\n    const held = heldWhy\(a\.agent\); if \(held\)/, 'Auto-On time (the helper)');
  assert.equal((ag.match(/sendRaw\(/g) || []).length, 5, 'sendRaw: its use in the seen ack, the answer, the assign, the board start and sendAgent; each refused one is said');
  assert.match(bt, /const no = refusal\(m\);\n    if \(no\) \{ notice\(\{ kind: 'refused', level: 'amber', text: no \}\); return false; \}/, 'sendBot');
  assert.match(bt, /const no = refusal\(r\.msg\);\n    if \(no\) \{ props\.refused\(id\); put\(msgEl, 'textContent', no\); return false; \}/, 'the bot\'s answer');
});

test('deliberate breaks of the gate, each one a test missed at first (2026-11-12): exact values only', () => {
  const g = gateWith(accounts(), agent({ account: 'PROP-1' }), { type: 'bot', account: 'PROP-1', mode: 'auto' });
  /* a kill switch passes only when it is turned ON, exactly: "on" that is not true is a release or nonsense */
  for (const on of [1, 'yes', 'true', {}, [true]]) {
    assert.notEqual(g.check({ type: 'agentKill', agent: 'demo', on }), '', 'agentKill on ' + JSON.stringify(on));
    assert.notEqual(g.check({ type: 'botKill', on }), '', 'botKill on ' + JSON.stringify(on));
  }
  /* only the two acknowledgements are acknowledgements */
  for (const t of ['orderSeen', 'botSeenX', 'agentseen', 'Seen']) assert.match(g.check({ type: t, agent: 'demo' }), /it does not send/, t);
  /* an account change: a group key, even empty, is a group; no account key, or an empty one, is not None */
  const p = gateWith(accounts(), agent({ account: 'MINE-1' }), { type: 'bot', account: 'MINE-1', mode: 'shadow' });
  assert.match(p.check({ type: 'agentAccount', agent: 'demo', group: '', account: null, keepMode: 'shadow' }), /a group is the prop business/);
  assert.match(p.check({ type: 'agentAccount', agent: 'demo', group: null, account: null, keepMode: 'shadow' }), /a group is the prop business/);
  for (const m of [{}, { account: '' }, { account: undefined }, { account: 0 }, { account: false }]) {
    assert.notEqual(p.check(Object.assign({ type: 'agentAccount', agent: 'demo', keepMode: 'shadow' }, m)), '', 'agentAccount ' + JSON.stringify(m));
    assert.notEqual(p.check(Object.assign({ type: 'botAccount' }, m)), '', 'botAccount ' + JSON.stringify(m));
  }
  assert.equal(p.check({ type: 'agentAccount', agent: 'demo', account: null, keepMode: 'shadow' }), '', 'None is account: null, exactly');
  assert.equal(p.check({ type: 'botAccount', account: null }), '');
});
