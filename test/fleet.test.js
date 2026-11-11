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
  assert.match(html, /<button type="button" class="ws-btn fl-tabbtn" id="wsFleetTab" aria-pressed="false"[^>]* hidden>Bots<\/button>/, 'hidden until ChartBridge says it knows Kill all');
  assert.match(html, /<section class="fl-view fl-in-ws" id="flView" aria-label="Bots tab"><\/section>/);
  assert.ok(html.indexOf('<script src="fleet.js"></script>') > 0 && html.indexOf('<script src="fleet.js"></script>') < html.indexOf('<script src="workspace.js"'), 'loaded before workspace.js');
  const files = JSON.parse(read('nt8', 'install-files.json'));
  assert.ok(files.www.some(x => x.from === 'live/fleet.js' && x.to === 'fleet.js') && files.www.some(x => x.from === 'live/fleet.css' && x.to === 'fleet.css'), 'installed on the PCs with the page');
  for (const id of ['wsAgentTab', 'wsLeagueTab', 'wsBotTab']) assert.ok(html.includes('id="' + id + '"'), id + ' is still there: Bots replaces none of them yet');
  assert.match(ws, /startBot\(\); startAgent\(\); startLeague\(\); startFleet\(\);/);
  assert.strictEqual((ws.match(/fleetView && fleetView\.shown\(\)\) fleetView\.showTab\(false\);/g) || []).length, 5, 'closed by each other tab, a layout tab and a layout change: one view at a time');
  // the only message the view posts is Kill all, and only after the question's Yes
  const posts = src.match(/V3\.post\([^;]*\)/g) || [];
  assert.deepStrictEqual(posts, ['V3.post(C.killAllMsg(S.pending))']);
  assert.match(src, /else if \(b\.dataset\.do === 'yes'\) \{ if \(S\.ask\) killAll\(\); \}/, 'Yes counts only while the question is up');
  assert.match(src, /const st = C\.killAllState\(S\.version, S\.accounts, S\.signedIn, S\.connected\);\s*endAsk\(\);\s*if \(!st\.ok\)/, 'checked again at the moment it is sent');
  // the only request it makes is GET /roster, with no body; it stores nothing
  assert.deepStrictEqual(src.match(/doFetch\([^)]*\)/g), ["doFetch('/roster', { cache: 'no-store', headers: h || {} })"]);
  assert.ok(!/method:|body:|localStorage|sessionStorage|XMLHttpRequest|WebSocket\(/.test(src.slice(src.indexOf('the tab (browser only)'))), 'a plain GET: no body, nothing stored, no other connection');
  assert.match(ws, /tabUrl\(on \? 'bots' : ''\);/); assert.match(ws, /\.get\('tab'\) === 'bots'\) fleetView\.showTab\(true\);/);
  assert.match(src, /<span class="fl-title">Bots<\/span>/);
  for (const word of ["type: 'order'", "type: 'flatten'", "type: 'agentMode'", "type: 'agentRules'", "type: 'agentKill'", 'accountPersonal'])
    assert.ok(!src.includes(word), 'no ' + word + ' in the Bots tab');
  assert.ok(!/confirm\(|alert\(|prompt\(/.test(src), 'no browser dialog');
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
  assert.deepStrictEqual([z.recordText, z.evidenceText, z.verdict], ['Run run-7: 240 sessions, 198 trades, MNQ', 'In-sample, not confirmed; try 3', 'made-up verdict']);
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
  assert.deepStrictEqual([q.quick, q.evidenceText, q.recordText], [true, 'In-sample, not confirmed; try count not known', 'Run r: 1 session, 1 trade']);
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
  assert.deepStrictEqual([F.ROSTER_MIN, F.ROSTER_FORMAT, F.LINEUP_FORMAT], ['0.6.20', 'specrunner.roster/1', 'specrunner.lineup/1']);
  const cs = read('nt8', 'ChartBridgeAgents.cs');
  assert.ok(cs.includes('specrunner\\\\.(roster|lineup)/1') || (cs.includes('specrunner.roster/1') && cs.includes('specrunner.lineup/1')), 'ChartBridge serves exactly these two formats');
  assert.match(cs, /if \(ctx\.Request\.Headers\["Host"\] != "localhost:" \+ ChartBridgeConfig\.Port\) \{ Answer\(ctx, 403\); return; \}/, 'the 403 the tab explains');
  assert.match(cs, /if \(json == null && why == null\) \{ Answer\(ctx, 404\); return; \}/, 'the 404 the tab explains');
});

test('roster: the view asks once when the tab opens, drops a late answer, never asks an older ChartBridge, and forgets on a lost connection', async () => {
  const src = read('live', 'fleet.js');
  // the view half runs only in a browser: a small stand-in document, enough for create()
  const listeners = {}, mk = () => ({ innerHTML: '', hidden: true, dataset: {}, addEventListener: (k, f) => { listeners[k] = f; }, removeEventListener() {}, setAttribute() {}, querySelector: () => null });
  const win = { document: {} }; const view = mk(), tab = mk();
  new Function('window', 'document', 'self', src)(win, win.document, win);
  let subs = null; const asks = []; let answers = [];
  const V3 = { listen: h => { subs = h; return () => {}; }, post: () => true };
  const fv = win.FleetView.create({ view, tab, v3: V3, fetch: (u, o) => { asks.push([u, o]); return new Promise(res => answers.push(res)); } });
  const tick = () => new Promise(r => setImmediate(r));
  fv.showTab(true);
  assert.strictEqual(asks.length, 0, 'not connected: nothing asked');
  subs.message({ type: 'hello', version: '0.6.19' });
  assert.deepStrictEqual([asks.length, fv.state().roster.state], [0, 'old']);
  assert.match(view.innerHTML, /The roster needs ChartBridge 0\.6\.20 or later \(this one is 0\.6\.19\)/);
  subs.message({ type: 'hello', version: '0.6.20' }); subs.message({ type: 'hello', version: '0.6.20' });
  await tick();
  assert.deepStrictEqual([asks.length, asks[0][0], asks[0][1].cache, fv.state().roster.state], [1, '/roster', 'no-store', 'loading'], 'two hellos (the page hands it over twice): one ask');
  fv.reloadRoster(); await tick();
  assert.strictEqual(asks.length, 2);
  answers[0]({ status: 200, json: () => Promise.resolve({ files: [served('late.json', botFile('late'))] }) }); await tick(); await tick();
  assert.deepStrictEqual(fv.state().roster.bots, [], 'the answer of the older ask is dropped');
  answers[1]({ status: 200, json: () => Promise.resolve({ files: [served('now.json', botFile('now'))] }) }); await tick(); await tick();
  assert.deepStrictEqual([fv.state().roster.state, fv.state().roster.bots], ['ok', ['now']]);
  assert.match(view.innerHTML, /data-name="now"/);
  subs.closed();
  assert.deepStrictEqual([fv.state().roster.state, fv.state().roster.bots], ['idle', []]);
  assert.doesNotMatch(view.innerHTML, /data-name="now"/, 'connection lost: no stale roster');
  // a bot name with markup in a "why" is shown as text
  subs.message({ type: 'hello', version: '0.6.20' }); await tick();
  answers[2]({ status: 200, json: () => Promise.resolve({ files: [{ name: 'x.json', ok: false, why: '<img src=x onerror=1>' }] }) }); await tick(); await tick();
  assert.ok(view.innerHTML.includes('&lt;img src=x onerror=1&gt;') && !view.innerHTML.includes('<img'), 'escaped');
});
