// ChartBridge's stop record to The Desk (ChartBridge 0.6.6, Anthony 2026-10-21: "the stop record, measured, never guessed").
// Part of the ChartBridge add-on; install it with the other files. See nt8/PROTOCOL.md, "The stop record to The Desk (0.6.6)".
//
// Every order update on a watched account already comes through ChartBridgeServer.OnOrderUpdate. For a stop order (stop market
// or stop limit, whoever placed it: the page, NinjaTrader's own chart or ATM, the bot, an agent, the copier) this file notes what
// NinjaTrader says now: its state, the stop price, the quantity and the filled count. Each time one of those changes it queues one
// event for The Desk's POST /api/stop-events, with the time ChartBridge saw it. So The Desk gets the stop price at send, every
// stop modify (the new price and when), the contracts, and how the stop ended; the fill and the exit are the fills it already has.
// Nothing is estimated: a price NinjaTrader does not give (0 or less) sends nothing.
//
// The queue follows the fills' rules (ChartBridgeDesk): events wait in pending_stops.jsonl next to config.txt (replaced
// atomically) until The Desk answers; a request gets 10 seconds and is retried every 10 seconds; a batch The Desk calls malformed
// (400 or 422) is sent one event at a time and a single bad one is set aside in rejected_stops.jsonl. The Desk stores each event
// once (the same order, time, state, price, quantity and fills), so a resend is safe.
//
// On when config.txt has postStops = true, or, with no postStops line, whenever postFills = true (the stop record goes where the
// fills go). This file never places, changes or cancels an order. Written in C# 5 syntax (NinjaTrader 8 compiles NinjaScript as C# 5).
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
    // ---------------------------------------------------------------- the stop record's window into ChartBridgeOrders (read only)
    public static partial class ChartBridgeOrders
    {
        // entry, stop, target or other: what ChartBridge calls this order on its pages (The Desk takes these four only)
        internal static string StopRecordRole(Order o)
        {
            string r = RoleFor(o);
            return r == "entry" || r == "stop" || r == "target" ? r : "other";
        }
        internal static string StopRecordState(OrderState s) { return StateText(s); }
    }

    public static class ChartBridgeStops
    {
        private static bool? postStops;                      // config.txt postStops; null: follow postFills
        public static bool On { get { return postStops.HasValue ? postStops.Value : ChartBridgeConfig.PostFills; } }
        public static Func<double> NowMs = ChartBridgeTime.NowUtcMs;   // the harness sets its own clock

        public static void ResetConfig() { postStops = null; }
        public static bool ReadConfig(string key, string val)
        {
            if (key != "postStops") return false;
            postStops = val.Equals("true", StringComparison.OrdinalIgnoreCase) || val == "1";
            return true;
        }

        // ---------------------------------------------------------- what was seen
        private static readonly object Seen = new object();
        private static readonly Dictionary<Order, string> LastKey = new Dictionary<Order, string>();   // what was last queued for it (its end too: a repeat is dropped)
        private static readonly Dictionary<Order, string> FirstId = new Dictionary<Order, string>();   // its id as first seen (kept: an id NinjaTrader changes later stays one order)
        private static readonly HashSet<Order> Ended = new HashSet<Order>();                           // orders whose end was queued (forgotten past MaxEnded)
        private const int MaxEnded = 20000;
        private static readonly Regex ByRx = new Regex("^(page|bot|copier|agent:[a-z][a-z0-9]{0,11})$");
        private static long seq, observed, queuedEvents;
        private static bool noInstrumentSaid;

        public static void Clear() { lock (Seen) { LastKey.Clear(); FirstId.Clear(); Ended.Clear(); } }

        private static bool IsDone(OrderState s) { return s == OrderState.Filled || s == OrderState.Cancelled || s == OrderState.Rejected; }

        // One order update (ChartBridgeServer.OnOrderUpdate, every watched account), on NinjaTrader's event thread: it only adds to the
        // queue in memory (no file, no network here; the 10 s timer saves and sends). The values are this event's (e), not the order's
        // live fields. Never throws into NinjaTrader's event.
        public static void Observe(Account a, OrderEventArgs e)
        {
            if (!On || a == null || e == null || e.Order == null || deskHasNone) return;
            Order o = e.Order;
            if (o.OrderType != OrderType.StopMarket && o.OrderType != OrderType.StopLimit) return;
            double px = e.StopPrice;
            OrderState st = e.OrderState;
            int qty = e.Quantity, filled = e.Filled;
            if (!(px > 0) || qty <= 0 || double.IsNaN(px) || double.IsInfinity(px)) return;
            if (o.Instrument == null || o.Instrument.MasterInstrument == null)
            {
                if (!noInstrumentSaid) { noInstrumentSaid = true; ChartBridgeServer.Log("stop record: a stop order on " + (a.Name ?? "?") + " has no instrument yet; it is skipped (said once)"); }
                return;
            }
            Interlocked.Increment(ref observed);
            string key = st.ToString() + "|" + px.ToString("R", CultureInfo.InvariantCulture) + "|" + qty + "|" + filled;
            string id;
            lock (Seen)
            {
                string was;
                if (LastKey.TryGetValue(o, out was) && was == key) return;   // nothing changed, or its end again
                if (!FirstId.TryGetValue(o, out id))
                {
                    id = string.IsNullOrEmpty(o.OrderId) ? "cb" + Interlocked.Increment(ref seq).ToString(CultureInfo.InvariantCulture) : o.OrderId;
                    FirstId[o] = id;
                }
                LastKey[o] = key;
                if (IsDone(st))
                {
                    Ended.Add(o);
                    if (Ended.Count > MaxEnded) { foreach (Order x in Ended) { LastKey.Remove(x); FirstId.Remove(x); } Ended.Clear(); }
                }
            }
            double lp = o.OrderType == OrderType.StopLimit ? e.LimitPrice : 0;
            Queue(EventJson(a, o, id, st, px, lp, qty, filled, NowMs()));
        }

        public static string EventJson(Account a, Order o, string id, OrderState st, double stopPx, double limitPx, int qty, int filled, double atMs)
        {
            Instrument inst = o.Instrument;
            string by = null;
            try { by = ChartBridgeV3.SourceOf(o); } catch (Exception) { by = null; }
            if (by != null && !ByRx.IsMatch(by)) by = null;
            string name = o.Name ?? "";
            StringBuilder b = new StringBuilder("{\"source\":\"nt8\"");
            b.Append(",\"account\":").Append(CbJson.Str(a.Name ?? ""))
             .Append(",\"instrument\":").Append(CbJson.Str(inst.FullName ?? ""))
             .Append(",\"root\":").Append(CbJson.Str(inst.MasterInstrument.Name ?? ""))
             .Append(",\"order_id\":").Append(CbJson.Str(id.Length > 64 ? id.Substring(0, 64) : id))
             .Append(",\"order_name\":").Append(name.Length == 0 ? "null" : CbJson.Str(name.Length > 64 ? name.Substring(0, 64) : name))
             .Append(",\"side\":").Append(CbJson.Str(ChartBridgeOrders.GroupIsBuy(o) ? "buy" : "sell"))
             .Append(",\"kind\":").Append(CbJson.Str(o.OrderType == OrderType.StopLimit ? "stopLimit" : "stop"))
             .Append(",\"nt_state\":").Append(CbJson.Str(st.ToString()))
             .Append(",\"state\":").Append(CbJson.Str(ChartBridgeOrders.StopRecordState(st)))
             .Append(",\"stop_price\":").Append(CbJson.Num(stopPx))
             .Append(",\"limit_price\":").Append(limitPx > 0 ? CbJson.Num(limitPx) : "null")
             .Append(",\"qty\":").Append(qty.ToString(CultureInfo.InvariantCulture))
             .Append(",\"filled\":").Append(Math.Max(0, Math.Min(filled, qty)).ToString(CultureInfo.InvariantCulture))
             .Append(",\"oco\":").Append(string.IsNullOrEmpty(o.Oco) ? "null" : CbJson.Str(o.Oco.Length > 64 ? o.Oco.Substring(0, 64) : o.Oco))
             .Append(",\"role\":").Append(CbJson.Str(ChartBridgeOrders.StopRecordRole(o)));
            if (by != null) b.Append(",\"by\":").Append(CbJson.Str(by));
            b.Append(",\"at_ms\":").Append(Math.Round(atMs).ToString(CultureInfo.InvariantCulture)).Append('}');
            return b.ToString();
        }

        // ---------------------------------------------------------- the queue (the fills' rules)
        private static readonly object Sync = new object();
        private static readonly List<string> PendingList = new List<string>();
        private static readonly HashSet<string> PendingSet = new HashSet<string>();
        private static readonly Regex RejectedRx = new Regex("\"rejected\"\\s*:\\s*\\[(.*?)\\]\\s*[,}]", RegexOptions.Singleline);
        private static readonly Regex ReasonRx = new Regex("\"reason\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        private const int FullBatch = 500;
        public static int TimeoutMs = 10000;
        private static int sending, batchSize = FullBatch;
        private static bool lastFailed, dirty, droppedSaid;
        private static volatile bool deskHasNone;   // The Desk answered 404: it has no stop record (an older Desk); nothing more is queued this start
        public static int Cap = 20000;               // events kept waiting at most; past it the oldest go (counted, said once)
        private static long dropped;
        private static string lastError = "";
        private static long setAside, rejectedByDesk, sent;
        private static string File_ { get { return Path.Combine(ChartBridgeConfig.Folder, "pending_stops.jsonl"); } }
        private static string SetAsideFile { get { return Path.Combine(ChartBridgeConfig.Folder, "rejected_stops.jsonl"); } }

        private static bool LooksWhole(string line) { return line.StartsWith("{") && line.EndsWith("}") && line.Contains("\"order_id\":"); }

        public static void Load()
        {
            deskHasNone = false;
            lock (Sync)
            {
                PendingList.Clear(); PendingSet.Clear(); dirty = false;
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
                catch (Exception ex) { ChartBridgeServer.Log("could not read pending stop events: " + ex.Message); }
                if (bad > 0) ChartBridgeServer.Log("skipped " + bad + " unreadable line(s) in pending_stops.jsonl");
            }
        }

        private static void Save()
        {
            try
            {
                string tmp = File_ + ".tmp";
                File.WriteAllLines(tmp, PendingList.ToArray());
                if (File.Exists(File_)) File.Replace(tmp, File_, null); else File.Move(tmp, File_);
            }
            catch (Exception ex) { ChartBridgeServer.Log("could not save pending stop events: " + ex.Message); }
        }

        // In memory only (the event thread): the file is written by SaveIfDirty on the timer's send, and at the stop.
        public static void Queue(string json)
        {
            bool sayDrop = false;
            lock (Sync)
            {
                if (!PendingSet.Add(json)) return;
                PendingList.Add(json); Interlocked.Increment(ref queuedEvents); dirty = true;
                while (PendingList.Count > Cap) { PendingSet.Remove(PendingList[0]); PendingList.RemoveAt(0); dropped++; if (!droppedSaid) { droppedSaid = true; sayDrop = true; } }
            }
            if (sayDrop) ChartBridgeServer.Log("stop record: more than " + Cap + " stop events wait for The Desk; the oldest are dropped (counted in /diag stops.dropped; said once)");
        }

        // pending_stops.jsonl as the queue is now, when it changed (never on NinjaTrader's event thread).
        public static void SaveIfDirty() { lock (Sync) { if (!dirty) return; dirty = false; Save(); } }

        public static int Waiting() { lock (Sync) return PendingList.Count; }

        public static string DiagJson()
        {
            long d; lock (Sync) d = dropped;
            return "{\"on\":" + (On ? "true" : "false") + ",\"deskHasNoStopRecord\":" + (deskHasNone ? "true" : "false") + ",\"dropped\":" + d + ",\"waiting\":" + Waiting() + ",\"seen\":" + Interlocked.Read(ref observed) +
                ",\"queued\":" + Interlocked.Read(ref queuedEvents) + ",\"sent\":" + Interlocked.Read(ref sent) +
                ",\"lastSendFailed\":" + (lastFailed ? "true" : "false") + ",\"lastError\":" + CbJson.Str(lastError) +
                ",\"setAside\":" + Interlocked.Read(ref setAside) + ",\"rejectedByDesk\":" + Interlocked.Read(ref rejectedByDesk) + "}";
        }

        private static void Remove(string[] batch)
        {
            lock (Sync)
            {
                PendingList.RemoveRange(0, Math.Min(batch.Length, PendingList.Count));   // the queue only grows at the end
                foreach (string f in batch) PendingSet.Remove(f);
                dirty = true;
            }
        }

        private static async Task<WebResponse> Post(HttpWebRequest req, byte[] bytes)
        {
            using (Stream s = await req.GetRequestStreamAsync()) await s.WriteAsync(bytes, 0, bytes.Length);
            return await req.GetResponseAsync();
        }

        // The timer's send (every 10 s, never NinjaTrader's event thread): saves the queue, then posts the oldest batch.
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
                    SaveIfDirty();
                    if (deskHasNone) return;
                    lock (Sync) batch = PendingList.Take(batchSize).ToArray();
                    if (batch.Length == 0) return;
                    byte[] bytes = Encoding.UTF8.GetBytes("[" + string.Join(",", batch) + "]");
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(ChartBridgeConfig.DeskUrl + "/api/stop-events");
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
                    Remove(batch);
                    SaveIfDirty();
                    Interlocked.Add(ref sent, batch.Length);
                    if (batch.Length > 1) batchSize = FullBatch;
                    NoteRejected(text);
                    lock (Sync) more = PendingList.Count > 0;
                    if (lastFailed) { ChartBridgeServer.Log("The Desk is taking stop events again."); lastFailed = false; }
                    lastError = "";
                }
                catch (WebException wex)
                {
                    HttpWebResponse res = wex.Response as HttpWebResponse;
                    int code = res != null ? (int)res.StatusCode : 0;
                    if (code == 404)
                    {
                        // an older Desk with no POST /api/stop-events: stop queueing until the next start (the waiting events stay in the file)
                        if (!deskHasNone) ChartBridgeServer.Log("The Desk has no stop record (POST /api/stop-events answered 404): no stop events are sent or queued until ChartBridge starts again; " + Waiting() + " stay in pending_stops.jsonl");
                        deskHasNone = true;
                        lastError = "The Desk has no stop record (404)";
                    }
                    else if (code == 400 || code == 422)
                    {
                        if (batch.Length > 1) batchSize = 1;   // find the bad one: one at a time
                        else
                        {
                            try { File.AppendAllLines(SetAsideFile, batch); } catch (Exception) { }
                            Remove(batch);
                            SaveIfDirty();
                            batchSize = FullBatch;
                            Interlocked.Increment(ref setAside);
                            ChartBridgeServer.Log("The Desk refused a stop event (" + code + "); it was set aside in rejected_stops.jsonl");
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
            if (!lastFailed) ChartBridgeServer.Log("The Desk did not take stop events (" + message + "); they are saved and will be retried every 10 seconds.");
            lastFailed = true;
        }

        private static void NoteRejected(string text)
        {
            Match m = RejectedRx.Match(text ?? "");
            if (!m.Success || m.Groups[1].Value.Trim().Length == 0) return;
            int n = Regex.Matches(m.Groups[1].Value, "\"index\"").Count;
            if (n == 0) return;
            Interlocked.Add(ref rejectedByDesk, n);
            Match why = ReasonRx.Match(m.Groups[1].Value);
            ChartBridgeServer.Log("The Desk could not store " + n + " stop event(s)" + (why.Success ? ", for example: " + why.Groups[1].Value : ""));
        }
    }
}
