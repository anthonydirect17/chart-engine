// The Fleet tab's view (chart 1.45.0, live/fleet.js FleetView) in a browser, on its own: the real fleet.js and the page's real
// stylesheets, fed ChartBridge's messages through a stand-in for the window's v3 connection (listen and post). It checks what is
// drawn, the Kill all question, and that exactly one message is ever sent, only after Yes. Every account and trader is made up:
// sample data only.
//   npm run smoke:fleet      (CHROMIUM_PATH=/path/to/chrome; SHOTS=dir)
// Then the tab inside the whole workspace against the fake bridge (the button, one view at a time, a reload).
// Screenshots: fleet-desktop, fleet-ask, fleet-phone, fleet-empty, fleet-workspace (.png in test/out).
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

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${pathToFileURL(path.join(root, 'live', 'workspace.css'))}">
<link rel="stylesheet" href="${pathToFileURL(path.join(root, 'live', 'fleet.css'))}">
<style>html,body{height:100%;margin:0}body{display:flex;flex-direction:column}</style></head>
<body class="fl-on"><div class="ws-top"><span>SAMPLE DATA: made-up accounts and traders</span>
<button type="button" class="ws-btn fl-tabbtn" id="wsFleetTab" aria-pressed="false" hidden>Fleet</button></div>
<section class="fl-view fl-in-ws" id="flView" aria-label="Fleet tab"></section>
<script src="${pathToFileURL(path.join(root, 'live', 'fleet.js'))}"></script>
<script>
  window.sent = []; window.subs = [];
  window.V3 = { listen: h => { window.subs.push(h); return () => {}; }, post: m => { window.sent.push(m); return true; } };
  window.feed = m => { for (const h of window.subs) h.message(m); };
  window.fleet = window.FleetView.create({ view: document.getElementById('flView'), tab: document.getElementById('wsFleetTab'), v3: window.V3, onTab: on => { window.tabOn = on; } });
