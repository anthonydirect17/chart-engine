// ChartBridge 0.3.2 for NinjaTrader 8
// Streams live market data and your fills from NinjaTrader to the chart-engine live page.
// Serves the page at http://localhost:8765/ and a WebSocket at ws://localhost:8765/ws (this PC only:
// every request must come from a loopback address, and a browser WebSocket from an allowed origin).
// ChartBridge's own page is locked with a 4-digit PIN (ChartBridgePin.cs): nothing streams to it and it cannot
// sign in for orders until it is unlocked.
// READ ONLY by default. Order entry from the chart (Step 2) lives only in ChartBridgeOrders.cs and stays
// off unless config.txt has "trading = true" and names the accounts in "tradeAccounts"; this file never
// places, changes or cancels an order itself.
// Protocol: nt8/PROTOCOL.md in https://github.com/anthonydirect17/chart-engine (MIT).
//
// Install: copy this file, ChartBridgeOrders.cs and ChartBridgePin.cs to Documents\NinjaTrader 8\bin\Custom\AddOns\ and the page files to
// Documents\NinjaTrader 8\ChartBridge\www\ (nt8\install.ps1 does both), then compile in the
// NinjaScript Editor. Output from the add-on appears in the Output window (New > NinjaScript Output).
//
// Written in C# 5 syntax on purpose so it compiles on every NinjaTrader 8 release.

