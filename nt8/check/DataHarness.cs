// ChartBridge 0.3.7, data side, on Mono: the prior settlement (snapshot and updates, in hello and as a message), the
// higher-timeframe bars (4h, 1D, 1W: through the gate last, never beside a chart load, served from memory to a second page
// and a reload, the forming bar kept live from the live trades, strict requests, a request NinjaTrader never answers freeing
// the gate), the weekly volume profile from the session tables (memory and the dated files, a missing session said, no
// NinjaTrader request), and the review follow-ups: the gate's stop edges (lf7 N1, N2, N3) and the CME holidays in
// MarketClosedNow (lf7 N4), spot-checked against the dates the page's own rules give for 2026 and 2027.
// Made-up prices; nothing here is market data.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript.AddOns;

public static class DataHarness
{
    static Action<bool, string> Check;
    const BindingFlags PS = BindingFlags.NonPublic | BindingFlags.Static;
    static object Priv(string name, params object[] args) { return typeof(ChartBridgeServer).GetMethod(name, PS).Invoke(null, args); }
    static object Field(string name) { return typeof(ChartBridgeServer).GetField(name, PS).GetValue(null); }
    static void SetField(string name, object v) { typeof(ChartBridgeServer).GetField(name, PS).SetValue(null, v); }
    static System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient> Clients() { return (System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient>)Field("Clients"); }
    static Dictionary<string, Instrument> Named() { return (Dictionary<string, Instrument>)Field("Instruments"); }
    static bool WaitFor(Func<bool> ok, int ms = 5000) { for (int i = 0; i < ms / 5 && !ok(); i++) Thread.Sleep(5); return ok(); }
    static int MadeCount() { lock (BarsRequest.Made) return BarsRequest.Made.Count; }
    static List<BarsRequest> Made(int from) { lock (BarsRequest.Made) return BarsRequest.Made.Skip(from).ToList(); }
    static bool IsMinute1(BarsRequest r) { return r.BarsPeriod != null && r.BarsPeriod.BarsPeriodType == BarsPeriodType.Minute && r.BarsPeriod.Value == 1; }
    static bool IsHtf(BarsRequest r) { return r.BarsPeriod != null && ((r.BarsPeriod.BarsPeriodType == BarsPeriodType.Minute && r.BarsPeriod.Value == 240) || r.BarsPeriod.BarsPeriodType == BarsPeriodType.Day || r.BarsPeriod.BarsPeriodType == BarsPeriodType.Week); }
    static bool IsWin(BarsRequest r) { return r.BarsPeriod != null && r.BarsPeriod.BarsPeriodType == BarsPeriodType.Tick && r.BarsBack > 0 && r.BarsBack != ChartBridgeServer.SeamTicksBack; }
    static string Gate() { return System.Text.RegularExpressions.Regex.Match((string)Priv("BooksJson"), "\"gate\":\\{[^}]*\\}").Value; }
    static bool Logged(string has) { lock (NinjaTrader.Code.Output.Lines) return NinjaTrader.Code.Output.Lines.Any(x => x.Contains(has)); }

    static TimeZoneInfo NY;
    static DateTime simNow;
    // New York wall time as NinjaTrader time (its zone setting; the stand-in's is the PC's unless set).
    static DateTime Et(int y, int mo, int d, int h, int mi, double sec)
    {
        DateTime wall = new DateTime(y, mo, d, h, mi, 0, DateTimeKind.Unspecified).AddTicks((long)Math.Round(sec * TimeSpan.TicksPerSecond));
        return DateTime.SpecifyKind(TimeZoneInfo.ConvertTimeFromUtc(TimeZoneInfo.ConvertTimeToUtc(wall, NY), NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo), DateTimeKind.Unspecified);
    }
    static double EtSec(DateTime nt) { return ChartBridgeTime.EtSeconds(ChartBridgeTime.ToUtc(nt)); }
    static double Wall(int y, int mo, int d, int h, int mi) { return (new DateTime(y, mo, d, h, mi, 0) - new DateTime(1970, 1, 1)).TotalSeconds; }
    static string N(double v) { return v.ToString("0.###", CultureInfo.InvariantCulture); }

    static Instrument Inst(string name, string root, double tick)
    {
        return new Instrument { FullName = name, MasterInstrument = new MasterInstrument { Name = root, TickSize = tick, PointValue = 2, TradingHours = new TradingHours { Name = "CME US Index Futures ETH" } } };
    }
    static Instrument mnq, nq, es;
    static ChartBridgeClient Page(int id, List<string> into)
    {
        ChartBridgeClient c = new ChartBridgeClient(null, id);
        c.Tap = s => { lock (into) into.Add(s); };
        Clients()[id] = c;
        return c;
    }
    static void Drop(ChartBridgeClient c) { if (c == null) return; ChartBridgeClient g; Clients().TryRemove(c.Id, out g); c.Close(); }
    static void Msg(ChartBridgeClient c, string json) { Priv("OnClientMessage", c, json); }
    static List<string> Of(List<string> l, string type) { lock (l) return l.Where(x => x.StartsWith("{\"type\":\"" + type + "\"")).ToList(); }
    static void Trade(Instrument i, DateTime t, double p, long v)
    {
        simNow = t;
        Priv("OnMarketData", null, new MarketDataEventArgs { Instrument = i, MarketDataType = MarketDataType.Last, Price = p, Volume = v, Time = t });
    }

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        NY = TimeZoneInfo.FindSystemTimeZoneById("America/New_York");
        typeof(ChartBridgeTime).GetField("et", PS).SetValue(null, NY);
        mnq = Inst("MNQ 12-26", "MNQ", 0.25); nq = Inst("NQ 12-26", "NQ", 0.25); es = Inst("ES 12-26", "ES", 0.25);
        Dictionary<string, Instrument> was = new Dictionary<string, Instrument>(Named());
        Named().Clear(); Named()["MNQ"] = mnq; Named()["NQ"] = nq; Named()["ES"] = es;
        Dictionary<int, ChartBridgeClient> pagesWas = Clients().ToDictionary(kv => kv.Key, kv => kv.Value);
        Clients().Clear();
        string dirWas = NinjaTrader.Core.Globals.UserDataDir;
        string dir = Path.Combine(Path.GetTempPath(), "cb-data-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(dir, "ChartBridge"));
        NinjaTrader.Core.Globals.UserDataDir = dir;
        bool bfWas = ChartBridgeServer.BackfillOn;
        ChartBridgeServer.BackfillOn = false;
        ChartBridgeServer.ClockForHarness = () => simNow;
        BarsRequest.AutoAnswer = null;
        try
        {
            Holidays();
            Settlement();
            HtfPure();
            HtfThroughGate();
            HtfTimeoutAndStuck();
            WeekProfile();
            StopLoadRestart();      // lf7 N1
            TimedOutAfterStop();    // lf7 N2
            StopBeforeSend();       // lf7 N3
        }
        catch (Exception ex) { Check(false, "data harness threw: " + ex); }
        finally
        {
            ChartBridgeServer.GateBeforeSendForHarness = null;
            MarketData.SettlementFor = null;
            ChartBridgeServer.ClockForHarness = null;
            ChartBridgeServer.BackfillOn = bfWas;
            ChartBridgeServer.ResetBooks(DateTime.MinValue);
            foreach (ChartBridgeClient c in Clients().Values.ToList()) Drop(c);
            Clients().Clear();
            foreach (KeyValuePair<int, ChartBridgeClient> kv in pagesWas) Clients()[kv.Key] = kv.Value;
            Named().Clear(); foreach (KeyValuePair<string, Instrument> kv in was) Named()[kv.Key] = kv.Value;
            lock ((System.Collections.IDictionary)Field("Settlements")) ((System.Collections.IDictionary)Field("Settlements")).Clear();
            NinjaTrader.Core.Globals.UserDataDir = dirWas;
            ChartBridgeServer.StopGate();
            Priv("StartGate");
            try { Directory.Delete(dir, true); } catch (Exception) { }
        }
    }

