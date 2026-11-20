// chart 1.60.0 (Anthony 2026-11-19) in a browser. Two parts, made-up messages and answers only (SAMPLE DATA: no account, firm, PC
// or number here is real):
//   npm run smoke:legion-claim        (CHROMIUM_PATH=/path/to/chrome; SHOTS=dir; LEGION_CLAIM_SMOKE_PORT)
// 1. Arm claims the firm's PC: Legion's trader desk (live/legion-desk.js) with the real Agent desk and the page's real claimer
//    (LegionCastraCore.createClaimer) on a stand-in feed and a stand-in Desk. Auto (its second click) on a trader on a prop account
//    whose firm runs on another PC sends nothing to ChartBridge, writes The Desk's firm-pc once with this PC's name as ChartBridge
//    gives it (groups.firmGuard.pc), says "Claiming Firm A for this PC...", and sends the Auto only once ChartBridge's next groups
//    message shows the firm "here": true. The Desk refusing, and no "here" within the wait, send nothing and say why. Shadow
//    cancels a claim that waits. The firm already this PC's: the Auto goes at once, The Desk is not asked. The Bot desk never claims.
// 2. Finished prop accounts are hidden: Legion's page (live/legion.html) against the fake bridge, with The Desk's answer marking a
//    tray account blown: the Cohorts tab leaves it out and says "1 finished prop account hidden", Castra's Needs you no longer
//    lists it as "in no cohort" and says the same line.
// Screenshots (test/out): legion-claim-waiting, legion-claim-armed, legion-claim-refused, legion-hidden-cohorts, legion-hidden-castra.
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const PORT = +(process.env.LEGION_CLAIM_SMOKE_PORT || 8998);

const css = ['workspace.css', 'bot.css', 'agent.css'].map(f => `<link rel="stylesheet" href="${pathToFileURL(path.join(root, 'live', f))}">`).join('');
const js = ['bot-core.js', 'agent-core.js', 'fleet.js', 'motion.js', 'agent-helper.js', 'agent-grid.js', 'bot.js', 'agent.js', 'legion-desk.js', 'ludus-core.js', 'legion-castra-core.js']
  .map(f => `<script src="${pathToFileURL(path.join(root, 'live', f))}"></script>`).join('\n');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">${css}
<style>html,body{margin:0}body{display:block;overflow:auto}</style></head>
<body><div class="ws-top"><span>SAMPLE DATA: made-up accounts, firms, PCs and traders</span></div>
<div id="lgd" style="height:900px"></div>
${js}
<script>
  window.posted = []; window.subs = []; window.deskCalls = []; window.deskMode = 'ok';
  window.deskState = { version: 3, pc: 'PC-ONE' };
  const AF = { listen: h => { window.subs.push(h); return () => {}; }, post: m => { window.posted.push(m); return true; }, send: () => true, sendOrder: () => true };
  window.feed = m => { for (const h of window.subs) h.message(m); };
  /* a stand-in Desk (made up): GET /api/legion/cohorts and PUT /api/legion/firm-pc, each call kept */
  const answer = () => ({ v: 1, version: window.deskState.version, note: 'made up', cohorts: [], firms: [{ firm: 'Firm A', pc: window.deskState.pc, set_ms: 1, cohorts: [] }], by_pc: {},
    prop_accounts: [{ account: 'PROP-1', firm: 'Firm A', stage: 'eval', cohort: null, pc: window.deskState.pc }], finished_accounts: [], bought_for: {}, pick_history: {}, problems: [] });
  const resp = (status, b) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(b) });
  const deskFetch = (u, o) => {
    const p = new URL(u).pathname, m = (o && o.method) || 'GET';
    window.deskCalls.push(m + ' ' + p + (o && o.body ? ' ' + o.body : ''));
    if (m === 'GET' && p === '/api/legion/cohorts') return resp(200, answer());
    if (m === 'PUT' && p === '/api/legion/firm-pc') {
      if (window.deskMode === 'refuse') return resp(400, { detail: 'a made-up refusal' });
      const b = JSON.parse(o.body);
      if (b.version !== window.deskState.version) return resp(409, { detail: 'stale', version: window.deskState.version });
      window.deskState.pc = b.pc; window.deskState.version++;
      return resp(200, answer());
    }
    return resp(404, {});
  };
  const K = window.LegionCastraCore;
  window.claimer = K.createClaimer({ desk: K.deskClient({ fetch: deskFetch, deskBase: () => 'http://localhost:8800' }), waitMs: 2500 });
  AF.listen({ message: m => window.claimer.hear(m), closed: () => window.claimer.lost() });
  const mem = new Map(), storage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
  window.legion = window.LegionDesk.mount(document.getElementById('lgd'), { v3: AF, storage, shown: true, side: 'agent',
    claim: (t, s) => window.claimer.claim(t, s), claimCancel: () => window.claimer.cancel() });
