'use strict';
// Legion's Castra and the cohort model (plan step 3.3): LegionCastraCore (live/legion-castra-core.js), the two views' wiring and
// the page. Made-up answers only (test/fixtures/castra-sample.js). The pages in a browser: test/legion-castra-smoke.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const K = require('../live/legion-castra-core.js');
const L = require('../live/ludus-core.js');
const F = require('./fixtures/castra-sample.js');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const row = (name, o) => Object.assign({ name, stageText: 'Eval', cushion: 1200, cushionWhy: '', today: 35, position: 'Flat', done: false }, o || {});
const trader = (o) => Object.assign({ id: 't1', name: 'Trader One', build: 'sample_a_v1', mode: 'auto', modeText: 'Auto', tone: 'on', status: 'Watching', accounts: ['EVAL-B'], accountText: 'EVAL-B', kind: 'prop', pnlToday: 12, trades: 2 }, o || {});

test('the routes: the roster and the ledger are the Ludus\'s own; the new reads are The Desk\'s Legion routes', () => {
  assert.equal(K.ROUTES.roster, L.ROUTES.roster);
  assert.equal(K.ROUTES.ledger, L.ROUTES.ledger);
  assert.deepEqual([K.ROUTES.cohorts, K.ROUTES.members, K.ROUTES.money, K.ROUTES.centurion, K.ROUTES.board],
    ['/api/legion/cohorts', '/api/legion/cohorts/members', '/api/legion/money', '/api/legion/centurion', '/api/legion/board']);
});

test('real against simulated money: ROI first, each with its sample; "not enough data yet" with no figure; simulated is labelled', () => {
  const v = K.moneyView(F.moneyAnswer());
  assert.equal(v.ok, true);
  const [a, b, old] = v.builds;
  assert.equal(a.real.ppd, '-0.40 per $1');
  assert.equal(a.sim.eval.text, '+1.10 per $1 (range +0.20 to +2.00), simulated');
  assert.match(a.real.sample, /3 ledger entries on 2 accounts \(2 with a card\)/);
  assert.equal(b.real.ppd, 'not enough data yet', 'no costs: no figure');
  assert.equal(b.real.costs, '$0');
  assert.equal(old.onRoster, false);
  assert.equal(old.sim.eval.text, 'not enough data yet', 'no roster file: no simulated figure');
  assert.match(K.SIM_LABEL, /Simulated by the Prop Sim on in-sample days/);
  assert.equal(v.unattributed.entries, 2);
  assert.equal(K.moneyView(null).ok, false);
});

test('TheDesk #120: "could not tell" which account a card had, beside the build\'s real figure and for the whole ledger (the review of R12, B3)', () => {
  const v = K.moneyView(F.moneyAnswer());
  const [a, b] = v.builds;
  assert.equal(a.real.cardAccount, 'could not tell: 2 entries counted by the card\'s fills account now (whether the card had another account when they were booked cannot be told)');
  assert.equal(a.real.ppd, '-0.40 per $1', 'the number is still shown');
  assert.equal(b.real.cardAccount, '', 'every entry told: nothing said');
  assert.equal(K.realCells({ card_account_could_not_tell: 1, card_account_words: null }).cardAccount, 'could not tell: 1 entry counted by the card\'s fills account now (whether the card had another account when it was booked cannot be told)');
  assert.equal(K.realCells({ card_account_words: 'could not tell' }).cardAccount, 'could not tell: some entries counted by the card\'s fills account now (whether the card had another account when they were booked cannot be told)');
  assert.equal(K.realCells({}).cardAccount, '', 'a Desk from before #120: nothing');
  assert.deepEqual(v.cardLog, { couldNotTell: 2, began: '2001-03-05', note: 'made up',
    words: 'Each entry counts under the card\'s fills account when it was booked, from The Desk\'s log of each card\'s fills account, which begins on 2001-03-05 (its first trade day). Could not tell for 2 entries (booked before the log began, or a card whose log cannot be read): each is counted by the card\'s fills account now, and the card may have had another account then.' });
  const ans = F.moneyAnswer();
  assert.match(K.moneyView(Object.assign({}, ans, { by_card_account_could_not_tell: 0 })).cardLog.words, /begins on 2001-03-05 \(its first trade day\)\. Every entry could be told\.$/);
  assert.match(K.moneyView(Object.assign({}, ans, { card_account_log: { began: 'soon', note: '' } })).cardLog.words, /gives no first day \(could not tell when it began\)\./, 'a first day not a date: never shown as one');
  assert.match(K.moneyView(Object.assign({}, ans, { by_card_account_could_not_tell: undefined })).cardLog.words, /The Desk does not say how many entries could not be told\.$/);
  const old = Object.assign({}, ans); delete old.by_card_account_could_not_tell; delete old.card_account_log;
  assert.equal(K.moneyView(old).cardLog, null, 'a Desk from before #120: no line');
  const js = read('live', 'legion-castra.js');
  assert.match(js, /\(b\.real\.cardAccount \? '<br><span class="cx-dim" data-cx-cnt>' \+ esc\(b\.real\.cardAccount\) \+ '<\/span>' : ''\)/, 'beside the real figure');
  assert.match(js, /if \(mv\.cardLog\) body \+= '<p class="cx-note cx-dim" data-cx-cardlog>' \+ esc\(mv\.cardLog\.words\)/, 'the ledger-level line');
});

