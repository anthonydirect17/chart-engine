// Chart 1.34.0 smoke (Anthony 2026-10-20): Screens and the one PIN. Against the fake bridge with a made-up test PIN (sample data;
// nothing reaches a broker), at 1366 x 768:
//   npm run smoke:screens       (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
// Checks: a window opened by hand asks for the PIN; Save these screens keeps every workspace window open now; with one closed,
// the Screens button says so and Open my screens opens it, unlocked by the opening window's PIN (no pad); a reload of it asks
// for the PIN again; a window that names itself like one but was not opened by Open my screens gets nothing and asks.
// Screenshot test/out/screens-pop-1366.png.
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
} catch (e) { fail('threw: ' + (e && e.stack || e)); }
finally { await browser.close(); bridge.kill(); }
console.log(errors.length ? errors.length + ' FAILED' : 'screens smoke: all passed');
process.exit(errors.length ? 1 : 0);
