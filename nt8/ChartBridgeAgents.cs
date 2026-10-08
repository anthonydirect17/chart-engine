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
        internal static string PlaceAgentEntry(string agentId, string text, out Order placed)
        {
            placed = null;
            string bracketBody, why, top = TopLevel("order", text, out bracketBody, out why);
            if (why == null) why = QuoteOnly(top, null);
            return why ?? PlaceOrder(top, bracketBody, null, null, false, agentId, out placed);
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
        internal static int AgentCap(string root) { return CapFor(root); }
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

        public const string SecretHeader = "X-ChartBridge-Agent";
        public const int MaxMessageBytes = 65536, MaxActionsPerSecond = 10;
        public const double SilenceMs = 5000, StripEveryMs = 1000, CheckEveryMs = 500;
        public const double FlatErrorEveryMs = 10000, FlatRetryMs = 3000, AcceptMinLeftMs = 5000;
        // Review A (second round): a cancel not confirmed after 10 tries is an error and is tried every 30 s from then; while the
        // market is shut the NOT FLAT error and the lost-trade error repeat every 60 s.
        public const int CancelSlowAfter = 10;
        public const double TradingFreshMs = 5000, AgainstGraceMs = 3000, CloseRetryHoldMs = 30000, GhostGraceMs = 5000;   // the market trading in fact: a trade in the last 5 s
        public const double CancelSlowMs = 30000, ShutErrorEveryMs = 60000, LostTradeEveryMs = 60000, CancelGiveUpMs = 30 * 60000;

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
        public static string OwnerAgent(string account, string root)
        {
            if (string.IsNullOrEmpty(account) || string.IsNullOrEmpty(root)) return null;
            foreach (ChartBridgeAgent a in All()) if (a.Account == account && a.Owns(root)) return a.Id;
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
                if (ag.Account != account.Name) return "agent " + id + " trades its own account " + ag.Account + " only";
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
        public static string PlacingProblem(string id, string kind, bool isBuy, double price, double limitPx, double tick)
        {
            ChartBridgeAgent a = Get(id);
            if (a == null) return "there is no agent " + id + " (agents in config.txt)";
            string why = a.PlacingProblem();
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

        // The agent whose CHOSEN account (chosen on the page: agent-<id>-account.txt) this is, for the bot's and the copier's
        // refusals, or null. An agent on its unchosen default (Sim101, no file) claims nothing against anyone (lead's default).
        public static string AgentOfAccount(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            foreach (ChartBridgeAgent a in All()) if (a.Chosen && string.Equals(a.Account, name, StringComparison.OrdinalIgnoreCase)) return a.Id;
            return null;
        }

        public static string AccountTakenWhy(string name, string by)
        {
            string id = AgentOfAccount(name);
            return id == null ? null : name + " is agent " + id + "'s account: " + by + " does not trade it (choose another account for agent " + id + " on the Agent tab first)";
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

        public static void OnExec(string account, Instrument inst, MarketPosition side, int qty, double price, string orderId, string json)
        {
            if (!Enabled) return;
            foreach (ChartBridgeAgent a in All()) if (a.Account == account) a.OnExec(inst, side, qty, price, orderId, json);
        }

        public static void OnPosition(Account account, PositionEventArgs e)
        {
            if (!Enabled || account == null || e == null || e.Position == null) return;
            foreach (ChartBridgeAgent a in All()) if (a.Account == account.Name) { a.OnPosition(e); a.StateChanged(e.Position.Instrument); }
        }

        // Every order update on any account (ChartBridgeOrders.OnOrderUpdate): an agent on that account and root sends agentState
        // again when a field changed, owns included (contract section 10: a leg cancelled after a close turns owns false at once).
        public static void OnAccountChange(Account account, Instrument inst) { OnAccountChange(account, inst, null); }

        public static void OnAccountChange(Account account, Instrument inst, Order o)
        {
            if (!Enabled || account == null) return;
            foreach (ChartBridgeAgent a in All()) if (a.Account == account.Name) { a.NoteOrderId(o); a.StateChanged(inst); }
        }

        // ChartBridgeOrders.Auth and the v3 handshake: a signed-in v3 page gets every agent's strip, its open proposals, its last
        // 200 notes and its last 50 plans.
        public static void AfterAuth(ChartBridgeClient client)
        {
            if (!Enabled || client == null || !client.Trader || !ChartBridgeV3.IsV3(client)) return;
            foreach (ChartBridgeAgent a in All()) a.Replay(client);
        }

        // ---------------------------------------------------------- messages from the page
        private static readonly Dictionary<string, string[]> PageKeys = new Dictionary<string, string[]>
        {
            { "agentMode", new[] { "type", "cid", "agent", "mode" } },
            { "agentKill", new[] { "type", "cid", "agent", "on" } },
            { "agentSeen", new[] { "type", "agent", "id", "at" } },
            { "agentAnswer", new[] { "type", "cid", "agent", "id", "answer", "at" } },
            { "agentAccount", new[] { "type", "cid", "agent", "account", "keepMode" } },   // 0.5.2: keepMode, the mode the page's question named
            { "agentRules", new[] { "type", "cid", "agent", "roots", "maxQtyNQ", "maxQtyMNQ", "maxQtyES", "maxQtyMES", "entryFrom", "entryUntil", "flatAt", "maxExpireSec", "maxTrades", "maxLosses" } },
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
        }

        private class Proposal
        {
            public Plan P;
            public string Account;
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
            public bool CloseHandled;      // its last close's end was looked at (a close that did not fill: the stop placed again; review D3)
            public double HoldUntilMs;     // after a close that could not go: the stop stays, the next try waits until then
            public bool GateAgain;         // a stop was placed again: its cancel waits for a trading market too (review E2)
            public string ReStopSay;
            public double StartMs, LastCancelMs = -1e18, LastCloseMs = -1e18, LastErrorMs, ApartSinceMs = -1;
            public Order Close;
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
        private string account = "Sim101";
        private bool chosen;   // the account was chosen on the page (agent-<id>-account.txt); false on the unchosen default
        private string rulesBroken, accountBroken, dayBroken, lossStandDown;
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
        private string openTag, openRoot;
        private Instrument openInst;   // the contract of the open trade (the flatten looks at it too, any month; review A5)
        private int ledQty;
        private readonly Dictionary<string, double> LostTrades = new Dictionary<string, double>();   // root -> last error (review A3)
        private readonly Dictionary<string, string> LostTradeText = new Dictionary<string, string>();
        private double ledCash, ledAvg;
        private readonly HashSet<string> Sticky = new HashSet<string>();   // roots it owns until flat by both readings with no entry
        private readonly Dictionary<string, Proposal> Proposals = new Dictionary<string, Proposal>();
        private readonly Dictionary<string, Order> EntryOfPlan = new Dictionary<string, Order>();
        private readonly Dictionary<string, string> PlanOfTag = new Dictionary<string, string>();
        private readonly List<Order> Placed = new List<Order>();
        private class CancelTry { public double FirstMs, LastMs; public int Tries; public string Why; public bool GaveUp; }
        private readonly Dictionary<Order, CancelTry> CancelSent = new Dictionary<Order, CancelTry>();   // cancels sent, until the order is done
        private readonly HashSet<string> MyTags = new HashSet<string>();
        private readonly Queue<double> Actions = new Queue<double>();
        private readonly LinkedList<string> Notes = new LinkedList<string>(), PlansShown = new LinkedList<string>();
        private string lastPlanJson;
        private readonly Dictionary<string, FlatJob> Flats = new Dictionary<string, FlatJob>();
        private string flattenedAt;
        private long nPlans, nProposals, nPlaced, nRefused, nHeartbeatLost;

        public string Account { get { lock (Sync) return account; } }
        public bool Chosen { get { lock (Sync) return chosen; } }
        public int MaxQtyFor(string root) { lock (Sync) return rules.Roots.Contains(root ?? "") ? rules.QtyFor(root) : 0; }
        private Rules RulesNow() { lock (Sync) return rules.Copy(); }

        private string Folder { get { return ChartBridgeConfig.Folder; } }
        private string SecretFile { get { return Path.Combine(Folder, "agent-" + Id + "-secret.txt"); } }
        private string AccountFile { get { return Path.Combine(Folder, "agent-" + Id + "-account.txt"); } }
        private string RulesFile { get { return Path.Combine(Folder, "agent-" + Id + "-rules.txt"); } }
        private string DayFile { get { return Path.Combine(Folder, "agent-" + Id + "-day.txt"); } }
        private string LogFile { get { return Path.Combine(Folder, "agent-" + Id + ".log"); } }

        private static double Now() { return ChartBridgeAgents.Now(); }
        private static DateTime NowEt() { return ChartBridgeAgents.NowEt(); }

        // ---------------------------------------------------------- start and stop
        public void Start()
        {
            LoadSecret();
            LoadRules();
            LoadAccount();
            LoadDay();
            lock (Sync) { noClientSinceMs = Now(); startedMs = noClientSinceMs; mode = "shadow"; }
            Log("agent channel ON for " + Id + ": it may connect at ws://localhost:" + ChartBridgeConfig.Port + "/agent/" + Id + " (account " + Account + (SimNow() ? " (Sim)" : " (LIVE)") + ", starting in shadow)");
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

        // ---------------------------------------------------------- the rules file (agent-<id>-rules.txt)
        // Two # lines, then key<TAB>value lines; no file: the defaults. A file that cannot be understood (a line it does not know,
        // a key twice, a value out of range) is never written over and stands the agent down until the page sets the rules or the
        // file is deleted. A key left out keeps its default (lead's default).
        private void LoadRules()
        {
            Rules r = new Rules();
            string broken = null;
            try
            {
                if (File.Exists(RulesFile))
                {
                    HashSet<string> seen = new HashSet<string>();
                    Dictionary<string, int> qty = new Dictionary<string, int>();
                    foreach (string raw in File.ReadAllLines(RulesFile))
                    {
                        string line = raw.Trim();
                        if (line.Length == 0 || line.StartsWith("#")) continue;
                        string[] p = line.Split('\t');
                        if (p.Length != 2 || !seen.Add(p[0])) { broken = "agent-" + Id + "-rules.txt has a line ChartBridge does not understand"; break; }
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
                            if (v != "none" && val < 1) { broken = "agent-" + Id + "-rules.txt: " + k + " must be none or a whole number of 1 or more"; break; }
                            if (k == "maxTrades") r.MaxTrades = val; else r.MaxLosses = val;
                        }
                        else { broken = "agent-" + Id + "-rules.txt has a line ChartBridge does not understand"; break; }
                    }
                    if (broken == null)
                    {
                        r.MaxQty = new Dictionary<string, int>();
                        foreach (string root in r.Roots) r.MaxQty[root] = qty.ContainsKey(root) ? qty[root] : DefaultQty(root);
                        string bad = RulesProblem(r);
                        if (bad != null) broken = "agent-" + Id + "-rules.txt: " + bad;
                    }
                }
            }
            catch (Exception ex) { broken = "agent-" + Id + "-rules.txt could not be read (" + ex.Message + ")"; }
            if (broken != null) { broken += ": no new entries for agent " + Id + " until its rules are set on the Agent tab or the file is deleted"; Log(broken); r = new Rules(); }
            lock (Sync) { rules = r; rulesBroken = broken; }
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

        private static void WriteWhole(string file, List<string> lines)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            string tmp = file + ".tmp";
            File.WriteAllLines(tmp, lines.ToArray());
            if (File.Exists(file)) File.Replace(tmp, file, null); else File.Move(tmp, file);
        }

        // ---------------------------------------------------------- the account file (agent-<id>-account.txt, as bot-account.txt)
        private void LoadAccount()
        {
            string a = "Sim101", broken = null;
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
                        else { broken = "agent-" + Id + "-account.txt has a line ChartBridge does not understand"; break; }
                    }
                    if (broken == null && found == null) broken = "agent-" + Id + "-account.txt names no account";
                    if (broken == null) a = found;
                }
            }
            catch (Exception ex) { broken = "agent-" + Id + "-account.txt could not be read (" + ex.Message + ")"; }
            if (broken != null) { broken += ": no new entries for agent " + Id + " until its account is chosen again on the Agent tab or the file is deleted"; Log(broken); }
            lock (Sync) { account = a; accountBroken = broken; chosen = broken == null && a != null && File.Exists(AccountFile); }
        }

        private string SaveAccount(string nm)
        {
            try
            {
                WriteWhole(AccountFile, new List<string> { "# ChartBridge account for agent " + Id + " (written by ChartBridge from the page's Agent tab; do not edit)",
                    "# the one account the agent's orders go to; Sim101 when this file is missing", "account\t" + nm });
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
        private static string SessionOf(DateTime et) { return (et.Hour >= 18 ? et.Date.AddDays(1) : et.Date).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture); }

        private void LoadDay()
        {
            string today = SessionOf(NowEt()), fileSession = null, broken = null, held = null;
            Dictionary<string, double> trades = new Dictionary<string, double>(), expiry = new Dictionary<string, double>();
            Dictionary<string, int[]> spans = new Dictionary<string, int[]>();
            HashSet<string> ids = new HashSet<string>(), carriedTags = new HashSet<string>();
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
                        if (p.Length == 2 && p[0] == "session" && Regex.IsMatch(p[1], "^[0-9]{4}-[0-9]{2}-[0-9]{2}$")) fileSession = p[1];
                        else if (p.Length == 3 && p[0] == "trade" && Regex.IsMatch(p[1], "^[0-9a-f]{8}(?:-[0-9]{1,4}){0,1}$") && p[2] == "open") trades[p[1]] = double.NaN;
                        else if (p.Length == 3 && p[0] == "trade" && Regex.IsMatch(p[1], "^[0-9a-f]{8}(?:-[0-9]{1,4}){0,1}$") && double.TryParse(p[2], NumberStyles.Float, CultureInfo.InvariantCulture, out v) && !double.IsNaN(v) && !double.IsInfinity(v)) trades[p[1]] = v;
                        else if (p.Length == 2 && p[0] == "plan" && p[1].Length >= 1 && p[1].Length <= 40) ids.Add(p[1]);
                        else if (p.Length == 3 && p[0] == "entry" && Regex.IsMatch(p[1], "^[0-9a-f]{8}$") && Regex.IsMatch(p[2], "^[0-9]{1,15}$")) expiry[p[1]] = double.Parse(p[2], CultureInfo.InvariantCulture);
                        else if (p.Length == 2 && p[0] == "standDown" && p[1].Length > 0) held = p[1];
                        else if (p.Length == 2 && p[0] == "carried" && Regex.IsMatch(p[1], "^[0-9a-f]{8}(?:-[0-9]{1,4}){0,1}$")) carriedTags.Add(p[1]);   // 0.5.2 review
                        else if (p.Length == 4 && p[0] == "span" && Regex.IsMatch(p[1], "^[0-9a-f]{8}(?:-[0-9]{1,4}){0,1}$") && Regex.IsMatch(p[2], "^[0-9]{1,6}$") && Regex.IsMatch(p[3], "^[0-9]{1,6}$"))
                            spans[p[1]] = new[] { int.Parse(p[2], CultureInfo.InvariantCulture), int.Parse(p[3], CultureInfo.InvariantCulture) };
                        else { broken = "agent-" + Id + "-day.txt has a line ChartBridge does not understand"; break; }
                    }
                    if (broken == null && fileSession == null) broken = "agent-" + Id + "-day.txt has no session line";
                }
            }
            catch (Exception ex) { broken = "agent-" + Id + "-day.txt could not be read (" + ex.Message + ")"; }
            // Lead's default (review A-N3, A-S4): an entry line whose order is no longer listed is dropped; an open trade of an
            // earlier session is dropped (it counts only in its own session; a position it left keeps its legs, and the flat hours
            // and the owner rules still see it by those legs).
            HashSet<string> listed = ListedTags();
            int stale = 0;
            lock (Sync)
            {
                session = today;
                Trades.Clear(); PlanIds.Clear(); Expiry.Clear(); Spans.Clear(); EntrySeen.Clear(); lossStandDown = null;
                if (broken != null) dayBroken = broken + ": no new entries for agent " + Id + " this run (delete it to start the day over)";
                else
                {
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
                    foreach (string t in carriedTags) Carried.Add(t);
                    if (fileSession != today) foreach (KeyValuePair<string, double> kv in trades) if (double.IsNaN(kv.Value)) Carried.Add(kv.Key);
                }
            }
            if (broken != null) Log(broken + ": no new entries for agent " + Id + " this run (delete it to start the day over)");
            if (stale > 0) Log("agent-" + Id + "-day.txt: " + stale + " open trade(s) from the session of " + fileSession + " dropped (a record counts only in its own session)");
        }

        // The tags of every order listed on this agent's account (entry lines and stale records are checked against them).
        private HashSet<string> ListedTags()
        {
            HashSet<string> tags = new HashSet<string>();
            Account a = FindAccount(Account);
            if (a == null) return tags;
            lock (a.Orders) foreach (Order o in a.Orders) { string t = ChartBridgeAgents.TagOf(o.Name); if (t != null) tags.Add(t); }
            return tags;
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
                    TryIo(delegate { File.AppendAllText(DayFile, line + Environment.NewLine); });
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
            List<string> lines = new List<string> { "# ChartBridge day for agent " + Id + " (written by ChartBridge; do not edit)", "# session, its trades (tag and open or realized dollars), plan ids used, entries and their expiry" };
            lock (Sync)
            {
                if (dayBroken != null) return;   // never written over a file that could not be read
                lines.Add("session\t" + session);
                foreach (KeyValuePair<string, double> kv in Trades)
                    lines.Add("trade\t" + kv.Key + "\t" + (double.IsNaN(kv.Value) ? "open" : kv.Value.ToString("0.##", CultureInfo.InvariantCulture)));
                foreach (string id in PlanIds) lines.Add("plan\t" + id);
                foreach (KeyValuePair<string, double> kv in Expiry) lines.Add("entry\t" + kv.Key + "\t" + kv.Value.ToString("0", CultureInfo.InvariantCulture));
                foreach (KeyValuePair<string, int[]> kv in Spans) if (Trades.ContainsKey(kv.Key)) lines.Add("span\t" + kv.Key + "\t" + kv.Value[0].ToString(CultureInfo.InvariantCulture) + "\t" + kv.Value[1].ToString(CultureInfo.InvariantCulture));
                if (lossStandDown != null) lines.Add("standDown\t" + lossStandDown);
                foreach (string t in Carried) lines.Add("carried\t" + t);   // 0.5.2 review: a trade of an earlier session, until flat
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
                List<KeyValuePair<string, double>> open = Trades.Where(kv => double.IsNaN(kv.Value) && kv.Key == openTag).ToList();
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

        private int LossesLocked() { return Trades.Values.Count(v => v < 0); }

        // Why no new entry may go now (files, losses), or null. Under Sync.
        private string StandDownLocked()
        {
            if (dayBroken != null) return dayBroken;
            if (rulesBroken != null) return rulesBroken;
            if (accountBroken != null) return accountBroken;
            int losses = LossesLocked();
            if (lossStandDown == null && rules.MaxLosses > 0 && losses >= rules.MaxLosses) lossStandDown = losses + " losing trades today (maxLosses " + rules.MaxLosses + "): no new entries for agent " + Id + " until 18:00 ET";
            return lossStandDown;   // never lifted by a rules change; the 18:00 ET roll clears it (lead's default)
        }

        private string StandDown() { string sd; lock (Sync) sd = StandDownLocked(); return sd ?? AccountConflict(); }

        // A file that cannot be read (check 2), or null. Under Sync.
        private string FilesBrokenLocked() { return dayBroken ?? rulesBroken ?? accountBroken; }

        // The account is not usable by this agent: the bot's, the copier's leader or a follower (on or off), whether or not the bot
        // and the copier are switched on (lead's default), or another agent's. On such a clash the agent stands down and the other user of the account is left as it was (lead's
        // default: both start on Sim101 when no file chose another).
        public string AccountConflict()
        {
            string acct = Account, bot = ChartBridgeAgents.BotAccountForAgents();   // on or off (lead's default); never a file read here
            if (bot == null) return "bot-account.txt cannot be read or understood, so ChartBridge cannot tell the bot's account: agent " + Id + " trades nothing until it is fixed";
            if (string.Equals(acct, bot, StringComparison.OrdinalIgnoreCase))
                return acct + " is also the bot's account: choose an account for agent " + Id + " on the Agent tab (an agent never shares an account)";
            string cw = ChartBridgeAgents.CopierUses(acct);
            if (cw != null) return cw.Replace(" is the copier's", " is also the copier's").Replace(" is a copier follower", " is also a copier follower") + ": choose an account for agent " + Id + " on the Agent tab (an agent never shares an account)";
            bool mine = Chosen;
            foreach (ChartBridgeAgent other in ChartBridgeAgents.All())
                if (other != this && string.Equals(other.Account, acct, StringComparison.OrdinalIgnoreCase) && (other.Chosen || !mine))
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
            { "plan", new[] { "type", "id", "root", "side", "kind", "price", "limitPrice", "qty", "stopTicks", "targetTicks", "expireSec", "riskDollars", "setup", "reason", "confidence" } },
            { "skip", new[] { "type", "id", "setup", "reason" } },
            { "withdraw", new[] { "type", "id", "reason" } },
            { "note", new[] { "type", "kind", "text" } },
            { "flatten", new[] { "type" } },
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
            else if (type == "flatten") OnAgentFlatten();
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
            lock (Sync) { helloed = true; welcomeSent = false; name = nm; build = bd; }   // a second hello too: its welcome first
            List<string> served = ServedRoots();   // welcome.instruments and the snapshot cover exactly these roots (section 10)
            ToAgent(WelcomeJson(served));
            lock (Sync) welcomeSent = true;   // only now may agentState go (review D4, E3: helloed stays set for the mute check and ticks)
            SendState(true);
            Snapshot(served);
            Log("agent " + Id + " (\"" + nm + "\", build " + bd + ") said hello");
            AgentLog("hello: \"" + nm + "\", build " + bd);
            Notify();
        }

        // Contract addition (after agentState, at every hello): one position per root of the agent (flat included) and one order per
        // working order of its own, so a runner that reconnects sees fills it missed.
        private void Snapshot(List<string> served)
        {
            Account a = FindAccount(Account);
            string acct = Account;
            List<Instrument> insts = new List<Instrument>();
            foreach (string root in served)
            {
                Instrument inst = ChartBridgeServer.InstrumentFor(root);
                if (inst == null) continue;
                insts.Add(inst);
                int q = a != null ? ChartBridgeOrders.AgentListed(a, inst) : 0;
                double avg = 0;
                if (a != null && q != 0) lock (a.Positions) { Position ps = a.Positions.FirstOrDefault(x => x.Instrument == inst || (x.Instrument != null && x.Instrument.FullName == inst.FullName)); if (ps != null) avg = ps.AveragePrice; }
                ToAgent("{\"type\":\"position\",\"account\":" + CbJson.Str(acct) + ",\"root\":" + CbJson.Str(root) + ",\"qty\":" + q.ToString(CultureInfo.InvariantCulture) +
                        ",\"avgPrice\":" + (q != 0 ? CbJson.Num(avg) : "null") + "}");
            }
            if (a != null)
            {
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
            return null;
        }

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
                Proposal pr = new Proposal { P = p, Account = Account, Sim = SimNow() };
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
                if (why == null) ToAgent(AnswerJson(p.Id, "placed", "placed on " + Account + " as order " + ChartBridgeOrders.AgentIdFor(placed) + "; it works until " + Iso(p.ExpiresAt)));
            }
            if (why != null) { lock (Sync) nRefused++; ToAgent(Reject(p.Id, why)); }
            ShowPlan(p, fresh);
            AgentLog("plan " + (p.Id ?? "(no id)") + " " + p.Side + " " + p.Qty + " " + p.Root + " " + p.Kind + " @ " + (p.PriceText ?? "?") + (p.LimitText != null ? " limit " + p.LimitText : "") +
                     " stop " + p.StopTicks + " target " + p.TargetTicks + " expire " + p.ExpireSec + "s risk " + (p.RiskText ?? "?") + " (" + (p.Setup ?? "") + ": " + (p.Reason ?? "") + "): " + p.Result);
            Notify();
        }

        // Checks 2 to 11 of the contract, in order (the id, check 1, is the caller's). forAccount: a proposal's account (placed only
        // if it is still this agent's). The first that fails is the answer.
        private string Checks(Plan p, string forAccount, bool placing) { string used; return Checks(p, forAccount, placing, out used); }

        // used: the account the checks validated (Place sends there, never a fresh read).
        private string Checks(Plan p, string forAccount, bool placing, out string used)
        {
            Rules r = RulesNow();
            string acct = Account, sd;
            used = acct;
            bool k;
            lock (Sync) { k = killed; sd = FilesBrokenLocked(); }
            // 2. not killed, not stood down, the files readable, the account tradable now
            if (k) return "the kill switch is on (release it on the Agent tab)";
            if (sd != null) return sd;
            if (forAccount != null && forAccount != acct) return "agent " + Id + "'s account changed from " + forAccount + " to " + acct + " after this proposal: nothing placed";
            string aw = AccountProblemFor(acct, true) ?? AccountConflict();
            if (aw != null) return aw;
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
            int ceiling = Math.Min(ChartBridgeAgents.HardCeiling(root), r.QtyFor(root)), cap = ChartBridgeOrders.AgentCap(root);
            if (p.Qty < 1 || p.Qty > ceiling) return "qty must be a whole number from 1 to " + ceiling + " (agent " + Id + "'s maxQty for " + root + ")";
            if (p.Qty > cap) return "qty " + p.Qty + " is over the " + root + " cap of " + cap + " (maxQty." + root + " in config.txt)";
            if (p.StopTicks < 1 || p.TargetTicks < 1) return "every agent entry needs a stop and a target: stopTicks and targetTicks must be whole numbers of 1 or more";
            int mb = ChartBridgeOrders.AgentMaxBracketTicks;
            if (mb > 0 && (p.StopTicks > mb || p.TargetTicks > mb)) return "stopTicks and targetTicks must be at most " + mb + " (maxBracketTicks in config.txt)";
            // 5. the risk in dollars
            double tick = inst.MasterInstrument.TickSize, pv = inst.MasterInstrument.PointValue;
            double risk = Math.Round(p.StopTicks * tick * pv * p.Qty, 2);
            if (Math.Abs(p.Risk - risk) > 0.01 + 1e-9) return "riskDollars " + p.RiskText + " is not stopTicks x tick x point value x qty (" + risk.ToString("0.00", CultureInfo.InvariantCulture) + ")";
            // 6. the expiry
            if (p.ExpireSec < 60 || p.ExpireSec > r.MaxExpireSec) return "expireSec must be from 60 to " + r.MaxExpireSec;
            // 7. the entry window (session time, 0.5.2; never while the market is closed)
            DateTime et = NowEt();
            if (!InWindow(r, et)) return WindowRefusal(r, et);
            // 8. one at a time (Owns first: it clears a lock whose position is flat by both readings)
            bool entry = WorkingEntries().Count > 0, owns = r.Roots.Any(x => Owns(x)), open, proposal;
            lock (Sync)
            {
                open = openTag != null || Sticky.Count > 0;
                proposal = Proposals.Values.Any(x => x.State == "open" || x.State == "accepting") && !placing;
            }
            if (entry) return "one at a time: agent " + Id + " already has a working entry";
            if (open || owns) return "one at a time: agent " + Id + " already has a position";
            if (proposal) return "one at a time: agent " + Id + " already has an open proposal";
            // 9. maxTrades, maxLosses
            int trades;
            string lossWhy;
            lock (Sync) { trades = Trades.Count; StandDownLocked(); lossWhy = lossStandDown; }
            if (r.MaxTrades > 0 && trades >= r.MaxTrades) return "agent " + Id + " has made " + trades + " trades today (maxTrades " + r.MaxTrades + ")";
            if (lossWhy != null) return lossWhy;
            // 10. the owner lock
            Account a = FindAccount(acct);
            string lockWhy = ChartBridgeAgents.EntryCheck("agent:" + Id, a, root);
            if (lockWhy != null) return lockWhy;
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
            return null;
        }

        // Placing (auto, or an accepted proposal): every check again at this moment, then ChartBridgeOrders.PlaceAgentEntry builds the
        // order from the plan's own parameters on the agent's own account, through every v2 gate and the owner lock.
        private string Place(Plan p, string forAccount, out Order placed)
        {
            placed = null;
            lock (PlaceGate)
            {
                string acct;
                string why = Checks(p, forAccount, forAccount != null, out acct);
                if (why != null) return why;
                string root = p.Root.ToUpperInvariant();
                string text = "{\"type\":\"order\",\"account\":" + CbJson.Str(acct) + ",\"root\":\"" + root + "\",\"side\":\"" + p.Side + "\",\"kind\":\"" + p.Kind + "\",\"qty\":" +
                              p.Qty.ToString(CultureInfo.InvariantCulture) + ",\"price\":" + p.PriceText + (p.Kind == "stopLimit" ? ",\"limitPrice\":" + p.LimitText : "") +
                              ",\"bracket\":{\"stop\":" + p.StopTicks.ToString(CultureInfo.InvariantCulture) + ",\"target\":" + p.TargetTicks.ToString(CultureInfo.InvariantCulture) + "}}";
                why = ChartBridgeOrders.PlaceAgentEntry(Id, text, out placed);
                if (why != null) { placed = null; return why; }
                string tag = ChartBridgeAgents.TagOf(placed.Name);
                ChartBridgeAgents.NoteTag(tag, Id);
                lock (Sync)
                {
                    Placed.Add(placed); MyTags.Add(tag); Sticky.Add(root); nPlaced++;
                    EntryOfPlan[p.Id] = placed; PlanOfTag[tag] = p.Id; Expiry[tag] = p.ExpiresAt;
                }
            }
            SaveDay();
            AgentLog("placed " + p.Side + " " + p.Qty + " " + p.Root + " " + p.Kind + " @ " + p.PriceText + (p.LimitText != null ? " limit " + p.LimitText : "") + " stop " + p.StopTicks +
                     " target " + p.TargetTicks + " on " + Account + (SimNow() ? " (Sim)" : " (LIVE)") + " (plan " + p.Id + ", until " + Iso(p.ExpiresAt) + ")");
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

        private bool SimNow() { Account a = FindAccount(Account); return a != null && ChartBridgeBot.IsSim(a); }

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
            Order entry;
            string was = null;
            lock (Sync)
            {
                Proposals.TryGetValue(id, out p);
                EntryOfPlan.TryGetValue(id, out entry);
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
            bool cancelled = entry != null && Cancel(entry, "withdrawn by the agent: " + reason);
            if (!cancelled) { ToAgent(Reject(id, "nothing to withdraw for " + id)); return; }
            if (p != null) { lock (Sync) p.State = "withdrawn"; ToPages(ProposalJson(p)); }
            ToAgent(AnswerJson(id, "withdrawn", "its unfilled entry cancelled (" + reason + ")" + (entry.Filled > 0 ? "; the " + entry.Filled + " filled keep their stop and target" : "")));
            AgentLog("withdraw " + id + ": its unfilled entry cancelled (" + reason + ")");
            Notify();
        }

        // flatten from the agent: auto only, not while killed: cancel its orders on its account and roots, then market out.
        private void OnAgentFlatten()
        {
            string m;
            bool k;
            lock (Sync) { m = mode; k = killed; }
            string why = m != "auto" ? "flatten is for auto mode only" : k ? "the kill switch is on" : null;
            if (why == null && StartFlatten("flatten from agent " + Id, false) == 0) why = "agent " + Id + " has nothing to flatten";
            if (why != null) { ToAgent(Reject(null, why)); return; }
            AgentLog("flatten from the agent (auto) on " + Account);
        }

        // ---------------------------------------------------------- the agent's orders
        public bool Owns(string root)
        {
            string acct;
            bool open, stick;
            lock (Sync) { acct = account; open = openTag != null && openRoot == root; stick = Sticky.Contains(root); }
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

        private bool IsMine(Order o) { return o != null && ChartBridgeAgents.AgentOf(o) == Id; }

        // The root of another contract month of one of its roots (its master instrument's name), or null.
        private string MonthRoot(Instrument inst)
        {
            if (inst == null || inst.MasterInstrument == null) return null;
            string m = (inst.MasterInstrument.Name ?? "").ToUpperInvariant();
            return FlatRoots().Contains(m) ? m : null;
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
        // Its protective orders: v2's legs, and the stop placed again over a shut market ("CB#<tag> ag:<id> stop p<price>"; review D1).
        private static readonly Regex LegRx = new Regex("^CB#[0-9a-f]{8} (?:(?:stop|target) |ag:[a-z][a-z0-9]{0,11} stop p)");
        private static readonly Regex ReStopRx = new Regex("^CB#[0-9a-f]{8} ag:[a-z][a-z0-9]{0,11} stop p");
        private static bool IsReStop(Order o) { return o != null && ReStopRx.IsMatch(o.Name ?? ""); }
        private bool IsMyEntry(Order o) { if (o == null) return false; Match m = ChartBridgeAgents.EntryRx.Match(o.Name ?? ""); return m.Success && m.Groups[2].Value == Id; }

        // Every working entry of this agent on its account: those NinjaTrader lists (also after a restart, by name) and those just sent.
        private List<Order> WorkingEntries()
        {
            List<Order> list = new List<Order>();
            Account a = FindAccount(Account);
            if (a != null) lock (a.Orders) foreach (Order o in a.Orders) if (IsMyEntry(o) && ChartBridgeOrders.IsWorking(o.OrderState)) list.Add(o);
            lock (Sync) foreach (Order o in Placed) if (!list.Contains(o) && ChartBridgeOrders.IsWorking(o.OrderState)) list.Add(o);
            return list;
        }

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
            ToAgent(AnswerJson(planId, answer, why + (o.Filled > 0 ? "; the rest cancelled, the " + o.Filled + " filled keep their stop and target" : "; its entry cancelled")));
            AgentLog("plan " + planId + " " + answer + ": " + why + (o.Filled > 0 ? " (" + o.Filled + " filled keep their legs)" : ""));
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
            if (rejectedEntry && planId != null) { ToAgent(AnswerJson(planId, "refused", "NinjaTrader rejected its entry")); AgentLog("plan " + planId + ": NinjaTrader rejected its entry"); }
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
            Order o = FindOrder(orderId);
            string entryTag = IsMyEntry(o) ? ChartBridgeAgents.TagOf(o.Name) : null;
            bool mine = o != null && IsMine(o);
            // section 10 item 7: while it owns the pair, every fill there reaches the agent, its own or not (Anthony's Flatten, a close
            // in NinjaTrader: role other, cbId null when the order is not ChartBridge's), read before this fill is booked
            bool tell = mine || OwnsContract(root, inst, FindAccount(Account));
            if (tell && json != null && json.EndsWith("}", StringComparison.Ordinal))   // section 10: ChartBridge's id and the order's role
                json = json.Substring(0, json.Length - 1) + ",\"cbId\":" + Str(CbIdOf(o)) + ",\"role\":" + CbJson.Str(mine ? ChartBridgeOrders.AgentRoleFor(o) : "other") + "}";   // 10.7: a role only for its own orders (ag:<id>, or legs of its entry's tag)
            RollDay();
            string closedTag = null, opened = null, netted = null;
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
                        pnl = Math.Round(ledCash * inst.MasterInstrument.PointValue, 2);
                        Trades[openTag] = pnl;
                        closedTag = openTag; openTag = null; openRoot = null; openInst = null; ledAvg = 0;
                    }
                }
                c = helloed ? client : null;
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
                if (sd != null && pnl < 0) { SaveDay(); Log("agent " + Id + " stands down: " + sd); ToPages(StatusJson("warn", "Agent " + Id + " stands down: " + sd)); }
            }
            Notify();
        }

        private class ExcessFill { public string Key; public int Qty, TradeSign; public double Price, Pv; }
        private readonly Dictionary<string, ExcessFill> ExcessByTag = new Dictionary<string, ExcessFill>();   // entry tag -> the close's part beyond its trade

        // Review E1: its open trade while the pair is flat by both readings, with nothing of the agent working and no fill NinjaTrader
        // shows ahead of its event, for 5 s: ended, booked from its own executions; a warning when those do not net to zero.
        private double ghostSince = -1;

        private void EndGhostTrade(double now)
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

        private Order FindOrder(string orderId)
        {
            if (string.IsNullOrEmpty(orderId)) return null;
            Account a = FindAccount(Account);
            if (a != null) lock (a.Orders) foreach (Order o in a.Orders) if (o.OrderId == orderId) return o;
            lock (Sync) foreach (Order o in Placed) if (o.OrderId == orderId) return o;
            return null;
        }

        // The account's position on the agent's roots, to the agent.
        public void OnPosition(PositionEventArgs e)
        {
            string root = ChartBridgeServer.RootFor(e.Position.Instrument);
            if (root == null || !RulesNow().Roots.Contains(root)) return;
            ChartBridgeClient c;
            lock (Sync) c = helloed ? client : null;
            if (c == null) return;
            int q = e.MarketPosition == MarketPosition.Long ? e.Quantity : e.MarketPosition == MarketPosition.Short ? -e.Quantity : 0;
            c.Send("{\"type\":\"position\",\"account\":" + CbJson.Str(Account) + ",\"root\":" + CbJson.Str(root) + ",\"qty\":" + q.ToString(CultureInfo.InvariantCulture) +
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
            RollDay();
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
            string clash = AccountConflict();
            if (clash != null)
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
            List<string> roots = FlatRoots();
            DropLedgerAgainst(roots);
            EndGhostTrade(now);
            foreach (string root in roots) Owns(root);
            if (ChartBridgeServer.ExecutionsReplayed(Account)) { DropStaleRecords(roots); WarnHeldByStopOnly(roots); }
            RepeatTradeLost(now);   // only once the session's executions were read again (review B)
            // the flat time (ruling 2): from flatAt until the next entryFrom in session order (0.5.2: with an 18:00 entryFrom a
            // position held across midnight is inside the session and stays; with 09:45 one held overnight is flattened, as
            // before) and while the market is closed, whatever the agent does or whether it is there
            bool flatHours = FlatHours(r, etNow), fromBefore;
            lock (Sync) fromBefore = Carried.Count > 0;
            if (fromBefore && !roots.Any(x => Owns(x))) { lock (Sync) Carried.Clear(); fromBefore = false; SaveDay(); }   // flat: nothing left from the session before
            flatHours = flatHours || fromBefore;   // 0.5.2 review: a position whose trade began in an earlier session is flattened, the market open
            if (!startTold && now - startedMs >= ChartBridgeAgents.SilenceMs)
            {
                startTold = true;
                List<string> held = roots.Where(x => Owns(x)).ToList();
                if (held.Count > 0)
                {
                    string text = "Agent " + Id + " holds a position or orders on " + string.Join(", ", held) + " on " + Account + " since ChartBridge started: its stop and target stay, and it is flattened at " +
                                  Hm(r.FlatAt) + (flatHours ? " (now: outside its trading hours)" : "") + "; check NinjaTrader";
                    Log(text); AgentLog(text); ChartBridgeOrders.AgentAlarm(text);
                }
            }
            if (flatHours) StartFlatten(AtFlatTime(r, etNow) ? Id + " flattened at " + Hm(r.FlatAt) + " by its rules" : fromBefore && !FlatHours(r, etNow) ? Id + " held a position from an earlier session (its " + Hm(r.FlatAt) + " flatten did not finish): flattened by its rules" : Id + " held a position outside its trading hours (" + Hm(r.FlatAt) + " to " + Hm(r.EntryFrom) + (ChartBridgeCme.Closed(etNow) ? ", or the market closed" : "") + "): flattened by its rules", true);
            StepFlatten(now);
            WelcomeIfCapsChanged();
            SendState(false);   // a change no event carries (the session's roll, the clock, a file): within one pass
            if (strip) ToPages(StripJson());
        }

        // The roots a flatten looks at: its rules' roots, or (rules file unreadable) every root an agent may trade.
        private List<string> FlatRoots()
        {
            lock (Sync) return rulesBroken != null ? new List<string> { "NQ", "MNQ", "ES", "MES" } : rules.Roots.ToList();
        }

        // An open trade record counts only while something of it is listed (its entry or its legs, by tag) or the ledger follows it;
        // otherwise it is dropped with a warning, so it can never make the agent own a position it did not place.
        private void DropStaleRecords(List<string> roots)
        {
            List<string> open;
            lock (Sync) open = Trades.Where(kv => double.IsNaN(kv.Value) && kv.Key != openTag).Select(kv => kv.Key).ToList();
            if (open.Count == 0) return;
            Account a = FindAccount(Account);
            List<Order> orders = new List<Order>();
            if (a != null) lock (a.Orders) orders = a.Orders.ToList();
            foreach (string key in open)
            {
                string tag = key.Length > 8 ? key.Substring(0, 8) : key;
                if (orders.Any(o => ChartBridgeAgents.TagOf(o.Name) == tag && ChartBridgeOrders.AgentMayFillState(o.OrderState))) continue;
                lock (Sync) { double v; if (Trades.TryGetValue(key, out v) && double.IsNaN(v)) Trades.Remove(key); }
                string text = "Agent " + Id + ": the day file's open trade " + key + " matches nothing ChartBridge sees (no order of it listed, no fill of it this session): dropped, so it never claims a position it did not place";
                Log(text); AgentLog(text); ChartBridgeOrders.AgentWarn(text);
                SaveDay();
                // review A3: a position on its roots there is never left without a word: an error every 60 s until that pair is flat
                if (a != null) foreach (string root in roots) { Instrument inst = ChartBridgeServer.InstrumentFor(root); if (inst != null && (ChartBridgeOrders.AgentListed(a, inst) != 0 || ChartBridgeOrders.AgentEffective(a, inst) != 0)) TradeLost(root); }
                Notify();
            }
        }

        // Review A1 and A3: its open trade ended where ChartBridge could not see it while the account holds a position: the trade is
        // dropped (ownership is not restored: Anthony decides), and the pages get an error every 60 s until that pair is flat.
        private void DropLedgerAgainst(List<string> roots)
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
        private void WarnHeldByStopOnly(List<string> roots)
        {
            Account a = FindAccount(Account);
            if (a == null) return;
            foreach (string root in roots)
            {
                bool followed, told;
                lock (Sync) { followed = openTag != null && openRoot == root; told = LostTrades.ContainsKey(root); }
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

        private void TradeLost(string root) { TradeLost(root, null); }

        private void TradeLost(string root, string say)
        {
            string text = say ?? "agent " + Id + " had an open trade on " + Account + " " + root + " and its legs are gone; ChartBridge no longer treats the position as the agent's: flatten or protect it by hand";
            lock (Sync) { LostTrades[root] = Now(); LostTradeText[root] = text; }
            Log(text); AgentLog(text); ChartBridgeOrders.AgentAlarm(text);
        }

        // Every pass: each lost-trade error again every 60 s until that pair is flat by both readings (lead's default: the pages have
        // no acknowledge message for it, so it ends only when the pair is flat).
        private void RepeatTradeLost(double now)
        {
            List<string> roots;
            lock (Sync) roots = LostTrades.Keys.ToList();
            if (roots.Count == 0) return;
            Account a = FindAccount(Account);
            foreach (string root in roots)
            {
                Instrument inst = ChartBridgeServer.InstrumentFor(root);
                bool flat = a != null && inst != null && ChartBridgeOrders.AgentListed(a, inst) == 0 && ChartBridgeOrders.AgentEffective(a, inst) == 0;
                string text = null;
                lock (Sync)
                {
                    if (flat) { LostTrades.Remove(root); LostTradeText.Remove(root); continue; }
                    if (now - LostTrades[root] >= ChartBridgeAgents.LostTradeEveryMs) { LostTrades[root] = now; text = LostTradeText[root]; }
                }
                if (text != null) { AgentLog(text); ChartBridgeOrders.AgentAlarm(text); }
            }
        }

        // ---------------------------------------------------------- the flatten (flatAt, or the agent's own in auto)
        // Per root it owns or has orders working on: every order that may fill on that contract of its account is cancelled; once
        // NinjaTrader confirms each one done, every fill there has come through, and both position readings agree, what it holds is
        // closed at market ("CB#<tag> ag:<id> flat"). Readings still apart after 3 s: the smaller is closed (never more than either
        // shows). Not flat 10 s after the start: a status error to the pages, every 10 s until flat. Returns how many roots started.
        private int StartFlatten(string why, bool byRules)
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

        private void StepFlatten(double now)
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
                        lock (Sync) { Flats.Remove(key); flattenedAt = at; }
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
                    if (now - j.StartMs >= ChartBridgeAgents.FlatErrorEveryMs && now - j.LastErrorMs >= ChartBridgeAgents.FlatErrorEveryMs)
                    {
                        j.LastErrorMs = now;
                        string text = "Agent " + Id + ": NOT FLAT " + ((now - j.StartMs) / 1000).ToString("0", CultureInfo.InvariantCulture) + " s after its flatten (" + j.Why + "): " + j.Root + " on " + a.Name +
                                      " still shows " + p1 + "; market not trading: " + (j.GateAgain ? "its stop placed again at " + CbJson.Num(j.StopPx) + " stays; ChartBridge tries again when it trades" : "the stop and target stay; ChartBridge tries again when it trades");
                        ChartBridgeOrders.AgentAlarm(text); AgentLog(text);
                    }
                    continue;
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
                        lock (Sync) { Flats.Remove(key); flattenedAt = at; }
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
            if (m == "auto") { string why = AccountProblemFor(Account, true) ?? AccountConflict(); if (why != null) return "auto refused: " + why; }   // auto: its account must be tradable
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

        private string SetKill(Dictionary<string, Val> d) { lock (PlaceGate) return SetKillLocked(d); }   // never between a placement's checks and its order

        private string SetKillLocked(Dictionary<string, Val> d)
        {
            bool on;
            if (!Bool(d, "on", out on)) return "on must be true or false";
            List<Proposal> expired = new List<Proposal>();
            lock (Sync) { killed = on; if (on) expired = ExpireOpenLocked("not answered"); }
            if (on)
            {
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
            bool cancelled = why == null && withdrawn != null && placed != null && Cancel(placed, "withdrawn by the agent during placement: " + withdrawn);
            if (cancelled) lock (Sync) p.State = "withdrawn";
            ToPages(ProposalJson(p));
            if (why == null)
            {
                ToAgent(AnswerJson(id, "accepted", "accepted on the page"));
                ToAgent(AnswerJson(id, cancelled ? "withdrawn" : "placed", cancelled ? "withdrawn during placement: its entry is cancelled" : "placed on " + p.Account + " as order " + ChartBridgeOrders.AgentIdFor(placed) + "; it works until " + Iso(p.P.ExpiresAt)));
            }
            else { lock (Sync) nRefused++; ToAgent(AnswerJson(id, "refused", why)); }
            AgentLog("proposal " + id + " accepted on the page" + (why == null ? ": placed on " + p.Account + (cancelled ? " and withdrawn during placement" : "") : " but refused: " + why));
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
            if (!PlainName(nm)) return "account must be an account name";
            if (d.ContainsKey("keepMode") && keep != "shadow" && keep != "copilot" && keep != "auto") return "keepMode must be shadow, copilot or auto (the mode the page's question named)";
            ChartBridgeAgents.RefreshFiles();   // a page's thread: the copies are read fresh
            string bot = ChartBridgeAgents.BotAccountForAgents();   // on or off (lead's default)
            if (bot == null) return "bot-account.txt cannot be read or understood, so ChartBridge cannot tell the bot's account: fix or delete it first";
            if (string.Equals(nm, bot, StringComparison.OrdinalIgnoreCase)) return nm + " is the bot's account: an agent never trades it";
            string cw = ChartBridgeAgents.CopierUses(nm);
            if (cw != null) return cw + ": an agent never trades it";
            foreach (ChartBridgeAgent other in ChartBridgeAgents.All())
                if (other != this && other.Chosen && string.Equals(other.Account, nm, StringComparison.OrdinalIgnoreCase)) return nm + " is agent " + other.Id + "'s account: each agent has its own";
            string why = AccountProblemFor(nm, true);
            if (why != null) return why;
            if (Exposed()) return "agent " + Id + " has a position, a working entry or a proposal: choose its account when it is flat";
            string old = Account;
            bool broken;
            lock (Sync) broken = accountBroken != null;
            if (nm == old && !broken && Chosen) return null;   // already its chosen account (choosing its unchosen default writes the file: it is then its own)
            foreach (string root in RulesNow().Roots)
            {
                if (ChartBridgeOrders.AgentHoldsOnRoot(FindAccount(nm), root)) return nm + " holds a position or a working order on " + root + ": choose agent " + Id + "'s account when both accounts are flat on its roots";
                if (nm != old && ChartBridgeOrders.AgentHoldsOnRoot(FindAccount(old), root)) return "agent " + Id + "'s account " + old + " holds a position or a working order on " + root + ": choose its account when both accounts are flat on its roots";
            }
            string err = SaveAccount(nm);
            if (err != null) return "agent-" + Id + "-account.txt could not be saved (" + err + "); nothing changed";
            // 0.5.2 (Anthony 2026-10-08): the mode is kept only when the page says which mode its question named (keepMode) and that is
            // still the agent's mode; an older page (no keepMode, its question says the agent goes to Shadow) or a mode changed since
            // the question (another page) puts the agent in shadow, as until 0.5.1.
            string wasMode;
            bool kept;
            lock (Sync) { account = nm; accountBroken = null; chosen = true; Sticky.Clear(); wasMode = mode; kept = keep != null && keep == mode; if (!kept) mode = "shadow"; }
            string mark = SimNow() ? "Sim" : "LIVE";
            string modeSay = kept ? "mode " + wasMode + " kept" : wasMode == "shadow" ? "mode shadow" : "mode shadow (was " + wasMode + (keep == null ? ": the page did not say which mode it showed" : ": the page's question named " + keep) + ")";
            Log("agent " + Id + " account " + nm + " (" + mark + "), was " + old + ", set by the page; " + modeSay);
            AgentLog("account " + nm + " (" + mark + "), was " + old + ", set by the page; " + modeSay);
            ToAgent(WelcomeJson());
            Notify();
            return null;
        }

        private bool Exposed()
        {
            bool ex;
            lock (Sync) ex = openTag != null || Proposals.Values.Any(p => p.State == "open" || p.State == "accepting");
            return ex || WorkingEntries().Count > 0 || RulesNow().Roots.Any(r => Owns(r));
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
            if (Exposed()) return "agent " + Id + " has a position, a working entry or an open proposal: change its rules when it is flat";
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

        private static string AnswerJson(string id, string answer, string text)
        {
            return "{\"type\":\"answer\",\"id\":" + CbJson.Str(id) + ",\"answer\":" + CbJson.Str(answer) + ",\"text\":" + CbJson.Str(text) + "}";
        }

        private static string Ms(double v) { return v >= 0 ? v.ToString("0", CultureInfo.InvariantCulture) : "null"; }
        private static string Iso(double ms) { return new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(ms).ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture); }
        private static string Raw(string t) { return t ?? "null"; }
        private static string Str(string s) { return s != null ? CbJson.Str(s) : "null"; }

        // welcome.rules (contract section 10 item 8): the caps ChartBridge really enforces on this agent's entries: per root the
        // smallest of its rule, the hard ceiling and config.txt's gate 3 cap (DefaultMaxQty when config.txt names none), plus
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
                   ",\"riskDollars\":" + Raw(p.RiskText) + ",\"setup\":" + Str(p.Setup) + ",\"reason\":" + Str(p.Reason) + ",\"confidence\":" + Raw(p.ConfText);
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
            return "{\"type\":\"agentProposal\",\"agent\":" + CbJson.Str(Id) + ",\"id\":" + CbJson.Str(pr.P.Id) + ",\"at\":" + Ms(pr.P.At) + ",\"account\":" + CbJson.Str(pr.Account) +
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
            return "{\"type\":\"welcome\",\"version\":" + CbJson.Str(ChartBridgeServer.Version) + ",\"agent\":" + CbJson.Str(Id) + ",\"mode\":" + CbJson.Str(m) + ",\"account\":" + CbJson.Str(Account) +
                   ",\"sim\":" + (SimNow() ? "true" : "false") + ",\"rules\":" + NoteWelcomeRules(EnforcedRulesJson(r)) + ",\"instruments\":" + ins + "}";
        }

        private bool OwnsAny() { return RulesNow().Roots.Any(x => Owns(x)); }

        // What the order path asks at the last moment (ChartBridgeAgents.PlacingProblem): killed, shadow, outside the window.
        public string PlacingProblem()
        {
            Rules r = RulesNow();
            string m;
            bool k;
            lock (Sync) { m = mode; k = killed; }
            if (k) return "the kill switch is on (release it on the Agent tab)";
            if (m == "shadow") return "agent " + Id + " is in shadow: nothing is placed";
            DateTime et = NowEt();
            if (!InWindow(r, et)) return WindowRefusal(r, et);   // 0.5.2: session time, the market open
            return null;
        }

        private string StateJson()
        {
            string sd = StandDown();
            bool owns = OwnsAny();
            lock (Sync)
            {
                return "{\"type\":\"agentState\",\"mode\":" + CbJson.Str(mode) + ",\"killed\":" + (killed ? "true" : "false") + ",\"standDown\":" + Str(sd) +
                       ",\"trades\":" + Trades.Count + ",\"losses\":" + LossesLocked() + ",\"pnlToday\":" + CbJson.Num(Math.Round(Trades.Values.Where(v => !double.IsNaN(v)).Sum(), 2)) +
                       ",\"owns\":" + (owns ? "true" : "false") + ",\"session\":" + Str(session) + "}";
            }
        }

        public string StripJson()
        {
            bool sim = SimNow(), owns = OwnsAny();
            string sd = StandDown();
            Rules r = RulesNow();
            StringBuilder b = new StringBuilder("{\"type\":\"agent\"");
            lock (Sync)
            {
                double now = Now();
                b.Append(",\"agent\":").Append(CbJson.Str(Id))
                 .Append(",\"name\":").Append(Str(name)).Append(",\"build\":").Append(Str(build))
                 .Append(",\"enabled\":true")
                 .Append(",\"connected\":").Append(client != null && helloed ? "true" : "false")
                 .Append(",\"mode\":").Append(CbJson.Str(mode))
                 .Append(",\"account\":").Append(CbJson.Str(account))
                 .Append(",\"sim\":").Append(sim ? "true" : "false")
                 .Append(",\"rules\":").Append(RulesJson(r))
                 .Append(",\"position\":").Append(openTag != null && ledQty != 0 ? "{\"root\":" + CbJson.Str(openRoot) + ",\"qty\":" + ledQty.ToString(CultureInfo.InvariantCulture) + ",\"avgPrice\":" + CbJson.Num(ledAvg) + "}" : "null")
                 .Append(",\"pnlToday\":").Append(CbJson.Num(Math.Round(Trades.Values.Where(v => !double.IsNaN(v)).Sum(), 2)))
                 .Append(",\"trades\":").Append(Trades.Count)
                 .Append(",\"losses\":").Append(LossesLocked())
                 .Append(",\"killed\":").Append(killed ? "true" : "false")
                 .Append(",\"standDown\":").Append(Str(sd))
                 .Append(",\"owns\":").Append(owns ? "true" : "false")
                 .Append(",\"lastBeatMs\":").Append(client != null ? Ms(Math.Max(0, now - lastMsgMs)) : "null")
                 .Append(",\"lastPlan\":").Append(lastPlanJson ?? "null");
            }
            return b.Append('}').ToString();
        }

        public string DiagJson()
        {
            lock (Sync)
            {
                return "{\"connected\":" + (client != null ? "true" : "false") + ",\"mode\":" + CbJson.Str(mode) + ",\"killed\":" + (killed ? "true" : "false") +
                       ",\"plans\":" + nPlans + ",\"proposals\":" + nProposals + ",\"placed\":" + nPlaced + ",\"refused\":" + nRefused + ",\"heartbeatLost\":" + nHeartbeatLost +
                       ",\"flattenedAt\":" + Str(flattenedAt) + ",\"secretFile\":" + CbJson.Str(secretState) + "}";
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
