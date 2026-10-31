// Chart 1.40.0 smoke (Sunday 11-01 item 14): ONH and ONL live overnight and locked at 9:30, drawn as IBH and IBL are, on the
// mounted chart (test/chart-host.html) against the fake bridge (sample data only, never market data). The page and the
// bridge run on a chosen New York time of day on a recent weekday, so each phase can be seen whatever the time of the run:
//   npm run smoke:onh       (CHROMIUM_PATH=/path/to/chrome for a preinstalled browser; SHOTS=dir for the screenshots)
// Checks: 3:00 ET forming (long dashes from the 18:00 bar, the same on every view and after a reload, a new high moves ONH);
// the clock crossing 9:30:00 locks them with no trade and no reload; 11:15 locked (solid, a new high no longer moves them);
// history that starts after 18:00 shows nothing and says so; a Saturday shows nothing and no note.
// Screenshots: onh-overnight-0300.png and onh-locked-1115.png in SHOTS (default test/out).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { C as H, hostUrl, waitLive } from './chart-host.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CE = require('../src/chart-engine.js'), U = CE.util;
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
const BASE_PORT = +(process.env.ONH_SMOKE_PORT || 8851);
const errors = [];
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { if (!ok) fail(m); else console.log('  ok   ' + m); };

/* Seconds to add to the real clock to stand at hh:mm:ss New York time on the most recent day that `want(day)` accepts. */
function offsetTo(hh, mm, want, ss) {
  const now = Date.now() / 1000, today = Math.floor(U.zoneSeconds(now) / 86400);
  for (let back = 1; back < 30; back++) {
    const bt = (today - back) * 86400 + hh * 3600 + mm * 60 + (ss || 0);
    if (!want(bt)) continue;
    let unix = bt - (U.zoneSeconds(now) - now);
    unix = bt - (U.zoneSeconds(unix) - unix);
    return Math.round(unix - now);
  }
  throw new Error('no day found');
}
/* a weekday whose trading day and the one before both have a regular session (a full overnight in the sample history) */
const weekday = bt => U.rthDay(bt) && U.rthDay(bt - 86400) && new Date(bt * 1000).getUTCDay() !== 1;
const saturday = bt => new Date(bt * 1000).getUTCDay() === 6;

let port = BASE_PORT;
async function startBridge(offset) {
  for (let tries = 0; tries < 6; tries++, port++) {
    const p = port;
    const b = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(p), '--pin-off', '--test-controls', '--clock-offset=' + offset], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errText = '';
    b.stderr.on('data', d => { errText += d; });
    const ok = await new Promise(res => { b.stdout.once('data', () => res(true)); b.once('exit', () => res(false)); });
    if (ok) {
      port++;
      await fetch(`http://localhost:${p}/test/hold?root=MNQ&on=1`, { method: 'POST' });   // hold the price: no new highs or lows
      return { port: p, kill: () => b.kill() };
    }
    if (!/EADDRINUSE/.test(errText)) throw new Error('bridge failed: ' + errText);
  }
  throw new Error('no free port from ' + BASE_PORT);
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
async function context(offset, opts) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(`(() => {
    const realNow = Date.now; Date.now = () => realNow() + ${offset * 1000};
    const dropBefore = ${opts && opts.dropHistoryBefore ? opts.dropHistoryBefore : 'null'};
    if (dropBefore !== null) {
      const d = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
      Object.defineProperty(WebSocket.prototype, 'onmessage', { configurable: true, get() { return d.get.call(this); }, set(fn) {
        d.set.call(this, ev => {
          if (typeof ev.data === 'string' && ev.data.startsWith('{"type":"history"')) {
            const m = JSON.parse(ev.data); m.bars = m.bars.filter(b => b[0] >= dropBefore);
            return fn({ data: JSON.stringify(m) });
          }
          return fn(ev);
        });
      } });
    }
  })();`);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  return ctx;
}
const live = p => waitLive(p, 20000).then(() => p.waitForTimeout(700));
async function openPage(ctx, url) {
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fail('console: ' + m.text()); });
  await p.goto(url);
  await live(p);
  return p;
}
const onOf = p => p.evaluate(() => window.liveChart.getLevels().filter(l => l.key === 'onh' || l.key === 'onl').map(l => ({ name: l.name, price: l.price, dash: l.dash.join('/'), from: l.from, color: l.color })));
const ibOf = p => p.evaluate(() => window.liveChart.getLevels().filter(l => l.layer === 'ib').map(l => l.name));
async function pickTf(p, text) { await p.click(`${H('tfSeg')} >> text="${text}"`); await live(p); }
const todayAt = (offset, hh, mm) => Math.floor(U.zoneSeconds(Date.now() / 1000 + offset) / 86400) * 86400 + hh * 3600 + mm * 60;
const price = (br, p) => fetch(`http://localhost:${br.port}/test/price?root=MNQ&p=${p}`, { method: 'POST' });
const shown = L => JSON.stringify(L.map(l => [l.name, l.price, l.dash]));

