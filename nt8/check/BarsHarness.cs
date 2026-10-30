// Daily 1-minute bars to The Desk (ChartBridge 0.3.6, ChartBridgeBars.cs), run for real on Mono inside check:orders
// (SeamHarness.Run calls BarsHarness.Run last). First the pure rules: the session date (18:00 New York start, Sunday open to
// Monday, daylight saving in March and November, early closes), NinjaTrader's close stamps to open times in UTC from
// several NinjaTrader time zones, which sessions the catch-up picks, the contract per root and session, the message.
// Then the failure scenarios, each through ChartBridgeServer's own gate (0.3.5) with the stand-in BarsRequest, a stand-in
// Desk and the bars worker thread:
//   S1 OffByDefault, S2 OneSession (both daylight saving changes, Sunday's open), S3 DeskUnreachable, S4 CatchUpAtStart,
//   S5 NeverBesideTheChart (a window out, a window queued behind bars, a backfill to come, a stuck gate, a bars request
//   NinjaTrader never answers), S6 StopDuringRequest (and during a post), S7 ContractPerRoot, S8 Diag, and RTH.
// 0.6.9: the 1 second bars (OneSecond*): rows from made-up trades, the parts, the request, the 1-minute message unchanged, regular
// trading hours, one a pass, a chart loading, today's Desk (404), a restart mid set, a refusal, the speed of one pass.
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
            OneSecondBuilder();          // 0.6.9: 1 second bars from made-up trades (pure)
            OneSecondMessages();         // 0.6.9: the parts of a set
            OneSecondSession(dir);       // 0.6.9: through the gate, a stand-in Desk, the 1-minute message unchanged
            OneSecondWindow();           // 0.6.9 (coordinator 2026-10-24): 16:15 to 18:00 ET on weekdays, the weekend while shut
            OneSecondRthAndOnePerPass(dir);
            OneSecondOldDeskAndRestart(dir);
            OneSecondRefused(dir);
            OneSecondSpeed();
            TickCheckCases();            // the NQ tick file (Sunday 11-01): the check of the live capture against the history (pure)
            TickFileCapture(dir);        // the queue's bound (drop and count), NQ only, the raw lines, the break left out
            TickFileChunks(dir);         // chunks cut once and sent again the same, a restart, 404 and a refusal
            TickFileDays(dir);           // the final day: the check, the parts, stored, packed, the raw kept or deleted
            TickFilePull(dir);           // the final pull through the gate, only in the window, from the open to the close
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
        public Func<string, int> Status1s = body => 404;   // 0.6.9: POST /api/bars-1s (404: a Desk without it, as today's)
        public readonly List<string> Bodies1s = new List<string>();
        public Func<string, int> StatusTicks = body => 200;   // the NQ tick file: POST /api/ticks/chunk and /api/ticks/day
        public Func<string, string> AnswerTicks = body => "{\"ok\":true,\"stored\":true,\"packed\":false}";
        public readonly List<string> BodiesTicks = new List<string>();
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
                            if (c.Request.Url.AbsolutePath == "/api/bars-1s")
                            {
                                lock (Bodies1s) Bodies1s.Add(body);
                                int code1 = Status1s(body);
                                byte[] b1 = System.Text.Encoding.UTF8.GetBytes(code1 == 200 ? "{\"ok\":true}" : "{\"detail\":\"bars must be a list\"}");
                                c.Response.StatusCode = code1; c.Response.OutputStream.Write(b1, 0, b1.Length); c.Response.Close();
                                return;
                            }
                            if (c.Request.Url.AbsolutePath.StartsWith("/api/ticks/"))
                            {
                                lock (BodiesTicks) BodiesTicks.Add(c.Request.Url.AbsolutePath + " " + body);
                                int code2 = StatusTicks(body);
                                byte[] b2 = System.Text.Encoding.UTF8.GetBytes(code2 == 200 ? AnswerTicks(body) : "{\"detail\":\"ticks must be a list\"}");
                                c.Response.StatusCode = code2; c.Response.OutputStream.Write(b2, 0, b2.Length); c.Response.Close();
                                return;
                            }
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
        public List<string> All1s() { lock (Bodies1s) return Bodies1s.ToList(); }
        public List<string> AllTicks() { lock (BodiesTicks) return BodiesTicks.ToList(); }
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
        if (r.BarsPeriod != null && r.BarsPeriod.BarsPeriodType == BarsPeriodType.Tick) { r.Answer(answerTicks(r), ErrorCode.NoError); return true; }   // 0.6.9
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
        ChartBridgeBars.ReadConfig("bars1s", "off");   // 0.6.9: the 1-minute cases as before; the 1 second cases turn it on (OneSecond*)
        ChartBridgeBars.CatchUpSessions = 5; ChartBridgeBars.RequestTimeoutMs = 60000; ChartBridgeBars.QueueWaitMs = 60000; ChartBridgeBars.MaxTries = 3;
        ChartBridgeBars.TickMs = 10000; ChartBridgeBars.SettleMs = 120000; ChartBridgeBars.PlanEveryMs = 60000;
        foreach (string f in new[] { "pending_bars.jsonl", "sent_bars.txt", "rejected_bars.jsonl", "refused_bars.txt", "config.txt", "sent_bars1s.txt", "refused_bars1s.txt", "rejected_bars1s.jsonl" }) File.Delete(Path.Combine(dir, "ChartBridge", f));
        if (Directory.Exists(Path.Combine(dir, "ChartBridge", "bars1s"))) Directory.Delete(Path.Combine(dir, "ChartBridge", "bars1s"), true);
        ChartBridgeBarsQueue.Load();
        ChartBridgeBars1sQueue.Load();
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
                  ChartBridgeServer.Version == "0.6.9", "S2 OneSession: contract v1 fields, bridge 0.6.9, pc HOME: " + (b.Length > 160 ? b.Substring(0, 160) : b));
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
            ChartBridgeBars.ReadConfig("bars", "on"); ChartBridgeBars.ReadConfig("barsRoots", "MNQ"); ChartBridgeBars.ReadConfig("pc", "HOME"); ChartBridgeBars.ReadConfig("bars1s", "off");   // 0.6.9: the 1-minute case
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
    // ------------------------------------------------------------ 0.6.9: 1 second bars (Anthony 2026-10-24, the stats suite's Phase 2)
    // The stand-in NinjaTrader's trades for a tick request: answerTicks (per case). TicksFor makes a session of made-up trades: one
    // every `every` seconds from the 18:00 ET open to the 17:00 close, the even ones with a quote stored (at the ask), the odd ones
    // without, plus three trades of the session before (the request covers whole days from 12:00 AM), which are left out.
    static Func<BarsRequest, Bars> answerTicks = r => new Bars();
    static Bars TicksFor(DateTime session, int every)
    {
        Bars b = new Bars();
        DateTime openEt = session.Date.AddDays(-1).AddHours(18);
        for (int k = 0; k < 3; k++) { b.Add(NtOf(session.Date.AddDays(-1).AddHours(12).AddSeconds(k)), 1, 1, 1, 24990, 1); b.Bids.Add(0); b.Asks.Add(0); }
        for (int sec = 0, n = 0; sec < 23 * 3600; sec += every, n++)
        {
            double p = 25000 + (sec % 13) * 0.25;
            b.Add(NtOf(openEt.AddSeconds(sec)).AddMilliseconds(250), p, p, p, p, 1 + sec % 3);
            if (n % 2 == 0) { b.Bids.Add(p - 0.25); b.Asks.Add(p); } else { b.Bids.Add(0); b.Asks.Add(0); }
        }
        return b;
    }
    static bool IsTicks1s(BarsRequest r) { return IsBars(r) && r.BarsPeriod != null && r.BarsPeriod.BarsPeriodType == BarsPeriodType.Tick; }
    static List<BarsRequest> TicksMade(int from) { return Made(from).Where(IsTicks1s).ToList(); }
    static List<string> Rows1s(string body) { return Regex.Matches(body, "\\[(\\d{13}),([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+),(\\d+),(\\d+),(\\d+)\\]").Cast<Match>().Select(m => m.Value).ToList(); }
    static string Field1s(string body, string key) { Match m = Regex.Match(body, "\"" + key + "\":(\"[^\"]*\"|[^,}\\]]*)"); return m.Success ? m.Groups[1].Value : "(none)"; }
    static string Bars1sDir(string dir) { return Path.Combine(dir, "ChartBridge", "bars1s"); }
    static Desk Fresh1s(string dir, string roots, DateTime nowUtc)
    {
        Desk d = Fresh(dir, roots, nowUtc);
        ChartBridgeBars.ReadConfig("bars1s", "on");
        answerTicks = r => TicksFor(SessionOf1s(r), 7);
        return d;
    }
    // The session a tick request asks for: to the close (17:00 ET of the session date, NinjaTrader's time) or to now.
    static DateTime SessionOf1s(BarsRequest r)
    {
        DateTime toEt = TimeZoneInfo.ConvertTimeFromUtc(TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(r.To, DateTimeKind.Unspecified), NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo), NY);
        return toEt.TimeOfDay > TimeSpan.FromHours(17) ? toEt.Date.AddDays(1) : toEt.Date;
    }

    static void OneSecondBuilder()
    {
        NtZone(Chicago);
        DateTime ou, cu; ChartBridgeBars.SessionUtc(D(2026, 9, 30), out ou, out cu);
        long from = Ms(ou), to = Ms(cu);
        Func<double, DateTime> At = secAfterOpen => NtOf(W(2026, 9, 29, 18, 0)).AddMilliseconds(secAfterOpen * 1000);
        SecondsBuilder b = new SecondsBuilder(from, to);
        b.Add(NtOf(W(2026, 9, 29, 17, 59)).AddSeconds(59.9), 24990, 5, 24989.75, 24990);   // the break: not this session
        b.Add(At(0.1), 25000, 2, 24999.75, 25000);       // at the ask: a buy (bidAsk)
        b.Add(At(0.4), 24999.75, 1, 24999.75, 25000);    // at the bid: a sell (bidAsk)
        b.Add(At(0.9), 25000.25, 3, 0, 0);               // no quote stored, above the last: a buy (tick rule)
        b.Add(At(1.0), 25000.25, 2, 0, 0);               // exactly on the next second: its own row; same price: the last side (buy)
        b.Add(At(5.0), 25000.25, 1, 0, 0);               // seconds 2 to 4 had no trade: no rows for them (gaps stay gaps)
        b.Add(At(5.5), 25000, 4, 24999.75, 25000.25);    // between the quotes: the tick rule, below the last: a sell
        b.Add(NtOf(W(2026, 9, 30, 17, 0)), 25010, 9, 0, 0);   // at the close: not this session
        SecondsBuild r = b.Finish();
        string rows = string.Join(" ", r.Rows.Select(x => "[" + x.T + "," + x.O + "," + x.H + "," + x.L + "," + x.C + "," + x.V + "," + x.Buy + "," + x.Sell + "]").ToArray());
        long t0 = Ms(ou);
        string want = "[" + t0 + ",25000,25000.25,24999.75,25000.25,6,5,1] [" + (t0 + 1000) + ",25000.25,25000.25,25000.25,25000.25,2,2,0] [" + (t0 + 5000) + ",25000.25,25000.25,25000,25000,5,1,4]";
        Check(rows == want, "1s builder: one row per second with trades: t its open (UTC ms), o h l c, v, buy volume, sell volume; a trade on the second starts the next row; seconds with no trade are left out: " + rows);
        Check(r.Trades == 6 && r.Volume == 13 && r.BidAsk == 2 && r.TickRule == 4 && r.None == 0 && r.Outside == 2 && r.Method == "mixed",
              "1s builder: sides counted by method (2 from the quote stored with the trade, 4 by the tick rule), the break and the close left out: " + r.Trades + " " + r.BidAsk + " " + r.TickRule + " " + r.Outside + " " + r.Method);
        // the first trade of the session with no quote has no side (the tick rule starts over at 18:00, as live)
        SecondsBuilder b2 = new SecondsBuilder(from, to);
        b2.Add(At(2), 25000, 3, 0, 0); b2.Add(At(2.5), 25000, 1, 0, 0); b2.Add(At(2.7), 25000.5, 2, 0, 0);
        SecondsBuild r2 = b2.Finish();
        Check(r2.Rows.Count == 1 && r2.Rows[0].V == 6 && r2.Rows[0].Buy == 2 && r2.Rows[0].Sell == 0 && r2.None == 2 && r2.TickRule == 1 && r2.Method == "tickRule",
              "1s builder: no quote and no trade before: no side (its volume in v only, v less bv less sv is the unknown); the tick rule after: " + r2.Rows[0].V + "/" + r2.Rows[0].Buy + "/" + r2.Rows[0].Sell + " none " + r2.None);
        // NinjaTrader's time zone: the same trades from Tokyo and London stamp the same UTC seconds
        foreach (TimeZoneInfo z in new[] { Tokyo, London, NY })
        {
            NtZone(z);
            SecondsBuilder bz = new SecondsBuilder(from, to);
            bz.Add(NtOf(W(2026, 9, 29, 18, 0)).AddMilliseconds(100), 25000, 1, 0, 0);
            bz.Add(NtOf(W(2026, 9, 30, 16, 59)).AddSeconds(59.5), 25001, 1, 0, 0);
            SecondsBuild rz = bz.Finish();
            Check(rz.Rows.Count == 2 && rz.Rows[0].T == Ms(ou) && rz.Rows[1].T == Ms(cu) - 1000, "1s builder: NinjaTrader in " + z.Id + ": the 18:00:00 ET and 16:59:59 ET seconds stamped exactly in UTC");
        }
        NtZone(Chicago);
        // a trade out of time order (never seen; kept exact): into its own second, open and close of that second untouched
        SecondsBuilder b3 = new SecondsBuilder(from, to);
        b3.Add(At(0), 25000, 1, 0, 0); b3.Add(At(3), 25002, 1, 0, 0); b3.Add(At(0.5), 24998, 2, 0, 0); b3.Add(At(1.5), 25001, 1, 0, 0);
        SecondsBuild r3 = b3.Finish();
        Check(r3.Rows.Count == 3 && r3.Rows[0].L == 24998 && r3.Rows[0].V == 3 && r3.Rows[0].C == 25000 && r3.Rows[1].T == Ms(ou) + 1000 && r3.OutOfOrder == 2,
              "1s builder: a trade out of order goes to its own second (sorted rows, no duplicate second): " + string.Join(",", r3.Rows.Select(x => x.T - Ms(ou)).ToArray()));
        // BuildSeconds reads the 1 tick series' stored bid and ask (GetBid/GetAsk): none stored (0): the tick rule for every trade
        Bars plain = new Bars();
        for (int i = 0; i < 4; i++) plain.Add(At(i), 25000 + i, 25000 + i, 25000 + i, 25000 + i, 1);
        SecondsBuild r4 = (SecondsBuild)ChartBridgeBars.BuildSeconds(plain, from, to);
        Check(r4.Rows.Count == 4 && r4.Method == "tickRule" && r4.None == 1 && r4.TickRule == 3, "1s builder: a tick series with no bid and ask stored: sides by the tick rule, said as tickRule: " + r4.Method);
    }

    static void OneSecondMessages()
    {
        SecondsBuilder b = new SecondsBuilder(0, long.MaxValue);
        for (int i = 0; i < 5; i++) b.Add(new DateTime(2026, 9, 30, 13, 0, i, 100, DateTimeKind.Unspecified), 25000 + i * 0.25, 2, 25000 + i * 0.25 - 0.25, 25000 + i * 0.25);
        NtZone(Chicago);
        SecondsBuild sb = b.Finish();
        int perWas = ChartBridgeBars.Rows1sPerPart;
        ChartBridgeBars.Rows1sPerPart = 2;
        ChartBridgeBars.ReadConfig("pc", "HOME");
        List<string> parts = ChartBridgeBars.Messages1s("MNQ 12-26", "MNQ", 0.25, D(2026, 9, 30), sb, "a1b2c3d4e5f6");
        ChartBridgeBars.Rows1sPerPart = perWas;
        string head = "{\"v\":2,\"source\":\"chartbridge\",\"bridge\":\"" + ChartBridgeServer.Version + "\",\"pc\":\"HOME\",\"contract\":\"MNQ 12-26\",\"root\":\"MNQ\",\"tick\":0.25,\"session\":\"2026-09-30\",\"tf\":\"1s\",\"stamp\":\"open\",\"cols\":[\"t\",\"o\",\"h\",\"l\",\"c\",\"v\",\"bv\",\"sv\"],\"sides\":{\"method\":\"bidAsk\",\"bidAsk\":5,\"tickRule\":0,\"none\":0},\"set\":\"a1b2c3d4e5f6\",\"part\":";
        Check(parts.Count == 3 && parts.All(x => x.StartsWith(head) && x.EndsWith("],\"complete\":true}")) && Field1s(parts[0], "part") == "1" && Field1s(parts[2], "part") == "3" && parts.All(x => Field1s(x, "parts") == "3") &&
              parts.All(x => Field1s(x, "setRows") == "5" && Field1s(x, "setTrades") == "5" && Field1s(x, "setVolume") == "10") && Rows1s(parts[0]).Count == 2 && Rows1s(parts[2]).Count == 1,
              "1s message (contract v2): 5 rows at 2 a part are 3 parts of one set, each with the set's totals, rows [t,o,h,l,c,v,bv,sv]: " + parts[0].Substring(0, Math.Min(420, parts[0].Length)));
        Check(ChartBridgeBars1sQueue.KeyOfLine(parts[1]) == "2026-09-30 MNQ 12-26" && ChartBridgeBars1sQueue.KeyOfLine(ChartBridgeBars.MessageJson("MNQ 12-26", "MNQ", 0.25, D(2026, 9, 30), new List<DeskBar>())) == null,
              "1s message: its key read back from the line; a 1-minute line is never taken for one");
        Check(Field1s(parts[0], "first") == Field1s(parts[2], "first") && Field1s(parts[0], "last") == sb.Rows[4].T.ToString(), "1s message: first and last second of the whole session in every part");
    }

    static void OneSecondSession(string dir)
    {
        // the 1-minute message of a session, with the 1 second bars off and on: byte for byte the same
        DateTime now = EtToUtc(W(2026, 9, 30, 17, 6));
        Desk off = Fresh(dir, "MNQ", now);
        string m1off;
        try { ChartBridgeBars.CatchUpSessions = 1; ChartBridgeBars.PlanOnce(null); m1off = off.All().FirstOrDefault() ?? ""; }
        finally { off.Stop(); }
        Desk desk = Fresh1s(dir, "MNQ", now);
        try
        {
            desk.Status1s = body => 200;
            ChartBridgeBars.CatchUpSessions = 1;
            int m0 = MadeCount();
            ChartBridgeBars.PlanOnce(null);
            string m1on = desk.All().FirstOrDefault() ?? "";
            Check(m1off.Length > 0 && m1on == m1off, "1s session: the 1-minute message is byte for byte the same with the 1 second bars on (" + m1on.Length + " bytes)");
            List<BarsRequest> ticks = TicksMade(m0);
            BarsRequest r = ticks.FirstOrDefault();
            Check(ticks.Count == 1 && r.BarsPeriod.Value == 1 && r.BarsPeriod.MarketDataType == MarketDataType.Last && r.MergePolicy == MergePolicy.DoNotMerge && r.TradingHours != null &&
                  r.Instrument.FullName == "MNQ 12-26" && r.From == W(2026, 9, 29, 17, 0) && r.To == W(2026, 9, 30, 16, 0),
                  "1s session: one request, 1 tick, Last, DoNotMerge, the trading hours, from the open itself (18:00 ET, 17:00 in NinjaTrader's Chicago time; Sunday 11-01 item 11: not the whole session before) to the close: " + (r == null ? "none" : r.From + " to " + r.To));
            List<string> got = desk.All1s();
            List<string> rows = got.SelectMany(Rows1s).ToList();
            int parts = got.Count;
            bool oneSet = got.Select(x => Field1s(x, "set")).Distinct().Count() == 1;
            bool inOrder = got.Select((x, i) => Field1s(x, "part") == (i + 1).ToString() && Field1s(x, "parts") == parts.ToString()).All(x => x);
            List<long> ts = rows.Select(x => long.Parse(x.Substring(1, 13))).ToList();
            bool sorted = ts.Zip(ts.Skip(1), (a, b) => b > a).All(x => x);
            DateTime ou, cu; ChartBridgeBars.SessionUtc(D(2026, 9, 30), out ou, out cu);
            Check(parts == 8 && oneSet && inOrder && rows.Count == 11829 && sorted && ts[0] == Ms(ou) && ts.Last() < Ms(cu) && ts.All(t => t % 1000 == 0) && Field1s(got[0], "setRows") == "11829",
                  "1s session: a trade every 7 s from 18:00 to 17:00 ET: 11,829 seconds in 8 parts of at most 1,500 rows, one set, parts 1 to 8 in order, sorted, inside the session: " + parts + " parts, " + rows.Count + " rows");
            Check(Field1s(got[0], "method") == "\"mixed\"" && got.All(x => x.Length < 128 * 1024), "1s session: sides by the quote stored with half the trades, the tick rule for the rest (mixed); every part under 128 KB (largest " + got.Max(x => x.Length) + " bytes)");
            Check(ChartBridgeBars1sQueue.IsDone("2026-09-30 MNQ 12-26") && Lines(dir, "sent_bars1s.txt").Contains("2026-09-30 MNQ 12-26") && Directory.GetFiles(Bars1sDir(dir)).Length == 0 && Logged("The Desk took the 1 second bars for 2026-09-30 MNQ 12-26 (8 parts)"),
                  "1s session: The Desk took every part: noted in sent_bars1s.txt, bars1s/ emptied");
            int m1 = MadeCount();
            ChartBridgeBars.PlanOnce(null);
            ChartBridgeBars1sQueue.Load();
            ChartBridgeBars.PlanOnce(null);
            Check(TicksMade(m1).Count == 0 && desk.All1s().Count == 8, "1s session: the next pass and a restart ask for nothing more");
            Check(Diag().Contains("\"oneSecond\":{\"on\":true,") && Diag().Contains("\"lastSent\":{\"MNQ 12-26\":\"2026-09-30\"}") && Diag().Contains("11829 seconds, 8 messages, 3 trades outside the session left out (asked 2026-09-29 17:00 to 2026-09-30 16:00 NinjaTrader time), sides mixed"),
                  "1s session: /diag bars.oneSecond: on, last sent, the last build: " + Regex.Match(Diag(), "\"oneSecond\":\\{.*\\}\\}$").Value);
        }
        finally { desk.Stop(); }
        // the roots: NQ and MNQ only (ES and MES get their 1-minute bars as before), and only with their 1-minute bars on
        Desk d2 = Fresh1s(dir, "NQ, MNQ, ES, MES", now);
        try
        {
            d2.Status1s = body => 200;
            ChartBridgeBars.CatchUpSessions = 1;
            int m0 = MadeCount();
            for (int i = 0; i < 4; i++) ChartBridgeBars.PlanOnce(null);
            List<string> asked = TicksMade(m0).Select(x => x.Instrument.FullName).ToList();
            Check(asked.Count == 2 && asked.Contains("NQ 12-26") && asked.Contains("MNQ 12-26") && d2.All().Count == 4, "1s roots: NQ and MNQ only, one a pass; the four 1-minute messages as before: " + string.Join(", ", asked));
        }
        finally { d2.Stop(); }
        Desk d3 = Fresh1s(dir, "ES", now);
        try { int m0 = MadeCount(); ChartBridgeBars.PlanOnce(null); Check(TicksMade(m0).Count == 0, "1s roots: barsRoots without NQ and MNQ: no 1 second request"); }
        finally { d3.Stop(); }
        Desk d4 = Fresh(dir, "MNQ", now);
        try { int m0 = MadeCount(); ChartBridgeBars.ReadConfig("bars1s", "off"); ChartBridgeBars.PlanOnce(null); Check(TicksMade(m0).Count == 0 && !ChartBridgeBars.OneSecondOn, "1s: bars1s = off: none, the 1-minute bars as before"); }
        finally { d4.Stop(); }
        ChartBridgeBars.ResetConfig(); ChartBridgeBars.ReadConfig("bars", "on");
        Check(ChartBridgeBars.OneSecondOn, "1s: on by default with bars = on (Anthony approved Phase 2 on 2026-10-24)");
        ChartBridgeBars.ResetConfig();
        Check(!ChartBridgeBars.OneSecondOn, "1s: off with bars off");
    }

    static void OneSecondWindow()
    {
        // 2026-10-07 is a Wednesday, 10-10 a Saturday, 10-11 a Sunday, 10-09 a Friday
        foreach (var c in new[] {
            new { At = W(2026, 10, 7, 8, 0), In = false, What = "Wednesday 08:00 (premarket)" },
            new { At = W(2026, 10, 7, 9, 30), In = false, What = "Wednesday 09:30 (regular hours)" },
            new { At = W(2026, 10, 7, 16, 14), In = false, What = "Wednesday 16:14" },
            new { At = W(2026, 10, 7, 16, 15), In = true, What = "Wednesday 16:15 (the window opens)" },
            new { At = W(2026, 10, 7, 17, 59), In = true, What = "Wednesday 17:59" },
            new { At = W(2026, 10, 7, 18, 0), In = false, What = "Wednesday 18:00 (the evening session opens)" },
            new { At = W(2026, 10, 7, 23, 0), In = false, What = "Wednesday 23:00 (evening session)" },
            new { At = W(2026, 10, 8, 2, 0), In = false, What = "Thursday 02:00 (overnight)" },
            new { At = W(2026, 10, 9, 16, 15), In = true, What = "Friday 16:15" },
            new { At = W(2026, 10, 9, 20, 0), In = false, What = "Friday 20:00 (a weekday evening, outside the window)" },
            new { At = W(2026, 10, 10, 0, 0), In = true, What = "Saturday 00:00" },
            new { At = W(2026, 10, 10, 13, 0), In = true, What = "Saturday 13:00" },
            new { At = W(2026, 10, 11, 17, 59), In = true, What = "Sunday 17:59" },
            new { At = W(2026, 10, 11, 18, 0), In = false, What = "Sunday 18:00 (the week's evening session opens)" },
            new { At = W(2026, 10, 12, 16, 15), In = true, What = "Monday 16:15" } })
            Check(ChartBridgeBars.In1sWindow(c.At) == c.In, "1s window: " + c.What + (c.In ? ": requests and sends may go" : ": nothing asked or sent"));
        // review of #71 (MEDIUM 2): a new request starts by 17:50 (the window's end less 10 minutes); sends may go on to 18:00
        foreach (var c in new[] {
            new { At = W(2026, 10, 7, 16, 15), In = true, What = "Wednesday 16:15" },
            new { At = W(2026, 10, 7, 17, 49), In = true, What = "Wednesday 17:49" },
            new { At = W(2026, 10, 7, 17, 50), In = false, What = "Wednesday 17:50" },
            new { At = W(2026, 10, 7, 17, 59), In = false, What = "Wednesday 17:59" },
            new { At = W(2026, 10, 10, 23, 59), In = true, What = "Saturday 23:59" },
            new { At = W(2026, 10, 11, 17, 49), In = true, What = "Sunday 17:49" },
            new { At = W(2026, 10, 11, 17, 50), In = false, What = "Sunday 17:50" } })
            Check(ChartBridgeBars.In1sStartWindow(c.At) == c.In, "1s start window: " + c.What + (c.In ? ": a request may start" : ": no new request (one may run past 18:00)"));
    }

    static void OneSecondRthAndOnePerPass(string dir)
    {
        // a start at 10:00 ET: the 1-minute catch-up runs as before; no 1 second request in regular trading hours; at 16:16 ET they go
        DateTime now = EtToUtc(W(2026, 10, 7, 10, 0));
        Desk desk = Fresh1s(dir, "MNQ", now);
        try
        {
            desk.Status1s = body => 200;
            ChartBridgeBars.CatchUpSessions = 2;
            int m0 = MadeCount();
            ChartBridgeBars.PlanOnce(null);
            int minutes = BarsMade(m0).Count(x => !IsTicks1s(x)), ticks = TicksMade(m0).Count;
            string st = Regex.Match(Diag(), "\"oneSecond\":\\{\"on\":true,\"state\":\"[^\"]*\"").Value;
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 7, 16, 16));
            ChartBridgeBars.PlanOnce(null);
            int after1 = TicksMade(m0).Count;
            ChartBridgeBars.PlanOnce(null);
            int after2 = TicksMade(m0).Count;
            Check(minutes == 2 && ticks == 0 && st.Contains("waiting: 1 second bars go 16:15 to 18:00 ET on weekdays and on the weekend") && after1 == 1 && after2 == 2,
                  "1s RTH: at 10:00 ET the 1-minute catch-up goes (" + minutes + "), no tick request (" + ticks + "); after 16:15 one a pass (" + after1 + ", " + after2 + ")");
            // the sends wait out regular trading hours too: a set queued, The Desk up, 10:00 the next day: nothing posted
            int posted = desk.All1s().Count;
            File.Delete(Path.Combine(dir, "ChartBridge", "sent_bars1s.txt"));
            ChartBridgeBars1sQueue.Load();
            SecondsBuilder b = new SecondsBuilder(0, long.MaxValue); b.Add(new DateTime(2026, 10, 6, 12, 0, 0), 25000, 1, 0, 0);
            ChartBridgeBars1sQueue.Queue("2026-10-06 NQ 12-26", ChartBridgeBars.Messages1s("NQ 12-26", "NQ", 0.25, D(2026, 10, 6), b.Finish(), "rth000000001"));
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 8, 10, 0));
            ChartBridgeBars1sQueue.Flush(null);
            int inRth = desk.All1s().Count - posted;
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 8, 16, 20));
            ChartBridgeBars1sQueue.Flush(null);
            Check(inRth == 0 && desk.All1s().Count - posted == 1, "1s RTH: a waiting set is not posted in regular trading hours; at 16:20 ET it goes");
            // the start's catch-up outside the window waits for it: a start at 08:00 ET (premarket) and at 19:00 ET (evening session)
            // asks nothing; at 16:15 it goes; Saturday any time; Sunday 18:00 nothing
            // review of #71 (MEDIUM 2): the pass's 1-minute requests take time: the clock is read again before a 1 second request.
            // A pass that starts at 17:45 and whose minute answer comes at 17:52 (or 18:01) asks for no trades.
            foreach (int doneAt in new[] { 52, 61 })
            {
                Desk dl = Fresh1s(dir, "MNQ", EtToUtc(W(2026, 9, 30, 17, 45)));
                try
                {
                    DateTime clk = EtToUtc(W(2026, 9, 30, 17, 45));
                    ChartBridgeBars.UtcNow = () => clk;
                    BarsRequest.AutoAnswer = r => { if (!IsTicks1s(r)) clk = EtToUtc(W(2026, 9, 30, 17, 0)).AddMinutes(doneAt); return AnswerLikeNt(r); };
                    dl.Status1s = body => 200;
                    ChartBridgeBars.CatchUpSessions = 1;
                    int l0 = MadeCount();
                    ChartBridgeBars.PlanOnce(null);
                    Check(dl.All().Count == 1 && TicksMade(l0).Count == 0 && Diag().Contains("(a request starts by 17:50)"),
                          "1s review of #71: a pass from 17:45 whose minute request ends at " + (doneAt >= 60 ? "18:01" : "17:" + doneAt) + ": the clock read again, no tick request");
                }
                finally { BarsRequest.AutoAnswer = AnswerLikeNt; dl.Stop(); }
            }
            foreach (var c in new[] {
                new { At = W(2026, 10, 9, 8, 0), Goes = false, What = "a Friday 08:00 start (premarket)" },
                new { At = W(2026, 10, 8, 19, 0), Goes = false, What = "a Thursday 19:00 start (evening session)" },
                new { At = W(2026, 10, 8, 16, 14), Goes = false, What = "Thursday 16:14" },
                new { At = W(2026, 10, 8, 16, 15), Goes = true, What = "Thursday 16:15" },
                new { At = W(2026, 10, 10, 9, 0), Goes = true, What = "a Saturday 09:00 start" },
                new { At = W(2026, 10, 11, 18, 0), Goes = false, What = "Sunday 18:00" } })
            {
                Desk dw = Fresh1s(dir, "MNQ", EtToUtc(c.At));
                try
                {
                    dw.Status1s = body => 200;
                    ChartBridgeBars.CatchUpSessions = 1;
                    int w0 = MadeCount();
                    ChartBridgeBars.PlanOnce(null);
                    Check((TicksMade(w0).Count == 1) == c.Goes && (dw.All1s().Count > 0) == c.Goes && dw.All().Count == 1,
                          "1s window, the start's catch-up: " + c.What + (c.Goes ? ": the request and the parts go" : ": no tick request and nothing posted; the 1-minute bars as before") + " (" + TicksMade(w0).Count + ")");
                }
                finally { dw.Stop(); }
            }
        }
        finally { desk.Stop(); }
        // never beside the chart: a page loading (the gate's own rule) holds the 1 second request back
        Desk d2 = Fresh1s(dir, "MNQ", EtToUtc(W(2026, 9, 30, 17, 6)));
        ChartBridgeClient loading = new ChartBridgeClient(null, 9901) { Root = "MNQ" };
        try
        {
            ChartBridgeBars.CatchUpSessions = 1;
            ChartBridgeBarsQueue.Queue(ChartBridgeBars.KeyOf(D(2026, 9, 30), "MNQ 12-26"), ChartBridgeBars.MessageJson("MNQ 12-26", "MNQ", 0.25, D(2026, 9, 30), new List<DeskBar> { new DeskBar { T = Ms(Utc(2026, 9, 30, 13, 30)), O = 1, H = 1, L = 1, C = 1, V = 1 } }));
            Clients()[loading.Id] = loading;
            int m0 = MadeCount();
            ChartBridgeBars.PlanOnce(null);
            Check(TicksMade(m0).Count == 0 && Diag().Contains("\"state\":\"waiting for the gate: a chart is loading\""), "1s: while a chart loads, no tick request (the gate's rule for the bars): " + Regex.Match(Diag(), "\"oneSecond\":\\{\"on\":true,\"state\":\"[^\"]*\"").Value);
            Clients().TryRemove(loading.Id, out loading);
            ChartBridgeBars.PlanOnce(null);
            Check(TicksMade(m0).Count == 1, "1s: once the chart is loaded it goes");
        }
        finally { ChartBridgeClient x; Clients().TryRemove(9901, out x); d2.Stop(); }
    }

    static void OneSecondOldDeskAndRestart(string dir)
    {
        Desk desk = Fresh1s(dir, "MNQ", EtToUtc(W(2026, 9, 30, 17, 6)));
        try
        {
            // today's Desk has no POST /api/bars-1s (404): the set stays on disk, nothing is set aside or refused, offered again later
            ChartBridgeBars.CatchUpSessions = 1;
            ChartBridgeBars.PlanOnce(null);
            string key = "2026-09-30 MNQ 12-26";
            string file = ChartBridgeBars1sQueue.FileOf(key);
            Check(File.Exists(file) && File.ReadAllLines(file).Length == 8 && ChartBridgeBars1sQueue.IsWaiting(key) && !ChartBridgeBars1sQueue.IsRefused(key) && ChartBridgeBars1sQueue.DeskHasNone &&
                  Lines(dir, "rejected_bars1s.jsonl").Length == 0 && Logged("The Desk has no 1 second bars store yet (POST /api/bars-1s answered 404)") && desk.All1s().Count == 1,
                  "1s old Desk: 404: the 8 parts stay in bars1s/, nothing set aside or refused, said once, offered every 30 minutes (one post so far)");
            ChartBridgeBars1sQueue.Flush(null);
            Check(desk.All1s().Count == 1, "1s old Desk: not offered again before 30 minutes");
            // The Desk gets its store: the parts go; it takes 3, then is down (503); a restart; the rest go, part 4 first, none twice
            int n = 0;
            desk.Status1s = body => ++n <= 3 ? 200 : 503;
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 9, 30, 17, 40));
            ChartBridgeBars1sQueue.Flush(null);
            Check(File.ReadAllLines(Path.ChangeExtension(file, ".sent")).Length == 3 && ChartBridgeBars1sQueue.WaitingParts() == 5 && Logged("The Desk did not take 1 second bars"),
                  "1s: three parts taken (noted in the .sent file, the big file not rewritten), then The Desk is down: 5 wait");
            ChartBridgeBars1sQueue.Load();   // a restart
            Check(ChartBridgeBars1sQueue.WaitingParts() == 5, "1s: after a restart the set comes back from bars1s/ with its progress");
            desk.Status1s = body => 200;
            int before = desk.All1s().Count;
            ChartBridgeBars1sQueue.Flush(null);
            List<string> got = desk.All1s();
            List<string> taken = got.Skip(1).Take(3).Concat(got.Skip(before)).ToList();   // got[0]: the 404; then parts 1 to 3 taken, part 4 refused with 503
            Check(got.Skip(before).Select(x => Field1s(x, "part")).SequenceEqual(new[] { "4", "5", "6", "7", "8" }) && taken.Select(x => Field1s(x, "part")).SequenceEqual(new[] { "1", "2", "3", "4", "5", "6", "7", "8" }) &&
                  ChartBridgeBars1sQueue.IsDone(key) && !File.Exists(file) && Logged("The Desk is taking 1 second bars again."),
                  "1s: from part 4 on, each part once (" + string.Join(",", got.Skip(before).Select(x => Field1s(x, "part")).ToArray()) + "), the set done");
            // a set waiting for a session older than 10 days is dropped when the queue is read
            SecondsBuilder b = new SecondsBuilder(0, long.MaxValue); b.Add(new DateTime(2026, 9, 10, 12, 0, 0), 25000, 1, 0, 0);
            ChartBridgeBars1sQueue.Queue("2026-09-10 MNQ 09-26", ChartBridgeBars.Messages1s("MNQ 09-26", "MNQ", 0.25, D(2026, 9, 10), b.Finish(), "old000000001"));
            ChartBridgeBars1sQueue.Load();
            Check(!ChartBridgeBars1sQueue.IsWaiting("2026-09-10 MNQ 09-26") && !File.Exists(ChartBridgeBars1sQueue.FileOf("2026-09-10 MNQ 09-26")), "1s: a waiting set older than 10 days is dropped at the start (the folder stays small)");
            // a set cut short (a crash mid-write leaves only the temp file, or a broken file): dropped and asked for again
            File.WriteAllText(ChartBridgeBars1sQueue.FileOf("2026-09-29 MNQ 12-26"), "{\"v\":2,\"source\":\"chartbridge\",\"tf\":\"1s\",\"session\":\"2026-09-29\",\"con");
            ChartBridgeBars1sQueue.Load();
            Check(!ChartBridgeBars1sQueue.IsWaiting("2026-09-29 MNQ 12-26") && Logged("unreadable 1 second bars set(s) in bars1s"), "1s: a broken set file is dropped at the start (asked for again)");
        }
        finally { desk.Stop(); }
    }

    static void OneSecondRefused(string dir)
    {
        Desk desk = Fresh1s(dir, "MNQ", EtToUtc(W(2026, 9, 30, 17, 6)));
        try
        {
            desk.Status1s = body => Field1s(body, "part") == "2" ? 400 : 200;
            ChartBridgeBars.CatchUpSessions = 1;
            ChartBridgeBars.PlanOnce(null);
            string key = "2026-09-30 MNQ 12-26";
            Check(ChartBridgeBars1sQueue.IsRefused(key) && Lines(dir, "refused_bars1s.txt").Contains(key) && Lines(dir, "rejected_bars1s.jsonl").Length == 1 && !File.Exists(ChartBridgeBars1sQueue.FileOf(key)) &&
                  Logged("The Desk refused part 2 of the 1 second bars for 2026-09-30 MNQ 12-26 (400: bars must be a list)") && desk.All1s().Count == 2,
                  "1s refused: a part The Desk calls malformed: set aside, the set dropped, refused_bars1s.txt, not asked again; the 1-minute bars unaffected (" + desk.All().Count + ")");
            int m0 = MadeCount();
            ChartBridgeBars1sQueue.Load();
            ChartBridgeBars.PlanOnce(null);
            Check(TicksMade(m0).Count == 0 && desk.All().Count == 1, "1s refused: after a restart not asked again");
            // NinjaTrader has no trades: tried 3 times, 15 minutes apart, then left until a restart; an error the same
            Desk d2 = Fresh1s(dir, "MNQ", EtToUtc(W(2026, 10, 1, 17, 6)));
            try
            {
                answerTicks = r => new Bars();
                ChartBridgeBars.CatchUpSessions = 1;
                int t0 = MadeCount();
                for (int i = 0; i < 6; i++) { DateTime at = EtToUtc(W(2026, 10, 1, 17, 6)).AddMinutes(16 * i); ChartBridgeBars.UtcNow = () => at; ChartBridgeBars.PlanOnce(null); }
                Check(TicksMade(t0).Count == 3 && Logged("1 second bars for MNQ 12-26 session 2026-10-01: NinjaTrader has no trades for it; tried 3 times") && d2.All().Count == 1,
                      "1s: a session with no trades in NinjaTrader: asked 3 times 15 minutes apart, then not until a restart (" + TicksMade(t0).Count + ")");
            }
            finally { d2.Stop(); }
        }
        finally { desk.Stop(); }
    }

    static void OneSecondSpeed()
    {
        // NinjaTrader's thread does one pass over the trades: about a busy NQ session (600,000 trades) on the stand-in series
        NtZone(Chicago);
        DateTime ou, cu; ChartBridgeBars.SessionUtc(D(2026, 9, 30), out ou, out cu);
        Bars b = new Bars();
        DateTime open = NtOf(W(2026, 9, 29, 18, 0));
        int n = 600000;
        for (int i = 0; i < n; i++) { double p = 25000 + (i % 40) * 0.25; b.Add(open.AddMilliseconds(i * 138L), p, p, p, p, 1 + i % 4); b.Bids.Add(i % 3 == 0 ? p - 0.25 : 0); b.Asks.Add(i % 3 == 0 ? p : 0); }
        System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
        SecondsBuild r = (SecondsBuild)ChartBridgeBars.BuildSeconds(b, Ms(ou), Ms(cu));
        double ms = sw.Elapsed.TotalMilliseconds;
        Console.WriteLine("     (1s build: " + n + " trades into " + r.Rows.Count + " seconds in " + Math.Round(ms) + " ms on the stand-in series, " + Math.Round(ms * 1000.0 / n, 3) + " us a trade)");
        Check(r.Trades == n && r.Rows.Count > 80000 && ms < 3000, "1s speed: 600,000 trades in one pass in " + Math.Round(ms) + " ms (the stand-in; NinjaTrader's own series reads arrays), rows only kept (" + r.Rows.Count + ")");
    }

    // ------------------------------------------------------------ the NQ tick file (ChartBridgeTicks.cs, Sunday 11-01)
    static TickRec Tr(long u, double p, long v) { return new TickRec { U = u, P = p, V = v, Contract = "NQ 12-26" }; }

    static void TickCheckCases()
    {
        long t0 = 1790719200000L;
        List<TickRec> live = new List<TickRec> { Tr(t0 + 100, 25000, 1), Tr(t0 + 900, 25000.25, 2), Tr(t0 + 1500, 25000, 1) };
        TickCheckResult same = TickCheck.Compare(live, live.ToList());
        Check(same.Status == "exact" && same.LiveTicks == 3 && same.HistTicks == 3 && same.Detail.Count == 0, "tick check: the same trades every second: exact");
        // the history has the same trades at other milliseconds of the same seconds (NinjaTrader's two clocks): still exact
        TickCheckResult shifted = TickCheck.Compare(live, new List<TickRec> { Tr(t0 + 5, 25000, 1), Tr(t0 + 990, 25000.25, 2), Tr(t0 + 1001, 25000, 1) });
        Check(shifted.Status == "exact", "tick check: second by second, not millisecond by millisecond: " + shifted.Status);
        List<TickRec> more = live.ToList(); more.Add(Tr(t0 + 5000, 25001, 4)); more.Add(Tr(t0 + 5100, 25001, 1));
        TickCheckResult filled = TickCheck.Compare(live, more);
        Check(filled.Status == "filled" && filled.SecondsLiveMissed == 1 && filled.TicksLiveMissed == 2 && filled.Detail.Count == 1 && filled.Detail[0][0] == t0 + 5000 && filled.Detail[0][2] == 2,
              "tick check: history has trades the live capture missed (a disconnect): filled, the second listed: " + filled.Status);
        TickCheckResult failed = TickCheck.Compare(more, live);
        Check(failed.Status == "failed" && failed.SecondsHistShort == 1 && failed.TicksHistShort == 2 && !failed.Passed, "tick check: live has trades the history lacks: failed");
        TickCheckResult vol = TickCheck.Compare(new List<TickRec> { Tr(t0, 25000, 5) }, new List<TickRec> { Tr(t0, 25000, 3) });
        Check(vol.Status == "failed", "tick check: the same count with less volume in history: failed");
        Check(TickCheck.Compare(live, new List<TickRec>()).Status == "failed", "tick check: no history at all: failed");
    }

    static string TicksDir(string dir) { return Path.Combine(dir, "ChartBridge", "ticks"); }
    static void TickFresh(string dir)
    {
        ChartBridgeTicks.Stop();
        ChartBridgeTicks.ResetConfig();
        if (Directory.Exists(TicksDir(dir))) Directory.Delete(TicksDir(dir), true);
        ChartBridgeBars.ReadConfig("bars", "on");
        ChartBridgeBars.ReadConfig("pc", "WORK");
        ChartBridgeTicks.Start();   // threads started; stopped at once so the cases drive each step themselves
        ChartBridgeTicks.Stop();
        typeof(ChartBridgeTicks).GetField("capturing", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, true);
        ChartBridgeTicks.QueueMax = 200000; ChartBridgeTicks.ChunkMaxTicks = 20000; ChartBridgeTicks.PartMaxTicks = 20000;
    }
    static void TickScan() { typeof(ChartBridgeTicks).GetMethod("ScanFolder", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null); }
    static void TickForget()
    {
        ((System.Collections.IDictionary)typeof(ChartBridgeTicks).GetField("Keys", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null)).Clear();
        typeof(ChartBridgeTicks).GetMethod("LoadDays", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null);
    }
    static void Feed(DateTime etWall, double p, long v) { ChartBridgeTicks.OnTrade("NQ", "NQ 12-26", 0.25, Ms(EtToUtc(etWall)), p, v, 1, ChartBridgeSides.BidAsk); }
    static string TickDiag() { return ChartBridgeTicks.DiagJson(); }

    static void TickFileCapture(string dir)
    {
        TickFresh(dir);
        ChartBridgeTicks.QueueMax = 5;
        for (int i = 0; i < 8; i++) Feed(W(2026, 10, 6, 9, 30).AddSeconds(i), 25000 + i * 0.25, 1);
        ChartBridgeTicks.OnTrade("MNQ", "MNQ 12-26", 0.25, Ms(EtToUtc(W(2026, 10, 6, 9, 31))), 25000, 1, 1, 2);
        Check(TickDiag().Contains("\"queue\":5,\"queueMax\":5,\"droppedQueue\":3,"), "tick file: a full queue drops and counts, never waits; MNQ is not captured (its bars come from NQ's ticks): " + TickDiag().Substring(0, 120));
        ChartBridgeTicks.QueueMax = 200000;
        Feed(W(2026, 10, 6, 17, 30), 25010, 1);   // the 17:00 to 18:00 break: no session
        Feed(W(2026, 10, 6, 18, 0), 25011, 2);    // 18:00: the next session (dated 2026-10-07)
        int n = ChartBridgeTicks.WriteOnce();
        string raw = Path.Combine(TicksDir(dir), "2026-10-06_NQ_12-26.raw"), raw7 = Path.Combine(TicksDir(dir), "2026-10-07_NQ_12-26.raw");
        string[] lines = File.Exists(raw) ? File.ReadAllLines(raw) : new string[0];
        Check(n == 6 && lines.Length == 5 && File.Exists(raw7) && File.ReadAllLines(raw7).Length == 1 && TickDiag().Contains("\"outside\":1,"),
              "tick file: the writer puts each trade in its session's raw file (18:00 starts the next), the break left out and counted: " + n + " written, " + lines.Length + " lines");
        Check(lines.Length > 0 && lines[0] == Ms(EtToUtc(W(2026, 10, 6, 9, 30))) + ",25000,1,1,2", "tick file: one line a trade, u (UTC ms), price, volume, side, method: " + (lines.Length > 0 ? lines[0] : ""));
        string[] state = File.ReadAllLines(Path.Combine(TicksDir(dir), "2026-10-06_NQ_12-26.state"));
        Check(state.Length == 4 && Regex.IsMatch(state[0], "^run [0-9a-f]{12}$") && state[1] == "tick 0.25", "tick file: the state file starts with the run id and the tick size");
        // over tickFileMaxMB: the batch is dropped and counted
        typeof(ChartBridgeTicks).GetField("diskBytes", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, ChartBridgeTicks.MaxBytes + 1);
        Feed(W(2026, 10, 6, 9, 40), 25000, 1);
        Check(ChartBridgeTicks.WriteOnce() == 0 && TickDiag().Contains("\"droppedDisk\":1,") && File.ReadAllLines(raw).Length == 5, "tick file: over tickFileMaxMB a batch is dropped and counted, nothing written");
        typeof(ChartBridgeTicks).GetField("diskBytes", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, 0L);
        // off: nothing captured
        ChartBridgeTicks.ReadConfig("tickFile", "off");
        Check(!ChartBridgeTicks.On, "tick file: tickFile = off turns it off (bars stay on)");
        ChartBridgeTicks.ResetConfig();
        ChartBridgeBars.ResetConfig();
        Check(!ChartBridgeTicks.On, "tick file: off without bars = on");
    }

    static void TickFileChunks(string dir)
    {
        TickFresh(dir);
        Desk desk = new Desk();
        string urlWas = ChartBridgeConfig.DeskUrl;
        ChartBridgeConfig.DeskUrl = desk.Url;
        ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 6, 10, 0));
        try
        {
            for (int i = 0; i < 5; i++) Feed(W(2026, 10, 6, 9, 30).AddSeconds(i), 25000 + i * 0.25, 1 + i);
            ChartBridgeTicks.WriteOnce();
            ChartBridgeTicks.ChunkMaxTicks = 3;
            int cut = ChartBridgeTicks.CutOnce();
            string key = "2026-10-06 NQ 12-26";
            string c1 = ChartBridgeTicks.ChunkJson(key, 1), c1b = ChartBridgeTicks.ChunkJson(key, 1), c2 = ChartBridgeTicks.ChunkJson(key, 2);
            Check(cut == 2 && c1 == c1b && Field1s(c1, "count") == "3" && Field1s(c2, "count") == "2" && Field1s(c2, "seq") == "2" && Field1s(c1, "pc") == "\"WORK\"" &&
                  c1.Contains("\"root\":\"NQ\",\"contract\":\"NQ 12-26\",\"tick\":0.25,\"session\":\"2026-10-06\",\"run\":\"") && c1.Contains("\"sides\":{\"bidAsk\":3,\"tickRule\":0,\"none\":0}") &&
                  c1.Contains("\"cols\":[\"u\",\"p\",\"v\",\"s\"],\"ticks\":[[" + Ms(EtToUtc(W(2026, 10, 6, 9, 30))) + ",25000,1,1],"),
                  "tick chunks: 5 trades at 3 a chunk are 2 chunks; a chunk read again is byte for byte the same (its byte range is kept): " + c1.Substring(0, Math.Min(300, c1.Length)));
            Check(ChartBridgeTicks.SendChunks(null) == 2 && desk.AllTicks().Count == 2 && desk.AllTicks()[0].StartsWith("/api/ticks/chunk {") && ChartBridgeTicks.SendChunks(null) == 0,
                  "tick chunks: both posted to /api/ticks/chunk once; nothing sent again");
            Check(TickDiag().Contains("\"lastSent\":{\"NQ 12-26\":\"2026-10-06 #2\"}") && TickDiag().Contains("\"chunks\":2,\"sent\":2,\"aside\":0"), "tick chunks: /diag lastSent and the file's counts: " + TickDiag());
            // a restart: the state file carries on (same run, the next seq)
            TickForget(); TickScan();
            Feed(W(2026, 10, 6, 9, 35), 25003, 1);
            ChartBridgeTicks.WriteOnce(); ChartBridgeTicks.CutOnce();
            string c3 = ChartBridgeTicks.ChunkJson(key, 3);
            int sent3 = ChartBridgeTicks.SendChunks(null);
            Check(sent3 == 1 && c3 != null && Field1s(c3, "run") == Field1s(c1, "run") && Field1s(c3, "count") == "1", "tick chunks: after a restart only the new chunk goes, seq 3 of the same run: " + sent3 + " " + (c3 ?? "null") + " " + TickDiag());
            // The Desk without the route (404): every chunk waits, offered again after 30 minutes
            desk.StatusTicks = body => 404;
            Feed(W(2026, 10, 6, 9, 36), 25003, 1);
            ChartBridgeTicks.WriteOnce(); ChartBridgeTicks.CutOnce();
            Check(ChartBridgeTicks.SendChunks(null) == 0 && TickDiag().Contains("\"deskHasNoTicks\":true") && desk.AllTicks().Count == 4, "tick chunks: a 404 keeps the chunk and says so");
            int before = desk.AllTicks().Count;
            ChartBridgeTicks.SendChunks(null);
            Check(desk.AllTicks().Count == before, "tick chunks: not offered again within 30 minutes");
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 6, 10, 31));
            desk.StatusTicks = body => 400;
            ChartBridgeTicks.SendChunks(null);
            string[] st = File.ReadAllLines(Path.Combine(TicksDir(dir), "2026-10-06_NQ_12-26.state"));
            Check(st.Contains("aside 4") && Logged("The Desk refused tick chunk 4 of 2026-10-06 NQ 12-26 (400"), "tick chunks: a refusal sets the chunk aside (its trades stay in the raw file; the final pull covers them)");
            Check(!desk.AllTicks().Any(b => b.Contains("Sim") || b.Contains("account")), "tick chunks: market data and the PC name only");
        }
        finally { desk.Stop(); ChartBridgeConfig.DeskUrl = urlWas; ChartBridgeTicks.ChunkMaxTicks = 20000; }
    }

    static TickDayBuild HistOf(IEnumerable<TickRec> t) { TickDayBuild h = new TickDayBuild(); foreach (TickRec x in t) { h.Ticks.Add(x); h.BidAsk++; } return h; }

    static void TickFileDays(string dir)
    {
        TickFresh(dir);
        Desk desk = new Desk();
        string urlWas = ChartBridgeConfig.DeskUrl;
        ChartBridgeConfig.DeskUrl = desk.Url;
        try
        {
            foreach (int day in new[] { 6, 7, 8 }) for (int i = 0; i < 4; i++) Feed(W(2026, 10, day, 9, 30).AddSeconds(i), 25000 + i * 0.25, 1);
            ChartBridgeTicks.WriteOnce();
            TickScan();
            string k6 = "2026-10-06 NQ 12-26", k7 = "2026-10-07 NQ 12-26", k8 = "2026-10-08 NQ 12-26";
            ChartBridgeTicks.PartMaxTicks = 2;
            List<TickRec> live6 = ChartBridgeTicks.ReadAllLive(k6);
            List<TickRec> hist6 = live6.ToList(); hist6.Add(Tr(Ms(EtToUtc(W(2026, 10, 6, 11, 0))), 25005, 3));   // a trade the live capture missed
            TickCheckResult r6 = ChartBridgeTicks.FinishDay(k6, HistOf(hist6));
            string day6 = Path.Combine(TicksDir(dir), "2026-10-06_NQ_12-26.day.jsonl");
            string[] parts = File.ReadAllLines(day6);
            Check(r6.Status == "filled" && parts.Length == 3 && parts.All(p => Field1s(p, "setTicks") == "5" && Field1s(p, "parts") == "3") && parts[0].Contains("\"check\":{\"status\":\"filled\",\"liveTicks\":4,") &&
                  parts[0].EndsWith(",\"complete\":true}") && Lines(dir, "ticks/tickdays.txt").Contains(k6 + "\tfilled\t0\t0"),
                  "tick days: the history (one trade more) checked against the live capture: filled; written whole as 3 parts with the check: " + parts[0].Substring(0, Math.Min(400, parts[0].Length)));
            Check(ChartBridgeTicks.DaysToPull(EtToUtc(W(2026, 10, 9, 17, 6))).SequenceEqual(new[] { k7, k8 }), "tick days: a day done is not pulled again; the others are, oldest first");
            // outside the window nothing goes
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 9, 10, 0));
            Check(ChartBridgeTicks.SendDays(null) == 0 && desk.AllTicks().Count == 0, "tick days: sent only in the 1 second bars' window (not at 10:00 ET)");
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 9, 16, 30));
            Check(ChartBridgeTicks.SendDays(null) == 3 && desk.AllTicks().All(b => b.StartsWith("/api/ticks/day {")), "tick days: the 3 parts to /api/ticks/day in the window");
            string raw6 = Path.Combine(TicksDir(dir), "2026-10-06_NQ_12-26.raw");
            Check(File.Exists(raw6) && !File.Exists(day6) && Lines(dir, "ticks/tickdays.txt").Contains(k6 + "\tfilled\t1\t0") && Logged("the raw file is kept (not packed yet)"),
                  "tick days: The Desk stored it but did not pack it: the raw file is kept (deleted only after the pack)");
            // stored and packed: the raw is deleted
            desk.AnswerTicks = body => "{\"ok\":true,\"stored\":true,\"kept\":true,\"packed\":true}";
            ChartBridgeTicks.FinishDay(k7, HistOf(ChartBridgeTicks.ReadAllLive(k7)));
            ChartBridgeTicks.SendDays(null);
            Check(!File.Exists(Path.Combine(TicksDir(dir), "2026-10-07_NQ_12-26.raw")) && !File.Exists(Path.Combine(TicksDir(dir), "2026-10-07_NQ_12-26.state")) && Lines(dir, "ticks/tickdays.txt").Contains(k7 + "\texact\t1\t1"),
                  "tick days: checked (exact), stored and packed: the raw file and its state are deleted");
            // a failed check: sent marked failed, the raw kept even when The Desk says packed
            List<TickRec> hist8 = ChartBridgeTicks.ReadAllLive(k8).Skip(1).ToList();
            TickCheckResult r8 = ChartBridgeTicks.FinishDay(k8, HistOf(hist8));
            ChartBridgeTicks.SendDays(null);
            Check(r8.Status == "failed" && File.Exists(Path.Combine(TicksDir(dir), "2026-10-08_NQ_12-26.raw")) && desk.AllTicks().Last().Contains("\"check\":{\"status\":\"failed\"") && Logged("the check FAILED"),
                  "tick days: a failed check is sent marked failed and keeps its raw until Anthony rules");
            // older than 7 days: listed in /diag
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 16, 16, 30));
            Check(TickDiag().Contains("\"rawOld\":[\"2026-10-06 NQ 12-26\",\"2026-10-08 NQ 12-26\"]"), "tick days: raw files older than 7 days are flagged in /diag: " + Regex.Match(TickDiag(), "\"rawOld\":\\[[^\\]]*\\]").Value);
            // a refused part: the day set aside, the raw kept
            desk.StatusTicks = body => 422;
            TickForget(); TickScan();
            Feed(W(2026, 10, 9, 9, 30), 25000, 1); ChartBridgeTicks.WriteOnce(); TickScan();
            ChartBridgeTicks.FinishDay("2026-10-09 NQ 12-26", HistOf(ChartBridgeTicks.ReadAllLive("2026-10-09 NQ 12-26")));
            ChartBridgeTicks.SendDays(null);
            Check(File.Exists(Path.Combine(TicksDir(dir), "2026-10-09_NQ_12-26.day.jsonl.refused")) && File.Exists(Path.Combine(TicksDir(dir), "2026-10-09_NQ_12-26.raw")), "tick days: a refused part sets the day aside; the raw stays");
        }
        finally { desk.Stop(); ChartBridgeConfig.DeskUrl = urlWas; ChartBridgeTicks.PartMaxTicks = 20000; }
    }

    static void TickFilePull(string dir)
    {
        DateTime now = EtToUtc(W(2026, 10, 6, 17, 6));
        Desk desk = Fresh(dir, "NQ", now);
        try
        {
            TickFresh(dir);
            ChartBridgeBars.ReadConfig("bars", "on");
            ChartBridgeBars.ReadConfig("barsRoots", "NQ");
            List<DateTime> walls = new List<DateTime>();
            for (int i = 0; i < 50; i++) walls.Add(W(2026, 10, 6, 9, 30).AddSeconds(i * 7).AddMilliseconds(120));
            foreach (DateTime w in walls) Feed(w, 25000, 1);
            ChartBridgeTicks.WriteOnce();
            answerTicks = r =>
            {
                Bars b = new Bars();
                b.Add(NtOf(W(2026, 10, 5, 12, 0)), 24990, 24990, 24990, 24990, 1); b.Bids.Add(0); b.Asks.Add(0);   // the day before: left out
                foreach (DateTime w in walls) { b.Add(NtOf(w), 25000, 25000, 25000, 25000, 1); b.Bids.Add(24999.75); b.Asks.Add(25000); }
                return b;
            };
            // 10:00 ET: trading hours, no request at all
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 7, 10, 0));
            int m0 = MadeCount();
            Check(!ChartBridgeTicks.PlanDay(null) && TicksMade(m0).Count == 0, "tick pull: never in trading hours (10:00 ET): no request");
            ChartBridgeBars.UtcNow = () => now;
            ChartBridgeBars.CatchUpSessions = 1;
            m0 = MadeCount();
            ChartBridgeBars.PlanOnce(null);
            List<BarsRequest> asked = TicksMade(m0);
            BarsRequest r0 = asked.FirstOrDefault();
            DateTime ou, cu; ChartBridgeBars.SessionUtc(D(2026, 10, 6), out ou, out cu);
            TimeZoneInfo z = NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo;
            Check(asked.Count == 1 && r0.Instrument.FullName == "NQ 12-26" && r0.From == TimeZoneInfo.ConvertTimeFromUtc(ou, z) && r0.To == TimeZoneInfo.ConvertTimeFromUtc(cu, z) && r0.BarsPeriod.BarsPeriodType == BarsPeriodType.Tick,
                  "tick pull: after the close, one tick request through the gate, from the session's open to its close (NinjaTrader's time): " + (r0 == null ? "none" : r0.From + " to " + r0.To));
            Check(Lines(dir, "ticks/tickdays.txt").Contains("2026-10-06 NQ 12-26\texact\t0\t0") && File.Exists(Path.Combine(TicksDir(dir), "2026-10-06_NQ_12-26.day.jsonl")),
                  "tick pull: the history matches the live capture second by second: exact, queued for The Desk");
            m0 = MadeCount();
            ChartBridgeBars.PlanOnce(null);
            Check(TicksMade(m0).Count == 0, "tick pull: a day done is not asked for again");
            Check(((string)Priv("DiagJson")).Contains("\"tickFile\":{\"on\":true,"), "tick file: /diag has tickFile");
        }
        finally { desk.Stop(); ChartBridgeTicks.Stop(); ChartBridgeTicks.ResetConfig(); typeof(ChartBridgeTicks).GetField("capturing", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, false); }
    }
}
