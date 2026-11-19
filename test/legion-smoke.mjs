// Legion's own page (plan step 3.2, live/legion.html) in a browser against the fake bridge (--v3, the made-up agent demo, sample
// data only; no account, trader or number here is real):
//   npm run smoke:legion        (CHROMIUM_PATH=/path/to/chrome; SHOTS=dir)
// Checks: the PIN pad first (the same PIN as the chart page); the header with the wordmark, the five tabs in order with their
// numerals, the clock, ChartBridge's state and Stop all automation, on every tab; the address keeps the tab and the chart page's
// old words land where the tab moved (?tab=legion, ?tab=league, ?tab=agent); Go live says "Not built yet" (Castra: test/legion-castra-smoke.mjs; the Ludus: test/ludus-smoke.mjs);
// Cohorts holds the chart page's Legion tab and Praetorian, the Colosseum the chart page's Colosseum, each the real module.
// Stop all: a double click on the button sends nothing; Yes inside its first moment is refused; Yes by the keyboard is refused;
// Escape and Cancel close it; a real click on Yes sends exactly one message, Kill all with ChartBridge 0.6.24 (and the header says
// the ledger is not covered), agentStopAll with 0.6.25, and ChartBridge's answer shows. No page error. No sideways scroll on
// a phone. Screenshots (test/out): legion-castra, legion-cohorts, legion-praetorian, legion-colosseum, legion-ludus, legion-golive,
// legion-ask, legion-answer (1600 x 900) and legion-phone-castra, legion-phone-cohorts, legion-phone-ask (390 x 844).
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
const errors = [];
let checks = 0;
const check = (ok, m) => { checks++; if (!ok) { errors.push(m); console.error('  FAIL ' + m); } else console.log('  ok   ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE_PORT = +(process.env.LEGION_SMOKE_PORT || 8993);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

async function withBridge(version, port, fn) {
  const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(port), '--v3', '--trading', '--test-controls', '--test-pin=' + TEST_PIN, '--agents=demo', '--version=' + version], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });
    await fn(port);
  } finally { bridge.kill(); }
}
const received = port => fetch(`http://127.0.0.1:${port}/test/received`, { method: 'POST' }).then(r => r.json());
async function open(port, vp, query) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
  /* The Desk, the roster and the PC helper are not part of this smoke: answered 404 (each part says it plainly) */
  await ctx.route(/localhost:8800|localhost:8767/, x => x.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
  const page = await ctx.newPage();
  const pe = [];
  page.on('pageerror', e => pe.push(e.message));
  page.on('dialog', d => { pe.push('a browser dialog: ' + d.message()); d.dismiss(); });
  await page.goto(`http://localhost:${port}/live/legion.html${query || ''}`);
  await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
  await enterPin(page, TEST_PIN);
  await page.waitForFunction(() => document.getElementById('lxConn').dataset.state === 'on', null, { timeout: 20000 });
  return { ctx, page, pe };
}
const app = page => page.evaluate(() => window.LegionApp.state());

