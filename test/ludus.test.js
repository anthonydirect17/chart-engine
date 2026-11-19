'use strict';
// Plan step 3.4: Legion's Ludus (Pipeline, Board, Builder, Seeds, Agents) and the build page. The pure part (live/ludus-core.js),
// the page's wiring, and the rules: ROI first, every number with its sample or "not enough data yet", simulated numbers labelled,
// the zone split off, discovery days only, read only. Made-up answers only (test/fixtures/ludus-sample.js: sample data).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../live/ludus-core.js');
const LC = require('../live/legion.js');
const CE = require('../src/chart-engine.js');
const F = require('./fixtures/ludus-sample.js');
const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('the address: the Ludus view and the build page are kept, and leave with the tab', () => {
  assert.deepEqual(L.routeFrom(''), { sub: 'pipeline', build: '', show: 'all', page: 1, trade: 0 });
  assert.deepEqual(L.routeFrom('?tab=ludus&ludus=board'), { sub: 'board', build: '', show: 'all', page: 1, trade: 0 });
  assert.deepEqual(L.routeFrom('?ludus=nonsense&build=xyz&show=bogus&page=-2&trade=1.5'), { sub: 'pipeline', build: '', show: 'all', page: 1, trade: 0 });
  assert.deepEqual(L.routeFrom('?ludus=board&build=' + F.A.toUpperCase() + '&show=losers&page=2&trade=7'), { sub: 'board', build: F.A, show: 'losers', page: 2, trade: 7 });
  const s = L.routeSearch('?tab=ludus&layout=X', { sub: 'board', build: F.A, show: 'winners', page: 3, trade: 4 });
  assert.equal(s, '?tab=ludus&layout=X&ludus=board&build=' + F.A + '&show=winners&page=3&trade=4');
  assert.equal(L.routeSearch(s, { sub: 'seeds', build: '' }), '?tab=ludus&layout=X&ludus=seeds', 'the build page\'s keys go with the build');
  assert.equal(L.routeSearch('', { sub: 'board', build: F.A, show: 'all', page: 1, trade: 0 }), '?tab=ludus&ludus=board&build=' + F.A, 'defaults left out');
  // Legion's own tab address drops them on any other tab (live/legion.js tabSearch: the one place)
  assert.equal(LC.tabSearch(s, 'cohorts', 'legion'), '?tab=cohorts&layout=X&sub=legion');
  assert.equal(LC.tabSearch(s, 'ludus', ''), s.replace('?tab=ludus&layout=X', '?tab=ludus&layout=X'), 'kept on the Ludus');
});

