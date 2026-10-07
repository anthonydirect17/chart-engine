// Runs the real ChartBridgeOrders.cs against the stand-in NinjaTrader types and checks every gate,
// the bracket logic, the legs check and the messages. Linux with mono: sh nt8/check/orders.sh
// (npm run check:orders). The stand-in account records Submit, Change, Cancel and Flatten; order
// states and fills are set here by hand, the way NinjaTrader would report them.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Text.RegularExpressions;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript.AddOns;

public static class OrdersHarness
{
    static int fails, checks;
    static List<string> sent = new List<string>();
    static ChartBridgeClient c;
    static Instrument mnq, es;

    static void Check(bool ok, string what) { Console.WriteLine((ok ? "ok   " : "FAIL ") + what); checks++; if (!ok) fails++; }
    // Integration: each 0.4.0 lane's harness prints its own count, so a lost or doubled check shows at once.
    static void Section(string name, Action<Action<bool, string>> run) { int was = checks, failed = fails; run(Check); Console.WriteLine("== " + name + ": " + (checks - was) + " checks, " + (fails - failed) + " failed"); }
    static string LastSent() { return sent.Count > 0 ? sent[sent.Count - 1] : ""; }
    static bool Rejected(string contains) { string m = LastSent(); return m.Contains("\"type\":\"reject\"") && m.Contains(contains); }
    static void Msg(string type, string json) { lock (c.Actions) c.Actions.Clear(); ChartBridgeOrders.OnMessage(c, type, json); }
    static string Order(string account, string rest) { return "{\"type\":\"order\",\"cid\":\"x\",\"account\":\"" + account + "\",\"root\":\"MNQ\"," + rest + "}"; }
    static void Update(Account a, Order o) { ChartBridgeOrders.OnOrderUpdate(a, new OrderEventArgs { Order = o }); }
    static void Fill(Account a, Order o, int filled, double avg) { o.Filled = filled; o.AverageFillPrice = avg; o.OrderState = filled >= o.Quantity ? OrderState.Filled : OrderState.PartFilled; Update(a, o); }
    // A fill with NinjaTrader's execution for it listed on the account (exec false: none listed, as before 0.3.8's review).
    static void FillX(Account a, Order o, int filled, double avg, double price, bool exec)
    {
        if (exec) lock (a.Executions) a.Executions.Add(new Execution { Order = o, Instrument = o.Instrument, Quantity = filled - o.Filled, Price = price, Time = DateTime.Now, ExecutionId = "x" + Guid.NewGuid().ToString("N") });
        Fill(a, o, filled, avg);
    }
    static string IdOf(Order o) { return (string)typeof(ChartBridgeOrders).GetMethod("IdFor", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, new object[] { o }); }
    static string Tag(Order entry) { return Regex.Match(entry.Name, "^CB#([0-9a-f]{8}) ").Groups[1].Value; }
    static List<string> After(Account a, int n) { return a.Calls.Skip(n).ToList(); }
    static string RoleOf(Order o) { return Regex.Match(o.Name ?? "", "^CB#[0-9a-f]{8} (stop|target|exit) ").Groups[1].Value; }

    // A connected account that the legs check has seen connected since time 0 (so it counts as steady).
    // Mark every order of an account done (the stand-in's Cancel does not change states).
    static void Done(Account a) { foreach (Order o in a.Orders) if (o.OrderState != OrderState.Filled) o.OrderState = OrderState.Cancelled; }

    // Pretend a leg was submitted ms milliseconds ago.
    static void Age(Order leg, double ms)
    {
        FieldInfo f = typeof(ChartBridgeOrders).GetField("LegBorn", BindingFlags.NonPublic | BindingFlags.Static);
        ((Dictionary<Order, double>)f.GetValue(null))[leg] = ChartBridgeTime.NowUtcMs() - ms;
    }

    static Account NewAccount(string name)
    {
        Account a = new Account { Name = name, Connection = new Connection { Status = ConnectionStatus.Connected } };
        Account.All.Add(a);
        FieldInfo since = typeof(ChartBridgeOrders).GetField("ConnectedSince", BindingFlags.NonPublic | BindingFlags.Static);
        ((Dictionary<Account, double>)since.GetValue(null))[a] = 0;
        return a;
    }

    static void SetPos(Account a, Instrument inst, int signed)
    {
        a.Positions.RemoveAll(p => p.Instrument == inst);
        if (signed != 0) a.Positions.Add(new Position { Instrument = inst, MarketPosition = signed > 0 ? MarketPosition.Long : MarketPosition.Short, Quantity = Math.Abs(signed), AveragePrice = 25000 });
    }

    static Order Manual(Account a, Instrument inst, OrderAction action, OrderType type, int qty, double limit, double stop, string oco, string name)
    {
        Order o = new Order { Account = a, Instrument = inst, OrderAction = action, OrderType = type, Quantity = qty, LimitPrice = limit, StopPrice = stop, Oco = oco, Name = name, OrderState = OrderState.Working };
        a.Orders.Add(o);
        return o;
    }

    public static int Main()
    {
        // 0.3.7: ChartBridge's folder (planned_brackets.txt) in a fresh directory, never a shared /tmp/nt8 from an earlier run
        string home = Path.Combine(Path.GetTempPath(), "cb-orders-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(home, "ChartBridge"));
        NinjaTrader.Core.Globals.UserDataDir = home;
        ChartBridgeOrders.LoadPlansNow();   // what StartPlans does at start, here on this thread
        mnq = new Instrument { FullName = "MNQ 12-26", MasterInstrument = new MasterInstrument { Name = "MNQ", TickSize = 0.25, PointValue = 2 } };
        es = new Instrument { FullName = "ES 12-26", MasterInstrument = new MasterInstrument { Name = "ES", TickSize = 0.25, PointValue = 50 } };
        FieldInfo f = typeof(ChartBridgeServer).GetField("Instruments", BindingFlags.NonPublic | BindingFlags.Static);
        ((Dictionary<string, Instrument>)f.GetValue(null))["MNQ"] = mnq;   // ES is not served
        Account sim = NewAccount("Sim101"), eval = NewAccount("DEMO-EVAL"), other = NewAccount("OTHER-ACC"), play = NewAccount("Playback101");
        ChartBridgeOrders.NewToken();
        string token = ChartBridgeOrders.SessionJson().Split('"')[3];

        c = new ChartBridgeClient(null, 1);
        c.Tap = s => sent.Add(s);
        c.Origin = "http://localhost:8765";
        FieldInfo cf = typeof(ChartBridgeServer).GetField("Clients", BindingFlags.NonPublic | BindingFlags.Static);
        ((System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient>)cf.GetValue(null))[1] = c;

        // ------------------------------------------------------------ gate 1: off by default
        ChartBridgeOrders.ResetConfig();
        Msg("auth", "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
        Check(LastSent().Contains("\"enabled\":false") && LastSent().Contains("trading is off"), "trading off by default: auth refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("trading is off") && sim.Calls.Count == 0, "trading off: order refused, nothing sent to NinjaTrader");

        ChartBridgeOrders.ReadConfig("trading", "true");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, DEMO-EVAL, SimB, SimC, SimD, SimE, SimF, SimG, SimH, SimP, SimR, SimX, Playback101, EVAL*");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "3");
        Check(!ChartBridgeOrders.TradeAccounts.Contains("Playback101") && !ChartBridgeOrders.TradeAccounts.Any(a => a.Contains("*")) && ChartBridgeOrders.TradeAccounts.Contains("Sim101"),
              "tradeAccounts drops Playback and wildcards");

        // ------------------------------------------------------------ gate 4: origin and token
        ChartBridgeClient evil = new ChartBridgeClient(null, 2); evil.Tap = s => sent.Add(s); evil.Origin = "https://evil.example";
        ChartBridgeOrders.OnMessage(evil, "auth", "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
        Check(LastSent().Contains("\"enabled\":false") && LastSent().Contains("own page"), "other origin: auth refused even with the right token");
        ChartBridgeClient upper = new ChartBridgeClient(null, 3); upper.Tap = s => sent.Add(s); upper.Origin = "http://LOCALHOST:8765";
        ChartBridgeOrders.OnMessage(upper, "auth", "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
        Check(LastSent().Contains("own page"), "Origin must match exactly (no case folding)");
        ChartBridgeOrders.OnMessage(evil, "order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("may not trade") && sim.Calls.Count == 0, "other origin: order refused");
        Msg("auth", "{\"type\":\"auth\",\"token\":\"wrong\"}");
        Check(LastSent().Contains("token does not match") && !c.Trader, "wrong token: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("may not trade") && sim.Calls.Count == 0, "not signed in: order refused");
        sent.Clear();
        Msg("auth", "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
        Check(c.Trader && sent[0].Contains("\"enabled\":true") && sent[0].Contains("\"Sim101\"") && sent[0].Contains("\"MNQ\":3"), "right origin and token: trading on, accounts and caps sent");
        Check(sent.Count >= 2 && sent[1].Contains("\"type\":\"orders\""), "orders snapshot after auth");

        // ------------------------------------------------------------ gates 2, 5, 6 and strict messages
        Msg("order", Order("OTHER-ACC", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("OTHER-ACC may not trade") && other.Calls.Count == 0, "account not in tradeAccounts: refused");
        Msg("order", Order("Playback101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("may not trade") && play.Calls.Count == 0, "Playback account: refused");
        Msg("order", Order("SimH", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("not connected in NinjaTrader"), "tradeAccounts name that NinjaTrader does not have: refused");
        Account lost = NewAccount("SimH");
        lost.Connection.Status = ConnectionStatus.ConnectionLost;
        Msg("order", Order("SimH", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("not connected (ConnectionLost)") && lost.Calls.Count == 0, "account whose connection is lost: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1.5"));
        Check(Rejected("whole number"), "fractional qty: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":\"1\""));
        Check(Rejected("whole number"), "qty as a string: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":2147483648"));
        Check(Rejected("whole number"), "qty past int range: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1e0"));
        Check(Rejected("whole number"), "qty with an exponent: refused");
        Msg("order", "{\"type\":\"order\",\"cid\":\"x\",\"account\":\"Sim101\",\"root\":\"ES\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1}");
        Check(Rejected("not served"), "instrument not served: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"price\":25000"));
        Check(Rejected("market order takes no price"), "market order with a price: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"brakcet\":{\"stop\":8,\"target\":16}"));
        Check(Rejected("nested") || Rejected("unknown key"), "misspelt bracket: refused, never sent naked");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"brakcet\":8"));
        Check(Rejected("unknown key \\\"brakcet\\\""), "unknown top-level key: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":null"));
        Check(Rejected("bracket must be an object"), "bracket null: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":\"8/16\""));
        Check(Rejected("bracket must be an object"), "bracket as a string: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"targt\":16}"));
        Check(Rejected("unknown key \\\"targt\\\""), "unknown key inside bracket: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":{\"x\":1}}"));
        Check(Rejected("nested"), "object nested in bracket: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"qty\":1"));
        Check(Rejected("key twice"), "duplicate key: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"stop\":2}"));
        Check(Rejected("key twice"), "duplicate key inside bracket: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":[1]"));
        Check(Rejected("nested object or list"), "list value: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":-1,\"target\":8}"));
        Check(Rejected("0 or more"), "negative bracket ticks: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8}"));
        Check(Rejected("needs both stop and target"), "bracket missing its target: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":4"));
        Check(Rejected("over the MNQ cap of 3"), "one order over the cap: refused");
        ChartBridgeOrders.ReadConfig("maxBracketTicks", "200");   // 0.3.7: only with the config limit set
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":201,\"target\":8}"));
        Check(Rejected("from 0 to 200 (maxBracketTicks in config.txt)"), "bracket over maxBracketTicks = 200: refused");
        ChartBridgeOrders.MaxBracketTicks = 0;
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":\"8\",\"target\":16}"));
        Check(Rejected("needs both stop and target"), "bracket ticks as a string: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8.5,\"target\":16}"));
        Check(Rejected("needs both stop and target"), "fractional bracket ticks: refused");