</script></body></html>`;
const file = path.join(SHOTS, 'legion-claim-smoke.html');
fs.writeFileSync(file, html);

const accounts = { type: 'accounts', personalNamed: true, list: [
  { name: 'MINE-1', connection: 'connected', personal: true, prop: false, sim: false, tradable: true, state: 'ok', pnlToday: 0, positions: [] },
  { name: 'PROP-1', connection: 'connected', prop: true, sim: false, tradable: true, state: 'ok', pnlToday: 0, positions: [] }] };
const guard = (pc, here) => ({ state: 'on', why: null, pc: 'PC-TWO', readAt: Date.now(), firms: [{ firm: 'Firm A', pc, here, accounts: ['PROP-1'], sides: [] }] });
const groups = g => ({ type: 'groups', list: [], error: null, firmGuard: g });
const agent = more => Object.assign({ type: 'agent', agent: 'demo', name: 'Demo Agent', build: 'sample-build-1', enabled: true, connected: true, mode: 'shadow', account: 'PROP-1', sim: false,
  killed: false, standDown: null, owns: false, lastBeatMs: 300, rules: { maxTrades: 2, maxLosses: 1, entryFrom: '09:40', entryUntil: '15:00', flatAt: '15:55' } }, more || {});

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  /* ================================================================ 1. Arm claims the firm's PC */
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('dialog', d => { pageErrors.push('a browser dialog: ' + d.message()); d.dismiss(); });
  await page.goto(pathToFileURL(file).href);
  const feed = m => page.evaluate(x => window.feed(x), m);
  const posted = () => page.evaluate(() => window.posted.filter(m => !Array.isArray(m) && !/Seen$/.test(m.type)).map(m => m.type + (m.agent ? ':' + m.agent : '') + (m.mode ? ':' + m.mode : '')));
  const desk = () => page.evaluate(() => window.deskCalls.slice());
  const clear = () => page.evaluate(() => { window.posted.length = 0; window.deskCalls.length = 0; });
  const L = '#lgd .lgd-agent';
  const why = () => page.evaluate(s => (document.querySelector(s + ' [data-k="modeWhy"]') || {}).textContent || '', L);
  const autoText = () => page.evaluate(s => (document.querySelector(s + ' [data-mode="auto"]') || {}).textContent || '', L);
  const pressAuto = async () => { await page.click(L + ' [data-mode="auto"]'); await sleep(500); await page.click(L + ' [data-mode="auto"]'); await sleep(300); };

  await feed({ type: 'hello', version: '0.6.25', features: ['v3'], instruments: [{ root: 'MNQ', tick: 0.25, pointValue: 2 }] });
  await feed({ type: 'trading', enabled: true, switches: { bot: true, agents: true } });
  await feed(accounts); await feed(groups(guard('PC-ONE', false))); await feed(agent());
  await sleep(300); await clear();

  await pressAuto();
  check((await posted()).length === 0, 'Auto on a firm that runs on PC-ONE: nothing goes to ChartBridge yet: ' + JSON.stringify(await posted()));
  const d1 = await desk();
  check(d1[0] === 'GET /api/legion/cohorts' && d1[1] === 'PUT /api/legion/firm-pc {"version":3,"firm":"Firm A","pc":"PC-TWO"}' && d1.length === 2,
    'The Desk is told once: this PC as ChartBridge names it (firmGuard.pc), with the version it read: ' + JSON.stringify(d1));
  check(/^Claiming Firm A for this PC \(PC-TWO\)\.\.\. waiting for ChartBridge here to read it/.test(await why()), 'the desk says it is claiming: ' + await why());
  check(await autoText() === 'Claiming...', 'the Auto button reads Claiming...');
  await page.screenshot({ path: path.join(SHOTS, 'legion-claim-waiting.png') });
  await feed(groups(guard('PC-ONE', false))); await sleep(200);
  check((await posted()).length === 0, 'ChartBridge still reads the old table (its once-a-minute read has not come): still nothing sent');
  await feed(groups(guard('PC-TWO', true))); await sleep(300);
  check(JSON.stringify(await posted()) === JSON.stringify(['agentMode:demo:auto']), 'ChartBridge shows Firm A "here": the Auto goes, once: ' + JSON.stringify(await posted()));
  check(/^Firm A now trades from PC-TWO \(this PC\); Firm A was PC-ONE: .*refused from that PC's next read of The Desk \(within a minute\); nothing there is closed or cancelled\. Auto sent\.$/.test(await why()), 'and says where the firm trades now: ' + await why());
  await feed(agent({ mode: 'auto' })); await sleep(200);
  await page.screenshot({ path: path.join(SHOTS, 'legion-claim-armed.png') });

  /* the firm already this PC's: Auto goes at once, The Desk is not asked */
  await feed(agent()); await sleep(200); await clear();
  await pressAuto();
  check(JSON.stringify(await posted()) === JSON.stringify(['agentMode:demo:auto']) && (await desk()).length === 0, 'the firm already this PC\'s: the Auto goes at once, The Desk not asked: ' + JSON.stringify([await posted(), await desk()]));

  /* The Desk refuses: nothing goes */
  await feed(groups(guard('PC-ONE', false))); await feed(agent()); await sleep(200); await clear();
  await page.evaluate(() => { window.deskMode = 'refuse'; window.deskState.pc = 'PC-ONE'; });
  await pressAuto(); await sleep(300);
  check((await posted()).length === 0 && /^The Desk refused it: a made-up refusal, so this PC did not claim Firm A: nothing was armed; the trader stays in Shadow\.$/.test(await why()),
    'The Desk refuses: nothing goes, said plainly: ' + await why());
  await page.screenshot({ path: path.join(SHOTS, 'legion-claim-refused.png') });

  /* no "here" within the wait (2.5 s on this page, 90 s on Legion): nothing goes */
  await page.evaluate(() => { window.deskMode = 'ok'; }); await sleep(6200); await clear();
  await pressAuto();
  await sleep(3000);
  check((await posted()).length === 0 && /did not show Firm A as this PC's within 3 s, so nothing was armed: the trader stays in Shadow/.test(await why()),
    'no "here" in time: nothing goes, said plainly: ' + await why());

  /* Shadow cancels a claim that waits */
  await page.evaluate(() => { window.deskState.pc = 'PC-ONE'; }); await sleep(6200); await clear();
  await pressAuto();
  check(await page.evaluate(() => window.claimer.state().busy), 'a claim waits');
  await page.click(L + ' [data-mode="shadow"]'); await sleep(200);
  check(!(await page.evaluate(() => window.claimer.state().busy)) && /^Claim cancelled: nothing was armed\.$/.test(await why()), 'Shadow cancels it: ' + await why());
  await feed(groups(guard('PC-TWO', true))); await sleep(300);
  check((await posted()).filter(x => x === 'agentMode:demo:auto').length === 0, 'and the late "here" sends nothing: ' + JSON.stringify(await posted()));
  check(pageErrors.length === 0, 'no page error: ' + pageErrors.join(' | '));
  await page.close();

  /* ================================================================ 2. finished accounts hidden on Legion's page */
  const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--test-controls', '--test-pin=' + TEST_PIN, '--version=0.6.24', '--personal=FUNDED-C', '--trading', '--agents=demo'], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    const model = Object.assign(F.cohortsAnswer({ tray: 'EVAL-D' }), { finished_accounts: [{ account: 'EVAL-D', reason: 'blown', at_ms: 978307200000 }] });
    const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, PUT, POST' };
    await ctx.route(/localhost:8800\//, async x => {
      const u = new URL(x.request().url()), m = x.request().method();
      if (m === 'OPTIONS') return x.fulfill({ status: 204, headers: CORS });
      const json = b => x.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(b) });
      if (m === 'GET' && u.pathname === '/api/legion/cohorts') return json(model);
      if (m === 'GET' && u.pathname === '/api/legion/money') return json(F.moneyAnswer());
      if (m === 'GET' && u.pathname === '/api/legion/roster') return json(F.rosterAnswer());
      if (m === 'GET' && u.pathname === '/api/legion/centurion') return json(F.centurionAnswer());
      if (m === 'GET' && u.pathname === '/api/legion/board') return json(F.boardAnswer());
      if (m === 'GET' && u.pathname === '/api/chart-league') return json({ date: '2001-02-01', trades: [], open: [], decisions: [] });
      return x.fulfill({ status: 404, contentType: 'application/json', headers: CORS, body: '{}' });
    });
    const p2 = await ctx.newPage();
    const pe2 = [];
    p2.on('pageerror', e => pe2.push(e.message));
    await p2.goto(`http://localhost:${PORT}/live/legion.html?tab=cohorts`);
    await p2.waitForSelector('.cb-pin-key', { timeout: 15000 });
    await enterPin(p2, TEST_PIN);
    await p2.waitForFunction(() => document.getElementById('lxConn').dataset.state === 'on', null, { timeout: 20000 });
    await p2.waitForFunction(() => !!document.querySelector('#chView .ch-tray'), null, { timeout: 15000 }).catch(() => {});
    const tray = await p2.evaluate(() => [...document.querySelectorAll('#chView .ch-tray [data-ch-account]')].map(e => e.dataset.chAccount));
    const line = await p2.evaluate(() => { const e = document.querySelector('#chView [data-ch-hidden]'); return e ? e.textContent + ' | ' + e.title : ''; });
    check(!tray.includes('EVAL-D'), 'Cohorts: the blown account is not in the tray: ' + JSON.stringify(tray));
    check(/^1 finished prop account hidden \(blown, promoted or archived on The Desk: Fleet keeps it\)\. \| EVAL-D: blown$/.test(line), 'and one line says so: ' + line);
    check(await p2.evaluate(() => /its bots trade from PC-ONE\./.test(document.querySelector('#chView .ch-firms').textContent)), 'the firm line: where its bots trade from');
    await p2.screenshot({ path: path.join(SHOTS, 'legion-hidden-cohorts.png'), fullPage: false });
    await p2.click('[data-lx-tab="castra"]');
    await p2.waitForFunction(() => /Needs you/.test(document.getElementById('cxView').textContent) && /finished prop account hidden/.test(document.getElementById('cxView').textContent), null, { timeout: 15000 }).catch(() => {});
    const needs = await p2.evaluate(() => { const c = [...document.querySelectorAll('#cxView .cx-card')].find(x => /Needs you/.test(x.querySelector('h2').textContent)); return c ? c.textContent : ''; });
    check(!/in no cohort/.test(needs) && /1 finished prop account hidden/.test(needs), 'Castra\'s Needs you: no "in no cohort" for it, and the hidden line: ' + needs.slice(0, 300));
    await p2.screenshot({ path: path.join(SHOTS, 'legion-hidden-castra.png'), fullPage: false });
    check(pe2.length === 0, 'no page error: ' + pe2.join(' | '));
    await ctx.close();
  } finally { bridge.kill(); }
} finally {
  await browser.close();
}
console.log(errors.length ? errors.length + ' of ' + checks + ' checks FAILED' : 'all ' + checks + ' checks passed');
process.exit(errors.length ? 1 : 0);
