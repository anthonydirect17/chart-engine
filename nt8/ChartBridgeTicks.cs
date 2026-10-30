// ChartBridge: the NQ tick file to The Desk (the Sunday 11-01 build), for NinjaTrader 8.
// Anthony's decisions of 2026-10-29: one NQ tick file per session is the only market data kept; everything is built from it (1
// second bars, 1 minute bars, the evening profile tape, the master day); MNQ trades take their bars from NQ's ticks. This release
// adds; it retires nothing (the 1-minute request, the evening profile export and the 1 second pull stay as they are).
//
// ON with "bars = on" (as the 1 second bars); "tickFile = off" in config.txt turns only it off. "tickFileMaxMB = 2048" bounds the
// ticks folder.
//
// 1. Live capture. Every NQ trade ChartBridge already receives (OnMarketData, after the pages, the tape and the other work, in its
//    own try) is put on a bounded queue: one counter read and one enqueue, never a lock the order lane or the chart feed holds, never
//    a file or a clock read there. A full queue DROPS the trade and counts it (droppedQueue); it never waits. A thread of its own
//    (BelowNormal) writes the queue to ticks/<session>_<contract>.raw, one line a trade ("u,p,v,s,m": UTC ms, price, volume, side,
//    side method), every 250 ms, whole lines only. Over tickFileMaxMB a batch is dropped and counted (droppedDisk).
// 2. Chunks. Another thread (BelowNormal) cuts each raw file every 3 minutes into chunks of at most 20,000 trades (byte ranges noted
//    in <same>.state, so a resend is the same chunk) and posts them to The Desk's POST /api/ticks/chunk (10 s each). The Desk keys a
//    chunk by contract, session, PC, run and seq and ignores one sent again. Chunks go at any hour: they go to The Desk, never to
//    NinjaTrader. NO request goes to NinjaTrader for them.
// 3. The final file. After the close, on the bars worker, in the 1 second bars' window (16:15 to 17:50 New York on weekdays, the
//    weekend while shut; never in trading hours), through the 0.3.5 gate, one tick request per captured session, from the open to
//    the close (NinjaTrader's history), checked against the live capture second by second (TickCheck). The history is the master
//    when the check passes (exact, or filled: history has trades the live capture missed, never fewer). The day goes to POST
//    /api/ticks/day in parts. The raw is deleted only when the check passed and The Desk answers "stored" and "packed" true; a failed
//    day keeps its raw until Anthony rules. Raw files older than 7 days are listed in /diag (tickFile.rawOld).
//
// Only market data and the PC name leave this PC. This file never places, changes or cancels an order and never touches the order
// lane. Written in C# 5 syntax on purpose so it compiles on every NinjaTrader 8 release.

