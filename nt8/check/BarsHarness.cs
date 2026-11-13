// Daily 1-minute bars to The Desk (ChartBridge 0.3.6, ChartBridgeBars.cs), run for real on Mono inside check:orders
// (SeamHarness.Run calls BarsHarness.Run last). First the pure rules: the session date (18:00 New York start, Sunday open to
// Monday, daylight saving in March and November, early closes), NinjaTrader's close stamps to open times in UTC from
// several NinjaTrader time zones, which sessions the catch-up picks, the contract per root and session, the message.
// Then the failure scenarios, each through ChartBridgeServer's own gate (0.3.5) with the stand-in BarsRequest, a stand-in
// Desk and the bars worker thread:
//   S1 OffByDefault, S2 OneSession (both daylight saving changes, Sunday's open), S3 DeskUnreachable, S4 CatchUpAtStart,
//   S5 NeverBesideTheChart (a window out, a window queued behind bars, a backfill to come, a stuck gate, a bars request
//   NinjaTrader never answers), S6 StopDuringRequest (and during a post), S7 ContractPerRoot, S8 Diag, and RTH.
// 0.6.9 to 0.6.14 had the 1 second bars' cases (OneSecond*); 0.6.15 retires the 1 second pull (Anthony 2026-11-03: everything is
// built from the ticks), and Retired1s checks it is gone: an old config line does nothing, no 1 second request or post at any hour,
// the tick file's final pull in the same pass as the 1-minute bars, the files it left untouched, /diag without it.
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
            TickCheckCases();            // the NQ tick file (Sunday 11-01): the check of the live capture against the history (pure)
            TickFileCapture(dir);        // the queue's bound (drop and count), NQ only, the raw lines, the break left out
            TickFileChunks(dir);         // chunks cut once and sent again the same, a restart, 404 and a refusal
            TickFileDrops(dir);          // lost trades and feed drops go to the files of their session at their next cut; a restart says gaps
            TickFileOneCutter(dir);      // the restart race: an old sender never writes a cut after the new one started
            TickFileCutOfMany(dir);      // re-review 1: a cut of several chunks that took drops flags every one of them
            TickFileDays(dir);           // the final day: the check, the parts, stored, packed, the raw kept or deleted
            TickFileUnstored(dir);       // a day not stored: kept and sent again later (3 times), never deleted before stored
            TickFilePull(dir);           // the final pull through the gate, only in the window, from the open to the close
            EveningWindow();             // the evening window's edges (In1sWindow, In1sStartWindow), the tick file's final pull, sends and packed asks
            TickDayMorningWindow();      // Anthony 2026-11-03: the final pull's morning catch-up before 09:15 ET on weekdays (pure)
            TickDayMorning(dir);         // the catch-up through the gate: closed sessions only, starts before 09:15, the 1 second bars not widened
            TickFilePacked(dir);         // 2026-11-03: stored, not packed: the last part sent again once a day; packed: the raw deleted
            TickFileGhosts(dir);         // review LOW 3: the raw deleted before the key is forgotten; no ghost key, no chunk that cannot be read
            TickFileAskedOnce(dir);      // review LOW 4: the asked date kept in memory too; LOW 2: a flagged day packed via the master
            TickCheckRule();             // 0.6.14 (Anthony 2026-11-03): failed only when history is empty or under 90 percent; short; holes (pure)
            TickFileRule(dir);           // 0.6.14: the known gaps from the flagged chunks, the summary's share and holes, short passed everywhere
            TickFileRecheck(dir);        // 0.6.14: a day failed under the old rule, its raw kept, checked again once
            TickFileAllFlagged(dir);     // 0.6.14 review LOW 1: every chunk flagged, skewed history: judged on the whole span
            TickFileRefusedAgain(dir);   // 0.6.14 review LOW 2: refused again after a recheck: no resend loop; the recovery
            Retired1s(dir);              // 0.6.15: the 1 second pull retired; the tick file's final pull as before, no longer behind it
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
        public Func<string, int> Status1s = body => 404;   // POST /api/bars-1s: 0.6.15 never posts there (the 1 second pull is retired); any post is recorded
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
        ChartBridgeBars.CatchUpSessions = 5; ChartBridgeBars.RequestTimeoutMs = 60000; ChartBridgeBars.QueueWaitMs = 60000; ChartBridgeBars.MaxTries = 3;
        ChartBridgeBars.TickMs = 10000; ChartBridgeBars.SettleMs = 120000; ChartBridgeBars.PlanEveryMs = 60000;
        foreach (string f in new[] { "pending_bars.jsonl", "sent_bars.txt", "rejected_bars.jsonl", "refused_bars.txt", "config.txt", "sent_bars1s.txt", "refused_bars1s.txt", "rejected_bars1s.jsonl" }) File.Delete(Path.Combine(dir, "ChartBridge", f));
        if (Directory.Exists(Path.Combine(dir, "ChartBridge", "bars1s"))) Directory.Delete(Path.Combine(dir, "ChartBridge", "bars1s"), true);   // what an earlier case made of the retired 1 second pull's files
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
                  ChartBridgeServer.Version == "0.6.22", "S2 OneSession: contract v1 fields, bridge 0.6.22, pc HOME: " + (b.Length > 160 ? b.Substring(0, 160) : b));
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
            Check(d.Contains(",\"pc\":\"HOME\",\"pcFrom\":\"config.txt\"}") && d.EndsWith("}"), "Diag: bars.pc is the name every Desk message carries, from config.txt here (the install job checks pc = WORK / HOME; 0.6.15: pcFrom is the last key, oneSecond is gone): " + Regex.Match(d, "\"pc\":[^,]*,\"pcFrom\":\"[^\"]*\"").Value);
            string pcWas = ChartBridgeBars.PcName();
            ChartBridgeBars.ReadConfig("pc", "");
            string d0 = Diag();
            Check(d0.Contains("\"pcFrom\":\"computer name\"") && !d0.Contains("\"pc\":\"HOME\""), "Diag: without pc in config.txt, bars.pc is the Windows computer name and pcFrom says so");
            ChartBridgeBars.ReadConfig("pc", pcWas);
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
    // ------------------------------------------------------------ the stand-in NinjaTrader's tick requests (the tick file's final pull)
    // The stand-in NinjaTrader's trades for a tick request: answerTicks (per case). (0.6.9 to 0.6.14 also served the 1 second bars'
    // requests; that pull is retired in 0.6.15.)
    static Func<BarsRequest, Bars> answerTicks = r => new Bars();
    static bool IsTicks1s(BarsRequest r) { return IsBars(r) && r.BarsPeriod != null && r.BarsPeriod.BarsPeriodType == BarsPeriodType.Tick; }
    static List<BarsRequest> TicksMade(int from) { return Made(from).Where(IsTicks1s).ToList(); }
    static string Field1s(string body, string key) { Match m = Regex.Match(body, "\"" + key + "\":(\"[^\"]*\"|[^,}\\]]*)"); return m.Success ? m.Groups[1].Value : "(none)"; }
    static string Bars1sDir(string dir) { return Path.Combine(dir, "ChartBridge", "bars1s"); }

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
        Check(vol.Status == "short" && vol.Passed, "tick check (0.6.14): the same count with less volume in history: short (passed)");
        Check(TickCheck.Compare(live, new List<TickRec>()).Status == "failed", "tick check: no history at all: failed");
    }

    // ------------------------------------------------------------ 0.6.14: the day check's rule (Anthony 2026-11-03)
    // Made-up trades only. One trade a second from t0 for n seconds, at ms into each second.
    static List<TickRec> Every(long t0, int from, int to, int ms) { List<TickRec> l = new List<TickRec>(); for (int i = from; i < to; i++) l.Add(Tr(t0 + i * 1000L + ms, 25000, 1)); return l; }

    static void TickCheckRule()
    {
        long t0 = 1790719200000L;
        Check(TickCheck.ThinSharePercent == 90 && TickCheck.HoleMinMs == 60000 && TickCheck.Rule == 2, "tick rule: the named constants: 90 percent, 60,000 ms, rule 2");
        Check(TickCheck.IsPassed("exact") && TickCheck.IsPassed("filled") && TickCheck.IsPassed("short") && !TickCheck.IsPassed("failed") && !TickCheck.IsPassed(null), "tick rule: exact, filled and short pass; failed does not");
        // history short in 5 of 100 seconds: 95 percent: passes as short, the counts kept as information
        List<TickRec> live = Every(t0, 0, 100, 500);
        List<TickRec> h95 = live.Where((x, i) => i % 20 != 7).ToList();
        TickCheckResult r = TickCheck.Compare(live, h95);
        Check(r.Status == "short" && r.Passed && r.SecondsHistShort == 5 && r.TicksHistShort == 5 && r.CoveredLive == 100 && r.CoveredHist == 95 && Math.Abs(r.HistoryShare - 0.95) < 1e-9 && r.Holes.Count == 0,
              "tick rule: history short in some seconds, 95 percent of live: short (passed), secondsHistShort and ticksHistShort kept: " + r.Status + " " + r.HistoryShare);
        // the 90 percent line: 90 of 100 passes, 89 of 100 fails
        TickCheckResult r90 = TickCheck.Compare(live, live.Where((x, i) => i % 10 != 3).ToList());
        TickCheckResult r89 = TickCheck.Compare(live, live.Where((x, i) => i % 10 != 3 && i != 98).ToList());
        Check(r90.Status == "short" && r90.CoveredHist == 90 && r89.Status == "failed" && r89.CoveredHist == 89 && !r89.Passed, "tick rule: 90 percent passes (short), 89 percent fails (history thin): " + r90.Status + " " + r89.Status);
        // the same count, less volume in a second: short, not failed
        TickCheckResult vol = TickCheck.Compare(new List<TickRec> { Tr(t0, 25000, 5) }, new List<TickRec> { Tr(t0, 25000, 3) });
        Check(vol.Status == "short" && vol.SecondsHistShort == 1, "tick rule: the same count with less volume in history: short");
        // history more somewhere and less somewhere: short (filled is never less)
        List<TickRec> mixed = h95.ToList(); mixed.Add(Tr(t0 + 50500, 25000, 1)); mixed.Add(Tr(t0 + 50600, 25000, 1));
        Check(TickCheck.Compare(live, mixed).Status == "short", "tick rule: more in one second and less in others: short");
        // no history at all: failed
        TickCheckResult none = TickCheck.Compare(live, new List<TickRec>());
        Check(none.Status == "failed" && none.CoveredHist == 0 && none.HistoryShare == 0, "tick rule: no history: failed");

        // (coordinator, WORK's look at Monday 2026-11-02) history stamps a trade 4 ms early to 106 ms late, so a trade late in its
        // second lands in the next one: per second differences, never a hole, never a failure
        List<TickRec> sk = new List<TickRec>(), skh = new List<TickRec>();
        int[] skew = { -4, 106, 30, 99, 0, 57 };
        for (int i = 0; i < 400; i++)
        {
            int ms = i % 3 == 0 ? 950 + (i % 50) : 100 + i % 700;   // every third trade in the last .950 to .999 of its second
            long u = t0 + i * 1000L + ms; sk.Add(Tr(u, 25000, 1)); sk.Add(Tr(u + 1, 25000, 1));
            skh.Add(Tr(u + skew[i % skew.Length], 25000, 1)); skh.Add(Tr(u + 1 + skew[(i + 1) % skew.Length], 25000, 1));
        }
        TickCheckResult rs = TickCheck.Compare(sk, skh);
        Check(rs.SecondsHistShort > 50 && rs.Holes.Count == 0 && rs.Status == "short" && rs.Passed && rs.HistoryShare >= 0.99,
              "tick rule: NinjaTrader's history stamping 4 ms early to 106 ms late: history short in " + rs.SecondsHistShort + " seconds, no hole, passed (short, share " + rs.HistoryShare + ")");
        // the worst skew everywhere: every history trade 106 ms late, each one in the next second (one trade a second at .950)
        TickCheckResult late = TickCheck.Compare(Every(t0, 0, 300, 950), Every(t0, 0, 300, 950).Select(x => Tr(x.U + 106, x.P, x.V)).ToList());
        Check(late.Holes.Count == 0 && late.Status == "short" && late.SecondsHistShort == 1 && late.SecondsLiveMissed == 1 && late.CoveredHist == 299,
              "tick rule: every history trade 106 ms late: no hole (history has a trade in every second but the first), short: " + late.Status + " " + late.SecondsHistShort + " " + late.Holes.Count);

        // a hole: history has no trade for 81 s (from its trade at 99.4 s to its trade at 180.4 s) while live traded 80 times, in a
        // 1,000 second day (92 percent): passes, the hole listed from history trade to history trade, with the live trades inside
        List<TickRec> day = Every(t0, 0, 1000, 400);
        List<TickRec> hHole = day.Where(x => x.U < t0 + 100000 || x.U >= t0 + 180000).ToList();
        TickCheckResult rh = TickCheck.Compare(day, hHole);
        Check(rh.Status == "short" && rh.Passed && rh.Holes.Count == 1 && rh.Holes[0][0] == t0 + 99400 && rh.Holes[0][1] == t0 + 180400 && rh.Holes[0][2] == 80 && rh.Holes[0][3] == 0,
              "tick rule: an 81 second history silence with live trades never fails the day; listed from history trade to history trade, with its live trades: " + string.Join(";", rh.Holes.Select(h => h[0] - t0 + "-" + (h[1] - t0) + "/" + h[2]).ToArray()));
        // the third re-review: a hole is bounded by history trades and measured in ms: 60.0 s is a hole, 59.9 s is not (live every
        // 100 ms; history the same with none strictly between its trades at a and b)
        Check(TickCheck.HoleMinMs == 60000 && TickCheck.HoleMarginMs == 1000 && TickCheck.SkewEarlyMs == 4 && TickCheck.SkewLateMs == 106, "tick rule: the constants: 60,000 ms, a 1,000 ms margin, the measured skew 4 ms early and 106 ms late");
        List<TickRec> dense = new List<TickRec>();
        for (int i = 0; i < 3000; i++) dense.Add(Tr(t0 + 37 + i * 100L, 25000, 1));
        foreach (long len in new long[] { 60000, 59900 })
        {
            long ha = t0 + 100037, hb = ha + len;
            TickCheckResult rl = TickCheck.Compare(dense, dense.Where(x => x.U <= ha || x.U >= hb).ToList());
            Check(len == 60000 ? rl.Holes.Count == 1 && rl.Holes[0][0] == ha && rl.Holes[0][1] == hb && rl.Holes[0][2] == 599 : rl.Holes.Count == 0,
                  "tick rule: a " + (len / 1000.0).ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + " s history silence with live trades inside: " + (len == 60000 ? "a hole (not second-aligned: from " + (ha - t0) + " to " + (hb - t0) + ")" : "not a hole"));
        }
        // the margin (HoleMarginMs, 1,000 ms, wider than the measured skew on purpose): one live trade inside a 62 s history silence.
        // Within 1,000 ms of either history trade that bounds it: no hole; further in, a hole.
        List<TickRec> hm = Every(t0, 0, 100, 500).Concat(Every(t0, 161, 300, 500)).ToList();   // history trades at 99.5 s and 161.5 s
        foreach (long[] e in new[] { new long[] { 1000, 0 }, new long[] { 1001, 1 }, new long[] { 62000 - 1000, 0 }, new long[] { 62000 - 1001, 1 } })
        {
            List<TickRec> lm = hm.ToList(); lm.Add(Tr(t0 + 99500 + e[0], 25000, 1));
            TickCheckResult rmg = TickCheck.Compare(lm, hm);
            Check(rmg.Holes.Count == e[1], "tick rule: one live trade " + e[0] + " ms after the history trade that starts a 62 s silence: " + (e[1] == 1 ? "a hole" : "no hole (inside the margin)"));
        }
        // probes with made-up random trades (a fixed seed), quiet stretches included. The skew: as measured (4 ms early to 106 ms
        // late), with 1 percent of the stamps 107 to 300 ms late (worse than measured).
        Random pr = new Random(20261103);
        Func<int> skewMs = () => pr.Next(100) == 0 ? 107 + pr.Next(194) : -4 + pr.Next(111);
        double[] rates = { 0.02, 0.05, 0.2, 1.0, 5.0, 20.0 };
        // (a) skew alone: history the same trades, each skewed: never a hole
        int probes = 0, falseHoles = 0, narrow = 0;
        foreach (double rate in rates)
        {
            int fr = 0, nr = 0;
            for (int trial = 0; trial < 100; trial++)
            {
                List<TickRec> pl = new List<TickRec>(), ph = new List<TickRec>();
                int n = Math.Max(1, (int)(rate * 600));
                for (int i = 0; i < n; i++) { long u = t0 + (long)(pr.NextDouble() * 600000); pl.Add(Tr(u, 25000, 1)); ph.Add(Tr(u + skewMs(), 25000, 1)); }
                fr += TickCheck.Compare(pl, ph).Holes.Count; probes++;
                nr += MarginHoles(pl, ph, 4, 106);
            }
            falseHoles += fr; narrow += nr;
            Console.WriteLine("     (skew probes at " + rate.ToString(System.Globalization.CultureInfo.InvariantCulture) + " trades a second: 100 random 10 minute captures, 1 percent of stamps 107 to 300 ms late: " + fr + " false holes; with the measured 4 / 106 ms margin there would be " + nr + ")");
        }
        Check(falseHoles == 0, "tick rule: the skew probes (1 percent of stamps 107 to 300 ms late) give no false hole: " + falseHoles + " in " + probes + " (the 4 / 106 ms margin would give " + narrow + ")");
        // (b) a real 60.0 s history silence (history has no trade for 60.0 s of its own time from a random millisecond), skewed
        // history: listed whenever a live trade falls inside it beyond the margin; no hole anywhere else
        foreach (double rate in new[] { 0.02, 0.05, 0.2, 1.0, 2.0, 5.0, 20.0 })
        {
            int listed = 0, eligible = 0, tries = 200, elsewhere = 0, wrong = 0;
            for (int trial = 0; trial < tries; trial++)
            {
                List<TickRec> pl = new List<TickRec>(), ph = new List<TickRec>();
                long g0 = t0 + 120000 + pr.Next(1000), g1 = g0 + 60000;
                int n = Math.Max(1, (int)(rate * 300));
                for (int i = 0; i < n; i++)
                {
                    long u = t0 + (long)(pr.NextDouble() * 300000), h = u + skewMs();
                    pl.Add(Tr(u, 25000, 1));
                    if (h < g0 || h >= g1) ph.Add(Tr(h, 25000, 1));   // the gap is in history's own time
                }
                if (ph.Count == 0) continue;
                long[] hs = ph.Select(x => x.U).OrderBy(x => x).ToArray();
                long a = hs.Where(x => x < g0).DefaultIfEmpty(long.MinValue).Max(), b = hs.Where(x => x >= g1).DefaultIfEmpty(long.MaxValue).Min();
                bool can = a != long.MinValue && b != long.MaxValue && pl.Any(x => x.U > a + TickCheck.HoleMarginMs && x.U < b - TickCheck.HoleMarginMs);
                TickCheckResult pg = TickCheck.Compare(pl, ph);
                bool got = pg.Holes.Any(x => x[0] == a && x[1] == b);
                if (can) eligible++;
                if (got) listed++;
                if (got != can) wrong++;
                elsewhere += pg.Holes.Count(x => !(x[0] == a && x[1] == b));
            }
            Console.WriteLine("     (a real 60.0 s history silence at a random millisecond, " + rate.ToString(System.Globalization.CultureInfo.InvariantCulture) + " trades a second, skewed history: listed " + listed + " of " + tries +
                              "; a live trade inside beyond the margin in " + eligible + "; holes elsewhere " + elsewhere + ")");
            Check(wrong == 0 && elsewhere == 0 && (rate < 1 || listed >= tries * 98 / 100),
                  "tick rule: a real 60.0 s history silence at " + rate.ToString(System.Globalization.CultureInfo.InvariantCulture) + " trades a second is listed whenever a live trade is inside beyond the margin (" + listed + " of " + tries + "), no hole elsewhere");
        }
        // seconds with no live trade inside count: live at 100 to 109 s and 150 to 159 s, nothing between, history none from 100 to
        // 159 s: one hole from history's trade at 99.4 s to its trade at 160.4 s, 20 live trades
        List<TickRec> sparse = day.Where(x => x.U < t0 + 110000 || x.U >= t0 + 150000).ToList();
        TickCheckResult rq = TickCheck.Compare(sparse, sparse.Where(x => x.U < t0 + 100000 || x.U >= t0 + 160000).ToList());
        Check(rq.Holes.Count == 1 && rq.Holes[0][0] == t0 + 99400 && rq.Holes[0][1] == t0 + 160400 && rq.Holes[0][2] == 20,
              "tick rule: quiet seconds inside a history silence count to its length: " + string.Join(";", rq.Holes.Select(h => h[0] - t0 + "-" + (h[1] - t0) + "/" + h[2]).ToArray()));
        // ... and one history trade in between, even in a second with no live trade, splits it: two silences of about 30 s, no hole
        List<TickRec> hSplit = sparse.Where(x => x.U < t0 + 100000 || x.U >= t0 + 160000).ToList(); hSplit.Add(Tr(t0 + 130200, 25000, 1));
        Check(TickCheck.Compare(sparse, hSplit).Holes.Count == 0, "tick rule: a history trade in between splits the silence (no hole)");
        // a quiet market is no hole: neither feed trades for 200 s, or for 70 s
        List<TickRec> quiet = day.Where(x => x.U < t0 + 100000 || x.U >= t0 + 300000).ToList();
        Check(TickCheck.Compare(quiet, quiet.ToList()).Holes.Count == 0 && TickCheck.Compare(quiet, quiet.ToList()).Status == "exact", "tick rule: no trades in either for 200 seconds: no hole, exact");
        List<TickRec> quiet70 = day.Where(x => x.U < t0 + 100000 || x.U >= t0 + 170000).ToList();
        Check(TickCheck.Compare(quiet70, quiet70.ToList()).Holes.Count == 0, "tick rule: a quiet market where neither feed trades for 70 s is not a hole without a capture gap");
        TickCheckResult q70g = TickCheck.Compare(quiet70, quiet70.ToList(), new List<long[]> { new long[] { t0 + 99400, t0 + 170400 } });
        Check(q70g.Holes.Count == 1 && q70g.Holes[0][3] == 1 && q70g.Holes[0][2] == 0, "tick rule: the same 70 s over a known capture gap is an inGap hole (nobody vouches for it)");
        // the covered span is from the first to the last live trade: history before and after it does not count in the share
        List<TickRec> wide = Every(t0, 0, 1000, 400);
        List<TickRec> liveMid = wide.Where(x => x.U >= t0 + 300000 && x.U < t0 + 400000).ToList();
        List<TickRec> hMid = wide.Where(x => x.U < t0 + 300000 || x.U >= t0 + 400000 || (x.U - t0) / 1000 % 5 == 0).ToList();   // 20 percent inside the span
        TickCheckResult rspan = TickCheck.Compare(liveMid, hMid);
        Check(rspan.Status == "failed" && rspan.CoveredLive == 100 && rspan.CoveredHist == 20 && rspan.SecondsLiveMissed > 800,
              "tick rule: only the span the live capture covered counts: history full outside it does not hide a thin history inside it: " + rspan.Status + " " + rspan.CoveredHist + "/" + rspan.CoveredLive);

        // the known capture gaps: seconds strictly inside a gap leave the span, so history's trades there do not hide a thin history
        // elsewhere. Live 2 trades a second at 0..199 and 400..999 (a restart between), history 2 trades a second at 200..399 and 85
        // percent elsewhere.
        List<TickRec> lg = Every(t0, 0, 200, 300).Concat(Every(t0, 400, 1000, 300)).Concat(Every(t0, 0, 200, 800)).Concat(Every(t0, 400, 1000, 800)).ToList();
        List<TickRec> hg = lg.Where((x, i) => i % 20 != 1 && i % 20 != 2 && i % 20 != 3).ToList();
        hg.AddRange(Every(t0, 200, 400, 300)); hg.AddRange(Every(t0, 200, 400, 700));
        hg = hg.OrderBy(x => x.U).ToList();
        TickCheckResult noGap = TickCheck.Compare(lg, hg);
        List<long[]> gaps = new List<long[]> { new long[] { t0 + 199300, t0 + 400300 } };
        TickCheckResult withGap = TickCheck.Compare(lg, hg, gaps);
        Check(noGap.Status == "filled" || noGap.Status == "short", "tick rule (set up): without the gap the history's trades in the restart hide the thin history: " + noGap.Status + " " + noGap.HistoryShare);
        Check(withGap.Status == "failed" && withGap.CoveredLive == 1600 && withGap.CoveredHist == 1360 && withGap.CoveredSeconds == 800 && !withGap.SpanWhole && Math.Abs(withGap.HistoryShare - 0.85) < 1e-9,
              "tick rule: a known capture gap leaves the span (seconds strictly between its two live trades): 85 percent fails: " + withGap.Status + " " + withGap.CoveredHist + "/" + withGap.CoveredLive);
        Check(!TickCheck.InGap(t0 + 199000, gaps) && TickCheck.InGap(t0 + 200000, gaps) && TickCheck.InGap(t0 + 399000, gaps) && !TickCheck.InGap(t0 + 400000, gaps), "tick rule: the gap's edge seconds stay in the span");
        Check(TickCheck.InGap(t0, new List<long[]> { new long[] { long.MinValue, t0 + 5000 } }) && TickCheck.InGap(t0 + 9000, new List<long[]> { new long[] { t0 + 5000, long.MaxValue } }), "tick rule: a gap with an open end");
        // gaps that leave no live trade: the share is over the whole span (never no check at all)
        TickCheckResult allGap = TickCheck.Compare(live, live.Take(50).ToList(), new List<long[]> { new long[] { long.MinValue, long.MaxValue } });
        Check(allGap.Status == "failed" && allGap.CoveredLive == 100 && allGap.CoveredHist == 50 && allGap.SpanWhole, "tick rule: gaps that cover every live trade: the whole span counts (50 percent fails)");

        // LOW 1 (the PR #79 review): a span left by the gaps under MinCoveredSeconds (600) or MinCoveredLive (1,000): the whole
        // first to last live span. A 6 minute capture, 2 trades a second, one late in its second; history 106 ms late on that one
        // (it lands in the next second); the gaps leave seconds 0 to 2, where the skew alone would make 83 percent.
        Check(TickCheck.MinCoveredSeconds == 600 && TickCheck.MinCoveredLive == 1000, "tick rule: the named constants: 600 seconds, 1,000 live trades");
        List<TickRec> six = Every(t0, 0, 360, 100).Concat(Every(t0, 0, 360, 950)).OrderBy(x => x.U).ToList();
        List<TickRec> sixH = six.Select(x => Tr(x.U % 1000 == 950 ? x.U + 106 : x.U, x.P, x.V)).ToList();
        TickCheckResult sliver = TickCheck.Compare(six, sixH, new List<long[]> { new long[] { t0 + 2950, long.MaxValue } });
        Check(sliver.Status == "short" && sliver.Passed && sliver.SpanWhole && sliver.CoveredSeconds == 360 && sliver.CoveredLive == 720 && sliver.CoveredHist == 719 && sliver.Holes.Count == 0,
              "tick rule: a 6 minute capture whose gaps leave 3 seconds, with skewed history: judged on the whole span, passes (short): " + sliver.Status + " " + sliver.CoveredHist + "/" + sliver.CoveredLive);
        // 700 seconds left but only 700 live trades: the whole span too
        List<TickRec> l700 = Every(t0, 0, 1200, 500);
        TickCheckResult r700 = TickCheck.Compare(l700, l700.ToList(), new List<long[]> { new long[] { t0 + 699500, long.MaxValue } });
        Check(r700.SpanWhole && r700.CoveredSeconds == 1200 && r700.Status == "exact", "tick rule: 700 seconds but fewer than 1,000 live trades left: the whole span");
        // 2,000 seconds and 2,000 live trades left by the gap: the span left is used (85 percent there fails; the whole would pass)
        List<TickRec> l2k = Every(t0, 0, 1000, 500).Concat(Every(t0, 2000, 3000, 500)).ToList();
        List<TickRec> h2k = l2k.Where((x, i) => i % 20 > 2).ToList(); h2k.AddRange(Every(t0, 1000, 2000, 300)); h2k.AddRange(Every(t0, 1000, 2000, 700));
        TickCheckResult r2k = TickCheck.Compare(l2k, h2k, new List<long[]> { new long[] { t0 + 999500, t0 + 2000500 } });
        Check(!r2k.SpanWhole && r2k.CoveredSeconds == 2000 && r2k.CoveredLive == 2000 && r2k.CoveredHist == 1700 && r2k.Status == "failed",
              "tick rule: a capture with 2,000 covered seconds still uses the covered span (85 percent fails): " + r2k.CoveredSeconds + " " + r2k.CoveredHist + "/" + r2k.CoveredLive + " " + r2k.Status);

        // NIT 5 (the coordinator's decision): a history silence of 60 seconds or more over a known capture gap is a hole too (inGap),
        // with the live trades in it (0 here); it never fails the day. Live 0..299 and 500..999, a restart gap between; history full
        // but silent from 350 to 429 (inside the gap).
        List<TickRec> lr = Every(t0, 0, 300, 500).Concat(Every(t0, 500, 1000, 500)).ToList();
        List<TickRec> hr = Every(t0, 0, 350, 500).Concat(Every(t0, 430, 1000, 500)).ToList();
        List<long[]> rg = new List<long[]> { new long[] { t0 + 299500, t0 + 500500 } };
        TickCheckResult rin = TickCheck.Compare(lr, hr, rg);
        Check(rin.Status == "filled" && rin.Passed && rin.Holes.Count == 1 && rin.Holes[0][0] == t0 + 349500 && rin.Holes[0][1] == t0 + 430500 && rin.Holes[0][2] == 0 && rin.Holes[0][3] == 1,
              "tick rule: an 80 second history silence inside a capture gap: a hole (inGap, live 0) on a filled day: " + rin.Status + " " + string.Join(";", rin.Holes.Select(h => h[0] - t0 + "-" + (h[1] - t0) + "/" + h[2] + "/" + h[3]).ToArray()));
        Check(TickCheck.Compare(lr, hr).Holes.Count == 0, "tick rule: the same silence with no known gap there (no live trade in it): no hole");
        // a silence that only touches the gap by one second is over it
        List<TickRec> hr2 = Every(t0, 0, 220, 500).Concat(Every(t0, 301, 1000, 500)).ToList();
        TickCheckResult rin2 = TickCheck.Compare(lr, hr2, rg);
        Check(rin2.Holes.Count == 1 && rin2.Holes[0][0] == t0 + 219500 && rin2.Holes[0][1] == t0 + 301500 && rin2.Holes[0][2] == 80 && rin2.Holes[0][3] == 1,
              "tick rule: a history silence from 219.5 to 301.5 s reaching into the gap: one inGap hole with the 80 live trades in it: " + string.Join(";", rin2.Holes.Select(h => h[0] - t0 + "-" + (h[1] - t0) + "/" + h[2] + "/" + h[3]).ToArray()));
        // an inGap silence: 60.0 s is a hole, 59.9 s is not
        TickCheckResult in60 = TickCheck.Compare(lr, Every(t0, 0, 350, 500).Concat(Every(t0, 409, 1000, 500)).ToList(), rg);
        List<TickRec> h599 = Every(t0, 0, 350, 500); h599.Add(Tr(t0 + 409400, 25000, 1)); h599.AddRange(Every(t0, 410, 1000, 500));
        TickCheckResult in599 = TickCheck.Compare(lr, h599, rg);
        Check(in60.Holes.Count == 1 && in60.Holes[0][0] == t0 + 349500 && in60.Holes[0][1] == t0 + 409500 && in60.Holes[0][3] == 1 && in599.Holes.Count == 0,
              "tick rule: a 60.0 s history silence over a gap is an inGap hole, a 59.9 s one is not");
        // LOW C: the session's open bounds the first silence. A restart at 200 s (an open start gap to the first trade of the next
        // chunk at 380 s), history missing the first 300 s of the session: an inGap hole from the open, taking in the live run
        List<TickRec> lo = Every(t0, 200, 1000, 500);
        List<TickRec> ho = Every(t0, 300, 1000, 500);
        List<long[]> og = new List<long[]> { new long[] { long.MinValue, t0 + 380500 } };
        TickCheckResult rop = TickCheck.Compare(lo, ho, og, t0);
        Check(rop.Holes.Count == 1 && rop.Holes[0][0] == t0 && rop.Holes[0][1] == t0 + 300500 && rop.Holes[0][2] == 100 && rop.Holes[0][3] == 1,
              "tick rule: history missing the first 300 s with an open start gap: an inGap hole from the open (100 live trades in it): " + string.Join(";", rop.Holes.Select(h => h[0] - t0 + "-" + (h[1] - t0) + "/" + h[2] + "/" + h[3]).ToArray()));
        TickCheckResult ropNo = TickCheck.Compare(lo, ho, og);
        Check(ropNo.Holes.Count == 0, "tick rule: without the open nothing before history's first trade is looked at (FinishDay always passes the open)");
        TickCheckResult ropQuiet = TickCheck.Compare(Every(t0, 300, 1000, 500), ho, null, t0);
        Check(ropQuiet.Holes.Count == 0, "tick rule: history and live both start at 300 s, no known gap: no hole at the open (nobody missed anything)");
        // the third re-review, LOW 1: the time from history's last trade to the close, on live evidence only (never inGap). The
        // session closes at 1,000 s; live trades to 999.5 s.
        long close = t0 + 1000000;
        List<TickRec> lc = Every(t0, 0, 1000, 500);
        foreach (int early in new[] { 120, 240 })
        {
            TickCheckResult rc = TickCheck.Compare(lc, Every(t0, 0, 1000 - early, 500), null, t0, close);
            long last = t0 + (999 - early) * 1000L + 500;
            Check(rc.Holes.Count == 1 && rc.Holes[0][0] == last && rc.Holes[0][1] == close && rc.Holes[0][2] == early && rc.Holes[0][3] == 0,
                  "tick rule: history ends " + early + " s before live's last trade: a hole from history's last trade to the close (" + early + " live trades): " + string.Join(";", rc.Holes.Select(h => h[0] - t0 + "-" + (h[1] - t0) + "/" + h[2] + "/" + h[3]).ToArray()));
        }
        // an early close (a holiday): both feeds stop at the halt at 600 s, the session's close (no early closes in SessionUtc) at
        // 1,000 s: no hole; and with an open end capture gap after the halt: still none (never inGap at the close)
        List<TickRec> halt = Every(t0, 0, 600, 500);
        Check(TickCheck.Compare(halt, halt.ToList(), null, t0, close).Holes.Count == 0, "tick rule: an early-close day, live stopping at the halt: no hole at the close");
        Check(TickCheck.Compare(halt, halt.ToList(), new List<long[]> { new long[] { t0 + 599500, long.MaxValue } }, t0, close).Holes.Count == 0,
              "tick rule: an open end capture gap with no live trades after history's last trade: no hole (live evidence only at the close)");
        // a live trade within the margin of history's last trade only: no hole
        List<TickRec> lc2 = halt.ToList(); lc2.Add(Tr(t0 + 599500 + 900, 25000, 1));
        Check(TickCheck.Compare(lc2, halt, null, t0, close).Holes.Count == 0, "tick rule: a live trade 900 ms after history's last trade only: no hole at the close (inside the margin)");
        // a hole is not split by a known gap
        TickCheckResult unsplit = TickCheck.Compare(day, hHole, new List<long[]> { new long[] { t0 + 139400, t0 + 141400 } });
        Check(unsplit.Holes.Count == 1 && unsplit.Holes[0][0] == t0 + 99400 && unsplit.Holes[0][1] == t0 + 180400 && unsplit.Holes[0][2] == 80 && unsplit.Holes[0][3] == 1, "tick rule: a known gap inside a hole does not split it (one hole, marked inGap)");
    }

    // FinishDay: the known gaps come from the chunks that took drops; the summary carries the share, the covered counts and the holes
    static void TickFileRule(string dir)
    {
        ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 5, 17, 30));   // started before the session opened: no restart flag
        TickFresh(dir);
        Desk desk = new Desk();
        string urlWas = ChartBridgeConfig.DeskUrl;
        ChartBridgeConfig.DeskUrl = desk.Url;
        string T = TicksDir(dir), k = "2026-10-06 NQ 12-26";
        try
        {
            typeof(ChartBridgeTicks).GetMethod("LoadDays", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null);
            DateTime a = W(2026, 10, 6, 9, 30);
            for (int i = 0; i < 600; i++) Feed(a.AddSeconds(i).AddMilliseconds(200), 25000, 1);   // chunk 1: 09:30:00 to 09:39:59
            ChartBridgeTicks.WriteOnce(); ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 6, 9, 40)); ChartBridgeTicks.CutOnce();
            ChartBridgeTicks.NoteFeedDrop();                                                       // a feed drop: chunk 2 is flagged
            for (int i = 600; i < 1200; i++) Feed(a.AddSeconds(i).AddMilliseconds(200), 25000, 1);
            ChartBridgeTicks.WriteOnce(); ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 6, 9, 50)); ChartBridgeTicks.CutOnce();
            for (int i = 1200; i < 1800; i++) Feed(a.AddSeconds(i).AddMilliseconds(200), 25000, 1);   // chunk 3: 09:50:00 to 09:59:59
            ChartBridgeTicks.WriteOnce(); ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 6, 10, 0)); ChartBridgeTicks.CutOnce();
            Check(Field1s(ChartBridgeTicks.ChunkJson(k, 2) ?? "", "gaps") == "1" && Field1s(ChartBridgeTicks.ChunkJson(k, 1) ?? "", "gaps") == "0", "tick rule file (set up): chunk 2 took the feed drop");
            // history: 85 percent in chunks 1 and 3, everything in chunk 2: thin where the capture is known good
            List<TickRec> live = ChartBridgeTicks.ReadAllLive(k);
            List<TickRec> hist = live.Where((x, i) => (i >= 600 && i < 1200) || (i % 20 != 1 && i % 20 != 2 && i % 20 != 3)).ToList();
            TickCheckResult r = ChartBridgeTicks.FinishDay(k, HistOf(hist));
            string part = File.ReadAllLines(Path.Combine(T, "2026-10-06_NQ_12-26.day.jsonl"))[0];
            Check(r.Status == "failed" && r.CoveredLive == 1200 && r.CoveredHist == 1020 && part.Contains("\"status\":\"failed\"") && part.Contains("\"rule\":2,\"coveredSeconds\":1200,\"spanWhole\":false,\"coveredLive\":1200,\"coveredHist\":1020,\"historyShare\":0.85,\"holes\":[]"),
                  "tick rule file: the flagged chunk's seconds leave the span (the last trade before it to the first after it): 85 percent fails: " + Regex.Match(part, "\"rule\":[^\\]]*\\]").Value);
            // the same day with history thin only inside the flagged chunk and a 2 minute hole in chunk 3: short, the hole listed
            long holeFrom = Ms(EtToUtc(a.AddSeconds(1300))), holeTo = Ms(EtToUtc(a.AddSeconds(1420)));
            List<TickRec> hist2 = live.Where((x, i) => (i < 600 || i >= 1200 || i % 2 == 0) && !(x.U >= holeFrom && x.U < holeTo)).ToList();
            TickCheckResult r2 = ChartBridgeTicks.FinishDay(k, HistOf(hist2));
            part = File.ReadAllLines(Path.Combine(T, "2026-10-06_NQ_12-26.day.jsonl"))[0];
            Check(r2.Status == "short" && r2.Passed && r2.Holes.Count == 1 && part.Contains("\"status\":\"short\"") && part.Contains("\"holes\":[{\"from\":" + (holeFrom - 800) + ",\"to\":" + (holeTo + 200) + ",\"live\":120,\"inGap\":false}]") &&
                  part.Contains("\"secondsHistShort\":") && Lines(dir, "ticks/tickdays.txt").Contains(k + "\tshort\t0\t0\t2") && TickDiag().Contains("\"lastDay\":\"" + k + ": short,") && TickDiag().Contains("1 hole(s)"),
                  "tick rule file: short with a 2 minute hole: passed, the hole in the check (from, to, live), tickdays.txt and /diag say short: " + Regex.Match(part, "\"holes\":\\[[^\\]]*\\]").Value);
            Check(Logged("; queued for The Desk") && Regex.IsMatch(part, "\"historyShare\":0\\.9\\d*,"), "tick rule file: a short day is queued as passed; historyShare in the summary: " + Field1s(part, "historyShare"));

            // a short day is passed everywhere: stored, not packed: its last part kept and asked; packed: the raw deleted
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 6, 16, 30));
            desk.AnswerTicks = body => "{\"ok\":true,\"whole\":true,\"stored\":true,\"kept\":true,\"packed\":false}";
            ChartBridgeTicks.SendDays(null);
            Check(File.Exists(ChartBridgeTicks.LastPartFile(k)) && TickDiag().Contains("\"packWait\":{\"" + k + "\":{\"lastPart\":true") && Lines(dir, "ticks/tickdays.txt").Contains(k + "\tshort\t1\t0\t2"),
                  "tick rule file: a short day stored, not packed: its last part kept, listed in packWait (as exact and filled)");
            desk.AnswerTicks = body => "{\"ok\":true,\"duplicate\":true,\"whole\":true,\"stored\":true,\"kept\":true,\"packed\":true}";
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 7, 16, 30));
            Check(ChartBridgeTicks.AskPacked(null) == 1 && !File.Exists(Path.Combine(T, "2026-10-06_NQ_12-26.raw")) && Lines(dir, "ticks/tickdays.txt").Contains(k + "\tshort\t1\t1\t2"),
                  "tick rule file: a short day asked and packed: the raw deleted (as exact and filled)");
            // a short day noted packed with its files left (a delete cut short): the look at the folder deletes them
            File.WriteAllText(Path.Combine(T, "2026-10-06_NQ_12-26.state"), "run 0a1b2c3d4e5f\ntick 0.25\ncontract NQ 12-26\nsession 2026-10-06\n");
            File.WriteAllText(Path.Combine(T, "2026-10-06_NQ_12-26.raw"), "1\n");
            TickForget(); TickScan();
            Check(!File.Exists(Path.Combine(T, "2026-10-06_NQ_12-26.raw")) && !File.Exists(Path.Combine(T, "2026-10-06_NQ_12-26.state")), "tick rule file: a short day noted packed: its files left are deleted by the look at the folder");
        }
        finally { desk.Stop(); ChartBridgeConfig.DeskUrl = urlWas; ChartBridgeTicks.PartMaxTicks = 20000; }
    }

    // A day failed under the old rule, its raw kept: checked again once under the new rule after the F5 to 0.6.14
    static void TickFileRecheck(string dir)
    {
        DateTime wed1630 = EtToUtc(W(2026, 10, 7, 16, 30));
        Desk desk = Fresh(dir, "NQ", wed1630);
        string T = TicksDir(dir), k6 = "2026-10-06 NQ 12-26", rule = Path.Combine(T, "tickrule.txt");
        MethodInfo load = typeof(ChartBridgeTicks).GetMethod("LoadDays", BindingFlags.NonPublic | BindingFlags.Static);
        try
        {
            List<DateTime> walls = TickMorningSetup(dir, wed1630);
            Check(File.Exists(rule) && File.ReadAllLines(rule).SequenceEqual(new[] { "rule 2" }), "tick recheck: a new folder notes rule 2, nothing to check again");
            // the folder of 0.6.13: tickdays.txt says 10-06 failed (stored), 10-05 failed with no raw; no tickrule.txt
            File.WriteAllLines(Path.Combine(T, "tickdays.txt"), new[] { "2026-10-05 NQ 12-26\tfailed\t1\t0", k6 + "\tfailed\t1\t0" });
            File.Delete(rule);
            load.Invoke(null, null);
            Check(File.ReadAllLines(rule).SequenceEqual(new[] { "rule 2", "recheck " + k6 }) && TickDiag().Contains("\"recheck\":[\"" + k6 + "\"]") && !ChartBridgeTicks.IsDayDone(k6),
                  "tick recheck: after the F5, a failed day with its raw kept is listed to be checked again; one with no raw is not: " + string.Join(" | ", File.ReadAllLines(rule)));
            Check(ChartBridgeTicks.DaysToPull(wed1630).Contains(k6), "tick recheck: the failed day is due again");
            // NIT 3 (the PR #79 review): a listed key whose raw file is gone is dropped and tickrule.txt written again
            File.WriteAllLines(rule, new[] { "rule 2", "recheck 2026-10-05 NQ 12-26", "recheck " + k6 });
            load.Invoke(null, null);
            Check(File.ReadAllLines(rule).SequenceEqual(new[] { "rule 2", "recheck " + k6 }), "tick recheck: a listed day whose raw is gone is dropped from tickrule.txt: " + string.Join(" | ", File.ReadAllLines(rule)));
            // outside the windows: nothing (the same windows as any final pull)
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 7, 10, 0));
            int m0 = MadeCount();
            Check(!ChartBridgeTicks.PlanDay(null) && TicksMade(m0).Count == 0, "tick recheck: never in trading hours");
            // NinjaTrader has nothing: tried again in 15 minutes, 3 times; the day stays failed and listed
            ChartBridgeBars.UtcNow = () => wed1630;
            answerTicks = r => new Bars();
            for (int i = 0; i < 3; i++) { ChartBridgeBars.UtcNow = () => wed1630.AddMinutes(20 * i); ChartBridgeTicks.PlanDay(null); }
            Check(!ChartBridgeTicks.DaysToPull(wed1630.AddMinutes(70)).Contains(k6) && Lines(dir, "ticks/tickdays.txt").Contains(k6 + "\tfailed\t1\t0") && File.ReadAllLines(rule).Contains("recheck " + k6) &&
                  TickDiag().Contains("NinjaTrader has no trades for it"),
                  "tick recheck: 3 tries with no answer, then not until a restart; the day stays failed and listed");
            // a restart (tickrule.txt read again): tried again, the history now matches: exact, written, queued; the list empty
            ChartBridgeTicks.Start(); ChartBridgeTicks.Stop();
            typeof(ChartBridgeTicks).GetField("capturing", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, true);
            load.Invoke(null, null); TickScan();
            List<DateTime> hist = walls;
            answerTicks = r => { Bars b = new Bars(); foreach (DateTime w in hist) { b.Add(NtOf(w), 25000, 25000, 25000, 25000, 1); b.Bids.Add(24999.75); b.Asks.Add(25000); } return b; };
            ChartBridgeBars.UtcNow = () => wed1630.AddMinutes(75);
            m0 = MadeCount();
            bool asked = ChartBridgeTicks.PlanDay(null);
            List<BarsRequest> made = TicksMade(m0);
            Check(asked && made.Count == 1 && IsSession(made[0], D(2026, 10, 6)) && Lines(dir, "ticks/tickdays.txt").Contains(k6 + "\texact\t0\t0\t2") && File.ReadAllLines(rule).SequenceEqual(new[] { "rule 2" }) &&
                  File.Exists(Path.Combine(T, "2026-10-06_NQ_12-26.day.jsonl")) && TickDiag().Contains("checked again under the 0.6.14 rule") && TickDiag().Contains("\"recheck\":[]"),
                  "tick recheck: after a restart the failed day is pulled once more, checked under the new rule (exact), queued; no longer listed: " + string.Join(",", Lines(dir, "ticks/tickdays.txt")));
            Check(!ChartBridgeTicks.DaysToPull(wed1630.AddMinutes(80)).Contains(k6), "tick recheck: once only: a day checked under the new rule is done");
            // NIT 4: tickdays.txt has the rule column; a line of 0.6.13 (no rule) keeps reading as rule 1 and is written back as 1
            Check(Lines(dir, "ticks/tickdays.txt").Contains("2026-10-05 NQ 12-26\tfailed\t1\t0\t1") && TickDiag().Contains("\"" + k6 + "\":{\"check\":\"exact\",\"stored\":false,\"packed\":false,\"rule\":2}"),
                  "tick recheck: tickdays.txt and /diag days carry the rule (the 0.6.13 line as rule 1): " + string.Join(" | ", Lines(dir, "ticks/tickdays.txt")));
            // LOW B (the PR #79 re-review): a round trip to 0.6.13 and back. 0.6.13 skips the five field line, pulls the day again under
            // its old rule, fails it and writes a four field line; tickrule.txt still says only "rule 2". The next start of 0.6.14
            // lists the day again (every start does) and checks it once more under the new rule.
            File.WriteAllLines(Path.Combine(T, "tickdays.txt"), Lines(dir, "ticks/tickdays.txt").Select(x => x.StartsWith(k6 + "\t") ? k6 + "\tfailed\t1\t0" : x).ToArray());
            Check(File.ReadAllLines(rule).SequenceEqual(new[] { "rule 2" }), "tick round trip (set up): tickrule.txt lists nothing");
            ChartBridgeTicks.Start(); ChartBridgeTicks.Stop();
            typeof(ChartBridgeTicks).GetField("capturing", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, true);
            load.Invoke(null, null); TickScan();
            Check(File.ReadAllLines(rule).SequenceEqual(new[] { "rule 2", "recheck " + k6 }) && ChartBridgeTicks.DaysToPull(wed1630.AddMinutes(78)).Contains(k6),
                  "tick round trip: the next start of 0.6.14 lists the day 0.6.13 failed again: " + string.Join(" | ", File.ReadAllLines(rule)));
            ChartBridgeBars.UtcNow = () => wed1630.AddMinutes(78);
            m0 = MadeCount();
            asked = ChartBridgeTicks.PlanDay(null);
            made = TicksMade(m0);
            Check(asked && made.Count == 1 && IsSession(made[0], D(2026, 10, 6)) && Lines(dir, "ticks/tickdays.txt").Contains(k6 + "\texact\t0\t0\t2") && File.ReadAllLines(rule).SequenceEqual(new[] { "rule 2" }) &&
                  !ChartBridgeTicks.DaysToPull(wed1630.AddMinutes(79)).Contains(k6),
                  "tick round trip: healed: checked under the new rule (exact, rule 2) and not listed again: " + string.Join(" | ", Lines(dir, "ticks/tickdays.txt")));
            // a day failed under the new rule stays failed (never pulled again, never listed after a restart)
            List<DateTime> part = walls.Take(20).ToList();
            TickMorningSetup(dir, wed1630);
            answerTicks = r => { Bars b = new Bars(); foreach (DateTime w in part) { b.Add(NtOf(w), 25000, 25000, 25000, 25000, 1); b.Bids.Add(24999.75); b.Asks.Add(25000); } return b; };
            ChartBridgeTicks.PlanDay(null);
            load.Invoke(null, null); TickScan();
            Check(Lines(dir, "ticks/tickdays.txt").Contains(k6 + "\tfailed\t0\t0\t2") && File.ReadAllLines(rule).SequenceEqual(new[] { "rule 2" }) && !ChartBridgeTicks.DaysToPull(wed1630.AddMinutes(30)).Contains(k6) && File.Exists(Path.Combine(T, "2026-10-06_NQ_12-26.raw")),
                  "tick recheck: a day failed under the new rule (history 40 percent) is not checked again; its raw is kept until Anthony rules");
            // NIT 4: even with tickrule.txt gone, a day failed under rule 2 is never listed again (once per failed rule 1 record)
            File.Delete(rule);
            load.Invoke(null, null);
            Check(File.ReadAllLines(rule).SequenceEqual(new[] { "rule 2" }) && !ChartBridgeTicks.DaysToPull(wed1630.AddMinutes(30)).Contains(k6),
                  "tick recheck: tickrule.txt lost: a day failed under the new rule is not listed again (its rule 2 in tickdays.txt)");
        }
        finally { desk.Stop(); ChartBridgeTicks.Stop(); ChartBridgeTicks.ResetConfig(); typeof(ChartBridgeTicks).GetField("capturing", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, false); }
    }

    // LOW 1 through FinishDay: a 6 minute capture made after its session opened (its first chunk flagged) with a feed drop before
    // each later cut (every chunk flagged), history skewed (106 ms late on the trades late in their second): judged on the whole span
    static void TickFileAllFlagged(string dir)
    {
        ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 6, 9, 29));   // started after the session opened
        TickFresh(dir);
        string k = "2026-10-06 NQ 12-26", T = TicksDir(dir);
        typeof(ChartBridgeTicks).GetMethod("LoadDays", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null);
        DateTime a = W(2026, 10, 6, 9, 30);
        for (int c = 0; c < 3; c++)
        {
            if (c > 0) { ChartBridgeBars.UtcNow = () => EtToUtc(a.AddSeconds(120 * c)); ChartBridgeTicks.NoteFeedDrop(); }
            for (int i = 120 * c; i < 120 * (c + 1); i++) { Feed(a.AddSeconds(i).AddMilliseconds(100), 25000, 1); Feed(a.AddSeconds(i).AddMilliseconds(950), 25000.25, 1); }
            ChartBridgeTicks.WriteOnce(); ChartBridgeBars.UtcNow = () => EtToUtc(a.AddSeconds(120 * (c + 1))); ChartBridgeTicks.CutOnce();
        }
        Check(Enumerable.Range(1, 3).All(q => Field1s(ChartBridgeTicks.ChunkJson(k, q) ?? "", "gaps") != "0"), "tick all flagged (set up): every chunk says gaps");
        List<TickRec> live = ChartBridgeTicks.ReadAllLive(k);
        TickCheckResult r = ChartBridgeTicks.FinishDay(k, HistOf(live.Select(x => Tr(x.U % 1000 == 950 ? x.U + 106 : x.U, x.P, x.V))));
        string part = File.ReadAllLines(Path.Combine(T, "2026-10-06_NQ_12-26.day.jsonl"))[0];
        DateTime ou, cu; ChartBridgeBars.SessionUtc(D(2026, 10, 6), out ou, out cu);
        long openMs = Ms(ou), firstMs = Ms(EtToUtc(a)) + 100;   // history's first trade, 09:30:00.100
        Check(r.Holes.Count == 1 && r.Holes[0][0] == openMs && r.Holes[0][1] == firstMs && r.Holes[0][3] == 1 && part.Contains("\"holes\":[{\"from\":" + openMs + ",\"to\":" + firstMs + ",\"live\":0,\"inGap\":true}]"),
              "tick all flagged (LOW C): started after the open, history from 09:30 only: an inGap hole from the session's open (18:00 ET) to history's first trade: " + Regex.Match(part, "\"holes\":\\[[^\\]]*\\]").Value);
        Check(r.Status == "short" && r.Passed && r.SpanWhole && r.CoveredSeconds == 360 && part.Contains("\"spanWhole\":true") && Lines(dir, "ticks/tickdays.txt").Contains(k + "\tshort\t0\t0\t2"),
              "tick all flagged: a 6 minute capture with every chunk flagged and skewed history passes (short), judged on the whole span: " + r.Status + " " + r.CoveredHist + "/" + r.CoveredLive);
    }

    // LOW 2 (the PR #79 review): a day checked again after an earlier refusal, refused again: set aside once, never a resend loop
    static void TickFileRefusedAgain(string dir)
    {
        ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 6, 16, 30));
        TickFresh(dir);
        typeof(ChartBridgeTicks).GetMethod("LoadDays", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null);
        Desk desk = new Desk();
        string urlWas = ChartBridgeConfig.DeskUrl;
        ChartBridgeConfig.DeskUrl = desk.Url;
        string T = TicksDir(dir), k = "2026-10-06 NQ 12-26";
        string day = Path.Combine(T, "2026-10-06_NQ_12-26.day.jsonl"), refused = day + ".refused", unstored = day + ".unstored";
        try
        {
            for (int i = 0; i < 4; i++) Feed(W(2026, 10, 6, 9, 30).AddSeconds(i), 25000, 1);
            ChartBridgeTicks.WriteOnce(); TickScan();
            desk.StatusTicks = body => 422;
            ChartBridgeTicks.FinishDay(k, HistOf(ChartBridgeTicks.ReadAllLive(k)));
            ChartBridgeTicks.SendDays(null);
            Check(File.Exists(refused) && !File.Exists(day), "tick refused again (set up): the first set refused and set aside");
            // checked again (a new set): the earlier set aside files of the day go
            File.WriteAllText(unstored, "{}");
            ChartBridgeTicks.FinishDay(k, HistOf(ChartBridgeTicks.ReadAllLive(k)));
            Check(File.Exists(day) && !File.Exists(refused) && !File.Exists(unstored) && !File.Exists(Path.Combine(T, "2026-10-06_NQ_12-26.day.sent")),
                  "tick refused again: a new set of the day removes the earlier .refused and .unstored");
            // refused again, with an older .refused there (the move is safe when its target exists): set aside, then nothing more
            File.WriteAllText(refused, "{}");
            int n0 = desk.AllTicks().Count;
            ChartBridgeTicks.SendDays(null);
            int n1 = desk.AllTicks().Count;
            for (int i = 0; i < 3; i++) ChartBridgeTicks.SendDays(null);
            Check(n1 == n0 + 1 && desk.AllTicks().Count == n1 && File.Exists(refused) && File.ReadAllText(refused) != "{}" && !File.Exists(day),
                  "tick refused again: refused a second time, the older .refused replaced, the part sent once: no resend loop: " + (n1 - n0) + " then " + (desk.AllTicks().Count - n1));
            // a set aside that cannot be done (a folder in the way): the file stays, is not sent again this run, and lastError says so
            File.Delete(refused); Directory.CreateDirectory(refused);
            ChartBridgeTicks.FinishDay(k, HistOf(ChartBridgeTicks.ReadAllLive(k)));
            n0 = desk.AllTicks().Count;
            ChartBridgeTicks.SendDays(null);
            n1 = desk.AllTicks().Count;
            for (int i = 0; i < 3; i++) ChartBridgeTicks.SendDays(null);
            Check(n1 == n0 + 1 && desk.AllTicks().Count == n1 && File.Exists(day) && TickDiag().Contains("could not be set aside"),
                  "tick refused again: a set aside that fails keeps the file and never sends it again this run (no loop): " + (n1 - n0) + " then " + (desk.AllTicks().Count - n1));
            Directory.Delete(refused);
            // the recovery for a PC that had 0.6.14 before The Desk took short: .refused renamed back to .day.jsonl is sent from part 1
            desk.StatusTicks = body => 422;
            ChartBridgeTicks.FinishDay(k, HistOf(ChartBridgeTicks.ReadAllLive(k)));
            ChartBridgeTicks.SendDays(null);
            Check(File.Exists(refused) && !File.Exists(day), "tick recovery (set up): refused and set aside");
            File.Move(refused, day);
            desk.StatusTicks = body => 200;
            desk.AnswerTicks = body => "{\"ok\":true,\"whole\":true,\"stored\":true,\"kept\":true,\"packed\":false}";
            n0 = desk.AllTicks().Count;
            ChartBridgeTicks.SendDays(null);
            Check(desk.AllTicks().Count == n0 + 1 && desk.AllTicks().Last().Contains("\"part\":1,") && !File.Exists(day) && Lines(dir, "ticks/tickdays.txt").Contains(k + "\texact\t1\t0\t2"),
                  "tick recovery: the .refused file renamed back to .day.jsonl is sent from part 1 and stored");
        }
        finally { desk.Stop(); ChartBridgeConfig.DeskUrl = urlWas; }
    }

    // The probes only: the holes a margin of afterStart and beforeEnd ms would list (no gaps, no open), to show which way round the
    // skew margin must be.
    static int MarginHoles(List<TickRec> live, List<TickRec> hist, int afterStart, int beforeEnd)
    {
        long[] hs = hist.Select(x => x.U).OrderBy(x => x).ToArray(), ls = live.Select(x => x.U).OrderBy(x => x).ToArray();
        int n = 0;
        for (int i = 1; i < hs.Length; i++)
        {
            long a = hs[i - 1], b = hs[i];
            if (b - a >= TickCheck.HoleMinMs && ls.Any(u => u > a + afterStart && u < b - beforeEnd)) n++;
        }
        return n;
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
            Check(c3 != null && Field1s(c3, "gaps") == "1", "tick chunks: the first chunk of a file after a restart says gaps 1 (The Desk never vouches across a restart): " + (c3 == null ? "null" : Field1s(c3, "gaps")));
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

    static void FeedC(string contract, DateTime etWall, double p, long v) { ChartBridgeTicks.OnTrade("NQ", contract, 0.25, Ms(EtToUtc(etWall)), p, v, 1, ChartBridgeSides.BidAsk); }
    static void TickRestart()
    {
        ChartBridgeTicks.Start(); ChartBridgeTicks.Stop();
        typeof(ChartBridgeTicks).GetField("capturing", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, true);
        TickScan();
    }

    static void TickFileDrops(string dir)
    {
        ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 5, 17, 30));   // ChartBridge started before the 2026-10-06 session opened
        TickFresh(dir);
        try
        {
            string k12 = "2026-10-06 NQ 12-26", k03 = "2026-10-06 NQ 03-27";
            FeedC("NQ 12-26", W(2026, 10, 6, 9, 30), 25000, 1); FeedC("NQ 03-27", W(2026, 10, 6, 9, 30).AddSeconds(1), 25100, 1);
            ChartBridgeTicks.WriteOnce();
            Check(ChartBridgeTicks.CutOnce() == 2 && Field1s(ChartBridgeTicks.ChunkJson(k12, 1), "gaps") == "0" && Field1s(ChartBridgeTicks.ChunkJson(k03, 1), "gaps") == "0",
                  "tick drops: files made by a run that started before the session opened: the first chunks say gaps 0");
            // a feed drop at 09:31:30 and the feed down until 09:40: the cut in between has nothing to cut and takes nothing up
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 6, 9, 31).AddSeconds(30));
            ChartBridgeTicks.NoteFeedDrop();
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 6, 9, 34));
            Check(ChartBridgeTicks.CutOnce() == 0, "tick drops: nothing to cut while the feed is down");
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 6, 9, 41));
            FeedC("NQ 12-26", W(2026, 10, 6, 9, 40), 25001, 1); FeedC("NQ 03-27", W(2026, 10, 6, 9, 40).AddSeconds(2), 25101, 1);
            ChartBridgeTicks.WriteOnce();
            string a2 = null, b2 = null;
            Check(ChartBridgeTicks.CutOnce() == 2 && Field1s(a2 = ChartBridgeTicks.ChunkJson(k12, 2), "gaps") == "1" && Field1s(b2 = ChartBridgeTicks.ChunkJson(k03, 2), "gaps") == "1",
                  "tick drops: the feed drop goes on the next chunk of EVERY file of its session (the roll week's two contracts), not on a cut with nothing in it: " + Field1s(a2 ?? "", "gaps") + " " + Field1s(b2 ?? "", "gaps"));
            FeedC("NQ 12-26", W(2026, 10, 6, 9, 42), 25002, 1);
            ChartBridgeTicks.WriteOnce(); ChartBridgeTicks.CutOnce();
            Check(Field1s(ChartBridgeTicks.ChunkJson(k12, 3), "gaps") == "0", "tick drops: taken up once: the chunk after says gaps 0");
            // a full queue at 09:43 drops a trade: lost goes to the session's files, each at its own next cut
            ChartBridgeTicks.QueueMax = 1;
            FeedC("NQ 12-26", W(2026, 10, 6, 9, 43), 25003, 1); FeedC("NQ 12-26", W(2026, 10, 6, 9, 43).AddSeconds(1), 25003, 1);
            ChartBridgeTicks.QueueMax = 200000;
            ChartBridgeTicks.WriteOnce(); ChartBridgeTicks.CutOnce();
            Check(Field1s(ChartBridgeTicks.ChunkJson(k12, 4), "lost") == "1" && ChartBridgeTicks.ChunkJson(k03, 3) == null,
                  "tick drops: a lost trade goes on the next chunk of its session's file that has one; the other file keeps it for its next cut");
            FeedC("NQ 03-27", W(2026, 10, 6, 9, 44), 25104, 1);
            ChartBridgeTicks.WriteOnce(); ChartBridgeTicks.CutOnce();
            Check(Field1s(ChartBridgeTicks.ChunkJson(k03, 3), "lost") == "1", "tick drops: ... and the other contract's file takes it at its own next cut");
            // a drop in the next session does not touch this one
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 6, 18, 30));
            ChartBridgeTicks.NoteFeedDrop();
            FeedC("NQ 12-26", W(2026, 10, 6, 9, 45), 25005, 1);
            ChartBridgeTicks.WriteOnce(); ChartBridgeTicks.CutOnce();
            Check(Field1s(ChartBridgeTicks.ChunkJson(k12, 5), "gaps") == "0", "tick drops: a feed drop in the 2026-10-07 session does not go on 2026-10-06's chunks");
            // a restart mid-session: Start() zeroes its counters, yet the first chunk of each file after it says gaps 1
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 6, 9, 50));
            TickRestart();
            FeedC("NQ 12-26", W(2026, 10, 6, 9, 50), 25006, 1); FeedC("NQ 03-27", W(2026, 10, 6, 9, 50), 25106, 1);
            ChartBridgeTicks.WriteOnce(); ChartBridgeTicks.CutOnce();
            string r12 = ChartBridgeTicks.ChunkJson(k12, 6) ?? "", r03 = ChartBridgeTicks.ChunkJson(k03, 4) ?? "";
            Check(Field1s(r12, "gaps") == "1" && Field1s(r03, "gaps") == "1", "tick drops: after a restart the first chunk of each file says gaps 1, never 0: " + Field1s(r12, "gaps") + " " + Field1s(r03, "gaps"));
            FeedC("NQ 12-26", W(2026, 10, 6, 9, 51), 25007, 1);
            ChartBridgeTicks.WriteOnce(); ChartBridgeTicks.CutOnce();
            Check(Field1s(ChartBridgeTicks.ChunkJson(k12, 7) ?? "", "gaps") == "0", "tick drops: ... and only the first");
            // a file this run makes after its session opened (ChartBridge started mid-session): its first chunk says gaps 1 too
            FeedC("NQ 06-27", W(2026, 10, 6, 9, 52), 25200, 1);
            ChartBridgeTicks.WriteOnce(); ChartBridgeTicks.CutOnce();
            Check(Field1s(ChartBridgeTicks.ChunkJson("2026-10-06 NQ 06-27", 1) ?? "", "gaps") == "1", "tick drops: a file made after its session opened starts with gaps 1");
        }
        finally { ChartBridgeTicks.QueueMax = 200000; }
    }

    static void TickFileCutOfMany(string dir)
    {
        ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 5, 17, 30));   // started before the session opened: no restart flag
        TickFresh(dir);
        try
        {
            string k = "2026-10-06 NQ 12-26";
            ChartBridgeTicks.ChunkMaxTicks = 2;
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 6, 9, 30));
            ChartBridgeTicks.QueueMax = 6;
            for (int i = 0; i < 7; i++) Feed(W(2026, 10, 6, 9, 30).AddSeconds(i), 25000, 1);   // the 7th is dropped (queue full)
            ChartBridgeTicks.QueueMax = 200000;
            ChartBridgeTicks.NoteFeedDrop();
            ChartBridgeTicks.WriteOnce();
            int made = ChartBridgeTicks.CutOnce();
            string[] c = new string[] { ChartBridgeTicks.ChunkJson(k, 1) ?? "", ChartBridgeTicks.ChunkJson(k, 2) ?? "", ChartBridgeTicks.ChunkJson(k, 3) ?? "" };
            Check(made == 3 && Field1s(c[0], "lost") == "1" && Field1s(c[0], "gaps") == "1" && c.Skip(1).All(x => Field1s(x, "lost") == "0" && Field1s(x, "gaps") == "1"),
                  "tick drops: one cut of 3 chunks that took drops flags all 3 (the first has the counts, the others gaps 1): " + string.Join(" | ", c.Select(x => Field1s(x, "lost") + "/" + Field1s(x, "gaps")).ToArray()));
            string[] st = File.ReadAllLines(Path.Combine(TicksDir(dir), "2026-10-06_NQ_12-26.state")).Where(l => l.StartsWith("cut ")).ToArray();
            Check(st.Length == 3 && st[0].EndsWith(" .") && st[1].EndsWith(" c") && st[2].EndsWith(" c"), "tick drops: the later chunks' flag is marked carried in the state file");
            Feed(W(2026, 10, 6, 9, 31), 25000, 1); ChartBridgeTicks.WriteOnce(); ChartBridgeTicks.CutOnce();
            Check(Field1s(ChartBridgeTicks.ChunkJson(k, 4) ?? "", "gaps") == "0", "tick drops: the next cut, with no drop, says gaps 0");
            TickRestart();   // read back from the state file after a restart
            ChartBridgeTicks.FinishDay(k, HistOf(ChartBridgeTicks.ReadAllLive(k)));
            string part = File.ReadAllLines(Path.Combine(TicksDir(dir), "2026-10-06_NQ_12-26.day.jsonl"))[0];
            Check(part.Contains("\"liveLost\":1,\"liveGaps\":1,"), "tick drops: the day's liveLost and liveGaps count each drop once (a carried flag is not a second drop): " + Regex.Match(part, "\"liveLost\":\\d+,\"liveGaps\":\\d+").Value);
        }
        finally { ChartBridgeTicks.ChunkMaxTicks = 20000; ChartBridgeTicks.QueueMax = 200000; }
    }

    static void TickFileOneCutter(string dir)
    {
        ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 6, 10, 0));
        TickFresh(dir);
        string state = Path.Combine(TicksDir(dir), "2026-10-06_NQ_12-26.state");
        FieldInfo genF = typeof(ChartBridgeTicks).GetField("generation", BindingFlags.NonPublic | BindingFlags.Static);
        MethodInfo cutAs = typeof(ChartBridgeTicks).GetMethod("CutOnce", BindingFlags.NonPublic | BindingFlags.Static, null, new Type[] { typeof(int) }, null);
        Feed(W(2026, 10, 6, 9, 30), 25000, 1);
        ChartBridgeTicks.WriteOnce();
        int old = (int)genF.GetValue(null);
        TickRestart();   // a new generation: the old sender's thread may still be running
        Check((int)cutAs.Invoke(null, new object[] { old }) == 0 && !File.ReadAllLines(state).Any(l => l.StartsWith("cut ")),
              "one cutter: a sender of an earlier generation cuts nothing (no second `cut 1` with other bytes)");
        Check(ChartBridgeTicks.CutOnce() == 1 && File.ReadAllLines(state).Count(l => l.StartsWith("cut 1 ")) == 1, "one cutter: the current sender cuts it once");
        // a cut in progress (CutSync held): Start() waits for it before it clears the files
        object cutSync = typeof(ChartBridgeTicks).GetField("CutSync", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
        Monitor.Enter(cutSync);
        Thread starter = new Thread(() => { ChartBridgeTicks.Start(); ChartBridgeTicks.Stop(); }) { IsBackground = true };
        bool waited;
        try { starter.Start(); waited = !starter.Join(400); }
        finally { Monitor.Exit(cutSync); }
        Check(waited && starter.Join(10000), "one cutter: Start() waits for a cut still in progress, then goes on");
        typeof(ChartBridgeTicks).GetField("capturing", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, true);
        TickScan();
        // the writer: one at a time
        object writeSync = typeof(ChartBridgeTicks).GetField("WriteSync", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
        Feed(W(2026, 10, 6, 9, 31), 25001, 1);
        Monitor.Enter(writeSync);
        Thread w2 = new Thread(() => ChartBridgeTicks.WriteOnce()) { IsBackground = true };
        bool blocked;
        try { w2.Start(); blocked = !w2.Join(300); }
        finally { Monitor.Exit(writeSync); }
        Check(blocked && w2.Join(10000) && File.ReadAllLines(Path.Combine(TicksDir(dir), "2026-10-06_NQ_12-26.raw")).Length == 2, "one writer: a second writer waits for the first; whole lines only");
    }

    static long TickDisk() { return (long)typeof(ChartBridgeTicks).GetField("diskBytes", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null); }
    static long FolderSize(string dir) { return Directory.GetFiles(TicksDir(dir)).Sum(f => new FileInfo(f).Length); }

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
                  parts[0].EndsWith(",\"complete\":true}") && Lines(dir, "ticks/tickdays.txt").Contains(k6 + "\tfilled\t0\t0\t2"),
                  "tick days: the history (one trade more) checked against the live capture: filled; written whole as 3 parts with the check: " + parts[0].Substring(0, Math.Min(400, parts[0].Length)));
            Check(ChartBridgeTicks.DaysToPull(EtToUtc(W(2026, 10, 9, 17, 6))).SequenceEqual(new[] { k7, k8 }), "tick days: a day done is not pulled again; the others are, oldest first");
            Check(TickDisk() == FolderSize(dir) && TickDisk() > new FileInfo(day6).Length, "tick disk: the folder's size counts the .day.jsonl files waiting too: " + TickDisk() + " of " + FolderSize(dir));
            // outside the window nothing goes
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 9, 10, 0));
            Check(ChartBridgeTicks.SendDays(null) == 0 && desk.AllTicks().Count == 0, "tick days: sent only in the evening window (not at 10:00 ET)");
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 9, 16, 30));
            Check(ChartBridgeTicks.SendDays(null) == 3 && desk.AllTicks().All(b => b.StartsWith("/api/ticks/day {")), "tick days: the 3 parts to /api/ticks/day in the window");
            string raw6 = Path.Combine(TicksDir(dir), "2026-10-06_NQ_12-26.raw");
            Check(File.Exists(raw6) && !File.Exists(day6) && Lines(dir, "ticks/tickdays.txt").Contains(k6 + "\tfilled\t1\t0\t2") && Logged("the raw file is kept (not packed yet)"),
                  "tick days: The Desk stored it but did not pack it: the raw file is kept (deleted only after the pack)");
            Check(TickDisk() == FolderSize(dir), "tick disk: counted again once the day file is deleted: " + TickDisk() + " of " + FolderSize(dir));
            // stored and packed: the raw is deleted
            desk.AnswerTicks = body => "{\"ok\":true,\"stored\":true,\"kept\":true,\"packed\":true}";
            ChartBridgeTicks.FinishDay(k7, HistOf(ChartBridgeTicks.ReadAllLive(k7)));
            ChartBridgeTicks.SendDays(null);
            Check(!File.Exists(Path.Combine(TicksDir(dir), "2026-10-07_NQ_12-26.raw")) && !File.Exists(Path.Combine(TicksDir(dir), "2026-10-07_NQ_12-26.state")) && Lines(dir, "ticks/tickdays.txt").Contains(k7 + "\texact\t1\t1\t2"),
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

    static void TickFileUnstored(string dir)
    {
        TickFresh(dir);
        Desk desk = new Desk();
        string urlWas = ChartBridgeConfig.DeskUrl;
        ChartBridgeConfig.DeskUrl = desk.Url;
        try
        {
            desk.AnswerTicks = body => "{\"ok\":true,\"whole\":false,\"stored\":false,\"kept\":null,\"packed\":false}";
            for (int i = 0; i < 3; i++) Feed(W(2026, 10, 6, 9, 30).AddSeconds(i), 25000, 1);
            for (int i = 0; i < 3; i++) Feed(W(2026, 10, 7, 9, 30).AddSeconds(i), 25000, 1);
            ChartBridgeTicks.WriteOnce(); TickScan();
            string k6 = "2026-10-06 NQ 12-26", k7 = "2026-10-07 NQ 12-26";
            ChartBridgeTicks.PartMaxTicks = 2;
            ChartBridgeTicks.FinishDay(k6, HistOf(ChartBridgeTicks.ReadAllLive(k6)));
            string day6 = Path.Combine(TicksDir(dir), "2026-10-06_NQ_12-26.day.jsonl"), sent6 = Path.Combine(TicksDir(dir), "2026-10-06_NQ_12-26.day.sent");
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 9, 16, 30));
            int n1 = ChartBridgeTicks.SendDays(null);
            Check(n1 == 2 && File.Exists(day6) && !File.Exists(sent6) && Lines(dir, "ticks/tickdays.txt").Contains(k6 + "\texact\t0\t0\t2") && Logged("did not store it; the day file is kept and sent again in 15 minutes (try 1 of 3)"),
                  "tick days: the last part answered without stored true: the day file is KEPT (not deleted), to be sent again from its first part");
            Check(ChartBridgeTicks.SendDays(null) == 0, "tick days: not sent again at once (15 minutes later)");
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 9, 16, 46));
            int before = desk.AllTicks().Count;
            Check(ChartBridgeTicks.SendDays(null) == 2 && desk.AllTicks().Count == before + 2 && desk.AllTicks()[before].Contains("\"part\":1,") && File.Exists(day6),
                  "tick days: sent again from part 1 after 15 minutes (The Desk ignores the parts it has); not stored: kept again");
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 9, 17, 2));
            ChartBridgeTicks.SendDays(null);
            Check(!File.Exists(day6) && File.Exists(day6 + ".unstored") && File.Exists(Path.Combine(TicksDir(dir), "2026-10-06_NQ_12-26.raw")) && TickDiag().Contains("did not store the day, 3 times"),
                  "tick days: after 3 tries the day is set aside (.unstored, kept), the raw is kept, /diag says so");
            // stored on the second try: then the day file goes (the raw stays: not packed)
            ChartBridgeTicks.FinishDay(k7, HistOf(ChartBridgeTicks.ReadAllLive(k7)));
            string day7 = Path.Combine(TicksDir(dir), "2026-10-07_NQ_12-26.day.jsonl");
            ChartBridgeTicks.SendDays(null);
            Check(File.Exists(day7), "tick days: not stored the first time: kept");
            desk.AnswerTicks = body => "{\"ok\":true,\"whole\":true,\"stored\":true,\"kept\":true,\"packed\":false}";
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 9, 17, 20));
            ChartBridgeTicks.SendDays(null);
            Check(!File.Exists(day7) && File.Exists(Path.Combine(TicksDir(dir), "2026-10-07_NQ_12-26.raw")) && Lines(dir, "ticks/tickdays.txt").Contains(k7 + "\texact\t1\t0\t2"),
                  "tick days: stored on the next try: the day file deleted only now; the raw kept (not packed)");
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
            Check(Lines(dir, "ticks/tickdays.txt").Contains("2026-10-06 NQ 12-26\texact\t0\t0\t2") && File.Exists(Path.Combine(TicksDir(dir), "2026-10-06_NQ_12-26.day.jsonl")),
                  "tick pull: the history matches the live capture second by second: exact, queued for The Desk");
            m0 = MadeCount();
            ChartBridgeBars.PlanOnce(null);
            Check(TicksMade(m0).Count == 0, "tick pull: a day done is not asked for again");
            Check(((string)Priv("DiagJson")).Contains("\"tickFile\":{\"on\":true,"), "tick file: /diag has tickFile");
        }
        finally { desk.Stop(); ChartBridgeTicks.Stop(); ChartBridgeTicks.ResetConfig(); typeof(ChartBridgeTicks).GetField("capturing", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, false); }
    }

    // ------------------------------------------------------------ Anthony 2026-11-03: the tick day's morning catch-up
    static void TickDayMorningWindow()
    {
        // 2026-10-07 is a Wednesday, 2026-10-10 a Saturday, 2026-10-11 a Sunday, 2026-10-12 a Monday
        foreach (var c in new[] {
            new { At = W(2026, 10, 7, 8, 40), In = true, What = "Wednesday 08:40 (the morning catch-up)" },
            new { At = W(2026, 10, 7, 0, 30), In = true, What = "Wednesday 00:30 (before 09:15 on a weekday)" },
            new { At = W(2026, 10, 7, 9, 14).AddSeconds(59), In = true, What = "Wednesday 09:14:59" },
            new { At = W(2026, 10, 7, 9, 15), In = false, What = "Wednesday 09:15:00 (the morning window ends)" },
            new { At = W(2026, 10, 7, 12, 0), In = false, What = "Wednesday 12:00 (trading hours)" },
            new { At = W(2026, 10, 7, 16, 15), In = true, What = "Wednesday 16:15 (the evening window, as before)" },
            new { At = W(2026, 10, 7, 17, 50), In = false, What = "Wednesday 17:50 (as before)" },
            new { At = W(2026, 10, 12, 8, 40), In = true, What = "Monday 08:40" },
            new { At = W(2026, 10, 10, 8, 40), In = true, What = "Saturday 08:40 (the weekend rule, as before)" },
            new { At = W(2026, 10, 11, 8, 40), In = true, What = "Sunday 08:40 (the weekend rule, as before)" },
            new { At = W(2026, 10, 11, 17, 50), In = false, What = "Sunday 17:50 (the weekend rule, as before)" } })
            Check(ChartBridgeTicks.InDayStartWindow(c.At) == c.In, "tick day start window: " + c.What + (c.In ? ": a final pull may start" : ": no final pull starts"));
        // the evening window (In1sStartWindow and In1sWindow, named for the 1 second bars retired in 0.6.15) is not widened: no start and no send on a weekday morning
        foreach (DateTime at in new[] { W(2026, 10, 7, 8, 40), W(2026, 10, 7, 0, 30), W(2026, 10, 12, 8, 40) })
            Check(!ChartBridgeBars.In1sStartWindow(at) && !ChartBridgeBars.In1sWindow(at), "evening window: not widened by the tick day's morning catch-up (" + at.ToString("ddd HH:mm", System.Globalization.CultureInfo.InvariantCulture) + ")");
        Check(ChartBridgeTicks.DayWaitText == "waiting: the final pull goes 16:15 to 17:50 ET on weekdays, before 09:15 ET on weekday mornings, and on the weekend", "tick day: dayState says when the next pull can go");
        // review LOW 1 (pending Anthony's answer): the window opens at MorningStart, 00:00 today (the behaviour unchanged)
        TimeSpan ms0 = ChartBridgeTicks.MorningStart;
        Check(ms0 == TimeSpan.Zero, "tick day morning: MorningStart is 00:00 until Anthony answers (the behaviour unchanged): " + ms0);
        foreach (DateTime day in new[] { W(2026, 10, 7, 0, 0), W(2026, 10, 12, 0, 0) })
        {
            DateTime opens = day.Add(ms0);
            Check(ChartBridgeTicks.InMorningWindow(opens) && ChartBridgeTicks.InMorningWindow(opens.AddMinutes(1)) && !ChartBridgeTicks.InMorningWindow(day.Add(ChartBridgeTicks.MorningEnd)) &&
                  (ms0 == TimeSpan.Zero || (!ChartBridgeTicks.InMorningWindow(opens.AddSeconds(-1)) && !ChartBridgeTicks.InDayStartWindow(opens.AddSeconds(-1)))),
                  "tick day morning: the window opens at MorningStart (" + opens.ToString("ddd HH:mm:ss", System.Globalization.CultureInfo.InvariantCulture) + ") and ends at MorningEnd");
        }
        Check(!ChartBridgeTicks.InMorningWindow(W(2026, 10, 10, 0, 0).Add(ms0)), "tick day morning: MorningStart does not open the window on the weekend");
    }

    // A clean ticks folder with session 2026-10-06 (Tuesday) captured live and closed but not pulled (NinjaTrader closed at 16:05), and
    // session 2026-10-07 open (it opened at 18:00 on 2026-10-06, live trades captured since).
    static List<DateTime> TickMorningSetup(string dir, DateTime nowUtc)
    {
        ChartBridgeBars.UtcNow = () => nowUtc;
        TickFresh(dir);
        typeof(ChartBridgeTicks).GetMethod("LoadDays", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null);   // no day done from an earlier case
        ChartBridgeBars.ReadConfig("bars", "on");
        ChartBridgeBars.ReadConfig("barsRoots", "NQ");
        List<DateTime> walls = new List<DateTime>();
        for (int i = 0; i < 50; i++) walls.Add(W(2026, 10, 6, 9, 30).AddSeconds(i * 7).AddMilliseconds(120));
        foreach (DateTime w in walls) Feed(w, 25000, 1);
        Feed(W(2026, 10, 6, 19, 0), 25010, 1);   // the open session 2026-10-07
        Feed(W(2026, 10, 7, 8, 0), 25012, 1);
        ChartBridgeTicks.WriteOnce();
        TickScan();
        List<DateTime> hist = walls;
        answerTicks = r =>
        {
            Bars b = new Bars();
            foreach (DateTime w in hist) { b.Add(NtOf(w), 25000, 25000, 25000, 25000, 1); b.Bids.Add(24999.75); b.Asks.Add(25000); }
            return b;
        };
        return walls;
    }
    static string DayStateNow() { return Regex.Match(ChartBridgeTicks.DiagJson(), "\"dayState\":(\"[^\"]*\")").Groups[1].Value; }
    static bool IsSession(BarsRequest r, DateTime session)
    {
        DateTime ou, cu; ChartBridgeBars.SessionUtc(session, out ou, out cu);
        TimeZoneInfo z = NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo;
        return r.From == TimeZoneInfo.ConvertTimeFromUtc(ou, z) && r.To == TimeZoneInfo.ConvertTimeFromUtc(cu, z);
    }

    static void TickDayMorning(string dir)
    {
        DateTime wed0840 = EtToUtc(W(2026, 10, 7, 8, 40));
        Desk desk = Fresh(dir, "NQ", wed0840);
        string doneLine = "2026-10-06 NQ 12-26\texact\t0\t0\t2";
        string dayFile = Path.Combine(TicksDir(dir), "2026-10-06_NQ_12-26.day.jsonl");
        try
        {
            // 1. Wednesday 08:40: ChartBridge started, yesterday's closed session not done: pulled, from its open to its close
            TickMorningSetup(dir, wed0840);
            int m0 = MadeCount();
            bool asked = ChartBridgeTicks.PlanDay(null);
            List<BarsRequest> made = TicksMade(m0);
            Check(asked && made.Count == 1 && IsSession(made[0], D(2026, 10, 6)) && Lines(dir, "ticks/tickdays.txt").Contains(doneLine) && File.Exists(dayFile),
                  "tick day morning: a weekday 08:40 start pulls yesterday's closed session not done (exact, queued): " + made.Count + " " + string.Join(",", Lines(dir, "ticks/tickdays.txt")));
            Check(!made.Any(r => IsSession(r, D(2026, 10, 7))), "tick day morning: the session still open (it opened at 18:00 yesterday) is not asked for");
            // the next pass: nothing more (the closed day is done, the open one is not due)
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 7, 8, 41));
            m0 = MadeCount();
            Check(!ChartBridgeTicks.PlanDay(null) && TicksMade(m0).Count == 0 && DayStateNow() == "\"idle\"",
                  "tick day morning: the still open session is never pulled in the morning; a day done is not asked again: " + DayStateNow());
            // the day file waits for the evening window to be sent (the sends keep In1sWindow)
            Check(ChartBridgeTicks.SendDays(null) == 0 && desk.AllTicks().Count == 0 && File.Exists(dayFile), "tick day morning: the day file is sent in the evening window, not in the morning");

            // 2. 09:14:59 starts, 09:15:00 does not
            TickMorningSetup(dir, EtToUtc(W(2026, 10, 7, 9, 15)));
            m0 = MadeCount();
            Check(!ChartBridgeTicks.PlanDay(null) && TicksMade(m0).Count == 0 && DayStateNow() == "\"" + ChartBridgeTicks.DayWaitText + "\"",
                  "tick day morning: 09:15:00 starts nothing, dayState says when the next pull can go: " + DayStateNow());
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 7, 9, 14).AddSeconds(59));
            m0 = MadeCount();
            Check(ChartBridgeTicks.PlanDay(null) && TicksMade(m0).Count == 1 && Lines(dir, "ticks/tickdays.txt").Contains(doneLine), "tick day morning: 09:14:59 starts the pull");

            // 3. planned at 09:14:59, but the gate reaches it at 09:15:00: nothing goes to NinjaTrader, not counted as a try
            TickMorningSetup(dir, EtToUtc(W(2026, 10, 7, 9, 14).AddSeconds(59)));
            int calls = 0;
            DateTime before = EtToUtc(W(2026, 10, 7, 9, 14).AddSeconds(59)), at915 = EtToUtc(W(2026, 10, 7, 9, 15));
            ChartBridgeBars.UtcNow = () => Interlocked.Increment(ref calls) == 1 ? before : at915;   // PlanDay's own look, then the gate's
            m0 = MadeCount();
            ChartBridgeTicks.PlanDay(null);
            Check(TicksMade(m0).Count == 0 && !Lines(dir, "ticks/tickdays.txt").Any() && DayStateNow() == "\"" + ChartBridgeTicks.DayWaitText + "\"" && !TickDiag().Contains("\"lastError\":\"2026-10-06"),
                  "tick day morning: a pull the gate reaches at 09:15:00 never goes out (not a failure): " + DayStateNow());
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 7, 16, 20));
            m0 = MadeCount();
            Check(ChartBridgeTicks.PlanDay(null) && TicksMade(m0).Count == 1 && Lines(dir, "ticks/tickdays.txt").Contains(doneLine), "tick day morning: that day goes in the evening window as before");

            // 4. a pull that started at 09:14:59 and is still out at 09:15 finishes: the day is written whole and recorded
            TickMorningSetup(dir, EtToUtc(W(2026, 10, 7, 9, 14).AddSeconds(59)));
            DateTime clk = EtToUtc(W(2026, 10, 7, 9, 14).AddSeconds(59));
            ChartBridgeBars.UtcNow = () => clk;
            BarsRequest.AutoAnswer = r => { if (IsTicks1s(r)) clk = EtToUtc(W(2026, 10, 7, 9, 17)); return AnswerLikeNt(r); };   // NinjaTrader answers at 09:17
            try
            {
                m0 = MadeCount();
                Check(ChartBridgeTicks.PlanDay(null) && TicksMade(m0).Count == 1 && Lines(dir, "ticks/tickdays.txt").Contains(doneLine) && File.Exists(dayFile) && DayStateNow() == "\"idle\"",
                      "tick day morning: a pull still out at 09:15 is not cut; it finishes, written whole and recorded: " + DayStateNow());
            }
            finally { BarsRequest.AutoAnswer = AnswerLikeNt; }

            // 5. the weekend keeps its own rule: Saturday 08:40 pulls; Sunday 17:55 does not
            TickMorningSetup(dir, EtToUtc(W(2026, 10, 11, 17, 55)));
            m0 = MadeCount();
            Check(!ChartBridgeTicks.PlanDay(null) && TicksMade(m0).Count == 0, "tick day: Sunday 17:55, nothing starts (the weekend rule as before)");
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 10, 8, 40));
            m0 = MadeCount();
            Check(ChartBridgeTicks.PlanDay(null) && TicksMade(m0).Count == 1 && Lines(dir, "ticks/tickdays.txt").Contains(doneLine), "tick day: Saturday 08:40 pulls (the weekend rule as before)");

            // 6. an old day NinjaTrader no longer has whole: less history: the check fails and is reported, the raw kept
            List<DateTime> walls = TickMorningSetup(dir, wed0840);
            List<DateTime> part = walls.Take(20).ToList();
            answerTicks = r => { Bars b = new Bars(); foreach (DateTime w in part) { b.Add(NtOf(w), 25000, 25000, 25000, 25000, 1); b.Bids.Add(24999.75); b.Asks.Add(25000); } return b; };
            ChartBridgeTicks.PlanDay(null);
            string raw6 = Path.Combine(TicksDir(dir), "2026-10-06_NQ_12-26.raw");
            Check(Lines(dir, "ticks/tickdays.txt").Contains("2026-10-06 NQ 12-26\tfailed\t0\t0\t2") && TickDiag().Contains("\"lastDay\":\"2026-10-06 NQ 12-26: failed,") && File.Exists(raw6) && File.Exists(dayFile),
                  "tick day morning: history short of the live capture: the check fails, reported in lastDay, sent marked failed, the raw kept");
            // nothing at all: retried 15 minutes later (3 times), reported in lastError, never marked done, the raw kept
            TickMorningSetup(dir, wed0840);
            answerTicks = r => new Bars();
            ChartBridgeTicks.PlanDay(null);
            Check(!Lines(dir, "ticks/tickdays.txt").Any() && TickDiag().Contains("\"lastError\":\"2026-10-06 NQ 12-26: NinjaTrader has no trades for it\"") && File.Exists(raw6) && !File.Exists(dayFile),
                  "tick day morning: NinjaTrader has nothing for the day: reported, not marked done, the raw kept (tried again in 15 minutes): " + TickDiag().Substring(TickDiag().IndexOf("\"lastError\"")));
            ChartBridgeBars.UtcNow = () => wed0840.AddMinutes(5);
            m0 = MadeCount();
            Check(!ChartBridgeTicks.PlanDay(null) && TicksMade(m0).Count == 0, "tick day morning: not asked again before 15 minutes");
        }
        finally { desk.Stop(); ChartBridgeTicks.Stop(); ChartBridgeTicks.ResetConfig(); typeof(ChartBridgeTicks).GetField("capturing", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, false); }

        // 7. through the bars worker in the morning window only the tick day's catch-up asks NinjaTrader for trades (0.6.15: there is
        //    no 1 second pull at any hour, an old bars1s = on line or not)
        desk = Fresh(dir, "NQ", wed0840);
        try
        {
            TickMorningSetup(dir, wed0840);
            ChartBridgeBars.ReadConfig("bars1s", "on");   // an old line: does nothing (0.6.15)
            ChartBridgeBars.CatchUpSessions = 1;
            ChartBridgeTicks.ReadConfig("tickFile", "off");
            int m0 = MadeCount();
            ChartBridgeBars.PlanOnce(null);
            Check(TicksMade(m0).Count == 0 && desk.All1s().Count == 0 && !Diag().Contains("oneSecond"),
                  "1s retired: with the tick file off, no tick request on a weekday morning (08:40 ET) and nothing posted to /api/bars-1s");
            ChartBridgeTicks.ReadConfig("tickFile", "on");
            m0 = MadeCount();
            ChartBridgeBars.PlanOnce(null);
            List<BarsRequest> made = TicksMade(m0);
            Check(made.Count == 1 && IsSession(made[0], D(2026, 10, 6)) && desk.All1s().Count == 0 && Lines(dir, "ticks/tickdays.txt").Contains("2026-10-06 NQ 12-26\texact\t0\t0\t2"),
                  "tick day morning: through the bars worker at 08:40, only the tick day's pull asks NinjaTrader: " + made.Count);
        }
        finally { desk.Stop(); ChartBridgeTicks.Stop(); ChartBridgeTicks.ResetConfig(); typeof(ChartBridgeTicks).GetField("capturing", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, false); }
    }

    // The evening window (Anthony's coordinator, 2026-10-24; the names In1sWindow and In1sStartWindow kept from the 1 second bars,
    // retired in 0.6.15): it still decides when the NQ tick file's final pull starts, its day sends and its packed asks. The same table
    // the 1 second bars' OneSecondWindow case had (review of #83, LOW 1), so a later refactor cannot move a boundary unnoticed.
    static void EveningWindow()
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
            Check(ChartBridgeBars.In1sWindow(c.At) == c.In, "evening window: " + c.What + (c.In ? ": the tick day's sends and packed asks may go" : ": nothing sent or asked"));
        // review of #71 (MEDIUM 2): a new request starts by 17:50 (the window's end less 10 minutes); sends may go on to 18:00
        foreach (var c in new[] {
            new { At = W(2026, 10, 7, 16, 15), In = true, What = "Wednesday 16:15" },
            new { At = W(2026, 10, 7, 17, 49), In = true, What = "Wednesday 17:49" },
            new { At = W(2026, 10, 7, 17, 50), In = false, What = "Wednesday 17:50" },
            new { At = W(2026, 10, 7, 17, 59), In = false, What = "Wednesday 17:59" },
            new { At = W(2026, 10, 10, 23, 59), In = true, What = "Saturday 23:59" },
            new { At = W(2026, 10, 11, 17, 49), In = true, What = "Sunday 17:49" },
            new { At = W(2026, 10, 11, 17, 50), In = false, What = "Sunday 17:50" } })
            Check(ChartBridgeBars.In1sStartWindow(c.At) == c.In, "evening start window: " + c.What + (c.In ? ": a final pull may start" : ": no new request (one may run past 18:00)"));
    }

    // ------------------------------------------------------------ 0.6.15: the 1 second pull retired (Anthony 2026-11-03)
    // "I would prefer to just build everything from the ticks": the NQ tick file is the one source and The Desk builds its 1 second
    // bars from the master tick day. ChartBridge asks NinjaTrader for no 1 second request and posts nothing to /api/bars-1s, at any
    // hour; an old bars1s or bars1sRoots line does nothing (one Output line, never an error); the tick file's final pull goes in the
    // same pass as the 1-minute bars (it no longer waits for a pass where the 1 second pull asked nothing); what the 1 second pull left
    // on the PC is never read, sent or deleted; /diag bars has no oneSecond.
    static void Retired1s(string dir)
    {
        // an old config line: taken (never "not a ChartBridge setting"), said in the Output window, changes nothing
        ChartBridgeBars.ResetConfig();
        ChartBridgeBars.ReadConfig("bars", "on");
        foreach (string[] kv in new[] { new[] { "bars1s", "on" }, new[] { "bars1s", "off" }, new[] { "bars1sRoots", "NQ, MNQ" } })
            Check(ChartBridgeBars.ReadConfig(kv[0], kv[1]) && ChartBridgeBars.Enabled && string.Join(",", ChartBridgeBars.Roots) == "NQ,MNQ,ES,MES" && Logged(ChartBridgeBars.RetiredKeyText(kv[0])),
                  "1s retired: config.txt " + kv[0] + " = " + kv[1] + " is taken and does nothing, said in the Output window (never an error)");
        Check(ChartBridgeBars.RetiredKeyText("bars1s") == "config.txt: bars1s is retired (ChartBridge 0.6.15: the 1 second pull no longer runs; the NQ tick file is the one source and The Desk builds its 1 second bars from it); the line does nothing",
              "1s retired: the Output line's words");
        ChartBridgeBars.ResetConfig();

        // what the 1 second pull left: said once a start (the worker's own start), never read, sent or deleted
        DateTime wed1620 = EtToUtc(W(2026, 10, 7, 16, 20));
        Desk desk = Fresh(dir, "NQ", wed1620);
        try
        {
            Check(ChartBridgeBars.Retired1sLeftovers() == null, "1s retired: no leftovers, no line");
            Directory.CreateDirectory(Bars1sDir(dir));
            string set = Path.Combine(Bars1sDir(dir), "2026-10-06_NQ_12-26.jsonl");
            string part = "{\"v\":2,\"source\":\"chartbridge\",\"bridge\":\"0.6.14\",\"pc\":\"HOME\",\"contract\":\"NQ 12-26\",\"root\":\"NQ\",\"tick\":0.25,\"session\":\"2026-10-06\",\"tf\":\"1s\",\"stamp\":\"open\",\"bars\":[[1791237600000,25000,25000,25000,25000,1,1,0]],\"complete\":true}";
            File.WriteAllText(set, part + "\n");
            string sent = Path.Combine(dir, "ChartBridge", "sent_bars1s.txt");
            File.WriteAllText(sent, "2026-10-05 NQ 12-26\n");
            string line = ChartBridgeBars.Retired1sLeftovers();
            Check(line != null && line.Contains("the bars1s folder (1 set(s) never sent), sent_bars1s.txt in the ChartBridge folder are no longer read or sent") && line.Contains("they may be deleted") && !line.Contains("refused_bars1s.txt"),
                  "1s retired: the leftovers named in one line: " + line);
            ChartBridgeBars.Start();   // bars on: the worker starts; it says the leftovers on its own thread (nothing planned: SettleMs)
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            while (!Logged("the 1 second pull is retired (ChartBridge 0.6.15: the NQ tick file is the one source): the bars1s folder") && sw.ElapsedMilliseconds < 5000) Thread.Sleep(20);
            ChartBridgeBars.Stop();
            Check(Logged("the 1 second pull is retired (ChartBridge 0.6.15: the NQ tick file is the one source): the bars1s folder"), "1s retired: the worker's start says the leftovers in the Output window");

            // the evening window (Wednesday 16:20 ET), bars on with an old bars1s = on line, the tick file on with Tuesday's session
            // captured and closed: one pass asks the 1-minute bars and then, in the same pass, the tick day's final pull; never a 1
            // second request, never a post to /api/bars-1s, the leftovers untouched
            TickMorningSetup(dir, wed1620);
            ChartBridgeBars.ReadConfig("bars1s", "on");
            ChartBridgeBars.ReadConfig("bars1sRoots", "NQ, MNQ");
            ChartBridgeBars.CatchUpSessions = 1;
            int m0 = MadeCount();
            ChartBridgeBars.PlanOnce(null);
            List<BarsRequest> made = BarsMade(m0);
            List<BarsRequest> ticks = TicksMade(m0);
            int minutes = made.Count(r => r.BarsPeriod != null && r.BarsPeriod.BarsPeriodType == BarsPeriodType.Minute);
            Check(minutes == 1 && ticks.Count == 1 && IsSession(ticks[0], D(2026, 10, 6)) && Lines(dir, "ticks/tickdays.txt").Contains("2026-10-06 NQ 12-26\texact\t0\t0\t2"),
                  "1s retired: one pass in the evening window: the 1-minute bars, then the tick day's final pull from the open to the close, nothing else (" + minutes + " minute, " + ticks.Count + " tick request(s))");
            ChartBridgeBarsQueue.Flush(null);
            ChartBridgeTicks.SendDays(null);
            System.Diagnostics.Stopwatch sw2 = System.Diagnostics.Stopwatch.StartNew();
            while (desk.Count == 0 && sw2.ElapsedMilliseconds < 3000) Thread.Sleep(20);
            Check(desk.Count == 1 && desk.AllTicks().Any(b => b.StartsWith("/api/ticks/day ")) && desk.All1s().Count == 0,
                  "1s retired: The Desk gets the 1-minute bars and the tick day, never a post to /api/bars-1s (" + desk.Count + " minute message(s), " + desk.AllTicks().Count + " tick post(s), " + desk.All1s().Count + " 1 second post(s))");
            m0 = MadeCount();
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 7, 16, 21));
            ChartBridgeBars.PlanOnce(null);
            Check(TicksMade(m0).Count == 0 && desk.All1s().Count == 0, "1s retired: the next pass asks nothing more (the day is done, no 1 second request)");
            Check(File.Exists(set) && File.ReadAllText(set) == part + "\n" && File.Exists(sent) && File.ReadAllText(sent) == "2026-10-05 NQ 12-26\n" && Directory.GetFiles(Bars1sDir(dir)).Length == 1,
                  "1s retired: the leftovers are untouched (not read, sent, changed or deleted)");
            string d = Diag();
            Check(!d.Contains("oneSecond") && d.Contains("\"pcFrom\":\"config.txt\"}"), "1s retired: /diag bars has no oneSecond: " + d.Substring(Math.Max(0, d.Length - 80)));
        }
        finally { desk.Stop(); ChartBridgeTicks.Stop(); ChartBridgeTicks.ResetConfig(); typeof(ChartBridgeTicks).GetField("capturing", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, false); }
    }

    // ------------------------------------------------------------ 2026-11-03: the raw deleted once packed
    static void TickFilePacked(string dir)
    {
        ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 9, 16, 30));   // Friday
        TickFresh(dir);
        typeof(ChartBridgeTicks).GetMethod("LoadDays", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null);
        Desk desk = new Desk();
        string urlWas = ChartBridgeConfig.DeskUrl;
        ChartBridgeConfig.DeskUrl = desk.Url;
        int timeoutWas = ChartBridgeTicks.TimeoutMs;
        string T = TicksDir(dir);
        try
        {
            foreach (int day in new[] { 6, 7, 8 }) for (int i = 0; i < 4; i++) Feed(W(2026, 10, day, 9, 30).AddSeconds(i), 25000 + i * 0.25, 1);
            ChartBridgeTicks.WriteOnce();
            TickScan();
            string k6 = "2026-10-06 NQ 12-26", k7 = "2026-10-07 NQ 12-26", k8 = "2026-10-08 NQ 12-26";
            string raw6 = Path.Combine(T, "2026-10-06_NQ_12-26.raw"), state6 = Path.Combine(T, "2026-10-06_NQ_12-26.state"), raw8 = Path.Combine(T, "2026-10-08_NQ_12-26.raw");
            string last6 = ChartBridgeTicks.LastPartFile(k6), last8 = ChartBridgeTicks.LastPartFile(k8), asked6 = Path.Combine(T, "2026-10-06_NQ_12-26.day.asked");
            ChartBridgeTicks.PartMaxTicks = 2;
            desk.AnswerTicks = body => "{\"ok\":true,\"whole\":true,\"stored\":true,\"kept\":true,\"packed\":false}";
            ChartBridgeTicks.FinishDay(k6, HistOf(ChartBridgeTicks.ReadAllLive(k6)));
            ChartBridgeTicks.FinishDay(k7, HistOf(ChartBridgeTicks.ReadAllLive(k7)));
            ChartBridgeTicks.FinishDay(k8, HistOf(ChartBridgeTicks.ReadAllLive(k8).Skip(1)));   // failed
            ChartBridgeTicks.SendDays(null);
            List<string> sent = desk.AllTicks();
            string lastSent6 = sent.Where(b => b.Contains("\"session\":\"2026-10-06\"")).Last().Substring("/api/ticks/day ".Length);
            Check(File.Exists(raw6) && File.Exists(last6) && File.ReadAllText(last6).Trim() == lastSent6 && lastSent6.Contains("\"part\":2,\"parts\":2,") &&
                  !File.Exists(Path.Combine(T, "2026-10-06_NQ_12-26.day.jsonl")) && !File.Exists(last8) && File.Exists(raw8),
                  "tick packed: stored, not packed: the raw kept and only the day's last part kept (.day.last, the very part sent); a failed day keeps no part");
            Check(TickDisk() == FolderSize(dir), "tick packed: the last part counts in the folder's size against tickFileMaxMB: " + TickDisk() + " of " + FolderSize(dir));
            int n0 = desk.AllTicks().Count;
            Check(ChartBridgeTicks.AskPacked(null) == 0 && desk.AllTicks().Count == n0 && TickDiag().Contains("\"packWait\":{\"" + k6 + "\":{\"lastPart\":true,\"asked\":\"2026-10-09\"}"),
                  "tick packed: not asked again the day The Desk answered; /diag packWait says so: " + Regex.Match(TickDiag(), "\"packWait\":\\{[^}]*\\}").Value);

            // the next window (Saturday): asked once, the last part sent again; still not packed: the raw kept, not asked again that day
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 10, 10, 0));
            Check(ChartBridgeTicks.AskPacked(null) == 2 && desk.AllTicks().Count == n0 + 2 && desk.AllTicks()[n0] == "/api/ticks/day " + lastSent6 && !desk.AllTicks().Skip(n0).Any(b => b.Contains("2026-10-08")),
                  "tick packed: stored, not packed: the last part sent again in the next window (once a day); the failed day is never asked");
            Check(File.Exists(raw6) && File.Exists(state6) && File.Exists(last6) && Lines(dir, "ticks/tickdays.txt").Contains(k6 + "\texact\t1\t0\t2"), "tick packed: still not packed: everything kept");
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 10, 13, 0));
            Check(ChartBridgeTicks.AskPacked(null) == 0 && desk.AllTicks().Count == n0 + 2, "tick packed: at most once a New York day");
            // a raw older than 7 days stays listed in rawOld while it waits
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 16, 10, 0));
            Check(TickDiag().Contains("\"rawOld\":[\"2026-10-06 NQ 12-26\",\"2026-10-07 NQ 12-26\",\"2026-10-08 NQ 12-26\"]"), "tick packed: raw files older than 7 days stay listed in rawOld: " + Regex.Match(TickDiag(), "\"rawOld\":\\[[^\\]]*\\]").Value);
            // outside the windows (Monday 10:00, trading hours): nothing asked
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 12, 10, 0));
            Check(ChartBridgeTicks.AskPacked(null) == 0 && desk.AllTicks().Count == n0 + 2, "tick packed: never asked in trading hours");

            // Monday 08:00 (the morning window): a Desk without the route (404) keeps everything
            desk.StatusTicks = body => 404;
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 12, 8, 0));
            Check(ChartBridgeTicks.AskPacked(null) == 0 && File.Exists(raw6) && File.Exists(last6) && Lines(dir, "ticks/tickdays.txt").Contains(k6 + "\texact\t1\t0\t2") && TickDiag().Contains("\"deskHasNoTicks\":true"),
                  "tick packed: a Desk 404 keeps the raw, the state and the last part");
            typeof(ChartBridgeTicks).GetField("deskHasNone", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, false);
            // a time-out keeps everything and asks again after 15 minutes
            desk.StatusTicks = body => { Thread.Sleep(1500); return 200; };
            ChartBridgeTicks.TimeoutMs = 300;
            ChartBridgeTicks.AskPacked(null);
            Check(File.Exists(raw6) && File.Exists(last6) && Lines(dir, "ticks/tickdays.txt").Contains(k6 + "\texact\t1\t0\t2") && TickDiag().Contains("asking whether the day is packed"),
                  "tick packed: a Desk time-out keeps everything: " + Regex.Match(TickDiag(), "\"lastError\":\"[^\"]*\"").Value);
            ChartBridgeTicks.TimeoutMs = timeoutWas;
            desk.StatusTicks = body => 200;
            int n1 = desk.AllTicks().Count;
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 12, 8, 5));
            Check(ChartBridgeTicks.AskPacked(null) == 0 && desk.AllTicks().Count == n1, "tick packed: after a failure, not asked again before 15 minutes");

            // 08:20: packed: the raw, its state and the last part are deleted, tickdays and /diag say packed; the failed day keeps its raw
            desk.AnswerTicks = body => "{\"ok\":true,\"duplicate\":true,\"whole\":true,\"stored\":true,\"kept\":true,\"role\":\"master\",\"packed\":true}";
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 12, 8, 20));
            int asked = ChartBridgeTicks.AskPacked(null);
            Check(asked == 2 && !File.Exists(raw6) && !File.Exists(state6) && !File.Exists(last6) && !File.Exists(asked6) && Lines(dir, "ticks/tickdays.txt").Contains(k6 + "\texact\t1\t1\t2") && Lines(dir, "ticks/tickdays.txt").Contains(k7 + "\texact\t1\t1\t2"),
                  "tick packed: stored and packed true: the raw, its state and the last part deleted, tickdays.txt says packed: " + string.Join(" | ", Lines(dir, "ticks/tickdays.txt")));
            string diag = TickDiag();
            string filesPart = diag.Substring(diag.IndexOf("\"files\":"), diag.IndexOf("\"lastSent\":") - diag.IndexOf("\"files\":"));
            Check(!filesPart.Contains(k6) && filesPart.Contains(k8) && diag.Contains("\"" + k6 + "\":{\"check\":\"exact\",\"stored\":true,\"packed\":true,\"rule\":2}") && diag.Contains("\"packWait\":{}") && TickDisk() == FolderSize(dir),
                  "tick packed: /diag files no longer lists the day, days says packed, nothing waits");
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 16, 16, 30));
            Check(ChartBridgeTicks.AskPacked(null) == 0 && File.Exists(raw8) && Lines(dir, "ticks/tickdays.txt").Contains(k8 + "\tfailed\t1\t0\t2") && TickDiag().Contains("\"rawOld\":[\"2026-10-08 NQ 12-26\"]"),
                  "tick packed: a failed day is never deleted (until Anthony rules) and stays in rawOld");
        }
        finally { desk.Stop(); ChartBridgeConfig.DeskUrl = urlWas; ChartBridgeTicks.PartMaxTicks = 20000; ChartBridgeTicks.TimeoutMs = timeoutWas; }
    }

    // ------------------------------------------------------------ review LOW 3: no ghost key after the raw is deleted
    // A day stored and not packed, with its own chunk 1 cut and not sent yet (the 2026-10-06 file), and a later session's chunk
    // (2026-10-07); a stand-in Desk.
    static string ChunksOf(Desk desk, string session) { return string.Join("|", desk.AllTicks().Where(b => b.StartsWith("/api/ticks/chunk ") && b.Contains("\"session\":\"" + session + "\"")).ToArray()); }
    static int LoggedCount(string has) { lock (NinjaTrader.Code.Output.Lines) return NinjaTrader.Code.Output.Lines.Count(x => x.Contains(has)); }
    static string DiagFiles() { string d = TickDiag(); int i = d.IndexOf("\"files\":"), j = d.IndexOf("\"lastSent\":"); return i >= 0 && j > i ? d.Substring(i, j - i) : d; }
    static bool KeyKnown(string key) { return ((System.Collections.IDictionary)typeof(ChartBridgeTicks).GetField("Keys", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null)).Contains(key); }

    static void TickFileGhosts(string dir)
    {
        ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 9, 16, 30));   // Friday
        TickFresh(dir);
        typeof(ChartBridgeTicks).GetMethod("LoadDays", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null);
        Desk desk = new Desk();
        string urlWas = ChartBridgeConfig.DeskUrl;
        ChartBridgeConfig.DeskUrl = desk.Url;
        string T = TicksDir(dir);
        string k6 = "2026-10-06 NQ 12-26", k7 = "2026-10-07 NQ 12-26";
        string raw6 = Path.Combine(T, "2026-10-06_NQ_12-26.raw"), state6 = Path.Combine(T, "2026-10-06_NQ_12-26.state");
        string raw7 = Path.Combine(T, "2026-10-07_NQ_12-26.raw"), state7 = Path.Combine(T, "2026-10-07_NQ_12-26.state");
        try
        {
            // 1. the race: the bars worker's ScanFolder runs between deleting the files and forgetting the key
            foreach (int day in new[] { 6, 7 }) for (int i = 0; i < 4; i++) Feed(W(2026, 10, day, 9, 30).AddSeconds(i), 25000 + i * 0.25, 1);
            ChartBridgeTicks.WriteOnce();
            TickScan();
            Check(ChartBridgeTicks.CutOnce() == 2, "tick ghosts: one chunk cut for each session, not sent yet");
            desk.AnswerTicks = body => "{\"ok\":true,\"whole\":true,\"stored\":true,\"kept\":true,\"packed\":false}";
            ChartBridgeTicks.FinishDay(k6, HistOf(ChartBridgeTicks.ReadAllLive(k6)));
            ChartBridgeTicks.SendDays(null);
            Check(File.Exists(raw6) && File.Exists(ChartBridgeTicks.LastPartFile(k6)) && ChunksOf(desk, "2026-10-06") == "", "tick ghosts: 2026-10-06 stored, not packed, its chunk not sent");
            desk.AnswerTicks = body => "{\"ok\":true,\"duplicate\":true,\"stored\":true,\"packed\":true}";
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 10, 10, 0));   // Saturday
            string scanError = null; int scans = 0;
            ChartBridgeTicks.DeleteStepForHarness = () => { scans++; try { TickScan(); } catch (Exception ex) { scanError = (ex.InnerException ?? ex).Message; } };
            try { ChartBridgeTicks.AskPacked(null); } finally { ChartBridgeTicks.DeleteStepForHarness = null; }
            Check(scans == 1 && scanError == null && !File.Exists(raw6) && !File.Exists(state6) && !KeyKnown(k6) && !DiagFiles().Contains(k6) && DiagFiles().Contains(k7),
                  "tick ghosts: a ScanFolder between the delete's steps registers no ghost key and does not fail; /diag files lists only 2026-10-07: " + scans + " " + scanError + " " + DiagFiles());
            TickScan();
            Check(!KeyKnown(k6) && !DiagFiles().Contains(k6), "tick ghosts: a later ScanFolder registers nothing either");
            string sendError = null; int sent = -1;
            try { sent = ChartBridgeTicks.SendChunks(null); } catch (Exception ex) { sendError = ex.Message; }
            Check(sendError == null && sent == 1 && ChunksOf(desk, "2026-10-07") != "" && ChunksOf(desk, "2026-10-06") == "",
                  "tick ghosts: the later session's chunk goes, nothing of the deleted day is read: " + sent + " " + sendError);

            // 2. a delete cut short: tickdays.txt notes the day packed, its files still there: ScanFolder never registers it and
            //    finishes the delete
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 9, 16, 30));
            TickFresh(dir);
            typeof(ChartBridgeTicks).GetMethod("LoadDays", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null);
            desk.AnswerTicks = body => "{\"ok\":true,\"whole\":true,\"stored\":true,\"kept\":true,\"packed\":false}";
            foreach (int day in new[] { 6, 7 }) for (int i = 0; i < 4; i++) Feed(W(2026, 10, day, 9, 30).AddSeconds(i), 25000 + i * 0.25, 1);
            ChartBridgeTicks.WriteOnce();
            TickScan();
            ChartBridgeTicks.FinishDay(k6, HistOf(ChartBridgeTicks.ReadAllLive(k6)));
            ChartBridgeTicks.SendDays(null);
            string days = Path.Combine(T, "tickdays.txt");
            File.WriteAllLines(days, File.ReadAllLines(days).Select(x => x.StartsWith(k6 + "\t") ? k6 + "\texact\t1\t1" : x).ToArray());
            TickForget();   // as a restart: the keys forgotten, tickdays.txt read again
            TickScan();
            Check(!KeyKnown(k6) && !DiagFiles().Contains(k6) && !File.Exists(raw6) && !File.Exists(state6) && !File.Exists(ChartBridgeTicks.LastPartFile(k6)) && KeyKnown(k7) && TickDisk() == FolderSize(dir),
                  "tick ghosts: a state whose day tickdays.txt notes packed is not registered; its files left from a delete cut short are deleted: " + DiagFiles());

            // 2b. a failed day noted packed in tickdays.txt (a Desk regression, or a record rebuilt): after a restart ScanFolder keeps
            //     its raw and its state and registers its key (a failed day keeps its raw until Anthony rules)
            File.WriteAllLines(days, File.ReadAllLines(days).Where(x => !x.StartsWith(k7 + "\t")).Concat(new[] { k7 + "\tfailed\t1\t1" }).ToArray());
            TickForget();
            TickScan();
            Check(File.Exists(raw7) && File.Exists(state7) && KeyKnown(k7) && DiagFiles().Contains(k7),
                  "tick ghosts: a failed day noted packed keeps its raw and its state after a restart, its key registered: " + DiagFiles());

            // 3. a state file with no raw file (deleted by hand, or the raw went first and the delete was cut short): not registered
            File.Delete(raw7);
            TickForget();
            TickScan();
            Check(!KeyKnown(k7) && !DiagFiles().Contains(k7) && File.Exists(state7), "tick ghosts: a state file whose raw file is gone is not registered: " + DiagFiles());

            // 4. the sender: a known key whose raw file is gone, with a chunk not sent: passed over and said once; the later
            //    session's chunk still goes
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 9, 16, 30));
            TickFresh(dir);
            foreach (int day in new[] { 6, 7 }) for (int i = 0; i < 4; i++) Feed(W(2026, 10, day, 9, 30).AddSeconds(i), 25000 + i * 0.25, 1);
            ChartBridgeTicks.WriteOnce();
            Check(ChartBridgeTicks.CutOnce() == 2, "tick ghosts: a chunk for each session");
            File.Delete(raw6);
            int n0 = desk.AllTicks().Count, said0 = LoggedCount("2026-10-06 NQ 12-26: the raw file is gone");
            string e1 = null, e2 = null; int s1 = -1, s2 = -1;
            try { s1 = ChartBridgeTicks.SendChunks(null); } catch (Exception ex) { e1 = ex.Message; }
            try { s2 = ChartBridgeTicks.SendChunks(null); } catch (Exception ex) { e2 = ex.Message; }
            Check(e1 == null && e2 == null && s1 == 1 && s2 == 0 && desk.AllTicks().Count == n0 + 1 && desk.AllTicks()[n0].Contains("\"session\":\"2026-10-07\""),
                  "tick ghosts: a chunk whose raw file is gone never throws; the later session's chunk is not held up: " + s1 + " " + s2 + " " + e1 + " " + e2);
            Check(LoggedCount("2026-10-06 NQ 12-26: the raw file is gone") == said0 + 1, "tick ghosts: said once in the Output window, not every loop");
        }
        finally { ChartBridgeTicks.DeleteStepForHarness = null; desk.Stop(); ChartBridgeConfig.DeskUrl = urlWas; ChartBridgeTicks.Stop(); ChartBridgeTicks.ResetConfig(); typeof(ChartBridgeTicks).GetField("capturing", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, false); }
    }

    // ------------------------------------------------------------ review LOW 4 and LOW 2: asked at most once a day; packed via the master
    static void TickFileAskedOnce(string dir)
    {
        ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 9, 16, 30));   // Friday
        TickFresh(dir);
        typeof(ChartBridgeTicks).GetMethod("LoadDays", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null);
        Desk desk = new Desk();
        string urlWas = ChartBridgeConfig.DeskUrl;
        ChartBridgeConfig.DeskUrl = desk.Url;
        string T = TicksDir(dir);
        string k6 = "2026-10-06 NQ 12-26";
        string raw6 = Path.Combine(T, "2026-10-06_NQ_12-26.raw"), state6 = Path.Combine(T, "2026-10-06_NQ_12-26.state"), last6 = ChartBridgeTicks.LastPartFile(k6);
        string asked6 = Path.Combine(T, "2026-10-06_NQ_12-26.day.asked");
        Func<int> asks = () => desk.AllTicks().Count(b => b.StartsWith("/api/ticks/day "));
        try
        {
            for (int i = 0; i < 4; i++) Feed(W(2026, 10, 6, 9, 30).AddSeconds(i), 25000 + i * 0.25, 1);
            ChartBridgeTicks.WriteOnce();
            TickScan();
            desk.AnswerTicks = body => "{\"ok\":true,\"whole\":true,\"stored\":true,\"kept\":true,\"packed\":false}";
            ChartBridgeTicks.FinishDay(k6, HistOf(ChartBridgeTicks.ReadAllLive(k6)));
            ChartBridgeTicks.SendDays(null);
            Check(File.Exists(last6) && File.Exists(asked6), "tick asked: 2026-10-06 stored, not packed, waiting");
            // the asked file cannot be written (a folder stands in its place): still at most once a New York day
            File.Delete(asked6); Directory.CreateDirectory(asked6);
            int a0 = asks();
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 10, 10, 0));   // Saturday
            int r1 = ChartBridgeTicks.AskPacked(null);
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 10, 10, 1));
            int r2 = ChartBridgeTicks.AskPacked(null);
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 10, 13, 0));
            int r3 = ChartBridgeTicks.AskPacked(null);
            Check(r1 == 1 && r2 == 0 && r3 == 0 && asks() == a0 + 1 && File.Exists(raw6) && File.Exists(last6),
                  "tick asked: the asked file write fails: still asked at most once a New York day (not every send loop): " + r1 + " " + r2 + " " + r3 + " " + (asks() - a0));
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 11, 10, 0));   // Sunday
            Check(ChartBridgeTicks.AskPacked(null) == 1 && asks() == a0 + 2, "tick asked: ... and asked again the next day");

            // a 400 / 422 refusal: everything kept, not asked again that day (the file still cannot be written), asked again the next day
            desk.StatusTicks = body => 422;
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 12, 8, 0));   // Monday morning
            int f1 = ChartBridgeTicks.AskPacked(null);
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 12, 8, 30));
            int f2 = ChartBridgeTicks.AskPacked(null);
            Check(f1 == 1 && f2 == 0 && asks() == a0 + 3 && File.Exists(raw6) && File.Exists(last6) && Lines(dir, "ticks/tickdays.txt").Contains(k6 + "\texact\t1\t0\t2") && Logged("asked again tomorrow"),
                  "tick asked: a 422 refusal keeps everything and is not asked again that day: " + f1 + " " + f2);
            desk.StatusTicks = body => 400;
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 13, 8, 0));   // Tuesday morning
            Check(ChartBridgeTicks.AskPacked(null) == 1 && asks() == a0 + 4 && ChartBridgeTicks.AskPacked(null) == 0 && File.Exists(raw6),
                  "tick asked: after a refusal, asked again the next day (a 400 this time: kept, once)");
            desk.StatusTicks = body => 200;

            // a 200 with no "packed" in it: everything kept, not packed, once a day
            Directory.Delete(asked6);
            desk.AnswerTicks = body => "{\"ok\":true,\"stored\":true}";
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 14, 8, 0));   // Wednesday morning
            int g1 = ChartBridgeTicks.AskPacked(null), g2 = ChartBridgeTicks.AskPacked(null);
            Check(g1 == 1 && g2 == 0 && File.Exists(raw6) && File.Exists(state6) && File.Exists(last6) && Lines(dir, "ticks/tickdays.txt").Contains(k6 + "\texact\t1\t0\t2") &&
                  File.Exists(asked6) && File.ReadAllText(asked6).Trim() == "2026-10-14" && TickDiag().Contains("\"packWait\":{\"" + k6 + "\":{\"lastPart\":true,\"asked\":\"2026-10-14\"}"),
                  "tick asked: a 200 without \"packed\" keeps the raw, its state and the last part, noted asked today: " + g1 + " " + g2);

            // review LOW 2: a day this PC sent that The Desk flagged (another PC is the master) packs when the master day is packed:
            // The Desk answers packed true via the master, and the raw is deleted
            ChartBridgeBars.ReadConfig("pc", "HOME");
            desk.AnswerTicks = body => "{\"stored\":true,\"packed\":true,\"packedVia\":\"master\"}";
            ChartBridgeBars.UtcNow = () => EtToUtc(W(2026, 10, 15, 8, 0));   // Thursday morning
            Check(ChartBridgeTicks.AskPacked(null) == 1 && !File.Exists(raw6) && !File.Exists(state6) && !File.Exists(last6) && !File.Exists(asked6) &&
                  Lines(dir, "ticks/tickdays.txt").Contains(k6 + "\texact\t1\t1\t2") && !DiagFiles().Contains(k6) && TickDiag().Contains("\"packWait\":{}"),
                  "tick asked: a flagged day: The Desk answers stored and packed true via the master: the raw, its state and the last part deleted, tickdays.txt says packed");
        }
        finally
        {
            try { if (Directory.Exists(asked6)) Directory.Delete(asked6); } catch (Exception) { }
            ChartBridgeBars.ReadConfig("pc", "WORK");
            desk.Stop(); ChartBridgeConfig.DeskUrl = urlWas; ChartBridgeTicks.Stop(); ChartBridgeTicks.ResetConfig();
            typeof(ChartBridgeTicks).GetField("capturing", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, false);
        }
    }
}
