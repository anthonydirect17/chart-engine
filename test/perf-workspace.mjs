// Workspace load benchmark: the default layout (4 charts and Time and Sales, live/workspace.html) against the fake
// bridge feeding a busy tape, compared with the single chart page (live/index.html) on the same feed. Sample data only.
// Not part of `npm test`: it takes about 2 minutes per page.
//
//   node test/perf-workspace.mjs [--mode=both|workspace|single] [--secs=120] [--warm=10] [--live-rate=300]
//                                [--tick-rate=15] [--port=8834] [--json=FILE] [--variant=default|no-tape|exec-only|exec-tape]
//
// --live-rate is trades a second per instrument while a page is subscribed to it (with the fake's bursts of 3 times
// that for 1.5 s in every 10 s), so the workspace's MNQ, NQ and ES each trade at that rate. The single page shows the
// execution chart's view (MNQ Range 40, the main pane's indicators); the workspace adds the 1 hour MNQ chart, NQ 5 min,
// ES 1 min and the MNQ tape. CHROMIUM_PATH=/path/to/chrome uses a preinstalled browser.
//
// Measures over the window after a warm-up: the page's frame intervals (p50, p95, p99, frames over 33 ms), the execution
// chart's own frame callback (the chart that trades in E2) and all charts' callbacks per frame, the tape's frame
// callback, main-thread busy % (Chromium's TaskDuration over the window, and its script and layout parts), long tasks, the JS heap at the end (and after a
// forced GC), and the WebSockets open. --variant opens the workspace with part of the default layout (to see what each
// part costs): no-tape (the 4 charts), exec-only (the execution chart alone, in its own cells), exec-tape (it and the tape).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, d) => { const a = process.argv.slice(2).find(x => x === '--' + name || x.startsWith('--' + name + '=')); return a === undefined ? d : a.includes('=') ? a.slice(a.indexOf('=') + 1) : true; };
const VARIANT = arg('variant', 'default');
const MODE = arg('mode', 'both'), SECS = +arg('secs', 120), WARM = +arg('warm', 10), LIVE_RATE = +arg('live-rate', 300), TICK_RATE = +arg('tick-rate', 15), PORT = +arg('port', 8834);

const init = `(() => {
  const P = window.__perf = { on: false, ts: [], exec: [], charts: [], perFrame: [], tape: [], long: [], sockets: [] };
  const now = () => performance.now();
  const Real = window.WebSocket;
  function Spy(url, protocols) { const s = protocols === undefined ? new Real(url) : new Real(url, protocols); P.sockets.push(s); return s; }
  Spy.prototype = Real.prototype; for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Spy[k] = Real[k];
  window.WebSocket = Spy;
  // each chart's frame loop is one function, asked for first inside ChartEngine.create: tag it with the chart's element
  let creating = null, frameCost = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => {
    if (creating && !cb.__chartEl) cb.__chartEl = creating;
    const el = cb.__chartEl;
    return raf(ts => {
      if (!P.on) return cb(ts);
      const t0 = now(); cb(ts); const dt = now() - t0;
      if (el) {
        if (cb.__exec === undefined) cb.__exec = !document.querySelector('.ws-panel') || !!el.closest('.ws-panel.exec');
        if (cb.__exec) P.exec.push(dt);
        P.charts.push(dt); frameCost += dt;
      } else if (cb.name === 'drawTape') P.tape.push(dt);
    });
  };
  const loop = ts => { if (P.on) { P.ts.push(ts); P.perFrame.push(frameCost); } frameCost = 0; raf(loop); }; raf(loop);
  let CE;
  Object.defineProperty(window, 'ChartEngine', { configurable: true, get() { return CE; }, set(v) {
    const create = v.create; v.create = function (el) { creating = el; try { return create.apply(this, arguments); } finally { creating = null; } };
    CE = v;
  } });
  try { new PerformanceObserver(l => { if (P.on) for (const e of l.getEntries()) P.long.push(e.duration); }).observe({ type: 'longtask', buffered: false }); } catch (e) {}
})();`;

const q = (arr, p) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;

