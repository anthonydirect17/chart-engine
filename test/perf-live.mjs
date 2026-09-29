// Live page load benchmark: the fake bridge (test/fake-bridge.mjs) streams sample NQ trades at a busy-market rate
// over a tick backfill of up to about 2 million trades, and headless Chromium measures what the chart costs.
// Sample data only, never market data. Not part of `npm test`: it takes about a minute per run.
//
//   node test/perf-live.mjs [--view=range|m1] [--secs=30] [--root=DIR] [--label=main] [--port=8830]
//                           [--tick-rate=15] [--live-rate=100] [--range=40] [--et=HH:MM] [--second-tab] [--embed]
//                           [--headed] [--profile] [--json=FILE]
//
// --root serves the page from another checkout (the bridge is always this one), so an older version can be measured
// on the same feed. It sets the saved settings (NQ, the view, Range 40, NinjaTrader style) in both the 1.3 and the
// 1.4 keys before the page loads. --et runs the page and bridge clocks at that New York time (01:30 loads the most
// Range history, 33 hours). --embed measures ChartLive.mount in test/embed-host.html (1.5.0 and later) instead of the
// standalone page. CHROMIUM_PATH=/path/to/chrome uses a preinstalled browser.
//
// Measures, over the window after a warm-up: requestAnimationFrame intervals (frames over 16.7 ms and 33 ms), the
// chart's own frame callback (step and draw), long tasks, each live tick message (JSON, onTick, the bar builders,
// chart update), GC pauses and layout from a Chromium trace, and heap growth. --profile adds a CPU profile (top
// functions by self time); it slows the page, so its numbers are only for finding where the time goes.
// ChartBridge 0.3.2's PIN: the fake bridge starts with a made-up test PIN, typed on the standalone page's pad before
// the measurement (a page from an older --root has no pad and goes straight on). --embed connects with single-use
// tickets, like The Desk's relay, which needs no ChartBridge PIN. A --root older than the PIN (no live/pin.js) gets a
// bridge with --pin-off.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, unlockIfAsked } from './smoke-pin.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, d) => { const a = process.argv.slice(2).find(x => x === '--' + name || x.startsWith('--' + name + '=')); return a === undefined ? d : a.includes('=') ? a.slice(a.indexOf('=') + 1) : true; };
const VIEW = arg('view', 'range'), SECS = +arg('secs', 30), ROOT = path.resolve(arg('root', here)), LABEL = arg('label', path.basename(ROOT));
const PORT = +arg('port', 8830), TICK_RATE = +arg('tick-rate', 15), LIVE_RATE = +arg('live-rate', 100), RANGE = +arg('range', 40);
const ET = arg('et', '');                  // a time of day in New York (HH:MM) for the page and the bridge clocks
const OFFSET = (() => {
  if (!ET) return 0;
  const [h, m] = ET.split(':').map(Number), fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, +x.value]));
  const cur = p.hour * 3600 + p.minute * 60 + p.second;
  return -(((cur - (h * 3600 + m * 60)) % 86400 + 86400) % 86400);
})();
const HEADED = !!arg('headed', false), EMBED = !!arg('embed', false);   // a real window (run under xvfb-run on a server)
const SECOND = !!arg('second-tab', false), PROFILE = !!arg('profile', false), WARM = +arg('warm', 5);

const bridge = spawn(process.execPath, [path.join(here, 'test', 'fake-bridge.mjs'), String(PORT), '--serve-root=' + ROOT,
  '--tick-rate=' + TICK_RATE, '--live-rate=' + LIVE_RATE, '--clock-offset=' + OFFSET, '--test-pin=' + TEST_PIN].concat(EMBED ? ['--tickets'] : []).concat(fs.existsSync(path.join(ROOT, 'live', 'pin.js')) ? [] : ['--pin-off']), { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });

