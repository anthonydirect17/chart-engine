// ChartBridge 0.6.8 on Mono: the history gap on seconds and range charts (a load with tickHours above 0: the served window).
// Written against the members 0.6.7 already has (and the 0.6.8 ones read by reflection when present), so the same file runs on
// the 0.6.7 code first (reproduce-first, nt8/check/WindowGapMain.cs) and then in the order harness. Three cases:
//   W1: NinjaTrader's minute answer ends 28 minutes early and the served window's trades hold every minute after it but miss
//       its last minute: 0.6.7 drops every rebuilt minute with that one (a hole); 0.6.8 keeps the minutes after it.
//   W2: the minute answer ends before the window's first trade (the window cannot rebuild it): 0.6.7 leaves the hole; 0.6.8
//       fills it from the minute book.
//   W3: NinjaTrader does not answer the minute request: 0.6.7 waits (no ready); 0.6.8 gives up at the time limit and starts
//       from NinjaTrader's kept minute answer and the minute book.
// Made-up prices; nothing here is market data.
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

public static class WindowGapHarness
{
    static Action<bool, string> Check;
    static readonly List<string> sent = new List<string>();
    static ChartBridgeClient client;
    static Instrument inst;
    static DateTime simNow;
    const BindingFlags PS = BindingFlags.NonPublic | BindingFlags.Static;
    static readonly bool New = typeof(ChartBridgeServer).GetField("MinuteTimeoutMs") != null;   // 0.6.8 or later

    static object Priv(string name, params object[] args) { return typeof(ChartBridgeServer).GetMethod(name, PS).Invoke(null, args); }
    static List<string> Sent() { lock (sent) return sent.ToList(); }
    static bool WaitFor(Func<bool> ok, int ms) { for (int i = 0; i < ms / 10 && !ok(); i++) Thread.Sleep(10); return ok(); }
    static List<BarsRequest> Reqs(int from) { lock (BarsRequest.Made) return BarsRequest.Made.Skip(from).ToList(); }
    static int Made() { lock (BarsRequest.Made) return BarsRequest.Made.Count; }
    static bool IsMinute(BarsRequest r) { return r.BarsPeriod != null && r.BarsPeriod.BarsPeriodType == BarsPeriodType.Minute; }
    static bool IsWindow(BarsRequest r) { return r.BarsPeriod != null && r.BarsPeriod.BarsPeriodType == BarsPeriodType.Tick && r.BarsBack > 0 && r.BarsBack != ChartBridgeServer.SeamTicksBack; }
    static DateTime Et(int h, int mi, double sec) { return new DateTime(2026, 10, 21, h, mi, 0).AddTicks((long)Math.Round(sec * TimeSpan.TicksPerSecond)); }
    static double EtSec(DateTime nt) { return ChartBridgeTime.EtSeconds(ChartBridgeTime.ToUtc(nt)); }
    static string Hm(double s) { long x = (long)Math.Floor(s) % 86400; return (x / 3600).ToString("00") + ":" + (x / 60 % 60).ToString("00"); }

