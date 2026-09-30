// Smoothness smoke (1.5.1): the live page on Range 40 at 01:30 ET, when it loads the most history (33 hours, about
// 1.8 million sample trades), then a busy market (150 trades a second, bursts of 450). Loads it three times, since
// what broke 1.4.x and 1.5.0 depends on timing (their frame loop stopped after 8 of 10 such loads here).
// Fails on: a page error, a chart that stopped drawing, more than 3 frames over 50 ms, or ticks back on the heap.
// The volume profile (unreleased) is on in every load (PERF_SMOKE_VP=0 for off, =rth for its RTH choice), so its build
// at load and its drawing at the right edge are measured too. The RTH choice runs at 13:30 ET (PERF_SMOKE_ET to change),
// when there is an RTH profile to draw; the others at 01:30, when the page loads the most history. At 13:30 the Range
// backfill is one session, so the RTH run asks for denser sample ticks (17 a second, not 15) to stay over a million.
//   npm run smoke:perf           (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser; about 90 s)
//   PERF_SMOKE_ROOT=../old-checkout npm run smoke:perf    measures another checkout's page on the same feed
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.PERF_SMOKE_PORT || 8837);
const out = path.join(os.tmpdir(), 'perf-smoke-' + process.pid + '.jsonl');
const LOADS = 3, HEAP_MB = 80;
const RTH = process.env.PERF_SMOKE_VP === 'rth';
const ET = process.env.PERF_SMOKE_ET || (RTH ? '13:30' : '01:30'), TICK_RATE = +process.env.PERF_SMOKE_TICK_RATE || (RTH ? 17 : 15);
const errors = [];
for (let i = 0; i < LOADS; i++) {
  const args = [path.join(here, 'test', 'perf-live.mjs'), '--view=range', '--secs=10', '--warm=3', '--et=' + ET, '--tick-rate=' + TICK_RATE, '--live-rate=150',
    '--port=' + (PORT + i), '--json=' + out, '--root=' + path.resolve(process.env.PERF_SMOKE_ROOT || here)]
    .concat(process.env.PERF_SMOKE_VP === '0' ? [] : [process.env.PERF_SMOKE_VP === 'rth' ? '--vp=rth' : '--vp']);
  const r = spawnSync(process.execPath, args, { stdio: ['ignore', 'ignore', 'inherit'], timeout: 180000 });
  if (r.status !== 0) { errors.push('load ' + (i + 1) + ': perf-live exited ' + r.status); continue; }
}
const runs = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
fs.rmSync(out, { force: true });
runs.forEach((d, i) => {
  const tag = 'load ' + (i + 1) + ' (' + d.version + ', ' + d.backfillTicks.toLocaleString() + ' ticks)';
  console.log(tag + ': chart frames ' + (d.frameLoopAlive ? 'running' : 'STOPPED') + ', frames over 50 ms ' + d.over50 + ', long tasks ' + d.longTasks + (d.volumeProfile ? ', volume profile ' + d.volumeProfile.mode + ' (' + d.volumeProfile.volumeAtStart + ' contracts, bars rebuilt ' + d.volumeProfile.builds + ' times)' : '') +
    ', tick ' + d.tickMeanUs + ' us, chart frame ' + d.chartFrameMeanMs + ' ms, GC max ' + d.gcMaxMs + ' ms, heap ' + d.heapEndMB + ' MB');
  for (const e of d.errors) errors.push(tag + ': page error: ' + e);
  if (d.backfillTicks < 1000000) errors.push(tag + ': backfill too small to test (' + d.backfillTicks + ')');
  if (!d.frameLoopAlive) errors.push(tag + ': the chart stopped drawing');
  if (d.over50 > 3) errors.push(tag + ': ' + d.over50 + ' frames over 50 ms');
  if (d.volumeProfile && (d.volumeProfile.volumeAtStart === null || d.volumeProfile.volumeAtStart === undefined)) errors.push(tag + ': the volume profile was not on');   // RTH at 01:30 is on and empty
  if (d.heapEndMB > HEAP_MB) errors.push(tag + ': JavaScript heap ' + d.heapEndMB + ' MB (over ' + HEAP_MB + ')');
});
if (runs.length < LOADS) errors.push('only ' + runs.length + ' of ' + LOADS + ' loads measured');
if (errors.length) { console.error('perf smoke FAILED:\n  ' + errors.join('\n  ')); process.exit(1); }
console.log('perf smoke ok: ' + runs.length + ' loads');
