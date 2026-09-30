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
    static BackfillSides Full(Tape k, int n, int nb, int na)
    {
        QuoteSeries b = QuoteSeries.From(QuoteBars(k.BT, k.BP, 0, nb), DateTime.MinValue), a = QuoteSeries.From(QuoteBars(k.AT, k.AP, 0, na), DateTime.MinValue);
        return ChartBridgeSides.ClassifyBackfill(k.T.Take(n).ToArray(), k.P.Take(n).ToArray(), n, b.Time, b.Price, b.Seen, b.Count, a.Time, a.Price, a.Seen, a.Count, null, null, -1, 0.25);
    }

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        FrontPure();
        SidesProof();
        JoinPure();
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
    // 400 made-up tapes (some with a 70 s quote silence, some across the 17:00 to 18:00 ET break). For each, the recent
    // window is the last N trades and the last M rows of each quote side (N and M random), classified as ChartBridge does
    // it; a full load classifies every trade with every quote row. From FrontStart on, every side and method must agree.
    static void SidesProof()
    {
        int trials = 400, compared = 0, bad = 0, cutMattered = 0, quoteCut = 0;
        string firstBad = null;
        for (int trial = 0; trial < trials; trial++)
        {
            Random rnd = new Random(1000 + trial);
            DateTime start = trial % 4 == 1 ? SidesHarnessEt(2026, 9, 29, 16, 59, 45) : new DateTime(2026, 9, 29, 10, 0, 0);
            Tape k = MakeTape(start, 1500, rnd.Next(0, 6), 5000 + trial, trial % 3 == 0 ? rnd.NextDouble() : -1, trial % 4 == 1 ? 0.2 + rnd.NextDouble() * 0.6 : -1);
            int n = k.T.Count;
            BackfillSides full = Full(k, n, k.BT.Count, k.AT.Count);
            int rn = rnd.Next(50, n), mb = rnd.Next(20, k.BT.Count + 1), ma = rnd.Next(20, k.AT.Count + 1);
            DateTime[] rt = k.T.Skip(n - rn).ToArray(); double[] rp = k.P.Skip(n - rn).ToArray();
            QuoteSeries qb = QuoteSeries.From(QuoteBars(k.BT, k.BP, k.BT.Count - mb, k.BT.Count), DateTime.MinValue);
            QuoteSeries qa = QuoteSeries.From(QuoteBars(k.AT, k.AP, k.AT.Count - ma, k.AT.Count), DateTime.MinValue);
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
        Console.WriteLine("     (" + trials + " tapes: " + compared.ToString("N0", CultureInfo.InvariantCulture) + " recent trades from the front compared, " + bad + " differ; before the front " + cutMattered + " differ; the quote cut moved the front in " + quoteCut + ")");
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
        Check(j.Index == 2 && !j.Matched && Math.Abs(j.GapMs - 100) < 0.01, "join: older history ending before the window: all of it, gap " + j.GapMs + " ms");
        // NinjaTrader's two answers differ past the join: the positional join is kept and the mismatch reported.
        double[] bp4 = (double[])bp.Clone(); bp4[5] = 99;
        j = ChartBridgeFill.Join(bt, bp4, bv, 7, rt, rp, rv, 4, 0);
        Check(!j.Matched && j.MismatchAt >= 0, "join: answers that differ are reported (mismatch at " + j.MismatchAt + ", index " + j.Index + ")");
        j = ChartBridgeFill.Join(new DateTime[0], new double[0], new long[0], 0, rt, rp, rv, 4, 0);
        Check(j.Index == 0 && !j.Matched, "join: no older history: nothing to send");
        // Whole-second data: the same rule, on whole seconds.
        DateTime[] bt5 = { at(1), at(2), at(2), at(2), at(3) }; double[] bp5 = { 1, 2, 3, 2, 4 };
        DateTime[] rt5 = { at(2), at(2), at(3) }; double[] rp5 = { 3, 2, 4 };
        j = ChartBridgeFill.Join(bt5, bp5, new long[] { 1, 1, 1, 1, 1 }, 5, rt5, rp5, new long[] { 1, 1, 1 }, 3, 0);
        Check(j.Index == 2 && j.Matched, "join: whole-second times (" + j.Index + ")");
        // A big join: 2,000,000 older trades, found in microseconds (binary search).
        int big = 2000000;
        DateTime[] btb = new DateTime[big]; double[] bpb = new double[big]; long[] bvb = new long[big];
        for (int i = 0; i < big; i++) { btb[i] = at(i * 0.01); bpb[i] = 100 + (i % 7) * 0.25; bvb[i] = 1 + i % 3; }
        System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
        j = ChartBridgeFill.Join(btb, bpb, bvb, big, btb.Skip(big - 50000).ToArray(), bpb.Skip(big - 50000).ToArray(), bvb.Skip(big - 50000).ToArray(), 50000, 123);
        sw.Stop();
        Check(j.Index == big - 50000 + 123 && j.Matched && j.Checked == ChartBridgeFill.JoinCheck && sw.Elapsed.TotalMilliseconds < 50, "join: 2,000,000 older trades joined in " + sw.Elapsed.TotalMilliseconds.ToString("0.00") + " ms, " + j.Checked + " checked");
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
        client = new ChartBridgeClient(null, 88);
        client.Tap = s => { lock (sent) sent.Add(s); };
        Clients()[88] = client;
        Func<BarsRequest, bool> was = BarsRequest.AutoAnswer;
        BarsRequest.AutoAnswer = null;
        int recentWas = ChartBridgeConfig.RecentTicks, chunkWas = ChartBridgeServer.OlderChunk;
        try
        {
            WholeLoad();
            Stale();
            Fallbacks();
            MinuteAndOld();
            Pacing();
        }
        finally
        {
            ChartBridgeConfig.RecentTicks = recentWas; ChartBridgeServer.OlderChunk = chunkWas;
            BarsRequest.AutoAnswer = was;
            ChartBridgeClient gone; Clients().TryRemove(88, out gone);
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
        // The page asks for two chunks before the older history is in; live trades keep flowing straight out.
        Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":41}");
        Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":41}");
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
        // Pull the rest, one "more" per chunk, with live trades between.
        int got = 0, nextTrade = 30420;
        Func<int> olderN = () => Sent().Count(x => x.StartsWith("{\"type\":\"olderTicks\""));
        for (int guard = 0; guard < 500; guard++)
        {
            int g = got;
            if (!WaitFor(() => olderN() > g, 3000)) break;
            got = olderN();
            if (Sent().Any(x => x.StartsWith("{\"type\":\"olderTicks\"") && x.Contains("\"done\":true"))) break;
            nextTrade = Math.Min(k.T.Count, nextTrade + 30);
            e = Deliver(k, e, nextTrade);             // the market keeps trading between chunks
            for (int n = got - g; n > 0; n--) Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":41}");   // one more per chunk that came
        }
        e = Deliver(k, e, k.T.Count);                     // and the rest of the tape, live
        Thread.Sleep(50);
        l = Sent();
        List<string> older = l.Where(x => x.StartsWith("{\"type\":\"olderTicks\"")).ToList();
        Check(older.Count > 3 && older.Last().Contains("\"done\":true") && older.Take(older.Count - 1).All(x => x.Contains("\"done\":false")) && older.All(x => x.Contains("\"sub\":41")),
            "live first: the older history in " + older.Count + " chunks, the last says done");
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
        Priv("OnClientMessage", client, "{\"type\":\"more\",\"sub\":41}");
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
