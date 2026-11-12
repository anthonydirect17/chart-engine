// The Bots tab's core (live/fleet.js FleetCore, drafted as Fleet): the Lab's roster files as GET /roster serves them, the traders
// and the prop accounts from ChartBridge's own messages, the day's profit stop mark as ChartBridge 0.6.19 computes it, and when
// Kill all may be sent. Made-up accounts, traders, bots and numbers.
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
    { name: 'EVAL-A', sim: false, connection: 'connected', personal: false, prop: true, tradable: true, group: 'g1', pnlToday: 310, roomFloor: 3140, targetLeft: 1860,
      rules: { size: 50000, target: 3000, consistency: 40, own: false }, positions: [{ root: 'MNQ', name: 'MNQ 12-26', qty: 4, avgPrice: 25000 }], why: {} },
    { name: 'EVAL-B', sim: false, connection: 'connected', personal: false, prop: true, tradable: true, group: 'g1', pnlToday: 1200, roomFloor: 2380, targetLeft: 520,
      rules: { size: 50000, target: 3000, consistency: 40, own: false }, positions: [], why: {} },
    { name: 'FUND-A', sim: false, connection: 'connected', personal: false, prop: true, tradable: true, group: 'g2', pnlToday: -155.5, roomFloor: null, targetLeft: null,
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

test('legion: traders: mode, account and its kind, window, the two entry switches, the day stop, and who is in Auto on prop accounts', () => {
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
  assert.deepStrictEqual([g.modeText, g.kind, g.autoProp, g.accountText, g.window, g.flatAt], ['Auto', 'prop', true, 'EVAL-A', '09:40 to 15:00', '15:55']);
  assert.deepStrictEqual([g.marketEntry, g.noTarget, g.switchesKnown, g.dayStop, g.dayStopKnown, g.status], [true, true, true, 900, true, 'In a trade']);
  assert.deepStrictEqual([t.manrae.kind, t.manrae.autoProp, t.manrae.marketEntry, t.manrae.noTarget, t.manrae.dayStop], ['personal', false, false, false, null], 'Auto on the personal account alone is not counted');
  assert.strictEqual(t.shadow1.autoProp, false);
  assert.deepStrictEqual([t.downed.autoProp, t.downed.tone, t.downed.status], [false, 'standDown', "Stood down: the day's profit stop is reached on EVAL-B"]);
  assert.deepStrictEqual([t.killed1.autoProp, t.killed1.tone], [false, 'killed']);
  assert.deepStrictEqual([t.away.autoProp, t.away.tone], [true, 'lost'], 'in Auto with its program away: it trades again the moment it connects, so it is counted, and named as not connected');
  assert.deepStrictEqual([t.nowhere.kind, t.nowhere.accountText, t.nowhere.autoProp], ['none', 'None', false]);
  assert.deepStrictEqual([t.grp.kind, t.grp.accountText, t.grp.autoProp], ['prop', 'Group Evals: EVAL-A, EVAL-B', true]);
  assert.deepStrictEqual([t.simmer.kind, t.simmer.autoProp], ['sim', false]);
  // an older ChartBridge: the switches and the day stop are said to be not known, never shown as off or none
  const old = F.traders(list, accounts, '0.6.17').find(x => x.id === 'germanicus');
  assert.deepStrictEqual([old.switchesKnown, old.dayStopKnown], [false, false]);
  // no personal account picked: nothing is prop, nobody is counted
  const none = F.traders(list, Object.assign({}, accounts, { personalNamed: false, list: accounts.list.map(a => Object.assign({}, a, { prop: false, personal: false })) }), '0.6.19');
  assert.ok(none.every(x => !x.autoProp));
  // a mode that is a key of every object is never a mode (N6)
  for (const mode of ['constructor', '__proto__', 'toString', 7, null, { a: 1 }]) assert.deepStrictEqual((({ mode: m, modeText, autoProp }) => [m, modeText, autoProp])(F.traders([agent('x', { mode })], accounts, '0.6.19')[0]), ['', 'Not known', false]);
});

test('legion: the head line never says nobody is trading while a trader is in Auto on a mixed group or on an account NinjaTrader does not list (PROP 3)', () => {
  const line = list => F.autoLine(F.traders(list, accounts, '0.6.19'));
  assert.strictEqual(line([agent('germanicus'), agent('grp', { account: null, group: { id: 'g1', name: 'Evals' }, seats: [{ account: 'EVAL-A' }, { account: 'EVAL-B' }] })]), 'In Auto on prop accounts: germanicus, grp');
  assert.strictEqual(line([agent('manrae', { account: 'MINE-1' }), agent('simmer', { account: 'Sim101' }), agent('s', { mode: 'shadow' })]), 'No trader is in Auto on a prop account');
  assert.strictEqual(line([]), 'No traders yet');
  // the very trader Kill all does NOT stop: a group holding the personal account and a prop account
  const mixed = agent('mix', { account: null, group: { id: 'g9', name: 'Both' }, seats: [{ account: 'MINE-1' }, { account: 'EVAL-A' }] });
  assert.strictEqual(F.traders([mixed], accounts, '0.6.19')[0].kind, 'mixed');
  assert.strictEqual(line([mixed]), 'In Auto on a group with your personal account in it (Kill all will NOT stop it: stop it on the Agent tab): mix');
  // a prop account NinjaTrader does not list now: in scope for Kill all (ChartBridgeAgents.KillScope), and said
  const gone = agent('gone', { account: 'DROPPED-1' });
  assert.strictEqual(F.traders([gone], accounts, '0.6.19')[0].kind, 'unlisted');
  assert.strictEqual(line([gone]), 'In Auto on an account NinjaTrader does not list now (Kill all stops it): gone');
  assert.strictEqual(line([agent('germanicus'), gone, mixed, agent('away', { account: 'EVAL-B', connected: false })]),
    'In Auto on prop accounts: away (its program is not connected now), germanicus. In Auto on an account NinjaTrader does not list now (Kill all stops it): gone. In Auto on a group with your personal account in it (Kill all will NOT stop it: stop it on the Agent tab): mix');
  // prop and Sim seats together: stopped by Kill all (its prop seats flattened), counted with the prop ones
  const ps = agent('ps', { account: null, group: { id: 'g8', name: 'PS' }, seats: [{ account: 'EVAL-A' }, { account: 'Sim101' }] });
  assert.deepStrictEqual([F.traders([ps], accounts, '0.6.19')[0].kind, line([ps])], ['propsim', 'In Auto on prop accounts: ps']);
  assert.deepStrictEqual(['prop', 'personal', 'sim', 'unlisted', ''].map(k => F.seatsKind([k])), ['prop', 'personal', 'sim', 'unlisted', '']);
  assert.deepStrictEqual([F.seatsKind([]), F.seatsKind(['unlisted', 'personal']), F.seatsKind(['sim', 'personal']), F.seatsKind(['prop', ''])], ['none', 'mixed', 'personal', '']);
  // the C# rule this mirrors
  const cs = read('nt8', 'ChartBridgeAgents.cs');
  assert.match(cs, /return listed == null \|\| !\(ChartBridgeBot\.IsSim\(listed\) \|\| ChartBridgeAccounts\.IsSim\(listed\)\);/, 'not listed: in scope');
  assert.match(cs, /return seats\.Any\(x => ChartBridgeBranches\.IsPersonal\(x\)\) && seats\.Any\(x => KillScope\(x\)\);/, 'the personal account and a seat in scope: left alone');
  for (const f of ['live/fleet.js', 'live/fleet.css', 'live/index.html']) assert.ok(!/on duty/i.test(read(...f.split('/'))), f + ': the words "on duty" (the withdrawn claim) are not used');
});

test('legion: versions: three parts or two, never "older than everything" (N7)', () => {
  assert.deepStrictEqual([F.atLeast('0.6.17', '0.6.17'), F.atLeast('0.6.16', '0.6.17'), F.atLeast('0.7', '0.6.17'), F.atLeast('1.0', '0.6.20'), F.atLeast('0.6', '0.6.17'), F.atLeast('', '0.6.17'), F.atLeast(null, '0.6.17'), F.atLeast(['0.9.9'], '0.6.17')],
    [true, false, true, true, false, false, false, false]);
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
  // PROP 5: before the first accounts message the tab does not know; that alone never holds Kill all back (ChartBridge answers)
  assert.deepStrictEqual(F.killAllState('0.6.19', null, true, true), { ok: true, why: '' });
  assert.strictEqual(F.autoLine([], false), 'Not heard from ChartBridge yet which accounts are prop');
  assert.strictEqual(F.autoLine([], true), 'No traders yet');
  assert.match(F.killAllState('0.6.19', accounts, true, false).why, /not connected/);
  assert.deepStrictEqual(F.killAllMsg('c1'), { type: 'agentKillAllProp', cid: 'c1' });
  assert.deepStrictEqual(F.killAllMsg(), { type: 'agentKillAllProp' });
  assert.match(read('nt8', 'ChartBridgeAgents.cs'), /\{ "agentKillAllProp", new\[\] \{ "type", "cid" \} \},/, 'ChartBridge takes exactly these keys');
});

test('fleet: dollars', () => {
  assert.deepStrictEqual([F.usd(1200), F.usd(-310), F.usd(310, true), F.usd(0, true), F.usd(155.5), F.usd(null), F.usd(NaN)], ['$1,200', '-$310', '+$310', '$0', '$155.50', '', '']);
});

test('legion: the tab is wired into the page beside the other three, with a connection that can post its three messages only', () => {
  const src = read('live', 'fleet.js'), html = read('live', 'index.html'), ws = read('live', 'workspace.js');
  assert.match(html, /<button type="button" class="ws-btn fl-tabbtn" id="wsFleetTab" aria-pressed="false"[^>]* hidden>Legion<\/button>/, 'hidden until ChartBridge says it knows Kill all');
  assert.match(html, /<section class="fl-view fl-in-ws" id="flView" aria-label="Legion tab"><\/section>/);
  assert.ok(html.indexOf('<script src="fleet.js"></script>') > 0 && html.indexOf('<script src="fleet.js"></script>') < html.indexOf('<script src="workspace.js"'), 'loaded before workspace.js');
  const files = JSON.parse(read('nt8', 'install-files.json'));
  assert.ok(files.www.some(x => x.from === 'live/fleet.js' && x.to === 'fleet.js') && files.www.some(x => x.from === 'live/fleet.css' && x.to === 'fleet.css'), 'installed on the PCs with the page');
  for (const id of ['wsAgentTab', 'wsLeagueTab', 'wsBotTab']) assert.ok(html.includes('id="' + id + '"'), id + ' is still there: Legion replaces none of them (Anthony 2026-11-11: keep both tabs)');
  assert.match(ws, /startBot\(\); startAgent\(\); startLeague\(\); startFleet\(\);/);
  assert.strictEqual((ws.match(/fleetView && fleetView\.shown\(\)\) fleetView\.showTab\(false\);/g) || []).length, 5, 'closed by each other tab, a layout tab and a layout change: one view at a time');
  assert.match(ws, /tabUrl\(on \? 'legion' : ''\);/); assert.match(ws, /\.get\('tab'\) === 'legion'\) fleetView\.showTab\(true\);/);
  // N5: the tab is not handed the feed. Its connection is built here and run: it passes what FleetCore.maySend passes and nothing else
  /* the review of 94, note 5: the gate is captured once from a frozen FleetCore, never read from an open object at each post */
  assert.match(ws, /const legionGate = window\.FleetCore && Object\.isFrozen\(window\.FleetCore\) \? window\.FleetCore\.maySend : null;\n/);
  const m = /const legionLink = AF && legionGate \? (\{[^\n]*\}) : null;\n/.exec(ws);
  assert.ok(m, 'the tab\'s own connection is one line in workspace.js');
  assert.match(ws, /tab: \$\('wsFleetTab'\), v3: legionLink, realClick: OT\.realClick, headers:/, 'and it is what the tab gets, not AF');
  const posted = [], heard = [];
  const AF = { listen: part => { heard.push(part); return () => {}; }, post: x => { posted.push(x); return true; }, send: () => { throw new Error('send reached'); }, sendOrder: () => { throw new Error('sendOrder reached'); } };
  const link = new Function('AF', 'legionGate', 'return ' + m[1])(AF, F.maySend);
  assert.deepStrictEqual(Object.keys(link).sort(), ['listen', 'post'], 'two things only: no send, no sendOrder');
  assert.strictEqual(link.post({ type: 'agentKillAllProp', cid: 'c1' }), true);
  assert.strictEqual(link.post({ type: 'agentKillAllProp' }), true);
  const good = [{ type: 'agentMode', cid: 'c2', agent: 'legion1', mode: 'auto', pick: 'germanicus_r115.json', pickSha: 'a'.repeat(64) }, { type: 'agentMode', agent: 'legion1', mode: 'shadow' }, { type: 'agentPick', cid: 'c3', agent: 'legion1', file: 'germanicus_r115.json' }, { type: 'agentPick', agent: 'legion1', file: null }];
  for (const ok of good) assert.strictEqual(link.post(ok), true, JSON.stringify(ok));
  for (const bad of [{ type: 'agentMode', cid: 'c2', agent: 'legion1', mode: 'auto' } /* a bare Auto (the re-review of 94, N4) */, { type: 'agentMode', agent: 'x', mode: 'copilot' }, { type: 'agentMode', agent: 'x', mode: 'auto', account: 'A' }, { type: 'agentMode', agent: 'Not An Id', mode: 'auto' }, { type: 'agentMode', mode: 'auto' },
    { type: 'agentPick', agent: 'x' }, { type: 'agentPick', agent: 'x', file: '../x.json' }, { type: 'agentPick', agent: 'x', file: 'x.txt' }, { type: 'agentPick', agent: 'x', file: 7 }, { type: 'agentPick', agent: 'x', file: null, group: 'g1' },
    { type: 'order' }, { type: 'flatten' }, { type: 'agentKill', agent: 'x', on: false }, { type: 'agentKillAllProp', cid: 'c', account: 'A' }, { type: 'agentKillAllProp', cid: 7 }, { type: 'agentKillAllProp', cid: '' }, { type: 'accountPersonal' },
    { type: 'agentAccount', agent: 'x', group: 'g1' }, { type: 'agentRules', agent: 'x' }, { type: 'accountGroup', account: 'A', group: 'g1' }, { cid: 'c' }, null, 'agentKillAllProp', []])
    assert.strictEqual(link.post(bad), false, JSON.stringify(bad) + ' is not passed on');
  assert.deepStrictEqual(posted, [{ type: 'agentKillAllProp', cid: 'c1' }, { type: 'agentKillAllProp' }].concat(good));
  const cs = read('nt8', 'ChartBridgeAgents.cs');
  assert.match(cs, /\{ "agentPick", new\[\] \{ "type", "cid", "agent", "file" \} \},/, 'ChartBridge takes exactly these keys for the pick');
  assert.match(cs, /\{ "agentMode", new\[\] \{ "type", "cid", "agent", "mode", "pick", "pickSha" \} \},/, 'and these for the mode (0.6.21: Auto names its pick)');
  link.listen('part'); assert.deepStrictEqual(heard, ['part']);
  assert.strictEqual(link.post.call({ post: () => true }, { type: 'order' }), false);
  // with no feed at all (accounts.js not served) the tab gets no connection and nothing is called on a null (the second look, FIX A)
  assert.strictEqual(new Function('AF', 'legionGate', 'return AF && legionGate ? ' + m[1] + ' : null')(null, F.maySend), null);
  assert.strictEqual(new Function('AF', 'legionGate', 'return AF && legionGate ? ' + m[1] + ' : null')(AF, null), null, 'and with fleet.js not served');
  // the tab's own file: no browser dialog, nothing stored, no other connection, no long dashes
  const viewSrc = src.slice(src.indexOf('the tab (browser only)'));
  assert.ok(!/confirm\(|alert\(|prompt\(/.test(src), 'no browser dialog');
  assert.ok(!/localStorage|sessionStorage|XMLHttpRequest|WebSocket\(|setInterval\(/.test(viewSrc), 'nothing stored, no other connection, nothing on an interval');
  assert.ok(!/[\u2013\u2014]/.test(src + read('live', 'fleet.css')), 'no long dashes');
});


/* ---------------------------------------------------------------- the roster (GET /roster, ChartBridge 0.6.20) */
const scored = over => Object.assign({ plan: { size: '50K', dll: true },
  playbook: { eval: { risk_dollars: 400, daily_loss_stop: 800, daily_profit_stop: 1200, max_trades: 1 }, funded: { risk_dollars: 250, daily_loss_stop: null, daily_profit_stop: null, max_trades: null, payout_at: 1500 } },
  numbers: { eval: { profit_per_dollar: 0.62, range95: [0.32, 0.92], no_edge: { median: 0.05, p5: -0.4, p95: 0.35 }, above_no_edge: true, not_searched_on: 0.2, eval_pass: 0.58, sessions_to_pass: 9 },
    funded: { profit_per_dollar: -0.1, range95: [-0.4, 0.2], no_edge: { median: 0.02, p5: -0.3, p95: 0.3 }, above_no_edge: false, not_searched_on: null, paid_per_funded: 1830.5, share_paid: 0.41, sessions_to_first_payout: null } },
  other_settings: { eval: [], funded: [] }, counts: {} }, over || {});
const botFile = (bot, over) => Object.assign({ format: 'specrunner.roster/1', bot, spec: { file: bot + '.json', sha256: 'a'.repeat(64) }, runs_live: true, why_not: null,
  record: { run_id: 'run-7', family: 'fam', try: 3, sessions: 240, trades: 198, instrument: 'MNQ', verdict: 'made-up verdict' } }, scored(), over || {});
const member = (bot, over) => Object.assign({ bot, spec: { file: bot + '.json', sha256: 'b'.repeat(64) }, runs_live: true, why_not: null, record: { run_id: 'run-' + bot, family: 'fam', try: 2, sessions: 200, trades: 1, instrument: 'MNQ', verdict: 'v' },
  taken: 90, skipped: 4, sessions_left_out: 0 }, over || {});
const lineupFile = (name, bots, over) => Object.assign({ format: 'specrunner.lineup/1', lineup: name, bots, runs_live: bots.every(b => b.runs_live), joined: { sessions: 190, trades: 180, skipped: 8 } }, scored(), over || {});
const served = (name, roster) => ({ name, ok: true, roster, sha256: require('node:crypto').createHash('sha256').update(name).digest('hex') });   // 0.6.21: each file's sha256 (made up here)
const shaOfName = name => require('node:crypto').createHash('sha256').update(name).digest('hex');

test('roster: a bot\'s card: whether it runs live, its run, in-sample and its try count, each stage\'s numbers beside the no-edge range', () => {
  const got = F.rosterCards({ files: [served('zeta.json', botFile('zeta')), served('alpha.json', botFile('alpha', { runs_live: false, why_not: 'more than one trade a session' }))], left: 0 });
  assert.deepStrictEqual([got.ok, got.why, got.lineups, got.notShown, got.left], [true, '', [], [], 0]);
  assert.deepStrictEqual(got.bots.map(c => c.name), ['alpha', 'zeta'], 'by name');
  const z = got.bots[1], a = got.bots[0];
  assert.deepStrictEqual([z.kind, z.file, z.runsLive, z.whyNot, z.quick, z.planText], ['bot', 'zeta.json', true, '', false, '50K with the daily loss limit']);
  assert.deepStrictEqual([z.recordText, z.evidenceText, z.verdictText], ['Run run-7: 240 sessions, 198 trades, MNQ', 'In-sample, not confirmed; try 3', "The run's own per-trade verdict (in-sample): made-up verdict"]);
  assert.deepStrictEqual([a.runsLive, a.whyNot], [false, 'more than one trade a session']);
  const [ev, fu] = z.stages;
  assert.deepStrictEqual([ev.stage, ev.title, ev.risk, ev.dayLoss, ev.dayProfit, ev.maxTrades, ev.payoutAt, ev.aboveNoEdge], ['eval', 'Eval', 400, 800, 1200, 1, null, true]);
  assert.strictEqual(ev.profitText, 'Profit per $1: +0.62 (95%: +0.32 to +0.92)');
  assert.strictEqual(ev.noEdgeText, 'No edge would show +0.05 (5th to 95th: -0.40 to +0.35)');
  assert.deepStrictEqual([ev.edgeText, ev.heldBackText, ev.stageText], ['Above no edge', 'On the sessions not searched: +0.20', 'Passes 58% of evals, in 9 sessions (median)']);
  assert.strictEqual(ev.playbookText, 'Risk $400 a trade; day loss stop $800; day profit stop $1,200; at most 1 trade a day');
  assert.strictEqual(fu.profitText, 'Profit per $1: -0.10 (95%: -0.40 to +0.20)', 'a losing number is shown as it is');
  assert.deepStrictEqual([fu.edgeText, fu.heldBackText], ['Not above no edge', 'On the sessions not searched: none were held back']);
  assert.strictEqual(fu.stageText, 'Paid $1,830.50 per funded account; 41% reach a payout', 'no median when the file has none');
  assert.strictEqual(fu.playbookText, 'Risk $250 a trade; day loss stop none; day profit stop none; no cap on trades a day; payout at $1,500');
  // above_no_edge is the file's own word, never worked out again here, and never read as true from anything but true
  assert.strictEqual(F.stageCard(scored({ numbers: Object.assign({}, scored().numbers, { eval: Object.assign({}, scored().numbers.eval, { above_no_edge: 'yes' }) }) }), 'eval'), null);
  // a positive number the file says is NOT above no edge stays "Not above": the tab never works the mark out from the number
  const pos = scored(); pos.numbers.eval = Object.assign({}, pos.numbers.eval, { profit_per_dollar: 0.9, above_no_edge: false });
  assert.deepStrictEqual([F.stageCard(pos, 'eval').aboveNoEdge, F.stageCard(pos, 'eval').edgeText], [false, 'Not above no edge']);
  // a quick file says so; a file with no try count says that, never a number
  const q = F.rosterCards({ files: [served('q.json', botFile('q', { counts: { quick: true }, record: { run_id: 'r', sessions: 1, trades: 1 } }))] }).bots[0];
  assert.deepStrictEqual([q.quick, q.runsLive, q.evidenceText, q.recordText], [true, false, 'In-sample, not confirmed; try count not known', 'Run r: 1 session, 1 trade']);
  assert.deepStrictEqual([F.signed(0), F.signed(0.004), F.signed(-0.005), F.signed(null), F.signed('1')], ['0.00', '+0.00', '-0.01', '', '']);
});

test('roster: a lineup\'s card: its bots in the file\'s order, live only when the file says so and every bot is, its joined record', () => {
  const pair = lineupFile('pair', [member('second-listed-first'), member('alpha', { runs_live: false, why_not: 'a level trigger', skipped: 9, sessions_left_out: 12 })]);
  const got = F.rosterCards({ files: [served('pair.json', pair), served('ok.json', lineupFile('ok', [member('a'), member('b')])),
    served('lying.json', lineupFile('lying', [member('a'), member('b', { runs_live: false, why_not: 'x' })], { runs_live: true })),
    served('held.json', lineupFile('held', [member('a'), member('b')], { runs_live: false }))], left: 3 });
  assert.deepStrictEqual(got.lineups.map(c => c.name), ['held', 'lying', 'ok', 'pair']);
  const c = Object.fromEntries(got.lineups.map(x => [x.name, x]));
  assert.deepStrictEqual(c.pair.bots.map(b => b.name), ['second-listed-first', 'alpha'], 'the lineup\'s order is kept: the first listed takes a tie');
  assert.deepStrictEqual([c.pair.runsLive, c.pair.whyNot], [false, 'alpha: a level trigger']);
  assert.deepStrictEqual([c.pair.bots[1].taken, c.pair.bots[1].skipped, c.pair.bots[1].sessionsLeftOut], [90, 9, 12]);
  assert.strictEqual(c.pair.joinedText, "190 sessions in common, 180 trades taken, 8 skipped because another bot's trade was open");
  assert.strictEqual(c.pair.evidenceText, 'In-sample, not confirmed; tries: second-listed-first 2, alpha 2');
  assert.deepStrictEqual([c.ok.runsLive, c.ok.whyNot], [true, '']);
  assert.deepStrictEqual([c.lying.runsLive, c.lying.whyNot], [false, 'b: x'], 'a file that says live with a bot that is not: not live');
  assert.deepStrictEqual([c.held.runsLive, c.held.whyNot], [false, 'the file says the lineup does not run live']);
  assert.strictEqual(got.left, 3);
});

test('roster: a file the tab cannot show whole is listed with why, never half shown; an answer that is not a list is refused', () => {
  const bad = (name, roster) => served(name, roster);
  const noNumbers = botFile('n'); delete noNumbers.numbers;
  const got = F.rosterCards({ files: [
    { name: 'broken.json', ok: false, why: 'not valid JSON' }, { name: 'silent.json', ok: false },
    bad('other.json', { format: 'specrunner.roster/2' }), bad('arr.json', []), bad('nonum.json', noNumbers),
    bad('norisk.json', botFile('r', { playbook: { eval: { risk_dollars: 0 }, funded: scored().playbook.funded } })),
    bad('noname.json', botFile('bad name')), bad('norun.json', botFile('x', { record: {} })), bad('nolive.json', botFile('y', { runs_live: 'yes' })),
    bad('one.json', lineupFile('one', [member('a')])), bad('badbot.json', lineupFile('bb', [member('a'), { bot: 'b' }])),
    'not an entry', { ok: true }, served('good.json', botFile('good'))] });
  assert.deepStrictEqual(got.bots.map(b => b.name), ['good']);
  assert.deepStrictEqual(got.lineups, []);
  assert.deepStrictEqual(got.notShown.map(x => x.name + ': ' + x.why), [
    'broken.json: not valid JSON', 'silent.json: ChartBridge did not serve it', 'other.json: not a roster file this tab knows', 'arr.json: not a roster file this tab knows',
    "nonum.json: its playbook or its numbers are not in the format's shape", "norisk.json: its playbook or its numbers are not in the format's shape",
    "noname.json: its bot, its run or whether it runs live is not in the format's shape", "norun.json: its bot, its run or whether it runs live is not in the format's shape",
    "nolive.json: its bot, its run or whether it runs live is not in the format's shape", "one.json: its name or its bots are not in the format's shape", "badbot.json: its name or its bots are not in the format's shape"]);
  // the review of 92, FIX 1: only null means none. One wrong-typed value a file: each is NOT shown, never a card with a plain
  // statement in its place ("day loss stop none", "no cap on trades a day", "none were held back", the range left off)
  const withPb = (stage, k, v) => { const d = botFile('w'); d.playbook = JSON.parse(JSON.stringify(d.playbook)); if (v === undefined) delete d.playbook[stage][k]; else d.playbook[stage][k] = v; return d; };
  const withNum = (stage, k, v) => { const d = botFile('w'); d.numbers = JSON.parse(JSON.stringify(d.numbers)); if (v === undefined) delete d.numbers[stage][k]; else d.numbers[stage][k] = v; return d; };
  const wrong = [
    withPb('eval', 'daily_loss_stop', '800'), withPb('eval', 'daily_loss_stop', -800), withPb('eval', 'daily_loss_stop', 0), withPb('eval', 'daily_loss_stop', undefined), withPb('eval', 'daily_loss_stop', false),
    withPb('eval', 'daily_profit_stop', '1200'), withPb('eval', 'max_trades', '1'), withPb('eval', 'max_trades', 1.5), withPb('eval', 'max_trades', 0), withPb('funded', 'payout_at', '1500'), withPb('funded', 'payout_at', undefined),
    withNum('eval', 'not_searched_on', '0.2'), withNum('eval', 'not_searched_on', undefined), withNum('eval', 'range95', undefined), withNum('eval', 'range95', ['0.3', 0.9]), withNum('eval', 'range95', [0.92, 0.32]), withNum('eval', 'range95', [0.3]),
    withNum('eval', 'no_edge', { median: 0, p5: 0.4, p95: -0.4 }), withNum('eval', 'eval_pass', 58), withNum('eval', 'eval_pass', -0.2), withNum('eval', 'eval_pass', '0.58'), withNum('eval', 'sessions_to_pass', -3.7), withNum('eval', 'sessions_to_pass', undefined),
    withNum('funded', 'share_paid', 1.2), withNum('funded', 'paid_per_funded', '1830'), withNum('funded', 'sessions_to_first_payout', 0),
    botFile('w', { runs_live: true, why_not: 'said, though it runs' }), botFile('w', { runs_live: false, why_not: null }), botFile('w', { runs_live: false, why_not: '' }), botFile('w', { counts: null }),
    lineupFile('twice', [member('a'), member('a')]), lineupFile('nocount', [member('a'), member('b', { taken: '90' })]), lineupFile('nojoin', [member('a'), member('b')], { joined: { sessions: 190, trades: '180', skipped: 8 } })];
  wrong.forEach((d, i) => { const got = F.rosterCards({ files: [served('w' + i + '.json', d)] }); assert.deepStrictEqual([got.bots.length, got.lineups.length, got.notShown.length], [0, 0, 1], 'wrong-typed file ' + i + ' is not shown: ' + JSON.stringify(got.notShown)); });
  // the same values right are shown (so the list above fails for the value, not for the fixture)
  for (const d of [withPb('eval', 'daily_loss_stop', null), withPb('eval', 'max_trades', 3), withNum('eval', 'not_searched_on', null), withNum('eval', 'eval_pass', 0), withNum('eval', 'eval_pass', 1), withNum('eval', 'sessions_to_pass', null)])
    assert.strictEqual(F.rosterCards({ files: [served('r.json', d)] }).bots.length, 1);
  assert.strictEqual(F.stageCard(withNum('eval', 'eval_pass', 0.996), 'eval').stageText, 'Passes 99.6% of evals, in 9 sessions (median)', 'never rounded up to 100%');
  // two files that name one bot: neither is shown, and the list says which files
  const two = F.rosterCards({ files: [served('a.json', botFile('same')), served('b.json', botFile('same')), served('c.json', botFile('other'))] });
  assert.deepStrictEqual([two.bots.map(b => b.name + ' ' + b.file), two.notShown.map(x => x.name)], [['other c.json'], ['a.json', 'b.json']]);
  assert.match(two.notShown[0].why, /2 files name the bot same \(a\.json, b\.json\)/);
  // a quick file (any truthy mark, as Bot-Lab's lines() takes it) never reads "Runs live"
  for (const q of [true, 'true', 1]) { const c = F.rosterCards({ files: [served('q.json', botFile('q', { counts: { quick: q } }))] }).bots[0]; assert.deepStrictEqual([c.quick, c.runsLive], [true, false]); assert.match(c.whyNot, /built with --quick/); }
  const ql = F.rosterCards({ files: [served('ql.json', lineupFile('ql', [member('a'), member('b')], { counts: { quick: 'yes' } }))] }).lineups[0];
  assert.deepStrictEqual([ql.quick, ql.runsLive], [true, false]);
  // the free-text verdict is labelled as the run's own, in-sample (FIX 2)
  assert.strictEqual(F.rosterCards({ files: [served('v.json', botFile('v', { record: { run_id: 'r', sessions: 2, trades: 2, try: 1, verdict: 'CONFIRMED on the locked weeks: proven edge' } }))] }).bots[0].verdictText,
    "The run's own per-trade verdict (in-sample): CONFIRMED on the locked weeks: proven edge");
  for (const body of [null, [], {}, { files: 'x' }, 'text']) assert.deepStrictEqual([F.rosterCards(body).ok, F.rosterCards(body).why], [false, "ChartBridge's answer is not a roster list"]);
  assert.deepStrictEqual(F.rosterCards({ files: [] }), { ok: true, why: '', bots: [], lineups: [], notShown: [], left: 0 });
});

test('roster: why it is not shown, by ChartBridge\'s answer; the format names are Bot-Lab\'s and ChartBridge\'s', () => {
  assert.match(F.rosterProblem(404), /^No roster folder is set on this PC\. It is one line in ChartBridge's config\.txt \(rosterFolder\)/);
  assert.match(F.rosterProblem(403), /only to a page opened by the localhost name/);
  assert.strictEqual(F.rosterProblem(500, 'the roster folder named in config.txt is not there'), 'ChartBridge could not read the roster folder: the roster folder named in config.txt is not there.');
  assert.strictEqual(F.rosterProblem(500), 'ChartBridge could not read the roster folder.');
  assert.match(F.rosterProblem(0), /ChartBridge did not answer/);
  assert.strictEqual(F.rosterProblem(502), 'ChartBridge answered 502 for the roster.');
  assert.match(F.rosterProblem('late'), /did not answer the roster request in 10 seconds/);
  assert.match(F.rosterProblem('notjson'), /something that is not JSON/);
  assert.deepStrictEqual([F.ROSTER_MIN, F.ROSTER_FORMAT, F.LINEUP_FORMAT], ['0.6.20', 'specrunner.roster/1', 'specrunner.lineup/1']);
  const cs = read('nt8', 'ChartBridgeAgents.cs');
  assert.ok(cs.includes('specrunner\\\\.(roster|lineup)/1') || (cs.includes('specrunner.roster/1') && cs.includes('specrunner.lineup/1')), 'ChartBridge serves exactly these two formats');
  assert.match(cs, /if \(ctx\.Request\.Headers\["Host"\] != "localhost:" \+ ChartBridgeConfig\.Port\) \{ Answer\(ctx, 403\); return; \}/, 'the 403 the tab explains');
  assert.match(cs, /if \(json == null && why == null\) \{ Answer\(ctx, 404\); return; \}/, 'the 404 the tab explains');
});


/* ---------------------------------------------------------------- the tab itself, on a stand-in page (no browser) */
/* The view half of fleet.js runs against a small stand-in for the page: enough to build the tab once, read what each part
   holds and click its buttons. The clock is the test's (o.now), the timers are node:test's. What needs a real browser (where
   a double click lands, a press and a release around a message, colours, injected markup) is in test/fleet-smoke.mjs. */
function page(t, over, opt) {
  const parts = new Map(), listeners = {};
  const mk = sel => {
    const e = { sel, textContent: '', innerHTML: '', hidden: false, attrs: {}, style: {}, cls: new Set(), focused: 0,
      setAttribute(k, v) { e.attrs[k] = String(v); }, removeAttribute(k) { delete e.attrs[k]; }, getAttribute: k => (k in e.attrs ? e.attrs[k] : null),
      getBoundingClientRect: () => ({ width: 157 }), focus() { e.focused++; } };
    e.classList = { toggle: (c, on) => { if (on) e.cls.add(c); else e.cls.delete(c); }, contains: c => e.cls.has(c) };
    return e;
  };
  const view = Object.assign(mk('view'), { addEventListener: (k, f) => { listeners[k] = f; }, removeEventListener() {}, querySelector: sel => { if (!parts.has(sel)) parts.set(sel, mk(sel)); return parts.get(sel); } });
  const tab = Object.assign(mk('tab'), { hidden: true, addEventListener() {} });
  const win = { document: {} };
  if (!(opt && opt.noAgentCore)) new Function('window', 'document', 'self', read('live', 'agent-core.js'))(win, win.document, win);   // the page's mode rules (Legion reuses them)
  new Function('window', 'document', 'self', read('live', 'fleet.js'))(win, win.document, win);
  const P = { T: 1_800_000_000_000, posts: [], asks: [], answers: [], subs: null, view, tab, part: k => view.querySelector('[data-k="' + k + '"]') };
  const V3 = { listen: h => { P.subs = h; return () => {}; }, post: m => { P.posts.push(m); return P.postOk !== false; } };
  P.key = key => listeners.keydown({ key, preventDefault() {} });
  P.fv = win.FleetView.create(Object.assign({ view, tab, v3: V3, settleMs: 0, realClick: require('../live/order-ticket.js').realClick, now: () => P.T, fetch: (u, o) => { P.asks.push([u, o]); return new Promise((res, rej) => P.answers.push({ res, rej })); } }, over || {}));
  P.feed = m => P.subs.message(m);
  P.click = (what, detail, card) => listeners.click({ target: { closest: () => ({ dataset: { do: what, card } }) }, detail: detail === undefined ? 1 : detail });
  P.html = () => view.innerHTML + ['lanes', 'lane-eval', 'lane-funded', 'roster', 'traders', 'accounts'].map(k => P.part(k).innerHTML).join('');
  P.change = (agentId, value) => listeners.change({ target: { dataset: { do: 'pick', agent: agentId }, value } });
  P.ready = v => { P.feed({ type: 'hello', version: v || '0.6.20' }); P.feed({ type: 'trading', enabled: true }); P.feed(accounts); P.feed(groups); P.feed(agent('germanicus')); P.replayDone(); };
  P.replayDone = () => P.feed({ type: 'agentStandDowns', list: [] });   // ChartBridge sends it after the sign-in replay (S1)
  P.tick = () => new Promise(r => setImmediate(r));
  t.after(() => P.fv.destroy());
  return P;
}
const timers = t => t.mock.timers.enable({ apis: ['setTimeout'] });

test('the question: Yes is not taken in the first moment, from a double click, with no question up, or after 8 seconds by the clock; then it sends one message', t => {
  timers(t);
  const P = page(t); P.fv.showTab(true); P.ready();
  P.click('yes');
  assert.deepStrictEqual([P.posts, P.fv.state().asking], [[], false], 'Yes with no question up sends nothing');
  P.click('ask');
  assert.deepStrictEqual([P.fv.state().asking, P.part('ask').hidden, P.part('kill').hidden, P.posts], [true, false, true, []], 'the first click asks and sends nothing');
  assert.strictEqual(view_focus(P), 1, 'the focus goes to Cancel');
  assert.strictEqual(P.view.querySelector('[data-do="no"]').style.minWidth, '157px', 'Cancel takes the room the button had');
  P.T += 100; P.click('yes');
  assert.deepStrictEqual([P.posts, P.fv.state().asking], [[], true], 'Yes 100 ms after the question opened: no answer, the question stays');
  assert.match(P.part('hint').textContent, /^Too soon: read the question, then click Yes\.$/, 'and the tab says why nothing happened');
  P.click('yes', 2); P.click('no', 2);
  assert.deepStrictEqual([P.posts, P.fv.state().asking], [[], true], 'the second click of the double click that opened it: on Yes or on Cancel, no answer');
  P.T += 499; P.click('yes');
  assert.deepStrictEqual(P.posts, [], 'and at 599 ms');
  P.T += 1; P.click('yes', 3);
  assert.strictEqual(P.posts.length, 1, 'at 600 ms a real click on Yes counts, whatever its click count (the second look, FIX B)');
  assert.deepStrictEqual([Object.keys(P.posts[0]).sort(), P.posts[0].type, typeof P.posts[0].cid, P.fv.state().asking], [['cid', 'type'], 'agentKillAllProp', 'string', false]);
  P.click('yes'); P.click('yes');
  assert.strictEqual(P.posts.length, 1, 'Yes on the old question sends nothing more');
  // a person in a hurry: Yes clicked again and again from the moment the question opens, the browser counting each as part of
  // a multiple click: it sends once, at the first click from 600 ms on
  for (const gap of [150, 250, 400]) {
    const before = P.posts.length, t0 = P.T;
    P.click('ask');
    let sentAt = null;
    for (let n = 1; n <= 20 && sentAt === null; n++) { P.T += gap; P.click('yes', n + 1); if (P.posts.length > before) sentAt = P.T - t0; }
    assert.strictEqual(P.posts.length, before + 1, 'every ' + gap + ' ms: sent once');
    assert.ok(sentAt >= F.ARM_MS && sentAt < F.ARM_MS + gap, 'every ' + gap + ' ms: at the first click from 600 ms on (' + sentAt + ' ms)');
    for (let n = 0; n < 5; n++) { P.T += gap; P.click('yes', 9); }
    assert.strictEqual(P.posts.length, before + 1, 'and the clicks after it send nothing more');
  }
  P.posts.length = 1;
  // the 8 seconds are compared at the Yes: with the timer held back (a window in the background, a PC that slept) Yes is too late
  P.click('ask'); P.T += F.CONFIRM_MS + 1; P.click('yes');
  assert.deepStrictEqual([P.posts.length, P.fv.state().asking], [1, false], 'Yes after 8 seconds by the clock: nothing sent, the question gone');
  // and the timer alone ends it
  P.click('ask'); assert.strictEqual(P.fv.state().asking, true);
  t.mock.timers.tick(F.CONFIRM_MS + 1);
  assert.deepStrictEqual([P.fv.state().asking, P.part('ask').hidden, P.part('kill').hidden], [false, true, false], 'the question times out by itself');
  // Cancel, whatever its click count once the first moment is over
  P.click('ask'); P.T += 700; P.click('no', 2);
  assert.deepStrictEqual([P.fv.state().asking, P.posts.length], [false, 1]);
});
function view_focus(P) { return P.view.querySelector('[data-do="no"]').focused; }

test('the question: everything is checked again at the Yes; closing the tab or a lost connection ends it; nothing is ever sent by itself', t => {
  timers(t);
  const P = page(t); P.fv.showTab(true); P.ready();
  P.click('ask'); P.T += 700;
  P.feed({ type: 'trading', enabled: false });                    // signed out while the question is up
  P.click('yes');
  assert.deepStrictEqual([P.posts, P.fv.state().asking], [[], false]);
  assert.match(P.part('hint').textContent, /Sign in to trading first/);
  assert.ok(P.part('hint').cls.has('bad'));
  P.feed({ type: 'trading', enabled: true });
  assert.doesNotMatch(P.part('hint').textContent, /Sign in/, 'the reason goes as soon as it is no longer true');
  P.click('ask'); P.T += 700;
  P.feed(Object.assign({}, accounts, { personalNamed: false }));  // the personal pick taken away
  P.click('yes');
  assert.deepStrictEqual(P.posts, []);
  assert.match(P.part('hint').textContent, /No personal account is picked yet/);
  P.feed(accounts);
  // not offered: a click on the button says why and asks nothing
  P.feed({ type: 'trading', enabled: false });
  assert.strictEqual(P.part('kill').attrs['aria-disabled'], 'true');
  P.click('ask');
  assert.deepStrictEqual([P.fv.state().asking, P.posts], [false, []]);
  P.feed({ type: 'trading', enabled: true });
  assert.strictEqual(P.part('kill').attrs['aria-disabled'], undefined);
  // the tab closed with the question up: no question when it opens again
  P.click('ask'); P.fv.showTab(false); P.fv.showTab(true);
  assert.deepStrictEqual([P.fv.state().asking, P.part('ask').hidden], [false, true]);
  // a lost connection ends it
  P.click('ask'); P.subs.closed();
  assert.strictEqual(P.fv.state().asking, false);
  // a session of every kind of message, hellos and reconnects: nothing is posted by itself (no replay)
  P.ready(); P.click('ask'); P.T += 700; P.click('yes');
  assert.strictEqual(P.posts.length, 1);
  // while that Kill all is still waiting for its answer: a hello, twice, and every other message post nothing (the second look, D4)
  assert.strictEqual(P.fv.state().pending, true);
  P.feed({ type: 'hello', version: '0.6.20' }); P.feed({ type: 'hello', version: '0.6.20' }); P.feed({ type: 'trading', enabled: true }); P.feed(accounts); P.feed(agent('germanicus'));
  assert.deepStrictEqual([P.posts.length, P.fv.state().pending], [1, true], 'a hello while a Kill all is pending sends nothing');
  for (let i = 0; i < 5; i++) { P.subs.closed(); P.ready(); P.feed({ type: 'status', level: 'info', text: 'anything' }); P.feed({ type: 'reject', cid: 'other', reason: 'x' }); }
  t.mock.timers.tick(120_000);
  assert.strictEqual(P.posts.length, 1, 'Kill all is never sent again by a hello, a reconnect or a timer');
});

test('Kill all is there and works whatever the roster does: a 404, a 500, an answer that never comes, a broken body', async t => {
  timers(t);
  for (const answer of [{ status: 404 }, { status: 500, json: () => Promise.resolve({ error: 'x' }) }, null, { status: 200, json: () => Promise.reject(new Error('bad')) }, { status: 200, json: () => Promise.resolve('junk') }]) {
    const P = page(t); P.fv.showTab(true); P.ready();
    await P.tick();
    assert.strictEqual(P.asks.length, 1);
    if (answer) P.answers[0].res(answer);
    await P.tick(); await P.tick();
    assert.deepStrictEqual([P.part('kill').hidden, P.part('kill').attrs['aria-disabled']], [false, undefined], 'the button is there and offered');
    P.click('ask'); P.T += 700; P.click('yes');
    assert.deepStrictEqual(P.posts.map(m => m.type), ['agentKillAllProp']);
  }
});

test("ChartBridge's answer: its time in front, marked bad when something was NOT stopped, kept until the next one; a kill never answered is never forgotten", t => {
  timers(t);
  const P = page(t); P.fv.showTab(true); P.ready();
  const kill = () => { P.click('ask'); P.T += 700; P.click('yes'); };
  const A = () => [P.part('answer').textContent.replace(/^\d\d:\d\d:\d\d {2}/, 'HH:MM:SS  '), P.part('answer').cls.has('bad'), P.part('answer').hidden];
  assert.deepStrictEqual(A(), ['', false, true], 'no answer line before any Kill all');
  kill();
  assert.match(P.part('answer').textContent, /^\d\d:\d\d:\d\d {2}Kill all sent: waiting for ChartBridge's answer$/, 'sent: it claims nothing is stopped');
  P.feed({ type: 'status', level: 'warn', text: 'Kill all (prop accounts): agent germanicus on EVAL-A: flattening what it owns, the kill switch on, mode shadow' });
  assert.deepStrictEqual(A(), ['HH:MM:SS  Kill all (prop accounts): agent germanicus on EVAL-A: flattening what it owns, the kill switch on, mode shadow', false, false]);
  for (const bad of ['Kill all (prop accounts): agent a: stopped. Agent b: NOT STOPPED, still trading its prop accounts', 'Kill all (prop accounts): agent a FAILED, stop it on the Agent tab now: x', 'Kill all (prop accounts): the saved Auto could NOT be removed']) {
    kill(); P.feed({ type: 'status', level: 'warn', text: bad });
    assert.deepStrictEqual(A(), ['HH:MM:SS  ' + bad, true, false], 'ChartBridge sends these as warn: the tab marks them bad itself');
  }
  // kept: a new question and Cancel do not erase it, nor closing and opening the tab
  P.click('ask'); P.T += 700; P.click('no');
  assert.strictEqual(A()[1], true);
  P.fv.showTab(false); P.fv.showTab(true);
  assert.match(A()[0], /could NOT be removed/);
  // a refusal
  kill(); P.feed({ type: 'reject', cid: P.posts[P.posts.length - 1].cid, reason: 'this connection may not trade' });
  assert.deepStrictEqual(A(), ['HH:MM:SS  ChartBridge refused Kill all: this connection may not trade', true, false]);
  // no answer in 5 seconds: said, marked bad; a late answer still replaces it
  kill(); P.T += F.ANSWER_WAIT_MS + 100; t.mock.timers.tick(F.ANSWER_WAIT_MS + 100);
  assert.deepStrictEqual(A(), ['HH:MM:SS  Kill all was sent and ChartBridge has not answered in 5 seconds: look in NinjaTrader now', true, false]);
  P.feed({ type: 'status', level: 'warn', text: 'Kill all (prop accounts): agent germanicus: stopped' });
  assert.deepStrictEqual(A(), ['HH:MM:SS  Kill all (prop accounts): agent germanicus: stopped', false, false]);
  // the same found at the next message when the timer is held back
  kill(); P.T += F.ANSWER_WAIT_MS + 100; P.feed(agent('germanicus'));
  assert.match(A()[0], /has not answered in 5 seconds/);
  // the connection drops before the answer: never "not connected" alone
  P.feed({ type: 'status', level: 'warn', text: 'Kill all (prop accounts): done' });
  kill(); P.subs.closed();
  assert.deepStrictEqual(A(), ["HH:MM:SS  Kill all was sent and ChartBridge's answer never came (the connection dropped): look in NinjaTrader now", true, false]);
  // it could not be sent at all
  P.ready(); P.postOk = false; kill();
  assert.match(A()[0], /Kill all could NOT be sent/); assert.strictEqual(A()[1], true);
  assert.strictEqual(F.badAnswer('all stopped'), false);
});

test('the roster is asked for when the tab opens, on a hello while it is open and on Read again: never on a timer or on any other message', async t => {
  timers(t);
  const P = page(t);
  P.fv.showTab(true);
  assert.strictEqual(P.asks.length, 0, 'not connected: nothing asked');
  P.feed({ type: 'hello', version: '0.6.19' });
  assert.deepStrictEqual([P.asks.length, P.fv.state().roster.state], [0, 'old'], 'an older ChartBridge is never asked');
  assert.match(P.part('roster').innerHTML, /The roster needs ChartBridge 0\.6\.20 or later \(this one is 0\.6\.19\)/);
  P.feed({ type: 'hello', version: '0.6.20' }); P.feed({ type: 'hello', version: '0.6.20' });
  await P.tick();
  assert.deepStrictEqual([P.asks.length, P.asks[0][0], P.asks[0][1].cache, Object.keys(P.asks[0][1]).sort(), P.fv.state().roster.state], [1, '/roster', 'no-store', ['cache', 'headers'], 'loading'], 'two hellos (the page hands it over twice): one plain GET');
  P.fv.reloadRoster(); await P.tick();
  assert.strictEqual(P.asks.length, 2);
  P.answers[0].res({ status: 200, json: () => Promise.resolve({ files: [served('late.json', botFile('late'))] }) }); await P.tick(); await P.tick();
  assert.deepStrictEqual(P.fv.state().roster.bots, [], 'the answer of the older ask is dropped');
  P.answers[1].res({ status: 200, json: () => Promise.resolve({ files: [served('now.json', botFile('now', { counts: { quick: true } }))] }) }); await P.tick(); await P.tick();
  assert.deepStrictEqual([P.fv.state().roster.state, P.fv.state().roster.bots], ['ok', ['now']]);
  assert.match(P.part('roster').innerHTML, /data-name="now"/);
  assert.match(P.part('roster').innerHTML, /Quick look: never traded/, 'the quick mark is drawn on the card');
  assert.match(P.part('roster').innerHTML, /Does not run live/);
  assert.match(P.part('roster').innerHTML, /Every number is from in-sample runs, and none is a promise\./);
  assert.doesNotMatch(P.html(), /unless a card says confirmed/);
  // the second hello of a connect, right after the answer: no second ask (N1)
  P.feed({ type: 'hello', version: '0.6.20' }); await P.tick();
  assert.strictEqual(P.asks.length, 2);
  // every other kind of message, and two minutes: no ask, and the roster is not drawn again
  const drawn = P.fv.state().draws.roster;
  for (let i = 0; i < 40; i++) { P.feed(agent('germanicus', { owns: i % 2 === 0 })); P.feed(Object.assign({}, accounts, { n: i })); P.feed(groups); P.feed({ type: 'status', level: 'info', text: 's' + i }); P.feed({ type: 'trading', enabled: true }); }
  P.T += 120_000; t.mock.timers.tick(120_000);
  assert.deepStrictEqual([P.asks.length, P.fv.state().draws.roster], [2, drawn], 'no polling, and a trader\'s message never redraws the roster');
  assert.ok(P.fv.state().draws.traders > 30, 'while the traders are redrawn as they change');
  // a lost connection forgets the roster; the hello after it asks again
  P.subs.closed();
  assert.deepStrictEqual([P.fv.state().roster.state, P.fv.state().roster.bots], ['idle', []]);
  assert.doesNotMatch(P.part('roster').innerHTML, /data-name="now"/, 'connection lost: no stale roster');
  P.feed({ type: 'hello', version: '0.6.20' }); await P.tick();
  assert.strictEqual(P.asks.length, 3);
  // a 200 that is not a list, a body that is not JSON, and an ask never answered: each said as what it is; Read again works
  P.answers[2].res({ status: 200, json: () => Promise.resolve({ files: 'x' }) }); await P.tick(); await P.tick();
  assert.deepStrictEqual([P.fv.state().roster.state, P.fv.state().roster.text], ['error', "ChartBridge's answer is not a roster list."], 'never shown as an empty roster');
  P.click('roster'); await P.tick();
  P.answers[3].res({ status: 200, json: () => Promise.reject(new SyntaxError('x')) }); await P.tick(); await P.tick();
  assert.match(P.fv.state().roster.text, /something that is not JSON/);
  P.click('roster'); await P.tick();
  assert.strictEqual(P.fv.state().roster.state, 'loading');
  P.click('roster'); await P.tick();
  assert.strictEqual(P.asks.length, 5, 'Read again while reading asks nothing');
  P.T += F.ROSTER_WAIT_MS + 1; t.mock.timers.tick(F.ROSTER_WAIT_MS + 1);
  assert.deepStrictEqual([P.fv.state().roster.state, /did not answer the roster request in 10 seconds/.test(P.fv.state().roster.text)], ['error', true], 'an ask never answered is given up');
  P.click('roster'); await P.tick();
  assert.strictEqual(P.asks.length, 6, 'and Read again asks once more');
  assert.ok(P.asks.every(a => a[0] === '/roster'));
});

test('what the tab draws: one line a card with its detail behind Details; its buttons and nothing else to press; every string from a file or from ChartBridge as text', async t => {
  timers(t);
  const X = '<img src=x onerror=1>"\'&';
  const P = page(t); P.fv.showTab(true);
  P.feed({ type: 'hello', version: '0.6.21' }); P.feed({ type: 'trading', enabled: true });
  P.feed({ type: 'accounts', personalNamed: true, list: [{ name: 'A' + X, connection: X, prop: true, group: 'g1', pnlToday: 1, roomFloor: null, why: { roomFloor: X }, rules: { target: 3000, consistency: 40 }, positions: [{ root: X, qty: 1 }] }] });
  P.feed({ type: 'groups', list: [{ id: 'g1', name: X, accountType: 'eval' }] });
  P.feed(agent('t1', { name: X, build: X, account: 'A' + X, standDown: X, rules: { entryFrom: X, entryUntil: X, flatAt: X } }));
  P.feed(agent('t2', { name: X, account: null, group: { id: 'g1', name: X }, seats: [{ account: X }], standDown: X, pick: 'gone.json' }));
  const hostile = botFile('ok', { why_not: X, runs_live: false, record: { run_id: X, sessions: 1, trades: 1, try: 1, instrument: X, verdict: X }, plan: { size: X, dll: true } });
  const lu = lineupFile('lu', [member('a', { runs_live: false, why_not: X, record: { run_id: X, instrument: X } }), member('b')], { runs_live: false });
  await P.tick();
  P.answers[0].res({ status: 200, json: () => Promise.resolve({ left: 1, files: [served(X + '.json', hostile), served('lu.json', lu), { name: X, ok: false, why: X }, served('bad.json', { format: X })] }) });
  await P.tick(); await P.tick();
  // one line a card; the detail opens with Details and shuts with Hide (Anthony 2026-11-11), and stays open through messages
  const shut = P.part('roster').innerHTML;
  assert.ok(!shut.includes('fl-more"') && !shut.includes('Why not:') && (shut.match(/data-do="more"/g) || []).length === 2 && shut.includes('>Details<'), 'shut: the line only');
  assert.match(shut, /In-sample, not confirmed; try 1/, 'the line itself says in-sample and the try count');
  P.click('more', 1, 'bot:ok'); P.click('more', 1, 'lineup:lu');
  P.feed(agent('t1', { name: X, build: X, account: 'A' + X, standDown: X + '2', rules: {} }));
  assert.ok(P.part('roster').innerHTML.includes('fl-more"') && P.part('roster').innerHTML.includes('Why not:') && P.part('roster').innerHTML.includes('>Hide<'));
  P.click('more', 1, 'bot:ok');
  assert.strictEqual((P.part('roster').innerHTML.match(/class="fl-more"/g) || []).length, 1, 'Hide shuts that one');
  P.click('more', 1, 'bot:ok');
  P.click('ask'); P.T += 700; P.click('yes');
  P.feed({ type: 'status', level: 'warn', text: 'Kill all (prop accounts): ' + X });
  assert.strictEqual(P.posts.length, 1, 'Details sends nothing');
  const html = P.html();
  assert.ok(html.includes('&lt;img src=x onerror=1&gt;'), 'the hostile string is there, as text');
  assert.ok(!/<img|onerror=1>"/.test(html), 'and never as markup');
  assert.strictEqual(P.fv.state().roster.bots.length + P.fv.state().roster.lineups.length, 2);
  // ChartBridge's own lines go in as text (textContent), never through innerHTML
  assert.ok(P.part('answer').textContent.includes(X) && !P.part('answer').innerHTML);
  assert.ok(!P.part('hint').innerHTML && !P.part('autoline').innerHTML);
  // Kill all with its Yes and Cancel, the Armed switch with its Yes and Cancel, one pick list a lane that has a trader, Read
  // again and a Details on each card: nothing else can be pressed, typed in or switched
  const pressable = html.match(/<(button|input|select|textarea|a|details|summary)\b[^>]*>/g) || [];
  assert.deepStrictEqual(pressable.map(x => (/data-do="([a-z]+)"/.exec(x) || [])[1]).sort(), ['arm', 'armno', 'armyes', 'ask', 'more', 'more', 'no', 'pick', 'roster', 'yes'], pressable.join(' '));
  assert.ok(pressable.every(x => x.startsWith('<button type="button"') || x.startsWith('<select class="fl-pick"')));
  assert.strictEqual((html.match(/role="switch"/g) || []).length, 1, 'one Armed switch, for both lanes');
  assert.ok(!/contenteditable|tabindex|onclick|role="(checkbox|slider)"|draggable/i.test(html));
  assert.match(html, /Not built yet, so not here: moving an account into or out of a lane by drag and drop/);
  // the lane's hostile strings (the trader's name, its group, its seat, why it is stood down, a pick that is gone) are text
  const lanesHtml = P.part('lane-eval').innerHTML + P.part('lane-funded').innerHTML;
  assert.ok(lanesHtml.includes('It is stood down: &lt;img src=x onerror=1&gt;') && lanesHtml.includes('gone.json (not offered now)'));
  assert.ok(!P.part('armsaid').innerHTML && !P.part('armask').innerHTML && !P.part('arm').innerHTML, 'the switch and its lines are set as text');
});

test('an older ChartBridge with the tab open by its address keeps the button (N9); a lineup draws 12 bots at most and says how many more', async t => {
  timers(t);
  const P = page(t);
  P.fv.showTab(true);
  P.feed({ type: 'hello', version: '0.6.10' });
  assert.strictEqual(P.tab.hidden, false, 'open: its own button stays, so the tab can be closed');
  P.fv.showTab(false);
  assert.strictEqual(P.tab.hidden, true, 'closed: hidden again, as Kill all is not there');
  P.feed({ type: 'hello', version: '0.6.20' }); P.fv.showTab(true); await P.tick();
  const many = lineupFile('big', Array.from({ length: 40 }, (_, i) => member('b' + i)));
  P.answers[0].res({ status: 200, json: () => Promise.resolve({ files: [served('big.json', many)] }) }); await P.tick(); await P.tick();
  P.click('more', 1, 'lineup:big');
  const h = P.part('roster').innerHTML;
  assert.match(h, /Lineup of 40/);
  assert.strictEqual((h.match(/class="fl-mname"/g) || []).length, F.MAX_MEMBERS);
  assert.match(h, /And 28 more bots in this lineup, not drawn\./);
  assert.match(h, /b11 2, and 28 more/);
});

test('Kill all\'s Yes takes a real click only (Anthony 2026-11-11): never a key; Cancel and Escape work from the keyboard; one rule with the group entry\'s Send', t => {
  timers(t);
  const OT = require('../live/order-ticket.js');
  assert.deepStrictEqual([{ detail: 1 }, { detail: 2 }, { detail: 0 }, {}, null, { detail: '1' }, { detail: NaN }].map(OT.realClick), [true, true, false, false, false, false, false], 'a click made by a key or by script carries detail 0');
  const P = page(t); P.fv.showTab(true); P.ready();
  P.click('ask'); P.T += 700;
  P.click('yes', 0);                                              // Enter or Space on Yes
  assert.deepStrictEqual([P.posts, P.fv.state().asking], [[], true], 'Yes from the keyboard sends nothing; the question stays');
  assert.match(P.part('hint').textContent, /confirmed by a click on Yes only, not by keyboard/);
  P.click('yes');
  assert.strictEqual(P.posts.length, 1, 'a real click then sends');
  // Cancel from the keyboard, at once
  P.click('ask'); P.click('no', 0);
  assert.strictEqual(P.fv.state().asking, false, 'Cancel by Enter, even in the first moment');
  // Escape cancels; with no question up it does nothing
  P.click('ask'); P.key('Enter'); assert.strictEqual(P.fv.state().asking, true);
  P.key('Escape'); assert.deepStrictEqual([P.fv.state().asking, P.posts.length], [false, 1]);
  P.key('Escape');
  // opening the question by keyboard is as it was
  P.click('ask', 0); assert.strictEqual(P.fv.state().asking, true);
  P.T += 700; P.click('yes', 0); assert.strictEqual(P.posts.length, 1);
  // a tab that was handed no rule never takes a Yes at all
  const Q = page(t, { realClick: undefined }); Q.fv.showTab(true); Q.ready();
  Q.click('ask'); Q.T += 700; Q.click('yes');
  assert.deepStrictEqual(Q.posts, [], 'no rule handed in: Yes is never taken');
  // the one rule, in both places: workspace.js calls OrderTicket.realClick for the group entry's Send and hands the same function to the tab
  const ws = read('live', 'workspace.js'), src = read('live', 'fleet.js');
  assert.match(ws, /d\.querySelector\('#gqSend'\)\.addEventListener\('click', e => \{\s*if \(!OT\.realClick\(e\)\) \{ tnote\('The group entry is sent by a click on Send only, not by keyboard\.', 'warn'\); return; \}/);
  assert.match(ws, /v3: legionLink, realClick: OT\.realClick, headers:/);
  assert.match(ws, /OT = window\.OrderTicket,/);
  assert.ok(!/detail === 0|detail !== 0|detail < 1/.test(src), 'fleet.js has no copy of the rule');
});

test('hotkeys under a tab (Anthony 2026-11-11 and 2026-11-12): one place, every tab that covers the chart, entries off, Close and Flatten all live', () => {
  const ws = read('live', 'workspace.js');
  const m = /const COVERING_TABS = (\{[^\n]*\});\n[\s\S]*?const LIVE_UNDER_TAB = new Set\((\[[^\n]*\])\);\nconst ACCEPT_SHOWN_ON = new Set\((\[[^\]]*\])\);[^\n]*\nconst underTab = (\(id, fn\) => \(\) => \{[\s\S]*?\n\};)\n/.exec(ws);
  assert.ok(m, 'the rule is one block in workspace.js');
  const tabs = new Function('return ' + m[1])();
  // every body class a tab sets while it covers the grid is in the list: a later tab that forgets it fails here
  const toggled = [...ws.matchAll(/document\.body\.classList\.toggle\('([a-z]+-on)', on\)/g)].map(x => x[1]).sort();
  assert.deepStrictEqual(Object.keys(tabs).sort(), toggled);
  assert.deepStrictEqual(tabs, { 'fl-on': 'Legion', 'ag-on': 'Agent', 'bt-on': 'Bot', 'lg-on': 'Colosseum' });   // 1.50.0: the League tab is the Colosseum
  for (const [cls, f] of [['fl-on', 'fleet.css'], ['ag-on', 'agent.css'], ['bt-on', 'bot.css'], ['lg-on', 'league.css']])
    assert.match(read('live', f), new RegExp('body\\.' + cls + ' \\.ws-grid[^{]*\\{ display: none !important; \\}'), cls + ' hides the chart grid');
  // the rule itself, run: which keys act under which tab
  const run = (cls, id) => {
    let acted = false; const notes = [];
    const fn = new Function('document', 'note', 'COVERING_TABS', 'coveringTab', 'LIVE_UNDER_TAB', 'ACCEPT_SHOWN_ON', 'return ' + m[4].replace(/^/, '').replace(/;$/, ''));
    const doc = { body: { classList: { contains: c => c === cls } } };
    const covering = () => { for (const c of Object.keys(tabs)) if (doc.body.classList.contains(c)) return tabs[c]; return ''; };
    fn(doc, (t, w) => notes.push([t, w]), tabs, covering, new Set(new Function('return ' + m[2])()), new Set(new Function('return ' + m[3])()))(id, () => { acted = true; })();
    return [acted, notes];
  };
  const entry = ['buy', 'sell', 'buy:limit', 'buy:stop', 'sell:limit', 'sell:stop'], undecided = ['be', 'merge', 'strategy:s1'], live = ['close', 'flattenAll', 'reject'];
  for (const id of entry.concat(undecided, live, ['accept'])) assert.deepStrictEqual(run('', id), [true, []], id + ' on the bare chart: as before, and nothing said');
  for (const cls of Object.keys(tabs)) {
    for (const id of live) assert.deepStrictEqual(run(cls, id), [true, []], id + ' under ' + tabs[cls] + ': live');
    for (const id of entry.concat(undecided)) { const [acted, notes] = run(cls, id); assert.strictEqual(acted, false, id + ' under ' + tabs[cls] + ': off'); assert.strictEqual(notes.length, 1); assert.match(notes[0][0], new RegExp('^Hotkey ignored: the ' + tabs[cls] + ' tab covers the chart\\.')); assert.strictEqual(notes[0][1], true); }
  }
  assert.deepStrictEqual(['fl-on', 'lg-on', 'ag-on', 'bt-on'].map(c => run(c, 'accept')[0]), [false, false, true, true], 'Accept: only on the tabs that show its proposal (Anthony 2026-11-12)');
  // both handlers go through it, and nothing else reaches the actions
  assert.match(ws, /actions: \{ buy: underTab\('buy', \(\) => keyAct\('buy'\)\), sell: underTab\('sell', \(\) => keyAct\('sell'\)\), be: underTab\('be', \(\) => keyAct\('be'\)\), close: underTab\('close', \(\) => core\.flattenHere\(\)\), flattenAll: underTab\('flattenAll', \(\) => core\.flattenAll\(\)\) \},/);
  assert.match(ws, /run: id => underTab\(id, \(\) => runExtraKey\(id\)\)\(\),/);
  assert.strictEqual((ws.match(/runExtraKey\(/g) || []).length, 2, 'runExtraKey: its definition and the one guarded call');
});

test('with no connection handed in (accounts.js not served) the tab is made, opens and says ChartBridge is not connected; nothing throws', t => {
  timers(t);
  const P = page(t, { v3: null });
  assert.strictEqual(P.subs, null);
  P.fv.showTab(true);
  assert.match(P.part('roster').innerHTML, /ChartBridge is not connected\./);
  assert.strictEqual(P.part('kill').attrs['aria-disabled'], 'true');
  P.click('ask');
  assert.deepStrictEqual([P.fv.state().asking, P.posts], [false, []]);
  assert.match(P.part('hint').textContent, /ChartBridge is not connected/);
  P.fv.hello({ type: 'hello', version: '0.6.20' });          // the page still hands it the ticket's hello
  assert.strictEqual(P.tab.hidden, false);
});

test('the head: the line under the title has its own row, and each number on a card\'s line says what it is', async t => {
  timers(t);
  const P = page(t); P.fv.showTab(true); P.ready(); await P.tick();
  const skeleton = P.view.innerHTML;
  /* the review of 94, note 1: the Armed row sits straight under the head row, above the lines that grow */
  const head = /<div class="fl-head">([\s\S]*?)<\/div>\s*<div class="fl-armrow">[\s\S]*?<\/div>\s*<p class="fl-ask fl-armask"[^>]*><\/p>\s*<p class="fl-ask" data-k="ask"[^>]*>[^<]*<\/p>\s*<p class="fl-autoline"/.exec(skeleton);
  assert.ok(head, 'the line follows the head row, outside it');
  assert.ok(!head[1].includes('autoline') && head[1].includes('data-do="ask"') && head[1].includes('data-do="yes"') && head[1].includes('data-do="no"'), 'the head row holds the title and the three buttons only');
  assert.ok(head[1].indexOf('data-do="yes"') < head[1].indexOf('data-do="no"') && head[1].indexOf('data-do="no"') < head[1].indexOf('data-do="ask"') && !/<(span|p)[^>]*fl-ask/.test(head[1]), 'Yes, then Cancel, then Kill all at the right end; the question\'s words are not in the row');
  P.answers[0].res({ status: 200, json: () => Promise.resolve({ files: [served('z.json', botFile('zeta'))] }) }); await P.tick(); await P.tick();
  const line = P.part('roster').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(line, /Eval \+0\.62 per \$1 Above no edge Funded -0\.10 per \$1 Not above no edge/, 'each number on the line is named: ' + line);
});


/* ---------------------------------------------------------------- the lanes, the pick and the Armed switch (D2) */
const laneRules = { roots: ['NQ', 'MNQ'], entryFrom: '09:40', entryUntil: '15:55', flatAt: '15:55', marketEntry: true, noTarget: true };
const evalTrader = more => agent('legion1', Object.assign({ mode: 'shadow', account: null, group: { id: 'g1', name: 'Evals' }, seats: [{ account: 'EVAL-A' }, { account: 'EVAL-B' }], rules: laneRules, pick: 'germ.json' }, more || {}));
const fundTrader = more => agent('legion2', Object.assign({ mode: 'shadow', account: null, group: { id: 'g2', name: 'Funded' }, seats: [{ account: 'FUND-A' }], rules: laneRules }, more || {}));
const cardsOf = files => F.rosterCards({ files, left: 0 });
const liveCards = () => cardsOf([served('germ.json', botFile('germ')), served('duo.json', lineupFile('duo', [member('a'), member('b')])), served('slow.json', botFile('slow', { runs_live: false, why_not: 'two trades a session' }))]);

test('lanes: a lane is the trader on a group of that Type; each reason a lane cannot be armed, in ChartBridge\'s own facts', () => {
  const V = '0.6.21', cards = liveCards();
  let [ev, fu] = F.lanes([evalTrader(), fundTrader()], groups, accounts, V, cards);
  assert.deepStrictEqual([ev.stage, ev.title, ev.id, ev.groupName, ev.seats, ev.pick, ev.pickText, ev.modeText, ev.auto, ev.why, ev.armable], ['eval', 'Eval lane', 'legion1', 'Evals', ['EVAL-A', 'EVAL-B'], 'germ.json', 'germ', 'Shadow', false, '', true]);
  assert.deepStrictEqual([fu.stage, fu.id, fu.seats, fu.pick, fu.pickText, fu.armable, fu.why], ['funded', 'legion2', ['FUND-A'], '', 'None', false, 'No bot is picked for it']);
  const why = (more, o) => F.lanes([evalTrader(more)], (o && o.groups) || groups, o && 'accounts' in o ? o.accounts : accounts, (o && o.v) || V, o && 'cards' in o ? o.cards : cards)[0];
  assert.match(why({}, { v: '0.6.20' }).why, /^The pick needs ChartBridge 0\.6\.21 or later \(this one is 0\.6\.20\)$/);
  assert.match(why({ enabled: false }).why, /off in ChartBridge/);
  assert.match(why({ killed: true }).why, /kill switch is on \(it is released on the Agent tab, by you\)/);
  assert.match(why({ standDown: 'the day stop' }).why, /^It is stood down: the day stop$/);
  assert.match(why({ pickProblem: 'not one pick line' }).why, /saved pick could not be read: not one pick line/);
  assert.match(why({ pick: undefined }).why, /No bot is picked/);
  assert.match(why({ pick: '../x.json' }).why, /No bot is picked/, 'a name ChartBridge would not take is no pick');
  assert.match(why({}, { cards: null }).why, /roster is not read/);
  assert.match(why({ pick: 'gone.json' }).why, /gone\.json is not a roster file this PC serves now/);
  assert.match(why({ pick: 'slow.json' }).why, /^slow does not run live: two trades a session$/);
  assert.match(why({ seats: [] }).why, /No account trades with its group/);
  // the review of 94, FIX 3: an account on the bench is not a lane's account
  const benchGroups = { type: 'groups', list: groups.list.map(g => (g.id === 'g1' ? Object.assign({}, g, { benched: ['EVAL-B'] }) : g)) };
  const b = why({}, { groups: benchGroups });
  assert.deepStrictEqual([b.seats, b.benched, b.armable], [['EVAL-A'], ['EVAL-B'], true]);
  assert.match(F.armWords([b]), /trades germ on 1 account \(1 account on the bench sits out\)/);
  assert.match(why({}, { groups: { type: 'groups', list: groups.list.map(g => (g.id === 'g1' ? Object.assign({}, g, { benched: ['EVAL-A', 'EVAL-B'] }) : g)) } }).why, /No account trades with its group \(all on the bench, or none\)/);
  // STOP 1: every trading account prop (or Sim, said), never one ChartBridge has not said
  assert.match(why({}, { accounts: null }).why, /^Not heard from ChartBridge yet which accounts are prop$/);
  assert.match(why({ seats: [{ account: 'EVAL-A' }, { account: 'NOBODY-9' }] }).why, /^ChartBridge has not said whether NOBODY-9 is prop$/);
  const simAcc = Object.assign({}, accounts, { list: accounts.list.concat([{ name: 'SIM-L1', sim: true, connection: 'connected', personal: false, prop: false, tradable: true, positions: [] }]) });
  const sim = why({ seats: [{ account: 'SIM-L1' }] }, { accounts: simAcc });
  assert.deepStrictEqual([sim.armable, sim.sim], [true, true], 'a lane of Sim accounts is allowed (the first Sim sessions), and said as such');
  assert.match(F.armWords([sim]), /on 1 Sim account/);
  // FIX 6: Auto as the Agent tab would offer it (AgentCore.modesAllowed with groupTradable)
  const untradable = Object.assign({}, accounts, { list: accounts.list.map(a => (a.name.startsWith('EVAL') ? Object.assign({}, a, { tradable: false }) : a)) });
  assert.match(why({}, { accounts: untradable }).why, /^Auto needs Evals to be tradable in ChartBridge\.$/);
  // the review of 93, FIX 2: Auto names the file; a roster answer with no sha256 cannot arm
  assert.match(why({}, { cards: F.rosterCards({ files: [{ name: 'germ.json', ok: true, roster: botFile('germ') }], left: 0 }) }).why, /ChartBridge gave no sha256 for germ\.json/);
  assert.strictEqual(why({}).sha, shaOfName('germ.json'));
  assert.match(why({ seats: [{ account: 'EVAL-A' }, { account: 'MINE-1' }] }).why, /holds your personal account/);
  assert.match(why({ rules: Object.assign({}, laneRules, { marketEntry: false }) }).why, /Market entry is off in its rules/);
  assert.strictEqual(why({ pick: 'duo.json' }).pickText, 'duo (lineup of 2)');
  assert.strictEqual(why({ connected: false }).runnerNote, 'Its runner is not connected: nothing trades in this lane until it is.');
  assert.strictEqual(why({ connected: false }).armable, true, 'a runner that is not connected does not hold the switch: ChartBridge holds the mode');
  // no trader on a group of that Type, two of them, a trader on one account, a group with no Type: no lane
  [ev, fu] = F.lanes([agent('solo', { account: 'EVAL-A' }), agent('g3er', { account: null, group: { id: 'g3', name: 'New' }, seats: [{ account: 'NOTYPE-1' }] })], groups, accounts, V, cards);
  assert.match(ev.why, /^No trader is on a group of Type eval\. ChartBridge's 17:00 reset puts a flat trader on None each trading day, so give the trader its group again on the Agent tab each day/, 'FIX 4: the daily step said as it is'); assert.match(fu.why, /^No trader is on a group of Type funded/);
  assert.deepStrictEqual([ev.id, ev.armable, ev.traders], ['', false, []]);
  [ev] = F.lanes([evalTrader(), agent('twin', { mode: 'auto', account: null, group: { id: 'g1', name: 'Evals' }, seats: [] })], groups, accounts, V, cards);
  assert.match(ev.why, /^2 traders are on eval groups \(legion1, twin\): Legion runs one lane a stage/);
  assert.deepStrictEqual([ev.armable, ev.auto, ev.traders], [false, true, ['legion1', 'twin']], 'and it still says one of them is in Auto');
  assert.strictEqual(F.lanes([evalTrader()], null, accounts, V, cards)[0].why, 'Not heard from ChartBridge yet');
  assert.doesNotThrow(() => F.lanes([null, 7, {}, { agent: 'x', group: 7 }], { list: [null, 7] }, { list: [7] }, null, { ok: false }));
});

test('the Armed switch: offered only when Kill all is, "not known" until heard, PARTLY with the reason; on names the pick and its sha256; off reaches traders in Auto outside the lanes', () => {
  const V = '0.6.21', cards = liveCards(), L = list => F.lanes(list, groups, accounts, V, cards), cidFn = () => 'c';
  const A = (ls, list, o) => F.armState(ls, (o && o.v) || V, !(o && o.out === 'signin'), !(o && o.out === 'conn'), o && 'acc' in o ? o.acc : accounts, o && 'grp' in o ? o.grp : groups, !(o && o.out === 'agents'), F.outsideAuto(ls, list, accounts, V));
  const both = [evalTrader(), fundTrader({ pick: 'duo.json' })], one = [evalTrader(), fundTrader()];
  const off = A(L(both), both);
  assert.deepStrictEqual([off.state, off.text, off.can, off.canOff, off.why], ['off', 'Armed: off', true, true, '']);
  assert.deepStrictEqual(F.armMsgs(L(both), true, both, cidFn), [{ type: 'agentMode', cid: 'c', agent: 'legion1', mode: 'auto', pick: 'germ.json', pickSha: shaOfName('germ.json') }, { type: 'agentMode', cid: 'c', agent: 'legion2', mode: 'auto', pick: 'duo.json', pickSha: shaOfName('duo.json') }], 'built by AgentCore.modeMsg, naming the pick and its sha256');
  assert.deepStrictEqual(F.armMsgs(L(one), true, one, cidFn).map(m => m.agent), ['legion1'], 'a lane that is not ready is never sent to Auto');
  assert.match(F.armWords(L(one)), /^Eval lane: legion1 goes to Auto and trades germ on 2 accounts\. Funded lane: stays off \(No bot is picked for it\)\.$/);
  // STOP 1: Armed is never offered when Kill all is not (one function decides both)
  const nopersonal = Object.assign({}, accounts, { personalNamed: false });
  const s1 = F.armState(L(both), V, true, true, nopersonal, groups, true, []);
  assert.deepStrictEqual([s1.can, F.killAllState(V, nopersonal, true, true).ok], [false, false]);
  assert.strictEqual(s1.why, F.killAllState(V, nopersonal, true, true).why, 'the same words as Kill all');
  // FIX 1: "not known" until the page has heard ChartBridge, and never offered either way
  for (const o of [{ out: 'conn' }, { out: 'signin' }, { acc: null }, { grp: null }, { out: 'agents' }]) {
    const u = A(L(both), both, o);
    assert.deepStrictEqual([u.state, u.text, u.can, u.canOff], ['unknown', 'Armed: not known', false, false], JSON.stringify(o));
    assert.match(u.why, /the page does not know whether a lane is in Auto/);
  }
  // the state, from the modes
  const st = list => A(L(list), list).state;
  assert.strictEqual(st([evalTrader({ mode: 'auto' }), fundTrader({ pick: 'duo.json', mode: 'auto' })]), 'on');
  assert.strictEqual(st([evalTrader({ mode: 'auto' }), fundTrader()]), 'on', 'the one ready lane is in Auto and the other cannot be');
  assert.strictEqual(st([evalTrader({ mode: 'auto' }), fundTrader({ pick: 'duo.json' })]), 'partly');
  assert.strictEqual(st([evalTrader(), fundTrader({ mode: 'auto' })]), 'partly', 'a lane in Auto that is not ready (set on the Agent tab) never reads as on');
  assert.strictEqual(st([evalTrader({ mode: 'auto' }), fundTrader({ mode: 'auto' })]), 'partly', 'every ready lane in Auto, and one more that is not ready: not on');
  // note 8: a lane in Copilot is not off: PARTLY, and a click sends it to Shadow
  const cop = [evalTrader({ mode: 'copilot' }), fundTrader()];
  const sc = A(L(cop), cop);
  assert.deepStrictEqual([sc.state, sc.reasons], ['partly', ['Eval lane has a trader not in Shadow: legion1 (Copilot)']]);
  assert.deepStrictEqual(F.armMsgs(L(cop), false, cop, null).map(m => [m.agent, m.mode]), [['legion1', 'shadow']]);
  // FIX 2: a trader in Auto on a prop account outside the lanes: PARTLY with its name; a click sends it to Shadow, never arms
  const loose = [evalTrader(), fundTrader({ pick: 'duo.json' }), agent('loose', { mode: 'auto', account: 'EVAL-A' })];
  const sl = A(L(loose), loose);
  assert.strictEqual(sl.state, 'partly');
  assert.match(sl.reasons.join(' '), /^Not a lane, so not armed from here: loose on a prop account in Auto \(a click sends it to Shadow; or Praetorian, the Agent tab until Praetorian merges\)$/);
  assert.deepStrictEqual(F.armMsgs(L(loose), false, loose, null, F.outsideAuto(L(loose), loose, accounts, V)).map(m => [m.agent, m.mode]), [['loose', 'shadow']]);
  // off: every trader of every lane that is not in Shadow, the second trader of a doubled lane included, and the loose one
  const mixed = [evalTrader({ mode: 'auto' }), fundTrader({ mode: 'copilot' }), agent('twin', { mode: 'auto', account: null, group: { id: 'g1', name: 'Evals' }, seats: [] }), agent('solo', { mode: 'auto', account: 'EVAL-A' })];
  assert.deepStrictEqual(F.armMsgs(L(mixed), false, mixed, null, F.outsideAuto(L(mixed), mixed, accounts, V)).map(m => [m.agent, m.mode]), [['legion1', 'shadow'], ['twin', 'shadow'], ['legion2', 'shadow'], ['solo', 'shadow']]);
  assert.deepStrictEqual(F.armMsgs(L(both), false, both, null), [], 'nothing to switch off');
  // why it cannot be switched on
  assert.match(A(L(both), both, { v: '0.6.20' }).why, /Armed needs ChartBridge 0\.6\.21 or later/);
  assert.match(A(L([fundTrader()]), [fundTrader()]).why, /^No lane is ready: Eval lane: No trader is on a group of Type eval.* Funded lane: No bot is picked for it$/);
  // every message it makes passes the gate, and the pick's too; the gate holds Auto to its pick and sha256
  for (const m of F.armMsgs(L(mixed), false, mixed, cidFn).concat(F.armMsgs(L(both), true, both, cidFn))) assert.strictEqual(F.maySend(m), true);
  for (const bad of [{ type: 'agentMode', agent: 'a1', mode: 'auto', pick: 'x.json' }, { type: 'agentMode', agent: 'a1', mode: 'auto', pickSha: 'a'.repeat(64) }, { type: 'agentMode', agent: 'a1', mode: 'auto', pick: 'x.json', pickSha: 'A'.repeat(64) },
    { type: 'agentMode', agent: 'a1', mode: 'shadow', pick: 'x.json', pickSha: 'a'.repeat(64) }, { type: 'agentMode', agent: 'a1', mode: 'auto', pick: '../x.json', pickSha: 'a'.repeat(64) }])
    assert.strictEqual(F.maySend(bad), false, JSON.stringify(bad));
  assert.ok(Object.isFrozen(F), 'FleetCore is frozen: its gate cannot be replaced (note 5)');
  assert.deepStrictEqual(F.pickMsg('legion1', 'germ.json', 'c9'), { type: 'agentPick', cid: 'c9', agent: 'legion1', file: 'germ.json' });
  assert.deepStrictEqual(F.pickMsg('legion1', null), { type: 'agentPick', agent: 'legion1', file: null });
  assert.deepStrictEqual([F.pickMsg('Legion 1', 'germ.json'), F.pickMsg('legion1', 'germ.txt'), F.pickMsg('legion1', ''), F.pickMsg('legion1', undefined)], [null, null, null, null]);
  assert.deepStrictEqual(F.pickChoices(cards), [{ file: 'duo.json', text: 'duo (lineup of 2)' }, { file: 'germ.json', text: 'germ' }], 'only files that run live are offered');
  assert.deepStrictEqual(F.pickChoices(null), []);
});

async function lanePage(t, list) {
  timers(t);
  const P = page(t); P.fv.showTab(true);
  P.feed({ type: 'hello', version: '0.6.21' }); P.feed({ type: 'trading', enabled: true }); P.feed(accounts); P.feed(groups);
  for (const a of list) P.feed(a);
  P.replayDone();
  await P.tick();
  P.answers[0].res({ status: 200, json: () => Promise.resolve({ left: 0, files: [served('germ.json', botFile('germ')), served('duo.json', lineupFile('duo', [member('a'), member('b')]))] }) });
  await P.tick(); await P.tick();
  return P;
}

test('Armed on: it asks, takes a real click on Yes after the first moment, and sends Auto for the ready lanes; everything is checked again at the Yes', async t => {
  const P = await lanePage(t, [evalTrader(), fundTrader()]);
  const arm = () => P.fv.state().arm;
  assert.deepStrictEqual([arm().state, P.part('arm').textContent, P.part('arm').attrs['aria-checked'], P.part('arm').attrs['data-state']], ['off', 'Armed: off', 'false', 'off']);
  P.click('armyes');
  assert.deepStrictEqual([P.posts, arm().asking], [[], false], 'Yes with no question up sends nothing');
  P.click('arm');
  assert.deepStrictEqual([arm().asking, P.posts, P.part('arm').hidden, P.part('armno').hidden, P.part('armyes').hidden, P.part('armask').hidden], [true, [], true, false, false, false], 'the first click asks and sends nothing');
  assert.strictEqual(P.part('armno').style.minWidth, '157px', 'Cancel takes the switch\'s own place');
  assert.strictEqual(P.part('armno').focused, 1, 'and the focus');
  assert.match(P.part('armask').textContent, /^Arm\? Eval lane: legion1 goes to Auto and trades germ on 2 accounts\. Funded lane: stays off \(No bot is picked for it\)\. Yes, or Cancel, beside this\.$/);
  P.T += 100; P.click('armyes', 2);
  assert.deepStrictEqual([P.posts, arm().asking], [[], true], 'the second click of a double click: nothing');
  assert.match(P.part('armsaid').textContent, /Too soon: read the question, then click Yes\.$/);
  P.T += 600; P.click('armyes', 0);
  assert.deepStrictEqual(P.posts, [], 'a click made by a key is never a Yes');
  assert.match(P.part('armsaid').textContent, /confirmed by a click on Yes only, not by keyboard/);
  P.click('armyes');
  assert.strictEqual(P.posts.length, 1);
  assert.deepStrictEqual([Object.keys(P.posts[0]).sort(), P.posts[0].type, P.posts[0].agent, P.posts[0].mode, P.posts[0].pick, P.posts[0].pickSha, arm().asking], [['agent', 'cid', 'mode', 'pick', 'pickSha', 'type'], 'agentMode', 'legion1', 'auto', 'germ.json', shaOfName('germ.json'), false], 'Auto names the pick and its file\'s sha256 (the review of 93, FIX 2)');
  assert.match(P.part('armsaid').textContent, /Sent Auto for legion1: the switch shows what ChartBridge says next$/);
  assert.strictEqual(arm().state, 'off', 'the switch does not move by itself: it waits for ChartBridge');
  // ChartBridge refuses: said, marked bad
  P.feed({ type: 'reject', cid: P.posts[0].cid, reason: 'the account is not tradable' });
  assert.match(P.part('armsaid').textContent, /ChartBridge refused Auto for legion1: the account is not tradable$/);
  assert.ok(P.part('armsaid').cls.has('bad'));
  // ChartBridge says Auto: the switch is on
  P.feed(evalTrader({ mode: 'auto' }));
  assert.deepStrictEqual([arm().state, P.part('arm').textContent, P.part('arm').attrs['aria-checked']], ['on', 'Armed: ON', 'true']);
  // the 8 seconds by the clock, the timer, Cancel and Escape
  P.feed(evalTrader()); P.posts.length = 0;
  P.click('arm'); P.T += F.CONFIRM_MS + 1; P.click('armyes');
  assert.deepStrictEqual([P.posts, arm().asking], [[], false], 'Yes after 8 seconds by the clock: nothing');
  P.click('arm'); t.mock.timers.tick(F.CONFIRM_MS + 1); assert.strictEqual(arm().asking, false, 'the question times out by itself');
  P.click('arm'); P.T += 700; P.click('armno', 0); assert.strictEqual(arm().asking, false, 'Cancel by the keyboard');
  P.click('arm'); P.key('Escape'); assert.strictEqual(arm().asking, false, 'Escape');
  // checked again at the Yes: the lane stopped being ready while the question was up
  P.click('arm'); P.T += 700; P.feed(evalTrader({ killed: true })); P.click('armyes');
  assert.deepStrictEqual(P.posts, [], 'nothing is sent for a lane that is no longer ready');
  assert.match(P.part('armsaid').textContent, /No lane is ready: Eval lane: Its kill switch is on/);
  // not signed in: the switch says why and asks nothing
  P.feed(evalTrader()); P.feed({ type: 'trading', enabled: false }); P.click('arm');
  assert.deepStrictEqual([arm().asking, P.posts, P.part('arm').attrs['aria-disabled']], [false, [], 'true']);
  assert.match(P.part('armsaid').textContent, /Sign in to trading first/);
  // closing the tab takes the question down with it (the review of 94, note 10)
  P.feed({ type: 'trading', enabled: true });
  assert.strictEqual(arm().state, 'unknown', 'a new sign-in: not known until its replay has ended (S1)');
  P.feed(evalTrader()); P.feed(fundTrader()); assert.strictEqual(arm().state, 'unknown', 'traders heard, the replay not ended yet');
  P.replayDone();
  P.click('arm'); assert.strictEqual(arm().asking, true);
  P.fv.showTab(false); P.fv.showTab(true); assert.strictEqual(arm().asking, false, 'closed and opened again inside the 8 seconds: no question up');
  // a lost connection ends the question, and the switch reads "not known", not "off" (FIX 1)
  P.click('arm'); assert.strictEqual(arm().asking, true);
  P.subs.closed(); assert.strictEqual(arm().asking, false);
  assert.deepStrictEqual([arm().state, P.part('arm').textContent, P.part('arm').attrs['aria-checked'], P.part('arm').attrs['aria-disabled']], ['unknown', 'Armed: not known', 'mixed', 'true']);
  P.click('arm', 0); P.click('arm');
  assert.deepStrictEqual([P.posts, arm().asking], [[], false], 'not known: neither a click nor a key does anything but say why');
  assert.deepStrictEqual(P.posts, []);
});

test('Armed off: one click or key, no question, Shadow for every lane trader not in Shadow; partly is said and a click switches all off', async t => {
  const P = await lanePage(t, [evalTrader({ mode: 'auto' }), fundTrader({ pick: 'duo.json' })]);
  const arm = () => P.fv.state().arm;
  assert.deepStrictEqual([arm().state, P.part('arm').textContent, P.part('arm').attrs['aria-checked']], ['partly', 'Armed: PARTLY', 'mixed']);
  assert.match(P.part('armsaid').textContent, /^Funded lane is not in Auto\. A click switches every lane off\.$/);
  P.click('arm', 0);                                       // by the keyboard: off is never held up
  assert.deepStrictEqual(P.posts.map(m => [m.type, m.agent, m.mode]), [['agentMode', 'legion1', 'shadow']]);
  assert.strictEqual(arm().asking, false, 'no question');
  P.feed(evalTrader({ mode: 'auto' })); P.feed(fundTrader({ pick: 'duo.json', mode: 'auto' }));
  assert.strictEqual(arm().state, 'on');
  P.posts.length = 0; P.click('arm');
  assert.deepStrictEqual(P.posts.map(m => [m.agent, m.mode]), [['legion1', 'shadow'], ['legion2', 'shadow']]);
  // a send that fails is said, marked bad
  P.posts.length = 0; P.postOk = false; P.click('arm');
  assert.match(P.part('armsaid').textContent, /Shadow could NOT be sent for 2 of 2: ChartBridge is not connected\. Use Kill all, or NinjaTrader$/);
  assert.ok(P.part('armsaid').cls.has('bad'));
  // Kill all and the 17:00 reset show here because the switch reads ChartBridge: both traders back in Shadow, the switch is off
  P.postOk = true; P.feed(evalTrader()); P.feed(fundTrader({ pick: 'duo.json' }));
  assert.deepStrictEqual([arm().state, P.part('arm').textContent], ['off', 'Armed: off']);
  // the question of Kill all and the Armed question are apart: Escape ends both
  P.click('ask'); P.click('arm'); assert.deepStrictEqual([P.fv.state().asking, arm().asking], [true, true]);
  P.key('Escape'); assert.deepStrictEqual([P.fv.state().asking, arm().asking], [false, false]);
});

test('the pick: one list a lane, sent as agentPick; locked in Auto and while the trader holds something; a refusal is said and the list goes back', async t => {
  const P = await lanePage(t, [evalTrader(), fundTrader()]);
  const lanesHtml = () => P.part('lane-eval').innerHTML + P.part('lane-funded').innerHTML;
  let html = lanesHtml();
  assert.match(html, /<select class="fl-pick" id="flPick-eval" data-do="pick" data-agent="legion1"><option value="">None<\/option><option value="duo\.json">duo \(lineup of 2\)<\/option><option value="germ\.json" selected>germ<\/option><\/select>/);
  assert.match(html, /<select class="fl-pick" id="flPick-funded" data-do="pick" data-agent="legion2"><option value="" selected>None<\/option>/);
  assert.match(html, /data-stage="eval" data-armable="true"/); assert.match(html, /data-stage="funded" data-armable="false"/);
  assert.match(html, /<span class="fl-seat">EVAL-A<\/span><span class="fl-seat">EVAL-B<\/span>/);
  P.change('legion2', 'gone.json');
  assert.deepStrictEqual(P.posts, [], 'a file the list does not offer is not sent (the review of 94, note 7)');
  P.change('legion2', 'duo.json');
  assert.deepStrictEqual(P.posts.map(m => [m.type, m.agent, m.file, typeof m.cid]), [['agentPick', 'legion2', 'duo.json', 'string']]);
  assert.match(P.part('armsaid').textContent, /Sent the pick for funded lane: duo\.json$/);
  assert.match(lanesHtml(), /id="flPick-funded"[^>]*><option value="" selected>None/, 'the list shows ChartBridge\'s pick until ChartBridge says otherwise');
  P.feed({ type: 'reject', cid: P.posts[0].cid, reason: 'agent legion2 is in Auto: the pick changes only while it is not' });
  assert.match(P.part('armsaid').textContent, /ChartBridge refused the pick for legion2: agent legion2 is in Auto/);
  P.feed(fundTrader({ pick: 'duo.json' }));
  assert.match(lanesHtml(), /<option value="duo\.json" selected>duo \(lineup of 2\)<\/option>/);
  P.change('legion1', '');
  assert.deepStrictEqual([P.posts[1].agent, P.posts[1].file], ['legion1', null], 'None is sent as null');
  // locked: in Auto, and while it holds something
  P.posts.length = 0;
  P.feed(evalTrader({ mode: 'auto' }));
  assert.match(lanesHtml(), /id="flPick-eval" data-do="pick" data-agent="legion1" disabled title="Switch Armed off first: the pick changes only while the lane is not in Auto"/);
  P.change('legion1', 'duo.json');
  assert.deepStrictEqual(P.posts, [], 'and a change that arrives anyway is not sent');
  P.feed(evalTrader({ owns: true }));
  assert.match(lanesHtml(), /id="flPick-eval"[^>]* disabled title="The trader holds something: the pick changes once it is flat"/);
  // a trader that is not a lane's, a name that is not a file: nothing
  P.change('nobody', 'duo.json'); P.change('legion2', '../x.json');
  assert.deepStrictEqual(P.posts, []);
  // the lanes are not drawn again while nothing they show changed (a list held open is not taken away by the once-a-second message)
  const draws = P.fv.state().draws['lane-eval'], fdraws = P.fv.state().draws['lane-funded'];
  P.feed(evalTrader({ owns: true, pnlToday: 55, lastBeatMs: 900 })); P.feed(evalTrader({ owns: true, pnlToday: 60, lastBeatMs: 7000 }));
  assert.strictEqual(P.fv.state().draws['lane-eval'], draws);
  // each lane is drawn on its own (note 3): a change in the eval lane never draws the funded lane again
  P.feed(evalTrader({ owns: false, standDown: 'made up' }));
  assert.ok(P.fv.state().draws['lane-eval'] > draws && P.fv.state().draws['lane-funded'] === fdraws, 'the other lane (and an open list in it) is left alone');
});


/* ---------------------------------------------------------------- a lane's own Multi-Account panel (1.47.0, the reuse map) */
test('the narrow feed: what the panel reads, memberBench and accountGroup, and every other send refused by name', () => {
  const posted = [], AF = { S: { accounts: [], groups: [{ id: 'g1', name: 'Lucid', members: ['SIM-A', 'SIM-B'] }, { id: 'g2', name: 'Other', members: ['SIM-H'] }] },
    post: m => { posted.push(m); return true; }, accountGroup: (...a) => { posted.push(['accountGroup'].concat(a)); return true; },
    joinRefusal: () => 'r', joinPlan: () => ({ mode: 'auto' }), joinWords: () => 'w',
    send: () => { throw new Error('send reached'); }, sendOrder: () => { throw new Error('sendOrder reached'); }, memberRules: () => { throw new Error('memberRules reached'); }, limit: () => { throw new Error('limit reached'); } };
  let lock = '';
  const other = { g2: '' };
  const f = F.laneFeed(AF, () => lock, 'g1', gid => other[gid]);
  assert.deepStrictEqual(Object.keys(f).sort(), ['S', 'accountGroup', 'joinPlan', 'joinRefusal', 'joinWords', 'post', 'refused'], 'nothing else of the page\'s feed is there');
  assert.ok(Object.isFrozen(f), 'and nothing can be added to it');
  assert.strictEqual(f.S, AF.S); assert.strictEqual(f.joinRefusal('A', {}), 'r'); assert.deepStrictEqual(f.joinPlan('A', {}, null), { mode: 'auto' }); assert.strictEqual(f.joinWords({}), 'w');
  // the sends of this lane: a bench move of its member, a join into its group, a removal of its member
  assert.strictEqual(f.post({ type: 'memberBench', cid: 'c1', account: 'SIM-A', benched: true }), true);
  assert.strictEqual(f.accountGroup('SIM-E', 'g1', '50000', { size: 50000 }, 'c2'), true, 'an account in no group joins');
  assert.strictEqual(f.accountGroup('SIM-B', null, '', null, 'c3'), true, 'a member leaves');
  assert.strictEqual(posted.length, 3);
  // every other send the panel has, and a few it does not, refused by name
  const others = [{ type: 'groupSave', cid: 'c', name: 'X', accountType: 'funded' }, { type: 'groupDelete', cid: 'c', group: 'g1' }, { type: 'accountGroup', cid: 'c', account: 'SIM-E', group: 'g1' },
    { type: 'memberRules', account: 'SIM-A' }, { type: 'accountLimits', account: 'SIM-A' }, { type: 'order' }, { type: 'agentMode', agent: 'a', mode: 'auto' }, { type: 'agentKillAllProp' },
    { type: 'memberBench', account: 'SIM-A', benched: 'yes' }, { type: 'memberBench', account: 'SIM-A', benched: true, group: 'g2' }, { type: 'memberBench', benched: true }, null, 'memberBench'];
  for (const m of others) assert.strictEqual(f.post(m), false, JSON.stringify(m));
  assert.deepStrictEqual(f.refused.slice(0, 8), ['groupSave', 'groupDelete', 'accountGroup', 'memberRules', 'accountLimits', 'order', 'agentMode', 'agentKillAllProp']);
  assert.strictEqual(f.accountGroup(7, 'g1'), false); assert.strictEqual(f.accountGroup('SIM-E', 7), false);
  // BOUND TO ITS LANE (the review of 97, F2, the reviewer's probes): nothing into another group, nothing out of another group,
  // no bench move there; taking an account from another group asks that group's lock too
  assert.strictEqual(f.accountGroup('SIM-H', 'g2'), false, 'into another group');
  assert.strictEqual(f.accountGroup('SIM-A', 'g2'), false, 'this lane\'s member sent to another group');
  assert.strictEqual(f.accountGroup('SIM-H', null), false, 'another group\'s member taken out');
  assert.strictEqual(f.accountGroup('SIM-E', null), false, 'an account in no group "taken out"');
  assert.strictEqual(f.post({ type: 'memberBench', account: 'SIM-H', benched: true }), false, 'a bench move in another group');
  assert.strictEqual(f.post({ type: 'memberBench', account: 'SIM-E', benched: true }), false, 'a bench move for an account in no group');
  other.g2 = 'The lane is in Auto: switch Armed off before an account moves.';
  assert.strictEqual(f.accountGroup('SIM-H', 'g1'), false, 'pulled from the other lane while it is in Auto');
  other.g2 = '';
  assert.strictEqual(f.accountGroup('SIM-H', 'g1'), true, 'and allowed once that lane is free');
  assert.strictEqual(posted.length, 4);
  for (const bad of [F.laneFeed(AF, () => '', 'g1', () => { throw new Error('x'); }), F.laneFeed(AF, () => '', 'g1'), F.laneFeed(AF, () => '', 'g1', () => null)])
    assert.strictEqual(bad.accountGroup('SIM-H', 'g1'), false, 'the other lock not known: refused');
  // no lock function, no group id, or the groups not known: everything refused
  for (const bad of [F.laneFeed(AF), F.laneFeed(AF, () => ''), F.laneFeed(AF, () => '', ''), F.laneFeed({ S: {}, post: AF.post, accountGroup: AF.accountGroup }, () => '', 'g1', () => '')]) {
    assert.strictEqual(bad.post({ type: 'memberBench', account: 'SIM-A', benched: true }), false);
    assert.strictEqual(bad.accountGroup('SIM-E', 'g1', '', null, 'c9'), false);
    assert.strictEqual(bad.accountGroup('SIM-A', null, '', null, 'c9'), false);
  }
  for (const gid of ['', undefined, null]) assert.strictEqual(F.laneFeed(AF, () => '', gid, () => '').accountGroup('SIM-E', gid), false, 'no lane group: nothing joins, even "into" the same nothing');
  assert.strictEqual(posted.length, 4, 'only the good sends reached the page\'s feed');
  // the lock: with a reason both sends are refused here too, whatever the panel shows
  lock = 'The lane is in Auto: switch Armed off before an account moves.';
  assert.strictEqual(f.post({ type: 'memberBench', account: 'SIM-A', benched: false }), false);
  assert.strictEqual(f.accountGroup('SIM-E', 'g1', '', null, 'c4'), false);
  const g = F.laneFeed(AF, () => { throw new Error('broken'); }, 'g1', () => '');
  assert.strictEqual(g.post({ type: 'memberBench', account: 'SIM-A', benched: true }), false, 'a lock that cannot be read refuses');
  // a lock that answers anything but text (null, a number, an object) is "not known", so both sends are refused
  for (const odd of [null, undefined, 0, 1, {}, true]) {
    const h = F.laneFeed(AF, () => odd, 'g1', () => '');
    assert.strictEqual(h.post({ type: 'memberBench', account: 'SIM-A', benched: true }), false, 'lock ' + String(odd));
    assert.strictEqual(h.accountGroup('SIM-E', 'g1', '', null, 'c5'), false, 'lock ' + String(odd));
  }
  assert.strictEqual(posted.length, 4);
  // the bench move's shape under another type is not a bench move: only memberBench passes
  for (const type of ['groupDelete', 'accountGroup', 'memberRules', 'order', 'MemberBench', undefined])
    assert.strictEqual(F.laneMaySend({ type, account: 'SIM-A', benched: true }), false, String(type));
  assert.strictEqual(F.laneMaySend({ type: 'memberBench', account: 'SIM-A', benched: true }), true);
});

test('a lane\'s lock: moves are free only while its one trader is in Shadow and holds nothing; not known is locked', () => {
  const V = '0.6.21', L = list => F.lanes(list, groups, accounts, V, liveCards())[0];
  assert.strictEqual(F.laneLock(L([evalTrader()]), true), '');
  assert.match(F.laneLock(L([evalTrader({ mode: 'auto' })]), true), /in Auto: switch Armed off/);
  assert.match(F.laneLock(L([evalTrader({ mode: 'copilot' })]), true), /not in Shadow \(Copilot\)/);
  assert.match(F.laneLock(L([evalTrader({ mode: 'copilot', owns: false, proposal: true })]), true), /not in Shadow/, 'a proposal is open only in Copilot: refused (the review of 97, F5)');
  assert.match(F.laneLock(L([evalTrader({ owns: true })]), true), /holds a position or a working entry/);
  assert.match(F.laneLock(L([evalTrader(), agent('twin', { mode: 'shadow', account: null, group: { id: 'g1', name: 'Evals' }, seats: [] })]), true), /Two traders are on this lane/);
  assert.strictEqual(F.laneLock(L([]), true), '', 'heard, and a lane with no trader: nothing trades it, moves are free');
  // NOT KNOWN IS LOCKED (the review of 97, F1): no lane, a lane not heard yet, before the groups message, before the first agent message
  for (const [why, l, heard] of [['null', null, true], ['undefined', undefined, true], ['not a lane', { traders: 'x' }, true],
    ['before the groups message', F.lanes([], null, null, V, null)[0], false], ['groups heard, no agent message yet', F.lanes([], groups, accounts, V, null)[0], false],
    ['a free lane, heard not said', L([evalTrader()]), undefined], ['heard as text', L([evalTrader()]), 'yes']])
    assert.strictEqual(F.laneLock(l, heard), F.NOT_KNOWN, why);
  assert.match(F.NOT_KNOWN, /^Not known yet/);
});

/* ---------------------------------------------------------------- the re-review of 94 (answers 22) */
test('the re-review of 94, R2: a doubled lane with a trader in Copilot (or not said) is never "off"; one click only switches off', () => {
  const V = '0.6.21', cards = liveCards();
  const twin = (mode) => agent('twin', { mode, account: null, group: { id: 'g1', name: 'Evals' }, seats: [] });
  for (const mode of ['copilot', undefined]) {
    const list = [evalTrader(), twin(mode), fundTrader({ pick: 'duo.json' })];
    const ls = F.lanes(list, groups, accounts, V, cards);
    assert.strictEqual(ls[0].notShadow, true, String(mode));
    const st = F.armState(ls, V, true, true, accounts, groups, true, F.outsideAuto(ls, list, accounts, V));
    assert.strictEqual(st.state, 'partly', String(mode));
    assert.match(st.reasons.join(' '), /Eval lane has a trader not in Shadow: twin \((Copilot|not known)\)/);
    const off = F.armMsgs(ls, false, list, null, []);
    assert.deepStrictEqual(off.map(m => [m.agent, m.mode]), [['twin', 'shadow']], 'a click on PARTLY sends Shadow, never Auto');
  }
});

test('the re-review of 94, R3: any trader in Auto outside the lanes reads PARTLY, named with what it is on; the personal account is left out', () => {
  const V = '0.6.21', cards = liveCards();
  const list = [evalTrader(), fundTrader(), agent('simmy', { mode: 'auto', account: 'SIM-X' }), agent('mine', { mode: 'auto', account: 'MINE-1' }), agent('odd', { mode: 'auto', account: 'NOBODY-9' })];
  const acc = Object.assign({}, accounts, { list: accounts.list.concat([{ name: 'SIM-X', sim: true, prop: false, connection: 'connected' }, { name: 'MINE-1', personal: true, prop: false, sim: false, connection: 'connected' }]) });
  const ls = F.lanes(list, groups, acc, V, cards);
  const out = F.outsideAuto(ls, list, acc, V);
  assert.ok(out.includes('simmy') && !out.includes('mine'), JSON.stringify(out));
  const st = F.armState(ls, V, true, true, acc, groups, true, out);
  assert.strictEqual(st.state, 'partly');
  assert.match(st.reasons.join(' '), /simmy on a Sim account \(Kill all does not reach it\)/);
  assert.match(st.reasons.join(' '), /or Praetorian, the Agent tab until Praetorian merges/);
  // no personal account picked: Kill all is refused, the switch still reads PARTLY (never "off") and may only switch off
  const noPick = Object.assign({}, acc, { personalNamed: false });
  const st2 = F.armState(F.lanes(list, groups, noPick, V, cards), V, true, true, noPick, groups, true, F.outsideAuto(F.lanes(list, groups, noPick, V, cards), list, noPick, V));
  assert.deepStrictEqual([st2.state, st2.can, st2.canOff], ['partly', false, true]);
});

test('the re-review of 94, N1: "not known" until the traders have settled, not at the first one', t => {
  timers(t);
  const P = page(t, { settleMs: 1500 });
  P.fv.showTab(true); P.ready();
  assert.strictEqual(P.fv.state().arm.state, 'unknown', 'the first trader heard: not known yet');
  P.T += 1500;
  assert.notStrictEqual(P.fv.state().arm.state, 'unknown', 'settled');
});

test('answers 25, S1: "heard" waits for ChartBridge\'s end of the sign-in replay (agentStandDowns) and the floor; a late trader, a new sign-in and a drop', t => {
  timers(t);
  const P = page(t, { settleMs: 1500 });
  const arm = () => P.fv.state().arm.state;
  const twin = agent('legion3', { mode: 'auto', account: null, group: { id: 'g1', name: 'Evals' }, seats: [], owns: false, runner: false });
  P.fv.showTab(true);
  P.feed({ type: 'hello', version: '0.6.21' }); P.feed({ type: 'trading', enabled: true }); P.feed(accounts); P.feed(groups);
  // the reviewer's case A: two lane traders heard, the floor passes, a third trader (Auto, on the eval group) 1.6 s later
  P.feed(evalTrader()); P.feed(fundTrader());
  P.T += 1600;
  assert.strictEqual(arm(), 'unknown', 'the floor alone is not "heard": the replay has not ended');
  P.feed(twin);
  P.replayDone();
  assert.strictEqual(arm(), 'partly', 'the late trader counts: the eval lane is doubled with a trader in Auto');
  // a checkmark change: ChartBridge sends trading true again, which is not a new sign-in
  P.feed({ type: 'trading', enabled: true });
  assert.strictEqual(arm(), 'partly');
  // case B: a sign-out and a sign-in on the same connection start again, and nothing is heard while signed out
  P.feed({ type: 'trading', enabled: false });
  assert.strictEqual(arm(), 'unknown');
  P.feed({ type: 'trading', enabled: true });
  assert.strictEqual(arm(), 'unknown', 'a new sign-in: the old replay does not count');
  P.feed(evalTrader()); P.feed(fundTrader());
  P.T += 2000;
  assert.strictEqual(arm(), 'unknown', 'its replay has not ended');
  P.replayDone();
  assert.strictEqual(arm(), 'off', 'the new replay has ended and has no third trader');
  // the floor: the end of the replay before 1.5 s from its first trader still waits for the floor
  P.subs.closed();
  assert.strictEqual(arm(), 'unknown', 'a drop forgets (K14)');
  P.feed({ type: 'hello', version: '0.6.21' }); P.feed({ type: 'trading', enabled: true }); P.feed(accounts); P.feed(groups);
  P.feed(evalTrader()); P.feed(fundTrader()); P.replayDone();
  assert.strictEqual(arm(), 'unknown', 'the end of the replay came 0 s after the first trader: the floor still runs');
  P.T += 1500;
  assert.strictEqual(arm(), 'off');
});

test('answers 25, N-b (K14): a drop resets the wait, even with the traders heard again at once', t => {
  timers(t);
  const P = page(t, { settleMs: 1500 });
  P.fv.showTab(true); P.ready(); P.T += 1500;
  assert.notStrictEqual(P.fv.state().arm.state, 'unknown');
  P.subs.closed();
  P.feed({ type: 'hello', version: '0.6.21' }); P.feed({ type: 'trading', enabled: true }); P.feed(accounts); P.feed(groups);
  P.feed(agent('germanicus'));
  P.T += 5000;
  assert.strictEqual(P.fv.state().arm.state, 'unknown', 'no end of the replay since the drop');
});

test('the re-review of 94, N2: a lane reads its bench through the Multi-Account panel\'s own rule when that file is loaded', () => {
  const win = { document: {} };
  new Function('window', 'document', 'self', read('live', 'agent-core.js'))(win, win.document, win);
  const calls = [];
  win.MultiAccountCore = { lanes: (g, S) => { calls.push(g.id); return { bench: [{ name: 'EVAL-B', member: true }, { name: 'LOOSE', member: false }], active: [] }; } };
  new Function('window', 'document', 'self', read('live', 'fleet.js'))(win, win.document, win);
  const ls = win.FleetCore.lanes([evalTrader()], groups, accounts, '0.6.21', liveCards());
  assert.deepStrictEqual([calls, ls[0].seats, ls[0].benched], [['g1'], ['EVAL-A'], ['EVAL-B']], 'the panel\'s bench, not the field read here');
});

test('the re-review of 94, N3: a Sim-only lane says Kill all does not reach it; a mixed lane says how many are Sim', () => {
  const ls = [{ stage: 'eval', title: 'Eval lane', armable: true, name: 'L1', pickText: 'germ', seats: ['A', 'B'], benched: [], sim: true, simCount: 2, connected: true },
    { stage: 'funded', title: 'Funded lane', armable: true, name: 'L2', pickText: 'duo', seats: ['C', 'D'], benched: [], sim: false, simCount: 1, connected: true }];
  const w = F.armWords(ls);
  assert.match(w, /on 2 Sim accounts \(Kill all does not reach Sim accounts: Armed off does\)/);
  assert.match(w, /trades duo on 2 accounts, 1 Sim\./);
});

test('the re-review of 94, N5: without the page\'s mode rules, Armed says it cannot switch from here, never "nothing to switch off"', t => {
  timers(t);
  const P = page(t, {}, { noAgentCore: true });
  P.fv.showTab(true);
  P.feed({ type: 'hello', version: '0.6.21' }); P.feed({ type: 'trading', enabled: true }); P.feed(accounts); P.feed(groups);
  P.feed(evalTrader({ mode: 'auto' })); P.feed(fundTrader()); P.replayDone();
  assert.strictEqual(P.fv.state().arm.state, 'partly', 'a lane in Auto: something to switch off');
  P.click('arm');
  assert.deepStrictEqual(P.posts, []);
  assert.match(P.part('armsaid').textContent, /cannot switch off from here: the page is incomplete/);
  assert.doesNotMatch(P.part('armsaid').textContent, /nothing to switch off/);
});

test('the re-review of 94, N6: the day stop mark says it is the page\'s own working', t => {
  timers(t);
  const P = page(t); P.fv.showTab(true); P.ready();
  assert.match(P.part('accounts').innerHTML, /The mark shown is worked out on this page from the group's rules and the plan's value; ChartBridge's own mark is not sent to the page yet\./);
});

