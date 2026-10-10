'use strict';
// Guards on ChartBridgeBars.cs (0.3.6, daily 1-minute bars to The Desk) and its use of the 0.3.5 gate in ChartBridge.cs.
// NinjaTrader cannot run here, so these check the code itself; the behaviour (the failure scenarios S1 to S8) runs under
// Mono in nt8/check/BarsHarness.cs (npm run check:orders).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const strip = src => src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '').replace(/([;{})])\s*\/\/.*$/, '$1')).join('\n');
const bsrc = read('nt8', 'ChartBridgeBars.cs');
const bars = strip(bsrc);
const msrc = read('nt8', 'ChartBridge.cs');
const src = msrc;
const main = strip(msrc);
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
  assert.match(between(bars, 'public static void Start()', 'public static void Stop()'), /if \(!Enabled\) return;\s*try\s*\{/);
  // 0.3.7 (review bars1 N7): the files are read on the bars thread (Run), never in Start (NinjaTrader's thread)
  assert.ok(!/ChartBridgeBarsQueue\.Load\(\)/.test(between(bars, 'public static void Start()', 'public static void Stop()')), 'Start reads no file');
  assert.match(between(bars, 'private static void Run(', 'private static bool Nap('), /if \(stopping\(\)\) return;\s*try\s*\{\s*ChartBridgeBarsQueue\.Load\(\);/);
  assert.match(between(bars, 'public static void Flush(Func<bool> stopping)', 'private static bool SendOne('), /if \(!ChartBridgeBars\.Enabled\) return;/);
  assert.match(between(bars, 'public static void PlanOnce(', 'private static void Later('), /if \(!Enabled\) \{ state = "off"; return; \}\s*if \(!IsConnected\(\)\)/);
});

test('bars: BarsRequest as NinjaTrader documents it, through the 0.3.5 gate (1 minute, Last, the chart\'s trading hours, this contract only)', () => {
  const run = between(main, 'private static void RunBars(', '// The feed (review 3');
  assert.match(run, /new BarsRequest\(inst, fromNt, toNt\)/);
  assert.match(run, /new BarsPeriod \{ BarsPeriodType = BarsPeriodType\.Minute, Value = 1, MarketDataType = MarketDataType\.Last \}/);
  assert.match(run, /req0\.TradingHours = inst\.MasterInstrument\.TradingHours;/);
  assert.match(run, /req0\.MergePolicy = MergePolicy\.DoNotMerge;/);
  // the gate's own rules for an answer: dropped after a stop, a late answer frees a stuck gate and is not copied
  assert.match(run, /if \(j\.Stop\.IsCancellationRequested\) \{ try \{ req\.Dispose\(\); \} catch \(Exception\) \{ \} t\.Error = "stopped"; t\.Done\.Set\(\); return; \}/);
  assert.match(run, /if \(!Claim\(j\)\) \{ try \{ req\.Dispose\(\); \} catch \(Exception\) \{ \} if \(LateAnswer\(j\)\) GateUnstuck\(j, "bars " \+ j\.Root\); return; \}/);
  assert.match(run, /finally \{ try \{ req\.Dispose\(\); \} catch \(Exception\) \{ \} done\(\); t\.Done\.Set\(\); \}/);
  const fetch = between(bars, 'private static Outcome Fetch(', 'public static string DiagJson(');
  assert.match(fetch, /if \(toNt > nowNt\) toNt = nowNt;/, 'never asks past now');
  assert.match(fetch, /ChartBridgeServer\.GateBars\(j\.Key, inst, fromNt, toNt, RequestTimeoutMs, stopping, t\)/);
  assert.ok(!/new BarsRequest/.test(bars), 'no request goes around the gate');
  assert.match(bars, /return \(long\)Math\.Round\(ChartBridgeTime\.UtcMs\(ChartBridgeTime\.ToUtc\(ntCloseStamp\)\)\) - 60000L;/, 'close stamp to open time in UTC');
});

