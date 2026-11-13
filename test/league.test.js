// The League tab (chart 1.35.0, Anthony 2026-10-21): live/league.js's pure part (LeagueCore): The Desk's league day as the page
// reads it, the marks on a chart, the decision log, the seats' day, the week and month table, the spend; and the page's wiring
// (the League tab in the top bar, the agent desk and the Bot as panels, the ⋯ switch, nothing that trades). SAMPLE data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../live/league.js');
const W = require('../live/workspace.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const T = 1792664400000;   // made-up wall ms as if UTC
const day = {
  shadow: 'SHADOW: no orders', folder: { set: true, ok: true, problem: null }, date: '2026-10-22',
  status: { date: '2026-10-22', now: '10:31:05', feed: 'live', seats: { S: { status: 'active', flag: null, decisions: 12, entries: 1, flex: { phase: 'eval', balance: 50120, today_pnl: 40 }, position: { side: 'long', contracts: 3, fill_px: 25010.25 } } },
    spend: { day_spent: 3, day_cap: 9.5, month_spent: 12.25, month_cap: 200, stopped: null } },
  trades: [{ id: 'a', seat: 'H', side: 'short', contracts: 5, fill_t: T, fill_px: 25000, stop_px: 25015, target_px: 24970, exit_t: T + 600000, exit_px: 24970, r: 1.97, relation: 'with' },
    { id: 'b', seat: 'X', side: 'long', fill_t: T, fill_px: 1 }, { id: 'c', seat: 'O', side: 'long', fill_t: null, fill_px: 25000 }],
  open: [{ id: 'd', seat: 'S', side: 'long', contracts: 3, fill_t: T + 900000, fill_px: 25010.25, stop_px: 24985.25, target_px: null }],
  decisions: [{ seat: 'H', time: '09:39:58', call_ok: true, refused: null, latency_s: 2, answer: { action: 'enter', side: 'short', stop_points: 15, target_points: 30, reference: 'VWAP', reasoning: 'r' }, relation: 'with', contracts: 5 },
    { seat: 'S', time: '09:45:00', call_ok: true, refused: null, latency_s: 4, answer: { action: 'pass', reasoning: 'no edge' } },
    { seat: 'O', time: '09:50:00', call_ok: true, refused: 'stop wider than 25 points', answer: { action: 'enter' } },
    { seat: 'O', time: '09:55:00', call_ok: false }, { seat: 'Z', time: '09:56:00', call_ok: true }],
};

test('the seats: H Haiku amber, S Sonnet cyan, O Opus violet; SHADOW: no orders', () => {
  assert.deepEqual(L.SEATS.map(s => [s.id, s.family, s.color]), [['H', 'Haiku', '#FFC266'], ['S', 'Sonnet', '#5DE0F0'], ['O', 'Opus', '#B69CFF']]);
  assert.equal(L.SHADOW, 'SHADOW: no orders');
});

test('The Desk\'s day as read: bad trades dropped, open ones kept open; no folder or no session said plainly', () => {
  const d = L.cleanDay(day);
  assert.deepEqual(d.trades.map(t => t.id), ['a']);
  assert.deepEqual(d.open.map(t => [t.id, t.open, t.exitT]), [['d', true, null]]);
  assert.equal(d.decisions.length, 4);
  /* The Desk on HOMESERVER reads the copy WORK's League Mirror posts: set false, ok true, source mirror is no problem */
  assert.equal(L.cleanDay({ folder: { set: false, ok: true, problem: null, source: 'mirror' } }).problem, '', 'the mirror: no warning');
  assert.equal(L.cleanDay(Object.assign({}, day, { folder: { set: false, ok: true, problem: null, source: 'mirror' } })).trades.length, 1, 'the mirror: the day as read');
  /* nothing to read: The Desk's own words, trimmed to 200 */
  const none = 'The league\'s folder is not set, and no league files have arrived from WORK yet.';
  assert.equal(L.cleanDay({ folder: { set: false, ok: false, problem: none, source: null } }).problem, none);
  assert.equal(L.cleanDay({ folder: { set: false, ok: false, problem: 'x'.repeat(300) } }).problem, 'x'.repeat(200));
  assert.equal(L.cleanDay({ folder: { set: true, ok: false, problem: 'The league\'s folder is set but cannot be found on this PC.' } }).problem, 'The league\'s folder is set but cannot be found on this PC.');
  /* an older Desk (set false, no ok, no problem): the page's own sentence, never "set a folder on WORK" */
  const old = L.cleanDay({ folder: { set: false } }).problem;
  assert.equal(old, 'No league files have reached The Desk yet.');
  assert.doesNotMatch(old, /WORK|folder/);
  assert.equal(L.cleanDay({ folder: { set: false, ok: false, problem: null } }).problem, 'No league files have reached The Desk yet.', 'ok false with no text: the same sentence');
  assert.equal(L.cleanDay({ folder: { set: true, ok: true, problem: 'The league has no session yet.' } }).problem, 'The league has no session yet.');
  assert.equal(L.cleanDay(null).problem, 'The Desk sent nothing the page can read.');
});

test('the marks: a hollow fill and exit per trade with its letter and colour, faint stop and target lines; MNQ and NQ only', () => {
  const m = L.marksFor(L.cleanDay(day), 'MNQ');
  assert.deepEqual(m.marks.map(k => [k.seat, k.kind, k.t, k.price, k.color]), [['H', 'entry', T / 1000, 25000, '#FFC266'], ['H', 'exit', (T + 600000) / 1000, 24970, '#FFC266'], ['S', 'entry', (T + 900000) / 1000, 25010.25, '#5DE0F0']]);
  assert.deepEqual(m.lines.map(l => [l.seat, l.kind, l.t1, l.price]), [['H', 'stop', (T + 600000) / 1000, 25015], ['H', 'target', (T + 600000) / 1000, 24970], ['S', 'stop', null, 24985.25]], 'an open trade\'s lines run to the right edge');
  assert.deepEqual(L.marksFor(L.cleanDay(day), 'NQ').marks.length, 3, 'NQ: the same prices');
  assert.deepEqual(L.marksFor(L.cleanDay(day), 'ES'), { marks: [], lines: [] }, 'ES: nothing');
  const bars = [{ t: 100 }, { t: 160 }, { t: 220 }];
  assert.deepEqual([L.barIndex(bars, 99), L.barIndex(bars, 100), L.barIndex(bars, 200), L.barIndex(bars, 999)], [-1, 0, 1, 2]);
});

test('the decision log, newest first, in words', () => {
  const rows = L.decisionRows(L.cleanDay(day).decisions);
  assert.deepEqual(rows.map(r => [r.seat, r.kind, r.text]), [
    ['O', 'failed', 'no answer (the call failed)'],
    ['O', 'refused', 'refused: stop wider than 25 points'],
    ['S', 'pass', 'passed: no edge'],
    ['H', 'enter', 'short 5 MNQ, stop 15 pt, target 30 pt at VWAP: r (with you)']]);
});

test('the seats\' day, the week and month table and the spend', () => {
  const s = L.seatDays(L.cleanDay(day));
  assert.deepEqual(s.map(x => [x.seat, x.line, x.n]), [['H', 'not reported', 1], ['S', 'LONG 3 MNQ from 25010.25', 0], ['O', 'not reported', 0]]);
  assert.equal(s[0].todayR, 1.97);
  const lg = { enough_n: 20, seats: { H: { score: { n: 24, mean_r: 0.12, enough: true }, rolling: { week: { n: 4, mean_r: 0.5, enough: false }, month: { n: 24, mean_r: 0.12, enough: true } }, mentor: { agreement: 0.75 }, latency: { n: 40, median_s: 3.2 } } } };
  const t = L.standingRows(lg);
  assert.deepEqual([t[0].week, t[0].month, t[0].agreement, t[0].latency], ['not enough data yet (n 4 of 20)', '+0.12 R (n 24)', '75%', '3.2 s median (n 40)']);
  assert.deepEqual([t[1].week, t[1].agreement], ['n 0', 'none yet']);
  assert.deepEqual(L.spendText(day.status.spend), { day: '$3.00 of $9.50', month: '$12.25 of $200.00', stopped: '' });
  assert.equal(L.spendText({ day_spent: 9.5, day_cap: 9.5, stopped: 'the daily cap of $9.50 is reached' }).stopped, 'API stopped: the daily cap of $9.50 is reached');
  assert.deepEqual(L.cleanGhosts('{"c1":true,"c2":false,"c3":"yes"}'), { c1: true });
});

test('the page: the Colosseum (1.50.0, was League) in the top tabs; the Bot button kept (1.36.0: no Bot panel); the ⋯ switch; nothing that trades', () => {
  const html = read('live/index.html');
  assert.match(html, /id="wsLeagueTab"[^>]*>Colosseum<\/button>/);
  assert.match(html, /<div id="wsTabHold" hidden>\s*<!--[^>]*-->\s*<button[^>]*id="wsBotTab"[^>]*>Bot<\/button>\s*<\/div>/, 'the Bot\'s own button waits in the hold');
  assert.match(html, /id="wsLeagueTab"[^>]*>Colosseum<\/button>\s*<!--[^>]*-->\s*<span class="pr-tabs" id="wsPrGroup"[^>]*>\s*<button[^>]*id="wsPraetorianTab"[^>]*>Praetorian<\/button>\s*<!--[^>]*-->\s*<button type="button" class="ws-btn ag-tabbtn" id="wsAgentTab" aria-pressed="false" hidden>Agent<\/button>\s*<span class="ws-tabslot" id="wsTabSlot"><\/span>/, '1.51.0: after the Colosseum, Praetorian with its two sides, the Agent desk\'s own button and the Bot\'s slot');
  assert.doesNotMatch(html, /data-add="agentdesk"/, 'no agent panel');
  assert.doesNotMatch(html, /data-add="bot"/, '1.36.0: no Bot panel (merged into the Agents strip)');
  assert.match(html, /data-do="league" hidden>League trades \(faint\): off<\/button>/);
  assert.ok(html.indexOf('<script src="league.js"></script>') < html.indexOf('<script src="workspace.js"></script>'));
  assert.ok(!W.TYPES.includes('bot') && !W.TYPES.includes('agentdesk'));
  const old = W.cleanLayout({ panels: [{ id: 'c1', type: 'chart', root: 'MNQ', tf: 'm1', x: 0, y: 0, w: 4, h: 2 }, { id: 'b1', type: 'bot', x: 4, y: 0, w: 2, h: 1 }] });
  assert.deepEqual(old.panels.map(p => p.id), ['c1'], '1.36.0: a saved layout with a Bot panel opens without it');
  const files = JSON.parse(read('nt8/install-files.json'));
  assert.ok(files.www.some(x => x.from === 'live/league.js') && files.www.some(x => x.from === 'live/league.css'));
  const src = read('live/league.js');
  assert.doesNotMatch(src, /type: ?'(order|change|cancel|flatten|plan)'|\.send\(JSON|method: ?'(POST|PUT)'/, 'a read only');
  assert.match(src, /'\/api\/chart-league'/);
  for (const f of ['live/league.js', 'live/league.css', 'test/league.test.js', 'test/league-smoke.mjs', 'test/tab-buttons.mjs']) assert.doesNotMatch(read(f), /[\u2013\u2014]/, f + ': no em or en dashes');
  const css = read('live/league.css');
  assert.doesNotMatch(css, /--ws-buy|--ws-sell/, 'no green or red in the league view');
});

test('1.36.0: the decision log shows a rest as a resting order, never as an entry; a cancel as its cancel', () => {
  const d = (id, answer, extra) => Object.assign({ id, seat: 'O', time: '11:23:42', call_ok: true, refused: null, answer }, extra || {});
  const rows = L.decisionRows([d('a', { action: 'rest', side: 'short', stop_points: 6, target_points: 15, reference: 'IBL', reasoning: 'Sample: retest from below' }, { contracts: 12 }),
    d('b', { action: 'cancel', reasoning: 'Sample: the level is gone' }), d('c', { action: 'enter', side: 'long', stop_points: 10, target_points: 20 })]);
  assert.deepEqual(rows.map(r => r.kind), ['enter', 'cancel', 'rest']);
  assert.equal(rows[2].text, 'rest short at IBL, stop 6 pt, target 15 pt, good until not reported: Sample: retest from below');
  assert.match(rows[1].text, /^cancelled its resting order: Sample/);
});

test('a past day (?tab=league&day=YYYY-MM-DD): the date checked first; today or no day is the live view; a bad day said plainly', () => {
  assert.deepEqual(L.checkDay(null, '2026-10-31'), { ok: true, day: null, problem: '' });
  assert.deepEqual(L.checkDay('', '2026-10-31'), { ok: true, day: null, problem: '' });
  assert.deepEqual(L.checkDay('2026-10-31', '2026-10-31'), { ok: true, day: null, problem: '' }, 'today is the live view');
  assert.deepEqual(L.checkDay('2026-10-22', '2026-10-31'), { ok: true, day: '2026-10-22', problem: '' });
  for (const bad of ['2026-1-22', '22-10-2026', '2026-10-22x', '../x', '2026-10-22T00:00', 'today']) {
    const c = L.checkDay(bad, '2026-10-31');
    assert.equal(c.ok, false, bad); assert.equal(c.day, null); assert.match(c.problem, /not a date \(YYYY-MM-DD\)\. Showing today\.$/);
  }
  assert.match(L.checkDay('2026-02-30', '2026-10-31').problem, /2026-02-30, which is not a calendar date/);
  assert.match(L.checkDay('2026-13-01', '2026-10-31').problem, /not a calendar date/);
  assert.match(L.checkDay('1999-12-31', '2026-10-31').problem, /not a calendar date/);
  assert.match(L.checkDay('2026-11-03', '2026-11-02').problem, /2026-11-03, which is after the current session \(2026-11-02\)\. Showing today\./);
  assert.match(L.checkDay('<b>x</b>', '2026-10-31').problem, /"\?b\?x\?\?b\?"/, 'nothing of the link shown as markup');
  /* review LOW 1: "today" is the league's session date (manrae.live.session_date): New York time, from 17:00 the next date,
     a Saturday or Sunday rolls to Monday */
  const ny = (mo, d, h, mi) => Date.UTC(2026, mo - 1, d, h + 4, mi || 0);   // EDT (UTC-4) until 2026-11-01
  assert.equal(L.sessionToday(ny(10, 29, 16, 59)), '2026-10-29', 'Thursday 16:59: the Thursday session');
  assert.equal(L.sessionToday(ny(10, 29, 17, 0)), '2026-10-30', 'Thursday 17:00: the Friday session');
  assert.equal(L.sessionToday(ny(10, 30, 16, 0)), '2026-10-30');
  assert.equal(L.sessionToday(ny(10, 30, 17, 30)), '2026-11-02', 'Friday 17:30: the weekend rolls to Monday');
  assert.equal(L.sessionToday(ny(10, 31, 12, 0)), '2026-11-02', 'Saturday: Monday');
  assert.equal(L.sessionToday(Date.UTC(2026, 10, 1, 22, 30)), '2026-11-02', 'Sunday 17:30 EST: Monday');
  /* the session that just closed opens as a past day after 17:00; the current session's date is the live view, never refused */
  const thu1730 = L.sessionToday(ny(10, 29, 17, 30));
  assert.deepEqual(L.checkDay('2026-10-29', thu1730), { ok: true, day: '2026-10-29', problem: '' }, 'after 17:00 the session that just closed is a past day');
  assert.deepEqual(L.checkDay('2026-10-30', thu1730), { ok: true, day: null, problem: '' }, 'the current session (dated tomorrow) is the live view');
  assert.deepEqual(L.checkDay('2026-10-30', L.sessionToday(ny(10, 31, 12, 0))), { ok: true, day: '2026-10-30', problem: '' }, 'on Saturday Friday is past');
  /* a bar's session: 18:00 New York opens the next date's session, the weekend rolls to Monday */
  const at = (mo, d, h) => Date.UTC(2026, mo - 1, d, h) / 1000;   // chart seconds: New York wall time as if UTC
  assert.equal(L.sessionOfBar(at(10, 29, 9)), '2026-10-29');
  assert.equal(L.sessionOfBar(at(10, 29, 18)), '2026-10-30');
  assert.equal(L.sessionOfBar(at(11, 1, 18)), '2026-11-02', 'the Sunday 18:00 open: Monday');
});

test('a past day: the live status is left out (it is today\'s, never that day\'s); an empty day says not enough data', () => {
  const p = L.cleanDay(day, true);
  assert.equal(p.status, null);
  assert.equal(p.past, true);
  assert.equal(p.trades.length, 1, 'the day\'s own trades stay');
  const seats = L.seatDays(p);
  assert.ok(seats.every(s => s.line === 'past day: the live status is not kept per day' && s.account === '' && s.flag === ''));
  assert.equal(L.cleanDay(day).status.date, '2026-10-22', 'the live day keeps its status');
  assert.equal(L.pastEmpty(p), false);
  const none = L.cleanDay({ folder: { set: true, ok: true }, date: '2026-10-19', trades: [], open: [], decisions: [] }, true);
  assert.equal(L.pastEmpty(none), true);
  assert.equal(L.emptyText('2026-10-19'), 'No league record for 2026-10-19: no paper trade and no decision. Not enough data to show that day.');
});

test('a past day on the chart: in the chart only if a bar of that session (18:00 of the day before to 17:00) is there', () => {
  const s = (y, m, d, h) => Date.UTC(y, m - 1, d, h) / 1000;
  const bars = [{ t: s(2026, 10, 26, 18) }, { t: s(2026, 10, 30, 15) }];   // the first bar opens the 10-27 session
  assert.deepEqual(L.chartReach(bars, '2026-10-22'), { reach: 'before', first: '2026-10-27' });
  assert.deepEqual(L.chartReach(bars, '2026-10-26'), { reach: 'before', first: '2026-10-27' }, 'review LOW 3: a bar at 18:00 on the 26th is the 27th\'s session, not the 26th\'s');
  assert.deepEqual(L.chartReach(bars, '2026-10-27'), { reach: 'in', first: '2026-10-27' });
  assert.deepEqual(L.chartReach(bars, '2026-10-28'), { reach: 'missing', first: '2026-10-27' }, 'no bar of that session in the history');
  assert.deepEqual(L.chartReach(bars, '2026-10-30'), { reach: 'in', first: '2026-10-27' });
  assert.deepEqual(L.chartReach([{ t: s(2026, 10, 29, 17) }, { t: s(2026, 10, 29, 18) }], '2026-10-29'), { reach: 'before', first: '2026-10-30' }, 'a bar in the 17:00 break belongs to the next session');
  assert.deepEqual(L.chartReach([], '2026-10-28'), { reach: 'none', first: '' });
  assert.deepEqual(L.chartReach(bars, 'x'), { reach: 'none', first: '' });
});

test('a past day: the page wiring (the address, read only, never on the live charts)', () => {
  const src = read('live/league.js'), ws = read('live/workspace.js');
  assert.match(src, /'\/api\/chart-league' \+ \(past \? '\?date=' \+ encodeURIComponent\(past\) : ''\)/);
  assert.match(src, /if \(past && d\.date !== past\)/, 'review LOW 2: an answer with no date, or another date, is never shown as the past day');
  assert.match(src, /C\.sessionToday\(\)/, 'today is the league\'s session date');
  assert.match(src, />Back to today<\/button>/);
  assert.match(src, /'Past day ' \+ past \+ ' · read only'/);
  assert.match(ws, /leagueView\.openDay\(new URLSearchParams\(location\.search\)\.get\('day'\)\)/);
  assert.match(ws, /const leagueGhostDay = \(\) => \(leagueView && leagueView\.shown\(\) && leagueView\.liveDay\(\)\) \|\| LG\.day;/);
  assert.doesNotMatch(ws, /LG\.day = leagueView\.day\(\)/, 'a past day never becomes the faint marks\' day');
});

/* ---------------------------------------------------------------- 1.57.0: the leaderboard (part F) */
const board = (programs, today) => L.cleanBoard({ v: 1, today: today || '2026-11-13', since: '2026-10-16', programs });
const prog = (id, kind, days, more) => Object.assign({ id, kind, source: 'agents', build: kind === 'bot' ? 'spec runner:ab' : 'b1', mode: 'shadow', last_day: days[0] ? days[0].date : '', days, today: [], diary: '' }, more || {});
const dayOf = (date, r, trades, more) => Object.assign({ date, r, trades: trades === undefined ? 1 : trades, pnl: 10, mode: 'shadow', spent_usd: null, paper: true }, more || {});

test('leaderboard: The Desk\'s answer is read strictly; a program not in the shape is left out', () => {
  assert.strictEqual(L.cleanBoard(null).ok, false);
  assert.strictEqual(L.cleanBoard({ v: 2, programs: [] }).ok, false);
  const b = board([prog('a', 'agent', [dayOf('2026-11-13', 1)]), { id: 'x', kind: 'robot', days: [] }, { id: '', kind: 'bot', days: [] }, prog('b', 'bot', [dayOf('bad', 1), dayOf('2026-11-12', 'x'), dayOf('2026-11-11', 2)])]);
  assert.deepStrictEqual(b.programs.map(p => [p.id, p.days.map(d => d.date)]), [['a', ['2026-11-13']], ['b', ['2026-11-11']]]);
});

test('leaderboard: rows mingle bots and agents; Today ranks by today\'s R, Multi-day by 20 days, the league\'s seats after; the pace word', () => {
  const days = (n, r) => Array.from({ length: n }, (_, i) => dayOf('2026-11-' + String(13 - i).padStart(2, '0'), r, 1, { spent_usd: 0.1 }));
  const b = board([
    prog('bot-up', 'bot', days(6, 1)),                                                  // 6 days, +1 a day, today +1
    prog('agent-flat', 'agent', [dayOf('2026-11-13', 2, 2, { spent_usd: 0.5 }), dayOf('2026-11-12', -3, 1, { spent_usd: 0.25 })], { diary: 'made-up thoughts' }),
    prog('bot-old', 'bot', [dayOf('2026-11-10', 9)]),                                     // no day today
  ]);
  const rows = L.boardRows(b, null, '2026-11-13');
  const by = Object.fromEntries(rows.map(r => [r.name, r]));
  assert.deepStrictEqual([by['bot-up'].todayR, by['bot-up'].r5, by['bot-up'].n5, by['bot-up'].r20, by['bot-up'].n20, by['bot-up'].pace], [1, 5, 5, 6, 6, 'no backtest pace yet']);
  assert.deepStrictEqual([by['agent-flat'].todayR, by['agent-flat'].r20, by['agent-flat'].pace], [2, -1, 'too early'], 'under 5 days: too early');
  assert.deepStrictEqual(by['agent-flat'].cost, { today: 0.5, month: 0.75, perTrade: 0.25 }, 'API cost today, this month, and a trade');
  assert.deepStrictEqual(by['agent-flat'].log, [{ time: '', text: 'made-up thoughts' }]);
  assert.strictEqual(by['bot-up'].cost, null, 'a bot has no API cost');
  assert.deepStrictEqual([by['bot-old'].todayR, by['bot-old'].todayN, by['bot-old'].status], [null, 0, 'Shadow, last day 2026-11-10']);
  assert.deepStrictEqual(L.rankBoard(rows, 'today').map(r => r.name), ['agent-flat', 'bot-up', 'bot-old'], 'Today: by today\'s R, no trade today last');
  assert.deepStrictEqual(L.rankBoard(rows, 'multi').map(r => r.name), ['bot-old', 'bot-up', 'agent-flat'], 'Multi-day: by the last 20 days');
  assert.deepStrictEqual([0, 4, 5, 20].map(n => L.paceWord('bot', n)), ['too early', 'too early', 'no backtest pace yet', 'no backtest pace yet']);
  assert.strictEqual(L.paceWord('agent', 9), 'no backtest');
});

test('leaderboard: the league\'s seats join as agents with R per trade, never added to the Desk\'s R per day; a past day has none', () => {
  const day = L.cleanDay({ date: '2026-11-13', folder: { ok: true }, status: { seats: {} }, league: { enough_n: 20, seats: { H: { rolling: { week: { n: 3 } } } } }, trades: [], open: [], decisions: [] }, false);
  const rows = L.boardRows(board([prog('bot-up', 'bot', [dayOf('2026-11-13', 1)])]), day, '2026-11-13');
  const seats = rows.filter(r => r.source === 'league');
  assert.deepStrictEqual(seats.map(r => [r.name, r.kind, r.comparable, r.pace]), [['Haiku seat (H)', 'agent', false, 'no backtest'], ['Sonnet seat (S)', 'agent', false, 'no backtest'], ['Opus seat (O)', 'agent', false, 'no backtest']]);
  assert.match(seats[0].week, /not enough data yet \(n 3 of 20\)/);
  assert.deepStrictEqual(L.rankBoard(rows, 'multi').map(r => r.source), ['desk', 'league', 'league', 'league'], 'the seats after on Multi-day');
  assert.strictEqual(L.boardRows(null, Object.assign({}, day, { past: true }), '2026-11-13').length, 0, 'a past day: no seats on the board');
  const older = L.boardRows(null, Object.assign({}, day, { date: '2026-11-12', trades: [{ seat: 'H', r: 2, crashCut: false, side: 'long', contracts: 1 }] }), '2026-11-13');
  assert.deepStrictEqual([older[0].todayR, older[0].todayN, older[0].trades.length, older[0].status], [null, 0, 0, 'Shadow league, its last session 2026-11-12'], 'the league\'s day is not today\'s: none of it counts as today');
});
