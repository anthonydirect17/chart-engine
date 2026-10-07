// ChartBridge daily 1-minute bars to The Desk (0.3.6), for NinjaTrader 8.
// OFF unless config.txt has "bars = on". Contract v1 (2026-09-30, approved by Anthony): after each CME session
// closes (17:00 New York time, plus a few minutes), and at ChartBridge's start for any of the last 5 sessions not sent
// yet, ChartBridge copies that session's finished 1-minute bars for NQ, MNQ, ES and MES (the front month the chart
// uses, plus any other contract of that root with fills that session) out of NinjaTrader's own historical data
// (BarsRequest, 1 minute, Last) and posts one message per contract per session to The Desk's POST /api/bars.
// Messages wait in pending_bars.jsonl next to pending_fills.jsonl until The Desk takes them (the fills queue's rules:
// 10 second requests, retried every 10 seconds, a message The Desk calls malformed is set aside in
// rejected_bars.jsonl); sessions The Desk took are noted in sent_bars.txt so the catch-up knows what is done.
// Only market data and the PC name leave this PC: no account, no PIN, no token.
// This file never places, changes or cancels an order and never touches the order lane. Its work runs on a background
// thread of its own at below-normal priority, and its requests go to NinjaTrader through the 0.3.5 gate in ChartBridge.cs
// (ChartBridgeServer.GateBars), last of all: queued only when no Range window, session backfill, minute chart's last trades
// or page load is out, queued or still to come; one at a time, so never beside a window or a backfill (one asked meanwhile
// waits behind it). Stop() ends it with nothing more asked or sent (as the gate's StopGate). In regular trading hours (09:30 to
// 16:15 New York time) it asks for nothing, except the catch-up after a start once the charts have settled. Every failure
// or timeout is logged and tried again later (3 tries, then not until the next start), never thrown into NinjaTrader.
//
// NinjaTrader 8 help used (ninjatrader.com/support/helpGuides/nt8/):
//   barsrequest.htm (from/to are turned into whole trading days; Request, Bars, Dispose), request.htm,
//   barsrequest_mergepolicy.htm (DoNotMerge: the named contract's own data), barsperiod.htm (Minute, Value, MarketDataType.Last),
//   tradinghours.htm and holidays.htm (the template's full holidays), how_bars_are_built.htm (a bar is stamped with its
//   CLOSING time), gettime.htm, bars.htm, connection_class.htm (Connection.Connections, PriceStatus, ConnectionStatus),
//   getinstrument.htm, instrument.htm (FullName, MasterInstrument), masterinstrument.htm (Name, TickSize),
//   executions.htm (the current session's executions only), general_section.htm (NinjaTrader's time zone setting).
//
// Written in C# 5 syntax on purpose so it compiles on every NinjaTrader 8 release.

