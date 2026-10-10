// Daily 1-minute bars to The Desk (ChartBridge 0.3.6, ChartBridgeBars.cs), run for real on Mono inside check:orders
// (SeamHarness.Run calls BarsHarness.Run last). First the pure rules: the session date (18:00 New York start, Sunday open to
// Monday, daylight saving in March and November, early closes), NinjaTrader's close stamps to open times in UTC from
// several NinjaTrader time zones, which sessions the catch-up picks, the contract per root and session, the message.
// Then the failure scenarios, each through ChartBridgeServer's own gate (0.3.5) with the stand-in BarsRequest, a stand-in
// Desk and the bars worker thread:
//   S1 OffByDefault, S2 OneSession (both daylight saving changes, Sunday's open), S3 DeskUnreachable, S4 CatchUpAtStart,
//   S5 NeverBesideTheChart (a window out, a window queued behind bars, a backfill to come, a stuck gate, a bars request
//   NinjaTrader never answers), S6 StopDuringRequest (and during a post), S7 ContractPerRoot, S8 Diag, and RTH.
// Made-up prices and a made-up account name; nothing here is market data.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript.AddOns;

public static class BarsHarness
{
    static Action<bool, string> Check;
    static object Priv(string name, params object[] args) { return typeof(ChartBridgeServer).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, args); }
    static System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient> Clients()
    {
        return (System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
    }
    static Dictionary<string, Instrument> Named() { return (Dictionary<string, Instrument>)typeof(ChartBridgeServer).GetField("Instruments", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null); }
    static bool WaitFor(Func<bool> ok, int ms = 5000) { for (int i = 0; i < ms / 5 && !ok(); i++) Thread.Sleep(5); return ok(); }

    static TimeZoneInfo Zone(string id) { return TimeZoneInfo.FindSystemTimeZoneById(id); }
    static TimeZoneInfo NY, Chicago, London, Tokyo;
    static DateTime D(int y, int m, int d) { return new DateTime(y, m, d); }
    static DateTime W(int y, int mo, int d, int h, int mi) { return new DateTime(y, mo, d, h, mi, 0); }
    static DateTime Utc(int y, int mo, int d, int h, int mi) { return new DateTime(y, mo, d, h, mi, 0, DateTimeKind.Utc); }
    static DateTime EtToUtc(DateTime etWall) { return TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(etWall, DateTimeKind.Unspecified), NY); }
    static long Ms(DateTime utc) { return (long)Math.Round((utc - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds); }
    // New York wall time as NinjaTrader shows it in its (stand-in) time zone.
    static DateTime NtOf(DateTime etWall) { return TimeZoneInfo.ConvertTimeFromUtc(TimeZoneInfo.ConvertTimeToUtc(etWall, NY), NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo); }
    static void NtZone(TimeZoneInfo z) { NinjaTrader.Core.GeneralOptionsClass.Zone = z; }
    static bool Logged(string has) { lock (NinjaTrader.Code.Output.Lines) return NinjaTrader.Code.Output.Lines.Any(x => x.Contains(has)); }

    // Close-stamped minute bars, as NinjaTrader would hand them over, for every minute the market is open between two
    // New York wall times (open minutes), prices made up from the minute.
    static RawBars Minutes(DateTime etFrom, DateTime etTo, Func<DateTime, bool> open)
    {
        List<DateTime> t = new List<DateTime>();
        for (DateTime m = etFrom; m < etTo; m = m.AddMinutes(1)) if (open == null || open(m)) t.Add(m);
        RawBars r = new RawBars { Count = t.Count, Time = new DateTime[t.Count], Open = new double[t.Count], High = new double[t.Count], Low = new double[t.Count], Close = new double[t.Count], Volume = new long[t.Count] };
        for (int i = 0; i < t.Count; i++)
        {
            r.Time[i] = NtOf(t[i].AddMinutes(1));   // stamped at its close
            double p = 25000 + (t[i].Minute % 7) * 0.25;
            r.Open[i] = p; r.High[i] = p + 1; r.Low[i] = p - 0.5; r.Close[i] = p + 0.25; r.Volume[i] = 10 + t[i].Minute;
        }
        return r;
    }
    static bool Trading(DateTime et) { return ChartBridgeBars.SessionDateOfEt(et) != DateTime.MinValue; }

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        NY = Zone("America/New_York"); Chicago = Zone("America/Chicago"); London = Zone("Europe/London"); Tokyo = Zone("Asia/Tokyo");
        // Linux has no Windows time zone names; ChartBridge asks for "Eastern Standard Time".
        typeof(ChartBridgeTime).GetField("et", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, NY);
        string dirWas = NinjaTrader.Core.Globals.UserDataDir, urlWas = ChartBridgeConfig.DeskUrl;
        string dir = Path.Combine(Path.GetTempPath(), "cb-bars-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(dir, "ChartBridge"));
        NinjaTrader.Core.Globals.UserDataDir = dir;
        // The order harness's stand-in accounts are not this harness's: their executions would add contracts.
        List<Account> accountsWas; lock (Account.All) { accountsWas = Account.All.ToList(); Account.All.Clear(); }
        Dictionary<string, string> overrideWas = new Dictionary<string, string>(ChartBridgeConfig.ContractOverride);
        ChartBridgeConfig.ContractOverride.Clear();
        // Stand-in pages other harnesses left subscribed would read as "a chart is loading": set aside while these cases run.
        Dictionary<int, ChartBridgeClient> pagesWas = Clients().ToDictionary(kv => kv.Key, kv => kv.Value);
        Clients().Clear();
        Console.WriteLine("     (bars: " + pagesWas.Count + " stand-in page(s) from earlier cases set aside: " + string.Join(", ", pagesWas.Values.Select(c => c.Id + (c.Root != null ? " " + c.Root : "") + (c.Ready ? " ready" : " loading")).ToArray()) + ")");
        int pauseWas = ChartBridgeBars.PauseBetweenMs;
        ChartBridgeBars.PauseBetweenMs = 0;
        ChartBridgeBars.ResetConfig();
        try
        {
            SessionDates();
            SessionBounds();
            Stamps();
            SessionBarsCases();
            CatchUpPick();
            Contracts();
            Message();
            Config();
            S1OffByDefault(dir);
            S2OneSession(dir);
            S3DeskUnreachable(dir);
            N1QueueAgeAndRefusals(dir);   // 0.3.7: review bars1 N1
            N7ReadOffNtThread(dir);       // 0.3.7: review bars1 N7
            S4CatchUpAtStart(dir);
            S5NeverBesideTheChart(dir);
            S6StopDuringRequest(dir);
            S7ContractPerRoot(dir);
            S8Diag(dir);
            Rth(dir);
        }
        catch (Exception ex) { Check(false, "bars harness threw: " + ex); }
        finally
        {
            ChartBridgeBars.Stop();
            BarsRequest.AutoAnswer = null;
            ChartBridgeBars.ResetConfig();
            ChartBridgeBars.PauseBetweenMs = pauseWas;
            ChartBridgeBars.UtcNow = () => DateTime.UtcNow;
            ChartBridgeBars.Lookup = name => Instrument.GetInstrument(name);
            ChartBridgeServer.ClockForHarness = null;
            ChartBridgeServer.ResetBooks(DateTime.MinValue);
            NtZone(null);
            ChartBridgeConfig.ContractOverride.Clear();
            foreach (KeyValuePair<string, string> kv in overrideWas) ChartBridgeConfig.ContractOverride[kv.Key] = kv.Value;
            lock (Account.All) { Account.All.Clear(); Account.All.AddRange(accountsWas); }
            foreach (KeyValuePair<int, ChartBridgeClient> kv in pagesWas) Clients()[kv.Key] = kv.Value;
            NinjaTrader.Core.Globals.UserDataDir = dirWas; ChartBridgeConfig.DeskUrl = urlWas;
        }
    }

    // ------------------------------------------------------------ the session date
    static void SessionDates()
    {
        Func<DateTime, string> S = et => { DateTime d = ChartBridgeBars.SessionDateOfEt(et); return d == DateTime.MinValue ? "shut" : d.ToString("yyyy-MM-dd ddd"); };
        Check(S(W(2026, 9, 30, 9, 30)) == "2026-09-30 Wed", "bars: Wednesday 09:30 ET is Wednesday's session");
        Check(S(W(2026, 9, 29, 18, 0)) == "2026-09-30 Wed", "bars: Tuesday 18:00 ET opens Wednesday's session");
        Check(S(W(2026, 9, 29, 17, 59)) == "shut", "bars: Tuesday 17:59 ET is the daily break");
        Check(S(W(2026, 9, 29, 16, 59)) == "2026-09-29 Tue", "bars: Tuesday 16:59 ET is still Tuesday's session");
        Check(S(W(2026, 9, 29, 17, 0)) == "shut", "bars: Tuesday 17:00 ET: Tuesday's session is over");
        Check(S(W(2026, 10, 2, 16, 59)) == "2026-10-02 Fri", "bars: Friday 16:59 ET is Friday's session");
        Check(S(W(2026, 10, 2, 18, 30)) == "shut", "bars: Friday 18:30 ET: no session (weekend)");
        Check(S(W(2026, 10, 3, 12, 0)) == "shut", "bars: Saturday: no session");
        Check(S(W(2026, 10, 4, 17, 59)) == "shut", "bars: Sunday 17:59 ET: no session yet");
        Check(S(W(2026, 10, 4, 18, 0)) == "2026-10-05 Mon", "bars: the Sunday 18:00 ET open belongs to Monday");
        Check(S(W(2026, 10, 4, 23, 0)) == "2026-10-05 Mon", "bars: Sunday evening is Monday's session");
        // DST: March 8 2026 and November 1 2026 (Sundays, 2 AM, market shut)
        Check(S(W(2026, 3, 8, 18, 0)) == "2026-03-09 Mon", "bars: March DST Sunday: 18:00 EDT opens Monday's session");
        Check(S(W(2026, 11, 1, 18, 0)) == "2026-11-02 Mon", "bars: November DST Sunday: 18:00 EST opens Monday's session");
        // Thanksgiving 2026: Thursday halts early (13:00 ET), Friday opens Thursday 18:00 ET and closes early (13:15 ET)
        Check(S(W(2026, 11, 26, 12, 59)) == "2026-11-26 Thu", "bars: Thanksgiving Thursday morning is Thursday's session");
        Check(S(W(2026, 11, 26, 18, 0)) == "2026-11-27 Fri", "bars: Thanksgiving Thursday 18:00 ET opens Friday's (early close) session");
        Check(S(W(2026, 11, 27, 13, 14)) == "2026-11-27 Fri", "bars: the day after Thanksgiving 13:14 ET is Friday's session");
    }

    static void SessionBounds()
    {
        Action<DateTime, DateTime, DateTime, string> B = (s, o, c, what) =>
        {
            DateTime ou, cu; ChartBridgeBars.SessionUtc(s, out ou, out cu);
            Check(ou == o && cu == c && (cu - ou).TotalHours == 23, "bars: " + what + ": " + ou.ToString("u") + " to " + cu.ToString("u"));
        };
        B(D(2026, 9, 30), Utc(2026, 9, 29, 22, 0), Utc(2026, 9, 30, 21, 0), "summer session (EDT)");
        B(D(2026, 3, 6), Utc(2026, 3, 5, 23, 0), Utc(2026, 3, 6, 22, 0), "the Friday before March DST (EST)");
        B(D(2026, 3, 9), Utc(2026, 3, 8, 22, 0), Utc(2026, 3, 9, 21, 0), "the Monday after March DST (EDT, Sunday open already EDT)");
        B(D(2026, 10, 30), Utc(2026, 10, 29, 22, 0), Utc(2026, 10, 30, 21, 0), "the Friday before November DST (EDT)");
        B(D(2026, 11, 2), Utc(2026, 11, 1, 23, 0), Utc(2026, 11, 2, 22, 0), "the Monday after November DST (EST)");
        B(D(2026, 10, 5), Utc(2026, 10, 4, 22, 0), Utc(2026, 10, 5, 21, 0), "a Monday: Sunday 18:00 ET to Monday 17:00 ET");
    }

    // ------------------------------------------------------------ close stamps to open times
    static void Stamps()
    {
        long want = Ms(Utc(2026, 9, 30, 13, 30));   // 09:30 ET open
        foreach (TimeZoneInfo z in new TimeZoneInfo[] { NY, Chicago, London, Tokyo, TimeZoneInfo.Utc })
        {
            NtZone(z);
            long got = ChartBridgeBars.OpenUtcMs(NtOf(W(2026, 9, 30, 9, 31)));
            Check(got == want, "bars: NinjaTrader in " + z.Id + ": the bar stamped 09:31 ET opened 09:30 ET = " + got);
        }
        // London is one hour closer to New York between the US (March 8) and UK (March 29) changes
        NtZone(London);
        DateTime stamp = NtOf(W(2026, 3, 10, 10, 1));
        Check(stamp == W(2026, 3, 10, 14, 1), "bars: NinjaTrader in London on 2026-03-10 shows the 10:01 ET close as 14:01 (" + stamp + ")");
        Check(ChartBridgeBars.OpenUtcMs(stamp) == Ms(Utc(2026, 3, 10, 14, 0)), "bars: and its open is 14:00 UTC");
        NtZone(Chicago);
        Check(ChartBridgeBars.OpenUtcMs(W(2026, 9, 29, 17, 1)) == Ms(Utc(2026, 9, 29, 22, 0)), "bars: NinjaTrader in Chicago: the session's first bar (17:01 CT) opened 18:00 ET");
        NtZone(null);
    }

    static void SessionBarsCases()
    {
        DateTime late = Utc(2027, 1, 1, 0, 0);
        foreach (TimeZoneInfo z in new TimeZoneInfo[] { NY, Chicago, London, Tokyo })
        {
            NtZone(z);
            RawBars raw = Minutes(W(2026, 9, 29, 15, 0), W(2026, 9, 30, 19, 0), Trading);
            List<DeskBar> b = ChartBridgeBars.SessionBars(raw, D(2026, 9, 30), late);
            Check(b.Count == 1380 && b[0].T == Ms(Utc(2026, 9, 29, 22, 0)) && b[b.Count - 1].T == Ms(Utc(2026, 9, 30, 20, 59)),
                  "bars: NinjaTrader in " + z.Id + ": session 2026-09-30 is 1380 bars, 18:00 ET to the 16:59 ET open (" + b.Count + ")");
        }
        NtZone(Chicago);
        RawBars wk = Minutes(W(2026, 10, 2, 12, 0), W(2026, 10, 5, 18, 0), Trading);
        List<DeskBar> mon = ChartBridgeBars.SessionBars(wk, D(2026, 10, 5), late);
        Check(mon.Count == 1380 && mon[0].T == Ms(Utc(2026, 10, 4, 22, 0)), "bars: Monday 2026-10-05: 1380 bars from Sunday 18:00 ET");
        List<DeskBar> fri = ChartBridgeBars.SessionBars(wk, D(2026, 10, 2), late);
        Check(fri.Count == 300 && fri[fri.Count - 1].T == Ms(Utc(2026, 10, 2, 20, 59)), "bars: Friday: only Friday's bars (from 12:00 in this sample) up to the 16:59 ET open (" + fri.Count + ")");
        NtZone(London);   // NinjaTrader set to London in the US-only DST weeks
        List<DeskBar> marL = ChartBridgeBars.SessionBars(Minutes(W(2026, 3, 8, 12, 0), W(2026, 3, 9, 18, 0), Trading), D(2026, 3, 9), late);
        Check(marL.Count == 1380 && marL[0].T == Ms(Utc(2026, 3, 8, 22, 0)), "bars: March DST Monday, NinjaTrader in London (UK clocks not changed yet)");
        List<DeskBar> octL = ChartBridgeBars.SessionBars(Minutes(W(2026, 10, 25, 12, 0), W(2026, 10, 26, 18, 0), Trading), D(2026, 10, 26), late);
        Check(octL.Count == 1380 && octL[0].T == Ms(Utc(2026, 10, 25, 22, 0)), "bars: Monday 2026-10-26, NinjaTrader in London (UK clocks already back)");
        // Thanksgiving: Thursday halts at 13:00 ET, reopens 18:00 ET for Friday, which closes at 13:15 ET
        NtZone(Chicago);
        Func<DateTime, bool> thanks = et => Trading(et) && !(et.Date == D(2026, 11, 26) && et.Hour >= 13 && et.Hour < 17) && !(et.Date == D(2026, 11, 27) && (et.Hour > 13 || (et.Hour == 13 && et.Minute >= 15)));
        RawBars tg = Minutes(W(2026, 11, 25, 12, 0), W(2026, 11, 27, 18, 0), thanks);
        List<DeskBar> thu = ChartBridgeBars.SessionBars(tg, D(2026, 11, 26), late);
        List<DeskBar> fr = ChartBridgeBars.SessionBars(tg, D(2026, 11, 27), late);
        Check(thu.Count == 1140 && thu[thu.Count - 1].T == Ms(Utc(2026, 11, 26, 17, 59)), "bars: Thanksgiving Thursday: Wednesday 18:00 ET to the 12:59 ET open, 1140 bars (" + thu.Count + ")");
        Check(fr.Count == 1155 && fr[0].T == Ms(Utc(2026, 11, 26, 23, 0)) && fr[fr.Count - 1].T == Ms(Utc(2026, 11, 27, 18, 14)), "bars: the Friday after: Thursday 18:00 ET to the 13:14 ET open, 1155 bars (" + fr.Count + ")");
        // never an unfinished bar; sorted; one per minute
        RawBars mid = Minutes(W(2026, 9, 29, 18, 0), W(2026, 9, 30, 12, 0), Trading);
        List<DeskBar> part = ChartBridgeBars.SessionBars(mid, D(2026, 9, 30), Utc(2026, 9, 30, 13, 30).AddSeconds(59));
        Check(part.Count > 0 && part[part.Count - 1].T == Ms(Utc(2026, 9, 30, 13, 29)), "bars: a bar still forming at 'now' is never included (last open 09:29 ET at 09:30:59 ET)");
        RawBars shuffled = Minutes(W(2026, 9, 29, 18, 0), W(2026, 9, 29, 18, 5), Trading);
        Array.Reverse(shuffled.Time); Array.Reverse(shuffled.Open); Array.Reverse(shuffled.High); Array.Reverse(shuffled.Low); Array.Reverse(shuffled.Close); Array.Reverse(shuffled.Volume);
        RawBars dup = new RawBars { Count = shuffled.Count + 1, Time = shuffled.Time.Concat(new[] { shuffled.Time[0] }).ToArray(), Open = shuffled.Open.Concat(new[] { 1.0 }).ToArray(),
                                   High = shuffled.High.Concat(new[] { 2.0 }).ToArray(), Low = shuffled.Low.Concat(new[] { 0.5 }).ToArray(), Close = shuffled.Close.Concat(new[] { 1.5 }).ToArray(), Volume = shuffled.Volume.Concat(new[] { 7L }).ToArray() };
        List<DeskBar> sd = ChartBridgeBars.SessionBars(dup, D(2026, 9, 30), late);
        bool sorted = true; for (int i = 1; i < sd.Count; i++) if (sd[i].T <= sd[i - 1].T) sorted = false;
        Check(sd.Count == 5 && sorted && sd[4].O == 1.0 && sd[4].V == 7, "bars: rows come out sorted, one per minute (a repeated minute keeps NinjaTrader's later row)");
        Check(ChartBridgeBars.SessionBars(null, D(2026, 9, 30), late).Count == 0, "bars: no bars: an empty list, no exception");
        NtZone(null);
    }

    // ------------------------------------------------------------ which sessions the catch-up picks
    static string Days(List<DateTime> l) { return string.Join(",", l.Select(d => d.ToString("MM-dd"))); }
    static void CatchUpPick()
    {
        Func<DateTime, bool> none = d => false;
        Check(Days(ChartBridgeBars.RecentSessions(W(2026, 9, 30, 10, 0), 5, none)) == "09-29,09-28,09-25,09-24,09-23", "bars: Wednesday morning: the last 5 closed sessions, weekends skipped");
        Check(Days(ChartBridgeBars.RecentSessions(W(2026, 9, 30, 17, 4), 5, none)) == "09-29,09-28,09-25,09-24,09-23", "bars: 17:04 ET: today's session is not taken yet (close + 5 minutes)");
        Check(Days(ChartBridgeBars.RecentSessions(W(2026, 9, 30, 17, 5), 5, none)) == "09-30,09-29,09-28,09-25,09-24", "bars: 17:05 ET: today's session is due");
        Check(Days(ChartBridgeBars.RecentSessions(W(2026, 10, 4, 20, 0), 5, none)) == "10-02,10-01,09-30,09-29,09-28", "bars: Sunday evening: Friday first");
        Check(Days(ChartBridgeBars.RecentSessions(W(2026, 10, 5, 9, 0), 5, none)) == "10-02,10-01,09-30,09-29,09-28", "bars: Monday morning: Monday's session is not closed yet");
        Func<DateTime, bool> xmas = d => d == D(2026, 12, 25);
        Check(Days(ChartBridgeBars.RecentSessions(W(2026, 12, 28, 10, 0), 5, xmas)) == "12-24,12-23,12-22,12-21,12-18", "bars: a full holiday (Christmas, Friday) is skipped");
        Func<DateTime, bool> goodFriday = d => d == D(2027, 3, 26);
        Check(Days(ChartBridgeBars.RecentSessions(W(2027, 3, 29, 18, 0), 3, goodFriday)) == "03-29,03-25,03-24", "bars: Good Friday is skipped");
        Check(Days(ChartBridgeBars.RecentSessions(W(2026, 11, 27, 17, 10), 2, none)) == "11-27,11-26", "bars: early-close days are ordinary sessions");
        Check(ChartBridgeBars.RecentSessions(W(2026, 9, 30, 10, 0), 5, d => { throw new Exception("x"); }).Count == 5, "bars: a holiday check that throws is taken as no holiday");
        Check(ChartBridgeBars.InRth(W(2026, 9, 30, 9, 30)) && ChartBridgeBars.InRth(W(2026, 9, 30, 16, 14)) && !ChartBridgeBars.InRth(W(2026, 9, 30, 9, 29)) &&
              !ChartBridgeBars.InRth(W(2026, 9, 30, 16, 15)) && !ChartBridgeBars.InRth(W(2026, 10, 3, 11, 0)), "bars: regular trading hours are 09:30 to 16:15 ET on weekdays");
    }

    static void Contracts()
    {
        ChartBridgeConfig.ContractOverride.Clear();
        Check(ChartBridgeBars.FrontContract("MNQ", D(2026, 12, 9)) == "MNQ 12-26", "bars: front month the day before the December roll (Thursday 2026-12-10): MNQ 12-26");
        Check(ChartBridgeBars.FrontContract("MNQ", D(2026, 12, 10)) == "MNQ 03-27", "bars: on the roll day: MNQ 03-27 (the chart's rule)");
        Check(ChartBridgeBars.FrontContract("ES", D(2026, 9, 30)) == "ES 12-26", "bars: ES on 2026-09-30: ES 12-26");
        ChartBridgeConfig.ContractOverride["NQ"] = "NQ 03-27";
        Check(ChartBridgeBars.FrontContract("NQ", D(2026, 9, 30)) == "NQ 03-27", "bars: contract.NQ in config.txt wins, as on the chart");
        ChartBridgeConfig.ContractOverride.Clear();
        List<DateTime> s = new List<DateTime> { D(2026, 9, 10), D(2026, 9, 9) };
        List<BarsJob> fills = new List<BarsJob>
        {
            new BarsJob { Session = D(2026, 9, 10), Root = "MNQ", Contract = "MNQ 09-26" },   // traded the old contract on the roll day
            new BarsJob { Session = D(2026, 9, 10), Root = "MNQ", Contract = "MNQ 09-26" },   // twice
            new BarsJob { Session = D(2026, 9, 10), Root = "MNQ", Contract = "MNQ 12-26" },   // the front month itself
            new BarsJob { Session = D(2026, 9, 10), Root = "CL", Contract = "CL 11-26" },     // not one of our roots
            new BarsJob { Session = D(2026, 9, 4), Root = "MNQ", Contract = "MNQ 09-26" },    // not one of these sessions
        };
        List<BarsJob> w = ChartBridgeBars.Wanted(s, new string[] { "MNQ", "ES" }, fills);
        Check(string.Join(" | ", w.Select(j => j.Key)) == "2026-09-10 MNQ 12-26 | 2026-09-10 ES 12-26 | 2026-09-10 MNQ 09-26 | 2026-09-09 MNQ 09-26 | 2026-09-09 ES 09-26",
              "bars: wanted: newest session first, each root's front month, plus another contract traded that session, once: " + string.Join(" | ", w.Select(j => j.Key)));
    }

    static void Message()
    {
        string pcWas = ChartBridgeBars.Pc;
        ChartBridgeBars.Pc = "HOME";
        List<DeskBar> b = new List<DeskBar>
        {
            new DeskBar { T = 1759269600000, O = 25900.25, H = 25901.0, L = 25899.75, C = 25900.5, V = 132 },
            new DeskBar { T = 1759269660000, O = 25900.5, H = 25900.5, L = 25900.5, C = 25900.5, V = 1 },
        };
        string m = ChartBridgeBars.MessageJson("MNQ 12-26", "MNQ", 0.25, D(2026, 9, 30), b);
        string want = "{\"v\":1,\"source\":\"chartbridge\",\"bridge\":\"" + ChartBridgeServer.Version + "\",\"pc\":\"HOME\",\"contract\":\"MNQ 12-26\",\"root\":\"MNQ\",\"tick\":0.25," +
                      "\"session\":\"2026-09-30\",\"tf\":\"1m\",\"stamp\":\"open\",\"bars\":[[1759269600000,25900.25,25901,25899.75,25900.5,132],[1759269660000,25900.5,25900.5,25900.5,25900.5,1]],\"complete\":true}";
        Check(m == want, "bars: the message is contract v1, field for field: " + m);
        Check(ChartBridgeBarsQueue.KeyOfLine(m) == "2026-09-30 MNQ 12-26", "bars: its queue key is the session and contract");
        Check(ChartBridgeBarsQueue.KeyOfLine(m.Substring(0, m.Length - 5)) == null, "bars: a line cut short has no key");
        ChartBridgeBars.Pc = "";
        Check(ChartBridgeBars.PcName() == Environment.MachineName, "bars: no pc in config.txt: the Windows computer name");
        ChartBridgeBars.Pc = pcWas;
    }

    static void Config()
    {
        ChartBridgeBars.ResetConfig();
        Check(!ChartBridgeBars.Enabled && string.Join(",", ChartBridgeBars.Roots) == "NQ,MNQ,ES,MES", "bars: off by default; NQ, MNQ, ES, MES by default");
        Check(ChartBridgeBars.ReadConfig("bars", "on") && ChartBridgeBars.Enabled, "bars: bars = on turns it on");
        ChartBridgeBars.ReadConfig("bars", "off");
        Check(!ChartBridgeBars.Enabled, "bars: bars = off turns it off");
        ChartBridgeBars.ReadConfig("barsRoots", " mnq , es ");
        Check(string.Join(",", ChartBridgeBars.Roots) == "MNQ,ES", "bars: barsRoots");
        ChartBridgeBars.ReadConfig("pc", "WORK");
        Check(ChartBridgeBars.PcName() == "WORK", "bars: pc");
        Check(!ChartBridgeBars.ReadConfig("trading", "true"), "bars: other keys are not taken");
        ChartBridgeBars.ResetConfig();
    }

    // ------------------------------------------------------------ a stand-in Desk
    class Desk
    {
        public HttpListener L; public int Port; public readonly List<string> Bodies = new List<string>();
        public Func<string, int> Status = body => 200;
        public int HoldMs;   // answer this late
        public Desk()
        {
            for (int tries = 0; ; tries++)
            {
                Port = 20000 + new Random().Next(20000);
                try { L = new HttpListener(); L.Prefixes.Add("http://127.0.0.1:" + Port + "/"); L.Start(); break; }
                catch (Exception) { if (tries > 20) throw; }
            }
            HttpListener l = L;
            Task.Run(() =>
            {
                while (l.IsListening)
                {
                    HttpListenerContext ctx;
                    try { ctx = l.GetContext(); } catch (Exception) { break; }
                    HttpListenerContext c = ctx;
                    Task.Run(() =>
                    {
                        try
                        {
                            string body; using (StreamReader r = new StreamReader(c.Request.InputStream)) body = r.ReadToEnd();
                            if (c.Request.Url.AbsolutePath != "/api/bars") { c.Response.StatusCode = 404; c.Response.Close(); return; }
                            lock (Bodies) Bodies.Add(body);
                            if (HoldMs > 0) Thread.Sleep(HoldMs);
                            int code = Status(body);
                            string ans = code == 200 ? "{\"ok\":true,\"stored\":1}" : "{\"detail\":\"bars must be a list\"}";
                            byte[] b = System.Text.Encoding.UTF8.GetBytes(ans);
                            c.Response.StatusCode = code; c.Response.OutputStream.Write(b, 0, b.Length); c.Response.Close();
                        }
                        catch (Exception) { }
                    });
                }
            });
        }
        public string Url { get { return "http://127.0.0.1:" + Port; } }
        public int Count { get { lock (Bodies) return Bodies.Count; } }
        public List<string> All() { lock (Bodies) return Bodies.ToList(); }
        public void Stop() { try { L.Stop(); L.Close(); } catch (Exception) { } }
    }

    static string[] Lines(string dir, string name) { string f = Path.Combine(dir, "ChartBridge", name); return File.Exists(f) ? File.ReadAllLines(f).Where(x => x.Trim().Length > 0).ToArray() : new string[0]; }
    static string Session(string body) { return Regex.Match(body, "\"session\":\"([^\"]+)\"").Groups[1].Value; }
    static string Contract(string body) { return Regex.Match(body, "\"contract\":\"([^\"]+)\"").Groups[1].Value; }
    static List<long> Ts(string body) { return Regex.Matches(body, "\\[(\\d{13}),").Cast<Match>().Select(m => long.Parse(m.Groups[1].Value)).ToList(); }

    // ------------------------------------------------------------ the stand-in NinjaTrader for bars requests
    static Instrument Inst(string name)
    {
        string root = name.Split(' ')[0];
        return new Instrument { FullName = name, MasterInstrument = new MasterInstrument { Name = root, TickSize = 0.25, PointValue = root == "MNQ" ? 2 : root == "MES" ? 5 : root == "ES" ? 50 : 20, TradingHours = new TradingHours { Name = "CME US Index Futures ETH" } } };
    }
    // A bars request is the only one with MergePolicy DoNotMerge (the stand-in's default is NinjaTrader's global setting).
    static bool IsBars(BarsRequest r) { return r.MergePolicy == MergePolicy.DoNotMerge; }
    static List<BarsRequest> Made(int from) { lock (BarsRequest.Made) return BarsRequest.Made.Skip(from).ToList(); }
    static List<BarsRequest> BarsMade(int from) { return Made(from).Where(IsBars).ToList(); }
    // The session a bars request asks for: it asks to the day after the session's close (NinjaTrader's dates), or to now.
    static DateTime SessionOf(BarsRequest r) { return r.To.TimeOfDay == TimeSpan.Zero ? r.To.Date.AddDays(-1) : r.To.Date; }
    static int MadeCount() { lock (BarsRequest.Made) return BarsRequest.Made.Count; }
    static Func<BarsRequest, bool> answerEmpty = r => false;   // per case: which bars requests get no bars
    static bool AnswerLikeNt(BarsRequest r)
    {
        if (!IsBars(r)) return false;
        Bars b = new Bars();
        if (!answerEmpty(r))
        {
            // Every open minute between from (a date, NinjaTrader's time) and to, stamped at its close in NinjaTrader's zone.
            TimeZoneInfo nt = NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo;
            DateTime fromEt = TimeZoneInfo.ConvertTimeFromUtc(TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(r.From, DateTimeKind.Unspecified), nt), NY);
            DateTime toEt = TimeZoneInfo.ConvertTimeFromUtc(TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(r.To, DateTimeKind.Unspecified), nt), NY);
            RawBars raw = Minutes(new DateTime(fromEt.Year, fromEt.Month, fromEt.Day, fromEt.Hour, fromEt.Minute, 0), toEt.AddMinutes(-1), Trading);
            for (int i = 0; i < raw.Count; i++) b.Add(raw.Time[i], raw.Open[i], raw.High[i], raw.Low[i], raw.Close[i], raw.Volume[i]);
        }
        r.Answer(b, ErrorCode.NoError);
        return true;
    }
    static void AnswerBars(BarsRequest r) { AnswerLikeNtAlways(r); }
    static void AnswerLikeNtAlways(BarsRequest r) { Func<BarsRequest, bool> was = answerEmpty; answerEmpty = x => false; AnswerLikeNt(r); answerEmpty = was; }

    static bool connected;
    // A clean start for a case: bars on (unless off), no queue, no record, the gate idle, NinjaTrader connected and answering.
    static Desk Fresh(string dir, string roots, DateTime nowUtc)
    {
        ChartBridgeBars.Stop();
        ChartBridgeBars.ResetConfig();
        ChartBridgeBars.Start();   // bars off: resets what the worker remembers, starts nothing
        ChartBridgeBars.ReadConfig("bars", "on");
        if (roots != null) ChartBridgeBars.ReadConfig("barsRoots", roots);
        ChartBridgeBars.ReadConfig("pc", "HOME");
        ChartBridgeBars.CatchUpSessions = 5; ChartBridgeBars.RequestTimeoutMs = 60000; ChartBridgeBars.QueueWaitMs = 60000; ChartBridgeBars.MaxTries = 3;
        ChartBridgeBars.TickMs = 10000; ChartBridgeBars.SettleMs = 120000; ChartBridgeBars.PlanEveryMs = 60000;
        foreach (string f in new[] { "pending_bars.jsonl", "sent_bars.txt", "rejected_bars.jsonl", "refused_bars.txt", "config.txt" }) File.Delete(Path.Combine(dir, "ChartBridge", f));
        ChartBridgeBarsQueue.Load();
        ChartBridgeServer.ResetBooks(DateTime.MinValue);
        ChartBridgeBars.Lookup = name => Inst(name);
        ChartBridgeBars.UtcNow = () => nowUtc;
        connected = true;
        ChartBridgeBars.IsConnected = () => connected;
        answerEmpty = r => false;
        BarsRequest.AutoAnswer = AnswerLikeNt;
        NtZone(Chicago);
        Desk desk = new Desk();
        ChartBridgeConfig.DeskUrl = desk.Url;
        return desk;
    }
    static string Diag() { return ChartBridgeBars.DiagJson(); }
    static string Gate() { return Regex.Match((string)Priv("BooksJson"), "\"gate\":\\{[^}]*\\}").Value; }
    static Thread BarsThread() { return (Thread)typeof(ChartBridgeBars).GetField("worker", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null); }

    // ------------------------------------------------------------ S1: off by default
    static void S1OffByDefault(string dir)
    {
        Desk desk = Fresh(dir, null, Utc(2026, 9, 30, 21, 6));
        List<string> originsWas = ChartBridgeConfig.AllowOrigins;
        try
        {
            // config.txt with other settings and no bars line, as on every PC today
            File.WriteAllText(Path.Combine(dir, "ChartBridge", "config.txt"), "# no bars line\nrangeHours = 2\npostFills = false\n");
            ChartBridgeConfig.Load();
            Check(!ChartBridgeBars.Enabled, "S1 OffByDefault: config.txt with no bars line leaves the daily bars off");
            ChartBridgeBars.TickMs = 20; ChartBridgeBars.SettleMs = 0; ChartBridgeBars.PlanEveryMs = 0;
            int m0 = MadeCount();
            ChartBridgeBars.Start();
            Thread.Sleep(300);
            ChartBridgeBars.PlanOnce(null);
            ChartBridgeBarsQueue.Queue("2026-09-30 MNQ 12-26", ChartBridgeBars.MessageJson("MNQ 12-26", "MNQ", 0.25, D(2026, 9, 30), new List<DeskBar> { new DeskBar { T = Ms(Utc(2026, 9, 30, 13, 30)), O = 1, H = 1, L = 1, C = 1, V = 1 } }));
            ChartBridgeBarsQueue.Flush();
            Check(BarsThread() == null && Made(m0).Count == 0 && desk.Count == 0 && Diag().StartsWith("{\"enabled\":false,\"state\":\"off\""),
                "S1 OffByDefault: no worker, no BarsRequest of any kind, nothing posted (" + Made(m0).Count + " requests, " + desk.Count + " posts): " + Diag());
            File.WriteAllText(Path.Combine(dir, "ChartBridge", "config.txt"), "bars = on\n");
            ChartBridgeConfig.Load();
            Check(ChartBridgeBars.Enabled, "S1 OffByDefault: bars = on in config.txt turns it on");
        }
        finally
        {
            File.Delete(Path.Combine(dir, "ChartBridge", "config.txt"));
            ChartBridgeConfig.Load();
            OrdersHarness.AllOffLines();   // the base checks run with every v3 off line (0.3.8 exactly); Load put the default, on
            ChartBridgeConfig.AllowOrigins = originsWas;
            ChartBridgeConfig.DeskUrl = desk.Url;
            desk.Stop();
        }
    }

    // ------------------------------------------------------------ S2: one session sent correctly
    static bool GoodSession(string body, DateTime session, out string why)
    {
        List<long> t = Ts(body);
        DateTime ou, cu; ChartBridgeBars.SessionUtc(session, out ou, out cu);
        bool sorted = true; for (int i = 1; i < t.Count; i++) if (t[i] <= t[i - 1]) sorted = false;
        bool minutes = t.All(x => x % 60000 == 0);
        bool rows = Regex.Matches(body, "\\[(\\d{13}),([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+),(\\d+)\\]").Count == t.Count;
        why = t.Count + " bars, " + (t.Count > 0 ? DateTimeOffset.FromUnixTimeMilliseconds(t[0]).UtcDateTime.ToString("u") + " to " + DateTimeOffset.FromUnixTimeMilliseconds(t[t.Count - 1]).UtcDateTime.ToString("u") : "none");
        return t.Count == 1380 && sorted && minutes && rows && t[0] == Ms(ou) && t[t.Count - 1] == Ms(cu) - 60000 && body.EndsWith("]],\"complete\":true}") &&
               Session(body) == session.ToString("yyyy-MM-dd") && body.Contains("\"tf\":\"1m\",\"stamp\":\"open\"");
    }
    static void S2OneSession(string dir)
    {
        foreach (var c in new[] {
            new { Now = EtToUtc(W(2026, 9, 30, 17, 6)), Session = D(2026, 9, 30), Zone = Chicago, What = "a summer Wednesday, NinjaTrader in Chicago" },
            new { Now = EtToUtc(W(2026, 3, 9, 17, 6)), Session = D(2026, 3, 9), Zone = NY, What = "the Monday after the March change (Sunday 18:00 EDT open = 22:00 UTC)" },
            new { Now = EtToUtc(W(2026, 3, 9, 17, 6)), Session = D(2026, 3, 9), Zone = London, What = "the same, NinjaTrader in London (UK clocks not changed yet)" },
            new { Now = EtToUtc(W(2026, 11, 2, 17, 6)), Session = D(2026, 11, 2), Zone = NY, What = "the Monday after the November change (Sunday 18:00 EST open = 23:00 UTC)" },
            new { Now = EtToUtc(W(2026, 3, 6, 17, 6)), Session = D(2026, 3, 6), Zone = Chicago, What = "the Friday before the March change (EST)" },
            new { Now = EtToUtc(W(2026, 10, 30, 17, 6)), Session = D(2026, 10, 30), Zone = Chicago, What = "the Friday before the November change (EDT)" },
            new { Now = EtToUtc(W(2026, 10, 5, 17, 6)), Session = D(2026, 10, 5), Zone = Tokyo, What = "a Monday: the Sunday 18:00 ET open belongs to it, NinjaTrader in Tokyo" } })
        {
            Desk desk = Fresh(dir, "MNQ", c.Now);
            try
            {
                NtZone(c.Zone);
                ChartBridgeBars.CatchUpSessions = 1;
                int m0 = MadeCount();
                ChartBridgeBars.PlanOnce(null);
                List<string> bodies = desk.All();
                string why = "no message";
                bool ok = bodies.Count == 1 && GoodSession(bodies[0], c.Session, out why) && BarsMade(m0).Count == 1;
                Check(ok, "S2 OneSession: " + c.What + ": one message, [t,o,h,l,c,v] with t the bar's open in UTC ms, sorted, no duplicates, 18:00 to 17:00 ET, complete: " + why);
            }
            finally { desk.Stop(); }
        }
        // the request itself, and the message's fields
        Desk d2 = Fresh(dir, "MNQ", EtToUtc(W(2026, 9, 30, 17, 6)));
        try
        {
            ChartBridgeBars.CatchUpSessions = 1;
            int m0 = MadeCount();
            ChartBridgeBars.PlanOnce(null);
            BarsRequest r = BarsMade(m0).FirstOrDefault();
            Check(r != null && r.BarsPeriod.BarsPeriodType == BarsPeriodType.Minute && r.BarsPeriod.Value == 1 && r.BarsPeriod.MarketDataType == MarketDataType.Last &&
                  r.TradingHours != null && r.TradingHours.Name == "CME US Index Futures ETH" && r.Instrument.FullName == "MNQ 12-26" &&
                  r.From == D(2026, 9, 28) && r.To == W(2026, 9, 30, 16, 6),
                  "S2 OneSession: the request: MNQ 12-26, 1 minute, Last, DoNotMerge, the instrument's trading hours, from the day before the open to now (NinjaTrader's time): " + (r == null ? "none" : r.From + " to " + r.To));
            string b = d2.All().FirstOrDefault() ?? "";
            Check(b.StartsWith("{\"v\":1,\"source\":\"chartbridge\",\"bridge\":\"" + ChartBridgeServer.Version + "\",\"pc\":\"HOME\",\"contract\":\"MNQ 12-26\",\"root\":\"MNQ\",\"tick\":0.25,\"session\":\"2026-09-30\",\"tf\":\"1m\",\"stamp\":\"open\",\"bars\":[[") &&
                  ChartBridgeServer.Version == "0.5.5", "S2 OneSession: contract v1 fields, bridge 0.5.5, pc HOME: " + (b.Length > 160 ? b.Substring(0, 160) : b));
            Check(Ts(b).Count > 0 && Ts(b)[0] == Ms(Utc(2026, 9, 29, 22, 0)) && b.Contains("[" + Ms(Utc(2026, 9, 29, 22, 0)) + ",25000,25001,24999.5,25000.25,10]"),
                "S2 OneSession: the first bar is the 18:00 ET minute (NinjaTrader's 18:01 close stamp less 60 s), prices and volume exact");
        }
        finally { d2.Stop(); }
    }

    // ------------------------------------------------------------ S3: The Desk unreachable
    static void S3DeskUnreachable(string dir)
    {
        Desk desk = Fresh(dir, "MNQ", EtToUtc(W(2026, 9, 30, 17, 6)));
        desk.Stop();   // The Desk is down: nothing listens
        Desk back = null;
        try
        {
            ChartBridgeBars.CatchUpSessions = 1;
            ChartBridgeBars.PlanOnce(null);
            string[] pending = Lines(dir, "pending_bars.jsonl");
            Check(pending.Length == 1 && ChartBridgeBarsQueue.KeyOfLine(pending[0]) == "2026-09-30 MNQ 12-26" && ChartBridgeBarsQueue.Waiting() == 1 && !ChartBridgeBarsQueue.IsDone("2026-09-30 MNQ 12-26"),
                "S3 DeskUnreachable: the message is on disk (pending_bars.jsonl) before any send, and stays there while The Desk is down");
            Check(Logged("The Desk did not take bars") && !Diag().Contains("\"lastError\":\"\""), "S3 DeskUnreachable: said once in the Output window, and /diag shows the error: " + Diag());
            Check(ChartBridgeBars.TickMs == 10000 && ChartBridgeBarsQueue.TimeoutMs == 10000, "S3 DeskUnreachable: retried every 10 s, 10 s per request (the fills' numbers)");
            // a restart while The Desk is down: the queue comes back from the file; a line cut short is skipped
            File.AppendAllText(Path.Combine(dir, "ChartBridge", "pending_bars.jsonl"), pending[0].Substring(0, 40) + Environment.NewLine);
            ChartBridgeBarsQueue.Load();
            Check(ChartBridgeBarsQueue.Waiting() == 1, "S3 DeskUnreachable: after a restart the message is back, the cut line skipped");

            // The Desk answers 503 (and 403, as through the tunnel), then comes back: the worker retries once per tick
            back = new Desk();
            ChartBridgeConfig.DeskUrl = back.Url;
            back.Status = body => 503;
            ChartBridgeBars.TickMs = 100; ChartBridgeBars.SettleMs = 600000;   // the worker only sends here
            ChartBridgeBars.Start();
            Thread.Sleep(1050);
            int tries = back.Count;
            back.Status = body => 403;
            Thread.Sleep(350);
            Check(tries >= 6 && tries <= 12 && ChartBridgeBarsQueue.Waiting() == 1 && Lines(dir, "rejected_bars.jsonl").Length == 0,
                "S3 DeskUnreachable: retried once per tick (" + tries + " posts in 1 s at a 100 ms tick; 10 s in NinjaTrader); 503 and 403 leave it queued, never set aside");
            back.Status = body => 200;
            Check(WaitFor(() => ChartBridgeBarsQueue.Waiting() == 0, 3000) && ChartBridgeBarsQueue.IsDone("2026-09-30 MNQ 12-26") && Lines(dir, "sent_bars.txt").Contains("2026-09-30 MNQ 12-26") &&
                  Lines(dir, "pending_bars.jsonl").Length == 0 && Logged("The Desk is taking bars again."),
                "S3 DeskUnreachable: once The Desk is back it goes, pending_bars.jsonl empties, sent_bars.txt notes the session");
            ChartBridgeBars.Stop();
            List<string> got = back.All();
            Check(got.Distinct().Count() == 1 && got[0] == pending[0], "S3 DeskUnreachable: every post was the same message, byte for byte (a resend is the same upsert at The Desk)");

            // set aside like fills: 400 and 422 only; the next message still goes
            back.Status = body => body.Contains("NQ 03-27") ? 400 : body.Contains("ES 03-27") ? 422 : 200;
            List<DeskBar> one = new List<DeskBar> { new DeskBar { T = Ms(Utc(2026, 9, 29, 13, 30)), O = 1, H = 2, L = 0.5, C = 1.5, V = 3 } };
            string bad = ChartBridgeBars.MessageJson("NQ 03-27", "NQ", 0.25, D(2026, 9, 29), one), bad2 = ChartBridgeBars.MessageJson("ES 03-27", "ES", 0.25, D(2026, 9, 29), one);
            string good = ChartBridgeBars.MessageJson("NQ 12-26", "NQ", 0.25, D(2026, 9, 29), one);
            ChartBridgeBarsQueue.Queue("2026-09-29 NQ 03-27", bad);
            ChartBridgeBarsQueue.Queue("2026-09-29 ES 03-27", bad2);
            ChartBridgeBarsQueue.Queue("2026-09-29 NQ 12-26", good);
            ChartBridgeBarsQueue.Queue("2026-09-29 NQ 12-26", good);   // twice: once in the queue
            ChartBridgeBarsQueue.Flush();
            string[] rej = Lines(dir, "rejected_bars.jsonl");
            Check(ChartBridgeBarsQueue.Waiting() == 0 && rej.Length == 2 && rej[0] == bad && rej[1] == bad2 && ChartBridgeBarsQueue.IsDone("2026-09-29 NQ 12-26") &&
                  !ChartBridgeBarsQueue.IsDone("2026-09-29 NQ 03-27") && Diag().Contains("\"setAside\":2") && Logged("refused the bars for 2026-09-29 NQ 03-27 (400: bars must be a list)"),
                "S3 DeskUnreachable: 400 and 422 set the message aside in rejected_bars.jsonl (not marked sent), the next one still goes, the reason is in the Output window");
            Check(back.All().Count(x => x == good) == 1, "S3 DeskUnreachable: a message queued twice is posted once");
        }
        finally { ChartBridgeBars.Stop(); if (back != null) back.Stop(); }
    }

    // ------------------------------------------------------------ 0.3.7 (review bars1 N1): the queue's age limit, refusals remembered
    static void N1QueueAgeAndRefusals(string dir)
    {
        Desk desk = Fresh(dir, "MNQ", EtToUtc(W(2026, 9, 30, 17, 6)));
        try
        {
            List<DeskBar> one = new List<DeskBar> { new DeskBar { T = Ms(Utc(2026, 9, 29, 13, 30)), O = 1, H = 2, L = 0.5, C = 1.5, V = 3 } };
            string old = ChartBridgeBars.MessageJson("MNQ 09-26", "MNQ", 0.25, D(2026, 8, 10), one), recent = ChartBridgeBars.MessageJson("MNQ 12-26", "MNQ", 0.25, D(2026, 9, 29), one);
            File.WriteAllLines(Path.Combine(dir, "ChartBridge", "pending_bars.jsonl"), new[] { old, recent });
            ChartBridgeBarsQueue.Load();
            Check(ChartBridgeBarsQueue.Waiting() == 1 && !ChartBridgeBarsQueue.IsWaiting("2026-08-10 MNQ 09-26") && Lines(dir, "pending_bars.jsonl").Length == 1 && Logged("dropped 1 message(s) older than 40 days from pending_bars.jsonl"),
                "N1: a message older than " + ChartBridgeBarsQueue.KeepSentDays + " days is dropped from pending_bars.jsonl at the start (it never waits longer than the record is kept)");
            // The Desk refuses 09-29 (422): set aside, and remembered across a restart, so the catch-up does not ask for it again
            desk.Status = body => body.Contains("\"session\":\"2026-09-29\"") ? 422 : 200;
            ChartBridgeBarsQueue.Flush();
            Check(ChartBridgeBarsQueue.IsRefused("2026-09-29 MNQ 12-26") && Lines(dir, "refused_bars.txt").Contains("2026-09-29 MNQ 12-26") && Lines(dir, "rejected_bars.jsonl").Length == 1,
                "N1: a refusal is set aside and noted in refused_bars.txt");
            // a restart: what the worker remembers this run (GaveUp) is gone, the files are read again
            ChartBridgeBars.ResetConfig(); ChartBridgeBars.Start();   // bars off: resets the run's memory, starts nothing
            ChartBridgeBars.ReadConfig("bars", "on"); ChartBridgeBars.ReadConfig("barsRoots", "MNQ"); ChartBridgeBars.ReadConfig("pc", "HOME");
            ChartBridgeBarsQueue.Load();
            ChartBridgeBars.CatchUpSessions = 2;
            int m0 = MadeCount();
            ChartBridgeBars.PlanOnce(null);
            List<string> asked = BarsMade(m0).Select(r => SessionOf(r).ToString("MM-dd")).ToList();
            Check(asked.Count == 1 && asked[0] == "09-30" && Lines(dir, "rejected_bars.jsonl").Length == 1,
                "N1: after a restart the refused session is not asked again (rejected_bars.jsonl does not grow); only 09-30 is (" + string.Join(",", asked) + ")");
        }
        finally { desk.Stop(); foreach (string f in new[] { "refused_bars.txt" }) File.Delete(Path.Combine(dir, "ChartBridge", f)); }
    }

    // ------------------------------------------------------------ 0.3.7 (review bars1 N7): the files are read off NinjaTrader's thread
    static void N7ReadOffNtThread(string dir)
    {
        Desk desk = Fresh(dir, "MNQ", EtToUtc(W(2026, 9, 30, 17, 6)));
        int caller = Thread.CurrentThread.ManagedThreadId, logThread = -1;
        try
        {
            List<DeskBar> one = new List<DeskBar> { new DeskBar { T = Ms(Utc(2026, 9, 29, 13, 30)), O = 1, H = 2, L = 0.5, C = 1.5, V = 3 } };
            File.WriteAllLines(Path.Combine(dir, "ChartBridge", "pending_bars.jsonl"), new[] { ChartBridgeBars.MessageJson("MNQ 12-26", "MNQ", 0.25, D(2026, 9, 29), one) });
            ChartBridgeBars.TickMs = 600000; ChartBridgeBars.SettleMs = 600000;   // the worker only starts
            NinjaTrader.Code.Output.OnLine = line => { if (line.Contains("daily 1-minute bars go to The Desk")) logThread = Thread.CurrentThread.ManagedThreadId; };
            ChartBridgeBars.Start();   // as NinjaTrader's thread calls it
            Check(WaitFor(() => logThread != -1) && logThread != caller && BarsThread() != null && logThread == BarsThread().ManagedThreadId && ChartBridgeBarsQueue.Waiting() == 1,
                "N7: Start() reads pending_bars.jsonl, sent_bars.txt and refused_bars.txt on the bars thread, not the caller's (NinjaTrader's) thread");
        }
        finally { NinjaTrader.Code.Output.OnLine = null; ChartBridgeBars.Stop(); desk.Stop(); }
    }

    // ------------------------------------------------------------ S4: catch-up at start
    static void S4CatchUpAtStart(string dir)
    {
        // Monday 2026-10-05 09:00 ET: the last 5 sessions are 10-02, 10-01, 09-30, 09-29, 09-28. 3 sent, 2 not.
        Desk desk = Fresh(dir, "MNQ, ES", EtToUtc(W(2026, 10, 5, 9, 0)));
        try
        {
            File.WriteAllLines(Path.Combine(dir, "ChartBridge", "sent_bars.txt"), new[] {
                "2026-10-02 MNQ 12-26", "2026-10-02 ES 12-26", "2026-10-01 MNQ 12-26", "2026-10-01 ES 12-26", "2026-09-29 MNQ 12-26", "2026-09-29 ES 12-26" });
            ChartBridgeBarsQueue.Load();
            int m0 = MadeCount();
            ChartBridgeBars.PlanOnce(null);
            List<string> asked = BarsMade(m0).Select(r => r.Instrument.FullName + " " + r.To.ToString("MM-dd")).ToList();
            List<string> sent = desk.All().Select(b => Session(b) + " " + Contract(b)).ToList();
            Check(sent.Count == 4 && sent.Contains("2026-09-30 MNQ 12-26") && sent.Contains("2026-09-30 ES 12-26") && sent.Contains("2026-09-28 MNQ 12-26") && sent.Contains("2026-09-28 ES 12-26") && asked.Count == 4,
                "S4 CatchUpAtStart: of the last 5 sessions, 3 sent and 2 not: only the 2 go, for each root (" + string.Join(", ", sent) + ")");
            int m1 = MadeCount();
            ChartBridgeBars.PlanOnce(null);
            ChartBridgeBarsQueue.Load();   // a restart
            ChartBridgeBars.PlanOnce(null);
            Check(Made(m1).Count == 0, "S4 CatchUpAtStart: the next pass, and the first after a restart, ask for nothing (sent_bars.txt)");
        }
        finally { desk.Stop(); }

        // A session NinjaTrader has no bars for (a holiday the template does not know): asked MaxTries times, 15 minutes apart, then
        // not again until a restart. Weekends and the template's holidays are never asked.
        Desk d2 = Fresh(dir, "MNQ", EtToUtc(W(2026, 12, 28, 8, 0)));
        try
        {
            Instrument chart = Inst("MNQ 03-27");
            chart.MasterInstrument.TradingHours.Holidays[D(2026, 12, 25)] = "Christmas";
            Named()["MNQ"] = chart;
            answerEmpty = r => SessionOf(r) == D(2026, 12, 22);   // NinjaTrader has nothing for 12-22's session
            int m0 = MadeCount();
            DateTime now = EtToUtc(W(2026, 12, 28, 8, 0));
            for (int pass = 0; pass < 6; pass++)
            {
                DateTime at = now.AddMinutes(16 * pass);
                ChartBridgeBars.UtcNow = () => at;
                ChartBridgeBars.PlanOnce(null);
            }
            List<BarsRequest> made = BarsMade(m0);
            List<string> days = made.Select(r => SessionOf(r).ToString("MM-dd")).ToList();
            int empty = days.Count(x => x == "12-22");
            Check(made.Count == 4 + 3 && empty == 3 && !days.Contains("12-25") && !days.Contains("12-26") && !days.Contains("12-27") && ChartBridgeBarsQueue.IsDone("2026-12-24 MNQ 03-27") &&
                  ChartBridgeBarsQueue.IsDone("2026-12-18 MNQ 03-27") && !ChartBridgeBarsQueue.IsDone("2026-12-22 MNQ 03-27") && Diag().Contains("\"gaveUp\":1") &&
                  Logged("MNQ 03-27 session 2026-12-22: NinjaTrader has no 1-minute bars for it; tried 3 times, not asked again until ChartBridge restarts"),
                "S4 CatchUpAtStart: 6 passes over 80 minutes: Christmas (a template holiday) and the weekend never asked, the session with no bars asked 3 times then left (" + string.Join(",", days) + ")");
        }
        finally { Named().Remove("MNQ"); d2.Stop(); }
    }

    // ------------------------------------------------------------ S5: never beside the chart's data work
    static DateTime simNow;
    class Trade { public DateTime T; public double P; public long V; }
    static List<Trade> Walk(DateTime t0, int n, int seed)
    {
        Random rnd = new Random(seed);
        List<Trade> l = new List<Trade>(n);
        DateTime t = t0; double p = 20000;
        for (int i = 0; i < n; i++) { t = t.AddMilliseconds(rnd.Next(1, 200)); p += (rnd.Next(0, 3) - 1) * 0.25; l.Add(new Trade { T = t, P = p, V = 1 + rnd.Next(0, 5) }); }
        return l;
    }
    static void LiveOn(Instrument i, List<Trade> tape, int from, int to)
    {
        for (int k = from; k < to; k++)
        {
            simNow = tape[k].T;
            Priv("OnMarketData", null, new MarketDataEventArgs { Instrument = i, MarketDataType = MarketDataType.Last, Price = tape[k].P, Volume = tape[k].V, Time = tape[k].T });
        }
    }
    static Bars TicksOf(List<Trade> tape, int from, int to) { Bars b = new Bars(); for (int i = from; i < to; i++) b.Add(tape[i].T, tape[i].P, tape[i].P, tape[i].P, tape[i].P, tape[i].V); return b; }
    static bool IsTicks(BarsRequest r) { return r.BarsPeriod != null && r.BarsPeriod.BarsPeriodType == BarsPeriodType.Tick && r.BarsPeriod.MarketDataType == MarketDataType.Last; }
    static bool IsWindow(BarsRequest r) { return IsTicks(r) && r.BarsBack > 0 && r.BarsBack != ChartBridgeServer.SeamTicksBack; }
    static bool IsBackfill(BarsRequest r) { return IsTicks(r) && r.BarsBack < 0; }
    static void AnswerChartMinutes(int from) { foreach (BarsRequest r in Made(from).Where(r => !IsBars(r) && r.BarsPeriod != null && r.BarsPeriod.BarsPeriodType == BarsPeriodType.Minute && !r.Answered)) r.Answer(new Bars(), ErrorCode.NoError); }
    static ChartBridgeClient Page(int id, string sub)
    {
        ChartBridgeClient c = new ChartBridgeClient(null, id);
        c.Tap = s => { };
        Clients()[id] = c;
        Priv("OnClientMessage", c, "{\"type\":\"subscribe\",\"root\":\"MNQ\",\"days\":5,\"tickHours\":2,\"sub\":" + sub + ",\"liveFirst\":true,\"profile\":true}");
        return c;
    }
    static void Drop(ChartBridgeClient c) { if (c == null) return; ChartBridgeClient g; Clients().TryRemove(c.Id, out g); c.Close(); }
    // PlanOnce on its own thread (it waits for its request's answer), as the bars worker runs it.
    static Thread PlanAsync() { Thread t = new Thread(() => ChartBridgeBars.PlanOnce(null)); t.IsBackground = true; t.Start(); return t; }

    static void S5NeverBesideTheChart(string dir)
    {
        Instrument mnq = Inst("MNQ 12-26");
        Instrument wasMnq; bool hadMnq = Named().TryGetValue("MNQ", out wasMnq);
        Named()["MNQ"] = mnq;
        // Tuesday 2026-09-29 11:00 ET on NinjaTrader's clock (the chart's side); the bars catch up the sessions before it.
        DateTime t0 = NtOf(W(2026, 9, 29, 11, 0));
        ChartBridgeServer.ClockForHarness = () => simNow;
        int wtoWas = ChartBridgeServer.WindowTimeoutMs, bfStartWas = ChartBridgeServer.BackfillStartMs, bfGapWas = ChartBridgeServer.BackfillGapMs;
        bool bfOnWas = ChartBridgeServer.BackfillOn;
        ChartBridgeClient a = null, b = null;
        Desk desk = Fresh(dir, "MNQ", EtToUtc(W(2026, 9, 29, 11, 0)));
        try
        {
            ChartBridgeBars.CatchUpSessions = 2;
            ChartBridgeServer.WindowFirstGuess = 1000;
            List<Trade> tape = Walk(t0.AddMinutes(-10), 200, 901);

            // (a) a Range window out: no bars request; it goes once the window is answered
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));
            NtZone(Chicago); simNow = t0;
            LiveOn(mnq, tape, 0, 100);
            int m0 = MadeCount();
            a = Page(951, "1");
            AnswerChartMinutes(m0);
            BarsRequest w = null;
            WaitFor(() => (w = Made(m0).FirstOrDefault(IsWindow)) != null, 3000);
            ChartBridgeBars.PlanOnce(null);
            ChartBridgeBars.PlanOnce(null);
            Check(w != null && BarsMade(m0).Count == 0 && Diag().Contains("\"waitingForGate\":\"window MNQ is out\"") && Diag().Contains("\"state\":\"waiting for the gate: window MNQ is out\"") && Gate().Contains("\"barsQueued\":0"),
                "S5 NeverBesideTheChart: while a Range window is out, no bars request is made, nothing piles up at the gate, /diag says why: " + Diag());
            if (w != null) w.Answer(TicksOf(tape, 0, 100), ErrorCode.NoError);
            WaitFor(() => a.Ready, 3000);
            ChartBridgeBars.PlanOnce(null);
            Check(a.Ready && BarsMade(m0).Count == 2 && desk.Count == 2 && Diag().Contains("\"waitingForGate\":null"), "S5 NeverBesideTheChart: once the window is answered and the page ready, the bars go (" + BarsMade(m0).Count + ")");
            Drop(a); a = null;

            // (b) a bars request out: a window asked meanwhile waits behind it, then goes
            Fresh(dir, "MNQ", EtToUtc(W(2026, 9, 29, 11, 0))).Stop();
            ChartBridgeConfig.DeskUrl = desk.Url;
            ChartBridgeBars.CatchUpSessions = 1;
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));
            LiveOn(mnq, tape, 100, 150);
            BarsRequest.AutoAnswer = r => false;   // NinjaTrader takes its time with the bars
            m0 = MadeCount();
            Thread plan = PlanAsync();
            BarsRequest br = null;
            WaitFor(() => (br = BarsMade(m0).FirstOrDefault()) != null, 3000);
            b = Page(952, "2");
            AnswerChartMinutes(m0);
            Thread.Sleep(400);
            bool none = !Made(m0).Any(IsWindow) && Gate().Contains("\"now\":\"bars 2026-09-28 MNQ 12-26\"") && Gate().Contains("\"windowsQueued\":1");
            if (br != null) AnswerBars(br);
            BarsRequest w2 = null;
            bool after = WaitFor(() => (w2 = Made(m0).FirstOrDefault(IsWindow)) != null, 3000);
            Check(br != null && none && after && plan.Join(3000) && ChartBridgeBarsQueue.IsDone("2026-09-28 MNQ 12-26"),
                "S5 NeverBesideTheChart: a window asked while a bars request is out waits in the gate's queue and goes right after its answer (never beside it)");
            if (w2 != null) w2.Answer(TicksOf(tape, 0, 150), ErrorCode.NoError);
            WaitFor(() => b.Ready, 3000);
            Drop(b); b = null;
            BarsRequest.AutoAnswer = AnswerLikeNt;

            // (c) a session backfill to come (a start after 18:00): no bars request until it is done, then they go
            Fresh(dir, "MNQ", EtToUtc(W(2026, 9, 29, 11, 0))).Stop();
            ChartBridgeConfig.DeskUrl = desk.Url;
            ChartBridgeBars.CatchUpSessions = 1;
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-1));   // listening began after 18:00: the backfill is wanted
            ChartBridgeServer.BackfillOn = true; ChartBridgeServer.BackfillStartMs = 0; ChartBridgeServer.BackfillGapMs = 0;
            m0 = MadeCount();
            LiveOn(mnq, tape, 150, 160);
            BarsRequest bf = null;
            WaitFor(() => (bf = Made(m0).FirstOrDefault(IsBackfill)) != null, 3000);
            ChartBridgeBars.PlanOnce(null);
            string waitOut = Diag();
            ChartBridgeServer.BackfillRetryMs = 1500;
            if (bf != null) bf.Answer(null, ErrorCode.Panic);   // fails once: asked again in 1.5 s here (60 s in NinjaTrader); the bars still wait
            WaitFor(() => ((string)Priv("BooksJson")).Contains("failed once"), 3000);
            ChartBridgeBars.PlanOnce(null);
            string waitRetry = Diag();
            Check(bf != null && BarsMade(m0).Count == 0 && waitOut.Contains("\"waitingForGate\":\"MNQ session backfill not done") && waitRetry.Contains("failed once"),
                "S5 NeverBesideTheChart: while a session backfill is out, and while it waits to be asked again, no bars request is made: " + waitRetry);
            BarsRequest bf2 = null;
            WaitFor(() => (bf2 = Made(m0).Where(IsBackfill).Skip(1).FirstOrDefault()) != null, 5000);
            if (bf2 != null) bf2.Answer(TicksOf(tape, 0, 160), ErrorCode.NoError);
            WaitFor(() => ((string)Priv("BooksJson")).Contains("\"state\":\"done\""), 3000);
            // the gate frees a moment after the backfill's state reads done: plan again until the bars request is made
            // (one plan right after "done" could still find the gate busy: a timing flake in the reviews and in 0.3.8's runs)
            for (int tries = 0; tries < 20 && BarsMade(m0).Count == 0; tries++) { ChartBridgeBars.PlanOnce(null); if (BarsMade(m0).Count == 0) Thread.Sleep(100); }
            WaitFor(() => BarsMade(m0).Count == 1 && ChartBridgeBarsQueue.IsDone("2026-09-28 MNQ 12-26"), 3000);   // the bars thread sends it
            Check(bf2 != null && BarsMade(m0).Count == 1 && ChartBridgeBarsQueue.IsDone("2026-09-28 MNQ 12-26"), "S5 NeverBesideTheChart: once the backfill is done, the bars go");
            ChartBridgeServer.BackfillOn = bfOnWas; ChartBridgeServer.BackfillRetryMs = 60000;

            // (d) the gate stuck on a window NinjaTrader never answered: the bars wait (no request, nothing queued) and go after it answers
            Fresh(dir, "MNQ", EtToUtc(W(2026, 9, 29, 11, 0))).Stop();
            ChartBridgeConfig.DeskUrl = desk.Url;
            ChartBridgeBars.CatchUpSessions = 1;
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));
            ChartBridgeServer.WindowTimeoutMs = 300;
            LiveOn(mnq, tape, 0, 100);
            m0 = MadeCount();
            a = Page(953, "3");
            AnswerChartMinutes(m0);
            BarsRequest ws = null;
            bool stuck = WaitFor(() => (ws = Made(m0).FirstOrDefault(IsWindow)) != null, 3000) && WaitFor(() => Gate().Contains("\"stuck\":\"window MNQ\""), 3000);
            WaitFor(() => a.Ready, 3000);
            for (int i = 0; i < 5; i++) ChartBridgeBars.PlanOnce(null);
            Check(stuck && BarsMade(m0).Count == 0 && Gate().Contains("\"barsQueued\":0") && Diag().Contains("\"waitingForGate\":\"NinjaTrader has not answered an earlier request (window MNQ) yet\""),
                "S5 NeverBesideTheChart: the gate stuck on a window: 5 passes make no bars request and queue nothing; /diag: " + Diag());
            if (ws != null) ws.Answer(TicksOf(tape, 0, 100), ErrorCode.NoError);   // the late answer frees the gate
            WaitFor(() => Gate().Contains("\"stuck\":null"), 3000);
            ChartBridgeBars.PlanOnce(null);
            Check(BarsMade(m0).Count == 1 && ChartBridgeBarsQueue.IsDone("2026-09-28 MNQ 12-26"), "S5 NeverBesideTheChart: once NinjaTrader answers the stuck window, the bars go");
            Drop(a); a = null;
            ChartBridgeServer.WindowTimeoutMs = wtoWas;

            // (e) Anthony: the chart never waits on bars. A bars request NinjaTrader never answers is given up at its limit and
            // frees the gate: the next window goes. Its late answer is dropped, not copied or queued, and never frees or changes
            // another request's stuck state: a window that NinjaTrader does not answer still leaves the gate stuck as in 0.3.5.
            Fresh(dir, "MNQ", EtToUtc(W(2026, 9, 29, 11, 0))).Stop();
            ChartBridgeConfig.DeskUrl = desk.Url;
            ChartBridgeBars.CatchUpSessions = 1; ChartBridgeBars.RequestTimeoutMs = 300;
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(t0).AddHours(-20));
            ChartBridgeServer.WindowTimeoutMs = 300;
            LiveOn(mnq, tape, 0, 100);
            BarsRequest.AutoAnswer = r => false;   // NinjaTrader answers nothing
            m0 = MadeCount();
            int posts0 = desk.Count;
            ChartBridgeBars.PlanOnce(null);
            string g1 = Gate(), d = Diag();
            bool freed = BarsMade(m0).Count == 1 && g1.Contains("\"now\":null") && g1.Contains("\"stuck\":null") && d.Contains("did not answer within") &&
                         Logged("bars 2026-09-28 MNQ 12-26: NinjaTrader did not answer in 0 s; given up, the gate goes on");
            a = Page(954, "4");
            AnswerChartMinutes(m0);
            BarsRequest wn = null;
            bool windowWent = WaitFor(() => (wn = Made(m0).FirstOrDefault(IsWindow)) != null, 3000);
            bool windowStuck = WaitFor(() => Gate().Contains("\"stuck\":\"window MNQ\""), 3000);   // the window keeps 0.3.5's rule
            BarsRequest late = BarsMade(m0).FirstOrDefault();
            if (late != null) AnswerBars(late);   // the bars' late answer
            Thread.Sleep(200);
            bool stillStuck = Gate().Contains("\"stuck\":\"window MNQ\"");
            bool dropped = Logged("bars 2026-09-28 MNQ 12-26: NinjaTrader answered after it was given up; not used") && ChartBridgeBarsQueue.Waiting() == 0 &&
                           !ChartBridgeBarsQueue.IsDone("2026-09-28 MNQ 12-26") && desk.Count == posts0;
            if (wn != null) wn.Answer(TicksOf(tape, 0, 100), ErrorCode.NoError);   // only the window's own answer frees it
            bool unstuck = WaitFor(() => Gate().Contains("\"stuck\":null"), 3000);
            Check(freed && windowWent && windowStuck && stillStuck && dropped && unstuck,
                "S5 NeverBesideTheChart: a bars request with no answer frees the gate at its limit (" + freed + "); the next window goes (" + windowWent +
                "); its late answer is dropped, not copied or queued (" + dropped + "), and leaves the window's stuck gate alone (" + stillStuck +
                "); an unanswered window still leaves the gate stuck as in 0.3.5, freed only by its own answer (" + windowStuck + ", " + unstuck + "): " + d);
            Drop(a); a = null;
            ChartBridgeServer.WindowTimeoutMs = wtoWas;
            BarsRequest.AutoAnswer = AnswerLikeNt;
        }
        finally
        {
            Drop(a); Drop(b);
            desk.Stop();
            BarsRequest.AutoAnswer = AnswerLikeNt;
            ChartBridgeServer.WindowTimeoutMs = wtoWas; ChartBridgeServer.BackfillStartMs = bfStartWas; ChartBridgeServer.BackfillGapMs = bfGapWas; ChartBridgeServer.BackfillOn = bfOnWas;
            ChartBridgeServer.BackfillRetryMs = 60000; ChartBridgeServer.WindowFirstGuess = 200000;
            ChartBridgeServer.StopGate();
            ChartBridgeServer.ResetBooks(DateTime.MinValue);
            ChartBridgeServer.ClockForHarness = null;
            if (hadMnq) Named()["MNQ"] = wasMnq; else Named().Remove("MNQ");
        }
    }

    // ------------------------------------------------------------ S6: a stop during a bars request
    static void S6StopDuringRequest(string dir)
    {
        Desk desk = Fresh(dir, "MNQ, ES", EtToUtc(W(2026, 9, 30, 17, 6)));
        try
        {
            ChartBridgeBars.TickMs = 20; ChartBridgeBars.SettleMs = 0; ChartBridgeBars.PlanEveryMs = 0;
            BarsRequest.AutoAnswer = r => false;   // the request stays out
            int m0 = MadeCount();
            ChartBridgeBars.Start();
            Thread worker = BarsThread();
            BarsRequest out1 = null;
            bool asked = WaitFor(() => (out1 = BarsMade(m0).FirstOrDefault()) != null, 3000);
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            ChartBridgeBars.Stop();            // as ChartBridgeServer.Stop: the bars first,
            ChartBridgeServer.StopGate(250);   // then the gate, both on NinjaTrader's thread
            long ms = sw.ElapsedMilliseconds;
            int made = MadeCount();
            if (out1 != null) AnswerBars(out1);   // NinjaTrader answers after the stop
            Thread.Sleep(500);
            Check(asked && ms < 700 && worker != null && !worker.IsAlive && MadeCount() == made && ChartBridgeBarsQueue.Waiting() == 0 && Lines(dir, "pending_bars.jsonl").Length == 0 && desk.Count == 0 && Diag().Contains("\"state\":\"stopped\""),
                "S6 StopDuringRequest: a stop with a bars request out returns in " + ms + " ms, the worker has ended, NinjaTrader is asked nothing more, and the late answer queues and sends nothing");
            ChartBridgeServer.ResetBooks(DateTime.MinValue);   // a start in the same process
        }
        finally { desk.Stop(); BarsRequest.AutoAnswer = AnswerLikeNt; }

        // a stop while a post to The Desk is in flight (The Desk answers in 3 s): it is aborted, the message stays queued, nothing more goes
        Desk slow = Fresh(dir, "MNQ", EtToUtc(W(2026, 9, 30, 17, 6)));
        try
        {
            slow.HoldMs = 3000;
            ChartBridgeBarsQueue.Queue("2026-09-30 MNQ 12-26", ChartBridgeBars.MessageJson("MNQ 12-26", "MNQ", 0.25, D(2026, 9, 30), new List<DeskBar> { new DeskBar { T = Ms(Utc(2026, 9, 30, 13, 30)), O = 1, H = 1, L = 1, C = 1, V = 1 } }));
            ChartBridgeBarsQueue.Queue("2026-09-30 ES 12-26", ChartBridgeBars.MessageJson("ES 12-26", "ES", 0.25, D(2026, 9, 30), new List<DeskBar> { new DeskBar { T = Ms(Utc(2026, 9, 30, 13, 30)), O = 1, H = 1, L = 1, C = 1, V = 1 } }));
            ChartBridgeBars.TickMs = 20; ChartBridgeBars.SettleMs = 600000;
            ChartBridgeBars.Start();
            Thread worker = BarsThread();
            bool posting = WaitFor(() => slow.Count == 1, 3000);
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            ChartBridgeBars.Stop();
            long ms = sw.ElapsedMilliseconds;
            Thread.Sleep(3500);
            Check(posting && ms < 500 && worker != null && !worker.IsAlive && slow.Count == 1 && ChartBridgeBarsQueue.Waiting() == 2 && !ChartBridgeBarsQueue.IsDone("2026-09-30 MNQ 12-26") && !Logged("The Desk did not take bars (The request was aborted"),
                "S6 StopDuringRequest: a stop during a post returns in " + ms + " ms, the post is aborted, both messages stay queued for the next start, and nothing more is posted (" + slow.Count + " post)");
        }
        finally { ChartBridgeBars.Stop(); slow.Stop(); }
    }

    // ------------------------------------------------------------ S7: the contracts per root
    static void S7ContractPerRoot(string dir)
    {
        Desk desk = Fresh(dir, null, EtToUtc(W(2026, 9, 30, 17, 6)));   // the default roots: NQ, MNQ, ES, MES
        Account acct = new Account { Name = "SimHarness" };
        try
        {
            // fills today in MNQ 09-26 (the old contract) and in MNQ 12-26, on a made-up account; one yesterday in ES 09-26
            acct.Executions.Add(new Execution { Instrument = Inst("MNQ 09-26"), Time = NtOf(W(2026, 9, 30, 10, 0)), ExecutionId = "x1", Price = 1, Quantity = 1 });
            acct.Executions.Add(new Execution { Instrument = Inst("MNQ 12-26"), Time = NtOf(W(2026, 9, 30, 10, 1)), ExecutionId = "x2", Price = 1, Quantity = 1 });
            acct.Executions.Add(new Execution { Instrument = Inst("ES 09-26"), Time = NtOf(W(2026, 9, 29, 19, 0)), ExecutionId = "x3", Price = 1, Quantity = 1 });   // Tuesday 19:00 ET: Wednesday's session
            acct.Executions.Add(new Execution { Instrument = Inst("CL 11-26"), Time = NtOf(W(2026, 9, 30, 10, 2)), ExecutionId = "x4", Price = 1, Quantity = 1 });
            lock (Account.All) Account.All.Add(acct);
            ChartBridgeBars.CatchUpSessions = 2;
            int m0 = MadeCount();
            ChartBridgeBars.PlanOnce(null);
            List<string> sent = desk.All().Select(b => Session(b) + " " + Contract(b)).ToList();
            string want = "2026-09-30 NQ 12-26,2026-09-30 MNQ 12-26,2026-09-30 ES 12-26,2026-09-30 MES 12-26,2026-09-30 MNQ 09-26,2026-09-30 ES 09-26," +
                          "2026-09-29 NQ 12-26,2026-09-29 MNQ 12-26,2026-09-29 ES 12-26,2026-09-29 MES 12-26";
            Check(string.Join(",", sent) == want && BarsMade(m0).Count == 10,
                "S7 ContractPerRoot: each root's front month for each session, plus MNQ 09-26 and ES 09-26 (traded that session), once each, nothing for CL: " + string.Join(", ", sent));
            Check(!desk.All().Any(b => b.Contains("SimHarness") || b.ToLowerInvariant().Contains("account")) && !Logged("SimHarness"),
                "S7 ContractPerRoot: no account name in any message or Output line");
            Check(desk.All().All(b => Regex.IsMatch(b, "^\\{\"v\":1,\"source\":\"chartbridge\",\"bridge\":\"[^\"]+\",\"pc\":\"HOME\",\"contract\":\"[A-Z]+ \\d\\d-\\d\\d\",\"root\":\"[A-Z]+\",\"tick\":0.25,\"session\":\"\\d{4}-\\d\\d-\\d\\d\",\"tf\":\"1m\",\"stamp\":\"open\",\"bars\":\\[(\\[\\d{13},[0-9.]+,[0-9.]+,[0-9.]+,[0-9.]+,\\d+\\],?)+\\],\"complete\":true\\}$")),
                "S7 ContractPerRoot: every message is market data and the PC name only, field for field");
            ChartBridgeConfig.ContractOverride["MNQ"] = "MNQ 03-27";
            Fresh(dir, "MNQ", EtToUtc(W(2026, 10, 1, 17, 6))).Stop();
            ChartBridgeConfig.DeskUrl = desk.Url;
            ChartBridgeBars.CatchUpSessions = 1;
            m0 = MadeCount();
            ChartBridgeBars.PlanOnce(null);
            Check(BarsMade(m0).Count == 1 && BarsMade(m0)[0].Instrument.FullName == "MNQ 03-27", "S7 ContractPerRoot: contract.MNQ in config.txt is the chart's contract, and so the bars'");
        }
        finally { ChartBridgeConfig.ContractOverride.Clear(); lock (Account.All) Account.All.Remove(acct); desk.Stop(); }
    }

    // ------------------------------------------------------------ S8: /diag tells the truth
    static void S8Diag(string dir)
    {
        Desk desk = Fresh(dir, "MNQ, ES", EtToUtc(W(2026, 9, 30, 17, 6)));
        try
        {
            ChartBridgeBars.CatchUpSessions = 2;
            ChartBridgeBars.PlanOnce(null);
            desk.Status = body => 503;
            List<DeskBar> one = new List<DeskBar> { new DeskBar { T = Ms(Utc(2026, 9, 24, 13, 30)), O = 1, H = 2, L = 0.5, C = 1.5, V = 3 } };
            ChartBridgeBarsQueue.Queue("2026-09-25 MNQ 12-26", ChartBridgeBars.MessageJson("MNQ 12-26", "MNQ", 0.25, D(2026, 9, 25), one));
            ChartBridgeBarsQueue.Queue("2026-09-24 ES 12-26", ChartBridgeBars.MessageJson("ES 12-26", "ES", 0.25, D(2026, 9, 24), one));
            ChartBridgeBarsQueue.Flush();
            string d = Diag();
            Check(d.StartsWith("{\"enabled\":true,\"state\":\"idle\",\"waitingForGate\":null,\"roots\":[\"MNQ\",\"ES\"],\"lastSent\":{\"ES 12-26\":\"2026-09-30\",\"MNQ 12-26\":\"2026-09-30\"},\"waiting\":2,\"setAside\":0,\"gaveUp\":0,") &&
                  d.Contains("\"lastRequest\":\"2026-09-29 ES 12-26 at 2026-09-30 21:06:00 UTC\"") && d.Contains("(503)"),
                "S8 Diag: the last session sent per contract, 2 queued while The Desk answers 503, the last request and the error: " + d);
            desk.Status = body => body.Contains("2026-09-25") ? 400 : 200;
            ChartBridgeBarsQueue.Flush();
            d = Diag();
            Check(d.Contains("\"lastSent\":{\"ES 12-26\":\"2026-09-30\",\"MNQ 12-26\":\"2026-09-30\"}") && d.Contains("\"waiting\":0") && d.Contains("\"setAside\":1") && d.Contains("\"lastError\":\"\""),
                "S8 Diag: then a 400 and a 200: none queued, 1 set aside, the last session per contract unchanged (2026-09-24 is older), no stale error: " + d);
            string server = (string)Priv("DiagJson");
            Check(server.Contains(",\"bars\":{\"enabled\":true,\"state\":") && server.Contains("\"barsQueued\":0"), "S8 Diag: GET /diag has the bars section, and the gate shows its bars queue");
            connected = false;
            ChartBridgeBars.PlanOnce(null);
            Check(Diag().Contains("\"state\":\"waiting: NinjaTrader has no price connection\""), "S8 Diag: not connected: it says it waits for the price connection");
        }
        finally { desk.Stop(); }
    }

    // ------------------------------------------------------------ regular trading hours
    static void Rth(string dir)
    {
        // A start at 10:00 ET on a Wednesday: the catch-up runs (once the gate is idle); its ES answers come back empty, so
        // they are due again in 15 minutes, but not in RTH: they go after 16:15 ET.
        DateTime now = EtToUtc(W(2026, 10, 7, 10, 0));
        Desk desk = Fresh(dir, "MNQ, ES", now);
        try
        {
            ChartBridgeBars.CatchUpSessions = 2;
            answerEmpty = r => r.Instrument.FullName.StartsWith("ES");
            int m0 = MadeCount();
            ChartBridgeBars.PlanOnce(null);
            int first = BarsMade(m0).Count, firstSent = desk.Count;
            answerEmpty = r => false;
            DateTime later = now.AddMinutes(20);
            ChartBridgeBars.UtcNow = () => later;
            ChartBridgeBars.PlanOnce(null);
            int inRth = BarsMade(m0).Count;
            string d = Diag();
            DateTime after = EtToUtc(W(2026, 10, 7, 16, 16));
            ChartBridgeBars.UtcNow = () => after;
            ChartBridgeBars.PlanOnce(null);
            Check(first == 4 && firstSent == 2 && inRth == 4 && d.Contains("\"state\":\"waiting: regular trading hours (after 16:15 ET)\"") && BarsMade(m0).Count == 6 && ChartBridgeBarsQueue.IsDone("2026-10-05 ES 12-26"),
                "RTH: the catch-up at a 10:00 ET start runs; its retries wait out regular trading hours and go at 16:16 ET (" + first + ", " + inRth + ", " + BarsMade(m0).Count + ")");
        }
        finally { desk.Stop(); }
    }
}
