// ChartBridge 0.4.0: the bot channel (nt8/PROTOCOL.md, "Bot channel (bot = on)"). Part of the ChartBridge add-on; install it
// with the other ChartBridge files.
//
// A local bot program on the trading PC (a rule program, never AI) connects on its own WebSocket path, /bot, with its own
// permission level: the secret in bot-secret.txt next to config.txt, which ChartBridge makes on this PC and never prints.
// It reads the live trades. It may send orders ONLY on Sim101 (NinjaTrader's simulator), and only through ChartBridge:
// every bot order is built here from the bot's parameters (or a proposal's) and placed by ChartBridgeOrders.PlaceBotEntry,
// through every v2 gate, inside the rails below. AI is never in the order path.
//
// Rules, each checked in this file (the contract line is named where it is enforced):
//   off by default: with "bot" not on in config.txt, /bot answers 404 and every bot page message is refused;
//   the upgrade needs a loopback address (ChartBridgeServer.Handle, as every request), NO Origin header (403), the secret in
//     X-ChartBridge-Bot (constant-time compare; wrong or missing: 403), and no other bot (409);
//   modes: shadow (nothing sent), copilot (a proposal to the signed-in pages; only Anthony's accept places it, from the
//     proposal's own parameters; an unanswered proposal is never sent and expires as "not answered"), auto (Sim101 only);
//     every start begins in shadow;
//   rails: 1 contract, on the bot's root only (botRoot, default MNQ, or its micro/mini sibling set from the page); at most 5
//     trades a day; stand down after 3 losing trades; every entry needs a stop; the kill switch; one trade at a time;
//   heartbeat: any bot message counts; 5 s of silence cancels the bot's unfilled entries, keeps any bot position's stop and
//     target, and tells the pages. ChartBridge NEVER flattens the bot's position by itself.
// Written in C# 5 syntax (NinjaTrader 8 compiles NinjaScript as C# 5).
#region Using declarations
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.WebSockets;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using NinjaTrader.Cbi;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    public static class ChartBridgeBot
    {
        // ---------------------------------------------------------- fixed rails (PROTOCOL.md "Bot channel", Rails)
        public const string BotAccount = "Sim101";          // the only account a bot order may go to, exact name
        public const int MaxQty = 1;                      // "at most 1 contract"
        public const int MaxTradesLimit = 5, MaxLossesLimit = 3;   // the page may lower these, never raise them (botRails)
        public const int MaxActionsPerSecond = 10;        // gate 7 for the bot connection
        public const double SilenceMs = 5000, StripEveryMs = 1000, CheckEveryMs = 500;
        public const int MaxLibraryBytes = 2 * 1024 * 1024;
        public const int MaxMessageBytes = 65536;
        public const string SecretHeader = "X-ChartBridge-Bot";
        public const int BotClientId = -1;                // the bot's ChartBridgeClient id (pages count up from 1)

        // ---------------------------------------------------------- settings (config.txt; read at start)
        public static bool Enabled;                       // bot = on (OFF by default)
        public static string ConfigRoot = "MNQ";          // botRoot
        public static string LibraryName = "bot-library.json";   // botLibrary (lead's default), served at GET /bot-library

        public static void ResetConfig() { Enabled = false; ConfigRoot = "MNQ"; LibraryName = "bot-library.json"; }

        // Called by ChartBridgeConfig.Load for the keys it does not know itself.
        public static bool ReadConfig(string key, string val)
        {
            if (key == "bot") { Enabled = SwitchOn(key, val); return true; }
            if (key == "botRoot") { ConfigRoot = (val ?? "").Trim().ToUpperInvariant(); return true; }
            if (key == "botLibrary") { LibraryName = (val ?? "").Trim(); return true; }
            return false;
        }

        // v3 switches: on, true and 1 mean on (any case); anything else is off, with one Output line naming the key and the value.
        public static bool SwitchOn(string key, string val)
        {
            string v = (val ?? "").Trim().ToLowerInvariant();
            if (v == "on" || v == "true" || v == "1") return true;
            if (v != "off" && v != "false" && v != "0") ChartBridgeServer.Log("config.txt: " + key + " = " + val + " is not on, true or 1, so " + key + " is OFF");
            return false;
        }

        // The micro or mini of the same market: the only other root the page may give the bot (botRails, lead's default).
        public static string Sibling(string root)
        {
            switch ((root ?? "").ToUpperInvariant())
            {
                case "MNQ": return "NQ";
                case "NQ": return "MNQ";
                case "MES": return "ES";
                case "ES": return "MES";
                default: return null;
            }
        }

        // ---------------------------------------------------------- state (all under Sync; never held during a NinjaTrader call)
        private static readonly object Sync = new object();
        private static readonly object PlaceGate = new object();   // one bot placement (rails check and submit) at a time

        private class Signal
        {
            public string Id, Action, Side, Kind, PriceText, Reason, Result;
            public int StopTicks, TargetTicks;            // TargetTicks 0 = none
            public double At;
        }

        private class Proposal
        {
            public Signal S;
            public string State = "open";                 // open, accepted, rejected, withdrawn, not answered
            public double SeenAt = -1, AnsweredAt = -1;   // page UTC ms, -1 = not yet
            public Order Entry;                           // placed on accept
        }

        private static ChartBridgeClient bot;             // the connected bot, or null
        private static bool claimed;                      // an upgrade is being accepted (one bot at a time)
        private static volatile bool helloed;             // botHello received on this connection (volatile: read on the tick path without the lock)
        private static string botName;
        private static double lastMsgMs, noBotSinceMs, lastStripMs;
        private static string mode = "shadow";            // every start begins in shadow (auto never survives a restart)
        private static bool killed;
        private static int maxTrades = MaxTradesLimit, maxLosses = MaxLossesLimit;
        private static string railRoot;                   // the page's choice (botRails), or null for botRoot
        private static string railsBroken, dayBroken;     // why bot-rails.txt or bot-day.txt could not be read (no new entries)
        private static string secret;                     // never logged, never in /diag
        private static string secretState = "missing";   // ok, missing, unreadable (this word only goes to /diag)
        private static string session;                    // the trading day (18:00 ET start), yyyy-MM-dd
        private static readonly Dictionary<string, double> Trades = new Dictionary<string, double>();   // entry tag -> realized $ (NaN while open)
        private static readonly HashSet<string> SignalIds = new HashSet<string>();   // ids used today
        private static string openTag;                    // the bot trade being followed (its entry's tag), or null
        private static int ledQty;                        // that trade's position, signed, from the executions
        private static double ledCash, ledAvg;            // its cash flow (points times contracts) and average entry
        private static readonly Dictionary<string, Proposal> Proposals = new Dictionary<string, Proposal>();
        private static readonly Dictionary<string, Order> EntryOfSignal = new Dictionary<string, Order>();
        private static readonly List<Order> Placed = new List<Order>();   // bot entries sent, until done
        private static readonly HashSet<string> Tags = new HashSet<string>();   // tags of bot entries (legs share them)
        private static readonly HashSet<Order> CancelSent = new HashSet<Order>();
        private static readonly Queue<double> Actions = new Queue<double>();   // the bot's recent actions (gate 7)
        private static string lastSignalJson;
        private static long nSignals, nProposals, nAnswered, nNotAnswered, nPlaced, nRefused, nHeartbeatLost;
        private static Timer timer;

        // Test hooks (the Mono harness): the clocks. Null in NinjaTrader.
        public static Func<double> ClockMs;
        public static Func<DateTime> ClockEt;
        private static double Now() { Func<double> f = ClockMs; return f != null ? f() : ChartBridgeTime.NowUtcMs(); }
        private static DateTime NowEt() { Func<DateTime> f = ClockEt; return f != null ? f() : ChartBridgeTime.NowEastern(); }

        private static string Folder { get { return ChartBridgeConfig.Folder; } }
        private static string SecretFile { get { return Path.Combine(Folder, "bot-secret.txt"); } }
        private static string RailsFile { get { return Path.Combine(Folder, "bot-rails.txt"); } }
        private static string DayFile { get { return Path.Combine(Folder, "bot-day.txt"); } }
        private static string LogFile { get { return Path.Combine(Folder, "bot.log"); } }

        // ---------------------------------------------------------- start and stop (ChartBridgeServer.Start and Stop)
        public static void Start() { Start(true); }

        // withTimer false: the Mono harness runs Check itself, step by step.
        public static void Start(bool withTimer)
        {
            Reset();
            if (!Enabled) return;
            LoadSecret();
            LoadRails();
            LoadDay();
            lock (Sync) noBotSinceMs = Now();
            if (withTimer) timer = new Timer(delegate { try { Check(); } catch (Exception ex) { ChartBridgeServer.Log("bot check error: " + ex.Message); } }, null, (int)CheckEveryMs, (int)CheckEveryMs);
            Log("the bot channel is ON: a bot may connect at ws://localhost:" + ChartBridgeConfig.Port + "/bot (Sim101 only, " + EffectiveRoot() + ", starting in shadow)");
        }

        public static void Stop()
        {
            Timer t = timer;
            timer = null;
            if (t != null) { try { t.Dispose(); } catch (Exception) { } }
            ChartBridgeClient b;
            lock (Sync) { b = bot; bot = null; }
            if (b != null) b.Close();
            Reset();
        }

        private static void Reset()
        {
            lock (Sync)
            {
                bot = null; claimed = false; helloed = false; botName = null; lastMsgMs = 0; noBotSinceMs = 0; lastStripMs = 0;
                mode = "shadow"; killed = false; maxTrades = MaxTradesLimit; maxLosses = MaxLossesLimit; railRoot = null; railsBroken = null; dayBroken = null;
                secret = null; secretState = "missing"; session = null; Trades.Clear(); SignalIds.Clear(); openTag = null; ledQty = 0; ledCash = 0; ledAvg = 0;
                Proposals.Clear(); EntryOfSignal.Clear(); Placed.Clear(); Tags.Clear(); CancelSent.Clear(); Actions.Clear(); lastSignalJson = null;
                nSignals = nProposals = nAnswered = nNotAnswered = nPlaced = nRefused = nHeartbeatLost = 0;
            }
        }

        // ---------------------------------------------------------- the secret (bot-secret.txt)
        // Two # lines, then 64 hex characters of random bytes. Made at the first start with bot on; deleting the file makes a new
        // one at the next start. A file that exists but cannot be read is never written over: every bot connection is refused
        // until it is fixed or deleted. The secret is never written to the Output window, /diag or any log.
        private static void LoadSecret()
        {
            string s = null, state;
            try
            {
                if (!File.Exists(SecretFile))
                {
                    byte[] b = new byte[32];
                    using (RNGCryptoServiceProvider rng = new RNGCryptoServiceProvider()) rng.GetBytes(b);
                    s = BitConverter.ToString(b).Replace("-", "").ToLowerInvariant();
                    Directory.CreateDirectory(Folder);
                    string tmp = SecretFile + ".tmp";
                    File.WriteAllLines(tmp, new[] { "# ChartBridge bot secret (made by ChartBridge on this PC; the bot reads it from here; never share it)",
                                                    "# Delete this file to make a new one at the next start.", s });
                    File.Move(tmp, SecretFile);
                    state = "ok";
                    Log("made bot-secret.txt next to config.txt (the bot reads the secret from that file)");
                }
                else
                {
                    string[] data = File.ReadAllLines(SecretFile).Select(l => l.Trim()).Where(l => l.Length > 0 && !l.StartsWith("#")).ToArray();
                    if (data.Length == 1 && Regex.IsMatch(data[0], "^[0-9a-fA-F]{64}$")) { s = data[0].ToLowerInvariant(); state = "ok"; }
                    else state = "unreadable";
                }
            }
            catch (Exception) { s = null; state = "unreadable"; }
            if (state != "ok") { s = null; Log("bot-secret.txt could not be read: every bot connection is refused until it is fixed or deleted (a new one is made at the next start)"); }
            lock (Sync) { secret = s; secretState = state; }
        }

        private static bool SecretMatches(string given)
        {
            string s;
            lock (Sync) s = secret;
            if (s == null || given == null || given.Length != s.Length) return false;
            int diff = 0;
            for (int i = 0; i < s.Length; i++) diff |= s[i] ^ given[i];   // constant time
            return diff == 0;
        }

        // ---------------------------------------------------------- the rails the page sets (bot-rails.txt, lead's default)
        // "maxTrades<TAB>n", "maxLosses<TAB>n", "root<TAB>ROOT" after two # lines. Tighten only: 1 to 5 trades, 1 to 3 losses,
        // botRoot or its micro/mini sibling. A file that cannot be read stands the bot down (no new entries) until it is fixed or
        // deleted; nothing is guessed.
        private static void LoadRails()
        {
            int t = MaxTradesLimit, l = MaxLossesLimit;
            string r = null, broken = null;
            try
            {
                if (File.Exists(RailsFile))
                {
                    foreach (string raw in File.ReadAllLines(RailsFile))
                    {
                        string line = raw.Trim();
                        if (line.Length == 0 || line.StartsWith("#")) continue;
                        string[] p = line.Split('\t');
                        int n;
                        if (p.Length == 2 && p[0] == "maxTrades" && int.TryParse(p[1], NumberStyles.None, CultureInfo.InvariantCulture, out n) && n >= 1 && n <= MaxTradesLimit) t = n;
                        else if (p.Length == 2 && p[0] == "maxLosses" && int.TryParse(p[1], NumberStyles.None, CultureInfo.InvariantCulture, out n) && n >= 1 && n <= MaxLossesLimit) l = n;
                        else if (p.Length == 2 && p[0] == "root") r = p[1].Trim().ToUpperInvariant();
                        else { broken = "bot-rails.txt has a line ChartBridge does not understand"; break; }
                    }
                }
            }
            catch (Exception ex) { broken = "bot-rails.txt could not be read (" + ex.Message + ")"; }
            if (r != null && r != ConfigRoot && r != Sibling(ConfigRoot)) { Log("bot-rails.txt names root " + r + ", which is neither botRoot " + ConfigRoot + " nor its sibling: the bot trades " + ConfigRoot); r = null; }
            if (broken != null) Log(broken + ": no new bot entries until it is fixed or deleted");
            lock (Sync) { maxTrades = t; maxLosses = l; railRoot = r; railsBroken = broken == null ? null : broken + ": no new bot entries until it is fixed or deleted"; }
        }

        private static string SaveRails(int t, int l, string r)
        {
            try
            {
                Directory.CreateDirectory(Folder);
                string tmp = RailsFile + ".tmp";
                File.WriteAllLines(tmp, new[] { "# ChartBridge bot rails (written by ChartBridge from the page; do not edit)",
                    "# maxTrades 1 to 5, maxLosses 1 to 3, root botRoot or its micro/mini sibling",
                    "maxTrades\t" + t.ToString(CultureInfo.InvariantCulture), "maxLosses\t" + l.ToString(CultureInfo.InvariantCulture), "root\t" + r });
                if (File.Exists(RailsFile)) File.Replace(tmp, RailsFile, null); else File.Move(tmp, RailsFile);
                return null;
            }
            catch (Exception ex) { return ex.Message; }
        }

        public static string EffectiveRoot() { lock (Sync) return railRoot ?? ConfigRoot; }

        // ---------------------------------------------------------- the day (bot-day.txt; reset at 18:00 ET)
        // So a restart cannot forget today's trades and losses (lead's default). "session<TAB>yyyy-MM-dd", then one line per bot
        // trade, "trade<TAB><entry tag><TAB>open" or "trade<TAB><tag><TAB><realized dollars>". A file that cannot be read stands
        // the bot down for this run (nothing is written over it).
        private static string SessionOf(DateTime et) { return (et.Hour >= 18 ? et.Date.AddDays(1) : et.Date).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture); }

        private static void LoadDay()
        {
            string today = SessionOf(NowEt()), fileSession = null, broken = null;
            Dictionary<string, double> trades = new Dictionary<string, double>();
            try
            {
                if (File.Exists(DayFile))
                {
                    foreach (string raw in File.ReadAllLines(DayFile))
                    {
                        string line = raw.Trim();
                        if (line.Length == 0 || line.StartsWith("#")) continue;
                        string[] p = line.Split('\t');
                        double v;
                        if (p.Length == 2 && p[0] == "session") fileSession = p[1];
                        else if (p.Length == 3 && p[0] == "trade" && Regex.IsMatch(p[1], "^[0-9a-f]{8}$") && p[2] == "open") trades[p[1]] = double.NaN;
                        else if (p.Length == 3 && p[0] == "trade" && Regex.IsMatch(p[1], "^[0-9a-f]{8}$") && double.TryParse(p[2], NumberStyles.Float, CultureInfo.InvariantCulture, out v) && !double.IsNaN(v)) trades[p[1]] = v;
                        else { broken = "bot-day.txt has a line ChartBridge does not understand"; break; }
                    }
                    if (broken == null && fileSession == null) broken = "bot-day.txt has no session line";
                }
            }
            catch (Exception ex) { broken = "bot-day.txt could not be read (" + ex.Message + ")"; }
            lock (Sync)
            {
                session = today;
                Trades.Clear();
                if (broken != null) dayBroken = broken + ": no new bot entries this run (delete it to start the day over)";
                else if (fileSession == today) foreach (KeyValuePair<string, double> kv in trades) Trades[kv.Key] = kv.Value;
            }
            if (broken != null) Log(broken + ": no new bot entries this run (delete it to start the day over)");
        }

        private static void SaveDay()
        {
            List<string> lines = new List<string> { "# ChartBridge bot day (written by ChartBridge; do not edit)", "# session, then one line per bot trade: tag and open or realized dollars" };
            lock (Sync)
            {
                if (dayBroken != null) return;   // never written over a file that could not be read
                lines.Add("session\t" + session);
                foreach (KeyValuePair<string, double> kv in Trades)
                    lines.Add("trade\t" + kv.Key + "\t" + (double.IsNaN(kv.Value) ? "open" : kv.Value.ToString("0.##", CultureInfo.InvariantCulture)));
            }
            try
            {
                Directory.CreateDirectory(Folder);
                string tmp = DayFile + ".tmp";
                File.WriteAllLines(tmp, lines.ToArray());
                if (File.Exists(DayFile)) File.Replace(tmp, DayFile, null); else File.Move(tmp, DayFile);
            }
            catch (Exception ex) { Log("bot-day.txt could not be saved (" + ex.Message + "); a restart would forget today's bot trades"); }
        }

        // A new trading day at 18:00 ET: trades, losses and signal ids start over. A trade still open goes on into the new day.
        private static void RollDay()
        {
            string today = SessionOf(NowEt());
            bool changed = false;
            lock (Sync)
            {
                if (session == today) return;
                session = today;
                double was;
                bool open = openTag != null && Trades.TryGetValue(openTag, out was);
                Trades.Clear();
                if (open) Trades[openTag] = double.NaN;
                SignalIds.Clear();
                changed = true;
            }
            if (changed) { SaveDay(); Log("a new trading day: the bot's trades and losses start over"); Notify(); }
        }

        private static int TradesToday() { lock (Sync) return Trades.Count; }
        private static int LossesToday() { lock (Sync) return Trades.Values.Count(v => v < 0); }
        private static double PnlToday() { lock (Sync) return Trades.Values.Where(v => !double.IsNaN(v)).Sum(); }

        // Rail: stand down after maxLosses losing trades (and while bot-rails.txt or bot-day.txt cannot be read). Call under Sync.
        private static string StandDownLocked()
        {
            if (dayBroken != null) return dayBroken;
            if (railsBroken != null) return railsBroken;
            int losses = Trades.Values.Count(v => v < 0);
            if (losses >= maxLosses) return losses + " losing trades today: no new bot entries until 18:00 ET";
            return null;
        }

        // ---------------------------------------------------------- strict messages (gate 8, as extended for v3 and the bot)
        // One flat JSON object. Values: a plain string (no backslash, no control character, at most 200 characters), a plain
        // number (no sign, no exponent, no leading zero), true, false or null. Any nested object or list, a key twice, an
        // escape or trailing text is refused. Whether a key is allowed, and what each value must be, is checked by the caller.
        public class Val { public char K; public string T; }   // K: 's' string, 'n' whole number, 'd' decimal, 'b' bool, 'z' null

        public static Dictionary<string, Val> Parse(string text, out string why)
        {
            why = null;
            Dictionary<string, Val> d = new Dictionary<string, Val>();
            int i = 0, n = text == null ? 0 : text.Length;
            if (n == 0) { why = "empty message"; return null; }
            if (text.IndexOf('\\') >= 0) { why = "message has an escape sequence"; return null; }
            Action ws = () => { while (i < n && (text[i] == ' ' || text[i] == '\t' || text[i] == '\n' || text[i] == '\r')) i++; };
            Func<string> str = () =>
            {
                if (i >= n || text[i] != '"') return null;
                int start = ++i;
                while (i < n && text[i] != '"') { char c = text[i]; if (c < 0x20 || c == 0x7f || i - start >= 200) return null; i++; }
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
                    string key = str();
                    if (string.IsNullOrEmpty(key)) { why = "a key is not a plain string"; return null; }
                    ws();
                    if (i >= n || text[i] != ':') { why = "malformed"; return null; }
                    i++; ws();
                    Val v = new Val();
                    if (i < n && text[i] == '"') { v.K = 's'; v.T = str(); if (v.T == null) { why = key + " is not a plain string of at most 200 characters"; return null; } }
                    else if (i < n && (text[i] == '{' || text[i] == '[')) { why = "message has a nested object or list"; return null; }
                    else if (string.CompareOrdinal(text, i, "true", 0, 4) == 0) { v.K = 'b'; v.T = "true"; i += 4; }
                    else if (string.CompareOrdinal(text, i, "false", 0, 5) == 0) { v.K = 'b'; v.T = "false"; i += 5; }
                    else if (string.CompareOrdinal(text, i, "null", 0, 4) == 0) { v.K = 'z'; v.T = "null"; i += 4; }
                    else
                    {
                        int st = i;
                        while (i < n && text[i] >= '0' && text[i] <= '9') i++;
                        string whole = text.Substring(st, i - st), frac = null;
                        if (i < n && text[i] == '.')
                        {
                            int fs = ++i;
                            while (i < n && text[i] >= '0' && text[i] <= '9') i++;
                            frac = text.Substring(fs, i - fs);
                        }
                        if (whole.Length == 0 || whole.Length > 15 || (whole.Length > 1 && whole[0] == '0') || (frac != null && (frac.Length == 0 || frac.Length > 10)))
                        { why = key + " is not a plain value"; return null; }
                        v.K = frac == null ? 'n' : 'd';
                        v.T = text.Substring(st, i - st);
                    }
                    if (d.ContainsKey(key)) { why = "message has a key twice (" + key + ")"; return null; }
                    d[key] = v;
                    ws();
                    if (i < n && text[i] == ',') { i++; ws(); continue; }
                    if (i < n && text[i] == '}') { i++; break; }
                    why = "malformed"; return null;
                }
            ws();
            if (i != n) { why = "text after the object"; return null; }
            return d;
        }

        private static string UnknownKey(Dictionary<string, Val> d, string[] allowed)
        {
            foreach (string k in d.Keys) if (Array.IndexOf(allowed, k) < 0) return k;
            return null;
        }

        private static string S(Dictionary<string, Val> d, string k) { Val v; return d != null && d.TryGetValue(k, out v) && v.K == 's' ? v.T : null; }
        private static bool Has(Dictionary<string, Val> d, string k) { return d.ContainsKey(k); }
        private static bool IsNull(Dictionary<string, Val> d, string k) { Val v; return d.TryGetValue(k, out v) && v.K == 'z'; }

        // A whole number by gate 8's rule (at most 9 digits): 1 ok, 0 absent, -1 anything else.
        private static int Whole(Dictionary<string, Val> d, string k, out int value)
        {
            value = 0;
            Val v;
            if (!d.TryGetValue(k, out v)) return 0;
            if (v.K != 'n' || v.T.Length > 9) return -1;
            value = int.Parse(v.T, CultureInfo.InvariantCulture);
            return 1;
        }

        // Page UTC ms (botSeen, botAnswer): a whole number of 1 to 15 digits.
        private static bool Ms(Dictionary<string, Val> d, string k, out double value)
        {
            value = 0;
            Val v;
            if (!d.TryGetValue(k, out v) || v.K != 'n') return false;
            value = double.Parse(v.T, CultureInfo.InvariantCulture);
            return value >= 1;
        }

        private static bool Bool(Dictionary<string, Val> d, string k, out bool value)
        {
            value = false;
            Val v;
            if (!d.TryGetValue(k, out v) || v.K != 'b') return false;
            value = v.T == "true";
            return true;
        }

        private static readonly Dictionary<string, string[]> BotKeys = new Dictionary<string, string[]>
        {
            { "botHello", new[] { "type", "name" } },
            { "beat", new[] { "type" } },
            { "signal", new[] { "type", "id", "action", "side", "kind", "price", "stopTicks", "targetTicks", "reason" } },
            { "withdraw", new[] { "type", "id", "reason" } },
            { "flatten", new[] { "type" } },
        };

        private static readonly Dictionary<string, string[]> PageKeys = new Dictionary<string, string[]>
        {
            { "botMode", new[] { "type", "cid", "mode" } },
            { "botKill", new[] { "type", "cid", "on" } },
            { "botSeen", new[] { "type", "id", "at" } },
            { "botAnswer", new[] { "type", "cid", "id", "answer", "at" } },
            { "botRails", new[] { "type", "cid", "maxTrades", "maxLosses", "root" } },   // lead's default (Anthony: rails changeable in the Bot tab)
        };

        // ---------------------------------------------------------- the /bot WebSocket and GET /bot-library (ChartBridgeServer.Handle)
        // The answer to an upgrade to /bot before it happens: 404 while the switch is off, 403 for any Origin header (any browser
        // page) and for a wrong or missing secret, 400 for a request that is not a WebSocket upgrade, 409 while a bot is
        // connected; 101 when it may go ahead. The address check (loopback only) has already run, as for every request.
        public static int UpgradeCheck(string origin, string givenSecret, bool isWebSocket)
        {
            if (!Enabled) return 404;                     // bot off: /bot does not exist
            if (origin != null) return 403;               // no Origin header at all: a browser always sends one
            if (!SecretMatches(givenSecret)) return 403;  // X-ChartBridge-Bot must be the secret in bot-secret.txt
            if (!isWebSocket) return 400;
            lock (Sync) if (bot != null || claimed) return 409;   // one bot connection at a time
            return 101;
        }

        public static async Task Serve(HttpListenerContext ctx, string path, CancellationToken token)
        {
            if (path == "/bot-library") { ServeLibrary(ctx); return; }
            int code = UpgradeCheck(ctx.Request.Headers["Origin"], ctx.Request.Headers[SecretHeader], ctx.Request.IsWebSocketRequest);
            if (code == 101)
            {
                lock (Sync) { if (bot != null || claimed) code = 409; else claimed = true; }   // the slot, taken before the upgrade
            }
            if (code != 101) { Answer(ctx, code); return; }
            WebSocket ws;
            try { HttpListenerWebSocketContext wsc = await ctx.AcceptWebSocketAsync(null); ws = wsc.WebSocket; }
            catch (Exception) { lock (Sync) claimed = false; throw; }
            await Run(ws, token);
        }

        private static void Answer(HttpListenerContext ctx, int code)
        {
            try
            {
                ctx.Response.StatusCode = code;
                ctx.Response.AddHeader("Cache-Control", "no-store");
                ctx.Response.ContentLength64 = 0;
                ctx.Response.Close();
            }
            catch (Exception) { try { ctx.Response.Abort(); } catch (Exception) { } }
        }

        private static async Task Run(WebSocket ws, CancellationToken token)
        {
            ChartBridgeClient c = new ChartBridgeClient(ws, BotClientId);
            if (!Attach(c)) { lock (Sync) claimed = false; c.Close(); return; }
            // As a page's: the send loop on its own thread, never inline (0.1.0 deadlock), never a pool thread.
            Task sending = Task.Factory.StartNew(() => c.SendLoop(), CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            byte[] buf = new byte[16384];
            try
            {
                while (ws.State == WebSocketState.Open && !token.IsCancellationRequested)
                {
                    MemoryStream bytes = new MemoryStream();
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
                    if (r.MessageType == WebSocketMessageType.Close || size > MaxMessageBytes) break;   // a message over 64 KB closes the bot's connection
                    OnBotMessage(c, Encoding.UTF8.GetString(bytes.ToArray()));
                }
            }
            catch (Exception) { }
            finally
            {
                Lose(c, "the bot disconnected", false);
                c.Close();
                try { await sending; } catch (Exception) { }
            }
        }

        // GET /bot-library (lead's default): the bytes of the file botLibrary names (bot-library.json next to config.txt), read
        // fresh each time, as application/json, at most 2 MB, checked only for being valid JSON. 404 while the switch is off or the
        // file is missing; only when asked for by the localhost name (as /session), so only ChartBridge's own page reads it (no
        // CORS headers). Loopback only, as every request.
        public static void ServeLibrary(HttpListenerContext ctx)
        {
            if (!Enabled) { Answer(ctx, 404); return; }
            string method = ctx.Request.HttpMethod ?? "";
            if (method != "GET" && method != "HEAD") { Answer(ctx, 405); return; }
            if (ctx.Request.Headers["Host"] != "localhost:" + ChartBridgeConfig.Port) { Answer(ctx, 403); return; }
            string why;
            string text = ReadLibrary(out why);
            if (text == null && why == null) { Answer(ctx, 404); return; }
            if (text == null) { ChartBridgeServer.ServeText(ctx, 500, "{\"error\":" + CbJson.Str(why) + "}", "application/json"); return; }
            ChartBridgeServer.ServeText(ctx, 200, text, "application/json");
        }

        // The library's text, or null: with why null when there is no such file, else why it cannot be served.
        public static string ReadLibrary(out string why)
        {
            why = null;
            string file = LibraryPath();
            if (file == null || !File.Exists(file)) return null;
            try
            {
                byte[] bytes;
                using (FileStream fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    if (fs.Length > MaxLibraryBytes) { why = "the bot library is over 2 MB"; return null; }
                    bytes = new byte[(int)fs.Length];
                    int at = 0, got;
                    while (at < bytes.Length && (got = fs.Read(bytes, at, bytes.Length - at)) > 0) at += got;
                }
                string text = new UTF8Encoding(false, true).GetString(bytes);
                if (text.Length > 0 && text[0] == '﻿') text = text.Substring(1);
                if (!JsonValid(text)) { why = "the bot library is not valid JSON"; return null; }
                return text;
            }
            catch (Exception ex) { why = "the bot library could not be read (" + ex.Message + ")"; return null; }
        }

        // A plain file name in ChartBridge's folder, or a full path; either way a .json file. Anything else serves nothing.
        public static string LibraryPath()
        {
            string name = LibraryName ?? "";
            if (name.Length == 0 || !name.EndsWith(".json", StringComparison.OrdinalIgnoreCase)) return null;
            if (Path.IsPathRooted(name)) return name;
            if (name.Contains("..") || name.IndexOf('/') >= 0 || name.IndexOf('\\') >= 0) return null;
            return Path.Combine(Folder, name);
        }

        // Valid JSON (RFC 8259), nothing more: the page lane owns the schema (docs/BOT_LIBRARY.md).
        public static bool JsonValid(string s)
        {
            int i = 0;
            if (!JsonValue(s, ref i, 0)) return false;
            JsonWs(s, ref i);
            return i == s.Length;
        }

        private static void JsonWs(string s, ref int i) { while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++; }

        private static bool JsonValue(string s, ref int i, int depth)
        {
            if (depth > 200) return false;
            JsonWs(s, ref i);
            if (i >= s.Length) return false;
            char c = s[i];
            if (c == '{' || c == '[')
            {
                char close = c == '{' ? '}' : ']';
                i++; JsonWs(s, ref i);
                if (i < s.Length && s[i] == close) { i++; return true; }
                for (;;)
                {
                    if (c == '{')
                    {
                        JsonWs(s, ref i);
                        if (!JsonString(s, ref i)) return false;
                        JsonWs(s, ref i);
                        if (i >= s.Length || s[i] != ':') return false;
                        i++;
                    }
                    if (!JsonValue(s, ref i, depth + 1)) return false;
                    JsonWs(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    if (i < s.Length && s[i] == close) { i++; return true; }
                    return false;
                }
            }
            if (c == '"') return JsonString(s, ref i);
            foreach (string lit in new[] { "true", "false", "null" })
                if (string.CompareOrdinal(s, i, lit, 0, lit.Length) == 0) { i += lit.Length; return true; }
            Match m = JsonNumberRx.Match(s, i);
            if (!m.Success || m.Index != i || m.Length == 0) return false;
            i += m.Length;
            return true;
        }

        private static readonly Regex JsonNumberRx = new Regex("\\G-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?");

        private static bool JsonString(string s, ref int i)
        {
            if (i >= s.Length || s[i] != '"') return false;
            i++;
            while (i < s.Length)
            {
                char c = s[i];
                if (c == '"') { i++; return true; }
                if (c < 0x20) return false;
                if (c == '\\')
                {
                    if (i + 1 >= s.Length) return false;
                    char e = s[i + 1];
                    if (e == 'u') { if (i + 5 >= s.Length || !Regex.IsMatch(s.Substring(i + 2, 4), "^[0-9a-fA-F]{4}$")) return false; i += 6; continue; }
                    if ("\"\\/bfnrt".IndexOf(e) < 0) return false;
                    i += 2; continue;
                }
                i++;
            }
            return false;
        }

        // ---------------------------------------------------------- the bot's connection
        // Takes the one bot slot for this connection (Run, after the upgrade; the harness with a stand-in client).
        public static bool Attach(ChartBridgeClient c)
        {
            lock (Sync)
            {
                if (!Enabled || c == null || bot != null) return false;
                bot = c; claimed = false; helloed = false; botName = null; lastMsgMs = Now(); Actions.Clear();
            }
            Log("a bot connected; it is told nothing until its botHello");
            Notify();
            return true;
        }

        // The bot is gone (heartbeat lost, its connection closed, or ChartBridge closed it): its unfilled entries are cancelled,
        // any bot position keeps its stop and target (nothing else is touched; ChartBridge never flattens it), open proposals
        // expire as "not answered" (it can no longer withdraw them; lead's default), and the pages are told.
        private static void Lose(ChartBridgeClient c, string why, bool heartbeat)
        {
            List<Proposal> expired;
            lock (Sync)
            {
                if (bot != c) return;
                bot = null; helloed = false; noBotSinceMs = Now();
                if (heartbeat) nHeartbeatLost++;
                expired = ExpireOpenLocked();
            }
            if (heartbeat) c.Close();
            int n = CancelUnfilled();
            foreach (Proposal p in expired) { ToPages(ProposalJson(p)); BotLog("proposal " + p.S.Id + " not answered (" + why + ")"); }
            string text = "Bot: " + why + ": " + (n > 0 ? n + " unfilled bot entr" + (n == 1 ? "y" : "ies") + " cancelled" : "no unfilled bot entry to cancel") +
                          "; any bot position keeps its stop and target (ChartBridge never flattens it)";
            Log(text);
            BotLog(text);
            ToPages(StatusJson("warn", text));
            Notify();
        }

        // Every bot message: strict keys, then by type. Any message counts for the heartbeat, even one that is refused.
        public static void OnBotMessage(ChartBridgeClient c, string text)
        {
            bool hello;
            lock (Sync) { if (c != bot) return; lastMsgMs = Now(); hello = helloed; }
            string why;
            Dictionary<string, Val> d = Parse(text, out why);
            string type = d != null ? S(d, "type") : null, id = d != null ? S(d, "id") : null;
            string[] keys;
            if (d == null) { ToBot(BotReject(null, "ChartBridge refused a bot message: " + why)); return; }
            if (type == null || !BotKeys.TryGetValue(type, out keys)) { ToBot(BotReject(id, "unknown bot message type " + (type ?? "(none)"))); return; }
            string odd = UnknownKey(d, keys);
            if (odd != null) { lock (Sync) nRefused++; ToBot(BotReject(id, "unknown key \"" + odd + "\" in " + type)); return; }   // e.g. "account": the bot never names one
            if (!Enabled) { ToBot(BotReject(id, "The bot channel is off (bot in config.txt).")); return; }
            if (type == "beat") return;
            if (!RateOk(Actions)) { ToBot(BotReject(id, "too many bot messages (more than " + MaxActionsPerSecond + " a second)")); return; }
            if (type == "botHello") { OnHello(d); return; }
            if (!hello) { ToBot(BotReject(id, "send botHello first")); return; }
            if (type == "signal") OnSignal(d);
            else if (type == "withdraw") OnWithdraw(d);
            else if (type == "flatten") OnBotFlatten();
        }

        // Gate 7: at most 10 actions a second (the bot's own queue, or a page's).
        private static bool RateOk(Queue<double> q)
        {
            double now = Now();
            lock (q)
            {
                while (q.Count > 0 && now - q.Peek() > 1000) q.Dequeue();
                if (q.Count >= MaxActionsPerSecond) return false;
                q.Enqueue(now);
            }
            return true;
        }

        private static void OnHello(Dictionary<string, Val> d)
        {
            string name = S(d, "name");
            if (name == null || name.Length < 1 || name.Length > 40) { ToBot(BotReject(null, "botHello needs a name of 1 to 40 characters")); return; }
            lock (Sync) { helloed = true; botName = name; }
            ToBot(WelcomeJson());
            ToBot(BotStateJson());
            Log("bot \"" + name + "\" said hello");
            BotLog("bot \"" + name + "\" connected");
            Notify();
        }

        // ---------------------------------------------------------- signals
        private static void OnSignal(Dictionary<string, Val> d)
        {
            string why;
            Signal s = ReadSignal(d, out why);
            if (s == null) { lock (Sync) nRefused++; ToBot(BotReject(S(d, "id"), why)); return; }
            RollDay();
            string m;
            lock (Sync)
            {
                if (SignalIds.Contains(s.Id)) why = "signal id " + s.Id + " was already used today";
                else { SignalIds.Add(s.Id); nSignals++; }
                m = mode;
            }
            if (why != null) { lock (Sync) nRefused++; ToBot(BotReject(s.Id, why)); return; }
            if (s.Action == "skipped") s.Result = "skipped";
            else if (m == "shadow") s.Result = "shadow";   // shadow: shown and logged; no orders
            else if (m == "copilot")
            {
                // copilot: a proposal, never an order. Refused at once when a rail would refuse it anyway.
                why = RailsProblem() ?? AccountProblem(false);
                if (why != null) { s.Result = "refused: " + why; lock (Sync) nRefused++; }
                else
                {
                    Proposal p = new Proposal { S = s };
                    lock (Sync) { Proposals[s.Id] = p; nProposals++; }
                    s.Result = "proposed";
                    ToPages(ProposalJson(p));
                }
            }
            else
            {
                // auto: ChartBridge places it, on Sim101 only, inside the rails and every gate.
                Order placed;
                why = Place(s, out placed);
                s.Result = why == null ? "placed" : "refused: " + why;
                if (placed != null) lock (Sync) EntryOfSignal[s.Id] = placed;
            }
            if (why != null) ToBot(BotReject(s.Id, why));
            string json = SignalJson(s);
            lock (Sync) lastSignalJson = json;
            ToPages(json);
            BotLog("signal " + s.Id + " " + s.Action + (s.Action == "fired" ? " " + s.Side + " " + s.Kind + (s.PriceText != null ? " @ " + s.PriceText : "") + " stop " + s.StopTicks + " target " + s.TargetTicks : "") +
                   " (" + s.Reason + "): " + s.Result);
            Notify();
        }

        private static Signal ReadSignal(Dictionary<string, Val> d, out string why)
        {
            why = null;
            Signal s = new Signal { Id = S(d, "id"), Action = S(d, "action"), Reason = S(d, "reason"), At = Now() };
            if (s.Id == null || s.Id.Length < 1 || s.Id.Length > 40) { why = "a signal needs an id of 1 to 40 characters"; return null; }
            if (s.Reason == null || s.Reason.Length < 1) { why = "a signal needs a reason of 1 to 200 characters"; return null; }
            if (s.Action == "skipped")
            {
                string odd = UnknownKey(d, new[] { "type", "id", "action", "reason", "side" });
                if (odd != null) { why = "a skipped signal carries only id, action, reason and side (not " + odd + ")"; return null; }
                s.Side = S(d, "side");
                if (Has(d, "side") && s.Side != "buy" && s.Side != "sell") { why = "side must be buy or sell"; return null; }
                return s;
            }
            if (s.Action != "fired") { why = "action must be fired or skipped"; return null; }
            s.Side = S(d, "side"); s.Kind = S(d, "kind");
            if (s.Side != "buy" && s.Side != "sell") { why = "side must be buy or sell"; return null; }
            if (s.Kind != "market" && s.Kind != "limit" && s.Kind != "stop") { why = "kind must be market, limit or stop"; return null; }
            Val pv;
            if (s.Kind == "market") { if (Has(d, "price")) { why = "a market signal takes no price"; return null; } }
            else
            {
                if (!d.TryGetValue("price", out pv) || (pv.K != 'n' && pv.K != 'd')) { why = "a " + s.Kind + " signal needs a plain price"; return null; }
                s.PriceText = pv.T;
            }
            int st, tt;
            if (Whole(d, "stopTicks", out st) != 1 || st < 1) { why = "every bot entry needs a stop: stopTicks must be a whole number of 1 or more"; return null; }
            s.StopTicks = st;
            if (IsNull(d, "targetTicks")) s.TargetTicks = 0;
            else if (Whole(d, "targetTicks", out tt) != 1 || tt < 1) { why = "targetTicks must be a whole number of 1 or more, or null for none"; return null; }
            else s.TargetTicks = tt;
            return s;
        }

        private static void OnWithdraw(Dictionary<string, Val> d)
        {
            string id = S(d, "id"), reason = S(d, "reason");
            if (id == null || reason == null || reason.Length < 1) { ToBot(BotReject(id, "withdraw needs an id and a reason")); return; }
            Proposal p;
            Order entry;
            string was = null;
            lock (Sync)
            {
                Proposals.TryGetValue(id, out p);
                EntryOfSignal.TryGetValue(id, out entry);
                if (p != null && p.State == "open") { p.State = "not answered"; nNotAnswered++; was = "open"; }   // never sent
                else if (p != null && p.State == "accepted") { was = "accepted"; entry = p.Entry; }
            }
            int cancelled = entry != null && Cancel(entry) ? 1 : 0;   // an unfilled entry; its legs and any position are untouched
            if (was == "accepted" && cancelled > 0) lock (Sync) p.State = "withdrawn";
            else if (was == "accepted") was = null;   // filled or done already: nothing to withdraw
            if (was == "open")
            {
                ToBot(AnswerJson(id, "not answered", "withdrawn by the bot before an answer: " + reason));
                ToPages(ProposalJson(p));
                BotLog("proposal " + id + " not answered (withdrawn by the bot: " + reason + ")");
            }
            else if (was == "accepted") ToPages(ProposalJson(p));
            if (was == null && cancelled == 0) { ToBot(BotReject(id, "nothing to withdraw for " + id)); return; }
            if (cancelled > 0) BotLog("withdraw " + id + ": its unfilled entry cancelled (" + reason + ")");
            Notify();
        }

        // flatten from the bot: auto mode only, and only the bot's own position on Sim101 (v2 Flatten: cancel, then market).
        private static void OnBotFlatten()
        {
            string m, root = EffectiveRoot(), why = null;
            bool open, k;
            lock (Sync) { m = mode; open = openTag != null; k = killed; }
            if (m != "auto") why = "flatten is for auto mode only";
            else if (k) why = "the kill switch is on";
            else if (!open) why = "the bot has no position to flatten";
            else why = ChartBridgeOrders.FlattenForBot(root);
            if (why != null) { ToBot(BotReject(null, why)); return; }
            BotLog("flatten from the bot (auto): " + root + " on " + BotAccount);
        }

        // ---------------------------------------------------------- placing a bot order (auto, or an accepted proposal)
        // The rails, then the account lock, then every v2 gate in ChartBridgeOrders (trading, gate 2 for Sim101, the cap at 1,
        // grid, side of market, stale price, bracket). The order is built here from the signal's own parameters; the account is
        // always Sim101 and the root always the bot's, whatever the bot sends.
        private static string Place(Signal s, out Order placed)
        {
            placed = null;
            lock (PlaceGate)
            {
                string root;
                string rootWhy = RootProblem(out root);
                string why = RailsProblem() ?? AccountProblem(false) ?? rootWhy;
                if (why != null) { lock (Sync) nRefused++; return why; }
                string text = "{\"type\":\"order\",\"account\":\"" + BotAccount + "\",\"root\":\"" + root + "\",\"side\":\"" + s.Side + "\",\"kind\":\"" + s.Kind + "\",\"qty\":" + MaxQty +
                              (s.Kind == "market" ? "" : ",\"price\":" + s.PriceText) +
                              ",\"bracket\":{\"stop\":" + s.StopTicks.ToString(CultureInfo.InvariantCulture) + ",\"target\":" + s.TargetTicks.ToString(CultureInfo.InvariantCulture) + "}}";
                why = ChartBridgeOrders.PlaceBotEntry(text, out placed);
                if (why != null) { lock (Sync) nRefused++; placed = null; return why; }
                lock (Sync) { Placed.Add(placed); Tags.Add(TagOf(placed.Name)); nPlaced++; }
            }
            BotLog("placed " + s.Side + " 1 " + EffectiveRoot() + " " + s.Kind + (s.PriceText != null ? " @ " + s.PriceText : "") + " stop " + s.StopTicks + " target " + s.TargetTicks + " on " + BotAccount + " (signal " + s.Id + ")");
            return null;
        }

        // The rails (PROTOCOL.md "Bot channel", Rails). Null when a new bot entry may go.
        private static string RailsProblem()
        {
            if (!Enabled) return "The bot channel is off (bot in config.txt).";
            if (!ChartBridgeOrders.Enabled) return "trading is off in config.txt";            // gate 1, the master switch above every v3 switch
            RollDay();
            lock (Sync)
            {
                if (killed) return "the kill switch is on (release it on the page)";
                string sd = StandDownLocked();
                if (sd != null) return sd;                                                     // 3 losing trades (or a file that cannot be read)
                if (Trades.Count >= maxTrades) return "The bot has made " + Trades.Count + " trades today (the limit).";   // 5 trades a day
                if (openTag != null) return "the bot already has a position: one trade at a time, 1 contract";
            }
            if (WorkingEntries().Count > 0) return "the bot already has a working entry: one trade at a time, 1 contract";
            return null;
        }

        // Sim101 only: the exact name, NinjaTrader's own simulator, and (for auto) tradable by gate 2.
        private static string AccountProblem(bool forAuto)
        {
            Account a = FindAccount();
            if (a == null) return BotAccount + " is not in NinjaTrader";
            if (!IsSim(a)) return BotAccount + " is not NinjaTrader's simulator (or ChartBridge cannot tell): the bot trades Sim101 only";
            if (forAuto && !ChartBridgeOrders.AccountTradable(BotAccount)) return BotAccount + " may not trade from the chart (tradeAccounts in config.txt): auto needs it";
            if (forAuto && (a.Connection == null || a.Connection.Status != ConnectionStatus.Connected)) return BotAccount + " is not connected";
            return null;
        }

        private static string RootProblem(out string root)
        {
            root = EffectiveRoot();
            if (ChartBridgeConfig.QuoteOnly(root)) return root + " is quote only: ChartBridge shows its prices on the Quote board and refuses every order for it (quoteRoots in config.txt)";
            if (root != ConfigRoot && root != Sibling(ConfigRoot)) return "the bot's root " + root + " is neither botRoot " + ConfigRoot + " nor its sibling";
            if (Sibling(root) == null) return "botRoot " + root + " is not a micro or a mini ChartBridge knows (MNQ, NQ, MES, ES)";
            if (ChartBridgeServer.InstrumentFor(root) == null) return "instrument " + root + " is not served by ChartBridge";
            return null;
        }

        private static Account FindAccount()
        {
            lock (NinjaTrader.Cbi.Account.All)
                foreach (Account a in NinjaTrader.Cbi.Account.All) if (a.Name == BotAccount) return a;   // exact, case and all
            return null;
        }

        // NinjaTrader's simulator: the account's Provider (or its connection's) is Simulator. Read by name, so a NinjaTrader
        // build without it compiles; when it cannot be read the answer is no (the bot is refused, never let through).
        public static bool IsSim(Account a)
        {
            if (a == null || a.Name != BotAccount) return false;
            string p = ProviderOf(a);
            if (p == null && a.Connection != null)
            {
                try
                {
                    PropertyInfo op = a.Connection.GetType().GetProperty("Options");
                    object o = op != null ? op.GetValue(a.Connection, null) : null;
                    p = o != null ? ProviderOf(o) : null;
                }
                catch (Exception) { p = null; }
            }
            return p == "Simulator";
        }

        private static string ProviderOf(object x)
        {
            try
            {
                PropertyInfo pi = x.GetType().GetProperty("Provider");
                object v = pi != null ? pi.GetValue(x, null) : null;
                return v != null ? v.ToString() : null;
            }
            catch (Exception) { return null; }
        }

        // ---------------------------------------------------------- the bot's orders
        private static readonly Regex TagRx = new Regex("^CB#([0-9a-f]{8}) ");
        private static readonly Regex BotEntryRx = new Regex("^CB#([0-9a-f]{8}) bot s[0-9]{1,9} t[0-9]{1,9}$");

        private static string TagOf(string name) { Match m = TagRx.Match(name ?? ""); return m.Success ? m.Groups[1].Value : null; }
        private static bool IsBotEntry(Order o) { return o != null && BotEntryRx.IsMatch(o.Name ?? ""); }

        // An order of the bot's (its entry, or a leg or exit of one): ChartBridgeOrders asks before building the bot's copy.
        public static bool Watching(Order o)
        {
            if (!Enabled || o == null) return false;
            if (IsBotEntry(o)) return true;
            string tag = TagOf(o.Name);
            lock (Sync) return tag != null && Tags.Contains(tag);
        }

        // Every working bot entry on Sim101: those NinjaTrader lists (also after a restart, by name) and those just sent.
        private static List<Order> WorkingEntries()
        {
            List<Order> list = new List<Order>();
            Account a = FindAccount();
            if (a != null) lock (a.Orders) foreach (Order o in a.Orders) if (IsBotEntry(o) && ChartBridgeOrders.IsWorking(o.OrderState)) list.Add(o);
            lock (Sync) foreach (Order o in Placed) if (!list.Contains(o) && ChartBridgeOrders.IsWorking(o.OrderState)) list.Add(o);
            return list;
        }

        private static bool Cancel(Order o)
        {
            if (o == null || o.Account == null || !ChartBridgeOrders.IsWorking(o.OrderState) || !IsBotEntry(o)) return false;   // only an entry: never a stop or target
            lock (Sync) { if (!CancelSent.Add(o)) return false; }
            o.Account.Cancel(new[] { o });
            Log("bot entry cancel sent: " + (o.Name ?? "") + " on " + o.Account.Name);
            return true;
        }

        // Heartbeat lost, kill switch, leaving auto: cancel the bot's UNFILLED entries. Its stops and targets are never touched,
        // and its position is never closed here.
        private static int CancelUnfilled()
        {
            int n = 0;
            foreach (Order o in WorkingEntries()) if (Cancel(o)) n++;
            return n;
        }

        // ChartBridgeOrders.OnOrderUpdate, before it forgets a done order: the bot sees its own orders only.
        public static void OnOrderUpdate(Account account, Order o, string json)
        {
            if (!Enabled || o == null) return;
            string tag = TagOf(o.Name);
            if (tag == null) return;
            ChartBridgeClient c;
            lock (Sync)
            {
                if (IsBotEntry(o)) Tags.Add(tag);
                else if (!Tags.Contains(tag)) return;
                if (!ChartBridgeOrders.IsWorking(o.OrderState) && o.OrderState != OrderState.CancelPending && o.OrderState != OrderState.CancelSubmitted)
                {
                    Placed.Remove(o);
                    CancelSent.Remove(o);
                }
                c = helloed ? bot : null;
            }
            if (c != null && json != null) c.Send(json);
        }

        // Every execution, once (ChartBridgeServer.Deliver). Follows the bot's trade on Sim101: it opens with the first fill of a
        // bot entry (a trade, even partly filled) and closes when that position is flat again, whatever closed it (its stop or
        // target, Flatten on the page, an order in NinjaTrader); its realized dollars come from those executions (lead's default).
        public static void OnExec(string account, Instrument inst, MarketPosition side, int qty, double price, string orderId, string json)
        {
            if (!Enabled || account != BotAccount || inst == null || qty <= 0) return;
            string root = ChartBridgeServer.RootFor(inst);
            if (root == null || root != EffectiveRoot()) return;
            Order o = FindOrder(orderId);
            string entryTag = IsBotEntry(o) ? TagOf(o.Name) : null;
            bool mine = o != null && Watching(o);
            RollDay();
            string closedTag = null, opened = null;
            double pnl = 0;
            ChartBridgeClient c;
            lock (Sync)
            {
                double was;
                if (openTag == null && entryTag != null && (!Trades.TryGetValue(entryTag, out was) || double.IsNaN(was)))
                {
                    openTag = entryTag; ledQty = 0; ledCash = 0; ledAvg = 0;
                    if (!Trades.ContainsKey(entryTag)) { Trades[entryTag] = double.NaN; opened = entryTag; }   // a trade (counted once, also after a restart)
                }
                if (openTag != null)
                {
                    int signed = side == MarketPosition.Long ? qty : -qty;
                    if (ledQty == 0 || Math.Sign(signed) == Math.Sign(ledQty)) ledAvg = (ledAvg * Math.Abs(ledQty) + price * qty) / (Math.Abs(ledQty) + qty);
                    ledQty += signed;
                    ledCash -= signed * price;
                    if (ledQty == 0)
                    {
                        pnl = Math.Round(ledCash * inst.MasterInstrument.PointValue, 2);
                        Trades[openTag] = pnl;
                        closedTag = openTag; openTag = null; ledAvg = 0;
                    }
                }
                c = helloed ? bot : null;
            }
            if (mine && c != null && json != null) c.Send(json);
            if (opened == null && closedTag == null) return;
            SaveDay();
            if (opened != null) BotLog("trade " + opened + " opened (" + TradesToday() + " today)");
            if (closedTag != null)
            {
                BotLog("trade " + closedTag + " closed: " + pnl.ToString("0.##", CultureInfo.InvariantCulture) + " dollars (" + LossesToday() + " losing today)");
                string sd;
                lock (Sync) sd = StandDownLocked();
                if (sd != null && pnl < 0) { Log("bot stands down: " + sd); ToPages(StatusJson("warn", "Bot stands down: " + sd)); }
            }
            Notify();
        }

        private static Order FindOrder(string orderId)
        {
            if (string.IsNullOrEmpty(orderId)) return null;
            Account a = FindAccount();
            if (a != null) lock (a.Orders) foreach (Order o in a.Orders) if (o.OrderId == orderId) return o;
            lock (Sync) foreach (Order o in Placed) if (o.OrderId == orderId) return o;
            return null;
        }

        // ChartBridgeServer.OnPositionUpdate: the bot's position (Sim101, its root) to the bot.
        public static void OnPosition(Account account, PositionEventArgs e)
        {
            if (!Enabled || account == null || account.Name != BotAccount || e == null || e.Position == null) return;
            string root = ChartBridgeServer.RootFor(e.Position.Instrument);
            if (root == null || root != EffectiveRoot()) return;
            ChartBridgeClient c;
            lock (Sync) c = helloed ? bot : null;
            if (c == null) return;
            int q = e.MarketPosition == MarketPosition.Long ? e.Quantity : e.MarketPosition == MarketPosition.Short ? -e.Quantity : 0;
            c.Send("{\"type\":\"position\",\"account\":\"" + BotAccount + "\",\"root\":" + CbJson.Str(root) + ",\"qty\":" + q.ToString(CultureInfo.InvariantCulture) +
                   ",\"avgPrice\":" + (q != 0 ? CbJson.Num(e.AveragePrice) : "null") + "}");
        }

        // Every live trade on every served root (ChartBridgeServer's tick path): one volatile read when no bot is there.
        public static void OnTick(string json)
        {
            ChartBridgeClient c = Volatile.Read(ref bot);
            if (c != null && helloed) c.Send(json);   // no lock on the tick path
        }

        // ---------------------------------------------------------- the timer: heartbeat, the day, the strip
        public static void Check()
        {
            if (!Enabled) return;
            RollDay();
            double now = Now();
            ChartBridgeClient silent = null;
            bool noBot, strip = false;
            lock (Sync)
            {
                if (bot != null && now - lastMsgMs > SilenceMs) silent = bot;   // 5 s of silence
                noBot = bot == null && !claimed;
                if (!noBot) noBotSinceMs = now;
                if (bot != null && helloed && now - lastStripMs >= StripEveryMs) { strip = true; lastStripMs = now; }
            }
            if (silent != null) { Lose(silent, "no message from the bot for 5 s (heartbeat lost)", true); return; }
            // No bot for 5 s (after a restart, or after it went): its unfilled entries left at the broker are cancelled too.
            if (noBot && now - noBotSinceMs > SilenceMs)
            {
                int n = CancelUnfilled();
                if (n > 0) { string text = "Bot: no bot is connected: " + n + " unfilled bot entr" + (n == 1 ? "y" : "ies") + " cancelled; any bot position keeps its stop and target"; Log(text); BotLog(text); ToPages(StatusJson("warn", text)); Notify(); }
            }
            if (strip) ToPages(StripJson());
        }

        // ---------------------------------------------------------- messages from the page (botMode, botKill, botSeen, botAnswer, botRails)
        public static void OnPageMessage(ChartBridgeClient client, string type, string text)
        {
            string why;
            Dictionary<string, Val> d = Parse(text, out why);
            string cid = d != null ? S(d, "cid") : null, id = d != null ? S(d, "id") : null;
            try
            {
                if (!Enabled) { PageReject(client, cid, id, "The bot channel is off (bot in config.txt)."); return; }   // switch off: refused, nothing done
                string gate = SignedIn(client);
                if (gate != null) { PageReject(client, cid, id, gate); return; }
                if (d == null) { PageReject(client, cid, id, why); return; }
                string[] keys;
                if (!PageKeys.TryGetValue(type, out keys)) { PageReject(client, cid, id, "unknown message type " + type); return; }
                string odd = UnknownKey(d, keys);
                if (odd != null) { PageReject(client, cid, id, "unknown key \"" + odd + "\" in " + type); return; }
                if (type != "botSeen" && !RateOk(client.Actions)) { PageReject(client, cid, id, "too many order actions (more than " + MaxActionsPerSecond + " a second)"); return; }
                if (type == "botMode") why = SetMode(d);
                else if (type == "botKill") why = SetKill(d);
                else if (type == "botSeen") why = Seen(d);
                else if (type == "botAnswer") why = AnswerProposal(d);
                else if (type == "botRails") why = SetRails(d);
                if (why != null) PageReject(client, cid, id, why);
            }
            catch (Exception ex)
            {
                Log("bot page message error: " + ex.Message);
                PageReject(client, cid, id, "ChartBridge error: " + ex.Message);
            }
        }

        // Gates 1 and 4: trading on, ChartBridge's own page, signed in with the session token.
        private static string SignedIn(ChartBridgeClient client)
        {
            if (!ChartBridgeOrders.Enabled) return "trading is off in config.txt";
            if (!client.Trader || !ChartBridgeOrders.OriginAllowed(client.Origin)) return "this connection may not trade; reload ChartBridge's page";
            return null;
        }

        private static string SetMode(Dictionary<string, Val> d)
        {
            string m = S(d, "mode");
            if (m != "shadow" && m != "copilot" && m != "auto") return "mode must be shadow, copilot or auto";
            if (m == "auto") { string why = AccountProblem(true); if (why != null) return "auto refused: " + why; }   // auto: Sim101 must be tradable
            string old;
            List<Proposal> expired = new List<Proposal>();
            lock (Sync)
            {
                old = mode; mode = m;
                if (old == "copilot" && m != "copilot") expired = ExpireOpenLocked();   // proposals live in copilot only
            }
            foreach (Proposal p in expired) { ToPages(ProposalJson(p)); ToBot(AnswerJson(p.S.Id, "not answered", "the mode changed to " + m)); BotLog("proposal " + p.S.Id + " not answered (the mode changed to " + m + ")"); }
            if (old == "auto" && m != "auto") CancelUnfilled();   // leaving auto: the bot's unfilled entries go (lead's default)
            Log("bot mode " + m + " (was " + old + "), set by the page");
            BotLog("mode " + m + " (was " + old + "), set by the page");
            Notify();
            return null;
        }

        private static string SetKill(Dictionary<string, Val> d)
        {
            bool on;
            if (!Bool(d, "on", out on)) return "on must be true or false";
            List<Proposal> expired = new List<Proposal>();
            lock (Sync) { killed = on; if (on) expired = ExpireOpenLocked(); }
            if (on)
            {
                // As the heartbeat loss: unfilled entries cancelled, the position keeps its stop and target, nothing flattened.
                int n = CancelUnfilled();
                foreach (Proposal p in expired) { ToPages(ProposalJson(p)); ToBot(AnswerJson(p.S.Id, "not answered", "the kill switch is on")); }
                string text = "Bot: the kill switch is on: " + n + " unfilled bot entr" + (n == 1 ? "y" : "ies") + " cancelled; any bot position keeps its stop and target; every bot order is refused until it is released";
                ToPages(StatusJson("warn", text));
                Log(text); BotLog(text);
            }
            else { Log("bot kill switch released by the page"); BotLog("kill switch released by the page"); }
            Notify();
            return null;
        }

        private static string Seen(Dictionary<string, Val> d)
        {
            string id = S(d, "id");
            double at;
            if (!Ms(d, "at", out at)) return "at must be page UTC ms (a whole number)";
            Proposal p;
            lock (Sync)
            {
                if (id == null || !Proposals.TryGetValue(id, out p)) return "no proposal " + (id ?? "(none)");
                if (p.SeenAt >= 0) return null;          // the first moment it showed is the one recorded
                p.SeenAt = at;
            }
            BotLog("proposal " + id + " seen on the page at " + at.ToString("0", CultureInfo.InvariantCulture));
            ToPages(ProposalJson(p));
            return null;
        }

        // Anthony's answer. Accept places the order from the PROPOSAL's own parameters (the page sends none: any other key is
        // refused above), through the rails and every gate. An expired or already answered proposal is refused.
        private static string AnswerProposal(Dictionary<string, Val> d)
        {
            string id = S(d, "id"), answer = S(d, "answer");
            double at;
            if (answer != "accept" && answer != "reject") return "answer must be accept or reject";
            if (!Ms(d, "at", out at)) return "at must be page UTC ms (a whole number)";
            Proposal p;
            lock (Sync)
            {
                if (id == null || !Proposals.TryGetValue(id, out p)) return "no proposal " + (id ?? "(none)");
                if (p.State != "open") return "proposal " + id + " is " + p.State + "; it can no longer be answered";
                p.AnsweredAt = at; nAnswered++;
                p.State = answer == "accept" ? "accepting" : "rejected";   // no second answer while it is placed
            }
            if (answer == "reject")
            {
                ToPages(ProposalJson(p));
                ToBot(AnswerJson(id, "rejected", "rejected on the page"));
                BotLog("proposal " + id + " rejected on the page");
                Notify();
                return null;
            }
            Order placed;
            string why = Place(p.S, out placed);
            lock (Sync) { p.State = why == null ? "accepted" : "rejected"; p.Entry = placed; if (placed != null) EntryOfSignal[id] = placed; }
            ToPages(ProposalJson(p));
            ToBot(AnswerJson(id, why == null ? "accepted" : "refused", why == null ? "placed on " + BotAccount : why));
            BotLog("proposal " + id + " accepted on the page" + (why == null ? ": placed on " + BotAccount : " but refused: " + why));
            Notify();
            return why == null ? null : "accepted, but refused: " + why;
        }

        private static string SetRails(Dictionary<string, Val> d)
        {
            int t, l;
            string root = (S(d, "root") ?? "").ToUpperInvariant();
            if (Whole(d, "maxTrades", out t) != 1 || t < 1 || t > MaxTradesLimit) return "maxTrades must be a whole number from 1 to " + MaxTradesLimit;
            if (Whole(d, "maxLosses", out l) != 1 || l < 1 || l > MaxLossesLimit) return "maxLosses must be a whole number from 1 to " + MaxLossesLimit;
            if (root != ConfigRoot && root != Sibling(ConfigRoot)) return "root must be " + ConfigRoot + (Sibling(ConfigRoot) != null ? " or " + Sibling(ConfigRoot) : "") + " (botRoot and its micro/mini sibling)";
            if (ChartBridgeConfig.QuoteOnly(root) || ChartBridgeServer.InstrumentFor(root) == null) return "instrument " + root + " is not traded by ChartBridge";
            bool exposed;
            lock (Sync) exposed = openTag != null;
            if (exposed || WorkingEntries().Count > 0) return "the bot has a position or a working entry: change its rails when it is flat";
            string err = SaveRails(t, l, root);
            if (err != null) return "bot-rails.txt could not be saved (" + err + "); nothing changed";
            lock (Sync) { maxTrades = t; maxLosses = l; railRoot = root == ConfigRoot ? null : root; railsBroken = null; }
            Log("bot rails set by the page: " + t + " trades, " + l + " losing trades, " + root);
            BotLog("rails set by the page: " + t + " trades, " + l + " losing trades, " + root);
            ToBot(WelcomeJson());   // so the bot knows its root and rails (lead's default)
            Notify();
            return null;
        }

        // Under Sync: every open proposal becomes "not answered" (never sent).
        private static List<Proposal> ExpireOpenLocked()
        {
            List<Proposal> list = new List<Proposal>();
            foreach (Proposal p in Proposals.Values) if (p.State == "open") { p.State = "not answered"; nNotAnswered++; list.Add(p); }
            return list;
        }

        // ChartBridgeOrders.Auth (a page that signed in) and "client" after it: a v3 page gets the strip and the open proposals.
        public static void AfterAuth(ChartBridgeClient client)
        {
            if (!Enabled || client == null || !client.Trader || !IsV3Stub(client)) return;
            client.Send(StripJson());
            List<Proposal> open;
            lock (Sync) open = Proposals.Values.Where(p => p.State == "open").ToList();
            foreach (Proposal p in open) client.Send(ProposalJson(p));
        }

        // ---------------------------------------------------------- STUB for lane B2's shared v3 plumbing (swap when merging)
        // Lane B2 (branch r116-accounts) owns the "client" v3 handshake, hello.features "v3" and trading.switches. Until it is
        // merged, this minimal stub only remembers which connections sent {"type":"client","v":3}, so bot messages go to v3 pages
        // only. When merging: replace IsV3Stub(c) with B2's helper (in AfterAuth here and in ChartBridgeServer.SendToV3Traders),
        // drop V3ClientStub and its dispatch line in ChartBridgeServer.OnClientMessage, and call AfterAuth from B2's handshake.
        private static readonly ConditionalWeakTable<ChartBridgeClient, object> V3Stub = new ConditionalWeakTable<ChartBridgeClient, object>();
        private static readonly object V3Mark = new object();

        public static bool IsV3Stub(ChartBridgeClient c) { object o; return c != null && V3Stub.TryGetValue(c, out o); }

        public static void V3ClientStub(ChartBridgeClient client, string text)
        {
            string why;
            Dictionary<string, Val> d = Parse(text, out why);
            int v;
            if (d != null && UnknownKey(d, new[] { "type", "v" }) == null && Whole(d, "v", out v) == 1 && v == 3)
            {
                V3Stub.GetValue(client, k => V3Mark);
                AfterAuth(client);
                return;
            }
            client.Send(StatusJson("warn", "ChartBridge refused a client message: it speaks protocol v3 ({\"type\":\"client\",\"v\":3})"));
        }

        // ---------------------------------------------------------- messages out
        private static void ToBot(string json)
        {
            ChartBridgeClient c;
            lock (Sync) c = bot;
            if (c != null) c.Send(json);
        }

        private static void ToPages(string json) { ChartBridgeServer.SendToV3Traders(json); }

        private static void Notify()
        {
            ToPages(StripJson());
            ChartBridgeClient c;
            lock (Sync) c = helloed ? bot : null;
            if (c != null) c.Send(BotStateJson());
        }

        private static void PageReject(ChartBridgeClient client, string cid, string id, string reason)
        {
            client.Send("{\"type\":\"reject\"" + (cid != null ? ",\"cid\":" + CbJson.Str(cid) : "") + (id != null ? ",\"id\":" + CbJson.Str(id) : "") + ",\"reason\":" + CbJson.Str(reason) + "}");
        }

        private static string BotReject(string id, string reason)
        {
            return "{\"type\":\"reject\",\"id\":" + (id != null ? CbJson.Str(id) : "null") + ",\"reason\":" + CbJson.Str(reason) + "}";
        }

        private static string StatusJson(string level, string text) { return "{\"type\":\"status\",\"level\":" + CbJson.Str(level) + ",\"text\":" + CbJson.Str(text) + "}"; }

        private static string AnswerJson(string id, string answer, string text)
        {
            return "{\"type\":\"answer\",\"id\":" + CbJson.Str(id) + ",\"answer\":" + CbJson.Str(answer) + ",\"text\":" + CbJson.Str(text) + "}";
        }

        private static string Ms(double v) { return v >= 0 ? v.ToString("0", CultureInfo.InvariantCulture) : "null"; }

        public static string StripJson()
        {
            StringBuilder b = new StringBuilder("{\"type\":\"bot\"");
            lock (Sync)
            {
                double now = Now();
                int losses = Trades.Values.Count(v => v < 0);
                double pnl = Trades.Values.Where(v => !double.IsNaN(v)).Sum();
                string root = railRoot ?? ConfigRoot, sd = StandDownLocked();
                b.Append(",\"enabled\":").Append(Enabled ? "true" : "false")
                 .Append(",\"connected\":").Append(bot != null && helloed ? "true" : "false")
                 .Append(",\"name\":").Append(botName != null && bot != null ? CbJson.Str(botName) : "null")
                 .Append(",\"mode\":").Append(CbJson.Str(mode))
                 .Append(",\"account\":\"").Append(BotAccount).Append('"')
                 .Append(",\"root\":").Append(CbJson.Str(root))
                 .Append(",\"position\":{\"qty\":").Append(ledQty.ToString(CultureInfo.InvariantCulture)).Append(",\"avgPrice\":").Append(ledQty != 0 ? CbJson.Num(ledAvg) : "null").Append('}')
                 .Append(",\"pnlToday\":").Append(CbJson.Num(Math.Round(pnl, 2)))
                 .Append(",\"trades\":").Append(Trades.Count)
                 .Append(",\"maxTrades\":").Append(maxTrades)
                 .Append(",\"losses\":").Append(losses)
                 .Append(",\"maxLosses\":").Append(maxLosses)
                 .Append(",\"maxQty\":").Append(MaxQty)
                 .Append(",\"killed\":").Append(killed ? "true" : "false")
                 .Append(",\"standDown\":").Append(sd != null ? CbJson.Str(sd) : "null")
                 .Append(",\"lastBeatMs\":").Append(bot != null ? Ms(Math.Max(0, now - lastMsgMs)) : "null")
                 .Append(",\"lastSignal\":").Append(lastSignalJson ?? "null");
            }
            return b.Append('}').ToString();
        }

        private static string BotStateJson()
        {
            lock (Sync)
            {
                string sd = StandDownLocked();
                return "{\"type\":\"botState\",\"mode\":" + CbJson.Str(mode) + ",\"killed\":" + (killed ? "true" : "false") + ",\"standDown\":" + (sd != null ? CbJson.Str(sd) : "null") +
                       ",\"trades\":" + Trades.Count + ",\"losses\":" + Trades.Values.Count(v => v < 0) + "}";
            }
        }

        private static string WelcomeJson()
        {
            string root = EffectiveRoot(), m;
            int t, l;
            lock (Sync) { m = mode; t = maxTrades; l = maxLosses; }
            Instrument inst = ChartBridgeServer.InstrumentFor(root);
            string instruments = inst == null ? "[]" :
                "[{\"root\":" + CbJson.Str(root) + ",\"name\":" + CbJson.Str(inst.FullName) + ",\"tick\":" + CbJson.Num(inst.MasterInstrument.TickSize) +
                ",\"pointValue\":" + CbJson.Num(inst.MasterInstrument.PointValue) + ",\"quoteOnly\":false}]";
            return "{\"type\":\"welcome\",\"version\":" + CbJson.Str(ChartBridgeServer.Version) + ",\"mode\":" + CbJson.Str(m) + ",\"account\":\"" + BotAccount + "\",\"root\":" + CbJson.Str(root) +
                   ",\"rails\":{\"maxQty\":" + MaxQty + ",\"maxTrades\":" + t + ",\"maxLosses\":" + l + "},\"instruments\":" + instruments + "}";
        }

        private static string SignalJson(Signal s)
        {
            return "{\"type\":\"botSignal\",\"id\":" + CbJson.Str(s.Id) + ",\"at\":" + Ms(s.At) + ",\"action\":" + CbJson.Str(s.Action) +
                   ",\"side\":" + (s.Side != null ? CbJson.Str(s.Side) : "null") + ",\"kind\":" + (s.Kind != null ? CbJson.Str(s.Kind) : "null") +
                   ",\"price\":" + (s.PriceText ?? "null") + ",\"stopTicks\":" + (s.Action == "fired" ? s.StopTicks.ToString(CultureInfo.InvariantCulture) : "null") +
                   ",\"targetTicks\":" + (s.Action == "fired" && s.TargetTicks > 0 ? s.TargetTicks.ToString(CultureInfo.InvariantCulture) : "null") +
                   ",\"reason\":" + CbJson.Str(s.Reason) + ",\"result\":" + CbJson.Str(s.Result ?? "") + "}";
        }

        private static string ProposalJson(Proposal p)
        {
            Signal s = p.S;
            string state;
            double seen, answered;
            lock (Sync) { state = p.State == "accepting" ? "open" : p.State; seen = p.SeenAt; answered = p.AnsweredAt; }
            return "{\"type\":\"botProposal\",\"id\":" + CbJson.Str(s.Id) + ",\"at\":" + Ms(s.At) + ",\"account\":\"" + BotAccount + "\",\"root\":" + CbJson.Str(EffectiveRoot()) +
                   ",\"side\":" + CbJson.Str(s.Side) + ",\"kind\":" + CbJson.Str(s.Kind) + ",\"price\":" + (s.PriceText ?? "null") + ",\"qty\":" + MaxQty +
                   ",\"stopTicks\":" + s.StopTicks.ToString(CultureInfo.InvariantCulture) + ",\"targetTicks\":" + (s.TargetTicks > 0 ? s.TargetTicks.ToString(CultureInfo.InvariantCulture) : "null") +
                   ",\"reason\":" + CbJson.Str(s.Reason) + ",\"state\":" + CbJson.Str(state) + ",\"seenAt\":" + Ms(seen) + ",\"answeredAt\":" + Ms(answered) + "}";
        }

        // /diag "bot" (only with the switch on): counts and state. Never the secret: only whether its file reads.
        public static string DiagJson()
        {
            lock (Sync)
            {
                return "{\"enabled\":" + (Enabled ? "true" : "false") + ",\"connected\":" + (bot != null ? "true" : "false") + ",\"mode\":" + CbJson.Str(mode) +
                       ",\"killed\":" + (killed ? "true" : "false") + ",\"trades\":" + Trades.Count + ",\"losses\":" + Trades.Values.Count(v => v < 0) +
                       ",\"signals\":" + nSignals + ",\"proposals\":" + nProposals + ",\"answered\":" + nAnswered + ",\"notAnswered\":" + nNotAnswered +
                       ",\"placed\":" + nPlaced + ",\"refused\":" + nRefused + ",\"heartbeatLost\":" + nHeartbeatLost + ",\"secretFile\":" + CbJson.Str(secretState) + "}";
            }
        }

        // ---------------------------------------------------------- logs (never the secret)
        private static void Log(string text) { ChartBridgeServer.Log("bot: " + text); }

        private static int logFailed;
        private static void BotLog(string text)
        {
            try { File.AppendAllText(LogFile, DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture) + "\t" + text.Replace('\n', ' ') + Environment.NewLine); }
            catch (Exception ex) { if (Interlocked.Exchange(ref logFailed, 1) == 0) Log("bot.log could not be written (" + ex.Message + ")"); }
        }
    }
}
