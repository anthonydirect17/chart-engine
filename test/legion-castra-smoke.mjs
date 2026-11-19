// Legion's Castra and the cohort model (plan step 3.3, live/legion-castra.js and live/legion-cohorts.js) in a browser, against the fake
// bridge (--v3, made-up accounts) and made-up answers of The Desk's Legion reads (test/fixtures/castra-sample.js: SAMPLE DATA ONLY):
//   npm run smoke:castra        (CHROMIUM_PATH=/path/to/chrome; SHOTS=dir)
// Checks, Castra: real against simulated money first, ROI led, each with its sample, simulated labelled; the money alarm shown (and
// says it stops nothing yet); who goes in today (approved first, overall profit per $1, days to pass, payout speed, the zone split
// off); Needs you as the one place; running now and today (live, from ChartBridge); last night; Centurion's week read only with
// no veto action. Checks, Cohorts: the cohorts with their picks, firm, PC and "direction: not built yet"; account chips with
// ChartBridge's live figures; the link to Fleet; the Drone sky mounted; a drag onto a cohort sends The Desk exactly one PUT with the
// version it read; a position and a cannot-tell are refused in plain words before anything is sent; The Desk's own refusal and a
// stale version come back in plain words; the "Move to" list does the same as a drag. The two tabs send The Desk only GETs and
// that one PUT; nothing to ChartBridge. No page error, no box that scrolls inside the page, no sideways scroll on a phone.
// With The Desk off, both say so and show no number. Screenshots (test/out): castra, castra-off, cohorts, cohorts-refused,
// cohorts-moved (1600 x 900) and castra-phone, cohorts-phone (390 x 844).
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const require = createRequire(import.meta.url);
const F = require('./fixtures/castra-sample.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
const errors = [];
let checks = 0;
const check = (ok, m) => { checks++; if (!ok) { errors.push(m); console.error('  FAIL ' + m); } else console.log('  ok   ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = +(process.env.CASTRA_SMOKE_PORT || 8996);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, PUT' };

function startBridge(port, flags) {
  const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(port), '--v3', '--test-controls', '--test-pin=' + TEST_PIN, '--version=0.6.24', '--personal=FUNDED-C', '--gone-grace-ms=600000'].concat(flags), { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((res, rej) => { bridge.stdout.once('data', () => res(bridge)); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });
}
async function withBridge(fn) {
  const bridge = await startBridge(PORT, ['--trading', '--agents=demo']);
  try { await fn(); } finally { bridge.kill(); }
}
/* The Desk (made-up answers), with a cohort model that moves: a stage that is not the cohort's is refused, a stale version is a 409 */
async function open(vp, query, mode, port) {
  const PT = port || PORT;
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
  const desk = [];
  const model = F.cohortsAnswer({ tray: 'EVAL-A' });
  const hold = { slow: mode === 'slow' ? 2500 : 0 };
  await ctx.route(/localhost:8800\//, async x => {
    const u = new URL(x.request().url()), m = x.request().method();
    desk.push(m + ' ' + u.pathname);
    if (mode === 'off') return x.abort('failed');
    if (hold.slow && m === 'GET') await sleep(hold.slow);
    if (m === 'OPTIONS') return x.fulfill({ status: 204, headers: CORS });
    const json = (b, status) => x.fulfill({ status: status || 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(b) });
    if (m === 'GET') {
      if (u.pathname === '/api/legion/money') return json(F.moneyAnswer());
      if (u.pathname === '/api/legion/cohorts') return json(model);
      if (u.pathname === '/api/legion/roster') return json(F.rosterAnswer());
      if (u.pathname === '/api/legion/centurion') return json(F.centurionAnswer());
      if (u.pathname === '/api/legion/board') return json(F.boardAnswer());
      if (u.pathname === '/api/chart-league') return json({ date: '2001-02-01', trades: [], open: [], decisions: [] });
    }
    if (m === 'PUT' && u.pathname === '/api/legion/cohorts/members') {
      const b = JSON.parse(x.request().postData() || '{}');
      desk.push('PUT body ' + JSON.stringify(b));
      if (b.version !== model.version) return json({ detail: 'stale', version: model.version }, 409);
      const to = b.cohort === null ? null : model.cohorts.find(c => c.id === b.cohort);
      const own = model.prop_accounts.find(a => a.account === b.account);
      if (to && own && to.stage !== own.stage) return json({ detail: b.account + ' is of stage ' + own.stage + ': this cohort is ' + to.stage }, 400);
      let moved = null;
      for (const c of model.cohorts) { const i = c.accounts.findIndex(a => a.account === b.account); if (i >= 0) moved = c.accounts.splice(i, 1)[0]; }
      if (to) to.accounts.push(moved || { account: b.account, firm: 'Firm A', stage: own.stage, type: { name: '50K Eval' }, problem: null });
      if (own) own.cohort = b.cohort;
      model.version++;
      return json(model);
    }
    return x.fulfill({ status: 404, contentType: 'application/json', headers: CORS, body: '{}' });
  });
  const page = await ctx.newPage();
  const pe = [];
  page.on('pageerror', e => pe.push(e.message));
  page.on('dialog', d => { pe.push('a browser dialog: ' + d.message()); d.dismiss(); });
  await page.goto(`http://localhost:${PT}/live/legion.html${query || ''}`);
  await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
  await enterPin(page, TEST_PIN);
  await page.waitForFunction(() => document.getElementById('lxConn').dataset.state === 'on', null, { timeout: 20000 });
  /* the fake's EVAL-B starts without a connection: it is given one, flat, so a drag of it is allowed (EVAL-A holds 2 MNQ; FUNDED-C is the personal pick: not a prop row) */
  if (port) return { ctx, page, pe, desk, model, hold };
  await page.request.post(`http://localhost:${PT}/test/account?name=EVAL-B&connection=connected`);
  await page.waitForFunction(() => { const f = window.LegionTabs.parts.fleet; if (!f) return false; const a = f.state().accounts.find(x => x.name === 'EVAL-B'); return !!a && a.position === 'Flat' && f.state().arm.state !== 'unknown'; }, null, { timeout: 15000 });   // and the traders are heard (the demo trader is in Shadow)
  return { ctx, page, pe, desk, model, hold };
}
const until = (page, fn, arg, ms) => page.waitForFunction(fn, arg, { timeout: ms || 8000 }).catch(() => {});
const text = (page, sel) => page.textContent(sel).then(t => (t || '').replace(/\s+/g, ' ').trim());
const innerScrolls = (page, sel) => page.evaluate(s => [...document.querySelectorAll(s + ' *')].filter(e => {
  const c = getComputedStyle(e); return /(auto|scroll)/.test(c.overflowY + c.overflowX) && (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1);
}).map(e => e.className || e.tagName), sel);
const sideways = page => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
const cstate = page => page.evaluate(() => window.LegionTabs.state());

try {
  await withBridge(async () => {
    /* ---------------- Castra, 1600 x 900 */
    const a = await open({ width: 1600, height: 900 }, '?tab=castra');
    await until(a.page, () => window.LegionTabs.state().castra.reads.money === 'ok' && window.LegionTabs.state().castra.reads.board === 'ok' && window.LegionTabs.state().castra.reads.centurion === 'ok');
    await sleep(1500);
    const cx = await text(a.page, '#cxView');
    check(!(await a.page.isVisible('#lx-castra .lx-todo')) && /Real against simulated money/.test(cx), 'Castra is built: the placeholder is gone, real against simulated money leads');
    const firstCard = await a.page.evaluate(() => document.querySelector('#cxView .cx-card h2').textContent);
    check(/Real against simulated money/.test(firstCard), 'the first card of the page is the money: ' + firstCard);
    check(/-0\.40 per \$1/.test(cx) && /\+1\.10 per \$1 \(range \+0\.20 to \+2\.00\), simulated/.test(cx), 'real profit per $1 beside the simulated one, which says simulated');
    check(/3 ledger entries on 2 accounts/.test(cx) && /not enough data yet/.test(await text(a.page, '#cxView [data-cx-build="sample_b_v1"]')), 'each with its sample; no costs reads "not enough data yet"');
    check(/Simulated by the Prop Sim on in-sample days: not proven/.test(cx), 'the simulated label');
    check(/Money alarm: not known yet\./.test(cx) && /range for the same number of evals is not served yet/.test(cx) && !/TRIPPED/i.test(cx), 'the money alarm reads not known yet: it does not trip on a range for another number of evals');
    check(/sample_a_v1/.test(await text(a.page, '.cx-goes')) && /approved by Anthony/.test(await text(a.page, '.cx-goes')) && /11 sessions \(median, simulated\)/.test(cx) && /19 sessions to the first payout/.test(cx), 'who goes in today: the approved build with days to pass and payout speed');
    check(/Split by zone and regime: off\./.test(cx) && /Off until a zone version passes test 3/.test(cx), 'the zone split is shown as off');
    check(/Needs you/.test(cx) && /1 prop account in no cohort \(EVAL-A\)/.test(await text(a.page, '#cxView .cx-needs')) && !/money alarm/.test(await text(a.page, '#cxView .cx-needs')), 'Needs you lists what waits, and the alarm is not on it');
    check(/Named account type: not built yet \(law 1\.6\)/.test(cx) && /Dollars per funded slot per 30 sessions: not built yet \(law 1\.6\)/.test(cx) && /Veto: not built yet \(plan steps 2\.9 and 3\.3\)/.test(cx), 'the named type, dollars per funded slot and the veto say not built yet (law 1.6)');
    check(/Nothing is running now|No trader is listed|ChartBridge is not connected/.test(await text(a.page, '#cxView')) || await a.page.isVisible('.cx-run'), 'running now says what ChartBridge says');
    check(/Today, live only/.test(cx) && /Live only: what ChartBridge reports now/.test(cx), 'today, live only');
    check(/Last night/.test(cx) && /2001-03-01/.test(cx) && /9 \(7 new, 2 neighbours/.test(cx), 'last night: the board\'s newest night');
    check(/Centurion's week/.test(cx) && /made-up finding one/.test(cx) && /this page has no veto action/.test(cx) && !(await a.page.$('#cxView button[data-cx-veto]')), 'Centurion\'s week is read only, no veto action');
    /* a refresh keeps the last answer: the page is not blanked and Needs you is not all clear while it reads */
    a.hold.slow = 2000;
    await a.page.click('[data-cx-again]'); await sleep(400);
    const mid = await text(a.page, '#cxView');
    check(/-0\.40 per \$1/.test(mid) && /1 prop account in no cohort/.test(mid) && !/Nothing needs you/.test(mid), 'during a refresh the last answer stays and Needs you is not all clear');
    a.hold.slow = 0;
    check(a.desk.filter(d => /\/api\/legion\//.test(d) && !/^GET /.test(d)).length === 0, 'Castra sends The Desk only GETs on its Legion routes: ' + a.desk.filter(d => /\/api\/legion\//.test(d) && !/^GET /.test(d)).join());
    check((await innerScrolls(a.page, '#lx-castra')).length === 0, 'no box scrolls inside Castra: ' + JSON.stringify(await innerScrolls(a.page, '#lx-castra')));
    await a.page.screenshot({ path: path.join(SHOTS, 'castra.png'), fullPage: true });
    check(a.pe.length === 0, 'no page error: ' + a.pe.join(' | '));
    await a.ctx.close();

    /* ---------------- Cohorts, 1600 x 900 */
    const c = await open({ width: 1600, height: 900 }, '?tab=cohorts');
    await until(c.page, () => window.LegionTabs.state().cohortModel && window.LegionTabs.state().cohortModel.state === 'ok');
    await until(c.page, () => /room/.test((document.querySelector('[data-ch-account="EVAL-B"]') || {}).textContent || ''), null, 10000);
    await sleep(500);
    const ch0 = await text(c.page, '#chView');
    check(await c.page.$$eval('#chView .ch-cohort', n => n.length) === 3 && /Alpha/.test(ch0) && /Beta/.test(ch0) && /Gamma/.test(ch0), 'three cohorts');
    check(/sample_a_v1 \(sample_a_v1\.json\)/.test(ch0) && /No pick yet/.test(ch0) && /PC: PC-ONE/.test(ch0) && /Firm A/.test(ch0), 'each cohort\'s pick, firm and PC');
    check(/Direction:?\s*not built yet/.test(ch0) || /not built yet \(the one-direction check is step 3\.5/.test(ch0), 'the firm\'s direction today says not built yet');
    check(await c.page.$$eval('#chView .ch-chip', n => n.length) === 3, 'account chips: one in Alpha, one in Beta, one in no cohort');
    check(/today/.test(await text(c.page, '[data-ch-account="EVAL-B"]')) && /room/.test(await text(c.page, '[data-ch-account="EVAL-B"]')), 'a chip shows the live room and today');
    check(/not listed by ChartBridge/.test(await text(c.page, '[data-ch-account="FUNDED-C"]')), 'a chip ChartBridge does not list says so, no guess');
    const href = await c.page.getAttribute('#chView a.lx-link', 'href');
    check(/^http:\/\/localhost:8800\/#\/prop\/fleet$/.test(href || ''), 'the link to Fleet: ' + href);
    check(await c.page.$('#chView .ak-wrap') !== null, 'the Drone sky is mounted');
    check(await c.page.$('#flView .fl-head, #flView section, #flView .fl-box') !== null, 'FleetView stays under it');
    await c.page.screenshot({ path: path.join(SHOTS, 'cohorts.png'), fullPage: true });

    /* a drag onto a cohort: one PUT with the version read */
    const before = c.desk.length;
    await c.page.dragAndDrop('[data-ch-account="EVAL-B"]', '[data-ch-drop="gamma"]');
    await until(c.page, () => window.LegionTabs.state().cohortModel.cohorts.find(x => x.id === 'gamma').accounts.includes('EVAL-B'));
    const puts = c.desk.slice(before).filter(d => /^PUT /.test(d));
    check(puts[0] === 'PUT /api/legion/cohorts/members' && puts[1] === 'PUT body {"version":4,"account":"EVAL-B","cohort":"gamma"}', 'a drag sends one PUT with the version it read: ' + puts.join(' | '));
    check(puts.length === 2, 'and no other write');
    await sleep(300);
    check(/EVAL-B is in Gamma\./.test(await text(c.page, '.ch-said')) && (await cstate(c.page)).cohortModel.version === 5, 'the answer is the new model: it says so and holds version 5');
    await c.page.screenshot({ path: path.join(SHOTS, 'cohorts-moved.png'), fullPage: true });

    /* refused here: a position, and a chip ChartBridge does not list */
    const n1 = c.desk.length;
    await c.page.dragAndDrop('[data-ch-account="EVAL-A"]', '[data-ch-drop="gamma"]');
    await sleep(300);
    const said1 = await text(c.page, '.ch-said');
    check(/EVAL-A holds a position \(Long 2 MNQ\)/.test(said1) && /nothing is moved while it does/.test(said1), 'a position is refused in plain words: ' + said1);
    await c.page.dragAndDrop('[data-ch-account="FUNDED-C"]', '[data-ch-drop="alpha"]');
    await sleep(300);
    check(/not listed by ChartBridge now, so this page cannot tell/.test(await text(c.page, '.ch-said')), 'a chip it cannot read is refused: it will not guess');
    check(c.desk.slice(n1).filter(d => /^PUT/.test(d)).length === 0, 'nothing was sent for either');
    await c.page.screenshot({ path: path.join(SHOTS, 'cohorts-refused.png'), fullPage: true });

    /* The Desk's own refusal (a stage that is not the cohort's), through the "Move to" list */
    await c.page.selectOption('[data-ch-move="EVAL-B"]', 'c:beta');
    await until(c.page, () => /The Desk refused it/.test(document.querySelector('.ch-said').textContent));
    check(/The Desk refused it: EVAL-B is of stage eval: this cohort is funded\./.test(await text(c.page, '.ch-said')), 'The Desk\'s refusal comes back in plain words: ' + await text(c.page, '.ch-said'));
    /* a stale version: another change came first */
    c.model.version += 3;
    await c.page.selectOption('[data-ch-move="EVAL-B"]', 'c:alpha');
    await until(c.page, () => /Another change came first/.test(document.querySelector('.ch-said').textContent));
    check(/Another change came first, so nothing was moved/.test(await text(c.page, '.ch-said')), 'a stale version says another change came first');
    await until(c.page, v => window.LegionTabs.state().cohortModel.version === v, c.model.version);
    check((await cstate(c.page)).cohortModel.version === c.model.version, 'and the cohorts are read again');
    check(c.desk.filter(d => /\/api\/legion\//.test(d) && /^(POST|DELETE|PATCH) /.test(d)).length === 0 && c.desk.filter(d => /^PUT \/api\/legion/.test(d)).every(d => d === 'PUT /api/legion/cohorts/members'), 'no write but the one PUT route');
    check((await innerScrolls(c.page, '#lx-cohorts .lx-card:not(.fl-box)')).filter(x => /ch-|cx-/.test(String(x))).length === 0, 'no box scrolls inside the cohort cards');
    check(c.pe.length === 0, 'no page error: ' + c.pe.join(' | '));
    await c.ctx.close();

    /* ---------------- The Desk off: both say so and show no number */
    const off = await open({ width: 1600, height: 900 }, '?tab=castra', 'off');
    await until(off.page, () => window.LegionTabs.state().castra.reads.money === 'fail');
    await sleep(300);
    const t = await text(off.page, '#cxView');
    check(/The Desk did not answer \/api\/legion\/money/.test(t) && /Cannot tell: /.test(t) && !/-0\.40|\+1\.10/.test(t), 'with The Desk off: Castra says so, names the reads, shows no number');
    await off.page.screenshot({ path: path.join(SHOTS, 'castra-off.png'), fullPage: true });
    await off.page.click('[data-lx-tab="cohorts"]'); await sleep(500);
    check(/The Desk did not answer \/api\/legion\/cohorts/.test(await text(off.page, '#chView')), 'and the cohorts too');
    check(off.pe.length === 0, 'no page error: ' + off.pe.join(' | '));
    await off.ctx.close();

    /* ---------------- nothing read yet: Needs you cannot tell, it is never all clear */
    const slow = await open({ width: 1600, height: 900 }, '?tab=castra', 'slow');
    await sleep(600);
    const st = await text(slow.page, '#cxView');
    check(/Cannot tell: .*roster.* is not read yet/.test(st) && !/Nothing needs you/.test(st), 'while the reads are pending Needs you says cannot tell, not all clear: ' + st.slice(0, 200));
    await slow.ctx.close();

    /* ---------------- before the sign-in replay: accounts are there, the traders are not heard. FleetView says so through its Armed state
       ('unknown'); here that state is forced (the fake cannot be held in the moment between the two), and the page must refuse every drag */
    const q = await open({ width: 1600, height: 900 }, '?tab=cohorts');
    await until(q.page, () => window.LegionTabs.state().cohortModel && window.LegionTabs.state().cohortModel.state === 'ok');
    await sleep(1200);
    await q.page.evaluate(() => { const f = window.LegionTabs.parts.fleet, was = f.state; f.state = () => Object.assign(was.call(f), { arm: { state: 'unknown', text: 'Armed: not known' } }); });
    await sleep(2200);
    const nq = q.desk.length;
    await q.page.dragAndDrop('[data-ch-account="EVAL-B"]', '[data-ch-drop="gamma"]');
    await sleep(300);
    check(/cannot tell whether a cohort is in Auto: ChartBridge has not sent the traders yet/.test(await text(q.page, '.ch-said')), 'a drag before the traders are heard is refused in plain words: ' + await text(q.page, '.ch-said'));
    check(q.desk.slice(nq).filter(d => /^PUT/.test(d)).length === 0, 'and no PUT is sent');
    await q.page.click('[data-lx-tab="castra"]'); await sleep(1300);
    check(/cannot tell what is running/.test(await text(q.page, '#cxView')), 'Castra says it cannot tell what is running, not "nothing"');
    check(q.pe.length === 0, 'no page error: ' + q.pe.join(' | '));
    await q.ctx.close();

    /* ---------------- a phone, 390 x 844 */
    const p = await open({ width: 390, height: 844 }, '?tab=castra');
    await until(p.page, () => window.LegionTabs.state().castra.reads.money === 'ok');
    await sleep(400);
    await p.page.screenshot({ path: path.join(SHOTS, 'castra-phone.png'), fullPage: true });
    let sw = await sideways(p.page);
    check(sw.sw <= sw.cw + 1, 'Castra on a phone: no sideways scroll ' + JSON.stringify(sw));
    check(await p.page.evaluate(() => getComputedStyle(document.querySelector('.cx-money thead')).display === 'none'), 'its tables stack on a phone');
    await p.page.click('[data-lx-tab="cohorts"]');
    await until(p.page, () => window.LegionTabs.state().cohortModel.state === 'ok'); await sleep(500);
    await p.page.screenshot({ path: path.join(SHOTS, 'cohorts-phone.png'), fullPage: true });
    sw = await sideways(p.page);
    check(sw.sw <= sw.cw + 1, 'Cohorts on a phone: no sideways scroll ' + JSON.stringify(sw));
    check(p.pe.length === 0, 'no page error: ' + p.pe.join(' | '));
    await p.ctx.close();
  });
} finally { await browser.close(); }
console.log(errors.length ? '\n' + errors.length + ' of ' + checks + ' checks FAILED' : '\nall ' + checks + ' checks passed');
process.exit(errors.length ? 1 : 0);
