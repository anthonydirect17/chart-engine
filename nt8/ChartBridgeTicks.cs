// ChartBridge: the NQ tick file to The Desk (the Sunday 11-01 build), for NinjaTrader 8.
// Anthony's decisions of 2026-10-29: one NQ tick file per session is the only market data kept; everything is built from it (1
// second bars, 1 minute bars, the evening profile tape, the master day); MNQ trades take their bars from NQ's ticks. This release
// adds; it retires nothing (the 1-minute request, the evening profile export and the 1 second pull stay as they are).
//
// ON with "bars = on" (as the 1 second bars); "tickFile = off" in config.txt turns only it off. "tickFileMaxMB = 2048" bounds the
// ticks folder.
//
// 1. Live capture. Every NQ trade ChartBridge already receives (OnMarketData, after the pages, the tape and the other work, in its
//    own try) is put on a bounded queue: one counter read and one enqueue, never a lock the order lane or the chart feed holds, never
//    a file or a clock read there. A full queue DROPS the trade and counts it (droppedQueue); it never waits. A thread of its own
//    (BelowNormal) writes the queue to ticks/<session>_<contract>.raw, one line a trade ("u,p,v,s,m": UTC ms, price, volume, side,
//    side method), every 250 ms, whole lines only. Over tickFileMaxMB a batch is dropped and counted (droppedDisk).
// 2. Chunks. Another thread (BelowNormal) cuts each raw file every 3 minutes into chunks of at most 20,000 trades (byte ranges noted
//    in <same>.state, so a resend is the same chunk) and posts them to The Desk's POST /api/ticks/chunk (10 s each). The Desk keys a
//    chunk by contract, session, PC, run and seq and ignores one sent again. Chunks go at any hour: they go to The Desk, never to
//    NinjaTrader. NO request goes to NinjaTrader for them.
// 3. The final file. After the close, on the bars worker, in the 1 second bars' window (16:15 to 17:50 New York on weekdays, the
//    weekend while shut; never in trading hours) and, as a catch-up for a session closed and not done (Anthony 2026-11-03: he may
//    close NinjaTrader before 16:15), on weekday mornings before 09:15 New York (this pull only), through the 0.3.5 gate, one tick
//    request per captured session, from the open to the close (NinjaTrader's history), checked against the live capture second by
//    second (TickCheck). The history is the master when the check passes: exact, filled (history has trades the live capture
//    missed, never fewer) or, from 0.6.14 (Anthony 2026-11-03), short (history has fewer in some seconds, but at least 90 percent of
//    the live trades over the span the live capture covered); it fails only when history has no trades or is under that 90 percent.
//    Holes (60 seconds or more of live trades with no history trade, an edge second left out only when the skew alone can empty
//    it; or 60 seconds or more of history silence over a known capture gap, from the session's open too: inGap) never fail the
//    day: they are listed in the check for the backtests to skip. A day failed under the old rule with its raw still there is checked again once (tickrule.txt). The day
//    goes to POST /api/ticks/day in parts. The raw is deleted only when the check passed and The Desk answers "stored" and "packed" true; a failed
//    day keeps its raw until Anthony rules.
//    Stored but not packed (2026-11-03): only the day's last part is kept (.day.last) and sent again at most once a day in the
//    final pull's windows; when The Desk answers stored and packed the raw, its state and the part are deleted (AskPacked).
//    Raw files older than 7 days are listed in /diag (tickFile.rawOld).
//
// Only market data and the PC name leave this PC. This file never places, changes or cancels an order and never touches the order
// lane. Written in C# 5 syntax on purpose so it compiles on every NinjaTrader 8 release.

