// ChartBridge 0.6.25 on Mono: the delta table (nt8/PROTOCOL.md "The delta table"). Pure cases on a RootBook: the table against
// every trade and its side, per second; the 18:00 reset; a start after 18:00 and a feed down at 18:00; a feed drop's missed
// seconds and the CME's closed hours; the message, its compact rows and its size for a full session; the file read back and joined.
// Then through ChartBridgeServer's own subscribe and market data handler: a minute load and a served-window load with live trades
// coming while they load, whose table plus every tick after it equals the book's table (the seam); the served window's live trades
// with their sides for a page that asked, unchanged for one that did not; the table saved, ChartBridge restarted, read back, the
// seconds between counted missed, and a page already live told. Made-up prices and sides; nothing here is market data.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript.AddOns;

public static partial class WindowHarness
{
    // ------------------------------------------------------------ helpers
    class SidedTrade { public DateTime T; public double P; public long V; public int S; }
    static List<SidedTrade> SidedWalk(DateTime t0, int n, int seed, int stepMs)
    {
        Random rnd = new Random(seed);
        List<SidedTrade> l = new List<SidedTrade>(n);
        foreach (Trade x in Walk(t0, n, seed, stepMs)) { int k = rnd.Next(0, 20); l.Add(new SidedTrade { T = x.T, P = x.P, V = x.V, S = k < 9 ? 1 : k < 18 ? -1 : k < 19 ? 0 : ChartBridgeSides.NoSide }); }
        return l;
    }
    static void FeedSided(RootBook book, IEnumerable<SidedTrade> trades, DateTime listeningUtc, DateTime feedUpUtc)
    {
        foreach (SidedTrade x in trades) lock (book.Sync) book.OnTrade(x.T, x.P, x.V, EtSec(x.T), listeningUtc, feedUpUtc, 0, DateTime.MinValue, true, 0, x.S, x.S == 0 ? 0 : 3);
    }
    // second (since startEt) -> { buy, sell, unknown, largest trade }
    static SortedDictionary<long, long[]> DeltaTruth(IEnumerable<SidedTrade> trades, double startEt)
    {
        SortedDictionary<long, long[]> d = new SortedDictionary<long, long[]>();
        foreach (SidedTrade x in trades) AddSec(d, EtSec(x.T), startEt, x.S, x.V);
        return d;
    }
    static void AddSec(SortedDictionary<long, long[]> d, double et, double startEt, int s, long v)
    {
        long k = DeltaTable.SecondOf(et) - (long)startEt;
        long[] a; if (!d.TryGetValue(k, out a)) { a = new long[4]; d[k] = a; }
        a[s == 1 ? 0 : s == -1 ? 1 : 2] += v;
        if (v > a[3]) a[3] = v;
    }
    static SortedDictionary<long, long[]> OfTable(DeltaTable t)
    {
        SortedDictionary<long, long[]> d = new SortedDictionary<long, long[]>();
        for (int i = t.Hi >= 0 ? t.Lo : 0; i <= t.Hi; i++) { int b, s, u, g; t.Get(i, out b, out s, out u, out g); if (b + s + u > 0) d[i] = new long[] { b, s, u, g }; }
        return d;
    }
    static string DiffSec(SortedDictionary<long, long[]> a, SortedDictionary<long, long[]> b)
    {
        foreach (KeyValuePair<long, long[]> kv in a)
        {
            long[] o; if (!b.TryGetValue(kv.Key, out o)) o = new long[4];
            if (o[0] != kv.Value[0] || o[1] != kv.Value[1] || o[2] != kv.Value[2] || o[3] != kv.Value[3]) return "second " + kv.Key + ": " + string.Join("/", kv.Value) + " against " + string.Join("/", o);
        }
        foreach (KeyValuePair<long, long[]> kv in b) if (!a.ContainsKey(kv.Key) && kv.Value.Take(3).Any(x => x != 0)) return "second " + kv.Key + " missing";
        return null;
    }
    // A "deltaTable" message decoded: second -> volumes, and its fields.
    static SortedDictionary<long, long[]> DecodeDelta(string json, out double from, out double covered, out string why, out double missed)
    {
        SortedDictionary<long, long[]> d = new SortedDictionary<long, long[]>();
        from = Field(json, "from"); covered = Field(json, "coveredFrom"); missed = Field(json, "missed");
        int w = json.IndexOf("\"why\":") + 6; why = json.Substring(w, 4) == "null" ? null : json.Substring(w + 1, json.IndexOf('"', w + 1) - w - 1);
        long[] rows = Ints(json, "rows"), unk = Ints(json, "unknown");
        long sec = 0;
        int rs = json.Contains("\"big\":true") ? 4 : 3, us = rs - 1;   // with each second's largest trade: rows of 4, unknowns of 3
        for (int i = 0; i + rs - 1 < rows.Length; i += rs) { sec += rows[i]; long[] a; if (!d.TryGetValue(sec, out a)) { a = new long[4]; d[sec] = a; } a[0] += rows[i + 1]; a[1] += rows[i + 2]; if (rs == 4) a[3] = rows[i + 3]; }
        sec = 0;
        for (int i = 0; i + us - 1 < unk.Length; i += us) { sec += unk[i]; long[] a; if (!d.TryGetValue(sec, out a)) { a = new long[4]; d[sec] = a; } a[2] += unk[i + 1]; if (us == 3 && a[3] == 0) a[3] = unk[i + 2]; }
        return d;
    }
    static long[] Ints(string json, string key)
    {
        int i = json.IndexOf("\"" + key + "\":[") + key.Length + 4, j = json.IndexOf(']', i);
        string body = json.Substring(i, j - i);
        return body.Length == 0 ? new long[0] : body.Split(',').Select(x => long.Parse(x, CultureInfo.InvariantCulture)).ToArray();
    }
    static string DeltaOf(List<string> l, string sub) { return l.LastOrDefault(x => x.StartsWith("{\"type\":\"deltaTable\"") && x.Contains(SubOf(sub) + ",")); }
    static void SubDelta(ChartBridgeClient c, string sub, int tickHours, bool delta)
    {
        Priv("OnClientMessage", c, "{\"type\":\"subscribe\",\"root\":\"MNQ\",\"days\":5,\"tickHours\":" + tickHours + ",\"sub\":" + sub + (tickHours > 0 ? ",\"liveFirst\":true" : "") + ",\"profile\":true" + (delta ? ",\"deltaTable\":true" : "") + "}");
    }
    // What the page with `sub` holds: its table plus every tick after its ready (or after the last pushed table, when one came later).
    static SortedDictionary<long, long[]> PageDelta(List<string> l, string sub, double startEt)
    {
        int ready = l.FindIndex(x => x.StartsWith("{\"type\":\"ready\"") && x.Contains(SubOf(sub)));
        int at = l.FindLastIndex(x => x.StartsWith("{\"type\":\"deltaTable\"") && (x.Contains(SubOf(sub) + ",") || !x.Contains("\"sub\":")));
        if (ready < 0 || at < 0) return null;
        double f, c, m; string w;
        SortedDictionary<long, long[]> d = DecodeDelta(l[at], out f, out c, out w, out m);
        foreach (string x in l.Skip(Math.Max(ready, at) + 1).Where(x => x.StartsWith("{\"type\":\"tick\""))) AddSec(d, Field(x, "t"), startEt, (int)Field(x, "s"), (long)Field(x, "v"));
        return d;
    }
    static SortedDictionary<long, long[]> BookDelta(RootBook book) { lock (book.Sync) return book.Delta != null ? OfTable(book.Delta) : null; }

