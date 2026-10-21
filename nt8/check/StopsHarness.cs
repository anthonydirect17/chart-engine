// 0.6.6 (Anthony 2026-10-21): the stop record to The Desk (nt8/ChartBridgeStops.cs), through ChartBridge's own order event:
// the stop at send (price, contracts, time), each drag of it (a new price and its time) and how it ended, one event per change,
// none for an update that changes nothing, none for an order that is not a stop or has no price; the switch (postStops, else
// postFills); the queue in pending_stops.jsonl; the post to a Desk of its own on 127.0.0.1 (taken, refused one at a time and set
// aside, down and retried). Made-up accounts (SIM-S) and sample prices only.
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

public static class StopsHarness
{
    static Action<bool, string> Check;
    static double clock = 1792590300000;   // a made-up time (UTC ms)
    static string Pending { get { return Path.Combine(ChartBridgeConfig.Folder, "pending_stops.jsonl"); } }
    static string[] FileLines() { return File.Exists(Pending) ? File.ReadAllLines(Pending).Where(l => l.Trim().Length > 0).ToArray() : new string[0]; }
    static string[] Lines() { ChartBridgeStops.SaveIfDirty(); return FileLines(); }   // as the 10 s timer's send does first
    static void Update(Account a, Order o)
    {
        // ChartBridge's own handler for every watched account's order event (the hook in ChartBridge.cs), as NinjaTrader calls it
        MethodInfo m = typeof(ChartBridgeServer).GetMethod("OnOrderUpdate", BindingFlags.NonPublic | BindingFlags.Static);
        m.Invoke(null, new object[] { a, Args(o) });
    }
    // NinjaTrader's event carries the order's values as of that event
    static OrderEventArgs Args(Order o) { return new OrderEventArgs { Order = o, OrderState = o.OrderState, StopPrice = o.StopPrice, LimitPrice = o.LimitPrice, Quantity = o.Quantity, Filled = o.Filled }; }
    static void Raw(Account a, OrderEventArgs e) { typeof(ChartBridgeServer).GetMethod("OnOrderUpdate", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, new object[] { a, e }); }
    static bool WaitFor(Func<bool> ok, int ms) { DateTime end = DateTime.UtcNow.AddMilliseconds(ms); while (DateTime.UtcNow < end) { if (ok()) return true; Thread.Sleep(50); } return ok(); }
    static string Field(string json, string key) { Match m = Regex.Match(json, "\"" + key + "\":(\"[^\"]*\"|[^,}]*)"); return m.Success ? m.Groups[1].Value : "(none)"; }

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        bool fillsWas = ChartBridgeConfig.PostFills;
        string deskWas = ChartBridgeConfig.DeskUrl;
        Func<double> nowWas = ChartBridgeStops.NowMs;
        int deskPort = 20000 + new Random().Next(9000);
        ChartBridgeConfig.DeskUrl = "http://127.0.0.1:" + deskPort;   // nothing listens there yet: The Desk is down
        ChartBridgeStops.NowMs = () => clock;
        ChartBridgeStops.TimeoutMs = 3000;
        Directory.CreateDirectory(ChartBridgeConfig.Folder);
        try { File.Delete(Pending); } catch (Exception) { }
        HttpListener desk = null;
        try
        {
            Instrument mnq = new Instrument { FullName = "MNQ 12-26", MasterInstrument = new MasterInstrument { Name = "MNQ", TickSize = 0.25, PointValue = 2 } };
            Account sim = new Account { Name = "SIM-S" };

            // the switch: off with postFills off and no postStops line; postStops = true turns it on alone; postStops = false wins
            ChartBridgeConfig.PostFills = false; ChartBridgeStops.ResetConfig(); ChartBridgeStops.Clear(); ChartBridgeStops.Load();
            Order quiet = new Order { Account = sim, Instrument = mnq, OrderAction = OrderAction.Sell, OrderType = OrderType.StopMarket, Quantity = 2, StopPrice = 24980, OrderId = "q1", Name = "Stop1", OrderState = OrderState.Working };
            Update(sim, quiet);
            Check(!ChartBridgeStops.On && Lines().Length == 0, "stops: postFills off and no postStops line: off, nothing queued");
            Check(ChartBridgeStops.ReadConfig("postStops", "true") && ChartBridgeStops.On, "stops: postStops = true turns it on with postFills off");
            ChartBridgeStops.ReadConfig("postStops", "false"); ChartBridgeConfig.PostFills = true;
            Check(!ChartBridgeStops.On && !ChartBridgeStops.ReadConfig("postFills", "true"), "stops: postStops = false wins over postFills; other keys are not its");
            ChartBridgeStops.ResetConfig();
            Check(ChartBridgeStops.On, "stops: no postStops line: it follows postFills (on)");

            // Anthony's habit: the bracket stop goes in at 80 ticks (20 points) right after the fill, then he drags it to 24994
            Order stop = new Order { Account = sim, Instrument = mnq, OrderAction = OrderAction.Sell, OrderType = OrderType.StopMarket, Quantity = 2, StopPrice = 24980, OrderId = "s1", Oco = "oco-7", Name = "Stop1", OrderState = OrderState.Submitted };
            Update(sim, stop);
            clock += 40; stop.OrderState = OrderState.Accepted; Update(sim, stop);
            clock += 10; Update(sim, stop);                                             // nothing changed: no event
            clock += 10; stop.OrderState = OrderState.Working; Update(sim, stop);
            clock += 4000; stop.StopPrice = 24994; stop.OrderState = OrderState.ChangeSubmitted; Update(sim, stop);   // the drag
            clock += 60; stop.OrderState = OrderState.Working; Update(sim, stop);
            clock += 60; stop.OrderId = "s1-broker"; Update(sim, stop);               // NinjaTrader gives it a new id: still one order, no event
            Check(FileLines().Length == 0 && ChartBridgeStops.Waiting() == 5, "stops (review of b4bc612): the order event only adds to the queue in memory; the file is written on the timer's send");
            string[] q = Lines();
            Check(q.Length == 5, "stops: one event per change of state, price, quantity or fills (5), none for an update that changes nothing: " + q.Length);
            Check(q.Length == 5 && q[0].StartsWith("{\"source\":\"nt8\",\"account\":\"SIM-S\",\"instrument\":\"MNQ 12-26\",\"root\":\"MNQ\",\"order_id\":\"s1\",\"order_name\":\"Stop1\",\"side\":\"sell\",\"kind\":\"stop\",\"nt_state\":\"Submitted\",\"state\":\"working\",\"stop_price\":24980,\"limit_price\":null,\"qty\":2,\"filled\":0,\"oco\":\"oco-7\",\"role\":\"other\"") &&
                  q[0].EndsWith(",\"at_ms\":1792590300000}"), "stops: at send: the stop price, contracts, side, its OCO and the time ChartBridge saw it, in The Desk's shape: " + (q.Length > 0 ? q[0] : ""));
            Check(q.Length == 5 && Field(q[3], "stop_price") == "24994" && Field(q[3], "nt_state") == "\"ChangeSubmitted\"" && Field(q[3], "at_ms") == "1792590304060" && Field(q[4], "order_id") == "\"s1\"",
                  "stops: the drag: the new price and when it was seen; the order keeps the id it was first seen with: " + string.Join(" | ", q.Skip(3)));
            clock += 600000; stop.Filled = 2; stop.AverageFillPrice = 24994; stop.OrderState = OrderState.Filled; Update(sim, stop);
            q = Lines();
            Check(q.Length == 6 && Field(q[5], "state") == "\"filled\"" && Field(q[5], "filled") == "2", "stops: how it ended (filled 2)");
            clock += 100; Update(sim, stop);
            Check(Lines().Length == 6, "stops (review of b4bc612): its end again (NinjaTrader repeats a final event) is not a new event");
            // the event's own values, never the live order's (NinjaTrader may have moved on since)
            Order ev = new Order { Account = sim, Instrument = mnq, OrderAction = OrderAction.Sell, OrderType = OrderType.StopMarket, Quantity = 1, StopPrice = 24999, OrderId = "v1", OrderState = OrderState.Working };
            clock += 100; Raw(sim, new OrderEventArgs { Order = ev, OrderState = OrderState.Accepted, StopPrice = 24977, Quantity = 1, Filled = 0 });
            q = Lines();
            Check(q.Length == 7 && Field(q[6], "stop_price") == "24977" && Field(q[6], "nt_state") == "\"Accepted\"", "stops (review of b4bc612): the event's own state and price are sent: " + (q.Length > 6 ? q[6] : ""));
            // an order with no instrument yet: skipped (said once), and taken when it has one
            Order bare = new Order { Account = sim, Instrument = new Instrument { FullName = "MNQ 12-26" }, OrderAction = OrderAction.Sell, OrderType = OrderType.StopMarket, Quantity = 1, StopPrice = 24950, OrderId = "n1", OrderState = OrderState.Working };
            clock += 100; Update(sim, bare);
            Check(Lines().Length == 7, "stops (review of b4bc612): a stop whose instrument has no master instrument is skipped");
            bare.Instrument = mnq; Update(sim, bare);
            Check(Lines().Length == 8, "stops: the same order once it has its instrument is taken (nothing was remembered for it before)");

            // not a stop, no price: nothing; a stop limit and a short's buy stop: their own fields
            Order limit = new Order { Account = sim, Instrument = mnq, OrderAction = OrderAction.Sell, OrderType = OrderType.Limit, Quantity = 1, LimitPrice = 25040, OrderId = "t1", Name = "Target1", OrderState = OrderState.Working };
            Order noPrice = new Order { Account = sim, Instrument = mnq, OrderAction = OrderAction.Sell, OrderType = OrderType.StopMarket, Quantity = 1, StopPrice = 0, OrderId = "z1", OrderState = OrderState.Initialized };
            Update(sim, limit); Update(sim, noPrice);
            Check(Lines().Length == 8, "stops: a target (limit) and a stop with no price yet send nothing");
            Order sl = new Order { Account = sim, Instrument = mnq, OrderAction = OrderAction.BuyToCover, OrderType = OrderType.StopLimit, Quantity = 1, StopPrice = 25032.5, LimitPrice = 25033.5, OrderId = "b1", OrderState = OrderState.Working };
            Update(sim, sl);
            q = Lines();
            Check(q.Length == 9 && Field(q[8], "side") == "\"buy\"" && Field(q[8], "kind") == "\"stopLimit\"" && Field(q[8], "limit_price") == "25033.5" && Field(q[8], "order_name") == "null",
                  "stops: a short's buy stop limit: side, kind and its limit price: " + (q.Length > 8 ? q[8] : ""));

            // The Desk down: the events wait (in the file too), /diag says why
            ChartBridgeStops.Flush();
            Check(WaitFor(() => ChartBridgeStops.DiagJson().Contains("\"lastSendFailed\":true"), 15000) && ChartBridgeStops.Waiting() == 9,
                  "stops: The Desk down: 9 events wait, /diag shows the failure: " + ChartBridgeStops.DiagJson());
            ChartBridgeStops.Load();
            Check(ChartBridgeStops.Waiting() == 9, "stops: a restart reads them back from pending_stops.jsonl");

            // The Desk up: the batch is taken; a malformed one is found one at a time and set aside
            List<string> got = new List<string>();
            desk = new HttpListener();
            desk.Prefixes.Add("http://127.0.0.1:" + deskPort + "/");
            desk.Start();
            HttpListener l = desk;
            Task.Run(() =>
            {
                while (l.IsListening)
                {
                    HttpListenerContext ctx;
                    try { ctx = l.GetContext(); } catch (Exception) { break; }
                    string body; using (StreamReader r = new StreamReader(ctx.Request.InputStream)) body = r.ReadToEnd();
                    lock (got) got.Add(ctx.Request.Url.AbsolutePath + " " + body);
                    bool bad = body.Contains("\"order_id\":\"bad\"");
                    byte[] ans = System.Text.Encoding.UTF8.GetBytes(bad ? "{\"detail\":\"bad\"}" : "{\"received\":1,\"rejected\":[],\"inserted\":1,\"duplicates\":0}");
                    ctx.Response.StatusCode = bad ? 400 : 200; ctx.Response.OutputStream.Write(ans, 0, ans.Length); ctx.Response.Close();
                }
            });
            // as ChartBridge's 10 s timer does: Flush again until taken (a send still failing against the Desk that was down is let finish)
            Check(WaitFor(() => { ChartBridgeStops.Flush(); return ChartBridgeStops.Waiting() == 0; }, 15000) && Lines().Length == 0, "stops: The Desk up: every waiting event is taken and the file emptied");
            lock (got) Check(got.Count >= 1 && got[0].StartsWith("/api/stop-events [{\"source\":\"nt8\"") && got.Sum(x => Regex.Matches(x, "\"order_id\"").Count) == 9,
                             "stops: posted to POST /api/stop-events as one JSON list: " + (got.Count > 0 ? got[0].Substring(0, Math.Min(80, got[0].Length)) : "none"));
            Check(ChartBridgeStops.DiagJson().Contains("\"lastSendFailed\":false") && ChartBridgeStops.DiagJson().Contains("\"sent\":9"), "stops: /diag after: " + ChartBridgeStops.DiagJson());
            ChartBridgeStops.Queue("{\"source\":\"nt8\",\"order_id\":\"bad\"}");
            ChartBridgeStops.Queue("{\"source\":\"nt8\",\"order_id\":\"good\"}");
            string aside = Path.Combine(ChartBridgeConfig.Folder, "rejected_stops.jsonl");
            Check(WaitFor(() => { ChartBridgeStops.Flush(); return ChartBridgeStops.Waiting() == 0; }, 15000) && File.Exists(aside) && File.ReadAllText(aside).Contains("\"bad\"") && !File.ReadAllText(aside).Contains("\"good\"") &&
                  ChartBridgeStops.DiagJson().Contains("\"setAside\":1"), "stops: a batch The Desk calls malformed: one at a time, only the bad event set aside, the good one taken");

            // the cap: past it the oldest go, counted in /diag and said once
            int capWas = ChartBridgeStops.Cap;
            ChartBridgeStops.Cap = 3;
            for (int i = 0; i < 5; i++) ChartBridgeStops.Queue("{\"source\":\"nt8\",\"order_id\":\"cap" + i + "\"}");
            string[] capped = Lines();
            ChartBridgeStops.Cap = capWas;
            Check(capped.Length == 3 && capped[0].Contains("cap2") && ChartBridgeStops.DiagJson().Contains("\"dropped\":2"), "stops (review of b4bc612): at most Cap events wait; the oldest are dropped and counted: " + ChartBridgeStops.DiagJson());
            Check(WaitFor(() => { ChartBridgeStops.Flush(); return ChartBridgeStops.Waiting() == 0; }, 15000), "stops: the capped queue is sent");
            // an older Desk (404): no stop record there: nothing more is queued or sent until the next start, said in /diag
            desk.Stop(); desk = null;
            HttpListener old = new HttpListener();
            old.Prefixes.Add("http://127.0.0.1:" + deskPort + "/");
            old.Start();
            Task.Run(() => { while (old.IsListening) { HttpListenerContext ctx; try { ctx = old.GetContext(); } catch (Exception) { break; } ctx.Response.StatusCode = 404; ctx.Response.Close(); } });
            try
            {
                ChartBridgeStops.Queue("{\"source\":\"nt8\",\"order_id\":\"old1\"}");
                Check(WaitFor(() => { ChartBridgeStops.Flush(); return ChartBridgeStops.DiagJson().Contains("\"deskHasNoStopRecord\":true"); }, 15000) && ChartBridgeStops.Waiting() == 1,
                      "stops (review of b4bc612): The Desk answers 404: it has no stop record, the event stays, /diag says so: " + ChartBridgeStops.DiagJson());
                Order late = new Order { Account = sim, Instrument = mnq, OrderAction = OrderAction.Sell, OrderType = OrderType.StopMarket, Quantity = 1, StopPrice = 24940, OrderId = "late1", OrderState = OrderState.Working };
                Update(sim, late);
                Check(ChartBridgeStops.Waiting() == 1, "stops: after the 404 nothing more is queued");
            }
            finally { old.Stop(); }
            ChartBridgeStops.Load();
            Check(ChartBridgeStops.DiagJson().Contains("\"deskHasNoStopRecord\":false"), "stops: the next start asks The Desk again");

            // the source: the hook sits in ChartBridge's own order event, after the order path, and never throws into NinjaTrader
            string src = File.ReadAllText(Path.Combine("ChartBridge.cs"));
            Check(src.Contains("try { ChartBridgeStops.Observe(a, e); } catch (Exception ex)") && src.Contains("try { ChartBridgeStops.SaveIfDirty(); } catch (Exception) { }") && src.Contains("try { ChartBridgeStops.Flush(); } catch (Exception) { }") &&
                  src.Contains(".Append(ChartBridgeStops.DiagJson())"), "stops: hooked into the order event, the 10 s timer and /diag");
            string own = File.ReadAllText(Path.Combine("ChartBridgeStops.cs"));
            Check(!Regex.IsMatch(own, "\\.(Submit|Change|Cancel|Flatten|CreateOrder)\\("), "stops: ChartBridgeStops.cs never places, changes or cancels an order");
        }
        finally
        {
            if (desk != null) { try { desk.Stop(); } catch (Exception) { } }
            ChartBridgeConfig.PostFills = fillsWas; ChartBridgeConfig.DeskUrl = deskWas; ChartBridgeStops.NowMs = nowWas; ChartBridgeStops.TimeoutMs = 10000;
            ChartBridgeStops.ResetConfig(); ChartBridgeStops.Clear();
            try { File.Delete(Pending); File.Delete(Path.Combine(ChartBridgeConfig.Folder, "rejected_stops.jsonl")); } catch (Exception) { }
            ChartBridgeStops.Load();
        }
    }
}
