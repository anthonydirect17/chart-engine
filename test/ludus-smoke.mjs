// Legion's Ludus and the build page (plan step 3.4, live/ludus.js) in a browser, against the fake bridge (--v3) and made-up
// answers of The Desk's reads (test/fixtures/ludus-sample.js: SAMPLE DATA ONLY, no build, run, price or bar here is real):
//   npm run smoke:ludus        (CHROMIUM_PATH=/path/to/chrome; SHOTS=dir)
// Checks: the five sub tabs; the Pipeline's stations I to VII; the Board's line of 30 and every build, ROI first, with the
// sample and "not enough data yet"; the build page (per account type, the eval and funded playbooks, the zone split off, the
// plain-code checks, the trades 20 a page with All, Winners, Losers and Worth a look) and one trade drawn on chart-engine's own
// chart (its own bars, Bot-Lab's from the master's ticks; a trade with none falls back to The Desk's stored bars, labelled);
// the address keeps all of it over a reload; the Builder, Seeds and Agents read only; with the board's read failing (The Desk
// off) the builds come from the ledger and the page says why. The stub gives CORS only where The Desk does (its /api/legion/
// routes, TheDesk #112): a read of a Lab route (/api/lab, /api/lab/loop/board, /api/bars) fails as the browser's CORS
// refusal does on the box, and is counted (the review of R12, B2). The Ludus sends The Desk only GETs. No page error, no
// box that scrolls inside the page, no sideways scroll on a phone. Screenshots (test/out): ludus-pipeline, ludus-board,
// ludus-build, ludus-trade, ludus-trade-desk-bars, ludus-builder, ludus-seeds, ludus-agents, ludus-noboard (1600 x 900) and ludus-phone-board,
// ludus-phone-build, ludus-phone-trade (390 x 844).
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const require = createRequire(import.meta.url);
const F = require('./fixtures/ludus-sample.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
const errors = [];
let checks = 0;
const check = (ok, m) => { checks++; if (!ok) { errors.push(m); console.error('  FAIL ' + m); } else console.log('  ok   ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = +(process.env.LUDUS_SMOKE_PORT || 8995);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET' };

async function withBridge(fn) {
  const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--test-pin=' + TEST_PIN, '--version=0.6.24'], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });
    await fn();
  } finally { bridge.kill(); }
}
/* The Desk (made-up answers) and the PC helper. board: 'ok' or 'blocked' (the board's read fails: The Desk off).
   CORS as The Desk gives it (docs/API.md, Legion): its /api/legion/ routes only, never the Lab's own. */
async function open(vp, query, board) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
  const desk = [];
  await ctx.route(/localhost:8800\//, async x => {
    const u = new URL(x.request().url()), m = x.request().method();
    desk.push(m + ' ' + u.pathname);
    const cors = u.pathname.startsWith('/api/legion/') ? CORS : {};
    if (m === 'OPTIONS') return x.fulfill({ status: 204, headers: cors });
    const json = b => x.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(b) });
    /* the Lab's own routes give this page no CORS: the browser refuses their answer, so the stub refuses them the same way
       (a fetch that throws; a fulfilled answer would reach the page here, as Playwright does not hold it to CORS) */
    if (u.pathname === '/api/lab/loop/board' || u.pathname === '/api/lab' || u.pathname === '/api/bars') return x.abort('accessdenied');
    if (u.pathname === '/api/legion/board') return board === 'blocked' ? x.abort('failed') : json(F.boardAnswer());
    if (u.pathname === '/api/legion/ledger') return json(F.ledgerAnswer());
    if (u.pathname === '/api/legion/roster') return json(F.rosterAnswer());
    if (u.pathname === '/api/legion/lab') return json({ seeds: F.labAnswer().seeds });
    if (u.pathname === '/api/legion/bars') return json(F.barsAnswer(u.searchParams.get('session')));
    const t = /^\/api\/legion\/build\/([0-9a-f]{64})\/trades$/.exec(u.pathname);
    if (t) return json(t[1] === F.A ? F.tradesAnswer(t[1], u.searchParams.get('show'), +u.searchParams.get('page')) : { ok: false, problem: 'This build has no trades file yet (sample).', trades: [] });
    return x.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{}' });
  });
  await ctx.route(/localhost:8767\//, x => (x.request().method() === 'OPTIONS' ? x.fulfill({ status: 204, headers: CORS })
    : x.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(F.helperStatus()) })));
  const page = await ctx.newPage();
  const pe = [];
  page.on('pageerror', e => pe.push(e.message));
  page.on('dialog', d => { pe.push('a browser dialog: ' + d.message()); d.dismiss(); });
  await page.goto(`http://localhost:${PORT}/live/legion.html${query || '?tab=ludus'}`);
  await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
  await enterPin(page, TEST_PIN);
  await page.waitForFunction(() => document.getElementById('lxConn').dataset.state === 'on', null, { timeout: 20000 });
  return { ctx, page, pe, desk };
}
const lstate = page => page.evaluate(() => (window.LegionTabs && typeof window.LegionTabs.state === 'function' ? window.LegionTabs.state().ludus : null) || {});
const until = (page, fn, arg, ms) => page.waitForFunction(fn, arg, { timeout: ms || 8000 }).catch(() => {});
/* no element inside the Ludus scrolls on its own (wide pages: the page scrolls, nothing inside it) */
const innerScrolls = page => page.evaluate(() => [...document.querySelectorAll('#lx-ludus *')].filter(e => {
  const s = getComputedStyle(e); return /(auto|scroll)/.test(s.overflowY + s.overflowX) && (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1);
}).map(e => e.className || e.tagName));
const sideways = page => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));

