// Chart 1.38.1 and ChartBridge 0.6.8 (WORK 2026-10-23: after a reload an NQ 1 min chart had no bars from about 10:40 to the live
// bar at 11:08, and the League chart sat on LOADING for 50 s). The page's wiring (the LOADING wait, no hole notice, no
// sessionStorage cache of bars), and ChartBridge's minute book in the source (its stamping, its lock order, the time limits, the
// window path); its behaviour is nt8/check/GapHarness.cs and WindowGapHarness.cs under Mono.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { LivePrefs: LP } = require('../live/live.js');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('1.38.1: the page says a LOADING that waits, shows no hole notice (Anthony: "I dont need a notice"), and keeps no bars in sessionStorage', () => {
  const live = read('live/live.js');
  assert.match(live, /setStatus\('Waiting for NinjaTrader\\'s ' \+ D\.root \+ ' history \(' \+ sec \+ ' s\)', ''\);/);
  assert.equal(LP.LOAD_WAIT_S, 10);
  assert.doesNotMatch(live, /No bars from|gapNotice|histGapText/, 'no hole notice on the page');
  const cs = read('nt8/ChartBridge.cs');
  assert.doesNotMatch(cs, /AfterReady\(L, Status\("warn", L\.Hole\)\)/, 'ChartBridge sends no hole status to the page');
  assert.match(cs, /if \(L\.Hole != null\) HistoryNote\(L\.Root, "history ends early: "/, 'the hole is recorded: /diag and history.log');
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
  // tick charts (Anthony 2026-10-23): the book copied for every load, the same rebuild rule on both paths, the time limit
  assert.match(cs, /L\.Book = book\.Minutes\.Snap\(\);   \/\/ every load/);
  assert.equal((cs.match(/RawBars tail = RebuildTail\(L, ticks\);/g) || []).length, 2, 'Finish and FinishWindow share the rebuild');
  assert.equal((cs.match(/if \(L\.RebuiltTailVolume < L\.NtTailVolume\) tail = null;/g) || []).length, 0, 'no rebuild is thrown away whole');
  // the order path is untouched: the minute book never reaches ChartBridgeOrders
  assert.doesNotMatch(read('nt8/ChartBridgeOrders.cs'), /MinuteBook|MinuteSnap|Minutes\./);
  // lock order: nothing takes a page's Pending lock and then a book's
  assert.doesNotMatch(cs, /lock \([a-zA-Z.]*Pending\)\s*lock \([a-z]+\.Sync\)/);
});
