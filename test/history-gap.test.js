// Chart 1.38.1 and ChartBridge 0.6.8 (WORK 2026-10-23: after a reload an NQ 1 min chart had no bars from about 10:40 to the live
// bar at 11:08, and the League chart sat on LOADING for 50 s). The page's pure rule for the hole notice (LivePrefs.histGapText,
// the same words ChartBridge 0.6.8 sends), the page's wiring (no sessionStorage cache of bars), and ChartBridge's minute book in
// the source (its stamping, its lock order, the time limits); its behaviour is nt8/check/GapHarness.cs under Mono.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { LivePrefs: LP } = require('../live/live.js');
const CE = require('../src/chart-engine.js');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const et = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s || 0) / 1000;   // New York wall clock as if UTC (the chart's convention)
const closed = CE.util.cmeClosed;

test('1.38.1: the hole notice says the minutes with no bars, in bar start times, as ChartBridge 0.6.8 does', () => {
  // the WORK case: the last history bar starts 10:40, ready at 11:08:20 on a Wednesday
  assert.equal(LP.histGapText(et(2026, 10, 21, 10, 40), et(2026, 10, 21, 11, 8, 20), closed), "No bars from 10:41 to 11:08 ET: NinjaTrader's minute history ends at 10:40");
  // 2 minutes or less: none (a quiet minute is not a hole); just over: said
  assert.equal(LP.histGapText(et(2026, 10, 21, 11, 5), et(2026, 10, 21, 11, 8), closed), '');
  assert.equal(LP.histGapText(et(2026, 10, 21, 11, 5), et(2026, 10, 21, 11, 8, 1), closed), "No bars from 11:06 to 11:08 ET: NinjaTrader's minute history ends at 11:05");
  // the 17:00 break and a weekend are no hole; a Sunday open with Friday's history names the days and counts the open minutes only
  assert.equal(LP.histGapText(et(2026, 10, 21, 16, 59), et(2026, 10, 21, 18, 1, 30), closed), '');
  assert.equal(LP.histGapText(et(2026, 10, 23, 16, 59), et(2026, 10, 25, 18, 1), closed), '');
  assert.equal(LP.histGapText(et(2026, 10, 23, 16, 59), et(2026, 10, 25, 18, 9, 30), closed), "No bars from Sun 18:00 to Sun 18:09 ET: NinjaTrader's minute history ends at Fri 16:59");
  assert.equal(LP.histGapText(NaN, et(2026, 10, 21, 11, 0), closed), '');
  assert.equal(LP.LOAD_WAIT_S, 10);
});

test('1.38.1: the page says LOADING waits and the hole, and keeps no bars in sessionStorage', () => {
  const live = read('live/live.js');
  assert.match(live, /setStatus\('Waiting for NinjaTrader\\'s ' \+ D\.root \+ ' history \(' \+ sec \+ ' s\)', ''\);/);
  assert.match(live, /if \(m && typeof m\.filled === 'number' && m\.filled > 0\) return;/, 'no notice when ChartBridge filled the minutes from its own bars');
  assert.match(live, /if \(m\.level === 'warn' && D\.gapText && \/\^No bars from \/\.test/, 'ChartBridge\'s status for the same hole is not shown twice');
  assert.doesNotMatch(live, /sessionStorage/, 'no sessionStorage bar cache (Anthony\'s instruction)');
  for (const f of ['live/live.js', 'live/league.js', 'live/agents-sky.js', 'live/agents-strip.js', 'live/workspace.js', 'nt8/ChartBridge.cs', 'nt8/PROTOCOL.md', 'nt8/check/GapHarness.cs', 'test/history-gap.test.js', 'test/fake-bridge.mjs', 'CHANGELOG.md'])
    assert.doesNotMatch(read(f), /[\u2013\u2014]/, f + ': no em or en dashes');
});

test('1.38.1 (Anthony 2026-10-23): the League chart and the Drone sky are NQ 1 min; the seats\' MNQ prices drawn unconverted', () => {
  const lg = read('live/league.js');
  assert.match(lg, /root: 'NQ', busy: false \}/);
  assert.match(lg, />NQ 1 min \(league trades MNQ\)</);
  assert.match(lg, /view: \{ root: S\.root, tf: 'm1' \}/, 'the League chart keeps the 1 min view: 5 days, no ticks (LivePrefs.daysFor)');
  assert.equal(LP.daysFor('m1'), 5);
  assert.match(lg, /const ROOTS = \['MNQ', 'NQ'\];/, 'the marks draw on NQ and MNQ charts at their own prices');
  const sky = read('live/agents-sky.js');
  assert.match(sky, /ctx\.fillText\(fit\(SKY_ROOT \+ ' ' \+ fmtPx\(last\)/, 'the sky\'s price label says NQ');
  assert.doesNotMatch(sky, /'MNQ ' \+|Waiting for MNQ|watching MNQ/);
});

test('0.6.8: ChartBridge keeps a minute book per instrument and joins it to NinjaTrader\'s minute answer at one seam', () => {
  const cs = read('nt8/ChartBridge.cs');
  assert.match(cs, /public const string Version = "0\.6\.8";/);
  // stamped at the close, end-inclusive, as TailFromTicks and NinjaTrader
  assert.match(cs, /public static long CloseOf\(long t\) \{ long rem = t % Minute; return rem == 0 \? t : t - rem \+ Minute; \}/);
  // fed under the book's lock in OnMarketData, reset on a feed drop
  assert.match(cs, /mb\.Add\(e\.Time, e\.Price, e\.Volume\);/);
  assert.match(cs, /b\.Minutes\.Reset\(why\);/);
  // the time limits and no pile of requests
  assert.match(cs, /public static int MinuteTimeoutMs = 20000, TailTimeoutMs = 20000, OverdueReaskMs = 120000;/);
  assert.match(cs, /if \(Interlocked\.Exchange\(ref L\.ReadyOnce, 1\) != 0\) return;/);
  // the order path is untouched: the minute book never reaches ChartBridgeOrders
  assert.doesNotMatch(read('nt8/ChartBridgeOrders.cs'), /MinuteBook|MinuteSnap|Minutes\./);
  // lock order: nothing takes a page's Pending lock and then a book's
  assert.doesNotMatch(cs, /lock \([a-zA-Z.]*Pending\)\s*lock \([a-z]+\.Sync\)/);
});
