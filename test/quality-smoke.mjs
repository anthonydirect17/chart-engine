// Quality round 1 smoke (chart 1.19.1): a bug found by clicking every control against the fake bridge, checked twice.
// The workspace (live/index.html) in Chromium against the fake bridge with --v3 and a fake Desk (test/fake-desk.mjs).
// Sample data and made-up accounts only; nothing reaches a broker, and no order is sent by this test.
//   Two changes to The Desk's hotkeys in a row are both saved: Limit then Stop at once, and Buy MKT's key then Sell MKT's
//   key at once. The second was sent with the rev read before the first was saved, so The Desk refused it as if another
//   PC had saved first (409) and that change was lost. The Desk's saves are slowed to 400 ms here (a Desk on another PC).
//   npm run smoke:quality        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
// Screenshot: test/out/quality-hotkeys-saved-1366.png.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';
import { startDesk } from './fake-desk.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const PORT = +(process.env.QUALITY_SMOKE_PORT || 8846), DESK_PORT = PORT + 1;
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms) {
  const end = Date.now() + (ms || 10000);
  for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); }
}
let bridge = null;
async function startBridge() {
  bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--trade-accounts=Sim101', '--no-v3-seed', '--test-controls', '--test-pin=' + TEST_PIN, '--desk-url=http://127.0.0.1:' + DESK_PORT], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => bridge.stdout.once('data', r));
}
async function openWs(ctx) {
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto(`http://localhost:${PORT}/live/`);
  await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
  await enterPin(page, TEST_PIN);
  await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 40000 });
  return page;
}
const deskDoc = async () => (await fetch(`http://127.0.0.1:${DESK_PORT}/api/chart-hotkeys`)).json();

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let desk = null;
try {
  await startBridge();
  desk = await startDesk(DESK_PORT);
  /* ================ Two hotkey changes in a row, both saved ================ */
  console.log('two changes to The Desk\'s hotkeys in a row');
  const ctx2 = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  /* The Desk answers a save in 400 ms, as over Tailscale from another PC: the second change is made before the first is saved */
  await ctx2.route(`http://127.0.0.1:${DESK_PORT}/api/chart-hotkeys`, async r => { if (r.request().method() === 'PUT') await wait(400); await r.continue(); });
  const p2 = await openWs(ctx2);
  await p2.click('#wsSet'); await wait(300);
  await until(async () => /^Shared by every PC/.test(await p2.textContent('#wsDeskNote')), 'The Desk\'s hotkeys in use', 20000);
  for (const rep of [1, 2]) {
    const [lim, stp] = rep === 1 ? ['Shift', 'Ctrl'] : ['', ''];   // set both, then clear both
    await p2.selectOption('#wsMod-limit', lim); await p2.selectOption('#wsMod-stop', stp);
    await until(async () => { const m = (await deskDoc()).modifiers; return m.limit === lim && m.stop === stp; }, `try ${rep}: both saved`, 5000);
    await wait(500);
    let d = await deskDoc();
    check(d.modifiers.limit === lim && d.modifiers.stop === stp, `try ${rep}: Limit ${lim || 'None'} then Stop ${stp || 'None'} at once: The Desk has both (${JSON.stringify(d.modifiers)})`);
    check(await p2.inputValue('#wsMod-limit') === lim && await p2.inputValue('#wsMod-stop') === stp && await p2.textContent('#wsModNote') === 'Saved in The Desk.', `try ${rep}: and Settings shows both, saved`);
    const [kb, ks] = rep === 1 ? ['F2', 'F8'] : ['F9', 'Shift+F8'];   // keys the page takes (F7 and the like stay the browser's)
    const press = k => p2.keyboard.press(k);
    await p2.focus('#wsHk-buy'); await press(kb); await p2.focus('#wsHk-sell'); await press(ks);
    await until(async () => (await deskDoc()).keys.sell === ks && await p2.inputValue('#wsHk-sell') === ks, `try ${rep}: Sell MKT's key saved`);
    await wait(500);
    d = await deskDoc();
    check(d.keys.buy === kb && d.keys.sell === ks, `try ${rep}: Buy MKT ${kb} then Sell MKT ${ks} at once: The Desk has both (buy ${d.keys.buy || 'none'}, sell ${d.keys.sell || 'none'})`);
    check(await p2.inputValue('#wsHk-buy') === kb && await p2.inputValue('#wsHk-sell') === ks, `try ${rep}: and Settings shows both`);
    check(!/another PC saved/.test(await p2.textContent('#wsSettings')), `try ${rep}: no "another PC saved first" note (there is no other PC)`);
  }
  await p2.screenshot({ path: path.join(out, 'quality-hotkeys-saved-1366.png') });
  await ctx2.close();
} catch (e) {
  fail('smoke threw: ' + (e && e.stack || e));
} finally {
  await browser.close();
  if (bridge) bridge.kill();
  if (desk) await desk.close().catch(() => {});
}
console.log(checks + ' checks, ' + errors.length + ' failed');
process.exit(errors.length ? 1 : 0);