try {
  /* ---------------- 3:00 ET: forming */
  {
    const off = offsetTo(3, 0, weekday);
    const br = await startBridge(off);
    const ctx = await context(off);
    const p = await openPage(ctx, hostUrl(br.port));
    const on = await onOf(p);
    const from = todayAt(off, 18, 0) - 86400;
    check(on.length === 2 && on[0].name === 'ONH' && on[1].name === 'ONL' && on[0].price > on[1].price && on.every(l => l.dash === '12/5'),
      '3:00 ET: ONH and ONL live, the IB\'s long dashes: ' + shown(on));
    check(on.every(l => l.from === from), 'they start at the 18:00 bar of the evening before: ' + on.map(l => l.from).join(', ') + ' (want ' + from + ')');
    check(on.every(l => l.color === CE.LEVEL_COLORS.overnight), 'in the overnight color');
    check((await ibOf(p)).length === 0 && await p.isHidden(H('ibNote')), 'no IB yet, no note');
    for (const tf of ['5m', '15s', 'Range', '1m']) {
      await pickTf(p, tf);
      check(JSON.stringify(await onOf(p)) === JSON.stringify(on), 'the same ONH and ONL on ' + tf);
    }
    await p.reload(); await live(p);
    check(JSON.stringify(await onOf(p)) === JSON.stringify(on), 'the same after a reload (from the history alone)');
    // a new overnight high moves ONH, live
    const hi = on[0].price + 6;
    await price(br, hi); await p.waitForTimeout(900);
    const moved = await onOf(p);
    check(moved[0].price === hi && moved[1].price === on[1].price && moved[0].dash === '12/5', 'a new high: ONH moves to it at once, still forming: ' + shown(moved));
    await p.screenshot({ path: path.join(SHOTS, 'onh-overnight-0300.png') });
    // Levels gear: ONH off draws ONL only
    await p.click(H('indBtn')); await p.click(H('indPanel') + ' [data-act="gear"][data-id="levels"]');
    await p.click(H('indPanel') + ' [data-f="tog:levels:onh"]'); await p.keyboard.press('Escape');
    check(JSON.stringify((await onOf(p)).map(l => l.name)) === '["ONL"]', 'ONH toggled off: only ONL');
    await p.click(H('indBtn')); await p.click(H('indPanel') + ' [data-act="gear"][data-id="levels"]');
    await p.click(H('indPanel') + ' [data-f="tog:levels:onh"]'); await p.keyboard.press('Escape');
    await ctx.close(); br.kill();
  }

  /* ---------------- the clock crossing 9:30:00 locks them, with no trade and no reload */
  {
    const off = offsetTo(9, 29, weekday, 48);
    const br = await startBridge(off);
    const ctx = await context(off);
    const p = await openPage(ctx, hostUrl(br.port));
    const before = await onOf(p);
    check(before.length === 2 && before.every(l => l.dash === '12/5'), '9:29:5x ET: still forming: ' + shown(before));
    await p.waitForFunction(() => window.liveChart.getLevels().some(l => l.key === 'onh' && l.dash.length === 0), null, { timeout: 30000 }).catch(() => {});
    const after = await onOf(p);
    check(after.length === 2 && after.every(l => l.dash === '') && after[0].price === before[0].price && after[1].price === before[1].price, '9:30:00 by the clock: locked, solid, the same prices: ' + shown(after));
    await ctx.close(); br.kill();
  }

  /* ---------------- 11:15 ET: locked */
  {
    const off = offsetTo(11, 15, weekday);
    const br = await startBridge(off);
    const ctx = await context(off);
    const p = await openPage(ctx, hostUrl(br.port));
    const on = await onOf(p);
    check(on.length === 2 && on.every(l => l.dash === '') && on.every(l => l.from === todayAt(off, 18, 0) - 86400), '11:15 ET: ONH and ONL locked, solid, from 18:00: ' + shown(on));
    check(JSON.stringify(await ibOf(p)) === '["IBH","IBL"]', 'with the IB locked beside them');
    for (const tf of ['5m', 'Range', '1m']) { await pickTf(p, tf); check(JSON.stringify(await onOf(p)) === JSON.stringify(on), 'locked ONH and ONL the same on ' + tf); }
    await price(br, on[0].price + 8); await p.waitForTimeout(900);
    check(JSON.stringify(await onOf(p)) === JSON.stringify(on), 'a new high in RTH does not move the locked ONH');
    await price(br, on[0].price - 1); await p.waitForTimeout(600);
    await p.screenshot({ path: path.join(SHOTS, 'onh-locked-1115.png') });
    await ctx.close(); br.kill();
  }

  /* ---------------- history that starts after 18:00; a Saturday */
  {
    const off = offsetTo(3, 0, weekday);
    const br = await startBridge(off);
    const ctx = await context(off, { dropHistoryBefore: todayAt(off, 20, 0) - 86400 });
    const p = await openPage(ctx, hostUrl(br.port));
    const note = await p.textContent(H('ibNote'));
    check((await onOf(p)).length === 0 && /^Overnight high and low not shown: the history does not reach back to the 18:00 ET start/.test(note) && await p.isVisible(H('ibNote')),
      'history from 20:00: no ONH or ONL, and the status line says why: ' + note);
    await ctx.close(); br.kill();
  }
  {
    const off = offsetTo(11, 0, saturday);
    const br = await startBridge(off);
    const ctx = await context(off);
    const p = await openPage(ctx, hostUrl(br.port));
    check((await onOf(p)).length === 0 && await p.isHidden(H('ibNote')), 'Saturday 11:00 ET: no ONH or ONL, no note');
    await ctx.close(); br.kill();
  }
} catch (e) { fail('threw: ' + (e && e.stack || e)); }
await browser.close();
console.log(errors.length ? `\nonh smoke: ${errors.length} FAILED` : '\nonh smoke: all ok');
process.exit(errors.length ? 1 : 0);
