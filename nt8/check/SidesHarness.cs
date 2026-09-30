// The side of every trade (ChartBridge 0.3.4), run for real on Mono. First the rules as pure functions
// (ChartBridgeSides.Classify: at, above, below the quote, between, no quote, crossed; the tick rule over sequences), the
// live tagger fed by Bid and Ask updates, and the as-of join of the backfill on the Bid and Ask history (ties, missing
// history, shorter history at either end, whole-second quotes, NinjaTrader's own stamps). Then whole loads through
// ChartBridgeServer's Subscribe and OnMarketData with the stand-in BarsRequest: the quote requests (answered in any
// order, refused, empty, shorter, never), the backfill's [t, p, v, s, sm], the live {.., s, sm}, the seam unchanged with
// sides that disagree, minute charts, and /diag.
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
    static readonly DateTime T0 = new DateTime(2026, 9, 29, 10, 0, 0);
    static DateTime At(double seconds) { return T0.AddTicks((long)Math.Round(seconds * TimeSpan.TicksPerSecond)); }
    const int N = ChartBridgeSides.None, AG = ChartBridgeSides.Aggressor, Q = ChartBridgeSides.BidAsk, TR = ChartBridgeSides.TickRule;

    // ------------------------------------------------------------ the stand-in's quote answers
    // Used as BarsRequest.AutoAnswer for the whole seam and sides run: each Bid or Ask request is answered at once with
    // NextBid or NextAsk (null: no history, an empty answer), unless Manual, when the case answers it itself.
    public static Bars NextBid, NextAsk;
    public static ErrorCode NextCode = ErrorCode.NoError;
    public static bool Manual;

    public static bool QuoteAnswer(BarsRequest r)
    {
        if (r.BarsPeriod == null || r.BarsPeriod.MarketDataType == MarketDataType.Last || Manual) return false;
        Bars b = r.BarsPeriod.MarketDataType == MarketDataType.Bid ? NextBid : NextAsk;
        r.Answer(b ?? new Bars(), NextCode);
        return true;
    }

    static void Reset() { NextBid = null; NextAsk = null; NextCode = ErrorCode.NoError; Manual = false; }

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
    static string Tag(LiveSideTagger t, double p, double eb, double ea) { int m; int s = t.Tag(p, eb, ea, out m); return s + "/" + m; }

    static void Live()
    {
        LiveSideTagger t = new LiveSideTagger();
        Check(Tag(t, 100, 0, 0) == "0/0", "live: before any quote or trade: unknown");
        Check(Tag(t, 100.25, 0, 0) == "1/3", "live: before any quote: the tick rule");
        t.NoteQuote(true, 100);
        Check(Tag(t, 100.25, 0, 0) == "1/3", "live: a bid alone is no quote: the tick rule (unchanged: previous side)");
        t.NoteQuote(false, 100.25);
        Check(Tag(t, 100.25, 100, 100.25) == "1/2", "live: at the ask from the Ask update: a buy by the quote");
        Check(Tag(t, 100, 100, 100.25) == "-1/2", "live: at the bid: a sell by the quote");
        t.NoteQuote(false, 100.5);   // the ask moved up: 100.25 is between now
        Check(Tag(t, 100.25, 100, 100.25) == "1/3", "live: between after the ask moved: the tick rule (up from 100)");
        t.NoteQuote(true, 100.25);
        Check(Tag(t, 100.25, 100.25, 100.5) == "-1/2", "live: the latest bid is used (100.25 is now the bid: a sell)");
        t.NoteQuote(true, 100.75);   // crossed (bid above ask): not used
        Check(Tag(t, 100.5, 100.25, 100.5) == "1/3", "live: a crossed quote is not used: the tick rule");
        string d = t.DiagJson();
        Check(d.Contains("\"trades\":8") && d.Contains("\"bidAsk\":3") && d.Contains("\"tickRule\":4") && d.Contains("\"none\":1") && d.Contains("\"aggressor\":0")
              && d.Contains("\"bidUpdates\":3") && d.Contains("\"askUpdates\":2"), "live: /diag counts by method and quote updates (" + d + ")");
        // The Last update's own Bid and Ask, compared only: same as the tracked quote, different, or not there.
        Check(d.Contains("\"eventQuoteSame\":3") && d.Contains("\"eventQuoteDiffers\":2") && d.Contains("\"eventQuoteNone\":3"),
            "live: /diag compares the Last update's own Bid and Ask with the tracked quote (" + d + ")");
    }

    // ------------------------------------------------------------ the as-of join
    static BackfillSides J(double[][] trades, double[][] bids, double[][] asks)
    {
        return ChartBridgeSides.ClassifyBackfill(trades.Select(x => At(x[0])).ToArray(), trades.Select(x => x[1]).ToArray(), trades.Length,
            bids == null ? null : bids.Select(x => At(x[0])).ToArray(), bids == null ? null : bids.Select(x => x[1]).ToArray(), bids == null ? 0 : bids.Length,
            asks == null ? null : asks.Select(x => At(x[0])).ToArray(), asks == null ? null : asks.Select(x => x[1]).ToArray(), asks == null ? 0 : asks.Length,
            null, null, 0.25);
    }
    static string Out(BackfillSides r) { return string.Join(" ", Enumerable.Range(0, r.Trades).Select(i => r.Side[i] + "/" + r.Method[i])); }
    static double[] R(double t, double p) { return new double[] { t, p }; }

    static void Join()
    {
        // Millisecond times throughout. Quote 100 / 100.25 from 0.001; the ask moves to 100.5 at 2.001.
        double[][] bids = { R(0.001, 100), R(3.001, 100.25) };
        double[][] asks = { R(0.001, 100.25), R(2.001, 100.5), R(5.001, 100.75) };
        double[][] trades = { R(1.001, 100.25), R(1.502, 100), R(2.501, 100.25), R(2.601, 100.5), R(4.001, 100.25), R(4.5, 100.5) };
        BackfillSides r = J(trades, bids, asks);
        Check(Out(r) == "1/2 -1/2 1/3 1/2 -1/2 1/2" && r.Quoted == 6 && r.BetweenQuotes == 1 && r.Counts[Q] == 5 && r.Counts[TR] == 1,
            "join: each trade by the quote in force at its time (" + Out(r) + ")");
        Check(r.ResolutionOk(), "join: millisecond trades and quotes compared by millisecond");

        // Tie: at 5.000 the ask 100.25 is lifted and in the same millisecond the ask moves to 100.5 and the bid steps up to 100.25.
        r = J(new[] { R(3.5, 100), R(5, 100.25), R(5.5, 100.25) }, new[] { R(1, 100), R(5, 100.25) }, new[] { R(1, 100.25), R(5, 100.5) });
        Check(r.Side[1] == 1 && r.Method[1] == Q && r.TieChanged == 1,
            "join, tie: a quote stamped in the trade's own millisecond is not used (the lifted ask 100.25 stands): a buy; tieChanged counts it (" + Out(r) + ", tieChanged " + r.TieChanged + ")");
        Check(r.Side[2] == -1 && r.Method[2] == Q, "join, tie: the next millisecond does use the new quote (100.25 is the bid: a sell)");

        // Never a quote from after the trade.
        r = J(new[] { R(1, 100.25), R(2, 100.5) }, new[] { R(3, 100) }, new[] { R(3, 100.25) });
        Check(Out(r) == "0/0 1/3" && r.BeforeQuotes == 2 && r.Quoted == 0, "join: quotes that start after the trades are never used (no look-ahead): the tick rule");

        // No quote history at all, or one side missing.
        r = J(trades, null, null);
        Check(r.Counts[Q] == 0 && r.Counts[TR] + r.Counts[N] == 6 && r.BeforeQuotes == 6 && r.BidTicks == 0, "join, missing history: every trade by the tick rule");
        r = J(trades, bids, null);
        Check(r.Counts[Q] == 0 && r.BeforeQuotes == 6, "join, only bids came back: every trade by the tick rule");
        r = J(new double[0][], bids, asks);
        Check(r.Trades == 0 && r.Side.Length == 0, "join: no trades: nothing");

        // Shorter history: the quotes end at 3 (a stale quote is never carried past the end).
        double[] lt = { 1.5, 2.5, 10.5, 11.5, 12.5, 13.5, 14.5, 15.5 };
        double[][] longTrades = lt.Select((t, i) => R(t, i % 2 == 0 ? 100.25 : 100)).ToArray();
        r = J(longTrades, new[] { R(0.2, 100), R(3, 100) }, new[] { R(0.2, 100.25), R(3, 100.25) });
        Check(r.Quoted == 2 && r.AfterQuotes == 6 && Enumerable.Range(0, 2).All(i => r.Method[i] == Q) && Enumerable.Range(2, 6).All(i => r.Method[i] == TR),
            "join, shorter history (ends early): trades over 5 s past its end go by the tick rule (" + Out(r) + ")");
        r = J(new[] { R(1.5, 100.25), R(7.9, 100.25), R(8.1, 100) }, new[] { R(0.2, 100), R(3, 100) }, new[] { R(0.2, 100.25), R(3, 100.25) });
        Check(r.Quoted == 2 && r.AfterQuotes == 1 && Out(r) == "1/2 1/2 -1/3", "join: within 5 s of the quote history's end the last quote still stands; after that, the tick rule (" + Out(r) + ")");
        r = J(longTrades, new[] { R(4.9, 100), R(20, 100) }, new[] { R(4.9, 100.25), R(20, 100.25) });
        Check(r.BeforeQuotes == 2 && r.Quoted == 6 && Enumerable.Range(2, 6).All(i => r.Method[i] == Q), "join, shorter history (starts late): trades before its start go by the tick rule");
        r = J(longTrades, new[] { R(0.2, 100), R(20, 100) }, new[] { R(0.2, 100.25), R(3, 100.25) });
        Check(r.AfterQuotes == 6, "join: the quote history ends where the shorter side (bids or asks) ends");

        // Whole-second quotes against millisecond trades: compared by whole second, so a quote in the trade's second is a tie.
        double[][] wsb = Enumerable.Range(0, 25).Select(i => R(i, 100)).ToArray(), wsa = Enumerable.Range(0, 25).Select(i => R(i, 100.25)).ToArray();
        wsa[10] = R(10, 101);   // at 10 s the ask jumps (say, a sweep in that second)
        r = J(new[] { R(10.4, 100.25), R(11.2, 100.25) }, wsb, wsa);
        Check(r.UnitTicks == TimeSpan.TicksPerSecond && r.QuoteResolution == TimeSpan.TicksPerSecond && r.Side[0] == 1 && r.Method[0] == Q && r.Side[1] == 1,
            "join: whole-second quotes: compared by second; a quote in the trade's own second is not used (" + Out(r) + ")");

        // NinjaTrader's own stamps on the trades (diag only): real ones checked against the join, filled-in ones (Bid = Last,
        // Ask = Bid + 1 tick) and missing ones counted.
        DateTime[] tt = trades.Select(x => At(x[0])).ToArray(); double[] tp = trades.Select(x => x[1]).ToArray();
        double[] sb = { 100, 100, 0, 100.25, 100.25, 100.5 }, sa = { 100.25, 100.25, 0, 100.5, 100.5, 100.75 };
        double[] synB = tp.ToArray(), synA = tp.Select(p => p + 0.25).ToArray();
        r = ChartBridgeSides.ClassifyBackfill(tt, tp, 6, bids.Select(x => At(x[0])).ToArray(), bids.Select(x => x[1]).ToArray(), 2, asks.Select(x => At(x[0])).ToArray(), asks.Select(x => x[1]).ToArray(), 3, sb, sa, 0.25);
        Check(r.StampUsable == 5 && r.StampMissing == 1 && r.StampLikeFillIn == 3 && r.StampAgree == 4 && r.StampDisagree == 1 && Out(r) == "1/2 -1/2 1/3 1/2 -1/2 1/2",
            "join: NinjaTrader's stamps compared with the join (usable " + r.StampUsable + ", like fill-in " + r.StampLikeFillIn + ", agree " + r.StampAgree + ", disagree " + r.StampDisagree + "); the join's sides unchanged");
        r = ChartBridgeSides.ClassifyBackfill(tt, tp, 6, null, null, 0, null, null, 0, synB, synA, 0.25);
        Check(r.StampLikeFillIn == 6 && r.StampUsable == 6 && r.Counts[Q] == 0, "join: stamps all like the fill-in (Bid = Last, Ask = Bid + 1 tick) are counted, never used");

        // Cost on ChartBridge's side: 300,000 trades against 1,000,000 bids and 1,000,000 asks (a busy 8 hours, roughly).
        int nt = 300000, nq = 1000000;
        DateTime[] ct = new DateTime[nt], cb = new DateTime[nq], ca = new DateTime[nq];
        double[] cp = new double[nt], cbp = new double[nq], cap = new double[nq];
        for (int i = 0; i < nq; i++) { cb[i] = At(i * 0.0288); ca[i] = At(i * 0.0288 + 0.0005); cbp[i] = 100 + (i / 50 % 8) * 0.25; cap[i] = cbp[i] + 0.25; }
        for (int i = 0; i < nt; i++) { ct[i] = At(i * 0.096 + 0.001); cp[i] = 100 + (i / 15 % 8) * 0.25 + (i % 2) * 0.25; }
        System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
        r = ChartBridgeSides.ClassifyBackfill(ct, cp, nt, cb, cbp, nq, ca, cap, nq, null, null, 0.25);
        sw.Stop();
        Console.WriteLine("     (300,000 trades joined on 2,000,000 quotes: " + sw.Elapsed.TotalMilliseconds.ToString("0") + " ms)");
        Check(r.Trades == nt && r.Quoted == nt && sw.Elapsed.TotalMilliseconds < 5000, "cost: 300,000 trades joined on 2,000,000 quotes in " + sw.Elapsed.TotalMilliseconds.ToString("0") + " ms");
    }

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
        try { LoadTick(); LoadOrder(); LoadRefused(); LoadMissing(); LoadMinute(); LoadTimeout(); }
        finally { Reset(); }
    }

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        Pure();
        Live();
        Join();
    }

    static void LoadTick()
    {
        // A tick chart: quotes arrive live first, then trades held during the load. The backfill: 4 trades; its last (10.25 at
        // 1.000) is also held live, where the live quote calls it a sell (the bid had moved up to it), while the backfill's quote
        // history calls it a buy. The seam still drops the held copy: the side takes no part in the match.
        Reset();
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        NextBid = Rows(R(-40, 100), R(0.4, 100.25), R(1.0005, 100.25));
        NextAsk = Rows(R(-40, 100.25), R(0.4, 100.5), R(1.0005, 100.75));
        Priv("Subscribe", client, "MNQ", 5, 8);
        Quote(0.9, 100.25, 100.5);
        Quote(1.0, 100.5, 100.75);                 // live: the bid is 100.5 now
        Trade(1.0, 100.5, 4);                      // in the backfill too: live calls it a sell (at the bid)
        Trade(1.2, 100.75, 1);                     // at the ask: a buy
        Trade(1.3, 100.625, 2);                    // between (made-up price): tick rule, down: a sell
        BarsRequest minutes = Made(m0)[0];
        minutes.Answer(Minutes(new[] { 0.0, 100, 100, 100, 100, 5 }, new[] { 60.0, 100, 100.5, 100, 100.5, 7 }), ErrorCode.NoError);
        BarsRequest last = Kind(m0, MarketDataType.Last, 1), bid = Kind(m0, MarketDataType.Bid, 0), ask = Kind(m0, MarketDataType.Ask, 0);
        Check(last != null && bid != null && ask != null && bid.Answered && ask.Answered, "load: a tick chart asks for Bid and Ask ticks with the trades");
        Check(bid != null && last != null && bid.From == last.From && bid.To == last.To && ask.From == last.From && ask.To == last.To
              && bid.BarsPeriod.BarsPeriodType == BarsPeriodType.Tick && bid.BarsPeriod.Value == 1, "load: the quote requests cover the trades' window, 1 tick");
        Check(Index(Sent(), "\"type\":\"ticks\"") < 0, "load: nothing goes out before the trades are in");
        last.Answer(Rows(new[] { -30.0, 100, 3 }, new[] { 0.5, 100.5, 2 }, new[] { 0.7, 100.25, 1 }, new[] { 1.0, 100.5, 4 }), ErrorCode.NoError);
        Check(WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0), "load: ready is sent");
        Thread.Sleep(30);
        List<string> l = Sent();
        string ticks = l[Index(l, "\"type\":\"ticks\"")];
        // -30: 100 at the bid (sell); 0.5: 100.5 at the ask of 0.4 (buy); 0.7: 100.25 at the bid (sell); 1.0: 100.5 at the ask
        // in force before 1.000 (100.5; the 1.0005 quote is in the same millisecond, a tie, not used): a buy.
        Check(ticks.Contains(",100,3,-1,2]") && ticks.Contains(",100.5,2,1,2]") && ticks.Contains(",100.25,1,-1,2]") && ticks.Contains(",100.5,4,1,2]"),
            "load: backfill trades are [t, p, v, s, sm], each by the quote history (" + ticks + ")");
        int rd = Index(l, "\"type\":\"ready\"");
        List<string> after = l.Skip(rd + 1).ToList();
        Check(after.Count == 2 && after[0].Contains("\"p\":100.75,\"v\":1,\"s\":1,\"sm\":2}") && after[1].Contains("\"p\":100.625,\"v\":2,\"s\":-1,\"sm\":3}"),
            "load: the held copy of the backfill's last trade is dropped although its side differs (the side is not in the match); the rest carry s and sm");
        Check(Priv("SeamsJson").ToString().Contains("\"droppedAsDuplicate\":1"), "load: the seam counted the duplicate as before");
        Quote(1.5, 100.5, 100.75);
        Trade(1.6, 100.5, 1);
        Check(Sent().Last().EndsWith(",\"p\":100.5,\"v\":1,\"s\":-1,\"sm\":2}"), "load: a live trade at the bid after ready: a sell, by the quote");
        string d = Diag();
        Check(d.Contains("\"sides\":{") && d.Contains("\"lastLoad\":{\"sub\":") && d.Contains("\"trades\":4,\"aggressor\":0,\"bidAsk\":4,\"tickRule\":0,\"none\":0,\"note\":null")
              && d.Contains("\"bidTicks\":3,\"askTicks\":3") && d.Contains("\"bidRequest\":\"ok\"") && d.Contains("\"quotedTrades\":4") && d.Contains("\"beforeQuotes\":0,\"afterQuotes\":0"),
            "diag: sides for the last load: counts by method, quote history, coverage (" + Snip(d) + ")");
        Check(d.Contains("\"live\":{\"trades\":") && d.Contains("\"tradeResolutionMs\":") && d.Contains("\"quoteResolutionMs\":"), "diag: live counts and the resolutions are there");
    }

    static string Snip(string d) { int i = d.IndexOf("\"sides\""); return i < 0 ? d : d.Substring(i, Math.Min(900, d.Length - i)); }

    static void LoadOrder()
    {
        // The three answers in any order: quotes after the trades, then trades after the quotes.
        Reset();
        Manual = true;
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        Priv("Subscribe", client, "MNQ", 5, 8);
        Made(m0)[0].Answer(Minutes(new[] { 60.0, 1, 1, 1, 1, 1 }), ErrorCode.NoError);
        Kind(m0, MarketDataType.Last, 1).Answer(Rows(new[] { 1.0, 100.25, 1 }), ErrorCode.NoError);
        Thread.Sleep(50);
        Check(Index(Sent(), "\"type\":\"ticks\"") < 0 && Index(Sent(), "\"type\":\"ready\"") < 0, "order: trades in, quotes not: the backfill waits");
        Kind(m0, MarketDataType.Bid, 0).Answer(Rows(new[] { 0.5, 100 }), ErrorCode.NoError);
        Thread.Sleep(30);
        Check(Index(Sent(), "\"type\":\"ready\"") < 0, "order: still waiting for the asks");
        Kind(m0, MarketDataType.Ask, 0).Answer(Rows(new[] { 0.5, 100.25 }, new[] { 1.0, 100.25 }), ErrorCode.NoError);
        Check(WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0) && Sent().Any(x => x.Contains("[") && x.Contains(",100.25,1,1,2]")), "order: quotes after the trades: sent, a buy at the ask");

        lock (sent) sent.Clear();
        m0 = MadeCount();
        Priv("Subscribe", client, "MNQ", 5, 8);
        Made(m0)[0].Answer(Minutes(new[] { 60.0, 1, 1, 1, 1, 1 }), ErrorCode.NoError);
        Kind(m0, MarketDataType.Ask, 0).Answer(Rows(new[] { 0.5, 100.25 }, new[] { 1.0, 100.25 }), ErrorCode.NoError);
        Kind(m0, MarketDataType.Bid, 0).Answer(Rows(new[] { 0.5, 100 }, new[] { 1.0, 100 }), ErrorCode.NoError);
        Thread.Sleep(30);
        Check(Index(Sent(), "\"type\":\"ticks\"") < 0, "order: quotes in, trades not: the backfill waits");
        Kind(m0, MarketDataType.Last, 1).Answer(Rows(new[] { 1.0, 100, 1 }), ErrorCode.NoError);
        Check(WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0) && Sent().Any(x => x.Contains(",100,1,-1,2]")), "order: trades last: sent, a sell at the bid");
        Reset();
    }

    static void LoadRefused()
    {
        // The quote requests ending in the future are refused: asked again ending now; refused again: the tick rule, and ready.
        Reset();
        NextCode = ErrorCode.Panic;
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        Priv("Subscribe", client, "MNQ", 5, 8);
        Made(m0)[0].Answer(Minutes(new[] { 60.0, 1, 1, 1, 1, 1 }), ErrorCode.NoError);
        BarsRequest b2 = Kind(m0, MarketDataType.Bid, 1), a2 = Kind(m0, MarketDataType.Ask, 1);
        Check(b2 != null && a2 != null && b2.To <= DateTime.Now.AddSeconds(1) && Kind(m0, MarketDataType.Bid, 2) == null,
            "refused: a quote request ending in the future that fails is asked again ending now, once");
        Kind(m0, MarketDataType.Last, 1).Answer(Rows(new[] { 0.5, 100, 1 }, new[] { 1.0, 100.25, 1 }), ErrorCode.NoError);
        Check(WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0), "refused: ready is still sent");
        List<string> l = Sent();
        string ticks = l[Index(l, "\"type\":\"ticks\"")];
        Check(ticks.Contains(",100,1,0,0]") && ticks.Contains(",100.25,1,1,3]"), "refused: the trades go by the tick rule (" + ticks + ")");
        string d = Diag();
        Check(d.Contains("\"bidRequest\":\"error: Panic stub error\"") && d.Contains("\"quotesRetriedEndingNow\":true") && d.Contains("\"note\":\"no bid or ask history came back"),
            "refused: /diag says the quote history failed and every trade went by the tick rule (" + Snip(d) + ")");
        Reset();
    }

    static void LoadMissing()
    {
        // Empty quote answers (a connection with no bid/ask history), and a shorter one: said so in /diag.
        Reset();
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        Priv("Subscribe", client, "MNQ", 5, 8);
        Made(m0)[0].Answer(Minutes(new[] { 60.0, 1, 1, 1, 1, 1 }), ErrorCode.NoError);
        Check(Kind(m0, MarketDataType.Bid, 1) != null, "missing: an empty quote answer ending in the future is asked again ending now");
        Kind(m0, MarketDataType.Last, 1).Answer(Rows(new[] { 0.5, 100, 1 }), ErrorCode.NoError);
        Check(WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0) && Diag().Contains("\"bidRequest\":\"empty\"") && Diag().Contains("\"bidTicks\":0"), "missing: empty quote history: /diag says so");

        lock (sent) sent.Clear();
        m0 = MadeCount();
        NextBid = Rows(R(0.1, 100), R(2, 100));
        NextAsk = Rows(R(0.1, 100.25), R(2, 100.25));
        Priv("Subscribe", client, "MNQ", 5, 8);
        Made(m0)[0].Answer(Minutes(new[] { 60.0, 1, 1, 1, 1, 1 }), ErrorCode.NoError);
        Kind(m0, MarketDataType.Last, 1).Answer(Rows(new[] { 0.05, 100, 1 }, new[] { 1.0, 100, 1 }, new[] { 8.0, 100.25, 1 }, new[] { 9.0, 100.25, 1 }), ErrorCode.NoError);
        Check(WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0), "shorter: ready is sent");
        string d = Diag();
        Check(d.Contains("\"quotedTrades\":1") && d.Contains("\"beforeQuotes\":1") && d.Contains("\"afterQuotes\":2") && d.Contains("\"note\":\"the bid/ask history is shorter than the trades: 1 trade(s) before it and 2 after it went by the tick rule\""),
            "shorter: trades outside the quote history counted and named in /diag (" + Snip(d) + ")");
        Check(NinjaTrader.Code.Output.Lines.Any(x => x.Contains("MNQ trade sides: the bid/ask history is shorter")), "shorter: and a line in the Output window");
        Reset();
    }

    static void LoadTimeout()
    {
        // The quotes do not come back: the held live trades are not kept waiting past QuoteWaitMs after the trades.
        Reset();
        Manual = true;
        int was = ChartBridgeServer.QuoteWaitMs;
        ChartBridgeServer.QuoteWaitMs = 300;
        try
        {
            lock (sent) sent.Clear();
            int m0 = MadeCount();
            Priv("Subscribe", client, "MNQ", 5, 8);
            Made(m0)[0].Answer(Minutes(new[] { 60.0, 1, 1, 1, 1, 1 }), ErrorCode.NoError);
            Kind(m0, MarketDataType.Bid, 0).Answer(Rows(new[] { 0.5, 100 }), ErrorCode.NoError);   // the bids come, the asks never do
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            Kind(m0, MarketDataType.Last, 1).Answer(Rows(new[] { 1.0, 100, 1 }, new[] { 1.5, 100.25, 1 }), ErrorCode.NoError);
            Thread.Sleep(100);
            Check(Index(Sent(), "\"type\":\"ready\"") < 0, "timeout: within QuoteWaitMs the backfill still waits for the quotes");
            Check(WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0) && sw.ElapsedMilliseconds >= 250, "timeout: after QuoteWaitMs it goes out without them (" + sw.ElapsedMilliseconds + " ms)");
            List<string> l = Sent();
            Check(l[Index(l, "\"type\":\"ticks\"")].Contains(",100.25,1,1,3]"), "timeout: the trades go by the tick rule");
            string d = Diag();
            Check(d.Contains("\"quotesTimedOut\":true") && d.Contains("\"askRequest\":\"no answer within 0.3 s of the trades\"") && d.Contains("\"bidRequest\":\"ok\"") && d.Contains("\"note\":\"no ask history came back"),
                "timeout: /diag says the quotes timed out (" + Snip(d) + ")");
            int n = Sent().Count;
            Kind(m0, MarketDataType.Ask, 0).Answer(Rows(new[] { 0.5, 100.25 }), ErrorCode.NoError);   // late
            Thread.Sleep(50);
            Check(Sent().Count == n && Sent().Count(x => x.Contains("\"type\":\"ready\"")) == 1, "timeout: a late quote answer sends nothing more");
        }
        finally { ChartBridgeServer.QuoteWaitMs = was; Reset(); }
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

static class BackfillSidesCheck
{
    public static bool ResolutionOk(this BackfillSides r) { return r.UnitTicks == TimeSpan.TicksPerMillisecond; }
}
