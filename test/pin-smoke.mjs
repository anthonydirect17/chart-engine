// PIN smoke test (ChartBridge 0.3.2): drives ChartBridge's own page in Chromium against the fake bridge with a pin
// file, the way Anthony uses it: set a PIN (keyboard), nothing streams before; reload asks again; wrong PINs (20 in
// a row) never block the right one; a ChartBridge restart mid-session keeps the open page unlocked and trading;
// change the PIN; a phone-sized page with touch; the forgotten-PIN recovery (delete the pin file). Made-up PINs
// only; sample data; nothing reaches a broker. Screenshots in test/out/ (and SHOTS_DIR when set).
//   npm run smoke:pin        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const SHOTS = process.env.SHOTS_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const PORT = +(process.env.PIN_SMOKE_PORT || 8785);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-pin-smoke-'));
const PIN_FILE = path.join(dir, 'pin.txt');
const FIRST = '1357', SECOND = '8024', THIRD = '5091';          // made-up PINs, tests only
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
let bridge = null;

async function startBridge() {
  const child = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--pin-file=' + PIN_FILE, '--trading', '--trade-accounts=Sim101', '--test-controls'],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => child.stdout.once('data', r));
  return child;
}
const control = async what => (await fetch(`http://127.0.0.1:${PORT}/test/${what}`, { method: 'POST' })).json();
const diag = async () => (await fetch(`http://127.0.0.1:${PORT}/diag`)).json();
async function shot(page, name) {
  const file = path.join(out, name);
  await page.screenshot({ path: file });
  if (SHOTS) fs.copyFileSync(file, path.join(SHOTS, name));
}
async function until(fn, what, ms) {
  const end = Date.now() + (ms || 8000);
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) { fail('timed out: ' + what); return null; }
    await new Promise(r => setTimeout(r, 100));
  }
}
// every WebSocket the page opens (the unlock token masked) and every time the PIN pad appears
function spies() {
  window.__ws = [];
  const Real = window.WebSocket;
  const Spy = function (u, p) { window.__ws.push(String(u).replace(/unlock=[^&]*/, 'unlock=*')); return p === undefined ? new Real(u) : new Real(u, p); };
  Spy.prototype = Real.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Spy[k] = Real[k];
  window.WebSocket = Spy;
  window.__pinShown = 0;
  new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.classList && n.classList.contains('cb-pin')) window.__pinShown++; })
    .observe(document, { childList: true, subtree: true });
}
const title = p => p.textContent('#cbPinTitle').catch(() => null);
const msg = p => p.textContent('#cbPinMsg').catch(() => null);
const pill = p => p.evaluate(() => { const el = document.getElementById('connPill'); return el ? el.textContent : null; });
const notBusy = p => p.waitForFunction(() => !document.querySelector('.cb-pin-busy'), null, { timeout: 10000 });
async function typePin(p, pin) { await p.keyboard.type(pin); await notBusy(p); }
const storedAnywhere = p => p.evaluate(() => JSON.stringify(Object.entries(localStorage)) + JSON.stringify(Object.entries(sessionStorage)) + document.cookie + location.href);
const noSideScroll = async (p, w, what) => check(await p.evaluate(() => document.documentElement.scrollWidth) <= w, w + ' px: no sideways scroll (' + what + ')');

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  bridge = await startBridge();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(spies);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|WebSocket connection/.test(m.text())) fail('console: ' + m.text()); });

  /* ---------------- 1. no PIN on this PC: "Set a PIN", nothing streams, no order UI */
  await page.goto(`http://localhost:${PORT}/live/single.html`);
  await until(async () => await title(page) === 'Set a PIN', '"Set a PIN" shown');
  await page.waitForTimeout(800);
  check(!(await page.$('#connPill')) && !(await page.$('#obar')) && !(await page.$('#chart')), 'no PIN set: no chart, no order bar, nothing behind the pad');
  check(await page.evaluate(() => window.__ws.length) === 0 && (await diag()).clients === 0, 'no PIN set: no WebSocket opened, ChartBridge has no client');
  check(await page.evaluate(async () => (await fetch('/session')).status) === 403, 'no PIN set: GET /session refused');
  check(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('cb-pin-card')), 'the pad has the keyboard focus');
  await shot(page, 'pin-set-1440.png');

  // keyboard: two different PINs are refused, then the same one twice sets it
  await page.keyboard.type(FIRST);
  check(await title(page) === 'Enter it again', 'set: asks for the PIN again');
  await typePin(page, '1358');
  check(await title(page) === 'Set a PIN' && /did not match/.test(await msg(page)) && !fs.existsSync(PIN_FILE), 'set: two different PINs are refused, nothing saved');
  await shot(page, 'pin-set-mismatch.png');
  await page.keyboard.type('139');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('57');                                        // 13, 9 deleted, 57: the first PIN
  await typePin(page, FIRST);
  await until(async () => await pill(page) === 'LIVE', 'live after setting the PIN', 15000);
  check(!(await page.$('.cb-pin')), 'set: the pad is gone, the chart is live');
  await until(() => page.evaluate(() => !document.getElementById('obar').hidden && !document.getElementById('buyMkt').disabled), 'trading after set');
  check(await page.getAttribute('#armBtn', 'aria-checked') === 'false', 'Armed off after the unlock');
  const fileText = fs.readFileSync(PIN_FILE, 'utf8');
  check(/^v1 pbkdf2-sha256 50000 [0-9a-f]{32} [0-9a-f]{64} [0-9a-f]{64}$/m.test(fileText) && !fileText.replace(/[0-9a-f]{32,}/g, '').includes(FIRST), 'the pin file holds a salted hash, never the PIN');
  check(!/v1\.[0-9a-f]{32}\.[0-9a-f]{64}/.test(await storedAnywhere(page)), 'the unlock is not in localStorage, sessionStorage, a cookie or the URL');
  check(await page.isVisible('#pinBtn'), 'the PIN button shows in the toolbar');
  await shot(page, 'pin-unlocked-1440.png');

  /* ---------------- 2. reload: the PIN again (memory only); wrong PINs never block the right one */
  await page.reload();
  await until(async () => await title(page) === 'Enter PIN', 'reload asks for the PIN');
  await page.waitForTimeout(600);
  check(await page.evaluate(() => window.__ws.length) === 0 && !(await page.$('#connPill')), 'reload: locked, no WebSocket opened');
  await until(async () => (await diag()).clients === 0, 'the old page\'s WebSocket is gone');
  await typePin(page, '0000');
  check(/Wrong PIN/.test(await msg(page)) && await title(page) === 'Enter PIN', 'a wrong PIN is refused');
  await shot(page, 'pin-unlock-wrong.png');
  let refused = 0;
  for (let i = 0; i < 20; i++) { await typePin(page, i % 2 ? '1375' : '9999'); if (/Wrong PIN/.test(await msg(page)) && await title(page) === 'Enter PIN') refused++; }
  check(refused === 20, '20 wrong PINs in a row, each refused (' + refused + ')');
  const t0 = Date.now();
  await typePin(page, FIRST);
  await until(async () => await pill(page) === 'LIVE', 'live after the right PIN', 15000);
  check(Date.now() - t0 < 5000, 'then the right PIN opens at once (' + (Date.now() - t0) + ' ms), nothing blocked');

  /* ---------------- 3. ChartBridge restarts mid-session: the open page stays unlocked and trading */
  await until(() => page.evaluate(() => !document.getElementById('buyMkt').disabled), 'trading after unlock');
  await control('hold?root=MNQ');
  await page.click('#armBtn');
  await page.click('#buyMkt');
  await until(async () => (await page.textContent('#oPos')).startsWith('LONG 1'), 'a position is open');
  const shownBefore = await page.evaluate(() => window.__pinShown);
  check(shownBefore === 1, 'the pad spy works: it saw this page\'s one unlock pad (' + shownBefore + ')');
  bridge.kill();
  await until(async () => await pill(page) === 'OFFLINE', 'offline while ChartBridge is down');
  check(await page.getAttribute('#armBtn', 'aria-checked') === 'false', 'restart: Armed off while disconnected (unchanged rule)');
  await page.waitForTimeout(2500);                                      // the page keeps retrying meanwhile
  check(!(await page.$('.cb-pin')), 'restart: while ChartBridge is down the page is not sent back to the PIN');
  bridge = await startBridge();
  await until(async () => await pill(page) === 'LIVE', 'live again after the restart', 20000);
  await until(() => page.evaluate(() => !document.getElementById('buyMkt').disabled), 'trading again after the restart (new order token)', 10000);
  check(await page.evaluate(() => window.__pinShown) === shownBefore && !(await page.$('.cb-pin')), 'restart: the PIN pad never showed');
  const rec = await control('received');
  check(rec.sessionRequests >= 1 && rec.urls.some(u => /unlock=\(hidden\)/.test(u)), 'restart: signed in again with the unlock held in memory (GET /session ' + rec.sessionRequests + ', WebSocket with ?unlock)');
  await page.click('#armBtn');
  await page.click('#buyMkt');
  await until(async () => (await page.textContent('#oPos')).startsWith('LONG'), 'an order after the restart fills');
  await page.click('#flattenBtn');
  await until(async () => (await page.textContent('#oPos')) === 'Flat', 'flatten after the restart');
  await page.click('#armBtn');
  await shot(page, 'pin-after-restart.png');

  /* ---------------- 4. change the PIN: the current one first; the page stays live */
  await page.click('#pinBtn');
  await until(async () => await title(page) === 'Current PIN', 'change dialog');
  check(await pill(page) === 'LIVE', 'change: the chart keeps streaming behind the dialog');
  await shot(page, 'pin-change.png');
  await page.keyboard.press('Escape');
  check(!(await page.$('.cb-pin')), 'change: Escape cancels');
  await page.click('#pinBtn');
  await until(async () => await title(page) === 'Current PIN', 'change dialog again');
  await typePin(page, '0000');
  check(/current PIN is wrong/.test(await msg(page)) && await title(page) === 'Current PIN', 'change: a wrong current PIN is refused');
  const hashBefore = fs.readFileSync(PIN_FILE, 'utf8');
  await typePin(page, FIRST);
  check(await title(page) === 'New PIN', 'change: then the new PIN');
  await typePin(page, SECOND);
  await typePin(page, '8025');
  check(await title(page) === 'New PIN' && /did not match/.test(await msg(page)), 'change: new PINs that differ are refused');
  await typePin(page, SECOND);
  await typePin(page, SECOND);
  await until(async () => !(await page.$('.cb-pin')), 'change done');
  check(fs.readFileSync(PIN_FILE, 'utf8') !== hashBefore && await pill(page) === 'LIVE', 'change: saved, the page stays live');
  check(/PIN changed/.test(await page.textContent('.cb-pin-toast').catch(() => '')), 'change: a short note says so');

  /* ---------------- 5. a phone-sized page with touch: the new PIN, the old one refused */
  const phoneCtx = await browser.newContext({ viewport: { width: 400, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await phoneCtx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const phone = await phoneCtx.newPage();
  phone.on('pageerror', e => fail('phone pageerror: ' + e.message));
  await phone.goto(`http://localhost:${PORT}/live/single.html`);
  await until(async () => await title(phone) === 'Enter PIN', 'phone: PIN pad');
  await noSideScroll(phone, 400, 'PIN pad');
  const keys = await phone.locator('.cb-pin-key').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return [r.width, r.height]; }));
  check(keys.length === 12 && keys.every(([w, h]) => w >= 44 && h >= 44), 'phone: 12 keys, each at least 44 px: ' + JSON.stringify(keys.slice(0, 3)));
  await shot(phone, 'pin-phone.png');
  for (const d of FIRST) await phone.locator(`.cb-pin-key[data-k="${d}"]`).tap();
  await notBusy(phone);
  check(/Wrong PIN/.test(await msg(phone)), 'phone: the old PIN is refused after the change');
  for (const d of SECOND) await phone.locator(`.cb-pin-key[data-k="${d}"]`).tap();
  await until(async () => await pill(phone) === 'LIVE', 'phone: the new PIN opens (touch)', 15000);
  await noSideScroll(phone, 400, 'chart');
  await phoneCtx.close();

  /* ---------------- 5b. review S2: /pin/status answering 500 on a reconnect keeps the page LIVE and unlocked */
  const shown5 = await page.evaluate(() => window.__pinShown);
  await page.route('**/pin/status', r => r.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"reason":"test 500"}' }));
  await control('drop');
  await until(async () => await pill(page) === 'LIVE' && await page.evaluate(() => window.__ws.length) > 0, 'live again after a drop with /pin/status answering 500', 15000);
  await page.waitForTimeout(800);
  check(await pill(page) === 'LIVE' && !(await page.$('.cb-pin')) && await page.evaluate(() => window.__pinShown) === shown5 && await page.evaluate(() => window.ChartBridgePin.active()),
    '/pin/status 500 on a reconnect: the page stays LIVE and unlocked, no pad');
  await page.unroute('**/pin/status');

  /* ---------------- 5c. review S3: GET /session refused once after a reconnect: it asks again and trading comes back */
  let sessionRefusals = 0;
  await page.route('**/session', r => { if (sessionRefusals < 1) { sessionRefusals++; return r.fulfill({ status: 403, body: '' }); } return r.continue(); });
  await control('drop');
  await until(async () => /Signing in to ChartBridge for orders again/.test(await page.textContent('#oOff')), 'a refused sign-in says it tries again', 15000);
  await until(() => page.evaluate(() => !document.getElementById('buyMkt').disabled), 'trading back after the sign-in retry', 10000);
  check(sessionRefusals === 1 && !(await page.$('.cb-pin')), 'a refused GET /session is retried after a status check; trading comes back with no pad');
  await page.unroute('**/session');

  /* ---------------- 5d. review B1: a damaged pin file never offers "Set a PIN" and never throws an open page out */
  const goodPin = fs.readFileSync(PIN_FILE, 'utf8');
  fs.writeFileSync(PIN_FILE, goodPin.slice(0, goodPin.length - 40));                      // torn after a good read
  await control('drop');
  await until(async () => await pill(page) === 'LIVE', 'live after a drop with a torn pin file (the copy read earlier)', 15000);
  check(!(await page.$('.cb-pin')) && await page.evaluate(() => window.ChartBridgePin.active()), 'torn pin file: the open page reconnects, unlocked, no pad');
  const other = await ctx.newPage();
  await other.goto(`http://localhost:${PORT}/live/single.html`);
  await until(async () => await title(other) === 'Enter PIN', 'a new page with a torn pin file asks for the PIN');
  check(await other.evaluate(async () => (await fetch('/pin/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"pin":"0000"}' })).status) === 409,
    'torn pin file: "Enter PIN", not "Set a PIN"; setting a new PIN is refused (409)');
  await other.close();
  // a restarted bridge that starts with the damaged file (no good copy): the page keeps its unlock and recovers alone
  bridge.kill();
  await until(async () => await pill(page) === 'OFFLINE', 'offline for the restart with a torn pin file');
  bridge = await startBridge();
  await page.waitForTimeout(4000);
  check(!(await page.$('.cb-pin')) && await page.evaluate(() => window.ChartBridgePin.active()) && await pill(page) !== 'LIVE',
    'restart with a torn pin file: ChartBridge answers 503, the page keeps its unlock (no pad) and waits');
  check(/pin\.txt/.test(await page.evaluate(() => [...document.querySelectorAll('.cb-pin-toast')].map(t => t.textContent).join(' '))), 'and says why (pin.txt)');
  await shot(page, 'pin-torn-file-waiting.png');
  fs.writeFileSync(PIN_FILE, goodPin);
  await until(async () => await pill(page) === 'LIVE', 'live again once the pin file reads, no PIN typed', 20000);
  check(!(await page.$('.cb-pin')), 'pin file readable again: the page recovers by itself, no PIN typed, no reload');
  // the pad over an open page closes by itself when the unlock holds again (the page kept its token)
  const shown5d = await page.evaluate(() => window.__pinShown);
  fs.writeFileSync(PIN_FILE, goodPin.replace(/ [0-9a-f]{64}(\s*)$/, ' ' + '1'.repeat(64) + '$1'));   // another secret: the token does not hold
  await control('drop');
  await until(async () => await title(page) === 'Enter PIN', 'the pad when ChartBridge says the unlock does not hold', 15000);
  fs.writeFileSync(PIN_FILE, goodPin);
  await until(async () => !(await page.$('.cb-pin')) && await pill(page) === 'LIVE', 'the pad closes by itself once the unlock holds again', 15000);
  check(await page.evaluate(() => window.__pinShown) === shown5d + 1, 'the pad showed once and closed by itself, no PIN typed, no reload');

  /* ---------------- 6. forgotten PIN: delete the pin file with ChartBridge running */
  fs.unlinkSync(PIN_FILE);
  await page.waitForTimeout(1500);
  check(await pill(page) === 'LIVE' && !(await page.$('.cb-pin')), 'pin file deleted: the open connection carries on');
  await control('drop');                                               // the next reconnect asks ChartBridge
  await until(async () => await title(page) === 'Set a PIN', 'after the pin file is gone, the next reconnect shows "Set a PIN"', 15000);
  check(await pill(page) !== 'LIVE' && /No PIN is set|^$/.test(await msg(page) || ''), 'forgotten PIN: locked again until a new PIN is set');
  await shot(page, 'pin-forgotten-set.png');
  await typePin(page, THIRD);
  await typePin(page, THIRD);
  await until(async () => await pill(page) === 'LIVE', 'live with the new PIN', 15000);
  check(fs.existsSync(PIN_FILE), 'a new pin file');

  await ctx.close();
} finally {
  await browser.close();
  if (bridge) bridge.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (errors.length) { console.error('FAIL (' + errors.length + ' of ' + checks + ' checks)\n' + errors.join('\n')); process.exit(1); }
console.log('pin smoke: ok (' + checks + ' checks)');
