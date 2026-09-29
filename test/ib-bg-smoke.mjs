// 1.5.3 smoke: the 1-hour Initial Balance and the chart background, on the live page and a mounted chart, against the
// fake bridge (sample data only, never market data). The page and the bridge run on a chosen New York time of day on
// the most recent weekday that has a regular session, so the IB phases can be seen whatever the time of the run:
//   npm run smoke:ib        (CHROMIUM_PATH=/path/to/chrome for a preinstalled browser; SHOTS=dir for the screenshots)
// Checks: nothing before 9:30; forming (dashed, "(forming)") at 10:00 and the same values on every view, after a
// reload and in ChartLive.mount; locked (solid) at 11:15; a weekend and an NYSE holiday show nothing; history that
// starts after 9:30 shows nothing and says so; the IB 1h menu entry per pane. Background: the four presets and a
// picked color draw the ground and the legend follows; saved per prefix, across a reload, and a second tab changing
// another color does not undo it. Screenshots of each go to SHOTS (default test/out).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CE = require('../src/chart-engine.js'), U = CE.util;
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
const BASE_PORT = +(process.env.IB_SMOKE_PORT || 8811);
const errors = [];
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { if (!ok) fail(m); else console.log('  ok   ' + m); };

/* Seconds to add to the real clock to stand at hh:mm New York time on the most recent day that `want(day)` accepts. */
function offsetTo(hh, mm, want) {
  const now = Date.now() / 1000, today = Math.floor(U.zoneSeconds(now) / 86400);
  for (let back = 0; back < 30; back++) {
    const bt = (today - back) * 86400 + hh * 3600 + mm * 60;                  // bar time (New York wall clock)
    if (!want(bt)) continue;
    let unix = bt - (U.zoneSeconds(now) - now);
    unix = bt - (U.zoneSeconds(unix) - unix);                               // the offset on that day (DST)
    if (unix > now) continue;
    return Math.round(unix - now);
  }
  throw new Error('no day found');
}
const weekday = bt => U.rthDay(bt);
const saturday = bt => new Date(bt * 1000).getUTCDay() === 6;
const holiday = bt => { const d = new Date(bt * 1000); return d.getUTCDay() > 0 && d.getUTCDay() < 6 && !U.rthDay(bt); };

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
      return { proc: b, port: p, kill: () => b.kill() };
    }
    if (!/EADDRINUSE/.test(errText)) throw new Error('bridge failed: ' + errText);
  }
  throw new Error('no free port from ' + BASE_PORT);
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
/* A browser context whose clock runs `offset` seconds off, like the bridge's; `filter` drops history bars in the page. */
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
async function openPage(ctx, url) {
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fail('console: ' + m.text()); });
  await p.goto(url);
  await live(p);
  return p;
}
const live = p => p.waitForFunction(() => document.getElementById('connPill') && document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 20000 }).then(() => p.waitForTimeout(700));
/* the IB lines the chart holds: the page's chart, or pane A of a mounted pair */
const ibOf = (p, pane) => p.evaluate(pn => (pn ? window[pn].chart : window.liveChart).getLevels().filter(l => l.layer === 'ib').map(l => ({ name: l.name, price: l.price, dash: l.dash.join('/') })), pane || null);
async function pickTf(p, text) { await p.click(`#tfSeg >> text="${text}"`); await live(p); }
const todayAt = (offset, hh, mm) => Math.floor(U.zoneSeconds(Date.now() / 1000 + offset) / 86400) * 86400 + hh * 3600 + mm * 60;

