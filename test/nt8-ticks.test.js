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

test('tick file: the final pull goes through the gate, only in its start window, at most one request a pass', () => {
  const plan = between(ticks, 'public static bool PlanDay(', 'public static TickCheckResult FinishDay(string key');
  assert.match(plan, /if \(!InDayStartWindow\(nowEt\)\) \{ dayState = DayWaitText; return false; \}/);
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

test('1 second bars (item 11, next build narrowed): from 12:00 AM of the session\'s own date (never before the open), from the open itself when that answer misses the open; never the day before', () => {
  const f = between(bars, 'private static Outcome Fetch1s(', 'public static string Diag1sJson(');
  assert.match(f, /DateTime openNt = TimeZoneInfo\.ConvertTimeFromUtc\(openUtc, ntZone\);/);
  assert.match(f, /DateTime fromNt = wide \? openNt : NarrowFrom1s\(openNt, toNt\);/);
  assert.match(bars, /public static DateTime NarrowFrom1s\(DateTime openNt, DateTime closeNt\) \{ DateTime d = closeNt\.Date; return d > openNt \? d : openNt; \}/);
  assert.match(f, /if \(!wide && \(sb == null \|\| sb\.Rows\.Count == 0 \|\| sb\.Rows\[0\]\.T > fromMs \+ Cover1sMinutes \* 60000L\)\)/, 'a narrow answer that misses the open is never sent');
  assert.ok(!/ConvertTimeFromUtc\(openUtc, ntZone\)\.Date/.test(f));
});

test('tick file (Anthony 2026-11-03): the morning catch-up before 09:15 ET is the tick day pull\'s own; the 1 second bars are not widened', () => {
  const win = between(ticks, 'public static TimeSpan MorningEnd', 'public static bool PlanDay(');
  assert.match(win, /public static TimeSpan MorningEnd = new TimeSpan\(9, 15, 0\);/);
  assert.match(win, /if \(et\.DayOfWeek == DayOfWeek\.Saturday \|\| et\.DayOfWeek == DayOfWeek\.Sunday\) return false;\s*return et\.TimeOfDay >= MorningStart && et\.TimeOfDay < MorningEnd;/);
  // review LOW 1, pending Anthony's answer: the window's start is one named line, 00:00 today (the behaviour unchanged)
  assert.match(ticks, /public static TimeSpan MorningStart = new TimeSpan\(0, 0, 0\);/);
  assert.match(win, /public static bool InDayStartWindow\(DateTime et\) \{ return ChartBridgeBars\.In1sStartWindow\(et\) \|\| InMorningWindow\(et\); \}/);
  // dayState says when the next pull can go
  assert.match(win, /string morning = MorningStart == TimeSpan\.Zero \? "before " \+ Hm\(MorningEnd\) : Hm\(MorningStart\) \+ " to " \+ Hm\(MorningEnd\);\s*return "waiting: the final pull goes 16:15 to 17:50 ET on weekdays, " \+ morning \+ " ET on weekday mornings, and on the weekend";/);
  // the window is checked by the gate as it sends (none starts at 09:15 or later); one already out is never cut
  const plan = between(ticks, 'public static bool PlanDay(', 'public static TickCheckResult FinishDay(string key');
  assert.match(plan, /if \(morning\) t\.MayStart = \(\) => InMorningWindow\(NowEt\(\)\);/);
  assert.match(plan, /if \(t\.NotStarted\) \{ dayState = DayWaitText; return true; \}\s*if \(t\.Error != null\) \{ LaterDay\(/, 'not started is not a try');
  const run = between(main, 'private static void RunBars(', 'req0.Request(');
  assert.ok(run.indexOf('t.MayStart') >= 0 && run.indexOf('t.MayStart') < run.indexOf('new BarsRequest('), 'MayStart is asked before the request is made');
  // the 1 second bars and the day's sends keep their own window
  assert.ok(!/InMorningWindow|InDayStartWindow|MorningEnd/.test(bars), 'ChartBridgeBars.cs does not use the morning window');
  assert.match(between(ticks, 'public static int SendDays(', 'private static string DayKeyOf('), /if \(!ChartBridgeBars\.In1sWindow\(/);
});

test('tick file (2026-11-03): the raw deleted once packed: only the last part kept, asked at most once a day in the windows, a failed day never', () => {
  const taken = between(ticks, 'private static void DayTaken(', '// ---------------------------------------------------------- the raw deleted once packed');
  assert.match(taken, /if \(passed && !packed\)/, 'only a passed day not packed keeps its last part');
  assert.match(taken, /File\.ReadAllLines\(file\)\.LastOrDefault\(/, 'the very last part sent');
  assert.match(taken, /if \(stored && packed && passed\) DeleteRaw\(key\);/);
  const ask = between(ticks, 'public static int AskPacked(', '// ---------------------------------------------------------- the folder');
  assert.match(ask, /if \(!InPackAskWindow\(nowEt\)\) return 0;/);
  assert.match(ask, /d\.Stored && !d\.Packed && TickCheck\.IsPassed\(d\.Check\)/, 'a failed day is never asked');
  assert.match(ask, /if \(last == today \|\| mem == today\) continue;/, 'at most once a New York day (the file or, review LOW 4, memory)');
  assert.ok((ask.match(/NoteAsked\(d\.Key, today\);/g) || []).length === 2, 'a refusal and an answer not packed both note the day asked (memory and file)');
  assert.match(ask, /if \(stored && packed\)\s*\{\s*lock \(Sync\) d\.Packed = true;\s*SaveDays\(\);\s*DeleteRaw\(d\.Key\);/);
  assert.match(ticks, /public static bool InPackAskWindow\(DateTime et\) \{ return ChartBridgeBars\.In1sWindow\(et\) \|\| InMorningWindow\(et\); \}/);
  assert.match(between(ticks, 'private static void SenderLoop(', '// ----'), /SendDays\(stopping\);\s*AskPacked\(stopping\);/);
});

test('tick file (review LOW 3): the raw deleted before the key is forgotten; no ghost key; a chunk whose raw is gone never throws', () => {
  const del = between(ticks, 'private static string DeleteFiles(', '// On the sender thread. Returns how many days were asked.');
  assert.match(del, /lock \(Sync\)/, 'the delete runs under the tick file lock');
  assert.match(del, /new\[\] \{ raw, LastPartFile\(key\), AskedFile\(key\), state \}/, 'the raw first, the state last');
  assert.ok(del.indexOf('File.Delete(f)') < del.indexOf('Keys.Remove(key)'), 'the files before the key');
  const scan = between(ticks, 'private static void ScanFolder()', 'private static void RecountDisk()');
  assert.match(scan, /packed = Days\.TryGetValue\(key, out d\) && d\.Packed && TickCheck\.IsPassed\(d\.Check\);/, 'a passed day noted packed is not registered; a failed one keeps its raw');
  assert.match(scan, /first = ScanDeleteSaid\.Add\(key\);\s*if \(first\) ChartBridgeServer\.Log\(/, 'a delete that fails is said once a run for each key');
  assert.match(scan, /if \(!File\.Exists\(Path\.Combine\(Folder, name \+ "\.raw"\)\)\) continue;/, 'a state with no raw is not registered');
  assert.match(between(ticks, 'private static void SenderLoop(', '// ----'), /LoadDays\(\); ScanFolder\(\);/, 'the days are read before the folder');
  const send = between(ticks, 'public static int SendChunks(', 'private static async Task<WebResponse> PostAsync(');
  assert.match(send, /if \(cuts\.Count > 0 && !File\.Exists\(k\.Raw\)\) \{ RawGone\(k, null\); continue; \}/);
});

test('tick file (Anthony 2026-11-03, 0.6.14): the day check fails only on no history or history under 90 percent; short passes; holes never fail', () => {
  const chk = between(ticks, 'public static class TickCheck', 'public class TickDayBuild');
  assert.match(chk, /public const int ThinSharePercent = 90;/);
  assert.match(chk, /public const int HoleMinSeconds = 59;/);
  assert.match(chk, /public static bool IsPassed\(string status\) \{ return status == "exact" \|\| status == "filled" \|\| status == "short"; \}/);
  assert.match(chk, /bool thin = r\.CoveredLive > 0 && r\.CoveredHist \* 100 < r\.CoveredLive \* ThinSharePercent;\s*if \(r\.HistTicks == 0 \|\| thin\) r\.Status = "failed";\s*else if \(r\.SecondsHistShort > 0\) r\.Status = "short";\s*else if \(r\.SecondsLiveMissed > 0\) r\.Status = "filled";\s*else r\.Status = "exact";/);
  assert.ok(!/Holes[^;\n]*Status|Status[^;\n]*Holes/.test(chk), 'holes never decide the status');
  assert.match(ticks, /public bool Passed \{ get \{ return TickCheck\.IsPassed\(Status\); \} \}/);
  // every place that treats a day as passed asks IsPassed, never the names one by one
  const rest = ticks.slice(ticks.indexOf('public class TickDayBuild'));
  assert.ok(!/"exact"|"filled"|"short"/.test(rest), 'no status compared by name outside TickCheck');
  assert.match(between(ticks, 'private static void DayTaken(', '// ----'), /bool passed = TickCheck\.IsPassed\(d\.Check\);/);
  assert.equal((ticks.match(/TickCheck\.IsPassed\(d\.Check\)/g) || []).length, 4, 'DayTaken, AskPacked, ScanFolder, /diag packWait');
  // the summary: the counts kept (information only), the share, the covered counts, the holes
  const parts = between(ticks, 'private static List<string> DayParts(KeyFiles k', 'private static readonly Regex StoredRx');
  for (const k of ['secondsHistShort', 'ticksHistShort', 'secondsLiveMissed', 'ticksLiveMissed', 'liveLost', 'liveGaps', 'rule', 'coveredLive', 'coveredHist', 'historyShare', 'holes'])
    assert.ok(parts.includes('\\"' + k + '\\":'), 'the check has ' + k);
  assert.match(parts, /c\.Append\("\{\\"from\\":"\)\.Append\(chk\.Holes\[i\]\[0\]\)\.Append\(",\\"to\\":"\)\.Append\(chk\.Holes\[i\]\[1\]\)\.Append\(",\\"live\\":"\)\.Append\(chk\.Holes\[i\]\[2\]\)/);
  // the known capture gaps go to the check
  assert.match(ticks, /TickCheckResult chk = TickCheck\.Compare\(live, hist\.Ticks, KnownGaps\(k\), OpenMsOf\(k\.Session\)\);/);
});

test('tick file (0.6.14): a day failed under the old rule with its raw kept is checked again once (tickrule.txt)', () => {
  const load = between(ticks, 'private static void LoadDays()', 'private static void SaveRule()');
  assert.match(load, /foreach \(DayRec d in Days\.Values\) if \(MayRecheck\(d\.Key\)\) Recheck\.Add\(d\.Key\);/);
  assert.match(load, /write = !there \|\| !listed\.SetEquals\(Recheck\);/, 'the record is written again when it lists other days');
  assert.match(load, /return Days\.TryGetValue\(key, out d\) && d\.Check == "failed" && d\.Rule < 2 && File\.Exists\(Path\.Combine\(Folder, BaseOf\(key\) \+ "\.raw"\)\);/, 'only a rule 1 failed day with its raw');
  // the rule column (a 0.6.13 line of four fields reads as rule 1)
  assert.match(load, /if \(f\.Length != 4 && f\.Length != 5\) continue;\s*int rule = 1;/);
  assert.match(ticks, /\+ "\\t" \+ d\.Rule\.ToString\(Inv\)\)\.ToList\(\);/);
  assert.match(ticks, /public static bool IsDayDone\(string key\) \{ lock \(Sync\) return Days\.ContainsKey\(key\) && !Recheck\.Contains\(key\); \}/);
  assert.match(between(ticks, 'private static TickCheckResult FinishDay(KeyFiles k', 'private static string ShareText('), /again = Recheck\.Remove\(k\.Key\);[\s\S]*if \(again\) SaveRule\(\);/);
  // the same windows and tries as any final pull: DaysToPull keeps MaxTries and RetryAtDay
  assert.match(between(ticks, 'public static List<string> DaysToPull(', 'private static void LaterDay('), /if \(IsDayDone\(k\.Key\) \|\| !File\.Exists\(k\.Raw\)\) continue;[\s\S]*if \(tries >= MaxTries\) continue;/);
});

test('tick file (0.6.14 review): the span floor, the skew trim, inGap holes, and a set aside that never loops', () => {
  const chk = between(ticks, 'public static class TickCheck', 'public class TickDayBuild');
  assert.match(chk, /public const int MinCoveredSeconds = 600;/);
  assert.match(chk, /public const int MinCoveredLive = 1000;/);
  assert.match(chk, /public const int SkewEarlyMs = 4, SkewLateMs = 106;/);
  assert.match(chk, /public const int EdgeEarlyMaxMs = SkewEarlyMs - 1;/);
  assert.match(chk, /public const int EdgeLateMinMs = 1000 - SkewLateMs;/);
  assert.match(chk, /else if \(r\.CoveredSeconds < MinCoveredSeconds \|\| r\.CoveredLive < MinCoveredLive\) \{ Cover\(r, by, liveFrom, liveTo, null\); r\.SpanWhole = true; \}/);
  // a live run: an edge second left out only when the skew alone can empty it; exactly 60 seconds otherwise (re-review LOW A)
  assert.match(chk, /if \(firstMax <= EdgeEarlyMaxMs\) len -= 1000;\s*if \(lastMin >= EdgeLateMinMs\) len -= 1000;\s*if \(len >= HoleMinSeconds \* 1000L\)/);
  // an inGap silence is never trimmed, and the first one starts at the session's open (re-review LOW C)
  assert.match(chk, /if \(to - from >= HoleMinSeconds \* 1000L\) into\.Add/);
  assert.match(chk, /long from = prevHist != long\.MinValue \? prevHist \+ 1000 : openSec;/);
  assert.match(ticks, /TickCheck\.Compare\(live, hist\.Ticks, KnownGaps\(k\), OpenMsOf\(k\.Session\)\);/);
  // every start lists every failed rule 1 day with its raw (re-review LOW B)
  assert.match(between(ticks, 'private static void LoadDays()', 'private static bool MayRecheck('), /foreach \(DayRec d in Days\.Values\) if \(MayRecheck\(d\.Key\)\) Recheck\.Add\(d\.Key\);\s*HashSet<string> listed/);
  const parts = between(ticks, 'private static List<string> DayParts(KeyFiles k', 'private static readonly Regex StoredRx');
  for (const k of ['coveredSeconds', 'spanWhole', 'inGap']) assert.ok(parts.includes('\\"' + k + '\\":'), 'the check has ' + k);
  const aside = between(ticks, 'private static void SetAside(', 'private static string DayKeyOf(');
  assert.match(aside, /try \{ if \(File\.Exists\(to\)\) File\.Delete\(to\); File\.Move\(file, to\); \}/);
  assert.match(aside, /lock \(Sync\) AsideFailed\.Add\(file\);/);
  assert.match(between(ticks, 'public static int SendDays(', 'private static string DayKeyOf('), /lock \(Sync\) if \(AsideFailed\.Contains\(file\)\) continue;/);
  assert.ok(!/File\.Move\(file, file \+ "\.(refused|unstored)"\)/.test(ticks), 'every set aside goes through SetAside');
  const finish = between(ticks, 'private static TickCheckResult FinishDay(KeyFiles k', 'private static string ShareText(');
  assert.match(finish, /new\[\] \{ "\.day\.sent", "\.day\.jsonl\.refused", "\.day\.jsonl\.unstored" \}/);
  assert.match(finish, /DayAgainAt\.Remove\(file\); DayAgainTries\.Remove\(file\); AsideFailed\.Remove\(file\);/);
});
