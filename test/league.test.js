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
  assert.equal(L.cleanDay({ folder: { set: false } }).problem, 'The league\'s folder is not set on The Desk (Lab, Shadow league, on WORK).');
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

test('the page: League in the top bar after the Agent tab; the Bot button kept (1.36.0: no Bot panel); the ⋯ switch; nothing that trades', () => {
  const html = read('live/index.html');
  assert.match(html, /id="wsLeagueTab"[^>]*>League<\/button>/);
  assert.match(html, /<div id="wsTabHold" hidden>\s*<!--[^>]*-->\s*<button[^>]*id="wsBotTab"[^>]*>Bot<\/button>\s*<\/div>/, 'the Bot\'s own button waits in the hold');
  assert.match(html, /<button type="button" class="ws-btn ag-tabbtn" id="wsAgentTab" aria-pressed="false" hidden>Agent<\/button>\s*<button[^>]*id="wsLeagueTab"/, 'the Agent tab stays in the top bar, League after it');
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
