// "Update ready: reload when flat" smoke (live/update-notice.js, the per-PC updater nt8/update-pc.ps1): the page
// laid out as the updater installs it (nt8/install-files.json), served by the fake bridge with trading on and an
// open position, and www/update.json written the way the updater writes it. Checks: nothing shows while the build is
// the one the page loaded; a new build shows the notice on the status line and the page never reloads by itself; the
// notice covers neither the order bar nor the chart, and neither moves; the ChartBridge ready and copied notes; a
// page opened after an install shows nothing, one opened during an install shows the notice; no update.json, no
// notice and no error. Sample data only; nothing reaches a broker. Screenshots in test/out/.
//   npm run smoke:update        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const PORT = +(process.env.UPDATE_SMOKE_PORT || 8793);
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };

// The www folder as the updater lays it out, under the fake bridge's /live/ (index.html's ../src/ is the root's src/).
const serve = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-update-smoke-'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'nt8', 'install-files.json'), 'utf8'));
for (const f of manifest.www) {
  const dest = f.to.startsWith('src/') ? path.join(serve, f.to) : path.join(serve, 'live', f.to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, f.from), dest);
}
const updateJson = path.join(serve, 'live', 'update.json');
const writeUpdate = (build, installedAt, cb = {}) => fs.writeFileSync(updateJson, JSON.stringify({ schema: 1,
  page: { version: '1.6.0', build, commit: 'c'.repeat(40), installedAt }, chartBridge: Object.assign({ compiled: '0.3.3', ready: null, copied: null }, cb) }, null, 2));
writeUpdate('build-a', 0);

const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--serve-root=' + serve, '--trading', '--trade-accounts=Sim101', '--pin-off', '--test-controls'],
  { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const control = async (what, q = {}) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q), { method: 'POST' })).json();
const URL_ = `http://localhost:${PORT}/live/`;

async function open(browser, width) {
  const page = await browser.newPage({ viewport: { width, height: 860 } });
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fail('console: ' + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto(URL_);
  await page.waitForFunction(() => document.getElementById('connPill')?.textContent === 'LIVE', null, { timeout: 15000 });
  return page;
}
const note = async page => { await page.waitForSelector('#updNote', { state: 'attached', timeout: 5000 }).catch(() => {}); return page.evaluate(() => { const n = document.getElementById('updNote'); return n ? { hidden: n.hidden, text: n.textContent, inFooter: !!n.closest('footer.status') } : null; }); };
const boxes = page => page.evaluate(() => {
  const r = el => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
  return { note: r(document.getElementById('updNote')), obar: r(document.getElementById('obar')), stage: r(document.querySelector('.stage')), canvas: r(document.querySelector('.stage canvas')) };
});
const overlap = (a, b) => !!a && !!b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const same = (a, b) => !!a && !!b && ['x', 'y', 'w', 'h'].every(k => Math.abs(a[k] - b[k]) < 0.5);
async function poll(page) { await page.evaluate(() => window.ChartUpdateNotice.checkNow()); await page.waitForTimeout(150); }
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await new Promise(r => setTimeout(r, 150)); }
}