test('bars: last of all at the gate, never beside a window or a backfill, never in RTH but the start catch-up', () => {
  const busy = between(main, 'private static string BarsBusyLocked()', 'private static string BackfillToCome()');
  for (const re of [/if \(gateStopped\) return/, /if \(gateStuck != null\) return/, /if \(gateNow != null\) return/, /if \(GateWindows\.Count > 0\) return/,
    /if \(GateBackfills\.Count > 0\) return/, /if \(GateBarJobs\.Count > 0\) return/, /if \(tailsOut > 0\) return/, /if \(PageLoading\(\)\) return/]) assert.match(busy, re);
  assert.match(between(main, 'private static string BackfillToCome()', 'public static string BarsGateBusy()'), /if \(b\.BackfillLive != null\) return/);
  const ask = between(main, 'public static string GateBars(', 'public static bool GateBarsWithdraw(');
  assert.match(ask, /string why = BackfillToCome\(\);\s*if \(why != null\) return why;/);
  assert.match(ask, /lock \(GateLock\)\s*\{\s*why = BarsBusyLocked\(\);\s*if \(why != null\) return why;\s*t\.Job = j;\s*GateBarJobs\.Add\(j\);\s*\}/, 'queued only when the gate is idle, checked under its lock');
  assert.match(main, /bars = new List<GateJob>\(GateBarJobs\); GateBarJobs\.Clear\(\);/, 'a stuck gate drops a queued bars request');
  // Anthony: the chart never waits on bars. An unanswered bars request frees the gate (claimed as timed out, never gateStuck);
  // windows and backfills keep 0.3.5's stuck rule.
  const loop = between(main, 'private static void GateLoop(', 'private static void GateTimedOut(');
  assert.match(loop, /if \(!answered && j\.FreesGate\)\s*\{[\s\S]*?if \(Interlocked\.CompareExchange\(ref j\.State, 3, 0\) == 0\)[\s\S]*?\}\s*else if \(!answered && Interlocked\.CompareExchange\(ref j\.State, 2, 0\) == 0\)\s*\{\s*GateTimedOut\(j\);/);
  assert.ok(!/GateTimedOut/.test(between(loop, 'j.FreesGate)', 'else if (!answered && Interlocked')), 'a bars timeout never marks the gate stuck');
  assert.match(main, /GateJob j = new GateJob \{ Kind = "bars", Root = what, TimeoutMs = timeoutMs, FreesGate = true \};/, 'bars requests free the gate (0.3.7: so do higher-timeframe ones)');
  assert.match(main, /GateWindows\.Clear\(\); GateBackfills\.Clear\(\); GateBarJobs\.Clear\(\); GateHtfJobs\.Clear\(\); gateStuck = null;/, 'StopGate clears it');
  const plan = between(bars, 'public static void PlanOnce(', 'private static void Later(');
  assert.match(plan, /if \(catchUpDone && InRth\(nowEt\)\)/);
  assert.match(plan, /if \(o == Outcome\.Wait\) return;/, 'a busy gate ends the pass: nothing piles up');
  assert.match(bars, /return tod >= new TimeSpan\(9, 30, 0\) && tod < new TimeSpan\(16, 15, 0\);/);
});

test('bars: its own low-priority background thread; a stop ends it and sends nothing more', () => {
  const start = between(bars, 'public static void Start()', 'public static void Stop()');
  assert.match(start, /new Thread\(/);
  assert.match(start, /t\.IsBackground = true;/);
  assert.match(start, /t\.Priority = ThreadPriority\.BelowNormal;/);
  assert.match(bars, /public static int SettleMs = 120000;/);
  assert.match(bars, /public static int StopJoinMs = 250;/);
  const stop = between(bars, 'public static void Stop()', 'private static bool Stopping(');
  assert.match(stop, /generation\+\+;/);
  assert.match(stop, /ChartBridgeBarsQueue\.Abort\(\);/);
  assert.match(stop, /t\.Join\(StopJoinMs\)/);
  assert.match(between(bars, 'private static bool SendOne(', 'private static string Clean('), /lock \(AbortSync\) \{ if \(stopGen != gen\) return false; inFlight = req; \}/);
  assert.match(main, /ChartBridgeBars\.Stop\(\);[\s\S]*StopGate\(250\);/, 'the bars stop before the gate');
  assert.ok(!/Dispatcher|Application\.Current/.test(bars), 'nothing on the UI thread');
  assert.ok(!/Thread\.Sleep\(PauseBetweenMs\)/.test(bars), 'every wait ends at a stop');
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

test('bars: ChartBridge.cs hooks it in (config, start, stop, /diag) and runs its requests through the gate; version 0.5.3', () => {
  assert.match(main, /public const string Version = "0\.5\.3";/);
  assert.match(src, /^\/\/ ChartBridge for NinjaTrader 8 \(its version is ChartBridgeServer\.Version, below\)/);
  assert.match(main, /AllowOrigins = new List<string>\(\);\s*ChartBridgeBars\.ResetConfig\(\);/);
  assert.match(main, /else if \(ChartBridgeBars\.ReadConfig\(key, val\)\) \{ \}[^\n]*\n\s*else if \(ChartBridgeOrders\.ReadConfig\(key, val\)\) \{ \}/);
  assert.match(main, /StartListening\(cts\.Token, 0\);\s*ChartBridgeBars\.Start\(\);/);
  assert.match(main, /b\.Append\(",\\"bars\\":"\)\.Append\(ChartBridgeBars\.DiagJson\(\)\);/);
  const uses = main.match(/ChartBridgeBars\.\w+/g) || [];
  assert.deepEqual([...new Set(uses)].sort(), ['ChartBridgeBars.DiagJson', 'ChartBridgeBars.ReadConfig', 'ChartBridgeBars.ResetConfig', 'ChartBridgeBars.Start', 'ChartBridgeBars.Stop']);
});

test('bars: installed, compile-checked, harnessed in check:orders', () => {
  assert.ok(JSON.parse(read('nt8', 'install-files.json')).addons.includes('nt8/ChartBridgeBars.cs'));
  assert.match(read('nt8', 'check', 'check.sh'), /ChartBridgePin\.cs ChartBridgeBars\.cs/);
  assert.match(read('nt8', 'check', 'orders.sh'), /ChartBridgeBars\.cs[\s\S]*check\/BarsHarness\.cs check\/DataHarness\.cs/);
  assert.match(read('nt8', 'check', 'SeamHarness.cs'), /BarsHarness\.Run\(Check\);/);
  assert.match(read('nt8', 'check', 'SeamHarness.cs'), /DataHarness\.Run\(Check\);/);
});

test('bars: no em or en dashes in the new files', () => {
  for (const f of [['nt8', 'ChartBridgeBars.cs'], ['nt8', 'check', 'BarsHarness.cs'], ['nt8', 'check', 'DataHarness.cs'], ['test', 'nt8-bars.test.js']])
    assert.ok(!/[\u2013\u2014]/.test(read(...f)), f.join('/'));
});
