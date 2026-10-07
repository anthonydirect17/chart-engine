// The Quote board's markets menu (chart 1.16.0, Anthony 2026-10-07: "we should be able to hide instruments from the quote
// board"), in Chromium, against the fake bridge with ChartBridge 0.4.0's quote-only markets (--v3; sample data only):
//   - each board's header menu lists every row it can show (NQ, ES, then the quote-only markets hello lists), checked;
//   - hiding YM and ZN on one board hides them there only; the other board keeps all ten;
//   - a reload keeps them hidden (saved with the layout, panel.hide); checking one again shows it;
//   - every row hidden: the board says "No markets shown: pick some in the menu".
//   npm run smoke:quoterows        (CHROMIUM_PATH=/path/to/chrome; QUOTEROWS_SMOKE_PORT)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const PORT = +(process.env.QUOTEROWS_SMOKE_PORT || 8981);
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms) {
  const end = Date.now() + (ms || 15000);
  for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); }
}
const ALL = 'NQ,ES,YM,RTY,GC,SI,CL,6E,ZN,ZB';
const LAYOUT = { Main: { panels: [
  { id: 'c1', type: 'chart', root: 'MNQ', tf: 'm1', x: 0, y: 0, w: 6, h: 6 },
  { id: 'q1', type: 'quotes', x: 6, y: 0, w: 3, h: 6 }, { id: 'q2', type: 'quotes', x: 9, y: 0, w: 3, h: 6 }] } };

const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--data-037', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const rowsOf = (p, id) => p.$$eval(`.ws-panel[data-id="${id}"] [data-root]`, els => els.map(e => e.dataset.root).join());
const saved = p => p.evaluate(() => { const s = JSON.parse(localStorage.getItem('live-workspace-v1')); return Object.fromEntries(s.layouts.Main.panels.filter(x => x.type === 'quotes').map(x => [x.id, x.hide || null])); });
const menu = async (p, id) => { await p.click(`.ws-panel[data-id="${id}"] [data-act="qbrows"]`); await p.waitForSelector('#wsQbRows:not([hidden])'); };
const picks = p => p.$$eval('#wsQbRows input[data-qroot]', els => els.map(e => e.dataset.qroot + (e.checked ? '+' : '-')).join());
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(l => { try { if (!localStorage.getItem('live-workspace-v1')) localStorage.setItem('live-workspace-v1', JSON.stringify({ v: 1, layouts: l })); } catch (e) { /* blocked */ } }, LAYOUT);
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  const load = async () => {
    await page.goto(`http://localhost:${PORT}/live/?layout=Main`);
    await page.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(page, TEST_PIN);
    await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 40000 });
  };
  await load();
  await until(async () => (await rowsOf(page, 'q1')) === ALL && (await rowsOf(page, 'q2')) === ALL, 'both boards show every row');
  check(true, 'default: every row shown on both boards (' + ALL + ')');
  await menu(page, 'q1');
  check((await picks(page)) === ALL.split(',').map(r => r + '+').join(), 'the menu lists every row it can show, each checked: ' + await picks(page));
  await page.click('#wsQbRows input[data-qroot="YM"]'); await page.click('#wsQbRows input[data-qroot="ZN"]'); await wait(300);
  await page.screenshot({ path: path.join(out, 'quoterows-menu.png') });
  await page.keyboard.press('Escape'); await wait(200);
  check((await rowsOf(page, 'q1')) === 'NQ,ES,RTY,GC,SI,CL,6E,ZB', 'YM and ZN hidden on that board: ' + await rowsOf(page, 'q1'));
  check((await rowsOf(page, 'q2')) === ALL, 'the other board keeps every row');
  check(JSON.stringify(await saved(page)) === '{"q1":["YM","ZN"],"q2":null}', 'saved with the layout: ' + JSON.stringify(await saved(page)));
  await load();
  await until(async () => (await rowsOf(page, 'q2')) === ALL, 'the reload');
  check((await rowsOf(page, 'q1')) === 'NQ,ES,RTY,GC,SI,CL,6E,ZB', 'after a reload: still hidden (' + await rowsOf(page, 'q1') + ')');
  await menu(page, 'q1');
  check(/YM-/.test(await picks(page)) && /ZN-/.test(await picks(page)) && /ES\+/.test(await picks(page)), 'the menu shows them unchecked: ' + await picks(page));
  await page.click('#wsQbRows input[data-qroot="YM"]'); await wait(300); await page.keyboard.press('Escape');
  check((await rowsOf(page, 'q1')) === 'NQ,ES,YM,RTY,GC,SI,CL,6E,ZB' && JSON.stringify((await saved(page)).q1) === '["ZN"]', 'checked again: YM back in its place');
  // every row hidden on the other board: it says so
  await menu(page, 'q2');
  for (const r of ALL.split(',')) await page.click(`#wsQbRows input[data-qroot="${r}"]`);
  await page.keyboard.press('Escape'); await wait(300);
  check((await rowsOf(page, 'q2')) === '' && /No markets shown: pick some in the menu/.test(await page.textContent('.ws-panel[data-id="q2"]')), 'none shown: "No markets shown: pick some in the menu"');
  check(await page.evaluate(() => { const b = document.querySelector('.ws-panel[data-id="q1"] .ws-body'); return b.scrollHeight <= b.clientHeight + 1; }), 'the board does not scroll');
  await page.screenshot({ path: path.join(out, 'quoterows.png') });
  await ctx.close();
} catch (e) {
  fail('smoke threw: ' + (e && e.stack || e));
} finally {
  await browser.close();
  bridge.kill();
}
console.log(checks + ' checks, ' + errors.length + ' failed');
process.exit(errors.length ? 1 : 0);
