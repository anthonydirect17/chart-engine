'use strict';
// Guards on ChartBridgeTicks.cs (the NQ tick file to The Desk, the Sunday 11-01 build) and its hooks in ChartBridge.cs and
// ChartBridgeBars.cs. NinjaTrader cannot run here, so these check the code itself; the behaviour (the queue's bound, the raw
// lines, the chunks, the check, the final pull through the gate) runs under Mono in nt8/check/BarsHarness.cs (npm run check:orders).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const strip = src => src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '').replace(/([;{})])\s*\/\/.*$/, '$1')).join('\n');
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, 'not found: ' + a); const j = b ? s.indexOf(b, i + a.length) : s.length; return s.slice(i, j < 0 ? s.length : j); };
const ticks = strip(read('nt8', 'ChartBridgeTicks.cs'));
const main = strip(read('nt8', 'ChartBridge.cs'));
const bars = strip(read('nt8', 'ChartBridgeBars.cs'));

test('tick file: C# 5 only', () => {
  assert.ok(!/(^|[\s(=,+:?])\$"/m.test(ticks), 'string interpolation');
  assert.ok(!/\?\.\w/.test(ticks), 'null-conditional ?.');
  assert.ok(!/\bnameof\(/.test(ticks), 'nameof');
  assert.ok(!/\{ get; \} =/.test(ticks), 'auto-property initializers');
  assert.ok(!/\bout var\b/.test(ticks), 'out var');
});

test('tick file: never an order, never the order lane, never an account in a message', () => {
  const forbidden = [/\.Submit\s*\(/, /\.CreateOrder\s*\(/, /\.Change\s*\(/, /\.Flatten\s*\(/, /\.Cancel\s*\(/, /CancelAllOrders/, /\bAtm\w*\./,
    /\bOrderAction\./, /ChartBridgeOrders\./, /\.Send\(|SendData\(|SendAll\(|SendToTraders\(|OrderLane/, /Account\./, /\.Name\b/];
  for (const re of forbidden) assert.ok(!re.test(ticks), 'found in ChartBridgeTicks.cs: ' + re);
});

test('tick file: the hot path is one counter and one enqueue, a full queue drops and counts', () => {
  const hot = between(ticks, 'public static void OnTrade(', 'public static void NoteFeedDrop(');
  assert.match(hot, /if \(!capturing \|\| root != Root\) return;/, 'NQ only, nothing while off');
  assert.match(hot, /if \(Interlocked\.Increment\(ref queued\) > QueueMax\)\s*\{\s*Interlocked\.Decrement\(ref queued\);\s*Interlocked\.Increment\(ref droppedQueue\);/);
  assert.match(hot, /Queue\.Enqueue\(/);
  for (const re of [/\block\s*\(/, /File\./, /FileStream/, /Wait\(/, /Sleep\(/, /Log\(/, /UtcNow/, /NowUtcMs/]) assert.ok(!re.test(hot), 'the hot path must not ' + re);
});

test('tick file: hooked in OnMarketData after the pages and the tape, in its own try; started, stopped, in /diag', () => {
  const md = between(main, 'private static void OnMarketData(', '// ---------------------------------------------------------- history backfill');
  const pages = md.indexOf('c.Send(json)'), tape = md.indexOf('ChartBridgeTape.OnPrint('), cap = md.indexOf('ChartBridgeTicks.OnTrade(');
  assert.ok(pages > 0 && tape > pages && cap > tape, 'after the pages and the tape counters');
  assert.match(md, /try \{ ChartBridgeTicks\.OnTrade\([^;]*\); \}\s*catch \(Exception\) \{ \}/);
  assert.match(main, /ChartBridgeTicks\.Start\(\);/);
  assert.match(main, /ChartBridgeTicks\.Stop\(\);/);
  assert.match(main, /b\.Append\(",\\"tickFile\\":"\)\.Append\(ChartBridgeTicks\.DiagJson\(\)\);/);
  assert.match(main, /ChartBridgeTicks\.ResetConfig\(\);/);
  assert.match(main, /else if \(ChartBridgeTicks\.ReadConfig\(key, val\)\) \{ \}/);
  assert.match(between(main, 'private static void FeedDropped(', 'HtfFeedDropped(root);'), /if \(MarketClosedNow\(\)\)[^\n]*\n\s*ChartBridgeTicks\.NoteFeedDrop\(\);/);
});

test('tick file: the final pull goes through the gate, only in the 1 second window, at most one request a pass', () => {
  const plan = between(ticks, 'public static bool PlanDay(', 'public static TickCheckResult FinishDay(string key');
  assert.match(plan, /if \(!ChartBridgeBars\.In1sStartWindow\(nowEt\)\) \{[^}]*return false; \}/);
  assert.match(plan, /ChartBridgeServer\.GateBars\("ticks " \+ key, inst, fromNt, toNt, ChartBridgeBars\.Request1sTimeoutMs, stopping, t, bars => BuildTickDay\(/);
  assert.ok(!/new BarsRequest/.test(ticks), 'no request goes around the gate');
  assert.match(bars, /bool asked1s = Plan1s\(stopping, nowEt, sessions\);\s*if \(!asked1s && !stopping\(\)\) ChartBridgeTicks\.PlanDay\(stopping\);/);
  // the raw is deleted only when the check passed and The Desk stored and packed the day
  assert.match(between(ticks, 'private static void DayTaken(', '// ----'), /if \(stored && packed && passed\)/);
  // chunks and days never go through a proxy
  assert.match(between(ticks, 'private static Sent2 Post(', 'catch (Exception ex)'), /req\.Proxy = null;/);
});

test('tick file: installed, compiled by the checks, no em or en dashes', () => {
  assert.ok(JSON.parse(read('nt8', 'install-files.json')).addons.includes('nt8/ChartBridgeTicks.cs'));
  for (const f of ['check.sh', 'orders.sh']) assert.match(read('nt8', 'check', f), /ChartBridgeTicks\.cs/);
  for (const f of [['nt8', 'ChartBridgeTicks.cs'], ['nt8', 'check', 'BarsHarness.cs'], ['nt8', 'PROTOCOL.md']])
    assert.doesNotMatch(read(...f), /[–—]/, f.join('/') + ': no em or en dashes');
});

test('1 second bars (item 11): the tick request starts at the session open, not 12:00 AM of the day before', () => {
  const f = between(bars, 'private static Outcome Fetch1s(', 'public static string Diag1sJson(');
  assert.match(f, /DateTime fromNt = TimeZoneInfo\.ConvertTimeFromUtc\(openUtc, ntZone\);/);
  assert.ok(!/ConvertTimeFromUtc\(openUtc, ntZone\)\.Date/.test(f));
});