</script></body></html>`;
const file = path.join(SHOTS, 'fleet-smoke.html');
fs.writeFileSync(file, html);

const accounts = { type: 'accounts', personalNamed: true, list: [
  { name: 'SAMPLE-MINE', connection: 'connected', personal: true, prop: false, pnlToday: 40, positions: [] },
  { name: 'SAMPLE-EVAL-1', connection: 'connected', prop: true, group: 'g1', pnlToday: 310, roomFloor: 3140, targetLeft: 1860, rules: { target: 3000, consistency: 40 }, positions: [{ root: 'MNQ', qty: 4 }] },
  { name: 'SAMPLE-EVAL-2', connection: 'connected', prop: true, group: 'g1', pnlToday: 1200, roomFloor: 2380, targetLeft: 520, rules: { target: 3000, consistency: 40 }, positions: [] },
  { name: 'SAMPLE-FUNDED-1', connection: 'connected', prop: true, group: 'g2', pnlToday: -155.5, roomFloor: 2620, targetLeft: null, rules: { target: null, consistency: null }, positions: [{ root: 'MNQ', qty: 2 }] },
  { name: 'SAMPLE-NEW-1', connection: 'connected', prop: true, group: null, pnlToday: 0, rules: null, positions: [] }] };
const groups = { type: 'groups', list: [{ id: 'g1', name: 'Sample evals', accountType: 'eval' }, { id: 'g2', name: 'Sample funded', accountType: 'funded' }] };
const agent = (id, more) => Object.assign({ type: 'agent', agent: id, name: id, build: 'sample build', enabled: true, connected: true, mode: 'auto', account: 'SAMPLE-EVAL-1',
  rules: { entryFrom: '09:40', entryUntil: '15:00', flatAt: '15:55' }, pnlToday: 0, trades: 0, killed: false, standDown: null, owns: false, lastBeatMs: 300 }, more || {});

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()); });
  await page.goto(pathToFileURL(file).href);
  const feed = m => page.evaluate(x => window.feed(x), m);
  const text = sel => page.locator(sel).innerText();

  // before ChartBridge says anything the tab's button is hidden; an older ChartBridge keeps it hidden
  check(await page.locator('#wsFleetTab').isHidden(), 'the Fleet button is hidden before ChartBridge says hello');
  await feed({ type: 'hello', version: '0.6.16', features: ['v3'] });
  check(await page.locator('#wsFleetTab').isHidden(), 'and with a ChartBridge before 0.6.17');
  await feed({ type: 'hello', version: '0.6.19', features: ['v3'] });
  check(await page.locator('#wsFleetTab').isVisible(), 'shown with ChartBridge 0.6.19');
  await page.click('#wsFleetTab');
  check(await page.evaluate(() => window.tabOn === true && window.fleet.shown()), 'a click opens the tab');

  // nothing known yet: said plainly, and Kill all is not offered
  check((await text('.fl-box[aria-label="Prop accounts"] .fl-empty')).includes('No personal account is picked yet'), 'no accounts message yet: says how to pick the personal account');
  check(await page.locator('.fl-kill').getAttribute('aria-disabled') === 'true', 'Kill all is not offered yet');
  await page.click('.fl-kill', { force: true });      // Playwright will not click an aria-disabled button by itself; a person can
  check(await page.evaluate(() => window.sent.length === 0) && (await text('.fl-said')).includes('Sign in to trading first'), 'a click on it sends nothing and says why');
  await page.screenshot({ path: path.join(SHOTS, 'fleet-empty.png') });

  await feed({ type: 'trading', enabled: true });
  await feed(accounts); await feed(groups);
  await feed(agent('germanicus', { rules: { entryFrom: '09:40', entryUntil: '15:00', flatAt: '15:55', marketEntry: true, noTarget: true }, dayStop: 900, owns: true }));
  await feed(agent('manrae', { account: 'SAMPLE-MINE', mode: 'copilot' }));
  await feed(agent('resting', { account: 'SAMPLE-EVAL-2', standDown: "the day's profit stop is reached on SAMPLE-EVAL-2 ($1200, 40% of the profit target (the consistency rule); the day is at $1200, realized plus open): flat, and no new entries for agent resting until 18:00 ET" }));

  check(!(await text('.fl-said')).includes('Sign in') && (await text('.fl-said')).includes('Kill all acts on the prop accounts only'), 'signed in: the reason it was not offered is gone, and the line says what Kill all touches');
  check((await text('.fl-dutyline')) === 'On duty: germanicus, Auto on SAMPLE-EVAL-1', 'the duty line names the one trader in Auto on a prop account: ' + await text('.fl-dutyline'));
  const g = page.locator('.fl-trader[data-id="germanicus"]');
  const gt = await g.innerText();
  check(gt.includes('ON DUTY') && /AUTO/i.test(gt) && gt.includes('SAMPLE-EVAL-1') && gt.includes('09:40 to 15:00 New York, flat at 15:55') && gt.includes('In a trade'), 'germanicus: Auto, on duty, its account, window and what it is doing');
  check(gt.includes('Market entry: on') && gt.includes('No target: on') && gt.includes('$900 (from its plan)'), 'its two entry switches are on and shown, and its day stop: ' + gt.replace(/\s+/g, ' '));
  const mt = await page.locator('.fl-trader[data-id="manrae"]').innerText();
  check(mt.includes('Market entry: off') && mt.includes('No target: off') && !mt.includes('ON DUTY') && /personal/i.test(mt), 'manrae: both switches off, on the personal account, not on duty');
  check((await page.locator('.fl-trader[data-id="resting"]').getAttribute('data-tone')) === 'standDown' && (await page.locator('.fl-trader[data-id="resting"]').innerText()).includes("Stood down: the day's profit stop is reached"), 'a trader stood down by the day stop says so');

  const rows = await page.locator('.fl-table tbody tr').evaluateAll(trs => trs.map(tr => ({ name: tr.dataset.name, done: tr.classList.contains('fl-done'), cells: [...tr.cells].map(c => c.innerText.replace(/\s+/g, ' ').trim()) })));
  check(rows.map(r => r.name).join(',') === 'SAMPLE-EVAL-1,SAMPLE-EVAL-2,SAMPLE-FUNDED-1,SAMPLE-NEW-1', 'the prop accounts only (the personal account is not listed): ' + rows.map(r => r.name).join(','));
  const r1 = rows[0].cells, r2 = rows[1], r3 = rows[2].cells, r4 = rows[3].cells;
  check(r1[1] === '$1,140 of $3,000' && r1[2] === '$3,140' && r1[3] === '+$310' && r1[4] === "$310 of $900 (the plan's day stop)" && r1[5].startsWith('Long 4 MNQ'), 'eval 1: progress, cushion, today, the plan\'s day stop, its position: ' + r1.join(' | '));
  check(r2.done && r2.cells[4].startsWith('$1,200 of $1,200 (40% of the $3,000 target)') && /reached/i.test(r2.cells[4]), 'eval 2: at the consistency mark: reached: ' + r2.cells[4]);
  check(r3[0].includes('Funded') && r3[3] === '-$155.50' && r3[4] === 'none (funded, and no plan value)', 'funded: no mark without a plan value: ' + r3.join(' | '));
  check(r4[0].includes('In no group: the runner sizes it 0'), 'an account in no group says why it would be sized 0');
  const tone = await page.locator('.fl-table tbody tr[data-name="SAMPLE-EVAL-1"] .fl-pnl').evaluate(el => getComputedStyle(el).color);
  const tone2 = await page.locator('.fl-table tbody tr[data-name="SAMPLE-FUNDED-1"] .fl-pnl').evaluate(el => getComputedStyle(el).color);
  check(tone !== tone2, 'Today is green when up and red when down (the only green and red on the tab)');
  check((await text('.fl-later')).includes('Not built yet, so not shown'), 'what is not built is said, not faked');
  await page.screenshot({ path: path.join(SHOTS, 'fleet-desktop.png') });

  // Kill all: asks first; Cancel sends nothing; Yes sends exactly one message
  check(await page.locator('.fl-kill[data-do="ask"]').getAttribute('aria-disabled') === null, 'Kill all is offered now');
  await page.click('.fl-kill[data-do="ask"]');
  check(await page.locator('.fl-ask').isVisible() && await page.evaluate(() => window.sent.length === 0), 'a click asks first and sends nothing');
  check(await page.evaluate(() => document.activeElement && document.activeElement.dataset.do === 'no'), 'the focus is on Cancel');
  await page.screenshot({ path: path.join(SHOTS, 'fleet-ask.png') });
  await page.click('.fl-ask [data-do="no"]');
  check(await page.locator('.fl-ask').count() === 0 && await page.evaluate(() => window.sent.length === 0), 'Cancel: the question goes, nothing sent');
  await page.click('.fl-kill[data-do="ask"]');
  await page.click('.fl-ask [data-do="yes"]');
  const sent = await page.evaluate(() => window.sent);
  check(sent.length === 1 && sent[0].type === 'agentKillAllProp' && typeof sent[0].cid === 'string' && Object.keys(sent[0]).sort().join(',') === 'cid,type', 'Yes: exactly one message, agentKillAllProp with a cid and nothing else: ' + JSON.stringify(sent));
  check((await text('.fl-said')).includes('waiting for ChartBridge'), 'and the tab says it was sent');
  await feed({ type: 'status', level: 'warn', text: 'Kill all (prop accounts): agent germanicus on SAMPLE-EVAL-1: flattening what it owns, the kill switch on, mode shadow. The bot, the copier and manual orders are never touched' });
  check((await text('.fl-said')).startsWith('Kill all (prop accounts): agent germanicus'), "ChartBridge's own words are shown");
  // a refusal is shown too
  await page.click('.fl-kill[data-do="ask"]');
  await page.click('.fl-ask [data-do="yes"]');
  const cid = await page.evaluate(() => window.sent[1].cid);
  await feed({ type: 'reject', cid, reason: 'this connection may not trade; reload ChartBridge\'s page' });
  check((await text('.fl-said')).includes('this connection may not trade') && await page.locator('.fl-said.bad').count() === 1, 'a refusal from ChartBridge is shown as one');
  check(await page.evaluate(() => window.sent.every(m => m.type === 'agentKillAllProp')) && (await page.evaluate(() => window.sent.length)) === 2, 'nothing but Kill all was ever sent');

  // the connection drops: everything ChartBridge said is forgotten
  await page.evaluate(() => { for (const h of window.subs) h.closed(); });
  check((await text('.fl-box[aria-label="Traders"] .fl-empty')).includes('ChartBridge is not connected') && await page.locator('.fl-table').count() === 0, 'connection lost: no stale traders or accounts');
  await feed({ type: 'hello', version: '0.6.19', features: ['v3'] }); await feed({ type: 'trading', enabled: true }); await feed(accounts); await feed(groups);
  await feed(agent('germanicus', { rules: { entryFrom: '09:40', entryUntil: '15:00', flatAt: '15:55', marketEntry: true, noTarget: true }, dayStop: 900, owns: true }));

  // phone width: one column, no sideways scroll of the page, the buttons big enough to touch
  await page.setViewportSize({ width: 390, height: 844 });
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    cols: getComputedStyle(document.querySelector('.fl-cols')).gridTemplateColumns.split(' ').length, kill: document.querySelector('.fl-kill').getBoundingClientRect().height }));
  check(m.sw <= m.cw + 1 && m.cols === 1, 'at 390 px: one column and no sideways scroll of the page (' + m.sw + ' in ' + m.cw + ')');
  check(m.kill >= 30, 'the Kill all button keeps its height (' + m.kill + ' px)');
  await page.screenshot({ path: path.join(SHOTS, 'fleet-phone.png'), fullPage: true });
  check(pageErrors.length === 0, 'no page errors: ' + pageErrors.join(' | '));
} finally { await browser.close(); }

/* ---- in the whole workspace, against the fake bridge: the button shows with a ChartBridge that knows Kill all, the tab opens
   over the grid, one view at a time, and a reload keeps it. The fake bridge knows nothing of prop accounts: the tab then says
   how to pick the personal account, and nothing is sent. */
{
  const { spawn } = await import('node:child_process');
  const { TEST_PIN, enterPin } = await import('./smoke-pin.mjs');
  const PORT = +(process.env.FLEET_SMOKE_PORT || 8987);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const b2 = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  let bridge = null;
  try {
    bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--test-controls', '--test-pin=' + TEST_PIN, '--agents=demo', '--version=0.6.19'], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });
    const ctx = await b2.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    for (const r of ['chart-hotkeys', 'chart-strategies', 'chart-accounts'])
      await ctx.route('http://localhost:8800/api/' + r, x => x.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
    const page = await ctx.newPage();
    const pe = [];
    page.on('pageerror', e => pe.push(e.message));
    page.on('dialog', d => { pe.push('a browser dialog: ' + d.message()); d.dismiss(); });
    await page.goto(`http://localhost:${PORT}/live/?layout=Main`);
    await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
    await enterPin(page, TEST_PIN);
    await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
    await page.waitForFunction(() => !document.getElementById('wsFleetTab').hidden, null, { timeout: 15000 }).catch(() => {});
    check(await page.locator('#wsFleetTab').isVisible(), 'workspace: the Fleet button shows with ChartBridge 0.6.19');
    await page.waitForFunction(() => !document.getElementById('wsAgentTab').hidden, null, { timeout: 15000 }).catch(() => {});
    check(await page.locator('#wsAgentTab').isVisible(), 'workspace: the Agent button is still there');
    await page.click('#wsFleetTab');
    await sleep(300);
    const on = await page.evaluate(() => ({ cls: document.body.classList.contains('fl-on'), url: location.search, grid: getComputedStyle(document.querySelector('.ws-grid')).display,
      view: getComputedStyle(document.getElementById('flView')).display, title: (document.querySelector('.fl-title') || {}).textContent }));
    check(on.cls && /tab=fleet/.test(on.url) && on.grid === 'none' && on.view !== 'none' && on.title === 'Fleet', 'workspace: the tab opens over the grid and the address keeps it: ' + JSON.stringify(on));
    await page.waitForFunction(() => document.querySelectorAll('.fl-trader').length > 0, null, { timeout: 10000 }).catch(() => {});
    check(await page.locator('.fl-trader[data-id="demo"]').count() === 1, 'workspace: the fake bridge\'s agent is listed as a trader');
    check((await page.locator('.fl-box[aria-label="Prop accounts"] .fl-empty').innerText()).includes('No personal account is picked yet'), 'workspace: no pick, so no prop account, and it says how to pick');
    await page.click('#wsAgentTab');
    await sleep(300);
    check(await page.evaluate(() => !document.body.classList.contains('fl-on') && document.body.classList.contains('ag-on') && /tab=agent/.test(location.search)), 'workspace: opening the Agent tab closes Fleet (one view at a time)');
    await page.click('#wsFleetTab');
    await sleep(300);
    check(await page.evaluate(() => document.body.classList.contains('fl-on') && !document.body.classList.contains('ag-on')), 'workspace: and Fleet closes the Agent tab');
    await page.reload();
    await page.waitForSelector('.cb-pin-key', { timeout: 15000 }).then(() => enterPin(page, TEST_PIN)).catch(() => {});
    await page.waitForFunction(() => document.body.classList.contains('fl-on'), null, { timeout: 20000 }).catch(() => {});
    check(await page.evaluate(() => document.body.classList.contains('fl-on')), 'workspace: a reload with ?tab=fleet opens the tab again');
    await page.click('#wsFleetTab');
    await sleep(300);
    check(await page.evaluate(() => !document.body.classList.contains('fl-on') && !/tab=/.test(location.search) && getComputedStyle(document.querySelector('.ws-grid')).display !== 'none'), 'workspace: a second click closes it and the grid is back');
    check(pe.length === 0, 'workspace: no page errors and no browser dialog: ' + pe.join(' | '));
    await page.screenshot({ path: path.join(SHOTS, 'fleet-workspace.png') });
  } finally { if (bridge) bridge.kill(); await b2.close(); }
}
console.log(errors.length ? `\n${errors.length} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(errors.length ? 1 : 0);