#region Using declarations
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    public class ChartBridge : AddOnBase
    {
        private bool startedHere;

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Name = "ChartBridge";
                Description = "Streams live data and fills to the chart-engine live page at http://localhost:8765/ (this PC only; read only unless order entry is turned on in config.txt).";
            }
            else if (State == State.Configure || State == State.Active)
            {
                if (!startedHere) startedHere = ChartBridgeServer.Start();
            }
            else if (State == State.Terminated)
            {
                if (startedHere) { ChartBridgeServer.Stop(); startedHere = false; }
            }
        }
    }

    // ------------------------------------------------------------------ settings
    public static class ChartBridgeConfig
    {
        public static int Port = 8765;
        public static string[] Roots = new string[] { "MNQ", "NQ", "MES", "ES" };
        public static int DefaultDays = 5;
        public static int DefaultTickHours = 8;
        public static Dictionary<string, string> ContractOverride = new Dictionary<string, string>();
        public static bool PostFills = false;                       // send fills to The Desk
        public static string DeskUrl = "http://localhost:8800";
        public static List<string> AccountAllow = new List<string>();   // empty = every account except Backtest / Playback
        public static List<string> AllowOrigins = new List<string>();   // web pages besides ChartBridge's own that may open the read-only WebSocket

        public static bool AccountAllowed(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            if (name.StartsWith("Backtest", StringComparison.OrdinalIgnoreCase) || name.StartsWith("Playback", StringComparison.OrdinalIgnoreCase)) return false;
            if (ChartBridgeOrders.AccountTradable(name)) return true;      // accounts the chart may trade are always watched
            if (AccountAllow.Count == 0) return true;
            foreach (string pat in AccountAllow)
            {
                if (pat.EndsWith("*") ? name.StartsWith(pat.TrimEnd('*'), StringComparison.OrdinalIgnoreCase) : name.Equals(pat, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        public static string Folder
        {
            get { return Path.Combine(NinjaTrader.Core.Globals.UserDataDir, "ChartBridge"); }
        }
        public static string WwwFolder { get { return Path.Combine(Folder, "www"); } }

        // Optional Documents\NinjaTrader 8\ChartBridge\config.txt, one "key = value" per line:
        //   port = 8765
        //   roots = MNQ, NQ, MES, ES
        //   days = 5
        //   tickHours = 8
        //   contract.MNQ = MNQ 12-26      (forces a contract instead of the computed front month)
        //   postFills = true              (send every fill to The Desk; off by default)
        //   deskUrl = http://localhost:8800
        //   accounts = Sim101, EVAL*       (only these accounts' fills; * matches a prefix; default all,
        //                                   Backtest and Playback accounts are always skipped)
        //   trading = true                (order entry from the chart; OFF by default; see ChartBridgeOrders.cs)
        //   tradeAccounts = Sim101, ...   (exact account names the chart may trade; no wildcard)
        //   maxQty.MNQ = 5                (largest order per instrument root; default 1)
        //   allowOrigins = https://desk.example.com, http://100.88.192.33:8800
        //                                 (web pages besides ChartBridge's own that may open the read-only
        //                                  WebSocket, such as The Desk; exact scheme://host[:port], no wildcard;
        //                                  they can never trade. Requests still have to come from this PC.
        //                                  One line: the last allowOrigins line wins. Non-ASCII hosts in punycode.)
        public static void Load()
        {
            ChartBridgeOrders.ResetConfig();
            AllowOrigins = new List<string>();
            string file = Path.Combine(Folder, "config.txt");
            if (!File.Exists(file)) return;
            foreach (string raw in File.ReadAllLines(file))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line.StartsWith("#")) continue;
                int eq = line.IndexOf('=');
                if (eq < 0) continue;
                string key = line.Substring(0, eq).Trim();
                string val = line.Substring(eq + 1).Trim();
                int n;
                if (key == "port" && int.TryParse(val, out n)) Port = n;
                else if (key == "days" && int.TryParse(val, out n)) DefaultDays = Math.Max(1, Math.Min(60, n));
                else if (key == "tickHours" && int.TryParse(val, out n)) DefaultTickHours = Math.Max(0, Math.Min(48, n));
                else if (key == "roots") Roots = val.Split(',').Select(s => s.Trim().ToUpperInvariant()).Where(s => s.Length > 0).ToArray();
                else if (key.StartsWith("contract.")) ContractOverride[key.Substring(9).Trim().ToUpperInvariant()] = val;
                else if (key == "postFills") PostFills = val.Equals("true", StringComparison.OrdinalIgnoreCase) || val == "1";
                else if (key == "deskUrl") DeskUrl = val.TrimEnd('/');
                else if (key == "accounts") AccountAllow = val.Split(',').Select(x => x.Trim()).Where(x => x.Length > 0).ToList();
                else if (key == "allowOrigins") AllowOrigins = ChartBridgeAccess.ParseOrigins(val);
                else ChartBridgeOrders.ReadConfig(key, val);   // trading, tradeAccounts, maxQty.<ROOT>
            }
        }
    }

    // ------------------------------------------------------------------ who may connect
    // HTTP.sys (the Windows web server under HttpListener) listens on every network interface and matches
    // only the Host header, so the prefix http://localhost:8765/ alone does not keep other devices out: on
    // the trading PC (2026-09-29) a request to the Wi-Fi or Tailscale address with "Host: localhost:8765"
    // was answered. So every request, on every path, is checked first, before any routing: it must come
    // from this PC (a loopback source address), or it gets 403. A Windows firewall rule blocking inbound
    // 8765 is still recommended as a second layer; safety does not rest on it.
    // A browser WebSocket must also come from ChartBridge's own page or an origin listed in allowOrigins,
    // so another web site open in the browser cannot read accounts, fills and ticks. A connection with no
    // Origin header is not a browser (a local program such as The Desk's relay) and is allowed: the
    // address check already limits it to this PC. Placing orders needs more (ChartBridgeOrders.cs, gate 4).
    // Neither rule guards against software on this PC (it can connect from 127.0.0.1 and send any Origin), and
    // a proxy, tunnel or port forward pointed at this port (cloudflared, tailscale serve or funnel, netsh
    // portproxy, ssh -R) makes its remote clients arrive as 127.0.0.1: never point one at ChartBridge.
    public static class ChartBridgeAccess
    {
        public const double RefusalLogEveryMs = 3600000;   // one Output line per address (or origin) per hour
        public const int MaxRemembered = 1000;                 // per budget: addresses and origins are counted apart
        public const int LogSkip = 0, LogLine = 1, LogBudgetFull = 2;
        private static readonly RefusalBudget AddressLog = new RefusalBudget(), OriginLog = new RefusalBudget();
        private static readonly Regex OriginRx = new Regex("^https?://(\\[[0-9a-f:.]+\\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?)(:[0-9]{1,5})?\\z");
        private static long refusedAddress, refusedOrigin;

        public static string OwnOrigin { get { return "http://localhost:" + ChartBridgeConfig.Port.ToString(CultureInfo.InvariantCulture); } }

        // True only for a loopback source: 127.0.0.0/8, ::1, or 127.x mapped into IPv6 (::ffff:127.0.0.1).
        // Anything missing or unreadable is not loopback.
        public static bool IsLoopback(IPEndPoint remote) { return remote != null && IsLoopback(remote.Address); }

        public static bool IsLoopback(IPAddress a)
        {
            if (a == null) return false;
            try
            {
                if (a.AddressFamily == AddressFamily.InterNetworkV6 && a.IsIPv4MappedToIPv6) a = a.MapToIPv4();
                if (a.AddressFamily == AddressFamily.InterNetwork) return IPAddress.IsLoopback(a);
                if (a.AddressFamily != AddressFamily.InterNetworkV6) return false;
                byte[] b = a.GetAddressBytes();   // ::1 whatever its scope id
                if (b.Length != 16 || b[15] != 1) return false;
                for (int i = 0; i < 15; i++) if (b[i] != 0) return false;
                return true;
            }
            catch (Exception) { return false; }
        }

        // The read-only WebSocket. origin is the Origin header, null when there is none.
        public static bool WsOriginAllowed(string origin)
        {
            if (origin == null) return true;                  // not a browser; the address check still applies
            string o = origin.Trim().ToLowerInvariant();
            if (o.Length == 0 || o == "null") return false;   // sandboxed frames, file:// pages and the like
            if (o == OwnOrigin) return true;
            List<string> list = ChartBridgeConfig.AllowOrigins;
            return list != null && list.Contains(o);
        }

        // allowOrigins = a, b, c: each an exact scheme://host[:port] (http or https), lower-cased; a default
        // port (:80 for http, :443 for https) and one trailing slash are dropped, as a browser's Origin has
        // neither. Anything else (a path, a wildcard, "null") is skipped with a line in the Output window.
        public static List<string> ParseOrigins(string val)
        {
            List<string> list = new List<string>();
            foreach (string raw in (val ?? "").Split(','))
            {
                string o = raw.Trim().ToLowerInvariant();
                if (o.Length == 0) continue;
                if (o.EndsWith("/")) o = o.Substring(0, o.Length - 1);
                if (o.StartsWith("http://") && o.EndsWith(":80")) o = o.Substring(0, o.Length - 3);
                else if (o.StartsWith("https://") && o.EndsWith(":443")) o = o.Substring(0, o.Length - 4);
                if (!OriginRx.IsMatch(o)) { ChartBridgeServer.Log("allowOrigins: skipped " + Clean(raw.Trim()) + " (must be scheme://host[:port], no path, no wildcard)"); continue; }
                if (!list.Contains(o)) list.Add(o);
            }
            return list;
        }

        // Log a refusal at most once an hour per key (a remote address, or an origin), so a scan cannot flood the
        // Output window. Each budget remembers at most MaxRemembered keys an hour; when it is full, one line says
        // further refusals are not logged this hour (they are still refused and counted in /diag). Addresses and
        // origins have separate budgets, so a web page making up origins cannot silence the address log.
        private class RefusalBudget
        {
            private readonly Dictionary<string, double> last = new Dictionary<string, double>();
            private double fullNotedMs = double.NegativeInfinity;

            public int Decide(string key, double nowMs)
            {
                lock (last)
                {
                    double was;
                    if (last.TryGetValue(key, out was) && nowMs - was < RefusalLogEveryMs) return LogSkip;
                    if (!last.ContainsKey(key) && last.Count >= MaxRemembered)
                    {
                        foreach (string k in last.Where(kv => nowMs - kv.Value >= RefusalLogEveryMs).Select(kv => kv.Key).ToList()) last.Remove(k);
                        if (last.Count >= MaxRemembered)
                        {
                            if (nowMs - fullNotedMs < RefusalLogEveryMs) return LogSkip;
                            fullNotedMs = nowMs;
                            return LogBudgetFull;
                        }
                    }
                    last[key] = nowMs;
                    return LogLine;
                }
            }
        }

        public static int AddressLogDecision(string address, double nowMs) { return AddressLog.Decide(address, nowMs); }
        public static int OriginLogDecision(string origin, double nowMs) { return OriginLog.Decide(origin, nowMs); }

        public static void NoteRefusedAddress(IPEndPoint remote, string path)
        {
            Interlocked.Increment(ref refusedAddress);
            string who = remote != null && remote.Address != null ? remote.Address.ToString() : "(unknown address)";
            int d = AddressLogDecision(who, ChartBridgeTime.NowUtcMs());
            if (d == LogLine)
                ChartBridgeServer.Log("refused a request from " + Clean(who) + " for " + Clean(path) + ": only this PC may connect (403; logged once an hour per address)");
            else if (d == LogBudgetFull)
                ChartBridgeServer.Log("refused requests from over " + MaxRemembered + " addresses this hour; further refusals from new addresses are not logged this hour (still refused; counted in /diag)");
        }

        public static void NoteRefusedOrigin(string origin)
        {
            Interlocked.Increment(ref refusedOrigin);
            string o = origin ?? "";
            int d = OriginLogDecision(o, ChartBridgeTime.NowUtcMs());
            if (d == LogLine)
                ChartBridgeServer.Log("refused a WebSocket from the web page " + Clean(o) + ": not ChartBridge's page and not in allowOrigins in config.txt (403; logged once an hour per origin)");
            else if (d == LogBudgetFull)
                ChartBridgeServer.Log("refused WebSockets from over " + MaxRemembered + " web page origins this hour; further refusals from new origins are not logged this hour (still refused; counted in /diag)");
        }

        // For the Output window: printable characters only, and not too long.
        private static string Clean(string s)
        {
            if (s == null) return "";
            StringBuilder b = new StringBuilder();
            foreach (char ch in s) { if (b.Length >= 120) { b.Append("..."); break; } b.Append(ch < 0x20 || ch == 0x7f ? '?' : ch); }
            return b.ToString();
        }

        // For /diag (not secret): who may connect, and how many were refused since the start.
        public static string DiagJson()
        {
            StringBuilder b = new StringBuilder("{\"loopbackOnly\":true,\"allowOrigins\":[");
            b.Append(CbJson.Str(OwnOrigin));
            List<string> list = ChartBridgeConfig.AllowOrigins ?? new List<string>();
            foreach (string o in list) b.Append(',').Append(CbJson.Str(o));
            b.Append("],\"refusedNotThisPc\":").Append(Interlocked.Read(ref refusedAddress));
            b.Append(",\"refusedOrigin\":").Append(Interlocked.Read(ref refusedOrigin)).Append('}');
            return b.ToString();
        }
    }

    // ------------------------------------------------------------------ time helpers
    public static class ChartBridgeTime
    {
        private static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        private static TimeZoneInfo et;
        private static readonly Stopwatch Clock = Stopwatch.StartNew();
        private static readonly object ClockSync = new object();
        private static double anchorMs = (DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        private static double lastCheckMs;
        private const double RecheckEveryMs = 5000, StepIfOffByMs = 50;

        public static TimeZoneInfo Eastern
        {
            get
            {
                if (et == null) et = TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time");
                return et;
            }
        }

        // NinjaTrader reports times in the time zone set under Tools > Options > General.
        public static DateTime ToUtc(DateTime ntTime)
        {
            DateTime t = DateTime.SpecifyKind(ntTime, DateTimeKind.Unspecified);
            TimeZoneInfo tz = NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo;
            try { return TimeZoneInfo.ConvertTimeToUtc(t, tz); }
            catch (ArgumentException) { return DateTime.SpecifyKind(t - tz.BaseUtcOffset, DateTimeKind.Utc); }   // inside a DST gap
        }

        public static double UtcMs(DateTime utc) { return (utc - Epoch).TotalMilliseconds; }

        // Exchange (New York) wall clock, as seconds since 1970 read as if UTC.
        public static double EtSeconds(DateTime utc)
        {
            DateTime e = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), Eastern);
            return (DateTime.SpecifyKind(e, DateTimeKind.Utc) - Epoch).TotalSeconds;
        }

        // Millisecond-resolution "now" (DateTime.UtcNow alone can be coarse on .NET Framework): the PC
        // clock read once, plus a stopwatch. Every 5 seconds it is compared with the PC clock again and
        // re-anchored if they differ by more than 50 ms, so a clock fix while NinjaTrader runs (HOME,
        // 2026-09-29: the PC was 0.57 s off until Windows time sync was turned on) is picked up.
        public static double NowUtcMs()
        {
            double now, stepped = 0;
            lock (ClockSync)
            {
                double elapsed = Clock.Elapsed.TotalMilliseconds;
                now = anchorMs + elapsed;
                if (elapsed - lastCheckMs >= RecheckEveryMs)
                {
                    lastCheckMs = elapsed;
                    double wall = UtcMs(DateTime.UtcNow);
                    double off = wall - now;
                    if (Math.Abs(off) > StepIfOffByMs) { anchorMs += off; now = wall; stepped = off; }
                }
            }
            // Log outside the lock; small steps (stopwatch drift) are not worth a line.
            if (Math.Abs(stepped) > 250) ChartBridgeServer.Log("PC clock changed by " + Math.Round(stepped).ToString(CultureInfo.InvariantCulture) + " ms; ChartBridge follows it.");
            return now;
        }

        public static DateTime NowEastern() { return TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, Eastern); }
    }

    // ------------------------------------------------------------------ JSON writing (no dependencies)
    public static class CbJson
    {
        public static string Str(string s)
        {
            if (s == null) return "null";
            StringBuilder b = new StringBuilder(s.Length + 2);
            b.Append('"');
            foreach (char c in s)
            {
                if (c == '"') b.Append("\\\"");
                else if (c == '\\') b.Append("\\\\");
                else if (c == '\n') b.Append("\\n");
                else if (c == '\r') b.Append("\\r");
                else if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
                else b.Append(c);
            }
            b.Append('"');
            return b.ToString();
        }
        public static string Num(double v)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return "null";
            return v.ToString("R", CultureInfo.InvariantCulture);
        }
        public static string Num3(double v) { return Math.Round(v, 3).ToString("0.###", CultureInfo.InvariantCulture); }
    }

    // ------------------------------------------------------------------ bars copied out of a BarsRequest
    // (copy fast inside NinjaTrader's callback, serialize later on a worker thread)
    public class RawBars
    {
        public int Count;
        public DateTime[] Time;
        public double[] Open, High, Low, Close;
        public long[] Volume;

        public static RawBars Copy(Bars bars, bool closeOnly)
        {
            RawBars r = new RawBars();
            int n = bars.Count;
            r.Count = n;
            r.Time = new DateTime[n]; r.Close = new double[n]; r.Volume = new long[n];
            if (!closeOnly) { r.Open = new double[n]; r.High = new double[n]; r.Low = new double[n]; }
            for (int i = 0; i < n; i++)
            {
                r.Time[i] = bars.GetTime(i);
                r.Close[i] = bars.GetClose(i);
                r.Volume[i] = bars.GetVolume(i);
                if (!closeOnly) { r.Open[i] = bars.GetOpen(i); r.High[i] = bars.GetHigh(i); r.Low[i] = bars.GetLow(i); }
            }
            return r;
        }
    }

    // ------------------------------------------------------------------ one connected page
    public class ChartBridgeClient
    {
        public readonly WebSocket Socket;
        public readonly int Id;
        public volatile string Root;            // subscribed instrument root, null until subscribe
        public volatile bool Ready;             // backfill sent; live ticks go straight out
        public string Origin;                   // the WebSocket's Origin header (orders only from ChartBridge's own page)
        public volatile bool Trader;            // signed in for orders (ChartBridgeOrders.Auth)
        public readonly Queue<double> Actions = new Queue<double>();   // recent order actions, for the rate limit
        public readonly List<string> Pending = new List<string>();   // live ticks held during backfill
        private readonly BlockingCollection<string> outbox = new BlockingCollection<string>(new ConcurrentQueue<string>(), 5000);
        private readonly CancellationTokenSource cts = new CancellationTokenSource();

        public ChartBridgeClient(WebSocket socket, int id) { Socket = socket; Id = id; }

        public Action<string> Tap;              // test hook: sees every message sent (unused in NinjaTrader)

        public void Send(string json)
        {
            if (Tap != null) Tap(json);
            if (cts.IsCancellationRequested) return;
            if (!outbox.TryAdd(json))
            {
                ChartBridgeServer.Log("Client " + Id + " is not keeping up; closing it.");
                Close();
            }
        }

        public async Task SendLoop()
        {
            try
            {
                foreach (string msg in outbox.GetConsumingEnumerable(cts.Token))
                {
                    if (Socket.State != WebSocketState.Open) break;
                    byte[] bytes = Encoding.UTF8.GetBytes(msg);
                    await Socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, cts.Token);
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex) { ChartBridgeServer.Log("Client " + Id + " send stopped: " + ex.Message); }
        }

        public void Close()
        {
            try { cts.Cancel(); } catch (Exception) { }
            try { outbox.CompleteAdding(); } catch (Exception) { }
        }
    }

    // ------------------------------------------------------------------ fills to The Desk
    // Fills wait in a queue (mirrored to pending_fills.jsonl so a restart loses nothing) until
    // The Desk accepts them. The Desk ignores duplicates by exec_id, so resending is safe.
    // The file is replaced atomically; a request gets 10 seconds; a batch The Desk calls malformed
    // is retried one fill at a time and a single bad fill is set aside in rejected_fills.jsonl, so
    // nothing blocks the queue for good.
    public static class ChartBridgeDesk
    {
        private static readonly object Sync = new object();
        private static readonly List<string> PendingList = new List<string>();
        private static readonly HashSet<string> PendingSet = new HashSet<string>();
        private static readonly Regex RejectedRx = new Regex("\"rejected\"\\s*:\\s*\\[(.*?)\\]\\s*[,}]", RegexOptions.Singleline);
        private static readonly Regex ReasonRx = new Regex("\"reason\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        private const int TimeoutMs = 10000, FullBatch = 500;
        private static int sending, batchSize = FullBatch;
        private static bool lastFailed;
        private static string lastError = "";
        private static long setAside, rejectedByDesk;
        private static string File_ { get { return Path.Combine(ChartBridgeConfig.Folder, "pending_fills.jsonl"); } }
        private static string SetAsideFile { get { return Path.Combine(ChartBridgeConfig.Folder, "rejected_fills.jsonl"); } }

        private static bool LooksWhole(string line) { return line.StartsWith("{") && line.EndsWith("}") && line.Contains("\"exec_id\":"); }

        public static void Load()
        {
            lock (Sync)
            {
                PendingList.Clear(); PendingSet.Clear();
                int bad = 0;
                try
                {
                    if (File.Exists(File_))
                        foreach (string raw in File.ReadAllLines(File_))
                        {
                            string line = raw.Trim();
                            if (line.Length == 0) continue;
                            if (!LooksWhole(line)) { bad++; continue; }   // a line cut short by a crash mid-write
                            if (PendingSet.Add(line)) PendingList.Add(line);
                        }
                }
                catch (Exception ex) { ChartBridgeServer.Log("could not read pending fills: " + ex.Message); }
                if (bad > 0) ChartBridgeServer.Log("skipped " + bad + " unreadable line(s) in pending_fills.jsonl");
            }
        }

        // Write the whole queue to a temp file, then swap it in, so a crash never leaves half a file.
        private static void Save()
        {
            try
            {
                string tmp = File_ + ".tmp";
                File.WriteAllLines(tmp, PendingList.ToArray());
                if (File.Exists(File_)) File.Replace(tmp, File_, null); else File.Move(tmp, File_);
            }
            catch (Exception ex) { ChartBridgeServer.Log("could not save pending fills: " + ex.Message); }
        }

        public static void Queue(string fillJson) { lock (Sync) { if (PendingSet.Add(fillJson)) { PendingList.Add(fillJson); Save(); } } }

        public static void QueueMany(List<string> fills)
        {
            lock (Sync)
            {
                bool changed = false;
                foreach (string f in fills) if (PendingSet.Add(f)) { PendingList.Add(f); changed = true; }
                if (changed) Save();
            }
        }

        public static string DiagJson()
        {
            int n; lock (Sync) n = PendingList.Count;
            return "{\"postFills\":" + (ChartBridgeConfig.PostFills ? "true" : "false") + ",\"deskUrl\":" + CbJson.Str(ChartBridgeConfig.DeskUrl) +
                ",\"waiting\":" + n + ",\"lastSendFailed\":" + (lastFailed ? "true" : "false") + ",\"lastError\":" + CbJson.Str(lastError) +
                ",\"setAside\":" + Interlocked.Read(ref setAside) + ",\"rejectedByDesk\":" + Interlocked.Read(ref rejectedByDesk) + "}";
        }

        private static void Remove(string[] batch)
        {
            lock (Sync)
            {
                PendingList.RemoveRange(0, Math.Min(batch.Length, PendingList.Count));   // the queue only grows at the end
                foreach (string f in batch) PendingSet.Remove(f);
                Save();
            }
        }

        private static async Task<WebResponse> Post(HttpWebRequest req, byte[] bytes)
        {
            using (Stream s = await req.GetRequestStreamAsync()) await s.WriteAsync(bytes, 0, bytes.Length);
            return await req.GetResponseAsync();
        }

        public static void Flush()
        {
            if (!ChartBridgeConfig.PostFills) return;
            if (Interlocked.CompareExchange(ref sending, 1, 0) != 0) return;
            string[] batch;
            lock (Sync) batch = PendingList.Take(batchSize).ToArray();
            if (batch.Length == 0) { Interlocked.Exchange(ref sending, 0); return; }
            Task.Run(async () =>
            {
                bool more = false;
                try
                {
                    byte[] bytes = Encoding.UTF8.GetBytes("[" + string.Join(",", batch) + "]");
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(ChartBridgeConfig.DeskUrl + "/api/fills");
                    req.Method = "POST";
                    req.ContentType = "application/json";
                    Task<WebResponse> call = Post(req, bytes);
                    Task first = await Task.WhenAny(call, Task.Delay(TimeoutMs));
                    if (first != call)
                    {
                        try { req.Abort(); } catch (Exception) { }
                        Task observed = call.ContinueWith(t => { Exception ignored = t.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
                        throw new TimeoutException("The Desk did not answer within " + (TimeoutMs / 1000) + " seconds");
                    }
                    string text;
                    using (HttpWebResponse res = (HttpWebResponse)await call)
                    using (StreamReader r = new StreamReader(res.GetResponseStream(), Encoding.UTF8)) text = r.ReadToEnd();
                    Remove(batch);
                    if (batch.Length > 1) batchSize = FullBatch;   // while hunting a bad fill, stay at one per request
                    NoteRejected(text);
                    lock (Sync) more = PendingList.Count > 0;
                    if (lastFailed) { ChartBridgeServer.Log("The Desk is taking fills again."); lastFailed = false; }
                    lastError = "";   // /diag: no stale error once a send has gone through
                }
                catch (WebException wex)
                {
                    HttpWebResponse res = wex.Response as HttpWebResponse;
                    int code = res != null ? (int)res.StatusCode : 0;
                    if (code == 400 || code == 422)
                    {
                        // The Desk called the batch malformed: find the bad fill by sending one at a time.
                        if (batch.Length > 1) batchSize = 1;
                        else
                        {
                            try { File.AppendAllLines(SetAsideFile, batch); } catch (Exception) { }
                            Remove(batch);
                            batchSize = FullBatch;
                            Interlocked.Increment(ref setAside);
                            ChartBridgeServer.Log("The Desk refused a fill (" + code + "); it was set aside in rejected_fills.jsonl");
                        }
                        more = true;
                    }
                    else Failed(wex.Message);
                }
                catch (Exception ex) { Failed(ex.Message); }
                finally { Interlocked.Exchange(ref sending, 0); }
                if (more) Flush();   // keep draining without waiting for the 10 second timer
            });
        }

        private static void Failed(string message)
        {
            lastError = message;
            if (!lastFailed) ChartBridgeServer.Log("The Desk did not take fills (" + message + "); they are saved and will be retried every 10 seconds.");
            lastFailed = true;
        }

        // The Desk answers 200 with a "rejected" list for fills it could not store: say so once per answer.
        private static void NoteRejected(string text)
        {
            Match m = RejectedRx.Match(text ?? "");
            if (!m.Success || m.Groups[1].Value.Trim().Length == 0) return;
            int n = Regex.Matches(m.Groups[1].Value, "\"index\"").Count;
            if (n == 0) return;
            Interlocked.Add(ref rejectedByDesk, n);
            Match why = ReasonRx.Match(m.Groups[1].Value);
            ChartBridgeServer.Log("The Desk could not store " + n + " fill(s)" + (why.Success ? ", for example: " + why.Groups[1].Value : ""));
        }
    }

    // ------------------------------------------------------------------ the server
    public static class ChartBridgeServer
    {
        public const string Version = "0.3.2";
        private static readonly object Gate = new object();
        private static HttpListener listener;
        private static CancellationTokenSource cts;
        private static readonly ConcurrentDictionary<int, ChartBridgeClient> Clients = new ConcurrentDictionary<int, ChartBridgeClient>();
        private static int nextId;
        private static readonly Dictionary<string, Instrument> Instruments = new Dictionary<string, Instrument>();
        private static readonly List<MarketData> Feeds = new List<MarketData>();
        private static readonly HashSet<Account> Watched = new HashSet<Account>();
        private static System.Threading.Timer accountTimer, pollTimer;
        private static readonly Regex TypeRx = new Regex("\"type\"\\s*:\\s*\"(\\w+)\"");
        private static readonly Regex RootRx = new Regex("\"root\"\\s*:\\s*\"(\\w+)\"");
        private static readonly Regex DaysRx = new Regex("\"days\"\\s*:\\s*(\\d+)");
        private static readonly Regex TickHoursRx = new Regex("\"tickHours\"\\s*:\\s*(\\d+)");
        private static readonly Regex PingRx = new Regex("\"c\"\\s*:\\s*([0-9.]+)");

        public static void Log(string text)
        {
            try { NinjaTrader.Code.Output.Process("ChartBridge: " + text, PrintTo.OutputTab1); } catch (Exception) { }
        }

        public static bool Start()
        {
            lock (Gate)
            {
                if (listener != null) return false;     // another instance already runs it
                try
                {
                    ChartBridgeConfig.Load();
                    Directory.CreateDirectory(ChartBridgeConfig.WwwFolder);
                    cts = new CancellationTokenSource();
                    ResolveInstruments();
                    ChartBridgeOrders.NewToken();
                    Log(ChartBridgeOrders.Enabled
                        ? "order entry is ON for " + ChartBridgeOrders.TradeAccounts.Count + " account(s): " + string.Join(", ", ChartBridgeOrders.TradeAccounts)
                        : "order entry is off (read only)");
                    Log(ChartBridgePin.IsSet ? "ChartBridge's page is locked with a PIN (pin.txt)" : "no PIN is set yet: ChartBridge's page asks for one before it shows anything");
                    SubscribeMarketData();
                    if (ChartBridgeConfig.PostFills) ChartBridgeDesk.Load();
                    WatchAccounts();
                    ChartBridgeOrders.WatchConnections();
                    try { ChartBridgeOrders.Resume(); } catch (Exception ex) { Log("bracket resume error: " + ex.Message); }   // entries that filled while stopped
                    accountTimer = new System.Threading.Timer(delegate { try { WatchAccounts(); } catch (Exception) { } try { ChartBridgeDesk.Flush(); } catch (Exception) { } }, null, 10000, 10000);
                    pollTimer = new System.Threading.Timer(delegate { try { PollExecutions(); } catch (Exception) { } try { ChartBridgeOrders.CheckLegs(); } catch (Exception ex) { Log("legs check error: " + ex.Message); } }, null, 2000, 2000);
                    listener = new HttpListener();
                    listener.Prefixes.Add("http://localhost:" + ChartBridgeConfig.Port + "/");
                    StartListening(cts.Token, 0);
                    return true;
                }
                catch (Exception ex)
                {
                    Log("could not start: " + ex.Message);
                    try { if (accountTimer != null) accountTimer.Dispose(); } catch (Exception) { }
                    try { if (pollTimer != null) pollTimer.Dispose(); } catch (Exception) { }
                    accountTimer = null; pollTimer = null;
                    Unwatch();
                    return false;
                }
            }
        }

        public static void Stop()
        {
            lock (Gate)
            {
                try { if (cts != null) cts.Cancel(); } catch (Exception) { }
                try { if (accountTimer != null) accountTimer.Dispose(); } catch (Exception) { }
                accountTimer = null;
                try { if (pollTimer != null) pollTimer.Dispose(); } catch (Exception) { }
                pollTimer = null;
                foreach (ChartBridgeClient c in Clients.Values) c.Close();
                Clients.Clear();
                foreach (MarketData md in Feeds) { try { md.Update -= OnMarketData; } catch (Exception) { } }
                Feeds.Clear();
                Unwatch();
                ChartBridgeOrders.UnwatchConnections();
                try { if (listener != null) { listener.Stop(); listener.Close(); } } catch (Exception) { }
                listener = null;
                Instruments.Clear();
                ChartBridgeOrders.Clear();
                Log("stopped");
            }
        }

        // The old listener can hold the port for a moment after a recompile, so retry for a while.
        private static void StartListening(CancellationToken token, int attempt)
        {
            try
            {
                listener.Start();
                Log("serving http://localhost:" + ChartBridgeConfig.Port + "/  (page files: " + ChartBridgeConfig.WwwFolder + ")");
                Task.Run(() => AcceptLoop(token));
            }
            catch (HttpListenerException ex)
            {
                if (ex.ErrorCode == 5)
                {
                    Log("Windows refused the web port (access denied). Run once in an admin PowerShell: " +
                        "netsh http add urlacl url=http://localhost:" + ChartBridgeConfig.Port + "/ user=%USERNAME%  then recompile.");
                    return;
                }
                if (attempt < 15 && !token.IsCancellationRequested)
                {
                    Task.Delay(2000).ContinueWith(delegate
                    {
                        lock (Gate)
                        {
                            if (listener == null || token.IsCancellationRequested) return;
                            listener = new HttpListener();
                            listener.Prefixes.Add("http://localhost:" + ChartBridgeConfig.Port + "/");
                            StartListening(token, attempt + 1);
                        }
                    });
                }
                else Log("port " + ChartBridgeConfig.Port + " is busy: " + ex.Message);
            }
        }

        private static async Task AcceptLoop(CancellationToken token)
        {
            HttpListener l = listener;
            while (!token.IsCancellationRequested && l != null && l.IsListening)
            {
                HttpListenerContext ctx;
                try { ctx = await l.GetContextAsync(); }
                catch (Exception) { break; }
                HttpListenerContext c = ctx;
                Task handling = Task.Run(() => Handle(c, token));   // one task per request; errors are handled inside
            }
        }

        private static async Task Handle(HttpListenerContext ctx, CancellationToken token)
        {
            try
            {
                // First, before any routing, on every path: only this PC (see ChartBridgeAccess).
                IPEndPoint remote = RemoteOf(ctx);
                if (!ChartBridgeAccess.IsLoopback(remote)) { ChartBridgeAccess.NoteRefusedAddress(remote, SafePath(ctx)); Refuse(ctx); return; }
                string path = ctx.Request.Url.AbsolutePath;
                if (path == "/ws" && ctx.Request.IsWebSocketRequest)
                {
                    string origin = ctx.Request.Headers["Origin"];
                    if (!ChartBridgeAccess.WsOriginAllowed(origin)) { ChartBridgeAccess.NoteRefusedOrigin(origin); Refuse(ctx); return; }
                    if (!ChartBridgePin.WsUnlocked(origin, ctx.Request.QueryString["unlock"])) { Refuse(ctx); return; }   // own page: locked until the PIN (not logged: a locked page retries)
                    HttpListenerWebSocketContext wsc = await ctx.AcceptWebSocketAsync(null);
                    await RunClient(wsc.WebSocket, token, origin);
                    return;
                }
                if (path == "/diag") { ServeText(ctx, DiagJson(), "application/json"); return; }
                if (path == "/session")   // same origin only: no CORS headers; and only when asked for by the localhost name (a second guard against DNS rebinding)
                {
                    if (ctx.Request.Headers["Host"] != "localhost:" + ChartBridgeConfig.Port) { ctx.Response.StatusCode = 403; ctx.Response.Close(); return; }
                    if (!ChartBridgePin.TokenValid(ctx.Request.Headers[ChartBridgePin.Header])) { Refuse(ctx); return; }   // the order sign-in token only for an unlocked page
                    ServeText(ctx, ChartBridgeOrders.SessionJson(), "application/json");
                    return;
                }
                if (path.StartsWith("/pin/")) { ChartBridgePin.Serve(ctx, path); return; }   // POST only, own page only (ChartBridgePin.cs)
                ServeFile(ctx, path);
            }
            catch (Exception ex)
            {
                Log("request failed: " + ex.Message);
                try { ctx.Response.StatusCode = 500; ctx.Response.Close(); } catch (Exception) { }
            }
        }

        // The request's source address, or null if HttpListener cannot say (then it is refused).
        private static IPEndPoint RemoteOf(HttpListenerContext ctx)
        {
            try { return ctx.Request.RemoteEndPoint; } catch (Exception) { return null; }
        }

        private static string SafePath(HttpListenerContext ctx)
        {
            try { return ctx.Request.Url.AbsolutePath; } catch (Exception) { return "?"; }
        }

        private static void Refuse(HttpListenerContext ctx)
        {
            try
            {
                ctx.Response.StatusCode = 403;
                NoFraming(ctx.Response);
                ctx.Response.ContentLength64 = 0;
                ctx.Response.Close();
            }
            catch (Exception) { try { ctx.Response.Abort(); } catch (Exception) { } }
        }

        private static void ServeText(HttpListenerContext ctx, string text, string type) { ServeText(ctx, 200, text, type); }

        public static void ServeText(HttpListenerContext ctx, int status, string text, string type)
        {
            byte[] body = Encoding.UTF8.GetBytes(text);
            HttpListenerResponse res = ctx.Response;
            res.StatusCode = status;
            res.ContentType = type + "; charset=utf-8";
            res.AddHeader("Cache-Control", "no-store");
            NoFraming(res);
            res.ContentLength64 = body.Length;
            res.OutputStream.Write(body, 0, body.Length);
            res.Close();
        }

        // The page can place orders, so no other site may show it inside a frame (clickjacking).
        private static void NoFraming(HttpListenerResponse res)
        {
            res.AddHeader("X-Frame-Options", "DENY");
            res.AddHeader("Content-Security-Policy", "frame-ancestors 'none'");
            res.AddHeader("X-Content-Type-Options", "nosniff");
        }

        private static void ServeFile(HttpListenerContext ctx, string path)
        {
            if (path == "/" || path.Length == 0) path = "/index.html";
            string root = Path.GetFullPath(ChartBridgeConfig.WwwFolder);
            string full = Path.GetFullPath(Path.Combine(root, path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar)));
            HttpListenerResponse res = ctx.Response;
            if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
            {
                res.StatusCode = 404;
                NoFraming(res);
                byte[] msg = Encoding.UTF8.GetBytes("Not found. Page files go in " + root);
                res.OutputStream.Write(msg, 0, msg.Length);
                res.Close();
                return;
            }
            string ext = Path.GetExtension(full).ToLowerInvariant();
            string type = ext == ".html" ? "text/html; charset=utf-8" : ext == ".js" ? "text/javascript; charset=utf-8"
                : ext == ".css" ? "text/css; charset=utf-8" : ext == ".json" ? "application/json" : ext == ".svg" ? "image/svg+xml"
                : ext == ".png" ? "image/png" : "application/octet-stream";
            byte[] body = File.ReadAllBytes(full);
            res.ContentType = type;
            res.AddHeader("Cache-Control", "no-cache");
            NoFraming(res);
            res.ContentLength64 = body.Length;
            res.OutputStream.Write(body, 0, body.Length);
            res.Close();
        }

        private const int MaxMessageBytes = 65536;   // page messages are small; anything bigger is not the page

        private static async Task RunClient(WebSocket ws, CancellationToken token, string origin)
        {
            int id = Interlocked.Increment(ref nextId);
            ChartBridgeClient client = new ChartBridgeClient(ws, id);
            client.Origin = origin;
            Clients[id] = client;
            Task sending = Task.Run(() => client.SendLoop());   // SendLoop blocks on its queue; never run it inline (0.1.0 deadlock)
            client.Send(HelloJson());
            client.Send(ExecsJson());
            byte[] buf = new byte[16384];
            try
            {
                while (ws.State == WebSocketState.Open && !token.IsCancellationRequested)
                {
                    MemoryStream bytes = new MemoryStream();   // whole message first: a UTF-8 character can span two frames
                    int size = 0;
                    WebSocketReceiveResult r;
                    do
                    {
                        r = await ws.ReceiveAsync(new ArraySegment<byte>(buf), token);
                        if (r.MessageType == WebSocketMessageType.Close) break;
                        size += r.Count;
                        if (size > MaxMessageBytes) break;
                        bytes.Write(buf, 0, r.Count);
                    } while (!r.EndOfMessage);
                    if (r.MessageType == WebSocketMessageType.Close) break;
                    if (size > MaxMessageBytes)
                    {
                        Log("client " + id + " sent a message over " + MaxMessageBytes + " bytes; closing it");
                        try { await ws.CloseAsync(WebSocketCloseStatus.MessageTooBig, "message too big", CancellationToken.None); } catch (Exception) { }
                        break;
                    }
                    string text = Encoding.UTF8.GetString(bytes.ToArray());
                    OnClientMessage(client, text);
                }
            }
            catch (Exception) { }
            finally
            {
                ChartBridgeClient gone;
                Clients.TryRemove(id, out gone);
                client.Close();
                try { if (ws.State == WebSocketState.Open) await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None); } catch (Exception) { }
                try { await sending; } catch (Exception) { }
            }
        }

        private static void OnClientMessage(ChartBridgeClient client, string text)
        {
            Match m = TypeRx.Match(text);
            if (!m.Success) return;
            string type = m.Groups[1].Value;
            if (type == "ping")
            {
                Match c = PingRx.Match(text);
                client.Send("{\"type\":\"pong\",\"c\":" + (c.Success ? c.Groups[1].Value : "0") + ",\"s\":" + CbJson.Num3(ChartBridgeTime.NowUtcMs()) + "}");
            }
            else if (type == "subscribe")
            {
                Match rm = RootRx.Match(text);
                string root = rm.Success ? rm.Groups[1].Value.ToUpperInvariant() : "MNQ";
                Match dm = DaysRx.Match(text), hm = TickHoursRx.Match(text);
                int days = dm.Success ? Math.Max(1, Math.Min(60, int.Parse(dm.Groups[1].Value))) : ChartBridgeConfig.DefaultDays;
                int tickHours = hm.Success ? Math.Max(0, Math.Min(48, int.Parse(hm.Groups[1].Value))) : ChartBridgeConfig.DefaultTickHours;
                Subscribe(client, root, days, tickHours);
            }
            else if (type == "auth" || type == "order" || type == "change" || type == "cancel" || type == "flatten")
                ChartBridgeOrders.OnMessage(client, type, text);   // every order path and its gates live in ChartBridgeOrders.cs
        }

        public static Instrument InstrumentFor(string root)
        {
            Instrument inst;
            return root != null && Instruments.TryGetValue(root, out inst) ? inst : null;
        }

        // The root ChartBridge serves for this exact contract, or null (other contracts are not ours).
        public static string RootFor(Instrument inst)
        {
            if (inst == null) return null;
            foreach (KeyValuePair<string, Instrument> kv in Instruments) if (kv.Value == inst || kv.Value.FullName == inst.FullName) return kv.Key;
            return null;
        }

        public static void SendToTraders(string json)
        {
            foreach (ChartBridgeClient c in Clients.Values) if (c.Trader) c.Send(json);
        }

        // ---------------------------------------------------------- instruments and front month
        private static void ResolveInstruments()
        {
            Instruments.Clear();
            foreach (string root in ChartBridgeConfig.Roots)
            {
                string name;
                if (!ChartBridgeConfig.ContractOverride.TryGetValue(root, out name)) name = root + " " + FrontMonth(ChartBridgeTime.NowEastern());
                Instrument inst = Instrument.GetInstrument(name);
                if (inst == null) { Log("instrument not found: " + name + " (set contract." + root + " in config.txt)"); continue; }
                Instruments[root] = inst;
                Log(root + " -> " + inst.FullName);
            }
        }

        // CME equity index futures: quarterly (Mar, Jun, Sep, Dec), expiring the third Friday.
        // NinjaTrader rolls them 8 days before expiry (the Thursday of the prior week); same rule here.
        public static string FrontMonth(DateTime nowEt)
        {
            int[] months = new int[] { 3, 6, 9, 12 };
            for (int y = nowEt.Year; y <= nowEt.Year + 1; y++)
            {
                foreach (int mo in months)
                {
                    DateTime first = new DateTime(y, mo, 1);
                    int toFriday = ((int)DayOfWeek.Friday - (int)first.DayOfWeek + 7) % 7;
                    DateTime expiry = first.AddDays(toFriday + 14);
                    DateTime roll = expiry.AddDays(-8);
                    if (nowEt.Date < roll.Date) return mo.ToString("00") + "-" + (y % 100).ToString("00");
                }
            }
            return "03-" + ((nowEt.Year + 2) % 100).ToString("00");
        }

        private static string RootOf(Instrument inst)
        {
            foreach (KeyValuePair<string, Instrument> kv in Instruments) if (kv.Value == inst) return kv.Key;
            return inst.MasterInstrument.Name;
        }

        private static string HelloJson()
        {
            StringBuilder b = new StringBuilder();
            b.Append("{\"type\":\"hello\",\"version\":").Append(CbJson.Str(Version));
            b.Append(",\"now\":").Append(CbJson.Num3(ChartBridgeTime.NowUtcMs()));
            b.Append(",\"instruments\":[");
            bool first = true;
            foreach (KeyValuePair<string, Instrument> kv in Instruments)
            {
                if (!first) b.Append(','); first = false;
                b.Append("{\"root\":").Append(CbJson.Str(kv.Key))
                 .Append(",\"name\":").Append(CbJson.Str(kv.Value.FullName))
                 .Append(",\"tick\":").Append(CbJson.Num(kv.Value.MasterInstrument.TickSize))
                 .Append(",\"pointValue\":").Append(CbJson.Num(kv.Value.MasterInstrument.PointValue)).Append('}');
            }
            b.Append("],\"accounts\":[");
            first = true;
            lock (Watched)
            {
                foreach (Account a in Watched) { if (!first) b.Append(','); first = false; b.Append(CbJson.Str(a.Name)); }
            }
            b.Append("],\"trading\":").Append(ChartBridgeOrders.TradingJson(false, null)).Append("}");
            return b.ToString();
        }

        // ---------------------------------------------------------- live market data
        private static void SubscribeMarketData()
        {
            foreach (Instrument inst in Instruments.Values)
            {
                MarketData md = new MarketData(inst);
                md.Update += OnMarketData;
                Feeds.Add(md);
            }
        }

        private static void OnMarketData(object sender, MarketDataEventArgs e)
        {
            if (e.MarketDataType != MarketDataType.Last) return;
            try
            {
                double rx = ChartBridgeTime.NowUtcMs();
                DateTime utc = ChartBridgeTime.ToUtc(e.Time);
                string root = RootOf(e.Instrument);
                ChartBridgeOrders.NoteLast(root, e.Price);
                string json = "{\"type\":\"tick\",\"root\":" + CbJson.Str(root) +
                    ",\"t\":" + CbJson.Num3(ChartBridgeTime.EtSeconds(utc)) +
                    ",\"u\":" + CbJson.Num3(ChartBridgeTime.UtcMs(utc)) +
                    ",\"rx\":" + CbJson.Num3(rx) +
                    ",\"p\":" + CbJson.Num(e.Price) + ",\"v\":" + e.Volume.ToString(CultureInfo.InvariantCulture) + "}";
                foreach (ChartBridgeClient c in Clients.Values)
                {
                    if (c.Root != root) continue;
                    if (c.Ready) c.Send(json);
                    else lock (c.Pending) { if (!c.Ready) c.Pending.Add(json); else c.Send(json); }
                }
            }
            catch (Exception ex) { Log("tick error: " + ex.Message); }
        }

        // ---------------------------------------------------------- history backfill
        private static void Subscribe(ChartBridgeClient client, string root, int days, int tickHours)
        {
            Instrument inst;
            if (!Instruments.TryGetValue(root, out inst))
            {
                client.Send("{\"type\":\"status\",\"level\":\"error\",\"text\":" + CbJson.Str("No instrument for " + root + ". Check the NinjaScript Output window.") + "}");
                return;
            }
            client.Ready = false;
            lock (client.Pending) client.Pending.Clear();
            client.Root = root;

            DateTime nowNt = DateTime.Now;   // BarsRequest takes times in NinjaTrader's time zone setting
            try { nowNt = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo); } catch (Exception) { }
            string fullName = inst.FullName;

            BarsRequest minutes = new BarsRequest(inst, nowNt.AddDays(-days - (days >= 5 ? 3 : 1)), nowNt);
            minutes.BarsPeriod = new BarsPeriod { BarsPeriodType = BarsPeriodType.Minute, Value = 1 };
            minutes.TradingHours = inst.MasterInstrument.TradingHours;
            minutes.Request(new Action<BarsRequest, ErrorCode, string>((req, code, message) =>
            {
                Task barsSent;
                try
                {
                    if (code != ErrorCode.NoError)
                    {
                        client.Send("{\"type\":\"status\",\"level\":\"warn\",\"text\":" + CbJson.Str("Minute history failed: " + code + " " + message) + "}");
                        barsSent = Task.FromResult(true);
                    }
                    else
                    {
                        RawBars raw = RawBars.Copy(req.Bars, false);     // quick copy on NinjaTrader's thread
                        barsSent = Task.Run(() => SendBars(client, root, fullName, raw, 60));   // format off-thread
                    }
                }
                catch (Exception ex) { Log("history error: " + ex.Message); barsSent = Task.FromResult(true); }
                finally { try { req.Dispose(); } catch (Exception) { } }
                RequestTicks(client, root, inst, nowNt, tickHours, barsSent);
            }));
        }

        private static void SendBars(ChartBridgeClient client, string root, string name, RawBars bars, int barSeconds)
        {
            const int chunk = 4000;
            int n = bars.Count;
            StringBuilder b = null;
            int inChunk = 0;
            for (int i = 0; i < n; i++)
            {
                if (b == null)
                {
                    b = new StringBuilder(chunk * 48);
                    b.Append("{\"type\":\"history\",\"root\":").Append(CbJson.Str(root)).Append(",\"name\":").Append(CbJson.Str(name))
                     .Append(",\"barSeconds\":").Append(barSeconds).Append(",\"bars\":[");
                    inChunk = 0;
                }
                // NinjaTrader stamps bars at their close; the chart wants the start.
                double t = ChartBridgeTime.EtSeconds(ChartBridgeTime.ToUtc(bars.Time[i])) - barSeconds;
                if (inChunk > 0) b.Append(',');
                b.Append('[').Append(CbJson.Num3(t)).Append(',').Append(CbJson.Num(bars.Open[i])).Append(',').Append(CbJson.Num(bars.High[i]))
                 .Append(',').Append(CbJson.Num(bars.Low[i])).Append(',').Append(CbJson.Num(bars.Close[i])).Append(',')
                 .Append(bars.Volume[i].ToString(CultureInfo.InvariantCulture)).Append(']');
                inChunk++;
                if (inChunk == chunk || i == n - 1)
                {
                    b.Append("],\"done\":").Append(i == n - 1 ? "true" : "false").Append('}');
                    client.Send(b.ToString());
                    b = null;
                }
            }
            if (n == 0) client.Send("{\"type\":\"history\",\"root\":" + CbJson.Str(root) + ",\"name\":" + CbJson.Str(name) + ",\"barSeconds\":" + barSeconds + ",\"bars\":[],\"done\":true}");
        }

        private static void RequestTicks(ChartBridgeClient client, string root, Instrument inst, DateTime nowNt, int tickHours, Task barsSent)
        {
            if (tickHours <= 0 || client.Root != root)
            {
                barsSent.ContinueWith(delegate { MarkReady(client, root); });
                return;
            }
            BarsRequest ticks = new BarsRequest(inst, nowNt.AddHours(-tickHours), nowNt);
            ticks.BarsPeriod = new BarsPeriod { BarsPeriodType = BarsPeriodType.Tick, Value = 1 };
            ticks.TradingHours = inst.MasterInstrument.TradingHours;
            ticks.Request(new Action<BarsRequest, ErrorCode, string>((req, code, message) =>
            {
                RawBars raw = null;
                try
                {
                    if (code != ErrorCode.NoError)
                        client.Send("{\"type\":\"status\",\"level\":\"warn\",\"text\":" + CbJson.Str("Tick history failed: " + code + " " + message + ". Seconds and range bars start from now.") + "}");
                    else if (client.Root == root) raw = RawBars.Copy(req.Bars, true);
                }
                catch (Exception ex) { Log("tick history error: " + ex.Message); }
                finally { try { req.Dispose(); } catch (Exception) { } }
                RawBars copy = raw;
                // Order on the wire: minute history, then ticks, then "ready" and the live ticks held meanwhile.
                barsSent.ContinueWith(delegate
                {
                    try { if (copy != null && client.Root == root) SendTicks(client, root, copy); }
                    catch (Exception ex) { Log("tick send error: " + ex.Message); }
                    finally { MarkReady(client, root); }
                });
            }));
        }

        private static void SendTicks(ChartBridgeClient client, string root, RawBars bars)
        {
            const int chunk = 20000;
            int n = bars.Count;
            StringBuilder b = null; int inChunk = 0;
            for (int i = 0; i < n; i++)
            {
                if (b == null) { b = new StringBuilder(chunk * 28); b.Append("{\"type\":\"ticks\",\"root\":").Append(CbJson.Str(root)).Append(",\"ticks\":["); inChunk = 0; }
                double t = ChartBridgeTime.EtSeconds(ChartBridgeTime.ToUtc(bars.Time[i]));
                if (inChunk > 0) b.Append(',');
                b.Append('[').Append(CbJson.Num3(t)).Append(',').Append(CbJson.Num(bars.Close[i])).Append(',')
                 .Append(bars.Volume[i].ToString(CultureInfo.InvariantCulture)).Append(']');
                inChunk++;
                if (inChunk == chunk || i == n - 1)
                {
                    b.Append("],\"done\":").Append(i == n - 1 ? "true" : "false").Append('}');
                    client.Send(b.ToString()); b = null;
                }
            }
            if (n == 0) client.Send("{\"type\":\"ticks\",\"root\":" + CbJson.Str(root) + ",\"ticks\":[],\"done\":true}");
        }

        private static void MarkReady(ChartBridgeClient client, string root)
        {
            if (client.Root != root) return;
            lock (client.Pending)
            {
                client.Send("{\"type\":\"ready\",\"root\":" + CbJson.Str(root) + "}");
                foreach (string json in client.Pending) client.Send(json);
                client.Pending.Clear();
                client.Ready = true;
            }
        }

        // ---------------------------------------------------------- fills (read only)
        // Two ways in, so a fill is never missed: the account's ExecutionUpdate event, and a poll of
        // each account's Executions every 2 seconds. Each execution is delivered once (keyed by
        // account and execution id). Order and position events are only counted, for /diag.
        private static readonly HashSet<string> Seen = new HashSet<string>();
        private static readonly Dictionary<string, long[]> EventCounts = new Dictionary<string, long[]>();  // account -> exec, order, position events
        private static long polledNew, eventNew, lastPollMs;

        private static void Count(string account, int kind)
        {
            lock (EventCounts)
            {
                long[] c;
                if (!EventCounts.TryGetValue(account ?? "", out c)) { c = new long[3]; EventCounts[account ?? ""] = c; }
                c[kind]++;
            }
        }

        private static string ExecKey(string account, string id, DateTime time, double price, int qty, string orderId)
        {
            if (!string.IsNullOrEmpty(id)) return account + "|" + id;
            return account + "|" + time.Ticks.ToString(CultureInfo.InvariantCulture) + "|" + CbJson.Num(price) + "|" + qty + "|" + orderId;
        }

        private static bool FirstTime(string key) { lock (Seen) return Seen.Add(key); }

        // To the open pages now; to The Desk's queue (in `deskBatch` when given, saved once by the caller).
        private static void Deliver(string account, Instrument inst, MarketPosition side, int qty, double price, DateTime time, string id, string orderId,
                                    List<string> deskBatch)
        {
            string json = ExecJson(account, inst, side, qty, price, time, id, orderId, true);
            foreach (ChartBridgeClient c in Clients.Values) c.Send(json);
            if (!ChartBridgeConfig.PostFills) return;
            string desk = DeskFillJson(account, inst, side, qty, price, time, id, orderId);
            if (deskBatch != null) deskBatch.Add(desk); else ChartBridgeDesk.Queue(desk);
        }

        // Deliver every execution of this account not delivered yet. Returns how many were new.
        private static int CatchUp(Account a)
        {
            int n = 0;
            List<string> batch = new List<string>();
            try
            {
                List<Execution> list;
                lock (a.Executions) list = a.Executions.ToList();
                foreach (Execution x in list)
                {
                    if (!FirstTime(ExecKey(a.Name, x.ExecutionId, x.Time, x.Price, x.Quantity, x.OrderId))) continue;
                    Deliver(a.Name, x.Instrument, x.MarketPosition, x.Quantity, x.Price, x.Time, x.ExecutionId, x.OrderId, batch);
                    n++;
                }
            }
            catch (Exception ex) { Log("could not read executions for " + a.Name + ": " + ex.Message); }
            ChartBridgeDesk.QueueMany(batch);
            return n;
        }

        private static void PollExecutions()
        {
            List<Account> accounts;
            lock (Watched) accounts = Watched.ToList();
            int n = 0;
            foreach (Account a in accounts) n += CatchUp(a);
            lastPollMs = (long)ChartBridgeTime.NowUtcMs();
            if (n > 0)
            {
                Interlocked.Add(ref polledNew, n);
                if (Interlocked.Read(ref eventNew) == 0) Log("found " + n + " new fill(s) by polling; the fill event has not fired yet in this session");
                ChartBridgeDesk.Flush();
            }
        }

        private static void WatchAccounts()
        {
            List<Account> fresh = new List<Account>();
            lock (Account.All)
            {
                foreach (Account a in Account.All) fresh.Add(a);
            }
            List<Account> added = new List<Account>();
            lock (Watched)
            {
                foreach (Account a in fresh)
                {
                    if (Watched.Contains(a) || !ChartBridgeConfig.AccountAllowed(a.Name)) continue;
                    a.ExecutionUpdate += OnExecutionUpdate;
                    a.OrderUpdate += OnOrderUpdate;
                    a.PositionUpdate += OnPositionUpdate;
                    Watched.Add(a);
                    added.Add(a);
                    Log("watching fills on account " + a.Name);
                }
            }
            // Fills that happened before this account was watched (earlier this session) go to The Desk too;
            // The Desk ignores ones it already has.
            int n = 0;
            foreach (Account a in added) n += CatchUp(a);
            if (n > 0) ChartBridgeDesk.Flush();
        }

        // Order code calls this before trading an account: an account that just connected may not be watched yet,
        // and an unwatched account's fills and order updates would never reach the page.
        public static bool EnsureWatched(Account a)
        {
            if (a == null) return false;
            lock (Watched) { if (Watched.Contains(a)) return true; }
            try { WatchAccounts(); } catch (Exception ex) { Log("watch accounts failed: " + ex.Message); }
            lock (Watched) return Watched.Contains(a);
        }

        private static void Unwatch()
        {
            lock (Watched)
            {
                foreach (Account a in Watched)
                {
                    try { a.ExecutionUpdate -= OnExecutionUpdate; } catch (Exception) { }
                    try { a.OrderUpdate -= OnOrderUpdate; } catch (Exception) { }
                    try { a.PositionUpdate -= OnPositionUpdate; } catch (Exception) { }
                }
                Watched.Clear();
            }
            lock (Seen) Seen.Clear();
        }

        private static void OnOrderUpdate(object sender, OrderEventArgs e)
        {
            Account a = sender as Account;
            Count(a != null ? a.Name : "", 1);
            try { ChartBridgeOrders.OnOrderUpdate(a, e); } catch (Exception ex) { Log("order update error: " + ex.Message); }
        }

        private static void OnPositionUpdate(object sender, PositionEventArgs e)
        {
            Account a = sender as Account;
            Count(a != null ? a.Name : "", 2);
            try { ChartBridgeOrders.OnPositionUpdate(a, e); } catch (Exception ex) { Log("position update error: " + ex.Message); }
        }

        // GET /diag: what ChartBridge sees, for checking why fills do or do not arrive. This PC only.
        private static string DiagJson()
        {
            StringBuilder b = new StringBuilder("{");
            b.Append("\"version\":").Append(CbJson.Str(Version));
            b.Append(",\"clockOffsetMs\":").Append(CbJson.Num3(ChartBridgeTime.UtcMs(DateTime.UtcNow) - ChartBridgeTime.NowUtcMs()));
            b.Append(",\"fillEventsDelivered\":").Append(Interlocked.Read(ref eventNew));
            b.Append(",\"fillsFoundByPolling\":").Append(Interlocked.Read(ref polledNew));
            b.Append(",\"lastPollUtcMs\":").Append(lastPollMs);
            b.Append(",\"clients\":").Append(Clients.Count);
            b.Append(",\"network\":").Append(ChartBridgeAccess.DiagJson());
            b.Append(",\"pin\":").Append(ChartBridgePin.DiagJson());   // whether a PIN is set, nothing else
            b.Append(",\"desk\":").Append(ChartBridgeDesk.DiagJson());
            b.Append(",\"accounts\":[");
            List<Account> accounts;
            lock (Watched) accounts = Watched.ToList();
            bool first = true;
            foreach (Account a in accounts.OrderBy(x => x.Name))
            {
                if (!first) b.Append(','); first = false;
                long[] c;
                lock (EventCounts) { if (!EventCounts.TryGetValue(a.Name, out c)) c = new long[3]; c = (long[])c.Clone(); }
                b.Append("{\"name\":").Append(CbJson.Str(a.Name));
                b.Append(",\"connection\":").Append(CbJson.Str(ConnectionText(a)));
                b.Append(",\"executions\":").Append(SafeCount(delegate { lock (a.Executions) return a.Executions.Count; }));
                b.Append(",\"orders\":").Append(SafeCount(delegate { lock (a.Orders) return a.Orders.Count; }));
                b.Append(",\"positions\":").Append(SafeCount(delegate { lock (a.Positions) return a.Positions.Count; }));
                b.Append(",\"fillEvents\":").Append(c[0]).Append(",\"orderEvents\":").Append(c[1]).Append(",\"positionEvents\":").Append(c[2]);
                b.Append('}');
            }
            b.Append("]}");
            return b.ToString();
        }

        private static string SafeCount(Func<int> f)
        {
            try { return f().ToString(CultureInfo.InvariantCulture); } catch (Exception ex) { return CbJson.Str("error: " + ex.Message); }
        }

        private static string ConnectionText(Account a)
        {
            try { return a.Connection == null ? "none" : a.Connection.Status.ToString(); } catch (Exception ex) { return "error: " + ex.Message; }
        }

        private static string ExecJson(string account, Instrument inst, MarketPosition side, int qty, double price, DateTime time, string id, string orderId, bool withType)
        {
            DateTime utc = ChartBridgeTime.ToUtc(time);
            StringBuilder b = new StringBuilder();
            b.Append('{');
            if (withType) b.Append("\"type\":\"exec\",");
            b.Append("\"account\":").Append(CbJson.Str(account))
             .Append(",\"name\":").Append(CbJson.Str(inst != null ? inst.FullName : ""))
             .Append(",\"root\":").Append(CbJson.Str(inst != null ? inst.MasterInstrument.Name : ""))
             .Append(",\"side\":").Append(CbJson.Str(side == MarketPosition.Long ? "buy" : "sell"))
             .Append(",\"qty\":").Append(qty.ToString(CultureInfo.InvariantCulture))
             .Append(",\"p\":").Append(CbJson.Num(price))
             .Append(",\"t\":").Append(CbJson.Num3(ChartBridgeTime.EtSeconds(utc)))
             .Append(",\"u\":").Append(CbJson.Num3(ChartBridgeTime.UtcMs(utc)))
             .Append(",\"id\":").Append(CbJson.Str(id))
             .Append(",\"order\":").Append(CbJson.Str(orderId)).Append('}');
            return b.ToString();
        }

        // One fill in The Desk's POST /api/fills shape.
        private static string DeskFillJson(string account, Instrument inst, MarketPosition side, int qty, double price, DateTime time, string id, string orderId)
        {
            DateTime utc = ChartBridgeTime.ToUtc(time);
            return "{\"source\":\"nt8\",\"account\":" + CbJson.Str(account) +
                ",\"instrument\":" + CbJson.Str(inst != null ? inst.FullName : "") +
                ",\"root\":" + CbJson.Str(inst != null ? inst.MasterInstrument.Name : "") +
                ",\"side\":" + CbJson.Str(side == MarketPosition.Long ? "buy" : "sell") +
                ",\"qty\":" + qty.ToString(CultureInfo.InvariantCulture) +
                ",\"price\":" + CbJson.Num(price) +
                ",\"time_utc_ms\":" + Math.Round(ChartBridgeTime.UtcMs(utc)).ToString(CultureInfo.InvariantCulture) +
                ",\"exec_id\":" + CbJson.Str(id) +
                ",\"order_id\":" + CbJson.Str(orderId) + "}";
        }

        private static string ExecsJson()
        {
            StringBuilder b = new StringBuilder("{\"type\":\"execs\",\"list\":[");
            bool first = true;
            List<Account> accounts;
            lock (Watched) accounts = Watched.ToList();
            foreach (Account a in accounts)
            {
                try
                {
                    lock (a.Executions)
                    {
                        foreach (Execution x in a.Executions)
                        {
                            if (!first) b.Append(','); first = false;
                            b.Append(ExecJson(a.Name, x.Instrument, x.MarketPosition, x.Quantity, x.Price, x.Time, x.ExecutionId, x.OrderId, false));
                        }
                    }
                }
                catch (Exception ex) { Log("could not read executions for " + a.Name + ": " + ex.Message); }
            }
            b.Append("]}");
            return b.ToString();
        }

        private static void OnExecutionUpdate(object sender, ExecutionEventArgs e)
        {
            try
            {
                Account a = sender as Account;
                string name = a != null ? a.Name : "";
                Count(name, 0);
                Instrument inst = e.Execution != null ? e.Execution.Instrument : null;   // ExecutionEventArgs has no Instrument of its own
                if (!FirstTime(ExecKey(name, e.ExecutionId, e.Time, e.Price, e.Quantity, e.OrderId))) return;
                Interlocked.Increment(ref eventNew);
                Deliver(name, inst, e.MarketPosition, e.Quantity, e.Price, e.Time, e.ExecutionId, e.OrderId, null);
                ChartBridgeDesk.Flush();
            }
            catch (Exception ex) { Log("fill error: " + ex.Message); }
        }
    }
}