try {
  await withBridge('0.6.24', BASE_PORT, async port => {
    const { ctx, page, pe } = await open(port, { width: 1600, height: 900 });
    check(await page.title() === 'Castra · Legion · Imperium', 'the window\'s title names the tab: ' + await page.title());
    const head = await page.evaluate(() => ({ word: document.querySelector('.lx-word-name').textContent, font: getComputedStyle(document.querySelector('.lx-word-name')).fontFamily,
      tabs: [...document.querySelectorAll('[data-lx-tab]')].map(b => b.textContent), stop: document.getElementById('lxStop').textContent, conn: document.getElementById('lxConn').textContent }));
    check(head.word === 'LEGION' && /Cinzel/.test(head.font), 'the wordmark LEGION in Cinzel: ' + JSON.stringify(head));
    check(JSON.stringify(head.tabs) === JSON.stringify(['ICastra', 'IICohorts', 'IIIColosseum', 'IVLudus', 'VGo live']), 'the five tabs in order with their numerals: ' + JSON.stringify(head.tabs));
    check(head.stop === 'Stop all automation' && /0\.6\.24: on/.test(head.conn), 'Stop all automation and ChartBridge\'s state in the header');
    const note = await page.getAttribute('#lxStopNote', 'title');   // the R12 delta, S-a: the standing word in the header's caption
    check(await page.evaluate(() => document.getElementById('lxHead').contains(document.getElementById('lxStopNote')) && document.getElementById('lxStopSaid').hidden), 'the R12 delta, S-a: the standing word sits in the header beside Stop all; no floating line for it');
    check(/own prop rule only .* not by the account ledger/.test(note), 'ChartBridge 0.6.24: the header says Stop all is Kill all by ChartBridge\'s own rule, not the ledger: ' + note);
    for (const t of ['castra', 'cohorts', 'colosseum', 'ludus', 'golive']) {
      await page.click('[data-lx-tab="' + t + '"]');
      await sleep(t === 'cohorts' || t === 'colosseum' ? 900 : 250);
      const s = await page.evaluate(() => ({ url: location.search, shown: [...document.querySelectorAll('.lx-view')].filter(v => !v.hidden).map(v => v.id), stop: !!document.getElementById('lxStop').offsetParent }));
      check(s.url.includes('tab=' + t) && s.shown.length === 1 && s.shown[0] === 'lx-' + t && s.stop, t + ': its page alone shows, the address keeps it, Stop all is in reach: ' + JSON.stringify(s));
      await page.screenshot({ path: path.join(SHOTS, 'legion-' + t + '.png') });
    }
    for (const t of ['golive']) check(/Not built yet\./.test(await page.textContent('#lx-' + t)), t + ' says Not built yet');
    const parts = await page.evaluate(() => ({ app: window.LegionApp.state(), tabs: window.LegionTabs.state() }));
    check(parts.app.mounted.join() === 'cohorts,praetorian,castra,cohortModel,colosseum,ludus' && parts.app.failed.length === 0, 'the moved tabs are mounted, none failed: ' + JSON.stringify(parts.app));
    check(parts.tabs.cohorts && parts.tabs.colosseum && parts.tabs.praetorian, 'each moved tab answers its own state (FleetView, LeagueView, AgentDesk)');
    await page.click('[data-lx-tab="cohorts"]'); await sleep(400);
    check(await page.locator('#flView .fl-title').first().textContent() === 'Legion', 'Cohorts: the chart page\'s Legion tab, drawn by live/fleet.js');
    check((await page.evaluate(() => window.LegionTabs.state().cohorts.shown)) === true, 'Cohorts: FleetView shown while its side is');
    await page.click('[data-lx-sub="praetorian"]'); await sleep(900);
    const pr = await page.evaluate(() => ({ url: location.search, prShown: window.LegionTabs.state().praetorian.shown, flShown: window.LegionTabs.state().cohorts.shown, view: !!document.querySelector('#agView .ag-desk, #agView [data-parity]') }));
    check(/sub=praetorian/.test(pr.url) && pr.prShown && !pr.flShown && pr.view, 'Praetorian: the Agent desk for your personal account, shown alone, the address keeps it: ' + JSON.stringify(pr));
    await page.screenshot({ path: path.join(SHOTS, 'legion-praetorian.png') });
    await page.click('[data-lx-tab="colosseum"]'); await sleep(700);
    check(/COLOSSEUM|Colosseum/.test(await page.textContent('#lgView')) && (await page.evaluate(() => window.LegionTabs.state().colosseum.shown)), 'Colosseum: the chart page\'s Colosseum, drawn by live/league.js');
    await page.click('[data-lx-tab="castra"]'); await sleep(200);
    const pr2 = await page.evaluate(() => ({ pr: window.LegionTabs.state().praetorian.shown, fl: window.LegionTabs.state().cohorts.shown, lg: window.LegionTabs.state().colosseum.shown }));
    check(!pr2.pr && !pr2.fl && !pr2.lg, 'on Castra no moved tab is shown (a hidden one reads and acknowledges nothing): ' + JSON.stringify(pr2));

    /* Stop all: the question and its guards */
    const r0 = await received(port), sent0 = (r0.types.agentKillAllProp || 0) + (r0.types.agentStopAll || 0);
    await page.dblclick('#lxStop');
    await sleep(300);
    const afterDbl = await app(page), r1 = await received(port);
    check(((r1.types.agentKillAllProp || 0) + (r1.types.agentStopAll || 0)) === sent0, 'a double click on Stop all sends nothing: ' + JSON.stringify(afterDbl));
    if (!afterDbl.asking) await page.click('#lxStop');
    check((await app(page)).asking && await page.locator('#lxStopAsk').isVisible(), 'the question opens in the page (no browser dialog)');
    check(/by its own prop rule only: an account The Desk's ledger types eval or funded that NinjaTrader lists as Sim is NOT stopped/.test(await page.textContent('#lxStopQ')),
      'the R12 delta, nit: ChartBridge 0.6.24: the ledger caveat is in the question itself: ' + await page.textContent('#lxStopQ'));
    await page.screenshot({ path: path.join(SHOTS, 'legion-ask.png') });
    await page.click('#lxStopNo');
    check(!(await app(page)).asking, 'Cancel closes it');
    await page.click('#lxStop'); await page.click('#lxStopYes');
    const early = await app(page);
    check(early.asking && /Too soon/.test(early.said), 'Yes inside its first moment: nothing sent, the question stays: ' + early.said);
    await sleep(700);
    await page.focus('#lxStopYes'); await page.keyboard.press('Enter');
    const key = await app(page);
    check(key.asking && /click on Yes only/.test(key.said), 'Yes by the keyboard is refused: ' + key.said);
    await page.keyboard.press('Escape');
    check(!(await app(page)).asking, 'Escape closes it');
    const r2 = await received(port);
    check(((r2.types.agentKillAllProp || 0) + (r2.types.agentStopAll || 0)) === sent0, 'nothing was sent by any of that');
    await page.click('#lxStop'); await sleep(700); await page.click('#lxStopYes');
    await page.waitForFunction(() => /Kill all \(prop accounts\)/.test(document.getElementById('lxStopSaid').textContent) && !/waiting/.test(document.getElementById('lxStopSaid').textContent), null, { timeout: 5000 }).catch(() => {});
    const r3 = await received(port), done = await app(page);
    check((r3.types.agentKillAllProp || 0) === (r0.types.agentKillAllProp || 0) + 1 && (r3.types.agentStopAll || 0) === (r0.types.agentStopAll || 0), 'a real click on Yes: exactly one Kill all with ChartBridge 0.6.24: ' + JSON.stringify(r3.types));
    check(!done.asking && !done.pending && /^Kill all \(prop accounts\)/.test(done.said), 'ChartBridge\'s answer shows in the header: ' + done.said);
    await page.screenshot({ path: path.join(SHOTS, 'legion-answer.png') });
    /* round 4, GOLIVE_MIN: the Go live tab says plainly that this ChartBridge cannot go live */
    await page.click('[data-lx-tab="golive"]'); await sleep(200);
    check(await page.locator('#lxGoLiveWhy').isVisible() && /^Go live needs ChartBridge 0\.6\.25 or later \(its firm and GO-size guards\); this one is 0\.6\.24\./.test(await page.textContent('#lxGoLiveWhy')),
      'round 4: Go live on ChartBridge 0.6.24 says it needs 0.6.25: ' + await page.textContent('#lxGoLiveWhy'));
    await page.screenshot({ path: path.join(SHOTS, 'legion-golive-old.png') });
    await page.click('[data-lx-tab="castra"]'); await sleep(200);
    check(pe.length === 0, 'no page error: ' + JSON.stringify(pe));
    await ctx.close();

    /* the chart page's old words */
    for (const [q, want] of [['?tab=legion', 'cohorts|legion'], ['?tab=league', 'colosseum|'], ['?tab=agent', 'cohorts|praetorian'], ['?tab=golive', 'golive|']]) {
      const o = await open(port, { width: 1366, height: 768 }, q);
      await sleep(300);
      const s = await app(o.page);
      check(s.tab + '|' + s.sub === want, q + ' opens ' + want + ': ' + s.tab + '|' + s.sub);
      await o.ctx.close();
    }

    /* a phone: the header wraps, the tables stack, no sideways scroll */
    const ph = await open(port, { width: 390, height: 844 });
    for (const t of ['castra', 'cohorts']) {
      await ph.page.click('[data-lx-tab="' + t + '"]'); await sleep(800);
      const w = await ph.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, stop: document.getElementById('lxStop').getBoundingClientRect().width }));
      check(w.sw <= w.cw && w.stop > 150, 'phone, ' + t + ': no sideways scroll, Stop all wide enough to hit: ' + JSON.stringify(w));
      await ph.page.screenshot({ path: path.join(SHOTS, 'legion-phone-' + t + '.png') });
    }
    await ph.page.click('[data-lx-tab="castra"]'); await ph.page.click('#lxStop'); await sleep(200);
    const pq = await ph.page.evaluate(() => { const q = document.getElementById('lxStopQ'), r = q.getBoundingClientRect(); const b = document.getElementById('lxStopAsk').getBoundingClientRect(); return { text: q.textContent, whole: q.scrollHeight <= q.clientHeight + 1 && q.scrollWidth <= q.clientWidth + 1, left: Math.round(b.left), right: Math.round(b.right), cw: document.documentElement.clientWidth }; });
    check(/NOT stopped/.test(pq.text) && pq.whole && pq.left >= 0 && pq.right <= pq.cw, 'phone: the question with its caveat shows whole: ' + JSON.stringify(pq));
    await ph.page.screenshot({ path: path.join(SHOTS, 'legion-phone-ask.png') });
    check(ph.pe.length === 0, 'phone: no page error: ' + JSON.stringify(ph.pe));
    await ph.ctx.close();
  });

  /* the next ChartBridge: Stop all automation with the ledger */
  await withBridge('0.6.25', BASE_PORT + 1, async port => {
    const { ctx, page, pe } = await open(port, { width: 1600, height: 900 });
    check((await page.textContent('#lxStopSaid')) === '' && await page.locator('#lxStopSaid').isHidden() && (await page.textContent('#lxStopNote')) === '', 'ChartBridge 0.6.25: no note beside Stop all');
    check(!/NOT stopped/.test(await page.textContent('#lxStopQ')), 'ChartBridge 0.6.25: the question has no caveat');
    const r0 = await received(port);
    await page.click('#lxStop'); await sleep(700); await page.click('#lxStopYes');
    await page.waitForFunction(() => /^Stop all automation:/.test(document.getElementById('lxStopSaid').textContent), null, { timeout: 5000 }).catch(() => {});
    const r1 = await received(port), s = await app(page);
    check((r1.types.agentStopAll || 0) === (r0.types.agentStopAll || 0) + 1 && (r1.types.agentKillAllProp || 0) === (r0.types.agentKillAllProp || 0), 'a real click on Yes: exactly one agentStopAll: ' + JSON.stringify(r1.types));
    check(/^Stop all automation:/.test(s.said) && !s.saidBad, 'its answer shows (round 4: its status line carries the press\'s cid, and it is this press\'s): ' + s.said);
    await page.click('[data-lx-tab="golive"]'); await sleep(200);
    check(await page.locator('#lxGoLiveWhy').isHidden(), 'round 4: on ChartBridge 0.6.25 the Go live tab has no version line');
    check(pe.length === 0, 'no page error: ' + JSON.stringify(pe));
    await ctx.close();
  });
} catch (e) {
  errors.push('the smoke threw: ' + (e && e.stack ? e.stack : e));
} finally {
  await browser.close();
}
console.log(checks + ' checks, ' + errors.length + ' failed');
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