    // ------------------------------------------------------------ lf7 N4: CME holidays, by the page's own rules
    static void Holidays()
    {
        Func<HashSet<DateTime>, string> D = set => string.Join(" ", set.OrderBy(x => x).Select(x => x.ToString("yyyy-MM-dd")).ToArray());
        // what src/chart-engine.js gives (cmeClosures, nyseHolidays, nyseEarlyCloses), run with node for 2026 and 2027
        Check(D(ChartBridgeCme.CmeClosures(2026)) == "2026-01-01 2026-04-03 2026-12-25" && D(ChartBridgeCme.CmeClosures(2027)) == "2027-01-01 2027-03-26 2027-12-24",
            "holidays: no Globex session on the page's dates (2026: " + D(ChartBridgeCme.CmeClosures(2026)) + "; 2027: " + D(ChartBridgeCme.CmeClosures(2027)) + ")");
        Check(D(ChartBridgeCme.NyseHolidays(2026)) == "2026-01-01 2026-01-19 2026-02-16 2026-04-03 2026-05-25 2026-06-19 2026-07-03 2026-09-07 2026-11-26 2026-12-25"
              && D(ChartBridgeCme.NyseHolidays(2027)) == "2027-01-01 2027-01-18 2027-02-15 2027-03-26 2027-05-31 2027-06-18 2027-07-05 2027-09-06 2027-11-25 2027-12-24",
            "holidays: the NYSE holidays (the 13:00 halt) are the page's");
        Check(D(ChartBridgeCme.NyseEarlyCloses(2026)) == "2026-11-27 2026-12-24" && D(ChartBridgeCme.NyseEarlyCloses(2027)) == "2027-11-26", "holidays: the NYSE early closes (the 13:15 halt) are the page's");
        // cmeClosed at New York wall times: the page's answers (node), true = closed
        string[][] page = {
            new[] {"2026-04-03T10:00:00", "true"}, new[] {"2026-04-02T18:30:00", "true"}, new[] {"2026-04-02T16:59:00", "false"},
            new[] {"2026-01-19T12:59:00", "false"}, new[] {"2026-01-19T13:00:00", "true"}, new[] {"2026-01-19T18:30:00", "false"},
            new[] {"2026-11-27T13:14:00", "false"}, new[] {"2026-11-27T13:15:00", "true"}, new[] {"2026-12-24T13:20:00", "true"},
            new[] {"2026-12-24T18:30:00", "true"}, new[] {"2026-12-27T18:30:00", "false"}, new[] {"2026-12-31T18:30:00", "true"},
            new[] {"2027-01-01T10:00:00", "true"}, new[] {"2027-03-26T10:00:00", "true"}, new[] {"2027-12-23T18:30:00", "true"},
            new[] {"2027-12-24T10:00:00", "true"}, new[] {"2027-12-26T18:30:00", "false"}, new[] {"2027-07-05T13:30:00", "true"},
            new[] {"2027-07-05T12:00:00", "false"}, new[] {"2026-07-03T13:30:00", "true"}, new[] {"2026-06-19T13:00:00", "true"},
            new[] {"2026-09-29T11:00:00", "false"}, new[] {"2026-10-02T17:00:00", "true"}, new[] {"2026-10-04T18:00:00", "false"},
            new[] {"2027-11-26T13:20:00", "true"}, new[] {"2027-11-26T13:10:00", "false"}, new[] {"2026-01-01T10:00:00", "true"},
            new[] {"2027-01-03T18:30:00", "false"} };
        int bad = 0; string first = null;
        foreach (string[] c in page)
        {
            DateTime w = DateTime.ParseExact(c[0], "yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture);
            bool want = c[1] == "true";
            simNow = Et(w.Year, w.Month, w.Day, w.Hour, w.Minute, 0);
            bool direct = ChartBridgeCme.Closed(w), server = (bool)Priv("MarketClosedNow");
            if (direct != want || server != want) { bad++; if (first == null) first = c[0] + " ET: page " + want + ", ChartBridgeCme " + direct + ", MarketClosedNow " + server; }
        }
        Check(bad == 0, "holidays: MarketClosedNow agrees with the page's cmeClosed at " + page.Length + " New York times in 2026 and 2027 (Good Friday, Christmas, New Year, the 13:00 halts, the 13:15 early closes, the 18:00 reopen" + (first != null ? "; " + bad + " differ, first " + first : "") + ")");
        // NinjaTrader in Chicago: the same instant, the same answer
        NinjaTrader.Core.GeneralOptionsClass.Zone = TimeZoneInfo.FindSystemTimeZoneById("America/Chicago");
        try
        {
            simNow = Et(2026, 4, 3, 10, 0, 0); bool gf = (bool)Priv("MarketClosedNow");
            simNow = Et(2026, 1, 19, 13, 30, 0); bool mlk = (bool)Priv("MarketClosedNow");
            simNow = Et(2026, 9, 29, 11, 0, 0); bool tue = (bool)Priv("MarketClosedNow");
            Check(gf && mlk && !tue, "holidays: NinjaTrader set to Chicago time: Good Friday closed, MLK Day after 13:00 ET closed, a Tuesday open");
        }
        finally { NinjaTrader.Core.GeneralOptionsClass.Zone = null; }
    }

    // ------------------------------------------------------------ the prior settlement
    static void Settlement()
    {
        ChartBridgeServer.ResetBooks(DateTime.MinValue);
        simNow = Et(2026, 9, 29, 11, 0, 0);
        MarketData.SettlementFor = i => i == mnq ? new MarketDataEventArgs { Instrument = mnq, MarketDataType = MarketDataType.Settlement, Price = 21456.25, Time = Et(2026, 9, 28, 16, 15, 0) } : null;
        List<MarketData> feeds = (List<MarketData>)Field("Feeds");
        int feedsBefore = feeds.Count;
        try { Priv("SubscribeMarketData"); }
        finally { MarketData.SettlementFor = null; feeds.RemoveRange(feedsBefore, feeds.Count - feedsBefore); }
        string hello = (string)Priv("HelloJson");
        Check(hello.Contains("{\"root\":\"MNQ\",\"name\":\"MNQ 12-26\",\"tick\":0.25,\"pointValue\":2,\"settlement\":21456.25}") && hello.Contains("{\"root\":\"NQ\",\"name\":\"NQ 12-26\",\"tick\":0.25,\"pointValue\":2,\"settlement\":null}"),
            "settlement: NinjaTrader's snapshot at subscription is in hello for MNQ; NQ has none and says null (never an estimate): " + hello.Substring(0, Math.Min(300, hello.Length)));
        Check(hello.Contains("\"features\":[\"liveFirst\",\"profile\",\"settlement\",\"htf\",\"weekProfile\"]"), "hello: features list settlement, htf and weekProfile");
        List<string> a = new List<string>(), b = new List<string>();
        ChartBridgeClient pa = Page(5101, a), pb = Page(5102, b);
        try
        {
            Func<MarketDataType, double, bool, MarketDataEventArgs> ev = (t, p, reset) => new MarketDataEventArgs { Instrument = mnq, MarketDataType = t, Price = p, Volume = 0, Time = Et(2026, 9, 29, 16, 14, 0), IsReset = reset };
            Priv("OnMarketData", null, ev(MarketDataType.Settlement, 21470.5, false));
            Check(WaitFor(() => Of(a, "settlement").Count == 1 && Of(b, "settlement").Count == 1), "settlement: a new value goes to every page");
            Check(Of(a, "settlement")[0] == "{\"type\":\"settlement\",\"root\":\"MNQ\",\"p\":21470.5}", "settlement: the message is {type, root, p}: " + Of(a, "settlement")[0]);
            Priv("OnMarketData", null, ev(MarketDataType.Settlement, 21470.5, false));      // the same again
            Priv("OnMarketData", null, ev(MarketDataType.Settlement, 0, false));            // no price
            Priv("OnMarketData", null, ev(MarketDataType.Settlement, 21000, true));         // a reset is never a value
            Priv("OnMarketData", null, ev(MarketDataType.LastClose, 21400, false));         // the last close is not the settlement
            Thread.Sleep(200);
            Check(Of(a, "settlement").Count == 1 && Of(b, "settlement").Count == 1, "settlement: the same value, a 0, a reset and a LastClose send nothing");
            Check(((string)Priv("HelloJson")).Contains("\"settlement\":21470.5}"), "settlement: the next hello has the new value");
            string diag = (string)Priv("DiagJson");
            Check(diag.Contains("\"settlements\":{\"MNQ\":{\"p\":21470.5,\"ntTime\":\"2026-09-29 16:14:00.000\"") && diag.Contains("\"from\":\"update\",\"changes\":1}"), "settlement: /diag shows it with NinjaTrader's time on it");
            Check(Logged("MNQ settlement 21456.25 (NinjaTrader's, snapshot") && Logged("MNQ settlement 21470.5 (NinjaTrader's, update"), "settlement: each value is noted in the Output window");
            int trades = Of(a, "tick").Count;
            Check(trades == 0, "settlement: no tick or trade comes of it");
        }
        finally { Drop(pa); Drop(pb); }
    }

    // ------------------------------------------------------------ higher-timeframe bars: the pure rules
    static void HtfPure()
    {
        Func<string, double, string> S = (tf, et) => new DateTime(1970, 1, 1).AddSeconds(ChartBridgeServer.HtfStart(tf, et)).ToString("yyyy-MM-dd HH:mm");
        string[][] cases = {
            new[] { "4h", "2026-09-28 18:00", "2026-09-28 18:00" }, new[] { "4h", "2026-09-28 21:59", "2026-09-28 18:00" }, new[] { "4h", "2026-09-28 22:00", "2026-09-28 22:00" },
            new[] { "4h", "2026-09-29 01:30", "2026-09-28 22:00" }, new[] { "4h", "2026-09-29 13:59", "2026-09-29 10:00" }, new[] { "4h", "2026-09-29 14:00", "2026-09-29 14:00" },
            new[] { "4h", "2026-09-29 16:59", "2026-09-29 14:00" }, new[] { "4h", "2026-10-04 18:00", "2026-10-04 18:00" }, new[] { "4h", "2026-03-08 18:30", "2026-03-08 18:00" },
            new[] { "1D", "2026-09-28 17:59", "2026-09-28 00:00" }, new[] { "1D", "2026-09-28 18:00", "2026-09-29 00:00" }, new[] { "1D", "2026-10-04 19:00", "2026-10-05 00:00" },
            new[] { "1W", "2026-10-04 18:00", "2026-10-05 00:00" }, new[] { "1W", "2026-10-02 16:00", "2026-09-28 00:00" }, new[] { "1W", "2026-09-28 09:00", "2026-09-28 00:00" } };
        int bad = 0; string first = null;
        foreach (string[] c in cases)
        {
            DateTime w = DateTime.ParseExact(c[1], "yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture);
            string got = S(c[0], Wall(w.Year, w.Month, w.Day, w.Hour, w.Minute));
            if (got != c[2]) { bad++; if (first == null) first = c[0] + " at " + c[1] + ": " + got + ", not " + c[2]; }
        }
        Check(bad == 0, "htf: bar starts: 4h from the 18:00 ET open (18, 22, 2, 6, 10, 14 to the 17:00 close), 1D the trading day (18:00 starts the next), 1W its Monday (" + cases.Length + " cases" + (first != null ? "; " + first : "") + ")");
        // NinjaTrader's stamps (close-stamped 4h bars in Chicago time; day and week bars on their date)
        NinjaTrader.Core.GeneralOptionsClass.Zone = TimeZoneInfo.FindSystemTimeZoneById("America/Chicago");
        try
        {
            RawBars r = new RawBars { Count = 3, Time = new[] { Et(2026, 9, 28, 22, 0, 0), Et(2026, 9, 29, 17, 0, 0), Et(2026, 9, 29, 22, 0, 0) },
                Open = new[] { 1.0, 2, 3 }, High = new[] { 1.5, 2.5, 3.5 }, Low = new[] { 0.5, 1.5, 2.5 }, Close = new[] { 1.25, 2.25, 3.25 }, Volume = new long[] { 10, 20, 30 } };
            List<double[]> l = ChartBridgeServer.HtfFromBars("4h", r);
            Check(l.Count == 3 && l[0][0] == Wall(2026, 9, 28, 18, 0) && l[1][0] == Wall(2026, 9, 29, 14, 0) && l[2][0] == Wall(2026, 9, 29, 18, 0) && l[1][5] == 20,
                "htf: 4h bars stamped at their close (NinjaTrader in Chicago): 22:00 is the 18:00 bar, the 17:00 close the 14:00 bar (three hours), prices and volume as NinjaTrader's");
            RawBars d = new RawBars { Count = 2, Time = new[] { new DateTime(2026, 9, 28), new DateTime(2026, 9, 29) }, Open = new[] { 1.0, 2 }, High = new[] { 1.0, 2 }, Low = new[] { 1.0, 2 }, Close = new[] { 1.0, 2 }, Volume = new long[] { 5, 6 } };
            List<double[]> ld = ChartBridgeServer.HtfFromBars("1D", d), lw = ChartBridgeServer.HtfFromBars("1W", new RawBars { Count = 1, Time = new[] { new DateTime(2026, 10, 2) }, Open = new[] { 1.0 }, High = new[] { 1.0 }, Low = new[] { 1.0 }, Close = new[] { 1.0 }, Volume = new long[] { 7 } });
            Check(ld.Count == 2 && ld[0][0] == Wall(2026, 9, 28, 0, 0) && ld[1][0] == Wall(2026, 9, 29, 0, 0) && lw.Count == 1 && lw[0][0] == Wall(2026, 9, 28, 0, 0),
                "htf: a day bar dated 2026-09-29 starts 2026-09-29 00:00; the week bar dated Friday 2026-10-02 starts Monday 2026-09-28");
            RawBars ds = new RawBars { Count = 1, Time = new[] { Et(2026, 9, 29, 17, 0, 0) }, Open = new[] { 1.0 }, High = new[] { 1.0 }, Low = new[] { 1.0 }, Close = new[] { 1.0 }, Volume = new long[] { 1 } };
            Check(ChartBridgeServer.HtfFromBars("1D", ds)[0][0] == Wall(2026, 9, 29, 0, 0), "htf: a day bar stamped at its session's close (16:00 Chicago) is still 2026-09-29");
        }
        finally { NinjaTrader.Core.GeneralOptionsClass.Zone = null; }
    }

    // NinjaTrader's 4h answer: close-stamped bars, the last forming (closes at 14:00 ET on 2026-09-29), with a gap at a weekend.
    static Bars FourHours()
    {
        Bars b = new Bars();
        DateTime[] closes = { Et(2026, 9, 25, 14, 0, 0), Et(2026, 9, 25, 17, 0, 0), Et(2026, 9, 27, 22, 0, 0), Et(2026, 9, 28, 2, 0, 0), Et(2026, 9, 28, 6, 0, 0), Et(2026, 9, 28, 10, 0, 0),
            Et(2026, 9, 28, 14, 0, 0), Et(2026, 9, 28, 17, 0, 0), Et(2026, 9, 28, 22, 0, 0), Et(2026, 9, 29, 2, 0, 0), Et(2026, 9, 29, 6, 0, 0), Et(2026, 9, 29, 10, 0, 0), Et(2026, 9, 29, 14, 0, 0) };
        for (int i = 0; i < closes.Length; i++) b.Add(closes[i], 25000 + i, 25010 + i, 24990 + i, 25005 + i, 1000 + i);
        return b;
    }

    static void HtfThroughGate()
    {
        DateTime t0 = Et(2026, 9, 29, 11, 0, 0);
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));
        int fgWas = ChartBridgeServer.WindowFirstGuess;
        ChartBridgeServer.WindowFirstGuess = 1000;
        List<string> la = new List<string>(), lb = new List<string>(), ll = new List<string>();
        ChartBridgeClient a = Page(5201, la), b = Page(5202, lb), load = Page(5203, ll);
        try
        {
            for (int i = 0; i < 20; i++) Trade(mnq, t0.AddSeconds(i), 25012 + (i % 3) * 0.25, 1);   // the feed is up
            int m0 = MadeCount();
            // a Range chart is loading (its minute history not answered yet): the 4h request waits
            Msg(load, "{\"type\":\"subscribe\",\"root\":\"MNQ\",\"days\":5,\"tickHours\":2,\"sub\":1,\"liveFirst\":true}");
            Msg(a, "{\"type\":\"htf\",\"root\":\"MNQ\",\"tf\":\"4h\",\"id\":42}");
            Thread.Sleep(700);
            Check(!Made(m0).Any(IsHtf) && Gate().Contains("\"htfQueued\":1"), "htf: while a chart is loading the 4h request waits at the gate (never beside a chart load): " + Gate());
            foreach (BarsRequest r in Made(m0).Where(IsMinute1)) r.Answer(new Bars(), ErrorCode.NoError);
            BarsRequest win = null;
            Check(WaitFor(() => (win = Made(m0).FirstOrDefault(IsWin)) != null), "htf: the chart's window goes first");
            Thread.Sleep(400);
            Check(!Made(m0).Any(IsHtf), "htf: and the 4h request does not go out beside it");
            Bars wb = new Bars(); for (int i = 0; i < 50; i++) wb.Add(t0.AddSeconds(-500 + i), 25012, 25012, 25012, 25012, 1);
            win.Answer(wb, ErrorCode.NoError);
            BarsRequest h = null;
            Check(WaitFor(() => (h = Made(m0).FirstOrDefault(IsHtf)) != null) && WaitFor(() => load.Ready), "htf: once the chart is live, the 4h request goes");
            List<BarsRequest> order = Made(m0);
            Check(h.BarsBack == ChartBridgeServer.HtfBarsBack && h.BarsPeriod.BarsPeriodType == BarsPeriodType.Minute && h.BarsPeriod.Value == 240 && h.BarsPeriod.MarketDataType == MarketDataType.Last
                  && h.TradingHours != null && h.TradingHours.Name == "CME US Index Futures ETH" && h.MergePolicy == MergePolicy.UseGlobalSettings && h.Instrument == mnq && order.IndexOf(h) > order.IndexOf(win),
                "htf: the request: MNQ 12-26 by count (" + h.BarsBack + "), Minute 240, Last, the chart's trading hours, NinjaTrader's merge setting, after the window");
            Check(Gate().Contains("\"now\":\"htf MNQ 4h\""), "htf: /diag shows it at the gate: " + Gate());
            h.Answer(FourHours(), ErrorCode.NoError);
            Check(WaitFor(() => Of(la, "htf").Count == 1), "htf: the page gets its answer");
            string ans = Of(la, "htf")[0];
            Check(ans.StartsWith("{\"type\":\"htf\",\"root\":\"MNQ\",\"tf\":\"4h\",\"id\":42,\"name\":\"MNQ 12-26\",\"bars\":[[" + N(Wall(2026, 9, 25, 10, 0)) + ",25000,25010,24990,25005,1000],[" + N(Wall(2026, 9, 25, 14, 0)) + ",25001,")
                  && ans.Contains("[" + N(Wall(2026, 9, 27, 18, 0)) + ",25002,") && ans.Contains("[" + N(Wall(2026, 9, 29, 10, 0)) + ",25012,25022,25002,25017,1012]]") && ans.EndsWith(",\"error\":null}"),
                "htf: start-stamped bars, oldest first, the forming one last, the id echoed: " + ans.Substring(0, Math.Min(260, ans.Length)));
            Check(Gate().Contains("\"now\":null") && Gate().Contains("\"htfQueued\":0"), "htf: the gate is free again");

            // a second page and a reload: from memory, nothing asked of NinjaTrader
            int m1 = MadeCount();
            Msg(b, "{\"type\":\"htf\",\"root\":\"MNQ\",\"tf\":\"4h\"}");
            Msg(a, "{\"type\":\"htf\",\"root\":\"MNQ\",\"tf\":\"4h\",\"id\":43}");
            Thread.Sleep(300);
            string bAns = Of(lb, "htf").FirstOrDefault() ?? "";
            Check(Made(m1).Count == 0 && bAns.Contains("\"id\":null") && Of(la, "htf").Count == 2 && Of(la, "htf")[1].Contains("\"id\":43")
                  && bAns.Substring(bAns.IndexOf("\"bars\"")) == Of(la, "htf")[1].Substring(Of(la, "htf")[1].IndexOf("\"bars\"")),
                "htf: a second page and a reload are served from memory (" + Made(m1).Count + " requests), the same bars");
            Check(((string)Priv("DiagJson")).Contains("\"htf\":{\"MNQ 4h\":{\"bars\":13,\"asking\":false,\"waiting\":0,\"day\":\"2026-09-29\",\"stale\":false,\"asks\":1,\"served\":3"), "htf: /diag counts one ask, three served");

            // the forming bar from the live trades ChartBridge already has: no request per trade, at most one push a second
            int m2 = MadeCount();
            Trade(mnq, Et(2026, 9, 29, 11, 5, 0), 25030, 7);
            Trade(mnq, Et(2026, 9, 29, 11, 5, 1), 25000, 2);
            Priv("HtfPush");
            List<string> pa = Of(la, "htfBar");
            Check(pa.Count == 1 && pa[0] == "{\"type\":\"htfBar\",\"root\":\"MNQ\",\"tf\":\"4h\",\"bars\":[[" + N(Wall(2026, 9, 29, 10, 0)) + ",25012,25030,25000,25000,1021]]}",
                "htf: the forming 10:00 bar takes the live trades (high 25030, close 25000, volume 1012 + 9): " + (pa.Count > 0 ? pa[0] : "none"));
            Priv("HtfPush");
            Check(Of(la, "htfBar").Count == 1 && Of(lb, "htfBar").Count == 1, "htf: nothing new, nothing pushed; the second page gets it too");
            Trade(mnq, Et(2026, 9, 29, 13, 59, 59.9), 25001, 1);
            Trade(mnq, Et(2026, 9, 29, 14, 0, 0.5), 25002.5, 3);
            Priv("HtfPush");
            pa = Of(la, "htfBar");
            Check(pa.Count == 2 && pa[1] == "{\"type\":\"htfBar\",\"root\":\"MNQ\",\"tf\":\"4h\",\"bars\":[[" + N(Wall(2026, 9, 29, 10, 0)) + ",25012,25030,25000,25001,1022],[" + N(Wall(2026, 9, 29, 14, 0)) + ",25002.5,25002.5,25002.5,25002.5,3]]}",
                "htf: at 14:00 the closed bar's final values, then the new forming bar: " + (pa.Count > 1 ? pa[1] : "none"));
            Check(Made(m2).Count == 0, "htf: the trades asked nothing of NinjaTrader");

            // strict requests: refused with a status, nothing asked
            int m3 = MadeCount();
            string[] bad = { "{\"type\":\"htf\",\"root\":\"MNQ\",\"tf\":\"4h\",\"extra\":1}", "{\"type\":\"htf\",\"root\":\"MNQ\",\"tf\":\"5m\"}", "{\"type\":\"htf\",\"root\":\"MNQ\",\"tf\":\"4h\",\"id\":\"7\"}",
                "{\"type\":\"htf\",\"root\":\"MNQ\",\"tf\":\"4h\",\"id\":007}", "{\"type\":\"htf\",\"root\":\"MNQ\",\"tf\":{\"x\":1}}", "{\"type\":\"htf\",\"root\":\"MNQ\"}",
                "{\"type\":\"htf\",\"root\":\"MNQ\",\"tf\":\"4h\",\"tf\":\"1D\"}", "{\"type\":\"htf\",\"root\":\"M\\u004eQ\",\"tf\":\"4h\"}", "{\"type\":\"htf\",\"root\":\"MNQ\",\"tf\":\"4h\"} x", "{\"type\":\"htf\",\"root\":\"MNQ\",\"tf\":\"4h\",\"id\":-1}" };
            List<string> lc = new List<string>(); ChartBridgeClient c = Page(5204, lc);
            foreach (string m in bad) Msg(c, m);
            Thread.Sleep(100);
            List<string> refusals = Of(lc, "status");
            Check(refusals.Count == bad.Length && refusals.All(x => x.Contains("ChartBridge refused a htf message")) && Of(lc, "htf").Count == 0 && Made(m3).Count == 0,
                "htf: " + bad.Length + " malformed requests (another key, tf 5m, id as a string or 007 or -1, a nested value, a missing tf, a key twice, an escape, trailing text) refused, nothing asked: " + string.Join(" | ", refusals.Take(3).ToArray()));
            Msg(c, "{\"type\":\"htf\",\"root\":\"CL\",\"tf\":\"1D\"}");
            Check(WaitFor(() => Of(lc, "htf").Count == 1) && Of(lc, "htf")[0].Contains("\"bars\":[],\"error\":\"ChartBridge does not serve CL\""), "htf: a root ChartBridge does not serve: an answer with the reason, no request");
            Drop(c);

            // a later trading day: asked again (the session's bars are NinjaTrader's again)
            simNow = Et(2026, 9, 30, 9, 0, 0);
            int m4 = MadeCount();
            Msg(a, "{\"type\":\"htf\",\"root\":\"MNQ\",\"tf\":\"4h\",\"id\":44}");
            BarsRequest h2 = null;
            Check(WaitFor(() => (h2 = Made(m4).FirstOrDefault(IsHtf)) != null), "htf: a request in the next trading day asks NinjaTrader again");
            if (h2 != null) h2.Answer(FourHours(), ErrorCode.NoError);
            Check(WaitFor(() => Of(la, "htf").Any(x => x.Contains("\"id\":44"))), "htf: and answers");
            // 1D and 1W: Day 1 and Week 1 requests
            int m5 = MadeCount();
            Msg(a, "{\"type\":\"htf\",\"root\":\"MNQ\",\"tf\":\"1D\"}");
            BarsRequest hd = null;
            Check(WaitFor(() => (hd = Made(m5).FirstOrDefault(IsHtf)) != null) && hd.BarsPeriod.BarsPeriodType == BarsPeriodType.Day && hd.BarsPeriod.Value == 1, "htf: 1D asks for Day 1 bars");
            Bars days = new Bars(); days.Add(new DateTime(2026, 9, 28), 1, 2, 0.5, 1.5, 100); days.Add(new DateTime(2026, 9, 29), 1.5, 3, 1, 2.5, 200);
            // live trades that come while NinjaTrader's answer is being copied are not lost: they go into the bars after it
            days.Hold = new ManualResetEventSlim(false);
            Thread answering = new Thread(() => { if (hd != null) hd.Answer(days, ErrorCode.NoError); });
            answering.IsBackground = true; answering.Start();
            Thread.Sleep(150);
            Trade(mnq, Et(2026, 9, 30, 9, 0, 1), 3.5, 4);
            Trade(mnq, Et(2026, 9, 30, 9, 0, 2), 3.25, 1);
            days.Hold.Set();
            Check(WaitFor(() => Of(la, "htf").Any(x => x.Contains("\"tf\":\"1D\""))), "htf: 1D answered");
            string dAns = Of(la, "htf").First(x => x.Contains("\"tf\":\"1D\""));
            Check(dAns.Contains("[[" + N(Wall(2026, 9, 28, 0, 0)) + ",1,2,0.5,1.5,100],[" + N(Wall(2026, 9, 29, 0, 0)) + ",1.5,3,1,2.5,200],[" + N(Wall(2026, 9, 30, 0, 0)) + ",3.5,3.5,3.25,3.25,5]]"),
                "htf: 1D bars on their trading day, and today's forming bar from the two trades that came while the answer was copied: " + dAns);
            int m6 = MadeCount();
            Msg(a, "{\"type\":\"htf\",\"root\":\"MNQ\",\"tf\":\"1W\"}");
            BarsRequest hw = null;
            Check(WaitFor(() => (hw = Made(m6).FirstOrDefault(IsHtf)) != null) && hw.BarsPeriod.BarsPeriodType == BarsPeriodType.Week && hw.BarsPeriod.Value == 1, "htf: 1W asks for Week 1 bars");
            if (hw != null) hw.Answer(new Bars(), ErrorCode.NoError);
            Check(WaitFor(() => Of(la, "htf").Any(x => x.Contains("\"tf\":\"1W\""))) && Of(la, "htf").First(x => x.Contains("\"tf\":\"1W\"")).Contains("\"bars\":[],\"error\":\"NinjaTrader has no 1W bars for MNQ 12-26\""),
                "htf: an empty answer says so (no bars made up)");
        }
        finally { Drop(a); Drop(b); Drop(load); ChartBridgeServer.WindowFirstGuess = fgWas; ChartBridgeServer.ResetBooks(DateTime.MinValue); }
    }