        // gate 5: prices
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":25000"));
        Check(Rejected("no last price"), "limit before any trade: refused");
        FieldInfo lf = typeof(ChartBridgeOrders).GetField("Last", BindingFlags.NonPublic | BindingFlags.Static);
        ((Dictionary<string, double[]>)lf.GetValue(null))["MNQ"] = new double[] { 25000, ChartBridgeTime.NowUtcMs() - 400000 };
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990"));
        Check(Rejected("stale"), "last price older than 300 seconds: refused");
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24999.1"));
        Check(Rejected("tick grid"), "price off the tick grid: refused");
        ChartBridgeOrders.ReadConfig("maxTicksAway", "200");   // 0.3.7: only with the config limit set
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24949.75"));
        Check(Rejected("more than 200 ticks") && Rejected("maxTicksAway in config.txt"), "limit 201 ticks away with maxTicksAway = 200: refused");
        ChartBridgeOrders.MaxTicksAway = 0;
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":2.4999e4"));
        Check(Rejected("plain price"), "price with an exponent: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1"));
        Check(Rejected("plain price"), "limit with no price: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"stop\",\"qty\":1,\"price\":24990"));
        Check(Rejected("buy stop must be above"), "buy stop below the market: refused");
        Msg("order", Order("Sim101", "\"side\":\"sell\",\"kind\":\"stop\",\"qty\":1,\"price\":25010"));
        Check(Rejected("sell stop must be below"), "sell stop above the market: refused");
        Msg("order", Order("Sim101", "\"side\":\"up\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("side must be"), "bad side: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"stopLimit\",\"qty\":1,\"price\":25010"));
        Check(Rejected("kind must be"), "unsupported kind: refused");
        Check(sim.Calls.Count == 0, "nothing reached NinjaTrader for any refused order");

        // ------------------------------------------------------------ strict messages: any quoted key counts
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":8"));
        Check(Rejected("bracket must be an object"), "\"bracket\":8 refused, never a naked order");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"stop-loss\":8"));
        Check(Rejected("unknown key \\\"stop-loss\\\""), "a key with a dash is still a key: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty \":1"));
        Check(Rejected("unknown key \\\"qty \\\""), "\"qty \" (with a space) refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":01"));
        Check(Rejected("whole number"), "qty with a leading zero refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990.00,\"bracket\":{\"stop\":08,\"target\":16}"));
        Check(Rejected("needs both stop and target"), "bracket ticks with a leading zero refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":25001"));
        Check(Rejected("buy limit above the last price"), "buy limit above the market (would fill at once): refused");
        Msg("order", Order("Sim101", "\"side\":\"sell\",\"kind\":\"limit\",\"qty\":1,\"price\":24999"));
        Check(Rejected("sell limit below the last price"), "sell limit below the market: refused");
        Check(sim.Calls.Count == 0, "still nothing reached NinjaTrader");

        // ------------------------------------------------------------ gate 3: the cap is on the position
        Account b = NewAccount("SimB");
        SetPos(b, mnq, 3);
        Msg("order", Order("SimB", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("position 4 contracts") && b.Calls.Count == 0, "long 3, cap 3: buying 1 more refused");
        Msg("order", Order("SimB", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":7"));
        Check(Rejected("over the MNQ cap of 3") && b.Calls.Count == 0, "cap 3, long 3: selling 7 in one order refused");
        Msg("order", Order("SimB", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Check(Rejected("opens or adds") && b.Calls.Count == 0, "bracket on an order that reduces the position: refused");
        Msg("order", Order("SimB", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":3"));
        Check(b.Calls.Count == 1 && b.Calls[0].Contains("Sell Market 3"), "long 3: selling 3 to exit is allowed");
        Done(b);
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "4");
        Msg("order", Order("SimB", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":4"));
        Check(b.Calls.Count == 2, "cap 4, long 3: selling 4 (to short 1) allowed");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "9");
        Msg("order", Order("SimB", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":9"));
        Check(Rejected("position 10 contracts") && b.Calls.Count == 2, "cap 9, long 3, a sell 4 still working: selling 9 more could make short 10: refused");
        Done(b);
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "3");
        Account cc = NewAccount("SimC");
        Msg("order", Order("SimC", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":2,\"price\":24990"));
        Msg("order", Order("SimC", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":2,\"price\":24980"));
        Check(cc.Calls.Count == 1 && Rejected("working 2"), "flat with a working buy 2: another buy 2 refused (cap 3)");
        cc.Orders[0].OrderState = OrderState.CancelPending;
        Msg("order", Order("SimC", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":2,\"price\":24980"));
        Check(cc.Calls.Count == 1 && Rejected("working 2"), "a cancel still pending can fill: it still counts");
        Done(cc);
        cc.Orders.Clear();
        Msg("order", Order("SimC", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":3,\"price\":24990"));
        cc.Orders.Clear();   // NinjaTrader has not listed it yet
        Msg("order", Order("SimC", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24980"));
        Check(cc.Calls.Count == 2 && Rejected("working 3"), "an order ChartBridge just sent counts before NinjaTrader lists it");
        Account pp = NewAccount("SimP");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "1");
        Msg("order", Order("SimP", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Fill(pp, pp.Orders[0], 1, 25000);   // filled; the position update has not landed yet
        Msg("order", Order("SimP", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(pp.Calls.Count == 1 && Rejected("the cap is 1"), "cap 1: a fill reported before its position update still counts");
        ChartBridgeOrders.OnPositionUpdate(pp, new PositionEventArgs { Position = new Position { Instrument = mnq }, MarketPosition = MarketPosition.Long, Quantity = 1, AveragePrice = 25000 });
        SetPos(pp, mnq, 1);
        Msg("order", Order("SimP", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(pp.Calls.Count == 1 && Rejected("the cap is 1"), "after the position update it is counted once, not twice (still refused at 2)");
        Msg("order", Order("SimP", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":1"));
        Check(pp.Calls.Count == 2, "and the exit is allowed (counted once)");
        Account d = NewAccount("SimD");
        SetPos(d, mnq, 1);
        Manual(d, mnq, OrderAction.Sell, OrderType.StopMarket, 1, 0, 24990, "atm1", "Stop1");
        Manual(d, mnq, OrderAction.Sell, OrderType.Limit, 1, 25010, 0, "atm1", "Target1");
        Msg("order", Order("SimD", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":1"));
        Check(d.Calls.Count == 1, "cap 1, long 1 with an OCO stop and target: selling 1 to exit allowed (an OCO pair counts once)");
        Manual(d, mnq, OrderAction.Sell, OrderType.Limit, 1, 25020, 0, "", "loose");
        Msg("order", Order("SimD", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":1"));
        Check(d.Calls.Count == 1 && Rejected("the cap is 1"), "cap 1: a separate working sell counts, so another sell 1 is refused");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "3");

        // ------------------------------------------------------------ brackets: one OCO pair per fill increment
        sent.Clear();
        Msg("order", "{\"type\":\"order\",\"cid\":\"c13\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"limit\",\"qty\":3,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":16}}");
        Check(sim.Calls.Count == 1 && Regex.IsMatch(sim.Calls[0], "^submit CB#[0-9a-f]{8} atm s8 t16 Buy Limit 3 L24990 S0 oco:$"), "allowed limit sent, its bracket ticks in its name (0.3.8: atm, ticks from each fill): " + (sim.Calls.Count > 0 ? sim.Calls[0] : "none"));
        Order entry = sim.Orders[0];
        string tag = Tag(entry);
        Fill(sim, entry, 2, 24990);
        List<string> legs = After(sim, 1);
        Check(legs.Count == 2 && legs[0] == "submit CB#" + tag + " stop f2 q2 p24990 Sell StopMarket 2 L0 S24988 oco:cb-" + tag + "-2" && legs[1] == "submit CB#" + tag + " target f2 q2 p24990 Sell Limit 2 L24994 S0 oco:cb-" + tag + "-2",
              "fill of 2 at 24990: OCO stop 24988 and target 24994 for 2, the increment in the names: " + string.Join(" | ", legs));
        Check(sent.Any(m => m.Contains("\"type\":\"order\"") && m.Contains("\"cid\":\"c13\"") && m.Contains("\"state\":\"partFilled\"") && m.Contains("\"role\":\"entry\"")), "order update sent to the page with cid, role and state");
        Fill(sim, entry, 3, (24990 * 2 + 24991) / 3.0);
        legs = After(sim, 3);
        Check(legs.Count == 2 && legs[0] == "submit CB#" + tag + " stop f3 q1 p24991 Sell StopMarket 1 L0 S24989 oco:cb-" + tag + "-3" && legs[1] == "submit CB#" + tag + " target f3 q1 p24991 Sell Limit 1 L24995 S0 oco:cb-" + tag + "-3",
              "next fill of 1 at 24991 (0.3.8, the ATM rule): its own pair, ticks from that fill: " + string.Join(" | ", legs));
        Check(!sim.Calls.Any(x => x.StartsWith("change")), "earlier legs are not resized (no change calls)");
        Update(sim, entry);
        Check(sim.Calls.Count == 5, "a repeated update places nothing more");
        Order stopA = sim.Orders[1], targetA = sim.Orders[2], stopB = sim.Orders[3], targetB = sim.Orders[4];
        foreach (Order leg in new[] { stopA, targetA, stopB, targetB }) Update(sim, leg);
        Check(sent.Any(m => m.Contains("\"role\":\"stop\"") && m.Contains("\"oco\":\"cb-" + tag + "-2\"")), "legs reach the page with role stop and their OCO id");

        // a leg fills in part: its partner shrinks; fills in full: its partner is cancelled
        targetA.Filled = 1; targetA.OrderState = OrderState.PartFilled; Update(sim, targetA);
        Check(sim.Calls.Last() == "change " + stopA.Name + " L0 S0 Q1", "target A filled 1 of 2: stop A shrunk to 1: " + sim.Calls.Last());
        stopA.Quantity = 1;
        targetA.Filled = 2; targetA.OrderState = OrderState.Filled; Update(sim, targetA);
        Check(sim.Calls.Last() == "cancel " + stopA.Name, "target A filled: stop A cancelled");
        stopA.OrderState = OrderState.Cancelled; Update(sim, stopA);

        // a rejected leg raises an error on the page
        sent.Clear();
        stopB.OrderState = OrderState.Rejected;
        ChartBridgeOrders.OnOrderUpdate(sim, new OrderEventArgs { Order = stopB, Error = ErrorCode.OrderRejected });
        Check(sent.Any(m => m.Contains("\"type\":\"status\"") && m.Contains("\"level\":\"error\"") && m.Contains("NO STOP") && m.Contains("OCO partner")), "rejected stop leg: error status on the page, naming the partner risk");
        Check(sent.Any(m => m.Contains("\"state\":\"rejected\"") && m.Contains("\"text\":\"NinjaTrader: OrderRejected\"")), "rejected leg: NinjaTrader's error sent with the order");

        // change and cancel by our id
        string idB = IdOf(targetB);
        Msg("change", "{\"type\":\"change\",\"id\":\"" + idB + "\",\"price\":25002}");
        Check(sim.Calls.Last() == "change " + targetB.Name + " L25002 S0 Q0", "target leg moved to 25002 (" + idB + "): " + sim.Calls.Last());
        Msg("change", "{\"type\":\"change\",\"id\":\"" + idB + "\",\"price\":24998}");
        Check(Rejected("sell limit below the last price"), "target moved through the market: refused");
        Order stopLeg = Manual(sim, mnq, OrderAction.Sell, OrderType.StopMarket, 1, 0, 24990, "", "my stop");
        Update(sim, stopLeg);
        string idS = IdOf(stopLeg);
        Msg("change", "{\"type\":\"change\",\"id\":\"" + idS + "\",\"price\":25005}");
        Check(Rejected("sell stop must be below"), "stop moved above the market: refused");
        Msg("change", "{\"type\":\"change\",\"id\":\"" + idS + "\",\"price\":24985,\"qty\":2}");
        Check(Rejected("unknown key \\\"qty\\\""), "change with a qty: refused");
        Msg("change", "{\"type\":\"change\",\"id\":\"" + idS + "\",\"price\":24985}");
        Check(sim.Calls.Last() == "change my stop L0 S24985 Q0", "order placed in NinjaTrader moved from the chart");
        Order stopLimit = Manual(sim, mnq, OrderAction.Sell, OrderType.StopLimit, 1, 24989, 24990, "", "my stop limit");
        Update(sim, stopLimit);
        Msg("change", "{\"type\":\"change\",\"id\":\"" + IdOf(stopLimit) + "\",\"price\":24985}");
        Check(Rejected("stop-limit"), "stop-limit move: refused");
        Msg("cancel", "{\"type\":\"cancel\",\"id\":\"" + idS + "\"}");
        Check(sim.Calls.Last() == "cancel my stop", "order cancelled by id");
        Msg("cancel", "{\"type\":\"cancel\",\"id\":\"o999\"}");
        Check(Rejected("no working order"), "unknown id: refused");
        Order esOrder = Manual(sim, es, OrderAction.Sell, OrderType.StopMarket, 1, 0, 5000, "", "es stop");
        int beforeEs = sim.Calls.Count;
        Msg("cancel", "{\"type\":\"cancel\",\"id\":\"" + IdOf(esOrder) + "\"}");
        Check(Rejected("not served") && sim.Calls.Count == beforeEs, "cancel on a contract ChartBridge does not serve: refused");
        Msg("change", "{\"type\":\"change\",\"id\":\"" + IdOf(esOrder) + "\",\"price\":4999}");
        Check(Rejected("not served") && sim.Calls.Count == beforeEs, "change on a contract ChartBridge does not serve: refused");

        // ------------------------------------------------------------ flatten: a late fill still gets legs, and an alarm
        Account e = NewAccount("SimE");
        Msg("order", Order("SimE", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":0}"));
        Order late = e.Orders[0];
        Msg("flatten", "{\"type\":\"flatten\",\"account\":\"SimE\",\"root\":\"MNQ\"}");
        Check(e.Calls.Last() == "flatten MNQ 12-26", "flatten sent for MNQ 12-26");
        sent.Clear();
        Fill(e, late, 1, 24990);
        Check(e.Calls.Count == 3 && e.Calls[2].StartsWith("submit CB#" + Tag(late) + " stop f1 q1 p24990 Sell StopMarket 1"), "entry that fills after Flatten still gets its stop");
        Check(sent.Any(m => m.Contains("\"level\":\"error\"") && m.Contains("AFTER Flatten")), "and the page gets an alarm");
        Msg("flatten", "{\"type\":\"flatten\",\"account\":\"OTHER-ACC\",\"root\":\"MNQ\"}");
        Check(Rejected("may not trade") && other.Calls.Count == 0, "flatten on a non-trading account: refused");
        Msg("flatten", "{\"type\":\"flatten\",\"account\":\"SimE\",\"root\":\"MNQ\",\"all\":true}");
        Check(Rejected("unknown key"), "flatten with an unknown key: refused");

        // stop only: lone legs, no OCO
        Account g = NewAccount("SimG");
        Msg("order", Order("SimG", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":12,\"target\":0}"));
        Fill(g, g.Orders[0], 1, 25000);
        Check(g.Calls.Count == 2 && g.Calls[1] == "submit CB#" + Tag(g.Orders[0]) + " stop f1 q1 p25000 Buy StopMarket 1 L0 S25003 oco:", "short with stop only: one buy stop 12 ticks above, no OCO: " + g.Calls.Last());

        // the stop level has already traded when the fill is reported: exit at market, with an alarm
        Account sx = NewAccount("SimX");
        Msg("order", Order("SimX", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":16}"));
        ChartBridgeOrders.NoteLast("MNQ", 24987);   // price fell through 24988 before the fill was reported
        sent.Clear();
        Fill(sx, sx.Orders[0], 1, 24990);
        Check(sx.Calls.Count == 2 && sx.Calls[1] == "submit CB#" + Tag(sx.Orders[0]) + " exit f1 q1 p24990 Sell Market 1 L0 S0 oco:", "stop level already passed: a market exit, no stop through the market: " + sx.Calls.Last());
        Check(sent.Any(m => m.Contains("\"level\":\"error\"") && m.Contains("already passed the stop level")), "and an alarm says so");
        ChartBridgeOrders.NoteLast("MNQ", 25000);

        // a bracketed fill that closes an opposite position: the fill gets its legs at once (a position read at
        // fill time can be stale either way), and the settled legs check removes them from the wrong side
        Account rr = NewAccount("SimR");
        Msg("order", Order("SimR", "\"side\":\"sell\",\"kind\":\"limit\",\"qty\":1,\"price\":25010,\"bracket\":{\"stop\":8,\"target\":16}"));
        SetPos(rr, mnq, 2);   // Anthony went long 2 elsewhere while the sell limit waited
        Fill(rr, rr.Orders[0], 1, 25010);
        Check(rr.Calls.Count == 3 && rr.Calls[1].Contains(" stop f1 q1 ") && rr.Calls[1].Contains("Buy StopMarket"), "a bracketed fill always gets its legs from the order event");
        SetPos(rr, mnq, 1);   // the sell closed 1 of the long 2
        sent.Clear();
        double tr = 3000000;
        ChartBridgeOrders.CheckLegs(tr); ChartBridgeOrders.CheckLegs(tr + 5000);
        Check(rr.Calls.Count == 5 && rr.Calls[3].StartsWith("cancel CB#") && rr.Calls[4].StartsWith("cancel CB#"), "buy legs on a long position are cancelled once it has settled");
        Check(sent.Any(m => m.Contains("\"level\":\"warn\"") && m.Contains("SimR") && m.Contains("cannot open or add")), "and the page is told");
        foreach (Order o in rr.Orders) if (o.Name.Contains(" stop ") || o.Name.Contains(" target ")) o.OrderState = OrderState.Cancelled;

        // ------------------------------------------------------------ flat: old legs cancelled, young ones left to the legs check
        Account ff = NewAccount("SimF");
        Msg("order", Order("SimF", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Fill(ff, ff.Orders[0], 1, 25000);
        Check(ff.Calls.Count == 3, "market with bracket: entry and two legs");
        SetPos(ff, mnq, 1);   // a newer fill already reopened: the position is long again when the flat event lands
        ChartBridgeOrders.OnPositionUpdate(ff, new PositionEventArgs { Position = new Position { Instrument = mnq }, MarketPosition = MarketPosition.Flat, Quantity = 0 });
        Check(ff.Calls.Count == 3, "stale flat event while the position is open again: legs kept");
        SetPos(ff, mnq, 0);
        ChartBridgeOrders.OnPositionUpdate(ff, new PositionEventArgs { Position = new Position { Instrument = mnq }, MarketPosition = MarketPosition.Flat, Quantity = 0 });
        Check(ff.Calls.Count == 3, "flat event right after the legs were placed (a new entry's legs may be racing it): legs left to the legs check");
        Age(ff.Orders[1], 5000); Age(ff.Orders[2], 5000);
        sent.Clear();
        ChartBridgeOrders.OnPositionUpdate(ff, new PositionEventArgs { Position = new Position { Instrument = mnq }, MarketPosition = MarketPosition.Flat, Quantity = 0 });
        Check(ff.Calls.Count == 5 && ff.Calls[3].StartsWith("cancel CB#") && ff.Calls[3].Contains(" stop ") && ff.Calls[4].Contains(" target "), "flat with legs older than 3 seconds: leftover stop and target cancelled");
        Check(sent.Any(m => m.Contains("\"level\":\"warn\"") && m.Contains("leftover bracket leg")), "and the page is told");

        // ------------------------------------------------------------ recompile: the bracket comes back from the order names
        Account r = NewAccount("DEMO-EVAL2");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, DEMO-EVAL, SimB, SimC, SimD, SimE, SimF, SimG, SimH, SimP, SimR, SimX, DEMO-EVAL2");
        Order rEntry = Manual(r, mnq, OrderAction.Buy, OrderType.Limit, 3, 24990, 0, "", "CB#0badcafe s8 t16");
        rEntry.Filled = 3; rEntry.AverageFillPrice = (24990 * 2 + 24992) / 3.0; rEntry.OrderState = OrderState.Filled;   // the third contract filled while ChartBridge was reloading
        Order rStop = Manual(r, mnq, OrderAction.Sell, OrderType.StopMarket, 1, 0, 24988, "cb-0badcafe-2", "CB#0badcafe stop f2 q2 p24990");   // shrunk after its target filled 1
        Order rTarget = Manual(r, mnq, OrderAction.Sell, OrderType.Limit, 2, 24994, 0, "cb-0badcafe-2", "CB#0badcafe target f2 q2 p24990");
        rTarget.Filled = 1; rTarget.OrderState = OrderState.PartFilled;
        SetPos(r, mnq, 2);
        ChartBridgeOrders.Clear(); ChartBridgeOrders.LoadPlansNow();
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        double trc = 4000000;
        // the scan notes the gap; it acts once the gap has lasted 4 seconds
        ChartBridgeOrders.CheckLegs(trc);
        Check(r.Calls.Count == 0, "after a reload, a gap is not acted on at once (an order event may still be on its way)");
        ChartBridgeOrders.CheckLegs(trc + 4500);
        Check(r.Calls.Count == 2 && r.Calls[0] == "submit CB#0badcafe stop f3 q1 p24992 Sell StopMarket 1 L0 S24990 oco:cb-0badcafe-3",
              "after a reload, the fill that came in meanwhile gets its own pair at its own price (24992, not the average): " + string.Join(" | ", r.Calls));
        ChartBridgeOrders.CheckLegs(trc + 6000); ChartBridgeOrders.CheckLegs(trc + 12000);
        Check(r.Calls.Count == 2, "later scans place nothing more (the shrunk pair still counts its 2 from the name)");
        rTarget.Filled = 2; rTarget.OrderState = OrderState.Filled; Update(r, rTarget);
        Check(r.Calls.Count == 3 && r.Calls[2] == "cancel CB#0badcafe stop f2 q2 p24990", "pairs are re-linked after a reload: the target filling cancels its stop");
        Order plain = Manual(r, mnq, OrderAction.Buy, OrderType.Market, 1, 0, 0, "", "CB#0badf00d s0 t0");
        plain.Filled = 1; plain.OrderState = OrderState.Filled;
        Update(r, plain);
        Check(r.Calls.Count == 3, "entry named with no bracket: no legs");

        // ------------------------------------------------------------ bracket upkeep runs with trading switched off
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, DEMO-EVAL, SimB, SimC, SimD, SimE, SimF, SimG, SimH");
        Order offEntry = Manual(eval, mnq, OrderAction.Buy, OrderType.Limit, 1, 24990, 0, "", "CB#00c0ffee s8 t16");
        ChartBridgeOrders.ReadConfig("trading", "false");
        sent.Clear();
        offEntry.Filled = 1; offEntry.AverageFillPrice = 24990; offEntry.OrderState = OrderState.Filled;
        Update(eval, offEntry);
        Check(eval.Calls.Count == 2 && eval.Calls[0].Contains("CB#00c0ffee stop f1 q1"), "trading switched off mid-trade: the fill still gets its stop and target");
        Check(!sent.Any(m => m.Contains("\"type\":\"order\"")), "trading off: nothing sent to the page");
        ChartBridgeOrders.ReadConfig("trading", "true");

        // ------------------------------------------------------------ the legs check
        foreach (Account a in Account.All) if (a.Name != "SimK") foreach (Order o in a.Orders) o.OrderState = OrderState.Cancelled;   // only SimK's legs from here
        Account k = NewAccount("SimK");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, DEMO-EVAL, SimK");
        Order k1s = Manual(k, mnq, OrderAction.Sell, OrderType.StopMarket, 1, 0, 24988, "cb-11111111-1", "CB#11111111 stop f1 q1 p24990");
        Order k1t = Manual(k, mnq, OrderAction.Sell, OrderType.Limit, 1, 25010, 0, "cb-11111111-1", "CB#11111111 target f1 q1 p24990");
        Order k2s = Manual(k, mnq, OrderAction.Sell, OrderType.StopMarket, 1, 0, 24988, "cb-11111111-2", "CB#11111111 stop f2 q1 p24990");
        Order k2t = Manual(k, mnq, OrderAction.Sell, OrderType.Limit, 1, 25010, 0, "cb-11111111-2", "CB#11111111 target f2 q1 p24990");
        SetPos(k, mnq, 2);
        double t0 = 1000000;
        ChartBridgeOrders.CheckLegs(t0); ChartBridgeOrders.CheckLegs(t0 + 10000);
        Check(k.Calls.Count == 0, "long 2 with two pairs of 1: legs match, nothing done");
        SetPos(k, mnq, 1);   // a sell from elsewhere closed 1
        sent.Clear();
        ChartBridgeOrders.CheckLegs(t0 + 20000);
        ChartBridgeOrders.CheckLegs(t0 + 22000);
        Check(k.Calls.Count == 0, "legs cover 2 on a long 1: nothing done before it has held 4 seconds");
        ChartBridgeOrders.CheckLegs(t0 + 24500);
        Check(k.Calls.Count == 2 && k.Calls.All(y => y.StartsWith("cancel CB#11111111")) && k.Calls.All(y => y.Contains(" f2 ")),
              "legs cover 2 on a long 1: the newest pair is cancelled: " + string.Join(" | ", k.Calls));
        Check(sent.Any(m => m.Contains("\"level\":\"warn\"") && m.Contains("cannot open or add")), "legs check: a warning on the page");
        k2s.OrderState = OrderState.Cancelled; k2t.OrderState = OrderState.Cancelled;
        k1s.Quantity = 3; k1t.Quantity = 3;
        ChartBridgeOrders.CheckLegs(t0 + 30000);
        SetPos(k, mnq, 2);   // it changed before the check could act: the clock starts again
        ChartBridgeOrders.CheckLegs(t0 + 32000);
        ChartBridgeOrders.CheckLegs(t0 + 35000);
        Check(k.Calls.Count == 2, "a change in the position restarts the 4 seconds");
        ChartBridgeOrders.CheckLegs(t0 + 36500);
        Check(k.Calls.Count == 4 && k.Calls[2] == "change " + k1s.Name + " L0 S0 Q2" && k.Calls[3] == "change " + k1t.Name + " L0 S0 Q2",
              "one pair of 3 on a long 2: both legs shrunk to 2: " + string.Join(" | ", k.Calls.Skip(2)));
        k1s.Quantity = 2; k1t.Quantity = 2;
        SetPos(k, mnq, -1);
        ChartBridgeOrders.CheckLegs(t0 + 40000); ChartBridgeOrders.CheckLegs(t0 + 45000);
        Check(k.Calls.Count == 6 && k.Calls[4].StartsWith("cancel") && k.Calls[5].StartsWith("cancel"), "sell legs on a short position: cancelled");
        k1s.OrderState = OrderState.Cancelled; k1t.OrderState = OrderState.Cancelled;
        Order lone = Manual(k, mnq, OrderAction.Buy, OrderType.StopMarket, 1, 0, 25010, "", "CB#22222222 stop f1 q1 p25000");
        SetPos(k, mnq, 0);
        ChartBridgeOrders.CheckLegs(t0 + 50000); ChartBridgeOrders.CheckLegs(t0 + 55000);
        Check(k.Calls.Count == 7 && k.Calls[6] == "cancel " + lone.Name, "lone leg on a flat position: cancelled");
        lone.OrderState = OrderState.Cancelled;
        Manual(k, mnq, OrderAction.Sell, OrderType.StopMarket, 1, 0, 24980, "", "Stop1");
        ChartBridgeOrders.CheckLegs(t0 + 60000); ChartBridgeOrders.CheckLegs(t0 + 65000);
        Check(k.Calls.Count == 7, "orders not placed by ChartBridge are never touched by the legs check");
        Manual(k, mnq, OrderAction.Sell, OrderType.StopMarket, 1, 0, 24988, "", "CB#33333333 stop f1 q1 p24990");   // a live stop whose position has not loaded yet
        k.Connection.Status = ConnectionStatus.ConnectionLost;
        ChartBridgeOrders.CheckLegs(t0 + 70000);
        k.Connection.Status = ConnectionStatus.Connected;   // reconnecting: orders are back, positions not yet
        ChartBridgeOrders.CheckLegs(t0 + 72000); ChartBridgeOrders.CheckLegs(t0 + 80000); ChartBridgeOrders.CheckLegs(t0 + 90000);
        Check(k.Calls.Count == 7, "within 30 seconds of a reconnect: the legs check cancels nothing");
        SetPos(k, mnq, 1);   // positions loaded
        ChartBridgeOrders.CheckLegs(t0 + 105000); ChartBridgeOrders.CheckLegs(t0 + 110000);
        Check(k.Calls.Count == 7, "after the reconnect settles with the position back: the stop is kept");
        // a drop shorter than the 2 second sample: the connection event restarts the clock
        ChartBridgeOrders.WatchConnections();
        SetPos(k, mnq, 0);   // what NinjaTrader might show for a moment after a quick reconnect
        Connection.FireStatus(k.Connection, ConnectionStatus.ConnectionLost);   // lost and back between two samples
        ChartBridgeOrders.CheckLegs(t0 + 112000); ChartBridgeOrders.CheckLegs(t0 + 118000);
        Check(k.Calls.Count == 7, "a connection event between samples: nothing is cancelled for 30 seconds");
        ChartBridgeOrders.UnwatchConnections();
        SetPos(k, mnq, 1);

        // ------------------------------------------------------------ an entry that filled while ChartBridge was stopped
        Account w = NewAccount("SimW");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, DEMO-EVAL, SimK, SimW");
        Order wEntry = Manual(w, mnq, OrderAction.Buy, OrderType.Limit, 1, 24990, 0, "", "CB#0000beef s8 t16");
        wEntry.Filled = 1; wEntry.AverageFillPrice = 24990; wEntry.OrderState = OrderState.Filled;   // no update will ever come for it
        SetPos(w, mnq, 1);
        double tw = 5000000;
        ChartBridgeOrders.CheckLegs(tw); ChartBridgeOrders.CheckLegs(tw + 4500);
        Check(w.Calls.Count == 2 && w.Calls[0].StartsWith("submit CB#0000beef stop f1 q1 p24990"), "a filled entry with no legs (filled while stopped) gets them once the gap has lasted 4 s: " + string.Join(" | ", w.Calls));
        Order wEntry2 = Manual(w, mnq, OrderAction.Buy, OrderType.Limit, 1, 24990, 0, "", "CB#0000cafe s8 t0");
        wEntry2.Filled = 1; wEntry2.AverageFillPrice = 24990; wEntry2.OrderState = OrderState.Filled;
        SetPos(w, mnq, 2);
        ChartBridgeOrders.CheckLegs(tw + 10000); ChartBridgeOrders.CheckLegs(tw + 15000);
        Check(w.Calls.Count == 3 && w.Calls[2].StartsWith("submit CB#0000cafe stop f1 q1"), "a second such entry: legs for the contract the other legs do not cover");
        ChartBridgeOrders.CheckLegs(tw + 20000); ChartBridgeOrders.CheckLegs(tw + 25000);
        Check(w.Calls.Count == 3, "and never places them twice");
        Order wOld = Manual(w, mnq, OrderAction.Buy, OrderType.Limit, 1, 24990, 0, "", "CB#0000dead s8 t16");
        wOld.Filled = 1; wOld.AverageFillPrice = 24990; wOld.OrderState = OrderState.Filled;   // an old entry whose legs NinjaTrader no longer lists
        ChartBridgeOrders.CheckLegs(tw + 30000); ChartBridgeOrders.CheckLegs(tw + 35000);
        Check(w.Calls.Count == 3, "an entry whose contracts are already covered by other legs gets none (long 2, legs cover 2)");

        // ------------------------------------------------------------ event order (third review)
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, DEMO-EVAL, SimK, SimW, SimS, SimT, SimU, SimV, SimY, SimZ");
        // the 2 s scan sees a fill before its order event: it only notes the gap, the event places the legs
        Account sa = NewAccount("SimS");
        Msg("order", Order("SimS", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":2,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order se = sa.Orders[0];
        se.Filled = 1; se.AverageFillPrice = 24990; se.OrderState = OrderState.PartFilled;   // NinjaTrader set Filled; the event is not delivered yet
        double ts = 6000000;
        ChartBridgeOrders.CheckLegs(ts);
        Check(sa.Calls.Count == 1, "the scan sees a fill before its event: it only notes the gap");
        Update(sa, se);
        Check(sa.Calls.Count == 3 && sa.Calls[1].Contains(" stop f1 q1 "), "the event places the legs for that contract");
        ChartBridgeOrders.CheckLegs(ts + 5000);
        Check(sa.Calls.Count == 3, "and the scan places nothing more");
        Fill(sa, se, 2, 24990);
        Check(sa.Calls.Count == 5 && sa.Calls[3].Contains(" stop f2 q1 "), "the second contract gets its own pair: long 2 with 2 stops");
        // the position event of a stop-out lands before its order event; a new entry's fill still gets its legs
        Account ta = NewAccount("SimT");
        Msg("order", Order("SimT", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Fill(ta, ta.Orders[0], 1, 25000);
        SetPos(ta, mnq, 1);
        Msg("order", Order("SimT", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24980,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order tLimit = ta.Orders[3], tStop = ta.Orders[1];
        SetPos(ta, mnq, 0);
        ChartBridgeOrders.OnPositionUpdate(ta, new PositionEventArgs { Position = new Position { Instrument = mnq }, MarketPosition = MarketPosition.Flat, Quantity = 0 });
        tStop.Filled = 1; tStop.OrderState = OrderState.Filled; Update(ta, tStop);   // order event after the position event
        int tBefore = ta.Calls.Count;
        Fill(ta, tLimit, 1, 24980);
        Check(ta.Calls.Skip(tBefore).Any(x => x.Contains(" stop f1 q1 p24980 ")), "mixed event order: the new entry still gets its stop");
        // the cap takes the worse of the two position readings
        Account ua = NewAccount("SimU");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "1");
        SetPos(ua, mnq, 1);
        Order uExit = Manual(ua, mnq, OrderAction.Sell, OrderType.Market, 1, 0, 0, "", "exit in NinjaTrader");
        SetPos(ua, mnq, 0);
        ChartBridgeOrders.OnPositionUpdate(ua, new PositionEventArgs { Position = new Position { Instrument = mnq }, MarketPosition = MarketPosition.Flat, Quantity = 0 });
        uExit.Filled = 1; uExit.OrderState = OrderState.Filled; Update(ua, uExit);   // position event first: the ledger now holds a stale sell
        Msg("order", Order("SimU", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990"));
        Msg("order", Order("SimU", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24985"));
        Check(ua.Calls.Count == 1 && Rejected("the cap is 1"), "cap 1: a stale ledger entry cannot open room for a second buy");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "3");
        Account va = NewAccount("SimV");
        SetPos(va, mnq, 1);
        Order vExit = Manual(va, mnq, OrderAction.Sell, OrderType.Market, 1, 0, 0, "", "stop in NinjaTrader");
        SetPos(va, mnq, 0);
        ChartBridgeOrders.OnPositionUpdate(va, new PositionEventArgs { Position = new Position { Instrument = mnq }, MarketPosition = MarketPosition.Flat, Quantity = 0 });
        vExit.Filled = 1; vExit.OrderState = OrderState.Filled; Update(va, vExit);
        Msg("order", Order("SimV", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Check(va.Calls.Count == 1 && !Rejected("reduces"), "right after a stop-out, a bracketed re-entry is not refused as reducing");
        // a rejected market exit is loud
        sent.Clear();
        Order sxExit = sx.Orders[1];
        sxExit.OrderState = OrderState.Rejected;
        ChartBridgeOrders.OnOrderUpdate(sx, new OrderEventArgs { Order = sxExit, Error = ErrorCode.OrderRejected });
        Check(sent.Any(m => m.Contains("\"level\":\"error\"") && m.Contains("EXIT was REJECTED")), "a rejected market exit raises an error");
        // connection events reset only the accounts on that connection, and price-only events reset nothing
        FieldInfo csf = typeof(ChartBridgeOrders).GetField("ConnectedSince", BindingFlags.NonPublic | BindingFlags.Static);
        Dictionary<Account, double> since = (Dictionary<Account, double>)csf.GetValue(null);
        ChartBridgeOrders.WatchConnections();
        Connection.FireStatus(sa.Connection, ConnectionStatus.Connected);
        Check(since.ContainsKey(sa) && since.ContainsKey(ta), "a price-feed-only event (status unchanged) resets nothing");
        Connection.FireStatus(sa.Connection, ConnectionStatus.ConnectionLost);
        Check(!since.ContainsKey(sa) && since.ContainsKey(ta), "a status change resets only the accounts on that connection");
        ChartBridgeOrders.UnwatchConnections();
        since[sa] = 0;
        // messages with escapes are refused
        Msg("order", "{\"type\":\"order\",\"cid\":\"a\\u0062\",\"account\":\"SimU\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1}");
        Check(Rejected("escape"), "a message with a backslash escape is refused");
        // the market exit needs a fresh tick: with a 3 second old price the stop is placed instead
        Account ya = NewAccount("SimY");
        Msg("order", Order("SimY", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":16}"));
        ((Dictionary<string, double[]>)lf.GetValue(null))["MNQ"] = new double[] { 24987, ChartBridgeTime.NowUtcMs() - 3000 };
        Fill(ya, ya.Orders[0], 1, 24990);
        Check(ya.Calls.Count == 3 && ya.Calls[1].Contains(" stop f1 q1 "), "a lagging price (3 s old) does not trigger a market exit: the stop is placed");
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        // missing-stop alarm: a position ChartBridge put a stop on, whose stop is gone
        Account za = NewAccount("SimZ");
        Msg("order", Order("SimZ", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Fill(za, za.Orders[0], 1, 25000);
        SetPos(za, mnq, 1);
        za.Orders[1].OrderState = OrderState.Cancelled;   // the stop was cancelled by hand in NinjaTrader
        sent.Clear();
        double tz = 7000000;
        ChartBridgeOrders.CheckLegs(tz); ChartBridgeOrders.CheckLegs(tz + 4500);
        Check(sent.Count(m => m.Contains("\"level\":\"error\"") && m.Contains("SimZ") && m.Contains("working stops cover 0")) == 1, "a position whose ChartBridge stop is gone raises an error once");
        ChartBridgeOrders.CheckLegs(tz + 6000);
        Check(sent.Count(m => m.Contains("working stops cover 0")) == 1, "and does not repeat it every 2 seconds");

        // ------------------------------------------------------------ fourth review
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, DEMO-EVAL, SimK, SimW, SimS, SimT, SimU, SimV, SimY, SimZ, Sim4A, Sim4B, Sim4C, Sim4D, Sim4E, Sim4F");
        // the alarm fires again for the same situation on a later trade
        SetPos(za, mnq, 0);
        ChartBridgeOrders.CheckLegs(tz + 10000); ChartBridgeOrders.CheckLegs(tz + 12000);
        Msg("order", Order("SimZ", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order z2 = za.Orders[za.Orders.Count - 1];
        Fill(za, z2, 1, 25000);
        SetPos(za, mnq, 1);
        za.Orders[za.Orders.Count - 2].OrderState = OrderState.Cancelled;   // this trade's stop cancelled by hand too
        sent.Clear();
        ChartBridgeOrders.CheckLegs(tz + 20000); ChartBridgeOrders.CheckLegs(tz + 24500);
        Check(sent.Count(m => m.Contains("SimZ") && m.Contains("working stops cover 0")) == 1, "the missing-stop alarm fires again on a later trade");
        // a leg fill that leaves a position in the opposite direction is caught
        Account a4a = NewAccount("Sim4A");
        Msg("order", Order("Sim4A", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Fill(a4a, a4a.Orders[0], 1, 25000);
        SetPos(a4a, mnq, 1);   // the sell closed a long elsewhere, then its buy target filled: long 1, no sell stop
        a4a.Orders[1].OrderState = OrderState.Cancelled; a4a.Orders[2].Filled = 1; a4a.Orders[2].OrderState = OrderState.Filled;
        sent.Clear();
        double t4 = 8000000;
        ChartBridgeOrders.CheckLegs(t4); ChartBridgeOrders.CheckLegs(t4 + 4500);
        Check(sent.Any(m => m.Contains("Sim4A") && m.Contains("position is 1") && m.Contains("working stops cover 0")), "a position opposite to the bracket's direction without a stop raises the alarm");
        // a check between the order event and the position event does not forget the position
        Account a4b = NewAccount("Sim4B");
        Msg("order", Order("Sim4B", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Fill(a4b, a4b.Orders[0], 1, 25000);
        ChartBridgeOrders.CheckLegs(t4 + 10000);   // the position has not landed yet
        SetPos(a4b, mnq, 1);
        a4b.Orders[1].OrderState = OrderState.Cancelled;
        sent.Clear();
        ChartBridgeOrders.CheckLegs(t4 + 12000); ChartBridgeOrders.CheckLegs(t4 + 16500);
        Check(sent.Any(m => m.Contains("Sim4B") && m.Contains("working stops cover 0")), "a legs check before the position update does not switch the alarm off");
        // after a reload, working legs teach the alarm which positions to watch
        Account a4c = NewAccount("Sim4C");
        Manual(a4c, mnq, OrderAction.Sell, OrderType.StopMarket, 1, 0, 24988, "cb-4c4c4c4c-1", "CB#4c4c4c4c stop f1 q1 p24990").OrderState = OrderState.Cancelled;
        Manual(a4c, mnq, OrderAction.Sell, OrderType.Limit, 1, 25010, 0, "cb-4c4c4c4c-1", "CB#4c4c4c4c target f1 q1 p24990");
        SetPos(a4c, mnq, 1);
        sent.Clear();
        ChartBridgeOrders.CheckLegs(t4 + 20000); ChartBridgeOrders.CheckLegs(t4 + 24500);
        Check(sent.Any(m => m.Contains("Sim4C") && m.Contains("working stops cover 0")), "after a reload the alarm still watches positions with ChartBridge legs");
        // the scan does not settle "no legs needed" on a connection that is not steady yet
        Account a4d = NewAccount("Sim4D");
        Order d4 = Manual(a4d, mnq, OrderAction.Buy, OrderType.Limit, 1, 24990, 0, "", "CB#4d4d4d4d s8 t16");
        d4.Filled = 1; d4.AverageFillPrice = 24990; d4.OrderState = OrderState.Filled;
        since.Remove(a4d);   // just reconnected: orders listed, position not yet
        ChartBridgeOrders.CheckLegs(t4 + 30000); ChartBridgeOrders.CheckLegs(t4 + 34500);
        Check(a4d.Calls.Count == 0, "reconnecting, position not loaded: no legs yet, and nothing settled");
        SetPos(a4d, mnq, 1);   // the position loads
        ChartBridgeOrders.CheckLegs(t4 + 36000);
        Check(a4d.Calls.Count == 2 && a4d.Calls[0].Contains("CB#4d4d4d4d stop f1 q1"), "once the position loads, the filled entry gets its legs: " + string.Join(" | ", a4d.Calls));
        // a new fill restarts the gap clock
        Account a4e = NewAccount("Sim4E");
        Order e4 = Manual(a4e, mnq, OrderAction.Buy, OrderType.Limit, 2, 24990, 0, "", "CB#4e4e4e4e s8 t16");
        e4.Filled = 1; e4.AverageFillPrice = 24990; e4.OrderState = OrderState.PartFilled;
        SetPos(a4e, mnq, 1);
        ChartBridgeOrders.CheckLegs(t4 + 40000);
        e4.Filled = 2; e4.OrderState = OrderState.Filled;   // the second fill lands just before the scan would act
        ChartBridgeOrders.CheckLegs(t4 + 44100);
        Check(a4e.Calls.Count == 0, "a new fill restarts the 4 seconds");
        SetPos(a4e, mnq, 2);
        ChartBridgeOrders.CheckLegs(t4 + 48500);
        Check(a4e.Calls.Count == 2 && a4e.Calls[0].Contains(" stop f2 q2 "), "then both contracts get legs together: " + string.Join(" | ", a4e.Calls));
        // the cap: position event before order event does not block an in-cap order
        Account a4f = NewAccount("Sim4F");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "2");
        Msg("order", Order("Sim4F", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Order f4 = a4f.Orders[0];
        ChartBridgeOrders.OnPositionUpdate(a4f, new PositionEventArgs { Position = new Position { Instrument = mnq }, MarketPosition = MarketPosition.Flat, Quantity = 0 });   // what it was
        SetPos(a4f, mnq, 1);
        ChartBridgeOrders.OnPositionUpdate(a4f, new PositionEventArgs { Position = new Position { Instrument = mnq }, MarketPosition = MarketPosition.Long, Quantity = 1, AveragePrice = 25000 });
        f4.Filled = 1; f4.AverageFillPrice = 25000; f4.OrderState = OrderState.Filled; Update(a4f, f4);   // order event second
        Msg("order", Order("Sim4F", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(a4f.Calls.Count == 2, "cap 2, long 1 (position event first): buying 1 more is allowed at once");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "3");
        // a cancelled market exit is loud too
        sent.Clear();
        Order cx = Manual(sx, mnq, OrderAction.Sell, OrderType.Market, 1, 0, 0, "", "CB#5e5e5e5e exit f1 q1 p24990");
        cx.OrderState = OrderState.Cancelled;
        Update(sx, cx);
        Check(sent.Any(m => m.Contains("EXIT was CANCELLED")), "a cancelled market exit raises an error");
        // a connection event matching no account resets every account
        ChartBridgeOrders.WatchConnections();
        Connection.FireStatus(new Connection { Status = ConnectionStatus.Connected }, ConnectionStatus.ConnectionLost);
        Check(!since.ContainsKey(ta) && !since.ContainsKey(sa), "a status event from a connection no account holds resets every account (the safe side)");
        ChartBridgeOrders.UnwatchConnections();

        // ------------------------------------------------------------ nothing is kept for finished brackets
        FieldInfo idf = typeof(ChartBridgeOrders).GetField("IdOf", BindingFlags.NonPublic | BindingFlags.Static);
        System.Collections.IDictionary ids = (System.Collections.IDictionary)idf.GetValue(null);
        Account m1 = NewAccount("SimM");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, DEMO-EVAL, SimK, SimW, SimM");
        int idsBefore = ids.Count;
        for (int i = 0; i < 20; i++)
        {
            Msg("order", Order("SimM", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
            Order en = m1.Orders[m1.Orders.Count - 1];
            Fill(m1, en, 1, 25000);
            Order st = m1.Orders[m1.Orders.Count - 2], tg = m1.Orders[m1.Orders.Count - 1];
            tg.Filled = 1; tg.OrderState = OrderState.Filled; Update(m1, tg);
            st.OrderState = OrderState.Cancelled; Update(m1, st);
            SetPos(m1, mnq, 0);
            ChartBridgeOrders.OnPositionUpdate(m1, new PositionEventArgs { Position = new Position { Instrument = mnq }, MarketPosition = MarketPosition.Flat, Quantity = 0 });
        }
        Check(ids.Count == idsBefore, "20 finished brackets leave no ids behind (" + (ids.Count - idsBefore) + " left)");

        // ------------------------------------------------------------ the missing-stop alarm names a target lost with its stop (OCO)
        // Sim101, 2026-09-29: the stop was cancelled by hand and NinjaTrader's OCO cancelled the target too.
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, DEMO-EVAL, SimK, SimW, SimM, SimO1, SimO2, SimO3");
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        double tO = 9000000;
        const string ocoText = "working stops cover 0 contract(s); the target was cancelled too (OCO), so the position has no stop and no target; check NinjaTrader and add a stop";
        Account o1 = NewAccount("SimO1");
        Msg("order", Order("SimO1", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Fill(o1, o1.Orders[0], 1, 25000);
        SetPos(o1, mnq, 1);
        Order o1s = o1.Orders[1], o1t = o1.Orders[2];
        Check(RoleOf(o1s) == "stop" && RoleOf(o1t) == "target" && o1s.Oco == o1t.Oco && o1s.Oco.Length > 0, "OCO test: a stop and a target in one OCO pair");
        o1s.OrderState = OrderState.Cancelled; Update(o1, o1s);   // cancelled by hand in NinjaTrader
        o1t.OrderState = OrderState.Cancelled; Update(o1, o1t);   // NinjaTrader's OCO cancels the target
        sent.Clear();
        ChartBridgeOrders.CheckLegs(tO); ChartBridgeOrders.CheckLegs(tO + 4500);
        List<string> al = sent.Where(m => m.Contains("\"level\":\"error\"") && m.Contains("SimO1") && m.Contains("working stops cover 0")).ToList();
        Check(al.Count == 1 && al[0].Contains(ocoText), "stop cancelled and its OCO target too: the alarm says so: " + string.Join(" | ", al));
        Check(al.Count == 1 && al[0].Contains("the position is 1 but ChartBridge's working stops cover 0 contract(s)"), "the alarm keeps its old prefix, so a search for the old text still finds it");
        ChartBridgeOrders.CheckLegs(tO + 6000);
        Check(sent.Count(m => m.Contains("SimO1") && m.Contains("working stops cover 0")) == 1, "and says it once");
        // the other way round: the target's event first, and the stop rejected rather than cancelled
        Account o2 = NewAccount("SimO2");
        Msg("order", Order("SimO2", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Fill(o2, o2.Orders[0], 1, 25000);
        SetPos(o2, mnq, -1);
        o2.Orders[1].OrderState = OrderState.Rejected; o2.Orders[2].OrderState = OrderState.Cancelled;
        Update(o2, o2.Orders[2]); Update(o2, o2.Orders[1]);
        sent.Clear();
        ChartBridgeOrders.CheckLegs(tO + 10000); ChartBridgeOrders.CheckLegs(tO + 14500);
        Check(sent.Any(m => m.Contains("SimO2") && m.Contains("position is -1") && m.Contains(ocoText)), "short, stop rejected, target event first: the alarm names the lost target too");
        // pairs ChartBridge cancels itself (Flatten) are not called lost, even if the position lingers
        Account o3 = NewAccount("SimO3");
        Msg("order", Order("SimO3", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Fill(o3, o3.Orders[0], 1, 25000);
        SetPos(o3, mnq, 1);
        Msg("flatten", "{\"type\":\"flatten\",\"account\":\"SimO3\",\"root\":\"MNQ\"}");
        Check(o3.Calls.Last() == "flatten MNQ 12-26", "OCO test: flatten sent");
        o3.Orders[1].OrderState = OrderState.Cancelled; Update(o3, o3.Orders[1]);
        o3.Orders[2].OrderState = OrderState.Cancelled; Update(o3, o3.Orders[2]);
        sent.Clear();
        ChartBridgeOrders.CheckLegs(tO + 20000); ChartBridgeOrders.CheckLegs(tO + 24500);
        List<string> al3 = sent.Where(m => m.Contains("SimO3") && m.Contains("working stops cover 0")).ToList();
        Check(al3.Count == 1 && !al3[0].Contains("OCO"), "legs cancelled by Flatten: the alarm (position still open) does not blame an OCO cancel: " + string.Join(" | ", al3));
        // the reviewer's P4: the TARGET is rejected first and the OCO cancels the stop; the alarm says which went first
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, DEMO-EVAL, SimK, SimW, SimM, SimO1, SimO2, SimO3, SimP4");
        Account p4 = NewAccount("SimP4");
        Msg("order", Order("SimP4", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Fill(p4, p4.Orders[0], 1, 25000);
        SetPos(p4, mnq, 1);
        Order p4s = p4.Orders[1], p4t = p4.Orders[2];
        p4t.OrderState = OrderState.Rejected; Update(p4, p4t);   // the target is rejected
        p4s.OrderState = OrderState.Cancelled; Update(p4, p4s);  // and NinjaTrader's OCO cancels the stop
        sent.Clear();
        ChartBridgeOrders.CheckLegs(tO + 26000); ChartBridgeOrders.CheckLegs(tO + 30500);
        List<string> al5 = sent.Where(m => m.Contains("SimP4") && m.Contains("working stops cover 0")).ToList();
        Check(al5.Count == 1 && al5[0].Contains("working stops cover 0 contract(s); the target was rejected and the stop was cancelled with it (OCO), so the position has no stop and no target; check NinjaTrader and add a stop")
              && !al5[0].Contains("cancelled too"), "target rejected first, the stop cancelled by its OCO: the alarm says the target went first: " + string.Join(" | ", al5));
        // both cancelled, the target first (cancelled by hand, the OCO took the stop): event order decides
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, DEMO-EVAL, SimK, SimW, SimM, SimO1, SimO2, SimO3, SimP4, SimP5");
        Account p5 = NewAccount("SimP5");
        Msg("order", Order("SimP5", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Fill(p5, p5.Orders[0], 1, 25000);
        SetPos(p5, mnq, 1);
        p5.Orders[2].OrderState = OrderState.Cancelled; Update(p5, p5.Orders[2]);   // target cancelled while the stop still works
        p5.Orders[1].OrderState = OrderState.Cancelled; Update(p5, p5.Orders[1]);   // then the OCO cancels the stop
        sent.Clear();
        ChartBridgeOrders.CheckLegs(tO + 26000); ChartBridgeOrders.CheckLegs(tO + 30500);
        Check(sent.Count(m => m.Contains("SimP5") && m.Contains("working stops cover 0 contract(s); the target was cancelled and the stop was cancelled with it (OCO), so the position has no stop and no target")) == 1,
              "target cancelled first, then its OCO stop: the alarm says the target went first");
        // the bookkeeping before Flatten and Cancel can never stop them: make it throw
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, DEMO-EVAL, SimK, SimW, SimM, SimO1, SimO2, SimO3, SimP4, SimP5, SimQ");
        Account q = NewAccount("SimQ");
        Msg("order", Order("SimQ", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Fill(q, q.Orders[0], 1, 25000);
        SetPos(q, mnq, 1);
        ChartBridgeOrders.BookkeepingFault = () => { throw new InvalidOperationException("test fault"); };
        lock (NinjaTrader.Code.Output.Lines) NinjaTrader.Code.Output.Lines.Clear();
        sent.Clear();
        Msg("flatten", "{\"type\":\"flatten\",\"account\":\"SimQ\",\"root\":\"MNQ\"}");
        bool logged;
        lock (NinjaTrader.Code.Output.Lines) logged = NinjaTrader.Code.Output.Lines.Any(x => x.Contains("bookkeeping error before a flatten (test fault); the flatten is sent anyway"));
        Check(q.Calls.Last() == "flatten MNQ 12-26" && !sent.Any(m => m.Contains("\"type\":\"reject\"")) && logged,
              "a throwing bookkeeping step still sends Flatten (no reject), and logs the error: " + q.Calls.Last());
        SetPos(q, mnq, 0);
        Age(q.Orders[1], 5000); Age(q.Orders[2], 5000);
        int qn = q.Calls.Count;
        ChartBridgeOrders.OnPositionUpdate(q, new PositionEventArgs { Position = new Position { Instrument = mnq }, MarketPosition = MarketPosition.Flat, Quantity = 0 });
        Check(After(q, qn).Count(x => x.StartsWith("cancel CB#")) == 2, "a throwing bookkeeping step still cancels leftover legs when flat: " + string.Join(" | ", After(q, qn)));
        ChartBridgeOrders.BookkeepingFault = null;
        Done(q);
        // a stop cancelled while its target still works: the plain alarm, no OCO words
        SetPos(o1, mnq, 0);
        ChartBridgeOrders.CheckLegs(tO + 30000);   // flat: the lost target of the last trade is forgotten
        Msg("order", Order("SimO1", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order o1e = o1.Orders[o1.Orders.Count - 1];
        Fill(o1, o1e, 1, 25000);
        SetPos(o1, mnq, 1);
        Order o1s2 = o1.Orders[o1.Orders.Count - 2];
        Check(RoleOf(o1s2) == "stop", "OCO test: second trade's stop found");
        o1s2.OrderState = OrderState.Cancelled; Update(o1, o1s2);
        sent.Clear();
        ChartBridgeOrders.CheckLegs(tO + 40000); ChartBridgeOrders.CheckLegs(tO + 44500);
        List<string> al4 = sent.Where(m => m.Contains("SimO1") && m.Contains("working stops cover 0")).ToList();
        Check(al4.Count == 1 && !al4[0].Contains("OCO") && al4[0].Contains("working stops cover 0 contract(s); check NinjaTrader and add a stop"),
              "next trade, stop cancelled but target working: plain alarm (the last trade's lost target was forgotten when flat): " + string.Join(" | ", al4));

        // ------------------------------------------------------------ gate 7: rate limit
        System.Threading.Thread.Sleep(1100);
        lock (c.Actions) c.Actions.Clear();
        int before = sim.Calls.Count;
        targetB.OrderState = OrderState.Working;
        Update(sim, targetB);
        idB = IdOf(targetB);
        for (int i = 0; i < 12; i++) ChartBridgeOrders.OnMessage(c, "cancel", "{\"type\":\"cancel\",\"id\":\"" + idB + "\"}");
        Check(sim.Calls.Count - before == 10 && Rejected("too many order actions"), "rate limit: 10 in a second, the rest refused (" + (sim.Calls.Count - before) + ")");

        // ------------------------------------------------------------ positions to the page
        sent.Clear();
        ChartBridgeOrders.OnPositionUpdate(sim, new PositionEventArgs { Position = new Position { Instrument = mnq }, MarketPosition = MarketPosition.Short, Quantity = 2, AveragePrice = 25001.25 });
        Check(sent.Count == 1 && sent[0].Contains("\"qty\":-2") && sent[0].Contains("\"avgPrice\":25001.25"), "position: short 2 sent signed");
        ChartBridgeOrders.OnPositionUpdate(other, new PositionEventArgs { Position = new Position { Instrument = mnq }, MarketPosition = MarketPosition.Long, Quantity = 1, AveragePrice = 1 });
        Check(sent.Count == 1, "position on a non-trading account is not sent");
        ChartBridgeOrders.OnPositionUpdate(sim, new PositionEventArgs { Position = new Position { Instrument = es }, MarketPosition = MarketPosition.Long, Quantity = 1, AveragePrice = 1 });
        Check(sent.Count == 1, "position on a contract ChartBridge does not serve is not sent");

        PlannedChecks();   // 0.3.8: a resting entry's planned stop and target, ticks from its fill (the ATM rule); 0.3.7: no distance limits unless config.txt sets them

        // ------------------------------------------------------------ turning trading off stops every order action
        ChartBridgeOrders.ResetConfig();
        int n = sim.Calls.Count;
        Msg("flatten", "{\"type\":\"flatten\",\"account\":\"Sim101\",\"root\":\"MNQ\"}");
        Check(Rejected("trading is off") && sim.Calls.Count == n, "after config reset: refused");

        NetworkChecks();
        DeskQueueChecks();
        SeamHarness.Run(Check);  // where the backfill meets the live trades (check/SeamHarness.cs, 0.3.3)
        SidesHarness.Run(Check); // the side of every trade, as pure rules (check/SidesHarness.cs, 0.3.4; its loads run inside SeamHarness)
        PinHarness.Run(Check);   // the PIN on ChartBridge's own page (check/PinHarness.cs)
        MarketsHarness.Run(Check);   // 0.4.0: quote-only markets, their rolls and settlement times, tape counters, error lines, /diag health (check/MarketsHarness.cs)
        Console.WriteLine("== base: " + checks + " checks, " + fails + " failed");
        Section("accounts (B2)", AccountsHarness.Run);  // 0.4.0: the per-account checkmark, Gone, Archive, cancel from the Working orders tab, switches off = 0.3.8 (check/AccountsHarness.cs)
        Section("merge (B4)", MergeHarness.Run);        // 0.4.0 B4: Merge stops and targets (check/MergeHarness.cs)
        Section("copier (B5)", CopierHarness.Run);      // 0.4.0 copier: Anthony's Sim test list against the copier engine (check/CopierHarness.cs)
        Section("bot (B3)", BotHarness.Run);            // 0.4.0: the bot channel, Sim101 only, its rails, heartbeat, secret and off switch (check/BotHarness.cs)
        Section("strategies (B1)", StrategiesHarness.Run);   // 0.4.0 B1: stop-limit and MIT entries, Order Strategies, breakeven and trailing, managed.txt (check/StrategiesHarness.cs)
        Section("cross-lane rules (integration)", IntegrationHarness.Run);   // 0.4.0: the rules that hold only with every lane together (check/IntegrationHarness.cs)

        Console.WriteLine("== total: " + checks + " checks");
        Console.WriteLine(fails == 0 ? "ALL PASSED" : fails + " FAILED");
        return fails == 0 ? 0 : 1;
    }
    // ------------------------------------------------------------ 0.3.7 and 0.3.8: planned stop and target on resting entries (Anthony's rulings, 2026-10-01)
    static Order Newest(Account a) { return a.Orders[a.Orders.Count - 1]; }
    static string Ord(string account, string rest) { return Order(account, rest); }
    static string PlanMsg(string id, string rest) { return "{\"type\":\"plan\",\"cid\":\"p\",\"id\":\"" + id + "\"" + (rest.Length > 0 ? "," + rest : "") + "}"; }
    static string LastOrderMsg(Order o) { string id = IdOf(o); for (int i = sent.Count - 1; i >= 0; i--) if (sent[i].Contains("\"type\":\"order\"") && sent[i].Contains("\"id\":\"" + id + "\"")) return sent[i]; return ""; }
    static string PlanFilePath() { return Path.Combine(NinjaTrader.Core.Globals.UserDataDir, "ChartBridge", "planned_brackets.txt"); }
    static string PlanFileText() { try { return File.ReadAllText(PlanFilePath()); } catch (Exception) { return ""; } }
    static bool Alarmed(string contains) { return sent.Any(m => m.Contains("\"level\":\"error\"") && m.Contains(contains)); }
    static void Recompile() { ChartBridgeOrders.Clear(); ChartBridgeOrders.NoteLast("MNQ", 25000); ChartBridgeOrders.LoadPlansNow(); }

    static void PlannedChecks()
    {
        ChartBridgeOrders.PlanReadRetryMs = 10; ChartBridgeOrders.PlanWriteRetryMs = 5;   // the harness: retries without the waits
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, SimN1, SimN2, SimN3, SimN4, SimN5, SimN6, SimN7, SimN8, SimN9, SimNA, SimNB, SimNC, SimND, SimNE");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "5");
        ChartBridgeOrders.NoteLast("MNQ", 25000);

        // ---- 0.3.7: no 200-tick limits; optional limits in config.txt
        Account n1 = NewAccount("SimN1");
        Msg("order", Ord("SimN1", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24750,\"bracket\":{\"stop\":500,\"target\":500}"));
        Check(n1.Calls.Count == 1 && Regex.IsMatch(n1.Calls[0], "^submit CB#[0-9a-f]{8} atm s500 t500 Buy Limit 1 L24750 S0 oco:$"),
              "no config limit: a limit 1000 ticks from the last price with a 500-tick bracket is accepted (atm s500 t500): " + (n1.Calls.Count > 0 ? n1.Calls[0] : LastSent()));
        Msg("order", Ord("SimN1", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":500,\"target\":1000}"));
        Order m500 = Newest(n1);
        Check(n1.Calls.Count == 2 && Regex.IsMatch(m500.Name, "^CB#[0-9a-f]{8} s500 t1000$"), "no config limit: a market entry with a 500 / 1000 tick bracket is accepted: " + m500.Name);
        Fill(n1, m500, 1, 25000);
        Check(n1.Calls.Count == 4 && n1.Calls[2].EndsWith("Sell StopMarket 1 L0 S24875 oco:cb-" + Tag(m500) + "-1") && n1.Calls[3].EndsWith("Sell Limit 1 L25250 S0 oco:cb-" + Tag(m500) + "-1"),
              "market entry: legs 500 and 1000 ticks from the fill: " + string.Join(" | ", After(n1, 2)));
        Msg("order", Ord("SimN1", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":100001,\"target\":8}"));
        Check(Rejected("at or below zero") && n1.Calls.Count == 4, "a market bracket that would put the stop below zero is refused");
        Msg("order", Ord("SimN1", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":99996,\"target\":8}"));
        Check(Rejected("at or below zero") && n1.Calls.Count == 4, "a limit bracket that would put the stop at or below zero is refused (never read as no stop)");
        ChartBridgeOrders.ReadConfig("maxTicksAway", "400");
        ChartBridgeOrders.ReadConfig("maxBracketTicks", "300");
        Check(ChartBridgeOrders.TradingJson(true, null).Contains("\"maxTicksAway\":400,\"maxBracketTicks\":300}"), "the trading message names the config limits when set: " + ChartBridgeOrders.TradingJson(true, null));
        Msg("order", Ord("SimN1", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24750,\"bracket\":{\"stop\":8,\"target\":16}"));
        Check(Rejected("more than 400 ticks from the last price 25000 (maxTicksAway in config.txt)") && n1.Calls.Count == 4, "maxTicksAway = 400: the 1000-tick limit is refused");
        Msg("order", Ord("SimN1", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24900,\"bracket\":{\"stop\":500,\"target\":8}"));
        Check(Rejected("from 0 to 300 (maxBracketTicks in config.txt)") && n1.Calls.Count == 4, "maxBracketTicks = 300: a 500-tick bracket is refused");
        Msg("order", Ord("SimN1", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":301,\"target\":8}"));
        Check(Rejected("from 0 to 300") && n1.Calls.Count == 4, "maxBracketTicks = 300: a market bracket of 301 ticks is refused");
        Msg("plan", PlanMsg(IdOf(n1.Orders[0]), "\"stopTicks\":301"));
        Check(Rejected("stopTicks must be at most 300 (maxBracketTicks in config.txt)"), "maxBracketTicks = 300: a plan of 301 ticks is refused");
        lock (NinjaTrader.Code.Output.Lines) NinjaTrader.Code.Output.Lines.Clear();
        ChartBridgeOrders.ReadConfig("maxTicksAway", "4OO");
        bool said; lock (NinjaTrader.Code.Output.Lines) said = NinjaTrader.Code.Output.Lines.Any(x => x.Contains("maxTicksAway = 4OO is not a whole number") && x.Contains("NO maxTicksAway limit"));
        Check(ChartBridgeOrders.MaxTicksAway == 0 && said, "a maxTicksAway that is not a whole number is ignored, said in the Output window");
        ChartBridgeOrders.ResetConfig();
        Check(ChartBridgeOrders.MaxTicksAway == 0 && ChartBridgeOrders.MaxBracketTicks == 0, "config reset: no limits (absent means none)");
        ChartBridgeOrders.ReadConfig("trading", "true");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, SimN1, SimN2, SimN3, SimN4, SimN5, SimN6, SimN7, SimN8, SimN9, SimNA, SimNB, SimNC, SimND, SimNE");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "5");

        // a 4-digit tick bracket in a 0.3.6-style name after a recompile
        Account n2 = NewAccount("SimN2");
        Order oldE = Manual(n2, mnq, OrderAction.Buy, OrderType.Limit, 2, 24990, 0, "", "CB#0ddba110 s1200 t2400");
        oldE.Filled = 1; oldE.AverageFillPrice = 24990; oldE.OrderState = OrderState.PartFilled;
        Manual(n2, mnq, OrderAction.Sell, OrderType.StopMarket, 1, 0, 24690, "cb-0ddba110-1", "CB#0ddba110 stop f1 q1 p24990");
        Manual(n2, mnq, OrderAction.Sell, OrderType.Limit, 1, 25590, 0, "cb-0ddba110-1", "CB#0ddba110 target f1 q1 p24990");
        Recompile();
        oldE.Filled = 2; oldE.AverageFillPrice = (24990 + 24980) / 2.0; oldE.OrderState = OrderState.Filled;
        Update(n2, oldE);
        Check(n2.Calls.Count == 2 && n2.Calls[0] == "submit CB#0ddba110 stop f2 q1 p24980 Sell StopMarket 1 L0 S24680 oco:cb-0ddba110-2" && n2.Calls[1] == "submit CB#0ddba110 target f2 q1 p24980 Sell Limit 1 L25580 S0 oco:cb-0ddba110-2",
              "after a recompile, a 0.3.6 name with a 4-digit bracket (s1200 t2400) recovers: the next fill gets its pair 1200 / 2400 ticks from its own price: " + string.Join(" | ", n2.Calls));

        // ---- 0.3.8 (Anthony's ATM rule): ticks from each actual fill, travelling with the entry
        Account n3 = NewAccount("SimN3");
        sent.Clear();
        Msg("order", Ord("SimN3", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":3,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order e3 = Newest(n3);
        string t3 = Tag(e3);
        Check(n3.Calls.Count == 1 && e3.Name == "CB#" + t3 + " atm s8 t16", "a resting entry is named atm with its ticks: " + e3.Name);
        Check(PlanFileText().Contains(t3 + " ticks 8 16 "), "and its ticks are in planned_brackets.txt: " + PlanFileText());
        Update(n3, e3);
        Check(LastOrderMsg(e3).Contains("\"role\":\"entry\"") && LastOrderMsg(e3).Contains(",\"planned\":{\"stopTicks\":8,\"targetTicks\":16}"), "the order event tells the page the planned ticks: " + LastOrderMsg(e3));
        Fill(n3, e3, 1, 24990);
        Fill(n3, e3, 2, (24990 + 24985) / 2.0);
        Fill(n3, e3, 3, (24990 + 24985 + 24988) / 3.0);
        Check(After(n3, 1).SequenceEqual(new[] {
                  "submit CB#" + t3 + " stop f1 q1 p24990 Sell StopMarket 1 L0 S24988 oco:cb-" + t3 + "-1", "submit CB#" + t3 + " target f1 q1 p24990 Sell Limit 1 L24994 S0 oco:cb-" + t3 + "-1",
                  "submit CB#" + t3 + " stop f2 q1 p24985 Sell StopMarket 1 L0 S24983 oco:cb-" + t3 + "-2", "submit CB#" + t3 + " target f2 q1 p24985 Sell Limit 1 L24989 S0 oco:cb-" + t3 + "-2",
                  "submit CB#" + t3 + " stop f3 q1 p24988 Sell StopMarket 1 L0 S24986 oco:cb-" + t3 + "-3", "submit CB#" + t3 + " target f3 q1 p24988 Sell Limit 1 L24992 S0 oco:cb-" + t3 + "-3" }),
              "fills at the limit, better on a gap, and another price: every increment's legs 8 / 16 ticks from its own fill: " + string.Join(" | ", After(n3, 1)));
        Check(WaitFor(() => !PlanFileText().Contains(t3), 5000), "the entry done and covered: its line leaves planned_brackets.txt");
        // HOME 2026-10-01: placed low, dragged up to where it fills; the stop and target follow it (0.3.7 measured them from the placement price)
        Account n4 = NewAccount("SimN4");
        Msg("order", Ord("SimN4", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24950,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order e4 = Newest(n4);
        Msg("change", "{\"type\":\"change\",\"id\":\"" + IdOf(e4) + "\",\"price\":24990}");
        Check(n4.Calls.Last() == "change " + e4.Name + " L24990 S0 Q0", "the entry dragged up 10 points, past where its stop and target were: never refused: " + LastSent());
        e4.LimitPrice = 24990;
        Fill(n4, e4, 1, 24990);
        Check(After(n4, 2).Count == 2 && After(n4, 2)[0].EndsWith("S24988 oco:cb-" + Tag(e4) + "-1") && After(n4, 2)[1].EndsWith("L24994 S0 oco:cb-" + Tag(e4) + "-1"),
              "and when it fills the legs are 8 / 16 ticks from the fill, not from where it was placed: " + string.Join(" | ", After(n4, 2)));
        Msg("order", Ord("SimN4", "\"side\":\"sell\",\"kind\":\"limit\",\"qty\":1,\"price\":25010,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order e4s = Newest(n4);
        Msg("change", "{\"type\":\"change\",\"id\":\"" + IdOf(e4s) + "\",\"price\":25030}");
        Check(n4.Calls.Last() == "change " + e4s.Name + " L25030 S0 Q0", "a sell entry dragged up past its stop: never refused");
        // a gap through where the stop would be: from the actual fill, so the stop is placed (no market exit without a trade through it)
        Account n5 = NewAccount("SimN5");
        Msg("order", Ord("SimN5", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order e5 = Newest(n5);
        sent.Clear();
        ChartBridgeOrders.NoteLast("MNQ", 24979);
        Fill(n5, e5, 1, 24978);   // a gap down through 24988: filled 12 ticks better
        Check(After(n5, 1).Count == 2 && After(n5, 1)[0].EndsWith("S24976 oco:cb-" + Tag(e5) + "-1") && After(n5, 1)[1].EndsWith("L24982 S0 oco:cb-" + Tag(e5) + "-1") && !Alarmed("passed the stop level"),
              "a gap fill: the legs are 8 / 16 ticks from the actual fill (24976 / 24982), the stop on the right side of it, no market exit: " + string.Join(" | ", After(n5, 1)));
        Msg("order", Ord("SimN5", "\"side\":\"buy\",\"kind\":\"stop\",\"qty\":1,\"price\":25010,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order e5s = Newest(n5);
        int c5 = n5.Calls.Count;
        ChartBridgeOrders.NoteLast("MNQ", 25013);
        Fill(n5, e5s, 1, 25013);   // slippage
        Check(After(n5, c5).Count == 2 && After(n5, c5)[0].EndsWith("S25011 oco:cb-" + Tag(e5s) + "-1") && After(n5, c5)[1].EndsWith("L25017 S0 oco:cb-" + Tag(e5s) + "-1"),
              "a stop entry with 3 ticks slippage: legs from the actual fill: " + string.Join(" | ", After(n5, c5)));
        Msg("order", Ord("SimN5", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":25010,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order e5x = Newest(n5);
        c5 = n5.Calls.Count;
        sent.Clear();
        ChartBridgeOrders.NoteLast("MNQ", 25007);   // a trade in the last 2 s went through 25008 before the fill was handled
        Fill(n5, e5x, 1, 25010);
        Check(After(n5, c5).Count == 1 && After(n5, c5)[0] == "submit CB#" + Tag(e5x) + " exit f1 q1 p25010 Sell Market 1 L0 S0 oco:" && Alarmed("price had already passed the stop level 25008 (last 25007)"),
              "a recent trade through the stop level: the market exit, with its alarm: " + string.Join(" | ", After(n5, c5)));
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        // old-page messages: market, limit and stop entries all ticks from the fill; the 0.3.7 price keys are gone
        Account n6 = NewAccount("SimN6");
        Msg("order", Ord("SimN6", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"stopPrice\":24980"));
        Check(Rejected("unknown key \\\"stopPrice\\\" in order"), "stopPrice (0.3.7) is an unknown key now: refused");
        Msg("order", Ord("SimN6", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Order m6 = Newest(n6);
        Update(n6, m6);
        Check(!LastOrderMsg(m6).Contains("planned"), "a market entry's order event has no planned key");
        Msg("order", Ord("SimN6", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990"));
        Order e6n = Newest(n6);
        Update(n6, e6n);
        Check(e6n.Name == "CB#" + Tag(e6n) + " atm s0 t0" && LastOrderMsg(e6n).Contains(",\"planned\":{\"stopTicks\":null,\"targetTicks\":null}"), "a limit with no bracket: planned null / null on the page: " + LastOrderMsg(e6n));

        // ---- plan: set, change and remove the distances before or between fills
        Account n8 = NewAccount("SimN8");
        Msg("order", Ord("SimN8", "\"side\":\"sell\",\"kind\":\"limit\",\"qty\":3,\"price\":25010"));
        Order e8 = Newest(n8);
        string id8 = IdOf(e8), t8 = Tag(e8);
        sent.Clear();
        Msg("plan", PlanMsg(id8, "\"targetTicks\":40"));
        Check(LastOrderMsg(e8).Contains(",\"planned\":{\"stopTicks\":null,\"targetTicks\":40}") && PlanFileText().Contains(t8 + " ticks 0 40 "), "add a target to a limit placed without one: " + LastOrderMsg(e8));
        Msg("plan", PlanMsg(id8, "\"stopTicks\":40"));
        Check(LastOrderMsg(e8).Contains(",\"planned\":{\"stopTicks\":40,\"targetTicks\":40}") && PlanFileText().Contains(t8 + " ticks 40 40 "), "add a stop (the target is kept): " + LastOrderMsg(e8));
        foreach (string[] bad in new[] { new[] { "\"stopTicks\":0", "stopTicks must be a whole number of 1 or more, or null" }, new[] { "\"stopTicks\":2.5", "stopTicks must be a whole number" },
                                         new[] { "\"stopTicks\":\"12\"", "stopTicks must be a whole number" }, new[] { "\"targetTicks\":-3", "targetTicks must be a whole number" },
                                         new[] { "", "plan needs stopTicks or targetTicks" }, new[] { "\"stopTicks\":12,\"qty\":2", "unknown key \\\"qty\\\" in plan" },
                                         new[] { "\"stopPrice\":25020", "unknown key \\\"stopPrice\\\" in plan" }, new[] { "\"stopTicks\":12,\"stopTicks\":14", "key twice" } })
        {
            Msg("plan", PlanMsg(id8, bad[0]));
            Check(Rejected(bad[1]) && LastOrderMsg(e8).Contains("\"stopTicks\":40,"), "plan " + (bad[0].Length > 0 ? bad[0] : "(no key)") + ": refused (" + bad[1] + ")");
        }
        Msg("plan", PlanMsg(id8, "\"stopTicks\":60"));
        Check(LastOrderMsg(e8).Contains("\"planned\":{\"stopTicks\":60,\"targetTicks\":40}"), "change the stop (a drag of the planned stop line): " + LastOrderMsg(e8));
        Check(n8.Calls.Count == 1, "plan changes send nothing to NinjaTrader");
        ChartBridgeOrders.NoteLast("MNQ", 25012);
        Fill(n8, e8, 1, 25010);
        Check(After(n8, 1).Count == 2 && After(n8, 1)[0].EndsWith("Buy StopMarket 1 L0 S25025 oco:cb-" + t8 + "-1") && After(n8, 1)[1].EndsWith("Buy Limit 1 L25000 S0 oco:cb-" + t8 + "-1"),
              "first part: legs 60 / 40 ticks from the fill: " + string.Join(" | ", After(n8, 1)));
        Msg("plan", PlanMsg(id8, "\"targetTicks\":null"));
        Check(LastOrderMsg(e8).Contains("\"planned\":{\"stopTicks\":60,\"targetTicks\":null}") && n8.Calls.Count == 3, "remove the target while part filled: the working pair untouched");
        Fill(n8, e8, 2, (25010 + 25011) / 2.0);
        Check(After(n8, 3).Count == 1 && After(n8, 3)[0] == "submit CB#" + t8 + " stop f2 q1 p25011 Buy StopMarket 1 L0 S25026 oco:", "second part: a lone stop 60 ticks from its own fill: " + string.Join(" | ", After(n8, 3)));
        Msg("plan", PlanMsg(id8, "\"stopTicks\":20,\"targetTicks\":20"));
        Fill(n8, e8, 3, (25010 + 25011 + 25010) / 3.0);
        Check(After(n8, 4).Count == 2 && After(n8, 4)[0].EndsWith("S25015 oco:cb-" + t8 + "-3") && After(n8, 4)[1].EndsWith("L25005 S0 oco:cb-" + t8 + "-3") && !n8.Calls.Any(x => x.StartsWith("change") || x.StartsWith("cancel")),
              "third part: the new distances; earlier legs never changed or cancelled: " + string.Join(" | ", After(n8, 4)));
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Msg("plan", PlanMsg(id8, "\"stopTicks\":4"));
        Check(Rejected("no working order") || Rejected("no longer working"), "plan on a filled entry: refused");
        string legId = IdOf(n8.Orders[1]);
        Msg("plan", PlanMsg(legId, "\"stopTicks\":4"));
        Check(Rejected("only a ChartBridge entry"), "plan on a bracket leg: refused (legs move with change)");
        Order old36 = Manual(n8, mnq, OrderAction.Sell, OrderType.Limit, 1, 25010, 0, "", "CB#0ddba111 s8 t16");
        Update(n8, old36);
        Msg("plan", PlanMsg(IdOf(old36), "\"stopTicks\":12"));
        Check(LastOrderMsg(old36).Contains("\"planned\":{\"stopTicks\":12,\"targetTicks\":16}") && PlanFileText().Contains("0ddba111 ticks 12 16 "), "plan on a resting entry placed by 0.3.6 (s8 t16): accepted, its line written");
        Account n7 = NewAccount("SimN7");
        Msg("order", Ord("SimN7", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Msg("plan", PlanMsg(IdOf(Newest(n7)), "\"stopTicks\":8"));
        Check(Rejected("only a resting limit or stop entry"), "plan on a market entry: refused");
        Account n9 = NewAccount("SimN9");
        SetPos(n9, mnq, 2);
        Msg("order", Ord("SimN9", "\"side\":\"sell\",\"kind\":\"limit\",\"qty\":1,\"price\":25010"));
        Msg("plan", PlanMsg(IdOf(Newest(n9)), "\"stopTicks\":8"));
        Check(Rejected("opens or adds"), "adding a stop to an entry that reduces the position: refused");
        ChartBridgeOrders.ReadConfig("trading", "false");
        Msg("plan", PlanMsg(IdOf(Newest(n9)), "\"stopTicks\":8"));
        Check(Rejected("trading is off"), "plan with trading off: refused");
        ChartBridgeOrders.ReadConfig("trading", "true");

        // ---- persistence: a recompile or restart while resting, after a plan
        Account na = NewAccount("SimNA");
        Msg("order", Ord("SimNA", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":2,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order ea = Newest(na);
        string ta = Tag(ea);
        Msg("plan", PlanMsg(IdOf(ea), "\"stopTicks\":12,\"targetTicks\":24"));
        Recompile();
        ChartBridgeOrders.Resume();
        sent.Clear();
        Msg("auth", "{\"type\":\"auth\",\"token\":\"" + ChartBridgeOrders.SessionJson().Split('"')[3] + "\"}");
        string snap = sent.FirstOrDefault(m => m.Contains("\"type\":\"orders\"")) ?? "";
        Check(snap.Contains("\"planned\":{\"stopTicks\":12,\"targetTicks\":24}"), "after a restart the orders snapshot has the changed planned ticks: " + snap);
        Fill(na, ea, 1, 24990);
        Check(After(na, 1).Count == 2 && After(na, 1)[0].EndsWith("S24987 oco:cb-" + ta + "-1") && After(na, 1)[1].EndsWith("L24996 S0 oco:cb-" + ta + "-1") && !Alarmed("could not be read"),
              "after a restart while resting, the fill gets legs at the changed ticks (from planned_brackets.txt): " + string.Join(" | ", After(na, 1)));
        Recompile();
        Fill(na, ea, 2, (24990 + 24988) / 2.0);
        Check(After(na, 3).Count == 2 && After(na, 3)[0] == "submit CB#" + ta + " stop f2 q1 p24988 Sell StopMarket 1 L0 S24985 oco:cb-" + ta + "-2",
              "a recompile while part filled: the next part still gets the changed ticks, once: " + string.Join(" | ", After(na, 3)));
        Check(WaitFor(() => !PlanFileText().Contains(ta), 5000), "done and covered: its line leaves planned_brackets.txt");
        // missing record: the ticks the entry was placed with (its name), never a guess, and an alarm
        Account nb = NewAccount("SimNB");
        Msg("order", Ord("SimNB", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order eb = Newest(nb);
        Msg("plan", PlanMsg(IdOf(eb), "\"stopTicks\":20"));
        File.Delete(PlanFilePath());
        Recompile();
        sent.Clear();
        Update(nb, eb);
        Check(Alarmed("planned stop and target of entry CB#" + Tag(eb) + " could not be read") && Alarmed("it will use the ticks it was placed with, stop 8 / target 16 ticks"),
              "missing record while resting: an alarm, naming the ticks it will use: " + string.Join(" | ", sent.Where(m => m.Contains("could not be read"))));
        Check(LastOrderMsg(eb).Contains("\"planned\":{\"stopTicks\":8,\"targetTicks\":16}"), "and the page is shown the ticks that will be used");
        sent.Clear();
        Fill(nb, eb, 1, 24990);
        Check(After(nb, 1).Count == 2 && After(nb, 1)[0].EndsWith("S24988 oco:cb-" + Tag(eb) + "-1") && Alarmed("its legs go at the ticks it was placed with"),
              "missing record at the fill: legs at the placement ticks from the name, and the alarm again: " + string.Join(" | ", After(nb, 1)));

        // ---- entries placed by 0.3.7 (planned prices) still resting after the upgrade: converted once, to the ticks they show now
        Account nc = NewAccount("SimNC");
        Order e37 = Manual(nc, mnq, OrderAction.Buy, OrderType.Limit, 1, 24990, 0, "", "CB#0ddba371 plan s24980 t25010");
        Order e37b = Manual(nc, mnq, OrderAction.Buy, OrderType.Limit, 1, 24990, 0, "", "CB#0ddba372 plan s24980 t25010");
        File.AppendAllText(PlanFilePath(), "0ddba371 24975 25020 " + (long)ChartBridgeTime.NowUtcMs() + "\n");   // its 0.3.7 line: the planned prices after a drag
        Recompile();
        sent.Clear();
        Update(nc, e37); Update(nc, e37b);
        Check(sent.Any(m => m.Contains("\"level\":\"warn\"") && m.Contains("entry CB#0ddba371 was placed by ChartBridge 0.3.7 with planned prices (stop 24975 / target 25020); from now on its stop and target are 60 / 120 ticks from its fill")),
              "a 0.3.7 entry with its 0.3.7 line: converted to the ticks from its price now (60 / 120), and the page is told: " + string.Join(" | ", sent.Where(m => m.Contains("0.3.7"))));
        Check(LastOrderMsg(e37).Contains("\"planned\":{\"stopTicks\":60,\"targetTicks\":120}") && LastOrderMsg(e37b).Contains("\"planned\":{\"stopTicks\":40,\"targetTicks\":80}"),
              "and one without a line from the prices in its name (40 / 80)");
        Check(WaitFor(() => PlanFileText().Contains("0ddba371 ticks 60 120 ") && !PlanFileText().Contains("0ddba371 24975"), 5000), "the converted ticks replace its 0.3.7 line: " + PlanFileText());
        Fill(nc, e37, 1, 24992);
        Check(After(nc, 0).Any(x => x.EndsWith("S24977 oco:cb-0ddba371-1")) && After(nc, 0).Any(x => x.EndsWith("L25022 S0 oco:cb-0ddba371-1")), "the converted entry fills: legs 60 / 120 ticks from the fill: " + string.Join(" | ", nc.Calls));
        WaitFor(() => !PlanFileText().Contains("0ddba371"), 3000);   // the filled entry's line is gone (its write is on a pool thread)
        File.AppendAllText(PlanFilePath(), "0ddba373 25000 0 " + (long)ChartBridgeTime.NowUtcMs() + "\n");   // a 0.3.7 line for an entry not seen yet
        Recompile();
        string kept = PlanFileText();
        Msg("order", Ord("SimNC", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24980"));
        Check(WaitFor(() => PlanFileText().Contains("0ddba373 25000 0 "), 3000), "a 0.3.7 line for an entry not recovered yet is kept when the file is written: " + PlanFileText());

        // 0.3.8 review P10: a 0.3.7 entry moved in NinjaTrader below its planned stop (buy limit 24975, stop 24980) converts with
        // NO STOP: an ERROR alarm at the conversion naming NO STOP, and again at its fill (before: a warn, then a target only)
        Account nd = NewAccount("SimND");
        Order e10 = Manual(nd, mnq, OrderAction.Buy, OrderType.Limit, 1, 24975, 0, "", "CB#0ddba401 plan s24980 t25010");
        Recompile();
        sent.Clear();
        Update(nd, e10);
        Check(Alarmed("SimND: entry CB#0ddba401 was placed by ChartBridge 0.3.7") && Alarmed("its planned stop 24980 is not below that price, so it has NO STOP"),
              "P10 a converted 0.3.7 entry whose stop is on the wrong side: an error alarm naming NO STOP at the conversion: " + string.Join(" | ", sent.Where(m => m.Contains("0ddba401")).Select(m => m.Length > 300 ? m.Substring(0, 300) : m)));
        sent.Clear();
        Fill(nd, e10, 1, 24975);
        Check(Alarmed("SimND: entry CB#0ddba401 (placed by ChartBridge 0.3.7) filled 1 contract(s) with NO STOP") && nd.Calls.Count == 1 && nd.Calls[0].Contains(" target f1 q1 "),
              "P10 and again at its fill, as an error (the target goes in): " + string.Join(" | ", nd.Calls));
        Done(nd);

        ReviewChecks();
    }

    // ------------------------------------------------------------ the 0.3.7 reviews, for 0.3.8's ticks (P1 race, the file read, P8, ...)
    static void ReviewChecks()
    {
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, SimZq1, SimZq2, SimZq4, SimZq5, SimZq6, SimZq7, SimZq8, SimKx1, SimKx2, SimKx4, SimRw1, SimRw2, SimRw3, SimRw4, SimW1, SimW2, SimZr0n, SimZr0x, SimZr1n, SimZr1x, SimZr2x");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "5");
        ChartBridgeOrders.NoteLast("MNQ", 25000);

        // P1: a plan adding a stop races the full fill of an entry with no plan, the fill landing during the save: the plan is
        // in force before the save, so the fill gets the new legs
        Account p1 = NewAccount("SimZq1");
        Msg("order", Ord("SimZq1", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990"));
        Order e1 = Newest(p1);
        Update(p1, e1);
        sent.Clear();
        ChartBridgeOrders.PlanWriteFault = () => { ChartBridgeOrders.PlanWriteFault = null; Fill(p1, e1, 1, 24990); return null; };
        Msg("plan", PlanMsg(IdOf(e1), "\"stopTicks\":40,\"targetTicks\":80"));
        ChartBridgeOrders.PlanWriteFault = null;
        Check(After(p1, 1).Count == 2 && After(p1, 1)[0].EndsWith("S24980 oco:cb-" + Tag(e1) + "-1") && After(p1, 1)[1].EndsWith("L25010 S0 oco:cb-" + Tag(e1) + "-1") && !sent.Any(m => m.Contains("\"type\":\"reject\"")),
              "P1 a fill landing while a plan is being saved gets the new plan's legs: " + string.Join(" | ", p1.Calls));
        // P1: NinjaTrader has the fill but its event is not handled yet: refused, saying so, and NO STOP alarmed
        Msg("order", Ord("SimZq1", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990"));
        Order e1b = Newest(p1);
        Update(p1, e1b);
        e1b.Filled = 1; e1b.AverageFillPrice = 24990; e1b.OrderState = OrderState.PartFilled;
        sent.Clear();
        int c1 = p1.Calls.Count;
        Msg("plan", PlanMsg(IdOf(e1b), "\"stopTicks\":40"));
        Check(Rejected("1 contract(s) filled before this plan arrived; they get the planned nothing (no stop, no target); nothing changed") && Alarmed("filled before the plan arrived and get NO STOP"),
              "P1 a plan racing a fill NinjaTrader has reported but ChartBridge has not handled: refused, and the NO STOP alarm: " + LastSent());
        e1b.OrderState = OrderState.Filled; Update(p1, e1b);
        Check(p1.Calls.Count == c1, "and the fill gets what was planned before (nothing), never the refused plan");
        // P1b: an existing plan, a part fill waiting: refused; the waiting contract gets the OLD ticks
        Account p2 = NewAccount("SimZq2");
        Msg("order", Ord("SimZq2", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":2,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order e2 = Newest(p2);
        Update(p2, e2);
        e2.Filled = 1; e2.AverageFillPrice = 24990; e2.OrderState = OrderState.PartFilled;
        sent.Clear();
        Msg("plan", PlanMsg(IdOf(e2), "\"stopTicks\":20"));
        Check(Rejected("1 contract(s) filled before this plan arrived; they get the planned stop 8 / target 16 ticks as it was") && !Alarmed("NO STOP"), "P1b a part fill waiting: refused, naming the ticks that contract gets: " + LastSent());
        Update(p2, e2);
        Check(After(p2, 1).Count == 2 && After(p2, 1)[0].EndsWith("S24988 oco:cb-" + Tag(e2) + "-1"), "P1b the waiting contract gets the old 8 ticks: " + string.Join(" | ", After(p2, 1)));
        Msg("plan", PlanMsg(IdOf(e2), "\"stopTicks\":20"));
        Fill(p2, e2, 2, 24990);
        Check(After(p2, 3).Count == 2 && After(p2, 3)[0].EndsWith("S24985 oco:cb-" + Tag(e2) + "-2"), "P1b sent again: the contract still to fill gets 20 ticks: " + string.Join(" | ", After(p2, 3)));
        Msg("order", Ord("SimZq2", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":2,\"price\":24990"));
        Order e2b = Newest(p2);
        Fill(p2, e2b, 1, 24990);
        sent.Clear();
        Msg("plan", PlanMsg(IdOf(e2b), "\"stopTicks\":8"));
        Check(!sent.Any(m => m.Contains("\"type\":\"reject\"")) && Alarmed("1 contract(s) of entry CB#" + Tag(e2b) + " already filled with NO STOP"), "a stop planned after a contract filled with none: applied to the rest, and an alarm for the contract with no stop");

        // 0.3.8 review P3 and P13: after a recompile, an increment after contracts handled with no legs (no name records their
        // price) gets its price from NinjaTrader's executions of the entry; when they cannot give it, NO legs from an estimate
        // and an error alarm. Before the fix the estimate put a stop at 24991.25 above a 24985 market (a wrong market EXIT).
        double[][] seq = { new double[] { 24970, 24990, 24985 }, new double[] { 24990, 24970, 24985 } };
        for (int k = 0; k < 2; k++)
        {
            foreach (bool withExec in new[] { false, true })
            {
                Account pa = NewAccount("SimZr" + k + (withExec ? "x" : "n"));
                Msg("order", Ord(pa.Name, "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":3,\"price\":24990"));
                Order pe = Newest(pa);
                Update(pa, pe);
                FillX(pa, pe, 1, seq[k][0], seq[k][0], withExec);   // no plan yet: no legs
                Msg("plan", PlanMsg(IdOf(pe), "\"stopTicks\":8,\"targetTicks\":16"));
                FillX(pa, pe, 2, (seq[k][0] + seq[k][1]) / 2.0, seq[k][1], withExec);
                Recompile();
                ChartBridgeOrders.NoteLast("MNQ", seq[k][2]);
                int pc = pa.Calls.Count;
                sent.Clear();
                FillX(pa, pe, 3, (seq[k][0] + seq[k][1] + seq[k][2]) / 3.0, seq[k][2], withExec);
                ChartBridgeOrders.NoteLast("MNQ", 25000);
                List<string> got = After(pa, pc);
                string label = "P" + (k == 0 ? "3" : "13") + " fills " + seq[k][0] + ", " + seq[k][1] + ", " + seq[k][2] + " then a recompile";
                if (withExec)
                    Check(got.Count == 2 && got[0].Contains(" stop f3 q1 p24985 ") && got[0].EndsWith("S24983 oco:cb-" + Tag(pe) + "-3") && got[1].Contains("L24989 S0") && !got.Any(x => x.Contains(" exit ")),
                          label + ", NinjaTrader's executions listed: the legs go 8 / 16 ticks from the real fill 24985 (stop 24983, target 24989), no market exit: " + string.Join(" | ", got));
                else
                    Check(got.Count == 0 && Alarmed("NO STOP: 1 contract(s) of entry CB#" + Tag(pe) + " filled while ChartBridge was restarting") && Alarmed("set the stop in NinjaTrader"),
                          label + ", no executions to read the price from: NO legs from an estimate (no exit, no stop above the market, no target below it), and an error alarm: " + string.Join(" | ", got));
                if (!withExec && k == 1)
                {
                    // the missing-stop alarm path still watches it: the position is 3, the stops cover 1
                    SetPos(pa, mnq, 3);
                    sent.Clear();
                    double tq = 71000000;
                    for (int t = 0; t <= 40000; t += 2000) ChartBridgeOrders.CheckLegs(tq + t);   // steady again 30 s after the recompile, then the alarm
                    Check(Alarmed("the position is 3 but ChartBridge's working stops cover 1 contract(s)"), "P13: and the missing-stop alarm says the position is not covered");
                    SetPos(pa, mnq, 0);
                }
                Done(pa);
            }
        }
        // the market exit still works from a REAL price: executions listed, a trade from the last 2 s through the stop
        Account p5 = NewAccount("SimZq5");
        Msg("order", Ord("SimZq5", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":3,\"price\":24990"));
        Order e5 = Newest(p5);
        Update(p5, e5);
        FillX(p5, e5, 1, 24970, 24970, true);
        Msg("plan", PlanMsg(IdOf(e5), "\"stopTicks\":40,\"targetTicks\":80"));
        FillX(p5, e5, 2, (24970 + 24990) / 2.0, 24990, true);
        Recompile();
        ChartBridgeOrders.NoteLast("MNQ", 24900);
        int c5 = p5.Calls.Count;
        FillX(p5, e5, 3, (24970 + 24990 + 24985) / 3.0, 24985, true);
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Check(After(p5, c5).Count == 1 && After(p5, c5)[0].Contains(" exit f3 q1 p24985 "), "P3: from the real fill price (24985, executions), a trade from the last 2 s through its stop 24975 still takes the market exit: " + string.Join(" | ", After(p5, c5)));
        // a sell, executions listed at the recompile: the value is exact at recovery already (no estimate kept)
        Account pq7 = NewAccount("SimZr2x");
        Msg("order", Ord("SimZr2x", "\"side\":\"sell\",\"kind\":\"limit\",\"qty\":3,\"price\":25010"));
        Order eq7 = Newest(pq7);
        Update(pq7, eq7);
        FillX(pq7, eq7, 1, 25012, 25012, true);   // no plan yet: no legs
        Msg("plan", PlanMsg(IdOf(eq7), "\"stopTicks\":8,\"targetTicks\":16"));
        FillX(pq7, eq7, 2, (25012 + 25010) / 2.0, 25010, true);
        Recompile();
        int cq7 = pq7.Calls.Count;
        FillX(pq7, eq7, 3, (25012 + 25010 + 25011) / 3.0, 25011, true);
        Check(After(pq7, cq7).Count == 2 && After(pq7, cq7)[0].Contains(" stop f3 q1 p25011 ") && After(pq7, cq7)[0].EndsWith("S25013 oco:cb-" + Tag(eq7) + "-3") && After(pq7, cq7)[1].Contains("L25007 S0"),
              "a sell: the contract after the recompile gets its legs from its own fill 25011 (stop 25013, target 25007): " + string.Join(" | ", After(pq7, cq7)));
        Done(pq7);
        // P4 (kept, documented): after a recompile, contracts handled with no legs after the last named pair get legs at the next fill
        Account p6 = NewAccount("SimZq6");
        Msg("order", Ord("SimZq6", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":2,\"price\":24990"));
        Order e6 = Newest(p6);
        Update(p6, e6);
        Fill(p6, e6, 1, 24990);
        Msg("plan", PlanMsg(IdOf(e6), "\"stopTicks\":40"));
        Recompile();
        int c6 = p6.Calls.Count;
        Fill(p6, e6, 2, 24990);
        Check(After(p6, c6).Count == 1 && After(p6, c6)[0].Contains(" stop f2 q2 "), "P4 after a recompile the next fill gets legs for both contracts (documented): " + string.Join(" | ", After(p6, c6)));

        // the file read at start: a plan before it is refused; a fill waits, and its legs go the moment it is read
        Account p7 = NewAccount("SimZq7");
        Msg("order", Ord("SimZq7", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order e7 = Newest(p7);
        Msg("plan", PlanMsg(IdOf(e7), "\"stopTicks\":12"));
        ChartBridgeOrders.Clear(); ChartBridgeOrders.NoteLast("MNQ", 25000);   // started again; the file not read yet
        Msg("plan", PlanMsg(IdOf(e7), "\"stopTicks\":16"));
        Check(Rejected("still reading planned_brackets.txt"), "a plan before the file is read: refused");
        Fill(p7, e7, 1, 24990);
        Check(p7.Calls.Count == 1, "S1 a fill before the file is read: no legs guessed");
        ChartBridgeOrders.LoadPlansNow();
        Check(p7.Calls.Count == 3 && p7.Calls[1].EndsWith("S24987 oco:cb-" + Tag(e7) + "-1"), "S1 the moment the file has been read, the waiting fill gets its legs at the saved ticks: " + string.Join(" | ", p7.Calls));
        Account kx2 = NewAccount("SimKx2");
        Msg("order", Ord("SimKx2", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":0}"));
        Order f2 = Newest(kx2);
        ChartBridgeOrders.Clear(); ChartBridgeOrders.NoteLast("MNQ", 25000);
        f2.Filled = 1; f2.AverageFillPrice = 24990; f2.OrderState = OrderState.Filled;   // filled, no event seen
        SetPos(kx2, mnq, 1);
        sent.Clear();
        double ts = 23000000;
        ChartBridgeOrders.CheckLegs(ts); ChartBridgeOrders.CheckLegs(ts + 2000);
        Check(!Alarmed("NO LEGS yet"), "S1 within 3 s of the scan first seeing it: no alarm yet");
        ChartBridgeOrders.CheckLegs(ts + 4000); ChartBridgeOrders.CheckLegs(ts + 6000);
        Check(sent.Count(m => m.Contains("\"level\":\"error\"") && m.Contains("entry " + f2.Name + " has 1 filled contract(s) and NO LEGS yet: planned_brackets.txt has not been read")) == 1, "S1 not read 3 s on: one page alarm naming the entry");
        ChartBridgeOrders.LoadPlansNow();
        // N3: a plan on an entry placed before the file is read: applied, no false "could not be saved", written after the read
        Account kx4 = NewAccount("SimKx4");
        ChartBridgeOrders.Clear(); ChartBridgeOrders.NoteLast("MNQ", 25000);
        Msg("order", Ord("SimKx4", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":0}"));
        Order f4 = Newest(kx4);
        sent.Clear();
        Msg("plan", PlanMsg(IdOf(f4), "\"stopTicks\":20"));
        Check(LastOrderMsg(f4).Contains("\"stopTicks\":20") && !Alarmed("could not be saved") && !PlanFileText().Contains(Tag(f4)), "N3 a plan before the file is read: applied, no false save alarm, the write waits for the read");
        ChartBridgeOrders.LoadPlansNow();
        Check(PlanFileText().Contains(Tag(f4) + " ticks 20 0 "), "N3 written right after the read: " + PlanFileText());

        // P8: an entry that filled while ChartBridge was stopped, found by the start scan: legs only for what the listed
        // position holds, whether the scan or the file read comes first
        string[] tags = { "0ddba301", "0ddba302", "0ddba303", "0ddba304" };
        for (int k = 0; k < 4; k++)
        {
            bool scanFirst = k < 2, flat = k % 2 == 0;
            Account a = NewAccount("SimRw" + (k + 1));
            Order e = Manual(a, mnq, OrderAction.Buy, OrderType.Limit, 1, 24990, 0, "", "CB#" + tags[k] + " atm s8 t16");
            e.Filled = 1; e.AverageFillPrice = 24990; e.OrderState = OrderState.Filled;
            SetPos(a, mnq, flat ? 0 : 1);
            File.AppendAllText(PlanFilePath(), tags[k] + " ticks 8 16 " + (long)ChartBridgeTime.NowUtcMs() + "\n");
            ChartBridgeOrders.Clear(); ChartBridgeOrders.NoteLast("MNQ", 25000);
            double t = 41000000 + k * 100000;
            if (scanFirst) { ChartBridgeOrders.CheckLegs(t); ChartBridgeOrders.LoadPlansNow(); }
            else { ChartBridgeOrders.LoadPlansNow(); ChartBridgeOrders.CheckLegs(t); }
            bool none = !a.Calls.Any(x => x.StartsWith("submit"));
            ChartBridgeOrders.CheckLegs(t + 2000); ChartBridgeOrders.CheckLegs(t + 6500); ChartBridgeOrders.CheckLegs(t + 9000);
            string what = "P8 " + (scanFirst ? "start scan before the read" : "read before the start scan") + ", position " + (flat ? "flat" : "long 1");
            if (flat) Check(none && !a.Calls.Any(x => x.StartsWith("submit")), what + ": no legs on a flat account: " + string.Join(" | ", a.Calls));
            else Check(none && a.Calls.Count == 2 && a.Calls[0].EndsWith("S24988 oco:cb-" + tags[k] + "-1") && a.Calls[1].EndsWith("L24994 S0 oco:cb-" + tags[k] + "-1"),
                       what + ": legs for the contract the position holds, by the scan: " + string.Join(" | ", a.Calls));
        }

        // 0.3.8, HOME: planned_brackets.txt was empty while an entry rested. A failed write is loud and tried again until it
        // works, a read that fails is tried again and then never rewritten, and every working resting entry is kept saved.
        Account w1 = NewAccount("SimW1");
        int faults = 0;
        ChartBridgeOrders.PlanWriteFault = () => ++faults <= 1 ? "held by another program" : null;   // one failed attempt: the retry writes it
        sent.Clear();
        Msg("order", Ord("SimW1", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":16}"));
        ChartBridgeOrders.PlanWriteFault = null;
        Order g1 = Newest(w1);
        Check(PlanFileText().Contains(Tag(g1) + " ticks 8 16 ") && !Alarmed("could not be saved") && faults >= 2, "a write that fails once is tried again at once and saved, with no alarm");
        ChartBridgeOrders.PlanWriteFault = () => "held by another program";   // it keeps failing
        sent.Clear();
        Msg("order", Ord("SimW1", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24980,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order g2 = Newest(w1);
        Check(Alarmed("the planned stop and target of entry CB#" + Tag(g2) + " could not be saved (held by another program); ChartBridge tries again every 2 seconds") && !PlanFileText().Contains(Tag(g2)),
              "a placement whose line cannot be saved: a page alarm (0.3.7 only logged it), and the order still goes: " + string.Join(" | ", sent.Where(m => m.Contains("could not be saved"))));
        ChartBridgeOrders.CheckLegs(50000000);
        Check(!PlanFileText().Contains(Tag(g2)), "still failing: not saved yet");
        ChartBridgeOrders.PlanWriteFault = null;
        sent.Clear();
        ChartBridgeOrders.CheckLegs(50002000);
        Check(WaitFor(() => PlanFileText().Contains(Tag(g2) + " ticks 8 16 "), 3000) && WaitFor(() => sent.Any(m => m.Contains("planned_brackets.txt is saved again")), 3000),
              "once it can be written, the 2 second check saves it, and the page is told: " + PlanFileText());
        // a working resting entry with no record (however it got lost) is given one by the 2 second check
        var plans = (System.Collections.IDictionary)typeof(ChartBridgeOrders).GetField("Plans", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
        var memLock = typeof(ChartBridgeOrders).GetField("PlanMemLock", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
        lock (memLock) plans.Remove(Tag(g1));
        ChartBridgeOrders.PlanWriteFault = () => null;   // (a write in passing would drop the line: this check must put it back)
        ChartBridgeOrders.PlanWriteFault = null;
        Msg("order", Ord("SimW1", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24970"));   // another write: the file loses g1's line
        Check(WaitFor(() => !PlanFileText().Contains(Tag(g1)), 2000), "(set up: a write without g1's record drops its line, as on HOME)");
        ChartBridgeOrders.CheckLegs(50004000);
        Check(WaitFor(() => PlanFileText().Contains(Tag(g1) + " ticks 8 16 "), 3000), "a working resting entry whose line is missing gets it back from the 2 second check: " + PlanFileText());
        // a read that fails a few times is tried again; one that never works: an alarm, and the file is never rewritten
        Account w2 = NewAccount("SimW2");
        Msg("order", Ord("SimW2", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":12,\"target\":16}"));
        Order g3 = Newest(w2);
        int readFaults = 0;
        ChartBridgeOrders.PlanReadFault = () => ++readFaults <= 2 ? "being scanned" : null;
        Recompile();
        ChartBridgeOrders.PlanReadFault = null;
        Update(w2, g3);
        Check(LastOrderMsg(g3).Contains("\"planned\":{\"stopTicks\":12,") && readFaults == 3, "a read that fails twice is tried again and reads: " + LastOrderMsg(g3));
        string before = PlanFileText();
        ChartBridgeOrders.PlanReadFault = () => "being scanned";
        sent.Clear();
        Recompile();
        ChartBridgeOrders.PlanReadFault = null;
        Check(Alarmed("planned_brackets.txt could not be read (being scanned, 5 tries)"), "a read that never works: a page alarm");
        Msg("order", Ord("SimW2", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24985,\"bracket\":{\"stop\":8,\"target\":0}"));
        Check(PlanFileText() == before && Alarmed("could not be read at start, so it is not rewritten this run"), "and the file is never rewritten from what memory has (it may hold lines memory lacks)");
        Recompile();

        // Q2 and N4: a mistyped limit means no limit, and the pages are told (at config load and when a page signs in, only then)
        sent.Clear();
        ChartBridgeOrders.ReadConfig("maxBracketTicks", "3oo");
        Check(ChartBridgeOrders.MaxBracketTicks == 0 && sent.Any(m => m.Contains("\"level\":\"warn\"") && m.Contains("maxBracketTicks = 3oo is not a whole number of 1 or more; it is ignored, so there is NO maxBracketTicks limit")),
              "a mistyped maxBracketTicks: no limit, and a warn to the signed-in pages");
        sent.Clear();
        Msg("auth", "{\"type\":\"auth\",\"token\":\"" + ChartBridgeOrders.SessionJson().Split('"')[3] + "\"}");
        Check(sent.Count >= 2 && sent[0].Contains("\"type\":\"trading\"") && sent[1].Contains("\"level\":\"warn\"") && sent[1].Contains("NO maxBracketTicks limit"), "and a page signing in gets the warning too");
        sent.Clear();
        Msg("auth", "{\"type\":\"auth\",\"token\":\"wrong\"}");
        Check(sent.Any(m => m.Contains("token does not match")) && !sent.Any(m => m.Contains("NO maxBracketTicks limit")), "N4 a page whose sign-in fails gets no config warning");
        Msg("auth", "{\"type\":\"auth\",\"token\":\"" + ChartBridgeOrders.SessionJson().Split('"')[3] + "\"}");
        // a bracket object on plan, change or cancel is refused; on flatten it is still ignored
        Account p8 = NewAccount("SimZq8");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, SimZq8");
        Msg("order", Ord("SimZq8", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":0}"));
        Order e8 = Newest(p8);
        Msg("plan", "{\"type\":\"plan\",\"id\":\"" + IdOf(e8) + "\",\"stopTicks\":12,\"bracket\":{\"stop\":8,\"target\":8}}");
        Check(Rejected("unknown key \\\"bracket\\\" in plan"), "plan with a bracket object: refused");
        Msg("change", "{\"type\":\"change\",\"id\":\"" + IdOf(e8) + "\",\"price\":24985,\"bracket\":{\"stop\":8,\"target\":8}}");
        Check(Rejected("unknown key \\\"bracket\\\" in change") && p8.Calls.Count == 1, "change with a bracket object: refused");
        sent.Clear();
        Msg("flatten", "{\"type\":\"flatten\",\"account\":\"SimZq8\",\"root\":\"MNQ\",\"bracket\":{\"stop\":8,\"target\":8}}");
        Check(p8.Calls.Last() == "flatten MNQ 12-26" && !sent.Any(m => m.Contains("\"type\":\"reject\"")), "flatten with a bracket object: still sent");
        ChartBridgeOrders.ResetConfig();
        ChartBridgeOrders.ReadConfig("trading", "true");
    }

    // ------------------------------------------------------------ who may connect (ChartBridge.cs, ChartBridgeAccess)
    // Example addresses only: a LAN-style address from the documentation range, a Tailscale-style 100.x address.
    static bool Loop(string ip) { return ChartBridgeAccess.IsLoopback(new IPEndPoint(IPAddress.Parse(ip), 50000)); }

    static void NetworkChecks()
    {
        Check(Loop("127.0.0.1") && Loop("127.0.0.2"), "address check: IPv4 loopback allowed");
        Check(Loop("::1"), "address check: IPv6 loopback ::1 allowed");
        Check(Loop("::ffff:127.0.0.1"), "address check: IPv4 loopback mapped into IPv6 (::ffff:127.0.0.1) allowed");
        Check(!Loop("192.0.2.10"), "address check: a LAN address refused");
        Check(!Loop("100.88.192.33"), "address check: a Tailscale 100.x address refused");
        Check(!Loop("::ffff:192.0.2.10") && !Loop("::ffff:100.88.192.33"), "address check: LAN and Tailscale addresses mapped into IPv6 refused");
        Check(!Loop("2001:db8::1") && !Loop("fe80::1") && !Loop("::") && !Loop("0.0.0.0") && !Loop("::2"), "address check: other IPv6, link-local, unspecified refused");
        Check(!ChartBridgeAccess.IsLoopback((IPEndPoint)null) && !ChartBridgeAccess.IsLoopback((IPAddress)null), "address check: no address (null) refused");

        // origin allow-list for the read-only WebSocket
        ChartBridgeConfig.AllowOrigins = ChartBridgeAccess.ParseOrigins("https://Desk.GoLivePage.com/, https://desk.golivepage.com:443, *, https://*.golivepage.com, null, http://x.example/path, http://100.88.192.33:8800, ftp://x.example");
        Check(string.Join(" ", ChartBridgeConfig.AllowOrigins) == "https://desk.golivepage.com http://100.88.192.33:8800",
              "allowOrigins: lower-cased, default port and trailing slash dropped, wildcards, null, paths and other schemes skipped: " + string.Join(" ", ChartBridgeConfig.AllowOrigins));
        Check(ChartBridgeAccess.WsOriginAllowed("http://localhost:8765"), "origin: ChartBridge's own page allowed");
        Check(ChartBridgeAccess.WsOriginAllowed("https://desk.golivepage.com") && ChartBridgeAccess.WsOriginAllowed("http://100.88.192.33:8800"), "origin: listed origins allowed");
        Check(ChartBridgeAccess.WsOriginAllowed("HTTPS://DESK.GOLIVEPAGE.COM"), "origin: compared lower-cased");
        Check(!ChartBridgeAccess.WsOriginAllowed("https://evil.example") && !ChartBridgeAccess.WsOriginAllowed("https://desk.golivepage.com.evil.example")
              && !ChartBridgeAccess.WsOriginAllowed("http://desk.golivepage.com") && !ChartBridgeAccess.WsOriginAllowed("https://desk.golivepage.com:8443")
              && !ChartBridgeAccess.WsOriginAllowed("http://localhost:8766") && !ChartBridgeAccess.WsOriginAllowed("http://127.0.0.1:8765"), "origin: unlisted origins refused (exact scheme, host and port)");
        Check(!ChartBridgeAccess.WsOriginAllowed("null") && !ChartBridgeAccess.WsOriginAllowed("NULL"), "origin: \"null\" refused");
        Check(!ChartBridgeAccess.WsOriginAllowed("") && !ChartBridgeAccess.WsOriginAllowed(" "), "origin: an empty Origin header refused");
        Check(ChartBridgeAccess.WsOriginAllowed(null), "origin: no Origin header (a local program, not a browser) allowed");
        Check(!ChartBridgeOrders.OriginAllowed("https://desk.golivepage.com") && ChartBridgeOrders.OriginAllowed("http://localhost:8765"), "a listed origin still cannot trade: orders only from ChartBridge's own page");

        // refusals are logged once an hour per address
        const int L = ChartBridgeAccess.LogLine, S = ChartBridgeAccess.LogSkip, F = ChartBridgeAccess.LogBudgetFull;
        Check(ChartBridgeAccess.AddressLogDecision("t-a", 0) == L && ChartBridgeAccess.AddressLogDecision("t-a", 1000) == S && ChartBridgeAccess.AddressLogDecision("t-b", 1000) == L
              && ChartBridgeAccess.AddressLogDecision("t-a", 3599999) == S && ChartBridgeAccess.AddressLogDecision("t-a", 3600000) == L, "refusal log: once an hour per address");
        // fill the address budget: 1000 keys a budget (two used above), then one "not logged this hour" line, then silence
        List<int> ds = new List<int>();
        for (int i = 0; i < 1500; i++) ds.Add(ChartBridgeAccess.AddressLogDecision("flood-" + i, 5000));
        Check(ds.Count(d => d == L) == ChartBridgeAccess.MaxRemembered - 2 && ds.Count(d => d == F) == 1 && ds.IndexOf(F) == ChartBridgeAccess.MaxRemembered - 2,
              "refusal log: 1500 addresses make " + ds.Count(d => d == L) + " lines, then one line saying further refusals are not logged this hour (" + ds.Count(d => d == F) + "), then none");
        Check(ChartBridgeAccess.AddressLogDecision("flood-late", 6000) == S, "refusal log: the budget-full line comes once an hour, not per refusal");
        Check(ChartBridgeAccess.OriginLogDecision("https://made-up-1.example", 6000) == L, "refusal log: a full address budget does not silence the origin log");
        int ol = 0, of = 0;
        for (int i = 0; i < 1200; i++) { int d = ChartBridgeAccess.OriginLogDecision("https://made-up-" + i + ".example", 7000); if (d == L) ol++; if (d == F) of++; }
        Check(ol == ChartBridgeAccess.MaxRemembered - 1 && of == 1, "refusal log: origins have their own budget and their own budget-full line (" + ol + " lines, " + of + " full)");
        Check(ChartBridgeAccess.AddressLogDecision("flood-late", 7000) == S && ChartBridgeAccess.AddressLogDecision("t-a", 3600000 + 1000) == S, "refusal log: a full origin budget changes nothing for addresses");
        Check(ChartBridgeAccess.AddressLogDecision("flood-late", 5000 + ChartBridgeAccess.RefusalLogEveryMs) == L, "refusal log: an hour later, logging works again");

        // config.txt: the allowOrigins line
        string dir = Path.Combine(Path.GetTempPath(), "cb-harness-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(dir, "ChartBridge"));
        NinjaTrader.Core.Globals.UserDataDir = dir;
        File.WriteAllLines(Path.Combine(dir, "ChartBridge", "config.txt"), new[] { "# test", "allowOrigins = https://desk.golivepage.com, http://100.88.192.33:8800" });
        ChartBridgeConfig.Load();
        Check(string.Join(" ", ChartBridgeConfig.AllowOrigins) == "https://desk.golivepage.com http://100.88.192.33:8800", "config.txt: allowOrigins is read");
        File.WriteAllLines(Path.Combine(dir, "ChartBridge", "config.txt"), new[] { "allowOrigins = https://desk.golivepage.com", "allowOrigins = http://localhost:8800" });
        ChartBridgeConfig.Load();
        Check(string.Join(" ", ChartBridgeConfig.AllowOrigins) == "http://localhost:8800", "config.txt: with two allowOrigins lines, the last one wins");
        Check(string.Join(" ", ChartBridgeAccess.ParseOrigins("https://b\u00fccher.example, https://xn--bcher-kva.example")) == "https://xn--bcher-kva.example",
              "allowOrigins: a non-ASCII host is skipped, its punycode form is taken");
        File.WriteAllLines(Path.Combine(dir, "ChartBridge", "config.txt"), new[] { "port = 8765" });
        ChartBridgeConfig.Load();
        Check(ChartBridgeConfig.AllowOrigins.Count == 0 && !ChartBridgeAccess.WsOriginAllowed("https://desk.golivepage.com") && ChartBridgeAccess.WsOriginAllowed("http://localhost:8765"),
              "config.txt without allowOrigins: only ChartBridge's own page");
        ChartBridgeConfig.AllowOrigins = ChartBridgeAccess.ParseOrigins("https://desk.golivepage.com");
        string diag = ChartBridgeAccess.DiagJson();
        Check(diag.Contains("\"allowOrigins\":[\"http://localhost:8765\",\"https://desk.golivepage.com\"]") && diag.Contains("\"loopbackOnly\":true"), "/diag lists the allowed origins: " + diag);

        // The real request handler behind a listener on every interface (what HTTP.sys does on Windows):
        // a plain GET from another address that says "Host: localhost" is refused on every path; from this PC it is served.
        // Plain GETs only: Mono's HttpListener has no server WebSocket (IsWebSocketRequest is always false), so the
        // upgrade branch never runs here. That the address check comes before the upgrade is pinned by the source
        // guard in test/nt8-source.test.js, and checked once on Windows with curl (nt8/PROTOCOL.md, Network access).
        IPAddress outside = null;
        try
        {
            foreach (System.Net.NetworkInformation.NetworkInterface ni in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
                foreach (System.Net.NetworkInformation.UnicastIPAddressInformation ua in ni.GetIPProperties().UnicastAddresses)
                    if (outside == null && ua.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(ua.Address)) outside = ua.Address;
        }
        catch (Exception) { outside = null; }
        int port = 20000 + new Random().Next(9000);
        HttpListener l = new HttpListener();
        l.Prefixes.Add("http://*:" + port + "/");
        l.Start();
        MethodInfo handle = typeof(ChartBridgeServer).GetMethod("Handle", BindingFlags.NonPublic | BindingFlags.Static);
        Task serving = Task.Run(() =>
        {
            while (l.IsListening)
            {
                HttpListenerContext ctx;
                try { ctx = l.GetContext(); } catch (Exception) { break; }
                try { ((Task)handle.Invoke(null, new object[] { ctx, CancellationToken.None })).Wait(); } catch (Exception ex) { Console.WriteLine("handler threw: " + ex.Message); }
            }
        });
        int portWas = ChartBridgeConfig.Port;
        ChartBridgeConfig.Port = port;   // so "Host: localhost:<port>" is the name /session wants
        ChartBridgeOrders.NewToken();
        try
        {
            int s1; string b1 = Get(IPAddress.Loopback, port, "/diag", out s1);
            Check(s1 == 200 && b1.Contains("\"network\":{\"loopbackOnly\":true"), "listener: /diag from this PC is served (" + s1 + ")");
            // 0.3.2: /session also needs the page unlocked with the PIN (made-up PIN; the PIN itself: check/PinHarness.cs)
            int s2; Get(IPAddress.Loopback, port, "/session", out s2);
            Check(s2 == 403, "listener: /session from this PC with Host localhost but not unlocked is refused (" + s2 + ")");
            ChartBridgePin.NewHashIterations = 1000;
            string unlock = ChartBridgePin.Set("4096").Token;
            ChartBridgePin.NewHashIterations = ChartBridgePin.DefaultIterations;
            int s3; Get(IPAddress.Loopback, port, "/session", out s3, unlock);
            Check(s3 == 200, "listener: /session from this PC with Host localhost, unlocked, is served (" + s3 + ")");
            if (outside == null) Console.WriteLine("skip listener: no non-loopback IPv4 address on this machine");
            else
            {
                lock (NinjaTrader.Code.Output.Lines) NinjaTrader.Code.Output.Lines.Clear();
                string[] paths = { "/diag", "/session", "/", "/index.html", "/ws", "/nothing", "/pin/status", "/pin/unlock" };
                List<string> codes = new List<string>();
                foreach (string p in paths) { int sc; string body = Get(outside, port, p, out sc); codes.Add(p + "=" + sc + (body.Length > 0 ? "+body" : "")); }
                Check(codes.All(x => x.EndsWith("=403")), "listener, plain GET only (no WebSocket upgrade on Mono): from another address with a forged Host localhost, every path is 403 with no body: " + string.Join(" ", codes));
                int logs;
                lock (NinjaTrader.Code.Output.Lines) logs = NinjaTrader.Code.Output.Lines.Count(x => x.Contains("refused a request from " + outside));
                Check(logs == 1, "listener: " + paths.Length + " refused requests from one address make one Output line (" + logs + ")");
                Check(ChartBridgeAccess.DiagJson().Contains("\"refusedNotThisPc\":" + paths.Length), "/diag counts the refusals: " + ChartBridgeAccess.DiagJson());
            }
        }
        finally { ChartBridgeConfig.Port = portWas; try { l.Stop(); l.Close(); } catch (Exception) { } }
    }

    // ------------------------------------------------------------ fills to The Desk: queued while it is down, drained once, /diag clean after
    // (the trading PC's outage test, 2026-09-29: after the drain /diag still showed the old lastError)
    static string DeskDiag() { return ChartBridgeDesk.DiagJson(); }
    static bool WaitFor(Func<bool> ok, int ms) { DateTime end = DateTime.UtcNow.AddMilliseconds(ms); while (DateTime.UtcNow < end) { if (ok()) return true; Thread.Sleep(50); } return ok(); }

    static void DeskQueueChecks()
    {
        string dir = Path.Combine(Path.GetTempPath(), "cb-desk-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(dir, "ChartBridge"));
        string dirWas = NinjaTrader.Core.Globals.UserDataDir, urlWas = ChartBridgeConfig.DeskUrl;
        bool postWas = ChartBridgeConfig.PostFills;
        NinjaTrader.Core.Globals.UserDataDir = dir;
        int deskPort = 20000 + new Random().Next(9000);
        ChartBridgeConfig.PostFills = true;
        ChartBridgeConfig.DeskUrl = "http://127.0.0.1:" + deskPort;          // nothing listens there yet: The Desk is down
        HttpListener desk = null;
        try
        {
            ChartBridgeDesk.Load();
            ChartBridgeDesk.Queue("{\"source\":\"nt8\",\"exec_id\":\"harness-1\"}");
            ChartBridgeDesk.Queue("{\"source\":\"nt8\",\"exec_id\":\"harness-2\"}");
            ChartBridgeDesk.Flush();
            bool failed = WaitFor(() => DeskDiag().Contains("\"lastSendFailed\":true") && !DeskDiag().Contains("\"lastError\":\"\""), 15000);
            Check(failed && DeskDiag().Contains("\"waiting\":2"), "Desk down: 2 fills wait, /diag shows the failure and its error: " + DeskDiag());
            Check(File.ReadAllLines(Path.Combine(dir, "ChartBridge", "pending_fills.jsonl")).Length == 2, "Desk down: the 2 fills are in pending_fills.jsonl");

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
                    lock (got) got.Add(body);
                    byte[] ok = System.Text.Encoding.UTF8.GetBytes("{\"stored\":2,\"rejected\":[]}");
                    ctx.Response.StatusCode = 200; ctx.Response.OutputStream.Write(ok, 0, ok.Length); ctx.Response.Close();
                }
            });
            ChartBridgeDesk.Flush();
            bool drained = WaitFor(() => DeskDiag().Contains("\"waiting\":0") && DeskDiag().Contains("\"lastSendFailed\":false"), 15000);
            int sent1, sent2;
            lock (got) { sent1 = got.Sum(b => Regex.Matches(b, "harness-1").Count); sent2 = got.Sum(b => Regex.Matches(b, "harness-2").Count); }
            Check(drained && sent1 == 1 && sent2 == 1, "Desk back: the queue drains, each fill sent exactly once (" + sent1 + ", " + sent2 + ")");
            Check(DeskDiag().Contains("\"lastError\":\"\""), "Desk back: /diag clears lastError after a successful send: " + DeskDiag());
            Check(File.ReadAllLines(Path.Combine(dir, "ChartBridge", "pending_fills.jsonl")).Length == 0, "Desk back: pending_fills.jsonl is empty");
        }
        finally
        {
            try { if (desk != null) { desk.Stop(); desk.Close(); } } catch (Exception) { }
            ChartBridgeConfig.PostFills = postWas;
            ChartBridgeConfig.DeskUrl = urlWas;
            NinjaTrader.Core.Globals.UserDataDir = dirWas;
        }
    }

    // GET with a forged "Host: localhost:<port>", straight to the address (no proxy).
    static string Get(IPAddress to, int port, string path, out int status) { return Get(to, port, path, out status, null); }

    static string Get(IPAddress to, int port, string path, out int status, string unlock)
    {
        HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://" + to + ":" + port + path);
        req.Proxy = null;
        if (unlock != null) req.Headers[ChartBridgePin.Header] = unlock;
        req.Host = "localhost:" + port;
        req.Timeout = 5000;
        try
        {
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
            using (StreamReader r = new StreamReader(res.GetResponseStream())) { status = (int)res.StatusCode; return r.ReadToEnd(); }
        }
        catch (WebException ex)
        {
            HttpWebResponse res = ex.Response as HttpWebResponse;
            status = res != null ? (int)res.StatusCode : -1;
            if (res == null) return ex.Message;
            using (StreamReader r = new StreamReader(res.GetResponseStream())) return r.ReadToEnd();
        }
    }
}