test('the section comments name the cards\' own numerals', () => {
  const js = read('live', 'legion-castra.js');
  const cards = [...js.matchAll(/card\('([IVX]+)', '([^']+)'/g)].map(m => m[1] + ' ' + m[2]);
  for (const [rn, title] of [['I', 'Real against simulated money'], ['II', 'Needs you'], ['III', 'Who goes in today'], ['IV', 'Running now'], ['VI', 'Last night']])
    assert.ok(cards.some(c => c.startsWith(rn + ' ' + title)), rn + ' ' + title);
  for (const c of ['/* I. real against simulated money', '/* II. Needs you', '/* III. who goes in today', '/* IV. running now, V. today live only', '/* VI. last night', '/* VII. Centurion\'s week'])
    assert.ok(js.includes(c), c);
});

test('the money alarm: never trips until the Prop Sim\'s range for the SAME number of evals is served; it never tops Needs you', () => {
  const v = K.moneyView(F.moneyAnswer());
  assert.equal(v.tripped, 0);
  for (const b of v.builds) { assert.equal(b.alarm.state, 'unknown'); assert.equal(b.alarm.words, K.ALARM_NOT_KNOWN); }
  assert.match(K.ALARM_NOT_KNOWN, /range for the same number of evals is not served yet/);
  /* 2 failed evals, real under the 400-account low end of the sim's own range: still not tripped */
  const two = K.alarmOf({ profit_per_dollar: -1, costs: 300, accounts: 2 }, { low: 0.2 }, null);
  assert.equal(two.state, 'unknown');
  const n = K.needsYou({ money: v, cohorts: null, traders: [], reads: { money: 'ok' } });
  assert.deepEqual(n.items.filter(i => i.kind === 'money alarm'), [], 'the alarm is not on Needs you');
  /* when the N-eval range is served (not today), the judgement is ready: equal to the low end is not under it */
  assert.equal(K.alarmOf({ profit_per_dollar: -1, costs: 300 }, null, { low: 0.2 }).state, 'tripped');
  assert.equal(K.alarmOf({ profit_per_dollar: 0.2, costs: 10 }, null, { low: 0.2 }).state, 'clear');
  assert.equal(K.alarmOf({ profit_per_dollar: -1, costs: 0 }, null, { low: 0.2 }).state, 'unknown', 'no costs: no figure');
});

test('who goes in today: the roster\'s builds, approved first, overall ROI, days to pass and payout speed; the zone split is off', () => {
  const g = K.goesInView(F.rosterAnswer(), F.cohortsAnswer());
  assert.equal(g.ok, true);
  assert.deepEqual(g.rows.map(r => r.file), ['sample_a_v1.json', 'sample_lineup.json'], 'a quick file and a broken one are left out; approved first');
  const a = g.rows[0];
  assert.equal(a.approved, true);
  assert.equal(a.label, 'approved by Anthony');
  assert.equal(a.ppdText, '+1.10 per $1 (simulated)');
  assert.equal(a.daysText, '11 sessions (median, simulated)');
  assert.equal(a.payoutText, '19 sessions to the first payout (median, simulated)');
  assert.deepEqual(a.picked, ['Alpha'], 'the cohort that picked it today');
  assert.match(a.sample, /210 trades/);
  assert.equal(g.rows[1].approved, false);
  assert.equal(g.rows[1].label, L.PLACED);
  assert.equal(g.rows[1].ppdText, 'not enough data yet');
  assert.equal(g.zoneSplit, 'off');
  assert.equal(L.ZONE_SPLIT_ON, false);
  assert.match(g.zoneWords, /Off until a zone version passes test 3/);
  assert.equal(K.goesInView({ ok: false, problem: 'no folder' }, null).ok, false);
});

test('running now and today: live only, from ChartBridge\'s rows; Shadow and stood-down traders are not running', () => {
  const r = K.runningNow([trader(), trader({ id: 't2', mode: 'shadow', modeText: 'Shadow' }), trader({ id: 't3', tone: 'killed' }), trader({ id: 't4', mode: 'copilot', modeText: 'Copilot' })]);
  assert.deepEqual(r.running.map(t => t.id), ['t1', 't4']);
  assert.equal(r.total, 4);
  assert.equal(r.shadow, 1);
  assert.equal(K.runningNow([], true).running.length, 0);
  const t = K.todayLive([row('EVAL-B'), row('FUNDED-C', { today: -10 }), row('X', { today: null })]);
  assert.equal(t.sum, 25);
  assert.equal(t.known, 2);
  assert.equal(t.accounts, 3);
  assert.equal(K.todayLive([row('A', { today: null })]).sum, null, 'nothing reported: no sum, not zero');
});

test('last night: the board\'s newest night; a board that does not read says why', () => {
  const n = K.lastNight(F.boardAnswer());
  assert.equal(n.ok, true);
  assert.deepEqual(n.night, { night: '2001-03-01', asked: 10, made: 9, fresh: 7, neighbours: 2, skipped: 1 });
  assert.equal(K.lastNight({ ok: false, problem: 'the board is not there yet' }).ok, false);
  const none = K.lastNight({ ok: true, board: Object.assign({}, F.boardAnswer().board, { nights: [] }) });
  assert.equal(none.night, null);
  assert.equal(none.words, 'No screen night yet.');
});

test('Centurion\'s week from an older Desk (its veto not built): read only, nothing to act on', () => {
  const c = K.centurionView(F.centurionAnswer());
  assert.equal(c.ok, true);
  assert.equal(c.vetoBuilt, false);
  assert.equal(c.acts, false);
  assert.equal(c.week, null);
  assert.equal(c.applied, null);
  assert.equal(c.applies, false);
  assert.deepEqual(c.changes.map(x => [x.name, x.from, x.to, x.allowed]), [['sample_builds_a_night', '50', '60', true], ['sample_other', 'a', 'b', false]]);
  assert.equal(c.findings.length, 2);
  assert.equal(K.centurionView({ ok: false, problem: 'no report yet' }).ok, false);
  assert.equal(K.centurionView(null).ok, false);
});

test('the cohort model: picks in words, chips with ChartBridge\'s live room and day, accounts in no cohort in the tray', () => {
  const v = K.cohortsView(F.cohortsAnswer(), [row('EVAL-B', { cushion: 840, today: -15 }), row('FUNDED-C', { stageText: 'Funded', position: 'Long 1 MNQ' })], [trader()], true);
  assert.equal(v.ok, true);
  assert.equal(v.version, 4);
  const [alpha, beta, gamma] = v.cohorts;
  assert.equal(alpha.pick.text, 'sample_a_v1 (sample_a_v1.json)');
  assert.equal(alpha.pick.bad, false);
  assert.equal(beta.pick.text, 'No pick yet');
  assert.equal(alpha.chips[0].room, 840);
  assert.equal(alpha.chips[0].today, -15);
  assert.equal(alpha.auto, true, 'a trader is in Auto on EVAL-B');
  assert.equal(beta.auto, false);
  assert.deepEqual(beta.openPositions, ['FUNDED-C']);
  assert.equal(gamma.chips.length, 0);
  assert.deepEqual(v.tray.map(k => k.account), ['EVAL-D']);
  assert.equal(v.tray[0].listed, false, 'ChartBridge does not list it: room and day are "not reported", never a guess');
  assert.equal(v.tray[0].room, null);
  assert.equal(K.pickWords({ file: 'x.json', state: 'changed', bot: 'x' }).bad, true);
  assert.match(K.pickWords({ file: 'x.json', state: 'changed', bot: 'x' }).text, /pick again/);
  assert.equal(K.cohortsView({ cohorts: [] }, [], []).ok, false, 'no version: not shown in part');
  assert.match(K.directionWords(), /not built yet/);
});

test('a drag is refused here in plain words: a position, Auto, or not being able to tell; The Desk\'s refusals come back in words', () => {
  const rows = [row('EVAL-B'), row('FUNDED-C', { position: 'Long 1 MNQ' })];
  const v = K.cohortsView(F.cohortsAnswer(), rows, [], true);
  assert.equal(K.dropRefusal(v, 'EVAL-B', 'gamma'), '', 'flat, nobody in Auto: no objection here');
  assert.match(K.dropRefusal(v, 'FUNDED-C', null), /holds a position \(Long 1 MNQ\)/);
  assert.match(K.dropRefusal(v, 'EVAL-D', 'gamma'), /not listed by ChartBridge now, so this page cannot tell/);
  assert.equal(K.dropRefusal(v, 'EVAL-B', 'alpha'), '', 'the same cohort again changes nothing');
  assert.match(K.dropRefusal(v, 'EVAL-B', 'nowhere'), /not there any more/);
  assert.match(K.dropRefusal(v, 'NOPE', 'gamma'), /not one of the prop accounts The Desk lists/);
  const auto = K.cohortsView(F.cohortsAnswer(), rows, [trader({ accounts: ['EVAL-B'] })], true);
  assert.match(K.dropRefusal(auto, 'EVAL-B', 'gamma'), /EVAL-B has a trader in Auto on it/, 'out of a cohort in Auto');
  const intoAuto = K.cohortsView(F.cohortsAnswer(), [row('EVAL-B'), row('FUNDED-C')], [trader({ accounts: ['FUNDED-C'] })], true);
  assert.match(K.dropRefusal(intoAuto, 'EVAL-B', 'beta'), /Beta is in Auto/, 'into a cohort in Auto');
  assert.match(K.dropRefusal(K.cohortsView(F.cohortsAnswer(), [row('EVAL-B', { position: 'Not connected' })], [], true), 'EVAL-B', 'gamma'), /not connected/);
  assert.match(K.moveWords({ status: 400, body: { detail: 'EVAL-B is of stage eval: this cohort is funded' } }), /^The Desk refused it: EVAL-B is of stage eval: this cohort is funded\.$/);
  assert.match(K.moveWords({ status: 409, body: { detail: 'stale', version: 5 } }), /Another change came first, so nothing was moved/);
  assert.equal(K.moveWords({ status: null, words: 'x' }, 'EVAL-B'), 'The Desk did not answer, so this page cannot tell whether EVAL-B moved: the cohorts are read again.', 'a timeout: The Desk may have applied it');
  assert.match(K.moveWords({ status: 500, words: 'The Desk answered 500 to /x.' }), /Nothing was moved\.$/);
});

test('Needs you: one list; a pick to redo, a stood-down trader, an account in no cohort; reads that failed are said, never hidden', () => {
  const rows = [row('EVAL-B'), row('FUNDED-C')];
  const money = K.moneyView(F.moneyAnswer());
  const cohorts = K.cohortsView(F.cohortsAnswer({ pick: 'changed', problem: true }), rows, [], true);
  const n = K.needsYou({ money, cohorts, traders: [trader({ tone: 'standDown', status: 'Stood down: made up' })], reads: { money: 'ok', board: 'fail' } });
  const kinds = n.items.map(i => i.kind);
  for (const k of ['pick', 'cohort', 'accounts', 'trader']) assert.ok(kinds.includes(k), k + ' in ' + kinds.join());
  assert.ok(!kinds.includes('money alarm'), 'no money alarm until the N-eval range is served');
  assert.deepEqual(n.cannotTell, ['board']);
  const none = K.needsYou({ money: K.moneyView(F.moneyAnswer({ alarm: false })), cohorts: K.cohortsView(F.cohortsAnswer({ alphaEmpty: false }), rows, [], true), traders: [], reads: {} });
  assert.deepEqual(none.items.map(i => i.kind), ['accounts'], 'EVAL-D is in no cohort: that is all that waits');
});

test('the Desk client: GET with no credentials and no cache, PUT with JSON; a refusal keeps its words, status and body', async () => {
  const calls = [];
  const fetch = async (u, o) => { calls.push([u, o]); return u.endsWith('/bad') ? { ok: false, status: 400, json: async () => ({ detail: 'no' }) } : { ok: true, status: 200, json: async () => ({ ok: 1 }) }; };
  const d = K.deskClient({ fetch, deskBase: () => Promise.resolve('http://desk.example.com') });
  assert.deepEqual(await d.get('/x'), { ok: 1 });
  assert.equal(calls[0][0], 'http://desk.example.com/x');
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(calls[0][1].cache, 'no-store');
  await d.put('/y', { version: 3 });
  assert.equal(calls[1][1].method, 'PUT');
  assert.equal(calls[1][1].headers['Content-Type'], 'application/json');
  assert.equal(calls[1][1].body, '{"version":3}');
  await assert.rejects(d.put('/bad', {}), e => e.status === 400 && e.body.detail === 'no' && /answered 400/.test(e.words));
  const off = K.deskClient({ fetch: async () => { throw new TypeError('network'); }, deskBase: () => 'http://desk.example.com' });
  await assert.rejects(off.get('/z?q=1'), e => e.status === null && /did not answer \/z \(it is off/.test(e.words));
});

test('the page: Castra and the cohort model are mounted from the tabs file at its mount points, and the install list carries every new file', () => {
  const html = read('live', 'legion.html');
  assert.match(html, /<div id="cxView"/);
  assert.match(html, /<div id="chView"/);
  for (const f of ['legion-castra-core.js', 'legion-castra.js', 'legion-cohorts.js', 'agents-strip.js', 'agents-sky.js']) assert.match(html, new RegExp('<script src="' + f + '"></script>'), f);
  assert.ok(html.indexOf('<script src="ludus-core.js">') < html.indexOf('<script src="legion-castra-core.js">') && html.indexOf('<script src="legion-castra-core.js">') < html.indexOf('<script src="legion-tabs.js">'), 'the core after the Ludus\'s, before the tabs file');
  assert.match(html, /<link rel="stylesheet" href="legion-castra.css">/);
  const inst = JSON.parse(read('nt8', 'install-files.json')).www.map(x => x.to);
  for (const f of ['legion-castra-core.js', 'legion-castra.js', 'legion-cohorts.js', 'legion-castra.css']) assert.ok(inst.includes(f), f + ' is installed');
  const tabs = read('live', 'legion-tabs.js');
  assert.match(tabs, /window\.LegionCastra\.mount\(\$\('cxView'\)/);
  assert.match(tabs, /window\.LegionCohorts\.mount\(\$\('chView'\)/);
  assert.match(tabs, /castra\.show\(tab === 'castra'\)/);
  assert.match(tabs, /cohortModel\.show\(tab === 'cohorts' && sub === 'legion'\)/);
});

test('Castra writes only Centurion\'s veto and undo (one POST each); Cohorts writes The Desk\'s cohort model only; neither sends ChartBridge anything', () => {
  const castra = read('live', 'legion-castra.js'), cohorts = read('live', 'legion-cohorts.js'), core = read('live', 'legion-castra-core.js');
  assert.doesNotMatch(castra, /\.put\(|method: ['"](PUT|POST|DELETE)/, 'Castra: no PUT, no write of its own');
  assert.equal((castra.match(/\.post\(/g) || []).length, 1, 'Castra: the one POST, its route and body from K.actionFor');
  assert.match(castra, /desk\.post\(act\.route, act\.body\)/);
  assert.equal((cohorts.match(/desk\.put\(/g) || []).length, 1, 'Cohorts: the one write (the member move)');
  assert.match(cohorts, /desk\.put\(K\.ROUTES\.members, \{ version: v\.version, account, cohort: toId \}\)/);
  for (const [n, src] of [['castra', castra], ['cohorts', cohorts], ['core', core]]) assert.doesNotMatch(src, /WebSocket|AF\.post|\.send\(|sendOrder|createFeed/, n + ': no way to ChartBridge or an order');
  assert.equal((core.match(/method: 'PUT'/g) || []).length, 1, 'the client has the one PUT');
  assert.equal((core.match(/method: 'POST'/g) || []).length, 1, 'and the one POST');
});

test('no dash, no sample numbers on screen outside the labelled fixtures, no purple', () => {
  for (const f of ['legion-castra-core.js', 'legion-castra.js', 'legion-cohorts.js', 'legion-castra.css']) {
    const src = read('live', f);
    assert.doesNotMatch(src, /[\u2013\u2014]/, f + ': no em or en dash');
    assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''), /purple|violet|magenta/i, f + ': no purple');
  }
  assert.doesNotMatch(read('test', 'fixtures', 'castra-sample.js'), /[\u2013\u2014]/);
});

test('a drag is refused when the page cannot tell whether a cohort is in Auto: traders not heard, a trader whose accounts cannot be read, a tray account under an Auto trader', () => {
  const rows = [row('EVAL-B'), row('FUNDED-C')];
  const notHeard = K.cohortsView(F.cohortsAnswer(), rows, [], false);
  assert.match(K.dropRefusal(notHeard, 'EVAL-B', 'gamma'), /cannot tell whether a cohort is in Auto: ChartBridge has not sent the traders yet/, 'accounts but no traders yet (before the sign-in replay)');
  assert.equal(K.dropRefusal(notHeard, 'EVAL-B', 'alpha'), '', 'the same cohort again still changes nothing');
  assert.match(K.dropRefusal(K.cohortsView(F.cohortsAnswer(), rows, []), 'EVAL-B', 'gamma'), /cannot tell whether a cohort is in Auto/, 'heard left out: not heard');
  const unreadable = K.cohortsView(F.cohortsAnswer(), rows, [trader({ accounts: [], cannotTell: true })], true);
  assert.match(K.dropRefusal(unreadable, 'EVAL-B', 'gamma'), /a trader in Auto has accounts it cannot read/);
  const heard = K.cohortsView(F.cohortsAnswer({ tray: 'EVAL-A' }), [row('EVAL-A'), row('EVAL-B')], [trader({ accounts: ['EVAL-A'] })], true);
  assert.match(K.dropRefusal(heard, 'EVAL-A', 'gamma'), /EVAL-A has a trader in Auto on it/, 'a tray account under an Auto trader');
  const ok = K.cohortsView(F.cohortsAnswer(), rows, [], true);
  assert.equal(K.dropRefusal(ok, 'EVAL-B', 'gamma'), '');
  const r = K.runningNow([], false);
  assert.match(r.cannotTell, /cannot tell what is running/);
  assert.match(K.runningNow([trader({ accounts: [], cannotTell: true })], true).cannotTell, /cannot read/);
});

test('a read keeps its last answer while refreshed; pending or failed with no answer is cannot tell, never all clear', () => {
  assert.deepEqual(K.readStatus({ state: 'loading', ans: { a: 1 } }), { state: 'ok', stale: false }, 'a refresh keeps the answer');
  assert.deepEqual(K.readStatus({ state: 'fail', ans: { a: 1 } }), { state: 'ok', stale: true }, 'a failed refresh keeps it, marked stale');
  assert.deepEqual(K.readStatus({ state: 'idle', ans: null }), { state: 'pending', stale: false });
  assert.deepEqual(K.readStatus({ state: 'loading', ans: null }), { state: 'pending', stale: false });
  assert.deepEqual(K.readStatus({ state: 'fail', ans: null }), { state: 'fail', stale: false });
  const n = K.needsYou({ money: null, cohorts: null, traders: [], reads: { money: 'pending', roster: 'ok', cohorts: 'fail' } });
  assert.deepEqual(n.items, []);
  assert.deepEqual(n.cannotTell, ['money', 'cohorts'], 'nothing read yet: cannot tell, which the page says instead of "nothing needs you"');
  assert.deepEqual([n.failed, n.pending], [['cohorts'], ['money']], 'failed and pending are told apart');
  const src = read('live', 'legion-castra.js');
  assert.match(src, /S\.reads\[name\] = \{ state: 'loading', why: '', ans: r\.ans \}/, 'the refresh starts from the last answer');
  assert.match(src, /state: 'fail', why: e && e\.words \? e\.words : 'The read failed\.', ans: r\.ans/, 'a failed refresh keeps it');
  assert.match(src, /nv\.cannotTell\.length \? '' : '<p class="cx-ok"><b>Nothing needs you/, 'all clear only with nothing unread');
});

test('the Desk client gives up on a hang (about 15 s): an aborted request and a failure, never a wait with no end', async () => {
  let signal = null;
  const hang = K.deskClient({ fetch: (u, o) => { signal = o.signal; return new Promise(() => {}); }, deskBase: () => 'http://desk.example.com', timeoutMs: 30 });
  await assert.rejects(hang.get('/slow'), e => e.status === null && /did not answer \/slow in 0 s|did not answer \/slow/.test(e.words));
  assert.ok(signal && signal.aborted, 'the request is aborted');
  await assert.rejects(hang.put('/slow', {}), e => /did not answer/.test(e.words));
  assert.match(read('live', 'legion-castra-core.js'), /15000/, 'the default is 15 s');
});

test('veto, dollars per funded slot and the named type say "not built yet (law 1.6)" where they would be; the cohort pick words; the race is closed', () => {
  const castra = read('live', 'legion-castra.js'), cohorts = read('live', 'legion-cohorts.js');
  assert.match(castra, /K\.VETO_UNKNOWN \+ \(c\.vetoWords \? ' The Desk: ' \+ c\.vetoWords : ''\) \+ ' \(plan steps 2\.9 and 3\.3: Centurion applies nothing until the veto is on\.\)'/);
  assert.match(castra, /Dollars per funded slot per 30 sessions: ' \+ esc\(K\.NOT_BUILT\) \+ ' \(law 1\.6\)/);
  assert.match(castra, /Named account type: ' \+ esc\(K\.NOT_BUILT\) \+ ' \(law 1\.6\)/);
  assert.match(cohorts, /is set in The Desk and is not changed on this tab yet/);
  assert.doesNotMatch(cohorts, /changed in the lanes/);
  assert.match(cohorts, /S\.busy = true; S\.gen\+\+;/, 'a read in flight is dropped when a write starts');
  assert.doesNotMatch(castra, /Simulated: ' \+ K\.SIM_LABEL/);
  assert.match(read('live', 'legion-tabs.js'), /heard: !!\(s\.arm && s\.arm\.state !== 'unknown'\)/);
  assert.match(read('live', 'legion-castra.css'), /\.cx-money \.cx-al \{ white-space: nowrap; display: inline-block; \}/);
});

test('a write that timed out is read again at once; the Centurion card cites plan steps 2.9 and 3.3 once; Needs you tells pending from failed', () => {
  const cohorts = read('live', 'legion-cohorts.js'), castra = read('live', 'legion-castra.js');
  assert.match(cohorts, /e\.status === 409 \|\| e\.status === 404 \|\| e\.status === null\)\) readCohorts\(\)/);
  assert.match(cohorts, /K\.moveWords\(e, account\)/);
  assert.doesNotMatch(castra, /There is no veto action yet/);
  assert.doesNotMatch(castra, /Veto: [^\n]*law 1\.6/);
  assert.match(castra, /is not read yet/);
  assert.match(castra, /could not be read/);
});

/* ---------------------------------------------------------------- Centurion's veto and undo (the contract v1, 2026-11-19, section 6) */
const LC = require('../live/legion.js');
const RUN = F.SAMPLE_RUN;

test('Centurion: the routes Castra uses are three (the read, the veto, the undo); it never calls the seal or the undo list', () => {
  assert.deepEqual([K.ROUTES.centurion, K.ROUTES.centurionVeto, K.ROUTES.centurionUndo], ['/api/legion/centurion', '/api/legion/centurion/veto', '/api/legion/centurion/undo']);
  assert.ok(!Object.values(K.ROUTES).some(r => /\/seal|\/undos/.test(r)), 'no seal or undos route');
  const code = f => read('live', f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['legion-castra.js', 'legion-castra-core.js', 'legion-tabs.js']) assert.doesNotMatch(code(f), /\/seal\b|undos|centurionSeal/, f + ': no seal, no undo list, outside the comments');
  for (const f of ['legion-castra.js', 'legion-castra-core.js']) {
    const src = read('live', f);
    for (const r of ['GET /api/legion/centurion', 'POST /api/legion/centurion/veto', 'POST /api/legion/centurion/undo']) assert.ok(src.includes(r), f + ' names ' + r + ' in its header');
  }
});

test('Centurion: the question is Legion\'s Stop all question: ARM_MS 600, CONFIRM_MS 8000, the same answer at every click', () => {
  assert.equal(K.ARM_MS, 600);
  assert.equal(K.CONFIRM_MS, 8000);
  assert.equal(K.ARM_MS, LC.ARM_MS);
  assert.equal(K.CONFIRM_MS, LC.CONFIRM_MS);
  for (const at of [0, 1000]) for (const age of [0, 1, 599, 600, 601, 4000, 7999, 8000, 8001, 20000]) for (const real of [true, false])
    assert.equal(K.askClick(at, at + age, real), LC.stopClick(at, at + age, real), [at, age, real].join());
  assert.equal(K.askClick(1000, 1300, true), 'early');
  assert.equal(K.askClick(1000, 1700, true), 'yes');
  assert.equal(K.askClick(1000, 1700, false), 'key');
  assert.equal(K.askClick(1000, 9001, true), 'late');
});

test('Centurion v1: acted on only for veto.built true and version 1; anything else is read only', () => {
  assert.equal(K.centurionView(F.centurionV1()).acts, true);
  for (const veto of [{ built: true, version: 2 }, { built: true }, { built: 'true', version: 1 }, { built: true, version: '1' }, { built: false, version: 1 }, null]) {
    const a = F.centurionV1(); a.veto = veto;
    const c = K.centurionView(a);
    assert.equal(c.acts, false, JSON.stringify(veto));
    assert.equal(c.week, null);
    assert.equal(K.actionFor(c, true, 'veto', RUN, 'sample_builds_a_night').why, K.VETO_UNKNOWN);
  }
  assert.equal(K.VETO_UNKNOWN, 'The Desk\'s veto is not one this page knows: read only.');
});

test('Centurion v1, the week: Veto only on an allowed change while The Desk says open; refused, vetoed and outcomes in words', () => {
  const c = K.centurionView(F.centurionV1({ vetoed: ['sample_neighbours'] }));
  const by = n => c.week.changes.find(x => x.name === n);
  assert.deepEqual([by('sample_builds_a_night').can, by('sample_neighbours').can, by('sample_other').can], [true, false, false]);
  assert.equal(by('sample_neighbours').then, 'Vetoed');
  assert.equal(by('sample_other').then, 'Refused by the allow-list: never applied');
  assert.equal(by('sample_builds_a_night').why, 'Sample reason: more builds a night (made up).');
  assert.equal(c.week.words, 'Veto until the end of Sunday, New York time. The rest go in at Sunday night\'s run.');
  assert.equal(c.week.closes, 'Mon, Jan 8, 2001, 00:00 EST', 'closes_utc in New York time');
  for (const state of ['closed', 'sealed', 'missed', 'reports only', 'not a Saturday report', 'something new']) {
    const w = K.centurionView(F.centurionV1({ state })).week;
    assert.ok(w.changes.every(x => !x.can), state + ': no Veto');
    assert.equal(w.changes.find(x => x.name === 'sample_builds_a_night').then, 'Not vetoed', state);
  }
  const done = K.centurionView(F.centurionV1({ state: 'sealed', vetoed: ['sample_neighbours'], outcomes: { sample_builds_a_night: ['applied', null], sample_neighbours: ['vetoed', null] } })).week;
  assert.deepEqual(done.changes.map(x => x.then), ['Applied', 'Vetoed', 'Refused by the allow-list: never applied']);
  assert.match(done.sealed, /^Mon, Jan 8, 2001, 00:05 EST$/);
  const odd = K.centurionView(F.centurionV1({ state: 'sealed', vetoed: ['sample_neighbours'], outcomes: { sample_builds_a_night: ['refused', 'Sample: moved since (made up).'], sample_neighbours: ['applied', null] } })).week;
  assert.equal(odd.changes[0].then, 'Refused: Sample: moved since (made up).');
  assert.equal(odd.changes[1].then, 'Vetoed (the applied log says: Applied)', 'a log that disagrees with the veto is shown, never hidden');
  const miss = K.centurionView(F.centurionV1({ state: 'missed', outcomes: { sample_builds_a_night: ['not applied', 'Sample: the seal did not answer (made up).'] } })).week;
  assert.equal(miss.changes[0].then, 'Not applied: Sample: the seal did not answer (made up).');
});

test('Centurion v1: a run id or a setting name that is not one The Desk would send gets no button', () => {
  const a = F.centurionV1(); a.week.run_id = 'centurion_2001';
  assert.ok(K.centurionView(a).week.changes.every(x => !x.can));
  const b = F.centurionV1(); b.week.changes[0].name = 'Sample-Bad';
  assert.equal(K.centurionView(b).week.changes[0].can, false);
  const r = F.centurionV1(); r.applied.rows[0].name = 'x'.repeat(65);
  assert.equal(K.centurionView(r).applied.rows[0].can, false);
});

test('Centurion v1, the applied log: Undo on "none" only; asked, done, refused in words; a log that does not read shows nothing', () => {
  const a = K.centurionView(F.centurionV1({ undo: { sample_neighbours: 'asked' }, more: 3 })).applied;
  assert.equal(a.ok, true);
  assert.deepEqual(a.rows.map(r => [r.name, r.can, r.then]), [['sample_builds_a_night', true, ''], ['sample_neighbours', false, 'Undo asked: done at the start of the next night\'s run'],
    ['sample_spare', false, 'Undo refused: Sample: moved since: undo by hand (made up).']]);
  assert.equal(a.rows[0].when, 'Mon, Jan 1, 2001, 00:05 EST');
  assert.equal(a.more, 3);
  assert.equal(K.centurionView(F.centurionV1({ undo: { sample_builds_a_night: 'done' } })).applied.rows[0].then, 'Undone');
  const bad = K.centurionView(F.centurionV1({ applied: false })).applied;
  assert.equal(bad.ok, false);
  assert.match(bad.problem, /^The applied log does not read: nothing from it is shown, and no undo can be asked now\.$/);
  assert.equal(K.actionFor(K.centurionView(F.centurionV1({ applied: false })), true, 'undo', 'centurion_20001230T110500Z', 'sample_builds_a_night').why.slice(0, 30), 'This change has no Undo now (T');
  assert.deepEqual(K.centurionView(F.centurionV1({ rows: [] })).applied.rows, []);
});

test('Centurion v1: the one POST carries exactly { run_id, name }; nothing is sent on a stale read or for a change not offered', () => {
  const c = K.centurionView(F.centurionV1({ vetoed: ['sample_neighbours'] }));
  const v = K.actionFor(c, true, 'veto', RUN, 'sample_builds_a_night');
  assert.deepEqual(v, { route: '/api/legion/centurion/veto', body: { run_id: RUN, name: 'sample_builds_a_night' } });
  assert.deepEqual(Object.keys(v.body), ['run_id', 'name']);
  const u = K.actionFor(c, true, 'undo', 'centurion_20001230T110500Z', 'sample_neighbours');
  assert.deepEqual(u, { route: '/api/legion/centurion/undo', body: { run_id: 'centurion_20001230T110500Z', name: 'sample_neighbours' } });
  assert.equal(K.actionFor(c, false, 'veto', RUN, 'sample_builds_a_night').why, K.VETO_UNREACHABLE, 'a stale or failed read sends nothing');
  for (const [kind, run, name] of [['veto', RUN, 'sample_neighbours'], ['veto', RUN, 'sample_other'], ['veto', 'centurion_20001230T110500Z', 'sample_builds_a_night'], ['undo', 'centurion_20001223T110500Z', 'sample_spare'], ['seal', RUN, 'sample_builds_a_night']])
    assert.ok(K.actionFor(c, true, kind, run, name).why, [kind, run, name].join());
  assert.ok(K.actionFor(K.centurionView(F.centurionV1({ state: 'closed' })), true, 'veto', RUN, 'sample_builds_a_night').why, 'closed: no veto');
});

test('Centurion v1: the answers in the contract\'s words; The Desk\'s refusal as it is; no answer is never called failed or done', () => {
  assert.equal(K.sentWords('veto', { words: 'Vetoed: this change will not go in.' }), 'Vetoed: this change will not go in.');
  assert.equal(K.sentWords('veto', {}), 'Vetoed: this change will not go in.');
  assert.equal(K.sentWords('undo', null), 'Undo asked: it is done at the start of the next night\'s run.');
  const late = 'The veto window closed at the end of Sunday, New York time. Sunday night\'s run takes the list as it was; use Undo after the run.';
  assert.equal(K.refusedWords('veto', { status: 409, body: { detail: late }, words: 'x' }), 'Refused: ' + late);
  assert.equal(K.refusedWords('veto', { status: null, body: null, words: 'The Desk did not answer /api/legion/centurion/veto in 15 s.' }), 'The Desk did not answer: the veto may or may not be recorded. Reading again.');
  assert.equal(K.refusedWords('undo', { status: null }), 'The Desk did not answer: the undo may or may not be recorded. Reading again.');
  assert.match(K.refusedWords('veto', { status: 500, body: null, words: 'The Desk answered 500 to /api/legion/centurion/veto.' }), /^Refused: The Desk answered 500/);
  assert.equal(K.VETO_Q, 'Veto this change? It will not go in at Sunday night\'s run. A veto cannot be taken back.');
  assert.equal(K.undoQuestion('sample_builds_a_night', '40'), 'Undo this change? sample_builds_a_night goes back to 40 at the start of the next night\'s run.');
  assert.equal(K.VETO_UNREACHABLE, 'The Desk did not answer, so no veto or undo can be sent now. If Sunday night\'s run cannot read the veto list, it applies nothing that week.');
  assert.deepEqual([K.NO_WEEK, K.NO_CHANGE, K.NO_APPLIED], ['No Saturday report yet: nothing to veto.', 'No change proposed this week.', 'No change applied yet.']);
  assert.equal(K.IN_SAMPLE, 'In-sample: nothing here is proven, and no change here trades.');
});

test('Centurion v1: New York time from the browser\'s zone data, in both offsets; anything not a UTC stamp is no time', () => {
  assert.equal(K.nyTime('2026-11-23T05:00:00Z'), 'Mon, Nov 23, 2026, 00:00 EST');
  assert.equal(K.nyTime('2026-07-13T04:00:00Z'), 'Mon, Jul 13, 2026, 00:00 EDT');
  for (const x of ['2026-11-23', '2026-11-23T05:00:00+00:00', '', null, 5]) assert.equal(K.nyTime(x), '');
  assert.match(read('live', 'legion-castra-core.js'), /new Intl\.DateTimeFormat\('en-US', \{ timeZone: 'America\/New_York'/);
});

test('the Desk client: POST with JSON and no credentials; a hang is a failure with no status (the may-or-may-not words)', async () => {
  const calls = [];
  const d = K.deskClient({ fetch: async (u, o) => { calls.push([u, o]); return { ok: true, status: 200, json: async () => ({ words: 'ok' }) }; }, deskBase: () => 'http://desk.example.com' });
  assert.deepEqual(await d.post('/api/legion/centurion/veto', { run_id: RUN, name: 'sample_builds_a_night' }), { words: 'ok' });
  assert.equal(calls[0][0], 'http://desk.example.com/api/legion/centurion/veto');
  assert.deepEqual([calls[0][1].method, calls[0][1].credentials, calls[0][1].cache, calls[0][1].headers['Content-Type']], ['POST', 'omit', 'no-store', 'application/json']);
  assert.equal(calls[0][1].body, JSON.stringify({ run_id: RUN, name: 'sample_builds_a_night' }));
  const hang = K.deskClient({ fetch: () => new Promise(() => {}), deskBase: () => 'http://desk.example.com', timeoutMs: 30 });
  await assert.rejects(hang.post('/api/legion/centurion/veto', {}), e => e.status === null && K.refusedWords('veto', e) === 'The Desk did not answer: the veto may or may not be recorded. Reading again.');
});

test('Castra\'s card VII: the question in the card with Yes and Cancel, Escape closes it, one send at a time, no button on a stale read', () => {
  const castra = read('live', 'legion-castra.js');
  assert.match(castra, /role="alertdialog"/);
  assert.match(castra, /data-cx-yes>Yes, ' \+ esc\(kind\) \+ '<\/button><button type="button" class="lx-btn" data-cx-no>Cancel<\/button>/);
  assert.match(castra, /e\.key === 'Escape' && S\.ask/);
  assert.match(castra, /document\.removeEventListener\('keydown', onKey, true\)/);
  assert.match(castra, /K\.askClick\(S\.ask \? S\.ask\.at : 0, Date\.now\(\), realClick\(e\)\)/);
  assert.match(castra, /\(sending \? 'Sending\.\.\.' : label\)/);
  assert.match(castra, /\(S\.sending \? ' disabled' : ''\)/);
  assert.match(castra, /if \(!a \|\| S\.sending\) \{ render\(\); return; \}/);
  assert.match(castra, /x\.can && fresh \? raw\(actBtn\('veto'/);
  assert.match(castra, /r\.can && fresh \? raw\(actBtn\('undo'/);
  assert.match(castra, /const realClick = typeof o\.realClick === 'function' \? o\.realClick : \(\) => false;/);
  assert.match(read('live', 'legion-tabs.js'), /window\.LegionCastra\.mount\(\$\('cxView'\), \{ [^}]*realClick \}\)/);
  assert.doesNotMatch(read('test', 'fixtures', 'castra-sample.js').match(/function centurionV1[\s\S]*?\n}\n/)[0], /[–—]/);
  assert.match(JSON.stringify(F.centurionV1()), /Sample week \(made up\)/, 'the sample week says sample on screen');
});