    // ------------------------------------------------------------ pure cases
    static void DeltaPure()
    {
        // A session from 18:00 ET Monday 2026-09-28 into Tuesday, ChartBridge listening since before it: whole, every trade with its side.
        DateTime s0 = Et(2026, 9, 28, 18, 0, 0.05);
        List<SidedTrade> tape = SidedWalk(s0, 60000, 21, 700);
        tape.AddRange(SidedWalk(Et(2026, 9, 29, 9, 29, 50), 30000, 22, 15));
        tape = tape.OrderBy(x => x.T).ToList();
        RootBook book = new RootBook("MNQ", 0.25);
        DateTime listening = ChartBridgeTime.ToUtc(s0).AddHours(-1);
        FeedSided(book, tape, listening, listening);
        DateTime start, end; SessionClock.Bounds(s0, out start, out end);
        DeltaTable d = book.Delta;
        string diff = d != null ? DiffSec(OfTable(d), DeltaTruth(tape, d.StartEt)) : "no table";
        Check(d != null && diff == null && d.Why == null && d.CoveredFromEt == d.StartEt && d.StartEt == EtSec(start),
            "delta table: every trade of the session in its second with its side (buy, sell, unknown; no side is unknown), exactly, from 18:00 ET (" + tape.Count.ToString("N0", CultureInfo.InvariantCulture) + " trades" + (diff != null ? "; " + diff : "") + ")");
        long buy = tape.Where(x => x.S == 1).Sum(x => x.V), sell = tape.Where(x => x.S == -1).Sum(x => x.V);
        Check(d != null && d.BuyVol == buy && d.SellVol == sell && d.Trades == tape.Count, "delta table: its totals are the tape's (buy " + buy + ", sell " + sell + ")");
        // the second is the one a page reads from t on the wire (rounded to the ms): 10:00:00.9996 is 10:00:01
        RootBook b2 = new RootBook("MNQ", 0.25);
        DateTime edge = Et(2026, 9, 29, 10, 0, 0.9996);
        FeedSided(b2, new[] { new SidedTrade { T = edge, P = 20000, V = 3, S = 1 } }, listening, listening);
        int eb, es, eu; b2.Delta.Get((int)(DeltaTable.SecondOf(EtSec(edge)) - (long)b2.Delta.StartEt), out eb, out es, out eu);
        Check(eb == 3 && DeltaTable.SecondOf(EtSec(edge)) == (long)Math.Floor(double.Parse(CbJson.Num3(EtSec(edge)), CultureInfo.InvariantCulture)), "delta table: a trade at .9996 s is in the second its ms-rounded time names (the page's)");

        // The message: rows and unknowns delta coded, less the trades the page gets live after it.
        List<SidedTrade> held = tape.Skip(tape.Count - 400).ToList();
        List<SeamTick> less = held.Select(x => new SeamTick { Time = x.T, Price = x.P, Volume = x.V, Side = x.S }).ToList();
        DeltaSnap snap; lock (book.Sync) snap = d.Snap(d.StartEt);
        string json = snap.Json("MNQ", "9", less);
        double f, c, m; string why;
        SortedDictionary<long, long[]> sentRows = DecodeDelta(json, out f, out c, out why, out m);
        // the largest trade of a second is kept as the table has it (the page's live ticks after it can only match or beat it): checked
        // against every trade, the volumes against the trades before the held ones
        SortedDictionary<long, long[]> wantMsg = DeltaTruth(tape.Take(tape.Count - 400), d.StartEt), allBig = DeltaTruth(tape, d.StartEt);
        foreach (KeyValuePair<long, long[]> kv in wantMsg) kv.Value[3] = allBig[kv.Key][3];
        string d2 = DiffSec(sentRows, wantMsg);
        // R12 N5: a second whose largest trade is a held one (the page gets it live after) says -1
        foreach (KeyValuePair<long, long[]> kv in wantMsg)
        {
            long heldMax = held.Where(x => DeltaTable.SecondOf(EtSec(x.T)) - (long)d.StartEt == kv.Key).Select(x => x.V).DefaultIfEmpty(0).Max();
            if (heldMax >= kv.Value[3]) kv.Value[3] = -1;
        }
        d2 = DiffSec(sentRows, wantMsg);
        Check(d2 == null && f == d.StartEt && c == d.StartEt && why == null && m == 0 && json.StartsWith("{\"type\":\"deltaTable\",\"root\":\"MNQ\",\"sub\":9,"),
            "delta message: the table less the trades the page is about to get live equals every trade before them" + (d2 != null ? " (" + d2 + ")" : ""));
        // A full session at every second (82,800 seconds, a busy NQ day's sizes): its size and the time to copy and write it.
        RootBook full = new RootBook("NQ", 0.25);
        Random rnd = new Random(5);
        DateTime fs = Et(2026, 9, 28, 18, 0, 0);
        List<SidedTrade> heavy = new List<SidedTrade>(82800 * 3);
        for (int sec = 0; sec < 82800; sec++) for (int k = 0; k < 3; k++) heavy.Add(new SidedTrade { T = fs.AddSeconds(sec + 0.1 + 0.3 * k), P = 20000, V = 1 + rnd.Next(0, 30), S = k == 2 ? (rnd.Next(0, 50) == 0 ? 0 : -1) : 1 });
        FeedSided(full, heavy, ChartBridgeTime.ToUtc(fs).AddHours(-1), ChartBridgeTime.ToUtc(fs).AddHours(-1));
        System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
        DeltaSnap fsnap; lock (full.Sync) fsnap = full.Delta.Snap(full.Delta.StartEt);
        double snapMs = sw.Elapsed.TotalMilliseconds; sw.Restart();
        string fj = fsnap.Json("NQ", "1", null);
        double jsonMs = sw.Elapsed.TotalMilliseconds;
        Console.WriteLine("     (a full session's delta table, 82,800 seconds: " + fj.Length.ToString("N0", CultureInfo.InvariantCulture) + " bytes; copied under the lock in " + snapMs.ToString("0.00", CultureInfo.InvariantCulture) + " ms, written in " + jsonMs.ToString("0.00", CultureInfo.InvariantCulture) + " ms, Mono)");
        Check(fj.Length < 2000000 && snapMs < 50, "delta message: a full session at every second is " + (fj.Length / 1e6).ToString("0.00", CultureInfo.InvariantCulture) + " MB (budget 2 MB), copied under the lock in " + snapMs.ToString("0.00", CultureInfo.InvariantCulture) + " ms");

        // 18:00 ET: a new session's table starts at 0; the finished one waits only for its last seconds to be written.
        List<SidedTrade> next = SidedWalk(Et(2026, 9, 29, 18, 0, 0.2), 500, 23, 300);
        FeedSided(book, next, listening, listening);
        DeltaTable n = book.Delta;
        Check(n != d && n.StartEt == d.StartEt + 86400 && DiffSec(OfTable(n), DeltaTruth(next, n.StartEt)) == null && book.DeltaDone.Contains(d) && n.Why == null,
            "delta table: reset at 18:00 ET: the new session's table holds only its own trades, from 18:00 (the finished one kept for its file)");
        // Thursday 17:00 to 18:00 and a trade replayed hours late at market data start never open a session (the session table's rule).
        RootBook b3 = new RootBook("MNQ", 0.25);
        lock (b3.Sync) b3.OnTrade(Et(2026, 9, 29, 12, 0, 0), 20000, 2, EtSec(Et(2026, 9, 29, 12, 0, 0)), listening, listening, 0, Et(2026, 9, 29, 20, 0, 0), true, 0, 1, 2);
        Check(b3.Delta == null, "delta table: a trade more than 2 minutes off the clock opens no session (NinjaTrader's replayed last trade)");

        // ChartBridge started after 18:00: from its first trade, "start"; running at 18:00 with the feed down: "feed".
        RootBook b4 = new RootBook("MNQ", 0.25);
        DateTime late0 = Et(2026, 9, 29, 10, 4, 0.31);
        List<SidedTrade> lateTape = SidedWalk(late0, 50, 24, 100);
        FeedSided(b4, lateTape, ChartBridgeTime.ToUtc(late0).AddSeconds(-1), ChartBridgeTime.ToUtc(late0).AddSeconds(-1));
        RootBook b5 = new RootBook("MNQ", 0.25);
        FeedSided(b5, SidedWalk(late0, 50, 24, 100), listening, ChartBridgeTime.ToUtc(late0).AddSeconds(-1));
        Check(b4.Delta.Why == "start" && Math.Abs(b4.Delta.CoveredFromEt - EtSec(lateTape[0].T)) < 0.001 && b5.Delta.Why == "feed",
            "delta table: started at 10:04 ET it counts from its first trade and says ChartBridge started; running with the feed down at 18:00 it says so");

        // A feed drop while open: missed from the drop to the next trade; the break and closed hours are never missed.
        RootBook b6 = new RootBook("MNQ", 0.25);
        DateTime m0 = Et(2026, 9, 29, 11, 0, 0.5);
        FeedSided(b6, new[] { new SidedTrade { T = m0, P = 20000, V = 1, S = 1 } }, listening, listening);
        lock (b6.Sync) b6.FeedDropped(EtSec(m0) + 1, "test");
        FeedSided(b6, new[] { new SidedTrade { T = m0.AddSeconds(31), P = 20000, V = 1, S = -1 } }, listening, listening);
        double brk = ChartBridgeServer.OpenSeconds(EtSec(Et(2026, 9, 29, 16, 59, 30)), EtSec(Et(2026, 9, 29, 18, 0, 30)));
        double xmas = ChartBridgeServer.OpenSeconds(EtSec(Et(2026, 12, 24, 13, 10, 0)), EtSec(Et(2026, 12, 24, 13, 20, 0)));
        Check(Math.Abs(b6.Delta.Missed - 30) < 0.01 && Math.Abs(brk - 60) < 0.01 && Math.Abs(xmas - 300) < 0.01,
            "delta table: a feed drop misses 30 s to the next trade; 16:59:30 to 18:00:30 misses 60 s (the break is closed); Christmas Eve 13:10 to 13:20 misses 5 minutes (CME halts at 13:15)");

        // The file: read back, and joined to a later run of the same session.
        DeltaTable saved = DeltaTable.Parse(d.Header() + "0 5 3 0 4\n100 2 0 1 2\n100 1 1 0 1\n50 1 0 0\nm 12.5\n7 9 9", d.StartEt);
        DeltaTable other = DeltaTable.Parse(d.Header() + "0 5 3 0\n", d.StartEt + 86400);
        int g0, g100, g50, xb, xs, xu; saved.Get(0, out xb, out xs, out xu, out g0); saved.Get(100, out xb, out xs, out xu, out g100); saved.Get(50, out xb, out xs, out xu, out g50);
        Check(saved != null && other == null && saved.Missed == 12.5 && saved.Hi == 100 && saved.BuyVol == 9 && saved.SellVol == 4 && saved.UnknownVol == 1 && g0 == 4 && g100 == 2 && g50 == DeltaTable.BigUnknown,
            "delta file: lines add up (a second written again by a late trade; its largest trade the larger), a cut last line is left out, missed seconds are kept; a line of an older file (four fields) reads with its largest trade not known (0); another session's file is not read");
        DeltaTable run = new DeltaTable { StartEt = d.StartEt, CoveredFromEt = d.StartEt + 1000, Why = "start" };
        run.Put(1000, 4, 0, 0, 4);
        double gap = run.Join(saved);
        Check(Math.Abs(gap - 899) < 0.01 && run.CoveredFromEt == d.StartEt && run.Why == null && Math.Abs(run.Missed - 911.5) < 0.01 && run.BuyVol == 13,
            "delta file: a restart's run joins the saved seconds, keeps the session's start, and counts the seconds between (899 s) missed");
    }