    // A request NinjaTrader never answers frees the gate (the chart never waits); a stuck gate answers at once.
    static void HtfTimeoutAndStuck()
    {
        DateTime t0 = Et(2026, 9, 29, 11, 0, 0);
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));
        int toWas = ChartBridgeServer.HtfTimeoutMs, fgWas = ChartBridgeServer.WindowFirstGuess;
        ChartBridgeServer.HtfTimeoutMs = 1000; ChartBridgeServer.WindowFirstGuess = 1000;
        List<string> la = new List<string>(), ll = new List<string>();
        ChartBridgeClient a = Page(5301, la), load = null;
        try
        {
            for (int i = 0; i < 20; i++) Trade(nq, t0.AddSeconds(i), 25012, 1);
            int m0 = MadeCount();
            Msg(a, "{\"type\":\"htf\",\"root\":\"NQ\",\"tf\":\"1D\",\"id\":1}");
            BarsRequest h = null;
            Check(WaitFor(() => (h = Made(m0).FirstOrDefault(IsHtf)) != null), "htf timeout: the request goes out");
            Check(WaitFor(() => Of(la, "htf").Count == 1, 4000) && Of(la, "htf")[0].Contains("\"bars\":[],\"error\":\"NinjaTrader did not answer within 1 s\""), "htf timeout: the page is answered with the reason");
            Check(WaitFor(() => Gate().Contains("\"now\":null")) && Gate().Contains("\"stuck\":null"), "htf timeout: the gate is free, not stuck (the chart never waits): " + Gate());
            load = Page(5302, ll);
            int m1 = MadeCount();
            Msg(load, "{\"type\":\"subscribe\",\"root\":\"NQ\",\"days\":5,\"tickHours\":2,\"sub\":1,\"liveFirst\":true}");
            foreach (BarsRequest r in Made(m1).Where(IsMinute1)) r.Answer(new Bars(), ErrorCode.NoError);
            Check(WaitFor(() => Made(m1).Any(IsWin)), "htf timeout: a Range load's window goes as usual");
            h.Answer(new Bars(), ErrorCode.NoError);   // the late answer
            Thread.Sleep(200);
            Check(Of(la, "htf").Count == 1, "htf timeout: its late answer is dropped, not sent");
            // the same within HtfRetryMs: not asked again
            int m2 = MadeCount();
            Msg(a, "{\"type\":\"htf\",\"root\":\"NQ\",\"tf\":\"1D\",\"id\":2}");
            Check(WaitFor(() => Of(la, "htf").Count == 2) && Of(la, "htf")[1].Contains("\"error\":\"the last request failed") && Made(m2).Count(IsHtf) == 0, "htf timeout: asked again within a minute: not sent again, said why");
            // a stuck gate (an earlier window never answered): answered at once, nothing asked
            SetField("gateStuck", "window MNQ");
            try
            {
                int m3 = MadeCount();
                Msg(a, "{\"type\":\"htf\",\"root\":\"ES\",\"tf\":\"1W\",\"id\":3}");
                Check(WaitFor(() => Of(la, "htf").Count == 3) && Of(la, "htf")[2].Contains("\"error\":\"NinjaTrader has not answered an earlier request (window MNQ) yet") && Made(m3).Count(IsHtf) == 0,
                    "htf: while the gate is stuck the page is answered at once, nothing asked");
            }
            finally { SetField("gateStuck", null); }
        }
        finally { Drop(a); Drop(load); ChartBridgeServer.HtfTimeoutMs = toWas; ChartBridgeServer.WindowFirstGuess = fgWas; ChartBridgeServer.ResetBooks(DateTime.MinValue); }
    }

    // ------------------------------------------------------------ the weekly profile
    static SessionTable Table(DateTime day, bool whole, long[][] rows)
    {
        double start = Wall(day.Year, day.Month, day.Day, 0, 0) - 6 * 3600;   // 18:00 ET the evening before
        SessionTable t = new SessionTable { StartEt = start, Whole = whole, CoveredFromEt = whole ? start : start + 3600 };
        foreach (long[] r in rows) t.Add(start + r[0], r[1], r[2]);
        return t;
    }
    static void WeekProfile()
    {
        // which sessions: the last 5 finished, days with a Globex session (Good Friday 2026 has none; a weekend is not one)
        Func<DateTime, string> F = now => string.Join(" ", ChartBridgeServer.FinishedSessions(now, 5).Select(x => x.ToString("MM-dd")).ToArray());
        Check(F(new DateTime(2026, 10, 8, 11, 0, 0)) == "10-01 10-02 10-05 10-06 10-07", "week: Thursday 11:00: the 5 sessions before today's (" + F(new DateTime(2026, 10, 8, 11, 0, 0)) + ")");
        Check(F(new DateTime(2026, 10, 8, 17, 30, 0)) == "10-02 10-05 10-06 10-07 10-08", "week: in the 17:00 break today's session is finished and counts");
        Check(F(new DateTime(2026, 4, 6, 11, 0, 0)) == "03-27 03-30 03-31 04-01 04-02",
            "week: the week of Good Friday 2026: no session on 04-03, so it is not missing (" + F(new DateTime(2026, 4, 6, 11, 0, 0)) + ")");
        Check(F(new DateTime(2026, 10, 10, 12, 0, 0)) == "10-05 10-06 10-07 10-08 10-09", "week: on a Saturday, Monday to Friday");

        simNow = Et(2026, 10, 8, 11, 0, 0);
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow).AddDays(-30));
        RootBook book = ChartBridgeServer.BookOf("MNQ", mnq);
        Thread.Sleep(100);
        long[][] r7 = { new long[] { 3600, 100000, 5 }, new long[] { 7200, 100001, 3 }, new long[] { 9 * 3600, 100000, 2 } };
        long[][] r6 = { new long[] { 3600, 100000, 1 }, new long[] { 3600, 99999, 4 } };
        long[][] r1 = { new long[] { 600, 100002, 6 } };
        SessionTable t7 = Table(new DateTime(2026, 10, 7), true, r7), t6 = Table(new DateTime(2026, 10, 6), false, r6), t1 = Table(new DateTime(2026, 10, 1), true, r1), t5 = Table(new DateTime(2026, 10, 5), true, r1);
        t6.Dropped = true; t6.DropAtEt = t6.StartEt + 7200; t6.DropWhy = "the data connection went ConnectionLost";
        lock (book.Sync) { book.KeepPast(t7); book.Last = t5; }
        // 10-06 and 10-01 from their files (as after a restart); 10-02 has none
        File.WriteAllText(book.PastFile(new DateTime(2026, 10, 6)), RootBook.LastText(t6));
        File.WriteAllText(book.PastFile(new DateTime(2026, 10, 1)), RootBook.LastText(t1));
        List<string> la = new List<string>();
        ChartBridgeClient a = Page(5401, la);
        try
        {
            int m0 = MadeCount();
            Msg(a, "{\"type\":\"weekProfile\",\"root\":\"MNQ\",\"id\":9}");
            Check(WaitFor(() => Of(la, "weekProfile").Count == 1), "week: answered");
            string w = Of(la, "weekProfile")[0];
            string expect = "{\"type\":\"weekProfile\",\"root\":\"MNQ\",\"id\":9,\"tick\":0.25,\"sessions\":[" +
                "{\"date\":\"2026-10-01\",\"from\":" + N(t1.StartEt) + ",\"whole\":true,\"coveredFrom\":" + N(t1.StartEt) + ",\"drop\":null,\"rows\":[[100002,6]]}," +
                "{\"date\":\"2026-10-02\",\"missing\":\"no table: ChartBridge was not running for this session, or its file is gone\"}," +
                "{\"date\":\"2026-10-05\",\"from\":" + N(t5.StartEt) + ",\"whole\":true,\"coveredFrom\":" + N(t5.StartEt) + ",\"drop\":null,\"rows\":[[100002,6]]}," +
                "{\"date\":\"2026-10-06\",\"from\":" + N(t6.StartEt) + ",\"whole\":false,\"coveredFrom\":" + N(t6.StartEt + 3600) + ",\"drop\":{\"at\":" + N(t6.StartEt + 7200) + ",\"why\":\"the data connection went ConnectionLost\"},\"rows\":[[99999,4],[100000,1]]}," +
                "{\"date\":\"2026-10-07\",\"from\":" + N(t7.StartEt) + ",\"whole\":true,\"coveredFrom\":" + N(t7.StartEt) + ",\"drop\":null,\"rows\":[[100000,7],[100001,3]]}]," +
                "\"rows\":[[99999,4],[100000,8],[100001,3],[100002,12]],\"error\":null}";
            Check(w == expect, "week: 5 sessions oldest first, from memory, the last session, and the dated files; 10-02 said missing; a session with a drop says so; rows by price and their sum: " + (w == expect ? "as expected" : w + " AGAINST " + expect));
            Check(Made(m0).Count == 0, "week: no NinjaTrader request");
            Msg(a, "{\"type\":\"weekProfile\",\"root\":\"MNQ\",\"days\":7}");
            Msg(a, "{\"type\":\"weekProfile\",\"root\":\"MNQ\",\"id\":1.5}");
            Thread.Sleep(100);
            Check(Of(la, "status").Count == 2 && Of(la, "status").All(x => x.Contains("ChartBridge refused a weekProfile message")) && Of(la, "weekProfile").Count == 1, "week: another key or a fraction is refused");

            // a session that finishes live is kept, and written to its dated file for after a restart
            Trade(mnq, Et(2026, 10, 8, 16, 59, 0), 25000, 4);
            Trade(mnq, Et(2026, 10, 8, 18, 0, 1), 25001, 2);
            string f8 = book.PastFile(new DateTime(2026, 10, 8));
            Check(WaitFor(() => File.Exists(f8)), "week: a finished session is written to profile-MNQ-2026-10-08.txt");
            lock (book.Sync) Check(book.Past.ContainsKey(new DateTime(2026, 10, 8)), "week: and kept in memory");
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow).AddDays(-30));   // a restart: nothing in memory
            simNow = Et(2026, 10, 9, 11, 0, 0);
            Msg(a, "{\"type\":\"weekProfile\",\"root\":\"MNQ\"}");
            Check(WaitFor(() => Of(la, "weekProfile").Count == 2), "week: answered after a restart");
            string w2 = Of(la, "weekProfile")[1];
            Check(w2.Contains("{\"date\":\"2026-10-08\",\"from\":") && w2.Contains("\"rows\":[[100000,4]]") && w2.Contains("{\"date\":\"2026-10-07\",\"missing\":") && w2.Contains("\"id\":null"),
                "week: after a restart the sessions come from their files (10-08 here; 10-07 was only in memory, so missing)");
        }
        finally { Drop(a); ChartBridgeServer.ResetBooks(DateTime.MinValue); }
    }

    // ------------------------------------------------------------ lf7 N1: a load in flight at a stop, then a start in the same process
    static void StopLoadRestart()
    {
        DateTime t0 = Et(2026, 9, 29, 11, 0, 0);
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));
        int fgWas = ChartBridgeServer.WindowFirstGuess; ChartBridgeServer.WindowFirstGuess = 1000;
        List<string> la = new List<string>(), lb = new List<string>();
        ChartBridgeClient a = Page(5501, la), b = null;
        try
        {
            for (int i = 0; i < 20; i++) Trade(mnq, t0.AddSeconds(i), 25012, 1);
            int m0 = MadeCount();
            Msg(a, "{\"type\":\"subscribe\",\"root\":\"MNQ\",\"days\":5,\"tickHours\":2,\"sub\":1,\"liveFirst\":true}");
            ChartBridgeServer.StopGate(250);                                         // as Stop() does, then its Books.Clear()
            lock ((System.Collections.IDictionary)Field("Books")) ((System.Collections.IDictionary)Field("Books")).Clear();
            foreach (BarsRequest r in Made(m0).Where(IsMinute1)) r.Answer(new Bars(), ErrorCode.NoError);   // the minute history answered after the stop
            Check(WaitFor(() => Of(la, "ready").Count == 1, 3000) && la.Any(x => x.Contains("ChartBridge stopped before the request went out")),
                "lf7 N1: a load answered after the stop is not left waiting on a window that will never go out (its page is answered)");
            Priv("StartGate");                                                       // a start in the same process
            b = Page(5502, lb);
            int m1 = MadeCount();
            Msg(b, "{\"type\":\"subscribe\",\"root\":\"MNQ\",\"days\":5,\"tickHours\":2,\"sub\":1,\"liveFirst\":true}");
            foreach (BarsRequest r in Made(m1).Where(IsMinute1)) r.Answer(new Bars(), ErrorCode.NoError);
            BarsRequest w = null;
            Check(WaitFor(() => (w = Made(m1).FirstOrDefault(IsWin)) != null, 3000), "lf7 N1: after the start a new page's window is asked (before: it joined the dead one as \"shared\" and never loaded)");
            if (w != null) { Bars wb = new Bars(); for (int i = 0; i < 20; i++) wb.Add(t0.AddSeconds(i), 25012, 25012, 25012, 25012, 1); w.Answer(wb, ErrorCode.NoError); }
            Check(WaitFor(() => Of(lb, "ready").Count == 1, 3000), "lf7 N1: and it loads");
        }
        finally { Drop(a); Drop(b); ChartBridgeServer.WindowFirstGuess = fgWas; ChartBridgeServer.ResetBooks(DateTime.MinValue); }
    }

    // lf7 N2: a timeout handled in the gap after StopGate reset the gate but before it cancelled the worker's token.
    static void TimedOutAfterStop()
    {
        ChartBridgeServer.ResetBooks(DateTime.MinValue);
        Type jt = typeof(ChartBridgeServer).GetNestedType("GateJob", BindingFlags.NonPublic);
        object j = Activator.CreateInstance(jt);
        jt.GetField("Kind").SetValue(j, "window"); jt.GetField("Root").SetValue(j, "MNQ");
        jt.GetField("OnTimeout").SetValue(j, (Action)(() => { }));
        jt.GetField("Stop").SetValue(j, new CancellationTokenSource().Token);   // its worker's token: not cancelled yet
        SetField("gateStopped", true);                                          // StopGate has reset the gate (and released the lock)
        try
        {
            Priv("GateTimedOut", j);
            Check(Field("gateStuck") == null, "lf7 N2: a timeout handled after the stop's reset does not mark the gate stuck again (" + (Field("gateStuck") ?? "null") + ")");
        }
        finally { SetField("gateStuck", null); SetField("gateStuckJob", null); Priv("StartGate"); }
    }

    // lf7 N3: a stop between the worker taking a job and sending it: nothing goes to NinjaTrader.
    static void StopBeforeSend()
    {
        DateTime t0 = Et(2026, 9, 29, 11, 0, 0);
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));
        int fgWas = ChartBridgeServer.WindowFirstGuess; ChartBridgeServer.WindowFirstGuess = 1000;
        List<string> la = new List<string>();
        ChartBridgeClient a = Page(5601, la);
        bool hit = false;
        try
        {
            for (int i = 0; i < 20; i++) Trade(mnq, t0.AddSeconds(i), 25012, 1);
            ChartBridgeServer.GateBeforeSendForHarness = () => { if (!hit) { hit = true; ChartBridgeServer.StopGate(0); } };   // the stop lands in the gap
            int m0 = MadeCount();
            Msg(a, "{\"type\":\"subscribe\",\"root\":\"MNQ\",\"days\":5,\"tickHours\":2,\"sub\":1,\"liveFirst\":true}");
            foreach (BarsRequest r in Made(m0).Where(IsMinute1)) r.Answer(new Bars(), ErrorCode.NoError);
            Check(WaitFor(() => hit, 3000), "lf7 N3: the stop came between taking the window and sending it");
            Thread.Sleep(300);
            Check(!Made(m0).Any(IsWin), "lf7 N3: no window went to NinjaTrader after the stop (" + Made(m0).Count(IsWin) + ")");
            Check(WaitFor(() => Of(la, "ready").Count == 1, 3000), "lf7 N3: and its page is answered (no trades), not left waiting");
        }
        finally { ChartBridgeServer.GateBeforeSendForHarness = null; Drop(a); ChartBridgeServer.WindowFirstGuess = fgWas; Priv("StartGate"); ChartBridgeServer.ResetBooks(DateTime.MinValue); }
    }
}
