// The side of every trade (ChartBridge 0.3.4), run for real on Mono. First the rules as pure functions
// (ChartBridgeSides.Classify: at, above, below the quote, between, no quote, crossed; the tick rule over sequences), the
// live tagger fed by timestamped Bid and Ask updates (the trade's own update first, one stamped after the trade, stale,
// reset, a burst, the delivery order), the 18:00 ET session. Then whole loads through ChartBridgeServer's Subscribe and
// OnMarketData with the stand-in BarsRequest: minute charts, the live {.., s, sm}, resets, the outbox and a 600,000-trade
// served window, and /diag. (0.3.7: the by-date tick load, its Bid and Ask history and the backfill's side join are gone,
// and their cases with them.)
// Made-up prices; nothing here is market data.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript.AddOns;

public static class SidesHarness
{
    static Action<bool, string> Check;
    // The made-up trades and quotes are at T0 plus seconds. The pure rules (Pure, Live, Join) run at a fixed instant in the
    // middle of a session, Tuesday 2026-09-29 11:00:00 New York time, so they are the same at any hour. They used to run ten
    // minutes before now: a run that started between about 17:35 and 18:15 ET put trades on both sides of the 18:00 session
    // start, where the tick rule starts over, and "join, N1" and two "live:" cases failed.
    static readonly TimeZoneInfo NewYork = TimeZoneInfo.FindSystemTimeZoneById("America/New_York");
    static readonly DateTime MidSession = NtTime(new DateTime(2026, 9, 29, 11, 0, 0, DateTimeKind.Unspecified));
    static DateTime T0 = MidSession;
    // A New York wall clock time in NinjaTrader's time zone setting (the stand-in's is the PC's), on a whole second.
    static DateTime NtTime(DateTime newYork) { return FromUtc(TimeZoneInfo.ConvertTimeToUtc(newYork, NewYork)); }
    static DateTime FromUtc(DateTime utc)
    {
        DateTime t = TimeZoneInfo.ConvertTimeFromUtc(utc, NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo);
        return new DateTime(t.Ticks / TimeSpan.TicksPerSecond * TimeSpan.TicksPerSecond, DateTimeKind.Unspecified);
    }
    // The whole loads (Load) go through ChartBridgeServer, which counts its quote window back from the PC's clock (there is no
    // clock hook), so their trades and quotes have to be recent: ten minutes before utcNow, or 17:40 ET when that would be
    // from 17:50 to 18:05 ET, so they never straddle an 18:00 session start either (AnyHour checks every minute of 4 days).
    static DateTime RecentBase(DateTime utcNow)
    {
        DateTime utc = utcNow.AddMinutes(-10), et = TimeZoneInfo.ConvertTimeFromUtc(utc, NewYork);
        if (et.TimeOfDay >= new TimeSpan(17, 50, 0) && et.TimeOfDay < new TimeSpan(18, 5, 0)) utc = TimeZoneInfo.ConvertTimeToUtc(et.Date.AddHours(17).AddMinutes(40), NewYork);
        return FromUtc(utc);
    }
    static DateTime At(double seconds) { return T0.AddTicks((long)Math.Round(seconds * TimeSpan.TicksPerSecond)); }
    const int N = ChartBridgeSides.None, AG = ChartBridgeSides.Aggressor, Q = ChartBridgeSides.BidAsk, TR = ChartBridgeSides.TickRule;

    static void Reset() { }

    // A copy of the Output window's lines, taken under its lock (other threads log while a check reads them).
    static List<string> OutputLines() { lock (NinjaTrader.Code.Output.Lines) return NinjaTrader.Code.Output.Lines.ToList(); }

    // ------------------------------------------------------------ pure rules
    static string C(double p, double bid, double ask, bool hasPrev, double prev, int prevSide)
    {
        int m; int s = ChartBridgeSides.Classify(p, bid, ask, hasPrev, prev, prevSide, out m);
        return s + "/" + m;
    }

    static string Seq(double bid, double ask, params double[] prices)
    {
        List<string> o = new List<string>();
        bool has = false; double prev = 0; int side = 0;
        foreach (double p in prices)
        {
            int m; int s = ChartBridgeSides.Classify(p, bid, ask, has, prev, side, out m);
            o.Add(s + "/" + m); has = true; prev = p; side = s;
        }
        return string.Join(" ", o);
    }

    static void Pure()
    {
        double nan = double.NaN;
        Check(C(100.25, 100, 100.25, false, 0, 0) == "1/" + Q, "side: at the ask is a buy, by the quote");
        Check(C(100.5, 100, 100.25, false, 0, 0) == "1/" + Q, "side: above the ask is a buy, by the quote");
        Check(C(100, 100, 100.25, false, 0, 0) == "-1/" + Q, "side: at the bid is a sell, by the quote");
        Check(C(99.75, 100, 100.25, true, 200, 1) == "-1/" + Q, "side: below the bid is a sell, by the quote (the tick rule is not asked)");
        Check(C(100.25, 100, 100.5, true, 100, -1) == "1/" + TR && C(100.25, 100, 100.5, true, 100.5, 1) == "-1/" + TR,
            "side: between bid and ask: the tick rule (up a buy, down a sell)");
        Check(C(100.25, 100, 100.5, true, 100.25, -1) == "-1/" + TR && C(100.25, 100, 100.5, true, 100.25, 1) == "1/" + TR,
            "side: between, unchanged price: the previous trade's side");
        Check(C(100.25, nan, nan, false, 0, 0) == "0/" + N, "side: no quote and no previous trade: unknown (0, method none)");
        Check(C(100.25, nan, 100.25, true, 100, 0) == "1/" + TR && C(100.25, 100, nan, true, 100.5, 0) == "-1/" + TR,
            "side: one side of the quote only: the tick rule");
        Check(C(100.25, 100.25, 100.25, true, 100, 0) == "1/" + TR && C(100, 100.25, 100, true, 100.25, 0) == "-1/" + TR,
            "side: a locked or crossed quote is not used: the tick rule");
        Check(C(100, 0, 100.25, true, 99, 0) == "1/" + TR && C(100, -1, 100.25, true, 99, 0) == "1/" + TR, "side: a zero or negative bid is no quote");
        Check(C(0.1 + 0.2, 0.25, 0.3, false, 0, 0) == "1/" + Q && C(0.3, 0.1 + 0.2, 0.55, false, 0, 0) == "-1/" + Q, "side: float noise (0.1 + 0.2 is 0.3) does not move a price off the quote");
        Check(ChartBridgeSides.Aggressor == 1 && ChartBridgeSides.BidAsk == 2 && ChartBridgeSides.TickRule == 3 && ChartBridgeSides.None == 0,
            "side: method codes 0 none, 1 aggressor flag, 2 bid/ask, 3 tick rule (the wire's sm)");

        // Tick rule sequences (no quote).
        Check(Seq(nan, nan, 10, 10.25, 10.25, 10, 10, 10.5) == "0/0 1/3 1/3 -1/3 -1/3 1/3", "tick rule: up, unchanged, down, unchanged, up");
        Check(Seq(nan, nan, 10, 10, 10.25, 10.25) == "0/0 0/0 1/3 1/3", "tick rule: unchanged after an unknown first trade stays unknown, until a price change");
        Check(Seq(nan, nan, 10, 9.75, 9.75, 9.75) == "0/0 -1/3 -1/3 -1/3", "tick rule: a run of unchanged prices keeps the last side");
        // Mixed: quote-classified trades set the side the tick rule carries on.
        Check(Seq(100, 100.5, 100.5, 100.25, 100.25, 100) == "1/2 -1/3 -1/3 -1/2", "mixed: at the ask a buy, then between (down) a sell, unchanged, then at the bid a sell");
        Check(Seq(100, 100.5, 100, 100.25, 100.25) == "-1/2 1/3 1/3", "mixed: at the bid a sell, then between (up) a buy, unchanged a buy");
    }

    // ------------------------------------------------------------ the live tagger (Bid and Ask updates, then Last)
    static string Tag(LiveSideTagger t, double p, double s, double eb, double ea) { int m; int x = t.Tag(p, At(s), eb, ea, out m); return x + "/" + m; }
    static void Q2(LiveSideTagger t, double s, double bid, double ask) { t.NoteQuote(true, bid, At(s)); t.NoteQuote(false, ask, At(s)); }