    // ------------------------------------------------------------ through the server
    static void DeltaLoads()
    {
        DateTime t0 = SimBase.AddHours(-1);
        DateTime ss, se; SessionClock.Bounds(t0, out ss, out se);
        List<Trade> tape = Walk(t0, 30000, 81, 110);   // about 55 minutes
        simNow = t0;
        ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(ss).AddMinutes(-5));   // listening since before the session: whole
        lock (sent) sent.Clear();
        Live(tape, 0, 20000);
        RootBook book = ChartBridgeServer.BookOf("MNQ", inst);
        double startEt; lock (book.Sync) startEt = book.Delta.StartEt;
        // A minute page with the table: trades come while it loads (a feeder of its own), held and released after ready.
        int m0 = MadeCount();
        SubDelta(client, "801", 0, true);
        Thread feeder = new Thread(() => Live(tape, 20000, 21000));
        feeder.Start();
        AnswerMinutes(m0);
        BarsRequest last = null;
        WaitFor(() => Ready(Sent(), "801") || (last = Find(m0, r => IsTrades(r) && r.BarsBack == ChartBridgeServer.SeamTicksBack)) != null, 3000);
        if (last != null && !last.Answered) last.Answer(Answer(tape, 0, 20000), ErrorCode.NoError);
        feeder.Join();
        Check(WaitFor(() => Ready(Sent(), "801")), "delta load (1m): ready");
        Live(tape, 21000, 22000);
        Thread.Sleep(80);
        List<string> l = Sent();
        string dm = DeltaOf(l, "801");
        int at = l.IndexOf(dm), rd = l.FindIndex(x => x.StartsWith("{\"type\":\"ready\"") && x.Contains(SubOf("801"))), pf = l.FindIndex(x => x.StartsWith("{\"type\":\"profile\"") && x.Contains(SubOf("801")));
        Check(dm != null && pf >= 0 && pf < at && at < rd, "delta load (1m): the deltaTable message comes after the profile, before ready");
        SortedDictionary<long, long[]> page = PageDelta(l, "801", startEt), truth = BookDelta(book);
        string diff = page != null && truth != null ? DiffSec(page, truth) : "none";
        Check(diff == null, "delta load (1m): the table plus every tick after ready equals ChartBridge's own table, second by second, with 1,000 trades coming during the load (the seam)" + (diff != null ? ": " + diff : ""));
        // A page that does not ask gets no table (an older page, The Desk's relay).
        int m1 = MadeCount();
        lock (sent) sent.Clear();
        Sub(client, "802", 0, false);
        AnswerMinutes(m1);
        WaitFor(() => Ready(Sent(), "802"), 3000);
        BarsRequest last2 = Find(m1, r => IsTrades(r) && r.BarsBack == ChartBridgeServer.SeamTicksBack);
        if (last2 != null && !last2.Answered) last2.Answer(Answer(tape, 0, 22000), ErrorCode.NoError);
        Check(WaitFor(() => Ready(Sent(), "802")) && !Sent().Any(x => x.Contains("\"type\":\"deltaTable\"")), "delta load: a subscribe without deltaTable gets no table");

