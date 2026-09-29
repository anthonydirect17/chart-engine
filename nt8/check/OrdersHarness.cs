// Runs the real ChartBridgeOrders.cs against the stand-in NinjaTrader types and checks every gate,
// the bracket logic, the legs check and the messages. Linux with mono: sh nt8/check/orders.sh
// (npm run check:orders). The stand-in account records Submit, Change, Cancel and Flatten; order
// states and fills are set here by hand, the way NinjaTrader would report them.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript.AddOns;

public static class OrdersHarness
{
    static int fails;
    static List<string> sent = new List<string>();
    static ChartBridgeClient c;
    static Instrument mnq, es;

    static void Check(bool ok, string what) { Console.WriteLine((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; }
    static string LastSent() { return sent.Count > 0 ? sent[sent.Count - 1] : ""; }
    static bool Rejected(string contains) { string m = LastSent(); return m.Contains("\"type\":\"reject\"") && m.Contains(contains); }
    static void Msg(string type, string json) { lock (c.Actions) c.Actions.Clear(); ChartBridgeOrders.OnMessage(c, type, json); }
    static string Order(string account, string rest) { return "{\"type\":\"order\",\"cid\":\"x\",\"account\":\"" + account + "\",\"root\":\"MNQ\"," + rest + "}"; }
    static void Update(Account a, Order o) { ChartBridgeOrders.OnOrderUpdate(a, new OrderEventArgs { Order = o }); }
    static void Fill(Account a, Order o, int filled, double avg) { o.Filled = filled; o.AverageFillPrice = avg; o.OrderState = filled >= o.Quantity ? OrderState.Filled : OrderState.PartFilled; Update(a, o); }
    static string IdOf(Order o) { return (string)typeof(ChartBridgeOrders).GetMethod("IdFor", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, new object[] { o }); }
    static string Tag(Order entry) { return Regex.Match(entry.Name, "^CB#([0-9a-f]{8}) ").Groups[1].Value; }
    static List<string> After(Account a, int n) { return a.Calls.Skip(n).ToList(); }

    // A connected account that the legs check has seen connected since time 0 (so it counts as steady).
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
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, DEMO-EVAL, SimB, SimC, SimD, SimE, SimF, SimG, SimH, Playback101, EVAL*");
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
        Check(Rejected("from 0 to 200"), "negative bracket ticks: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8}"));
        Check(Rejected("needs both stop and target"), "bracket missing its target: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":4"));
        Check(Rejected("over the MNQ cap of 3"), "one order over the cap: refused");
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":201,\"target\":8}"));
        Check(Rejected("from 0 to 200"), "bracket over 200 ticks: refused");
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
        Msg("order", Order("Sim101", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24949.75"));
        Check(Rejected("more than 200 ticks"), "limit 201 ticks away: refused");
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

        // ------------------------------------------------------------ gate 3: the cap is on the position
        Account b = NewAccount("SimB");
        SetPos(b, mnq, 3);
        Msg("order", Order("SimB", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("position 4 contracts") && b.Calls.Count == 0, "long 3, cap 3: buying 1 more refused");
        Msg("order", Order("SimB", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":7"));
        Check(Rejected("over the MNQ cap of 3") && b.Calls.Count == 0, "cap 3, long 3: selling 7 in one order refused");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "4");
        Msg("order", Order("SimB", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":4"));
        Check(b.Calls.Count == 1, "cap 4, long 3: selling 4 (to short 1) allowed");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "9");
        Msg("order", Order("SimB", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":9"));
        Check(Rejected("position 10 contracts") && b.Calls.Count == 1, "cap 9, long 3, a sell 4 still working: selling 9 more could make short 10: refused");
        b.Calls.Clear(); b.Orders.Clear();
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "3");
        Msg("order", Order("SimB", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Check(Rejected("opens or adds") && b.Calls.Count == 0, "bracket on an order that reduces the position: refused");
        Msg("order", Order("SimB", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":3"));
        Check(b.Calls.Count == 1 && b.Calls[0].Contains("Sell Market 3"), "long 3: selling 3 to exit is allowed");
        Account cc = NewAccount("SimC");
        Msg("order", Order("SimC", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":2,\"price\":24990"));
        Msg("order", Order("SimC", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":2,\"price\":24980"));
        Check(cc.Calls.Count == 1 && Rejected("working 2"), "flat with a working buy 2: another buy 2 refused (cap 3)");
        Account d = NewAccount("SimD");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "1");
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
        Check(sim.Calls.Count == 1 && Regex.IsMatch(sim.Calls[0], "^submit CB#[0-9a-f]{8} s8 t16 Buy Limit 3 L24990 S0 oco:$"), "allowed limit sent, bracket written in its name: " + (sim.Calls.Count > 0 ? sim.Calls[0] : "none"));
        Order entry = sim.Orders[0];
        string tag = Tag(entry);
        Fill(sim, entry, 2, 24990);
        List<string> legs = After(sim, 1);
        Check(legs.Count == 2 && legs[0] == "submit CB#" + tag + " stop Sell StopMarket 2 L0 S24988 oco:cb-" + tag + "-2" && legs[1] == "submit CB#" + tag + " target Sell Limit 2 L24994 S0 oco:cb-" + tag + "-2",
              "fill of 2 at 24990: OCO stop 24988 and target 24994 for 2: " + string.Join(" | ", legs));
        Check(sent.Any(m => m.Contains("\"type\":\"order\"") && m.Contains("\"cid\":\"c13\"") && m.Contains("\"state\":\"partFilled\"") && m.Contains("\"role\":\"entry\"")), "order update sent to the page with cid, role and state");
        Fill(sim, entry, 3, (24990 * 2 + 24991) / 3.0);
        legs = After(sim, 3);
        Check(legs.Count == 2 && legs[0] == "submit CB#" + tag + " stop Sell StopMarket 1 L0 S24989 oco:cb-" + tag + "-3" && legs[1] == "submit CB#" + tag + " target Sell Limit 1 L24995 S0 oco:cb-" + tag + "-3",
              "next fill of 1 at 24991: its own pair, priced from that fill: " + string.Join(" | ", legs));
        Check(!sim.Calls.Any(x => x.StartsWith("change")), "earlier legs are not resized (no change calls)");
        Update(sim, entry);
        Check(sim.Calls.Count == 5, "a repeated update places nothing more");
        Order stopA = sim.Orders[1], targetA = sim.Orders[2], stopB = sim.Orders[3], targetB = sim.Orders[4];
        foreach (Order leg in new[] { stopA, targetA, stopB, targetB }) Update(sim, leg);
        Check(sent.Any(m => m.Contains("\"role\":\"stop\"") && m.Contains("\"oco\":\"cb-" + tag + "-2\"")), "legs reach the page with role stop and their OCO id");

        // a leg fills in part: its partner shrinks; fills in full: its partner is cancelled
        targetA.Filled = 1; targetA.OrderState = OrderState.PartFilled; Update(sim, targetA);
        Check(sim.Calls.Last() == "change CB#" + tag + " stop L0 S0 Q1", "target A filled 1 of 2: stop A shrunk to 1: " + sim.Calls.Last());
        stopA.Quantity = 1;
        targetA.Filled = 2; targetA.OrderState = OrderState.Filled; Update(sim, targetA);
        Check(sim.Calls.Last() == "cancel CB#" + tag + " stop", "target A filled: stop A cancelled");
        stopA.OrderState = OrderState.Cancelled; Update(sim, stopA);

        // a rejected leg raises an error on the page
        sent.Clear();
        stopB.OrderState = OrderState.Rejected;
        ChartBridgeOrders.OnOrderUpdate(sim, new OrderEventArgs { Order = stopB, Error = ErrorCode.OrderRejected });
        Check(sent.Any(m => m.Contains("\"type\":\"status\"") && m.Contains("\"level\":\"error\"") && m.Contains("NO STOP")), "rejected stop leg: error status on the page");
        Check(sent.Any(m => m.Contains("\"state\":\"rejected\"") && m.Contains("\"text\":\"NinjaTrader: OrderRejected\"")), "rejected leg: NinjaTrader's error sent with the order");

        // change and cancel by our id
        string idB = IdOf(targetB);
        Msg("change", "{\"type\":\"change\",\"id\":\"" + idB + "\",\"price\":25002}");
        Check(sim.Calls.Last() == "change CB#" + tag + " target L25002 S0 Q0", "target leg moved to 25002 (" + idB + "): " + sim.Calls.Last());
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

        // ------------------------------------------------------------ flatten: late fills get no legs
        Account e = NewAccount("SimE");
        Msg("order", Order("SimE", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":0}"));
        Order late = e.Orders[0];
        Msg("flatten", "{\"type\":\"flatten\",\"account\":\"SimE\",\"root\":\"MNQ\"}");
        Check(e.Calls.Last() == "flatten MNQ 12-26", "flatten sent for MNQ 12-26");
        Fill(e, late, 1, 24990);
        Check(e.Calls.Count == 2, "entry that fills after Flatten gets no bracket legs");
        Msg("flatten", "{\"type\":\"flatten\",\"account\":\"OTHER-ACC\",\"root\":\"MNQ\"}");
        Check(Rejected("may not trade") && other.Calls.Count == 0, "flatten on a non-trading account: refused");
        Msg("flatten", "{\"type\":\"flatten\",\"account\":\"SimE\",\"root\":\"MNQ\",\"all\":true}");
        Check(Rejected("unknown key"), "flatten with an unknown key: refused");

        // stop only: lone legs, no OCO
        Account g = NewAccount("SimG");
        Msg("order", Order("SimG", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":12,\"target\":0}"));
        Fill(g, g.Orders[0], 1, 25000);
        Check(g.Calls.Count == 2 && g.Calls[1] == "submit CB#" + Tag(g.Orders[0]) + " stop Buy StopMarket 1 L0 S25003 oco:", "short with stop only: one buy stop 12 ticks above, no OCO: " + g.Calls.Last());

        // ------------------------------------------------------------ flat: leftover legs cancelled, unless a newer fill reopened
        Account ff = NewAccount("SimF");
        Msg("order", Order("SimF", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Fill(ff, ff.Orders[0], 1, 25000);
        SetPos(ff, mnq, 1);
        Check(ff.Calls.Count == 3, "market with bracket: entry and two legs");
        SetPos(ff, mnq, 1);   // a newer fill already reopened: the position is long again when the flat event lands
        ChartBridgeOrders.OnPositionUpdate(ff, new PositionEventArgs { Position = new Position { Instrument = mnq }, MarketPosition = MarketPosition.Flat, Quantity = 0 });
        Check(ff.Calls.Count == 3, "stale flat event while the position is open again: legs kept");
        SetPos(ff, mnq, 0);
        ChartBridgeOrders.OnPositionUpdate(ff, new PositionEventArgs { Position = new Position { Instrument = mnq }, MarketPosition = MarketPosition.Flat, Quantity = 0 });
        Check(ff.Calls.Count == 5 && ff.Calls[3].EndsWith(" stop") && ff.Calls[4].EndsWith(" target"), "flat: leftover stop and target cancelled");

        // ------------------------------------------------------------ recompile: the bracket comes back from the order name
        Account r = NewAccount("DEMO-EVAL2");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, DEMO-EVAL, SimB, SimC, SimD, SimE, SimF, SimG, SimH, DEMO-EVAL2");
        Order rEntry = Manual(r, mnq, OrderAction.Buy, OrderType.Limit, 3, 24990, 0, "", "CB#0badcafe s8 t16");
        rEntry.Filled = 2; rEntry.AverageFillPrice = 24990; rEntry.OrderState = OrderState.PartFilled;
        Manual(r, mnq, OrderAction.Sell, OrderType.StopMarket, 1, 0, 24988, "cb-0badcafe-2", "CB#0badcafe stop");     // shrunk after its target filled 1
        Order rTarget = Manual(r, mnq, OrderAction.Sell, OrderType.Limit, 2, 24994, 0, "cb-0badcafe-2", "CB#0badcafe target");
        rTarget.Filled = 1; rTarget.OrderState = OrderState.PartFilled;
        ChartBridgeOrders.Clear();
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Update(r, rEntry);
        Check(r.Calls.Count == 0, "after a recompile: a pair that was shrunk still counts at its larger leg (no extra legs)");
        rEntry.Filled = 3; rEntry.AverageFillPrice = (24990 * 2 + 24992) / 3.0; rEntry.OrderState = OrderState.Filled;
        Update(r, rEntry);
        Check(r.Calls.Count == 2 && r.Calls[0] == "submit CB#0badcafe stop Sell StopMarket 1 L0 S24990 oco:cb-0badcafe-3", "after a recompile: the next fill gets its own pair: " + string.Join(" | ", r.Calls));
        Order plain = Manual(r, mnq, OrderAction.Buy, OrderType.Market, 1, 0, 0, "", "CB#0badf00d s0 t0");
        plain.Filled = 1; plain.OrderState = OrderState.Filled;
        Update(r, plain);
        Check(r.Calls.Count == 2, "entry named with no bracket: no legs");

        // ------------------------------------------------------------ bracket upkeep runs with trading switched off
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, DEMO-EVAL, SimB, SimC, SimD, SimE, SimF, SimG, SimH");
        Order offEntry = Manual(eval, mnq, OrderAction.Buy, OrderType.Limit, 1, 24990, 0, "", "CB#00c0ffee s8 t16");
        ChartBridgeOrders.ReadConfig("trading", "false");
        sent.Clear();
        offEntry.Filled = 1; offEntry.AverageFillPrice = 24990; offEntry.OrderState = OrderState.Filled;
        Update(eval, offEntry);
        Check(eval.Calls.Count == 2 && eval.Calls[0].Contains("CB#00c0ffee stop"), "trading switched off mid-trade: the fill still gets its stop and target");
        Check(!sent.Any(m => m.Contains("\"type\":\"order\"")), "trading off: nothing sent to the page");
        ChartBridgeOrders.ReadConfig("trading", "true");

        // ------------------------------------------------------------ the legs check
        Account k = NewAccount("SimK");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, DEMO-EVAL, SimK");
        Order k1s = Manual(k, mnq, OrderAction.Sell, OrderType.StopMarket, 1, 0, 24988, "cb-11111111-1", "CB#11111111 stop");
        Order k1t = Manual(k, mnq, OrderAction.Sell, OrderType.Limit, 1, 25010, 0, "cb-11111111-1", "CB#11111111 target");
        Order k2s = Manual(k, mnq, OrderAction.Sell, OrderType.StopMarket, 1, 0, 24988, "cb-11111111-2", "CB#11111111 stop");
        Order k2t = Manual(k, mnq, OrderAction.Sell, OrderType.Limit, 1, 25010, 0, "cb-11111111-2", "CB#11111111 target");
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
        Check(k.Calls.Count == 2 && k.Calls.All(x => x.StartsWith("cancel CB#11111111")) && k.Calls.Count(x => x.EndsWith("stop")) == 1,
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
        Check(k.Calls.Count == 4 && k.Calls[2] == "change CB#11111111 stop L0 S0 Q2" && k.Calls[3] == "change CB#11111111 target L0 S0 Q2",
              "one pair of 3 on a long 2: both legs shrunk to 2: " + string.Join(" | ", k.Calls.Skip(2)));
        k1s.Quantity = 2; k1t.Quantity = 2;
        SetPos(k, mnq, -1);
        ChartBridgeOrders.CheckLegs(t0 + 40000); ChartBridgeOrders.CheckLegs(t0 + 45000);
        Check(k.Calls.Count == 6 && k.Calls[4].StartsWith("cancel") && k.Calls[5].StartsWith("cancel"), "sell legs on a short position: cancelled");
        k1s.OrderState = OrderState.Cancelled; k1t.OrderState = OrderState.Cancelled;
        Manual(k, mnq, OrderAction.Buy, OrderType.StopMarket, 1, 0, 25010, "", "CB#22222222 stop");
        SetPos(k, mnq, 0);
        ChartBridgeOrders.CheckLegs(t0 + 50000); ChartBridgeOrders.CheckLegs(t0 + 55000);
        Check(k.Calls.Count == 7 && k.Calls[6] == "cancel CB#22222222 stop", "lone leg on a flat position: cancelled");
        k.Orders.Last().OrderState = OrderState.Cancelled;
        Order manualStop = Manual(k, mnq, OrderAction.Sell, OrderType.StopMarket, 1, 0, 24980, "", "Stop1");
        ChartBridgeOrders.CheckLegs(t0 + 60000); ChartBridgeOrders.CheckLegs(t0 + 65000);
        Check(k.Calls.Count == 7, "orders not placed by ChartBridge are never touched by the legs check");
        Manual(k, mnq, OrderAction.Sell, OrderType.StopMarket, 1, 0, 24988, "", "CB#33333333 stop");   // a live stop whose position has not loaded yet
        k.Connection.Status = ConnectionStatus.ConnectionLost;
        ChartBridgeOrders.CheckLegs(t0 + 70000);
        k.Connection.Status = ConnectionStatus.Connected;   // reconnecting: orders are back, positions not yet
        ChartBridgeOrders.CheckLegs(t0 + 72000); ChartBridgeOrders.CheckLegs(t0 + 80000); ChartBridgeOrders.CheckLegs(t0 + 90000);
        Check(k.Calls.Count == 7, "within 30 seconds of a reconnect: the legs check cancels nothing");
        SetPos(k, mnq, 1);   // positions loaded
        ChartBridgeOrders.CheckLegs(t0 + 105000); ChartBridgeOrders.CheckLegs(t0 + 110000);
        Check(k.Calls.Count == 7, "after the reconnect settles with the position back: the stop is kept");
        SetPos(k, mnq, 0);

        // ------------------------------------------------------------ gate 7: rate limit
        System.Threading.Thread.Sleep(1100);
        lock (c.Actions) c.Actions.Clear();
        int before = sim.Calls.Count;
        idB = IdOf(targetB);   // the recompile above (Clear) forgot the old ids
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

        // ------------------------------------------------------------ turning trading off stops every order action
        ChartBridgeOrders.ResetConfig();
        int n = sim.Calls.Count;
        Msg("flatten", "{\"type\":\"flatten\",\"account\":\"Sim101\",\"root\":\"MNQ\"}");
        Check(Rejected("trading is off") && sim.Calls.Count == n, "after config reset: refused");

        Console.WriteLine(fails == 0 ? "ALL PASSED" : fails + " FAILED");
        return fails == 0 ? 0 : 1;
    }
}
