// ChartBridge 0.4.0: diagnostics and quote-only markets. Part of the ChartBridge add-on; install it with the other files.
// Nothing here places, changes or cancels an order. What it holds:
//   CbLogLimit          an error line in the Output window at most once a minute per kind, with a count of the rest
//   CbBuckets, CbHist   fixed log-scale buckets (each about 41 percent wider than the last): medians and p95 with no
//                       sorting and no allocation per value
//   ChartBridgeHealth   /diag "health": send times, thread headroom, page connects and closes
//   ChartBridgeMarkets  the quote-only markets (config.txt quoteRoots): each one's tick size, price format, settlement time
//                       and front-month roll, from NinjaTrader's own instrument data where it has it, else the table here
//   ChartBridgeTape     /diag "tape": per root and per 15 minutes of the session, how the trades arrive (diagnostic only)
// Written in C# 5 syntax on purpose so it compiles on every NinjaTrader 8 release.

#region Using declarations
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using NinjaTrader.Cbi;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    // ------------------------------------------------------------------ an error line at most once a minute per kind
    // A fault that repeats on every trade (a tick error) used to write one Output line per trade. Now the first one is
    // written, then at most one a minute per kind, saying how many came since the last line. Every one is counted (/diag).
    // Never throws; makes no string for a fault it does not write.
    public static class CbLogLimit
    {
        public const double EveryMs = 60000;
        private class Kind { public double LastMs = double.NegativeInfinity; public long Since, Total; }
        private static readonly Dictionary<string, Kind> Kinds = new Dictionary<string, Kind>();

        public static void Error(string kind, Exception ex) { Note(kind, ex, null); }
        public static void Note(string kind, string text) { Note(kind, null, text); }

        private static void Note(string kind, Exception ex, string text)
        {
            try
            {
                long more = 0; bool write = false;
                double now = ChartBridgeTime.NowUtcMs();
                lock (Kinds)
                {
                    Kind k;
                    if (!Kinds.TryGetValue(kind, out k)) { k = new Kind(); Kinds[kind] = k; }
                    k.Total++;
                    if (now - k.LastMs >= EveryMs) { write = true; more = k.Since; k.Since = 0; k.LastMs = now; }
                    else k.Since++;
                }
                if (!write) return;
                string what = text ?? (kind + ": " + (ex != null ? ex.Message : ""));
                ChartBridgeServer.Log(what + (more > 0 ? " (" + more + " more since the last line)" : "") + " (said at most once a minute; all counted in /diag)");
            }
            catch (Exception) { }
        }

        public static string DiagJson()
        {
            lock (Kinds)
                return "{" + string.Join(",", Kinds.OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => CbJson.Str(kv.Key) + ":" + kv.Value.Total).ToArray()) + "}";
        }
        public static long Count(string kind) { lock (Kinds) { Kind k; return Kinds.TryGetValue(kind, out k) ? k.Total : 0; } }
    }

    // ------------------------------------------------------------------ fixed log-scale buckets
    // Bucket 0 holds values below `unit` (and 0, negatives, NaN); bucket k (k >= 1) holds [unit * 2^((k-1)/2), unit * 2^(k/2)).
    // A quantile is read as the upper edge of the bucket it falls in, so a median or p95 is "at most this", within a factor
    // of 1.41. Finding a bucket is one logarithm: no sorting and no allocation per value.
    public static class CbBuckets
    {
        private static readonly double InvLn2 = 1.0 / Math.Log(2);
        public static int Of(double v, double unit, int count)
        {
            if (!(v >= unit)) return 0;
            double k = 1 + Math.Floor(2 * Math.Log(v / unit) * InvLn2);
            return k < count - 1 ? (int)k : count - 1;
        }
        public static double Upper(int k, double unit) { return k <= 0 ? unit : unit * Math.Pow(2, k / 2.0); }
        public static double Quantile(long[] a, int off, int len, double q, double unit)
        {
            long total = 0;
            for (int i = 0; i < len; i++) total += a[off + i];
            if (total <= 0) return double.NaN;
            long want = Math.Max(1, (long)Math.Ceiling(q * total)), seen = 0;
            for (int i = 0; i < len; i++) { seen += a[off + i]; if (seen >= want) return Upper(i, unit); }
            return Upper(len - 1, unit);
        }
        public static double Quantile(int[] a, int off, int len, double q, double unit)
        {
            long total = 0;
            for (int i = 0; i < len; i++) total += a[off + i];
            if (total <= 0) return double.NaN;
            long want = Math.Max(1, (long)Math.Ceiling(q * total)), seen = 0;
            for (int i = 0; i < len; i++) { seen += a[off + i]; if (seen >= want) return Upper(i, unit); }
            return Upper(len - 1, unit);
        }
    }

    // A histogram any thread may add to (Interlocked, no lock): count, buckets and the largest value.
    public sealed class CbHist
    {
        public const int Size = 64;
        private readonly long[] n = new long[Size];
        private readonly double unit;
        private long count, maxBits = BitConverter.DoubleToInt64Bits(0);
        public CbHist(double unit) { this.unit = unit; }
        public void Add(double v)
        {
            Interlocked.Increment(ref n[CbBuckets.Of(v, unit, Size)]);
            Interlocked.Increment(ref count);
            for (int i = 0; i < 8; i++)
            {
                long was = Interlocked.Read(ref maxBits);
                if (!(v > BitConverter.Int64BitsToDouble(was))) break;
                if (Interlocked.CompareExchange(ref maxBits, BitConverter.DoubleToInt64Bits(v), was) == was) break;
            }
        }
        public long Count { get { return Interlocked.Read(ref count); } }
        // {"n":count,"p50":..,"p95":..,"max":..} (null when empty), values in the histogram's unit as given to Add
        public string Json()
        {
            long[] c = new long[Size];
            for (int i = 0; i < Size; i++) c[i] = Interlocked.Read(ref n[i]);
            long total = Count;
            if (total == 0) return "{\"n\":0,\"p50\":null,\"p95\":null,\"max\":null}";
            return "{\"n\":" + total + ",\"p50\":" + CbJson.Num3(CbBuckets.Quantile(c, 0, Size, 0.5, unit)) + ",\"p95\":" + CbJson.Num3(CbBuckets.Quantile(c, 0, Size, 0.95, unit)) +
                   ",\"max\":" + CbJson.Num3(BitConverter.Int64BitsToDouble(Interlocked.Read(ref maxBits))) + "}";
        }
    }

    // ------------------------------------------------------------------ /diag "health"
    public static class ChartBridgeHealth
    {
        public static readonly CbHist SendMsAll = new CbHist(0.01);   // every page's sends since the start, ms (from 10 us)
        private static long connects, closes, notKeepingUp, sendErrors, sendLoops;
        private static double lastConnectMs = -1, lastNotKeepingUpMs = -1;
        public static void Connected() { Interlocked.Increment(ref connects); lastConnectMs = ChartBridgeTime.NowUtcMs(); }
        public static void Closed() { Interlocked.Increment(ref closes); }
        public static void NotKeepingUp() { Interlocked.Increment(ref notKeepingUp); lastNotKeepingUpMs = ChartBridgeTime.NowUtcMs(); }
        public static void SendError() { Interlocked.Increment(ref sendErrors); }
        public static void LoopStarted() { Interlocked.Increment(ref sendLoops); }
        public static void LoopEnded() { Interlocked.Decrement(ref sendLoops); }

        public static string ThreadsJson()
        {
            int wa = -1, ia = -1, wmin = -1, imin = -1, wmax = -1, imax = -1, proc = -1;
            try { ThreadPool.GetAvailableThreads(out wa, out ia); ThreadPool.GetMinThreads(out wmin, out imin); ThreadPool.GetMaxThreads(out wmax, out imax); } catch (Exception) { }
            try { using (Process p = Process.GetCurrentProcess()) proc = p.Threads.Count; } catch (Exception) { }
            return "{\"poolWorkersFree\":" + wa + ",\"poolWorkersMin\":" + wmin + ",\"poolWorkersMax\":" + wmax + ",\"poolWorkersBusy\":" + (wmax >= 0 && wa >= 0 ? wmax - wa : -1) +
                   ",\"poolIoFree\":" + ia + ",\"poolIoMin\":" + imin + ",\"poolIoMax\":" + imax + ",\"processThreads\":" + proc + ",\"pageSendThreads\":" + Interlocked.Read(ref sendLoops) + "}";
        }
        public static string PagesJson()
        {
            return "{\"connects\":" + Interlocked.Read(ref connects) + ",\"closes\":" + Interlocked.Read(ref closes) + ",\"notKeepingUp\":" + Interlocked.Read(ref notKeepingUp) +
                   ",\"sendErrors\":" + Interlocked.Read(ref sendErrors) + ",\"lastConnectUtcMs\":" + (lastConnectMs >= 0 ? CbJson.Num3(lastConnectMs) : "null") +
                   ",\"lastNotKeepingUpUtcMs\":" + (lastNotKeepingUpMs >= 0 ? CbJson.Num3(lastNotKeepingUpMs) : "null") + ",\"sendMs\":" + SendMsAll.Json() + "}";
        }
    }

    // ------------------------------------------------------------------ the quote-only markets
    // config.txt quoteRoots (default YM, RTY, GC, SI, CL, 6E, ZN, ZB) are served for the Quote board: hello, history, live
    // ticks, the prior settlement, like the traded roots; every order action for them is refused (ChartBridgeOrders, one early
    // check). Each has its own front-month roll; NinjaTrader's own rollover list (MasterInstrument.RolloverCollection) is used
    // when it covers today, else the rule in the table. Tick size is NinjaTrader's (the table's only when NinjaTrader gives
    // none). contract.<ROOT> in config.txt still wins over both.
    public static class ChartBridgeMarkets
    {
        public const int IndexRoll = 0, LastTradeRoll = 1, FirstNoticeRoll = 2;
        public const int RollDaysBefore = 8;   // the roll, calendar days before the key date (as the index rule: 8 days before expiry)
        public class Spec
        {
            public string Root, Format, Settle; public double Tick; public int Roll; public int[] Months;
            public TimeSpan? SettleEt;   // New York time the settlement can be out by (null: the equity index rule, 16:00)
        }
        private static readonly int[] Quarterly = { 3, 6, 9, 12 }, AllMonths = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 };
        private static Spec S(string root, double tick, string format, int roll, int[] months, TimeSpan? settle) { return new Spec { Root = root, Tick = tick, Format = format, Roll = roll, Months = months, SettleEt = settle }; }
        // The fallback table (CME contract specs). Key dates: index futures expire the third Friday (rolled 8 days before, as
        // ChartBridgeServer.FrontMonth); 6E's last trade is two business days before the third Wednesday; CL's last trade is three
        // business days before the 25th of the month before (the business day before the 25th when it is not one); GC, SI, ZN and
        // ZB are rolled before their first notice day, the last business day of the month before. The roll is RollDaysBefore
        // calendar days before the key date. Business days: Monday to Friday, not an NYSE holiday (ChartBridgeCme).
        public static readonly Dictionary<string, Spec> Table = new Dictionary<string, Spec>
        {
            { "YM",  S("YM",  1,        "decimal", IndexRoll,       Quarterly, null) },
            { "RTY", S("RTY", 0.1,      "decimal", IndexRoll,       Quarterly, null) },
            { "GC",  S("GC",  0.1,      "decimal", FirstNoticeRoll, new[] { 2, 4, 6, 8, 10, 12 }, new TimeSpan(13, 30, 0)) },
            { "SI",  S("SI",  0.005,    "decimal", FirstNoticeRoll, new[] { 3, 5, 7, 9, 12 }, new TimeSpan(13, 25, 0)) },
            { "CL",  S("CL",  0.01,     "decimal", LastTradeRoll,   AllMonths, new TimeSpan(14, 30, 0)) },
            { "6E",  S("6E",  0.00005,  "decimal", LastTradeRoll,   Quarterly, new TimeSpan(15, 0, 0)) },
            { "ZN",  S("ZN",  0.015625, "32nds",   FirstNoticeRoll, Quarterly, new TimeSpan(15, 0, 0)) },
            { "ZB",  S("ZB",  0.03125,  "32nds",   FirstNoticeRoll, Quarterly, new TimeSpan(15, 0, 0)) },
        };
        public static string[] DefaultQuoteRoots() { return new[] { "YM", "RTY", "GC", "SI", "CL", "6E", "ZN", "ZB" }; }

        public static Spec SpecOf(string root) { Spec s; return root != null && Table.TryGetValue(root, out s) ? s : null; }
        // "decimal", or "32nds" (ZN, ZB: the page writes 104'035 for 104 and 3.5/32)
        public static string FormatOf(string root) { Spec s = SpecOf(root); return s != null ? s.Format : "decimal"; }
        // NinjaTrader's tick size; the table's only when NinjaTrader gives none
        public static double TickOf(string root, Instrument inst)
        {
            try { if (inst != null && inst.MasterInstrument != null && inst.MasterInstrument.TickSize > 0) return inst.MasterInstrument.TickSize; } catch (Exception) { }
            Spec s = SpecOf(root);
            return s != null ? s.Tick : 0.25;
        }
        // When root's settlement can be out on trading day d (New York time): the equity index rule (ChartBridgeCme: 16:00, 12:00
        // on an NYSE holiday or early close), or the root's own earlier time.
        public static TimeSpan EarliestSettlement(string root, DateTime d)
        {
            TimeSpan rule = ChartBridgeCme.EarliestSettlement(d);
            Spec s = SpecOf(root);
            return s != null && s.SettleEt.HasValue && s.SettleEt.Value < rule ? s.SettleEt.Value : rule;
        }

        private static bool Biz(DateTime d) { return d.DayOfWeek != DayOfWeek.Saturday && d.DayOfWeek != DayOfWeek.Sunday && !ChartBridgeCme.NyseHolidays(d.Year).Contains(d.Date); }
        private static DateTime BizBefore(DateTime d, int n) { DateTime x = d.Date; for (int i = 0; i < n; ) { x = x.AddDays(-1); if (Biz(x)) i++; } return x; }
        private static DateTime ThirdWeekday(int y, int m, DayOfWeek wd) { DateTime d = new DateTime(y, m, 1); while (d.DayOfWeek != wd) d = d.AddDays(1); return d.AddDays(14); }

        // The date the contract of (y, m) stops being the front month, by the table's rule.
        public static DateTime RollDate(Spec s, int y, int m)
        {
            DateTime key;
            if (s.Roll == FirstNoticeRoll) { DateTime d = new DateTime(y, m, 1).AddDays(-1); while (!Biz(d)) d = d.AddDays(-1); key = d; }
            else if (s.Root == "CL")
            {
                DateTime d25 = new DateTime(y, m, 1).AddMonths(-1).AddDays(24);
                DateTime from = d25; if (!Biz(from)) { from = from.AddDays(-1); while (!Biz(from)) from = from.AddDays(-1); }
                key = BizBefore(from, 3);
            }
            else if (s.Roll == LastTradeRoll) key = BizBefore(ThirdWeekday(y, m, DayOfWeek.Wednesday), 2);   // 6E
            else key = ThirdWeekday(y, m, DayOfWeek.Friday);                                                    // index
            return key.AddDays(-RollDaysBefore);
        }

        // "MM-yy" of root's front month on New York date nowEt by the table (any root not in it: the equity index rule).
        public static string FrontMonth(string root, DateTime nowEt)
        {
            Spec s = SpecOf(root);
            if (s == null || s.Roll == IndexRoll) return ChartBridgeServer.FrontMonth(nowEt);
            for (int k = 0; k < 30; k++)
            {
                DateTime c = new DateTime(nowEt.Year, nowEt.Month, 1).AddMonths(k);
                if (Array.IndexOf(s.Months, c.Month) < 0) continue;
                if (nowEt.Date < RollDate(s, c.Year, c.Month).Date) return c.ToString("MM-yy", CultureInfo.InvariantCulture);
            }
            return new DateTime(nowEt.Year + 2, s.Months[0], 1).ToString("MM-yy", CultureInfo.InvariantCulture);
        }

        // NinjaTrader's own front month from its rollover list (Tools > Instruments, Rollovers), read by reflection so that a
        // NinjaTrader build without it compiles and falls back: the contract month of the latest rollover on or before today,
        // only when the list also holds a later rollover (a list that ends before today is out of date). Null when it cannot say.
        public static string NtFrontMonth(object master, DateTime nowEt)
        {
            try
            {
                if (master == null) return null;
                PropertyInfo p = master.GetType().GetProperty("RolloverCollection");
                IEnumerable list = p != null ? p.GetValue(master, null) as IEnumerable : null;
                if (list == null) return null;
                DateTime best = DateTime.MinValue, month = DateTime.MinValue; bool later = false;
                foreach (object r in list)
                {
                    if (r == null) continue;
                    PropertyInfo pm = r.GetType().GetProperty("ContractMonth"), pd = r.GetType().GetProperty("Date");
                    if (pm == null || pd == null) return null;
                    DateTime cm = (DateTime)pm.GetValue(r, null), d = (DateTime)pd.GetValue(r, null);
                    if (d.Date <= nowEt.Date) { if (d >= best) { best = d; month = cm; } }
                    else later = true;
                }
                if (best == DateTime.MinValue || !later) return null;
                return month.ToString("MM-yy", CultureInfo.InvariantCulture);
            }
            catch (Exception) { return null; }
        }

        // How each served root was resolved, for /diag "markets" (set at start).
        private static readonly Dictionary<string, string> How = new Dictionary<string, string>();
        public static void NoteHow(string root, string how) { lock (How) How[root] = how; }
        public static void ClearHow() { lock (How) How.Clear(); }

        // The instrument for a quote-only root: contract.<ROOT> from config.txt; else the table's front month, and NinjaTrader's
        // rollover list (read from that contract's master instrument) when it covers today and says another month.
        public static Instrument Resolve(string root, DateTime nowEt, Func<string, Instrument> get, out string name, out string how)
        {
            how = null;
            if (ChartBridgeConfig.ContractOverride.TryGetValue(root, out name)) { how = "contract." + root + " in config.txt"; return get(name); }
            string rule = FrontMonth(root, nowEt);
            name = root + " " + rule;
            Instrument inst = get(name);
            how = "the roll rule (" + rule + ")";
            if (inst == null) return null;
            string nt = NtFrontMonth(inst.MasterInstrument, nowEt);
            if (nt == null) { how += "; NinjaTrader's rollover list does not cover today"; return inst; }
            if (nt == rule) { how = "NinjaTrader's rollover list (" + nt + "), as the roll rule"; return inst; }
            Instrument ntInst = get(root + " " + nt);
            if (ntInst == null) { how += "; NinjaTrader's rollover list says " + nt + " but that contract was not found"; return inst; }
            name = root + " " + nt;
            how = "NinjaTrader's rollover list (" + nt + "; the roll rule says " + rule + ")";
            return ntInst;
        }

        public static string DiagJson(IEnumerable<KeyValuePair<string, Instrument>> served)
        {
            StringBuilder b = new StringBuilder("{");
            foreach (KeyValuePair<string, Instrument> kv in served)
            {
                string how; lock (How) How.TryGetValue(kv.Key, out how);
                Spec s = SpecOf(kv.Key);
                if (b.Length > 1) b.Append(',');
                b.Append(CbJson.Str(kv.Key)).Append(":{\"contract\":").Append(CbJson.Str(kv.Value != null ? kv.Value.FullName : null))
                 .Append(",\"quoteOnly\":").Append(ChartBridgeConfig.QuoteOnly(kv.Key) ? "true" : "false")
                 .Append(",\"tick\":").Append(CbJson.Num(TickOf(kv.Key, kv.Value))).Append(",\"tableTick\":").Append(s != null ? CbJson.Num(s.Tick) : "null")
                 .Append(",\"priceFormat\":").Append(CbJson.Str(FormatOf(kv.Key)))
                 .Append(",\"settlesBy\":").Append(CbJson.Str(s != null && s.SettleEt.HasValue ? s.SettleEt.Value.ToString("hh\\:mm", CultureInfo.InvariantCulture) + " ET" : "16:00 ET (equity index rule)"))
                 .Append(",\"resolvedBy\":").Append(CbJson.Str(how)).Append('}');
            }
            return b.Append('}').ToString();
        }
    }

    // ------------------------------------------------------------------ tape timing counters (diagnostic only)
    // Per root and per 15 minutes of the session (from 18:00 ET), how the live trades arrive: prints per second (the slot's
    // average and its busiest second), the gap between prints by NinjaTrader's time on them (median, p95, longest), the share
    // of prints stamped in the same millisecond as the print before (by NinjaTrader's time, u, and by when ChartBridge got
    // it, rx), the price step from one print to the next in ticks (0, 1, 2, 3 or more), and the delay rx minus u (median,
    // p95; below 0 counted apart, a clock difference). Fed from OnMarketData after the trade has gone out, in its own try:
    // nothing here can stop a trade, its send, or ChartBridgeOrders.NoteLast. No lock and no allocation per trade: fixed
    // arrays (this session and the last), the slot worked out again only when a trade falls outside the current one, and the
    // log buckets of CbBuckets (no sorting). Two NinjaTrader threads feeding one root at once could miscount a print; the
    // counts are a diagnostic, never used for anything else.
    public sealed class TapeSession
    {
        public const int Slots = 96, Gb = 48;   // 15-minute slots of a day; gap and delay buckets (1 ms up to about 3 hours)
        public double StartEt = double.NaN;     // the session's 18:00 ET, bar-time seconds
        public readonly int[] Prints = new int[Slots], Pairs = new int[Slots], SameU = new int[Slots], SameRx = new int[Slots], Peak = new int[Slots], NegDelay = new int[Slots];
        public readonly int[] J0 = new int[Slots], J1 = new int[Slots], J2 = new int[Slots], J3 = new int[Slots];
        public readonly double[] GapMax = new double[Slots];
        public readonly int[] Gap = new int[Slots * Gb], Delay = new int[Slots * Gb];
        public void Clear(double startEt)
        {
            StartEt = startEt;
            Array.Clear(Prints, 0, Slots); Array.Clear(Pairs, 0, Slots); Array.Clear(SameU, 0, Slots); Array.Clear(SameRx, 0, Slots); Array.Clear(Peak, 0, Slots); Array.Clear(NegDelay, 0, Slots);
            Array.Clear(J0, 0, Slots); Array.Clear(J1, 0, Slots); Array.Clear(J2, 0, Slots); Array.Clear(J3, 0, Slots); Array.Clear(GapMax, 0, Slots);
            Array.Clear(Gap, 0, Gap.Length); Array.Clear(Delay, 0, Delay.Length);
        }
    }

    public sealed class TapeRoot
    {
        public readonly string Root;
        private readonly double invTick;
        public TapeSession Cur = new TapeSession(), Last = new TapeSession();
        private double slotStart = double.PositiveInfinity, slotEnd = double.NegativeInfinity, prevU, prevRx;
        private int slot; private long prevTicks, sec = long.MinValue; private int secN; private bool hasPrev;
        public long Late, Sessions;   // prints of an earlier session than the current one (not counted); sessions seen
        public TapeRoot(string root, double tick) { Root = root; invTick = tick > 0 && !double.IsInfinity(tick) ? 1 / tick : 4; }

        // et: bar-time seconds (New York wall clock as UTC); a session starts at 18:00 of the day before its trading day.
        private bool Locate(double et)
        {
            if (double.IsNaN(et) || double.IsInfinity(et)) return false;
            double start = Math.Floor((et - 64800) / 86400) * 86400 + 64800;
            TapeSession s = Cur;
            if (double.IsNaN(s.StartEt) || start > s.StartEt)
            {
                if (!double.IsNaN(s.StartEt)) { TapeSession old = Last; Last = s; old.Clear(start); Cur = old; }
                else s.Clear(start);
                hasPrev = false; Sessions++;
            }
            else if (start < s.StartEt) { Late++; return false; }
            int k = (int)((et - start) / 900);
            if (k < 0) k = 0; else if (k >= TapeSession.Slots) k = TapeSession.Slots - 1;
            slot = k; slotStart = start + k * 900.0; slotEnd = slotStart + 900;
            return true;
        }

        public void OnPrint(double uMs, double rxMs, double et, double price)
        {
            if (!(et >= slotStart && et < slotEnd) && !Locate(et)) return;
            TapeSession s = Cur; int k = slot;
            s.Prints[k]++;
            long sc = (long)Math.Floor(uMs / 1000);
            if (sc == sec) secN++; else { sec = sc; secN = 1; }
            if (secN > s.Peak[k]) s.Peak[k] = secN;
            bool priced = price > 0 && price < 1e12;
            long ticks = priced ? (long)Math.Round(price * invTick) : 0;
            if (hasPrev)
            {
                double gap = uMs - prevU;
                if (!(gap > 0)) gap = 0;
                s.Gap[k * TapeSession.Gb + CbBuckets.Of(gap, 1, TapeSession.Gb)]++;
                if (gap > s.GapMax[k]) s.GapMax[k] = gap;
                if (Math.Floor(uMs) == Math.Floor(prevU)) s.SameU[k]++;
                if (Math.Floor(rxMs) == Math.Floor(prevRx)) s.SameRx[k]++;
                if (priced)
                {
                    long j = ticks - prevTicks; if (j < 0) j = -j;
                    if (j == 0) s.J0[k]++; else if (j == 1) s.J1[k]++; else if (j == 2) s.J2[k]++; else s.J3[k]++;
                }
                s.Pairs[k]++;
            }
            double d = rxMs - uMs;
            if (d < 0) s.NegDelay[k]++;
            s.Delay[k * TapeSession.Gb + CbBuckets.Of(d, 1, TapeSession.Gb)]++;
            prevU = uMs; prevRx = rxMs; if (priced) prevTicks = ticks; hasPrev = priced || hasPrev;
        }
    }

    public static class ChartBridgeTape
    {
        private static readonly object Sync = new object();
        private static volatile Dictionary<string, TapeRoot> roots = new Dictionary<string, TapeRoot>();   // replaced, never changed: read with no lock
        private static long failed;
        public static bool ThrowForHarness;   // the harness only: OnPrint throws, to show a trade still goes out

        // One live trade, after it went out. uMs: NinjaTrader's time on it (UTC ms); rxMs: when ChartBridge got it; et: its
        // bar-time seconds; tick: the root's tick size.
        public static void OnPrint(string root, double tick, double uMs, double rxMs, double et, double price)
        {
            if (ThrowForHarness) throw new InvalidOperationException("tape test fault");
            if (root == null) return;
            Dictionary<string, TapeRoot> d = roots;
            TapeRoot t;
            if (!d.TryGetValue(root, out t))
            {
                lock (Sync)
                {
                    d = roots;
                    if (!d.TryGetValue(root, out t)) { Dictionary<string, TapeRoot> n = new Dictionary<string, TapeRoot>(d); t = new TapeRoot(root, tick); n[root] = t; roots = n; }
                }
            }
            t.OnPrint(uMs, rxMs, et, price);
        }
        // An exception in OnPrint (caught by the caller): counted, and said at most once a minute.
        public static void Failed(Exception ex) { Interlocked.Increment(ref failed); CbLogLimit.Error("tape counter error", ex); }
        public static long FailedCount { get { return Interlocked.Read(ref failed); } }
        public static void Reset() { lock (Sync) roots = new Dictionary<string, TapeRoot>(); Interlocked.Exchange(ref failed, 0); }
        public static TapeRoot Of(string root) { TapeRoot t; return root != null && roots.TryGetValue(root, out t) ? t : null; }

        private static string Ms(double v) { return double.IsNaN(v) ? "null" : CbJson.Num3(v); }
        // bar-time seconds as New York wall clock text; a time out of DateTime's range (a bad stamp) as its number
        private static string EtText(double et, string format)
        {
            if (!(et > -6e10 && et < 2.5e11)) return CbJson.Num3(et);
            return new DateTime(1970, 1, 1).AddSeconds(et).ToString(format, CultureInfo.InvariantCulture);
        }
        private static string Share(int part, int of) { return of > 0 ? CbJson.Num3((double)part / of) : "null"; }

        public static string SessionJson(TapeSession s)
        {
            if (s == null || double.IsNaN(s.StartEt)) return "null";
            StringBuilder b = new StringBuilder();
            b.Append("{\"from\":").Append(CbJson.Str(EtText(s.StartEt, "yyyy-MM-dd HH:mm"))).Append(",\"slots\":[");
            bool first = true; long prints = 0;
            for (int k = 0; k < TapeSession.Slots; k++)
            {
                int n = s.Prints[k];
                if (n <= 0) continue;
                prints += n;
                if (!first) b.Append(','); first = false;
                int pairs = s.Pairs[k], jumps = s.J0[k] + s.J1[k] + s.J2[k] + s.J3[k];
                b.Append("{\"at\":").Append(CbJson.Str(EtText(s.StartEt + k * 900.0, "HH:mm")))
                 .Append(",\"prints\":").Append(n).Append(",\"perSec\":").Append(CbJson.Num3(n / 900.0)).Append(",\"peakPerSec\":").Append(s.Peak[k])
                 .Append(",\"gapMs\":{\"p50\":").Append(Ms(CbBuckets.Quantile(s.Gap, k * TapeSession.Gb, TapeSession.Gb, 0.5, 1)))
                 .Append(",\"p95\":").Append(Ms(CbBuckets.Quantile(s.Gap, k * TapeSession.Gb, TapeSession.Gb, 0.95, 1)))
                 .Append(",\"max\":").Append(pairs > 0 ? CbJson.Num3(s.GapMax[k]) : "null").Append('}')
                 .Append(",\"sameMsU\":").Append(Share(s.SameU[k], pairs)).Append(",\"sameMsRx\":").Append(Share(s.SameRx[k], pairs))
                 .Append(",\"jumpTicks\":{\"0\":").Append(Share(s.J0[k], jumps)).Append(",\"1\":").Append(Share(s.J1[k], jumps))
                 .Append(",\"2\":").Append(Share(s.J2[k], jumps)).Append(",\"3+\":").Append(Share(s.J3[k], jumps)).Append('}')
                 .Append(",\"delayMs\":{\"p50\":").Append(Ms(CbBuckets.Quantile(s.Delay, k * TapeSession.Gb, TapeSession.Gb, 0.5, 1)))
                 .Append(",\"p95\":").Append(Ms(CbBuckets.Quantile(s.Delay, k * TapeSession.Gb, TapeSession.Gb, 0.95, 1)))
                 .Append(",\"below0\":").Append(s.NegDelay[k]).Append("}}");
            }
            return b.Append("],\"prints\":").Append(prints).Append('}').ToString();
        }

        // /diag "tape": per root, this session's slots and the last session's. Quantiles are bucket upper edges (within 41 percent).
        public static string DiagJson()
        {
            StringBuilder b = new StringBuilder("{\"failed\":");
            b.Append(FailedCount).Append(",\"roots\":{");
            bool first = true;
            foreach (KeyValuePair<string, TapeRoot> kv in roots.OrderBy(x => x.Key, StringComparer.Ordinal))
            {
                if (!first) b.Append(','); first = false;
                TapeRoot t = kv.Value;
                b.Append(CbJson.Str(kv.Key)).Append(":{\"late\":").Append(t.Late).Append(",\"session\":").Append(SessionJson(t.Cur)).Append(",\"last\":").Append(SessionJson(t.Last)).Append('}');
            }
            return b.Append("}}").ToString();
        }
    }
}