try {
  await withBridge(async () => {
    /* ---------------- 1600 x 900, The Desk answers every read */
    const { ctx, page, pe, desk } = await open({ width: 1600, height: 900 }, '?tab=ludus');
    await until(page, () => window.LegionTabs.state().ludus && window.LegionTabs.state().ludus.board === 'ok');
    const subs = await page.$$eval('[data-ld-sub]', b => b.map(x => x.textContent));
    check(JSON.stringify(subs) === JSON.stringify(['Pipeline', 'Board', 'Builder', 'Seeds', 'Agents']), 'the five sub tabs: ' + JSON.stringify(subs));
    const st = await page.$$eval('.ld-station', x => x.map(e => e.querySelector('.lx-rn').textContent + ' ' + e.querySelector('b').textContent + ' ' + e.querySelector('.ld-count').textContent));
    check(JSON.stringify(st) === JSON.stringify(['I Screen 3', 'II The line 1', 'III Proof 0', 'IV Your review 0', 'V Roster 0', 'VI Live check not built yet', 'VII Full size not built yet']), 'the Pipeline: stations I to VII with their counts: ' + JSON.stringify(st));
    check(/Read from the loop's board/.test(await page.textContent('#lx-ludus')), 'it says where it read from');
    await page.screenshot({ path: path.join(SHOTS, 'ludus-pipeline.png'), fullPage: true });

    await page.click('[data-ld-sub="board"]'); await sleep(200);
    check(/ludus=board/.test(await page.evaluate(() => location.search)), 'the address keeps the Board');
    const heads = await page.$$eval('.ld-builds th', x => x.map(e => e.textContent));
    check(heads.slice(0, 5).join('|') === 'Build|Profit per $1|Pass rate|Days to pass|Payout per funded account' && heads[5] === 'Sample', 'ROI first, then the sample: ' + heads.join('|'));
    const rows = await page.$$eval('.ld-builds tbody tr', x => x.map(e => [...e.querySelectorAll('td')].slice(0, 6).map(c => c.textContent)));
    check(rows.length === 3 && rows[0][0].startsWith('samplea_v1') && rows[0][1] === '+0.82 per $1' && rows[0][2] === '61%' && rows[0][3] === '12 sessions (median)' && rows[0][4] === '$1,240' && /210 trades on 120 days, of 143 sessions/.test(rows[0][5]),
      'the best build first, its best try by law 6.7\'s line: ' + JSON.stringify(rows[0]));
    check(rows[2][0].startsWith('sampleb_v1') && rows[2][1] === 'not enough data yet' && /12 trades on 9 days/.test(rows[2][5]), 'a build under the minimums: not enough data yet, with its sample: ' + JSON.stringify(rows[2]));
    const line = await page.$$eval('.ld-line tbody tr', x => x.map(e => e.textContent));
    check(line.length === 1 && /samplea_v1/.test(line[0]) && /may go to proof/.test(line[0]), 'the line of 30: ' + JSON.stringify(line));
    await page.screenshot({ path: path.join(SHOTS, 'ludus-board.png'), fullPage: true });

    /* the build page */
    await page.click('.ld-builds [data-ld-build="' + F.A + '"]');
    await until(page, () => window.LegionTabs.state().ludus.trades === 'ok');
    check((await page.evaluate(() => location.search)).includes('build=' + F.A), 'the address names the build');
    const body = await page.textContent('#lx-ludus');
    check(/Simulated by the Prop Sim on in-sample days: nothing here is proven, and none of it is real money\./.test(body), 'simulated numbers labelled simulated');
    const types = await page.$$eval('.ld-types tbody tr', x => x.map(e => e.textContent));
    check(types.length === 2 && /^50K, daily loss limit, \$150/.test(types[0]) && /^25K, daily loss limit, \$110/.test(types[1]), 'per account type: ' + JSON.stringify(types));
    const pbs = await page.$$eval('.ld-pb h3', x => x.map(e => e.textContent));
    check(JSON.stringify(pbs) === JSON.stringify(['Eval: played for speed', 'Funded: played steadier']) && /Roster file sample_a_v1\.json \(in-sample, not proven, not approved\)/.test(body), 'its best eval and funded playbooks, labelled: ' + JSON.stringify(pbs));
    check(/Dollars per funded slot per 30 sessions\s*not given yet/.test(body) && /Risk a trade\s*\$200/.test(body), 'the funded slot number leads, not made up; the playbook\'s values');
    check(/Off until a zone version passes test 3 on later days/.test(body), 'the zone and regime split: off');
    check(/Trades on 70% of sessions \(the floor\):/.test(body) && /microscalp/.test(body), 'the plain-code checks, and the ones not on the board yet named');
    const tr = await page.$$eval('.ld-trades tbody tr', x => x.length);
    const shows = await page.$$eval('[data-ld-show]', x => x.map(e => e.textContent));
    check(tr === 20 && JSON.stringify(shows) === JSON.stringify(['All (45)', 'Winners (30)', 'Losers (15)', 'Worth a look (5)']), 'the trades, 20 a page, with the four views and their counts: ' + JSON.stringify(shows));
    check(/Discovery days only \(by teststudio\/fence\.py\)\. 3 locked weeks of the proof counted, never listed or drawn\./.test(body), 'discovery days only; the locked weeks counted, never listed');
    await page.screenshot({ path: path.join(SHOTS, 'ludus-build.png'), fullPage: true });
    await page.click('.ld-pager[data-pager="trades"] button:last-child');
    await until(page, () => /page=2/.test(location.search) && window.LegionTabs.state().ludus.trades === 'ok');
    check((await page.$$eval('.ld-trades tbody tr', x => x[0].querySelector('td').textContent)) === '21', 'Next: the second page starts at trade 21');
    await page.click('[data-ld-show="losers"]');
    await until(page, () => /show=losers/.test(location.search) && window.LegionTabs.state().ludus.trades === 'ok');
    const losers = await page.$$eval('.ld-trades tbody tr', x => x.map(e => e.querySelectorAll('td')[3].textContent));
    check(losers.length === 15 && losers.every(r => r === '-1.00 R') && !/page=/.test(await page.evaluate(() => location.search)), 'Losers: 15, each below 0 R, from page 1');
    await page.click('[data-ld-show="all"]');
    await until(page, () => !/show=/.test(location.search) && window.LegionTabs.state().ludus.trades === 'ok');

    /* one trade on the chart */
    await page.click('[data-ld-trade-btn="1"]');
    await until(page, () => window.LegionTabs.state().ludus.chart === true);
    await sleep(400);
    const ch = await page.evaluate(() => { const c = document.querySelector('#ldChart canvas'); if (!c) return null;
      const g = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let lit = 0, first = null; for (let i = 0; i < g.length; i += 4) { if (first === null) first = g[i] + g[i + 1] + g[i + 2]; if (Math.abs(g[i] + g[i + 1] + g[i + 2] - first) > 30) lit++; }
      return { w: c.width, h: c.height, lit }; });
    check(ch && ch.w > 300 && ch.h > 200 && ch.lit > 2000, 'trade 1 drawn on chart-engine\'s chart (the bars, the trade and its stop): ' + JSON.stringify(ch));
    check(/trade=1/.test(await page.evaluate(() => location.search)) && /Entry\s*21000\.25/.test(await page.textContent('#ldOne')) && /Flag this trade: not built yet/.test(await page.textContent('#ldOne')), 'its numbers beside it; the address keeps it');
    check((await lstate(page)).barsFrom === 'trade' && /This trade's own 1-minute bars, written by Bot-Lab from the master's ticks/.test(await page.textContent('#ldOne'))
      && !desk.some(r => / \/api\/(legion\/)?bars\b/.test(r)), 'trade 1: drawn from its own bars (the master\'s ticks), labelled; no read of The Desk\'s stored bars');
    await page.screenshot({ path: path.join(SHOTS, 'ludus-trade.png'), fullPage: true });
    await page.click('[data-ld-trade-btn="3"]');
    await until(page, () => window.LegionTabs.state().ludus.bars === 'ok' && window.LegionTabs.state().ludus.chart === true);
    await sleep(300);
    const s3 = await lstate(page), one3 = await page.textContent('#ldOne');
    check(s3.chart === true && s3.barsFrom === 'desk' && /This trade carries no bars of its own\. Instead: The Desk's stored 1-minute bars of that session \(ChartBridge's, not the master's ticks\)/.test(one3)
      && desk.some(r => r.startsWith('GET /api/legion/bars')), 'trade 3: no bars of its own, so The Desk\'s stored bars from /api/legion/bars, labelled plainly');
    await page.screenshot({ path: path.join(SHOTS, 'ludus-trade-desk-bars.png'), fullPage: true });
    await page.click('[data-ld-trade-btn="2"]'); await sleep(300);
    const s2 = await lstate(page);
    check(!s2.chart && /no bars of its own/.test(s2.barsWhy) && /no entry time/.test(s2.barsWhy), 'a trade with no bars and no entry time: no chart, and it says why: ' + s2.barsWhy);
    check((await innerScrolls(page)).length === 0, 'no box scrolls inside the page: ' + JSON.stringify(await innerScrolls(page)));

    /* a reload keeps the build page and the trade */
    await page.goto(`http://localhost:${PORT}/live/legion.html?tab=ludus&ludus=board&build=${F.A}&trade=1`);
    await page.waitForFunction(() => document.querySelector('.cb-pin-key') || (document.getElementById('lxConn') && document.getElementById('lxConn').dataset.state === 'on'), null, { timeout: 15000 });
    if (await page.$('.cb-pin-key')) await enterPin(page, TEST_PIN);
    await until(page, () => window.LegionTabs && typeof window.LegionTabs.state === 'function' && window.LegionTabs.state().ludus && window.LegionTabs.state().ludus.chart === true, null, 15000);
    check((await lstate(page)).chart === true && (await page.$$eval('[data-ld-sub]', b => b.filter(x => x.getAttribute('aria-selected') === 'true').length)) === 0, 'a reload opens the same build page with the same trade on the chart');
    await page.click('[data-ld-back]'); await sleep(200);
    check(/ludus=board/.test(await page.evaluate(() => location.search)) && !/build=/.test(await page.evaluate(() => location.search)) && (await page.$$('.ld-builds')).length === 1, 'Back to the Board');

    /* Builder, Seeds, Agents: read only */
    await page.click('[data-ld-sub="builder"]'); await sleep(200);
    const lib = await page.$$eval('.ld-lib dt', x => x.map(e => e.textContent));
    check(JSON.stringify(lib) === JSON.stringify(['window', 'location']) && (await page.$$('.ld-fates tbody tr')).length === 2 && /stays on The Desk's Lab/.test(await page.textContent('#lx-ludus')), 'the Builder: the library and each request\'s fate');
    await page.screenshot({ path: path.join(SHOTS, 'ludus-builder.png'), fullPage: true });
    await page.click('[data-ld-sub="seeds"]');
    await until(page, () => document.querySelectorAll('.ld-seeds tbody tr').length === 2);
    check((await page.$$eval('.ld-seeds tbody tr', x => x.map(e => e.textContent))).join('|').includes('refused: sample reason'), 'the Seeds: each request\'s state');
    await page.screenshot({ path: path.join(SHOTS, 'ludus-seeds.png'), fullPage: true });
    await page.click('[data-ld-sub="agents"]');
    await until(page, () => document.querySelectorAll('.ld-agents tbody tr').length === 3);
    const ag = await page.$$eval('.ld-agents tbody tr', x => x.map(e => e.textContent));
    check(/\+0\.08 R over 40 trades/.test(ag[0]) && /not enough data yet \(the PC helper reports no sample for it\)/.test(ag[0]) && !/\+0\.12/.test(ag[0])
      && /not enough data yet/.test(ag[1]) && /not enough data yet \(n 12 of 20\)/.test(ag[2]) && !/\+0\.30/.test(ag[2]),
      'the Agents: each edge with its sample, not enough data yet under 20 trades or with no sample: ' + JSON.stringify(ag));
    check(/from 20 trades on \(the league's bar\)/.test(await page.textContent('#lx-ludus')), 'the Agents say the bar');
    await page.screenshot({ path: path.join(SHOTS, 'ludus-agents.png'), fullPage: true });

    /* leaving the tab: the address drops the Ludus's keys, and a hidden Ludus is not shown */
    await page.click('[data-lx-tab="castra"]'); await sleep(200);
    check(!/ludus=|build=/.test(await page.evaluate(() => location.search)) && (await lstate(page)).shown === false, 'another tab: the Ludus\'s keys leave the address, the Ludus is hidden');
    /* the Ludus's routes (the Account page's own PUT /api/chart-accounts/listed, from the cohorts' rows, is not the Ludus's) */
    const mine = desk.filter(r => / \/api\/(lab|legion|bars)\b/.test(r));
    const writes = mine.filter(r => !/^(GET|OPTIONS) /.test(r));
    check(writes.length === 0 && mine.some(r => r.startsWith('GET /api/legion/build/')), 'only GETs from the Ludus reached The Desk: ' + JSON.stringify(writes));
    const lab = mine.filter(r => / \/api\/(lab|bars)\b/.test(r));
    check(lab.length === 0 && ['board', 'lab', 'bars'].every(k => mine.some(r => r.startsWith('GET /api/legion/' + k))), 'The Desk\'s Legion routes only (board, lab, bars), never the Lab\'s (no CORS there): ' + JSON.stringify(lab));
    check(pe.length === 0, 'no page error: ' + JSON.stringify(pe));
    await ctx.close();

    /* ---------------- the board's read failing (The Desk off, or one from before #112): the ledger instead */
    const nb = await open({ width: 1600, height: 900 }, '?tab=ludus&ludus=board', 'blocked');
    await until(nb.page, () => window.LegionTabs.state().ludus && window.LegionTabs.state().ludus.ledger === 'ok');
    const nbt = await nb.page.textContent('#lx-ludus');
    check(/The board: The Desk did not answer \/api\/legion\/board \(it is off, or it does not let this page read it yet\)\. The builds below are read from the loop's ledger instead\./.test(nbt), 'it says why the board is not read, and where the builds come from');
    check((await nb.page.$$('.ld-builds tbody tr')).length === 3 && (await nb.page.$$('.ld-line')).length === 0, 'every build from the ledger; no line without the board');
    await nb.page.screenshot({ path: path.join(SHOTS, 'ludus-noboard.png'), fullPage: true });
    await nb.page.click('[data-ld-build="' + F.A + '"]');
    await until(nb.page, () => window.LegionTabs.state().ludus.trades === 'ok');
    check((await nb.page.$$('.ld-types tbody tr')).length === 2 && (await nb.page.$$('.ld-pb')).length === 2, 'the build page from the ledger and the roster');
    check(nb.pe.length === 0, 'no page error: ' + JSON.stringify(nb.pe));
    await nb.ctx.close();

    /* ---------------- a phone */
    const ph = await open({ width: 390, height: 844 }, '?tab=ludus&ludus=board');
    await until(ph.page, () => window.LegionTabs.state().ludus && window.LegionTabs.state().ludus.board === 'ok');
    let w = await sideways(ph.page);
    const stacked = await ph.page.evaluate(() => getComputedStyle(document.querySelector('.ld-builds thead')).display);
    check(w.sw <= w.cw && stacked === 'none', 'phone, the Board: no sideways scroll, the tables stack: ' + JSON.stringify(w) + ' ' + stacked);
    await ph.page.screenshot({ path: path.join(SHOTS, 'ludus-phone-board.png'), fullPage: true });
    await ph.page.click('.ld-builds [data-ld-build="' + F.A + '"]');
    await until(ph.page, () => window.LegionTabs.state().ludus.trades === 'ok');
    w = await sideways(ph.page);
    check(w.sw <= w.cw, 'phone, the build page: no sideways scroll: ' + JSON.stringify(w));
    await ph.page.screenshot({ path: path.join(SHOTS, 'ludus-phone-build.png'), fullPage: true });
    await ph.page.click('[data-ld-trade-btn="1"]');
    await until(ph.page, () => window.LegionTabs.state().ludus.chart === true);
    await sleep(400);
    w = await sideways(ph.page);
    const box = await ph.page.evaluate(() => { const r = document.getElementById('ldChart').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
    check(w.sw <= w.cw && box.w > 300 && box.h >= 240, 'phone, the trade on the chart: full width, no sideways scroll: ' + JSON.stringify({ w, box }));
    await ph.page.locator('#ldOne').scrollIntoViewIfNeeded();
    await ph.page.screenshot({ path: path.join(SHOTS, 'ludus-phone-trade.png') });
    check((await innerScrolls(ph.page)).length === 0, 'phone: no box scrolls inside the page');
    check(ph.pe.length === 0, 'phone: no page error: ' + JSON.stringify(ph.pe));
    await ph.ctx.close();
  });
} catch (e) {
  errors.push('the smoke threw: ' + (e && e.stack ? e.stack : e));
} finally {
  await browser.close();
}
console.log(checks + ' checks, ' + errors.length + ' failed');
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
