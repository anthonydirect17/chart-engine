// 0.6.9 (Anthony 2026-10-24, Phase 2 of his stats suite): the order record to The Desk (nt8/ChartBridgeOrderRecord.cs), through
// ChartBridge's own order event: every order type (market, limit, stop market, stop limit, MIT) and every change of its state, price,
// quantity and fills, one event a change, none for an update that changes nothing; the bid, ask and last price at submission and at a
// price change (and null with the reason when not known); the stop record (POST /api/stop-events) beside it exactly as in 0.6.6; the
// queue in pending_orders.jsonl and the post to a Desk of its own on 127.0.0.1 (taken, 404 kept, refused one at a time and set aside);
// the event thread's cost. Made-up accounts (SIM-R) and sample prices only.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript.AddOns;

public static class RecordHarness
{
    static Action<bool, string> Check;
    const BindingFlags PS = BindingFlags.NonPublic | BindingFlags.Static;
    static double clock = 1792590300000;   // a made-up time (UTC ms)
    static DateTime ntNow = new DateTime(2026, 10, 21, 9, 45, 0);   // NinjaTrader's clock (the stand-in zone)
    static string Pending { get { return Path.Combine(ChartBridgeConfig.Folder, "pending_orders.jsonl"); } }
    static string[] FileLines() { return File.Exists(Pending) ? File.ReadAllLines(Pending).Where(l => l.Trim().Length > 0).ToArray() : new string[0]; }
    static string[] Lines() { ChartBridgeOrderRecord.SaveNow(); return FileLines(); }   // as the 10 s timer does first
    static void Raw(Account a, OrderEventArgs e) { typeof(ChartBridgeServer).GetMethod("OnOrderUpdate", PS).Invoke(null, new object[] { a, e }); }
    static void Update(Account a, Order o) { Raw(a, Args(o)); }
    static OrderEventArgs Args(Order o) { return new OrderEventArgs { Order = o, OrderState = o.OrderState, StopPrice = o.StopPrice, LimitPrice = o.LimitPrice, Quantity = o.Quantity, Filled = o.Filled, AverageFillPrice = o.AverageFillPrice, Time = ntNow }; }
    static bool WaitFor(Func<bool> ok, int ms) { DateTime end = DateTime.UtcNow.AddMilliseconds(ms); while (DateTime.UtcNow < end) { if (ok()) return true; Thread.Sleep(50); } return ok(); }
    static string F(string json, string key) { Match m = Regex.Match(json, "\"" + key + "\":(\"[^\"]*\"|\\{[^}]*\\}|[^,}]*)"); return m.Success ? m.Groups[1].Value : "(none)"; }
    static Dictionary<string, Instrument> Named() { return (Dictionary<string, Instrument>)typeof(ChartBridgeServer).GetField("Instruments", PS).GetValue(null); }
    static void Quote(string root, double bid, double ask, DateTime at)
    {
        object tagger = typeof(ChartBridgeServer).GetMethod("SideTagger", PS).Invoke(null, new object[] { root });
        ((LiveSideTagger)tagger).NoteQuote(true, bid, at); ((LiveSideTagger)tagger).NoteQuote(false, ask, at);
    }

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        bool fillsWas = ChartBridgeConfig.PostFills;
        string deskWas = ChartBridgeConfig.DeskUrl;
        Func<double> nowWas = ChartBridgeOrderRecord.NowMs, stopsNowWas = ChartBridgeStops.NowMs;
        Dictionary<string, Instrument> namedWas = new Dictionary<string, Instrument>(Named());
        int deskPort = 20000 + new Random().Next(9000);
        ChartBridgeConfig.DeskUrl = "http://127.0.0.1:" + deskPort;   // nothing listens there yet: The Desk is down
        ChartBridgeOrderRecord.NowMs = () => clock; ChartBridgeStops.NowMs = () => clock;
        ChartBridgeOrderRecord.TimeoutMs = 3000;
        ChartBridgeServer.ClockForHarness = () => ntNow;
        Directory.CreateDirectory(ChartBridgeConfig.Folder);
        try { File.Delete(Pending); } catch (Exception) { }
        HttpListener desk = null;
        try
        {
            Instrument mnq = new Instrument { FullName = "MNQ 12-26", MasterInstrument = new MasterInstrument { Name = "MNQ", TickSize = 0.25, PointValue = 2 } };
            Instrument back = new Instrument { FullName = "MNQ 03-27", MasterInstrument = new MasterInstrument { Name = "MNQ", TickSize = 0.25, PointValue = 2 } };
            Named()["MNQ"] = mnq;
            Account sim = new Account { Name = "SIM-R" };

            // the switch: off with postFills off and no postOrders line; postOrders = true alone; postOrders = false wins; else postFills
            ChartBridgeConfig.PostFills = false; ChartBridgeOrderRecord.ResetConfig(); ChartBridgeStops.ResetConfig(); ChartBridgeOrderRecord.Clear(); ChartBridgeOrderRecord.Load();
            Order quiet = new Order { Account = sim, Instrument = mnq, OrderAction = OrderAction.Buy, OrderType = OrderType.Market, Quantity = 1, OrderId = "q1", OrderState = OrderState.Submitted };
            Update(sim, quiet);
            Check(!ChartBridgeOrderRecord.On && Lines().Length == 0, "order record: postFills off and no postOrders line: off, nothing queued");
            Check(ChartBridgeOrderRecord.ReadConfig("postOrders", "true") && ChartBridgeOrderRecord.On, "order record: postOrders = true turns it on with postFills off");
            ChartBridgeOrderRecord.ReadConfig("postOrders", "false"); ChartBridgeConfig.PostFills = true;
            Check(!ChartBridgeOrderRecord.On && !ChartBridgeOrderRecord.ReadConfig("postStops", "true"), "order record: postOrders = false wins over postFills; postStops is not its key");
            ChartBridgeOrderRecord.ResetConfig();
            Check(ChartBridgeOrderRecord.On && ChartBridgeStops.On, "order record: no postOrders line: it follows postFills (on), as the stop record does");
            ChartBridgeStops.Clear(); ChartBridgeStops.Load();
            int stopsWas = ChartBridgeStops.Waiting();

            // the quote ChartBridge knows: bid 24999.75, ask 25000, last 25000 (a trade 1 s ago)
            Quote("MNQ", 24999.75, 25000, ntNow.AddSeconds(-1));
            ChartBridgeOrders.NoteLast("MNQ", 25000);

            // a market entry: sent, accepted, filled
            Order mkt = new Order { Account = sim, Instrument = mnq, OrderAction = OrderAction.Buy, OrderType = OrderType.Market, Quantity = 2, OrderId = "m1", Name = "CB#0a1b2c3d s20 t40", OrderState = OrderState.Initialized };
            Update(sim, mkt);
            clock += 5; mkt.OrderState = OrderState.Submitted; Update(sim, mkt);
            clock += 5; Update(sim, mkt);   // nothing changed: no event
            clock += 30; mkt.OrderState = OrderState.Accepted; Update(sim, mkt);
            clock += 20; mkt.OrderState = OrderState.Filled; mkt.Filled = 2; mkt.AverageFillPrice = 25000.25; Update(sim, mkt);
            clock += 20; Update(sim, mkt);  // NinjaTrader repeats the final event: not a new one
            Check(FileLines().Length == 0 && ChartBridgeOrderRecord.Waiting() == 4, "order record: the order event only adds to the queue in memory (4 events; the file is written on the timer's send)");
            string[] q = Lines();
            string sentAt = q.Length > 0 ? q[0] : "";
            Check(q.Length == 4 && sentAt.StartsWith("{\"v\":1,\"source\":\"nt8\",\"account\":\"SIM-R\",\"instrument\":\"MNQ 12-26\",\"root\":\"MNQ\",\"order_id\":\"m1\",\"order_name\":\"CB#0a1b2c3d s20 t40\",\"oco\":null,\"side\":\"buy\",\"kind\":\"market\",\"nt_state\":\"Initialized\",\"state\":\"working\",\"limit_price\":null,\"stop_price\":null,\"qty\":2,\"filled\":0,\"avg_fill_price\":null,\"role\":\"entry\",\"by\":null,\"decision_id\":null,\"change\":\"new\",\"quote\":{\"bid\":24999.75,\"ask\":25000,\"last\":25000,\"why\":null},") &&
                  sentAt.EndsWith(",\"seq\":1,\"at_ms\":1792590300000}") && F(sentAt, "nt_time_ms") != "null",
                  "order record: a market entry at submission: every field, role entry, and the bid, ask and last ChartBridge knew then: " + sentAt);
            Check(q.Length == 4 && F(q[1], "change") == "\"state\"" && F(q[1], "quote") == "null" && F(q[2], "nt_state") == "\"Accepted\"" && F(q[3], "change") == "\"state,filled\"" && F(q[3], "filled") == "2" && F(q[3], "avg_fill_price") == "25000.25" && F(q[3], "state") == "\"filled\"",
                  "order record: each change once (state; state and fills with the average fill price); the quote only at submission: " + string.Join(" | ", q.Skip(1).Select(x => F(x, "nt_state") + " " + F(x, "change"))));

            // a limit, moved (a price change: the quote again), part filled, then cancelled
            clock += 1000;
            Order lim = new Order { Account = sim, Instrument = mnq, OrderAction = OrderAction.Sell, OrderType = OrderType.Limit, Quantity = 3, LimitPrice = 25010, OrderId = "l1", Name = "Target1", Oco = "oco-1", OrderState = OrderState.Submitted };
            Update(sim, lim);
            clock += 10; lim.OrderState = OrderState.Working; Update(sim, lim);
            Quote("MNQ", 25001, 25001.25, ntNow);
            clock += 4000; lim.LimitPrice = 25012; lim.OrderState = OrderState.ChangeSubmitted; Update(sim, lim);
            clock += 30; lim.OrderState = OrderState.Working; Update(sim, lim);
            clock += 30; lim.Filled = 1; lim.AverageFillPrice = 25012; lim.OrderState = OrderState.PartFilled; Update(sim, lim);
            clock += 30; lim.OrderState = OrderState.CancelSubmitted; Update(sim, lim);
            clock += 30; lim.OrderState = OrderState.Cancelled; Update(sim, lim);
            q = Lines().Skip(4).ToArray();
            Check(q.Length == 7 && F(q[0], "kind") == "\"limit\"" && F(q[0], "limit_price") == "25010" && F(q[0], "side") == "\"sell\"" && F(q[0], "oco") == "\"oco-1\"" && F(q[0], "role") == "\"other\"" &&
                  F(q[2], "change") == "\"state,price\"" && F(q[2], "limit_price") == "25012" && F(q[2], "quote") == "{\"bid\":25001,\"ask\":25001.25,\"last\":25000,\"why\":null}" &&
                  F(q[4], "change") == "\"state,filled\"" && F(q[4], "filled") == "1" && F(q[6], "state") == "\"cancelled\"",
                  "order record: a limit (an order typed in NinjaTrader: role other), its move with the quote at that moment, a part fill and the cancel: " + string.Join(" | ", q.Select(x => F(x, "nt_state") + " " + F(x, "change") + " " + F(x, "limit_price"))));

            // a stop market and a stop limit (a short's): the stop record (POST /api/stop-events) still gets exactly its 0.6.6 events
            Order stp = new Order { Account = sim, Instrument = mnq, OrderAction = OrderAction.Sell, OrderType = OrderType.StopMarket, Quantity = 2, StopPrice = 24980, OrderId = "s1", Name = "CB#0a1b2c3d stop f2 q2 p25000.25", OrderState = OrderState.Accepted };
            clock += 100; Update(sim, stp);
            clock += 3000; stp.StopPrice = 24994; stp.OrderState = OrderState.ChangeSubmitted; Update(sim, stp);
            Order sl = new Order { Account = sim, Instrument = mnq, OrderAction = OrderAction.BuyToCover, OrderType = OrderType.StopLimit, Quantity = 1, StopPrice = 25032.5, LimitPrice = 25033.5, OrderId = "b1", OrderState = OrderState.Working };
            clock += 100; Update(sim, sl);
            q = Lines().Skip(11).ToArray();
            Check(q.Length == 3 && F(q[0], "kind") == "\"stop\"" && F(q[0], "stop_price") == "24980" && F(q[0], "limit_price") == "null" && F(q[0], "role") == "\"stop\"" && F(q[1], "change") == "\"state,price\"" && F(q[1], "stop_price") == "24994" &&
                  F(q[2], "kind") == "\"stopLimit\"" && F(q[2], "side") == "\"buy\"" && F(q[2], "stop_price") == "25032.5" && F(q[2], "limit_price") == "25033.5",
                  "order record: a bracket stop (role stop) and its move; a short's buy stop limit with both prices: " + string.Join(" | ", q.Select(x => F(x, "kind") + " " + F(x, "stop_price") + " " + F(x, "limit_price"))));
            ChartBridgeStops.SaveIfDirty();
            string stopsFile = Path.Combine(ChartBridgeConfig.Folder, "pending_stops.jsonl");
            string[] st = File.Exists(stopsFile) ? File.ReadAllLines(stopsFile).Where(l => l.Trim().Length > 0).Skip(stopsWas).ToArray() : new string[0];
            string want0 = ChartBridgeStops.EventJson(sim, stp, "s1", OrderState.Accepted, 24980, 0, 2, 0, clock - 3100);
            Check(st.Length == 3 && st[0] == want0 && st[0].StartsWith("{\"source\":\"nt8\",\"account\":\"SIM-R\",\"instrument\":\"MNQ 12-26\",\"root\":\"MNQ\",\"order_id\":\"s1\",") && !st.Any(x => x.Contains("\"v\":")),
                  "stop-events unchanged: the stop record queued its 3 events exactly as 0.6.6 makes them (no market or limit order, none of the new fields): " + (st.Length > 0 ? st[0] : "none"));

            // MIT, a quantity change and a rejection; an order with no id yet; the bot's entry says by bot
            Order mit = new Order { Account = sim, Instrument = mnq, OrderAction = OrderAction.Buy, OrderType = OrderType.MIT, Quantity = 1, StopPrice = 24950, OrderState = OrderState.Working, Name = "CB#1b2c3d4e bot s8 t16" };
            clock += 100; Update(sim, mit);
            clock += 100; mit.Quantity = 2; Update(sim, mit);
            clock += 100; mit.OrderState = OrderState.Rejected; Update(sim, mit);
            q = Lines().Skip(14).ToArray();
            Check(q.Length == 3 && F(q[0], "kind") == "\"mit\"" && Regex.IsMatch(F(q[0], "order_id"), "^\"cb[0-9a-f]{6}-1\"$") && F(q[0], "by") == "\"bot\"" && F(q[0], "role") == "\"entry\"" &&
                  F(q[1], "change") == "\"qty\"" && F(q[1], "qty") == "2" && F(q[2], "state") == "\"rejected\"" && F(q[2], "order_id") == F(q[0], "order_id"),
                  "order record: an MIT with no id yet (cb, this start's nonce, a number; kept for the order's life), its quantity change and its rejection; the bot's entry: by bot: " + string.Join(" | ", q.Select(x => F(x, "order_id") + " " + F(x, "change") + " " + F(x, "by"))));

            // the quote not known: a contract ChartBridge does not serve, a quote gone stale, none yet
            Order other = new Order { Account = sim, Instrument = back, OrderAction = OrderAction.Buy, OrderType = OrderType.Limit, Quantity = 1, LimitPrice = 25100, OrderId = "x1", OrderState = OrderState.Submitted };
            clock += 100; Update(sim, other);
            ntNow = ntNow.AddMinutes(5);
            Order late = new Order { Account = sim, Instrument = mnq, OrderAction = OrderAction.Buy, OrderType = OrderType.Limit, Quantity = 1, LimitPrice = 24900, OrderId = "x2", OrderState = OrderState.Submitted };
            clock += 100; Update(sim, late);
            q = Lines().Skip(17).ToArray();
            Check(q.Length == 2 && F(q[0], "quote") == "{\"bid\":null,\"ask\":null,\"last\":null,\"why\":\"ChartBridge has no live data for MNQ 03-27 (it serves another contract or not this root)\"}",
                  "order record: a contract ChartBridge does not serve: the quote null with why: " + (q.Length > 0 ? F(q[0], "quote") : ""));
            Check(q.Length == 2 && F(q[1], "quote").StartsWith("{\"bid\":null,\"ask\":null,") && F(q[1], "quote").Contains("the bid is stale (300 s old); the ask is stale (300 s old)"),
                  "order record: a quote older than 60 s is not known (stale, said so; the last price by its own age): " + (q.Length > 1 ? F(q[1], "quote") : ""));

            // an order with no instrument yet: skipped (said once), taken once it has one
            Order bare = new Order { Account = sim, Instrument = new Instrument { FullName = "MNQ 12-26" }, OrderAction = OrderAction.Sell, OrderType = OrderType.Market, Quantity = 1, OrderId = "n1", OrderState = OrderState.Submitted };
            clock += 100; Update(sim, bare);
            Check(Lines().Length == 19, "order record: an order whose instrument has no master instrument is skipped");
            bare.Instrument = mnq; Update(sim, bare);
            Check(Lines().Length == 20, "order record: and taken once it has one");

            // The Desk down: the events wait (in the file too), /diag says why; a restart reads them back
            ChartBridgeOrderRecord.Flush();
            Check(WaitFor(() => ChartBridgeOrderRecord.DiagJson().Contains("\"lastSendFailed\":true"), 15000) && ChartBridgeOrderRecord.Waiting() == 20, "order record: The Desk down: 20 events wait: " + ChartBridgeOrderRecord.DiagJson());
            ChartBridgeOrderRecord.Load();
            Check(ChartBridgeOrderRecord.Waiting() == 20, "order record: a restart reads them back from pending_orders.jsonl");

            // today's Desk (no POST /api/order-events: 404): nothing lost, offered again later; then The Desk takes them, a bad one set aside
            List<string> got = new List<string>();
            bool hasRecord = false;
            desk = new HttpListener();
            desk.Prefixes.Add("http://127.0.0.1:" + deskPort + "/");
            desk.Start();
            HttpListener lsn = desk;
            Task.Run(() =>
            {
                while (lsn.IsListening)
                {
                    HttpListenerContext ctx;
                    try { ctx = lsn.GetContext(); } catch (Exception) { break; }
                    string body; using (StreamReader r = new StreamReader(ctx.Request.InputStream)) body = r.ReadToEnd();
                    lock (got) got.Add(ctx.Request.Url.AbsolutePath + " " + body);
                    if (!hasRecord || ctx.Request.Url.AbsolutePath != "/api/order-events") { ctx.Response.StatusCode = 404; ctx.Response.Close(); continue; }
                    bool bad = body.Contains("\"order_id\":\"bad\"");
                    byte[] ans = System.Text.Encoding.UTF8.GetBytes(bad ? "{\"detail\":\"bad\"}" : "{\"received\":1,\"rejected\":[],\"inserted\":1,\"duplicates\":0}");
                    ctx.Response.StatusCode = bad ? 400 : 200; ctx.Response.OutputStream.Write(ans, 0, ans.Length); ctx.Response.Close();
                }
            });
            ChartBridgeOrderRecord.NoDeskRetryMs = 1500;
            Check(WaitFor(() => { ChartBridgeOrderRecord.Flush(); return ChartBridgeOrderRecord.DiagJson().Contains("\"deskHasNoOrderRecord\":true"); }, 15000) && ChartBridgeOrderRecord.Waiting() == 20 &&
                  FileLines().Length == 20,
                  "order record: today's Desk answers 404: every event stays (memory and file), /diag says so: " + ChartBridgeOrderRecord.DiagJson());
            int posts = 0; lock (got) posts = got.Count;
            ChartBridgeOrderRecord.Flush(); Thread.Sleep(300);
            lock (got) Check(got.Count == posts, "order record: not offered again before the retry time (5 minutes in NinjaTrader)");
            clock += 100; mkt.OrderState = OrderState.Cancelled; Update(sim, mkt);   // still recorded meanwhile
            hasRecord = true;
            Thread.Sleep(1600);
            Check(WaitFor(() => { ChartBridgeOrderRecord.Flush(); return ChartBridgeOrderRecord.Waiting() == 0; }, 15000) && Lines().Length == 0 && ChartBridgeOrderRecord.DiagJson().Contains("\"deskHasNoOrderRecord\":false"),
                  "order record: once The Desk has the record, all 21 go and the file empties: " + ChartBridgeOrderRecord.DiagJson());
            lock (got) Check(got.Last().StartsWith("/api/order-events [{\"v\":1,\"source\":\"nt8\"") && got.Where(x => x.StartsWith("/api/order-events [")).Last().Split(new[] { "\"order_id\"" }, StringSplitOptions.None).Length - 1 == 21,
                             "order record: posted to POST /api/order-events as one JSON list");
            // a malformed one: one at a time, only it set aside
            File.Delete(Path.Combine(ChartBridgeConfig.Folder, "rejected_orders.jsonl"));
            typeof(ChartBridgeOrderRecord).GetMethod("Build", PS).Invoke(null, null);
            List<string> pl = (List<string>)typeof(ChartBridgeOrderRecord).GetField("PendingList", PS).GetValue(null);
            HashSet<string> ps = (HashSet<string>)typeof(ChartBridgeOrderRecord).GetField("PendingSet", PS).GetValue(null);
            foreach (string x in new[] { "{\"v\":1,\"source\":\"nt8\",\"order_id\":\"bad\",\"at_ms\":1}", "{\"v\":1,\"source\":\"nt8\",\"order_id\":\"good\",\"at_ms\":2}" }) lock (typeof(ChartBridgeOrderRecord).GetField("Sync", PS).GetValue(null)) { pl.Add(x); ps.Add(x); }
            string aside = Path.Combine(ChartBridgeConfig.Folder, "rejected_orders.jsonl");
            Check(WaitFor(() => { ChartBridgeOrderRecord.Flush(); return ChartBridgeOrderRecord.Waiting() == 0; }, 15000) && File.Exists(aside) && File.ReadAllText(aside).Contains("\"bad\"") && !File.ReadAllText(aside).Contains("\"good\""),
                  "order record: a batch The Desk calls malformed: one at a time, only the bad event set aside");

            // the event thread's cost: 20,000 order events through ChartBridge's own handler
            ChartBridgeOrderRecord.Clear();
            int n = 20000;
            List<Order> many = Enumerable.Range(0, n / 4).Select(i => new Order { Account = sim, Instrument = mnq, OrderAction = OrderAction.Buy, OrderType = OrderType.Limit, Quantity = 1, LimitPrice = 24900 + i % 40, OrderId = "p" + i, OrderState = OrderState.Submitted }).ToList();
            ChartBridgeOrderRecord.ResetConfig(); ChartBridgeOrderRecord.ReadConfig("postOrders", "false");
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            foreach (OrderState s in new[] { OrderState.Submitted, OrderState.Accepted, OrderState.Working, OrderState.Cancelled }) foreach (Order o in many) { o.OrderState = s; Update(sim, o); }
            double offMs = sw.Elapsed.TotalMilliseconds;
            foreach (Order o in many) o.OrderState = OrderState.Initialized;
            ChartBridgeOrderRecord.ResetConfig();
            sw.Restart();
            foreach (OrderState s in new[] { OrderState.Submitted, OrderState.Accepted, OrderState.Working, OrderState.Cancelled }) foreach (Order o in many) { o.OrderState = s; Update(sim, o); }
            double onMs = sw.Elapsed.TotalMilliseconds;
            double mean = ChartBridgeOrderRecord.ObserveMeanUs();
            Console.WriteLine("     (order record: " + n + " order events through OnOrderUpdate: " + Math.Round(offMs) + " ms with the record off, " + Math.Round(onMs) + " ms on; Observe alone " + Math.Round(mean, 2) + " us an event, mean)");
            Check(ChartBridgeOrderRecord.Waiting() == n && mean < 100, "order record: the event thread only enqueues: " + n + " events, Observe " + Math.Round(mean, 2) + " us an event (mean; under 100 us), no file, no network, no JSON there");
            Check(FileLines().Length == 0 || !File.Exists(Pending) || File.ReadAllLines(Pending).Length < n, "order record: nothing written on the event thread");
            Check(ChartBridgeOrderRecord.DiagJson().Contains("\"observeMeanUs\":"), "order record: /diag orderRecord gives the event thread's cost");
            ChartBridgeOrderRecord.Clear();
            ChartBridgeOrderRecord.Load();

            // the source: recording only
            string own = File.ReadAllText("ChartBridgeOrderRecord.cs");
            Check(!Regex.IsMatch(own, "\\.(Submit|Change|Cancel|Flatten|CreateOrder)\\("), "order record: ChartBridgeOrderRecord.cs never places, changes or cancels an order");
            string observe = own.Substring(own.IndexOf("public static void Observe("), own.IndexOf("private static string Px(") - own.IndexOf("public static void Observe("));
            Check(!Regex.IsMatch(observe, "File\\.|Flush\\(|Save|EventJson\\(|WebRequest"), "order record: Observe writes no file, sends nothing and makes no JSON (the timer does)");
            string src = File.ReadAllText("ChartBridge.cs");
            Check(src.Contains("try { ChartBridgeOrderRecord.Observe(a, e); } catch (Exception ex)") && src.Contains("try { ChartBridgeOrderRecord.Flush(); } catch (Exception) { }") && src.Contains("try { ChartBridgeOrderRecord.SaveNow(); } catch (Exception) { }") &&
                  src.IndexOf("ChartBridgeOrders.OnOrderUpdate(a, e)") < src.IndexOf("ChartBridgeOrderRecord.Observe(a, e)"), "order record: hooked after the order path in the order event, on the 10 s timer and at the stop");
        }
        finally
        {
            if (desk != null) { try { desk.Stop(); } catch (Exception) { } }
            ChartBridgeServer.ClockForHarness = null;
            Named().Clear(); foreach (KeyValuePair<string, Instrument> kv in namedWas) Named()[kv.Key] = kv.Value;
            ChartBridgeConfig.PostFills = fillsWas; ChartBridgeConfig.DeskUrl = deskWas; ChartBridgeOrderRecord.NowMs = nowWas; ChartBridgeStops.NowMs = stopsNowWas;
            ChartBridgeOrderRecord.TimeoutMs = 10000; ChartBridgeOrderRecord.NoDeskRetryMs = 300000;
            ChartBridgeOrderRecord.ResetConfig(); ChartBridgeOrderRecord.Clear(); ChartBridgeStops.ResetConfig(); ChartBridgeStops.Clear();
            try { File.Delete(Pending); File.Delete(Path.Combine(ChartBridgeConfig.Folder, "rejected_orders.jsonl")); File.Delete(Path.Combine(ChartBridgeConfig.Folder, "pending_stops.jsonl")); } catch (Exception) { }
            ChartBridgeOrderRecord.Load(); ChartBridgeStops.Load();
        }
    }
}
