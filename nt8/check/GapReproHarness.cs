// The WORK case of 2026-10-23 (an NQ 1 min chart after a reload: no bars from 10:40 to the live bar at 11:08), written against the
// members ChartBridge 0.6.7 already has, so the same file runs on the 0.6.7 code (reproduce-first, nt8/check/GapMain.cs) and in
// the order harness. NinjaTrader's minute answer ends 28 minutes before the clock, its 20,000 last trades start after that, and
// ChartBridge saw every trade from 10:39 live. On 0.6.7 the hole is there (minuteTailRebuilt 0); on 0.6.8 the minutes are
// continuous to the ready minute and every trade counts once. nt8/check/GapHarness.cs has the 0.6.8 cases around it. Made-up
// prices; nothing here is market data.
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

public static class GapReproHarness
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
    static DateTime Et(int h, int mi, double sec) { return new DateTime(2026, 10, 21, h, mi, 0).AddTicks((long)Math.Round(sec * TimeSpan.TicksPerSecond)); }
    static double EtSec(DateTime nt) { return ChartBridgeTime.EtSeconds(ChartBridgeTime.ToUtc(nt)); }
    static string Hm(double s) { long x = (long)Math.Floor(s) % 86400; return (x / 3600).ToString("00") + ":" + (x / 60 % 60).ToString("00"); }
    class Trade { public DateTime T; public double P; public long V; }
    static readonly Regex BarRx = new Regex(@"\[([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+),([0-9]+)\]");
    static readonly Regex TickRx = new Regex("\"t\":([0-9.]+).*\"p\":([0-9.]+),\"v\":([0-9]+)");

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
        client = new ChartBridgeClient(null, 867);
        client.Tap = s => { lock (sent) sent.Add(s); };
        clients[867] = client;
        BarsRequest.AutoAnswer = null;
        bool bfWas = ChartBridgeServer.BackfillOn;
        ChartBridgeServer.BackfillOn = false;
        ChartBridgeServer.ClockForHarness = () => simNow;
        try { Work(); }
        finally
        {
            ChartBridgeServer.ClockForHarness = null;
            ChartBridgeServer.BackfillOn = bfWas;
            ChartBridgeServer.ResetBooks(DateTime.MinValue);
            ChartBridgeClient gone; clients.TryRemove(867, out gone);
            if (had) instruments["NQ"] = was; else instruments.Remove("NQ");
            NinjaTrader.Core.GeneralOptionsClass.Zone = zoneWas;
        }
    }

    static void Live(Trade x)
    {
        simNow = x.T.AddMilliseconds(40);
        Priv("OnMarketData", null, new MarketDataEventArgs { Instrument = inst, MarketDataType = MarketDataType.Last, Price = x.P, Volume = x.V, Time = x.T });
    }

    static void Work()
    {
        simNow = Et(6, 0, 0);
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow));
        Random r = new Random(868);
        List<Trade> tape = new List<Trade>();
        double p = 21440;
        for (DateTime t = Et(10, 39, 0.5); t < Et(11, 8, 20); t = t.AddMilliseconds(r.Next(0, 301))) { p += (r.Next(0, 3) - 1) * 0.25; tape.Add(new Trade { T = t, P = p, V = 1 + r.Next(0, 4) }); }
        foreach (Trade x in tape.Where(x => x.T < Et(11, 8, 0))) Live(x);
        lock (sent) sent.Clear();
        int r0 = Made();
        simNow = Et(11, 8, 0);
        Priv("Subscribe", client, "NQ", 5, 0);
        List<Trade> held = tape.Where(x => x.T >= Et(11, 8, 0)).ToList();
        foreach (Trade x in held.Take(held.Count / 2)) Live(x);
        Bars nt = new Bars();
        for (DateTime c = Et(9, 31, 0); c <= Et(10, 40, 0); c = c.AddMinutes(1))
        {
            DateTime s0 = c.AddMinutes(-1);
            List<Trade> in1 = tape.Where(x => x.T > s0 && x.T <= c).ToList();
            if (in1.Count == 0) nt.Add(c, 21400, 21401, 21399, 21400, 10);
            else nt.Add(c, in1[0].P, in1.Max(x => x.P), in1.Min(x => x.P), in1[in1.Count - 1].P, in1.Sum(x => x.V));
        }
        Reqs(r0).First(q => q.BarsPeriod != null && q.BarsPeriod.BarsPeriodType == BarsPeriodType.Minute).Answer(nt, ErrorCode.NoError);
        foreach (Trade x in held.Skip(held.Count / 2)) Live(x);
        BarsRequest last = null;
        if (WaitFor(() => (last = Reqs(r0).FirstOrDefault(q => q.BarsBack == ChartBridgeServer.SeamTicksBack)) != null, 500))
        {
            Bars ticks = new Bars();
            for (int i = 0; i < ChartBridgeServer.SeamTicksBack; i++) ticks.Add(Et(10, 50, 0).AddMilliseconds(i * 55), 21440, 21440, 21440, 21440, 1);
            last.Answer(ticks, ErrorCode.NoError);
        }
        WaitFor(() => Sent().Any(x => x.Contains("\"type\":\"ready\"")), 3000);
        Thread.Sleep(50);
        List<string> l = Sent();
        List<double[]> bars = new List<double[]>(); List<double[]> after = new List<double[]>();
        bool afterReady = false;
        foreach (string s in l)
        {
            if (s.Contains("\"type\":\"history\"")) foreach (Match m in BarRx.Matches(s.Substring(s.IndexOf("\"bars\":")))) bars.Add(Enumerable.Range(1, 6).Select(k => double.Parse(m.Groups[k].Value, CultureInfo.InvariantCulture)).ToArray());
            else if (s.Contains("\"type\":\"ready\"")) afterReady = true;
            else if (afterReady && s.Contains("\"type\":\"tick\"")) { Match m = TickRx.Match(s); after.Add(new[] { double.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture), double.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture) }); }
        }
        string seams = (string)Priv("SeamsJson");
        string seam = seams.Substring(Math.Max(0, seams.LastIndexOf("{\"client\"")));
        double lastBar = bars.Count > 0 ? bars[bars.Count - 1][0] : 0, firstAfter = after.Count > 0 ? after[0][0] : 0;
        List<double> starts = bars.Select(b => b[0]).ToList();
        bool continuous = starts.Count == 98 && starts.Select((t, i) => Math.Abs(t - (EtSec(Et(9, 30, 0)) + 60 * i)) < 0.001).All(x => x);
        double fed = tape.Sum(x => x.V), got = bars.Where(b => b[0] >= EtSec(Et(10, 39, 0))).Sum(b => b[5]) + after.Sum(a => a[1]);
        Console.WriteLine("     (WORK case on ChartBridge " + ChartBridgeServer.Version + ": " + bars.Count + " bars, the last starting " + Hm(lastBar) + " ET, the first trade after ready " + Hm(firstAfter) + " ET; volume " + got + " of " + fed + ")");
        if (!New) Check(afterReady && seam.Contains("\"minuteTailRebuilt\":0") && firstAfter - (lastBar + 60) > 20 * 60,
            "WORK case REPRODUCED on " + ChartBridgeServer.Version + ": minuteTailRebuilt 0 and no bar from " + Hm(lastBar + 60) + " to " + Hm(firstAfter) + " ET");
        else Check(afterReady && continuous && got == fed, "WORK case fixed on " + ChartBridgeServer.Version + ": continuous minutes from 09:30 to 11:07, every trade once (" + got + " of " + fed + ")");
    }
}
