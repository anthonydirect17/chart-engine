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

test('the money alarm: real under the low end of the sim\'s range trips it; no real figure or no range cannot be judged', () => {
  const v = K.moneyView(F.moneyAnswer());
  assert.equal(v.tripped, 1);
  assert.equal(v.builds[0].alarm.state, 'tripped');
  assert.match(v.builds[0].alarm.words, /under the low end of the Prop Sim's range \(\+0\.20\)/);
  assert.match(v.builds[0].alarm.words, /step 3\.5 \(not built yet\)/, 'it stops nothing here');
  assert.equal(v.builds[1].alarm.state, 'unknown');
  assert.equal(v.builds[2].alarm.state, 'unknown', 'no simulated range');
  const ok = K.moneyView(F.moneyAnswer({ alarm: false }));
  assert.equal(ok.tripped, 0);
  assert.equal(ok.builds[0].alarm.state, 'clear');
  assert.equal(K.alarmOf({ profit_per_dollar: 0.2, costs: 10 }, { low: 0.2 }).state, 'clear', 'equal to the low end is not under it');
  assert.equal(K.alarmOf({ profit_per_dollar: -1, costs: 0 }, { low: 0.2 }).state, 'unknown', 'no costs: no figure');
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
  assert.equal(K.runningNow([]).running.length, 0);
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

test('Centurion\'s week: read only, the veto is not built, nothing is applied', () => {
  const c = K.centurionView(F.centurionAnswer());
  assert.equal(c.ok, true);
  assert.equal(c.vetoBuilt, false);
  assert.equal(c.applies, false);
  assert.deepEqual(c.changes.map(x => [x.name, x.from, x.to, x.allowed]), [['sample_builds_a_night', '50', '60', true], ['sample_other', 'a', 'b', false]]);
  assert.equal(c.findings.length, 2);
  assert.equal(K.centurionView({ ok: false, problem: 'no report yet' }).ok, false);
  assert.equal(K.centurionView(null).ok, false);
});

test('the cohort model: picks in words, chips with ChartBridge\'s live room and day, accounts in no cohort in the tray', () => {
  const v = K.cohortsView(F.cohortsAnswer(), [row('EVAL-B', { cushion: 840, today: -15 }), row('FUNDED-C', { stageText: 'Funded', position: 'Long 1 MNQ' })], [trader()]);
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
  const v = K.cohortsView(F.cohortsAnswer(), rows, []);
  assert.equal(K.dropRefusal(v, 'EVAL-B', 'gamma'), '', 'flat, nobody in Auto: no objection here');
  assert.match(K.dropRefusal(v, 'FUNDED-C', null), /holds a position \(Long 1 MNQ\)/);
  assert.match(K.dropRefusal(v, 'EVAL-D', 'gamma'), /not listed by ChartBridge now, so this page cannot tell/);
  assert.equal(K.dropRefusal(v, 'EVAL-B', 'alpha'), '', 'the same cohort again changes nothing');
  assert.match(K.dropRefusal(v, 'EVAL-B', 'nowhere'), /not there any more/);
  assert.match(K.dropRefusal(v, 'NOPE', 'gamma'), /not one of the prop accounts The Desk lists/);
  const auto = K.cohortsView(F.cohortsAnswer(), rows, [trader({ accounts: ['EVAL-B'] })]);
  assert.match(K.dropRefusal(auto, 'EVAL-B', 'gamma'), /Alpha is in Auto/, 'out of a cohort in Auto');
  const intoAuto = K.cohortsView(F.cohortsAnswer(), [row('EVAL-B'), row('FUNDED-C')], [trader({ accounts: ['FUNDED-C'] })]);
  assert.match(K.dropRefusal(intoAuto, 'EVAL-B', 'beta'), /Beta is in Auto/, 'into a cohort in Auto');
  assert.match(K.dropRefusal(K.cohortsView(F.cohortsAnswer(), [row('EVAL-B', { position: 'Not connected' })], []), 'EVAL-B', 'gamma'), /not connected/);
  assert.match(K.moveWords({ status: 400, body: { detail: 'EVAL-B is of stage eval: this cohort is funded' } }), /^The Desk refused it: EVAL-B is of stage eval: this cohort is funded\.$/);
  assert.match(K.moveWords({ status: 409, body: { detail: 'stale', version: 5 } }), /Another change came first, so nothing was moved/);
  assert.match(K.moveWords({ status: null, words: 'The Desk did not answer /api/legion/cohorts/members (it is off, or it does not let this page read it yet).' }), /did not answer.*Nothing was moved\.$/);
});

test('Needs you: one list; an alarm, a pick to redo, a stood-down trader, an account in no cohort; reads that failed are said, never hidden', () => {
  const rows = [row('EVAL-B'), row('FUNDED-C')];
  const money = K.moneyView(F.moneyAnswer());
  const cohorts = K.cohortsView(F.cohortsAnswer({ pick: 'changed', problem: true }), rows, []);
  const n = K.needsYou({ money, cohorts, traders: [trader({ tone: 'standDown', status: 'Stood down: made up' })], reads: { money: 'ok', board: 'fail' } });
  const kinds = n.items.map(i => i.kind);
  for (const k of ['money alarm', 'pick', 'cohort', 'accounts', 'trader']) assert.ok(kinds.includes(k), k + ' in ' + kinds.join());
  assert.equal(kinds[0], 'money alarm', 'the alarm first');
  assert.deepEqual(n.cannotTell, ['board']);
  const none = K.needsYou({ money: K.moneyView(F.moneyAnswer({ alarm: false })), cohorts: K.cohortsView(F.cohortsAnswer({ alphaEmpty: false }), rows, []), traders: [], reads: {} });
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

test('Castra reads and never writes; Cohorts writes The Desk\'s cohort model only and sends ChartBridge nothing', () => {
  const castra = read('live', 'legion-castra.js'), cohorts = read('live', 'legion-cohorts.js'), core = read('live', 'legion-castra-core.js');
  assert.doesNotMatch(castra, /\.put\(|\.post\(|method: ['"](PUT|POST|DELETE)/, 'Castra: no write');
  assert.equal((cohorts.match(/desk\.put\(/g) || []).length, 1, 'Cohorts: the one write (the member move)');
  assert.match(cohorts, /desk\.put\(K\.ROUTES\.members, \{ version: v\.version, account, cohort: toId \}\)/);
  for (const [n, src] of [['castra', castra], ['cohorts', cohorts], ['core', core]]) assert.doesNotMatch(src, /WebSocket|AF\.post|\.send\(|sendOrder|createFeed/, n + ': no way to ChartBridge or an order');
  assert.equal((core.match(/method: 'PUT'/g) || []).length, 1, 'the client has the one PUT');
});

test('no dash, no sample numbers on screen outside the labelled fixtures, no purple', () => {
  for (const f of ['legion-castra-core.js', 'legion-castra.js', 'legion-cohorts.js', 'legion-castra.css']) {
    const src = read('live', f);
    assert.doesNotMatch(src, /[–—]/, f + ': no em or en dash');
    assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''), /purple|violet|magenta/i, f + ': no purple');
  }
  assert.doesNotMatch(read('test', 'fixtures', 'castra-sample.js'), /[–—]/);
});