#region Using declarations
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    // One finished 1-minute bar as The Desk gets it: T is the bar's OPEN time, Unix milliseconds UTC.
    public struct DeskBar
    {
        public long T;
        public double O, H, L, C;
        public long V;
    }

    // One contract of one session to fetch.
    public class BarsJob
    {
        public DateTime Session;   // the session date (the New York date it ends on)
        public string Root, Contract;
        public string Key { get { return ChartBridgeBars.KeyOf(Session, Contract); } }
    }

    public static class ChartBridgeBars
    {
        private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        // ---------------------------------------------------------- settings (config.txt)
        //   bars = on                     (send each session's 1-minute bars to The Desk; OFF by default)
        //   barsRoots = NQ, MNQ, ES, MES  (the roots whose bars are sent; these by default)
        //   pc = HOME                     (this PC's name in the messages; the Windows computer name by default)
        public static bool Enabled;
        public static string[] Roots = DefaultRoots();
        public static string Pc = "";

        private static string[] DefaultRoots() { return new string[] { "NQ", "MNQ", "ES", "MES" }; }

        public static void ResetConfig() { Enabled = false; Roots = DefaultRoots(); Pc = ""; }

        // Called by ChartBridgeConfig.Load; true when the key is one of these.
        public static bool ReadConfig(string key, string val)
        {
            if (key == "bars")
            {
                string v = (val ?? "").Trim().ToLowerInvariant();
                Enabled = v == "on" || v == "true" || v == "1";
                return true;
            }
            if (key == "barsRoots")
            {
                string[] r = (val ?? "").Split(',').Select(s => s.Trim().ToUpperInvariant()).Where(s => s.Length > 0).Distinct().ToArray();
                if (r.Length > 0) Roots = r;
                return true;
            }
            if (key == "pc") { Pc = CleanPc(val); return true; }
            return false;
        }

        private static string CleanPc(string s)
        {
            StringBuilder b = new StringBuilder();
            foreach (char ch in (s ?? "").Trim()) { if (b.Length >= 64) break; if (ch >= 0x20 && ch != 0x7f) b.Append(ch); }
            return b.ToString();
        }

        public static string PcName()
        {
            if (!string.IsNullOrEmpty(Pc)) return Pc;
            try { return CleanPc(Environment.MachineName); } catch (Exception) { return ""; }
        }

        // ---------------------------------------------------------- timing (fields, not constants, so the harness can shorten them)
        public static int CatchUpSessions = 5;              // the last 5 sessions
        public static TimeSpan CloseDelay = TimeSpan.FromMinutes(5);   // after 17:00 New York time, for NinjaTrader to finish the last bar
        public static int TickMs = 10000;                   // the queue is retried every 10 s, like fills
        public static int PlanEveryMs = 60000;              // what is due is looked at once a minute
        public static int SettleMs = 120000;                // nothing is asked for in the first 2 minutes after the start (the charts load first)
        public static int RequestTimeoutMs = 60000;         // the gate's time limit for one request (one contract's minutes, about a second)
        public static int QueueWaitMs = 60000;              // a request queued at the gate that has not gone out in this long is taken back
        public static int RetryMinutes = 15;                // a failed or empty request is tried again after this long
        public static int MaxTries = 3;                     // then not again until ChartBridge restarts (a day NinjaTrader has no bars for)
        public static int PauseBetweenMs = 2000;            // between two requests
        public static int StopJoinMs = 250;                 // Stop() runs on NinjaTrader's thread: it waits this long for the worker

        // Test hooks (the stand-ins for NinjaTrader in nt8/check); NinjaTrader's own by default.
        public static Func<DateTime> UtcNow = () => DateTime.UtcNow;
        public static Func<bool> IsConnected = DefaultConnected;
        public static Func<string, Instrument> Lookup = name => Instrument.GetInstrument(name);

        // ---------------------------------------------------------- the session (pure; nt8/check/BarsHarness.cs)
        // A CME session runs 18:00 New York time (the previous calendar day) to 17:00; its date is the New York date it
        // ends on. The Sunday 18:00 open belongs to Monday. Returns the session date for a New York wall time, or
        // DateTime.MinValue when the market is shut then (the 17:00 to 18:00 break, Friday 17:00 to Sunday 18:00).
        public static DateTime SessionDateOfEt(DateTime et)
        {
            DateTime d = et.Date;
            TimeSpan tod = et.TimeOfDay;
            if (tod >= TimeSpan.FromHours(18)) d = d.AddDays(1);
            else if (tod >= TimeSpan.FromHours(17)) return DateTime.MinValue;
            if (d.DayOfWeek == DayOfWeek.Saturday || d.DayOfWeek == DayOfWeek.Sunday) return DateTime.MinValue;
            return DateTime.SpecifyKind(d, DateTimeKind.Unspecified);
        }

        // The session's bounds in UTC: [18:00 New York the day before, 17:00 New York on the day). Daylight saving comes from
        // the time zone (it changes at 2 AM on a Sunday, when the market is shut, so a session is always 23 hours).
        public static void SessionUtc(DateTime session, out DateTime openUtc, out DateTime closeUtc)
        {
            DateTime d = DateTime.SpecifyKind(session.Date, DateTimeKind.Unspecified);
            openUtc = TimeZoneInfo.ConvertTimeToUtc(d.AddDays(-1).AddHours(18), ChartBridgeTime.Eastern);
            closeUtc = TimeZoneInfo.ConvertTimeToUtc(d.AddHours(17), ChartBridgeTime.Eastern);
        }

        // Regular trading hours, 09:30 to 16:15 New York time on a weekday: no bars request then, except the start's catch-up.
        public static bool InRth(DateTime et)
        {
            if (et.DayOfWeek == DayOfWeek.Saturday || et.DayOfWeek == DayOfWeek.Sunday) return false;
            TimeSpan tod = et.TimeOfDay;
            return tod >= new TimeSpan(9, 30, 0) && tod < new TimeSpan(16, 15, 0);
        }

        // NinjaTrader stamps a bar with its CLOSING time, in the time zone set under Tools > Options > General
        // (How Bars are Built). The Desk wants the OPEN time as UTC milliseconds: the stamp to UTC, less one minute.
        public static long OpenUtcMs(DateTime ntCloseStamp)
        {
            return (long)Math.Round(ChartBridgeTime.UtcMs(ChartBridgeTime.ToUtc(ntCloseStamp))) - 60000L;
        }

        // The finished bars of `raw` (NinjaTrader's close stamps) inside the session and closed by nowUtc, sorted by open
        // time, one per minute (a repeated minute keeps NinjaTrader's later row).
        public static List<DeskBar> SessionBars(RawBars raw, DateTime session, DateTime nowUtc)
        {
            DateTime openUtc, closeUtc;
            SessionUtc(session, out openUtc, out closeUtc);
            long from = (long)Math.Round(ChartBridgeTime.UtcMs(openUtc)), to = (long)Math.Round(ChartBridgeTime.UtcMs(closeUtc));
            long now = (long)Math.Floor(ChartBridgeTime.UtcMs(DateTime.SpecifyKind(nowUtc, DateTimeKind.Utc)));
            SortedDictionary<long, DeskBar> byT = new SortedDictionary<long, DeskBar>();
            if (raw == null || raw.Open == null) return new List<DeskBar>();
            for (int i = 0; i < raw.Count; i++)
            {
                long t = OpenUtcMs(raw.Time[i]);
                if (t < from || t + 60000L > to || t + 60000L > now) continue;   // outside the session, or not finished
                byT[t] = new DeskBar { T = t, O = raw.Open[i], H = raw.High[i], L = raw.Low[i], C = raw.Close[i], V = raw.Volume[i] };
            }
            return byT.Values.ToList();
        }

        // The last `count` sessions that have closed (17:00 New York plus CloseDelay) by nowEt, newest first: weekdays that
        // are not a full holiday of the trading hours template. Early closes are ordinary sessions (they just end sooner).
        public static List<DateTime> RecentSessions(DateTime nowEt, int count, Func<DateTime, bool> isHoliday)
        {
            List<DateTime> list = new List<DateTime>();
            DateTime d = nowEt.Date;
            if (nowEt < d.AddHours(17).Add(CloseDelay)) d = d.AddDays(-1);
            for (int i = 0; i < 40 && list.Count < count; i++, d = d.AddDays(-1))
            {
                if (d.DayOfWeek == DayOfWeek.Saturday || d.DayOfWeek == DayOfWeek.Sunday) continue;
                bool holiday = false;
                try { holiday = isHoliday != null && isHoliday(d); } catch (Exception) { holiday = false; }
                if (!holiday) list.Add(DateTime.SpecifyKind(d, DateTimeKind.Unspecified));
            }
            return list;
        }

        // The contract the chart uses for a root in that session: contract.<ROOT> from config.txt if set, else the front
        // month by the chart's own roll rule (ChartBridgeServer.FrontMonth, 8 days before expiry) on the session's date
        // (0.4.0: the root's own roll for a market that is not an equity index, ChartBridgeMarkets; the same for MNQ, NQ, ES, MES).
        public static string FrontContract(string root, DateTime session)
        {
            string name;
            if (ChartBridgeConfig.ContractOverride.TryGetValue(root, out name)) return name;
            return root + " " + ChartBridgeMarkets.FrontMonth(root, session.Date);
        }

        public static string KeyOf(DateTime session, string contract) { return session.ToString("yyyy-MM-dd", Inv) + " " + contract; }

        // What each session needs, newest session first: every root's front month, then any other contract of a root
        // that had fills in that session (`fills`: their session, root and contract). No duplicates.
        public static List<BarsJob> Wanted(List<DateTime> sessions, string[] roots, List<BarsJob> fills)
        {
            List<BarsJob> list = new List<BarsJob>();
            HashSet<string> seen = new HashSet<string>();
            foreach (DateTime s in sessions)
            {
                foreach (string root in roots)
                {
                    BarsJob j = new BarsJob { Session = s, Root = root, Contract = FrontContract(root, s) };
                    if (seen.Add(j.Key)) list.Add(j);
                }
                if (fills == null) continue;
                foreach (BarsJob f in fills)
                    if (f.Session == s && roots.Contains(f.Root) && seen.Add(f.Key)) list.Add(f);
            }
            return list;
        }

        // One message for The Desk (contract v1). Market data and the PC name only.
        public static string MessageJson(string contract, string root, double tick, DateTime session, List<DeskBar> bars)
        {
            StringBuilder b = new StringBuilder(256 + bars.Count * 56);
            b.Append("{\"v\":1,\"source\":\"chartbridge\",\"bridge\":").Append(CbJson.Str(ChartBridgeServer.Version))
             .Append(",\"pc\":").Append(CbJson.Str(PcName()))
             .Append(",\"contract\":").Append(CbJson.Str(contract))
             .Append(",\"root\":").Append(CbJson.Str(root))
             .Append(",\"tick\":").Append(CbJson.Num(tick))
             .Append(",\"session\":").Append(CbJson.Str(session.ToString("yyyy-MM-dd", Inv)))
             .Append(",\"tf\":\"1m\",\"stamp\":\"open\",\"bars\":[");
            for (int i = 0; i < bars.Count; i++)
            {
                DeskBar x = bars[i];
                if (i > 0) b.Append(',');
                b.Append('[').Append(x.T.ToString(Inv)).Append(',').Append(CbJson.Num(x.O)).Append(',').Append(CbJson.Num(x.H)).Append(',')
                 .Append(CbJson.Num(x.L)).Append(',').Append(CbJson.Num(x.C)).Append(',').Append(x.V.ToString(Inv)).Append(']');
            }
            b.Append("],\"complete\":true}");
            return b.ToString();
        }

        // ---------------------------------------------------------- NinjaTrader
        // True when some connection's price feed is Connected (Connection.Connections, PriceStatus).
        private static bool DefaultConnected()
        {
            try
            {
                lock (Connection.Connections)
                    foreach (Connection c in Connection.Connections)
                        if (c != null && c.PriceStatus == ConnectionStatus.Connected) return true;
            }
            catch (Exception) { }
            return false;
        }

        // Full holidays of the trading hours template the chart uses (TradingHours.Holidays), by date.
        private static HashSet<DateTime> Holidays()
        {
            HashSet<DateTime> days = new HashSet<DateTime>();
            try
            {
                foreach (string root in Roots)
                {
                    Instrument inst = ChartBridgeServer.InstrumentFor(root);
                    if (inst == null || inst.MasterInstrument == null || inst.MasterInstrument.TradingHours == null) continue;
                    foreach (KeyValuePair<DateTime, string> h in inst.MasterInstrument.TradingHours.Holidays) days.Add(h.Key.Date);
                    break;
                }
            }
            catch (Exception) { }
            return days;
        }

        // Contracts of our roots with fills in these sessions, from the watched accounts' executions. NinjaTrader keeps the
        // current session's executions only (executions.htm), so after a restart older sessions get the front month only.
        // Only the instrument and time of each fill are read; nothing about the account is kept.
        private static List<BarsJob> FillJobs(List<DateTime> sessions)
        {
            List<BarsJob> list = new List<BarsJob>();
            try
            {
                List<Account> accounts;
                lock (Account.All) accounts = Account.All.ToList();
                foreach (Account a in accounts)
                {
                    if (a == null || !ChartBridgeConfig.AccountAllowed(a.Name)) continue;
                    List<Execution> xs;
                    try { lock (a.Executions) xs = a.Executions.ToList(); } catch (Exception) { continue; }
                    foreach (Execution x in xs)
                    {
                        if (x == null || x.Instrument == null || x.Instrument.MasterInstrument == null) continue;
                        string root = (x.Instrument.MasterInstrument.Name ?? "").ToUpperInvariant();
                        DateTime s = SessionDateOfEt(TimeZoneInfo.ConvertTimeFromUtc(ChartBridgeTime.ToUtc(x.Time), ChartBridgeTime.Eastern));
                        if (!sessions.Contains(s)) continue;
                        list.Add(new BarsJob { Session = s, Root = root, Contract = x.Instrument.FullName });
                    }
                }
            }
            catch (Exception ex) { Note("could not read fills for the bars' contracts: " + ex.Message); }
            return list;
        }

        // ---------------------------------------------------------- the worker
        private static readonly object Gate = new object();
        private static ManualResetEvent stopEvent;
        private static Thread worker;
        private static int generation;
        private static readonly Dictionary<string, DateTime> RetryAt = new Dictionary<string, DateTime>();   // key -> not before (UTC)
        private static readonly Dictionary<string, int> Tries = new Dictionary<string, int>();               // key -> failed tries this run
        private static readonly HashSet<string> GaveUp = new HashSet<string>();                             // not asked again this run
        private static readonly Dictionary<string, string> LoggedFailure = new Dictionary<string, string>();
        private static volatile string fetchError = "", lastRequest = "", state = "off", waitingForGate;
        private static volatile bool catchUpDone;            // the start's catch-up has been through every session once

        public static void Start()
        {
            Stop();
            lock (Gate)
            {
                lock (RetryAt) { RetryAt.Clear(); Tries.Clear(); GaveUp.Clear(); LoggedFailure.Clear(); }
                fetchError = ""; lastRequest = ""; waitingForGate = null; catchUpDone = false;
                state = Enabled ? "starting" : "off";
                if (!Enabled) return;
                try
                {
                    // bars N7 (0.3.7): pending_bars.jsonl, sent_bars.txt and refused_bars.txt are read on the bars thread
                    // (Run), not here: Start runs on NinjaTrader's thread.
                    ManualResetEvent stop = new ManualResetEvent(false);
                    stopEvent = stop;
                    int gen = ++generation;
                    Thread t = new Thread(() => Run(gen, stop));
                    t.IsBackground = true;
                    t.Priority = ThreadPriority.BelowNormal;
                    t.Name = "ChartBridge bars";
                    worker = t;
                    t.Start();
                }
                catch (Exception ex) { Note("daily bars could not start: " + ex.Message); }
            }
        }

        // Nothing more is asked of NinjaTrader or sent to The Desk after this returns: the worker leaves any wait at once, a
        // post in flight is aborted (the message stays queued; The Desk stores a resend once), and an answer that comes later is
        // not copied. Runs on NinjaTrader's thread, so it waits StopJoinMs (250 ms) for the worker at most, as the gate's Stop.
        public static void Stop()
        {
            Thread t;
            lock (Gate)
            {
                generation++;
                try { if (stopEvent != null) stopEvent.Set(); } catch (Exception) { }
                stopEvent = null;
                t = worker; worker = null;
                if (t != null) state = "stopped";
            }
            ChartBridgeBarsQueue.Abort();
            try
            {
                if (t != null && t != Thread.CurrentThread && !t.Join(StopJoinMs))
                    ChartBridgeServer.Log("the bars worker did not end within " + StopJoinMs + " ms of the stop; it ends on its own and sends nothing more");
            }
            catch (Exception) { }
        }

        private static bool Stopping(int gen, ManualResetEvent stop) { return gen != Volatile.Read(ref generation) || stop.WaitOne(0); }

        private static void Run(int gen, ManualResetEvent stop)
        {
            Func<bool> stopping = () => Stopping(gen, stop);
            System.Diagnostics.Stopwatch since = System.Diagnostics.Stopwatch.StartNew();
            if (stopping()) return;
            try
            {
                ChartBridgeBarsQueue.Load();   // bars N7: off NinjaTrader's thread
                ChartBridgeServer.Log("daily 1-minute bars go to The Desk after each close (bars = on): " + string.Join(", ", Roots) +
                    "; " + ChartBridgeBarsQueue.Waiting() + " message(s) waiting in pending_bars.jsonl");
            }
            catch (Exception ex) { Note("daily bars could not read their files: " + ex.Message); }
            long lastPlan = long.MinValue / 2;
            state = "starting: the charts load first";
            while (!stop.WaitOne(TickMs))
            {
                if (stopping()) return;
                try { ChartBridgeBarsQueue.Flush(stopping); } catch (Exception ex) { Note("bars send error: " + ex.Message); }
                long now = since.ElapsedMilliseconds;
                if (now < SettleMs || now - lastPlan < PlanEveryMs) continue;
                lastPlan = now;
                try { PlanOnce(stopping); } catch (Exception ex) { Note("bars error: " + ex.Message); }
            }
        }

        private static bool Nap(int ms, Func<bool> stopping)
        {
            for (int left = ms; left > 0; left -= 50) { if (stopping != null && stopping()) return true; Thread.Sleep(Math.Min(50, left)); }
            return stopping != null && stopping();
        }

        // One look at what is due; asks NinjaTrader for it one contract at a time, through the gate. Public for the harness.
        public static void PlanOnce(Func<bool> stopping)
        {
            if (stopping == null) stopping = () => false;
            if (!Enabled) { state = "off"; return; }
            if (!IsConnected()) { state = "waiting: NinjaTrader has no price connection"; return; }   // tried again next minute
            DateTime nowUtc = UtcNow();
            DateTime nowEt = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(nowUtc, DateTimeKind.Utc), ChartBridgeTime.Eastern);
            if (catchUpDone && InRth(nowEt)) { state = "waiting: regular trading hours (after 16:15 ET)"; waitingForGate = null; return; }
            HashSet<DateTime> holidays = Holidays();
            List<DateTime> sessions = RecentSessions(nowEt, CatchUpSessions, d => holidays.Contains(d.Date));
            bool first = true;
            foreach (BarsJob j in Wanted(sessions, Roots, FillJobs(sessions)))
            {
                if (stopping()) return;
                if (ChartBridgeBarsQueue.IsDone(j.Key) || ChartBridgeBarsQueue.IsWaiting(j.Key) || ChartBridgeBarsQueue.IsRefused(j.Key)) continue;   // bars N1: a refusal is remembered across restarts
                DateTime notBefore;
                lock (RetryAt)
                {
                    if (GaveUp.Contains(j.Key)) continue;
                    if (RetryAt.TryGetValue(j.Key, out notBefore) && UtcNow() < notBefore) continue;
                }
                if (!first && PauseBetweenMs > 0 && Nap(PauseBetweenMs, stopping)) return;
                first = false;
                Outcome o = Fetch(j, stopping);
                if (o == Outcome.Stopped) return;
                if (o == Outcome.Wait) return;   // the gate is busy: this pass ends, the next minute tries again
                try { ChartBridgeBarsQueue.Flush(stopping); } catch (Exception ex) { Note("bars send error: " + ex.Message); }
            }
            catchUpDone = true;
            waitingForGate = null;
            state = "idle";
        }

        // A later try for this job (MaxTries in all, then not until ChartBridge restarts), and one Output line per job and reason.
        private static void Later(BarsJob j, string why)
        {
            fetchError = j.Key + ": " + why;
            bool log, gaveUp;
            lock (RetryAt)
            {
                int n;
                Tries.TryGetValue(j.Key, out n);
                Tries[j.Key] = ++n;
                gaveUp = n >= MaxTries;
                if (gaveUp) GaveUp.Add(j.Key); else RetryAt[j.Key] = UtcNow().AddMinutes(RetryMinutes);
                string was;
                log = gaveUp || !LoggedFailure.TryGetValue(j.Key, out was) || was != why;
                LoggedFailure[j.Key] = why;
            }
            if (log) ChartBridgeServer.Log("bars for " + j.Contract + " session " + j.Session.ToString("yyyy-MM-dd", Inv) + ": " + why +
                (gaveUp ? "; tried " + MaxTries + " times, not asked again until ChartBridge restarts" : "; trying again in " + RetryMinutes + " minutes"));
        }

        // The Desk set this message aside: not asked for again until the next start.
        public static void SkipThisRun(string key) { lock (RetryAt) GaveUp.Add(key); }

        private static void Note(string text) { fetchError = text; ChartBridgeServer.Log(text); }

        private enum Outcome { Done, Later, Wait, Stopped }

        // Ask NinjaTrader, through the gate, for the job's contract, 1-minute Last bars, whole trading days around the session
        // (BarsRequest turns from and to into whole trading days), then keep the session's own finished minutes.
        private static Outcome Fetch(BarsJob j, Func<bool> stopping)
        {
            Instrument inst = null;
            try { inst = Lookup(j.Contract); } catch (Exception) { inst = null; }
            if (inst == null || inst.MasterInstrument == null) { Later(j, "NinjaTrader does not know the instrument"); return Outcome.Later; }
            DateTime nowUtc = UtcNow(), openUtc, closeUtc;
            SessionUtc(j.Session, out openUtc, out closeUtc);
            TimeZoneInfo ntZone = NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo;   // BarsRequest takes NinjaTrader's times
            DateTime fromNt = TimeZoneInfo.ConvertTimeFromUtc(openUtc, ntZone).Date.AddDays(-1);
            DateTime toNt = TimeZoneInfo.ConvertTimeFromUtc(closeUtc, ntZone).Date.AddDays(1);
            DateTime nowNt = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(nowUtc, DateTimeKind.Utc), ntZone);
            if (toNt > nowNt) toNt = nowNt;   // never past now

            BarsTicket t = new BarsTicket();
            string busy = ChartBridgeServer.GateBars(j.Key, inst, fromNt, toNt, RequestTimeoutMs, stopping, t);
            if (busy != null) { waitingForGate = busy; state = "waiting for the gate: " + busy; return Outcome.Wait; }
            waitingForGate = null;
            state = "asking NinjaTrader: " + j.Key;
            lastRequest = j.Key + " at " + nowUtc.ToString("yyyy-MM-dd HH:mm:ss", Inv) + " UTC";
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            long giveUpMs = (long)QueueWaitMs + RequestTimeoutMs + ChartBridgeServer.AnswerCopyMs + 5000;
            while (!t.Done.Wait(50))
            {
                if (stopping()) { ChartBridgeServer.GateBarsWithdraw(t); return Outcome.Stopped; }
                if (!t.Started && sw.ElapsedMilliseconds > QueueWaitMs && ChartBridgeServer.GateBarsWithdraw(t))
                {
                    waitingForGate = "the request did not go out within " + (QueueWaitMs / 1000) + " s (the chart's requests went first)";
                    state = "waiting for the gate: " + waitingForGate;
                    return Outcome.Wait;
                }
                if (sw.ElapsedMilliseconds > giveUpMs) { Later(j, "no answer from the gate"); return Outcome.Later; }
            }
            if (stopping()) return Outcome.Stopped;
            if (t.GateStuck) { waitingForGate = t.Error; state = "waiting for the gate: " + t.Error; return Outcome.Wait; }
            if (t.Error != null) { Later(j, t.Error); return Outcome.Later; }
            List<DeskBar> bars = SessionBars(t.Raw, j.Session, UtcNow());
            if (bars.Count == 0) { Later(j, "NinjaTrader has no 1-minute bars for it"); return Outcome.Later; }
            if (stopping()) return Outcome.Stopped;   // nothing is queued after a stop
            string root = (inst.MasterInstrument.Name ?? j.Root).ToUpperInvariant();
            ChartBridgeBarsQueue.Queue(j.Key, MessageJson(inst.FullName, root, inst.MasterInstrument.TickSize, j.Session, bars));
            lock (RetryAt) { RetryAt.Remove(j.Key); Tries.Remove(j.Key); LoggedFailure.Remove(j.Key); }
            fetchError = "";
            ChartBridgeServer.Log("bars for " + inst.FullName + " session " + j.Session.ToString("yyyy-MM-dd", Inv) + ": " + bars.Count + " minutes queued for The Desk");
            return Outcome.Done;
        }

        // /diag "bars": enabled, what it is doing (and what it waits for at the gate), the last session The Desk took per contract,
        // the queue, what was set aside or given up, the last problem.
        public static string DiagJson()
        {
            string err = ChartBridgeBarsQueue.SendError();
            if (err.Length == 0) err = fetchError ?? "";
            int gaveUp; lock (RetryAt) gaveUp = GaveUp.Count;
            string wait = waitingForGate;
            return "{\"enabled\":" + (Enabled ? "true" : "false") +
                ",\"state\":" + CbJson.Str(state ?? "") +
                ",\"waitingForGate\":" + (wait != null ? CbJson.Str(wait) : "null") +
                ",\"roots\":[" + string.Join(",", Roots.Select(r => CbJson.Str(r)).ToArray()) + "]" +
                ",\"lastSent\":" + ChartBridgeBarsQueue.LastSentJson() +
                ",\"waiting\":" + ChartBridgeBarsQueue.Waiting() +
                ",\"setAside\":" + ChartBridgeBarsQueue.SetAsideCount() +
                ",\"gaveUp\":" + gaveUp +
                ",\"lastRequest\":" + CbJson.Str(lastRequest ?? "") +
                ",\"lastError\":" + CbJson.Str(err) + "}";
        }
    }

    // One daily bars request at the gate (ChartBridgeServer.GateBars): its answer copied on NinjaTrader's thread, or why not.
    public class BarsTicket
    {
        public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);
        public volatile bool Started;      // it went to NinjaTrader (it can no longer be taken back)
        public volatile bool GateStuck;    // it waited at the gate while another request was not answered: asked again later
        public RawBars Raw;
        public volatile string Error;
        public object Job;                 // the gate's own record of it
    }

    // ------------------------------------------------------------------ the bars queue (the fills queue's rules)
    // Each message is a line of pending_bars.jsonl (next to pending_fills.jsonl), written before it is sent; the file is
    // replaced atomically. One message per request, oldest first, 10 seconds each, to the same deskUrl as fills, with
    // nothing added (The Desk guards POST /api/bars as it guards POST /api/fills). The Desk calling a message malformed
    // (400 or 422) sets it aside in rejected_bars.jsonl, so nothing blocks the queue; anything else leaves it waiting for
    // the next try (every 10 seconds). Sessions The Desk took are noted in sent_bars.txt ("yyyy-MM-dd contract").
    public static class ChartBridgeBarsQueue
    {
        private static readonly object Sync = new object();
        private static readonly List<string> Pending = new List<string>();
        private static readonly List<string> PendingKeys = new List<string>();   // same order as Pending
        private static readonly HashSet<string> Sent = new HashSet<string>();
        private static readonly HashSet<string> Refused = new HashSet<string>();   // bars N1 (0.3.7): sessions The Desk refused, kept KeepSentDays
        private static readonly Regex SessionRx = new Regex("\"session\":\"(\\d{4}-\\d{2}-\\d{2})\"");
        private static readonly Regex ContractRx = new Regex("\"contract\":\"([^\"\\\\]*)\"");
        private static readonly Regex DetailRx = new Regex("\"detail\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        public static int TimeoutMs = 10000;
        public const int KeepSentDays = 40;
        private static int sending;
        private static bool lastFailed;
        private static string sendError = "";
        private static long setAside;

        private static string File_ { get { return Path.Combine(ChartBridgeConfig.Folder, "pending_bars.jsonl"); } }
        private static string SetAsideFile { get { return Path.Combine(ChartBridgeConfig.Folder, "rejected_bars.jsonl"); } }
        private static string SentFile { get { return Path.Combine(ChartBridgeConfig.Folder, "sent_bars.txt"); } }
        private static string RefusedFile { get { return Path.Combine(ChartBridgeConfig.Folder, "refused_bars.txt"); } }

        // "yyyy-MM-dd contract" of a whole message line, or null for a line cut short by a crash mid-write.
        public static string KeyOfLine(string line)
        {
            if (line == null || !line.StartsWith("{\"v\":1,") || !line.EndsWith(",\"complete\":true}")) return null;
            Match s = SessionRx.Match(line), c = ContractRx.Match(line);
            if (!s.Success || !c.Success) return null;
            return s.Groups[1].Value + " " + c.Groups[1].Value;
        }

        public static void Load()
        {
            lock (Sync)
            {
                Pending.Clear(); PendingKeys.Clear(); Sent.Clear(); Refused.Clear();
                sendError = ""; lastFailed = false;
                Interlocked.Exchange(ref setAside, 0);   // /diag: set aside since this start
                int bad = 0, old = 0;
                DateTime cutoff = ChartBridgeBars.UtcNow().Date.AddDays(-KeepSentDays);
                try
                {
                    Directory.CreateDirectory(ChartBridgeConfig.Folder);
                    if (File.Exists(File_))
                        foreach (string raw in File.ReadAllLines(File_))
                        {
                            string line = raw.Trim();
                            if (line.Length == 0) continue;
                            string key = KeyOfLine(line);
                            if (key == null) { bad++; continue; }
                            if (Older(key, cutoff)) { old++; continue; }   // bars N1: never waits longer than the record is kept
                            if (PendingKeys.Contains(key)) continue;
                            Pending.Add(line); PendingKeys.Add(key);
                        }
                }
                catch (Exception ex) { ChartBridgeServer.Log("could not read pending bars: " + ex.Message); }
                if (bad > 0) ChartBridgeServer.Log("skipped " + bad + " unreadable line(s) in pending_bars.jsonl");
                if (old > 0) { ChartBridgeServer.Log("dropped " + old + " message(s) older than " + KeepSentDays + " days from pending_bars.jsonl"); SavePending(); }
                try
                {
                    if (File.Exists(RefusedFile))
                        foreach (string raw in File.ReadAllLines(RefusedFile)) { string k = raw.Trim(); if (k.Length > 11 && !Older(k, cutoff)) Refused.Add(k); }
                }
                catch (Exception ex) { ChartBridgeServer.Log("could not read refused_bars.txt: " + ex.Message); }
                try
                {
                    if (File.Exists(SentFile))
                        foreach (string raw in File.ReadAllLines(SentFile)) { string k = raw.Trim(); if (k.Length > 11) Sent.Add(k); }
                }
                catch (Exception ex) { ChartBridgeServer.Log("could not read sent_bars.txt: " + ex.Message); }
            }
        }

        // Write a file through a temp file swapped in, so a crash never leaves half a file.
        private static void Replace(string file, IEnumerable<string> lines)
        {
            string tmp = file + ".tmp";
            File.WriteAllLines(tmp, lines.ToArray());
            if (File.Exists(file)) File.Replace(tmp, file, null); else File.Move(tmp, file);
        }

        private static void SavePending()
        {
            try { Replace(File_, Pending); } catch (Exception ex) { ChartBridgeServer.Log("could not save pending bars: " + ex.Message); }
        }

        // A key ("yyyy-MM-dd contract") whose session is before cutoff; an unreadable date is not old.
        private static bool Older(string key, DateTime cutoff)
        {
            DateTime d;
            return key.Length >= 10 && DateTime.TryParseExact(key.Substring(0, 10), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out d) && d < cutoff;
        }

        // Sessions older than KeepSentDays are dropped from the record: the catch-up never looks that far back.
        private static void SaveSent() { SaveRecord(Sent, SentFile, "sent_bars.txt"); }
        private static void SaveRefused() { SaveRecord(Refused, RefusedFile, "refused_bars.txt"); }
        private static void SaveRecord(HashSet<string> set, string file, string name)
        {
            DateTime cutoff = ChartBridgeBars.UtcNow().Date.AddDays(-KeepSentDays);
            List<string> keep = set.Where(k => !Older(k, cutoff)).OrderBy(k => k, StringComparer.Ordinal).ToList();
            set.Clear();
            foreach (string k in keep) set.Add(k);
            try { Replace(file, keep); } catch (Exception ex) { ChartBridgeServer.Log("could not save " + name + ": " + ex.Message); }
        }

        public static void Queue(string key, string json)
        {
            lock (Sync)
            {
                if (PendingKeys.Contains(key)) return;
                Pending.Add(json); PendingKeys.Add(key);
                SavePending();
            }
        }

        public static bool IsWaiting(string key) { lock (Sync) return PendingKeys.Contains(key); }
        public static bool IsDone(string key) { lock (Sync) return Sent.Contains(key); }
        public static bool IsRefused(string key) { lock (Sync) return Refused.Contains(key); }
        public static int Waiting() { lock (Sync) return Pending.Count; }
        public static long SetAsideCount() { return Interlocked.Read(ref setAside); }
        public static string SendError() { return sendError ?? ""; }

        // {"MNQ 12-26":"2026-09-30", ...}: the latest session The Desk took, per contract.
        public static string LastSentJson()
        {
            Dictionary<string, string> last = new Dictionary<string, string>();
            lock (Sync)
            {
                foreach (string k in Sent)
                {
                    string day = k.Substring(0, 10), contract = k.Substring(11);
                    string was;
                    if (!last.TryGetValue(contract, out was) || string.CompareOrdinal(day, was) > 0) last[contract] = day;
                }
            }
            return "{" + string.Join(",", last.OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => CbJson.Str(kv.Key) + ":" + CbJson.Str(kv.Value)).ToArray()) + "}";
        }

        private static void Done(string key, string line, bool sent)
        {
            lock (Sync)
            {
                int i = PendingKeys.IndexOf(key);
                if (i >= 0) { Pending.RemoveAt(i); PendingKeys.RemoveAt(i); }
                SavePending();
                if (sent) { Sent.Add(key); SaveSent(); }
                else { Refused.Add(key); SaveRefused(); }   // bars N1: set aside, and not asked for again after a restart either
            }
        }

        private static async Task<WebResponse> Post(HttpWebRequest req, byte[] bytes)
        {
            using (Stream s = await req.GetRequestStreamAsync()) await s.WriteAsync(bytes, 0, bytes.Length);
            return await req.GetResponseAsync();
        }

        // Sends the waiting messages, oldest first, until one fails (then the next try is in 10 seconds). Runs on the bars
        // thread (never NinjaTrader's); a second caller while one is sending returns at once. Nothing is posted once
        // stopping() is true or Abort() has run.
        public static void Flush() { Flush(null); }
        public static void Flush(Func<bool> stopping)
        {
            if (!ChartBridgeBars.Enabled) return;
            if (Interlocked.CompareExchange(ref sending, 1, 0) != 0) return;
            int gen = Volatile.Read(ref stopGen);
            try
            {
                while (true)
                {
                    if (stopping != null && stopping()) return;
                    string line, key;
                    lock (Sync)
                    {
                        if (Pending.Count == 0) return;
                        line = Pending[0]; key = PendingKeys[0];
                    }
                    if (!SendOne(key, line, gen)) return;
                }
            }
            finally { Interlocked.Exchange(ref sending, 0); }
        }

        // ChartBridgeBars.Stop: a post in flight is aborted (the message stays queued) and no other starts.
        private static readonly object AbortSync = new object();
        private static int stopGen;
        private static HttpWebRequest inFlight;
        public static void Abort()
        {
            lock (AbortSync)
            {
                stopGen++;
                try { if (inFlight != null) inFlight.Abort(); } catch (Exception) { }
            }
        }

        // True when the message left the queue (taken, or set aside).
        private static bool SendOne(string key, string line, int gen)
        {
            HttpWebRequest req = null;
            try
            {
                byte[] bytes = Encoding.UTF8.GetBytes(line);
                req = (HttpWebRequest)WebRequest.Create(ChartBridgeConfig.DeskUrl + "/api/bars");
                req.Method = "POST";
                req.ContentType = "application/json";
                lock (AbortSync) { if (stopGen != gen) return false; inFlight = req; }
                Task<WebResponse> call = Post(req, bytes);
                if (!call.Wait(TimeoutMs) && !call.IsCompleted)
                {
                    try { req.Abort(); } catch (Exception) { }
                    Task observed = call.ContinueWith(t => { Exception ignored = t.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
                    throw new TimeoutException("The Desk did not answer within " + (TimeoutMs / 1000) + " seconds");
                }
                using (WebResponse res = call.Result) { }
                Done(key, line, true);
                if (lastFailed) { ChartBridgeServer.Log("The Desk is taking bars again."); lastFailed = false; }
                sendError = "";   // /diag: no stale error once a send has gone through
                ChartBridgeServer.Log("The Desk took the bars for " + key);
                return true;
            }
            catch (Exception ex)
            {
                Exception e = ex is AggregateException && ex.InnerException != null ? ex.InnerException : ex;
                WebException wex = e as WebException;
                HttpWebResponse res = wex != null ? wex.Response as HttpWebResponse : null;
                int code = res != null ? (int)res.StatusCode : 0;
                if (code == 400 || code == 422)
                {
                    string why = "";
                    try { using (StreamReader r = new StreamReader(res.GetResponseStream(), Encoding.UTF8)) { Match m = DetailRx.Match(r.ReadToEnd()); if (m.Success) why = m.Groups[1].Value; } } catch (Exception) { }
                    try { File.AppendAllLines(SetAsideFile, new string[] { line }); } catch (Exception) { }
                    Done(key, line, false);
                    Interlocked.Increment(ref setAside);
                    ChartBridgeBars.SkipThisRun(key);
                    ChartBridgeServer.Log("The Desk refused the bars for " + key + " (" + code + (why.Length > 0 ? ": " + Clean(why) : "") + "); set aside in rejected_bars.jsonl, not asked for again (refused_bars.txt)");
                    return true;
                }
                if (Volatile.Read(ref stopGen) != gen) return false;   // aborted by a stop: still queued, nothing to report
                sendError = e.Message;
                if (!lastFailed) ChartBridgeServer.Log("The Desk did not take bars (" + e.Message + "); they are saved and will be retried every 10 seconds.");
                lastFailed = true;
                return false;
            }
            finally { lock (AbortSync) { if (inFlight == req) inFlight = null; } }
        }

        private static string Clean(string s)
        {
            StringBuilder b = new StringBuilder();
            foreach (char ch in s ?? "") { if (b.Length >= 200) { b.Append("..."); break; } b.Append(ch < 0x20 || ch == 0x7f ? '?' : ch); }
            return b.ToString();
        }
    }
}
