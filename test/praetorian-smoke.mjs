// Praetorian (chart 1.48.0; Anthony 2026-11-11: the Agent and Bot tabs as one tab, "focused on the personal (not prop
// business) accounts") in a browser: the real Agent desk (live/agent.js) and Bot desk (live/bot.js), each handed the very
// connection the page and both pop-out windows build for them (AgentCore.praetorianLink) over a
// stand-in for the window's feed. Made-up messages only: MINE-1 is the personal account, PROP-1 a prop account, SIM-A Sim.
//   npm run smoke:praetorian      (CHROMIUM_PATH=/path/to/chrome; SHOTS=dir)
// Checks: a trader on a prop account shows why it is held back, its mode, account and rules controls are off and its kill
// switch ON is not; a deliberate break (the disabled attribute taken off by hand, then Auto clicked twice) still sends nothing
// and the desk says Praetorian's reason; Kill switch ON goes; its release is held back; moved to the personal account it is
// whole again and Auto goes; the picker offers your personal account and Sim, lists a prop account and a group as not on
// Praetorian; the Bot desk the same. Screenshots: praetorian-agent-prop.png, praetorian-agent-mine.png, praetorian-bot-prop.png.
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
const errors = [];
let checks = 0;
const check = (ok, m) => { checks++; if (!ok) { errors.push(m); console.error('  FAIL ' + m); } else console.log('  ok   ' + m); };