    static void Live()
    {
        LiveSideTagger t = new LiveSideTagger();
        Check(Tag(t, 100, 1.0, 0, 0) == "0/0", "live: before any quote or trade: unknown");
        Check(Tag(t, 100.25, 1.1, 0, 0) == "1/3", "live: before any quote: the tick rule");
        t.NoteQuote(true, 100, At(1.2));
        Check(Tag(t, 100.25, 1.3, 0, 0) == "1/3", "live: a bid alone is no quote: the tick rule (unchanged: previous side)");
        t.NoteQuote(false, 100.25, At(1.4));
        Check(Tag(t, 100.25, 1.5, 100, 100.25) == "1/2", "live: at the ask from the Ask update: a buy by the quote");
        Check(Tag(t, 100, 1.6, 100, 100.25) == "-1/2", "live: at the bid: a sell by the quote");
        t.NoteQuote(false, 100.5, At(1.7));   // the ask moved up: 100.25 is between now
        Check(Tag(t, 100.25, 1.8, 100, 100.25) == "1/3", "live: between after the ask moved: the tick rule (up from 100)");
        t.NoteQuote(true, 100.25, At(1.9));
        Check(Tag(t, 100.25, 2.0, 100.25, 100.5) == "-1/2", "live: the latest bid before the trade is used (100.25 is now the bid: a sell)");
        t.NoteQuote(true, 100.75, At(2.1));   // crossed (bid above ask): not used
        Check(Tag(t, 100.5, 2.2, 100.25, 100.5) == "1/3", "live: a crossed quote is not used: the tick rule");
        string d = t.DiagJson();
        Check(d.Contains("\"trades\":8") && d.Contains("\"bidAsk\":3") && d.Contains("\"tickRule\":4") && d.Contains("\"none\":1") && d.Contains("\"aggressor\":0")
              && d.Contains("\"bidUpdates\":3") && d.Contains("\"askUpdates\":2"), "live: /diag counts by method and quote updates (" + d + ")");
        // The Last update's own Bid and Ask, compared only: same as the latest updates, different, or not there.
        Check(d.Contains("\"eventQuoteSame\":3") && d.Contains("\"eventQuoteDiffers\":2") && d.Contains("\"eventQuoteNone\":3"),
            "live: /diag compares the Last update's own Bid and Ask with the latest updates (" + d + ")");

        // S3: the trade's own quote updates arrive first (same exchange time). The book is 100 / 100.25; a buy lifts the last
        // contract at 100.25, the ask moves to 100.5 and a bid joins at 100.25, all stamped 3.000, the two updates delivered
        // before the Last. By arrival order that is a sell; by the tie rule (strictly before) the 100 / 100.25 quote stands: a buy.
        t = new LiveSideTagger();
        Q2(t, 2.5, 100, 100.25);
        Q2(t, 3.0, 100.25, 100.5);
        Check(Tag(t, 100.25, 3.0, 100.25, 100.5) == "1/2" && t.DiagJson().Contains("\"liveTieChanged\":1"),
            "live, S3: the trade's own quote update delivered first is not used (a buy, not a sell); liveTieChanged counts it (" + t.DiagJson() + ")");
        // The forum's case: updates stamped after the trade (.413) delivered before it (.412): never used.
        Q2(t, 4.413, 101, 101.25);
        Check(Tag(t, 100.5, 4.412, 0, 0) == "1/2" && t.DiagJson().Contains("\"quoteAfterTrade\":1"),
            "live: a quote stamped after the trade is never used (the 3.000 quote 100.25 / 100.5 stands: at the ask, a buy); quoteAfterTrade counts it");
        // Stale: nothing for over 60 s before the trade (a hole, a disconnect): the tick rule, counted.
        Check(Tag(t, 101, 70, 0, 0) == "1/3" && t.DiagJson().Contains("\"staleQuotes\":1"), "live: a quote over 60 s old is stale: the tick rule (up), counted");
        // A reset (NinjaTrader's IsReset) forgets the quote.
        Q2(t, 71, 101, 101.25);
        t.ClearQuote();
        Check(Tag(t, 101, 71.5, 0, 0) == "1/3" && t.DiagJson().Contains("\"quoteResets\":1"), "live: after a reset the old quote is not used");
        // A burst of more updates than the tagger keeps, all at the trade's time: the quote from before the burst still stands.
        t = new LiveSideTagger();
        Q2(t, 5.0, 100, 100.25);
        for (int i = 0; i < 400; i++) Q2(t, 6.0, 100 + (i % 3) * 0.25, 100.75 + (i % 3) * 0.25);
        Q2(t, 6.0, 100.5, 101.25);
        Check(Tag(t, 100.25, 6.0, 0, 0) == "1/2", "live: 800 updates at the trade's own time: the quote from before them (100 / 100.25) still decides");
        Check(Tag(t, 100.5, 6.5, 0, 0) == "-1/2", "live: and the next trade uses the last of them (bid 100.5 / ask 101.25: at the bid, a sell)");

        // S3: the reorder live (updates at a trade's time delivered first): each trade by the quote stamped before it (the
        // sides the removed backfill join gave the same trades, 0.3.4 to 0.3.6).
        double[][] qb = { R(1, 100), R(3, 100.25), R(4, 100) }, qa = { R(1, 100.25), R(3, 100.5), R(4, 100.25) };
        double[][] tr = { R(2, 100.25), R(3, 100.25), R(3.5, 100.25), R(3.6, 100.375), R(4, 100.25), R(4.2, 100) };
        t = new LiveSideTagger();
        List<string> live = new List<string>();
        int qi = 0;
        foreach (double[] x in tr)
        {
            while (qi < qb.Length && qb[qi][0] <= x[0]) { Q2(t, qb[qi][0], qb[qi][1], qa[qi][1]); qi++; }   // updates at the trade's time delivered first
            live.Add(Tag(t, x[1], x[0], 0, 0));
        }
        Check(string.Join(" ", live) == "1/2 1/2 -1/2 1/3 -1/2 -1/2", "live: each trade by the quote stamped before it, whatever the delivery order (" + string.Join(" ", live) + ")");
    }

    static double[] R(double t, double p) { return new double[] { t, p }; }

