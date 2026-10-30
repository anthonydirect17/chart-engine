// ChartBridge for NinjaTrader 8 (its version is ChartBridgeServer.Version, below)
// Streams live market data and your fills from NinjaTrader to the chart-engine live page.
// Serves the page at http://localhost:8765/ and a WebSocket at ws://localhost:8765/ws (this PC only:
// every request must come from a loopback address, and a browser WebSocket from an allowed origin).
// ChartBridge's own page is locked with a 4-digit PIN (ChartBridgePin.cs): nothing streams to it and it cannot
// sign in for orders until it is unlocked.
// READ ONLY by default. Order entry from the chart (Step 2) lives only in ChartBridgeOrders.cs and stays
// off unless config.txt has "trading = true"; which accounts may trade is the Account page's checkmark (gate 2,
// ChartBridgeAccounts.cs). This file never places, changes or cancels an order itself.
// Protocol: nt8/PROTOCOL.md in https://github.com/anthonydirect17/chart-engine (MIT).
//
// Install: copy the add-on files listed in nt8\install-files.json to Documents\NinjaTrader 8\bin\Custom\AddOns\ and its page files to
// Documents\NinjaTrader 8\ChartBridge\www\ (nt8\install.ps1 does both; nt8\update-pc.ps1 updates them), then compile in the
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
        public static List<string> AllowOrigins = new List<string>();   // web pages besides ChartBridge's own that may open the read-only WebSocket
        // 0.4.0: markets served for the Quote board only (ChartBridgeTape.cs, ChartBridgeMarkets): every order for them is refused.
        // A root in both roots and quoteRoots is quote only.
        public static string[] QuoteRoots = ChartBridgeMarkets.DefaultQuoteRoots();
        public static bool QuoteOnly(string root) { return root != null && Array.IndexOf(QuoteRoots, root.ToUpperInvariant()) >= 0; }

        // 0.5.1: no Backtest or Playback account. Which accounts are watched (their fills go to The Desk) and listed is
        // ChartBridgeAccounts.SeenConnected: connected in this NinjaTrader session. The "accounts =" watch list is retired.
        public static bool AccountAllowed(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            return !name.StartsWith("Backtest", StringComparison.OrdinalIgnoreCase) && !name.StartsWith("Playback", StringComparison.OrdinalIgnoreCase);
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
        //   quoteRoots = YM, RTY, GC, SI, CL, 6E, ZN, ZB
        //                                 (0.4.0: served for the Quote board only, each on its own front-month roll; every
        //                                  order for them is refused. Default these eight; "quoteRoots =" for none.)
        //   contract.MNQ = MNQ 12-26      (forces a contract instead of the computed front month)
        //   postFills = true              (send every fill to The Desk; off by default)
        //   postStops = true              (0.6.6: the stop record to The Desk, every stop order's price at send and each modify;
        //                                  with no postStops line it follows postFills; see ChartBridgeStops.cs)
        //   postOrders = true             (0.6.9: the order record to The Desk, every order of every type and each change of it; with
        //                                  no postOrders line it follows postFills; see ChartBridgeOrderRecord.cs)
        //   deskUrl = http://localhost:8800
        //   trading = true                (order entry from the chart; OFF by default; see ChartBridgeOrders.cs)
        //   tradeAccounts = Sim101, ...   (exact account names; pre-checked on a first start, and gate 2 only with accountChecks = off)
        //   maxQty.MNQ = 5                (largest order per instrument root; default 1. 0.5.3: agents' MNQ entries never read it:
        //                                  their own cap is 20, Anthony 2026-10-10; ChartBridgeAgents.ShippedConfigCap)
        //   accountChecks = off           (0.4.0: every v3 feature is ON by default, Anthony 2026-10-07; a line like this turns one
        //                                  off. accountChecks: gate 2 is the page's per-account checkmark, saved in accounts.txt;
        //                                  see ChartBridgeAccounts.cs. The others: orderTypes, strategies, merge, cancelFromList,
        //                                  copier, bot. trading = true stays the master switch above them all)
        //   allowOrigins = https://desk.example.com, http://100.88.192.33:8800
        //                                 (web pages besides ChartBridge's own that may open the read-only
        //                                  WebSocket, such as The Desk; exact scheme://host[:port], no wildcard;
        //                                  they can never trade. Requests still have to come from this PC.
        //                                  One line: the last allowOrigins line wins. Non-ASCII hosts in punycode.)
        //   bars = on, barsRoots, pc      (0.3.6: daily 1-minute bars to The Desk; off by default; see ChartBridgeBars.cs)
        //   bars1s = off, bars1sRoots     (0.6.9: with bars = on, each session's 1 second bars for NQ and MNQ too; bars1s = off turns
        //                                  only them off; see ChartBridgeBars.cs)
        //   bot = off, botRoot, botLibrary (0.4.0: the bot channel, on by default, on the account chosen on the Bot tab; see ChartBridgeBot.cs)
        //   agents = manrae                (0.5.0: the agent channel, a comma list of agent ids; none: off; see ChartBridgeAgents.cs)
        //   timeServer = time.windows.com  (0.5.6: the time server this PC's clock is checked against every 5 minutes, so the page
        //                                  can split its feed delay into the clock's part and the real one; off: no check. It
        //                                  only measures, never sets the clock. See ChartBridgeClock)
        // Any other key (the retired accounts and quoteHours lines included) does nothing, said once per load in the Output
        // window: "config.txt: <key> is not a ChartBridge setting; the line does nothing".
        public static void Load()
        {
            ChartBridgeOrders.ResetConfig();
            AllowOrigins = new List<string>();
            ChartBridgeBars.ResetConfig();
            ChartBridgeStops.ResetConfig();   // 0.6.6: the stop record follows postFills unless config.txt has postStops
            ChartBridgeOrderRecord.ResetConfig();   // 0.6.9: the order record follows postFills unless config.txt has postOrders
            ChartBridgeSwitches.Reset();   // 0.4.0 accounts: the v3 switches, all ON unless config.txt turns one off (Anthony 2026-10-07)
            ChartBridgeCopier.ResetConfig();   // 0.4.0 copier:
            ChartBridgeBot.ResetConfig();   // 0.4.0 bot: on by default
            ChartBridgeAgents.ResetConfig();   // 0.5.0 agents: off until config.txt names one
            ChartBridgeClock.ResetConfig();   // 0.5.6: the time check asks time.windows.com unless config.txt names another
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
                ChartBridgeSwitches.Note(key, val);   // 0.4.0 accounts: records a v3 switch (accountChecks, cancelFromList, ...); never takes the key
                int n;
                if (key == "port") { if (int.TryParse(val, out n)) Port = n; }
                else if (key == "days") { if (int.TryParse(val, out n)) DefaultDays = Math.Max(1, Math.Min(60, n)); }
                else if (key == "tickHours") { if (int.TryParse(val, out n)) DefaultTickHours = Math.Max(0, Math.Min(48, n)); }
                else if (key == "rangeHours") { if (int.TryParse(val, out n)) RangeHours = Math.Max(1, Math.Min(8, n)); }
                else if (key == "profileRoots") ProfileRoots = val.Split(',').Select(s => s.Trim().ToUpperInvariant()).Where(s => s.Length > 0).ToArray();
                else if (key == "roots") Roots = val.Split(',').Select(s => s.Trim().ToUpperInvariant()).Where(s => s.Length > 0).ToArray();
                else if (key == "quoteRoots") QuoteRoots = val.Split(',').Select(s => s.Trim().ToUpperInvariant()).Where(s => s.Length > 0).ToArray();   // 0.4.0
                else if (key.StartsWith("contract.")) ContractOverride[key.Substring(9).Trim().ToUpperInvariant()] = val;
                else if (ChartBridgeStops.ReadConfig(key, val)) { }   // 0.6.6: postStops = true|false (ChartBridgeStops.cs)
                else if (ChartBridgeOrderRecord.ReadConfig(key, val)) { }   // 0.6.9: postOrders = true|false (ChartBridgeOrderRecord.cs)
                else if (key == "postFills") PostFills = val.Equals("true", StringComparison.OrdinalIgnoreCase) || val == "1";
                else if (key == "deskUrl") DeskUrl = val.TrimEnd('/');
                else if (key == "allowOrigins") AllowOrigins = ChartBridgeAccess.ParseOrigins(val);
                else if (ChartBridgeCopier.ReadConfig(key, val)) { }   // 0.4.0 copier: copier = off turns it off (on by default; ChartBridgeCopier.cs)
                else if (ChartBridgeBot.ReadConfig(key, val)) { }    // 0.4.0 bot: bot, botRoot, botLibrary (ChartBridgeBot.cs)
                else if (ChartBridgeAgents.ReadConfig(key, val)) { }   // 0.5.0 agents: agents = manrae (ChartBridgeAgents.cs)
                else if (ChartBridgeClock.ReadConfig(key, val)) { }   // 0.5.6: timeServer = time.windows.com, or off (ChartBridgeClock)
                else if (ChartBridgeBars.ReadConfig(key, val)) { }   // bars, barsRoots, pc (ChartBridgeBars.cs)
                else if (ChartBridgeOrders.ReadConfig(key, val)) { }   // trading, tradeAccounts, maxQty.<ROOT>, maxTicksAway, maxBracketTicks, merge, orderTypes, strategies
                else if (Array.IndexOf(ChartBridgeSwitches.Names, key) >= 0) { }   // accountChecks, cancelFromList: read by ChartBridgeSwitches.Note above
                else if (key.StartsWith("maxQty.")) ChartBridgeServer.Log("config.txt: " + key + " = " + val + " is not a whole number; the line does nothing");
                else ChartBridgeServer.Log("config.txt: " + key + " is not a ChartBridge setting; the line does nothing");
            }
            ChartBridgeAgents.NoteConfigCaps();   // 0.5.3: a maxQty.MNQ line caps the page only, not agents: said once
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
            if (stepped != 0) ChartBridgeClock.PcClockChanged(stepped);   // 0.5.6: the time check's offset follows too (over 250 ms: checked again)
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

    // ------------------------------------------------------------------ 0.3.7: the CME calendar (lf7 N4)
    // A port of the page's rules in src/chart-engine.js (nyseHolidays, nyseEarlyCloses, goodFriday, cmeClosures, cmeClosed),
    // day for day, so ChartBridge and the chart agree on when CME Globex equity index futures are shut. Dates are New York
    // calendar dates; times are New York wall clock. Unscheduled changes are not known in advance and are not here.
    public static class ChartBridgeCme
    {
        private static readonly Dictionary<int, HashSet<DateTime>> HolidayCache = new Dictionary<int, HashSet<DateTime>>(), EarlyCache = new Dictionary<int, HashSet<DateTime>>(), ClosureCache = new Dictionary<int, HashSet<DateTime>>();

        // Easter Sunday less two days (the anonymous Gregorian algorithm, as the page).
        public static DateTime GoodFriday(int year)
        {
            int a = year % 19, b = year / 100, c = year % 100, d4 = b / 4, e = b % 4, f = (b + 8) / 25;
            int g = (b - f + 1) / 3, h = (19 * a + b - d4 - g + 15) % 30, i = c / 4, k = c % 4;
            int l = (32 + 2 * e + 2 * i - h - k) % 7, m = (a + 11 * h + 22 * l) / 451;
            int em = (h + l - 7 * m + 114) / 31, ed = ((h + l - 7 * m + 114) % 31) + 1;
            return new DateTime(year, em, ed).AddDays(-2);
        }
        private static DateTime Nth(int year, int month, DayOfWeek wd, int n) { DateTime d = new DateTime(year, month, 1); while (d.DayOfWeek != wd) d = d.AddDays(1); return d.AddDays(7 * (n - 1)); }
        private static DateTime LastWd(int year, int month, DayOfWeek wd) { DateTime d = new DateTime(year, month, 1).AddMonths(1).AddDays(-1); while (d.DayOfWeek != wd) d = d.AddDays(-1); return d; }
        private static DateTime Observed(DateTime d) { return d.DayOfWeek == DayOfWeek.Saturday ? d.AddDays(-1) : d.DayOfWeek == DayOfWeek.Sunday ? d.AddDays(1) : d; }

        // NYSE full-day closures: New Year's Day (Sunday to Monday; on a Saturday not moved), Martin Luther King Jr. Day,
        // Washington's Birthday, Good Friday, Memorial Day, Juneteenth (from 2022), Independence Day, Labor Day, Thanksgiving
        // and Christmas (Saturday to Friday, Sunday to Monday).
        public static HashSet<DateTime> NyseHolidays(int year)
        {
            lock (HolidayCache)
            {
                HashSet<DateTime> set;
                if (HolidayCache.TryGetValue(year, out set)) return set;
                set = new HashSet<DateTime>();
                DateTime ny = new DateTime(year, 1, 1);
                if (ny.DayOfWeek != DayOfWeek.Saturday) set.Add(Observed(ny));
                set.Add(Nth(year, 1, DayOfWeek.Monday, 3)); set.Add(Nth(year, 2, DayOfWeek.Monday, 3)); set.Add(GoodFriday(year)); set.Add(LastWd(year, 5, DayOfWeek.Monday));
                if (year >= 2022) set.Add(Observed(new DateTime(year, 6, 19)));
                set.Add(Observed(new DateTime(year, 7, 4))); set.Add(Nth(year, 9, DayOfWeek.Monday, 1)); set.Add(Nth(year, 11, DayOfWeek.Thursday, 4)); set.Add(Observed(new DateTime(year, 12, 25)));
                HolidayCache[year] = set;
                return set;
            }
        }
        // NYSE early closes (13:00 ET): the day after Thanksgiving; July 3 and December 24 when Monday to Thursday.
        public static HashSet<DateTime> NyseEarlyCloses(int year)
        {
            lock (EarlyCache)
            {
                HashSet<DateTime> set;
                if (EarlyCache.TryGetValue(year, out set)) return set;
                set = new HashSet<DateTime> { Nth(year, 11, DayOfWeek.Thursday, 4).AddDays(1) };
                foreach (DateTime d in new[] { new DateTime(year, 7, 3), new DateTime(year, 12, 24) }) if (d.DayOfWeek >= DayOfWeek.Monday && d.DayOfWeek <= DayOfWeek.Thursday) set.Add(d);
                EarlyCache[year] = set;
                return set;
            }
        }
        // Days with no Globex session at all: New Year's Day, Good Friday and Christmas, on the days the NYSE observes them.
        public static HashSet<DateTime> CmeClosures(int year)
        {
            lock (ClosureCache)
            {
                HashSet<DateTime> set;
                if (ClosureCache.TryGetValue(year, out set)) return set;
                HashSet<DateTime> hol = NyseHolidays(year);
                set = new HashSet<DateTime>(new[] { new DateTime(year, 1, 1), new DateTime(year, 1, 2), GoodFriday(year), new DateTime(year, 12, 24), new DateTime(year, 12, 25), new DateTime(year, 12, 26) }.Where(d => hol.Contains(d)));
                ClosureCache[year] = set;
                return set;
            }
        }
        // The trading day a New York wall time belongs to: sessions start at 18:00, so 18:00 on a day starts the next day's.
        public static DateTime TradingDay(DateTime etWall) { return etWall.AddHours(6).Date; }
        // Whether trading day d has a Globex session: Monday to Friday, not a CME closure.
        public static bool SessionDay(DateTime d)
        {
            d = d.Date;
            return d.DayOfWeek != DayOfWeek.Saturday && d.DayOfWeek != DayOfWeek.Sunday && !CmeClosures(d.Year).Contains(d);
        }
        // 0.3.7 (the prior settlement): the earliest a session's settlement can be out, its next session's 18:00 ET open, the
        // session running at New York time et (the last one begun; in a break, a weekend or a holiday, the one before it), and
        // the session day before a given one.
        public static TimeSpan EarliestSettlement(DateTime d) { return NyseHolidays(d.Year).Contains(d.Date) || NyseEarlyCloses(d.Year).Contains(d.Date) ? TimeSpan.FromHours(12) : TimeSpan.FromHours(16); }
        // 0.3.8: the session's close, New York time of day: 17:00, or the halt on an NYSE holiday (13:00) or early close (13:15).
        public static TimeSpan SessionClose(DateTime d) { return NyseHolidays(d.Year).Contains(d.Date) ? TimeSpan.FromHours(13) : NyseEarlyCloses(d.Year).Contains(d.Date) ? new TimeSpan(13, 15, 0) : TimeSpan.FromHours(17); }
        public static DateTime NextSessionOpen(DateTime d) { DateTime n = d.Date.AddDays(1); for (int i = 0; i < 30 && !SessionDay(n); i++) n = n.AddDays(1); return n.AddHours(-6); }
        public static DateTime CurrentSession(DateTime et) { DateTime d = TradingDay(et); for (int i = 0; i < 30 && !SessionDay(d); i++) d = d.AddDays(-1); return d; }
        public static DateTime PreviousSession(DateTime d) { DateTime p = d.Date.AddDays(-1); for (int i = 0; i < 30 && !SessionDay(p); i++) p = p.AddDays(-1); return p; }
        // Closed at New York wall time et: the 17:00 to 18:00 break every day, Friday 17:00 to Sunday 18:00, a day with no
        // Globex session, and after the halt on an NYSE holiday (13:00) or an NYSE early close (13:15) until 18:00.
        public static bool Closed(DateTime et)
        {
            double s = et.TimeOfDay.TotalSeconds;
            if (s >= 61200 && s < 64800) return true;
            if (!SessionDay(TradingDay(et))) return true;
            DateTime day = et.Date;
            if (day.DayOfWeek == DayOfWeek.Saturday || day.DayOfWeek == DayOfWeek.Sunday || s >= 64800) return false;
            if (NyseHolidays(day.Year).Contains(day)) return s >= 46800;
            if (NyseEarlyCloses(day.Year).Contains(day)) return s >= 47700;
            return false;
        }
    }

    // ------------------------------------------------------------------ 0.6.3 (audit C3): state files that survive a power cut
    // A whole file goes to a temp file opened write-through and flushed to the disk (Flush(true)) before it replaces the file, and
    // the copy it replaces is kept as <file>.bak (File.Replace's backup), so a power cut leaves the old file or the new one, never
    // a file of zeros, and a file that will not read can fall back to the last good copy (each loader says so). An append is
    // written through and flushed the same way.
    public static class ChartBridgeFiles
    {
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
        public static string BackupOf(string path) { return path + ".bak"; }

        public static void WriteWhole(string path, string text)
        {
            string dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            string tmp = path + ".tmp";
            byte[] bytes = Utf8.GetBytes(text);
            using (FileStream fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                fs.Write(bytes, 0, bytes.Length);
                fs.Flush(true);
            }
            if (File.Exists(path)) File.Replace(tmp, path, BackupOf(path), true); else File.Move(tmp, path);
        }

        public static void WriteLines(string path, IEnumerable<string> lines) { WriteWhole(path, string.Concat(lines.Select(l => l + Environment.NewLine))); }

        public static void Append(string path, string text)
        {
            byte[] bytes = Utf8.GetBytes(text);
            using (FileStream fs = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough))
            {
                fs.Write(bytes, 0, bytes.Length);
                fs.Flush(true);
            }
        }

        // 0.6.3 (review MED 5): a File.Replace cut off (a power cut between its steps) can leave no file with the copy beside it:
        // the copies to look at when the file is missing, the last good copy first, then the temp file that was about to replace it.
        public static string[] LeftOvers(string path) { return File.Exists(path) ? new string[0] : new[] { BackupOf(path), path + ".tmp" }.Where(File.Exists).ToArray(); }

        // The last good copy's lines (null: none, or it does not read).
        public static string[] ReadBackup(string path) { return ReadAny(BackupOf(path)); }
        // A file's lines (null: none, or it does not read).
        public static string[] ReadAny(string b)
        {
            try
            {
                if (!File.Exists(b)) return null;
                List<string> lines = new List<string>();
                using (FileStream fs = new FileStream(b, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (StreamReader r = new StreamReader(fs))
                {
                    string l;
                    while ((l = r.ReadLine()) != null) lines.Add(l);
                }
                return lines.ToArray();
            }
            catch (Exception) { return null; }
        }

        // A loader's note (a backup taken, a file kept from the lines that read): logged, to the pages now, and to each page that
        // signs in later this run (ChartBridgeAccounts.SignedIn).
        private static readonly List<string> Notes = new List<string>();
        public static void Note(string text)
        {
            ChartBridgeServer.Log("NOTE: " + text);
            lock (Notes) { if (!Notes.Contains(text)) Notes.Add(text); }
            ChartBridgeServer.SendToTraders(NoteJson(text));
        }
        public static void ClearNotes() { lock (Notes) Notes.Clear(); }
        public static void SignedIn(ChartBridgeClient c) { List<string> n; lock (Notes) n = Notes.ToList(); foreach (string t in n) c.Send(NoteJson(t)); }
        private static string NoteJson(string text) { return "{\"type\":\"status\",\"level\":\"warn\",\"text\":" + CbJson.Str(text) + "}"; }

        // 0.6.3 (audit C5, Anthony's decision): a kill switch kept in a file (agent-<id>-kill.txt, bot-kill.txt) so a restart never
        // releases it. Written only by the page's kill message; released only by it. The file there at all is a kill switch on
        // (one that does not read says so with a time of 0). KillSince: null when there is no file, else the UTC ms it went on.
        // Review (C5): -1 when the file is there but held open (an IOException): still on, read again as the agents' files (C4).
        public static Func<string, string> KillReadFault;   // test hook: a non-null answer fails the read by file name
        public static double? KillSince(string path)
        {
            try
            {
                if (!File.Exists(path)) return null;
                Func<string, string> fault = KillReadFault;
                string why = fault != null ? fault(Path.GetFileName(path)) : null;
                if (why != null) throw new IOException(why);
                foreach (string raw in File.ReadAllLines(path))
                {
                    string[] p = raw.Trim().Split('\t');
                    double v;
                    if (p.Length == 2 && p[0] == "killed" && double.TryParse(p[1], NumberStyles.None, CultureInfo.InvariantCulture, out v)) return v;
                }
                return 0;
            }
            catch (IOException) { return -1; }   // held open: still on; read again
            catch (Exception) { return 0; }   // there but not readable: still on (the careful side)
        }
        public static string SaveKill(string path, string who, double atMs)
        {
            try { WriteLines(path, new[] { "# ChartBridge kill switch for " + who + " (written only by the page's kill message; released only there; do not edit)", "# while this file is here the kill switch is on, also after a restart", "killed\t" + atMs.ToString("0", CultureInfo.InvariantCulture) }); return null; }
            catch (Exception ex) { return ex.Message; }
        }
        public static string ClearKill(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); string b = BackupOf(path); if (File.Exists(b)) File.Delete(b); return null; }
            catch (Exception ex) { return ex.Message; }
        }

        // The words the loaders use when the backup is taken.
        public static string BackupNote(string name, string why) { return name + " could not be read (" + why + "): ChartBridge uses its last good copy (" + name + ".bak), so the last change before the problem may be missing: check it on the page"; }
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
        public byte[] QCode;   // 0.3.8: served-window trades only: each one's Time and Sales category (0 unknown); null: none known

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
            if (QCode != null) { r.QCode = new byte[n]; Array.Copy(QCode, i0, r.QCode, 0, n); }
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
        public byte QCode;         // 0.3.8: its Time and Sales category (ChartBridgeSides.QCode: 0 unknown, the default)
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
    // Live trades only since 0.3.7 (the by-date backfill's sides and their join on the Bid and Ask history are removed).
    // The prevailing quote is the last bid and the last ask stamped STRICTLY BEFORE the
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

        // 0.3.8, Time and Sales: where a trade printed against the prevailing quote, as NinjaTrader's Time and Sales colours
        // it: 2 above the ask, 1 at the ask, 0 between, -1 at the bid, -2 below the bid; NoQ (sent as nothing) without a
        // usable quote (QuoteUsable: both sides above zero, bid below ask). The quote is the one the side was classified by.
        public const int NoQ = int.MinValue;
        public static int Category(double price, double bid, double ask)
        {
            if (!QuoteUsable(bid, ask)) return NoQ;
            long p = PriceKey(price), b = PriceKey(bid), a = PriceKey(ask);
            return p > a ? 2 : p == a ? 1 : p < b ? -2 : p == b ? -1 : 0;
        }
        // Kept in a byte where trades are stored (SeamTick, TradeLog): 0 unknown (the default), else q + 3 (1 to 5).
        public static byte QCode(int q) { return q == NoQ || q < -2 || q > 2 ? (byte)0 : (byte)(q + 3); }
        public static int QOf(byte code) { return code >= 1 && code <= 5 ? code - 3 : NoQ; }
        // The live tick's field, made once: no string is made per trade for it (unknown: no field).
        private static readonly string[] QFields = { ",\"q\":-2", ",\"q\":-1", ",\"q\":0", ",\"q\":1", ",\"q\":2" };
        public static string QJson(int q) { return q >= -2 && q <= 2 ? QFields[q + 2] : ""; }
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
        private readonly List<byte[]> cats = new List<byte[]>();   // 0.3.8: each trade's Time and Sales category (QCode; 0 unknown)
        public int Count;
        public int Served;                   // loads that got their window from here (for /diag)

        // A trade from NinjaTrader's tick answer has no quote stored with it: its category is unknown (0), never guessed.
        public void Add(DateTime t, double price, long volume) { Add(t, price, volume, 0); }
        public void Add(DateTime t, double price, long volume, byte qCode)
        {
            if ((Count & Mask) == 0) { times.Add(new long[Size]); prices.Add(new double[Size]); vols.Add(new long[Size]); cats.Add(new byte[Size]); }
            int b = Count >> Shift, i = Count & Mask;
            times[b][i] = t.Ticks; prices[b][i] = price; vols[b][i] = volume; cats[b][i] = qCode;
            Count++;
        }
        public DateTime First { get { return Count > 0 ? new DateTime(times[0][0]) : DateTime.MinValue; } }

        // What is logged so far, fixed: the blocks are only ever appended to, so this copies block references, not trades
        // (the lock is held for microseconds); ToBars then copies the trades with no lock held.
        public View Snapshot() { return new View { T = times.ToArray(), P = prices.ToArray(), V = vols.ToArray(), Q = cats.ToArray(), Count = Count }; }
        public class View
        {
            public long[][] T; public double[][] P; public long[][] V; public byte[][] Q; public int Count;
            public RawBars ToBars()
            {
                RawBars r = new RawBars { Count = Count, Time = new DateTime[Count], Close = new double[Count], Volume = new long[Count], QCode = new byte[Count] };
                for (int i = 0; i < Count; i++) { int b = i >> Shift, k = i & Mask; r.Time[i] = new DateTime(T[b][k]); r.Close[i] = P[b][k]; r.Volume[i] = V[b][k]; r.QCode[i] = Q[b][k]; }
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
        // 0.3.7: the trading day of a session starting at startEt (bar-time seconds of its 18:00 ET start): the date it ends on.
        public static DateTime TradingDate(double startEt) { return new DateTime(1970, 1, 1).AddSeconds(startEt + 6 * 3600).Date; }
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

    // ------------------------------------------------------------------ 0.6.8: the minute book
    // Per instrument, 1-minute OHLCV bars built from every live trade ChartBridge sees (OnMarketData, under the book's lock), so a
    // minute chart's load no longer depends on NinjaTrader's minute history reaching up to now (WORK 2026-10-23: after a reload
    // NinjaTrader's minute answer ended 28 to 40 minutes early and the chart had a hole until the live bar). Stamped exactly as
    // NinjaTrader stamps its minute bars and as ChartBridgeSeam.TailFromTicks rebuilds them: at the bar's close, a trade at
    // exactly hh:mm:00.000 in the bar that ends then (end-inclusive, the rule PROTOCOL.md's live check recipe is for). No side
    // volume: the history bars carry none ([t, o, h, l, c, v]).
    // From: a minute close (NinjaTrader time, DateTime ticks): every trade after it is in the book, every bar closes after it.
    // Set at the first trade after a start or a reset, to the close of that trade's minute or of the clock's minute, whichever
    // is later (NinjaTrader can replay an old last trade when market data starts: the clock keeps it from claiming the time
    // before). Trades at or before From are not kept. Reset on a feed drop (the market open); a new contract only comes with a
    // start, which makes new books. At most Cap bars (about two sessions), the oldest Trim go at once and From moves up to the
    // last of them. Per trade: one division, a compare and a few stores; no allocation.
    public class MinuteBook
    {
        public const int Cap = 3000, Trim = 120;
        private const long Minute = TimeSpan.TicksPerMinute;
        private readonly long[] close = new long[Cap];
        private readonly double[] open = new double[Cap], high = new double[Cap], low = new double[Cap], last = new double[Cap];
        private readonly long[] vol = new long[Cap];
        public int Count;
        public long From = -1;                 // -1: not started (no trade since the start or the last reset)
        public DateTimeKind Kind = DateTimeKind.Unspecified;
        public long LastTrade;                 // NinjaTrader's time of the last trade it saw (kept or not), DateTime ticks; 0: none
        public long Trades, LateTrades, Resets;
        public string ResetWhy;

        // The close of the 1-minute bar holding time t (end-inclusive, as NinjaTrader and TailFromTicks).
        public static long CloseOf(long t) { long rem = t % Minute; return rem == 0 ? t : t - rem + Minute; }

        public void Reset(string why) { Count = 0; From = -1; Resets++; ResetWhy = why; }

        // Under the RootBook's lock. nowNt: NinjaTrader's clock now (read by the caller only while From is -1).
        public void Begin(DateTime t, DateTime nowNt)
        {
            From = Math.Max(CloseOf(t.Ticks), nowNt == DateTime.MinValue ? 0 : CloseOf(nowNt.Ticks));
            Kind = t.Kind;
        }

        public void Add(DateTime time, double p, long v)
        {
            long t = time.Ticks;
            if (t > LastTrade) LastTrade = t;
            if (From < 0 || t <= From) return;
            Trades++;
            long k = CloseOf(t);
            int n = Count;
            if (n > 0 && close[n - 1] == k)
            {
                int j = n - 1;
                if (p > high[j]) high[j] = p;
                if (p < low[j]) low[j] = p;
                last[j] = p; vol[j] += v;
                return;
            }
            if (n == 0 || close[n - 1] < k) { Put(n, k, p, v); return; }
            // a late trade (NinjaTrader's time before the last bar's minute): its own bar's high, low and volume
            LateTrades++;
            int i = n - 1;
            while (i >= 0 && close[i] > k) i--;
            if (i >= 0 && close[i] == k)
            {
                if (p > high[i]) high[i] = p;
                if (p < low[i]) low[i] = p;
                vol[i] += v;
                return;
            }
            Insert(i + 1, k, p, v);   // a minute with no bar yet (rare): in its place
        }

        private void Put(int at, long k, double p, long v)
        {
            if (Count == Cap) { Drop(); at = Count; }
            close[at] = k; open[at] = p; high[at] = p; low[at] = p; last[at] = p; vol[at] = v;
            Count++;
        }
        private void Insert(int at, long k, double p, long v)
        {
            if (Count == Cap) { Drop(); at = Math.Max(0, at - Trim); if (k <= From) return; }
            int m = Count - at;
            Array.Copy(close, at, close, at + 1, m); Array.Copy(open, at, open, at + 1, m); Array.Copy(high, at, high, at + 1, m);
            Array.Copy(low, at, low, at + 1, m); Array.Copy(last, at, last, at + 1, m); Array.Copy(vol, at, vol, at + 1, m);
            Count++;
            close[at] = k; open[at] = p; high[at] = p; low[at] = p; last[at] = p; vol[at] = v;
        }
        // The oldest Trim bars go; From becomes the last one's close (every trade after it is still in).
        private void Drop()
        {
            From = close[Trim - 1];
            int m = Count - Trim;
            Array.Copy(close, Trim, close, 0, m); Array.Copy(open, Trim, open, 0, m); Array.Copy(high, Trim, high, 0, m);
            Array.Copy(low, Trim, low, 0, m); Array.Copy(last, Trim, last, 0, m); Array.Copy(vol, Trim, vol, 0, m);
            Count = m;
        }

        // Under the RootBook's lock: a copy (at most Cap bars, a few microseconds), used with no lock held.
        public MinuteSnap Snap()
        {
            MinuteSnap s = new MinuteSnap { From = From, Kind = Kind, LastTrade = LastTrade };
            RawBars r = new RawBars { Count = Count, Time = new DateTime[Count], Open = new double[Count], High = new double[Count], Low = new double[Count], Close = new double[Count], Volume = new long[Count] };
            for (int i = 0; i < Count; i++) r.Time[i] = new DateTime(close[i], Kind);
            Array.Copy(open, r.Open, Count); Array.Copy(high, r.High, Count); Array.Copy(low, r.Low, Count); Array.Copy(last, r.Close, Count); Array.Copy(vol, r.Volume, Count);
            s.Bars = r;
            return s;
        }
    }

    // A minute book as it was at a load's subscribe (copied under the RootBook's lock together with the clearing of the page's
    // held trades): every trade before that moment is in Bars, every one after it is held for the page.
    public class MinuteSnap
    {
        public long From = -1;
        public long LastTrade;                 // the last trade before the copy (NinjaTrader time, ticks; 0: none): the held trades come after it
        public DateTimeKind Kind;
        public RawBars Bars;
        public bool Started { get { return From >= 0; } }

        // NinjaTrader's minute answer (nt, its last bar still forming) joined to the book: NinjaTrader's bars up to the cut, then
        // the book's after it. The cut is From, moved up past any closed minute NinjaTrader has more volume for than the book
        // (the book missed trades there: a drop no event told of); NinjaTrader's last bar and the book's last are never compared
        // (both may be partial). Null when the book cannot stand in: not started, it begins after NinjaTrader's last bar (a hole
        // between them: ChartBridge started, or the feed came back, after that bar), or it has no bar yet (the review of 0.6.8: a
        // load in the book's first minute, From the close of the minute still forming; NinjaTrader's bar stamped at From would
        // then hold trades the page also gets as held trades). With a bar after From, every kept NinjaTrader bar closes before the
        // copy's last trade, so none holds a held trade. An empty answer: the book alone.
        public RawBars Join(RawBars nt, out long cut, out int filled, out int shortMinutes)
        {
            cut = From; filled = 0; shortMinutes = 0;
            if (!Started || Bars == null || Bars.Count == 0) return null;
            int n = nt != null ? nt.Count : 0;
            if (n > 0 && nt.Time[n - 1].Ticks < From) return null;
            int b = Bars.Count;
            long bookLast = b > 0 ? Bars.Time[b - 1].Ticks : From;
            for (int i = 0; i < n - 1; i++)
            {
                long t = nt.Time[i].Ticks;
                if (t <= From || t >= bookLast) continue;
                int k = Array.BinarySearch(Bars.Time, 0, b, nt.Time[i]);
                long have = k >= 0 ? Bars.Volume[k] : 0;
                if (have < nt.Volume[i]) { shortMinutes++; if (t > cut) cut = t; }
            }
            int keep = 0;
            while (keep < n && nt.Time[keep].Ticks <= cut) keep++;
            int from = 0;
            while (from < b && Bars.Time[from].Ticks <= cut) from++;
            filled = b - from;
            RawBars r = new RawBars { Count = keep + filled, Time = new DateTime[keep + filled], Open = new double[keep + filled], High = new double[keep + filled], Low = new double[keep + filled], Close = new double[keep + filled], Volume = new long[keep + filled] };
            if (keep > 0)
            {
                Array.Copy(nt.Time, r.Time, keep); Array.Copy(nt.Open, r.Open, keep); Array.Copy(nt.High, r.High, keep);
                Array.Copy(nt.Low, r.Low, keep); Array.Copy(nt.Close, r.Close, keep); Array.Copy(nt.Volume, r.Volume, keep);
            }
            Array.Copy(Bars.Time, from, r.Time, keep, filled); Array.Copy(Bars.Open, from, r.Open, keep, filled); Array.Copy(Bars.High, from, r.High, keep, filled);
            Array.Copy(Bars.Low, from, r.Low, keep, filled); Array.Copy(Bars.Close, from, r.Close, keep, filled); Array.Copy(Bars.Volume, from, r.Volume, keep, filled);
            return r;
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
        // 0.3.7: finished sessions by trading day (the date the session ends on), for the weekly profile: each table as it
        // finishes, and the saved ones read from profile-<ROOT>-<date>.txt once (PastLoaded). At most PastKept.
        public readonly Dictionary<DateTime, SessionTable> Past = new Dictionary<DateTime, SessionTable>();
        public bool PastLoaded;
        public const int PastKept = 10;
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
        // 0.6.8: the minute book (every live trade's 1-minute bars), and a minute history or last-trades request NinjaTrader
        // has not answered in its time (when it was given up; -1: none): no new one is asked for the instrument meanwhile.
        public readonly MinuteBook Minutes = new MinuteBook();
        public double MinuteOverdueMs = -1, TailOverdueMs = -1;
        // 0.6.8: NinjaTrader's minute answers for this instrument, joined (ChartBridgeServer.KeepNtMinutes; in memory only, at most
        // NtMinutesKept bars): a load whose own minute request is not answered in time starts from these and the minute book.
        public RawBars NtMinutes; public double NtMinutesAtMs = -1;
        public DateTime NtMinutesFrom = DateTime.MaxValue;   // the earliest request start the kept answers cover (re-review B)
        public DateTime NtMinutesLastAt = DateTime.MaxValue; // third review E: NinjaTrader's clock when the answer with the kept last bar came (that bar was forming then)
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
            OnTrade(t, price, volume, et, listeningSinceUtc, feedUpSinceUtc, nowMs, nowNt, backfill, 0);
        }
        // qCode (0.3.8): the trade's Time and Sales category as tagged live (ChartBridgeSides.QCode), kept in the served window.
        public void OnTrade(DateTime t, double price, long volume, double et, DateTime listeningSinceUtc, DateTime feedUpSinceUtc, double nowMs, DateTime nowNt, bool backfill, byte qCode)
        {
            if (Table == null || t >= Table.End || t < Table.Start)
            {
                DateTime s, e;
                SessionClock.Bounds(t, out s, out e);
                if (Table != null && s < Table.Start) { LateTrades++; if (Cache != null) Cache.Add(t, price, volume, qCode); AddLive(t, price, volume, qCode); return; }
                if (nowNt != DateTime.MinValue && Math.Abs((nowNt - t).TotalSeconds) > StaleTradeSec) { StaleTrades++; return; }
                if (Table != null) { Last = Table; LastChanged = true; KeepPast(Table); }
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
            if (Cache != null) Cache.Add(t, price, volume, qCode);
            AddLive(t, price, volume, qCode);
            if (rateStartMs < 0) rateStartMs = nowMs;
            if (nowMs - rateStartMs >= 15 * 60000) { rateLast = rateCur; rateCur = 0; rateStartMs = nowMs; }
            rateCur++;
        }
        private void AddLive(DateTime t, double price, long volume, byte qCode)
        {
            if (WindowLive == null) return;
            if (WindowLive.Count < LiveCap) WindowLive.Add(new SeamTick { Time = t, Price = price, Volume = volume, QCode = qCode });
            else { WindowLive = null; CapGen = WindowGen; }   // abandoned: the loads waiting are answered (no trades) off the lock
        }
        public bool InTable(DateTime t) { return Table != null && t >= Table.Start && t < Table.End; }

        // Under Sync (0.3.7): a finished table kept by its trading day; the oldest go past PastKept.
        public void KeepPast(SessionTable t)
        {
            if (t == null) return;
            Past[SessionTable.TradingDate(t.StartEt)] = t;
            while (Past.Count > PastKept) Past.Remove(Past.Keys.Min());
        }

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
            b.Append("session ").Append(CbJson.Num3(t.StartEt)).Append(' ').Append(t.Whole ? 1 : 0).Append(' ').Append(CbJson.Num3(t.CoveredFromEt));
            // 0.3.7: the feed drop, when there was one ("-" when none; older files end after coveredFrom: no drop known)
            b.Append(' ').Append(t.Dropped ? CbJson.Num3(t.DropAtEt) : "-");
            if (t.Dropped) b.Append(' ').Append((t.DropWhy ?? "").Replace('\n', ' ').Replace('\r', ' '));
            b.Append('\n');
            List<long> keys = new List<long>(t.Vol.Keys); keys.Sort();
            foreach (long k in keys) b.Append(k.ToString(CultureInfo.InvariantCulture)).Append(' ').Append(t.Vol[k].ToString(CultureInfo.InvariantCulture)).Append('\n');
            return b.ToString();
        }
        public const double LastMaxAgeSec = 4 * 86400;   // a saved session older than this (a long weekend at most) is not used as "last"
        // 0.3.7: a dated copy per session, profile-<ROOT>-<yyyy-MM-dd>.txt (the trading day), for the weekly profile; kept 14 days
        public string PastFile(DateTime day) { return System.IO.Path.Combine(ChartBridgeConfig.Folder, "profile-" + Root + "-" + day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + ".txt"); }
        public const int PastFileDays = 14;
        public static SessionTable ParseTable(string text) { return ParseLast(text, double.NegativeInfinity); }   // 0.3.7: no age limit (the weekly profile)
        public static SessionTable ParseLast(string text, double nowEt)
        {
            if (string.IsNullOrEmpty(text)) return null;
            string[] lines = text.Split('\n');
            string[] h = lines[0].Split(' ');
            if (h.Length < 4 || h[0] != "session") return null;
            SessionTable t = new SessionTable { StartEt = double.Parse(h[1], CultureInfo.InvariantCulture), Whole = h[2] == "1", CoveredFromEt = double.Parse(h[3], CultureInfo.InvariantCulture) };
            if (nowEt - t.StartEt > LastMaxAgeSec) return null;
            if (h.Length >= 5 && h[4] != "-") { t.Dropped = true; t.Whole = false; t.DropAtEt = double.Parse(h[4], CultureInfo.InvariantCulture); t.DropWhy = string.Join(" ", h.Skip(5).ToArray()); }
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
        private bool hasLast;
        private int lastSide;
        private readonly SessionClock session = new SessionClock();
        private readonly long[] counts = new long[4];
        private long bidUpdates, askUpdates, eventSame, eventDiffers, eventNone, tieChanged, quoteAfterTrade, staleQuotes, resets;
        private readonly long[] catCounts = new long[5];   // 0.3.8: trades by Time and Sales category, -2 to 2
        private long catNone;

        public void NoteQuote(bool isBid, double price, DateTime time)
        {
            lock (sync) { if (isBid) { bids.Add(time, price); bidUpdates++; } else { asks.Add(time, price); askUpdates++; } }
        }

        // NinjaTrader reset its market data (IsReset) or a connection dropped: the quote is unknown until new updates.
        public void ClearQuote() { lock (sync) { bids.Clear(); asks.Clear(); resets++; } }

        // 0.6.9 (the order record): the last bid and ask to arrive, with NinjaTrader's time of each (NaN when none since a reset).
        public void LatestQuote(out double bid, out DateTime bidTime, out double ask, out DateTime askTime)
        {
            lock (sync) { bid = bids.Latest; bidTime = bids.LatestTime; ask = asks.Latest; askTime = asks.LatestTime; }
        }

        private bool Quote(DateTime t, bool inclusive, out double bid, out double ask)
        {
            DateTime bt, at;
            bool ok = bids.AsOf(t, inclusive, out bid, out bt) & asks.AsOf(t, inclusive, out ask, out at);
            return ok && (t - bt).Ticks <= ChartBridgeSides.QuoteMaxAge && (t - at).Ticks <= ChartBridgeSides.QuoteMaxAge;
        }

        // eventBid, eventAsk: the Last update's own Bid and Ask (MarketDataEventArgs), only compared, for /diag.
        public int Tag(double price, DateTime time, double eventBid, double eventAsk, out int method)
        {
            int cat;
            return Tag(price, time, eventBid, eventAsk, out method, out cat);
        }

        // cat (0.3.8, the wire's q): the trade's Time and Sales category (ChartBridgeSides.Category) against the same quote
        // the side used; ChartBridgeSides.NoQ without one.
        public int Tag(double price, DateTime time, double eventBid, double eventAsk, out int method, out int cat)
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
                cat = q ? ChartBridgeSides.Category(price, b, a) : ChartBridgeSides.NoQ;
                if (cat == ChartBridgeSides.NoQ) catNone++; else catCounts[cat + 2]++;
                bool q2 = Quote(time, true, out b2, out a2);
                int m2;
                if (ChartBridgeSides.Classify(price, q2 ? b2 : double.NaN, q2 ? a2 : double.NaN, hasLast, lastPrice, lastSide, out m2) != s) tieChanged++;
                if ((!double.IsNaN(bids.Latest) && bids.LatestTime > time) || (!double.IsNaN(asks.Latest) && asks.LatestTime > time)) quoteAfterTrade++;
                counts[method]++;
                if (!ChartBridgeSides.QuoteUsable(eventBid, eventAsk)) eventNone++;
                else if (ChartBridgeSides.PriceKey(eventBid) == ChartBridgeSides.PriceKey(bids.Latest) && ChartBridgeSides.PriceKey(eventAsk) == ChartBridgeSides.PriceKey(asks.Latest)) eventSame++;
                else eventDiffers++;
                hasLast = true; lastPrice = price; lastSide = s;
                return s;
            }
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
                    ",\"eventQuoteSame\":" + eventSame + ",\"eventQuoteDiffers\":" + eventDiffers + ",\"eventQuoteNone\":" + eventNone +
                    ",\"q\":{\"aboveAsk\":" + catCounts[4] + ",\"atAsk\":" + catCounts[3] + ",\"between\":" + catCounts[2] + ",\"atBid\":" + catCounts[1] + ",\"belowBid\":" + catCounts[0] + ",\"unknown\":" + catNone + "}}";
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
        // 0.5.1: an orders or positions snapshot for this page (the list at sign-in, a newly listed account's orders) is being built
        // and queued: what NinjaTrader's thread sends this page meanwhile is noted in every open snapshot's own notes (under
        // SnapLock, held only to note or take) and sent again, fresh, right after that snapshot (ChartBridgeOrders.Snapshot), so
        // the newest state lands last, also with two snapshots open at once.
        public readonly object SnapLock = new object();
        public readonly List<ChartBridgeOrders.SnapNotes> SnapOpen = new List<ChartBridgeOrders.SnapNotes>();   // each open snapshot's own notes
        public readonly List<SeamTick> Pending = new List<SeamTick>();   // live ticks held during backfill (lock it to read or write)
        public int SubscribeSeq;                // bumped under the Pending lock on every subscribe: a load for an older one is dropped
        public volatile bool WantsProfile;      // 0.3.5: the page's subscribe asked for "profile" messages (set under the Pending lock)
        public readonly Dictionary<string, ChartBridgeServer.HtfWatch> Htf = new Dictionary<string, ChartBridgeServer.HtfWatch>();   // 0.3.7: higher-timeframe series this page asked for (lock it)
        public bool WeekBusy;   // 0.3.7: one weekProfile answer in progress per page (under the Htf lock)
        public readonly List<string[]> WeekQueue = new List<string[]>();   // requests meanwhile, folded per root: {root, latest id}, in order (Htf lock)
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
        public readonly CbHist SendMs = new CbHist(0.01);   // 0.4.0: how long each send to this page took, ms (/diag pages[].sendMs)

        public Action<string> Tap;              // test hook: sees every message sent (unused in NinjaTrader)

        private static readonly string[] OrderLaneTypes = { "hello", "trading", "orders", "order", "position", "reject", "exec", "execs", "status", "pong", "accounts", "merge", "copier", "copierEvent",
            "bot", "botSignal", "botProposal", "welcome", "botState", "answer", "managed", "pcClock", "groupPreview", "groupPlaced", "riskAlert" };   // 0.6.6: riskAlert (a held entry, a skipped copy, a daily loss reached)   // 0.6.5: a group entry's preview and result   // 0.4.0 accounts: "accounts" in the order lane   // 0.4.0 B4: merge   // 0.4.0 copier: copier, copierEvent   // 0.4.0 bot: the bot's messages never wait behind market data   // 0.4.0 B1: managed   // 0.5.6: pcClock, in order after hello

        // The message's type, read from its start ({"type":"...), as every message ChartBridge sends begins.
        public static string TypeOf(string json)
        {
            const string head = "{\"type\":\"";
            if (json == null || !json.StartsWith(head, StringComparison.Ordinal)) return null;
            int end = json.IndexOf('"', head.Length);
            return end < 0 ? null : json.Substring(head.Length, end - head.Length);
        }

        private static readonly string[] AgentLaneTypes = { "agent", "agentPlan", "agentProposal", "agentNote", "agentState" };   // 0.5.0 agents: never behind market data

        public static bool OrderLane(string json)
        {
            string type = TypeOf(json);
            return type != null && (Array.IndexOf(OrderLaneTypes, type) >= 0 || Array.IndexOf(AgentLaneTypes, type) >= 0);
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
            {
                ChartBridgeHealth.NotKeepingUp();   // 0.4.0: counted in /diag health.pages
                ChartBridgeServer.Log("Client " + Id + " is not keeping up" + (lagMs.HasValue ? ": " + (lagMs.Value / 1000).ToString("0.0", CultureInfo.InvariantCulture) + " s behind" : "") + "; closing it (the page reconnects and reloads).");
            }
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

        // 0.4.0: blocks this page's own send thread until the socket has taken the message (SendLoop). Once the page is closed
        // the wait ends within a second even if the socket never answers, so no thread is left waiting on a dead page.
        private bool SendText(string msg)
        {
            if (Socket.State != WebSocketState.Open) return false;
            byte[] bytes = Encoding.UTF8.GetBytes(msg);
            long t0 = Stopwatch.GetTimestamp();
            Interlocked.Exchange(ref sendStarted, t0);
            Task send = Socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, cts.Token);
            for (;;)
            {
                try { if (send.Wait(1000)) break; } catch (AggregateException) { break; }   // done; a failure is thrown below as itself
                if (cts.IsCancellationRequested) throw new OperationCanceledException(cts.Token);
            }
            send.GetAwaiter().GetResult();
            Interlocked.Exchange(ref sendStarted, 0);
            NoteSendTime(Stopwatch.GetTimestamp() - t0);
            return true;
        }

        // 0.4.0: a finished send's time, for /diag (this page's and all pages')
        private void NoteSendTime(long ticks)
        {
            double ms = ticks * 1000.0 / Stopwatch.Frequency;
            SendMs.Add(ms);
            ChartBridgeHealth.SendMsAll.Add(ms);
        }

        private bool SendOrderLane()
        {
            string msg;
            while (orderLane.TryDequeue(out msg))
            {
                Interlocked.Decrement(ref orderLaneCount);
                if (!SendText(msg)) return false;
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

        // 0.4.0: synchronous, on its own thread (RunClient starts it LongRunning, as the gate worker): it blocks on the outbox
        // and on each send, so a page never holds a thread-pool thread (an await here would hand the loop back to the pool).
        // The order is as before: the order lane goes first before every data entry and between the released trades.
        public void SendLoop()
        {
            loopStarted = true;
            ChartBridgeHealth.LoopStarted();
            try
            {
                foreach (object item in outbox.GetConsumingEnumerable(cts.Token))
                {
                    if (!SendOrderLane()) return;
                    if (item == Wake) continue;
                    Stamp ignored; queuedAt.TryDequeue(out ignored);   // this entry no longer waits
                    string[] batch = item as string[];
                    if (batch == null)
                    {
                        string one = (string)item;
                        bool bulk = Bulk(one);
                        long t0 = Stopwatch.GetTimestamp();
                        if (!SendText(one)) return;
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
                        if (!SendOrderLane()) return;
                        long t0 = Stopwatch.GetTimestamp();
                        if (!SendText(msg)) return;
                        Interlocked.Add(ref bulkSpent, Stopwatch.GetTimestamp() - t0);
                    }
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                // Review 3 N1: a send that failed ends the page's stream; close it so the page reconnects instead of waiting.
                ChartBridgeHealth.SendError();
                ChartBridgeServer.Log("Client " + Id + " send stopped: " + ex.Message + "; closing it.");
            }
            finally { Close(); ChartBridgeHealth.LoopEnded(); }   // every way out (review 5 N6: also when the socket is no longer open); Close is idempotent
        }

        public string DiagJson()
        {
            return "{\"id\":" + Id + ",\"root\":" + CbJson.Str(Root) + ",\"ready\":" + (Ready ? "true" : "false") +
                ",\"queued\":" + Queued + ",\"orderLaneQueued\":" + OrderLaneQueued + ",\"oldestDataMs\":" + CbJson.Num3(DataAgeMs()) +
                ",\"sendMs\":" + SendMs.Json() + "}";   // 0.4.0: median, p95 (bucket upper edges) and longest send
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
                ",\"setAside\":" + Interlocked.Read(ref setAside) + ",\"rejectedByDesk\":" + Interlocked.Read(ref rejectedByDesk) + ",\"rejectedFile\":\"rejected_fills.jsonl\"}";
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
                    NoteRejected(text, batch);   // 0.6.10 (C-B): each one The Desk rejected inside its 200, kept before the batch goes
                    Remove(batch);
                    if (batch.Length > 1) batchSize = FullBatch;   // while hunting a bad fill, stay at one per request
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

        // The Desk answers 200 with a "rejected" list for fills it could not store: say so once per answer. 0.6.10 (Anthony 2026-10-30,
        // C-B): each rejected fill is also appended to rejected_fills.jsonl with The Desk's reason, as the 400/422 path keeps a bad one, so
        // none is dropped unseen; /diag desk.rejectedByDesk counts them and desk.rejectedFile names the file.
        private static void NoteRejected(string text, string[] batch)
        {
            Match m = RejectedRx.Match(text ?? "");
            if (!m.Success || m.Groups[1].Value.Trim().Length == 0) return;
            int n = Regex.Matches(m.Groups[1].Value, "\"index\"").Count;
            if (n == 0) return;
            Interlocked.Add(ref rejectedByDesk, n);
            Match why = ReasonRx.Match(m.Groups[1].Value);
            int kept = KeepRejected(m.Groups[1].Value, batch, SetAsideFile);
            ChartBridgeServer.Log("The Desk could not store " + n + " fill(s)" + (why.Success ? ", for example: " + why.Groups[1].Value : "") + "; " + kept + " kept in rejected_fills.jsonl with its reason");
        }

        private static readonly Regex RejectedItemRx = new Regex("\\{(?:[^{}\"]|\"(?:[^\"\\\\]|\\\\.)*\")*\\}");
        private static readonly Regex IndexRx = new Regex("\"index\"\\s*:\\s*([0-9]+)");
        // 0.6.10 (C-B): each item of The Desk's "rejected" list ({index, reason, ...}) whose index names an item of the batch sent: that
        // item, as it was sent, with "desk_reason" (The Desk's words) put first, one line each in file. Returns how many were kept.
        internal static int KeepRejected(string rejectedList, string[] batch, string file)
        {
            List<string> lines = new List<string>();
            foreach (Match item in RejectedItemRx.Matches(rejectedList ?? ""))
            {
                Match ix = IndexRx.Match(item.Value);
                int i;
                if (!ix.Success || !int.TryParse(ix.Groups[1].Value, out i) || i < 0 || i >= batch.Length) continue;
                string sent = batch[i] ?? "";
                if (!sent.StartsWith("{")) continue;
                Match why = ReasonRx.Match(item.Value);
                string reason = why.Success ? Regex.Unescape(why.Groups[1].Value) : "no reason given";
                lines.Add("{\"desk_reason\":" + CbJson.Str(reason) + (sent.Length > 2 ? "," + sent.Substring(1) : "}"));
            }
            if (lines.Count == 0) return 0;
            try { File.AppendAllLines(file, lines); }
            catch (Exception ex) { ChartBridgeServer.Log("could not keep the rejected items in " + Path.GetFileName(file) + ": " + ex.Message); return 0; }
            return lines.Count;
        }
    }

    // ------------------------------------------------------------------ the server
    public static class ChartBridgeServer
    {
        public const string Version = "0.6.10";   // 0.6.10: the account lifecycle (Anthony 2026-10-30): remove-only changes for an account NinjaTrader no longer lists (leave its group, a copier follower off then removed, Hide with no stale hold), Hide takes a member out of its group in the same step, a member not in NinjaTrader no longer blocks an agent's group, a group preview sizes only the members gate 2 lets trade, the accounts message's notListed; 0.6.9: the stats suite's Phase 2 (recording only): 1 second bars to The Desk, the order record (every order type, POST /api/order-events), a decision id on a group entry's orders and fills; 0.6.8: the minute book (minute and tick charts' history up to now from every live trade ChartBridge saw), a hole recorded in /diag and history.log (never shown), 20 s limits on a load's minute history and last trades; 0.6.7: the bench (memberBench), no hedging always on, a group's own rules optional and never sizing a member
        private static readonly object Gate = new object();
        private static HttpListener listener;
        private static CancellationTokenSource cts;
        private static readonly ConcurrentDictionary<int, ChartBridgeClient> Clients = new ConcurrentDictionary<int, ChartBridgeClient>();
        private static int nextId;
        private static readonly Dictionary<string, Instrument> Instruments = new Dictionary<string, Instrument>();
        private static readonly List<MarketData> Feeds = new List<MarketData>();
        private static readonly HashSet<Account> Watched = new HashSet<Account>();
        private static readonly HashSet<string> Replayed = new HashSet<string>();   // 0.5.0 agents: accounts whose executions were read once since the watch began
        private static System.Threading.Timer accountTimer, pollTimer;
        private static readonly Regex TypeRx = new Regex("\"type\"\\s*:\\s*\"(\\w+)\"");
        private static readonly Regex RootRx = new Regex("\"root\"\\s*:\\s*\"(\\w+)\"");
        private static readonly Regex DaysRx = new Regex("\"days\"\\s*:\\s*(\\d+)");
        private static readonly Regex TickHoursRx = new Regex("\"tickHours\"\\s*:\\s*(\\d+)");
        private static readonly Regex PingRx = new Regex("\"c\"\\s*:\\s*([0-9.]+)");
        private static readonly Regex SubRx = new Regex("\"sub\"\\s*:\\s*(\\d{1,15})(?!\\d)");   // the page's subscribe id (0.3.3), echoed back
        private static readonly Regex LiveFirstRx = new Regex("\"liveFirst\"\\s*:\\s*(true|1)(?![\\w.])");   // 0.3.5: a tick chart gets the served window
        private static readonly Regex ProfileRx = new Regex("\"profile\"\\s*:\\s*(true|1)(?![\\w.])");       // 0.3.5: the page wants "profile" messages

        // 0.5.6: a message for every page (the time check's result, ChartBridgeClock)
        public static void ToEveryPage(string json) { foreach (ChartBridgeClient c in Clients.Values) c.Send(json); }

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
                    ChartBridgeFiles.ClearNotes();   // 0.6.3: this run's file notes only
                    ChartBridgeConfig.Load();
                    Directory.CreateDirectory(ChartBridgeConfig.WwwFolder);
                    cts = new CancellationTokenSource();
                    StartGate();   // review 6 S1: tick requests may go out again
                    lock (Books) Books.Clear();   // lf7 N1: nothing a load answered after the last stop left behind (a book waiting on a dropped request)
                    ResolveInstruments();
                    ChartBridgeOrders.NewToken();
                    ChartBridgeOrders.StartPlans();   // 0.3.7: planned_brackets.txt, read on a pool thread before the accounts are watched
                    ChartBridgeAccounts.Start();      // 0.4.0 accounts: accounts.txt (the checkmarks) read before the accounts are watched; the 1 s Gone check
                    ChartBridgeBot.Start();           // 0.4.0 bot: its secret, rails and day, before the accounts are watched (off: nothing)
                    ChartBridgeAgents.Start();        // 0.5.0 agents: each agent's secret, rules, account and day, before the accounts are watched (none: nothing)
                    Log(ChartBridgeOrders.Enabled
                        ? "order entry is ON for " + ChartBridgeOrders.TradeAccounts.Count + " account(s): " + string.Join(", ", ChartBridgeOrders.TradeAccounts)
                        : "order entry is off (read only)");
                    Log(ChartBridgePin.IsSet ? "ChartBridge's page is locked with a PIN (pin.txt)" : "no PIN is set yet: ChartBridge's page asks for one before it shows anything");
                    LoadSettlementsSoon();  // 0.3.7: the prior settlement known before this start (settlements.txt), read off this thread
                    SubscribeMarketData();
                    WatchFeed();   // 0.3.5 S2
                    if (ChartBridgeConfig.PostFills) ChartBridgeDesk.Load();
                    ChartBridgeStops.Clear();
                    if (ChartBridgeStops.On) ChartBridgeStops.Load();   // 0.6.6: the stop record's queue
                    ChartBridgeOrderRecord.Clear();
                    if (ChartBridgeOrderRecord.On) ChartBridgeOrderRecord.Load();   // 0.6.9: the order record's queue
                    ChartBridgeDecisions.Load();   // 0.6.9: the group entries' decision ids (decisions.txt), before the accounts are watched
                    WatchAccounts();
                    ChartBridgeOrders.WatchConnections();
                    try { ChartBridgeOrders.Resume(); } catch (Exception ex) { Log("bracket resume error: " + ex.Message); }   // entries that filled while stopped
                    accountTimer = new System.Threading.Timer(delegate { try { WatchAccounts(); } catch (Exception) { } try { ChartBridgeDesk.Flush(); } catch (Exception) { } try { ChartBridgeStops.Flush(); } catch (Exception) { } try { ChartBridgeOrderRecord.Flush(); } catch (Exception) { } try { ChartBridgeDecisions.SaveIfDirty(); } catch (Exception) { } try { SweepBooks(); } catch (Exception) { } }, null, 10000, 10000);
                    htfTimer = new System.Threading.Timer(delegate { try { HtfPush(); HtfExpire(); } catch (Exception ex) { Log("higher-timeframe push error: " + ex.Message); } try { SettlementTick(); } catch (Exception ex) { Log("settlement error: " + ex.Message); } }, null, HtfPushMs, HtfPushMs);   // 0.3.7
                    pollTimer = new System.Threading.Timer(delegate { try { PollExecutions(); } catch (Exception) { } try { ChartBridgeOrders.CheckLegs(); } catch (Exception ex) { Log("legs check error: " + ex.Message); } try { ChartBridgeBranches.Poll(); } catch (Exception ex) { Log("daily reset error: " + ex.Message); } }, null, 2000, 2000);   // 0.5.7: the 17:00 ET reset to None
                    listener = new HttpListener();
                    listener.Prefixes.Add("http://localhost:" + ChartBridgeConfig.Port + "/");
                    StartListening(cts.Token, 0);
                    ChartBridgeBars.Start();   // daily bars to The Desk, when bars = on (its own low-priority thread)
                    ChartBridgeCopier.Start();   // 0.4.0 copier: when copier = on (its own thread and 1 s timer); starts stood down
                    try { ChartBridgeBranches.Poll(); } catch (Exception ex) { Log("daily reset error: " + ex.Message); }   // 0.6.3 (audit C1): a 17:00 ET reset missed while off runs now, once every branch is loaded
                    ChartBridgeClock.Start();    // 0.5.6: this PC's clock against a time server, every 5 minutes on its own thread (measures only)
                    return true;
                }
                catch (Exception ex)
                {
                    Log("could not start: " + ex.Message);
                    try { if (accountTimer != null) accountTimer.Dispose(); } catch (Exception) { }
                    try { if (pollTimer != null) pollTimer.Dispose(); } catch (Exception) { }
                    try { if (htfTimer != null) htfTimer.Dispose(); } catch (Exception) { }
                    accountTimer = null; pollTimer = null; htfTimer = null;
                    ChartBridgeAccounts.Stop();   // 0.4.0 accounts
                    ChartBridgeCopier.Stop();   // 0.4.0 copier:
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
                cts = null;   // 0.6.8: a load started after this stop (none in NinjaTrader; the harness) is not taken for the stopped run's
                ChartBridgeBot.Stop();   // 0.4.0 bot
                ChartBridgeAgents.Stop();   // 0.5.0 agents
                ChartBridgeBars.Stop();
                ChartBridgeCopier.Stop();   // 0.4.0 copier:
                ChartBridgeClock.Stop();    // 0.5.6: the time check
                try { if (accountTimer != null) accountTimer.Dispose(); } catch (Exception) { }
                accountTimer = null;
                try { if (pollTimer != null) pollTimer.Dispose(); } catch (Exception) { }
                pollTimer = null;
                try { if (htfTimer != null) htfTimer.Dispose(); } catch (Exception) { }
                htfTimer = null;
                foreach (ChartBridgeClient c in Clients.Values) c.Close();
                Clients.Clear();
                foreach (MarketData md in Feeds) { try { md.Update -= OnMarketData; } catch (Exception) { } }
                Feeds.Clear();
                StopGate(250);   // nothing carries over to the next start (review 3 N-9); the worker ends, the retries' timers go (review 5 N6); a short wait on NinjaTrader's thread (review 6 S2)
                lock (Books) Books.Clear();
                ChartBridgeTape.Reset();                   // 0.4.0: the tape counters start over with the next start
                HtfReset();                                // 0.3.7: nothing kept; a start asks again
                lock (WeekCache) WeekCache.Clear();
                lock (Settlements) Settlements.Clear();
                ChartBridgeAccounts.Stop();   // 0.4.0 accounts
                Unwatch();
                try { ChartBridgeStops.SaveIfDirty(); } catch (Exception) { }   // 0.6.6: after Unwatch (no order event can add one now): the stop events the 10 s timer has not saved
                try { ChartBridgeOrderRecord.SaveNow(); } catch (Exception) { }   // 0.6.9: the same for the order record's events
                try { ChartBridgeDecisions.SaveIfDirty(); } catch (Exception) { }   // 0.6.9: and the decision ids
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
                if (path == "/bot" || path == "/bot-library") { await ChartBridgeBot.Serve(ctx, path, token); return; }   // 0.4.0 bot: off = 404 (ChartBridgeBot.cs)
                if (path == "/agent" || path.StartsWith("/agent/", StringComparison.Ordinal)) { await ChartBridgeAgents.Serve(ctx, path, token); return; }   // 0.5.0 agents: an id not in agents = 404 (ChartBridgeAgents.cs)
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
            ChartBridgeHealth.Connected();   // 0.4.0: /diag health.pages
            // SendLoop blocks on its queue: never run it inline (0.1.0 deadlock). 0.4.0: on its own thread, not a pool thread per page
            Task sending = Task.Factory.StartNew(() => client.SendLoop(), CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            Dictionary<string, string> seen = new Dictionary<string, string>();
            int clockSeen = ChartBridgeClock.Changes;
            client.Send(HelloJsonFor(seen));
            SettlementAfterHello(client, seen);   // 0.3.7: hello ends up right even if settlements.txt was read (or a value came) while it was built
            if (ChartBridgeClock.Changes != clockSeen) client.Send(ChartBridgeClock.MessageJson());   // 0.5.6: the same for a time check that ended meanwhile
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
                ChartBridgeHealth.Closed();
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
                          LiveFirstRx.IsMatch(text), ProfileRx.IsMatch(text), false);
            }
            else if (type == "htf") OnHtfMessage(client, text);                 // 0.3.7: 4h, 1D, 1W bars (strict)
            else if (type == "weekProfile") OnWeekProfileMessage(client, text); // 0.3.7: the last 5 sessions' volume at price (strict)
            else if (type == "auth" || type == "order" || type == "change" || type == "plan" || type == "cancel" || type == "flatten" || type == "groupPreview" || type == "groupOrder")   // 0.6.5: groupPreview, groupOrder
                ChartBridgeOrders.OnMessage(client, type, text);   // every order path and its gates live in ChartBridgeOrders.cs
            else if (ChartBridgeGroups.Handles(type)) ChartBridgeGroups.OnMessage(client, type, text);   // 0.5.8: groupSave, groupDelete, accountGroup, accountLimits (ChartBridgeGroups.cs; no order calls); 0.6.7: memberBench
            else if (type == "client" || type == "accountTrade" || type == "accountArchive" || type == "accountUnarchive")
                ChartBridgeAccounts.OnMessage(client, type, text);   // 0.4.0 accounts: v3 page, the checkmark and Archive (ChartBridgeAccounts.cs; no order calls)
            else if (type == "merge") ChartBridgeOrders.OnMessage(client, type, text);   // 0.4.0 B4: Merge stops and targets (ChartBridgeMerge.cs)
            else if (type.StartsWith("copier", StringComparison.Ordinal)) ChartBridgeCopier.OnMessage(client, type, text);   // 0.4.0 copier: copier*
            else if (type.StartsWith("bot", StringComparison.Ordinal)) ChartBridgeBot.OnPageMessage(client, type, text);   // 0.4.0 bot: botMode, botKill, botSeen, botAnswer, botRails
            else if (type.StartsWith("agent", StringComparison.Ordinal)) ChartBridgeAgents.OnPageMessage(client, type, text);   // 0.5.0 agents: agentMode, agentKill, agentSeen, agentAnswer, agentAccount, agentRules
        }

        // The order code's lookups (0.4.0): a root that may be traded from the chart and its contract. A quote-only root
        // (quoteRoots) is never one: null, as for a root not served, so no order path can reach its contract.
        public static Instrument InstrumentFor(string root)
        {
            if (ChartBridgeConfig.QuoteOnly(root)) return null;
            return ServedInstrumentFor(root);
        }

        // The root ChartBridge serves for this exact contract, or null (other contracts are not ours; 0.4.0: nor a quote-only one).
        public static string RootFor(Instrument inst)
        {
            if (inst == null) return null;
            foreach (KeyValuePair<string, Instrument> kv in Instruments) if (kv.Value == inst || kv.Value.FullName == inst.FullName) return ChartBridgeConfig.QuoteOnly(kv.Key) ? null : kv.Key;
            return null;
        }

        // 0.4.0: every served root's contract, the quote-only ones too (market data, settlement, higher-timeframe bars, profiles).
        public static Instrument ServedInstrumentFor(string root)
        {
            Instrument inst;
            return root != null && Instruments.TryGetValue(root, out inst) ? inst : null;
        }

        public static ICollection<ChartBridgeClient> AllClients() { return Clients.Values; }   // 0.4.0 accounts: ChartBridgeAccounts.cs sends per page

        public static void SendToTraders(string json)
        {
            foreach (ChartBridgeClient c in Clients.Values) if (c.Trader) c.Send(json);
        }

        // ---------------------------------------------------------- instruments and front month
        private static void ResolveInstruments()
        {
            Instruments.Clear();
            ChartBridgeMarkets.ClearHow();
            foreach (string root in ChartBridgeConfig.Roots)
            {
                if (ChartBridgeConfig.QuoteOnly(root)) { Log(root + " is in roots and in quoteRoots: served quote only, orders for it are refused (take it out of quoteRoots to trade it)"); continue; }
                string name;
                if (!ChartBridgeConfig.ContractOverride.TryGetValue(root, out name)) name = root + " " + ChartBridgeMarkets.FrontMonth(root, ChartBridgeTime.NowEastern());   // 0.4.0: the root's own roll (the index rule for MNQ, NQ, MES, ES, as before)
                Instrument inst = Instrument.GetInstrument(name);
                if (inst == null) { Log("instrument not found: " + name + " (set contract." + root + " in config.txt)"); continue; }
                Instruments[root] = inst;
                Log(root + " -> " + inst.FullName);
            }
            ResolveQuoteRoots(ChartBridgeTime.NowEastern(), n => Instrument.GetInstrument(n));   // a lambda: NinjaTrader 8.1's GetInstrument has an optional second parameter, so the method group does not convert (0.4.1)
        }

        // 0.4.0: the quote-only markets (quoteRoots), after the traded roots; each on its own roll (ChartBridgeMarkets.Resolve).
        public static void ResolveQuoteRoots(DateTime nowEt, Func<string, Instrument> get)
        {
            List<string> done = new List<string>();
            foreach (string root in ChartBridgeConfig.QuoteRoots)
            {
                if (done.Contains(root)) continue;
                done.Add(root);
                string name, how;
                Instrument inst = null;
                try { inst = ChartBridgeMarkets.Resolve(root, nowEt, get, out name, out how); }
                catch (Exception ex) { name = root; how = null; Log("quote-only market " + root + " not resolved: " + ex.Message); }
                if (inst == null) { Log("instrument not found: " + name + " (quote only; set contract." + root + " in config.txt, or take it out of quoteRoots)"); continue; }
                Instruments[root] = inst;
                ChartBridgeMarkets.NoteHow(root, how);
                Log(root + " -> " + inst.FullName + " (quote only, orders refused; " + how + ")");
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

        private static string HelloJson() { return HelloJsonFor(null); }
        // seen: each root's settlement fields as hello gave them (for SettlementAfterHello).
        private static string HelloJsonFor(Dictionary<string, string> seen)
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
                 .Append(",\"tick\":").Append(CbJson.Num(ChartBridgeMarkets.TickOf(kv.Key, kv.Value)))   // NinjaTrader's tick size (0.4.0: the table's only when it gives none)
                 .Append(",\"pointValue\":").Append(CbJson.Num(kv.Value.MasterInstrument.PointValue))
                 .Append(",\"quoteOnly\":").Append(ChartBridgeConfig.QuoteOnly(kv.Key) ? "true" : "false")   // 0.4.0: served for the Quote board, orders refused
                 .Append(",\"priceFormat\":").Append(CbJson.Str(ChartBridgeMarkets.FormatOf(kv.Key)))       // 0.4.0: "decimal", or "32nds" (ZN, ZB)
                 .Append(SettlementHelloFields(kv.Key, seen)).Append('}');   // 0.3.7: the prior settlement (null when none) and the day it settles
            }
            b.Append("],\"accounts\":[");
            first = true;
            lock (Watched)
            {
                foreach (Account a in Watched) { if (!first) b.Append(','); first = false; b.Append(CbJson.Str(a.Name)); }
            }
            b.Append("],\"trading\":").Append(ChartBridgeOrders.TradingJson(false, null));
            b.Append(",\"pcClock\":").Append(ChartBridgeClock.Json());   // 0.5.6: this PC's clock against a time server (ChartBridgeClock)
            b.Append(",\"features\":[\"liveFirst\",\"profile\",\"settlement\",\"htf\",\"weekProfile\",\"v3\"]}");   // 0.4.0 accounts: "v3", this ChartBridge speaks protocol v3   // 0.3.5: the served window, the session's volume at price; 0.3.7: settlement, higher-timeframe bars, the weekly profile
            return b.ToString();
        }

        // ---------------------------------------------------------- live market data
        private static void SubscribeMarketData()
        {
            long nowTicks = ChartBridgeTime.ToUtc(NowNt()).Ticks;
            Interlocked.Exchange(ref listeningSinceUtcTicks, nowTicks);   // 0.3.5: a session that starts after this is whole
            Interlocked.Exchange(ref feedUpSinceUtcTicks, nowTicks); Interlocked.Exchange(ref feedDown, 0); Interlocked.Exchange(ref firstTradeUtcTicks, 0);
            foreach (KeyValuePair<string, Instrument> kv in Instruments)
            {
                MarketData md = new MarketData(kv.Value);
                md.Update += OnMarketData;
                Feeds.Add(md);
                // 0.3.7: the settlement NinjaTrader already has (its help: snapshot data is there right on subscription); later
                // ones come as Settlement events (OnMarketData). 0.4.0: through the same one queue as those, in order, off this thread
                try { MarketDataEventArgs st = md.Settlement; if (st != null) QueueSettlement(kv.Key, kv.Value.FullName, st.Price, st.Time, "snapshot"); }
                catch (Exception ex) { Log("settlement snapshot not read for " + kv.Key + ": " + ex.Message); }
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

        // 0.6.9 (the order record, ChartBridgeOrderRecord.cs): the bid, ask and last price ChartBridge knows now for this exact contract,
        // from the live data it already follows (no request, nothing estimated). Each one NaN when not known, and then the reason why
        // (null when all three are known). A quote or a last price older than QuoteFreshMs is not known (stale). Cheap: three short locks.
        public static int QuoteFreshMs = 60000;
        public static string QuoteNow(Instrument inst, out double bid, out double ask, out double last)
        {
            bid = double.NaN; ask = double.NaN; last = double.NaN;
            if (inst == null) return "no instrument";
            string root = RootFor(inst);
            if (root == null) return "ChartBridge has no live data for " + (inst.FullName ?? "?") + " (it serves another contract or not this root)";
            List<string> why = new List<string>();
            LiveSideTagger t;
            lock (LiveSides) LiveSides.TryGetValue(root, out t);
            if (t == null) why.Add("no bid or ask seen yet for " + root);
            else
            {
                double b, a; DateTime bt, at;
                t.LatestQuote(out b, out bt, out a, out at);
                DateTime now = NowNt();
                if (double.IsNaN(b) || !(b > 0)) why.Add("no bid seen yet");
                else if ((now - bt).TotalMilliseconds > QuoteFreshMs) why.Add("the bid is stale (" + Math.Round((now - bt).TotalSeconds) + " s old)");
                else bid = b;
                if (double.IsNaN(a) || !(a > 0)) why.Add("no ask seen yet");
                else if ((now - at).TotalMilliseconds > QuoteFreshMs) why.Add("the ask is stale (" + Math.Round((now - at).TotalSeconds) + " s old)");
                else ask = a;
            }
            double p, ageMs;
            if (!ChartBridgeOrders.LastKnown(root, out p, out ageMs)) why.Add("no trade seen yet for " + root);
            else if (ageMs > QuoteFreshMs) why.Add("the last price is stale (" + Math.Round(ageMs / 1000) + " s old)");
            else last = p;
            return why.Count == 0 ? null : string.Join("; ", why);
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
            if (type == MarketDataType.Settlement)
            {
                // 0.3.7: NinjaTrader's settlement for the contract (a reset is never one: handled above). Rare: off this thread,
                // one at a time in the order they came (0.3.8: one queue; a task each could take them out of order).
                QueueSettlement(RootOf(e.Instrument), e.Instrument != null ? e.Instrument.FullName : null, e.Price, e.Time, "update");
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
                int method, cat;
                int side = SideTagger(root).Tag(e.Price, e.Time, e.Bid, e.Ask, out method, out cat);
                double t = ChartBridgeTime.EtSeconds(utc);
                string json = "{\"type\":\"tick\",\"root\":" + CbJson.Str(root) +
                    ",\"t\":" + CbJson.Num3(t) +
                    ",\"u\":" + CbJson.Num3(ChartBridgeTime.UtcMs(utc)) +
                    ",\"rx\":" + CbJson.Num3(rx) +
                    ",\"p\":" + CbJson.Num(e.Price) + ",\"v\":" + e.Volume.ToString(CultureInfo.InvariantCulture) +
                    ",\"s\":" + side.ToString(CultureInfo.InvariantCulture) + ",\"sm\":" + method.ToString(CultureInfo.InvariantCulture) + ChartBridgeSides.QJson(cat) + "}";   // 0.3.4: side and method; 0.3.8: q
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
                        new DateTime(Interlocked.Read(ref feedUpSinceUtcTicks), DateTimeKind.Utc), rx, nowNt, profileRoot, ChartBridgeSides.QCode(cat));
                    // 0.6.8: the minute book takes the trade (its first trade after a start or a reset sets From, the only time
                    // the clock is read here)
                    MinuteBook mb = book.Minutes;
                    if (mb.From < 0) mb.Begin(e.Time, NowNt());
                    mb.Add(e.Time, e.Price, e.Volume);
                    wantBackfill = book.BackfillState == "wanted";
                    if (wantBackfill) book.BackfillState = "queued";
                    lastChanged = book.LastChanged;
                    capGen = book.CapGen; book.CapGen = -1;
                    foreach (ChartBridgeClient c in Clients.Values.Concat(ChartBridgeAgents.Subscribed()))   // 0.5.0 agents: an agent's subscribe is a page's
                    {
                        if (c.Root != root) continue;
                        if (c.Ready) c.Send(json);
                        else lock (c.Pending)
                        {
                            if (c.Ready) c.Send(json);
                            else c.Pending.Add(new SeamTick { Time = e.Time, Price = e.Price, Volume = e.Volume, Json = json, Side = side, Method = method, QCode = ChartBridgeSides.QCode(cat) });   // NinjaTrader's time, as the backfill's
                        }
                    }
                }
                // 0.4.0: tape timing counters (/diag "tape"), after the trade went out, on their own: never stop a trade (ChartBridgeTape.cs)
                try { ChartBridgeTape.OnPrint(root, book.Tick, ChartBridgeTime.UtcMs(utc), rx, t, e.Price); }
                catch (Exception tx) { ChartBridgeTape.Failed(tx); }
                HtfOnTrade(root, e.Time, t, e.Price, e.Volume);   // 0.3.7: the forming 4h, 1D and 1W bars, from this trade (no request)
                ChartBridgeBot.OnTick(json);   // 0.4.0 bot: every live trade to the bot (one read when none is connected)
                ChartBridgeAgents.OnTick(root, json);   // 0.5.0 agents: every live trade to each agent (its subscribed root came through the seam above)
                if (wantBackfill) QueueBackfill(book, e.Instrument, false);
                if (capGen >= 0) Task.Run(() => WindowFailed(book, capGen, "over " + RootBook.LiveCap + " live trades came while it waited", false));   // B2
                if (lastChanged) SaveLast(book);
            }
            catch (Exception ex) { CbLogLimit.Error("tick error", ex); }   // 0.4.0: at most a line a minute, with a count (a fault on every trade used to flood the Output window)
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
        // 0.6.8: a load's minute history and last-trades requests each wait at most this long for NinjaTrader (WORK 2026-10-23:
        // the League chart sat on LOADING for 50 s and more); then the load goes ready with what ChartBridge has and says so. A
        // request given up is not asked again for the instrument until NinjaTrader answers it or OverdueReaskMs has passed.
        public static int MinuteTimeoutMs = 20000, TailTimeoutMs = 20000, OverdueReaskMs = 120000, MinuteRecheckMs = 3000;

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
            public int TailRebuilt = -1;             // minute bars rebuilt from ticks; -1 when there was no tail
            public long NtTailVolume = -1, RebuiltTailVolume = -1;   // that minute's volume, NinjaTrader's and rebuilt
            public int HeldAtAnswer = -1;            // trades held when NinjaTrader answered the tick request
            public string Sub;                       // the subscribe id on history, ticks and ready: the page's, or Seq
            public string SubJson { get { return ",\"sub\":" + Sub; } }
            // 0.3.5: a tick chart's served window (every subscribe with tickHours above 0), and the page's wish for "profile" messages.
            public bool Window, Profile, FromCache;
            public string WindowAsked = "";          // the counts asked of NinjaTrader, for /diag ("200000, 600000")
            public WindowDiag Diag;
            // 0.6.8: the minute book as it was when the held trades were cleared (minute and hour charts), what the load did
            // with it, and the requests' time limits (MinuteState and TailState: 0 waiting, 1 answered, 2 given up).
            public MinuteSnap Book;
            public int MinuteState, TailState, ReadyOnce;
            public int Filled = -1, ShortMinutes;    // bars from the book (-1: not used); closed minutes NinjaTrader had more volume for
            public DateTime? NtLastBar, LastBarClose, FirstBarClose; // NinjaTrader's last minute bar (its close stamp); the last and first bars sent
            public bool MinuteTimedOut, TailTimedOut;
            public bool Agent;                       // review of 0.6.8: an agent's subscribe (it places real orders): no time limit, full history only
            public bool StoodIn;                     // went ready on stand-in history (the book, NinjaTrader's kept answers): told when the real one comes
            public bool MinuteFailed;                // NinjaTrader answered the minute request with an error
            public bool FromKept;                    // re-review B: answered from NinjaTrader's fresh kept answer (no request)
            public DateTime AnsweredNt = DateTime.MaxValue;   // NinjaTrader's clock when its minute answer came
            public int LateSent;                     // "historyLate" sent (once)
            public int WaitNoted;                    // re-review C: the first time limit passed with nothing to stand in
            public DateTime HistoryFrom;             // the minute request's start (kept answers are cut to it)
            public CancellationToken Stop;           // ChartBridge's run: a timer or a late answer after a stop does nothing
            public int TailKeptAfter;                // rebuilt minutes kept after NinjaTrader's bar when the tail itself was not rebuilt
            public string Hole;                      // the "no bars from ... to ..." text, when the history ends too early
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

        private static void Subscribe(ChartBridgeClient client, string root, int days, int tickHours) { StartLoad(client, root, days, tickHours, null, false, false, false); }

        // 0.5.0 agents: an agent's subscribe, answered as a page's (history, ticks, ready, then live tick for that root).
        // 0.6.8 (review): an agent waits for NinjaTrader's full history as in 0.6.7: no time limits, no stand-in history.
        public static void AgentSubscribe(ChartBridgeClient client, string root, int days, int tickHours, string sub) { StartLoad(client, root, days, tickHours, sub, false, false, true); }

        // sub: the page's subscribe id (digits), or null to number the loads here. window (0.3.5, subscribe "liveFirst"): ignored
        // since 0.3.5, every tick chart gets the served window. profile (0.3.5): the page wants "profile" messages.
        private static void StartLoad(ChartBridgeClient client, string root, int days, int tickHours, string sub, bool window, bool profile, bool agent)
        {
            Instrument inst;
            if (!Instruments.TryGetValue(root, out inst))
            {
                client.SendData("{\"type\":\"status\",\"level\":\"error\",\"text\":" + CbJson.Str("No instrument for " + root + ". Check the NinjaScript Output window.") + "}");
                return;
            }
            Load L = new Load { Client = client, Root = root, Name = inst.FullName, TickHours = tickHours, Inst = inst, Window = tickHours > 0, Profile = profile, Agent = agent };   // S6: every tick chart gets the served window (0.3.7: the by-date load is gone)
            CancellationTokenSource run = cts;
            L.Stop = run != null ? run.Token : CancellationToken.None;
            RootBook book = BookOf(root, inst);
            // 0.6.8: the book's lock, then the page's Pending lock (the order OnMarketData takes them in, and MarkReady and
            // ServeFromCache): the minute book is copied at the very moment the held trades are cleared, so every trade before it
            // is in the copy and every trade after it is held. None is in both, none in neither.
            lock (book.Sync)
            lock (client.Pending)   // from here every live trade for this root is held until MarkReady
            {
                L.Seq = ++client.SubscribeSeq;
                L.Sub = sub ?? L.Seq.ToString(CultureInfo.InvariantCulture);
                client.Ready = false;
                client.Pending.Clear();
                client.Root = root;
                client.WantsProfile = profile;
                L.Book = book.Minutes.Snap();   // every load (0.6.8: tick charts too, for their minute history)
            }
            L.NowNt = NowNt();
            L.StartedMs = ChartBridgeTime.NowUtcMs();
            if (L.Window)
            {
                L.Diag = new WindowDiag { Client = client.Id, Root = root, Sub = L.Sub, AtUtcMs = L.StartedMs };
                lock (Windows) { Windows.Add(L.Diag); if (Windows.Count > 20) Windows.RemoveAt(0); }
            }

            // 0.6.8: an earlier minute history request for this instrument given up and still unanswered: not asked again (no
            // pile of requests on a NinjaTrader that is not answering) when there is history to stand in for it; else asked.
            L.HistoryFrom = L.NowNt.AddDays(-days - (days >= 5 ? 3 : 1));
            // re-review B: NinjaTrader's kept answer, fresh (kept within OverdueReaskMs) and reaching back to this load's start, joined
            // to the book, is this load's answer: NinjaTrader is not asked (a reload right after one, or after historyLate, does not
            // ask NinjaTrader again or wait on it). Not for an agent (it asks NinjaTrader).
            if (!L.Agent && FromKept(L, book)) return;
            bool overdue;
            lock (book.Sync) overdue = book.MinuteOverdueMs >= 0 && L.StartedMs - book.MinuteOverdueMs < OverdueReaskMs;
            if (overdue && KeptCovers(L, book))   // third review D: only when the kept answers cover this load's days; else NinjaTrader is asked
            {
                L.MinuteState = 2; L.MinuteTimedOut = true;
                MinuteGivenUp(L, "minute history: NinjaTrader has not answered an earlier request yet, so it is not asked again for now");
                return;
            }
            BarsRequest minutes = new BarsRequest(inst, L.HistoryFrom, L.NowNt);
            minutes.BarsPeriod = new BarsPeriod { BarsPeriodType = BarsPeriodType.Minute, Value = 1 };
            minutes.TradingHours = inst.MasterInstrument.TradingHours;
            minutes.Request(new Action<BarsRequest, ErrorCode, string>((req, code, message) =>
            {
                if (Interlocked.CompareExchange(ref L.MinuteState, 1, 0) != 0)
                {
                    // answered after its time limit: not sent to this load, but kept for the next loads of the instrument
                    // (KeepNtMinutes), and the page whose load went ready on stand-in history is told to load again
                    RawBars late = null;
                    try { if (code == ErrorCode.NoError && !L.Stop.IsCancellationRequested) late = RawBars.Copy(req.Bars, false); } catch (Exception) { }
                    finally { try { req.Dispose(); } catch (Exception) { } }
                    if (L.Stop.IsCancellationRequested) return;   // review: a previous run's answer touches nothing
                    lock (book.Sync) book.MinuteOverdueMs = -1;
                    HistoryNote(root, "minute history: NinjaTrader answered after " + CbJson.Num3((ChartBridgeTime.NowUtcMs() - L.StartedMs) / 1000) + " s, when it was given up at " + (MinuteTimeoutMs / 1000) + " s; kept for the next load" + (late != null && late.Count > 0 ? " (last bar " + EtText(late.Time[late.Count - 1]) + ")" : ""));
                    DateTime lateAt = NowNt();
                    if (late != null) Task.Run(() => { KeepNtMinutes(book, late, L.HistoryFrom, lateAt); HistoryLate(L); });
                    return;
                }
                if (!L.Stop.IsCancellationRequested) lock (book.Sync) book.MinuteOverdueMs = -1;   // third review D: any answer frees the instrument
                L.AnsweredNt = NowNt();
                RawBars raw = null;
                try
                {
                    if (code != ErrorCode.NoError)
                    {
                        L.MinuteFailed = true;
                        if (Current(L)) client.SendData("{\"type\":\"status\",\"level\":\"warn\",\"text\":" + CbJson.Str("Minute history failed: " + code + " " + message) + "}");
                        HistoryNote(root, "Minute history failed: " + code + " " + message);   // 0.6.8: in /diag and history.log too
                    }
                    else if (Current(L)) raw = RawBars.Copy(req.Bars, false);     // quick copy on NinjaTrader's thread
                }
                catch (Exception ex) { CbLogLimit.Error("history error", ex); }   // 0.4.0: at most a line a minute
                finally { try { req.Dispose(); } catch (Exception) { } }
                MinutesAnswered(L, raw);
            }));
            if (!L.Agent) Task.Delay(MinuteTimeoutMs).ContinueWith(delegate { MinuteTimeout(L, book); }, TaskScheduler.Default);
        }

        // 0.6.8: the minute history's time limit. Given up only when there is history to stand in for it (NinjaTrader's kept
        // answers, or the minute book with a bar); with nothing (a cold start), the load keeps waiting for NinjaTrader as in 0.6.7
        // and the page says it waits. Never for an agent.
        private static void MinuteTimeout(Load L, RootBook book)
        {
            try
            {
                if (L.Stop.IsCancellationRequested || L.Agent || Volatile.Read(ref L.MinuteState) != 0 || !Current(L)) return;
                if (!CanStandIn(L, book))
                {
                    // re-review C: the instrument is marked overdue at the first limit (a reload with history to stand in does not ask
                    // again), and the load looks again every few seconds until the answer comes or something can stand in
                    if (Interlocked.Exchange(ref L.WaitNoted, 1) == 0)
                    {
                        lock (book.Sync) book.MinuteOverdueMs = ChartBridgeTime.NowUtcMs();
                        HistoryNote(L.Root, "minute history: no answer from NinjaTrader in " + (MinuteTimeoutMs / 1000) + " s and nothing to stand in for it; the load waits for NinjaTrader");
                    }
                    Task.Delay(MinuteRecheckMs).ContinueWith(delegate { MinuteTimeout(L, book); }, TaskScheduler.Default);
                    return;
                }
                if (Interlocked.CompareExchange(ref L.MinuteState, 2, 0) != 0) return;
                L.MinuteTimedOut = true;
                lock (book.Sync) book.MinuteOverdueMs = ChartBridgeTime.NowUtcMs();
                MinuteGivenUp(L, "minute history: no answer from NinjaTrader in " + (MinuteTimeoutMs / 1000) + " s");
            }
            catch (Exception ex) { CbLogLimit.Error("minute history timeout error", ex); }
        }
        private static bool FromKept(Load L, RootBook book)
        {
            double at; DateTime from;
            lock (book.Sync) { at = book.NtMinutesAtMs; from = book.NtMinutesFrom; }
            if (at < 0 || L.StartedMs - at >= OverdueReaskMs || from > L.HistoryFrom || L.Book == null) return false;
            RawBars mine = ClosedKept(book, L.HistoryFrom);   // third review E: never its last bar if it was still forming
            if (mine == null || mine.Count == 0) return false;
            long cut; int filled, shortMinutes;
            if (L.Book.Join(mine, out cut, out filled, out shortMinutes) == null) return false;   // the book must reach back to it: no hole
            L.MinuteState = 1; L.FromKept = true;
            HistoryNote(L.Root, "minute history from NinjaTrader's answer kept " + CbJson.Num3((L.StartedMs - at) / 1000) + " s ago (no request)" + (L.Window ? " (a tick chart)" : ""));
            MinutesAnswered(L, mine);
            return true;
        }
        private static bool KeptCovers(Load L, RootBook book)
        {
            lock (book.Sync) return !L.Agent && book.NtMinutes != null && book.NtMinutes.Count > 0 && book.NtMinutesFrom <= L.HistoryFrom;
        }
        // Third review E: the kept answers without a last bar that was still forming when they came (it may be short); from a load's
        // own start.
        private static RawBars ClosedKept(RootBook book, DateTime from)
        {
            RawBars kept; DateTime lastAt;
            lock (book.Sync) { kept = book.NtMinutes; lastAt = book.NtMinutesLastAt; }
            if (kept == null || kept.Count == 0) return kept;
            int a = 0; while (a < kept.Count && kept.Time[a] < from) a++;
            int b = kept.Count; if (b > a && kept.Time[b - 1] > lastAt) b--;
            return a == 0 && b == kept.Count ? kept : kept.Slice(a, b);
        }
        private static bool CanStandIn(Load L, RootBook book)
        {
            if (L.Agent) return false;
            RawBars kept;
            lock (book.Sync) kept = book.NtMinutes;
            if (kept != null && kept.Count > 0) return true;
            return L.Book != null && L.Book.Started && L.Book.Bars != null && L.Book.Bars.Count > 0;
        }
        // 0.6.8 (review): NinjaTrader's minute answer came after the load it was asked for went ready on stand-in history. If that
        // load is still the page's, the page is told once ("historyLate") and loads again (chart 1.38.1: it subscribes again, the
        // bars it shows kept meanwhile); the new load gets the answer that was just kept, or asks again.
        public static int HistoryLateGapMs = 300000;   // re-review B: at most once a page and instrument in 5 minutes
        private static readonly Dictionary<string, double> HistoryLateAt = new Dictionary<string, double>();
        private static void HistoryLate(Load L)
        {
            if (L.Stop.IsCancellationRequested || !L.StoodIn || !Current(L) || Interlocked.Exchange(ref L.LateSent, 1) != 0) return;
            string key = L.Client.Id.ToString(CultureInfo.InvariantCulture) + "|" + L.Root;
            double now = ChartBridgeTime.NowUtcMs(), was;
            lock (HistoryLateAt)
            {
                if (HistoryLateAt.TryGetValue(key, out was) && now - was < HistoryLateGapMs) { HistoryNote(L.Root, "minute history came after a stand-in load, but the page was told to load again less than " + (HistoryLateGapMs / 60000) + " minutes ago: not told again"); return; }
                HistoryLateAt[key] = now;
                if (HistoryLateAt.Count > 500) HistoryLateAt.Clear();
            }
            L.Client.SendData("{\"type\":\"historyLate\",\"root\":" + CbJson.Str(L.Root) + L.SubJson + "}");
            HistoryNote(L.Root, "minute history came after the load went ready on stand-in history: the page was told to load again");
        }

        // 0.6.8: NinjaTrader's minute answer (raw; null after an error or for an older load). A minute or hour chart whose minute
        // book reaches back to NinjaTrader's last bar gets NinjaTrader's bars up to the book's start and the book's after it
        // (MinuteSnap.Join), and no last-trades request: the book has every trade up to the moment the held trades were
        // cleared. Otherwise today's path (0.3.3 to 0.6.7): NinjaTrader's last bar goes out after the last trades, rebuilt from
        // them when it can be.
        private static void MinutesAnswered(Load L, RawBars raw)
        {
            try
            {
                if (L.Stop.IsCancellationRequested) return;   // review: a previous run's answer touches nothing (no book made again)
                if (raw != null && raw.Count > 0 && !L.FromKept) { RootBook kb = BookOf(L.Root, L.Inst); RawBars keep = raw; DateTime asked = L.HistoryFrom, at = L.AnsweredNt; Task.Run(() => KeepNtMinutes(kb, keep, asked, at)); }
                if (!Current(L)) return;
                if (raw != null && raw.Count > 0) L.NtLastBar = raw.Time[raw.Count - 1];
                // re-review A: after an error answer an agent gets exactly what 0.6.7 sent (no history, then ready), never the book
                // alone; a page gets the book (stand-in history, said in ready)
                if (L.Book != null && !(raw == null && L.Agent))
                {
                    long cut; int filled, shortMinutes;
                    RawBars joined = L.Book.Join(raw, out cut, out filled, out shortMinutes);
                    if (joined != null)
                    {
                        L.Filled = filled; L.ShortMinutes = shortMinutes;
                        if (raw == null) L.StoodIn = true;   // the book alone, for an answer that failed
                        if (!L.Window) { SendJoined(L, joined); return; }
                        raw = joined;   // a tick chart: the joined minutes, the last one rebuilt from its trades as before
                    }
                }
                SendHead(L, raw);
            }
            catch (Exception ex) { CbLogLimit.Error("history error", ex); }
            RequestTicks(L);
        }

        // A load's minute history before its trades: all but the last (forming) bar now, the last after the trades (rebuilt
        // from them when it can be).
        private static void SendHead(Load L, RawBars raw)
        {
            if (raw != null && raw.Count > 0)
            {
                // The last bar was still forming: it goes out after the ticks, rebuilt from them when it can be.
                L.MinuteTail = raw.Slice(raw.Count - 1, raw.Count);
                raw = raw.Slice(0, raw.Count - 1);
            }
            if (raw != null)
            {
                RawBars head = raw;
                bool final = L.MinuteTail == null;
                L.HeadSent = Task.Run(() => SendBars(L, head, final));   // format off-thread; stops if the page resubscribes
            }
        }

        // 0.6.8: the history of a minute or hour chart as one list, the last bar in its own message with done true (as 0.3.3),
        // then "ready" and every held trade (none of them is in the list: they came after the book was copied).
        private static void SendJoined(Load L, RawBars bars)
        {
            Task.Run(() =>
            {
                try
                {
                    int n = bars.Count;
                    if (n == 0) SendBars(L, bars, true);
                    else { SendBars(L, bars.Slice(0, n - 1), false); SendBars(L, bars.Slice(n - 1, n), true); }
                }
                catch (Exception ex) { CbLogLimit.Error("history error", ex); }
                finally { MarkReady(L, null); }
            });
        }

        // 0.6.8: the minute history did not come in time (or an earlier request is still unanswered), and there is history to
        // stand in for it (MinuteTimeout, CanStandIn). NinjaTrader's earlier answers for this instrument (kept in memory, cut to this
        // load's own start and to the minutes before the copy's last trade, so no kept bar holds a held trade), joined to the
        // minute book as a fresh answer would be, else the book alone. A minute or hour chart goes ready with them; a tick chart
        // goes on to its trades, its last minute rebuilt from them as usual. Nothing goes to the page about it (Anthony
        // 2026-10-23: "I dont need a notice"): a history note only. Whatever happens, the load ends in ready or in its trades.
        private static void MinuteGivenUp(Load L, string why)
        {
            bool handed = false;
            try
            {
                L.StoodIn = true;
                RootBook book = BookOf(L.Root, L.Inst);
                RawBars kept, bars; string text;
                kept = ClosedKept(book, L.HistoryFrom);   // third review E: no last bar that was still forming
                RawBars whole = kept;
                kept = KeptFor(L, kept);
                if (kept != null && kept.Count > 0)
                {
                    L.NtLastBar = kept.Time[kept.Count - 1];
                    string asOf = "NinjaTrader's minute history as it last sent it (to " + EtHm(kept.Time[kept.Count - 1].AddMinutes(-1)) + " ET)";
                    long cut = -1; int filled = 0, shortMinutes = 0;
                    RawBars joined = L.Book != null ? L.Book.Join(kept, out cut, out filled, out shortMinutes) : null;
                    if (joined != null)
                    {
                        L.Filled = filled; L.ShortMinutes = shortMinutes;
                        bars = joined;
                        text = "; the load shows " + asOf + " and ChartBridge's own minute bars from " + EtHm(new DateTime(L.Book.From, L.Book.Kind)) + " ET";
                    }
                    else
                    {
                        // re-review (from finding 1): the book does not reach back to them (or has no bar yet): the kept bars from this
                        // load's start, their last minute rebuilt from the last trades and the held trades matched against them, as
                        // 0.6.7 does with NinjaTrader's answer (no minute before the copy left out, none counted twice)
                        int a = 0; while (a < whole.Count && whole.Time[a] < L.HistoryFrom) a++;
                        RawBars mine = a == 0 ? whole : whole.Slice(a, whole.Count);
                        HistoryNote(L.Root, why + "; the load shows " + asOf + ", its last minute from the last trades" + (L.Window ? " (a tick chart)" : ""));
                        if (L.Window) { SendHead(L, mine); return; }   // finally: its trades
                        SendHead(L, mine);
                        handed = true;
                        try { RequestTicks(L); }
                        catch (Exception ex) { CbLogLimit.Error("history error", ex); L.HeadSent.ContinueWith(delegate { Finish(L, null); }, TaskScheduler.Default); }   // third review F
                        return;
                    }
                }
                else
                {
                    bars = L.Book != null && L.Book.Started ? L.Book.Bars : new RawBars();
                    L.Filled = bars.Count;
                    text = bars.Count > 0 ? "; the load starts from ChartBridge's own minute bars, from " + EtHm(new DateTime(L.Book.From, L.Book.Kind)) + " ET" : "; the load has no minute history";
                }
                HistoryNote(L.Root, why + text + (L.Window ? " (a tick chart)" : ""));
                if (!L.Window) { handed = true; SendJoined(L, bars); return; }
                SendHead(L, bars);
            }
            catch (Exception ex) { CbLogLimit.Error("history error", ex); }
            finally
            {
                // review of 0.6.8: never a load stuck on LOADING
                if (L.Window) RequestTicks(L);
                else if (!handed) SendJoined(L, new RawBars());
            }
        }
        // Kept answers as a timed-out load may use them: from its own start (the days it asked for), and only the minutes that close
        // before the copy's last trade's minute (a kept answer that came after the copy could hold held trades in that minute).
        private static RawBars KeptFor(Load L, RawBars kept)
        {
            if (kept == null || kept.Count == 0) return kept;
            long last = L.Book != null && L.Book.LastTrade > 0 ? L.Book.LastTrade : L.NowNt.Ticks;
            long before = MinuteBook.CloseOf(last);
            int a = 0; while (a < kept.Count && kept.Time[a] < L.HistoryFrom) a++;
            int b = kept.Count; while (b > a && kept.Time[b - 1].Ticks >= before) b--;
            return a == 0 && b == kept.Count ? kept : kept.Slice(a, b);
        }

        // 0.6.8: NinjaTrader's minute answers for an instrument, kept in memory: the bars before the new answer's first, the new
        // answer, and the kept bars after its last (a stale answer does not take away later bars an earlier answer had), at most
        // NtMinutesKept (about 60 days of minutes). Off NinjaTrader's thread.
        public const int NtMinutesKept = 90000;
        public static void KeepNtMinutes(RootBook book, RawBars nw) { KeepNtMinutes(book, nw, nw != null && nw.Count > 0 ? nw.Time[0] : DateTime.MaxValue, DateTime.MaxValue); }
        // askedFrom: the start of the request it answered (a by-date answer covers every minute NinjaTrader has from there);
        // answeredAt: NinjaTrader's clock when it came (its last bar was forming then; MaxValue: every bar closed)
        public static void KeepNtMinutes(RootBook book, RawBars nw, DateTime askedFrom, DateTime answeredAt)
        {
            try
            {
                if (nw == null || nw.Count == 0 || nw.Open == null) return;
                RawBars old;
                lock (book.Sync) old = book.NtMinutes;
                bool newLast;
                RawBars m = MergeNtMinutes(old, nw, out newLast);
                lock (book.Sync)
                {
                    if (book.NtMinutes != old) return;
                    if (newLast || old == null) book.NtMinutesLastAt = answeredAt;   // the kept last bar is the new answer's
                    book.NtMinutesFrom = old == null || old.Count == 0 ? askedFrom : (askedFrom < book.NtMinutesFrom ? askedFrom : book.NtMinutesFrom);
                    if (m.Count > 0 && m.Time[0] > book.NtMinutesFrom && m.Count == NtMinutesKept) book.NtMinutesFrom = m.Time[0];   // cut at the cap
                    book.NtMinutes = m; book.NtMinutesAtMs = ChartBridgeTime.NowUtcMs();
                }
            }
            catch (Exception ex) { CbLogLimit.Error("minute history keep error", ex); }
        }
        public static RawBars MergeNtMinutes(RawBars old, RawBars nw) { bool newLast; return MergeNtMinutes(old, nw, out newLast); }
        // newLast: the merged last bar is the new answer's. Third review E: when the kept bars run past the new answer's last bar
        // (the new answer is the staler one), that bar was forming when it came: it is not kept inside the merge as if closed (the
        // kept bar of that minute, if there is one, is used).
        public static RawBars MergeNtMinutes(RawBars old, RawBars nw, out bool newLast)
        {
            RawBars r;
            newLast = true;
            if (old == null || old.Count == 0 || old.Open == null) r = nw;
            else
            {
                DateTime first = nw.Time[0], lastNew = nw.Time[nw.Count - 1];
                int a = 0; while (a < old.Count && old.Time[a] < first) a++;
                int b = old.Count; while (b > 0 && old.Time[b - 1] > lastNew) b--;
                int nNew = nw.Count;
                if (b < old.Count)
                {
                    newLast = false;
                    nNew--;                                                   // the new answer's forming bar
                    if (b > a && old.Time[b - 1] == lastNew) b--;             // the kept bar of that minute, later and fuller
                }
                int n = a + nNew + (old.Count - b);
                r = new RawBars { Count = n, Time = new DateTime[n], Open = new double[n], High = new double[n], Low = new double[n], Close = new double[n], Volume = new long[n] };
                CopyBars(old, 0, r, 0, a); CopyBars(nw, 0, r, a, nNew); CopyBars(old, b, r, a + nNew, old.Count - b);
            }
            return r.Count > NtMinutesKept ? r.Slice(r.Count - NtMinutesKept, r.Count) : r;
        }
        private static void CopyBars(RawBars f, int i, RawBars t, int j, int n)
        {
            if (n <= 0) return;
            Array.Copy(f.Time, i, t.Time, j, n); Array.Copy(f.Open, i, t.Open, j, n); Array.Copy(f.High, i, t.High, j, n);
            Array.Copy(f.Low, i, t.Low, j, n); Array.Copy(f.Close, i, t.Close, j, n); Array.Copy(f.Volume, i, t.Volume, j, n);
        }

        // 0.6.8 (WORK's request, 2026-10-23: NinjaTrader's Output window loses them): the history path's own notes ("Minute history
        // failed", "last trades for the forming minute not loaded", "tick window failed", the time limits and the holes) with the
        // time and the instrument: the Output window as before, the last 50 in /diag ("historyNotes"), and history.log next to
        // ChartBridge's other files (copier.log, bot.log), written off the caller's thread; past 512 KB it moves to history.log.1
        // (one old file kept).
        private static readonly List<string> HistoryNotes = new List<string>();
        private static readonly object HistoryLogLock = new object();
        public const int HistoryLogMaxBytes = 512 * 1024;
        public static void HistoryNote(string root, string text)
        {
            Log(root + " " + text);
            string line = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture) + "\t" + EtText(NowNt()) + " ET\t" + root + "\t" + text.Replace('\t', ' ').Replace('\n', ' ');
            lock (HistoryNotes) { HistoryNotes.Add(line); if (HistoryNotes.Count > 50) HistoryNotes.RemoveAt(0); }
            Task.Run(() =>
            {
                try
                {
                    lock (HistoryLogLock)
                    {
                        Directory.CreateDirectory(ChartBridgeConfig.Folder);
                        string path = Path.Combine(ChartBridgeConfig.Folder, "history.log");
                        FileInfo fi = new FileInfo(path);
                        if (fi.Exists && fi.Length > HistoryLogMaxBytes) { string old = path + ".1"; if (File.Exists(old)) File.Delete(old); File.Move(path, old); }
                        File.AppendAllText(path, line + "\n");
                    }
                }
                catch (Exception) { }   // the Output window and /diag still have it
            });
        }
        private static string HistoryNotesJson() { lock (HistoryNotes) return "[" + string.Join(",", HistoryNotes.Select(x => CbJson.Str(x)).ToArray()) + "]"; }
        private static DateTime EtWall(DateTime nt) { return TimeZoneInfo.ConvertTimeFromUtc(ChartBridgeTime.ToUtc(nt), ChartBridgeTime.Eastern); }
        private static string EtHm(DateTime nt) { return EtWall(nt).ToString("HH:mm", CultureInfo.InvariantCulture); }

        // 0.6.8: the hole between a minute chart's last history bar (its close stamp) and "ready", when the market was open for
        // more than 2 minutes of it (the 17:00 break, a weekend and the CME holidays are not a hole: ChartBridgeCme.Closed); null
        // when there is none. "No bars from 10:41 to 11:08 ET: NinjaTrader's minute history ends at 10:40" (bar start times, as
        // the chart shows them; the day is named when the hole crosses midnight).
        public static string HoleText(DateTime lastClose, DateTime readyNt)
        {
            DateTime x = EtWall(lastClose), r = EtWall(readyNt);
            double open = 0; DateTime first = DateTime.MinValue;
            int guard = 0;
            for (DateTime m = x; m < r && guard < 20160; m = m.AddMinutes(1), guard++)
            {
                if (ChartBridgeCme.Closed(m)) continue;
                if (first == DateTime.MinValue) first = m;
                open += Math.Min(60, (r - m).TotalSeconds);
            }
            if (first == DateTime.MinValue || open <= 120) return null;
            DateTime to = new DateTime(r.Ticks - r.Ticks % TimeSpan.TicksPerMinute), ends = x.AddMinutes(-1);
            string f = first.Date != to.Date || ends.Date != to.Date ? "ddd HH:mm" : "HH:mm";
            return "No bars from " + first.ToString(f, CultureInfo.InvariantCulture) + " to " + to.ToString(f, CultureInfo.InvariantCulture) +
                " ET: NinjaTrader's minute history ends at " + ends.ToString(f, CultureInfo.InvariantCulture);
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
            if (n > 0 && (!L.LastBarClose.HasValue || bars.Time[n - 1] > L.LastBarClose.Value)) L.LastBarClose = bars.Time[n - 1];   // 0.6.8: for the hole check
            if (n > 0 && (!L.FirstBarClose.HasValue || bars.Time[0] < L.FirstBarClose.Value)) L.FirstBarClose = bars.Time[0];        // 0.6.8: ready's historyFrom
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
            if (L.MinuteTail == null) { L.HeadSent.ContinueWith(delegate { Finish(L, null); }, TaskScheduler.Default); return; }
            // 0.3.5: not while a session backfill is out (the forming minute then stays as NinjaTrader sent it); counted, so no
            // backfill starts while it is.
            // 0.6.8: not while an earlier last-trades request for this instrument was given up and is still unanswered.
            RootBook book = BookOf(L.Root, L.Inst);
            bool overdue;
            lock (book.Sync) overdue = !L.Agent && book.TailOverdueMs >= 0 && ChartBridgeTime.NowUtcMs() - book.TailOverdueMs < OverdueReaskMs;
            if (overdue || !BeginTail()) { L.HeadSent.ContinueWith(delegate { Finish(L, null); }, TaskScheduler.Default); return; }
            // Minute and hour charts: only the last trades, for the forming minute (not sent to the page).
            BarsRequest ticks = new BarsRequest(L.Inst, SeamTicksBack);
            ticks.BarsPeriod = new BarsPeriod { BarsPeriodType = BarsPeriodType.Tick, Value = 1 };
            ticks.TradingHours = L.Inst.MasterInstrument.TradingHours;
            ticks.Request(new Action<BarsRequest, ErrorCode, string>((req, code, message) =>
            {
                bool mine = Interlocked.CompareExchange(ref L.TailState, 1, 0) == 0;
                RawBars raw = null;
                try
                {
                    if (!mine) { lock (book.Sync) book.TailOverdueMs = -1; Log(L.Root + " last trades: NinjaTrader answered after " + (TailTimeoutMs / 1000) + " s, when they were given up; not used"); }
                    else if (code != ErrorCode.NoError) HistoryNote(L.Root, "last trades for the forming minute not loaded (" + code + " " + message + "); the minute stays as NinjaTrader sent it");
                    else if (Current(L)) { raw = RawBars.Copy(req.Bars, true); NoteAnswer(L); }
                }
                catch (Exception ex) { Log("last trades error: " + ex.Message); }
                finally { try { req.Dispose(); } catch (Exception) { } EndTail(); }
                if (!mine) return;
                RawBars copy = raw;
                L.HeadSent.ContinueWith(delegate { Finish(L, copy); }, TaskScheduler.Default);
            }));
            // 0.6.8: at most TailTimeoutMs for them; then the forming minute stays as NinjaTrader sent it (a history note; nothing on
            // the page). An agent waits for them as in 0.6.7.
            if (!L.Agent) Task.Delay(TailTimeoutMs).ContinueWith(delegate
            {
                if (L.Stop.IsCancellationRequested) return;   // review: nothing of a previous run
                if (Interlocked.CompareExchange(ref L.TailState, 2, 0) != 0) return;
                L.TailTimedOut = true;
                lock (book.Sync) book.TailOverdueMs = ChartBridgeTime.NowUtcMs();
                HistoryNote(L.Root, "last trades: no answer from NinjaTrader in " + (TailTimeoutMs / 1000) + " s; the forming minute stays as NinjaTrader sent it");
                if (!Current(L)) return;
                L.HeadSent.ContinueWith(delegate { Finish(L, null); }, TaskScheduler.Default);
            }, TaskScheduler.Default);
        }

        // A minute or hour chart (no tick backfill since 0.3.5; tick charts finish in FinishWindow). Order on the wire: minute
        // history, its last bar (rebuilt from the last trades when it can be), then "ready" and the held live trades not
        // already in that minute.
        private static void Finish(Load L, RawBars ticks)
        {
            RawBars seam = null;   // what the held trades are matched against: the last trades, when the forming minute came from them
            try
            {
                if (!Current(L)) return;
                if (L.MinuteTail != null)
                {
                    RawBars tail = RebuildTail(L, ticks);
                    if (tail != null) seam = ticks;   // minute charts: only when the minutes after NinjaTrader's came from these same ticks
                    SendBars(L, tail ?? L.MinuteTail, true);
                }
            }
            catch (Exception ex) { CbLogLimit.Error("tick send error", ex); }   // 0.4.0: at most a line a minute
            finally { MarkReady(L, seam); }
        }

        // NinjaTrader's last (forming) minute and any after it, rebuilt from a load's trades: the bars that stand for it, or null to
        // keep NinjaTrader's bar as it is. Minute charts (Finish, the last trades) and tick charts (FinishWindow, the served window).
        private static RawBars RebuildTail(Load L, RawBars ticks)
        {
            RawBars tail = ticks != null ? ChartBridgeSeam.TailFromTicks(L.MinuteTail.Time[0], ticks.Time, ticks.Close, ticks.Volume, ticks.Count) : null;
            L.NtTailVolume = L.MinuteTail.Volume[0];
            if (tail != null)
            {
                L.RebuiltTailVolume = 0;
                for (int i = 0; i < tail.Count; i++) if (tail.Time[i] == L.MinuteTail.Time[0]) L.RebuiltTailVolume = tail.Volume[i];
                // The ticks were answered after the minutes, so they should hold at least as much of that minute.
                // Less means the tick data lags: keep NinjaTrader's bar (and, on minute charts, release every held trade).
                if (L.RebuiltTailVolume < L.NtTailVolume)
                {
                    // 0.6.8: NinjaTrader's bar is kept for that minute, but the minutes the same trades hold after it are
                    // not thrown away with it (before 0.6.8 they were, and the chart had no bar from that minute to the
                    // live one: a hole the trades in hand could fill). They go after NinjaTrader's bar, and the held
                    // trades are matched against these same trades.
                    int after = 0;
                    while (after < tail.Count && tail.Time[after] <= L.MinuteTail.Time[0]) after++;
                    if (after < tail.Count)
                    {
                        RawBars later = tail.Slice(after, tail.Count);
                        RawBars both = new RawBars { Count = later.Count + 1, Time = new DateTime[later.Count + 1], Open = new double[later.Count + 1], High = new double[later.Count + 1], Low = new double[later.Count + 1], Close = new double[later.Count + 1], Volume = new long[later.Count + 1] };
                        CopyBars(L.MinuteTail, 0, both, 0, 1); CopyBars(later, 0, both, 1, later.Count);
                        L.TailKeptAfter = later.Count;
                        tail = both;
                    }
                    else tail = null;
                }
            }
            L.TailRebuilt = tail != null ? tail.Count - (L.TailKeptAfter > 0 ? 1 : 0) : 0;
            return tail;
        }

        // Each trade is [t, p, v] (0.3.4 to 0.3.6 added s and sm on the by-date backfill, removed in 0.3.7).
        private static void SendTicks(Load L, RawBars bars) { SendTicks(L, bars, 0); }
        // from (0.3.5): the first trade to send (a served window is cut at rangeHours).
        private static void SendTicks(Load L, RawBars bars, int from)
        {
            const int chunk = 20000;
            int n = bars.Count;
            StringBuilder b = null; int inChunk = 0;
            ChartBridgeTime.EtCache et = new ChartBridgeTime.EtCache();
            for (int i = Math.Max(0, from); i < n; i++)
            {
                if (b == null) { b = new StringBuilder(chunk * 34); b.Append("{\"type\":\"ticks\",\"root\":").Append(CbJson.Str(L.Root)).Append(L.SubJson).Append(",\"ticks\":["); inChunk = 0; }
                if (inChunk > 0) b.Append(',');
                AppendTrade(b, bars, i, et);
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

        // One trade as the page reads it: [t, p, v] (the served window carries no side; 0.3.7 removed the by-date load's sided
        // backfill). The same text as 0.3.4 wrote for t, p, v, with no string made per number (0.3.5; the harness compares them).
        // 0.3.8: a trade ChartBridge saw live with a usable quote is [t, p, v, null, null, q] (q its Time and Sales category;
        // the side places stay null as in 0.3.7, so a page reading s and sm sees none); one with no stored quote stays [t, p, v].
        public static void AppendTrade(StringBuilder b, RawBars bars, int i, ChartBridgeTime.EtCache et)
        {
            b.Append('[');
            CbJson.AppendNum3(b, et.Seconds(bars.Time[i]));
            b.Append(',');
            CbJson.AppendNum(b, bars.Close[i]);
            b.Append(',');
            CbJson.AppendLong(b, bars.Volume[i]);
            int q = bars.QCode != null ? ChartBridgeSides.QOf(bars.QCode[i]) : ChartBridgeSides.NoQ;
            if (q != ChartBridgeSides.NoQ) { b.Append(",null,null,"); CbJson.AppendLong(b, q); }
            b.Append(']');
        }

        // "ready", then the held live trades that are not in the backfill (ChartBridgeSeam.Dedupe), in the order they came.
        // Under the Pending lock, so no live trade can slip between the held ones and the ones that follow. 0.3.5: the
        // "profile" first (S4): the table copied under the book's lock together with the trades held so far (all in it), then
        // formatted with no lock held, less those of them that are released after it (the page adds them as it gets them).
        // The trades held after the copy are not in it and are released after it too.
        private static void MarkReady(Load L, RawBars seam)
        {
            if (Interlocked.Exchange(ref L.ReadyOnce, 1) != 0) return;   // 0.6.8: once per load (a timeout and a late answer cannot both)
            ChartBridgeClient client = L.Client;
            string profile = null;
            // 0.6.8: a history that ends well before now is recorded (the seam in /diag, historyNotes and history.log), never shown
            // on the page (Anthony 2026-10-23: "I dont need a notice")
            if (L.LastBarClose.HasValue)
            {
                try { L.Hole = HoleText(L.LastBarClose.Value, NowNt()); } catch (Exception ex) { CbLogLimit.Error("hole check error", ex); }
                if (L.Hole != null) HistoryNote(L.Root, "history ends early: " + L.Hole + (L.Window ? " (a tick chart)" : ""));
            }

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
                // 0.6.8: a minute or hour chart's "ready" says how many of its bars came from ChartBridge's minute book ("filled")
                // 0.6.8 (review): and, for a program reading it (an agent), whether the minute history is NinjaTrader's answer to this
                // load ("minuteTimedOut" false) or stood in for it (true: NinjaTrader's kept answers and the book; never for an agent),
                // whether the last trades were given up ("tailTimedOut"), and the first bar's start ("historyFrom", bar-time seconds, or
                // null with no bar)
                burst.Add("{\"type\":\"ready\",\"root\":" + CbJson.Str(L.Root) + (L.Window ? "" : ",\"filled\":" + Math.Max(0, L.Filled).ToString(CultureInfo.InvariantCulture)) +
                    ",\"minuteTimedOut\":" + (L.MinuteTimedOut ? "true" : "false") + ",\"minuteFailed\":" + (L.MinuteFailed ? "true" : "false") +
                    ",\"standIn\":" + (L.StoodIn ? "true" : "false") + ",\"tailTimedOut\":" + (L.TailTimedOut ? "true" : "false") +
                    ",\"historyFrom\":" + (L.FirstBarClose.HasValue ? CbJson.Num3(ChartBridgeTime.EtSeconds(ChartBridgeTime.ToUtc(L.FirstBarClose.Value)) - 60) : "null") + L.SubJson + "}");
                foreach (SeamTick h in r.Release) burst.Add(h.Json);
                client.SendAll(burst);
                DateTime? firstHeld = client.Pending.Count > 0 ? client.Pending[0].Time : (DateTime?)null;
                client.Pending.Clear();
                client.Ready = true;
                NoteSeam(L, r, seam != null, firstHeld);
                if (L.Diag != null) L.Diag.TimeToLiveMs = ChartBridgeTime.NowUtcMs() - L.StartedMs;
            }
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
            j.OnDropped = () => WindowFailed(book, gen, "ChartBridge stopped before the request went out", false);   // lf7 N1
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
                        foreach (SeamTick h in r.Release) cache.Add(h.Time, h.Price, h.Volume, h.QCode);   // the live trades not in the answer, with their q
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
            HistoryNote(book.Root, "tick window failed (" + why + "); tick charts start from live trades" + (backoff ? ", asked again after " + (WindowRetryMs / 1000) + " s at the earliest" : ""));
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
                    RawBars tail = RebuildTail(L, ticks);   // 0.6.8: the minutes after a short last minute are kept here too
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
                    SendTicks(L, ticks);
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
        // OnDropped (0.3.7, lf7 N1): the job will never go out (ChartBridge stopped before it was sent): its waiters are answered.
        // FreesGate (0.3.6 bars, 0.3.7 higher-timeframe bars): not answered in time, it is given up and the gate goes on.
        private class GateJob { public string Kind, Root; public RootBook Book; public Action<Action> Start; public Action OnTimeout; public Action<string> OnStuck; public Action OnDropped; public Action<string> OnExpire; public bool FreesGate; public double QueuedMs; public int TimeoutMs; public int State; public CancellationToken Stop; }
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
        public static Action GateBeforeSendForHarness; // the harness only (lf7 N3): runs on the worker between taking a job and sending it
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
            string stuck; bool stopped;
            lock (GateLock)
            {
                stopped = gateStopped;                 // review 6 S1: after Stop nothing goes to NinjaTrader (its pages are closed)
                stuck = stopped ? null : gateStuck;
                if (!stopped && (stuck == null || j.Kind != "window")) (j.Kind == "window" ? GateWindows : GateBackfills).Add(j);
            }
            if (stopped) { Dropped(j); return; }       // lf7 N1: never a waiter left on a job that will not go out
            if (stuck != null && j.OnStuck != null) { j.OnStuck(stuck); if (j.Kind == "window") return; }   // review 4 B1, S2
            GateKick();
        }
        private static void Dropped(GateJob j)
        {
            try { if (j.OnDropped != null) j.OnDropped(); } catch (Exception ex) { Log("request dropped error: " + ex.Message); }
        }
        // Starts the worker when there is work and it is not running (after an enqueue, a late answer, a tail's end).
        private static void GateKick()
        {
            lock (GateLock)
            {
                if (gateStopped || gateRunning || (GateWindows.Count == 0 && GateBackfills.Count == 0 && GateHtfJobs.Count == 0 && GateBarJobs.Count == 0)) return;
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
                GateWindows.Clear(); GateBackfills.Clear(); GateBarJobs.Clear(); GateHtfJobs.Clear(); gateStuck = null; gateStuckJob = null; gateStuckSinceMs = -1; gateNow = null;
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
                // Last of all (0.3.7 higher-timeframe bars a page asked for, then 0.3.6 daily bars): no backfill queued, no
                // minute chart's last trades out, no page loading
                if ((GateHtfJobs.Count == 0 && GateBarJobs.Count == 0) || tailsOut > 0) return null;
                if (PageLoading()) { wait = true; return null; }
                List<GateJob> q = GateHtfJobs.Count > 0 ? GateHtfJobs : GateBarJobs;
                j = q[0]; q.RemoveAt(0);
                return j;
            }
            if (tailsOut > 0) return null;
            // S-E: the feed up and quiet for BackfillStartMs (from the first live trade after market data started), and no page
            // loading; then in profileRoots order (MNQ, NQ, ES, MES), whatever order their first trades came in.
            long first = Interlocked.Read(ref firstTradeUtcTicks);
            if (first == 0 || (ChartBridgeTime.ToUtc(NowNt()).Ticks - first) / TimeSpan.TicksPerMillisecond < BackfillStartMs || PageLoading()) { wait = true; return null; }
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
                Action probe = GateBeforeSendForHarness;
                if (probe != null) probe();
                // lf7 N3: a stop between taking the job and sending it: nothing goes out (the request is dropped, its waiters
                // answered). Checked under the lock StopGate takes, right before the send: what is left is the few instructions
                // from here to NinjaTrader's call, and a request sent in them has its answer dropped uncopied (j.Stop is the
                // worker's token, already cancelled).
                bool stoppedNow;
                lock (GateLock) stoppedNow = stop.IsCancellationRequested || gateStopped;
                if (stoppedNow) { Dropped(j); return; }
                ManualResetEventSlim done = new ManualResetEventSlim(false);
                j.Stop = stop;   // the stop of the worker that sent it: a backfill's retry is cancelled with it (N6)
                GateJob jj = j;
                // State 5: the worker gave up waiting on this answer's copy (below); the copy that ends after that frees the gate.
                try { j.Start(() => { done.Set(); if (Interlocked.CompareExchange(ref jj.State, 6, 5) == 5) GateUnstuck(jj, jj.Kind + " " + jj.Root); }); }
                catch (Exception ex) { Log(j.Kind + " request error (" + j.Root + "): " + ex.Message); done.Set(); }
                bool answered = done.Wait(j.TimeoutMs, stop);
                if (!answered && j.FreesGate)
                {
                    // 0.3.6 (Anthony): the chart never waits on bars. A bars request not answered in its time limit is given up
                    // and the gate goes on: it is NOT marked stuck, so windows and backfills go as usual (accepted: one may go
                    // while NinjaTrader still works on it). Claimed as timed out (3), so its late answer is dropped uncopied,
                    // and GateUnstuck leaves the gate alone (it is not gateStuckJob). The session is asked again later.
                    if (Interlocked.CompareExchange(ref j.State, 3, 0) == 0)
                    {
                        try { j.OnTimeout(); } catch (Exception ex) { Log("request timeout error: " + ex.Message); }
                        Log(j.Kind + " " + j.Root + ": NinjaTrader did not answer in " + (j.TimeoutMs / 1000) + " s; given up, the gate goes on (a late answer is not used)");
                    }
                    else if (!done.Wait(AnswerCopyMs, stop)) Log(j.Kind + " " + j.Root + ": NinjaTrader answered at the time limit, but the copy did not end within " + (AnswerCopyMs / 1000) + " s more; the gate goes on");
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
            List<GateJob> windows, backfills, bars, htf;
            lock (GateLock)
            {
                if (j.Stop.IsCancellationRequested || gateStopped) return;   // stopped meanwhile: the gate was reset, nothing to mark (review 6 N1; lf7 N2: also in the gap before StopGate cancels)
                gateStuck = what; gateStuckJob = j; gateStuckSinceMs = ChartBridgeTime.NowUtcMs();
                windows = new List<GateJob>(GateWindows); GateWindows.Clear();
                backfills = new List<GateJob>(GateBackfills);
                bars = new List<GateJob>(GateBarJobs); GateBarJobs.Clear();   // 0.3.6: a queued bars request is dropped, and asked again later
                htf = new List<GateJob>(GateHtfJobs); GateHtfJobs.Clear();   // 0.3.7: its pages get the bars in memory, or the reason
            }
            try { j.OnTimeout(); } catch (Exception ex) { Log("request timeout error: " + ex.Message); }
            Log(StuckNote(what));
            foreach (GateJob w in windows.Concat(backfills).Concat(bars).Concat(htf)) { try { if (w.OnStuck != null) w.OnStuck(what); } catch (Exception ex) { Log("request stuck error: " + ex.Message); } }
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
        private static bool PageLoading() { return Clients.Values.Any(c => !string.IsNullOrEmpty(c.Root) && !c.Ready) || ChartBridgeAgents.Subscribed().Any(c => !c.Ready); }   // 0.5.0 agents: an agent's load counts as a page's
        // Under GateLock: why the gate is not idle for a bars request, or null.
        private static string BarsBusyLocked()
        {
            if (gateStopped) return "ChartBridge is stopping";
            if (gateStuck != null) return "NinjaTrader has not answered an earlier request (" + gateStuck + ") yet";
            if (gateNow != null) return gateNow + " is out";
            if (GateWindows.Count > 0) return GateWindows.Count + " window request(s) queued";
            if (GateBackfills.Count > 0) return GateBackfills.Count + " session backfill(s) queued";
            if (GateBarJobs.Count > 0) return "a bars request is queued";
            if (GateHtfJobs.Count > 0) return GateHtfJobs.Count + " higher-timeframe request(s) queued";
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
        public static string GateBars(string what, Instrument inst, DateTime fromNt, DateTime toNt, int timeoutMs, Func<bool> dropped, BarsTicket t) { return GateBars(what, inst, fromNt, toNt, timeoutMs, dropped, t, null); }
        // 0.6.9: build not null: the 1 second bars' request instead (ChartBridgeBars.Fetch1s): 1 tick, Last, the same trading hours and
        // merge policy, through the same rules of the gate (a bars job, last of all, freeing the gate at its time limit). On NinjaTrader's
        // thread build makes the 1 second rows from the answer in one pass (no copy of the ticks is kept) into t.Built.
        public static string GateBars(string what, Instrument inst, DateTime fromNt, DateTime toNt, int timeoutMs, Func<bool> dropped, BarsTicket t, Func<Bars, object> build)
        {
            string why = BackfillToCome();
            if (why != null) return why;
            GateJob j = new GateJob { Kind = "bars", Root = what, TimeoutMs = timeoutMs, FreesGate = true };
            j.Start = done => RunBars(j, inst, fromNt, toNt, dropped, t, done, build);
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
        private static void RunBars(GateJob j, Instrument inst, DateTime fromNt, DateTime toNt, Func<bool> dropped, BarsTicket t, Action done, Func<Bars, object> build)
        {
            if (dropped != null && dropped()) { t.Error = "stopped"; done(); t.Done.Set(); return; }   // stopped since it was queued: nothing goes out
            try
            {
                BarsRequest req0 = new BarsRequest(inst, fromNt, toNt);
                req0.BarsPeriod = build == null ? new BarsPeriod { BarsPeriodType = BarsPeriodType.Minute, Value = 1, MarketDataType = MarketDataType.Last }
                                                : new BarsPeriod { BarsPeriodType = BarsPeriodType.Tick, Value = 1, MarketDataType = MarketDataType.Last };   // 0.6.9: every trade, for the 1 second bars
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
                        else if (req.Bars != null && build != null) { Stopwatch bw = Stopwatch.StartNew(); t.Built = build(req.Bars); t.BuildMs = bw.Elapsed.TotalMilliseconds; }   // 0.6.9: one pass over the trades, rows only
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
        // 0.6.3 (audit C7): NinjaTrader's data connection is down (a drop seen, no trade or Connected since): the agents' flat time
        // reads it to tell a lost feed from a halt.
        // Review LOW 9: no trade at all since ChartBridge started listening (feedDown starts at 0) counts too, once 5 s have passed
        // since that start: a start with no data ever is a feed that is not up.
        public static bool FeedDown
        {
            get
            {
                if (Volatile.Read(ref feedDown) != 0) return true;
                long since = Interlocked.Read(ref listeningSinceUtcTicks);
                return Interlocked.Read(ref firstTradeUtcTicks) == 0 && since > 0 && ChartBridgeTime.ToUtc(NowNt()).Ticks - since >= TimeSpan.TicksPerSecond * 5;
            }
        }
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
            lock (GateLock) { GateWindows.Clear(); GateBackfills.Clear(); GateBarJobs.Clear(); GateHtfJobs.Clear(); gateStuck = null; gateStuckJob = null; tailsOut = 0; gateStopped = false; }   // the harness: as after a start
            HtfReset();
            lock (WeekCache) WeekCache.Clear();
            Interlocked.Exchange(ref listeningSinceUtcTicks, listeningSinceUtc.Ticks);
            Interlocked.Exchange(ref feedUpSinceUtcTicks, listeningSinceUtc.Ticks); Interlocked.Exchange(ref feedDown, 0);
            Interlocked.Exchange(ref firstTradeUtcTicks, 0);
        }

        private static void SaveLast(RootBook book)
        {
            SessionTable last; string file = book.LastFile;
            lock (book.Sync) { last = book.Last; book.LastChanged = false; }
            if (last == null) return;
            DateTime day = SessionTable.TradingDate(last.StartEt);
            string dated = book.PastFile(day), root = book.Root;
            Task.Run(() =>   // S4: formatted and written off the market data thread (a finished table is never changed)
            {
                try
                {
                    string text = RootBook.LastText(last);
                    Directory.CreateDirectory(Path.GetDirectoryName(file));
                    foreach (string f in new[] { file, dated }) { File.WriteAllText(f + ".tmp", text); if (File.Exists(f)) File.Delete(f); File.Move(f + ".tmp", f); }
                    // 0.3.7: the dated copies (the weekly profile) are kept RootBook.PastFileDays; older ones go
                    foreach (string f in Directory.GetFiles(Path.GetDirectoryName(file), "profile-" + root + "-*.txt"))
                    {
                        DateTime d;
                        string stem = Path.GetFileNameWithoutExtension(f);
                        if (stem.Length >= 10 && DateTime.TryParseExact(stem.Substring(stem.Length - 10), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out d) && d < day.AddDays(-RootBook.PastFileDays))
                            try { File.Delete(f); } catch (Exception) { }
                    }
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
            foreach (RootBook b in list) lock (b.Sync) { if (b.Table != null && now >= b.Table.End) { if (b.Cache != null) { Interlocked.Increment(ref windowsSwept); lastWindowSweptMs = ChartBridgeTime.NowUtcMs(); } b.Cache = null; } }
            lastSweepMs = ChartBridgeTime.NowUtcMs();   // 0.4.0: /diag health.memory
        }

        // The market is closed now (New York time: Friday 17:00 to Sunday 18:00, the daily 17:00 to 18:00 break, and since
        // 0.3.7 (lf7 N4) the CME holidays by the page's own rules: no session on New Year's Day, Good Friday and Christmas,
        // the 13:00 halt on the other NYSE holidays and 13:15 on an NYSE early close; ChartBridgeCme).
        private static bool MarketClosedNow()
        {
            return ChartBridgeCme.Closed(TimeZoneInfo.ConvertTimeFromUtc(ChartBridgeTime.ToUtc(NowNt()), ChartBridgeTime.Eastern));
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
            HtfFeedDropped(root);   // 0.3.7: the forming higher-timeframe bars miss trades: asked again at the next request
            List<RootBook> list; lock (Books) list = Books.Values.Where(b => root == null || b.Root == root).ToList();
            double et = ChartBridgeTime.EtSeconds(DateTime.UtcNow);
            if (ClockForHarness != null) et = ChartBridgeTime.EtSeconds(ChartBridgeTime.ToUtc(NowNt()));
            foreach (RootBook b in list)
            {
                bool changed;
                lock (b.Sync) { changed = b.FeedDropped(et, why); if (b.WindowAsking) b.WindowLive = null; b.Minutes.Reset(why); }   // 0.6.8: the minute book starts over once the feed is back
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
                    MinuteBook mb = k.Minutes;   // 0.6.8
                    b.Append(",\"minutes\":{\"from\":").Append(mb.From >= 0 ? CbJson.Str(EtText(new DateTime(mb.From, mb.Kind))) : "null").Append(",\"bars\":").Append(mb.Count)
                     .Append(",\"trades\":").Append(mb.Trades).Append(",\"lateTrades\":").Append(mb.LateTrades).Append(",\"resets\":").Append(mb.Resets)
                     .Append(",\"resetWhy\":").Append(mb.ResetWhy != null ? CbJson.Str(mb.ResetWhy) : "null")
                     .Append(",\"minuteOverdue\":").Append(k.MinuteOverdueMs >= 0 ? "true" : "false").Append(",\"tailOverdue\":").Append(k.TailOverdueMs >= 0 ? "true" : "false").Append('}');
                    double rate = k.RatePerHour(now);
                    b.Append(",\"tradesPerHour\":").Append(rate >= 0 ? CbJson.Num3(rate) : "null").Append("},");
                }
            }
            string gate;
            lock (GateLock) gate = "{\"now\":" + (gateNow != null ? CbJson.Str(gateNow) : "null") + ",\"windowsQueued\":" + GateWindows.Count + ",\"backfillsQueued\":" + GateBackfills.Count +
                ",\"barsQueued\":" + GateBarJobs.Count + ",\"htfQueued\":" + GateHtfJobs.Count + ",\"minuteTailsOut\":" + tailsOut + ",\"stuck\":" + (gateStuck != null ? CbJson.Str(gateStuck) : "null") + ",\"stuckSinceUtcMs\":" + (gateStuckSinceMs >= 0 ? CbJson.Num3(gateStuckSinceMs) : "null") +
                ",\"feedDown\":" + (Volatile.Read(ref feedDown) != 0 ? "true" : "false") + ",\"firstTradeUtcMs\":" + (Interlocked.Read(ref firstTradeUtcTicks) > 0 ? CbJson.Num3((Interlocked.Read(ref firstTradeUtcTicks) - 621355968000000000L) / 10000.0) : "null") + "}";
            b.Append("\"gate\":").Append(gate).Append(",\"profileRoots\":[").Append(string.Join(",", ChartBridgeConfig.ProfileRoots.Select(x => CbJson.Str(x)).ToArray())).Append(']');
            b.Append(",\"backfillTotalMs\":").Append(CbJson.Num3(total));
            return b.Append('}').ToString();
        }
        private static string WindowsJson() { lock (Windows) return "[" + string.Join(",", Windows.Select(x => x.Json()).ToArray()) + "]"; }

        // ---------------------------------------------------------- 0.3.7: page requests (strict, as every new message)
        // A page message of the 0.3.7 data side ("htf", "weekProfile"): one flat JSON object with only the keys listed, each
        // once. Values: a plain string (printable ASCII, no backslash, at most 32 characters) or a whole number of 1 to 15
        // digits (no sign, no leading zero). Anything else (another key, a nested object or list, true, false, null, a
        // fraction, an escape, trailing text) is refused with a "status" warning, and nothing is asked of NinjaTrader.
        public static Dictionary<string, string> ParseStrict(string text, string[] required, string[] optional, out string why)
        {
            why = null;
            Dictionary<string, string> d = new Dictionary<string, string>();
            int i = 0, n = text == null ? 0 : text.Length;
            Action ws = () => { while (i < n && (text[i] == ' ' || text[i] == '\t' || text[i] == '\n' || text[i] == '\r')) i++; };
            Func<int, string> str = max =>
            {
                if (i >= n || text[i] != '"') return null;
                int start = ++i;
                while (i < n && text[i] != '"') { char c = text[i]; if (c < 0x20 || c > 0x7e || c == '\\' || i - start >= max) return null; i++; }
                if (i >= n) return null;
                return text.Substring(start, i++ - start);
            };
            ws();
            if (i >= n || text[i] != '{') { why = "not a JSON object"; return null; }
            i++; ws();
            if (i < n && text[i] == '}') i++;
            else
                for (;;)
                {
                    string key = str(32);
                    if (string.IsNullOrEmpty(key)) { why = "a key is not a plain string"; return null; }
                    ws();
                    if (i >= n || text[i] != ':') { why = "malformed"; return null; }
                    i++; ws();
                    string val;
                    if (i < n && text[i] == '"') { val = str(32); if (val == null) { why = key + " is not a plain string of at most 32 characters"; return null; } val = "s" + val; }
                    else
                    {
                        int st = i;
                        while (i < n && text[i] >= '0' && text[i] <= '9') i++;
                        string num = text.Substring(st, i - st);
                        if (num.Length == 0 || num.Length > 15 || (num.Length > 1 && num[0] == '0')) { why = key + " is not a plain string or a whole number"; return null; }
                        val = "n" + num;
                    }
                    if (d.ContainsKey(key)) { why = key + " appears twice"; return null; }
                    if (Array.IndexOf(required, key) < 0 && Array.IndexOf(optional, key) < 0) { why = "unknown key " + key; return null; }
                    d[key] = val;
                    ws();
                    if (i < n && text[i] == ',') { i++; ws(); continue; }
                    if (i < n && text[i] == '}') { i++; break; }
                    why = "malformed"; return null;
                }
            ws();
            if (i != n) { why = "text after the object"; return null; }
            foreach (string k in required) if (!d.ContainsKey(k)) { why = "missing " + k; return null; }
            return d;
        }
        private static void RefuseRequest(ChartBridgeClient client, string type, string why)
        {
            client.Send("{\"type\":\"status\",\"level\":\"warn\",\"text\":" + CbJson.Str("ChartBridge refused a " + type + " message: " + why) + "}");
        }
        // The page's request as parsed: a string value ("s..."), a whole number ("n..."), or null when absent.
        private static string StrOf(Dictionary<string, string> d, string k) { string v; return d.TryGetValue(k, out v) && v.StartsWith("s", StringComparison.Ordinal) ? v.Substring(1) : null; }
        private static string NumOf(Dictionary<string, string> d, string k) { string v; return d.TryGetValue(k, out v) && v.StartsWith("n", StringComparison.Ordinal) ? v.Substring(1) : null; }

        // ---------------------------------------------------------- 0.3.7: the prior settlement
        // The settlement of the session BEFORE the current trading session (sessions run 18:00 to 17:00 ET; ChartBridgeCme).
        // From NinjaTrader's own settlement for the contract: MarketData.Settlement (a MarketDataEventArgs; NinjaTrader's help,
        // MarketData: "Snapshot data is provided right on subscription"), read when market data is subscribed, and every
        // OnMarketData event of MarketDataType.Settlement after that. Only a price above 0 counts, never the last close.
        // Each value is tagged with the trading day it belongs to, from NinjaTrader's time on it (SettlementDay); a value
        // whose time cannot say which session it settles (stamped inside a later session) is not used. The prior for the
        // session running now is the value of the session day before it: today's settlement, in after the afternoon close,
        // waits until the next session starts at 18:00 (over a weekend or a CME holiday, until the next session's 18:00 open);
        // then it is the prior. With no dated value for that day the prior is null: never an estimate. Pages get it in
        // "hello" (each instrument's "settlement" and "settlementDate") and as {"type":"settlement","root","p","date"}
        // whenever it changes (a new value for that day, or the 18:00 roll). The last two dated values per contract are kept
        // in settlements.txt in ChartBridge's folder, so a restart in the evening still knows the prior; each line names its
        // contract, and a line for another contract than the one served now (the roll) is ignored (review B2 S1).
        private class SettleRoot
        {
            public string Contract;                  // the contract the values are for (a new one starts over)
            public readonly SortedDictionary<DateTime, double> ByDate = new SortedDictionary<DateTime, double>();   // trading day -> settlement
            public double RawP = double.NaN; public DateTime RawNt; public string RawFrom; public DateTime? RawDay; public double RawAtUtcMs = -1;
            public bool Sent; public DateTime SentDay; public double SentP = double.NaN;   // the prior the pages were last told
        }
        private static readonly Dictionary<string, SettleRoot> Settlements = new Dictionary<string, SettleRoot>();
        private static readonly object SettleFileLock = new object(), SettleTickLock = new object();
        private static volatile bool settleLoaded = true;   // false from Start until settlements.txt is read (nothing is written before)
        // 0.3.8: values stamped 16:00 to 17:00 ET that came before settlements.txt was read, with no day before's value to
        // compare yet: judged again once it is read ({root, contract, price, ntTime, from}; Settlements lock).
        private static readonly List<object[]> SettlePending = new List<object[]>();
        private static volatile bool settleReadFailed;      // the file could not be read: never rewritten from memory this run (it may hold what memory lacks)
        private static readonly List<string> SettleOtherRoots = new List<string>();   // lines for roots not configured now, written back as they were (Settlements lock)
        private static int settleSaveQueued;
        public const int SettlementsKept = 2;
        private static string SettlementFile { get { return Path.Combine(ChartBridgeConfig.Folder, "settlements.txt"); } }
        private static bool SameP(double a, double b) { return double.IsNaN(a) ? double.IsNaN(b) : !double.IsNaN(b) && ChartBridgeSides.PriceKey(a) == ChartBridgeSides.PriceKey(b); }
        private static string Day(DateTime d) { return d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture); }

        // The trading day a settlement stamped at NinjaTrader time ntTime belongs to, or null when the time cannot say. A
        // date-only stamp (00:00) is that date. Otherwise (0.3.8, Anthony): the latest day with a Globex session
        // whose settlement could be out by then (16:00 ET; 12:00 on an NYSE holiday or early close, when CME halts early),
        // as long as the next session's settlement time has not come yet: NinjaTrader keeps the last settlement and stamps
        // it when it is read, so on HOME 10-01's settlement came stamped 20:43 ET that evening (inside the next session),
        // and it is 10-01's. A value stamped after the next session's settlement time could be either day's: null, not used.
        // 0.3.8 buffer (Anthony): between the settlement time and the session's close (16:00 to 17:00 ET) NinjaTrader can
        // still hold the day before's value, so such a stamp is provisional: NoteSettlement uses it only when it differs from
        // the day before's stored value. From the close (17:00 ET) on it is the day's.
        public static DateTime? SettlementDay(DateTime ntTime) { bool prov; return SettlementDay(ntTime, NowNt(), out prov); }
        public static DateTime? SettlementDay(DateTime ntTime, DateTime nowNt) { bool prov; return SettlementDay(ntTime, nowNt, out prov); }
        // nowNt: a date-only stamp for a day counts only once that day's settlement time has passed (review B2 N1).
        public static DateTime? SettlementDay(DateTime ntTime, DateTime nowNt, out bool provisional) { return SettlementDay(ntTime, nowNt, out provisional, null); }
        // root (0.4.0): a quote-only market settles earlier than the equity index rule's 16:00 ET (CL 14:30, GC 13:30, ZN 15:00,
        // ChartBridgeMarkets.EarliestSettlement); null or an index root: the rule as before.
        public static DateTime? SettlementDay(DateTime ntTime, DateTime nowNt, out bool provisional, string root)
        {
            provisional = false;
            if (ntTime.TimeOfDay == TimeSpan.Zero)
            {
                DateTime d0 = ntTime.Date;
                if (!ChartBridgeCme.SessionDay(d0)) return null;
                try { if (TimeZoneInfo.ConvertTimeFromUtc(ChartBridgeTime.ToUtc(nowNt), ChartBridgeTime.Eastern) < d0.Add(ChartBridgeMarkets.EarliestSettlement(root, d0))) return null; }
                catch (Exception) { return null; }
                return d0;
            }
            DateTime et = TimeZoneInfo.ConvertTimeFromUtc(ChartBridgeTime.ToUtc(ntTime), ChartBridgeTime.Eastern);
            for (DateTime d = et.Date; d > et.Date.AddDays(-14); d = d.AddDays(-1))
            {
                if (!ChartBridgeCme.SessionDay(d) || d.Add(ChartBridgeMarkets.EarliestSettlement(root, d)) > et) continue;
                for (DateTime n = d.AddDays(1); n < d.AddDays(15); n = n.AddDays(1))
                    if (ChartBridgeCme.SessionDay(n))
                    {
                        if (et >= n.Add(ChartBridgeMarkets.EarliestSettlement(root, n))) return null;
                        provisional = et < d.Add(ChartBridgeCme.SessionClose(d));
                        return d;
                    }
                return null;
            }
            return null;
        }
        // Why a settlement stamp gives no day (the Output window line).
        private static string UndatedWhy(DateTime ntTime, string root)
        {
            if (ntTime.TimeOfDay == TimeSpan.Zero)
            {
                DateTime d0 = ntTime.Date;
                if (!ChartBridgeCme.SessionDay(d0)) return "is dated " + Day(d0) + ", a day with no Globex session, so it is not used";
                return "is dated " + Day(d0) + ", and that day's settlement is not due before " + d0.Add(ChartBridgeMarkets.EarliestSettlement(root, d0)).ToString("HH:mm", CultureInfo.InvariantCulture) +
                       " ET, so it is not used yet (a date-only stamp counts once that time has passed)";
            }
            return "is stamped " + EtText(ntTime) + " ET, after the next session's settlement time (or before any): which session it settles is not known, so it is not used";
        }
        // The prior settlement for the session running at NinjaTrader time now: its day, and the value (NaN when none).
        private static void PriorSettlement(string root, DateTime nowNt, out DateTime day, out double p)
        {
            day = ChartBridgeCme.PreviousSession(ChartBridgeCme.CurrentSession(TimeZoneInfo.ConvertTimeFromUtc(ChartBridgeTime.ToUtc(nowNt), ChartBridgeTime.Eastern)));
            p = double.NaN;
            Instrument inst = ServedInstrumentFor(root);
            string contract = inst != null ? inst.FullName : null;
            lock (Settlements) { SettleRoot s; double v; if (Settlements.TryGetValue(root, out s) && s.Contract == contract && s.ByDate.TryGetValue(day, out v)) p = v; }
        }

        public static void NoteSettlement(string root, double price, DateTime ntTime, string from) { NoteSettlement(root, null, price, ntTime, from); }

        // 0.3.8: Settlement updates from OnMarketData, handled one at a time in arrival order on a pool thread. 0.4.0: the
        // snapshot read at subscription too (from: "snapshot" or "update").
        private static readonly ConcurrentQueue<object[]> SettleQueue = new ConcurrentQueue<object[]>();
        private static int settleDraining;
        private static void QueueSettlement(string root, string contract, double price, DateTime ntTime, string from)
        {
            SettleQueue.Enqueue(new object[] { root, contract, price, ntTime, from });
            if (Interlocked.CompareExchange(ref settleDraining, 1, 0) == 0) Task.Run(() => DrainSettlements());
        }
        private static void DrainSettlements()
        {
            for (;;)
            {
                object[] x;
                while (SettleQueue.TryDequeue(out x))
                {
                    try { NoteSettlement((string)x[0], (string)x[1], (double)x[2], (DateTime)x[3], (string)x[4]); }
                    catch (Exception ex) { Log("settlement error: " + ex.Message); }
                }
                Interlocked.Exchange(ref settleDraining, 0);
                if (SettleQueue.IsEmpty || Interlocked.CompareExchange(ref settleDraining, 1, 0) != 0) return;   // more came: go on (unless another drain took them)
            }
        }
        // The harness: true once every queued update has been handled.
        public static bool SettlementsIdle { get { return SettleQueue.IsEmpty && Volatile.Read(ref settleDraining) == 0; } }
        // contract: the instrument the value came with (null: the contract served for root now).
        public static void NoteSettlement(string root, string contract, double price, DateTime ntTime, string from)
        {
            if (root == null || double.IsNaN(price) || double.IsInfinity(price) || !(price > 0)) return;
            if (contract == null) { Instrument inst = ServedInstrumentFor(root); contract = inst != null ? inst.FullName : null; }
            bool provisional;
            DateTime? day = SettlementDay(ntTime, NowNt(), out provisional, root);
            bool stored = false, undated = false;
            string waitWhy = null;
            lock (Settlements)
            {
                SettleRoot s;
                if (!Settlements.TryGetValue(root, out s)) { s = new SettleRoot(); Settlements[root] = s; }
                if (s.Contract != contract) { s.Contract = contract; s.ByDate.Clear(); }   // another contract (a roll): its own values only
                bool again = SameP(s.RawP, price) && s.RawNt == ntTime;
                if (day.HasValue)
                {
                    // 0.3.8 (Anthony and the coordinator): a value equal to the day before's stored one is never used, whatever its
                    // stamp (NinjaTrader can still hold the day before's value; two equal settlements in a row are rare, and a
                    // blank is safer than a wrong change). With none stored: from the close on it is the day's (HOME's first
                    // evening); before the close (16:00 to 17:00) it waits. A value that came before settlements.txt was read,
                    // with nothing stored yet to compare, is held and judged once it is read.
                    DateTime before = ChartBridgeCme.PreviousSession(day.Value);
                    double old;
                    bool known = s.ByDate.TryGetValue(before, out old);
                    if (!known && !settleLoaded)
                    {
                        SettlePending.Add(new object[] { root, contract, price, ntTime, from });   // judged once settlements.txt is read
                        return;
                    }
                    if (known ? SameP(old, price) : provisional)
                    {
                        if (!again) waitWhy = "is stamped " + EtText(ntTime) + " ET (the " + Day(day.Value) + " session's), and " +
                            (known ? "equals " + Day(before) + "'s settlement, so it may still be the day before's: not used; waiting for a value that differs"
                                   : "came before that session's close at " + day.Value.Add(ChartBridgeCme.SessionClose(day.Value)).ToString("HH:mm", CultureInfo.InvariantCulture) +
                                     " ET with no settlement for " + Day(before) + " known to compare it with: not used; waiting for a value that differs, or one stamped after the close");
                        day = null;
                    }
                }
                s.RawP = price; s.RawNt = ntTime; s.RawFrom = from; s.RawDay = day; s.RawAtUtcMs = ChartBridgeTime.NowUtcMs();
                if (day.HasValue)
                {
                    double was;
                    if (!s.ByDate.TryGetValue(day.Value, out was) || !SameP(was, price))
                    {
                        s.ByDate[day.Value] = price; stored = true;
                        while (s.ByDate.Count > 4) s.ByDate.Remove(s.ByDate.Keys.First());
                    }
                }
                else undated = !again;
            }
            if (stored)
            {
                SaveSettlementsSoon();
                Log(root + " settlement " + CbJson.Num(price) + " for the session of " + Day(day.Value) + " (NinjaTrader's, " + from + ", stamped " + EtText(ntTime) + " ET)");
            }
            if (waitWhy != null) Log(root + " settlement " + CbJson.Num(price) + " (NinjaTrader's, " + from + ") " + waitWhy);
            else if (undated) Log(root + " settlement " + CbJson.Num(price) + " (NinjaTrader's, " + from + ") " + UndatedWhy(ntTime, root));
            SettlementTick();
        }
        // Pages get the prior when it changes: a new value for its day, or the next session's start (every second, HtfPushMs).
        private static void SettlementTick() { lock (SettleTickLock) SettlementTickLocked(); }   // one at a time: compare and send in order (N2)
        private static void SettlementTickLocked()
        {
            DateTime now = NowNt();
            List<string> roots = Instruments.Keys.ToList();
            lock (Settlements) foreach (string r in Settlements.Keys) if (!roots.Contains(r)) roots.Add(r);
            foreach (string root in roots)
            {
                DateTime day; double p;
                PriorSettlement(root, now, out day, out p);
                lock (Settlements)
                {
                    SettleRoot s;
                    if (!Settlements.TryGetValue(root, out s)) { s = new SettleRoot(); Settlements[root] = s; }
                    if (s.Sent && s.SentDay == day && SameP(s.SentP, p)) continue;
                    bool first = !s.Sent;
                    s.Sent = true; s.SentDay = day; s.SentP = p;
                    if (first && double.IsNaN(p)) continue;   // nothing known yet: hello already says null
                }
                string json = "{\"type\":\"settlement\",\"root\":" + CbJson.Str(root) + ",\"p\":" + (double.IsNaN(p) ? "null" : CbJson.Num(p)) + ",\"date\":" + CbJson.Str(Day(day)) + "}";
                foreach (ChartBridgeClient c in Clients.Values) c.Send(json);
            }
        }
        // hello's fields for one instrument: the prior settlement for the session running now, and its day.
        private static string SettlementHelloFields(string root, Dictionary<string, string> seen)
        {
            DateTime day; double p;
            PriorSettlement(root, NowNt(), out day, out p);
            string f = ",\"settlement\":" + (double.IsNaN(p) ? "null" : CbJson.Num(p)) + ",\"settlementDate\":" + CbJson.Str(Day(day));
            if (seen != null) seen[root] = f;
            return f;
        }
        // A page registered before its hello went out can miss a "settlement" sent to every page in between (settlements.txt read
        // just after a start, or a new value), or get it ahead of a hello built a moment earlier. So, after hello: for any root
        // whose prior is now not what hello said, this page gets "settlement" with the value as it is now (after hello, so the
        // page ends with the right value; a later change reaches it like every page).
        private static void SettlementAfterHello(ChartBridgeClient client, Dictionary<string, string> seen)
        {
            try
            {
                DateTime now = NowNt();
                foreach (KeyValuePair<string, string> kv in seen)
                {
                    DateTime day; double p;
                    PriorSettlement(kv.Key, now, out day, out p);
                    string f = ",\"settlement\":" + (double.IsNaN(p) ? "null" : CbJson.Num(p)) + ",\"settlementDate\":" + CbJson.Str(Day(day));
                    if (f != kv.Value)
                        client.Send("{\"type\":\"settlement\",\"root\":" + CbJson.Str(kv.Key) + ",\"p\":" + (double.IsNaN(p) ? "null" : CbJson.Num(p)) + ",\"date\":" + CbJson.Str(Day(day)) + "}");
                }
            }
            catch (Exception ex) { Log("settlement after hello: " + ex.Message); }
        }
        // settlements.txt: "ROOT yyyy-MM-dd price CONTRACT" (the contract last, it has a space), the last SettlementsKept days
        // per root, replaced through a temp file. Written off NinjaTrader's thread, one writer at a time, each from the state
        // as it is then (so the last write is the newest), and never before the file was read at a start (N2, N3).
        private static void SaveSettlementsSoon()
        {
            if (!settleLoaded) return;   // the load writes it once done
            if (Interlocked.Exchange(ref settleSaveQueued, 1) == 0) Task.Run(() => { Interlocked.Exchange(ref settleSaveQueued, 0); SaveSettlements(); });
        }
        private static void SaveSettlements()
        {
            if (settleReadFailed) return;   // reading failed at start: the file is left as it is (said once in the Output window then)
            lock (SettleFileLock)
            {
                List<string> lines = new List<string>();
                lock (Settlements) lines.AddRange(SettleOtherRoots);   // roots not configured now: kept, not dropped
                lock (Settlements)
                    foreach (KeyValuePair<string, SettleRoot> kv in Settlements.OrderBy(x => x.Key, StringComparer.Ordinal))
                        if (kv.Value.Contract != null)
                            foreach (KeyValuePair<DateTime, double> d in kv.Value.ByDate.Skip(Math.Max(0, kv.Value.ByDate.Count - SettlementsKept)))
                                lines.Add(kv.Key + " " + Day(d.Key) + " " + CbJson.Num(d.Value) + " " + kv.Value.Contract);
                try
                {
                    string f = SettlementFile;
                    Directory.CreateDirectory(Path.GetDirectoryName(f));
                    File.WriteAllLines(f + ".tmp", lines.ToArray());
                    if (File.Exists(f)) File.Delete(f);
                    File.Move(f + ".tmp", f);
                }
                catch (Exception ex) { Log("settlements.txt not saved: " + ex.Message); }
            }
        }
        // At Start, off NinjaTrader's thread (N3): the values kept before, for the contracts served now only (a line for another
        // contract, the one before a roll, is ignored: S1). Then the pages get the prior if it changed, and the file is written
        // once with whatever came in meanwhile.
        private static void LoadSettlementsSoon() { settleLoaded = false; settleReadFailed = false; lock (Settlements) { SettleOtherRoots.Clear(); SettlePending.Clear(); } Task.Run(() => { try { LoadSettlements(); } catch (Exception ex) { Log("settlements.txt error: " + ex.Message); settleReadFailed = true; SettleLoadDone(); } }); }
        // settlements.txt is read (or failed): from now on values are judged at once; the ones held meanwhile are judged now.
        private static void SettleLoadDone()
        {
            List<object[]> held;
            lock (Settlements) { settleLoaded = true; held = new List<object[]>(SettlePending); SettlePending.Clear(); }
            foreach (object[] h in held) NoteSettlement((string)h[0], (string)h[1], (double)h[2], (DateTime)h[3], (string)h[4]);
        }
        private static void LoadSettlements()
        {
            string[] lines = new string[0];
            lock (SettleFileLock)
            {
                try { if (File.Exists(SettlementFile)) lines = File.ReadAllLines(SettlementFile); }
                catch (Exception ex) { settleReadFailed = true; Log("settlements.txt not read: " + ex.Message + "; it is not rewritten this run (the priors from it are not known until a settlement comes in)"); }
            }
            int ignored = 0;
            lock (Settlements)
                foreach (string line in lines)
                {
                    string[] f = line.Trim().Split(new[] { ' ' }, 4);
                    DateTime d; double p;
                    if (f.Length != 4 || !DateTime.TryParseExact(f[1], "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out d)
                        || !double.TryParse(f[2], NumberStyles.Float, CultureInfo.InvariantCulture, out p) || !(p > 0)) { ignored++; continue; }
                    Instrument inst = ServedInstrumentFor(f[0]);
                    if (inst == null && !Settlements.ContainsKey(f[0])) { SettleOtherRoots.Add(line.Trim()); continue; }   // a root not configured now: kept for when it is again
                    if (inst == null || inst.FullName != f[3]) { ignored++; continue; }   // not the contract served now
                    SettleRoot s;
                    if (!Settlements.TryGetValue(f[0], out s)) { s = new SettleRoot(); Settlements[f[0]] = s; }
                    if (s.Contract != f[3]) { s.Contract = f[3]; s.ByDate.Clear(); }
                    if (!s.ByDate.ContainsKey(d)) s.ByDate[d] = p;
                }
            if (ignored > 0) Log("settlements.txt: " + ignored + " line(s) not for a contract served now (or unreadable) ignored");
            SettleLoadDone();
            SaveSettlements();
            SettlementTick();
        }
        private static string SettlementsJson()
        {
            DateTime now = NowNt();
            List<string> roots; lock (Settlements) roots = Settlements.Keys.OrderBy(x => x, StringComparer.Ordinal).ToList();
            StringBuilder b = new StringBuilder("{");
            foreach (string root in roots)
            {
                DateTime day; double p;
                PriorSettlement(root, now, out day, out p);
                lock (Settlements)
                {
                    SettleRoot s = Settlements[root];
                    if (b.Length > 1) b.Append(',');
                    b.Append(CbJson.Str(root)).Append(":{\"prior\":{\"date\":").Append(CbJson.Str(Day(day))).Append(",\"p\":").Append(double.IsNaN(p) ? "null" : CbJson.Num(p)).Append('}');
                    b.Append(",\"byDate\":{").Append(string.Join(",", s.ByDate.Select(kv => CbJson.Str(Day(kv.Key)) + ":" + CbJson.Num(kv.Value)).ToArray())).Append('}');
                    b.Append(",\"last\":");
                    if (double.IsNaN(s.RawP)) b.Append("null");
                    else b.Append("{\"p\":").Append(CbJson.Num(s.RawP)).Append(",\"ntTime\":").Append(CbJson.Str(EtText(s.RawNt))).Append(",\"day\":").Append(s.RawDay.HasValue ? CbJson.Str(Day(s.RawDay.Value)) : "null")
                          .Append(",\"from\":").Append(CbJson.Str(s.RawFrom ?? "")).Append(",\"receivedUtcMs\":").Append(CbJson.Num3(s.RawAtUtcMs)).Append('}');
                    b.Append('}');
                }
            }
            return b.Append('}').ToString();
        }

        // ---------------------------------------------------------- 0.3.7: higher-timeframe bars (4h, 1D, 1W)
        // A page asks ("htf": root, tf "4h", "1D" or "1W", optional id) for NinjaTrader's own 240-minute, day or week bars.
        // ChartBridge asks NinjaTrader once per root and timeframe, BY COUNT (BarsRequest(instrument, HtfBarsBack), Minute 240,
        // Day 1 or Week 1, the instrument's trading hours, NinjaTrader's merge setting as the chart), through the gate LAST:
        // only when no window or backfill is out or queued, no minute chart's last trades are out and no page is loading; a
        // request NinjaTrader does not answer in HtfTimeoutMs is given up and frees the gate (the chart never waits). The
        // answer is kept (one per root and timeframe): a second page or a reload is served from memory, and the forming bar is
        // kept live from the live trades ChartBridge already has (no NinjaTrader request per trade). Asked again at a request
        // in a later trading day (18:00 ET), after a feed drop, or after a failure (not within HtfRetryMs of it). A page that
        // asked gets "htfBar" with the forming bar at most once a second while it changes (HtfPushMs).
        public static int HtfBarsBack = 300, HtfTimeoutMs = 15000, HtfQueueMs = 120000, HtfRetryMs = 60000, HtfPushMs = 1000;
        public const int HtfKeep = 400, HtfWatchMax = 12, HtfCollectMax = 500000;
        public static readonly string[] HtfFrames = { "4h", "1D", "1W" };
        private class HtfSeries
        {
            public string Root, Tf, Name;
            public List<double[]> Bars;              // [t, o, h, l, c, v], oldest first, the last forming; null before the first answer
            public bool Asking, Stale; public DateTime Day; public int Version, Asks, Served; public double AskedMs = -1, AnsweredMs = -1, CallbackMs = -1, FailedMs = -1;
            public string Error;
            public List<SeamTick> Collect;           // live trades from the answer's callback until its bars are in (applied then)
            public readonly List<KeyValuePair<ChartBridgeClient, string>> Waiters = new List<KeyValuePair<ChartBridgeClient, string>>();   // one per page (its latest id)
            public int Gen;                          // bumped when Bars is replaced by a new answer
            public string PrefixKey, PrefixText;     // the closed bars' text (they never change), cached; only the forming bar is new each time
        }
        // A page's series: HasHistory once it was sent bars (only then does it get "htfBar", review B2 N5).
        public class HtfWatch { public string Root, Tf; public int Version = -1; public double LastT = double.MinValue; public bool HasHistory; }
        // What an answer needs, copied under HtfLock in microseconds and formatted with no lock held (review B2 S2): the closed bars'
        // cached text, or a copy of them when it is not cached yet, and a copy of the forming bar.
        private class HtfSnap { public string Name, Key, Prefix; public double[][] Closed; public double[] Last; public int Version; }
        private static HtfSnap HtfSnapLocked(HtfSeries s)
        {
            HtfSnap n = new HtfSnap { Name = s.Name, Version = s.Version };
            int c = s.Bars != null ? s.Bars.Count : 0;
            if (c == 0) { n.Prefix = ""; return n; }
            n.Key = s.Gen + "|" + c + "|" + s.Bars[0][0].ToString("R", CultureInfo.InvariantCulture) + "|" + s.Bars[c - 1][0].ToString("R", CultureInfo.InvariantCulture);
            if (s.PrefixKey == n.Key) n.Prefix = s.PrefixText;
            else { n.Closed = new double[c - 1][]; for (int i = 0; i < c - 1; i++) n.Closed[i] = (double[])s.Bars[i].Clone(); }
            n.Last = (double[])s.Bars[c - 1].Clone();
            return n;
        }
        // The "bars" array text of a snapshot, built with no lock held; the closed bars' text is kept for the next answer.
        private static string HtfBarsText(HtfSeries s, HtfSnap n)
        {
            if (n.Last == null) return "[]";
            string prefix = n.Prefix;
            if (prefix == null)
            {
                StringBuilder pb = new StringBuilder(n.Closed.Length * 56);
                foreach (double[] x in n.Closed) { if (pb.Length > 0) pb.Append(','); AppendHtfBar(pb, x); }
                prefix = pb.ToString();
                lock (HtfLock) { s.PrefixKey = n.Key; s.PrefixText = prefix; }
            }
            StringBuilder b = new StringBuilder(prefix.Length + 80);
            b.Append('[').Append(prefix);
            if (prefix.Length > 0) b.Append(',');
            AppendHtfBar(b, n.Last);
            return b.Append(']').ToString();
        }
        private static void AppendHtfBar(StringBuilder b, double[] x)
        {
            b.Append('['); CbJson.AppendNum3(b, x[0]);
            for (int k = 1; k < 5; k++) { b.Append(','); CbJson.AppendNum(b, x[k]); }
            b.Append(','); CbJson.AppendLong(b, (long)x[5]); b.Append(']');
        }
        // The page now has this series' bars as of the snapshot: htfBar follows from there.
        private static void HtfHasHistory(ChartBridgeClient c, string root, string tf, HtfSnap n)
        {
            if (n == null || n.Last == null) return;
            lock (c.Htf) { HtfWatch w; if (c.Htf.TryGetValue(root + " " + tf, out w)) { w.HasHistory = true; w.Version = n.Version; w.LastT = n.Last[0]; } }
        }
        private static void AddWaiter(HtfSeries s, ChartBridgeClient client, string id)
        {
            for (int i = 0; i < s.Waiters.Count; i++)
                if (s.Waiters[i].Key == client) { s.Waiters[i] = new KeyValuePair<ChartBridgeClient, string>(client, id); return; }   // one per page: its latest id
            s.Waiters.Add(new KeyValuePair<ChartBridgeClient, string>(client, id));
        }
        private static readonly object HtfLock = new object();
        private static readonly Dictionary<string, HtfSeries> Htf = new Dictionary<string, HtfSeries>();
        private static readonly List<GateJob> GateHtfJobs = new List<GateJob>();
        private static System.Threading.Timer htfTimer;

        // The start of the bar holding New York wall time et (bar-time seconds): 4h bars from the session's 18:00 ET open (18:00,
        // 22:00, 02:00, 06:00, 10:00, 14:00 to the 17:00 close), 1D the trading day (the date the session ends on, 00:00), 1W the
        // Monday of that trading day's week.
        public static double HtfStart(string tf, double et)
        {
            double day = Math.Floor((et + 21600) / 86400);   // the trading day (sessions from 18:00 ET)
            if (tf == "4h") { double open = day * 86400 - 21600; return open + Math.Floor((et - open) / 14400) * 14400; }
            if (tf == "1D") return day * 86400;
            double dow = ((day + 4) % 7 + 7) % 7;             // 0 Sunday (1970-01-01 was a Thursday)
            return (day - (dow + 6) % 7) * 86400;
        }
        // A NinjaTrader bar's start, from its stamp: intraday bars are stamped at their close, so a 4h bar is the one holding the
        // instant before it; day and week bars carry their session's date (at 00:00, or the session's close: either way the
        // trading day of the instant before the stamp, when it has a time of day).
        public static double HtfStartOfStamp(string tf, DateTime ntStamp)
        {
            if (tf != "4h" && ntStamp.TimeOfDay == TimeSpan.Zero)
                return HtfStart(tf, (ntStamp.Date - new DateTime(1970, 1, 1)).TotalSeconds + 43200);   // midday of that date: its own trading day
            double et = ChartBridgeTime.EtSeconds(ChartBridgeTime.ToUtc(ntStamp));
            return HtfStart(tf, et - 0.001);
        }
        // NinjaTrader's bars as the page gets them: start-stamped, oldest first; two bars on one start (they should not be) merged.
        public static List<double[]> HtfFromBars(string tf, RawBars raw)
        {
            List<double[]> l = new List<double[]>(raw.Count + 8);
            for (int i = 0; i < raw.Count; i++)
            {
                double t = HtfStartOfStamp(tf, raw.Time[i]);
                double[] last = l.Count > 0 ? l[l.Count - 1] : null;
                if (last != null && t < last[0]) continue;   // out of order: never sent backwards
                if (last != null && t == last[0]) { last[2] = Math.Max(last[2], raw.High[i]); last[3] = Math.Min(last[3], raw.Low[i]); last[4] = raw.Close[i]; last[5] += raw.Volume[i]; continue; }
                l.Add(new double[] { t, raw.Open[i], raw.High[i], raw.Low[i], raw.Close[i], raw.Volume[i] });
            }
            return l;
        }
        // Under HtfLock: one live trade into a series' forming bar (a new bar when its start is later; an older trade ignored).
        private static void HtfApply(HtfSeries s, double et, double p, long v)
        {
            if (s.Bars == null) return;
            double t = HtfStart(s.Tf, et);
            double[] last = s.Bars.Count > 0 ? s.Bars[s.Bars.Count - 1] : null;
            if (last != null && t < last[0]) return;
            if (last != null && t == last[0]) { if (p > last[2]) last[2] = p; if (p < last[3]) last[3] = p; last[4] = p; last[5] += v; }
            else { s.Bars.Add(new double[] { t, p, p, p, p, v }); if (s.Bars.Count > HtfKeep) s.Bars.RemoveAt(0); }
            s.Version++;
        }
        // OnMarketData, for every live trade (after the book): a few additions per series of that root, under HtfLock.
        private static void HtfOnTrade(string root, DateTime t, double et, double p, long v)
        {
            lock (HtfLock)
            {
                if (Htf.Count == 0) return;
                foreach (string tf in HtfFrames)
                {
                    HtfSeries s;
                    if (!Htf.TryGetValue(root + " " + tf, out s)) continue;
                    if (s.Collect != null) { if (s.Collect.Count < HtfCollectMax) s.Collect.Add(new SeamTick { Time = t, Price = p, Volume = v, Side = 0, Method = 0, Json = null }); }
                    else HtfApply(s, et, p, v);
                }
            }
        }

        private static void OnHtfMessage(ChartBridgeClient client, string text)
        {
            string why;
            Dictionary<string, string> d = ParseStrict(text, new[] { "type", "root", "tf" }, new[] { "id" }, out why);
            string root = d != null ? StrOf(d, "root") : null, tf = d != null ? StrOf(d, "tf") : null, id = d != null && d.ContainsKey("id") ? NumOf(d, "id") : null;
            if (d == null) { RefuseRequest(client, "htf", why); return; }
            if (root == null || tf == null || (d.ContainsKey("id") && id == null)) { RefuseRequest(client, "htf", "root and tf must be strings, id a whole number"); return; }
            if (Array.IndexOf(HtfFrames, tf) < 0) { RefuseRequest(client, "htf", "tf must be 4h, 1D or 1W"); return; }
            Instrument inst = ServedInstrumentFor(root);
            if (inst == null) { client.Send(HtfJson(root, tf, id, null, null, "ChartBridge does not serve " + root)); return; }
            lock (client.Htf)
            {
                string wk = root + " " + tf;
                if (!client.Htf.ContainsKey(wk))
                {
                    if (client.Htf.Count >= HtfWatchMax) { client.Send(HtfJson(root, tf, id, null, null, "at most " + HtfWatchMax + " higher-timeframe charts per page")); return; }
                    client.Htf[wk] = new HtfWatch { Root = root, Tf = tf };
                }
            }
            HtfServe(client, inst, root, tf, id);
        }

        private static void HtfServe(ChartBridgeClient client, Instrument inst, string root, string tf, string id)
        {
            string error = null; bool ask = false; HtfSeries s; HtfSnap snap = null;
            DateTime today = ChartBridgeCme.TradingDay(TimeZoneInfo.ConvertTimeFromUtc(ChartBridgeTime.ToUtc(NowNt()), ChartBridgeTime.Eastern));
            string stuck; lock (GateLock) stuck = gateStuck;
            lock (HtfLock)
            {
                string key = root + " " + tf;
                if (!Htf.TryGetValue(key, out s)) { s = new HtfSeries { Root = root, Tf = tf, Name = inst.FullName }; Htf[key] = s; }
                bool fresh = s.Bars != null && !s.Stale && s.Day == today;
                bool backoff = s.FailedMs >= 0 && ChartBridgeTime.NowUtcMs() - s.FailedMs < HtfRetryMs;
                if (fresh || (s.Bars != null && (backoff || stuck != null) && !s.Asking)) { snap = HtfSnapLocked(s); s.Served++; }
                else if (s.Asking) AddWaiter(s, client, id);
                else if (stuck != null) error = "NinjaTrader has not answered an earlier request (" + stuck + ") yet; asked again once it has";
                else if (backoff) error = "the last request failed (" + s.Error + "); asked again " + (HtfRetryMs / 1000) + " s after it at the earliest";
                else { s.Asking = true; s.Name = inst.FullName; AddWaiter(s, client, id); ask = true; }
            }
            if (snap != null) { client.Send(HtfJson(root, tf, id, snap.Name, HtfBarsText(s, snap), null)); HtfHasHistory(client, root, tf, snap); return; }
            if (error != null) { client.Send(HtfJson(root, tf, id, null, null, error)); return; }
            if (ask) HtfAsk(s, inst, today);
        }

        // The page's answer: bars (or none, with the error), the request's id echoed (null when the page sent none).
        private static string HtfJson(string root, string tf, string id, string name, string barsText, string error)
        {
            StringBuilder b = new StringBuilder(96 + (barsText != null ? barsText.Length : 2));
            b.Append("{\"type\":\"htf\",\"root\":").Append(CbJson.Str(root)).Append(",\"tf\":").Append(CbJson.Str(tf)).Append(",\"id\":").Append(id ?? "null");
            b.Append(",\"name\":").Append(name != null ? CbJson.Str(name) : "null").Append(",\"bars\":").Append(barsText ?? "[]");
            b.Append(",\"error\":").Append(error != null ? CbJson.Str(error) : "null").Append('}');
            return b.ToString();
        }
        private static void HtfAsk(HtfSeries s, Instrument inst, DateTime today)
        {
            GateJob j = new GateJob { Kind = "htf", Root = s.Root + " " + s.Tf, TimeoutMs = HtfTimeoutMs, FreesGate = true };
            double queuedMs = ChartBridgeTime.NowUtcMs();
            j.Start = done => HtfRun(s, inst, today, j, done);
            j.OnTimeout = () => HtfFailed(s, "NinjaTrader did not answer within " + (HtfTimeoutMs / 1000) + " s");
            j.OnStuck = stuck => HtfFailed(s, "NinjaTrader has not answered an earlier request (" + stuck + ") yet");
            j.OnDropped = () => HtfFailed(s, "ChartBridge stopped before the request went out");
            j.OnExpire = why => HtfFailed(s, why);
            j.QueuedMs = queuedMs;
            string stuckNow; bool stopped;
            lock (GateLock)
            {
                stopped = gateStopped; stuckNow = stopped ? null : gateStuck;
                if (!stopped && stuckNow == null) GateHtfJobs.Add(j);
            }
            if (stopped) { Dropped(j); return; }
            if (stuckNow != null) { j.OnStuck(stuckNow); return; }
            GateKick();
        }

        private static void HtfRun(HtfSeries s, Instrument inst, DateTime today, GateJob j, Action done)
        {
            try
            {
                lock (HtfLock) { s.Asks++; s.AskedMs = ChartBridgeTime.NowUtcMs(); }
                BarsRequest req0 = new BarsRequest(inst, HtfBarsBack);
                req0.BarsPeriod = s.Tf == "4h" ? new BarsPeriod { BarsPeriodType = BarsPeriodType.Minute, Value = 240 }
                    : new BarsPeriod { BarsPeriodType = s.Tf == "1D" ? BarsPeriodType.Day : BarsPeriodType.Week, Value = 1 };
                req0.TradingHours = inst.MasterInstrument.TradingHours;   // the chart's template (merge policy: NinjaTrader's setting, as the chart)
                req0.Request(new Action<BarsRequest, ErrorCode, string>((req, code, message) =>
                {
                    if (j.Stop.IsCancellationRequested) { try { req.Dispose(); } catch (Exception) { } return; }   // stopped since: dropped, not copied
                    if (!Claim(j)) { try { req.Dispose(); } catch (Exception) { } if (LateAnswer(j)) GateUnstuck(j, j.Kind + " " + j.Root); return; }   // given up first: dropped
                    Stopwatch sw = Stopwatch.StartNew();
                    RawBars raw = null; string error = null;
                    try
                    {
                        if (code != ErrorCode.NoError) error = "NinjaTrader refused the request: " + code + " " + message;
                        else if (req.Bars == null || req.Bars.Count == 0) error = "NinjaTrader has no " + s.Tf + " bars for " + inst.FullName;
                        else { lock (HtfLock) s.Collect = new List<SeamTick>(256); raw = RawBars.Copy(req.Bars, false); }   // the one copy on NinjaTrader's thread
                    }
                    catch (Exception ex) { error = "could not copy the bars: " + ex.Message; raw = null; }
                    finally { try { req.Dispose(); } catch (Exception) { } }
                    double cbMs = sw.Elapsed.TotalMilliseconds;
                    done();
                    RawBars copy = raw; string err = error;
                    Task.Run(() => HtfAnswered(s, copy, err, today, cbMs));
                }));
            }
            catch (Exception ex) { done(); HtfFailed(s, "the request failed: " + ex.Message); }
        }

        private static void HtfAnswered(HtfSeries s, RawBars raw, string error, DateTime today, double cbMs)
        {
            if (raw == null) { HtfFailed(s, error ?? "no answer"); return; }
            List<double[]> bars;
            try { bars = HtfFromBars(s.Tf, raw); }
            catch (Exception ex) { HtfFailed(s, "could not read the bars: " + ex.Message); return; }
            List<KeyValuePair<ChartBridgeClient, string>> waiters;
            HtfSnap snap;
            lock (HtfLock)
            {
                if (!s.Asking) { s.Collect = null; return; }   // stopped meanwhile (Stop clears the series)
                while (bars.Count > HtfKeep) bars.RemoveAt(0);
                s.Bars = bars; s.Gen++; s.Day = today; s.Stale = false; s.Error = null; s.FailedMs = -1; s.CallbackMs = cbMs; s.AnsweredMs = ChartBridgeTime.NowUtcMs();
                if (s.Collect != null)
                {
                    ChartBridgeTime.EtCache et = new ChartBridgeTime.EtCache();
                    foreach (SeamTick h in s.Collect) HtfApply(s, et.Seconds(h.Time), h.Price, h.Volume);
                    s.Collect = null;
                }
                s.Asking = false; s.Version++;
                waiters = new List<KeyValuePair<ChartBridgeClient, string>>(s.Waiters); s.Waiters.Clear();
                s.Served += waiters.Count;
                snap = HtfSnapLocked(s);
            }
            string text = HtfBarsText(s, snap);   // once, with no lock held (review B2 S2)
            foreach (KeyValuePair<ChartBridgeClient, string> w in waiters) { w.Key.Send(HtfJson(s.Root, s.Tf, w.Value, snap.Name, text, null)); HtfHasHistory(w.Key, s.Root, s.Tf, snap); }
        }

        // A request that failed: its pages get the bars ChartBridge already has (kept live), or none and the reason.
        private static void HtfFailed(HtfSeries s, string why)
        {
            // A failure blocks a new request for HtfRetryMs (review: say when it can be asked again, not just "ask again").
            why += "; it can be asked again in " + (HtfRetryMs / 1000) + " s (from " + EtText(NowNt()) + " ET)";
            List<KeyValuePair<ChartBridgeClient, string>> waiters;
            HtfSnap snap = null;
            lock (HtfLock)
            {
                if (!s.Asking) return;
                s.Asking = false; s.Collect = null; s.Error = why; s.FailedMs = ChartBridgeTime.NowUtcMs();
                waiters = new List<KeyValuePair<ChartBridgeClient, string>>(s.Waiters); s.Waiters.Clear();
                if (s.Bars != null) snap = HtfSnapLocked(s);
            }
            Log("higher-timeframe bars " + s.Root + " " + s.Tf + ": " + why);
            string text = snap != null ? HtfBarsText(s, snap) : null;
            foreach (KeyValuePair<ChartBridgeClient, string> w in waiters)
            {
                if (snap != null) { w.Key.Send(HtfJson(s.Root, s.Tf, w.Value, snap.Name, text, null)); HtfHasHistory(w.Key, s.Root, s.Tf, snap); }
                else w.Key.Send(HtfJson(s.Root, s.Tf, w.Value, null, null, why));
            }
        }

        // Every HtfPushMs: each page's watched series whose forming bar changed since it was last sent gets "htfBar" with the bars
        // from the last one it has (the closed bar's final values when a new bar began, then the forming one).
        private static void HtfPush()
        {
            foreach (ChartBridgeClient c in Clients.Values)
            {
                List<HtfWatch> watches;
                lock (c.Htf) { if (c.Htf.Count == 0) continue; watches = c.Htf.Values.ToList(); }
                foreach (HtfWatch w in watches)
                {
                    List<double[]> bars = new List<double[]>(2);
                    int version; double lastT;
                    lock (c.Htf) { if (!w.HasHistory) continue; }   // N5: only a page that has this series' bars
                    lock (HtfLock)
                    {
                        HtfSeries s;
                        if (!Htf.TryGetValue(w.Root + " " + w.Tf, out s) || s.Bars == null || s.Bars.Count == 0 || s.Version == w.Version) continue;
                        lastT = s.Bars[s.Bars.Count - 1][0];
                        double from = w.LastT == double.MinValue ? lastT : Math.Min(w.LastT, lastT);
                        for (int i = Math.Max(0, s.Bars.Count - 3); i < s.Bars.Count; i++) if (s.Bars[i][0] >= from) bars.Add((double[])s.Bars[i].Clone());
                        version = s.Version;
                    }
                    StringBuilder b = new StringBuilder(200);
                    b.Append("{\"type\":\"htfBar\",\"root\":").Append(CbJson.Str(w.Root)).Append(",\"tf\":").Append(CbJson.Str(w.Tf)).Append(",\"bars\":[");
                    for (int i = 0; i < bars.Count; i++) { if (i > 0) b.Append(','); AppendHtfBar(b, bars[i]); }
                    b.Append("]}");
                    lock (c.Htf) { w.Version = version; w.LastT = lastT; }
                    c.Send(b.ToString());
                }
            }
        }
        // A feed drop (market open) on a root: its series miss trades; asked again at the next request.
        private static void HtfFeedDropped(string root)
        {
            lock (HtfLock) foreach (HtfSeries s in Htf.Values) if (root == null || s.Root == root) s.Stale = true;
        }
        // A request queued longer than HtfQueueMs (the chart's own requests kept going first) is taken back: its pages get
        // the bars in memory, or none and why, and may ask again.
        private static void HtfExpire()
        {
            List<GateJob> old = new List<GateJob>();
            double now = ChartBridgeTime.NowUtcMs();
            lock (GateLock) { old = GateHtfJobs.Where(x => now - x.QueuedMs > HtfQueueMs).ToList(); foreach (GateJob x in old) GateHtfJobs.Remove(x); }
            foreach (GateJob x in old) { try { if (x.OnExpire != null) x.OnExpire("not asked: the chart's own requests kept NinjaTrader busy for " + (HtfQueueMs / 1000) + " s"); } catch (Exception) { } }
        }
        private static string HtfDiagJson()
        {
            StringBuilder b = new StringBuilder("{");
            lock (HtfLock)
                foreach (HtfSeries s in Htf.Values.OrderBy(x => x.Root + " " + x.Tf, StringComparer.Ordinal))
                {
                    if (b.Length > 1) b.Append(',');
                    b.Append(CbJson.Str(s.Root + " " + s.Tf)).Append(":{\"bars\":").Append(s.Bars != null ? s.Bars.Count : 0)
                     .Append(",\"asking\":").Append(s.Asking ? "true" : "false").Append(",\"waiting\":").Append(s.Waiters.Count)
                     .Append(",\"day\":").Append(s.Bars != null ? CbJson.Str(s.Day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)) : "null")
                     .Append(",\"stale\":").Append(s.Stale ? "true" : "false").Append(",\"asks\":").Append(s.Asks).Append(",\"served\":").Append(s.Served)
                     .Append(",\"askedAtUtcMs\":").Append(s.AskedMs >= 0 ? CbJson.Num3(s.AskedMs) : "null")
                     .Append(",\"answerMs\":").Append(s.AnsweredMs >= 0 && s.AskedMs >= 0 ? CbJson.Num3(s.AnsweredMs - s.AskedMs) : "null")
                     .Append(",\"callbackMs\":").Append(s.CallbackMs >= 0 ? CbJson.Num3(s.CallbackMs) : "null")
                     .Append(",\"lastError\":").Append(s.Error != null ? CbJson.Str(s.Error) : "null").Append('}');
                }
            return b.Append('}').ToString();
        }
        private static void HtfReset()
        {
            lock (HtfLock)
            {
                foreach (HtfSeries s in Htf.Values) { s.Asking = false; s.Waiters.Clear(); s.Collect = null; }
                Htf.Clear();
            }
        }

        // ---------------------------------------------------------- 0.3.7: the weekly volume profile, on request
        // A page asks ("weekProfile": root, optional id) for the volume at price of the last WeekSessions finished sessions of a
        // root (the session running now is the page's own "profile"). Built only from the session tables ChartBridge keeps (the
        // finished ones in memory, and profile-<ROOT>-<date>.txt for the ones before a restart): never a NinjaTrader request. A
        // session with no table (ChartBridge was not running, or its file is gone) is listed with "missing" and why; a table
        // that is not whole says so (whole, coveredFrom, drop), as the profile does. Sessions are the days with a Globex session
        // (ChartBridgeCme), so a weekend or a CME holiday is not "missing". Read and formatted off NinjaTrader's thread.
        public const int WeekSessions = 5;
        private static void OnWeekProfileMessage(ChartBridgeClient client, string text)
        {
            string why;
            Dictionary<string, string> d = ParseStrict(text, new[] { "type", "root" }, new[] { "id" }, out why);
            if (d == null) { RefuseRequest(client, "weekProfile", why); return; }
            string root = StrOf(d, "root"), id = d.ContainsKey("id") ? NumOf(d, "id") : null;
            if (root == null || (d.ContainsKey("id") && id == null)) { RefuseRequest(client, "weekProfile", "root must be a string, id a whole number"); return; }
            Instrument inst = ServedInstrumentFor(root);
            if (inst == null) { client.Send("{\"type\":\"weekProfile\",\"root\":" + CbJson.Str(root) + ",\"id\":" + (id ?? "null") + ",\"tick\":null,\"sessions\":[],\"rows\":[],\"error\":" + CbJson.Str("ChartBridge does not serve " + root) + "}"); return; }
            // review B2 S2: one answer in progress per page; requests meanwhile are folded per root (the latest id of each root is
            // answered once, in the order the roots were first asked), so a request for another root is never lost
            lock (client.Htf)
            {
                if (client.WeekBusy)
                {
                    string[] had = client.WeekQueue.FirstOrDefault(q => q[0] == root);
                    if (had != null) had[1] = id; else if (client.WeekQueue.Count < 16) client.WeekQueue.Add(new[] { root, id });
                    return;
                }
                client.WeekBusy = true;
            }
            Task.Run(() =>
            {
                string r = root, i = id;
                while (true)
                {
                    try
                    {
                        Instrument ri = ServedInstrumentFor(r);
                        if (ri == null) client.Send("{\"type\":\"weekProfile\",\"root\":" + CbJson.Str(r) + ",\"id\":" + (i ?? "null") + ",\"tick\":null,\"sessions\":[],\"rows\":[],\"error\":" + CbJson.Str("ChartBridge does not serve " + r) + "}");
                        else client.Send(WeekProfileJson(BookOf(r, ri), i, TimeZoneInfo.ConvertTimeFromUtc(ChartBridgeTime.ToUtc(NowNt()), ChartBridgeTime.Eastern)));
                    }
                    catch (Exception ex) { Log("weekly profile error: " + ex.Message); client.Send("{\"type\":\"weekProfile\",\"root\":" + CbJson.Str(r) + ",\"id\":" + (i ?? "null") + ",\"tick\":null,\"sessions\":[],\"rows\":[],\"error\":" + CbJson.Str(ex.Message) + "}"); }
                    lock (client.Htf)
                    {
                        if (client.WeekQueue.Count == 0) { client.WeekBusy = false; return; }
                        r = client.WeekQueue[0][0]; i = client.WeekQueue[0][1];
                        client.WeekQueue.RemoveAt(0);
                    }
                }
            });
        }
        // The answer's body after its id, per root, kept while the same session tables answer (review B2 S2): a repeat is
        // served from here, with nothing copied under the book's lock.
        private static readonly Dictionary<string, string[]> WeekCache = new Dictionary<string, string[]>();   // root -> {key, body}
        // The last `count` finished sessions at New York time nowEt: days with a Globex session whose 17:00 ET close has passed.
        public static List<DateTime> FinishedSessions(DateTime nowEt, int count)
        {
            List<DateTime> l = new List<DateTime>();
            for (DateTime d = nowEt.Date.AddDays(1); l.Count < count && d > nowEt.Date.AddDays(-40); d = d.AddDays(-1))
                if (ChartBridgeCme.SessionDay(d) && d.AddHours(17) <= nowEt) l.Add(d);
            l.Reverse();
            return l;
        }
        public static string WeekProfileJson(RootBook book, string id, DateTime nowEt)
        {
            List<DateTime> days = FinishedSessions(nowEt, WeekSessions);
            bool load; lock (book.Sync) load = !book.PastLoaded;
            if (load)
            {
                // the saved tables, once per book (a restart keeps them on disk); a file that cannot be read is "missing"
                Dictionary<DateTime, SessionTable> read = new Dictionary<DateTime, SessionTable>();
                foreach (DateTime d in days)
                {
                    string f = book.PastFile(d);
                    try { if (File.Exists(f)) { SessionTable t = RootBook.ParseTable(File.ReadAllText(f)); if (t != null && SessionTable.TradingDate(t.StartEt) == d) read[d] = t; } }
                    catch (Exception ex) { Log("weekly profile: " + f + " not read: " + ex.Message); }
                }
                lock (book.Sync)
                {
                    foreach (KeyValuePair<DateTime, SessionTable> kv in read) if (!book.Past.ContainsKey(kv.Key)) book.Past[kv.Key] = kv.Value;
                    while (book.Past.Count > RootBook.PastKept) book.Past.Remove(book.Past.Keys.Min());
                    book.PastLoaded = true;
                }
            }
            // which table answers each day, found under the book's lock (a few lookups); the cache key says which they are
            List<SessionTable> tables = new List<SessionTable>();
            SessionTable live = null; long liveTrades = 0;
            StringBuilder kb = new StringBuilder();
            lock (book.Sync)
            {
                foreach (DateTime d in days)
                {
                    SessionTable t;
                    if (!book.Past.TryGetValue(d, out t)) t = null;
                    if (t == null && book.Table != null && SessionTable.TradingDate(book.Table.StartEt) == d) { t = book.Table; live = t; liveTrades = t.Trades; }   // finished, the next not begun yet
                    if (t == null && book.Last != null && SessionTable.TradingDate(book.Last.StartEt) == d) t = book.Last;
                    tables.Add(t);
                    kb.Append(d.ToString("yyyyMMdd", CultureInfo.InvariantCulture)).Append(':').Append(t == null ? "-" : System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(t) + "/" + t.Volume + "/" + t.Vol.Count + "/" + (t.Whole ? 1 : 0) + (t.Dropped ? "d" : "")).Append(t == live ? "/" + liveTrades : "").Append(';');
                }
            }
            string key = kb.ToString(), head = "{\"type\":\"weekProfile\",\"root\":" + CbJson.Str(book.Root) + ",\"id\":" + (id ?? "null");
            lock (WeekCache) { string[] c; if (WeekCache.TryGetValue(book.Root, out c) && c[0] == key) return head + c[1]; }
            // per session: price -> volume. A finished table that is Last or kept in Past never changes and is read with no lock;
            // only the book's current table (finished, in the 17:00 break) is copied under the book's lock. Summed with none held.
            StringBuilder b = new StringBuilder(4096);
            b.Append(",\"tick\":").Append(CbJson.Num(book.Tick));
            b.Append(",\"sessions\":[");
            Dictionary<long, long> all = new Dictionary<long, long>();
            for (int i = 0; i < days.Count; i++)
            {
                if (i > 0) b.Append(',');
                b.Append("{\"date\":").Append(CbJson.Str(days[i].ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)));
                SessionTable t = tables[i];
                if (t == null) { b.Append(",\"missing\":").Append(CbJson.Str("no table: ChartBridge was not running for this session, or its file is gone")).Append('}'); continue; }
                Dictionary<long, long> rows = new Dictionary<long, long>();
                long[] keys, vals;
                if (t == live) lock (book.Sync) { keys = t.Vol.Keys.ToArray(); vals = t.Vol.Values.ToArray(); }
                else { keys = t.Vol.Keys.ToArray(); vals = t.Vol.Values.ToArray(); }
                for (int k = 0; k < keys.Length; k++)
                {
                    long p = (long)(uint)(keys[k] & 0xFFFFFFFFL), was;   // as the profile rows read it
                    rows.TryGetValue(p, out was); rows[p] = was + vals[k];
                    all.TryGetValue(p, out was); all[p] = was + vals[k];
                }
                b.Append(",\"from\":"); CbJson.AppendNum3(b, t.StartEt);
                b.Append(",\"whole\":").Append(t.Whole ? "true" : "false").Append(",\"coveredFrom\":"); CbJson.AppendNum3(b, t.CoveredFromEt);
                b.Append(",\"drop\":");
                if (!t.Dropped) b.Append("null"); else { b.Append("{\"at\":"); CbJson.AppendNum3(b, t.DropAtEt); b.Append(",\"why\":").Append(CbJson.Str(t.DropWhy ?? "")).Append('}'); }
                b.Append(",\"rows\":"); AppendPriceRows(b, rows);
                b.Append('}');
            }
            b.Append("],\"rows\":"); AppendPriceRows(b, all);
            string body = b.Append(",\"error\":null}").ToString();
            lock (WeekCache) WeekCache[book.Root] = new[] { key, body };
            return head + body;
        }
        private static void AppendPriceRows(StringBuilder b, Dictionary<long, long> rows)
        {
            b.Append('[');
            bool first = true;
            foreach (KeyValuePair<long, long> kv in rows.OrderBy(x => x.Key))
            {
                if (kv.Value <= 0) continue;
                if (!first) b.Append(','); first = false;
                b.Append('['); CbJson.AppendLong(b, kv.Key); b.Append(','); CbJson.AppendLong(b, kv.Value); b.Append(']');
            }
            b.Append(']');
        }

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
            b.Append(",\"minuteTailRebuilt\":").Append(L.TailRebuilt);
            b.Append(",\"ntTailVolume\":").Append(L.NtTailVolume >= 0 ? L.NtTailVolume.ToString(CultureInfo.InvariantCulture) : "null");
            b.Append(",\"rebuiltTailVolume\":").Append(L.RebuiltTailVolume >= 0 ? L.RebuiltTailVolume.ToString(CultureInfo.InvariantCulture) : "null");
            // 0.6.8: NinjaTrader's last minute bar (its close stamp), the minute book's From, the bars it filled (-1: not used),
            // closed minutes NinjaTrader had more volume for, the time limits, and the hole recorded (never sent to the page)
            b.Append(",\"minuteLastBar\":").Append(EtOrNull(L.NtLastBar));
            b.Append(",\"bookFrom\":").Append(L.Book != null && L.Book.Started ? CbJson.Str(EtText(new DateTime(L.Book.From, L.Book.Kind))) : "null");
            b.Append(",\"bookFilled\":").Append(L.Filled);
            b.Append(",\"bookShortMinutes\":").Append(L.ShortMinutes);
            b.Append(",\"minuteTimedOut\":").Append(L.MinuteTimedOut ? "true" : "false");
            b.Append(",\"tailTimedOut\":").Append(L.TailTimedOut ? "true" : "false");
            b.Append(",\"hole\":").Append(L.Hole != null ? CbJson.Str(L.Hole) : "null");
            b.Append(",\"tailKeptAfter\":").Append(L.TailKeptAfter);
            b.Append(",\"standIn\":").Append(L.StoodIn ? "true" : "false").Append(",\"agent\":").Append(L.Agent ? "true" : "false")
             .Append(",\"minuteFailed\":").Append(L.MinuteFailed ? "true" : "false").Append(",\"fromKept\":").Append(L.FromKept ? "true" : "false");
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
        // Per instrument: the live counts and quote (0.3.7: the by-date backfill's "lastLoad" went with it).
        private static string SidesJson()
        {
            StringBuilder b = new StringBuilder("{");
            List<string> roots = Instruments.Keys.ToList();
            lock (LiveSides) foreach (string r in LiveSides.Keys) if (!roots.Contains(r)) roots.Add(r);
            bool first = true;
            foreach (string root in roots)
            {
                LiveSideTagger t;
                lock (LiveSides) LiveSides.TryGetValue(root, out t);
                if (!first) b.Append(','); first = false;
                b.Append(CbJson.Str(root)).Append(":{\"live\":").Append(t != null ? t.DiagJson() : "null").Append('}');
            }
            return b.Append('}').ToString();
        }

        // ---------------------------------------------------------- fills (read only)
        // Two ways in, so a fill is never missed: the account's ExecutionUpdate event, and a poll of
        // each account's Executions every 2 seconds. Each execution is delivered once (keyed by
        // account and execution id). Order and position events are only counted, for /diag.
        // 0.4.0: Seen is in memory only, on purpose (see HealthJson): after a recompile the session's executions go to The Desk
        // again, which stores each (source, account, exec_id) once.
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
        // 0.5.0: the execution's own Order (NinjaTrader's Execution.Order) while it is delivered, so the fills "by" never scans.
        [ThreadStatic] private static Order execOrder;

        private static void Deliver(string account, Instrument inst, MarketPosition side, int qty, double price, DateTime time, string id, string orderId,
                                    List<string> deskBatch)
        {
            string json = ExecJson(account, inst, side, qty, price, time, id, orderId, true);
            foreach (ChartBridgeClient c in Clients.Values) c.Send(json);
            try { ChartBridgeBot.OnExec(account, inst, side, qty, price, orderId, json); } catch (Exception ex) { Log("bot fill error: " + ex.Message); }   // 0.4.0 bot: its trades, losses and fills
            try { ChartBridgeAgents.OnExec(account, inst, side, qty, price, orderId, json); } catch (Exception ex) { Log("agent fill error: " + ex.Message); }   // 0.5.0 agents: each agent's trades, losses and fills
            if (!ChartBridgeConfig.PostFills) return;
            string desk = DeskFillJson(account, inst, side, qty, price, time, id, orderId, execOrder);
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
                    execOrder = x.Order;   // 0.5.0: for the fills "by"
                    try { Deliver(a.Name, x.Instrument, x.MarketPosition, x.Quantity, x.Price, x.Time, x.ExecutionId, x.OrderId, batch); } finally { execOrder = null; }
                    n++;
                }
                lock (Replayed) Replayed.Add(a.Name);   // 0.5.0 agents: read through without an error (an agent's stale records wait for it)
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
            fresh = fresh.Where(ChartBridgeAccounts.SeenConnected).ToList();   // 0.5.1: only accounts seen Connected this NinjaTrader session
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
            foreach (Account a in added) ChartBridgeOrders.SeedNoted(a);   // 0.4.3: fills from before the watch are in its position already (outside the Watched lock: review 10)
            // Fills that happened before this account was watched (earlier this session) go to The Desk too;
            // The Desk ignores ones it already has.
            int n = 0;
            foreach (Account a in added) n += CatchUp(a);
            if (n > 0) ChartBridgeDesk.Flush();
        }

        // 0.5.0 agents: true once this account's executions of the session were read through without an error since its watch began
        // (WatchAccounts' CatchUp, or a later poll's when that one failed).
        public static bool ExecutionsReplayed(string account) { if (account == null) return false; lock (Replayed) return Replayed.Contains(account); }

        // Order code calls this before trading an account: an account that just connected may not be watched yet,
        // and an unwatched account's fills and order updates would never reach the page.
        // 0.4.3: watched already (no watch attempt): the copier's every-second order look skips the rest
        public static bool IsWatched(Account a) { if (a == null) return false; lock (Watched) return Watched.Contains(a); }

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
            lock (Replayed) Replayed.Clear();   // 0.5.0 agents
            lock (Seen) Seen.Clear();
        }

        private static void OnOrderUpdate(object sender, OrderEventArgs e)
        {
            Account a = sender as Account;
            Count(a != null ? a.Name : "", 1);
            try { ChartBridgeOrders.OnOrderUpdate(a, e); } catch (Exception ex) { Log("order update error: " + ex.Message); }
            try { ChartBridgeStops.Observe(a, e); } catch (Exception ex) { Log("stop record error: " + ex.Message); }   // 0.6.6: the stop record to The Desk (ChartBridgeStops.cs)
            try { ChartBridgeOrderRecord.Observe(a, e); } catch (Exception ex) { Log("order record error: " + ex.Message); }   // 0.6.9: the order record to The Desk (ChartBridgeOrderRecord.cs; it only adds to a queue in memory)
        }

        private static void OnPositionUpdate(object sender, PositionEventArgs e)
        {
            Account a = sender as Account;
            Count(a != null ? a.Name : "", 2);
            try { ChartBridgeOrders.OnPositionUpdate(a, e); } catch (Exception ex) { Log("position update error: " + ex.Message); }
            try { ChartBridgeBot.OnPosition(a, e); } catch (Exception ex) { Log("bot position error: " + ex.Message); }   // 0.4.0 bot
            try { ChartBridgeAgents.OnPosition(a, e); } catch (Exception ex) { Log("agent position error: " + ex.Message); }   // 0.5.0 agents
        }

        // GET /diag: what ChartBridge sees, for checking why fills do or do not arrive. This PC only.
        private static string DiagJson()
        {
            StringBuilder b = new StringBuilder("{");
            b.Append("\"version\":").Append(CbJson.Str(Version));
            b.Append(",\"clockOffsetMs\":").Append(CbJson.Num3(ChartBridgeTime.UtcMs(DateTime.UtcNow) - ChartBridgeTime.NowUtcMs()));
            b.Append(",\"pcClock\":").Append(ChartBridgeClock.DiagJson());   // 0.5.6: this PC's clock against a time server (clockOffsetMs is ChartBridge's own clock against the PC's)
            b.Append(",\"fillEventsDelivered\":").Append(Interlocked.Read(ref eventNew));
            b.Append(",\"fillsFoundByPolling\":").Append(Interlocked.Read(ref polledNew));
            b.Append(",\"lastPollUtcMs\":").Append(lastPollMs);
            b.Append(",\"clients\":").Append(Clients.Count);
            b.Append(",\"pages\":[").Append(string.Join(",", Clients.Values.Select(c => c.DiagJson()).ToArray())).Append(']');   // 0.3.4: each page's queue and lag
            b.Append(",\"network\":").Append(ChartBridgeAccess.DiagJson());
            b.Append(",\"pin\":").Append(ChartBridgePin.DiagJson());   // whether a PIN is set, nothing else
            b.Append(",\"desk\":").Append(ChartBridgeDesk.DiagJson());
            b.Append(",\"stops\":").Append(ChartBridgeStops.DiagJson());   // 0.6.6: the stop record to The Desk
            b.Append(",\"orderRecord\":").Append(ChartBridgeOrderRecord.DiagJson());   // 0.6.9: the order record to The Desk, and the decision ids
            b.Append(",\"bars\":").Append(ChartBridgeBars.DiagJson());   // 0.3.6: daily 1-minute bars to The Desk
            b.Append(",\"seams\":").Append(SeamsJson());   // 0.3.3: where each load's backfill met the live trades
            b.Append(",\"historyNotes\":").Append(HistoryNotesJson());   // 0.6.8: the history path's notes (also history.log)
            b.Append(",\"sides\":").Append(SidesJson());
            b.Append(",\"books\":").Append(BooksJson());       // 0.3.5: per instrument, the session table, its backfill and the served window
            b.Append(",\"settlements\":").Append(SettlementsJson());   // 0.3.7: NinjaTrader's settlement per root
            b.Append(",\"htf\":").Append(HtfDiagJson());               // 0.3.7: higher-timeframe bars per root and timeframe
            b.Append(",\"health\":").Append(HealthJson());           // 0.4.0: memory, thread headroom, page connects and closes, send times, errors
            b.Append(",\"markets\":").Append(ChartBridgeMarkets.DiagJson(Instruments.ToList()));   // 0.4.0: each served root's contract, how it was found, quote only or not
            b.Append(",\"tape\":").Append(ChartBridgeTape.DiagJson());   // 0.4.0: how the live trades arrive, per root and 15 minutes
            if (ChartBridgeOrders.MergeOn) b.Append(",\"merges\":").Append(ChartBridgeOrders.MergeDiagJson());   // 0.4.0 B4: with merge = on
            if (ChartBridgeCopier.Enabled) b.Append(",\"copier\":").Append(ChartBridgeCopier.DiagJson());   // 0.4.0 copier: counts only, never account names
            if (ChartBridgeBot.Enabled) b.Append(",\"bot\":").Append(ChartBridgeBot.DiagJson());   // 0.4.0 bot: counts only, never the secret
            if (ChartBridgeAgents.Enabled) b.Append(",\"agents\":").Append(ChartBridgeAgents.DiagJson());   // 0.5.0 agents: per id counts and state, never a secret
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

        // ---------------------------------------------------------- 0.4.0: /diag "health"
        // memory: the sizes of what grows while ChartBridge runs, and when it was last cleaned up. Seen (fills delivered, one key
        // per execution) is only cleared at a stop: a key dropped while NinjaTrader still lists its execution would be delivered
        // again by the 2 s poll. After a recompile (F5) the session's executions go to The Desk once more; The Desk stores each
        // (source, account, exec_id) once and counts a repeat as a duplicate (TheDesk thedesk/fills.py insert_fills), so nothing
        // is stored twice, and a fill that reached neither The Desk nor pending_fills.jsonl before the F5 is still sent.
        private static double lastSweepMs = -1, lastWindowSweptMs = -1;
        private static long windowsSwept;
        private static string HealthJson()
        {
            int seen, sides, htf, week, settle, seams, windows;
            lock (Seen) seen = Seen.Count;
            lock (LiveSides) sides = LiveSides.Count;
            lock (HtfLock) htf = Htf.Count;
            lock (WeekCache) week = WeekCache.Count;
            lock (Settlements) settle = Settlements.Count;
            lock (Seams) seams = Seams.Count;
            lock (Windows) windows = Windows.Count;
            List<RootBook> books; lock (Books) books = Books.Values.ToList();
            long past = 0, windowTrades = 0, liveHeld = 0, rows = 0;
            foreach (RootBook k in books)
                lock (k.Sync)
                {
                    past += k.Past.Count; if (k.Table != null) rows += k.Table.Vol.Count;
                    if (k.Cache != null) windowTrades += k.Cache.Count;
                    if (k.BackfillLive != null) liveHeld += k.BackfillLive.Count;
                    if (k.WindowLive != null) liveHeld += k.WindowLive.Count;
                }
            long heap = -1; int g0 = -1, g1 = -1, g2 = -1;
            try { heap = GC.GetTotalMemory(false); g0 = GC.CollectionCount(0); g1 = GC.CollectionCount(1); g2 = GC.CollectionCount(2); } catch (Exception) { }
            StringBuilder b = new StringBuilder("{\"memory\":{");
            b.Append("\"seenFills\":").Append(seen).Append(",\"books\":").Append(books.Count).Append(",\"pastSessions\":").Append(past).Append(",\"profileRows\":").Append(rows)
             .Append(",\"windowTrades\":").Append(windowTrades).Append(",\"liveTradesHeld\":").Append(liveHeld).Append(",\"sideTaggers\":").Append(sides)
             .Append(",\"htfSeries\":").Append(htf).Append(",\"weekProfiles\":").Append(week).Append(",\"settlementRoots\":").Append(settle)
             .Append(",\"seamsKept\":").Append(seams).Append(",\"windowsKept\":").Append(windows)
             .Append(",\"lastSweepUtcMs\":").Append(lastSweepMs >= 0 ? CbJson.Num3(lastSweepMs) : "null")
             .Append(",\"windowsDroppedAfterSession\":").Append(Interlocked.Read(ref windowsSwept))
             .Append(",\"lastWindowDropUtcMs\":").Append(lastWindowSweptMs >= 0 ? CbJson.Num3(lastWindowSweptMs) : "null")
             .Append(",\"heapBytes\":").Append(heap).Append(",\"gcGen0\":").Append(g0).Append(",\"gcGen1\":").Append(g1).Append(",\"gcGen2\":").Append(g2).Append('}');
            b.Append(",\"threads\":").Append(ChartBridgeHealth.ThreadsJson());
            b.Append(",\"pages\":").Append(ChartBridgeHealth.PagesJson());
            b.Append(",\"errors\":").Append(CbLogLimit.DiagJson());
            return b.Append('}').ToString();
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
        private static string DeskFillJson(string account, Instrument inst, MarketPosition side, int qty, double price, DateTime time, string id, string orderId) { return DeskFillJson(account, inst, side, qty, price, time, id, orderId, null); }

        private static string DeskFillJson(string account, Instrument inst, MarketPosition side, int qty, double price, DateTime time, string id, string orderId, Order order)
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
                ",\"order_id\":" + CbJson.Str(orderId) + FillBy(account, orderId, order) + ChartBridgeDecisions.FillField(account, orderId, order) + "}";   // 0.5.0: "by" when ChartBridge knows who placed it; 0.6.9: "decision_id" for a group entry's fill only
        }

        // 0.5.0 (contract section 8): ,"by":"agent:<id>", "bot" or "copier" when ChartBridge knows the fill's order as one of theirs;
        // "" otherwise, so every other fill is byte for byte as before. Reads the order by its id on that account.
        private static string FillBy(string account, string orderId, Order order)
        {
            if (order != null) { try { string own = ChartBridgeV3.SourceOf(order); return own == null ? "" : ",\"by\":" + CbJson.Str(own); } catch (Exception) { return ""; } }   // the execution's own order: no scan
            if (string.IsNullOrEmpty(orderId) || string.IsNullOrEmpty(account)) return "";
            try
            {
                Order o = null;
                List<Account> all;
                lock (Account.All) all = Account.All.ToList();
                foreach (Account a in all)
                {
                    if (a.Name != account) continue;
                    lock (a.Orders) foreach (Order x in a.Orders) if (x.OrderId == orderId) { o = x; break; }
                    break;
                }
                string by = ChartBridgeV3.SourceOf(o);
                return by == null ? "" : ",\"by\":" + CbJson.Str(by);
            }
            catch (Exception ex) { Log("fill by error: " + ex.Message); return ""; }
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
                execOrder = e.Execution != null ? e.Execution.Order : null;   // 0.5.0: for the fills "by"
                try { Deliver(name, inst, e.MarketPosition, e.Quantity, e.Price, e.Time, e.ExecutionId, e.OrderId, null); } finally { execOrder = null; }
                ChartBridgeDesk.Flush();
            }
            catch (Exception ex) { Log("fill error: " + ex.Message); }
        }
    }

    // ------------------------------------------------------------------ 0.5.6: this PC's clock against a time server (build list #77)
    // The page's feed delay is ChartBridge's receipt of a trade (rx, this PC's clock through ChartBridgeTime.NowUtcMs) minus the
    // exchange's time on it (u), so a PC clock that runs ahead reads as late data (2026-10-12: the laptop showed "feed 2435 ms",
    // and 122 ms after a Windows time sync). Every 5 minutes ChartBridge asks a time server what time it is (SNTP, RFC 4330: one
    // UDP packet to port 123 and its answer, 2 s at most) on a background thread of its own (the name lookup too, synchronous on
    // it: never NinjaTrader's thread or the thread pool's), and tells the pages how far this PC's clock is off ("pcClock" in hello and the "pcClock" message, nt8/PROTOCOL.md),
    // so the page can split the feed delay into the clock's part and the real one. It only measures: it never sets the clock
    // and never changes a setting of Windows or NinjaTrader.
    // config.txt: timeServer = time.windows.com (the default, the server Windows time sync uses); timeServer = off: no check.
    public static class ChartBridgeClock
    {
        public const string DefaultServer = "time.windows.com";
        public static int Port = 123;          // SNTP's port (the harness points it at a server of its own)
        public const int EveryMs = 300000;     // a check every 5 minutes
        public const int FirstAfterMs = 3000;  // the first one 3 s after a start
        public const int TimeoutMs = 2000;     // the answer gets 2 s; then "no answer" (the name lookup takes what Windows' own takes)
        public const double KeepMs = 1800000;  // a result is kept through failed checks for 30 minutes, then "not checked"
        public const double WarnMs = 500;      // off by this much or more: said in the Output window (the page warns at the same)
        public const double StepMs = 250;      // the PC clock changed by more than this (ChartBridgeTime): checked again at once
        public static string Server = DefaultServer;
        public static bool Off { get { return Server.Equals("off", StringComparison.OrdinalIgnoreCase); } }

        private static readonly object Sync = new object();
        private static bool has;                                  // a good answer is held
        private static double offsetMs, rttMs, atUtcMs;           // offset: the server's time minus this PC's (ChartBridge's clock)
        private static string answeredBy, why = "not checked yet";
        private static int changes, gen;                          // changes: every change the pages are told; gen: the running loop
        private static long checks, fails;
        private static string lastError;
        private static double lastTryUtcMs;
        private static int said;                                  // the Output window last said: 0 nothing, 1 an answer, 2 no answer
        private static bool saidOver;                             // it last said the clock is off by WarnMs or more
        private static AutoResetEvent wake;

        public static void ResetConfig() { Server = DefaultServer; }
        public static bool ReadConfig(string key, string val)
        {
            if (key != "timeServer") return false;
            Server = val.Length == 0 ? DefaultServer : val;
            return true;
        }

        public static int Changes { get { lock (Sync) return changes; } }

        // Back to "not checked yet" (a start); nothing is sent.
        public static void Reset()
        {
            lock (Sync)
            {
                has = false; offsetMs = rttMs = atUtcMs = 0; answeredBy = null; changes++;
                why = Off ? "the time check is off in config.txt (timeServer = off)" : "not checked yet";
                checks = fails = 0; faults = 0; lastError = null; lastTryUtcMs = 0; said = 0; saidOver = false;
            }
        }

        public static void Start()
        {
            Reset();
            if (Off) { ChartBridgeServer.Log("time check: off (config.txt timeServer = off); the page shows the feed delay as before"); return; }
            AutoResetEvent w = new AutoResetEvent(false);
            int g;
            lock (Sync) { g = ++gen; wake = w; }
            Thread t = new Thread(Loop) { IsBackground = true, Name = "ChartBridge time check", Priority = ThreadPriority.BelowNormal };
            t.Start(new object[] { g, w });
        }

        // The loop ends at its next wake; a check under way ends within its timeouts and its answer is dropped.
        public static void Stop()
        {
            AutoResetEvent w;
            lock (Sync) { gen++; w = wake; wake = null; }
            if (w != null) try { w.Set(); } catch (Exception) { }
        }

        private static void Loop(object state)
        {
            object[] a = (object[])state;
            int g = (int)a[0];
            AutoResetEvent w = (AutoResetEvent)a[1];
            int wait = FirstAfterMs, seen = -1;
            // Nothing may leave this loop as an exception: one unhandled on a background thread ends NinjaTrader. A fault is said
            // in the Output window and the loop waits its full interval again (never a hot spin), as the bars worker and the
            // copier guard theirs.
            while (true)
            {
                try { w.WaitOne(wait); } catch (Exception) { Thread.Sleep(wait); }
                if (Volatile.Read(ref gen) != g) return;
                wait = EveryMs;
                try
                {
                    Action fault = FaultForHarness;
                    if (fault != null) fault();
                    int now = Changes;
                    if (seen != -1 && now != seen) ToPages();   // the PC clock changed since the last check: the corrected offset first
                    string server = Server;
                    double off, rtt; string err;
                    bool ok = Ask(server, Port, out off, out rtt, out err);
                    if (Volatile.Read(ref gen) != g) return;
                    // An answer taken across a step of the PC clock is off by that step until the next check (the step itself
                    // corrects the held offset only from the moment it is seen); a step over StepMs asks again at once.
                    Note(server, ok, off, rtt, err, ChartBridgeTime.NowUtcMs());
                    seen = Changes;
                }
                catch (Exception ex)
                {
                    Interlocked.Increment(ref faults);
                    try { ChartBridgeServer.Log("time check error (" + ex.GetType().Name + ": " + ex.Message + "); checked again in 5 minutes"); } catch (Exception) { }
                }
            }
        }
        public static Action FaultForHarness;   // the harness: throws inside the loop's step
        private static int faults;

        // ChartBridgeTime followed a change of the PC clock (stepped ms; positive: the PC clock moved ahead). The offset held is
        // corrected by it at once (cheap: this runs on whatever thread read the clock); a change above StepMs is checked again now.
        public static void PcClockChanged(double stepped)
        {
            AutoResetEvent w = null;
            lock (Sync)
            {
                if (has) { offsetMs -= stepped; changes++; }
                if (Math.Abs(stepped) > StepMs) w = wake;
            }
            if (w != null) try { w.Set(); } catch (Exception) { }
        }

        // One check's outcome. An answer replaces what was held; no answer keeps a held answer for KeepMs, then says why.
        // The Output window gets a line when the first check answers or not, when that changes, and when the clock goes past
        // WarnMs or back under it; never one per check.
        public static void Note(string server, bool ok, double off, double rtt, string err, double nowMs)
        {
            string push = null, line = null, overLine = null;
            lock (Sync)
            {
                checks++; lastTryUtcMs = nowMs;
                if (ok)
                {
                    has = true; offsetMs = off; rttMs = rtt; atUtcMs = nowMs; answeredBy = server; why = null; lastError = null; changes++;
                    push = MessageLocked();
                    if (said != 1) line = "time check: " + Describe(off, server) + " (round trip " + Math.Round(rtt).ToString(CultureInfo.InvariantCulture) + " ms)" + (said == 2 ? ", answering again" : "") + ". ChartBridge only measures; it never sets the clock.";
                    said = 1;
                    bool over = Math.Abs(off) >= WarnMs;
                    if (over != saidOver)
                        overLine = over ? "this PC's clock is off by " + Seconds(off) + " s: the page's feed delay shows the clock's part apart. Windows can fix it: Settings, Time and language, Date and time, Sync now."
                                        : "this PC's clock is within " + Math.Round(WarnMs).ToString(CultureInfo.InvariantCulture) + " ms of " + server + " again";
                    saidOver = over;
                }
                else
                {
                    fails++; lastError = err;
                    bool keep = has && nowMs - atUtcMs <= KeepMs;
                    if (!keep)
                    {
                        string w = "no answer from " + server + " (" + err + ")";
                        if (has || why != w) { has = false; why = w; changes++; push = MessageLocked(); }
                    }
                    if (said != 2) line = "time check: no answer from " + server + " (" + err + ")" + (keep ? "; the last answer is kept for up to 30 minutes" : "; the page shows the feed delay as before (the clock not checked)") + ". Checked again every 5 minutes.";
                    said = 2;
                }
            }
            if (line != null) ChartBridgeServer.Log(line);
            if (overLine != null) ChartBridgeServer.Log(overLine);
            if (push != null) ChartBridgeServer.ToEveryPage(push);
        }

        private static string Describe(double off, string server)
        {
            double ahead = -off;
            return "this PC's clock is " + Math.Abs(Math.Round(ahead)).ToString(CultureInfo.InvariantCulture) + " ms " + (ahead >= 0 ? "ahead of " : "behind ") + server;
        }
        private static string Seconds(double ms) { return (Math.Abs(ms) / 1000).ToString("0.0", CultureInfo.InvariantCulture); }

        // hello's pcClock: {"checked":true,"offsetMs","rttMs","atUtcMs","server"} or {"checked":false,"why","server"}
        public static string Json() { lock (Sync) return JsonLocked(); }
        private static string JsonLocked()
        {
            if (has)
                return "{\"checked\":true,\"offsetMs\":" + CbJson.Num3(offsetMs) + ",\"rttMs\":" + CbJson.Num3(rttMs) + ",\"atUtcMs\":" + CbJson.Num3(atUtcMs) + ",\"server\":" + CbJson.Str(answeredBy) + "}";
            return "{\"checked\":false,\"why\":" + CbJson.Str(why) + ",\"server\":" + (Off ? "null" : CbJson.Str(Server)) + "}";
        }
        public static string MessageJson() { lock (Sync) return MessageLocked(); }
        private static string MessageLocked() { return "{\"type\":\"pcClock\"," + JsonLocked().Substring(1); }
        private static void ToPages() { ChartBridgeServer.ToEveryPage(MessageJson()); }

        // /diag pcClock: hello's fields and the counters
        public static string DiagJson()
        {
            lock (Sync)
            {
                string j = JsonLocked();
                return j.Substring(0, j.Length - 1) + ",\"checks\":" + checks + ",\"fails\":" + fails + ",\"lastError\":" + (lastError == null ? "null" : CbJson.Str(lastError)) +
                    ",\"faults\":" + Volatile.Read(ref faults) + ",\"lastTryUtcMs\":" + CbJson.Num3(lastTryUtcMs) + ",\"everyMs\":" + EveryMs + ",\"timeoutMs\":" + TimeoutMs + ",\"warnMs\":" + CbJson.Num(WarnMs) + "}";
            }
        }

        // One SNTP question and its answer; false with why when there is none. The times are ChartBridge's clock (the one rx is
        // stamped with), so the offset is exactly what the page's feed delay is off by.
        public static bool Ask(string server, int port, out double offset, out double rtt, out string err)
        {
            offset = 0; rtt = 0; err = null;
            try
            {
                // synchronous on this check's own thread (Begin/EndGetHostAddresses would resolve on a pool thread and leave a lookup
                // that timed out running): a slow lookup only delays this check, and Stop never waits for it
                IPAddress[] list = Dns.GetHostAddresses(server);
                IPAddress addr = list.FirstOrDefault(x => x.AddressFamily == AddressFamily.InterNetwork) ?? list.FirstOrDefault();
                if (addr == null) { err = "the name has no address"; return false; }
                using (Socket s = new Socket(addr.AddressFamily, SocketType.Dgram, ProtocolType.Udp))
                {
                    s.ReceiveTimeout = TimeoutMs; s.SendTimeout = TimeoutMs;
                    s.Connect(new IPEndPoint(addr, port));
                    byte[] req = new byte[48];
                    req[0] = 0x23;                         // leap indicator 0, version 4, mode 3 (client)
                    double t0 = ChartBridgeTime.NowUtcMs();
                    WriteStamp(req, 40, t0);               // the transmit time, which the server echoes as the originate time
                    s.Send(req);
                    byte[] res = new byte[512];
                    int n = s.Receive(res);
                    double t3 = ChartBridgeTime.NowUtcMs();
                    return Offset(req, res, n, t0, t3, out offset, out rtt, out err);
                }
            }
            catch (SocketException ex) { err = ex.SocketErrorCode == SocketError.TimedOut || ex.SocketErrorCode == SocketError.WouldBlock ? "no answer within " + (TimeoutMs / 1000) + " s: offline, or UDP port 123 blocked" : "network error: " + ex.SocketErrorCode; return false; }
            catch (Exception ex) { err = ex.GetType().Name + ": " + ex.Message; return false; }
        }

        // The SNTP four-timestamp formula (RFC 4330): t0 the question sent and t3 the answer received (this PC), t1 the question
        // received and t2 the answer sent (the server). offset = ((t1 - t0) + (t2 - t3)) / 2, the server's time minus this PC's;
        // round trip = (t3 - t0) - (t2 - t1). An answer that is not the server's to this very question, or from a server that
        // says its own clock is not set, is no answer.
        public static bool Offset(byte[] req, byte[] res, int n, double t0, double t3, out double offset, out double rtt, out string err)
        {
            offset = 0; rtt = 0; err = null;
            if (res == null || n < 48) { err = "a short answer (" + n + " bytes)"; return false; }
            int li = res[0] >> 6, mode = res[0] & 7, stratum = res[1];
            if (mode != 4) { err = "not a server's answer (mode " + mode + ")"; return false; }
            if (stratum == 0) { err = "the server turned the question down (" + Encoding.ASCII.GetString(res, 12, 4).Trim('\0', ' ') + ")"; return false; }
            if (li == 3 || stratum > 15) { err = "the server's own clock is not set"; return false; }
            for (int i = 0; i < 8; i++) if (res[24 + i] != req[40 + i]) { err = "the answer was not to this question"; return false; }
            double t1 = StampMs(res, 32), t2 = StampMs(res, 40);
            if (double.IsNaN(t1) || double.IsNaN(t2)) { err = "the answer has no times"; return false; }
            double r = (t3 - t0) - (t2 - t1);
            if (r < -5 || r > TimeoutMs + 1000) { err = "the times do not add up (round trip " + Math.Round(r).ToString(CultureInfo.InvariantCulture) + " ms)"; return false; }
            rtt = Math.Max(0, r);
            offset = ((t1 - t0) + (t2 - t3)) / 2;
            return true;
        }

        // NTP time: seconds since 1900 and a 32-bit fraction, big-endian. Seconds with the top bit clear are after 2036-02-07
        // (the next NTP era, RFC 4330 section 3). NaN for a zero time (not set).
        private const double NtpToUnixSec = 2208988800.0, TwoTo32 = 4294967296.0;
        public static double StampMs(byte[] b, int at)
        {
            uint sec = (uint)(b[at] << 24 | b[at + 1] << 16 | b[at + 2] << 8 | b[at + 3]);
            uint frac = (uint)(b[at + 4] << 24 | b[at + 5] << 16 | b[at + 6] << 8 | b[at + 7]);
            if (sec == 0 && frac == 0) return double.NaN;
            double s = sec;
            if ((sec & 0x80000000u) == 0) s += TwoTo32;
            return (s - NtpToUnixSec) * 1000 + frac * 1000.0 / TwoTo32;
        }
        public static void WriteStamp(byte[] b, int at, double unixMs)
        {
            double s = unixMs / 1000 + NtpToUnixSec;
            double whole = Math.Floor(s);
            uint sec = (uint)((ulong)whole & 0xFFFFFFFFul);
            uint frac = (uint)Math.Min(TwoTo32 - 1, Math.Floor((s - whole) * TwoTo32));
            b[at] = (byte)(sec >> 24); b[at + 1] = (byte)(sec >> 16); b[at + 2] = (byte)(sec >> 8); b[at + 3] = (byte)sec;
            b[at + 4] = (byte)(frac >> 24); b[at + 5] = (byte)(frac >> 16); b[at + 6] = (byte)(frac >> 8); b[at + 7] = (byte)frac;
        }
    }
}