#region Using declarations
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    // One trade: U its time in UTC ms, P price, V volume, S side (1 buy, -1 sell, 0 none), M the side's method (ChartBridgeSides).
    public struct TickRec
    {
        public long U;
        public double P;
        public long V;
        public int S, M;
        public string Contract;
        public double Tick;
    }

    // The check of a session's live capture against NinjaTrader's history, second by second.
    public class TickCheckResult
    {
        public string Status = "failed";   // "exact", "filled", "short" or "failed" (TickCheck.IsPassed: the first three pass)
        public long LiveTicks, LiveVolume, HistTicks, HistVolume, SecondsLiveMissed, TicksLiveMissed, SecondsHistShort, TicksHistShort;
        public readonly List<long[]> Detail = new List<long[]>();   // {second (UTC ms), live trades, history trades}
        // 0.6.14 (Anthony 2026-11-03): the span the share is judged over (TickCheck.Compare): its seconds and the trades of each in
        // it; SpanWhole when that is the whole first to last live span (no known gap, or the span left by the gaps too small);
        // history's share of live's there (NaN when no live trade is in it); and every hole: {from UTC ms, to UTC ms (exclusive),
        // live trades in it, 1 when it is a history silence over a known capture gap else 0}.
        public long CoveredLive, CoveredHist, CoveredSeconds;
        public bool SpanWhole;
        public double HistoryShare = double.NaN;
        public readonly List<long[]> Holes = new List<long[]>();
        public bool Passed { get { return TickCheck.IsPassed(Status); } }
    }

    public static class TickCheck
    {
        public static int DetailMax = 20;   // seconds listed of each kind
        // Anthony's decision of 2026-11-03: "the only failure should be very large gaps in the day, or days that are unusable for a
        // backtesting purpose, small inconsistency does not matter to me"; "even a 1 minute gap should not fail the whole day, that
        // gap just should not be used for testing".
        public const int ThinSharePercent = 90;    // history under 90 percent of live's trades in the span: failed
        public const int HoleMinSeconds = 60;      // a hole: 60 seconds or more with no history trade
        // The skew measured on WORK (2026-11-02): history's time of a trade runs 4 ms early to 106 ms late against the live feed. So a
        // run's first second is history-empty by the skew alone when every live trade in it is in its first 4 ms (the twin landed in
        // the second before), and its last second when every live trade in it is at 894 ms or later (the twin landed in the next).
        // Only such an edge second is left out of a run's length for the 60 second test (the PR #79 re-review, LOW A).
        public const int SkewEarlyMs = 4, SkewLateMs = 106;
        public const int EdgeEarlyMaxMs = SkewEarlyMs;          // 4: a first second whose live trades are all at 4 ms or less
        public const int EdgeLateMinMs = 1000 - SkewLateMs;     // 894: a last second whose live trades are all at 894 ms or more
        // The coordinator for Anthony, 2026-11-03 (the PR #79 review): judge on the whole first to last live span when the span left
        // by the known gaps has fewer than 600 seconds or fewer than 1,000 live trades (a short run, or most chunks flagged: a sliver
        // of a span would let the skew fail a good day).
        public const int MinCoveredSeconds = 600;
        public const int MinCoveredLive = 1000;
        public const int Rule = 2;                 // the check's rule: 2 from 0.6.14 (1, every second history short failed, before)

        // The statuses that pass: history is the day's record.
        public static bool IsPassed(string status) { return status == "exact" || status == "filled" || status == "short"; }

        public static TickCheckResult Compare(IList<TickRec> live, IList<TickRec> hist) { return Compare(live, hist, null, long.MinValue); }
        public static TickCheckResult Compare(IList<TickRec> live, IList<TickRec> hist, IList<long[]> gaps) { return Compare(live, hist, gaps, long.MinValue); }

        // Per UTC second: the trades and volume of each.
        //   failed: history has no trades, or history is thin: in the span its trades are under ThinSharePercent of live's.
        //   short: passed, history has fewer trades or less volume than live in some second (information only: NinjaTrader's history
        //     stamps a trade up to about 0.1 s later than the live feed, so a trade late in its second lands in the next one).
        //   filled: passed, history has more in some seconds (the live capture missed them: a disconnect, a late start), never less.
        //   exact: passed, every second the same.
        // The span: every second from the first live trade's second to the last live trade's second, both included, less the
        // seconds strictly inside a known capture gap (gaps: {a, b} UTC ms, the last live trade before the gap and the first after
        // it; long.MinValue / long.MaxValue for an open end). When what the gaps leave has fewer than MinCoveredSeconds seconds or
        // fewer than MinCoveredLive live trades, the span is the whole first to last live span (SpanWhole).
        // A hole (never failing the day), listed from its first second to the end of its last (to: the last second + 1000 ms), at
        // least HoleMinSeconds long:
        //   - a maximal run of seconds that have live trades and no history trade, with no history trade in any second between them
        //     (seconds with no trade at all inside the run count to its length); the known gaps do not split one. Its length for the
        //     test leaves out its first second when every live trade in it is at EdgeEarlyMaxMs or less, and its last second when
        //     every live trade in it is at EdgeLateMinMs or more (the skew alone can empty those);
        //   - a history silence over a known gap (inGap): the seconds strictly between two history trades, none in between, or from
        //     the session's open (openMs, when known) to history's first trade, when one of them is inside a known gap (no one vouches
        //     for that time); never trimmed (no live trade to be skewed against); it takes in any run of the first kind inside it.
        // A silence after history's last trade is not looked at (the caretaker skips a late start or an early end by CME's calendar).
        public static TickCheckResult Compare(IList<TickRec> live, IList<TickRec> hist, IList<long[]> gaps, long openMs)
        {
            TickCheckResult r = new TickCheckResult();
            SortedDictionary<long, long[]> by = new SortedDictionary<long, long[]>();   // second -> {live n, live v, hist n, hist v}
            long liveFrom = long.MaxValue, liveTo = long.MinValue;
            foreach (TickRec x in live)
            {
                long[] a = Slot(by, x.U); a[0]++; a[1] += x.V; r.LiveTicks++; r.LiveVolume += x.V;
                long s = Sec(x.U), ms = x.U - s; if (ms < a[4]) a[4] = ms; if (ms > a[5]) a[5] = ms;
                if (s < liveFrom) liveFrom = s; if (s > liveTo) liveTo = s;
            }
            foreach (TickRec x in hist) { long[] a = Slot(by, x.U); a[2]++; a[3] += x.V; r.HistTicks++; r.HistVolume += x.V; }
            int missedListed = 0, shortListed = 0;
            long runFrom = -1, runLast = -1, runLive = 0, runFirstMax = 0, runLastMin = 0, prevHist = long.MinValue, liveSince = 0;
            long openSec = openMs == long.MinValue ? long.MinValue : Sec(openMs);
            List<long[]> runs = new List<long[]>(), silences = new List<long[]>();
            foreach (KeyValuePair<long, long[]> kv in by)
            {
                long[] a = kv.Value;
                if (a[0] > a[2] || a[1] > a[3])
                {
                    r.SecondsHistShort++; r.TicksHistShort += Math.Max(0, a[0] - a[2]);
                    if (shortListed++ < DetailMax) r.Detail.Add(new long[] { kv.Key, a[0], a[2] });
                }
                else if (a[2] > a[0] || a[3] > a[1])
                {
                    r.SecondsLiveMissed++; r.TicksLiveMissed += a[2] - a[0];
                    if (missedListed++ < DetailMax) r.Detail.Add(new long[] { kv.Key, a[0], a[2] });
                }
                if (a[2] > 0)
                {
                    EndRun(runs, runFrom, runLast, runLive, runFirstMax, runLastMin); runFrom = -1; runLive = 0;
                    long from = prevHist != long.MinValue ? prevHist + 1000 : openSec;   // the first silence starts at the open
                    if (from != long.MinValue && OverGap(from, kv.Key, gaps)) EndSilence(silences, from, kv.Key, liveSince);
                    prevHist = kv.Key; liveSince = 0;
                }
                else if (a[0] > 0)
                {
                    if (runFrom < 0) { runFrom = kv.Key; runFirstMax = a[5]; }
                    runLast = kv.Key; runLastMin = a[4]; runLive += a[0]; liveSince += a[0];
                }
            }
            EndRun(runs, runFrom, runLast, runLive, runFirstMax, runLastMin);
            foreach (long[] s in silences) r.Holes.Add(new long[] { s[0], s[1], s[2], 1 });
            foreach (long[] h in runs)
                if (!silences.Any(s => s[0] <= h[0] && h[1] <= s[1])) r.Holes.Add(new long[] { h[0], h[1], h[2], 0 });
            r.Holes.Sort((x, y) => x[0].CompareTo(y[0]));
            if (r.LiveTicks > 0)
            {
                long all = (liveTo - liveFrom) / 1000 + 1;
                Cover(r, by, liveFrom, liveTo, gaps);
                if (r.CoveredSeconds == all) r.SpanWhole = true;
                else if (r.CoveredSeconds < MinCoveredSeconds || r.CoveredLive < MinCoveredLive) { Cover(r, by, liveFrom, liveTo, null); r.SpanWhole = true; }
                r.HistoryShare = (double)r.CoveredHist / r.CoveredLive;
            }
            bool thin = r.CoveredLive > 0 && r.CoveredHist * 100 < r.CoveredLive * ThinSharePercent;
            if (r.HistTicks == 0 || thin) r.Status = "failed";
            else if (r.SecondsHistShort > 0) r.Status = "short";
            else if (r.SecondsLiveMissed > 0) r.Status = "filled";
            else r.Status = "exact";
            r.Detail.Sort((x, y) => x[0].CompareTo(y[0]));
            return r;
        }

        // A run of live seconds from its first second to its last: kept when at least HoleMinSeconds long, less an edge second the
        // skew alone can empty (firstMax: the latest live ms in its first second; lastMin: the earliest in its last).
        private static void EndRun(List<long[]> into, long from, long last, long n, long firstMax, long lastMin)
        {
            if (from < 0) return;
            long len = last + 1000 - from;
            if (firstMax <= EdgeEarlyMaxMs) len -= 1000;
            if (lastMin >= EdgeLateMinMs) len -= 1000;
            if (len >= HoleMinSeconds * 1000L) into.Add(new long[] { from, last + 1000, n });
        }
        // A history silence [from, to) over a known gap: kept when at least HoleMinSeconds long (never trimmed).
        private static void EndSilence(List<long[]> into, long from, long to, long n)
        {
            if (to - from >= HoleMinSeconds * 1000L) into.Add(new long[] { from, to, n });
        }

        // Whether any second of [from, to) is strictly inside a known gap.
        private static bool OverGap(long from, long to, IList<long[]> gaps)
        {
            if (gaps == null || to <= from) return false;
            foreach (long[] g in gaps)
            {
                long lo = g[0] == long.MinValue ? from : Math.Max(from, Sec(g[0]) + 1000);
                long hi = g[1] == long.MaxValue ? to - 1000 : Math.Min(to - 1000, Sec(g[1]) - 1000);
                if (lo <= hi) return true;
            }
            return false;
        }

        private static void Cover(TickCheckResult r, SortedDictionary<long, long[]> by, long from, long to, IList<long[]> gaps)
        {
            r.CoveredLive = 0; r.CoveredHist = 0; r.CoveredSeconds = 0;
            for (long t = from; t <= to; t += 1000) if (!InGap(t, gaps)) r.CoveredSeconds++;
            foreach (KeyValuePair<long, long[]> kv in by)
            {
                long t = kv.Key;
                if (t < from || t > to || InGap(t, gaps)) continue;
                r.CoveredLive += kv.Value[0]; r.CoveredHist += kv.Value[2];
            }
        }

        // A second strictly inside a known gap: after the second of its last live trade before and before the second of the first after.
        public static bool InGap(long t, IList<long[]> gaps)
        {
            if (gaps == null) return false;
            foreach (long[] g in gaps)
                if ((g[0] == long.MinValue || t > Sec(g[0])) && (g[1] == long.MaxValue || t < Sec(g[1]))) return true;
            return false;
        }

        public static long Sec(long u) { return u - ((u % 1000) + 1000) % 1000; }

        private static long[] Slot(SortedDictionary<long, long[]> by, long u)
        {
            long t = Sec(u);
            long[] a;
            if (!by.TryGetValue(t, out a)) { a = new long[] { 0, 0, 0, 0, 1000, -1 }; by[t] = a; }   // {live n, v, hist n, v, live min ms, max ms}
            return a;
        }
    }

    // NinjaTrader's trades of one session, read once on its thread (no other copy kept), sides by ChartBridge's rule.
    public class TickDayBuild
    {
        public readonly List<TickRec> Ticks = new List<TickRec>();
        public long BidAsk, TickRule, None, Outside;
        public string QuoteError;
    }

    public static class ChartBridgeTicks
    {
        private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
        public const string Root = "NQ";

        // ---------------------------------------------------------- settings (config.txt)
        private static bool off;
        public static long MaxBytes = 2048L * 1024 * 1024;
        public static bool On { get { return ChartBridgeBars.Enabled && !off; } }
        public static void ResetConfig() { off = false; MaxBytes = 2048L * 1024 * 1024; }
        public static bool ReadConfig(string key, string val)
        {
            string v = (val ?? "").Trim().ToLowerInvariant();
            if (key == "tickFile") { off = v == "off" || v == "false" || v == "0"; return true; }
            if (key == "tickFileMaxMB")
            {
                long mb;
                if (long.TryParse(v, NumberStyles.Integer, Inv, out mb) && mb >= 16) MaxBytes = mb * 1024 * 1024;
                return true;
            }
            return false;
        }

        // ---------------------------------------------------------- timing (fields so the harness can shorten them)
        public static int QueueMax = 200000;
        public static int WriteEveryMs = 250;
        public static int SendEveryMs = 10000;        // the sender looks every 10 s
        public static int ChunkEveryMs = 180000;      // and cuts chunks every 3 minutes
        public static int ChunkMaxTicks = 20000;
        public static int PartMaxTicks = 20000;
        public static int TimeoutMs = 10000;
        public static int FailRetryMs = 60000;
        public static int NoDeskRetryMs = 1800000;
        public static int RawOldDays = 7;
        public static int MaxTries = 3;
        public static int RetryMinutes = 15;

        public static string Folder { get { return Path.Combine(ChartBridgeConfig.Folder, "ticks"); } }
        private static string DaysFile { get { return Path.Combine(Folder, "tickdays.txt"); } }

        // ---------------------------------------------------------- 1. the live capture (hot path)
        private static readonly ConcurrentQueue<TickRec> Queue = new ConcurrentQueue<TickRec>();
        private static int queued;
        private static volatile bool capturing;
        private static long droppedQueue, droppedDisk, outside, written, feedDrops, lostTotal;

        // From OnMarketData for every live trade: NQ only, never blocks (a full queue drops and counts).
        public static void OnTrade(string root, string contract, double tick, double utcMs, double price, long volume, int side, int method)
        {
            if (!capturing || root != Root) return;
            if (Interlocked.Increment(ref queued) > QueueMax)
            {
                Interlocked.Decrement(ref queued);
                Interlocked.Increment(ref droppedQueue);
                NoteLost((long)Math.Floor(utcMs), (long)Math.Floor(utcMs), 1);   // the drop path only: three more counters, no lock
                return;
            }
            Queue.Enqueue(new TickRec { U = (long)Math.Floor(utcMs), P = price, V = volume, S = side, M = method, Contract = contract, Tick = tick });
        }

        // A feed drop while the market is open (ChartBridgeServer.FeedDropped): the next chunk of every file of the session it falls
        // in says the capture may have a hole (not the hot path: a feed drop is rare, so its time is read here).
        public static void NoteFeedDrop()
        {
            if (!capturing) return;
            DropTimes.Enqueue((long)Math.Round(ChartBridgeTime.UtcMs(ChartBridgeBars.UtcNow())));
            Interlocked.Increment(ref feedDrops);
        }

        // Trades lost (a full queue, a full disk) between the UTC ms first and last: counted, and the times kept so the drops go to the
        // session(s) they fall in (TakeDrops).
        private static void NoteLost(long first, long last, long n)
        {
            Interlocked.CompareExchange(ref firstLostU, first, 0);
            Interlocked.Exchange(ref lastLostU, last);
            Interlocked.Add(ref lostTotal, n);
        }
        private static long firstLostU, lastLostU;
        private static readonly ConcurrentQueue<long> DropTimes = new ConcurrentQueue<long>();

        // ---------------------------------------------------------- the files of one session and contract
        // Carried: a later chunk of a cut that took drops: its gaps (1) is the flag only, not a count (the cut's first chunk has them).
        private class Cut { public int Seq; public long From, To; public int N; public long Lost, Gaps, BidAsk, TickRule, None; public bool Carried; }
        private class KeyFiles
        {
            public string Key, Session, Contract, Raw, State, Run;
            public double Tick = 0.25;
            public long CutTo;
            public long LostSeen, GapsSeen;   // the session's drops (SessionDrops) already put on a chunk of this file, this run
            public bool MadeHere, CutThisRun; // the files made by this run; a cut made by this run
            public readonly List<Cut> Cuts = new List<Cut>();
            public readonly HashSet<int> Sent = new HashSet<int>(), Aside = new HashSet<int>();
        }
        private static readonly object Sync = new object();
        private static readonly Dictionary<string, KeyFiles> Keys = new Dictionary<string, KeyFiles>();
        private static readonly Dictionary<string, string> LastSent = new Dictionary<string, string>();
        private static long diskBytes;

        public static string KeyOf(string session, string contract) { return session + " " + contract; }
        public static string BaseOf(string key)
        {
            StringBuilder b = new StringBuilder();
            foreach (char ch in key) b.Append(char.IsLetterOrDigit(ch) || ch == '-' ? ch : '_');
            return b.ToString();
        }
        private static string NewId() { return Guid.NewGuid().ToString("N").Substring(0, 12); }

        // On the writer's or sender's thread: the key's files, made on the first trade (state: "run <id>", "tick <size>").
        private static KeyFiles FilesOf(string session, string contract, double tick, bool make)
        {
            string key = KeyOf(session, contract);
            lock (Sync)
            {
                KeyFiles k;
                if (Keys.TryGetValue(key, out k)) return k;
                string b = Path.Combine(Folder, BaseOf(key));
                k = new KeyFiles { Key = key, Session = session, Contract = contract, Raw = b + ".raw", State = b + ".state" };
                if (File.Exists(k.State)) ReadState(k);
                else if (make)
                {
                    Directory.CreateDirectory(Folder);
                    k.Run = NewId(); k.Tick = tick > 0 ? tick : 0.25; k.MadeHere = true;
                    File.WriteAllLines(k.State, new string[] { "run " + k.Run, "tick " + k.Tick.ToString("R", Inv), "contract " + contract, "session " + session });
                }
                else return null;
                Keys[key] = k;
                return k;
            }
        }

        private static void ReadState(KeyFiles k)
        {
            foreach (string raw in File.ReadAllLines(k.State))
            {
                string[] f = raw.Trim().Split(' ');
                if (f.Length < 2) continue;
                if (f[0] == "run") k.Run = f[1];
                else if (f[0] == "tick") { double t; if (double.TryParse(f[1], NumberStyles.Float, Inv, out t) && t > 0) k.Tick = t; }
                else if (f[0] == "cut" && f.Length >= 11)
                {
                    Cut c = new Cut();
                    c.Seq = int.Parse(f[1], Inv); c.From = long.Parse(f[2], Inv); c.To = long.Parse(f[3], Inv); c.N = int.Parse(f[4], Inv);
                    c.Lost = long.Parse(f[5], Inv); c.Gaps = long.Parse(f[6], Inv); c.BidAsk = long.Parse(f[7], Inv); c.TickRule = long.Parse(f[8], Inv); c.None = long.Parse(f[9], Inv);
                    c.Carried = f[10] == "c";
                    k.Cuts.Add(c); if (c.To > k.CutTo) k.CutTo = c.To;
                }
                else if (f[0] == "sent") k.Sent.Add(int.Parse(f[1], Inv));
                else if (f[0] == "aside") k.Aside.Add(int.Parse(f[1], Inv));
            }
            if (k.Run == null) k.Run = NewId();
        }

        // ---------------------------------------------------------- the writer
        // One pass: the queue to the raw files, whole lines. Public for the harness. One writer at a time (an old writer thread
        // still finishing after a restart and the new one never append to a raw file together).
        private static readonly object WriteSync = new object();
        public static int WriteOnce() { lock (WriteSync) return WriteBatch(); }
        private static int WriteBatch()
        {
            List<TickRec> batch = new List<TickRec>();
            TickRec x;
            while (batch.Count < 400000 && Queue.TryDequeue(out x)) { batch.Add(x); Interlocked.Decrement(ref queued); }
            if (batch.Count == 0) return 0;
            if (diskBytes > MaxBytes)
            {
                Interlocked.Add(ref droppedDisk, batch.Count); NoteLost(batch[0].U, batch[batch.Count - 1].U, batch.Count);
                error = "the ticks folder is over tickFileMaxMB (" + (MaxBytes / 1048576) + " MB): trades are not written";
                return 0;
            }
            Dictionary<string, StringBuilder> lines = new Dictionary<string, StringBuilder>();
            Dictionary<string, TickRec> firstOf = new Dictionary<string, TickRec>();
            long hourKey = long.MinValue; DateTime hourDate = DateTime.MinValue; string hourSession = null;
            foreach (TickRec r in batch)
            {
                long hk = r.U / 3600000L;   // the session of a trade by its New York hour (a session starts and ends on an hour)
                if (hk != hourKey)
                {
                    hourKey = hk;
                    DateTime et = TimeZoneInfo.ConvertTimeFromUtc(new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(hk * 3600000L), ChartBridgeTime.Eastern);
                    hourDate = ChartBridgeBars.SessionDateOfEt(et);
                    hourSession = hourDate == DateTime.MinValue ? null : hourDate.ToString("yyyy-MM-dd", Inv);
                }
                if (hourSession == null) { Interlocked.Increment(ref outside); continue; }
                string key = KeyOf(hourSession, r.Contract ?? "");
                StringBuilder b;
                if (!lines.TryGetValue(key, out b)) { b = new StringBuilder(); lines[key] = b; firstOf[key] = r; }
                b.Append(r.U.ToString(Inv)).Append(',').Append(r.P.ToString("R", Inv)).Append(',').Append(r.V.ToString(Inv)).Append(',')
                 .Append(r.S.ToString(Inv)).Append(',').Append(r.M.ToString(Inv)).Append('\n');
            }
            int n = 0;
            foreach (KeyValuePair<string, StringBuilder> kv in lines)
            {
                TickRec f = firstOf[kv.Key];
                KeyFiles k = FilesOf(kv.Key.Substring(0, 10), f.Contract ?? "", f.Tick, true);
                byte[] bytes = Encoding.ASCII.GetBytes(kv.Value.ToString());
                using (FileStream fs = new FileStream(k.Raw, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
                    fs.Write(bytes, 0, bytes.Length);
                Interlocked.Add(ref diskBytes, bytes.Length);
                int c = 0; foreach (char ch in kv.Value.ToString()) if (ch == '\n') c++;
                n += c;
            }
            Interlocked.Add(ref written, n);
            return n;
        }

        // ---------------------------------------------------------- 2. chunks
        // Drops go to the session they fall in: per session the running totals {lost, gaps}; each file takes the part it has not put
        // on a chunk yet (KeyFiles.LostSeen, GapsSeen) at its next cut, and only when that cut is made, so a file with nothing to cut
        // keeps them for the cut after (a feed down for a while has nothing to cut). Every file of the session takes them (the roll
        // week has two contracts; a drop is not known to one). lostTaken: the lost trades already given to sessions.
        private static readonly Dictionary<string, long[]> SessionDrops = new Dictionary<string, long[]>();
        private static long lostTaken;
        private static DateTime runStartUtc = DateTime.MinValue;

        // The session a UTC ms falls in, "yyyy-MM-dd", or null in the break or the weekend.
        public static string SessionOfMs(long u)
        {
            DateTime et = TimeZoneInfo.ConvertTimeFromUtc(new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(u), ChartBridgeTime.Eastern);
            DateTime d = ChartBridgeBars.SessionDateOfEt(et);
            return d == DateTime.MinValue ? null : d.ToString("yyyy-MM-dd", Inv);
        }

        private static long[] DropsOf(string session)
        {
            long[] a;
            if (!SessionDrops.TryGetValue(session, out a)) { a = new long[2]; SessionDrops[session] = a; }
            return a;
        }

        // The drops counted since the last cut, put on their sessions' totals (the sender thread, inside CutOnce).
        private static void TakeDrops()
        {
            long total = Interlocked.Read(ref lostTotal), lost = total - lostTaken;
            if (lost > 0)
            {
                long last = Interlocked.Read(ref lastLostU), first = Interlocked.Exchange(ref firstLostU, 0);
                if (first == 0) first = last;
                string a = SessionOfMs(first), b = SessionOfMs(last);
                lock (Sync)
                {
                    if (a != null) DropsOf(a)[0] += lost;
                    if (b != null && b != a) DropsOf(b)[0] += lost;
                }
                lostTaken = total;
            }
            long at;
            while (DropTimes.TryDequeue(out at))
            {
                string s = SessionOfMs(at);
                if (s != null) lock (Sync) DropsOf(s)[1]++;
            }
        }

        // A file this run did not make, or made after its session had opened, may miss trades from before this run's first cut: its
        // first cut this run says gaps 1 or more (a restart is never vouched for; The Desk does not vouch from the chunks before).
        private static bool MayMissBefore(KeyFiles k)
        {
            if (!k.MadeHere) return true;
            DateTime s;
            if (!DateTime.TryParseExact(k.Session, "yyyy-MM-dd", Inv, DateTimeStyles.None, out s)) return true;
            DateTime ou, cu; ChartBridgeBars.SessionUtc(s, out ou, out cu);
            return runStartUtc > ou;
        }

        // Reads the raw file's bytes [from, to) as trades.
        private static List<TickRec> ReadRange(KeyFiles k, long from, long to)
        {
            List<TickRec> list = new List<TickRec>();
            if (to <= from) return list;
            byte[] buf = new byte[to - from];
            using (FileStream fs = new FileStream(k.Raw, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                fs.Seek(from, SeekOrigin.Begin);
                int got = 0;
                while (got < buf.Length) { int r = fs.Read(buf, got, buf.Length - got); if (r <= 0) break; got += r; }
            }
            foreach (string line in Encoding.ASCII.GetString(buf).Split('\n'))
            {
                TickRec t;
                if (ParseLine(line, k.Contract, out t)) list.Add(t);
            }
            return list;
        }

        public static bool ParseLine(string line, string contract, out TickRec t)
        {
            t = new TickRec();
            string[] f = (line ?? "").Trim().Split(',');
            if (f.Length != 5) return false;
            long u, v; double p; int s, m;
            if (!long.TryParse(f[0], NumberStyles.Integer, Inv, out u) || !double.TryParse(f[1], NumberStyles.Float, Inv, out p) ||
                !long.TryParse(f[2], NumberStyles.Integer, Inv, out v) || !int.TryParse(f[3], NumberStyles.Integer, Inv, out s) ||
                !int.TryParse(f[4], NumberStyles.Integer, Inv, out m)) return false;
            t = new TickRec { U = u, P = p, V = v, S = s, M = m, Contract = contract };
            return true;
        }

        public static List<TickRec> ReadAllLive(string key)
        {
            KeyFiles k;
            lock (Sync) Keys.TryGetValue(key, out k);
            if (k == null || !File.Exists(k.Raw)) return new List<TickRec>();
            return ReadRange(k, 0, new FileInfo(k.Raw).Length);
        }

        // Cuts the bytes after the last cut, to the last whole line, into chunks of at most ChunkMaxTicks. Public for the harness.
        // Never two cutters (the restart race): a cut runs under CutSync and only for the current generation; Start() takes CutSync
        // before it clears the files, so an old sender still cutting finishes first and the new one reads its cuts from the state
        // files; an old sender that comes later finds another generation and cuts nothing. So `cut <seq>` is written once.
        private static readonly object CutSync = new object();
        public static int CutOnce() { return CutOnce(Volatile.Read(ref generation)); }
        private static int CutOnce(int gen)
        {
            lock (CutSync)
            {
                if (gen != Volatile.Read(ref generation)) return 0;
                return CutLocked();
            }
        }
        private static int CutLocked()
        {
            RecountDisk();
            TakeDrops();
            List<KeyFiles> keys; lock (Sync) keys = Keys.Values.ToList();
            int made = 0;
            foreach (KeyFiles k in keys)
            {
                if (!File.Exists(k.Raw)) continue;
                long len = new FileInfo(k.Raw).Length;
                if (len <= k.CutTo) continue;
                long[] tot; lock (Sync) { long[] d = DropsOf(k.Session); tot = new long[] { d[0], d[1] }; }
                long lost = tot[0] - k.LostSeen, gaps = tot[1] - k.GapsSeen;
                if (!k.CutThisRun && MayMissBefore(k)) gaps = Math.Max(gaps, 1);
                // Every chunk of a cut that took drops is flagged (re-review 1): the drop's trades may sit in any of them (a cut of
                // several chunks: the queue full after a writer stall, a minute of more than ChunkMaxTicks). The first chunk carries
                // the counts; the others gaps 1, marked carried ("c") in the state so the day's totals count each drop once.
                bool flagged = lost > 0 || gaps > 0, carried = false;
                byte[] buf = new byte[len - k.CutTo];
                using (FileStream fs = new FileStream(k.Raw, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    fs.Seek(k.CutTo, SeekOrigin.Begin);
                    int got = 0;
                    while (got < buf.Length) { int r = fs.Read(buf, got, buf.Length - got); if (r <= 0) break; got += r; }
                }
                long baseAt = k.CutTo, pos = baseAt, start = baseAt;   // CutLine moves k.CutTo: the bytes' own start is kept here
                int n = 0; long ba = 0, tr = 0, no = 0;
                List<string> notes = new List<string>();
                for (int i = 0; i < buf.Length; i++)
                {
                    if (buf[i] != (byte)'\n') continue;
                    // the line's method (its last field) for the sides' counts
                    int j = i - 1; while (j >= 0 && buf[j] != (byte)',') j--;
                    char m = j >= 0 && j + 1 < i ? (char)buf[j + 1] : '0';
                    if (m == '1' || m == '2') ba++; else if (m == '3') tr++; else no++;
                    n++;
                    pos = baseAt + i + 1;
                    if (n >= ChunkMaxTicks) { notes.Add(CutLine(k, start, pos, n, lost, gaps, ba, tr, no, carried)); lost = 0; gaps = flagged ? 1 : 0; carried = flagged; start = pos; n = 0; ba = tr = no = 0; made++; }
                }
                if (n > 0) { notes.Add(CutLine(k, start, pos, n, lost, gaps, ba, tr, no, carried)); made++; }
                if (notes.Count > 0)
                {
                    File.AppendAllLines(k.State, notes);
                    lock (Sync) { k.LostSeen = tot[0]; k.GapsSeen = tot[1]; k.CutThisRun = true; }   // taken up only now a cut is made
                }
            }
            return made;
        }

        private static string CutLine(KeyFiles k, long from, long to, int n, long lost, long gaps, long ba, long tr, long no, bool carried)
        {
            Cut c = new Cut { Seq = k.Cuts.Count + 1, From = from, To = to, N = n, Lost = lost, Gaps = gaps, BidAsk = ba, TickRule = tr, None = no, Carried = carried };
            lock (Sync) { k.Cuts.Add(c); k.CutTo = to; }
            return "cut " + c.Seq + " " + from + " " + to + " " + n + " " + lost + " " + gaps + " " + ba + " " + tr + " " + no + (carried ? " c" : " .");
        }

        // The chunk's message: the same bytes read again make the same message.
        public static string ChunkJson(string key, int seq)
        {
            KeyFiles k; lock (Sync) Keys.TryGetValue(key, out k);
            if (k == null) return null;
            Cut c = k.Cuts.FirstOrDefault(x => x.Seq == seq);
            if (c == null) return null;
            List<TickRec> t = ReadRange(k, c.From, c.To);
            long vol = 0; foreach (TickRec r in t) vol += r.V;
            StringBuilder b = new StringBuilder(256 + t.Count * 32);
            b.Append("{\"v\":1,\"source\":\"chartbridge\",\"bridge\":").Append(CbJson.Str(ChartBridgeServer.Version))
             .Append(",\"pc\":").Append(CbJson.Str(ChartBridgeBars.PcName()))
             .Append(",\"root\":\"NQ\",\"contract\":").Append(CbJson.Str(k.Contract))
             .Append(",\"tick\":").Append(CbJson.Num(k.Tick))
             .Append(",\"session\":").Append(CbJson.Str(k.Session))
             .Append(",\"run\":").Append(CbJson.Str(k.Run))
             .Append(",\"seq\":").Append(seq.ToString(Inv))
             .Append(",\"count\":").Append(t.Count.ToString(Inv)).Append(",\"volume\":").Append(vol.ToString(Inv))
             .Append(",\"first\":").Append(t.Count > 0 ? t[0].U.ToString(Inv) : "null")
             .Append(",\"last\":").Append(t.Count > 0 ? t[t.Count - 1].U.ToString(Inv) : "null")
             .Append(",\"lost\":").Append(c.Lost.ToString(Inv)).Append(",\"gaps\":").Append(c.Gaps.ToString(Inv))
             .Append(",\"sides\":{\"bidAsk\":").Append(c.BidAsk.ToString(Inv)).Append(",\"tickRule\":").Append(c.TickRule.ToString(Inv)).Append(",\"none\":").Append(c.None.ToString(Inv)).Append('}')
             .Append(",\"cols\":[\"u\",\"p\",\"v\",\"s\"],\"ticks\":[");
            AppendTicks(b, t, 0, t.Count);
            b.Append("]}");
            return b.ToString();
        }

        private static void AppendTicks(StringBuilder b, IList<TickRec> t, int i0, int i1)
        {
            for (int i = i0; i < i1; i++)
            {
                if (i > i0) b.Append(',');
                b.Append('[').Append(t[i].U.ToString(Inv)).Append(',').Append(CbJson.Num(t[i].P)).Append(',').Append(t[i].V.ToString(Inv)).Append(',').Append(t[i].S.ToString(Inv)).Append(']');
            }
        }

        // ---------------------------------------------------------- sending (the sender thread)
        private enum Sent2 { Taken, Refused, NoDesk, Failed, Stopped }
        private static volatile bool deskHasNone;
        private static DateTime retryAt = DateTime.MinValue;
        private static volatile string error = "", lastAnswer = "";
        private static readonly object AbortSync = new object();
        private static int stopGen;
        private static HttpWebRequest inFlight;

        // Posts the chunks not taken yet, oldest key and seq first, until one fails. Public for the harness.
        public static int SendChunks(Func<bool> stopping)
        {
            int gen = Volatile.Read(ref stopGen), sent = 0;
            if (deskHasNone && ChartBridgeBars.UtcNow() < retryAt) return 0;
            List<KeyFiles> keys; lock (Sync) keys = Keys.Values.OrderBy(k => k.Key, StringComparer.Ordinal).ToList();
            foreach (KeyFiles k in keys)
            {
                List<Cut> cuts; lock (Sync) cuts = k.Cuts.Where(c => !k.Sent.Contains(c.Seq) && !k.Aside.Contains(c.Seq)).OrderBy(c => c.Seq).ToList();
                if (cuts.Count > 0 && !File.Exists(k.Raw)) { RawGone(k, null); continue; }   // review LOW 3: never thrown every loop
                foreach (Cut c in cuts)
                {
                    if (stopping != null && stopping()) return sent;
                    string body;
                    try { body = ChunkJson(k.Key, c.Seq); }
                    catch (Exception ex) { if (File.Exists(k.Raw)) throw; RawGone(k, ex.Message); break; }   // deleted as it was read
                    if (body == null) continue;
                    int code; string answer;
                    Sent2 r = Post("/api/ticks/chunk", body, gen, out code, out answer);
                    if (r == Sent2.Stopped) return sent;
                    if (r == Sent2.Taken)
                    {
                        if (deskHasNone) ChartBridgeServer.Log("The Desk is taking the NQ tick file's chunks again.");
                        deskHasNone = false; error = "";
                        lock (Sync) { k.Sent.Add(c.Seq); LastSent[k.Contract] = k.Session + " #" + c.Seq; }
                        File.AppendAllLines(k.State, new string[] { "sent " + c.Seq });
                        sent++;
                        continue;
                    }
                    if (r == Sent2.Refused)
                    {
                        lock (Sync) k.Aside.Add(c.Seq);
                        File.AppendAllLines(k.State, new string[] { "aside " + c.Seq });
                        ChartBridgeServer.Log("The Desk refused tick chunk " + c.Seq + " of " + k.Key + " (" + code + (answer.Length > 0 ? ": " + answer : "") + "); set aside, its trades stay in the raw file and the final pull covers them");
                        continue;
                    }
                    if (r == Sent2.NoDesk)
                    {
                        if (!deskHasNone) ChartBridgeServer.Log("The Desk has no tick file route yet (POST /api/ticks/chunk answered 404): chunks wait on disk and are offered again every " + (NoDeskRetryMs / 60000) + " minutes");
                        deskHasNone = true; retryAt = ChartBridgeBars.UtcNow().AddMilliseconds(NoDeskRetryMs); error = "The Desk has no tick file route (404)";
                    }
                    else error = "chunk not taken: " + answer;
                    return sent;
                }
            }
            return sent;
        }

        // A key with chunks not sent whose raw file is gone: passed over (the later keys' chunks still go), said once a run.
        private static readonly HashSet<string> RawGoneSaid = new HashSet<string>();
        private static void RawGone(KeyFiles k, string why)
        {
            bool first; lock (Sync) first = RawGoneSaid.Add(k.Key);
            if (!first) return;
            ChartBridgeServer.Log("the NQ tick file for " + k.Key + ": the raw file is gone (" + (why ?? "not in the ticks folder") + "); its chunks not sent are passed over");
        }

        private static async Task<WebResponse> PostAsync(HttpWebRequest req, byte[] bytes)
        {
            using (Stream st = await req.GetRequestStreamAsync()) await st.WriteAsync(bytes, 0, bytes.Length);
            return await req.GetResponseAsync();
        }

        private static readonly Regex DetailRx = new Regex("\"detail\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");

        private static Sent2 Post(string path, string body, int gen, out int code, out string answer)
        {
            code = 0; answer = "";
            HttpWebRequest req = null;
            try
            {
                byte[] bytes = Encoding.UTF8.GetBytes(body);
                req = (HttpWebRequest)WebRequest.Create(ChartBridgeConfig.DeskUrl + path);
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Proxy = null;   // never through a proxy (The Desk refuses one)
                lock (AbortSync) { if (stopGen != gen) return Sent2.Stopped; inFlight = req; }
                Task<WebResponse> call = PostAsync(req, bytes);
                if (!call.Wait(TimeoutMs) && !call.IsCompleted)
                {
                    try { req.Abort(); } catch (Exception) { }
                    Task observed = call.ContinueWith(t => { Exception ignored = t.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
                    throw new TimeoutException("The Desk did not answer within " + (TimeoutMs / 1000) + " seconds");
                }
                using (WebResponse res = call.Result)
                using (StreamReader rd = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                    answer = rd.ReadToEnd();
                code = 200;
                lastAnswer = answer.Length > 300 ? answer.Substring(0, 300) : answer;
                return Sent2.Taken;
            }
            catch (Exception ex)
            {
                Exception e = ex is AggregateException && ex.InnerException != null ? ex.InnerException : ex;
                WebException wex = e as WebException;
                HttpWebResponse res = wex != null ? wex.Response as HttpWebResponse : null;
                code = res != null ? (int)res.StatusCode : 0;
                if (code == 400 || code == 413 || code == 422)
                {
                    try { using (StreamReader r = new StreamReader(res.GetResponseStream(), Encoding.UTF8)) { Match m = DetailRx.Match(r.ReadToEnd()); if (m.Success) answer = m.Groups[1].Value.Length > 200 ? m.Groups[1].Value.Substring(0, 200) : m.Groups[1].Value; } } catch (Exception) { }
                    return Sent2.Refused;
                }
                if (Volatile.Read(ref stopGen) != gen) return Sent2.Stopped;
                if (code == 404) return Sent2.NoDesk;
                answer = e.Message;
                return Sent2.Failed;
            }
            finally { lock (AbortSync) { if (inFlight == req) inFlight = null; } }
        }

        // ---------------------------------------------------------- 3. the final file
        // tickdays.txt: one line a day: "<key>\t<check>\t<stored>\t<packed>\t<rule>" (check exact, filled, short or failed; stored and
        // packed 0 or 1; rule the check's rule it was made under, TickCheck.Rule, from 0.6.14). A line of 0.6.13 or before has no rule
        // field and reads as rule 1.
        private class DayRec { public string Key, Check; public bool Stored, Packed; public int Rule = TickCheck.Rule; }
        private static readonly Dictionary<string, DayRec> Days = new Dictionary<string, DayRec>();
        private static readonly Dictionary<string, DateTime> RetryAtDay = new Dictionary<string, DateTime>();
        private static readonly Dictionary<string, int> TriesDay = new Dictionary<string, int>();
        private static volatile string dayState = "off", lastDay = "";

        // 0.6.14, the check again under the new rule (Anthony 2026-11-03): at EVERY start (LoadDays) each day tickdays.txt notes failed
        // under rule 1 (a line with no rule field: 0.6.13 or before wrote it) whose raw file is in the folder is to be checked again
        // (Recheck); ticks/tickrule.txt ("rule 2", then "recheck <key>" lines) is the record of that list, written again whenever it
        // differs. A listed day is not done: its final pull runs once more (the same windows, the 15 minutes and the 3 tries, again
        // after a restart), the new check's record (rule 2) replaces the failed one, and the key leaves the list. A day checked by
        // 0.6.14 has rule 2, so it is checked again at most once per failed rule 1 record, whatever happens to tickrule.txt; a round
        // trip to 0.6.13 and back (0.6.13 rewrites the day as a four field line) is healed at the next start of 0.6.14 (the PR #79
        // re-review, LOW B). A day whose raw file is gone cannot be checked again and stays failed. A day checked again is sent again
        // as a new set.
        private static readonly HashSet<string> Recheck = new HashSet<string>();
        private static string RuleFile { get { return Path.Combine(Folder, "tickrule.txt"); } }

        private static void LoadDays()
        {
            bool write = false;
            lock (Sync)
            {
                Days.Clear();
                Recheck.Clear();
                if (File.Exists(DaysFile))
                    foreach (string raw in File.ReadAllLines(DaysFile))
                    {
                        string[] f = raw.Split('\t');
                        if (f.Length != 4 && f.Length != 5) continue;
                        int rule = 1;
                        if (f.Length == 5 && !int.TryParse(f[4], NumberStyles.Integer, Inv, out rule)) rule = 1;
                        Days[f[0]] = new DayRec { Key = f[0], Check = f[1], Stored = f[2] == "1", Packed = f[3] == "1", Rule = rule };
                    }
                foreach (DayRec d in Days.Values) if (MayRecheck(d.Key)) Recheck.Add(d.Key);
                // the record: written when it is not there or lists other days (a key checked again or its raw gone is dropped)
                HashSet<string> listed = new HashSet<string>();
                bool there = File.Exists(RuleFile);
                if (there)
                    foreach (string raw in File.ReadAllLines(RuleFile))
                        if (raw.StartsWith("recheck ", StringComparison.Ordinal)) listed.Add(raw.Substring(8).Trim());
                write = !there || !listed.SetEquals(Recheck);
            }
            if (write) SaveRule();
        }
        // Under Sync: failed under rule 1 (before 0.6.14) and its raw file still there.
        private static bool MayRecheck(string key)
        {
            DayRec d;
            return Days.TryGetValue(key, out d) && d.Check == "failed" && d.Rule < 2 && File.Exists(Path.Combine(Folder, BaseOf(key) + ".raw"));
        }
        private static void SaveRule()
        {
            List<string> lines = new List<string> { "rule " + TickCheck.Rule };
            lock (Sync) lines.AddRange(Recheck.OrderBy(x => x, StringComparer.Ordinal).Select(x => "recheck " + x));
            Directory.CreateDirectory(Folder);
            string tmp = RuleFile + ".tmp";
            File.WriteAllLines(tmp, lines.ToArray());
            if (File.Exists(RuleFile)) File.Replace(tmp, RuleFile, null); else File.Move(tmp, RuleFile);
        }
        private static void SaveDays()
        {
            List<string> lines; lock (Sync) lines = Days.Values.OrderBy(d => d.Key, StringComparer.Ordinal).Select(d => d.Key + "\t" + d.Check + "\t" + (d.Stored ? "1" : "0") + "\t" + (d.Packed ? "1" : "0") + "\t" + d.Rule.ToString(Inv)).ToList();
            Directory.CreateDirectory(Folder);
            string tmp = DaysFile + ".tmp";
            File.WriteAllLines(tmp, lines.ToArray());
            if (File.Exists(DaysFile)) File.Replace(tmp, DaysFile, null); else File.Move(tmp, DaysFile);
        }

        // Done: recorded in tickdays.txt and not listed to be checked again under the 0.6.14 rule.
        public static bool IsDayDone(string key) { lock (Sync) return Days.ContainsKey(key) && !Recheck.Contains(key); }

        // NinjaTrader's trades of [fromMs, toMs) on its thread: one pass, sides by the stored bid and ask else the tick rule.
        public static object BuildTickDay(Bars bars, long fromMs, long toMs, string contract)
        {
            TickDayBuild d = new TickDayBuild();
            bool quotes = true, hasPrev = false; double prevPrice = 0; int prevSide = 0;
            long hourKey = long.MinValue, offsetTicks = 0;
            long epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).Ticks;
            int n = bars.Count;
            for (int i = 0; i < n; i++)
            {
                DateTime nt = bars.GetTime(i);
                long hk = nt.Ticks / TimeSpan.TicksPerHour;
                if (hk != hourKey) { hourKey = hk; offsetTicks = nt.Ticks - ChartBridgeTime.ToUtc(nt).Ticks; }
                long ms = (nt.Ticks - offsetTicks - epoch) / TimeSpan.TicksPerMillisecond;
                double price = bars.GetClose(i);
                if (ms < fromMs || ms >= toMs || !(price > 0)) { d.Outside++; continue; }
                double bid = double.NaN, ask = double.NaN;
                if (quotes)
                {
                    try { bid = bars.GetBid(i); ask = bars.GetAsk(i); }
                    catch (Exception ex) { quotes = false; bid = double.NaN; ask = double.NaN; d.QuoteError = ex.Message; }
                }
                int method;
                int side = ChartBridgeSides.Classify(price, bid, ask, hasPrev, prevPrice, prevSide, out method);
                if (method == ChartBridgeSides.BidAsk) d.BidAsk++; else if (method == ChartBridgeSides.TickRule) d.TickRule++; else d.None++;
                hasPrev = true; prevPrice = price; prevSide = side;
                d.Ticks.Add(new TickRec { U = ms, P = price, V = bars.GetVolume(i), S = side, M = method, Contract = contract });
            }
            return d;
        }

        // The keys with a raw file whose session has closed and that are not done yet, oldest first.
        public static List<string> DaysToPull(DateTime nowUtc)
        {
            List<string> out1 = new List<string>();
            List<KeyFiles> keys; lock (Sync) keys = Keys.Values.ToList();
            foreach (KeyFiles k in keys.OrderBy(x => x.Key, StringComparer.Ordinal))
            {
                if (IsDayDone(k.Key) || !File.Exists(k.Raw)) continue;
                DateTime s;
                if (!DateTime.TryParseExact(k.Session, "yyyy-MM-dd", Inv, DateTimeStyles.None, out s)) continue;
                DateTime ou, cu; ChartBridgeBars.SessionUtc(s, out ou, out cu);
                if (nowUtc < cu.Add(ChartBridgeBars.CloseDelay)) continue;
                DateTime notBefore;
                lock (Sync)
                {
                    int tries; TriesDay.TryGetValue(k.Key, out tries);
                    if (tries >= MaxTries) continue;
                    if (RetryAtDay.TryGetValue(k.Key, out notBefore) && nowUtc < notBefore) continue;
                }
                out1.Add(k.Key);
            }
            return out1;
        }

        private static void LaterDay(string key, string why)
        {
            int n;
            lock (Sync) { TriesDay.TryGetValue(key, out n); TriesDay[key] = ++n; RetryAtDay[key] = ChartBridgeBars.UtcNow().AddMinutes(RetryMinutes); }
            error = key + ": " + why;
            ChartBridgeServer.Log("the NQ tick file for " + key + ": " + why + (n >= MaxTries ? "; tried " + MaxTries + " times, not asked again until ChartBridge restarts" : "; trying again in " + RetryMinutes + " minutes"));
        }

        // Anthony 2026-11-03: he sometimes closes NinjaTrader before 16:15 (e.g. 16:05), so a session's final pull never ran that day.
        // The catch-up: the final pull of a session that has CLOSED (a raw file, not done) may also START on a weekday morning, from
        // ChartBridge's start until 09:15 New York (Monday to Friday; the weekend keeps its own rule). Only this pull: the 1 second
        // bars keep In1sStartWindow, and the day's sends keep In1sWindow. A request out at 09:15 is never cut: the gate checks the
        // window only at the moment it would send the request (BarsTicket.MayStart); one already out finishes as any other.
        // MorningStart: when the morning window opens (New York). 00:00 is the behaviour Anthony has today (from ChartBridge's start,
        // any time after midnight); a later start (e.g. 06:00) is this one line once Anthony answers. dayState's text follows it.
        public static TimeSpan MorningStart = new TimeSpan(0, 0, 0);
        public static TimeSpan MorningEnd = new TimeSpan(9, 15, 0);
        public static bool InMorningWindow(DateTime et)
        {
            if (et.DayOfWeek == DayOfWeek.Saturday || et.DayOfWeek == DayOfWeek.Sunday) return false;
            return et.TimeOfDay >= MorningStart && et.TimeOfDay < MorningEnd;
        }
        // When a final pull may start: the 1 second bars' start window, or a weekday morning in the morning window.
        public static bool InDayStartWindow(DateTime et) { return ChartBridgeBars.In1sStartWindow(et) || InMorningWindow(et); }
        public static string DayWaitText
        {
            get
            {
                string morning = MorningStart == TimeSpan.Zero ? "before " + Hm(MorningEnd) : Hm(MorningStart) + " to " + Hm(MorningEnd);
                return "waiting: the final pull goes 16:15 to 17:50 ET on weekdays, " + morning + " ET on weekday mornings, and on the weekend";
            }
        }
        private static string Hm(TimeSpan t) { return t.Hours.ToString("00", Inv) + ":" + t.Minutes.ToString("00", Inv); }
        private static DateTime NowEt() { return TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(ChartBridgeBars.UtcNow(), DateTimeKind.Utc), ChartBridgeTime.Eastern); }

        // On the bars worker, after the 1-minute and 1 second bars of a pass, and only when those asked nothing this pass: at most one
        // session's final pull, only in InDayStartWindow. Returns true when it asked NinjaTrader.
        public static bool PlanDay(Func<bool> stopping)
        {
            if (!On) { dayState = "off"; return false; }
            DateTime nowUtc = ChartBridgeBars.UtcNow();
            DateTime nowEt = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(nowUtc, DateTimeKind.Utc), ChartBridgeTime.Eastern);
            if (!InDayStartWindow(nowEt)) { dayState = DayWaitText; return false; }
            bool morning = !ChartBridgeBars.In1sStartWindow(nowEt);   // the morning catch-up: it must start before 09:15 ET
            ScanFolder();
            List<string> due = DaysToPull(nowUtc);
            if (due.Count == 0) { dayState = "idle"; return false; }
            string key = due[0];
            KeyFiles k; lock (Sync) k = Keys[key];
            Instrument inst = null;
            try { inst = ChartBridgeBars.Lookup(k.Contract); } catch (Exception) { inst = null; }
            if (inst == null || inst.MasterInstrument == null) { LaterDay(key, "NinjaTrader does not know the instrument"); return false; }
            DateTime session = DateTime.ParseExact(k.Session, "yyyy-MM-dd", Inv);
            DateTime openUtc, closeUtc; ChartBridgeBars.SessionUtc(session, out openUtc, out closeUtc);
            TimeZoneInfo ntZone = NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo;
            DateTime fromNt = TimeZoneInfo.ConvertTimeFromUtc(openUtc, ntZone), toNt = TimeZoneInfo.ConvertTimeFromUtc(closeUtc, ntZone);
            long fromMs = (long)Math.Round(ChartBridgeTime.UtcMs(openUtc)), toMs = (long)Math.Round(ChartBridgeTime.UtcMs(closeUtc));
            BarsTicket t = new BarsTicket();
            if (morning) t.MayStart = () => InMorningWindow(NowEt());   // checked by the gate as it sends: none starts at 09:15 or later
            string contract = k.Contract;
            string busy = ChartBridgeServer.GateBars("ticks " + key, inst, fromNt, toNt, ChartBridgeBars.Request1sTimeoutMs, stopping, t, bars => BuildTickDay(bars, fromMs, toMs, contract));
            if (busy != null) { dayState = "waiting for the gate: " + busy; return false; }
            dayState = "asking NinjaTrader: ticks " + key + (morning ? " (the morning catch-up)" : "");
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            long giveUpMs = (long)ChartBridgeBars.QueueWaitMs + ChartBridgeBars.Request1sTimeoutMs + ChartBridgeServer.AnswerCopyMs + 5000;
            while (!t.Done.Wait(50))
            {
                if (stopping != null && stopping()) { ChartBridgeServer.GateBarsWithdraw(t); return true; }
                if (!t.Started && sw.ElapsedMilliseconds > ChartBridgeBars.QueueWaitMs && ChartBridgeServer.GateBarsWithdraw(t)) { dayState = "waiting for the gate"; return true; }
                if (sw.ElapsedMilliseconds > giveUpMs) { LaterDay(key, "no answer from the gate"); return true; }
            }
            if (t.GateStuck) { dayState = "waiting for the gate: " + t.Error; return true; }
            if (t.NotStarted) { dayState = DayWaitText; return true; }   // the morning window closed while it waited at the gate: nothing went out, not a try
            if (t.Error != null) { LaterDay(key, t.Error); return true; }
            TickDayBuild hist = t.Built as TickDayBuild;
            if (hist == null || hist.Ticks.Count == 0) { LaterDay(key, "NinjaTrader has no trades for it"); return true; }
            if (stopping != null && stopping()) return true;
            FinishDay(k, hist);
            return true;
        }

        // The check, the parts written whole to <key>.day.jsonl, and the record. Public for the harness.
        public static TickCheckResult FinishDay(string key, TickDayBuild hist)
        {
            KeyFiles k; lock (Sync) k = Keys[key];
            return FinishDay(k, hist);
        }

        private static TickCheckResult FinishDay(KeyFiles k, TickDayBuild hist)
        {
            List<TickRec> live = ReadAllLive(k.Key);
            TickCheckResult chk = TickCheck.Compare(live, hist.Ticks, KnownGaps(k), OpenMsOf(k.Session));
            long liveLost = 0, liveGaps = 0;
            lock (Sync)
            {
                foreach (Cut c in k.Cuts) if (!c.Carried) { liveLost += c.Lost; liveGaps += c.Gaps; }   // a carried flag is not a second drop
                long[] d = DropsOf(k.Session); liveLost += Math.Max(0, d[0] - k.LostSeen); liveGaps += Math.Max(0, d[1] - k.GapsSeen);   // not on a chunk yet
            }
            List<string> parts = DayParts(k, hist, chk, liveLost, liveGaps);
            string file = Path.Combine(Folder, BaseOf(k.Key) + ".day.jsonl");
            string tmp = file + ".tmp";
            File.WriteAllLines(tmp, parts.ToArray());
            if (File.Exists(file)) File.Delete(file);
            File.Move(tmp, file);
            // A new set of the day (the PR #79 review, LOW 2): its progress and the day's earlier sets set aside (.refused, .unstored:
            // the same day's earlier set, now replaced) go, and the resend timer of the file starts again.
            foreach (string old in new[] { ".day.sent", ".day.jsonl.refused", ".day.jsonl.unstored" })
                try { File.Delete(Path.Combine(Folder, BaseOf(k.Key) + old)); } catch (Exception) { }
            bool again;
            lock (Sync)
            {
                DayAgainAt.Remove(file); DayAgainTries.Remove(file); AsideFailed.Remove(file);
                Days[k.Key] = new DayRec { Key = k.Key, Check = chk.Status, Stored = false, Packed = false, Rule = TickCheck.Rule }; again = Recheck.Remove(k.Key);
            }
            SaveDays();
            if (again) SaveRule();
            RecountDisk();
            lastDay = k.Key + ": " + chk.Status + ", live " + chk.LiveTicks + " trades, history " + chk.HistTicks + " (live missed " + chk.TicksLiveMissed + " in " + chk.SecondsLiveMissed +
                      " seconds, history short " + chk.TicksHistShort + " in " + chk.SecondsHistShort + " seconds), history share " + ShareText(chk) + ", " + chk.Holes.Count + " hole(s), " + parts.Count + " parts" +
                      (again ? ", checked again under the 0.6.14 rule" : "");
            ChartBridgeServer.Log("the NQ tick file for " + lastDay + (chk.Passed ? "; queued for The Desk" : "; the check FAILED (no history, or history under " + TickCheck.ThinSharePercent + " percent of the live trades): sent marked failed, the raw file is kept until Anthony rules"));
            dayState = "idle";
            return chk;
        }

        // The session's open (18:00 New York the evening before) in UTC ms, or long.MinValue when the session cannot be read.
        private static long OpenMsOf(string session)
        {
            DateTime s;
            if (!DateTime.TryParseExact(session, "yyyy-MM-dd", Inv, DateTimeStyles.None, out s)) return long.MinValue;
            DateTime ou, cu; ChartBridgeBars.SessionUtc(s, out ou, out cu);
            return (long)Math.Round(ChartBridgeTime.UtcMs(ou));
        }

        private static string ShareText(TickCheckResult chk)
        {
            return double.IsNaN(chk.HistoryShare) ? "not known (no live trade in the span)" : (Math.Round(chk.HistoryShare * 100, 1)).ToString("0.0", Inv) + " percent";
        }

        // The live capture gaps ChartBridge knows of (0.6.14), for the check's covered span: for each chunk that took drops (its
        // lost or gaps above 0, its carried chunks too: a dropped trade or a feed drop may sit anywhere in them) the span from the
        // last live trade of the chunk before it (long.MinValue when none) to the first live trade of the chunk after it
        // (long.MaxValue when none); and when drops wait for a cut not made yet, from the last cut trade to long.MaxValue.
        private static List<long[]> KnownGaps(KeyFiles k)
        {
            List<Cut> cuts; long pending;
            lock (Sync)
            {
                cuts = k.Cuts.OrderBy(c => c.Seq).ToList();
                long[] d = DropsOf(k.Session); pending = Math.Max(0, d[0] - k.LostSeen) + Math.Max(0, d[1] - k.GapsSeen);
            }
            List<long[]> gaps = new List<long[]>();
            for (int i = 0; i < cuts.Count; i++)
            {
                if (cuts[i].Lost <= 0 && cuts[i].Gaps <= 0) continue;
                long a = i > 0 ? EdgeU(k, cuts[i - 1], false) : long.MinValue, b = i + 1 < cuts.Count ? EdgeU(k, cuts[i + 1], true) : long.MaxValue;
                gaps.Add(new long[] { a, b });
            }
            if (pending > 0) gaps.Add(new long[] { cuts.Count > 0 ? EdgeU(k, cuts[cuts.Count - 1], false) : long.MinValue, long.MaxValue });
            return gaps;
        }
        // The first (lowest) or last (highest) trade time of a cut; an open end when it has none.
        private static long EdgeU(KeyFiles k, Cut c, bool first)
        {
            List<TickRec> t = ReadRange(k, c.From, c.To);
            if (t.Count == 0) return first ? long.MaxValue : long.MinValue;
            return first ? t.Min(x => x.U) : t.Max(x => x.U);
        }

        public static List<string> DayParts(string key, TickDayBuild hist, TickCheckResult chk, string set)
        {
            KeyFiles k; lock (Sync) k = Keys[key];
            return DayParts(k, hist, chk, 0, 0, set);
        }

        private static List<string> DayParts(KeyFiles k, TickDayBuild hist, TickCheckResult chk, long liveLost, long liveGaps, string set = null)
        {
            set = set ?? NewId();
            List<TickRec> t = hist.Ticks;
            long vol = 0; foreach (TickRec r in t) vol += r.V;
            string method = hist.BidAsk > 0 && hist.TickRule == 0 ? "bidAsk" : hist.BidAsk == 0 && hist.TickRule > 0 ? "tickRule" : hist.BidAsk > 0 ? "mixed" : "none";
            StringBuilder c = new StringBuilder();
            c.Append("{\"status\":").Append(CbJson.Str(chk.Status))
             .Append(",\"liveTicks\":").Append(chk.LiveTicks).Append(",\"liveVolume\":").Append(chk.LiveVolume)
             .Append(",\"histTicks\":").Append(chk.HistTicks).Append(",\"histVolume\":").Append(chk.HistVolume)
             .Append(",\"secondsLiveMissed\":").Append(chk.SecondsLiveMissed).Append(",\"ticksLiveMissed\":").Append(chk.TicksLiveMissed)
             .Append(",\"secondsHistShort\":").Append(chk.SecondsHistShort).Append(",\"ticksHistShort\":").Append(chk.TicksHistShort)
             .Append(",\"liveLost\":").Append(liveLost).Append(",\"liveGaps\":").Append(liveGaps)
             .Append(",\"rule\":").Append(TickCheck.Rule)
             .Append(",\"coveredSeconds\":").Append(chk.CoveredSeconds).Append(",\"spanWhole\":").Append(chk.SpanWhole ? "true" : "false")
             .Append(",\"coveredLive\":").Append(chk.CoveredLive).Append(",\"coveredHist\":").Append(chk.CoveredHist)
             .Append(",\"historyShare\":").Append(double.IsNaN(chk.HistoryShare) ? "null" : CbJson.Num(Math.Round(chk.HistoryShare, 4)))
             .Append(",\"holes\":[");
            for (int i = 0; i < chk.Holes.Count; i++)
            {
                if (i > 0) c.Append(',');
                c.Append("{\"from\":").Append(chk.Holes[i][0]).Append(",\"to\":").Append(chk.Holes[i][1]).Append(",\"live\":").Append(chk.Holes[i][2])
                 .Append(",\"inGap\":").Append(chk.Holes[i][3] != 0 ? "true" : "false").Append('}');
            }
            c.Append("],\"detail\":[");
            for (int i = 0; i < chk.Detail.Count; i++)
            {
                if (i > 0) c.Append(',');
                c.Append("{\"t\":").Append(chk.Detail[i][0]).Append(",\"live\":").Append(chk.Detail[i][1]).Append(",\"hist\":").Append(chk.Detail[i][2]).Append('}');
            }
            c.Append("]}");
            int per = Math.Max(1, PartMaxTicks), count = Math.Max(1, (t.Count + per - 1) / per);
            List<string> parts = new List<string>();
            for (int p = 0; p < count; p++)
            {
                StringBuilder b = new StringBuilder(1024 + per * 32);
                b.Append("{\"v\":1,\"source\":\"chartbridge\",\"bridge\":").Append(CbJson.Str(ChartBridgeServer.Version))
                 .Append(",\"pc\":").Append(CbJson.Str(ChartBridgeBars.PcName()))
                 .Append(",\"root\":\"NQ\",\"contract\":").Append(CbJson.Str(k.Contract))
                 .Append(",\"tick\":").Append(CbJson.Num(k.Tick))
                 .Append(",\"session\":").Append(CbJson.Str(k.Session))
                 .Append(",\"set\":").Append(CbJson.Str(set))
                 .Append(",\"part\":").Append((p + 1).ToString(Inv)).Append(",\"parts\":").Append(count.ToString(Inv))
                 .Append(",\"setTicks\":").Append(t.Count.ToString(Inv)).Append(",\"setVolume\":").Append(vol.ToString(Inv))
                 .Append(",\"first\":").Append(t.Count > 0 ? t[0].U.ToString(Inv) : "null")
                 .Append(",\"last\":").Append(t.Count > 0 ? t[t.Count - 1].U.ToString(Inv) : "null")
                 .Append(",\"check\":").Append(c.ToString())
                 .Append(",\"sides\":{\"method\":").Append(CbJson.Str(method)).Append(",\"bidAsk\":").Append(hist.BidAsk.ToString(Inv))
                 .Append(",\"tickRule\":").Append(hist.TickRule.ToString(Inv)).Append(",\"none\":").Append(hist.None.ToString(Inv)).Append('}')
                 .Append(",\"cols\":[\"u\",\"p\",\"v\",\"s\"],\"ticks\":[");
                AppendTicks(b, t, p * per, Math.Min(t.Count, (p + 1) * per));
                b.Append("],\"complete\":true}");
                parts.Add(b.ToString());
            }
            return parts;
        }

        private static readonly Regex StoredRx = new Regex("\"stored\"\\s*:\\s*true"), PackedRx = new Regex("\"packed\"\\s*:\\s*true");

        // Sends the days waiting (their parts in order, from the first not taken), only in the 1 second bars' window. When The Desk
        // answers the last part: stored noted; the raw deleted only when the check passed and the answer says stored and packed.
        public static int SendDays(Func<bool> stopping)
        {
            DateTime nowUtc = ChartBridgeBars.UtcNow();
            if (!ChartBridgeBars.In1sWindow(TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(nowUtc, DateTimeKind.Utc), ChartBridgeTime.Eastern))) return 0;
            if (deskHasNone && nowUtc < retryAt) return 0;
            int gen = Volatile.Read(ref stopGen), sent = 0;
            if (!Directory.Exists(Folder)) return 0;
            foreach (string file in Directory.GetFiles(Folder, "*.day.jsonl").OrderBy(x => x, StringComparer.Ordinal))
            {
                DateTime notBefore;
                lock (Sync) if (DayAgainAt.TryGetValue(file, out notBefore) && nowUtc < notBefore) continue;   // not stored last time: later
                lock (Sync) if (AsideFailed.Contains(file)) continue;   // could not be set aside: never sent again this run (no loop)
                string progress = file.Substring(0, file.Length - ".jsonl".Length) + ".sent";
                List<string> lines = File.ReadAllLines(file).Where(x => x.Trim().Length > 0).ToList();
                int next = File.Exists(progress) ? File.ReadAllLines(progress).Count(x => x.Trim().Length > 0) : 0;
                string key = DayKeyOf(file);
                while (next < lines.Count)
                {
                    if (stopping != null && stopping()) return sent;
                    int code; string answer;
                    Sent2 r = Post("/api/ticks/day", lines[next], gen, out code, out answer);
                    if (r == Sent2.Stopped) return sent;
                    if (r == Sent2.Taken)
                    {
                        deskHasNone = false; error = "";
                        next++; sent++;
                        File.AppendAllText(progress, next.ToString(Inv) + Environment.NewLine);
                        if (next >= lines.Count) DayTaken(key, file, progress, StoredRx.IsMatch(answer), PackedRx.IsMatch(answer));
                        continue;
                    }
                    if (r == Sent2.Refused)
                    {
                        ChartBridgeServer.Log("The Desk refused part " + (next + 1) + " of the NQ tick file for " + key + " (" + code + (answer.Length > 0 ? ": " + answer : "") + "); the day is set aside (" + Path.GetFileName(file) + ".refused), the raw file is kept");
                        SetAside(key, file, ".refused", progress);
                        break;
                    }
                    if (r == Sent2.NoDesk) { deskHasNone = true; retryAt = nowUtc.AddMilliseconds(NoDeskRetryMs); error = "The Desk has no tick file route (404)"; }
                    else error = "day part not taken: " + answer;
                    return sent;
                }
            }
            return sent;
        }

        // A day file set aside (the PR #79 review, LOW 2): an older file under the target name is deleted first (an earlier set of
        // the same day), then the file is moved. When that cannot be done the file stays, is not sent again while ChartBridge runs
        // (AsideFailed: never a send every 10 s), and the Output window and lastError say so.
        private static readonly HashSet<string> AsideFailed = new HashSet<string>();
        private static void SetAside(string key, string file, string suffix, string progress)
        {
            string to = file + suffix;
            try { if (File.Exists(to)) File.Delete(to); File.Move(file, to); }
            catch (Exception ex)
            {
                lock (Sync) AsideFailed.Add(file);
                error = key + ": the day file could not be set aside as " + Path.GetFileName(to) + " (" + ex.Message + "); not sent again until ChartBridge restarts";
                ChartBridgeServer.Log("the NQ tick file for " + error);
            }
            if (progress != null) try { File.Delete(progress); } catch (Exception) { }
        }

        private static string DayKeyOf(string file)
        {
            string b = Path.GetFileName(file);
            b = b.Substring(0, b.Length - ".day.jsonl".Length);
            lock (Sync) foreach (KeyFiles k in Keys.Values) if (BaseOf(k.Key) == b) return k.Key;
            return b;
        }

        // A day whose last part was answered without "stored":true is kept and sent again from its first part (The Desk ignores the
        // parts it has) after RetryMinutes, MaxTries times; then it is set aside (.day.jsonl.unstored, kept) and /diag says so. The day
        // file is deleted only after "stored":true.
        private static readonly Dictionary<string, DateTime> DayAgainAt = new Dictionary<string, DateTime>();
        private static readonly Dictionary<string, int> DayAgainTries = new Dictionary<string, int>();

        private static void DayTaken(string key, string file, string progress, bool stored, bool packed)
        {
            DayRec d;
            lock (Sync) { if (!Days.TryGetValue(key, out d)) { d = new DayRec { Key = key, Check = "failed", Rule = TickCheck.Rule }; Days[key] = d; } d.Stored = stored; d.Packed = packed; }
            SaveDays();
            if (!stored)
            {
                int tries;
                lock (Sync) { DayAgainTries.TryGetValue(file, out tries); DayAgainTries[file] = ++tries; DayAgainAt[file] = ChartBridgeBars.UtcNow().AddMinutes(RetryMinutes); }
                try { File.Delete(progress); } catch (Exception) { }
                if (tries >= MaxTries)
                {
                    SetAside(key, file, ".unstored", null);
                    lock (Sync) { DayAgainAt.Remove(file); DayAgainTries.Remove(file); }
                    error = key + ": The Desk took every part but did not store the day, " + tries + " times; set aside (" + Path.GetFileName(file) + ".unstored), the raw file is kept";
                    ChartBridgeServer.Log("the NQ tick file for " + error);
                }
                else ChartBridgeServer.Log("The Desk took the NQ tick file for " + key + " but did not store it; the day file is kept and sent again in " + RetryMinutes + " minutes (try " + tries + " of " + MaxTries + "), the raw file is kept");
                return;
            }
            lock (Sync) { DayAgainAt.Remove(file); DayAgainTries.Remove(file); }
            bool passed = TickCheck.IsPassed(d.Check);
            // Stored, passed, not packed yet: the day's last part is kept (<base>.day.last, one part, at most PartMaxTicks trades, counted
            // in the folder's size against tickFileMaxMB) so it can be sent again later to learn "packed" (AskPacked). The rest of the
            // day file goes as before.
            if (passed && !packed)
            {
                try
                {
                    string lastPart = File.ReadAllLines(file).LastOrDefault(x => x.Trim().Length > 0);
                    if (lastPart != null)
                    {
                        string lp = LastPartFile(key); File.WriteAllText(lp + ".tmp", lastPart); if (File.Exists(lp)) File.Delete(lp); File.Move(lp + ".tmp", lp);
                        lock (Sync) AskedDay[key] = EtToday();
                        File.WriteAllText(AskedFile(key), EtToday());   // The Desk just answered: the first ask is the next New York day
                    }
                }
                catch (Exception ex) { error = key + ": the day's last part could not be kept: " + ex.Message; ChartBridgeServer.Log("the NQ tick file for " + error); }
            }
            try { File.Delete(file); File.Delete(progress); } catch (Exception) { }
            RecountDisk();
            if (stored && packed && passed) DeleteRaw(key);
            else ChartBridgeServer.Log("The Desk " + (stored ? "stored" : "took") + " the NQ tick file for " + key + "; the raw file is kept (" + (!passed ? "the check failed: until Anthony rules" : !packed ? "not packed yet" : "not stored") + ")");
        }

        // ---------------------------------------------------------- the raw deleted once packed (2026-11-03)
        // A day stored and passed but not packed keeps its raw and its last part (<base>.day.last). At most once a New York day, in the
        // final pull's windows (InPackAskWindow: the 1 second bars' window or a weekday morning before 09:15), the last part is sent to
        // /api/ticks/day again: The Desk ignores the part (it has the set) and answers the day's stored and packed state now. Stored and
        // packed: the raw, its state and the last part are deleted and the day noted packed in tickdays.txt. A failed day is never
        // asked (it never packs; its raw stays until Anthony rules). 404 keeps everything and asks again when the route is tried again
        // (NoDeskRetryMs); a time-out or another failure keeps everything and asks nothing more for RetryMinutes; a refusal keeps
        // everything and asks again the next day.
        private static DateTime packAgainAt = DateTime.MinValue;   // after a failure (a time-out, The Desk down): no ask before then
        // Review LOW 4: the New York date each day was last asked, in memory as well as in <base>.day.asked, so a failed write of
        // that file never makes a send every loop (at most once a day while ChartBridge runs; the file carries it over a restart).
        private static readonly Dictionary<string, string> AskedDay = new Dictionary<string, string>();
        private static void NoteAsked(string key, string day)
        {
            lock (Sync) AskedDay[key] = day;
            try { File.WriteAllText(AskedFile(key), day); } catch (Exception) { }
        }
        public static string LastPartFile(string key) { return Path.Combine(Folder, BaseOf(key) + ".day.last"); }
        private static string AskedFile(string key) { return Path.Combine(Folder, BaseOf(key) + ".day.asked"); }
        private static string EtToday() { return TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(ChartBridgeBars.UtcNow(), DateTimeKind.Utc), ChartBridgeTime.Eastern).ToString("yyyy-MM-dd", Inv); }
        public static bool InPackAskWindow(DateTime et) { return ChartBridgeBars.In1sWindow(et) || InMorningWindow(et); }

        // Review LOW 3: the files go first and the key last, all under Sync, so the bars worker's ScanFolder (PlanDay) can never
        // register the key again from a state file still there (a ghost in /diag, a "bars error", a chunk that cannot be read). The
        // raw goes first and the state last: a crash part way leaves a state with no raw, of a day tickdays.txt already notes packed
        // (it is saved before this), which ScanFolder never registers and finishes deleting (DeleteFiles).
        public static Action DeleteStepForHarness;   // the harness only: runs between the files and the key (a ScanFolder there)
        private static void DeleteRaw(string key)
        {
            string why = DeleteFiles(key, true);
            RecountDisk();
            if (why != null) ChartBridgeServer.Log("could not delete the raw ticks of " + key + ": " + why);
            else ChartBridgeServer.Log("The Desk stored and packed the NQ tick file for " + key + "; the raw file is deleted");
        }
        // Deletes the raw, the last part, the asked file and the state (last), then forgets the key. Returns null, or why not.
        private static string DeleteFiles(string key, bool hook)
        {
            lock (Sync)
            {
                AskedDay.Remove(key);
                KeyFiles k; Keys.TryGetValue(key, out k);
                string b = Path.Combine(Folder, BaseOf(key));
                string raw = k != null ? k.Raw : b + ".raw", state = k != null ? k.State : b + ".state";
                try { foreach (string f in new[] { raw, LastPartFile(key), AskedFile(key), state }) if (File.Exists(f)) File.Delete(f); }
                catch (Exception ex) { return ex.Message; }
                finally
                {
                    Action h = DeleteStepForHarness;
                    if (hook && h != null) h();
                    Keys.Remove(key);
                }
                return null;
            }
        }

        // On the sender thread. Returns how many days were asked.
        public static int AskPacked(Func<bool> stopping)
        {
            DateTime nowUtc = ChartBridgeBars.UtcNow();
            DateTime nowEt = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(nowUtc, DateTimeKind.Utc), ChartBridgeTime.Eastern);
            if (!InPackAskWindow(nowEt)) return 0;
            if (deskHasNone && nowUtc < retryAt) return 0;
            lock (Sync) if (nowUtc < packAgainAt) return 0;
            string today = nowEt.ToString("yyyy-MM-dd", Inv);
            List<DayRec> waiting;
            lock (Sync) waiting = Days.Values.Where(d => d.Stored && !d.Packed && TickCheck.IsPassed(d.Check)).OrderBy(d => d.Key, StringComparer.Ordinal).ToList();
            int gen = Volatile.Read(ref stopGen), asked = 0;
            foreach (DayRec d in waiting)
            {
                if (stopping != null && stopping()) return asked;
                string lp = LastPartFile(d.Key), af = AskedFile(d.Key);
                if (!File.Exists(lp)) continue;   // a day stored before this release: no part to send again (its raw stays; rawOld lists it)
                string last = "", mem;
                try { if (File.Exists(af)) last = File.ReadAllText(af).Trim(); } catch (Exception) { last = ""; }
                lock (Sync) if (!AskedDay.TryGetValue(d.Key, out mem)) mem = "";
                if (last == today || mem == today) continue;   // at most once a New York day
                string line = File.ReadAllText(lp).Trim();
                int code; string answer;
                Sent2 r = Post("/api/ticks/day", line, gen, out code, out answer);
                if (r == Sent2.Stopped) return asked;
                if (r == Sent2.NoDesk) { deskHasNone = true; retryAt = nowUtc.AddMilliseconds(NoDeskRetryMs); error = "The Desk has no tick file route (404)"; return asked; }
                if (r == Sent2.Failed) { lock (Sync) packAgainAt = nowUtc.AddMinutes(RetryMinutes); error = d.Key + ": asking whether the day is packed: " + answer; return asked; }
                asked++;
                if (r == Sent2.Refused)
                {
                    NoteAsked(d.Key, today);
                    ChartBridgeServer.Log("The Desk refused the NQ tick file's last part for " + d.Key + " sent again (" + code + (answer.Length > 0 ? ": " + answer : "") + "); the raw file is kept, asked again tomorrow");
                    continue;
                }
                deskHasNone = false;
                bool stored = StoredRx.IsMatch(answer), packed = PackedRx.IsMatch(answer);
                if (stored && packed)
                {
                    lock (Sync) d.Packed = true;
                    SaveDays();
                    DeleteRaw(d.Key);
                    continue;
                }
                NoteAsked(d.Key, today);
                RecountDisk();
                if (!stored) ChartBridgeServer.Log("The Desk answered the NQ tick file's last part for " + d.Key + " without stored; the raw file is kept, asked again tomorrow");
            }
            return asked;
        }

        // ---------------------------------------------------------- the folder (the sender thread and the bars worker)
        // Review LOW 3: a state file is not registered when its day is noted packed in tickdays.txt (a delete cut short: its files
        // are deleted now) or when its raw file is gone; a state file deleted while it is read is passed over. Only a passed day
        // (exact, filled or short) noted packed is deleted: a failed day keeps its raw until Anthony rules, even if tickdays.txt says packed.
        // A delete that fails is said once a run for each key (ScanDeleteSaid), not every look at the folder.
        private static readonly HashSet<string> ScanDeleteSaid = new HashSet<string>();
        private static void ScanFolder()
        {
            if (!Directory.Exists(Folder)) return;
            foreach (string st in Directory.GetFiles(Folder, "*.state"))
            {
                string name = Path.GetFileNameWithoutExtension(st);
                bool known; lock (Sync) known = Keys.Values.Any(k => BaseOf(k.Key) == name);
                if (known) continue;
                string session = null, contract = null;
                try
                {
                    foreach (string raw in File.ReadAllLines(st))
                    {
                        if (raw.StartsWith("session ", StringComparison.Ordinal)) session = raw.Substring(8).Trim();
                        else if (raw.StartsWith("contract ", StringComparison.Ordinal)) contract = raw.Substring(9).Trim();
                    }
                }
                catch (Exception) { continue; }   // deleted (or locked) as it was read: looked at again next time
                if (session == null || contract == null) continue;
                string key = KeyOf(session, contract);
                bool packed; lock (Sync) { DayRec d; packed = Days.TryGetValue(key, out d) && d.Packed && TickCheck.IsPassed(d.Check); }
                if (packed)
                {
                    string why = DeleteFiles(key, false);
                    RecountDisk();
                    if (why == null) ChartBridgeServer.Log("the NQ tick file for " + key + " is packed: its files left from a delete cut short are deleted");
                    else
                    {
                        bool first; lock (Sync) first = ScanDeleteSaid.Add(key);
                        if (first) ChartBridgeServer.Log("could not delete the files left of the packed NQ tick file for " + key + ": " + why + " (tried again at each look at the folder, said once)");
                    }
                    continue;
                }
                if (!File.Exists(Path.Combine(Folder, name + ".raw"))) continue;
                FilesOf(session, contract, 0, false);
            }
        }

        // diskBytes counts every file of the folder (the raw files, the states and the .day.jsonl files waiting): counted again at
        // every cut, after a day file is written and after files are deleted; the writer adds what it appends in between.
        private static void RecountDisk() { Interlocked.Exchange(ref diskBytes, FolderBytes()); }

        private static long FolderBytes()
        {
            long n = 0;
            try { if (Directory.Exists(Folder)) foreach (string f in Directory.GetFiles(Folder)) n += new FileInfo(f).Length; } catch (Exception) { }
            return n;
        }

        // ---------------------------------------------------------- the threads
        private static readonly object Gate = new object();
        private static ManualResetEvent stopEvent;
        private static Thread writer, sender;
        private static int generation;

        public static void Start()
        {
            Stop();
            lock (Gate)
            lock (CutSync)   // waits for a cut of the old sender still in progress (CutOnce)
            {
                Interlocked.Exchange(ref droppedQueue, 0); Interlocked.Exchange(ref droppedDisk, 0); Interlocked.Exchange(ref outside, 0);
                Interlocked.Exchange(ref written, 0); Interlocked.Exchange(ref feedDrops, 0); Interlocked.Exchange(ref lostTotal, 0);
                lostTaken = 0; Interlocked.Exchange(ref firstLostU, 0); Interlocked.Exchange(ref lastLostU, 0);
                long ignored; while (DropTimes.TryDequeue(out ignored)) { }
                runStartUtc = ChartBridgeBars.UtcNow();
                error = ""; lastDay = ""; deskHasNone = false; retryAt = DateTime.MinValue;
                lock (Sync) { Keys.Clear(); Recheck.Clear(); AsideFailed.Clear(); LastSent.Clear(); RetryAtDay.Clear(); TriesDay.Clear(); SessionDrops.Clear(); DayAgainAt.Clear(); DayAgainTries.Clear(); AskedDay.Clear(); RawGoneSaid.Clear(); ScanDeleteSaid.Clear(); packAgainAt = DateTime.MinValue; }
                if (!On) { dayState = "off"; return; }
                dayState = "starting";
                ManualResetEvent stop = new ManualResetEvent(false);
                stopEvent = stop;
                int gen = ++generation;
                capturing = true;
                writer = new Thread(() => WriterLoop(gen, stop)) { IsBackground = true, Priority = ThreadPriority.BelowNormal, Name = "ChartBridge tick file" };
                sender = new Thread(() => SenderLoop(gen, stop)) { IsBackground = true, Priority = ThreadPriority.BelowNormal, Name = "ChartBridge tick chunks" };
                writer.Start(); sender.Start();
            }
        }

        public static void Stop()
        {
            Thread w, s;
            lock (Gate)
            {
                capturing = false;
                generation++;
                try { if (stopEvent != null) stopEvent.Set(); } catch (Exception) { }
                stopEvent = null;
                w = writer; s = sender; writer = null; sender = null;
            }
            lock (AbortSync) { stopGen++; try { if (inFlight != null) inFlight.Abort(); } catch (Exception) { } }
            foreach (Thread t in new Thread[] { w, s })
                try { if (t != null && t != Thread.CurrentThread) t.Join(250); } catch (Exception) { }
        }

        private static bool Stopping(int gen, ManualResetEvent stop) { return gen != Volatile.Read(ref generation) || stop.WaitOne(0); }

        private static void WriterLoop(int gen, ManualResetEvent stop)
        {
            try { Directory.CreateDirectory(Folder); Interlocked.Exchange(ref diskBytes, FolderBytes()); } catch (Exception ex) { error = "the ticks folder: " + ex.Message; }
            while (true)
            {
                bool last = stop.WaitOne(WriteEveryMs) || gen != Volatile.Read(ref generation);
                try { WriteOnce(); } catch (Exception ex) { error = "tick file write error: " + ex.Message; CbLogLimit.Error("tick file write error", ex); }
                if (last) return;   // the stop: what was queued is written once more, then nothing
            }
        }

        private static void SenderLoop(int gen, ManualResetEvent stop)
        {
            Func<bool> stopping = () => Stopping(gen, stop);
            try { LoadDays(); ScanFolder(); } catch (Exception ex) { error = "the ticks folder could not be read: " + ex.Message; }
            System.Diagnostics.Stopwatch since = System.Diagnostics.Stopwatch.StartNew();
            long lastCut = 0;
            while (!stop.WaitOne(SendEveryMs))
            {
                if (stopping()) return;
                try
                {
                    if (since.ElapsedMilliseconds - lastCut >= ChunkEveryMs) { lastCut = since.ElapsedMilliseconds; ScanFolder(); CutOnce(gen); }
                    SendChunks(stopping);
                    SendDays(stopping);
                    AskPacked(stopping);
                }
                catch (Exception ex) { error = "tick file send error: " + ex.Message; CbLogLimit.Error("tick file send error", ex); }
            }
        }

        // ---------------------------------------------------------- /diag "tickFile"
        public static string DiagJson()
        {
            StringBuilder b = new StringBuilder();
            DateTime now = ChartBridgeBars.UtcNow().Date;
            b.Append("{\"on\":").Append(On ? "true" : "false")
             .Append(",\"capturing\":").Append(capturing ? "true" : "false")
             .Append(",\"queue\":").Append(Volatile.Read(ref queued)).Append(",\"queueMax\":").Append(QueueMax)
             .Append(",\"droppedQueue\":").Append(Interlocked.Read(ref droppedQueue)).Append(",\"droppedDisk\":").Append(Interlocked.Read(ref droppedDisk))
             .Append(",\"outside\":").Append(Interlocked.Read(ref outside)).Append(",\"written\":").Append(Interlocked.Read(ref written))
             .Append(",\"feedDrops\":").Append(Interlocked.Read(ref feedDrops))
             .Append(",\"diskMB\":").Append(CbJson.Num(Math.Round(Interlocked.Read(ref diskBytes) / 1048576.0, 1))).Append(",\"maxMB\":").Append(MaxBytes / 1048576)
             .Append(",\"files\":{");
            List<KeyFiles> keys; lock (Sync) keys = Keys.Values.OrderBy(k => k.Key, StringComparer.Ordinal).ToList();
            List<string> old = new List<string>();
            bool first = true;
            foreach (KeyFiles k in keys)
            {
                long size = 0; try { if (File.Exists(k.Raw)) size = new FileInfo(k.Raw).Length; } catch (Exception) { }
                DateTime s; int age = DateTime.TryParseExact(k.Session, "yyyy-MM-dd", Inv, DateTimeStyles.None, out s) ? (int)(now - s.Date).TotalDays : 0;
                if (age > RawOldDays && File.Exists(k.Raw)) old.Add(k.Key);
                int cuts, sent, aside; lock (Sync) { cuts = k.Cuts.Count; sent = k.Sent.Count; aside = k.Aside.Count; }
                if (!first) b.Append(','); first = false;
                b.Append(CbJson.Str(k.Key)).Append(":{\"bytes\":").Append(size).Append(",\"chunks\":").Append(cuts).Append(",\"sent\":").Append(sent)
                 .Append(",\"aside\":").Append(aside).Append(",\"ageDays\":").Append(age).Append('}');
            }
            b.Append("},\"lastSent\":{");
            lock (Sync) b.Append(string.Join(",", LastSent.OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => CbJson.Str(kv.Key) + ":" + CbJson.Str(kv.Value)).ToArray()));
            b.Append("},\"days\":{");
            lock (Sync) b.Append(string.Join(",", Days.Values.OrderBy(d => d.Key, StringComparer.Ordinal).Select(d => CbJson.Str(d.Key) + ":{\"check\":" + CbJson.Str(d.Check) + ",\"stored\":" + (d.Stored ? "true" : "false") + ",\"packed\":" + (d.Packed ? "true" : "false") + ",\"rule\":" + d.Rule.ToString(Inv) + "}").ToArray()));
            b.Append("},\"recheck\":[");
            lock (Sync) b.Append(string.Join(",", Recheck.OrderBy(x => x, StringComparer.Ordinal).Select(x => CbJson.Str(x)).ToArray()));
            b.Append("],\"packWait\":{");
            List<DayRec> pw; lock (Sync) pw = Days.Values.Where(d => d.Stored && !d.Packed && TickCheck.IsPassed(d.Check)).OrderBy(d => d.Key, StringComparer.Ordinal).ToList();
            b.Append(string.Join(",", pw.Select(d =>
            {
                string asked = ""; try { if (File.Exists(AskedFile(d.Key))) asked = File.ReadAllText(AskedFile(d.Key)).Trim(); } catch (Exception) { }
                return CbJson.Str(d.Key) + ":{\"lastPart\":" + (File.Exists(LastPartFile(d.Key)) ? "true" : "false") + ",\"asked\":" + (asked.Length > 0 ? CbJson.Str(asked) : "null") + "}";
            }).ToArray()));
            b.Append("},\"rawOld\":[").Append(string.Join(",", old.Select(x => CbJson.Str(x)).ToArray())).Append(']')
             .Append(",\"rawOldNote\":").Append(old.Count > 0 ? CbJson.Str(old.Count + " raw file(s) older than " + RawOldDays + " days: a raw file is deleted only after its day is packed and stored at The Desk") : "null")
             .Append(",\"dayState\":").Append(CbJson.Str(dayState ?? ""))
             .Append(",\"lastDay\":").Append(CbJson.Str(lastDay ?? ""))
             .Append(",\"deskHasNoTicks\":").Append(deskHasNone ? "true" : "false")
             .Append(",\"lastError\":").Append(CbJson.Str(error ?? "")).Append('}');
            return b.ToString();
        }
    }
}
