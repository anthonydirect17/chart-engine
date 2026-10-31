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
// 0.6.9 (Anthony 2026-10-24, the stats suite's Phase 2): with bars = on, each session's 1 second bars for NQ and MNQ too, built from
// NinjaTrader's 1 tick history in one pass on its thread (buy and sell volume by the live side rule), through the same gate, only
// 16:15 to 18:00 New York on weekdays and on the weekend while shut, to The Desk's POST /api/bars-1s in parts (ChartBridgeBars1sQueue, bars1s/). The 1-minute bars are unchanged.
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

    // 0.6.9: one second of trades as The Desk gets it: T is the second's OPEN, Unix milliseconds UTC; V every trade's volume, Buy and
    // Sell the volume of the trades called buys and sells (V less both is the volume of trades with no side).
    public struct SecondBar
    {
        public long T;
        public double O, H, L, C;
        public long V, Buy, Sell;
    }

    // 0.6.9: what one session's trades made: the rows and how each trade got its side.
    public class SecondsBuild
    {
        public readonly List<SecondBar> Rows = new List<SecondBar>();
        public long Trades, Volume, BidAsk, TickRule, None, Outside, OutOfOrder;
        public string QuoteError;   // NinjaTrader's GetBid/GetAsk threw (then the tick rule for every trade)
        // "bidAsk": every side from the quote stored with the trade; "tickRule": none from it; "mixed": both; "none": no side at all
        public string Method
        {
            get
            {
                if (BidAsk > 0 && TickRule == 0) return "bidAsk";
                if (BidAsk == 0 && TickRule > 0) return "tickRule";
                if (BidAsk > 0 && TickRule > 0) return "mixed";
                return "none";
            }
        }
    }

    // 0.6.9: the trades of one session in NinjaTrader's order, one row per UTC second, the session [fromMs, toMs) only. NinjaTrader's
    // times are turned into UTC with its time zone once an hour of its clock (a change of offset falls on the hour, when the market is
    // shut), not once a trade.
    public class SecondsBuilder
    {
        private readonly long fromMs, toMs;
        private readonly SecondsBuild b = new SecondsBuild();
        private bool has, hasPrev;
        private SecondBar cur;
        private double prevPrice;
        private int prevSide;
        private long hourKey = long.MinValue, offsetTicks;
        private static readonly long EpochTicks = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).Ticks;
        public string QuoteError { set { b.QuoteError = value; } }

        public SecondsBuilder(long fromMs, long toMs) { this.fromMs = fromMs; this.toMs = toMs; }

        public void Add(DateTime ntTime, double price, long volume, double bid, double ask)
        {
            long hk = ntTime.Ticks / TimeSpan.TicksPerHour;
            if (hk != hourKey) { hourKey = hk; offsetTicks = ntTime.Ticks - ChartBridgeTime.ToUtc(ntTime).Ticks; }
            long ms = (ntTime.Ticks - offsetTicks - EpochTicks) / TimeSpan.TicksPerMillisecond;
            if (ms < fromMs || ms >= toMs || !(price > 0)) { b.Outside++; return; }
            int method;
            int side = ChartBridgeSides.Classify(price, bid, ask, hasPrev, prevPrice, prevSide, out method);
            if (method == ChartBridgeSides.BidAsk) b.BidAsk++; else if (method == ChartBridgeSides.TickRule) b.TickRule++; else b.None++;
            hasPrev = true; prevPrice = price; prevSide = side;
            b.Trades++; b.Volume += volume;
            long t = ms - ((ms % 1000) + 1000) % 1000;
            if (has && t < cur.T)
            {
                // out of NinjaTrader's time order (never seen; kept exact): into the row of its own second, open and close left as they are
                b.OutOfOrder++;
                int lo = 0, hi = b.Rows.Count - 1;
                while (lo <= hi) { int mid = (lo + hi) / 2; if (b.Rows[mid].T < t) lo = mid + 1; else hi = mid - 1; }
                if (lo < b.Rows.Count && b.Rows[lo].T == t)
                {
                    SecondBar r = b.Rows[lo];
                    if (price > r.H) r.H = price; if (price < r.L) r.L = price;
                    r.V += volume; if (side > 0) r.Buy += volume; else if (side < 0) r.Sell += volume;
                    b.Rows[lo] = r;
                }
                else
                {
                    SecondBar r = new SecondBar { T = t, O = price, H = price, L = price, C = price, V = volume, Buy = side > 0 ? volume : 0, Sell = side < 0 ? volume : 0 };
                    b.Rows.Insert(lo, r);
                }
                return;
            }
            if (!has || t != cur.T)
            {
                if (has) b.Rows.Add(cur);
                cur = new SecondBar { T = t, O = price, H = price, L = price, C = price };
                has = true;
            }
            else
            {
                if (price > cur.H) cur.H = price;
                if (price < cur.L) cur.L = price;
                cur.C = price;
            }
            cur.V += volume;
            if (side > 0) cur.Buy += volume; else if (side < 0) cur.Sell += volume;
        }

        public SecondsBuild Finish()
        {
            if (has) { b.Rows.Add(cur); has = false; }
            return b;
        }
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
        //   bars1s = off                  (0.6.9: with bars = on, each session's 1 second bars go too; this line turns only them off)
        //   bars1sRoots = NQ, MNQ         (0.6.9: the roots whose 1 second bars are sent; these by default)
        public static bool Enabled;
        public static string[] Roots = DefaultRoots();
        public static string Pc = "";
        private static bool oneSecondOff;
        public static string[] Roots1s = DefaultRoots1s();
        public static bool OneSecondOn { get { return Enabled && !oneSecondOff; } }

        private static string[] DefaultRoots() { return new string[] { "NQ", "MNQ", "ES", "MES" }; }
        private static string[] DefaultRoots1s() { return new string[] { "NQ", "MNQ" }; }

        public static void ResetConfig() { Enabled = false; Roots = DefaultRoots(); Pc = ""; oneSecondOff = false; Roots1s = DefaultRoots1s(); lock (Planned1s) Planned1s.Clear(); }

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
            if (key == "bars1s")
            {
                string v = (val ?? "").Trim().ToLowerInvariant();
                oneSecondOff = v == "off" || v == "false" || v == "0";
                return true;
            }
            if (key == "bars1sRoots")
            {
                string[] r = (val ?? "").Split(',').Select(s => s.Trim().ToUpperInvariant()).Where(s => s.Length > 0).Distinct().ToArray();
                if (r.Length > 0) Roots1s = r;
                return true;
            }
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
        public static int Request1sTimeoutMs = 180000;      // 0.6.9: the gate's time limit for one session's trades (NinjaTrader may load them first)
        public static int Rows1sPerPart = 1500;             // 0.6.9: 1 second rows per message (the 1-minute message's own limit of 1,500 rows; about 90 KB)

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

        // 0.6.9 (the coordinator's ruling, 2026-10-24): the only times the 1 second bars ask NinjaTrader for trades or post to The
        // Desk: 16:15 to 18:00 New York on a weekday (after regular hours, before the evening session opens), and the weekend while
        // the market is shut (Saturday, and Sunday before the 18:00 open). Never premarket, in regular hours or in the evening
        // session, so a Range or tick chart load is never held behind a session's trades while Anthony may be watching. The start's
        // catch-up waits for the next window too.
        // Review of #71 (MEDIUM 2): a new 1 second request starts only up to 17:50 New York (the window's end less StartMargin1s), so one
        // that runs long (up to Request1sTimeoutMs) is not out when the evening session opens. Sends may go on to 18:00.
        public static TimeSpan StartMargin1s = TimeSpan.FromMinutes(10);
        public static bool In1sStartWindow(DateTime et)
        {
            if (!In1sWindow(et)) return false;
            if (et.DayOfWeek == DayOfWeek.Saturday) return true;
            return et.TimeOfDay < TimeSpan.FromHours(18) - StartMargin1s;   // a weekday's and Sunday's window both end at 18:00
        }
        private static DateTime NowEt() { return TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(UtcNow(), DateTimeKind.Utc), ChartBridgeTime.Eastern); }

        public static bool In1sWindow(DateTime et)
        {
            TimeSpan tod = et.TimeOfDay;
            if (et.DayOfWeek == DayOfWeek.Saturday) return true;
            if (et.DayOfWeek == DayOfWeek.Sunday) return tod < TimeSpan.FromHours(18);
            return tod >= new TimeSpan(16, 15, 0) && tod < TimeSpan.FromHours(18);
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

        // ---------------------------------------------------------- 0.6.9: 1 second bars (pure; nt8/check/BarsHarness.cs)
        // NinjaTrader's trades of one session (a 1 tick, Last BarsRequest) made into one row per second that had a trade, in one pass on
        // NinjaTrader's thread (no copy of the trades is kept). The side of each trade by ChartBridge's own rule (ChartBridgeSides.Classify,
        // the rule the live trades use): the bid and ask NinjaTrader stored with that trade when it has them (at or above the ask a buy,
        // at or below the bid a sell), else the tick rule; the first trade of the session between the quotes or with no quote has no
        // side. The session starts the tick rule over (nothing carries across the 17:00 to 18:00 break).
        public static object BuildSeconds(Bars bars, long fromMs, long toMs)
        {
            SecondsBuilder sb = new SecondsBuilder(fromMs, toMs);
            int n = bars.Count;
            bool quotes = true;
            for (int i = 0; i < n; i++)
            {
                double bid = double.NaN, ask = double.NaN;
                if (quotes)
                {
                    try { bid = bars.GetBid(i); ask = bars.GetAsk(i); }
                    catch (Exception ex) { quotes = false; bid = double.NaN; ask = double.NaN; sb.QuoteError = ex.Message; }
                }
                sb.Add(bars.GetTime(i), bars.GetClose(i), bars.GetVolume(i), bid, ask);
            }
            return sb.Finish();
        }

        // The rows of one session's 1 second bars as messages for The Desk's POST /api/bars-1s (contract v2, tf 1s), Rows1sPerPart rows
        // each, in order. Every part carries the set (one id for the session's parts made together), its number and the count, and the
        // session's totals, so The Desk can tell when it has the whole session (every part of one set) and check it against its minutes.
        public static List<string> Messages1s(string contract, string root, double tick, DateTime session, SecondsBuild sb, string set)
        {
            List<string> parts = new List<string>();
            int per = Math.Max(1, Rows1sPerPart), total = sb.Rows.Count;
            int count = Math.Max(1, (total + per - 1) / per);
            for (int k = 0; k < count; k++)
                parts.Add(Message1s(contract, root, tick, session, sb, set, k + 1, count, k * per, Math.Min(total, (k + 1) * per)));
            return parts;
        }

        public static string Message1s(string contract, string root, double tick, DateTime session, SecondsBuild sb, string set, int part, int parts, int i0, int i1)
        {
            StringBuilder b = new StringBuilder(512 + (i1 - i0) * 64);
            b.Append("{\"v\":2,\"source\":\"chartbridge\",\"bridge\":").Append(CbJson.Str(ChartBridgeServer.Version))
             .Append(",\"pc\":").Append(CbJson.Str(PcName()))
             .Append(",\"contract\":").Append(CbJson.Str(contract))
             .Append(",\"root\":").Append(CbJson.Str(root))
             .Append(",\"tick\":").Append(CbJson.Num(tick))
             .Append(",\"session\":").Append(CbJson.Str(session.ToString("yyyy-MM-dd", Inv)))
             .Append(",\"tf\":\"1s\",\"stamp\":\"open\",\"cols\":[\"t\",\"o\",\"h\",\"l\",\"c\",\"v\",\"bv\",\"sv\"]")
             .Append(",\"sides\":{\"method\":").Append(CbJson.Str(sb.Method))
             .Append(",\"bidAsk\":").Append(sb.BidAsk.ToString(Inv)).Append(",\"tickRule\":").Append(sb.TickRule.ToString(Inv)).Append(",\"none\":").Append(sb.None.ToString(Inv)).Append('}')
             .Append(",\"set\":").Append(CbJson.Str(set))
             .Append(",\"part\":").Append(part.ToString(Inv)).Append(",\"parts\":").Append(parts.ToString(Inv))
             .Append(",\"setRows\":").Append(sb.Rows.Count.ToString(Inv)).Append(",\"setTrades\":").Append(sb.Trades.ToString(Inv)).Append(",\"setVolume\":").Append(sb.Volume.ToString(Inv))
             .Append(",\"first\":").Append(sb.Rows.Count > 0 ? sb.Rows[0].T.ToString(Inv) : "null")
             .Append(",\"last\":").Append(sb.Rows.Count > 0 ? sb.Rows[sb.Rows.Count - 1].T.ToString(Inv) : "null")
             .Append(",\"bars\":[");
            for (int i = i0; i < i1; i++)
            {
                SecondBar x = sb.Rows[i];
                if (i > i0) b.Append(',');
                b.Append('[').Append(x.T.ToString(Inv)).Append(',').Append(CbJson.Num(x.O)).Append(',').Append(CbJson.Num(x.H)).Append(',')
                 .Append(CbJson.Num(x.L)).Append(',').Append(CbJson.Num(x.C)).Append(',').Append(x.V.ToString(Inv)).Append(',')
                 .Append(x.Buy.ToString(Inv)).Append(',').Append(x.Sell.ToString(Inv)).Append(']');
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
                state1s = OneSecondOn ? "starting" : "off"; lastBuild1s = ""; error1s = "";
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
            ChartBridgeBars1sQueue.Abort();   // 0.6.9
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
                ChartBridgeBars1sQueue.Load();   // 0.6.9: the 1 second bars' sets waiting (bars1s/), on this thread too
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
                try { ChartBridgeBars1sQueue.Flush(stopping); } catch (Exception ex) { Note1s("1 second bars send error: " + ex.Message); }   // 0.6.9
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
            bool asked1s = Plan1s(stopping, nowEt, sessions);   // 0.6.9: then the 1 second bars, never in regular trading hours
            if (!asked1s && !stopping()) ChartBridgeTicks.PlanDay(stopping);   // the NQ tick file's final pull: one request a pass at most, the same window
        }

        // ---------------------------------------------------------- 0.6.9: the 1 second bars' worker part
        // After the 1-minute bars of the pass, the same sessions' 1 second bars for Roots1s (NQ, MNQ), the same contracts (the front
        // month and any other with fills). Only in In1sWindow (16:15 to 18:00 New York on weekdays, the weekend while shut), the start's
        // catch-up included: a whole session's trades is a big request. At most one request a pass (once a minute), through the same gate, last of all.
        private static volatile string state1s = "off", lastBuild1s = "", error1s = "";
        public static string Key1s(string key) { return "1s " + key; }   // the retry records' key (never the same as a 1-minute key)

        // True when it asked NinjaTrader (or waits at the gate) this pass: then the tick file's final pull waits for the next pass.
        private static bool Plan1s(Func<bool> stopping, DateTime nowEt, List<DateTime> sessions)
        {
            if (!OneSecondOn) { state1s = "off"; return false; }
            nowEt = NowEt();   // review of #71 (MEDIUM 2): the pass's 1-minute requests may have taken minutes: the clock now, not the pass's start
            if (!In1sStartWindow(nowEt)) { state1s = "waiting: 1 second bars go 16:15 to 18:00 ET on weekdays and on the weekend (a request starts by 17:50)"; return false; }
            string[] roots = Roots1s.Where(r => Roots.Contains(r)).ToArray();   // only roots whose 1-minute bars go too (barsRoots)
            List<BarsJob> wanted1s = Wanted(sessions, roots, FillJobs(sessions));
            lock (Planned1s) { if (Planned1s.Count > 50) Planned1s.Clear(); foreach (BarsJob j in wanted1s) Planned1s.Add(j.Contract); }
            foreach (BarsJob j in wanted1s)
            {
                if (stopping()) return true;
                if (ChartBridgeBars1sQueue.IsDone(j.Key) || ChartBridgeBars1sQueue.IsWaiting(j.Key) || ChartBridgeBars1sQueue.IsRefused(j.Key)) continue;
                DateTime notBefore;
                string k = Key1s(j.Key);
                lock (RetryAt)
                {
                    if (GaveUp.Contains(k)) continue;
                    if (RetryAt.TryGetValue(k, out notBefore) && UtcNow() < notBefore) continue;
                }
                if (!In1sStartWindow(NowEt())) { state1s = "waiting: 1 second bars go 16:15 to 18:00 ET on weekdays and on the weekend (a request starts by 17:50)"; return false; }   // and again right before it
                Outcome o = Fetch1s(j, stopping);
                if (o == Outcome.Done) { try { ChartBridgeBars1sQueue.Flush(stopping); } catch (Exception ex) { Note1s("1 second bars send error: " + ex.Message); } }
                return true;   // one a pass
            }
            state1s = "idle";
            return false;
        }

        private static void Note1s(string text) { error1s = text; ChartBridgeServer.Log(text); }

        private static void Later1s(BarsJob j, string why)
        {
            error1s = j.Key + ": " + why;
            string k = Key1s(j.Key);
            bool log, gaveUp;
            lock (RetryAt)
            {
                int n;
                Tries.TryGetValue(k, out n);
                Tries[k] = ++n;
                gaveUp = n >= MaxTries;
                if (gaveUp) GaveUp.Add(k); else RetryAt[k] = UtcNow().AddMinutes(RetryMinutes);
                string was;
                log = gaveUp || !LoggedFailure.TryGetValue(k, out was) || was != why;
                LoggedFailure[k] = why;
            }
            if (log) ChartBridgeServer.Log("1 second bars for " + j.Contract + " session " + j.Session.ToString("yyyy-MM-dd", Inv) + ": " + why +
                (gaveUp ? "; tried " + MaxTries + " times, not asked again until ChartBridge restarts" : "; trying again in " + RetryMinutes + " minutes"));
        }

        // The session's trades from NinjaTrader (1 tick, Last, whole trading days from the open's date to the close, never past now), made
        // into 1 second rows on NinjaTrader's thread (BuildSeconds), then split into messages and queued (bars1s/) here.
        private static Outcome Fetch1s(BarsJob j, Func<bool> stopping)
        {
            Instrument inst = null;
            try { inst = Lookup(j.Contract); } catch (Exception) { inst = null; }
            if (inst == null || inst.MasterInstrument == null) { Later1s(j, "NinjaTrader does not know the instrument"); return Outcome.Later; }
            DateTime nowUtc = UtcNow(), openUtc, closeUtc;
            SessionUtc(j.Session, out openUtc, out closeUtc);
            TimeZoneInfo ntZone = NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo;
            // Sunday 11-01 (item 11): from the session's open itself, NinjaTrader's time. From 12:00 AM of the open's date NinjaTrader gave the
            // whole session before as well (its whole trading days); the rows are cut to the session by time either way.
            DateTime fromNt = TimeZoneInfo.ConvertTimeFromUtc(openUtc, ntZone);
            DateTime toNt = TimeZoneInfo.ConvertTimeFromUtc(closeUtc, ntZone);
            DateTime nowNt = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(nowUtc, DateTimeKind.Utc), ntZone);
            if (toNt > nowNt) toNt = nowNt;
            long fromMs = (long)Math.Round(ChartBridgeTime.UtcMs(openUtc)), toMs = (long)Math.Round(ChartBridgeTime.UtcMs(closeUtc));
            long nowMs = (long)Math.Floor(ChartBridgeTime.UtcMs(DateTime.SpecifyKind(nowUtc, DateTimeKind.Utc)));
            if (nowMs < toMs) { Later1s(j, "the session has not closed yet"); return Outcome.Later; }   // never a part session
            BarsTicket t = new BarsTicket();
            string busy = ChartBridgeServer.GateBars("1s " + j.Key, inst, fromNt, toNt, Request1sTimeoutMs, stopping, t, bars => BuildSeconds(bars, fromMs, toMs));
            if (busy != null) { state1s = "waiting for the gate: " + busy; return Outcome.Wait; }
            state1s = "asking NinjaTrader: 1s " + j.Key;
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            long giveUpMs = (long)QueueWaitMs + Request1sTimeoutMs + ChartBridgeServer.AnswerCopyMs + 5000;
            while (!t.Done.Wait(50))
            {
                if (stopping()) { ChartBridgeServer.GateBarsWithdraw(t); return Outcome.Stopped; }
                if (!t.Started && sw.ElapsedMilliseconds > QueueWaitMs && ChartBridgeServer.GateBarsWithdraw(t))
                {
                    state1s = "waiting for the gate: the request did not go out within " + (QueueWaitMs / 1000) + " s (the chart's requests went first)";
                    return Outcome.Wait;
                }
                if (sw.ElapsedMilliseconds > giveUpMs) { Later1s(j, "no answer from the gate"); return Outcome.Later; }
            }
            if (stopping()) return Outcome.Stopped;
            if (t.GateStuck) { state1s = "waiting for the gate: " + t.Error; return Outcome.Wait; }
            if (t.Error != null) { Later1s(j, t.Error); return Outcome.Later; }
            SecondsBuild sb = t.Built as SecondsBuild;
            if (sb == null || sb.Rows.Count == 0) { Later1s(j, "NinjaTrader has no trades for it"); return Outcome.Later; }
            if (stopping()) return Outcome.Stopped;
            string root = (inst.MasterInstrument.Name ?? j.Root).ToUpperInvariant();
            string set = Guid.NewGuid().ToString("N").Substring(0, 12);
            List<string> parts = Messages1s(inst.FullName, root, inst.MasterInstrument.TickSize, j.Session, sb, set);
            string err = ChartBridgeBars1sQueue.Queue(j.Key, parts);
            if (err != null) { Later1s(j, "could not save the 1 second bars: " + err); return Outcome.Later; }
            lock (RetryAt) { string k = Key1s(j.Key); RetryAt.Remove(k); Tries.Remove(k); LoggedFailure.Remove(k); }
            error1s = "";
            lastBuild1s = j.Key + ": " + sb.Trades + " trades, " + sb.Rows.Count + " seconds, " + parts.Count + " messages, " + sb.Outside + " trades outside the session left out" +
                          " (asked " + fromNt.ToString("yyyy-MM-dd HH:mm", Inv) + " to " + toNt.ToString("yyyy-MM-dd HH:mm", Inv) + " NinjaTrader time), sides " + sb.Method +
                          " (bidAsk " + sb.BidAsk + ", tickRule " + sb.TickRule + ", none " + sb.None + "), built in " + Math.Round(t.BuildMs) + " ms on NinjaTrader's thread" +
                          (sb.QuoteError != null ? "; NinjaTrader gave no bid and ask with the trades (" + sb.QuoteError + ")" : "");
            ChartBridgeServer.Log("1 second bars for " + inst.FullName + " session " + j.Session.ToString("yyyy-MM-dd", Inv) + ": " + lastBuild1s.Substring(j.Key.Length + 2) + "; queued for The Desk");
            state1s = "idle";
            return Outcome.Done;
        }

        // Sunday 11-01 (decided 2026-11-01): /diag lastSent lists every contract the 1 second pull covers, "none yet" where The Desk
        // has not taken a set of it (so a missing MNQ is never mistaken for a fault): the front contract of each of its roots (Roots1s
        // that are in barsRoots) and every contract a pass planned (a contract with fills too).
        private static readonly HashSet<string> Planned1s = new HashSet<string>();
        private static List<string> Covered1s()
        {
            List<string> out1 = new List<string>();
            if (!OneSecondOn) return out1;
            DateTime today = NowEt().Date;
            foreach (string r in Roots1s.Where(r => Roots.Contains(r))) out1.Add(FrontContract(r, today));
            lock (Planned1s) out1.AddRange(Planned1s);
            return out1;
        }

        public static string Diag1sJson()
        {
            int gaveUp; lock (RetryAt) gaveUp = GaveUp.Count(k => k.StartsWith("1s ", StringComparison.Ordinal));
            string err = ChartBridgeBars1sQueue.SendError();
            if (err.Length == 0) err = error1s ?? "";
            return "{\"on\":" + (OneSecondOn ? "true" : "false") +
                ",\"state\":" + CbJson.Str(state1s ?? "") +
                ",\"roots\":[" + string.Join(",", Roots1s.Select(r => CbJson.Str(r)).ToArray()) + "]" +
                ",\"lastSent\":" + ChartBridgeBars1sQueue.LastSentJson(Covered1s()) +
                ",\"waitingSets\":" + ChartBridgeBars1sQueue.Waiting() +
                ",\"waitingParts\":" + ChartBridgeBars1sQueue.WaitingParts() +
                ",\"setAside\":" + ChartBridgeBars1sQueue.SetAsideCount() +
                ",\"deskHasNo1s\":" + (ChartBridgeBars1sQueue.DeskHasNone ? "true" : "false") +
                ",\"gaveUp\":" + gaveUp +
                ",\"lastBuild\":" + CbJson.Str(lastBuild1s ?? "") +
                ",\"error\":" + CbJson.Str(err) + "}";
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
                ",\"lastError\":" + CbJson.Str(err) +
                ",\"oneSecond\":" + Diag1sJson() + "}";   // 0.6.9
        }
    }

    // One daily bars request at the gate (ChartBridgeServer.GateBars): its answer copied on NinjaTrader's thread, or why not.
    public class BarsTicket
    {
        public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);
        public volatile bool Started;      // it went to NinjaTrader (it can no longer be taken back)
        public volatile bool GateStuck;    // it waited at the gate while another request was not answered: asked again later
        public RawBars Raw;
        public object Built;               // 0.6.9: the 1 second bars' rows (SecondsBuild), made on NinjaTrader's thread
        public double BuildMs;             // 0.6.9: how long that took there
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

    // ------------------------------------------------------------------ 0.6.9: the 1 second bars' queue
    // One session of one contract is a set of parts (ChartBridgeBars.Messages1s, about 55 for a full NQ session). Each set is written
    // once, whole (a temp file swapped in), to bars1s/<session>_<contract>.jsonl next to config.txt, one part a line, before anything
    // is sent; bars1s/<same>.sent notes each part The Desk took (a line appended per part, so the big file is never written again).
    // The parts go to The Desk's POST /api/bars-1s in order, oldest session first, one a request, 10 seconds each, only in the 1 second
    // bars' window (ChartBridgeBars.In1sWindow: The Desk stores tens of thousands of rows a session, never while Anthony may trade). A set done is noted in
    // sent_bars1s.txt (40 days) and its files deleted. A part The Desk calls malformed (400, 413 or 422) is set aside in
    // rejected_bars1s.jsonl and its whole set dropped and noted in refused_bars1s.txt (40 days: not asked for again). A 404 means
    // this Desk has no 1 second store yet: the sets stay on disk and are offered again every 30 minutes (said once). Anything else is
    // tried again after a minute. A set waiting for a session older than KeepWaitingDays is dropped when the queue is read (the
    // catch-up never asks that far back), so the folder stays small (a set is about 4 to 5 MB).
    public static class ChartBridgeBars1sQueue
    {
        private class Set { public string Key, File, Progress; public int Parts, Next; }
        private static readonly object Sync = new object();
        private static readonly List<Set> Sets = new List<Set>();
        private static readonly HashSet<string> Sent = new HashSet<string>(), Refused = new HashSet<string>();
        private static readonly Regex SessionRx = new Regex("\"session\":\"(\\d{4}-\\d{2}-\\d{2})\"");
        private static readonly Regex ContractRx = new Regex("\"contract\":\"([^\"\\\\]*)\"");
        private static readonly Regex DetailRx = new Regex("\"detail\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        public static int TimeoutMs = 10000;
        public static int FailRetryMs = 60000;          // after a failed send
        public static int NoDeskRetryMs = 1800000;      // after a 404 (this Desk has no 1 second store yet)
        public const int KeepSentDays = 40;
        public static int KeepWaitingDays = 10;
        private static int sending;
        private static volatile bool deskHasNone, lastFailed;
        private static DateTime retryAt = DateTime.MinValue;
        private static string sendError = "";
        private static long setAside;

        public static string Folder { get { return Path.Combine(ChartBridgeConfig.Folder, "bars1s"); } }
        private static string SentFile { get { return Path.Combine(ChartBridgeConfig.Folder, "sent_bars1s.txt"); } }
        private static string RefusedFile { get { return Path.Combine(ChartBridgeConfig.Folder, "refused_bars1s.txt"); } }
        private static string SetAsideFile { get { return Path.Combine(ChartBridgeConfig.Folder, "rejected_bars1s.jsonl"); } }
        public static bool DeskHasNone { get { return deskHasNone; } }

        public static string FileOf(string key)
        {
            StringBuilder b = new StringBuilder();
            foreach (char ch in key) b.Append(char.IsLetterOrDigit(ch) || ch == '-' ? ch : '_');
            return Path.Combine(Folder, b.ToString() + ".jsonl");
        }

        // "yyyy-MM-dd contract" of a whole part line, or null.
        public static string KeyOfLine(string line)
        {
            if (line == null || !line.StartsWith("{\"v\":2,") || !line.EndsWith(",\"complete\":true}") || !line.Contains("\"tf\":\"1s\"")) return null;
            Match s = SessionRx.Match(line), c = ContractRx.Match(line);
            if (!s.Success || !c.Success) return null;
            return s.Groups[1].Value + " " + c.Groups[1].Value;
        }

        private static bool Older(string key, DateTime cutoff)
        {
            DateTime d;
            return key.Length >= 10 && DateTime.TryParseExact(key.Substring(0, 10), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out d) && d < cutoff;
        }

        private static void DeleteSet(Set s) { try { File.Delete(s.File); } catch (Exception) { } try { File.Delete(s.Progress); } catch (Exception) { } }

        // On the bars thread when it starts (never NinjaTrader's).
        public static void Load()
        {
            lock (Sync)
            {
                Sets.Clear(); Sent.Clear(); Refused.Clear();
                sendError = ""; lastFailed = false; deskHasNone = false; retryAt = DateTime.MinValue;
                Interlocked.Exchange(ref setAside, 0);
                DateTime now = ChartBridgeBars.UtcNow().Date, cutoffSent = now.AddDays(-KeepSentDays), cutoffWait = now.AddDays(-KeepWaitingDays);
                try
                {
                    if (File.Exists(SentFile)) foreach (string raw in File.ReadAllLines(SentFile)) { string k = raw.Trim(); if (k.Length > 11 && !Older(k, cutoffSent)) Sent.Add(k); }
                    if (File.Exists(RefusedFile)) foreach (string raw in File.ReadAllLines(RefusedFile)) { string k = raw.Trim(); if (k.Length > 11 && !Older(k, cutoffSent)) Refused.Add(k); }
                }
                catch (Exception ex) { ChartBridgeServer.Log("could not read the 1 second bars' records: " + ex.Message); }
                int dropped = 0, bad = 0;
                try
                {
                    Directory.CreateDirectory(Folder);
                    foreach (string f in Directory.GetFiles(Folder, "*.jsonl").OrderBy(x => x, StringComparer.Ordinal))
                    {
                        Set s = new Set { File = f, Progress = Path.ChangeExtension(f, ".sent") };
                        string key = null; int n = 0; bool whole = true;
                        foreach (string raw in File.ReadLines(f))
                        {
                            string line = raw.Trim();
                            if (line.Length == 0) continue;
                            string k = KeyOfLine(line);
                            if (k == null || (key != null && k != key)) { whole = false; break; }
                            key = k; n++;
                        }
                        if (!whole || key == null) { bad++; DeleteSet(s); continue; }
                        if (Older(key, cutoffWait) || Sent.Contains(key) || Refused.Contains(key)) { dropped++; DeleteSet(s); continue; }
                        s.Key = key; s.Parts = n;
                        if (File.Exists(s.Progress)) s.Next = File.ReadAllLines(s.Progress).Count(x => x.Trim().Length > 0);
                        if (s.Next >= s.Parts) { Sent.Add(key); DeleteSet(s); continue; }   // every part was taken before the stop
                        Sets.Add(s);
                    }
                    try { foreach (string f in Directory.GetFiles(Folder, "*.tmp")) File.Delete(f); } catch (Exception) { }
                }
                catch (Exception ex) { ChartBridgeServer.Log("could not read the 1 second bars waiting in bars1s: " + ex.Message); }
                Sets.Sort((a, b) => string.CompareOrdinal(a.Key, b.Key));
                if (bad > 0) ChartBridgeServer.Log("dropped " + bad + " unreadable 1 second bars set(s) in bars1s (they are asked for again)");
                if (dropped > 0) ChartBridgeServer.Log("dropped " + dropped + " 1 second bars set(s) older than " + KeepWaitingDays + " days or already taken from bars1s");
            }
        }

        private static void Replace(string file, IEnumerable<string> lines)
        {
            string tmp = file + ".tmp";
            File.WriteAllLines(tmp, lines.ToArray());
            if (File.Exists(file)) File.Replace(tmp, file, null); else File.Move(tmp, file);
        }
        private static void SaveRecord(HashSet<string> set, string file, string name)
        {
            DateTime cutoff = ChartBridgeBars.UtcNow().Date.AddDays(-KeepSentDays);
            List<string> keep = set.Where(k => !Older(k, cutoff)).OrderBy(k => k, StringComparer.Ordinal).ToList();
            set.Clear();
            foreach (string k in keep) set.Add(k);
            try { Replace(file, keep); } catch (Exception ex) { ChartBridgeServer.Log("could not save " + name + ": " + ex.Message); }
        }

        // The set's parts written whole before anything is sent; null, or why it could not be.
        public static string Queue(string key, List<string> parts)
        {
            lock (Sync)
            {
                if (Sets.Any(s => s.Key == key)) return null;
                Set set = new Set { Key = key, File = FileOf(key), Parts = parts.Count };
                set.Progress = Path.ChangeExtension(set.File, ".sent");
                try
                {
                    Directory.CreateDirectory(Folder);
                    try { File.Delete(set.Progress); } catch (Exception) { }
                    string tmp = set.File + ".tmp";
                    File.WriteAllLines(tmp, parts.ToArray());
                    if (File.Exists(set.File)) File.Delete(set.File);
                    File.Move(tmp, set.File);
                }
                catch (Exception ex) { return ex.Message; }
                Sets.Add(set);
                Sets.Sort((a, b) => string.CompareOrdinal(a.Key, b.Key));
                return null;
            }
        }

        public static bool IsWaiting(string key) { lock (Sync) return Sets.Any(s => s.Key == key); }
        public static bool IsDone(string key) { lock (Sync) return Sent.Contains(key); }
        public static bool IsRefused(string key) { lock (Sync) return Refused.Contains(key); }
        public static int Waiting() { lock (Sync) return Sets.Count; }
        public static int WaitingParts() { lock (Sync) return Sets.Sum(s => s.Parts - s.Next); }
        public static long SetAsideCount() { return Interlocked.Read(ref setAside); }
        public static string SendError() { return sendError ?? ""; }
        // The latest session The Desk took, per contract; each contract of `covered` The Desk has not taken a set of yet: "none yet".
        public static string LastSentJson() { return LastSentJson(null); }
        public static string LastSentJson(IEnumerable<string> covered)
        {
            Dictionary<string, string> last = new Dictionary<string, string>();
            if (covered != null) foreach (string c in covered) if (!string.IsNullOrEmpty(c)) last[c] = "none yet";
            lock (Sync)
                foreach (string k in Sent)
                {
                    string day = k.Substring(0, 10), contract = k.Substring(11), was;
                    if (!last.TryGetValue(contract, out was) || was == "none yet" || string.CompareOrdinal(day, was) > 0) last[contract] = day;
                }
            return "{" + string.Join(",", last.OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => CbJson.Str(kv.Key) + ":" + CbJson.Str(kv.Value)).ToArray()) + "}";
        }

        private static readonly object AbortSync = new object();
        private static int stopGen;
        private static HttpWebRequest inFlight;
        public static void Abort()
        {
            lock (AbortSync) { stopGen++; try { if (inFlight != null) inFlight.Abort(); } catch (Exception) { } }
        }

        private enum Sent1 { Taken, Refused, NoDesk, Failed, Stopped }

        // On the bars thread only. Sends parts, oldest first, until one fails, The Desk has no store, it is regular trading hours, or a stop.
        public static void Flush(Func<bool> stopping)
        {
            if (!ChartBridgeBars.OneSecondOn) return;
            if (Interlocked.CompareExchange(ref sending, 1, 0) != 0) return;
            int gen = Volatile.Read(ref stopGen);
            try
            {
                Set s = null;
                List<string> lines = null;
                while (true)
                {
                    if (stopping != null && stopping()) return;
                    DateTime nowUtc = ChartBridgeBars.UtcNow();
                    if (!ChartBridgeBars.In1sWindow(TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(nowUtc, DateTimeKind.Utc), ChartBridgeTime.Eastern))) return;   // the same window as the requests
                    if ((deskHasNone || lastFailed) && nowUtc < retryAt) return;
                    Set first;
                    lock (Sync) { if (Sets.Count == 0) return; first = Sets[0]; }
                    if (first != s)
                    {
                        s = first; lines = null;   // a set's file is read once, then its parts go one after another
                        try { lines = File.ReadAllLines(s.File).Where(x => x.Trim().Length > 0).ToList(); } catch (Exception ex) { sendError = ex.Message; }
                        if (lines == null || lines.Count != s.Parts)
                        {
                            lock (Sync) Sets.Remove(s);
                            DeleteSet(s);
                            ChartBridgeServer.Log("the 1 second bars for " + s.Key + " could not be read from bars1s; dropped (asked for again)");
                            continue;
                        }
                    }
                    string line = lines[s.Next];
                    string why;
                    int code;
                    Sent1 r = SendOne(line, gen, out code, out why);
                    if (r == Sent1.Stopped) return;
                    if (r == Sent1.Taken)
                    {
                        if (deskHasNone || lastFailed) ChartBridgeServer.Log("The Desk is taking 1 second bars again.");
                        deskHasNone = false; lastFailed = false; sendError = "";
                        s.Next++;
                        try { File.AppendAllText(s.Progress, s.Next.ToString(CultureInfo.InvariantCulture) + Environment.NewLine); } catch (Exception) { }
                        if (s.Next >= s.Parts)
                        {
                            lock (Sync) { Sets.Remove(s); Sent.Add(s.Key); SaveRecord(Sent, SentFile, "sent_bars1s.txt"); }
                            DeleteSet(s);
                            ChartBridgeServer.Log("The Desk took the 1 second bars for " + s.Key + " (" + s.Parts + " parts)");
                        }
                        continue;
                    }
                    if (r == Sent1.Refused)
                    {
                        try { File.AppendAllLines(SetAsideFile, new string[] { line }); } catch (Exception) { }
                        lock (Sync) { Sets.Remove(s); Refused.Add(s.Key); SaveRecord(Refused, RefusedFile, "refused_bars1s.txt"); }
                        DeleteSet(s);
                        Interlocked.Increment(ref setAside);
                        ChartBridgeBars.SkipThisRun(ChartBridgeBars.Key1s(s.Key));
                        ChartBridgeServer.Log("The Desk refused part " + (s.Next + 1) + " of the 1 second bars for " + s.Key + " (" + code + (why.Length > 0 ? ": " + why : "") + "); set aside in rejected_bars1s.jsonl, the session not asked for again (refused_bars1s.txt)");
                        continue;
                    }
                    retryAt = nowUtc.AddMilliseconds(r == Sent1.NoDesk ? NoDeskRetryMs : FailRetryMs);
                    if (r == Sent1.NoDesk)
                    {
                        if (!deskHasNone) ChartBridgeServer.Log("The Desk has no 1 second bars store yet (POST /api/bars-1s answered 404): " + Waiting() + " session(s) wait in bars1s and are offered again every " + (NoDeskRetryMs / 60000) + " minutes");
                        deskHasNone = true; sendError = "The Desk has no 1 second bars store (404)";
                    }
                    else
                    {
                        if (!lastFailed) ChartBridgeServer.Log("The Desk did not take 1 second bars (" + why + "); they are saved and tried again in " + (FailRetryMs / 1000) + " seconds.");
                        lastFailed = true; sendError = why;
                    }
                    return;
                }
            }
            finally { Interlocked.Exchange(ref sending, 0); }
        }

        private static async Task<WebResponse> Post(HttpWebRequest req, byte[] bytes)
        {
            using (Stream st = await req.GetRequestStreamAsync()) await st.WriteAsync(bytes, 0, bytes.Length);
            return await req.GetResponseAsync();
        }

        private static Sent1 SendOne(string line, int gen, out int code, out string why)
        {
            code = 0; why = "";
            HttpWebRequest req = null;
            try
            {
                byte[] bytes = Encoding.UTF8.GetBytes(line);
                req = (HttpWebRequest)WebRequest.Create(ChartBridgeConfig.DeskUrl + "/api/bars-1s");
                req.Method = "POST";
                req.ContentType = "application/json";
                lock (AbortSync) { if (stopGen != gen) return Sent1.Stopped; inFlight = req; }
                Task<WebResponse> call = Post(req, bytes);
                if (!call.Wait(TimeoutMs) && !call.IsCompleted)
                {
                    try { req.Abort(); } catch (Exception) { }
                    Task observed = call.ContinueWith(t => { Exception ignored = t.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
                    throw new TimeoutException("The Desk did not answer within " + (TimeoutMs / 1000) + " seconds");
                }
                using (WebResponse res = call.Result) { }
                return Sent1.Taken;
            }
            catch (Exception ex)
            {
                Exception e = ex is AggregateException && ex.InnerException != null ? ex.InnerException : ex;
                WebException wex = e as WebException;
                HttpWebResponse res = wex != null ? wex.Response as HttpWebResponse : null;
                code = res != null ? (int)res.StatusCode : 0;
                if (code == 400 || code == 413 || code == 422)
                {
                    try { using (StreamReader r = new StreamReader(res.GetResponseStream(), Encoding.UTF8)) { Match m = DetailRx.Match(r.ReadToEnd()); if (m.Success) why = Clean(m.Groups[1].Value); } } catch (Exception) { }
                    return Sent1.Refused;
                }
                if (Volatile.Read(ref stopGen) != gen) return Sent1.Stopped;
                if (code == 404) return Sent1.NoDesk;
                why = e.Message;
                return Sent1.Failed;
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
