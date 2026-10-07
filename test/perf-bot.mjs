// R5 (the motion kit, docs/MOTION.md): the Bot tab animating while its live chart draws, and the chart's gates still hold.
// The workspace on the Bot tab against the fake bridge's v3 bot channel with a busy tape (sample data, a made-up bot and
// a made-up library). For the whole window the entrance scene is played again and again, and a library build is opened
// full screen and closed (its curve drawing, its tiles counting, its stamp landing, its bars growing), so motion runs in
// nearly every frame while MNQ trades at --live-rate. Measured as test/perf-workspace.mjs does: each chart's own frame
// callback, all charts per frame, the motion kit's one loop, the frame intervals, long tasks and the heap.
// Gates (README): a chart's frame p95 under 4 ms, all charts per frame p95 under 8 ms; and the motion loop's p95 under
// 4 ms (never more than a chart's own budget). Also: motion never runs inside a chart's frame (a chart's callback never calls the kit's).
// Not part of `npm test` (about a minute).
//   node test/perf-bot.mjs [--secs=30] [--warm=8] [--live-rate=200] [--tick-rate=15] [--port=8968] [--json=FILE]
//   npm run perf:bot         (CHROMIUM_PATH=/path/to/chrome uses a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, d) => { const a = process.argv.slice(2).find(x => x === '--' + name || x.startsWith('--' + name + '=')); return a === undefined ? d : a.includes('=') ? a.slice(a.indexOf('=') + 1) : true; };
const SECS = +arg('secs', 30), WARM = +arg('warm', 8), LIVE_RATE = +arg('live-rate', 200), TICK_RATE = +arg('tick-rate', 15), PORT = +arg('port', 8968);
const GATE = { chartP95: 4, allP95: 8, motionP95: 4 };
/* --idle: the same page with no scene played (the baseline to compare with) */
const IDLE = !!arg('idle', false);
/* --scenes=entrance or detail: only that one, to see what each costs */
const SCENES = String(arg('scenes', 'both'));

const init = `(() => {
  const P = window.__perf = { on: false, ts: [], charts: [], perFrame: [], motion: [], long: [], nested: 0 };
  const now = () => performance.now();
  let creating = null, frameCost = 0, inChart = false;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => {
    if (creating && !cb.__chartEl) cb.__chartEl = creating;
    const el = cb.__chartEl;
    return raf(ts => {
      if (!P.on) return cb(ts);
      if (el) { inChart = true; const t0 = now(); try { cb(ts); } finally { inChart = false; } const dt = now() - t0; P.charts.push(dt); frameCost += dt; }
      else if (cb.name === 'loop') { if (inChart) P.nested++; const t0 = now(); cb(ts); P.motion.push(now() - t0); }
      else cb(ts);
    });
  };
  const loop2 = ts => { if (P.on) { P.ts.push(ts); P.perFrame.push(frameCost); } frameCost = 0; raf(loop2); }; raf(loop2);
  let CE;
  Object.defineProperty(window, 'ChartEngine', { configurable: true, get() { return CE; }, set(v) {
    const create = v.create; v.create = function (el) { creating = el; try { return create.apply(this, arguments); } finally { creating = null; } };
    CE = v;
  } });
  try { new PerformanceObserver(l => { if (P.on) for (const e of l.getEntries()) P.long.push(e.duration); }).observe({ type: 'longtask', buffered: false }); } catch (e) {}
})();`;
const q = (arr, p) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r3 = v => Math.round(v * 1000) / 1000;

const bridge = spawn(process.execPath, [path.join(here, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--test-controls', '--test-pin=' + TEST_PIN,
  '--tick-rate=' + TICK_RATE, '--live-rate=' + LIVE_RATE], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });
