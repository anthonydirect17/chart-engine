// The seam between the backfill and the live trades (ChartBridge 0.3.3), run for real on Mono.
// First ChartBridgeSeam.Dedupe and TailFromTicks as pure functions (overlap, no overlap, a multiset at the last
// time, all held older, none older, empty backfill, empty hold, whole-second backfill against millisecond live
// trades, float noise in prices). Then the whole load through ChartBridgeServer's own Subscribe and OnMarketData,
// with the stand-in BarsRequest answered by hand the way NinjaTrader calls back: what goes on the wire and in
// what order, the tick request asking past now, a refused request asked again ending now, minute charts, and a
// load for an older subscribe sending nothing. Made-up prices; nothing here is market data.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript.AddOns;

public static class SeamHarness
{
    static Action<bool, string> Check;
    static readonly DateTime T0 = new DateTime(2026, 9, 29, 10, 0, 0);   // NinjaTrader time (the stand-in's zone is the PC's)

    static DateTime At(double seconds) { return T0.AddTicks((long)Math.Round(seconds * TimeSpan.TicksPerSecond)); }
    static SeamTick H(double s, double p, long v) { return new SeamTick { Time = At(s), Price = p, Volume = v, Json = s + "|" + p + "|" + v }; }
    static SeamResult D(double[][] back, params SeamTick[] held)
    {
        DateTime[] t = back.Select(b => At(b[0])).ToArray();
        return ChartBridgeSeam.Dedupe(t, back.Select(b => b[1]).ToArray(), back.Select(b => (long)b[2]).ToArray(), back.Length, held.ToList());
    }
    static string Out(SeamResult r) { return string.Join(" ", r.Release.Select(h => h.Json)); }

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        Pure();
        Load();
    }

    // ------------------------------------------------------------ the pure functions
    static void Pure()
    {
        double[][] back = { new double[] { 0, 21440, 2 }, new double[] { 0.5, 21440.25, 3 }, new double[] { 1.0, 21440.5, 4 } };

        // The review's case (scratchpad p6.js): the last backfill trade is held too. True volume 10, not 14.
        SeamResult r = D(back, H(1.0, 21440.5, 4), H(1.2, 21440.75, 1));
        Check(Out(r) == "1.2|21440.75|1" && r.DroppedSameTime == 1 && r.DroppedOlder == 0 && r.Held == 2,
            "seam: overlap at the last backfill time is dropped once, the later trade released (" + Out(r) + ")");
        long vol = back.Sum(b => (long)b[2]) + r.Release.Sum(h => h.Volume);
        Check(vol == 10, "seam: the review's example adds up to the true volume 10 (got " + vol + ")");

        r = D(back, H(0.5, 21440.25, 3), H(1.0, 21440.5, 4), H(1.2, 21440.75, 1), H(1.3, 21441, 2));
        Check(Out(r) == "1.2|21440.75|1 1.3|21441|2" && r.DroppedOlder == 1 && r.DroppedSameTime == 1, "seam: a held trade older than the backfill's end is dropped");

        r = D(back, H(1.2, 21440.75, 1), H(1.3, 21441, 2));
        Check(Out(r) == "1.2|21440.75|1 1.3|21441|2" && r.Dropped == 0, "seam: no overlap (every held trade after the backfill): all released, none dropped");

        r = D(back, H(1.0, 21440.25, 1), H(1.0, 21440.5, 5));
        Check(Out(r) == "1|21440.25|1 1|21440.5|5" && r.Dropped == 0, "seam: at the last time but another price or size: a real trade, released");

        // Multiset at the last time: the backfill has (p,1) twice and (q,2) once at T.
        double[][] multi = { new double[] { 0, 100, 1 }, new double[] { 2, 100, 1 }, new double[] { 2, 100.25, 2 }, new double[] { 2, 100, 1 } };
        r = D(multi, H(2, 100, 1), H(2, 100.25, 2), H(2, 100, 1), H(2, 100, 1), H(2, 100.25, 1), H(2.5, 100, 1));
        Check(Out(r) == "2|100|1 2|100.25|1 2.5|100|1" && r.DroppedSameTime == 3,
            "seam: same time, multiset: as many (price, size) dropped as the backfill has at that time, the rest released in order (" + Out(r) + ")");

        r = D(back, H(0, 21440, 2), H(0.5, 21440.25, 3), H(0.7, 21440, 1));
        Check(r.Release.Count == 0 && r.DroppedOlder == 3, "seam: every held trade older than the backfill's end: none released");

        r = D(back, H(3, 1, 1), H(2, 2, 2), H(4, 3, 3));
        Check(Out(r) == "3|1|1 2|2|2 4|3|3", "seam: none older: all released in arrival order (not sorted)");

        r = D(new double[0][], H(1, 1, 1), H(2, 2, 2));
        Check(Out(r) == "1|1|1 2|2|2" && !r.HasBackfillEnd && r.BackfillTicks == 0, "seam: empty backfill: every held trade released");
        r = ChartBridgeSeam.Dedupe(null, null, null, 0, new List<SeamTick> { H(1, 1, 1) });
        Check(r.Release.Count == 1, "seam: no backfill at all (null): held released");

        r = D(back);
        Check(r.Release.Count == 0 && r.Held == 0 && r.HasBackfillEnd && r.BackfillEnd == At(1.0), "seam: empty hold: nothing released, backfill end still reported");

        // Resolution: backfill in whole seconds, live in milliseconds: both compared in whole seconds.
        double[][] secs = { new double[] { 0, 50, 1 }, new double[] { 1, 51, 1 }, new double[] { 1, 52, 2 } };
        r = D(secs, H(0.9, 50, 1), H(1.3, 51, 1), H(1.4, 53, 1), H(1.6, 52, 2), H(2.1, 51, 1));
        Check(Out(r) == "1.4|53|1 2.1|51|1" && r.ResolutionTicks == TimeSpan.TicksPerSecond && r.DroppedOlder == 1 && r.DroppedSameTime == 2,
            "seam: whole-second backfill, millisecond live: compared by whole second (" + Out(r) + ")");
        r = D(back, H(1.0004, 21440.5, 4), H(1.0014, 21440.5, 4));
        Check(r.ResolutionTicks == ChartBridgeSeam.Ms && r.DroppedSameTime == 1 && Out(r) == "1.0014|21440.5|4",
            "seam: finer live times (0.1 ms) against a millisecond backfill: compared by millisecond; the next millisecond is kept");
        r = D(new double[][] { new double[] { 1.25, 7, 1 } }, H(1.25, 7, 1));
        Check(r.ResolutionTicks == ChartBridgeSeam.Ms && r.DroppedSameTime == 1, "seam: millisecond times on both sides: compared by millisecond");

        // Prices from the two sources may differ in the last float bit.
        r = ChartBridgeSeam.Dedupe(new[] { At(1) }, new[] { 0.1 + 0.2 }, new long[] { 1 }, 1, new List<SeamTick> { H(1, 0.3, 1) });
        Check(r.DroppedSameTime == 1, "seam: 0.1+0.2 and 0.3 are the same price");

        // Pure: the inputs are not changed.
        List<SeamTick> heldList = new List<SeamTick> { H(1.0, 21440.5, 4), H(1.2, 21440.75, 1) };
        DateTime[] bt = back.Select(b => At(b[0])).ToArray();
        ChartBridgeSeam.Dedupe(bt, back.Select(b => b[1]).ToArray(), back.Select(b => (long)b[2]).ToArray(), 3, heldList);
        Check(heldList.Count == 2 && bt[2] == At(1.0), "seam: Dedupe changes neither input");

        // The forming minute rebuilt from ticks. Bars are stamped at their close (10:01 = the 10:00 minute).
        DateTime[] tt = { At(-30), At(0), At(20), At(59.999), At(60), At(65) };
        double[] tp = { 1, 10, 12, 9, 20, 21 };
        long[] tv = { 5, 1, 2, 3, 4, 1 };
        RawBars tail = ChartBridgeSeam.TailFromTicks(At(60), tt, tp, tv, tt.Length);
        Check(tail != null && tail.Count == 2 && tail.Time[0] == At(60) && tail.Open[0] == 10 && tail.High[0] == 12 && tail.Low[0] == 9 && tail.Close[0] == 9 && tail.Volume[0] == 6
              && tail.Time[1] == At(120) && tail.Open[1] == 20 && tail.Close[1] == 21 && tail.Volume[1] == 5,
            "tail: the forming minute and the one after rebuilt from ticks; a trade at hh:mm:00 opens that minute");
        Check(ChartBridgeSeam.TailFromTicks(At(60), new[] { At(5), At(10) }, new[] { 1.0, 2.0 }, new long[] { 1, 1 }, 2) == null,
            "tail: ticks starting after the minute began: not rebuilt (NinjaTrader's bar stays)");
        Check(ChartBridgeSeam.TailFromTicks(At(60), new[] { At(-50), At(-10) }, new[] { 1.0, 2.0 }, new long[] { 1, 1 }, 2) == null,
            "tail: no trade in the forming minute: not rebuilt");
        Check(ChartBridgeSeam.TailFromTicks(At(60), new DateTime[0], new double[0], new long[0], 0) == null, "tail: no ticks: not rebuilt");
    }

    // ------------------------------------------------------------ the whole load through ChartBridgeServer
    static readonly List<string> sent = new List<string>();
    static ChartBridgeClient client;
    static Instrument inst;

    static object Priv(string name, params object[] args)
    {
        return typeof(ChartBridgeServer).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, args);
    }
    static void Live(double s, double p, long v)
    {
        Priv("OnMarketData", null, new MarketDataEventArgs { Instrument = inst, MarketDataType = MarketDataType.Last, Price = p, Volume = v, Time = At(s) });
    }
    static List<string> Sent() { lock (sent) return sent.ToList(); }
    static bool WaitFor(Func<bool> ok) { for (int i = 0; i < 300 && !ok(); i++) Thread.Sleep(10); return ok(); }
    static BarsRequest Req(int i) { lock (BarsRequest.Made) return BarsRequest.Made.Count > i ? BarsRequest.Made[i] : null; }
    static int Reqs() { lock (BarsRequest.Made) return BarsRequest.Made.Count; }
    static Bars Minutes(params double[][] rows) { Bars b = new Bars(); foreach (double[] r in rows) b.Add(At(r[0]), r[1], r[2], r[3], r[4], (long)r[5]); return b; }
    static Bars Ticks(params double[][] rows) { Bars b = new Bars(); foreach (double[] r in rows) b.Add(At(r[0]), r[1], r[1], r[1], r[1], (long)r[2]); return b; }
    static int Index(List<string> l, string has) { return l.FindIndex(s => s.Contains(has)); }
    static string Seams() { return (string)Priv("SeamsJson"); }

    static void Load()
    {
        // Linux has no Windows time zone names; ChartBridge asks for "Eastern Standard Time".
        typeof(ChartBridgeTime).GetField("et", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, TimeZoneInfo.FindSystemTimeZoneById("America/New_York"));
        inst = new Instrument { FullName = "MNQ 12-26", MasterInstrument = new MasterInstrument { Name = "MNQ", TickSize = 0.25, PointValue = 2 } };
        Dictionary<string, Instrument> instruments = (Dictionary<string, Instrument>)typeof(ChartBridgeServer).GetField("Instruments", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
        Instrument was;
        instruments.TryGetValue("MNQ", out was);
        instruments["MNQ"] = inst;
        var clients = (System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
        client = new ChartBridgeClient(null, 77);
        client.Tap = s => { lock (sent) sent.Add(s); };
        clients[77] = client;
        try { TickChart(); MinuteChart(); Refused(); Stale(); Empty(); }
        finally
        {
            ChartBridgeClient gone; clients.TryRemove(77, out gone);
            if (was != null) instruments["MNQ"] = was; else instruments.Remove("MNQ");
        }
    }

    static void TickChart()
    {
        lock (sent) sent.Clear();
        int r0 = Reqs();
        DateTime before = DateTime.Now;
        Priv("Subscribe", client, "MNQ", 5, 8);
        BarsRequest minutes = Req(r0);
        Check(minutes != null && minutes.To >= before.AddSeconds(-1) && minutes.To <= DateTime.Now.AddSeconds(1), "load: the minute request ends now (unchanged)");
        Live(1.0, 21440.5, 4);      // delivered after the hold began, also in the backfill
        Live(1.2, 21440.75, 1);     // after the backfill's end
        Check(Sent().Count == 0 && !client.Ready, "load: live trades are held while the backfill loads");
        minutes.Answer(Minutes(new double[] { 0, 21430, 21439, 21429, 21438, 50 }, new double[] { 60, 21438, 21441, 21437, 21439, 7 }), ErrorCode.NoError);
        BarsRequest ticks = Req(r0 + 1);
        Check(ticks != null && ticks.BarsBack < 0 && ticks.To >= minutes.To.AddMinutes(ChartBridgeServer.TickToMarginMinutes).AddSeconds(-1),
            "load: the tick request asks " + ChartBridgeServer.TickToMarginMinutes + " minutes past now");
        Check(ticks != null && ticks.From <= minutes.To.AddHours(-8).AddSeconds(1) && ticks.From >= minutes.To.AddHours(-8).AddSeconds(-1), "load: the tick request starts tickHours back");
        Live(1.3, 21441, 2);        // still held
        ticks.Answer(Ticks(new double[] { -30, 21438, 3 }, new double[] { 0, 21440, 2 }, new double[] { 0.5, 21440.25, 3 }, new double[] { 1.0, 21440.5, 4 }), ErrorCode.NoError);
        Check(WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0), "load: ready is sent");
        Thread.Sleep(30);
        List<string> l = Sent();
        int hist1 = Index(l, "\"type\":\"history\""), hist2 = l.FindLastIndex(s => s.Contains("\"type\":\"history\"")), tk = Index(l, "\"type\":\"ticks\""), rd = Index(l, "\"type\":\"ready\"");
        Check(hist1 >= 0 && hist1 < hist2 && hist2 < tk && tk < rd, "load: order on the wire: minute history, its last bar, ticks, ready");
        Check(l[hist1].Contains("\"done\":false") && !l[hist1].Contains("21441,") && l[hist2].Contains("\"done\":true"),
            "load: the forming minute is held back from the first history message; the last one says done");
        // The forming bar (close 10:01) rebuilt from the ticks at or after 10:00: O 21440 H 21440.5 L 21440 C 21440.5 V 9.
        Check(l[hist2].Contains(",21440,21440.5,21440,21440.5,9]"), "load: the forming minute rebuilt from the ticks (" + l[hist2] + ")");
        List<string> after = l.Skip(rd + 1).ToList();
        Check(after.Count == 2 && after[0].Contains("\"p\":21440.75") && after[1].Contains("\"p\":21441"),
            "load: after ready only the held trades not in the backfill, in order (" + after.Count + " sent)");
        Live(1.4, 21441.25, 1);
        Check(Sent().Last().Contains("\"p\":21441.25") && client.Ready, "load: then live trades go straight out");
        string seams = Seams();
        Check(seams.Contains("\"held\":3") && seams.Contains("\"droppedAsDuplicate\":1") && seams.Contains("\"released\":2") && seams.Contains("\"lastBackfillTick\":\"2026-09-29 ")
              && seams.Contains("\"tickToAheadMin\":60") && seams.Contains("\"minuteTailRebuilt\":1") && seams.Contains("\"resolutionMs\":1") && seams.Contains("\"overlapMs\":0"),
            "diag: the seam is in /diag (" + seams + ")");
        string diag = (string)Priv("DiagJson");
        Check(diag.Contains("\"seams\":[{"), "diag: /diag has seams");
    }

    static void MinuteChart()
    {
        lock (sent) sent.Clear();
        int r0 = Reqs();
        Priv("Subscribe", client, "MNQ", 5, 0);
        Live(1.0, 21440.5, 4);
        Live(1.2, 21440.75, 1);
        Req(r0).Answer(Minutes(new double[] { 0, 21430, 21439, 21429, 21438, 50 }, new double[] { 60, 21438, 21441, 21437, 21439, 7 }), ErrorCode.NoError);
        BarsRequest last = Req(r0 + 1);
        Check(last != null && last.BarsBack == ChartBridgeServer.SeamTicksBack, "minute chart: the last " + ChartBridgeServer.SeamTicksBack + " trades are asked for the forming minute");
        last.Answer(Ticks(new double[] { -30, 21438, 3 }, new double[] { 0, 21440, 2 }, new double[] { 0.5, 21440.25, 3 }, new double[] { 1.0, 21440.5, 4 }), ErrorCode.NoError);
        Check(WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0), "minute chart: ready is sent");
        Thread.Sleep(30);
        List<string> l = Sent();
        int rd = Index(l, "\"type\":\"ready\"");
        Check(Index(l, "\"type\":\"ticks\"") < 0, "minute chart: no tick backfill goes to the page");
        Check(l.Take(rd).Any(s => s.Contains(",21440,21440.5,21440,21440.5,9]")), "minute chart: the forming minute rebuilt from the same ticks");
        List<string> after = l.Skip(rd + 1).ToList();
        Check(after.Count == 1 && after[0].Contains("\"p\":21440.75"), "minute chart: the held trade already in that minute is not sent again");

        // The last trades do not reach back to the minute's start: NinjaTrader's bar stays and nothing is dropped.
        lock (sent) sent.Clear();
        r0 = Reqs();
        Priv("Subscribe", client, "MNQ", 5, 0);
        Live(1.0, 21440.5, 4);
        Req(r0).Answer(Minutes(new double[] { 60, 21438, 21441, 21437, 21439, 7 }), ErrorCode.NoError);
        Req(r0 + 1).Answer(Ticks(new double[] { 0.5, 21440.25, 3 }, new double[] { 1.0, 21440.5, 4 }), ErrorCode.NoError);
        Check(WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0), "minute chart, short ticks: ready is sent");
        Thread.Sleep(30);
        l = Sent();
        rd = Index(l, "\"type\":\"ready\"");
        Check(l.Take(rd).Any(s => s.Contains(",21438,21441,21437,21439,7]")) && l.Skip(rd + 1).Count() == 1,
            "minute chart, short ticks: NinjaTrader's minute kept and every held trade released (as 0.3.2)");
    }

    static void Refused()
    {
        lock (sent) sent.Clear();
        int r0 = Reqs();
        Priv("Subscribe", client, "MNQ", 5, 8);
        Live(1.2, 21440.75, 1);
        Req(r0).Answer(Minutes(new double[] { 60, 21438, 21441, 21437, 21439, 7 }), ErrorCode.NoError);
        Req(r0 + 1).Answer(new Bars(), ErrorCode.Panic);
        BarsRequest again = Req(r0 + 2);
        Check(again != null && again.To <= DateTime.Now.AddSeconds(1) && again.To >= DateTime.Now.AddMinutes(-1), "refused: a tick request ending in the future that fails is asked again ending now");
        Check(Index(Sent(), "Tick history failed") < 0, "refused: no warning for the first refusal");
        again.Answer(Ticks(new double[] { 0, 21440, 2 }, new double[] { 1.0, 21440.5, 4 }), ErrorCode.NoError);
        Check(WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0) && Seams().Contains("\"tickRetriedEndingNow\":true"), "refused: loads, and /diag says it was asked again");

        lock (sent) sent.Clear();
        r0 = Reqs();
        Priv("Subscribe", client, "MNQ", 5, 8);
        Live(1.2, 21440.75, 1);
        Req(r0).Answer(Minutes(new double[] { 60, 21438, 21441, 21437, 21439, 7 }), ErrorCode.NoError);
        Req(r0 + 1).Answer(new Bars(), ErrorCode.Panic);
        Req(r0 + 2).Answer(new Bars(), ErrorCode.Panic);
        Check(Reqs() == r0 + 3, "refused twice: asked again only once");
        Check(WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0), "refused twice: ready is still sent");
        Thread.Sleep(30);
        List<string> l = Sent();
        int rd = Index(l, "\"type\":\"ready\"");
        Check(Index(l, "Tick history failed") >= 0 && l.Skip(rd + 1).Count() == 1 && l.Take(rd).Any(s => s.Contains(",21438,21441,21437,21439,7]")),
            "refused twice: the warning, NinjaTrader's minute, and the held trade released (as 0.3.2)");
    }

    static void Stale()
    {
        lock (sent) sent.Clear();
        int r0 = Reqs();
        Priv("Subscribe", client, "MNQ", 5, 8);   // the page then asks again (say for more tick hours)
        Live(1.0, 21440.5, 4);
        Priv("Subscribe", client, "MNQ", 5, 33);
        Check(client.Pending.Count == 0, "stale: a new subscribe starts a fresh hold");
        Live(1.2, 21440.75, 1);
        Req(r0).Answer(Minutes(new double[] { 60, 1, 1, 1, 1, 1 }), ErrorCode.NoError);   // the old load answers first
        Thread.Sleep(50);
        Check(Sent().Count == 0 && Reqs() == r0 + 2, "stale: the older load sends nothing and asks for no ticks");
        Req(r0 + 1).Answer(Minutes(new double[] { 60, 21438, 21441, 21437, 21439, 7 }), ErrorCode.NoError);
        Req(r0 + 2).Answer(Ticks(new double[] { 0, 21440, 2 }, new double[] { 1.0, 21440.5, 4 }), ErrorCode.NoError);
        Check(WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0), "stale: the newer load completes");
        Thread.Sleep(30);
        List<string> l = Sent();
        Check(l.Count(s => s.Contains("\"type\":\"ready\"")) == 1 && !l.Any(s => s.Contains("[1,1,1,1,1]") || s.Contains(",1,1,1,1,1]")), "stale: one ready, nothing from the older load");
        Check(l.Skip(Index(l, "\"type\":\"ready\"") + 1).Count() == 1, "stale: the held trade from before the new subscribe is not sent (it is in the new backfill)");
    }

    static void Empty()
    {
        lock (sent) sent.Clear();
        int r0 = Reqs();
        Priv("Subscribe", client, "MNQ", 5, 8);
        Live(1.0, 21440.5, 4);
        Live(1.2, 21440.75, 1);
        Req(r0).Answer(new Bars(), ErrorCode.NoError);
        Req(r0 + 1).Answer(new Bars(), ErrorCode.NoError);
        Check(WaitFor(() => Index(Sent(), "\"type\":\"ready\"") >= 0), "empty: ready is sent");
        Thread.Sleep(30);
        List<string> l = Sent();
        Check(l.Skip(Index(l, "\"type\":\"ready\"") + 1).Count() == 2 && l.Any(s => s.Contains("\"bars\":[],\"done\":true")) && l.Any(s => s.Contains("\"ticks\":[],\"done\":true")),
            "empty: an empty history and backfill say done, and every held trade is released");
    }
}
