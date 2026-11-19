// Load time and bytes of one chart load, per view, against the fake bridge (test/fake-bridge.mjs, --live-first): the
// budget check for ChartBridge's delta table (nt8/PROTOCOL.md "The delta table"). Sample data only, never market data.
// Not part of `npm test`: about a minute a view.
//
//   node test/perf-delta-load.mjs [--views=m1,m5,range,s15] [--runs=3] [--et=16:55] [--tick-rate=15] [--live-rate=50]
//                                 [--port=8860] [--serve-root=DIR] [--bridge-flags=--delta-table] [--json=FILE]
//
// --et sets the page and bridge clocks to that New York time (16:55, the default, is the end of a full session: about
// 82,500 seconds of it, nearly every one with trades at --tick-rate 15). Each view is loaded once to warm the bridge (the
// first served window is "asked of NinjaTrader"), then --runs times in a fresh tab. For each load: the milliseconds from
// navigation to the chart's LIVE badge, to the delta pane built (its core handed to the chart), the bytes the page's
// WebSocket received up to and including `ready` (with the delta table message's own bytes), and the trades the window held.
// --serve-root serves the page from another checkout (to measure the page before a change on the same fake);
// --bridge-flags passes flags to the fake (comma separated), for example --delta-table to serve the table.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { hostUrl } from './chart-host.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, d) => { const a = process.argv.slice(2).find(x => x === '--' + name || x.startsWith('--' + name + '=')); return a === undefined ? d : a.includes('=') ? a.slice(a.indexOf('=') + 1) : true; };
const VIEWS = String(arg('views', 'm1,m5,range,s15')).split(',').filter(Boolean), RUNS = +arg('runs', 3);
const ET = String(arg('et', '16:55')), PORT = +arg('port', 8860), TICK_RATE = +arg('tick-rate', 15), LIVE_RATE = +arg('live-rate', 50);
const ROOT = path.resolve(String(arg('serve-root', here))), JSON_OUT = arg('json', '');
const EXTRA = String(arg('bridge-flags', '')).split(',').filter(Boolean);
const OFFSET = (() => {
  const [h, m] = ET.split(':').map(Number), fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  const cur = +p.hour * 3600 + +p.minute * 60 + +p.second;
  let off = -(((cur - (h * 3600 + m * 60)) % 86400 + 86400) % 86400);
  // a weekday's session: from Saturday or Sunday go back to Friday
  const back = { Sat: 1, Sun: 2 }[p.weekday] || 0;
  return off - back * 86400;
})();

const bridge = spawn(process.execPath, [path.join(here, 'test', 'fake-bridge.mjs'), String(PORT), '--serve-root=' + ROOT, '--live-first', '--pin-off',
  '--tick-rate=' + TICK_RATE, '--live-rate=' + LIVE_RATE, '--clock-offset=' + OFFSET].concat(EXTRA), { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });

const init = tf => `(() => {
  const realNow = Date.now; Date.now = () => realNow() + ${OFFSET * 1000};
  try {
    const s = { root: 'NQ', tf: ${JSON.stringify(tf)}, glide: 'smooth', rangeMode: 'nt' };
    localStorage.setItem('live-settings-v2', JSON.stringify(s));
    localStorage.setItem('live-range-v2', JSON.stringify({ NQ: 40 }));
  } catch (e) {}
})();`;

const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const results = {};
let browser;
try {
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  for (const view of VIEWS) {
    const runs = [];
    for (let k = 0; k <= RUNS; k++) {
      const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
      await ctx.addInitScript(init(view));
      await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
      const page = await ctx.newPage();
      const wire = { bytes: 0, deltaBytes: 0, ticksBytes: 0, done: false, types: {} };
      page.on('websocket', ws => ws.on('framereceived', f => {
        if (wire.done) return;
        const s = typeof f.payload === 'string' ? f.payload : '';
        const len = Buffer.byteLength(s);
        const m = /"type":"([A-Za-z]+)"/.exec(s), t = m ? m[1] : '?';
        if (t === 'tick') return;                         // live trades are not the load
        wire.bytes += len; wire.types[t] = (wire.types[t] || 0) + len;
        if (t === 'deltaTable') wire.deltaBytes += len;
        if (t === 'ticks') wire.ticksBytes += len;
        if (t === 'ready') wire.done = true;
      }));
      const t0 = Date.now();
      await page.goto(hostUrl(PORT));
      await page.waitForFunction(() => { const b = document.querySelector('[id$="-badge"]'); return !!b && b.dataset.conn === 'live'; }, null, { timeout: 180000, polling: 10 });
      const live = Date.now() - t0;
      await page.waitForFunction(() => { const D = window.liveMount.data(); return !!D.delta; }, null, { timeout: 180000, polling: 10 });
      const delta = Date.now() - t0;
      const info = await page.evaluate(() => { const D = window.liveMount.data(); return { trades: D.ticks.length, backfill: D.backfill, bars: D.delta ? D.delta.bars.length : 0, cum: D.delta && D.delta.last ? D.delta.last.c : null, by: D.deltaCov ? D.deltaCov.by : '' }; });
      await ctx.close();
      if (k === 0) continue;                              // the warm-up
      runs.push({ liveMs: live, deltaMs: delta, bytes: wire.bytes, deltaBytes: wire.deltaBytes, ticksBytes: wire.ticksBytes, types: wire.types, info });
      console.log(view + ' run ' + k + ': live ' + live + ' ms, delta built ' + delta + ' ms, ' + (wire.bytes / 1e6).toFixed(3) + ' MB to ready (table ' + (wire.deltaBytes / 1e6).toFixed(3) + ' MB, ticks ' + (wire.ticksBytes / 1e6).toFixed(3) + ' MB), store ' + info.trades + ' trades, delta by ' + info.by + ', ' + info.bars + ' delta bars');
    }
    results[view] = { liveMs: median(runs.map(r => r.liveMs)), deltaMs: median(runs.map(r => r.deltaMs)), bytes: median(runs.map(r => r.bytes)), deltaBytes: median(runs.map(r => r.deltaBytes)), ticksBytes: median(runs.map(r => r.ticksBytes)), runs };
    console.log(view + ' median: live ' + results[view].liveMs + ' ms, delta ' + results[view].deltaMs + ' ms, ' + (results[view].bytes / 1e6).toFixed(3) + ' MB');
  }
} finally {
  if (browser) await browser.close();
  bridge.kill();
}
if (JSON_OUT) fs.writeFileSync(String(JSON_OUT), JSON.stringify({ et: ET, tickRate: TICK_RATE, liveRate: LIVE_RATE, extra: EXTRA, results }, null, 1));
