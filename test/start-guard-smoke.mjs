// Release 1 (the start guard, the lock of 2026-11-15, topic 2): the real workspace against the fake bridge (sample data; nothing
// reaches a broker), in Chromium, with automation tabs broken on purpose (each tab's create made to throw, the rest of its file
// as served):
//   - none broken: the charts go live, the ticket is enabled, the Bot button and the Legion link show, nothing is said;
//   - the chart page's two parts broken (the Bot tab, the Agent desk): the charts still go live, the ticket still sends a Buy MKT
//     to the fake, no page error, the note line names both, the Bot's button stays hidden after ChartBridge's hello;
//   - plan step 3.2: Legion's own page (legion.html) with the Colosseum and Legion's cohorts broken: Stop all automation and the
//     other tabs still work, and the page names what did not start;
//   - an old address of a tab that moved (?tab=agent) opens Legion's page on that tab.
// Screenshots in test/out/start-guard-*.png.
//   npm run smoke:start-guard        (CHROMIUM_PATH=/path/to/chrome; START_GUARD_SMOKE_PORT)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin, ticketOnSim101 } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const PORT = +(process.env.START_GUARD_SMOKE_PORT || 8993);
const errors = [];
let checks = 0;
const check = (ok, m) => { checks++; if (!ok) { errors.push(m); console.error('  FAIL ' + m); } else console.log('  ok   ' + m); };
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const LAYOUT = { Main: { panels: [
  { id: 'c1', type: 'chart', root: 'MNQ', tf: 'm1', x: 0, y: 0, w: 6, h: 6 }, { id: 'c2', type: 'chart', root: 'NQ', tf: 'm5', x: 6, y: 0, w: 4, h: 6 },
  { id: 'tk', type: 'ticket', x: 10, y: 0, w: 2, h: 6 }] } };
const FILES = { bot: 'BotDesk', agent: 'AgentDesk', league: 'LeagueView', fleet: 'FleetView' };

const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--trade-accounts=Sim101', '--max-qty=MNQ:5,NQ:2',
  '--test-controls', '--agents=demo', '--version=0.6.20', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