let browser = null;
try {
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await open(browser, 1440);
  let navigations = 0;
  page.on('framenavigated', f => { if (f === page.mainFrame()) navigations++; });
  await page.waitForSelector('#obar:not([hidden])', { timeout: 10000 });
  // an open position (placed in NinjaTrader itself): LONG 1 in the order bar
  await control('elsewhere', { account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'market', qty: 1 });
  await until(async () => (await page.textContent('#oPos')).startsWith('LONG 1'), 'position LONG 1 in the order bar');
  await page.evaluate(() => { window.__loadedOnce = 'yes'; });
  await poll(page);
  const n0 = await note(page);
  check(n0 && n0.inFooter && n0.hidden, 'the same build as loaded: nothing shown (the notice waits on the status line)');
  const before = await boxes(page);

  writeUpdate('build-b', Date.now());
  await poll(page);
  const n1 = await note(page);
  check(n1 && !n1.hidden && n1.text === 'Update ready: reload when flat', 'a new build: "Update ready: reload when flat" (' + (n1 && n1.text) + ')');
  check(await page.evaluate(() => { const n = document.getElementById('updNote'); return n.scrollWidth <= n.clientWidth + 1 && n.clientWidth > 0; }), '1440 px: the notice is shown whole');
  const after = await boxes(page);
  check(!overlap(after.note, after.obar), 'the notice does not cover the order bar');
  check(!overlap(after.note, after.stage) && !overlap(after.note, after.canvas), 'the notice does not cover the chart');
  check(same(before.obar, after.obar) && same(before.stage, after.stage), 'the order bar and the chart did not move');
  check((await page.textContent('#oPos')).startsWith('LONG 1'), 'the open position is still shown');
  check(await page.evaluate(() => window.__loadedOnce) === 'yes' && navigations === 0, 'the page did not reload itself');
  const styles = await page.evaluate(() => { const s = getComputedStyle(document.getElementById('updNote')); return s.position + ' ' + s.zIndex; });
  check(/^(static|relative) /.test(styles), 'the notice sits in the flow of the status line, not over anything (' + styles + ')');
  await page.screenshot({ path: path.join(out, 'update-notice-1440.png'), clip: { x: 0, y: 760, width: 1440, height: 100 } });

  const whole = pg => pg.evaluate(() => { const n = document.getElementById('updNote'); return n.scrollWidth <= n.clientWidth + 1; });
  writeUpdate('build-b', Date.now() - 1000, { ready: '0.3.4' });
  await poll(page);
  const n2 = await note(page);
  check(n2 && /^Update ready.* · ChartBridge 0\.3\.4 ready/.test(n2.text) && await whole(page), '1440 px: ChartBridge ready, in the form that fits: ' + (n2 && n2.text));
  check(/ChartBridge 0\.3\.4 ready to install \(flat, then F5\)/.test(await page.getAttribute('#updNote', 'title')), 'the tooltip has the whole text');
  const wide = await open(browser, 1920);
  await poll(wide);
  const w1 = await note(wide);
  check(w1 && w1.text === 'ChartBridge 0.3.4 ready to install (flat, then F5)' && await whole(wide), '1920 px, a page opened after the install: "ChartBridge 0.3.4 ready to install (flat, then F5)" (' + (w1 && w1.text) + ')');
  await wide.close();
  writeUpdate('build-b', Date.now() - 1000, { copied: '0.3.4' });
  await poll(page);
  const n3 = await note(page);
  check(n3 && /ChartBridge 0\.3\.4(: F5 when flat| copied: press F5 when flat)$/.test(n3.text) && await whole(page), 'ChartBridge copied, waiting for F5: ' + (n3 && n3.text));
  check(same(before.obar, (await boxes(page)).obar) && same(before.stage, (await boxes(page)).stage), 'still nothing moved with the longer notice');
  await page.screenshot({ path: path.join(out, 'update-notice-1440-chartbridge.png'), clip: { x: 0, y: 760, width: 1440, height: 100 } });
  // the page's own minute: it polls by itself (no test hook) and still never reloads
  check(await page.evaluate(() => window.__loadedOnce) === 'yes' && navigations === 0, 'still no reload');

  // a page opened after the install: nothing to say; one opened while files were being installed: the notice
  writeUpdate('build-c', Date.now() - 60000);
  const fresh = await open(browser, 1024);
  await poll(fresh);
  const f1 = await note(fresh);
  check(f1 && f1.hidden, 'a page opened after the install shows nothing');
  const bx = await boxes(fresh);
  if (bx.obar && bx.note) check(!overlap(bx.note, bx.obar), '1024 px: the notice spot is off the order bar');
  await fresh.close();
  writeUpdate('build-d', Date.now() + 5000);           // installed after this page began loading
  const during = await open(browser, 1024);
  await poll(during);
  await during.waitForTimeout(2500);                  // fonts and status messages settle; the notice fits again
  const f2 = await note(during);
  check(f2 && !f2.hidden && /^Update ready(: reload when flat)?$/.test(f2.text), 'a page that loaded during an install shows the notice (' + (f2 && f2.text) + ')');
  check(await during.evaluate(() => { const n = document.getElementById('updNote'); return n.scrollWidth <= n.clientWidth + 1 && /reload when flat/.test(n.title); }), '1024 px: shown whole (the short form when the room is short; the tooltip has it all)');
  const b2 = await boxes(during);
  check(!overlap(b2.note, b2.obar) && !overlap(b2.note, b2.stage), '1024 px: the notice covers neither the order bar nor the chart');
  await during.screenshot({ path: path.join(out, 'update-notice-1024.png') });
  await during.close();

  // no update.json (a PC without the updater): no notice, no error
  fs.rmSync(updateJson);
  const none = await open(browser, 1440);
  await poll(none);
  const f3 = await note(none);
  check(f3 && f3.hidden, 'no update.json: nothing shown');
  await none.close();
} catch (e) {
  fail('smoke crashed: ' + (e && e.stack || e));
} finally {
  if (browser) await browser.close();
  bridge.kill();
  fs.rmSync(serve, { recursive: true, force: true });
}
console.log(errors.length ? `update notice smoke: ${errors.length} FAILED of ${checks}` : `update notice smoke: ${checks} checks passed`);
process.exit(errors.length ? 1 : 0);