const settings = { root: 'NQ', tf: VIEW === 'm1' ? 'm1' : 'range', glide: 'smooth' };
const init = `(() => {
  const realNow = Date.now; Date.now = () => realNow() + ${OFFSET * 1000};
  try {
    localStorage.setItem('live-settings-v1', ${JSON.stringify(JSON.stringify(settings))});
    localStorage.setItem('live-range-v1', ${JSON.stringify(JSON.stringify({ NQ: RANGE }))});
    localStorage.setItem('live-settings-v2', ${JSON.stringify(JSON.stringify(Object.assign({ rangeMode: 'nt' }, settings)))});
    localStorage.setItem('live-range-v2', ${JSON.stringify(JSON.stringify({ NQ: RANGE }))});
  } catch (e) {}
  const P = window.__perf = { backfill: 0, tickHours: null, lagMax: 0, lag: [], on: false, tick: [], rafCb: [], ts: [], long: [], heap: [], update: 0, updateN: 0, setBars: 0, setBarsN: 0, add: 0, addN: 0 };
  const now = () => performance.now();
  const d = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
  Object.defineProperty(WebSocket.prototype, 'onmessage', { configurable: true, get() { return d.get.call(this); }, set(fn) {
    const send = this.send; this.send = function (x) { try { const m = JSON.parse(x); if (m.type === 'subscribe') { P.tickHours = m.tickHours; P.backfill = 0; } } catch (e) {} return send.apply(this, arguments); };
    d.set.call(this, ev => {
      if (typeof ev.data === 'string' && ev.data.startsWith('{"type":"ticks"')) P.backfill += JSON.parse(ev.data).ticks.length;
      if (!P.on || typeof ev.data !== 'string' || !ev.data.startsWith('{"type":"tick"')) return fn(ev);
      const t0 = now(); fn(ev); P.tick.push(now() - t0);
    });
  } });
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => raf(ts => { const lag = now() - ts; if (lag > P.lagMax) P.lagMax = lag; if (!P.on) return cb(ts); P.lag.push(lag); const t0 = now(); cb(ts); P.rafCb.push(now() - t0); });
  const loop = ts => { if (P.on) P.ts.push(ts); raf(loop); }; raf(loop);
  const timed = (obj, k) => { const f = obj[k]; obj[k] = function () { if (!P.on) return f.apply(this, arguments); const t0 = now(); const r = f.apply(this, arguments); P[k] += now() - t0; P[k + 'N']++; return r; }; };
  let CE, BB;
  Object.defineProperty(window, 'ChartEngine', { configurable: true, get() { return CE; }, set(v) {
    const create = v.create; v.create = function () { const c = create.apply(this, arguments); timed(c, 'update'); timed(c, 'setBars'); window.__chart = c; return c; };
    CE = v;
  } });
  Object.defineProperty(window, 'BarBuilder', { configurable: true, get() { return BB; }, set(v) { if (v && v.BarBuilder) timed(v.BarBuilder.prototype, 'add'); BB = v; } });
  try { new PerformanceObserver(l => { if (P.on) for (const e of l.getEntries()) P.long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: false }); } catch (e) {}
  setInterval(() => { if (P.on && performance.memory) P.heap.push([now(), performance.memory.usedJSHeapSize]); }, 1000);
})();`;

const q = (arr, p) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;

