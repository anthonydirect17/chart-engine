// ChartBridge 0.3.5 on Mono: the session's volume at price (SessionTable, RootBook), its one backfill, and the served window.
// First as pure cases on a RootBook: the table against every trade (per half hour and price, so the RTH part too), the 18:00
// rollover and the weekend (the last finished session kept, the served window dropped), NinjaTrader in another time zone
// across the daylight saving weeks, and when a session's table is whole. Then through ChartBridgeServer's own subscribe,
// market data handler and requests: a mid-session start whose one backfill is joined to the live trades by the seam; a tick
// chart's served window asked by count (asked again when short, cut at rangeHours), then served to a second page and a
// reload from ChartBridge's memory with no request to NinjaTrader; the "profile" message exact against every trade. And the
// faster trade text against 0.3.4's. Made-up prices; nothing here is market data.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Threading;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript.AddOns;

public static class WindowHarness
{
    static Action<bool, string> Check;
    static object Priv(string name, params object[] args) { return typeof(ChartBridgeServer).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, args); }

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        TablePure();
        RolloverAndWeekend();
        TimeZones();
        WholeRule();
        Format();
    }

    // ------------------------------------------------------------ helpers
    static DateTime Et(int y, int mo, int d, int h, int mi, double sec)
    {
        DateTime wall = new DateTime(y, mo, d, h, mi, 0, DateTimeKind.Unspecified).AddTicks((long)Math.Round(sec * TimeSpan.TicksPerSecond));
        return DateTime.SpecifyKind(TimeZoneInfo.ConvertTimeFromUtc(TimeZoneInfo.ConvertTimeToUtc(wall, ChartBridgeTime.Eastern), NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo), DateTimeKind.Unspecified);
    }
    static double EtSec(DateTime nt) { return ChartBridgeTime.EtSeconds(ChartBridgeTime.ToUtc(nt)); }
    class Trade { public DateTime T; public double P; public long V; }
    // A made-up tape: trades from t0 every stepMs (0 to 2 x, some in the same ms), prices walking by ticks. Seeded.
    static List<Trade> Walk(DateTime t0, int n, int seed, int stepMs)
    {
        Random rnd = new Random(seed);
        List<Trade> l = new List<Trade>(n);
        DateTime t = t0; double p = 20000;
        for (int i = 0; i < n; i++)
        {
            if (rnd.NextDouble() > 0.2) t = t.AddTicks(rnd.Next(1, 2 * stepMs + 1) * TimeSpan.TicksPerMillisecond);
            p += (rnd.Next(0, 3) - 1) * 0.25;
            l.Add(new Trade { T = t, P = p, V = 1 + rnd.Next(0, 5) });
        }
        return l;
    }
    // The truth: every trade of the session starting at `start` (NinjaTrader time), per half hour of New York time and price.
    static Dictionary<long, long> Truth(IEnumerable<Trade> trades, DateTime start, DateTime end, double tick)
    {
        Dictionary<long, long> d = new Dictionary<long, long>();
        foreach (Trade x in trades) if (x.T >= start && x.T < end) SessionTable.Add(d, EtSec(x.T), (long)Math.Round(x.P / tick), x.V);
        return d;
    }
    static string Diff(Dictionary<long, long> a, Dictionary<long, long> b)
    {
        foreach (KeyValuePair<long, long> kv in a) { long v; if (!b.TryGetValue(kv.Key, out v) || v != kv.Value) return "row " + kv.Key + ": " + kv.Value + " against " + (b.ContainsKey(kv.Key) ? b[kv.Key].ToString() : "none"); }
        foreach (long k in b.Keys) if (!a.ContainsKey(k)) return "row " + k + " missing";
        return null;
    }
    static void Feed(RootBook book, IEnumerable<Trade> trades, DateTime listeningUtc)
    {
        foreach (Trade x in trades) lock (book.Sync) book.OnTrade(x.T, x.P, x.V, EtSec(x.T), listeningUtc, 0, DateTime.MinValue, true);
    }

    // ------------------------------------------------------------ the table against every trade
    static void TablePure()
    {
        // A session from 18:00 ET on Monday 2026-09-28 into Tuesday's RTH, NinjaTrader listening since before it.
        DateTime s0 = Et(2026, 9, 28, 18, 0, 0.05);
        List<Trade> tape = Walk(s0, 60000, 11, 600);    // about 10 hours: into Tuesday morning
        tape.AddRange(Walk(Et(2026, 9, 29, 9, 29, 50), 30000, 12, 20));   // 9:29:50 on: across 9:30 in a busy minute
        tape = tape.OrderBy(x => x.T).ToList();
        RootBook book = new RootBook("MNQ", 0.25);
        DateTime listening = ChartBridgeTime.ToUtc(s0).AddHours(-1);
        Feed(book, tape, listening);
        DateTime start, end; SessionClock.Bounds(s0, out start, out end);
        Dictionary<long, long> truth = Truth(tape, start, end, 0.25);
        string diff = Diff(book.Table.Vol, truth);
        Check(book.Table.Whole && diff == null && book.Table.Trades == tape.Count, "table: every trade of the session in it, per half hour and price, exactly (" + tape.Count.ToString("N0", CultureInfo.InvariantCulture) + " trades, " + truth.Count + " rows" + (diff != null ? "; " + diff : "") + ")");
        // The RTH part: the rows of the half hours from 9:30 are the trades from 9:30:00.000 on, to the trade.
        double rth0 = EtSec(Et(2026, 9, 29, 9, 30, 0));
        long rows = book.Table.Vol.Where(kv => (kv.Key >> 32) * SessionTable.BucketSeconds >= rth0).Sum(kv => kv.Value);
        long trades = tape.Where(x => EtSec(x.T) >= rth0).Sum(x => x.V);
        long before = tape.Count(x => EtSec(x.T) >= rth0 - 10 && EtSec(x.T) < rth0);
        Check(rows == trades && trades > 0 && before > 100, "table: the half hours from 9:30 ET hold exactly the volume traded from 9:30:00.000 on (" + rows + "; " + before + " trades in the 10 s before it are not in them)");
        // The profile message: rows in key order, the page's price in ticks; less the trades the page gets after it.
        List<SeamTick> less = tape.Skip(tape.Count - 500).Select(x => new SeamTick { Time = x.T, Price = x.P, Volume = x.V }).ToList();
        string json;
        ProfileSnap snap; lock (book.Sync) snap = book.Snap();
        json = snap.Json("7", less);   // S4: copied under the lock, formatted with none held
        Dictionary<long, long> sent = ParseRows(json, "session");
        Dictionary<long, long> want = Truth(tape.Take(tape.Count - 500), start, end, 0.25);
        string d2 = Diff(sent, want);
        Check(d2 == null && json.Contains("\"whole\":true") && json.Contains("\"bucketSeconds\":1800") && json.Contains("\"last\":null"), "profile message: the table less the trades the page is about to get live equals every trade before them" + (d2 != null ? " (" + d2 + ")" : ""));
    }
    // "rows":[[half hour start, price ticks, volume], ...] of one table in a profile message, keyed as SessionTable keys them.
    static Dictionary<long, long> ParseRows(string json, string table)
    {
        Dictionary<long, long> d = new Dictionary<long, long>();
        int i = json.IndexOf("\"" + table + "\":{");
        if (i < 0) return d;
        i = json.IndexOf("\"rows\":[", i) + 8;
        while (i < json.Length && json[i] == '[')
        {
            int j = json.IndexOf(']', i);
            string[] p = json.Substring(i + 1, j - i - 1).Split(',');
            double bucket = double.Parse(p[0], CultureInfo.InvariantCulture);
            d[SessionTable.Key(bucket, long.Parse(p[1], CultureInfo.InvariantCulture))] = long.Parse(p[2], CultureInfo.InvariantCulture);
            i = j + 1; if (i < json.Length && json[i] == ',') i++;
        }
        return d;
    }

    // ------------------------------------------------------------ 18:00 and the weekend
    static void RolloverAndWeekend()
    {
        RootBook book = new RootBook("MNQ", 0.25);
        DateTime listening = ChartBridgeTime.ToUtc(Et(2026, 9, 23, 12, 0, 0));   // since before Thursday's session (Wednesday 18:00)
        List<Trade> thu = Walk(Et(2026, 9, 23, 18, 0, 0.001), 100, 20, 500).Concat(Walk(Et(2026, 9, 24, 16, 30, 0), 3000, 21, 500)).ToList();   // Thursday's session, from its start
        List<Trade> fri = Walk(Et(2026, 9, 24, 18, 0, 0.001), 5000, 22, 700);     // Friday's session, from 18:00 Thursday
        List<Trade> sun = Walk(Et(2026, 9, 27, 18, 0, 0.001), 2000, 23, 300);     // Sunday 18:00: Monday's session
        thu = thu.Where(x => x.T < Et(2026, 9, 24, 17, 0, 0)).ToList();
        Feed(book, thu, listening);
        book.Cache = new TradeLog(); book.Cache.Add(thu[0].T, thu[0].P, thu[0].V);
        Feed(book, fri, listening);
        Check(book.Last != null && book.Last.Whole && book.Last.Volume == thu.Sum(x => x.V) && book.Table.Whole && book.Cache == null && book.LastChanged,
            "18:00: Thursday's session ends (kept as the last one, " + book.Last.Volume + " contracts), Friday's starts whole from its first trade, the served window is dropped");
        book.LastChanged = false;
        Feed(book, sun, listening);
        DateTime fs, fe; SessionClock.Bounds(fri[0].T, out fs, out fe);
        Check(book.Last.Volume == fri.Sum(x => x.V) && book.Last.Start == fs && book.Table.Start == Et(2026, 9, 27, 18, 0, 0) && book.Table.Whole && book.LastChanged,
            "the weekend: Sunday 18:00 starts Monday's session; Friday's is the last one kept (" + book.Last.Volume + " contracts)");
        string text = RootBook.LastText(book.Last);
        SessionTable back = RootBook.ParseLast(text, book.Last.StartEt + 3 * 86400);
        Check(back != null && back.Whole && Math.Abs(back.StartEt - book.Last.StartEt) < 0.001 && Diff(back.Vol, book.Last.Vol) == null && text.Split('\n').Length < book.Last.Vol.Count + 3,
            "the last session's table in its file and back: the same rows (" + back.Vol.Count + "), no single trades in it");
        Check(RootBook.ParseLast(text, book.Last.StartEt + 5 * 86400) == null, "nit: a saved session more than 4 days old is not used (a stale file)");
        // A late trade of a finished session (NinjaTrader delivering it after 18:00) changes no table.
        long v0 = book.Table.Volume, l0 = book.Last.Volume;
        lock (book.Sync) book.OnTrade(fri[fri.Count - 1].T, 1, 7, EtSec(fri[fri.Count - 1].T), listening, 0, DateTime.MinValue, true);
        Check(book.Table.Volume == v0 && book.Last.Volume == l0 && book.LateTrades == 1, "a late trade of the session before is counted as late, in no table");
    }

    // ------------------------------------------------------------ NinjaTrader in other time zones, across the DST weeks
    static void TimeZones()
    {
        TimeZoneInfo was = NinjaTrader.Core.GeneralOptionsClass.Zone;
        string wrong = "";
        try
        {
            foreach (string z in new[] { "Europe/London", "Asia/Kolkata", "America/Chicago", "UTC" })
            foreach (DateTime day in new[] { new DateTime(2026, 10, 27), new DateTime(2026, 3, 10), new DateTime(2026, 11, 3) })
            {
                NinjaTrader.Core.GeneralOptionsClass.Zone = TimeZoneInfo.FindSystemTimeZoneById(z);
                RootBook book = new RootBook("MNQ", 0.25);
                DateTime prev = day.AddDays(-1);
                DateTime s0 = Et(prev.Year, prev.Month, prev.Day, 18, 0, 0.01);
                List<Trade> tape = Walk(s0, 2000, day.Day, 400).Concat(Walk(Et(day.Year, day.Month, day.Day, 9, 29, 0), 3000, day.Day + 1, 40)).OrderBy(x => x.T).ToList();
                Feed(book, tape, ChartBridgeTime.ToUtc(s0).AddHours(-2));
                DateTime start, end; SessionClock.Bounds(tape[0].T, out start, out end);
                double rth0 = EtSec(Et(day.Year, day.Month, day.Day, 9, 30, 0));
                bool startOk = Math.Abs(book.Table.StartEt - EtSec(Et(prev.Year, prev.Month, prev.Day, 18, 0, 0))) < 0.001;
                bool rthOk = book.Table.Vol.Where(kv => (kv.Key >> 32) * SessionTable.BucketSeconds >= rth0).Sum(kv => kv.Value) == tape.Where(x => EtSec(x.T) >= rth0).Sum(x => x.V);
                bool exact = Diff(book.Table.Vol, Truth(tape, start, end, 0.25)) == null && book.Table.Trades == tape.Count;
                if (!(startOk && rthOk && exact)) wrong += "; " + z + " " + day.ToString("yyyy-MM-dd") + ": start " + startOk + ", RTH " + rthOk + ", exact " + exact;
            }
        }
        finally { NinjaTrader.Core.GeneralOptionsClass.Zone = was; }
        Check(wrong == "", "time zones: NinjaTrader in London, Kolkata, Chicago and UTC, in the weeks the US and UK clocks differ and around them: the session starts 18:00 ET, 9:30 ET is a half-hour edge, the table is exact" + wrong);
    }

    // ------------------------------------------------------------ when a session's table is whole
    static void WholeRule()
    {
        DateTime s0 = Et(2026, 9, 29, 18, 0, 0.02);
        Func<DateTime, DateTime, RootBook> first = (listening, t) => { RootBook b = new RootBook("MNQ", 0.25); lock (b.Sync) b.OnTrade(t, 20000, 1, EtSec(t), listening, 0, t, true); return b; };
        RootBook a = first(ChartBridgeTime.ToUtc(s0).AddMinutes(-30), s0);
        RootBook b2 = first(ChartBridgeTime.ToUtc(s0).AddHours(3), s0.AddHours(3));
        RootBook c = first(ChartBridgeTime.ToUtc(s0).AddMinutes(-30), s0.AddMinutes(15));
        RootBook d = first(DateTime.MinValue, s0.AddHours(3));
        Check(a.Table.Whole && a.BackfillLive == null && a.BackfillState == "none", "whole: ChartBridge listening before 18:00 and the session's first trade at the start");
        Check(!b2.Table.Whole && b2.BackfillLive != null && b2.BackfillState == "wanted" && Math.Abs(b2.Table.CoveredFromEt - EtSec(s0.AddHours(3))) < 0.001,
            "not whole: ChartBridge started mid-session; the table counts from its first live trade and one backfill is wanted");
        Check(!c.Table.Whole && c.BackfillState == "wanted", "not whole: the first trade 15 minutes after 18:00 (the feed was down across the start)");
        Check(!d.Table.Whole, "not whole: not yet listening to market data");
        RootBook e = first(ChartBridgeTime.ToUtc(s0).AddMinutes(-30), s0.AddSeconds(45)), f = first(ChartBridgeTime.ToUtc(s0).AddMinutes(-30), s0.AddSeconds(90));
        Check(e.Table.Whole && !f.Table.Whole, "whole only when the first trade comes within a minute of 18:00 (45 s: whole; 90 s: not)");
        RootBook g = new RootBook("MES", 0.25);
        lock (g.Sync) g.OnTrade(s0.AddHours(3), 5000, 1, EtSec(s0.AddHours(3)), ChartBridgeTime.ToUtc(s0).AddHours(3), 0, s0.AddHours(3), false);
        Check(!g.Table.Whole && g.BackfillLive == null && g.BackfillState == "none (not in profileRoots)", "an instrument not in profileRoots: no backfill, the table counts from its first live trade (" + g.BackfillState + ")");
        // S7: a trade far older than the clock (NinjaTrader's snapshot of the last trade when market data starts) opens no table
        RootBook h = new RootBook("MNQ", 0.25);
        DateTime fri = Et(2026, 9, 25, 16, 59, 58);
        lock (h.Sync) h.OnTrade(fri, 20000, 1, EtSec(fri), ChartBridgeTime.ToUtc(fri).AddHours(40), 0, fri.AddHours(40), true);
        Check(h.Table == null && h.StaleTrades == 1 && h.BackfillState == "none", "S7: a stale last trade at start (Friday 16:59:58 seen on Sunday) opens no session and wants no backfill");
        // S1: a backfill that waits too long stops keeping live trades
        RootBook k = first(ChartBridgeTime.ToUtc(s0).AddHours(3), s0.AddHours(3));
        lock (k.Sync) for (int i = 0; i < RootBook.LiveCap + 10; i++) k.OnTrade(s0.AddHours(3).AddMilliseconds(i), 20000, 1, EtSec(s0.AddHours(3)), ChartBridgeTime.ToUtc(s0).AddHours(3), 0, DateTime.MinValue, true);
        Check(k.BackfillLive == null && k.BackfillState.StartsWith("abandoned"), "S1: the live trades kept for a backfill are bounded (" + RootBook.LiveCap.ToString("N0", CultureInfo.InvariantCulture) + "); past it the backfill is abandoned and nothing more is kept");
    }

    // ------------------------------------------------------------ the faster trade text is the same text
    // Every trade 0.3.5 formats (the backfill and the older history) must read exactly as 0.3.4 wrote it: the same time to
    // the millisecond across daylight saving changes in NinjaTrader's zone and New York's, the same price and volume text.
    static string Old(DateTime nt, double p, long v, int s, int m)
    {
        double t = ChartBridgeTime.EtSeconds(ChartBridgeTime.ToUtc(nt));
        return "[" + CbJson.Num3(t) + "," + CbJson.Num(p) + "," + v.ToString(CultureInfo.InvariantCulture) + "," + s.ToString(CultureInfo.InvariantCulture) + "," + m.ToString(CultureInfo.InvariantCulture) + "]";
    }
    static void Format()
    {
        Random rnd = new Random(4242);
        int compared = 0, differ = 0; string first = null;
        string[] zones = { null, "America/New_York", "America/Chicago", "Europe/London", "Asia/Kolkata", "Australia/Lord_Howe", "UTC" };
        DateTime[] around = { new DateTime(2026, 3, 8), new DateTime(2026, 11, 1), new DateTime(2026, 3, 29), new DateTime(2026, 10, 25), new DateTime(2026, 4, 5), new DateTime(2026, 9, 29) };
        TimeZoneInfo was = NinjaTrader.Core.GeneralOptionsClass.Zone;
        try
        {
            foreach (string z in zones)
            {
                NinjaTrader.Core.GeneralOptionsClass.Zone = z == null ? null : TimeZoneInfo.FindSystemTimeZoneById(z);
                foreach (DateTime day in around)
                {
                    int n = 6000;
                    RawBars bars = new RawBars { Count = n, Time = new DateTime[n], Close = new double[n], Volume = new long[n] };
                    BackfillSides sd = new BackfillSides { Side = new sbyte[n], Method = new byte[n], Trades = n };
                    long tick = day.AddDays(-1).Ticks;
                    for (int i = 0; i < n; i++)
                    {
                        tick += (long)(rnd.NextDouble() * 60 * TimeSpan.TicksPerSecond);   // up to a minute apart: 4 days
                        if (rnd.NextDouble() < 0.05) tick += rnd.Next(0, 3) * 5000;        // on half milliseconds now and then
                        bars.Time[i] = new DateTime(tick);
                        int k = rnd.Next(0, 6);
                        bars.Close[i] = k == 0 ? 20000 + rnd.Next(0, 4000) * 0.25 : k == 1 ? rnd.Next(1, 100000) * 0.01 : k == 2 ? rnd.NextDouble() * 50000 : k == 3 ? -rnd.Next(1, 800) * 0.25 : k == 4 ? rnd.Next(1, 9) * 0.0001 : 1e10 + rnd.Next(0, 100);
                        bars.Volume[i] = rnd.Next(0, 3) == 0 ? rnd.Next(1, 10) : (long)rnd.Next(0, int.MaxValue) * 1000;
                        sd.Side[i] = (sbyte)rnd.Next(-1, 2); sd.Method[i] = (byte)rnd.Next(0, 4);
                    }
                    ChartBridgeTime.EtCache et = new ChartBridgeTime.EtCache();
                    for (int i = 0; i < n; i++)
                    {
                        System.Text.StringBuilder b = new System.Text.StringBuilder();
                        ChartBridgeServer.AppendTrade(b, bars, sd, i, et);
                        string o = Old(bars.Time[i], bars.Close[i], bars.Volume[i], sd.Side[i], sd.Method[i]);
                        compared++;
                        if (b.ToString() != o) { differ++; if (first == null) first = (z ?? "local") + " " + bars.Time[i].ToString("o") + ": " + b + " against " + o; }
                    }
                }
            }
        }
        finally { NinjaTrader.Core.GeneralOptionsClass.Zone = was; }
        Check(differ == 0 && compared > 200000, "format: " + compared.ToString("N0", CultureInfo.InvariantCulture) + " trades written the fast way read exactly as 0.3.4 wrote them, in 7 NinjaTrader time zones across the 2026 DST changes" + (first != null ? " (" + differ + " differ; first: " + first + ")" : ""));
        // And what it saves: a 100,000-trade chunk both ways.
        int m2 = 100000;
        RawBars rb = new RawBars { Count = m2, Time = new DateTime[m2], Close = new double[m2], Volume = new long[m2] };
        BackfillSides rs = new BackfillSides { Side = new sbyte[m2], Method = new byte[m2], Trades = m2 };
        for (int i = 0; i < m2; i++) { rb.Time[i] = DateTime.Now.AddHours(-3).AddTicks(i * 311117L); rb.Close[i] = 20000 + (i % 41) * 0.25; rb.Volume[i] = 1 + i % 5; rs.Side[i] = (sbyte)(i % 3 - 1); rs.Method[i] = 2; }
        double oldUs = 1e9, newUs = 1e9;
        for (int rep = 0; rep < 3; rep++)
        {
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            System.Text.StringBuilder a = new System.Text.StringBuilder();
            for (int i = 0; i < m2; i++) a.Append(Old(rb.Time[i], rb.Close[i], rb.Volume[i], rs.Side[i], rs.Method[i]));
            oldUs = Math.Min(oldUs, sw.Elapsed.TotalMilliseconds * 1000 / m2);
            sw = System.Diagnostics.Stopwatch.StartNew();
            System.Text.StringBuilder c = new System.Text.StringBuilder();
            ChartBridgeTime.EtCache et = new ChartBridgeTime.EtCache();
            for (int i = 0; i < m2; i++) ChartBridgeServer.AppendTrade(c, rb, rs, i, et);
            newUs = Math.Min(newUs, sw.Elapsed.TotalMilliseconds * 1000 / m2);
        }
        Console.WriteLine("     (a trade's text: " + oldUs.ToString("0.00", CultureInfo.InvariantCulture) + " us as 0.3.4 wrote it, " + newUs.ToString("0.00", CultureInfo.InvariantCulture) + " us now, Mono on the build box)");
        Check(newUs < oldUs, "format: faster than before (" + newUs.ToString("0.00", CultureInfo.InvariantCulture) + " against " + oldUs.ToString("0.00", CultureInfo.InvariantCulture) + " us a trade)");
    }

    // ------------------------------------------------------------ through the server
    static ChartBridgeClient client;
    static Instrument inst;
    static readonly List<string> sent = new List<string>();
    static System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient> Clients()
    {
        return (System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
    }
    static List<string> Sent() { lock (sent) return sent.ToList(); }
    static bool WaitFor(Func<bool> ok, int ms = 5000) { for (int i = 0; i < ms / 5 && !ok(); i++) Thread.Sleep(5); return ok(); }
    static int MadeCount() { lock (BarsRequest.Made) return BarsRequest.Made.Count; }
    static List<BarsRequest> Made(int from) { lock (BarsRequest.Made) return BarsRequest.Made.Skip(from).ToList(); }
    static BarsRequest Find(int from, Func<BarsRequest, bool> f) { return Made(from).FirstOrDefault(f); }
    static bool IsMinute(BarsRequest r) { return r.BarsPeriod != null && r.BarsPeriod.BarsPeriodType == BarsPeriodType.Minute; }
    static bool IsTrades(BarsRequest r) { return r.BarsPeriod != null && r.BarsPeriod.BarsPeriodType == BarsPeriodType.Tick && r.BarsPeriod.MarketDataType == MarketDataType.Last; }
    static Bars Answer(List<Trade> tape, int from, int to) { Bars b = new Bars(); for (int i = Math.Max(0, from); i < to; i++) b.Add(tape[i].T, tape[i].P, tape[i].P, tape[i].P, tape[i].P, tape[i].V); return b; }
    static List<double[]> Arr(string json, string key)
    {
        List<double[]> o = new List<double[]>();
        int i = json.IndexOf("\"" + key + "\":["); if (i < 0) return o;
        i += key.Length + 4;
        while (i < json.Length && json[i] == '[')
        {
            int j = json.IndexOf(']', i);
            o.Add(json.Substring(i + 1, j - i - 1).Split(',').Select(x => double.Parse(x, CultureInfo.InvariantCulture)).ToArray());
            i = j + 1; if (i < json.Length && json[i] == ',') i++;
        }
        return o;
    }
    static double Field(string json, string key) { int i = json.IndexOf("\"" + key + "\":"); int j = i + key.Length + 3, e = j; while (e < json.Length && "-0123456789.".IndexOf(json[e]) >= 0) e++; return double.Parse(json.Substring(j, e - j), CultureInfo.InvariantCulture); }
    static string SubOf(string sub) { return "\"sub\":" + sub; }

    // What a page with subscribe `sub` got, from its last "ticks" load on: the window's trades, then every tick after ready.
    // profile: the "profile" rows it got last plus every tick after that message (what the page's volume profile holds).
    class Page { public List<double[]> Trades = new List<double[]>(); public Dictionary<long, long> Profile; public bool Whole; public int Windows; }
    static Page PageOf(List<string> l, string sub, ChartBridgeClient c)
    {
        Page pg = new Page();
        int ready = l.FindIndex(x => x.StartsWith("{\"type\":\"ready\"") && x.Contains(SubOf(sub)));
        if (ready < 0) return pg;
        int loadStart = l.FindIndex(x => x.Contains(SubOf(sub) + ","));
        foreach (string x in l.Skip(loadStart).Take(ready - loadStart).Where(x => x.StartsWith("{\"type\":\"ticks\"") && x.Contains(SubOf(sub)))) pg.Trades.AddRange(Arr(x, "ticks"));
        pg.Windows = pg.Trades.Count;
        foreach (string x in l.Skip(ready + 1).Where(x => x.StartsWith("{\"type\":\"tick\""))) pg.Trades.Add(new[] { Field(x, "t"), Field(x, "p"), Field(x, "v") });
        int prof = l.FindLastIndex(x => x.StartsWith("{\"type\":\"profile\""));
        if (prof >= 0)
        {
            pg.Profile = ParseRows(l[prof], "session");
            pg.Whole = l[prof].Contains("\"session\":{\"from\"") && l[prof].IndexOf("\"whole\":true") >= 0 && l[prof].IndexOf("\"whole\":true") < l[prof].IndexOf("\"last\":");
            foreach (string x in l.Skip(prof + 1).Where(x => x.StartsWith("{\"type\":\"tick\""))) SessionTable.Add(pg.Profile, Field(x, "t"), (long)Math.Round(Field(x, "p") / 0.25), (long)Field(x, "v"));
        }
        return pg;
    }
    // The page's trades are the tape from its first trade on: each once, in order.
    static bool IsTail(List<Trade> tape, int end, List<double[]> page, out int from)
    {
        from = end - page.Count;
        if (from < 0) return false;
        for (int j = 0; j < page.Count; j++)
        {
            Trade x = tape[from + j];
            if (Math.Abs(page[j][0] - Math.Round(EtSec(x.T), 3)) > 0.0006 || Math.Abs(page[j][1] - x.P) > 1e-9 || (long)page[j][2] != x.V) return false;
        }
        return true;
    }

    // The server cases run on a simulated NinjaTrader clock: the time of the last live trade fed (so they never depend on the
    // time of day the harness runs at, nit N7). A weekday morning, market open.
    static DateTime simNow;
    static readonly DateTime SimBase = Et(2026, 9, 29, 11, 0, 0);   // Tuesday 11:00 ET
    static void Live(List<Trade> tape, int from, int to)
    {
        for (int i = from; i < to; i++)
        {
            simNow = tape[i].T;
            Priv("OnMarketData", null, new MarketDataEventArgs { Instrument = inst, MarketDataType = MarketDataType.Last, Price = tape[i].P, Volume = tape[i].V, Time = tape[i].T });
        }
    }
    static string Books() { return (string)Priv("BooksJson"); }
    static int TradesAsked(int from, Func<BarsRequest, bool> f) { return Made(from).Count(r => IsTrades(r) && f(r)); }
    static bool ByDate(BarsRequest r) { return r.BarsBack < 0; }
    static bool ByCount(BarsRequest r) { return r.BarsBack > 0 && r.BarsBack != ChartBridgeServer.SeamTicksBack; }
    static void Sub(ChartBridgeClient c, string sub, int tickHours, bool liveFirst)
    {
        Priv("OnClientMessage", c, "{\"type\":\"subscribe\",\"root\":\"MNQ\",\"days\":5,\"tickHours\":" + tickHours + ",\"sub\":" + sub + (liveFirst ? ",\"liveFirst\":true" : "") + ",\"profile\":true}");
    }
    static void AnswerMinutes(int from) { foreach (BarsRequest r in Made(from).Where(r => IsMinute(r) && !r.Answered)) r.Answer(new Bars(), ErrorCode.NoError); }
    static bool Ready(List<string> l, string sub) { return l.Any(x => x.StartsWith("{\"type\":\"ready\"") && x.Contains(SubOf(sub))); }
    static ChartBridgeClient NewClient(int id, List<string> into)
    {
        ChartBridgeClient c = new ChartBridgeClient(new PageSocket(), id);
        c.Tap = s => { lock (into) into.Add(s); };
        Clients()[id] = c;
        System.Threading.Tasks.Task.Run(() => c.SendLoop());
        return c;
    }
    static void DropClient(ChartBridgeClient c) { ChartBridgeClient g; Clients().TryRemove(c.Id, out g); c.Close(); }

    public static void Load(Action<bool, string> check, Instrument i)
    {
        Check = check; inst = i;
        client = NewClient(88, sent);
        Func<BarsRequest, bool> was = BarsRequest.AutoAnswer;
        BarsRequest.AutoAnswer = null;
        int gapWas = ChartBridgeServer.BackfillGapMs, startWas = ChartBridgeServer.BackfillStartMs, retryWas = ChartBridgeServer.BackfillRetryMs, toWas = ChartBridgeServer.BackfillTimeoutMs, wretryWas = ChartBridgeServer.WindowRetryMs;
        ChartBridgeServer.ByDateTickLoads = false;
        ChartBridgeServer.ClockForHarness = () => simNow;
        Priv("WatchFeed");
        try
        {
            ChartBridgeServer.BackfillGapMs = 0; ChartBridgeServer.BackfillRetryMs = 300; ChartBridgeServer.WindowRetryMs = 400;
            MidSession();
            BackfillWaitsAndRetries();
            Windows();
            WindowSingleFlight();
            FeedDrop();
        }
        finally
        {
            ChartBridgeServer.BackfillOn = false; ChartBridgeServer.BackfillGapMs = gapWas; ChartBridgeServer.BackfillStartMs = startWas; ChartBridgeServer.BackfillRetryMs = retryWas;
            ChartBridgeServer.BackfillTimeoutMs = toWas; ChartBridgeServer.WindowRetryMs = wretryWas;
            ChartBridgeServer.ClockForHarness = null; ChartBridgeServer.ByDateTickLoads = true;
            Priv("UnwatchFeed");
            ChartBridgeServer.ResetBooks(DateTime.MinValue);
            BarsRequest.AutoAnswer = was;
            DropClient(client);
        }
    }

    // ChartBridge starts mid-session: the table counts from its first live trade and says so; the one backfill of the session
    // so far (MNQ is in profileRoots), asked by date through the gate, is joined to the live trades by the 0.3.3 seam; the
    // page's profile is then pushed whole and equals every trade. Never asked again that session, not by page loads either.
    static void MidSession()
    {
        DateTime t0 = SimBase.AddMinutes(-30);
        DateTime ss, se; SessionClock.Bounds(t0, out ss, out se);
        List<Trade> tape = Walk(t0, 30000, 31, 50);   // about 25 minutes
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddMinutes(-1));   // listening since just before the tape: after 18:00
        ChartBridgeServer.BackfillOn = true; ChartBridgeServer.BackfillStartMs = 0;
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        Live(tape, 0, 10000);
        BarsRequest bf = null;
        Check(WaitFor(() => (bf = Find(m0, r => IsTrades(r) && ByDate(r))) != null, 3000) && bf.From == ss && TradesAsked(m0, ByDate) == 1,
            "mid-session start: one backfill of the session asked by date from its 18:00 ET start, at its first live trade");
        if (bf == null) return;
        string d0 = Books();
        Check(d0.Contains("\"whole\":false") && d0.Contains("\"state\":\"asked\"") && d0.Contains("\"now\":\"backfill MNQ\""), "mid-session start: until it comes, the table is not whole and /diag says the backfill is out");
        // A page opens a 1m chart with the profile meanwhile: no last-trades request while the backfill is out; it is live.
        Sub(client, "301", 0, false);
        AnswerMinutes(m0);
        Check(WaitFor(() => Ready(Sent(), "301")) && !Made(m0).Any(r => IsTrades(r) && r.BarsBack == ChartBridgeServer.SeamTicksBack),
            "mid-session start: a minute page goes live meanwhile, and asks NinjaTrader for no trades while the backfill is out");
        string p0 = Sent().First(x => x.StartsWith("{\"type\":\"profile\""));
        List<string> l0 = Sent();
        Check(p0.Contains("\"whole\":false") && p0.Contains("\"backfill\":\"asked\"") && l0.IndexOf(p0) < l0.FindIndex(x => x.StartsWith("{\"type\":\"ready\"")),
            "mid-session start: its profile says not whole, the backfill asked, and comes before ready");
        Live(tape, 10000, 20000);                       // the market trades on
        Bars big = Answer(tape, 0, 19000);
        System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
        bf.Answer(big, ErrorCode.NoError);              // NinjaTrader's answer ends a little before the live trades
        double callerMs = sw.Elapsed.TotalMilliseconds;
        Live(tape, 20000, 25000);
        Check(WaitFor(() => Books().Contains("\"state\":\"done\""), 5000), "mid-session start: the backfill is in");
        Live(tape, 25000, 30000);
        Thread.Sleep(80);
        RootBook book = ChartBridgeServer.BookOf("MNQ", inst);
        Dictionary<long, long> truth = Truth(tape, ss, se, 0.25);
        string diff; lock (book.Sync) diff = Diff(book.Table.Vol, truth);
        Check(book.Table.Whole && diff == null, "mid-session start: backfill and live trades joined by the seam: the table is every trade of the session, exactly (" + tape.Count.ToString("N0", CultureInfo.InvariantCulture) + " trades" + (diff != null ? "; " + diff : "") + ")");
        double cb; lock (book.Sync) cb = book.BackfillCallbackMs;
        Console.WriteLine("     (the backfill's answer: 19,000 trades; on NinjaTrader's callback thread " + cb.ToString("0.00", CultureInfo.InvariantCulture) + " ms (the copy), the whole callback returned in " + callerMs.ToString("0.00", CultureInfo.InvariantCulture) + " ms)");
        Check(cb >= 0 && Books().Contains("\"callbackMs\":"), "mid-session start: the time on NinjaTrader's callback thread is measured and in /diag (" + cb.ToString("0.00", CultureInfo.InvariantCulture) + " ms for 19,000 trades)");
        Page pg = PageOf(Sent(), "301", client);
        string pd = pg.Profile != null ? Diff(pg.Profile, truth) : "no profile";
        Check(pg.Whole && pd == null, "mid-session start: the page got the whole profile pushed, in order with its live trades: its profile equals every trade" + (pd != null ? " (" + pd + ")" : ""));
        // Never again this session: more trades, another load.
        int m1 = MadeCount();
        Sub(client, "302", 0, false);
        AnswerMinutes(m1);
        BarsRequest last = null;
        WaitFor(() => (last = Find(m1, r => IsTrades(r) && r.BarsBack == ChartBridgeServer.SeamTicksBack)) != null);
        if (last != null) last.Answer(Answer(tape, 29000, 30000), ErrorCode.NoError);
        WaitFor(() => Ready(Sent(), "302"));
        Thread.Sleep(200);
        Check(TradesAsked(m1, ByDate) == 0, "mid-session start: the backfill is never asked again that session, not for a page load either");
        ChartBridgeServer.BackfillOn = false;
    }

    // B1: the backfill waits for a window request that is out (never beside it), starts only a moment after market data
    // starts, is asked once more after an error, then given up with nothing more kept (S1); a timed out one is given up too.
    static void BackfillWaitsAndRetries()
    {
        DateTime t0 = SimBase.AddMinutes(-10);
        List<Trade> tape = Walk(t0, 6000, 51, 100);
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0));   // listening from the first trade: mid-session
        ChartBridgeServer.BackfillOn = true; ChartBridgeServer.BackfillStartMs = 20000;
        ChartBridgeServer.WindowFirstGuess = 50000;
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        Live(tape, 0, 10);                               // the backfill is wanted, but market data started 1 s ago
        Sub(client, "501", 2, true);                     // a Range page: its window request goes out first
        AnswerMinutes(m0);
        BarsRequest w = null;
        WaitFor(() => (w = Find(m0, r => IsTrades(r) && ByCount(r))) != null);
        Live(tape, 10, 2000);                            // 20 s and more pass: the backfill may start, but the window is out
        Thread.Sleep(300);
        Check(w != null && TradesAsked(m0, ByDate) == 0 && Books().Contains("\"backfillsQueued\":1"), "B1: the backfill waits while a window request is out (queued, not sent beside it)");
        if (w == null) return;
        w.Answer(Answer(tape, 0, 2000), ErrorCode.NoError);
        BarsRequest bf = null;
        Check(WaitFor(() => (bf = Find(m0, r => IsTrades(r) && ByDate(r))) != null, 3000) && WaitFor(() => Ready(Sent(), "501")), "B1: then it goes, once the window is answered (and the page is live)");
        if (bf == null) return;
        bf.Answer(null, ErrorCode.Panic);
        BarsRequest bf2 = null;
        Check(WaitFor(() => (bf2 = Made(m0).Where(r => IsTrades(r) && ByDate(r)).Skip(1).FirstOrDefault()) != null, 3000) && bf2.To <= simNow.AddSeconds(1),
            "B1: an error: asked once more after the retry delay (60 s on the trading PC), ending now");
        if (bf2 == null) return;
        Live(tape, 2000, 2100);
        bf2.Answer(new Bars(), ErrorCode.NoError);        // empty
        Thread.Sleep(800);
        RootBook book = ChartBridgeServer.BookOf("MNQ", inst);
        string state; bool live; lock (book.Sync) { state = book.BackfillState; live = book.BackfillLive != null; }
        Check(TradesAsked(m0, ByDate) == 2 && state.StartsWith("failed: ") && !live, "B1, S1: then given up with a note (\"" + state + "\"), no third ask, and no live trades kept for it");
        // A backfill NinjaTrader never answers: given up after its time limit, nothing kept, and the gate goes on to windows.
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0));
        ChartBridgeServer.BackfillStartMs = 0; ChartBridgeServer.BackfillTimeoutMs = 300;
        simNow = t0;
        int m1 = MadeCount();
        Live(tape, 0, 50);
        WaitFor(() => Find(m1, r => IsTrades(r) && ByDate(r)) != null);
        Thread.Sleep(600);
        book = ChartBridgeServer.BookOf("MNQ", inst);
        lock (book.Sync) { state = book.BackfillState; live = book.BackfillLive != null; }
        Sub(client, "502", 2, true);
        AnswerMinutes(m1);
        BarsRequest wr = null;
        Check(state.StartsWith("timed out") && !live && WaitFor(() => (wr = Find(m1, r => IsTrades(r) && ByCount(r))) != null, 3000),
            "B1: a backfill with no answer is given up after its time limit (\"" + state + "\"), nothing kept; the next window request still goes");
        if (wr != null) wr.Answer(Answer(tape, 0, 50), ErrorCode.NoError);
        WaitFor(() => Ready(Sent(), "502"));
        ChartBridgeServer.BackfillOn = false; ChartBridgeServer.BackfillTimeoutMs = 300000; ChartBridgeServer.WindowFirstGuess = 200000;
        ChartBridgeServer.ResetBooks(DateTime.MinValue);
    }

    // A Range page opens: the served window asked by count (asked once more when the answer is short, never a third time), cut
    // at rangeHours; a second page and a reload get it from ChartBridge's memory; every page has every trade once from the
    // window's start, and its profile equals every trade of the session. A page that does not ask for "liveFirst" (a 1.6.x
    // page, The Desk's relay) gets the same window (S6), never the by-date load.
    static void Windows()
    {
        DateTime t0 = SimBase.AddHours(-2.6);
        DateTime ss, se; SessionClock.Bounds(t0, out ss, out se);
        List<Trade> tape = Walk(t0, 40000, 41, 117);   // about 2.6 hours
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(ss).AddMinutes(-5));   // listening since before the session: whole
        lock (sent) sent.Clear();
        Live(tape, 0, 1);
        RootBook book = ChartBridgeServer.BookOf("MNQ", inst);
        lock (book.Sync) { book.Table.Whole = true; book.BackfillLive = null; book.BackfillState = "none"; }   // as if ChartBridge saw the session start
        Live(tape, 1, 36000);
        int m0 = MadeCount();
        ChartBridgeServer.WindowFirstGuess = 5000;       // no live rate known yet: the first guess (200,000 on the trading PC)
        Sub(client, "401", 17, true);
        Live(tape, 36000, 36100);                         // held
        AnswerMinutes(m0);
        BarsRequest w1 = null;
        WaitFor(() => (w1 = Find(m0, IsTrades)) != null);
        Check(w1 != null && ByCount(w1) && !Made(m0).Any(r => r.BarsPeriod != null && r.BarsPeriod.MarketDataType != MarketDataType.Last),
            "served window: asked by count (" + (w1 != null ? w1.BarsBack : -1) + " trades), with no Bid or Ask request");
        if (w1 == null) return;
        int n1 = w1.BarsBack;
        w1.Answer(Answer(tape, 36100 - n1, 36100), ErrorCode.NoError);   // full, not back 2 hours
        BarsRequest w2 = null;
        WaitFor(() => (w2 = Made(m0).Where(IsTrades).Skip(1).FirstOrDefault()) != null);
        Check(w2 != null && w2.BarsBack == Math.Min(ChartBridgeServer.WindowMaxTicks, n1 * 3), "served window: an answer that does not reach back " + ChartBridgeConfig.RangeHours + " hours is asked once more, for 3 times as many");
        if (w2 == null) return;
        Live(tape, 36100, 36200);
        w2.Answer(Answer(tape, 36150 - w2.BarsBack, 36150), ErrorCode.NoError);   // full and short again: no third ask
        Check(WaitFor(() => Ready(Sent(), "401")) && TradesAsked(m0, r => true) == 2, "served window: a second short answer is used as it is (two asks at most), ready");
        Live(tape, 36200, 37000);
        Thread.Sleep(50);
        List<string> l = Sent();
        Page p1 = PageOf(l, "401", client);
        int from1;
        bool tail1 = IsTail(tape, 37000, p1.Trades, out from1);
        Check(tail1 && from1 == 36150 - w2.BarsBack, "served window: the page has every trade from the answer's first on, each once and in order (" + p1.Windows + " in the window, " + (p1.Trades.Count - p1.Windows) + " live)");
        Dictionary<long, long> truth = Truth(tape.Take(37000), ss, se, 0.25);
        string pd = p1.Profile != null ? Diff(p1.Profile, truth) : "no profile";
        Check(p1.Whole && pd == null && l.FindIndex(x => x.StartsWith("{\"type\":\"profile\"")) < l.FindIndex(x => x.StartsWith("{\"type\":\"ready\"")),
            "served window: the profile, before ready and less the held trades released after it, plus every tick after equals every trade of the session" + (pd != null ? " (" + pd + ")" : ""));
        // A second page (an old-style subscribe: no liveFirst, tickHours 17), then a reload of the first: from memory.
        List<string> sent2 = new List<string>();
        ChartBridgeClient c2 = NewClient(89, sent2);
        try
        {
            int m1 = MadeCount();
            Sub(c2, "402", 17, false);
            Live(tape, 37000, 37050);
            AnswerMinutes(m1);
            Check(WaitFor(() => { lock (sent2) return Ready(sent2, "402"); }), "second page (a 1.6.x-style subscribe, no liveFirst): ready");
            Live(tape, 37050, 38000);
            Sub(client, "403", 17, true);                // the first page reloads
            Live(tape, 38000, 38020);
            AnswerMinutes(m1);
            Check(WaitFor(() => Ready(Sent(), "403")), "reload: ready");
            Live(tape, 38020, 40000);
            Thread.Sleep(50);
            Check(TradesAsked(m1, r => true) == 0, "S6, second page and reload: no trade request to NinjaTrader at all (the served window is ChartBridge's; never the by-date load)");
            List<string> l2; lock (sent2) l2 = sent2.ToList();
            Page p2 = PageOf(l2, "402", c2), p3 = PageOf(Sent(), "403", client);
            int from2, from3;
            bool tail2 = IsTail(tape, 40000, p2.Trades, out from2), tail3 = IsTail(tape, 40000, p3.Trades, out from3);
            Dictionary<long, long> all = Truth(tape, ss, se, 0.25);
            string d2 = p2.Profile != null ? Diff(p2.Profile, all) : "none", d3 = p3.Profile != null ? Diff(p3.Profile, all) : "none";
            Check(tail2 && tail3 && from2 == from1 && from3 == from1, "second page and reload: every trade once and in order, from the same first trade as the first page (so their range bars start where the first page's did)");
            Check(d2 == null && d3 == null, "second page and reload: their profiles equal every trade of the session" + (d2 != null ? " (second: " + d2 + ")" : "") + (d3 != null ? " (reload: " + d3 + ")" : ""));
            Check(Books().Contains("\"served\":3") && ((string)Priv("WindowsJson")).Contains("\"fromCache\":true"), "diag: the served window was served three times from memory, the first page included (/diag books, windows)");
        }
        finally { DropClient(c2); ChartBridgeServer.WindowFirstGuess = 200000; }
    }

    // B2: one window request per instrument at a time: pages that open while it is out, and a page that subscribes again
    // meanwhile, share it; its answer is kept though the page that asked has moved on; a failed window is not asked again on
    // every reload.
    static void WindowSingleFlight()
    {
        DateTime t0 = SimBase.AddHours(-2.2);
        List<Trade> tape = Walk(t0, 20000, 61, 400);
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));
        lock (sent) sent.Clear();
        Live(tape, 0, 18000);
        List<string> sent2 = new List<string>();
        ChartBridgeClient c2 = NewClient(90, sent2);
        try
        {
            int m0 = MadeCount();
            Sub(client, "601", 2, true);
            Sub(c2, "602", 8, false);
            AnswerMinutes(m0);
            Live(tape, 18000, 18050);
            Sub(client, "603", 2, true);                 // the first page subscribes again while the request is out
            AnswerMinutes(m0);
            Thread.Sleep(200);
            Check(TradesAsked(m0, r => true) == 1, "B2: two pages opening together and a resubscribe meanwhile: one request to NinjaTrader (" + TradesAsked(m0, r => true) + ")");
            BarsRequest w = Find(m0, IsTrades);
            if (w == null) return;
            w.Answer(Answer(tape, 0, 18040), ErrorCode.NoError);
            List<string> l2 = null;
            Check(WaitFor(() => Ready(Sent(), "603")) && WaitFor(() => { lock (sent2) { l2 = sent2.ToList(); return Ready(l2, "602"); } }) && !Ready(Sent(), "601"),
                "B2: the answer is kept and serves both pages (the one that subscribed again gets it; the superseded load sends nothing)");
            Live(tape, 18050, 18100);
            Thread.Sleep(50);
            int f1, f2;
            Check(IsTail(tape, 18100, PageOf(Sent(), "603", client).Trades, out f1) && IsTail(tape, 18100, PageOf(l2 = Sent2(sent2), "602", c2).Trades, out f2) && f1 == f2,
                "B2: both pages have every trade once from the same first trade");
            // A failed window: loads go live with none, and reloads within a minute do not ask again.
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));
            Live(tape, 18100, 18200);
            int m1 = MadeCount();
            Sub(client, "611", 2, true);
            AnswerMinutes(m1);
            BarsRequest bad = null;
            WaitFor(() => (bad = Find(m1, IsTrades)) != null);
            if (bad == null) return;
            bad.Answer(null, ErrorCode.Panic);
            Check(WaitFor(() => Ready(Sent(), "611")) && Sent().Any(x => x.Contains("Tick history failed")), "B2: a failed window: the page goes live with no trades, and says so");
            Sub(client, "612", 2, true); AnswerMinutes(m1);
            Sub(client, "613", 2, true); AnswerMinutes(m1);
            WaitFor(() => Ready(Sent(), "613"));
            Check(TradesAsked(m1, r => true) == 1, "B2: reloads right after a failure do not ask again (" + TradesAsked(m1, r => true) + " request)");
            Thread.Sleep(ChartBridgeServer.WindowRetryMs + 100);
            Sub(client, "614", 2, true); AnswerMinutes(m1);
            Check(WaitFor(() => TradesAsked(m1, r => true) == 2, 2000), "B2: after the retry delay (a minute on the trading PC) the next load asks again");
            BarsRequest again = Made(m1).Where(IsTrades).Skip(1).FirstOrDefault();
            if (again != null) again.Answer(Answer(tape, 0, 18200), ErrorCode.NoError);
            WaitFor(() => Ready(Sent(), "614"));
        }
        finally { DropClient(c2); }
    }
    static List<string> Sent2(List<string> l) { lock (l) return l.ToList(); }

    // S2: the data connection drops: the table is not whole any more (for the rest of the session), the served window is
    // dropped, the live page gets the profile again with the drop in it, and the next load asks NinjaTrader for its window.
    static void FeedDrop()
    {
        DateTime t0 = SimBase.AddHours(-2.2);
        DateTime ss, se; SessionClock.Bounds(t0, out ss, out se);
        List<Trade> tape = Walk(t0, 12000, 71, 600);
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(ss).AddMinutes(-5));
        lock (sent) sent.Clear();
        Live(tape, 0, 1);
        RootBook book = ChartBridgeServer.BookOf("MNQ", inst);
        lock (book.Sync) { book.Table.Whole = true; book.BackfillLive = null; book.BackfillState = "none"; }
        Live(tape, 1, 10000);
        int m0 = MadeCount();
        Sub(client, "701", 2, true);
        AnswerMinutes(m0);
        BarsRequest w = null;
        WaitFor(() => (w = Find(m0, IsTrades)) != null);
        if (w == null) return;
        w.Answer(Answer(tape, 0, 10000), ErrorCode.NoError);
        WaitFor(() => Ready(Sent(), "701"));
        Live(tape, 10000, 10500);
        Connection.FirePrice(new Connection { Status = ConnectionStatus.Connected }, ConnectionStatus.Connected, ConnectionStatus.ConnectionLost);
        Thread.Sleep(100);
        string prof = Sent().LastOrDefault(x => x.StartsWith("{\"type\":\"profile\""));
        bool whole, cache; lock (book.Sync) { whole = book.Table.Whole; cache = book.Cache != null; }
        Check(!whole && !cache && prof != null && prof.Contains("\"drop\":{") && prof.Contains("\"whole\":false") && Books().Contains("\"drop\":\"the data connection went ConnectionLost"),
            "S2: a feed drop: the table is not whole, the served window is dropped, and the live page gets the profile with the drop");
        Live(tape, 11000, 11500);                         // back, with a gap of trades never seen
        int m1 = MadeCount();
        Sub(client, "702", 2, true);
        AnswerMinutes(m1);
        BarsRequest w2 = null;
        Check(WaitFor(() => (w2 = Find(m1, IsTrades)) != null), "S2: the next load asks NinjaTrader for its window again (its history fills the gap)");
        if (w2 != null) w2.Answer(Answer(tape, 0, 11500), ErrorCode.NoError);
        WaitFor(() => Ready(Sent(), "702"));
        List<string> l = Sent();
        int r2 = l.FindIndex(x => x.StartsWith("{\"type\":\"ready\"") && x.Contains(SubOf("702")));
        string p2 = l.Take(r2).LastOrDefault(x => x.StartsWith("{\"type\":\"profile\""));
        Check(p2 != null && p2.Contains("\"whole\":false") && p2.Contains("\"drop\":{"), "S2: and a reload's profile still says not whole, with the drop (never whole again this session)");
        ChartBridgeServer.ResetBooks(DateTime.MinValue);
    }

    class PageSocket : System.Net.WebSockets.WebSocket
    {
        public double ChunkUs, TickUs; public Action<string> OnGot;
        public int Chunks, Ticks; public double MaxLagMs;
        public readonly List<double> Lags = new List<double>(), Quiet = new List<double>();   // live trade waits while the history comes, and with none coming
        public volatile bool Filling;
        public override System.Net.WebSockets.WebSocketCloseStatus? CloseStatus { get { return null; } }
        public override string CloseStatusDescription { get { return null; } }
        public override System.Net.WebSockets.WebSocketState State { get { return System.Net.WebSockets.WebSocketState.Open; } }
        public override string SubProtocol { get { return null; } }
        public override void Abort() { }
        public override System.Threading.Tasks.Task CloseAsync(System.Net.WebSockets.WebSocketCloseStatus s, string d, CancellationToken c) { return System.Threading.Tasks.Task.FromResult(0); }
        public override System.Threading.Tasks.Task CloseOutputAsync(System.Net.WebSockets.WebSocketCloseStatus s, string d, CancellationToken c) { return System.Threading.Tasks.Task.FromResult(0); }
        public override void Dispose() { }
        public override System.Threading.Tasks.Task<System.Net.WebSockets.WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> b, CancellationToken c) { return new System.Threading.Tasks.TaskCompletionSource<System.Net.WebSockets.WebSocketReceiveResult>().Task; }
        public override System.Threading.Tasks.Task SendAsync(ArraySegment<byte> b, System.Net.WebSockets.WebSocketMessageType t, bool end, CancellationToken c)
        {
            c.ThrowIfCancellationRequested();
            string text = System.Text.Encoding.UTF8.GetString(b.Array, b.Offset, b.Count);
            bool chunk = text.StartsWith("{\"type\":\"olderTicks\"");
            if (chunk && OnGot != null) OnGot(text);          // the page asks for the next one as this one arrives
            double us = chunk ? ChunkUs : TickUs;
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew(); while (sw.Elapsed.TotalMilliseconds < us / 1000.0) { }
            if (chunk) { Chunks++; if (text.Contains("\"done\":true")) Filling = false; }
            else if (text.StartsWith("{\"type\":\"tick\""))
            {
                Ticks++;
                double lag = ChartBridgeTime.NowUtcMs() - Field(text, "rx");
                lock (Lags) { if (Filling) { Lags.Add(lag); if (lag > MaxLagMs) MaxLagMs = lag; } else Quiet.Add(lag); }
            }
            return System.Threading.Tasks.Task.FromResult(0);
        }
    }

}
