// ChartBridge 0.5.0: the agent channel (nt8/PROTOCOL.md, "Agent channel (agents, 0.5.0)"). Part of the ChartBridge add-on;
// install it with the other ChartBridge files. 0.5.2: the window is measured in session time (minutes since the 18:00 New
// York open), so an agent may trade the whole session, 18:00 to its entryUntil, across midnight (ChartBridgeAgent.SessionSec).
//
// Any number of agent programs (the first is named in config.txt "agents = ..."; each id has its own files, rules, account,
// mode and state) connect on their own WebSocket path, /agent/<id>, each with its own secret (agent-<id>-secret.txt next to
// config.txt, made by ChartBridge on this PC and never printed). AI is never in the order path: an agent sends PLANS, and
// ChartBridge itself places every agent order, from the plan's parameters, inside that agent's rules, through every v2 gate
// (ChartBridgeOrders.PlaceAgentEntry, the page's own order path with the agent as its source). Rules, each enforced here:
//   one object per agent id (ChartBridgeAgent), never one static slot;
//   the upgrade: loopback only (as every request), the id in "agents" (else 404), NO Origin header (403), the agent's secret in
//     X-ChartBridge-Agent (constant-time compare; wrong or missing: 403), a WebSocket upgrade (else 400), one connection per id (409);
//   modes: shadow (nothing placed), copilot (a proposal; only Anthony's accept places it, open until the plan's own expiry),
//     auto (placed); every start begins in shadow;
//   plans: checks 1 to 12 of the contract, in that order, in every mode, and again at the moment of placing;
//   entries: limit or stop-limit only, always with a stop and a target, at most the agent's maxQty and never above the hard
//     ceiling (minis 2, micros 20: HardCeiling, a code change and a review to raise); one position and one entry at a time;
//   ChartBridge's own timers cancel an unfilled entry at its expiry and outside the entry window, and at flatAt cancel every
//     working order of the agent on its account and roots, then close its position at market, even with the agent gone;
//   heartbeat: 5 s of silence (or a disconnect, or no connection for 5 s after a start) cancels the agent's unfilled entries,
//     expires its proposals, keeps every stop and target, and tells the pages;
//   the owner lock: an (account, root) an agent owns refuses entries from every other source (PlaceOrderLocked and the copier's
//     Eligible ask EntryCheck), and an agent is refused wherever anything else holds a position or a working order;
//   accounts: never the bot's, never the copier's leader or a follower, never another agent's.
// 0.6.0 (group trading, Anthony 2026-10-15): an agent trades one account or a whole prop group. Each account it trades is a SEAT
// (ChartBridgeAgent.Seat: its own open trade, ledger, owner locks, flatten jobs and lost-trade errors). One plan, one decision:
// ChartBridge places it on every seat that can take it, each with the size the runner gave it (plan.sizes), each checked on its
// own; a seat that cannot take it sits that trade out. A seat that leaves the group while it holds the agent's trade stays the
// agent's (owned, protected, flattened at flatAt) until flat, and takes no new entry.
// 0.6.2 (SPEC CE-2): a hero (a build) stood down on a prop group (the runner's standDown; agent-standdowns.txt, written only here)
// takes no new entry on any seat in that group until Anthony clears it on the Board (agentStandDownClear); only entries are gated.
// A league seat is one Sim account: its entries are refused whenever the account is not Sim (read fresh at every gate).
// Written in C# 5 syntax (NinjaTrader 8 compiles NinjaScript as C# 5).
#region Using declarations
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using NinjaTrader.Cbi;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    // ---------------------------------------------------------------- the agent channel's window into ChartBridgeOrders
    // The agent code reuses the order code's own gates and readings (the same functions, never a copy), through these wrappers.
    public static partial class ChartBridgeOrders
    {
        // 0.5.0 agents: an agent entry (ChartBridgeAgent builds the message from the plan's own parameters, always the agent's
        // account), through the same strict reading, quote-only check and gates as an order from the page, with the agent as
        // its source (the owner lock, the agent's ceiling, its name). Never a strategy (no strategy object is cut out).
        internal static string PlaceAgentEntry(string agentId, string text, out Order placed) { return PlaceAgentEntry(agentId, null, text, out placed); }
        // planId: the plan it comes from (an agent's order messages to a v3 page carry it as "planId").
        internal static string PlaceAgentEntry(string agentId, string planId, string text, out Order placed)
        {
            placed = null;
            string bracketBody, why, top = TopLevel("order", text, out bracketBody, out why);
            if (why == null) why = QuoteOnly(top, null);
            return why ?? PlaceOrder(top, bracketBody, null, null, false, agentId, planId, out placed);
        }
        internal static object AgentPlaceLock { get { return PlaceLock; } }
        internal static string AgentIdFor(Order o) { return IdFor(o); }   // the id the agent's order messages carry ("o12")
        internal static string AgentOrderJson(Order o) { return AgentOrderJson(o, null); }   // the snapshot after hello
        // As the page's order message, with the agent's roles: its flat close "flat", its protective exit "protect" (section 10).
        // Section 10 item 6: and orderName, NinjaTrader's own name of the order (the tag the agent's legs carry); name stays the instrument.
        internal static string AgentOrderJson(Order o, string text)
        {
            string json = OrderJson(o, text, AgentRoleFor(o));
            return json.Substring(0, json.Length - 1) + ",\"orderName\":" + (o.Name != null ? CbJson.Str(o.Name) : "null") + "}";
        }
        // "CB#<tag> ag:<id> flat", "CB#<tag> ag:<id> protect f<n>" (n: the entry's filled count it exited), "CB#<tag> ag:<id> stop p<price>"
        // (the stop placed again over a shut market).
        private static readonly Regex AgentMarketRx = new Regex("^CB#([0-9a-f]{8}) ag:[a-z][a-z0-9]{0,11} (flat|protect f([0-9]{1,6})|stop p[0-9]{1,9}(?:\\.[0-9]{1,8}){0,1})$");
        internal static string AgentRoleFor(Order o)
        {
            if (o == null) return "other";
            Match m = AgentMarketRx.Match(o.Name ?? "");
            return m.Success ? m.Groups[2].Value.Split(' ')[0] : RoleFor(o);
        }
        // An agent's protective exit read as v2's exit name for the recovery and the exit alarm: "CB#<tag> exit f<n> q0 p0" (the
        // recovery counts the contracts up to f<n> as handled and values them from NinjaTrader's executions of the entry).
        private static string AgentLegName(string name)
        {
            Match m = AgentMarketRx.Match(name ?? "");
            return m.Success && m.Groups[3].Success ? "CB#" + m.Groups[1].Value + " exit f" + m.Groups[3].Value + " q0 p0" : name ?? "";
        }
        // ChartBridge's id of an order it already knows ("o12"), never a new one; null when it has none.
        internal static string AgentKnownId(Order o) { string id; lock (Sync) return o != null && IdOf.TryGetValue(o, out id) ? id : null; }
        internal static string AgentPriceProblem(string root, double tick, string kind, bool isBuy, double price) { return PriceProblem(root, tick, kind, isBuy, price); }
        internal static bool AgentOnGrid(double price, double tick) { return OnGrid(price, tick); }
        internal static string AgentLastPrice(string root, out double p) { return LastPrice(root, out p); }
        internal static int AgentListed(Account a, Instrument i) { return SignedPosition(a, i); }
        internal static int AgentEffective(Account a, Instrument i) { return EffectivePosition(a, i); }
        internal static bool AgentHoldsOnRoot(Account a, string root) { return BotHoldsOnRoot(a, root); }
        internal static List<Order> AgentMayFill(Account a, Instrument i) { return CopierMayFill(a, i); }
        internal static bool AgentMayFillState(OrderState s) { return MayFill(s); }
        internal static string AgentStatus(Account a) { return StatusOf(a); }
        // Gate 3's config cap for an agent's entry: the agents' shipped cap where one ships (0.5.3: MNQ 20, Anthony 2026-10-10;
        // config.txt's maxQty line for that root is never read for agents), else config.txt's cap as for the page (CapFor). The
        // page's, the bot's and the copier's caps stay CapFor. The agent's rule and the hard ceiling apply on top (CapFor(id, root)).
        internal static int AgentCap(string root) { int s = ChartBridgeAgents.ShippedConfigCap(root); return s > 0 ? s : CapFor(root); }
        // Gate 3's cap for an agent's entry and its words (0.5.3 review: the words name the cap that applied, never maxQty.MNQ):
        // the agent's maxQty (ChartBridgeAgents.CapFor, its words CapWords), or AgentCap when that is lower (config.txt's line
        // for a root with no shipped cap).
        internal static int AgentEntryCap(string agent, string root, out string why)
        {
            int own = ChartBridgeAgents.CapFor(agent, root), conf = AgentCap(root);
            if (conf < own) { why = "maxQty." + root + " in config.txt"; return conf; }
            why = ChartBridgeAgents.CapWords(agent, root, own);
            return own;
        }
        // 0.5.3 review: the position count's cap for a page exit from an agent's position (PlaceOrderLocked's pageReduces: at most
        // the smaller reading, never a flip or an add; it skips the per-order qty check): the agent's cap (AgentEntryCap), or the
        // position it holds (held) when that is larger, as after its rule was lowered. The page's exits still working never add up
        // past the position itself (PlaceOrderLocked, 0.5.3 re-review).
        internal static int AgentExitCap(string owner, string root, int held, out string why)
        {
            string w;
            int a = AgentEntryCap(owner, root, out w);
            why = "an exit from agent " + owner + "'s position: " + (a >= held ? w : "its " + held + " contracts");
            return Math.Max(a, held);
        }
        internal static int AgentMaxBracketTicks { get { return MaxBracketTicks; } }
        internal static int AgentMaxTicksAway { get { return MaxTicksAway; } }
        // The last trade on a root (any age, 0 when none) and whether it is no older than maxAgeMs (the market trading in fact).
        internal static bool AgentFreshLast(string root, double maxAgeMs, out double last) { return FreshLast(root, maxAgeMs, out last); }
        internal static bool AgentOrderTypes { get { return OrderTypesOn; } }
        // A market close or a cancel ChartBridge sends for an agent: counted in gate 3 at once; the flatten marks the brackets
        // there (a late entry fill still gets its legs, with an alarm) and notes the legs it cancels (not a lost stop).
        internal static void AgentSent(Order o) { lock (Sync) { IdFor(o); Ours.Add(o); } }
        internal static void AgentUnsent(Order o) { lock (Sync) Ours.Remove(o); }
        internal static void AgentFlattening(Account a, Instrument inst)
        {
            lock (Sync)
                foreach (Bracket br in BracketOfEntry.Values)
                    if (br.Account == a && SameInstrument(br.Instrument, inst)) br.AfterFlatten = true;
            NoteWeCancelSafe(() => WorkingLegs(a, inst), "flatten");
        }
        // The fill of an order on that account and contract that NinjaTrader shows but whose order event has not come yet (so a
        // position reading may lack it), or null: the flatten's close waits for it (0.4.3's rule for the copier's close).
        internal static string AgentUnnotedFill(Account a, Instrument i, double now) { return CopierUnnotedFill(a, i, now); }
        internal static void AgentAlarm(string text) { Alarm(text); }
        internal static void AgentWarn(string text) { Warn(text); }
    }

    // ---------------------------------------------------------------- the channel: the agents in config.txt
    public static class ChartBridgeAgents
    {
        // The hard ceiling (PROTOCOL.md "Agent channel", the rule set): a ChartBridge constant. Raising it is a code change and
        // a review. Minis 2, micros 20; a root with no ceiling here can never be an agent's root.
        public static int HardCeiling(string root)
        {
            switch ((root ?? "").ToUpperInvariant())
            {
                case "NQ": return 2;
                case "ES": return 2;
                case "MNQ": return 20;
                case "MES": return 20;
                default: return 0;
            }
        }

        // 0.5.3 (Anthony, 2026-10-10): the agents' MNQ cap of 20 ships with ChartBridge, so any PC can run an agent at its full
        // plan with nothing set by hand. For agent entries on MNQ it replaces config.txt's gate 3 cap: a maxQty.MNQ line caps the
        // page, the bot and the copier only. 0: nothing ships for the root (it takes config.txt's cap, as the page's).
        public static int ShippedConfigCap(string root) { return (root ?? "").ToUpperInvariant() == "MNQ" ? 20 : 0; }

        // At config load, with agents on and a maxQty.MNQ line: said once, so the line is not read as the agents' cap.
        public static void NoteConfigCaps()
        {
            if (Ids().Count == 0) return;
            int n;
            if (ChartBridgeOrders.MaxQty.TryGetValue("MNQ", out n))
                ChartBridgeServer.Log("config.txt: maxQty.MNQ = " + n + " caps the page's, the bot's and the copier's MNQ orders only; agents use their own MNQ cap of " +
                                      ShippedConfigCap("MNQ") + " (with the agent's rule and the hard ceiling)");
        }

        public const string SecretHeader = "X-ChartBridge-Agent";
        public const int MaxMessageBytes = 65536, MaxActionsPerSecond = 10;
        public const double SilenceMs = 5000, StripEveryMs = 1000, CheckEveryMs = 500;
        public const double FlatErrorEveryMs = 10000, FlatRetryMs = 3000, AcceptMinLeftMs = 5000;
        // Review A (second round): a cancel not confirmed after 10 tries is an error and is tried every 30 s from then; while the
        // market is shut the NOT FLAT error and the lost-trade error repeat every 60 s.
        public const int CancelSlowAfter = 10;
        public const double TradingFreshMs = 5000, AgainstGraceMs = 3000, CloseRetryHoldMs = 30000, GhostGraceMs = 5000;   // the market trading in fact: a trade in the last 5 s
        public const double CancelSlowMs = 30000, ShutErrorEveryMs = 60000, LostTradeEveryMs = 60000, CancelGiveUpMs = 30 * 60000;
        public const double LostHoldMaxMs = 30000;   // 0.5.7 review of #47: the longest a lost-trade error waits for ChartBridge's own flatten

        // The market is shut (no market order is sent): 17:00 to 18:00 New York time Monday to Thursday, and Friday 17:00 to Sunday
        // 18:00. Fixed times (lead's default: NinjaTrader's trading hours are not read; holidays are not known here: the flatten
        // also asks ChartBridgeCme.Closed, the 0.5.2 review).
        public static bool MarketShut(DateTime et)
        {
            double h = et.TimeOfDay.TotalHours;
            switch (et.DayOfWeek)
            {
                case DayOfWeek.Saturday: return true;
                case DayOfWeek.Sunday: return h < 18;
                case DayOfWeek.Friday: return h >= 17;
                default: return h >= 17 && h < 18;
            }
        }

        // Two instruments are the same contract (the same object, or the same full name).
        public static bool SameContract(Instrument x, Instrument y) { return x != null && y != null && (x == y || x.FullName == y.FullName); }
        public const int NotesKept = 200, PlansKept = 50, StopLimitMaxTicks = 20;
        private static readonly Regex IdRx = new Regex("^[a-z][a-z0-9]{0,11}$");

        // ---------------------------------------------------------- settings (config.txt "agents"; read at start)
        private static readonly List<string> ConfigIds = new List<string>();
        public static void ResetConfig() { lock (ConfigIds) ConfigIds.Clear(); }

        // Called by ChartBridgeConfig.Load for the keys it does not know itself. "agents = manrae" (a comma list); absent or empty:
        // the channel is off and /agent/... answers 404. An id is 1 to 12 characters, a-z and 0-9, starting with a letter; any
        // other is left out with one Output line (lead's default).
        public static bool ReadConfig(string key, string val)
        {
            if (key != "agents") return false;
            lock (ConfigIds)
            {
                ConfigIds.Clear();
                foreach (string raw in (val ?? "").Split(','))
                {
                    string id = raw.Trim();
                    if (id.Length == 0) continue;
                    if (!IdRx.IsMatch(id)) { ChartBridgeServer.Log("config.txt: agents: \"" + id + "\" is not an agent id (1 to 12 characters, a-z and 0-9, starting with a letter); it is left out"); continue; }
                    if (!ConfigIds.Contains(id)) ConfigIds.Add(id);
                }
            }
            return true;
        }

        public static List<string> Ids() { lock (ConfigIds) return ConfigIds.ToList(); }

        // ---------------------------------------------------------- the agents (one object per id)
        private static readonly object Reg = new object();
        private static ChartBridgeAgent[] agents = new ChartBridgeAgent[0];   // replaced whole, read without a lock (Volatile)
        private static Timer timer;
        private static int checking;

        public static bool Enabled { get { return Volatile.Read(ref agents).Length > 0; } }
        public static ChartBridgeAgent[] All() { return Volatile.Read(ref agents); }

        // 0.5.8: a group, rules or limits change: every agent its accountState again (when it changed).
        // 0.6.0: and a group's membership: each agent on a group reads its seats again (seatsRev up, welcome) first.
        public static void AccountStatesChanged() { foreach (ChartBridgeAgent a in All() ?? new ChartBridgeAgent[0]) { a.RefreshSeats(); a.SendAccountState(false); } }
        public static ChartBridgeAgent Get(string id)
        {
            foreach (ChartBridgeAgent a in All()) if (a.Id == id) return a;
            return null;
        }

        // Test hooks (the Mono harness): the clocks. Null in NinjaTrader.
        public static Func<double> ClockMs;
        public static Func<DateTime> ClockEt;
        internal static double Now() { Func<double> f = ClockMs; return f != null ? f() : ChartBridgeTime.NowUtcMs(); }
        internal static DateTime NowEt() { Func<DateTime> f = ClockEt; return f != null ? f() : ChartBridgeTime.NowEastern(); }

        public static void Start() { Start(true); }

        // withTimer false: the Mono harness runs Check itself, step by step.
        public static void Start(bool withTimer)
        {
            Stop();
            List<ChartBridgeAgent> list = new List<ChartBridgeAgent>();
            int n = 0;
            foreach (string id in Ids()) list.Add(new ChartBridgeAgent(id, -100 - (n++)));
            Volatile.Write(ref agents, list.ToArray());
            if (list.Count == 0) return;
            ResetFiles();
            RefreshFiles();
            lock (SdLock) { sdIoSince = double.NaN; sdIoAlarmed = false; }
            LoadStandDowns();   // 0.6.2: the group stand-downs, before any agent can enter
            foreach (ChartBridgeAgent a in list) a.Start();
            RecoverTags();
            if (withTimer) timer = new Timer(delegate { try { Check(); } catch (Exception ex) { ChartBridgeServer.Log("agent check error: " + ex.Message); } }, null, (int)CheckEveryMs, (int)CheckEveryMs);
        }

        public static void Stop()
        {
            Timer t = timer;
            timer = null;
            if (t != null) { try { t.Dispose(); } catch (Exception) { } }
            ChartBridgeAgent[] was = Volatile.Read(ref agents);
            Volatile.Write(ref agents, new ChartBridgeAgent[0]);
            foreach (ChartBridgeAgent a in was) a.Stop();
            lock (TagsLock) AgentTags.Clear();
        }

        // ---------------------------------------------------------- bot-account.txt and copier.txt, when those lanes are off
        // Read on the timer's thread (and a page's), never on NinjaTrader's event threads: the agents' clash rules read this copy. A file
        // read again only when its time stamp changes; one that cannot be read keeps the last good copy for one more pass, then
        // counts as a clash (ChartBridge cannot tell whose the account is). With no good copy yet (the first read at a start), a
        // failed read counts as a clash at once (review B).
        private static readonly object FilesLock = new object();
        private static DateTime botStamp = DateTime.MinValue, copierStamp = DateTime.MinValue;
        private static string botFileAccount;   // null: not read yet, or unreadable (a clash)
        private static List<string> copierLeader = new List<string>(), copierFollowers = new List<string>();
        private static int botFails, copierFails;
        private static bool botGood, copierGood, copierUnreadable = true;

        private static void ResetFiles()
        {
            lock (FilesLock)
            {
                botStamp = DateTime.MinValue; copierStamp = DateTime.MinValue; botFileAccount = null; botGood = false; copierGood = false;
                copierLeader = new List<string>(); copierFollowers = new List<string>(); botFails = 0; copierFails = 0; copierUnreadable = true;
            }
        }

        public static Func<string> CopierReadFault;   // test hook: a non-null answer fails a read of copier.txt (unused in NinjaTrader)

        internal static void RefreshFiles()
        {
            try
            {
                string bf = Path.Combine(ChartBridgeConfig.Folder, "bot-account.txt");
                DateTime bs = File.Exists(bf) ? File.GetLastWriteTimeUtc(bf) : DateTime.MinValue.AddTicks(1);
                bool readBot; lock (FilesLock) readBot = bs != botStamp || botFails > 0;
                if (readBot)
                {
                    string acct = ChartBridgeBot.ReadAccountFile();
                    lock (FilesLock)
                    {
                        if (acct != null) { botFileAccount = acct; botFails = 0; botGood = true; botStamp = bs; }
                        else if (++botFails >= 2 || !botGood) { botFileAccount = null; botStamp = bs; }
                    }
                }
            }
            catch (Exception) { lock (FilesLock) if (++botFails >= 2 || !botGood) botFileAccount = null; }
            string cf = Path.Combine(ChartBridgeConfig.Folder, "copier.txt");
            try
            {
                DateTime cs = File.Exists(cf) ? File.GetLastWriteTimeUtc(cf) : DateTime.MinValue.AddTicks(1);
                bool readCopier; lock (FilesLock) readCopier = cs != copierStamp || copierFails > 0;
                if (!readCopier) return;
                Func<string> fault = CopierReadFault;
                if (fault != null && fault() != null) throw new IOException(fault());
                List<string> leader = new List<string>(), followers = new List<string>();
                if (File.Exists(cf))
                    foreach (string raw in File.ReadAllLines(cf))
                    {
                        string[] p = raw.Split('\t');
                        if (p.Length == 2 && p[0] == "leader" && p[1].Length > 0) leader.Add(p[1]);
                        else if (p.Length == 6 && p[0] == "follower" && p[1].Length > 0) followers.Add(p[1]);
                    }
                lock (FilesLock) { copierLeader = leader; copierFollowers = followers; copierFails = 0; copierGood = true; copierUnreadable = false; copierStamp = cs; }
            }
            catch (Exception) { lock (FilesLock) if (++copierFails >= 2 || !copierGood) copierUnreadable = true; }
        }

        // The bot's account for the agents' clash rules (on: its memory; off: the copy of bot-account.txt); null: cannot be told.
        internal static string BotAccountForAgents() { if (ChartBridgeBot.Enabled) return ChartBridgeBot.BotAccount; lock (FilesLock) return botFileAccount; }

        // Why the copier uses this account, for the agents (on: its memory; off: the copy of copier.txt), or null.
        internal static string CopierUses(string name)
        {
            if (ChartBridgeCopier.Enabled) return ChartBridgeCopier.AgentAccountRefusal(name);
            lock (FilesLock)
            {
                if (copierUnreadable) return "copier.txt cannot be read, so ChartBridge cannot tell whether " + name + " is the copier's";
                if (copierLeader.Any(x => x.Equals(name, StringComparison.OrdinalIgnoreCase))) return name + " is the copier's leader";
                if (copierFollowers.Any(x => x.Equals(name, StringComparison.OrdinalIgnoreCase))) return name + " is a copier follower";
            }
            return null;
        }

        // Every 500 ms: each agent's heartbeat, expiries, window, flat time, day and strip. One pass at a time.
        public static void Check()
        {
            if (Interlocked.Exchange(ref checking, 1) == 1) return;
            try
            {
                RefreshFiles();
                double now = Now();
                try { RetryStandDowns(now); } catch (Exception ex) { ChartBridgeServer.Log("agent stand-downs retry error: " + ex.Message); }   // 0.6.3 (audit C4)
                if (now - lastTagScan >= 2000) { lastTagScan = now; RecoverTags(); }
                foreach (ChartBridgeAgent a in All())
                {
                    try { a.Check(now); } catch (Exception ex) { ChartBridgeServer.Log("agent " + a.Id + " check error: " + ex.Message); }
                }
            }
            finally { Interlocked.Exchange(ref checking, 0); }
        }
        private static double lastTagScan;

        // ---------------------------------------------------------- whose order is it (names; legs share their entry's tag)
        //   entry "CB#1a2b3c4d ag:manrae s8 t16" (limit or stop-limit, ticks from each fill), its legs "CB#1a2b3c4d stop f1 q1 p..."
        //   and "... target ...", the flat time's close "CB#1a2b3c4d ag:manrae flat" (a market order, never an entry).
        public static readonly Regex EntryRx = new Regex("^CB#([0-9a-f]{8}) ag:([a-z][a-z0-9]{0,11}) s([0-9]{1,9}) t([0-9]{1,9})$");
        private static readonly Regex AgentNameRx = new Regex("^CB#([0-9a-f]{8}) ag:([a-z][a-z0-9]{0,11})(?: |$)");
        private static readonly Regex TagRx = new Regex("^CB#([0-9a-f]{8}) ");
        private static readonly object TagsLock = new object();
        private static readonly Dictionary<string, string> AgentTags = new Dictionary<string, string>();   // entry tag -> agent id

        public static string TagOf(string name) { Match m = TagRx.Match(name ?? ""); return m.Success ? m.Groups[1].Value : null; }
        public static bool IsEntryName(string name) { return name != null && EntryRx.IsMatch(name); }
        public static bool IsAgentEntry(Order o) { return o != null && IsEntryName(o.Name); }
        internal static void NoteTag(string tag, string id) { if (tag != null && id != null) lock (TagsLock) AgentTags[tag] = id; }
        public static string AgentOfTag(string tag) { string id; if (tag == null || !Enabled) return null; lock (TagsLock) return AgentTags.TryGetValue(tag, out id) ? id : null; }
        // The plan id each entry tag was placed for (memory, and the day file's tagplan lines across a restart): an agent's order
        // messages to a v3 page carry it as "planId" (ChartBridgeAccounts.ForPage), so the page finds the plan of a trade exactly.
        private static readonly Dictionary<string, string> PlanTags = new Dictionary<string, string>();   // entry tag -> plan id
        internal static void NotePlan(string tag, string planId) { if (tag != null && !string.IsNullOrEmpty(planId)) lock (TagsLock) PlanTags[tag] = planId; }

        // ,"planId":"<id>" for an agent's entry, its legs and its flat close when ChartBridge knows the plan of its tag; "" otherwise.
        public static string PlanIdField(Order o)
        {
            if (o == null || !Enabled || AgentOf(o) == null) return "";
            string tag = TagOf(o.Name), id;
            if (tag == null) return "";
            lock (TagsLock) if (!PlanTags.TryGetValue(tag, out id)) return "";
            return ",\"planId\":" + CbJson.Str(id);
        }

        // The agent an order belongs to (its entry, a leg of it, its flat close), or null. Name and memory only (NinjaTrader's
        // threads call it): the tags are learned at placement, from every order update, and by a scan of the accounts every 2 s.
        public static string AgentOf(Order o)
        {
            if (o == null || !Enabled) return null;
            string name = o.Name ?? "";
            Match m = AgentNameRx.Match(name);
            if (m.Success) return m.Groups[2].Value;
            string tag = TagOf(name), id;
            if (tag == null) return null;
            lock (TagsLock) return AgentTags.TryGetValue(tag, out id) ? id : null;
        }

        // After a start (and every 2 s): the agent entries NinjaTrader lists, so their legs are known as the agent's.
        private static void RecoverTags()
        {
            if (!Enabled) return;
            List<Account> accounts;
            lock (Account.All) accounts = Account.All.ToList();
            foreach (Account a in accounts)
            {
                List<Order> orders;
                lock (a.Orders) orders = a.Orders.ToList();
                foreach (Order o in orders)
                {
                    Match m = AgentNameRx.Match(o.Name ?? "");
                    if (m.Success) NoteTag(m.Groups[1].Value, m.Groups[2].Value);
                }
            }
        }

        // ---------------------------------------------------------- the owner lock (PROTOCOL.md "Agent channel", section 6)
        // The agent that owns (account, root) now, or null. Built to the ruling's question only: whether an agent owns it.
        // 0.6.0: per (account, root) still: any seat of an agent (one it trades now, or one that left its group while it holds the
        // agent's trade).
        public static string OwnerAgent(string account, string root)
        {
            if (string.IsNullOrEmpty(account) || string.IsNullOrEmpty(root)) return null;
            foreach (ChartBridgeAgent a in All()) if (a.OwnsOn(account, root)) return a.Id;
            return null;
        }

        // Every new entry from every source asks here, under PlaceLock (PlaceOrderLocked) or the copier's lock (Eligible): null
        // when it may go on. source: "page", "bot", "copier" or "agent:<id>". Exits never come here.
        public static string EntryCheck(string source, Account account, string root)
        {
            if (!Enabled || account == null || string.IsNullOrEmpty(root)) return null;
            string owner = OwnerAgent(account.Name, root);
            if (source != null && source.StartsWith("agent:", StringComparison.Ordinal))
            {
                string id = source.Substring(6);
                ChartBridgeAgent ag = Get(id);
                if (ag == null) return "there is no agent " + id + " (agents in config.txt)";
                if (!ag.IsEntrySeat(account.Name)) return "agent " + id + " trades its own account " + ag.AccountWords() + " only";   // 0.6.0: a seat it trades now (never one that left its group)
                string conflict = ag.AccountConflict();
                if (conflict != null) return conflict;
                if (owner != null && owner != id) return account.Name + " " + root + " belongs to agent " + owner + " until it is flat";
                if (owner == id) return "agent " + id + " still holds " + account.Name + " " + root + ": one position and one entry at a time";
                if (ChartBridgeOrders.AgentHoldsOnRoot(account, root))
                    return account.Name + " " + root + " has a position or a working order that is not agent " + id + "'s: an agent enters only where nothing else is held or working (the owner lock)";
                return null;
            }
            if (owner != null) return account.Name + " " + root + " belongs to agent " + owner + (source == "page" ? ": use Flatten, or move its stop or target" : " until it is flat");
            return null;
        }

        // Defense in depth (review A-N4): PlaceOrderLocked asks the agent itself, under the order lock, just before the order is
        // made: not killed, not in shadow, inside its entry window, and a stop-limit's limit within 20 ticks on the right side.
        // 0.6.2: and, for this seat (account), no stand-down of its build on the seat's group, and a league seat's account Sim.
        public static string PlacingProblem(string id, string account, string kind, bool isBuy, double price, double limitPx, double tick)
        {
            ChartBridgeAgent a = Get(id);
            if (a == null) return "there is no agent " + id + " (agents in config.txt)";
            string why = a.PlacingProblem(account);   // 0.6.2: and, for this seat, a stand-down on its group and a league seat's Sim
            if (why != null) return why;
            if (kind == "stopLimit")
            {
                double lo = isBuy ? price : price - StopLimitMaxTicks * tick, hi = isBuy ? price + StopLimitMaxTicks * tick : price;
                if (limitPx < lo - 1e-9 || limitPx > hi + 1e-9) return "an agent's stop-limit has its limit within " + StopLimitMaxTicks + " ticks of its price, on the side that fills";
            }
            return null;
        }

        // The ceiling for an agent entry in PlaceOrderLocked (gate 3's own count): the agent's maxQty for the root, never above the
        // hard ceiling; 0 (nothing) for an unknown agent or a root it does not trade.
        public static int CapFor(string id, string root)
        {
            ChartBridgeAgent a = Get(id);
            return a == null ? 0 : Math.Min(HardCeiling(root), a.MaxQtyFor(root));
        }
        // 0.5.3 review: the words for the agent's cap that applied (rule: its maxQty for the root): its own rule (the Agent tab)
        // when below the hard ceiling, else the hard ceiling (a rule is never above it, RulesProblem; with no line it is the ceiling).
        public static string CapWords(string id, string root, int rule)
        {
            int ceil = HardCeiling(root);
            return rule < ceil ? "agent " + id + "'s maxQty for " + root : "the hard ceiling of " + ceil + " for " + root;
        }

        // The agent whose CHOSEN account (chosen on the page: agent-<id>-account.txt) this is, for the bot's and the copier's
        // refusals, or null. An agent on None (no file, or "-": 0.5.7) claims nothing against anyone (lead's default).
        // 0.6.0: every seat counts: each account of the group it trades, and a seat that left while it holds the agent's trade.
        public static string AgentOfAccount(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            foreach (ChartBridgeAgent a in All()) if (a.Claims(name)) return a.Id;
            return null;
        }

        public static string AccountTakenWhy(string name, string by)
        {
            string id = AgentOfAccount(name);
            if (id == null) return null;
            ChartBridgeAgent a = Get(id);
            string g = a != null ? a.GroupWordsFor(name) : null;
            return g != null ? name + " is a seat of agent " + id + " (" + g + "): " + by + " does not trade it (choose another account for agent " + id + " on the Agent tab first)"
                             : name + " is agent " + id + "'s account: " + by + " does not trade it (choose another account for agent " + id + " on the Agent tab first)";
        }

        // 0.6.0: an account joining a group that an agent trades (ChartBridgeGroups.AccountGroup): refused for the bot's account, the
        // copier's leader or a follower (on or off), and another agent's account. Null when it may join.
        public static string JoinRefusal(string name, string groupId) { return JoinRefusal(name, groupId, true); }
        // refresh false: memory only (the copies of bot-account.txt and copier.txt as they are, the copier's and the agents' memory),
        // for the check again under ChartBridgeGroups' save (PlaceLock, then its SaveLock: no file read under them).
        public static string JoinRefusal(string name, string groupId, bool refresh)
        {
            if (!Enabled || string.IsNullOrEmpty(name) || string.IsNullOrEmpty(groupId)) return null;
            List<ChartBridgeAgent> on = All().Where(a => a.OnGroup(groupId)).ToList();
            if (on.Count == 0) return null;
            if (refresh) RefreshFiles();   // a page's thread: the copies are read fresh
            string who = "agent " + on[0].Id, gname = ChartBridgeGroups.NameOf(groupId) ?? groupId;
            string bot = BotAccountForAgents();
            if (bot == null) return "bot-account.txt cannot be read or understood, so ChartBridge cannot tell the bot's account: " + name + " cannot join " + gname + ", which " + who + " trades, until it is fixed";
            if (string.Equals(name, bot, StringComparison.OrdinalIgnoreCase)) return name + " is the bot's account: it cannot join " + gname + ", which " + who + " trades (an agent never shares an account)";
            string cw = CopierUses(name);
            if (cw != null) return cw + ": it cannot join " + gname + ", which " + who + " trades (an agent never shares an account)";
            string other = AgentOfAccount(name);
            if (other != null && on.All(a => a.Id != other)) return name + " is agent " + other + "'s account: it cannot join " + gname + ", which " + who + " trades (each agent has its own accounts)";
            return null;
        }

        // ---------------------------------------------------------- 0.6.2: group stand-downs (agent-standdowns.txt; SPEC CE-2)
        // A hero (a build) stood down on a prop group: NO NEW ENTRIES from that build on any seat in that group until Anthony clears
        // it on the Agent tab's Board (agentStandDownClear). Raised by the agent (its runner's standDown {group, kind, why}); the agent
        // can never clear one. Only entries are gated: exits, Flatten, protect, the legs, flatAt and the stop placed again always go.
        // The file is written only by ChartBridge (two # lines, then standDown<TAB><build><TAB><group id><TAB><UTC ms><TAB><kind><TAB>
        // <why>), whole through a temp file. It survives restarts and the 18:00 roll (nothing rolls it); a deleted group's lines are
        // dropped (GroupDeleted, under the groups' save, before a later group could take the same id). A file that cannot be read is
        // never written over that run, and (Anthony 2026-10-16) agent entries on accounts in a prop group are refused until it can; accounts in
        // no group keep trading, exits pass; with groups.txt unreadable too, only Sim accounts take agent entries (BrokenRefusal).
        public sealed class GroupStandDown { public string Build, Group, Kind, Why; public double At; }
        public const string StandDownsFileName = "agent-standdowns.txt";
        private static readonly object SdLock = new object();       // the memory copy only (a leaf: nothing is called under it)
        private static readonly object SdFileLock = new object();   // one write of the file at a time (never under PlaceLock)
        private static List<GroupStandDown> sdList = new List<GroupStandDown>();
        private static string sdBroken;
        public static Func<string> StandDownWriteFault;   // test hook: a non-null answer fails a write of the file (unused in NinjaTrader)
        private static string SdPath { get { return Path.Combine(ChartBridgeConfig.Folder, StandDownsFileName); } }
        private static readonly Regex SdGroupRx = new Regex("^g[1-9][0-9]{0,8}$");

        // A plain string of 1 to max characters that reads back the same from the file: no tab or control character, no quote, no
        // backslash (the strict parser's plain strings already are), nothing a reader would trim.
        internal static bool SdText(string s, int max)
        {
            if (string.IsNullOrEmpty(s) || s.Length > max || s.Trim() != s) return false;
            foreach (char ch in s) if (ch < 0x20 || ch == 0x7f || ch == '"' || ch == '\\') return false;
            return true;
        }

        private static GroupStandDown ReadSdLine(string line)
        {
            string[] p = line.Split('\t');
            if (p.Length != 6 || p[0] != "standDown" || !SdText(p[1], 40) || !SdGroupRx.IsMatch(p[2]) || !Regex.IsMatch(p[3], "^[0-9]{1,15}$") || !SdText(p[4], 40) || !SdText(p[5], 200)) return null;
            return new GroupStandDown { Build = p[1], Group = p[2], At = double.Parse(p[3], CultureInfo.InvariantCulture), Kind = p[4], Why = p[5] };
        }

        private static string WriteStandDowns(List<GroupStandDown> list)
        {
            try
            {
                Func<string> fault = StandDownWriteFault;
                if (fault != null && fault() != null) throw new IOException(fault());
                List<string> lines = new List<string> { "# ChartBridge stand-downs (written only by ChartBridge; Anthony clears one on the Agent tab's Board; do not edit)",
                    "# standDown<TAB><build><TAB><group id><TAB><UTC ms><TAB><kind><TAB><why>: no new entries from that build on that group until it is cleared" };
                foreach (GroupStandDown s in list)
                    lines.Add("standDown\t" + s.Build + "\t" + s.Group + "\t" + s.At.ToString("0", CultureInfo.InvariantCulture) + "\t" + s.Kind + "\t" + s.Why);
                ChartBridgeAgent.WriteWhole(SdPath, lines);
                return null;
            }
            catch (Exception ex) { return ex.Message; }
        }

        // At start (Start): the file read once; a group that is gone has its lines dropped (groups.txt readable only: never guessed).
        internal static void LoadStandDowns()
        {
            List<GroupStandDown> list = new List<GroupStandDown>();
            string broken = null, io = null;
            Func<string[], string> parse = all =>
            {
                list = new List<GroupStandDown>();
                foreach (string raw in all)
                {
                    string line = raw.TrimEnd('\r');
                    if (line.Trim().Length == 0 || line.StartsWith("#", StringComparison.Ordinal)) continue;
                    GroupStandDown s = ReadSdLine(line);
                    if (s == null) return StandDownsFileName + " has a line ChartBridge does not understand";
                    if (list.Any(x => x.Build == s.Build && x.Group == s.Group)) return StandDownsFileName + " names build " + s.Build + " on group " + s.Group + " twice";
                    list.Add(s);
                }
                return null;
            };
            try
            {
                if (File.Exists(SdPath)) broken = ChartBridgeAgent.ParseOrBackup(SdPath, StandDownsFileName, parse);
            }
            catch (IOException ex) { io = StandDownsFileName + " could not be read yet (" + ex.Message + "): every new agent entry on an account in a prop group is refused until it is read (accounts in no group keep trading; exits always work; ChartBridge tries again)"; }
            catch (Exception ex) { broken = StandDownsFileName + " could not be read (" + ex.Message + ")"; }
            if (io != null)
            {
                // 0.6.3 (audit C4): not read yet: refused as unreadable meanwhile (raises kept in memory), read again on the 500 ms
                // check, the alarm after IoRetryMs
                bool first;
                lock (SdLock)
                {
                    first = double.IsNaN(sdIoSince);
                    if (first) { sdIoSince = Now(); sdList = new List<GroupStandDown>(); sdRepeatSaid.Clear(); sdCapAlarmed.Clear(); }
                    sdBroken = io;
                }
                if (first) { ChartBridgeServer.Log(io); try { ChartBridgeV3.SendToV3Traders(StandDownsMessage()); } catch (Exception) { } }
                return;
            }
            if (broken != null)
            {
                broken += ": every new agent entry on an account in a prop group is refused until it can be read (accounts in no group keep trading; exits always work); fix or delete the file, then recompile";
                lock (SdLock) { sdList = new List<GroupStandDown>(); sdBroken = broken; sdRepeatSaid.Clear(); sdCapAlarmed.Clear(); sdIoSince = double.NaN; }
                ChartBridgeOrders.AgentAlarm(broken);   // logged and to every signed-in page; a page that signs in later gets agentStandDowns.error
                try { ChartBridgeV3.SendToV3Traders(StandDownsMessage()); } catch (Exception) { }
                return;
            }
            // 0.6.3 (audit C4): read after a wait: a stand-down raised meanwhile (memory only) is kept and saved
            List<GroupStandDown> raised;
            bool waited;
            lock (SdLock) { waited = !double.IsNaN(sdIoSince); raised = waited ? sdList.Where(m => !list.Any(x => x.Build == m.Build && x.Group == m.Group)).ToList() : new List<GroupStandDown>(); sdIoSince = double.NaN; sdIoAlarmed = false; }
            list.AddRange(raised);
            if (raised.Count > 0) lock (SdFileLock) { string err = WriteStandDowns(list); if (err != null) ChartBridgeServer.Log(StandDownsFileName + " could not be saved (" + err + ")"); }
            if (waited) ChartBridgeServer.Log(StandDownsFileName + " could be read now");
            // fix round 1: only when groups.txt exists and was read (a missing groups.txt keeps every line, and the file is not rewritten)
            bool groupsRead = File.Exists(Path.Combine(ChartBridgeConfig.Folder, "groups.txt")) && !ChartBridgeGroups.Unreadable();
            List<GroupStandDown> gone = !groupsRead ? new List<GroupStandDown>() : list.Where(x => ChartBridgeGroups.NameOf(x.Group) == null).ToList();
            foreach (GroupStandDown s in gone) list.Remove(s);
            lock (SdLock) { sdList = list; sdBroken = null; sdRepeatSaid.Clear(); sdCapAlarmed.Clear(); }
            if (gone.Count > 0)
            {
                lock (SdFileLock) { string err = WriteStandDowns(list); if (err != null) ChartBridgeServer.Log(StandDownsFileName + " could not be saved (" + err + ")"); }
                foreach (GroupStandDown s in gone) ChartBridgeServer.Log("agent stand-down of build " + s.Build + " on group " + s.Group + " dropped: the group is gone");
            }
            if (list.Count > 0) ChartBridgeServer.Log(StandDownsFileName + ": " + list.Count + " stand-down" + (list.Count == 1 ? "" : "s") + " in force (" + string.Join("; ", list.Select(x => "build " + x.Build + " on group " + x.Group)) + ")");
            try { ChartBridgeV3.SendToV3Traders(StandDownsMessage()); } catch (Exception) { }   // pages signed in already (a page that signs in later gets it in AfterAuth)
        }

        private static double sdIoSince = double.NaN, sdIoLastTry;
        private static bool sdIoAlarmed;
        // 0.6.3 (audit C4): the 500 ms check reads a file that could not be opened again (every 5 s after IoRetryMs, with the alarm).
        private static void RetryStandDowns(double now)
        {
            double since;
            lock (SdLock) since = sdIoSince;
            if (double.IsNaN(since)) return;
            bool alarmed;
            lock (SdLock) alarmed = sdIoAlarmed;
            if (alarmed && now - sdIoLastTry < 5000) return;
            sdIoLastTry = now;
            LoadStandDowns();
            string alarm = null;
            lock (SdLock) if (!double.IsNaN(sdIoSince) && now - sdIoSince >= ChartBridgeAgent.IoRetryMs && !sdIoAlarmed) { sdIoAlarmed = true; alarm = sdBroken; }
            if (alarm != null) ChartBridgeOrders.AgentAlarm(alarm.Replace(" could not be read yet (", " could not be read for a minute (").Replace("ChartBridge tries again)", "ChartBridge keeps trying)"));
        }

        // The file could not be read at start, or null.
        public static string StandDownsBroken() { lock (SdLock) return sdBroken; }

        // Anthony 2026-10-16: while agent-standdowns.txt cannot be read, an agent entry is refused only on an account in a prop group (any
        // group in groups.txt): an account in no group (a Sim league seat, a personal account) keeps trading, exits always go. With
        // groups.txt unreadable too (membership unknown), every account that is not Sim is refused (the careful side for prop accounts)
        // and a Sim account is allowed. acct: the account the entry goes to. Null when it may go on.
        public static string BrokenRefusal(string acct)
        {
            string broken = StandDownsBroken();
            if (broken == null || string.IsNullOrEmpty(acct) || ChartBridgeBranches.IsNone(acct)) return null;
            if (ChartBridgeGroups.Unreadable())
            {
                Account a = null;
                lock (Account.All) foreach (Account x in Account.All) if (x.Name == acct) { a = x; break; }
                return a != null && ChartBridgeBot.IsSim(a) ? null : broken + "; groups.txt cannot be read either, so " + acct + " (not Sim) is refused: only Sim accounts take agent entries until both files read";
            }
            return ChartBridgeGroups.GroupOf(acct) != null ? broken + " (" + acct + " is in group " + (ChartBridgeGroups.NameOf(ChartBridgeGroups.GroupOf(acct)) ?? ChartBridgeGroups.GroupOf(acct)) + ")" : null;
        }

        // Why an agent entry of `build` on group `gid` (null: no group) is refused by a stand-down, or null. Words name the build, the
        // group, the kind and the why. (The unreadable file is BrokenRefusal's, per account.)
        public static string StandDownRefusal(string build, string gid)
        {
            GroupStandDown hit = null;
            lock (SdLock) { if (build != null && gid != null) hit = sdList.FirstOrDefault(x => x.Build == build && x.Group == gid); }
            if (hit == null) return null;
            return "build " + build + " stands down on group " + (ChartBridgeGroups.NameOf(gid) ?? gid) + " (" + hit.Kind + ": " + hit.Why + "): no new entries from it on that group until Anthony clears it on the Agent tab's Board (exits always work)";
        }

        // The stand-downs of one build, or every one (build null), as copies.
        public static List<GroupStandDown> StandDownsOf(string build)
        {
            lock (SdLock) return sdList.Where(x => build == null || x.Build == build).Select(x => new GroupStandDown { Build = x.Build, Group = x.Group, Kind = x.Kind, Why = x.Why, At = x.At }).ToList();
        }

        // agent.standDowns and agentState.groupStandDown: {group, why, kind, at}.
        internal static string StandDownJson(GroupStandDown s)
        {
            return "{\"group\":" + CbJson.Str(s.Group) + ",\"why\":" + CbJson.Str(s.Why) + ",\"kind\":" + CbJson.Str(s.Kind) + ",\"at\":" + s.At.ToString("0", CultureInfo.InvariantCulture) + "}";
        }

        // The pages' agentStandDowns: every stand-down in force (so a hero not connected is seen too), each with its build and its
        // group's name; error: why the file cannot be read (then every agent entry is refused), or null.
        public static string StandDownsMessage()
        {
            List<GroupStandDown> all = StandDownsOf(null);
            string broken = StandDownsBroken();
            return "{\"type\":\"agentStandDowns\",\"list\":[" + string.Join(",", all.Select(s => "{\"build\":" + CbJson.Str(s.Build) + ",\"group\":" + CbJson.Str(s.Group) + ",\"name\":" +
                   (ChartBridgeGroups.NameOf(s.Group) != null ? CbJson.Str(ChartBridgeGroups.NameOf(s.Group)) : "null") + ",\"why\":" + CbJson.Str(s.Why) + ",\"kind\":" + CbJson.Str(s.Kind) +
                   ",\"at\":" + s.At.ToString("0", CultureInfo.InvariantCulture) + "}").ToArray()) + "],\"error\":" + (broken != null ? CbJson.Str(broken) : "null") + "}";
        }

        // The agent's standDown (raise only). Null when it holds (fresh false: it was in force already, kept as first raised).
        // In memory first (the gate holds at once, even if the file cannot be written), then the file.
        // Fix round 1: at most MaxStandDowns in force for a group id ChartBridge does not know (only possible while groups.txt cannot be
        // read); a raise for a group in groups.txt is always taken (fix round 2: the cap never refuses a real stand-down). A refused one
        // is logged and alarmed once per build and group, the alarm sent after both stand-down locks are let go. sayAgain: a repeat
        // raise of one in force, true only the first time for that build and group (logged once).
        public const int MaxStandDowns = 200;
        private static readonly HashSet<string> sdRepeatSaid = new HashSet<string>();   // under SdLock: build<TAB>group said again once
        private static readonly HashSet<string> sdCapAlarmed = new HashSet<string>();   // under SdLock: build<TAB>group refused by the cap, alarmed once
        internal static string RaiseStandDown(string agentId, string build, string gid, string kind, string why, out bool fresh, out bool sayAgain)
        {
            fresh = false; sayAgain = false;
            string err = null, full = null, alarm = null;
            bool write = false;
            bool known = !ChartBridgeGroups.Unreadable() && ChartBridgeGroups.NameOf(gid) != null;   // read before the locks (the groups' own lock)
            lock (SdFileLock)
            {
                List<GroupStandDown> snap;
                lock (SdLock)
                {
                    if (sdList.Any(x => x.Build == build && x.Group == gid)) { sayAgain = sdRepeatSaid.Add(build + "\t" + gid); return null; }
                    if (!known && sdList.Count >= MaxStandDowns)
                    {
                        full = "the stand-down of build " + build + " on group " + gid + " (a group ChartBridge cannot find: groups.txt cannot be read) was refused: " + MaxStandDowns +
                               " stand-downs are in force already (" + StandDownsFileName + "); clear some on the Agent tab's Board";
                        if (sdCapAlarmed.Add(build + "\t" + gid)) alarm = "agent " + agentId + ": " + full;
                    }
                    if (full == null)
                    {
                        List<GroupStandDown> next = sdList.ToList();
                        next.Add(new GroupStandDown { Build = build, Group = gid, Kind = kind, Why = why, At = Math.Floor(Now()) });
                        sdList = next; fresh = true; write = sdBroken == null; snap = next.ToList();
                    }
                    else snap = null;
                }
                if (write) err = WriteStandDowns(snap);
            }
            if (full != null)
            {
                if (alarm != null) ChartBridgeOrders.AgentAlarm(alarm);   // both stand-down locks let go
                else ChartBridgeServer.Log("agent " + agentId + ": " + full);
                return full;
            }
            if (!write) ChartBridgeServer.Log("agent " + agentId + ": the stand-down of build " + build + " on group " + gid + " holds in memory only: " + StandDownsFileName + " could not be read at start, so it is not written");
            if (err != null) ChartBridgeOrders.AgentAlarm("agent " + agentId + ": " + StandDownsFileName + " could not be saved (" + err + "): the stand-down of build " + build + " on group " + gid + " holds until ChartBridge restarts, then it is lost: stand the hero down again or keep it Off");
            return null;
        }

        // Anthony's clear (the page). Refused when there is none, or the file cannot be read or written (the stand-down then stays).
        internal static string ClearStandDown(string build, string gid, out GroupStandDown was)
        {
            was = null;
            lock (SdFileLock)
            {
                List<GroupStandDown> next;
                lock (SdLock)
                {
                    if (sdBroken != null) return sdBroken + "; nothing was cleared";
                    was = sdList.FirstOrDefault(x => x.Build == build && x.Group == gid);
                    if (was == null) return "no stand-down of build " + build + " on group " + gid;
                    GroupStandDown w = was;
                    next = sdList.Where(x => x != w).ToList();
                }
                string err = WriteStandDowns(next);
                if (err != null) return StandDownsFileName + " could not be saved (" + err + "): the stand-down stays";
                GroupStandDown gone = was;
                lock (SdLock) { sdList = sdList.Where(x => x != gone).ToList(); sdRepeatSaid.Remove(gone.Build + "\t" + gone.Group); }
            }
            return null;
        }

        // 0.6.2: a group deleted (ChartBridgeGroups.GroupDelete, under its save): its stand-downs go with it, in memory at once and in
        // the file, so a group made later with the same id never inherits one.
        public static void GroupDeleted(string gid)
        {
            List<GroupStandDown> gone;
            lock (SdFileLock)
            {
                List<GroupStandDown> next;
                bool write;
                lock (SdLock)
                {
                    gone = sdList.Where(x => x.Group == gid).ToList();
                    if (gone.Count == 0) return;
                    next = sdList.Where(x => x.Group != gid).ToList();
                    sdList = next; write = sdBroken == null;
                    sdRepeatSaid.RemoveWhere(k => k.EndsWith("\t" + gid, StringComparison.Ordinal));
                }
                string err = write ? WriteStandDowns(next) : null;
                if (err != null) ChartBridgeServer.Log(StandDownsFileName + " could not be saved (" + err + ") after group " + gid + " was deleted");
            }
            foreach (GroupStandDown s in gone) ChartBridgeServer.Log("agent stand-down of build " + s.Build + " on group " + gid + " dropped: the group was deleted");
            try { ChartBridgeV3.SendToV3Traders(StandDownsMessage()); } catch (Exception) { }
        }

        // A stand-down raised or cleared: every agent sweeps (its entries on that group cancelled, its proposals expired) and is told.
        internal static void StandDownsChanged()
        {
            ChartBridgeV3.SendToV3Traders(StandDownsMessage());
            foreach (ChartBridgeAgent a in All()) a.AfterStandDownChange();
        }

        // agentStandDownClear {cid, build, group}: signed-in v3 pages only (OnPageMessage's gates), counted in gate 7.
        private static string PageClear(Dictionary<string, ChartBridgeAgent.Val> d)
        {
            string build = ChartBridgeAgent.S(d, "build"), gid = ChartBridgeAgent.S(d, "group");
            if (!SdText(build, 40)) return "build must be the build's name (1 to 40 characters)";
            if (gid == null || !SdGroupRx.IsMatch(gid)) return "group must be a group id (a plain string such as g1)";
            GroupStandDown was;
            string why = ClearStandDown(build, gid, out was);
            if (why != null) return why;
            string text = "stand-down of build " + build + " on group " + (ChartBridgeGroups.NameOf(gid) ?? gid) + " (" + gid + ") cleared on the page (it was " + was.Kind + ": " + was.Why + "); new entries from it may go there again";
            ChartBridgeServer.Log("agent " + text);
            foreach (ChartBridgeAgent a in All()) a.NoteCleared(build, text);
            ChartBridgeV3.SendToV3Traders("{\"type\":\"status\",\"level\":\"info\",\"text\":" + CbJson.Str("Agent " + text) + "}");
            StandDownsChanged();
            return null;
        }

        // ---------------------------------------------------------- the /agent/<id> WebSocket (ChartBridgeServer.Handle)
        // The answer to an upgrade before it happens: 404 while the channel is off or the id is not in agents, 403 for any Origin
        // header (any browser page) and for a wrong or missing secret, 400 for a request that is not a WebSocket upgrade, 409
        // while that id is connected; 101 when it may go ahead. The address check (loopback only) has already run.
        public static int UpgradeCheck(string id, string origin, string givenSecret, bool isWebSocket)
        {
            ChartBridgeAgent a = Get(id);
            if (a == null) return 404;
            if (origin != null) return 403;
            if (!a.SecretMatches(givenSecret)) return 403;
            if (!isWebSocket) return 400;
            if (a.Busy()) return 409;
            return 101;
        }

        public static async Task Serve(HttpListenerContext ctx, string path, CancellationToken token)
        {
            string id = path.StartsWith("/agent/", StringComparison.Ordinal) ? path.Substring(7) : "";
            int code = UpgradeCheck(id, ctx.Request.Headers["Origin"], ctx.Request.Headers[SecretHeader], ctx.Request.IsWebSocketRequest);
            ChartBridgeAgent a = Get(id);
            if (code == 101 && !a.Claim()) code = 409;   // the slot, taken before the upgrade
            if (code != 101) { Answer(ctx, code); return; }
            WebSocket ws;
            try { HttpListenerWebSocketContext wsc = await ctx.AcceptWebSocketAsync(null); ws = wsc.WebSocket; }
            catch (Exception) { a.Unclaim(); throw; }
            await a.Run(ws, token);
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

        // ---------------------------------------------------------- hooks from the rest of ChartBridge
        // Every live trade on every served root (the tick path, outside the book's lock): to every agent that said hello, except
        // the root it subscribed to (that one reaches it through the seam, as a page's, ChartBridgeServer's tick loop).
        public static void OnTick(string root, string json)
        {
            ChartBridgeAgent[] list = Volatile.Read(ref agents);
            for (int i = 0; i < list.Length; i++) list[i].OnTick(root, json);
        }

        // Agent connections that subscribed to a root (the tick path's seam and the gate's "a chart is loading").
        private static readonly List<ChartBridgeClient> NoClients = new List<ChartBridgeClient>();
        public static List<ChartBridgeClient> Subscribed()
        {
            ChartBridgeAgent[] all = Volatile.Read(ref agents);
            if (all.Length == 0) return NoClients;   // no agents: nothing made on the tick path
            List<ChartBridgeClient> list = new List<ChartBridgeClient>();
            for (int i = 0; i < all.Length; i++) { ChartBridgeClient c = all[i].SubscribedClient(); if (c != null) list.Add(c); }
            return list;
        }

        public static void OnOrderUpdate(Account account, Order o, string json)
        {
            if (!Enabled || o == null) return;
            string id = AgentOf(o);
            if (id == null) return;
            ChartBridgeAgent a = Get(id);
            if (a != null) a.OnOrderUpdate(o, json);
        }

        // 0.6.0: to the agent of that seat (its ledger is the seat's own).
        public static void OnExec(string account, Instrument inst, MarketPosition side, int qty, double price, string orderId, string json)
        {
            if (!Enabled) return;
            foreach (ChartBridgeAgent a in All()) if (a.HasSeat(account)) a.OnExec(account, inst, side, qty, price, orderId, json);
        }

        public static void OnPosition(Account account, PositionEventArgs e)
        {
            if (!Enabled || account == null || e == null || e.Position == null) return;
            foreach (ChartBridgeAgent a in All()) if (a.HasSeat(account.Name)) { a.OnPosition(account.Name, e); a.StateChanged(e.Position.Instrument); }
        }

        // Every order update on any account (ChartBridgeOrders.OnOrderUpdate): an agent on that account and root sends agentState
        // again when a field changed, owns included (contract section 10: a leg cancelled after a close turns owns false at once).
        public static void OnAccountChange(Account account, Instrument inst) { OnAccountChange(account, inst, null); }

        public static void OnAccountChange(Account account, Instrument inst, Order o)
        {
            if (!Enabled || account == null) return;
            foreach (ChartBridgeAgent a in All()) if (a.HasSeat(account.Name)) { a.NoteOrderId(o); a.StateChanged(inst); }
        }

        // ChartBridgeOrders.Auth and the v3 handshake: a signed-in v3 page gets every agent's strip, its open proposals, its last
        // 200 notes and its last 50 plans.
        public static void AfterAuth(ChartBridgeClient client)
        {
            if (!Enabled || client == null || !client.Trader || !ChartBridgeV3.IsV3(client)) return;
            foreach (ChartBridgeAgent a in All()) a.Replay(client);
            client.Send(StandDownsMessage());   // 0.6.2: every stand-down in force (a hero not connected too)
        }

        // ---------------------------------------------------------- messages from the page
        private static readonly Dictionary<string, string[]> PageKeys = new Dictionary<string, string[]>
        {
            { "agentMode", new[] { "type", "cid", "agent", "mode" } },
            { "agentKill", new[] { "type", "cid", "agent", "on" } },
            { "agentSeen", new[] { "type", "agent", "id", "at" } },
            { "agentAnswer", new[] { "type", "cid", "agent", "id", "answer", "at" } },
            { "agentAccount", new[] { "type", "cid", "agent", "account", "group", "keepMode", "league" } },   // 0.5.2: keepMode, the mode the page's question named; 0.6.0: group (a group id) in place of account
            { "agentRules", new[] { "type", "cid", "agent", "roots", "maxQtyNQ", "maxQtyMNQ", "maxQtyES", "maxQtyMES", "entryFrom", "entryUntil", "flatAt", "maxExpireSec", "maxTrades", "maxLosses" } },
            { "agentStandDownClear", new[] { "type", "cid", "build", "group" } },   // 0.6.2: Anthony's Clear stand-down (the Board); no agent key: a stand-down is the build's on the group
        };

        public static void OnPageMessage(ChartBridgeClient client, string type, string text)
        {
            string why;
            Dictionary<string, ChartBridgeAgent.Val> d = ChartBridgeAgent.Parse(text, 200, out why);
            string cid = d != null ? ChartBridgeAgent.S(d, "cid") : null, id = d != null ? ChartBridgeAgent.S(d, "id") : null;
            try
            {
                if (!Enabled) { PageReject(client, cid, id, "The agent channel is off (no agents in config.txt)."); return; }
                if (!ChartBridgeOrders.Enabled) { PageReject(client, cid, id, "trading is off in config.txt"); return; }
                if (!client.Trader || !ChartBridgeOrders.OriginAllowed(client.Origin)) { PageReject(client, cid, id, "this connection may not trade; reload ChartBridge's page"); return; }
                if (!ChartBridgeV3.IsV3(client)) { PageReject(client, cid, id, "agent messages are protocol v3: send {\"type\":\"client\",\"v\":3} first"); return; }
                if (d == null) { PageReject(client, cid, id, why); return; }
                string[] keys;
                if (!PageKeys.TryGetValue(type, out keys)) { PageReject(client, cid, id, "unknown message type " + type); return; }
                string odd = ChartBridgeAgent.UnknownKey(d, keys);
                if (odd != null) { PageReject(client, cid, id, "unknown key \"" + odd + "\" in " + type); return; }
                if (d.ContainsKey("cid") && cid == null) { PageReject(client, cid, id, "cid must be a plain string"); return; }
                if (!RateOk(client.Actions)) { PageReject(client, cid, id, "too many order actions (more than " + MaxActionsPerSecond + " a second)"); return; }
                if (type == "agentStandDownClear") { why = PageClear(d); if (why != null) PageReject(client, cid, id, why); return; }   // 0.6.2
                ChartBridgeAgent a = Get(ChartBridgeAgent.S(d, "agent") ?? "");
                if (a == null) { PageReject(client, cid, id, "there is no agent " + (ChartBridgeAgent.S(d, "agent") ?? "(none)") + " (agents in config.txt)"); return; }
                why = a.OnPage(type, d);
                if (why != null) PageReject(client, cid, id, why);
            }
            catch (Exception ex)
            {
                ChartBridgeServer.Log("agent page message error: " + ex.Message);
                PageReject(client, cid, id, "ChartBridge error: " + ex.Message);
            }
        }

        // Gate 7: at most 10 actions a second (an agent's own queue, or a page's).
        internal static bool RateOk(Queue<double> q)
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

        private static void PageReject(ChartBridgeClient client, string cid, string id, string reason)
        {
            client.Send("{\"type\":\"reject\"" + (cid != null ? ",\"cid\":" + CbJson.Str(cid) : "") + (id != null ? ",\"id\":" + CbJson.Str(id) : "") + ",\"reason\":" + CbJson.Str(reason) + "}");
        }

        // /diag "agents" (only with the channel on): per id, counts and state. Never a secret: only whether its file reads.
        public static string DiagJson()
        {
            StringBuilder b = new StringBuilder("{");
            bool first = true;
            foreach (ChartBridgeAgent a in All()) { if (!first) b.Append(','); first = false; b.Append(CbJson.Str(a.Id)).Append(':').Append(a.DiagJson()); }
            return b.Append('}').ToString();
        }
    }

    // ---------------------------------------------------------------- one agent
    public sealed class ChartBridgeAgent
    {
        public readonly string Id;
        private readonly int clientId;
        private readonly object Sync = new object();       // this agent's state; never held during a NinjaTrader or order call
        private readonly object PlaceGate = new object();  // one check-and-place of this agent at a time

        public ChartBridgeAgent(string id, int clientId) { Id = id; this.clientId = clientId; }

        // ---------------------------------------------------------- the rule set (section 3)
        public class Rules
        {
            public List<string> Roots = new List<string> { "NQ", "MNQ" };
            public Dictionary<string, int> MaxQty = new Dictionary<string, int> { { "NQ", 2 }, { "MNQ", 20 } };
            public int EntryFrom = 9 * 60 + 45, EntryUntil = 15 * 60, FlatAt = 15 * 60 + 55;   // New York minutes of the day (0.5.2: in session order, Sm)
            public int MaxExpireSec = 1800, MaxTrades, MaxLosses;                             // 0: none
            public Rules Copy()
            {
                return new Rules { Roots = Roots.ToList(), MaxQty = new Dictionary<string, int>(MaxQty), EntryFrom = EntryFrom, EntryUntil = EntryUntil, FlatAt = FlatAt,
                                   MaxExpireSec = MaxExpireSec, MaxTrades = MaxTrades, MaxLosses = MaxLosses };
            }
            // A root's maxQty: its line, else the hard ceiling (NQ 2 and MNQ 20 are the contract's defaults; ES 2, MES 20).
            public int QtyFor(string root) { int n; return MaxQty.TryGetValue(root ?? "", out n) ? n : DefaultQty(root); }
        }
        public static int DefaultQty(string root) { return ChartBridgeAgents.HardCeiling(root); }   // NQ 2, MNQ 20 (the contract's defaults), ES 2, MES 20

        public static string Hm(int minutes) { return (minutes / 60).ToString("00", CultureInfo.InvariantCulture) + ":" + (minutes % 60).ToString("00", CultureInfo.InvariantCulture); }
        public static int ParseHm(string s)
        {
            Match m = Regex.Match(s ?? "", "^([0-9]{2}):([0-9]{2})$");
            if (!m.Success) return -1;
            int h = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture), mi = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
            return h > 23 || mi > 59 ? -1 : h * 60 + mi;
        }

        // 0.5.2 (Anthony's rulings, 2026-10-08): the window is in session time, minutes since the 18:00 New York open, so 18:00 is
        // 0, 23:59 is 359, midnight is 360 and 17:00 (the break) is 1380. A window may start at 18:00 and run past midnight.
        public const int SessionOpenMin = 18 * 60, LastFlatMin = 15 * 60 + 59;
        public static int Sm(int minuteOfDay) { return ((minuteOfDay - SessionOpenMin) % 1440 + 1440) % 1440; }
        // Seconds since the session's 18:00 open for a New York wall time (0 to 86399).
        public static double SessionSec(DateTime et) { double s = et.TimeOfDay.TotalSeconds - SessionOpenMin * 60; return s < 0 ? s + 86400 : s; }
        // Inside the entry window: the market open (not the 17:00 to 18:00 break, Friday 17:00 to Sunday 18:00, a CME holiday, or
        // after the halt on an NYSE holiday or early close: ChartBridgeCme.Closed) and from entryFrom up to entryUntil in session order.
        public static bool InWindow(Rules r, DateTime et)
        {
            if (ChartBridgeCme.Closed(et)) return false;
            double s = SessionSec(et);
            return s >= Sm(r.EntryFrom) * 60 && s < Sm(r.EntryUntil) * 60;
        }
        // The flat hours: from flatAt until the next entryFrom in session order, and whenever the market is closed (the break, the
        // weekend, a holiday or a halt); a position held across midnight inside the window is never flattened.
        public static bool FlatHours(Rules r, DateTime et)
        {
            if (ChartBridgeCme.Closed(et)) return true;
            double s = SessionSec(et);
            return s >= Sm(r.FlatAt) * 60 || s < Sm(r.EntryFrom) * 60;
        }
        // From flatAt up to the session's end (18:00): the flat time itself (else the agent held a position outside its hours).
        public static bool AtFlatTime(Rules r, DateTime et) { return SessionSec(et) >= Sm(r.FlatAt) * 60; }
        public static string WindowText(Rules r) { return Hm(r.EntryFrom) + " to " + Hm(r.EntryUntil) + " New York time"; }

        // Why a rule set is not allowed, or null (the page's agentRules and the rules file share it). 0.5.2: in session order,
        // entryFrom before entryUntil before flatAt, flatAt at the latest 15:59 (the 17:00 to 18:00 break and 16:00 to 17:00 stay
        // out); both 09:45 to 15:00 flat 15:55 and 18:00 to 15:25 flat 15:55 are allowed.
        public static string RulesProblem(Rules r)
        {
            if (r.Roots.Count == 0) return "roots must name at least one root";
            foreach (string root in r.Roots)
            {
                if (ChartBridgeAgents.HardCeiling(root) == 0) return root + " is not a root an agent may trade (NQ, MNQ, ES, MES)";
                int q = r.QtyFor(root);
                if (q < 1 || q > ChartBridgeAgents.HardCeiling(root)) return "maxQty for " + root + " must be from 1 to " + ChartBridgeAgents.HardCeiling(root) + " (the hard ceiling)";
            }
            if (r.Roots.Distinct().Count() != r.Roots.Count) return "roots names a root twice";
            if (Sm(r.FlatAt) > Sm(LastFlatMin)) return "flatAt must be 15:59 at the latest (the session runs from 18:00 to 17:00 New York time)";
            if (Sm(r.EntryFrom) >= Sm(r.EntryUntil)) return "entryFrom must be before entryUntil in the session, which runs from 18:00 to 17:00 New York time (" + Hm(r.EntryFrom) + " to " + Hm(r.EntryUntil) + " goes the wrong way round)";
            if (Sm(r.FlatAt) <= Sm(r.EntryUntil)) return "flatAt must be after entryUntil in the session, which runs from 18:00 to 17:00 New York time";
            if (r.MaxExpireSec < 60 || r.MaxExpireSec > 1800) return "maxExpireSec must be from 60 to 1800";
            if (r.MaxTrades < 0 || r.MaxTrades > 50) return "maxTrades must be none or 1 to 50";
            if (r.MaxLosses < 0 || r.MaxLosses > 20) return "maxLosses must be none or 1 to 20";
            return null;
        }

        // ---------------------------------------------------------- plans and proposals
        private class Plan
        {
            public string Id, Action, Root, Side, Kind, PriceText, LimitText, RiskText, ConfText, Setup, Reason, Result;
            public int Qty, StopTicks, TargetTicks, ExpireSec;
            public bool HasQty, HasStop, HasTarget, HasExpire;
            public double Price, Limit, Risk, Conf, At, ExpiresAt;
            // 0.6.0 (a group): sizes in seat order (0: that seat sits it out, the runner's call), the seatsRev it was sized for; and,
            // from the checks, the seats it was checked on, why each that cannot take it sits out, and each seat's result
            public string SizesText;
            public int[] Sizes;
            public bool BadSizes, HasSeatsRev, BadSeatsRev;
            public long SeatsRev;
            public string[] SeatNames, Outs, Results;
            public Order[] Orders;
        }

        private class Proposal
        {
            public Plan P;
            public string Account;   // 0.6.0: the account, or "group:<id>" (KeyNow)
            public bool Sim;
            public string State = "open";                 // open, accepting, accepted, rejected, withdrawn, not answered, expired
            public double SeenAt = -1, AnsweredAt = -1;
            public Order Entry;
            public string WithdrawnWhy;
        }

        private class FlatJob
        {
            public string Root, Why;
            public Instrument Inst;   // the contract (the served one, or another month the agent's own trade holds; review A5)
            public bool Owned;   // it owned the pair: close its position; else only its own orders are cancelled (checked again: review A1)
            public bool WasMissing;   // the account left NinjaTrader's list since the job started (checked again when it is back)
            public int StartQty, LegQty;   // the position when the job started, and the agent's stop legs' contracts then (the cap without a ledger)
            public int ClosedQty;          // contracts its closes filled (taken off LegQty's cap; review A C2)
            public bool CloseCounted, CancelsSent;
            public double StopPx;          // the agent's stop price when the job started (placed again over a shut market; review A C1)
            public string Tag;             // the tag of that stop
            public Order ReStop;           // the stop placed again
            public bool ReStopTried;       // tried in this shut spell (once)
            public bool FeedSaid;          // 0.6.3 (audit C7): the flatten without a fresh price (the data feed down) was said once
            public bool CloseHandled;      // its last close's end was looked at (a close that did not fill: the stop placed again; review D3)
            public double HoldUntilMs;     // after a close that could not go: the stop stays, the next try waits until then
            public bool GateAgain;         // a stop was placed again: its cancel waits for a trading market too (review E2)
            public string ReStopSay;
            public double StartMs, LastCancelMs = -1e18, LastCloseMs = -1e18, LastErrorMs, ApartSinceMs = -1;
            public Order Close;
        }

        // ---------------------------------------------------------- a seat (0.6.0): one account the agent trades
        // Everything ChartBridge follows per account lives here: the open trade and its ledger, the roots it owns until flat
        // (Sticky), the flatten jobs, the lost-trade errors, the contract-against clock. A single account is one seat; a group is one
        // seat per member, in the group's order. A seat that left the group while it holds the agent's trade stays (owned, protected,
        // flattened at flatAt) until flat, and takes no new entry (ChartBridgeAgents.EntryCheck asks IsEntrySeat). Every field is
        // under the agent's Sync, as before; the code below is the 0.5.8 single-account code, one copy per seat.
        private sealed class Seat
        {
            public readonly string Name;   // the account (NinjaTrader's name)
            private readonly ChartBridgeAgent ag;
            private readonly object Sync;
            public Seat(ChartBridgeAgent agent, string name) { ag = agent; Name = name; Sync = agent.Sync; }

            public string openTag, openRoot;
            public Instrument openInst;   // the contract of the open trade (the flatten looks at it too, any month; review A5)
            public int ledQty;
            public double ledCash, ledAvg;
            public readonly Dictionary<string, double> LostTrades = new Dictionary<string, double>();   // root -> last error (review A3)
            public readonly Dictionary<string, string> LostTradeText = new Dictionary<string, string>();
            public readonly Dictionary<string, string> HeldLost = new Dictionary<string, string>();   // root -> a lost-trade error held while ChartBridge's own flatten runs there (0.5.7)
            public readonly Dictionary<string, double> HeldSince = new Dictionary<string, double>();   // root -> when the hold began (review of #47: at most 30 s)
            public readonly HashSet<string> Sticky = new HashSet<string>();   // roots it owns until flat by both readings with no entry
            public readonly Dictionary<string, FlatJob> Flats = new Dictionary<string, FlatJob>();   // the contract's full name -> its flatten job
            // the last plan on this seat (agentState.seats, the page's seats table): why it sat out, its size and risk
            public string Out, LastPlanId;
            public int LastSize;
            public double LastRisk;

            private string Id { get { return ag.Id; } }
            private string Account { get { return Name; } }
            private Dictionary<string, double> Trades { get { return ag.Trades; } }
            private Dictionary<string, int[]> Spans { get { return ag.Spans; } }
            private Dictionary<string, int> EntrySeen { get { return ag.EntrySeen; } }
            private HashSet<string> Carried { get { return ag.Carried; } }
            private Dictionary<string, ExcessFill> ExcessByTag { get { return ag.ExcessByTag; } }
            private Rules RulesNow() { return ag.RulesNow(); }
            private List<string> FlatRoots() { return ag.FlatRoots(); }
            private string MonthRoot(Instrument inst) { return ag.MonthRoot(inst); }
            private bool IsMine(Order o) { return ag.IsMine(o); }
            private bool IsMyEntry(Order o) { return ag.IsMyEntry(o); }
            private string CbIdOf(Order o) { return ag.CbIdOf(o); }
            private void RollDay() { ag.RollDay(); }
            private string StandDownLocked() { return ag.StandDownLocked(); }
            private void SaveDay() { ag.SaveDay(); }
            private void Notify() { ag.Notify(); }
            private void Log(string text) { ag.Log(text); }
            private void AgentLog(string text) { ag.AgentLog(text); }

            // Its own entries working on this account: NinjaTrader's list (by name, after a restart too) and those just sent.
            public List<Order> WorkingEntries()
            {
                List<Order> list = new List<Order>();
                Account a = FindAccount(Name);
                if (a != null) lock (a.Orders) foreach (Order o in a.Orders) if (IsMyEntry(o) && ChartBridgeOrders.IsWorking(o.OrderState)) list.Add(o);
                lock (Sync) foreach (Order o in ag.Placed) if (o.Account != null && o.Account.Name == Name && !list.Contains(o) && ChartBridgeOrders.IsWorking(o.OrderState)) list.Add(o);
                return list;
            }

            // Anything of the agent's here: its open trade, a working entry, a root it owns, a flatten job, a lost-trade error not yet flat.
            public bool Exposed()
            {
                bool ex;
                lock (Sync) ex = openTag != null || Flats.Count > 0 || LostTrades.Count > 0 || HeldLost.Count > 0;
                return ex || WorkingEntries().Count > 0 || FlatRoots().Any(r => Owns(r));
            }

            // Its open trade as the strip shows it ({root, qty, avgPrice}), or null. Under Sync.
            public string PositionJsonLocked()
            {
                return openTag != null && ledQty != 0 ? "{\"root\":" + CbJson.Str(openRoot) + ",\"qty\":" + ledQty.ToString(CultureInfo.InvariantCulture) + ",\"avgPrice\":" + CbJson.Num(ledAvg) + "}" : "null";
            }

            // 0.5.2 re-check: does the agent own a position on root from an earlier session? Its open trade's tag is carried, or (no
            // trade record yet: after a start, before the executions are read again) the position is held under its own legs of a
            // carried trade. A position of this session (its own record, or legs of a tag not carried) never counts.
            public bool FromBefore(string root)
            {
                if (!Owns(root)) return false;
                string open;
                HashSet<string> carried;
                lock (Sync) { open = openTag != null && openRoot == root ? openTag : null; carried = new HashSet<string>(Carried.Select(t => t.Length > 8 ? t.Substring(0, 8) : t)); }
                if (open != null) return carried.Contains(open.Length > 8 ? open.Substring(0, 8) : open);
                Account a = FindAccount(Account);
                Instrument inst = ChartBridgeServer.InstrumentFor(root);
                if (a == null || inst == null) return false;
                if (ChartBridgeOrders.AgentListed(a, inst) == 0 && ChartBridgeOrders.AgentEffective(a, inst) == 0) return false;
                return ChartBridgeOrders.AgentMayFill(a, inst).Any(o => IsMine(o) && LegRx.IsMatch(o.Name ?? "") && carried.Contains(ChartBridgeAgents.TagOf(o.Name) ?? ""));
            }


            public bool Owns(string root)
            {
                string acct;
                bool open, stick;
                lock (Sync) { acct = Name; open = openTag != null && openRoot == root; stick = Sticky.Contains(root); }
                Account a = FindAccount(acct);
                if (open && LedgerAgainst(root, a) == null) return true;   // its open trade, unless the account holds the other side (review A1)
                Instrument inst = ChartBridgeServer.InstrumentFor(root);
                if (open) return a != null && inst != null && ChartBridgeOrders.AgentMayFill(a, inst).Any(o => IsMine(o) && ChartBridgeAgents.IsAgentEntry(o));
                if (a == null || inst == null) return stick;
                List<Order> may = ChartBridgeOrders.AgentMayFill(a, inst);
                bool entryWorks = may.Any(o => IsMine(o) && ChartBridgeAgents.IsAgentEntry(o)), mineWorks = may.Any(o => IsMine(o));
                if (entryWorks) return true;
                int p1 = ChartBridgeOrders.AgentListed(a, inst), p2 = ChartBridgeOrders.AgentEffective(a, inst);
                int held = p1 != 0 ? p1 : p2;
                // its own stop or target that would close what the account holds (a sell for a long, a buy for a short) protects it there
                bool legsWork = held != 0 && may.Any(o => IsMine(o) && LegRx.IsMatch(o.Name ?? "") && (o.OrderAction == OrderAction.Sell) == (held > 0));
                if (legsWork && (p1 != 0 || p2 != 0)) return true;   // its own stop or target protects a position there (after a restart too)
                if (!stick) return false;
                bool unnoted = ChartBridgeOrders.AgentUnnotedFill(a, inst, Now()) != null;   // a fill NinjaTrader shows whose event is not through yet
                if (p1 == 0 && p2 == 0 && !mineWorks && !unnoted) { lock (Sync) { if (!(openTag != null && openRoot == root)) Sticky.Remove(root); } return false; }   // flat by both readings, nothing of it working: the lock clears
                return true;
            }


            // Its open trade on this root is against what the account holds: both readings of the trade's contract show a position on
            // the other side (it ended where ChartBridge could not see it, and the account holds someone else's). The text, or null.
            private string LedgerAgainst(string root, Account a) { return LedgerAgainst(root, a, false); }

            // forDrop: the trade is ended only once this has held for 3 s with no unnoted fill (review A C4).
            private string LedgerAgainst(string root, Account a, bool forDrop)
            {
                Instrument li;
                int q;
                lock (Sync) { if (openTag == null || openRoot != root) return null; li = openInst; q = ledQty; }
                if (a == null || q == 0) { lock (Sync) AgainstSince.Remove(root); return null; }
                if (li == null) li = ChartBridgeServer.InstrumentFor(root);
                if (li == null) return null;
                int p1 = ChartBridgeOrders.AgentListed(a, li), p2 = ChartBridgeOrders.AgentEffective(a, li);
                double now = Now();
                if (p1 == 0 || p2 == 0 || Math.Sign(p1) == Math.Sign(q) || Math.Sign(p2) == Math.Sign(q)) { lock (Sync) AgainstSince.Remove(root); return null; }
                string text = "its trade holds " + q + " but " + a.Name + " " + root + " shows " + p1;
                if (!forDrop) return text;   // the owner lock and the flatten: at once (never the agent's while the account holds the other side)
                // review A C4: only once it has held for 3 s with no fill NinjaTrader shows ahead of its event (a late execution of the
                // agent's own close would otherwise read as someone else's position for a moment)
                bool unnoted = ChartBridgeOrders.AgentUnnotedFill(a, li, now) != null;
                lock (Sync)
                {
                    double since;
                    if (unnoted || !AgainstSince.TryGetValue(root, out since)) { AgainstSince[root] = now; return null; }
                    if (now - since < ChartBridgeAgents.AgainstGraceMs) return null;
                }
                return text;
            }

            private readonly Dictionary<string, double> AgainstSince = new Dictionary<string, double>();   // root -> since when its trade is against the account

            // The contract a flatten job closes: the served one by Owns, another month only while its own open trade holds it.
            private bool OwnsContract(string root, Instrument inst, Account a)
            {
                Instrument served = ChartBridgeServer.InstrumentFor(root);
                if (served == null || ChartBridgeAgents.SameContract(inst, served)) return Owns(root);
                lock (Sync) if (!(openTag != null && openRoot == root && ChartBridgeAgents.SameContract(openInst, inst) && ledQty != 0)) return false;
                return LedgerAgainst(root, a) == null;
            }

            // The most a flatten may close on that contract: its open trade's own quantity there; with no trade followed (after a restart
            // before the executions are read, or none), the agent's stop legs' contracts when the job started (review A1).
            private int CloseCap(string root, Instrument inst, FlatJob j)
            {
                lock (Sync)
                    if (openTag != null && openRoot == root && (openInst == null || ChartBridgeAgents.SameContract(openInst, inst)) && ledQty != 0) return Math.Abs(ledQty);
                return Math.Max(0, j.LegQty - j.ClosedQty);   // each close's fill comes off it (review A C2)
            }

            // Every execution on this agent's account (ChartBridgeServer.Deliver). Follows the agent's trade: it opens with the first fill
            // of its entry (a trade, even part filled) and closes when that position is flat again, whatever closed it; its realized
            // dollars come from those executions (as the bot's).
            public void OnExec(Instrument inst, MarketPosition side, int qty, double price, string orderId, string json)
            {
                if (inst == null || qty <= 0) return;
                string root = ChartBridgeServer.RootFor(inst) ?? MonthRoot(inst);   // any contract month of its roots (review A5)
                if (root == null) return;
                Rules r = RulesNow();
                if (!r.Roots.Contains(root)) return;
                Order o = ag.FindOrder(orderId, Name);
                string entryTag = IsMyEntry(o) ? ChartBridgeAgents.TagOf(o.Name) : null;
                bool mine = o != null && IsMine(o);
                // section 10 item 7: while it owns the pair, every fill there reaches the agent, its own or not (Anthony's Flatten, a close
                // in NinjaTrader: role other, cbId null when the order is not ChartBridge's), read before this fill is booked
                bool tell = mine || OwnsContract(root, inst, FindAccount(Account));
                if (tell && json != null && json.EndsWith("}", StringComparison.Ordinal))   // section 10: ChartBridge's id and the order's role
                    json = json.Substring(0, json.Length - 1) + ",\"cbId\":" + Str(CbIdOf(o)) + ",\"role\":" + CbJson.Str(mine ? ChartBridgeOrders.AgentRoleFor(o) : "other") + "}";   // 10.7: a role only for its own orders (ag:<id>, or legs of its entry's tag)
                RollDay();
                string closedTag = null, opened = null, netted = null, sdWas = null;
                bool spanChanged = false;
                double pnl = 0;
                ChartBridgeClient c;
                lock (Sync)
                {
                    // review E1: a late execution of an entry whose trade the crossing rule just closed (the close bigger than the trade)
                    // nets against that close: the trade's result and its contracts grow by the matched part; only the true net (any rest
                    // of this fill) may open a trade again
                    ExcessFill ex;
                    if (entryTag != null && openTag == null && ExcessByTag.TryGetValue(entryTag, out ex) && ex.Qty > 0 && (side == MarketPosition.Long ? 1 : -1) == ex.TradeSign)
                    {
                        int m = Math.Min(qty, ex.Qty);
                        double was;
                        if (Trades.TryGetValue(ex.Key, out was) && !double.IsNaN(was)) Trades[ex.Key] = Math.Round(was + m * (ex.Price - price) * ex.TradeSign * ex.Pv, 2);
                        int[] sp0;
                        if (Spans.TryGetValue(ex.Key, out sp0)) sp0[1] += m;
                        int seen0;
                        EntrySeen.TryGetValue(entryTag, out seen0);
                        EntrySeen[entryTag] = seen0 + m;
                        ex.Qty -= m;
                        qty -= m;
                        netted = ex.Key;
                    }
                    if (entryTag != null && qty > 0)
                    {
                        // A trade opens with the first fill of its entry (counted once, also after a restart: the executions are read again
                        // then). Each trade knows which of its entry's contracts it covers (Spans: first, count; in the day file), so the
                        // same entry filling again after its first part already closed (a part fill, then the rest) opens a NEW trade,
                        // "<tag>-2", whose result counts in losses, pnlToday and maxLosses (review A-S3), and a replay never counts twice.
                        int seen;
                        EntrySeen.TryGetValue(entryTag, out seen);
                        seen += qty;
                        EntrySeen[entryTag] = seen;
                        string inSpan = null;
                        foreach (KeyValuePair<string, int[]> sp in Spans)
                            if ((sp.Key == entryTag || sp.Key.StartsWith(entryTag + "-", StringComparison.Ordinal)) && seen > sp.Value[0] && seen <= sp.Value[0] + sp.Value[1]) inSpan = sp.Key;
                        double was;
                        if (inSpan != null)
                        {
                            if (openTag == null && Trades.TryGetValue(inSpan, out was) && double.IsNaN(was)) { openTag = inSpan; openRoot = root; openInst = inst; ledQty = 0; ledCash = 0; ledAvg = 0; Sticky.Add(root); }
                        }
                        else if (openTag != null && (openTag == entryTag || openTag.StartsWith(entryTag + "-", StringComparison.Ordinal)))
                        {
                            int[] sp;
                            if (Spans.TryGetValue(openTag, out sp)) sp[1] = seen - sp[0];   // more of the same entry while its trade is open
                            spanChanged = true;
                        }
                        else if (openTag == null)
                        {
                            string key = entryTag;
                            for (int n = 2; Trades.ContainsKey(key); n++) key = entryTag + "-" + n.ToString(CultureInfo.InvariantCulture);
                            openTag = key; openRoot = root; openInst = inst; ledQty = 0; ledCash = 0; ledAvg = 0; Sticky.Add(root);
                            Trades[key] = double.NaN; Spans[key] = new[] { seen - qty, qty }; opened = key;
                        }
                    }
                    if (qty > 0 && openTag != null && root == openRoot && (openInst == null || ChartBridgeAgents.SameContract(inst, openInst)))
                    {
                        int signed = side == MarketPosition.Long ? qty : -qty;
                        // review D5: a fill bigger than the trade on the other side closes the trade at that fill's own price; the rest is
                        // not the agent's (its trade never crosses zero, so its result is always from its actual executions); the rest is
                        // kept for a late execution of the same entry to net against (review E1)
                        if (ledQty != 0 && Math.Sign(signed) != Math.Sign(ledQty) && Math.Abs(signed) > Math.Abs(ledQty))
                        {
                            string tag8 = openTag.Length > 8 ? openTag.Substring(0, 8) : openTag;
                            ExcessByTag[tag8] = new ExcessFill { Key = openTag, Qty = Math.Abs(signed) - Math.Abs(ledQty), Price = price, TradeSign = Math.Sign(ledQty), Pv = inst.MasterInstrument.PointValue };
                            signed = -ledQty;
                        }
                        if (ledQty == 0 || Math.Sign(signed) == Math.Sign(ledQty)) ledAvg = (ledAvg * Math.Abs(ledQty) + price * qty) / (Math.Abs(ledQty) + qty);
                        ledQty += signed;
                        ledCash -= signed * price;
                        if (ledQty == 0)
                        {
                            sdWas = ag.lossStandDown;   // 0.6.0: a group's plan can reach maxLosses on a seat's close that is not itself a loss
                            pnl = Math.Round(ledCash * inst.MasterInstrument.PointValue, 2);
                            Trades[openTag] = pnl;
                            closedTag = openTag; openTag = null; openRoot = null; openInst = null; ledAvg = 0;
                        }
                    }
                    c = ag.HelloedClientLocked();
                }
                if (tell && c != null && json != null) c.Send(json);
                if (netted != null) { AgentLog("a late fill of its entry netted against the close of trade " + netted); SaveDay(); Notify(); }
                if (spanChanged && opened == null && closedTag == null) SaveDay();
                if (opened == null && closedTag == null) return;
                SaveDay();
                if (opened != null) AgentLog("trade " + opened + " opened on " + root);
                if (closedTag != null)
                {
                    AgentLog("trade " + closedTag + " closed: " + pnl.ToString("0.##", CultureInfo.InvariantCulture) + " dollars");
                    string sd;
                    lock (Sync) sd = StandDownLocked();
                    bool groupTrade;
                    lock (Sync) groupTrade = ag.SeatOfTag.ContainsKey(closedTag.Length > 8 ? closedTag.Substring(0, 8) : closedTag);
                    if (sd != null && (pnl < 0 || (groupTrade && sdWas == null))) { SaveDay(); Log("agent " + Id + " stands down: " + sd); ToPages(StatusJson("warn", "Agent " + Id + " stands down: " + sd)); }
                }
                Notify();
            }


            // Review E1: its open trade while the pair is flat by both readings, with nothing of the agent working and no fill NinjaTrader
            // shows ahead of its event, for 5 s: ended, booked from its own executions; a warning when those do not net to zero.
            private double ghostSince = -1;

            public void EndGhostTrade(double now)
            {
                string key, root;
                Instrument li;
                lock (Sync) { key = openTag; root = openRoot; li = openInst; }
                if (key == null) { ghostSince = -1; return; }
                if (li == null) li = ChartBridgeServer.InstrumentFor(root);
                Account a = FindAccount(Account);
                if (a == null || li == null) { ghostSince = -1; return; }
                int p1 = ChartBridgeOrders.AgentListed(a, li), p2 = ChartBridgeOrders.AgentEffective(a, li);
                bool busy = p1 != 0 || p2 != 0 || ChartBridgeOrders.AgentMayFill(a, li).Any(o => IsMine(o)) || ChartBridgeOrders.AgentUnnotedFill(a, li, now) != null;
                if (busy) { ghostSince = -1; return; }
                if (ghostSince < 0) { ghostSince = now; return; }
                if (now - ghostSince < ChartBridgeAgents.GhostGraceMs) return;
                ghostSince = -1;
                double realized;
                int left;
                lock (Sync)
                {
                    if (openTag != key) return;
                    double pv = li.MasterInstrument != null ? li.MasterInstrument.PointValue : 0;
                    left = ledQty;
                    realized = Math.Round((ledCash + ledQty * ledAvg) * pv, 2);
                    Trades[key] = realized; openTag = null; openRoot = null; openInst = null; ledQty = 0; ledCash = 0; ledAvg = 0; Sticky.Remove(root);
                    StandDownLocked();
                }
                string text = "Agent " + Id + ": its trade " + key + " on " + a.Name + " " + root + " was ended: the pair is flat by both readings with nothing of it working; " +
                              realized.ToString("0.##", CultureInfo.InvariantCulture) + " dollars booked from its executions" + (left != 0 ? " (its own executions leave " + left + " open: some were not seen; check NinjaTrader's fills)" : "");
                Log(text); AgentLog(text);
                if (left != 0) ChartBridgeOrders.AgentWarn(text);
                SaveDay();
                Notify();
            }


            // Review A1 and A3: its open trade ended where ChartBridge could not see it while the account holds a position: the trade is
            // dropped (ownership is not restored: Anthony decides), and the pages get an error every 60 s until that pair is flat.
            public void DropLedgerAgainst(List<string> roots)
            {
                Account a = FindAccount(Account);
                foreach (string root in roots)
                {
                    string why = LedgerAgainst(root, a, true);
                    if (why == null) continue;
                    string key;
                    double realized;
                    lock (Sync)
                    {
                        if (openTag == null || openRoot != root) continue;
                        // the realized part is booked first (review A C4): what its fills so far closed, at the average of its opening fills
                        Instrument li = openInst ?? ChartBridgeServer.InstrumentFor(root);
                        double pv = li != null && li.MasterInstrument != null ? li.MasterInstrument.PointValue : 0;
                        realized = Math.Round((ledCash + ledQty * ledAvg) * pv, 2);
                        key = openTag; Trades[key] = realized; openTag = null; openRoot = null; openInst = null; ledQty = 0; ledCash = 0; ledAvg = 0; Sticky.Remove(root); AgainstSince.Remove(root);
                        StandDownLocked();
                    }
                    string text = "Agent " + Id + ": its open trade " + key + " on " + root + " was ended (" + why + "); its realized part, " + realized.ToString("0.##", CultureInfo.InvariantCulture) + " dollars, is booked";
                    Log(text); AgentLog(text);
                    SaveDay();
                    TradeLost(root);
                    Notify();
                }
            }

            // Review D1: a position whose only working orders there are the agent's own stop (a leg, or the stop placed again) with no
            // trade followed (a restart lost it: the executions read again did not give it back): the A3 error every 60 s until flat.
            // The pair stays the agent's (its stop protects it) and its flat hours close it.
            public void WarnHeldByStopOnly(List<string> roots)
            {
                Account a = FindAccount(Account);
                if (a == null) return;
                foreach (string root in roots)
                {
                    bool followed, told;
                    lock (Sync) { followed = openTag != null && openRoot == root; told = LostTrades.ContainsKey(root) || HeldLost.ContainsKey(root); }
                    if (followed || told) continue;
                    Instrument inst = ChartBridgeServer.InstrumentFor(root);
                    if (inst == null) continue;
                    int p1 = ChartBridgeOrders.AgentListed(a, inst), p2 = ChartBridgeOrders.AgentEffective(a, inst);
                    if (p1 == 0 && p2 == 0) continue;
                    List<Order> may = ChartBridgeOrders.AgentMayFill(a, inst);
                    if (may.Count == 0 || !may.All(o => IsMine(o) && LegRx.IsMatch(o.Name ?? ""))) continue;
                    TradeLost(root, "agent " + Id + " holds " + p1 + " on " + Account + " " + root + " with no trade record (ChartBridge restarted); only its own stop protects it: ChartBridge keeps that stop and closes the position at its flat time; check NinjaTrader");
                }
            }

            public void TradeLost(string root) { TradeLost(root, null); }

            // 0.5.7: while ChartBridge's own flatten job runs on that root (its cancels take the legs away), the error is HELD, never
            // dropped: RepeatTradeLost raises it once no job runs there and the pair is still not flat, and forgets it if it is flat.
            private void TradeLost(string root, string say)
            {
                string text = say ?? "agent " + Id + " had an open trade on " + Account + " " + root + " and its legs are gone; ChartBridge no longer treats the position as the agent's: flatten or protect it by hand";
                bool held, already;
                lock (Sync)
                {
                    held = HoldLocked(root, Now());
                    already = HeldLost.ContainsKey(root);
                    if (held) HeldLost[root] = text;
                    else { HeldLost.Remove(root); LostTrades[root] = Now(); LostTradeText[root] = text; }
                }
                if (held) { if (!already) { string h = text + " (held while ChartBridge's own flatten runs on " + root + ")"; Log(h); AgentLog(h); } return; }
                Log(text); AgentLog(text); ChartBridgeOrders.AgentAlarm(text);
            }

            // Under Sync: a flatten job of this agent that owns the pair runs on a contract of that root (review of #47: a job that does
            // not own it never says NOT FLAT, so it holds nothing).
            private bool FlattenRunsLocked(string root) { return Flats.Values.Any(j => j.Root == root && j.Owned); }

            // Under Sync: hold the lost-trade error on that root now: its own flatten runs there, and the hold is under 30 s old (review
            // of #47: after that it is raised and repeats as before, whatever the job does). Starts the hold's clock.
            private bool HoldLocked(string root, double now)
            {
                if (!FlattenRunsLocked(root)) return false;
                double since;
                if (!HeldSince.TryGetValue(root, out since)) { HeldSince[root] = now; return true; }
                return now - since < ChartBridgeAgents.LostHoldMaxMs;
            }

            // Every pass: each lost-trade error again every 60 s until that pair is flat by both readings (lead's default: the pages have
            // no acknowledge message for it, so it ends only when the pair is flat). 0.5.7: none while a flatten job runs on that root;
            // an error held meanwhile is raised once the job ends with the pair still not flat.
            public void RepeatTradeLost(double now)
            {
                List<string> roots;
                lock (Sync) roots = LostTrades.Keys.Concat(HeldLost.Keys).Distinct().ToList();
                if (roots.Count == 0) return;
                Account a = FindAccount(Account);
                foreach (string root in roots)
                {
                    Instrument inst = ChartBridgeServer.InstrumentFor(root);
                    bool flat = a != null && inst != null && ChartBridgeOrders.AgentListed(a, inst) == 0 && ChartBridgeOrders.AgentEffective(a, inst) == 0;
                    string text = null, raise = null, dropped = null;
                    lock (Sync)
                    {
                        string h;
                        bool wasHeld = HeldLost.TryGetValue(root, out h);
                        if (flat) { LostTrades.Remove(root); LostTradeText.Remove(root); HeldLost.Remove(root); HeldSince.Remove(root); if (wasHeld) dropped = h; }
                        else if (HoldLocked(root, now)) { }   // held: neither repeated nor dropped (at most 30 s)
                        else if (wasHeld) { HeldLost.Remove(root); if (!FlattenRunsLocked(root)) HeldSince.Remove(root); LostTrades[root] = now; LostTradeText[root] = h; raise = h; }
                        else
                        {
                            if (!FlattenRunsLocked(root)) HeldSince.Remove(root);   // no job there now: a later job may hold again
                            if (now - LostTrades[root] >= ChartBridgeAgents.LostTradeEveryMs) { LostTrades[root] = now; text = LostTradeText[root]; }
                        }
                    }
                    if (dropped != null) { string d = "agent " + Id + ": the lost-trade error held on " + Account + " " + root + " is not raised: the pair is flat"; Log(d); AgentLog(d); }
                    if (raise != null) { Log(raise); AgentLog(raise); ChartBridgeOrders.AgentAlarm(raise); }
                    if (text != null) { AgentLog(text); ChartBridgeOrders.AgentAlarm(text); }
                }
            }


            // ---------------------------------------------------------- the flatten (flatAt, or the agent's own in auto)
            // Per root it owns or has orders working on: every order that may fill on that contract of its account is cancelled; once
            // NinjaTrader confirms each one done, every fill there has come through, and both position readings agree, what it holds is
            // closed at market ("CB#<tag> ag:<id> flat"). Readings still apart after 3 s: the smaller is closed (never more than either
            // shows). Not flat 10 s after the start: a status error to the pages, every 10 s until flat. Returns how many roots started.
            public int StartFlatten(string why, bool byRules)
            {
                Account a = FindAccount(Account);   // null: not listed by NinjaTrader; a pair it still owns gets its job (and its errors)
                string acctName = Account;
                int started = 0;
                foreach (string root in FlatRoots())
                {
                    foreach (Instrument inst in FlatContracts(root))
                    {
                        string key = inst.FullName ?? root;
                        bool busy;
                        lock (Sync) busy = Flats.ContainsKey(key);
                        if (busy) continue;
                        List<Order> may = a != null ? ChartBridgeOrders.AgentMayFill(a, inst) : new List<Order>();
                        bool mineWorking = may.Any(o => IsMine(o)), owned = OwnsContract(root, inst, a);
                        if (!owned && !mineWorking) continue;
                        List<Order> stops = may.Where(o => IsMine(o) && StopLegRx.IsMatch(o.Name ?? "") && o.StopPrice > 0).ToList();
                        int legQty = stops.Sum(o => Math.Max(0, o.Quantity - o.Filled));
                        int startQty = a != null ? ChartBridgeOrders.AgentListed(a, inst) : 0;
                        // the stop nearest the market (lead's default: the most protective of its stops), to place again over a shut market
                        Order near = stops.Count == 0 ? null : stops.Any(o => o.OrderAction == OrderAction.Sell) ? stops.OrderByDescending(o => o.StopPrice).First() : stops.OrderBy(o => o.StopPrice).First();
                        lock (Sync)
                        {
                            Flats[key] = new FlatJob { Root = root, Inst = inst, Why = why, StartMs = Now(), Owned = owned, StartQty = startQty, LegQty = legQty, WasMissing = a == null,
                                                       StopPx = near != null ? near.StopPrice : 0, Tag = near != null ? ChartBridgeAgents.TagOf(near.Name) : null };
                            if (owned) Sticky.Add(root);   // its pair until flat: cancelling its own legs never makes it someone else's
                        }
                        started++;
                        string where = root + (ChartBridgeAgents.SameContract(inst, ChartBridgeServer.InstrumentFor(root)) ? "" : " (" + inst.FullName + ")");
                        string text = byRules ? why : "Agent " + Id + ": " + why + ": " + where + " on " + acctName;
                        Log(text); AgentLog(text + " (" + where + " on " + acctName + ")");
                        ChartBridgeServer.SendToTraders(StatusJson("info", text));
                    }
                }
                if (started > 0) Notify();
                return started;
            }

            private static readonly Regex StopLegRx = new Regex("^CB#[0-9a-f]{8} (?:stop |mstop |ag:[a-z][a-z0-9]{0,11} stop p)");

            // The contracts a flatten looks at on a root: the served one, and another month while its own open trade holds it (review A5).
            private List<Instrument> FlatContracts(string root)
            {
                List<Instrument> list = new List<Instrument>();
                Instrument served = ChartBridgeServer.InstrumentFor(root);
                if (served != null) list.Add(served);
                lock (Sync)
                    if (openTag != null && openRoot == root && openInst != null && ledQty != 0 && !ChartBridgeAgents.SameContract(openInst, served)) list.Add(openInst);
                return list;
            }

            // Review A1: the pair is no longer the agent's: the job ends and nothing of the account's is closed.
            private void DropJob(FlatJob j, string key, Account a) { DropJob(j, key, a, null); }

            private void DropJob(FlatJob j, string key, Account a, string say)
            {
                lock (Sync) { Flats.Remove(key); if (!(openTag != null && openRoot == j.Root)) Sticky.Remove(j.Root); }
                string text = say ?? (a != null ? a.Name : Account) + " " + j.Root + " is no longer agent " + Id + "'s: ChartBridge did not close it";
                Log(text); AgentLog(text + " (its flatten: " + j.Why + ")");
                ChartBridgeServer.SendToTraders(StatusJson("warn", text));
                Notify();
            }

            public void StepFlatten(double now)
            {
                List<FlatJob> jobs;
                lock (Sync) jobs = Flats.Values.ToList();
                if (jobs.Count == 0) return;
                Account a = FindAccount(Account);
                DateTime etShut = NowEt();
                bool shut = ChartBridgeAgents.MarketShut(etShut) || ChartBridgeCme.Closed(etShut);   // 0.5.2 review: the calendar's halts too (13:00 NYSE holiday, 13:15 early close, CME holidays): no order while closed
                foreach (FlatJob j in jobs)
                {
                    Instrument inst = j.Inst;
                    string key = inst != null ? inst.FullName ?? j.Root : j.Root;
                    if (inst == null) { lock (Sync) Flats.Remove(key); continue; }
                    double errEvery = shut ? ChartBridgeAgents.ShutErrorEveryMs : ChartBridgeAgents.FlatErrorEveryMs;
                    if (a == null)
                    {
                        // the account left NinjaTrader's list: the job stays (resumed when it is back, after 18:00 too), and it is loud
                        j.WasMissing = true;
                        if (now - j.StartMs >= ChartBridgeAgents.FlatErrorEveryMs && now - j.LastErrorMs >= errEvery)
                        {
                            j.LastErrorMs = now;
                            string text = "Agent " + Id + ": NOT FLAT? its flatten (" + j.Why + ") waits: " + Account + " (account not listed by NinjaTrader); it goes on when the account is back; check NinjaTrader now";
                            ChartBridgeOrders.AgentAlarm(text); AgentLog(text);
                        }
                        continue;
                    }
                    int p1 = ChartBridgeOrders.AgentListed(a, inst), p2 = ChartBridgeOrders.AgentEffective(a, inst);
                    // review A1: back from missing, or the position is not what the job started with: is the pair still the agent's?
                    if (j.Owned && (p1 != 0 || p2 != 0) && (j.WasMissing || p1 != j.StartQty))
                    {
                        j.WasMissing = false;
                        bool flipped = j.StartQty != 0 && p1 != 0 && Math.Sign(p1) != Math.Sign(j.StartQty);
                        if (flipped || !OwnsContract(j.Root, inst, a)) { DropJob(j, key, a); continue; }
                    }
                    j.WasMissing = false;
                    if (j.Close != null && !j.CloseCounted && !ChartBridgeOrders.AgentMayFillState(j.Close.OrderState)) { j.ClosedQty += j.Close.Filled; j.CloseCounted = true; }   // review A C2
                    if (shut)
                    {
                        // review A2: no order at all while the market is shut (its stop and target stay); the job goes on at the open
                        if ((p1 == 0 && p2 == 0) || !j.Owned)
                        {
                            if (ChartBridgeOrders.AgentMayFill(a, inst).Any(o => IsMine(o) && o != j.Close)) continue;   // its own orders wait for the open
                            string at = Iso(now);
                            lock (Sync) { Flats.Remove(key); ag.flattenedAt = at; }
                            AgentLog("flat on " + j.Root + " " + a.Name + " (" + j.Why + ")");
                            Notify();
                            continue;
                        }
                        string legsSay = "its stop and target stay";
                        if (j.CancelsSent)
                        {
                            bool stopWorks = ChartBridgeOrders.AgentMayFill(a, inst).Any(o => IsMine(o) && (StopLegRx.IsMatch(o.Name ?? "") || o == j.ReStop));
                            bool closeStill = j.Close != null && ChartBridgeOrders.AgentMayFillState(j.Close.OrderState);
                            if (closeStill && !stopWorks) legsSay = "its stop and target were cancelled and its market close still works (it may fill at the open), so its stop is not placed again beside it; act in NinjaTrader now";   // review D2
                            else if (stopWorks) legsSay = j.ReStop != null && ChartBridgeOrders.AgentMayFillState(j.ReStop.OrderState) ? "ChartBridge placed its stop again at " + CbJson.Num(j.StopPx) : "its stop stays";
                            else if (!j.ReStopTried) { j.ReStopTried = true; j.ReStopSay = ReStop(a, inst, j, p1, p2); legsSay = j.ReStopSay; }   // once per shut spell
                            else legsSay = j.ReStopSay ?? "its stop and target were already cancelled; act in NinjaTrader now";
                        }
                        if (now - j.StartMs >= ChartBridgeAgents.FlatErrorEveryMs && now - j.LastErrorMs >= errEvery)
                        {
                            j.LastErrorMs = now;
                            string text = "Agent " + Id + ": NOT FLAT " + ((now - j.StartMs) / 1000).ToString("0", CultureInfo.InvariantCulture) + " s after its flatten (" + j.Why + "): " + j.Root + " on " + a.Name +
                                          " still shows " + p1 + "; the market is shut, so ChartBridge sends no close until it opens; " + legsSay + (legsSay.Contains("act in NinjaTrader") ? "" : "; act in NinjaTrader if you need to");
                            ChartBridgeOrders.AgentAlarm(text); AgentLog(text);
                        }
                        continue;
                    }
                    j.ReStopTried = false;
                    // review A C1: an early close or a halt: before any leg is cancelled the market must be trading in fact (a trade on that
                    // root in the last 5 s); otherwise the stop and target stay and the job tries again
                    // review D3: a close that ended without filling (rejected, cancelled) in open hours: the stop goes back at once, and
                    // the next try waits 30 s with it in place
                    if (j.Owned && j.Close != null && !j.CloseHandled && !ChartBridgeOrders.AgentMayFillState(j.Close.OrderState))
                    {
                        j.CloseHandled = true;
                        if (j.Close.Filled < j.Close.Quantity && (p1 != 0 || p2 != 0))
                        {
                            string say = ReStop(a, inst, j, p1, p2);
                            j.HoldUntilMs = now + ChartBridgeAgents.CloseRetryHoldMs;
                            string text = "Agent " + Id + ": NOT FLAT: its market close on " + j.Root + " " + a.Name + " ended unfilled (" + j.Close.OrderState + "); " + say + "; ChartBridge tries again in 30 s";
                            j.LastErrorMs = now;
                            ChartBridgeOrders.AgentAlarm(text); AgentLog(text);
                        }
                    }
                    if (now < j.HoldUntilMs) continue;
                    double lastPx;
                    if (j.Owned && (p1 != 0 || p2 != 0) && (!j.CancelsSent || j.GateAgain) && !ChartBridgeOrders.AgentFreshLast(j.Root, ChartBridgeAgents.TradingFreshMs, out lastPx))
                    {
                        // 0.6.3 (audit C7, Anthony's decision): no trade seen because the data feed is down, the account Connected and
                        // the market open by the calendar (not shut, above): the flatten goes anyway, saying so. The feed up and no
                        // trade is a real halt: as before, the stop and target stay and ChartBridge tries again when it trades.
                        bool feedDown = ChartBridgeServer.FeedDown, acctUp = ChartBridgeAccounts.ConnectionText(a) == "connected";
                        if (feedDown && acctUp)
                        {
                            if (!j.FeedSaid)
                            {
                                j.FeedSaid = true;
                                string text = "Agent " + Id + ": flattening " + j.Root + " on " + a.Name + " (" + j.Why + ") with NinjaTrader's data feed down: no trade seen for 5 s because the data connection is lost, the account is Connected and the market is open by the calendar, so the close goes without a fresh price; check the fill in NinjaTrader";
                                ChartBridgeOrders.AgentAlarm(text); AgentLog(text);
                            }
                        }
                        else
                        {
                            if (now - j.StartMs >= ChartBridgeAgents.FlatErrorEveryMs && now - j.LastErrorMs >= ChartBridgeAgents.FlatErrorEveryMs)
                            {
                                j.LastErrorMs = now;
                                string text = "Agent " + Id + ": NOT FLAT " + ((now - j.StartMs) / 1000).ToString("0", CultureInfo.InvariantCulture) + " s after its flatten (" + j.Why + "): " + j.Root + " on " + a.Name +
                                              " still shows " + p1 + "; " + (feedDown ? "no trade seen for 5 s: NinjaTrader's data feed is down and " + a.Name + " is not Connected, so ChartBridge cannot close it now; act in NinjaTrader now"
                                              : "market not trading: " + (j.GateAgain ? "its stop placed again at " + CbJson.Num(j.StopPx) + " stays; ChartBridge tries again when it trades" : "the stop and target stay; ChartBridge tries again when it trades"));
                                ChartBridgeOrders.AgentAlarm(text); AgentLog(text);
                            }
                            continue;
                        }
                    }
                    string exitWhy;
                    bool up = ChartBridgeAccounts.ExitAllowed(a, out exitWhy);
                    List<Order> may = ChartBridgeOrders.AgentMayFill(a, inst);
                    // not its pair: only its own orders, and never its stop placed again while the account holds a position there (review
                    // D1; flat, that stop could only open one, so it goes: lead's default)
                    List<Order> others = may.Where(o => o != j.Close && (j.Owned || (IsMine(o) && !(IsReStop(o) && (p1 != 0 || p2 != 0))))).ToList();
                    bool closeWorks = j.Close != null && may.Contains(j.Close);
                    if (up && others.Count > 0)
                    {
                        if (now - j.LastCancelMs >= ChartBridgeAgents.FlatRetryMs)
                        {
                            j.LastCancelMs = now;
                            j.CancelsSent = true;
                            j.GateAgain = false;
                            if (j.Owned) ChartBridgeOrders.AgentFlattening(a, inst);   // never marks the page's brackets on a pair it does not own
                            try { a.Cancel(others.ToArray()); }
                            catch (Exception ex) { Log("agent " + Id + " flatten: the cancels could not be sent (" + ex.Message + "); tried again in 3 s"); }
                            Log("agent " + Id + " flatten: cancel sent for " + others.Count + " order(s) on " + j.Root + " " + a.Name);
                        }
                    }
                    else if (up && !closeWorks)
                    {
                        if ((p1 == 0 && p2 == 0) || !j.Owned)
                        {
                            string at = Iso(now);
                            lock (Sync) { Flats.Remove(key); ag.flattenedAt = at; }
                            AgentLog("flat on " + j.Root + " " + a.Name + " (" + j.Why + ")");
                            Notify();
                            continue;
                        }
                        string unnoted = ChartBridgeOrders.AgentUnnotedFill(a, inst, now);
                        int qty = 0, dir = 0;
                        if (unnoted == null && p1 == p2) { qty = Math.Abs(p1); dir = Math.Sign(p1); j.ApartSinceMs = -1; }
                        else
                        {
                            if (j.ApartSinceMs < 0) j.ApartSinceMs = now;
                            if (now - j.ApartSinceMs >= ChartBridgeAgents.FlatRetryMs && Math.Sign(p1) == Math.Sign(p2) && p1 != 0)
                            { qty = Math.Min(Math.Abs(p1), Math.Abs(p2)); dir = Math.Sign(p1); }
                        }
                        if (qty > 0 && now - j.LastCloseMs >= ChartBridgeAgents.FlatRetryMs)
                        {
                            // review A1: asked again before every close, and never more than the agent's own trade holds
                            if (!OwnsContract(j.Root, inst, a)) { DropJob(j, key, a); continue; }
                            int cap = CloseCap(j.Root, inst, j);
                            if (cap <= 0 && j.ClosedQty > 0)
                            {
                                DropJob(j, key, a, (a.Name + " " + j.Root + ": agent " + Id + "'s " + j.ClosedQty + " closed; the rest (" + p1 + ") is not agent " + Id + "'s: ChartBridge did not close it"));
                                continue;
                            }
                            qty = Math.Min(qty, cap);
                            if (qty > 0) { j.LastCloseMs = now; j.CloseCounted = false; j.CloseHandled = false; j.Close = SendClose(a, inst, dir, qty, j.Root, j); }
                        }
                    }
                    bool flat = (p1 == 0 && p2 == 0) || !j.Owned;
                    if (!flat && now - j.StartMs >= ChartBridgeAgents.FlatErrorEveryMs && now - j.LastErrorMs >= ChartBridgeAgents.FlatErrorEveryMs)
                    {
                        j.LastErrorMs = now;
                        string text = "Agent " + Id + ": NOT FLAT " + ((now - j.StartMs) / 1000).ToString("0", CultureInfo.InvariantCulture) + " s after its flatten (" + j.Why + "): " + j.Root + " on " + a.Name +
                                      " still shows " + p1 + (p2 != p1 ? " (or " + p2 + " with fills not yet in the position)" : "") + (up ? "" : "; the account is not connected (" + exitWhy + ")") + "; act in NinjaTrader now";
                        ChartBridgeOrders.AgentAlarm(text);
                        AgentLog(text);
                    }
                }
            }

            // Review A C1 (lead's default: a position is never left without a stop over a closed market): the job paused for the shut
            // hours after its legs were cancelled. While it still holds a position, its stop goes back at the agent's own stop price
            // (the one nearest the market when the job started), unless that price is already through the last trade. Says what it did.
            private string ReStop(Account a, Instrument inst, FlatJob j, int p1, int p2)
            {
                if (j.Close != null && ChartBridgeOrders.AgentMayFillState(j.Close.OrderState)) return "its market close still works, so its stop is not placed again beside it; act in NinjaTrader now";   // review D2
                if (!j.Owned || p1 == 0 || p2 == 0 || Math.Sign(p1) != Math.Sign(p2)) return "its stop and target were already cancelled; act in NinjaTrader now";
                if (j.StopPx <= 0) return "its stop and target were already cancelled and ChartBridge knows no stop price for it; act in NinjaTrader now";
                double last;
                ChartBridgeOrders.AgentFreshLast(j.Root, double.MaxValue, out last);
                int dir = Math.Sign(p1);
                if (last > 0 && (dir > 0 ? j.StopPx >= last : j.StopPx <= last))
                    return "its stop and target were already cancelled and its stop price " + CbJson.Num(j.StopPx) + " is through the last trade " + CbJson.Num(last) + ", so it was not placed again; act in NinjaTrader now";
                int qty = Math.Min(Math.Min(Math.Abs(p1), Math.Abs(p2)), CloseCap(j.Root, inst, j));
                if (qty <= 0) return "its stop and target were already cancelled; act in NinjaTrader now";
                Order x = SendStop(a, inst, dir, qty, j);
                if (x == null) return "its stop and target were already cancelled and its stop could not be placed again; act in NinjaTrader now";
                j.ReStop = x;
                j.GateAgain = true;
                return "its stop and target had been cancelled: ChartBridge placed its stop again at " + CbJson.Num(j.StopPx) + " for " + qty;
            }

            // The stop placed again: a stop market at the agent's stop price, GTC, "CB#<tag> ag:<id> stop p<price>" (role stop).
            private Order SendStop(Account a, Instrument inst, int dir, int qty, FlatJob j)
            {
                string tag = j.Tag ?? Guid.NewGuid().ToString("N").Substring(0, 8);
                Order x;
                lock (ChartBridgeOrders.AgentPlaceLock)
                {
                    int p1 = ChartBridgeOrders.AgentListed(a, inst), p2 = ChartBridgeOrders.AgentEffective(a, inst);
                    if (Math.Sign(p1) != dir || Math.Sign(p2) != dir || qty > Math.Min(Math.Abs(p1), Math.Abs(p2))) return null;   // changed meanwhile
                    x = a.CreateOrder(inst, dir > 0 ? OrderAction.Sell : OrderAction.Buy, OrderType.StopMarket, OrderEntry.Manual, TimeInForce.Gtc, qty, 0, j.StopPx, "",
                        "CB#" + tag + " ag:" + Id + " stop p" + j.StopPx.ToString("0.########", CultureInfo.InvariantCulture), NinjaTrader.Core.Globals.MaxDate, null);
                    ChartBridgeAgents.NoteTag(tag, Id);
                    ChartBridgeOrders.AgentSent(x);
                    try { a.Submit(new[] { x }); }
                    catch (Exception ex) { ChartBridgeOrders.AgentUnsent(x); Log("agent " + Id + " flatten: the stop could not be placed again (" + ex.Message + ")"); return null; }
                }
                string text = "agent " + Id + " flatten: its legs were cancelled and its close cannot go now: stop " + (dir > 0 ? "sell " : "buy ") + qty + " " + j.Root + " at " + CbJson.Num(j.StopPx) + " placed again on " + a.Name;
                Log(text); AgentLog(text);
                return x;
            }

            // The flatten's one market order: closes what the position holds, never more (an exit: no entry gate, a Connected account).
            // Under the order lock, the position and the orders that may fill are read again first: nothing new may slip in between.
            private Order SendClose(Account a, Instrument inst, int dir, int qty, string root, FlatJob j)
            {
                string tag = Guid.NewGuid().ToString("N").Substring(0, 8);
                Order x;
                lock (ChartBridgeOrders.AgentPlaceLock)
                {
                    int p1 = ChartBridgeOrders.AgentListed(a, inst), p2 = ChartBridgeOrders.AgentEffective(a, inst);
                    bool other = ChartBridgeOrders.AgentMayFill(a, inst).Any(o => o != j.Close);
                    if (other || Math.Sign(p1) != dir || Math.Sign(p2) != dir || qty > Math.Min(Math.Abs(p1), Math.Abs(p2))) return null;   // changed meanwhile: the next pass looks again
                    x = a.CreateOrder(inst, dir > 0 ? OrderAction.Sell : OrderAction.Buy, OrderType.Market, OrderEntry.Manual, TimeInForce.Day, qty, 0, 0, "",
                        "CB#" + tag + " ag:" + Id + " flat", NinjaTrader.Core.Globals.MaxDate, null);
                    ChartBridgeAgents.NoteTag(tag, Id);
                    ChartBridgeOrders.AgentSent(x);
                    try { a.Submit(new[] { x }); }
                    catch (Exception ex) { ChartBridgeOrders.AgentUnsent(x); Log("agent " + Id + " flatten: the close could not be sent (" + ex.Message + ")"); return null; }
                }
                string text = "agent " + Id + " flatten: " + (dir > 0 ? "sell " : "buy ") + qty + " " + root + " at market on " + a.Name;
                Log(text); AgentLog(text);
                return x;
            }

        }

        // ---------------------------------------------------------- state (under Sync)
        private ChartBridgeClient client;
        private bool claimed;
        private volatile bool helloed;
        private string name, build;
        private double lastMsgMs, noClientSinceMs, lastStripMs, attachedMs, startedMs;
        private bool startTold;
        private string mode = "shadow";
        private bool killed;
        private Rules rules = new Rules();
        private string account = ChartBridgeBranches.None;   // 0.5.7 (DECISION 2026-10-14e): None until chosen; was Sim101
        private bool chosen;   // an account was chosen on the page (agent-<id>-account.txt); false on None
        private bool league;   // 0.6.2: a league seat (agent-<id>-account.txt league<TAB><account>): one account, entries only while it is Sim
        private string rulesBroken, accountBroken, dayBroken, lossStandDown;
        private bool dayRepaired;   // 0.6.3 (audit C3): dayBroken is a damaged file kept from its lines (saves go on)
        private string secret, secretState = "missing";
        private string session;
        // 0.5.2 review: the tags of trade records from an earlier session (dropped at a start, or carried over at the roll): a position
        // left is flattened. Kept in the day file (carried<TAB><tag>), so a roll while running and then a restart still flatten it.
        private readonly HashSet<string> Carried = new HashSet<string>();
        private readonly Dictionary<string, double> Trades = new Dictionary<string, double>();   // entry tag -> realized $ (NaN while open)
        private readonly HashSet<string> PlanIds = new HashSet<string>();
        private readonly Dictionary<string, double> Expiry = new Dictionary<string, double>();   // entry tag -> its plan's expiry (UTC ms)
        private readonly Dictionary<string, int[]> Spans = new Dictionary<string, int[]>();    // trade key -> { entry contracts before it, contracts it covers }
        private readonly Dictionary<string, int> EntrySeen = new Dictionary<string, int>();     // entry tag -> its contracts seen filling this run
        // 0.6.0: the open trade, its ledger, the roots owned until flat, the flatten jobs and the lost-trade errors are each seat's own
        // (Seat); a single account is one seat.
        private string groupId;   // the group it trades (agent-<id>-account.txt group<TAB><id>), or null: one account (or None)
        private List<string> seatNames = new List<string>();   // the accounts it trades now, in seat order (welcome.seats)
        private long seatsRev = 1;   // up on every change of seatNames (welcome.seatsRev; a plan with another is refused)
        private readonly Dictionary<string, Seat> Seats = new Dictionary<string, Seat>(StringComparer.Ordinal);   // every seat it follows: now, and one that left while it holds its trade
        private readonly Dictionary<string, string> SeatOfTag = new Dictionary<string, string>();   // entry tag -> its seat (a group's plans only; the day file's #seat lines)
        private readonly Dictionary<string, Proposal> Proposals = new Dictionary<string, Proposal>();
        private readonly Dictionary<string, List<Order>> EntryOfPlan = new Dictionary<string, List<Order>>();   // 0.6.0: one entry per seat
        private readonly Dictionary<string, string> PlanOfTag = new Dictionary<string, string>();
        private readonly List<Order> Placed = new List<Order>();
        private class CancelTry { public double FirstMs, LastMs; public int Tries; public string Why; public bool GaveUp; }
        private readonly Dictionary<Order, CancelTry> CancelSent = new Dictionary<Order, CancelTry>();   // cancels sent, until the order is done
        private readonly HashSet<string> MyTags = new HashSet<string>();
        private readonly Queue<double> Actions = new Queue<double>();
        private readonly LinkedList<string> Notes = new LinkedList<string>(), PlansShown = new LinkedList<string>();
        private string lastPlanJson;
        private string flattenedAt;
        private long nPlans, nProposals, nPlaced, nRefused, nHeartbeatLost;

        public string Account { get { lock (Sync) return account; } }
        public bool Chosen { get { lock (Sync) return chosen; } }
        public bool League { get { lock (Sync) return league; } }
        public string Build { get { lock (Sync) return build; } }
        // 0.6.2 (SPEC CE-2): the refusal for a league seat on an account that is not NinjaTrader's simulator (read fresh each time;
        // an unknown provider is no Sim)
        private string LeagueRefusal { get { return "agent " + Id + " is a league seat: Sim accounts only"; } }

        // ---------------------------------------------------------- 0.6.0: the seats
        public string GroupId { get { lock (Sync) return groupId; } }
        public bool OnGroup(string gid) { lock (Sync) return groupId != null && groupId == gid; }
        private bool GroupNow() { lock (Sync) return groupId != null; }
        // No account and no group: nothing trades.
        private bool NoneNow() { lock (Sync) return groupId == null && ChartBridgeBranches.IsNone(account); }
        // An account it follows (a seat now, or one that left while it holds its trade): its fills, orders and positions come here.
        public bool HasSeat(string acct) { lock (Sync) return acct != null && Seats.ContainsKey(acct); }
        // An account it may enter on now: a seat of its account or group (never one that left the group).
        public bool IsEntrySeat(string acct) { lock (Sync) return acct != null && seatNames.Contains(acct); }
        private List<string> SeatNames() { lock (Sync) return seatNames.ToList(); }
        private Seat SeatFor(string acct) { lock (Sync) { Seat s; return acct != null && Seats.TryGetValue(acct, out s) ? s : null; } }
        // Every seat it follows: the seats now in seat order, then any that left (by name).
        private List<Seat> AllSeats()
        {
            lock (Sync)
            {
                List<Seat> list = seatNames.Where(n => Seats.ContainsKey(n)).Select(n => Seats[n]).ToList();
                list.AddRange(Seats.Values.Where(x => !seatNames.Contains(x.Name)).OrderBy(x => x.Name, StringComparer.Ordinal));
                return list;
            }
        }
        // The agent owns (account, root): a seat of it does (the owner lock, ChartBridgeAgents.OwnerAgent).
        public bool OwnsOn(string acct, string root) { Seat s = SeatFor(acct); return s != null && s.Owns(root); }
        // Any seat owns root.
        public bool Owns(string root) { return AllSeats().Any(s => s.Owns(root)); }
        // The account is this agent's against the bot, the copier and other agents: a seat of the account or group chosen, or a seat
        // that left while it holds the agent's trade (0.5.7: an agent on None claims nothing else).
        public bool Claims(string acct)
        {
            if (string.IsNullOrEmpty(acct)) return false;
            Seat held = null;
            lock (Sync)
            {
                if (chosen && seatNames.Any(x => string.Equals(x, acct, StringComparison.OrdinalIgnoreCase))) return true;
                foreach (Seat x in Seats.Values) if (!seatNames.Contains(x.Name) && string.Equals(x.Name, acct, StringComparison.OrdinalIgnoreCase)) held = x;
            }
            return held != null && held.Exposed();
        }
        // The words for what it trades: the account, "group Lucid (SIM-A, SIM-B)", or None's "-".
        public string AccountWords()
        {
            string g, a;
            List<string> seats;
            lock (Sync) { g = groupId; a = account; seats = seatNames.ToList(); }
            return g == null ? a : "group " + (ChartBridgeGroups.NameOf(g) ?? g) + " (" + (seats.Count > 0 ? string.Join(", ", seats) : "no accounts") + ")";
        }
        // For the bot's and the copier's refusals: "group Lucid" when acct is a seat of the group it trades, "it holds agent X's trade"
        // for a seat that left, null for its own single account.
        public string GroupWordsFor(string acct)
        {
            string g;
            bool now;
            lock (Sync) { g = groupId; now = seatNames.Any(x => string.Equals(x, acct, StringComparison.OrdinalIgnoreCase)); }
            if (now) return g == null ? null : "group " + (ChartBridgeGroups.NameOf(g) ?? g);
            return "it holds agent " + Id + "'s trade until flat";
        }
        // The key a proposal keeps of what it was made for (an account, or "group:<id>"): accepted only while it is still that.
        private string KeyNow() { lock (Sync) return groupId != null ? "group:" + groupId : account; }
        private static string KeyWords(string key) { return key != null && key.StartsWith("group:", StringComparison.Ordinal) ? "group " + (ChartBridgeGroups.NameOf(key.Substring(6)) ?? key.Substring(6)) : key; }
        // The client of a hello'd agent, or null. Under Sync.
        private ChartBridgeClient HelloedClientLocked() { return helloed ? client : null; }

        // The seats now: the group's members (groups.txt, in its order), or the one account, or none (None). A change puts seatsRev
        // up, makes the new seats, and (tell) tells the agent (welcome, accountState) and the pages. The group deleted: the agent goes
        // to None (its seats still holding its trade stay its own until flat). True when the seats changed.
        internal bool RefreshSeats() { return RefreshSeats(true); }
        private bool RefreshSeats(bool tell)
        {
            string gid, acct;
            lock (Sync) { gid = groupId; acct = account; }
            List<string> want;
            if (gid != null)
            {
                want = ChartBridgeGroups.MembersOf(gid);
                if (want == null && !ChartBridgeGroups.Unreadable())
                {
                    string why;
                    lock (PlaceGate) { lock (Sync) if (groupId != gid) return false; string keep; lock (Sync) keep = mode; why = GoNone("its group " + gid + " was deleted", keep); }
                    if (why != null) Log("agent " + Id + ": its group " + gid + " was deleted, but " + why);
                    return true;
                }
                if (want == null) want = new List<string>();   // groups.txt cannot be read: no seat (every entry is refused anyway)
            }
            else want = ChartBridgeBranches.IsNone(acct) ? new List<string>() : new List<string> { acct };
            bool changed;
            string was;
            lock (Sync)
            {
                if (groupId != gid || account != acct) return false;   // changed meanwhile: the caller of that change refreshes
                changed = !want.SequenceEqual(seatNames);
                was = string.Join(", ", seatNames);
                if (changed)
                {
                    seatNames = want;
                    seatsRev++;
                    foreach (string n in want) if (!Seats.ContainsKey(n)) Seats[n] = new Seat(this, n);
                }
            }
            if (!changed) return false;
            if (gid != null) { string t = "group " + (ChartBridgeGroups.NameOf(gid) ?? gid) + "'s seats are now " + (want.Count > 0 ? string.Join(", ", want) : "none") + " (were " + (was.Length > 0 ? was : "none") + "); seatsRev " + SeatsRevNow(); Log("agent " + Id + " " + t); AgentLog(t); }
            PruneSeats();
            if (tell) { ToAgent(WelcomeJson()); Notify(); }
            return true;
        }
        private long SeatsRevNow() { lock (Sync) return seatsRev; }

        // A seat it no longer trades is dropped once nothing of the agent is left on it (flat by both readings, nothing working).
        private void PruneSeats()
        {
            List<Seat> gone;
            lock (Sync) gone = Seats.Values.Where(x => !seatNames.Contains(x.Name)).ToList();
            foreach (Seat x in gone)
            {
                if (x.Exposed()) continue;
                lock (Sync) { if (seatNames.Contains(x.Name)) continue; Seats.Remove(x.Name); }
            }
        }
        public int MaxQtyFor(string root) { lock (Sync) return rules.Roots.Contains(root ?? "") ? rules.QtyFor(root) : 0; }
        private Rules RulesNow() { lock (Sync) return rules.Copy(); }

        private string Folder { get { return ChartBridgeConfig.Folder; } }
        private string SecretFile { get { return Path.Combine(Folder, "agent-" + Id + "-secret.txt"); } }
        private string AccountFile { get { return Path.Combine(Folder, "agent-" + Id + "-account.txt"); } }
        private string RulesFile { get { return Path.Combine(Folder, "agent-" + Id + "-rules.txt"); } }
        private string DayFile { get { return Path.Combine(Folder, "agent-" + Id + "-day.txt"); } }
        private string KillFile { get { return Path.Combine(Folder, "agent-" + Id + "-kill.txt"); } }   // 0.6.3 (audit C5)
        private double killedAt;   // the UTC ms the kill switch went on (0: not known), while killed
        public bool Killed { get { lock (Sync) return killed; } }
        private string LogFile { get { return Path.Combine(Folder, "agent-" + Id + ".log"); } }

        private static double Now() { return ChartBridgeAgents.Now(); }
        private static DateTime NowEt() { return ChartBridgeAgents.NowEt(); }

        // ---------------------------------------------------------- start and stop
        public void Start()
        {
            LoadSecret();
            LoadRules();
            LoadAccount();
            RefreshSeats(false);   // 0.6.0: its seats (a group's members, or its one account)
            LoadDay();
            double? kill = ChartBridgeFiles.KillSince(KillFile);   // 0.6.3 (audit C5): a kill switch survives a restart until the page releases it
            lock (Sync) { noClientSinceMs = Now(); startedMs = noClientSinceMs; mode = "shadow"; killed = kill.HasValue; killedAt = kill ?? 0; }
            if (kill.HasValue) Log("agent " + Id + ": its kill switch is still on (" + KilledWords(kill.Value) + "; kept through the restart): every agent order is refused until it is released on the page");
            Log("agent channel ON for " + Id + ": it may connect at ws://localhost:" + ChartBridgeConfig.Port + "/agent/" + Id + " (account " + AccountWords() + (SimNow() ? " (Sim)" : " (LIVE)") + (League ? ", a league seat" : "") + ", starting in shadow)");
        }

        public void Stop()
        {
            ChartBridgeClient c;
            lock (Sync) { c = client; client = null; helloed = false; }
            if (c != null) c.Close();
        }

        // ---------------------------------------------------------- the secret (agent-<id>-secret.txt, as bot-secret.txt)
        private void LoadSecret()
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
                    File.WriteAllLines(tmp, new[] { "# ChartBridge agent secret for " + Id + " (made by ChartBridge on this PC; the agent reads it from here; never share it)",
                                                    "# Delete this file to make a new one at the next start.", s });
                    File.Move(tmp, SecretFile);
                    state = "ok";
                    Log("made agent-" + Id + "-secret.txt next to config.txt (the agent reads the secret from that file)");
                }
                else
                {
                    string[] data = File.ReadAllLines(SecretFile).Select(l => l.Trim()).Where(l => l.Length > 0 && !l.StartsWith("#")).ToArray();
                    if (data.Length == 1 && Regex.IsMatch(data[0], "^[0-9a-fA-F]{64}$")) { s = data[0].ToLowerInvariant(); state = "ok"; }
                    else state = "unreadable";
                }
            }
            catch (Exception) { s = null; state = "unreadable"; }
            if (state != "ok") { s = null; Log("agent-" + Id + "-secret.txt could not be read: every connection for agent " + Id + " is refused until it is fixed or deleted (a new one is made at the next start)"); }
            lock (Sync) { secret = s; secretState = state; }
        }

        public bool SecretMatches(string given)
        {
            string s;
            lock (Sync) s = secret;
            if (s == null || given == null || given.Length != s.Length) return false;
            int diff = 0;
            for (int i = 0; i < s.Length; i++) diff |= s[i] ^ given[i];   // constant time
            return diff == 0;
        }

        // 0.6.3 (audit C3): a file read but not understood (a power cut, a hand edit) falls back to its last good copy (.bak), said so
        // to the pages; null when one of them parsed, else the main file's problem (parse is run again on it, so its state is the
        // main file's). An IOException is thrown to the caller as before.
        internal static string ParseOrBackup(string path, string name, Func<string[], string> parse)
        {
            string[] lines = ReadAll(path);
            string why = parse(lines);
            if (why == null) return null;
            string[] b = ChartBridgeFiles.ReadBackup(path);
            if (b != null && parse(b) == null) { ChartBridgeFiles.Note(ChartBridgeFiles.BackupNote(name, why)); return null; }
            return parse(lines);
        }

        // A file's lines; the harness's ChartBridgeAccounts.ReadFault fails a read by file name (an IOException, as a sharing lock).
        internal static string[] ReadAll(string path)
        {
            Func<string, string> fault = ChartBridgeAccounts.ReadFault;
            string why = fault != null ? fault(Path.GetFileName(path)) : null;
            if (why != null) throw new IOException(why);
            return File.ReadAllLines(path);
        }

        // 0.6.3 (audit C4): a file that exists but cannot be opened (an IOException: Defender, a backup tool or OneDrive holding it at
        // NinjaTrader's start) is "not read yet": no new entries for the agent meanwhile, read again on every 500 ms check, the alarm
        // only after IoRetryMs (then tried every 5 s), and the stand-down gone once a read succeeds. kind: rules, account or day.
        public static double IoRetryMs = 60000;
        private readonly Dictionary<string, double> ioSince = new Dictionary<string, double>();
        private readonly HashSet<string> ioAlarmed = new HashSet<string>();
        private double ioLastTry;
        private void IoState(string kind, bool failed, string why)
        {
            bool was;
            lock (Sync)
            {
                was = ioSince.ContainsKey(kind);
                if (failed) { if (!was) ioSince[kind] = Now(); return; }
                ioSince.Remove(kind);
                if (ioAlarmed.Remove(kind)) why = "read";
            }
            if (was) { Log("agent-" + Id + "-" + kind + ".txt could be read now: its stand-down is gone"); if (why == "read") ChartBridgeServer.SendToTraders("{\"type\":\"status\",\"level\":\"info\",\"text\":" + CbJson.Str("agent-" + Id + "-" + kind + ".txt could be read now: agent " + Id + " is no longer stood down for it") + "}"); }
        }
        private bool IoPending(string kind) { lock (Sync) return ioSince.ContainsKey(kind); }
        private static string IoWords(string file, string id, string msg) { return file + " could not be read yet (" + msg + "): no new entries for agent " + id + " until it is read (ChartBridge tries again; exits always work)"; }
        private void RetryIo(double now)
        {
            List<string> kinds;
            lock (Sync)
            {
                if (ioSince.Count == 0) return;
                bool late = ioSince.Keys.All(k => ioAlarmed.Contains(k));   // alarmed: every 5 s from then
                if (late && now - ioLastTry < 5000) return;
                ioLastTry = now;
                kinds = ioSince.Keys.ToList();
            }
            foreach (string k in kinds)
            {
                if (k == "rules") LoadRules();
                else if (k == "account") { LoadAccount(); RefreshSeats(false); }
                else LoadDay();
            }
            List<string> alarm = new List<string>();
            lock (Sync)
            {
                foreach (KeyValuePair<string, double> kv in ioSince)
                    if (now - kv.Value >= IoRetryMs && ioAlarmed.Add(kv.Key)) alarm.Add(kv.Key == "rules" ? rulesBroken : kv.Key == "account" ? accountBroken : dayBroken);
            }
            foreach (string w in alarm) if (w != null) ChartBridgeOrders.AgentAlarm(w.Replace(" could not be read yet (", " could not be read for a minute (").Replace("(ChartBridge tries again;", "(ChartBridge keeps trying;"));
            Notify();
        }

        // ---------------------------------------------------------- the rules file (agent-<id>-rules.txt)
        // Two # lines, then key<TAB>value lines; no file: the defaults. A file that cannot be understood (a line it does not know,
        // a key twice, a value out of range) is never written over and stands the agent down until the page sets the rules or the
        // file is deleted. A key left out keeps its default (lead's default).
        private void LoadRules()
        {
            Rules r = new Rules();
            string broken = null, io = null;
            Func<string[], string> parse = all =>
            {
                    string broken1 = null;
                    r = new Rules();
                    HashSet<string> seen = new HashSet<string>();
                    Dictionary<string, int> qty = new Dictionary<string, int>();
                    foreach (string raw in all)
                    {
                        string line = raw.Trim();
                        if (line.Length == 0 || line.StartsWith("#")) continue;
                        string[] p = line.Split('\t');
                        if (p.Length != 2 || !seen.Add(p[0])) { broken1 = "agent-" + Id + "-rules.txt has a line ChartBridge does not understand"; break; }
                        string k = p[0], v = p[1].Trim();
                        int n;
                        if (k == "roots") r.Roots = v.Split(',').Select(x => x.Trim().ToUpperInvariant()).Where(x => x.Length > 0).ToList();
                        else if (k.StartsWith("maxQty.", StringComparison.Ordinal) && int.TryParse(v, NumberStyles.None, CultureInfo.InvariantCulture, out n)) qty[k.Substring(7).ToUpperInvariant()] = n;
                        else if (k == "entryFrom" && (n = ParseHm(v)) >= 0) r.EntryFrom = n;
                        else if (k == "entryUntil" && (n = ParseHm(v)) >= 0) r.EntryUntil = n;
                        else if (k == "flatAt" && (n = ParseHm(v)) >= 0) r.FlatAt = n;
                        else if (k == "maxExpireSec" && int.TryParse(v, NumberStyles.None, CultureInfo.InvariantCulture, out n)) r.MaxExpireSec = n;
                        else if ((k == "maxTrades" || k == "maxLosses") && (v == "none" || int.TryParse(v, NumberStyles.None, CultureInfo.InvariantCulture, out n)))
                        {
                            int val = v == "none" ? 0 : int.Parse(v, CultureInfo.InvariantCulture);
                            if (v != "none" && val < 1) { broken1 = "agent-" + Id + "-rules.txt: " + k + " must be none or a whole number of 1 or more"; break; }
                            if (k == "maxTrades") r.MaxTrades = val; else r.MaxLosses = val;
                        }
                        else { broken1 = "agent-" + Id + "-rules.txt has a line ChartBridge does not understand"; break; }
                    }
                    if (broken1 == null)
                    {
                        r.MaxQty = new Dictionary<string, int>();
                        foreach (string root in r.Roots) r.MaxQty[root] = qty.ContainsKey(root) ? qty[root] : DefaultQty(root);
                        string bad = RulesProblem(r);
                        if (bad != null) broken1 = "agent-" + Id + "-rules.txt: " + bad;
                    }
                    return broken1;
            };
            try
            {
                if (File.Exists(RulesFile)) broken = ParseOrBackup(RulesFile, "agent-" + Id + "-rules.txt", parse);
            }
            catch (IOException ex) { io = IoWords("agent-" + Id + "-rules.txt", Id, ex.Message); }
            catch (Exception ex) { broken = "agent-" + Id + "-rules.txt could not be read (" + ex.Message + ")"; }
            if (broken != null) { broken += ": no new entries for agent " + Id + " until its rules are set on the Agent tab or the file is deleted"; Log(broken); r = new Rules(); }
            if (io != null) { broken = io; if (!IoPending("rules")) Log(io); r = new Rules(); }
            lock (Sync) { rules = r; rulesBroken = broken; }
            IoState("rules", io != null, null);
        }

        private string SaveRules(Rules r)
        {
            try
            {
                List<string> lines = new List<string> { "# ChartBridge rules for agent " + Id + " (written by ChartBridge from the page's Agent tab; do not edit)",
                    "# roots, maxQty.<ROOT> (1 to the hard ceiling: minis 2, micros 20), entryFrom, entryUntil, flatAt (New York time, in session order from 18:00), maxExpireSec, maxTrades, maxLosses",
                    "roots\t" + string.Join(",", r.Roots) };
                foreach (string root in r.Roots) lines.Add("maxQty." + root + "\t" + r.QtyFor(root).ToString(CultureInfo.InvariantCulture));
                lines.Add("entryFrom\t" + Hm(r.EntryFrom)); lines.Add("entryUntil\t" + Hm(r.EntryUntil)); lines.Add("flatAt\t" + Hm(r.FlatAt));
                lines.Add("maxExpireSec\t" + r.MaxExpireSec.ToString(CultureInfo.InvariantCulture));
                lines.Add("maxTrades\t" + (r.MaxTrades > 0 ? r.MaxTrades.ToString(CultureInfo.InvariantCulture) : "none"));
                lines.Add("maxLosses\t" + (r.MaxLosses > 0 ? r.MaxLosses.ToString(CultureInfo.InvariantCulture) : "none"));
                WriteWhole(RulesFile, lines);
                return null;
            }
            catch (Exception ex) { return ex.Message; }
        }

        internal static void WriteWhole(string file, List<string> lines)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            ChartBridgeFiles.WriteLines(file, lines.ToArray());   // 0.6.3 (audit C3): write-through, flushed, the previous copy kept as .bak
        }

        // ---------------------------------------------------------- the account file (agent-<id>-account.txt, as bot-account.txt)
        private void LoadAccount()
        {
            string a = ChartBridgeBranches.None, broken = null, grp = null, io = null;   // 0.5.7: no file is None (was Sim101)
            bool lg = false;
            Func<string[], string> parse = all =>
            {
                    string broken1 = null;
                    a = ChartBridgeBranches.None; grp = null; lg = false;
                    string found = null, foundGroup = null;
                    foreach (string raw in all)
                    {
                        string line = raw.Trim();
                        if (line.Length == 0 || line.StartsWith("#")) continue;
                        string[] p = line.Split('\t');
                        if (found == null && foundGroup == null && p.Length == 2 && p[0] == "account" && PlainName(p[1])) found = p[1];
                        else if (found == null && foundGroup == null && p.Length == 2 && p[0] == "group" && GroupIdRx.IsMatch(p[1])) foundGroup = p[1];   // 0.6.0: a group (an older ChartBridge stands the agent down on it)
                        else if (found == null && foundGroup == null && p.Length == 2 && p[0] == "league" && PlainName(p[1]) && !ChartBridgeBranches.IsNone(p[1])) { found = p[1]; lg = true; }   // 0.6.2: a league seat (an older ChartBridge stands the agent down on it)
                        else { broken1 = "agent-" + Id + "-account.txt has a line ChartBridge does not understand"; break; }
                    }
                    if (broken1 == null && found == null && foundGroup == null) broken1 = "agent-" + Id + "-account.txt names no account";
                    if (broken1 == null && foundGroup != null) grp = foundGroup;
                    else if (broken1 == null) a = found;
                    if (broken1 != null) { a = ChartBridgeBranches.None; grp = null; lg = false; }
                    return broken1;
            };
            try
            {
                if (File.Exists(AccountFile)) broken = ParseOrBackup(AccountFile, "agent-" + Id + "-account.txt", parse);
            }
            catch (IOException ex) { io = IoWords("agent-" + Id + "-account.txt", Id, ex.Message); }
            catch (Exception ex) { broken = "agent-" + Id + "-account.txt could not be read (" + ex.Message + ")"; }
            if (broken != null) { broken += ": no new entries for agent " + Id + " until its account is chosen again on the Agent tab or the file is deleted"; Log(broken); }
            if (io != null) { broken = io; if (!IoPending("account")) Log(io); a = ChartBridgeBranches.None; grp = null; lg = false; }
            lock (Sync) { account = a; groupId = grp; accountBroken = broken; league = broken == null && lg && grp == null; chosen = broken == null && (grp != null || (a != null && !ChartBridgeBranches.IsNone(a))) && File.Exists(AccountFile); }
            IoState("account", io != null, null);
        }

        private string SaveAccount(string nm)
        {
            try
            {
                WriteWhole(AccountFile, new List<string> { "# ChartBridge account for agent " + Id + " (written by ChartBridge from the page's Agent tab; do not edit)",
                    "# the one account the agent's orders go to; - is None (nothing trades), as is a missing file", "account\t" + nm });
                return null;
            }
            catch (Exception ex) { return ex.Message; }
        }

        // 0.6.2: a league seat, as league<TAB><account> (a ChartBridge before 0.6.2 does not understand the line and stands the agent
        // down: safe, as the group line before it).
        private string SaveLeague(string nm)
        {
            try
            {
                WriteWhole(AccountFile, new List<string> { "# ChartBridge account for agent " + Id + " (written by ChartBridge from the page's Agent tab; do not edit)",
                    "# a league seat: the one Sim account the agent's orders go to (ChartBridge refuses its entries whenever the account is not Sim); account<TAB>- is None", "league\t" + nm });
                return null;
            }
            catch (Exception ex) { return ex.Message; }
        }

        // 0.6.0: the group it trades, as group<TAB><id> (a ChartBridge before 0.6.0 does not understand the line and stands the agent
        // down: safe).
        private static readonly Regex GroupIdRx = new Regex("^g[1-9][0-9]{0,8}$");
        private string SaveGroup(string gid)
        {
            try
            {
                WriteWhole(AccountFile, new List<string> { "# ChartBridge account for agent " + Id + " (written by ChartBridge from the page's Agent tab; do not edit)",
                    "# the group whose accounts the agent's orders go to (each member is a seat); account<TAB>- is None", "group\t" + gid });
                return null;
            }
            catch (Exception ex) { return ex.Message; }
        }

        private static bool PlainName(string nm)
        {
            if (string.IsNullOrEmpty(nm) || nm.Length > 200 || nm.Trim() != nm) return false;
            foreach (char ch in nm) if (ch < 0x20 || ch == 0x7f || ch == '"' || ch == '\\') return false;
            return true;
        }

        // ---------------------------------------------------------- the day file (agent-<id>-day.txt; 18:00 ET)
        // "session<TAB>yyyy-MM-dd", then one line per trade ("trade<TAB><tag><TAB>open" or the realized dollars, as bot-day.txt),
        // plus (lead's default) "plan<TAB><id>" for each plan id used today, so a restart still refuses an id twice, and
        // "entry<TAB><tag><TAB><expiry UTC ms>" for each entry placed, so its expiry still fires after a restart. A file that
        // cannot be read stands the agent down for this run and is never written over.
        // 0.5.7: "#tagplan<TAB><tag><TAB><plan id>" for each entry of today's trades, its working entries and the trades carried
        // over, so its order messages still carry "planId" after a restart. It starts with "#" so a ChartBridge before 0.5.7
        // reads it as a comment (any other line it does not know stands the agent down); a malformed one is skipped, never fatal.
        private static string SessionOf(DateTime et) { return (et.Hour >= 18 ? et.Date.AddDays(1) : et.Date).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture); }

        private void LoadDay()
        {
            string today = SessionOf(NowEt()), fileSession = null, broken = null, held = null, damaged = null, io = null;
            Dictionary<string, double> trades = new Dictionary<string, double>(), expiry = new Dictionary<string, double>();
            Dictionary<string, int[]> spans = new Dictionary<string, int[]>();
            HashSet<string> ids = new HashSet<string>(), carriedTags = new HashSet<string>();
            Dictionary<string, string> tagPlans = new Dictionary<string, string>(), tagSeats = new Dictionary<string, string>();
            // 0.6.3 (audit C3): every line that reads is kept; a line that does not (a power cut's NULs or half line) is counted, never
            // a reason to forget the day. first: the file itself (a later line wins, as appended); else its last good copy, which
            // only fills what the file lacks.
            Func<string[], bool, int> read = (all, first) =>
            {
                int bad = 0;
                foreach (string raw in all)
                {
                    if (raw.IndexOf('\0') >= 0) { if (raw.Trim('\0', ' ', '\t', '\r').Length > 0 || first) bad++; continue; }
                    string line = raw.Trim();
                    string seatTag, seatAcct;
                    if (ReadSeatLine(line, out seatTag, out seatAcct)) { if (first || !tagSeats.ContainsKey(seatTag)) tagSeats[seatTag] = seatAcct; continue; }   // 0.6.0: #seat<TAB><tag><TAB><account>
                    string tagPlanId, tagOfPlan;
                    if (ReadTagPlan(line, out tagOfPlan, out tagPlanId)) { if (first || !tagPlans.ContainsKey(tagOfPlan)) tagPlans[tagOfPlan] = tagPlanId; continue; }
                    if (line.Length == 0 || line.StartsWith("#")) continue;
                    string[] p = line.Split('\t');
                    double v;
                    if (p.Length == 2 && p[0] == "session" && Regex.IsMatch(p[1], "^[0-9]{4}-[0-9]{2}-[0-9]{2}$")) { if (first || fileSession == null) fileSession = p[1]; }
                    else if (p.Length == 3 && p[0] == "trade" && Regex.IsMatch(p[1], "^[0-9a-f]{8}(?:-[0-9]{1,4}){0,1}$") && p[2] == "open") { if (first || !trades.ContainsKey(p[1])) trades[p[1]] = double.NaN; }
                    else if (p.Length == 3 && p[0] == "trade" && Regex.IsMatch(p[1], "^[0-9a-f]{8}(?:-[0-9]{1,4}){0,1}$") && double.TryParse(p[2], NumberStyles.Float, CultureInfo.InvariantCulture, out v) && !double.IsNaN(v) && !double.IsInfinity(v)) { if (first || !trades.ContainsKey(p[1])) trades[p[1]] = v; }
                    else if (p.Length == 2 && p[0] == "plan" && p[1].Length >= 1 && p[1].Length <= 40) ids.Add(p[1]);
                    else if (p.Length == 3 && p[0] == "entry" && Regex.IsMatch(p[1], "^[0-9a-f]{8}$") && Regex.IsMatch(p[2], "^[0-9]{1,15}$")) { if (first || !expiry.ContainsKey(p[1])) expiry[p[1]] = double.Parse(p[2], CultureInfo.InvariantCulture); }
                    else if (p.Length == 2 && p[0] == "standDown" && p[1].Length > 0) { if (first || held == null) held = p[1]; }
                    else if (p.Length == 2 && p[0] == "carried" && Regex.IsMatch(p[1], "^[0-9a-f]{8}(?:-[0-9]{1,4}){0,1}$")) carriedTags.Add(p[1]);   // 0.5.2 review
                    else if (p.Length == 4 && p[0] == "span" && Regex.IsMatch(p[1], "^[0-9a-f]{8}(?:-[0-9]{1,4}){0,1}$") && Regex.IsMatch(p[2], "^[0-9]{1,6}$") && Regex.IsMatch(p[3], "^[0-9]{1,6}$"))
                    { if (first || !spans.ContainsKey(p[1])) spans[p[1]] = new[] { int.Parse(p[2], CultureInfo.InvariantCulture), int.Parse(p[3], CultureInfo.InvariantCulture) }; }
                    else bad++;
                }
                return bad;
            };
            try
            {
                if (File.Exists(DayFile))
                {
                    int bad = read(ReadAll(DayFile), true);
                    bool noSession = fileSession == null;
                    if (bad > 0 || noSession)
                    {
                        string[] b = ChartBridgeFiles.ReadBackup(DayFile);
                        bool fromBackup = b != null && read(b, false) >= 0 && b.Length > 0;
                        if (fileSession == null) fileSession = today;   // no session line anywhere: counted as today's (never forgotten)
                        damaged = "agent-" + Id + "-day.txt has " + (bad > 0 ? bad + " line" + (bad == 1 ? "" : "s") + " ChartBridge could not read" : "no session line") +
                                  " (a power cut?): the trades, losses and plan ids from the lines that read" + (fromBackup ? " and from its last good copy (agent-" + Id + "-day.txt.bak)" : "") +
                                  " are kept and the file is written again from them";
                    }
                }
            }
            catch (IOException ex) { broken = "agent-" + Id + "-day.txt could not be read"; io = IoWords("agent-" + Id + "-day.txt", Id, ex.Message); }
            catch (Exception ex) { broken = "agent-" + Id + "-day.txt could not be read (" + ex.Message + ")"; }
            // Lead's default (review A-N3, A-S4): an entry line whose order is no longer listed is dropped; an open trade of an
            // earlier session is dropped (it counts only in its own session; a position it left keeps its legs, and the flat hours
            // and the owner rules still see it by those legs).
            HashSet<string> listed = ListedTags(tagSeats.Values);
            int stale = 0;
            lock (Sync)
            {
                session = today;
                Trades.Clear(); PlanIds.Clear(); Expiry.Clear(); Spans.Clear(); EntrySeen.Clear(); lossStandDown = null;
                dayRepaired = false; dayBroken = null;
                if (io != null) dayBroken = io;
                else if (broken != null) dayBroken = broken + ": no new entries for agent " + Id + " this run (delete it to start the day over)";
                else
                {
                    // 0.6.3 (audit C3): a damaged file keeps today's counts (never reset) and stands the agent down for this run only
                    if (damaged != null) { dayBroken = damaged + ": no new entries for agent " + Id + " this run: check today's trades in NinjaTrader (the next start goes on with these counts)"; dayRepaired = true; }
                    foreach (KeyValuePair<string, double> kv in expiry) if (listed.Contains(kv.Key)) Expiry[kv.Key] = kv.Value;
                    if (fileSession == today)
                    {
                        foreach (KeyValuePair<string, double> kv in trades) Trades[kv.Key] = kv.Value;
                        foreach (KeyValuePair<string, int[]> kv in spans) if (trades.ContainsKey(kv.Key)) Spans[kv.Key] = kv.Value;
                        foreach (string id in ids) PlanIds.Add(id);
                        lossStandDown = held;
                    }
                    else stale = trades.Count(kv => double.IsNaN(kv.Value));
                }
                // 0.5.2 review: whatever position a trade of an earlier session left is flattened (the flat hours below), the market open:
                // the records carried over at a roll (the file's carried lines), and an open record of an earlier session dropped now
                Carried.Clear();
                if (broken == null)
                {
                    foreach (KeyValuePair<string, string> kv in tagPlans) PlanOfTag[kv.Key] = kv.Value;
                    foreach (string t in carriedTags) Carried.Add(t);
                    if (fileSession != today) foreach (KeyValuePair<string, double> kv in trades) if (double.IsNaN(kv.Value)) Carried.Add(kv.Key);
                    // 0.6.0: each group seat's tag, and a seat that holds something of its own is followed again (restart recovery),
                    // also one no longer in the group (it stays the agent's until flat)
                    HashSet<string> kept = new HashSet<string>(Trades.Where(kv => double.IsNaN(kv.Value)).Select(kv => kv.Key).Concat(Expiry.Keys).Concat(Carried).Select(k => k.Length > 8 ? k.Substring(0, 8) : k));
                    foreach (KeyValuePair<string, string> kv in tagSeats)
                    {
                        SeatOfTag[kv.Key] = kv.Value;
                        if ((kept.Contains(kv.Key) || listed.Contains(kv.Key)) && !Seats.ContainsKey(kv.Value)) Seats[kv.Value] = new Seat(this, kv.Value);
                    }
                }
            }
            if (broken == null) foreach (KeyValuePair<string, string> kv in tagPlans) ChartBridgeAgents.NotePlan(kv.Key, kv.Value);
            if (io != null) { if (!IoPending("day")) Log(io); }
            else if (broken != null) Log(broken + ": no new entries for agent " + Id + " this run (delete it to start the day over)");
            IoState("day", io != null, null);
            if (damaged != null)
            {
                string said;
                lock (Sync) said = dayBroken;
                try { File.Copy(DayFile, DayFile + ".unreadable", true); } catch (Exception) { }   // the file as it was, for a look
                SaveDay();   // written again from what was kept, so the next start reads it whole
                ChartBridgeOrders.AgentAlarm(said);
            }
            if (stale > 0) Log("agent-" + Id + "-day.txt: " + stale + " open trade(s) from the session of " + fileSession + " dropped (a record counts only in its own session)");
        }

        // 0.5.7: the day file's "#tagplan<TAB><tag><TAB><plan id>" lines (a comment to a ChartBridge before 0.5.7).
        internal const string TagPlanPrefix = "#tagplan\t";
        private static readonly Regex EntryTagRx = new Regex("^[0-9a-f]{8}$");
        // A plan id that reads back the same: 1 to 40 characters, no tab or line break, nothing a line's trim would cut.
        private static bool TagPlanWritable(string id)
        {
            return id != null && id.Length >= 1 && id.Length <= 40 && id == id.Trim() && id.IndexOfAny(new[] { '\t', '\r', '\n' }) < 0;
        }
        private static bool ReadTagPlan(string line, out string tag, out string planId)
        {
            tag = null; planId = null;
            if (!line.StartsWith(TagPlanPrefix, StringComparison.Ordinal)) return false;
            string[] p = line.Substring(TagPlanPrefix.Length).Split('\t');
            if (p.Length != 2 || !EntryTagRx.IsMatch(p[0]) || !TagPlanWritable(p[1])) return false;   // malformed: read as a comment
            tag = p[0]; planId = p[1];
            return true;
        }

        // The tags of every order listed on this agent's accounts (entry lines and stale records are checked against them). 0.6.0:
        // every seat, and (more) the accounts the day file names for its seats.
        private HashSet<string> ListedTags() { return ListedTags(null); }
        private HashSet<string> ListedTags(IEnumerable<string> more)
        {
            HashSet<string> tags = new HashSet<string>();
            HashSet<string> names;
            lock (Sync) { names = new HashSet<string>(seatNames.Concat(Seats.Keys)); }
            if (more != null) foreach (string m in more) names.Add(m);
            foreach (string n in names)
            {
                Account a = FindAccount(n);
                if (a == null) continue;
                lock (a.Orders) foreach (Order o in a.Orders) { string t = ChartBridgeAgents.TagOf(o.Name); if (t != null) tags.Add(t); }
            }
            return tags;
        }

        // 0.6.0: the day file's "#seat<TAB><tag><TAB><account>" lines (a comment to a ChartBridge before 0.6.0): a group seat's entry tag.
        internal const string SeatPrefix = "#seat\t";
        private static bool ReadSeatLine(string line, out string tag, out string acct)
        {
            tag = null; acct = null;
            if (!line.StartsWith(SeatPrefix, StringComparison.Ordinal)) return false;
            string[] p = line.Substring(SeatPrefix.Length).Split('\t');
            if (p.Length != 2 || !EntryTagRx.IsMatch(p[0]) || !PlainName(p[1])) return false;   // malformed: read as a comment
            tag = p[0]; acct = p[1];
            return true;
        }

        // The day file is appended to and written whole under one lock (review B), so an appended plan id is never lost to a whole
        // write made from an older copy. A Windows sharing violation (a virus scanner, a backup) is tried again briefly, then logged.
        private readonly object DayFileLock = new object();
        private const int DayTries = 3, DayRetryMs = 25;

        private static void TryIo(Action write)
        {
            for (int i = 1; ; i++)
            {
                try { write(); return; }
                catch (IOException) { if (i >= DayTries) throw; }
                Thread.Sleep(DayRetryMs);
            }
        }

        private void AppendDay(string line)
        {
            lock (DayFileLock)
            {
                try
                {
                    if (!File.Exists(DayFile)) { SaveDay(); return; }   // the whole file (with this id) the first time
                    TryIo(delegate { ChartBridgeFiles.Append(DayFile, line + Environment.NewLine); });   // 0.6.3 (audit C3): written through, flushed
                }
                catch (Exception ex) { Log("agent-" + Id + "-day.txt could not be appended to (" + ex.Message + "); a restart would forget a plan id"); }
            }
        }

        private void SaveDay()
        {
            lock (DayFileLock) SaveDayLocked();
        }

        private void SaveDayLocked()
        {
            List<string> lines = new List<string> { "# ChartBridge day for agent " + Id + " (written by ChartBridge; do not edit)", "# session, its trades (tag and open or realized dollars), plan ids used, entries and their expiry, the plan of each entry (#tagplan)" };
            lock (Sync)
            {
                if (dayBroken != null && !dayRepaired) return;   // never written over a file that could not be read (0.6.3: one kept from its lines is)
                lines.Add("session\t" + session);
                foreach (KeyValuePair<string, double> kv in Trades)
                    lines.Add("trade\t" + kv.Key + "\t" + (double.IsNaN(kv.Value) ? "open" : kv.Value.ToString("0.##", CultureInfo.InvariantCulture)));
                foreach (string id in PlanIds) lines.Add("plan\t" + id);
                foreach (KeyValuePair<string, double> kv in Expiry) lines.Add("entry\t" + kv.Key + "\t" + kv.Value.ToString("0", CultureInfo.InvariantCulture));
                foreach (KeyValuePair<string, int[]> kv in Spans) if (Trades.ContainsKey(kv.Key)) lines.Add("span\t" + kv.Key + "\t" + kv.Value[0].ToString(CultureInfo.InvariantCulture) + "\t" + kv.Value[1].ToString(CultureInfo.InvariantCulture));
                if (lossStandDown != null) lines.Add("standDown\t" + lossStandDown);
                foreach (string t in Carried) lines.Add("carried\t" + t);   // 0.5.2 review: a trade of an earlier session, until flat
                // 0.5.7: the plan of each entry still of today (its trade, its working entry, a trade carried over)
                HashSet<string> keep = new HashSet<string>(Trades.Keys.Concat(Expiry.Keys).Concat(Carried).Select(k => k.Length > 8 ? k.Substring(0, 8) : k));
                foreach (KeyValuePair<string, string> kv in PlanOfTag) if (keep.Contains(kv.Key) && TagPlanWritable(kv.Value)) lines.Add(TagPlanPrefix + kv.Key + "\t" + kv.Value);
                foreach (KeyValuePair<string, string> kv in SeatOfTag) if (keep.Contains(kv.Key) && PlainName(kv.Value)) lines.Add(SeatPrefix + kv.Key + "\t" + kv.Value);   // 0.6.0: each group seat's tag
            }
            try { TryIo(delegate { WriteWhole(DayFile, lines); }); }
            catch (Exception ex) { Log("agent-" + Id + "-day.txt could not be saved (" + ex.Message + "); a restart would forget today's trades and plan ids"); }
        }

        // A new trading day at 18:00 ET: trades, losses and plan ids start over. A trade still open goes on into the new day.
        private void RollDay()
        {
            string today = SessionOf(NowEt());
            lock (Sync) { if (session == today) return; }
            HashSet<string> listed = ListedTags();
            lock (Sync)
            {
                if (session == today) return;
                foreach (string k in Expiry.Keys.ToList()) if (!listed.Contains(k)) Expiry.Remove(k);   // review A-N3
                session = today;
                // a trade the ledger still follows goes on into the new day; any other open record is dropped (review A-S4)
                HashSet<string> followed = OpenTagsLocked();   // 0.6.0: every seat's open trade
                List<KeyValuePair<string, double>> open = Trades.Where(kv => double.IsNaN(kv.Value) && followed.Contains(kv.Key)).ToList();
                foreach (KeyValuePair<string, double> kv in open) Carried.Add(kv.Key);   // 0.5.2 review: a trade of the session before: flattened (its flat time has passed); saved below
                Trades.Clear();
                foreach (KeyValuePair<string, double> kv in open) Trades[kv.Key] = kv.Value;
                foreach (string k in Spans.Keys.ToList()) if (!Trades.ContainsKey(k)) Spans.Remove(k);
                PlanIds.Clear();
                ExcessByTag.Clear();
                lossStandDown = null;
                foreach (string k in Proposals.Where(kv => kv.Value.State != "open" && kv.Value.State != "accepting").Select(kv => kv.Key).ToList()) Proposals.Remove(k);   // review B: pruned at the roll
            }
            SaveDay();
            AgentLog("a new trading day: trades, losses and plan ids start over");
            Notify();
        }

        // 0.6.0 (Q3 a): a group's plan counts once, for maxTrades and maxLosses: its seats' trades (tags with a #seat line) are one
        // trade, a loss when their sum is below 0 once every one of them has closed. Every other trade counts by itself, as before.
        private Dictionary<string, List<double>> UnitsLocked()
        {
            Dictionary<string, List<double>> u = new Dictionary<string, List<double>>();
            foreach (KeyValuePair<string, double> kv in Trades)
            {
                string t8 = kv.Key.Length > 8 ? kv.Key.Substring(0, 8) : kv.Key, pid;
                string key = SeatOfTag.ContainsKey(t8) && PlanOfTag.TryGetValue(t8, out pid) ? "plan\t" + pid : kv.Key;
                List<double> l;
                if (!u.TryGetValue(key, out l)) u[key] = l = new List<double>();
                l.Add(kv.Value);
            }
            return u;
        }
        private int TradesLocked() { return UnitsLocked().Count; }
        private int LossesLocked() { return UnitsLocked().Values.Count(v => v.All(x => !double.IsNaN(x)) && v.Sum() < 0); }
        // The open trade of every seat. Under Sync.
        private HashSet<string> OpenTagsLocked() { return new HashSet<string>(Seats.Values.Where(x => x.openTag != null).Select(x => x.openTag)); }

        // Why no new entry may go now (files, losses), or null. Under Sync.
        private string StandDownLocked()
        {
            if (dayBroken != null) return dayBroken;
            if (rulesBroken != null) return rulesBroken;
            if (accountBroken != null) return accountBroken;
            if (groupId == null && ChartBridgeBranches.IsNone(account)) return "agent " + Id + "'s account is None: no new entries until an account is chosen on the Agent tab";
            int losses = LossesLocked();
            if (lossStandDown == null && rules.MaxLosses > 0 && losses >= rules.MaxLosses) lossStandDown = losses + " losing trades today (maxLosses " + rules.MaxLosses + "): no new entries for agent " + Id + " until 18:00 ET";
            return lossStandDown;   // never lifted by a rules change; the 18:00 ET roll clears it (lead's default)
        }

        private string StandDown() { string sd; lock (Sync) sd = StandDownLocked(); return sd ?? LatchProblem() ?? AccountConflict(); }   // 0.6.2: a stand-down on its group (the backstop cancels its entries)

        // A file that cannot be read (check 2), or null. Under Sync.
        private string FilesBrokenLocked() { return dayBroken ?? rulesBroken ?? accountBroken; }

        // The account is not usable by this agent: the bot's, the copier's leader or a follower (on or off), whether or not the bot
        // and the copier are switched on (lead's default), or another agent's. On such a clash the agent stands down and the other user of the account is left as it was (lead's
        // default). 0.5.7: None clashes with nobody.
        // 0.6.0: every seat it trades (a clash on any seat stands the whole agent down, as for its one account).
        public string AccountConflict()
        {
            foreach (string seat in SeatNames()) { string w = AccountConflict(seat); if (w != null) return w; }
            return null;
        }

        private string AccountConflict(string acct)
        {
            string bot = ChartBridgeAgents.BotAccountForAgents();   // on or off (lead's default); never a file read here
            if (ChartBridgeBranches.IsNone(acct)) return null;
            if (bot == null) return "bot-account.txt cannot be read or understood, so ChartBridge cannot tell the bot's account: agent " + Id + " trades nothing until it is fixed";
            if (string.Equals(acct, bot, StringComparison.OrdinalIgnoreCase))
                return acct + " is also the bot's account: choose an account for agent " + Id + " on the Agent tab (an agent never shares an account)";
            string cw = ChartBridgeAgents.CopierUses(acct);
            if (cw != null) return cw.Replace(" is the copier's", " is also the copier's").Replace(" is a copier follower", " is also a copier follower") + ": choose an account for agent " + Id + " on the Agent tab (an agent never shares an account)";
            bool mine = Chosen;
            foreach (ChartBridgeAgent other in ChartBridgeAgents.All())
                if (other != this && other.SeatNames().Any(x => string.Equals(x, acct, StringComparison.OrdinalIgnoreCase)) && (other.Chosen || !mine))
                    return acct + " is also agent " + other.Id + "'s account: choose an account for agent " + Id + " on the Agent tab (an agent never shares an account)";
            return null;
        }

        // ---------------------------------------------------------- strict messages (gate 8, the agent's form)
        // One flat JSON object. Values: a plain string (no backslash, no control character, at most maxLen characters), a plain
        // number (no sign, no exponent, no leading zero), true, false or null. Any nested object or list, a key twice, an escape or
        // trailing text is refused. The caller allows each key and checks each value (strings at most 200, note.text 1,000).
        public class Val { public char K; public string T; }   // K: 's' string, 'n' whole number, 'd' decimal, 'b' bool, 'z' null

        public static Dictionary<string, Val> Parse(string text, int maxLen, out string why)
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
                while (i < n && text[i] != '"') { char c = text[i]; if (c < 0x20 || c == 0x7f || i - start >= maxLen) return null; i++; }
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
                    if (string.IsNullOrEmpty(key) || key.Length > 40) { why = "a key is not a plain string"; return null; }
                    ws();
                    if (i >= n || text[i] != ':') { why = "malformed"; return null; }
                    i++; ws();
                    Val v = new Val();
                    if (i < n && text[i] == '"') { v.K = 's'; v.T = str(); if (v.T == null) { why = key + " is not a plain string of at most " + maxLen + " characters"; return null; } }
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

        public static string UnknownKey(Dictionary<string, Val> d, string[] allowed)
        {
            foreach (string k in d.Keys) if (Array.IndexOf(allowed, k) < 0) return k;
            return null;
        }

        public static string S(Dictionary<string, Val> d, string k) { Val v; return d != null && d.TryGetValue(k, out v) && v.K == 's' ? v.T : null; }

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

        // A plain number (whole or decimal): 1 ok, 0 absent, -1 anything else.
        private static int Number(Dictionary<string, Val> d, string k, out double value, out string raw)
        {
            value = 0; raw = null;
            Val v;
            if (!d.TryGetValue(k, out v)) return 0;
            if (v.K != 'n' && v.K != 'd') return -1;
            raw = v.T;
            value = double.Parse(v.T, CultureInfo.InvariantCulture);
            return 1;
        }

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

        private static readonly Dictionary<string, string[]> AgentKeys = new Dictionary<string, string[]>
        {
            { "agentHello", new[] { "type", "name", "build" } },
            { "beat", new[] { "type" } },
            { "subscribe", new[] { "type", "root", "days", "tickHours", "sub" } },
            { "plan", new[] { "type", "id", "root", "side", "kind", "price", "limitPrice", "qty", "stopTicks", "targetTicks", "expireSec", "riskDollars", "setup", "reason", "confidence", "seatsRev", "sizes" } },   // 0.6.0: seatsRev, sizes
            { "skip", new[] { "type", "id", "setup", "reason" } },
            { "withdraw", new[] { "type", "id", "reason" } },
            { "note", new[] { "type", "kind", "text" } },
            { "flatten", new[] { "type", "account" } },   // 0.6.0: account (one seat); without it, every seat
            { "standDown", new[] { "type", "group", "kind", "why" } },   // 0.6.2: raise only (there is no clear from the agent)
        };

        // ---------------------------------------------------------- the connection
        public bool Busy() { lock (Sync) return client != null || claimed; }
        public bool Claim() { lock (Sync) { if (client != null || claimed) return false; claimed = true; return true; } }
        public void Unclaim() { lock (Sync) claimed = false; }

        public async Task Run(WebSocket ws, CancellationToken token)
        {
            ChartBridgeClient c = new ChartBridgeClient(ws, clientId);
            if (!Attach(c)) { Unclaim(); c.Close(); return; }
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
                        if (size > ChartBridgeAgents.MaxMessageBytes) break;
                        bytes.Write(buf, 0, r.Count);
                    } while (!r.EndOfMessage);
                    if (r.MessageType == WebSocketMessageType.Close || size > ChartBridgeAgents.MaxMessageBytes) break;   // over 64 KB closes the agent's connection
                    OnMessage(c, Encoding.UTF8.GetString(bytes.ToArray()));
                }
            }
            catch (Exception ex) { Log("agent " + Id + " connection ended: " + ex.GetType().Name + ": " + ex.Message); }
            finally
            {
                try { Lose(c, "agent " + Id + " disconnected", false); }
                catch (Exception ex) { Log("agent " + Id + " disconnect handling error: " + ex.GetType().Name + ": " + ex.Message); }
                c.Close();
                try { await sending; } catch (Exception) { }
            }
        }

        // Takes this agent's one slot for the connection (Run, after the upgrade; the harness with a stand-in client).
        public bool Attach(ChartBridgeClient c)
        {
            lock (Sync)
            {
                if (c == null || client != null) return false;
                client = c; claimed = false; helloed = false; welcomeSent = false; name = null; build = null; lastMsgMs = Now(); attachedMs = lastMsgMs; Actions.Clear(); lastStateSent = null; lastWelcomeRules = null;
            }
            Log("agent " + Id + " connected; it is told nothing until its agentHello");
            Notify();
            return true;
        }

        public ChartBridgeClient SubscribedClient() { ChartBridgeClient c = Volatile.Read(ref client); return c != null && helloed && c.Root != null ? c : null; }

        // The agent is gone (heartbeat lost, its connection closed): its unfilled entries are cancelled, its open proposals expire
        // as "not answered", every stop and target stays, and the pages are told. The flat time still runs.
        private void Lose(ChartBridgeClient c, string why, bool heartbeat)
        {
            List<Proposal> expired;
            lock (Sync)
            {
                if (client != c) return;
                client = null; helloed = false; noClientSinceMs = Now();
                if (heartbeat) nHeartbeatLost++;
                expired = ExpireOpenLocked("not answered");
            }
            if (heartbeat) c.Close();
            int n = CancelUnfilled(why);
            foreach (Proposal p in expired) { ToPages(ProposalJson(p)); AgentLog("proposal " + p.P.Id + " not answered (" + why + ")"); }
            string text = "Agent " + Id + ": " + why + ": " + (n > 0 ? n + " unfilled entr" + (n == 1 ? "y" : "ies") + " cancelled" : "no unfilled entry to cancel") +
                          "; any position keeps its stop and target; its flat time still runs";
            Log(text);
            AgentLog(text);
            ToPages(StatusJson("warn", text));
            Notify();
        }

        // Every agent message: strict keys, then by type. Any message counts for the heartbeat, even one that is refused.
        public void OnMessage(ChartBridgeClient c, string text)
        {
            bool hello;
            lock (Sync) { if (c != client) return; lastMsgMs = Now(); hello = helloed; }
            string why;
            Dictionary<string, Val> d = Parse(text, 1000, out why);
            string type = d != null ? S(d, "type") : null, id = d != null ? S(d, "id") : null;
            // Every message but a beat counts toward the 10 a second first, before anything else is done with it (review B-S1).
            if (type != "beat" && !ChartBridgeAgents.RateOk(Actions)) { RateRefused(id); return; }
            // Before agentHello nothing else is read (lead's default): never shown to the pages, never logged as a plan.
            if (!hello && type != "agentHello") { ToAgent(Reject(null, "send agentHello first")); return; }
            if (d == null) { ToAgent(Reject(null, "ChartBridge refused a message: " + why)); RefusedPlanIfPlan(text, why); return; }
            string[] keys;
            if (type == null || !AgentKeys.TryGetValue(type, out keys)) { ToAgent(Reject(id, "unknown agent message type " + (type ?? "(none)"))); return; }
            string odd = UnknownKey(d, keys);
            if (odd == null)
                foreach (KeyValuePair<string, Val> kv in d)
                    if (kv.Value.K == 's' && kv.Value.T.Length > 200 && !(type == "note" && kv.Key == "text")) { odd = null; why = kv.Key + " is longer than 200 characters"; break; }
            if (odd != null) why = "unknown key \"" + odd + "\" in " + type;
            if (why != null)
            {
                ToAgent(Reject(id, why));
                if (type == "plan") RefusedPlan(d, why);
                return;
            }
            if (type == "agentHello") { OnHello(d); return; }
            if (type == "beat") return;
            if (type == "plan") OnPlan(d);
            else if (type == "skip") OnSkip(d);
            else if (type == "withdraw") OnWithdraw(d);
            else if (type == "note") OnNote(d);
            else if (type == "subscribe") OnSubscribe(c, d);
            else if (type == "flatten") OnAgentFlatten(d);
            else if (type == "standDown") OnStandDown(d);
        }

        // Over the rate: one reject a second at most, nothing else (no plan shown, no id used, no file written).
        private double lastRateRejectMs = -1e18;
        private void RateRefused(string id)
        {
            double now = Now();
            bool say;
            lock (Sync) { say = now - lastRateRejectMs >= 1000; if (say) lastRateRejectMs = now; }
            if (say) ToAgent(Reject(id, "too many agent messages (more than " + ChartBridgeAgents.MaxActionsPerSecond + " a second): refused, nothing done"));
        }

        private void RefusedPlanIfPlan(string text, string why)
        {
            if (text == null || !Regex.IsMatch(text, "\"type\"\\s*:\\s*\"plan\"")) return;
            Plan p = new Plan { Action = "plan", At = Now(), Result = "refused: " + why };
            lock (Sync) { nPlans++; nRefused++; }
            ShowPlan(p);
            AgentLog("plan (unreadable) refused: " + why);
        }

        private void RefusedPlan(Dictionary<string, Val> d, string why)
        {
            Plan p = ReadPlanLoose(d);
            p.Result = "refused: " + why;
            bool fresh = UseId(p.Id);
            lock (Sync) { nPlans++; nRefused++; }
            ShowPlan(p, fresh);
            AgentLog("plan " + (p.Id ?? "(no id)") + " refused: " + why);
        }

        private void OnHello(Dictionary<string, Val> d)
        {
            string nm = S(d, "name"), bd = S(d, "build");
            if (nm == null || nm.Length < 1 || nm.Length > 40) { ToAgent(Reject(null, "agentHello needs a name of 1 to 40 characters")); return; }
            if (bd == null || bd.Length < 1 || bd.Length > 40) { ToAgent(Reject(null, "agentHello needs a build of 1 to 40 characters")); return; }
            // 0.6.2 (fix round 1): the build names the hero a stand-down holds (agent-standdowns.txt), so it must read back the same: no
            // space at either end (a build cut at 40 characters on the space before its stamp is refused), no tab or control character
            if (!ChartBridgeAgents.SdText(bd, 40)) { string w = "agentHello needs a build of 1 to 40 characters with no space at either end (send the build name without a cut stamp)"; ToAgent(Reject(null, w)); Log("agent " + Id + " hello refused: " + w); AgentLog("hello refused: " + w); return; }
            // and one build for the whole connection: a second hello with another build is refused (a stand-down could not follow it)
            string had;
            lock (Sync) had = helloed ? build : null;
            if (had != null && had != bd) { string w = "agentHello cannot change the build on this connection (it said build " + had + "): reconnect to run another build"; ToAgent(Reject(null, w)); Log("agent " + Id + " hello refused: " + w); AgentLog("hello refused: " + w); return; }
            lock (Sync) { helloed = true; welcomeSent = false; snapshotSent = false; name = nm; build = bd; }   // a second hello too: its welcome first
            List<string> served = ServedRoots();   // welcome.instruments and the snapshot cover exactly these roots (section 10)
            ToAgent(WelcomeJson(served));
            lock (Sync) welcomeSent = true;   // only now may agentState go (review D4, E3: helloed stays set for the mute check and ticks)
            SendState(true);
            Snapshot(served);
            lock (Sync) snapshotSent = true;   // 0.5.8: accountState goes after the snapshot
            SendAccountState(true);
            Log("agent " + Id + " (\"" + nm + "\", build " + bd + ") said hello");
            AgentLog("hello: \"" + nm + "\", build " + bd);
            Notify();
        }

        // Contract addition (after agentState, at every hello): one position per root of the agent (flat included) and one order per
        // working order of its own, so a runner that reconnects sees fills it missed.
        // 0.6.0: one position per (seat, root) and the working orders of every seat (one account: as before).
        private void Snapshot(List<string> served)
        {
            List<string> accts = AllSeats().Select(x => x.Name).ToList();
            if (accts.Count == 0) accts.Add(Account);   // None: one flat position per root, as before
            List<Instrument> insts = served.Select(x => ChartBridgeServer.InstrumentFor(x)).Where(x => x != null).ToList();
            foreach (string acct in accts)
            {
                Account a = FindAccount(acct);
                foreach (string root in served)
                {
                    Instrument inst = ChartBridgeServer.InstrumentFor(root);
                    if (inst == null) continue;
                    int q = a != null ? ChartBridgeOrders.AgentListed(a, inst) : 0;
                    double avg = 0;
                    if (a != null && q != 0) lock (a.Positions) { Position ps = a.Positions.FirstOrDefault(x => x.Instrument == inst || (x.Instrument != null && x.Instrument.FullName == inst.FullName)); if (ps != null) avg = ps.AveragePrice; }
                    ToAgent("{\"type\":\"position\",\"account\":" + CbJson.Str(acct) + ",\"root\":" + CbJson.Str(root) + ",\"qty\":" + q.ToString(CultureInfo.InvariantCulture) +
                            ",\"avgPrice\":" + (q != 0 ? CbJson.Num(avg) : "null") + "}");
                }
            }
            foreach (string acct in accts)
            {
                Account a = FindAccount(acct);
                if (a == null) continue;
                List<Order> orders;
                lock (a.Orders) orders = a.Orders.ToList();
                foreach (Order o in orders)
                    if (IsMine(o) && ChartBridgeOrders.IsWorking(o.OrderState) && insts.Any(i => i == o.Instrument || (o.Instrument != null && i.FullName == o.Instrument.FullName)))
                        ToAgent(ChartBridgeOrders.AgentOrderJson(o));
            }
            // the end of the snapshot (section 10): a runner without it is not ready
            ToAgent("{\"type\":\"snapshot\",\"roots\":[" + string.Join(",", served.Select(x => CbJson.Str(x))) + "]}");
        }

        // The agent's roots ChartBridge serves now (NinjaTrader connected, the contract found), in its rules' order.
        private List<string> ServedRoots() { return RulesNow().Roots.Where(x => ChartBridgeServer.InstrumentFor(x) != null).ToList(); }

        // subscribe: answered as for a page (history, ticks, ready, then live tick for that root). Strict values (lead's default:
        // root required; days, tickHours and sub whole numbers, the page's defaults when left out).
        private void OnSubscribe(ChartBridgeClient c, Dictionary<string, Val> d)
        {
            string root = (S(d, "root") ?? "").ToUpperInvariant();
            int days, tickHours, sub;
            int hd = Whole(d, "days", out days), ht = Whole(d, "tickHours", out tickHours), hs = Whole(d, "sub", out sub);
            if (root.Length == 0) { ToAgent(Reject(null, "subscribe needs a root")); return; }
            if (hd < 0 || ht < 0 || hs < 0) { ToAgent(Reject(null, "days, tickHours and sub must be whole numbers")); return; }
            if (ChartBridgeServer.ServedInstrumentFor(root) == null) { ToAgent(Reject(null, root + " is not served by ChartBridge")); return; }
            ChartBridgeServer.AgentSubscribe(c, root, hd == 1 ? Math.Max(1, Math.Min(60, days)) : ChartBridgeConfig.DefaultDays,
                ht == 1 ? Math.Max(0, Math.Min(48, tickHours)) : ChartBridgeConfig.DefaultTickHours, hs == 1 ? sub.ToString(CultureInfo.InvariantCulture) : null);
        }

        // ---------------------------------------------------------- plans (section 4: checks 1 to 12, in that order)
        private Plan ReadPlanLoose(Dictionary<string, Val> d)
        {
            Plan p = new Plan { Action = "plan", At = Now(), Id = S(d, "id"), Root = S(d, "root"), Side = S(d, "side"), Kind = S(d, "kind"), Setup = S(d, "setup"), Reason = S(d, "reason") };
            double x; string raw; int w;
            if (Number(d, "price", out x, out raw) == 1) { p.Price = x; p.PriceText = raw; }
            if (Number(d, "limitPrice", out x, out raw) == 1) { p.Limit = x; p.LimitText = raw; }
            if (Number(d, "riskDollars", out x, out raw) == 1) { p.Risk = x; p.RiskText = raw; }
            if (Number(d, "confidence", out x, out raw) == 1) { p.Conf = x; p.ConfText = raw; }
            if (Whole(d, "qty", out w) == 1) { p.Qty = w; p.HasQty = true; }
            if (Whole(d, "stopTicks", out w) == 1) { p.StopTicks = w; p.HasStop = true; }
            if (Whole(d, "targetTicks", out w) == 1) { p.TargetTicks = w; p.HasTarget = true; }
            if (Whole(d, "expireSec", out w) == 1) { p.ExpireSec = w; p.HasExpire = true; }
            if (p.HasExpire) p.ExpiresAt = p.At + p.ExpireSec * 1000.0;
            // 0.6.0: sizes "5,3,4" (whole numbers in seat order) and seatsRev (a whole number)
            if (d.ContainsKey("sizes"))
            {
                string st = S(d, "sizes");
                if (st != null && SizesRx.IsMatch(st)) { p.SizesText = st; p.Sizes = st.Split(',').Select(t => int.Parse(t, CultureInfo.InvariantCulture)).ToArray(); }
                else p.BadSizes = true;
            }
            int hr = Whole(d, "seatsRev", out w);
            if (hr == 1) { p.SeatsRev = w; p.HasSeatsRev = true; } else if (hr < 0) p.BadSeatsRev = true;
            return p;
        }

        // Check 1: a strict message (every field present and of its kind; limitPrice is checked with the kind, check 3).
        private static string Strict(Dictionary<string, Val> d, Plan p)
        {
            if (p.Id == null || p.Id.Length < 1 || p.Id.Length > 40) return "a plan needs an id of 1 to 40 characters";
            if (p.Root == null) return "a plan needs a root";
            if (p.Side != "buy" && p.Side != "sell") return "side must be buy or sell";
            if (p.Kind == null) return "a plan needs a kind";
            if (p.PriceText == null) return "price must be a plain number";
            if (d.ContainsKey("limitPrice") && p.LimitText == null) return "limitPrice must be a plain number";
            if (!p.HasQty) return "qty must be a whole number";
            if (!p.HasStop) return "stopTicks must be a whole number";
            if (!p.HasTarget) return "targetTicks must be a whole number";
            if (!p.HasExpire) return "expireSec must be a whole number";
            if (p.RiskText == null) return "riskDollars must be a plain number";
            if (p.Setup == null || p.Setup.Length < 1 || p.Setup.Length > 40) return "setup must be 1 to 40 characters";
            if (p.Reason == null || p.Reason.Length < 1 || p.Reason.Length > 200) return "reason must be 1 to 200 characters";
            if (p.ConfText == null || p.Conf < 0 || p.Conf > 1) return "confidence must be a number from 0 to 1";
            if (p.BadSizes) return "sizes must be whole numbers in seat order, like \"5,3,4\" (0: that seat sits this trade out)";   // 0.6.0
            if (p.BadSeatsRev) return "seatsRev must be a whole number (welcome.seatsRev)";
            return null;
        }
        private static readonly Regex SizesRx = new Regex("^(?:0|[1-9][0-9]{0,5})(?:,(?:0|[1-9][0-9]{0,5})){0,63}$");

        private void OnPlan(Dictionary<string, Val> d)
        {
            Plan p = ReadPlanLoose(d);
            RollDay();
            // Check 1. Every plan id seen today is used, refused or not (lead's default); one used before is refused, and that
            // refusal is shown on its own, never stored over the plan that id first named (sign-in replay, lastPlan).
            bool fresh = UseId(p.Id);
            string why = p.Id != null && p.Id.Length >= 1 && p.Id.Length <= 40 && !fresh ? "plan id " + p.Id + " was already used today" : null;
            if (why == null) why = Strict(d, p);
            lock (Sync) nPlans++;
            if (why == null) why = Checks(p, null, false);   // checks 2 to 11
            string m;
            lock (Sync) m = mode;
            if (why != null) p.Result = "refused: " + why;
            else if (m == "shadow") p.Result = "shadow";
            else if (m == "copilot")
            {
                Proposal pr = new Proposal { P = p, Account = KeyNow(), Sim = SimNow() };
                lock (Sync) { Proposals[p.Id] = pr; nProposals++; }
                p.Result = "proposed";
                ToPages(ProposalJson(pr));
                ToAgent(AnswerJson(p.Id, "proposed", "a proposal on the page until " + Iso(p.ExpiresAt)));
            }
            else
            {
                Order placed;
                why = Place(p, null, out placed);
                p.Result = why == null ? "placed" : "refused: " + why;
                if (why == null && p.SeatNames != null) SeatAnswers(p);   // 0.6.0: one answer per seat, then the plan's
                if (why == null) ToAgent(AnswerJson(p.Id, "placed", p.SeatNames != null ? PlacedWords(p) : "placed on " + Account + " as order " + ChartBridgeOrders.AgentIdFor(placed) + "; it works until " + Iso(p.ExpiresAt)));
            }
            if (why != null) { lock (Sync) nRefused++; ToAgent(Reject(p.Id, why)); }
            ShowPlan(p, fresh);
            AgentLog("plan " + (p.Id ?? "(no id)") + " " + p.Side + " " + p.Qty + " " + p.Root + " " + p.Kind + " @ " + (p.PriceText ?? "?") + (p.LimitText != null ? " limit " + p.LimitText : "") +
                     " stop " + p.StopTicks + " target " + p.TargetTicks + " expire " + p.ExpireSec + "s risk " + (p.RiskText ?? "?") + (p.SizesText != null ? " sizes " + p.SizesText : "") + " (" + (p.Setup ?? "") + ": " + (p.Reason ?? "") + "): " + p.Result + SeatsSaid(p));
            Notify();
        }

        // 0.6.0: a group plan's result per seat for the log ("; SIM-C not in this trade: ...").
        private static string SeatsSaid(Plan p)
        {
            if (p.SeatNames == null) return "";
            StringBuilder b = new StringBuilder();
            for (int i = 0; i < p.SeatNames.Length; i++)
            {
                string r = p.Results != null ? p.Results[i] : null;
                if (p.Outs[i] != null) b.Append("; ").Append(p.SeatNames[i]).Append(" not in this trade: ").Append(p.Outs[i]);
                else if (r != null && r != "placed") b.Append("; ").Append(p.SeatNames[i]).Append(" refused: ").Append(r);
                else if (r == "placed") b.Append("; ").Append(p.SeatNames[i]).Append(" ").Append(p.Sizes[i]);
            }
            return b.ToString();
        }

        // 0.6.0: the plan-level answer's words for a group: where it went, and which seats sat it out.
        private string PlacedWords(Plan p)
        {
            List<string> on = new List<string>(), off = new List<string>();
            for (int i = 0; i < p.SeatNames.Length; i++)
            {
                if (p.Results != null && p.Results[i] == "placed") on.Add(p.SeatNames[i] + " " + p.Sizes[i] + " (order " + ChartBridgeOrders.AgentIdFor(p.Orders[i]) + ")");
                else off.Add(p.SeatNames[i] + " not in this trade: " + (p.Outs[i] ?? p.Results[i] ?? "not placed"));
            }
            return "placed on " + string.Join(", ", on) + "; it works until " + Iso(p.ExpiresAt) + (off.Count > 0 ? "; " + string.Join("; ", off) : "");
        }

        // 0.6.0: one answer per seat (with its account): placed, or refused with why (not in this trade, or the order path's refusal).
        private void SeatAnswers(Plan p)
        {
            for (int i = 0; i < p.SeatNames.Length; i++)
            {
                string seat = p.SeatNames[i], r = p.Results != null ? p.Results[i] : null;
                if (r == "placed") ToAgent(AnswerJson(p.Id, "placed", "placed on " + seat + " as order " + ChartBridgeOrders.AgentIdFor(p.Orders[i]) + " (" + p.Sizes[i] + "); it works until " + Iso(p.ExpiresAt), seat));
                else ToAgent(AnswerJson(p.Id, "refused", p.Outs[i] != null ? "not in this trade: " + p.Outs[i] : "refused: " + (r ?? "not placed"), seat));
            }
        }

        // Checks 2 to 11 of the contract, in order (the id, check 1, is the caller's). forAccount: a proposal's account (placed only
        // if it is still this agent's). The first that fails is the answer.
        private string Checks(Plan p, string forAccount, bool placing) { string used; return Checks(p, forAccount, placing, out used); }

        // used: the account the checks validated (Place sends there, never a fresh read).
        // 0.6.0 (a group): the plan-level checks are as for one account; the checks of one account (tradable and connected, the owner
        // lock, the one-direction check) and a size of 0 make that seat sit this trade out (Q1 b: p.Outs, in seat order); the plan is
        // refused only when no seat can take it. One at a time, maxTrades and maxLosses count the whole group (one plan, one trade).
        private string Checks(Plan p, string forAccount, bool placing, out string used)
        {
            Rules r = RulesNow();
            string acct = Account, sd, gid;
            List<string> seats;
            long rev;
            bool k, lg;
            lock (Sync) { k = killed; sd = FilesBrokenLocked(); gid = groupId; seats = seatNames.ToList(); rev = seatsRev; lg = league; }
            bool grp = gid != null;
            used = grp ? "group:" + gid : acct;
            p.SeatNames = null; p.Outs = null; p.Results = null; p.Orders = null;
            // 2. not killed, not stood down, the files readable, the account tradable now
            if (k) return "the kill switch is on (release it on the Agent tab)";
            if (sd != null) return sd;
            if (!grp && ChartBridgeBranches.IsNone(acct)) return "agent " + Id + "'s account is None: no new entries until an account is chosen on the Agent tab";   // 0.5.7
            if (forAccount != null && forAccount != used) return "agent " + Id + "'s account changed from " + KeyWords(forAccount) + " to " + KeyWords(used) + " after this proposal: nothing placed";
            // 0.6.2: a stand-down of its build on its group (a group pick: the whole plan; one account inside a group: its one seat), or
            // agent-standdowns.txt unreadable (an account in a prop group: BrokenRefusal)
            string latch = LatchProblem();
            if (latch != null) return latch;
            if (lg && (grp || !SeatSim(acct))) return LeagueRefusal;   // 0.6.2: a league seat enters only while its account is Sim (read fresh)
            string[] outs = null;
            if (grp)
            {
                string gw = GroupPlanProblem(p, gid, seats, rev);
                if (gw != null) return gw;
                string cw = AccountConflict();
                if (cw != null) return cw;
                outs = new string[seats.Count];
                for (int i = 0; i < seats.Count; i++) outs[i] = p.Sizes[i] == 0 ? "its size is 0 (no room for 1 contract)" : AccountProblemFor(seats[i], true);
            }
            else
            {
                if (p.SizesText != null) return "sizes is for a group: agent " + Id + " trades one account (" + acct + "); send qty alone";   // 0.6.0
                if (p.HasSeatsRev && p.SeatsRev != rev) return "agent " + Id + "'s account changed (seatsRev " + rev + "): size again";
                string aw = AccountProblemFor(acct, true) ?? AccountConflict();
                if (aw != null) return aw;
            }
            // 3. the root and the kind
            string root = (p.Root ?? "").ToUpperInvariant();
            if (!r.Roots.Contains(root)) return root + " is not one of agent " + Id + "'s roots (" + string.Join(", ", r.Roots) + ")";
            if (ChartBridgeConfig.QuoteOnly(root)) return root + " is quote only: ChartBridge shows its prices on the Quote board and refuses every order for it (quoteRoots in config.txt)";
            Instrument inst = ChartBridgeServer.InstrumentFor(root);
            if (inst == null) return "instrument " + root + " is not served by ChartBridge";
            if (p.Kind != "limit" && p.Kind != "stopLimit") return "an agent's entry is a limit or a stop-limit (" + (p.Kind ?? "(none)") + " refused)";
            if (p.Kind == "stopLimit" && p.LimitText == null) return "a stopLimit plan needs a limitPrice";
            if (p.Kind == "limit" && p.LimitText != null) return "limitPrice goes on a stopLimit plan only";
            if (p.Kind == "stopLimit" && !ChartBridgeOrders.AgentOrderTypes) return "stop-limit entries are off (orderTypes = off in config.txt)";
            // 4. the size, the stop and the target
            int ceiling = Math.Min(ChartBridgeAgents.HardCeiling(root), r.QtyFor(root)), cap;
            if (p.Qty < 1 || p.Qty > ceiling) return "qty must be a whole number from 1 to " + ceiling + " (" + ChartBridgeAgents.CapWords(Id, root, ceiling) + ")";
            string capWhy;
            cap = ChartBridgeOrders.AgentEntryCap(Id, root, out capWhy);   // 0.5.3 review: the words name the cap that applied (MNQ never maxQty.MNQ)
            if (p.Qty > cap) return "qty " + p.Qty + " is over the " + root + " cap of " + cap + " (" + capWhy + ")";
            if (grp)   // 0.6.0: every seat's size against the same caps (ChartBridge never resizes: a size over a cap refuses the plan)
                for (int i = 0; i < seats.Count; i++)
                {
                    if (p.Sizes[i] > ceiling) return "sizes: " + seats[i] + "'s " + p.Sizes[i] + " is over " + ceiling + " (" + ChartBridgeAgents.CapWords(Id, root, ceiling) + ")";
                    if (p.Sizes[i] > cap) return "sizes: " + seats[i] + "'s " + p.Sizes[i] + " is over the " + root + " cap of " + cap + " (" + capWhy + ")";
                }
            if (p.StopTicks < 1 || p.TargetTicks < 1) return "every agent entry needs a stop and a target: stopTicks and targetTicks must be whole numbers of 1 or more";
            int mb = ChartBridgeOrders.AgentMaxBracketTicks;
            if (mb > 0 && (p.StopTicks > mb || p.TargetTicks > mb)) return "stopTicks and targetTicks must be at most " + mb + " (maxBracketTicks in config.txt)";
            // 5. the risk in dollars (0.6.0, a group: the sum over its seats' sizes)
            double tick = inst.MasterInstrument.TickSize, pv = inst.MasterInstrument.PointValue;
            double risk = Math.Round(p.StopTicks * tick * pv * (grp ? p.Sizes.Sum() : p.Qty), 2);
            if (Math.Abs(p.Risk - risk) > 0.01 + 1e-9) return "riskDollars " + p.RiskText + " is not stopTicks x tick x point value x " + (grp ? "the sum of sizes" : "qty") + " (" + risk.ToString("0.00", CultureInfo.InvariantCulture) + ")";
            // 6. the expiry
            if (p.ExpireSec < 60 || p.ExpireSec > r.MaxExpireSec) return "expireSec must be from 60 to " + r.MaxExpireSec;
            // 7. the entry window (session time, 0.5.2; never while the market is closed)
            DateTime et = NowEt();
            if (!InWindow(r, et)) return WindowRefusal(r, et);
            // 8. one at a time (Owns first: it clears a lock whose position is flat by both readings); 0.6.0: on every seat
            bool entry = WorkingEntries().Count > 0, owns = r.Roots.Any(x => Owns(x)), open, proposal;
            lock (Sync)
            {
                open = Seats.Values.Any(x => x.openTag != null || x.Sticky.Count > 0);
                proposal = Proposals.Values.Any(x => x.State == "open" || x.State == "accepting") && !placing;
            }
            if (entry) return "one at a time: agent " + Id + " already has a working entry";
            if (open || owns) return "one at a time: agent " + Id + " already has a position";
            if (proposal) return "one at a time: agent " + Id + " already has an open proposal";
            ClearCarried();   // 0.5.2 re-check: flat by check 8, so nothing from an earlier session is left (never left to the next pass)
            // 9. maxTrades, maxLosses (0.6.0: a group's plan counts once)
            int trades;
            string lossWhy;
            lock (Sync) { trades = TradesLocked(); StandDownLocked(); lossWhy = lossStandDown; }
            if (r.MaxTrades > 0 && trades >= r.MaxTrades) return "agent " + Id + " has made " + trades + " trades today (maxTrades " + r.MaxTrades + ")";
            if (lossWhy != null) return lossWhy;
            if (!grp)
            {
                // 10. the owner lock
                Account a = FindAccount(acct);
                string lockWhy = ChartBridgeAgents.EntryCheck("agent:" + Id, a, root);
                if (lockWhy != null) return lockWhy;
                // 10b. 0.5.8 (G3 a): one direction per group (advisory here; the binding check runs under PlaceLock in PlaceOrderLocked)
                string groupWhy = ChartBridgeGroups.EntryCheck("agent:" + Id, a, root, p.Side == "buy", p.Qty, true, false);
                if (groupWhy != null) return groupWhy;
            }
            else
                for (int i = 0; i < seats.Count; i++)
                {
                    if (outs[i] != null) continue;
                    // 10 and 10b on each seat (0.6.0): a position or order that is not the agent's, or the one-direction check, sits it out
                    Account a = FindAccount(seats[i]);
                    outs[i] = ChartBridgeAgents.EntryCheck("agent:" + Id, a, root) ?? ChartBridgeGroups.EntryCheck("agent:" + Id, a, root, p.Side == "buy", p.Sizes[i], true, false);
                }
            // 11. the price (v2 gate 5): on the grid, a fresh last trade, the side of the market; a stop-limit's limit within 20 ticks
            bool buy = p.Side == "buy";
            string bad = ChartBridgeOrders.AgentPriceProblem(root, tick, p.Kind == "limit" ? "limit" : "stop", buy, p.Price);
            if (bad != null) return bad;
            if (p.Kind == "stopLimit")
            {
                if (!(p.Limit > 0) || !ChartBridgeOrders.AgentOnGrid(p.Limit, tick)) return "limitPrice " + p.LimitText + " is not on the " + CbJson.Num(tick) + " tick grid";
                double lo = buy ? p.Price : p.Price - ChartBridgeAgents.StopLimitMaxTicks * tick, hi = buy ? p.Price + ChartBridgeAgents.StopLimitMaxTicks * tick : p.Price;
                if (p.Limit < lo - 1e-9 || p.Limit > hi + 1e-9)
                    return "a " + p.Side + " stop-limit's limitPrice must be from its price " + (buy ? "up to " : "down to ") + ChartBridgeAgents.StopLimitMaxTicks + " ticks " + (buy ? "above" : "below") + " it";
            }
            if (grp)
            {
                p.SeatNames = seats.ToArray(); p.Outs = outs;
                if (outs.All(x => x != null))
                    return "no seat of " + KeyWords(used) + " can take this plan: " + string.Join("; ", seats.Select((x, i) => x + ": " + outs[i]));
            }
            return null;
        }

        // 0.6.0: a group plan's own checks (part of check 2): groups.txt readable, seats there, sizes for each, the seatsRev it was
        // sized for, qty the first seat's size that is not 0. Null when it may go on.
        private string GroupPlanProblem(Plan p, string gid, List<string> seats, long rev)
        {
            if (ChartBridgeGroups.Unreadable()) return ChartBridgeGroups.ReadFailedText;
            if (seats.Count == 0) return "group " + (ChartBridgeGroups.NameOf(gid) ?? gid) + " has no accounts: agent " + Id + " trades nothing until it has";
            if (p.SizesText == null || !p.HasSeatsRev) return "a plan for a group needs sizes (one per seat, in welcome.seats order) and seatsRev";
            if (p.SeatsRev != rev) return "the group changed; size again";
            if (p.Sizes.Length != seats.Count) return "sizes has " + p.Sizes.Length + " sizes for " + seats.Count + " seats (" + string.Join(", ", seats) + ")";
            int first = p.Sizes.FirstOrDefault(x => x > 0);
            if (first == 0) return "every size is 0: no seat takes this plan";
            if (p.Qty != first) return "qty must be the first seat's size that is not 0 (" + first + ")";
            return null;
        }

        // Placing (auto, or an accepted proposal): every check again at this moment, then ChartBridgeOrders.PlaceAgentEntry builds the
        // order from the plan's own parameters on the agent's own account, through every v2 gate and the owner lock.
        // 0.6.0 (a group): then seat by seat (PlaceSeatsLocked), each through PlaceAgentEntry with its own account and size.
        private string Place(Plan p, string forAccount, out Order placed)
        {
            placed = null;
            bool seats;
            lock (PlaceGate)
            {
                string acct;
                string why = Checks(p, forAccount, forAccount != null, out acct);
                if (why != null) return why;
                seats = p.SeatNames != null;
                if (seats)
                {
                    why = PlaceSeatsLocked(p, out placed);
                    if (why != null) { placed = null; return why; }
                }
                else
                {
                    string root = p.Root.ToUpperInvariant();
                    string text = "{\"type\":\"order\",\"account\":" + CbJson.Str(acct) + ",\"root\":\"" + root + "\",\"side\":\"" + p.Side + "\",\"kind\":\"" + p.Kind + "\",\"qty\":" +
                                  p.Qty.ToString(CultureInfo.InvariantCulture) + ",\"price\":" + p.PriceText + (p.Kind == "stopLimit" ? ",\"limitPrice\":" + p.LimitText : "") +
                                  ",\"bracket\":{\"stop\":" + p.StopTicks.ToString(CultureInfo.InvariantCulture) + ",\"target\":" + p.TargetTicks.ToString(CultureInfo.InvariantCulture) + "}}";
                    why = ChartBridgeOrders.PlaceAgentEntry(Id, p.Id, text, out placed);
                    if (why != null) { placed = null; return why; }
                    string tag = ChartBridgeAgents.TagOf(placed.Name);
                    ChartBridgeAgents.NoteTag(tag, Id);
                    Seat s = SeatFor(acct);
                    lock (Sync)
                    {
                        Placed.Add(placed); MyTags.Add(tag); if (s != null) s.Sticky.Add(root); nPlaced++;
                        EntryOfPlan[p.Id] = new List<Order> { placed }; PlanOfTag[tag] = p.Id; Expiry[tag] = p.ExpiresAt;
                    }
                }
            }
            SaveDay();
            if (seats)
            {
                for (int i = 0; i < p.SeatNames.Length; i++)
                    if (p.Results[i] == "placed")
                        AgentLog("placed " + p.Side + " " + p.Sizes[i] + " " + p.Root + " " + p.Kind + " @ " + p.PriceText + (p.LimitText != null ? " limit " + p.LimitText : "") + " stop " + p.StopTicks +
                                 " target " + p.TargetTicks + " on " + p.SeatNames[i] + (SeatSim(p.SeatNames[i]) ? " (Sim)" : " (LIVE)") + " (plan " + p.Id + ", until " + Iso(p.ExpiresAt) + ")");
                return null;
            }
            AgentLog("placed " + p.Side + " " + p.Qty + " " + p.Root + " " + p.Kind + " @ " + p.PriceText + (p.LimitText != null ? " limit " + p.LimitText : "") + " stop " + p.StopTicks +
                     " target " + p.TargetTicks + " on " + Account + (SimNow() ? " (Sim)" : " (LIVE)") + " (plan " + p.Id + ", until " + Iso(p.ExpiresAt) + ")");
            return null;
        }

        // 0.6.0: a group plan, under PlaceGate after every check passed again: each seat that can take it, in seat order, through
        // ChartBridgeOrders.PlaceAgentEntry with that seat's account and size (each runs every v2 gate, the owner lock and the
        // one-direction check under PlaceLock), each in its own try, all with the plan's id. A seat the order path refuses is refused
        // there and the others go on. PlaceLock is taken per seat by PlaceOrder, never held across seats: PlaceOrder writes the plans
        // file after it lets PlaceLock go, and that write must never run under PlaceLock. Null when at least one seat was placed.
        private string PlaceSeatsLocked(Plan p, out Order first)
        {
            first = null;
            string root = p.Root.ToUpperInvariant();
            Instrument inst = ChartBridgeServer.InstrumentFor(root);
            double tick = inst != null ? inst.MasterInstrument.TickSize : 0, pv = inst != null ? inst.MasterInstrument.PointValue : 0;
            int n = p.SeatNames.Length, count = 0;
            p.Results = new string[n]; p.Orders = new Order[n];
            for (int i = 0; i < n; i++)
            {
                string seat = p.SeatNames[i];
                Seat s = SeatFor(seat);
                if (s != null) lock (Sync) { s.Out = p.Outs[i]; s.LastSize = p.Sizes[i]; s.LastRisk = Math.Round(p.StopTicks * tick * pv * p.Sizes[i], 2); s.LastPlanId = p.Id; }
                if (p.Outs[i] != null) continue;
                string text = "{\"type\":\"order\",\"account\":" + CbJson.Str(seat) + ",\"root\":\"" + root + "\",\"side\":\"" + p.Side + "\",\"kind\":\"" + p.Kind + "\",\"qty\":" +
                              p.Sizes[i].ToString(CultureInfo.InvariantCulture) + ",\"price\":" + p.PriceText + (p.Kind == "stopLimit" ? ",\"limitPrice\":" + p.LimitText : "") +
                              ",\"bracket\":{\"stop\":" + p.StopTicks.ToString(CultureInfo.InvariantCulture) + ",\"target\":" + p.TargetTicks.ToString(CultureInfo.InvariantCulture) + "}}";
                Order o = null;
                string why;
                try { why = ChartBridgeOrders.PlaceAgentEntry(Id, p.Id, text, out o); }
                catch (Exception ex) { why = "ChartBridge error: " + ex.Message; o = null; }
                if (why == null && o == null) why = "nothing was placed";
                if (why == null && o.OrderState == OrderState.Rejected) why = "NinjaTrader rejected its entry";   // at once, inside Submit: that seat only
                if (why != null)
                {
                    p.Results[i] = why;
                    if (s != null) lock (Sync) s.Out = "refused: " + why;
                    Log("agent " + Id + " plan " + p.Id + ": " + seat + " refused: " + why);
                    continue;
                }
                string tag = ChartBridgeAgents.TagOf(o.Name);
                ChartBridgeAgents.NoteTag(tag, Id);
                lock (Sync)
                {
                    Placed.Add(o); MyTags.Add(tag); if (s != null) s.Sticky.Add(root);
                    List<Order> l;
                    if (!EntryOfPlan.TryGetValue(p.Id, out l)) EntryOfPlan[p.Id] = l = new List<Order>();
                    l.Add(o);
                    PlanOfTag[tag] = p.Id; SeatOfTag[tag] = seat; Expiry[tag] = p.ExpiresAt;
                }
                p.Results[i] = "placed"; p.Orders[i] = o; count++;
                if (first == null) first = o;
            }
            if (count == 0)
                return "no seat took it: " + string.Join("; ", p.SeatNames.Select((x, i) => x + ": " + (p.Outs[i] ?? p.Results[i])));
            lock (Sync) nPlaced++;
            return null;
        }

        // The account: in NinjaTrader under that exact name, never Backtest or Playback, and (gates) tradable by gate 2 and Connected.
        private static string AccountProblemFor(string nm, bool gates)
        {
            if (!ChartBridgeOrders.Enabled) return "trading is off in config.txt";
            if (ChartBridgeOrders.IsNeverTradable(nm ?? "")) return nm + " is a Backtest or Playback account: an agent never trades one";
            Account a = FindAccount(nm);
            if (a == null) return nm + " is not in NinjaTrader";
            if (gates && !ChartBridgeOrders.AccountTradable(nm))
                return (ChartBridgeAccounts.On ? ChartBridgeAccounts.EntryRefusal(nm) : nm + " may not trade from the chart (tradeAccounts in config.txt)") + ": the agent needs it tradable";
            if (gates && (a.Connection == null || a.Connection.Status != ConnectionStatus.Connected)) return nm + " is not connected";
            if (gates && ChartBridgeAccounts.On && ChartBridgeAccounts.IsGone(a)) return nm + " is gone: entries wait until it is back";
            return null;
        }

        private static Account FindAccount(string nm)
        {
            if (string.IsNullOrEmpty(nm)) return null;
            lock (NinjaTrader.Cbi.Account.All)
                foreach (Account a in NinjaTrader.Cbi.Account.All) if (a.Name == nm) return a;   // exact, case and all
            return null;
        }

        // 0.6.0: a group is Sim only when every seat is (the careful side).
        private bool SimNow()
        {
            if (!GroupNow()) { Account a = FindAccount(Account); return a != null && ChartBridgeBot.IsSim(a); }
            List<string> seats = SeatNames();
            return seats.Count > 0 && seats.All(SeatSim);
        }

        private void OnSkip(Dictionary<string, Val> d)
        {
            string id = S(d, "id"), setup = S(d, "setup"), reason = S(d, "reason");
            if (id == null || id.Length < 1 || id.Length > 40 || reason == null || reason.Length < 1 || (d.ContainsKey("setup") && (setup == null || setup.Length < 1 || setup.Length > 40)))
            { ToAgent(Reject(id, "skip needs an id (1 to 40), a reason (1 to 200) and, if given, a setup (1 to 40)")); return; }
            Plan p = new Plan { Action = "skip", Id = id, Setup = setup, Reason = reason, At = Now(), Result = "skipped" };
            ShowPlan(p);
            AgentLog("skip " + id + (setup != null ? " (" + setup + ")" : "") + ": " + reason);
        }

        private void OnNote(Dictionary<string, Val> d)
        {
            string kind = S(d, "kind"), text = S(d, "text");
            if (kind != "look" && kind != "thinking" && kind != "lesson" && kind != "notebook" && kind != "status") { ToAgent(Reject(null, "note kind must be look, thinking, lesson, notebook or status")); return; }
            if (text == null || text.Length < 1 || text.Length > 1000) { ToAgent(Reject(null, "note text must be 1 to 1,000 characters")); return; }
            string json = "{\"type\":\"agentNote\",\"agent\":" + CbJson.Str(Id) + ",\"at\":" + Ms(Now()) + ",\"kind\":" + CbJson.Str(kind) + ",\"text\":" + CbJson.Str(text) + "}";
            lock (Sync) { Notes.AddLast(json); while (Notes.Count > ChartBridgeAgents.NotesKept) Notes.RemoveFirst(); }
            ToPages(json);
        }

        private void OnWithdraw(Dictionary<string, Val> d)
        {
            string id = S(d, "id"), reason = S(d, "reason");
            if (id == null || reason == null || reason.Length < 1) { ToAgent(Reject(id, "withdraw needs an id and a reason")); return; }
            Proposal p;
            List<Order> entries;
            string was = null;
            lock (Sync)
            {
                Proposals.TryGetValue(id, out p);
                EntryOfPlan.TryGetValue(id, out entries);
                entries = entries != null ? entries.ToList() : new List<Order>();
                if (p != null && p.State == "open") { p.State = "withdrawn"; was = "open"; }
                else if (p != null && p.State == "accepting") { p.WithdrawnWhy = reason; was = "accepting"; }
            }
            if (was == "accepting") { AgentLog("withdraw " + id + " arrived while its accept is being placed: the entry is cancelled once placed if it has not filled (" + reason + ")"); return; }
            if (was == "open")
            {
                ToAgent(AnswerJson(id, "withdrawn", "withdrawn by the agent before an answer: " + reason));
                ToPages(ProposalJson(p));
                AgentLog("proposal " + id + " withdrawn by the agent (" + reason + ")");
                Notify();
                return;
            }
            // 0.6.0: every seat's unfilled entry of that plan
            List<Order> gone = entries.Where(e => Cancel(e, "withdrawn by the agent: " + reason)).ToList();
            bool cancelled = gone.Count > 0;
            if (!cancelled) { ToAgent(Reject(id, "nothing to withdraw for " + id)); return; }
            Order entry = gone[0];
            int filled = gone.Sum(e => e.Filled);
            if (p != null) { lock (Sync) p.State = "withdrawn"; ToPages(ProposalJson(p)); }
            ToAgent(AnswerJson(id, "withdrawn", (gone.Count > 1 ? "its " + gone.Count + " unfilled entries cancelled (" : "its unfilled entry cancelled (") + reason + ")" + (filled > 0 ? "; the " + filled + " filled keep their stop and target" : "")));
            AgentLog("withdraw " + id + ": its unfilled entry cancelled (" + reason + ")");
            Notify();
        }

        // flatten from the agent: auto only, not while killed: cancel its orders on its account and roots, then market out. 0.6.0:
        // every seat at once (one message for the whole group), or account: that seat only.
        private void OnAgentFlatten(Dictionary<string, Val> d)
        {
            string m, seat = S(d, "account");
            bool k;
            lock (Sync) { m = mode; k = killed; }
            string why = m != "auto" ? "flatten is for auto mode only" : k ? "the kill switch is on" : null;
            if (why == null && d.ContainsKey("account") && (seat == null || !HasSeat(seat))) why = "account must be one of agent " + Id + "'s seats (" + string.Join(", ", AllSeats().Select(x => x.Name)) + ")";
            if (why == null && StartFlatten("flatten from agent " + Id, false, seat) == 0) why = "agent " + Id + " has nothing to flatten" + (seat != null ? " on " + seat : "");
            if (why != null) { ToAgent(Reject(null, why)); return; }
            AgentLog("flatten from the agent (auto) on " + (seat ?? AccountWords()));
        }

        // ---------------------------------------------------------- the agent's orders
        private void ClearCarried()
        {
            bool had;
            lock (Sync) { had = Carried.Count > 0; Carried.Clear(); }
            if (had) SaveDay();
        }

        private bool IsMine(Order o) { return o != null && ChartBridgeAgents.AgentOf(o) == Id; }

        // The root of another contract month of one of its roots (its master instrument's name), or null.
        private string MonthRoot(Instrument inst)
        {
            if (inst == null || inst.MasterInstrument == null) return null;
            string m = (inst.MasterInstrument.Name ?? "").ToUpperInvariant();
            return FlatRoots().Contains(m) ? m : null;
        }

        // Its protective orders: v2's legs, and the stop placed again over a shut market ("CB#<tag> ag:<id> stop p<price>"; review D1).
        private static readonly Regex LegRx = new Regex("^CB#[0-9a-f]{8} (?:(?:stop|target) |ag:[a-z][a-z0-9]{0,11} stop p)");
        private static readonly Regex ReStopRx = new Regex("^CB#[0-9a-f]{8} ag:[a-z][a-z0-9]{0,11} stop p");
        private static bool IsReStop(Order o) { return o != null && ReStopRx.IsMatch(o.Name ?? ""); }
        private bool IsMyEntry(Order o) { if (o == null) return false; Match m = ChartBridgeAgents.EntryRx.Match(o.Name ?? ""); return m.Success && m.Groups[2].Value == Id; }

        // Every working entry of this agent on its accounts (0.6.0: every seat it follows): those NinjaTrader lists (also after a
        // restart, by name) and those just sent.
        private List<Order> WorkingEntries()
        {
            List<Order> list = new List<Order>();
            foreach (Seat x in AllSeats())
            {
                Account a = FindAccount(x.Name);
                if (a != null) lock (a.Orders) foreach (Order o in a.Orders) if (IsMyEntry(o) && ChartBridgeOrders.IsWorking(o.OrderState)) list.Add(o);
            }
            lock (Sync) foreach (Order o in Placed) if (!list.Contains(o) && ChartBridgeOrders.IsWorking(o.OrderState)) list.Add(o);
            return list;
        }

        // 0.6.0: a seat (made when missing: a single account chosen just now).
        private Seat EnsureSeat(string acct)
        {
            lock (Sync) { Seat s; if (!Seats.TryGetValue(acct, out s)) Seats[acct] = s = new Seat(this, acct); return s; }
        }
        private static bool SeatSim(string acct) { Account a = FindAccount(acct); return a != null && ChartBridgeBot.IsSim(a); }
        // 0.6.0: the seat of a group entry's tag (its answers carry it as account), or null (one account: as before).
        private string SeatOfTagNow(string tag) { string s; lock (Sync) return tag != null && SeatOfTag.TryGetValue(tag, out s) ? s : null; }

        // Cancel an unfilled (or part-filled) entry of this agent: never a stop or a target; the filled part keeps its legs. True only
        // the first time (for the answer); while the order still works the cancel is sent again every 3 s (ResendCancels), with a
        // status warning from the second try (a cancel the broker lost, or sent while disconnected).
        private bool Cancel(Order o, string why)
        {
            if (o == null || o.Account == null || !ChartBridgeOrders.IsWorking(o.OrderState) || !IsMyEntry(o)) return false;
            lock (Sync) { if (CancelSent.ContainsKey(o)) return false; CancelSent[o] = new CancelTry { FirstMs = Now(), LastMs = Now(), Tries = 1, Why = why }; }
            SendCancel(o, why, 1);
            return true;
        }

        private void SendCancel(Order o, string why, int tries)
        {
            try { o.Account.Cancel(new[] { o }); }
            catch (Exception ex) { Log("agent " + Id + " cancel of " + (o.Name ?? "") + " could not be sent (" + ex.Message + "); it is tried again in 3 s"); }
            Log("agent " + Id + " entry cancel sent" + (tries > 1 ? " again (try " + tries + ")" : "") + ": " + (o.Name ?? "") + " on " + o.Account.Name + " (" + why + ")");
            if (tries == 2)
            {
                string text = "Agent " + Id + ": the cancel of its entry " + (o.Name ?? "") + " on " + o.Account.Name + " was not confirmed in 3 s (" + why + "); ChartBridge sends it again every 3 s until it is done; check NinjaTrader";
                AgentLog(text);
                ChartBridgeOrders.AgentWarn(text);
            }
            if (tries == ChartBridgeAgents.CancelSlowAfter)
            {
                string text = "Agent " + Id + ": the cancel of its entry " + (o.Name ?? "") + " on " + o.Account.Name + " is still not confirmed after " + tries + " tries (" + why + "); ChartBridge tries again every 30 s; cancel it in NinjaTrader now";
                AgentLog(text);
                ChartBridgeOrders.AgentAlarm(text);
            }
        }

        // Every pass: a cancel whose order still works is sent again every 3 s.
        private void ResendCancels(double now)
        {
            List<KeyValuePair<Order, CancelTry>> due = new List<KeyValuePair<Order, CancelTry>>(), gaveUp = new List<KeyValuePair<Order, CancelTry>>();
            lock (Sync)
                foreach (KeyValuePair<Order, CancelTry> kv in CancelSent.ToList())
                {
                    if (!ChartBridgeOrders.AgentMayFillState(kv.Key.OrderState)) { CancelSent.Remove(kv.Key); continue; }
                    if (kv.Value.GaveUp) continue;
                    // review A C5: after 30 minutes no more tries, with a final error (the order stays listed as given up, never retried)
                    if (now - kv.Value.FirstMs >= ChartBridgeAgents.CancelGiveUpMs) { kv.Value.GaveUp = true; gaveUp.Add(kv); continue; }
                    // review A4: never sent while the account is not Connected (resumed when it is); from the 10th try every 30 s
                    Account acc = kv.Key.Account;
                    if (acc == null || acc.Connection == null || acc.Connection.Status != ConnectionStatus.Connected) continue;
                    double every = kv.Value.Tries >= ChartBridgeAgents.CancelSlowAfter ? ChartBridgeAgents.CancelSlowMs : ChartBridgeAgents.FlatRetryMs;
                    if (now - kv.Value.LastMs >= every) { kv.Value.LastMs = now; kv.Value.Tries++; due.Add(kv); }
                }
            foreach (KeyValuePair<Order, CancelTry> kv in due) SendCancel(kv.Key, kv.Value.Why, kv.Value.Tries);
            foreach (KeyValuePair<Order, CancelTry> kv in gaveUp)
            {
                string text = "Agent " + Id + ": the cancel of its entry " + (kv.Key.Name ?? "") + " on " + (kv.Key.Account != null ? kv.Key.Account.Name : Account) + " was never confirmed in 30 minutes (" + kv.Value.Tries +
                              " tries); ChartBridge stops trying: cancel it in NinjaTrader now";
                Log(text); AgentLog(text); ChartBridgeOrders.AgentAlarm(text);
            }
        }

        // Heartbeat lost, the kill switch, leaving auto, outside the window: every unfilled entry goes, with an answer.
        private int CancelUnfilled(string why)
        {
            int n = 0;
            foreach (Order o in WorkingEntries()) if (Cancel(o, why)) { n++; AnswerEntryEnded(o, "expired", why); }
            return n;
        }

        private void AnswerEntryEnded(Order o, string answer, string why)
        {
            string tag = ChartBridgeAgents.TagOf(o.Name), planId;
            lock (Sync) PlanOfTag.TryGetValue(tag ?? "", out planId);
            if (planId == null) return;
            string seat = SeatOfTagNow(tag);   // 0.6.0: a group's seat answers with its account
            ToAgent(AnswerJson(planId, answer, why + (o.Filled > 0 ? "; the rest cancelled, the " + o.Filled + " filled keep their stop and target" : "; its entry cancelled"), seat));
            AgentLog("plan " + planId + " " + answer + (seat != null ? " on " + seat : "") + ": " + why + (o.Filled > 0 ? " (" + o.Filled + " filled keep their legs)" : ""));
        }

        // ChartBridgeOrders.OnOrderUpdate: the agent sees its own orders; done entries are forgotten.
        public void OnOrderUpdate(Order o, string json)
        {
            CbIdOf(o);   // before ChartBridge forgets a done order's id: its exec carries the same cbId as its order messages
            string tag = ChartBridgeAgents.TagOf(o.Name);
            if (IsMyEntry(o)) { ChartBridgeAgents.NoteTag(tag, Id); lock (Sync) MyTags.Add(tag); }
            bool done = !ChartBridgeOrders.AgentMayFillState(o.OrderState), rejectedEntry = false;
            string planId = null;
            ChartBridgeClient c;
            lock (Sync)
            {
                if (done)
                {
                    rejectedEntry = o.OrderState == OrderState.Rejected && Placed.Contains(o);
                    Placed.Remove(o); CancelSent.Remove(o);
                    if (IsMyEntry(o) && tag != null) { Expiry.Remove(tag); PlanOfTag.TryGetValue(tag, out planId); }
                }
                c = helloed ? client : null;
            }
            if (c != null && json != null) c.Send(json);
            if (done && IsMyEntry(o)) SaveDay();
            if (rejectedEntry && planId != null)
            {
                string seat = SeatOfTagNow(tag);   // 0.6.0: on a group, that seat only (the others keep theirs)
                Seat x = seat != null ? SeatFor(seat) : null;
                if (x != null) lock (Sync) x.Out = "refused: NinjaTrader rejected its entry";
                ToAgent(AnswerJson(planId, "refused", "NinjaTrader rejected its entry", seat)); AgentLog("plan " + planId + ": NinjaTrader rejected its entry" + (seat != null ? " on " + seat : ""));
            }
        }

        // Every execution on one of its seats (ChartBridgeServer.Deliver): that seat follows its trade (Seat.OnExec).
        public void OnExec(string account, Instrument inst, MarketPosition side, int qty, double price, string orderId, string json)
        {
            Seat x = SeatFor(account);
            if (x != null) x.OnExec(inst, side, qty, price, orderId, json);
        }

        private class ExcessFill { public string Key; public int Qty, TradeSign; public double Price, Pv; }
        private readonly Dictionary<string, ExcessFill> ExcessByTag = new Dictionary<string, ExcessFill>();   // entry tag -> the close's part beyond its trade

        // ChartBridge's id for an order of this agent ("o12"), as its order messages carried it (kept here: ChartBridge forgets a done
        // order's id); null for an order that is not ChartBridge's.
        private readonly Dictionary<Order, string> CbIds = new Dictionary<Order, string>();

        // Any ChartBridge order on its account, as its order event passes (before ChartBridge forgets a done order's id): a fill of
        // the page's order on its pair then carries the id the pages saw.
        public void NoteOrderId(Order o)
        {
            if (o == null || !(o.Name ?? "").StartsWith("CB#", StringComparison.Ordinal)) return;
            bool on;
            lock (Sync) on = helloed && client != null && !CbIds.ContainsKey(o);
            if (on) CbIdOf(o);
        }

        private string CbIdOf(Order o)
        {
            if (o == null || !(o.Name ?? "").StartsWith("CB#", StringComparison.Ordinal)) return null;
            string id;
            lock (Sync) if (CbIds.TryGetValue(o, out id)) return id;
            id = ChartBridgeOrders.AgentKnownId(o) ?? (IsMine(o) ? ChartBridgeOrders.AgentIdFor(o) : null);   // never a new id for an order not its own
            if (id == null) return null;
            lock (Sync)
            {
                if (CbIds.Count >= 2000) foreach (Order k in CbIds.Keys.ToList()) if (!ChartBridgeOrders.AgentMayFillState(k.OrderState)) CbIds.Remove(k);   // done orders go first
                CbIds[o] = id;
            }
            return id;
        }

        private Order FindOrder(string orderId, string acct)
        {
            if (string.IsNullOrEmpty(orderId)) return null;
            Account a = FindAccount(acct);
            if (a != null) lock (a.Orders) foreach (Order o in a.Orders) if (o.OrderId == orderId) return o;
            lock (Sync) foreach (Order o in Placed) if (o.OrderId == orderId) return o;
            return null;
        }

        // The account's position on the agent's roots, to the agent (0.6.0: each seat's, with its account).
        public void OnPosition(string acct, PositionEventArgs e)
        {
            string root = ChartBridgeServer.RootFor(e.Position.Instrument);
            if (root == null || !RulesNow().Roots.Contains(root)) return;
            ChartBridgeClient c;
            lock (Sync) c = helloed ? client : null;
            if (c == null) return;
            int q = e.MarketPosition == MarketPosition.Long ? e.Quantity : e.MarketPosition == MarketPosition.Short ? -e.Quantity : 0;
            c.Send("{\"type\":\"position\",\"account\":" + CbJson.Str(acct) + ",\"root\":" + CbJson.Str(root) + ",\"qty\":" + q.ToString(CultureInfo.InvariantCulture) +
                   ",\"avgPrice\":" + (q != 0 ? CbJson.Num(e.AveragePrice) : "null") + "}");
        }

        public void OnTick(string root, string json)
        {
            ChartBridgeClient c = Volatile.Read(ref client);
            if (c == null || !helloed || c.Root == root) return;   // the subscribed root comes through the seam
            c.Send(json);
        }

        // ---------------------------------------------------------- the timer: heartbeat, expiries, the window, the flat time
        public void Check(double now)
        {
            RetryIo(now);   // 0.6.3 (audit C4)
            RollDay();
            RefreshSeats();   // 0.6.0: a group's membership (and a deleted group: None)
            ChartBridgeClient silent = null, mute = null;
            bool none, strip = false;
            lock (Sync)
            {
                if (client != null && now - lastMsgMs > ChartBridgeAgents.SilenceMs) silent = client;
                else if (client != null && !helloed && now - attachedMs > ChartBridgeAgents.SilenceMs) mute = client;   // never said hello: closed, its id freed
                none = client == null && !claimed;
                if (!none) noClientSinceMs = now;
                if (client != null && helloed && now - lastStripMs >= ChartBridgeAgents.StripEveryMs) { strip = true; lastStripMs = now; }
            }
            if (silent != null) Lose(silent, "no message from agent " + Id + " for 5 s (heartbeat lost)", true);
            if (mute != null) Lose(mute, "agent " + Id + " connected but sent no agentHello in 5 s", true);
            double since;
            lock (Sync) since = noClientSinceMs;
            if (none && now - since > ChartBridgeAgents.SilenceMs)
            {
                int n = CancelUnfilled("no agent " + Id + " connected for 5 s");
                if (n > 0) { string text = "Agent " + Id + ": not connected: " + n + " unfilled entr" + (n == 1 ? "y" : "ies") + " cancelled; any position keeps its stop and target"; Log(text); AgentLog(text); ToPages(StatusJson("warn", text)); Notify(); }
            }
            // A clash with the bot, the copier or another agent (set after this agent's entries went out): it stands down, its
            // unfilled entries are cancelled and its open proposals expire; a position keeps its legs, the flat time still runs.
            // 0.6.2: and a stand-down of its build on its group (agent-standdowns.txt), the same way.
            string clash = LatchProblem() ?? AccountConflict();
            if (clash != null) Sweep(clash);
            Rules r = RulesNow();
            DateTime etNow = NowEt();
            bool inWindow = InWindow(r, etNow);   // 0.5.2: session time, the market open
            // proposals live until their plan's expiry (Anthony's ruling 4), and never outside the window
            List<Proposal> ended = new List<Proposal>();
            lock (Sync)
                foreach (Proposal p in Proposals.Values)
                    if (p.State == "open" && (now >= p.P.ExpiresAt || !inWindow)) { p.State = "expired"; ended.Add(p); }
            foreach (Proposal p in ended)
            {
                string why = now >= p.P.ExpiresAt ? "its plan expired unanswered" : ChartBridgeCme.Closed(etNow) ? "the market closed" : "the entry window closed at " + Hm(r.EntryUntil);
                ToPages(ProposalJson(p)); ToAgent(AnswerJson(p.P.Id, "expired", why)); AgentLog("proposal " + p.P.Id + " expired (" + why + ")");
            }
            lock (Sync)
            {
                List<string> endedKeys = Proposals.Where(kv => kv.Value.State != "open" && kv.Value.State != "accepting").OrderBy(kv => kv.Value.P.At).Select(kv => kv.Key).ToList();
                for (int i = 0; i < endedKeys.Count - 50; i++) Proposals.Remove(endedKeys[i]);   // review B: ended proposals do not pile up
            }
            // entries: cancelled at their expiry (from ChartBridge's own clock), outside the window, when the expiry is not known, and
            // (the backstop, every pass) while the agent is killed, in shadow (every start), or stood down; a cancel not confirmed is
            // sent again every 3 s (ResendCancels)
            string backstop;
            lock (Sync) backstop = killed ? "the kill switch is on" : mode == "shadow" ? "agent " + Id + " is in shadow" : null;
            if (backstop == null) { string sd = StandDown(); if (sd != null) backstop = "agent " + Id + " stands down: " + sd; }
            int cancelled = 0;
            foreach (Order o in WorkingEntries())
            {
                string tag = ChartBridgeAgents.TagOf(o.Name);
                double exp;
                bool known;
                lock (Sync) known = Expiry.TryGetValue(tag ?? "", out exp);
                string why = backstop ?? (!inWindow ? (ChartBridgeCme.Closed(etNow) ? "the market is closed" : "outside the entry window (" + Hm(r.EntryFrom) + " to " + Hm(r.EntryUntil) + ")") : !known ? "its expiry is not known (ChartBridge restarted)" : now >= exp ? "its plan expired" : null);
                if (why != null && Cancel(o, why)) { cancelled++; AnswerEntryEnded(o, "expired", why); }
            }
            ResendCancels(now);
            FlushRefused(now);
            if (cancelled > 0 || ended.Count > 0) Notify();
            // every pass: a lock whose pair is flat by both readings, with nothing of the agent working there, clears; an open trade
            // record that nothing listed belongs to any more is dropped (once the executions have been read again after a start)
            // 0.6.0: on every seat it follows (each its own ledger, locks, jobs and errors)
            List<string> roots = FlatRoots();
            List<Seat> seats = AllSeats();
            foreach (Seat x in seats) { x.DropLedgerAgainst(roots); x.EndGhostTrade(now); foreach (string root in roots) x.Owns(root); }
            DropStaleRecords(roots);   // each record once its seat's executions were read again (ExecutionsReplayed)
            foreach (Seat x in seats) { if (ChartBridgeServer.ExecutionsReplayed(x.Name)) x.WarnHeldByStopOnly(roots); x.RepeatTradeLost(now); }   // only once the session's executions were read again (review B)
            // the flat time (ruling 2): from flatAt until the next entryFrom in session order (0.5.2: with an 18:00 entryFrom a
            // position held across midnight is inside the session and stays; with 09:45 one held overnight is flattened, as
            // before) and while the market is closed, whatever the agent does or whether it is there
            bool flatHours = FlatHours(r, etNow), fromBefore;
            lock (Sync) fromBefore = Carried.Count > 0;
            if (fromBefore && !seats.Any(x => roots.Any(y => x.Owns(y)))) { ClearCarried(); fromBefore = false; }   // flat: nothing left from the session before
            // 0.5.2 re-check: only a position that is in fact from an earlier session, never because Carried is merely not empty
            if (fromBefore) fromBefore = seats.Any(x => roots.Any(y => x.FromBefore(y)));
            flatHours = flatHours || fromBefore;   // 0.5.2 review: a position whose trade began in an earlier session is flattened, the market open
            if (!startTold && now - startedMs >= ChartBridgeAgents.SilenceMs)
            {
                startTold = true;
                foreach (Seat x in seats)
                {
                    List<string> held = roots.Where(y => x.Owns(y)).ToList();
                    if (held.Count == 0) continue;
                    string text = "Agent " + Id + " holds a position or orders on " + string.Join(", ", held) + " on " + x.Name + " since ChartBridge started: its stop and target stay, and it is flattened at " +
                                  Hm(r.FlatAt) + (flatHours ? " (now: outside its trading hours)" : "") + "; check NinjaTrader";
                    Log(text); AgentLog(text); ChartBridgeOrders.AgentAlarm(text);
                }
            }
            if (flatHours) StartFlatten(AtFlatTime(r, etNow) ? Id + " flattened at " + Hm(r.FlatAt) + " by its rules" : fromBefore && !FlatHours(r, etNow) ? Id + " held a position from an earlier session (its " + Hm(r.FlatAt) + " flatten did not finish): flattened by its rules" : Id + " held a position outside its trading hours (" + Hm(r.FlatAt) + " to " + Hm(r.EntryFrom) + (ChartBridgeCme.Closed(etNow) ? ", or the market closed" : "") + "): flattened by its rules", true);
            foreach (Seat x in seats) x.StepFlatten(now);
            PruneSeats();   // 0.6.0: a seat that left the group, now flat with nothing of the agent's there, is dropped
            WelcomeIfCapsChanged();
            SendState(false);   // a change no event carries (the session's roll, the clock, a file): within one pass
            SendAccountState(false);   // 0.5.8: its account's real numbers, when any field but "at" changed
            if (strip) ToPages(StripJson());
        }

        // A stand-down (a clash, or 0.6.2 a stand-down on its group): its open proposals expire, its unfilled entries are cancelled; a
        // position keeps its stop and target and the flat time still runs.
        private void Sweep(string clash)
        {
            List<Proposal> gone;
            lock (Sync) gone = ExpireOpenLocked("expired");
            foreach (Proposal p in gone) { ToPages(ProposalJson(p)); ToAgent(AnswerJson(p.P.Id, "expired", "agent " + Id + " stands down: " + clash)); }
            int n = CancelUnfilled("agent " + Id + " stands down: " + clash);
            if (n > 0 || gone.Count > 0)
            {
                string text = "Agent " + Id + " stands down: " + clash + ": " + n + " unfilled entr" + (n == 1 ? "y" : "ies") + " cancelled; any position keeps its stop and target; its flat time still runs";
                Log(text); AgentLog(text); ToPages(StatusJson("warn", text)); Notify();
            }
        }

        // The roots a flatten looks at: its rules' roots, or (rules file unreadable) every root an agent may trade.
        private List<string> FlatRoots()
        {
            lock (Sync) return rulesBroken != null ? new List<string> { "NQ", "MNQ", "ES", "MES" } : rules.Roots.ToList();
        }

        // An open trade record counts only while something of it is listed (its entry or its legs, by tag) or the ledger follows it;
        // otherwise it is dropped with a warning, so it can never make the agent own a position it did not place.
        // 0.6.0: a record of a group's seat is looked at on that seat (its #seat line); any other on every seat it follows (one
        // account: that one), each only once the executions of those seats were read again after a start.
        private void DropStaleRecords(List<string> roots)
        {
            List<string> open;
            lock (Sync) { HashSet<string> followed = OpenTagsLocked(); open = Trades.Where(kv => double.IsNaN(kv.Value) && !followed.Contains(kv.Key)).Select(kv => kv.Key).ToList(); }
            if (open.Count == 0) return;
            foreach (string key in open)
            {
                string tag = key.Length > 8 ? key.Substring(0, 8) : key;
                string seat = SeatOfTagNow(tag);
                List<Seat> where = seat != null ? AllSeats().Where(x => x.Name == seat).ToList() : AllSeats();
                if (where.Count == 0 || !where.All(x => ChartBridgeServer.ExecutionsReplayed(x.Name))) continue;
                List<Order> orders = new List<Order>();
                foreach (Seat x in where) { Account sa = FindAccount(x.Name); if (sa != null) lock (sa.Orders) orders.AddRange(sa.Orders); }
                if (orders.Any(o => ChartBridgeAgents.TagOf(o.Name) == tag && ChartBridgeOrders.AgentMayFillState(o.OrderState))) continue;
                lock (Sync) { double v; if (Trades.TryGetValue(key, out v) && double.IsNaN(v)) Trades.Remove(key); }
                string text = "Agent " + Id + ": the day file's open trade " + key + " matches nothing ChartBridge sees (no order of it listed, no fill of it this session): dropped, so it never claims a position it did not place";
                Log(text); AgentLog(text); ChartBridgeOrders.AgentWarn(text);
                SaveDay();
                // review A3: a position on its roots there is never left without a word: an error every 60 s until that pair is flat
                foreach (Seat x in where)
                {
                    Account a = FindAccount(x.Name);
                    if (a != null) foreach (string root in roots) { Instrument inst = ChartBridgeServer.InstrumentFor(root); if (inst != null && (ChartBridgeOrders.AgentListed(a, inst) != 0 || ChartBridgeOrders.AgentEffective(a, inst) != 0)) x.TradeLost(root); }
                }
                Notify();
            }
        }

        // The flatten on every seat it follows (onlySeat: that one). Returns how many (seat, contract) jobs started.
        private int StartFlatten(string why, bool byRules) { return StartFlatten(why, byRules, null); }
        private int StartFlatten(string why, bool byRules, string onlySeat)
        {
            int n = 0;
            foreach (Seat x in AllSeats()) if (onlySeat == null || x.Name == onlySeat) n += x.StartFlatten(why, byRules);
            return n;
        }

        // ---------------------------------------------------------- messages from the page
        public string OnPage(string type, Dictionary<string, Val> d)
        {
            if (type == "agentMode") return SetMode(d);
            if (type == "agentKill") return SetKill(d);
            if (type == "agentSeen") return Seen(d);
            if (type == "agentAnswer") return AnswerProposal(d);
            if (type == "agentAccount") return SetAccount(d);
            if (type == "agentRules") return SetRules(d);
            return "unknown message type " + type;
        }

        private string SetMode(Dictionary<string, Val> d) { lock (PlaceGate) return SetModeLocked(d); }   // never between a placement's checks and its order

        private string SetModeLocked(Dictionary<string, Val> d)
        {
            string m = S(d, "mode");
            if (m != "shadow" && m != "copilot" && m != "auto") return "mode must be shadow, copilot or auto";
            if (m == "auto" && NoneNow()) return "auto refused: agent " + Id + "'s account is None: no new entries until an account is chosen on the Agent tab";   // 0.5.7
            if (m == "auto") { string why = AutoProblem(); if (why != null) return "auto refused: " + why; }   // auto: its account must be tradable
            string old;
            List<Proposal> expired = new List<Proposal>();
            lock (Sync)
            {
                old = mode; mode = m;
                if (old == "copilot" && m != "copilot") expired = ExpireOpenLocked("not answered");
            }
            foreach (Proposal p in expired) { ToPages(ProposalJson(p)); ToAgent(AnswerJson(p.P.Id, "not answered", "the mode changed to " + m)); AgentLog("proposal " + p.P.Id + " not answered (the mode changed to " + m + ")"); }
            if (old == "auto" && m != "auto") CancelUnfilled("the mode changed to " + m);   // leaving auto: its unfilled entries go (lead's default)
            Log("agent " + Id + " mode " + m + " (was " + old + "), set by the page");
            AgentLog("mode " + m + " (was " + old + "), set by the page");
            ToAgent(WelcomeJson());
            Notify();
            return null;
        }

        // Auto needs its account tradable (0.6.0, a group: at least one seat tradable, and no clash on any).
        private string AutoProblem()
        {
            if (!GroupNow()) return AccountProblemFor(Account, true) ?? AccountConflict();
            if (ChartBridgeGroups.Unreadable()) return ChartBridgeGroups.ReadFailedText;
            string cw = AccountConflict();
            if (cw != null) return cw;
            List<string> seats = SeatNames();
            if (seats.Count == 0) return AccountWords() + " has no accounts";
            List<string> whys = seats.Select(x => AccountProblemFor(x, true)).ToList();
            return whys.All(x => x != null) ? "no account of " + AccountWords() + " is tradable now (" + string.Join("; ", whys) + ")" : null;
        }

        private string SetKill(Dictionary<string, Val> d) { lock (PlaceGate) return SetKillLocked(d); }
        internal static string KilledWords(double at) { return at > 0 ? "on since " + DateTime.SpecifyKind(new DateTime(1970, 1, 1).AddMilliseconds(at), DateTimeKind.Utc).ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture) + " UTC" : "on"; }   // never between a placement's checks and its order

        private string SetKillLocked(Dictionary<string, Val> d)
        {
            bool on;
            if (!Bool(d, "on", out on)) return "on must be true or false";
            List<Proposal> expired = new List<Proposal>();
            // 0.6.3 (audit C5): saved, so a restart keeps it; a release whose file cannot be removed is refused (it would come back)
            string saveErr = null;
            if (on) { bool was; lock (Sync) was = killed; if (!was) saveErr = ChartBridgeFiles.SaveKill(KillFile, "agent " + Id, ChartBridgeAgents.Now()); }
            else { string err = ChartBridgeFiles.ClearKill(KillFile); if (err != null) return "agent-" + Id + "-kill.txt could not be removed (" + err + "): the kill switch stays on"; }
            lock (Sync) { if (on && !killed) killedAt = ChartBridgeAgents.Now(); killed = on; if (!on) killedAt = 0; if (on) expired = ExpireOpenLocked("not answered"); }
            if (on)
            {
                if (saveErr != null) { string w = "agent-" + Id + "-kill.txt could not be saved (" + saveErr + "): the kill switch is on now but a restart would release it"; ToPages(StatusJson("warn", w)); Log(w); }
                int n = CancelUnfilled("the kill switch is on");
                foreach (Proposal p in expired) { ToPages(ProposalJson(p)); ToAgent(AnswerJson(p.P.Id, "not answered", "the kill switch is on")); }
                string text = "Agent " + Id + ": the kill switch is on: " + n + " unfilled entr" + (n == 1 ? "y" : "ies") + " cancelled; any position keeps its stop and target; every agent order is refused until it is released";
                ToPages(StatusJson("warn", text));
                Log(text); AgentLog(text);
            }
            else { Log("agent " + Id + " kill switch released by the page"); AgentLog("kill switch released by the page"); }
            Notify();
            return null;
        }

        private string Seen(Dictionary<string, Val> d)
        {
            string id = S(d, "id");
            double at;
            if (!Ms(d, "at", out at)) return "at must be page UTC ms (a whole number)";
            Proposal p;
            lock (Sync)
            {
                if (id == null || !Proposals.TryGetValue(id, out p)) return "no proposal " + (id ?? "(none)") + " from agent " + Id;
                if (p.SeenAt >= 0) return null;
                p.SeenAt = at;
            }
            AgentLog("proposal " + id + " seen on the page at " + at.ToString("0", CultureInfo.InvariantCulture));
            ToPages(ProposalJson(p));
            return null;
        }

        // Anthony's answer. Accept places the order from the PROPOSAL's own parameters (the page sends none), through every check
        // again; with under 5 s of its expiry left it is refused as expired. The entry works only the time left.
        private string AnswerProposal(Dictionary<string, Val> d)
        {
            string id = S(d, "id"), answer = S(d, "answer");
            double at;
            if (answer != "accept" && answer != "reject") return "answer must be accept or reject";
            if (!Ms(d, "at", out at)) return "at must be page UTC ms (a whole number)";
            Proposal p;
            bool late = false;
            lock (Sync)
            {
                if (id == null || !Proposals.TryGetValue(id, out p)) return "no proposal " + (id ?? "(none)") + " from agent " + Id;
                if (p.State != "open") return "proposal " + id + " is " + p.State + "; it can no longer be answered";
                p.AnsweredAt = at;
                if (answer == "accept" && p.P.ExpiresAt - Now() < ChartBridgeAgents.AcceptMinLeftMs) { p.State = "expired"; late = true; }
                else p.State = answer == "accept" ? "accepting" : "rejected";
            }
            if (late)
            {
                ToPages(ProposalJson(p));
                ToAgent(AnswerJson(id, "expired", "accepted with under 5 s of its expiry left: not placed"));
                AgentLog("proposal " + id + " accepted with under 5 s left: expired, nothing placed");
                Notify();
                return "proposal " + id + " expired (under 5 s left): nothing placed";
            }
            if (answer == "reject")
            {
                ToPages(ProposalJson(p));
                ToAgent(AnswerJson(id, "rejected", "rejected on the page"));
                AgentLog("proposal " + id + " rejected on the page");
                Notify();
                return null;
            }
            Order placed;
            string why = Place(p.P, p.Account, out placed), withdrawn;
            lock (Sync) { p.State = why == null ? "accepted" : "rejected"; p.Entry = placed; withdrawn = p.WithdrawnWhy; }
            bool cancelled = false;
            if (why == null && withdrawn != null && placed != null)   // 0.6.0: every seat's entry of it
                foreach (Order e in p.P.Orders != null ? p.P.Orders.Where(x => x != null).ToList() : new List<Order> { placed })
                    if (Cancel(e, "withdrawn by the agent during placement: " + withdrawn)) cancelled = true;
            if (cancelled) lock (Sync) p.State = "withdrawn";
            ToPages(ProposalJson(p));
            if (why == null)
            {
                ToAgent(AnswerJson(id, "accepted", "accepted on the page"));
                if (p.P.SeatNames != null && !cancelled) SeatAnswers(p.P);   // 0.6.0: one answer per seat, then the plan's
                ToAgent(AnswerJson(id, cancelled ? "withdrawn" : "placed", cancelled ? "withdrawn during placement: its entry is cancelled" : p.P.SeatNames != null ? PlacedWords(p.P) : "placed on " + p.Account + " as order " + ChartBridgeOrders.AgentIdFor(placed) + "; it works until " + Iso(p.P.ExpiresAt)));
            }
            else { lock (Sync) nRefused++; ToAgent(AnswerJson(id, "refused", why)); }
            AgentLog("proposal " + id + " accepted on the page" + (why == null ? ": placed on " + KeyWords(p.Account) + (cancelled ? " and withdrawn during placement" : "") + SeatsSaid(p.P) : " but refused: " + why));
            Notify();
            return why == null ? null : "accepted, but refused: " + why;
        }

        // agentAccount (ruling 1): refused for the bot's account, the copier's leader or any follower (on or off), another agent's
        // account, an account not tradable now, while this agent has a position, a working entry or a proposal, and while the old or
        // the new account holds any position or working order on the agent's roots (as botAccount). Saved; the agent gets welcome.
        // 0.5.2 (Anthony 2026-10-08): the agent keeps its mode when keepMode names it (until 0.5.1, and for a page that does not
        // send keepMode or names another mode, a change puts it in shadow).
        private string SetAccount(Dictionary<string, Val> d) { lock (PlaceGate) return SetAccountLocked(d); }   // never between a placement's checks and its order

        private string SetAccountLocked(Dictionary<string, Val> d)
        {
            string nm = S(d, "account"), keep = S(d, "keepMode");
            if (d.ContainsKey("keepMode") && keep != "shadow" && keep != "copilot" && keep != "auto") return "keepMode must be shadow, copilot or auto (the mode the page's question named)";
            bool lg = false;   // 0.6.2: league (a league seat: one Sim account, never a group)
            if (d.ContainsKey("league") && !Bool(d, "league", out lg)) return "league must be true or false";
            if (d.ContainsKey("group"))   // 0.6.0: a whole group (every member a seat)
            {
                if (d.ContainsKey("account")) return "agentAccount takes account or group, not both";
                if (lg) return "a league seat is one Sim account, never a group";
                string gid = S(d, "group");
                if (gid == null || !GroupIdRx.IsMatch(gid)) return "group must be a group id (a plain string such as g1)";
                return SetGroupLocked(gid, keep);
            }
            Val nv;
            if (d.TryGetValue("account", out nv) && nv.K == 'z')   // 0.5.7: null is None, refused while the agent is exposed
            {
                if (lg) return "a league seat needs its Sim account (league goes with an account, never None)";
                if (Exposed()) return "agent " + Id + " has a position, a working entry or a proposal: choose None when it is flat";
                // review of #47: and while its account holds any position or working order (a trade it lost included): the reset's rule
                string cur = Account;
                if (!ChartBridgeBranches.IsNone(cur) && !ChartBridgeBranches.Idle(FindAccount(cur))) return "agent " + Id + "'s account " + cur + " has a position or a working order: choose None when it is flat";
                List<string> busy = SeatNames().Where(x => !ChartBridgeBranches.Idle(FindAccount(x))).ToList();   // 0.6.0: a group's seats too
                if (GroupNow() && busy.Count > 0) return "agent " + Id + "'s " + AccountWords() + ": " + string.Join(", ", busy) + (busy.Count == 1 ? " has" : " have") + " a position or a working order: choose None when every seat is flat";
                return GoNone("set by the page", keep);
            }
            if (!PlainName(nm) || ChartBridgeBranches.IsNone(nm)) return "account must be an account name, or null for None";
            ChartBridgeAgents.RefreshFiles();   // a page's thread: the copies are read fresh
            string bot = ChartBridgeAgents.BotAccountForAgents();   // on or off (lead's default)
            if (bot == null) return "bot-account.txt cannot be read or understood, so ChartBridge cannot tell the bot's account: fix or delete it first";
            if (string.Equals(nm, bot, StringComparison.OrdinalIgnoreCase)) return nm + " is the bot's account: an agent never trades it";
            string cw = ChartBridgeAgents.CopierUses(nm);
            if (cw != null) return cw + ": an agent never trades it";
            foreach (ChartBridgeAgent other in ChartBridgeAgents.All())
                if (other != this && other.Claims(nm)) return nm + " is agent " + other.Id + "'s account: each agent has its own";   // 0.6.0: a seat of another agent's group too
            string why = AccountProblemFor(nm, true);
            if (why != null) return why;
            if (lg && !SeatSim(nm)) return LeagueRefusal + " (" + nm + " is not NinjaTrader's simulator)";   // 0.6.2: read fresh; an unknown provider is no Sim
            if (Exposed()) return "agent " + Id + " has a position, a working entry or a proposal: choose its account when it is flat";
            string old = Account;
            bool broken, wasGroup = GroupNow(), wasLeague = League;
            lock (Sync) broken = accountBroken != null;
            if (nm == old && !broken && Chosen && !wasGroup && lg == wasLeague) return null;   // already its chosen account (choosing its unchosen default writes the file: it is then its own); 0.6.2: and as a league seat or not
            foreach (string root in RulesNow().Roots)
            {
                if (ChartBridgeOrders.AgentHoldsOnRoot(FindAccount(nm), root)) return nm + " holds a position or a working order on " + root + ": choose agent " + Id + "'s account when both accounts are flat on its roots";
                if (nm != old && ChartBridgeOrders.AgentHoldsOnRoot(FindAccount(old), root)) return "agent " + Id + "'s account " + old + " holds a position or a working order on " + root + ": choose its account when both accounts are flat on its roots";
                if (wasGroup) foreach (string x in SeatNames()) if (x != nm && ChartBridgeOrders.AgentHoldsOnRoot(FindAccount(x), root)) return "agent " + Id + "'s seat " + x + " holds a position or a working order on " + root + ": choose its account when every seat is flat on its roots";
            }
            if (wasGroup) old = AccountWords();
            else if (wasLeague) old += " (league seat)";
            string err = lg ? SaveLeague(nm) : SaveAccount(nm);
            if (err != null) return "agent-" + Id + "-account.txt could not be saved (" + err + "); nothing changed";
            // 0.5.2 (Anthony 2026-10-08): the mode is kept only when the page says which mode its question named (keepMode) and that is
            // still the agent's mode; an older page (no keepMode, its question says the agent goes to Shadow) or a mode changed since
            // the question (another page) puts the agent in shadow, as until 0.5.1.
            string wasMode;
            bool kept;
            lock (Sync) { account = nm; groupId = null; accountBroken = null; chosen = true; league = lg; wasMode = mode; kept = keep != null && keep == mode; if (!kept) mode = "shadow"; }
            RefreshSeats(false);   // 0.6.0: its one seat (seatsRev up); the old seats are dropped (nothing of the agent's is left there)
            string mark = (SimNow() ? "Sim" : "LIVE") + (lg ? ", a league seat" : "");
            string modeSay = kept ? "mode " + wasMode + " kept" : wasMode == "shadow" ? "mode shadow" : "mode shadow (was " + wasMode + (keep == null ? ": the page did not say which mode it showed" : ": the page's question named " + keep) + ")";
            Log("agent " + Id + " account " + nm + " (" + mark + "), was " + old + ", set by the page; " + modeSay);
            AgentLog("account " + nm + " (" + mark + "), was " + old + ", set by the page; " + modeSay);
            ToAgent(WelcomeJson());
            Notify();
            return null;
        }

        // The agent on None: saved, the agent told (welcome); its mode kept as an account change keeps it (keepMode), else shadow.
        // 0.6.0: from a group too; a seat that still holds the agent's trade (its group was deleted) stays its own until flat.
        private string GoNone(string by, string keep)
        {
            string old = GroupNow() ? AccountWords() : Account;
            bool broken;
            lock (Sync) broken = accountBroken != null;
            if (NoneNow() && !broken) return null;
            string err = SaveAccount(ChartBridgeBranches.None);
            if (err != null) return "agent-" + Id + "-account.txt could not be saved (" + err + "); nothing changed";
            string wasMode;
            bool kept;
            lock (Sync) { account = ChartBridgeBranches.None; groupId = null; accountBroken = null; chosen = false; league = false; wasMode = mode; kept = keep != null && keep == mode; if (!kept) mode = "shadow"; }
            RefreshSeats(false);   // no seat now (seatsRev up); a seat with nothing of the agent's left is dropped
            List<string> held = AllSeats().Select(x => x.Name).ToList();
            string say = "account None (nothing trades), was " + old + ", " + by + "; " + (kept || wasMode == "shadow" ? "mode " + wasMode + (kept ? " kept" : "") : "mode shadow (was " + wasMode + ")") +
                         (held.Count > 0 ? "; " + string.Join(", ", held) + " still " + (held.Count == 1 ? "holds" : "hold") + " its trade: owned and protected until flat, no new entry" : "");
            Log("agent " + Id + " " + say); AgentLog(say);
            ToAgent(WelcomeJson());
            Notify();
            return null;
        }

        // The daily reset (ChartBridgeBranches.Run): "" when the agent is on None now, a note when it keeps its account, null when
        // nothing was to do. Its mode is kept (nothing trades on None anyway).
        public string ResetToNone()
        {
            lock (PlaceGate)
            {
                string acct = Account;
                if (NoneNow() || ChartBridgeBranches.KeepThroughReset("agent:" + Id, GroupNow() ? KeyNow() : acct)) return null;
                if (GroupNow())   // 0.6.0: None only when no seat is exposed and every member is idle; else the words name the accounts holding something
                {
                    List<string> busy = AllSeats().Where(x => x.Exposed() || !ChartBridgeBranches.Idle(FindAccount(x.Name))).Select(x => x.Name).ToList();
                    if (busy.Count > 0 || Exposed()) return "agent " + Id + " stays on " + AccountWords() + ": " + (busy.Count > 0 ? string.Join(", ", busy) + (busy.Count == 1 ? " has" : " have") : "it has") + " a position or a working order (it goes to None at a later reset once flat, or choose None yourself)";
                }
                else if (Exposed() || !ChartBridgeBranches.Idle(FindAccount(acct))) return ChartBridgeBranches.SkipWords("agent " + Id, acct);
                string keep;
                lock (Sync) keep = mode;
                string why = GoNone("by the daily reset (17:00 ET)", keep);
                return why == null ? "" : "agent " + Id + " stays on " + acct + ": " + why;
            }
        }

        // 0.6.0: on any seat it follows.
        private bool Exposed()
        {
            bool ex;
            lock (Sync) ex = Seats.Values.Any(x => x.openTag != null) || Proposals.Values.Any(p => p.State == "open" || p.State == "accepting");
            return ex || WorkingEntries().Count > 0 || FlatRoots().Any(r => Owns(r));   // rules file unreadable: every root an agent may trade
        }

        // 0.6.0: agentAccount with a group: every member a seat. Refused when the group has no account, when a member is the bot's, the
        // copier's leader or a follower (on or off), another agent's, Backtest or Playback, or not in NinjaTrader; while this agent has
        // a position, a working entry or a proposal; and while a member, or a seat it trades now, holds any position or working order
        // on its roots (as for one account). A member that is not tradable or connected now is taken: it sits out each trade until it is.
        private string SetGroupLocked(string gid, string keep)
        {
            ChartBridgeAgents.RefreshFiles();   // a page's thread: the copies are read fresh
            if (ChartBridgeGroups.Unreadable()) return ChartBridgeGroups.ReadFailedText + "; nothing changed";
            List<string> members = ChartBridgeGroups.MembersOf(gid);
            string gname = ChartBridgeGroups.NameOf(gid);
            if (members == null) return "there is no group " + gid;
            if (members.Count == 0) return "group " + gname + " has no accounts: put accounts in it on the Accounts tab first";
            string bot = ChartBridgeAgents.BotAccountForAgents();
            if (bot == null) return "bot-account.txt cannot be read or understood, so ChartBridge cannot tell the bot's account: fix or delete it first";
            foreach (string m in members)
            {
                string w = MemberProblem(m, bot);
                if (w != null) return "group " + gname + ": " + w;
            }
            if (Exposed()) return "agent " + Id + " has a position, a working entry or a proposal: choose its account when it is flat";
            string old = GroupNow() ? AccountWords() : Account;
            bool broken;
            lock (Sync) broken = accountBroken != null;
            if (OnGroup(gid) && !broken && Chosen) return null;   // already its group
            List<string> now = SeatNames();
            foreach (string root in RulesNow().Roots)
            {
                foreach (string m in members) if (ChartBridgeOrders.AgentHoldsOnRoot(FindAccount(m), root)) return m + " holds a position or a working order on " + root + ": choose group " + gname + " for agent " + Id + " when every account in it is flat on its roots";
                foreach (string x in now) if (!members.Contains(x) && ChartBridgeOrders.AgentHoldsOnRoot(FindAccount(x), root)) return "agent " + Id + "'s account " + x + " holds a position or a working order on " + root + ": choose its account when it is flat on its roots";
            }
            string err = SaveGroup(gid);
            if (err != null) return "agent-" + Id + "-account.txt could not be saved (" + err + "); nothing changed";
            string wasMode;
            bool kept;
            lock (Sync) { account = ChartBridgeBranches.None; groupId = gid; accountBroken = null; chosen = true; league = false; wasMode = mode; kept = keep != null && keep == mode; if (!kept) mode = "shadow"; }
            RefreshSeats(false);
            string mark = SimNow() ? "Sim" : "LIVE";
            string modeSay = kept ? "mode " + wasMode + " kept" : wasMode == "shadow" ? "mode shadow" : "mode shadow (was " + wasMode + (keep == null ? ": the page did not say which mode it showed" : ": the page's question named " + keep) + ")";
            Log("agent " + Id + " account " + AccountWords() + " (" + mark + "), was " + old + ", set by the page; seatsRev " + SeatsRevNow() + "; " + modeSay);
            AgentLog("account " + AccountWords() + " (" + mark + "), was " + old + ", set by the page; seatsRev " + SeatsRevNow() + "; " + modeSay);
            ToAgent(WelcomeJson());
            Notify();
            return null;
        }

        // Why a group's member cannot be one of this agent's seats, or null (the same rules as one account; not its tradability now).
        private string MemberProblem(string m, string bot)
        {
            if (!PlainName(m)) return m + " is not an account name ChartBridge can trade";
            string why = AccountProblemFor(m, false);
            if (why != null) return why;
            if (string.Equals(m, bot, StringComparison.OrdinalIgnoreCase)) return m + " is the bot's account: an agent never trades it";
            string cw = ChartBridgeAgents.CopierUses(m);
            if (cw != null) return cw + ": an agent never trades it";
            foreach (ChartBridgeAgent other in ChartBridgeAgents.All()) if (other != this && other.Claims(m)) return m + " is agent " + other.Id + "'s account: each agent has its own";
            return null;
        }

        // agentRules: flat keys (the strict parser allows no nesting): roots "NQ,MNQ", maxQty<ROOT> for a root named (left out: the
        // hard ceiling; for a root not named only 0 is accepted), entryFrom, entryUntil, flatAt (HH:MM New York), maxExpireSec,
        // maxTrades and maxLosses (0 = none).
        private string SetRules(Dictionary<string, Val> d) { lock (PlaceGate) return SetRulesLocked(d); }   // never between a placement's checks and its order

        private string SetRulesLocked(Dictionary<string, Val> d)
        {
            Rules r = new Rules();
            string roots = S(d, "roots");
            if (roots == null) return "roots must be a list like \"NQ,MNQ\"";
            r.Roots = roots.Split(',').Select(x => x.Trim().ToUpperInvariant()).Where(x => x.Length > 0).ToList();
            r.MaxQty = new Dictionary<string, int>();
            foreach (string root in r.Roots)
            {
                int q;
                if (ChartBridgeAgents.HardCeiling(root) == 0) return root + " is not a root an agent may trade (NQ, MNQ, ES, MES)";
                int has = Whole(d, "maxQty" + root, out q);
                if (has < 0) return "maxQty" + root + " must be a whole number";
                r.MaxQty[root] = has == 1 ? q : ChartBridgeAgents.HardCeiling(root);   // left out: the hard ceiling
                if (ChartBridgeConfig.QuoteOnly(root) || ChartBridgeServer.InstrumentFor(root) == null) return root + " is not traded by ChartBridge (roots, quoteRoots in config.txt)";
            }
            foreach (string k in new[] { "maxQtyNQ", "maxQtyMNQ", "maxQtyES", "maxQtyMES" })
            {
                int q;
                if (!d.ContainsKey(k)) continue;
                if (Whole(d, k, out q) != 1) return k + " must be a whole number";
                if (!r.Roots.Contains(k.Substring(6)) && q != 0) return k + " is for a root not in roots: send 0 or leave it out";
            }
            r.EntryFrom = ParseHm(S(d, "entryFrom")); r.EntryUntil = ParseHm(S(d, "entryUntil")); r.FlatAt = ParseHm(S(d, "flatAt"));
            if (r.EntryFrom < 0 || r.EntryUntil < 0 || r.FlatAt < 0) return "entryFrom, entryUntil and flatAt must be HH:MM (New York time)";
            int n;
            if (Whole(d, "maxExpireSec", out n) != 1) return "maxExpireSec must be a whole number from 60 to 1800";
            r.MaxExpireSec = n;
            if (Whole(d, "maxTrades", out n) != 1) return "maxTrades must be a whole number (0 = none)";
            r.MaxTrades = n;
            if (Whole(d, "maxLosses", out n) != 1) return "maxLosses must be a whole number (0 = none)";
            r.MaxLosses = n;
            string bad = RulesProblem(r);
            if (bad != null) return bad;
            // 0.5.4 (Anthony 2026-10-10, DECISION ag: "I do not want to be locked out of changing the time ... during live trading"):
            // while the agent has a position, a working entry or an open proposal, its window (entryFrom, entryUntil, flatAt) may
            // still change, inside the same limits; every other rule waits until it is flat. The new window rules at once: a flat
            // time already passed, or a start after now, puts it in its flat hours (FlatHours) and its position is flattened by its
            // rules; an entry or a proposal outside the new window ends as at the window's end.
            // the rules file could not be read (the rules in force are placeholder defaults): no change while exposed, not even the
            // window, since it would be measured against those defaults and would clear the broken file's stand-down
            bool broken; lock (Sync) broken = rulesBroken != null;
            if (broken && Exposed()) return "agent-" + Id + "-rules.txt could not be read: agent " + Id + " has a position, a working entry or an open proposal, so its rules cannot change until it is flat (or the file reads again)";
            if (Exposed() && !SameButWindow(RulesNow(), r)) return "agent " + Id + " has a position, a working entry or an open proposal: only its window (entries from, until, flat at) can change now; change its other rules when it is flat";
            string err = SaveRules(r);
            if (err != null) return "agent-" + Id + "-rules.txt could not be saved (" + err + "); nothing changed";
            lock (Sync) { rules = r; rulesBroken = null; StandDownLocked(); }   // a loss stand-down already held stays (lead's default)
            SaveDay();
            string said = RulesText(r);
            Log("agent " + Id + " rules set by the page: " + said);
            AgentLog("rules set by the page: " + said);
            ToAgent(WelcomeJson());
            Notify();
            return null;
        }

        // The two rule sets differ in the window alone (entryFrom, entryUntil, flatAt): the same roots in the same order, each root's
        // maxQty, maxExpireSec, maxTrades and maxLosses.
        private static bool SameButWindow(Rules a, Rules b)
        {
            return a.Roots.SequenceEqual(b.Roots) && a.Roots.All(x => a.QtyFor(x) == b.QtyFor(x)) && a.MaxExpireSec == b.MaxExpireSec && a.MaxTrades == b.MaxTrades && a.MaxLosses == b.MaxLosses;
        }

        // 0.5.2: why an entry is refused outside the window: the market closed, or the time.
        private string WindowRefusal(Rules r, DateTime et)
        {
            return ChartBridgeCme.Closed(et) ? "the market is closed now (the 17:00 to 18:00 break, the weekend, a CME holiday or a holiday halt): no entry for agent " + Id
                                             : "outside agent " + Id + "'s entry window (" + WindowText(r) + ")";
        }

        private static string RulesText(Rules r)
        {
            return "roots " + string.Join(",", r.Roots) + ", maxQty " + string.Join(" ", r.Roots.Select(x => x + " " + r.QtyFor(x))) + ", entries " + Hm(r.EntryFrom) + " to " + Hm(r.EntryUntil) +
                   ", flat at " + Hm(r.FlatAt) + ", maxExpireSec " + r.MaxExpireSec + ", maxTrades " + (r.MaxTrades > 0 ? r.MaxTrades.ToString(CultureInfo.InvariantCulture) : "none") +
                   ", maxLosses " + (r.MaxLosses > 0 ? r.MaxLosses.ToString(CultureInfo.InvariantCulture) : "none");
        }

        // Under Sync: every open proposal ends (never placed).
        private List<Proposal> ExpireOpenLocked(string state)
        {
            List<Proposal> list = new List<Proposal>();
            foreach (Proposal p in Proposals.Values) if (p.State == "open") { p.State = state; list.Add(p); }
            return list;
        }

        // A signed-in v3 page: this agent's strip, its open proposals, its last 50 plans and its last 200 notes.
        public void Replay(ChartBridgeClient c)
        {
            c.Send(StripJson());
            List<Proposal> open;
            List<string> plans, notes;
            lock (Sync) { open = Proposals.Values.Where(p => p.State == "open").ToList(); plans = PlansShown.ToList(); notes = Notes.ToList(); }
            foreach (Proposal p in open) c.Send(ProposalJson(p));
            foreach (string j in plans) c.Send(j);
            foreach (string j in notes) c.Send(j);
        }

        // ---------------------------------------------------------- messages out
        private void ToAgent(string json)
        {
            ChartBridgeClient c;
            lock (Sync) c = client;
            if (c != null) c.Send(json);
        }

        private static void ToPages(string json) { ChartBridgeV3.SendToV3Traders(json); }

        private void Notify()
        {
            ToPages(StripJson());
            SendState(false);
            SendAccountState(false);   // 0.5.8: an account or rules change reaches accountState at once
        }

        // 0.5.8: accountState (PROTOCOL.md "Prop groups and account state"): after the snapshot of every hello, then whenever any
        // field but "at" changed. Built with no lock of the agent's held (it reads NinjaTrader's collections), as agentState.
        private readonly object AccountStateLock = new object();
        private readonly Dictionary<string, string> lastAccountStateKeys = new Dictionary<string, string>();   // 0.6.0: per account
        private long accountStateSeq, lastAccountStateSeq;
        private bool snapshotSent;

        // 0.6.0: one accountState per seat it follows (AllSeats: the seats in seat order, then any that left while it holds the
        // agent's trade, until flat), each sent when it changed; with no seat, its account (None's state on None or an empty group).
        internal void SendAccountState(bool force)
        {
            ChartBridgeClient c;
            lock (Sync) c = helloed && welcomeSent && snapshotSent ? client : null;
            if (c == null) return;
            List<string> accts = AllSeats().Select(x => x.Name).ToList();
            if (accts.Count == 0) lock (Sync) accts.Add(groupId != null ? ChartBridgeBranches.None : account);
            long seq = Interlocked.Increment(ref accountStateSeq);
            List<string[]> built = new List<string[]>();
            foreach (string acct in accts)
            {
                string key, json;
                try { json = ChartBridgeGroups.AccountStateJson(acct, out key); }
                catch (Exception ex) { Log("agent " + Id + " accountState error: " + ex.Message); return; }
                built.Add(new[] { acct, key, json });
            }
            lock (AccountStateLock)
            {
                if (seq < lastAccountStateSeq) return;   // a newer one was sent meanwhile
                List<string> send = new List<string>();
                lock (Sync)
                {
                    if (client != c) return;
                    foreach (string[] x in built)
                    {
                        string was;
                        lastAccountStateKeys.TryGetValue(x[0], out was);
                        if (force || x[1] != was) { lastAccountStateKeys[x[0]] = x[1]; send.Add(x[2]); }
                    }
                    foreach (string k in lastAccountStateKeys.Keys.Where(k => !accts.Contains(k)).ToList()) lastAccountStateKeys.Remove(k);
                }
                lastAccountStateSeq = seq;
                foreach (string j in send) c.Send(j);
            }
        }

        // agentState to the agent: always after its hello, else only when a field changed (section 10). The state is built with no
        // lock of the agent's held (its readings take NinjaTrader's collection locks on NinjaTrader's threads; review A C3); a
        // sequence number taken first keeps an older state from ever following a newer one; StateLock only compares and sends.
        private readonly object StateLock = new object();
        private string lastStateSent;
        private long stateSeq, lastStateSeq;

        private bool welcomeSent;   // agentState waits for the welcome of the latest hello (review E3)

        private void SendState(bool force)
        {
            ChartBridgeClient c;
            lock (Sync) c = helloed && welcomeSent ? client : null;
            if (c == null) return;
            long seq = Interlocked.Increment(ref stateSeq);
            string json = StateJson();
            lock (StateLock)
            {
                if (seq < lastStateSeq) return;   // a newer state was sent meanwhile
                lock (Sync) { if (client != c) return; if (!force && json == lastStateSent) return; lastStateSent = json; }
                lastStateSeq = seq;
                c.Send(json);
            }
        }

        // An order or position change on this agent's account: on one of its roots (or of an unknown contract), agentState again
        // if it changed.
        public void StateChanged(Instrument inst)
        {
            bool on;
            lock (Sync) on = helloed && client != null;
            if (!on) return;
            if (inst != null) { string root = ChartBridgeServer.RootFor(inst); if (root != null && !FlatRoots().Contains(root)) return; }
            SendState(false);
        }

        // A plan id seen today: true when it is new (now used), false when it was used before or is not an id at all.
        private bool UseId(string id)
        {
            if (id == null || id.Length < 1 || id.Length > 40) return false;
            bool fresh, broken;
            lock (DayFileLock)   // the id and its line together: a whole write either has it or comes before the line (review B)
            {
                lock (Sync) { fresh = PlanIds.Add(id); broken = dayBroken != null; }
                if (fresh && !broken) AppendDay("plan\t" + id);
            }   // appended (review B-S1): the whole file is written on the roll and on trades
            return fresh;
        }

        private void ShowPlan(Plan p) { ShowPlan(p, true); }

        private double lastRefusedShownMs = -1e18;
        private int refusedHeld;
        private Plan heldPlan;      // the latest refused plan held back (shown by the timer's flush with the count of the others)
        private bool heldStore;

        private void ShowPlan(Plan p, bool store)
        {
            if (p.Result != null && p.Result.StartsWith("refused: ", StringComparison.Ordinal))
            {
                // Refused plans reach the pages at most once a second per agent (review B-S1); the one shown says how many were held.
                double now = Now();
                int held;
                lock (Sync)
                {
                    if (now - lastRefusedShownMs < 1000) { refusedHeld++; heldPlan = p; heldStore = store; return; }
                    lastRefusedShownMs = now; held = refusedHeld; refusedHeld = 0; heldPlan = null;
                }
                if (held > 0) p.Result += " (and " + held + " more refused plan" + (held == 1 ? "" : "s") + " in the second before, not shown)";
            }
            ShowPlanNow(p, store);
        }

        // The timer's flush (review B): refused plans held back are told within about a second even when no other plan follows: the
        // latest of them is shown with the count of the rest.
        private void FlushRefused(double now)
        {
            Plan p;
            bool store;
            int others;
            lock (Sync)
            {
                if (heldPlan == null || now - lastRefusedShownMs < 1000) return;
                p = heldPlan; store = heldStore; others = refusedHeld - 1;
                heldPlan = null; refusedHeld = 0; lastRefusedShownMs = now;
            }
            if (others > 0) p.Result += " (and " + others + " more refused plan" + (others == 1 ? "" : "s") + " in the second before, not shown)";
            ShowPlanNow(p, store);
        }

        private void ShowPlanNow(Plan p, bool store)
        {
            string json = PlanJson(p);
            if (!store) { ToPages(json); return; }
            lock (Sync)
            {
                if (p.Action == "plan") lastPlanJson = json;
                PlansShown.AddLast(json);
                while (PlansShown.Count > ChartBridgeAgents.PlansKept) PlansShown.RemoveFirst();
            }
            ToPages(json);
        }

        private static string Reject(string id, string reason)
        {
            return "{\"type\":\"reject\",\"id\":" + (id != null ? CbJson.Str(id) : "null") + ",\"reason\":" + CbJson.Str(reason) + "}";
        }

        private static string StatusJson(string level, string text) { return "{\"type\":\"status\",\"level\":" + CbJson.Str(level) + ",\"text\":" + CbJson.Str(text) + "}"; }

        private static string AnswerJson(string id, string answer, string text) { return AnswerJson(id, answer, text, null); }
        // 0.6.0: account, for one seat of a group plan (a plan-level answer, and every answer for one account, has none).
        private static string AnswerJson(string id, string answer, string text, string account)
        {
            return "{\"type\":\"answer\",\"id\":" + CbJson.Str(id) + ",\"answer\":" + CbJson.Str(answer) + ",\"text\":" + CbJson.Str(text) + (account != null ? ",\"account\":" + CbJson.Str(account) : "") + "}";
        }

        private static string Ms(double v) { return v >= 0 ? v.ToString("0", CultureInfo.InvariantCulture) : "null"; }
        private static string Iso(double ms) { return new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(ms).ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture); }
        private static string Raw(string t) { return t ?? "null"; }
        private static string Str(string s) { return s != null ? CbJson.Str(s) : "null"; }

        // welcome.rules (contract section 10 item 8): the caps ChartBridge really enforces on this agent's entries: per root the
        // smallest of its rule, the hard ceiling and gate 3's config cap for agents (AgentCap: MNQ 20 whatever config.txt says), plus
        // config.txt's maxBracketTicks and maxTicksAway (null when not set). The pages' strip keeps the agent's own rules.
        private static string EnforcedRulesJson(Rules r)
        {
            string own = RulesJson(r);
            StringBuilder q = new StringBuilder("\"maxQty\":{");
            q.Append(string.Join(",", r.Roots.Select(x => CbJson.Str(x) + ":" + EnforcedQty(r, x).ToString(CultureInfo.InvariantCulture)).ToArray())).Append('}');
            int i = own.IndexOf("\"maxQty\":{", StringComparison.Ordinal), j = own.IndexOf('}', i);
            string body = own.Substring(0, i) + q + own.Substring(j + 1);
            int mb = ChartBridgeOrders.AgentMaxBracketTicks, ma = ChartBridgeOrders.AgentMaxTicksAway;
            return body.Substring(0, body.Length - 1) + ",\"maxBracketTicks\":" + (mb > 0 ? mb.ToString(CultureInfo.InvariantCulture) : "null") +
                   ",\"maxTicksAway\":" + (ma > 0 ? ma.ToString(CultureInfo.InvariantCulture) : "null") + "}";
        }

        private string lastWelcomeRules;   // the rules the agent's last welcome carried
        private string NoteWelcomeRules(string json) { lock (Sync) lastWelcomeRules = json; return json; }

        // Every pass: a cap ChartBridge enforces changed (config.txt read again, the rules, the switches): welcome again.
        private void WelcomeIfCapsChanged()
        {
            string was;
            bool on;
            lock (Sync) { was = lastWelcomeRules; on = helloed && client != null; }
            if (!on || was == null) return;
            if (EnforcedRulesJson(RulesNow()) != was) ToAgent(WelcomeJson());
        }

        private static int EnforcedQty(Rules r, string root) { return Math.Min(Math.Min(r.QtyFor(root), ChartBridgeAgents.HardCeiling(root)), ChartBridgeOrders.AgentCap(root)); }

        private static string RulesJson(Rules r)
        {
            StringBuilder b = new StringBuilder("{\"roots\":[");
            b.Append(string.Join(",", r.Roots.Select(x => CbJson.Str(x)).ToArray())).Append("],\"maxQty\":{");
            b.Append(string.Join(",", r.Roots.Select(x => CbJson.Str(x) + ":" + r.QtyFor(x).ToString(CultureInfo.InvariantCulture)).ToArray())).Append('}');
            b.Append(",\"entryFrom\":").Append(CbJson.Str(Hm(r.EntryFrom))).Append(",\"entryUntil\":").Append(CbJson.Str(Hm(r.EntryUntil))).Append(",\"flatAt\":").Append(CbJson.Str(Hm(r.FlatAt)))
             .Append(",\"maxExpireSec\":").Append(r.MaxExpireSec)
             .Append(",\"maxTrades\":").Append(r.MaxTrades > 0 ? r.MaxTrades.ToString(CultureInfo.InvariantCulture) : "null")
             .Append(",\"maxLosses\":").Append(r.MaxLosses > 0 ? r.MaxLosses.ToString(CultureInfo.InvariantCulture) : "null");
            return b.Append('}').ToString();
        }

        private string PlanFields(Plan p)
        {
            return ",\"root\":" + Str(p.Root) + ",\"side\":" + Str(p.Side) + ",\"kind\":" + Str(p.Kind) + ",\"price\":" + Raw(p.PriceText) + ",\"limitPrice\":" + Raw(p.LimitText) +
                   ",\"qty\":" + (p.HasQty ? p.Qty.ToString(CultureInfo.InvariantCulture) : "null") + ",\"stopTicks\":" + (p.HasStop ? p.StopTicks.ToString(CultureInfo.InvariantCulture) : "null") +
                   ",\"targetTicks\":" + (p.HasTarget ? p.TargetTicks.ToString(CultureInfo.InvariantCulture) : "null") + ",\"expireSec\":" + (p.HasExpire ? p.ExpireSec.ToString(CultureInfo.InvariantCulture) : "null") +
                   ",\"riskDollars\":" + Raw(p.RiskText) + ",\"setup\":" + Str(p.Setup) + ",\"reason\":" + Str(p.Reason) + ",\"confidence\":" + Raw(p.ConfText) + SeatFields(p);
        }

        // 0.6.0: a group plan's sizes, seatsRev and, once checked, each seat: its size, its risk and why it is not in this trade (null:
        // it is), and its result once placed. Nothing for a plan on one account (as before).
        private static string SeatFields(Plan p)
        {
            if (p.SizesText == null && p.SeatNames == null) return "";
            StringBuilder b = new StringBuilder();
            b.Append(",\"sizes\":").Append(Str(p.SizesText)).Append(",\"seatsRev\":").Append(p.HasSeatsRev ? p.SeatsRev.ToString(CultureInfo.InvariantCulture) : "null");
            if (p.SeatNames == null) return b.ToString();
            Instrument inst = ChartBridgeServer.InstrumentFor((p.Root ?? "").ToUpperInvariant());
            double tick = inst != null ? inst.MasterInstrument.TickSize : 0, pv = inst != null ? inst.MasterInstrument.PointValue : 0;
            b.Append(",\"seats\":[");
            for (int i = 0; i < p.SeatNames.Length; i++)
            {
                if (i > 0) b.Append(',');
                string r = p.Results != null ? p.Results[i] : null;
                b.Append("{\"account\":").Append(CbJson.Str(p.SeatNames[i])).Append(",\"size\":").Append(p.Sizes[i].ToString(CultureInfo.InvariantCulture))
                 .Append(",\"risk\":").Append(CbJson.Num(Math.Round(p.StopTicks * tick * pv * p.Sizes[i], 2)))
                 .Append(",\"out\":").Append(Str(p.Outs[i] ?? (r != null && r != "placed" ? "refused: " + r : null)))
                 .Append(",\"placed\":").Append(r == "placed" ? "true" : "false").Append('}');
            }
            return b.Append(']').ToString();
        }

        private string PlanJson(Plan p)
        {
            return "{\"type\":\"agentPlan\",\"agent\":" + CbJson.Str(Id) + ",\"id\":" + Str(p.Id) + ",\"at\":" + Ms(p.At) + ",\"action\":" + CbJson.Str(p.Action) + PlanFields(p) +
                   ",\"result\":" + CbJson.Str(p.Result ?? "") + "}";
        }

        private string ProposalJson(Proposal pr)
        {
            string state;
            double seen, answered;
            lock (Sync) { state = pr.State == "accepting" ? "open" : pr.State; seen = pr.SeenAt; answered = pr.AnsweredAt; }
            bool grp = pr.Account != null && pr.Account.StartsWith("group:", StringComparison.Ordinal);   // 0.6.0: a group's proposal names the group, account null
            return "{\"type\":\"agentProposal\",\"agent\":" + CbJson.Str(Id) + ",\"id\":" + CbJson.Str(pr.P.Id) + ",\"at\":" + Ms(pr.P.At) + ",\"account\":" + (grp ? "null" : CbJson.Str(pr.Account)) +
                   (grp ? ",\"group\":" + GroupJson(pr.Account.Substring(6)) : "") +
                   ",\"sim\":" + (pr.Sim ? "true" : "false") + PlanFields(pr.P) + ",\"expiresAt\":" + Ms(pr.P.ExpiresAt) + ",\"state\":" + CbJson.Str(state) +
                   ",\"seenAt\":" + Ms(seen) + ",\"answeredAt\":" + Ms(answered) + "}";
        }

        private string WelcomeJson() { return WelcomeJson(ServedRoots()); }

        private string WelcomeJson(List<string> served)
        {
            Rules r = RulesNow();
            string m;
            lock (Sync) m = mode;
            StringBuilder ins = new StringBuilder("[");
            bool first = true;
            foreach (string root in served)
            {
                Instrument inst = ChartBridgeServer.InstrumentFor(root);
                if (inst == null) continue;
                if (!first) ins.Append(','); first = false;
                ins.Append("{\"root\":").Append(CbJson.Str(root)).Append(",\"name\":").Append(CbJson.Str(inst.FullName)).Append(",\"tick\":").Append(CbJson.Num(inst.MasterInstrument.TickSize))
                   .Append(",\"pointValue\":").Append(CbJson.Num(inst.MasterInstrument.PointValue)).Append('}');
            }
            ins.Append(']');
            return "{\"type\":\"welcome\",\"version\":" + CbJson.Str(ChartBridgeServer.Version) + ",\"agent\":" + CbJson.Str(Id) + ",\"mode\":" + CbJson.Str(m) + ",\"account\":" + ChartBridgeBranches.Json(Account) +
                   ",\"sim\":" + (SimNow() ? "true" : "false") + ",\"league\":" + (League ? "true" : "false") + ",\"killed\":" + (Killed ? "true" : "false") + ",\"rules\":" + NoteWelcomeRules(EnforcedRulesJson(r)) + ",\"instruments\":" + ins + SeatsWelcomeFields() + "}";
        }

        // 0.6.0: welcome's group ({id, name} or null), seats (the member accounts in seat order, null for one account) and seatsRev.
        private string SeatsWelcomeFields()
        {
            string gid;
            List<string> seats;
            long rev;
            lock (Sync) { gid = groupId; seats = seatNames.ToList(); rev = seatsRev; }
            return ",\"group\":" + (gid != null ? WelcomeGroupJson(gid) : "null") + ",\"seats\":" + (gid != null ? "[" + string.Join(",", seats.Select(x => CbJson.Str(x))) + "]" : "null") +
                   ",\"seatsRev\":" + rev.ToString(CultureInfo.InvariantCulture);
        }

        private static string GroupJson(string gid) { return "{\"id\":" + CbJson.Str(gid) + ",\"name\":" + Str(ChartBridgeGroups.NameOf(gid)) + "}"; }
        // 0.6.2: the agent's welcome.group adds the group's account Type ("eval", "funded", or null when not set) for its runner.
        private static string WelcomeGroupJson(string gid) { return "{\"id\":" + CbJson.Str(gid) + ",\"name\":" + Str(ChartBridgeGroups.NameOf(gid)) + ",\"accountType\":" + Str(ChartBridgeGroups.TypeOf(gid)) + "}"; }

        // 0.6.0: each seat for agentState and the strip (a group only): its account, whether the agent owns anything there, its open
        // trade, today's P&L and trades there, and why it is not in the last plan's trade (null: it is). strip: also SIM or LIVE, the
        // last plan's size and risk on it, and its last closed trade's dollars (the page's R).
        private string SeatsJson(bool strip)
        {
            List<Seat> seats = AllSeats();
            List<bool> owns = seats.Select(x => FlatRoots().Any(y => x.Owns(y))).ToList();
            List<bool> sims = strip ? seats.Select(x => SeatSim(x.Name)).ToList() : null;
            StringBuilder b = new StringBuilder("[");
            lock (Sync)
            {
                for (int i = 0; i < seats.Count; i++)
                {
                    Seat x = seats[i];
                    List<KeyValuePair<string, double>> mine = Trades.Where(kv => { string s8; return SeatOfTag.TryGetValue(kv.Key.Length > 8 ? kv.Key.Substring(0, 8) : kv.Key, out s8) && s8 == x.Name; }).ToList();
                    if (i > 0) b.Append(',');
                    b.Append("{\"account\":").Append(CbJson.Str(x.Name)).Append(",\"owns\":").Append(owns[i] ? "true" : "false").Append(",\"position\":").Append(x.PositionJsonLocked())
                     .Append(",\"pnlToday\":").Append(CbJson.Num(Math.Round(mine.Where(kv => !double.IsNaN(kv.Value)).Sum(kv => kv.Value), 2))).Append(",\"trades\":").Append(mine.Count)
                     .Append(",\"out\":").Append(Str(x.Out));
                    if (strip)
                    {
                        List<KeyValuePair<string, double>> last = x.LastPlanId == null ? new List<KeyValuePair<string, double>>() :
                            mine.Where(kv => { string pid; return PlanOfTag.TryGetValue(kv.Key.Length > 8 ? kv.Key.Substring(0, 8) : kv.Key, out pid) && pid == x.LastPlanId; }).ToList();
                        bool closed = last.Count > 0 && last.All(kv => !double.IsNaN(kv.Value));
                        b.Append(",\"sim\":").Append(sims[i] ? "true" : "false").Append(",\"seat\":").Append(seatNames.Contains(x.Name) ? "true" : "false")
                         .Append(",\"lastPlan\":").Append(Str(x.LastPlanId)).Append(",\"size\":").Append(x.LastSize.ToString(CultureInfo.InvariantCulture))
                         .Append(",\"risk\":").Append(CbJson.Num(x.LastRisk)).Append(",\"lastPnl\":").Append(closed ? CbJson.Num(Math.Round(last.Sum(kv => kv.Value), 2)) : "null");
                    }
                    b.Append('}');
                }
            }
            return b.Append(']').ToString();
        }

        private bool OwnsAny() { return RulesNow().Roots.Any(x => Owns(x)); }   // 0.6.0: any seat

        // What the order path asks at the last moment (ChartBridgeAgents.PlacingProblem): killed, shadow, outside the window.
        // 0.6.0: and the agent connected (its hello said): asked per seat under PlaceLock, so once the socket drops (Lose) no further
        // seat is placed. Only the agent's Sync is taken here (as before), never a lock Lose waits on.
        // 0.6.2 (SPEC CE-2): and, for this seat (acct, under PlaceLock), a stand-down of its build on the seat's group or on the group
        // it trades (raised mid fan-out: no further seat is placed), agent-standdowns.txt unreadable, and a league seat whose account is
        // not Sim now (read fresh: a provider changed after the start is caught here).
        public string PlacingProblem(string acct)
        {
            Rules r = RulesNow();
            string m, bd, gid;
            bool k, on, lg;
            lock (Sync) { m = mode; k = killed; on = client != null && helloed; bd = build; gid = groupId; lg = league; }
            if (k) return "the kill switch is on (release it on the Agent tab)";
            if (m == "shadow") return "agent " + Id + " is in shadow: nothing is placed";
            if (!on) return "agent " + Id + " is not connected: nothing more is placed";   // 0.6.0: a fan-out stops at the seat after its socket dropped
            DateTime et = NowEt();
            if (!InWindow(r, et)) return WindowRefusal(r, et);   // 0.5.2: session time, the market open
            string sd = ChartBridgeAgents.BrokenRefusal(acct) ?? ChartBridgeAgents.StandDownRefusal(bd, ChartBridgeGroups.GroupOf(acct)) ?? (gid != null ? ChartBridgeAgents.StandDownRefusal(bd, gid) : null);
            if (sd != null) return sd;
            if (lg) { Account a = FindAccount(acct); if (gid != null || a == null || !ChartBridgeBot.IsSim(a)) return LeagueRefusal; }
            return null;
        }

        // 0.6.2: a stand-down of its build (its last hello's) on the group it trades, or on the group its one account is in; or
        // agent-standdowns.txt unreadable (an account in a prop group: BrokenRefusal). Null otherwise (None, a personal account or a league seat in no group).
        private string GroupNowForLatch()
        {
            string gid, acct;
            lock (Sync) { gid = groupId; acct = account; }
            return gid ?? (ChartBridgeBranches.IsNone(acct) ? null : ChartBridgeGroups.GroupOf(acct));
        }
        // agent-standdowns.txt unreadable (Anthony 2026-10-16): on a group, the whole agent (every seat is in the group); on one account,
        // by that account (BrokenRefusal: in a prop group refused, in no group allowed; groups.txt unreadable too: Sim only).
        private string LatchProblem()
        {
            string gid, acct;
            lock (Sync) { gid = groupId; acct = account; }
            string broken = gid != null ? ChartBridgeAgents.StandDownsBroken() : ChartBridgeAgents.BrokenRefusal(acct);
            return broken ?? ChartBridgeAgents.StandDownRefusal(Build, GroupNowForLatch());
        }

        // agentState.groupStandDown: the stand-down on the group it is on now, {group, kind, why, at}, or null.
        private string GroupStandDownJson()
        {
            string gid = GroupNowForLatch(), bd = Build;
            ChartBridgeAgents.GroupStandDown s = gid == null || bd == null ? null : ChartBridgeAgents.StandDownsOf(bd).FirstOrDefault(x => x.Group == gid);
            return s == null ? "null" : "{\"group\":" + CbJson.Str(s.Group) + ",\"kind\":" + CbJson.Str(s.Kind) + ",\"why\":" + CbJson.Str(s.Why) + ",\"at\":" + s.At.ToString("0", CultureInfo.InvariantCulture) + "}";
        }
        // agent.standDowns (the pages): every stand-down of its build, on any group.
        private string StandDownsJson()
        {
            string bd = Build;
            return "[" + (bd == null ? "" : string.Join(",", ChartBridgeAgents.StandDownsOf(bd).Select(ChartBridgeAgents.StandDownJson).ToArray())) + "]";
        }

        // 0.6.2: a stand-down raised or cleared (any agent's): this agent sweeps when it now stands down (its unfilled entries
        // cancelled, its open proposals expired; positions keep their stop and target), and the agent and the pages are told.
        internal void AfterStandDownChange()
        {
            string w = LatchProblem();
            if (w != null) Sweep(w);
            Notify();
        }
        internal void NoteCleared(string bd, string text) { if (bd != null && bd == Build) AgentLog(text); }

        // The agent's standDown {group, kind, why} (0.6.2, raise only: there is no clear from the agent). The stand-down is its build's
        // (its hello's) on that group: no new entries from that build on any seat in the group until Anthony clears it on the Board.
        private void OnStandDown(Dictionary<string, Val> d)
        {
            string gid = S(d, "group"), kind = S(d, "kind"), why = S(d, "why"), bd = Build;
            string bad = gid == null || !GroupIdRx.IsMatch(gid) ? "standDown needs group (a group id such as g1)" :
                         !ChartBridgeAgents.SdText(kind, 40) ? "standDown needs a kind of 1 to 40 characters" :
                         !ChartBridgeAgents.SdText(why, 200) ? "standDown needs a why of 1 to 200 characters" :
                         !ChartBridgeAgents.SdText(bd, 40) ? "standDown needs the build of agentHello (1 to 40 characters, no spaces at its ends)" :
                         !ChartBridgeGroups.Unreadable() && ChartBridgeGroups.NameOf(gid) == null ? "there is no group " + gid : null;   // groups.txt unreadable: taken (a stand-down only refuses)
            if (bad != null) { ToAgent(Reject(null, bad)); return; }
            bool fresh, sayAgain;
            string full = ChartBridgeAgents.RaiseStandDown(Id, bd, gid, kind, why, out fresh, out sayAgain);
            if (full != null) { ToAgent(Reject(null, full)); return; }   // fix round 1: at most MaxStandDowns (logged and an alarm there)
            string gname = ChartBridgeGroups.NameOf(gid) ?? gid;
            if (!fresh && !sayAgain) { Notify(); return; }   // fix round 1: a repeat raise is logged once per build and group
            string text = fresh ? "agent " + Id + " stood down build " + bd + " on group " + gname + " (" + kind + ": " + why + "): no new entries from it on " + gname + " until Anthony clears it on the Agent tab's Board; exits always work"
                                : "agent " + Id + " stood down build " + bd + " on group " + gname + " again (" + kind + ": " + why + "): it stands down already (kept as first raised)";
            Log(text); AgentLog(text);
            if (fresh) { ToPages(StatusJson("warn", "Agent " + text.Substring(6))); ChartBridgeAgents.StandDownsChanged(); }
            else Notify();
        }

        private string StateJson()
        {
            string sd = StandDown(), gsd = GroupStandDownJson();   // 0.6.2: groupStandDown, the stand-down on the group it is on now
            string gtype = GroupNow() ? Str(ChartBridgeGroups.TypeOf(GroupId)) : "null";   // 0.6.2: groupType, the Type of the group it trades (a change in Settings reaches the runner without a reconnect)
            bool owns = OwnsAny();
            string seats = GroupNow() || AllSeats().Any(x => !IsEntrySeat(x.Name)) ? ",\"seats\":" + SeatsJson(false) : "";   // 0.6.0: a group's seats (one account: as before)
            lock (Sync)
            {
                return "{\"type\":\"agentState\",\"mode\":" + CbJson.Str(mode) + ",\"killed\":" + (killed ? "true" : "false") + ",\"standDown\":" + Str(sd) +
                       ",\"trades\":" + TradesLocked() + ",\"losses\":" + LossesLocked() + ",\"pnlToday\":" + CbJson.Num(Math.Round(Trades.Values.Where(v => !double.IsNaN(v)).Sum(), 2)) +
                       ",\"owns\":" + (owns ? "true" : "false") + ",\"session\":" + Str(session) + ",\"groupStandDown\":" + gsd + ",\"groupType\":" + gtype + seats + "}";
            }
        }

        public string StripJson()
        {
            bool sim = SimNow(), owns = OwnsAny();
            string sd = StandDown(), sds = StandDownsJson();   // 0.6.2: standDowns, every stand-down of its build
            Rules r = RulesNow();
            string gid = GroupId, seats = gid != null || AllSeats().Any(x => !IsEntrySeat(x.Name)) ? SeatsJson(true) : null;   // 0.6.0
            Seat pos = AllSeats().FirstOrDefault(x => { lock (Sync) return x.openTag != null && x.ledQty != 0; });
            StringBuilder b = new StringBuilder("{\"type\":\"agent\"");
            lock (Sync)
            {
                double now = Now();
                b.Append(",\"agent\":").Append(CbJson.Str(Id))
                 .Append(",\"name\":").Append(Str(name)).Append(",\"build\":").Append(Str(build))
                 .Append(",\"enabled\":true")
                 .Append(",\"connected\":").Append(client != null && helloed ? "true" : "false")
                 .Append(",\"mode\":").Append(CbJson.Str(mode))
                 .Append(",\"account\":").Append(ChartBridgeBranches.Json(account))
                 .Append(",\"sim\":").Append(sim ? "true" : "false")
                 .Append(",\"league\":").Append(league ? "true" : "false")   // 0.6.2
                 .Append(",\"rules\":").Append(RulesJson(r))
                 .Append(",\"position\":").Append(pos != null ? pos.PositionJsonLocked() : "null")
                 .Append(",\"pnlToday\":").Append(CbJson.Num(Math.Round(Trades.Values.Where(v => !double.IsNaN(v)).Sum(), 2)))
                 .Append(",\"trades\":").Append(TradesLocked())
                 .Append(",\"losses\":").Append(LossesLocked())
                 .Append(",\"killed\":").Append(killed ? "true" : "false")
                 .Append(",\"killedAt\":").Append(killed && killedAt > 0 ? Ms(killedAt) : "null")   // 0.6.3 (audit C5)
                 .Append(",\"standDown\":").Append(Str(sd))
                 .Append(",\"standDowns\":").Append(sds)   // 0.6.2
                 .Append(",\"owns\":").Append(owns ? "true" : "false")
                 .Append(",\"lastBeatMs\":").Append(client != null ? Ms(Math.Max(0, now - lastMsgMs)) : "null")
                 .Append(",\"lastPlan\":").Append(lastPlanJson ?? "null");
                if (gid != null) b.Append(",\"group\":").Append(GroupJson(gid)).Append(",\"seatsRev\":").Append(seatsRev.ToString(CultureInfo.InvariantCulture));   // 0.6.0
                if (seats != null) b.Append(",\"seats\":").Append(seats);
            }
            return b.Append('}').ToString();
        }

        public string DiagJson()
        {
            lock (Sync)
            {
                return "{\"connected\":" + (client != null ? "true" : "false") + ",\"mode\":" + CbJson.Str(mode) + ",\"killed\":" + (killed ? "true" : "false") +
                       ",\"plans\":" + nPlans + ",\"proposals\":" + nProposals + ",\"placed\":" + nPlaced + ",\"refused\":" + nRefused + ",\"heartbeatLost\":" + nHeartbeatLost +
                       ",\"flattenedAt\":" + Str(flattenedAt) + ",\"secretFile\":" + CbJson.Str(secretState) +
                       ",\"league\":" + (league ? "true" : "false") + "}";   // 0.6.2: a league seat (the welcome's own flag; never the account)
            }
        }

        // ---------------------------------------------------------- logs (never the secret)
        private void Log(string text) { ChartBridgeServer.Log("agent: " + text); }

        private int logFailed;
        private void AgentLog(string text)
        {
            try { File.AppendAllText(LogFile, DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture) + "\t" + text.Replace('\n', ' ') + Environment.NewLine); }
            catch (Exception ex) { if (Interlocked.Exchange(ref logFailed, 1) == 0) Log("agent-" + Id + ".log could not be written (" + ex.Message + ")"); }
        }
    }
}