    // ------------------------------------------------------------ whole loads
    static ChartBridgeClient client;
    static Instrument inst;
    static List<string> sent;
    static object Priv(string name, params object[] args) { return typeof(ChartBridgeServer).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, args); }
    static void Md(MarketDataType type, double s, double p, long v, double eb, double ea)
    {
        Priv("OnMarketData", null, new MarketDataEventArgs { Instrument = inst, MarketDataType = type, Price = p, Volume = v, Time = At(s), Bid = eb, Ask = ea });
    }
    static void Quote(double s, double bid, double ask) { Md(MarketDataType.Bid, s, bid, 5, bid, ask); Md(MarketDataType.Ask, s, ask, 5, bid, ask); }
    static void Trade(double s, double p, long v) { Md(MarketDataType.Last, s, p, v, 0, 0); }
    static List<string> Sent() { lock (sent) return sent.ToList(); }
    static bool WaitFor(Func<bool> ok) { for (int i = 0; i < 300 && !ok(); i++) Thread.Sleep(10); return ok(); }
    static List<BarsRequest> Made(int from) { lock (BarsRequest.Made) return BarsRequest.Made.Skip(from).ToList(); }
    static int MadeCount() { lock (BarsRequest.Made) return BarsRequest.Made.Count; }
    static BarsRequest Kind(int from, MarketDataType t, int nth) { return Made(from).Where(r => r.BarsPeriod != null && r.BarsPeriod.MarketDataType == t).Skip(nth).FirstOrDefault(); }
    static Bars Minutes(params double[][] rows) { Bars b = new Bars(); foreach (double[] r in rows) b.Add(At(r[0]), r[1], r[2], r[3], r[4], (long)r[5]); return b; }
    static Bars Rows(params double[][] rows) { Bars b = new Bars(); foreach (double[] r in rows) b.Add(At(r[0]), r[1], r[1], r[1], r[1], r.Length > 2 ? (long)r[2] : 1); return b; }
    static int Index(List<string> l, string has) { return l.FindIndex(x => x.Contains(has)); }
    static string Diag() { return (string)Priv("DiagJson"); }

    public static void Load(Action<bool, string> check, ChartBridgeClient c, Instrument i, List<string> s)
    {
        Check = check; client = c; inst = i; sent = s;
        // 0.3.7: the by-date tick load and its Bid and Ask history (quoteHours) are gone, and their load cases with them; the
        // join's rules stay as pure cases above. These loads run on minute charts, and the 600,000-trade one on the served window.
        T0 = RecentBase(DateTime.UtcNow);
        try { LoadMinute(); LoadOutbox(); LoadReset(); LoadMemory(); LoadTape(); }
        finally { Reset(); T0 = MidSession; }
    }

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        typeof(ChartBridgeTime).GetField("et", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, TimeZoneInfo.FindSystemTimeZoneById("America/New_York"));
        T0 = MidSession;
        AnyHour();
        Pure();
        Live();
        TapePure();
        Session();
        Lanes();
    }

    // The same at any hour: the pure rules' T0 is mid-session, and the loads' base, worked out for every minute of a winter,
    // a summer and both clock-change days, has trades from 1 minute before to 5 minutes after it in one session, 5 to 40
    // minutes before that minute.
    static void AnyHour()
    {
        DateTime ms, me;
        SessionClock.Bounds(MidSession, out ms, out me);
        bool mid = TimeZoneInfo.ConvertTimeFromUtc(ChartBridgeTime.ToUtc(MidSession), NewYork) == new DateTime(2026, 9, 29, 11, 0, 0) && MidSession - ms > TimeSpan.FromHours(16) && me - MidSession > TimeSpan.FromHours(6);
        int bad = 0; string first = null;
        foreach (DateTime day in new[] { new DateTime(2026, 1, 13), new DateTime(2026, 3, 8), new DateTime(2026, 7, 14), new DateTime(2026, 11, 1) })
            for (int m = 0; m < 24 * 60; m++)
            {
                DateTime utc = TimeZoneInfo.ConvertTimeToUtc(day, NewYork).AddMinutes(m);
                DateTime b = RecentBase(utc), st, en;
                SessionClock.Bounds(b.AddMinutes(-1), out st, out en);
                double back = (utc - ChartBridgeTime.ToUtc(b)).TotalMinutes;
                if (b.AddMinutes(5) >= en || back < 5 || back > 40) { bad++; if (first == null) first = utc.ToString("yyyy-MM-dd HH:mm") + " UTC: base " + b.ToString("HH:mm:ss"); }
            }
        Check(mid && bad == 0, "the same at any hour: the pure rules run at 11:00 ET mid-session; the loads' base never straddles 18:00 ET and stays recent, for every minute of 4 days (" + bad + " bad" + (first != null ? ", first " + first : "") + ")");
    }

    // ------------------------------------------------------------ the 18:00 ET session (Anthony's ruling, 2026-09-30)
    // NinjaTrader time for a New York wall clock time (the stand-in's NinjaTrader zone is the PC's).
    static DateTime Et(int y, int mo, int d, int h, int mi, double sec)
    {
        DateTime wall = new DateTime(y, mo, d, h, mi, 0, DateTimeKind.Unspecified).AddTicks((long)Math.Round(sec * TimeSpan.TicksPerSecond));
        return DateTime.SpecifyKind(TimeZoneInfo.ConvertTimeFromUtc(TimeZoneInfo.ConvertTimeToUtc(wall, ChartBridgeTime.Eastern), NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo), DateTimeKind.Unspecified);
    }

    static void Session()
    {
        // The review's reopen print: 100.25 at 16:59:59 ET (a buy at the ask), then the 18:00:00 reopening print at 101 with
        // no fresh quote. Nothing carries across the break: side 0.
        DateTime close = Et(2026, 9, 29, 16, 59, 59), open = Et(2026, 9, 29, 18, 0, 0);
        LiveSideTagger t = new LiveSideTagger();
        t.NoteQuote(true, 100, close.AddSeconds(-1)); t.NoteQuote(false, 100.25, close.AddSeconds(-1));
        int m1, m2;
        int s1 = t.Tag(100.25, close, 0, 0, out m1), s2 = t.Tag(101, open, 0, 0, out m2);
        int m3; int s3 = t.Tag(101.25, open.AddSeconds(1), 0, 0, out m3);
        Check(s1 == 1 && m1 == Q && s2 == 0 && m2 == N && s3 == 1 && m3 == TR,
            "session, live: the 18:00 ET reopening print with no fresh quote is side 0 (not a buy against the previous session); the next up-tick a buy (" + s2 + "/" + m2 + ", " + s3 + "/" + m3 + ")");
        // DST: the boundary is 18:00 New York time on the day, whatever the offset.
        foreach (int[] d in new[] { new[] { 2026, 3, 8 }, new[] { 2026, 11, 1 }, new[] { 2026, 3, 9 }, new[] { 2026, 11, 2 } })
        {
            SessionClock c = new SessionClock();
            bool a = c.NewSession(Et(d[0], d[1], d[2], 17, 59, 59.999)), b = c.NewSession(Et(d[0], d[1], d[2], 18, 0, 0)), again = c.NewSession(Et(d[0], d[1], d[2], 23, 0, 0));
            Check(!a && b && !again, "session, DST: " + d[0] + "-" + d[1] + "-" + d[2] + " 17:59:59.999 ET and 18:00:00 ET are different sessions, 23:00 the same as 18:00");
        }
        DateTime st, en;
        SessionClock.Bounds(Et(2026, 3, 8, 12, 0, 0), out st, out en);
        Check(Math.Abs((en - st).TotalHours - 23) < 0.001 && st == Et(2026, 3, 7, 18, 0, 0), "session, DST: the session holding the spring-forward (2026-03-08) is 23 hours, from 18:00 ET the day before");
        SessionClock.Bounds(Et(2026, 11, 1, 12, 0, 0), out st, out en);
        Check(Math.Abs((en - st).TotalHours - 25) < 0.001 && en == Et(2026, 11, 1, 18, 0, 0), "session, DST: the session holding the fall-back (2026-11-01) is 25 hours, to 18:00 ET that day");
        SessionClock w = new SessionClock();
        Check(!w.NewSession(Et(2026, 10, 2, 16, 59, 0)) && w.NewSession(Et(2026, 10, 4, 18, 0, 1)), "session: Friday's close and Sunday's 18:00 open are different sessions (a weekend)");
    }

    // ------------------------------------------------------------ the page's two send lanes (review 2 S1)
    class TimedSocket : System.Net.WebSockets.WebSocket
    {
        public double Us; public volatile bool Hang, Aborted;   // Aborted: ChartBridge ended the connection (the page sees it)
        public Func<string, double> Per;                 // time per message by its text (overrides Us)
        public int ThrowOnce;                            // 1: the next send fails (not a cancel), the socket stays open
        public readonly System.Diagnostics.Stopwatch Clock = System.Diagnostics.Stopwatch.StartNew();
        public readonly List<string> Got = new List<string>();
        public readonly List<long> At = new List<long>();
        public TimedSocket(double us) { Us = us; }
        public override System.Net.WebSockets.WebSocketCloseStatus? CloseStatus { get { return null; } }
        public override string CloseStatusDescription { get { return null; } }
        public override System.Net.WebSockets.WebSocketState State { get { return Aborted ? System.Net.WebSockets.WebSocketState.Aborted : System.Net.WebSockets.WebSocketState.Open; } }
        public override string SubProtocol { get { return null; } }
        public override void Abort() { Aborted = true; }
        public override System.Threading.Tasks.Task CloseAsync(System.Net.WebSockets.WebSocketCloseStatus s, string d, CancellationToken c) { return System.Threading.Tasks.Task.FromResult(0); }
        public override System.Threading.Tasks.Task CloseOutputAsync(System.Net.WebSockets.WebSocketCloseStatus s, string d, CancellationToken c) { return System.Threading.Tasks.Task.FromResult(0); }
        public override void Dispose() { }
        public override System.Threading.Tasks.Task<System.Net.WebSockets.WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> b, CancellationToken c) { return new System.Threading.Tasks.TaskCompletionSource<System.Net.WebSockets.WebSocketReceiveResult>().Task; }
        public override System.Threading.Tasks.Task SendAsync(ArraySegment<byte> b, System.Net.WebSockets.WebSocketMessageType t, bool end, CancellationToken c)
        {
            if (Interlocked.Exchange(ref ThrowOnce, 0) == 1) throw new InvalidOperationException("simulated send failure");
            if (Hang) return new System.Threading.Tasks.TaskCompletionSource<int>().Task;   // a page that stopped reading
            c.ThrowIfCancellationRequested();
            string text = System.Text.Encoding.UTF8.GetString(b.Array, b.Offset, b.Count);
            double us = Per != null ? Per(text) : Us;
            if (us >= 20000) Thread.Sleep((int)(us / 1000));
            else { System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew(); while (sw.Elapsed.TotalMilliseconds < us / 1000.0) { } }
            lock (Got) { Got.Add(text); At.Add(Clock.ElapsedTicks); }
            return System.Threading.Tasks.Task.FromResult(0);
        }
        public int Count { get { lock (Got) return Got.Count; } }
        public double MsAt(string has) { lock (Got) { int i = Got.FindIndex(x => x.Contains(has)); return i < 0 ? -1 : At[i] * 1000.0 / System.Diagnostics.Stopwatch.Frequency; } }
    }
    static int laneId = 70000;
    static bool ClosedLog(int id) { lock (NinjaTrader.Code.Output.Lines) return NinjaTrader.Code.Output.Lines.Any(x => x.Contains("Client " + id + " is not keeping up")); }
    static string LaneTick(int i) { return "{\"type\":\"tick\",\"root\":\"MNQ\",\"t\":1.000,\"u\":1.000,\"rx\":1.000,\"p\":20000.25,\"v\":1,\"s\":1,\"sm\":2,\"i\":" + i + "}"; }

    // held: trades released at ready (SendAll); us: the page's time per message; rate: live trades a second after ready for
    // secs; replyAtMs: when an order reply is sent after ready. Returns (closed, reply delay ms, delivered, live delivered in order).
    static string Race(int held, double us, int rate, double secs, double replyAtMs, out bool closed, out double replyMs)
    {
        TimedSocket sock = new TimedSocket(us);
        int id = Interlocked.Increment(ref laneId);
        ChartBridgeClient c = new ChartBridgeClient(sock, id);
        System.Threading.Tasks.Task loop = System.Threading.Tasks.Task.Run(() => c.SendLoop());
        List<string> burst = new List<string> { "{\"type\":\"ready\",\"root\":\"MNQ\",\"sub\":1}" };
        for (int i = 0; i < held; i++) burst.Add(LaneTick(i));
        System.Diagnostics.Stopwatch clock = sock.Clock;
        double t0 = clock.Elapsed.TotalMilliseconds;
        c.SendAll(burst);
        int liveSent = 0;
        System.Threading.Tasks.Task live = System.Threading.Tasks.Task.Run(() =>
        {
            long n = (long)(rate * secs);
            for (long k = 0; k < n; k++)
            {
                double due = t0 + k * 1000.0 / rate;
                while (clock.Elapsed.TotalMilliseconds < due) Thread.SpinWait(20);
                c.Send(LaneTick(1000000 + (int)k)); liveSent++;
            }
        });
        while (clock.Elapsed.TotalMilliseconds < t0 + replyAtMs) Thread.SpinWait(20);
        double sentAt = clock.Elapsed.TotalMilliseconds;
        c.Send("{\"type\":\"order\",\"id\":\"x\",\"state\":\"working\"}");
        live.Wait();
        int want = held + 2 + liveSent;
        for (int i = 0; i < 3000 && sock.Count < want && !ClosedLog(id); i++) Thread.Sleep(5);
        closed = ClosedLog(id);
        double got = sock.MsAt("\"type\":\"order\"");
        replyMs = got < 0 ? -1 : got - sentAt;
        List<string> all; lock (sock.Got) all = sock.Got.ToList();
        List<int> ids = all.Where(x => x.Contains("\"i\":")).Select(x => int.Parse(x.Substring(x.IndexOf("\"i\":") + 4).TrimEnd('}'))).ToList();
        bool inOrder = ids.Zip(ids.Skip(1), (a, b) => a < b).All(x => x);
        c.Close();
        try { loop.Wait(2000); } catch (Exception) { }
        return "held " + held + ", " + us + " us/message, live " + rate + "/s: closed " + closed + ", reply after " + replyMs.ToString("0.0") + " ms, delivered " + all.Count + " of " + want + ", data in order " + inOrder;
    }

    static void Lanes()
    {
        bool closed; double reply;
        // The review's rows: an order reply sent during a 20,000-trade release reaches the page within a few ms.
        foreach (double us in new[] { 20.0, 200.0 })
        {
            string r = Race(20000, us, 0, 0, 5, out closed, out reply);
            Console.WriteLine("     (" + r + ")");
            // under 50 ms: the next message boundary is 0.2 ms away; the rest is room for the scheduler (review 4 N1). 0.3.3
            // closed this page; the first 0.3.4 round delivered the reply 0.45 s and 4.1 s late.
            Check(!closed && reply >= 0 && reply < 50, "lanes: an order reply sent 5 ms into a 20,000-trade release at " + us + " us a message arrives " + reply.ToString("0.0") + " ms later (at the next message boundary)");
        }
        // Live trades keep coming after ready while the release drains; the page keeps up in steady state. 30 us a message is
        // the page's real pace (review 3 measured 26 to 31 us a live trade): 20,000 drain in about 0.6 s. At 200 us (a slow
        // page) the last trades wait about 4 s, still under the 5 s rule.
        foreach (double[] rr in new[] { new[] { 30.0, 3000 }, new[] { 200.0, 1500 } })
        {
            string r = Race(20000, rr[0], (int)rr[1], 5, 4500, out closed, out reply);
            Console.WriteLine("     (" + r + ")");
            Check(!closed && reply >= 0 && reply < 50 && r.Contains("data in order True"),
                "lanes: 20,000 released at " + rr[0] + " us a message with " + rr[1] + " live trades/s after ready: not closed, every data message in order, the order reply " + reply.ToString("0.0") + " ms");
        }
        // Order within and across lanes: data never goes ahead of an order-lane message sent before it; each lane is FIFO.
        TimedSocket s = new TimedSocket(50);
        ChartBridgeClient c = new ChartBridgeClient(s, Interlocked.Increment(ref laneId));
        List<string> tapped = new List<string>();
        c.Tap = x => tapped.Add(x);
        for (int i = 0; i < 200; i++) c.Send(LaneTick(i));
        c.Send("{\"type\":\"order\",\"id\":\"a\"}"); c.Send("{\"type\":\"exec\",\"id\":\"b\"}"); c.Send("{\"type\":\"position\",\"id\":\"c\"}");
        c.Send(LaneTick(200));
        System.Threading.Tasks.Task lp = System.Threading.Tasks.Task.Run(() => c.SendLoop());
        for (int i = 0; i < 400 && s.Count < 204; i++) Thread.Sleep(5);
        List<string> got; lock (s.Got) got = s.Got.ToList();
        int ia = got.FindIndex(x => x.Contains("\"id\":\"a\"")), ib = got.FindIndex(x => x.Contains("\"id\":\"b\"")), ic = got.FindIndex(x => x.Contains("\"id\":\"c\"")), i200 = got.FindIndex(x => x.Contains("\"i\":200}"));
        Check(got.Count == 204 && ia <= 1 && ib == ia + 1 && ic == ib + 1 && i200 == 203 && tapped.Count == 204,
            "lanes: order-lane messages go out first, in their own order (order, exec, position at " + ia + ", " + ib + ", " + ic + "); the data sent after them comes after them (" + i200 + "); Tap saw every message in call order");
        // Send and Close unchanged: after Close, Send does nothing (Tap still sees it, as before).
        c.Close();
        int before = s.Count;
        c.Send("{\"type\":\"order\",\"id\":\"late\"}"); c.Send(LaneTick(999));
        Thread.Sleep(30);
        Check(s.Count == before && tapped.Count == 206, "lanes: after Close nothing more is sent (Send returns quietly, as before)");
        try { lp.Wait(1000); } catch (Exception) { }
        foreach (string x in new[] { "{\"type\":\"hello\"", "{\"type\":\"trading\"", "{\"type\":\"orders\"", "{\"type\":\"order\"", "{\"type\":\"position\"", "{\"type\":\"reject\"", "{\"type\":\"exec\"", "{\"type\":\"execs\"", "{\"type\":\"status\"", "{\"type\":\"pong\"" })
            Check(ChartBridgeClient.OrderLane(x + ",\"x\":1}"), "lanes: " + x.Substring(9) + " is in the order lane");
        foreach (string x in new[] { "{\"type\":\"tick\"", "{\"type\":\"ticks\"", "{\"type\":\"history\"", "{\"type\":\"ready\"", "{\"type\":\"orderx\"", "not json" })
            Check(!ChartBridgeClient.OrderLane(x + ",\"x\":1}"), "lanes: " + x + " is market data (FIFO as before)");

        // A page that stopped reading is still closed: 5,000 waiting while one send has been stuck for over 2 s.
        TimedSocket hung = new TimedSocket(0) { Hang = true };
        int hid = Interlocked.Increment(ref laneId);
        ChartBridgeClient hc = new ChartBridgeClient(hung, hid);
        System.Threading.Tasks.Task hl = System.Threading.Tasks.Task.Run(() => hc.SendLoop());
        for (int i = 0; i < 5100; i++) hc.Send(LaneTick(i));
        Check(!ClosedLog(hid), "lanes: a stuck page is not closed before its send has hung for 2 s");
        Thread.Sleep(2300);
        hc.Send(LaneTick(-1));
        Check(ClosedLog(hid), "lanes: a page whose send has hung over 2 s with 5,000 waiting is closed, not keeping up");
        hc.Close();
        SlowPages();
        LoadPace();
        Adversarial();
        ReloadAtRate();
        RandomClose();
    }

    // Review 3, round 3: a page more than 5 s behind is reconnected. A page that keeps draining, but slower than the market
    // (3,000 trades a second), is closed about 5 s behind; the Output line gives the lag.
    static void SlowPages()
    {
        foreach (double us in new[] { 1000.0, 400.0 })
        {
            TimedSocket s = new TimedSocket(us);
            int id = Interlocked.Increment(ref laneId);
            ChartBridgeClient c = new ChartBridgeClient(s, id);
            System.Threading.Tasks.Task loop = System.Threading.Tasks.Task.Run(() => c.SendLoop());
            System.Diagnostics.Stopwatch clock = s.Clock;
            double t0 = clock.Elapsed.TotalMilliseconds, closedAt = -1, maxAge = 0;
            long k = 0;
            while (clock.Elapsed.TotalMilliseconds - t0 < 60000)
            {
                double now = clock.Elapsed.TotalMilliseconds - t0;
                while (k < now * 3.0) { c.Send(LaneTick((int)k)); k++; }
                if (ClosedLog(id)) { closedAt = now; break; }
                maxAge = Math.Max(maxAge, c.DataAgeMs());
                Thread.Sleep(1);
            }
            string line; lock (NinjaTrader.Code.Output.Lines) line = NinjaTrader.Code.Output.Lines.FirstOrDefault(x => x.Contains("Client " + id + " is not keeping up"));
            Console.WriteLine("     (slow page, " + (1e6 / us).ToString("0") + " messages/s against 3,000 trades/s: closed after " + (closedAt / 1000).ToString("0.0") + " s, the oldest waiting trade " + (maxAge / 1000).ToString("0.0") + " s old; " + line + ")");
            Check(closedAt > 0 && maxAge < 5600 && line != null && line.Contains(" s behind; closing it (the page reconnects and reloads).") && WaitFor(() => s.Aborted),
                "lag: a page at " + (1e6 / us).ToString("0") + " messages/s against 3,000 trades/s is closed about 5 s behind (after " + (closedAt / 1000).ToString("0.0") + " s), with its lag in the Output line");
            c.Close();
            try { loop.Wait(2000); } catch (Exception) { }
        }
    }

    // A load's history and ticks chunks go out back to back at the page's pace; their wait does not count as lag. A 48 h
    // backfill (130 chunks of 20,000 trades, about 600 KB each; about 2.6 million trades), then ready and 20,000 held
    // trades, with live trades after it. The page's measured pace for such a chunk in Chromium is about 3.5 ms (JSON.parse
    // and the tick store); here 50 ms (a PC 14 times slower), so the whole load takes about 7 s, and is not closed.
    static void LoadPace()
    {
        foreach (double chunkMs in new[] { 3.5, 50.0 })
        {
            TimedSocket s = new TimedSocket(30);
            s.Per = m => m.StartsWith("{\"type\":\"ticks\"") || m.StartsWith("{\"type\":\"history\"") ? chunkMs * 1000 : 30;
            int id = Interlocked.Increment(ref laneId);
            ChartBridgeClient c = new ChartBridgeClient(s, id);
            System.Threading.Tasks.Task loop = System.Threading.Tasks.Task.Run(() => c.SendLoop());
            string chunk = "{\"type\":\"ticks\",\"root\":\"MNQ\",\"ticks\":[[1,2,3,1,2]],\"done\":false}";
            for (int i = 0; i < 20; i++) c.Send("{\"type\":\"history\",\"root\":\"MNQ\",\"bars\":[],\"done\":false}");
            for (int i = 0; i < 130; i++) c.Send(chunk);
            List<string> burst = new List<string> { "{\"type\":\"ready\",\"root\":\"MNQ\",\"sub\":1}" };
            for (int i = 0; i < 20000; i++) burst.Add(LaneTick(i));
            c.SendAll(burst);
            System.Diagnostics.Stopwatch w = System.Diagnostics.Stopwatch.StartNew();
            double maxAge = 0; long k = 0;
            int want = 20 + 130 + 20001;
            while (s.Count < want + (int)k && w.Elapsed.TotalSeconds < 30 && !ClosedLog(id))
            {
                while (k < w.Elapsed.TotalMilliseconds * 1.0) { c.Send(LaneTick(1000000 + (int)k)); k++; }   // 1,000 live trades a second
                maxAge = Math.Max(maxAge, c.DataAgeMs());
                Thread.Sleep(1);
            }
            Console.WriteLine("     (48 h load at " + chunkMs + " ms a chunk: drained in " + w.Elapsed.TotalSeconds.ToString("0.0") + " s, the oldest waiting entry at most " + (maxAge / 1000).ToString("0.00") + " s, closed " + ClosedLog(id) + ")");
            Check(!ClosedLog(id) && s.Count >= want, "lag: a 48 h load (130 chunks at " + chunkMs + " ms each), then a 20,000-trade release and live trades: not closed (drained in " + w.Elapsed.TotalSeconds.ToString("0.0") + " s, lag at most " + (maxAge / 1000).ToString("0.00") + " s)");
            c.Close();
            try { loop.Wait(2000); } catch (Exception) { }
        }
    }

    // Review 3's adversarial cases (Lanes3.cs), folded in: Close in the middle of a release, lost wakeups, cross-thread
    // order, a Send racing a Close, and a send that fails.
    static void Adversarial()
    {
        // Close mid-batch.
        TimedSocket s = new TimedSocket(200);
        ChartBridgeClient c = new ChartBridgeClient(s, Interlocked.Increment(ref laneId));
        System.Threading.Tasks.Task loop = System.Threading.Tasks.Task.Run(() => c.SendLoop());
        List<string> burst = new List<string> { "{\"type\":\"ready\",\"root\":\"MNQ\",\"sub\":1}" };
        for (int i = 0; i < 20000; i++) burst.Add(LaneTick(i));
        c.SendAll(burst);
        Thread.Sleep(100);
        c.Send("{\"type\":\"order\",\"id\":\"o1\"}");
        Thread.Sleep(5);
        c.Close();
        bool ended = loop.Wait(2000);
        int atClose = s.Count;
        Exception thrown = null;
        try { c.Send("{\"type\":\"order\",\"id\":\"o2\"}"); c.Send(LaneTick(-1)); c.SendAll(new List<string> { LaneTick(-2) }); c.SendData(LaneTick(-3)); } catch (Exception ex) { thrown = ex; }
        Thread.Sleep(30);
        bool o1; lock (s.Got) o1 = s.Got.Any(x => x.Contains("\"id\":\"o1\""));
        Check(ended && !loop.IsFaulted && s.Count == atClose && o1 && thrown == null,
            "adversarial: Close mid-release ends the send loop cleanly (sent " + atClose + " of 20,002), nothing after it, the order reply queued before it delivered, Send/SendAll/SendData after it quiet");

        // Lost wakeups: an order-lane message sent alone from another thread, the loop parked or busy.
        TimedSocket ws = new TimedSocket(0);
        ChartBridgeClient wc = new ChartBridgeClient(ws, Interlocked.Increment(ref laneId));
        System.Threading.Tasks.Task wl = System.Threading.Tasks.Task.Run(() => wc.SendLoop());
        Random rnd = new Random(7);
        int missed = 0; double worst = 0;
        for (int i = 0; i < 3000; i++)
        {
            int mode = rnd.Next(3);
            if (mode == 1) wc.Send(LaneTick(i));
            if (mode == 2) { int j = i; System.Threading.Tasks.Task.Run(() => wc.Send(LaneTick(j))); }
            string msg = "{\"type\":\"order\",\"id\":\"w" + i + "\"}";
            System.Threading.Tasks.Task.Run(() => wc.Send(msg));
            System.Diagnostics.Stopwatch w = System.Diagnostics.Stopwatch.StartNew();
            bool got = false;
            while (w.Elapsed.TotalMilliseconds < 200) { lock (ws.Got) { if (ws.Got.Count > 0 && ws.Got.Contains(msg)) { got = true; break; } } Thread.SpinWait(50); }
            if (!got) missed++; else worst = Math.Max(worst, w.Elapsed.TotalMilliseconds);
            lock (ws.Got) { ws.Got.Clear(); ws.At.Clear(); }
        }
        Check(missed == 0, "adversarial: 3,000 order-lane messages each sent alone from another thread: none lost (worst " + worst.ToString("0.0") + " ms)");
        wc.Close();

        // Cross-thread order: thread A sends order O_k, thread B then sends data D_k, during a 20,000 release.
        TimedSocket xs = new TimedSocket(5);
        ChartBridgeClient xc = new ChartBridgeClient(xs, Interlocked.Increment(ref laneId));
        System.Threading.Tasks.Task xl = System.Threading.Tasks.Task.Run(() => xc.SendLoop());
        List<string> rel = new List<string>();
        for (int i = 0; i < 20000; i++) rel.Add("{\"type\":\"tick\",\"b\":" + i + "}");
        xc.SendAll(rel);
        int n = 5000, done = -1;
        System.Threading.Tasks.Task ta = System.Threading.Tasks.Task.Run(() => { for (int k = 0; k < n; k++) { xc.Send("{\"type\":\"order\",\"k\":" + k + "}"); Volatile.Write(ref done, k); } });
        System.Threading.Tasks.Task tb = System.Threading.Tasks.Task.Run(() => { for (int k = 0; k < n; k++) { while (Volatile.Read(ref done) < k) Thread.SpinWait(5); xc.Send("{\"type\":\"tick\",\"k\":" + k + "}"); } });
        System.Threading.Tasks.Task.WaitAll(ta, tb);
        for (int i = 0; i < 3000 && xs.Count < 20000 + 2 * n; i++) Thread.Sleep(10);
        List<string> got2; lock (xs.Got) got2 = xs.Got.ToList();
        Dictionary<string, int> pos = new Dictionary<string, int>();
        for (int i = 0; i < got2.Count; i++) pos[got2[i]] = i;
        int bad = 0;
        for (int k = 0; k < n; k++)
        {
            string o = "{\"type\":\"order\",\"k\":" + k + "}", d = "{\"type\":\"tick\",\"k\":" + k + "}";
            if (!pos.ContainsKey(o) || !pos.ContainsKey(d) || pos[o] > pos[d]) bad++;
            if (k > 0 && (pos[o] < pos["{\"type\":\"order\",\"k\":" + (k - 1) + "}"] || pos[d] < pos["{\"type\":\"tick\",\"k\":" + (k - 1) + "}"])) bad++;
        }
        for (int i = 1; i < 20000; i++) if (pos["{\"type\":\"tick\",\"b\":" + i + "}"] < pos["{\"type\":\"tick\",\"b\":" + (i - 1) + "}"]) bad++;
        Check(got2.Count == 20000 + 2 * n && bad == 0, "adversarial: 5,000 order/data pairs from two threads during a 20,000 release: every message delivered, no data ahead of its order, each lane in order (" + bad + " violations)");
        xc.Close();

        // A Send racing a Close never throws (review 3 S2: it used to, out of the broadcast loops).
        foreach (string msg in new[] { "{\"type\":\"order\",\"id\":\"x\"}", "{\"type\":\"tick\",\"p\":1}" })
        {
            int threw = 0; string kind = "";
            for (int r = 0; r < 3000; r++)
            {
                ChartBridgeClient rc = new ChartBridgeClient(new TimedSocket(0), Interlocked.Increment(ref laneId));
                ManualResetEventSlim go = new ManualResetEventSlim();
                System.Threading.Tasks.Task closer = System.Threading.Tasks.Task.Run(() => { go.Wait(); rc.Close(); });
                go.Set();
                try { for (int i = 0; i < 200; i++) rc.Send(msg); rc.SendAll(new List<string> { msg }); rc.SendData(msg); }
                catch (Exception ex) { threw++; kind = ex.GetType().Name; }
                closer.Wait();
            }
            Check(threw == 0, "adversarial: Send racing Close, 3,000 rounds (" + ChartBridgeClient.TypeOf(msg) + "): no throw (" + threw + " " + kind + ")");
        }

        // A send that fails (not a cancel) with the socket still open: the page is closed so it reconnects (review 3 N1).
        TimedSocket fs = new TimedSocket(0) { ThrowOnce = 1 };
        int fid = Interlocked.Increment(ref laneId);
        ChartBridgeClient fc = new ChartBridgeClient(fs, fid);
        System.Threading.Tasks.Task fl = System.Threading.Tasks.Task.Run(() => fc.SendLoop());
        fc.Send(LaneTick(0));
        bool fended = fl.Wait(2000);
        bool flog; lock (NinjaTrader.Code.Output.Lines) flog = NinjaTrader.Code.Output.Lines.Any(x => x.Contains("Client " + fid + " send stopped: simulated send failure; closing it."));
        int fbefore = fs.Count;
        fc.Send("{\"type\":\"order\",\"id\":\"after\"}");
        Check(fended && flog && fs.Count == fbefore && fs.Aborted, "adversarial: a failed send ends the connection (socket aborted, so the page reconnects) instead of leaving it connected and silent");
    }

    // Review 4 B1: the reload after a lag close, at 3,000 trades a second. The held trades are the load's seconds times the
    // rate (WORK: a 29.8 s load, about 90,000), released after "ready" at the page's pace, with live trades behind them. The
    // release is the page's own bulk data like the load's chunks, so it is not counted as lag: no close, no reload loop.
    // The review's model: 230 chunks at 3.5 ms, a 250 ms page freeze on "ready", then the release at 42 or 84 us a message.
    static void ReloadAtRate()
    {
        foreach (int held in new[] { 90000, 130000 })
            foreach (double us in new[] { 42.0, 84.0 })
            {
                TimedSocket s = new TimedSocket(us);
                s.Per = m => m.StartsWith("{\"type\":\"ticks\"") ? 3500 : m.StartsWith("{\"type\":\"ready\"") ? 250000 : us;
                int id = Interlocked.Increment(ref laneId);
                ChartBridgeClient c = new ChartBridgeClient(s, id);
                System.Threading.Tasks.Task loop = System.Threading.Tasks.Task.Run(() => c.SendLoop());
                for (int i = 0; i < 230; i++) c.Send("{\"type\":\"ticks\",\"root\":\"MNQ\",\"ticks\":[[1,2,3,1,2]],\"done\":false}");
                List<string> burst = new List<string>(held + 1) { "{\"type\":\"ready\",\"root\":\"MNQ\",\"sub\":1}" };
                for (int i = 0; i < held; i++) burst.Add(LaneTick(i));
                c.SendAll(burst);
                System.Diagnostics.Stopwatch w = System.Diagnostics.Stopwatch.StartNew();
                double drain = 230 * 3.5 + 250 + held * us / 1000.0, maxAge = 0;
                long k = 0;
                while (w.Elapsed.TotalMilliseconds < drain + 2500 && !ClosedLog(id))
                {
                    while (k < w.Elapsed.TotalMilliseconds * 3.0) { c.Send(LaneTick(1000000 + (int)k)); k++; }
                    maxAge = Math.Max(maxAge, c.DataAgeMs());
                    Thread.Sleep(1);
                }
                // then wait for the rest to drain (the spinning page can run slower than its nominal pace on a busy CPU)
                for (int i = 0; i < 6000 && s.Count < 230 + held + 1 + (int)k && !ClosedLog(id); i++) Thread.Sleep(10);
                bool closed = ClosedLog(id);
                Console.WriteLine("     (reload at 3,000 trades/s: " + held + " held at " + us + " us a message, drain about " + (drain / 1000).ToString("0.0") + " s: closed " + closed + ", the oldest live wait at most " + (maxAge / 1000).ToString("0.00") + " s, delivered " + s.Count + " of " + (230 + held + 1 + k) + ")");
                Check(!closed && !s.Aborted && s.Count == 230 + held + 1 + (int)k,
                    "lag, B1: a reload holding " + held + " trades at " + us + " us a message with 3,000 live trades/s: not closed, no reload loop, all delivered (the oldest live wait at most " + (maxAge / 1000).ToString("0.00") + " s)");
                c.Close();
                try { loop.Wait(2000); } catch (Exception) { }
            }
        // A truly slow page after a load: its live backlog still ages (bulk sends never hide it) and it is closed about 5 s behind.
        TimedSocket ss = new TimedSocket(1000);
        ss.Per = m => m.StartsWith("{\"type\":\"ticks\"") ? 3500 : 1000;
        int sid = Interlocked.Increment(ref laneId);
        ChartBridgeClient sc = new ChartBridgeClient(ss, sid);
        System.Threading.Tasks.Task sl = System.Threading.Tasks.Task.Run(() => sc.SendLoop());
        for (int i = 0; i < 50; i++) sc.Send("{\"type\":\"ticks\",\"root\":\"MNQ\",\"ticks\":[[1,2,3,1,2]],\"done\":false}");
        sc.SendAll(new List<string> { "{\"type\":\"ready\",\"root\":\"MNQ\",\"sub\":1}", LaneTick(0) });
        System.Diagnostics.Stopwatch sw2 = System.Diagnostics.Stopwatch.StartNew();
        long kk = 0; double at = -1, maxA = 0;
        while (sw2.Elapsed.TotalSeconds < 30)
        {
            while (kk < sw2.Elapsed.TotalMilliseconds * 3.0) { sc.Send(LaneTick(1000000 + (int)kk)); kk++; }
            maxA = Math.Max(maxA, sc.DataAgeMs());
            if (ClosedLog(sid)) { at = sw2.Elapsed.TotalSeconds; break; }
            Thread.Sleep(1);
        }
        Console.WriteLine("     (slow page after a load, 1,000 messages/s against 3,000 trades/s: closed after " + at.ToString("0.0") + " s, " + (maxA / 1000).ToString("0.0") + " s behind)");
        Check(at > 0 && maxA < 5600 && WaitFor(() => ss.Aborted), "lag: a slow page after a load is still closed about 5 s behind (after " + at.ToString("0.0") + " s) and its socket aborted");
        sc.Close();
    }

    // Review 4 B2: a close at a random moment, between two sends or during one, always ends the connection.
    static void RandomClose()
    {
        int open = 0;
        Random rnd = new Random(11);
        for (int r = 0; r < 1000; r++)
        {
            TimedSocket s = new TimedSocket(rnd.Next(3) == 0 ? 0 : 20);
            ChartBridgeClient c = new ChartBridgeClient(s, Interlocked.Increment(ref laneId));
            System.Threading.Tasks.Task loop = System.Threading.Tasks.Task.Run(() => c.SendLoop());
            int n = rnd.Next(1, 40);
            for (int i = 0; i < n; i++) c.Send(LaneTick(i));
            System.Threading.Thread.SpinWait(rnd.Next(1, 20000));
            c.Close();
            try { loop.Wait(1000); } catch (Exception) { }
            if (!s.Aborted) open++;
        }
        Check(open == 0, "close, B2: 1,000 closes at random moments: the socket was left open " + open + " times (the page always sees the close and reconnects)");
    }

    // Review 4 S1: a load's chunks are made and queued a few at a time. A 600,000-trade served window through the real Subscribe,
    // the most chunks ever waiting and the time from NinjaTrader's answer to "ready" at the page, against queuing the whole
    // load at once (BulkWindow unlimited, as before): at the page's measured 3.5 ms a chunk (making a chunk takes longer
    // here, so few wait either way), and at 300 ms a chunk (slower than ChartBridge makes them here, about 75 ms on Mono: the old way queues nearly the whole load).
    static void LoadMemory()
    {
        var clients = (System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
        Bars big = new Bars();
        for (int i = 0; i < 600000; i++) big.Add(At(-3000 + i * 0.005), 100 + (i % 9) * 0.25, 0, 0, 100 + (i % 9) * 0.25, 1);
        int was = ChartBridgeClient.BulkWindow, guessWas = ChartBridgeServer.WindowFirstGuess;
        ChartBridgeServer.WindowFirstGuess = 700000;   // 0.3.7: the served window (by count), asked once: the answer is not full
        try
        {
            foreach (double chunkMs in new[] { 3.5, 300.0 })
            foreach (int window in new[] { int.MaxValue, was })
            {
                Reset();
                ChartBridgeServer.ResetBooks(DateTime.MinValue);   // no served window in memory: each run asks NinjaTrader
                ChartBridgeClient.BulkWindow = window;
                TimedSocket s = new TimedSocket(30);
                s.Per = m => m.StartsWith("{\"type\":\"ticks\"") ? chunkMs * 1000 : 30;
                int id = Interlocked.Increment(ref laneId);
                ChartBridgeClient c = new ChartBridgeClient(s, id);
                clients[id] = c;
                System.Threading.Tasks.Task loop = System.Threading.Tasks.Task.Run(() => c.SendLoop());
                int m0 = MadeCount();
                Priv("Subscribe", c, "MNQ", 1, 8);
                Made(m0)[0].Answer(Minutes(new[] { 60.0, 1, 1, 1, 1, 1 }), ErrorCode.NoError);
                int peak = 0;
                long peakBytes = 0;
                bool stop = false;
                System.Threading.Tasks.Task watch = System.Threading.Tasks.Task.Run(() => { while (!Volatile.Read(ref stop)) { peak = Math.Max(peak, c.BulkQueued); Thread.Sleep(1); } });
                GC.Collect();
                long before = GC.GetTotalMemory(true);
                System.Threading.Tasks.Task mem = System.Threading.Tasks.Task.Run(() => { while (!Volatile.Read(ref stop)) { peakBytes = Math.Max(peakBytes, GC.GetTotalMemory(false) - before); Thread.Sleep(5); } });
                BarsRequest ask = null;
                WaitFor(() => (ask = Made(m0).FirstOrDefault(r => r.BarsBack == 700000)) != null);
                System.Diagnostics.Stopwatch w = System.Diagnostics.Stopwatch.StartNew();
                ask.Answer(big, ErrorCode.NoError);
                bool readyIn = false;
                for (int i = 0; i < 6000 && !readyIn; i++) { readyIn = s.MsAt("\"type\":\"ready\"") >= 0; if (!readyIn) Thread.Sleep(10); }
                double ms = w.Elapsed.TotalMilliseconds;
                Volatile.Write(ref stop, true);
                watch.Wait(); mem.Wait();
                int chunks; long chunkChars;
                lock (s.Got) { chunks = s.Got.Count(x => x.StartsWith("{\"type\":\"ticks\"")); chunkChars = s.Got.Where(x => x.StartsWith("{\"type\":\"ticks\"")).Select(x => (long)x.Length).DefaultIfEmpty(0).Max(); }
                Console.WriteLine("     (600,000-trade load at " + chunkMs + " ms a chunk, " + (window == int.MaxValue ? "whole load queued at once (as before)" : "a window of " + window + " chunks") + ": " + chunks + " chunks of up to " + (chunkChars * 2 / 1048576.0).ToString("0.00") + " MB as .NET strings, at most " + peak + " waiting (" + (peak * chunkChars * 2 / 1048576.0).ToString("0") + " MB), heap growth at most " + (peakBytes / 1048576.0).ToString("0") + " MB, answer to ready at the page " + ms.ToString("0") + " ms)");
                Check(readyIn && chunks == 30 && (window == int.MaxValue || peak <= window), "memory, S1: " + chunkMs + " ms a chunk, " + (window == int.MaxValue ? "unlimited" : "window " + window) + ": at most " + peak + " chunks waiting, ready at the page after " + ms.ToString("0") + " ms");
                ChartBridgeClient gone; clients.TryRemove(id, out gone);
                c.Close();
                try { loop.Wait(2000); } catch (Exception) { }
            }
        }
        finally { ChartBridgeClient.BulkWindow = was; ChartBridgeServer.WindowFirstGuess = guessWas; ChartBridgeServer.ResetBooks(DateTime.MinValue); Reset(); }
    }

    // S1: the held live trades are released with "ready" as one outbox entry: a burst of any size cannot fill the page's
    // 5,000-message outbox and close it (the review's Outbox.cs shape: a page that drains like a real socket, about 20 us
    // a message).
    class SlowSocket : System.Net.WebSockets.WebSocket
    {
        public int Sent;
        public readonly List<string> Got = new List<string>();
        public override System.Net.WebSockets.WebSocketCloseStatus? CloseStatus { get { return null; } }
        public override string CloseStatusDescription { get { return null; } }
        public override System.Net.WebSockets.WebSocketState State { get { return System.Net.WebSockets.WebSocketState.Open; } }
        public override string SubProtocol { get { return null; } }
        public override void Abort() { }
        public override System.Threading.Tasks.Task CloseAsync(System.Net.WebSockets.WebSocketCloseStatus s, string d, CancellationToken c) { return System.Threading.Tasks.Task.FromResult(0); }
        public override System.Threading.Tasks.Task CloseOutputAsync(System.Net.WebSockets.WebSocketCloseStatus s, string d, CancellationToken c) { return System.Threading.Tasks.Task.FromResult(0); }
        public override void Dispose() { }
        public override System.Threading.Tasks.Task<System.Net.WebSockets.WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> b, CancellationToken c) { return new System.Threading.Tasks.TaskCompletionSource<System.Net.WebSockets.WebSocketReceiveResult>().Task; }
        public override System.Threading.Tasks.Task SendAsync(ArraySegment<byte> b, System.Net.WebSockets.WebSocketMessageType t, bool end, CancellationToken c)
        {
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew(); while (sw.Elapsed.TotalMilliseconds < 0.02) { }
            string text = System.Text.Encoding.UTF8.GetString(b.Array, b.Offset, b.Count);
            lock (Got) { if (text.StartsWith("{\"type\":\"tick\"") || text.StartsWith("{\"type\":\"ready\"")) Got.Add(text); }
            Interlocked.Increment(ref Sent); return System.Threading.Tasks.Task.FromResult(0);
        }
    }

    static void LoadOutbox()
    {
        Reset();
        var clients = (System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
        foreach (int n in new[] { 6000, 20000 })
        {
            SlowSocket sock = new SlowSocket();
            int id = 9000 + n;
            ChartBridgeClient c = new ChartBridgeClient(sock, id);
            clients[id] = c;
            System.Threading.Tasks.Task loop = System.Threading.Tasks.Task.Run(() => c.SendLoop());
            try
            {
                int m0 = MadeCount();
                Priv("Subscribe", c, "MNQ", 1, 0);   // 0.3.7: a minute chart (the by-date tick load is gone); its last trades come late
                Made(m0)[0].Answer(Minutes(new[] { 60.0, 1, 1, 1, 1, 1 }), ErrorCode.NoError);
                for (int i = 0; i < n; i++) Md(MarketDataType.Last, 1 + i * 0.002, 20001, 1, 0, 0);   // held while the last trades load
                Kind(m0, MarketDataType.Last, 1).Answer(Rows(Enumerable.Range(0, 30000).Select(i => new[] { -300 + i * 0.009, 20000 + (i % 7) * 0.25, 1 }).ToArray()), ErrorCode.NoError);
                WaitFor(() => { lock (sock.Got) return sock.Got.Count >= n + 1; });
                for (int i = 0; i < 100 && !(sock.Got.Count >= n + 1); i++) Thread.Sleep(50);
                bool closed; lock (NinjaTrader.Code.Output.Lines) closed = NinjaTrader.Code.Output.Lines.Any(x => x.Contains("Client " + id + " is not keeping up"));
                List<string> got; lock (sock.Got) got = sock.Got.ToList();
                bool ordered = got.Count == n + 1 && got[0].StartsWith("{\"type\":\"ready\"") && Enumerable.Range(1, n).All(i => got[i].Contains("\"u\":"));
                Check(!closed && ordered, "outbox: " + n + " live trades held during the load are released after ready without closing the page (" + (got.Count - 1) + " delivered, in order: " + ordered + ", closed: " + closed + ")");
            }
            finally { ChartBridgeClient gone; clients.TryRemove(id, out gone); c.Close(); }
        }
        Reset();
    }

    // Review 2 S2: a reset event (IsReset), whatever its type and price, and a Last event without a real price never reach the
    // order code's last price (ChartBridgeOrders.NoteLast) or the page. The order code itself is unchanged.
    static double OrdersLast()
    {
        var f = typeof(ChartBridgeOrders).GetField("Last", BindingFlags.NonPublic | BindingFlags.Static);
        var d = (System.Collections.IDictionary)f.GetValue(null);
        lock (d) return d.Contains("MNQ") ? ((double[])d["MNQ"])[0] : double.NaN;
    }

    static void LoadReset()
    {
        Reset();
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        Priv("Subscribe", client, "MNQ", 5, 0);
        Made(m0)[0].Answer(Minutes(new[] { 60.0, 1, 1, 1, 1, 1 }), ErrorCode.NoError);
        BarsRequest lt = Made(m0).Skip(1).FirstOrDefault();
        if (lt != null) lt.Answer(Rows(new[] { 1.0, 25000, 1 }), ErrorCode.NoError);
        WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0);
        Trade(2.0, 25000.25, 1);
        int n = Sent().Count;
        Check(OrdersLast() == 25000.25, "reset: a real trade reaches the order code's last price");
        foreach (MarketDataType ty in new[] { MarketDataType.Last, MarketDataType.Bid, MarketDataType.Ask, MarketDataType.DailyVolume })
            Priv("OnMarketData", null, new MarketDataEventArgs { Instrument = inst, MarketDataType = ty, Price = 0, Volume = 0, Time = At(2.5), IsReset = true });
        Check(OrdersLast() == 25000.25 && Sent().Count == n, "reset: IsReset events (Last, Bid, Ask, other, price 0) never reach the order code's last price or the page");
        Check(Diag().Contains("\"quoteResets\":") && OutputLines().Count(x => x.Contains("market data reset (IsReset) on MNQ: type Last, price 0")) == 1
              && OutputLines().Count(x => x.Contains("market data reset (IsReset)")) == 1, "reset: the first reset is logged once, with its type and price");
        Trade(3.0, 0, 5);
        Priv("OnMarketData", null, new MarketDataEventArgs { Instrument = inst, MarketDataType = MarketDataType.Last, Price = -1, Volume = 1, Time = At(3.1) });
        Check(OrdersLast() == 25000.25 && Sent().Count == n, "reset: a Last event at price 0 or below is not a trade: not to the order code, not to the page");
        Trade(4.0, 25000.5, 1);
        Check(OrdersLast() == 25000.5 && Sent().Count == n + 1, "reset: the next real trade goes through as usual");
        string dg = Diag();
        Check(dg.Contains("\"pages\":[") && dg.Contains("{\"id\":77,\"root\":\"MNQ\",\"ready\":true,\"queued\":") && dg.Contains("\"orderLaneQueued\":") && dg.Contains("\"oldestDataMs\":"),
            "diag: each page's queue depth, order-lane depth and oldest waiting market data age (" + dg.Substring(dg.IndexOf("\"pages\""), Math.Min(160, dg.Length - dg.IndexOf("\"pages\""))) + ")");
        Reset();
    }

    // ------------------------------------------------------------ 0.3.8: the Time and Sales category (q)
    static int Cat(double p, double bid, double ask) { return ChartBridgeSides.Category(p, bid, ask); }
    static string TagQ(LiveSideTagger t, double p, double s) { int m, q; int x = t.Tag(p, At(s), 0, 0, out m, out q); return x + "/" + m + "/" + (q == ChartBridgeSides.NoQ ? "none" : q.ToString()); }

    static void TapePure()
    {
        double nan = double.NaN; int U = ChartBridgeSides.NoQ;
        Check(Cat(100.5, 100, 100.25) == 2 && Cat(100.25, 100, 100.25) == 1 && Cat(100.25, 100, 100.5) == 0 && Cat(100, 100, 100.25) == -1 && Cat(99.75, 100, 100.25) == -2,
            "q: above the ask 2, at the ask 1, between 0, at the bid -1, below the bid -2");
        Check(Cat(100, nan, 100.25) == U && Cat(100, 100, nan) == U && Cat(100, 0, 100.25) == U && Cat(100, -1, 100.25) == U && Cat(100, 100.25, 100.25) == U && Cat(100, 100.5, 100.25) == U,
            "q: no usable quote (a side missing, zero or below, locked, crossed): unknown, never guessed (the side's rule for sm 2)");
        Check(Cat(0.1 + 0.2, 0.25, 0.3) == 1 && Cat(0.3, 0.1 + 0.2, 0.55) == -1, "q: float noise (0.1 + 0.2 is 0.3) is the same price");
        bool trip = true;
        for (int q = -2; q <= 2; q++) trip &= ChartBridgeSides.QOf(ChartBridgeSides.QCode(q)) == q && ChartBridgeSides.QCode(q) != 0;
        Check(trip && ChartBridgeSides.QCode(U) == 0 && ChartBridgeSides.QOf(0) == U && default(SeamTick).QCode == 0,
            "q: stored as a byte, 0 unknown (the default of a trade made without one), each category round trips");
        Check(ChartBridgeSides.QJson(2) == ",\"q\":2" && ChartBridgeSides.QJson(-2) == ",\"q\":-2" && ChartBridgeSides.QJson(0) == ",\"q\":0" && ChartBridgeSides.QJson(U) == ""
              && object.ReferenceEquals(ChartBridgeSides.QJson(1), ChartBridgeSides.QJson(1)),
            "q: the live field is one of five strings made once (no string per trade); unknown is no field");

        // The live tagger: the same quote as the side (strictly before the trade, not stale, not after a reset).
        LiveSideTagger t = new LiveSideTagger();
        Check(TagQ(t, 100, 1.0) == "0/0/none", "q, live: before any quote: unknown");
        Q2(t, 1.5, 100, 100.25);
        Check(TagQ(t, 100.5, 2.0) == "1/2/2" && TagQ(t, 100.25, 2.1) == "1/2/1" && TagQ(t, 100, 2.2) == "-1/2/-1" && TagQ(t, 99.5, 2.3) == "-1/2/-2",
            "q, live: above the ask, at it, at the bid and below it, with the side by the quote");
        Q2(t, 2.4, 100, 100.5);
        Check(TagQ(t, 100.25, 2.5) == "1/3/0", "q, live: between the quote: 0, the side by the tick rule (up from 99.5: a buy)");
        // S3's tie: the trade's own quote update (same time, delivered first) is not used for q either.
        t = new LiveSideTagger();
        Q2(t, 2.5, 100, 100.25);
        Q2(t, 3.0, 100.25, 100.5);
        Check(TagQ(t, 100.25, 3.0) == "1/2/1", "q, live: the trade's own quote update delivered first is not used (at the ask of 100 / 100.25: 1, not -1 at the new bid)");
        Check(TagQ(t, 100.5, 70) == "1/3/none", "q, live: a quote over 60 s old is stale: unknown (the side by the tick rule)");
        Q2(t, 71, 101, 101.25);
        t.ClearQuote();
        Check(TagQ(t, 101.25, 71.5) == "1/3/none", "q, live: after a reset the old quote is not used: unknown");
        t = new LiveSideTagger();
        t.NoteQuote(true, 100.25, At(1)); t.NoteQuote(false, 100.25, At(1));
        Check(TagQ(t, 100.25, 2) == "0/0/none", "q, live: a locked quote: unknown");
        Check(t.DiagJson().Contains("\"q\":{\"aboveAsk\":0,\"atAsk\":0,\"between\":0,\"atBid\":0,\"belowBid\":0,\"unknown\":1}"), "q, live: /diag counts each category (" + t.DiagJson() + ")");

        // History: the served window keeps the q of the trades ChartBridge saw live; NinjaTrader's tick answer has none.
        RootBook book = new RootBook("MNQ", 0.25);
        DateTime b0 = At(10);
        DateTime listen = ChartBridgeTime.ToUtc(b0).AddHours(-30);
        lock (book.Sync)
        {
            book.OnTrade(b0, 100, 1, 0, listen, listen, 0, DateTime.MinValue, false);
            book.Cache = new TradeLog();
            book.Cache.Add(b0.AddSeconds(1), 100.25, 2);   // as from NinjaTrader's answer
            book.WindowLive = new List<SeamTick>();
            book.OnTrade(b0.AddSeconds(2), 100.5, 3, 0, listen, listen, 0, DateTime.MinValue, false, ChartBridgeSides.QCode(2));
            book.OnTrade(b0.AddSeconds(3), 100, 4, 0, listen, listen, 0, DateTime.MinValue, false, ChartBridgeSides.QCode(-1));
            book.OnTrade(b0.AddSeconds(4), 100.25, 5, 0, listen, listen, 0, DateTime.MinValue, false, ChartBridgeSides.QCode(0));
            book.OnTrade(b0.AddSeconds(5), 100.25, 6, 0, listen, listen, 0, DateTime.MinValue, false);
        }
        RawBars rb = book.Cache.Snapshot().ToBars();
        System.Text.StringBuilder sb = new System.Text.StringBuilder();
        ChartBridgeTime.EtCache etc = new ChartBridgeTime.EtCache();
        for (int i = 0; i < rb.Count; i++) { if (i > 0) sb.Append(' '); ChartBridgeServer.AppendTrade(sb, rb, i, etc); }
        string[] rows = sb.ToString().Split(' ');
        Check(rows.Length == 5 && rows[0].EndsWith(",100.25,2]") && rows[0].Split(',').Length == 3 && rows[1].EndsWith(",100.5,3,null,null,2]") && rows[2].EndsWith(",100,4,null,null,-1]")
              && rows[3].EndsWith(",100.25,5,null,null,0]") && rows[4].EndsWith(",100.25,6]") && rows[4].Split(',').Length == 3,
            "q, history: a served-window trade seen live with a quote is [t, p, v, null, null, q]; one from NinjaTrader's answer or with no quote stays [t, p, v] (" + sb + ")");
        Check(book.WindowLive.Count == 4 && book.WindowLive[0].QCode == ChartBridgeSides.QCode(2) && book.WindowLive[3].QCode == 0,
            "q, history: the live trades held for a window's seam keep their q (released into the window with it)");
        RawBars sl = rb.Slice(1, 3);
        Check(sl.QCode != null && sl.Count == 2 && ChartBridgeSides.QOf(sl.QCode[0]) == 2 && ChartBridgeSides.QOf(sl.QCode[1]) == -1, "q, history: a cut of the window keeps them");
        RawBars plain = new RawBars { Count = 1, Time = new[] { b0 }, Close = new[] { 100.0 }, Volume = new long[] { 1 } };
        sb.Length = 0; ChartBridgeServer.AppendTrade(sb, plain, 0, etc);
        Check(sb.ToString().Split(',').Length == 3, "q, history: trades with no stored quote (a NinjaTrader answer, a table) are [t, p, v], as in 0.3.7: " + sb);
    }

    // Through OnMarketData: the live tick's q, and what it costs (the flood: trades with a quote update between each).
    static void LoadTape()
    {
        Reset();
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        Priv("Subscribe", client, "MNQ", 5, 0);
        Made(m0)[0].Answer(Minutes(new[] { 60.0, 1, 1, 1, 1, 1 }), ErrorCode.NoError);
        BarsRequest lt = Made(m0).Skip(1).FirstOrDefault();
        if (lt != null) lt.Answer(Rows(new[] { 1.0, 25000, 1 }), ErrorCode.NoError);
        WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0);
        lock (sent) sent.Clear();
        Trade(19.0, 24990, 1);   // after the earlier loads' quotes went stale (60 s): no usable quote
        Quote(20.0, 25000, 25000.25);
        Trade(20.1, 25000.5, 1); Trade(20.2, 25000.25, 1); Trade(20.3, 25000, 1); Trade(20.4, 24999.75, 1);
        Quote(20.5, 25000, 25000.5);
        Trade(20.6, 25000.25, 1);
        List<string> ticks = Sent().Where(x => x.StartsWith("{\"type\":\"tick\"")).ToList();
        string[] want = { "}", ",\"sm\":2,\"q\":2}", ",\"sm\":2,\"q\":1}", ",\"sm\":2,\"q\":-1}", ",\"sm\":2,\"q\":-2}", ",\"sm\":3,\"q\":0}" };
        bool ok = ticks.Count == want.Length;
        for (int i = 0; ok && i < want.Length; i++) ok = ticks[i].EndsWith(want[i]) && ticks[i].Contains("\"p\":") && (i > 0 || !ticks[i].Contains("\"q\""));
        Check(ok, "q, live tick: the last field, from the side tagger's quote; no field without a usable quote (" + string.Join(" ", ticks.Select(x => x.Substring(x.IndexOf("\"p\":"))).ToArray()) + ")");

        // The flood: 200,000 trades through OnMarketData, a Bid and an Ask update before each, one page ready.
        Action<string> tapWas = client.Tap;
        client.Tap = x => { };
        try
        {
            const int n = 100000;
            double best = 1e9;
            for (int rep = 0; rep < 3; rep++)
            {
                System.Diagnostics.Stopwatch sw = new System.Diagnostics.Stopwatch();
                for (int i = 0; i < n; i++)
                {
                    double at = 30 + rep * 40 + i * 0.0001, mid = 25000 + (i % 40) * 0.25;
                    Md(MarketDataType.Bid, at, mid - 0.25, 3, 0, 0); Md(MarketDataType.Ask, at, mid, 3, 0, 0);
                    sw.Start();
                    Md(MarketDataType.Last, at + 0.00005, mid + (i % 5 - 2) * 0.25, 1, 0, 0);
                    sw.Stop();
                }
                best = Math.Min(best, sw.Elapsed.TotalMilliseconds * 1000 / n);
            }
            Console.WriteLine("     (flood: " + n.ToString("N0") + " trades through OnMarketData, quotes between them: " + best.ToString("0.00") + " us a trade, best of 3, Mono, reflection call included)");
            Check(best < 200, "q, flood: OnMarketData at " + best.ToString("0.00") + " us a trade with q (see the report for before and after)");
        }
        finally { client.Tap = tapWas; Reset(); }
    }

    static void LoadMinute()
    {
        // Minute charts: no tick backfill goes to the page, so no quote request is made.
        Reset();
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        Priv("Subscribe", client, "MNQ", 5, 0);
        Made(m0)[0].Answer(Minutes(new[] { 60.0, 1, 1, 1, 1, 1 }), ErrorCode.NoError);
        Check(Kind(m0, MarketDataType.Bid, 0) == null && Kind(m0, MarketDataType.Ask, 0) == null, "minute chart: no quote requests");
        BarsRequest last = Made(m0).Skip(1).FirstOrDefault();
        if (last != null) last.Answer(Rows(new[] { 1.0, 100, 1 }), ErrorCode.NoError);
        Check(WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0), "minute chart: ready is sent");
    }
}