test('the routes: The Desk\'s reads, one table; reads only', () => {
  assert.equal(L.ROUTES.board, '/api/lab/loop/board');
  assert.equal(L.ROUTES.ledger, '/api/legion/ledger');
  assert.equal(L.ROUTES.roster, '/api/legion/roster');
  assert.equal(L.ROUTES.lab, '/api/lab');
  assert.equal(L.ROUTES.trades(F.A, 'worth_a_look', 2), '/api/legion/build/' + F.A + '/trades?show=worth_a_look&page=2');
  assert.equal(L.ROUTES.bars('MNQ', '2001-02-01'), '/api/bars?root=MNQ&session=2001-02-01');
  assert.match(L.failWords('/api/lab/loop/board', null), /did not answer \/api\/lab\/loop\/board \(it is off, or it does not let this page read it yet\)/);
  assert.match(L.failWords('/api/legion/roster', 403), /THEDESK_FILLS_FROM/);
  for (const f of ['live/ludus.js', 'live/ludus-core.js']) {
    const src = read(...f.split('/'));
    assert.doesNotMatch(src, /method:\s*'(POST|PUT|DELETE)'|\.post\(|\.send\(|new WebSocket|sendOrder|localStorage\.(setItem|removeItem)/, f + ': reads only, nothing sent');
    assert.deepEqual([...src.matchAll(/localStorage\.getItem\(([^)]*)\)/g)].map(m => m[1]), f === 'live/ludus.js' ? ["'live-colors-v1'"] : [], f + ': reads the chart page\'s saved candle colors only');
  }
  assert.match(read('live', 'ludus.js'), /o\.fetch\(base \+ path, \{ cache: 'no-store', mode: 'cors', credentials: 'omit' \}\)/, 'the one fetch: GET, no cookies');
});

test('the best try: law 6.7\'s figures of tries only, the highest; builds ranked as the board ranks them', () => {
  const runs = L.runsOf(F.BOARD, null);
  assert.equal(runs.from, 'board');
  assert.equal(runs.runs.length, 6);
  const list = L.builds(runs.runs, F.BOARD);
  assert.deepEqual(list.map(b => b.id), [F.A, F.C, F.B], 'best first, a build with no figure last');
  const a = list[0];
  assert.equal(a.best.run_id, 'run-a2', 'not the older figure (2.0), not the repeat (3.0)');
  assert.equal(a.name, 'samplea_v1');
  assert.deepEqual(a.specs, [F.SPEC_A]);
  assert.equal(a.tries, 3);
  assert.equal(list[2].best, null, 'not enough data: no best try');
  // the same from the ledger alone (no board): the same builds in the same order
  const led = L.runsOf(null, F.ledgerAnswer());
  assert.equal(led.from, 'ledger');
  assert.deepEqual(L.builds(led.runs, null).map(b => [b.id, b.best && b.best.run_id]), list.map(b => [b.id, b.best && b.best.run_id]));
  assert.equal(L.runsOf(null, { ok: false, problem: 'The loop\'s folder is not set.' }).problem, 'The loop\'s folder is not set.');
  assert.equal(L.bestTry([{ kind: 'try', prop: { profit_per_dollar: 5 } }]), null, 'a figure that names no line is the older one');
});

test('ROI first: profit per $1, pass rate, days to pass, payout per funded account, then the sample; not enough data yet', () => {
  const roi = L.roiOf(F.RUNS_A[1]);
  assert.deepEqual(L.roiCells(roi).map(c => c.label), ['Profit per $1', 'Pass rate', 'Days to pass', 'Payout per funded account', 'Sample']);
  assert.deepEqual(L.roiCells(roi).map(c => c.text), ['+0.82 per $1', '61%', '12 sessions (median)', '$1,240', '210 trades on 120 days, of 143 sessions']);
  assert.equal(L.noEdgeText(roi), 'above its no-edge p95 (+0.40)');
  const none = L.roiOf(F.RUNS_B[0]);
  assert.deepEqual(L.roiCells(none).map(c => c.text), [L.NOT_ENOUGH, L.NOT_ENOUGH, L.NOT_ENOUGH, L.NOT_ENOUGH, '12 trades on 9 days, of 40 sessions'], 'every number with its sample');
  assert.equal(L.NOT_ENOUGH, 'not enough data yet');
  const old = L.roiOf(F.RUNS_A[0]);
  assert.equal(L.roiCells(old)[0].text, '+2.00 per $1 (older figure)');
  assert.match(L.noEdgeText(old), /never judged against law 6\.7/);
  assert.match(L.SIMULATED, /^Simulated by the Prop Sim on in-sample days: nothing here is proven, and none of it is real money\.$/);
  assert.equal(L.sampleText(null), 'no sample');
  assert.equal(L.usd(-40), '-$40');
  assert.equal(L.perDollar(0), '+0.00 per $1');
});

test('the build page: per account type, its best try there; the roster\'s playbooks (never a lineup\'s or a quick file\'s)', () => {
  const [a, c] = L.builds(L.runsOf(F.BOARD, null).runs, F.BOARD);
  const types = L.byType(a);
  assert.deepEqual(types.map(t => [t.type, t.run, t.tries, L.roiCells(t.roi)[0].text]), [
    ['50K, daily loss limit, $150', 'run-a2', 2, '+0.82 per $1'],
    ['25K, daily loss limit, $110', 'run-a4', 1, '+0.35 per $1']]);
  const ro = L.rosterFor(F.rosterAnswer(), a);
  assert.equal(ro.name, 'sample_a_v1.json');
  assert.equal(ro.label, L.PLACED);
  assert.equal(ro.approved, false);
  assert.equal(L.rosterFor(F.rosterAnswer(), c), null, 'build C: only a quick file (refused) and a lineup');
  const byspec = { ok: true, files: [{ ok: true, quick: false, name: 'x.json', board: null, roster: F.ROSTER_A }] };
  assert.equal(L.rosterFor(byspec, a).name, 'x.json', 'matched by the spec when the board does not name it');
  assert.equal(L.planName(F.ROSTER_A), '50K, daily loss limit');
  const ev = L.playbookStage(F.ROSTER_A, 'eval'), fu = L.playbookStage(F.ROSTER_A, 'funded');
  assert.deepEqual(ev.cells.map(c => c.label + ': ' + c.text), ['Profit per $1: +1.10 per $1', 'Pass rate: 66%', 'Days to pass: 11 sessions (median)', 'Sample: 210 trades, of 143 sessions']);
  assert.deepEqual(ev.playbook.map(c => c.label + ': ' + c.text), ['Risk a trade: $200', 'Daily loss stop: $500', 'Daily profit stop: none', 'Max trades a day: 3']);
  assert.equal(fu.cells[0].label, 'Dollars per funded slot per 30 sessions', 'funded: the slot number leads (law 1.6)');
  assert.equal(fu.cells[0].text, L.NOT_GIVEN, 'not made up while the board does not carry it');
  assert.deepEqual(fu.cells.slice(1).map(c => c.text), ['+0.90 per $1', '$1,310', '52%', '19 sessions (median)', '210 trades, of 143 sessions']);
  assert.ok(fu.playbook.some(c => c.label === 'Payout at' && c.text === '$1,500'));
  assert.equal(ev.noEdge, 'above its no-edge p95 (+0.40)');
  assert.equal(ev.untuned, '+0.70 per $1 on the sessions not searched');
  assert.equal(L.playbookStage({}, 'eval'), null);
});

test('the zone and regime split is off, and nothing reads a zone figure', () => {
  assert.equal(L.ZONE_SPLIT_ON, false);
  assert.match(L.ZONES_OFF, /^Off until a zone version passes test 3 on later days/);
  for (const f of ['live/ludus.js', 'live/ludus-core.js']) assert.doesNotMatch(read(...f.split('/')).replace(/\/\*[\s\S]*?\*\//g, ''), /by_zone|by_day_zone|by_zone4|by_pd|[?&]zone=/, f);
});

test('the line, the checks and the stations I to VII', () => {
  const list = L.builds(L.runsOf(F.BOARD, null).runs, F.BOARD);
  const ln = L.lineOf(F.BOARD, list);
  assert.equal(ln.rows.length, 1);
  assert.equal(ln.rows[0].name, 'samplea_v1');
  assert.equal(L.roiCells(ln.rows[0].roi)[1].text, '61%', 'the line row leads with the held run\'s money');
  assert.deepEqual(ln.rows[0].halves, ['+0.90 per $1 (no-edge p95 +0.35)', '+0.70 per $1 (no-edge p95 +0.35)']);
  const ck = L.checksOf(list[0], F.BOARD);
  assert.deepEqual(ck.lines.map(l => [l.label, l.ok]), [['Trades on 70% of sessions (the floor)', true], ['Beats its no-edge line on both halves', true],
    ['At least 40 untuned sessions before proof', true], ['In the line of 30', true]]);
  assert.match(ck.lines[0].text, /^80% of its tuned sessions \(80 days with a trade of 100 sessions\)$/);
  assert.match(ck.missing, /microscalp/);
  const cc = L.checksOf(list[1], null);
  assert.deepEqual(cc.lines.map(l => l.ok), [false, false, true], 'C: under the floor, halves not scored (no board: no line standing)');
  const st = L.pipeline(F.BOARD, list, 6);
  assert.deepEqual(st.map(s => s.rn + ' ' + s.name), ['I Screen', 'II The line', 'III Proof', 'IV Your review', 'V Roster', 'VI Live check', 'VII Full size']);
  assert.deepEqual(st.map(s => s.count), [3, 1, 0, 0, 0, null, null]);
  assert.match(st[0].note, /Last night \(2001-03-01\): 9 builds made, 7 new ones\./);
  assert.match(st[2].note, /^1 build picked for proof \(3 a night\)\./);
  assert.match(st[4].note, /0 builds approved by you\. 1 file placed for the Legion build \(in-sample, not proven, not approved\)\./);
  assert.ok(st[0].items.every(x => x.link) && st[0].items[0].name === 'samplea_v1');
  assert.match(st[5].note, /not built yet/);
  assert.deepEqual(L.pipeline(null, [], 6).map(s => s.count), [0, 0, 0, 0, 0, null, null], 'no board: nothing invented');
});

test('the trades: discovery days only, 20 a page; the one trade on chart-engine\'s chart from its own numbers and the bars given', () => {
  const v = L.tradesOf(F.tradesAnswer(F.A, 'all', 1));
  assert.ok(v.ok && v.placeholder);
  assert.equal(v.rows.length, 20);
  assert.equal(v.pages, 3);
  assert.match(v.fence, /^Discovery days only \(by teststudio\/fence\.py\)\. 3 locked weeks of the proof counted, never listed or drawn\.$/);
  assert.equal(L.tradesOf(Object.assign(F.tradesAnswer(F.A, 'all', 1), { fence: { days: 'all' } })).ok, false, 'not discovery days: nothing shown');
  assert.equal(L.tradesOf({ ok: false, problem: 'This build has no trades file yet.' }).problem, 'This build has no trades file yet.');
  const t = v.rows[0];
  const w = L.tradeWindow(t, 'MNQ');
  assert.deepEqual(w, { root: 'MNQ', session: '2001-02-01', from: F.T0 - 3600000, to: F.T0 + 25 * 60000 + 1800000 });
  assert.equal(L.tradeWindow(v.rows[1], 'MNQ'), null, 'no entry time: no chart');
  const rows = L.barsIn(F.barsAnswer('2001-02-01'), w);
  assert.equal(rows.length, 60 + 25 + 30 + 1);
  assert.ok(rows.every(b => b[0] >= w.from && b[0] <= w.to));
  assert.deepEqual(L.barsIn(F.barsAnswer('2001-02-02'), w), []);
  const zone = s => CE.util.zoneSeconds(s);
  const d = L.chartOf(t, rows, zone, CE.LEVEL_COLORS.close);
  assert.equal(d.bars.length, rows.length);
  assert.equal(d.bars[0].t, zone(rows[0][0] / 1000), 'the chart\'s wall clock (New York)');
  assert.deepEqual(d.trades, [{ tIn: zone(F.T0 / 1000), pIn: 21000.25, tOut: zone((F.T0 + 25 * 60000) / 1000), pOut: 21006.25, dir: 1, label: '+1.50 R' }]);
  assert.deepEqual(d.levels, [{ name: 'Stop', price: 20996.25, color: CE.LEVEL_COLORS.close }]);
  assert.deepEqual(L.tradeRows(t).map(r => r.label), ['Trade', 'Side', 'Entry', 'Stop', 'Exit', 'R', 'P&L', 'Plain-code flags']);
  assert.equal(L.tradeRows(v.rows[1]).find(r => r.label === 'Entry').text, L.NOT_GIVEN);
});

test('the Builder, the Seeds and the Agents: read only here, with their samples', () => {
  const b = L.builderOf(F.BOARD);
  assert.deepEqual(b.slots.map(s => s.slot), ['window', 'location']);
  assert.equal(b.perNight, 3);
  assert.deepEqual(b.fates.map(f => f.state), ['ran', 'refused']);
  assert.match(L.builderOf({}).why, /no library yet/);
  const seeds = L.seedsOf(F.labAnswer());
  assert.deepEqual(seeds.map(s => [s.name, s.path, s.state]), [['Sample seed', 'fresh', 'waiting'], ['Sample fork', 'fork of seat S', 'refused']]);
  assert.ok(!('words' in seeds[0]), 'never the seed\'s words');
  const ag = L.agentsOf(F.helperStatus());
  assert.equal(L.edgeText(ag[0].live, ag[0].liveN), '+0.08 R over 40 trades');
  assert.equal(L.edgeText(ag[1].exam), L.NOT_ENOUGH);
});

test('the page: installed, mounted at the one place, shown only on its tab; no sample numbers in the page itself', () => {
  const www = JSON.parse(read('nt8', 'install-files.json')).www;
  for (const f of ['ludus-core.js', 'ludus.js', 'ludus.css']) assert.ok(www.some(x => x.from === 'live/' + f && x.to === f), f + ' is installed');
  const html = read('live', 'legion.html');
  assert.ok(html.indexOf('src="ludus-core.js"') < html.indexOf('src="ludus.js"') && html.indexOf('src="ludus.js"') < html.indexOf('src="legion-tabs.js"'), 'its core, its view, then the tabs that mount it');
  assert.ok(html.indexOf('href="legion.css"') < html.indexOf('href="ludus.css"'));
  const sec = /<section class="lx-view" id="lx-ludus"[\s\S]*?<\/section>/.exec(html)[0];
  assert.match(sec, /<div id="ldView"/);
  assert.doesNotMatch(sec, /\$\d|\d+%|sample/i, 'no numbers in the page itself');
  const tabs = read('live', 'legion-tabs.js');
  assert.match(tabs, /ludus = window\.LudusView\.mount\(\$\('ldView'\), \{ fetch: \(u, o\) => fetch\(u, o\), deskBase: \(\) => window\.AccountsPage\.deskBase/);
  assert.match(tabs, /if \(ludus\) guard\('the Ludus', \(\) => ludus\.show\(tab === 'ludus'\)\);/, 'a hidden Ludus reads nothing');
  assert.doesNotMatch(/let ludus = null;[\s\S]*?mounted\.ludus/.exec(tabs)[0], /\bAF\b|\bhub\b/, 'no ChartBridge connection handed to it');
  const view = read('live', 'ludus.js');
  assert.match(view, /o\.chart\.create\(host,/, 'the one trade on chart-engine\'s own engine');
  assert.doesNotMatch(view + read('live', 'ludus-core.js'), /lightweight-charts|chart\.js|echarts|highcharts|d3\./i, 'no other chart library');
});

test('the look: Legion\'s tokens, green and red for sides, R and P&L only; no Cinzel of its own; plain hyphens', () => {
  const css = read('live', 'ludus.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /purple|#[89a-f][0-9a-f]00ff|violet|crimson/i);
  assert.doesNotMatch(css, /overflow(-[xy])?:\s*(auto|scroll)/, 'no scroll box inside a page');
  const greens = [...css.matchAll(/([^{}]+)\{[^}]*--ws-(buy|sell)[^}]*\}/g)].map(m => m[1].trim());
  assert.deepEqual(greens, ['.ld-up', '.ld-down', '.ld-long', '.ld-short']);
  const view = read('live', 'ludus.js');
  for (const m of view.matchAll(/tone\(([^)]*)\)/g)) assert.match(m[1], /^(x|x\.r|x\.pnl|x\.exam|x\.live)$/, 'green and red only for R, P&L and edges in R: ' + m[1]);
  for (const f of ['live/ludus-core.js', 'live/ludus.js', 'live/ludus.css', 'test/ludus.test.js', 'test/ludus-smoke.mjs', 'test/fixtures/ludus-sample.js', 'live/legion.html', 'live/legion-tabs.js']) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) assert.ok(!/[\u2013\u2014]/.test(fs.readFileSync(p, 'utf8')), f + ': no em or en dashes');
  }
});
