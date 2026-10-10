// The header room and Jump to live (chart 1.14.0, Anthony live on 1.13.0: "price keeps running up into the header",
// and the Jump to live pill over the plot) against the fake bridge (sample data; nothing reaches a broker), in Chromium:
//   - a trend of +60 points in two minutes on MNQ (the fake's random walk held, a trade every 200 ms), watched on a big
//     workspace panel (full header) and a small one (the short header), then on a mounted chart with its own toolbar
//     (test/chart-host.html; /single.html until chart 1.21.0): the last price, the
//     forming bar's high and every visible high stay below the header plus a margin, all the time, by themselves;
//   - the bars are never squashed more than the move needs: the scale is the fit of the bars in view (eased);
//   - with the price scale squashed by hand (a drag on the price axis) the auto-fit takes over once the price nears
//     the header, and following live again (End, the icon) brings the auto-fit back;
//   - Jump to live: a small icon at the top of the price scale with the tooltip "Jump to live (End)", only while not
//     following live, clear of the price and order tags, taking no layout room; a click or End goes back to live;
//   - the price scale lock (review D2): in the corner under the price axis, saved per chart; locked, a zoom set by hand
//     is kept as price moves, End fits it again.
//   npm run smoke:headroom        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';
import { C as H, hostUrl, waitLive } from './chart-host.mjs';