#region Using declarations
using System;
using System.Collections.Concurrent;
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
    // One trade: U its time in UTC ms, P price, V volume, S side (1 buy, -1 sell, 0 none), M the side's method (ChartBridgeSides).
    public struct TickRec
    {
        public long U;
        public double P;
        public long V;
        public int S, M;
        public string Contract;
        public double Tick;
    }

    // The check of a session's live capture against NinjaTrader's history, second by second.
    public class TickCheckResult
    {
        public string Status = "failed";   // "exact", "filled" or "failed"
        public long LiveTicks, LiveVolume, HistTicks, HistVolume, SecondsLiveMissed, TicksLiveMissed, SecondsHistShort, TicksHistShort;
        public readonly List<long[]> Detail = new List<long[]>();   // {second (UTC ms), live trades, history trades}
        public bool Passed { get { return Status == "exact" || Status == "filled"; } }
    }

    public static class TickCheck
    {
        public static int DetailMax = 20;   // seconds listed of each kind

        // Per UTC second: the trades and volume of each. exact: every second the same; filled: history has more in some seconds (the
        // live capture missed them: a disconnect, a late start), never less; failed: live has a trade or volume in a second history
        // lacks, or history has none.
        public static TickCheckResult Compare(IList<TickRec> live, IList<TickRec> hist)
        {
            TickCheckResult r = new TickCheckResult();
            SortedDictionary<long, long[]> by = new SortedDictionary<long, long[]>();   // second -> {live n, live v, hist n, hist v}
            foreach (TickRec x in live) { long[] a = Slot(by, x.U); a[0]++; a[1] += x.V; r.LiveTicks++; r.LiveVolume += x.V; }
            foreach (TickRec x in hist) { long[] a = Slot(by, x.U); a[2]++; a[3] += x.V; r.HistTicks++; r.HistVolume += x.V; }
            int missedListed = 0, shortListed = 0;
            foreach (KeyValuePair<long, long[]> kv in by)
            {
                long[] a = kv.Value;
                if (a[0] > a[2] || a[1] > a[3])
                {
                    r.SecondsHistShort++; r.TicksHistShort += Math.Max(0, a[0] - a[2]);
                    if (shortListed++ < DetailMax) r.Detail.Add(new long[] { kv.Key, a[0], a[2] });
                }
                else if (a[2] > a[0] || a[3] > a[1])
                {
                    r.SecondsLiveMissed++; r.TicksLiveMissed += a[2] - a[0];
                    if (missedListed++ < DetailMax) r.Detail.Add(new long[] { kv.Key, a[0], a[2] });
                }
            }
            if (r.HistTicks == 0 || r.SecondsHistShort > 0) r.Status = "failed";
            else if (r.SecondsLiveMissed > 0) r.Status = "filled";
            else r.Status = "exact";
            r.Detail.Sort((x, y) => x[0].CompareTo(y[0]));
            return r;
        }

        private static long[] Slot(SortedDictionary<long, long[]> by, long u)
        {
            long t = u - ((u % 1000) + 1000) % 1000;
            long[] a;
            if (!by.TryGetValue(t, out a)) { a = new long[4]; by[t] = a; }
            return a;
        }
    }

    // NinjaTrader's trades of one session, read once on its thread (no other copy kept), sides by ChartBridge's rule.
    public class TickDayBuild
    {
        public readonly List<TickRec> Ticks = new List<TickRec>();
        public long BidAsk, TickRule, None, Outside;
        public string QuoteError;
    }

    public static class ChartBridgeTicks
    {
        private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
        public const string Root = "NQ";

        // ---------------------------------------------------------- settings (config.txt)
        private static bool off;
        public static long MaxBytes = 2048L * 1024 * 1024;
        public static bool On { get { return ChartBridgeBars.Enabled && !off; } }
        public static void ResetConfig() { off = false; MaxBytes = 2048L * 1024 * 1024; }
        public static bool ReadConfig(string key, string val)
        {
            string v = (val ?? "").Trim().ToLowerInvariant();
            if (key == "tickFile") { off = v == "off" || v == "false" || v == "0"; return true; }
            if (key == "tickFileMaxMB")
            {
                long mb;
                if (long.TryParse(v, NumberStyles.Integer, Inv, out mb) && mb >= 16) MaxBytes = mb * 1024 * 1024;
                return true;
            }
            return false;
        }

        // ---------------------------------------------------------- timing (fields so the harness can shorten them)
        public static int QueueMax = 200000;
        public static int WriteEveryMs = 250;
        public static int SendEveryMs = 10000;        // the sender looks every 10 s
        public static int ChunkEveryMs = 180000;      // and cuts chunks every 3 minutes
        public static int ChunkMaxTicks = 20000;
        public static int PartMaxTicks = 20000;
        public static int TimeoutMs = 10000;
        public static int FailRetryMs = 60000;
        public static int NoDeskRetryMs = 1800000;
        public static int RawOldDays = 7;
        public static int MaxTries = 3;
        public static int RetryMinutes = 15;

        public static string Folder { get { return Path.Combine(ChartBridgeConfig.Folder, "ticks"); } }
        private static string DaysFile { get { return Path.Combine(Folder, "tickdays.txt"); } }

        // ---------------------------------------------------------- 1. the live capture (hot path)
        private static readonly ConcurrentQueue<TickRec> Queue = new ConcurrentQueue<TickRec>();
        private static int queued;
        private static volatile bool capturing;
        private static long droppedQueue, droppedDisk, outside, written, feedDrops, lostTotal;

        // From OnMarketData for every live trade: NQ only, never blocks (a full queue drops and counts).
        public static void OnTrade(string root, string contract, double tick, double utcMs, double price, long volume, int side, int method)
        {
            if (!capturing || root != Root) return;
            if (Interlocked.Increment(ref queued) > QueueMax)
            {
                Interlocked.Decrement(ref queued);
                Interlocked.Increment(ref droppedQueue); Interlocked.Increment(ref lostTotal);
                return;
            }
            Queue.Enqueue(new TickRec { U = (long)Math.Floor(utcMs), P = price, V = volume, S = side, M = method, Contract = contract, Tick = tick });
        }

        // A feed drop while the market is open (ChartBridgeServer.FeedDropped): the next chunk says the capture may have a hole.
        public static void NoteFeedDrop() { if (capturing) Interlocked.Increment(ref feedDrops); }

        // ---------------------------------------------------------- the files of one session and contract
        private class Cut { public int Seq; public long From, To; public int N; public long Lost, Gaps, BidAsk, TickRule, None; }
        private class KeyFiles
        {
            public string Key, Session, Contract, Raw, State, Run;
            public double Tick = 0.25;
            public long CutTo;
            public readonly List<Cut> Cuts = new List<Cut>();
            public readonly HashSet<int> Sent = new HashSet<int>(), Aside = new HashSet<int>();
        }
        private static readonly object Sync = new object();
        private static readonly Dictionary<string, KeyFiles> Keys = new Dictionary<string, KeyFiles>();
        private static readonly Dictionary<string, string> LastSent = new Dictionary<string, string>();
        private static long diskBytes;

        public static string KeyOf(string session, string contract) { return session + " " + contract; }
        public static string BaseOf(string key)
        {
            StringBuilder b = new StringBuilder();
            foreach (char ch in key) b.Append(char.IsLetterOrDigit(ch) || ch == '-' ? ch : '_');
            return b.ToString();
        }
        private static string NewId() { return Guid.NewGuid().ToString("N").Substring(0, 12); }

        // On the writer's or sender's thread: the key's files, made on the first trade (state: "run <id>", "tick <size>").
        private static KeyFiles FilesOf(string session, string contract, double tick, bool make)
        {
            string key = KeyOf(session, contract);
            lock (Sync)
            {
                KeyFiles k;
                if (Keys.TryGetValue(key, out k)) return k;
                string b = Path.Combine(Folder, BaseOf(key));
                k = new KeyFiles { Key = key, Session = session, Contract = contract, Raw = b + ".raw", State = b + ".state" };
                if (File.Exists(k.State)) ReadState(k);
                else if (make)
                {
                    Directory.CreateDirectory(Folder);
                    k.Run = NewId(); k.Tick = tick > 0 ? tick : 0.25;
                    File.WriteAllLines(k.State, new string[] { "run " + k.Run, "tick " + k.Tick.ToString("R", Inv), "contract " + contract, "session " + session });
                }
                else return null;
                Keys[key] = k;
                return k;
            }
        }

        private static void ReadState(KeyFiles k)
        {
            foreach (string raw in File.ReadAllLines(k.State))
            {
                string[] f = raw.Trim().Split(' ');
                if (f.Length < 2) continue;
                if (f[0] == "run") k.Run = f[1];
                else if (f[0] == "tick") { double t; if (double.TryParse(f[1], NumberStyles.Float, Inv, out t) && t > 0) k.Tick = t; }
                else if (f[0] == "cut" && f.Length >= 11)
                {
                    Cut c = new Cut();
                    c.Seq = int.Parse(f[1], Inv); c.From = long.Parse(f[2], Inv); c.To = long.Parse(f[3], Inv); c.N = int.Parse(f[4], Inv);
                    c.Lost = long.Parse(f[5], Inv); c.Gaps = long.Parse(f[6], Inv); c.BidAsk = long.Parse(f[7], Inv); c.TickRule = long.Parse(f[8], Inv); c.None = long.Parse(f[9], Inv);
                    k.Cuts.Add(c); if (c.To > k.CutTo) k.CutTo = c.To;
                }
                else if (f[0] == "sent") k.Sent.Add(int.Parse(f[1], Inv));
                else if (f[0] == "aside") k.Aside.Add(int.Parse(f[1], Inv));
            }
            if (k.Run == null) k.Run = NewId();
        }

        // ---------------------------------------------------------- the writer
        // One pass: the queue to the raw files, whole lines. Public for the harness.
        public static int WriteOnce()
        {
            List<TickRec> batch = new List<TickRec>();
            TickRec x;
            while (batch.Count < 400000 && Queue.TryDequeue(out x)) { batch.Add(x); Interlocked.Decrement(ref queued); }
            if (batch.Count == 0) return 0;
            if (diskBytes > MaxBytes)
            {
                Interlocked.Add(ref droppedDisk, batch.Count); Interlocked.Add(ref lostTotal, batch.Count);
                error = "the ticks folder is over tickFileMaxMB (" + (MaxBytes / 1048576) + " MB): trades are not written";
                return 0;
            }
            Dictionary<string, StringBuilder> lines = new Dictionary<string, StringBuilder>();
            Dictionary<string, TickRec> firstOf = new Dictionary<string, TickRec>();
            long hourKey = long.MinValue; DateTime hourDate = DateTime.MinValue; string hourSession = null;
            foreach (TickRec r in batch)
            {
                long hk = r.U / 3600000L;   // the session of a trade by its New York hour (a session starts and ends on an hour)
                if (hk != hourKey)
                {
                    hourKey = hk;
                    DateTime et = TimeZoneInfo.ConvertTimeFromUtc(new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(hk * 3600000L), ChartBridgeTime.Eastern);
                    hourDate = ChartBridgeBars.SessionDateOfEt(et);
                    hourSession = hourDate == DateTime.MinValue ? null : hourDate.ToString("yyyy-MM-dd", Inv);
                }
                if (hourSession == null) { Interlocked.Increment(ref outside); continue; }
                string key = KeyOf(hourSession, r.Contract ?? "");
                StringBuilder b;
                if (!lines.TryGetValue(key, out b)) { b = new StringBuilder(); lines[key] = b; firstOf[key] = r; }
                b.Append(r.U.ToString(Inv)).Append(',').Append(r.P.ToString("R", Inv)).Append(',').Append(r.V.ToString(Inv)).Append(',')
                 .Append(r.S.ToString(Inv)).Append(',').Append(r.M.ToString(Inv)).Append('\n');
            }
            int n = 0;
            foreach (KeyValuePair<string, StringBuilder> kv in lines)
            {
                TickRec f = firstOf[kv.Key];
                KeyFiles k = FilesOf(kv.Key.Substring(0, 10), f.Contract ?? "", f.Tick, true);
                byte[] bytes = Encoding.ASCII.GetBytes(kv.Value.ToString());
                using (FileStream fs = new FileStream(k.Raw, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
                    fs.Write(bytes, 0, bytes.Length);
                Interlocked.Add(ref diskBytes, bytes.Length);
                int c = 0; foreach (char ch in kv.Value.ToString()) if (ch == '\n') c++;
                n += c;
            }
            Interlocked.Add(ref written, n);
            return n;
        }

        // ---------------------------------------------------------- 2. chunks
        private static long lostCut, gapsCut;

        // Reads the raw file's bytes [from, to) as trades.
        private static List<TickRec> ReadRange(KeyFiles k, long from, long to)
        {
            List<TickRec> list = new List<TickRec>();
            if (to <= from) return list;
            byte[] buf = new byte[to - from];
            using (FileStream fs = new FileStream(k.Raw, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                fs.Seek(from, SeekOrigin.Begin);
                int got = 0;
                while (got < buf.Length) { int r = fs.Read(buf, got, buf.Length - got); if (r <= 0) break; got += r; }
            }
            foreach (string line in Encoding.ASCII.GetString(buf).Split('\n'))
            {
                TickRec t;
                if (ParseLine(line, k.Contract, out t)) list.Add(t);
            }
            return list;
        }

        public static bool ParseLine(string line, string contract, out TickRec t)
        {
            t = new TickRec();
            string[] f = (line ?? "").Trim().Split(',');
            if (f.Length != 5) return false;
            long u, v; double p; int s, m;
            if (!long.TryParse(f[0], NumberStyles.Integer, Inv, out u) || !double.TryParse(f[1], NumberStyles.Float, Inv, out p) ||
                !long.TryParse(f[2], NumberStyles.Integer, Inv, out v) || !int.TryParse(f[3], NumberStyles.Integer, Inv, out s) ||
                !int.TryParse(f[4], NumberStyles.Integer, Inv, out m)) return false;
            t = new TickRec { U = u, P = p, V = v, S = s, M = m, Contract = contract };
            return true;
        }

        public static List<TickRec> ReadAllLive(string key)
        {
            KeyFiles k;
            lock (Sync) Keys.TryGetValue(key, out k);
            if (k == null || !File.Exists(k.Raw)) return new List<TickRec>();
            return ReadRange(k, 0, new FileInfo(k.Raw).Length);
        }

        // Cuts the bytes after the last cut, to the last whole line, into chunks of at most ChunkMaxTicks. Public for the harness.
        public static int CutOnce()
        {
            List<KeyFiles> keys; lock (Sync) keys = Keys.Values.ToList();
            long lost = Interlocked.Read(ref lostTotal) - lostCut, gaps = Interlocked.Read(ref feedDrops) - gapsCut;
            lostCut += lost; gapsCut += gaps;
            int made = 0;
            foreach (KeyFiles k in keys)
            {
                if (!File.Exists(k.Raw)) continue;
                long len = new FileInfo(k.Raw).Length;
                if (len <= k.CutTo) continue;
                byte[] buf = new byte[len - k.CutTo];
                using (FileStream fs = new FileStream(k.Raw, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    fs.Seek(k.CutTo, SeekOrigin.Begin);
                    int got = 0;
                    while (got < buf.Length) { int r = fs.Read(buf, got, buf.Length - got); if (r <= 0) break; got += r; }
                }
                long baseAt = k.CutTo, pos = baseAt, start = baseAt;   // CutLine moves k.CutTo: the bytes' own start is kept here
                int n = 0; long ba = 0, tr = 0, no = 0;
                List<string> notes = new List<string>();
                for (int i = 0; i < buf.Length; i++)
                {
                    if (buf[i] != (byte)'\n') continue;
                    // the line's method (its last field) for the sides' counts
                    int j = i - 1; while (j >= 0 && buf[j] != (byte)',') j--;
                    char m = j >= 0 && j + 1 < i ? (char)buf[j + 1] : '0';
                    if (m == '1' || m == '2') ba++; else if (m == '3') tr++; else no++;
                    n++;
                    pos = baseAt + i + 1;
                    if (n >= ChunkMaxTicks) { notes.Add(CutLine(k, start, pos, n, lost, gaps, ba, tr, no)); lost = gaps = 0; start = pos; n = 0; ba = tr = no = 0; made++; }
                }
                if (n > 0) { notes.Add(CutLine(k, start, pos, n, lost, gaps, ba, tr, no)); lost = gaps = 0; made++; }
                if (notes.Count > 0) File.AppendAllLines(k.State, notes);
            }
            return made;
        }

        private static string CutLine(KeyFiles k, long from, long to, int n, long lost, long gaps, long ba, long tr, long no)
        {
            Cut c = new Cut { Seq = k.Cuts.Count + 1, From = from, To = to, N = n, Lost = lost, Gaps = gaps, BidAsk = ba, TickRule = tr, None = no };
            lock (Sync) { k.Cuts.Add(c); k.CutTo = to; }
            return "cut " + c.Seq + " " + from + " " + to + " " + n + " " + lost + " " + gaps + " " + ba + " " + tr + " " + no + " .";
        }

        // The chunk's message: the same bytes read again make the same message.
        public static string ChunkJson(string key, int seq)
        {
            KeyFiles k; lock (Sync) Keys.TryGetValue(key, out k);
            if (k == null) return null;
            Cut c = k.Cuts.FirstOrDefault(x => x.Seq == seq);
            if (c == null) return null;
            List<TickRec> t = ReadRange(k, c.From, c.To);
            long vol = 0; foreach (TickRec r in t) vol += r.V;
            StringBuilder b = new StringBuilder(256 + t.Count * 32);
            b.Append("{\"v\":1,\"source\":\"chartbridge\",\"bridge\":").Append(CbJson.Str(ChartBridgeServer.Version))
             .Append(",\"pc\":").Append(CbJson.Str(ChartBridgeBars.PcName()))
             .Append(",\"root\":\"NQ\",\"contract\":").Append(CbJson.Str(k.Contract))
             .Append(",\"tick\":").Append(CbJson.Num(k.Tick))
             .Append(",\"session\":").Append(CbJson.Str(k.Session))
             .Append(",\"run\":").Append(CbJson.Str(k.Run))
             .Append(",\"seq\":").Append(seq.ToString(Inv))
             .Append(",\"count\":").Append(t.Count.ToString(Inv)).Append(",\"volume\":").Append(vol.ToString(Inv))
             .Append(",\"first\":").Append(t.Count > 0 ? t[0].U.ToString(Inv) : "null")
             .Append(",\"last\":").Append(t.Count > 0 ? t[t.Count - 1].U.ToString(Inv) : "null")
             .Append(",\"lost\":").Append(c.Lost.ToString(Inv)).Append(",\"gaps\":").Append(c.Gaps.ToString(Inv))
             .Append(",\"sides\":{\"bidAsk\":").Append(c.BidAsk.ToString(Inv)).Append(",\"tickRule\":").Append(c.TickRule.ToString(Inv)).Append(",\"none\":").Append(c.None.ToString(Inv)).Append('}')
             .Append(",\"cols\":[\"u\",\"p\",\"v\",\"s\"],\"ticks\":[");
            AppendTicks(b, t, 0, t.Count);
            b.Append("]}");
            return b.ToString();
        }

        private static void AppendTicks(StringBuilder b, IList<TickRec> t, int i0, int i1)
        {
            for (int i = i0; i < i1; i++)
            {
                if (i > i0) b.Append(',');
                b.Append('[').Append(t[i].U.ToString(Inv)).Append(',').Append(CbJson.Num(t[i].P)).Append(',').Append(t[i].V.ToString(Inv)).Append(',').Append(t[i].S.ToString(Inv)).Append(']');
            }
        }

        // ---------------------------------------------------------- sending (the sender thread)
        private enum Sent2 { Taken, Refused, NoDesk, Failed, Stopped }
        private static volatile bool deskHasNone;
        private static DateTime retryAt = DateTime.MinValue;
        private static volatile string error = "", lastAnswer = "";
        private static readonly object AbortSync = new object();
        private static int stopGen;
        private static HttpWebRequest inFlight;

        // Posts the chunks not taken yet, oldest key and seq first, until one fails. Public for the harness.
        public static int SendChunks(Func<bool> stopping)
        {
            int gen = Volatile.Read(ref stopGen), sent = 0;
            if (deskHasNone && ChartBridgeBars.UtcNow() < retryAt) return 0;
            List<KeyFiles> keys; lock (Sync) keys = Keys.Values.OrderBy(k => k.Key, StringComparer.Ordinal).ToList();
            foreach (KeyFiles k in keys)
            {
                List<Cut> cuts; lock (Sync) cuts = k.Cuts.Where(c => !k.Sent.Contains(c.Seq) && !k.Aside.Contains(c.Seq)).OrderBy(c => c.Seq).ToList();
                foreach (Cut c in cuts)
                {
                    if (stopping != null && stopping()) return sent;
                    string body = ChunkJson(k.Key, c.Seq);
                    if (body == null) continue;
                    int code; string answer;
                    Sent2 r = Post("/api/ticks/chunk", body, gen, out code, out answer);
                    if (r == Sent2.Stopped) return sent;
                    if (r == Sent2.Taken)
                    {
                        if (deskHasNone) ChartBridgeServer.Log("The Desk is taking the NQ tick file's chunks again.");
                        deskHasNone = false; error = "";
                        lock (Sync) { k.Sent.Add(c.Seq); LastSent[k.Contract] = k.Session + " #" + c.Seq; }
                        File.AppendAllLines(k.State, new string[] { "sent " + c.Seq });
                        sent++;
                        continue;
                    }
                    if (r == Sent2.Refused)
                    {
                        lock (Sync) k.Aside.Add(c.Seq);
                        File.AppendAllLines(k.State, new string[] { "aside " + c.Seq });
                        ChartBridgeServer.Log("The Desk refused tick chunk " + c.Seq + " of " + k.Key + " (" + code + (answer.Length > 0 ? ": " + answer : "") + "); set aside, its trades stay in the raw file and the final pull covers them");
                        continue;
                    }
                    if (r == Sent2.NoDesk)
                    {
                        if (!deskHasNone) ChartBridgeServer.Log("The Desk has no tick file route yet (POST /api/ticks/chunk answered 404): chunks wait on disk and are offered again every " + (NoDeskRetryMs / 60000) + " minutes");
                        deskHasNone = true; retryAt = ChartBridgeBars.UtcNow().AddMilliseconds(NoDeskRetryMs); error = "The Desk has no tick file route (404)";
                    }
                    else error = "chunk not taken: " + answer;
                    return sent;
                }
            }
            return sent;
        }

        private static async Task<WebResponse> PostAsync(HttpWebRequest req, byte[] bytes)
        {
            using (Stream st = await req.GetRequestStreamAsync()) await st.WriteAsync(bytes, 0, bytes.Length);
            return await req.GetResponseAsync();
        }

        private static readonly Regex DetailRx = new Regex("\"detail\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");

        private static Sent2 Post(string path, string body, int gen, out int code, out string answer)
        {
            code = 0; answer = "";
            HttpWebRequest req = null;
            try
            {
                byte[] bytes = Encoding.UTF8.GetBytes(body);
                req = (HttpWebRequest)WebRequest.Create(ChartBridgeConfig.DeskUrl + path);
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Proxy = null;   // never through a proxy (The Desk refuses one)
                lock (AbortSync) { if (stopGen != gen) return Sent2.Stopped; inFlight = req; }
                Task<WebResponse> call = PostAsync(req, bytes);
                if (!call.Wait(TimeoutMs) && !call.IsCompleted)
                {
                    try { req.Abort(); } catch (Exception) { }
                    Task observed = call.ContinueWith(t => { Exception ignored = t.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
                    throw new TimeoutException("The Desk did not answer within " + (TimeoutMs / 1000) + " seconds");
                }
                using (WebResponse res = call.Result)
                using (StreamReader rd = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                    answer = rd.ReadToEnd();
                code = 200;
                lastAnswer = answer.Length > 300 ? answer.Substring(0, 300) : answer;
                return Sent2.Taken;
            }
            catch (Exception ex)
            {
                Exception e = ex is AggregateException && ex.InnerException != null ? ex.InnerException : ex;
                WebException wex = e as WebException;
                HttpWebResponse res = wex != null ? wex.Response as HttpWebResponse : null;
                code = res != null ? (int)res.StatusCode : 0;
                if (code == 400 || code == 413 || code == 422)
                {
                    try { using (StreamReader r = new StreamReader(res.GetResponseStream(), Encoding.UTF8)) { Match m = DetailRx.Match(r.ReadToEnd()); if (m.Success) answer = m.Groups[1].Value.Length > 200 ? m.Groups[1].Value.Substring(0, 200) : m.Groups[1].Value; } } catch (Exception) { }
                    return Sent2.Refused;
                }
                if (Volatile.Read(ref stopGen) != gen) return Sent2.Stopped;
                if (code == 404) return Sent2.NoDesk;
                answer = e.Message;
                return Sent2.Failed;
            }
            finally { lock (AbortSync) { if (inFlight == req) inFlight = null; } }
        }

        // ---------------------------------------------------------- 3. the final file
        // tickdays.txt: one line a day: "<key>\t<check>\t<stored>\t<packed>" (check exact, filled or failed; stored and packed 0 or 1).
        private class DayRec { public string Key, Check; public bool Stored, Packed; }
        private static readonly Dictionary<string, DayRec> Days = new Dictionary<string, DayRec>();
        private static readonly Dictionary<string, DateTime> RetryAtDay = new Dictionary<string, DateTime>();
        private static readonly Dictionary<string, int> TriesDay = new Dictionary<string, int>();
        private static volatile string dayState = "off", lastDay = "";

        private static void LoadDays()
        {
            lock (Sync)
            {
                Days.Clear();
                if (!File.Exists(DaysFile)) return;
                foreach (string raw in File.ReadAllLines(DaysFile))
                {
                    string[] f = raw.Split('\t');
                    if (f.Length != 4) continue;
                    Days[f[0]] = new DayRec { Key = f[0], Check = f[1], Stored = f[2] == "1", Packed = f[3] == "1" };
                }
            }
        }
        private static void SaveDays()
        {
            List<string> lines; lock (Sync) lines = Days.Values.OrderBy(d => d.Key, StringComparer.Ordinal).Select(d => d.Key + "\t" + d.Check + "\t" + (d.Stored ? "1" : "0") + "\t" + (d.Packed ? "1" : "0")).ToList();
            Directory.CreateDirectory(Folder);
            string tmp = DaysFile + ".tmp";
            File.WriteAllLines(tmp, lines.ToArray());
            if (File.Exists(DaysFile)) File.Replace(tmp, DaysFile, null); else File.Move(tmp, DaysFile);
        }

        public static bool IsDayDone(string key) { lock (Sync) return Days.ContainsKey(key); }

        // NinjaTrader's trades of [fromMs, toMs) on its thread: one pass, sides by the stored bid and ask else the tick rule.
        public static object BuildTickDay(Bars bars, long fromMs, long toMs, string contract)
        {
            TickDayBuild d = new TickDayBuild();
            bool quotes = true, hasPrev = false; double prevPrice = 0; int prevSide = 0;
            long hourKey = long.MinValue, offsetTicks = 0;
            long epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).Ticks;
            int n = bars.Count;
            for (int i = 0; i < n; i++)
            {
                DateTime nt = bars.GetTime(i);
                long hk = nt.Ticks / TimeSpan.TicksPerHour;
                if (hk != hourKey) { hourKey = hk; offsetTicks = nt.Ticks - ChartBridgeTime.ToUtc(nt).Ticks; }
                long ms = (nt.Ticks - offsetTicks - epoch) / TimeSpan.TicksPerMillisecond;
                double price = bars.GetClose(i);
                if (ms < fromMs || ms >= toMs || !(price > 0)) { d.Outside++; continue; }
                double bid = double.NaN, ask = double.NaN;
                if (quotes)
                {
                    try { bid = bars.GetBid(i); ask = bars.GetAsk(i); }
                    catch (Exception ex) { quotes = false; bid = double.NaN; ask = double.NaN; d.QuoteError = ex.Message; }
                }
                int method;
                int side = ChartBridgeSides.Classify(price, bid, ask, hasPrev, prevPrice, prevSide, out method);
                if (method == ChartBridgeSides.BidAsk) d.BidAsk++; else if (method == ChartBridgeSides.TickRule) d.TickRule++; else d.None++;
                hasPrev = true; prevPrice = price; prevSide = side;
                d.Ticks.Add(new TickRec { U = ms, P = price, V = bars.GetVolume(i), S = side, M = method, Contract = contract });
            }
            return d;
        }

        // The keys with a raw file whose session has closed and that are not done yet, oldest first.
        public static List<string> DaysToPull(DateTime nowUtc)
        {
            List<string> out1 = new List<string>();
            List<KeyFiles> keys; lock (Sync) keys = Keys.Values.ToList();
            foreach (KeyFiles k in keys.OrderBy(x => x.Key, StringComparer.Ordinal))
            {
                if (IsDayDone(k.Key) || !File.Exists(k.Raw)) continue;
                DateTime s;
                if (!DateTime.TryParseExact(k.Session, "yyyy-MM-dd", Inv, DateTimeStyles.None, out s)) continue;
                DateTime ou, cu; ChartBridgeBars.SessionUtc(s, out ou, out cu);
                if (nowUtc < cu.Add(ChartBridgeBars.CloseDelay)) continue;
                DateTime notBefore;
                lock (Sync)
                {
                    int tries; TriesDay.TryGetValue(k.Key, out tries);
                    if (tries >= MaxTries) continue;
                    if (RetryAtDay.TryGetValue(k.Key, out notBefore) && nowUtc < notBefore) continue;
                }
                out1.Add(k.Key);
            }
            return out1;
        }

        private static void LaterDay(string key, string why)
        {
            int n;
            lock (Sync) { TriesDay.TryGetValue(key, out n); TriesDay[key] = ++n; RetryAtDay[key] = ChartBridgeBars.UtcNow().AddMinutes(RetryMinutes); }
            error = key + ": " + why;
            ChartBridgeServer.Log("the NQ tick file for " + key + ": " + why + (n >= MaxTries ? "; tried " + MaxTries + " times, not asked again until ChartBridge restarts" : "; trying again in " + RetryMinutes + " minutes"));
        }

        // On the bars worker, after the 1-minute and 1 second bars of a pass, and only when those asked nothing this pass: at most one
        // session's final pull, only in the 1 second bars' window. Returns true when it asked NinjaTrader.
        public static bool PlanDay(Func<bool> stopping)
        {
            if (!On) { dayState = "off"; return false; }
            DateTime nowUtc = ChartBridgeBars.UtcNow();
            DateTime nowEt = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(nowUtc, DateTimeKind.Utc), ChartBridgeTime.Eastern);
            if (!ChartBridgeBars.In1sStartWindow(nowEt)) { dayState = "waiting: the final pull goes 16:15 to 17:50 ET on weekdays and on the weekend"; return false; }
            ScanFolder();
            List<string> due = DaysToPull(nowUtc);
            if (due.Count == 0) { dayState = "idle"; return false; }
            string key = due[0];
            KeyFiles k; lock (Sync) k = Keys[key];
            Instrument inst = null;
            try { inst = ChartBridgeBars.Lookup(k.Contract); } catch (Exception) { inst = null; }
            if (inst == null || inst.MasterInstrument == null) { LaterDay(key, "NinjaTrader does not know the instrument"); return false; }
            DateTime session = DateTime.ParseExact(k.Session, "yyyy-MM-dd", Inv);
            DateTime openUtc, closeUtc; ChartBridgeBars.SessionUtc(session, out openUtc, out closeUtc);
            TimeZoneInfo ntZone = NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo;
            DateTime fromNt = TimeZoneInfo.ConvertTimeFromUtc(openUtc, ntZone), toNt = TimeZoneInfo.ConvertTimeFromUtc(closeUtc, ntZone);
            long fromMs = (long)Math.Round(ChartBridgeTime.UtcMs(openUtc)), toMs = (long)Math.Round(ChartBridgeTime.UtcMs(closeUtc));
            BarsTicket t = new BarsTicket();
            string contract = k.Contract;
            string busy = ChartBridgeServer.GateBars("ticks " + key, inst, fromNt, toNt, ChartBridgeBars.Request1sTimeoutMs, stopping, t, bars => BuildTickDay(bars, fromMs, toMs, contract));
            if (busy != null) { dayState = "waiting for the gate: " + busy; return false; }
            dayState = "asking NinjaTrader: ticks " + key;
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            long giveUpMs = (long)ChartBridgeBars.QueueWaitMs + ChartBridgeBars.Request1sTimeoutMs + ChartBridgeServer.AnswerCopyMs + 5000;
            while (!t.Done.Wait(50))
            {
                if (stopping != null && stopping()) { ChartBridgeServer.GateBarsWithdraw(t); return true; }
                if (!t.Started && sw.ElapsedMilliseconds > ChartBridgeBars.QueueWaitMs && ChartBridgeServer.GateBarsWithdraw(t)) { dayState = "waiting for the gate"; return true; }
                if (sw.ElapsedMilliseconds > giveUpMs) { LaterDay(key, "no answer from the gate"); return true; }
            }
            if (t.GateStuck) { dayState = "waiting for the gate: " + t.Error; return true; }
            if (t.Error != null) { LaterDay(key, t.Error); return true; }
            TickDayBuild hist = t.Built as TickDayBuild;
            if (hist == null || hist.Ticks.Count == 0) { LaterDay(key, "NinjaTrader has no trades for it"); return true; }
            if (stopping != null && stopping()) return true;
            FinishDay(k, hist);
            return true;
        }

        // The check, the parts written whole to <key>.day.jsonl, and the record. Public for the harness.
        public static TickCheckResult FinishDay(string key, TickDayBuild hist)
        {
            KeyFiles k; lock (Sync) k = Keys[key];
            return FinishDay(k, hist);
        }

        private static TickCheckResult FinishDay(KeyFiles k, TickDayBuild hist)
        {
            List<TickRec> live = ReadAllLive(k.Key);
            TickCheckResult chk = TickCheck.Compare(live, hist.Ticks);
            long liveLost = 0, liveGaps = 0;
            lock (Sync) foreach (Cut c in k.Cuts) { liveLost += c.Lost; liveGaps += c.Gaps; }
            List<string> parts = DayParts(k, hist, chk, liveLost, liveGaps);
            string file = Path.Combine(Folder, BaseOf(k.Key) + ".day.jsonl");
            string tmp = file + ".tmp";
            File.WriteAllLines(tmp, parts.ToArray());
            if (File.Exists(file)) File.Delete(file);
            File.Move(tmp, file);
            try { File.Delete(Path.Combine(Folder, BaseOf(k.Key) + ".day.sent")); } catch (Exception) { }
            lock (Sync) Days[k.Key] = new DayRec { Key = k.Key, Check = chk.Status, Stored = false, Packed = false };
            SaveDays();
            lastDay = k.Key + ": " + chk.Status + ", live " + chk.LiveTicks + " trades, history " + chk.HistTicks + " (live missed " + chk.TicksLiveMissed + " in " + chk.SecondsLiveMissed +
                      " seconds, history short " + chk.TicksHistShort + " in " + chk.SecondsHistShort + " seconds), " + parts.Count + " parts";
            ChartBridgeServer.Log("the NQ tick file for " + lastDay + (chk.Passed ? "; queued for The Desk" : "; the check FAILED: sent marked failed, the raw file is kept until Anthony rules"));
            dayState = "idle";
            return chk;
        }

        public static List<string> DayParts(string key, TickDayBuild hist, TickCheckResult chk, string set)
        {
            KeyFiles k; lock (Sync) k = Keys[key];
            return DayParts(k, hist, chk, 0, 0, set);
        }

        private static List<string> DayParts(KeyFiles k, TickDayBuild hist, TickCheckResult chk, long liveLost, long liveGaps, string set = null)
        {
            set = set ?? NewId();
            List<TickRec> t = hist.Ticks;
            long vol = 0; foreach (TickRec r in t) vol += r.V;
            string method = hist.BidAsk > 0 && hist.TickRule == 0 ? "bidAsk" : hist.BidAsk == 0 && hist.TickRule > 0 ? "tickRule" : hist.BidAsk > 0 ? "mixed" : "none";
            StringBuilder c = new StringBuilder();
            c.Append("{\"status\":").Append(CbJson.Str(chk.Status))
             .Append(",\"liveTicks\":").Append(chk.LiveTicks).Append(",\"liveVolume\":").Append(chk.LiveVolume)
             .Append(",\"histTicks\":").Append(chk.HistTicks).Append(",\"histVolume\":").Append(chk.HistVolume)
             .Append(",\"secondsLiveMissed\":").Append(chk.SecondsLiveMissed).Append(",\"ticksLiveMissed\":").Append(chk.TicksLiveMissed)
             .Append(",\"secondsHistShort\":").Append(chk.SecondsHistShort).Append(",\"ticksHistShort\":").Append(chk.TicksHistShort)
             .Append(",\"liveLost\":").Append(liveLost).Append(",\"liveGaps\":").Append(liveGaps).Append(",\"detail\":[");
            for (int i = 0; i < chk.Detail.Count; i++)
            {
                if (i > 0) c.Append(',');
                c.Append("{\"t\":").Append(chk.Detail[i][0]).Append(",\"live\":").Append(chk.Detail[i][1]).Append(",\"hist\":").Append(chk.Detail[i][2]).Append('}');
            }
            c.Append("]}");
            int per = Math.Max(1, PartMaxTicks), count = Math.Max(1, (t.Count + per - 1) / per);
            List<string> parts = new List<string>();
            for (int p = 0; p < count; p++)
            {
                StringBuilder b = new StringBuilder(1024 + per * 32);
                b.Append("{\"v\":1,\"source\":\"chartbridge\",\"bridge\":").Append(CbJson.Str(ChartBridgeServer.Version))
                 .Append(",\"pc\":").Append(CbJson.Str(ChartBridgeBars.PcName()))
                 .Append(",\"root\":\"NQ\",\"contract\":").Append(CbJson.Str(k.Contract))
                 .Append(",\"tick\":").Append(CbJson.Num(k.Tick))
                 .Append(",\"session\":").Append(CbJson.Str(k.Session))
                 .Append(",\"set\":").Append(CbJson.Str(set))
                 .Append(",\"part\":").Append((p + 1).ToString(Inv)).Append(",\"parts\":").Append(count.ToString(Inv))
                 .Append(",\"setTicks\":").Append(t.Count.ToString(Inv)).Append(",\"setVolume\":").Append(vol.ToString(Inv))
                 .Append(",\"first\":").Append(t.Count > 0 ? t[0].U.ToString(Inv) : "null")
                 .Append(",\"last\":").Append(t.Count > 0 ? t[t.Count - 1].U.ToString(Inv) : "null")
                 .Append(",\"check\":").Append(c.ToString())
                 .Append(",\"sides\":{\"method\":").Append(CbJson.Str(method)).Append(",\"bidAsk\":").Append(hist.BidAsk.ToString(Inv))
                 .Append(",\"tickRule\":").Append(hist.TickRule.ToString(Inv)).Append(",\"none\":").Append(hist.None.ToString(Inv)).Append('}')
                 .Append(",\"cols\":[\"u\",\"p\",\"v\",\"s\"],\"ticks\":[");
                AppendTicks(b, t, p * per, Math.Min(t.Count, (p + 1) * per));
                b.Append("],\"complete\":true}");
                parts.Add(b.ToString());
            }
            return parts;
        }

        private static readonly Regex StoredRx = new Regex("\"stored\"\\s*:\\s*true"), PackedRx = new Regex("\"packed\"\\s*:\\s*true");

        // Sends the days waiting (their parts in order, from the first not taken), only in the 1 second bars' window. When The Desk
        // answers the last part: stored noted; the raw deleted only when the check passed and the answer says stored and packed.
        public static int SendDays(Func<bool> stopping)
        {
            DateTime nowUtc = ChartBridgeBars.UtcNow();
            if (!ChartBridgeBars.In1sWindow(TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(nowUtc, DateTimeKind.Utc), ChartBridgeTime.Eastern))) return 0;
            if (deskHasNone && nowUtc < retryAt) return 0;
            int gen = Volatile.Read(ref stopGen), sent = 0;
            if (!Directory.Exists(Folder)) return 0;
            foreach (string file in Directory.GetFiles(Folder, "*.day.jsonl").OrderBy(x => x, StringComparer.Ordinal))
            {
                string progress = file.Substring(0, file.Length - ".jsonl".Length) + ".sent";
                List<string> lines = File.ReadAllLines(file).Where(x => x.Trim().Length > 0).ToList();
                int next = File.Exists(progress) ? File.ReadAllLines(progress).Count(x => x.Trim().Length > 0) : 0;
                string key = DayKeyOf(file);
                while (next < lines.Count)
                {
                    if (stopping != null && stopping()) return sent;
                    int code; string answer;
                    Sent2 r = Post("/api/ticks/day", lines[next], gen, out code, out answer);
                    if (r == Sent2.Stopped) return sent;
                    if (r == Sent2.Taken)
                    {
                        deskHasNone = false; error = "";
                        next++; sent++;
                        File.AppendAllText(progress, next.ToString(Inv) + Environment.NewLine);
                        if (next >= lines.Count) DayTaken(key, file, progress, StoredRx.IsMatch(answer), PackedRx.IsMatch(answer));
                        continue;
                    }
                    if (r == Sent2.Refused)
                    {
                        ChartBridgeServer.Log("The Desk refused part " + (next + 1) + " of the NQ tick file for " + key + " (" + code + (answer.Length > 0 ? ": " + answer : "") + "); the day is set aside (" + Path.GetFileName(file) + ".refused), the raw file is kept");
                        try { File.Move(file, file + ".refused"); File.Delete(progress); } catch (Exception) { }
                        break;
                    }
                    if (r == Sent2.NoDesk) { deskHasNone = true; retryAt = nowUtc.AddMilliseconds(NoDeskRetryMs); error = "The Desk has no tick file route (404)"; }
                    else error = "day part not taken: " + answer;
                    return sent;
                }
            }
            return sent;
        }

        private static string DayKeyOf(string file)
        {
            string b = Path.GetFileName(file);
            b = b.Substring(0, b.Length - ".day.jsonl".Length);
            lock (Sync) foreach (KeyFiles k in Keys.Values) if (BaseOf(k.Key) == b) return k.Key;
            return b;
        }

        private static void DayTaken(string key, string file, string progress, bool stored, bool packed)
        {
            DayRec d;
            lock (Sync) { if (!Days.TryGetValue(key, out d)) { d = new DayRec { Key = key, Check = "failed" }; Days[key] = d; } d.Stored = stored; d.Packed = packed; }
            SaveDays();
            try { File.Delete(file); File.Delete(progress); } catch (Exception) { }
            bool passed = d.Check == "exact" || d.Check == "filled";
            if (stored && packed && passed)
            {
                KeyFiles k; lock (Sync) { Keys.TryGetValue(key, out k); Keys.Remove(key); }
                if (k != null)
                {
                    long size = File.Exists(k.Raw) ? new FileInfo(k.Raw).Length : 0;
                    try { File.Delete(k.Raw); File.Delete(k.State); Interlocked.Add(ref diskBytes, -size); } catch (Exception ex) { ChartBridgeServer.Log("could not delete the raw ticks of " + key + ": " + ex.Message); }
                }
                ChartBridgeServer.Log("The Desk stored and packed the NQ tick file for " + key + "; the raw file is deleted");
            }
            else ChartBridgeServer.Log("The Desk " + (stored ? "stored" : "took") + " the NQ tick file for " + key + "; the raw file is kept (" + (!passed ? "the check failed: until Anthony rules" : !packed ? "not packed yet" : "not stored") + ")");
        }

        // ---------------------------------------------------------- the folder (the sender thread and the bars worker)
        private static void ScanFolder()
        {
            if (!Directory.Exists(Folder)) return;
            foreach (string st in Directory.GetFiles(Folder, "*.state"))
            {
                string name = Path.GetFileNameWithoutExtension(st);
                bool known; lock (Sync) known = Keys.Values.Any(k => BaseOf(k.Key) == name);
                if (known) continue;
                string session = null, contract = null;
                foreach (string raw in File.ReadAllLines(st))
                {
                    if (raw.StartsWith("session ", StringComparison.Ordinal)) session = raw.Substring(8).Trim();
                    else if (raw.StartsWith("contract ", StringComparison.Ordinal)) contract = raw.Substring(9).Trim();
                }
                if (session != null && contract != null) FilesOf(session, contract, 0, false);
            }
        }

        private static long FolderBytes()
        {
            long n = 0;
            try { if (Directory.Exists(Folder)) foreach (string f in Directory.GetFiles(Folder)) n += new FileInfo(f).Length; } catch (Exception) { }
            return n;
        }

        // ---------------------------------------------------------- the threads
        private static readonly object Gate = new object();
        private static ManualResetEvent stopEvent;
        private static Thread writer, sender;
        private static int generation;

        public static void Start()
        {
            Stop();
            lock (Gate)
            {
                Interlocked.Exchange(ref droppedQueue, 0); Interlocked.Exchange(ref droppedDisk, 0); Interlocked.Exchange(ref outside, 0);
                Interlocked.Exchange(ref written, 0); Interlocked.Exchange(ref feedDrops, 0); Interlocked.Exchange(ref lostTotal, 0);
                lostCut = 0; gapsCut = 0; error = ""; lastDay = ""; deskHasNone = false; retryAt = DateTime.MinValue;
                lock (Sync) { Keys.Clear(); LastSent.Clear(); RetryAtDay.Clear(); TriesDay.Clear(); }
                if (!On) { dayState = "off"; return; }
                dayState = "starting";
                ManualResetEvent stop = new ManualResetEvent(false);
                stopEvent = stop;
                int gen = ++generation;
                capturing = true;
                writer = new Thread(() => WriterLoop(gen, stop)) { IsBackground = true, Priority = ThreadPriority.BelowNormal, Name = "ChartBridge tick file" };
                sender = new Thread(() => SenderLoop(gen, stop)) { IsBackground = true, Priority = ThreadPriority.BelowNormal, Name = "ChartBridge tick chunks" };
                writer.Start(); sender.Start();
            }
        }

        public static void Stop()
        {
            Thread w, s;
            lock (Gate)
            {
                capturing = false;
                generation++;
                try { if (stopEvent != null) stopEvent.Set(); } catch (Exception) { }
                stopEvent = null;
                w = writer; s = sender; writer = null; sender = null;
            }
            lock (AbortSync) { stopGen++; try { if (inFlight != null) inFlight.Abort(); } catch (Exception) { } }
            foreach (Thread t in new Thread[] { w, s })
                try { if (t != null && t != Thread.CurrentThread) t.Join(250); } catch (Exception) { }
        }

        private static bool Stopping(int gen, ManualResetEvent stop) { return gen != Volatile.Read(ref generation) || stop.WaitOne(0); }

        private static void WriterLoop(int gen, ManualResetEvent stop)
        {
            try { Directory.CreateDirectory(Folder); Interlocked.Exchange(ref diskBytes, FolderBytes()); } catch (Exception ex) { error = "the ticks folder: " + ex.Message; }
            while (true)
            {
                bool last = stop.WaitOne(WriteEveryMs) || gen != Volatile.Read(ref generation);
                try { WriteOnce(); } catch (Exception ex) { error = "tick file write error: " + ex.Message; CbLogLimit.Error("tick file write error", ex); }
                if (last) return;   // the stop: what was queued is written once more, then nothing
            }
        }

        private static void SenderLoop(int gen, ManualResetEvent stop)
        {
            Func<bool> stopping = () => Stopping(gen, stop);
            try { ScanFolder(); LoadDays(); } catch (Exception ex) { error = "the ticks folder could not be read: " + ex.Message; }
            System.Diagnostics.Stopwatch since = System.Diagnostics.Stopwatch.StartNew();
            long lastCut = 0;
            while (!stop.WaitOne(SendEveryMs))
            {
                if (stopping()) return;
                try
                {
                    if (since.ElapsedMilliseconds - lastCut >= ChunkEveryMs) { lastCut = since.ElapsedMilliseconds; ScanFolder(); CutOnce(); }
                    SendChunks(stopping);
                    SendDays(stopping);
                }
                catch (Exception ex) { error = "tick file send error: " + ex.Message; CbLogLimit.Error("tick file send error", ex); }
            }
        }

        // ---------------------------------------------------------- /diag "tickFile"
        public static string DiagJson()
        {
            StringBuilder b = new StringBuilder();
            DateTime now = ChartBridgeBars.UtcNow().Date;
            b.Append("{\"on\":").Append(On ? "true" : "false")
             .Append(",\"capturing\":").Append(capturing ? "true" : "false")
             .Append(",\"queue\":").Append(Volatile.Read(ref queued)).Append(",\"queueMax\":").Append(QueueMax)
             .Append(",\"droppedQueue\":").Append(Interlocked.Read(ref droppedQueue)).Append(",\"droppedDisk\":").Append(Interlocked.Read(ref droppedDisk))
             .Append(",\"outside\":").Append(Interlocked.Read(ref outside)).Append(",\"written\":").Append(Interlocked.Read(ref written))
             .Append(",\"feedDrops\":").Append(Interlocked.Read(ref feedDrops))
             .Append(",\"diskMB\":").Append(CbJson.Num(Math.Round(Interlocked.Read(ref diskBytes) / 1048576.0, 1))).Append(",\"maxMB\":").Append(MaxBytes / 1048576)
             .Append(",\"files\":{");
            List<KeyFiles> keys; lock (Sync) keys = Keys.Values.OrderBy(k => k.Key, StringComparer.Ordinal).ToList();
            List<string> old = new List<string>();
            bool first = true;
            foreach (KeyFiles k in keys)
            {
                long size = 0; try { if (File.Exists(k.Raw)) size = new FileInfo(k.Raw).Length; } catch (Exception) { }
                DateTime s; int age = DateTime.TryParseExact(k.Session, "yyyy-MM-dd", Inv, DateTimeStyles.None, out s) ? (int)(now - s.Date).TotalDays : 0;
                if (age > RawOldDays && File.Exists(k.Raw)) old.Add(k.Key);
                int cuts, sent, aside; lock (Sync) { cuts = k.Cuts.Count; sent = k.Sent.Count; aside = k.Aside.Count; }
                if (!first) b.Append(','); first = false;
                b.Append(CbJson.Str(k.Key)).Append(":{\"bytes\":").Append(size).Append(",\"chunks\":").Append(cuts).Append(",\"sent\":").Append(sent)
                 .Append(",\"aside\":").Append(aside).Append(",\"ageDays\":").Append(age).Append('}');
            }
            b.Append("},\"lastSent\":{");
            lock (Sync) b.Append(string.Join(",", LastSent.OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => CbJson.Str(kv.Key) + ":" + CbJson.Str(kv.Value)).ToArray()));
            b.Append("},\"days\":{");
            lock (Sync) b.Append(string.Join(",", Days.Values.OrderBy(d => d.Key, StringComparer.Ordinal).Select(d => CbJson.Str(d.Key) + ":{\"check\":" + CbJson.Str(d.Check) + ",\"stored\":" + (d.Stored ? "true" : "false") + ",\"packed\":" + (d.Packed ? "true" : "false") + "}").ToArray()));
            b.Append("},\"rawOld\":[").Append(string.Join(",", old.Select(x => CbJson.Str(x)).ToArray())).Append(']')
             .Append(",\"rawOldNote\":").Append(old.Count > 0 ? CbJson.Str(old.Count + " raw file(s) older than " + RawOldDays + " days: a raw file is deleted only after its day is packed and stored at The Desk") : "null")
             .Append(",\"dayState\":").Append(CbJson.Str(dayState ?? ""))
             .Append(",\"lastDay\":").Append(CbJson.Str(lastDay ?? ""))
             .Append(",\"deskHasNoTicks\":").Append(deskHasNone ? "true" : "false")
             .Append(",\"lastError\":").Append(CbJson.Str(error ?? "")).Append('}');
            return b.ToString();
        }
    }
}
