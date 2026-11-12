// Chart 1.45.0 (Anthony 2026-11-11, build answers 14; the review of 92's N11): while a tab covers the chart grid, a hotkey that can
// open or add to a position does nothing and says so; Close and Flatten all work as on the bare chart. In the whole workspace
// against the fake bridge (sample data; nothing reaches a broker), with the real hotkey handlers and the real tabs:
//   - on the bare chart every key sends what it sends today (Buy, Sell, Close, Flatten all);
//   - under each tab (Legion, Agent, Bot, League): Buy, Sell, B/E and Merge send nothing and the top bar says why; Close and
//     Flatten all send exactly what they send on the bare chart; Reject is not switched off; Accept (Anthony 2026-11-12:
//     "On where shown") is off under Legion and League and as before on the Agent and the Bot tab, which show its proposal;
//   - with the tab closed again the keys are as before.
//   npm run smoke:tabkeys        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin, ticketOnSim101 } from './smoke-pin.mjs';
import { toggleTab } from './tab-buttons.mjs';
import { startDesk } from './fake-desk.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(out, { recursive: true });
const PORT = +(process.env.TABKEYS_SMOKE_PORT || 8989), DP = PORT + 1;
const errors = [];
let checks = 0;
const check = (ok, m) => { checks++; if (!ok) { errors.push(m); console.error('  FAIL ' + m); } else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const KEYS = { buy: 'Alt+B', sell: 'Alt+S', be: 'Alt+K', close: 'Alt+C', flattenAll: 'Alt+X' };
const PRESS = { buy: 'Alt+KeyB', sell: 'Alt+KeyS', be: 'Alt+KeyK', close: 'Alt+KeyC', flattenAll: 'Alt+KeyX', merge: 'Alt+KeyM', accept: 'Alt+KeyY', reject: 'Alt+KeyN' };

const spies = () => {
  window.__sent = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) {
    try { const m = JSON.parse(d); if (['order', 'change', 'cancel', 'flatten', 'plan', 'merge', 'botAnswer', 'agentAnswer'].includes(m.type)) window.__sent.push(m); } catch (e) { /* not JSON */ }
    return send.call(this, d);
  };
};
/* a stand-in Desk, so the League tab is offered (its league has no session: the tab opens and says so) */
const desk = await startDesk(DP, { hotkeys: { rev: 1, keys: Object.assign({ merge: 'Alt+M', maximize: '', accept: 'Alt+Y', reject: 'Alt+N' }, KEYS), modifiers: { limit: '', stop: '' } } });
desk.league = { shadow: 'SHADOW: no orders', folder: { set: true, ok: true, problem: 'The league has no session yet.' }, trades: [], open: [], decisions: [] };
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--trade-accounts=Sim101', '--max-qty=MNQ:9,NQ:2,MES:2,ES:2', '--test-controls', '--agents=demo', '--version=0.6.20', '--test-pin=' + TEST_PIN, '--desk-url=http://127.0.0.1:' + DP], { stdio: ['ignore', 'pipe', 'inherit'] });
const browser = ticketOnSim101(await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}));
try {
  await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(spies);
  await ctx.addInitScript(k => { try { localStorage.setItem('live-hotkeys-v1', JSON.stringify(k)); localStorage.setItem('live-bracket-v1', JSON.stringify({ MNQ: { stop: 12, target: 24 } })); } catch (e) { /* blocked */ } }, KEYS);
  const page = await ctx.newPage();
  const pe = [];
  page.on('pageerror', e => pe.push(e.message));
  await page.goto(`http://localhost:${PORT}/live/?layout=Main`);
  await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
  await enterPin(page, TEST_PIN);
  await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
  const tk = id => `.ws-panel[data-type="ticket"] [data-tk-id="${id}"]`;
  await page.waitForSelector(tk('buyMkt'));
  await page.click(tk('armBtn'));
  const blur = () => page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  const sentNow = () => page.evaluate(() => window.__sent.splice(0).map(m => { const c = Object.assign({}, m); delete c.cid; return c; }));
  const note = () => page.evaluate(() => { const e = document.getElementById('wsNote'); return e.hidden ? '' : e.textContent; });
  const press = async id => { await blur(); await page.keyboard.press(PRESS[id]); await wait(450); return sentNow(); };
  const shape = list => JSON.stringify(list.map(m => [m.type, m.side || '', m.kind || '', m.account || '', m.root || '']));

  // ---- the bare chart: what each key sends today (a position is opened first, so Close and Flatten all have something to send)
  await sentNow();
  const bare = {};
  bare.buy = await press('buy');
  bare.close = await press('close');
  await wait(500);
  bare.sell = await press('sell');
  bare.flattenAll = await press('flattenAll');
  check(bare.buy.length === 1 && bare.buy[0].type === 'order' && bare.buy[0].side === 'buy', 'bare chart: the Buy key sends one buy order: ' + shape(bare.buy));
  check(bare.sell.length === 1 && bare.sell[0].type === 'order' && bare.sell[0].side === 'sell', 'bare chart: the Sell key sends one sell order: ' + shape(bare.sell));
  check(bare.close.length >= 1 && bare.close.every(m => m.type === 'flatten'), 'bare chart: the Close key sends its flatten: ' + shape(bare.close));
  check(bare.flattenAll.length >= 1 && bare.flattenAll.every(m => m.type === 'flatten'), 'bare chart: the Flatten all key sends its flatten: ' + shape(bare.flattenAll));
  await wait(600);

  // ---- under each tab
  const tabs = [
    { name: 'Legion', cls: 'fl-on', toggle: () => page.click('#wsFleetTab') },
    { name: 'Agent', cls: 'ag-on', toggle: () => page.click('#wsAgentTab') },
    { name: 'Bot', cls: 'bt-on', toggle: () => toggleTab(page, 'bot') },
    { name: 'League', cls: 'lg-on', toggle: () => page.click('#wsLeagueTab') },
  ];
  await page.waitForFunction(() => !document.getElementById('wsFleetTab').hidden && !document.getElementById('wsAgentTab').hidden && !document.getElementById('wsLeagueTab').hidden, null, { timeout: 20000 }).catch(() => {});
  for (const t of tabs) {
    for (const urgent of ['close', 'flattenAll']) {
      // a position opened on the bare chart, then the tab over it
      const opened = await press('buy');
      check(shape(opened) === shape(bare.buy), t.name + ': (a position opened on the bare chart for the ' + urgent + ' key)');
      await t.toggle(); await wait(400);
      const on = await page.evaluate(c => document.body.classList.contains(c) && getComputedStyle(document.querySelector('.ws-grid')).display === 'none', t.cls);
      check(on, t.name + ': the tab is open and covers the chart grid');
      await sentNow();
      const shown = t.name === 'Agent' || t.name === 'Bot';       // the tabs that show the proposal the Accept key answers
      const why = 'Hotkey ignored: the ' + t.name + ' tab covers the chart. Only Close, Flatten all and Reject work under ' + (shown ? 'it, and Accept for a proposal shown on it.' : 'a tab.');
      if (urgent === 'close') for (const id of ['buy', 'sell', 'be', 'merge'].concat(shown ? [] : ['accept'])) {
        const got = await press(id);
        const said = await note();
        check(got.length === 0 && said === why, t.name + ': the ' + id + ' key sends nothing and the top bar says why: ' + shape(got) + ' | ' + said);
        await page.evaluate(() => { document.getElementById('wsNote').hidden = true; });
      }
      if (urgent === 'close' && shown) {
        // Anthony 2026-11-12 ("On where shown"): on the Agent and the Bot tab Accept is as before this release
        const got = await press('accept'), said = await note();
        check(got.length === 0 && !/Hotkey ignored/.test(said), t.name + ': the Accept key is not switched off on the tab that shows its proposal (none is open here, and it says so): ' + said);
      }
      if (urgent === 'close') {
        // Reject can only decline a proposal: it is not switched off (with none open it says so, as on the bare chart)
        const got = await press('reject'), said = await note();
        check(got.length === 0 && !/Hotkey ignored/.test(said), t.name + ': the Reject key is not switched off under the tab: ' + said);
      }
      const got = await press(urgent);
      check(shape(got) === shape(bare[urgent]), t.name + ': the ' + urgent + ' key sends exactly what it sends on the bare chart: ' + shape(got));
      if (t.name === 'Legion' && urgent === 'close') await page.screenshot({ path: path.join(out, 'tab-hotkeys-legion.png') });
      await t.toggle(); await wait(500);
      check(await page.evaluate(c2 => !document.body.classList.contains(c2), t.cls), t.name + ': closed again');
    }
  }

  // ---- the tabs closed: exactly as before
  await wait(600);
  const again = await press('buy');
  check(shape(again) === shape(bare.buy), 'with no tab open the Buy key sends what it sent before: ' + shape(again));
  const againClose = await press('close');
  check(shape(againClose) === shape(bare.close), 'and Close closes it');
  check(pe.length === 0, 'no page errors: ' + pe.join(' | '));
} finally { bridge.kill(); await browser.close(); try { desk.close(); } catch (e) { /* closed */ } }
console.log(errors.length ? `\n${errors.length} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(errors.length ? 1 : 0);