let browser = null, result = null;
try {
  browser = await chromium.launch(Object.assign({ headless: !HEADED, args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] },
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}));
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(init);
  // cross-origin isolated, so performance.now() has 5 microsecond resolution instead of 100
  await ctx.route(/\/live\/(index\.html)?$|\/test\/embed-host\.html$/, async r => {
    const resp = await r.fetch();
    await r.fulfill({ response: resp, headers: Object.assign({}, resp.headers(), { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' }) });
  });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const errors = [];
  const open = async () => {
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    const t0 = Date.now();
    if (EMBED) {
      await page.goto(`http://localhost:${PORT}/test/embed-host.html`);
      await page.evaluate(url => { window.ChartLive.mount(document.getElementById('paneA'), { wsUrl: () => url + '?ticket=' + Math.random().toString(36).slice(2), storagePrefix: '' }); document.getElementById('paneB').remove(); }, `ws://localhost:${PORT}/ws`);
    } else { await page.goto(`http://localhost:${PORT}/live/`); await unlockIfAsked(page, TEST_PIN, 120000); }
    await page.waitForFunction(() => { const el = document.querySelector('[id$="connPill"]'); return el && el.textContent === 'LIVE'; }, null, { timeout: 120000, polling: 200 });
    return { page, loadMs: Date.now() - t0 };
  };
  const other = SECOND ? await open() : null;
  const { page, loadMs } = await open();
  await page.bringToFront();
  await page.waitForTimeout(WARM * 1000);
  const before = await page.evaluate(() => ({ iso: self.crossOriginIsolated, bars: window.__chart.bars().length, heap: performance.memory && performance.memory.usedJSHeapSize, version: window.ChartEngine.VERSION }));
  const cdp = await ctx.newCDPSession(page);
  if (PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 100 }); await cdp.send('Profiler.start'); }
  await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'disabled-by-default-v8.gc', 'blink.user_timing', 'toplevel'] });
  await page.evaluate(() => { window.__perf.on = true; });
  await page.waitForTimeout(SECS * 1000);
  const P = await page.evaluate(() => { window.__perf.on = false; const p = window.__perf; return Object.assign({}, p, { bars: window.__chart.bars().length, stats: window.__chart.stats() }); });
  const trace = JSON.parse((await browser.stopTracing()).toString());
  let profile = null;
  if (PROFILE) profile = (await cdp.send('Profiler.stop')).profile;

  // ---- trace: the page's renderer main thread
  const ev = trace.traceEvents || trace;
  const mains = new Map();
  for (const e of ev) if (e.ph === 'M' && e.name === 'thread_name' && e.args && e.args.name === 'CrRendererMain') mains.set(e.pid + ':' + e.tid, true);
  let busiest = null, counts = new Map();
  for (const e of ev) if (e.ph === 'X' && e.name === 'FunctionCall' && mains.has(e.pid + ':' + e.tid)) counts.set(e.pid + ':' + e.tid, (counts.get(e.pid + ':' + e.tid) || 0) + 1);
  for (const [k, n] of counts) if (!busiest || n > counts.get(busiest)) busiest = k;
  const onMain = e => e.pid + ':' + e.tid === busiest;
  const sum = {}, list = {};
  const add = (k, dur) => { sum[k] = (sum[k] || 0) + dur; (list[k] = list[k] || []).push(dur); };
  for (const e of ev) {
    if (e.ph !== 'X' || !onMain(e) || !e.dur) continue;
    const ms = e.dur / 1000;
    if (e.name === 'MajorGC' || e.name === 'MinorGC') add(e.name, ms);
    else if (e.name === 'V8.GC_MC_BACKGROUND_MARKING') { /* background */ }
    else if (e.name === 'Layout' || e.name === 'UpdateLayoutTree' || e.name === 'Paint' || e.name === 'PrePaint' || e.name === 'Layerize' || e.name === 'Commit') add(e.name, ms);
    else if (e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') add('Task', ms);
  }
  const gcAll = (list.MajorGC || []).concat(list.MinorGC || []);

  // ---- frames
  const iv = []; for (let i = 1; i < P.ts.length; i++) iv.push(P.ts[i] - P.ts[i - 1]);
  const FRAME = 1000 / 60;
  const dropped = iv.reduce((s, d) => s + Math.max(0, Math.round(d / FRAME) - 1), 0);
  const heap0 = P.heap.length ? P.heap[0][1] : 0, heap1 = P.heap.length ? P.heap[P.heap.length - 1][1] : 0;

  result = {
    label: LABEL + (EMBED ? ' (embedded)' : ''), version: before.version, embed: EMBED, view: VIEW === 'm1' ? '1m' : 'Range ' + RANGE, secs: SECS, secondTab: SECOND, crossOriginIsolated: before.iso,
    et: ET || 'now', headed: HEADED, rafLagMaxMs: r2(P.lagMax), rafLagWindowP99: r2(q(P.lag, 0.99)), rafLagWindowMax: r2(Math.max(0, ...P.lag)), frameLoopAlive: P.rafCb.length > 0, tickHours: P.tickHours, backfillTicks: P.backfill, loadMs, bars: P.bars, liveTicks: P.tick.length, ticksPerSec: r2(P.tick.length / SECS),
    frames: iv.length, fps: r2(iv.length / SECS), frameP50: r2(q(iv, 0.5)), frameP99: r2(q(iv, 0.99)), frameMax: r2(Math.max(0, ...iv)),
    over16: iv.filter(d => d > FRAME * 1.25).length, over33: iv.filter(d => d > 33.4).length, over50: iv.filter(d => d > 50).length, droppedFrames: dropped,
    chartFrameMeanMs: r3(mean(P.rafCb)), chartFrameP95: r3(q(P.rafCb, 0.95)), chartFrameP99: r3(q(P.rafCb, 0.99)), chartFrameMax: r2(Math.max(0, ...P.rafCb)),
    longTasks: P.long.length, longTaskMs: r2(P.long.reduce((s, x) => s + x[1], 0)), longTaskMax: r2(Math.max(0, ...P.long.map(x => x[1]))),
    tickMeanUs: r2(mean(P.tick) * 1000), tickP99Us: r2(q(P.tick, 0.99) * 1000), tickMaxMs: r2(Math.max(0, ...P.tick)),
    addPerTickUs: r2(P.tick.length ? P.add / P.tick.length * 1000 : 0), updatePerTickUs: r2(P.tick.length ? P.update / P.tick.length * 1000 : 0), updateCalls: P.updateN,
    gcCount: gcAll.length, majorGC: (list.MajorGC || []).length, gcMs: r2(gcAll.reduce((a, b) => a + b, 0)), gcMaxMs: r2(Math.max(0, ...gcAll)),
    gcPauses: gcAll.filter(x => x >= 5).map(r2).sort((a, b) => b - a).slice(0, 12),
    layoutMs: r2((sum.Layout || 0) + (sum.UpdateLayoutTree || 0)), paintMs: r2((sum.Paint || 0) + (sum.PrePaint || 0) + (sum.Layerize || 0)), taskMs: r2(sum.Task || 0),
    heapStartMB: r2(heap0 / 1048576), heapEndMB: r2(heap1 / 1048576), heapGrowthMBps: r2((heap1 - heap0) / 1048576 / SECS),
    errors,
  };
  if (profile) {
    const byId = new Map(profile.nodes.map(n => [n.id, n]));
    const dt = profile.timeDeltas, self = new Map();
    for (let i = 0; i < profile.samples.length; i++) {
      const n = byId.get(profile.samples[i]), cf = n.callFrame;
      const k = (cf.functionName || '(anonymous)') + ' ' + (cf.url ? cf.url.split('/').slice(-2).join('/') + ':' + (cf.lineNumber + 1) : '');
      self.set(k, (self.get(k) || 0) + (dt[i] || 0) / 1000);
    }
    const total = [...self.values()].reduce((a, b) => a + b, 0);
    result.profileTop = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, ms]) => ({ fn: k, ms: r2(ms), pct: r2(ms / total * 100) }));
  }
} finally {
  if (browser) await browser.close();
  bridge.kill();
}
const json = arg('json', '');
if (json) fs.appendFileSync(json, JSON.stringify(result) + '\n');
console.log(JSON.stringify(result, null, 1));
