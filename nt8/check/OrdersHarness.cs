// Runs the real ChartBridgeOrders.cs against the stand-in NinjaTrader types and checks every gate,
// the bracket logic and the messages. Linux with mono: sh nt8/check/orders.sh (npm run check:orders).
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript.AddOns;

public static class OrdersHarness
{
    static int fails;
    static List<string> sent = new List<string>();
    static void Check(bool ok, string what) { Console.WriteLine((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; }
    static string LastSent() { return sent.Count > 0 ? sent[sent.Count - 1] : ""; }
    static bool Rejected(string contains) { string m = LastSent(); return m.Contains("\"type\":\"reject\"") && m.Contains(contains); }
    static void Msg(ChartBridgeClient c, string type, string json) { ChartBridgeOrders.OnMessage(c, type, json); }

    public static int Main()
    {
        Instrument mnq = new Instrument { FullName = "MNQ 12-26", MasterInstrument = new MasterInstrument { Name = "MNQ", TickSize = 0.25, PointValue = 2 } };
        FieldInfo f = typeof(ChartBridgeServer).GetField("Instruments", BindingFlags.NonPublic | BindingFlags.Static);
        ((Dictionary<string, Instrument>)f.GetValue(null))["MNQ"] = mnq;
        Account sim = new Account { Name = "Sim101" }, eval = new Account { Name = "DEMO-EVAL" }, other = new Account { Name = "OTHER-ACC" }, play = new Account { Name = "Playback101" };
        Account.All.AddRange(new[] { sim, eval, other, play });
        ChartBridgeOrders.NewToken();
        string token = ChartBridgeOrders.SessionJson().Split('"')[3];

        ChartBridgeClient c = new ChartBridgeClient(null, 1);
        c.Tap = s => sent.Add(s);
        c.Origin = "http://localhost:8765";
        FieldInfo cf = typeof(ChartBridgeServer).GetField("Clients", BindingFlags.NonPublic | BindingFlags.Static);
        ((System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient>)cf.GetValue(null))[1] = c;

        // gate 1: off by default
        ChartBridgeOrders.ResetConfig();
        Msg(c, "auth", "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
        Check(LastSent().Contains("\"enabled\":false") && LastSent().Contains("trading is off"), "trading off by default: auth refused");
        Msg(c, "order", "{\"type\":\"order\",\"cid\":\"c0\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1}");
        Check(Rejected("trading is off") && sim.Calls.Count == 0, "trading off: order refused, nothing sent to NinjaTrader");

        ChartBridgeOrders.ReadConfig("trading", "true");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, DEMO-EVAL, Playback101, LFE*");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "2");
        Check(ChartBridgeOrders.TradeAccounts.SequenceEqual(new[] { "Sim101", "DEMO-EVAL" }), "tradeAccounts drops Playback and wildcards");

        // gate 4: origin and token
        ChartBridgeClient evil = new ChartBridgeClient(null, 2); evil.Tap = s => sent.Add(s); evil.Origin = "https://evil.example";
        Msg(evil, "auth", "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
        Check(LastSent().Contains("\"enabled\":false") && LastSent().Contains("own page"), "other origin: auth refused even with the right token");
        Msg(evil, "order", "{\"type\":\"order\",\"cid\":\"e1\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1}");
        Check(Rejected("may not trade") && sim.Calls.Count == 0, "other origin: order refused");
        Msg(c, "auth", "{\"type\":\"auth\",\"token\":\"wrong\"}");
        Check(LastSent().Contains("token does not match") && !c.Trader, "wrong token: refused");
        Msg(c, "order", "{\"type\":\"order\",\"cid\":\"c1\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1}");
        Check(Rejected("may not trade") && sim.Calls.Count == 0, "not signed in: order refused");
        sent.Clear();
        Msg(c, "auth", "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
        Check(c.Trader && sent[0].Contains("\"enabled\":true") && sent[0].Contains("\"Sim101\"") && sent[0].Contains("\"MNQ\":2"), "right origin and token: trading on, accounts and caps sent");
        Check(sent.Count >= 2 && sent[1].Contains("\"type\":\"orders\""), "orders snapshot after auth");

        // gates 2, 3, 5, 6
        Msg(c, "order", "{\"type\":\"order\",\"cid\":\"c2\",\"account\":\"OTHER-ACC\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1}");
        Check(Rejected("OTHER-ACC may not trade") && other.Calls.Count == 0, "account not in tradeAccounts: refused");
        Msg(c, "order", "{\"type\":\"order\",\"cid\":\"c3\",\"account\":\"Playback101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1}");
        Check(Rejected("may not trade") && play.Calls.Count == 0, "Playback account: refused");
        Msg(c, "order", "{\"type\":\"order\",\"cid\":\"c4\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":3}");
        Check(Rejected("over the MNQ cap of 2"), "qty over cap: refused");
        Msg(c, "order", "{\"type\":\"order\",\"cid\":\"c5\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1.5}");
        Check(Rejected("whole number"), "fractional qty: refused");
        Msg(c, "order", "{\"type\":\"order\",\"cid\":\"c6\",\"account\":\"Sim101\",\"root\":\"ES\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1}");
        Check(Rejected("not served"), "instrument not served: refused");
        Msg(c, "order", "{\"type\":\"order\",\"cid\":\"c7\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":25000}");
        Check(Rejected("no last price"), "limit before any trade: refused");
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Msg(c, "order", "{\"type\":\"order\",\"cid\":\"c8\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24999.1}");
        Check(Rejected("tick grid"), "price off the tick grid: refused");
        Msg(c, "order", "{\"type\":\"order\",\"cid\":\"c9\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24949.75}");
        Check(Rejected("more than 200 ticks"), "limit 201 ticks away: refused");
        Msg(c, "order", "{\"type\":\"order\",\"cid\":\"c10\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"stop\",\"qty\":1,\"price\":24990}");
        Check(Rejected("buy stop must be above"), "buy stop below the market: refused");
        Msg(c, "order", "{\"type\":\"order\",\"cid\":\"c11\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"sell\",\"kind\":\"stop\",\"qty\":1,\"price\":25010}");
        Check(Rejected("sell stop must be below"), "sell stop above the market: refused");
        System.Threading.Thread.Sleep(1100);
        Msg(c, "order", "{\"type\":\"order\",\"cid\":\"c12\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":-1,\"target\":8}}");
        Check(Rejected("bracket ticks"), "negative bracket ticks: refused");
        Check(sim.Calls.Count == 0, "nothing reached NinjaTrader for any refused order");

        // an allowed limit with a bracket
        System.Threading.Thread.Sleep(1100);   // clear the rate-limit window
        sent.Clear();
        Msg(c, "order", "{\"type\":\"order\",\"cid\":\"c13\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"limit\",\"qty\":2,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":16}}");
        Check(sim.Calls.Count == 1 && sim.Calls[0].StartsWith("submit ChartBridge entry Buy Limit 2 L24990 S0"), "allowed limit sent: " + (sim.Calls.Count > 0 ? sim.Calls[0] : "none"));
        Order entry = sim.Orders[0];
        // partial fill of 1 at 24990: stop 24988, target 24994, OCO, qty 1
        entry.Filled = 1; entry.AverageFillPrice = 24990; entry.OrderState = OrderState.PartFilled;
        ChartBridgeOrders.OnOrderUpdate(sim, new OrderEventArgs { Order = entry });
        Check(sim.Calls.Count == 3 && sim.Calls[1].Contains("ChartBridge stop Sell StopMarket 1 L0 S24988 oco:cb-") && sim.Calls[2].Contains("ChartBridge target Sell Limit 1 L24994 S0 oco:cb-"),
              "partial fill: OCO stop 24988 and target 24994 for 1: " + string.Join(" | ", sim.Calls.Skip(1)));
        Check(sent.Any(m => m.Contains("\"type\":\"order\"") && m.Contains("\"cid\":\"c13\"") && m.Contains("\"state\":\"partFilled\"") && m.Contains("\"role\":\"entry\"")), "order update sent to the page with cid, role and state");
        entry.Filled = 2; entry.OrderState = OrderState.Filled;
        ChartBridgeOrders.OnOrderUpdate(sim, new OrderEventArgs { Order = entry });
        Check(sim.Calls.Count == 5 && sim.Calls[3].StartsWith("change ChartBridge stop") && sim.Calls[3].EndsWith("Q2") && sim.Calls[4].StartsWith("change ChartBridge target") && sim.Calls[4].EndsWith("Q2"),
              "full fill: both legs resized to 2");
        ChartBridgeOrders.OnOrderUpdate(sim, new OrderEventArgs { Order = entry });
        Check(sim.Calls.Count == 5, "a repeated update does not resize again");

        // change and cancel a leg by our id
        foreach (Order leg in sim.Orders.Skip(1)) ChartBridgeOrders.OnOrderUpdate(sim, new OrderEventArgs { Order = leg });   // NinjaTrader reports the legs as working
        string stopId = sim.Orders[1] != null ? System.Text.RegularExpressions.Regex.Match(sent.First(m => m.Contains("\"role\":\"stop\"")), "\"id\":\"(o\\d+)\"").Groups[1].Value : "";
        Msg(c, "change", "{\"type\":\"change\",\"id\":\"" + stopId + "\",\"price\":24985}");
        Check(sim.Calls.Last().StartsWith("change ChartBridge stop") && sim.Calls.Last().Contains("S24985"), "stop leg moved to 24985 (id " + stopId + ")");
        Msg(c, "change", "{\"type\":\"change\",\"id\":\"" + stopId + "\",\"price\":25005}");
        Check(Rejected("sell stop must be below"), "stop leg moved above the market: refused");
        Msg(c, "cancel", "{\"type\":\"cancel\",\"id\":\"" + stopId + "\"}");
        Check(sim.Calls.Last() == "cancel ChartBridge stop", "stop leg cancelled");
        Msg(c, "cancel", "{\"type\":\"cancel\",\"id\":\"o999\"}");
        Check(Rejected("no working order"), "unknown id: refused");

        // flatten
        Msg(c, "flatten", "{\"type\":\"flatten\",\"account\":\"Sim101\",\"root\":\"MNQ\"}");
        Check(sim.Calls.Last() == "flatten MNQ 12-26", "flatten sent for MNQ 12-26 on Sim101");
        Msg(c, "flatten", "{\"type\":\"flatten\",\"account\":\"OTHER-ACC\",\"root\":\"MNQ\"}");
        Check(Rejected("may not trade") && other.Calls.Count == 0, "flatten on a non-trading account: refused");

        // gate 7: rate limit
        System.Threading.Thread.Sleep(1100);
        int before = eval.Calls.Count;
        for (int i = 0; i < 12; i++) Msg(c, "order", "{\"type\":\"order\",\"cid\":\"r" + i + "\",\"account\":\"DEMO-EVAL\",\"root\":\"MNQ\",\"side\":\"sell\",\"kind\":\"market\",\"qty\":1}");
        Check(eval.Calls.Count - before == 10 && Rejected("too many order actions"), "rate limit: 10 sent in a second, the rest refused (" + (eval.Calls.Count - before) + ")");

        // position message
        sent.Clear();
        ChartBridgeOrders.OnPositionUpdate(sim, new PositionEventArgs { Position = new Position { Instrument = mnq }, MarketPosition = MarketPosition.Short, Quantity = 2, AveragePrice = 25001.25 });
        Check(sent.Count == 1 && sent[0].Contains("\"qty\":-2") && sent[0].Contains("\"avgPrice\":25001.25"), "position: short 2 sent signed");
        ChartBridgeOrders.OnPositionUpdate(other, new PositionEventArgs { Position = new Position { Instrument = mnq }, MarketPosition = MarketPosition.Long, Quantity = 1, AveragePrice = 1 });
        Check(sent.Count == 1, "position on a non-trading account is not sent");

        // turning trading off stops everything
        ChartBridgeOrders.ResetConfig();
        int n = sim.Calls.Count;
        Msg(c, "flatten", "{\"type\":\"flatten\",\"account\":\"Sim101\",\"root\":\"MNQ\"}");
        Check(Rejected("trading is off") && sim.Calls.Count == n, "after config reset: refused");

        Console.WriteLine(fails == 0 ? "ALL PASSED" : fails + " FAILED");
        return fails == 0 ? 0 : 1;
    }
}