try {
  /* ---------------- IB forming at 10:00 */
  {
    const off = offsetTo(10, 0, weekday);
    const br = await startBridge(off);
    const ctx = await context(off);
    const p = await openPage(ctx, `http://localhost:${br.port}/live/`);
    const ib = await ibOf(p);
    check(ib.length === 2 && ib[0].name === 'IBH (forming)' && ib[1].name === 'IBL (forming)' && ib.every(l => l.dash === '6/4') && ib[0].price >= ib[1].price,
      '10:00 ET: IBH and IBL forming, dashed: ' + JSON.stringify(ib));
    check((await p.evaluate(() => window.liveChart.getLayers().ib)) === true, 'IB 1h on by default on the main pane');
    check(/5\/5/.test(await p.textContent('#indCount')), 'indicator count 5/5: ' + await p.textContent('#indCount'));
    await p.screenshot({ path: path.join(SHOTS, 'ib-forming-1000.png') });
    // the same IB on every view
    for (const tf of ['15s', '30s', '5m', '15m', '1h', 'Range', '1m']) {
      await pickTf(p, tf);
      const v = await ibOf(p);
      check(JSON.stringify(v) === JSON.stringify(ib), 'same IB on ' + tf + ': ' + JSON.stringify(v.map(l => l.price)));
    }
    // after a reload
    await p.reload(); await live(p);
    check(JSON.stringify(await ibOf(p)) === JSON.stringify(ib), 'same IB after a reload');
    // the menu entry: off hides the lines and is saved for this pane only
    await p.click('#indBtn');
    check(await p.isVisible('#indPanel input[data-layer="ib"]') && /IB 1h/.test(await p.textContent('#indPanel')), 'Indicators menu has "IB 1h"');
    await p.click('#indPanel input[data-layer="ib"]'); await p.keyboard.press('Escape');
    check((await p.evaluate(() => window.liveChart.getLayers().ib)) === false && (await p.evaluate(() => JSON.parse(localStorage.getItem('live-indicators-v1')).main.ib)) === false, 'IB 1h off: layer off and saved for the main pane');
    await p.reload(); await live(p);
    check((await p.evaluate(() => window.liveChart.getLayers().ib)) === false, 'IB 1h off after a reload');
    await p.click('#indBtn'); await p.click('#indPanel input[data-layer="ib"]'); await p.keyboard.press('Escape');
    // the mounted chart (The Desk): same IB; a new pane starts with it off
    const host = await openPageEmbed(ctx, br.port);
    const mA = await ibOf(host, '__a');
    check(JSON.stringify(mA) === JSON.stringify(ib), 'ChartLive.mount main pane: same IB: ' + JSON.stringify(mA.map(l => l.price)));
    check((await host.evaluate(() => window.__b.chart.getLayers().ib)) === false, 'a new mounted pane starts with IB 1h off');
    await host.close();
    await ctx.close(); br.kill();
  }

  /* ---------------- locked after 10:30 */
  {
    const off = offsetTo(11, 15, weekday);
    const br = await startBridge(off);
    const ctx = await context(off);
    const p = await openPage(ctx, `http://localhost:${br.port}/live/`);
    const ib = await ibOf(p);
    check(ib.length === 2 && ib[0].name === 'IBH' && ib[1].name === 'IBL' && ib.every(l => l.dash === ''), '11:15 ET: IBH and IBL locked, solid: ' + JSON.stringify(ib));
    await p.screenshot({ path: path.join(SHOTS, 'ib-locked-1115.png') });
    for (const tf of ['5m', '1h', 'Range', '1m']) { await pickTf(p, tf); check(JSON.stringify(await ibOf(p)) === JSON.stringify(ib), 'locked IB the same on ' + tf); }
    await ctx.close(); br.kill();
  }

  /* ---------------- before 9:30, a Saturday, an NYSE holiday, and history that starts after 9:30 */
  {
    const off = offsetTo(9, 0, weekday);
    const br = await startBridge(off);
    const ctx = await context(off);
    const p = await openPage(ctx, `http://localhost:${br.port}/live/`);
    check((await ibOf(p)).length === 0 && await p.isHidden('#ibNote'), '9:00 ET: no IB yet, no note');
    await ctx.close(); br.kill();
  }
  {
    const off = offsetTo(11, 0, saturday);
    const br = await startBridge(off);
    const ctx = await context(off);
    const p = await openPage(ctx, `http://localhost:${br.port}/live/`);
    check((await ibOf(p)).length === 0 && await p.isHidden('#ibNote'), 'Saturday 11:00 ET: no IB, no note');
    await ctx.close(); br.kill();
  }
  {
    let off = null;
    try { off = offsetTo(11, 0, holiday); } catch (e) { console.log('  (no NYSE holiday in the last 30 days: skipped)'); }
    if (off !== null) {
      const br = await startBridge(off);
      const ctx = await context(off);
      const p = await openPage(ctx, `http://localhost:${br.port}/live/`);
      check((await ibOf(p)).length === 0 && /holiday/.test(await p.textContent('#ibNote')), 'NYSE holiday 11:00 ET: no IB, a quiet note: ' + await p.textContent('#ibNote'));
      await ctx.close(); br.kill();
    }
  }
  {
    const off = offsetTo(11, 0, weekday);
    const br = await startBridge(off);
    const ctx = await context(off, { dropHistoryBefore: todayAt(off, 9, 45) });
    const p = await openPage(ctx, `http://localhost:${br.port}/live/`);
    const note = await p.textContent('#ibNote');
    check((await ibOf(p)).length === 0 && /history starts after 9:30/.test(note) && await p.isVisible('#ibNote'), 'history from 9:45: no IB, and the status line says why: ' + note);
    await p.screenshot({ path: path.join(SHOTS, 'ib-uncovered.png') });
    await ctx.close(); br.kill();
  }

  /* ---------------- background */
  {
    const off = offsetTo(11, 15, weekday);
    const br = await startBridge(off);
    const ctx = await context(off);
    const a = await openPage(ctx, `http://localhost:${br.port}/live/`);
    const b = await openPage(ctx, `http://localhost:${br.port}/live/`);      // a second tab, open before A changes anything
    await a.bringToFront();
    /* the ground drawn in the plot's top-left corner (device pixels), and the stage and legend backgrounds */
    const look = p => p.evaluate(() => {
      const c = document.querySelector('#chart canvas'), x = c.getContext('2d');
      const d = x.getImageData(4, 4, 1, 1).data;
      const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
      return { canvas: hex, stage: getComputedStyle(document.querySelector('.stage')).backgroundColor, legend: getComputedStyle(document.getElementById('legend')).backgroundColor,
        head: getComputedStyle(document.getElementById('lgName')).color, theme: window.liveChart.getTheme().bg, saved: JSON.parse(localStorage.getItem('live-colors-v1') || 'null') };
    });
    const rgb = h => { const c = U.parseColor(h); return 'rgb(' + c.r + ', ' + c.g + ', ' + c.b + ')'; };
    const base = await look(a);
    check(base.theme === '#080B10' && base.canvas === '#080B10' && base.legend === 'rgba(8, 11, 16, 0.78)', 'default ground unchanged: ' + JSON.stringify(base));
    await a.screenshot({ path: path.join(SHOTS, 'bg-dark-default.png') });
    await a.click('.ce-theme-btn');
    check(await a.isVisible('.ce-grounds') && (await a.$$('.ce-ground')).length === 4, 'Colors panel: four background presets');
    await a.screenshot({ path: path.join(SHOTS, 'colors-panel-open.png') });
    for (const g of CE.BACKGROUNDS) {
      await a.click(`.ce-ground[data-bg="${g.id}"]`); await a.waitForTimeout(250);
      const l = await look(a);
      const T = U.buildTheme({ bg: g.bg });
      check(l.theme === g.bg && l.canvas === g.bg && l.stage === rgb(g.bg) && l.saved.bg === g.bg && U.contrast(T.tagText, g.bg) >= 7,
        g.name + ' ground: canvas ' + l.canvas + ', stage ' + l.stage + ', saved ' + l.saved.bg + ', legend name ' + l.head);
      await a.keyboard.press('Escape'); await a.mouse.move(700, 400); await a.waitForTimeout(200);
      await a.screenshot({ path: path.join(SHOTS, 'bg-' + g.id + '.png') });
      await a.click('.ce-theme-btn');
    }
    // any color with the picker (hex box): white, a mid-grey, a saturated red
    for (const [hex, name] of [['#FFFFFF', 'white'], ['#777777', 'midgrey'], ['#B0102A', 'red']]) {
      await a.fill('.ce-theme-panel input[data-hex="bg"]', hex); await a.waitForTimeout(250);
      const l = await look(a);
      check(l.canvas === hex && l.saved.bg === hex, 'picked ' + name + ' ' + hex + ': drawn and saved');
      await a.keyboard.press('Escape'); await a.mouse.move(700, 400); await a.waitForTimeout(200);
      await a.screenshot({ path: path.join(SHOTS, 'bg-picked-' + name + '.png') });
      await a.click('.ce-theme-btn');
    }
    await a.click('.ce-ground[data-bg="light"]'); await a.keyboard.press('Escape'); await a.waitForTimeout(200);
    // tab B still shows its own (dark) ground and changes the bull color: A's light ground must survive
    await b.bringToFront();
    await b.click('.ce-theme-btn'); await b.click('.ce-preset[data-id="mint"]'); await b.keyboard.press('Escape'); await b.waitForTimeout(200);
    const savedAfterB = await b.evaluate(() => JSON.parse(localStorage.getItem('live-colors-v1')));
    check(savedAfterB.bg === '#F5F7FA' && savedAfterB.up === '#4FD1A5', 'second tab changing Bull kept the light ground: ' + JSON.stringify(savedAfterB));
    await a.bringToFront(); await a.reload(); await live(a);
    const r = await look(a);
    check(r.theme === '#F5F7FA' && r.canvas === '#F5F7FA' && (await a.evaluate(() => window.liveChart.getTheme().up)) === '#4FD1A5', 'after a reload: light ground and the other tab\'s bull color');
    check(r.legend === 'rgba(245, 247, 250, 0.78)', 'the legend follows the ground: ' + r.legend);
    await a.screenshot({ path: path.join(SHOTS, 'bg-light-after-reload.png') });
    // the mounted chart keeps its own (prefix desk:): still dark
    const host = await openPageEmbed(ctx, br.port);
    const emb = await host.evaluate(() => ({ bg: window.__a.chart.getTheme().bg, saved: localStorage.getItem('desk:live-colors-v1') }));
    check(emb.bg === '#080B10', 'the embedded chart keeps its own ground: ' + JSON.stringify(emb));
    await host.click('#paneA .ce-theme-btn'); await host.click('#paneA .ce-ground[data-bg="black"]'); await host.keyboard.press('Escape');
    check(JSON.parse(await host.evaluate(() => localStorage.getItem('desk:live-colors-v1'))).bg === '#000000' && JSON.parse(await host.evaluate(() => localStorage.getItem('live-colors-v1'))).bg === '#F5F7FA',
      'embedded ground saved under desk:, the page\'s untouched');
    await host.close();
    // reset puts the default ground back
    await a.click('.ce-theme-btn'); await a.click('.ce-reset'); await a.keyboard.press('Escape'); await a.waitForTimeout(200);
    check((await look(a)).canvas === '#080B10', 'Reset to default: the dark ground again');
    await ctx.close(); br.kill();
  }
} finally {
  await browser.close();
}

async function openPageEmbed(ctx, p) {
  const host = await ctx.newPage();
  host.on('pageerror', e => fail('embed pageerror: ' + e.message));
  await host.goto(`http://localhost:${p}/test/embed-host.html`);
  await host.evaluate(port => {
    window.__a = ChartLive.mount(document.getElementById('paneA'), { wsUrl: 'ws://localhost:' + port + '/ws', paneId: 'main', storagePrefix: 'desk:' });
    window.__b = ChartLive.mount(document.getElementById('paneB'), { wsUrl: 'ws://localhost:' + port + '/ws', paneId: 'pane-2', storagePrefix: 'desk:' });
  }, p);
  await host.waitForFunction(() => [...document.querySelectorAll('[id$="-connPill"]')].every(x => x.textContent === 'LIVE'), null, { timeout: 20000 });
  await host.waitForTimeout(700);
  return host;
}

if (errors.length) { console.error('FAIL\n' + errors.join('\n')); process.exit(1); }
console.log('ib and background smoke: ok (screenshots in ' + SHOTS + ')');
