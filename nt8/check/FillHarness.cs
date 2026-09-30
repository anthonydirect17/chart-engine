// Live first (ChartBridge 0.3.5), run for real on Mono: the recent trades first, "ready", then the older history pulled by
// the page. First the two new joins as pure functions (ChartBridgeFill.FrontStart and Join), with a random proof that
// every trade sent from the recent window has the side a full load gives it. Then whole loads through ChartBridgeServer's
// own Subscribe, OnMarketData and "more", with a made-up tape of trades and quotes delivered live the whole time (a busy
// market during the load): every trade reaches the page exactly once, in order, with the side a full load of the same
// tape gives it. Then the pacing: a page at a realistic pace pulling a million older trades while 3,000 live trades a
// second arrive, against the 5 s rule. Made-up prices; nothing here is market data.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Threading;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript.AddOns;

public static class FillHarness
{
    static Action<bool, string> Check;
    const int Q = ChartBridgeSides.BidAsk, TR = ChartBridgeSides.TickRule;

    static object Priv(string name, params object[] args) { return typeof(ChartBridgeServer).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, args); }

    // ------------------------------------------------------------ a made-up tape
    // Trades and the Bid and Ask updates around them, in time order, as NinjaTrader would deliver them live and keep them
    // for its historical requests. Quotes move a tick now and then (spread one or two ticks), with size-only updates in
    // between (repeated prices, which the quote series thins); trades hit the ask, the bid, or (at a two-tick spread) the
    // middle, which goes by the tick rule. Times step 0 to 40 ms, so some trades share a millisecond. Seeded.
    class Tape
    {
        public readonly List<DateTime> T = new List<DateTime>(); public readonly List<double> P = new List<double>(); public readonly List<long> V = new List<long>();
        public readonly List<DateTime> BT = new List<DateTime>(); public readonly List<double> BP = new List<double>();
        public readonly List<DateTime> AT = new List<DateTime>(); public readonly List<double> AP = new List<double>();
        public readonly List<int[]> Events = new List<int[]>();   // {kind 0 trade, 1 bid, 2 ask; index}, in delivery order
    }
    static Tape MakeTape(DateTime t0, int trades, int sizeRows, int seed, double staleAt, double sessionAt, int maxStepMs = 40)
    {
        Tape k = new Tape();
        Random rnd = new Random(seed);
        double bid = 20000, ask = 20000.25;
        DateTime t = t0;
        long quiet = -1;                                   // quotes stop for 70 s after this trade (a stale quote)
        if (staleAt >= 0) quiet = (long)(staleAt * trades);
        for (int i = 0; i < trades; i++)
        {
            int step = rnd.Next(0, maxStepMs + 1);
            t = t.AddTicks(step * TimeSpan.TicksPerMillisecond);
            if (sessionAt >= 0 && i == (int)(sessionAt * trades)) t = t.AddMinutes(61);   // the 17:00 to 18:00 ET break
            bool silent = quiet >= 0 && i >= quiet && i < quiet + 400;   // the first of them trades 70 s after the last quote
            if (i == quiet) t = t.AddSeconds(70);
            if (!silent)
            {
                if (rnd.NextDouble() < 0.3)
                {
                    double mid = rnd.NextDouble() < 0.5 ? 0.25 : -0.25;
                    bid += mid; ask = bid + (rnd.NextDouble() < 0.3 ? 0.5 : 0.25);
                    k.BT.Add(t); k.BP.Add(bid); k.Events.Add(new[] { 1, k.BT.Count - 1 });
                    k.AT.Add(t); k.AP.Add(ask); k.Events.Add(new[] { 2, k.AT.Count - 1 });
                }
                // size-only updates (the same price again), stamped up to 2 ms before the trade or at its own time
                for (int s = 0; s < sizeRows; s++)
                {
                    DateTime ts = t.AddTicks(-rnd.Next(0, 3) * TimeSpan.TicksPerMillisecond);
                    bool isBid = rnd.NextDouble() < 0.5;
                    List<DateTime> qt = isBid ? k.BT : k.AT;
                    if (qt.Count > 0 && ts < qt[qt.Count - 1]) ts = qt[qt.Count - 1];
                    qt.Add(ts); (isBid ? k.BP : k.AP).Add(isBid ? bid : ask);
                    k.Events.Add(new[] { isBid ? 1 : 2, qt.Count - 1 });
                }
            }
            double r = rnd.NextDouble();
            double p = r < 0.44 ? ask : r < 0.88 ? bid : ask - bid > 0.3 ? bid + 0.25 : k.P.Count > 0 ? k.P[k.P.Count - 1] : bid;
            k.T.Add(t); k.P.Add(p); k.V.Add(1 + rnd.Next(0, 5));
            k.Events.Add(new[] { 0, k.T.Count - 1 });
        }
        return k;
    }
    static Bars TradeBars(Tape k, int from, int to) { Bars b = new Bars(); for (int i = Math.Max(0, from); i < to; i++) b.Add(k.T[i], k.P[i], k.P[i], k.P[i], k.P[i], k.V[i]); return b; }
    static Bars QuoteBars(List<DateTime> t, List<double> p, int from, int to) { Bars b = new Bars(); for (int i = Math.Max(0, from); i < to; i++) b.Add(t[i], p[i], p[i], p[i], p[i], 5); return b; }
    // A full load's sides: every trade, with the quote rows from quoteFrom on (ChartBridgeServer.QuoteStart: a full load keeps
    // rows from now minus min(tickHours, 24) h; review S1: the proof has to cut its full load there too).
    static BackfillSides Full(Tape k, int n, int nb, int na) { return Full(k, n, nb, na, DateTime.MinValue); }
    static BackfillSides Full(Tape k, int n, int nb, int na, DateTime quoteFrom)
    {
        QuoteSeries b = QuoteSeries.From(QuoteBars(k.BT, k.BP, 0, nb), quoteFrom), a = QuoteSeries.From(QuoteBars(k.AT, k.AP, 0, na), quoteFrom);
        return ChartBridgeSides.ClassifyBackfill(k.T.Take(n).ToArray(), k.P.Take(n).ToArray(), n, b.Time, b.Price, b.Seen, b.Count, a.Time, a.Price, a.Seen, a.Count, null, null, -1, 0.25);
    }

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        FrontPure();
        SidesProof();
        SidesQuoteStart();
        JoinPure();
        JoinReview();
        JoinProperty();
        JoinCasesFile();
        Format();
    }

    // ------------------------------------------------------------ the faster trade text is the same text
    // Every trade 0.3.5 formats (the backfill and the older history) must read exactly as 0.3.4 wrote it: the same time to
    // the millisecond across daylight saving changes in NinjaTrader's zone and New York's, the same price and volume text.
    static string Old(DateTime nt, double p, long v, int s, int m)
    {
        double t = ChartBridgeTime.EtSeconds(ChartBridgeTime.ToUtc(nt));
        return "[" + CbJson.Num3(t) + "," + CbJson.Num(p) + "," + v.ToString(CultureInfo.InvariantCulture) + "," + s.ToString(CultureInfo.InvariantCulture) + "," + m.ToString(CultureInfo.InvariantCulture) + "]";
    }
    static void Format()
    {
        Random rnd = new Random(4242);
        int compared = 0, differ = 0; string first = null;
        string[] zones = { null, "America/New_York", "America/Chicago", "Europe/London", "Asia/Kolkata", "Australia/Lord_Howe", "UTC" };
        DateTime[] around = { new DateTime(2026, 3, 8), new DateTime(2026, 11, 1), new DateTime(2026, 3, 29), new DateTime(2026, 10, 25), new DateTime(2026, 4, 5), new DateTime(2026, 9, 29) };
        TimeZoneInfo was = NinjaTrader.Core.GeneralOptionsClass.Zone;
        try
        {
            foreach (string z in zones)
            {
                NinjaTrader.Core.GeneralOptionsClass.Zone = z == null ? null : TimeZoneInfo.FindSystemTimeZoneById(z);
                foreach (DateTime day in around)
                {
                    int n = 6000;
                    RawBars bars = new RawBars { Count = n, Time = new DateTime[n], Close = new double[n], Volume = new long[n] };
                    BackfillSides sd = new BackfillSides { Side = new sbyte[n], Method = new byte[n], Trades = n };
                    long tick = day.AddDays(-1).Ticks;
                    for (int i = 0; i < n; i++)
                    {
                        tick += (long)(rnd.NextDouble() * 60 * TimeSpan.TicksPerSecond);   // up to a minute apart: 4 days
                        if (rnd.NextDouble() < 0.05) tick += rnd.Next(0, 3) * 5000;        // on half milliseconds now and then
                        bars.Time[i] = new DateTime(tick);
                        int k = rnd.Next(0, 6);
                        bars.Close[i] = k == 0 ? 20000 + rnd.Next(0, 4000) * 0.25 : k == 1 ? rnd.Next(1, 100000) * 0.01 : k == 2 ? rnd.NextDouble() * 50000 : k == 3 ? -rnd.Next(1, 800) * 0.25 : k == 4 ? rnd.Next(1, 9) * 0.0001 : 1e10 + rnd.Next(0, 100);
                        bars.Volume[i] = rnd.Next(0, 3) == 0 ? rnd.Next(1, 10) : (long)rnd.Next(0, int.MaxValue) * 1000;
                        sd.Side[i] = (sbyte)rnd.Next(-1, 2); sd.Method[i] = (byte)rnd.Next(0, 4);
                    }
                    ChartBridgeTime.EtCache et = new ChartBridgeTime.EtCache();
                    for (int i = 0; i < n; i++)
                    {
                        System.Text.StringBuilder b = new System.Text.StringBuilder();
                        ChartBridgeServer.AppendTrade(b, bars, sd, i, et);
                        string o = Old(bars.Time[i], bars.Close[i], bars.Volume[i], sd.Side[i], sd.Method[i]);
                        compared++;
                        if (b.ToString() != o) { differ++; if (first == null) first = (z ?? "local") + " " + bars.Time[i].ToString("o") + ": " + b + " against " + o; }
                    }
                }
            }
        }
        finally { NinjaTrader.Core.GeneralOptionsClass.Zone = was; }
        Check(differ == 0 && compared > 200000, "format: " + compared.ToString("N0", CultureInfo.InvariantCulture) + " trades written the fast way read exactly as 0.3.4 wrote them, in 7 NinjaTrader time zones across the 2026 DST changes" + (first != null ? " (" + differ + " differ; first: " + first + ")" : ""));
        // And what it saves: a 100,000-trade chunk both ways.
        int m2 = 100000;
        RawBars rb = new RawBars { Count = m2, Time = new DateTime[m2], Close = new double[m2], Volume = new long[m2] };
        BackfillSides rs = new BackfillSides { Side = new sbyte[m2], Method = new byte[m2], Trades = m2 };
        for (int i = 0; i < m2; i++) { rb.Time[i] = DateTime.Now.AddHours(-3).AddTicks(i * 311117L); rb.Close[i] = 20000 + (i % 41) * 0.25; rb.Volume[i] = 1 + i % 5; rs.Side[i] = (sbyte)(i % 3 - 1); rs.Method[i] = 2; }
        double oldUs = 1e9, newUs = 1e9;
        for (int rep = 0; rep < 3; rep++)
        {
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            System.Text.StringBuilder a = new System.Text.StringBuilder();
            for (int i = 0; i < m2; i++) a.Append(Old(rb.Time[i], rb.Close[i], rb.Volume[i], rs.Side[i], rs.Method[i]));
            oldUs = Math.Min(oldUs, sw.Elapsed.TotalMilliseconds * 1000 / m2);
            sw = System.Diagnostics.Stopwatch.StartNew();
            System.Text.StringBuilder c = new System.Text.StringBuilder();
            ChartBridgeTime.EtCache et = new ChartBridgeTime.EtCache();
            for (int i = 0; i < m2; i++) ChartBridgeServer.AppendTrade(c, rb, rs, i, et);
            newUs = Math.Min(newUs, sw.Elapsed.TotalMilliseconds * 1000 / m2);
        }
        Console.WriteLine("     (a trade's text: " + oldUs.ToString("0.00", CultureInfo.InvariantCulture) + " us as 0.3.4 wrote it, " + newUs.ToString("0.00", CultureInfo.InvariantCulture) + " us now, Mono on the build box)");
        Check(newUs < oldUs, "format: faster than before (" + newUs.ToString("0.00", CultureInfo.InvariantCulture) + " against " + oldUs.ToString("0.00", CultureInfo.InvariantCulture) + " us a trade)");
    }

    // ------------------------------------------------------------ FrontStart, by hand
    static void FrontPure()
    {
        DateTime b0 = new DateTime(2026, 9, 29, 10, 0, 0);
        Func<double, DateTime> at = x => b0.AddTicks((long)(x * TimeSpan.TicksPerSecond));
        BackfillSides s = new BackfillSides { Side = new sbyte[5], Method = new byte[] { TR, TR, TR, Q, TR }, UnitTicks = ChartBridgeSeam.Ms };
        int qf;
        DateTime[] t = { at(0), at(1), at(2), at(3), at(4) };
        int w = ChartBridgeFill.FrontStart(t, new[] { 1.0, 1, 1, 1, 1 }, 5, s, false, DateTime.MinValue, DateTime.MinValue, out qf);
        Check(w == 3 && qf == 0, "front: unchanged prices lean on the trade before the window, until the first trade classified by the quote (" + w + ")");
        w = ChartBridgeFill.FrontStart(t, new[] { 1.0, 1, 1.25, 1, 1 }, 5, s, false, DateTime.MinValue, DateTime.MinValue, out qf);
        Check(w == 2, "front: or the first price change, whose tick rule needs only the trade before it (" + w + ")");
        w = ChartBridgeFill.FrontStart(t, new[] { 1.0, 1.25, 1.5, 1, 1 }, 5, new BackfillSides { Side = new sbyte[5], Method = new byte[] { Q, TR, TR, TR, TR }, UnitTicks = 1 }, false, DateTime.MinValue, DateTime.MinValue, out qf);
        Check(w == 0, "front: a first trade classified by the quote starts the window");
        // The quote cut: quotes from 10:00:00; trades up to 10:01:00.000 could have a quote older than the window's.
        DateTime[] t2 = { at(30), at(60), at(60.001), at(61), at(90) };
        w = ChartBridgeFill.FrontStart(t2, new[] { 1.0, 1.25, 1.5, 1.75, 2 }, 5, new BackfillSides { Side = new sbyte[5], Method = new byte[] { Q, Q, Q, Q, Q }, UnitTicks = ChartBridgeSeam.Ms }, true, at(0), at(0), out qf);
        Check(qf == 2 && w == 2, "front: a trade is sent from the recent window only more than 60 s after the later quote history's start (quote cut " + qf + ", front " + w + ")");
        // A session start inside the window: the first trade of the session does not lean on the one before.
        DateTime e1 = SidesHarnessEt(2026, 9, 29, 17, 59, 59.5), e2 = SidesHarnessEt(2026, 9, 29, 18, 0, 0.2);
        w = ChartBridgeFill.FrontStart(new[] { e1, e1.AddMilliseconds(100), e2, e2.AddMilliseconds(5) }, new[] { 1.0, 1, 1, 1 }, 4, new BackfillSides { Side = new sbyte[4], Method = new byte[] { TR, TR, 0, TR }, UnitTicks = 1 }, false, DateTime.MinValue, DateTime.MinValue, out qf);
        Check(w == 2, "front: the first trade after 18:00 ET starts the window (the tick rule starts over there) (" + w + ")");
        w = ChartBridgeFill.FrontStart(t, new[] { 1.0, 1, 1, 1, 1 }, 5, new BackfillSides { Side = new sbyte[5], Method = new byte[] { TR, TR, TR, TR, TR }, UnitTicks = 1 }, false, DateTime.MinValue, DateTime.MinValue, out qf);
        Check(w == 5, "front: no trade with a side of its own: none (the load falls back to a full load)");
        Check(ChartBridgeFill.FrontStart(new DateTime[0], new double[0], 0, null, false, DateTime.MinValue, DateTime.MinValue, out qf) == 0, "front: an empty window");
    }
    static DateTime SidesHarnessEt(int y, int mo, int d, int h, int mi, double sec)
    {
        DateTime wall = new DateTime(y, mo, d, h, mi, 0, DateTimeKind.Unspecified).AddTicks((long)Math.Round(sec * TimeSpan.TicksPerSecond));
        return DateTime.SpecifyKind(TimeZoneInfo.ConvertTimeFromUtc(TimeZoneInfo.ConvertTimeToUtc(wall, ChartBridgeTime.Eastern), NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo), DateTimeKind.Unspecified);
    }

    // ------------------------------------------------------------ the sides proof
    // 400 made-up tapes (some with a 70 s quote silence, some across the 17:00 to 18:00 ET break). Each has a quote start,
    // as every load has (ChartBridgeServer.QuoteStart): before the tape, or somewhere inside it (review S1: a full load keeps
    // quote rows from there only, so the proof's full load does too). The recent window is the last N trades and the last M
    // rows of each quote side (N and M random), cut at the same quote start, classified as ChartBridge does it; the full
    // load classifies every trade with the rows from the quote start. From FrontStart on, every side and method must agree.
    static void SidesProof()
    {
        int trials = 400, compared = 0, bad = 0, cutMattered = 0, quoteCut = 0, startInside = 0;
        string firstBad = null;
        for (int trial = 0; trial < trials; trial++)
        {
            Random rnd = new Random(1000 + trial);
            DateTime start = trial % 4 == 1 ? SidesHarnessEt(2026, 9, 29, 16, 59, 45) : new DateTime(2026, 9, 29, 10, 0, 0);
            Tape k = MakeTape(start, 1500, rnd.Next(0, 6), 5000 + trial, trial % 3 == 0 ? rnd.NextDouble() : -1, trial % 4 == 1 ? 0.2 + rnd.NextDouble() * 0.6 : -1);
            int n = k.T.Count;
            DateTime qFrom = trial % 2 == 0 ? DateTime.MinValue : k.T[rnd.Next(0, n)];   // half the tapes: the quote start inside
            if (qFrom != DateTime.MinValue) startInside++;
            BackfillSides full = Full(k, n, k.BT.Count, k.AT.Count, qFrom);
            int rn = rnd.Next(50, n), mb = rnd.Next(20, k.BT.Count + 1), ma = rnd.Next(20, k.AT.Count + 1);
            DateTime[] rt = k.T.Skip(n - rn).ToArray(); double[] rp = k.P.Skip(n - rn).ToArray();
            QuoteSeries qb = QuoteSeries.From(QuoteBars(k.BT, k.BP, k.BT.Count - mb, k.BT.Count), qFrom);
            QuoteSeries qa = QuoteSeries.From(QuoteBars(k.AT, k.AP, k.AT.Count - ma, k.AT.Count), qFrom);
            BackfillSides rec = ChartBridgeSides.ClassifyBackfill(rt, rp, rn, qb.Time, qb.Price, qb.Seen, qb.Count, qa.Time, qa.Price, qa.Seen, qa.Count, null, null, -1, 0.25);
            int qf;
            int w = ChartBridgeFill.FrontStart(rt, rp, rn, rec, qb.Count > 0 && qa.Count > 0, qb.Count > 0 ? qb.Time[0] : DateTime.MinValue, qa.Count > 0 ? qa.Time[0] : DateTime.MinValue, out qf);
            if (qf > 0) quoteCut++;
            for (int i = 0; i < rn; i++)
            {
                bool same = rec.Side[i] == full.Side[n - rn + i] && rec.Method[i] == full.Method[n - rn + i];
                if (i < w) { if (!same) cutMattered++; continue; }
                compared++;
                if (!same) { bad++; if (firstBad == null) firstBad = "trial " + trial + " trade " + i + " of " + rn + " (front " + w + "): recent " + rec.Side[i] + "/" + rec.Method[i] + ", full " + full.Side[n - rn + i] + "/" + full.Method[n - rn + i]; }
            }
        }
        Console.WriteLine("     (" + trials + " tapes, " + startInside + " with the quote start inside them: " + compared.ToString("N0", CultureInfo.InvariantCulture) + " recent trades from the front compared, " + bad + " differ; before the front " + cutMattered + " differ; the quote cut moved the front in " + quoteCut + ")");
        Check(bad == 0 && compared > 20000, "sides proof: every trade from the recent window's front has the side and method a full load gives it (" + compared + " compared" + (firstBad != null ? "; " + firstBad : "") + ")");
        Check(cutMattered > 0 && quoteCut > 0, "sides proof: the cut is not idle: trades before the front do differ (" + cutMattered + "), and the quote cut moved it in " + quoteCut + " tapes");
    }

    // ------------------------------------------------------------ Join, by hand
    static void JoinPure()
    {
        DateTime b0 = new DateTime(2026, 9, 29, 10, 0, 0);
        Func<double, DateTime> at = x => b0.AddTicks((long)Math.Round(x * TimeSpan.TicksPerSecond));
        // B: 0.1 0.2 [0.3 x3: 10 11 10] 0.4 0.5; R (the recent window) starts at the second 0.3 trade.
        DateTime[] bt = { at(0.1), at(0.2), at(0.3), at(0.3), at(0.3), at(0.4), at(0.5) };
        double[] bp = { 1, 2, 10, 11, 10, 3, 4 }; long[] bv = { 1, 1, 1, 1, 1, 1, 1 };
        DateTime[] rt = { at(0.3), at(0.3), at(0.4), at(0.5) }; double[] rp = { 11, 10, 3, 4 }; long[] rv = { 1, 1, 1, 1 };
        FillJoin j = ChartBridgeFill.Join(bt, bp, bv, 7, rt, rp, rv, 4, 0);
        Check(j.Index == 3 && j.Matched && j.Truncated && j.Checked == 4, "join: a window cut inside one millisecond's trades is found by matching (older history = the first 3) (" + j.Index + ")");
        // The page got R from its second trade (the front); B's copy of it is the second of R's trades at 0.3 in B.
        DateTime[] rt2 = { at(0.25), at(0.3), at(0.3), at(0.4) }; double[] rp2 = { 7, 10, 11, 3 };
        DateTime[] bt2 = { at(0.1), at(0.25), at(0.3), at(0.3), at(0.4), at(0.5) }; double[] bp2 = { 1, 7, 10, 11, 3, 4 };
        j = ChartBridgeFill.Join(bt2, bp2, new long[] { 1, 1, 1, 1, 1, 1 }, 6, rt2, rp2, rv, 4, 2);
        Check(j.Index == 3 && j.Matched && !j.Truncated, "join: by position among the trades at the front's time (" + j.Index + ")");
        // Identical trades at one time: position decides, not the price.
        DateTime[] bt3 = { at(1), at(1), at(1), at(1), at(2) }; double[] bp3 = { 5, 5, 5, 5, 6 };
        DateTime[] rt3 = { at(0.5), at(1), at(1), at(1), at(1), at(2) }; double[] rp3 = { 4, 5, 5, 5, 5, 6 };
        j = ChartBridgeFill.Join(bt3, bp3, new long[] { 1, 1, 1, 1, 1 }, 5, rt3, rp3, new long[] { 1, 1, 1, 1, 1, 1 }, 6, 3);
        Check(j.Index == 2 && j.Matched, "join: four identical trades at one time, the page has the last two: the older history holds the first two (" + j.Index + ")");
        // The older history ends before the page's first trade: all of it, and the gap is reported.
        j = ChartBridgeFill.Join(new[] { at(0.1), at(0.2) }, new[] { 1.0, 2 }, new long[] { 1, 1 }, 2, rt, rp, rv, 4, 0);
        Check(j.Index == 2 && !j.Matched && Math.Abs(j.GapMs - 100) < 0.01 && j.Send == 0, "join: older history ending " + j.GapMs + " ms before the window: none of it is sent (trades in between could be missing)");
        // NinjaTrader's two answers differ past the join: the positional join is kept and the mismatch reported.
        double[] bp4 = (double[])bp.Clone(); bp4[5] = 99;
        j = ChartBridgeFill.Join(bt, bp4, bv, 7, rt, rp, rv, 4, 0);
        Check(!j.Matched && j.MismatchAt >= 0 && j.Send == 0, "join: answers that differ are reported, and nothing is sent (mismatch at " + j.MismatchAt + ", index " + j.Index + ")");
        j = ChartBridgeFill.Join(new DateTime[0], new double[0], new long[0], 0, rt, rp, rv, 4, 0);
        Check(j.Index == 0 && !j.Matched && j.Send == 0, "join: no older history: nothing to send");
        // Forward alike, backward not: the older history lacks a trade the recent window has before its front.
        DateTime[] btx = { at(0.1), at(0.2), at(0.3), at(0.4) }; double[] bpx = { 1, 2, 3, 4 };
        DateTime[] rtx = { at(0.1), at(0.15), at(0.2), at(0.3), at(0.4) }; double[] rpx = { 1, 9, 2, 3, 4 };
        j = ChartBridgeFill.Join(btx, bpx, new long[] { 1, 1, 1, 1 }, 4, rtx, rpx, new long[] { 1, 1, 1, 1, 1 }, 5, 3);
        Check(!j.Matched && j.Send == 0, "join: the trades before the join are checked too (the older history lacks one the recent window has): not proven, nothing sent");
        // Whole-second data: the same rule, on whole seconds.
        DateTime[] bt5 = { at(1), at(2), at(2), at(2), at(3) }; double[] bp5 = { 1, 2, 3, 2, 4 };
        DateTime[] rt5 = { at(2), at(2), at(3) }; double[] rp5 = { 3, 2, 4 };
        j = ChartBridgeFill.Join(bt5, bp5, new long[] { 1, 1, 1, 1, 1 }, 5, rt5, rp5, new long[] { 1, 1, 1 }, 3, 0);
        Check(j.Index == 2 && j.Matched, "join: whole-second times (" + j.Index + ")");
        // A big join: 2,000,000 older trades, found in microseconds (binary search).
        int big = 2000000;
        DateTime[] btb = new DateTime[big]; double[] bpb = new double[big]; long[] bvb = new long[big];
        for (int i = 0; i < big; i++) { btb[i] = at(i * 0.01); bpb[i] = 100 + (i % 7) * 0.25; bvb[i] = 1 + i % 3; }
        DateTime[] rtb = btb.Skip(big - 50000).ToArray(); double[] rpb = bpb.Skip(big - 50000).ToArray(); long[] rvb = bvb.Skip(big - 50000).ToArray();
        double best = double.MaxValue;
        for (int rep = 0; rep < 3; rep++)   // the best of three: one pause of a shared build box is not the join's cost
        {
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            j = ChartBridgeFill.Join(btb, bpb, bvb, big, rtb, rpb, rvb, 50000, 123);
            sw.Stop();
            best = Math.Min(best, sw.Elapsed.TotalMilliseconds);
        }
        Check(j.Index == big - 50000 + 123 && j.Matched && j.Checked == ChartBridgeFill.JoinCheck && best < 50, "join: 2,000,000 older trades joined in " + best.ToString("0.00") + " ms, " + j.Checked + " checked");
    }


    // ------------------------------------------------------------ review of live first: the joins that were wrong (J1 to J4)
    // The page's trades after the join are B[0 .. Send) then R[w ..]. They must be the truth from the page's first trade on:
    // no trade twice, none missing, in time order (a proven join gives the whole truth, an unproven one the recent part).
    static string Row(DateTime b0, DateTime t, double p, long v) { return ((t - b0).TotalSeconds).ToString("0.###", CultureInfo.InvariantCulture) + "|" + p.ToString(CultureInfo.InvariantCulture) + "|" + v; }
    static bool PageIsTruthTail(FillJoin j, DateTime[] bt, double[] bp, long[] bv, DateTime[] rt, double[] rp, long[] rv, int w, DateTime[] tt, double[] tp, long[] tv, out string page)
    {
        DateTime b0 = tt.Length > 0 ? tt[0] : DateTime.MinValue;
        List<string> pg = new List<string>(), truth = new List<string>();
        for (int i = 0; i < j.Send; i++) pg.Add(Row(b0, bt[i], bp[i], bv[i]));
        for (int i = w; i < rt.Length; i++) pg.Add(Row(b0, rt[i], rp[i], rv[i]));
        for (int i = 0; i < tt.Length; i++) truth.Add(Row(b0, tt[i], tp[i], tv[i]));
        page = string.Join(" ", pg.ToArray());
        if (pg.Count > truth.Count) return false;
        for (int i = 0; i < pg.Count; i++) if (pg[i] != truth[truth.Count - pg.Count + i]) return false;
        return true;
    }
    static void JoinReview()
    {
        DateTime b0 = new DateTime(2026, 9, 25, 16, 50, 0);
        Func<DateTime, double, DateTime> at = (b, x) => b.AddTicks((long)Math.Round(x * TimeSpan.TicksPerSecond));
        string page;
        // J1: the Sunday 18:00 ET open. R (the last trades by count) reaches back into Friday; B (a request by date: whole
        // trading days) holds only Sunday. R[0] and R[1] share a millisecond and the front is R[1] (g0 = 1).
        {
            DateTime fri = b0, sun = new DateTime(2026, 9, 27, 18, 0, 0);
            DateTime[] rt = { at(fri, 0), at(fri, 0), at(fri, 1), at(fri, 2), sun, sun, at(sun, 0.5) };
            double[] rp = { 100, 100.25, 100.5, 100.25, 101, 101, 101.25 }; long[] rv = { 1, 2, 1, 1, 40, 3, 1 };
            BackfillSides rs = new BackfillSides { Trades = 7, Side = new sbyte[7], Method = new byte[] { TR, Q, Q, Q, Q, Q, Q }, UnitTicks = ChartBridgeSeam.Ms };
            int qf, w = ChartBridgeFill.FrontStart(rt, rp, 7, rs, false, DateTime.MinValue, DateTime.MinValue, out qf);
            DateTime[] bt = { sun, sun, at(sun, 0.5) }; double[] bp = { 101, 101, 101.25 }; long[] bv = { 40, 3, 1 };
            FillJoin j = ChartBridgeFill.Join(bt, bp, bv, 3, rt, rp, rv, 7, w);
            bool ok = PageIsTruthTail(j, bt, bp, bv, rt, rp, rv, w, rt.Skip(w).ToArray(), rp.Skip(w).ToArray(), rv.Skip(w).ToArray(), out page);
            Check(w == 1 && j.StartsAfter && j.Matched && j.Index == 0 && j.Send == 0 && ok,
                "review J1 (Sunday open: the older history starts after the page's first trade): nothing older is sent, B checked where it starts (front " + w + ", index " + j.Index + ", matched " + j.Matched + "); the page: " + page);
        }
        // J2: B has fewer trades at T0 than R has before the front (NinjaTrader's two answers differ at T0).
        {
            DateTime[] rt = { at(b0, 0), at(b0, 1), at(b0, 1), at(b0, 1), at(b0, 2), at(b0, 3) };
            double[] rp = { 99, 100, 100.25, 100.5, 100.75, 101 }; long[] rv = { 1, 1, 1, 1, 1, 1 };
            int w = 3;
            DateTime[] bt = { at(b0, -1), at(b0, 0), at(b0, 1), at(b0, 2), at(b0, 3) }; double[] bp = { 98, 99, 100, 100.75, 101 }; long[] bv = { 1, 1, 1, 1, 1 };
            FillJoin j = ChartBridgeFill.Join(bt, bp, bv, 5, rt, rp, rv, 6, w);
            bool ok = PageIsTruthTail(j, bt, bp, bv, rt, rp, rv, w, bt.Take(3).Concat(rt.Skip(3)).ToArray(), bp.Take(3).Concat(rp.Skip(3)).ToArray(), bv.Take(3).Concat(rv.Skip(3)).ToArray(), out page);
            Check(j.Index <= 3 && !j.Matched && j.Send == 0 && ok, "review J2 (fewer trades at the front's time in the older history): the index stays within B's trades at T0 (" + j.Index + " <= 3), not proven, nothing sent; the page: " + page);
        }
        // J3: the same trades at T0 in another order in the two answers.
        {
            DateTime[] rt = { at(b0, 0), at(b0, 1), at(b0, 1), at(b0, 1), at(b0, 2) }; double[] rp = { 99, 100, 100.25, 100.5, 101 }; long[] rv = { 1, 5, 7, 2, 1 };
            int w = 2;
            DateTime[] bt = { at(b0, -1), at(b0, 0), at(b0, 1), at(b0, 1), at(b0, 1), at(b0, 2) }; double[] bp = { 98, 99, 100.25, 100, 100.5, 101 }; long[] bv = { 1, 1, 7, 5, 2, 1 };
            FillJoin j = ChartBridgeFill.Join(bt, bp, bv, 6, rt, rp, rv, 5, w);
            bool ok = PageIsTruthTail(j, bt, bp, bv, rt, rp, rv, w, new[] { at(b0, -1), at(b0, 0), at(b0, 1), at(b0, 1), at(b0, 1), at(b0, 2) }, new[] { 98, 99, 100, 100.25, 100.5, 101.0 }, new long[] { 1, 1, 5, 7, 2, 1 }, out page);
            Check(!j.Matched && j.MismatchAt >= 0 && j.Send == 0 && ok, "review J3 (same-time trades in another order): not proven (mismatch at " + j.MismatchAt + "), nothing sent, so no trade twice and none swapped; the page: " + page);
        }
        // J4: the window cut inside five identical 1-lots (a control: exact before and after).
        {
            DateTime[] rt = { at(b0, 1), at(b0, 1), at(b0, 1), at(b0, 2) }; double[] rp = { 100, 100, 100, 100.25 }; long[] rv = { 1, 1, 1, 1 };
            DateTime[] bt = { at(b0, 0), at(b0, 1), at(b0, 1), at(b0, 1), at(b0, 1), at(b0, 1), at(b0, 2) }; double[] bp = { 99, 100, 100, 100, 100, 100, 100.25 }; long[] bv = { 1, 1, 1, 1, 1, 1, 1 };
            FillJoin j = ChartBridgeFill.Join(bt, bp, bv, 7, rt, rp, rv, 4, 0);
            bool ok = PageIsTruthTail(j, bt, bp, bv, rt, rp, rv, 0, bt, bp, bv, out page);
            Check(j.Matched && j.Send == 3 && ok && page.Split(' ').Length == 7, "review J4 (a window cut inside identical 1-lots, control): exact, all 7 trades once (" + page + ")");
        }
    }

    // A random hunt: a true tape; R its last trades by count (sometimes starting inside one millisecond's trades); a front
    // w; B the tape from a start (before the front, or after it as whole trading days can be), and now and then NinjaTrader's
    // two answers differing near the front, inside R (a trade missing, two same-time trades swapped, a volume changed). Whatever
    // happens, the page's trades must be the truth from its first trade on, and an untouched B that covers the front must
    // be sent whole.
    static void JoinProperty()
    {
        int trials = 3000, proven = 0, startsAfter = 0, touched = 0, bad = 0, lost = 0;
        string first = null;
        for (int trial = 0; trial < trials; trial++)
        {
            Random rnd = new Random(900 + trial);
            int n = rnd.Next(40, 400);
            DateTime t = new DateTime(2026, 9, 29, 10, 0, 0);
            List<DateTime> tt = new List<DateTime>(); List<double> tp = new List<double>(); List<long> tv = new List<long>();
            double px = 100;
            for (int i = 0; i < n; i++)
            {
                if (rnd.NextDouble() > 0.45) t = t.AddMilliseconds(rnd.Next(1, 4));   // many trades share a millisecond
                px += rnd.NextDouble() < 0.3 ? 0.25 : rnd.NextDouble() < 0.43 ? -0.25 : 0;
                tt.Add(t); tp.Add(px); tv.Add(rnd.NextDouble() < 0.5 ? 1 : rnd.Next(1, 6));
            }
            // at least 20 trades from the front on (on the trading PC, R is 100,000 trades and the check runs over 2,000
            // each way; a handful of made-up 1-lots could match by chance)
            int rn = rnd.Next(21, n + 1), r0 = n - rn, w = rnd.Next(0, rn - 20);
            DateTime[] rt = tt.Skip(r0).ToArray(); double[] rp = tp.Skip(r0).ToArray(); long[] rv = tv.Skip(r0).ToArray();
            int b0 = rnd.NextDouble() < 0.2 ? rnd.Next(r0 + w, n) : rnd.Next(0, r0 + w + 1);   // B's first trade in the tape
            if (b0 >= n) b0 = n - 1;
            List<DateTime> bt = tt.Skip(b0).ToList(); List<double> bp = tp.Skip(b0).ToList(); List<long> bv = tv.Skip(b0).ToList();
            bool touch = rnd.NextDouble() < 0.4;
            if (touch)
            {
                touched++;
                // near the front, and never before R's first trade: there B is the only answer, so it is the truth
                int at = Math.Max(Math.Max(0, r0 - b0), Math.Min(bt.Count - 1, (r0 + w - b0) + rnd.Next(-4, 5)));
                double k = rnd.NextDouble();
                if (k < 0.34 && bt.Count > 1) { bt.RemoveAt(at); bp.RemoveAt(at); bv.RemoveAt(at); }
                else if (k < 0.67 && at + 1 < bt.Count && bt[at] == bt[at + 1]) { double x = bp[at]; bp[at] = bp[at + 1]; bp[at + 1] = x; long y = bv[at]; bv[at] = bv[at + 1]; bv[at + 1] = y; }
                else bv[at] += 1;
            }
            FillJoin j = ChartBridgeFill.Join(bt.ToArray(), bp.ToArray(), bv.ToArray(), bt.Count, rt, rp, rv, rn, w);
            if (j.Proven) proven++;
            if (j.StartsAfter) startsAfter++;
            string page;
            // The truth: the tape (B untouched there) up to the front; B as NinjaTrader gave it is what the page may hold.
            bool ok = PageIsTruthTail(j, bt.ToArray(), bp.ToArray(), bv.ToArray(), rt, rp, rv, w, tt.ToArray(), tp.ToArray(), tv.ToArray(), out page);
            if (!ok) { bad++; if (first == null) first = "trial " + trial + " (rn " + rn + ", w " + w + ", B from " + b0 + ", touched " + touch + ", index " + j.Index + ", send " + j.Send + "): " + page; }
            if (!touch && b0 <= r0 + w && j.Send != r0 + w - b0) { lost++; if (first == null) first = "trial " + trial + ": an untouched B covering the front sent " + j.Send + " of " + (r0 + w - b0); }
        }
        Console.WriteLine("     (join hunt: " + trials + " tapes, " + touched + " with the two answers differing near the front, " + startsAfter + " with B starting after the front; " + proven + " proven)");
        Check(bad == 0 && lost == 0, "join hunt: in every tape the page's trades are the truth from its first trade on, and an untouched older history covering the front is sent whole (" + trials + " tapes)" + (first != null ? "; first wrong: " + first : ""));
    }

    // Review S1: the recent window's quote rows by count are cut at the full load's quote start (QuoteStart), so a trade
    // sent from the front has a full load's side even when the rows by count reach back before it. The reviewer's case:
    // quotes over 3 hours, tickHours 1.
    static void SidesQuoteStart()
    {
        Random rnd = new Random(7);
        DateTime t0 = new DateTime(2026, 9, 29, 20, 0, 0);
        List<DateTime> tt = new List<DateTime>(), bt = new List<DateTime>(), at = new List<DateTime>();
        List<double> tp = new List<double>(), bp = new List<double>(), ap = new List<double>();
        double bid = 20000, ask = 20000.25; DateTime t = t0;
        for (int i = 0; i < 20000; i++)
        {
            t = t.AddMilliseconds(rnd.Next(100, 1000));
            if (rnd.NextDouble() < 0.3) { bid += rnd.NextDouble() < 0.5 ? 0.25 : -0.25; ask = bid + (rnd.NextDouble() < 0.3 ? 0.5 : 0.25); }
            bt.Add(t.AddMilliseconds(-5)); bp.Add(bid); at.Add(t.AddMilliseconds(-5)); ap.Add(ask);
            double r = rnd.NextDouble();
            tt.Add(t); tp.Add(r < 0.45 ? ask : r < 0.9 ? bid : ask - bid > 0.3 ? bid + 0.25 : bid);
        }
        DateTime now = tt[tt.Count - 1];
        DateTime quoteFrom = ChartBridgeServer.QuoteStart(now, 1);
        Func<List<DateTime>, List<double>, DateTime, QuoteSeries> qs = (qt, qp, from) => { Bars b = new Bars(); for (int i = 0; i < qt.Count; i++) b.Add(qt[i], qp[i], qp[i], qp[i], qp[i], 5); return QuoteSeries.From(b, from); };
        QuoteSeries fb = qs(bt, bp, quoteFrom), fa = qs(at, ap, quoteFrom);
        DateTime[] T_ = tt.ToArray(); double[] P_ = tp.ToArray();
        BackfillSides full = ChartBridgeSides.ClassifyBackfill(T_, P_, T_.Length, fb.Time, fb.Price, fb.Seen, fb.Count, fa.Time, fa.Price, fa.Seen, fa.Count, null, null, -1, 0.25);
        int rn = 15000; DateTime[] rt = T_.Skip(T_.Length - rn).ToArray(); double[] rp = P_.Skip(T_.Length - rn).ToArray();
        foreach (bool cut in new[] { true, false })
        {
            DateTime from = cut ? quoteFrom : DateTime.MinValue;       // false: 0.3.5 before review S1 (rows by count uncut)
            QuoteSeries rb = qs(bt, bp, from), ra = qs(at, ap, from);
            BackfillSides rec = ChartBridgeSides.ClassifyBackfill(rt, rp, rn, rb.Time, rb.Price, rb.Seen, rb.Count, ra.Time, ra.Price, ra.Seen, ra.Count, null, null, -1, 0.25);
            int qf, w = ChartBridgeFill.FrontStart(rt, rp, rn, rec, true, rb.Time[0], ra.Time[0], out qf);
            int differ = 0, compared = 0;
            for (int i = w; i < rn; i++) { int k = T_.Length - rn + i; compared++; if (rec.Side[i] != full.Side[k] || rec.Method[i] != full.Method[k]) differ++; }
            if (cut) Check(differ == 0 && compared > 5000, "review S1: recent quote rows cut at the full load's quote start (" + quoteFrom.ToString("HH:mm:ss") + "): " + compared + " trades from the front (" + rt[w].ToString("HH:mm:ss") + "), " + differ + " with another side than a full load");
            else Check(differ > 0, "review S1: and the case is not idle: uncut, as before the fix, " + differ + " of " + compared + " differ");
        }
    }


    // nt8/check/join-cases.txt: cases with the C# answers written down, which test/live-first.test.js runs through the fake
    // bridge's port (test/fill-join.js). Checked here against the C# as it is now, so the port and the C# cannot drift.
    static void JoinCasesFile()
    {
        string path = System.IO.File.Exists("check/join-cases.txt") ? "check/join-cases.txt" : "nt8/check/join-cases.txt";
        if (!System.IO.File.Exists(path)) { Check(false, "join cases: " + path + " not found"); return; }
        DateTime b0 = new DateTime(2026, 9, 29, 10, 0, 0);
        int n = 0, bad = 0; string first = null;
        foreach (string line in System.IO.File.ReadAllLines(path))
        {
            if (line.Length == 0 || line[0] == '#') continue;
            string[] c = line.Split('\t');
            Func<string, List<string[]>> trades = x => x.Length == 0 ? new List<string[]>() : x.Split(' ').Select(y => y.Split(':')).ToList();
            List<string[]> B = trades(c[2]), R = trades(c[3]);
            Func<List<string[]>, DateTime[]> T = l => l.Select(y => b0.AddTicks(long.Parse(y[0], CultureInfo.InvariantCulture) * TimeSpan.TicksPerMillisecond)).ToArray();
            Func<List<string[]>, double[]> P = l => l.Select(y => double.Parse(y[1], CultureInfo.InvariantCulture)).ToArray();
            Func<List<string[]>, long[]> V = l => l.Select(y => long.Parse(y[2], CultureInfo.InvariantCulture)).ToArray();
            FillJoin j = ChartBridgeFill.Join(T(B), P(B), V(B), B.Count, T(R), P(R), V(R), R.Count, int.Parse(c[1]));
            string got = j.Index + " " + j.Send + " " + (j.Matched ? 1 : 0) + " " + (j.StartsAfter ? 1 : 0) + " " + (j.GapMs >= 0 ? 1 : 0) + " " + j.MismatchAt + " " + j.Checked;
            string want = c[4] + " " + c[5] + " " + c[6] + " " + c[7] + " " + c[8] + " " + c[9] + " " + c[10];
            n++;
            if (got != want) { bad++; if (first == null) first = c[0] + ": " + got + " against " + want; }
        }
        Check(bad == 0 && n > 100, "join cases file: the C# gives the answers written down in " + path + " (" + n + " cases; the fake bridge's port is checked on the same)" + (first != null ? "; first differs: " + first : ""));
    }

    // ------------------------------------------------------------ whole loads
    static ChartBridgeClient client;
    static Instrument inst;
    static readonly List<string> sent = new List<string>();
    static System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient> Clients()
    {
        return (System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
    }
    static List<string> Sent() { lock (sent) return sent.ToList(); }
    static bool WaitFor(Func<bool> ok, int ms = 5000) { for (int i = 0; i < ms / 5 && !ok(); i++) Thread.Sleep(5); return ok(); }
    static int MadeCount() { lock (BarsRequest.Made) return BarsRequest.Made.Count; }
    static List<BarsRequest> Made(int from) { lock (BarsRequest.Made) return BarsRequest.Made.Skip(from).ToList(); }
    static BarsRequest Find(int from, Func<BarsRequest, bool> f) { return Made(from).FirstOrDefault(f); }
    static bool IsMinute(BarsRequest r) { return r.BarsPeriod != null && r.BarsPeriod.BarsPeriodType == BarsPeriodType.Minute; }
    static bool IsKind(BarsRequest r, MarketDataType t) { return r.BarsPeriod != null && r.BarsPeriod.BarsPeriodType == BarsPeriodType.Tick && r.BarsPeriod.MarketDataType == t; }

    // Delivers the tape live (OnMarketData) from event e0 up to the first trade index `upto` (exclusive); returns the event reached.
    static int Deliver(Tape k, int e0, int upto)
    {
        int e = e0;
        for (; e < k.Events.Count; e++)
        {
            int[] ev = k.Events[e];
            if (ev[0] == 0 && ev[1] >= upto) break;
            MarketDataType type = ev[0] == 0 ? MarketDataType.Last : ev[0] == 1 ? MarketDataType.Bid : MarketDataType.Ask;
            DateTime t = ev[0] == 0 ? k.T[ev[1]] : ev[0] == 1 ? k.BT[ev[1]] : k.AT[ev[1]];
            double p = ev[0] == 0 ? k.P[ev[1]] : ev[0] == 1 ? k.BP[ev[1]] : k.AP[ev[1]];
            long v = ev[0] == 0 ? k.V[ev[1]] : 5;
            Priv("OnMarketData", null, new MarketDataEventArgs { Instrument = inst, MarketDataType = type, Price = p, Volume = v, Time = t });
        }
        return e;
    }
    static int QuotesBefore(List<DateTime> qt, DateTime t) { int i = 0; while (i < qt.Count && qt[i] <= t) i++; return i; }
    static string Sub(string json) { int i = json.IndexOf("\"sub\":"); if (i < 0) return null; int j = i + 6; while (j < json.Length && char.IsDigit(json[j])) j++; return json.Substring(i + 6, j - i - 6); }

    // The page's view: every trade it got, in time order, with its side: older chunks (newest first, each oldest first),
    // the recent window (ticks), the held trades released after ready, and the live trades.
    class PageTrade { public double T; public double P; public long V; public int S, Sm; public string From; }
    static List<double[]> Arr(string json, string key)
    {
        List<double[]> o = new List<double[]>();
        int i = json.IndexOf("\"" + key + "\":["); if (i < 0) return o;
        i += key.Length + 4;
        while (i < json.Length && json[i] == '[')
        {
            int j = json.IndexOf(']', i);
            o.Add(json.Substring(i + 1, j - i - 1).Split(',').Select(x => double.Parse(x, CultureInfo.InvariantCulture)).ToArray());
            i = j + 1; if (i < json.Length && json[i] == ',') i++;
        }
        return o;
    }
    static double Field(string json, string key) { int i = json.IndexOf("\"" + key + "\":"); int j = i + key.Length + 3, e = j; while (e < json.Length && "-0123456789.".IndexOf(json[e]) >= 0) e++; return double.Parse(json.Substring(j, e - j), CultureInfo.InvariantCulture); }

    public static void Load(Action<bool, string> check, Instrument i)
    {
        Check = check; inst = i;
        // A page that takes everything at once (its send loop drains the outbox), so the 5 s rule never closes it while the
        // cases run; what it is sent is read from Tap, in order.
        client = new ChartBridgeClient(new PageSocket(), 88);
        client.Tap = s => { lock (sent) sent.Add(s); };
        Clients()[88] = client;
        System.Threading.Tasks.Task.Run(() => client.SendLoop());
        Func<BarsRequest, bool> was = BarsRequest.AutoAnswer;
        BarsRequest.AutoAnswer = null;
        int recentWas = ChartBridgeConfig.RecentTicks, chunkWas = ChartBridgeServer.OlderChunk;
        try
        {
            WholeLoad();
            Stale();
            Fallbacks();
            Idle();
            MinuteAndOld();
            SundayOpen();
            AnswersDiffer();
            InFlight();
            TradesOnly();
            Disconnect();
            TickHoursCapCases();
            Pacing();
        }
        finally
        {
            ChartBridgeConfig.RecentTicks = recentWas; ChartBridgeServer.OlderChunk = chunkWas;
            BarsRequest.AutoAnswer = was;
            ChartBridgeClient gone; Clients().TryRemove(88, out gone);
            client.Close();
        }
    }

    // A tick chart loads live first in a busy market: trades and quotes keep arriving between every step.
    static void WholeLoad()
    {
        ChartBridgeConfig.RecentTicks = 5000; ChartBridgeServer.OlderChunk = 3000;
        DateTime t0 = new DateTime(DateTime.Now.AddMinutes(-25).Ticks / TimeSpan.TicksPerSecond * TimeSpan.TicksPerSecond);
        Tape k = MakeTape(t0, 40000, 6, 77, 0.3, -1);
        int e = Deliver(k, 0, 30000);                     // NinjaTrader has been running: 30,000 trades before the subscribe
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        DateTime before = DateTime.Now;
        // The page asks for two chunks the moment it sees ready: here at the very moment ready is queued, before ChartBridge
        // has even asked for the older history (the tightest race there can be; the requests must not be lost).
        Action<string> tap = client.Tap;
        client.Tap = x =>
        {
            tap(x);
            if (x.StartsWith("{\"type\":\"ready\"") && x.Contains("\"sub\":41"))
            {
                Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":41,\"upTo\":2}");
                Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":41,\"upTo\":2}");   // asked again: still two
            }
        };
        Priv("SubscribeLiveFirst", client, "MNQ", 5, 1, "41");
        e = Deliver(k, e, 30100);                         // held
        BarsRequest minutes = Find(m0, IsMinute);
        // Minute history up to the forming minute (made up from the tape).
        Bars mb = new Bars();
        DateTime m = new DateTime(k.T[0].Ticks / TimeSpan.TicksPerMinute * TimeSpan.TicksPerMinute);
        while (m <= k.T[30100]) { mb.Add(m.AddMinutes(1), 20000, 20001, 19999, 20000, 1); m = m.AddMinutes(1); }
        minutes.Answer(mb, ErrorCode.NoError);
        BarsRequest rt = Find(m0, r => IsKind(r, MarketDataType.Last)), rb = Find(m0, r => IsKind(r, MarketDataType.Bid)), ra = Find(m0, r => IsKind(r, MarketDataType.Ask));
        Check(rt != null && rt.BarsBack == 5000 && rb != null && ra != null && rb.BarsBack == ChartBridgeServer.RecentQuoteRows && ra.BarsBack == ChartBridgeServer.RecentQuoteRows,
            "live first: the recent window is asked by count (5,000 trades, " + ChartBridgeServer.RecentQuoteRows + " rows of each quote side), not by date (whole days)");
        e = Deliver(k, e, 30150);
        int e1 = 30150;                                   // NinjaTrader answers here: the last 5,000 trades, the last rows of each side
        DateTime te = k.T[e1 - 1];
        int nb = QuotesBefore(k.BT, te), na = QuotesBefore(k.AT, te);
        rb.Answer(QuoteBars(k.BT, k.BP, nb - rb.BarsBack, nb), ErrorCode.NoError);
        e = Deliver(k, e, 30160);
        rt.Answer(TradeBars(k, e1 - 5000, e1), ErrorCode.NoError);
        e = Deliver(k, e, 30180);
        ra.Answer(QuoteBars(k.AT, k.AP, na - ra.BarsBack, na), ErrorCode.NoError);
        Check(WaitFor(() => Sent().Any(x => x.StartsWith("{\"type\":\"ready\""))), "live first: ready");
        e = Deliver(k, e, 30200);
        List<string> l = Sent();
        string ready = l.First(x => x.StartsWith("{\"type\":\"ready\""));
        Check(ready.Contains("\"sub\":41") && ready.Contains("\"older\":true"), "live first: ready says the older history follows (" + ready + ")");
        List<double[]> recent = l.Where(x => x.StartsWith("{\"type\":\"ticks\"")).SelectMany(x => Arr(x, "ticks")).ToList();
        Check(recent.Count > 0 && recent.Count <= 5000, "live first: the recent window goes out from its front (" + recent.Count + " of 5,000 trades)");
        // After ready: the older history asked for exactly as a full load (trades ending past now, quotes of the window).
        BarsRequest bt = Made(m0).Where(r => IsKind(r, MarketDataType.Last)).Skip(1).FirstOrDefault();
        BarsRequest bb = Made(m0).Where(r => IsKind(r, MarketDataType.Bid)).Skip(1).FirstOrDefault(), ba = Made(m0).Where(r => IsKind(r, MarketDataType.Ask)).Skip(1).FirstOrDefault();
        Check(bt != null && bt.BarsBack < 0 && bt.To >= before.AddMinutes(ChartBridgeServer.TickToMarginMinutes).AddSeconds(-5) && bt.From <= before.AddHours(-1).AddSeconds(5) && bb != null && ba != null && bb.BarsBack < 0,
            "live first: after ready the whole window is asked as a full load asks it (from tickHours back, ending 60 minutes past now; the quotes too)");
        client.Tap = tap;
        // The page asked for two chunks at ready, before the older history is in; live trades keep flowing straight out.
        int liveBefore = Sent().Count;
        e = Deliver(k, e, 30400);
        Check(Sent().Count > liveBefore && Sent().Skip(liveBefore).All(x => x.StartsWith("{\"type\":\"tick\"")), "live first: live trades go straight out while the older history loads");
        int e2 = 30400;
        DateTime te2 = k.T[e2 - 1];
        int nb2 = QuotesBefore(k.BT, te2), na2 = QuotesBefore(k.AT, te2);
        ba.Answer(QuoteBars(k.AT, k.AP, 0, na2), ErrorCode.NoError);
        bt.Answer(TradeBars(k, 0, e2), ErrorCode.NoError);
        e = Deliver(k, e, 30420);
        bb.Answer(QuoteBars(k.BT, k.BP, 0, nb2), ErrorCode.NoError);
        // Pull the rest as live.js does: upTo two more than the page has, with live trades between. Never more than two on
        // their way (review N1): the chunks sent never exceed the page's latest upTo.
        int got = 0, nextTrade = 30420, upTo = 2, overAsked = 0;
        Func<int> olderN = () => Sent().Count(x => x.StartsWith("{\"type\":\"olderTicks\""));
        for (int guard = 0; guard < 500; guard++)
        {
            int g = got;
            if (!WaitFor(() => olderN() > g, 3000)) break;
            Thread.Sleep(2);
            got = olderN();
            if (got > upTo) overAsked++;
            if (Sent().Any(x => x.StartsWith("{\"type\":\"olderTicks\"") && x.Contains("\"done\":true"))) break;
            nextTrade = Math.Min(k.T.Count, nextTrade + 30);
            e = Deliver(k, e, nextTrade);             // the market keeps trading between chunks
            upTo = got + 2;
            Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":41,\"upTo\":" + upTo + "}");
            if (guard % 3 == 0) Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":41,\"upTo\":" + upTo + "}");   // a re-ask adds nothing
        }
        e = Deliver(k, e, k.T.Count);                     // and the rest of the tape, live
        Thread.Sleep(50);
        l = Sent();
        List<string> older = l.Where(x => x.StartsWith("{\"type\":\"olderTicks\"")).ToList();
        Check(older.Count > 3 && older[0].Contains("\"left\":") && older.Last().Contains("\"done\":true") && older.Take(older.Count - 1).All(x => x.Contains("\"done\":false")) && older.All(x => x.Contains("\"sub\":41")),
            "live first: the older history in " + older.Count + " chunks, the last says done");
        Check(overAsked == 0, "live first: never more chunks sent than the page asked for with upTo, re-asks included (review N1: at most two on their way)");
        // Newest first: each chunk ends where the one before it began.
        bool newestFirst = true;
        for (int c = 1; c < older.Count; c++) { List<double[]> a = Arr(older[c - 1], "ticks"), b2 = Arr(older[c], "ticks"); if (a.Count > 0 && b2.Count > 0 && !(b2[b2.Count - 1][0] <= a[0][0])) newestFirst = false; }
        Check(newestFirst, "live first: chunks newest first, each oldest first inside");
        // Rebuild the page's trades: older (reversed chunk order), recent window, then every tick after ready in order.
        List<double[]> page = new List<double[]>();
        for (int c = older.Count - 1; c >= 0; c--) page.AddRange(Arr(older[c], "ticks"));
        int olderCount = page.Count;
        page.AddRange(recent);
        int readyAt = l.FindIndex(x => x.StartsWith("{\"type\":\"ready\""));
        foreach (string x in l.Skip(readyAt + 1).Where(x => x.StartsWith("{\"type\":\"tick\"")))
            page.Add(new[] { Field(x, "t"), Field(x, "p"), Field(x, "v"), Field(x, "s"), Field(x, "sm") });
        // The tape as the page should have it: every trade from the start of the window on, with the sides a full load gives.
        BackfillSides full = Full(k, k.T.Count, k.BT.Count, k.AT.Count);
        int wrongTrade = -1, wrongSide = -1;
        for (int j = 0; j < Math.Min(page.Count, k.T.Count); j++)
        {
            double t = ChartBridgeTime.EtSeconds(ChartBridgeTime.ToUtc(k.T[j]));
            if (wrongTrade < 0 && (Math.Abs(page[j][0] - Math.Round(t, 3)) > 0.0006 || Math.Abs(page[j][1] - k.P[j]) > 1e-9 || (long)page[j][2] != k.V[j])) wrongTrade = j;
            if (wrongSide < 0 && ((int)page[j][3] != full.Side[j] || (int)page[j][4] != full.Method[j])) wrongSide = j;
        }
        Check(page.Count == k.T.Count && wrongTrade < 0,
            "live first: every trade of the tape reaches the page exactly once and in order: older history " + olderCount + ", recent window " + recent.Count + ", live " + (page.Count - olderCount - recent.Count) + " = " + page.Count + " of " + k.T.Count + (wrongTrade >= 0 ? " (first wrong at " + wrongTrade + ")" : ""));
        Check(wrongSide < 0, "live first: every trade's side and method equal a full load of the same tape (older, recent, released and live alike)" + (wrongSide >= 0 ? " (first differs at " + wrongSide + ")" : ""));
        string d = (string)Priv("DiagJson");
        int fi = d.IndexOf("\"fills\":[");
        string fills = fi < 0 ? "" : d.Substring(fi, Math.Min(1400, d.Length - fi));
        Check(fills.Contains("\"sub\":41") && fills.Contains("\"state\":\"done\"") && fills.Contains("\"timeToLiveMs\":") && fills.Contains("\"recentWindowMin\":") && fills.Contains("\"backgroundMs\":")
              && fills.Contains("\"chunks\":" + older.Count) && fills.Contains("\"matched\":true") && fills.Contains("\"sidesDiffer\":0") && fills.Contains("\"recentSent\":" + recent.Count) && fills.Contains("\"olderTicks\":" + olderCount),
            "diag: /diag fills has the load: time to live, the recent window, background time, chunks, the join matched with no side differing (" + fills + ")");
        Check(d.Contains("\"liveFirst\":true") && d.Contains("\"tickToAheadMin\":null"), "diag: the seam of a live-first load says so");
        Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":41,\"upTo\":99}");
        Thread.Sleep(30);
        Check(Sent().Count(x => x.StartsWith("{\"type\":\"olderTicks\"")) == older.Count, "live first: a request after done sends nothing");
    }

    // A newer subscribe stops the older history; a request with an old id is ignored.
    static void Stale()
    {
        ChartBridgeConfig.RecentTicks = 200; ChartBridgeServer.OlderChunk = 100;
        DateTime t0 = new DateTime(DateTime.Now.AddMinutes(-20).Ticks / TimeSpan.TicksPerSecond * TimeSpan.TicksPerSecond);
        Tape k = MakeTape(t0, 3000, 0, 91, -1, -1, 300);
        int e = Deliver(k, 0, 2500);
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        Priv("SubscribeLiveFirst", client, "MNQ", 5, 1, "50");
        Find(m0, IsMinute).Answer(new Bars(), ErrorCode.NoError);
        Find(m0, r => IsKind(r, MarketDataType.Last)).Answer(TradeBars(k, 2300, 2500), ErrorCode.NoError);
        Find(m0, r => IsKind(r, MarketDataType.Bid)).Answer(QuoteBars(k.BT, k.BP, 0, k.BT.Count), ErrorCode.NoError);
        Find(m0, r => IsKind(r, MarketDataType.Ask)).Answer(QuoteBars(k.AT, k.AP, 0, k.AT.Count), ErrorCode.NoError);
        Check(WaitFor(() => Sent().Any(x => x.StartsWith("{\"type\":\"ready\"") && x.Contains("\"older\":true"))), "stale: first load live");
        Made(m0).Where(r => IsKind(r, MarketDataType.Last)).Skip(1).First().Answer(TradeBars(k, 0, 2500), ErrorCode.NoError);
        Made(m0).Where(r => IsKind(r, MarketDataType.Bid)).Skip(1).First().Answer(QuoteBars(k.BT, k.BP, 0, k.BT.Count), ErrorCode.NoError);
        Made(m0).Where(r => IsKind(r, MarketDataType.Ask)).Skip(1).First().Answer(QuoteBars(k.AT, k.AP, 0, k.AT.Count), ErrorCode.NoError);
        Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":50}");
        Check(WaitFor(() => Sent().Count(x => x.StartsWith("{\"type\":\"olderTicks\"")) == 1), "stale: one chunk asked, one sent");
        int m1 = MadeCount();
        Priv("SubscribeLiveFirst", client, "MNQ", 5, 1, "51");   // the page switched views
        int n0 = Sent().Count(x => x.StartsWith("{\"type\":\"olderTicks\""));
        Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":50}");
        Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":51}");
        Thread.Sleep(50);
        Check(Sent().Count(x => x.StartsWith("{\"type\":\"olderTicks\"")) == n0, "stale: after a newer subscribe nothing more of the older load's history goes out, whatever id asks");
        Check(Find(m1, IsMinute) != null, "stale: the newer load runs");
    }

    // The recent window fails, comes back empty, or the older history fails: never worse than a full load.
    static void Fallbacks()
    {
        ChartBridgeConfig.RecentTicks = 200; ChartBridgeServer.OlderChunk = 100;
        DateTime t0 = new DateTime(DateTime.Now.AddMinutes(-20).Ticks / TimeSpan.TicksPerSecond * TimeSpan.TicksPerSecond);
        Tape k = MakeTape(t0, 3000, 0, 92, -1, -1, 300);
        foreach (bool refuse in new[] { true, false })
        {
            int e = Deliver(k, 0, 2400);
            lock (sent) sent.Clear();
            int m0 = MadeCount();
            Priv("SubscribeLiveFirst", client, "MNQ", 5, 1, refuse ? "60" : "61");
            e = Deliver(k, e, 2450);
            Find(m0, IsMinute).Answer(new Bars(), ErrorCode.NoError);
            BarsRequest rt = Find(m0, r => IsKind(r, MarketDataType.Last));
            if (refuse) rt.Answer(new Bars(), ErrorCode.Panic); else rt.Answer(new Bars(), ErrorCode.NoError);
            Find(m0, r => IsKind(r, MarketDataType.Bid)).Answer(QuoteBars(k.BT, k.BP, 0, 10), ErrorCode.NoError);
            Find(m0, r => IsKind(r, MarketDataType.Ask)).Answer(QuoteBars(k.AT, k.AP, 0, 10), ErrorCode.NoError);
            Check(WaitFor(() => Made(m0).Count(r => IsKind(r, MarketDataType.Last)) == 2), "fallback: the recent window " + (refuse ? "refused" : "empty") + ": a full load is asked, as before 0.3.5");
            BarsRequest ft = Made(m0).Where(r => IsKind(r, MarketDataType.Last)).Skip(1).First();
            Check(ft.BarsBack < 0 && Sent().All(x => !x.StartsWith("{\"type\":\"ready\"")), "fallback: by date, and still no ready (the live trades stay held)");
            e = Deliver(k, e, 2500);
            ft.Answer(TradeBars(k, 0, 2480), ErrorCode.NoError);
            Made(m0).Where(r => IsKind(r, MarketDataType.Bid)).Skip(1).First().Answer(QuoteBars(k.BT, k.BP, 0, k.BT.Count), ErrorCode.NoError);
            Made(m0).Where(r => IsKind(r, MarketDataType.Ask)).Skip(1).First().Answer(QuoteBars(k.AT, k.AP, 0, k.AT.Count), ErrorCode.NoError);
            Check(WaitFor(() => Sent().Any(x => x.StartsWith("{\"type\":\"ready\""))), "fallback: ready");
            Thread.Sleep(30);
            List<string> l = Sent();
            string ready = l.First(x => x.StartsWith("{\"type\":\"ready\""));
            int backfill = l.Where(x => x.StartsWith("{\"type\":\"ticks\"")).Sum(x => Arr(x, "ticks").Count);
            int released = l.Skip(l.IndexOf(ready) + 1).Count(x => x.StartsWith("{\"type\":\"tick\""));
            Check(!ready.Contains("older") && backfill == 2480 && released == 20, "fallback: a plain ready, the whole backfill and the held trades after it: " + backfill + " + " + released);
            Check(((string)Priv("DiagJson")).Contains("\"fellBack\":\"" + (refuse ? "the recent trades did not load" : "no recent trades came back")), "fallback: /diag says why");
        }
        // The older history fails: the page is told in the last (only) chunk.
        {
            int e = Deliver(k, 0, 2600);
            lock (sent) sent.Clear();
            int m0 = MadeCount();
            Priv("SubscribeLiveFirst", client, "MNQ", 5, 1, "62");
            Find(m0, IsMinute).Answer(new Bars(), ErrorCode.NoError);
            Find(m0, r => IsKind(r, MarketDataType.Last)).Answer(TradeBars(k, 2400, 2600), ErrorCode.NoError);
            Find(m0, r => IsKind(r, MarketDataType.Bid)).Answer(QuoteBars(k.BT, k.BP, 0, k.BT.Count), ErrorCode.NoError);
            Find(m0, r => IsKind(r, MarketDataType.Ask)).Answer(QuoteBars(k.AT, k.AP, 0, k.AT.Count), ErrorCode.NoError);
            Check(WaitFor(() => Sent().Any(x => x.StartsWith("{\"type\":\"ready\""))), "older fails: live first");
            BarsRequest bt = Made(m0).Where(r => IsKind(r, MarketDataType.Last)).Skip(1).First();
            bt.Answer(new Bars(), ErrorCode.Panic);
            BarsRequest again = Made(m0).Where(r => IsKind(r, MarketDataType.Last)).Skip(2).FirstOrDefault();
            Check(again != null && again.To <= DateTime.Now.AddSeconds(1), "older fails: asked once more ending now, like a full load");
            again.Answer(new Bars(), ErrorCode.Panic);
            Made(m0).Where(r => IsKind(r, MarketDataType.Bid)).Skip(1).First().Answer(new Bars(), ErrorCode.NoError);
            Made(m0).Where(r => IsKind(r, MarketDataType.Ask)).Skip(1).First().Answer(new Bars(), ErrorCode.NoError);
            Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":62}");
            Check(WaitFor(() => Sent().Any(x => x.StartsWith("{\"type\":\"olderTicks\""))), "older fails: the page's request is answered");
            string last = Sent().First(x => x.StartsWith("{\"type\":\"olderTicks\""));
            Check(last.Contains("\"ticks\":[]") && last.Contains("\"done\":true") && last.Contains("\"error\":\"the older history did not load"), "older fails: one empty chunk, done, with the reason (" + last + ")");
        }
    }

    // A page that stops asking (closed, stuck) does not keep the older history in NinjaTrader's memory.
    static void Idle()
    {
        ChartBridgeConfig.RecentTicks = 200; ChartBridgeServer.OlderChunk = 100;
        int idleWas = ChartBridgeServer.FillIdleMs;
        ChartBridgeServer.FillIdleMs = 300;
        try
        {
            DateTime t0 = new DateTime(DateTime.Now.AddMinutes(-20).Ticks / TimeSpan.TicksPerSecond * TimeSpan.TicksPerSecond);
            Tape k = MakeTape(t0, 3000, 0, 93, -1, -1, 300);
            Deliver(k, 0, 2600);
            lock (sent) sent.Clear();
            int m0 = MadeCount();
            Priv("SubscribeLiveFirst", client, "MNQ", 5, 1, "65");
            Find(m0, IsMinute).Answer(new Bars(), ErrorCode.NoError);
            Find(m0, r => IsKind(r, MarketDataType.Last)).Answer(TradeBars(k, 2400, 2600), ErrorCode.NoError);
            Find(m0, r => IsKind(r, MarketDataType.Bid)).Answer(QuoteBars(k.BT, k.BP, 0, k.BT.Count), ErrorCode.NoError);
            Find(m0, r => IsKind(r, MarketDataType.Ask)).Answer(QuoteBars(k.AT, k.AP, 0, k.AT.Count), ErrorCode.NoError);
            Check(WaitFor(() => Made(m0).Count(r => IsKind(r, MarketDataType.Last)) == 2), "idle: live, the older history asked");
            Made(m0).Where(r => IsKind(r, MarketDataType.Last)).Skip(1).First().Answer(TradeBars(k, 0, 2600), ErrorCode.NoError);
            Made(m0).Where(r => IsKind(r, MarketDataType.Bid)).Skip(1).First().Answer(QuoteBars(k.BT, k.BP, 0, k.BT.Count), ErrorCode.NoError);
            Made(m0).Where(r => IsKind(r, MarketDataType.Ask)).Skip(1).First().Answer(QuoteBars(k.AT, k.AP, 0, k.AT.Count), ErrorCode.NoError);
            Check(WaitFor(() => ((string)Priv("DiagJson")).Contains("\"sub\":65,\"tickHours\":1,\"atUtcMs\"") && ((string)Priv("DiagJson")).Contains("dropped: the page stopped asking"), 3000),
                "idle: a page that asks for nothing for FillIdleMs has its older history dropped (/diag says so)");
            Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":65,\"upTo\":2}");
            Thread.Sleep(50);
            List<string> ans = Sent().Where(x => x.StartsWith("{\"type\":\"olderTicks\"")).ToList();
            Check(ans.Count == 1 && ans[0].Contains("\"ticks\":[]") && ans[0].Contains("\"done\":true") && ans[0].Contains("\"dropped\":true") && ans[0].Contains("stopped asking"),
                "idle: a request after that is answered once: empty, done, dropped, and why (review N2: the page stops waiting and says so) (" + (ans.Count > 0 ? ans[0] : "none") + ")");
            Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":65,\"upTo\":2}");
            Thread.Sleep(30);
            Check(Sent().Count(x => x.StartsWith("{\"type\":\"olderTicks\"")) == 1, "idle: and only once");
        }
        finally { ChartBridgeServer.FillIdleMs = idleWas; }
    }

    // A minute chart asking live first loads as before (no tick window); a page that does not ask gets no count request.
    static void MinuteAndOld()
    {
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        Priv("SubscribeLiveFirst", client, "MNQ", 5, 0, "70");
        Find(m0, IsMinute).Answer(new Bars(), ErrorCode.NoError);
        Check(WaitFor(() => Sent().Any(x => x.StartsWith("{\"type\":\"ready\""))) && !Sent().First(x => x.StartsWith("{\"type\":\"ready\"")).Contains("older"), "minute chart: live first changes nothing (no tick history, a plain ready)");
        lock (sent) sent.Clear();
        m0 = MadeCount();
        Priv("OnClientMessage", client, "{\"type\":\"subscribe\",\"root\":\"MNQ\",\"days\":5,\"tickHours\":1}");
        Find(m0, IsMinute).Answer(new Bars(), ErrorCode.NoError);
        BarsRequest t = Find(m0, r => IsKind(r, MarketDataType.Last));
        Check(t != null && t.BarsBack < 0, "old page (no liveFirst): the tick backfill is asked by date, a full load as 0.3.4");
        t.Answer(new Bars(), ErrorCode.NoError);
        Made(m0).Where(r => IsKind(r, MarketDataType.Last)).Skip(1).First().Answer(new Bars(), ErrorCode.NoError);
        Find(m0, r => IsKind(r, MarketDataType.Bid)).Answer(new Bars(), ErrorCode.NoError);
        Find(m0, r => IsKind(r, MarketDataType.Ask)).Answer(new Bars(), ErrorCode.NoError);
        Check(WaitFor(() => Sent().Any(x => x.StartsWith("{\"type\":\"ready\""))) && !Sent().First(x => x.StartsWith("{\"type\":\"ready\"")).Contains("older"), "old page: a plain ready");
        Check(((string)Priv("HelloJson")).Contains("\"features\":[\"liveFirst\"]"), "hello names the feature, so a page knows it may ask");
        // The subscribe flag is read strictly: liveFirst true or 1.
        lock (sent) sent.Clear();
        m0 = MadeCount();
        Priv("OnClientMessage", client, "{\"type\":\"subscribe\",\"root\":\"MNQ\",\"days\":5,\"tickHours\":1,\"sub\":71,\"liveFirst\":true}");
        Find(m0, IsMinute).Answer(new Bars(), ErrorCode.NoError);
        BarsRequest lf = Find(m0, r => IsKind(r, MarketDataType.Last));
        Check(lf != null && lf.BarsBack == ChartBridgeConfig.RecentTicks, "subscribe with liveFirst true asks the recent window by count");
        lf.Answer(new Bars(), ErrorCode.NoError);
        Find(m0, r => IsKind(r, MarketDataType.Bid)).Answer(new Bars(), ErrorCode.NoError);
        Find(m0, r => IsKind(r, MarketDataType.Ask)).Answer(new Bars(), ErrorCode.NoError);
        for (int round = 0; round < 6 && !Sent().Any(x => x.StartsWith("{\"type\":\"ready\"")); round++)
        {
            Thread.Sleep(20);
            foreach (BarsRequest r in Made(m0).Where(r => !r.Answered)) r.Answer(new Bars(), ErrorCode.NoError);
        }
        Check(Sent().Any(x => x.StartsWith("{\"type\":\"ready\"") && !x.Contains("older")), "liveFirst with an empty recent answer: a full load, a plain ready");
    }


    // ------------------------------------------------------------ whole loads, the older history answered in whole trading days
    // NinjaTrader answers a request by date with whole trading days (BarsRequest help): the trading day of the date the request
    // starts on, from 18:00 ET the evening before; a Saturday or Sunday date gives Monday's, from Sunday 18:00 ET. The stub
    // answers the older history that way, on the tape's own clock (a tape set on last weekend is not at the real now).
    static DateTime TradingDayStart(DateTime nt)
    {
        DateTime d = TimeZoneInfo.ConvertTimeFromUtc(ChartBridgeTime.ToUtc(nt), ChartBridgeTime.Eastern).Date;
        if (d.DayOfWeek == DayOfWeek.Saturday) d = d.AddDays(2); else if (d.DayOfWeek == DayOfWeek.Sunday) d = d.AddDays(1);
        DateTime eve = d.AddDays(-1);
        return SidesHarnessEt(eve.Year, eve.Month, eve.Day, 18, 0, 0);
    }
    static Bars WholeDays(Tape k, int delivered, int tickHours, Func<int, bool> skip)
    {
        DateTime from = TradingDayStart(k.T[delivered - 1].AddHours(-tickHours));
        Bars b = new Bars();
        for (int i = 0; i < delivered; i++) if (k.T[i] >= from && (skip == null || !skip(i))) b.Add(k.T[i], k.P[i], k.P[i], k.P[i], k.P[i], k.V[i]);
        return b;
    }
    static Tape Trades(List<DateTime> t, List<double> p, List<long> v)
    {
        Tape k = new Tape();
        for (int i = 0; i < t.Count; i++) { k.T.Add(t[i]); k.P.Add(p[i]); k.V.Add(v[i]); k.Events.Add(new[] { 0, i }); }
        return k;
    }
    class Pulled { public List<string> Older = new List<string>(); public List<double[]> Page = new List<double[]>(); public int OlderTrades, Recent; public BarsRequest Dated; }
    // A live-first load of tape k: `before` trades delivered live, then the subscribe; the recent window is the last `recent`
    // trades by count (no quote rows: they are days old, before the quote start); the older history is answered by bAnswer
    // (given the trades delivered by then); the page pulls it as live.js does. What the page got, in its order.
    static Pulled LoadTape(Tape k, int before, int recent, int tickHours, string sub, Func<int, Bars> bAnswer)
    {
        ChartBridgeConfig.RecentTicks = recent; ChartBridgeServer.OlderChunk = 50;
        int e = Deliver(k, 0, before);
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        Priv("SubscribeLiveFirst", client, "MNQ", 5, tickHours, sub);
        int e1 = before + 10;
        e = Deliver(k, e, e1);                            // held while NinjaTrader answers
        Find(m0, IsMinute).Answer(new Bars(), ErrorCode.NoError);
        Find(m0, r => IsKind(r, MarketDataType.Last)).Answer(TradeBars(k, e1 - recent, e1), ErrorCode.NoError);
        Find(m0, r => IsKind(r, MarketDataType.Bid)).Answer(new Bars(), ErrorCode.NoError);
        Find(m0, r => IsKind(r, MarketDataType.Ask)).Answer(new Bars(), ErrorCode.NoError);
        Pulled res = new Pulled();
        if (!WaitFor(() => Sent().Any(x => x.StartsWith("{\"type\":\"ready\"")))) return res;
        e = Deliver(k, e, e1 + 10);
        Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":" + sub + ",\"upTo\":2}");
        WaitFor(() => Made(m0).Count(r => IsKind(r, MarketDataType.Last)) == 2 && Made(m0).Count(r => IsKind(r, MarketDataType.Ask)) == 2);   // its quote requests too
        res.Dated = Made(m0).Where(r => IsKind(r, MarketDataType.Last)).Skip(1).First();
        res.Dated.Answer(bAnswer(e1 + 10), ErrorCode.NoError);
        // no quote rows (days old): an empty answer to a request ending in the future is asked again ending now; answer that too
        for (int round = 0; round < 3; round++)
        {
            foreach (BarsRequest q in Made(m0).Where(r => !r.Answered && (IsKind(r, MarketDataType.Bid) || IsKind(r, MarketDataType.Ask)))) q.Answer(new Bars(), ErrorCode.NoError);
            Thread.Sleep(20);
        }
        Func<int> olderN = () => Sent().Count(x => x.StartsWith("{\"type\":\"olderTicks\""));
        int got = 0, next = e1 + 10;
        for (int guard = 0; guard < 400; guard++)
        {
            int g = got;
            if (!WaitFor(() => olderN() > g, 3000)) break;
            got = olderN();
            if (Sent().Any(x => x.StartsWith("{\"type\":\"olderTicks\"") && x.Contains("\"done\":true"))) break;
            next = Math.Min(k.T.Count, next + 5);
            e = Deliver(k, e, next);
            Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":" + sub + ",\"upTo\":" + (got + 2) + "}");
        }
        e = Deliver(k, e, k.T.Count);
        Thread.Sleep(50);
        List<string> l = Sent();
        res.Older = l.Where(x => x.StartsWith("{\"type\":\"olderTicks\"")).ToList();
        for (int c = res.Older.Count - 1; c >= 0; c--) res.Page.AddRange(Arr(res.Older[c], "ticks"));
        res.OlderTrades = res.Page.Count;
        List<double[]> recentGot = l.Where(x => x.StartsWith("{\"type\":\"ticks\"")).SelectMany(x => Arr(x, "ticks")).ToList();
        res.Recent = recentGot.Count;
        res.Page.AddRange(recentGot);
        int readyAt = l.FindIndex(x => x.StartsWith("{\"type\":\"ready\""));
        foreach (string x in l.Skip(readyAt + 1).Where(x => x.StartsWith("{\"type\":\"tick\"")))
            res.Page.Add(new[] { Field(x, "t"), Field(x, "p"), Field(x, "v") });
        return res;
    }
    // The page's trades are the tape from the page's first trade on: each once, in order, none missing. `from`: that trade.
    static bool IsTapeTail(Tape k, List<double[]> page, out int from, out int wrong)
    {
        from = k.T.Count - page.Count; wrong = -1;
        if (from < 0) { wrong = 0; return false; }
        for (int j = 0; j < page.Count; j++)
        {
            int i = from + j;
            double t = Math.Round(ChartBridgeTime.EtSeconds(ChartBridgeTime.ToUtc(k.T[i])), 3);
            if (Math.Abs(page[j][0] - t) > 0.0006 || Math.Abs(page[j][1] - k.P[i]) > 1e-9 || (long)page[j][2] != k.V[i]) { wrong = j; return false; }
        }
        return true;
    }

    // Review B1 through the whole load: the Sunday 18:00 ET open. The last trades by count reach back into Friday (whose
    // first two share a millisecond, so the front is the second); the request by date gives only Sunday's session. 0.3.5 as
    // first built sent Sunday's opening print again in front of Friday's trades.
    static void SundayOpen()
    {
        List<DateTime> t = new List<DateTime>(); List<double> p = new List<double>(); List<long> v = new List<long>();
        DateTime fri = SidesHarnessEt(2026, 9, 25, 16, 50, 0), sun = SidesHarnessEt(2026, 9, 27, 18, 0, 0);
        for (int i = 0; i < 600; i++) { t.Add(i == 221 ? t[220] : fri.AddSeconds(i)); p.Add(i % 2 == 0 ? 100 : 100.25); v.Add(1 + i % 3); }
        for (int i = 0; i < 700; i++) { t.Add(i == 1 ? t[600] : sun.AddMilliseconds(500 * i)); p.Add(i % 2 == 0 ? 101 : 101.25); v.Add(i == 0 ? 40 : 1 + i % 4); }
        Tape k = Trades(t, p, v);
        // subscribe after 300 of Sunday's trades; the recent window is the last 690 by count: from Friday's trade 220 on
        Pulled r = LoadTape(k, 900, 690, 26, "81", n => WholeDays(k, n, 26, null));
        int from, wrong;
        bool tail = IsTapeTail(k, r.Page, out from, out wrong);
        Check(r.Dated != null && r.Dated.BarsBack < 0 && WholeDays(k, 920, 26, null).Count > 0 && WholeDays(k, 920, 26, null).GetTime(0) == sun,
            "Sunday open: the older history is asked by date, and the stub answers whole trading days (Sunday's session only)");
        Check(r.Older.Count == 1 && r.Older[0].Contains("\"ticks\":[]") && r.Older[0].Contains("\"done\":true") && r.Older[0].Contains("\"startsAfter\":true") && !r.Older[0].Contains("joinMismatch"),
            "Sunday open: the page's request is answered with nothing older, done, startsAfter (" + (r.Older.Count > 0 ? r.Older[0] : "none") + ")");
        Check(tail && from == 221 && r.OlderTrades == 0, "Sunday open (review J1 through Subscribe): the page has every trade from Friday's trade 221 (its front) on exactly once, in order; Sunday's opening print once (" + r.Page.Count + " trades" + (wrong >= 0 ? ", first wrong at " + wrong : "") + ")");
        string d = (string)Priv("DiagJson");
        Check(d.Contains("\"sub\":81,") && d.Contains("\"startsAfter\":true"), "Sunday open: /diag fills says the older history starts after the page's first trade");
    }

    // Review J2 and J3 through the whole load: NinjaTrader's answer by date differs from the one by count at the front. The
    // page gets no older trade and is told (joinMismatch), so it never holds a trade twice or two swapped.
    static void AnswersDiffer()
    {
        foreach (int kind in new[] { 2, 3 })
        {
            DateTime t0 = new DateTime(DateTime.Now.AddMinutes(-20).Ticks / TimeSpan.TicksPerSecond * TimeSpan.TicksPerSecond);
            List<DateTime> t = new List<DateTime>(); List<double> p = new List<double>(); List<long> v = new List<long>();
            int s0 = 400;                                  // the recent window's first trade
            for (int i = 0; i < 1000; i++) { t.Add(t0.AddMilliseconds(100 * i)); p.Add(i % 2 == 0 ? 99 : 99.25); v.Add(1 + i % 2); }
            if (kind == 2)
            {
                // R: 99 at t, then three at t + 100 ms: 99 (same price: leans), 99 (leans), 100.5 (the front, g0 = 2)
                p[s0] = 99; t[s0 + 1] = t[s0 + 2] = t[s0 + 3] = t[s0].AddMilliseconds(100); p[s0 + 1] = 99; p[s0 + 2] = 99; p[s0 + 3] = 100.5;
            }
            else
            {
                // R: 99 at t, then 99 (5 lots, leans) and 100.25 (7 lots, the front) at t + 100 ms
                p[s0] = 99; t[s0 + 1] = t[s0 + 2] = t[s0].AddMilliseconds(100); p[s0 + 1] = 99; v[s0 + 1] = 5; p[s0 + 2] = 100.25; v[s0 + 2] = 7;
            }
            Tape k = Trades(t, p, v);
            Func<int, Bars> b;
            if (kind == 2) b = n => WholeDays(k, n, 1, i => i == s0 + 2 || i == s0 + 3);   // two of R's trades at the front's time missing
            else b = n =>
            {
                Bars x = WholeDays(k, n, 1, null);   // the two same-time trades in the other order
                int j = x.Times.IndexOf(t[s0 + 1]);
                double[] o = x.Ohlc[j]; x.Ohlc[j] = x.Ohlc[j + 1]; x.Ohlc[j + 1] = o; long vv = x.Volumes[j]; x.Volumes[j] = x.Volumes[j + 1]; x.Volumes[j + 1] = vv;
                return x;
            };
            // subscribe after 890 trades: e1 = 900, recent 500: R starts at trade 400
            Pulled r = LoadTape(k, 890, 500, 1, kind == 2 ? "82" : "83", b);
            int from, wrong;
            bool tail = IsTapeTail(k, r.Page, out from, out wrong);
            Check(r.Older.Count == 1 && r.Older[0].Contains("\"ticks\":[]") && r.Older[0].Contains("\"joinMismatch\":true") && r.Older[0].Contains("\"done\":true"),
                "review J" + kind + " through Subscribe: the answers differ at the front: nothing older sent, joinMismatch said at once (" + (r.Older.Count > 0 ? r.Older[0] : "none") + ")");
            int front = kind == 2 ? s0 + 3 : s0 + 2;
            Check(tail && from == front && r.OlderTrades == 0, "review J" + kind + " through Subscribe: the page holds the tape from its front (trade " + from + ") on, each trade once" + (wrong >= 0 ? " (first wrong at " + wrong + ")" : ""));
        }
    }

    // Review N1: the page asks with upTo (two more than it has); asking again with the same upTo adds nothing, so at most two
    // chunks are ever on their way, whatever the page re-asks while NinjaTrader loads the whole window.
    static void InFlight()
    {
        ChartBridgeConfig.RecentTicks = 200; ChartBridgeServer.OlderChunk = 100;
        DateTime t0 = new DateTime(DateTime.Now.AddMinutes(-20).Ticks / TimeSpan.TicksPerSecond * TimeSpan.TicksPerSecond);
        Tape k = MakeTape(t0, 3000, 0, 94, -1, -1, 300);
        Deliver(k, 0, 2600);
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        Priv("SubscribeLiveFirst", client, "MNQ", 5, 1, "84");
        Find(m0, IsMinute).Answer(new Bars(), ErrorCode.NoError);
        Find(m0, r => IsKind(r, MarketDataType.Last)).Answer(TradeBars(k, 2400, 2600), ErrorCode.NoError);
        Find(m0, r => IsKind(r, MarketDataType.Bid)).Answer(QuoteBars(k.BT, k.BP, 0, k.BT.Count), ErrorCode.NoError);
        Find(m0, r => IsKind(r, MarketDataType.Ask)).Answer(QuoteBars(k.AT, k.AP, 0, k.AT.Count), ErrorCode.NoError);
        Check(WaitFor(() => Made(m0).Count(r => IsKind(r, MarketDataType.Last)) == 2), "in flight: live, the older history asked");
        // Before the history is in, nothing is sent, so what is asked can be read: a page without upTo (one more per "more")
        // is capped at MaxAsked; a page with upTo asks for exactly upTo less what it got, however often it asks.
        for (int i = 0; i < 9; i++) Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":84}");
        int legacy; lock (client.Fill.Sync) legacy = client.Fill.Asked;
        Check(legacy == ChartBridgeServer.MaxAsked, "in flight: nine \"more\" without upTo ask for " + legacy + " (at most " + ChartBridgeServer.MaxAsked + ")");
        for (int i = 0; i < 5; i++) Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":84,\"upTo\":2}");   // the ready ask and four re-asks (10 s each)
        Made(m0).Where(r => IsKind(r, MarketDataType.Last)).Skip(1).First().Answer(TradeBars(k, 0, 2600), ErrorCode.NoError);
        Made(m0).Where(r => IsKind(r, MarketDataType.Bid)).Skip(1).First().Answer(QuoteBars(k.BT, k.BP, 0, k.BT.Count), ErrorCode.NoError);
        Made(m0).Where(r => IsKind(r, MarketDataType.Ask)).Skip(1).First().Answer(QuoteBars(k.AT, k.AP, 0, k.AT.Count), ErrorCode.NoError);
        Func<int> olderN = () => Sent().Count(x => x.StartsWith("{\"type\":\"olderTicks\""));
        WaitFor(() => olderN() >= 2);
        Thread.Sleep(80);
        int two = olderN();
        Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":84,\"upTo\":2}");
        Thread.Sleep(50);
        int still = olderN();
        Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":84,\"upTo\":3}");
        WaitFor(() => olderN() >= 3);
        Thread.Sleep(50);
        Check(two == 2 && still == 2 && olderN() == 3, "in flight (review N1): five asks for upTo 2 before the history came gave 2 chunks, not 4 (" + two + "); asking again gave none (" + still + "); upTo 3 gave one more (" + olderN() + ")");
    }

    // A minute view's volume profile needs trades only: "quotes": false asks no Bid and Ask ticks, in the recent window or
    // the older history (sides by the tick rule; the page does not use them on a minute view).
    static void TradesOnly()
    {
        ChartBridgeConfig.RecentTicks = 200; ChartBridgeServer.OlderChunk = 1000;
        DateTime t0 = new DateTime(DateTime.Now.AddMinutes(-20).Ticks / TimeSpan.TicksPerSecond * TimeSpan.TicksPerSecond);
        Tape k = MakeTape(t0, 3000, 0, 95, -1, -1, 300);
        Deliver(k, 0, 2600);
        lock (sent) sent.Clear();
        int m0 = MadeCount();
        Priv("OnClientMessage", client, "{\"type\":\"subscribe\",\"root\":\"MNQ\",\"days\":5,\"tickHours\":2,\"sub\":86,\"liveFirst\":true,\"quotes\":false}");
        Find(m0, IsMinute).Answer(new Bars(), ErrorCode.NoError);
        BarsRequest rt = Find(m0, r => IsKind(r, MarketDataType.Last));
        rt.Answer(TradeBars(k, 2400, 2600), ErrorCode.NoError);
        Check(WaitFor(() => Sent().Any(x => x.StartsWith("{\"type\":\"ready\"") && x.Contains("\"older\":true"))), "trades only: live at once (no quote answer to wait for)");
        Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":86,\"upTo\":4}");   // 2,600 trades: 3 chunks of 1,000
        WaitFor(() => Made(m0).Count(r => IsKind(r, MarketDataType.Last)) == 2);
        Made(m0).Where(r => IsKind(r, MarketDataType.Last)).Skip(1).First().Answer(TradeBars(k, 0, 2600), ErrorCode.NoError);
        Check(WaitFor(() => Sent().Any(x => x.StartsWith("{\"type\":\"olderTicks\"") && x.Contains("\"done\":true"))), "trades only: the older history comes");
        Check(rt.BarsBack == 200 && !Made(m0).Any(r => IsKind(r, MarketDataType.Bid) || IsKind(r, MarketDataType.Ask)), "trades only: no Bid or Ask request at all, recent or older (" + Made(m0).Count + " requests: minutes and the two trade requests)");
        List<double[]> got = Sent().Where(x => x.StartsWith("{\"type\":\"ticks\"") || x.StartsWith("{\"type\":\"olderTicks\"")).SelectMany(x => Arr(x, "ticks")).ToList();
        Check(got.Count > 0 && got.All(x => x.Length == 5 && ((int)x[4] == ChartBridgeSides.TickRule || (int)x[4] == 0)), "trades only: every trade's side by the tick rule (sm 3), or none for the very first");
        Check(((string)Priv("DiagJson")).Contains("not asked (the page wants trades only)"), "trades only: /diag sides says the quotes were not asked");
    }

    // Review N3: a page that disconnects mid-history has its older history dropped at once, not 120 s after NinjaTrader's
    // answer; and one that disconnects before "ready" never starts one.
    static void Disconnect()
    {
        ChartBridgeConfig.RecentTicks = 200; ChartBridgeServer.OlderChunk = 100;
        DateTime t0 = new DateTime(DateTime.Now.AddMinutes(-20).Ticks / TimeSpan.TicksPerSecond * TimeSpan.TicksPerSecond);
        Tape k = MakeTape(t0, 3000, 0, 96, -1, -1, 300);
        Deliver(k, 0, 2600);
        foreach (bool beforeReady in new[] { false, true })
        {
            List<string> got = new List<string>();
            ChartBridgeClient c = new ChartBridgeClient(null, 89);
            c.Tap = x => { lock (got) got.Add(x); };
            Clients()[89] = c;
            try
            {
                int m0 = MadeCount();
                string sub = beforeReady ? "88" : "87";
                Priv("SubscribeLiveFirst", c, "MNQ", 5, 1, sub);
                Find(m0, IsMinute).Answer(new Bars(), ErrorCode.NoError);
                if (beforeReady) c.Close();
                Find(m0, r => IsKind(r, MarketDataType.Last)).Answer(TradeBars(k, 2400, 2600), ErrorCode.NoError);
                Find(m0, r => IsKind(r, MarketDataType.Bid)).Answer(new Bars(), ErrorCode.NoError);
                Find(m0, r => IsKind(r, MarketDataType.Ask)).Answer(new Bars(), ErrorCode.NoError);
                if (beforeReady)
                {
                    WaitFor(() => { lock (got) return got.Any(x => x.StartsWith("{\"type\":\"ready\"")); });   // MarkReady ran (its sends still reach Tap)
                    Thread.Sleep(100);
                    Check(c.Fill == null && Made(m0).Count(r => IsKind(r, MarketDataType.Last)) == 1, "disconnect before ready: no older history is asked or kept");
                    continue;
                }
                Check(WaitFor(() => Made(m0).Count(r => IsKind(r, MarketDataType.Last)) == 2) && c.Fill != null, "disconnect: live, the older history asked");
                FillState f = c.Fill;
                c.Close();
                Check(WaitFor(() => c.Fill == null && f.Done, 2000) && ((string)Priv("DiagJson")).Contains("\"sub\":87,") && ((string)Priv("DiagJson")).Contains("dropped: the page disconnected"),
                    "disconnect (review N3): the older history is dropped at once (/diag: dropped: the page disconnected)");
                Made(m0).Where(r => IsKind(r, MarketDataType.Last)).Skip(1).First().Answer(TradeBars(k, 0, 2600), ErrorCode.NoError);
                Made(m0).Where(r => IsKind(r, MarketDataType.Bid)).Skip(1).First().Answer(new Bars(), ErrorCode.NoError);
                Made(m0).Where(r => IsKind(r, MarketDataType.Ask)).Skip(1).First().Answer(new Bars(), ErrorCode.NoError);
                Thread.Sleep(80);
                bool none; lock (got) none = !got.Any(x => x.StartsWith("{\"type\":\"olderTicks\""));
                Check(none && f.Ticks == null && ((string)Priv("DiagJson")).Contains("dropped: the page disconnected"), "disconnect: NinjaTrader's answer after that is freed at once, nothing sent, and /diag still says why");
            }
            finally { ChartBridgeClient gone; Clients().TryRemove(89, out gone); }
        }
    }


    // The tick-hours cap (0.3.5): 48 while CME Globex trades; up to 120 only while it is closed (the weekend, or a weekday
    // with no trade for 90 minutes: a full CME closure). Times are New York wall clock, turned into UTC.
    static DateTime EtUtc(int y, int mo, int d, int h, int mi) { return TimeZoneInfo.ConvertTimeToUtc(new DateTime(y, mo, d, h, mi, 0, DateTimeKind.Unspecified), ChartBridgeTime.Eastern); }
    static void TickHoursCapCases()
    {
        DateTime since = EtUtc(2026, 9, 20, 12, 0);         // subscribed to market data long before
        Func<DateTime, double, bool> closed = (now, quietMin) => ChartBridgeServer.GlobexClosed(now, now.AddMinutes(-quietMin), since);
        string[] names = { "Tuesday 10:00, trading", "Tuesday 17:30, the daily break (30 min quiet)", "Tuesday 17:59, the daily break (59 min quiet)", "Friday 16:59", "Friday 17:00", "Saturday 12:00",
                           "Sunday 17:59", "Sunday 18:01, the first trades in", "Monday 11:00, a full closure (no trade for 18 hours)", "Monday 18:01 after it reopened" };
        bool[] got = {
            closed(EtUtc(2026, 9, 29, 10, 0), 0.01), closed(EtUtc(2026, 9, 29, 17, 30), 30), closed(EtUtc(2026, 9, 29, 17, 59), 59), closed(EtUtc(2026, 10, 2, 16, 59), 0.01), closed(EtUtc(2026, 10, 2, 17, 0), 1),
            closed(EtUtc(2026, 10, 3, 12, 0), 19 * 60), closed(EtUtc(2026, 10, 4, 17, 59), 49 * 60), closed(EtUtc(2026, 10, 4, 18, 1), 0.5), closed(EtUtc(2026, 12, 28, 11, 0), 18 * 60), closed(EtUtc(2026, 12, 28, 18, 1), 0.2) };
        bool[] want = { false, false, false, false, true, true, true, false, true, false };
        string wrong = "";
        for (int i = 0; i < want.Length; i++) if (got[i] != want[i]) wrong += "; " + names[i] + ": " + (got[i] ? "closed" : "open");
        Check(wrong == "", "tick-hours cap: Globex closed on the weekend (Friday 17:00 to Sunday 18:00 ET) and after 90 minutes with no trade on a weekday (a full CME closure); the weekday daily break is not (" + want.Length + " times" + wrong + ")");
        Check(!ChartBridgeServer.GlobexClosed(EtUtc(2026, 9, 29, 12, 0), DateTime.MinValue, DateTime.MinValue), "tick-hours cap: before ChartBridge listens to market data, only the calendar counts");
        // Through the subscribe: a page asking 97 hours gets them on a Saturday, and 48 on a Tuesday (trades arriving).
        Func<DateTime> clockWas = ChartBridgeServer.CapClock;
        try
        {
            foreach (bool weekend in new[] { true, false })
            {
                DateTime fake = weekend ? EtUtc(2026, 10, 3, 12, 0) : DateTime.UtcNow;   // the harness's trades were just delivered: trading
                ChartBridgeServer.CapClock = () => fake;
                lock (sent) sent.Clear();
                int m0 = MadeCount();
                Priv("OnClientMessage", client, "{\"type\":\"subscribe\",\"root\":\"MNQ\",\"days\":5,\"tickHours\":97,\"sub\":" + (weekend ? 97 : 98) + "}");
                Find(m0, IsMinute).Answer(new Bars(), ErrorCode.NoError);
                BarsRequest t = Find(m0, r => IsKind(r, MarketDataType.Last));
                double hours = t == null ? -1 : (DateTime.Now - t.From).TotalHours;
                Check(t != null && Math.Abs(hours - (weekend ? 97 : 48)) < 0.1, "tick-hours cap: a subscribe for 97 hours " + (weekend ? "on a Saturday gets 97" : "while Globex trades gets 48") + " (" + hours.ToString("0.0", CultureInfo.InvariantCulture) + ")");
                foreach (BarsRequest r in Made(m0).Where(r => !r.Answered)) r.Answer(new Bars(), ErrorCode.NoError);
                Thread.Sleep(20);
                foreach (BarsRequest r in Made(m0).Where(r => !r.Answered)) r.Answer(new Bars(), ErrorCode.NoError);
            }
        }
        finally { ChartBridgeServer.CapClock = clockWas; }
    }


    // ------------------------------------------------------------ pacing against the 5 s rule
    // A page at a realistic pace (a 10,000-trade chunk costs it 5 ms, a live trade 30 us) pulls a million older trades while
    // 3,000 live trades a second arrive; a slow page (25 ms a chunk, 100 us a trade, 1,500 a second) too. The page asks for
    // the next chunk as each arrives (as live.js does). Measured: whether it is closed, the oldest waiting data (the 5 s
    // rule's own measure), and each live trade's wait from NinjaTrader's event to the page.
    class PageSocket : System.Net.WebSockets.WebSocket
    {
        public double ChunkUs, TickUs; public Action<string> OnGot;
        public int Chunks, Ticks; public double MaxLagMs;
        public readonly List<double> Lags = new List<double>(), Quiet = new List<double>();   // live trade waits while the history comes, and with none coming
        public volatile bool Filling;
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
            c.ThrowIfCancellationRequested();
            string text = System.Text.Encoding.UTF8.GetString(b.Array, b.Offset, b.Count);
            bool chunk = text.StartsWith("{\"type\":\"olderTicks\"");
            if (chunk && OnGot != null) OnGot(text);          // the page asks for the next one as this one arrives
            double us = chunk ? ChunkUs : TickUs;
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew(); while (sw.Elapsed.TotalMilliseconds < us / 1000.0) { }
            if (chunk) { Chunks++; if (text.Contains("\"done\":true")) Filling = false; }
            else if (text.StartsWith("{\"type\":\"tick\""))
            {
                Ticks++;
                double lag = ChartBridgeTime.NowUtcMs() - Field(text, "rx");
                lock (Lags) { if (Filling) { Lags.Add(lag); if (lag > MaxLagMs) MaxLagMs = lag; } else Quiet.Add(lag); }
            }
            return System.Threading.Tasks.Task.FromResult(0);
        }
    }

    static double Pct(List<double> l, double q) { lock (l) { List<double> x = l.OrderBy(v => v).ToList(); return x.Count > 0 ? x[Math.Min(x.Count - 1, (int)(x.Count * q))] : -1; } }
    static string F1(double v) { return v.ToString("0.0", CultureInfo.InvariantCulture); }

    static void Pacing()
    {
        ChartBridgeClient off; Clients().TryRemove(88, out off);   // only the paced page gets the live trades here
        ChartBridgeServer.OlderChunk = 10000;
        ChartBridgeConfig.RecentTicks = 5000;
        foreach (double[] row in new[] { new[] { 5000.0, 30, 3000 }, new[] { 25000.0, 100, 1500 } })
        {
            int older = 1000000;
            DateTime t0 = new DateTime(DateTime.Now.AddHours(-10).Ticks / TimeSpan.TicksPerSecond * TimeSpan.TicksPerSecond);
            // The older history: a million trades 30 ms apart (no quotes: sides by the tick rule, which is enough here).
            Bars big = new Bars();
            for (int i = 0; i < older + 5000; i++) big.Add(t0.AddTicks(i * 30L * TimeSpan.TicksPerMillisecond), 20000 + (i % 9) * 0.25, 0, 0, 20000 + (i % 9) * 0.25, 1 + i % 3);
            Bars recentBars = new Bars();
            for (int i = older; i < older + 5000; i++) recentBars.Add(big.Times[i], big.GetClose(i), 0, 0, big.GetClose(i), big.GetVolume(i));
            PageSocket sock = new PageSocket { ChunkUs = row[0], TickUs = row[1] };
            int id = 88000 + (int)row[1];
            ChartBridgeClient c = new ChartBridgeClient(sock, id);
            sock.OnGot = text => { if (!text.Contains("\"done\":true")) Priv("OnClientMessage", c, "{\"type\":\"more\",\"sub\":" + Sub(text) + "}"); };
            Clients()[id] = c;
            System.Threading.Tasks.Task loop = System.Threading.Tasks.Task.Run(() => c.SendLoop());
            volatile_stop = false;
            double maxAge = 0;
            Thread monitor = new Thread(() => { while (!volatile_stop) { if (sock.Filling) { double a = c.DataAgeMs(); if (a > maxAge) maxAge = a; } Thread.Sleep(2); } });
            monitor.Start();
            bool stopLive = false;
            Thread feed = null;
            try
            {
                int m0 = MadeCount();
                Priv("SubscribeLiveFirst", c, "MNQ", 5, 12, "90");
                Find(m0, IsMinute).Answer(new Bars(), ErrorCode.NoError);
                Find(m0, r => IsKind(r, MarketDataType.Last)).Answer(recentBars, ErrorCode.NoError);
                Find(m0, r => IsKind(r, MarketDataType.Bid)).Answer(new Bars(), ErrorCode.NoError);
                Find(m0, r => IsKind(r, MarketDataType.Ask)).Answer(new Bars(), ErrorCode.NoError);
                WaitFor(() => Made(m0).Count(r => IsKind(r, MarketDataType.Last)) == 2);
                // Live trades at the market's rate on their own thread: alone for 1.5 s, during the whole older history, and
                // alone again for 1.5 s after it.
                int rate = (int)row[2];
                DateTime liveT = big.Times[older + 4999];
                feed = new Thread(() =>
                {
                    System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
                    long sentN = 0;
                    while (!stopLive)
                    {
                        long due = (long)(sw.Elapsed.TotalSeconds * rate);
                        for (; sentN < due; sentN++)
                        {
                            liveT = liveT.AddTicks(TimeSpan.TicksPerMillisecond / 3);
                            Priv("OnMarketData", null, new MarketDataEventArgs { Instrument = inst, MarketDataType = MarketDataType.Last, Price = 20001, Volume = 1, Time = liveT });
                        }
                        Thread.Sleep(1);
                    }
                });
                feed.Start();
                Thread.Sleep(1500);
                sock.Filling = true;
                System.Diagnostics.Stopwatch fillClock = System.Diagnostics.Stopwatch.StartNew();
                Priv("OnClientMessage", c, "{\"type\":\"more\",\"sub\":90}");
                Priv("OnClientMessage", c, "{\"type\":\"more\",\"sub\":90}");
                BarsRequest bt = Made(m0).Where(r => IsKind(r, MarketDataType.Last)).Skip(1).First();
                bt.Answer(big, ErrorCode.NoError);
                Made(m0).Where(r => IsKind(r, MarketDataType.Bid)).Skip(1).First().Answer(new Bars(), ErrorCode.NoError);
                Made(m0).Where(r => IsKind(r, MarketDataType.Ask)).Skip(1).First().Answer(new Bars(), ErrorCode.NoError);
                bool done = WaitFor(() => sock.Chunks >= older / 10000 + 1 || ClosedLog(id), 120000);
                double fillMs = fillClock.Elapsed.TotalMilliseconds;
                Thread.Sleep(1500);
                stopLive = true; feed.Join(2000);
                bool closed = ClosedLog(id);
                string what = older.ToString("N0", CultureInfo.InvariantCulture) + " older trades, page " + (row[0] / 1000) + " ms a chunk and " + row[1] + " us a trade, " + rate + " live trades/s: " + sock.Chunks + " chunks in " + (fillMs / 1000).ToString("0.0", CultureInfo.InvariantCulture) + " s, closed " + closed +
                    ", oldest waiting data at most " + maxAge.ToString("0", CultureInfo.InvariantCulture) + " ms (the rule closes at 5,000); live trade wait while it came: median " + F1(Pct(sock.Lags, 0.5)) + " ms, p99 " + F1(Pct(sock.Lags, 0.99)) + " ms, max " + F1(sock.MaxLagMs) +
                    " ms; with no history coming: median " + F1(Pct(sock.Quiet, 0.5)) + " ms, p99 " + F1(Pct(sock.Quiet, 0.99)) + " ms (" + sock.Ticks + " live trades)";
                Console.WriteLine("     (" + what + ")");
                Check(done && !closed && maxAge < 1000 && sock.MaxLagMs < 1000, "pacing: " + what);
            }
            finally { stopLive = true; if (feed != null) feed.Join(2000); volatile_stop = true; monitor.Join(1000); ChartBridgeClient gone; Clients().TryRemove(id, out gone); c.Close(); }
        }
        // A million made-up rows are garbage now: collect them here, so the timing cases that run after this are not paused by it.
        GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
    }
    static volatile bool volatile_stop;
    static bool ClosedLog(int id) { lock (NinjaTrader.Code.Output.Lines) return NinjaTrader.Code.Output.Lines.Any(x => x.Contains("Client " + id + " is not keeping up")); }
}
