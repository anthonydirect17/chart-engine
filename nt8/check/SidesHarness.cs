// The side of every trade (ChartBridge 0.3.4), run for real on Mono. First the rules as pure functions
// (ChartBridgeSides.Classify: at, above, below the quote, between, no quote, crossed; the tick rule over sequences), the
// live tagger fed by timestamped Bid and Ask updates (the trade's own update first, one stamped after the trade, stale,
// reset, a burst), live and backfill agreeing on the same trades, the as-of join of the backfill on the Bid and Ask
// history (ties, missing history, shorter history at either end, a hole, whole-second quotes, NinjaTrader's own stamps)
// and the thinned quote series. Then whole loads through
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
    // Ten minutes ago, on a whole second: the quote window is counted back from now (QuoteHoursMax), so the made-up trades
    // and quotes have to be recent.
    static readonly DateTime T0 = new DateTime(DateTime.Now.AddMinutes(-10).Ticks / TimeSpan.TicksPerSecond * TimeSpan.TicksPerSecond);
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

        // S3: live and backfill now classify the same trades the same way (the same quotes, the reorder live).
        double[][] qb = { R(1, 100), R(3, 100.25), R(4, 100) }, qa = { R(1, 100.25), R(3, 100.5), R(4, 100.25) };
        double[][] tr = { R(2, 100.25), R(3, 100.25), R(3.5, 100.25), R(3.6, 100.375), R(4, 100.25), R(4.2, 100) };
        BackfillSides bf = J(tr, qb, qa);
        t = new LiveSideTagger();
        List<string> live = new List<string>();
        int qi = 0;
        foreach (double[] x in tr)
        {
            while (qi < qb.Length && qb[qi][0] <= x[0]) { Q2(t, qb[qi][0], qb[qi][1], qa[qi][1]); qi++; }   // updates at the trade's time delivered first
            live.Add(Tag(t, x[1], x[0], 0, 0));
        }
        Check(string.Join(" ", live) == Out(bf), "live and backfill agree on the same trades (live " + string.Join(" ", live) + ", backfill " + Out(bf) + ")");
    }

    // ------------------------------------------------------------ the as-of join
    static BackfillSides J(double[][] trades, double[][] bids, double[][] asks)
    {
        return ChartBridgeSides.ClassifyBackfill(trades.Select(x => At(x[0])).ToArray(), trades.Select(x => x[1]).ToArray(), trades.Length,
            bids == null ? null : bids.Select(x => At(x[0])).ToArray(), bids == null ? null : bids.Select(x => x[1]).ToArray(), bids == null ? 0 : bids.Length,
            asks == null ? null : asks.Select(x => At(x[0])).ToArray(), asks == null ? null : asks.Select(x => x[1]).ToArray(), asks == null ? 0 : asks.Length,
            null, null, 0, 0.25);
    }
    static QuoteSeries Thin(double[][] rows) { Bars b = new Bars(); foreach (double[] x in rows) b.Add(At(x[0]), x[1], x[1], x[1], x[1], 1); return QuoteSeries.From(b, DateTime.MinValue); }
    static BackfillSides JQ(double[][] trades, QuoteSeries bq, QuoteSeries aq)
    {
        return ChartBridgeSides.ClassifyBackfill(trades.Select(x => At(x[0])).ToArray(), trades.Select(x => x[1]).ToArray(), trades.Length,
            bq.Time, bq.Price, bq.Seen, bq.Count, aq.Time, aq.Price, aq.Seen, aq.Count, null, null, 0, 0.25);
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
        Check(r.Counts[Q] == 0 && r.Counts[TR] + r.Counts[N] == 6 && r.BeforeQuotes == 6 && !r.HasBid, "join, missing history: every trade by the tick rule");
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

        // N1: a hole in the middle of the quote history (30 minutes missing): trades in it do not use the quote from before it.
        r = J(new[] { R(5, 104), R(1000, 103.75), R(1900, 103.5), R(1901, 103.75) }, new[] { R(0, 103.75), R(10, 103.75), R(1900.5, 103.5) }, new[] { R(0, 104), R(10, 104), R(1900.5, 103.75) });
        Check(Out(r) == "1/2 -1/3 -1/3 1/2" && r.StaleQuotes == 2 && r.Quoted == 2,
            "join, N1: a quote over 60 s old is stale (a hole in the history): the tick rule, counted (" + Out(r) + ", stale " + r.StaleQuotes + ")");

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
        r = ChartBridgeSides.ClassifyBackfill(tt, tp, 6, bids.Select(x => At(x[0])).ToArray(), bids.Select(x => x[1]).ToArray(), 2, asks.Select(x => At(x[0])).ToArray(), asks.Select(x => x[1]).ToArray(), 3, sb, sa, 0, 0.25);
        Check(r.StampUsable == 5 && r.StampMissing == 1 && r.StampLikeFillIn == 3 && r.StampAgree == 4 && r.StampDisagree == 1 && Out(r) == "1/2 -1/2 1/3 1/2 -1/2 1/2",
            "join: NinjaTrader's stamps compared with the join (usable " + r.StampUsable + ", like fill-in " + r.StampLikeFillIn + ", agree " + r.StampAgree + ", disagree " + r.StampDisagree + "); the join's sides unchanged");
        r = ChartBridgeSides.ClassifyBackfill(tt, tp, 6, null, null, 0, null, null, 0, synB, synA, 0, 0.25);
        Check(r.StampLikeFillIn == 6 && r.StampUsable == 6 && r.Counts[Q] == 0, "join: stamps all like the fill-in (Bid = Last, Ask = Bid + 1 tick) are counted, never used");

        // S2: the quote series keeps time and price only, and only the rows that can matter: the first of each run at one
        // price, one every 5 s within a run (so a quote's age is known), and the last row.
        Bars raw = new Bars();
        double[][] rows = { R(0, 100), R(0.1, 100), R(0.2, 100), R(0.3, 100.25), R(0.4, 100.25), R(6, 100.25), R(7, 100.25), R(12.5, 100.25), R(13, 100), R(13.2, 100) };
        foreach (double[] x in rows) raw.Add(At(x[0]), x[1], x[1], x[1], x[1], 7);
        QuoteSeries qs = QuoteSeries.From(raw, At(-1));
        string kept = string.Join(" ", qs.Time.Select(x => ((x - T0).TotalSeconds).ToString("0.#"))), seen = string.Join(" ", qs.Seen.Select(x => ((x - T0).TotalSeconds).ToString("0.#")));
        Check(kept == "0 0.3 6 12.5 13" && seen == "0.2 0.4 7 12.5 13.2" && qs.RawRows == 10,
            "quotes: size-only rows dropped (first of each price and a 5 s heartbeat kept), each kept row remembers its last update (kept " + kept + ", seen " + seen + ")");
        Check(QuoteSeries.From(raw, At(0.25)).RawRows == 7 && QuoteSeries.From(raw, At(0.25)).Time[0] == At(0.3), "quotes: rows before the quote window are skipped");
        // The same sides from the thinned series as from every row.
        double[][] full = Enumerable.Range(0, 400).Select(i => R(i * 0.05, 100 + (i / 7 % 3) * 0.25)).ToArray();
        double[][] fullA = full.Select(x => R(x[0], x[1] + 0.25)).ToArray();
        double[][] tq = Enumerable.Range(0, 150).Select(i => R(i * 0.13 + 0.01, 100 + (i % 4) * 0.25)).ToArray();
        Bars fb = new Bars(), fa = new Bars();
        foreach (double[] x in full) fb.Add(At(x[0]), x[1], x[1], x[1], x[1], 3);
        foreach (double[] x in fullA) fa.Add(At(x[0]), x[1], x[1], x[1], x[1], 3);
        QuoteSeries tb = QuoteSeries.From(fb, At(-1)), ta = QuoteSeries.From(fa, At(-1));
        BackfillSides thin = JQ(tq, tb, ta);
        Check(Out(thin) == Out(J(tq, full, fullA)) && tb.Count < full.Length / 3, "quotes: the thinned series gives the same sides as every row (" + tb.Count + " of " + full.Length + " rows kept)");
        // Review 2 N1: the thinned series must not move a quote's age at the 60 s stale edge. Bid 100 at 0 s and a size-only
        // update at 4 s (dropped), the bid moves at 70 s; a trade at 63 s at the bid, up-tick: every row says fresh (a sell by
        // the quote); the kept row alone said stale (a buy by the tick rule). With Seen it is the same.
        double[][] nb = { R(0, 100), R(4, 100), R(70, 100.25) }, na = { R(0, 100.25), R(4, 100.25), R(70, 100.5) };
        double[][] nt2 = { R(1, 99.75), R(63, 100) };
        Check(Out(JQ(nt2, Thin(nb), Thin(na))) == Out(J(nt2, nb, na)) && Out(J(nt2, nb, na)) == "-1/2 -1/2",
            "quotes, N1: at the 60 s edge the thinned series gives the same sides as every row (" + Out(JQ(nt2, Thin(nb), Thin(na))) + ")");
        // And over many made-up histories with gaps around 60 s, size-only runs and trades at every distance: never a different side.
        int diffs = 0, tradesChecked = 0;
        for (int seed = 1; seed <= 200; seed++)
        {
            Random rnd = new Random(seed);
            List<double[]> hb = new List<double[]>(), ha = new List<double[]>(), ht = new List<double[]>();
            double t = 0, bid = 100;
            for (int i = 0; i < 60; i++)
            {
                double gap = rnd.Next(4) == 0 ? 50 + rnd.NextDouble() * 20 : rnd.NextDouble() * 6;   // often near 60 s
                t += Math.Round(gap, 3);
                if (rnd.Next(3) == 0) bid += (rnd.Next(2) == 0 ? -0.25 : 0.25);
                hb.Add(R(t, bid)); ha.Add(R(t, bid + 0.25));
                double tx = t + Math.Round(rnd.NextDouble() * 70, 3);
                ht.Add(R(tx, bid + (rnd.Next(3) - 1) * 0.25));
            }
            double[][] trs = ht.OrderBy(x => x[0]).ToArray();
            string a = Out(JQ(trs, Thin(hb.ToArray()), Thin(ha.ToArray()))), b = Out(J(trs, hb.ToArray(), ha.ToArray()));
            tradesChecked += trs.Length;
            if (a != b) diffs++;
        }
        Check(diffs == 0, "quotes, N1: 200 made-up histories (" + tradesChecked + " trades) around the 60 s edge: thinned and every row agree on every side (" + diffs + " differ)");
        // Cost of the copy on NinjaTrader's answer thread: 1,000,000 Bid rows (about 1 in 6 changes price).
        Bars big = new Bars();
        for (int i = 0; i < 1000000; i++) { double px = 100 + (i / 6 % 8) * 0.25; big.Add(At(i * 0.0288), px, px, px, px, 1 + i % 5); }
        System.Diagnostics.Stopwatch cw = System.Diagnostics.Stopwatch.StartNew();
        QuoteSeries bigQ = QuoteSeries.From(big, At(-1));
        cw.Stop();
        Console.WriteLine("     (1,000,000 quote rows copied and thinned to " + bigQ.Count + ": " + cw.Elapsed.TotalMilliseconds.ToString("0") + " ms, about " + (bigQ.Count * 16 / 1024) + " KB kept)");
        Check(bigQ.RawRows == 1000000 && bigQ.Count < 200000 && cw.Elapsed.TotalMilliseconds < 3000, "cost: 1,000,000 quote rows copied and thinned in " + cw.Elapsed.TotalMilliseconds.ToString("0") + " ms (" + bigQ.Count + " kept)");

        // Cost on ChartBridge's side: 300,000 trades against 1,000,000 bids and 1,000,000 asks (a busy 8 hours, roughly).
        int nt = 300000, nq = 1000000;
        DateTime[] ct = new DateTime[nt], cb = new DateTime[nq], ca = new DateTime[nq];
        double[] cp = new double[nt], cbp = new double[nq], cap = new double[nq];
        for (int i = 0; i < nq; i++) { cb[i] = At(i * 0.0288); ca[i] = At(i * 0.0288 + 0.0005); cbp[i] = 100 + (i / 50 % 8) * 0.25; cap[i] = cbp[i] + 0.25; }
        for (int i = 0; i < nt; i++) { ct[i] = At(i * 0.096 + 0.001); cp[i] = 100 + (i / 15 % 8) * 0.25 + (i % 2) * 0.25; }
        System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
        r = ChartBridgeSides.ClassifyBackfill(ct, cp, nt, cb, cbp, nq, ca, cap, nq, null, null, 0, 0.25);
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
        try { LoadTick(); LoadSeamDisagree(); LoadOrder(); LoadRefused(); LoadMissing(); LoadMinute(); LoadTimeout(); LoadNoTrades(); LoadWindow(); LoadOutbox(); LoadReset(); LoadMemory(); }
        finally { Reset(); }
    }

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        typeof(ChartBridgeTime).GetField("et", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, TimeZoneInfo.FindSystemTimeZoneById("America/New_York"));
        Pure();
        Live();
        Join();
        Session();
        Lanes();
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
        // no fresh quote. Nothing carries across the break: side 0, live, in the backfill, and in the seam continuation.
        DateTime close = Et(2026, 9, 29, 16, 59, 59), open = Et(2026, 9, 29, 18, 0, 0);
        LiveSideTagger t = new LiveSideTagger();
        t.NoteQuote(true, 100, close.AddSeconds(-1)); t.NoteQuote(false, 100.25, close.AddSeconds(-1));
        int m1, m2;
        int s1 = t.Tag(100.25, close, 0, 0, out m1), s2 = t.Tag(101, open, 0, 0, out m2);
        int m3; int s3 = t.Tag(101.25, open.AddSeconds(1), 0, 0, out m3);
        Check(s1 == 1 && m1 == Q && s2 == 0 && m2 == N && s3 == 1 && m3 == TR,
            "session, live: the 18:00 ET reopening print with no fresh quote is side 0 (not a buy against the previous session); the next up-tick a buy (" + s2 + "/" + m2 + ", " + s3 + "/" + m3 + ")");
        BackfillSides r = ChartBridgeSides.ClassifyBackfill(new[] { close, open, open.AddSeconds(1) }, new[] { 100.25, 101.0, 101.25 }, 3,
            new List<DateTime> { close.AddSeconds(-1) }, new List<double> { 100 }, 1, new List<DateTime> { close.AddSeconds(-1) }, new List<double> { 100.25 }, 1, null, null, 0, 0.25);
        Check(Out(r) == "1/2 0/0 1/3" && r.SessionStarts == 1, "session, backfill: the same (" + Out(r) + "), live and backfill agree");
        List<SeamTick> rel = new List<SeamTick> {
            new SeamTick { Time = open, Price = 101, Volume = 1, Side = 1, Method = TR, Json = "{\"type\":\"tick\",\"p\":101,\"s\":1,\"sm\":3}" },
            new SeamTick { Time = open.AddSeconds(1), Price = 101, Volume = 1, Side = 1, Method = TR, Json = "{\"type\":\"tick\",\"p\":101,\"s\":1,\"sm\":3}" } };
        DateTime et2; double ep; int es;
        List<SeamTick> cont = ChartBridgeSides.ContinueTickRule(rel, close, 100.25, 1, out et2, out ep, out es);
        Check(cont[0].Side == 0 && cont[0].Method == N && cont[0].Json.EndsWith("\"s\":0,\"sm\":0}") && cont[1].Side == 0 && es == 0,
            "session, seam: released trades after the break start over too (" + cont[0].Json + " " + cont[1].Json + ")");
        cont = ChartBridgeSides.ContinueTickRule(rel, open.AddSeconds(-0.5 + 0.5), 100.5, -1, out et2, out ep, out es);
        Check(cont[0].Side == 1 && cont[1].Side == 1, "session, seam: within one session the chain continues (up from 100.5: a buy)");

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

    // Review 4 S1: a load's chunks are made and queued a few at a time. A 600,000-trade tick load through the real Subscribe,
    // the most chunks ever waiting and the time from NinjaTrader's answer to "ready" at the page, against queuing the whole
    // load at once (BulkWindow unlimited, as before): at the page's measured 3.5 ms a chunk (making a chunk takes longer
    // here, so few wait either way), and at 300 ms a chunk (slower than ChartBridge makes them here, about 75 ms on Mono: the old way queues nearly the whole load).
    static void LoadMemory()
    {
        var clients = (System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
        Bars big = new Bars();
        for (int i = 0; i < 600000; i++) big.Add(At(-3000 + i * 0.005), 100 + (i % 9) * 0.25, 0, 0, 100 + (i % 9) * 0.25, 1);
        int was = ChartBridgeClient.BulkWindow;
        try
        {
            foreach (double chunkMs in new[] { 3.5, 300.0 })
            foreach (int window in new[] { int.MaxValue, was })
            {
                Reset();
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
                System.Diagnostics.Stopwatch w = System.Diagnostics.Stopwatch.StartNew();
                Kind(m0, MarketDataType.Last, 1).Answer(big, ErrorCode.NoError);
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
        finally { ChartBridgeClient.BulkWindow = was; Reset(); }
    }

    static void LoadTick()
    {
        // A tick chart: quotes arrive live first, then trades held during the load. The backfill: 4 trades; its last (100.5 at
        // 1.000) is also held live. Its own quote update (bid up to 100.5, stamped 1.000) arrives before it; by the tie rule
        // (strictly before) live, like the backfill, uses the 0.9 quote: a buy both ways (0.3.4 review S3). The seam drops the
        // held copy.
        Reset();
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        NextBid = Rows(R(-40, 100), R(0.4, 100.25), R(1.0005, 100.25));
        NextAsk = Rows(R(-40, 100.25), R(0.4, 100.5), R(1.0005, 100.75));
        Priv("Subscribe", client, "MNQ", 5, 8);
        Quote(0.9, 100.25, 100.5);
        Quote(1.0, 100.5, 100.75);                 // the trade's own update, delivered first, same time: not used
        Trade(1.0, 100.5, 4);                      // in the backfill too: a buy (at the 0.9 ask), live and backfill alike
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
            "load: the held copy of the backfill's last trade is dropped; the rest carry s and sm");
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
        Check(d.Contains("\"quotedTrades\":1") && d.Contains("\"beforeQuotes\":1") && d.Contains("\"afterQuotes\":2") && d.Contains("\"note\":\"the bid/ask history does not cover every trade: 1 trade(s) before it, 2 after it and 0 with a quote over 60 s old went by the tick rule\""),
            "shorter: trades outside the quote history counted and named in /diag (" + Snip(d) + ")");
        Check(NinjaTrader.Code.Output.Lines.Any(x => x.Contains("MNQ trade sides: the bid/ask history does not cover every trade")), "shorter: and a line in the Output window");
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

    static void LoadSeamDisagree()
    {
        // The live quote and the quote history disagree about the seam trade (100.5 at 1.000): live says a sell (its bid is
        // 100.5), the history a buy. The side takes no part in the match: the held copy is still dropped, once. N3: the next
        // held trade (100.5 at 1.2, between the live quote, same price) goes by the tick rule; its side now continues from the
        // backfill's copy (a buy), not from the dropped live twin (a sell); and so does the next live trade after ready.
        Reset();
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        NextBid = Rows(R(-40, 100), R(0.8, 100));
        NextAsk = Rows(R(-40, 100.25), R(0.8, 100.25));
        Priv("Subscribe", client, "MNQ", 5, 8);
        Quote(0.5, 100.5, 100.75);
        Trade(1.0, 100.5, 4);                      // live: at the bid, a sell
        Quote(1.1, 100.25, 100.75);
        Trade(1.2, 100.5, 1);                      // live: between, same price: the twin's side (sell), tick rule
        Made(m0)[0].Answer(Minutes(new[] { 60.0, 1, 1, 1, 1, 1 }), ErrorCode.NoError);
        Kind(m0, MarketDataType.Last, 1).Answer(Rows(new[] { -30.0, 100, 1 }, new[] { 1.0, 100.5, 4 }), ErrorCode.NoError);
        Check(WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0), "seam, sides disagree: ready is sent");
        Thread.Sleep(30);
        List<string> l = Sent();
        Check(l[Index(l, "\"type\":\"ticks\"")].Contains(",100.5,4,1,2]"), "seam, sides disagree: the backfill calls the seam trade a buy");
        List<string> after = l.Skip(Index(l, "\"type\":\"ready\"") + 1).ToList();
        Check(after.Count == 1 && after[0].EndsWith("\"p\":100.5,\"v\":1,\"s\":1,\"sm\":3}"),
            "seam, sides disagree: the live copy (a sell) is dropped all the same; N3: the next held trade's tick rule continues from the backfill's buy (" + string.Join(" ", after) + ")");
        Trade(1.4, 100.5, 2);
        Check(Sent().Last().EndsWith("\"s\":1,\"sm\":3}"), "seam, N3: the next live trade after ready continues from it too");
        Reset();
    }

    static void LoadNoTrades()
    {
        // S1b: the trade request failed (twice): nothing to classify, so no wait for the quotes at all.
        Reset();
        Manual = true;
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
        Priv("Subscribe", client, "MNQ", 5, 8);
        Made(m0)[0].Answer(Minutes(new[] { 60.0, 1, 1, 1, 1, 1 }), ErrorCode.NoError);
        Kind(m0, MarketDataType.Last, 1).Answer(new Bars(), ErrorCode.Panic);
        Kind(m0, MarketDataType.Last, 2).Answer(new Bars(), ErrorCode.Panic);
        Check(WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0) && sw.ElapsedMilliseconds < ChartBridgeServer.QuoteWaitMs,
            "no trades: ready at once, without waiting for the quotes (" + sw.ElapsedMilliseconds + " ms)");
        Reset();
    }

    static void LoadWindow()
    {
        // S2: the quote window is at most QuoteHoursMax (24 h) back, whatever the trades ask (a range view up to 48 h); trades
        // before it go by the tick rule. And a resubscribe while the quotes load: the old load sends nothing more.
        Reset();
        Manual = true;
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        Priv("Subscribe", client, "MNQ", 5, 40);
        Made(m0)[0].Answer(Minutes(new[] { 60.0, 1, 1, 1, 1, 1 }), ErrorCode.NoError);
        BarsRequest last = Kind(m0, MarketDataType.Last, 1), bid = Kind(m0, MarketDataType.Bid, 0);
        Check(last != null && bid != null && Math.Abs((bid.From - last.From).TotalHours - 16) < 0.01,
            "window: a 40-hour trade request gets a 24-hour quote request (" + (bid != null && last != null ? (bid.From - last.From).TotalHours.ToString("0.##") : "?") + " h later start)");
        last.Answer(Rows(new[] { 1.0, 100, 1 }), ErrorCode.NoError);
        Priv("Subscribe", client, "MNQ", 5, 8);    // the page resubscribes while the quotes load
        int n = Sent().Count;
        Kind(m0, MarketDataType.Bid, 0).Answer(Rows(new[] { 0.5, 100 }), ErrorCode.NoError);
        Kind(m0, MarketDataType.Ask, 0).Answer(Rows(new[] { 0.5, 100.25 }), ErrorCode.NoError);
        Thread.Sleep(80);
        Check(!Sent().Skip(n).Any(x => x.Contains("\"type\":\"ticks\"") || x.Contains("\"type\":\"ready\"")), "window: a resubscribe during the quote wait: the old load sends nothing more");
        Reset();
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
        Manual = true;
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
                Priv("Subscribe", c, "MNQ", 1, 8);
                Made(m0)[0].Answer(Minutes(new[] { 60.0, 1, 1, 1, 1, 1 }), ErrorCode.NoError);
                Kind(m0, MarketDataType.Last, 1).Answer(Rows(Enumerable.Range(0, 30000).Select(i => new[] { -300 + i * 0.009, 20000 + (i % 7) * 0.25, 1 }).ToArray()), ErrorCode.NoError);
                for (int i = 0; i < n; i++) Md(MarketDataType.Last, 1 + i * 0.002, 20001, 1, 0, 0);   // held while the quotes load
                Kind(m0, MarketDataType.Bid, 0).Answer(Rows(new[] { -400.0, 19999.75 }), ErrorCode.NoError);
                Kind(m0, MarketDataType.Ask, 0).Answer(Rows(new[] { -400.0, 20000 }), ErrorCode.NoError);
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
        Check(Diag().Contains("\"quoteResets\":") && NinjaTrader.Code.Output.Lines.Count(x => x.Contains("market data reset (IsReset) on MNQ: type Last, price 0")) == 1
              && NinjaTrader.Code.Output.Lines.Count(x => x.Contains("market data reset (IsReset)")) == 1, "reset: the first reset is logged once, with its type and price");
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
