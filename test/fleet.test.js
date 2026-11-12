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
  assert.match(F.killAllState('0.6.19', null, true, true).why, /No personal account is picked yet/);
  assert.match(F.killAllState('0.6.19', accounts, true, false).why, /not connected/);
  assert.deepStrictEqual(F.killAllMsg('c1'), { type: 'agentKillAllProp', cid: 'c1' });
  assert.deepStrictEqual(F.killAllMsg(), { type: 'agentKillAllProp' });
  assert.match(read('nt8', 'ChartBridgeAgents.cs'), /\{ "agentKillAllProp", new\[\] \{ "type", "cid" \} \},/, 'ChartBridge takes exactly these keys');
});

test('fleet: dollars', () => {
  assert.deepStrictEqual([F.usd(1200), F.usd(-310), F.usd(310, true), F.usd(0, true), F.usd(155.5), F.usd(null), F.usd(NaN)], ['$1,200', '-$310', '+$310', '$0', '$155.50', '', '']);
});

test('legion: the tab is wired into the page beside the other three, with a connection that can post one message only', () => {
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
  // N5: the tab is not handed the feed. Its connection is built here and run: it passes agentKillAllProp with a cid and nothing else
  const m = /const legionLink = (\{[^\n]*\});\n/.exec(ws);
  assert.ok(m, 'the tab\'s own connection is one line in workspace.js');
  assert.match(ws, /tab: \$\('wsFleetTab'\), v3: legionLink, headers:/, 'and it is what the tab gets, not AF');
  const posted = [], heard = [];
  const AF = { listen: part => { heard.push(part); return () => {}; }, post: x => { posted.push(x); return true; }, send: () => { throw new Error('send reached'); }, sendOrder: () => { throw new Error('sendOrder reached'); } };
  const link = new Function('AF', 'return ' + m[1])(AF);
  assert.deepStrictEqual(Object.keys(link).sort(), ['listen', 'post'], 'two things only: no send, no sendOrder');
  assert.strictEqual(link.post({ type: 'agentKillAllProp', cid: 'c1' }), true);
  assert.strictEqual(link.post({ type: 'agentKillAllProp' }), true);
  for (const bad of [{ type: 'agentMode', agent: 'x', mode: 'auto' }, { type: 'order' }, { type: 'flatten' }, { type: 'agentKill', agent: 'x', on: false }, { type: 'agentKillAllProp', cid: 'c', account: 'A' }, { type: 'accountPersonal' }, { cid: 'c' }, null, 'agentKillAllProp', []])
    assert.strictEqual(link.post(bad), false, JSON.stringify(bad) + ' is not passed on');
  assert.deepStrictEqual(posted, [{ type: 'agentKillAllProp', cid: 'c1' }, { type: 'agentKillAllProp' }]);
  link.listen('part'); assert.deepStrictEqual(heard, ['part']);
  assert.strictEqual(link.post.call({ post: () => true }, { type: 'order' }), false);
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
const served = (name, roster) => ({ name, ok: true, roster });

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
function page(t, over) {
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
  new Function('window', 'document', 'self', read('live', 'fleet.js'))(win, win.document, win);
  const P = { T: 1_800_000_000_000, posts: [], asks: [], answers: [], subs: null, view, tab, part: k => view.querySelector('[data-k="' + k + '"]') };
  const V3 = { listen: h => { P.subs = h; return () => {}; }, post: m => { P.posts.push(m); return P.postOk !== false; } };
  P.fv = win.FleetView.create(Object.assign({ view, tab, v3: V3, now: () => P.T, fetch: (u, o) => { P.asks.push([u, o]); return new Promise((res, rej) => P.answers.push({ res, rej })); } }, over || {}));
  P.feed = m => P.subs.message(m);
  P.click = (what, detail, card) => listeners.click({ target: { closest: () => ({ dataset: { do: what, card } }) }, detail: detail === undefined ? 1 : detail });
  P.html = () => view.innerHTML + ['roster', 'traders', 'accounts'].map(k => P.part(k).innerHTML).join('');
  P.ready = v => { P.feed({ type: 'hello', version: v || '0.6.20' }); P.feed({ type: 'trading', enabled: true }); P.feed(accounts); P.feed(groups); P.feed(agent('germanicus')); };
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
  assert.deepStrictEqual([P.posts, P.fv.state().asking], [[], true], 'Yes 100 ms after the question opened: no answer');
  P.T += 499; P.click('yes');
  assert.deepStrictEqual(P.posts, [], 'and at 599 ms');
  P.T += 200; P.click('yes', 2);
  assert.deepStrictEqual([P.posts, P.fv.state().asking], [[], true], 'the second click of a double click, even late: no answer');
  P.click('no', 2);
  assert.strictEqual(P.fv.state().asking, true, 'nor does it cancel: the question stays for a real answer');
  P.click('yes');
  assert.strictEqual(P.posts.length, 1);
  assert.deepStrictEqual([Object.keys(P.posts[0]).sort(), P.posts[0].type, typeof P.posts[0].cid, P.fv.state().asking], [['cid', 'type'], 'agentKillAllProp', 'string', false]);
  P.click('yes'); P.click('yes');
  assert.strictEqual(P.posts.length, 1, 'Yes on the old question sends nothing more');
  // the 8 seconds are compared at the Yes: with the timer held back (a window in the background, a PC that slept) Yes is too late
  P.click('ask'); P.T += F.CONFIRM_MS + 1; P.click('yes');
  assert.deepStrictEqual([P.posts.length, P.fv.state().asking], [1, false], 'Yes after 8 seconds by the clock: nothing sent, the question gone');
  // and the timer alone ends it
  P.click('ask'); assert.strictEqual(P.fv.state().asking, true);
  t.mock.timers.tick(F.CONFIRM_MS + 1);
  assert.deepStrictEqual([P.fv.state().asking, P.part('ask').hidden, P.part('kill').hidden], [false, true, false], 'the question times out by itself');
  // Cancel
  P.click('ask'); P.T += 700; P.click('no');
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
  P.feed({ type: 'hello', version: '0.6.20' }); P.feed({ type: 'trading', enabled: true });
  P.feed({ type: 'accounts', personalNamed: true, list: [{ name: 'A' + X, connection: X, prop: true, group: 'g1', pnlToday: 1, roomFloor: null, why: { roomFloor: X }, rules: { target: 3000, consistency: 40 }, positions: [{ root: X, qty: 1 }] }] });
  P.feed({ type: 'groups', list: [{ id: 'g1', name: X, accountType: 'eval' }] });
  P.feed(agent('t1', { name: X, build: X, account: 'A' + X, standDown: X, rules: { entryFrom: X, entryUntil: X, flatAt: X } }));
  P.feed(agent('t2', { name: 'n', account: null, group: { id: X, name: X }, seats: [{ account: X }] }));
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
  // Kill all, Yes, Cancel, Read again and a Details on each card: nothing else can be pressed, typed in or switched (no Armed
  // control until D2 adds the real one)
  const pressable = html.match(/<(button|input|select|textarea|a|details|summary|label)\b[^>]*>/g) || [];
  assert.deepStrictEqual(pressable.map(x => (/data-do="([a-z]+)"/.exec(x) || [])[1]).sort(), ['ask', 'more', 'more', 'no', 'roster', 'yes'], 'exactly Kill all, Yes, Cancel, Read again and two Details: ' + pressable.join(' '));
  assert.ok(pressable.every(x => x.startsWith('<button type="button"')));
  assert.ok(!/contenteditable|tabindex|onclick|role="(switch|checkbox|slider)"/i.test(html));
  assert.match(html, /Not built yet, so not shown: .*the one Armed slider/);
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
