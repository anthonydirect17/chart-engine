'use strict';
// Guards on ChartBridgeBars.cs (0.3.6-pre, daily 1-minute bars to The Desk). NinjaTrader cannot run here, so these
// check the code itself; the behaviour (session dates, stamps, catch-up, queue) runs under Mono in nt8/check/BarsHarness.cs
// (npm run check:bars).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const strip = src => src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '').replace(/([;{})])\s*\/\/.*$/, '$1')).join('\n');
const bsrc = read('nt8', 'ChartBridgeBars.cs');
const bars = strip(bsrc);
const main = strip(read('nt8', 'ChartBridge.cs'));
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, 'not found: ' + a); const j = b ? s.indexOf(b, i + a.length) : s.length; return s.slice(i, j < 0 ? s.length : j); };

test('bars: C# 5 only', () => {
  assert.ok(!/(^|[\s(=,+:?])\$"/m.test(bars), 'string interpolation');
  assert.ok(!/\?\.\w/.test(bars), 'null-conditional ?.');
  assert.ok(!/\bnameof\(/.test(bars), 'nameof');
  assert.ok(!/\{ get; \} =/.test(bars), 'auto-property initializers');
  assert.ok(!/\bout var\b/.test(bars), 'out var');
});

test('bars: never an order, never the order lane, never an account in a message', () => {
  const forbidden = [/\.Submit\s*\(/, /\.CreateOrder\s*\(/, /\.Change\s*\(/, /\.Flatten\s*\(/, /\.Cancel\s*\(/, /CancelAllOrders/, /\bAtm\w*\./,
    /\bOrderAction\./, /ChartBridgeOrders\./, /\.Send\(|SendData\(|SendAll\(|SendToTraders\(|OrderLane/];
  for (const re of forbidden) assert.ok(!re.test(bars), 'found in ChartBridgeBars.cs: ' + re);
  const msg = between(bars, 'public static string MessageJson(', 'private static bool DefaultConnected(');
  assert.ok(!/account|Account|pin|token/i.test(msg.replace(/\.Append\(CbJson\.Str\(PcName\(\)\)\)/, '')), 'the message carries market data and the PC name only');
  // the fills' contracts are read from executions, the account is only checked against the allow-list
  const fillJobs = between(bars, 'private static List<BarsJob> FillJobs(', '// ----');
  assert.ok(!/a\.Name\b[^)]*\+|Log\([^)]*a\.Name/.test(fillJobs), 'no account name logged or kept');
});

test('bars: off by default, on only with bars = on', () => {
  assert.match(bars, /public static bool Enabled;/);
  assert.match(bars, /public static void ResetConfig\(\) \{ Enabled = false;/);
  assert.match(bars, /Enabled = v == "on" \|\| v == "true" \|\| v == "1";/);
  assert.match(between(bars, 'public static void Start()', 'public static void Stop()'), /if \(!Enabled\) return;/);
  assert.match(between(bars, 'public static void Flush()', 'private static bool SendOne('), /if \(!ChartBridgeBars\.Enabled\) return;/);
  assert.match(between(bars, 'public static void PlanOnce(', 'private static void Later('), /if \(!Enabled\) return;\s*if \(!IsConnected\(\)\) return;/);
});

test('bars: BarsRequest as NinjaTrader documents it (1 minute, Last, the chart\'s trading hours, this contract only)', () => {
  const fetch = between(bars, 'private static void Fetch(', 'public static string DiagJson(');
  assert.match(fetch, /new BarsRequest\(inst, fromNt, toNt\)/);
  assert.match(fetch, /new BarsPeriod \{ BarsPeriodType = BarsPeriodType\.Minute, Value = 1, MarketDataType = MarketDataType\.Last \}/);
  assert.match(fetch, /req\.TradingHours = inst\.MasterInstrument\.TradingHours;/);
  assert.match(fetch, /req\.MergePolicy = MergePolicy\.DoNotMerge;/);
  assert.match(fetch, /finally \{ try \{ r\.Dispose\(\); \} catch \(Exception\) \{ \} a\.Done\.Set\(\); \}/);
  assert.match(fetch, /if \(toNt > nowNt\) toNt = nowNt;/, 'never asks past now');
  assert.match(fetch, /if \(!a\.Done\.Wait\(RequestTimeoutMs\)\)/, 'a request that is not answered is given up, not waited on forever');
  assert.match(bars, /return \(long\)Math\.Round\(ChartBridgeTime\.UtcMs\(ChartBridgeTime\.ToUtc\(ntCloseStamp\)\)\) - 60000L;/, 'close stamp to open time in UTC');
});

test('bars: one at a time, on its own low-priority background thread, after the charts', () => {
  const start = between(bars, 'public static void Start()', 'public static void Stop()');
  assert.match(start, /new Thread\(/);
  assert.match(start, /t\.IsBackground = true;/);
  assert.match(start, /t\.Priority = ThreadPriority\.BelowNormal;/);
  assert.match(bars, /public static int SettleMs = 120000;/);
  assert.match(between(bars, 'public static void PlanOnce(', 'private static void Later('), /if \(ChartBridgeServer\.PagesLoading\(\)\) return;/);
  assert.ok(!/Dispatcher|Application\.Current/.test(bars), 'nothing on the UI thread');
  assert.match(main, /public static bool PagesLoading\(\)\s*\{\s*foreach \(ChartBridgeClient c in Clients\.Values\) if \(c\.Root != null && !c\.Ready\) return true;/);
});

test('bars: the fills queue\'s rules (file first, atomic, 10 s, deskUrl, set aside on 400/422, sent record)', () => {
  const q = between(bars, 'public static class ChartBridgeBarsQueue', null);
  assert.match(q, /"pending_bars\.jsonl"/);
  assert.match(q, /"rejected_bars\.jsonl"/);
  assert.match(q, /"sent_bars\.txt"/);
  assert.match(q, /File\.Replace\(tmp, file, null\)/);
  assert.match(q, /public static int TimeoutMs = 10000;/);
  assert.match(q, /req\.Abort\(\)/);
  assert.match(q, /WebRequest\.Create\(ChartBridgeConfig\.DeskUrl \+ "\/api\/bars"\)/);
  assert.match(q, /if \(code == 400 \|\| code == 422\)/);
  assert.ok(!/Headers\.Add|Authorization|Cookie/.test(q), 'nothing added to the request (The Desk guards it as it guards fills)');
  assert.match(bars, /public static int TickMs = 10000;/, 'retried every 10 s');
});

test('bars: ChartBridge.cs only hooks it in (config, start, stop, /diag) and the version is 0.3.6-pre', () => {
  assert.match(main, /public const string Version = "0\.3\.6-pre";/);
  assert.match(main, /AllowOrigins = new List<string>\(\);\s*ChartBridgeBars\.ResetConfig\(\);/);
  assert.match(main, /else if \(ChartBridgeBars\.ReadConfig\(key, val\)\) \{ \}[^\n]*\n\s*else ChartBridgeOrders\.ReadConfig\(key, val\);/);
  assert.match(main, /StartListening\(cts\.Token, 0\);\s*ChartBridgeBars\.Start\(\);/);
  assert.match(main, /ChartBridgeBars\.Stop\(\);/);
  assert.match(main, /b\.Append\(",\\"bars\\":"\)\.Append\(ChartBridgeBars\.DiagJson\(\)\);/);
  const uses = main.match(/ChartBridgeBars\.\w+/g) || [];
  assert.deepEqual([...new Set(uses)].sort(), ['ChartBridgeBars.DiagJson', 'ChartBridgeBars.ReadConfig', 'ChartBridgeBars.ResetConfig', 'ChartBridgeBars.Start', 'ChartBridgeBars.Stop']);
});

test('bars: installed, compile-checked, harnessed', () => {
  assert.match(read('nt8', 'install.ps1'), /'nt8\\ChartBridgeBars\.cs'/);
  assert.match(read('nt8', 'check', 'check.sh'), /ChartBridgePin\.cs ChartBridgeBars\.cs/);
  assert.match(read('nt8', 'check', 'orders.sh'), /ChartBridgeBars\.cs/);
  assert.match(read('nt8', 'check', 'bars.sh'), /ChartBridgeBars\.cs check\/Nt8Stubs\.cs check\/BarsHarness\.cs/);
  assert.match(read('package.json'), /"check:bars": "sh nt8\/check\/bars\.sh"/);
});

test('bars: no em or en dashes in the new files', () => {
  for (const f of [['nt8', 'ChartBridgeBars.cs'], ['nt8', 'check', 'BarsHarness.cs'], ['nt8', 'check', 'bars.sh'], ['test', 'nt8-bars.test.js']])
    assert.ok(!/[\u2013\u2014]/.test(read(...f)), f.join('/'));
});
