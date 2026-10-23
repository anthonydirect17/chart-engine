// ChartBridge 0.6.8 on Mono: the minute book and the history gap (WORK 2026-10-23, page 1.38.0, ChartBridge 0.6.7: after a reload
// an NQ 1 min chart had no bars from about 10:40 to the live bar at 11:08). Through ChartBridgeServer's own subscribe, market
// data handler and the stand-in BarsRequest answered by hand: NinjaTrader's minute answer ends 28 minutes before the clock and
// its 20,000 last trades start after that, while ChartBridge saw every live trade of those 28 minutes. Then the pure rules of
// the minute book (stamping at the close, a trade on the minute, the cap, late trades, resets), the fallback when the book
// starts after NinjaTrader's last bar (today's path; the hole recorded in /diag and history.log, not shown), the timeouts, and /diag. Made-up prices; nothing here is
// market data.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript.AddOns;

public static class GapHarness
{
    static Action<bool, string> Check;
    static readonly List<string> sent = new List<string>();
    static ChartBridgeClient client;
    static Instrument inst;
    static DateTime simNow;
    const BindingFlags PS = BindingFlags.NonPublic | BindingFlags.Static;

    static object Priv(string name, params object[] args) { return typeof(ChartBridgeServer).GetMethod(name, PS).Invoke(null, args); }
    static List<string> Sent() { lock (sent) return sent.ToList(); }
    static bool WaitFor(Func<bool> ok, int ms) { for (int i = 0; i < ms / 10 && !ok(); i++) Thread.Sleep(10); return ok(); }
    static int Index(List<string> l, string has) { return l.FindIndex(s => s.Contains(has)); }
    static List<BarsRequest> Reqs(int from) { lock (BarsRequest.Made) return BarsRequest.Made.Skip(from).ToList(); }
    static int Made() { lock (BarsRequest.Made) return BarsRequest.Made.Count; }
    static bool IsMinute(BarsRequest r) { return r.BarsPeriod != null && r.BarsPeriod.BarsPeriodType == BarsPeriodType.Minute; }
    static bool IsLastTrades(BarsRequest r) { return r.BarsPeriod != null && r.BarsPeriod.BarsPeriodType == BarsPeriodType.Tick && r.BarsBack == ChartBridgeServer.SeamTicksBack; }

    // New York wall time to NinjaTrader's time (the harness sets NinjaTrader's zone to New York).
    static DateTime Et(int h, int mi, double sec) { return new DateTime(2026, 10, 21, h, mi, 0).AddTicks((long)Math.Round(sec * TimeSpan.TicksPerSecond)); }
    static double EtSec(DateTime nt) { return ChartBridgeTime.EtSeconds(ChartBridgeTime.ToUtc(nt)); }

    class Trade { public DateTime T; public double P; public long V; }
    // A made-up tape from t0 to t1, a trade about every stepMs (some on the same millisecond, one exactly on each minute).
    static List<Trade> Tape(DateTime t0, DateTime t1, int stepMs, int seed)
    {
        Random r = new Random(seed);
        List<Trade> l = new List<Trade>();
        double p = 21440;
        for (DateTime t = t0; t < t1; t = t.AddMilliseconds(r.Next(0, 2 * stepMs + 1)))
        {
            p += (r.Next(0, 3) - 1) * 0.25;
            l.Add(new Trade { T = t, P = p, V = 1 + r.Next(0, 4) });
        }
        for (DateTime m = new DateTime(t0.Ticks - t0.Ticks % TimeSpan.TicksPerMinute).AddMinutes(1); m < t1; m = m.AddMinutes(1)) l.Add(new Trade { T = m, P = 21500, V = 7 });   // on the minute
        return l.OrderBy(x => x.T).ToList();
    }
    static void Live(Trade x)
    {
        simNow = x.T.AddMilliseconds(40);
        Priv("OnMarketData", null, new MarketDataEventArgs { Instrument = inst, MarketDataType = MarketDataType.Last, Price = x.P, Volume = x.V, Time = x.T });
    }
    // NinjaTrader's minute bars (stamped at the close, end-inclusive) of the trades in (from, to], and made-up bars before.
    static Bars NtMinutes(List<Trade> tape, DateTime firstClose, DateTime lastClose)
    {
        Bars b = new Bars();
        for (DateTime c = firstClose; c <= lastClose; c = c.AddMinutes(1))
        {
            DateTime s = c.AddMinutes(-1);
            List<Trade> in1 = tape.Where(x => x.T > s && x.T <= c).ToList();
            if (in1.Count == 0) b.Add(c, 21400, 21401, 21399, 21400, 10);   // a minute before the live tape: made up
            else b.Add(c, in1[0].P, in1.Max(x => x.P), in1.Min(x => x.P), in1[in1.Count - 1].P, in1.Sum(x => x.V));
        }
        return b;
    }
    static Bars TicksOf(IEnumerable<Trade> l) { Bars b = new Bars(); foreach (Trade x in l) b.Add(x.T, x.P, x.P, x.P, x.P, x.V); return b; }