    class Trade { public DateTime T; public double P; public long V; }
    static List<Trade> Tape(DateTime t0, DateTime t1, int stepMs, int seed)
    {
        Random r = new Random(seed);
        List<Trade> l = new List<Trade>();
        double p = 21440;
        for (DateTime t = t0; t < t1; t = t.AddMilliseconds(r.Next(1, 2 * stepMs + 1))) { p += (r.Next(0, 3) - 1) * 0.25; l.Add(new Trade { T = t, P = p, V = 1 + r.Next(0, 4) }); }
        return l;
    }
    static void Live(Trade x)
    {
        simNow = x.T.AddMilliseconds(40);
        Priv("OnMarketData", null, new MarketDataEventArgs { Instrument = inst, MarketDataType = MarketDataType.Last, Price = x.P, Volume = x.V, Time = x.T });
    }
    static Bars NtMinutes(List<Trade> tape, DateTime firstClose, DateTime lastClose)
    {
        Bars b = new Bars();
        for (DateTime c = firstClose; c <= lastClose; c = c.AddMinutes(1))
        {
            DateTime s = c.AddMinutes(-1);
            List<Trade> in1 = tape.Where(x => x.T > s && x.T <= c).ToList();
            if (in1.Count == 0) b.Add(c, 21400, 21401, 21399, 21400, 10);
            else b.Add(c, in1[0].P, in1.Max(x => x.P), in1.Min(x => x.P), in1[in1.Count - 1].P, in1.Sum(x => x.V));
        }
        return b;
    }
    static Bars TicksOf(IEnumerable<Trade> l) { Bars b = new Bars(); foreach (Trade x in l) b.Add(x.T, x.P, x.P, x.P, x.P, x.V); return b; }
    static readonly Regex BarRx = new Regex(@"\[([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+),([0-9]+)\]");
    static List<double[]> HistoryBars(List<string> l)
    {
        List<double[]> bars = new List<double[]>();
        foreach (string s in l.Where(x => x.Contains("\"type\":\"history\"")))
            foreach (Match m in BarRx.Matches(s.Substring(s.IndexOf("\"bars\":")))) bars.Add(Enumerable.Range(1, 6).Select(k => double.Parse(m.Groups[k].Value, CultureInfo.InvariantCulture)).ToArray());
        return bars;
    }
    // The minutes the page builds from the history before the ready minute: continuous from 09:30 to the minute before it?
    static string Gaps(List<double[]> bars, double readyEt)
    {
        double cutoff = Math.Floor(readyEt / 60) * 60;
        List<double> starts = bars.Select(b => b[0]).Where(t => t < cutoff).Distinct().OrderBy(t => t).ToList();
        List<string> holes = new List<string>();
        for (int i = 1; i < starts.Count; i++) if (starts[i] - starts[i - 1] > 60) holes.Add(Hm(starts[i - 1] + 60) + " to " + Hm(starts[i]));
        if (starts.Count > 0 && cutoff - starts[starts.Count - 1] > 60) holes.Add(Hm(starts[starts.Count - 1] + 60) + " to " + Hm(cutoff));
        return holes.Count == 0 ? null : string.Join(", ", holes);
    }

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
        client = new ChartBridgeClient(null, 869);
        client.Tap = s => { lock (sent) sent.Add(s); };
        clients[869] = client;
        BarsRequest.AutoAnswer = null;
        bool bfWas = ChartBridgeServer.BackfillOn;
        int guessWas = ChartBridgeServer.WindowFirstGuess;
        ChartBridgeServer.BackfillOn = false;
        ChartBridgeServer.ClockForHarness = () => simNow;
        Console.WriteLine("     (window gap harness on ChartBridge " + ChartBridgeServer.Version + ")");
        try { W1(); W2(); W3(); }
        finally
        {
            ChartBridgeServer.ClockForHarness = null;
            ChartBridgeServer.BackfillOn = bfWas; ChartBridgeServer.WindowFirstGuess = guessWas;
            ChartBridgeServer.ResetBooks(DateTime.MinValue);
            ChartBridgeClient gone; clients.TryRemove(869, out gone);
            if (had) instruments["NQ"] = was; else instruments.Remove("NQ");
            NinjaTrader.Core.GeneralOptionsClass.Zone = zoneWas;
        }
    }

    // One window load at 11:08: the minute answer (null: not answered), then the served window's trades by count.
    static List<string> Load(List<Trade> tape, Bars minutes, Func<List<Trade>, List<Trade>> window, int readyMs)
    {
        lock (sent) sent.Clear();
        int r0 = Made();
        simNow = Et(11, 8, 0);
        ChartBridgeServer.WindowFirstGuess = 500000;
        Priv("OnClientMessage", client, "{\"type\":\"subscribe\",\"root\":\"NQ\",\"days\":5,\"tickHours\":2,\"sub\":7,\"liveFirst\":true}");
        List<Trade> held = tape.Where(x => x.T >= Et(11, 8, 0)).ToList();
        foreach (Trade x in held.Take(held.Count / 2)) Live(x);
        if (minutes != null) Reqs(r0).First(IsMinute).Answer(minutes, ErrorCode.NoError);
        BarsRequest w = null;
        WaitFor(() => (w = Reqs(r0).FirstOrDefault(IsWindow)) != null, Math.Max(readyMs, 500));
        if (w != null) w.Answer(TicksOf(window(tape.Where(x => x.T < Et(11, 8, 0)).ToList())), ErrorCode.NoError);
        foreach (Trade x in held.Skip(held.Count / 2)) Live(x);
        WaitFor(() => Sent().Any(x => x.Contains("\"type\":\"ready\"")), readyMs);
        Thread.Sleep(50);
        return Sent();
    }

    // W1: the window's trades miss NinjaTrader's last minute (10:39 to 10:40) but hold every minute after it; ChartBridge started
    // at 10:50 (its minute book does not reach back to 10:40), so this is the rebuild's own fix, not the book's.
    static void W1()
    {
        simNow = Et(10, 50, 0);
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow));
        List<Trade> tape = Tape(Et(10, 38, 0), Et(11, 8, 20), 150, 701);
        foreach (Trade x in tape.Where(x => x.T >= Et(10, 50, 0) && x.T < Et(11, 8, 0))) Live(x);
        List<string> l = Load(tape, NtMinutes(tape, Et(9, 31, 0), Et(10, 40, 0)), pre => pre.Where(x => x.T <= Et(10, 39, 0) || x.T > Et(10, 40, 0)).ToList(), 3000);
        bool ready = l.Any(x => x.Contains("\"type\":\"ready\""));
        string gaps = Gaps(HistoryBars(l), EtSec(Et(11, 8, 0)));
        Console.WriteLine("     (W1 on " + ChartBridgeServer.Version + ": ready " + ready + ", holes in the minute history: " + (gaps ?? "none") + ")");
        if (!New) Check(ready && gaps != null, "W1 REPRODUCED on " + ChartBridgeServer.Version + ": the window's trades miss the minute answer's last minute only, and the rebuilt minutes after it are dropped: no bars " + gaps);
        else Check(ready && gaps == null, "W1 fixed: the window's trades miss the minute answer's last minute only: its bar kept and the minutes after it rebuilt, no hole to the ready minute");
    }

    // W2: the minute answer ends at 10:40 and the window's trades start at 10:55 (they cannot rebuild it); ChartBridge saw every
    // trade from 10:38 live.
    static void W2()
    {
        simNow = Et(6, 0, 0);
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow).AddHours(-20));
        List<Trade> tape = Tape(Et(10, 38, 0), Et(11, 8, 20), 150, 702);
        foreach (Trade x in tape.Where(x => x.T < Et(11, 8, 0))) Live(x);
        List<string> l = Load(tape, NtMinutes(tape, Et(9, 31, 0), Et(10, 40, 0)), pre => pre.Where(x => x.T >= Et(10, 55, 0)).ToList(), 3000);
        bool ready = l.Any(x => x.Contains("\"type\":\"ready\""));
        string gaps = Gaps(HistoryBars(l), EtSec(Et(11, 8, 0)));
        Console.WriteLine("     (W2 on " + ChartBridgeServer.Version + ": ready " + ready + ", holes in the minute history: " + (gaps ?? "none") + ")");
        if (!New) Check(ready && gaps != null, "W2 REPRODUCED on " + ChartBridgeServer.Version + ": the minute answer ends before the window's trades begin: no bars " + gaps);
        else Check(ready && gaps == null, "W2 fixed: the minute answer ends before the window's trades begin: the minute book fills it, no hole to the ready minute");
    }

    // W3: NinjaTrader does not answer the minute request (an earlier load's answer to 10:40 is known).
    static void W3()
    {
        FieldInfo mt = typeof(ChartBridgeServer).GetField("MinuteTimeoutMs"), ot = typeof(ChartBridgeServer).GetField("OverdueReaskMs");
        int mWas = mt != null ? (int)mt.GetValue(null) : 0, oWas = ot != null ? (int)ot.GetValue(null) : 0;
        try
        {
            if (mt != null) mt.SetValue(null, 400);
            if (ot != null) ot.SetValue(null, 1);   // the earlier load's answer is not fresh: this load asks NinjaTrader, and waits for it
            simNow = Et(6, 0, 0);
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow).AddHours(-20));
            List<Trade> tape = Tape(Et(10, 38, 0), Et(11, 8, 20), 150, 703);
            foreach (Trade x in tape.Where(x => x.T < Et(10, 50, 0))) Live(x);
            // an earlier minute chart load at 10:50, answered (to 10:40)
            int r0 = Made();
            simNow = Et(10, 50, 0);
            Priv("Subscribe", client, "NQ", 5, 0);
            Reqs(r0).First(IsMinute).Answer(NtMinutes(tape, Et(9, 31, 0), Et(10, 40, 0)), ErrorCode.NoError);
            BarsRequest last = null;
            if (WaitFor(() => (last = Reqs(r0).FirstOrDefault(r => r.BarsBack == ChartBridgeServer.SeamTicksBack)) != null, 300)) last.Answer(new Bars(), ErrorCode.NoError);
            WaitFor(() => Sent().Any(x => x.Contains("\"type\":\"ready\"")), 2000);
            foreach (Trade x in tape.Where(x => x.T >= Et(10, 50, 0) && x.T < Et(11, 8, 0))) Live(x);
            List<string> l = Load(tape, null, pre => pre.Where(x => x.T >= Et(10, 30, 0)).ToList(), 3000);
            bool ready = l.Any(x => x.Contains("\"type\":\"ready\""));
            string gaps = ready ? Gaps(HistoryBars(l), EtSec(Et(11, 8, 0))) : "no ready";
            Console.WriteLine("     (W3 on " + ChartBridgeServer.Version + ": ready " + ready + ", holes: " + (gaps ?? "none") + ")");
            if (!New) Check(!ready, "W3 REPRODUCED on " + ChartBridgeServer.Version + ": no minute answer: the tick chart is not ready after 3 s (it waits for NinjaTrader with no limit)");
            else
            {
                string notes = (string)Priv("HistoryNotesJson");
                Check(ready && gaps == null && HistoryBars(l).Count > 60 && !l.Any(x => x.Contains("\"type\":\"status\"")) && notes.Contains("minute history: no answer from NinjaTrader in 0 s; the load shows NinjaTrader's minute history as it last sent it (to 10:39 ET) and ChartBridge's own minute bars from 10:39 ET (a tick chart)") && l.Any(x => x.Contains("\"type\":\"ready\"") && x.Contains("\"standIn\":true")),
                    "W3 fixed: no minute answer in its time: the tick chart is ready from NinjaTrader's kept minute answer and the minute book, no hole; a history note, nothing on the page (" + HistoryBars(l).Count + " bars)");
            }
        }
        finally { if (mt != null) mt.SetValue(null, mWas); if (ot != null) ot.SetValue(null, oWas); }
    }
}