        // A served window (seconds or range page): NinjaTrader's answer has no side, the live trades since it carry theirs.
        int m2 = MadeCount();
        lock (sent) sent.Clear();
        ChartBridgeServer.WindowFirstGuess = 30000;
        SubDelta(client, "803", 2, true);
        AnswerMinutes(m2);
        BarsRequest w = null;
        WaitFor(() => (w = Find(m2, IsTrades)) != null);
        Live(tape, 22000, 22300);                           // held while NinjaTrader answers
        if (w != null) w.Answer(Answer(tape, 0, 22100), ErrorCode.NoError);   // its answer ends inside the held trades
        Check(WaitFor(() => Ready(Sent(), "803")), "delta load (window): ready");
        Live(tape, 22300, 23000);
        Thread.Sleep(80);
        l = Sent();
        Page p = PageOf(l, "803", client);
        List<string> rows = l.Where(x => x.StartsWith("{\"type\":\"ticks\"") && x.Contains(SubOf("803"))).ToList();
        int sided = rows.Sum(x => Arr(x, "ticks").Count(r => r.Length >= 5 && !double.IsNaN(r[3]))), plain = rows.Sum(x => Arr(x, "ticks").Count(r => r.Length < 5 || double.IsNaN(r[3])));
        page = PageDelta(l, "803", startEt); truth = BookDelta(book);
        diff = page != null ? DiffSec(page, truth) : "none";
        Check(sided == 200 && plain == p.Windows - 200 && diff == null,
            "delta load (window): the 200 trades held while NinjaTrader answered, after its answer, carry their sides ([t, p, v, s, sm]); its " + plain + " trades do not; table plus ticks equals ChartBridge's table" + (diff != null ? " (" + diff + ")" : "") + (sided != 200 ? " (sided " + sided + ", window " + p.Windows + ")" : ""));
        // the same window to a page that did not ask: as before, no side in places 4 and 5
        lock (sent) sent.Clear();
        int m3 = MadeCount();
        Sub(client, "804", 2, true);
        AnswerMinutes(m3);
        WaitFor(() => Ready(Sent(), "804"));
        int sidedOld = Sent().Where(x => x.StartsWith("{\"type\":\"ticks\"") && x.Contains(SubOf("804"))).Sum(x => Arr(x, "ticks").Count(r => r.Length >= 5 && !double.IsNaN(r[3])));
        Check(sidedOld == 0 && !Sent().Any(x => x.Contains("\"type\":\"deltaTable\"")), "delta load (window): a page that did not ask gets the window as before (no sides, no table)");
        ChartBridgeServer.WindowFirstGuess = 200000;