const browser = await chromium.launch(Object.assign({ args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] }, process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}));
let result = null, failed = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(init);
  // only the Bot tab's chart: the workspace's layout has no panel (the Bot tab is measured, not the grid)
  await ctx.addInitScript(() => { try { localStorage.setItem('live-workspace-v1', JSON.stringify({ v: 1, layouts: { Perf: { panels: [] } } })); } catch (e) {} });
  await ctx.route(/\/live\/(index\.html)?(\?.*)?$/, async r => {
    const resp = await r.fetch();
    await r.fulfill({ response: resp, headers: Object.assign({}, resp.headers(), { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' }) });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/live/?layout=Perf&tab=bot`);
  await page.waitForSelector('.cb-pin-key', { timeout: 30000 });
  await enterPin(page, TEST_PIN);
  await fetch(`http://127.0.0.1:${PORT}/test/bot-connect?name=Sample%20Lantern%20Fade`, { method: 'POST' });
  await page.waitForFunction(() => { const b = window.workspace && window.workspace.bot(); return b && b.on && b.chart && b.library.state === 'ok'; }, null, { timeout: 60000, polling: 200 });
  await page.waitForFunction(() => { const c = document.querySelector('.bt-chart .badge, .bt-chart [data-conn]'); return !c || c.dataset.conn === 'live'; }, null, { timeout: 60000, polling: 200 });
  if (arg('css', '')) await page.addStyleTag({ content: String(arg('css', '')) });   // an experiment: a style added (what costs what)
  await page.waitForTimeout(WARM * 1000);
  const heapStart = await page.evaluate(() => performance.memory.usedJSHeapSize);
  await page.evaluate(() => { window.__perf.on = true; });
  // motion in nearly every frame: the entrance again, then a build full screen and closed, over and over
  const t0 = Date.now();
  let scenes = 0;
  while (IDLE && Date.now() - t0 < SECS * 1000) await page.waitForTimeout(500);
  while (!IDLE && Date.now() - t0 < SECS * 1000) {
    if (SCENES !== 'detail') { await page.evaluate(() => window.workspace.botReplay()); scenes++; await page.waitForTimeout(1150); }
    if (SCENES !== 'entrance') {
      await page.click('.bt-entry[data-id="sample-lantern-fade"]'); scenes++;
      await page.waitForTimeout(1350);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(50);
    }
  }
  const P = await page.evaluate(() => { const p = window.__perf; p.on = false; return Object.assign({}, p, { heapEnd: performance.memory.usedJSHeapSize, iso: self.crossOriginIsolated }); });
  const heapGc = await page.evaluate(() => { if (window.gc) window.gc(); return performance.memory.usedJSHeapSize; });
  const iv = []; for (let i = 1; i < P.ts.length; i++) iv.push(P.ts[i] - P.ts[i - 1]);
  result = {
    page: 'workspace, the Bot tab (MNQ 1 min, live) with the entrance and the Library full screen playing', secs: SECS, liveRate: LIVE_RATE, scenes,
    chartFrames: P.charts.length, chartP50: r3(q(P.charts, 0.5)), chartP95: r3(q(P.charts, 0.95)), chartP99: r3(q(P.charts, 0.99)),
    allChartsPerFrameP95: r3(q(P.perFrame, 0.95)), motionFrames: P.motion.length, motionP50: r3(q(P.motion, 0.5)), motionP95: r3(q(P.motion, 0.95)), motionMax: r3(Math.max(0, ...P.motion)),
    motionInsideChartFrame: P.nested, frameP50: r3(q(iv, 0.5)), frameP95: r3(q(iv, 0.95)), over33: iv.filter(d => d > 33.4).length, longTasks: P.long.length,
    heapStartMB: r3(heapStart / 1048576), heapEndMB: r3(P.heapEnd / 1048576), heapAfterGcMB: r3(heapGc / 1048576), crossOriginIsolated: P.iso, errors,
  };
  if (!(result.chartFrames > SECS * 10)) failed.push('the Bot tab\'s chart drew only ' + result.chartFrames + ' frames');
  if (!IDLE && !(result.motionFrames > SECS * 10)) failed.push('motion ran in only ' + result.motionFrames + ' frames');
  if (result.chartP95 >= GATE.chartP95) failed.push('chart frame p95 ' + result.chartP95 + ' ms (gate ' + GATE.chartP95 + ')');
  if (result.allChartsPerFrameP95 >= GATE.allP95) failed.push('all charts per frame p95 ' + result.allChartsPerFrameP95 + ' ms (gate ' + GATE.allP95 + ')');
  if (!IDLE && result.motionP95 >= GATE.motionP95) failed.push('motion loop p95 ' + result.motionP95 + ' ms (gate ' + GATE.motionP95 + ')');
  if (result.motionInsideChartFrame) failed.push('motion ran inside a chart frame ' + result.motionInsideChartFrame + ' times');
  if (errors.length) failed.push('page errors: ' + errors.join('; '));
} finally { await browser.close(); bridge.kill(); }
const json = arg('json', '');
if (json) fs.appendFileSync(json, JSON.stringify(result) + '\n');
console.log(JSON.stringify(result, null, 1));
console.log(failed.length ? 'FAILED: ' + failed.join('; ') : 'the gates hold: chart p95 ' + result.chartP95 + ' ms, all charts ' + result.allChartsPerFrameP95 + ' ms, motion ' + result.motionP95 + ' ms');
process.exit(failed.length ? 1 : 0);