async function run(mode) {
  const bridge = spawn(process.execPath, [path.join(here, 'test', 'fake-bridge.mjs'), String(PORT), '--tick-rate=' + TICK_RATE, '--live-rate=' + LIVE_RATE, '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });
  const browser = await chromium.launch(Object.assign({ args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] }, process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}));
  try {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await ctx.addInitScript(init);
    // the single page: the execution chart's view (MNQ, Range 40)
    if (mode === 'single') await ctx.addInitScript(() => { try { localStorage.setItem('live-settings-v2', JSON.stringify({ root: 'MNQ', tf: 'range', glide: 'smooth', rangeMode: 'nt' })); localStorage.setItem('live-range-v2', JSON.stringify({ MNQ: 40 })); } catch (e) {} });
    if (mode === 'workspace' && VARIANT !== 'default') {
      const W = (await import('../live/workspace.js')).default;
      const keep = { 'no-tape': p => p.type !== 'tape', 'exec-only': p => p.exec, 'exec-tape': p => p.exec || p.type === 'tape' }[VARIANT];
      if (!keep) throw new Error('unknown --variant ' + VARIANT);
      const store = JSON.stringify({ v: 1, layouts: { Perf: { panels: W.defaultLayout().panels.filter(keep) } } });
      await ctx.addInitScript(v => { try { localStorage.setItem('workspace:live-workspace-v1', v); } catch (e) {} }, store);
    }
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    // cross-origin isolated, so performance.now() has 5 microsecond resolution instead of 100 (as perf-live)
    await ctx.route(/\/live\/(index\.html|workspace\.html)?(\?.*)?$/, async r => {
      const resp = await r.fetch();
      await r.fulfill({ response: resp, headers: Object.assign({}, resp.headers(), { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' }) });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const t0 = Date.now();
    await page.goto(`http://localhost:${PORT}/live/${mode === 'single' ? '' : 'workspace.html?layout=Perf'}`);
    await page.waitForSelector('.cb-pin-key', { timeout: 30000 });
    await enterPin(page, TEST_PIN);
    if (mode === 'single') await page.waitForFunction(() => { const e = document.getElementById('connPill'); return e && e.textContent === 'LIVE'; }, null, { timeout: 120000, polling: 200 });
    else await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 120000, polling: 200 });
    const loadMs = Date.now() - t0;
    await page.waitForTimeout(WARM * 1000);
    const heapStart = await page.evaluate(() => performance.memory.usedJSHeapSize);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const m0 = await metric();
    await page.evaluate(() => { window.__perf.on = true; });
    await page.waitForTimeout(SECS * 1000);
    const P = await page.evaluate(() => { const p = window.__perf; p.iso = self.crossOriginIsolated; p.on = false; return Object.assign({}, p, { sockets: p.sockets.filter(s => s.readyState === 1).length, socketsMade: p.sockets.length,
      heapEnd: performance.memory.usedJSHeapSize, tapeRows: document.querySelectorAll('.tp-row').length, tapeKept: window.workspace ? (window.workspace.views().find(v => v.type === 'tape') || {}).count : null }); });
    const m1 = await metric();
    const heapGc = await page.evaluate(() => { if (window.gc) window.gc(); return performance.memory.usedJSHeapSize; });

    // the renderer main thread's task time over the window (Chromium's TaskDuration), and how much of it was script
    const busyPct = (m1.TaskDuration - m0.TaskDuration) / SECS * 100, scriptPct = (m1.ScriptDuration - m0.ScriptDuration) / SECS * 100;
    const layoutPct = ((m1.LayoutDuration - m0.LayoutDuration) + (m1.RecalcStyleDuration - m0.RecalcStyleDuration)) / SECS * 100;

    const iv = []; for (let i = 1; i < P.ts.length; i++) iv.push(P.ts[i] - P.ts[i - 1]);
    return {
      page: mode === 'single' ? 'single chart page (MNQ Range 40)' : VARIANT === 'default' ? 'workspace default layout (4 charts + tape)' : 'workspace ' + VARIANT, secs: SECS, liveRatePerInstrument: LIVE_RATE, loadMs,
      fps: r2(iv.length / SECS), frameP50: r2(q(iv, 0.5)), frameP95: r2(q(iv, 0.95)), frameP99: r2(q(iv, 0.99)), frameMax: r2(Math.max(0, ...iv)), over33: iv.filter(d => d > 33.4).length,
      execChartP50: r3(q(P.exec, 0.5)), execChartP95: r3(q(P.exec, 0.95)), execChartP99: r3(q(P.exec, 0.99)), execChartMean: r3(P.exec.reduce((a, b) => a + b, 0) / (P.exec.length || 1)),
      allChartsPerFrameP50: r3(q(P.perFrame, 0.5)), allChartsPerFrameP95: r3(q(P.perFrame, 0.95)),
      tapeFrameP50: P.tape.length ? r3(q(P.tape, 0.5)) : null, tapeFrameP95: P.tape.length ? r3(q(P.tape, 0.95)) : null, tapeFrames: P.tape.length, tapeRows: P.tapeRows, tapeKept: P.tapeKept,
      mainThreadBusyPct: r2(busyPct), scriptPct: r2(scriptPct), layoutStylePct: r2(layoutPct), longTasks: P.long.length, longTaskMax: r2(Math.max(0, ...P.long)),
      heapStartMB: r2(heapStart / 1048576), heapEndMB: r2(P.heapEnd / 1048576), heapAfterGcMB: r2(heapGc / 1048576),
      crossOriginIsolated: P.iso, webSockets: P.sockets, webSocketsMade: P.socketsMade, errors,
    };
  } finally { await browser.close(); bridge.kill(); }
}

const results = [];
for (const m of MODE === 'both' ? ['single', 'workspace'] : [MODE]) results.push(await run(m));
const json = arg('json', '');
if (json) for (const r of results) fs.appendFileSync(json, JSON.stringify(r) + '\n');
console.log(JSON.stringify(results, null, 1));