const browser = ticketOnSim101(await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}));
async function open(broken, query) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  for (const f of broken) {
    await ctx.route(new RegExp('/live/' + f + '\\.js(\\?|$)'), async r => {
      const res = await r.fetch();
      const body = (await res.text()) + `\n;window.${FILES[f]} = Object.assign({}, window.${FILES[f]}, { create() { throw new Error('start-guard smoke: ${f}.js broken on purpose'); } });\n`;
      await r.fulfill({ response: res, body });
    });
  }
  await ctx.addInitScript(l => { try { localStorage.setItem('live-workspace-v1', JSON.stringify({ v: 1, layouts: l })); } catch (e) { /* blocked */ } }, LAYOUT);
  const page = await ctx.newPage();
  const pe = [], logged = [];
  page.on('pageerror', e => pe.push(e.message));
  page.on('console', m => { if (m.type() === 'error') logged.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/live/?layout=Main${query || ''}`);
  await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
  await enterPin(page, TEST_PIN);
  await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && window.workspace.ticket().enabled, null, { timeout: 40000 });
  await page.waitForFunction(() => window.workspace.views().every(v => v.type !== 'chart' || v.state === 'live'), null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  return { ctx, page, pe, logged };
}
const shown = (page, id) => page.evaluate(i => { const b = document.getElementById(i); return !!b && !b.hidden; }, id);
const chartsLive = page => page.evaluate(() => window.workspace.views().filter(v => v.type === 'chart').map(v => v.id + ':' + v.state + ':' + window.workspace.chart(v.id).bars().length));
const failNote = page => page.evaluate(() => { const e = document.getElementById('wsNote'); return e && !e.hidden ? e.textContent : ''; });

try {
  await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });

  console.log('none broken');
  let o = await open([]);
  let ch = await chartsLive(o.page);
  check(ch.length === 2 && ch.every(x => /:live:[1-9]/.test(x)), 'the charts are live with bars: ' + ch.join(', '));
  check(await o.page.evaluate(() => !!document.querySelector('.ws-panel[data-type="ticket"] [data-tk-id="buyMkt"]')), 'the ticket is on the page');
  for (const id of ['wsBotTab', 'wsLegion']) check(await shown(o.page, id), id + ' shows');
  check(!(await o.page.evaluate(() => ['wsAgentTab', 'wsFleetTab', 'wsLeagueTab', 'wsPraetorianTab'].some(i => document.getElementById(i)))), 'plan step 3.2: no Legion, Colosseum or Agent tab on the chart page');
  check(!/did not start/.test(await failNote(o.page)), 'nothing said');
  check(!o.pe.length, 'no page error' + (o.pe.length ? ': ' + o.pe.join(' | ') : ''));
  await o.page.screenshot({ path: path.join(out, 'start-guard-ok.png') });
  await o.ctx.close();

  console.log('the Bot tab and the Agent desk broken');
  o = await open(['bot', 'agent']);
  ch = await chartsLive(o.page);
  check(ch.length === 2 && ch.every(x => /:live:[1-9]/.test(x)), 'the charts are live with bars all the same: ' + ch.join(', '));
  check(!o.pe.length, 'no page error' + (o.pe.length ? ': ' + o.pe.join(' | ') : ''));
  const note = await failNote(o.page);
  check(note === 'The Bot tab and Agent desk did not start: the charts and the ticket work; reload this window to try it again.', 'the note line names both: "' + note + '"');
  check(o.logged.filter(t => /did not start/.test(t)).length === 2, 'each broken part named in the console (' + o.logged.filter(t => /did not start/.test(t)).length + ')');
  check(!(await shown(o.page, 'wsBotTab')), 'wsBotTab stays hidden after the hello');
  check(await o.page.evaluate(() => window.workspace.bot() === null && window.workspace.agent() === null), 'no desk object on the page');
  await o.page.screenshot({ path: path.join(out, 'start-guard-broken.png') });
  /* the ticket works: Armed, Buy MKT, the fake gets the order (sample data, the fake's Sim101) */
  const before = ((await control('received')).types || {}).order || 0;
  const tk = id => `.ws-panel[data-type="ticket"] [data-tk-id="${id}"]`;
  await o.page.click(tk('armBtn'));
  await o.page.waitForFunction(() => window.workspace.ticket().armed, null, { timeout: 5000 });
  await o.page.click(tk('buyMkt'));
  await o.page.waitForTimeout(1200);
  const q = o.page.locator('.nostop-ask:not([hidden]) .nostop-send');
  if (await q.count()) { await q.first().click(); await o.page.waitForTimeout(1200); }   // "No stop: send anyway?" when no bracket is set
  const after = ((await control('received')).types || {}).order || 0;
  check(after === before + 1, 'with every tab broken the ticket still sends: one order reached the fake (' + before + ' then ' + after + ')');
  await o.page.click(tk('armBtn'));
  await o.page.click('#wsFlat');
  await o.page.waitForTimeout(1000);
  await o.ctx.close();

  console.log('Legion: the cohorts and the Colosseum broken');
  {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    for (const f of ['league', 'fleet']) {
      await ctx.route(new RegExp('/live/' + f + '\\.js(\\?|$)'), async r => {
        const res = await r.fetch();
        await r.fulfill({ response: res, body: (await res.text()) + `\n;window.${FILES[f]} = Object.assign({}, window.${FILES[f]}, { create() { throw new Error('start-guard smoke: ${f}.js broken on purpose'); } });\n` });
      });
    }
    const page = await ctx.newPage(), pe = [];
    page.on('pageerror', e => pe.push(e.message));
    await page.goto(`http://localhost:${PORT}/live/legion.html?tab=cohorts`);
    await page.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(page, TEST_PIN);
    await page.waitForFunction(() => document.getElementById('lxConn').dataset.state === 'on', null, { timeout: 30000 });
    const st = await page.evaluate(() => window.LegionApp.state());
    check(JSON.stringify(st.failed) === JSON.stringify(['the cohorts', 'the Colosseum']) && st.mounted.join() === 'praetorian', 'Legion names the two that did not start; Praetorian still mounted: ' + JSON.stringify(st));
    check(/the cohorts, the Colosseum did not start: Stop all automation and the other tabs work/.test(await page.textContent('#lxFailed')), 'and says so on the page');
    await page.click('#lxStop');
    check((await page.evaluate(() => window.LegionApp.state())).asking, 'Stop all automation still asks');
    await page.click('#lxStopNo');
    await page.click('[data-lx-sub="praetorian"]'); await page.waitForTimeout(500);
    check(await page.evaluate(() => !!window.legion.agent() && window.legion.agent().shown === true), 'Praetorian still opens');
    check(!pe.length, 'no page error' + (pe.length ? ': ' + pe.join(' | ') : ''));
    await page.screenshot({ path: path.join(out, 'start-guard-legion-broken.png') });
    await ctx.close();
  }

  console.log('an old address of a tab that moved: ?tab=agent');
  {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage(), pe = [];
    page.on('pageerror', e => pe.push(e.message));
    await page.goto(`http://localhost:${PORT}/live/?layout=Main&tab=agent`);
    await page.waitForURL(/\/live\/legion\.html\?layout=Main&tab=agent/, { timeout: 10000 }).catch(() => {});
    check(/\/live\/legion\.html\?layout=Main&tab=agent$/.test(page.url()), 'the chart page forwards it to Legion: ' + page.url());
    await page.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(page, TEST_PIN);
    await page.waitForFunction(() => document.getElementById('lxConn').dataset.state === 'on', null, { timeout: 30000 });
    const st = await page.evaluate(() => window.LegionApp.state());
    check(st.tab === 'cohorts' && st.sub === 'praetorian', 'Legion opens Cohorts, Praetorian: ' + st.tab + '|' + st.sub);
    check(!pe.length, 'no page error' + (pe.length ? ': ' + pe.join(' | ') : ''));
    await ctx.close();
  }
} catch (e) {
  errors.push(String(e && e.stack || e));
} finally {
  await browser.close();
  bridge.kill();
}
console.log(errors.length ? `\n${errors.length} of ${checks} checks FAILED:\n  ` + errors.join('\n  ') : `\n${checks}/${checks} checks passed`);
process.exit(errors.length ? 1 : 0);
