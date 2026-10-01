// ChartBridge 0.3.6 for NinjaTrader 8
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
// Install: copy this file, ChartBridgeOrders.cs, ChartBridgePin.cs and ChartBridgeBars.cs to Documents\NinjaTrader 8\bin\Custom\AddOns\ and the page files to
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
using System.Reflection;
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
        public static int RangeHours = 2;                           // 0.3.5: the hours of trades a tick chart gets before "ready" (the served window)
        public static string[] ProfileRoots = new string[] { "MNQ", "NQ", "ES", "MES" };   // 0.3.5: roots whose session is loaded once at start, in this order
        public static Dictionary<string, string> ContractOverride = new Dictionary<string, string>();
        public static bool PostFills = false;                       // send fills to The Desk
        public static string DeskUrl = "http://localhost:8800";
        public static List<string> AccountAllow = new List<string>();   // empty = every account except Backtest / Playback
        public static List<string> AllowOrigins = new List<string>();   // web pages besides ChartBridge's own that may open the read-only WebSocket
        public static int QuoteHours = 0;                           // 0.3.4.1: hours of historical Bid and Ask a tick chart asks for (0, 1 or 2)

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
        //   rangeHours = 2                (0.3.5: the hours of recent trades a Range or seconds chart starts with; 1 to 8)
        //   profileRoots = MNQ, NQ, ES, MES
        //                                 (0.3.5: when ChartBridge starts after 18:00 ET, the instruments whose session so far
        //                                  is loaded once, one at a time in this order, for an exact volume profile; others
        //                                  count from the live trades only. Default all four.)
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
        //   quoteHours = 0                (0.3.4.1: hours of historical Bid and Ask ticks a tick chart asks NinjaTrader for,
        //                                  to side its backfill trades: 0 (the default: none; they go by the tick rule),
        //                                  1 or 2. Anything else is 0, with a line in the Output window.)
        //   bars = on, barsRoots, pc      (0.3.6: daily 1-minute bars to The Desk; off by default; see ChartBridgeBars.cs)
        public static void Load()
        {
            ChartBridgeOrders.ResetConfig();
            AllowOrigins = new List<string>();
            QuoteHours = 0;
            ChartBridgeBars.ResetConfig();
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
                else if (key == "rangeHours" && int.TryParse(val, out n)) RangeHours = Math.Max(1, Math.Min(8, n));
                else if (key == "profileRoots") ProfileRoots = val.Split(',').Select(s => s.Trim().ToUpperInvariant()).Where(s => s.Length > 0).ToArray();
                else if (key == "roots") Roots = val.Split(',').Select(s => s.Trim().ToUpperInvariant()).Where(s => s.Length > 0).ToArray();
                else if (key.StartsWith("contract.")) ContractOverride[key.Substring(9).Trim().ToUpperInvariant()] = val;
                else if (key == "postFills") PostFills = val.Equals("true", StringComparison.OrdinalIgnoreCase) || val == "1";
                else if (key == "deskUrl") DeskUrl = val.TrimEnd('/');
                else if (key == "accounts") AccountAllow = val.Split(',').Select(x => x.Trim()).Where(x => x.Length > 0).ToList();
                else if (key == "allowOrigins") AllowOrigins = ChartBridgeAccess.ParseOrigins(val);
                else if (key == "quoteHours") QuoteHours = ParseQuoteHours(val);
                else if (ChartBridgeBars.ReadConfig(key, val)) { }   // bars, barsRoots, pc (ChartBridgeBars.cs)
                else ChartBridgeOrders.ReadConfig(key, val);   // trading, tradeAccounts, maxQty.<ROOT>
            }
        }

        // quoteHours (0.3.4.1): the whole numbers 0, 1 or 2; anything else is 0 (no bid/ask history), said in the Output window.
        public static int ParseQuoteHours(string val)
        {
            int n;
            if (int.TryParse(val, out n) && n >= 0 && n <= 2) return n;
            ChartBridgeServer.Log("config.txt: quoteHours = " + val + " is not 0, 1 or 2; using 0 (no bid/ask history is asked)");
            return 0;
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

        // 0.3.5: EtSeconds(ToUtc(nt)) for many times in a row, the same value to the bit. The New York wall clock is the
        // NinjaTrader time plus an offset that changes only at a daylight saving change of either zone. Per hour of
        // NinjaTrader time the offset is read at the hour's first and last tick: equal, it holds for the whole hour (a
        // change inside the hour would show at one end); different, every time in that hour is converted in full.
        // Not thread safe: one per formatting loop.
        public class EtCache
        {
            private long hour = long.MinValue, offset;
            private bool exact;
            private static long EtTicks(DateTime nt) { return TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(ToUtc(nt), DateTimeKind.Utc), Eastern).Ticks; }
            public double Seconds(DateTime nt)
            {
                long h = nt.Ticks / TimeSpan.TicksPerHour;
                if (h != hour)
                {
                    hour = h;
                    DateTime a = new DateTime(h * TimeSpan.TicksPerHour, nt.Kind), z = new DateTime(h * TimeSpan.TicksPerHour + TimeSpan.TicksPerHour - 1, nt.Kind);
                    long oa = EtTicks(a) - a.Ticks, oz = EtTicks(z) - z.Ticks;
                    exact = oa != oz; offset = oa;
                }
                if (exact) return EtSeconds(ToUtc(nt));
                return new TimeSpan(nt.Ticks + offset - Epoch.Ticks).TotalSeconds;   // as EtSeconds computes it
            }
        }
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

        // 0.3.5: the same text as Num3 and Num, written straight into b with no string made per number, for the millions of
        // trades in a backfill (formatting was about 2.4 us a trade, most of ChartBridge's own cost). Only values the fast
        // path writes exactly are taken; anything else goes through Num3 or Num. The harness compares both on random values.
        public static void AppendNum3(StringBuilder b, double v)
        {
            double r = Math.Round(v, 3);
            if (!(Math.Abs(r) < 1e12)) { b.Append(Num3(v)); return; }
            long m = (long)Math.Round(r * 1000);
            if (m == 0) { b.Append(Num3(v)); return; }   // 0 and -0: whatever the runtime writes
            if (m < 0) { b.Append('-'); m = -m; }
            AppendLong(b, m / 1000);
            AppendFraction(b, m % 1000, 3);
        }

        public static void AppendNum(StringBuilder b, double v)
        {
            double a = Math.Abs(v);
            if (a >= 0.001 && a < 1e9)
            {
                long m = (long)Math.Round(v * 1e6);
                if ((double)m / 1e6 == v)   // v is exactly this decimal of at most 6 places: that is its shortest round-trip text
                {
                    if (m < 0) { b.Append('-'); m = -m; }
                    AppendLong(b, m / 1000000);
                    AppendFraction(b, m % 1000000, 6);
                    return;
                }
            }
            b.Append(Num(v));
        }

        public static void AppendLong(StringBuilder b, long v)
        {
            if (v < 0) { if (v == long.MinValue) { b.Append(v.ToString(CultureInfo.InvariantCulture)); return; } b.Append('-'); v = -v; }
            if (v < 10) { b.Append((char)('0' + v)); return; }
            int start = b.Length;
            while (v > 0) { b.Append((char)('0' + (int)(v % 10))); v /= 10; }
            for (int i = start, j = b.Length - 1; i < j; i++, j--) { char c = b[i]; b[i] = b[j]; b[j] = c; }
        }

        // ".ddd" for frac of `places` digits, trailing zeros dropped (nothing when frac is 0).
        private static void AppendFraction(StringBuilder b, long frac, int places)
        {
            if (frac == 0) return;
            int keep = places;
            while (frac % 10 == 0) { frac /= 10; keep--; }
            b.Append('.');
            long div = 1; for (int i = 1; i < keep; i++) div *= 10;
            for (; div > 0; div /= 10) { b.Append((char)('0' + (int)(frac / div % 10))); }
        }
    }

    // ------------------------------------------------------------------ bars copied out of a BarsRequest
    // (copy fast inside NinjaTrader's callback, serialize later on a worker thread)
    public class RawBars
    {
        public int Count;
        public DateTime[] Time;
        public double[] Open, High, Low, Close;
        public long[] Volume;
        public double[] Bid, Ask;               // tick series only: NinjaTrader's bid and ask stamped on the trades from StampFrom on (CopyTicks)
        public int StampFrom = -1;

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

        // A tick series (close, volume and time), plus the bid and ask NinjaTrader stamps on its last StampSample trades
        // (Bars.GetBid and GetAsk), a sample kept for /diag only (0.3.4), so NinjaTrader's answer thread does little extra
        // work. A connection without them leaves Bid and Ask null.
        public const int StampSample = 2000;
        public static RawBars CopyTicks(Bars bars)
        {
            RawBars r = Copy(bars, true);
            try
            {
                int from = Math.Max(0, r.Count - StampSample), m = r.Count - from;
                double[] b = new double[m], a = new double[m];
                for (int i = 0; i < m; i++) { b[i] = bars.GetBid(from + i); a[i] = bars.GetAsk(from + i); }
                r.Bid = b; r.Ask = a; r.StampFrom = from;
            }
            catch (Exception) { r.Bid = null; r.Ask = null; r.StampFrom = -1; }
            return r;
        }

        // Bars i0 (inclusive) to i1 (exclusive) as a new RawBars.
        public RawBars Slice(int i0, int i1)
        {
            i0 = Math.Max(0, i0); i1 = Math.Min(Count, i1);
            int n = Math.Max(0, i1 - i0);
            RawBars r = new RawBars();
            r.Count = n;
            r.Time = new DateTime[n]; Array.Copy(Time, i0, r.Time, 0, n);
            r.Close = new double[n]; Array.Copy(Close, i0, r.Close, 0, n);
            r.Volume = new long[n]; Array.Copy(Volume, i0, r.Volume, 0, n);
            if (Open != null)
            {
                r.Open = new double[n]; Array.Copy(Open, i0, r.Open, 0, n);
                r.High = new double[n]; Array.Copy(High, i0, r.High, 0, n);
                r.Low = new double[n]; Array.Copy(Low, i0, r.Low, 0, n);
            }
            return r;
        }
    }

    // ------------------------------------------------------------------ the seam between backfill and live (0.3.3)
    // A live trade held while the backfill loads, with NinjaTrader's own time for it (e.Time, in NinjaTrader's
    // time zone, the same basis as the backfill's bar times; never the PC clock).
    public struct SeamTick
    {
        public DateTime Time;
        public double Price;
        public long Volume;
        public string Json;     // the "tick" message as it goes to the page
        public int Side, Method;   // 0.3.4: its side and method as tagged live (in Json too); not part of the seam's match
    }

    // What one subscribe's seam did, for /diag.
    public class SeamResult
    {
        public List<SeamTick> Release = new List<SeamTick>();   // held trades to send after "ready", in the order they came
        public int Held, DroppedOlder, DroppedSameTime;
        public int HeldAtAnswer;             // held when NinjaTrader answered the tick request; only these can match at T
        public int DroppedAfterAnswer;       // held after the answer that matched at T (dropped at ms resolution, kept at whole seconds)
        public int OlderAfterAnswer;         // held after the answer but older than T (dropped): NinjaTrader delivered it late
        public int BackfillTicks;
        public bool HasBackfillEnd;
        public DateTime BackfillEnd;         // the last backfill trade's time (NinjaTrader time zone)
        public long ResolutionTicks;         // the time step both sides were compared at (DateTime ticks: 10000 = 1 ms)
        public int Dropped { get { return DroppedOlder + DroppedSameTime; } }
    }

    // One rule decides the seam. The backfill is everything NinjaTrader had when it answered the tick request (made
    // after the hold began), and the held live trades are everything that arrived after the hold began. They overlap;
    // this removes the overlap from the held side. Let T be the time of the last backfill trade:
    //   - a held trade before T is in the backfill already: dropped;
    //   - at exactly T, as many held trades are dropped as the backfill has at T with the same price and volume (a
    //     multiset match: trades carry no id, and two real trades can share price, size and time). At whole-second
    //     resolution only trades held by the time NinjaTrader answered (heldAtAnswer, counted under the Pending lock
    //     in the answer's callback, after the copy) may match: "at T" is then a whole second, and a trade held after
    //     the answer, later in that second, is a real trade the backfill cannot have. At millisecond resolution every
    //     held trade may match (exact whatever order NinjaTrader delivers in); droppedAfterAnswer counts the ones
    //     held after the answer that matched, olderAfterAnswer the ones held after the answer but older than T.
    //   - the rest are released in the order they arrived.
    // Times are compared at the coarser resolution of the two sides. NinjaTrader 8 keeps millisecond times on tick
    // data from most connections. A side counts as whole seconds when its trades near the seam (the backfill's last
    // 64, the first 64 held) all sit on whole seconds and there are at least 20 of them; a backfill shorter than
    // that counts when every trade in it does (the whole backfill was read). Then "at T" is that whole second.
    public static class ChartBridgeSeam
    {
        public const long Ms = TimeSpan.TicksPerMillisecond, Second = TimeSpan.TicksPerSecond;
        public const int ResolutionSample = 64;   // trades read near the seam to judge a side's resolution
        public const int MinForSeconds = 20;      // fewer than this can land on whole seconds by chance

        // Coarsest step every time in times[from..to) sits on: 1 s (only with at least minForSeconds times), 1 ms,
        // or 1 (DateTime's 100 ns). Empty: 1.
        public static long Resolution(IList<DateTime> times, int from, int to) { return Resolution(times, from, to, MinForSeconds); }

        public static long Resolution(IList<DateTime> times, int from, int to, int minForSeconds)
        {
            bool seconds = true, ms = true;
            int n = 0;
            for (int i = Math.Max(0, from); i < to; i++)
            {
                long t = times[i].Ticks;
                n++;
                if (t % Second != 0) seconds = false;
                if (t % Ms != 0) { ms = false; break; }
            }
            if (n == 0 || !ms) return 1;
            return seconds && n >= Math.Max(1, minForSeconds) ? Second : Ms;
        }

        private static long Key(DateTime t, long unit) { long k = t.Ticks; return k - k % unit; }
        private static string TradeKey(double p, long v)   // price exact for any tick size down to 0.000001
        {
            return ((long)Math.Round(p * 1e6)).ToString(CultureInfo.InvariantCulture) + "|" + v.ToString(CultureInfo.InvariantCulture);
        }

        // Every held trade counts as held before the answer (the pure cases and a caller with no count).
        public static SeamResult Dedupe(DateTime[] backTime, double[] backPrice, long[] backVolume, int backCount, IList<SeamTick> held)
        {
            return Dedupe(backTime, backPrice, backVolume, backCount, held, held != null ? held.Count : 0);
        }

        // backTime/backPrice/backVolume: the tick backfill (first backCount entries, oldest first).
        // held: the live trades held since the hold began, in arrival order; the first heldAtAnswer of them were held
        // when NinjaTrader answered the tick request. Pure: changes neither input.
        public static SeamResult Dedupe(DateTime[] backTime, double[] backPrice, long[] backVolume, int backCount, IList<SeamTick> held, int heldAtAnswer)
        {
            SeamResult r = new SeamResult();
            int nHeld = held != null ? held.Count : 0;
            heldAtAnswer = Math.Max(0, Math.Min(nHeld, heldAtAnswer));
            r.Held = nHeld;
            r.HeldAtAnswer = heldAtAnswer;
            r.BackfillTicks = Math.Max(0, backCount);
            if (backCount <= 0 || backTime == null)
            {
                for (int i = 0; i < nHeld; i++) r.Release.Add(held[i]);
                r.ResolutionTicks = 1;
                return r;
            }
            r.HasBackfillEnd = true;
            r.BackfillEnd = backTime[backCount - 1];
            int sample = Math.Min(nHeld, ResolutionSample);
            DateTime[] heldTimes = new DateTime[sample];
            for (int i = 0; i < sample; i++) heldTimes[i] = held[i].Time;
            // A short backfill is read whole, so it may count as whole seconds with fewer than 20 trades (review N2).
            long unit = Math.Max(Resolution(backTime, backCount - ResolutionSample, backCount, Math.Min(MinForSeconds, backCount)), Resolution(heldTimes, 0, sample));
            r.ResolutionTicks = unit;
            if (nHeld == 0) return r;
            long end = Key(backTime[backCount - 1], unit);
            // The backfill's trades at T, counted by (price, volume).
            Dictionary<string, int> atEnd = new Dictionary<string, int>();
            for (int i = backCount - 1; i >= 0 && Key(backTime[i], unit) == end; i--)
            {
                string k = TradeKey(backPrice[i], backVolume[i]);
                int c; atEnd.TryGetValue(k, out c); atEnd[k] = c + 1;
            }
            for (int i = 0; i < nHeld; i++)
            {
                SeamTick h = held[i];
                long k = Key(h.Time, unit);
                if (k < end)
                {
                    r.DroppedOlder++;
                    if (i >= heldAtAnswer) r.OlderAfterAnswer++;   // arrived after the answer yet older than T: NinjaTrader delivered late
                    continue;
                }
                if (k == end)
                {
                    string pk = TradeKey(h.Price, h.Volume);
                    int c;
                    if (atEnd.TryGetValue(pk, out c) && c > 0)
                    {
                        atEnd[pk] = c - 1;
                        if (i >= heldAtAnswer) r.DroppedAfterAnswer++;   // held after the answer, matching at T
                        if (i < heldAtAnswer || unit < Second) { r.DroppedSameTime++; continue; }
                        // whole seconds and held after the answer: a real trade later in T's second, kept
                    }
                }
                r.Release.Add(h);
            }
            return r;
        }

        // The minute history's last bar was still forming when NinjaTrader answered, so it holds some trades that
        // may also be held live, and misses the ones after. So it is rebuilt (with any minute after it) from the
        // tick backfill, which the held trades are then matched against: minute bars and ticks meet at one seam.
        // tailClose: the last minute bar's time. NinjaTrader stamps time bars at their close, so a trade at exactly
        // hh:mm:00.000 belongs to the bar that ends then (the one before the tail); the rebuild takes trades strictly
        // after the tail's start, and a trade exactly on a later boundary goes to the bar ending there. (Believed to be
        // NinjaTrader's rule; a live check, see PROTOCOL.md.)
        // Returns the bars that replace that last bar (stamped at their close, like NinjaTrader's), or null when the
        // ticks cannot stand in for it: they start after the bar's start (NinjaTrader sent less tick history),
        // or have no trade after it. The caller also keeps NinjaTrader's bar when the rebuilt one has less volume.
        public static RawBars TailFromTicks(DateTime tailClose, DateTime[] tickTime, double[] tickPrice, long[] tickVolume, int tickCount)
        {
            if (tickTime == null || tickCount <= 0) return null;
            long minute = TimeSpan.TicksPerMinute;
            long tailStart = tailClose.Ticks - minute;
            if (tickTime[0].Ticks > tailStart) return null;
            int first = tickCount;
            for (int i = tickCount - 1; i >= 0 && tickTime[i].Ticks > tailStart; i--) first = i;
            if (first >= tickCount) return null;
            List<DateTime> t = new List<DateTime>(); List<double> o = new List<double>(), h = new List<double>(), l = new List<double>(), c = new List<double>();
            List<long> v = new List<long>();
            long cur = long.MinValue;
            for (int i = first; i < tickCount; i++)
            {
                long k = tickTime[i].Ticks, rem = k % minute, b = rem == 0 ? k - minute : k - rem;   // b: the start of the bar holding k
                double p = tickPrice[i];
                if (b != cur)
                {
                    cur = b;
                    t.Add(new DateTime(b + minute, tickTime[i].Kind)); o.Add(p); h.Add(p); l.Add(p); c.Add(p); v.Add(tickVolume[i]);
                }
                else
                {
                    int j = t.Count - 1;
                    if (p > h[j]) h[j] = p;
                    if (p < l[j]) l[j] = p;
                    c[j] = p; v[j] += tickVolume[i];
                }
            }
            RawBars r = new RawBars();
            r.Count = t.Count;
            r.Time = t.ToArray(); r.Open = o.ToArray(); r.High = h.ToArray(); r.Low = l.ToArray(); r.Close = c.ToArray(); r.Volume = v.ToArray();
            return r;
        }
    }

    // ------------------------------------------------------------------ the side of every trade (0.3.4)
    // Cumulative delta needs each trade's side: a market buy (the aggressor lifted the ask) or a market sell (the
    // aggressor hit the bid). NinjaTrader 8 gives an add-on no exchange aggressor flag: MarketDataEventArgs has Ask, Bid,
    // Instrument, IsReset, MarketDataType, Price, Time and Volume, nothing more (nt8/PROTOCOL.md, Trade side). So
    // ChartBridge infers the side, by the rule Anthony approved (2026-09-29), and says how it did (the method):
    //   1 (aggressor): the exchange's aggressor flag. Reserved: NinjaTrader 8 does not expose one, so never sent today.
    //   2 (bidAsk): the prevailing quote. At or above the ask, a buy; at or below the bid, a sell. The quote must have
    //     both sides, above zero, bid below ask (a crossed or locked quote is not used).
    //   3 (tickRule): between bid and ask, or with no usable quote: above the previous trade's price a buy, below it a
    //     sell, at the same price the previous trade's side (Lee-Ready; Anthony kept it over NinjaTrader's "same side
    //     as the previous trade" for between-quote trades, 2026-09-30).
    //   0 (none): no usable quote and no previous trade (or the same price as an unclassified one): side 0.
    // Side: 1 buy, -1 sell, 0 unknown.
    // The prevailing quote, live and in the backfill alike, is the last bid and the last ask stamped STRICTLY BEFORE the
    // trade (the tie rule): a quote stamped at the trade's own time is not used, because a trade and the quote change it
    // causes (the ask it lifted moving up, the bid stepping up to the traded price) share one timestamp, and taking that
    // later quote can call a buy a sell. A quote stamped after the trade is never used. A quote older than QuoteMaxAge
    // (60 s) before the trade is stale (a hole in the data, a disconnect): the tick rule, counted in /diag.
    public static class ChartBridgeSides
    {
        public const int None = 0, Aggressor = 1, BidAsk = 2, TickRule = 3;
        public const long QuoteMaxAge = 60 * TimeSpan.TicksPerSecond;

        // Prices compared on a 0.000001 grid, so float noise (0.1 + 0.2 against 0.3) is the same price.
        public static long PriceKey(double p) { return (long)Math.Round(p * 1e6); }

        public static bool QuoteUsable(double bid, double ask)
        {
            if (double.IsNaN(bid) || double.IsNaN(ask) || double.IsInfinity(bid) || double.IsInfinity(ask) || bid <= 0 || ask <= 0) return false;
            return PriceKey(bid) < PriceKey(ask);
        }

        // One trade. hasPrev, prevPrice, prevSide: the previous trade of the same stream, whatever its method.
        public static int Classify(double price, double bid, double ask, bool hasPrev, double prevPrice, int prevSide, out int method)
        {
            if (QuoteUsable(bid, ask))
            {
                long p = PriceKey(price);
                if (p >= PriceKey(ask)) { method = BidAsk; return 1; }
                if (p <= PriceKey(bid)) { method = BidAsk; return -1; }
            }
            return ByTickRule(price, hasPrev, prevPrice, prevSide, out method);
        }

        public static int ByTickRule(double price, bool hasPrev, double prevPrice, int prevSide, out int method)
        {
            int s = 0;
            if (hasPrev)
            {
                long p = PriceKey(price), q = PriceKey(prevPrice);
                s = p > q ? 1 : p < q ? -1 : prevSide;
            }
            method = s == 0 ? None : TickRule;
            return s;
        }

        // The released held trades after a load's seam (review N3): their tick rule continues from the backfill's copy of
        // the seam trade (time, price, side), not from its dropped live twin. Quote-classified trades keep their side;
        // tick-rule and unknown ones are worked out again along the chain (starting over at 18:00 ET, SessionClock) and
        // their message rewritten. Returns new copies (SeamTick is a struct); end*: the chain's last trade.
        public static List<SeamTick> ContinueTickRule(IList<SeamTick> release, DateTime lastTime, double lastPrice, int lastSide,
                                                      out DateTime endTime, out double endPrice, out int endSide)
        {
            List<SeamTick> outList = new List<SeamTick>(release.Count);
            SessionClock session = new SessionClock();
            session.NewSession(lastTime);
            foreach (SeamTick h0 in release)
            {
                SeamTick h = h0;
                bool samePrev = !session.NewSession(h.Time);   // 18:00 ET: the tick rule starts over
                if (h.Method == None || h.Method == TickRule)
                {
                    int m;
                    int s = ByTickRule(h.Price, samePrev, lastPrice, lastSide, out m);
                    if (s != h.Side || m != h.Method)
                    {
                        int cut = h.Json.LastIndexOf(",\"s\":", StringComparison.Ordinal);
                        if (cut > 0) h.Json = h.Json.Substring(0, cut) + ",\"s\":" + s.ToString(CultureInfo.InvariantCulture) + ",\"sm\":" + m.ToString(CultureInfo.InvariantCulture) + "}";
                        h.Side = s; h.Method = m;
                    }
                }
                outList.Add(h);
                lastTime = h.Time; lastPrice = h.Price; lastSide = h.Side;
            }
            endTime = lastTime; endPrice = lastPrice; endSide = lastSide;
            return outList;
        }

        private static long Key(DateTime t, long unit) { long k = t.Ticks; return k - k % unit; }

        // Quote row j as of a trade at key k: its last update before the trade is at most QuoteMaxAge old. With a thinned
        // series that update is Seen[j] when Seen[j] is before the trade; otherwise the trade is within the 5 s heartbeat of
        // row j, so the quote is fresh either way.
        private static bool Fresh(IList<DateTime> time, IList<DateTime> seen, int j, long k, long unit)
        {
            long kept = Key(time[j], unit), last = seen != null ? Key(seen[j], unit) : kept;
            if (last >= k) last = kept;
            return k - last <= QuoteMaxAge;
        }
        public const long QuoteEndSlack = 5 * TimeSpan.TicksPerSecond;

        // The tick backfill, each trade by the quote prevailing at its time: an as-of join on NinjaTrader's historical Bid
        // and Ask ticks (QuoteSeries, oldest first), by the tie rule above. Times are compared at the coarser resolution of
        // the trades and the quotes (1 ms, or whole seconds; ChartBridgeSeam.Resolution), so at whole seconds "the same
        // time" is the same second. tieChanged in /diag counts the trades the other tie rule (a quote at the same time
        // counts) would have called differently.
        // Coverage: a trade is classified by the quote only when there is a bid and an ask before it, it is no more than
        // QuoteEndSlack (5 s) past the end of the shorter of the two quote histories (a history that stops early would
        // otherwise leave a stale quote in force), and neither quote is older than QuoteMaxAge (a hole in the middle).
        // Every other trade goes by the tick rule (beforeQuotes, afterQuotes, staleQuotes in /diag). No quote history at
        // all, or only one side: every trade by the tick rule.
        // stampBid/stampAsk (may be null): NinjaTrader's own bid and ask stamped on the trades from stampFrom on
        // (Bars.GetBid/GetAsk, a sample), only compared, for /diag. NinjaTrader's help says that with no bid/ask tied to
        // the trades it fills them in as Bid = Last and Ask = Bid + 1 tick. A real sell at the bid with a one-tick spread
        // looks the same, so one trade cannot tell; likeFillIn counts them, and likeFillIn equal to usable means the stamps
        // were filled in.
        public static BackfillSides ClassifyBackfill(DateTime[] tt, double[] tp, int n, IList<DateTime> bt, IList<double> bp, int nb, IList<DateTime> at, IList<double> ap, int na,
                                                     double[] stampBid, double[] stampAsk, int stampFrom, double tickSize)
        {
            return ClassifyBackfill(tt, tp, n, bt, bp, null, nb, at, ap, null, na, stampBid, stampAsk, stampFrom, tickSize);
        }

        // bs, as_: QuoteSeries.Seen for the bids and the asks (null: every row is there, Seen is the row's own time).
        public static BackfillSides ClassifyBackfill(DateTime[] tt, double[] tp, int n, IList<DateTime> bt, IList<double> bp, IList<DateTime> bs, int nb,
                                                     IList<DateTime> at, IList<double> ap, IList<DateTime> as_, int na,
                                                     double[] stampBid, double[] stampAsk, int stampFrom, double tickSize)
        {
            BackfillSides r = new BackfillSides();
            n = tt == null || tp == null ? 0 : Math.Max(0, Math.Min(n, Math.Min(tt.Length, tp.Length)));
            nb = bt == null || bp == null ? 0 : Math.Max(0, Math.Min(nb, Math.Min(bt.Count, bp.Count)));
            na = at == null || ap == null ? 0 : Math.Max(0, Math.Min(na, Math.Min(at.Count, ap.Count)));
            r.Trades = n;
            r.Side = new sbyte[n]; r.Method = new byte[n];
            if (nb > 0) { r.HasBid = true; r.FirstBid = bt[0]; r.LastBid = bt[nb - 1]; }
            if (na > 0) { r.HasAsk = true; r.FirstAsk = at[0]; r.LastAsk = at[na - 1]; }
            if (n > 0) { r.HasTrades = true; r.FirstTrade = tt[0]; r.LastTrade = tt[n - 1]; }
            int S = ChartBridgeSeam.ResolutionSample;
            r.TradeResolution = n > 0 ? ChartBridgeSeam.Resolution(tt, n - S, n) : 0;
            long rb = nb > 0 ? ChartBridgeSeam.Resolution(bt, nb - S, nb) : 0, ra = na > 0 ? ChartBridgeSeam.Resolution(at, na - S, na) : 0;
            r.QuoteResolution = Math.Max(rb, ra);
            long unit = Math.Max(1, Math.Max(r.TradeResolution, r.QuoteResolution));
            r.UnitTicks = unit;
            bool quotes = nb > 0 && na > 0;
            if (bs != null && bs.Count < nb) bs = null;
            if (as_ != null && as_.Count < na) as_ = null;
            if (nb > 0 && bs != null) r.LastBid = bs[nb - 1];   // the history's real end, not the last kept row
            if (na > 0 && as_ != null) r.LastAsk = as_[na - 1];
            long end = quotes ? Math.Min(Key(bs != null ? bs[nb - 1] : bt[nb - 1], unit), Key(as_ != null ? as_[na - 1] : at[na - 1], unit)) + QuoteEndSlack : long.MinValue;
            int ib = -1, ia = -1, ibi = -1, iai = -1;   // last bid/ask strictly before the trade; at or before it (for tieChanged)
            bool stamps = stampBid != null && stampAsk != null && stampFrom >= 0;
            bool hasPrev = false; double prevPrice = 0; int prevSide = 0;
            SessionClock session = new SessionClock();
            for (int i = 0; i < n; i++)
            {
                if (session.NewSession(tt[i])) { hasPrev = false; prevSide = 0; r.SessionStarts++; }   // 18:00 ET: the tick rule starts over
                long k = Key(tt[i], unit);
                while (ib + 1 < nb && Key(bt[ib + 1], unit) < k) ib++;
                while (ia + 1 < na && Key(at[ia + 1], unit) < k) ia++;
                if (ibi < ib) ibi = ib;
                if (iai < ia) iai = ia;
                while (ibi + 1 < nb && Key(bt[ibi + 1], unit) <= k) ibi++;
                while (iai + 1 < na && Key(at[iai + 1], unit) <= k) iai++;
                double p = tp[i];
                int m, s;
                bool inWindow = quotes && k <= end;
                if (inWindow && ib >= 0 && ia >= 0 && Fresh(bt, bs, ib, k, unit) && Fresh(at, as_, ia, k, unit))
                {
                    r.Quoted++;
                    s = Classify(p, bp[ib], ap[ia], hasPrev, prevPrice, prevSide, out m);
                    if (m != BidAsk) { if (QuoteUsable(bp[ib], ap[ia])) r.BetweenQuotes++; else r.CrossedQuotes++; }
                }
                else
                {
                    if (!inWindow || ib < 0 || ia < 0) { if (quotes && k > end && ib >= 0 && ia >= 0) r.AfterQuotes++; else r.BeforeQuotes++; }
                    else r.StaleQuotes++;
                    s = ByTickRule(p, hasPrev, prevPrice, prevSide, out m);
                }
                // The other tie rule (a quote at the trade's own time counts), for tieChanged: every trade, covered or not.
                int m2, s2;
                if (inWindow && ibi >= 0 && iai >= 0 && Fresh(bt, bs, ibi, k, unit) && Fresh(at, as_, iai, k, unit))
                    s2 = Classify(p, bp[ibi], ap[iai], hasPrev, prevPrice, prevSide, out m2);
                else s2 = ByTickRule(p, hasPrev, prevPrice, prevSide, out m2);
                if (s2 != s) r.TieChanged++;
                r.Side[i] = (sbyte)s; r.Method[i] = (byte)m; r.Counts[m]++;
                hasPrev = true; prevPrice = p; prevSide = s;
                int j = i - stampFrom;
                if (stamps && j >= 0 && j < stampBid.Length && j < stampAsk.Length)
                {
                    double sb = stampBid[j], sa = stampAsk[j];
                    if (!QuoteUsable(sb, sa)) r.StampMissing++;
                    else
                    {
                        r.StampUsable++;
                        if (tickSize > 0 && PriceKey(sb) == PriceKey(p) && PriceKey(sa) == PriceKey(p + tickSize)) r.StampLikeFillIn++;
                        long pk = PriceKey(p);
                        int ss = pk >= PriceKey(sa) ? 1 : pk <= PriceKey(sb) ? -1 : 0;
                        if (ss != 0 && s != 0) { if (ss == s) r.StampAgree++; else r.StampDisagree++; }
                    }
                }
            }
            return r;
        }
    }

    // A historical Bid or Ask series, as the join needs it (0.3.4): time and price only (no size), and only the rows that
    // can matter. Size-only updates never change the prevailing quote, so of a run of rows at one price only the first is
    // kept, plus one every HeartbeatTicks (5 s). Seen[j] is the time of the last row NinjaTrader sent from kept row j up to
    // the next kept row, so a quote's age is exact (review N1): the last update before a trade is Seen[j] when that is
    // before the trade, and otherwise less than 5 s old (the heartbeat). The history ends at the last Seen. Rows before
    // From (the quote window's start) are skipped.
    public class QuoteSeries
    {
        public const long HeartbeatTicks = 5 * TimeSpan.TicksPerSecond;
        public readonly List<DateTime> Time = new List<DateTime>();
        public readonly List<double> Price = new List<double>();
        public readonly List<DateTime> Seen = new List<DateTime>();
        public int RawRows;                  // rows NinjaTrader sent inside the window
        public int Count { get { return Time.Count; } }

        public static QuoteSeries From(Bars bars, DateTime from)
        {
            QuoteSeries q = new QuoteSeries();
            int n = bars.Count;
            long lastKept = long.MinValue;
            double lastPrice = double.NaN;
            for (int i = 0; i < n; i++)
            {
                DateTime t = bars.GetTime(i);
                if (t < from) continue;
                double p = bars.GetClose(i);
                q.RawRows++;
                if (q.Time.Count == 0 || ChartBridgeSides.PriceKey(p) != ChartBridgeSides.PriceKey(lastPrice) || t.Ticks - lastKept >= HeartbeatTicks)
                {
                    q.Time.Add(t); q.Price.Add(p); q.Seen.Add(t);
                    lastKept = t.Ticks; lastPrice = p;
                }
                else q.Seen[q.Seen.Count - 1] = t;
            }
            return q;
        }
    }

    // The trading session (0.3.4, Anthony's ruling 2026-09-30): CME equity index futures reopen at 18:00 New York time
    // (the page's session start too), and nothing carries across the 17:00 to 18:00 break (or a weekend): the tick rule
    // starts over, so the first trade of a session between the quotes, or with no usable quote, is side 0 (unknown). Times
    // are NinjaTrader's; the boundary is 18:00 America/New_York, daylight saving included (ChartBridgeTime.Eastern).
    public class SessionClock
    {
        private bool has;
        private DateTime start, end;         // the current session, [start, end), in NinjaTrader's time zone

        // Notes t and says whether it starts another session than the trade noted before it (false for the first).
        public bool NewSession(DateTime t)
        {
            if (has && t >= start && t < end) return false;
            bool had = has;
            Bounds(t, out start, out end);
            has = true;
            return had;
        }

        // The session holding NinjaTrader time t: from the last 18:00 New York time at or before t, for one day.
        public static void Bounds(DateTime nt, out DateTime start, out DateTime end)
        {
            TimeZoneInfo ntZone = NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo;
            DateTime et = TimeZoneInfo.ConvertTimeFromUtc(ChartBridgeTime.ToUtc(nt), ChartBridgeTime.Eastern);
            DateTime open = DateTime.SpecifyKind(et.Date.AddHours(18), DateTimeKind.Unspecified);
            if (et < open) open = open.AddDays(-1);
            start = DateTime.SpecifyKind(TimeZoneInfo.ConvertTimeFromUtc(TimeZoneInfo.ConvertTimeToUtc(open, ChartBridgeTime.Eastern), ntZone), nt.Kind);
            end = DateTime.SpecifyKind(TimeZoneInfo.ConvertTimeFromUtc(TimeZoneInfo.ConvertTimeToUtc(open.AddDays(1), ChartBridgeTime.Eastern), ntZone), nt.Kind);
        }
    }

    // ------------------------------------------------------------------ 0.3.5: per instrument, the session's volume at price and the served window
    // Two things ChartBridge keeps per instrument, both fed by the live trades (OnMarketData), so that no page load or reload
    // asks NinjaTrader again for what it already delivered (on WORK, 16 to 17 hour Range loads and the quote history froze
    // NinjaTrader for 8.5 to 10.9 s at a time, during RTH):
    //   SessionTable: the volume at each price of the session from 18:00 ET, per half hour of New York time (so the page can
    //   also draw the RTH profile, 9:30 to 16:00 or 13:00, from it). The page's volume profile is drawn from it, exactly as
    //   from every trade. Complete when ChartBridge saw the session start live; otherwise one backfill of the session so far,
    //   once, joined to the live trades by the 0.3.3 seam.
    //   TradeLog: the served window. The trades the first tick chart of the session got (the last rangeHours of trades, asked
    //   of NinjaTrader by count) and every live trade since; a reload or another page gets its trades from here. Dropped at the
    //   next session. Nothing about trades is written to disk.
    public class TradeLog
    {
        private const int Shift = 16, Size = 1 << Shift, Mask = Size - 1;
        private readonly List<long[]> times = new List<long[]>();
        private readonly List<double[]> prices = new List<double[]>();
        private readonly List<long[]> vols = new List<long[]>();
        public int Count;
        public int Served;                   // loads that got their window from here (for /diag)

        public void Add(DateTime t, double price, long volume)
        {
            if ((Count & Mask) == 0) { times.Add(new long[Size]); prices.Add(new double[Size]); vols.Add(new long[Size]); }
            int b = Count >> Shift, i = Count & Mask;
            times[b][i] = t.Ticks; prices[b][i] = price; vols[b][i] = volume;
            Count++;
        }
        public DateTime First { get { return Count > 0 ? new DateTime(times[0][0]) : DateTime.MinValue; } }

        // What is logged so far, fixed: the blocks are only ever appended to, so this copies block references, not trades
        // (the lock is held for microseconds); ToBars then copies the trades with no lock held.
        public View Snapshot() { return new View { T = times.ToArray(), P = prices.ToArray(), V = vols.ToArray(), Count = Count }; }
        public class View
        {
            public long[][] T; public double[][] P; public long[][] V; public int Count;
            public RawBars ToBars()
            {
                RawBars r = new RawBars { Count = Count, Time = new DateTime[Count], Close = new double[Count], Volume = new long[Count] };
                for (int i = 0; i < Count; i++) { int b = i >> Shift, k = i & Mask; r.Time[i] = new DateTime(T[b][k]); r.Close[i] = P[b][k]; r.Volume[i] = V[b][k]; }
                return r;
            }
        }
    }

    public class SessionTable
    {
        public const double BucketSeconds = 1800;   // half an hour of New York time: 9:30, 13:00 and 16:00 are bucket edges
        public DateTime Start, End;                  // the session, [Start, End), NinjaTrader time (SessionClock.Bounds)
        public double StartEt;                       // its start in bar-time seconds (New York wall clock), as the page keys it
        public bool Whole;                           // every trade of the session is in (else from CoveredFrom only)
        public double CoveredFromEt;
        public bool Dropped; public double DropAtEt; public string DropWhy;   // 0.3.5 S2: the feed dropped this session (never whole again)
        public readonly Dictionary<long, long> Vol = new Dictionary<long, long>();   // (half hour, price in ticks) -> volume
        public long Trades, Volume;

        public static long Key(double et, long priceTicks) { return ((long)Math.Floor(et / BucketSeconds) << 32) | (priceTicks & 0xFFFFFFFFL); }
        public static long PriceTicks(double price, double tick) { return (long)Math.Round(price / tick); }
        public void Add(double et, long priceTicks, long volume) { Add(Vol, et, priceTicks, volume); Trades++; Volume += volume; }
        public static void Add(Dictionary<long, long> d, double et, long priceTicks, long volume)
        {
            long k = Key(et, priceTicks), was;
            d.TryGetValue(k, out was);
            d[k] = was + volume;
        }
        // [[half hour start, price in ticks, volume], ...] in key order; `less` is taken off (trades the page gets as live ticks after it)
        public static void AppendRows(StringBuilder b, long[] keys, long[] vals, Dictionary<long, long> less)
        {
            long[] k2 = (long[])keys.Clone(), v2 = (long[])vals.Clone();
            Array.Sort(k2, v2);
            b.Append('[');
            bool first = true;
            for (int i = 0; i < k2.Length; i++)
            {
                long k = k2[i], v = v2[i], minus;
                if (less != null && less.TryGetValue(k, out minus)) v -= minus;
                if (v <= 0) continue;
                if (!first) b.Append(',');
                first = false;
                b.Append('[');
                CbJson.AppendLong(b, (k >> 32) * (long)BucketSeconds);
                b.Append(',');
                CbJson.AppendLong(b, (long)(uint)(k & 0xFFFFFFFFL));
                b.Append(',');
                CbJson.AppendLong(b, v);
                b.Append(']');
            }
            b.Append(']');
        }
    }

    // One instrument's table, last finished table, served window and live trade rate. Lock Sync for everything in it; the
    // market data handler takes it (then a page's Pending lock) for every trade, so a snapshot taken under it is exact. Only
    // short work runs under it: a trade's adds, and copies (snapshots) that the formatting then works from with no lock held.
    public class RootBook
    {
        public const int LiveCap = 500000;           // live trades kept for a seam (backfill or window) at most; past it the request is abandoned
        public const double StaleTradeSec = 120;     // a trade older than this (by the clock) never opens a session's table (S7)
        public readonly object Sync = new object();
        public readonly string Root; public readonly double Tick;
        public SessionTable Table, Last;
        public TradeLog Cache;
        public List<SeamTick> BackfillLive;          // live trades since the table began, while its backfill is to come
        public bool LastChanged;
        public string BackfillState = "none";
        public string BackfillWaitWas;               // review 5 S1: the state a waiting backfill goes back to once the gate is free
        public double BackfillAskedMs = -1, BackfillMs = -1, BackfillCallbackMs = -1; public int BackfillTrades = -1, BackfillReleased = -1, BackfillAsks; public string BackfillFirst, BackfillLast;
        // The served window being asked of NinjaTrader (one request per instrument at a time, B2): the loads waiting for it,
        // the live trades since it was asked (for its seam), and when the last one failed (no re-ask for a minute).
        public bool WindowAsking; public int WindowGen, WindowAsks, WindowFailures; public double WindowFailedMs = -1, WindowCallbackMs = -1;
        public int CapGen = -1;                      // B2: the window whose live trades passed LiveCap (failed off the lock, OnMarketData)
        public string WindowAskedText, WindowError;
        public bool CacheGap; public double GapAskMs = -1;   // S-G: the served window misses a feed drop; when it was last asked again for that
        public List<SeamTick> WindowLive;
        public readonly List<object> WindowWaiters = new List<object>();
        public long LateTrades, StaleTrades;         // live trades older than the session held; trades too old to open a session
        public double MaxGapSec;                     // the longest time between two live trades this session (a feed gap shows here)
        private DateTime lastTrade;
        private long rateCur, rateLast; private double rateStartMs = -1;   // live trades in the current and the last 15 minutes
        public RootBook(string root, double tick) { Root = root; Tick = tick > 0 ? tick : 0.25; }

        // Under Sync. Session change: the table ends (kept as Last), the served window is dropped, and the new session's table
        // starts. It is whole when ChartBridge was listening before the session started and the feed was up from before it
        // (however late the first trade comes, review 3 S-A). When ChartBridge started after the session began, it is built
        // from the first live trade, and for `backfill` (profileRoots) one backfill of the session so far is wanted; that is
        // the only case with a backfill. When ChartBridge was running but the feed was down at the start, the table counts
        // from the first live trade and says the feed was down (no backfill). A trade more than StaleTradeSec off the clock
        // (nowNt; MinValue: no check) never opens a table: NinjaTrader may replay the last trade as a snapshot when market
        // data starts (a weekend, the 17:00 break), which would open a finished session.
        public void OnTrade(DateTime t, double price, long volume, double et, DateTime listeningSinceUtc, DateTime feedUpSinceUtc, double nowMs, DateTime nowNt, bool backfill)
        {
            if (Table == null || t >= Table.End || t < Table.Start)
            {
                DateTime s, e;
                SessionClock.Bounds(t, out s, out e);
                if (Table != null && s < Table.Start) { LateTrades++; if (Cache != null) Cache.Add(t, price, volume); AddLive(t, price, volume); return; }
                if (nowNt != DateTime.MinValue && Math.Abs((nowNt - t).TotalSeconds) > StaleTradeSec) { StaleTrades++; return; }
                if (Table != null) { Last = Table; LastChanged = true; }
                DateTime sUtc = ChartBridgeTime.ToUtc(s);
                bool started = listeningSinceUtc.Ticks > 0 && listeningSinceUtc <= sUtc;   // ChartBridge was running before the session
                bool whole = started && feedUpSinceUtc.Ticks > 0 && feedUpSinceUtc <= sUtc;
                bool want = !started && backfill;                                        // a start after 18:00: the one backfill
                Table = new SessionTable { Start = s, End = e, StartEt = ChartBridgeTime.EtSeconds(sUtc), Whole = whole, CoveredFromEt = whole ? 0 : et };
                if (whole) Table.CoveredFromEt = Table.StartEt;
                if (started && !whole) { Table.Dropped = true; Table.DropAtEt = Table.StartEt; Table.DropWhy = "the data connection was down at the session start"; }
                Cache = null; CacheGap = false;
                BackfillLive = want ? new List<SeamTick>(4096) : null;
                BackfillState = whole ? "none" : want ? "wanted" : started ? "none (the feed was down at 18:00; no backfill after a start before 18:00)" : "none (not in profileRoots)";
                BackfillAskedMs = -1; BackfillMs = -1; BackfillCallbackMs = -1; BackfillTrades = -1; BackfillReleased = -1; BackfillAsks = 0; BackfillFirst = null; BackfillLast = null;
                LateTrades = 0; MaxGapSec = 0; lastTrade = t;
            }
            double gap = (t - lastTrade).TotalSeconds;
            if (gap > MaxGapSec) MaxGapSec = gap;
            if (t > lastTrade) lastTrade = t;
            Table.Add(et, SessionTable.PriceTicks(price, Tick), volume);
            if (BackfillLive != null)
            {
                if (BackfillLive.Count < LiveCap) BackfillLive.Add(new SeamTick { Time = t, Price = price, Volume = volume });
                else { BackfillLive = null; BackfillState = "abandoned: over " + LiveCap + " live trades while it waited"; }   // S1: bounded
            }
            if (Cache != null) Cache.Add(t, price, volume);
            AddLive(t, price, volume);
            if (rateStartMs < 0) rateStartMs = nowMs;
            if (nowMs - rateStartMs >= 15 * 60000) { rateLast = rateCur; rateCur = 0; rateStartMs = nowMs; }
            rateCur++;
        }
        private void AddLive(DateTime t, double price, long volume)
        {
            if (WindowLive == null) return;
            if (WindowLive.Count < LiveCap) WindowLive.Add(new SeamTick { Time = t, Price = price, Volume = volume });
            else { WindowLive = null; CapGen = WindowGen; }   // abandoned: the loads waiting are answered (no trades) off the lock
        }
        public bool InTable(DateTime t) { return Table != null && t >= Table.Start && t < Table.End; }

        // Under Sync (S2): a feed drop or a reset while the market is open. The table is no longer every trade of the session
        // (and never becomes whole again this session); the served window misses the gap too (CacheGap).
        public bool FeedDropped(double atEt, string why)
        {
            if (Cache != null) CacheGap = true;   // S-G: kept; asked again at a load at most once in 10 minutes (ServeWindow)
            if (Table == null || Table.Dropped) return false;
            Table.Dropped = true; Table.Whole = false; Table.DropAtEt = atEt; Table.DropWhy = why;
            return true;
        }

        // Live trades an hour, from the last 15 to 30 minutes (-1 when under a minute of trades has been seen).
        public double RatePerHour(double nowMs)
        {
            if (rateStartMs < 0) return -1;
            double spanMs = nowMs - rateStartMs + (rateLast > 0 ? 15 * 60000 : 0);
            if (spanMs < 60000) return -1;
            return (rateCur + rateLast) * 3600000.0 / spanMs;
        }

        // S4: what the "profile" message needs, copied under Sync (the rows as two arrays: microseconds), formatted after with
        // no lock held. Last is never changed once it is Last, so it is taken as it is.
        public ProfileSnap Snap()
        {
            ProfileSnap p = new ProfileSnap { Root = Root, Tick = Tick, Last = Last, Backfill = BackfillState };
            SessionTable t = Table;
            if (t != null)
            {
                p.Has = true; p.StartEt = t.StartEt; p.Whole = t.Whole; p.CoveredFromEt = t.CoveredFromEt; p.Start = t.Start; p.End = t.End;
                p.Dropped = t.Dropped; p.DropAtEt = t.DropAtEt; p.DropWhy = t.DropWhy;
                p.Keys = new long[t.Vol.Count]; p.Vals = new long[t.Vol.Count];
                int i = 0;
                foreach (KeyValuePair<long, long> kv in t.Vol) { p.Keys[i] = kv.Key; p.Vals[i] = kv.Value; i++; }
            }
            return p;
        }

        // The last finished session's table, kept in one small file per instrument (ChartBridge's folder, profile-MNQ.txt):
        // its start, whether whole, and its rows. Only for the profile of the last session on a weekend (and a later weekly
        // profile); nothing about single trades.
        public string LastFile { get { return System.IO.Path.Combine(ChartBridgeConfig.Folder, "profile-" + Root + ".txt"); } }
        public static string LastText(SessionTable t)
        {
            if (t == null) return null;
            StringBuilder b = new StringBuilder();
            b.Append("session ").Append(CbJson.Num3(t.StartEt)).Append(' ').Append(t.Whole ? 1 : 0).Append(' ').Append(CbJson.Num3(t.CoveredFromEt)).Append('\n');
            List<long> keys = new List<long>(t.Vol.Keys); keys.Sort();
            foreach (long k in keys) b.Append(k.ToString(CultureInfo.InvariantCulture)).Append(' ').Append(t.Vol[k].ToString(CultureInfo.InvariantCulture)).Append('\n');
            return b.ToString();
        }
        public const double LastMaxAgeSec = 4 * 86400;   // a saved session older than this (a long weekend at most) is not used
        public static SessionTable ParseLast(string text, double nowEt)
        {
            if (string.IsNullOrEmpty(text)) return null;
            string[] lines = text.Split('\n');
            string[] h = lines[0].Split(' ');
            if (h.Length < 4 || h[0] != "session") return null;
            SessionTable t = new SessionTable { StartEt = double.Parse(h[1], CultureInfo.InvariantCulture), Whole = h[2] == "1", CoveredFromEt = double.Parse(h[3], CultureInfo.InvariantCulture) };
            if (nowEt - t.StartEt > LastMaxAgeSec) return null;
            for (int i = 1; i < lines.Length; i++)
            {
                string[] kv = lines[i].Split(' ');
                if (kv.Length != 2) continue;
                long k = long.Parse(kv[0], CultureInfo.InvariantCulture), v = long.Parse(kv[1], CultureInfo.InvariantCulture);
                t.Vol[k] = v; t.Volume += v;
            }
            return t;
        }
    }

    // A "profile" message's content, copied under the book's lock and formatted with none held (RootBook.Snap).
    public class ProfileSnap
    {
        public string Root, Backfill, DropWhy; public double Tick, StartEt, CoveredFromEt, DropAtEt; public bool Has, Whole, Dropped;
        public DateTime Start, End;
        public long[] Keys, Vals; public SessionTable Last;

        // The "profile" message: this session's table less `less` (trades the page is about to get as live ticks), and the
        // last finished session's, for the weekend's "last session" profile.
        public string Json(string sub, List<SeamTick> less)
        {
            StringBuilder b = new StringBuilder(4096);
            b.Append("{\"type\":\"profile\",\"root\":").Append(CbJson.Str(Root));
            if (sub != null) b.Append(",\"sub\":").Append(sub);
            b.Append(",\"tick\":").Append(CbJson.Num(Tick)).Append(",\"bucketSeconds\":").Append((int)SessionTable.BucketSeconds);
            b.Append(",\"session\":");
            if (!Has) b.Append("null");
            else
            {
                Dictionary<long, long> minus = null;
                if (less != null && less.Count > 0)
                {
                    minus = new Dictionary<long, long>();
                    foreach (SeamTick h in less)
                        if (h.Time >= Start && h.Time < End) SessionTable.Add(minus, ChartBridgeTime.EtSeconds(ChartBridgeTime.ToUtc(h.Time)), SessionTable.PriceTicks(h.Price, Tick), h.Volume);
                }
                b.Append("{\"from\":"); CbJson.AppendNum3(b, StartEt);
                b.Append(",\"whole\":").Append(Whole ? "true" : "false").Append(",\"coveredFrom\":"); CbJson.AppendNum3(b, CoveredFromEt);
                b.Append(",\"backfill\":").Append(CbJson.Str(Backfill ?? "none"));
                b.Append(",\"drop\":");
                if (!Dropped) b.Append("null");
                else { b.Append("{\"at\":"); CbJson.AppendNum3(b, DropAtEt); b.Append(",\"why\":").Append(CbJson.Str(DropWhy ?? "")).Append('}'); }
                b.Append(",\"rows\":"); SessionTable.AppendRows(b, Keys, Vals, minus);
                b.Append('}');
            }
            b.Append(",\"last\":");
            SessionTable l = Last;
            if (l == null) b.Append("null");
            else
            {
                b.Append("{\"from\":"); CbJson.AppendNum3(b, l.StartEt);
                b.Append(",\"whole\":").Append(l.Whole ? "true" : "false").Append(",\"coveredFrom\":"); CbJson.AppendNum3(b, l.CoveredFromEt);
                long[] lk = new long[l.Vol.Count], lv = new long[l.Vol.Count]; int i = 0;
                foreach (KeyValuePair<long, long> kv in l.Vol) { lk[i] = kv.Key; lv[i] = kv.Value; i++; }
                b.Append(",\"rows\":"); SessionTable.AppendRows(b, lk, lv, null);
                b.Append('}');
            }
            return b.Append('}').ToString();
        }
    }

    // What ClassifyBackfill decided, for the "ticks" message and /diag.
    public class BackfillSides
    {
        public sbyte[] Side;                 // 1 buy, -1 sell, 0 unknown, per trade
        public byte[] Method;                // ChartBridgeSides.None, Aggressor, BidAsk, TickRule, per trade
        public int Trades;
        public readonly int[] Counts = new int[4];   // trades by method
        public bool HasTrades, HasBid, HasAsk;
        public DateTime FirstTrade, LastTrade, FirstBid, LastBid, FirstAsk, LastAsk;
        public int Quoted;                   // trades with a fresh bid and ask before them, inside the quote history
        public int BeforeQuotes, AfterQuotes, StaleQuotes;   // trades outside it (before its start, after its end) or with a stale quote: tick rule
        public int BetweenQuotes, CrossedQuotes;   // quoted trades that went by the tick rule: between bid and ask, or a crossed or locked quote
        public int TieChanged;               // trades the other tie rule (a quote at the trade's own time counts) would call differently
        public int SessionStarts;            // 18:00 ET boundaries crossed inside the backfill (the tick rule started over)
        public long TradeResolution, QuoteResolution, UnitTicks;   // DateTime ticks (10000 = 1 ms); 0 when there were none
        public int StampUsable, StampLikeFillIn, StampMissing;   // NinjaTrader's stamps (a sample): a usable quote (of which like its fill-in), or none
        public int StampAgree, StampDisagree;   // usable stamps that put the trade at the bid or ask, against the side ChartBridge gave it
    }

    // One side (bid or ask) of the live quote: the recent updates with NinjaTrader's time for each, so the quote as of a
    // trade can be read by time, not by arrival (quote updates can arrive before the trade that caused them). Keeps the
    // last Size updates; of the older ones it keeps the latest-stamped and the latest stamped before that, so a burst of
    // more than Size updates at one time still leaves the quote from before it. Not thread safe: LiveSideTagger locks.
    public class LiveQuoteSide
    {
        public const int Size = 256;
        private readonly DateTime[] time = new DateTime[Size];
        private readonly double[] price = new double[Size];
        private int count, head;             // head: where the next update goes
        private bool hasBase, hasPrev; private DateTime baseTime, prevTime; private double basePrice, prevPrice;   // the latest evicted update, and the latest one stamped before it
        public double Latest = double.NaN;   // the last update to arrive, whatever its time
        public DateTime LatestTime;

        public void Add(DateTime t, double p)
        {
            if (count == Size)
            {
                DateTime ot = time[head]; double op = price[head];
                if (!hasBase) { hasBase = true; baseTime = ot; basePrice = op; }
                else if (ot > baseTime) { hasPrev = true; prevTime = baseTime; prevPrice = basePrice; baseTime = ot; basePrice = op; }
                else if (ot == baseTime) basePrice = op;
                else if (!hasPrev || ot >= prevTime) { hasPrev = true; prevTime = ot; prevPrice = op; }
            }
            else count++;
            time[head] = t; price[head] = p;
            head = (head + 1) % Size;
            Latest = p; LatestTime = t;
        }

        public void Clear() { count = 0; head = 0; hasBase = false; hasPrev = false; Latest = double.NaN; }

        // The quote as of t: the update with the latest time before t (at or before t when inclusive); among updates with
        // that same time, the one that arrived last.
        public bool AsOf(DateTime t, bool inclusive, out double p, out DateTime at)
        {
            bool found = false; p = double.NaN; at = DateTime.MinValue;
            if (hasPrev && (inclusive ? prevTime <= t : prevTime < t)) { found = true; p = prevPrice; at = prevTime; }
            if (hasBase && (inclusive ? baseTime <= t : baseTime < t) && (!found || baseTime >= at)) { found = true; p = basePrice; at = baseTime; }
            int start = (head - count + Size) % Size;
            for (int k = 0; k < count; k++)
            {
                int i = (start + k) % Size;
                DateTime ti = time[i];
                if ((inclusive ? ti <= t : ti < t) && (!found || ti >= at)) { found = true; p = price[i]; at = ti; }
            }
            return found;
        }
    }

    // One instrument's live trades, by the same tie rule as the backfill (strictly before the trade) so a chart reload
    // gives the same sides. Also counts, for /diag: liveTieChanged (the other tie rule would call it differently, the live
    // twin of the backfill's tieChanged), quoteAfterTrade (the latest update to arrive was stamped after the trade: the
    // reorder the arrival order alone would have taken as the quote), staleQuotes, and whether the Last event's own
    // e.Bid/e.Ask equal the latest updates. Thread safe.
    public class LiveSideTagger
    {
        private readonly object sync = new object();
        private readonly LiveQuoteSide bids = new LiveQuoteSide(), asks = new LiveQuoteSide();
        private double lastPrice;
        private DateTime lastTime;
        private bool hasLast;
        private int lastSide;
        private readonly SessionClock session = new SessionClock();
        private readonly long[] counts = new long[4];
        private long bidUpdates, askUpdates, eventSame, eventDiffers, eventNone, tieChanged, quoteAfterTrade, staleQuotes, resets;

        public void NoteQuote(bool isBid, double price, DateTime time)
        {
            lock (sync) { if (isBid) { bids.Add(time, price); bidUpdates++; } else { asks.Add(time, price); askUpdates++; } }
        }

        // NinjaTrader reset its market data (IsReset) or a connection dropped: the quote is unknown until new updates.
        public void ClearQuote() { lock (sync) { bids.Clear(); asks.Clear(); resets++; } }

        private bool Quote(DateTime t, bool inclusive, out double bid, out double ask)
        {
            DateTime bt, at;
            bool ok = bids.AsOf(t, inclusive, out bid, out bt) & asks.AsOf(t, inclusive, out ask, out at);
            return ok && (t - bt).Ticks <= ChartBridgeSides.QuoteMaxAge && (t - at).Ticks <= ChartBridgeSides.QuoteMaxAge;
        }

        // eventBid, eventAsk: the Last update's own Bid and Ask (MarketDataEventArgs), only compared, for /diag.
        public int Tag(double price, DateTime time, double eventBid, double eventAsk, out int method)
        {
            lock (sync)
            {
                if (session.NewSession(time)) { hasLast = false; lastSide = 0; }   // 18:00 ET: the tick rule starts over
                double b, a, b2, a2;
                bool q = Quote(time, false, out b, out a);
                if (!q)
                {
                    double x, y; DateTime tx, ty;
                    if (bids.AsOf(time, false, out x, out tx) && asks.AsOf(time, false, out y, out ty)) staleQuotes++;
                }
                int s = ChartBridgeSides.Classify(price, q ? b : double.NaN, q ? a : double.NaN, hasLast, lastPrice, lastSide, out method);
                bool q2 = Quote(time, true, out b2, out a2);
                int m2;
                if (ChartBridgeSides.Classify(price, q2 ? b2 : double.NaN, q2 ? a2 : double.NaN, hasLast, lastPrice, lastSide, out m2) != s) tieChanged++;
                if ((!double.IsNaN(bids.Latest) && bids.LatestTime > time) || (!double.IsNaN(asks.Latest) && asks.LatestTime > time)) quoteAfterTrade++;
                counts[method]++;
                if (!ChartBridgeSides.QuoteUsable(eventBid, eventAsk)) eventNone++;
                else if (ChartBridgeSides.PriceKey(eventBid) == ChartBridgeSides.PriceKey(bids.Latest) && ChartBridgeSides.PriceKey(eventAsk) == ChartBridgeSides.PriceKey(asks.Latest)) eventSame++;
                else eventDiffers++;
                hasLast = true; lastPrice = price; lastTime = time; lastSide = s;
                return s;
            }
        }

        // After a load's seam (N3): the trade the tick rule continues from is the backfill's copy (or the last released
        // one), whose side can differ from the dropped live twin's. Only when that trade is still the last one here.
        public void FixLast(DateTime time, double price, int side)
        {
            lock (sync) { if (hasLast && lastTime == time && ChartBridgeSides.PriceKey(lastPrice) == ChartBridgeSides.PriceKey(price)) lastSide = side; }
        }

        public string DiagJson()
        {
            lock (sync)
            {
                return "{\"trades\":" + (counts[0] + counts[1] + counts[2] + counts[3]) +
                    ",\"aggressor\":" + counts[ChartBridgeSides.Aggressor] + ",\"bidAsk\":" + counts[ChartBridgeSides.BidAsk] +
                    ",\"tickRule\":" + counts[ChartBridgeSides.TickRule] + ",\"none\":" + counts[ChartBridgeSides.None] +
                    ",\"liveTieChanged\":" + tieChanged + ",\"quoteAfterTrade\":" + quoteAfterTrade + ",\"staleQuotes\":" + staleQuotes +
                    ",\"bid\":" + CbJson.Num(bids.Latest) + ",\"ask\":" + CbJson.Num(asks.Latest) +
                    ",\"bidUpdates\":" + bidUpdates + ",\"askUpdates\":" + askUpdates + ",\"quoteResets\":" + resets +
                    ",\"eventQuoteSame\":" + eventSame + ",\"eventQuoteDiffers\":" + eventDiffers + ",\"eventQuoteNone\":" + eventNone + "}";
            }
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
        public readonly List<SeamTick> Pending = new List<SeamTick>();   // live ticks held during backfill (lock it to read or write)
        public int SubscribeSeq;                // bumped under the Pending lock on every subscribe: a load for an older one is dropped
        public volatile bool WantsProfile;      // 0.3.5: the page's subscribe asked for "profile" messages (set under the Pending lock)
        // Two lanes (0.3.4). The order lane (OrderLane: hello, trading, orders, order, position, reject, exec, execs, status,
        // pong) is a FIFO checked before every message, so these go out at the next message boundary, ahead of any market
        // data queued before them; the data lane (history, ticks, ready, tick, and anything else) is the FIFO outbox. Order
        // within each lane is kept. A data message never goes out ahead of an order-lane message sent before it.
        // The outbox holds one message (a string), several sent in order (a string[], SendAll), or Wake (an order-lane
        // message is waiting).
        // A page more than 5 s behind is reconnected (review 3, Anthony's "just a reset"): it is closed (and its socket
        // aborted, so the page sees it), and it reconnects on its own and reloads. "Behind" is how long the oldest waiting
        // market data entry has waited (DataAgeMs), not counting the time spent sending the page's own bulk data meanwhile:
        // a load's history and ticks chunks and the held trades released after "ready" (review 4 B1). They go out back to
        // back at the page's pace; a live backlog ages during every other send. Only bulk sends that have finished are
        // credited, so a page frozen in the middle of one still ages. The price of that credit (review 5 S1): right after
        // a load, live trades queued behind the release are as late as the release is long, and that does not count, so
        // a page can run up to the release's length plus 5 s behind before it is closed (review 5 measured 4.4 to 14.3 s
        // on healthy pages at 3,000 trades a second). Counting it closed every reload at that rate in a loop. Sending
        // recent ticks first (next: branch live-first) is what shrinks the release. Also closed: 5,000 entries waiting
        // while the message being sent has been stuck for over StuckMs (2 s), and over 5,000 order-lane messages waiting.
        public const int SoftCap = 5000;
        public const double StuckMs = 2000, MaxLagMs = 5000;
        private static readonly object Wake = new object();
        private readonly BlockingCollection<object> outbox = new BlockingCollection<object>(new ConcurrentQueue<object>());
        private struct Stamp { public long At, Bulk; }   // when a data entry was queued, and bulkSpent then
        private readonly ConcurrentQueue<Stamp> queuedAt = new ConcurrentQueue<Stamp>();   // one per data entry, in outbox order
        private readonly ConcurrentQueue<string> orderLane = new ConcurrentQueue<string>();
        private int orderLaneCount;
        private long sendStarted;               // Stopwatch timestamp when the message being sent was handed to the socket; 0 when none
        private long bulkSpent;                 // Stopwatch ticks spent on finished bulk sends (chunks and released trades), in all
        private int bulkQueued;                 // history and ticks chunks queued and not yet sent (a load keeps at most BulkWindow)
        private volatile bool loopStarted;
        private readonly ManualResetEventSlim bulkSent = new ManualResetEventSlim(false);
        private readonly CancellationTokenSource cts = new CancellationTokenSource();

        public ChartBridgeClient(WebSocket socket, int id) { Socket = socket; Id = id; }

        public Action<string> Tap;              // test hook: sees every message sent (unused in NinjaTrader)

        private static readonly string[] OrderLaneTypes = { "hello", "trading", "orders", "order", "position", "reject", "exec", "execs", "status", "pong" };

        // The message's type, read from its start ({"type":"...), as every message ChartBridge sends begins.
        public static string TypeOf(string json)
        {
            const string head = "{\"type\":\"";
            if (json == null || !json.StartsWith(head, StringComparison.Ordinal)) return null;
            int end = json.IndexOf('"', head.Length);
            return end < 0 ? null : json.Substring(head.Length, end - head.Length);
        }

        public static bool OrderLane(string json)
        {
            string type = TypeOf(json);
            return type != null && Array.IndexOf(OrderLaneTypes, type) >= 0;
        }

        private static bool Bulk(string json)
        {
            return json.StartsWith("{\"type\":\"ticks\"", StringComparison.Ordinal) || json.StartsWith("{\"type\":\"history\"", StringComparison.Ordinal);
        }

        private static double MsSince(long stamp) { return (Stopwatch.GetTimestamp() - stamp) * 1000.0 / Stopwatch.Frequency; }

        private bool Stuck()
        {
            long started = Interlocked.Read(ref sendStarted);
            return started != 0 && MsSince(started) > StuckMs;
        }

        // How long the oldest waiting market data entry has waited, in ms (0 when none waits). See above.
        public double DataAgeMs()
        {
            Stamp q;
            if (!queuedAt.TryPeek(out q)) return 0;
            long waited = Stopwatch.GetTimestamp() - q.At - (Interlocked.Read(ref bulkSpent) - q.Bulk);
            return Math.Max(0, waited * 1000.0 / Stopwatch.Frequency);
        }

        public int Queued { get { return outbox.Count; } }
        public int BulkQueued { get { return Volatile.Read(ref bulkQueued); } }
        public int OrderLaneQueued { get { return Volatile.Read(ref orderLaneCount); } }

        // Into the outbox, or false when the page is closed for being behind or stuck (see above). Never blocks, never
        // throws: an entry that races a Close is dropped quietly (review 3 S2; it used to throw out of broadcast loops).
        private bool Admit(object item)
        {
            if (outbox.Count >= SoftCap && Stuck()) { NotKeepingUp(null); return true; }
            double age = DataAgeMs();
            if (age > MaxLagMs) { NotKeepingUp(age); return true; }
            try
            {
                if (item != Wake)
                {
                    queuedAt.Enqueue(new Stamp { At = Stopwatch.GetTimestamp(), Bulk = Interlocked.Read(ref bulkSpent) });
                    string one = item as string;
                    if (one != null && Bulk(one)) Interlocked.Increment(ref bulkQueued);
                }
                if (!outbox.TryAdd(item)) NotKeepingUp(null);
            }
            catch (InvalidOperationException) { }   // closed meanwhile (CompleteAdding): Send after Close does nothing
            return true;
        }

        private int closedLogged;
        private void NotKeepingUp(double? lagMs)
        {
            if (Interlocked.Exchange(ref closedLogged, 1) == 0)
                ChartBridgeServer.Log("Client " + Id + " is not keeping up" + (lagMs.HasValue ? ": " + (lagMs.Value / 1000).ToString("0.0", CultureInfo.InvariantCulture) + " s behind" : "") + "; closing it (the page reconnects and reloads).");
            Close();
        }

        public void Send(string json)
        {
            if (Tap != null) Tap(json);
            if (cts.IsCancellationRequested) return;
            if (OrderLane(json))
            {
                if (Interlocked.Increment(ref orderLaneCount) > SoftCap) { NotKeepingUp(null); return; }
                orderLane.Enqueue(json);
                Admit(Wake);
            }
            else Admit(json);
        }

        // Always the data lane, whatever the type (a load's own warnings stay after its history, as in 0.3.3).
        public void SendData(string json)
        {
            if (Tap != null) Tap(json);
            if (cts.IsCancellationRequested) return;
            Admit(json);
        }

        // Several data-lane messages as ONE outbox entry, sent in this order, each its own WebSocket message (0.3.4): the
        // held live trades released at "ready". Order-lane messages still go out between them (SendLoop).
        public void SendAll(IList<string> msgs)
        {
            if (msgs == null || msgs.Count == 0) return;
            if (Tap != null) foreach (string m in msgs) Tap(m);
            if (cts.IsCancellationRequested) return;
            string[] batch = new string[msgs.Count];
            msgs.CopyTo(batch, 0);
            Admit(batch);
        }

        private async Task<bool> SendText(string msg)
        {
            if (Socket.State != WebSocketState.Open) return false;
            byte[] bytes = Encoding.UTF8.GetBytes(msg);
            Interlocked.Exchange(ref sendStarted, Stopwatch.GetTimestamp());
            await Socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, cts.Token);
            Interlocked.Exchange(ref sendStarted, 0);
            return true;
        }

        private async Task<bool> SendOrderLane()
        {
            string msg;
            while (orderLane.TryDequeue(out msg))
            {
                Interlocked.Decrement(ref orderLaneCount);
                if (!await SendText(msg)) return false;
            }
            return true;
        }

        // A load's history and ticks chunks are made and queued a few at a time (review 4 S1): before each one, the loading
        // thread waits until fewer than BulkWindow chunks wait for this page, so a load holds a few MB here, not all of it
        // (a 20,000-trade chunk is about 1.3 MB as a .NET string). While it waits it checks the 5 s rule, so a page frozen
        // during a load is closed too. False when the page was closed. No wait before the send loop runs (the harness).
        public static int BulkWindow = 3;   // settable only for the harness (to compare with queuing a whole load at once)
        public bool WaitForBulkRoom()
        {
            while (loopStarted && Volatile.Read(ref bulkQueued) >= BulkWindow)
            {
                if (cts.IsCancellationRequested) return false;
                double age = DataAgeMs();
                if (age > MaxLagMs) { NotKeepingUp(age); return false; }
                bulkSent.Reset();
                if (Volatile.Read(ref bulkQueued) < BulkWindow) break;
                bulkSent.Wait(100);
            }
            return !cts.IsCancellationRequested;
        }

        public async Task SendLoop()
        {
            loopStarted = true;
            try
            {
                foreach (object item in outbox.GetConsumingEnumerable(cts.Token))
                {
                    if (!await SendOrderLane()) return;
                    if (item == Wake) continue;
                    Stamp ignored; queuedAt.TryDequeue(out ignored);   // this entry no longer waits
                    string[] batch = item as string[];
                    if (batch == null)
                    {
                        string one = (string)item;
                        bool bulk = Bulk(one);
                        long t0 = Stopwatch.GetTimestamp();
                        if (!await SendText(one)) return;
                        if (bulk)
                        {
                            Interlocked.Add(ref bulkSpent, Stopwatch.GetTimestamp() - t0);
                            Interlocked.Decrement(ref bulkQueued);
                            bulkSent.Set();
                        }
                        continue;
                    }
                    foreach (string msg in batch)   // the release after "ready": bulk too (review 4 B1)
                    {
                        if (!await SendOrderLane()) return;
                        long t0 = Stopwatch.GetTimestamp();
                        if (!await SendText(msg)) return;
                        Interlocked.Add(ref bulkSpent, Stopwatch.GetTimestamp() - t0);
                    }
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                // Review 3 N1: a send that failed ends the page's stream; close it so the page reconnects instead of waiting.
                ChartBridgeServer.Log("Client " + Id + " send stopped: " + ex.Message + "; closing it.");
            }
            finally { Close(); }   // every way out (review 5 N6: also when the socket is no longer open); Close is idempotent
        }

        public string DiagJson()
        {
            return "{\"id\":" + Id + ",\"root\":" + CbJson.Str(Root) + ",\"ready\":" + (Ready ? "true" : "false") +
                ",\"queued\":" + Queued + ",\"orderLaneQueued\":" + OrderLaneQueued + ",\"oldestDataMs\":" + CbJson.Num3(DataAgeMs()) + "}";
        }

        public void Close()
        {
            try { cts.Cancel(); } catch (Exception) { }
            try { outbox.CompleteAdding(); } catch (Exception) { }
            // Review 4 B2: also end the connection, so the page always sees the close and reconnects (a close between two
            // sends used to leave the socket open: the page stayed connected, silent and Armed). Abort is thread safe.
            try { if (Socket != null) Socket.Abort(); } catch (Exception) { }
            try { bulkSent.Set(); } catch (Exception) { }
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
        public const string Version = "0.3.6";
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
        private static readonly Regex SubRx = new Regex("\"sub\"\\s*:\\s*(\\d{1,15})(?!\\d)");   // the page's subscribe id (0.3.3), echoed back
        private static readonly Regex LiveFirstRx = new Regex("\"liveFirst\"\\s*:\\s*(true|1)(?![\\w.])");   // 0.3.5: a tick chart gets the served window
        private static readonly Regex ProfileRx = new Regex("\"profile\"\\s*:\\s*(true|1)(?![\\w.])");       // 0.3.5: the page wants "profile" messages

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
                    StartGate();   // review 6 S1: tick requests may go out again
                    ResolveInstruments();
                    ChartBridgeOrders.NewToken();
                    ChartBridgeOrders.StartPlans();   // 0.3.7: planned_brackets.txt, read on a pool thread before the accounts are watched
                    Log(ChartBridgeOrders.Enabled
                        ? "order entry is ON for " + ChartBridgeOrders.TradeAccounts.Count + " account(s): " + string.Join(", ", ChartBridgeOrders.TradeAccounts)
                        : "order entry is off (read only)");
                    Log(ChartBridgePin.IsSet ? "ChartBridge's page is locked with a PIN (pin.txt)" : "no PIN is set yet: ChartBridge's page asks for one before it shows anything");
                    SubscribeMarketData();
                    WatchFeed();   // 0.3.5 S2
                    if (ChartBridgeConfig.PostFills) ChartBridgeDesk.Load();
                    WatchAccounts();
                    ChartBridgeOrders.WatchConnections();
                    try { ChartBridgeOrders.Resume(); } catch (Exception ex) { Log("bracket resume error: " + ex.Message); }   // entries that filled while stopped
                    accountTimer = new System.Threading.Timer(delegate { try { WatchAccounts(); } catch (Exception) { } try { ChartBridgeDesk.Flush(); } catch (Exception) { } try { SweepBooks(); } catch (Exception) { } }, null, 10000, 10000);
                    pollTimer = new System.Threading.Timer(delegate { try { PollExecutions(); } catch (Exception) { } try { ChartBridgeOrders.CheckLegs(); } catch (Exception ex) { Log("legs check error: " + ex.Message); } }, null, 2000, 2000);
                    listener = new HttpListener();
                    listener.Prefixes.Add("http://localhost:" + ChartBridgeConfig.Port + "/");
                    StartListening(cts.Token, 0);
                    ChartBridgeBars.Start();   // daily bars to The Desk, when bars = on (its own low-priority thread)
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
                ChartBridgeBars.Stop();
                try { if (accountTimer != null) accountTimer.Dispose(); } catch (Exception) { }
                accountTimer = null;
                try { if (pollTimer != null) pollTimer.Dispose(); } catch (Exception) { }
                pollTimer = null;
                foreach (ChartBridgeClient c in Clients.Values) c.Close();
                Clients.Clear();
                foreach (MarketData md in Feeds) { try { md.Update -= OnMarketData; } catch (Exception) { } }
                Feeds.Clear();
                StopGate(250);   // nothing carries over to the next start (review 3 N-9); the worker ends, the retries' timers go (review 5 N6); a short wait on NinjaTrader's thread (review 6 S2)
                lock (Books) Books.Clear();
                Unwatch();
                ChartBridgeOrders.UnwatchConnections();
                UnwatchFeed();
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
            WriteBody(ctx, body);
        }

        // 0.3.5: the body, or for a HEAD request only its length (HttpListener refuses a body on a HEAD reply: writing one
        // failed the request with a 500 and a "request failed" line in the Output window).
        private static void WriteBody(HttpListenerContext ctx, byte[] body)
        {
            HttpListenerResponse res = ctx.Response;
            res.ContentLength64 = body.Length;
            if (!IsHead(ctx)) res.OutputStream.Write(body, 0, body.Length);
            res.Close();
        }
        private static bool IsHead(HttpListenerContext ctx) { return string.Equals(ctx.Request.HttpMethod, "HEAD", StringComparison.OrdinalIgnoreCase); }

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
                WriteBody(ctx, Encoding.UTF8.GetBytes("Not found. Page files go in " + root));
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
            WriteBody(ctx, body);
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
                Match sm = SubRx.Match(text);
                StartLoad(client, root, days, tickHours, sm.Success ? long.Parse(sm.Groups[1].Value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture) : null,   // canonical digits: "007" is not JSON
                          LiveFirstRx.IsMatch(text), ProfileRx.IsMatch(text));
            }
            else if (type == "auth" || type == "order" || type == "change" || type == "plan" || type == "cancel" || type == "flatten")
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
            b.Append("],\"trading\":").Append(ChartBridgeOrders.TradingJson(false, null));
            b.Append(",\"features\":[\"liveFirst\",\"profile\"]}");   // 0.3.5: the served window, and the session's volume at price
            return b.ToString();
        }

        // ---------------------------------------------------------- live market data
        private static void SubscribeMarketData()
        {
            long nowTicks = ChartBridgeTime.ToUtc(NowNt()).Ticks;
            Interlocked.Exchange(ref listeningSinceUtcTicks, nowTicks);   // 0.3.5: a session that starts after this is whole
            Interlocked.Exchange(ref feedUpSinceUtcTicks, nowTicks); Interlocked.Exchange(ref feedDown, 0); Interlocked.Exchange(ref firstTradeUtcTicks, 0);
            foreach (Instrument inst in Instruments.Values)
            {
                MarketData md = new MarketData(inst);
                md.Update += OnMarketData;
                Feeds.Add(md);
            }
        }

        // 0.3.4: each instrument's live quote and tick-rule state, for the side of its trades (ChartBridgeSides).
        private static readonly Dictionary<string, LiveSideTagger> LiveSides = new Dictionary<string, LiveSideTagger>();
        private static int quoteErrorLogged, resetLogged;

        private static LiveSideTagger SideTagger(string root)
        {
            lock (LiveSides)
            {
                LiveSideTagger t;
                if (!LiveSides.TryGetValue(root, out t)) { t = new LiveSideTagger(); LiveSides[root] = t; }
                return t;
            }
        }

        private static void OnMarketData(object sender, MarketDataEventArgs e)
        {
            MarketDataType type = e.MarketDataType;
            if (e.IsReset)
            {
                // NinjaTrader's help: IsReset means "a UI reset is needed after a manual disconnect" (meant for its columns).
                // Such an event is never a trade, whatever its type and price: ChartBridge only forgets the live quote (0.3.4
                // review S2; a reset event of type Last with price 0 used to reach the order code's last price).
                try
                {
                    SideTagger(RootOf(e.Instrument)).ClearQuote();
                    string resetRoot = RootOf(e.Instrument), resetWhy = "a market data reset at " + EtText(NowNt());
                    Task.Run(() => FeedDropped(resetRoot, resetWhy));   // 0.3.5 S2, off NinjaTrader's thread
                    if (Interlocked.Exchange(ref resetLogged, 1) == 0)
                        Log("market data reset (IsReset) on " + RootOf(e.Instrument) + ": type " + type + ", price " + e.Price.ToString(CultureInfo.InvariantCulture) + "; the live quote is forgotten, nothing is sent (logged once)");
                }
                catch (Exception ex) { if (Interlocked.Exchange(ref quoteErrorLogged, 1) == 0) Log("quote error (logged once): " + ex.Message); }
                return;
            }
            if (type == MarketDataType.Bid || type == MarketDataType.Ask)
            {
                // Bid and Ask updates only move the quote the next trades are classified by (0.3.4), with NinjaTrader's time
                // for each; nothing is sent.
                try { SideTagger(RootOf(e.Instrument)).NoteQuote(type == MarketDataType.Bid, e.Price, e.Time); }
                catch (Exception ex) { if (Interlocked.Exchange(ref quoteErrorLogged, 1) == 0) Log("quote error (logged once): " + ex.Message); }
                return;
            }
            if (type != MarketDataType.Last) return;
            if (!(e.Price > 0)) return;   // a Last event without a real price is not a trade: never to the order code or the page
            try
            {
                double rx = ChartBridgeTime.NowUtcMs();
                DateTime utc = ChartBridgeTime.ToUtc(e.Time);
                string root = RootOf(e.Instrument);
                ChartBridgeOrders.NoteLast(root, e.Price);
                int method;
                int side = SideTagger(root).Tag(e.Price, e.Time, e.Bid, e.Ask, out method);
                double t = ChartBridgeTime.EtSeconds(utc);
                string json = "{\"type\":\"tick\",\"root\":" + CbJson.Str(root) +
                    ",\"t\":" + CbJson.Num3(t) +
                    ",\"u\":" + CbJson.Num3(ChartBridgeTime.UtcMs(utc)) +
                    ",\"rx\":" + CbJson.Num3(rx) +
                    ",\"p\":" + CbJson.Num(e.Price) + ",\"v\":" + e.Volume.ToString(CultureInfo.InvariantCulture) +
                    ",\"s\":" + side.ToString(CultureInfo.InvariantCulture) + ",\"sm\":" + method.ToString(CultureInfo.InvariantCulture) + "}";   // 0.3.4: side and method
                // 0.3.5: the instrument's table and served window take the trade, and the pages get it, under the book's lock: a
                // snapshot taken under it (a load's window and profile) is exact against what the pages get after it.
                if (Volatile.Read(ref feedDown) != 0 || Interlocked.Read(ref firstTradeUtcTicks) == 0) FeedUp();   // a trade: the feed is up
                RootBook book = BookOf(root, e.Instrument);
                bool wantBackfill, lastChanged; int capGen;
                bool profileRoot = Array.IndexOf(ChartBridgeConfig.ProfileRoots, root) >= 0;
                lock (book.Sync)
                {
                    DateTime nowNt = book.InTable(e.Time) ? DateTime.MinValue : NowNt();   // the clock only when a session may open
                    book.OnTrade(e.Time, e.Price, e.Volume, t, new DateTime(Interlocked.Read(ref listeningSinceUtcTicks), DateTimeKind.Utc),
                        new DateTime(Interlocked.Read(ref feedUpSinceUtcTicks), DateTimeKind.Utc), rx, nowNt, profileRoot);
                    wantBackfill = book.BackfillState == "wanted";
                    if (wantBackfill) book.BackfillState = "queued";
                    lastChanged = book.LastChanged;
                    capGen = book.CapGen; book.CapGen = -1;
                    foreach (ChartBridgeClient c in Clients.Values)
                    {
                        if (c.Root != root) continue;
                        if (c.Ready) c.Send(json);
                        else lock (c.Pending)
                        {
                            if (c.Ready) c.Send(json);
                            else c.Pending.Add(new SeamTick { Time = e.Time, Price = e.Price, Volume = e.Volume, Json = json, Side = side, Method = method });   // NinjaTrader's time, as the backfill's
                        }
                    }
                }
                if (wantBackfill) QueueBackfill(book, e.Instrument, false);
                if (capGen >= 0) Task.Run(() => WindowFailed(book, capGen, "over " + RootBook.LiveCap + " live trades came while it waited", false));   // B2
                if (lastChanged) SaveLast(book);
            }
            catch (Exception ex) { Log("tick error: " + ex.Message); }
        }

        // ---------------------------------------------------------- history backfill
        // The tick request asks past "now" (0.3.3). NinjaTrader's help says a BarsRequest's from and to are turned into
        // whole trading days (12:00 AM), so the time of day should not cut the ticks; the margin makes sure that, if a
        // connection does cut there, the backfill still runs past the moment the live trades began to be held, even with
        // the PC clock behind the data's clock. No trade exists in the future, so it can only add. Should a request
        // ending in the future ever be refused, it is asked once more ending now (0.3.2's request).
        public const int TickToMarginMinutes = 60;
        // With no tick backfill (minute and hour charts), the last trades up to now (BarsRequest by count) stand in for
        // the forming minute, so that minute and the held live trades meet at one seam too. Only ChartBridge uses them.
        public const int SeamTicksBack = 20000;

        // One subscribe's load: minute history, tick backfill, then "ready" and the held live trades.
        private class Load
        {
            public ChartBridgeClient Client;
            public string Root, Name;
            public int Seq, TickHours;
            public Instrument Inst;
            public DateTime NowNt;
            public double StartedMs;
            public RawBars MinuteTail;               // the minute history's last (forming) bar, sent after the ticks
            public Task HeadSent = Task.FromResult(true);
            public bool TickToMargin, Retried;
            public int TailRebuilt = -1;             // minute bars rebuilt from ticks; -1 when there was no tail
            public long NtTailVolume = -1, RebuiltTailVolume = -1;   // that minute's volume, NinjaTrader's and rebuilt
            public int HeldAtAnswer = -1;            // trades held when NinjaTrader answered the tick request
            public string Sub;                       // the subscribe id on history, ticks and ready: the page's, or Seq
            // 0.3.4: tick charts also ask for the historical Bid and Ask ticks of the same window, at the same time as the
            // trades; the backfill goes out once all three are in (Arrived), each trade tagged with its side. 0.3.4.1: only
            // with quoteHours 1 or 2 in config.txt, and only those hours; otherwise only the trades are waited for.
            public int Waiting;                      // answers still to come (trades, bids, asks); under lock (L)
            public bool Proceeded, QuotesTimedOut;   // the backfill went out (Finish queued); it did not wait longer for quotes
            public RawBars LastTicks;
            public QuoteSeries Bids, Asks;
            public DateTime QuoteFrom;               // the quote window's start (QuoteWindowHours back)
            public int QuoteHours;                   // 0.3.4.1: the hours of Bid and Ask this load asked for (0: none)
            public string QuotesSkipped;             // 0.3.4.1: why none were asked (quoteHours 0, or one still outstanding); null when asked
            public double QuoteCopyMs;               // ChartBridge's time copying and thinning the two quote answers
            public bool HasBackLast; public DateTime BackLastTime; public double BackLastPrice; public int BackLastSide;   // the backfill's last trade (N3)
            public string BidNote = "asked", AskNote = "asked";   // then ok, empty, the error, or no answer in time, for /diag
            public bool BidRetried, AskRetried;
            public double QuotesAnsweredMs = -1;     // ms from the subscribe to the later of the two quote answers
            public string SubJson { get { return ",\"sub\":" + Sub; } }
            // 0.3.5: a tick chart's served window (subscribe "liveFirst"), and the page's wish for "profile" messages.
            public bool Window, Profile, FromCache;
            public string WindowAsked = "";          // the counts asked of NinjaTrader, for /diag ("200000, 600000")
            public WindowDiag Diag;
        }

        // /diag "windows" (0.3.5): each served window, last 20.
        private class WindowDiag
        {
            public int Client; public string Root, Sub, From, Asked, Error; public bool FromCache; public int Trades = -1; public double AtUtcMs, TimeToLiveMs = -1;
            public string Json()
            {
                return "{\"client\":" + Client + ",\"root\":" + CbJson.Str(Root) + ",\"sub\":" + (Sub ?? "null") + ",\"atUtcMs\":" + CbJson.Num3(AtUtcMs) +
                    ",\"fromCache\":" + (FromCache ? "true" : "false") + ",\"askedByCount\":" + CbJson.Str(Asked ?? "") + ",\"trades\":" + Trades +
                    ",\"from\":" + (From != null ? CbJson.Str(From) : "null") + ",\"timeToLiveMs\":" + (TimeToLiveMs >= 0 ? CbJson.Num3(TimeToLiveMs) : "null") +
                    ",\"error\":" + (Error != null ? CbJson.Str(Error) : "null") + "}";
            }
        }
        private static readonly List<WindowDiag> Windows = new List<WindowDiag>();

        // Still the page's latest subscribe? A load for an older one (the page resubscribed, say for more tick hours)
        // sends nothing more: its history and ticks would be taken as the new load's and counted twice.
        private static bool Current(Load L) { return L.Client.Root == L.Root && Volatile.Read(ref L.Client.SubscribeSeq) == L.Seq; }

        public static Func<DateTime> ClockForHarness;   // the harness's simulated NinjaTrader clock; null in NinjaTrader
        private static DateTime NowNt()
        {
            Func<DateTime> fake = ClockForHarness;
            if (fake != null) return fake();
            DateTime now = DateTime.Now;   // BarsRequest takes times in NinjaTrader's time zone setting
            try { now = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo); } catch (Exception) { }
            return now;
        }

        private static void Subscribe(ChartBridgeClient client, string root, int days, int tickHours) { StartLoad(client, root, days, tickHours, null, false, false); }

        // sub: the page's subscribe id (digits), or null to number the loads here. window (0.3.5, subscribe "liveFirst"): a
        // tick chart gets the served window instead of tickHours by date. profile (0.3.5): the page wants "profile" messages.
        private static void StartLoad(ChartBridgeClient client, string root, int days, int tickHours, string sub, bool window, bool profile)
        {
            Instrument inst;
            if (!Instruments.TryGetValue(root, out inst))
            {
                client.SendData("{\"type\":\"status\",\"level\":\"error\",\"text\":" + CbJson.Str("No instrument for " + root + ". Check the NinjaScript Output window.") + "}");
                return;
            }
            Load L = new Load { Client = client, Root = root, Name = inst.FullName, TickHours = tickHours, Inst = inst, Window = tickHours > 0 && !ByDateTickLoads, Profile = profile };   // S6: every tick chart gets the served window
            lock (client.Pending)   // from here every live trade for this root is held until MarkReady
            {
                L.Seq = ++client.SubscribeSeq;
                L.Sub = sub ?? L.Seq.ToString(CultureInfo.InvariantCulture);
                client.Ready = false;
                client.Pending.Clear();
                client.Root = root;
                client.WantsProfile = profile;
            }
            L.NowNt = NowNt();
            L.StartedMs = ChartBridgeTime.NowUtcMs();
            if (L.Window)
            {
                L.Diag = new WindowDiag { Client = client.Id, Root = root, Sub = L.Sub, AtUtcMs = L.StartedMs };
                lock (Windows) { Windows.Add(L.Diag); if (Windows.Count > 20) Windows.RemoveAt(0); }
            }

            BarsRequest minutes = new BarsRequest(inst, L.NowNt.AddDays(-days - (days >= 5 ? 3 : 1)), L.NowNt);
            minutes.BarsPeriod = new BarsPeriod { BarsPeriodType = BarsPeriodType.Minute, Value = 1 };
            minutes.TradingHours = inst.MasterInstrument.TradingHours;
            minutes.Request(new Action<BarsRequest, ErrorCode, string>((req, code, message) =>
            {
                try
                {
                    if (code != ErrorCode.NoError)
                    {
                        if (Current(L)) client.SendData("{\"type\":\"status\",\"level\":\"warn\",\"text\":" + CbJson.Str("Minute history failed: " + code + " " + message) + "}");
                    }
                    else if (Current(L))
                    {
                        RawBars raw = RawBars.Copy(req.Bars, false);     // quick copy on NinjaTrader's thread
                        if (raw.Count > 0)
                        {
                            // The last bar was still forming: it goes out after the ticks, rebuilt from them when it can be.
                            L.MinuteTail = raw.Slice(raw.Count - 1, raw.Count);
                            raw = raw.Slice(0, raw.Count - 1);
                        }
                        RawBars head = raw;
                        bool final = L.MinuteTail == null;
                        L.HeadSent = Task.Run(() => SendBars(L, head, final));   // format off-thread; stops if the page resubscribes
                    }
                }
                catch (Exception ex) { Log("history error: " + ex.Message); }
                finally { try { req.Dispose(); } catch (Exception) { } }
                RequestTicks(L);
            }));
        }

        // final: this is the last "history" message (done true on its last chunk; an empty one still says done).
        // Checked before every chunk: once the page has subscribed again, nothing more of this load goes out.
        private static void SendBars(Load L, RawBars bars, bool final)
        {
            const int chunk = 4000, barSeconds = 60;
            int n = bars.Count;
            StringBuilder b = null;
            int inChunk = 0;
            for (int i = 0; i < n; i++)
            {
                if (b == null)
                {
                    b = new StringBuilder(chunk * 48);
                    b.Append("{\"type\":\"history\",\"root\":").Append(CbJson.Str(L.Root)).Append(",\"name\":").Append(CbJson.Str(L.Name))
                     .Append(",\"barSeconds\":").Append(barSeconds).Append(L.SubJson).Append(",\"bars\":[");
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
                    b.Append("],\"done\":").Append(final && i == n - 1 ? "true" : "false").Append('}');
                    if (!L.Client.WaitForBulkRoom()) return;   // a few chunks at a time (review 4 S1)
                    if (!Current(L)) return;
                    L.Client.Send(b.ToString());
                    b = null;
                }
            }
            if (n == 0 && final && Current(L))
                L.Client.Send("{\"type\":\"history\",\"root\":" + CbJson.Str(L.Root) + ",\"name\":" + CbJson.Str(L.Name) + ",\"barSeconds\":" + barSeconds + L.SubJson + ",\"bars\":[],\"done\":true}");
        }

        // In NinjaTrader's answer to a tick request, right after the copy: how many live trades were held by then. Only
        // those can be in the backfill it handed over (counting after the copy errs toward "held at the answer", the
        // side that cannot count a trade twice). At whole seconds a trade held after this never matches at T.
        private static void NoteAnswer(Load L)
        {
            lock (L.Client.Pending) { if (Current(L)) L.HeldAtAnswer = L.Client.Pending.Count; }
        }

        private static void RequestTicks(Load L)
        {
            if (!Current(L)) return;   // a newer subscribe owns the client now
            if (L.Window) { ServeWindow(L); return; }
            if (L.TickHours > 0)
            {
                // 0.3.4.1: the Bid and Ask history only when config.txt asks for it (quoteHours 1 or 2), and never while an
                // earlier request for this instrument is still outstanding. Without it the backfill goes out as soon as the
                // trades are in, every trade by the tick rule; live trades keep their side from the live quote.
                int hours = QuoteWindowHours(ChartBridgeConfig.QuoteHours, L.TickHours);
                string skipped = hours > 0 ? null : "not requested (quoteHours 0)";
                if (hours > 0 && !BeginQuotes(L.Root)) { hours = 0; skipped = "not requested: an earlier bid/ask request for " + L.Root + " is still outstanding"; Log(L.Root + " bid/ask history " + skipped + " (see /diag sides)"); }
                lock (L)
                {
                    L.QuoteHours = hours; L.QuotesSkipped = skipped;
                    L.Waiting = hours > 0 ? 3 : 1;
                    if (hours > 0) L.QuoteFrom = L.NowNt.AddHours(-hours);
                    else { L.BidNote = skipped; L.AskNote = skipped; }
                }
                try { RequestTickHistory(L, true); }
                catch (Exception)
                {
                    if (hours > 0) QuotesNotAsked(L.Root);   // the quotes are never asked: free the gate
                    throw;
                }
                if (hours > 0)
                {
                    RequestQuotes(L, MarketDataType.Bid, true);
                    RequestQuotes(L, MarketDataType.Ask, true);
                }
                return;
            }
            if (L.MinuteTail == null) { L.HeadSent.ContinueWith(delegate { Finish(L, null); }, TaskScheduler.Default); return; }
            // 0.3.5: not while a session backfill is out (the forming minute then stays as NinjaTrader sent it); counted, so no
            // backfill starts while it is.
            if (!BeginTail()) { L.HeadSent.ContinueWith(delegate { Finish(L, null); }, TaskScheduler.Default); return; }
            // Minute and hour charts: only the last trades, for the forming minute (not sent to the page).
            BarsRequest ticks = new BarsRequest(L.Inst, SeamTicksBack);
            ticks.BarsPeriod = new BarsPeriod { BarsPeriodType = BarsPeriodType.Tick, Value = 1 };
            ticks.TradingHours = L.Inst.MasterInstrument.TradingHours;
            ticks.Request(new Action<BarsRequest, ErrorCode, string>((req, code, message) =>
            {
                RawBars raw = null;
                try
                {
                    if (code != ErrorCode.NoError) Log("last trades for the forming minute not loaded (" + code + " " + message + "); the minute stays as NinjaTrader sent it");
                    else if (Current(L)) { raw = RawBars.Copy(req.Bars, true); NoteAnswer(L); }
                }
                catch (Exception ex) { Log("last trades error: " + ex.Message); }
                finally { try { req.Dispose(); } catch (Exception) { } EndTail(); }
                RawBars copy = raw;
                L.HeadSent.ContinueWith(delegate { Finish(L, copy); }, TaskScheduler.Default);
            }));
        }

        private static void RequestTickHistory(Load L, bool margin)
        {
            ChartBridgeClient client = L.Client;
            L.TickToMargin = margin;
            DateTime to = margin ? L.NowNt.AddMinutes(TickToMarginMinutes) : NowNt();
            BarsRequest ticks = new BarsRequest(L.Inst, L.NowNt.AddHours(-L.TickHours), to);
            ticks.BarsPeriod = new BarsPeriod { BarsPeriodType = BarsPeriodType.Tick, Value = 1 };
            ticks.TradingHours = L.Inst.MasterInstrument.TradingHours;
            ticks.Request(new Action<BarsRequest, ErrorCode, string>((req, code, message) =>
            {
                RawBars raw = null;
                bool again = false;
                try
                {
                    if (code != ErrorCode.NoError)
                    {
                        if (Current(L) && margin) again = true;
                        else if (Current(L)) client.SendData("{\"type\":\"status\",\"level\":\"warn\",\"text\":" + CbJson.Str("Tick history failed: " + code + " " + message + ". Seconds and range bars start from now.") + "}");
                    }
                    else if (Current(L))
                    {
                        raw = RawBars.CopyTicks(req.Bars);
                        NoteAnswer(L);
                        if (margin && raw.Count == 0) { again = true; raw = null; }   // nothing at all from a request ending in the future: as refused
                    }
                }
                catch (Exception ex) { Log("tick history error: " + ex.Message); }
                finally { try { req.Dispose(); } catch (Exception) { } }
                if (again)
                {
                    Log("tick history ending " + TickToMarginMinutes + " minutes ahead " + (code != ErrorCode.NoError ? "was refused (" + code + " " + message + ")" : "came back empty") + "; asking again, ending now");
                    L.Retried = true;
                    RequestTickHistory(L, false);
                    return;
                }
                lock (L) L.LastTicks = raw;
                Arrived(L, true);
            }));
        }

        // 0.3.4: the historical Bid or Ask ticks for the tick backfill's window, for the side of each trade. Asked like the
        // trades: ending past now, and once more ending now if that is refused or empty. Missing is not an error: the
        // trades then go by the tick rule, and /diag says so.
        private static void RequestQuotes(Load L, MarketDataType type, bool margin)
        {
            bool isBid = type == MarketDataType.Bid;
            try { RequestQuotesOnce(L, type, margin); }
            catch (Exception ex)
            {
                // Could not even ask: count it as answered (with nothing), so the backfill never waits on it.
                Log((isBid ? "bid" : "ask") + " history request error: " + ex.Message);
                QuoteAnswered(L.Root);
                lock (L) { if (!L.Proceeded) { if (isBid) L.BidNote = "error: " + ex.Message; else L.AskNote = "error: " + ex.Message; } }
                Arrived(L, false);
            }
        }

        private static void RequestQuotesOnce(Load L, MarketDataType type, bool margin)
        {
            bool isBid = type == MarketDataType.Bid;
            DateTime to = margin ? L.NowNt.AddMinutes(TickToMarginMinutes) : NowNt();
            BarsRequest quotes = new BarsRequest(L.Inst, L.QuoteFrom, to);
            quotes.BarsPeriod = new BarsPeriod { BarsPeriodType = BarsPeriodType.Tick, Value = 1, MarketDataType = type };
            quotes.TradingHours = L.Inst.MasterInstrument.TradingHours;
            quotes.Request(new Action<BarsRequest, ErrorCode, string>((req, code, message) =>
            {
                QuoteSeries raw = null;
                bool again = false, wanted;
                string note = "not loaded";
                lock (L) wanted = !L.Proceeded;
                try
                {
                    if (code != ErrorCode.NoError)
                    {
                        note = "error: " + code + " " + message;
                        if (Current(L) && margin && wanted) again = true;
                    }
                    else if (Current(L) && wanted)   // no copy for a load that already went out or was replaced
                    {
                        Stopwatch sw = Stopwatch.StartNew();
                        raw = QuoteSeries.From(req.Bars, L.QuoteFrom);
                        sw.Stop();
                        lock (L) L.QuoteCopyMs += sw.Elapsed.TotalMilliseconds;
                        note = raw.Count > 0 ? "ok" : "empty";
                        if (margin && raw.Count == 0) { again = true; raw = null; }
                    }
                }
                catch (Exception ex) { raw = null; note = "error: " + ex.Message; Log((isBid ? "bid" : "ask") + " history error: " + ex.Message); }
                finally { try { req.Dispose(); } catch (Exception) { } }
                if (again)
                {
                    lock (L) { if (isBid) L.BidRetried = true; else L.AskRetried = true; }
                    RequestQuotes(L, type, false);   // still outstanding: the retry answers for it
                    return;
                }
                QuoteAnswered(L.Root);
                lock (L)
                {
                    if (!L.Proceeded)   // a late answer (after QuoteWaitMs) is not used
                    {
                        if (isBid) { L.Bids = raw; L.BidNote = note; } else { L.Asks = raw; L.AskNote = note; }
                        L.QuotesAnsweredMs = ChartBridgeTime.NowUtcMs() - L.StartedMs;
                    }
                }
                Arrived(L, false);
            }));
        }

        // One of the tick chart's three answers is in (a failed or stale one counts); after the last, the backfill goes out.
        // The live trades stay held until then, so the quotes get at most QuoteWaitMs (2.5 s) after the trades are in: past
        // that the backfill goes out without them (tick rule; /diag says so) and a late answer is ignored. 2.5 s: the quotes
        // are asked at the same time as the trades, so a quote history NinjaTrader already has comes back with them or
        // soon after; a slow first download then costs one load's sides (tick rule, reported), not seconds more of a frozen
        // chart and a longer hold. When the trade request failed there is nothing to classify and no wait at all.
        public static int QuoteWaitMs = 2500;
        // The quote window: at most the last 24 hours (a range view may ask up to 48 hours of trades). Older trades go by
        // the tick rule (beforeQuotes). 0.3.4.1: quoteHours (at most 2) sets the window now; this stays as a ceiling.
        public const int QuoteHoursMax = 24;

        // 0.3.4.1: the hours of Bid and Ask a tick load asks for: quoteHours (0, 1 or 2 from config.txt), at most the trades'
        // own window and QuoteHoursMax. 0: none asked (also for minute and hour charts, which have no tick backfill).
        public static int QuoteWindowHours(int quoteHours, int tickHours)
        {
            if (quoteHours <= 0 || tickHours <= 0) return 0;
            return Math.Min(Math.Min(quoteHours, tickHours), QuoteHoursMax);
        }

        // 0.3.4.1: the Bid and Ask requests NinjaTrader has not answered yet, per instrument root (2 when a load asks for
        // both). NinjaTrader's help documents no way to cancel a BarsRequest that has been sent (BarsRequest: Request(),
        // Dispose() once done), so a load that went out without its quotes cannot stop them; instead a reload does not ask
        // again until they have answered (its trades go by the tick rule, and /diag says why). A request that never
        // answers keeps that instrument's quotes off until NinjaTrader restarts: the safe side.
        private static readonly Dictionary<string, int> QuotesOutstanding = new Dictionary<string, int>();

        private static bool BeginQuotes(string root)
        {
            lock (QuotesOutstanding)
            {
                int n;
                if (QuotesOutstanding.TryGetValue(root, out n) && n > 0) return false;
                QuotesOutstanding[root] = 2;
                return true;
            }
        }

        private static void QuoteAnswered(string root)
        {
            lock (QuotesOutstanding)
            {
                int n;
                if (QuotesOutstanding.TryGetValue(root, out n) && n > 0) QuotesOutstanding[root] = n - 1;
            }
        }

        // BeginQuotes took the gate but the load failed before either quote request was made (the trade request threw).
        private static void QuotesNotAsked(string root)
        {
            lock (QuotesOutstanding) QuotesOutstanding[root] = 0;
        }

        private static int QuotesOutstandingFor(string root)
        {
            lock (QuotesOutstanding) { int n; return QuotesOutstanding.TryGetValue(root, out n) ? n : 0; }
        }

        private static void Arrived(Load L, bool trades)
        {
            bool go = false, wait = false;
            lock (L)
            {
                L.Waiting--;
                if (L.Proceeded) return;
                if (L.Waiting <= 0 || (trades && L.LastTicks == null)) { L.Proceeded = true; go = true; }   // no trades: no wait
                else if (trades) wait = true;
            }
            if (go) { Proceed(L); return; }
            if (wait)
                Task.Delay(QuoteWaitMs).ContinueWith(delegate
                {
                    lock (L)
                    {
                        if (L.Proceeded) return;
                        L.Proceeded = true; L.QuotesTimedOut = true;
                        string late = "no answer within " + (QuoteWaitMs / 1000.0).ToString(CultureInfo.InvariantCulture) + " s of the trades";
                        if (L.Bids == null && L.BidNote == "asked") L.BidNote = late;
                        if (L.Asks == null && L.AskNote == "asked") L.AskNote = late;
                    }
                    Proceed(L);
                }, TaskScheduler.Default);
        }

        private static void Proceed(Load L)
        {
            RawBars copy;
            lock (L) copy = L.LastTicks;
            L.HeadSent.ContinueWith(delegate { Finish(L, copy); }, TaskScheduler.Default);   // review 5 N4: Finish can wait at the page's pace; never on a NinjaTrader scheduler
        }

        // Order on the wire: minute history, its last bar (rebuilt from the ticks when it can be), the tick backfill
        // (tick charts only), then "ready" and the held live trades not already in the backfill.
        private static void Finish(Load L, RawBars ticks)
        {
            RawBars seam = L.TickHours > 0 ? ticks : null;   // what the held trades are matched against
            try
            {
                if (!Current(L)) return;
                if (L.MinuteTail != null)
                {
                    RawBars tail = ticks != null ? ChartBridgeSeam.TailFromTicks(L.MinuteTail.Time[0], ticks.Time, ticks.Close, ticks.Volume, ticks.Count) : null;
                    L.NtTailVolume = L.MinuteTail.Volume[0];
                    if (tail != null)
                    {
                        L.RebuiltTailVolume = 0;
                        for (int i = 0; i < tail.Count; i++) if (tail.Time[i] == L.MinuteTail.Time[0]) L.RebuiltTailVolume = tail.Volume[i];
                        // The ticks were answered after the minutes, so they should hold at least as much of that minute.
                        // Less means the tick data lags: keep NinjaTrader's bar (and, on minute charts, release every held trade).
                        if (L.RebuiltTailVolume < L.NtTailVolume) tail = null;
                    }
                    L.TailRebuilt = tail != null ? tail.Count : 0;
                    if (tail != null) seam = ticks;   // minute charts: only when the forming minute came from these same ticks
                    SendBars(L, tail ?? L.MinuteTail, true);
                }
                if (ticks != null && L.TickHours > 0)
                {
                    BackfillSides sides = null;
                    try { sides = ClassifyLoad(L, ticks); }
                    catch (Exception ex) { Log("trade side error (backfill sent without sides): " + ex.Message); }
                    SendTicks(L, ticks, sides);
                }
            }
            catch (Exception ex) { Log("tick send error: " + ex.Message); }
            finally
            {
                lock (L) { L.Bids = null; L.Asks = null; L.LastTicks = null; }   // the quote history can be large
                MarkReady(L, seam);
            }
        }

        // The backfill's sides by the quote history (ChartBridgeSides.ClassifyBackfill), noted for /diag.
        private static BackfillSides ClassifyLoad(Load L, RawBars ticks)
        {
            QuoteSeries b, a;
            lock (L) { b = L.Bids; a = L.Asks; }
            BackfillSides r = ChartBridgeSides.ClassifyBackfill(ticks.Time, ticks.Close, ticks.Count,
                b != null ? b.Time : null, b != null ? b.Price : null, b != null ? b.Seen : null, b != null ? b.Count : 0,
                a != null ? a.Time : null, a != null ? a.Price : null, a != null ? a.Seen : null, a != null ? a.Count : 0,
                ticks.Bid, ticks.Ask, ticks.StampFrom, L.Inst.MasterInstrument.TickSize);
            if (r.Trades > 0)
                lock (L) { L.HasBackLast = true; L.BackLastTime = ticks.Time[r.Trades - 1]; L.BackLastPrice = ticks.Close[r.Trades - 1]; L.BackLastSide = r.Side[r.Trades - 1]; }
            NoteSides(L, r, b, a);
            return r;
        }

        // Each trade is [t, p, v], and since 0.3.4 [t, p, v, s, sm] (side and method) when the sides were worked out: the
        // first three keep their places, so a page that reads only them is unchanged.
        private static void SendTicks(Load L, RawBars bars, BackfillSides sides) { SendTicks(L, bars, sides, 0); }
        // from (0.3.5): the first trade to send (a served window is cut at rangeHours).
        private static void SendTicks(Load L, RawBars bars, BackfillSides sides, int from)
        {
            const int chunk = 20000;
            int n = bars.Count;
            if (sides != null && sides.Trades != n) sides = null;
            StringBuilder b = null; int inChunk = 0;
            ChartBridgeTime.EtCache et = new ChartBridgeTime.EtCache();
            for (int i = Math.Max(0, from); i < n; i++)
            {
                if (b == null) { b = new StringBuilder(chunk * 34); b.Append("{\"type\":\"ticks\",\"root\":").Append(CbJson.Str(L.Root)).Append(L.SubJson).Append(",\"ticks\":["); inChunk = 0; }
                if (inChunk > 0) b.Append(',');
                AppendTrade(b, bars, sides, i, et);
                inChunk++;
                if (inChunk == chunk || i == n - 1)
                {
                    b.Append("],\"done\":").Append(i == n - 1 ? "true" : "false").Append('}');
                    if (!L.Client.WaitForBulkRoom()) return;   // a few chunks at a time (review 4 S1)
                    if (!Current(L)) return;   // the page subscribed again: stop mid-backfill
                    L.Client.Send(b.ToString()); b = null;
                }
            }
            if (Math.Max(0, from) >= n && Current(L)) L.Client.Send("{\"type\":\"ticks\",\"root\":" + CbJson.Str(L.Root) + L.SubJson + ",\"ticks\":[],\"done\":true}");
        }

        // One trade as the page reads it: [t, p, v], and [t, p, v, s, sm] with its side (0.3.4). The same text as 0.3.4 wrote,
        // with no string made per number (0.3.5, CbJson.AppendNum3 and AppendNum; the harness compares them).
        public static void AppendTrade(StringBuilder b, RawBars bars, BackfillSides sides, int i, ChartBridgeTime.EtCache et)
        {
            b.Append('[');
            CbJson.AppendNum3(b, et.Seconds(bars.Time[i]));
            b.Append(',');
            CbJson.AppendNum(b, bars.Close[i]);
            b.Append(',');
            CbJson.AppendLong(b, bars.Volume[i]);
            if (sides != null) { b.Append(','); CbJson.AppendLong(b, sides.Side[i]); b.Append(','); CbJson.AppendLong(b, sides.Method[i]); }
            b.Append(']');
        }

        // "ready", then the held live trades that are not in the backfill (ChartBridgeSeam.Dedupe), in the order they came.
        // Under the Pending lock, so no live trade can slip between the held ones and the ones that follow. 0.3.5: the
        // "profile" first (S4): the table copied under the book's lock together with the trades held so far (all in it), then
        // formatted with no lock held, less those of them that are released after it (the page adds them as it gets them).
        // The trades held after the copy are not in it and are released after it too.
        private static void MarkReady(Load L, RawBars seam)
        {
            ChartBridgeClient client = L.Client;
            string profile = null;
            if (L.Profile)
            {
                RootBook book = BookOf(L.Root, L.Inst);
                ProfileSnap snap; List<SeamTick> before;
                lock (book.Sync)
                lock (client.Pending)
                {
                    if (!Current(L)) return;
                    snap = book.Snap();
                    before = new List<SeamTick>(client.Pending);
                }
                // Dedupe decides each held trade in order, so the first ones decide the same way now as with more after them.
                SeamResult early = seam != null ? ChartBridgeSeam.Dedupe(seam.Time, seam.Close, seam.Volume, seam.Count, before, L.HeldAtAnswer)
                    : ChartBridgeSeam.Dedupe(null, null, null, 0, before);
                profile = snap.Json(L.Sub, early.Release);
            }
            lock (client.Pending)
            {
                if (!Current(L)) return;
                SeamResult r = seam != null
                    ? ChartBridgeSeam.Dedupe(seam.Time, seam.Close, seam.Volume, seam.Count, client.Pending, L.HeldAtAnswer)
                    : ChartBridgeSeam.Dedupe(null, null, null, 0, client.Pending);
                // "ready" and the released trades go into the page's outbox as ONE data-lane entry (SendAll, 0.3.4): order
                // traffic still goes out between them, and the page is not closed while it keeps draining (ChartBridgeClient).
                List<string> burst = new List<string>(r.Release.Count + 2);
                if (profile != null) burst.Add(profile);
                burst.Add("{\"type\":\"ready\",\"root\":" + CbJson.Str(L.Root) + L.SubJson + "}");
                foreach (SeamTick h in ContinueSides(L, r.Release)) burst.Add(h.Json);
                client.SendAll(burst);
                DateTime? firstHeld = client.Pending.Count > 0 ? client.Pending[0].Time : (DateTime?)null;
                client.Pending.Clear();
                client.Ready = true;
                NoteSeam(L, r, seam != null, firstHeld);
                if (L.Diag != null) L.Diag.TimeToLiveMs = ChartBridgeTime.NowUtcMs() - L.StartedMs;
            }
        }

        // N3: the released trades' tick rule continues from the backfill's copy of the seam trade, not from its dropped live
        // twin (whose live side can differ). Trades classified by the quote keep their side; tick-rule ones are worked out
        // again along the chain and their message rewritten. The live tagger then continues from the last of them.
        private static List<SeamTick> ContinueSides(Load L, List<SeamTick> release)
        {
            bool has; DateTime lastTime; double lastPrice; int lastSide;
            lock (L) { has = L.HasBackLast; lastTime = L.BackLastTime; lastPrice = L.BackLastPrice; lastSide = L.BackLastSide; }
            if (!has) return release;
            List<SeamTick> outList = ChartBridgeSides.ContinueTickRule(release, lastTime, lastPrice, lastSide, out lastTime, out lastPrice, out lastSide);
            SideTagger(L.Root).FixLast(lastTime, lastPrice, lastSide);
            return outList;
        }

        // ---------------------------------------------------------- 0.3.5: the served window
        // Every tick chart (Range or seconds; 0.3.5 never runs the by-date tick load of 0.3.4, S6) starts with the last
        // rangeHours of trades. ChartBridge asks NinjaTrader for them BY COUNT (BarsRequest(instrument, barsBack)), sized from
        // the live trade rate, and at most once more with three times the count when the answer is full and still does not
        // reach back rangeHours (two asks at most). One request per instrument at a time (B2): loads that come while it is
        // outstanding (a second page, a reload, a view switch) wait for the same answer. The answer is kept whatever load is
        // current: cut at rangeHours and joined to the live trades since the ask by the 0.3.3 seam, it is the instrument's
        // served window (RootBook.Cache), extended by every live trade. Every later load of that instrument gets its trades
        // from there and NinjaTrader is not asked again. Dropped at the next session, at a feed drop, and after the session
        // ends (a weekend). When a window fails, loads get none (their charts start from live trades) and NinjaTrader is not
        // asked again for WindowRetryMs. The request itself waits its turn at the gate (one tick request at a time).
        public static int WindowFirstGuess = 200000;   // no live rate known yet (settable for the harness)
        public const int WindowMaxTicks = 2000000;
        public static int WindowRetryMs = 60000;       // after a failed window, no new ask for a minute
        public static int GapReaskMs = 600000;         // S-G: a window missing a feed drop is asked again at most once in 10 minutes
        public static bool ByDateTickLoads;            // the harness only: 0.3.4's by-date tick load, kept for its tests; never on in 0.3.5

        private static void ServeWindow(Load L)
        {
            RootBook book = BookOf(L.Root, L.Inst);
            bool ask = false, none = false; int gen = 0, count = WindowFirstGuess;
            string stuck; lock (GateLock) stuck = gateStuck;
            lock (book.Sync)
            {
                double nowMs = ChartBridgeTime.NowUtcMs();
                bool backoff = book.WindowFailedMs >= 0 && nowMs - book.WindowFailedMs < WindowRetryMs;
                // S-G: a served window that misses a feed drop is asked again at a load, at most once in GapReaskMs per instrument,
                // and only when the ask can go out now (review 4 S4): else the window is served with its gap
                if (book.Cache != null && book.CacheGap && stuck == null && !backoff && !book.WindowAsking && (book.GapAskMs < 0 || nowMs - book.GapAskMs >= GapReaskMs))
                { book.Cache = null; book.CacheGap = false; book.GapAskMs = nowMs; }
                if (book.Cache == null)
                {
                    if (book.WindowAsking && stuck == null) { book.WindowWaiters.Add(L); if (L.Diag != null) L.Diag.Asked = "shared"; return; }   // the same answer
                    if (stuck != null) { none = true; if (L.Diag != null) L.Diag.Error = StuckNote(stuck); }   // X1, review 4 B1: never waits on it
                    else if (backoff) none = true;
                    else
                    {
                        ask = true; gen = ++book.WindowGen;
                        book.WindowAsking = true; book.WindowWaiters.Add(L); book.WindowLive = new List<SeamTick>(4096);
                        double rate = book.RatePerHour(ChartBridgeTime.NowUtcMs());
                        if (rate > 0) count = (int)Math.Max(20000, Math.Min(WindowMaxTicks, rate * ChartBridgeConfig.RangeHours * 1.5));
                    }
                }
            }
            if (none)
            {
                if (L.Diag != null && L.Diag.Error == null) L.Diag.Error = "the last window failed less than " + (WindowRetryMs / 1000) + " s ago: not asked again yet";
                L.HeadSent.ContinueWith(delegate { FinishWindow(L, null); }, TaskScheduler.Default);
                return;
            }
            if (ask) { AskWindow(book, L.Inst, gen, count, 1); return; }
            if (!ServeFromCache(L, book) && Current(L)) ServeWindow(L);   // the served window was just dropped (18:00, a feed drop): ask
        }

        // A load's trades from the served window: fixed under the book's lock (the page's held trades are all in it, so they
        // are cleared), copied and sent with no lock held.
        private static bool ServeFromCache(Load L, RootBook book)
        {
            TradeLog.View view;
            lock (book.Sync)
            lock (L.Client.Pending)
            {
                if (!Current(L)) return true;
                if (book.Cache == null) return false;
                view = book.Cache.Snapshot(); book.Cache.Served++; L.Client.Pending.Clear();
            }
            L.FromCache = true;
            if (L.Diag != null) L.Diag.FromCache = true;
            L.HeadSent.ContinueWith(delegate { FinishWindow(L, view.ToBars()); }, TaskScheduler.Default);
            return true;
        }

        private static void AskWindow(RootBook book, Instrument inst, int gen, int count, int round)
        {
            GateJob j = new GateJob { Kind = "window", Root = book.Root, Book = book, TimeoutMs = WindowTimeoutMs };
            j.OnTimeout = () => WindowFailed(book, gen, "no answer from NinjaTrader in " + (WindowTimeoutMs / 1000) + " s", true);
            j.OnStuck = what => WindowFailed(book, gen, StuckNote(what), false);   // review 4 B1: never left waiting on a stuck gate
            j.Start = done =>
            {
                lock (book.Sync)
                {
                    if (book.WindowGen != gen || !book.WindowAsking) { done(); return; }
                    book.WindowAsks++;
                    book.WindowAskedText = (round > 1 ? book.WindowAskedText + ", " : "") + count.ToString(CultureInfo.InvariantCulture);
                }
                BarsRequest ticks = new BarsRequest(inst, count);
                ticks.BarsPeriod = new BarsPeriod { BarsPeriodType = BarsPeriodType.Tick, Value = 1 };
                ticks.TradingHours = inst.MasterInstrument.TradingHours;
                ticks.Request(new Action<BarsRequest, ErrorCode, string>((req, code, message) =>
                {
                    // On NinjaTrader's thread only the copy (its Bars are its own) and a count; everything else on a worker. An answer
                    // given up (X1) is dropped at once, not copied. A full answer that does not reach back rangeHours is not copied
                    // either: the second, larger ask is queued before the gate goes on (review 3 S-D: ahead of any backfill).
                    if (j.Stop.IsCancellationRequested) { try { req.Dispose(); } catch (Exception) { } return; }   // review 6 S1: ChartBridge stopped since: dropped, not copied
                    if (!Claim(j)) { try { req.Dispose(); } catch (Exception) { } if (LateAnswer(j)) GateUnstuck(j, "window " + book.Root); return; }   // review 4 S1: timed out first
                    Stopwatch sw = Stopwatch.StartNew();
                    RawBars raw = null; string error = null; int held = 0; bool again = false;
                    try
                    {
                        if (code != ErrorCode.NoError) error = code + " " + message;
                        else
                        {
                            int n = req.Bars != null ? req.Bars.Count : 0;
                            again = n >= count && n > 0 && req.Bars.GetTime(0) > NowNt().AddHours(-ChartBridgeConfig.RangeHours) && count < WindowMaxTicks && round < 2;
                            if (!again) { raw = RawBars.Copy(req.Bars, true); lock (book.Sync) held = book.WindowLive != null ? book.WindowLive.Count : 0; }
                        }
                    }
                    catch (Exception ex) { error = ex.Message; again = false; }
                    finally { try { req.Dispose(); } catch (Exception) { } }
                    double cbMs = sw.Elapsed.TotalMilliseconds;
                    if (again) AskWindow(book, inst, gen, Math.Min(WindowMaxTicks, count * 3), round + 1);   // queued ahead of any backfill
                    done();
                    if (!again) Task.Run(() => OnWindowAnswer(book, inst, gen, count, round, raw, held, error, cbMs));
                    else lock (book.Sync) { if (book.WindowGen == gen) book.WindowCallbackMs = Math.Max(book.WindowCallbackMs, cbMs); }
                }));
            };
            GateEnqueue(j);
        }

        private static void OnWindowAnswer(RootBook book, Instrument inst, int gen, int count, int round, RawBars raw, int held, string error, double cbMs)
        {
            try
            {
                lock (book.Sync) { if (book.WindowGen == gen) book.WindowCallbackMs = Math.Max(book.WindowCallbackMs, cbMs); }
                if (raw == null) { WindowFailed(book, gen, error ?? "no answer", true); return; }
                DateTime from = NowNt().AddHours(-ChartBridgeConfig.RangeHours);
                int start = 0;
                while (start < raw.Count && raw.Time[start] < from) start++;   // cut at rangeHours
                TradeLog cache = new TradeLog();
                for (int i = start; i < raw.Count; i++) cache.Add(raw.Time[i], raw.Close[i], raw.Volume[i]);   // off every lock
                List<object> waiters;
                lock (book.Sync)
                {
                    if (book.WindowGen != gen || !book.WindowAsking) return;   // failed or given up meanwhile (its loads were answered)
                    if (book.WindowLive == null) { waiters = null; }        // abandoned (too many live trades) or a feed drop
                    else
                    {
                        SeamResult r = ChartBridgeSeam.Dedupe(raw.Time, raw.Close, raw.Volume, raw.Count, book.WindowLive, held);
                        foreach (SeamTick h in r.Release) cache.Add(h.Time, h.Price, h.Volume);   // the live trades not in the answer
                        book.Cache = cache; book.WindowAsking = false; book.WindowLive = null; book.WindowFailedMs = -1;
                        waiters = new List<object>(book.WindowWaiters); book.WindowWaiters.Clear();
                    }
                }
                if (waiters == null) { WindowFailed(book, gen, "the live trades could not be joined to it (a feed drop, or too many while it came)", false); return; }
                string asked; lock (book.Sync) asked = book.WindowAskedText;
                foreach (object o in waiters)
                {
                    Load w = (Load)o;
                    if (w.Diag != null && w.Diag.Asked == null) w.Diag.Asked = asked;
                    if (Current(w) && !ServeFromCache(w, book)) w.HeadSent.ContinueWith(delegate { FinishWindow(w, null); }, TaskScheduler.Default);
                }
            }
            catch (Exception ex) { Log("window error: " + ex.Message); WindowFailed(book, gen, ex.Message, true); }
        }

        // A window that failed: its loads go live with no trades (their charts start from now), and no new ask for a minute.
        private static void WindowFailed(RootBook book, int gen, string why, bool backoff)
        {
            List<object> waiters;
            lock (book.Sync)
            {
                if (book.WindowGen != gen || !book.WindowAsking) return;
                book.WindowGen++; book.WindowAsking = false; book.WindowLive = null;
                if (backoff) book.WindowFailedMs = ChartBridgeTime.NowUtcMs();   // a stuck gate or the cap: the next load may ask again
                book.WindowFailures++; book.WindowError = why;
                waiters = new List<object>(book.WindowWaiters); book.WindowWaiters.Clear();
            }
            Log(book.Root + " tick window failed (" + why + "); tick charts start from live trades" + (backoff ? ", asked again after " + (WindowRetryMs / 1000) + " s at the earliest" : ""));
            foreach (object o in waiters)
            {
                Load w = (Load)o;
                if (w.Diag != null) w.Diag.Error = why;
                if (Current(w)) w.HeadSent.ContinueWith(delegate { FinishWindow(w, null); }, TaskScheduler.Default);
            }
        }

        // The served window out: the forming minute (rebuilt from it when it can be), the trades, then "ready". ticks null:
        // none (the window failed).
        private static void FinishWindow(Load L, RawBars ticks)
        {
            try
            {
                if (!Current(L)) return;
                if (L.MinuteTail != null)
                {
                    RawBars tail = ticks != null ? ChartBridgeSeam.TailFromTicks(L.MinuteTail.Time[0], ticks.Time, ticks.Close, ticks.Volume, ticks.Count) : null;
                    L.NtTailVolume = L.MinuteTail.Volume[0];
                    if (tail != null)
                    {
                        L.RebuiltTailVolume = 0;
                        for (int i = 0; i < tail.Count; i++) if (tail.Time[i] == L.MinuteTail.Time[0]) L.RebuiltTailVolume = tail.Volume[i];
                        if (L.RebuiltTailVolume < L.NtTailVolume) tail = null;
                    }
                    L.TailRebuilt = tail != null ? tail.Count : 0;
                    SendBars(L, tail ?? L.MinuteTail, true);
                }
                if (ticks == null)
                {
                    L.Client.SendData("{\"type\":\"status\",\"level\":\"warn\",\"text\":" + CbJson.Str("Tick history failed" + (L.Diag != null && L.Diag.Error != null ? ": " + L.Diag.Error : "") + ". Seconds and range bars start from now.") + "}");
                    L.Client.Send("{\"type\":\"ticks\",\"root\":" + CbJson.Str(L.Root) + L.SubJson + ",\"ticks\":[],\"done\":true}");
                }
                else
                {
                    if (L.Diag != null) { L.Diag.Trades = ticks.Count; if (ticks.Count > 0) L.Diag.From = EtText(ticks.Time[0]); }
                    SendTicks(L, ticks, null);
                }
            }
            catch (Exception ex) { Log("window send error: " + ex.Message); }
            finally { MarkReady(L, null); }
        }

        // ---------------------------------------------------------- 0.3.5: one tick request to NinjaTrader at a time
        // The served windows' requests and the session backfills go to NinjaTrader one at a time, windows first (B1, B2). A
        // backfill starts only with nothing else outstanding: no window request, no backfill, no minute chart's last-trades
        // request. A minute chart's last trades (as in 0.3.3) are not queued here: they can go beside a window or each other,
        // and are skipped while a backfill is out (its forming minute stays as NinjaTrader sent it). A request NinjaTrader does
        // not answer in time is given up for its loads (they go on without it), but it stays outstanding (review 3 X1): no
        // tick request goes out until NinjaTrader answers it (or restarts), and that late answer is dropped at once, not
        // copied. Meanwhile nothing waits on it (review 4 B1, S2): a window load goes live at once with the reason, and a
        // queued backfill says it waits.
        // State (review 4 S1): 0 out, 1 answered, 2 timing out (the worker is marking the gate stuck), 3 timed out; claimed once
        // with Interlocked, so an answer and a timeout never both act, and an answer that loses to the timeout still frees the
        // gate (GateUnstuck), but only once the gate is marked: an answer during the marking (4) leaves that to the worker, so it
        // never frees the gate before the worker marks it stuck. 5: answered, but its copy outlasted AnswerCopyMs, so treated as
        // timed out; 6: that copy ended, the gate freed (review 5 N2).
        private class GateJob { public string Kind, Root; public RootBook Book; public Action<Action> Start; public Action OnTimeout; public Action<string> OnStuck; public int TimeoutMs; public int State; public CancellationToken Stop; }
        private static bool Claim(GateJob j) { return Interlocked.CompareExchange(ref j.State, 1, 0) == 0; }
        // An answer that lost to the timeout: true when the gate is already marked stuck, so the caller frees it (GateUnstuck).
        private static bool LateAnswer(GateJob j) { return Interlocked.CompareExchange(ref j.State, 4, 2) != 2; }
        // The note for a load (and the log) while a request is stuck: what it turns off, and until when.
        private static string StuckNote(string what) { return "NinjaTrader has not answered an earlier tick request (" + what + ") yet; tick history is not asked for until it does or NinjaTrader restarts"; }
        private static double gateStuckSinceMs = -1;
        private static readonly object GateLock = new object();
        private static readonly List<GateJob> GateWindows = new List<GateJob>(), GateBackfills = new List<GateJob>();
        private static bool gateRunning;
        private static bool gateStopped;              // set by StopGate, cleared by Start: nothing is queued or sent meanwhile (review 6 S1)
        private static GateJob gateStuckJob;          // the request that set gateStuck: only its own answer frees it (review 6 N1)
        private static Task gateTask;                 // the worker, stopped and joined by Stop (review 5 N6)
        private static CancellationTokenSource gateStop = new CancellationTokenSource();   // cancels the worker's waits and the backfill retries' timers
        private static string gateNow;                // the request outstanding now, for /diag and the minute charts
        private static string gateStuck;              // a request given up but not answered yet: nothing else goes out (X1)
        private static int tailsOut;                  // minute charts' last-trades requests outstanding
        public static int WindowTimeoutMs = 120000, BackfillTimeoutMs = 300000, BackfillGapMs = 3000, BackfillStartMs = 60000, BackfillRetryMs = 60000;
        public static int AnswerCopyMs = 30000;   // review 5 N2: an answer that claimed its request at the limit has this long to finish its copy
        public static bool BackfillOn = true;         // the harness turns it off for the cases that do not test it

        private static void GateEnqueue(GateJob j)
        {
            string stuck;
            lock (GateLock)
            {
                if (gateStopped) return;               // review 6 S1: after Stop nothing goes to NinjaTrader (its pages are closed)
                stuck = gateStuck;
                if (stuck == null || j.Kind != "window") (j.Kind == "window" ? GateWindows : GateBackfills).Add(j);
            }
            if (stuck != null && j.OnStuck != null) { j.OnStuck(stuck); if (j.Kind == "window") return; }   // review 4 B1, S2
            GateKick();
        }
        // Starts the worker when there is work and it is not running (after an enqueue, a late answer, a tail's end).
        private static void GateKick()
        {
            lock (GateLock)
            {
                if (gateStopped || gateRunning || (GateWindows.Count == 0 && GateBackfills.Count == 0 && GateBarJobs.Count == 0)) return;
                gateRunning = true;
                CancellationToken stop = gateStop.Token;
                // Its own thread (review 6 N2): it waits up to minutes on a request, so it does not hold a thread-pool thread.
                gateTask = Task.Factory.StartNew(() => GateWorker(stop), CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            }
        }
        // Stop(): the gate is marked stopped (nothing is queued, no worker starts, an answer that comes later is dropped uncopied;
        // review 6 S1), the worker leaves its wait and ends, and the backfill retries' timers are cancelled, so nothing of the
        // gate runs on after ChartBridge stops (review 5 N6). Stop() waits joinMs 250 for the worker (it runs on NinjaTrader's
        // thread, review 6 S2); a worker still inside a NinjaTrader call then ends on its own and can send nothing. The harness
        // waits 5 s before it exits.
        public static void StopGate(int joinMs = 5000)
        {
            Task worker; CancellationTokenSource stop;
            lock (GateLock)
            {
                gateStopped = true;
                GateWindows.Clear(); GateBackfills.Clear(); GateBarJobs.Clear(); gateStuck = null; gateStuckJob = null; gateStuckSinceMs = -1; gateNow = null;
                worker = gateTask; gateTask = null; gateRunning = false;
                stop = gateStop; gateStop = new CancellationTokenSource();
            }
            try { stop.Cancel(); } catch (Exception) { }
            try { if (worker != null && !worker.Wait(joinMs)) Log("the tick request worker did not end within " + joinMs + " ms of the stop; it ends on its own and sends nothing more"); } catch (Exception) { }
        }
        // Start(): the gate takes requests again (a start in the same process, as in the harness).
        private static void StartGate() { lock (GateLock) gateStopped = false; }

        // Under GateLock: the next request to send, or null. wait: when null, whether to look again soon (a backfill waiting
        // for its start time or for page loads to end) rather than stop until a kick (nothing else can change it).
        private static GateJob GateNext(out bool wait)
        {
            wait = false;
            if (gateStuck != null) return null;       // X1: strictly one at a time, also after a timeout
            GateJob j = null;
            if (GateWindows.Count > 0) { j = GateWindows[0]; GateWindows.RemoveAt(0); return j; }
            if (GateBackfills.Count == 0)
            {
                // 0.3.6: a daily bars request, last of all: no backfill queued, no minute chart's last trades out, no page loading
                if (GateBarJobs.Count == 0 || tailsOut > 0) return null;
                if (PageLoading()) { wait = true; return null; }
                j = GateBarJobs[0]; GateBarJobs.RemoveAt(0);
                return j;
            }
            if (tailsOut > 0) return null;
            // S-E: the feed up and quiet for BackfillStartMs (from the first live trade after market data started), and no page
            // loading; then in profileRoots order (MNQ, NQ, ES, MES), whatever order their first trades came in.
            long first = Interlocked.Read(ref firstTradeUtcTicks);
            if (first == 0 || (ChartBridgeTime.ToUtc(NowNt()).Ticks - first) / TimeSpan.TicksPerMillisecond < BackfillStartMs || Clients.Values.Any(c => !string.IsNullOrEmpty(c.Root) && !c.Ready)) { wait = true; return null; }
            int best = int.MaxValue;
            foreach (GateJob b in GateBackfills)
            {
                int i = Array.IndexOf(ChartBridgeConfig.ProfileRoots, b.Root);
                if (i < 0) i = int.MaxValue - 1;
                if (i < best) { best = i; j = b; }
            }
            GateBackfills.Remove(j);
            return j;
        }

        private static void GateWorker(CancellationToken stop)
        {
            try { GateLoop(stop); }
            catch (OperationCanceledException) { }   // stopped (StopGate): it has already reset the gate
        }
        private static void GateLoop(CancellationToken stop)
        {
            while (true)
            {
                GateJob j; bool wait;
                lock (GateLock)
                {
                    if (stop.IsCancellationRequested) return;   // stopped: StopGate reset the gate, a new worker may run
                    j = GateNext(out wait);
                    if (j == null && !wait) { gateRunning = false; return; }   // a kick starts it again
                    if (j != null) gateNow = j.Kind + " " + j.Root;
                }
                if (j == null) { stop.WaitHandle.WaitOne(200); continue; }
                ManualResetEventSlim done = new ManualResetEventSlim(false);
                j.Stop = stop;   // the stop of the worker that sent it: a backfill's retry is cancelled with it (N6)
                GateJob jj = j;
                // State 5: the worker gave up waiting on this answer's copy (below); the copy that ends after that frees the gate.
                try { j.Start(() => { done.Set(); if (Interlocked.CompareExchange(ref jj.State, 6, 5) == 5) GateUnstuck(jj, jj.Kind + " " + jj.Root); }); }
                catch (Exception ex) { Log(j.Kind + " request error (" + j.Root + "): " + ex.Message); done.Set(); }
                bool answered = done.Wait(j.TimeoutMs, stop);
                if (!answered && j.Kind == "bars")
                {
                    // 0.3.6 (Anthony): the chart never waits on bars. A bars request not answered in its time limit is given up
                    // and the gate goes on: it is NOT marked stuck, so windows and backfills go as usual (accepted: one may go
                    // while NinjaTrader still works on it). Claimed as timed out (3), so its late answer is dropped uncopied,
                    // and GateUnstuck leaves the gate alone (it is not gateStuckJob). The session is asked again later.
                    if (Interlocked.CompareExchange(ref j.State, 3, 0) == 0)
                    {
                        try { j.OnTimeout(); } catch (Exception ex) { Log("request timeout error: " + ex.Message); }
                        Log("bars " + j.Root + ": NinjaTrader did not answer in " + (j.TimeoutMs / 1000) + " s; given up, the gate goes on (a late answer is not used)");
                    }
                    else if (!done.Wait(AnswerCopyMs, stop)) Log("bars " + j.Root + ": NinjaTrader answered at the time limit, but the copy did not end within " + (AnswerCopyMs / 1000) + " s more; the gate goes on");
                }
                else if (!answered && Interlocked.CompareExchange(ref j.State, 2, 0) == 0)
                {
                    GateTimedOut(j);
                    if (Interlocked.CompareExchange(ref j.State, 3, 2) != 2) GateUnstuck(j, j.Kind + " " + j.Root);   // answered while it was being marked
                }
                else if (!answered && !done.Wait(AnswerCopyMs, stop))
                {
                    // The answer claimed it at the limit, but its copy has not ended (review 5 N2): shown as stuck, not hung silently.
                    Log(j.Kind + " " + j.Root + ": NinjaTrader answered at the time limit, but the answer was not copied within " + (AnswerCopyMs / 1000) + " s more; treated as unanswered");
                    GateTimedOut(j);
                    Interlocked.Exchange(ref j.State, 5);
                    if (done.IsSet && Interlocked.CompareExchange(ref j.State, 6, 5) == 5) GateUnstuck(j, j.Kind + " " + j.Root);   // it ended meanwhile
                }
                lock (GateLock) { if (stop.IsCancellationRequested) return; gateNow = null; }
                if (j.Kind == "backfill" && answered && BackfillGapMs > 0) stop.WaitHandle.WaitOne(BackfillGapMs);
            }
        }
        // A request not answered in time: still at NinjaTrader, so nothing else goes until it answers (X1). Windows queued behind
        // it are answered now (their loads go live with no trades and a note, review 4 B1); queued backfills say they wait (S2).
        private static void GateTimedOut(GateJob j)
        {
            string what = j.Kind + " " + j.Root;
            List<GateJob> windows, backfills, bars;
            lock (GateLock)
            {
                if (j.Stop.IsCancellationRequested) return;   // stopped meanwhile: the gate was reset, nothing to mark (review 6 N1)
                gateStuck = what; gateStuckJob = j; gateStuckSinceMs = ChartBridgeTime.NowUtcMs();
                windows = new List<GateJob>(GateWindows); GateWindows.Clear();
                backfills = new List<GateJob>(GateBackfills);
                bars = new List<GateJob>(GateBarJobs); GateBarJobs.Clear();   // 0.3.6: a queued bars request is dropped, and asked again later
            }
            try { j.OnTimeout(); } catch (Exception ex) { Log("request timeout error: " + ex.Message); }
            Log(StuckNote(what));
            foreach (GateJob w in windows.Concat(backfills).Concat(bars)) { try { if (w.OnStuck != null) w.OnStuck(what); } catch (Exception ex) { Log("request stuck error: " + ex.Message); } }
        }
        // A given-up request answered at last: its answer is dropped at once (not copied), and the gate goes on. Only the request
        // that made the gate stuck frees it (review 6 N1: not an answer from before a stop).
        private static void GateUnstuck(GateJob j, string what)
        {
            List<GateJob> backfills;
            lock (GateLock)
            {
                if (gateStuckJob != j) backfills = null;
                else { gateStuck = null; gateStuckJob = null; gateStuckSinceMs = -1; backfills = new List<GateJob>(GateBackfills); }
            }
            if (backfills == null) { Log(what + ": NinjaTrader answered after it was given up; not used"); return; }
            Log(what + ": NinjaTrader answered after it was given up; not used. Tick requests go out again");
            foreach (GateJob b in backfills) BackfillWaits(b.Book, null);   // back to the state they had; they run as usual
            GateKick();
        }
        // A queued backfill's label while the gate is stuck (review 4 S2; a queued retry too, review 5 S1): it waits, it is not
        // "building"; null: back to the state it had (queued, or failed once and asked again).
        private static void BackfillWaits(RootBook book, string what)
        {
            if (book == null) return;
            bool changed = false;
            lock (book.Sync)
            {
                bool waits = book.BackfillState == "queued" || book.BackfillState.StartsWith("failed once", StringComparison.Ordinal);   // review 5 S1: a retry too
                if (what != null && waits) { book.BackfillWaitWas = book.BackfillState; book.BackfillState = "waiting: NinjaTrader has not answered an earlier tick request (" + what + ")"; changed = true; }
                else if (what == null && book.BackfillState.StartsWith("waiting:", StringComparison.Ordinal)) { book.BackfillState = book.BackfillWaitWas ?? "queued"; book.BackfillWaitWas = null; changed = true; }
            }
            if (changed) Task.Run(() => PushProfile(book));
        }

        // A minute chart's last trades (20,000 by count): not while a backfill is out or a request is stuck; counted, so no
        // backfill starts meanwhile.
        private static bool BeginTail()
        {
            lock (GateLock)
            {
                if (gateStopped || gateStuck != null || (gateNow != null && gateNow.StartsWith("backfill", StringComparison.Ordinal))) return false;
                tailsOut++;
                return true;
            }
        }
        private static void EndTail() { lock (GateLock) if (tailsOut > 0) tailsOut--; GateKick(); }

        // ---------------------------------------------------------- 0.3.6: the daily bars' requests (ChartBridgeBars.cs)
        // A daily 1-minute bars request goes to NinjaTrader through this gate, last of all. It is queued only while the gate is
        // idle: not stopped or stuck, nothing out, nothing queued, no minute chart's last trades out, no page loading, and no
        // session backfill still to come (queued, waiting for its start, or failed once and due again). It is sent only while
        // that still holds (no backfill queued, no last trades out, no page loading). So it never starts beside a window or a
        // backfill: one that comes meanwhile waits behind it, about a second for one contract's minutes, at most its 60 s limit.
        // Unlike a window or a backfill, a bars request NinjaTrader does not answer in time does NOT leave the gate stuck: the
        // chart never waits on bars (Anthony, 0.3.6; GateLoop). When the gate is not idle nothing is queued: GateBars says why,
        // and ChartBridgeBars tries next minute.
        private static readonly List<GateJob> GateBarJobs = new List<GateJob>();
        private static bool PageLoading() { return Clients.Values.Any(c => !string.IsNullOrEmpty(c.Root) && !c.Ready); }
        // Under GateLock: why the gate is not idle for a bars request, or null.
        private static string BarsBusyLocked()
        {
            if (gateStopped) return "ChartBridge is stopping";
            if (gateStuck != null) return "NinjaTrader has not answered an earlier request (" + gateStuck + ") yet";
            if (gateNow != null) return gateNow + " is out";
            if (GateWindows.Count > 0) return GateWindows.Count + " window request(s) queued";
            if (GateBackfills.Count > 0) return GateBackfills.Count + " session backfill(s) queued";
            if (GateBarJobs.Count > 0) return "a bars request is queued";
            if (tailsOut > 0) return "a minute chart's last trades are out";
            if (PageLoading()) return "a chart is loading";
            return null;
        }
        private static string BackfillToCome()
        {
            List<RootBook> books;
            lock (Books) books = Books.Values.ToList();
            foreach (RootBook b in books) lock (b.Sync) if (b.BackfillLive != null) return b.Root + " session backfill not done (" + b.BackfillState + ")";
            return null;
        }
        // Why a bars request may not go now, or null (for /diag; GateBars decides again when it queues).
        public static string BarsGateBusy()
        {
            string why = BackfillToCome();
            if (why != null) return why;
            lock (GateLock) return BarsBusyLocked();
        }
        // Queues one daily bars request (1 minute, Last, the instrument's trading hours, this contract's own data) when the gate is
        // idle, and returns null; otherwise queues nothing and returns why. The answer, a failure, the time limit, a stuck gate
        // while it waits, or a stop end it through t.Done. dropped(): ChartBridgeBars has stopped since (nothing more is asked,
        // a late answer is not copied).
        public static string GateBars(string what, Instrument inst, DateTime fromNt, DateTime toNt, int timeoutMs, Func<bool> dropped, BarsTicket t)
        {
            string why = BackfillToCome();
            if (why != null) return why;
            GateJob j = new GateJob { Kind = "bars", Root = what, TimeoutMs = timeoutMs };
            j.Start = done => RunBars(j, inst, fromNt, toNt, dropped, t, done);
            j.OnTimeout = () => { t.Error = "NinjaTrader did not answer within " + (timeoutMs / 1000) + " s"; t.Done.Set(); };
            j.OnStuck = stuck => { t.Error = "the request waited while NinjaTrader had not answered " + stuck; t.GateStuck = true; t.Done.Set(); };
            lock (GateLock)
            {
                why = BarsBusyLocked();
                if (why != null) return why;
                t.Job = j;
                GateBarJobs.Add(j);
            }
            GateKick();
            return null;
        }
        // Takes a bars request back out of the queue if it has not gone to NinjaTrader yet (true), so it never waits there long.
        public static bool GateBarsWithdraw(BarsTicket t)
        {
            lock (GateLock) { GateJob j = t.Job as GateJob; return j != null && GateBarJobs.Remove(j); }
        }
        private static void RunBars(GateJob j, Instrument inst, DateTime fromNt, DateTime toNt, Func<bool> dropped, BarsTicket t, Action done)
        {
            if (dropped != null && dropped()) { t.Error = "stopped"; done(); t.Done.Set(); return; }   // stopped since it was queued: nothing goes out
            try
            {
                BarsRequest req0 = new BarsRequest(inst, fromNt, toNt);
                req0.BarsPeriod = new BarsPeriod { BarsPeriodType = BarsPeriodType.Minute, Value = 1, MarketDataType = MarketDataType.Last };
                req0.TradingHours = inst.MasterInstrument.TradingHours;   // the template the chart uses
                req0.MergePolicy = MergePolicy.DoNotMerge;                // this contract's own prices, never another contract's
                t.Started = true;
                req0.Request(new Action<BarsRequest, ErrorCode, string>((req, code, message) =>
                {
                    if (j.Stop.IsCancellationRequested) { try { req.Dispose(); } catch (Exception) { } t.Error = "stopped"; t.Done.Set(); return; }   // review 6 S1: dropped, not copied
                    if (!Claim(j)) { try { req.Dispose(); } catch (Exception) { } if (LateAnswer(j)) GateUnstuck(j, "bars " + j.Root); return; }   // timed out first: dropped, not copied
                    try
                    {
                        if (dropped != null && dropped()) t.Error = "stopped";
                        else if (code != ErrorCode.NoError) t.Error = "NinjaTrader refused the request: " + code + " " + message;
                        else if (req.Bars != null) t.Raw = RawBars.Copy(req.Bars, false);   // the one copy on NinjaTrader's thread (minutes of one session)
                    }
                    catch (Exception ex) { t.Error = "could not copy the bars: " + ex.Message; }
                    finally { try { req.Dispose(); } catch (Exception) { } done(); t.Done.Set(); }
                }));
            }
            catch (Exception ex) { t.Error = "the request failed: " + ex.Message; done(); t.Done.Set(); }
        }

        // The feed (review 3 S-A, S-B, S-E): up since listening began, or since the first trade or Connected after a drop.
        private static long feedUpSinceUtcTicks, firstTradeUtcTicks;
        private static int feedDown;
        private static void FeedUp()
        {
            long now = ChartBridgeTime.ToUtc(NowNt()).Ticks;
            if (Interlocked.CompareExchange(ref feedDown, 0, 1) == 1) Interlocked.Exchange(ref feedUpSinceUtcTicks, now);
            Interlocked.CompareExchange(ref firstTradeUtcTicks, now, 0);
        }

        // ---------------------------------------------------------- 0.3.5: the books, and the one backfill of a session
        private static readonly Dictionary<string, RootBook> Books = new Dictionary<string, RootBook>();
        private static long listeningSinceUtcTicks;
        public static RootBook BookOf(string root, Instrument inst)
        {
            RootBook b;
            lock (Books)
            {
                if (Books.TryGetValue(root, out b)) return b;
                double tick = 0.25;
                try { if (inst != null && inst.MasterInstrument != null && inst.MasterInstrument.TickSize > 0) tick = inst.MasterInstrument.TickSize; } catch (Exception) { }
                b = new RootBook(root, tick);
                Books[root] = b;
            }
            // The last session's table from its file, off the thread that asked (the market data handler, S4); at most a few
            // days old (a long weekend).
            RootBook nb = b;
            Task.Run(() =>
            {
                try
                {
                    if (!File.Exists(nb.LastFile)) return;
                    SessionTable t = RootBook.ParseLast(File.ReadAllText(nb.LastFile), ChartBridgeTime.EtSeconds(DateTime.UtcNow));
                    if (t != null) lock (nb.Sync) if (nb.Last == null) nb.Last = t;
                }
                catch (Exception ex) { Log("last session's profile not read: " + ex.Message); }
            });
            return b;
        }
        // For the harness: forget every book and queued request, and set when ChartBridge began listening to market data.
        public static void ResetBooks(DateTime listeningSinceUtc)
        {
            lock (Books) Books.Clear();
            lock (GateLock) { GateWindows.Clear(); GateBackfills.Clear(); GateBarJobs.Clear(); gateStuck = null; gateStuckJob = null; tailsOut = 0; gateStopped = false; }   // the harness: as after a start
            Interlocked.Exchange(ref listeningSinceUtcTicks, listeningSinceUtc.Ticks);
            Interlocked.Exchange(ref feedUpSinceUtcTicks, listeningSinceUtc.Ticks); Interlocked.Exchange(ref feedDown, 0);
            Interlocked.Exchange(ref firstTradeUtcTicks, 0);
        }

        private static void SaveLast(RootBook book)
        {
            SessionTable last; string file = book.LastFile;
            lock (book.Sync) { last = book.Last; book.LastChanged = false; }
            if (last == null) return;
            Task.Run(() =>   // S4: formatted and written off the market data thread (a finished table is never changed)
            {
                try
                {
                    string text = RootBook.LastText(last);
                    Directory.CreateDirectory(Path.GetDirectoryName(file)); File.WriteAllText(file + ".tmp", text); if (File.Exists(file)) File.Delete(file); File.Move(file + ".tmp", file);
                }
                catch (Exception ex) { Log("last session's profile not saved: " + ex.Message); }
            });
        }

        // Every 10 s: the served window of a session that has ended (the weekend, or before the next session's first trade)
        // is dropped (nit N6), so a Friday window does not sit in memory until Sunday.
        private static void SweepBooks()
        {
            List<RootBook> list; lock (Books) list = Books.Values.ToList();
            DateTime now = NowNt();
            foreach (RootBook b in list) lock (b.Sync) { if (b.Table != null && now >= b.Table.End) b.Cache = null; }
        }

        // The market is closed now (New York time: Friday 17:00 to Sunday 18:00, and the daily 17:00 to 18:00 break).
        private static bool MarketClosedNow()
        {
            DateTime et = TimeZoneInfo.ConvertTimeFromUtc(ChartBridgeTime.ToUtc(NowNt()), ChartBridgeTime.Eastern);
            double h = et.TimeOfDay.TotalHours;
            if (et.DayOfWeek == DayOfWeek.Saturday) return true;
            if (et.DayOfWeek == DayOfWeek.Sunday) return h < 18;
            if (et.DayOfWeek == DayOfWeek.Friday) return h >= 17;
            return h >= 17 && h < 18;
        }

        // The one backfill of a session, for an instrument in profileRoots whose table is not whole (ChartBridge started after
        // 18:00 ET, and only then): queued at its first live trade, sent through the gate once the feed has been up for
        // BackfillStartMs and no page is loading (nothing else outstanding), MNQ, NQ, ES, MES in profileRoots order whatever
        // order the first trades came in, once per session, never for a page load. NinjaTrader is asked for the session so
        // far BY DATE: its help says a by-date request covers whole trading days from 12:00 AM, so the answer also holds the
        // hours before 18:00 (the previous day's session back to midnight); those are copied and then left out. On
        // NinjaTrader's thread only the copy; the rest on a worker. On an error or an empty answer it is asked once more after
        // BackfillRetryMs, then given up with a note. The live trades since the table began are joined to its answer by the
        // 0.3.3 seam.
        private class BackfillAsk { public bool Retry; public CancellationToken Stop; }
        private static void QueueBackfill(RootBook book, Instrument inst, bool retry)
        {
            if (!BackfillOn) return;
            BackfillAsk ask = new BackfillAsk { Retry = retry };
            GateJob j = new GateJob { Kind = "backfill", Root = book.Root, Book = book, TimeoutMs = BackfillTimeoutMs };
            j.Start = done => RunBackfill(book, inst, ask, j, done);
            j.OnStuck = what => BackfillWaits(book, what);
            j.OnTimeout = () =>
            {
                lock (book.Sync) { book.BackfillLive = null; book.BackfillState = "timed out: no answer in " + (BackfillTimeoutMs / 1000) + " s"; }
                Log(book.Root + " session backfill: no answer from NinjaTrader in " + (BackfillTimeoutMs / 1000) + " s; given up (the volume profile stays from the first live trade)");
            };
            GateEnqueue(j);
        }

        private static void RunBackfill(RootBook book, Instrument inst, BackfillAsk ask, GateJob j, Action done)
        {
            ask.Stop = j.Stop;
            SessionTable table;
            lock (book.Sync)
            {
                table = book.Table;
                if (table == null || table.Whole || book.BackfillLive == null) { done(); return; }
                if (MarketClosedNow()) { book.BackfillLive = null; book.BackfillState = "skipped: the market is closed"; done(); return; }   // S7
                book.BackfillState = ask.Retry ? "asked again" : "asked"; book.BackfillAsks++; book.BackfillAskedMs = ChartBridgeTime.NowUtcMs();
            }
            double asked = ChartBridgeTime.NowUtcMs();
            BarsRequest req0 = new BarsRequest(inst, table.Start, ask.Retry ? NowNt() : NowNt().AddMinutes(TickToMarginMinutes));
            req0.BarsPeriod = new BarsPeriod { BarsPeriodType = BarsPeriodType.Tick, Value = 1 };
            req0.TradingHours = inst.MasterInstrument.TradingHours;
            req0.Request(new Action<BarsRequest, ErrorCode, string>((req, code, message) =>
            {
                if (j.Stop.IsCancellationRequested) { try { req.Dispose(); } catch (Exception) { } return; }   // review 6 S1: ChartBridge stopped since: dropped, not copied
                if (!Claim(j)) { try { req.Dispose(); } catch (Exception) { } if (LateAnswer(j)) GateUnstuck(j, book.Root + " session backfill"); return; }   // timed out first: dropped at once, not copied
                Stopwatch sw = Stopwatch.StartNew();
                RawBars raw = null; int held = 0; string error = null;
                try
                {
                    if (code != ErrorCode.NoError) error = code + " " + message;
                    else { raw = RawBars.Copy(req.Bars, true); lock (book.Sync) held = book.BackfillLive != null ? book.BackfillLive.Count : 0; }   // the one copy on NinjaTrader's thread
                }
                catch (Exception ex) { error = ex.Message; }
                finally { try { req.Dispose(); } catch (Exception) { } }
                double cbMs = sw.Elapsed.TotalMilliseconds;
                done();
                RawBars copy = raw; int h = held; string err = error;
                Task.Run(() => FinishBackfill(book, inst, table, copy, h, err, asked, cbMs, ask));
            }));
        }

        private static void FinishBackfill(RootBook book, Instrument inst, SessionTable table, RawBars raw, int heldAtAnswer, string error, double asked, double cbMs, BackfillAsk ask)
        {
            try
            {
                lock (book.Sync) { if (book.Table == table) book.BackfillCallbackMs = Math.Max(book.BackfillCallbackMs, cbMs); }
                // Off every lock: the session's trades in the answer, per half hour and price (the day before 18:00 left out).
                Dictionary<long, long> d = new Dictionary<long, long>();
                ChartBridgeTime.EtCache et = new ChartBridgeTime.EtCache();
                long trades = 0, volume = 0; DateTime lastIn = DateTime.MinValue;
                if (raw != null)
                    for (int i = 0; i < raw.Count; i++)
                    {
                        if (raw.Time[i] < table.Start || raw.Time[i] >= table.End) continue;
                        SessionTable.Add(d, et.Seconds(raw.Time[i]), SessionTable.PriceTicks(raw.Close[i], book.Tick), raw.Volume[i]);
                        trades++; volume += raw.Volume[i]; lastIn = raw.Time[i];
                    }
                string why = error ?? (raw == null || raw.Count == 0 ? "no trades came back" : trades == 0 ? "no trade of this session came back" : null);
                if (why == null)
                {
                    DateTime firstLive = DateTime.MaxValue;
                    lock (book.Sync) { if (book.BackfillLive != null && book.BackfillLive.Count > 0) firstLive = book.BackfillLive[0].Time; }
                    if (firstLive != DateTime.MaxValue && lastIn < firstLive.AddSeconds(-1)) why = "the answer ends at " + EtText(lastIn) + ", before the live trades began";
                }
                if (why != null)
                {
                    bool retry;
                    lock (book.Sync)
                    {
                        if (book.Table != table || book.BackfillLive == null) return;
                        retry = !ask.Retry;
                        if (retry) book.BackfillState = "failed once (" + why + "), asked again in " + (BackfillRetryMs / 1000) + " s";
                        else { book.BackfillState = "failed: " + why; book.BackfillLive = null; }   // S1: nothing more is kept for it
                    }
                    Log(book.Root + " session backfill failed (" + why + ")" + (retry ? "; asked once more in " + (BackfillRetryMs / 1000) + " s" : "; given up: the volume profile counts from the first live trade"));
                    if (retry)
                    {
                        // The token of the worker that sent the ask, not the current one: a failure handled after a stop schedules
                        // nothing (StopGate cancels it, and the retry's timer with it; review 5 N6).
                        Task.Delay(BackfillRetryMs, ask.Stop).ContinueWith(delegate { QueueBackfill(book, inst, true); }, CancellationToken.None, TaskContinuationOptions.OnlyOnRanToCompletion, TaskScheduler.Default);
                    }
                    return;
                }
                lock (book.Sync)
                {
                    if (book.Table != table || book.BackfillLive == null) return;   // the session changed, or it was given up
                    SeamResult r = ChartBridgeSeam.Dedupe(raw.Time, raw.Close, raw.Volume, raw.Count, book.BackfillLive, heldAtAnswer);
                    foreach (SeamTick h in r.Release)
                        if (book.InTable(h.Time)) { SessionTable.Add(d, ChartBridgeTime.EtSeconds(ChartBridgeTime.ToUtc(h.Time)), SessionTable.PriceTicks(h.Price, book.Tick), h.Volume); trades++; volume += h.Volume; }
                    table.Vol.Clear();
                    foreach (KeyValuePair<long, long> kv in d) table.Vol[kv.Key] = kv.Value;
                    table.Trades = trades; table.Volume = volume;
                    if (!table.Dropped) { table.Whole = true; table.CoveredFromEt = table.StartEt; }   // a feed drop this session: never whole
                    book.BackfillLive = null;
                    book.BackfillState = "done"; book.BackfillMs = ChartBridgeTime.NowUtcMs() - asked; book.BackfillTrades = raw.Count; book.BackfillReleased = r.Release.Count;
                    book.BackfillFirst = EtText(raw.Time[0]); book.BackfillLast = EtText(raw.Time[raw.Count - 1]);
                }
                PushProfile(book);
                Log(book.Root + " session backfill: " + raw.Count + " trades (" + book.BackfillFirst + " to " + book.BackfillLast + ", " + trades + " of this session), " +
                    Math.Round(book.BackfillMs) + " ms from the ask, " + Math.Round(cbMs, 1) + " ms on NinjaTrader's thread; the volume profile is " + (table.Whole ? "whole" : "still missing the feed drop"));
            }
            catch (Exception ex) { Log(book.Root + " session backfill error: " + ex.Message); lock (book.Sync) { if (book.Table == table) { book.BackfillLive = null; book.BackfillState = "failed: " + ex.Message; } } }
        }

        // A new "profile" to every live page of this instrument that asked for it, in order with its live trades: its trades are
        // held (as during a load) while the message is made from a snapshot with no lock held, then released after it (S4).
        private static void PushProfile(RootBook book)
        {
            foreach (ChartBridgeClient c in Clients.Values)
            {
                if (c.Root != book.Root || !c.WantsProfile) continue;
                int seq; ProfileSnap snap;
                lock (book.Sync)
                lock (c.Pending)
                {
                    if (!c.Ready || c.Root != book.Root || !c.WantsProfile) continue;   // still loading: its "ready" brings a fresh one
                    c.Ready = false; c.Pending.Clear(); seq = Volatile.Read(ref c.SubscribeSeq);
                    snap = book.Snap();
                }
                string json = snap.Json(null, null);
                lock (c.Pending)
                {
                    if (Volatile.Read(ref c.SubscribeSeq) != seq) continue;   // it subscribed again: that load owns it now
                    List<string> burst = new List<string>(c.Pending.Count + 1) { json };
                    foreach (SeamTick h in c.Pending) burst.Add(h.Json);
                    c.SendAll(burst);
                    c.Pending.Clear();
                    c.Ready = true;
                }
            }
        }

        // S2: a data connection lost (or a market data reset) while the market is open: each table named is not every trade of
        // its session any more, its served window keeps the gap (asked again at a load at most once in 10 minutes, when the ask
        // can go out), a window being asked is not used, and the live pages get the profile again with the drop in it. While
        // the market is closed nothing was missed: only the feed is noted down (a session starting before it is back is not whole).
        private static void FeedDropped(string root, string why)
        {
            Interlocked.Exchange(ref feedDown, 1);   // a session that starts before the feed is back is not whole
            if (MarketClosedNow()) { Log("data feed: " + why + " while the market is closed; no trade was missed"); return; }   // S-B
            List<RootBook> list; lock (Books) list = Books.Values.Where(b => root == null || b.Root == root).ToList();
            double et = ChartBridgeTime.EtSeconds(DateTime.UtcNow);
            if (ClockForHarness != null) et = ChartBridgeTime.EtSeconds(ChartBridgeTime.ToUtc(NowNt()));
            foreach (RootBook b in list)
            {
                bool changed;
                lock (b.Sync) { changed = b.FeedDropped(et, why); if (b.WindowAsking) b.WindowLive = null; }
                if (changed) { Log(b.Root + ": " + why + "; the volume profile of this session is missing trades from here; the served window keeps the gap (asked again at a load at most once in 10 minutes)"); PushProfile(b); }
            }
        }

        // NinjaTrader's static Connection.ConnectionStatusUpdate, attached by reflection (as ChartBridgeOrders does): a price
        // feed that goes from Connected to anything else is a drop.
        private static EventInfo feedEvent; private static Delegate feedHandler;
        private static void WatchFeed()
        {
            try
            {
                EventInfo ev = typeof(Connection).GetEvent("ConnectionStatusUpdate", BindingFlags.Public | BindingFlags.Static);
                if (ev == null) { Log("connection status events not found; a feed drop is not seen by the volume profile"); return; }
                MethodInfo mi = typeof(ChartBridgeServer).GetMethod("OnFeedStatus", BindingFlags.NonPublic | BindingFlags.Static);
                Delegate d = Delegate.CreateDelegate(ev.EventHandlerType, mi);
                ev.AddEventHandler(null, d);
                feedEvent = ev; feedHandler = d;
            }
            catch (Exception ex) { Log("could not watch connection status (" + ex.Message + "); a feed drop is not seen by the volume profile"); }
        }
        private static void UnwatchFeed()
        {
            try { if (feedEvent != null && feedHandler != null) feedEvent.RemoveEventHandler(null, feedHandler); } catch (Exception) { }
            feedEvent = null; feedHandler = null;
        }
        private static void OnFeedStatus(object sender, EventArgs e)
        {
            try
            {
                PropertyInfo ps = e.GetType().GetProperty("PriceStatus") ?? e.GetType().GetProperty("Status");
                PropertyInfo pp = e.GetType().GetProperty("PreviousPriceStatus") ?? e.GetType().GetProperty("PreviousStatus");
                if (ps == null || pp == null) return;
                string now = Convert.ToString(ps.GetValue(e, null)), was = Convert.ToString(pp.GetValue(e, null));
                if (was == "Connected" && now != "Connected") { string why = "the data connection went " + now + " at " + EtText(NowNt()); Task.Run(() => FeedDropped(null, why)); }   // off NinjaTrader's thread
                else if (now == "Connected" && was != "Connected") { Interlocked.Exchange(ref feedDown, 0); Interlocked.Exchange(ref feedUpSinceUtcTicks, ChartBridgeTime.ToUtc(NowNt()).Ticks); }   // up from now
            }
            catch (Exception ex) { Log("feed status error: " + ex.Message); }
        }

        private static string BooksJson()
        {
            List<RootBook> list; lock (Books) list = Books.Values.ToList();
            StringBuilder b = new StringBuilder("{");
            double now = ChartBridgeTime.NowUtcMs(), total = 0;
            foreach (RootBook k in list)
            {
                lock (k.Sync)
                {
                    SessionTable t = k.Table;
                    b.Append(CbJson.Str(k.Root)).Append(":{\"table\":");
                    if (t == null) b.Append("null");
                    else b.Append("{\"session\":").Append(CbJson.Str(EtText(t.Start))).Append(",\"whole\":").Append(t.Whole ? "true" : "false")
                          .Append(",\"trades\":").Append(t.Trades).Append(",\"volume\":").Append(t.Volume).Append(",\"rows\":").Append(t.Vol.Count)
                          .Append(",\"drop\":").Append(t.Dropped ? CbJson.Str(t.DropWhy ?? "") : "null")
                          .Append(",\"lateTrades\":").Append(k.LateTrades).Append(",\"staleTrades\":").Append(k.StaleTrades).Append(",\"maxGapSec\":").Append(CbJson.Num3(k.MaxGapSec)).Append('}');
                    b.Append(",\"last\":").Append(k.Last == null ? "null" : "{\"whole\":" + (k.Last.Whole ? "true" : "false") + ",\"volume\":" + k.Last.Volume + ",\"rows\":" + k.Last.Vol.Count + "}");
                    b.Append(",\"backfill\":{\"state\":").Append(CbJson.Str(k.BackfillState)).Append(",\"asks\":").Append(k.BackfillAsks)
                     .Append(",\"askedAtUtcMs\":").Append(k.BackfillAskedMs >= 0 ? CbJson.Num3(k.BackfillAskedMs) : "null")
                     .Append(",\"ms\":").Append(k.BackfillMs >= 0 ? CbJson.Num3(k.BackfillMs) : "null")
                     .Append(",\"callbackMs\":").Append(k.BackfillCallbackMs >= 0 ? CbJson.Num3(k.BackfillCallbackMs) : "null")
                     .Append(",\"trades\":").Append(k.BackfillTrades).Append(",\"releasedLive\":").Append(k.BackfillReleased)
                     .Append(",\"liveHeld\":").Append(k.BackfillLive != null ? k.BackfillLive.Count : 0)
                     .Append(",\"first\":").Append(k.BackfillFirst != null ? CbJson.Str(k.BackfillFirst) : "null").Append(",\"last\":").Append(k.BackfillLast != null ? CbJson.Str(k.BackfillLast) : "null").Append('}');
                    if (k.BackfillMs >= 0) total += k.BackfillMs;
                    b.Append(",\"window\":").Append(k.Cache == null ? "null" : "{\"from\":" + CbJson.Str(EtText(k.Cache.First)) + ",\"trades\":" + k.Cache.Count + ",\"served\":" + k.Cache.Served + "}");
                    b.Append(",\"windowAsk\":{\"asking\":").Append(k.WindowAsking ? "true" : "false").Append(",\"waiting\":").Append(k.WindowWaiters.Count)
                     .Append(",\"asks\":").Append(k.WindowAsks).Append(",\"failures\":").Append(k.WindowFailures)
                     .Append(",\"lastError\":").Append(k.WindowError != null ? CbJson.Str(k.WindowError) : "null")
                     .Append(",\"callbackMs\":").Append(k.WindowCallbackMs >= 0 ? CbJson.Num3(k.WindowCallbackMs) : "null").Append('}');
                    double rate = k.RatePerHour(now);
                    b.Append(",\"tradesPerHour\":").Append(rate >= 0 ? CbJson.Num3(rate) : "null").Append("},");
                }
            }
            string gate;
            lock (GateLock) gate = "{\"now\":" + (gateNow != null ? CbJson.Str(gateNow) : "null") + ",\"windowsQueued\":" + GateWindows.Count + ",\"backfillsQueued\":" + GateBackfills.Count +
                ",\"barsQueued\":" + GateBarJobs.Count + ",\"minuteTailsOut\":" + tailsOut + ",\"stuck\":" + (gateStuck != null ? CbJson.Str(gateStuck) : "null") + ",\"stuckSinceUtcMs\":" + (gateStuckSinceMs >= 0 ? CbJson.Num3(gateStuckSinceMs) : "null") +
                ",\"feedDown\":" + (Volatile.Read(ref feedDown) != 0 ? "true" : "false") + ",\"firstTradeUtcMs\":" + (Interlocked.Read(ref firstTradeUtcTicks) > 0 ? CbJson.Num3((Interlocked.Read(ref firstTradeUtcTicks) - 621355968000000000L) / 10000.0) : "null") + "}";
            b.Append("\"gate\":").Append(gate).Append(",\"profileRoots\":[").Append(string.Join(",", ChartBridgeConfig.ProfileRoots.Select(x => CbJson.Str(x)).ToArray())).Append(']');
            b.Append(",\"backfillTotalMs\":").Append(CbJson.Num3(total));
            return b.Append('}').ToString();
        }
        private static string WindowsJson() { lock (Windows) return "[" + string.Join(",", Windows.Select(x => x.Json()).ToArray()) + "]"; }

        // ---------------------------------------------------------- the seam in /diag (last 20 subscribes)
        private const int SeamsKept = 20;
        private static readonly List<string> Seams = new List<string>();

        private static string EtText(DateTime nt)
        {
            try { return TimeZoneInfo.ConvertTimeFromUtc(ChartBridgeTime.ToUtc(nt), ChartBridgeTime.Eastern).ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture); }
            catch (Exception) { return nt.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + " (NT)"; }
        }

        private static string EtOrNull(DateTime? nt) { return nt.HasValue ? CbJson.Str(EtText(nt.Value)) : "null"; }

        private static void NoteSeam(Load L, SeamResult r, bool matched, DateTime? firstHeld)
        {
            DateTime? end = r.HasBackfillEnd ? r.BackfillEnd : (DateTime?)null;
            DateTime? firstOut = r.Release.Count > 0 ? r.Release[0].Time : (DateTime?)null;
            StringBuilder b = new StringBuilder("{");
            b.Append("\"client\":").Append(L.Client.Id);
            b.Append(",\"root\":").Append(CbJson.Str(L.Root));
            b.Append(",\"sub\":").Append(L.Sub);
            b.Append(",\"tickHours\":").Append(L.TickHours);
            b.Append(",\"atUtcMs\":").Append(CbJson.Num3(ChartBridgeTime.NowUtcMs()));
            b.Append(",\"loadMs\":").Append(CbJson.Num3(ChartBridgeTime.NowUtcMs() - L.StartedMs));
            b.Append(",\"matched\":").Append(matched ? "true" : "false");   // false: nothing to match against, every held trade released
            b.Append(",\"backfillTicks\":").Append(r.BackfillTicks);
            b.Append(",\"lastBackfillTick\":").Append(EtOrNull(end));
            b.Append(",\"firstHeldTick\":").Append(EtOrNull(firstHeld));
            b.Append(",\"firstReleasedTick\":").Append(EtOrNull(firstOut));
            // lastBackfillTick minus firstHeldTick: 0 or more means the two streams overlapped (no gap possible);
            // below 0, no held trade was at or before the backfill's end: a quiet moment, or a gap of up to that long.
            b.Append(",\"overlapMs\":").Append(end.HasValue && firstHeld.HasValue ? CbJson.Num3((end.Value - firstHeld.Value).TotalMilliseconds) : "null");
            b.Append(",\"held\":").Append(r.Held);
            b.Append(",\"heldAtAnswer\":").Append(matched ? r.HeldAtAnswer.ToString(CultureInfo.InvariantCulture) : "null");
            b.Append(",\"droppedAsDuplicate\":").Append(r.Dropped);
            b.Append(",\"droppedOlder\":").Append(r.DroppedOlder);
            b.Append(",\"droppedSameTime\":").Append(r.DroppedSameTime);
            b.Append(",\"droppedAfterAnswer\":").Append(r.DroppedAfterAnswer);   // held after the answer, matched at T
            b.Append(",\"olderAfterAnswer\":").Append(r.OlderAfterAnswer);       // held after the answer, older than T
            b.Append(",\"released\":").Append(r.Release.Count);
            b.Append(",\"resolutionMs\":").Append(CbJson.Num((double)r.ResolutionTicks / ChartBridgeSeam.Ms));
            b.Append(",\"tickToAheadMin\":").Append(L.TickHours > 0 ? (L.TickToMargin ? TickToMarginMinutes : 0).ToString(CultureInfo.InvariantCulture) : "null");
            b.Append(",\"tickRetriedEndingNow\":").Append(L.Retried ? "true" : "false");
            b.Append(",\"minuteTailRebuilt\":").Append(L.TailRebuilt);
            b.Append(",\"ntTailVolume\":").Append(L.NtTailVolume >= 0 ? L.NtTailVolume.ToString(CultureInfo.InvariantCulture) : "null");
            b.Append(",\"rebuiltTailVolume\":").Append(L.RebuiltTailVolume >= 0 ? L.RebuiltTailVolume.ToString(CultureInfo.InvariantCulture) : "null");
            b.Append('}');
            lock (Seams)
            {
                Seams.Add(b.ToString());
                if (Seams.Count > SeamsKept) Seams.RemoveAt(0);
            }
        }

        private static string SeamsJson()
        {
            lock (Seams) return "[" + string.Join(",", Seams) + "]";
        }

        // ---------------------------------------------------------- trade sides in /diag (0.3.4)
        private static readonly Dictionary<string, string> LastLoadSides = new Dictionary<string, string>();

        private static string MsOrNull(long ticks) { return ticks > 0 ? CbJson.Num((double)ticks / ChartBridgeSeam.Ms) : "null"; }

        private static void NoteSides(Load L, BackfillSides r, QuoteSeries bq, QuoteSeries aq)
        {
            string bidNote, askNote; bool bidRetried, askRetried, timedOut; double quotesMs, copyMs;
            lock (L) { bidNote = L.BidNote; askNote = L.AskNote; bidRetried = L.BidRetried; askRetried = L.AskRetried; quotesMs = L.QuotesAnsweredMs; timedOut = L.QuotesTimedOut; copyMs = L.QuoteCopyMs; }
            int bidRows = bq != null ? bq.Count : 0, askRows = aq != null ? aq.Count : 0;
            int quoteHours; string skipped;
            lock (L) { quoteHours = L.QuoteHours; skipped = L.QuotesSkipped; }
            bool capped = quoteHours > 0 && L.TickHours > quoteHours;
            // In words, when some trades could not use the quote history (also in the Output window, except when no quotes
            // were asked: that is the setting, said in /diag only, not a line on every load).
            string note = null;
            if (skipped != null) note = skipped == "not requested (quoteHours 0)" ? "quotes not requested (quoteHours 0)" : "quotes " + skipped + " (every backfill trade went by the tick rule)";
            else if (r.Trades > 0 && (bidRows == 0 || askRows == 0))
                note = "no " + (bidRows == 0 && askRows == 0 ? "bid or ask" : bidRows == 0 ? "bid" : "ask") + " history came back (bid: " + bidNote + ", ask: " + askNote + "): every backfill trade went by the tick rule";
            else if (r.BeforeQuotes > 0 || r.AfterQuotes > 0 || r.StaleQuotes > 0)
                note = "the bid/ask history does not cover every trade: " + r.BeforeQuotes + " trade(s) before it" + (capped ? " (quotes are asked for the last " + quoteHours + " hour" + (quoteHours == 1 ? "" : "s") + ", quoteHours in config.txt)" : "") +
                    ", " + r.AfterQuotes + " after it and " + r.StaleQuotes + " with a quote over " + (ChartBridgeSides.QuoteMaxAge / TimeSpan.TicksPerSecond) + " s old went by the tick rule";
            StringBuilder b = new StringBuilder("{");
            b.Append("\"sub\":").Append(L.Sub);
            b.Append(",\"atUtcMs\":").Append(CbJson.Num3(ChartBridgeTime.NowUtcMs()));
            b.Append(",\"trades\":").Append(r.Trades);
            b.Append(",\"aggressor\":").Append(r.Counts[ChartBridgeSides.Aggressor]);
            b.Append(",\"bidAsk\":").Append(r.Counts[ChartBridgeSides.BidAsk]);
            b.Append(",\"tickRule\":").Append(r.Counts[ChartBridgeSides.TickRule]);
            b.Append(",\"none\":").Append(r.Counts[ChartBridgeSides.None]);
            b.Append(",\"note\":").Append(note != null ? CbJson.Str(note) : "null");
            b.Append(",\"bidTicks\":").Append(bq != null ? bq.RawRows : 0).Append(",\"askTicks\":").Append(aq != null ? aq.RawRows : 0);
            b.Append(",\"bidRowsKept\":").Append(bidRows).Append(",\"askRowsKept\":").Append(askRows);   // after dropping size-only updates
            b.Append(",\"quoteHours\":").Append(ChartBridgeConfig.QuoteHours);   // 0.3.4.1: the setting
            b.Append(",\"quoteWindowHours\":").Append(quoteHours);                // the hours this load asked for (0: none)
            b.Append(",\"quoteCopyMs\":").Append(CbJson.Num3(copyMs));
            b.Append(",\"bidRequest\":").Append(CbJson.Str(bidNote)).Append(",\"askRequest\":").Append(CbJson.Str(askNote));
            b.Append(",\"quotesRetriedEndingNow\":").Append(bidRetried || askRetried ? "true" : "false");
            b.Append(",\"quotesTimedOut\":").Append(timedOut ? "true" : "false");
            b.Append(",\"quotesLoadMs\":").Append(quotesMs >= 0 ? CbJson.Num3(quotesMs) : "null");
            b.Append(",\"firstTrade\":").Append(EtOrNull(r.HasTrades ? r.FirstTrade : (DateTime?)null));
            b.Append(",\"lastTrade\":").Append(EtOrNull(r.HasTrades ? r.LastTrade : (DateTime?)null));
            b.Append(",\"firstBid\":").Append(EtOrNull(r.HasBid ? r.FirstBid : (DateTime?)null));
            b.Append(",\"lastBid\":").Append(EtOrNull(r.HasBid ? r.LastBid : (DateTime?)null));
            b.Append(",\"firstAsk\":").Append(EtOrNull(r.HasAsk ? r.FirstAsk : (DateTime?)null));
            b.Append(",\"lastAsk\":").Append(EtOrNull(r.HasAsk ? r.LastAsk : (DateTime?)null));
            b.Append(",\"quotedTrades\":").Append(r.Quoted);
            b.Append(",\"beforeQuotes\":").Append(r.BeforeQuotes).Append(",\"afterQuotes\":").Append(r.AfterQuotes).Append(",\"staleQuotes\":").Append(r.StaleQuotes);
            b.Append(",\"betweenQuotes\":").Append(r.BetweenQuotes).Append(",\"crossedQuotes\":").Append(r.CrossedQuotes);
            b.Append(",\"tieChanged\":").Append(r.TieChanged);
            b.Append(",\"sessionStarts\":").Append(r.SessionStarts);
            b.Append(",\"tradeResolutionMs\":").Append(MsOrNull(r.TradeResolution));
            b.Append(",\"quoteResolutionMs\":").Append(MsOrNull(r.QuoteResolution));
            b.Append(",\"comparedAtMs\":").Append(MsOrNull(r.UnitTicks));
            b.Append(",\"stamps\":{\"usable\":").Append(r.StampUsable).Append(",\"likeFillIn\":").Append(r.StampLikeFillIn).Append(",\"missing\":").Append(r.StampMissing)
             .Append(",\"agree\":").Append(r.StampAgree).Append(",\"disagree\":").Append(r.StampDisagree).Append('}');
            b.Append('}');
            lock (LastLoadSides) LastLoadSides[L.Root] = b.ToString();
            if (note != null && skipped == null) Log(L.Root + " trade sides: " + note + " (see /diag sides)");
        }

        // Per instrument: the live counts and quote, and the last backfill's (null before the first tick chart load).
        private static string SidesJson()
        {
            StringBuilder b = new StringBuilder("{");
            List<string> roots = Instruments.Keys.ToList();
            lock (LiveSides) foreach (string r in LiveSides.Keys) if (!roots.Contains(r)) roots.Add(r);
            lock (LastLoadSides) foreach (string r in LastLoadSides.Keys) if (!roots.Contains(r)) roots.Add(r);
            bool first = true;
            foreach (string root in roots)
            {
                LiveSideTagger t;
                lock (LiveSides) LiveSides.TryGetValue(root, out t);
                string last;
                lock (LastLoadSides) LastLoadSides.TryGetValue(root, out last);
                if (!first) b.Append(','); first = false;
                b.Append(CbJson.Str(root)).Append(":{\"live\":").Append(t != null ? t.DiagJson() : "null").Append(",\"lastLoad\":").Append(last ?? "null")
                 .Append(",\"quotesOutstanding\":").Append(QuotesOutstandingFor(root)).Append('}');   // 0.3.4.1: bid/ask requests not yet answered
            }
            return b.Append('}').ToString();
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
            b.Append(",\"pages\":[").Append(string.Join(",", Clients.Values.Select(c => c.DiagJson()).ToArray())).Append(']');   // 0.3.4: each page's queue and lag
            b.Append(",\"network\":").Append(ChartBridgeAccess.DiagJson());
            b.Append(",\"pin\":").Append(ChartBridgePin.DiagJson());   // whether a PIN is set, nothing else
            b.Append(",\"desk\":").Append(ChartBridgeDesk.DiagJson());
            b.Append(",\"bars\":").Append(ChartBridgeBars.DiagJson());   // 0.3.6: daily 1-minute bars to The Desk
            b.Append(",\"seams\":").Append(SeamsJson());   // 0.3.3: where each load's backfill met the live trades
            b.Append(",\"sides\":").Append(SidesJson());
            b.Append(",\"books\":").Append(BooksJson());       // 0.3.5: per instrument, the session table, its backfill and the served window
            b.Append(",\"windows\":").Append(WindowsJson());   // 0.3.5: the last 20 served windows   // 0.3.4: how each trade's side was found, live and in the last backfill
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
