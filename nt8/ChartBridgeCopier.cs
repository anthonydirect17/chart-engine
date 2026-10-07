// ChartBridge copier engine (protocol v3, ChartBridge 0.4.0). Part of the ChartBridge add-on; install it with the other
// ChartBridge files. See nt8/PROTOCOL.md, "Copier engine (copier = on)" and "Copier engine: as built (0.4.0)".
//
// OFF by default: nothing here runs unless config.txt has "copier = on", and "trading = true" stays the master switch above
// it. With the switch off every copier message is refused and every hook below returns at once, so ChartBridge behaves as
// 0.3.8 did. Decided by Anthony (2026-10-07). The safety rules, each named where it is enforced:
//   S1 Sim only. Every follower order (entry, stop, move, exit) needs an account on NinjaTrader's own simulator; a real
//      account is refused at copierFollower and again before every order, and logged. 0.4.0 has no unlock.
//   S2 One leader. Only entries placed from ChartBridge's own page on the leader are copied, and only while the copier is
//      armed with a follower on; such an entry must carry a stop. Exits on the leader are always copied, whatever caused them.
//   S3 A stop at once. Each follower fill gets its own stop at the broker at the SAME PRICE as the leader's stop; when the
//      leader's stop moves, the follower's moves to the same price. A stop level already traded: a market exit instead.
//      A fill whose stop price cannot be known is flattened (never left without a stop).
//   S4 Never cross zero. A follower exit is NinjaTrader's Flatten on that root (its working orders cancelled first, then
//      the rest closed); a scale-out first shrinks the follower's stops, waits for NinjaTrader to confirm, then reduces
//      to the same share of what it holds. A flat follower gets nothing. Never an opposite order sized from the leader.
//   S5 Skipped, never partly: a follower at its position limit (gate 3), not Connected, unchecked (gate 2), Gone, past
//      its loss limit, or holding the opposite side.
//   S6 Mass disconnect: the leader, or 3 or more followers, leaving Connected within 10 s stands the copier down until
//      Re-arm. Every start begins stood down. Exits and stop moves still go to followers that hold a copier position.
//   S7 The sweep: every second, a copier order on a follower that is flat (both readings) is cancelled.
//   S8 Every decision is logged with its timing (copier.log, the Output window, copierEvent).
// Order calls live only in the functions named in test/nt8-source.test.js ("copier order calls"). Copier orders on a
// follower go through one copier thread, in order, under ChartBridgeOrders' PlaceLock (one order check and send at a
// time across all pages), so NinjaTrader's event thread only records and queues.
// Written in C# 5 syntax (NinjaTrader 8 compiles NinjaScript as C# 5).
#region Using declarations
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.WebSockets;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using NinjaTrader.Cbi;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    // ---------------------------------------------------------------- the copier's window into ChartBridgeOrders
    // The copier reuses the order code's own gates (the same functions, never a copy), read through these wrappers.
    public static partial class ChartBridgeOrders
    {
        internal static object CopierPlaceLock { get { return PlaceLock; } }
        internal static string CopierGate(ChartBridgeClient c) { return Gate(c); }                                  // gates 1, 4 and 7
        internal static Account CopierFindAccount(string name, out string why) { return FindAccount(name, out why); }   // gate 2 (entries)
        internal static string CopierStatus(Account a) { return StatusOf(a); }
        internal static bool CopierSteady(Account a) { return Steady(a, ChartBridgeTime.NowUtcMs()); }
        internal static int CopierListed(Account a, Instrument i) { return SignedPosition(a, i); }
        internal static int CopierEffective(Account a, Instrument i) { return EffectivePosition(a, i); }
        internal static bool CopierFreshLast(string root, out double last) { return FreshLast(root, FreshTickMs, out last); }
        internal static string CopierPriceProblem(string root, double tick, string kind, bool isBuy, double price) { return PriceProblem(root, tick, kind, isBuy, price); }
        internal static double CopierRound(double price, double tick) { return Round(price, tick); }
        internal static bool CopierIsBuy(Order o) { return IsBuy(o); }
        internal static bool CopierDone(Order o) { return IsDone(o.OrderState); }
        internal static void CopierAlarm(string text) { Alarm(text); }
        internal static void CopierWarn(string text) { Warn(text); }
        internal static bool CopierIsLeg(Order o, string role) { Match m = LegNameRx.Match(o.Name ?? ""); return m.Success && m.Groups[2].Value == role; }

        // Gate 3 for a follower order, the rule PlaceOrderLocked applies: the order and the position it could become (the
        // position read two ways, the worse taken, plus every working order on that side, plus this order) within the cap.
        internal static string CopierCapProblem(Account a, Instrument inst, string root, bool isBuy, int qty)
        {
            int posNow = SignedPosition(a, inst), posEff = EffectivePosition(a, inst), pendBuy, pendSell, cap = CapFor(root);
            int pos = isBuy ? Math.Max(posNow, posEff) : Math.Min(posNow, posEff);
            if (qty > cap) return "qty " + qty + " is over the " + root + " cap of " + cap + " (maxQty." + root + " in config.txt)";
            PendingOrders(a, inst, out pendBuy, out pendSell);
            long worst = isBuy ? (long)pos + pendBuy + qty : (long)(-pos) + pendSell + qty;
            if (worst > cap) return "it could make the " + root + " position " + worst + " contracts; the cap is " + cap + " (maxQty." + root + " in config.txt)";
            return null;
        }

        // A copier order just sent counts in gate 3 at once (Ours), and a follower stop is a ChartBridge leg: young legs are
        // left alone by the flat-position cleanup, and the missing-stop alarm watches the follower's position.
        internal static void CopierSent(Order o, bool stop)
        {
            lock (Sync)
            {
                IdFor(o);
                Ours.Add(o);
                if (stop) { LegBorn[o] = ChartBridgeTime.NowUtcMs(); Manage(o.Account, o.Instrument); }
            }
        }

        // Before a copier Flatten: the follower's legs are cancelled by ChartBridge, not lost.
        internal static void CopierNoteFlatten(Account a, Instrument inst) { NoteWeCancelSafe(() => WorkingLegs(a, inst), "flatten"); }

        // The leader entry's planned stop ticks (0 for none); reads the account's orders: call without Sync.
        internal static int CopierPlannedStopTicks(Order entry)
        {
            Bracket br = BracketFor(entry);
            if (br == null) return 0;
            lock (Sync) return br.StopTicks;
        }

        // Strict v3 messages (gate 8): no escape, one flat object, no list, no key twice, only the keys allowed, printable.
        internal static string CopierStrict(string type, string text, string[] allowed)
        {
            if (text.IndexOf('\\') >= 0) return "message has an escape sequence; ChartBridge's page never sends one";
            if (text.Any(ch => ch < ' ')) return "message has a control character";
            if (text.Count(ch => ch == '{') != 1 || text.Count(ch => ch == '[') != 0) return "message has an unexpected nested object or list";
            if (Duplicate(text)) return "message has a key twice";
            string odd = Unknown(text, allowed);
            return odd != null ? "unknown key \"" + odd + "\" in " + type : null;
        }
        internal static bool CopierHas(string text, string key) { return Has(text, key); }
        internal static string CopierStr(string text, string key) { return Str(text, key); }
        internal static int CopierInt(string text, string key, out int v) { return Int(text, key, out v); }
        internal static bool CopierNull(string text, string key) { return IsNull(text, key); }

        // Hook from PlaceLegs: a fill increment of a ChartBridge entry has its legs (stop null: no stop, or exited at once).
        private static void CopierLeaderFill(Bracket br, int filled, int qty, double incPrice, Order stop, double stopPrice)
        {
            try { ChartBridgeCopier.LeaderFilled(br.Account, br.Instrument, br.Tag, br.EntryIsBuy, filled, qty, incPrice, stop, stop != null ? stopPrice : 0); }
            catch (Exception ex) { ChartBridgeServer.Log("copier error: " + ex.Message); }
        }
    }

    // ---------------------------------------------------------------- the copier
    public static class ChartBridgeCopier
    {
        // ---------------------------------------------------------- the switch (config.txt, off by default)
        public static bool Enabled;
        public static void ResetConfig() { Enabled = false; }

        // "copier = on" (on, true or 1, any case); anything else is off, with one Output line naming the value.
        public static bool ReadConfig(string key, string val)
        {
            if (key != "copier") return false;
            string v = (val ?? "").Trim();
            Enabled = v.Equals("on", StringComparison.OrdinalIgnoreCase) || v.Equals("true", StringComparison.OrdinalIgnoreCase) || v == "1";
            if (!Enabled) ChartBridgeServer.Log("config.txt: copier = " + v + ": the copier is off");
            return true;
        }

        public const int MaxQtyPerContract = 9, MassFollowers = 3, LeaderMsKept = 200;
        public const double MassWindowMs = 10000, ReduceConfirmMs = 3000, LeaderStopWaitMs = 2000;
        private const string StartWhy = "ChartBridge started: check the accounts and press Re-arm";

        // Read from NinjaTrader by default; the accounts lane's own readings can be plugged in here.
        public static Func<Account, bool> IsSim = ReadSim;
        public static Func<Account, bool> IsGone = a => false;
        public static Func<Account, double?> PnlToday = ReadPnlToday;
        public static Func<ChartBridgeClient, bool> IsV3 = SentClientV3;
        public static bool HarnessManual;   // test hook: no copier thread and no timer; work runs on the caller's thread and the harness calls Tick (unused in NinjaTrader)

        // ---------------------------------------------------------- state (all under Lk)
        private static readonly object Lk = new object();

        private class Follower
        {
            public string Name, Size = "micro", LastAction, Skipped, LossHitSession;
            public bool On;
            public int Qty = 1, LossLimit;   // LossLimit 0 = off
            public double LastAt;
            public double? Slippage;
        }

        private class LeaderEntry
        {
            public Order Entry, LastStop;
            public string Tag, Kind, Root;
            public Instrument Inst;
            public bool Buy, Copy;
            public double Price, LastStopPrice;
            public readonly List<FEntry> Copies = new List<FEntry>();   // orders mode: the followers' orders
        }

        private class FEntry   // one copier entry order on one follower
        {
            public Order Order, LeaderStop;
            public Follower F;
            public Account A;
            public Instrument Inst, LInst;
            public string Root, Tag;
            public bool Buy, OrdersMode;
            public LeaderEntry L;
            public double LeaderStopPrice, LeaderFill = double.NaN, CoveredValue;
            public long LeaderTs, SentTs;
            public int Covered;
        }

        private class FStop { public Order Stop, LeaderStop; public Copy C; public double Born; public bool RemapSaid; }

        private class Copy     // a follower's copied position on one contract
        {
            public Account A;
            public Follower F;
            public Instrument Inst, LInst;
            public string Root, Tag;
            public int Dir, Intended;
            public double FlatSince;
            public readonly List<FStop> Stops = new List<FStop>();
        }

        private class Reduce { public Copy C; public int Target; public long Ts; public double Since; public string Why; public readonly Dictionary<Order, int> Watch = new Dictionary<Order, int>(); }
        private class Waiting { public FEntry Fe; public int Mark, Qty; public double Price, Since; public long FillTs; }

        private static string leader, mode = "executions", lastLeaderRoot = "MNQ";
        private static bool armed, loadFailed;
        private static string standDownWhy = StartWhy, saveFailed;
        private static readonly List<Follower> Followers = new List<Follower>();
        private static readonly Dictionary<string, LeaderEntry> LeaderByTag = new Dictionary<string, LeaderEntry>();
        private static readonly Dictionary<Order, LeaderEntry> LeaderByOrder = new Dictionary<Order, LeaderEntry>();
        private static readonly Dictionary<Order, FEntry> FEntries = new Dictionary<Order, FEntry>();
        private static readonly Dictionary<Order, FStop> FStops = new Dictionary<Order, FStop>();
        private static readonly Dictionary<Order, double> LeaderStopPrice = new Dictionary<Order, double>();   // mapped leader stops, last price seen
        private static readonly Dictionary<string, Copy> Copies = new Dictionary<string, Copy>();
        private static readonly Dictionary<Order, double> Placed = new Dictionary<Order, double>();   // every copier order, when sent (the sweep)
        private static readonly Dictionary<string, int> LeaderPos = new Dictionary<string, int>();   // leader contract -> signed position last seen
        private static readonly Dictionary<string, bool> WasUp = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
        private static readonly List<KeyValuePair<string, double>> Drops = new List<KeyValuePair<string, double>>();
        private static readonly List<Reduce> Reduces = new List<Reduce>();
        private static readonly List<Waiting> Waits = new List<Waiting>();
        private static readonly List<double> LeaderMs = new List<double>();
        private static long decisions, skippedCount, standDowns;
        private static string lastStateSent;

        private static Follower FollowerNamed(string name) { return Followers.FirstOrDefault(f => f.Name.Equals(name ?? "", StringComparison.OrdinalIgnoreCase)); }
        private static bool IsLeader(string name) { return leader != null && name != null && leader.Equals(name, StringComparison.OrdinalIgnoreCase); }

        private static void ResetState()
        {
            leader = null; mode = "executions"; lastLeaderRoot = "MNQ"; armed = false; standDownWhy = StartWhy; loadFailed = false; saveFailed = null;
            Followers.Clear(); LeaderByTag.Clear(); LeaderByOrder.Clear(); FEntries.Clear(); FStops.Clear(); LeaderStopPrice.Clear(); Copies.Clear(); Placed.Clear();
            LeaderPos.Clear(); WasUp.Clear(); Drops.Clear(); Reduces.Clear(); Waits.Clear(); LeaderMs.Clear();
            decisions = 0; skippedCount = 0; standDowns = 0; lastStateSent = null;
        }

        // ---------------------------------------------------------- start and stop
        private static System.Threading.Timer timer;
        private static BlockingCollection<Action> queue;
        private static Thread worker;
        private static int busy;

        // Called by ChartBridgeServer.Start. Every start begins stood down (S6).
        public static void Start()
        {
            lock (Lk) ResetState();
            if (!Enabled) return;   // off: nothing loads and nothing runs
            Load();
            if (HarnessManual) return;
            BlockingCollection<Action> q = new BlockingCollection<Action>();
            queue = q;
            worker = new Thread(() => { foreach (Action a in q.GetConsumingEnumerable()) { Interlocked.Exchange(ref busy, 1); Run(a); Interlocked.Exchange(ref busy, 0); } });
            worker.IsBackground = true;
            worker.Name = "ChartBridge copier";
            worker.Start();
            timer = new System.Threading.Timer(delegate { try { Tick(); } catch (Exception ex) { ChartBridgeServer.Log("copier tick error: " + ex.Message); } }, null, 1000, 1000);
            ChartBridgeServer.Log("the copier is ON (Sim followers only); it starts stood down: press Re-arm on the page");
        }

        public static void Stop()
        {
            try { if (timer != null) timer.Dispose(); } catch (Exception) { }
            timer = null;
            BlockingCollection<Action> q = queue;
            queue = null;
            if (q != null) { try { q.CompleteAdding(); } catch (Exception) { } }
            Thread w = worker;
            worker = null;
            if (w != null) { try { w.Join(500); } catch (Exception) { } }
            FlushLog();
            lock (Lk) ResetState();
            lock (V3) V3.Clear();
        }

        // Copier work, in order, on the copier thread (NinjaTrader's event thread never waits for an order check).
        private static void Work(Action a)
        {
            BlockingCollection<Action> q = queue;
            if (HarnessManual) { Run(a); return; }
            if (q == null) return;   // stopped: nothing runs
            try { q.Add(a); } catch (InvalidOperationException) { }   // stopping
        }

        private static void Run(Action a)
        {
            try { a(); }
            catch (Exception ex)
            {
                ChartBridgeServer.Log("copier error: " + ex);
                ChartBridgeOrders.CopierAlarm("copier error (" + ex.Message + "); check every follower's position and stop in NinjaTrader");
            }
        }

        // Test hook: true once the copier thread has nothing queued or running.
        public static bool WaitIdle(int ms)
        {
            Stopwatch sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < ms)
            {
                BlockingCollection<Action> q = queue;
                if ((q == null || q.Count == 0) && Interlocked.CompareExchange(ref busy, 0, 0) == 0) { Thread.Sleep(20); if ((q == null || q.Count == 0) && busy == 0) return true; }
                Thread.Sleep(5);
            }
            return false;
        }

        // ---------------------------------------------------------- reading NinjaTrader
        // S1: an account on NinjaTrader's own simulator: its Provider (Account.Provider, else Account.Connection.Options.Provider)
        // reads exactly "Simulator". Anything else, or nothing readable, is not Sim (refused). Backtest and Playback never.
        private static bool ReadSim(Account a)
        {
            if (a == null || ChartBridgeOrders.IsNeverTradable(a.Name ?? "")) return false;
            return ProviderOf(a) == "Simulator";
        }

        public static string ProviderOf(Account a)
        {
            try
            {
                object v = Prop(a, "Provider");
                if (v == null) v = Prop(Prop(Prop(a, "Connection"), "Options"), "Provider");
                return v != null ? v.ToString() : null;
            }
            catch (Exception) { return null; }
        }

        private static object Prop(object o, string name)
        {
            if (o == null) return null;
            PropertyInfo p = o.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
            return p != null ? p.GetValue(o, null) : null;
        }

        // Today's P&L (realized plus unrealized, in the account's currency) as NinjaTrader reports it
        // (Account.Get(AccountItem.RealizedProfitLoss / UnrealizedProfitLoss, Currency.UsDollar)); null when not readable.
        private static double? ReadPnlToday(Account a)
        {
            try
            {
                MethodInfo get = a.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
                    .FirstOrDefault(m => m.Name == "Get" && m.GetParameters().Length == 2 && m.GetParameters()[0].ParameterType.Name == "AccountItem" && m.GetParameters()[1].ParameterType.Name == "Currency");
                if (get == null) return null;
                Type item = get.GetParameters()[0].ParameterType, cur = get.GetParameters()[1].ParameterType;
                object usd = Enum.Parse(cur, "UsDollar");
                double r = Convert.ToDouble(get.Invoke(a, new[] { Enum.Parse(item, "RealizedProfitLoss"), usd }), CultureInfo.InvariantCulture);
                double u = Convert.ToDouble(get.Invoke(a, new[] { Enum.Parse(item, "UnrealizedProfitLoss"), usd }), CultureInfo.InvariantCulture);
                return r + u;
            }
            catch (Exception) { return null; }
        }

        private static Account Find(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            lock (Account.All) foreach (Account a in Account.All) if (a.Name != null && a.Name.Equals(name, StringComparison.OrdinalIgnoreCase)) return a;
            return null;
        }

        private static bool Up(Account a) { return a != null && ChartBridgeOrders.CopierStatus(a) == "Connected"; }

        private static string ConnectionText(Account a)
        {
            string s = a != null ? ChartBridgeOrders.CopierStatus(a) : "";
            return s == "Connected" ? "connected" : s == "Connecting" ? "connecting" : s == "ConnectionLost" ? "lost" : "disconnected";
        }

        private static bool Working(Order o) { return o != null && ChartBridgeOrders.IsWorking(o.OrderState); }

        // The leader's NQ or MNQ maps to MNQ (micro) or NQ (mini); ES or MES to MES or ES. Anything else: none.
        public static string FollowerRoot(string leaderRoot, string size)
        {
            string r = (leaderRoot ?? "").ToUpperInvariant();
            bool micro = size == "micro";
            if (r == "NQ" || r == "MNQ") return micro ? "MNQ" : "NQ";
            if (r == "ES" || r == "MES") return micro ? "MES" : "ES";
            return null;
        }

        private static readonly Regex TagRx = new Regex("^CB#([0-9a-f]{8}) ");
        private static readonly Regex CopyEntryRx = new Regex("^CB#([0-9a-f]{8}) copy ([0-9a-f]{8})$");   // a copier entry on a follower: its tag, the leader entry's tag
        private static string TagOf(string name) { Match m = TagRx.Match(name ?? ""); return m.Success ? m.Groups[1].Value : null; }
        private static string NewTag() { return Guid.NewGuid().ToString("N").Substring(0, 8); }
        private static double Ms(long from, long to) { return (to - from) * 1000.0 / Stopwatch.Frequency; }
        private static string P(double v) { return v.ToString("0.########", CultureInfo.InvariantCulture); }

        // The follower's position along the copy's direction: the smaller of the two readings, 0 when either is flat or opposite.
        private static int Held(Account a, Instrument inst, int dir)
        {
            int l = ChartBridgeOrders.CopierListed(a, inst) * dir, e = ChartBridgeOrders.CopierEffective(a, inst) * dir;
            return l > 0 && e > 0 ? Math.Min(l, e) : 0;
        }

        private static bool Flat(Account a, Instrument inst) { return ChartBridgeOrders.CopierListed(a, inst) == 0 && ChartBridgeOrders.CopierEffective(a, inst) == 0; }

        // ---------------------------------------------------------- pages (protocol v3 only)
        // A page that sent {"type":"client","v":3}. Only those get copier messages (a v2 page gets no v3 message at all).
        private static readonly List<ChartBridgeClient> V3 = new List<ChartBridgeClient>();

        private static bool SentClientV3(ChartBridgeClient c) { lock (V3) return V3.Contains(c); }

        public static void NoteV3(ChartBridgeClient c)
        {
            lock (V3)
            {
                V3.RemoveAll(x => x.Socket != null && x.Socket.State != WebSocketState.Open && x.Socket.State != WebSocketState.Connecting);
                if (!V3.Contains(c)) V3.Add(c);
            }
        }

        private static void Broadcast(string json)
        {
            List<ChartBridgeClient> to;
            lock (V3) to = V3.ToList();
            foreach (ChartBridgeClient c in to) if (c.Trader && IsV3(c)) c.Send(json);
        }

        // After a successful auth: a v3 page gets the copier's state.
        public static void AfterAuth(ChartBridgeClient client)
        {
            try { if (client != null && client.Trader && IsV3(client)) client.Send(StateJson()); } catch (Exception ex) { ChartBridgeServer.Log("copier error: " + ex.Message); }
        }

        private static void Reject(ChartBridgeClient client, string cid, string reason)
        {
            client.Send("{\"type\":\"reject\"" + (cid != null ? ",\"cid\":" + CbJson.Str(cid) : "") + ",\"reason\":" + CbJson.Str(reason) + "}");
        }

        // ---------------------------------------------------------- messages from the page
        private static readonly Dictionary<string, string[]> Keys = new Dictionary<string, string[]>
        {
            { "copierGet", new[] { "type", "cid" } },
            { "copierSet", new[] { "type", "cid", "leader", "mode" } },
            { "copierFollower", new[] { "type", "cid", "account", "on", "qty", "size", "lossLimit" } },
            { "copierRearm", new[] { "type", "cid" } },
        };

        // client and copier* (ChartBridgeServer.OnClientMessage). Every refusal is a reject; nothing reaches NinjaTrader.
        public static void OnMessage(ChartBridgeClient client, string type, string text)
        {
            if (type == "client") { OnClient(client, text); return; }
            string cid = ChartBridgeOrders.CopierStr(text, "cid");
            try
            {
                string why = ChartBridgeOrders.CopierGate(client);   // trading on, the own signed-in page, 10 actions a second
                if (why == null && !IsV3(client)) why = "copier messages are protocol v3: send {\"type\":\"client\",\"v\":3} first";
                if (why == null && !Enabled) why = "The copier is off (copier in config.txt).";
                string[] allowed = null;
                if (why == null && !Keys.TryGetValue(type, out allowed)) why = "unknown message type " + type;
                else if (why == null) why = ChartBridgeOrders.CopierStrict(type, text, allowed);
                if (why == null && ChartBridgeOrders.CopierHas(text, "cid") && cid == null) why = "cid must be a plain string";
                if (why == null)
                {
                    if (type == "copierGet") { client.Send(StateJson()); return; }
                    if (type == "copierSet") why = SetLeader(text);
                    else if (type == "copierFollower") why = SetFollower(text);
                    else if (type == "copierRearm") why = Rearm();
                }
                if (why != null) Reject(client, cid, why);
            }
            catch (Exception ex)
            {
                ChartBridgeServer.Log("copier message error: " + ex.Message);
                Reject(client, cid, "ChartBridge error: " + ex.Message);
            }
        }

        // {"type":"client","v":3}, once after hello. Only v 3 is known.
        private static void OnClient(ChartBridgeClient client, string text)
        {
            int v;
            string why = ChartBridgeOrders.CopierStrict("client", text, new[] { "type", "v" });
            if (why == null && (ChartBridgeOrders.CopierInt(text, "v", out v) != 1 || v != 3)) why = "client: v must be 3 (this ChartBridge speaks protocol v3)";
            if (why != null) { client.Send("{\"type\":\"status\",\"level\":\"warn\",\"text\":" + CbJson.Str(why) + "}"); return; }
            NoteV3(client);
        }

        private static string SetLeader(string text)
        {
            bool hasLeader = ChartBridgeOrders.CopierHas(text, "leader"), hasMode = ChartBridgeOrders.CopierHas(text, "mode");
            string name = ChartBridgeOrders.CopierStr(text, "leader"), m = ChartBridgeOrders.CopierStr(text, "mode");
            if (!hasLeader && !hasMode) return "copierSet needs leader or mode.";
            if (hasLeader && string.IsNullOrEmpty(name)) return "leader must be an account name.";
            if (hasMode && m != "executions" && m != "orders") return "mode must be executions or orders.";
            if (loadFailed) return "copier.txt could not be read at start: the copier's settings cannot change until it can (restart ChartBridge)";
            Account a = hasLeader ? Find(name) : null;
            if (hasLeader && (a == null || ChartBridgeOrders.IsNeverTradable(a.Name))) return "No account " + name + ".";
            string old;
            lock (Lk)
            {
                if (hasLeader && FollowerNamed(name) != null) return name + " is a follower; the leader cannot be one.";
                old = leader;
            }
            foreach (string l in new[] { old, hasLeader ? a.Name : null })
            {
                string busyWhy = LeaderBusy(l);
                if (busyWhy != null) return busyWhy;
            }
            lock (Lk)
            {
                if (hasLeader) { leader = a.Name; LeaderPos.Clear(); }
                if (hasMode) mode = m;
            }
            Decision(null, "set", null, "leader " + (hasLeader ? a.Name : old ?? "(none)") + ", mode " + (hasMode ? m : mode) + " (set by the page)");
            Save();
            BroadcastState(true);
            return null;
        }

        // The copier cannot change while the leader has a position or a working ChartBridge entry.
        private static string LeaderBusy(string name)
        {
            Account a = Find(name);
            if (a == null) return null;
            List<Position> positions;
            lock (a.Positions) positions = a.Positions.ToList();
            foreach (Position p in positions)
                if (p.MarketPosition != MarketPosition.Flat && p.Quantity != 0 && ChartBridgeServer.RootFor(p.Instrument) != null)
                    return "The copier cannot change while the leader " + a.Name + " has a position.";
            List<Order> orders;
            lock (a.Orders) orders = a.Orders.ToList();
            foreach (Order o in orders)
                if (Working(o) && TagOf(o.Name) != null && !ChartBridgeOrders.CopierIsLeg(o, "stop") && !ChartBridgeOrders.CopierIsLeg(o, "target"))
                    return "The copier cannot change while the leader " + a.Name + " has a working entry.";
            return null;
        }

        private static string SetFollower(string text)
        {
            foreach (string k in new[] { "account", "on", "qty", "size", "lossLimit" })
                if (!ChartBridgeOrders.CopierHas(text, k)) return "copierFollower needs " + k + ".";
            string name = ChartBridgeOrders.CopierStr(text, "account"), size = ChartBridgeOrders.CopierStr(text, "size");
            Match on = Regex.Match(text, "\"on\"\\s*:\\s*(true|false)\\s*[,}]");
            int qty, loss = 0;
            if (string.IsNullOrEmpty(name)) return "account must be an account name.";
            if (!on.Success) return "on must be true or false.";
            if (ChartBridgeOrders.CopierInt(text, "qty", out qty) != 1 || qty < 1 || qty > MaxQtyPerContract) return "qty must be a whole number from 1 to 9.";
            if (size != "micro" && size != "mini") return "size must be micro or mini.";
            if (!ChartBridgeOrders.CopierNull(text, "lossLimit") && (ChartBridgeOrders.CopierInt(text, "lossLimit", out loss) != 1 || loss < 1))
                return "lossLimit must be whole dollars of 1 or more, or null for off.";
            if (loadFailed) return "copier.txt could not be read at start: the copier's settings cannot change until it can (restart ChartBridge)";
            Account a = Find(name);
            if (a == null || ChartBridgeOrders.IsNeverTradable(a.Name)) return "No account " + name + ".";
            if (!IsSim(a))   // S1: refused here, and again before every order
            {
                Decision(a.Name, "refused", null, a.Name + " is not a Sim account (NinjaTrader reports " + (ProviderOf(a) ?? "no provider") + "); nothing copied to it");
                return a.Name + " is not a Sim account: the copier copies to Sim accounts only.";
            }
            lock (Lk)
            {
                if (IsLeader(a.Name)) return a.Name + " is the leader; it cannot be a follower.";
                Follower f = FollowerNamed(a.Name);
                if (f == null) { f = new Follower { Name = a.Name }; Followers.Add(f); }
                f.On = on.Groups[1].Value == "true"; f.Qty = qty; f.Size = size; f.LossLimit = loss;
                if (!f.On) f.Skipped = null;
            }
            Decision(a.Name, "set", null, (on.Groups[1].Value == "true" ? "on" : "off") + ", " + qty + " " + size + " per leader contract, loss limit " + (loss > 0 ? loss.ToString(CultureInfo.InvariantCulture) : "off") + " (set by the page)");
            Save();
            BroadcastState(true);
            return null;
        }

        // Re-arm: refused while the leader is not Connected or 3 or more followers are not.
        private static string Rearm()
        {
            string l;
            List<string> names;
            lock (Lk) { l = leader; names = Followers.Select(f => f.Name).ToList(); }
            if (loadFailed) return "copier.txt could not be read at start: the copier stays stood down (restart ChartBridge)";
            if (l == null) return "No leader is set.";
            if (!Up(Find(l))) return "The leader " + l + " is not connected.";
            int down = names.Count(n => !Up(Find(n)));
            if (down >= MassFollowers) return down + " followers are not connected.";
            lock (Lk) { armed = true; standDownWhy = null; Drops.Clear(); }
            Event(null, "rearm", null, 0, double.NaN, null, null, null, "Re-armed by the page");
            BroadcastState(true);
            return null;
        }

        // ---------------------------------------------------------- the leader's entries (hooks in PlaceOrderLocked)
        // S2 (lead's default): while armed with a follower on, every leader entry from the page needs a stop.
        public static string LeaderEntryCheck(Account account, bool hasStop)
        {
            if (!Enabled || account == null) return null;
            lock (Lk) { if (!IsLeader(account.Name) || !armed || !Followers.Any(f => f.On)) return null; }
            return hasStop ? null : "The copier needs a stop on every leader entry.";
        }

        // S2: an entry the page just sent on the leader. Copied only if the copier is armed with a follower on now (and,
        // in executions mode, again when it fills). Orders mode: each follower gets its own real order at once.
        public static void LeaderEntrySent(Order entry, string kind, double price)
        {
            if (!Enabled || entry == null || entry.Account == null) return;
            try
            {
                string tag = TagOf(entry.Name), root = ChartBridgeServer.RootFor(entry.Instrument), m;
                if (tag == null || root == null) return;
                LeaderEntry le;
                lock (Lk)
                {
                    if (!IsLeader(entry.Account.Name)) return;
                    le = new LeaderEntry { Entry = entry, Tag = tag, Kind = kind, Price = price, Inst = entry.Instrument, Root = root, Buy = ChartBridgeOrders.CopierIsBuy(entry), Copy = armed && Followers.Any(f => f.On) };
                    LeaderByTag[tag] = le; LeaderByOrder[entry] = le;
                    lastLeaderRoot = root;
                    m = mode;
                }
                if (m != "orders") return;
                if (le.Copy) Work(() => PlaceOrdersCopies(le, Stopwatch.GetTimestamp()));
                else Event(null, "skip", root, 0, double.NaN, null, null, null, "the copier is stood down (or no follower is on): the leader's entry is not copied");
            }
            catch (Exception ex) { ChartBridgeServer.Log("copier error: " + ex.Message); }
        }

        // ---------------------------------------------------------- the leader's fills (hook in PlaceLegs)
        // One fill increment of a ChartBridge entry with its legs placed. stop: the leader's stop for it (null: none, or the
        // increment exited at once because its stop level had traded).
        public static void LeaderFilled(Account account, Instrument inst, string tag, bool buy, int filled, int qty, double incPrice, Order stop, double stopPrice)
        {
            if (!Enabled || account == null) return;
            long ts = Stopwatch.GetTimestamp();
            LeaderEntry le;
            bool live, ordersMode;
            lock (Lk)
            {
                if (!IsLeader(account.Name) || !LeaderByTag.TryGetValue(tag ?? "", out le)) return;   // not from the page (S2)
                live = armed && le.Copy;
                ordersMode = mode == "orders";
                if (stop != null) { le.LastStop = stop; le.LastStopPrice = stopPrice; }
            }
            if (ordersMode) { if (stop != null) Work(() => LeaderStopKnown(le, stop, stopPrice)); return; }
            if (!live) { Event(null, "skip", le.Root, qty, incPrice, null, null, null, "the copier is stood down (or was when the entry was placed): the leader's fill is not copied"); return; }
            if (stop == null) { Event(null, "skip", le.Root, qty, incPrice, null, null, null, "the leader's fill has no stop at the broker (or exited at once): nothing copied"); return; }
            Work(() => CopyIncrement(le, qty, incPrice, stop, stopPrice, ts));
        }

        // Executions mode: every follower that is on gets a market order for qty per leader contract filled (S5 checks first).
        private static void CopyIncrement(LeaderEntry le, int inc, double leaderPrice, Order leaderStop, double stopPrice, long ts)
        {
            lock (ChartBridgeOrders.CopierPlaceLock)
            {
                foreach (Follower f in OnFollowers())
                {
                    string fRoot = FollowerRoot(le.Root, f.Size), label, why;
                    int fq = f.Qty * inc;
                    Instrument fInst;
                    Account a = Eligible(f, fRoot, le, fq, out fInst, out label, out why);
                    if (a == null) { Skip(f, label, why, fRoot, fq); continue; }
                    string tag = NewTag();
                    Order o = a.CreateOrder(fInst, le.Buy ? OrderAction.Buy : OrderAction.Sell, OrderType.Market, OrderEntry.Manual, TimeInForce.Day, fq, 0, 0, "",
                        "CB#" + tag + " copy " + le.Tag, NinjaTrader.Core.Globals.MaxDate, null);
                    FEntry fe = new FEntry { Order = o, F = f, A = a, Inst = fInst, LInst = le.Inst, Root = fRoot, Tag = tag, Buy = le.Buy, L = le, LeaderStop = leaderStop, LeaderStopPrice = stopPrice, LeaderFill = leaderPrice, LeaderTs = ts };
                    Send(fe, o, "sent " + (le.Buy ? "buy " : "sell ") + fq + " " + fRoot + " at market on the leader's fill of " + inc + " at " + P(leaderPrice));
                }
            }
        }

        // Orders mode: the leader's entry, placed for each follower as a real order (same kind and price, its own quantity).
        private static void PlaceOrdersCopies(LeaderEntry le, long ts)
        {
            lock (ChartBridgeOrders.CopierPlaceLock)
            {
                foreach (Follower f in OnFollowers())
                {
                    string fRoot = FollowerRoot(le.Root, f.Size), label, why;
                    int fq = f.Qty * le.Entry.Quantity;
                    Instrument fInst;
                    Account a = Eligible(f, fRoot, le, fq, out fInst, out label, out why);
                    if (a == null) { Skip(f, label, why, fRoot, fq); continue; }
                    if (le.Kind != "market" && le.Kind != "limit" && le.Kind != "stop") { Skip(f, "kind", "a " + le.Kind + " entry is not copied in orders mode", fRoot, fq); continue; }
                    if (le.Kind != "market")
                    {
                        string bad = ChartBridgeOrders.CopierPriceProblem(fRoot, fInst.MasterInstrument.TickSize, le.Kind, le.Buy, le.Price);
                        if (bad != null) { Skip(f, "price", bad, fRoot, fq); continue; }
                    }
                    OrderType type = le.Kind == "market" ? OrderType.Market : le.Kind == "limit" ? OrderType.Limit : OrderType.StopMarket;
                    string tag = NewTag();
                    Order o = a.CreateOrder(fInst, le.Buy ? OrderAction.Buy : OrderAction.Sell, type, OrderEntry.Manual, TimeInForce.Day, fq,
                        le.Kind == "limit" ? le.Price : 0, le.Kind == "stop" ? le.Price : 0, "", "CB#" + tag + " copy " + le.Tag, NinjaTrader.Core.Globals.MaxDate, null);
                    FEntry fe = new FEntry { Order = o, F = f, A = a, Inst = fInst, LInst = le.Inst, Root = fRoot, Tag = tag, Buy = le.Buy, L = le, OrdersMode = true, LeaderTs = ts };
                    lock (Lk) le.Copies.Add(fe);
                    Send(fe, o, "placed " + (le.Buy ? "buy " : "sell ") + fq + " " + fRoot + " " + le.Kind + (le.Kind == "market" ? "" : " @ " + P(le.Price)) + " for the leader's entry");
                }
            }
        }

        // Called under PlaceLock: S1 once more, then the entry is sent and logged.
        private static void Send(FEntry fe, Order o, string text)
        {
            if (!IsSim(fe.A)) { Skip(fe.F, "not a Sim account", fe.A.Name + " is not a Sim account; nothing copied to it", fe.Root, o.Quantity); return; }
            lock (Lk) { FEntries[o] = fe; Placed[o] = ChartBridgeTime.NowUtcMs(); fe.F.Skipped = null; fe.F.LastAction = "enter"; fe.F.LastAt = ChartBridgeTime.NowUtcMs(); }
            ChartBridgeOrders.CopierSent(o, false);
            fe.SentTs = Stopwatch.GetTimestamp();
            fe.A.Submit(new[] { o });
            Event(fe.A.Name, "enter", fe.Root, o.Quantity, double.NaN, null, Ms(fe.LeaderTs, fe.SentTs), null, text);
        }

        private static List<Follower> OnFollowers() { lock (Lk) return Followers.Where(f => f.On).ToList(); }

        // S1 and S5: the follower may take this entry, or null with a short label (shown on the page) and the reason.
        private static Account Eligible(Follower f, string fRoot, LeaderEntry le, int fq, out Instrument inst, out string label, out string why)
        {
            inst = null; label = null; why = null;
            Account a = Find(f.Name);
            if (a == null) { label = "not connected"; why = f.Name + " is not in NinjaTrader"; return null; }
            if (!IsSim(a)) { label = "not a Sim account"; why = a.Name + " is not a Sim account; nothing copied to it"; return null; }
            if (!Up(a)) { label = "not connected"; why = a.Name + " is not connected (" + ChartBridgeOrders.CopierStatus(a) + ")"; return null; }
            if (IsGone(a)) { label = "gone"; why = a.Name + " is gone"; return null; }
            if (!ChartBridgeOrders.AccountTradable(a.Name)) { label = "not checked for trading"; why = a.Name + " may not trade (tradeAccounts in config.txt, or its checkmark)"; return null; }
            string w;
            if (ChartBridgeOrders.CopierFindAccount(a.Name, out w) == null) { label = "not connected"; why = w; return null; }
            if (f.LossLimit > 0)
            {
                string session = SessionKey(ChartBridgeTime.NowUtcMs());
                double? pnl = PnlToday(a);
                lock (Lk) if (pnl.HasValue && pnl.Value <= -f.LossLimit) f.LossHitSession = session;
                bool hit;
                lock (Lk) hit = f.LossHitSession == session;
                if (hit) { label = "loss limit"; why = a.Name + " is at or past its daily loss limit of " + f.LossLimit + " (P&L today " + (pnl.HasValue ? P(pnl.Value) : "not known") + "); skipped until 18:00 ET"; return null; }
                if (!pnl.HasValue) { label = "loss limit"; why = a.Name + " has a loss limit and NinjaTrader does not report its P&L today; skipped"; return null; }
            }
            inst = fRoot != null ? ChartBridgeServer.InstrumentFor(fRoot) : null;
            if (inst == null) { label = "no contract"; why = (fRoot ?? le.Root + "'s micro or mini") + " is not served by ChartBridge"; return null; }
            int dir = le.Buy ? 1 : -1;
            if (ChartBridgeOrders.CopierListed(a, inst) * dir < 0 || ChartBridgeOrders.CopierEffective(a, inst) * dir < 0) { label = "opposite position"; why = a.Name + " holds the opposite side on " + fRoot; return null; }
            Copy c;
            lock (Lk) Copies.TryGetValue(a.Name + "|" + inst.FullName, out c);
            if (c != null && c.LInst != null && c.LInst.FullName != le.Inst.FullName && Held(a, inst, c.Dir) > 0)
            { label = "busy"; why = a.Name + " already holds a copy of the leader's " + (ChartBridgeServer.RootFor(c.LInst) ?? "other contract") + " on " + fRoot; return null; }
            string cap = ChartBridgeOrders.CopierCapProblem(a, inst, fRoot, le.Buy, fq);
            if (cap != null) { label = "position limit"; why = a.Name + ": " + cap; return null; }
            return a;
        }

        private static void Skip(Follower f, string label, string why, string root, int qty)
        {
            lock (Lk) { f.Skipped = label; f.LastAction = "skip"; f.LastAt = ChartBridgeTime.NowUtcMs(); skippedCount++; }
            Event(f.Name, label == "not a Sim account" ? "refused" : "skip", root, qty, double.NaN, null, null, null, "skipped: " + why);
        }

        // The trading session (18:00 New York to 18:00) a time belongs to: the loss limit holds until the next one.
        private static string SessionKey(double utcMs)
        {
            DateTime utc = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(utcMs);
            double et;
            try { et = ChartBridgeTime.EtSeconds(utc); }
            catch (Exception) { et = (utc - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds - 4 * 3600; }   // no zone data: New York daylight time
            return new DateTime(1970, 1, 1).AddSeconds(et + 6 * 3600).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);   // 18:00 starts the next day's session
        }

        // ---------------------------------------------------------- order events (hook at the end of OnOrderUpdate)
        public static void OnOrderUpdate(Account account, Order o)
        {
            if (!Enabled || account == null || o == null) return;
            try
            {
                FEntry fe;
                LeaderEntry le;
                bool leaderStop, watched;
                lock (Lk)
                {
                    FEntries.TryGetValue(o, out fe);
                    LeaderByOrder.TryGetValue(o, out le);
                    leaderStop = LeaderStopPrice.ContainsKey(o);
                    watched = Reduces.Any(r => r.Watch.ContainsKey(o));
                }
                if (fe != null) FollowerEntryUpdate(fe, o);
                if (le != null) LeaderEntryUpdate(le, o);
                if (leaderStop) LeaderStopUpdate(o);
                if (watched) Work(() => CheckReduces(ChartBridgeTime.NowUtcMs()));
            }
            catch (Exception ex) { ChartBridgeServer.Log("copier order event error: " + ex.Message); }
        }

        // A follower entry filled (all or part): the new contracts get their stop (S3), on the copier thread.
        private static void FollowerEntryUpdate(FEntry fe, Order o)
        {
            int inc = 0;
            double price = 0;
            long fillTs = Stopwatch.GetTimestamp();
            lock (Lk)
            {
                int filled = o.Filled;
                if (filled > fe.Covered)
                {
                    inc = filled - fe.Covered;
                    double value = o.AverageFillPrice * filled;
                    price = (value - fe.CoveredValue) / inc;
                    fe.Covered = filled; fe.CoveredValue = value;
                }
            }
            if (inc > 0) { int q = inc, mark = fe.Covered; double p = price; Work(() => ProtectFill(fe, mark, q, p, fillTs)); }
            if (o.OrderState == OrderState.Rejected) Event(fe.A.Name, "refused", fe.Root, o.Quantity, double.NaN, null, null, null, "NinjaTrader rejected the follower's entry");
        }

        // S3: the follower's stop at the leader's stop price, at once; a level already traded is a market exit; no price
        // known (orders mode, the leader not filled yet) waits for the leader's stop; no stop possible: flatten.
        private static void ProtectFill(FEntry fe, int mark, int qty, double price, long fillTs)
        {
            Copy c = CopyFor(fe.A, fe.F, fe.Inst, fe.Root, fe.LInst, fe.Buy ? 1 : -1);
            double? slip = null;
            if (!double.IsNaN(fe.LeaderFill))
            {
                double tick = fe.Inst.MasterInstrument.TickSize;
                slip = Math.Round((price - fe.LeaderFill) / tick * (fe.Buy ? 1 : -1), 2);
            }
            lock (Lk) { c.Intended += qty; fe.F.Slippage = slip ?? fe.F.Slippage; fe.F.LastAt = ChartBridgeTime.NowUtcMs(); }
            double sp = StopPriceFor(fe);
            if (double.IsNaN(sp) && fe.OrdersMode && fe.L != null && Working(fe.L.Entry))
            {
                lock (Lk) Waits.Add(new Waiting { Fe = fe, Mark = mark, Qty = qty, Price = price, Since = ChartBridgeTime.NowUtcMs(), FillTs = fillTs });
                Decision(fe.A.Name, "wait", fe.Root, "filled " + qty + " at " + P(price) + " before the leader; its stop waits for the leader's (at most " + (LeaderStopWaitMs / 1000) + " s)");
                return;
            }
            PlaceStop(fe, c, mark, qty, price, sp, slip, fillTs);
        }

        private static void PlaceStop(FEntry fe, Copy c, int filledMark, int qty, double price, double sp, double? slip, long fillTs)
        {
            string where = fe.Root + " " + fe.A.Name;
            if (!IsSim(fe.A))
            {
                ChartBridgeOrders.CopierAlarm(where + ": the copier refuses every order on an account that is not Sim, so this follower's fill of " + qty + " has NO STOP from the copier; set the stop in NinjaTrader now");
                Event(fe.A.Name, "refused", fe.Root, qty, double.NaN, slip, null, null, fe.A.Name + " is not a Sim account; nothing copied to it");
                return;
            }
            if (double.IsNaN(sp) || !(sp > 0))
            {
                ChartBridgeOrders.CopierAlarm(where + ": the leader's stop price for this copy is not known, so the follower is flattened (never left without a stop)");
                Flatten(c, "no stop price known for its fill", fillTs);
                return;
            }
            double last;
            int dir = fe.Buy ? 1 : -1;
            OrderAction exit = fe.Buy ? OrderAction.Sell : OrderAction.Buy;
            string mark = " f" + filledMark.ToString(CultureInfo.InvariantCulture) + " q" + qty.ToString(CultureInfo.InvariantCulture) + " p" + P(price);
            long sent = Stopwatch.GetTimestamp();
            if (ChartBridgeOrders.CopierFreshLast(fe.Root, out last) && (fe.Buy ? sp >= last : sp <= last))
            {
                // The stop level has already traded on the follower's contract: exit as the stop would have.
                Order x = fe.A.CreateOrder(fe.Inst, exit, OrderType.Market, OrderEntry.Manual, TimeInForce.Day, qty, 0, 0, "", "CB#" + fe.Tag + " exit" + mark, NinjaTrader.Core.Globals.MaxDate, null);
                lock (Lk) { Placed[x] = ChartBridgeTime.NowUtcMs(); c.Intended = Math.Max(0, c.Intended - qty); }
                ChartBridgeOrders.CopierSent(x, false);
                fe.A.Submit(new[] { x });
                ChartBridgeOrders.CopierAlarm(where + ": price had already passed the leader's stop level " + P(sp) + " (last " + P(last) + "); the follower exited " + qty + " at market");
                Event(fe.A.Name, "stop", fe.Root, qty, sp, slip, Ms(fe.LeaderTs, sent), Ms(fe.LeaderTs, fillTs), "filled " + qty + " at " + P(price) + "; the stop level " + P(sp) + " had already traded: exited at market");
                return;
            }
            Order s = fe.A.CreateOrder(fe.Inst, exit, OrderType.StopMarket, OrderEntry.Manual, TimeInForce.Gtc, qty, 0, sp, "", "CB#" + fe.Tag + " stop" + mark, NinjaTrader.Core.Globals.MaxDate, null);
            Order ls = fe.LeaderStop ?? (fe.L != null ? fe.L.LastStop : null);
            lock (Lk)
            {
                FStop fs = new FStop { Stop = s, LeaderStop = ls, C = c, Born = ChartBridgeTime.NowUtcMs() };
                FStops[s] = fs; c.Stops.Add(fs); Placed[s] = fs.Born;
                if (ls != null && !LeaderStopPrice.ContainsKey(ls)) LeaderStopPrice[ls] = ls.StopPrice > 0 ? ls.StopPrice : sp;
                fe.F.LastAction = "stop";
            }
            ChartBridgeOrders.CopierSent(s, true);
            fe.A.Submit(new[] { s });
            Event(fe.A.Name, "stop", fe.Root, qty, sp, slip, Ms(fe.LeaderTs, sent), Ms(fe.LeaderTs, fillTs),
                  "filled " + qty + " at " + P(price) + (slip.HasValue ? " (slippage " + P(slip.Value) + " ticks)" : "") + "; stop at " + P(sp) + ", the leader's stop price");
        }

        // The leader's stop price for this copy: its stop now (it may have moved), else the last price seen, else (orders mode,
        // the leader not filled yet, a resting entry) where the leader's planned stop goes if it fills at its price. NaN: none.
        private static double StopPriceFor(FEntry fe)
        {
            Order ls = fe.LeaderStop ?? (fe.L != null ? fe.L.LastStop : null);
            if (ls != null && Working(ls) && ls.StopPrice > 0) return ls.StopPrice;
            double known;
            if (ls != null) { lock (Lk) if (LeaderStopPrice.TryGetValue(ls, out known) && known > 0) return known; }
            if (fe.LeaderStopPrice > 0) return fe.LeaderStopPrice;
            if (fe.L != null && fe.L.LastStopPrice > 0) return fe.L.LastStopPrice;
            if (fe.OrdersMode && fe.L != null && fe.L.Price > 0)
            {
                int ticks = ChartBridgeOrders.CopierPlannedStopTicks(fe.L.Entry);
                double tick = fe.L.Inst.MasterInstrument.TickSize;
                if (ticks > 0) return ChartBridgeOrders.CopierRound(fe.L.Buy ? fe.L.Price - ticks * tick : fe.L.Price + ticks * tick, tick);
            }
            return double.NaN;
        }

        // Orders mode: the leader's stop is placed. Follower stops of this entry with no leader stop yet follow it from now on,
        // and fills waiting for it get their stop.
        private static void LeaderStopKnown(LeaderEntry le, Order stop, double price)
        {
            List<FStop> unmapped;
            List<Waiting> ready;
            lock (Lk)
            {
                unmapped = FStops.Values.Where(s => s.LeaderStop == null && le.Copies.Any(fe => fe.Tag == TagOf(s.Stop.Name))).ToList();
                foreach (FStop s in unmapped) s.LeaderStop = stop;
                if (!LeaderStopPrice.ContainsKey(stop)) LeaderStopPrice[stop] = price;
                ready = Waits.Where(w => w.Fe.L == le).ToList();
                Waits.RemoveAll(w => w.Fe.L == le);
            }
            foreach (Waiting w in ready) PlaceStop(w.Fe, CopyFor(w.Fe.A, w.Fe.F, w.Fe.Inst, w.Fe.Root, w.Fe.LInst, w.Fe.Buy ? 1 : -1), w.Mark, w.Qty, w.Price, price, null, w.FillTs);
            MoveStops(unmapped.Where(s => Math.Abs(s.Stop.StopPrice - price) > 1e-9).ToList(), price, "stop moved to the leader's stop now that the leader filled");
        }

        // Fills that waited for the leader's stop longer than LeaderStopWaitMs: stop at the leader's planned distance from the
        // follower's own fill (lead's default), or flattened when the leader has no planned stop.
        private static void CheckWaits(double now)
        {
            List<Waiting> late;
            lock (Lk) { late = Waits.Where(w => now - w.Since >= LeaderStopWaitMs).ToList(); Waits.RemoveAll(w => late.Contains(w)); }
            foreach (Waiting w in late)
            {
                FEntry fe = w.Fe;
                Copy c = CopyFor(fe.A, fe.F, fe.Inst, fe.Root, fe.LInst, fe.Buy ? 1 : -1);
                double sp = StopPriceFor(fe);
                if (double.IsNaN(sp))
                {
                    int ticks = fe.L != null ? ChartBridgeOrders.CopierPlannedStopTicks(fe.L.Entry) : 0;
                    double tick = fe.Inst.MasterInstrument.TickSize;
                    if (ticks > 0) sp = ChartBridgeOrders.CopierRound(fe.Buy ? w.Price - ticks * tick : w.Price + ticks * tick, tick);
                }
                PlaceStop(fe, c, w.Mark, w.Qty, w.Price, sp, null, w.FillTs);
            }
        }

        private static Copy CopyFor(Account a, Follower f, Instrument inst, string root, Instrument linst, int dir)
        {
            lock (Lk)
            {
                Copy c;
                string key = a.Name + "|" + inst.FullName;
                if (!Copies.TryGetValue(key, out c) || (c.Intended <= 0 && c.Stops.All(s => !Working(s.Stop)) && c.Dir != dir))
                {
                    c = new Copy { A = a, F = f, Inst = inst, Root = root, LInst = linst, Dir = dir, Tag = NewTag() };
                    Copies[key] = c;
                }
                if (c.LInst == null) c.LInst = linst;
                return c;
            }
        }

        // Orders mode: the leader's entry moved or cancelled: the followers' orders follow.
        private static void LeaderEntryUpdate(LeaderEntry le, Order o)
        {
            bool ordersMode;
            lock (Lk) ordersMode = le.Copies.Count > 0;
            if (!ordersMode) return;
            if (o.OrderState == OrderState.Cancelled || o.OrderState == OrderState.Rejected) { Work(() => CancelFollowerEntries(le)); return; }
            if (!Working(o)) return;
            double px = o.OrderType == OrderType.Limit ? o.LimitPrice : o.StopPrice;
            bool moved;
            lock (Lk) { moved = px > 0 && Math.Abs(px - le.Price) > 1e-9; if (moved) le.Price = px; }
            if (moved) Work(() => MoveFollowerEntries(le, px));
        }

        private static void MoveFollowerEntries(LeaderEntry le, double price)
        {
            List<FEntry> list;
            lock (Lk) list = le.Copies.ToList();
            foreach (FEntry fe in list)
            {
                Order o = fe.Order;
                if (!Working(o) || o.OrderType == OrderType.Market) continue;
                if (!IsSim(fe.A)) { Event(fe.A.Name, "refused", fe.Root, o.Quantity, price, null, null, null, fe.A.Name + " is not a Sim account; nothing copied to it"); continue; }
                string kind = o.OrderType == OrderType.Limit ? "limit" : "stop";
                string bad = ChartBridgeOrders.CopierPriceProblem(fe.Root, fe.Inst.MasterInstrument.TickSize, kind, fe.Buy, price);
                if (bad != null)
                {
                    fe.A.Cancel(new[] { o });
                    Event(fe.A.Name, "move", fe.Root, o.Quantity, price, null, null, null, "could not move with the leader's entry (" + bad + "); the follower's order is cancelled");
                    continue;
                }
                if (kind == "limit") o.LimitPriceChanged = price; else o.StopPriceChanged = price;
                fe.A.Change(new[] { o });
                Event(fe.A.Name, "move", fe.Root, o.Quantity, price, null, null, null, "entry moved with the leader's to " + P(price));
            }
        }

        private static void CancelFollowerEntries(LeaderEntry le)
        {
            List<FEntry> list;
            lock (Lk) list = le.Copies.ToList();
            foreach (FEntry fe in list)
            {
                if (!Working(fe.Order) || !IsSim(fe.A)) continue;   // S1: no order action on an account that is not Sim
                fe.A.Cancel(new[] { fe.Order });
                Event(fe.A.Name, "sweep", fe.Root, fe.Order.Quantity - fe.Order.Filled, double.NaN, null, null, null, "cancelled with the leader's entry");
            }
        }

        // The leader's stop moved (a drag, breakeven, trailing, a merge): each follower stop mapped to it moves to the same price.
        private static void LeaderStopUpdate(Order ls)
        {
            if (!Working(ls) || !(ls.StopPrice > 0)) return;
            double price = ls.StopPrice, was;
            List<FStop> mapped;
            lock (Lk)
            {
                if (LeaderStopPrice.TryGetValue(ls, out was) && Math.Abs(was - price) < 1e-9) return;
                LeaderStopPrice[ls] = price;
                mapped = FStops.Values.Where(s => s.LeaderStop == ls).ToList();
            }
            Work(() => MoveStops(mapped, price, "stop moved with the leader's to " + P(price)));
        }

        private static void MoveStops(List<FStop> stops, double price, string text)
        {
            foreach (FStop s in stops)
            {
                Order o = s.Stop;
                if (!Working(o) || Math.Abs(o.StopPrice - price) < 1e-9) continue;
                Account a = o.Account;
                if (!IsSim(a)) { Event(a.Name, "refused", s.C.Root, o.Quantity, price, null, null, null, a.Name + " is not a Sim account; nothing copied to it"); continue; }
                if (!Up(a)) { Event(a.Name, "skip", s.C.Root, o.Quantity, price, null, null, null, "skipped: " + a.Name + " is not connected; its stop stays at " + P(o.StopPrice)); continue; }
                o.StopPriceChanged = price;
                a.Change(new[] { o });
                lock (Lk) s.C.F.LastAction = "move";
                Event(a.Name, "move", s.C.Root, o.Quantity - o.Filled, price, null, null, null, text);
            }
        }

        // ---------------------------------------------------------- the leader's exits (hook at the end of OnPositionUpdate)
        // S2 and S4: a leader position that shrinks is a scale-out; flat (or turned to the other side) is every follower flat.
        public static void OnPositionUpdate(Account account, Instrument inst, int signed)
        {
            if (!Enabled || account == null || inst == null) return;
            try
            {
                int prev;
                bool known;
                lock (Lk)
                {
                    if (!IsLeader(account.Name)) return;
                    known = LeaderPos.TryGetValue(inst.FullName, out prev);
                    LeaderPos[inst.FullName] = signed;
                }
                if (known && prev == signed) return;
                long ts = Stopwatch.GetTimestamp();
                if (signed == 0 || (known && prev != 0 && Math.Sign(prev) != Math.Sign(signed)))
                    Work(() => LeaderExit(account, inst, known ? Math.Abs(prev) : 0, 0, Math.Sign(signed), ts));
                else if (known && Math.Sign(prev) == Math.Sign(signed) && Math.Abs(signed) < Math.Abs(prev))
                    Work(() => LeaderExit(account, inst, Math.Abs(prev), Math.Abs(signed), Math.Sign(signed), ts));
            }
            catch (Exception ex) { ChartBridgeServer.Log("copier position event error: " + ex.Message); }
        }

        // Acts only on a leader connection that has been steady (a reconnect can show positions late); otherwise the
        // reconcile step below catches a flat leader once it is steady. The position update itself is the reading: NinjaTrader
        // may report it before the fill's order update (event order differs between connections), so the exit is not held
        // back for the fill readings to agree.
        private static void LeaderExit(Account la, Instrument inst, int prevAbs, int nowAbs, int newSign, long ts)
        {
            if (!ChartBridgeOrders.CopierSteady(la)) { Decision(null, "wait", ChartBridgeServer.RootFor(inst), "the leader's position changed on a connection that is not steady yet; checked again every second"); return; }
            List<Copy> copies;
            lock (Lk) copies = Copies.Values.Where(c => c.LInst != null && c.LInst.FullName == inst.FullName).ToList();
            foreach (Copy c in copies)
            {
                if (nowAbs == 0) { if (c.Dir != newSign) Flatten(c, newSign == 0 ? "the leader is flat" : "the leader turned to the other side", ts); }   // flat, or turned: every copy on the old side closes
                else if (c.Dir == newSign) ScaleOut(c, prevAbs, nowAbs, ts);
            }
        }

        // A leader scale-out: the follower is reduced by the same share, rounded to the nearest contract, at least 1, capped at
        // what it holds. The share is taken of the contracts the copier gave it (Intended), so a follower whose own stop already
        // took some is not reduced twice.
        private static void ScaleOut(Copy c, int prevAbs, int nowAbs, long ts)
        {
            int target, held = Held(c.A, c.Inst, c.Dir);
            lock (Lk)
            {
                int basis = c.Intended > 0 ? c.Intended : held;
                if (basis <= 0) return;
                double share = (prevAbs - nowAbs) / (double)prevAbs;
                int cut = Math.Max(1, (int)Math.Round(basis * share, MidpointRounding.AwayFromZero));
                target = Math.Max(0, basis - cut);
                c.Intended = target;
            }
            if (held <= 0) return;   // a flat follower gets nothing
            if (target <= 0) { Flatten(c, "the leader scaled out (its share closes the follower)", ts); return; }
            if (held <= target) { Decision(c.A.Name, "reduce", c.Root, "already at " + held + " (its own stop took the rest); nothing sent"); return; }
            StartReduce(c, target, ts, "the leader scaled out from " + prevAbs + " to " + nowAbs);
        }

        // S4: shrink the follower's stops to the target first (stops whose leader stop is gone first, then the newest), and
        // send the reduce only once NinjaTrader shows them shrunk or cancelled (CheckReduces), never before.
        private static void StartReduce(Copy c, int target, long ts, string why)
        {
            if (!ExitAllowed(c, "reduce")) return;
            List<FStop> stops;
            lock (Lk) stops = c.Stops.Where(s => Working(s.Stop)).OrderBy(s => Working(s.LeaderStop) ? 1 : 0).ThenByDescending(s => s.Born).ToList();
            int cover = stops.Sum(s => s.Stop.Quantity - s.Stop.Filled), excess = cover - target;
            Reduce r = new Reduce { C = c, Target = target, Ts = ts, Since = ChartBridgeTime.NowUtcMs(), Why = why };
            List<Order> cancel = new List<Order>(), change = new List<Order>();
            foreach (FStop s in stops)
            {
                if (excess <= 0) break;
                int left = s.Stop.Quantity - s.Stop.Filled;
                if (left <= excess) { cancel.Add(s.Stop); r.Watch[s.Stop] = 0; excess -= left; }
                else { s.Stop.QuantityChanged = s.Stop.Filled + left - excess; change.Add(s.Stop); r.Watch[s.Stop] = left - excess; excess = 0; }
            }
            lock (Lk) { Reduces.RemoveAll(x => x.C == c); Reduces.Add(r); }
            if (cancel.Count > 0) c.A.Cancel(cancel.ToArray());
            if (change.Count > 0) c.A.Change(change.ToArray());
            if (cancel.Count + change.Count > 0) Decision(c.A.Name, "reduce", c.Root, "stops shrunk to " + target + " first (" + cancel.Count + " cancelled, " + change.Count + " changed); the reduce waits for NinjaTrader to confirm");
            CheckReduces(ChartBridgeTime.NowUtcMs());
        }

        private static void CheckReduces(double now)
        {
            List<Reduce> list;
            lock (Lk) list = Reduces.ToList();
            foreach (Reduce r in list)
            {
                bool done = r.Watch.All(kv => ChartBridgeOrders.CopierDone(kv.Key) || kv.Key.Quantity - kv.Key.Filled <= kv.Value);
                if (!done && now - r.Since < ReduceConfirmMs) continue;
                lock (Lk) Reduces.Remove(r);
                if (!done)
                {
                    ChartBridgeOrders.CopierAlarm(r.C.Root + " " + r.C.A.Name + ": the copier could not reduce this follower: NinjaTrader did not confirm its stop change within " + (ReduceConfirmMs / 1000) + " s, so no reduce was sent (it would have crossed zero if the old stop filled); check NinjaTrader");
                    Event(r.C.A.Name, "reduce", r.C.Root, 0, double.NaN, null, null, null, "not reduced: its stop change was not confirmed");
                    continue;
                }
                SendReduce(r);
            }
        }

        private static void SendReduce(Reduce r)
        {
            Copy c = r.C;
            if (!ExitAllowed(c, "reduce")) return;
            int held = Held(c.A, c.Inst, c.Dir), k = held - r.Target;   // read again now: never more than it holds above the target
            if (k <= 0) { Decision(c.A.Name, "reduce", c.Root, "holds " + held + ", at or under the target " + r.Target + ": nothing sent"); return; }
            Order x = c.A.CreateOrder(c.Inst, c.Dir > 0 ? OrderAction.Sell : OrderAction.Buy, OrderType.Market, OrderEntry.Manual, TimeInForce.Day, k, 0, 0, "",
                "CB#" + c.Tag + " copy out", NinjaTrader.Core.Globals.MaxDate, null);
            lock (Lk) { Placed[x] = ChartBridgeTime.NowUtcMs(); c.F.LastAction = "reduce"; c.F.LastAt = ChartBridgeTime.NowUtcMs(); }
            ChartBridgeOrders.CopierSent(x, false);
            long sent = Stopwatch.GetTimestamp();
            c.A.Submit(new[] { x });
            Event(c.A.Name, "reduce", c.Root, k, double.NaN, null, Ms(r.Ts, sent), null, "reduced by " + k + " to " + r.Target + " (" + r.Why + ")");
        }

        // S4: "flatten this follower": NinjaTrader's Flatten on that contract (working orders cancelled first, then the rest
        // closed at market). A flat follower gets nothing.
        private static void Flatten(Copy c, string why, long ts)
        {
            lock (Lk) { c.Intended = 0; Reduces.RemoveAll(x => x.C == c); }
            if (Flat(c.A, c.Inst)) return;
            if (!ExitAllowed(c, "flatten")) return;
            ChartBridgeOrders.CopierNoteFlatten(c.A, c.Inst);
            long sent = Stopwatch.GetTimestamp();
            c.A.Flatten(new[] { c.Inst });
            lock (Lk) { c.F.LastAction = "flatten"; c.F.LastAt = ChartBridgeTime.NowUtcMs(); c.FlatSince = 0; }
            Event(c.A.Name, "flatten", c.Root, Math.Abs(ChartBridgeOrders.CopierListed(c.A, c.Inst)), double.NaN, null, Ms(ts, sent), null, "flattened: " + why);
        }

        // Exits need a Sim account (S1) that is Connected and watched; closing never needs the checkmark or the armed copier.
        private static bool ExitAllowed(Copy c, string what)
        {
            if (!IsSim(c.A))
            {
                ChartBridgeOrders.CopierAlarm(c.Root + " " + c.A.Name + ": not a Sim account, so the copier sends it nothing (not even the " + what + "); close it in NinjaTrader");
                Event(c.A.Name, "refused", c.Root, 0, double.NaN, null, null, null, c.A.Name + " is not a Sim account; nothing copied to it");
                return false;
            }
            if (!Up(c.A) || !ChartBridgeServer.EnsureWatched(c.A))
            {
                Event(c.A.Name, "skip", c.Root, 0, double.NaN, null, null, null, "skipped: " + c.A.Name + " is not connected; it keeps its stop at the broker, and is flattened when it is back if the leader is still flat");
                return false;
            }
            return true;
        }

        // ---------------------------------------------------------- every second (and at once on a connection event)
        public static void ConnectionChanged() { if (Enabled) { try { SampleConnections(ChartBridgeTime.NowUtcMs()); } catch (Exception ex) { ChartBridgeServer.Log("copier connection check error: " + ex.Message); } } }

        public static void Tick() { Tick(ChartBridgeTime.NowUtcMs()); }

        public static void Tick(double now)
        {
            if (!Enabled) return;
            SampleConnections(now);
            Work(() =>
            {
                Recover(now);
                Sweep(now);
                CheckReduces(now);
                CheckWaits(now);
                Remap();
                Reconcile(now);
                Cleanup();
            });
            KeepSaved();
            FlushLog();
            BroadcastState(false);
        }

        // S6: the leader, or 3 or more followers, leaving Connected within 10 s: stand down until Re-arm.
        private static void SampleConnections(double now)
        {
            string l;
            List<string> names;
            lock (Lk) { l = leader; names = Followers.Select(f => f.Name).ToList(); }
            if (l != null) names.Insert(0, l);
            string why = null;
            foreach (string n in names)
            {
                bool up = Up(Find(n)), was, known;
                lock (Lk)
                {
                    known = WasUp.TryGetValue(n, out was);
                    WasUp[n] = up;
                    if (known && was && !up) Drops.Add(new KeyValuePair<string, double>(n, now));
                }
            }
            lock (Lk)
            {
                Drops.RemoveAll(d => now - d.Value > MassWindowMs);
                if (!armed) return;
                int followersDown = Drops.Where(d => !IsLeader(d.Key)).Select(d => d.Key.ToUpperInvariant()).Distinct().Count();
                if (l != null && Drops.Any(d => IsLeader(d.Key))) why = "the leader " + l + " left Connected";
                else if (followersDown >= MassFollowers) why = followersDown + " followers left Connected within 10 s";
                if (why == null) return;
                armed = false; standDownWhy = why; standDowns++;
            }
            ChartBridgeOrders.CopierWarn("copier: " + why + ": the copier stands down until Re-arm");
            Event(null, "standDown", null, 0, double.NaN, null, null, null, why + ": the copier stands down until Re-arm");
            BroadcastState(true);
        }

        // S7: a copier order on a follower that is flat by both readings is cancelled, unless it was sent in the last 3 s (its
        // fill or position change may still be on its way) or it is an orders-mode entry whose leader entry is still working.
        private static void Sweep(double now)
        {
            List<KeyValuePair<Order, double>> list;
            lock (Lk)
            {
                foreach (Order done in Placed.Keys.Where(o => ChartBridgeOrders.CopierDone(o)).ToList()) Placed.Remove(done);
                list = Placed.ToList();
            }
            foreach (KeyValuePair<Order, double> kv in list)
            {
                Order o = kv.Key;
                if (!Working(o) || now - kv.Value < ChartBridgeOrders.YoungMs || o.Account == null || o.Instrument == null) continue;
                if (!Flat(o.Account, o.Instrument)) continue;
                FEntry fe;
                lock (Lk) FEntries.TryGetValue(o, out fe);
                if (fe != null && fe.OrdersMode && fe.L != null && Working(fe.L.Entry)) continue;
                if (!IsSim(o.Account) || !Up(o.Account)) continue;
                o.Account.Cancel(new[] { o });
                lock (Lk) Placed.Remove(o);
                Event(o.Account.Name, "sweep", ChartBridgeServer.RootFor(o.Instrument), o.Quantity - o.Filled, double.NaN, null, null, null, "cancelled a copier order left on a flat follower");
            }
        }

        // A follower stop whose leader stop went away (a merge cancels pairs and keeps or makes one stop) while the leader still
        // holds: it follows the leader's working stop when all of them are at one price; otherwise it stays where it is.
        private static void Remap()
        {
            List<FStop> orphans;
            lock (Lk) orphans = FStops.Values.Where(s => Working(s.Stop) && s.LeaderStop != null && ChartBridgeOrders.CopierDone(s.LeaderStop) && s.LeaderStop.OrderState != OrderState.Filled).ToList();
            string l;
            lock (Lk) l = leader;
            Account la = Find(l);
            foreach (FStop s in orphans)
            {
                if (la == null || s.C.LInst == null) continue;
                int pos = ChartBridgeOrders.CopierListed(la, s.C.LInst);
                if (pos == 0) continue;
                List<Order> orders;
                lock (la.Orders) orders = la.Orders.ToList();
                List<Order> stops = orders.Where(o => Working(o) && o.Instrument != null && o.Instrument.FullName == s.C.LInst.FullName &&
                    (o.OrderType == OrderType.StopMarket || o.OrderType == OrderType.StopLimit) && ChartBridgeOrders.CopierIsBuy(o) == (pos < 0) && TagOf(o.Name) != null).ToList();
                if (stops.Count == 0 || stops.Select(o => o.StopPrice).Distinct().Count() != 1)
                {
                    if (!s.RemapSaid) { s.RemapSaid = true; Decision(s.C.A.Name, "move", s.C.Root, "the leader's stop it followed is gone and the leader's stops are not at one price; this stop stays at " + P(s.Stop.StopPrice)); }
                    continue;
                }
                Order to = stops[0];
                lock (Lk) { s.LeaderStop = to; s.RemapSaid = false; if (!LeaderStopPrice.ContainsKey(to)) LeaderStopPrice[to] = to.StopPrice; }
                MoveStops(new List<FStop> { s }, to.StopPrice, "the leader's stop it followed is gone (a merge?); it follows the leader's stop at " + P(to.StopPrice));
            }
        }

        // The exit rule for a missed exit (lead's default): a follower holding a copier position while the leader has been flat
        // on that contract for 4 s (both readings, a steady connection, no leader entry working there) is flattened. This
        // catches an exit that happened while the follower (or the leader's connection) was down.
        private static void Reconcile(double now)
        {
            string l;
            List<Copy> copies;
            List<LeaderEntry> entries;
            lock (Lk) { l = leader; copies = Copies.Values.ToList(); entries = LeaderByOrder.Values.ToList(); }
            Account la = Find(l);
            if (la == null) return;
            foreach (Copy c in copies)
            {
                bool mismatch = c.LInst != null && Held(c.A, c.Inst, c.Dir) > 0 && Up(c.A) && ChartBridgeOrders.CopierSteady(la) && Flat(la, c.LInst) &&
                                !entries.Any(e => e.Inst.FullName == c.LInst.FullName && Working(e.Entry));
                bool pending;
                lock (Lk) pending = Reduces.Any(r => r.C == c) || Waits.Any(w => w.Fe.Inst == c.Inst && w.Fe.A == c.A);
                if (!mismatch || pending) { c.FlatSince = 0; continue; }
                if (c.FlatSince == 0) { c.FlatSince = now; continue; }
                if (now - c.FlatSince < ChartBridgeOrders.SettleMs) continue;
                c.FlatSince = 0;
                Flatten(c, "the leader has been flat for " + (ChartBridgeOrders.SettleMs / 1000) + " s (its exit was not copied when it happened)", Stopwatch.GetTimestamp());
            }
        }

        // After a recompile or restart (memory is gone): a follower's working copier stop ("CB#<tag> stop ..." whose entry
        // "CB#<tag> copy <leader tag>" is on the same account) is taken back with its copy, and follows the leader's stop of
        // that leader entry at the same price, if there is one. A working copier ENTRY from before is cancelled (lead's
        // default: it can no longer be linked to the leader's, and its fill would get no stop).
        private static void Recover(double now)
        {
            List<Follower> list;
            string l;
            lock (Lk) { list = Followers.ToList(); l = leader; }
            Account la = Find(l);
            List<Order> leaderOrders = new List<Order>();
            if (la != null) lock (la.Orders) leaderOrders = la.Orders.ToList();
            foreach (Follower f in list)
            {
                Account a = Find(f.Name);
                if (!Up(a)) continue;
                List<Order> orders;
                lock (a.Orders) orders = a.Orders.ToList();
                Dictionary<string, string> entries = new Dictionary<string, string>();
                foreach (Order o in orders) { Match m = CopyEntryRx.Match(o.Name ?? ""); if (m.Success) entries[m.Groups[1].Value] = m.Groups[2].Value; }
                foreach (Order o in orders)
                {
                    bool known;
                    lock (Lk) known = Placed.ContainsKey(o) || FStops.ContainsKey(o) || FEntries.ContainsKey(o);
                    if (known || !Working(o) || o.Instrument == null) continue;
                    string tag = TagOf(o.Name), root = ChartBridgeServer.RootFor(o.Instrument), ltag;
                    if (tag == null || root == null || !entries.TryGetValue(tag, out ltag)) continue;
                    if (CopyEntryRx.IsMatch(o.Name ?? ""))
                    {
                        if (!IsSim(a)) continue;
                        a.Cancel(new[] { o });
                        Event(a.Name, "sweep", root, o.Quantity - o.Filled, double.NaN, null, null, null, "cancelled a copier entry left from before the restart (it cannot be linked to the leader's)");
                        continue;
                    }
                    if (!ChartBridgeOrders.CopierIsLeg(o, "stop")) continue;
                    Order lentry = leaderOrders.FirstOrDefault(x => TagOf(x.Name) == ltag && !ChartBridgeOrders.CopierIsLeg(x, "stop") && !ChartBridgeOrders.CopierIsLeg(x, "target"));
                    Order lstop = leaderOrders.FirstOrDefault(x => TagOf(x.Name) == ltag && ChartBridgeOrders.CopierIsLeg(x, "stop") && Working(x) && Math.Abs(x.StopPrice - o.StopPrice) < 1e-9);
                    int dir = ChartBridgeOrders.CopierIsBuy(o) ? -1 : 1;
                    Copy c = CopyFor(a, f, o.Instrument, root, lentry != null ? lentry.Instrument : (lstop != null ? lstop.Instrument : null), dir);
                    int heldNow = Held(a, o.Instrument, dir);
                    lock (Lk)
                    {
                        FStop fs = new FStop { Stop = o, LeaderStop = lstop, C = c, Born = now - ChartBridgeOrders.YoungMs };
                        FStops[o] = fs; c.Stops.Add(fs); Placed[o] = fs.Born;
                        if (lstop != null && !LeaderStopPrice.ContainsKey(lstop)) LeaderStopPrice[lstop] = lstop.StopPrice;
                        c.Intended = Math.Max(c.Intended, heldNow);
                    }
                    Decision(a.Name, "recovered", root, "a copier stop at " + P(o.StopPrice) + " taken back after a restart" + (lstop != null ? "; it follows the leader's stop" : "; no leader stop at that price, so it stays where it is") +
                             (c.LInst == null ? "; the leader's contract is not known, so the leader's exits are not copied to it" : ""));
                }
            }
        }

        // Records of copies that are flat and done are dropped.
        private static void Cleanup()
        {
            lock (Lk)
            {
                foreach (Order o in FEntries.Keys.Where(o => ChartBridgeOrders.CopierDone(o) && !Waits.Any(w => w.Fe.Order == o)).ToList()) FEntries.Remove(o);
                foreach (Order o in FStops.Keys.Where(o => ChartBridgeOrders.CopierDone(o)).ToList()) { FStop s = FStops[o]; s.C.Stops.Remove(s); FStops.Remove(o); }
                foreach (Order o in LeaderStopPrice.Keys.Where(o => ChartBridgeOrders.CopierDone(o) && !FStops.Values.Any(s => s.LeaderStop == o)).ToList()) LeaderStopPrice.Remove(o);
                foreach (KeyValuePair<Order, LeaderEntry> kv in LeaderByOrder.Where(kv => ChartBridgeOrders.CopierDone(kv.Key) && kv.Value.Copies.All(fe => !FEntries.ContainsKey(fe.Order))).ToList())
                { LeaderByOrder.Remove(kv.Key); LeaderByTag.Remove(kv.Value.Tag); }
            }
            List<Copy> copies;
            lock (Lk) copies = Copies.Values.ToList();
            foreach (Copy c in copies)
            {
                bool idle;
                lock (Lk) idle = c.Stops.Count == 0 && !Reduces.Any(r => r.C == c) && !FEntries.Values.Any(fe => fe.A == c.A && fe.Inst == c.Inst);
                if (idle && Flat(c.A, c.Inst)) lock (Lk) { Copies.Remove(c.A.Name + "|" + c.Inst.FullName); }
            }
        }

        // ---------------------------------------------------------- messages to the page, copier.log and /diag
        private static readonly List<string> LogLines = new List<string>();

        private static void Event(string account, string action, string root, int qty, double price, double? slip, double? leaderMs, double? fillMs, string text)
        {
            double at = ChartBridgeTime.NowUtcMs();
            lock (Lk)
            {
                decisions++;
                if (leaderMs.HasValue) { LeaderMs.Add(leaderMs.Value); if (LeaderMs.Count > LeaderMsKept) LeaderMs.RemoveAt(0); }
            }
            string json = "{\"type\":\"copierEvent\",\"at\":" + CbJson.Num3(Math.Round(at)) + ",\"account\":" + (account != null ? CbJson.Str(account) : "null") +
                          ",\"action\":" + CbJson.Str(action) + ",\"root\":" + (root != null ? CbJson.Str(root) : "null") + ",\"qty\":" + (qty > 0 ? qty.ToString(CultureInfo.InvariantCulture) : "null") +
                          ",\"price\":" + (double.IsNaN(price) ? "null" : CbJson.Num(price)) + ",\"slippageTicks\":" + (slip.HasValue ? CbJson.Num(slip.Value) : "null") +
                          ",\"leaderMs\":" + (leaderMs.HasValue ? CbJson.Num3(leaderMs.Value) : "null") + ",\"fillMs\":" + (fillMs.HasValue ? CbJson.Num3(fillMs.Value) : "null") +
                          ",\"text\":" + CbJson.Str(text) + "}";
            Line(account, action, root, qty, price, slip, leaderMs, fillMs, text);
            Broadcast(json);
            if (action != "set") BroadcastState(true);
        }

        // A decision that is logged (copier.log and the Output window) but not a copierEvent of its own.
        private static void Decision(string account, string action, string root, string text) { Line(account, action, root, 0, double.NaN, null, null, null, text); }

        private static void Line(string account, string action, string root, int qty, double price, double? slip, double? leaderMs, double? fillMs, string text)
        {
            ChartBridgeServer.Log("copier " + action + (account != null ? " " + account : "") + (root != null ? " " + root : "") + ": " + text +
                                  (leaderMs.HasValue ? " (leader " + CbJson.Num3(leaderMs.Value) + " ms" + (fillMs.HasValue ? ", fill " + CbJson.Num3(fillMs.Value) + " ms" : "") + ")" : ""));
            string line = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture) + "\t" + (account ?? "-") + "\t" + action + "\t" + (root ?? "-") + "\t" +
                          (qty > 0 ? qty.ToString(CultureInfo.InvariantCulture) : "-") + "\t" + (double.IsNaN(price) ? "-" : P(price)) + "\t" + (slip.HasValue ? P(slip.Value) : "-") + "\t" +
                          (leaderMs.HasValue ? CbJson.Num3(leaderMs.Value) : "-") + "\t" + (fillMs.HasValue ? CbJson.Num3(fillMs.Value) : "-") + "\t" + text.Replace('\t', ' ').Replace('\n', ' ');
            lock (LogLines) LogLines.Add(line);
        }

        // copier.log next to config.txt, appended off NinjaTrader's thread (every second, and at stop).
        public static void FlushLog()
        {
            List<string> lines;
            lock (LogLines) { if (LogLines.Count == 0) return; lines = LogLines.ToList(); LogLines.Clear(); }
            try
            {
                Directory.CreateDirectory(ChartBridgeConfig.Folder);
                File.AppendAllText(Path.Combine(ChartBridgeConfig.Folder, "copier.log"), string.Join("\n", lines) + "\n");
            }
            catch (Exception ex) { ChartBridgeServer.Log("copier.log could not be written (" + ex.Message + "); " + lines.Count + " line(s) are in the Output window only"); }
        }

        private static void BroadcastState(bool force)
        {
            string json = StateJson();
            lock (Lk) { if (!force && json == lastStateSent) return; lastStateSent = json; }
            Broadcast(json);
        }

        private static string PositionJson(Account a, Instrument inst, bool withRoot)
        {
            int q = a != null && inst != null ? ChartBridgeOrders.CopierListed(a, inst) : 0;
            double avg = 0;
            if (q != 0) { lock (a.Positions) { Position p = a.Positions.FirstOrDefault(x => x.Instrument == inst || (x.Instrument != null && x.Instrument.FullName == inst.FullName)); if (p != null) avg = p.AveragePrice; } }
            return "{" + (withRoot ? "\"root\":" + CbJson.Str(ChartBridgeServer.RootFor(inst) ?? "") + "," : "") + "\"qty\":" + q + ",\"avgPrice\":" + (q != 0 && avg > 0 ? CbJson.Num(avg) : "null") + "}";
        }

        public static string StateJson()
        {
            if (!Enabled)
                return "{\"type\":\"copier\",\"enabled\":false,\"simOnly\":true,\"armed\":false,\"standDownWhy\":" + CbJson.Str("The copier is off (copier in config.txt).") + ",\"leader\":null,\"mode\":\"executions\",\"followers\":[]}";
            string l, m, why, lroot;
            bool on;
            List<Follower> list;
            lock (Lk) { l = leader; m = mode; why = standDownWhy; on = armed; lroot = lastLeaderRoot; list = Followers.Select(f => new Follower { Name = f.Name, On = f.On, Qty = f.Qty, Size = f.Size, LossLimit = f.LossLimit, LastAction = f.LastAction, LastAt = f.LastAt, Slippage = f.Slippage, Skipped = f.Skipped }).ToList(); }
            StringBuilder b = new StringBuilder("{\"type\":\"copier\",\"enabled\":true,\"simOnly\":true,\"armed\":").Append(on ? "true" : "false")
                .Append(",\"standDownWhy\":").Append(why != null ? CbJson.Str(why) : "null").Append(",\"leader\":");
            Account la = Find(l);
            if (l == null) b.Append("null");
            else
            {
                string pos = "null";
                if (la != null)
                {
                    List<Position> ps;
                    lock (la.Positions) ps = la.Positions.ToList();
                    Position p = ps.FirstOrDefault(x => x.MarketPosition != MarketPosition.Flat && x.Quantity != 0 && ChartBridgeServer.RootFor(x.Instrument) != null);
                    if (p != null) pos = PositionJson(la, p.Instrument, true);
                }
                b.Append("{\"account\":").Append(CbJson.Str(l)).Append(",\"connection\":").Append(CbJson.Str(ConnectionText(la))).Append(",\"position\":").Append(pos).Append('}');
            }
            b.Append(",\"mode\":").Append(CbJson.Str(m)).Append(",\"followers\":[");
            bool first = true;
            foreach (Follower f in list)
            {
                Account a = Find(f.Name);
                string root = FollowerRoot(lroot, f.Size);
                Instrument inst = root != null ? ChartBridgeServer.InstrumentFor(root) : null;
                double? pnl = a != null ? PnlToday(a) : null;
                if (!first) b.Append(','); first = false;
                b.Append("{\"account\":").Append(CbJson.Str(f.Name)).Append(",\"sim\":").Append(a != null && IsSim(a) ? "true" : "false")
                 .Append(",\"on\":").Append(f.On ? "true" : "false").Append(",\"qty\":").Append(f.Qty).Append(",\"size\":").Append(CbJson.Str(f.Size))
                 .Append(",\"root\":").Append(root != null ? CbJson.Str(root) : "null").Append(",\"position\":").Append(PositionJson(a, inst, false))
                 .Append(",\"lastAction\":").Append(f.LastAction != null ? CbJson.Str(f.LastAction) : "null").Append(",\"lastAt\":").Append(f.LastAt > 0 ? CbJson.Num3(Math.Round(f.LastAt)) : "null")
                 .Append(",\"slippageTicks\":").Append(f.Slippage.HasValue ? CbJson.Num(f.Slippage.Value) : "null").Append(",\"skipped\":").Append(f.Skipped != null ? CbJson.Str(f.Skipped) : "null")
                 .Append(",\"lossLimit\":").Append(f.LossLimit > 0 ? f.LossLimit.ToString(CultureInfo.InvariantCulture) : "null").Append(",\"pnlToday\":").Append(pnl.HasValue ? CbJson.Num(pnl.Value) : "null")
                 .Append(",\"connection\":").Append(CbJson.Str(ConnectionText(a))).Append('}');
            }
            return b.Append("]}").ToString();
        }

        // /diag "copier" (only with the switch on): counts, never account names.
        public static string DiagJson()
        {
            lock (Lk)
            {
                List<double> ms = LeaderMs.OrderBy(x => x).ToList();
                double? median = ms.Count == 0 ? (double?)null : ms.Count % 2 == 1 ? ms[ms.Count / 2] : (ms[ms.Count / 2 - 1] + ms[ms.Count / 2]) / 2;
                return "{\"armed\":" + (armed ? "true" : "false") + ",\"followers\":" + Followers.Count + ",\"followersOn\":" + Followers.Count(f => f.On) +
                       ",\"decisions\":" + decisions + ",\"skipped\":" + skippedCount + ",\"standDowns\":" + standDowns +
                       ",\"leaderMsMedian\":" + (median.HasValue ? CbJson.Num3(median.Value) : "null") + ",\"openCopies\":" + Copies.Count +
                       ",\"settingsReadFailed\":" + (loadFailed ? "true" : "false") + ",\"settingsSaveFailed\":" + (saveFailed != null ? "true" : "false") + "}";
            }
        }

        // ---------------------------------------------------------- copier.txt (written by ChartBridge only)
        //   # ChartBridge copier (written by ChartBridge; do not edit)
        //   leader<TAB><account>
        //   mode<TAB>executions|orders
        //   follower<TAB><account><TAB>on|off<TAB><qty 1-9><TAB>micro|mini<TAB><loss limit, 0 = off>
        // Read once at start; written whole through a temp file after every change (on the page's connection thread, outside
        // every lock), tried again every second when it fails. A file that exists but cannot be read is never rewritten that
        // run, and the copier's settings cannot change (the pages are told).
        public static Func<string> ReadFault, WriteFault;   // test hooks: a non-null answer fails a read or write with that text (unused in NinjaTrader)
        private static string FilePath { get { return Path.Combine(ChartBridgeConfig.Folder, "copier.txt"); } }

        private static void Load()
        {
            string file = FilePath;
            if (!File.Exists(file)) return;
            string[] lines;
            try
            {
                string fault = ReadFault != null ? ReadFault() : null;
                if (fault != null) throw new IOException(fault);
                lines = File.ReadAllLines(file);
            }
            catch (Exception ex)
            {
                lock (Lk) loadFailed = true;
                ChartBridgeServer.Log("ALERT: copier.txt could not be read (" + ex.Message + "): the copier keeps no leader or followers this run and stays stood down; it is not rewritten");
                return;
            }
            lock (Lk)
            {
                foreach (string raw in lines)
                {
                    string[] p = raw.Split('\t');
                    int q, loss;
                    if (raw.StartsWith("#") || raw.Trim().Length == 0) continue;
                    if (p.Length == 2 && p[0] == "leader" && p[1].Length > 0) leader = p[1];
                    else if (p.Length == 2 && p[0] == "mode" && (p[1] == "executions" || p[1] == "orders")) mode = p[1];
                    else if (p.Length == 6 && p[0] == "follower" && p[1].Length > 0 && (p[2] == "on" || p[2] == "off") && int.TryParse(p[3], NumberStyles.None, CultureInfo.InvariantCulture, out q) &&
                             q >= 1 && q <= MaxQtyPerContract && (p[4] == "micro" || p[4] == "mini") && int.TryParse(p[5], NumberStyles.None, CultureInfo.InvariantCulture, out loss) && FollowerNamed(p[1]) == null)
                        Followers.Add(new Follower { Name = p[1], On = p[2] == "on", Qty = q, Size = p[4], LossLimit = loss });
                    else ChartBridgeServer.Log("copier.txt: line not understood, skipped: " + raw);
                }
                if (leader != null) { Follower f = FollowerNamed(leader); if (f != null) Followers.Remove(f); }
            }
        }

        private static void Save()
        {
            string err = WriteOnce();
            lock (Lk) saveFailed = err;
            if (err != null) ChartBridgeOrders.CopierAlarm("copier.txt could not be saved (" + err + "); the copier's settings are in force but may not survive a restart; ChartBridge tries again every second");
        }

        private static readonly object FileLock = new object();

        private static string WriteOnce()
        {
            lock (FileLock)
            {
                List<string> lines = new List<string> { "# ChartBridge copier (written by ChartBridge; do not edit)" };
                lock (Lk)
                {
                    if (loadFailed) return "copier.txt could not be read at start, so it is not rewritten this run";
                    if (leader != null) lines.Add("leader\t" + leader);
                    lines.Add("mode\t" + mode);
                    foreach (Follower f in Followers)
                        lines.Add("follower\t" + f.Name + "\t" + (f.On ? "on" : "off") + "\t" + f.Qty.ToString(CultureInfo.InvariantCulture) + "\t" + f.Size + "\t" + f.LossLimit.ToString(CultureInfo.InvariantCulture));
                }
                try
                {
                    string fault = WriteFault != null ? WriteFault() : null;
                    if (fault != null) return fault;
                    Directory.CreateDirectory(ChartBridgeConfig.Folder);
                    string tmp = FilePath + ".tmp";
                    File.WriteAllLines(tmp, lines.ToArray());
                    if (File.Exists(FilePath)) File.Replace(tmp, FilePath, null); else File.Move(tmp, FilePath);
                    return null;
                }
                catch (Exception ex) { return ex.Message; }
            }
        }

        private static void KeepSaved()
        {
            string failed;
            lock (Lk) failed = saveFailed;
            if (failed == null) return;
            string err = WriteOnce();
            lock (Lk) saveFailed = err;
            if (err == null) ChartBridgeOrders.CopierWarn("copier.txt is saved now");
        }
    }
}
