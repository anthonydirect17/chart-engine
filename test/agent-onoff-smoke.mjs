// On/Off, the spend readout, the hero picker and the names on the Agent tab (chart 1.20.0, live/agent-helper.js; DECISION
// 2026-10-09 v and w) in the workspace against the fake bridge (--agents=demo) and the fake PC helper (test/fake-helper.mjs,
// on localhost:8767 as the real one). The agent, the builds, the hero names, the account SIM-AG1 and every dollar are made up:
// sample data only.
//   - the picker: in Shadow on a Sim account heroes and the builds over the bar; heroes only in Copilot;
//   - On: the helper starts him with the build picked (here the fake connects the agent with that build's name); the header
//     shows the hero's name, the build id and stamp only in the Build row; a build that is not a hero keeps Copilot and Auto
//     closed;
//   - Off when flat: sent at once; the spend readout (this session, overall);
//   - Off in a trade: asks "Flatten and turn him off?"; "Keep him on" sends nothing; "Flatten and turn off" sends the page's
//     own `flatten` for his account and root (once, exactly the chart's Flatten message), and Off only once ChartBridge says
//     he is flat;
//   - every helper call carries the PIN unlock; a PC with no helper says so and offers no On.
//   npm run smoke:onoff      (CHROMIUM_PATH=/path/to/chrome; ONOFF_SMOKE_PORT; SHOTS=dir)
// Screenshots: agent-onoff-off, agent-onoff-on, agent-onoff-ask (.png in test/out).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';
import { startFakeHelper } from './fake-helper.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = +(process.env.ONOFF_SMOKE_PORT || 8981);
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const agentNow = async () => (await control('agents')).agents.find(a => a.agent === 'demo');
async function until(fn, what, ms = 10000) {
  const t0 = Date.now();
  for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() - t0 > ms) { fail('timed out: ' + what); return null; } await sleep(150); }
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let bridge = null, helper = null;
try {
  bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--test-controls', '--test-pin=' + TEST_PIN, '--agents=demo', '--agent-any-time', '--max-qty=MNQ:20,NQ:2'], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });
  helper = await startFakeHelper({ bridgePort: PORT });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  for (const r of ['chart-hotkeys', 'chart-strategies', 'chart-accounts']) {
    await ctx.route('http://localhost:8800/api/' + r, x => x.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(r === 'chart-accounts' ? { accounts: [] } : r === 'chart-strategies' ? { rev: 0, strategies: [] } : { rev: 1, keys: {}, modifiers: {} }) }));
  }
  /* every message a page sends on each WebSocket, and every request to the helper with its headers */
  await ctx.addInitScript(() => {
    const Real = window.WebSocket, socks = window.__socks = [];
    function Spy(url, p) { const s = p === undefined ? new Real(url) : new Real(url, p); const rec = { url: String(url), msgs: [] }; const send = s.send.bind(s); s.send = d => { try { rec.msgs.push(JSON.parse(d)); } catch (e) { /* not JSON */ } return send(d); }; socks.push(rec); return s; }
    Spy.prototype = Real.prototype; for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Spy[k] = Real[k];
    window.WebSocket = Spy;
  });
  const helperAsks = [];
  ctx.on('request', r => { if (r.url().startsWith('http://localhost:8767/') && r.method() !== 'OPTIONS') helperAsks.push({ url: r.url(), unlock: r.headers()['x-chartbridge-unlock'] || '' }); });
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  page.on('dialog', d => { fail('a browser dialog: ' + d.message()); d.dismiss(); });
  await page.goto(`http://localhost:${PORT}/live/?layout=Main`);
  await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
  await enterPin(page, TEST_PIN);
  await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
  const text = sel => page.evaluate(s => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);
  const visible = sel => page.evaluate(s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest('[hidden]'); }, sel);
  const options = () => page.evaluate(() => [...document.querySelectorAll('#agView [data-k="hPick"] option')].map(o => o.value));
  const sentAll = () => page.evaluate(() => window.__socks.flatMap(s => s.msgs));
  const disabled = sel => page.evaluate(s => document.querySelector(s).disabled, sel);
  await control('price', { root: 'MNQ', p: 25400 });

  console.log('the tab, off: the picker, the spend, On offered');
  await until(async () => (await page.evaluate(() => window.workspace.agent().agents.length)) === 1, 'ChartBridge told of demo');
  await page.click('#wsAgentTab');
  await until(async () => (await page.evaluate(() => window.workspace.agent().shown)), 'the tab opens');
  /* his own account first (Sim101 is the bot's: as built, an agent there stands down) */
  await page.click('#agView [data-act="acctOpen"]');
  await page.selectOption('#agView [data-k="acctSel"]', 'SIM-AG1');
  await page.click('#agView [data-act="acctSave"]');
  await until(async () => (await text('.ag-strip [data-k="sAccount"]')) === 'SIM-AG1', 'demo trades SIM-AG1');
  await until(async () => (await options()).length === 3, 'the picker fills from the helper');
  check(JSON.stringify(await options()) === JSON.stringify(['sample-build-1', 'sample-build-3', 'sample-build-2']), 'Shadow on Sim: the heroes, then the build over the bar; not the one under it: ' + (await options()).join(', '));
  check((await text('#agView [data-k="hNote"]')) === 'No Shadow bar set: every build is listed in Shadow.', 'the note says no bar is set yet');
  check((await text('#agView [data-k="hSess"]')) === '$1.84' && (await text('#agView [data-k="hAll"]')) === '$1,234.50', 'the spend next to On/Off: session ' + await text('#agView [data-k="hSess"]') + ', overall ' + await text('#agView [data-k="hAll"]'));
  check((await text('#agView [data-k="hWhy"]')) === 'Off: no model calls, no spend.', 'off says what off means');
  check(!(await disabled('#agView [data-onoff="on"]')) && await disabled('#agView [data-onoff="off"]'), 'On offered, Off not (he is off)');
  check(helperAsks.length > 0 && helperAsks.every(x => /^v1\.[0-9a-f]{32}\.[0-9a-f]{64}$/.test(x.unlock)), 'every helper call carries the PIN page\'s unlock (' + helperAsks.length + ' calls)');
  await page.screenshot({ path: path.join(SHOTS, 'agent-onoff-off.png'), clip: { x: 0, y: 0, width: 760, height: 900 } });

  console.log('On with a build that is not a hero: Shadow on Sim only');
  await page.selectOption('#agView [data-k="hPick"]', 'sample-build-2');
  await page.click('#agView [data-onoff="on"]');
  await until(async () => (await agentNow()).connected, 'the helper started him (the fake connects demo)');
  await until(async () => (await text('.ag-strip [data-k="name"]')) === 'sample-build-2', 'the header shows the build id (no hero name)');
  const onCall = helper.calls.find(c => c.route === 'POST /on');
  check(onCall && onCall.body.agent === 'demo' && onCall.body.build === 'sample-build-2', 'POST /on {agent, build}: ' + JSON.stringify(onCall && onCall.body));
  await until(async () => await disabled('#agView [data-mode="copilot"]'), 'Copilot closes for a build that is not a hero');
  check(await disabled('#agView [data-mode="auto"]') && /is not a hero: Shadow on a Sim account only/.test(await page.getAttribute('#agView [data-mode="copilot"]', 'title')), 'Copilot and Auto closed, with why: ' + await page.getAttribute('#agView [data-mode="copilot"]', 'title'));
  check(await disabled('#agView [data-k="hPick"]'), 'the picker is closed while he runs (Off first)');
  console.log('Off when flat: at once');
  await page.click('#agView [data-onoff="off"]');
  await until(async () => !(await agentNow()).connected, 'Off: the helper ended him');
  check(!(await visible('#agView [data-k="hAsk"]')) && helper.calls.filter(c => c.route === 'POST /off').length === 1, 'flat: no question, one POST /off');

  console.log('On with a hero: his name in the header, the build and stamp in the details');
  await until(async () => !(await disabled('#agView [data-k="hPick"]')), 'the picker opens again');
  await page.selectOption('#agView [data-k="hPick"]', 'sample-build-3');
  await page.click('#agView [data-onoff="on"]');
  await until(async () => (await text('.ag-strip [data-k="name"]')) === 'Demo 2', 'the header says Demo 2');
  const strip = await text('.ag-strip');
  check(!/sample-build-3|cccccccccccc/.test(strip), 'no build id or stamp in the header: "' + strip + '"');
  check((await text('#agView [data-k="buildRow"]')) === 'sample-build-3 cccccccccccc', 'the Build row: ' + await text('#agView [data-k="buildRow"]'));
  await until(async () => !(await disabled('#agView [data-mode="copilot"]')), 'a hero may go to Copilot');
  await page.screenshot({ path: path.join(SHOTS, 'agent-onoff-on.png'), clip: { x: 0, y: 0, width: 760, height: 900 } });

  console.log('Copilot: heroes only in the picker; a trade; Off asks');
  await page.click('#agView [data-mode="copilot"]');
  await until(async () => (await agentNow()).mode === 'copilot', 'Copilot');
  await until(async () => JSON.stringify(await options()) === JSON.stringify(['sample-build-1', 'sample-build-3']), 'heroes only in Copilot');
  check((await text('#agView [data-k="hNote"]')) === 'Heroes only in Copilot.', 'the note says why');
  await control('agent-plan', { agent: 'demo', id: 'oo1', side: 'buy', kind: 'limit', p: 25390, qty: 1, stop: 12, target: 24, expire: 900 });
  await until(() => page.isVisible('.ag-plist .ag-prop[data-id="oo1"]'), 'the proposal');
  await page.click('.ag-plist .ag-prop[data-id="oo1"] [data-agans="accept"]');
  await until(async () => (await page.evaluate(() => window.workspace.agent().orders)).some(o => o.by === 'agent:demo' && o.role === 'entry'), 'his entry works');
  await control('price', { root: 'MNQ', p: 25389.75 });
  await until(async () => /Long 1 MNQ/.test(await text('.ag-strip [data-k="sPos"]')), 'demo is long 1 MNQ');
  const flattensBefore = (await sentAll()).filter(m => m.type === 'flatten').length;
  await page.click('#agView [data-onoff="off"]');
  await until(() => visible('#agView [data-k="hAsk"]'), 'Off in a trade asks');
  check((await text('#agView [data-k="hAskText"]')) === 'Demo 2 holds long 1 MNQ on SIM-AG1. Flatten and turn him off?', 'the question: ' + await text('#agView [data-k="hAskText"]'));
  check(helper.calls.filter(c => c.route === 'POST /off').length === 1 && (await sentAll()).filter(m => m.type === 'flatten').length === flattensBefore, 'asking sends nothing');
  await page.screenshot({ path: path.join(SHOTS, 'agent-onoff-ask.png'), clip: { x: 0, y: 0, width: 760, height: 900 } });
  await page.click('#agView [data-act="hAskNo"]');
  await sleep(600);
  check(!(await visible('#agView [data-k="hAsk"]')) && (await agentNow()).connected && helper.calls.filter(c => c.route === 'POST /off').length === 1 && (await sentAll()).filter(m => m.type === 'flatten').length === flattensBefore,
    '"Keep him on": nothing sent, he stays on and in his trade');
  console.log('Flatten and turn off');
  await page.click('#agView [data-onoff="off"]');
  await until(() => visible('#agView [data-k="hAsk"]'), 'asked again');
  await page.click('#agView [data-act="hFlatOff"]');
  await until(async () => (await sentAll()).filter(m => m.type === 'flatten').length === flattensBefore + 1, 'the page\'s own Flatten is sent');
  const fl = (await sentAll()).filter(m => m.type === 'flatten').pop();
  check(fl.account === 'SIM-AG1' && fl.root === 'MNQ' && Object.keys(fl).sort().join(',') === 'account,root,type', 'the chart\'s own Flatten message {type, account SIM-AG1, root MNQ}: ' + JSON.stringify(fl));
  const offAt = await until(() => helper.calls.filter(c => c.route === 'POST /off').length === 2 && helper.calls.filter(c => c.route === 'POST /off')[1].at, 'Off once he is flat');
  check(/Flat/.test(await text('.ag-strip [data-k="sPos"]')) && !(await agentNow()).position, 'he is flat');
  await until(async () => !(await agentNow()).connected, 'the helper ended him');
  check((await sentAll()).filter(m => m.type === 'flatten').length === flattensBefore + 1, 'one flatten only');
  check(offAt > 0, 'Off went after the flatten filled');
  check(!(await sentAll()).some(m => m.type === 'order' && m.account === 'SIM-AG1'), 'the page built no order for him');

  console.log('settings: auto-On and the daily cap');
  await page.click('#agView .ag-hset summary');
  await page.fill('#agView [data-k="hAuto"]', '9:30');
  await page.click('#agView [data-act="hSave"]');
  check(/Auto-On is HH:MM/.test(await text('#agView [data-k="hSetWhy"]')), 'checked before sending: ' + await text('#agView [data-k="hSetWhy"]'));
  await page.fill('#agView [data-k="hAuto"]', '09:30');
  await page.fill('#agView [data-k="hCap"]', '5');
  await page.click('#agView [data-act="hSave"]');
  await until(async () => /^Set\./.test(await text('#agView [data-k="hSetWhy"]')), 'set');
  const st = helper.calls.filter(c => c.route === 'POST /settings').pop();
  check(st && st.body.autoOn === '09:30' && st.body.cap === 5, 'POST /settings: ' + JSON.stringify(st && st.body));

  console.log('a PC with no helper');
  helper.setDown(true);
  await until(async () => /PC helper is not running on this PC/.test(await text('#agView [data-k="hWhy"]')), 'the line says the helper is not running', 15000);
  check(await disabled('#agView [data-onoff="on"]') && await disabled('#agView [data-onoff="off"]'), 'no On or Off without the helper');
  await page.close();
} catch (e) {
  fail('smoke stopped: ' + (e && e.stack || e));
} finally {
  if (helper) await helper.close();
  if (bridge) bridge.kill();
  await browser.close();
}
console.log(errors.length ? '\n' + errors.length + ' of ' + checks + ' checks failed' : '\nall ' + checks + ' checks passed');
process.exit(errors.length ? 1 : 0);