        // Saved, then ChartBridge restarts 2 minutes later: read back, the seconds between missed, the session's start kept.
        string folder = ChartBridgeConfig.Folder;
        foreach (string f in Directory.GetFiles(folder, "delta-MNQ-*.txt")) File.Delete(f);
        ChartBridgeServer.DeltaFiles = true;
        try
        {
            ChartBridgeServer.SaveDeltas();
            string file = ChartBridgeServer.DeltaFile("MNQ", startEt);
            Live(tape, 23000, 23500);
            ChartBridgeServer.SaveDeltas();                  // a second pass appends
            SortedDictionary<long, long[]> before = BookDelta(book);
            int lastSec = before.Keys.Max() > 0 ? (int)before.Keys.Max() : 0;
            DeltaTable back = File.Exists(file) ? DeltaTable.Parse(File.ReadAllText(file), startEt) : null;
            before.Remove(lastSec);                          // the second still forming waits for the next pass
            Check(back != null && DiffSec(OfTable(back), before) == null && File.ReadAllText(file).StartsWith("deltatable 1 "),
                "delta file: two passes write every closed second once (the forming one waits), off the market data thread" + (back == null ? " (no file: " + file + ")" : DiffSec(OfTable(back), before) != null ? " (" + DiffSec(OfTable(back), before) + ")" : ""));
            // the restart: the books start over; the next trades come 2 minutes after the last one
            DateTime restartAt = tape[23499].T.AddSeconds(120);
            List<Trade> after = Walk(restartAt, 2000, 82, 100);
            simNow = restartAt;
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(restartAt).AddSeconds(-1));
            RootBook nb = ChartBridgeServer.BookOf("MNQ", inst);
            Check(WaitFor(() => { lock (nb.Sync) return nb.DeltaReadDone; }, 3000), "delta file: read back at the start, off the thread that made the book");
            Live(after, 0, 1000);
            lock (sent) sent.Clear();
            int m4 = MadeCount();
            SubDelta(client, "805", 0, true);
            AnswerMinutes(m4);
            WaitFor(() => Ready(Sent(), "805"), 3000);
            BarsRequest l4 = Find(m4, r => IsTrades(r) && r.BarsBack == ChartBridgeServer.SeamTicksBack);
            if (l4 != null && !l4.Answered) l4.Answer(Answer(after, 0, 1000), ErrorCode.NoError);
            Check(WaitFor(() => Ready(Sent(), "805")), "delta after a restart: ready");
            Live(after, 1000, 1200);
            Thread.Sleep(80);
            l = Sent();
            string rm = DeltaOf(l, "805");
            double from, cov, missed; string why;
            if (rm != null) DecodeDelta(rm, out from, out cov, out why, out missed); else { from = cov = missed = -1; why = "none"; }
            SortedDictionary<long, long[]> want = new SortedDictionary<long, long[]>(OfTable(back));
            long gapFrom = (long)startEt + back.Hi + 1;
            double expectMissed = EtSec(after[0].T) - gapFrom;
            page = PageDelta(l, "805", startEt); truth = BookDelta(nb);
            diff = page != null ? DiffSec(page, truth) : "none";
            string kept = DiffSec(want, new SortedDictionary<long, long[]>(truth.Where(kv => kv.Key <= back.Hi).ToDictionary(kv => kv.Key, kv => kv.Value)));
            Check(rm != null && from == startEt && cov == startEt && why == null && Math.Abs(missed - Math.Round(expectMissed)) <= 1 && diff == null && kept == null,
                "delta after a restart: the page's table is the saved seconds plus the new run's, from 18:00 ET, with the " + Math.Round(expectMissed) + " s between them missed (" + missed + ")" + (diff != null ? "; " + diff : "") + (kept != null ? "; " + kept : ""));
            // R12 S1: a trade for a second the pass is writing, arriving while it writes, is written by the next pass
            bool hookRan = false;
            Trade lateOne = new Trade { T = after[600].T, P = after[600].P, V = 9 };
            ChartBridgeServer.DeltaSaveHookForHarness = () => { if (hookRan) return; hookRan = true; Live(new List<Trade> { lateOne }, 0, 1); simNow = after[1199].T; };
            ChartBridgeServer.SaveDeltas();
            ChartBridgeServer.DeltaSaveHookForHarness = null;
            ChartBridgeServer.SaveDeltas();
            // R12 S2: a crash cut the file's last line in its fourth field ("100 2 0 1" of "100 2 0 13 5"): taken off before the next append
            File.AppendAllText(file, "100 2 0 1");
            DeltaTable cutRead = DeltaTable.Parse(File.ReadAllText(file), startEt);
            int c100b, c100s, c100u; cutRead.Get(100, out c100b, out c100s, out c100u);
            int b100, s100, u100; lock (nb.Sync) nb.Delta.Get(100, out b100, out s100, out u100);
            Check(hookRan && c100b == b100 && c100u == u100, "delta file (R12 S2): a last line with no newline is not read, though it looks whole");
            Live(after, 1200, 1500);
            ChartBridgeServer.SaveDeltas();
            string afterCut = File.ReadAllText(file);
            Check(!afterCut.Contains("100 2 0 1" + "\n") && afterCut.EndsWith("\n"), "delta file (R12 S2): the cut line is taken off before the next append");
            // R12 B1: a second restart in the session: the file read back is the book, the first run's seconds once (never twice), the
            // second run's the tape's with the late trade
            SortedDictionary<long, long[]> book2 = BookDelta(nb);
            DateTime restart2 = after[1499].T.AddSeconds(60);
            List<Trade> third0 = Walk(restart2, 600, 84, 100);
            simNow = restart2;
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(restart2).AddSeconds(-1));
            RootBook nb2 = ChartBridgeServer.BookOf("MNQ", inst);
            WaitFor(() => { lock (nb2.Sync) return nb2.DeltaReadDone; }, 3000);
            Live(third0, 0, 300);
            ChartBridgeServer.SaveDeltas();
            SortedDictionary<long, long[]> now2 = BookDelta(nb2), read2 = OfTable(DeltaTable.Parse(File.ReadAllText(file), startEt));
            long forming = now2.Keys.Max(); now2.Remove(forming);
            string fileDiff = DiffSec(read2, now2);
            string firstRun = DiffSec(OfTable(back), new SortedDictionary<long, long[]>(BookDelta(nb2).Where(kv => kv.Key <= back.Hi).ToDictionary(kv => kv.Key, kv => kv.Value)));
            // the second run's seconds against the tape (volumes a second), its last second lost at the restart (counted missed)
            Dictionary<long, long> tapeVol = new Dictionary<long, long>();
            foreach (Trade x in after.Take(1500).Concat(new[] { lateOne })) { long k = DeltaTable.SecondOf(EtSec(x.T)) - (long)startEt; long had; tapeVol.TryGetValue(k, out had); tapeVol[k] = had + x.V; }
            long lost = DeltaTable.SecondOf(EtSec(after[1499].T)) - (long)startEt;
            SortedDictionary<long, long[]> all2 = BookDelta(nb2);
            string run2 = null;
            foreach (KeyValuePair<long, long> kv in tapeVol) { if (kv.Key == lost) continue; long[] a; long got = all2.TryGetValue(kv.Key, out a) ? a[0] + a[1] + a[2] : 0; if (got != kv.Value) { run2 = "second " + kv.Key + ": " + got + " against the tape's " + kv.Value; break; } }
            Check(fileDiff == null && firstRun == null && run2 == null,
                "delta file (R12 B1): after a second restart the file reads back as the book, the first run's seconds once, the second run's as the tape (with the trade that came while a pass wrote)" + (fileDiff != null ? "; file: " + fileDiff : "") + (firstRun != null ? "; first run: " + firstRun : "") + (run2 != null ? "; second run: " + run2 : ""));
            // A page live before the file is read back is told: the table comes again, pushed (no sub), in order with its trades.
            simNow = after[1199].T;
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow).AddSeconds(-1));
            ChartBridgeServer.DeltaFiles = false;            // this start reads nothing yet
            RootBook pb = ChartBridgeServer.BookOf("MNQ", inst);
            WaitFor(() => { lock (pb.Sync) return pb.DeltaReadDone; }, 3000);
            List<Trade> third = Walk(after[1199].T.AddSeconds(30), 1500, 83, 100);
            Live(third, 0, 500);
            lock (sent) sent.Clear();
            int m5 = MadeCount();
            SubDelta(client, "806", 0, true);
            AnswerMinutes(m5);
            WaitFor(() => Ready(Sent(), "806"), 3000);
            BarsRequest l5 = Find(m5, r => IsTrades(r) && r.BarsBack == ChartBridgeServer.SeamTicksBack);
            if (l5 != null && !l5.Answered) l5.Answer(Answer(third, 0, 500), ErrorCode.NoError);
            WaitFor(() => Ready(Sent(), "806"));
            ChartBridgeServer.DeltaFiles = true;
            Priv("ReadDelta", pb);                          // the read back lands now, after the page went live
            Live(third, 500, 800);
            Thread.Sleep(80);
            l = Sent();
            int pushed = l.FindLastIndex(x => x.StartsWith("{\"type\":\"deltaTable\"") && !x.Contains("\"sub\":"));
            page = PageDelta(l, "806", startEt); truth = BookDelta(pb);
            diff = page != null ? DiffSec(page, truth) : "none";
            bool joined; lock (pb.Sync) joined = pb.Delta != null && pb.Delta.Restored;
            Check(pushed > l.FindIndex(x => x.StartsWith("{\"type\":\"ready\"") && x.Contains(SubOf("806"))) && joined && diff == null,
                "delta after a restart: a page live before the saved table was read back gets it pushed, and its table plus ticks equals ChartBridge's" + (diff != null ? " (" + diff + ")" : ""));
        }
        finally
        {
            ChartBridgeServer.DeltaFiles = false;
            foreach (string f in Directory.GetFiles(folder, "delta-MNQ-*.txt")) try { File.Delete(f); } catch (Exception) { }
            ChartBridgeServer.ResetBooks(DateTime.MinValue);
        }
    }

    // ------------------------------------------------------------ round 2 (the R12 delta review, second opinion folded in)
    static string D2Folder { get { return ChartBridgeConfig.Folder; } }
    static void D2Clean() { foreach (string f in Directory.GetFiles(D2Folder, "delta-MNQ-*")) try { File.Delete(f); } catch (Exception) { } }
    // A fresh ChartBridge run, listening since before the session (whole), fed `tape` [from, to); its book.
    static RootBook D2Run(List<Trade> tape, int from, int to, DateTime listeningUtc, bool readFile)
    {
        bool was = ChartBridgeServer.DeltaFiles;
        ChartBridgeServer.DeltaFiles = readFile;
        simNow = tape[from].T;
        ChartBridgeServer.ResetBooks(listeningUtc);
        RootBook b = ChartBridgeServer.BookOf("MNQ", inst);
        WaitFor(() => { lock (b.Sync) return b.DeltaReadDone || b.DeltaReadTries > 0; }, 3000);
        ChartBridgeServer.DeltaFiles = was;
        Live(tape, from, to);
        return b;
    }
    static SortedDictionary<long, long[]> D2File(double startEt)
    {
        string f = ChartBridgeServer.DeltaFile("MNQ", startEt);
        DeltaTable t = File.Exists(f) ? DeltaTable.Parse(File.ReadAllText(f), startEt) : null;
        return t != null ? OfTable(t) : null;
    }
    static SortedDictionary<long, long[]> D2Book(RootBook b, bool dropLast)
    {
        SortedDictionary<long, long[]> d = BookDelta(b);
        if (dropLast && d.Count > 0) d.Remove(d.Keys.Max());
        return d;
    }
    static string D2Same(SortedDictionary<long, long[]> file, SortedDictionary<long, long[]> book) { return file == null ? "no file read back" : DiffSec(file, book); }

    static void DeltaRound2()
    {
        DateTime ss, se; SessionClock.Bounds(SimBase, out ss, out se);
        DateTime listening = ChartBridgeTime.ToUtc(ss).AddMinutes(-5);
        double startEt = EtSec(ss);
        ChartBridgeServer.DeltaFiles = true;
        try
        {
            // 1. a partial append: its bytes are cut back off, so the next pass never writes those seconds twice; and when the cut back
            // fails too, the next pass cuts back first
            D2Clean();
            List<Trade> t1 = Walk(SimBase.AddMinutes(-40), 6000, 91, 150);
            RootBook b1 = D2Run(t1, 0, 3000, listening, true);
            ChartBridgeServer.SaveDeltas();
            Live(t1, 3000, 4500);
            int calls = 0;
            ChartBridgeServer.DeltaAppendForHarness = (f, text) => { calls++; File.AppendAllText(f, text.Substring(0, text.Length / 2)); throw new IOException("the disk is full (harness)"); };
            ChartBridgeServer.SaveDeltas();
            ChartBridgeServer.DeltaAppendForHarness = null;
            ChartBridgeServer.SaveDeltas();
            string d1 = D2Same(D2File(startEt), D2Book(b1, true));
            Check(calls == 1 && d1 == null, "delta round 2, item 1: an append that fails half written is cut back off: the file reads back as the book, no second twice" + (d1 != null ? " (" + d1 + ")" : ""));
            Live(t1, 4500, 5200);
            ChartBridgeServer.DeltaAppendForHarness = (f, text) => { File.AppendAllText(f, text.Substring(0, text.Length / 3)); throw new IOException("the disk is full (harness)"); };
            ChartBridgeServer.DeltaCutBackForHarness = (f, len) => { throw new IOException("the file is locked (harness)"); };
            ChartBridgeServer.SaveDeltas();
            ChartBridgeServer.DeltaAppendForHarness = null; ChartBridgeServer.DeltaCutBackForHarness = null;
            ChartBridgeServer.SaveDeltas();
            d1 = D2Same(D2File(startEt), D2Book(b1, true));
            Check(d1 == null, "delta round 2, item 1: when that cut back fails too, the next pass cuts back first: the file reads back as the book" + (d1 != null ? " (" + d1 + ")" : ""));

            // 2. the first write cut inside its header: the file is emptied and the header written again
            D2Clean();
            RootBook b2 = D2Run(t1, 0, 2000, listening, false);   // nothing read (the file is written below, as a crashed first write left it)
            File.WriteAllText(ChartBridgeServer.DeltaFile("MNQ", startEt), "deltatable 1 17906");
            ChartBridgeServer.SaveDeltas();
            string d2 = D2Same(D2File(startEt), D2Book(b2, true));
            Check(d2 == null, "delta round 2, item 2: a first write cut inside its header: emptied, the header written again, the file reads back as the book" + (d2 != null ? " (" + d2 + ")" : ""));

            // 3. the forming second: written at a stop (final) and once the clock is 2 s past it
            D2Clean();
            RootBook b3 = D2Run(t1, 0, 2500, listening, true);
            ChartBridgeServer.SaveDeltas(true);
            string d3 = D2Same(D2File(startEt), D2Book(b3, false));
            Live(t1, 2500, 2800);
            simNow = t1[2799].T.AddSeconds(3);
            ChartBridgeServer.SaveDeltas();
            string d3b = D2Same(D2File(startEt), D2Book(b3, false));
            Check(d3 == null && d3b == null, "delta round 2, item 3: at a stop every second is written, the forming one too; and a pass 2 s after the newest second writes it" + (d3 != null ? " (stop: " + d3 + ")" : "") + (d3b != null ? " (clock: " + d3b + ")" : ""));

            // 5. ChartBridge started in the break with the finished session's table read back; NinjaTrader replays its last trade
            D2Clean();
            DateTime close = Et(2026, 9, 29, 16, 55, 0);
            List<Trade> t5 = Walk(close, 3000, 95, 150);
            t5 = t5.Where(x => x.T < Et(2026, 9, 29, 16, 59, 59)).ToList();
            RootBook b5 = D2Run(t5, 0, t5.Count, listening, true);
            ChartBridgeServer.SaveDeltas(true);
            SortedDictionary<long, long[]> saved5 = D2Book(b5, false);
            simNow = Et(2026, 9, 29, 17, 1, 0);
            ChartBridgeServer.ResetBooks(ChartBridgeTime.ToUtc(simNow).AddSeconds(-30));
            RootBook nb5 = ChartBridgeServer.BookOf("MNQ", inst);
            WaitFor(() => { lock (nb5.Sync) return nb5.DeltaReadDone; }, 3000);
            DeltaTable installed; lock (nb5.Sync) installed = nb5.Delta;
            Trade replay = t5[t5.Count - 1];
            Priv("OnMarketData", null, new MarketDataEventArgs { Instrument = inst, MarketDataType = MarketDataType.Last, Price = replay.P, Volume = replay.V, Time = replay.T });
            DeltaTable after5; lock (nb5.Sync) after5 = nb5.Delta;
            string d5 = installed != null ? DiffSec(OfTable(after5), saved5) : "nothing installed";
            Check(installed != null && ReferenceEquals(after5, installed) && d5 == null,
                "delta round 2, item 5 and R12 N4: started in the break, the finished session's table is installed, and NinjaTrader's replay of its last trade keeps it (not replaced, not counted twice)" + (d5 != null ? " (" + d5 + ")" : ""));
            lock (sent) sent.Clear();
            int m5 = MadeCount();
            SubDelta(client, "905", 0, true);
            AnswerMinutes(m5);
            WaitFor(() => Ready(Sent(), "905"), 3000);
            BarsRequest l5 = Find(m5, r => IsTrades(r) && r.BarsBack == ChartBridgeServer.SeamTicksBack);
            if (l5 != null && !l5.Answered) l5.Answer(new Bars(), ErrorCode.NoError);
            WaitFor(() => Ready(Sent(), "905"));
            SortedDictionary<long, long[]> page5 = PageDelta(Sent(), "905", startEt);
            string p5 = page5 != null ? DiffSec(page5, saved5) : "no table";
            Check(p5 == null, "delta round 2 (R12 N4): a page loading in the break gets the finished session's table" + (p5 != null ? " (" + p5 + ")" : ""));

            // 6. a read error at the start is tried again, never appended past; a file that is not this session's is set aside
            D2Clean();
            RootBook b6a = D2Run(t1, 0, 2000, listening, true);
            ChartBridgeServer.SaveDeltas(true);
            SortedDictionary<long, long[]> saved6 = D2Book(b6a, false);
            int reads = 0;
            ChartBridgeServer.DeltaReadForHarness = f => { if (++reads == 1) throw new IOException("the file is busy (harness)"); return File.ReadAllText(f); };
            RootBook b6 = D2Run(t1, 2600, 3200, listening, true);
            bool notRead; lock (b6.Sync) notRead = !b6.DeltaReadDone;
            ChartBridgeServer.SaveDeltas();
            ChartBridgeServer.DeltaReadForHarness = null;
            bool joined6; lock (b6.Sync) joined6 = b6.Delta != null && b6.Delta.Restored;
            SortedDictionary<long, long[]> book6 = D2Book(b6, false);
            string kept6 = DiffSec(saved6, new SortedDictionary<long, long[]>(book6.Where(kv => kv.Key <= saved6.Keys.Max()).ToDictionary(kv => kv.Key, kv => kv.Value)));
            string d6 = D2Same(D2File(startEt), D2Book(b6, true));
            Check(notRead && reads == 2 && joined6 && kept6 == null && d6 == null,
                "delta round 2, item 6: a read that fails at the start writes nothing, is tried again by the next pass and joined; the file reads back as the book" + (kept6 != null ? " (" + kept6 + ")" : "") + (d6 != null ? " (" + d6 + ")" : ""));
            D2Clean();
            File.WriteAllText(ChartBridgeServer.DeltaFile("MNQ", startEt), "deltatable 1 123 123 -\n5 1 1 0 1\n");   // another session's
            RootBook b6c = D2Run(t1, 0, 1500, listening, true);
            ChartBridgeServer.SaveDeltas(true);
            string d6c = D2Same(D2File(startEt), D2Book(b6c, false));
            Check(File.Exists(ChartBridgeServer.DeltaFile("MNQ", startEt) + ".unread-1") && d6c == null,
                "delta round 2, item 6: a file that is not this session's table is set aside (.unread-1) and a fresh one started, never appended to" + (d6c != null ? " (" + d6c + ")" : ""));

            // 7. a table read back while a page load is in flight: the page gets it pushed once ready
            D2Clean();
            RootBook b7a = D2Run(t1, 0, 2000, listening, true);
            ChartBridgeServer.SaveDeltas(true);
            RootBook b7 = D2Run(t1, 2600, 3000, listening, false);   // its read found nothing (the file is read below, mid-load)
            lock (sent) sent.Clear();
            bool hooked = false;
            ChartBridgeServer.LoadSnapHookForHarness = root => { if (hooked) return; hooked = true; Priv("ReadDelta", b7); };
            int m7 = MadeCount();
            SubDelta(client, "907", 0, true);
            AnswerMinutes(m7);
            WaitFor(() => Ready(Sent(), "907"), 3000);
            BarsRequest l7 = Find(m7, r => IsTrades(r) && r.BarsBack == ChartBridgeServer.SeamTicksBack);
            if (l7 != null && !l7.Answered) l7.Answer(Answer(t1, 2600, 3000), ErrorCode.NoError);
            WaitFor(() => Ready(Sent(), "907"));
            ChartBridgeServer.LoadSnapHookForHarness = null;
            WaitFor(() => Sent().Any(x => x.StartsWith("{\"type\":\"deltaTable\"") && !x.Contains("\"sub\":")), 2000);
            Live(t1, 3000, 3100);
            Thread.Sleep(80);
            SortedDictionary<long, long[]> page7 = PageDelta(Sent(), "907", startEt);
            string p7 = page7 != null ? DiffSec(page7, BookDelta(b7)) : "no table";
            bool pushed7 = Sent().Any(x => x.StartsWith("{\"type\":\"deltaTable\"") && !x.Contains("\"sub\":"));
            Check(hooked && pushed7 && p7 == null, "delta round 2, item 7: a table read back while a page loads is pushed to it once ready; its table plus ticks equals ChartBridge's" + (p7 != null ? " (" + p7 + ")" : ""));

            // 8. a page loading while the feed is down is told the seconds missed so far (rounded up)
            D2Clean();
            RootBook b8 = D2Run(t1, 0, 1000, listening, true);
            double dropAt = EtSec(t1[999].T) + 0.5;
            lock (b8.Sync) b8.FeedDropped(dropAt, "harness");
            simNow = t1[999].T.AddSeconds(30.2);
            lock (sent) sent.Clear();
            int m8 = MadeCount();
            SubDelta(client, "908", 0, true);
            AnswerMinutes(m8);
            WaitFor(() => Ready(Sent(), "908"), 3000);
            BarsRequest l8 = Find(m8, r => IsTrades(r) && r.BarsBack == ChartBridgeServer.SeamTicksBack);
            if (l8 != null && !l8.Answered) l8.Answer(new Bars(), ErrorCode.NoError);
            WaitFor(() => Ready(Sent(), "908"));
            string dm8 = DeltaOf(Sent(), "908");
            double f8, c8, missed8; string w8;
            if (dm8 != null) DecodeDelta(dm8, out f8, out c8, out w8, out missed8); else missed8 = -1;
            Check(missed8 >= 30 && missed8 <= 31, "delta round 2, item 8: a page loading 30 s into a feed drop is told 30 s or more missed, rounded up (" + missed8 + ")");

            // 9. late trades by second, not capped: 30,000 late trades all written; and a finished table let go is said
            D2Clean();
            RootBook b9 = D2Run(t1, 0, 3000, listening, true);
            ChartBridgeServer.SaveDeltas();
            List<Trade> late9 = new List<Trade>(30000);
            Random rnd9 = new Random(9);
            for (int i = 0; i < 30000; i++) { Trade x = t1[rnd9.Next(0, 2900)]; late9.Add(new Trade { T = x.T, P = x.P, V = 1 + rnd9.Next(0, 3) }); }
            Live(late9, 0, late9.Count);
            simNow = t1[2999].T;
            ChartBridgeServer.SaveDeltas();
            string d9 = D2Same(D2File(startEt), D2Book(b9, true));
            Check(d9 == null, "delta round 2, item 9: 30,000 late trades (over the old cap of 20,000) are all written, merged a second each" + (d9 != null ? " (" + d9 + ")" : ""));

            // 10. the missed seconds are written first in a pass (a cut later in it loses the least)
            D2Clean();
            RootBook b10 = D2Run(t1, 0, 1500, listening, true);
            ChartBridgeServer.SaveDeltas();
            lock (b10.Sync) b10.FeedDropped(EtSec(t1[1499].T) + 0.2, "harness");
            Live(t1, 1600, 1700);
            Live(new List<Trade> { new Trade { T = t1[100].T, P = t1[100].P, V = 2 } }, 0, 1);   // a late trade
            simNow = t1[1699].T;
            string before10 = File.ReadAllText(ChartBridgeServer.DeltaFile("MNQ", startEt));
            ChartBridgeServer.SaveDeltas();
            string added10 = File.ReadAllText(ChartBridgeServer.DeltaFile("MNQ", startEt)).Substring(before10.Length);
            string[] lines10 = added10.Split('\n');
            int lateLine = Array.FindIndex(lines10, x => x.StartsWith(((long)(DeltaTable.SecondOf(EtSec(t1[100].T)) - (long)startEt)).ToString(CultureInfo.InvariantCulture) + " "));
            Check(lines10.Length > 3 && lines10[0].StartsWith("m ") && lateLine == 1, "delta round 2, item 10: a pass writes its missed seconds first, then the late trades, then the seconds (" + string.Join(" | ", lines10.Take(3)) + ")");

            // 11. a second's largest trade that is not known stays so (a later small known one never shows as the largest)
            DeltaTable t11 = new DeltaTable { StartEt = startEt };
            t11.Put(10, 4, 0, 0, 0); t11.Put(10, 0, 1, 0, 1);
            int x11, y11, z11, g11; t11.Get(10, out x11, out y11, out z11, out g11);
            string j11 = t11.Snap(startEt + 20).Json("MNQ", null, null);
            Check(g11 == DeltaTable.BigUnknown && j11.Contains("\"rows\":[10,4,1,0]"), "delta round 2, item 11: a second whose largest trade is not known stays not known (sent as 0) after a smaller known one: " + j11.Substring(j11.IndexOf("\"rows\"")));

            // R12 N2: a profile push and a table push to the same page at once: neither skips it (200 rounds)
            D2Clean();
            RootBook bn2 = D2Run(t1, 0, 500, listening, true);
            lock (sent) sent.Clear();
            int mn = MadeCount();
            SubDelta(client, "909", 0, true);
            AnswerMinutes(mn);
            WaitFor(() => Ready(Sent(), "909"), 3000);
            BarsRequest ln = Find(mn, r => IsTrades(r) && r.BarsBack == ChartBridgeServer.SeamTicksBack);
            if (ln != null && !ln.Answered) ln.Answer(new Bars(), ErrorCode.NoError);
            WaitFor(() => Ready(Sent(), "909"));
            int rounds = 200, missedPush = 0;
            for (int r = 0; r < rounds; r++)
            {
                int p0, q0; lock (sent) { p0 = sent.Count(x => x.StartsWith("{\"type\":\"profile\"") && !x.Contains("\"sub\":")); q0 = sent.Count(x => x.StartsWith("{\"type\":\"deltaTable\"") && !x.Contains("\"sub\":")); }
                System.Threading.Tasks.Task a = System.Threading.Tasks.Task.Run(() => Priv("PushProfile", bn2)), bt = System.Threading.Tasks.Task.Run(() => ChartBridgeServer.PushDelta(bn2));
                System.Threading.Tasks.Task.WaitAll(a, bt);
                WaitFor(() => { lock (sent) return sent.Count(x => x.StartsWith("{\"type\":\"profile\"") && !x.Contains("\"sub\":")) > p0 && sent.Count(x => x.StartsWith("{\"type\":\"deltaTable\"") && !x.Contains("\"sub\":")) > q0; }, 200);
                lock (sent) if (!(sent.Count(x => x.StartsWith("{\"type\":\"profile\"") && !x.Contains("\"sub\":")) > p0 && sent.Count(x => x.StartsWith("{\"type\":\"deltaTable\"") && !x.Contains("\"sub\":")) > q0)) missedPush++;
            }
            Check(missedPush == 0, "delta round 2 (R12 N2): a profile push and a table push to one page at the same moment, " + rounds + " times: the page gets both every time (" + missedPush + " skipped)");
        }
        finally
        {
            ChartBridgeServer.DeltaAppendForHarness = null; ChartBridgeServer.DeltaCutBackForHarness = null; ChartBridgeServer.DeltaReadForHarness = null; ChartBridgeServer.LoadSnapHookForHarness = null;
            ChartBridgeServer.DeltaFiles = false;
            D2Clean();
            ChartBridgeServer.ResetBooks(DateTime.MinValue);
        }
    }

    // round 2, item 4 (pure): a feed drop still open at 18:00 counts missed to the session's end
    static void DeltaRound2Pure()
    {
        RootBook b = new RootBook("MNQ", 0.25);
        DateTime listening = ChartBridgeTime.ToUtc(Et(2026, 9, 28, 17, 0, 0));
        FeedSided(b, new[] { new SidedTrade { T = Et(2026, 9, 29, 16, 58, 0), P = 20000, V = 1, S = 1 } }, listening, listening);
        DeltaTable old = b.Delta;
        lock (b.Sync) b.FeedDropped(EtSec(Et(2026, 9, 29, 16, 59, 0)), "harness");
        FeedSided(b, new[] { new SidedTrade { T = Et(2026, 9, 29, 18, 0, 1), P = 20000, V = 1, S = -1 } }, listening, listening);
        Check(b.Delta != old && Math.Abs(old.Missed - 60) < 0.01 && old.MissedUnsaved > 59 && old.DownSinceEt < 0 && b.Delta.Missed == 0,
            "delta round 2, item 4: a feed drop at 16:59 still open at 18:00: the finished session missed 60 s (to 17:00), the new one none (" + old.Missed + ")");
    }
}