const css = ['workspace.css', 'bot.css', 'agent.css'].map(f => `<link rel="stylesheet" href="${pathToFileURL(path.join(root, 'live', f))}">`).join('');
const js = ['bot-core.js', 'agent-core.js', 'fleet.js', 'motion.js', 'agent-helper.js', 'agent-grid.js', 'bot.js', 'agent.js'].map(f => `<script src="${pathToFileURL(path.join(root, 'live', f))}"></script>`).join('\n');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">${css}
<style>html,body{height:100%;margin:0}body{display:flex;flex-direction:column}</style></head>
<body><div class="ws-top"><span>SAMPLE DATA: made-up accounts and traders</span>
<button type="button" class="ws-btn ag-tabbtn" id="wsAgentTab" aria-pressed="false" hidden>Agent</button>
<button type="button" class="ws-btn bt-tabbtn" id="wsBotTab" aria-pressed="false" hidden>Bot</button></div>
<section class="bt-view bt-in-ws" id="btView" aria-label="Bot tab"></section>
<section class="ag-view ag-in-ws" id="agView" aria-label="Agent tab"></section>
${js}
<script>
  window.posted = []; window.subs = [];
  /* a stand-in PC helper (made up, as test/fake-helper.mjs answers): GET /status, POST /on, /off, /settings, each call kept */
  window.helperCalls = []; window.flattened = [];
  window.helperState = { demo: { on: false, running: false, why: 'off', build: 'sample-build-1', runningBuild: null, hero: null, since: null, autoOn: '', cap: null, lastExit: null, spend: { session: 0, overall: 0, date: '2026-11-12' } } };
  const realFetch = window.fetch;
  window.fetch = (u, o) => {
    const url = String(u), at = url.indexOf(':8767/'), m = at > 0 && (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) ? [null, null, '/' + url.slice(at + 6).split(/[?#]/)[0]] : null;
    if (!m) return realFetch(u, o);
    const route = ((o && o.method) || 'GET') + ' ' + m[2];
    window.helperCalls.push(route);
    const body = route === 'GET /status' ? { v: 1, agents: window.helperState, builds: [{ build: 'sample-build-1', stamp: 'aaaaaaaaaaaa', hero: 'Demo', here: true, shadowOk: true, trades: 40, meanR: 0.2, dollars: 900, frozenAt: '2026-10-05' }],
      buildsNote: null, bar: { min_trades: null, min_mean_r: null }, barSet: false, session: '2026-11-12' } : { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  const AF = { listen: h => { window.subs.push(h); return () => {}; }, post: m => { window.posted.push(m); return true; }, send: m => { window.posted.push(['send', m]); return true; }, sendOrder: m => { window.posted.push(['order', m]); return true; }, limit: () => null };
  window.link = window.AgentCore.praetorianLink(AF);   // the one builder the page and both pop-out windows use (the review of 102, F1)
  window.feed = m => { for (const h of window.subs) h.message(m); };
  const mem = new Map(), storage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
  window.agentDesk = window.AgentDesk.create({ v3: window.link, storage, flatten: (account, root) => { window.flattened.push(account + ' ' + root); return true; }, els: { tab: document.getElementById('wsAgentTab'), view: document.getElementById('agView') },
    onTab: on => document.body.classList.toggle('ag-on', on) });
  window.botDesk = window.BotDesk.create({ v3: window.link, storage, els: { tab: document.getElementById('wsBotTab'), view: document.getElementById('btView') },
    onTab: on => document.body.classList.toggle('bt-on', on) });
</script></body></html>`;
const file = path.join(SHOTS, 'praetorian-smoke.html');
fs.writeFileSync(file, html);

const accounts = { type: 'accounts', personalNamed: true, list: [
  { name: 'MINE-1', connection: 'connected', personal: true, prop: false, sim: false, tradable: true, state: 'ok', pnlToday: 0, positions: [] },
  { name: 'PROP-1', connection: 'connected', prop: true, sim: false, tradable: true, state: 'ok', pnlToday: 0, positions: [] },
  { name: 'SIM-A', connection: 'connected', sim: true, tradable: true, state: 'ok', pnlToday: 0, positions: [] }] };
const agent = more => Object.assign({ type: 'agent', agent: 'demo', name: 'Demo Agent', build: 'sample-build-1', enabled: true, connected: true, mode: 'shadow', account: 'PROP-1', sim: false,
  killed: false, standDown: null, owns: false, lastBeatMs: 300, rules: { maxTrades: 2, maxLosses: 1, entryFrom: '09:40', entryUntil: '15:00', flatAt: '15:55' } }, more || {});
const bot = more => Object.assign({ type: 'bot', enabled: true, connected: true, name: 'Sample bot', mode: 'shadow', account: 'PROP-1', sim: false, killed: false, maxTrades: 2, maxLosses: 1, root: 'MNQ' }, more || {});

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('dialog', d => { pageErrors.push('a browser dialog: ' + d.message()); d.dismiss(); });
  await page.goto(pathToFileURL(file).href);
  const feed = m => page.evaluate(x => window.feed(x), m);
  const posted = () => page.evaluate(() => window.posted.map(m => Array.isArray(m) ? m[0] : m.type + (m.agent ? ':' + m.agent : '') + (m.mode ? ':' + m.mode : '') + (m.on !== undefined ? ':' + m.on : '')));
  const clear = () => page.evaluate(() => { window.posted.length = 0; });
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  await feed({ type: 'hello', version: '0.6.21', features: ['v3'], instruments: [{ root: 'MNQ', tick: 0.25, pointValue: 2 }] });
  await feed({ type: 'trading', enabled: true, switches: { bot: true, agents: true } });
  await feed(accounts);
  await feed(agent());
  await page.evaluate(() => window.agentDesk.showTab(true));
  await page.waitForSelector('#agView [data-k="prWhy"]:not([hidden])', { timeout: 5000 }).catch(() => {});

  /* a trader on a prop account */
  const prWhy = await page.locator('#agView [data-k="prWhy"]').innerText().catch(() => '');
  check(/can only be stopped/.test(prWhy) && /PROP-1 is a prop account: it is set up from Legion's trader desk/.test(prWhy), 'a prop trader: the desk says why it is held back: ' + prWhy);
  const dis = await page.evaluate(() => ({ modes: [...document.querySelectorAll('#agView [data-k="modes"] button')].map(b => b.disabled), acct: document.querySelector('#agView [data-k="acctOpen"]').disabled, rules: document.querySelector('#agView [data-k="rulesOpen"]').disabled, kill: document.querySelector('#agView [data-k="kill"]').disabled }));
  check(dis.modes.length === 3 && dis.modes.every(Boolean) && dis.acct && dis.rules && !dis.kill, 'a prop trader: Shadow, Copilot, Auto, Change account and Change the rules off; the Kill switch on: ' + JSON.stringify(dis));
  await page.screenshot({ path: path.join(SHOTS, 'praetorian-agent-prop.png') });

  /* the deliberate break: the disabled attribute taken off by hand, Auto clicked twice (its confirm): nothing reaches the feed */
  await clear();
  await page.evaluate(() => { for (const b of document.querySelectorAll('#agView [data-k="modes"] button')) b.disabled = false; document.querySelector('#agView [data-mode="auto"]').click(); });
  await sleep(500);
  await page.evaluate(() => { for (const b of document.querySelectorAll('#agView [data-k="modes"] button')) b.disabled = false; document.querySelector('#agView [data-mode="auto"]').click(); });
  await sleep(300);
  check((await posted()).length === 0, 'the break: Auto forced on a prop trader sends nothing (' + JSON.stringify(await posted()) + ')');
  const said = await page.evaluate(() => document.body.innerText);
  check(/Not sent from Praetorian: Demo Agent: PROP-1 is a prop account/.test(said), 'the break: the desk says Praetorian\'s reason, never "not signed in"');
  await page.evaluate(() => { for (const b of document.querySelectorAll('#agView [data-k="modes"] button')) b.disabled = false; document.querySelector('#agView [data-mode="copilot"]').click(); });
  await sleep(200);
  check((await posted()).length === 0, 'the break: Copilot forced sends nothing');

  /* Kill switch ON goes; the release is held back */
  await page.evaluate(() => window.agentDesk.render && 0);
  await page.click('#agView [data-k="kill"]');
  await sleep(200);
  check(JSON.stringify(await posted()) === JSON.stringify(['agentKill:demo:true']), 'Kill switch ON for a prop trader goes: ' + JSON.stringify(await posted()));
  await clear();
  await feed(agent({ killed: true }));
  await sleep(100);
  check(await page.evaluate(() => document.querySelector('#agView [data-k="kill"]').disabled), 'killed, on a prop account: the release is held back');
  await page.evaluate(() => { const k = document.querySelector('#agView [data-k="kill"]'); k.disabled = false; k.click(); });
  await sleep(1200);
  await page.evaluate(() => { const k = document.querySelector('#agView [data-k="kill"]'); k.disabled = false; k.click(); });
  await sleep(200);
  check((await posted()).length === 0, 'the break: the release forced twice on a prop trader sends nothing');

  /* moved to the personal account (another page): whole again */
  await feed(agent({ account: 'MINE-1', killed: false }));
  await sleep(150);
  check(await page.locator('#agView [data-k="prWhy"]').isHidden(), 'on the personal account: no hold-back line');
  const dis2 = await page.evaluate(() => ({ auto: document.querySelector('#agView [data-mode="auto"]').disabled, acct: document.querySelector('#agView [data-k="acctOpen"]').disabled, rules: document.querySelector('#agView [data-k="rulesOpen"]').disabled }));
  check(!dis2.acct && !dis2.rules, 'on the personal account: Change account and Change the rules offered: ' + JSON.stringify(dis2));
  await clear();
  if (!dis2.auto) {
    await page.click('#agView [data-mode="auto"]'); await sleep(500); await page.click('#agView [data-mode="auto"]'); await sleep(200);
    check(JSON.stringify(await posted()) === JSON.stringify(['agentMode:demo:auto']), 'on the personal account: Auto (its second click) goes as before: ' + JSON.stringify(await posted()));
  } else check(false, 'on the personal account Auto should be offered');
  await page.screenshot({ path: path.join(SHOTS, 'praetorian-agent-mine.png') });

  /* the picker: your personal account and Sim offered; a prop account listed, not offered */
  await page.click('#agView [data-k="acctOpen"]');
  const opts = await page.$$eval('#agView [data-k="acctSel"] option', os => os.map(o => ({ v: o.value, d: o.disabled, t: o.textContent })));
  const o = v => opts.find(x => x.v === v) || {};
  check(o('PROP-1').d === true && /not on Praetorian/.test(o('PROP-1').t), 'the picker lists PROP-1, not offered: ' + o('PROP-1').t);
  check(o('SIM-A').d === false && o('').d === false, 'the picker offers Sim and None');
  check(o('MINE-1').t && /now/.test(o('MINE-1').t), 'the picker shows the personal account as his now');
  await page.selectOption('#agView [data-k="acctSel"]', 'PROP-1', { force: true }).catch(() => {});
  await page.evaluate(() => { const s = document.querySelector('#agView [data-k="acctSel"]'); for (const x of s.options) x.disabled = false; s.value = 'PROP-1'; });
  await clear();
  await page.click('#agView [data-act="acctSave"]');
  await sleep(200);
  const yes = await page.$('#agView [data-act="acctYes"]:visible');
  if (yes) { await yes.click(); await sleep(200); }
  check(!(await posted()).some(x => /^agentAccount/.test(x)), 'the break: PROP-1 forced into the picker and Set (and the LIVE question\'s Yes) sends nothing');

  /* the review of 102: the PC helper's calls (not ChartBridge messages, so the desk guards them itself) and the stops */
  console.log('the review of 102: F2, F3, F4, F6, F7');
  await page.evaluate(() => { window.agentDesk.showTab(false); window.agentDesk.showTab(true); });
  await feed(agent({ account: 'PROP-1', mode: 'shadow', killed: false }));
  await page.waitForFunction(() => window.helperCalls.includes('GET /status') && !!document.querySelector('#agView [data-k="hPick"] option[value="sample-build-1"]'), null, { timeout: 8000 }).catch(() => {});
  await sleep(300);
  const onBtn = '#agView [data-k="hBtns"] [data-onoff="on"]';
  check(await page.evaluate(s => { const b = document.querySelector(s); return !!b && b.disabled; }, onBtn), 'F7: a prop trader: the helper\'s On is held back (disabled)');
  /* F4: the On forced on and clicked: helperOn's own guard refuses it, no POST /on */
  await page.evaluate(s => { const b = document.querySelector(s); b.disabled = false; b.click(); }, onBtn);
  await sleep(400);
  check(!(await page.evaluate(() => window.helperCalls.includes('POST /on'))), 'F4: On forced on a prop trader: no POST /on reaches the helper');
  check(/Not started from Praetorian: Demo Agent: PROP-1 is a prop account/.test(await page.$eval('#agView [data-k="hWhy"]', e => e.textContent)), 'F4: and the desk says why');
  /* the Auto-On time forced: no POST /settings */
  await page.evaluate(() => { const h = document.querySelector('#agView [data-k="hAuto"]'); if (h) h.value = '09:30'; const b = document.querySelector('#agView [data-act="hSave"]'); b.disabled = false; b.click(); });
  await sleep(300);
  check(!(await page.evaluate(() => window.helperCalls.includes('POST /settings'))), 'F4: an Auto-On time forced on a prop trader: no POST /settings');
  /* F2: a prop trader in Auto holding 1 MNQ, his program on: Off asks, "Flatten and turn off" sends Shadow, then the flatten */
  await page.evaluate(() => { Object.assign(window.helperState.demo, { on: true, running: true, why: 'on', runningBuild: 'sample-build-1' }); });
  await feed(agent({ account: 'PROP-1', mode: 'auto', position: { root: 'MNQ', qty: 1, avg: 25000 } }));
  await sleep(3600);   // the helper's next poll
  await clear();
  await page.evaluate(() => { const b = document.querySelector('#agView [data-k="hBtns"] [data-onoff="off"]'); b.disabled = false; b.click(); });
  await page.waitForSelector('#agView [data-act="hFlatOff"]', { state: 'visible', timeout: 5000 }).catch(() => {});
  await page.click('#agView [data-act="hFlatOff"]').catch(() => {});
  await sleep(300);
  check(JSON.stringify(await posted()) === JSON.stringify(['agentMode:demo:shadow']), 'F2: "Flatten and turn off" on a prop trader in Auto sends Shadow (a stop) through the gate: ' + JSON.stringify(await posted()));
  await feed(agent({ account: 'PROP-1', mode: 'shadow', position: { root: 'MNQ', qty: 1, avg: 25000 } }));
  await page.waitForFunction(() => window.flattened.length > 0, null, { timeout: 5000 }).catch(() => {});
  check(JSON.stringify(await page.evaluate(() => window.flattened)) === JSON.stringify(['PROP-1 MNQ']), 'F2: then the flatten of PROP-1 MNQ: ' + JSON.stringify(await page.evaluate(() => window.flattened)));
  await feed(agent({ account: 'PROP-1', mode: 'shadow' }));
  await page.waitForFunction(() => window.helperCalls.includes('POST /off'), null, { timeout: 5000 }).catch(() => {});
  check(await page.evaluate(() => window.helperCalls.includes('POST /off')), 'F2: then Off (POST /off) once he is flat');
  check(!(await posted()).some(x => /^agentMode:demo:(auto|copilot)/.test(x)), 'F2: nothing but Shadow was sent for him');
  /* F3: Start in Shadow on the board: on the personal account in Auto; moved to PROP-1 while the desk waits for Shadow: no POST /on */
  await page.evaluate(() => { Object.assign(window.helperState.demo, { on: false, running: false, why: 'off', runningBuild: null }); window.helperCalls.length = 0; });
  await feed(agent({ account: 'MINE-1', mode: 'auto', connected: false }));   // Off: the board offers Start in Shadow
  await sleep(3600);
  await page.click('#agView [data-act="board"]');
  await page.waitForSelector('#agView [data-act="bStart"][data-agent="demo"]', { state: 'visible', timeout: 8000 }).catch(() => {});
  await clear();
  await page.click('#agView [data-act="bStart"][data-agent="demo"]').catch(() => {});
  await sleep(300);
  check(JSON.stringify(await posted()) === JSON.stringify(['agentMode:demo:shadow']), 'F3: Start in Shadow sends Shadow first: ' + JSON.stringify(await posted()));
  await feed(agent({ account: 'PROP-1', mode: 'shadow', connected: false }));   // another page moved him to a prop account; ChartBridge says Shadow
  await sleep(1800);
  check(!(await page.evaluate(() => window.helperCalls.includes('POST /on'))), 'F3: moved to PROP-1 during the wait: no POST /on (checked again before the start)');
  check(/Nothing was started from Praetorian: Demo Agent: PROP-1 is a prop account/.test(await page.$eval('#agView [data-k="bLine"]', e => e.textContent)), 'F3: and the board says why');
  /* F6: a group's Clear stand-down is held back on Praetorian, with the reason */
  const sdBtn = await page.evaluate(() => { const b = document.querySelector('#agView [data-act="bSdClear"]'); return b ? { d: b.disabled, t: b.title } : null; });
  if (sdBtn) check(sdBtn.d && /Not on Praetorian/.test(sdBtn.t), 'F6: Clear stand-down held back with the reason: ' + JSON.stringify(sdBtn));
  else console.log('  (no stand-down row in this sample: F6 is checked by the source test)');
  await page.click('#agView [data-act="boardClose"]').catch(() => {});

  /* the Bot desk: the bot on a prop account */
  await page.evaluate(() => { window.agentDesk.showTab(false); window.botDesk.showTab(true); });
  await feed(bot());
  await sleep(300);
  const bWhy = await page.locator('#btView [data-k="prWhy"]').innerText().catch(() => '');
  check(/The bot: PROP-1 is a prop account/.test(bWhy), 'the bot on a prop account: why it is held back: ' + bWhy);
  const bd = await page.evaluate(() => ({ modes: [...document.querySelectorAll('#btView [data-k="modes"] button')].map(b => b.disabled), acct: document.querySelector('#btView [data-k="acctOpen"]').disabled, rails: document.querySelector('#btView [data-k="railsOpen"]').disabled, kill: document.querySelector('#btView [data-k="kill"]').disabled }));
  check(bd.modes.every(Boolean) && bd.acct && bd.rails && !bd.kill, 'the bot on a prop account: modes, account and rails off; Kill switch on: ' + JSON.stringify(bd));
  await page.screenshot({ path: path.join(SHOTS, 'praetorian-bot-prop.png') });
  await clear();
  await page.evaluate(() => { for (const b of document.querySelectorAll('#btView [data-k="modes"] button')) b.disabled = false; document.querySelector('#btView [data-mode="copilot"]').click(); });
  await sleep(200);
  check((await posted()).length === 0, 'the break: Copilot forced on the bot on a prop account sends nothing');
  await page.click('#btView [data-k="kill"]');
  await sleep(200);
  check(JSON.stringify(await posted()) === JSON.stringify(['botKill:true']), 'the bot\'s Kill switch ON goes: ' + JSON.stringify(await posted()));
  await feed(bot({ killed: true }));
  await sleep(150);
  check(await page.evaluate(() => document.querySelector('#btView [data-k="kill"]').disabled), 'F7: the bot killed on a prop account: its release is held back (disabled)');
  await clear();
  await page.evaluate(() => { const k = document.querySelector('#btView [data-k="kill"]'); k.disabled = false; k.click(); });
  await sleep(1200);
  await page.evaluate(() => { const k = document.querySelector('#btView [data-k="kill"]'); k.disabled = false; k.click(); });
  await sleep(200);
  check((await posted()).length === 0, 'the bot\'s release forced twice on a prop account sends nothing');
  await feed(bot({ killed: false }));
  await feed(bot({ account: 'MINE-1' }));
  await sleep(150);
  check(await page.locator('#btView [data-k="prWhy"]').isHidden() && !(await page.evaluate(() => document.querySelector('#btView [data-k="acctOpen"]').disabled)), 'the bot on the personal account: whole again');

  /* the connection drops: the gate forgets, and nothing but a kill switch ON passes */
  await page.evaluate(() => { for (const h of window.subs) if (h.closed) h.closed(); });
  check(await page.evaluate(() => window.link.post({ type: 'botMode', mode: 'auto' }) === false && window.link.post({ type: 'botKill', on: true }) === true), 'after a drop: only a kill switch ON passes');
  check(!(await posted()).some(x => x === 'send' || x === 'order'), 'nothing ever reached the feed\'s send or sendOrder');
  check(pageErrors.length === 0, 'no page errors: ' + pageErrors.join(' | '));
} finally {
  await browser.close();
}
console.log(errors.length ? errors.length + ' of ' + checks + ' checks FAILED' : 'all ' + checks + ' checks passed');
process.exit(errors.length ? 1 : 0);
