// ChartBridge's order record to The Desk, and the decision id of a group entry (ChartBridge 0.6.9; Anthony 2026-10-24, Phase 2 of his
// stats suite: "ChartBridge records every order he sends (market, limit, stop, target) with its price when sent", and "a group entry
// counts once as a decision"). Part of the ChartBridge add-on; install it with the other files. See nt8/PROTOCOL.md, "The order record
// to The Desk (0.6.9)" and "The decision id of a group entry (0.6.9)".
//
//   - ChartBridgeOrderRecord: every order update on a watched account already comes through ChartBridgeServer.OnOrderUpdate. For every
//     order, whatever its type (market, limit, stop market, stop limit, MIT) and whoever placed it (the page, NinjaTrader's own chart
//     or ATM, the bot, an agent, the copier), each change of NinjaTrader's state, the limit or stop price, the quantity or the filled
//     count queues one event for The Desk's POST /api/order-events, with the time ChartBridge saw it, and at the order's first event
//     and at each price change the bid, ask and last price ChartBridge knows at that moment (each null with the reason when not known).
//     The stop record (ChartBridgeStops.cs, POST /api/stop-events) is not changed and still runs beside it, exactly as in 0.6.6.
//   - ChartBridgeDecisions: one id for one group entry from the page's group ticket (ChartBridgeGroups.cs, groupOrder), set on every
//     member's entry before it is sent and carried by that entry's legs (they share its CB# tag), so the order record and the fills to
//     The Desk (an optional "decision_id") can count one decision once. A single-account entry has none (its fills are as before).
//
// Recording only: the order event only adds a small snapshot to a queue in memory (no file, no network, no JSON on NinjaTrader's event
// thread); the 10 s account timer builds the events, saves pending_orders.jsonl and sends. This file never places, changes or cancels an
// order. Written in C# 5 syntax (NinjaTrader 8 compiles NinjaScript as C# 5).
#region Using declarations
using System;
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
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    // ---------------------------------------------------------------- the order record's window into ChartBridgeOrders (read only)
    public static partial class ChartBridgeOrders
    {
        // 0.6.9: the last trade price ChartBridge saw for a root and how old it is (this PC's clock), for the order record's quote
        internal static bool LastKnown(string root, out double price, out double ageMs)
        {
            double[] v;
            price = 0; ageMs = 0;
            lock (Last) { if (root == null || !Last.TryGetValue(root, out v)) return false; }
            price = v[0];
            ageMs = ChartBridgeTime.NowUtcMs() - v[1];
            return true;
        }
        internal static string OrderRecordKind(OrderType t)
        {
            if (t == OrderType.Market) return "market";
            if (t == OrderType.Limit) return "limit";
            if (t == OrderType.StopMarket) return "stop";
            if (t == OrderType.StopLimit) return "stopLimit";
            if (t == OrderType.MIT) return "mit";
            return "other";
        }
    }

    // ---------------------------------------------------------------- the decision id of a group entry
    public static class ChartBridgeDecisions
    {
        // The harness turns it off to run the 0.6.8 path and compare the orders sent (they must be the same, byte for byte).
        public static bool Enabled = true;
        public static int KeepDays = 5;            // decisions.txt keeps a decision this long (a trade's exits after a restart)
        public const int MaxKept = 5000;
        private static readonly object Sync = new object();
        private static readonly Dictionary<string, string> ByTag = new Dictionary<string, string>();       // CB# tag -> decision id
        private static readonly Dictionary<string, double> TagAt = new Dictionary<string, double>();        // CB# tag -> when (UTC ms)
        private static bool dirty;
        private static long made, noted;
        [ThreadStatic] private static string current, currentAccount;   // the group entry being placed on this thread, and its member

        private static string File_ { get { return Path.Combine(ChartBridgeConfig.Folder, "decisions.txt"); } }

        // "d" and 12 hex characters, new for every group entry.
        public static string NewId() { Interlocked.Increment(ref made); return "d" + Guid.NewGuid().ToString("N").Substring(0, 12); }

        // ChartBridgeGroups' groupOrder, around each member's PlaceOrder (same thread): the entry that member's PlaceOrder creates takes it.
        public static void Begin(string decision, string account) { if (!Enabled) return; current = decision; currentAccount = account; }
        public static void End() { current = null; currentAccount = null; }

        // "CB#1a2b3c4d ..." -> "1a2b3c4d"; null for any other name.
        public static string TagOf(string name)
        {
            if (name == null || name.Length < 11 || name[0] != 'C' || name[1] != 'B' || name[2] != '#') return null;
            for (int i = 3; i < 11; i++) { char c = name[i]; if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return null; }
            if (name.Length > 11 && name[11] != ' ') return null;
            return name.Substring(3, 8);
        }

        // ChartBridgeGroups.NoteNewOrder, inside PlaceOrderLocked after CreateOrder and before Submit, for every order ChartBridge's
        // order path creates: only a group entry's member order (this thread inside Begin, the same account) is noted. Never throws.
        public static void NoteCreated(Account a, Order o)
        {
            string d = current;
            if (d == null || o == null || a == null) return;
            try
            {
                if (!string.Equals(a.Name, currentAccount, StringComparison.OrdinalIgnoreCase)) return;
                string tag = TagOf(o.Name);
                if (tag == null) return;
                lock (Sync)
                {
                    ByTag[tag] = d; TagAt[tag] = ChartBridgeTime.NowUtcMs(); dirty = true; noted++;
                    if (ByTag.Count > MaxKept) { string oldest = TagAt.OrderBy(kv => kv.Value).First().Key; ByTag.Remove(oldest); TagAt.Remove(oldest); }
                }
            }
            catch (Exception) { }
        }

        // The decision of an order (its own entry or a leg of it, by the CB# tag), or null.
        public static string Of(Order o)
        {
            if (o == null) return null;
            string tag = TagOf(o.Name);
            if (tag == null) return null;
            lock (Sync) { string d; return ByTag.TryGetValue(tag, out d) ? d : null; }
        }
        public static bool Any() { lock (Sync) return ByTag.Count > 0; }

        // The fills to The Desk (DeskFillJson): ,"decision_id":"d..." for a fill of a group entry's order (its entry or a leg); "" for
        // every other fill, so it is byte for byte as before. The execution's own order when given; else read by its id on that account,
        // only while some decision is kept.
        public static string FillField(string account, string orderId, Order order)
        {
            try
            {
                if (order == null && Any() && !string.IsNullOrEmpty(orderId) && !string.IsNullOrEmpty(account))
                {
                    List<Account> all;
                    lock (Account.All) all = Account.All.ToList();
                    foreach (Account a in all)
                    {
                        if (a.Name != account) continue;
                        lock (a.Orders) foreach (Order x in a.Orders) if (x.OrderId == orderId) { order = x; break; }
                        break;
                    }
                }
                string d = Of(order);
                return d == null ? "" : ",\"decision_id\":" + CbJson.Str(d);
            }
            catch (Exception) { return ""; }
        }

        public static void Clear() { lock (Sync) { ByTag.Clear(); TagAt.Clear(); dirty = false; } }

        // decisions.txt: "tag<TAB>decision<TAB>UTC ms", written by ChartBridge only (a header line, then one line a tag), KeepDays kept.
        public static void Load()
        {
            lock (Sync)
            {
                ByTag.Clear(); TagAt.Clear(); dirty = false;
                try
                {
                    if (!File.Exists(File_)) return;
                    double cutoff = ChartBridgeTime.NowUtcMs() - KeepDays * 86400000.0;
                    foreach (string raw in File.ReadAllLines(File_))
                    {
                        string[] p = raw.Split('\t');
                        double at;
                        if (p.Length != 3 || TagOf("CB#" + p[0]) == null || !Regex.IsMatch(p[1], "^d[0-9a-f]{12}$") || !double.TryParse(p[2], NumberStyles.Float, CultureInfo.InvariantCulture, out at)) continue;
                        if (at < cutoff) continue;
                        ByTag[p[0]] = p[1]; TagAt[p[0]] = at;
                    }
                }
                catch (Exception ex) { ChartBridgeServer.Log("could not read decisions.txt: " + ex.Message); }
            }
        }

        // On the 10 s timer's send and at the stop (never NinjaTrader's event thread).
        public static void SaveIfDirty()
        {
            string[] lines;
            lock (Sync)
            {
                if (!dirty) return;
                double cutoff = ChartBridgeTime.NowUtcMs() - KeepDays * 86400000.0;
                foreach (string old in TagAt.Where(kv => kv.Value < cutoff).Select(kv => kv.Key).ToList()) { ByTag.Remove(old); TagAt.Remove(old); }
                lines = new[] { "# ChartBridge decision ids of group entries (written by ChartBridge; do not edit): tag<TAB>decision<TAB>UTC ms" }
                    .Concat(ByTag.OrderBy(kv => TagAt[kv.Key]).Select(kv => kv.Key + "\t" + kv.Value + "\t" + Math.Round(TagAt[kv.Key]).ToString(CultureInfo.InvariantCulture))).ToArray();
                dirty = false;
            }
            try
            {
                Directory.CreateDirectory(ChartBridgeConfig.Folder);
                string tmp = File_ + ".tmp";
                File.WriteAllLines(tmp, lines);
                if (File.Exists(File_)) File.Replace(tmp, File_, null); else File.Move(tmp, File_);
            }
            catch (Exception ex) { lock (Sync) dirty = true; ChartBridgeServer.Log("could not save decisions.txt: " + ex.Message); }
        }

        public static string DiagJson() { int n; lock (Sync) n = ByTag.Count; return "{\"made\":" + Interlocked.Read(ref made) + ",\"ordersNoted\":" + Interlocked.Read(ref noted) + ",\"kept\":" + n + "}"; }
    }

    // ---------------------------------------------------------------- the order record
    public static class ChartBridgeOrderRecord
    {
        private static bool? postOrders;                     // config.txt postOrders; null: follow postFills
        public static bool On { get { return postOrders.HasValue ? postOrders.Value : ChartBridgeConfig.PostFills; } }
        public static Func<double> NowMs = ChartBridgeTime.NowUtcMs;   // the harness sets its own clock
        public static void ResetConfig() { postOrders = null; }
        public static bool ReadConfig(string key, string val)
        {
            if (key != "postOrders") return false;
            postOrders = val.Equals("true", StringComparison.OrdinalIgnoreCase) || val == "1";
            return true;
        }

        // What one order event left: the event's own values (never the order's live fields), read on the event thread; the JSON is made
        // on the timer.
        private sealed class Snap
        {
            public Order O; public string Account, Instrument, Root, Id, NtId, Name, Oco, Change;
            public OrderType Type; public bool Buy;
            public OrderState State; public double Limit, Stop, Avg, AtMs; public int Qty, Filled; public DateTime NtTime;
            public bool Quoted; public double Bid, Ask, Last; public string QuoteWhy;
            public long Seq;
        }
        private sealed class Prev { public OrderState State; public double Limit, Stop; public int Qty, Filled; }

        private static readonly object Seen = new object();
        private static readonly Dictionary<Order, Prev> Last = new Dictionary<Order, Prev>();
        private static readonly Dictionary<Order, string> FirstId = new Dictionary<Order, string>();
        // Review of #71 (LOW 6): the ended orders are forgotten oldest first, one at a time past MaxEnded (never all at once, so a final
        // event repeated soon after is still known), and an order seen with no end for MaxAgeMs (7 days) is forgotten on the timer.
        private static readonly Queue<Order> Ended = new Queue<Order>();
        private static readonly Dictionary<Order, double> SeenAt = new Dictionary<Order, double>();   // first seen (UTC ms), every order kept
        public static int MaxEnded = 20000;
        public static double MaxAgeMs = 7 * 86400000.0;
        private static readonly Regex ByRx = new Regex("^(page|bot|copier|agent:[a-z][a-z0-9]{0,11})$");
        private static long idSeq, eventSeq, observed, queuedEvents, observeTicks;
        private static string start = NewStart();
        private static bool noInstrumentSaid;
        private static string NewStart() { return Guid.NewGuid().ToString("N").Substring(0, 6); }

        private static bool IsDone(OrderState s) { return s == OrderState.Filled || s == OrderState.Cancelled || s == OrderState.Rejected; }

        public static void Clear()
        {
            lock (Seen) { Last.Clear(); FirstId.Clear(); Ended.Clear(); SeenAt.Clear(); }
            lock (Sync) Snaps.Clear();
            start = NewStart();   // the per-start part of a "cb" id and of every event's seq (the stop record's known limit, fixed here)
            Interlocked.Exchange(ref idSeq, 0); Interlocked.Exchange(ref eventSeq, 0);
        }

        // One order update (ChartBridgeServer.OnOrderUpdate, every watched account), on NinjaTrader's event thread. Only adds a snapshot
        // to the queue in memory: no file, no network, no JSON here. Never throws into NinjaTrader's event.
        public static void Observe(Account a, OrderEventArgs e)
        {
            if (!On || a == null || e == null || e.Order == null) return;
            long t0 = System.Diagnostics.Stopwatch.GetTimestamp();
            Order o = e.Order;
            Instrument inst = o.Instrument;
            if (inst == null || inst.MasterInstrument == null)
            {
                if (!noInstrumentSaid) { noInstrumentSaid = true; ChartBridgeServer.Log("order record: an order on " + (a.Name ?? "?") + " has no instrument yet; it is skipped until it has one (said once)"); }
                return;
            }
            Interlocked.Increment(ref observed);
            OrderState st = e.OrderState;
            double lp = e.LimitPrice, sp = e.StopPrice;
            int qty = e.Quantity, filled = e.Filled;
            string id, change;
            lock (Seen)
            {
                Prev p;
                bool had = Last.TryGetValue(o, out p);
                if (had && p.State == st && p.Limit == lp && p.Stop == sp && p.Qty == qty && p.Filled == filled) return;   // nothing changed, or its end again
                if (!had) change = "new";
                else
                {
                    List<string> c = new List<string>(4);
                    if (p.State != st) c.Add("state");
                    if (p.Limit != lp || p.Stop != sp) c.Add("price");
                    if (p.Qty != qty) c.Add("qty");
                    if (p.Filled != filled) c.Add("filled");
                    change = string.Join(",", c);
                }
                if (!FirstId.TryGetValue(o, out id))
                {
                    id = string.IsNullOrEmpty(o.OrderId) ? "cb" + start + "-" + Interlocked.Increment(ref idSeq).ToString(CultureInfo.InvariantCulture) : o.OrderId;
                    FirstId[o] = id;
                    SeenAt[o] = NowMs();
                }
                Last[o] = new Prev { State = st, Limit = lp, Stop = sp, Qty = qty, Filled = filled };
                if (IsDone(st) && !(had && IsDone(p.State)))
                {
                    Ended.Enqueue(o);
                    while (Ended.Count > MaxEnded) { Order x = Ended.Dequeue(); Last.Remove(x); FirstId.Remove(x); SeenAt.Remove(x); }
                }
            }
            Snap s = new Snap
            {
                O = o, Account = a.Name ?? "", Instrument = inst.FullName ?? "", Root = inst.MasterInstrument.Name ?? "", Id = id, NtId = o.OrderId, Name = o.Name, Oco = o.Oco, Change = change,
                Type = o.OrderType, Buy = ChartBridgeOrders.GroupIsBuy(o), State = st, Limit = lp, Stop = sp, Qty = qty, Filled = filled, Avg = e.AverageFillPrice, NtTime = e.Time,
                AtMs = NowMs(), Seq = Interlocked.Increment(ref eventSeq)
            };
            if (change == "new" || change.Contains("price"))
            {
                // at submission (the order's first event) and at each price change: what ChartBridge knows now, never estimated
                s.Quoted = true;
                try { s.QuoteWhy = ChartBridgeServer.QuoteNow(inst, out s.Bid, out s.Ask, out s.Last); }
                catch (Exception ex) { s.Bid = s.Ask = s.Last = double.NaN; s.QuoteWhy = "the quote could not be read (" + ex.Message + ")"; }
            }
            bool sayDrop = false;
            lock (Sync)
            {
                // review of #71 (LOW 7): only the snapshots' own queue here (a Dequeue, never a move of the waiting lines); the timer keeps
                // snapshots and lines together within Cap, dropping the oldest lines first
                Snaps.Enqueue(s); Interlocked.Increment(ref queuedEvents);
                if (Snaps.Count > Cap) { Snaps.Dequeue(); dropped++; if (!droppedSaid) { droppedSaid = true; sayDrop = true; } }
            }
            Interlocked.Add(ref observeTicks, System.Diagnostics.Stopwatch.GetTimestamp() - t0);
            if (sayDrop) ChartBridgeServer.Log("order record: more than " + Cap + " order events wait for The Desk; the oldest are dropped (counted in /diag orderRecord.dropped; said once)");
        }

        private static string Px(double v) { return v > 0 && !double.IsNaN(v) && !double.IsInfinity(v) ? CbJson.Num(v) : "null"; }
        private static string Cut(string s) { return s.Length > 64 ? s.Substring(0, 64) : s; }

        // One event in The Desk's POST /api/order-events shape (v 1). Made on the timer, never on NinjaTrader's event thread.
        private static string EventJson(Snap s)
        {
            string by = null, decision = null, role = "other";
            try { by = ChartBridgeV3.SourceOf(s.O); } catch (Exception) { by = null; }
            if (by != null && !ByRx.IsMatch(by)) by = null;
            try { decision = ChartBridgeDecisions.Of(s.O); } catch (Exception) { decision = null; }
            try { role = ChartBridgeOrders.StopRecordRole(s.O); } catch (Exception) { role = "other"; }
            string name = s.Name ?? "";
            StringBuilder b = new StringBuilder(640);
            b.Append("{\"v\":1,\"source\":\"nt8\"");
            b.Append(",\"account\":").Append(CbJson.Str(s.Account))
             .Append(",\"instrument\":").Append(CbJson.Str(s.Instrument))
             .Append(",\"root\":").Append(CbJson.Str(s.Root))
             .Append(",\"order_id\":").Append(CbJson.Str(Cut(s.Id)))
             .Append(",\"nt_order_id\":").Append(string.IsNullOrEmpty(s.NtId) ? "null" : CbJson.Str(Cut(s.NtId)))   // review of #71: NinjaTrader's id now (fills carry the final one)
             .Append(",\"order_name\":").Append(name.Length == 0 ? "null" : CbJson.Str(Cut(name)))
             .Append(",\"oco\":").Append(string.IsNullOrEmpty(s.Oco) ? "null" : CbJson.Str(Cut(s.Oco)))
             .Append(",\"side\":").Append(s.Buy ? "\"buy\"" : "\"sell\"")
             .Append(",\"kind\":").Append(CbJson.Str(ChartBridgeOrders.OrderRecordKind(s.Type)))
             .Append(",\"nt_state\":").Append(CbJson.Str(s.State.ToString()))
             .Append(",\"state\":").Append(CbJson.Str(ChartBridgeOrders.StopRecordState(s.State)))
             .Append(",\"limit_price\":").Append(Px(s.Limit))
             .Append(",\"stop_price\":").Append(Px(s.Stop))
             .Append(",\"qty\":").Append(s.Qty.ToString(CultureInfo.InvariantCulture))
             .Append(",\"filled\":").Append(Math.Max(0, s.Qty > 0 ? Math.Min(s.Filled, s.Qty) : s.Filled).ToString(CultureInfo.InvariantCulture))
             .Append(",\"avg_fill_price\":").Append(s.Filled > 0 ? Px(s.Avg) : "null")
             .Append(",\"role\":").Append(CbJson.Str(role))
             .Append(",\"by\":").Append(by == null ? "null" : CbJson.Str(by))
             .Append(",\"decision_id\":").Append(decision == null ? "null" : CbJson.Str(decision))
             .Append(",\"change\":").Append(CbJson.Str(s.Change));
            if (s.Quoted)
                b.Append(",\"quote\":{\"bid\":").Append(Px(s.Bid)).Append(",\"ask\":").Append(Px(s.Ask)).Append(",\"last\":").Append(Px(s.Last))
                 .Append(",\"why\":").Append(s.QuoteWhy == null ? "null" : CbJson.Str(s.QuoteWhy)).Append('}');
            else b.Append(",\"quote\":null");
            double ntMs = double.NaN;
            try { if (s.NtTime > new DateTime(2000, 1, 1)) ntMs = ChartBridgeTime.UtcMs(ChartBridgeTime.ToUtc(s.NtTime)); } catch (Exception) { }
            b.Append(",\"nt_time_ms\":").Append(double.IsNaN(ntMs) ? "null" : Math.Round(ntMs).ToString(CultureInfo.InvariantCulture))
             .Append(",\"start\":").Append(CbJson.Str(start))
             .Append(",\"seq\":").Append(s.Seq.ToString(CultureInfo.InvariantCulture))
             .Append(",\"at_ms\":").Append(Math.Round(s.AtMs).ToString(CultureInfo.InvariantCulture)).Append('}');
            return b.ToString();
        }

        // ---------------------------------------------------------- the queue (the stop record's rules, but a 404 keeps the events)
        private static readonly object Sync = new object();
        private static readonly Queue<Snap> Snaps = new Queue<Snap>();
        private static readonly List<string> Appended = new List<string>();   // lines added since the file was last written (it is appended to)
        private static bool rewrite;                                          // a line left the queue since: the file is written whole
        private static readonly List<string> PendingList = new List<string>();
        private static readonly HashSet<string> PendingSet = new HashSet<string>();
        private static readonly Regex RejectedRx = new Regex("\"rejected\"\\s*:\\s*\\[(.*?)\\]\\s*[,}]", RegexOptions.Singleline);
        private static readonly Regex ReasonRx = new Regex("\"reason\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        private const int FullBatch = 500;
        public static int TimeoutMs = 10000;
        public static int NoDeskRetryMs = 300000;    // after a 404 (a Desk without POST /api/order-events yet): offered again every 5 minutes
        private static int sending, batchSize = FullBatch;
        private static bool lastFailed, droppedSaid;
        private static volatile bool deskHasNone;
        private static double noDeskUntil;
        public static int Cap = 20000;
        private static long dropped, setAside, rejectedByDesk, sent;
        private static string lastError = "";
        private static string File_ { get { return Path.Combine(ChartBridgeConfig.Folder, "pending_orders.jsonl"); } }
        private static string SetAsideFile { get { return Path.Combine(ChartBridgeConfig.Folder, "rejected_orders.jsonl"); } }

        private static bool LooksWhole(string line) { return line.StartsWith("{\"v\":1,") && line.EndsWith("}") && line.Contains("\"order_id\":") && line.Contains(",\"at_ms\":"); }

        public static void Load()
        {
            deskHasNone = false; noDeskUntil = 0;
            lock (Sync)
            {
                PendingList.Clear(); PendingSet.Clear(); Appended.Clear(); rewrite = false;
                int bad = 0;
                try
                {
                    if (File.Exists(File_))
                        foreach (string raw in File.ReadAllLines(File_))
                        {
                            string line = raw.Trim();
                            if (line.Length == 0) continue;
                            if (!LooksWhole(line)) { bad++; continue; }
                            if (PendingSet.Add(line)) PendingList.Add(line);
                        }
                }
                catch (Exception ex) { ChartBridgeServer.Log("could not read pending order events: " + ex.Message); }
                if (bad > 0) { ChartBridgeServer.Log("skipped " + bad + " unreadable line(s) in pending_orders.jsonl"); rewrite = true; }
            }
        }

        // The snapshots made into events (JSON), added to the waiting lines. Never on NinjaTrader's event thread.
        private static void Build()
        {
            Prune();
            List<Snap> take;
            lock (Sync) { if (Snaps.Count == 0) return; take = Snaps.ToList(); Snaps.Clear(); }
            List<string> lines = new List<string>(take.Count);
            foreach (Snap s in take) { try { lines.Add(EventJson(s)); } catch (Exception ex) { ChartBridgeServer.Log("order record: an event could not be made (" + ex.Message + ")"); } }
            lock (Sync)
            {
                foreach (string l in lines) if (PendingSet.Add(l)) { PendingList.Add(l); Appended.Add(l); }
                int over = PendingList.Count - Cap;
                if (over > 0)
                {
                    for (int i = 0; i < over; i++) PendingSet.Remove(PendingList[i]);
                    PendingList.RemoveRange(0, over);   // once, on the timer
                    dropped += over; rewrite = true;
                    if (!droppedSaid) { droppedSaid = true; ChartBridgeServer.Log("order record: more than " + Cap + " order events wait for The Desk; the oldest are dropped (counted in /diag orderRecord.dropped; said once)"); }
                }
            }
        }

        private static readonly object SaveLock = new object();
        private static void SaveIfDirty()
        {
            lock (SaveLock)
            {
                // review of #71 (LOW 7): written only when the queue changed since the last write: new lines are appended (a line cut
                // short by a crash is skipped when read), and the file is written whole only after lines left the queue (sent, set aside,
                // dropped). So a Desk answering 404 for days costs an append of the new events, never a rewrite every 10 s.
                string[] lines; bool whole;
                lock (Sync)
                {
                    whole = rewrite || !File.Exists(File_);
                    if (!whole && Appended.Count == 0) return;
                    lines = whole ? PendingList.ToArray() : Appended.ToArray();
                    Appended.Clear(); rewrite = false;
                }
                try
                {
                    Directory.CreateDirectory(ChartBridgeConfig.Folder);
                    if (whole)
                    {
                        string tmp = File_ + ".tmp";
                        File.WriteAllLines(tmp, lines);
                        if (File.Exists(File_)) File.Replace(tmp, File_, null); else File.Move(tmp, File_);
                    }
                    else File.AppendAllLines(File_, lines);
                    lastWrite = whole ? "whole" : "append";
                }
                catch (Exception ex) { lock (Sync) rewrite = true; ChartBridgeServer.Log("could not save pending order events: " + ex.Message); }
            }
        }

        // At ChartBridge's stop (after the accounts are no longer watched) and for the harness: build and save now, on this thread.
        public static void SaveNow() { Build(); SaveIfDirty(); }

        public static int Waiting() { lock (Sync) return PendingList.Count + Snaps.Count; }
        public static string lastWrite = "";   // the harness: how the last save wrote the file ("whole" or "append")
        public static int BatchSize { get { return batchSize; } }

        // On the timer: orders seen with no end for MaxAgeMs are forgotten (an order NinjaTrader never ended for us).
        private static void Prune()
        {
            double cut = NowMs() - MaxAgeMs;
            lock (Seen)
            {
                List<Order> old = null;
                foreach (KeyValuePair<Order, double> kv in SeenAt) if (kv.Value < cut) { if (old == null) old = new List<Order>(); old.Add(kv.Key); }
                if (old == null) return;
                foreach (Order o in old) { Prev p; if (Last.TryGetValue(o, out p) && IsDone(p.State)) continue; Last.Remove(o); FirstId.Remove(o); SeenAt.Remove(o); }
            }
        }
        public static int Known() { lock (Seen) return Last.Count; }

        // The event thread's own cost, for /diag and the harness: the mean time Observe took, in microseconds.
        public static double ObserveMeanUs()
        {
            long n = Interlocked.Read(ref observed);
            return n == 0 ? 0 : Interlocked.Read(ref observeTicks) * 1e6 / System.Diagnostics.Stopwatch.Frequency / n;
        }

        public static string DiagJson()
        {
            long d; lock (Sync) d = dropped;
            return "{\"on\":" + (On ? "true" : "false") + ",\"deskHasNoOrderRecord\":" + (deskHasNone ? "true" : "false") + ",\"dropped\":" + d + ",\"waiting\":" + Waiting() +
                ",\"seen\":" + Interlocked.Read(ref observed) + ",\"queued\":" + Interlocked.Read(ref queuedEvents) + ",\"sent\":" + Interlocked.Read(ref sent) +
                ",\"observeMeanUs\":" + CbJson.Num3(ObserveMeanUs()) +
                ",\"lastSendFailed\":" + (lastFailed ? "true" : "false") + ",\"lastError\":" + CbJson.Str(lastError) +
                ",\"setAside\":" + Interlocked.Read(ref setAside) + ",\"rejectedByDesk\":" + Interlocked.Read(ref rejectedByDesk) + ",\"rejectedFile\":\"rejected_orders.jsonl\"" +
                ",\"start\":" + CbJson.Str(start) + ",\"decisions\":" + ChartBridgeDecisions.DiagJson() + "}";
        }

        private static void Remove(string[] batch)
        {
            lock (Sync)
            {
                HashSet<string> gone = new HashSet<string>(batch);
                PendingList.RemoveAll(gone.Contains);
                foreach (string f in batch) PendingSet.Remove(f);
                rewrite = true;
            }
        }

        private static async Task<WebResponse> Post(HttpWebRequest req, byte[] bytes)
        {
            using (Stream s = await req.GetRequestStreamAsync()) await s.WriteAsync(bytes, 0, bytes.Length);
            return await req.GetResponseAsync();
        }

        // The 10 s account timer (never NinjaTrader's event thread): builds the events, saves the queue, posts the oldest batch.
        public static void Flush()
        {
            if (!On) return;
            if (Interlocked.CompareExchange(ref sending, 1, 0) != 0) return;
            Task.Run(async () =>
            {
                bool more = false;
                string[] batch = new string[0];
                try
                {
                    Build();
                    SaveIfDirty();
                    if (deskHasNone && ChartBridgeTime.NowUtcMs() < noDeskUntil) return;
                    lock (Sync) batch = PendingList.Take(batchSize).ToArray();
                    if (batch.Length == 0) return;
                    byte[] bytes = Encoding.UTF8.GetBytes("[" + string.Join(",", batch) + "]");
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(ChartBridgeConfig.DeskUrl + "/api/order-events");
                    req.Method = "POST";
                    req.ContentType = "application/json";
                    Task<WebResponse> call = Post(req, bytes);
                    Task first = await Task.WhenAny(call, Task.Delay(TimeoutMs));
                    if (first != call)
                    {
                        try { req.Abort(); } catch (Exception) { }
                        Task observedCall = call.ContinueWith(t => { Exception ignored = t.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
                        throw new TimeoutException("The Desk did not answer within " + (TimeoutMs / 1000) + " seconds");
                    }
                    string text;
                    using (HttpWebResponse res = (HttpWebResponse)await call)
                    using (StreamReader r = new StreamReader(res.GetResponseStream(), Encoding.UTF8)) text = r.ReadToEnd();
                    NoteRejected(text, batch);   // 0.6.10 (C-B): each one The Desk rejected inside its 200, kept before the batch goes
                    Remove(batch);
                    SaveIfDirty();
                    Interlocked.Add(ref sent, batch.Length);
                    batchSize = Math.Min(FullBatch, Math.Max(batch.Length, batchSize) * 2);   // review of #71 (LOW 7): grows back after a refusal
                    lock (Sync) more = PendingList.Count > 0;
                    if (lastFailed || deskHasNone) ChartBridgeServer.Log("The Desk is taking order events.");
                    lastFailed = false; deskHasNone = false;
                    lastError = "";
                }
                catch (WebException wex)
                {
                    HttpWebResponse res = wex.Response as HttpWebResponse;
                    int code = res != null ? (int)res.StatusCode : 0;
                    if (code == 404)
                    {
                        // a Desk without POST /api/order-events yet: the events stay (in the file too) and are offered again every 5 minutes,
                        // so none is lost while The Desk's side is still to come
                        if (!deskHasNone) ChartBridgeServer.Log("The Desk has no order record yet (POST /api/order-events answered 404): the order events stay in pending_orders.jsonl (" + Waiting() + " now) and are offered again every " + (NoDeskRetryMs / 60000) + " minutes");
                        deskHasNone = true; noDeskUntil = ChartBridgeTime.NowUtcMs() + NoDeskRetryMs;
                        lastError = "The Desk has no order record (404)";
                    }
                    else if (code == 400 || code == 413 || code == 422)
                    {
                        if (batch.Length > 1) batchSize = Math.Max(1, batch.Length / 2);   // halved until the bad one goes alone
                        else
                        {
                            try { File.AppendAllLines(SetAsideFile, batch); } catch (Exception) { }
                            Remove(batch);
                            SaveIfDirty();
                            Interlocked.Increment(ref setAside);
                            ChartBridgeServer.Log("The Desk refused an order event (" + code + "); it was set aside in rejected_orders.jsonl");
                        }
                        more = true;
                    }
                    else Failed(wex.Message);
                }
                catch (Exception ex) { Failed(ex.Message); }
                finally { Interlocked.Exchange(ref sending, 0); }
                if (more) Flush();
            });
        }

        private static void Failed(string message)
        {
            lastError = message;
            if (!lastFailed) ChartBridgeServer.Log("The Desk did not take order events (" + message + "); they are saved and will be retried every 10 seconds.");
            lastFailed = true;
        }

        // 0.6.10 (Anthony 2026-10-30, C-B): each order event The Desk rejected inside its 200 is appended to rejected_orders.jsonl with
        // The Desk's reason (as the 400/413/422 path sets one aside), never dropped unseen.
        private static void NoteRejected(string text, string[] batch)
        {
            Match m = RejectedRx.Match(text ?? "");
            if (!m.Success || m.Groups[1].Value.Trim().Length == 0) return;
            int n = Regex.Matches(m.Groups[1].Value, "\"index\"").Count;
            if (n == 0) return;
            Interlocked.Add(ref rejectedByDesk, n);
            Match why = ReasonRx.Match(m.Groups[1].Value);
            int kept = ChartBridgeDesk.KeepRejected(m.Groups[1].Value, batch, SetAsideFile);
            ChartBridgeServer.Log("The Desk could not store " + n + " order event(s)" + (why.Success ? ", for example: " + why.Groups[1].Value : "") + "; " + kept + " kept in rejected_orders.jsonl with its reason");
        }
    }
}
