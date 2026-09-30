// Daily 1-minute bars to The Desk (ChartBridge 0.3.6-pre, ChartBridgeBars.cs), run for real on Mono (nt8/check/bars.sh).
// The session date (18:00 New York start, Sunday open to Monday, daylight saving in March and November, early closes),
// NinjaTrader's close stamps to open times in UTC from several NinjaTrader time zones, which sessions the catch-up
// picks, the contract per root and session, the message, the queue against a stand-in Desk (down, back, a refusal, a
// line cut short), and whole passes with the stand-in BarsRequest (connected or not, a chart loading, no answer).
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
    static int fails, passes;
    static void Check(bool ok, string what)
    {
        if (ok) { passes++; Console.WriteLine("ok   " + what); }
        else { fails++; Console.WriteLine("FAIL " + what); }
    }

    static TimeZoneInfo Zone(string id) { return TimeZoneInfo.FindSystemTimeZoneById(id); }
    static TimeZoneInfo NY, Chicago, London, Tokyo;
    static DateTime D(int y, int m, int d) { return new DateTime(y, m, d); }
    static DateTime W(int y, int mo, int d, int h, int mi) { return new DateTime(y, mo, d, h, mi, 0); }
    static DateTime Utc(int y, int mo, int d, int h, int mi) { return new DateTime(y, mo, d, h, mi, 0, DateTimeKind.Utc); }
    static long Ms(DateTime utc) { return (long)Math.Round((utc - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds); }
    // New York wall time as NinjaTrader shows it in its (stand-in) time zone.
    static DateTime NtOf(DateTime etWall) { return TimeZoneInfo.ConvertTimeFromUtc(TimeZoneInfo.ConvertTimeToUtc(etWall, NY), NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo); }
    static void NtZone(TimeZoneInfo z) { NinjaTrader.Core.GeneralOptionsClass.Zone = z; }

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

    public static int Main()
    {
        NY = Zone("America/New_York"); Chicago = Zone("America/Chicago"); London = Zone("Europe/London"); Tokyo = Zone("Asia/Tokyo");
        // Linux has no Windows time zone names; ChartBridge asks for "Eastern Standard Time".
        typeof(ChartBridgeTime).GetField("et", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, NY);
        string dir = Path.Combine(Path.GetTempPath(), "cb-bars-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(dir, "ChartBridge"));
        NinjaTrader.Core.Globals.UserDataDir = dir;
        ChartBridgeBars.ResetConfig();
        try
        {
            SessionDates();
            SessionBounds();
            Stamps();
            SessionBarsCases();
            CatchUp();
            Contracts();
            Message();
            Config();
            QueueCases(dir);
            Passes(dir);
        }
        catch (Exception ex) { Check(false, "harness threw: " + ex); }
        Console.WriteLine(fails == 0 ? "ALL PASSED (" + passes + " checks)" : fails + " FAILED (" + passes + " passed)");
        return fails == 0 ? 0 : 1;
    }

    // ------------------------------------------------------------ the session date
    static void SessionDates()
    {
        Func<DateTime, string> S = et => { DateTime d = ChartBridgeBars.SessionDateOfEt(et); return d == DateTime.MinValue ? "shut" : d.ToString("yyyy-MM-dd ddd"); };
        Check(S(W(2026, 9, 30, 9, 30)) == "2026-09-30 Wed", "Wednesday 09:30 ET is Wednesday's session");
        Check(S(W(2026, 9, 29, 18, 0)) == "2026-09-30 Wed", "Tuesday 18:00 ET opens Wednesday's session");
        Check(S(W(2026, 9, 29, 17, 59)) == "shut", "Tuesday 17:59 ET is the daily break");
        Check(S(W(2026, 9, 29, 16, 59)) == "2026-09-29 Tue", "Tuesday 16:59 ET is still Tuesday's session");
        Check(S(W(2026, 9, 29, 17, 0)) == "shut", "Tuesday 17:00 ET: Tuesday's session is over");
        Check(S(W(2026, 10, 2, 16, 59)) == "2026-10-02 Fri", "Friday 16:59 ET is Friday's session");
        Check(S(W(2026, 10, 2, 18, 30)) == "shut", "Friday 18:30 ET: no session (weekend)");
        Check(S(W(2026, 10, 3, 12, 0)) == "shut", "Saturday: no session");
        Check(S(W(2026, 10, 4, 17, 59)) == "shut", "Sunday 17:59 ET: no session yet");
        Check(S(W(2026, 10, 4, 18, 0)) == "2026-10-05 Mon", "the Sunday 18:00 ET open belongs to Monday");
        Check(S(W(2026, 10, 4, 23, 0)) == "2026-10-05 Mon", "Sunday evening is Monday's session");
        // DST: March 8 2026 and November 1 2026 (Sundays, 2 AM, market shut)
        Check(S(W(2026, 3, 8, 18, 0)) == "2026-03-09 Mon", "March DST Sunday: 18:00 EDT opens Monday's session");
        Check(S(W(2026, 11, 1, 18, 0)) == "2026-11-02 Mon", "November DST Sunday: 18:00 EST opens Monday's session");
        // Thanksgiving 2026: Thursday halts early (13:00 ET), Friday opens Thursday 18:00 ET and closes early (13:15 ET)
        Check(S(W(2026, 11, 26, 12, 59)) == "2026-11-26 Thu", "Thanksgiving Thursday morning is Thursday's session");
        Check(S(W(2026, 11, 26, 18, 0)) == "2026-11-27 Fri", "Thanksgiving Thursday 18:00 ET opens Friday's (early close) session");
        Check(S(W(2026, 11, 27, 13, 14)) == "2026-11-27 Fri", "the day after Thanksgiving 13:14 ET is Friday's session");
    }

    static void SessionBounds()
    {
        Action<DateTime, DateTime, DateTime, string> B = (s, o, c, what) =>
        {
            DateTime ou, cu; ChartBridgeBars.SessionUtc(s, out ou, out cu);
            Check(ou == o && cu == c && (cu - ou).TotalHours == 23, what + ": " + ou.ToString("u") + " to " + cu.ToString("u"));
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
            Check(got == want, "NinjaTrader in " + z.Id + ": the bar stamped 09:31 ET opened 09:30 ET = " + got);
        }
        // London is one hour closer to New York between the US (March 8) and UK (March 29) changes
        NtZone(London);
        DateTime stamp = NtOf(W(2026, 3, 10, 10, 1));
        Check(stamp == W(2026, 3, 10, 14, 1), "NinjaTrader in London on 2026-03-10 shows the 10:01 ET close as 14:01 (" + stamp + ")");
        Check(ChartBridgeBars.OpenUtcMs(stamp) == Ms(Utc(2026, 3, 10, 14, 0)), "and its open is 14:00 UTC");
        NtZone(Chicago);
        Check(ChartBridgeBars.OpenUtcMs(W(2026, 9, 29, 17, 1)) == Ms(Utc(2026, 9, 29, 22, 0)), "NinjaTrader in Chicago: the session's first bar (17:01 CT) opened 18:00 ET");
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
                  "NinjaTrader in " + z.Id + ": session 2026-09-30 is 1380 bars, 18:00 ET to the 16:59 ET open (" + b.Count + ")");
        }
        NtZone(Chicago);
        // Monday: the Sunday evening belongs to it; Friday's bars do not
        RawBars wk = Minutes(W(2026, 10, 2, 12, 0), W(2026, 10, 5, 18, 0), Trading);
        List<DeskBar> mon = ChartBridgeBars.SessionBars(wk, D(2026, 10, 5), late);
        Check(mon.Count == 1380 && mon[0].T == Ms(Utc(2026, 10, 4, 22, 0)), "Monday 2026-10-05: 1380 bars from Sunday 18:00 ET");
        List<DeskBar> fri = ChartBridgeBars.SessionBars(wk, D(2026, 10, 2), late);
        Check(fri.Count == 300 && fri[fri.Count - 1].T == Ms(Utc(2026, 10, 2, 20, 59)), "Friday: only Friday's bars (from 12:00 in this sample) up to the 16:59 ET open (" + fri.Count + ")");
        // DST weeks
        NtZone(NY);
        List<DeskBar> mar = ChartBridgeBars.SessionBars(Minutes(W(2026, 3, 8, 12, 0), W(2026, 3, 9, 18, 0), Trading), D(2026, 3, 9), late);
        Check(mar.Count == 1380 && mar[0].T == Ms(Utc(2026, 3, 8, 22, 0)), "March DST Monday: 1380 bars from 22:00 UTC Sunday");
        List<DeskBar> nov = ChartBridgeBars.SessionBars(Minutes(W(2026, 11, 1, 12, 0), W(2026, 11, 2, 18, 0), Trading), D(2026, 11, 2), late);
        Check(nov.Count == 1380 && nov[0].T == Ms(Utc(2026, 11, 1, 23, 0)), "November DST Monday: 1380 bars from 23:00 UTC Sunday");
        NtZone(London);   // NinjaTrader set to London in the US-only DST weeks
        List<DeskBar> marL = ChartBridgeBars.SessionBars(Minutes(W(2026, 3, 8, 12, 0), W(2026, 3, 9, 18, 0), Trading), D(2026, 3, 9), late);
        Check(marL.Count == 1380 && marL[0].T == Ms(Utc(2026, 3, 8, 22, 0)), "the same, NinjaTrader in London (UK clocks not changed yet)");
        List<DeskBar> octL = ChartBridgeBars.SessionBars(Minutes(W(2026, 10, 25, 12, 0), W(2026, 10, 26, 18, 0), Trading), D(2026, 10, 26), late);
        Check(octL.Count == 1380 && octL[0].T == Ms(Utc(2026, 10, 25, 22, 0)), "Monday 2026-10-26, NinjaTrader in London (UK clocks already back)");
        // Thanksgiving: Thursday halts at 13:00 ET, reopens 18:00 ET for Friday, which closes at 13:15 ET
        NtZone(Chicago);
        Func<DateTime, bool> thanks = et => Trading(et) && !(et.Date == D(2026, 11, 26) && et.Hour >= 13 && et.Hour < 17) && !(et.Date == D(2026, 11, 27) && (et.Hour > 13 || (et.Hour == 13 && et.Minute >= 15)));
        RawBars tg = Minutes(W(2026, 11, 25, 12, 0), W(2026, 11, 27, 18, 0), thanks);
        List<DeskBar> thu = ChartBridgeBars.SessionBars(tg, D(2026, 11, 26), late);
        List<DeskBar> fr = ChartBridgeBars.SessionBars(tg, D(2026, 11, 27), late);
        Check(thu.Count == 1140 && thu[thu.Count - 1].T == Ms(Utc(2026, 11, 26, 17, 59)), "Thanksgiving Thursday: Wednesday 18:00 ET to the 12:59 ET open, 1140 bars (" + thu.Count + ")");
        Check(fr.Count == 1155 && fr[0].T == Ms(Utc(2026, 11, 26, 23, 0)) && fr[fr.Count - 1].T == Ms(Utc(2026, 11, 27, 18, 14)), "the Friday after: Thursday 18:00 ET to the 13:14 ET open, 1155 bars (" + fr.Count + ")");
        // never an unfinished bar; sorted; one per minute
        RawBars mid = Minutes(W(2026, 9, 29, 18, 0), W(2026, 9, 30, 12, 0), Trading);
        List<DeskBar> part = ChartBridgeBars.SessionBars(mid, D(2026, 9, 30), Utc(2026, 9, 30, 13, 30).AddSeconds(59));
        Check(part.Count > 0 && part[part.Count - 1].T == Ms(Utc(2026, 9, 30, 13, 29)), "a bar still forming at 'now' is never included (last open 09:29 ET at 09:30:59 ET)");
        RawBars shuffled = Minutes(W(2026, 9, 29, 18, 0), W(2026, 9, 29, 18, 5), Trading);
        Array.Reverse(shuffled.Time); Array.Reverse(shuffled.Open); Array.Reverse(shuffled.High); Array.Reverse(shuffled.Low); Array.Reverse(shuffled.Close); Array.Reverse(shuffled.Volume);
        RawBars dup = new RawBars { Count = shuffled.Count + 1, Time = shuffled.Time.Concat(new[] { shuffled.Time[0] }).ToArray(), Open = shuffled.Open.Concat(new[] { 1.0 }).ToArray(),
                                   High = shuffled.High.Concat(new[] { 2.0 }).ToArray(), Low = shuffled.Low.Concat(new[] { 0.5 }).ToArray(), Close = shuffled.Close.Concat(new[] { 1.5 }).ToArray(), Volume = shuffled.Volume.Concat(new[] { 7L }).ToArray() };
        List<DeskBar> sd = ChartBridgeBars.SessionBars(dup, D(2026, 9, 30), late);
        bool sorted = true; for (int i = 1; i < sd.Count; i++) if (sd[i].T <= sd[i - 1].T) sorted = false;
        Check(sd.Count == 5 && sorted && sd[4].O == 1.0 && sd[4].V == 7, "rows come out sorted, one per minute (a repeated minute keeps NinjaTrader's later row)");
        Check(ChartBridgeBars.SessionBars(null, D(2026, 9, 30), late).Count == 0, "no bars: an empty list, no exception");
        NtZone(null);
    }

    // ------------------------------------------------------------ which sessions the catch-up picks
    static string Days(List<DateTime> l) { return string.Join(",", l.Select(d => d.ToString("MM-dd"))); }
    static void CatchUp()
    {
        Func<DateTime, bool> none = d => false;
        Check(Days(ChartBridgeBars.RecentSessions(W(2026, 9, 30, 10, 0), 5, none)) == "09-29,09-28,09-25,09-24,09-23", "Wednesday morning: the last 5 closed sessions, weekends skipped");
        Check(Days(ChartBridgeBars.RecentSessions(W(2026, 9, 30, 17, 4), 5, none)) == "09-29,09-28,09-25,09-24,09-23", "17:04 ET: today's session is not taken yet (close + 5 minutes)");
        Check(Days(ChartBridgeBars.RecentSessions(W(2026, 9, 30, 17, 5), 5, none)) == "09-30,09-29,09-28,09-25,09-24", "17:05 ET: today's session is due");
        Check(Days(ChartBridgeBars.RecentSessions(W(2026, 10, 4, 20, 0), 5, none)) == "10-02,10-01,09-30,09-29,09-28", "Sunday evening: Friday first");
        Check(Days(ChartBridgeBars.RecentSessions(W(2026, 10, 5, 9, 0), 5, none)) == "10-02,10-01,09-30,09-29,09-28", "Monday morning: Monday's session is not closed yet");
        Func<DateTime, bool> xmas = d => d == D(2026, 12, 25);
        Check(Days(ChartBridgeBars.RecentSessions(W(2026, 12, 28, 10, 0), 5, xmas)) == "12-24,12-23,12-22,12-21,12-18", "a full holiday (Christmas, Friday) is skipped");
        Func<DateTime, bool> goodFriday = d => d == D(2027, 3, 26);
        Check(Days(ChartBridgeBars.RecentSessions(W(2027, 3, 29, 18, 0), 3, goodFriday)) == "03-29,03-25,03-24", "Good Friday is skipped");
        Check(Days(ChartBridgeBars.RecentSessions(W(2026, 11, 27, 17, 10), 2, none)) == "11-27,11-26", "early-close days are ordinary sessions");
        Check(ChartBridgeBars.RecentSessions(W(2026, 9, 30, 10, 0), 5, d => { throw new Exception("x"); }).Count == 5, "a holiday check that throws is taken as no holiday");
    }

    static void Contracts()
    {
        ChartBridgeConfig.ContractOverride.Clear();
        Check(ChartBridgeBars.FrontContract("MNQ", D(2026, 12, 9)) == "MNQ 12-26", "front month the day before the December roll (Thursday 2026-12-10): MNQ 12-26");
        Check(ChartBridgeBars.FrontContract("MNQ", D(2026, 12, 10)) == "MNQ 03-27", "on the roll day: MNQ 03-27 (the chart's rule)");
        Check(ChartBridgeBars.FrontContract("ES", D(2026, 9, 30)) == "ES 12-26", "ES on 2026-09-30: ES 12-26");
        ChartBridgeConfig.ContractOverride["NQ"] = "NQ 03-27";
        Check(ChartBridgeBars.FrontContract("NQ", D(2026, 9, 30)) == "NQ 03-27", "contract.NQ in config.txt wins, as on the chart");
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
              "wanted: newest session first, each root's front month, plus another contract traded that session, once: " + string.Join(" | ", w.Select(j => j.Key)));
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
        Check(m == want, "the message is contract v1, field for field: " + m);
        Check(ChartBridgeBarsQueue.KeyOfLine(m) == "2026-09-30 MNQ 12-26", "its queue key is the session and contract");
        Check(ChartBridgeBarsQueue.KeyOfLine(m.Substring(0, m.Length - 5)) == null, "a line cut short has no key");
        ChartBridgeBars.Pc = "";
        Check(ChartBridgeBars.PcName() == Environment.MachineName, "no pc in config.txt: the Windows computer name");
        ChartBridgeBars.Pc = pcWas;
    }

    static void Config()
    {
        ChartBridgeBars.ResetConfig();
        Check(!ChartBridgeBars.Enabled && string.Join(",", ChartBridgeBars.Roots) == "NQ,MNQ,ES,MES", "off by default; NQ, MNQ, ES, MES by default");
        Check(ChartBridgeBars.ReadConfig("bars", "on") && ChartBridgeBars.Enabled, "bars = on turns it on");
        ChartBridgeBars.ReadConfig("bars", "off");
        Check(!ChartBridgeBars.Enabled, "bars = off turns it off");
        ChartBridgeBars.ReadConfig("barsRoots", " mnq , es ");
        Check(string.Join(",", ChartBridgeBars.Roots) == "MNQ,ES", "barsRoots");
        ChartBridgeBars.ReadConfig("pc", "WORK");
        Check(ChartBridgeBars.PcName() == "WORK", "pc");
        Check(!ChartBridgeBars.ReadConfig("trading", "true"), "other keys are not taken");
        ChartBridgeBars.ResetConfig();
    }

    // ------------------------------------------------------------ a stand-in Desk
    class Desk
    {
        public HttpListener L; public int Port; public readonly List<string> Bodies = new List<string>();
        public Func<string, int> Status = body => 200;
        public Desk(int port)
        {
            Port = port; L = new HttpListener(); L.Prefixes.Add("http://127.0.0.1:" + port + "/"); L.Start();
            HttpListener l = L;
            Task.Run(() =>
            {
                while (l.IsListening)
                {
                    HttpListenerContext ctx;
                    try { ctx = l.GetContext(); } catch (Exception) { break; }
                    string body; using (StreamReader r = new StreamReader(ctx.Request.InputStream)) body = r.ReadToEnd();
                    if (ctx.Request.Url.AbsolutePath != "/api/bars") { ctx.Response.StatusCode = 404; ctx.Response.Close(); continue; }
                    lock (Bodies) Bodies.Add(body);
                    int code = Status(body);
                    string ans = code == 200 ? "{\"ok\":true,\"stored\":1}" : "{\"detail\":\"bars must be a list\"}";
                    byte[] b = System.Text.Encoding.UTF8.GetBytes(ans);
                    ctx.Response.StatusCode = code; ctx.Response.OutputStream.Write(b, 0, b.Length); ctx.Response.Close();
                }
            });
        }
        public int Count { get { lock (Bodies) return Bodies.Count; } }
        public void Stop() { try { L.Stop(); L.Close(); } catch (Exception) { } }
    }

    static string Pending(string dir) { string f = Path.Combine(dir, "ChartBridge", "pending_bars.jsonl"); return File.Exists(f) ? File.ReadAllText(f) : ""; }
    static string[] Lines(string dir, string name) { string f = Path.Combine(dir, "ChartBridge", name); return File.Exists(f) ? File.ReadAllLines(f).Where(x => x.Trim().Length > 0).ToArray() : new string[0]; }

    static void QueueCases(string dir)
    {
        ChartBridgeBars.UtcNow = () => Utc(2026, 9, 30, 21, 10);
        ChartBridgeBars.Enabled = true;
        int port = 20000 + new Random().Next(9000);
        ChartBridgeConfig.DeskUrl = "http://127.0.0.1:" + port;          // nothing listens yet: The Desk is down
        ChartBridgeBarsQueue.Load();
        List<DeskBar> one = new List<DeskBar> { new DeskBar { T = 1759269600000, O = 1, H = 2, L = 0.5, C = 1.5, V = 3 } };
        string m1 = ChartBridgeBars.MessageJson("MNQ 12-26", "MNQ", 0.25, D(2026, 9, 30), one);
        string m2 = ChartBridgeBars.MessageJson("ES 12-26", "ES", 0.25, D(2026, 9, 30), one);
        ChartBridgeBarsQueue.Queue("2026-09-30 MNQ 12-26", m1);
        ChartBridgeBarsQueue.Queue("2026-09-30 MNQ 12-26", m1);
        ChartBridgeBarsQueue.Queue("2026-09-30 ES 12-26", m2);
        Check(ChartBridgeBarsQueue.Waiting() == 2 && Lines(dir, "pending_bars.jsonl").Length == 2, "queued before sending, once each, in pending_bars.jsonl");
        ChartBridgeBarsQueue.Flush();
        string diag = ChartBridgeBars.DiagJson();
        Check(diag.Contains("\"waiting\":2") && !diag.Contains("\"lastError\":\"\"") && ChartBridgeBarsQueue.IsWaiting("2026-09-30 ES 12-26"), "Desk down: both wait, /diag shows the error: " + diag);
        int lines;
        lock (NinjaTrader.Code.Output.Lines) lines = NinjaTrader.Code.Output.Lines.Count(x => x.Contains("The Desk did not take bars"));
        ChartBridgeBarsQueue.Flush();
        int lines2;
        lock (NinjaTrader.Code.Output.Lines) lines2 = NinjaTrader.Code.Output.Lines.Count(x => x.Contains("The Desk did not take bars"));
        Check(lines == 1 && lines2 == 1, "Desk down: one Output line, not one per retry");

        // a restart in between: the queue comes back from the file; a line cut short is skipped
        File.AppendAllText(Path.Combine(dir, "ChartBridge", "pending_bars.jsonl"), m1.Substring(0, 40) + Environment.NewLine);
        ChartBridgeBarsQueue.Load();
        Check(ChartBridgeBarsQueue.Waiting() == 2, "after a restart: the 2 messages are back, the cut line skipped");

        Desk desk = new Desk(port);
        try
        {
            ChartBridgeBarsQueue.Flush();
            diag = ChartBridgeBars.DiagJson();
            Check(desk.Count == 2 && desk.Bodies[0] == m1 && desk.Bodies[1] == m2, "Desk back: each message posted once, oldest first, exactly as queued");
            Check(ChartBridgeBarsQueue.Waiting() == 0 && Lines(dir, "pending_bars.jsonl").Length == 0, "pending_bars.jsonl is empty");
            Check(ChartBridgeBarsQueue.IsDone("2026-09-30 MNQ 12-26") && Lines(dir, "sent_bars.txt").Contains("2026-09-30 MNQ 12-26"), "sent_bars.txt notes the session");
            Check(diag.Contains("\"lastSent\":{\"ES 12-26\":\"2026-09-30\",\"MNQ 12-26\":\"2026-09-30\"}") && diag.Contains("\"lastError\":\"\""), "/diag: last session per contract, no stale error: " + diag);

            // a message The Desk calls malformed is set aside, and the next one still goes
            desk.Status = body => body.Contains("NQ 03-27") ? 400 : 200;
            string bad = ChartBridgeBars.MessageJson("NQ 03-27", "NQ", 0.25, D(2026, 9, 29), one);
            string good = ChartBridgeBars.MessageJson("NQ 12-26", "NQ", 0.25, D(2026, 9, 29), one);
            ChartBridgeBarsQueue.Queue("2026-09-29 NQ 03-27", bad);
            ChartBridgeBarsQueue.Queue("2026-09-29 NQ 12-26", good);
            ChartBridgeBarsQueue.Flush();
            Check(ChartBridgeBarsQueue.Waiting() == 0 && Lines(dir, "rejected_bars.jsonl").Length == 1 && Lines(dir, "rejected_bars.jsonl")[0] == bad, "400: set aside in rejected_bars.jsonl");
            Check(ChartBridgeBarsQueue.IsDone("2026-09-29 NQ 12-26") && !ChartBridgeBarsQueue.IsDone("2026-09-29 NQ 03-27") && ChartBridgeBars.DiagJson().Contains("\"setAside\":1"), "the next message still went; the refused one is not marked sent");
            bool said;
            lock (NinjaTrader.Code.Output.Lines) said = NinjaTrader.Code.Output.Lines.Any(x => x.Contains("refused the bars for 2026-09-29 NQ 03-27 (400: bars must be a list)"));
            Check(said, "the refusal and The Desk's reason are in the Output window");

            // the record keeps 40 days
            ChartBridgeBars.UtcNow = () => Utc(2026, 11, 20, 12, 0);
            ChartBridgeBarsQueue.Queue("2026-11-19 MNQ 12-26", ChartBridgeBars.MessageJson("MNQ 12-26", "MNQ", 0.25, D(2026, 11, 19), one));
            desk.Status = body => 200;
            ChartBridgeBarsQueue.Flush();
            Check(Lines(dir, "sent_bars.txt").SequenceEqual(new[] { "2026-11-19 MNQ 12-26" }), "sent_bars.txt drops sessions over 40 days old: " + string.Join(";", Lines(dir, "sent_bars.txt")));
            ChartBridgeBars.Enabled = false;
            ChartBridgeBarsQueue.Queue("2026-11-18 MNQ 12-26", ChartBridgeBars.MessageJson("MNQ 12-26", "MNQ", 0.25, D(2026, 11, 18), one));
            int before = desk.Count;
            ChartBridgeBarsQueue.Flush();
            Check(desk.Count == before, "bars off: nothing is sent");
        }
        finally { desk.Stop(); ChartBridgeBars.Enabled = false; }
    }

    // ------------------------------------------------------------ whole passes (the stand-in BarsRequest answers at once)
    static Instrument Inst(string name)
    {
        string root = name.Split(' ')[0];
        return new Instrument { FullName = name, MasterInstrument = new MasterInstrument { Name = root, TickSize = 0.25, PointValue = root == "MNQ" ? 2 : 20, TradingHours = new TradingHours { Name = "CME US Index Futures ETH" } } };
    }

    static bool AnswerLikeNt(BarsRequest r)
    {
        // Every open minute between from (a date, NinjaTrader's time) and to, stamped at its close in NinjaTrader's zone.
        TimeZoneInfo nt = NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo;
        DateTime fromEt = TimeZoneInfo.ConvertTimeFromUtc(TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(r.From, DateTimeKind.Unspecified), nt), NY);
        DateTime toEt = TimeZoneInfo.ConvertTimeFromUtc(TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(r.To, DateTimeKind.Unspecified), nt), NY);
        RawBars raw = Minutes(new DateTime(fromEt.Year, fromEt.Month, fromEt.Day, fromEt.Hour, fromEt.Minute, 0), toEt.AddMinutes(-1), Trading);
        Bars b = new Bars();
        for (int i = 0; i < raw.Count; i++) b.Add(raw.Time[i], raw.Open[i], raw.High[i], raw.Low[i], raw.Close[i], raw.Volume[i]);
        r.Answer(b, ErrorCode.NoError);
        return true;
    }

    static List<BarsRequest> Made() { lock (BarsRequest.Made) return BarsRequest.Made.ToList(); }

    static void Passes(string dir)
    {
        NtZone(Chicago);
        ChartBridgeConfig.ContractOverride.Clear();
        ChartBridgeBars.ResetConfig();
        ChartBridgeBars.ReadConfig("bars", "on");
        ChartBridgeBars.ReadConfig("barsRoots", "MNQ, ES");
        ChartBridgeBars.ReadConfig("pc", "HOME");
        ChartBridgeBars.PauseBetweenMs = 0;
        foreach (string f in new[] { "pending_bars.jsonl", "sent_bars.txt", "rejected_bars.jsonl" }) File.Delete(Path.Combine(dir, "ChartBridge", f));
        ChartBridgeBarsQueue.Load();
        ChartBridgeBars.Lookup = name => Inst(name);
        ChartBridgeBars.UtcNow = () => Utc(2026, 9, 30, 21, 6);   // 17:06 ET: today's session is due
        bool connected = false;
        ChartBridgeBars.IsConnected = () => connected;
        // a fill in another MNQ contract this session, on a made-up account
        Account acct = new Account { Name = "SimHarness" };
        acct.Executions.Add(new Execution { Instrument = Inst("MNQ 09-26"), Time = NtOf(W(2026, 9, 30, 10, 0)), ExecutionId = "x1", Price = 1, Quantity = 1 });
        Account.All.Add(acct);
        int port = 20000 + new Random().Next(9000);
        ChartBridgeConfig.DeskUrl = "http://127.0.0.1:" + port;
        Desk desk = new Desk(port);
        BarsRequest.AutoAnswer = AnswerLikeNt;
        try
        {
            lock (BarsRequest.Made) BarsRequest.Made.Clear();
            ChartBridgeBars.PlanOnce(null);
            Check(Made().Count == 0 && desk.Count == 0, "not connected: nothing is asked for");

            connected = true;
            var clients = (System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
            ChartBridgeClient page = new ChartBridgeClient(null, 91) { Root = "MNQ", Ready = false };
            clients[91] = page;
            ChartBridgeBars.PlanOnce(null);
            Check(Made().Count == 0, "a chart is loading its history: nothing is asked for");
            page.Ready = true;

            ChartBridgeBars.PlanOnce(null);
            List<BarsRequest> made = Made();
            List<string> bodies; lock (desk.Bodies) bodies = desk.Bodies.ToList();
            Check(made.Count == 11 && bodies.Count == 11, "connected, 17:06 ET: 5 sessions x MNQ and ES, plus MNQ 09-26 traded today: 11 requests, 11 messages (" + made.Count + ", " + bodies.Count + ")");
            Check(made.All(r => r.BarsPeriod.BarsPeriodType == BarsPeriodType.Minute && r.BarsPeriod.Value == 1 && r.BarsPeriod.MarketDataType == MarketDataType.Last
                                && r.MergePolicy == MergePolicy.DoNotMerge && r.TradingHours != null && r.TradingHours.Name == "CME US Index Futures ETH"),
                  "every request: 1 minute, Last, DoNotMerge, the instrument's trading hours");
            BarsRequest today = made[0];
            Check(today.Instrument.FullName == "MNQ 12-26" && today.From == D(2026, 9, 28) && today.To == W(2026, 9, 30, 16, 6),
                  "the first request: MNQ 12-26, from the day before the session's open (NinjaTrader's dates) to now: " + today.From + " to " + today.To);
            Check(made.All(r => r.To <= W(2026, 9, 30, 16, 6)), "no request ends past now");
            string first = bodies[0];
            MatchCollection ts = Regex.Matches(first, "\\[(\\d{13}),");
            List<long> t = ts.Cast<Match>().Select(m => long.Parse(m.Groups[1].Value)).ToList();
            bool sorted = true; for (int i = 1; i < t.Count; i++) if (t[i] <= t[i - 1]) sorted = false;
            Check(first.StartsWith("{\"v\":1,\"source\":\"chartbridge\",\"bridge\":\"0.3.6-pre\",\"pc\":\"HOME\",\"contract\":\"MNQ 12-26\",\"root\":\"MNQ\",\"tick\":0.25,\"session\":\"2026-09-30\",\"tf\":\"1m\",\"stamp\":\"open\",\"bars\":[[")
                  && first.EndsWith("]],\"complete\":true}"), "the first message: today's MNQ 12-26: " + first.Substring(0, 200));
            Check(t.Count == 1380 && sorted && t[0] == Ms(Utc(2026, 9, 29, 22, 0)) && t[t.Count - 1] == Ms(Utc(2026, 9, 30, 20, 59)), "1380 bars, sorted, 18:00 ET to the 16:59 ET open (" + t.Count + ")");
            Check(bodies.Any(b => b.Contains("\"contract\":\"MNQ 09-26\"") && b.Contains("\"session\":\"2026-09-30\"")) && !bodies.Any(b => b.Contains("\"contract\":\"MNQ 09-26\"") && !b.Contains("\"session\":\"2026-09-30\"")),
                  "MNQ 09-26 (a fill today) is sent for today only");
            Check(string.Join(",", bodies.Where(b => b.Contains("\"contract\":\"ES 12-26\"")).Select(b => Regex.Match(b, "\"session\":\"([^\"]+)\"").Groups[1].Value)) == "2026-09-30,2026-09-29,2026-09-28,2026-09-25,2026-09-24",
                  "ES: the last 5 sessions, newest first");
            Check(!bodies.Any(b => b.Contains("SimHarness") || b.Contains("account")), "no account in any message");
            bool leaked; lock (NinjaTrader.Code.Output.Lines) leaked = NinjaTrader.Code.Output.Lines.Any(x => x.Contains("SimHarness"));
            Check(!leaked, "no account name in the Output window");
            Check(ChartBridgeBars.DiagJson().Contains("\"MNQ 12-26\":\"2026-09-30\"") && ChartBridgeBars.DiagJson().Contains("\"waiting\":0"), "/diag: " + ChartBridgeBars.DiagJson());

            lock (BarsRequest.Made) BarsRequest.Made.Clear();
            ChartBridgeBars.PlanOnce(null);
            Check(Made().Count == 0, "the next pass asks for nothing: all sent");
            ChartBridgeBarsQueue.Load();   // a restart
            ChartBridgeBars.PlanOnce(null);
            Check(Made().Count == 0, "after a restart, sent_bars.txt says they are done");

            // the next day, before its close: nothing new; after it: only the new session
            ChartBridgeBars.UtcNow = () => Utc(2026, 10, 1, 20, 0);
            ChartBridgeBars.PlanOnce(null);
            Check(Made().Count == 0, "the next day at 16:00 ET: nothing new yet");
            ChartBridgeBars.UtcNow = () => Utc(2026, 10, 1, 21, 6);
            ChartBridgeBars.PlanOnce(null);
            Check(Made().Count == 2 && Made().All(r => r.To == W(2026, 10, 1, 16, 6)), "after its close: only that session, MNQ and ES (" + Made().Count + ")");

            // no answer from NinjaTrader: logged, tried again later, never thrown
            ChartBridgeBars.UtcNow = () => Utc(2026, 10, 2, 21, 6);
            BarsRequest.AutoAnswer = r => false;
            ChartBridgeBars.RequestTimeoutMs = 200;
            lock (BarsRequest.Made) BarsRequest.Made.Clear();
            ChartBridgeBars.PlanOnce(null);
            Check(Made().Count == 2 && ChartBridgeBars.DiagJson().Contains("did not answer within"), "no answer: given up after the timeout, both roots, /diag says so");
            ChartBridgeBars.PlanOnce(null);
            Check(Made().Count == 2, "and not asked again before the retry time");
            BarsRequest.AutoAnswer = AnswerLikeNt;
            ChartBridgeBars.UtcNow = () => Utc(2026, 10, 2, 21, 30);
            ChartBridgeBars.PlanOnce(null);
            Check(Made().Count == 4 && ChartBridgeBarsQueue.IsDone("2026-10-02 MNQ 12-26"), "15 minutes later: asked again and sent");

            // an error answer, an empty answer, an unknown contract
            ChartBridgeBars.UtcNow = () => Utc(2026, 10, 5, 21, 6);
            BarsRequest.AutoAnswer = r => { r.Answer(new Bars(), r.Instrument.FullName.StartsWith("ES") ? ErrorCode.Panic : ErrorCode.NoError); return true; };
            ChartBridgeBars.PlanOnce(null);
            string d = ChartBridgeBars.DiagJson();
            Check(!ChartBridgeBarsQueue.IsWaiting("2026-10-05 ES 12-26") && !ChartBridgeBarsQueue.IsWaiting("2026-10-05 MNQ 12-26"), "an error or an empty answer queues nothing");
            bool both; lock (NinjaTrader.Code.Output.Lines) both = NinjaTrader.Code.Output.Lines.Any(x => x.Contains("ES 12-26 session 2026-10-05: NinjaTrader refused the request"))
                                                                   && NinjaTrader.Code.Output.Lines.Any(x => x.Contains("MNQ 12-26 session 2026-10-05: NinjaTrader has no 1-minute bars"));
            Check(both, "each is logged");
            ChartBridgeBars.Lookup = name => null;
            ChartBridgeBars.UtcNow = () => Utc(2026, 10, 6, 21, 6);
            ChartBridgeBars.PlanOnce(null);
            bool unknown; lock (NinjaTrader.Code.Output.Lines) unknown = NinjaTrader.Code.Output.Lines.Any(x => x.Contains("session 2026-10-06: NinjaTrader does not know the instrument"));
            Check(unknown, "an instrument NinjaTrader does not know is logged, not thrown");

            // a full holiday of the instrument's template is not asked for
            ChartBridgeBars.Lookup = name => Inst(name);
            Instrument chartInst = Inst("MNQ 12-26");
            chartInst.MasterInstrument.TradingHours.Holidays[D(2026, 12, 25)] = "Christmas";
            Dictionary<string, Instrument> instruments = (Dictionary<string, Instrument>)typeof(ChartBridgeServer).GetField("Instruments", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
            instruments["MNQ"] = chartInst;
            BarsRequest.AutoAnswer = AnswerLikeNt;
            ChartBridgeBars.UtcNow = () => Utc(2026, 12, 28, 15, 0);
            lock (BarsRequest.Made) BarsRequest.Made.Clear();
            ChartBridgeBars.PlanOnce(null);
            List<string> asked = Made().Select(r => r.Instrument.FullName + " " + r.To.ToString("MM-dd")).ToList();
            Check(Made().Count == 10 && Made().All(r => r.Instrument.FullName.EndsWith(" 03-27")) && !asked.Any(a => a.EndsWith(" 12-26")) && ChartBridgeBarsQueue.IsDone("2026-12-24 MNQ 03-27") && ChartBridgeBarsQueue.IsDone("2026-12-18 ES 03-27"),
                  "Monday 12-28: Christmas (a full holiday of the template) is skipped, 12-18 to 12-24 are asked, all in 03-27 (rolled Dec 10): " + string.Join(", ", asked));
            instruments.Remove("MNQ");
            clients.TryRemove(91, out page);

            // the worker: its own background thread, below normal priority; Stop ends it
            string server = (string)typeof(ChartBridgeServer).GetMethod("DiagJson", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null);
            Check(server.Contains(",\"bars\":{\"enabled\":true,"), "GET /diag has the bars section");
            ChartBridgeBars.TickMs = 50; ChartBridgeBars.SettleMs = 0; ChartBridgeBars.PlanEveryMs = 0;
            ChartBridgeBars.UtcNow = () => Utc(2027, 1, 6, 22, 30);   // 17:30 ET, a new session due
            lock (BarsRequest.Made) BarsRequest.Made.Clear();
            Thread worker = null;
            BarsRequest.AutoAnswer = r => { worker = Thread.CurrentThread; return AnswerLikeNt(r); };
            ChartBridgeBars.Start();
            DateTime until = DateTime.UtcNow.AddSeconds(10);
            while (!ChartBridgeBarsQueue.IsDone("2027-01-06 MNQ 03-27") && DateTime.UtcNow < until) Thread.Sleep(20);
            Check(ChartBridgeBarsQueue.IsDone("2027-01-06 MNQ 03-27") && worker != null && worker.IsBackground && worker.Priority == ThreadPriority.BelowNormal && worker.Name == "ChartBridge bars",
                  "the worker asks and sends on its own background thread at below-normal priority");
            ChartBridgeBars.Stop();
            Thread.Sleep(300);
            Check(worker != null && !worker.IsAlive, "Stop ends the worker");
        }
        finally
        {
            BarsRequest.AutoAnswer = null;
            desk.Stop();
            Account.All.Remove(acct);
            ChartBridgeBars.ResetConfig();
            NtZone(null);
        }
    }
}