const require = createRequire(import.meta.url);
const CE = require('../src/chart-engine.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const SHOTS = process.env.SHOTS_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const PORT = +(process.env.HEADROOM_SMOKE_PORT || 8897);
const TREND_PTS = 60, TREND_SECS = +(process.env.HEADROOM_TREND_SECS || 120), MARGIN = 4;
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function shot(page, name) {
  const file = path.join(out, name);
  await page.screenshot({ path: file });
  if (SHOTS) fs.copyFileSync(file, path.join(SHOTS, name));
}
const bridges = [];
let cport = PORT;                                     // the bridge the trend drives
async function startBridge(port, pin) {               // pin: the workspace's PIN; a mounted chart never has it (PIN off)
  const b = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(port), '--trading', '--trade-accounts=Sim101', '--test-controls',
    '--version=0.3.8', '--data-037', '--live-rate=40', pin ? '--test-pin=' + TEST_PIN : '--pin-off'], { stdio: ['ignore', 'pipe', 'inherit'] });
  bridges.push(b);
  await new Promise(r => b.stdout.once('data', r));
}
const control = async (what, q) => (await fetch(`http://127.0.0.1:${cport}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
async function openPage(ctx, url) {
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('wsConn') || document.querySelector('.cb-pin-key'), null, { timeout: 15000 });
  if (await page.$('.cb-pin-key')) await enterPin(page, TEST_PIN);
  return page;
}

/* One look at a chart: where the header ends, where the last price, the forming bar's high and the highest bar in view
   are, the scale against the fit of the bars in view (how much more squashed than needed), and the Jump to live icon. */
const look = (page, sel) => page.evaluate(sel => {
  const U = window.ChartEngine.util;
  const one = (c, el) => {
    const box = el.querySelector('.chart-box').getBoundingClientRect(), lg = el.querySelector('.legend');
    const lgOn = lg && getComputedStyle(lg).display !== 'none' && lg.offsetHeight > 0;
    const header = lgOn ? lg.getBoundingClientRect().bottom - box.top : 0;
    const ps = c.priceScale(), w = box.width - 78, bs = c.bars(), lb = c.lastBar();
    let hi = -Infinity, lo = Infinity;
    for (let i = 0; i < bs.length; i++) { const x = c.barToX(i); if (x >= -2 && x <= w + 2) { if (bs[i].h > hi) hi = bs[i].h; if (bs[i].l < lo) lo = bs[i].l; } }
    if (lb) { hi = Math.max(hi, lb.h); lo = Math.min(lo, lb.l); }
    const fit = U.fitRange(lo, hi, null, ps.plotHeight, 0.25, c.getLayers().volume, c.getFitTop());
    const btn = el.querySelector('.ce-live');
    const b = btn && !btn.hidden ? btn.getBoundingClientRect() : null;
    return {
      header, fitTop: c.getFitTop(), plotH: ps.plotHeight, auto: ps.auto, live: c.isLive(),
      yLast: c.priceToY(lb.c), yHigh: c.priceToY(lb.h), yVis: c.priceToY(hi), yLow: c.priceToY(lo),
      squash: fit ? (ps.hi - ps.lo) / (fit.hi - fit.lo) : null, short: el.classList.contains('short') || !!el.querySelector('.chart-live.short'),
      w: Math.round(box.width), h: Math.round(box.height), last: lb.c,
      icon: b ? { x: b.left - box.left, y: b.top - box.top, w: b.width, h: b.height, title: btn.title, plotW: w } : null,
    };
  };
  if (sel === 'host') return [one(window.liveChart, document.querySelector('.chart-live'))];
  return window.workspace.panels().filter(p => p.type === 'chart' && p.root === 'MNQ').map(p => Object.assign(one(window.workspace.chart(p.id), document.querySelector(`.ws-panel[data-id="${p.id}"]`)), { id: p.id, tf: p.tf }));
}, sel);

/* The trend: a trade every 200 ms, +60 points over TREND_SECS, with ticks of noise (sample data). */
async function trend(from, onSample, pts = TREND_PTS, secs = TREND_SECS) {
  const t0 = Date.now(), end = t0 + secs * 1000;
  let k = 0, last = from;
  for (;;) {
    const now = Date.now(); if (now >= end) break;
    const f = (now - t0) / (secs * 1000), noise = [0, 0.5, -0.25, 0.75, -0.5, 0.25][k % 6];
    last = Math.round((from + pts * f + noise) * 4) / 4;
    await control('price', { root: 'MNQ', p: last });
    if (k % 3 === 2) await onSample(f);
    k++; await wait(200);
  }
  return last;
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  await startBridge(PORT, true);
  const L = Math.round((await control('hold', { root: 'MNQ' })).last);
  await control('price', { root: 'MNQ', p: L });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());

  /* ================================================================ the workspace: a big panel and a small one */
  console.log('workspace 1366x768: MNQ Range 40 (big, full header) and MNQ 1 hour (small, short header)');
  const wp = await openPage(ctx, `http://localhost:${PORT}/live/?layout=Display`);
  await wp.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
  await wp.waitForTimeout(2500);
  let s = await look(wp, 'ws');
  const big = s.find(x => !x.short), small = s.find(x => x.short);
  check(!!big && !!small, 'an MNQ panel of each size: ' + s.map(x => x.tf + ' ' + x.w + 'x' + x.h + (x.short ? ' short' : '')).join(', '));
  // a first leg up of 40 points, then the price scale squashed by hand on the big panel (one drag down on the price
  // axis), as Anthony does today; then the trend goes on
  const L0 = await trend(L, async () => {}, 40, 10);
  const bigBox = await wp.locator(`.ws-panel[data-id="${big.id}"] .chart-box`).boundingBox();
  await wp.mouse.move(bigBox.x + bigBox.width - 30, bigBox.y + bigBox.height * 0.5); await wp.mouse.down();
  await wp.mouse.move(bigBox.x + bigBox.width - 30, bigBox.y + bigBox.height * 0.5 + 40, { steps: 4 }); await wp.mouse.up();
  await wp.mouse.move(4, 760); await wp.waitForTimeout(400);
  s = await look(wp, 'ws');
  check(s.find(x => x.id === big.id).auto === false, 'big panel: after a first leg up, the price scale squashed by hand, auto-fit off for now');
  const bad = { ws: [] }, worst = {}, squash = {};
  let tookOver = null, beforeTake = Infinity;
  /* 1.16.0: a workspace chart has no text on it, so its header is the plot's top: the price set by hand runs up to 12 px
     under it before the auto-fit takes over, further than under the 1.15.0 legend: a longer leg, at the same pace */
  const WS_PTS = TREND_PTS + 30, WS_SECS = Math.round(TREND_SECS * (TREND_PTS + 30) / TREND_PTS);
  const last1 = await trend(L0, async f => {
    const all = await look(wp, 'ws');
    for (const x of all) {
      const key = x.short ? 'small' : 'big';
      if (key === 'big' && x.auto && tookOver === null) tookOver = f;
      const top = x.header + MARGIN, room = Math.min(x.yLast, x.yHigh, x.yVis) - x.header;
      if (key === 'big' && tookOver === null) beforeTake = Math.min(beforeTake, Math.min(x.yLast, x.yHigh) - x.header);   // set by hand: the price still clear
      if (!(key === 'big' && tookOver === null)) {
        if (x.yLast < top || x.yHigh < top || x.yVis < top || x.yLast > x.plotH || x.yLow > x.plotH + 1) bad.ws.push(key + ' at ' + Math.round(f * 100) + '%: ' + JSON.stringify({ header: Math.round(x.header), last: Math.round(x.yLast), high: Math.round(x.yHigh), vis: Math.round(x.yVis), low: Math.round(x.yLow), plotH: x.plotH }));
        worst[key] = Math.min(worst[key] === undefined ? Infinity : worst[key], room);
        if (x.auto) squash[key] = Math.max(squash[key] || 0, x.squash);
      }
    }
  }, WS_PTS, WS_SECS);
  check(tookOver !== null && beforeTake >= MARGIN, 'big panel: the auto-fit took over by itself as the price neared the header (at ' + (tookOver === null ? '-' : Math.round(tookOver * 100) + '%') + ' of the move; until then the price stayed ' + Math.round(beforeTake) + ' px or more below the header)');
  check(bad.ws.length === 0, 'workspace: through +' + WS_PTS + ' points in ' + WS_SECS + ' s the last price, the forming high and every high in view stayed at least ' + MARGIN + ' px below the header, and every low above the bottom (closest: big ' + Math.round(worst.big) + ' px, small ' + Math.round(worst.small) + ' px)' + (bad.ws.length ? ': ' + bad.ws.slice(0, 4).join('; ') : ''));
  check(squash.big <= 1.1 && squash.small <= 1.1, 'never squashed more than the move needs: the scale at most ' + Math.max(squash.big, squash.small).toFixed(3) + ' times the fit of the bars in view (easing included)');
  await shot(wp, 'headroom-ws-1366-after-trend.png');

  /* Jump to live in the workspace: scroll back on the big panel */
  const pb = await wp.locator(`.ws-panel[data-id="${big.id}"] .chart-box`).boundingBox();
  await wp.mouse.move(pb.x + pb.width * 0.3, pb.y + pb.height * 0.5); await wp.mouse.down();
  await wp.mouse.move(pb.x + pb.width * 0.7, pb.y + pb.height * 0.5, { steps: 6 }); await wp.mouse.up();
  await wp.mouse.move(4, 760); await wp.waitForTimeout(500);
  s = await look(wp, 'ws');
  let bx = s.find(x => x.id === big.id);
  const sizeBefore = [bx.w, bx.h];
  check(!bx.live && bx.icon && bx.icon.title === 'Jump to live (End)', 'scrolled back: the Jump to live icon shows, titled "Jump to live (End)"');
  const tagTop = Math.max(0, Math.min(bx.yLast - 9, bx.plotH - 32));
  check(bx.icon && bx.icon.x >= bx.icon.plotW && bx.icon.x + bx.icon.w <= bx.w && (bx.icon.y <= 8 || tagTop < 30) && bx.icon.w <= 26 && bx.icon.h <= 24,
    'a small icon at the top of the price scale (lower only to keep clear of the tags there), not over the plot: ' + JSON.stringify(bx.icon));
  check(bx.icon && (bx.icon.y + bx.icon.h <= tagTop || bx.icon.y >= tagTop + 32), 'clear of the last price tag (' + Math.round(tagTop) + ' to ' + Math.round(tagTop + 32) + ' px)');
  check(sizeBefore[0] === big.w && sizeBefore[1] === big.h, 'it takes no layout room: the chart keeps its size');
  await shot(wp, 'headroom-ws-jump-to-live.png');
  await wp.click(`.ws-panel[data-id="${big.id}"] .ce-live`); await wp.waitForTimeout(500);
  bx = (await look(wp, 'ws')).find(x => x.id === big.id);
  check(bx.live && !bx.icon && bx.auto, 'a click: following live again, the icon gone, the auto-fit on');
  const locks = await wp.evaluate(() => [...document.querySelectorAll('.ws-panel[data-type="chart"]')].map(p => { const l = p.querySelector('.ce-lock'), b = p.querySelector('.chart-box').getBoundingClientRect(); if (!l) return false; const r = l.getBoundingClientRect(); return r.left >= b.right - 78 && r.bottom <= b.bottom && r.top >= b.bottom - 26; }));
  check(locks.length > 0 && locks.every(Boolean), 'every workspace chart has the lock in its corner under the price axis');
  await ctx.close();

  /* ================================================================ a mounted chart (the single chart page until 1.21.0): the same
     trend, then End. Its own bridge (the PIN off), its price where the workspace's trend left MNQ */
  console.log('a mounted chart (test/chart-host.html) 1366x768');
  await startBridge(PORT + 1, false);
  cport = PORT + 1;
  await control('hold', { root: 'MNQ' }); await control('price', { root: 'MNQ', p: last1 });
  const ctx2 = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
  await ctx2.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const sp = await ctx2.newPage();
  sp.on('pageerror', e => fail('page error: ' + e.message));
  await sp.goto(hostUrl(PORT + 1));
  await waitLive(sp, 30000);
  await sp.waitForFunction(() => window.liveChart && window.liveChart.lastBar(), null, { timeout: 30000 });
  await sp.click(H('tfSeg') + ' [data-v="m1"]'); await sp.waitForTimeout(1500);
  const sbad = []; let sworst = Infinity, ssq = 0;
  await trend(last1, async f => {
    const [x] = await look(sp, 'host');
    const top = x.header + MARGIN;
    if (x.yLast < top || x.yHigh < top || x.yVis < top || x.yLast > x.plotH) sbad.push(Math.round(f * 100) + '%: ' + JSON.stringify({ header: Math.round(x.header), last: Math.round(x.yLast), high: Math.round(x.yHigh), vis: Math.round(x.yVis) }));
    sworst = Math.min(sworst, Math.min(x.yLast, x.yHigh, x.yVis) - x.header);
    if (x.auto) ssq = Math.max(ssq, x.squash);
  });
  check(sbad.length === 0, 'mounted chart: through the trend everything stayed below the header (closest ' + Math.round(sworst) + ' px)' + (sbad.length ? ': ' + sbad.slice(0, 4).join('; ') : ''));
  check(ssq <= 1.1, 'mounted chart: never squashed more than needed (' + ssq.toFixed(3) + ')');
  await shot(sp, 'headroom-chart-1366-after-trend.png');
  // scroll back: the icon; End goes back to live
  const cb = await sp.locator(H('chart')).boundingBox();
  await sp.mouse.move(cb.x + cb.width * 0.3, cb.y + cb.height * 0.4); await sp.mouse.down();
  await sp.mouse.move(cb.x + cb.width * 0.7, cb.y + cb.height * 0.4, { steps: 6 }); await sp.mouse.up();
  await sp.mouse.move(cb.x + 40, cb.y + cb.height + 20); await sp.waitForTimeout(500);
  let [x] = await look(sp, 'host');
  check(!x.live && x.icon && x.icon.x >= x.icon.plotW && x.icon.y < 60 && x.icon.title === 'Jump to live (End)', 'mounted chart: scrolled back, the icon at the top of the price scale: ' + JSON.stringify(x.icon));
  await shot(sp, 'headroom-chart-jump-to-live.png');
  await sp.focus(H('chart')); await sp.keyboard.press('End'); await sp.waitForTimeout(500);
  [x] = await look(sp, 'host');
  check(x.live && !x.icon, 'End: following live again, the icon gone');
  // the price scale lock (Anthony, review D2): in the corner under the price axis, saved per chart
  const lockAt = await sp.evaluate(sel => { const l = document.querySelector(sel + ' .ce-lock'), b = document.querySelector(sel).getBoundingClientRect(), r = l.getBoundingClientRect();
    return { inCorner: r.left >= b.right - 78 && r.right <= b.right && r.top >= b.bottom - 26 && r.bottom <= b.bottom, pressed: l.getAttribute('aria-pressed'), title: l.title }; }, H('chart'));
  check(lockAt.inCorner && lockAt.pressed === 'false', 'a lock in the corner under the price axis (no tag ever goes there), unlocked by default: ' + JSON.stringify(lockAt));
  await sp.click(H('chart') + ' .ce-lock');
  check((await sp.evaluate(() => JSON.parse(localStorage.getItem('live-scale-lock-v1') || '{}').main)) === true, 'a click locks it, saved for this chart');
  await sp.mouse.move(cb.x + cb.width - 30, cb.y + cb.height * 0.4); await sp.mouse.down();
  await sp.mouse.move(cb.x + cb.width - 30, cb.y + cb.height * 0.4 - 130, { steps: 8 }); await sp.mouse.up();
  await sp.mouse.move(cb.x + 40, cb.y + cb.height + 20); await sp.waitForTimeout(300);
  const lastNow = (await look(sp, 'host'))[0].last;
  await trend(lastNow, async () => {}, 30, 8);
  [x] = await look(sp, 'host');
  check(!x.auto, 'locked: the zoom set by hand is kept through +30 points (price may leave the view: last at ' + Math.round(x.yLast) + ' px)');
  await sp.focus(H('chart')); await sp.keyboard.press('End'); await sp.waitForTimeout(500);
  [x] = await look(sp, 'host');
  check(x.auto && await sp.getAttribute(H('chart') + ' .ce-lock', 'aria-pressed') === 'true', 'End fits it again; the lock stays on');
  await shot(sp, 'headroom-chart-lock.png');
  await sp.reload(); await waitLive(sp, 30000);
  await sp.waitForFunction(() => window.liveChart && window.liveChart.lastBar(), null, { timeout: 30000 });
  check(await sp.getAttribute(H('chart') + ' .ce-lock', 'aria-pressed') === 'true', 'locked after a reload');
  await sp.click(H('chart') + ' .ce-lock');
  check((await sp.evaluate(() => JSON.parse(localStorage.getItem('live-scale-lock-v1') || '{}').main)) === undefined && (await look(sp, 'host'))[0].auto, 'unlocked: saved, the auto-fit on');
  await ctx2.close();
} finally {
  await browser.close();
  for (const b of bridges) b.kill();
}
console.log(`\n${checks - errors.length}/${checks} checks passed`);
if (errors.length) { console.error(errors.length + ' failed'); process.exit(1); }