    // What one load put on the wire: the history bars (start time in ET seconds) and the trades after ready.
    class Wire { public List<double[]> Bars = new List<double[]>(); public List<double[]> After = new List<double[]>(); public List<string> Statuses = new List<string>(); public string Ready; public int ReadyAt = -1; }
    static readonly Regex BarRx = new Regex(@"\[([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+),([0-9]+)\]");
    static readonly Regex TickRx = new Regex("\"t\":([0-9.]+).*\"p\":([0-9.]+),\"v\":([0-9]+)");
    static Wire Read(List<string> l)
    {
        Wire w = new Wire();
        for (int i = 0; i < l.Count; i++)
        {
            string s = l[i];
            if (s.Contains("\"type\":\"history\""))
                foreach (Match m in BarRx.Matches(s.Substring(s.IndexOf("\"bars\":")))) w.Bars.Add(Enumerable.Range(1, 6).Select(k => double.Parse(m.Groups[k].Value, CultureInfo.InvariantCulture)).ToArray());
            else if (s.Contains("\"type\":\"ready\"")) { w.Ready = s; w.ReadyAt = i; }
            else if (s.Contains("\"type\":\"status\"")) w.Statuses.Add(s);
            else if (s.Contains("\"type\":\"tick\"") && w.ReadyAt >= 0) { Match m = TickRx.Match(s); w.After.Add(new[] { double.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture), double.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture), double.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture) }); }
        }
        return w;
    }
    static string Seams() { return (string)Priv("SeamsJson"); }
    static string Notes() { return (string)Priv("HistoryNotesJson"); }
    // A new stand-in page (the old one's outbox is never drained here: after many cases it would be full and drop the history)
    static int pageIds = 868;
    static void FreshPage()
    {
        var clients = (System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", PS).GetValue(null);
        ChartBridgeClient gone; clients.TryRemove(client.Id, out gone);
        client = new ChartBridgeClient(null, ++pageIds + 1000);
        client.Tap = x => { lock (sent) sent.Add(x); };
        clients[client.Id] = client;
    }
    static string LastSeam() { string s = Seams(); int i = s.LastIndexOf("{\"client\""); return i >= 0 ? s.Substring(i) : ""; }
    static string Hm(double etSec) { long s = (long)Math.Floor(etSec) % 86400; return (s / 3600).ToString("00") + ":" + (s / 60 % 60).ToString("00"); }

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        typeof(ChartBridgeTime).GetField("et", PS).SetValue(null, TimeZoneInfo.FindSystemTimeZoneById("America/New_York"));
        TimeZoneInfo zoneWas = NinjaTrader.Core.GeneralOptionsClass.Zone;
        NinjaTrader.Core.GeneralOptionsClass.Zone = TimeZoneInfo.FindSystemTimeZoneById("America/New_York");
        inst = new Instrument { FullName = "NQ 12-26", MasterInstrument = new MasterInstrument { Name = "NQ", TickSize = 0.25, PointValue = 20 } };
        Dictionary<string, Instrument> instruments = (Dictionary<string, Instrument>)typeof(ChartBridgeServer).GetField("Instruments", PS).GetValue(null);
        Instrument was; bool had = instruments.TryGetValue("NQ", out was);
        instruments["NQ"] = inst;
        var clients = (System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", PS).GetValue(null);
        client = new ChartBridgeClient(null, 868);
        client.Tap = s => { lock (sent) sent.Add(s); };
        clients[868] = client;
        BarsRequest.AutoAnswer = null;
        bool bfWas = ChartBridgeServer.BackfillOn;
        ChartBridgeServer.BackfillOn = false;
        ChartBridgeServer.ClockForHarness = () => simNow;
        try
        {
            Reproduce();
        }
        finally
        {
            ChartBridgeServer.ClockForHarness = null;
            ChartBridgeServer.BackfillOn = bfWas;
            ChartBridgeServer.ResetBooks(DateTime.MinValue);
            ChartBridgeClient gone; clients.TryRemove(868, out gone); clients.TryRemove(client.Id, out gone);
            if (had) instruments["NQ"] = was; else instruments.Remove("NQ");
            NinjaTrader.Core.GeneralOptionsClass.Zone = zoneWas;
        }
    }

    // The WORK case: listening since 06:00 ET; NinjaTrader's minute answer ends at 10:40 (28 minutes before the reload at
    // 11:08); its 20,000 last trades start at 10:50; ChartBridge saw every trade from 10:39 on live. Before 0.6.8 (run on the
    // 0.6.7 code first): "gap REPRODUCED: minuteTailRebuilt 0 and no bar from 10:40 to 11:08 ET" (see the 0.6.8 CHANGELOG).
    static List<Trade> tape;
    static Wire LoadWith(Bars ntAnswer, bool answerTail, out bool askedTail, out string seam)
    {
        lock (sent) sent.Clear();
        int r0 = Made();
        List<Trade> held = tape.Where(x => x.T >= Et(11, 8, 0)).ToList();
        simNow = Et(11, 8, 0);
        Priv("Subscribe", client, "NQ", 5, 0);
        foreach (Trade x in held.Take(held.Count / 2)) Live(x);    // held while the load runs
        BarsRequest minutes = Reqs(r0).FirstOrDefault(IsMinute);
        Check(minutes != null, "gap: the subscribe asks NinjaTrader for minute bars");
        minutes.Answer(ntAnswer, ErrorCode.NoError);
        foreach (Trade x in held.Skip(held.Count / 2)) Live(x);
        BarsRequest last = null;
        askedTail = WaitFor(() => (last = Reqs(r0).FirstOrDefault(IsLastTrades)) != null, 300);
        if (last != null && answerTail)
        {
            // 20,000 trades, all after NinjaTrader's last minute (10:50 on): they cannot rebuild it
            List<Trade> t20k = Enumerable.Range(0, ChartBridgeServer.SeamTicksBack).Select(i => new Trade { T = Et(10, 50, 0).AddMilliseconds(i * 55), P = 21440, V = 1 }).ToList();
            last.Answer(TicksOf(t20k), ErrorCode.NoError);
        }
        Check(WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0, 3000), "gap: ready is sent");
        Thread.Sleep(50);
        seam = LastSeam();
        return Read(Sent());
    }
    static double Vol(IEnumerable<double[]> rows, int k) { return rows.Sum(r => r[k]); }

    static void Reproduce()
    {
        simNow = Et(6, 0, 0);
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow));
        tape = Tape(Et(10, 39, 0.5), Et(11, 8, 20), 150, 868);
        foreach (Trade x in tape.Where(x => x.T < Et(11, 8, 0))) Live(x);
        bool askedTail; string seam;
        Wire w = LoadWith(NtMinutes(tape, Et(9, 31, 0), Et(10, 40, 0)), true, out askedTail, out seam);
        double lastBar = w.Bars.Count > 0 ? w.Bars[w.Bars.Count - 1][0] : 0, firstAfter = w.After.Count > 0 ? w.After[0][0] : 0;
        Console.WriteLine("     (last history bar starts " + Hm(lastBar) + " ET, first trade after ready " + Hm(firstAfter) + " ET, " + w.Bars.Count + " bars, seam " + seam + ")");
        // continuous minutes from 09:30 to the ready minute, none twice
        List<double> starts = w.Bars.Select(b => b[0]).ToList();
        double s0 = EtSec(Et(9, 30, 0)), sEnd = EtSec(Et(11, 7, 0));
        bool continuous = starts.Count == (int)((sEnd - s0) / 60) + 1 && starts.Select((t, i) => Math.Abs(t - (s0 + 60 * i)) < 0.001).All(x => x);
        Check(!askedTail && continuous && starts.Distinct().Count() == starts.Count,
            "0.6.8 FIXED: continuous minutes from 09:30 to the ready minute (11:07, " + starts.Count + " bars), none twice, and no 20,000-trade request");
        // every trade fed once: the bars from 10:39 (NinjaTrader's last minute is the trades in (10:38, 10:39]... (10:39, 10:40]) and the trades after ready
        double fed = tape.Sum(x => x.V), inBars = Vol(w.Bars.Where(b => b[0] >= EtSec(Et(10, 39, 0))), 5), after = Vol(w.After, 2);
        int heldN = tape.Count(x => x.T >= Et(11, 8, 0));
        Check(inBars + after == fed && w.After.Count == heldN && w.After.All(a => a[0] >= EtSec(Et(11, 8, 0)) - 0.0005),
            "0.6.8: total volume equals the trades fed (" + fed + " = " + inBars + " in bars + " + after + " after ready), every held trade sent once (" + heldN + ")");
        Check(w.Ready.Contains("\"filled\":28") && seam.Contains("\"bookFilled\":28") && seam.Contains("\"minuteLastBar\":\"2026-10-21 10:40:00.000\"") && seam.Contains("\"bookFrom\":\"2026-10-21 10:40:00.000\"") && seam.Contains("\"minuteTailRebuilt\":-1") && seam.Contains("\"hole\":null"),
            "0.6.8: ready says filled 28; /diag seams: the minute answer's last bar 10:40, the book's from 10:40, 28 bars filled");
        Check(!w.Statuses.Any(x => x.Contains("No bars")), "0.6.8: no hole, no hole notice");
        // the volume at each minute equals the trades in it (end-inclusive, as NinjaTrader stamps)
        string bad = null;
        foreach (double[] b in w.Bars.Where(b => b[0] >= EtSec(Et(10, 40, 0))))
        {
            double v = tape.Where(x => EtSec(x.T) > b[0] && EtSec(x.T) <= b[0] + 60 && x.T < Et(11, 8, 0)).Sum(x => x.V);
            if (v != b[5]) { bad = Hm(b[0]) + ": " + b[5] + " against " + v; break; }
        }
        Check(bad == null, "0.6.8: each minute's volume is its trades', a trade on the minute in the bar that ends then" + (bad != null ? " (" + bad + ")" : ""));

        Fallback();
        TailKeptAfter();
        Race();
        Timeouts();
        Pure();
        Resets();
        FirstMinute();
        ColdStart();
        LateAfterStandIn();
        AgentWaits();
        KeptTrimmed();
        ErrorAnswers();
        NoReloadLoop();
        ColdStartRecheck();
        AfterStop();
        Storm();   // last: the GapHarness page on NQ is not read after it (it gets the storm's live NQ trades)
    }

    // The book starts after NinjaTrader's last bar (ChartBridge started at 10:50): today's path, and the hole recorded in /diag and history.log only.
    static void Fallback()
    {
        simNow = Et(10, 50, 0);
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow));
        foreach (Trade x in tape.Where(x => x.T >= Et(10, 50, 0) && x.T < Et(11, 8, 0))) Live(x);
        bool askedTail; string seam;
        Wire w = LoadWith(NtMinutes(tape, Et(9, 31, 0), Et(10, 40, 0)), true, out askedTail, out seam);
        string want = "No bars from 10:40 to 11:08 ET: NinjaTrader's minute history ends at 10:39";
        Check(askedTail && w.Bars.Count == 70 && w.Ready.Contains("\"filled\":0") && seam.Contains("\"minuteTailRebuilt\":0") && seam.Contains("\"bookFilled\":-1") && seam.Contains("\"bookFrom\":\"2026-10-21 10:51:00.000\""),
            "fallback: the book starts at 10:51, after NinjaTrader's last bar (10:40): today's path (the 20,000 trades asked, NinjaTrader's bars as sent)");
        Check(w.Statuses.Count == 0 && !Sent().Any(x => x.Contains("No bars")) && seam.Contains("\"hole\":\"" + want + "\"") && ((string)Priv("HistoryNotesJson")).Contains("history ends early: " + want),
            "fallback: the hole is recorded in /diag (the seam, historyNotes) and history.log, and nothing about it goes to the page (Anthony 2026-10-23: \"I dont need a notice\"): " + want);
        Check(w.After.Count == tape.Count(x => x.T >= Et(11, 8, 0)), "fallback: every held trade released, as before");
        // the hole rule: the 17:00 break and a weekend are not a hole
        Check(ChartBridgeServer.HoleText(new DateTime(2026, 10, 21, 17, 0, 0), new DateTime(2026, 10, 21, 18, 1, 30)) == null &&
              ChartBridgeServer.HoleText(new DateTime(2026, 10, 23, 17, 0, 0), new DateTime(2026, 10, 25, 18, 1, 0)) == null &&
              ChartBridgeServer.HoleText(new DateTime(2026, 10, 21, 11, 6, 0), new DateTime(2026, 10, 21, 11, 8, 0)) == null,
            "hole rule: none across the 17:00 break, a weekend, or 2 minutes");
        string sunday = ChartBridgeServer.HoleText(new DateTime(2026, 10, 23, 17, 0, 0), new DateTime(2026, 10, 25, 18, 9, 30));
        Check(sunday == "No bars from Sun 18:00 to Sun 18:09 ET: NinjaTrader's minute history ends at Fri 16:59", "hole rule: across a weekend only the open minutes count, the days named: " + sunday);
    }

    // 0.6.8, the fallback's own fix: the last trades miss NinjaTrader's last minute (a hole in the tick data there) but hold every
    // minute after it. Before 0.6.8 the whole rebuild was dropped with that minute (rebuilt volume 0 under NinjaTrader's), and the
    // chart had no bar from it to the live one; now NinjaTrader's bar is kept and the later minutes come from the same trades.
    static void TailKeptAfter()
    {
        simNow = Et(10, 50, 0);
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow));
        foreach (Trade x in tape.Where(x => x.T >= Et(10, 50, 0) && x.T < Et(11, 8, 0))) Live(x);
        lock (sent) sent.Clear();
        int r0 = Made();
        List<Trade> held = tape.Where(x => x.T >= Et(11, 8, 0)).ToList();
        simNow = Et(11, 8, 0);
        Priv("Subscribe", client, "NQ", 5, 0);
        foreach (Trade x in held.Take(20)) Live(x);
        Reqs(r0).First(IsMinute).Answer(NtMinutes(tape, Et(9, 31, 0), Et(10, 40, 0)), ErrorCode.NoError);
        BarsRequest last = null;
        WaitFor(() => (last = Reqs(r0).FirstOrDefault(IsLastTrades)) != null, 1000);
        // the last trades: from 10:38:30, none in (10:39, 10:40], then every trade from 10:40 to 11:08:05 (some already held)
        List<Trade> ticks = tape.Where(x => x.T > Et(10, 40, 0) && x.T <= Et(11, 8, 5)).ToList();
        ticks.Insert(0, new Trade { T = Et(10, 38, 30), P = 21440, V = 1 });
        last.Answer(TicksOf(ticks), ErrorCode.NoError);
        foreach (Trade x in held.Skip(20)) Live(x);
        WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0, 3000);
        Thread.Sleep(50);
        Wire w = Read(Sent());
        string seam = LastSeam();
        List<double> starts = w.Bars.Select(b => b[0]).ToList();
        double s0 = EtSec(Et(9, 30, 0)), sEnd = EtSec(Et(11, 8, 0));
        bool continuous = starts.Count == (int)((sEnd - s0) / 60) + 1 && starts.Select((t, i) => Math.Abs(t - (s0 + 60 * i)) < 0.001).All(x => x);
        double fedAfter = tape.Where(x => x.T > Et(10, 40, 0)).Sum(x => x.V), got = Vol(w.Bars.Where(b => b[0] >= EtSec(Et(10, 40, 0))), 5) + Vol(w.After, 2);
        Check(continuous && got == fedAfter && seam.Contains("\"tailKeptAfter\":29") && seam.Contains("\"matched\":true") && !w.Statuses.Any(x => x.Contains("No bars")),
            "fallback, the last trades miss NinjaTrader's last minute only: its bar kept, the 29 minutes after it from the same trades, matched, every trade once (" + got + " of " + fedAfter + "), no hole");
    }

    // The copy against live trades on another thread: no trade in both, none in neither.
    static void Race()
    {
        simNow = Et(6, 0, 0);
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow));
        List<Trade> pre = Tape(Et(10, 39, 0.5), Et(11, 0, 0), 150, 31);
        foreach (Trade x in pre) Live(x);
        List<Trade> flow = Tape(Et(11, 0, 0.2), Et(11, 6, 0), 20, 32);
        lock (sent) sent.Clear();
        int r0 = Made();
        Thread feeder = new Thread(() => { foreach (Trade x in flow) { Priv("OnMarketData", null, new MarketDataEventArgs { Instrument = inst, MarketDataType = MarketDataType.Last, Price = x.P, Volume = x.V, Time = x.T }); } });
        feeder.Start();
        Thread.Sleep(5);
        Priv("Subscribe", client, "NQ", 5, 0);
        BarsRequest minutes = Reqs(r0).FirstOrDefault(IsMinute);
        minutes.Answer(NtMinutes(pre, Et(9, 31, 0), Et(10, 40, 0)), ErrorCode.NoError);
        WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0, 3000);
        feeder.Join();
        Thread.Sleep(50);
        Wire w = Read(Sent());
        double fed = pre.Sum(x => x.V) + flow.Sum(x => x.V), got = Vol(w.Bars.Where(b => b[0] >= EtSec(Et(10, 39, 0))), 5) + Vol(w.After, 2);
        List<double> starts = w.Bars.Select(b => b[0]).ToList();
        Check(got == fed && starts.Distinct().Count() == starts.Count && w.Ready != null && !Reqs(r0).Any(IsLastTrades),
            "race: " + flow.Count + " trades on another thread during the subscribe: bars plus the trades after ready hold every trade once (" + got + " of " + fed + "), no minute twice");
    }

    // WORK 2026-10-23, 11:09: a reload of every window. Several instruments load at once; NinjaTrader answers each minute request
    // late (trades keep coming in between, on another thread) and stale (ending 28 minutes before the clock), and there is no tick
    // backfill at all. One instrument's answer comes after its time limit: it starts from NinjaTrader's earlier answer (kept in
    // memory) and the minute book, and its late answer is kept for the next load. Every chart: continuous minutes to the ready
    // minute, none twice, every trade once.
    static void Storm()
    {
        string[] roots = { "NQ", "ES", "RTY" };
        Dictionary<string, Instrument> instruments = (Dictionary<string, Instrument>)typeof(ChartBridgeServer).GetField("Instruments", PS).GetValue(null);
        var clients = (System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", PS).GetValue(null);
        Dictionary<string, Instrument> was = new Dictionary<string, Instrument>();
        Dictionary<string, Instrument> ins = new Dictionary<string, Instrument>();
        Dictionary<string, ChartBridgeClient> pages = new Dictionary<string, ChartBridgeClient>();
        Dictionary<string, List<string>> got = new Dictionary<string, List<string>>();
        int mWas = ChartBridgeServer.MinuteTimeoutMs, oWas = ChartBridgeServer.OverdueReaskMs;
        try
        {
            simNow = Et(6, 0, 0);
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow));
            int id = 900;
            foreach (string r in roots)
            {
                Instrument w0; if (instruments.TryGetValue(r, out w0)) was[r] = w0;
                ins[r] = r == "NQ" ? inst : new Instrument { FullName = r + " 12-26", MasterInstrument = new MasterInstrument { Name = r, TickSize = 0.25, PointValue = 5 } };
                instruments[r] = ins[r];
                List<string> l = new List<string>(); got[r] = l;
                ChartBridgeClient c = new ChartBridgeClient(null, ++id); c.Tap = x => { lock (l) l.Add(x); }; clients[id] = c; pages[r] = c;
            }
            // every instrument's trades from 10:39 to 11:08 live, before the reload
            Dictionary<string, List<Trade>> tapes = new Dictionary<string, List<Trade>>();
            int seed = 40;
            foreach (string r in roots) tapes[r] = Tape(Et(10, 39, 0.5), Et(11, 14, 0), 120, ++seed);
            foreach (var a in roots.SelectMany(r => tapes[r].Where(t => t.T < Et(11, 8, 0)).Select(t => new { r, t })).OrderBy(a => a.t.T).ToList())
            {
                simNow = a.t.T;
                Priv("OnMarketData", null, new MarketDataEventArgs { Instrument = ins[a.r], MarketDataType = MarketDataType.Last, Price = a.t.P, Volume = a.t.V, Time = a.t.T });
            }
            // RTY: one earlier load answered (NinjaTrader's answer to 10:40 kept in memory)
            simNow = Et(11, 0, 0);
            int r0 = Made();
            Priv("Subscribe", pages["RTY"], "RTY", 5, 0);
            Reqs(r0).First(IsMinute).Answer(NtMinutes(tapes["RTY"], Et(9, 31, 0), Et(10, 40, 0)), ErrorCode.NoError);
            WaitFor(() => { lock (got["RTY"]) return got["RTY"].Any(x => x.Contains("\"type\":\"ready\"")); }, 3000);
            foreach (string r in roots) lock (got[r]) got[r].Clear();
            // the reload of every window: all subscribe at once, trades keep coming on another thread meanwhile (RTY's earlier answer
            // no longer fresh, so it is asked and its kept answer stands in when the answer is late)
            ChartBridgeServer.MinuteTimeoutMs = 1500; ChartBridgeServer.OverdueReaskMs = 1;
            simNow = Et(11, 8, 0);
            r0 = Made();
            foreach (string r in roots) Priv("Subscribe", pages[r], r, 5, 0);
            List<object[]> flow = roots.SelectMany(r => tapes[r].Where(t => t.T >= Et(11, 8, 0)).Select(t => new object[] { r, t })).OrderBy(a => ((Trade)a[1]).T).ToList();
            Thread feeder = new Thread(() => { foreach (object[] a in flow) { Trade t = (Trade)a[1]; Priv("OnMarketData", null, new MarketDataEventArgs { Instrument = ins[(string)a[0]], MarketDataType = MarketDataType.Last, Price = t.P, Volume = t.V, Time = t.T }); if (t.V == 7) Thread.Sleep(60); } });
            feeder.Start();
            Thread.Sleep(400);   // NinjaTrader slow: the answers come while the trades flow
            List<BarsRequest> mins = Reqs(r0).Where(IsMinute).ToList();
            Check(mins.Count == 3, "storm: three minute requests at once (" + mins.Count + ")");
            foreach (BarsRequest q in mins) { string r = roots.First(x => ins[x] == q.Instrument); if (r != "RTY") q.Answer(NtMinutes(tapes[r], Et(9, 31, 0), Et(10, 40, 0)), ErrorCode.NoError); }
            BarsRequest rty = mins.First(q => q.Instrument == ins["RTY"]);
            foreach (string r in roots) WaitFor(() => { lock (got[r]) return got[r].Any(x => x.Contains("\"type\":\"ready\"")); }, 5000);
            feeder.Join();
            rty.Answer(NtMinutes(tapes["RTY"], Et(9, 31, 0), Et(10, 45, 0)), ErrorCode.NoError);   // after its limit: kept, not sent
            Thread.Sleep(100);
            Check(!Reqs(r0).Any(IsLastTrades), "storm: no 20,000-trade request (the book has every forming minute)");
            foreach (string r in roots)
            {
                List<string> l; lock (got[r]) l = got[r].ToList();
                Wire w = Read(l);
                List<double> starts = w.Bars.Select(b => b[0]).ToList();
                double s0 = EtSec(Et(9, 30, 0)), sEnd = EtSec(Et(11, 7, 0));
                bool continuous = starts.Count == (int)((sEnd - s0) / 60) + 1 && starts.Select((t, i) => Math.Abs(t - (s0 + 60 * i)) < 0.001).All(x => x);
                double fed = tapes[r].Sum(x => x.V), vol = Vol(w.Bars.Where(b => b[0] >= EtSec(Et(10, 39, 0))), 5) + Vol(w.After, 2);
                bool status = w.Statuses.Count == 0 && (r != "RTY" || Notes().Contains("minute history: no answer from NinjaTrader in 1 s; the load shows NinjaTrader's minute history as it last sent it (to 10:39 ET) and ChartBridge's own minute bars from 10:40 ET"));
                Check(continuous && vol == fed && w.After.Count == tapes[r].Count(x => x.T >= Et(11, 8, 0)) && w.Ready.Contains("\"filled\":28") && status,
                    "storm, " + r + (r == "RTY" ? " (its answer after the limit: NinjaTrader's earlier answer and the book)" : " (late, stale answer, no tick backfill)") + ": continuous minutes 09:30 to 11:07, none twice, every trade once (" + vol + " of " + fed + ")" + (w.Statuses.Count > 0 ? "; " + w.Statuses[0] : ""));
            }
            string bj = (string)Priv("DiagJson");
            Check(bj.Contains("RTY minute history: NinjaTrader answered after") || bj.Contains("minute history: NinjaTrader answered after"), "storm: the late answer is noted in /diag historyNotes");
            RootBook rb = ChartBridgeServer.BookOf("RTY", ins["RTY"]);
            RawBars kept; lock (rb.Sync) kept = rb.NtMinutes;
            Check(kept != null && kept.Time[kept.Count - 1] == Et(10, 45, 0) && kept.Time[0] == Et(9, 31, 0), "storm: the late answer is kept for the next load (to 10:45)");
        }
        finally
        {
            ChartBridgeServer.MinuteTimeoutMs = mWas; ChartBridgeServer.OverdueReaskMs = oWas;
            foreach (string r in roots) { if (r == "NQ") continue; Instrument w0; if (was.TryGetValue(r, out w0)) instruments[r] = w0; else instruments.Remove(r); }
            foreach (ChartBridgeClient c in pages.Values) { ChartBridgeClient g; clients.TryRemove(c.Id, out g); }
        }
    }

    // Review 1: a load in the book's first minute, right after a ChartBridge start (11:07:50). The book's From is 11:08, the close
    // of the minute still forming, and it has no bar: NinjaTrader's bar stamped 11:08 holds trades that are also held for the
    // page. The book does not stand in (Join: no bar after From); the last-trades path runs and its seam drops what is in both.
    static void FirstMinute()
    {
        FreshPage();
        simNow = Et(11, 7, 50);
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow));
        List<Trade> t = Tape(Et(11, 7, 51), Et(11, 8, 30), 150, 811).Where(x => x.T.Second != 0 || x.T.Millisecond != 0).ToList();
        foreach (Trade x in t.Where(x => x.T < Et(11, 7, 58))) Live(x);
        lock (sent) sent.Clear();
        int r0 = Made();
        simNow = Et(11, 7, 58);
        Priv("Subscribe", client, "NQ", 5, 0);
        List<Trade> held = t.Where(x => x.T >= Et(11, 7, 58)).ToList();
        foreach (Trade x in held.Where(x => x.T < Et(11, 8, 10))) Live(x);
        // NinjaTrader's answer at 11:08:10: its forming bar (stamped 11:09) and the one before (11:08) hold trades held for the page
        Bars nt = NtMinutes(t.Where(x => x.T <= Et(11, 8, 10)).ToList(), Et(10, 31, 0), Et(11, 9, 0));
        Reqs(r0).First(IsMinute).Answer(nt, ErrorCode.NoError);
        BarsRequest last = null;
        bool asked = WaitFor(() => (last = Reqs(r0).FirstOrDefault(IsLastTrades)) != null, 1000);
        foreach (Trade x in held.Where(x => x.T >= Et(11, 8, 10) && x.T <= Et(11, 8, 12))) Live(x);   // live before they are in an answer (0.3.3's order)
        if (last != null) last.Answer(TicksOf(t.Where(x => x.T <= Et(11, 8, 12))), ErrorCode.NoError);
        foreach (Trade x in held.Where(x => x.T > Et(11, 8, 12))) Live(x);
        WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0, 3000);
        Thread.Sleep(50);
        Wire w = Read(Sent());
        double fed = t.Sum(x => x.V), got = Vol(w.Bars.Where(b => b[0] >= EtSec(Et(11, 7, 0))), 5) + Vol(w.After, 2);
        Check(asked && got == fed && w.Ready.Contains("\"filled\":0") && LastSeam().Contains("\"matched\":true"),
            "review 1: a load in the book's first minute right after a start: the book does not stand in, the last trades' seam runs, every trade once (" + got + " of " + fed + ")");
    }

    // Review 2: a cold start (no trade in the book, nothing kept): the minute history's time limit gives up nothing; the load waits for
    // NinjaTrader as in 0.6.7 (the page says it waits), and goes ready with NinjaTrader's answer when it comes.
    static void ColdStart()
    {
        FreshPage();
        int mWas = ChartBridgeServer.MinuteTimeoutMs;
        try
        {
            ChartBridgeServer.MinuteTimeoutMs = 200;
            simNow = Et(11, 8, 0);
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow));
            lock (sent) sent.Clear();
            int r0 = Made();
            Priv("Subscribe", client, "NQ", 5, 0);
            Thread.Sleep(800);
            bool early = Sent().Any(x => x.Contains("\"type\":\"ready\""));
            Reqs(r0).First(IsMinute).Answer(NtMinutes(tape, Et(9, 31, 0), Et(10, 40, 0)), ErrorCode.NoError);
            BarsRequest last = null;
            if (WaitFor(() => (last = Reqs(r0).FirstOrDefault(IsLastTrades)) != null, 500)) last.Answer(new Bars(), ErrorCode.NoError);
            bool ready = WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0, 2000);
            Thread.Sleep(30);
            Wire w = Read(Sent());
            Check(!early && ready && w.Bars.Count == 70 && w.Ready.Contains("\"minuteTimedOut\":false") && Notes().Contains("nothing to stand in for it; the load waits for NinjaTrader"),
                "review 2: a cold start (no book, nothing kept): past the time limit the load keeps waiting, then goes ready with NinjaTrader's 70 bars");
        }
        finally { ChartBridgeServer.MinuteTimeoutMs = mWas; }
    }

    // Review 2: a load that went ready on stand-in history (the book), then NinjaTrader's answer comes: the page is told once to load
    // again ("historyLate", with its subscribe id), and the next load asks NinjaTrader again (the answer kept meanwhile).
    static void LateAfterStandIn()
    {
        FreshPage();
        int mWas = ChartBridgeServer.MinuteTimeoutMs;
        try
        {
            ChartBridgeServer.MinuteTimeoutMs = 200;
            simNow = Et(6, 0, 0);
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow));
            foreach (Trade x in tape.Where(x => x.T < Et(11, 8, 0))) Live(x);
            lock (sent) sent.Clear();
            int r0 = Made();
            simNow = Et(11, 8, 0);
            Priv("OnClientMessage", client, "{\"type\":\"subscribe\",\"root\":\"NQ\",\"days\":5,\"tickHours\":0,\"sub\":61}");
            bool ready = WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0, 2000);
            BarsRequest q = Reqs(r0).First(IsMinute);
            q.Answer(NtMinutes(tape, Et(9, 31, 0), Et(10, 40, 0)), ErrorCode.NoError);
            bool told = WaitFor(() => Sent().Any(x => x.Contains("\"type\":\"historyLate\"")), 2000);
            List<string> l = Sent();
            Check(ready && told && l.Count(x => x.Contains("\"type\":\"historyLate\"")) == 1 && l.Any(x => x.Contains("{\"type\":\"historyLate\",\"root\":\"NQ\",\"sub\":61}")) && Notes().Contains("the page was told to load again"),
                "review 2: ready on the book's bars, then NinjaTrader's answer: the page is told once to load again (historyLate, its sub 61)");
            RootBook rb = ChartBridgeServer.BookOf("NQ", inst);
            RawBars kept; lock (rb.Sync) kept = rb.NtMinutes;
            Check(kept != null && kept.Count == 70, "review 2: the late answer is kept for that next load");
        }
        finally { ChartBridgeServer.MinuteTimeoutMs = mWas; }
    }

    // Review 3: an agent (it places real orders) never goes ready on stand-in history: no time limit, it waits for NinjaTrader's
    // answer, and its ready says so.
    static void AgentWaits()
    {
        int mWas = ChartBridgeServer.MinuteTimeoutMs, tWas = ChartBridgeServer.TailTimeoutMs;
        List<string> got = new List<string>();
        ChartBridgeClient ag = new ChartBridgeClient(null, -868);
        ag.Tap = x => { lock (got) got.Add(x); };
        try
        {
            ChartBridgeServer.MinuteTimeoutMs = 200; ChartBridgeServer.TailTimeoutMs = 200;
            simNow = Et(6, 0, 0);
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow));
            foreach (Trade x in tape.Where(x => x.T < Et(11, 8, 0))) Live(x);
            // a page's load gets NinjaTrader's answer kept first: there is stand-in history for the agent to be offered, and it is not
            RootBook rb = ChartBridgeServer.BookOf("NQ", inst);
            ChartBridgeServer.KeepNtMinutes(rb, RawBars.Copy(NtMinutes(tape, Et(9, 31, 0), Et(10, 40, 0)), false));
            int r0 = Made();
            simNow = Et(11, 8, 0);
            ChartBridgeServer.AgentSubscribe(ag, "NQ", 5, 0, "5");
            Thread.Sleep(900);
            bool early; lock (got) early = got.Any(x => x.Contains("\"type\":\"ready\""));
            Reqs(r0).First(IsMinute).Answer(NtMinutes(tape, Et(9, 31, 0), Et(10, 40, 0)), ErrorCode.NoError);
            bool ready = WaitFor(() => { lock (got) return got.Any(x => x.Contains("\"type\":\"ready\"")); }, 2000);
            string rd; lock (got) rd = got.FirstOrDefault(x => x.Contains("\"type\":\"ready\"")) ?? "";
            Check(!early && ready && rd.Contains("\"minuteTimedOut\":false") && rd.Contains("\"tailTimedOut\":false") && rd.Contains("\"historyFrom\":") && LastSeam().Contains("\"agent\":true") && LastSeam().Contains("\"standIn\":false"),
                "review 3: an agent's subscribe waits past the time limit (kept answers there) and goes ready only on NinjaTrader's answer: " + rd);
        }
        finally { ChartBridgeServer.MinuteTimeoutMs = mWas; ChartBridgeServer.TailTimeoutMs = tWas; }
    }

    // Review 6: kept answers served to a timed-out load are cut to that load's own start (a 1-day load gets no bar from 10 days ago).
    static void KeptTrimmed()
    {
        FreshPage();
        int mWas = ChartBridgeServer.MinuteTimeoutMs;
        try
        {
            ChartBridgeServer.MinuteTimeoutMs = 200;
            simNow = Et(6, 0, 0);
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow));
            foreach (Trade x in tape.Where(x => x.T < Et(11, 8, 0))) Live(x);
            Bars old = NtMinutes(tape, Et(9, 31, 0), Et(10, 40, 0));
            Bars withOld = new Bars();
            withOld.Add(Et(9, 31, 0).AddDays(-10), 1, 1, 1, 1, 5);
            for (int i = 0; i < old.Count; i++) withOld.Add(old.GetTime(i), old.GetOpen(i), old.GetHigh(i), old.GetLow(i), old.GetClose(i), old.GetVolume(i));
            ChartBridgeServer.KeepNtMinutes(ChartBridgeServer.BookOf("NQ", inst), RawBars.Copy(withOld, false));
            lock (sent) sent.Clear();
            simNow = Et(11, 8, 0);
            Priv("OnClientMessage", client, "{\"type\":\"subscribe\",\"root\":\"NQ\",\"days\":1,\"tickHours\":0,\"sub\":71}");
            bool ready = WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0, 2000);
            Thread.Sleep(30);
            Wire w = Read(Sent());
            double first = w.Bars.Count > 0 ? w.Bars[0][0] : 0;
            Check(ready && w.Bars.Count == 98 && first == EtSec(Et(9, 30, 0)), "review 6: a 1-day load that times out gets the kept answer from its own start (the bar 10 days back left out): " + w.Bars.Count + " bars from " + Hm(first) + (ready ? "" : "; sent " + string.Join(" | ", Sent().Take(5)) + "; notes " + Notes()));
        }
        finally { ChartBridgeServer.MinuteTimeoutMs = mWas; }
    }

    // Re-review A: NinjaTrader answers an agent's minute request with an error: the agent gets exactly what 0.6.7 sent (no history
    // bar, then ready), never the book alone; ready says minuteFailed. A page in the same case gets the book (standIn true).
    static void ErrorAnswers()
    {
        List<string> got = new List<string>();
        ChartBridgeClient ag = new ChartBridgeClient(null, -869);
        ag.Tap = x => { lock (got) got.Add(x); };
        simNow = Et(6, 0, 0);
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow));
        foreach (Trade x in tape.Where(x => x.T < Et(11, 8, 0))) Live(x);
        int r0 = Made();
        simNow = Et(11, 8, 0);
        ChartBridgeServer.AgentSubscribe(ag, "NQ", 5, 0, "9");
        Reqs(r0).First(IsMinute).Answer(new Bars(), ErrorCode.UserAbort);
        WaitFor(() => { lock (got) return got.Any(x => x.Contains("\"type\":\"ready\"")); }, 3000);
        Thread.Sleep(30);
        List<string> l; lock (got) l = got.ToList();
        Wire w = Read(l);
        Check(w.Ready != null && w.Bars.Count == 0 && w.Ready.Contains("\"minuteFailed\":true") && w.Ready.Contains("\"standIn\":false") && w.Ready.Contains("\"filled\":0") && l.Any(x => x.Contains("Minute history failed")),
            "re-review A: an agent's minute request answered with an error: no history bar (as 0.6.7), ready says minuteFailed: " + w.Bars.Count + " bars, " + w.Ready);
        FreshPage();
        lock (sent) sent.Clear();
        r0 = Made();
        Priv("Subscribe", client, "NQ", 5, 0);
        Reqs(r0).First(IsMinute).Answer(new Bars(), ErrorCode.UserAbort);
        WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0, 3000);
        Thread.Sleep(30);
        Wire p = Read(Sent());
        Check(p.Bars.Count == 28 && p.Ready.Contains("\"minuteFailed\":true") && p.Ready.Contains("\"standIn\":true"), "re-review A: a page in the same case gets the book's 28 bars, and ready says minuteFailed and standIn");
    }

    // Re-review B: NinjaTrader answers just over the limit every time. The first load goes ready on the book, its answer comes late:
    // the page is told once and loads again; that load (and the next) take the answer just kept (fresh, reaching back to their
    // start) and ask NinjaTrader nothing, so there is no second historyLate and no reload loop. With the kept answer not fresh any
    // more, a late answer within 5 minutes of the last historyLate is not told again either.
    static void NoReloadLoop()
    {
        FreshPage();
        int mWas = ChartBridgeServer.MinuteTimeoutMs, oWas = ChartBridgeServer.OverdueReaskMs;
        try
        {
            ChartBridgeServer.MinuteTimeoutMs = 200;
            simNow = Et(6, 0, 0);
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow));
            foreach (Trade x in tape.Where(x => x.T < Et(11, 8, 0))) Live(x);
            lock (sent) sent.Clear();
            simNow = Et(11, 8, 0);
            int asked0 = Made();
            for (int round = 0; round < 3; round++)
            {
                int r0 = Made();
                int readies = Sent().Count(x => x.Contains("\"type\":\"ready\""));
                Priv("OnClientMessage", client, "{\"type\":\"subscribe\",\"root\":\"NQ\",\"days\":5,\"tickHours\":0,\"sub\":" + (81 + round) + "}");
                WaitFor(() => Sent().Count(x => x.Contains("\"type\":\"ready\"")) > readies, 2000);
                BarsRequest q = Reqs(r0).FirstOrDefault(IsMinute);
                if (q != null) { Thread.Sleep(50); q.Answer(NtMinutes(tape, Et(9, 31, 0), Et(10, 40, 0)), ErrorCode.NoError); }   // over the limit
                Thread.Sleep(150);
            }
            int lates = Sent().Count(x => x.Contains("\"type\":\"historyLate\"")), asked = Reqs(asked0).Count(IsMinute);
            string seams = Seams();
            Check(lates == 1 && asked == 1 && seams.Contains("\"fromKept\":true"),
                "re-review B: NinjaTrader over the limit every time: one historyLate, then the reloads take the kept answer and ask nothing (" + lates + " historyLate, " + asked + " minute request)");
            // the kept answer no longer fresh: the next load asks, goes ready on stand-in, its answer comes late: not told again
            ChartBridgeServer.OverdueReaskMs = 1;
            Thread.Sleep(20);
            int r1 = Made(), rd = Sent().Count(x => x.Contains("\"type\":\"ready\""));
            Priv("OnClientMessage", client, "{\"type\":\"subscribe\",\"root\":\"NQ\",\"days\":5,\"tickHours\":0,\"sub\":90}");
            WaitFor(() => Sent().Count(x => x.Contains("\"type\":\"ready\"")) > rd, 2000);
            BarsRequest q2 = Reqs(r1).FirstOrDefault(IsMinute);
            if (q2 != null) q2.Answer(NtMinutes(tape, Et(9, 31, 0), Et(10, 40, 0)), ErrorCode.NoError);
            Thread.Sleep(150);
            Check(q2 != null && Sent().Count(x => x.Contains("\"type\":\"historyLate\"")) == 1 && Notes().Contains("not told again"),
                "re-review B: a second late answer within 5 minutes is not told to the page again");
        }
        finally { ChartBridgeServer.MinuteTimeoutMs = mWas; ChartBridgeServer.OverdueReaskMs = oWas; }
    }

    // Re-review C and the kept-alone tail: a cold start passes the limit (the instrument marked overdue) and keeps looking; once an
    // answer is kept (another load's), the load goes ready on it, its last minute from the last trades as 0.6.7 does.
    static void ColdStartRecheck()
    {
        FreshPage();
        int mWas = ChartBridgeServer.MinuteTimeoutMs, rWas = ChartBridgeServer.MinuteRecheckMs;
        try
        {
            ChartBridgeServer.MinuteTimeoutMs = 200; ChartBridgeServer.MinuteRecheckMs = 100;
            simNow = Et(11, 7, 50);
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow));
            List<Trade> t = Tape(Et(11, 7, 51), Et(11, 8, 20), 150, 812);
            foreach (Trade x in t.Where(x => x.T < Et(11, 7, 58))) Live(x);
            lock (sent) sent.Clear();
            int r0 = Made();
            simNow = Et(11, 7, 58);
            Priv("Subscribe", client, "NQ", 5, 0);
            Thread.Sleep(450);
            bool early = Sent().Any(x => x.Contains("\"type\":\"ready\""));
            bool marked = ((string)Priv("BooksJson")).Contains("\"minuteOverdue\":true");
            RootBook rb = ChartBridgeServer.BookOf("NQ", inst);
            ChartBridgeServer.KeepNtMinutes(rb, RawBars.Copy(NtMinutes(tape, Et(9, 31, 0), Et(10, 40, 0)), false));
            BarsRequest last = null;
            bool asked = WaitFor(() => (last = Reqs(r0).FirstOrDefault(IsLastTrades)) != null, 1500);
            if (last != null) last.Answer(TicksOf(t.Where(x => x.T < Et(11, 7, 58))), ErrorCode.NoError);
            bool ready = WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0, 2000);
            Thread.Sleep(30);
            Wire w = Read(Sent());
            Check(!early && marked && asked && ready && w.Bars.Count == 70 && w.Ready.Contains("\"standIn\":true") && w.Ready.Contains("\"minuteTimedOut\":true"),
                "re-review C: a cold start past the limit marks the instrument overdue and keeps looking; with an answer kept it goes ready on it (70 bars), its last minute from the last trades (asked: " + asked + ")");
        }
        finally { ChartBridgeServer.MinuteTimeoutMs = mWas; ChartBridgeServer.MinuteRecheckMs = rWas; }
    }

    // Review 10: ChartBridge stops while a load waits: its time limit and its late answer do nothing (no book made again, nothing
    // kept from the previous run, nothing sent).
    static void AfterStop()
    {
        FreshPage();
        FieldInfo cf = typeof(ChartBridgeServer).GetField("cts", PS);
        object ctsWas = cf.GetValue(null);
        int mWas = ChartBridgeServer.MinuteTimeoutMs;
        CancellationTokenSource run = new CancellationTokenSource();
        try
        {
            ChartBridgeServer.MinuteTimeoutMs = 200;
            cf.SetValue(null, run);
            simNow = Et(6, 0, 0);
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow));
            foreach (Trade x in tape.Where(x => x.T < Et(11, 8, 0))) Live(x);
            lock (sent) sent.Clear();
            int r0 = Made();
            simNow = Et(11, 8, 0);
            Priv("Subscribe", client, "NQ", 5, 0);
            run.Cancel();                                         // the stop: the run's token, then the books go
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow));
            Thread.Sleep(600);                                    // past the time limit
            Reqs(r0).First(IsMinute).Answer(NtMinutes(tape, Et(9, 31, 0), Et(10, 40, 0)), ErrorCode.NoError);
            Thread.Sleep(100);
            string bj = (string)Priv("BooksJson");
            Check(!Sent().Any(x => x.Contains("\"type\":\"ready\"") || x.Contains("\"type\":\"history\"")) && !bj.Contains("\"NQ\":"),
                "review 10: after a stop, the time limit and the late answer do nothing: no ready, no history, no book made again");
        }
        finally { cf.SetValue(null, ctsWas); ChartBridgeServer.MinuteTimeoutMs = mWas; }
    }

    // The time limits: the minute history (the book alone, said on screen; no new ask while it is unanswered), the last trades.
    static void Timeouts()
    {
        int mWas = ChartBridgeServer.MinuteTimeoutMs, tWas = ChartBridgeServer.TailTimeoutMs;
        try
        {
            ChartBridgeServer.MinuteTimeoutMs = 300; ChartBridgeServer.TailTimeoutMs = 300;
            simNow = Et(6, 0, 0);
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow));
            foreach (Trade x in tape.Where(x => x.T < Et(11, 8, 0))) Live(x);
            simNow = Et(11, 8, 0);
            lock (sent) sent.Clear();
            int r0 = Made();
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            Priv("Subscribe", client, "NQ", 5, 0);
            bool ready = WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0, 3000);
            sw.Stop();
            Thread.Sleep(30);
            Wire w = Read(Sent());
            BarsRequest first = Reqs(r0).FirstOrDefault(IsMinute);
            Check(ready && sw.ElapsedMilliseconds < 2000 && w.Ready.Contains("\"filled\":28") && w.Ready.Contains("\"minuteTimedOut\":true") && w.Bars.Count == 28 && w.Statuses.Count == 0 && Notes().Contains("minute history: no answer from NinjaTrader in 0 s; the load starts from ChartBridge's own minute bars, from 10:40 ET") && LastSeam().Contains("\"minuteTimedOut\":true") && LastSeam().Contains("\"standIn\":true"),
                "timeout: no minute answer in its time, the book stands in: ready in " + sw.ElapsedMilliseconds + " ms with its 28 bars, ready says minuteTimedOut, nothing on the page (a history note only)");
            // a reload while that request is unanswered: not asked again, ready at once from the book
            lock (sent) sent.Clear();
            int r1 = Made();
            Priv("Subscribe", client, "NQ", 5, 0);
            Check(WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0, 1000) && Made() == r1 && Read(Sent()).Statuses.Count == 0 && Notes().Contains("NinjaTrader has not answered an earlier request yet, so it is not asked again for now"),
                "timeout: a reload while it is unanswered asks NinjaTrader nothing (no retry storm) and goes ready from the book");
            // the late answer is not used, and frees the instrument to ask again
            lock (sent) sent.Clear();
            first.Answer(NtMinutes(tape, Et(9, 31, 0), Et(10, 40, 0)), ErrorCode.NoError);
            Thread.Sleep(30);
            Check(!Sent().Any(x => x.Contains("\"type\":\"history\"") || x.Contains("\"type\":\"ready\"")), "timeout: the late answer sends nothing");
            RootBook nb = ChartBridgeServer.BookOf("NQ", inst);
            WaitFor(() => { lock (nb.Sync) return nb.NtMinutes != null; }, 1000);
            int r2 = Made();
            Priv("Subscribe", client, "NQ", 5, 0);
            bool readyKept = WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0, 1000);
            Check(readyKept && Reqs(r2).FirstOrDefault(IsMinute) == null && LastSeam().Contains("\"fromKept\":true") && Read(Sent()).Ready.Contains("\"minuteTimedOut\":false"),
                "timeout: after the late answer (kept), the next load takes it as its answer and asks NinjaTrader nothing (re-review B)");

            // the last trades (today's path: a book that starts after NinjaTrader's last bar) not answered in time
            simNow = Et(10, 50, 0);
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow));
            foreach (Trade x in tape.Where(x => x.T >= Et(10, 50, 0) && x.T < Et(11, 8, 0))) Live(x);
            bool askedTail; string seam;
            Wire t = LoadWith(NtMinutes(tape, Et(9, 31, 0), Et(10, 40, 0)), false, out askedTail, out seam);
            Check(askedTail && t.Ready != null && t.Ready.Contains("\"tailTimedOut\":true") && t.Statuses.Count == 0 && Notes().Contains("last trades: no answer from NinjaTrader in 0 s") && seam.Contains("\"hole\":\"No bars from 10:40") && seam.Contains("\"tailTimedOut\":true"),
                "timeout: the last trades not answered in time: ready with NinjaTrader's bar as sent; ready says tailTimedOut; the limit and the hole in /diag and history.log only, nothing on the page");
            lock (sent) sent.Clear();
            BarsRequest lateTail = Reqs(0).Where(IsLastTrades).Last();
            lateTail.Answer(TicksOf(tape.Take(10)), ErrorCode.NoError);
            Thread.Sleep(50);
            Check(!Sent().Any(x => x.Contains("\"type\":\"ready\"") || x.Contains("\"type\":\"history\"")), "timeout: the late last trades send nothing more (one ready per load)");
        }
        finally { ChartBridgeServer.MinuteTimeoutMs = mWas; ChartBridgeServer.TailTimeoutMs = tWas; }
    }

    // The minute book's own rules.
    static void Pure()
    {
        MinuteBook b = new MinuteBook();
        b.Add(Et(10, 0, 1), 1, 1);
        Check(b.Count == 0 && b.Trades == 0, "book: nothing kept before its first Begin");
        b.Begin(Et(10, 0, 0.5), Et(10, 0, 30));                   // From: 10:01
        b.Add(Et(10, 0, 40), 5, 2);                                // at or before From: not kept (that minute is partial)
        b.Add(Et(10, 1, 0), 6, 3);                                 // exactly 10:01:00.000: the bar ending 10:01, before From
        b.Add(Et(10, 1, 0.001), 7, 4);                             // the bar ending 10:02
        b.Add(Et(10, 2, 0), 8, 5);                                 // on the minute: the same bar (ends then)
        b.Add(Et(10, 2, 0.5), 9, 6);
        MinuteSnap s = b.Snap();
        Check(b.From == Et(10, 1, 0).Ticks && s.Bars.Count == 2 && s.Bars.Time[0] == Et(10, 2, 0) && s.Bars.Volume[0] == 9 && s.Bars.Open[0] == 7 && s.Bars.Close[0] == 8 && s.Bars.Time[1] == Et(10, 3, 0),
            "book: From is the later of the first trade's and the clock's minute close; bars stamped at their close, a trade on the minute in the bar ending then");
        b.Add(Et(10, 1, 30), 2, 1);                                // late, into its bar: high, low, volume
        s = b.Snap();
        Check(s.Bars.Volume[0] == 10 && s.Bars.Low[0] == 2 && s.Bars.Close[0] == 8 && b.LateTrades == 1, "book: a late trade goes into its own bar (high, low, volume; the close stays the last one in time order)");
        MinuteBook c = new MinuteBook();
        c.Begin(Et(0, 0, 0), DateTime.MinValue);
        for (int i = 0; i < MinuteBook.Cap + 500; i++) c.Add(new DateTime(2026, 10, 21).AddMinutes(i).AddSeconds(30), 1, 1);
        MinuteSnap cs = c.Snap();
        Check(c.Count <= MinuteBook.Cap && c.Count > MinuteBook.Cap - MinuteBook.Trim && new DateTime(c.From) == cs.Bars.Time[0].AddMinutes(-1),
            "book: at most " + MinuteBook.Cap + " bars; the oldest go and From moves up with them (" + c.Count + " kept, from " + new DateTime(c.From).ToString("HH:mm") + ")");
        // the cost per trade
        MinuteBook d = new MinuteBook();
        d.Begin(Et(0, 0, 0), DateTime.MinValue);
        DateTime t0 = Et(0, 0, 1);
        System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
        for (int i = 0; i < 1000000; i++) d.Add(t0.AddTicks(i * 400000L), 21440 + (i % 9) * 0.25, 1);
        sw.Stop();
        Console.WriteLine("     (minute book: 1,000,000 trades in " + sw.Elapsed.TotalMilliseconds.ToString("0") + " ms, " + d.Count + " bars)");
        Check(sw.Elapsed.TotalMilliseconds < 1500, "book: a million trades in " + sw.Elapsed.TotalMilliseconds.ToString("0") + " ms (no allocation per trade)");
        // Join: NinjaTrader's closed minute with more volume than the book moves the cut past it
        MinuteSnap j = b.Snap();
        RawBars nt = new RawBars { Count = 3, Time = new[] { Et(10, 1, 0), Et(10, 2, 0), Et(10, 3, 0) }, Open = new double[3], High = new double[3], Low = new double[3], Close = new double[3], Volume = new long[] { 5, 99, 1 } };
        long cut; int filled, shortM;
        RawBars r = j.Join(nt, out cut, out filled, out shortM);
        Check(r != null && shortM == 1 && cut == Et(10, 2, 0).Ticks && filled == 1 && r.Count == 3 && r.Volume[1] == 99,
            "join: a closed minute NinjaTrader has more volume for than the book (a drop no event told of) is NinjaTrader's; the book's after it");
        nt.Time = new[] { Et(9, 58, 0), Et(9, 59, 0), Et(10, 0, 0) };
        Check(j.Join(nt, out cut, out filled, out shortM) == null, "join: none when the book starts after NinjaTrader's last bar (the hole is not filled half way)");
        MinuteBook e = new MinuteBook();
        e.Begin(Et(10, 0, 20), Et(10, 0, 20));   // started this minute: From 10:01, no bar yet
        e.Add(Et(10, 0, 30), 5, 1);
        nt.Time = new[] { Et(9, 59, 0), Et(10, 0, 0), Et(10, 1, 0) };
        Check(e.Snap().Join(nt, out cut, out filled, out shortM) == null && e.Snap().LastTrade == Et(10, 0, 30).Ticks, "review 1: join: none in the book's first minute (no bar after From: NinjaTrader's bar at From could hold held trades)");
    }

    // A feed drop and a contract change start the book over.
    static void Resets()
    {
        simNow = Et(6, 0, 0);
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow));
        foreach (Trade x in tape.Where(x => x.T < Et(10, 50, 0))) Live(x);
        Priv("FeedDropped", "NQ", "a test drop");
        string j = (string)Priv("BooksJson");
        Check(j.Contains("\"minutes\":{\"from\":null,\"bars\":0") && j.Contains("\"resetWhy\":\"a test drop\""), "reset: a feed drop (the market open) empties the book until the next trade");
        simNow = Et(10, 52, 10);
        foreach (Trade x in tape.Where(x => x.T >= Et(10, 52, 0) && x.T < Et(10, 55, 0))) Live(x);
        j = (string)Priv("BooksJson");
        Check(j.Contains("\"minutes\":{\"from\":\"2026-10-21 10:53:00.000\""), "reset: the book starts again from the first whole minute after the feed is back (10:53)");
    }
}
