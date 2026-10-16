// The Agent tab's heroes-on-duty board and a group's default hero (chart 1.28.0, ChartBridge 0.6.1, SPEC CE-1) in the workspace
// against the fake bridge (--agents=demo,demotwo,demothree --board-groups: Group A on SIM-A and SIM-B, Funded, default hero
// sample-build-3; Group B on SIM-C and SIM-D (a made-up LIVE account), Evals, default hero sample-build-1) and the fake PC helper (test/fake-helper.mjs) on 8767 with tiers on its build rows. Every agent,
// hero, build, account and number is made up: sample data only, and the page says so where it shows (the hero names say
// "Sample Hero").
//   - the group's default hero preselected in his build picker, every hero listed with its tier fit for the group's Type;
//   - the board: a group hero row, a single account row, a NO HERO row; columns hero, tier, group and accounts, mode, position,
//     today R, room left, Kill; R3 (nothing moves);
//   - Assign hero with no free slot: "add an agent id to config.txt", nothing sent; with one: agentAccount {group} (the LIVE
//     member asked once in the page; the slot asked again at Continue), then the helper's POST /on with the group's default hero,
//     in Shadow; a seated slot that is Off says so, with Start in Shadow and No hero on duty;
//   - KILL ALL AGENTS: agentKill on to every agent, in one click.
//   npm run smoke:agent-board   (CHROMIUM_PATH=/path/to/chrome; AGENT_BOARD_PORT, else the first free port from 9011; SHOTS=dir)
// Screenshots: agent-board, agent-board-assign-ask, agent-board-assigned, agent-board-off, agent-board-killed, agent-board-picker (.png in test/out).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';
import { startFakeHelper } from './fake-helper.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 10000) {
  const t0 = Date.now();
  for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() - t0 > ms) { fail('timed out: ' + what); return null; } await sleep(150); }
}
const free = p => new Promise(res => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(p, '127.0.0.1', () => s.close(() => res(true))); });
let port = +(process.env.AGENT_BOARD_PORT || 0) || 9011;
while (!(await free(port))) port++;
const control = async (what, q) => (await fetch(`http://127.0.0.1:${port}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
/* the helper's build rows: tiers on two, none on the third (the Bot-Lab side that fills them comes later) */
const BUILDS = [
  { build: 'sample-build-1', stamp: 'aaaaaaaaaaaa', hero: 'Sample Hero A', here: true, shadowOk: true, trades: 40, meanR: 0.2, tier: 'Good', edge: 0.1, examEdge: 0.12, liveEdge: 0.09, liveN: 30 },
  { build: 'sample-build-2', stamp: 'bbbbbbbbbbbb', hero: 'Sample Hero B', here: true, shadowOk: true, trades: 25, meanR: 0.1, tier: 'Acceptable', edge: 0.05 },
  { build: 'sample-build-3', stamp: 'cccccccccccc', hero: 'Sample Hero C', here: true, shadowOk: true, trades: 12, meanR: 0.05 },
];

const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(port), '--v3', '--trading', '--test-controls', '--test-pin=' + TEST_PIN,
  '--agents=demo,demotwo,demothree', '--agent-any-time', '--board-groups', '--agent-accounts=demotwo:Sim101'], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });
let helper = null;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  helper = await startFakeHelper({ bridgePort: port, agents: ['demo', 'demotwo', 'demothree'], builds: BUILDS });
  /* demo leads Group A with Sample Hero B, demotwo trades Sim101 with Sample Hero A (both on in the helper); demothree is on None and Off */
  await control('agent-connect', { agent: 'demo', name: 'Sample Hero B', build: 'sample-build-2 bbbbbbbbbbbb' });
  await control('agent-connect', { agent: 'demotwo', name: 'Sample Hero A', build: 'sample-build-1 aaaaaaaaaaaa' });
  Object.assign(helper.status.demo, { on: true, running: true, why: 'on', build: 'sample-build-2', runningBuild: 'sample-build-2', hero: 'Sample Hero B' });
  Object.assign(helper.status.demotwo, { on: true, running: true, why: 'on', build: 'sample-build-1', runningBuild: 'sample-build-1', hero: 'Sample Hero A' });
  await control('agent-group', { agent: 'demo', name: 'Group A', members: 'SIM-A,SIM-B', sizes: '3,2' });

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  for (const api of ['chart-hotkeys', 'chart-strategies', 'chart-accounts'])
    await ctx.route('http://localhost:8800/api/' + api, r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(api === 'chart-accounts' ? { accounts: [] } : api === 'chart-strategies' ? { rev: 0, strategies: [] } : { rev: 1, keys: {}, modifiers: {} }) }));
  await ctx.addInitScript(() => {
    const Real = window.WebSocket, socks = window.__socks = [];
    function Spy(url, p) { const s = p === undefined ? new Real(url) : new Real(url, p); const rec = { msgs: [] }; const send = s.send.bind(s); s.send = d => { try { const m = JSON.parse(d); if (/^agent/.test(m.type)) rec.msgs.push(m); } catch (e) { /* not JSON */ } return send(d); }; socks.push(rec); return s; }
    Spy.prototype = Real.prototype; for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Spy[k] = Real[k];
    window.WebSocket = Spy;
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  page.on('dialog', d => { fail('a browser dialog: ' + d.message()); d.dismiss(); });
  await page.goto(`http://localhost:${port}/live/?layout=Main&tab=agent`);
  await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
  await enterPin(page, TEST_PIN);
  await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
  await page.waitForFunction(() => window.workspace.agent().agents.length === 3, null, { timeout: 15000 });
  const sent = () => page.evaluate(() => window.__socks.flatMap(s => s.msgs));

  /* ---------------- piece 3: a group's default hero preselected, every hero listed with its tier fit */
  console.log('piece 3: the default hero of the group he trades is preselected');
  await control('agent-connect', { agent: 'demothree', name: 'Sample Hero C', build: 'sample-build-3 cccccccccccc' });
  await control('agent-group', { agent: 'demothree', name: 'Group B', members: 'SIM-C,SIM-D', sizes: '1,1' });   // a sample view: demothree on Group B (Evals)
  await page.selectOption('#agView [data-k="pick"]', 'demothree');
  const pick = await until(async () => { const r = await page.evaluate(() => { const s = document.querySelector('#agView [data-k="hPick"]'); return s && s.options.length > 1 ? { v: s.value, opts: [...s.options].map(o => o.textContent), note: document.querySelector('#agView [data-k="hNote"]').textContent } : null; }); return r; }, 'the build picker filled');
  check(pick && pick.v === 'sample-build-1', 'Group B\'s default hero (sample-build-1) preselected: ' + JSON.stringify(pick));
  check(pick && pick.opts.length === 3 && pick.opts.includes('Sample Hero C (sample-build-3), tier unknown') && pick.opts.includes('Sample Hero B (sample-build-2)'),
    'every hero listed for Group B (Evals): Acceptable fits evals, a hero with no rating says tier unknown: ' + JSON.stringify(pick && pick.opts));
  await page.selectOption('#agView [data-k="hPick"]', 'sample-build-3');
  check(await page.$eval('#agView [data-k="hPick"]', s => s.value) === 'sample-build-3' && await page.$eval('#agView [data-k="hNote"]', e => e.textContent) === 'tier unknown', 'he can pick another; its warning in the card\'s head');
  await page.screenshot({ path: path.join(SHOTS, 'agent-board-picker.png'), clip: { x: 0, y: 0, width: 520, height: 520 } });
  await control('agent-group', { agent: 'demothree', on: '0' });
  await control('agent-connect', { agent: 'demothree', on: '0' });
  await until(async () => !(await page.evaluate(() => window.workspace.agent().agents.find(a => a.agent === 'demothree').connected)), 'demothree back on None, not connected');

  /* ---------------- piece 2: the board */
  console.log('piece 2: the heroes-on-duty board');
  await page.click('#agView [data-act="board"]');
  await until(() => page.isVisible('#agView [data-k="board"]'), 'the board shown');
  check(!(await page.isVisible('#agView [data-k="main"]')), 'the board in place of the desk');
  const rows = await until(async () => { const r = await page.$$eval('#agView [data-brow]', els => els.map(e => ({ kind: e.dataset.brow, agent: e.dataset.agent || '', gid: e.dataset.gid || '', text: e.innerText.replace(/\s+/g, ' ').trim() })));
    return r.length === 3 && r.some(x => /Good/.test(x.text)) && r.some(x => /Acceptable/.test(x.text)) ? r : null; }, 'three rows with the tiers from the helper');
  const [rg, rs, rn] = [rows.find(r => r.agent === 'demo'), rows.find(r => r.agent === 'demotwo'), rows.find(r => r.kind === 'none')];
  check(rg && /SAMPLE HERO B/i.test(rg.text) && /Acceptable \+0\.05R/i.test(rg.text) && /Acceptable: evals only; funded only when no Good or better hero is on duty/.test(rg.text) && /Group A/.test(rg.text) && /leads 2 accounts: SIM-A, SIM-B · Funded/.test(rg.text) && /daily room/.test(rg.text),
    'a group hero row: name and build, tier and its fit for Funded, the group and the accounts it leads, the room of the tightest seat: ' + (rg && rg.text));
  check(rs && /SAMPLE HERO A/i.test(rs.text) && /Good \+0\.10R/i.test(rs.text) && /Sim101/.test(rs.text) && /one account/.test(rs.text) && /Shadow/i.test(rs.text) && /FLAT/.test(rs.text),
    'a single account row: Sim101, Good, Shadow, flat: ' + (rs && rs.text));
  check(rn && rn.gid === 'g2' && /No hero/i.test(rn.text) && /Group B/.test(rn.text) && /2 accounts: SIM-C, SIM-D · Evals/.test(rn.text) && /Default hero: Sample Hero A \(sample-build-1\)/.test(rn.text) && /Assign hero/i.test(rn.text),
    'a NO HERO row for Group B with its accounts, its Type, its default hero and Assign hero: ' + (rn && rn.text));
  const moving = await page.evaluate(() => [...document.querySelectorAll('#agView [data-k="board"], #agView [data-k="board"] *')].filter(e => { const s = getComputedStyle(e); return s.animationName !== 'none' || s.transitionDuration.split(',').some(d => parseFloat(d) > 0); }).map(e => e.className));
  check(moving.length === 0, 'R3: nothing on the board moves or has a transition: ' + JSON.stringify(moving));
  const wide = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  check(wide, 'no sideways scroll at 1440 px');
  await page.screenshot({ path: path.join(SHOTS, 'agent-board.png') });

  /* Assign hero with no free slot: the words, nothing sent */
  helper.status.demothree.on = true;
  await sleep(3500);   // the next poll of the helper
  const before = (await sent()).length;
  await page.click('#agView [data-act="bAssign"][data-gid="g2"]');
  const noSlot = await until(async () => { const t = await page.textContent('#agView [data-k="bLine"]'); return /config\.txt/.test(t) ? t : null; }, 'the no free slot words');
  check(noSlot === 'No free agent (an agent id on None and Off): add an agent id to config.txt (agents = ...); ChartBridge never writes config.txt.' && (await sent()).length === before, 'no free slot: "add an agent id to config.txt", nothing sent');
  helper.status.demothree.on = false;
  await sleep(3500);

  /* Assign hero with a free slot: agentAccount {group}, the LIVE member asked once in the page, then POST /on in Shadow */
  const onsBefore = helper.calls.filter(c => c.route === 'POST /on').length;
  await page.click('#agView [data-act="bAssign"][data-gid="g2"]');
  let ask = await until(() => page.$('#agView [data-brow="none"] .ag-ask'), 'the LIVE question for SIM-D');
  let askText = ask ? await ask.innerText() : '';
  check(/Agent demothree will trade group Group B \(SIM-C, SIM-D\), with LIVE account SIM-D, in Shadow/.test(askText) && !(await sent()).some(m => m.type === 'agentAccount' && m.agent === 'demothree'), 'a LIVE member: asked once in the page, nothing sent yet: ' + askText.replace(/\s+/g, ' '));
  await page.screenshot({ path: path.join(SHOTS, 'agent-board-assign-ask.png') });
  /* fix round 1: the slot is asked again at Continue: turned On meanwhile, nothing is sent */
  helper.status.demothree.on = true;
  await sleep(3500);
  await page.click('#agView [data-act="bYes"]');
  const stale = await until(async () => { const t = await page.textContent('#agView [data-k="bLine"]'); return /^Nothing was sent: agent demothree is On in the helper now/.test(t) ? t : null; }, 'the recheck at Continue');
  check(stale && !(await sent()).some(m => m.type === 'agentAccount' && m.agent === 'demothree'), 'Continue asks the free slot again: On meanwhile, nothing sent: ' + stale);
  helper.status.demothree.on = false;
  await sleep(3500);
  await page.click('#agView [data-act="bAssign"][data-gid="g2"]');
  ask = await until(() => page.$('#agView [data-brow="none"] .ag-ask'), 'the LIVE question again');
  await page.click('#agView [data-act="bYes"]');
  const acc = await until(async () => (await sent()).find(m => m.type === 'agentAccount' && m.agent === 'demothree'), 'agentAccount sent');
  check(acc && acc.group === 'g2' && acc.keepMode === 'shadow' && acc.account === undefined, 'agentAccount {agent, group, keepMode shadow}: ' + JSON.stringify(acc));
  const on = await until(() => helper.calls.slice(onsBefore).find(c => c.route === 'POST /on'), 'the helper\'s POST /on');
  check(on && on.body.agent === 'demothree' && on.body.build === 'sample-build-1' && on.body.mode === 'shadow', 'then POST /on with Group B\'s default hero, in Shadow: ' + JSON.stringify(on && on.body));
  await until(async () => /is on Group B with sample-build-1, in Shadow/.test(await page.textContent('#agView [data-k="bLine"]')), 'the board says so');
  await until(async () => (await page.$$('#agView [data-brow="hero"]')).length === 3 && !(await page.$('#agView [data-brow="none"]')), 'demothree now a hero row; no NO HERO row left');
  await sleep(500);
  await page.screenshot({ path: path.join(SHOTS, 'agent-board-assigned.png') });

  /* fix round 1: seated on Group B but Off (as when the helper refuses On or the wait runs out): the row says so, Start in Shadow */
  Object.assign(helper.status.demothree, { on: false, running: false, runningBuild: null, build: 'sample-build-1' });
  await control('agent-connect', { agent: 'demothree', on: '0' });
  const offRow = await until(async () => { const t = await page.$eval('#agView [data-brow="hero"][data-agent="demothree"]', e => e.innerText.replace(/\s+/g, ' ')).catch(() => ''); return /Off: not started \(nothing trades\)/.test(t) ? t : null; }, 'the Off warning on his row', 15000);
  check(offRow && /No hero on duty/i.test(offRow) && /Start in Shadow/i.test(offRow) && /set None on his desk to free the slot/.test(offRow), 'a seated slot that is Off: the warning, No hero on duty, Start in Shadow and the hint: ' + offRow);
  await page.screenshot({ path: path.join(SHOTS, 'agent-board-off.png') });
  const ons1 = helper.calls.filter(c => c.route === 'POST /on').length;
  await page.click('#agView [data-act="bStart"][data-agent="demothree"]');
  const on2 = await until(() => helper.calls.slice(ons1).find(c => c.route === 'POST /on'), 'Start in Shadow\'s POST /on');
  check(on2 && on2.body.agent === 'demothree' && on2.body.build === 'sample-build-1' && on2.body.mode === 'shadow', 'Start in Shadow: the helper\'s POST /on with his build, in Shadow: ' + JSON.stringify(on2 && on2.body));
  await until(async () => !(await page.$('#agView [data-brow="hero"][data-agent="demothree"] .ag-boff')), 'the warning gone once he is on');

  /* KILL ALL AGENTS: agentKill on to every agent, one click */
  const k0 = (await sent()).filter(m => m.type === 'agentKill').length;
  await page.click('#agView [data-act="killAll"]');
  const kills = await until(async () => { const k = (await sent()).filter(m => m.type === 'agentKill').slice(k0); return k.length >= 3 ? k : null; }, 'three agentKill');
  check(kills && kills.length === 3 && kills.every(m => m.on === true) && kills.map(m => m.agent).sort().join() === 'demo,demothree,demotwo', 'one click: agentKill on to every agent: ' + JSON.stringify(kills));
  await until(async () => (await page.evaluate(() => window.workspace.agent().agents.every(a => a.killed))), 'every agent killed');
  await until(async () => /All agents killed/i.test(await page.textContent('#agView [data-act="killAll"]')), 'the button says so');
  check((await page.$$eval('#agView [data-act="bKill"]', b => b.map(x => x.disabled && /Killed/i.test(x.textContent)))).every(Boolean), 'each row\'s Kill says Killed');
  await page.screenshot({ path: path.join(SHOTS, 'agent-board-killed.png') });
  /* Open goes to his desk; the board is kept in this browser */
  await page.click('#agView [data-act="bOpen"][data-agent="demo"]');
  await until(() => page.isVisible('#agView [data-k="main"]'), 'his desk');
  check(await page.evaluate(() => window.workspace.agent().chosen) === 'demo', 'Open shows that agent\'s desk');
  await page.close();
} catch (e) {
  fail('smoke stopped: ' + (e && e.stack || e));
} finally {
  if (helper) await helper.close();
  bridge.kill();
  await browser.close();
}
console.log(errors.length ? '\n' + errors.length + ' of ' + checks + ' checks failed' : '\nall ' + checks + ' checks passed');
process.exit(errors.length ? 1 : 0);
