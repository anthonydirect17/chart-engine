// ChartBridge 0.4.0: the bot channel (nt8/PROTOCOL.md, "Bot channel (bot = on)"). Part of the ChartBridge add-on; install it
// with the other ChartBridge files.
//
// A local bot program on the trading PC (a rule program, never AI) connects on its own WebSocket path, /bot, with its own
// permission level: the secret in bot-secret.txt next to config.txt, which ChartBridge makes on this PC and never prints.
// It reads the live trades. It may send orders ONLY on the bot's account, the one Anthony chooses on the page (botAccount,
// None by default since 0.5.7, a Sim or a live account: Anthony 2026-10-07, no Sim lock), and only through ChartBridge: every bot order is
// built here from the bot's parameters (or a proposal's) and placed by ChartBridgeOrders.PlaceBotEntry, through every v2 gate
// (trading on, the account's checkmark or tradeAccounts, Connected, the caps), inside the rails below. AI is never in the
// order path. The bot itself never names an account.
//
// Rules, each checked in this file (the contract line is named where it is enforced):
//   on by default (Anthony 2026-10-07): with "bot = off" in config.txt, /bot answers 404 and every bot page message is refused;
//   the upgrade needs a loopback address (ChartBridgeServer.Handle, as every request), NO Origin header (403), the secret in
//     X-ChartBridge-Bot (constant-time compare; wrong or missing: 403), and no other bot (409);
//   modes: shadow (nothing sent), copilot (a proposal to the signed-in pages; only Anthony's accept places it, from the
//     proposal's own parameters; an unanswered proposal is never sent and expires as "not answered"), auto (on the bot's
//     account); every start begins in shadow;
//   the account: chosen on the page (botAccount), saved in bot-account.txt, None (nothing trades) by default; refused while the bot has a
//     position or a working entry, when it does not pass the account gates, and when the copier uses it (a follower that is
//     on, or the leader); release 1 (step 1.6b, Anthony 2026-11-18: "Personal only, Sim later"): ONLY the personal account
//     picked on the chart page (personal-account.txt); no pick, another account or a Sim account: refused, for the choice,
//     for arming (copilot, auto) and for every entry;
//   rails (release 1, step 1.6b): fail closed: the size, trades a day, losing trades, the day's loss stop and the day's profit
//     stop, all set on the Bot tab (bot-rails.txt); one missing, 0 or unreadable: no arming and no entry, each missing one
//     named; the size is capped only by the hard ceiling (ChartBridgeAgents.HardCeiling: 2 minis, 20 micros, raised only by
//     a new ChartBridge build), never by config.txt's maxQty; on the bot's root only (botRoot, default MNQ, or its
//     micro/mini sibling set from the page); every entry needs a stop; the kill switch; one trade at a time;
//   the day stops (release 1, step 1.6b, Anthony 2026-11-17 Q7 and 2026-11-18): realized plus open, checked every 500 ms and at
//     every close; reached: the bot's own contracts are closed at once (even with the kill switch on), the day is latched in
//     bot-day.txt until 18:00 ET and the mode drops to Shadow; Anthony arms it again himself, never ChartBridge;
//   bot only (release 1, decision 3a, 2026-11-18): the bot shares the personal account with Anthony, so its day stop and its own
//     flatten close only its own share (its own stop, target and entry cancelled first, then one market close of what its ledger
//     follows and its legs prove) and never touch Anthony's contracts or orders there; the bot's ledger counts only its own share;
//   the owner guard (release 1, decision 3b): no new bot entry while Anthony holds his own position or working orders on the
//     bot's account and root, named; copilot and auto stay armed; Shadow is unaffected;
//   heartbeat: any bot message counts; 5 s of silence cancels the bot's unfilled entries, keeps any bot position's stop and
//     target, and tells the pages. ChartBridge never closes the bot's position by itself, except at a day stop (above).
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
        public const string DefaultAccount = ChartBridgeBranches.None;   // 0.5.7 (DECISION 2026-10-14e): None until Anthony chooses an account (botAccount); was Sim101
        // Release 1 (step 1.6b): no fixed size, trades or losses rail. Each is set on the Bot tab (botRails); these bound only what
        // the page may type for the counts. The size's only bound is ChartBridgeAgents.HardCeiling (a code change to raise).
        public const int RailCountMax = 100;
        public const int MaxActionsPerSecond = 10;        // gate 7 for the bot connection
        public const double SilenceMs = 5000, StripEveryMs = 1000, CheckEveryMs = 500;
        public const int MaxLibraryBytes = 2 * 1024 * 1024;
        public const int MaxMessageBytes = 65536;
        public const string SecretHeader = "X-ChartBridge-Bot";
        public const int BotClientId = -1;                // the bot's ChartBridgeClient id (pages count up from 1)

        // ---------------------------------------------------------- settings (config.txt; read at start)
        // bot (ON by default, Anthony 2026-10-07; "bot = off" turns it off). Integration (0.4.0): one source of truth for every v3
        // switch, ChartBridgeSwitches in ChartBridgeV3.cs (ChartBridgeConfig.Load records "bot" there), so trading.switches.bot and
        // the bot channel never disagree.
        public static bool Enabled { get { return ChartBridgeV3.Bot; } }
        public static string ConfigRoot = "MNQ";          // botRoot
        public static string LibraryName = "bot-library.json";   // botLibrary (lead's default), served at GET /bot-library

        public static void ResetConfig() { ConfigRoot = "MNQ"; LibraryName = "bot-library.json"; }   // the switch's default (on) is ChartBridgeSwitches.Reset's, in ChartBridgeConfig.Load

        // Called by ChartBridgeConfig.Load for the keys it does not know itself.
        public static bool ReadConfig(string key, string val)
        {
            if (key == "bot") return true;   // the switch is ChartBridgeSwitches' (read in ChartBridgeConfig.Load before this); taken here only
            if (key == "botRoot") { ConfigRoot = (val ?? "").Trim().ToUpperInvariant(); return true; }
            if (key == "botLibrary") { LibraryName = (val ?? "").Trim(); return true; }
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
            public string Account;                        // the bot's account when it was proposed: placed only on that one
            public string State = "open";                 // open, accepted, rejected, withdrawn, not answered
            public double SeenAt = -1, AnsweredAt = -1;   // page UTC ms, -1 = not yet
            public Order Entry;                           // placed on accept
            public string WithdrawnWhy;                   // review 2 finding 7: a withdraw that arrived while the accept was being placed
        }

        private static ChartBridgeClient bot;             // the connected bot, or null
        private static bool claimed;                      // an upgrade is being accepted (one bot at a time)
        private static volatile bool helloed;             // botHello received on this connection (volatile: read on the tick path without the lock)
        private static string botName;
        private static double lastMsgMs, noBotSinceMs, lastStripMs;
        private static string mode = "shadow";            // every start begins in shadow (auto never survives a restart)
        private static bool killed;
        private static int size, maxTrades, maxLosses;   // release 1 (1.6b): set on the Bot tab (bot-rails.txt); 0 = not set (fail closed)
        private static double dayLoss, dayProfit;        // the day's loss and profit stops in dollars, realized plus open; 0 = not set
        private static string dayStopKind;                // "loss" or "profit" once a day stop is reached this trading day (latched), else null
        private static double dayStopDay;                 // the day's dollars when it was reached
        private static double stopFlattenTryMs = -1;      // the last cancel again (a lost cancel) a latched day stop or the bot's close sent, reserved under Sync
        private static string stopFlattenWhy;             // decision 3a: why the bot's close was last refused (CloseStep), said once a reason, or null
        private static string stopFlattenWait;            // decision 3a: why the bot's close last waited (its legs being cancelled, a close on its way), said once a reason, or null
        private static bool openUnknownSaid;              // the open trade's dollars could not be read: said once a trading day
        // Release 1 (decision 3a, 2026-11-18, "bot only"): the bot shares the personal account with Anthony, so ChartBridge closes only
        // the bot's own contracts (CloseShare) and follows only the bot's own share of the position (OnExec).
        private static int handQty;                       // Anthony's own contracts on the bot's contract, signed, from the executions that are not the bot's (0 at each bot entry: the owner guard)
        private static int closeProof;                    // the bot's contracts its own working stops (else targets) showed while it was being closed, the most seen; 0 when none
        private static double closeTryMs = -1;            // the last close of the bot's share sent (-1: none yet since the day stop or the bot's flatten), reserved under Sync
        private static bool closeAsked;                   // the bot's own flatten (auto) asked for its share to be closed: kept until the bot is flat
        private static string closeShortSaid;             // the proof was short of the followed size: said once a trade
        private static string railRoot;                   // the page's choice (botRails), or null for botRoot
        private static string account = DefaultAccount;   // the bot's account (botAccount, bot-account.txt), exact name
        private static string accountBroken;              // why bot-account.txt could not be read (no new entries)
        private static string railsBroken, dayBroken;     // why bot-rails.txt or bot-day.txt could not be read (no new entries)
        private static string secret;                     // never logged, never in /diag
        private static string secretState = "missing";   // ok, missing, unreadable (this word only goes to /diag)
        private static string session;                    // the trading day (18:00 ET start), yyyy-MM-dd
        private static readonly Dictionary<string, double> Trades = new Dictionary<string, double>();   // entry tag -> realized $ (NaN while open)
        private static readonly HashSet<string> SignalIds = new HashSet<string>();   // ids used today
        private static string openTag;                    // the bot trade being followed (its entry's tag), or null
        private static int ledQty;                        // that trade's position, signed, from the executions
        private static double ledCash, ledAvg;            // its cash flow (points times contracts) and average entry
        private static double ledPrior;                   // the trade's dollars already closed before it was followed (again): what it closed with when a late entry fill reopened it, or bot-day.txt's at a restore; else 0
        private static double ledPv;                      // the point value of its instrument, so bot-day.txt can keep its dollars closed so far (SaveDay)
        // Release 1 (R12, the day file): a trade open in bot-day.txt written by this build: its dollars closed so far, its size and its
        // average price when it was saved. Kept until it is followed again (RestoreOpenTrade), and written back unchanged meanwhile.
        private class OpenLine { public double Dollars, Avg; public int Qty; }
        private static readonly Dictionary<string, OpenLine> OpenSaved = new Dictionary<string, OpenLine>();
        private static string untoldTag;                  // a trade whose size changed while it was not followed (its dollars cannot be told), or null
        private static string untoldWhy;                  // that, in words, for the refusals
        private static readonly object SaveGate = new object();   // one bot-day.txt write at a time, each from the newest state (taken before Sync)
        private static readonly Dictionary<string, Proposal> Proposals = new Dictionary<string, Proposal>();
        private static readonly Dictionary<string, Order> EntryOfSignal = new Dictionary<string, Order>();
        private static readonly List<Order> Placed = new List<Order>();   // bot entries sent, until done
        private static readonly HashSet<string> Tags = new HashSet<string>();   // tags of bot entries (legs share them)
        private static readonly HashSet<Order> CancelSent = new HashSet<Order>();
        private static readonly HashSet<Order> CloseLost = new HashSet<Order>();   // decision 3a: the bot's closes said as gone unfilled
        private static readonly Queue<double> Actions = new Queue<double>();   // the bot's recent actions (gate 7)
        private static string lastSignalJson;
        private static long nSignals, nProposals, nAnswered, nNotAnswered, nPlaced, nRefused, nHeartbeatLost;
        private static Timer timer;

        // Test hooks (the Mono harness): the clocks. Null in NinjaTrader.
        public static Func<double> ClockMs;
        public static Func<DateTime> ClockEt;
        public static Action ModeArmChecked;              // runs in SetMode after ArmProblem, before the lock (the race of review R12 finding 2)
        private static double Now() { Func<double> f = ClockMs; return f != null ? f() : ChartBridgeTime.NowUtcMs(); }
        private static DateTime NowEt() { Func<DateTime> f = ClockEt; return f != null ? f() : ChartBridgeTime.NowEastern(); }

        private static string Folder { get { return ChartBridgeConfig.Folder; } }
        private static string SecretFile { get { return Path.Combine(Folder, "bot-secret.txt"); } }
        private static string RailsFile { get { return Path.Combine(Folder, "bot-rails.txt"); } }
        private static string AccountFile { get { return Path.Combine(Folder, "bot-account.txt"); } }

        // The account the bot trades: None ("-", nothing trades) until Anthony chooses one on the page (botAccount).
        public static string BotAccount { get { lock (Sync) return account; } }

        // 0.5.0 agents (lead's default): the bot's account for the agents' refusals whether or not the bot is on: in memory when on,
        // else read from bot-account.txt (None, "-", when there is none); null when that file cannot be understood.
        public static string AccountForAgents() { return Enabled ? BotAccount : ReadAccountFile(); }

        // bot-account.txt as the agents read it (ChartBridgeAgents.RefreshFiles, on its timer's thread): None ("-") when there is none.
        public static string ReadAccountFile()
        {
            try
            {
                if (!File.Exists(AccountFile)) return DefaultAccount;
                string found = null;
                foreach (string raw in File.ReadAllLines(AccountFile))
                {
                    string line = raw.Trim();
                    if (line.Length == 0 || line.StartsWith("#")) continue;
                    string[] p = line.Split('\t');
                    if (found == null && p.Length == 2 && p[0] == "account" && PlainName(p[1])) found = p[1];
                    else return null;
                }
                return found;
            }
            catch (Exception) { return null; }
        }
        private static string DayFile { get { return Path.Combine(Folder, "bot-day.txt"); } }
        private static string KillFile { get { return Path.Combine(Folder, "bot-kill.txt"); } }   // 0.6.3 (audit C5)
        private static double killedAt;
        private static bool killReadPending;   // review (C5): bot-kill.txt held open at the start: on meanwhile, read again on the check
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
            LoadAccount();
            LoadDay();
            RestoreOpenTrade();   // review R12 round 2: a bot trade open in bot-day.txt is followed again from NinjaTrader's position
            double? kill = ChartBridgeFiles.KillSince(KillFile);   // 0.6.3 (audit C5): the kill switch survives a restart until the page releases it
            lock (Sync) { noBotSinceMs = Now(); killed = kill.HasValue; killedAt = Math.Max(0, kill ?? 0); killReadPending = kill == -1; }
            if (kill == -1) Log("bot-kill.txt is there but could not be read yet (held open): the kill switch is on; ChartBridge reads it again");
            if (kill.HasValue) Log("the bot's kill switch is still on (" + ChartBridgeAgent.KilledWords(kill.Value) + "; kept through the restart): every bot order is refused until it is released on the page");
            if (withTimer) timer = new Timer(delegate { try { Check(); } catch (Exception ex) { ChartBridgeServer.Log("bot check error: " + ex.Message); } }, null, (int)CheckEveryMs, (int)CheckEveryMs);
            Log("the bot channel is ON: a bot may connect at ws://localhost:" + ChartBridgeConfig.Port + "/bot (account " + BotAccount + " (" + AcctMark() + "), " + EffectiveRoot() + ", starting in shadow)");
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
                mode = "shadow"; killed = false; size = 0; maxTrades = 0; maxLosses = 0; dayLoss = 0; dayProfit = 0; railRoot = null; railsBroken = null; dayBroken = null;
                dayStopKind = null; dayStopDay = 0; stopFlattenTryMs = -1; stopFlattenWhy = null; stopFlattenWait = null; openUnknownSaid = false;
                handQty = 0; closeProof = 0; closeTryMs = -1; closeAsked = false; closeShortSaid = null;
                account = DefaultAccount; accountBroken = null;
                secret = null; secretState = "missing"; session = null; Trades.Clear(); SignalIds.Clear(); openTag = null; ledQty = 0; ledCash = 0; ledAvg = 0; ledPrior = 0; ledPv = 0;
                OpenSaved.Clear(); untoldTag = null; untoldWhy = null;
                Proposals.Clear(); EntryOfSignal.Clear(); Placed.Clear(); Tags.Clear(); CancelSent.Clear(); CloseLost.Clear(); Actions.Clear(); lastSignalJson = null;
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

        // ---------------------------------------------------------- the rails the page sets (bot-rails.txt)
        // After two # lines: "size<TAB>n", "maxTrades<TAB>n", "maxLosses<TAB>n", "dayLoss<TAB>dollars", "dayProfit<TAB>dollars" and
        // "root<TAB>ROOT". Release 1 (step 1.6b, fail closed): no file, or a file without one of the five, leaves it NOT SET, and a
        // rail not set refuses arming and every entry, named (RailsMissingLocked); nothing has a default. A value of 0, "none", a
        // blank, a size above the hard ceiling of the root, or any line ChartBridge does not understand stands the bot down until the
        // page sets the rails again or the file is deleted; nothing is guessed. A file from before 1.6b (maxTrades, maxLosses and
        // root only) reads, with the size and both day stops not set.
        private static void LoadRails()
        {
            int z = 0, t = 0, l = 0;
            double dl = 0, dp = 0;
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
                        double v;
                        if (p.Length == 2 && p[0] == "size" && int.TryParse(p[1], NumberStyles.None, CultureInfo.InvariantCulture, out n) && n >= 1) z = n;
                        else if (p.Length == 2 && p[0] == "maxTrades" && int.TryParse(p[1], NumberStyles.None, CultureInfo.InvariantCulture, out n) && n >= 1 && n <= RailCountMax) t = n;
                        else if (p.Length == 2 && p[0] == "maxLosses" && int.TryParse(p[1], NumberStyles.None, CultureInfo.InvariantCulture, out n) && n >= 1 && n <= RailCountMax) l = n;
                        else if (p.Length == 2 && p[0] == "dayLoss" && MoneyText(p[1], out v)) dl = v;
                        else if (p.Length == 2 && p[0] == "dayProfit" && MoneyText(p[1], out v)) dp = v;
                        else if (p.Length == 2 && p[0] == "root") r = p[1].Trim().ToUpperInvariant();
                        else { broken = "bot-rails.txt has a line ChartBridge does not understand"; break; }
                    }
                }
            }
            catch (Exception ex) { broken = "bot-rails.txt could not be read (" + ex.Message + ")"; }
            if (r != null && r != ConfigRoot && r != Sibling(ConfigRoot)) { Log("bot-rails.txt names root " + r + ", which is neither botRoot " + ConfigRoot + " nor its sibling: the bot trades " + ConfigRoot); r = null; }
            string root = r ?? ConfigRoot;
            if (broken == null && z > ChartBridgeAgents.HardCeiling(root)) broken = "bot-rails.txt names size " + z + ", above the hard ceiling of " + ChartBridgeAgents.HardCeiling(root) + " for " + root;
            if (broken != null) { Log(broken + ": no new bot entries until the rails are set again on the Bot tab or the file is deleted"); z = 0; t = 0; l = 0; dl = 0; dp = 0; }
            lock (Sync) { size = z; maxTrades = t; maxLosses = l; dayLoss = dl; dayProfit = dp; railRoot = r; railsBroken = broken == null ? null : broken + ": no new bot entries until the rails are set again on the Bot tab or the file is deleted"; }
        }

        private static string SaveRails(int z, int t, int l, double dl, double dp, string r)
        {
            try
            {
                Directory.CreateDirectory(Folder);
                ChartBridgeFiles.WriteLines(RailsFile, new[] { "# ChartBridge bot rails (written by ChartBridge from the page's Bot tab; do not edit)",
                    "# size, trades and losing trades a day, the day's loss and profit stops in dollars, and the root; one missing: the bot does not trade",
                    "size\t" + z.ToString(CultureInfo.InvariantCulture), "maxTrades\t" + t.ToString(CultureInfo.InvariantCulture), "maxLosses\t" + l.ToString(CultureInfo.InvariantCulture),
                    "dayLoss\t" + Dollars(dl), "dayProfit\t" + Dollars(dp), "root\t" + r });   // 0.6.3 (audit C3): write-through, flushed, the previous copy kept as .bak
                return null;
            }
            catch (Exception ex) { return ex.Message; }
        }

        // Dollars as bot-rails.txt and the page write them: above 0, at most ChartBridgeAgents.DayStopMax, at most 2 decimals.
        private static bool MoneyText(string t, out double v)
        {
            v = 0;
            if (t == null || !Regex.IsMatch(t, "^[0-9]{1,7}(?:\\.[0-9]{1,2})?$") || !double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) return false;
            return v > 0 && v <= ChartBridgeAgents.DayStopMax;
        }
        private static string Dollars(double v) { return v.ToString("0.##", CultureInfo.InvariantCulture); }

        // Under Sync: the rails not set, in plain words ("the size and the day's loss stop"), or null when all five are set.
        private static List<string> MissingLocked()
        {
            List<string> m = new List<string>();
            if (size < 1) m.Add("size");
            if (maxTrades < 1) m.Add("maxTrades");
            if (maxLosses < 1) m.Add("maxLosses");
            if (!(dayLoss > 0)) m.Add("dayLoss");
            if (!(dayProfit > 0)) m.Add("dayProfit");
            return m;
        }
        private static readonly Dictionary<string, string> RailWords = new Dictionary<string, string>
        {
            { "size", "the size" }, { "maxTrades", "the trades a day" }, { "maxLosses", "the losing trades a day" },
            { "dayLoss", "the day's loss stop" }, { "dayProfit", "the day's profit stop" }
        };
        private static string RailsMissingLocked()
        {
            List<string> m = MissingLocked();
            if (m.Count == 0) return null;
            List<string> w = m.Select(x => RailWords[x]).ToList();
            string list = w.Count == 1 ? w[0] : string.Join(", ", w.Take(w.Count - 1)) + " and " + w[w.Count - 1];
            return "the bot's rails are not set: " + list + " (set " + (w.Count == 1 ? "it" : "them") + " on the Bot tab; until then the bot does not trade)";
        }

        // The size the bot trades on root: the Bot tab's, never above the hard ceiling (a ChartBridge constant). 0: not set.
        public static int SizeFor(string root) { int z; lock (Sync) z = size; return Math.Min(z, ChartBridgeAgents.HardCeiling(root)); }

        // Gate 3's cap for a bot entry (ChartBridgeOrders.PlaceOrderLocked): the Bot tab's size and the hard ceiling only;
        // config.txt's maxQty.<ROOT> caps the ticket and the copier, never the bot (Anthony 2026-11-18, "Bot tab + hard ceiling").
        public static int EntryCap(string root, out string why)
        {
            int z, ceil = ChartBridgeAgents.HardCeiling(root);
            lock (Sync) z = size;
            why = "the bot's size on the Bot tab; the hard ceiling for " + root + " is " + ceil;
            return Math.Min(z, ceil);
        }

        public static string EffectiveRoot() { lock (Sync) return railRoot ?? ConfigRoot; }

        // ---------------------------------------------------------- the bot's account (bot-account.txt; Anthony 2026-10-07)
        // "account<TAB>NAME" after two # lines, written by ChartBridge from the page (botAccount) through a temp file. No file: None
        // (0.5.7; was Sim101). None is saved as "account<TAB>-" (ChartBridgeBranches).
        // A file that cannot be understood stands the bot down (no new entries) until the page chooses the account again or the
        // file is deleted; nothing is guessed.
        private static void LoadAccount()
        {
            string a = DefaultAccount, broken = null;
            try
            {
                if (File.Exists(AccountFile))
                {
                    string found = null;
                    foreach (string raw in File.ReadAllLines(AccountFile))
                    {
                        string line = raw.Trim();
                        if (line.Length == 0 || line.StartsWith("#")) continue;
                        string[] p = line.Split('\t');
                        if (found == null && p.Length == 2 && p[0] == "account" && PlainName(p[1])) found = p[1];
                        else { broken = "bot-account.txt has a line ChartBridge does not understand"; break; }
                    }
                    if (broken == null && found == null) broken = "bot-account.txt names no account";
                    if (broken == null) a = found;
                }
            }
            catch (Exception ex) { broken = "bot-account.txt could not be read (" + ex.Message + ")"; }
            if (broken != null) Log(broken + ": no new bot entries until the bot's account is chosen again on the Bot tab or the file is deleted");
            lock (Sync) { account = a; accountBroken = broken == null ? null : broken + ": no new bot entries until the bot's account is chosen again on the Bot tab or the file is deleted"; }
        }

        private static string SaveAccount(string name)
        {
            try
            {
                Directory.CreateDirectory(Folder);
                ChartBridgeFiles.WriteLines(AccountFile, new[] { "# ChartBridge bot account (written by ChartBridge from the page's Bot tab; do not edit)",
                    "# the one account the bot's orders go to; - is None (nothing trades), as is a missing file", "account\t" + name });   // 0.6.3 (audit C3): write-through, flushed, the previous copy kept as .bak
                return null;
            }
            catch (Exception ex) { return ex.Message; }
        }

        // An account name as NinjaTrader shows it: plain printable text, no tab, quote or backslash (gate 8 would refuse it).
        private static bool PlainName(string name)
        {
            if (string.IsNullOrEmpty(name) || name.Length > 200 || name.Trim() != name) return false;
            foreach (char ch in name) if (ch < 0x20 || ch == 0x7f || ch == '"' || ch == '\\') return false;
            return true;
        }

        // ---------------------------------------------------------- the day (bot-day.txt; reset at 18:00 ET)
        // So a restart cannot forget today's trades and losses (lead's default). "session<TAB>yyyy-MM-dd", then one line per bot
        // trade, "trade<TAB><entry tag><TAB>open" or "trade<TAB><tag><TAB><realized dollars>". Release 1 (step 1.6b): a day stop
        // reached is latched as "stop<TAB>loss|profit<TAB><the day's dollars then>" until 18:00 ET (a ChartBridge before 1.6b does
        // not understand that line and stands the bot down: the careful side). A file that cannot be read stands the bot down for
        // this run (nothing is written over it).
        // Release 1 (R12, the day file): the trade being followed is kept as "trade<TAB><tag><TAB>open<TAB><its dollars closed so
        // far><TAB><its size, signed><TAB><its average price>", written again at every execution that changes it (a part exit, a
        // late entry fill that reopens it, its close), so a restart keeps the dollars of the contracts already closed and a reopened
        // trade is followed again. The dollars are the ledger's own: (cash flow plus size times average price) times the point
        // value, plus what it closed with before (ledPrior); no commission, as the ledger. A ChartBridge before this build does not
        // understand the six field line and stands the bot down (it reads a trade line only with three fields): the careful side.
        // A three field "open" line (an older build's file) still reads, as 0 dollars closed. "untold<TAB><tag>": that trade's size
        // changed while ChartBridge was not following it, so its dollars cannot be told: no arming and no entry until 18:00 ET.
        // A missing file with a copy of today's session left by a cut off save (bot-day.txt.tmp or .bak) stands the bot down as
        // well, named: the day is never started over from nothing by accident.
        private static string SessionOf(DateTime et) { return (et.Hour >= 18 ? et.Date.AddDays(1) : et.Date).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture); }

        private static void LoadDay()
        {
            string today = SessionOf(NowEt()), fileSession = null, broken = null, stopKind = null, untold = null, left = null;
            double stopDay = 0;
            Dictionary<string, double> trades = new Dictionary<string, double>();
            Dictionary<string, OpenLine> saved = new Dictionary<string, OpenLine>();
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
                        OpenLine ol;
                        if (p.Length == 2 && p[0] == "session") fileSession = p[1];
                        else if (p.Length == 3 && p[0] == "trade" && Regex.IsMatch(p[1], "^[0-9a-f]{8}$") && p[2] == "open") trades[p[1]] = double.NaN;
                        else if (p.Length == 6 && p[0] == "trade" && Regex.IsMatch(p[1], "^[0-9a-f]{8}$") && p[2] == "open" && (ol = ReadOpenLine(p[3], p[4], p[5])) != null) { trades[p[1]] = double.NaN; saved[p[1]] = ol; }
                        else if (p.Length == 3 && p[0] == "trade" && Regex.IsMatch(p[1], "^[0-9a-f]{8}$") && double.TryParse(p[2], NumberStyles.Float, CultureInfo.InvariantCulture, out v) && !double.IsNaN(v)) trades[p[1]] = v;
                        else if (p.Length == 3 && p[0] == "stop" && stopKind == null && (p[1] == "loss" || p[1] == "profit") && double.TryParse(p[2], NumberStyles.Float, CultureInfo.InvariantCulture, out v) && !double.IsNaN(v) && !double.IsInfinity(v)) { stopKind = p[1]; stopDay = v; }
                        else if (p.Length == 2 && p[0] == "untold" && untold == null && Regex.IsMatch(p[1], "^[0-9a-f]{8}$")) untold = p[1];
                        else { broken = "bot-day.txt has a line ChartBridge does not understand"; break; }
                    }
                    if (broken == null && fileSession == null) broken = "bot-day.txt has no session line";
                }
                else
                {
                    // R12 (the day file): no file, but a copy of today's session left by a save cut off between its steps: never an
                    // empty day by accident (a copy of an earlier session is a new day, as no file)
                    foreach (string alt in ChartBridgeFiles.LeftOvers(DayFile))
                    {
                        string[] b = ChartBridgeFiles.ReadAny(alt);
                        string bs = b == null ? null : b.Select(x => x.Trim().Split('\t')).Where(x => x.Length == 2 && x[0] == "session").Select(x => x[1]).FirstOrDefault();
                        if (b != null && bs != null && bs != today) continue;
                        left = string.Join(" and ", ChartBridgeFiles.LeftOvers(DayFile).Select(Path.GetFileName));
                        broken = "bot-day.txt is missing and " + Path.GetFileName(alt) + (b == null ? ", which cannot be read," : " (today's session)") + " is there: a save may have been cut off";
                        break;
                    }
                }
            }
            catch (Exception ex) { broken = "bot-day.txt could not be read (" + ex.Message + ")"; }
            string fix = left == null ? "delete it to start the day over" : "delete " + left + " to start the day over";
            lock (Sync)
            {
                session = today;
                Trades.Clear();
                OpenSaved.Clear(); untoldTag = null; untoldWhy = null;
                if (broken != null) dayBroken = broken + ": no new bot entries this run (" + fix + ")";
                else if (fileSession == today)
                {
                    foreach (KeyValuePair<string, double> kv in trades) Trades[kv.Key] = kv.Value;
                    foreach (KeyValuePair<string, OpenLine> kv in saved) OpenSaved[kv.Key] = kv.Value;
                    dayStopKind = stopKind; dayStopDay = stopDay;
                    if (untold != null) { untoldTag = untold; untoldWhy = UntoldWords(untold, null); }
                }
            }
            if (broken != null) Log(broken + ": no new bot entries this run (" + fix + ")");
        }

        // The last three fields of an open line written by this build: the dollars closed so far (cents, as the ledger rounds them),
        // the size (signed, not 0) and the average price (above 0). Anything else: null (not understood, so the bot stands down).
        private static OpenLine ReadOpenLine(string dollars, string qty, string avg)
        {
            double d, a;
            int q;
            if (!Regex.IsMatch(dollars, "^-?[0-9]{1,9}(?:\\.[0-9]{1,2})?$") || !double.TryParse(dollars, NumberStyles.Float, CultureInfo.InvariantCulture, out d)) return null;
            if (!Regex.IsMatch(qty, "^-?[1-9][0-9]{0,5}$") || !int.TryParse(qty, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out q)) return null;
            if (!Regex.IsMatch(avg, "^[0-9]{1,9}(?:\\.[0-9]{1,12})?$") || !double.TryParse(avg, NumberStyles.Float, CultureInfo.InvariantCulture, out a) || !(a > 0)) return null;
            return new OpenLine { Dollars = d, Qty = q, Avg = a };
        }

        // Under Sync: why arming and entries wait for 18:00 ET after a trade's size changed while it was not followed.
        private static string UntoldWords(string tag, string how)
        {
            return "bot trade " + tag + (how ?? " changed size while ChartBridge was not following it (bot-day.txt)") +
                   ": the dollars of those contracts cannot be told, so copilot, auto and new bot entries are refused until 18:00 ET";
        }

        private static void SaveDay()
        {
            List<string> lines = new List<string> { "# ChartBridge bot day (written by ChartBridge; do not edit)", "# session, then one line per bot trade: tag and open (dollars closed so far, size, average price) or realized dollars" };
            lock (SaveGate)   // R12 (the day file): one write at a time, each from the state at its turn, so an older state never lands last
            {
                lock (Sync)
                {
                    if (dayBroken != null) return;   // never written over a file that could not be read
                    lines.Add("session\t" + session);
                    foreach (KeyValuePair<string, double> kv in Trades)
                    {
                        OpenLine ol;
                        if (kv.Key == openTag) ol = FollowedLineLocked();   // R12: the trade being followed, open with its dollars closed so far
                        else if (!double.IsNaN(kv.Value)) { lines.Add("trade\t" + kv.Key + "\t" + Dollars(kv.Value)); continue; }
                        else OpenSaved.TryGetValue(kv.Key, out ol);   // open in the file and not followed again yet: written back as it was read
                        lines.Add("trade\t" + kv.Key + "\topen" + (ol == null ? "" : "\t" + Dollars(ol.Dollars) + "\t" + ol.Qty.ToString(CultureInfo.InvariantCulture) + "\t" + ol.Avg.ToString("0.############", CultureInfo.InvariantCulture)));
                    }
                    if (dayStopKind != null) lines.Add("stop\t" + dayStopKind + "\t" + dayStopDay.ToString("0.##", CultureInfo.InvariantCulture));   // release 1 (1.6b): the latch
                    if (untoldTag != null) lines.Add("untold\t" + untoldTag);   // R12: until 18:00 ET, also across a restart
                }
                try
                {
                    Directory.CreateDirectory(Folder);
                    ChartBridgeFiles.WriteLines(DayFile, lines.ToArray());   // 0.6.3 (audit C3): write-through, flushed, the previous copy kept as .bak
                }
                catch (Exception ex) { Log("bot-day.txt could not be saved (" + ex.Message + "); a restart would forget today's bot trades"); }
            }
        }

        // Under Sync, for the trade being followed: its dollars closed so far, the ledger's way (the cash flow of its executions plus
        // the size still held at its average price, times the point value, plus what it closed with before it was followed again),
        // its size and its average price. Null while it holds nothing (only between a reopen and its fill, never saved then).
        private static OpenLine FollowedLineLocked()
        {
            if (openTag == null || ledQty == 0 || !(ledAvg > 0)) return null;
            return new OpenLine { Dollars = Math.Round(ledPrior + (ledCash + ledQty * ledAvg) * ledPv, 2), Qty = ledQty, Avg = ledAvg };
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
                ledPrior = 0;   // a reopened trade's earlier dollars were yesterday's
                if (openTag != null) ledCash = -ledQty * ledAvg;   // R12 (the day file): so were the dollars of its contracts closed yesterday (only the size held goes on)
                OpenSaved.Clear(); untoldTag = null; untoldWhy = null;   // R12: a trade never followed again goes with the day, and so does its refusal
                SignalIds.Clear();
                dayStopKind = null; dayStopDay = 0; stopFlattenTryMs = -1; stopFlattenWhy = null; stopFlattenWait = null; openUnknownSaid = false;   // release 1 (1.6b): the day stops' latch ends with the day
                closeTryMs = -1;
                changed = true;
            }
            if (changed) { SaveDay(); Log("a new trading day: the bot's trades, losses and day stops start over (the mode stays as it is: Anthony arms the bot)"); Notify(); }
        }

        private static int TradesToday() { lock (Sync) return Trades.Count; }
        private static int LossesToday() { lock (Sync) return Trades.Values.Count(v => v < 0); }
        private static double PnlToday() { lock (Sync) return Trades.Values.Where(v => !double.IsNaN(v)).Sum(); }

        // Rail: stand down after maxLosses losing trades (and while bot-rails.txt or bot-day.txt cannot be read). Call under Sync.
        // Release 1 (1.6b): also while the account is not the personal one, while a rail is not set, and once a day stop is reached.
        private static string StandDownLocked()
        {
            if (ChartBridgeBranches.IsNone(account) && accountBroken == null) return "the bot's account is None: no bot entries until an account is chosen on the Bot tab";   // 0.5.7: first, the plainest reason
            if (dayBroken != null) return dayBroken;
            if (railsBroken != null) return railsBroken;
            if (accountBroken != null) return accountBroken;
            string wait = ChartBridgeBranches.WaitingWords("bot", "the bot", account);   // 0.6.3 (review round 2, LOW C)
            if (wait != null) return wait;
            string own = PersonalProblem(account);   // release 1 (1.6b): the personal account only (by name here; Sim is read outside the lock)
            if (own != null) return own;
            string missing = RailsMissingLocked();
            if (missing != null) return missing;
            string unfollowed = OpenNotFollowedLocked();
            if (unfollowed != null) return unfollowed;
            if (untoldWhy != null) return untoldWhy;   // R12 (the day file): dollars that cannot be told, until 18:00 ET
            if (dayStopKind != null) return DayStopWordsLocked();
            int losses = Trades.Values.Count(v => v < 0);
            if (losses >= maxLosses) return losses + " losing trades today: no new bot entries until 18:00 ET";
            return null;
        }

        // ---------------------------------------------------------- release 1 (step 1.6b): the personal account only
        // Anthony 2026-11-17 (Q7) and 2026-11-18 ("Personal only, Sim later"): the bot trades only the personal account picked once on
        // the chart page's Accounts tab (personal-account.txt, ChartBridgeBranches.IsPersonal). With no pick it trades nothing. A Sim
        // account is refused for now: Lucid's accounts may read as NinjaTrader's simulator (law item 113), so Sim cannot be told from
        // prop by the provider name; Sim comes back only after the WORK check shows Lucid does not read as Simulator (PROTOCOL.md).
        // By name only (no NinjaTrader call): safe under Sync. Null when the account may be the bot's.
        private static string PersonalProblem(string name)
        {
            if (ChartBridgeBranches.IsNone(name)) return null;   // None trades nothing anyway (its own words come first)
            if (!ChartBridgeBranches.PersonalNamed) return "no personal account is picked (the chart page's Accounts tab): the bot trades the personal account only";
            if (!ChartBridgeBranches.IsPersonal(name)) return name + " is not the personal account: the bot trades the personal account only (choose it on the Bot tab)";
            return null;
        }

        // ---------------------------------------------------------- review R12 round 2: a bot trade still open after a restart
        // The trade being followed (openTag and its ledger) lives in memory only; bot-day.txt keeps "open" for it. After a restart or
        // a NinjaScript recompile, that trade is followed again, so its dollars reach the day stops and a latched day flattens it. Round
        // 3: only with proof the position is the bot's: a stop or target of that trade (named CB#<its tag>) still open on the bot's
        // account and root (a leg being cancelled is no proof). Its size comes from those legs (the stops', else the targets'), the side
        // from theirs (a sell stop: the bot is long), and only when NinjaTrader's position there has that side and at least that size;
        // the price is the bot's own filled entry when NinjaTrader still lists it, else NinjaTrader's average. A position with no such
        // leg is never taken (it may be Anthony's own). Until then (no leg, no matching position, or
        // more than one open trade in the file), copilot, auto and every new bot entry are refused, named; it is looked at again every
        // 500 ms. At 18:00 ET a trade never followed again is dropped with the day, as before.
        private static string OpenNotFollowedLocked()
        {
            if (openTag != null) return null;
            List<string> open = Trades.Where(kv => double.IsNaN(kv.Value)).Select(kv => kv.Key).ToList();
            if (open.Count == 0) return null;
            return "bot trade " + string.Join(", ", open) + " was still open when ChartBridge started (bot-day.txt), and " +
                   (open.Count > 1 ? "more than one open trade cannot be told apart" : "NinjaTrader shows no stop or target of it (CB#" + open[0] + ") with its " + (railRoot ?? ConfigRoot) + " position on " + account) +
                   ": copilot, auto and new bot entries are refused until it is followed again (or 18:00 ET)";
        }

        // A leg's side by its name (Sell, SellShort): read only, so this file never names an order action it could build.
        private static bool SellsLeg(Order o) { string side = Convert.ToString(o.OrderAction, CultureInfo.InvariantCulture); return side == "Sell" || side == "SellShort"; }

        private static void RestoreOpenTrade()
        {
            string tag;
            lock (Sync)
            {
                if (openTag != null || dayBroken != null) return;
                List<string> open = Trades.Where(kv => double.IsNaN(kv.Value)).Select(kv => kv.Key).ToList();
                if (open.Count != 1) return;
                tag = open[0];
            }
            Account a = FindAccount();
            string root = EffectiveRoot();
            Instrument inst = ChartBridgeServer.InstrumentFor(root);
            if (a == null || inst == null) return;
            // the proof: the trade's own stops and targets still open on this account and contract (never its entry)
            List<Order> legs = new List<Order>();
            lock (a.Orders)
                foreach (Order o in a.Orders)
                    if (o != null && TagOf(o.Name) == tag && !IsBotEntry(o) && o.Instrument != null && (o.Instrument == inst || o.Instrument.FullName == inst.FullName) &&
                        o.OrderState != OrderState.Filled && o.OrderState != OrderState.Cancelled && o.OrderState != OrderState.Rejected &&
                        o.OrderState != OrderState.CancelPending && o.OrderState != OrderState.CancelSubmitted && o.Quantity - o.Filled > 0)   // a leg on its way out proves nothing
                        legs.Add(o);
            List<Order> stops = legs.Where(o => o.OrderType == OrderType.StopMarket || o.OrderType == OrderType.StopLimit).ToList();
            List<Order> sized = stops.Count > 0 ? stops : legs.Where(o => o.OrderType == OrderType.Limit).ToList();
            if (sized.Count == 0) return;
            bool sells = SellsLeg(sized[0]);
            if (sized.Any(o => SellsLeg(o) != sells)) return;   // legs on both sides: cannot tell
            int q = sized.Sum(o => o.Quantity - o.Filled) * (sells ? 1 : -1);   // a sell stop protects a long
            Position held = null;
            lock (a.Positions)
                foreach (Position p in a.Positions)
                    if (p != null && p.Instrument != null && (p.Instrument == inst || p.Instrument.FullName == inst.FullName) && p.MarketPosition != MarketPosition.Flat && p.Quantity > 0) { held = p; break; }
            if (held == null || !(held.AveragePrice > 0)) return;
            int pos = held.MarketPosition == MarketPosition.Long ? held.Quantity : -held.Quantity;
            if (Math.Sign(pos) != Math.Sign(q) || Math.Abs(pos) < Math.Abs(q)) return;   // another side, or less than the legs cover: not the bot's as read
            // the price: the trade's own filled entry when NinjaTrader still lists it (its tag, this account and contract, the other side
            // from its legs), so Anthony's contracts held there never move it; else NinjaTrader's average, as before
            int entryFilled = 0;
            double entryCost = 0;
            lock (a.Orders)
                foreach (Order o in a.Orders)
                    if (o != null && IsBotEntry(o) && TagOf(o.Name) == tag && o.Account != null && (o.Account == a || o.Account.Name == a.Name) &&
                        o.Instrument != null && (o.Instrument == inst || o.Instrument.FullName == inst.FullName) && o.Filled > 0 && o.AverageFillPrice > 0 && SellsLeg(o) != sells)
                    { entryFilled += o.Filled; entryCost += o.Filled * o.AverageFillPrice; }
            bool fromEntry = entryFilled > 0, fromFile = false;
            double avg = fromEntry ? entryCost / entryFilled : held.AveragePrice, was, prior = 0;
            double pv = inst.MasterInstrument.PointValue;
            bool done = false;
            OpenLine ol = null;
            string untold = null;
            lock (Sync)
            {
                if (openTag == null && Trades.TryGetValue(tag, out was) && double.IsNaN(was))
                {
                    // R12 (the day file): the dollars it had closed so far (its part exits, or what it closed with before a late fill
                    // reopened it) come back with it; at the size it was saved with, so does its average price, so the day reads as
                    // before the restart to the cent. A size that changed while it was not followed (a close that filled meanwhile):
                    // followed all the same (its dollars known so far count, a latched day flattens it), but the rest cannot be told,
                    // so no arming and no entry until 18:00 ET. A line from an older build (no dollars): 0, as before.
                    if (OpenSaved.TryGetValue(tag, out ol))
                    {
                        prior = ol.Dollars;
                        if (ol.Qty == q) { avg = ol.Avg; fromFile = true; }
                        else
                        {
                            untoldTag = tag;
                            untoldWhy = untold = UntoldWords(tag, " held " + ol.Qty + " when it was saved (bot-day.txt) and " + q + " when it was followed again");
                        }
                        OpenSaved.Remove(tag);
                    }
                    openTag = tag; ledQty = q; ledAvg = avg; ledCash = -q * avg; ledPrior = prior; ledPv = pv;
                    handQty = pos - q; closeProof = 0; closeShortSaid = null;   // decision 3a: the rest of NinjaTrader's position there is Anthony's own
                    Tags.Add(tag);   // its legs' updates reach the bot again
                    done = true;
                }
            }
            if (!done) return;
            string w = "Bot: trade " + tag + " (open in bot-day.txt) is followed again from its " + sized.Count + " open " + (stops.Count > 0 ? "stop" : "target") + (sized.Count == 1 ? "" : "s") + ": " + q + " " + inst.FullName + " at " + avg.ToString("0.##", CultureInfo.InvariantCulture) + (fromFile ? " (its price in bot-day.txt)" : fromEntry ? " (its entry's fill)" : " (NinjaTrader's average)") + " on " + a.Name +
                       (prior != 0 ? ", with " + (prior < 0 ? "-$" : "$") + Dollars(Math.Abs(prior)) + " already closed" : "") +
                       (Math.Abs(pos) > Math.Abs(q) ? "; NinjaTrader holds " + pos + " there, the rest is not the bot's" : "");
            Log(w); BotLog(w); ToPages(StatusJson("warn", w));
            if (untold != null) { string u = "Bot stands down: " + untold; Log(u); BotLog(u); ToPages(StatusJson("warn", u)); SaveDay(); }
            Notify();
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
            { "botRails", new[] { "type", "cid", "size", "maxTrades", "maxLosses", "dayLoss", "dayProfit", "root" } },   // release 1 (1.6b): all seven required; the Bot tab sets every rail
            { "botAccount", new[] { "type", "cid", "account" } },   // Anthony 2026-10-07: the bot trades the account he chooses
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
            if (!Enabled) { ToBot(BotReject(id, "The bot channel is off (bot = off in config.txt).")); return; }
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
                    Proposal p = new Proposal { S = s, Account = BotAccount };
                    lock (Sync) { Proposals[s.Id] = p; nProposals++; }
                    s.Result = "proposed";
                    ToPages(ProposalJson(p));
                }
            }
            else
            {
                // auto: ChartBridge places it, on the bot's account, inside the rails and every gate.
                Order placed;
                why = Place(s, null, out placed);
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
                else if (p != null && p.State == "accepting") { p.WithdrawnWhy = reason; was = "accepting"; }   // review 2 finding 7: AnswerProposal cancels it once placed
            }
            if (was == "accepting") { BotLog("withdraw " + id + " arrived while its accept is being placed: the entry is cancelled as soon as it is placed if it has not filled (" + reason + ")"); return; }
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

        // flatten from the bot: auto mode only, and only the bot's own position on its account. Release 1 (decision 3a): its own share
        // only (CloseShare: its own orders cancelled, then market), never Anthony's contracts or orders there; before, v2 Flatten.
        private static void OnBotFlatten()
        {
            string m, root = EffectiveRoot(), why = null;
            bool open, k;
            lock (Sync) { m = mode; open = openTag != null; k = killed; }
            if (m != "auto") why = "flatten is for auto mode only";
            else if (k) why = "the kill switch is on";
            else if (!open) why = "the bot has no position to flatten";
            else
            {
                // decision 3a: only the bot's own share (CloseShare), never Anthony's contracts or orders; it goes on every 500 ms until
                // the bot is flat (closeAsked)
                lock (Sync) { closeAsked = true; closeTryMs = -1; stopFlattenWait = null; stopFlattenWhy = null; }
                int kind, qty;
                string w = CloseShare(root, out kind, out qty);
                if (kind == CloseRefused) why = w;
                else BotLog("flatten from the bot (auto): the bot's own " + root + " on " + BotAccount + ": " + (kind == CloseSent ? Contracts(qty) + " closed at market" : kind == CloseWait ? "closed once " + w : "nothing held"));
            }
            if (why != null) { ToBot(BotReject(null, why)); return; }
        }

        // ---------------------------------------------------------- placing a bot order (auto, or an accepted proposal)
        // The rails, then the account, then every v2 gate in ChartBridgeOrders (trading, gate 2 for the bot's account, the cap at
        // 1, grid, side of market, stale price, bracket). The order is built here from the signal's own parameters; the account is
        // always the bot's (the one Anthony chose) and the root always the bot's, whatever the bot sends. forAccount: a proposal's
        // account (placed only if it is still the bot's), or null.
        private static string Place(Signal s, string forAccount, out Order placed)
        {
            placed = null;
            lock (PlaceGate)
            {
                string root, acct = BotAccount;
                string rootWhy = RootProblem(out root);
                string why = RailsProblem() ?? AccountProblem(false) ?? rootWhy;
                if (why == null && forAccount != null && forAccount != acct) why = "the bot's account changed from " + forAccount + " to " + acct + " after this proposal: nothing placed";
                int qty;
                lock (Sync) qty = size;
                if (why == null && qty > ChartBridgeAgents.HardCeiling(root)) why = "the bot's size " + qty + " is above the hard ceiling of " + ChartBridgeAgents.HardCeiling(root) + " for " + root + ": set the rails again on the Bot tab";   // release 1 (1.6b): checked again at placement
                if (why == null && qty < 1) why = "the bot's size is not set (the Bot tab)";
                if (why != null) { lock (Sync) nRefused++; return why; }
                string text = "{\"type\":\"order\",\"account\":" + CbJson.Str(acct) + ",\"root\":\"" + root + "\",\"side\":\"" + s.Side + "\",\"kind\":\"" + s.Kind + "\",\"qty\":" + qty.ToString(CultureInfo.InvariantCulture) +
                              (s.Kind == "market" ? "" : ",\"price\":" + s.PriceText) +
                              ",\"bracket\":{\"stop\":" + s.StopTicks.ToString(CultureInfo.InvariantCulture) + ",\"target\":" + s.TargetTicks.ToString(CultureInfo.InvariantCulture) + "}}";
                why = ChartBridgeOrders.PlaceBotEntry(text, out placed);
                if (why != null) { lock (Sync) nRefused++; placed = null; return why; }
                lock (Sync) { Placed.Add(placed); Tags.Add(TagOf(placed.Name)); nPlaced++; handQty = 0; }   // decision 3b: the owner guard found nothing of Anthony's there
            }
            BotLog("placed " + s.Side + " " + SizeFor(EffectiveRoot()) + " " + EffectiveRoot() + " " + s.Kind + (s.PriceText != null ? " @ " + s.PriceText : "") + " stop " + s.StopTicks + " target " + s.TargetTicks + " on " + BotAccount + (SimNow() ? " (Sim)" : " (LIVE)") + " (signal " + s.Id + ")");
            return null;
        }

        // The rails (PROTOCOL.md "Bot channel", Rails). Null when a new bot entry may go.
        private static string RailsProblem()
        {
            if (!Enabled) return "The bot channel is off (bot = off in config.txt).";
            if (!ChartBridgeOrders.Enabled) return "trading is off in config.txt";            // gate 1, the master switch above every v3 switch
            RollDay();
            lock (Sync)
            {
                if (killed) return "the kill switch is on (release it on the page)";
                string sd = StandDownLocked();
                if (sd != null) return sd;                                                     // 3 losing trades (or a file that cannot be read)
                if (Trades.Count >= maxTrades) return "The bot has made " + Trades.Count + " trades today (the limit).";   // 5 trades a day
                if (openTag != null) return "the bot already has a position: one trade at a time";
            }
            if (WorkingEntries().Count > 0) return "the bot already has a working entry: one trade at a time";
            return OwnerGuard(FindAccount(), EffectiveRoot());   // release 1 (decision 3b): the owner guard
        }

        // ---------------------------------------------------------- release 1 (decision 3b, 2026-11-18): the owner guard
        // No new bot entry while Anthony holds his own position, or has his own working order, on the bot's account and root: the
        // position there minus the bot's followed size (both readings, any contract month of the root), and any order that may still
        // fill there that is not the bot's (its entries, and the legs and close of a bot trade: their tag). Named, like the agents'
        // owner lock. Copilot and auto stay armed and make no entry until the account is clear; Shadow sends nothing anyway. Asked by
        // RailsProblem (a copilot proposal, an auto entry, an accepted proposal) and again by ChartBridgeOrders.PlaceOrderLocked under
        // the order lock, so a page order cannot slip in between. Reads NinjaTrader: never under Sync. Null when the bot may enter.
        public static string OwnerGuard(Account a, string root)
        {
            if (!Enabled || a == null || string.IsNullOrEmpty(root)) return null;
            int q;
            HashSet<string> tags;
            lock (Sync) { q = openTag != null ? ledQty : 0; tags = new HashSet<string>(Tags); }
            List<Order> listed;
            lock (a.Orders) listed = a.Orders.ToList();
            foreach (Order o in listed) if (IsBotEntry(o)) tags.Add(TagOf(o.Name));   // after a restart, the bot's entries NinjaTrader still lists
            string own = ChartBridgeOrders.BotOwnerExposure(a, root, q, o => { string t = TagOf(o.Name); return IsBotEntry(o) || (t != null && tags.Contains(t)); });
            return own == null ? null : own + ": no bot entry while Anthony holds his own position or working orders on the bot's account and root (the owner guard; copilot and auto stay armed and enter once it is clear)";
        }

        // The bot's account (Anthony 2026-10-07: the one he chose, Sim or live; no Sim lock): it is in NinjaTrader under that exact
        // name, never Backtest or Playback, and (for auto and for choosing it) passes the account gates now: tradable by gate 2
        // (its checkmark, or tradeAccounts) and Connected. Every bot order passes the full gates again in PlaceBotEntry.
        private static string AccountProblem(bool forAuto) { return AccountProblemFor(BotAccount, forAuto); }

        private static string AccountProblemFor(string name, bool gates)
        {
            if (ChartBridgeOrders.IsNeverTradable(name ?? "")) return name + " is a Backtest or Playback account: the bot never trades one";
            Account a = FindAccount(name);
            if (a == null) return name + " is not in NinjaTrader";
            // release 1 (step 1.6b): a Sim account is refused for now, then the personal account only (see PersonalProblem)
            if (IsSim(a) || ChartBridgeAccounts.IsSim(a)) return name + " is a Sim account: the bot trades the personal account only (Sim comes back once the WORK check shows Lucid's accounts do not read as Simulator)";
            string own = PersonalProblem(name);
            if (own != null) return own;
            if (gates && !ChartBridgeOrders.AccountTradable(name))
                return (ChartBridgeAccounts.On ? ChartBridgeAccounts.EntryRefusal(name) : name + " may not trade from the chart (tradeAccounts in config.txt)") + ": the bot needs it tradable";
            if (gates && (a.Connection == null || a.Connection.Status != ConnectionStatus.Connected)) return name + " is not connected";
            return null;
        }

        // Minors (3): a position or a working order (any, not only the bot's) on root, any contract month, on this account. Read
        // with the order code's own readings (ChartBridgeOrders.BotHoldsOnRoot: both position readings, and orders just sent).
        private static bool HoldsOnRoot(Account a, string root) { return a != null && ChartBridgeOrders.BotHoldsOnRoot(a, root); }

        // Is the bot's account on NinjaTrader's simulator now (for the SIM or LIVE mark; it refuses nothing).
        private static bool SimNow() { Account a = FindAccount(); return a != null && IsSim(a); }
        // 0.6.3: the account's mark in texts: None (nothing trades), Sim or LIVE.
        private static string AcctMark() { string b = BotAccount; return b == null || ChartBridgeBranches.IsNone(b) ? "None" : SimNow() ? "Sim" : "LIVE"; }

        private static string RootProblem(out string root)
        {
            root = EffectiveRoot();
            if (ChartBridgeConfig.QuoteOnly(root)) return root + " is quote only: ChartBridge shows its prices on the Quote board and refuses every order for it (quoteRoots in config.txt)";
            if (root != ConfigRoot && root != Sibling(ConfigRoot)) return "the bot's root " + root + " is neither botRoot " + ConfigRoot + " nor its sibling";
            if (Sibling(root) == null) return "botRoot " + root + " is not a micro or a mini ChartBridge knows (MNQ, NQ, MES, ES)";
            if (ChartBridgeServer.InstrumentFor(root) == null) return "instrument " + root + " is not served by ChartBridge";
            return null;
        }

        private static Account FindAccount() { return FindAccount(BotAccount); }

        private static Account FindAccount(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            lock (NinjaTrader.Cbi.Account.All)
                foreach (Account a in NinjaTrader.Cbi.Account.All) if (a.Name == name) return a;   // exact, case and all
            return null;
        }

        // NinjaTrader's simulator: the account's Provider (or its connection's) is Simulator. Read by name, so a NinjaTrader
        // build without it compiles; when it cannot be read the answer is no (shown as LIVE: the careful side). Since Anthony's
        // 2026-10-07 decision this only marks SIM or LIVE; it refuses nothing.
        public static bool IsSim(Account a)
        {
            if (a == null) return false;
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

        // Every working bot entry on the bot's account: those NinjaTrader lists (also after a restart, by name) and those just sent.
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
            bool lostClose = false;
            lock (Sync)
            {
                if (IsBotEntry(o)) Tags.Add(tag);
                else if (!Tags.Contains(tag)) return;
                if (!ChartBridgeOrders.IsWorking(o.OrderState) && o.OrderState != OrderState.CancelPending && o.OrderState != OrderState.CancelSubmitted)
                {
                    Placed.Remove(o);
                    CancelSent.Remove(o);
                    lostClose = IsBotClose(o) && (o.OrderState == OrderState.Rejected || o.OrderState == OrderState.Cancelled) && o.Filled < o.Quantity && CloseLost.Add(o);   // said once an order
                }
                c = helloed ? bot : null;
            }
            if (c != null && json != null) c.Send(json);
            if (lostClose)
            {
                // decision 3a: its own close went unfilled after its stop and target were cancelled for it
                string w = "Bot: its close " + (o.Name ?? "") + " on " + (o.Account != null ? o.Account.Name : BotAccount) + " was " + (o.OrderState == OrderState.Rejected ? "REJECTED" : "CANCELLED") +
                           " with " + (o.Quantity - o.Filled) + " not filled: its stop and target were cancelled for it, so the bot's own position may have NO STOP; ChartBridge sends its close again within 5 s while the bot holds it; check NinjaTrader";
                Log(w); BotLog(w); ToPages(StatusJson("error", w));
            }
        }

        // Every execution, once (ChartBridgeServer.Deliver). Follows the bot's trade on its account: it opens with the first fill of a
        // bot entry (a trade, even partly filled) and closes when that position is flat again, whatever closed it (its stop or
        // target, Flatten on the page, an order in NinjaTrader); its realized dollars come from those executions (lead's default).
        // Release 1 (1.6b, review R12 finding 1): a fill of a bot entry whose trade has already closed (the rest of a part filled
        // entry filling after its stop, or after a day stop's flatten) reopens that trade: it is followed again, and at its close
        // the new dollars are added to what it closed with before, so the trades, the losing trades and the day stops count them.
        public static void OnExec(string account, Instrument inst, MarketPosition side, int qty, double price, string orderId, string json)
        {
            if (!Enabled || account != BotAccount || inst == null || qty <= 0) return;
            string root = ChartBridgeServer.RootFor(inst);
            if (root == null || root != EffectiveRoot()) return;
            Order o = FindOrder(orderId);
            string entryTag = IsBotEntry(o) ? TagOf(o.Name) : null;
            bool mine = o != null && Watching(o);
            RollDay();
            string closedTag = null, opened = null, reopened = null, untold = null;
            double pnl = 0;
            bool changed = false;
            ChartBridgeClient c;
            lock (Sync)
            {
                double was;
                if (openTag == null && entryTag != null && Trades.TryGetValue(entryTag, out was) && double.IsNaN(was))
                {
                    // R12 (the day file): an entry fill of a trade open in bot-day.txt and not followed again yet: the restore reads it
                    // from NinjaTrader's position with the rest; its price cannot be told apart there, so no arming and no entry until
                    // 18:00 ET (kept in bot-day.txt)
                    if (untoldTag == null) { untoldTag = entryTag; untoldWhy = untold = UntoldWords(entryTag, "'s entry filled " + qty + " more before it was followed again after a restart"); changed = true; }
                }
                else if (openTag == null && entryTag != null && Trades.TryGetValue(entryTag, out was) && !double.IsNaN(was))
                {
                    openTag = entryTag; ledQty = 0; ledCash = 0; ledAvg = 0; ledPrior = was;   // a late fill: the closed trade is open again (still one trade)
                    reopened = entryTag;
                }
                else if (openTag == null && entryTag != null)
                {
                    openTag = entryTag; ledQty = 0; ledCash = 0; ledAvg = 0; ledPrior = 0;
                    if (!Trades.ContainsKey(entryTag)) { Trades[entryTag] = double.NaN; opened = entryTag; }   // a trade (counted once, also after a restart)
                }
                // Release 1 (decision 3a, 2026-11-18): the bot follows only its own share. Its own executions (its entry, its stop and target,
                // its close: its tag) are its share. Any other execution on its contract is Anthony's own (his hand order, or a close of the
                // whole position such as Flatten): it changes the bot's share only where NinjaTrader's position can no longer hold it, so
                // Anthony's own contracts go first and his trades never enter the bot's ledger, its dollars or its day stops. Before
                // 3a every execution there counted as the bot's: right only while the bot alone held the contract.
                int signed = side == MarketPosition.Long ? qty : -qty, part = signed;
                if (!mine)
                {
                    int after = handQty + ledQty + signed;
                    int keep = openTag == null || ledQty == 0 ? 0 : Math.Sign(ledQty) * Math.Min(Math.Abs(ledQty), Math.Max(0, Math.Sign(ledQty) * after));
                    part = openTag == null ? 0 : keep - ledQty;
                    handQty = after - (ledQty + part);
                }
                if (openTag != null && part != 0)
                {
                    changed = true;   // R12 (the day file): every execution of the followed trade is saved, part exits too
                    ledPv = inst.MasterInstrument.PointValue;
                    int n = Math.Abs(part);
                    if (ledQty == 0 || Math.Sign(part) == Math.Sign(ledQty)) ledAvg = (ledAvg * Math.Abs(ledQty) + price * n) / (Math.Abs(ledQty) + n);
                    ledQty += part;
                    ledCash -= part * price;
                    if (ledQty == 0)
                    {
                        pnl = Math.Round(ledPrior + ledCash * inst.MasterInstrument.PointValue, 2);   // ledPrior: what a reopened trade had closed with
                        Trades[openTag] = pnl;
                        closedTag = openTag; openTag = null; ledAvg = 0; ledPrior = 0;
                        closeProof = 0; closeAsked = false; closeShortSaid = null;   // decision 3a: the bot is flat: its close is done
                    }
                }
                c = helloed ? bot : null;
            }
            if (mine && c != null && json != null) c.Send(json);
            if (changed) SaveDay();   // R12 (the day file): a part exit as well as an open, a close or a reopen
            if (untold != null) { string u = "Bot stands down: " + untold; Log(u); BotLog(u); ToPages(StatusJson("warn", u)); Notify(); }
            if (opened == null && closedTag == null && reopened == null) return;
            if (opened != null) BotLog("trade " + opened + " opened (" + TradesToday() + " today)");
            if (reopened != null && closedTag == null)
            {
                string w = "Bot: trade " + reopened + " is open again: its entry filled " + qty + " more after the trade had closed (followed again; its dollars are added to the trade's)";
                Log(w); BotLog(w); ToPages(StatusJson("warn", w));
                CheckDayStops();   // a day stop already reached flattens it again (at most every 5 s)
            }
            if (closedTag != null)
            {
                BotLog("trade " + closedTag + " closed: " + pnl.ToString("0.##", CultureInfo.InvariantCulture) + " dollars (" + LossesToday() + " losing today)");
                string sd;
                lock (Sync) sd = StandDownLocked();
                if (sd != null && pnl < 0) { Log("bot stands down: " + sd); ToPages(StatusJson("warn", "Bot stands down: " + sd)); }
                CheckDayStops();   // release 1 (1.6b): every close (the timer checks the open trade every 500 ms)
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

        // ChartBridgeServer.OnPositionUpdate: the bot's position (its account, its root) to the bot.
        public static void OnPosition(Account account, PositionEventArgs e)
        {
            if (!Enabled || account == null || account.Name != BotAccount || e == null || e.Position == null) return;
            string root = ChartBridgeServer.RootFor(e.Position.Instrument);
            if (root == null || root != EffectiveRoot()) return;
            ChartBridgeClient c;
            lock (Sync) c = helloed ? bot : null;
            if (c == null) return;
            int q = e.MarketPosition == MarketPosition.Long ? e.Quantity : e.MarketPosition == MarketPosition.Short ? -e.Quantity : 0;
            c.Send("{\"type\":\"position\",\"account\":" + CbJson.Str(BotAccount) + ",\"root\":" + CbJson.Str(root) + ",\"qty\":" + q.ToString(CultureInfo.InvariantCulture) +
                   ",\"avgPrice\":" + (q != 0 ? CbJson.Num(e.AveragePrice) : "null") + "}");
        }

        // Every live trade on every served root (ChartBridgeServer's tick path): one volatile read when no bot is there.
        public static void OnTick(string json)
        {
            ChartBridgeClient c = Volatile.Read(ref bot);
            if (c != null && helloed) c.Send(json);   // no lock on the tick path
        }

        // ---------------------------------------------------------- release 1 (step 1.6b): the day's loss and profit stops
        // Anthony 2026-11-17 (Q7: "flatten at once (realized + open; done for the day)") and 2026-11-18 ("Drop to Shadow"). The day is
        // the bot's realized dollars today (its closed trades) plus its open trade marked to ChartBridge's last trade on its root. At
        // or below minus dayLoss, or at or above dayProfit: the day is latched (bot-day.txt, until 18:00 ET), the mode drops to
        // Shadow (open proposals end "not answered", unfilled entries are cancelled), and the bot's own contracts are closed at once,
        // even with the kill switch on. Decision 3a (2026-11-18, "bot only"): only the bot's (CloseShare: its stop, target and entry
        // cancelled first, then one market close of its own share); Anthony's own contracts and working orders on the same account
        // and root are never touched (before 3a it was NinjaTrader's Flatten of the whole root). While latched: the close goes on
        // as CloseShare says while the bot still holds a trade (a refused close, or an entry that filled after it; a close is sent
        // again at most every 5 s), and a bot entry still working is cancelled again every 5 s. Copilot and auto are refused until
        // 18:00 ET; the new day does not arm it: Anthony arms it himself. When the open trade cannot be valued (no fresh last
        // price), the realized dollars alone are checked, said once a day.
        public static void CheckDayStops()
        {
            if (!Enabled) return;
            string root = EffectiveRoot();
            bool latched, open, held, asked;
            int q;
            double cash, realized, prior = 0, dl, dp, was;
            lock (Sync)
            {
                latched = dayStopKind != null; held = openTag != null; open = held && ledQty != 0; q = ledQty; cash = ledCash; asked = closeAsked;
                realized = Trades.Values.Where(v => !double.IsNaN(v)).Sum(); dl = dayLoss; dp = dayProfit;
                // R12 (the day file): the followed trade's dollars closed before it was followed again (bot-day.txt's, at a restore);
                // a trade reopened in this run already counts them in its closed figure (Trades), so never twice
                if (held && Trades.TryGetValue(openTag, out was) && double.IsNaN(was)) prior = ledPrior;
            }
            if (latched) { RetryStopFlatten(root, held); return; }
            if (asked && held) CloseStep(root, "the bot's flatten", false);   // decision 3a: the bot's own flatten goes on until its share is closed
            if (!(dl > 0) || !(dp > 0)) return;   // a rail not set: the bot places nothing (fail closed), so there is no day to stop
            double day = realized + prior;
            if (open)
            {
                double last;
                string why = ChartBridgeOrders.AgentLastPrice(root, out last);
                Instrument inst = ChartBridgeServer.InstrumentFor(root);
                if (why == null && inst != null) day += (cash + q * last) * inst.MasterInstrument.PointValue;
                else
                {
                    bool fresh;
                    lock (Sync) { fresh = !openUnknownSaid; openUnknownSaid = true; }
                    if (fresh) { string w = "Bot: its open trade cannot be valued (" + (why ?? "no instrument for " + root) + "): its day stops read the realized dollars alone until it can"; Log(w); BotLog(w); ToPages(StatusJson("warn", w)); }
                }
            }
            day = Math.Round(day, 2);
            string kind = day <= -dl + 1e-9 ? "loss" : day >= dp - 1e-9 ? "profit" : null;
            if (kind != null) HitDayStop(kind, day, root);
        }

        private static string DayStopWordsLocked()
        {
            if (dayStopKind == null) return null;
            string mark = dayStopKind == "loss" ? "the day's loss stop ($" + Dollars(dayLoss) + ")" : "the day's profit stop ($" + Dollars(dayProfit) + ")";
            return mark + " was reached today (the day at " + (dayStopDay < 0 ? "-$" : "$") + Dollars(Math.Abs(dayStopDay)) + ", realized plus open): the bot's own contracts were closed and it was set to Shadow; no bot entries until 18:00 ET, then Anthony arms it again";
        }

        private static void HitDayStop(string kind, double day, string root)
        {
            List<Proposal> expired;
            string old, words, unfollowed;
            bool holds;
            lock (Sync)
            {
                if (dayStopKind != null) return;   // latched once
                dayStopKind = kind; dayStopDay = day; old = mode; mode = "shadow";
                stopFlattenTryMs = Now();   // the cancel again of a lost cancel: 5 s from here
                closeTryMs = -1;            // decision 3a: the first close of the bot's share goes as soon as nothing of its own can fill
                expired = ExpireOpenLocked();
                words = DayStopWordsLocked();
                holds = openTag != null;
                unfollowed = holds ? null : OpenNotFollowedLocked();
            }
            SaveDay();
            foreach (Proposal p in expired) { ToPages(ProposalJson(p)); NotAnsweredFor(p, "a day stop was reached"); }
            int n = CancelUnfilled(), ck = CloseNothing;
            string cw = holds ? CloseStep(root, "the day stop", true, out ck) : null;
            // decision 3a, the untold case: a trade open in bot-day.txt that is not followed has no proof of its size, so nothing of it
            // is closed (its stop and target, if any, stay); it is closed once it is followed again (RestoreOpenTrade, every 500 ms)
            string text = "Bot: " + words + " (mode " + old + " to shadow" + (n > 0 ? "; " + n + " unfilled bot entr" + (n == 1 ? "y" : "ies") + " cancelled" : "") +
                          (holds ? "; " + cw : "") + (unfollowed != null ? "; nothing closed: " + unfollowed + "; act in NinjaTrader if you need to" : "") + ")";
            Log(text); BotLog(text);
            ToPages(StatusJson(unfollowed != null || ck == CloseRefused ? "error" : "warn", text));   // decision 3a: nothing of the bot's closed is an error
            Notify();
        }

        // ---------------------------------------------------------- release 1 (decision 3a, 2026-11-18, "bot only"): the bot's share
        // Anthony said "whatever you think"; the coordinator's call: when the bot's day stop fires (and for the bot's own flatten in
        // auto), ChartBridge closes only the bot's own contracts and cancels only the bot's own working orders (its entry, stop and
        // target: its tag), and leaves Anthony's own contracts and working orders on the same account and root untouched. Each step
        // (CloseShare, every 500 ms while it is due; reads NinjaTrader, never under Sync):
        //  1. the bot's own orders on its contract: the legs of its trade (its tag), every bot entry, and its own closes;
        //  2. the proof: what its legs still working on the closing side cover (its stops', else its targets', as RestoreOpenTrade
        //     reads them), the most seen while it is being closed (they are cancelled in step 4);
        //  3. a close of its own, or any other market order on its account and root (a Flatten or a close of Anthony's on its way
        //     closes the bot's share too), that may still fill: wait, never a second close beside it;
        //  4. its legs and entries still working: cancelled now (BotCloseCancel; a lost cancel again every 5 s), and nothing more
        //     until none of its legs can fill, so a leg never fills after the close and the close never reaches Anthony's contracts
        //     (an entry of its own still working does not hold the close back: its fill only adds to the bot's own position);
        //  5. the size: the smallest of the bot's followed size (its ledger), the proof, and NinjaTrader's position on the bot's side
        //     by both readings; one market close of that size (BotCloseSend), at most once every 5 s.
        // The untold case (the R12 day file: its dollars cannot be told) closes what its legs prove, as any other: the followed size
        // there came from its legs at the restore. When nothing proves it (no working leg was seen, or the trade is not followed at
        // all), nothing is closed: refused, said as an error, and the bot stays stood down. Why: the legs carry the bot's tag and are
        // sized by ChartBridge to the bot's own fills, so they can never claim Anthony's contracts; refusing outright would leave a
        // proven bot position open past its day stop, and closing past the proof could sell Anthony's own contracts.
        private const int CloseNothing = 0, CloseSent = 1, CloseWait = 2, CloseRefused = 3;
        private static readonly Regex CloseRx = new Regex("^CB#([0-9a-f]{8}) bot close$");
        private static bool IsBotClose(Order o) { return o != null && CloseRx.IsMatch(o.Name ?? ""); }
        private static bool MayStillFill(Order o) { return o != null && o.OrderState != OrderState.Filled && o.OrderState != OrderState.Cancelled && o.OrderState != OrderState.Rejected; }
        private static bool SameContract(Instrument x, Instrument y) { return x != null && y != null && (x == y || x.FullName == y.FullName); }
        private static string Contracts(int n) { return n + " contract" + (n == 1 ? "" : "s"); }

        private static string CloseShare(string root, out int kind, out int qty)
        {
            kind = CloseNothing; qty = 0;
            string tag;
            int q;
            lock (Sync) { tag = openTag; q = ledQty; }
            if (tag == null || q == 0) return null;
            kind = CloseRefused;
            Account a = FindAccount();
            Instrument inst = ChartBridgeServer.InstrumentFor(root);
            if (a == null) return BotAccount + " is not in NinjaTrader";
            if (inst == null) return "instrument " + root + " is not served by ChartBridge";
            List<Order> orders;
            lock (a.Orders) orders = a.Orders.ToList();
            lock (Sync) foreach (Order o in Placed) if (!orders.Contains(o)) orders.Add(o);
            List<Order> legs = orders.Where(o => o != null && TagOf(o.Name) == tag && !IsBotEntry(o) && !IsBotClose(o) && SameContract(o.Instrument, inst) && MayStillFill(o)).ToList();
            List<Order> entries = orders.Where(o => IsBotEntry(o) && MayStillFill(o)).ToList();
            // 2. the proof
            List<Order> live = legs.Where(o => ChartBridgeOrders.IsWorking(o.OrderState) && SellsLeg(o) == (q > 0)).ToList();
            List<Order> stops = live.Where(o => o.OrderType == OrderType.StopMarket || o.OrderType == OrderType.StopLimit).ToList();
            List<Order> sized = stops.Count > 0 ? stops : live.Where(o => o.OrderType == OrderType.Limit).ToList();
            int proofNow = sized.Sum(o => Math.Max(0, o.Quantity - o.Filled)), proof;
            lock (Sync)
            {
                if (openTag != tag) { kind = CloseNothing; return null; }
                closeProof = Math.Max(closeProof, proofNow); proof = closeProof;
            }
            // 3. a close on its way
            Func<Instrument, bool> onRoot = i => i != null && ((i.MasterInstrument != null && string.Equals(i.MasterInstrument.Name, root, StringComparison.OrdinalIgnoreCase)) || ChartBridgeServer.RootFor(i) == root);
            foreach (Order o in orders)
                if (o != null && o.OrderType == OrderType.Market && onRoot(o.Instrument) && !IsBotEntry(o) && MayStillFill(o))
                {
                    kind = CloseWait;
                    return "a market order on " + a.Name + " " + root + " may still fill (" + (o.Name ?? "no name") + ")";
                }
            // 4. its own legs and entries cancelled first
            List<Order> working = legs.Concat(entries).Where(o => ChartBridgeOrders.IsWorking(o.OrderState)).ToList(), send = new List<Order>(), lost = new List<Order>();
            bool again;
            lock (Sync)
            {
                foreach (Order o in working) if (CancelSent.Add(o)) send.Add(o); else lost.Add(o);
                double now = Now();
                again = lost.Count > 0 && now - stopFlattenTryMs >= 5000;
                if (again) stopFlattenTryMs = now;
            }
            if (again) send.AddRange(lost);
            if (send.Count > 0) ChartBridgeOrders.BotCloseCancel(a, inst, tag, send);
            // only its legs hold the close back: a leg is an exit, so one filling after the close would close twice and reach Anthony's
            // contracts; an entry of its own still working only adds to the bot's position (a late fill reopens its trade, closed again)
            if (legs.Count > 0)
            {
                kind = CloseWait;
                return "its own stop and target (" + legs.Count + " order" + (legs.Count == 1 ? "" : "s") + ") are cancelled first, so none can fill after its close";
            }
            // 5. the size, and the close
            int dir = Math.Sign(q), cover = ChartBridgeOrders.BotCover(a, inst, dir);
            if (proof <= 0) return "no stop or target of bot trade " + tag + " proves its size, so ChartBridge closes none of it (Anthony's own contracts are never touched): act in NinjaTrader";
            qty = Math.Min(Math.Min(proof, Math.Abs(q)), cover);
            if (qty <= 0) { kind = CloseWait; return "NinjaTrader's " + root + " position on " + a.Name + " holds nothing on the bot's side by both readings (only its executions are late)"; }
            bool due;
            lock (Sync) { double now = Now(); due = closeTryMs < 0 || now - closeTryMs >= 5000; if (due) closeTryMs = now; }
            if (!due) { kind = CloseWait; return "its last close was sent less than 5 s ago"; }
            Order sent;
            string why = ChartBridgeOrders.BotCloseSend(a, inst, tag, dir, qty, out sent);
            if (why != null) return why;
            kind = CloseSent;
            string shortWhy = null;
            lock (Sync)
            {
                if (proof < Math.Abs(q) && closeShortSaid != tag) { closeShortSaid = tag; shortWhy = "bot trade " + tag + " follows " + Contracts(Math.Abs(q)) + " but its own stop and target prove only " + proof + ": ChartBridge closed those " + proof + " and none of the rest, which cannot be told apart from Anthony's own contracts; act in NinjaTrader"; }
            }
            if (shortWhy != null) { string w = "Bot: " + shortWhy; Log(w); BotLog(w); ToPages(StatusJson("error", w)); }
            return null;
        }

        // One step of closing the bot's share, in words. quiet: the caller says them (the day stop's first step). Otherwise a wait is
        // said once a reason, a refusal once a reason as an error (the bot's position may be left without its stop and target), and
        // every close sent.
        private static string CloseStep(string root, string what, bool quiet) { int kind; return CloseStep(root, what, quiet, out kind); }
        private static string CloseStep(string root, string what, bool quiet, out int kind)
        {
            int qty;
            string why = CloseShare(root, out kind, out qty), was, where = BotAccount + " " + root;
            if (kind == CloseNothing) return "the bot holds nothing on " + where;
            string words = kind == CloseSent ? "the bot's own " + Contracts(qty) + " on " + where + " closed at market (only the bot's: Anthony's own contracts and orders are untouched)"
                         : kind == CloseWait ? "the bot's own contracts on " + where + " are closed once nothing of its own can fill: " + why
                         : "the bot's own contracts on " + where + " were not closed: " + why + " (looked at again every 500 ms)";
            lock (Sync) { was = kind == CloseRefused ? stopFlattenWhy : stopFlattenWait; if (kind == CloseRefused) stopFlattenWhy = why; else if (kind == CloseWait) stopFlattenWait = why; else { stopFlattenWait = null; stopFlattenWhy = null; } }
            if (quiet) return words;
            if (kind == CloseSent) { string w = "Bot: " + what + ": " + words; Log(w); BotLog(w); ToPages(StatusJson("warn", w)); }
            else if (why != was) { string w = "Bot: " + what + ": " + words; Log(w); BotLog(w); if (kind == CloseRefused) ToPages(StatusJson("error", w)); }
            return words;
        }

        // Release 1 (1.6b, review R12 finding 1): while the day is latched. held: the bot still holds a trade (a refused close, or an
        // entry that filled after it): its share is closed as CloseShare says (decision 3a; a close at most every 5 s, never beside
        // one still on its way). Otherwise a bot entry still working (its cancel lost): its cancel again every 5 s, the try reserved
        // under Sync so two overlapping checks never send two, never a close of a root the bot holds nothing on.
        private static void RetryStopFlatten(string root, bool held)
        {
            if (held) { CloseStep(root, "the day stop", false); return; }
            List<Order> working = WorkingEntries();
            if (working.Count == 0) return;
            bool due;
            lock (Sync) { double now = Now(); due = now - stopFlattenTryMs >= 5000; if (due) stopFlattenTryMs = now; }
            if (!due) return;
            lock (Sync) foreach (Order o in working) CancelSent.Remove(o);
            int n = 0;
            foreach (Order o in working) if (Cancel(o)) n++;
            if (n > 0) { string w = "Bot: the day stop: " + n + " bot entr" + (n == 1 ? "y is" : "ies are") + " still working: cancel sent again"; Log(w); BotLog(w); }
        }

        // ---------------------------------------------------------- the timer: heartbeat, the day, the strip
        public static void Check()
        {
            if (!Enabled) return;
            bool kp;
            lock (Sync) kp = killReadPending && killed;
            if (kp)
            {
                double? k = ChartBridgeFiles.KillSince(KillFile);
                if (k != -1) { lock (Sync) { killReadPending = false; if (k.HasValue) killedAt = k.Value; } Log("bot-kill.txt read now: the kill switch stays on until it is released on the page"); Notify(); }
            }
            RollDay();
            RestoreOpenTrade();   // review R12 round 2: until it is followed again, no arming and no entry (OpenNotFollowedLocked)
            CheckDayStops();   // release 1 (1.6b): the day's loss and profit stops, realized plus open
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

        // ---------------------------------------------------------- messages from the page (botMode, botKill, botSeen, botAnswer, botRails, botAccount)
        public static void OnPageMessage(ChartBridgeClient client, string type, string text)
        {
            string why;
            Dictionary<string, Val> d = Parse(text, out why);
            string cid = d != null ? S(d, "cid") : null, id = d != null ? S(d, "id") : null;
            try
            {
                if (!Enabled) { PageReject(client, cid, id, "The bot channel is off (bot = off in config.txt)."); return; }   // switch off: refused, nothing done
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
                else if (type == "botAccount") { bool dropped = false; lock (PlaceGate) { why = SetAccount(d); if (why == null) dropped = ChartBridgeBranches.Chosen("bot"); } if (dropped) Notify(); }   // 0.6.3 (review round 2, MED A): under PlaceGate, as the reset
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
            if (m == "auto" && ChartBridgeBranches.IsNone(BotAccount)) return "auto refused: the bot's account is None: no bot entries until an account is chosen on the Bot tab";   // 0.5.7
            if (m == "auto") { string why = AccountProblem(true); if (why != null) return "auto refused: " + why; }   // auto: the bot's account must be tradable
            if (m != "shadow") { string why = ArmProblem(); if (why != null) return m + " refused: " + why; }   // release 1 (1.6b): fail closed, the personal account, no re-arm after a day stop
            Action race = ModeArmChecked;
            if (race != null) race();
            string old;
            List<Proposal> expired = new List<Proposal>();
            lock (Sync)
            {
                if (m != "shadow")
                {
                    // review R12 finding 2: checked again where the mode is set, so a day stop reached (or a rail lost) after ArmProblem
                    // above can never be armed over (the latch ends at 18:00 ET; the bot must not then be armed by itself)
                    string again = railsBroken ?? RailsMissingLocked() ?? OpenNotFollowedLocked() ?? DayStopWordsLocked();
                    if (again != null) return m + " refused: " + again;
                }
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

        // Release 1 (step 1.6b): what refuses copilot and auto (Shadow is always allowed). The account (the personal one, never Sim:
        // AccountProblemFor), a rails file that cannot be read, a rail not set (each named), and a day stop reached today: the bot
        // stays in Shadow until 18:00 ET, and Anthony arms it again himself after that.
        private static string ArmProblem()
        {
            string acct = BotAccount;
            if (!ChartBridgeBranches.IsNone(acct)) { string a = AccountProblemFor(acct, false); if (a != null) return a; }
            lock (Sync)
            {
                if (railsBroken != null) return railsBroken;
                if (dayBroken != null) return dayBroken;   // R12 (the day file): a day that cannot be read is never armed on
                string missing = RailsMissingLocked();
                if (missing != null) return missing;
                string unfollowed = OpenNotFollowedLocked();
                if (unfollowed != null) return unfollowed;
                if (untoldWhy != null) return untoldWhy;   // R12 (the day file)
                if (dayStopKind != null) return DayStopWordsLocked();
            }
            return null;
        }

        private static string SetKill(Dictionary<string, Val> d)
        {
            bool on;
            if (!Bool(d, "on", out on)) return "on must be true or false";
            List<Proposal> expired = new List<Proposal>();
            string saveErr = null;   // 0.6.3 (audit C5): saved, so a restart keeps it; a release whose file cannot be removed is refused
            if (on) { bool was; lock (Sync) was = killed; if (!was) saveErr = ChartBridgeFiles.SaveKill(KillFile, "the bot", Now()); }
            else { string err = ChartBridgeFiles.ClearKill(KillFile); if (err != null) return "bot-kill.txt could not be removed (" + err + "): the kill switch stays on"; }
            lock (Sync) { if (on && !killed) killedAt = Now(); killed = on; if (!on) killedAt = 0; if (on) expired = ExpireOpenLocked(); }
            if (on)
            {
                if (saveErr != null) { string w = "bot-kill.txt could not be saved (" + saveErr + "): the kill switch is on now but a restart would release it"; ToPages(StatusJson("warn", w)); Log(w); }
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
            string why = Place(p.S, p.Account, out placed), withdrawn;
            lock (Sync) { p.State = why == null ? "accepted" : "rejected"; p.Entry = placed; if (placed != null) EntryOfSignal[id] = placed; withdrawn = p.WithdrawnWhy; }
            // Review 2 finding 7: the bot withdrew it while it was being placed: cancelled at once if it has not filled.
            bool cancelled = why == null && withdrawn != null && placed != null && placed.Filled == 0 && Cancel(placed);
            if (cancelled) lock (Sync) p.State = "withdrawn";
            ToPages(ProposalJson(p));
            ToBot(AnswerJson(id, why == null ? "accepted" : "refused", why == null ? "placed on " + p.Account + (cancelled ? "; withdrawn during placement: its entry is cancelled" : "") : why));
            BotLog("proposal " + id + " accepted on the page" + (why == null ? ": placed on " + p.Account : " but refused: " + why));
            if (withdrawn != null && why == null)
                BotLog("proposal " + id + " withdrawn during placement (" + withdrawn + "): " + (cancelled ? "its unfilled entry cancelled" : "its entry had already filled or ended; nothing cancelled (its stop and target stay)"));
            Notify();
            return why == null ? null : "accepted, but refused: " + why;
        }

        // botRails (release 1, step 1.6b): every rail at once, all required: size (1 to the hard ceiling of root), maxTrades and
        // maxLosses (1 to RailCountMax), dayLoss and dayProfit (dollars above 0, at most 2 decimals), root (botRoot or its sibling).
        // 0, null or anything else is refused in plain words: nothing is "no limit". Refused while the bot has a position or a
        // working entry. A day stop already reached today stays reached (the latch is not a rail).
        private static string SetRails(Dictionary<string, Val> d)
        {
            int z, t, l;
            double dl, dp;
            string root = (S(d, "root") ?? "").ToUpperInvariant();
            if (root != ConfigRoot && root != Sibling(ConfigRoot)) return "root must be " + ConfigRoot + (Sibling(ConfigRoot) != null ? " or " + Sibling(ConfigRoot) : "") + " (botRoot and its micro/mini sibling)";
            if (ChartBridgeConfig.QuoteOnly(root) || ChartBridgeServer.InstrumentFor(root) == null) return "instrument " + root + " is not traded by ChartBridge";
            int ceil = ChartBridgeAgents.HardCeiling(root);
            if (Whole(d, "size", out z) != 1 || z < 1 || z > ceil) return "size must be a whole number from 1 to " + ceil + " for " + root + " (the hard ceiling: 2 minis or 20 micros, raised only by a new ChartBridge build)";
            if (Whole(d, "maxTrades", out t) != 1 || t < 1 || t > RailCountMax) return "maxTrades must be a whole number from 1 to " + RailCountMax;
            if (Whole(d, "maxLosses", out l) != 1 || l < 1 || l > RailCountMax) return "maxLosses must be a whole number from 1 to " + RailCountMax;
            if (!Money(d, "dayLoss", out dl)) return "dayLoss must be dollars above 0, at most " + Dollars(ChartBridgeAgents.DayStopMax) + ", at most 2 decimals (the day's loss stop, realized plus open)";
            if (!Money(d, "dayProfit", out dp)) return "dayProfit must be dollars above 0, at most " + Dollars(ChartBridgeAgents.DayStopMax) + ", at most 2 decimals (the day's profit stop, realized plus open)";
            bool exposed;
            lock (Sync) exposed = openTag != null;
            if (exposed || WorkingEntries().Count > 0) return "the bot has a position or a working entry: change its rails when it is flat";
            string err = SaveRails(z, t, l, dl, dp, root);
            if (err != null) return "bot-rails.txt could not be saved (" + err + "); nothing changed";
            lock (Sync) { size = z; maxTrades = t; maxLosses = l; dayLoss = dl; dayProfit = dp; railRoot = root == ConfigRoot ? null : root; railsBroken = null; }
            string words = "size " + z + " " + root + ", " + t + " trades, " + l + " losing trades, day loss stop $" + Dollars(dl) + ", day profit stop $" + Dollars(dp);
            Log("bot rails set by the page: " + words);
            BotLog("rails set by the page: " + words);
            ToBot(WelcomeJson());   // so the bot knows its root and rails (lead's default)
            Notify();
            return null;
        }

        // A dollar value from the page: a plain number above 0, at most DayStopMax, at most 2 decimals.
        private static bool Money(Dictionary<string, Val> d, string key, out double v)
        {
            v = 0;
            Val x;
            if (!d.TryGetValue(key, out x) || (x.K != 'n' && x.K != 'd')) return false;
            return MoneyText(x.T, out v);
        }

        // botAccount (Anthony 2026-10-07): the account the bot trades, Sim or live. Refused while the bot has a position or a
        // working entry (its trade would be split across two accounts), when the account does not pass the account gates now
        // (in NinjaTrader, never Backtest or Playback, its checkmark or tradeAccounts, Connected), and when the copier uses it (a
        // follower that is on, or the leader). Saved in bot-account.txt; open proposals expire (they were for the old account).
        // 0.5.7 (DECISION 2026-10-14e): "account": null is None: refused only while the bot has a position or a working entry.
        private static string SetAccount(Dictionary<string, Val> d)
        {
            Val v;
            if (d.TryGetValue("account", out v) && v.K == 'z') return SetNone();
            string name = S(d, "account");
            if (!PlainName(name) || ChartBridgeBranches.IsNone(name)) return "account must be an account name, or null for None";
            string why = AccountProblemFor(name, true);
            if (why != null) return why;
            why = ChartBridgeCopier.BotAccountRefusal(name);
            if (why != null) return why;
            bool exposed;
            lock (Sync) exposed = openTag != null;
            if (exposed || WorkingEntries().Count > 0) return "the bot has a position or a working entry: choose its account when it is flat";
            string old = BotAccount;
            bool broken;
            lock (Sync) broken = accountBroken != null;
            if (name == old && !broken) return null;   // already the bot's account
            why = ChartBridgeAgents.AccountTakenWhy(name, "the bot");   // 0.5.0 agents: never an agent's account (ruling 1)
            if (why != null) return why;
            // Minors (3): any position or working order on the bot's root, the bot's or not, on the account chosen or on the bot's
            // account now, refuses the change (a trade there would sit beside the bot's or under its rails).
            string root = EffectiveRoot();
            if (HoldsOnRoot(FindAccount(name), root)) return name + " holds a position or a working order on " + root + ": choose the bot's account when both accounts are flat on " + root;
            if (name != old && HoldsOnRoot(FindAccount(old), root)) return "the bot's account " + old + " holds a position or a working order on " + root + ": choose the bot's account when both accounts are flat on " + root;
            string err = SaveAccount(name);
            if (err != null) return "bot-account.txt could not be saved (" + err + "); nothing changed";
            List<Proposal> expired;
            lock (Sync) { account = name; accountBroken = null; expired = ExpireOpenLocked(); }
            foreach (Proposal p in expired) { ToPages(ProposalJson(p)); ToBot(AnswerJson(p.S.Id, "not answered", "the bot's account changed to " + name)); BotLog("proposal " + p.S.Id + " not answered (the bot's account changed to " + name + ")"); }
            string mark = AcctMark();
            Log("bot account " + name + " (" + mark + "), was " + old + ", set by the page");
            BotLog("account " + name + " (" + mark + "), was " + old + ", set by the page");
            ToBot(WelcomeJson());   // so the bot knows its account
            Notify();
            return null;
        }

        // Review of #47: SetNone, GoNone and ResetToNone take PlaceGate (never between a placement's checks and its order); the
        // lock order is Place's own: PlaceGate, then ChartBridgeOrders' PlaceLock or Sync, never the other way.
        private static string SetNone() { lock (PlaceGate) return SetNoneLocked(); }
        private static string SetNoneLocked()
        {
            bool exposed;
            lock (Sync) exposed = openTag != null;
            if (exposed || WorkingEntries().Count > 0) return "the bot has a position or a working entry: choose None when it is flat";
            return GoNone("set by the page");
        }

        // The bot on None: saved, open proposals end, the bot is told. Null, or why not.
        private static string GoNone(string by)
        {
            lock (PlaceGate) return GoNoneLocked(by);
        }
        private static string GoNoneLocked(string by)
        {
            string old = BotAccount;
            bool broken;
            lock (Sync) broken = accountBroken != null;
            if (ChartBridgeBranches.IsNone(old) && !broken) return null;
            string err = SaveAccount(ChartBridgeBranches.None);
            if (err != null) return "bot-account.txt could not be saved (" + err + "); nothing changed";
            List<Proposal> expired;
            lock (Sync) { account = ChartBridgeBranches.None; accountBroken = null; expired = ExpireOpenLocked(); }
            foreach (Proposal p in expired) { ToPages(ProposalJson(p)); NotAnsweredFor(p, "the bot's account changed to None"); }
            Log("bot account None (nothing trades), was " + old + ", " + by);
            BotLog("account None (nothing trades), was " + old + ", " + by);
            ToBot(WelcomeJson());
            Notify();
            return null;
        }
        private static void NotAnsweredFor(Proposal p, string why) { ToBot(AnswerJson(p.S.Id, "not answered", why)); BotLog("proposal " + p.S.Id + " not answered (" + why + ")"); }

        // The daily reset (ChartBridgeBranches.Run): "" when the bot is on None now, a note when it keeps its account, null when
        // nothing was to do.
        public static string ResetToNone()
        {
            if (!Enabled && ChartBridgeBranches.DroppedWhileRetrying("bot")) return null;   // 0.6.3 (review round 2, MED A)
            if (!Enabled) return ResetFileToNone();
            lock (PlaceGate) return ResetToNoneLocked();
        }
        private static string ResetToNoneLocked()
        {
            if (ChartBridgeBranches.DroppedWhileRetrying("bot")) return null;   // 0.6.3 (review round 2, MED A)
            string acct = BotAccount;
            if (ChartBridgeBranches.IsNone(acct) || ChartBridgeBranches.KeepThroughReset("bot", acct)) return null;
            string unk = ChartBridgeBranches.UnknownWhy(FindAccount(acct), acct);   // 0.6.3 (review HIGH 1)
            if (unk != null) return ChartBridgeBranches.WaitWords("the bot", acct, unk);
            bool exposed;
            lock (Sync) exposed = openTag != null;
            if (exposed || WorkingEntries().Count > 0 || !ChartBridgeBranches.Idle(FindAccount(acct))) return ChartBridgeBranches.SkipWords("the bot", acct);
            string why = GoNone("by the daily reset (17:00 ET)");
            return why == null ? "" : "the bot stays on " + acct + ": " + why;
        }

        // The bot channel off: bot-account.txt alone (it is read again when the bot is turned on). A file that cannot be understood
        // is never written over (null: nothing to do).
        private static string ResetFileToNone()
        {
            string acct = ReadAccountFile();
            if (acct == null || ChartBridgeBranches.IsNone(acct) || ChartBridgeBranches.KeepThroughReset("bot", acct)) return null;
            string unk = ChartBridgeBranches.UnknownWhy(FindAccount(acct), acct);   // 0.6.3 (review HIGH 1)
            if (unk != null) return ChartBridgeBranches.WaitWords("the bot (off)", acct, unk);
            if (!ChartBridgeBranches.Idle(FindAccount(acct))) return ChartBridgeBranches.SkipWords("the bot (off)", acct);
            string err = SaveAccount(ChartBridgeBranches.None);
            if (err != null) return "the bot (off) stays on " + acct + ": bot-account.txt could not be saved (" + err + ")";
            Log("bot account None (nothing trades), was " + acct + ", by the daily reset (17:00 ET; the bot channel is off)");
            return "";
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
            if (!Enabled || client == null || !client.Trader || !ChartBridgeV3.IsV3(client)) return;   // integration: the one v3 handshake
            client.Send(StripJson());
            List<Proposal> open;
            lock (Sync) open = Proposals.Values.Where(p => p.State == "open").ToList();
            foreach (Proposal p in open) client.Send(ProposalJson(p));
        }

        // ---------------------------------------------------------- messages out
        private static void ToBot(string json)
        {
            ChartBridgeClient c;
            lock (Sync) c = bot;
            if (c != null) c.Send(json);
        }

        private static void ToPages(string json) { ChartBridgeV3.SendToV3Traders(json); }   // integration: the one shared v3 send

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
            bool simNow = SimNow();   // read before the lock (NinjaTrader's account list has its own)
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
                 .Append(",\"account\":").Append(ChartBridgeBranches.Json(account))
                 .Append(",\"sim\":").Append(simNow ? "true" : "false")
                 .Append(",\"root\":").Append(CbJson.Str(root))
                 .Append(",\"position\":{\"qty\":").Append(ledQty.ToString(CultureInfo.InvariantCulture)).Append(",\"avgPrice\":").Append(ledQty != 0 ? CbJson.Num(ledAvg) : "null").Append('}')
                 .Append(",\"pnlToday\":").Append(CbJson.Num(Math.Round(pnl, 2)))
                 .Append(",\"trades\":").Append(Trades.Count)
                 .Append(",\"maxTrades\":").Append(maxTrades > 0 ? maxTrades.ToString(CultureInfo.InvariantCulture) : "null")
                 .Append(",\"losses\":").Append(losses)
                 .Append(",\"maxLosses\":").Append(maxLosses > 0 ? maxLosses.ToString(CultureInfo.InvariantCulture) : "null")
                 .Append(",\"maxQty\":").Append(size > 0 ? size.ToString(CultureInfo.InvariantCulture) : "null")   // release 1 (1.6b): the Bot tab's size (null: not set)
                 .Append(",\"size\":").Append(size > 0 ? size.ToString(CultureInfo.InvariantCulture) : "null")
                 .Append(",\"hardCeiling\":").Append(ChartBridgeAgents.HardCeiling(root))
                 .Append(",\"dayLoss\":").Append(dayLoss > 0 ? CbJson.Num(dayLoss) : "null")
                 .Append(",\"dayProfit\":").Append(dayProfit > 0 ? CbJson.Num(dayProfit) : "null")
                 .Append(",\"railsMissing\":[").Append(string.Join(",", MissingLocked().Select(x => CbJson.Str(x)))).Append(']')
                 .Append(",\"dayStop\":").Append(dayStopKind != null ? "{\"kind\":" + CbJson.Str(dayStopKind) + ",\"day\":" + CbJson.Num(dayStopDay) + ",\"text\":" + CbJson.Str(DayStopWordsLocked()) + "}" : "null")
                 .Append(",\"personal\":").Append(PersonalProblem(account) == null && !ChartBridgeBranches.IsNone(account) ? "true" : "false")
                 .Append(",\"killed\":").Append(killed ? "true" : "false")
                 .Append(",\"killedAt\":").Append(killed && killedAt > 0 ? Ms(killedAt) : "null")   // 0.6.3 (audit C5)
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
                       ",\"trades\":" + Trades.Count + ",\"losses\":" + Trades.Values.Count(v => v < 0) + ",\"dayStop\":" + (dayStopKind != null ? CbJson.Str(dayStopKind) : "null") + "}";
            }
        }

        private static string WelcomeJson()
        {
            string root = EffectiveRoot(), m;
            int z, t, l;
            double dl, dp;
            bool k;
            lock (Sync) { m = mode; z = size; t = maxTrades; l = maxLosses; dl = dayLoss; dp = dayProfit; k = killed; }
            Func<int, string> N = x => x > 0 ? x.ToString(CultureInfo.InvariantCulture) : "null";
            Instrument inst = ChartBridgeServer.InstrumentFor(root);
            string instruments = inst == null ? "[]" :
                "[{\"root\":" + CbJson.Str(root) + ",\"name\":" + CbJson.Str(inst.FullName) + ",\"tick\":" + CbJson.Num(inst.MasterInstrument.TickSize) +
                ",\"pointValue\":" + CbJson.Num(inst.MasterInstrument.PointValue) + ",\"quoteOnly\":false}]";
            return "{\"type\":\"welcome\",\"version\":" + CbJson.Str(ChartBridgeServer.Version) + ",\"mode\":" + CbJson.Str(m) + ",\"account\":" + ChartBridgeBranches.Json(BotAccount) + ",\"sim\":" + (SimNow() ? "true" : "false") + ",\"root\":" + CbJson.Str(root) +
                   ",\"killed\":" + (k ? "true" : "false") + ",\"rails\":{\"maxQty\":" + N(z) + ",\"size\":" + N(z) + ",\"maxTrades\":" + N(t) + ",\"maxLosses\":" + N(l) +
                   ",\"dayLoss\":" + (dl > 0 ? CbJson.Num(dl) : "null") + ",\"dayProfit\":" + (dp > 0 ? CbJson.Num(dp) : "null") + "},\"instruments\":" + instruments + "}";
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
            Account pa = FindAccount(p.Account);
            return "{\"type\":\"botProposal\",\"id\":" + CbJson.Str(s.Id) + ",\"at\":" + Ms(s.At) + ",\"account\":" + CbJson.Str(p.Account ?? BotAccount) + ",\"sim\":" + (pa != null && IsSim(pa) ? "true" : "false") + ",\"root\":" + CbJson.Str(EffectiveRoot()) +
                   ",\"side\":" + CbJson.Str(s.Side) + ",\"kind\":" + CbJson.Str(s.Kind) + ",\"price\":" + (s.PriceText ?? "null") + ",\"qty\":" + SizeFor(EffectiveRoot()).ToString(CultureInfo.InvariantCulture) +
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
