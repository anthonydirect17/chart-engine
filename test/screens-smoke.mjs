// Chart 1.34.0 smoke (Anthony 2026-10-20): Screens and the one PIN. Against the fake bridge with a made-up test PIN (sample data;
// nothing reaches a broker), at 1366 x 768:
//   npm run smoke:screens       (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
// Checks: a window opened by hand asks for the PIN; Save these screens keeps every workspace window open now; with one closed,
// the Screens button says so and Open my screens opens it, unlocked by the opening window's PIN (no pad); a reload of it asks
// for the PIN again; a window that names itself like one but was not opened by Open my screens gets nothing and asks.
// 1.35.0: Brave with Shields up (made-up window places): the popover says what to allow and Save refuses.
// Screenshots test/out/screens-pop-1366.png, test/out/screens-brave-1366.png.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const PORT = +(process.env.SCREENS_SMOKE_PORT || 8797);
const errors = [];
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, what, ms) => { const end = Date.now() + (ms || 10000); for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); } };
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--trading', '--test-controls', '--trade-accounts=Sim101', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const live = p => p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && !document.querySelector('.cb-pin'), null, { timeout: 30000 });
const padShows = p => p.waitForSelector('.cb-pin-key', { timeout: 15000 }).then(() => true, () => false);
const popText = p => p.$eval('#wsScreensPop', e => e.innerText);
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const errs = p => p.on('pageerror', e => fail('pageerror (' + p.url() + '): ' + e.message));
  const p = await ctx.newPage(); errs(p);
  await p.goto(`http://localhost:${PORT}/live/?layout=Main`);
  check(await padShows(p), 'the first window asks for the PIN');
  await enterPin(p, TEST_PIN); await live(p);
  const p2 = await ctx.newPage(); errs(p2);
  await p2.goto(`http://localhost:${PORT}/live/?layout=Second`);
  check(await padShows(p2), 'a window opened by hand (a typed address, a bookmark) asks for the PIN too');
  await enterPin(p2, TEST_PIN); await live(p2);
  /* Save these screens: both windows */
  await p.click('#wsScreens');
  await until(() => p.$eval('#wsScreensPop', e => !e.hidden), 'the Screens popover');
  check(/No screens saved yet/.test(await popText(p)), 'nothing saved yet: the popover says how');
  await p.click('#wsScreensPop [data-scr="save"]');
  const saved = await until(async () => { const t = await popText(p); return /Saved 2 windows: Main, Second\./.test(t) ? t : null; }, 'saved');
  check(!!saved && /Main[\s\S]*open[\s\S]*Second[\s\S]*open/.test(saved), 'Save these screens: both windows kept, both open: ' + JSON.stringify(saved));
  /* one closed: the button says so; Open my screens opens it, unlocked, no pad */
  await p2.close();
  await p.click('#wsScreens'); await wait(200);   // closes
  await p.click('#wsScreens');
  const t1 = await until(async () => { const t = await popText(p); return /\nSecond\n[^\n]*\nnot open\n/.test(t) ? t : null; }, 'Second not open');
  check(!!t1 && (await p.$eval('#wsScreens', b => b.classList.contains('ws-scr-due'))), 'with Second closed: the popover and the button say it is not open');
  await p.screenshot({ path: path.join(out, 'screens-pop-1366.png') });
  const popP = ctx.waitForEvent('page', { timeout: 15000 });
  await p.click('#wsScreensPop [data-scr="open"]');
  const c = await popP; errs(c);
  let pad = false;
  c.on('framenavigated', () => {});
  const sawPad = c.waitForSelector('.cb-pin-key', { timeout: 6000 }).then(() => { pad = true; }, () => {});
  await live(c).catch(e => fail('the opened window did not come live: ' + e.message));
  await sawPad;
  check(!pad && /layout=Second/.test(c.url()), 'Open my screens: Second opens, unlocked by this window\'s PIN (no pad): ' + c.url());
  check((await c.evaluate(() => window.name)) === '', 'its one-time code is spent (its name cleared)');
  const msg = await until(async () => { const t = await popText(p); return /Opened Second\./.test(t) ? t : null; }, 'Opened Second');
  check(!!msg, 'the popover says what it opened: ' + JSON.stringify(msg && msg.split('\n').filter(l => /Opened/.test(l))));
  /* a reload asks again */
  await c.reload();
  check(await padShows(c), 'a reload of the opened window asks for the PIN');
  await c.close();
  /* a window named like one, but not opened by Open my screens: nothing given */
  const fakeP = ctx.waitForEvent('page', { timeout: 15000 });
  await p.evaluate(port => { window.open('http://localhost:' + port + '/live/?layout=Second', 'cbw-' + '0'.repeat(32), 'popup,width=900,height=700'); }, PORT);
  const f = await fakeP; errs(f);
  check(await padShows(f), 'a window with a made-up code (not opened by Open my screens) gets no unlock: the PIN pad');
  await f.close();
  await ctx.close();

  /* 1.35.0: Brave with Shields up (fingerprinting blocked): the window's place is made up (brave-core 13737), so the popover
     says why every window opens on the main screen and exactly what to allow, and Save refuses the made-up places */
  const bctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await bctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await bctx.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'brave', { get: () => ({ isBrave: () => Promise.resolve(true) }), configurable: true });
    const def = (o, k, f) => Object.defineProperty(o, k, { get: f, configurable: true });
    def(window, 'screenX', () => 5); def(window, 'screenY', () => 3); def(window, 'outerHeight', () => window.innerHeight + 3);
    def(Screen.prototype, 'width', () => window.innerWidth + 2); def(Screen.prototype, 'height', () => window.innerHeight + 4);
    def(Screen.prototype, 'availLeft', () => 2); def(Screen.prototype, 'availTop', () => 7);
  });
  const b = await bctx.newPage(); errs(b);
  await b.goto(`http://localhost:${PORT}/live/?layout=Main`);
  await padShows(b); await enterPin(b, TEST_PIN); await live(b);
  await b.click('#wsScreens');
  const bt = await until(async () => { const t = await popText(b); return /Brave's Shields are hiding where this window is/.test(t) ? t : null; }, 'the Brave note');
  check(!!bt && /it reports 5, 3/.test(bt) && /Shields icon \(the lion\)/.test(bt) && /Allow all fingerprinting/.test(bt) && /Window management: Allow/.test(bt) && /Pop-ups and redirects: Allow/.test(bt),
    'Brave Shields: the popover says why every window opens on the main screen and exactly what to allow');
  await b.click('#wsScreensPop [data-scr="save"]');
  const nt = await until(async () => { const t = await popText(b); return /Not saved: the browser is hiding where the windows are/.test(t) ? t : null; }, 'not saved');
  check(!!nt, 'Save refuses the made-up places');
  await b.screenshot({ path: path.join(out, 'screens-brave-1366.png') });
  await bctx.close();
} catch (e) { fail('threw: ' + (e && e.stack || e)); }
finally { await browser.close(); bridge.kill(); }
console.log(errors.length ? errors.length + ' FAILED' : 'screens smoke: all passed');
process.exit(errors.length ? 1 : 0);
