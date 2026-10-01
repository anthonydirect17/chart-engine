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
        foreach (Trade x in trades) lock (book.Sync) book.OnTrade(x.T, x.P, x.V, EtSec(x.T), listeningUtc, listeningUtc, 0, DateTime.MinValue, true);
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
        lock (book.Sync) book.OnTrade(fri[fri.Count - 1].T, 1, 7, EtSec(fri[fri.Count - 1].T), listening, listening, 0, DateTime.MinValue, true);
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
        Func<DateTime, DateTime, RootBook> first = (listening, t) => { RootBook b = new RootBook("MNQ", 0.25); lock (b.Sync) b.OnTrade(t, 20000, 1, EtSec(t), listening, listening, 0, t, true); return b; };
        RootBook a = first(ChartBridgeTime.ToUtc(s0).AddMinutes(-30), s0);
        RootBook b2 = first(ChartBridgeTime.ToUtc(s0).AddHours(3), s0.AddHours(3));
        RootBook c = first(ChartBridgeTime.ToUtc(s0).AddMinutes(-30), s0.AddMinutes(15));
        RootBook d = first(DateTime.MinValue, s0.AddHours(3));
        Check(a.Table.Whole && a.BackfillLive == null && a.BackfillState == "none", "whole: ChartBridge listening before 18:00 and the session's first trade at the start");
        Check(!b2.Table.Whole && b2.BackfillLive != null && b2.BackfillState == "wanted" && Math.Abs(b2.Table.CoveredFromEt - EtSec(s0.AddHours(3))) < 0.001,
            "not whole: ChartBridge started mid-session; the table counts from its first live trade and one backfill is wanted");
        Check(c.Table.Whole && c.BackfillState == "none", "review 3 S-A: whole though the first trade comes 15 minutes after 18:00 (ChartBridge and the feed were up before it): no backfill");
        Check(!d.Table.Whole, "not whole: not yet listening to market data");
        RootBook e = first(ChartBridgeTime.ToUtc(s0).AddMinutes(-30), s0.AddSeconds(45)), f = first(ChartBridgeTime.ToUtc(s0).AddMinutes(-30), s0.AddSeconds(90));
        Check(e.Table.Whole && f.Table.Whole, "whole however late the first trade (45 s, 90 s)");
        // the feed down across 18:00 (ChartBridge running): not whole, says so, and no backfill (only a start after 18:00 has one)
        RootBook fd = new RootBook("MNQ", 0.25);
        DateTime listen = ChartBridgeTime.ToUtc(s0).AddMinutes(-30), upAt = ChartBridgeTime.ToUtc(s0).AddMinutes(4);
        lock (fd.Sync) fd.OnTrade(s0.AddMinutes(4), 20000, 1, EtSec(s0.AddMinutes(4)), listen, upAt, 0, s0.AddMinutes(4), true);
        Check(!fd.Table.Whole && fd.Table.Dropped && fd.BackfillLive == null && fd.BackfillState.StartsWith("none (the feed was down"),
            "review 3 S-A: the feed down across 18:00 with ChartBridge running: not whole, marked as a drop at the start, no backfill (" + fd.BackfillState + ")");
        RootBook g = new RootBook("MES", 0.25);
        lock (g.Sync) g.OnTrade(s0.AddHours(3), 5000, 1, EtSec(s0.AddHours(3)), ChartBridgeTime.ToUtc(s0).AddHours(3), ChartBridgeTime.ToUtc(s0).AddHours(3), 0, s0.AddHours(3), false);
        Check(!g.Table.Whole && g.BackfillLive == null && g.BackfillState == "none (not in profileRoots)", "an instrument not in profileRoots: no backfill, the table counts from its first live trade (" + g.BackfillState + ")");
        // S7: a trade far older than the clock (NinjaTrader's snapshot of the last trade when market data starts) opens no table
        RootBook h = new RootBook("MNQ", 0.25);
        DateTime fri = Et(2026, 9, 25, 16, 59, 58);
        lock (h.Sync) h.OnTrade(fri, 20000, 1, EtSec(fri), ChartBridgeTime.ToUtc(fri).AddHours(40), ChartBridgeTime.ToUtc(fri).AddHours(40), 0, fri.AddHours(40), true);
        Check(h.Table == null && h.StaleTrades == 1 && h.BackfillState == "none", "S7: a stale last trade at start (Friday 16:59:58 seen on Sunday) opens no session and wants no backfill");
        // S1: a backfill that waits too long stops keeping live trades
        RootBook k = first(ChartBridgeTime.ToUtc(s0).AddHours(3), s0.AddHours(3));
        lock (k.Sync) for (int i = 0; i < RootBook.LiveCap + 10; i++) k.OnTrade(s0.AddHours(3).AddMilliseconds(i), 20000, 1, EtSec(s0.AddHours(3)), ChartBridgeTime.ToUtc(s0).AddHours(3), ChartBridgeTime.ToUtc(s0).AddHours(3), 0, DateTime.MinValue, true);
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
        int gapWas = ChartBridgeServer.BackfillGapMs, startWas = ChartBridgeServer.BackfillStartMs, retryWas = ChartBridgeServer.BackfillRetryMs, toWas = ChartBridgeServer.BackfillTimeoutMs, wretryWas = ChartBridgeServer.WindowRetryMs, wtoWas = ChartBridgeServer.WindowTimeoutMs;
        ChartBridgeServer.ByDateTickLoads = false;
        ChartBridgeServer.ClockForHarness = () => simNow;
        Priv("WatchFeed");
        Dictionary<string, Instrument> named = (Dictionary<string, Instrument>)typeof(ChartBridgeServer).GetField("Instruments", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
        bool hadNq = named.ContainsKey("NQ"), hadEs = named.ContainsKey("ES");
        if (!hadNq) named["NQ"] = NqInst;
        if (!hadEs) named["ES"] = EsInst;
        // Every stand-in page's SendLoop holds a pool thread while it waits on its queue, and the reconnect storm opens 10 at
        // once: with Mono's slow thread injection a load's continuations could run seconds late and the storm case failed
        // (2 runs in 11; 1 in 4 still with the gate's worker on its own thread). Enough threads up front; set back after.
        int minWorkers, minIo; ThreadPool.GetMinThreads(out minWorkers, out minIo);
        ThreadPool.SetMinThreads(Math.Max(minWorkers, 64), minIo);
        try
        {
            ChartBridgeServer.BackfillGapMs = 0; ChartBridgeServer.BackfillRetryMs = 300; ChartBridgeServer.WindowRetryMs = 400;
            MidSession();
            BackfillWaitsAndRetries();
            GateAfterTimeout();
            StuckStrandsNothing();
            WindowCap();
            TimeoutRace();
            Counts();
            RetryStuck();
            CopyNeverEnds();
            AnsweredWhileMarking();
            StopEndsGate();
            StopRound2();
            StopLoad();
            StopLate();
            StopShortWait();
            BackfillOrderAndRound2();
            ClosedMarketDrop();
            Windows();
            WindowSingleFlight();
            FeedDrop();
        }
        finally
        {
            ChartBridgeServer.BackfillOn = false; ChartBridgeServer.BackfillGapMs = gapWas; ChartBridgeServer.BackfillStartMs = startWas; ChartBridgeServer.BackfillRetryMs = retryWas;
            ChartBridgeServer.BackfillTimeoutMs = toWas; ChartBridgeServer.WindowRetryMs = wretryWas; ChartBridgeServer.WindowTimeoutMs = wtoWas;
            ChartBridgeServer.ClockForHarness = null; ChartBridgeServer.ByDateTickLoads = true;
            Priv("UnwatchFeed");
            if (!hadNq) named.Remove("NQ");
            if (!hadEs) named.Remove("ES");
            ChartBridgeServer.StopGate();   // review 5 N6: the gate's worker ends and its retry timers go before the process exits
            ThreadPool.SetMinThreads(minWorkers, minIo);
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
        // A backfill NinjaTrader does not answer in time: given up, nothing kept; it stays outstanding (X1), so a page's window
        // is not asked beside it (the page goes live without one); its late answer is dropped and the gate goes on.
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0));
        ChartBridgeServer.BackfillStartMs = 0; ChartBridgeServer.BackfillTimeoutMs = 300;
        simNow = t0;
        int m1 = MadeCount();
        Live(tape, 0, 50);
        BarsRequest late = null;
        WaitFor(() => (late = Find(m1, r => IsTrades(r) && ByDate(r))) != null);
        Thread.Sleep(600);
        book = ChartBridgeServer.BookOf("MNQ", inst);
        lock (book.Sync) { state = book.BackfillState; live = book.BackfillLive != null; }
        Sub(client, "502", 2, true);
        AnswerMinutes(m1);
        Check(state.StartsWith("timed out") && !live && WaitFor(() => Ready(Sent(), "502"), 3000) && TradesAsked(m1, ByCount) == 0,
            "B1, X1: a backfill with no answer is given up after its time limit (\"" + state + "\"), nothing kept; while it is still out no window goes beside it (the page goes live without one)");
        if (late != null) late.Answer(Answer(tape, 0, 50), ErrorCode.NoError);
        Sub(client, "503", 2, true);
        AnswerMinutes(m1);
        BarsRequest wr = null;
        Check(WaitFor(() => (wr = Find(m1, r => IsTrades(r) && ByCount(r))) != null, 3000), "X1: once NinjaTrader answers it (the answer dropped), the next window goes");
        if (wr != null) wr.Answer(Answer(tape, 0, 50), ErrorCode.NoError);
        WaitFor(() => Ready(Sent(), "503"));
        ChartBridgeServer.BackfillOn = false; ChartBridgeServer.BackfillTimeoutMs = 300000; ChartBridgeServer.WindowFirstGuess = 200000;
        ChartBridgeServer.ResetBooks(DateTime.MinValue);
    }

    static void SubOn(ChartBridgeClient c, string root, string sub, int tickHours)
    {
        Priv("OnClientMessage", c, "{\"type\":\"subscribe\",\"root\":\"" + root + "\",\"days\":5,\"tickHours\":" + tickHours + ",\"sub\":" + sub + (tickHours > 0 ? ",\"liveFirst\":true" : "") + ",\"profile\":true}");
    }
    static string Gate() { return System.Text.RegularExpressions.Regex.Match(Books(), "\"gate\":\\{[^}]*\\}").Value; }
    static bool IsWin(BarsRequest r) { return IsTrades(r) && ByCount(r); }

    // Review 4 B1 (the reviewer's "queued"), S2 ("bfstuck"), S4 ("gapstuck") and S3 ("mixed"): while a request is stuck at
    // NinjaTrader nothing waits on it. A window queued behind it is answered at once (its page goes live with no trades and
    // says why), and so is every later load; a load of an instrument with a served window gets it (with its gap, if any);
    // queued backfills say they wait (not "building") and run once NinjaTrader answers. A minute chart is never held up.
    static void StuckStrandsNothing()
    {
        DateTime t0 = SimBase.AddMinutes(-20);
        List<Trade> mnq = Walk(t0, 4000, 101, 100), nq = Walk(t0, 4000, 102, 100);
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddMinutes(-1));   // a start after 18:00: backfills wanted
        ChartBridgeServer.BackfillOn = true; ChartBridgeServer.BackfillStartMs = 3600000;   // the backfills stay queued here
        ChartBridgeServer.WindowTimeoutMs = 300; ChartBridgeServer.WindowFirstGuess = 5000;
        List<string> sa = new List<string>(), sb = new List<string>(), sc = new List<string>(), sd = new List<string>();
        ChartBridgeClient a = NewClient(931, sa), b = NewClient(932, sb), c = NewClient(933, sc), d = NewClient(934, sd);
        try
        {
            int m0 = MadeCount();
            LiveOn(inst, mnq, 0, 50); LiveOn(NqInst, nq, 0, 50);
            // an MNQ page with its window served first (it has a served window from then on), then a feed drop (a gap in it)
            SubOn(a, "MNQ", "1", 2); AnswerMinutes(m0);
            BarsRequest wa = null;
            WaitFor(() => (wa = Find(m0, r => IsWin(r) && RootOfReq(r) == "MNQ")) != null);
            if (wa != null) wa.Answer(Answer(mnq, 0, 50), ErrorCode.NoError);
            WaitFor(() => { lock (sa) return Ready(sa, "1"); });
            Connection.FirePrice(new Connection { Status = ConnectionStatus.Connected }, ConnectionStatus.Connected, ConnectionStatus.ConnectionLost);
            Thread.Sleep(100);
            LiveOn(inst, mnq, 50, 100); LiveOn(NqInst, nq, 50, 100);
            // an NQ page: its window times out and stays at NinjaTrader; an ES page's window was queued behind it
            SubOn(b, "NQ", "1", 2); SubOn(c, "ES", "1", 2); AnswerMinutes(m0);
            BarsRequest wn = null;
            WaitFor(() => (wn = Find(m0, r => IsWin(r) && RootOfReq(r) == "NQ")) != null);
            Check(WaitFor(() => { lock (sb) return Ready(sb, "1"); }, 3000) && WaitFor(() => { lock (sc) return Ready(sc, "1"); }, 3000) && !Made(m0).Any(r => IsWin(r) && RootOfReq(r) == "ES"),
                "review 4 B1: a window queued behind a stuck request is answered at once: its page goes live with no trades (no ES request went out)");
            string esNote; lock (sc) esNote = sc.FirstOrDefault(x => x.Contains("\"status\"")) ?? "";
            Check(esNote.Contains("has not answered an earlier tick request (window NQ)") && esNote.Contains("until it does or NinjaTrader restarts"), "review 4 B1, S5: and says why and until when: " + esNote);
            // later loads never wait either: an NQ reload and a new ES page are live at once
            SubOn(b, "NQ", "2", 2); SubOn(d, "ES", "2", 2); AnswerMinutes(m0);
            Check(WaitFor(() => { lock (sb) return Ready(sb, "2"); }, 2000) && WaitFor(() => { lock (sd) return Ready(sd, "2"); }, 2000), "review 4 B1: later loads while it is stuck go live at once too");
            // review 4 S4: an MNQ reload (its served window has a gap): served the window with its gap, not thrown away
            int trades0; lock (sa) trades0 = sa.Count;
            SubOn(a, "MNQ", "2", 2); AnswerMinutes(m0);
            WaitFor(() => { lock (sa) return Ready(sa, "2"); }, 2000);
            List<string> la; lock (sa) la = sa.Skip(trades0).ToList();
            int nTicks = la.Where(x => x.StartsWith("{\"type\":\"ticks\"")).Sum(x => Arr(x, "ticks").Count);
            Check(nTicks >= 100 && !la.Any(x => x.Contains("Tick history failed")), "review 4 S4: a load with a gapped served window while stuck gets that window (" + nTicks + " trades), not nothing");
            // review 4 S2: the queued backfills say they wait, not "building"
            string st = Books();
            Check(st.Contains("\"state\":\"waiting: NinjaTrader has not answered an earlier tick request (window NQ)\"") && !st.Contains("\"state\":\"queued\""), "review 4 S2: queued backfills wait, and say so (not building)");
            // review 4 S3: a minute chart is not held up (its last-trades request is skipped while stuck)
            SubOn(d, "ES", "3", 0); AnswerMinutes(m0);
            Check(WaitFor(() => { lock (sd) return Ready(sd, "3"); }, 2000), "review 4 S3: a minute page is live while the gate is stuck");
            // NinjaTrader answers at last: the answer is dropped, the backfills are queued again, loads ask again
            if (wn != null) wn.Answer(Answer(nq, 0, 100), ErrorCode.NoError);
            Thread.Sleep(200);
            SubOn(c, "ES", "3", 2); AnswerMinutes(m0);
            Check(!Books().Contains("waiting:") && Gate().Contains("\"stuck\":null") && WaitFor(() => Find(m0, r => IsWin(r) && RootOfReq(r) == "ES") != null, 3000),
                "review 4 S2: once NinjaTrader answers, the backfills are queued again and the next ES load asks for its window");
            BarsRequest we = Find(m0, r => IsWin(r) && RootOfReq(r) == "ES");
            if (we != null) we.Answer(Answer(nq, 0, 100), ErrorCode.NoError);
            WaitFor(() => { lock (sc) return Ready(sc, "3"); });
        }
        finally { DropClient(a); DropClient(b); DropClient(c); DropClient(d); }
        // review 4 S3 ("mixed"): minute charts' last-trades requests (20,000 by count, as since 0.3.3) are not queued behind a window
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));
        ChartBridgeServer.BackfillOn = false;
        List<string> se = new List<string>(), sf = new List<string>();
        ChartBridgeClient e = NewClient(935, se), f = NewClient(936, sf);
        try
        {
            simNow = t0;
            int m1 = MadeCount();
            LiveOn(inst, mnq, 0, 20); LiveOn(EsInst, nq, 0, 20);
            SubOn(e, "MNQ", "1", 2); SubOn(f, "ES", "1", 0);
            foreach (BarsRequest r in Made(m1).Where(r => IsMinute(r) && !r.Answered)) { Bars bb = new Bars(); bb.Add(simNow.AddSeconds(-30), 20000, 20000, 20000, 20000, 5); r.Answer(bb, ErrorCode.NoError); }
            Check(WaitFor(() => Find(m1, r => IsTrades(r) && r.BarsBack == ChartBridgeServer.SeamTicksBack) != null && Find(m1, IsWin) != null, 2000),
                "review 4 S3: a minute chart's last-trades request is not queued behind a window (unchanged since 0.3.3)");
            foreach (BarsRequest r in Made(m1).Where(r => IsTrades(r) && !r.Answered)) r.Answer(Answer(mnq, 0, 20), ErrorCode.NoError);
            WaitFor(() => { lock (se) return Ready(se, "1"); });
        }
        finally { DropClient(e); DropClient(f); }
        ChartBridgeServer.BackfillOn = false; ChartBridgeServer.BackfillStartMs = 0; ChartBridgeServer.WindowTimeoutMs = 120000; ChartBridgeServer.WindowFirstGuess = 200000;
        ChartBridgeServer.ResetBooks(DateTime.MinValue);
    }

    // Review 4 B2 (the reviewer's "cap"): a window whose live trades pass the cap while it is out answers its loads (no trades)
    // and frees the instrument: the next load asks again.
    static void WindowCap()
    {
        DateTime t0 = SimBase.AddMinutes(-10);
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));
        ChartBridgeServer.WindowFirstGuess = 5000;
        List<string> sa = new List<string>(), sb = new List<string>();
        ChartBridgeClient a = NewClient(941, sa), b = NewClient(942, sb);
        try
        {
            int m0 = MadeCount();
            LiveOn(NqInst, Walk(t0, 10, 111, 100), 0, 10);
            SubOn(a, "NQ", "1", 2); AnswerMinutes(m0);
            BarsRequest w = null;
            WaitFor(() => (w = Find(m0, IsWin)) != null);
            MethodInfo md = typeof(ChartBridgeServer).GetMethod("OnMarketData", BindingFlags.NonPublic | BindingFlags.Static);
            for (int k = 0; k < RootBook.LiveCap + 5; k++) { simNow = simNow.AddMilliseconds(2); md.Invoke(null, new object[] { null, new MarketDataEventArgs { Instrument = NqInst, MarketDataType = MarketDataType.Last, Price = 20000, Volume = 1, Time = simNow } }); }
            bool rdy = WaitFor(() => { lock (sa) return Ready(sa, "1"); }, 3000) && WaitFor(() => a.Ready, 30000);   // its held trades are tapped one by one
            Check(rdy && a.Pending.Count == 0 && Books().Contains("\"windowAsk\":{\"asking\":false"),
                "review 4 B2: past " + RootBook.LiveCap.ToString("N0", CultureInfo.InvariantCulture) + " live trades while the window was out, its page goes live (no trades held) and the instrument is freed");
            if (w != null) w.Answer(Answer(Walk(t0, 100, 112, 100), 0, 100), ErrorCode.NoError);   // the answer, late: not used
            SubOn(b, "NQ", "1", 2); AnswerMinutes(m0);
            BarsRequest w2 = null;
            Check(WaitFor(() => (w2 = Made(m0).Where(IsWin).Skip(1).FirstOrDefault()) != null, 3000), "review 4 B2: a new NQ page afterwards asks for its window again");
            if (w2 != null) w2.Answer(Answer(Walk(simNow.AddMinutes(-5), 100, 113, 100), 0, 100), ErrorCode.NoError);
            Check(WaitFor(() => { lock (sb) return Ready(sb, "1"); }, 3000), "review 4 B2: and loads");
        }
        finally { DropClient(a); DropClient(b); ChartBridgeServer.WindowFirstGuess = 200000; ChartBridgeServer.ResetBooks(DateTime.MinValue); }
    }

    // Review 4 S1 (the reviewer's "race"): an answer whose copy is still running when the time limit passes. The request is
    // claimed once: whichever wins, the gate is never left stuck after NinjaTrader answered. Run at several moments near the limit.
    static void TimeoutRace()
    {
        DateTime t0 = SimBase.AddMinutes(-10);
        ChartBridgeServer.WindowTimeoutMs = 300; ChartBridgeServer.WindowFirstGuess = 3000000;
        List<Trade> big = Walk(SimBase.AddHours(-1.9), 1500000, 121, 3);
        Bars bigBars = Answer(big, 0, big.Count);
        string bad = null; int runs = 0;
        foreach (int at in new[] { 240, 270, 285, 295, 305 })
        {
            simNow = big[big.Count - 1].T;
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));
            List<string> sa = new List<string>(), sb = new List<string>();
            ChartBridgeClient a = NewClient(951, sa), b = NewClient(952, sb);
            try
            {
                int m0 = MadeCount();
                SubOn(a, "MNQ", "1", 2); AnswerMinutes(m0);
                BarsRequest w = null;
                System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
                WaitFor(() => (w = Find(m0, IsWin)) != null, 2000);
                if (w == null) { bad = "no window"; break; }
                Thread.Sleep(Math.Max(0, at - (int)sw.ElapsedMilliseconds));
                w.Answer(bigBars, ErrorCode.NoError);
                WaitFor(() => { lock (sa) return Ready(sa, "1"); }, 5000);
                Thread.Sleep(200);
                if (!Gate().Contains("\"stuck\":null")) { bad = "answered at " + at + " ms: " + Gate(); break; }
                SubOn(b, "NQ", "1", 2); AnswerMinutes(m0);
                if (!WaitFor(() => Find(m0, r => IsWin(r) && RootOfReq(r) == "NQ") != null, 2000)) { bad = "answered at " + at + " ms: the next window did not go out"; break; }
                BarsRequest wn = Find(m0, r => IsWin(r) && RootOfReq(r) == "NQ");
                wn.Answer(Answer(big, big.Count - 100, big.Count), ErrorCode.NoError);
                WaitFor(() => { lock (sb) return Ready(sb, "1"); });
                runs++;
            }
            finally { DropClient(a); DropClient(b); }
        }
        Check(bad == null, "review 4 S1: an answer at the time limit (a 1.5 M trade copy racing the timeout, " + runs + " runs): the gate is never left stuck, the next window goes" + (bad != null ? " (" + bad + ")" : ""));
        ChartBridgeServer.WindowTimeoutMs = 120000; ChartBridgeServer.WindowFirstGuess = 200000;
        ChartBridgeServer.ResetBooks(DateTime.MinValue);
    }

    static void LiveOn(Instrument i, List<Trade> tape, int from, int to)
    {
        for (int k = from; k < to; k++)
        {
            simNow = tape[k].T;
            Priv("OnMarketData", null, new MarketDataEventArgs { Instrument = i, MarketDataType = MarketDataType.Last, Price = tape[k].P, Volume = tape[k].V, Time = tape[k].T });
        }
    }
    static readonly Instrument NqInst = new Instrument { FullName = "NQ 12-26", MasterInstrument = new MasterInstrument { Name = "NQ", TickSize = 0.25, PointValue = 20 } };
    static readonly Instrument EsInst = new Instrument { FullName = "ES 12-26", MasterInstrument = new MasterInstrument { Name = "ES", TickSize = 0.25, PointValue = 50 } };
    static string RootOfReq(BarsRequest r) { return r.Instrument != null && r.Instrument.MasterInstrument != null ? r.Instrument.MasterInstrument.Name : "?"; }

    // X1 (review 3, the reviewer's "wintimeout"): a window NinjaTrader does not answer in time is given up, but it stays
    // outstanding: no backfill and no second window go out beside it, and its late answer is dropped without a copy.
    static void GateAfterTimeout()
    {
        DateTime t0 = SimBase.AddMinutes(-30);
        List<Trade> tape = Walk(t0, 6000, 81, 100);
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddMinutes(-1));   // a start after 18:00: a backfill is wanted
        ChartBridgeServer.BackfillOn = true; ChartBridgeServer.BackfillStartMs = 0;
        ChartBridgeServer.WindowTimeoutMs = 300; ChartBridgeServer.WindowFirstGuess = 50000;
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        Sub(client, "801", 2, true);                     // the page first: its window goes out, then the backfill is wanted
        AnswerMinutes(m0);
        BarsRequest w = null;
        WaitFor(() => (w = Find(m0, r => IsTrades(r) && ByCount(r))) != null);
        Live(tape, 0, 500);
        Check(WaitFor(() => Ready(Sent(), "801"), 3000) && Sent().Any(x => x.Contains("Tick history failed")), "X1: a window with no answer in time: the page goes live without it, and says so");
        Thread.Sleep(ChartBridgeServer.WindowRetryMs + 100);
        Sub(client, "802", 2, true); AnswerMinutes(m0);
        WaitFor(() => Ready(Sent(), "802"), 3000);
        Live(tape, 500, 800);
        Thread.Sleep(300);
        Check(w != null && TradesAsked(m0, ByDate) == 0 && TradesAsked(m0, ByCount) == 1 && Books().Contains("\"stuck\":\"window MNQ\""),
            "X1: while it is still at NinjaTrader, no backfill goes out and no second window, not even for a reload after the retry delay (/diag gate stuck)");
        if (w == null) return;
        RootBook book = ChartBridgeServer.BookOf("MNQ", inst);
        w.Answer(Answer(tape, 0, 800), ErrorCode.NoError);   // the late answer
        double cb; lock (book.Sync) cb = book.WindowCallbackMs;
        BarsRequest bf = null;
        Check(cb < 0 && !Books().Contains("\"stuck\":\"window") && WaitFor(() => (bf = Find(m0, r => IsTrades(r) && ByDate(r))) != null, 3000),
            "X1: its late answer is dropped at once (not copied: no callback time), and then the queued backfill goes");
        if (bf != null) bf.Answer(Answer(tape, 0, 800), ErrorCode.NoError);
        WaitFor(() => Books().Contains("\"state\":\"done\""), 3000);
        ChartBridgeServer.BackfillOn = false; ChartBridgeServer.WindowTimeoutMs = 120000; ChartBridgeServer.WindowFirstGuess = 200000;
        ChartBridgeServer.ResetBooks(DateTime.MinValue);
    }

    // S-E: the backfills wait for the feed to be up a while (BackfillStartMs from the first live trade) and go in profileRoots
    // order (MNQ, NQ, ES), whatever order the first trades came in. S-D: a window's second ask goes before a queued backfill.
    // Review 4 "counts": the tick requests NinjaTrader gets after a mid-session start with two Range pages (MNQ, NQ) open
    // before the backfills: the two windows, then the backfills in profileRoots order, never two out at once. Then a
    // reconnect storm: 10 MNQ pages subscribing twice each, one window in all.
    static void Counts()
    {
        DateTime t0 = SimBase.AddMinutes(-10);
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddMinutes(-1));
        ChartBridgeServer.BackfillOn = true; ChartBridgeServer.BackfillStartMs = 0; ChartBridgeServer.WindowFirstGuess = 1000;
        List<Trade> mnq = Walk(t0, 20, 131, 100), nq = Walk(t0, 20, 132, 100), es = Walk(t0, 20, 133, 100);
        List<string> sa = new List<string>(), sb = new List<string>();
        ChartBridgeClient a = NewClient(951, sa), b = NewClient(952, sb);
        List<ChartBridgeClient> storm = new List<ChartBridgeClient>();
        try
        {
            int m0 = MadeCount();
            SubOn(a, "MNQ", "1", 2); SubOn(b, "NQ", "1", 2); AnswerMinutes(m0);
            WaitFor(() => TradesAsked(m0, r => true) >= 1);
            LiveOn(inst, mnq, 0, 20); LiveOn(NqInst, nq, 0, 20); LiveOn(EsInst, es, 0, 20);   // the backfills are wanted now
            int maxOut = 0; List<string> order = new List<string>();
            for (int k = 0; k < 10; k++)
            {
                BarsRequest r = null;
                if (!WaitFor(() => (r = Made(m0).FirstOrDefault(x => IsTrades(x) && !x.Answered)) != null, 1500)) break;
                Thread.Sleep(30);   // anything else that would go out meanwhile
                maxOut = Math.Max(maxOut, Made(m0).Count(x => IsTrades(x) && !x.Answered));
                string root = RootOfReq(r);
                order.Add((ByCount(r) ? "window " : "backfill ") + root);
                List<Trade> tp = root == "MNQ" ? mnq : root == "NQ" ? nq : es;
                r.Answer(Answer(tp, 0, tp.Count), ErrorCode.NoError);
            }
            AnswerMinutes(m0);
            string got = string.Join(", ", order.ToArray());
            Check(got == "window MNQ, window NQ, backfill MNQ, backfill NQ, backfill ES" && maxOut == 1,
                "review 4 counts: a mid-session start with two Range pages: " + got + "; at most " + maxOut + " out at once");
            Check(WaitFor(() => { lock (sa) lock (sb) return Ready(sa, "1") && Ready(sb, "1"); }), "review 4 counts: both pages load");
            ChartBridgeServer.BackfillOn = false;
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));
            int m1 = MadeCount();
            LiveOn(inst, mnq, 0, 5);
            for (int k = 0; k < 10; k++) { List<string> l = new List<string>(); storm.Add(NewClient(960 + k, l)); SubOn(storm[k], "MNQ", "1", 2); }
            AnswerMinutes(m1);
            Thread.Sleep(100);
            int during = TradesAsked(m1, r => true);
            BarsRequest w = null;
            if (WaitFor(() => (w = Find(m1, IsWin)) != null)) w.Answer(Answer(mnq, 0, 5), ErrorCode.NoError);
            Thread.Sleep(200);
            foreach (ChartBridgeClient c in storm) SubOn(c, "MNQ", "2", 2);
            AnswerMinutes(m1);
            Check(WaitFor(() => storm.All(c => c.Ready)) && during == 1 && TradesAsked(m1, r => true) == 1,
                "review 4 counts: a reconnect storm (10 MNQ pages, 2 subscribes each): one window in all (" + TradesAsked(m1, r => true) + ")");
        }
        finally
        {
            DropClient(a); DropClient(b); foreach (ChartBridgeClient c in storm) DropClient(c);
            ChartBridgeServer.BackfillOn = false; ChartBridgeServer.WindowFirstGuess = 200000; ChartBridgeServer.ResetBooks(DateTime.MinValue);
        }
    }

    // Review 5 S1 (the reviewer's "retrystuck"): a backfill that failed once, whose retry is queued while another request is
    // stuck, says it waits (not "building"); once NinjaTrader answers the stuck one its retry state is back and the retry runs.
    static void RetryStuck()
    {
        DateTime t0 = SimBase.AddMinutes(-10);
        List<Trade> mnq = Walk(t0, 50, 141, 100), nq = Walk(t0, 50, 142, 100);
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0));   // a mid-session start: both want their backfill
        int retryWas = ChartBridgeServer.BackfillRetryMs, toWas = ChartBridgeServer.BackfillTimeoutMs;
        ChartBridgeServer.BackfillOn = true; ChartBridgeServer.BackfillStartMs = 0; ChartBridgeServer.BackfillTimeoutMs = 300; ChartBridgeServer.BackfillRetryMs = 800;
        try
        {
            int m0 = MadeCount();
            LiveOn(inst, mnq, 0, 20); LiveOn(NqInst, nq, 0, 20);
            BarsRequest first = null, other = null;
            if (!WaitFor(() => (first = Find(m0, r => IsTrades(r) && ByDate(r))) != null, 3000)) { Check(false, "review 5 S1: no backfill went out"); return; }
            string root = RootOfReq(first);
            RootBook fb = ChartBridgeServer.BookOf(root, root == "NQ" ? NqInst : inst);
            first.Answer(null, ErrorCode.Panic);                                                     // fails once: asked again in 0.8 s
            WaitFor(() => (other = Made(m0).FirstOrDefault(r => IsTrades(r) && ByDate(r) && RootOfReq(r) != root)) != null, 3000);   // never answered: stuck
            string st = "";
            bool waits = WaitFor(() => { lock (fb.Sync) st = fb.BackfillState; return st.StartsWith("waiting: NinjaTrader has not answered an earlier tick request (backfill ", StringComparison.Ordinal); }, 4000);
            Check(other != null && waits && TradesAsked(m0, ByDate) == 2 && Books().Contains("\"backfillsQueued\":1"),
                "review 5 S1: a backfill that failed once, its retry queued behind a stuck request, says it waits (\"" + st + "\"), not building");
            if (other == null) return;
            ChartBridgeServer.BackfillStartMs = int.MaxValue;   // holds the retry at the gate for a moment, so its state can be read
            other.Answer(new Bars(), ErrorCode.NoError);                                             // at last: dropped, the gate goes on
            BarsRequest again = null;
            bool back = WaitFor(() => { lock (fb.Sync) st = fb.BackfillState; return st.StartsWith("failed once", StringComparison.Ordinal); }, 3000);
            ChartBridgeServer.BackfillStartMs = 0;
            Check(back && WaitFor(() => (again = Made(m0).Where(r => IsTrades(r) && ByDate(r) && RootOfReq(r) == root).Skip(1).FirstOrDefault()) != null, 3000),
                "review 5 S1: once NinjaTrader answers, its retry state is back (\"" + st + "\") and the retry goes out");
            List<Trade> tp = root == "NQ" ? nq : mnq;
            if (again != null) again.Answer(Answer(tp, 0, 20), ErrorCode.NoError);
            Check(WaitFor(() => { lock (fb.Sync) return fb.BackfillState == "done"; }, 3000), "review 5 S1: and the retry loads the session");
        }
        finally
        {
            ChartBridgeServer.BackfillOn = false; ChartBridgeServer.BackfillRetryMs = retryWas; ChartBridgeServer.BackfillTimeoutMs = toWas;
            ChartBridgeServer.ResetBooks(DateTime.MinValue);
        }
    }

    // Review 5 N2: an answer that claims its request but whose copy never ends. After the time limit plus AnswerCopyMs the
    // gate shows it stuck (one log line), its page goes live, and a load meanwhile says why; when the copy ends at last the
    // gate is free again and the next window goes.
    static void CopyNeverEnds()
    {
        DateTime t0 = SimBase.AddMinutes(-10);
        List<Trade> tape = Walk(t0, 100, 151, 100);
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));
        int copyWas = ChartBridgeServer.AnswerCopyMs, wtoWas = ChartBridgeServer.WindowTimeoutMs;
        ChartBridgeServer.AnswerCopyMs = 300; ChartBridgeServer.WindowTimeoutMs = 300; ChartBridgeServer.WindowFirstGuess = 1000;
        List<string> sa = new List<string>(), sb = new List<string>();
        ChartBridgeClient a = NewClient(971, sa), b = NewClient(972, sb);
        Bars held = Answer(tape, 0, 50);
        held.Hold = new System.Threading.ManualResetEventSlim(false);
        System.Threading.Tasks.Task copying = null;
        try
        {
            int m0 = MadeCount();
            LiveOn(inst, tape, 0, 50); LiveOn(NqInst, Walk(t0, 20, 152, 100), 0, 20);
            SubOn(a, "MNQ", "1", 2); AnswerMinutes(m0);
            BarsRequest w = null;
            if (!WaitFor(() => (w = Find(m0, IsWin)) != null)) { Check(false, "review 5 N2: no window went out"); return; }
            copying = System.Threading.Tasks.Task.Run(() => w.Answer(held, ErrorCode.NoError));   // claims it at once; the copy never ends
            Check(WaitFor(() => Gate().Contains("\"stuck\":\"window MNQ\""), 3000) && WaitFor(() => { lock (sa) return Ready(sa, "1"); }, 3000),
                "review 5 N2: an answer whose copy never ends: after the limit plus AnswerCopyMs the gate shows it stuck (not hung silently), and its page goes live");
            SubOn(b, "NQ", "1", 2); AnswerMinutes(m0);
            Check(WaitFor(() => { lock (sb) return Ready(sb, "1") && sb.Any(x => x.Contains("has not answered an earlier tick request (window MNQ)")); }, 3000) && Made(m0).Count(IsWin) == 1,
                "review 5 N2: a load meanwhile goes live at once and says why (no request beside it)");
            held.Hold.Set();
            if (copying != null) copying.Wait(3000);
            Check(WaitFor(() => Gate().Contains("\"stuck\":null"), 3000), "review 5 N2: when the copy ends at last, the gate is free again");
            SubOn(b, "NQ", "2", 2); AnswerMinutes(m0);
            BarsRequest w2 = null;
            Check(WaitFor(() => (w2 = Made(m0).Where(IsWin).Skip(1).FirstOrDefault()) != null, 3000), "review 5 N2: and the next window goes");
            if (w2 != null) w2.Answer(Answer(Walk(t0, 20, 152, 100), 0, 20), ErrorCode.NoError);
            WaitFor(() => { lock (sb) return Ready(sb, "2"); });
        }
        finally
        {
            held.Hold.Set();
            DropClient(a); DropClient(b);
            ChartBridgeServer.AnswerCopyMs = copyWas; ChartBridgeServer.WindowTimeoutMs = wtoWas; ChartBridgeServer.WindowFirstGuess = 200000;
            ChartBridgeServer.ResetBooks(DateTime.MinValue);
        }
    }

    // Review 5 (its race2 probe, 1 run in 36 under load): the late answer came between the worker's timeout claim and its
    // marking the gate stuck, freed the gate before it was marked, and the gate stayed stuck for good. Here the answer comes
    // while the worker marks it (from the window's failure line, on the worker's thread): the gate must end free and the next
    // window go.
    static void AnsweredWhileMarking()
    {
        DateTime t0 = SimBase.AddMinutes(-10);
        List<Trade> tape = Walk(t0, 100, 171, 100);
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));
        int wtoWas = ChartBridgeServer.WindowTimeoutMs;
        ChartBridgeServer.WindowTimeoutMs = 300; ChartBridgeServer.WindowFirstGuess = 1000;
        List<string> sa = new List<string>(), sb = new List<string>();
        ChartBridgeClient a = NewClient(981, sa), b = NewClient(982, sb);
        BarsRequest w = null; bool answeredIn = false;
        try
        {
            int m0 = MadeCount();
            LiveOn(inst, tape, 0, 50); LiveOn(NqInst, Walk(t0, 20, 172, 100), 0, 20);
            NinjaTrader.Code.Output.OnLine = line =>
            {
                if (w == null || !line.Contains("MNQ tick window failed (no answer from NinjaTrader")) return;
                BarsRequest ww = w; w = null;
                ww.Answer(Answer(tape, 0, 50), ErrorCode.NoError);   // late, while the worker is marking the gate stuck
                answeredIn = true;
            };
            SubOn(a, "MNQ", "1", 2); AnswerMinutes(m0);
            if (!WaitFor(() => (w = Find(m0, IsWin)) != null)) { Check(false, "review 5: no window went out"); return; }
            bool answered = WaitFor(() => answeredIn, 3000);
            NinjaTrader.Code.Output.OnLine = null;
            Check(answered && WaitFor(() => Gate().Contains("\"stuck\":null"), 3000) && WaitFor(() => { lock (sa) return Ready(sa, "1"); }, 3000),
                "review 5: an answer that comes while the worker marks the gate stuck frees it once marked (not before), and its page is answered once");
            SubOn(b, "NQ", "1", 2); AnswerMinutes(m0);
            BarsRequest w2 = null;
            Check(WaitFor(() => (w2 = Made(m0).Where(IsWin).Skip(1).FirstOrDefault()) != null, 3000), "review 5: and the next window goes");
            if (w2 != null) w2.Answer(Answer(Walk(t0, 20, 172, 100), 0, 20), ErrorCode.NoError);
            WaitFor(() => { lock (sb) return Ready(sb, "1"); });
            Thread.Sleep(100);
            lock (sa) Check(sa.Count(x => x.StartsWith("{\"type\":\"ready\"")) == 1, "review 5: the MNQ page got one ready");
        }
        finally
        {
            NinjaTrader.Code.Output.OnLine = null;
            DropClient(a); DropClient(b);
            ChartBridgeServer.WindowTimeoutMs = wtoWas; ChartBridgeServer.WindowFirstGuess = 200000;
            ChartBridgeServer.ResetBooks(DateTime.MinValue);
        }
    }

    // Review 5 N6: stopping ends the gate's worker while it waits on a request (limit 5 min), within its bound, and cancels a
    // backfill retry still to come (its timer), so nothing of the gate runs on after a stop or at the process's exit. A failure
    // answered after the stop schedules no retry either (it once took the token made for the next start).
    static void StopEndsGate()
    {
        DateTime t0 = SimBase.AddMinutes(-10);
        List<Trade> mnq = Walk(t0, 50, 161, 100), nq = Walk(t0, 50, 162, 100);
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0));
        int retryWas = ChartBridgeServer.BackfillRetryMs, toWas = ChartBridgeServer.BackfillTimeoutMs;
        ChartBridgeServer.BackfillOn = true; ChartBridgeServer.BackfillStartMs = 0; ChartBridgeServer.BackfillTimeoutMs = 300000; ChartBridgeServer.BackfillRetryMs = 600;
        try
        {
            int m0 = MadeCount();
            LiveOn(inst, mnq, 0, 20); LiveOn(NqInst, nq, 0, 20);
            BarsRequest first = null, other = null;
            if (!WaitFor(() => (first = Find(m0, r => IsTrades(r) && ByDate(r))) != null, 3000)) { Check(false, "review 5 N6: no backfill went out"); return; }
            first.Answer(null, ErrorCode.Panic);                                                     // fails once: its retry is due in 0.6 s
            WaitFor(() => (other = Made(m0).Where(r => IsTrades(r) && ByDate(r)).Skip(1).FirstOrDefault()) != null, 3000);   // the worker waits on it
            System.Threading.Tasks.Task worker = (System.Threading.Tasks.Task)typeof(ChartBridgeServer).GetField("gateTask", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
            bool running = worker != null && !worker.IsCompleted;
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            ChartBridgeServer.StopGate();
            long ms = sw.ElapsedMilliseconds;
            int made = MadeCount();
            if (other != null) other.Answer(null, ErrorCode.Panic);                                 // fails after the stop: no retry
            Thread.Sleep(1500);
            Check(other != null && running && worker.IsCompleted && ms < 5000 && MadeCount() == made && Gate().Contains("\"now\":null") && Gate().Contains("\"backfillsQueued\":0"),
                "review 5 N6: a stop ends the gate's worker waiting on a request (" + ms + " ms, bound 5 s), cancels the backfill retry still to come, and a failure answered after it schedules none (" + (MadeCount() - made) + " requests after)");
        }
        finally
        {
            ChartBridgeServer.BackfillOn = false; ChartBridgeServer.BackfillRetryMs = retryWas; ChartBridgeServer.BackfillTimeoutMs = toWas;
            ChartBridgeServer.ResetBooks(DateTime.MinValue);
        }
    }

    // Review 6 S1 ("stopround2"): a window out at the stop is answered after it with a full, short answer, so a second ask
    // would be due. Nothing goes to NinjaTrader after the stop, and the answer is dropped, not copied.
    static void StopRound2()
    {
        DateTime t0 = SimBase.AddMinutes(-10);
        List<Trade> tape = Walk(t0, 100, 181, 100);
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));
        ChartBridgeServer.WindowFirstGuess = 1000;
        List<string> sa = new List<string>();
        ChartBridgeClient a = NewClient(991, sa);
        try
        {
            int m0 = MadeCount();
            LiveOn(inst, tape, 0, 50);
            SubOn(a, "MNQ", "1", 2); AnswerMinutes(m0);
            BarsRequest w = null;
            if (!WaitFor(() => (w = Find(m0, IsWin)) != null)) { Check(false, "review 6 S1: no window went out"); return; }
            DropClient(a);                                                        // as Stop() closes its pages
            ChartBridgeServer.StopGate();
            int made = MadeCount();
            List<Trade> full = Walk(simNow.AddMinutes(-1), (int)w.BarsBack, 182, 5);
            w.Answer(Answer(full, 0, full.Count), ErrorCode.NoError);              // full and short: a second ask would be due
            Thread.Sleep(800);
            RootBook book = ChartBridgeServer.BookOf("MNQ", inst);
            double cb; lock (book.Sync) cb = book.WindowCallbackMs;
            Check(MadeCount() == made && cb < 0 && Gate().Contains("\"now\":null"),
                "review 6 S1: a window answered after the stop asks nothing more of NinjaTrader (" + (MadeCount() - made) + " requests after) and is not copied");
        }
        finally
        {
            DropClient(a);
            ChartBridgeServer.WindowFirstGuess = 200000;
            ChartBridgeServer.ResetBooks(DateTime.MinValue);
        }
    }

    // Review 6 S1 ("stopload"): a Range load in flight at the stop (its minute history not answered yet; its page closed, as
    // Stop() does). The minute answer comes after the stop: no window goes to NinjaTrader.
    static void StopLoad()
    {
        DateTime t0 = SimBase.AddMinutes(-10);
        List<Trade> tape = Walk(t0, 100, 183, 100);
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));
        List<string> sa = new List<string>();
        ChartBridgeClient a = NewClient(992, sa);
        try
        {
            int m0 = MadeCount();
            LiveOn(inst, tape, 0, 50);
            SubOn(a, "MNQ", "1", 2);
            DropClient(a);
            ChartBridgeServer.StopGate();
            int made = MadeCount();
            AnswerMinutes(m0);
            Thread.Sleep(800);
            Check(MadeCount() == made && Gate().Contains("\"now\":null") && Gate().Contains("\"windowsQueued\":0"),
                "review 6 S1: a load whose minute history is answered after the stop sends no window (" + (MadeCount() - made) + " requests after)");
        }
        finally
        {
            DropClient(a);
            ChartBridgeServer.ResetBooks(DateTime.MinValue);
        }
    }

    // Review 6 N1 ("stoplate"): a request stuck before a stop, then a start in the same process and a new stuck request; the
    // old request's late answer must not free the new stuck gate.
    static void StopLate()
    {
        DateTime t0 = SimBase.AddMinutes(-10);
        List<Trade> tape = Walk(t0, 100, 184, 100), nq = Walk(t0, 20, 185, 100);
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));
        int wtoWas = ChartBridgeServer.WindowTimeoutMs;
        ChartBridgeServer.WindowTimeoutMs = 300; ChartBridgeServer.WindowFirstGuess = 1000;
        List<string> sa = new List<string>(), sb = new List<string>();
        ChartBridgeClient a = NewClient(993, sa), b = null;
        try
        {
            int m0 = MadeCount();
            LiveOn(inst, tape, 0, 50);
            SubOn(a, "MNQ", "1", 2); AnswerMinutes(m0);
            BarsRequest w = null;
            if (!WaitFor(() => (w = Find(m0, IsWin)) != null) || !WaitFor(() => Gate().Contains("\"stuck\":\"window MNQ\""), 3000)) { Check(false, "review 6 N1: MNQ did not get stuck"); return; }
            DropClient(a);
            ChartBridgeServer.StopGate();
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));   // a start in the same process
            LiveOn(NqInst, nq, 0, 20);
            b = NewClient(994, sb);
            int m1 = MadeCount();
            SubOn(b, "NQ", "1", 2); AnswerMinutes(m1);
            BarsRequest wn = null;
            bool nqStuck = WaitFor(() => (wn = Find(m1, IsWin)) != null) && WaitFor(() => Gate().Contains("\"stuck\":\"window NQ\""), 3000);
            w.Answer(Answer(tape, 0, 50), ErrorCode.NoError);                     // the old run's request answers late
            Thread.Sleep(300);
            bool still = Gate().Contains("\"stuck\":\"window NQ\"");
            if (wn != null) wn.Answer(Answer(nq, 0, 20), ErrorCode.NoError);       // the new run's own answer frees it
            Check(nqStuck && still && WaitFor(() => Gate().Contains("\"stuck\":null"), 3000),
                "review 6 N1: an answer from before a stop does not free a newer stuck gate; only that request's own answer does");
        }
        finally
        {
            DropClient(a); if (b != null) DropClient(b);
            ChartBridgeServer.WindowTimeoutMs = wtoWas; ChartBridgeServer.WindowFirstGuess = 200000;
            ChartBridgeServer.ResetBooks(DateTime.MinValue);
        }
    }

    // Review 6 S2 ("stopinrequest"): Stop() runs on NinjaTrader's thread, so it waits only 250 ms for the worker, even when the
    // worker is inside a NinjaTrader call (here Request() takes 1.5 s). The worker then ends on its own and sends nothing more.
    static void StopShortWait()
    {
        DateTime t0 = SimBase.AddMinutes(-10);
        List<Trade> tape = Walk(t0, 100, 186, 100);
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));
        List<string> sa = new List<string>();
        ChartBridgeClient a = NewClient(995, sa);
        System.Threading.ManualResetEventSlim inRequest = new System.Threading.ManualResetEventSlim(false);
        try
        {
            int m0 = MadeCount();
            LiveOn(inst, tape, 0, 50);
            BarsRequest.AutoAnswer = r => { if (IsWin(r)) { inRequest.Set(); Thread.Sleep(1500); } return false; };
            SubOn(a, "MNQ", "1", 2);
            new Thread(() => AnswerMinutes(m0)).Start();
            if (!inRequest.Wait(5000)) { Check(false, "review 6 S2: no window went out"); return; }
            System.Threading.Tasks.Task worker = (System.Threading.Tasks.Task)typeof(ChartBridgeServer).GetField("gateTask", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
            DropClient(a);
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            ChartBridgeServer.StopGate(250);
            long ms = sw.ElapsedMilliseconds;
            int made = MadeCount();
            bool ended = worker != null && worker.Wait(5000);
            Thread.Sleep(300);
            bool logged; lock (NinjaTrader.Code.Output.Lines) logged = NinjaTrader.Code.Output.Lines.Any(l => l.Contains("did not end within 250 ms of the stop"));
            Check(ms < 700 && ended && logged && MadeCount() == made,
                "review 6 S2: Stop waits " + ms + " ms (250 ms) for a worker inside a 1.5 s NinjaTrader call, says so once, and the worker then ends and sends nothing");
        }
        finally
        {
            BarsRequest.AutoAnswer = null;
            DropClient(a);
            ChartBridgeServer.ResetBooks(DateTime.MinValue);
        }
    }

    static void BackfillOrderAndRound2()
    {
        DateTime t0 = SimBase.AddMinutes(-20);
        List<Trade> es = Walk(t0, 50, 91, 100), nq = Walk(t0.AddSeconds(1), 50, 92, 100), mnq = Walk(t0.AddSeconds(2), 3000, 93, 100);
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddMinutes(-1));
        ChartBridgeServer.BackfillOn = true; ChartBridgeServer.BackfillStartMs = 60000;
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        LiveOn(EsInst, es, 0, 5); LiveOn(NqInst, nq, 0, 5); LiveOn(inst, mnq, 0, 5);
        LiveOn(inst, mnq, 5, 300);                        // 30 s: not yet
        Thread.Sleep(300);
        Check(TradesAsked(m0, ByDate) == 0, "S-E: no backfill in the first minute after the feed came up");
        LiveOn(inst, mnq, 300, 1100);                     // past a minute (about 80 ms a trade)
        List<string> order = new List<string>();
        for (int k = 0; k < 3; k++)
        {
            BarsRequest r = null;
            if (!WaitFor(() => (r = Made(m0).Where(x => IsTrades(x) && ByDate(x)).Skip(k).FirstOrDefault()) != null, 3000)) break;
            order.Add(RootOfReq(r));
            List<Trade> tp = RootOfReq(r) == "MNQ" ? mnq.Take(1100).ToList() : RootOfReq(r) == "NQ" ? nq.Take(5).ToList() : es.Take(5).ToList();
            r.Answer(Answer(tp, 0, tp.Count), ErrorCode.NoError);
        }
        Check(string.Join(",", order.ToArray()) == "MNQ,NQ,ES", "S-E: then the backfills one at a time in profileRoots order: " + string.Join(", ", order.ToArray()) + " (the first trades came ES, NQ, MNQ)");
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddMinutes(-1));
        ChartBridgeServer.BackfillStartMs = 0; ChartBridgeServer.WindowFirstGuess = 1000;
        simNow = t0;
        int m1 = MadeCount();
        Sub(client, "811", 2, true); AnswerMinutes(m1);
        BarsRequest w1 = null;
        WaitFor(() => (w1 = Find(m1, r => IsTrades(r) && ByCount(r))) != null);
        LiveOn(inst, mnq, 0, 2000);                       // the backfill is now wanted and queued
        if (w1 != null) w1.Answer(Answer(mnq, 2000 - w1.BarsBack, 2000), ErrorCode.NoError);   // full and short: a second ask
        WaitFor(() => Made(m1).Count(IsTrades) >= 2, 3000);
        List<BarsRequest> ts = Made(m1).Where(IsTrades).ToList();
        Check(ts.Count >= 2 && ByCount(ts[0]) && ByCount(ts[1]) && ts[1].BarsBack == 3000, "S-D: a window's second ask goes before the queued backfill (" + string.Join(", ", ts.Select(r => ByDate(r) ? "by date" : r.BarsBack.ToString(CultureInfo.InvariantCulture)).ToArray()) + ")");
        if (ts.Count >= 2) ts[1].Answer(Answer(mnq, 0, 2000), ErrorCode.NoError);
        BarsRequest bf = null;
        if (WaitFor(() => (bf = Find(m1, r => IsTrades(r) && ByDate(r))) != null, 3000)) bf.Answer(Answer(mnq, 0, 2000), ErrorCode.NoError);
        Thread.Sleep(200);
        ChartBridgeServer.BackfillOn = false; ChartBridgeServer.WindowFirstGuess = 200000;
        ChartBridgeServer.ResetBooks(DateTime.MinValue);
    }

    // S-B: a feed drop while the market is closed (a Saturday, the 17:00 to 18:00 break) misses no trade: nothing is marked.
    static void ClosedMarketDrop()
    {
        DateTime fri = Et(2026, 9, 25, 15, 0, 0);
        List<Trade> tape = Walk(fri, 3000, 95, 300);
        simNow = fri;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(Et(2026, 9, 24, 12, 0, 0)));   // listening since Thursday noon: whole
        Live(tape, 0, 3000);
        RootBook book = ChartBridgeServer.BookOf("MNQ", inst);
        simNow = Et(2026, 9, 26, 11, 0, 0);               // Saturday
        Priv("FeedDropped", null, "a test drop on Saturday");
        simNow = Et(2026, 9, 29, 17, 30, 0);              // a Tuesday in the break
        Priv("FeedDropped", null, "a test drop in the break");
        bool whole; lock (book.Sync) whole = book.Table.Whole && !book.Table.Dropped;
        Check(whole, "S-B: a feed drop on a Saturday or in the 17:00 to 18:00 break marks nothing (no trade was missed)");
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
        bool whole, cache; lock (book.Sync) { whole = book.Table.Whole; cache = book.CacheGap; }
        Check(!whole && cache && prof != null && prof.Contains("\"drop\":{") && prof.Contains("\"whole\":false") && Books().Contains("\"drop\":\"the data connection went ConnectionLost"),
            "S2: a feed drop: the table is not whole, the served window is marked as missing it, and the live page gets the profile with the drop");
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
        // S-G: another drop right after: the next load gets the served window (with the gap), not a new request
        Connection.FirePrice(new Connection { Status = ConnectionStatus.Connected }, ConnectionStatus.Connected, ConnectionStatus.ConnectionLost);
        Thread.Sleep(100);
        Live(tape, 11600, 11700);
        int m2 = MadeCount();
        Sub(client, "703", 2, true);
        AnswerMinutes(m2);
        Check(WaitFor(() => Ready(Sent(), "703")) && TradesAsked(m2, r => true) == 0, "S-G: a second drop within 10 minutes: the next load is served the window with its gap, no new request");
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
