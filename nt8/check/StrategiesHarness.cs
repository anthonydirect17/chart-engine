// ChartBridge 0.4.0 lane B1 on Mono (inside check:orders): stop-limit and MIT entries (orderTypes) and Order Strategies
// (strategies), against the stand-in NinjaTrader types. Every refusal must never reach the stand-in account; with a switch
// off everything is refused exactly as in 0.3.8 and nothing is sent. Made-up accounts (Sim101, SIM-S1 ...) and made-up
// prices; nothing here is market data.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript.AddOns;

public static class StrategiesHarness
{
    static Action<bool, string> Check;
    static ChartBridgeClient page, v2page;
    static readonly List<string> sent = new List<string>(), sentV2 = new List<string>();
    static Instrument mnq;
    static Dictionary<string, Instrument> namedWas;
    static double clock = 10000000;
    const BindingFlags PS = BindingFlags.NonPublic | BindingFlags.Static;

    static string Last() { return sent.Count > 0 ? sent[sent.Count - 1] : ""; }
    static bool Rejected(string has) { string m = Last(); return m.Contains("\"type\":\"reject\"") && m.Contains(has); }
    static void Msg(string type, string json) { lock (page.Actions) page.Actions.Clear(); ChartBridgeOrders.OnMessage(page, type, json); }
    static string Ord(string account, string rest) { return "{\"type\":\"order\",\"cid\":\"s\",\"account\":\"" + account + "\",\"root\":\"MNQ\"," + rest + "}"; }
    static void Update(Account a, Order o) { ChartBridgeOrders.OnOrderUpdate(a, new OrderEventArgs { Order = o }); }
    static void Fill(Account a, Order o, int filled, double avg) { o.Filled = filled; o.AverageFillPrice = avg; o.OrderState = filled >= o.Quantity ? OrderState.Filled : OrderState.PartFilled; Update(a, o); }
    static string Tag(Order o) { return Regex.Match(o.Name, "^CB#([0-9a-f]{8}) ").Groups[1].Value; }
    static string IdOf(Order o) { return (string)typeof(ChartBridgeOrders).GetMethod("IdFor", PS).Invoke(null, new object[] { o }); }
    static List<string> After(Account a, int n) { return a.Calls.Skip(n).ToList(); }
    static void Trade(double price) { ChartBridgeOrders.NoteLast("MNQ", price); }
    static void Tick(double ms) { clock += ms; }
    static string ManagedFile { get { return Path.Combine(ChartBridgeConfig.Folder, "managed.txt"); } }
    static List<string> Managed() { return sent.Where(m => m.StartsWith("{\"type\":\"managed\"")).ToList(); }
    static bool WarnSaid(string has) { return sent.Any(m => m.Contains("\"type\":\"status\"") && m.Contains("\"level\":\"warn\"") && m.Contains(has)); }
    static bool Error(string has) { return sent.Any(m => m.Contains("\"type\":\"status\"") && m.Contains("\"level\":\"error\"") && m.Contains(has)); }
    // NinjaTrader confirms a stop move: the new price, working again.
    static void Confirm(Account a, Order stop, double price) { stop.StopPrice = price; stop.OrderState = OrderState.Working; Update(a, stop); }

    static Account NewAccount(string name)
    {
        Account a = new Account { Name = name, Connection = new Connection { Status = ConnectionStatus.Connected } };
        Account.All.Add(a);
        ((Dictionary<Account, double>)typeof(ChartBridgeOrders).GetField("ConnectedSince", PS).GetValue(null))[a] = 0;
        return a;
    }

    static void SetPos(Account a, int signed, double avg)
    {
        a.Positions.RemoveAll(p => p.Instrument == mnq);
        if (signed != 0) a.Positions.Add(new Position { Instrument = mnq, MarketPosition = signed > 0 ? MarketPosition.Long : MarketPosition.Short, Quantity = Math.Abs(signed), AveragePrice = avg });
    }

    // ChartBridge started again (F5): memory gone, managed.txt and planned_brackets.txt read again; the pages stay.
    static void Restart()
    {
        ChartBridgeOrders.Clear();
        ChartBridgeOrders.LoadPlansNow();
    }

    static void Config(bool orderTypes, bool strategies)
    {
        ChartBridgeOrders.ResetConfig();
        ChartBridgeOrders.ReadConfig("trading", "true");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, SIM-S1, SIM-S2, SIM-S3, SIM-S4, SIM-S5, SIM-S6, SIM-S7, SIM-S8, SIM-S9, SIM-T1, SIM-T2, SIM-T3, SIM-T4, SIM-T5, SIM-T6, SIM-T7, SIM-T8, SIM-U1, SIM-U2, SIM-U3, SIM-U4, SIM-U5, SIM-U6, SIM-U7");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "6");
        ChartBridgeSwitches.Note("orderTypes", orderTypes ? "on" : "off");   // integration: ChartBridgeConfig.Load records every v3 switch in ChartBridgeSwitches
        ChartBridgeSwitches.Note("strategies", strategies ? "On" : "off");
    }

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        try
        {
            // MNQ served on its own stand-in contract (the harnesses before this one leave the served list as they found it)
            Dictionary<string, Instrument> named = (Dictionary<string, Instrument>)typeof(ChartBridgeServer).GetField("Instruments", PS).GetValue(null);
            namedWas = new Dictionary<string, Instrument>(named);
            mnq = new Instrument { FullName = "MNQ 12-26", MasterInstrument = new MasterInstrument { Name = "MNQ", TickSize = 0.25, PointValue = 2 } };
            named["MNQ"] = mnq;
            Check(ChartBridgeServer.InstrumentFor("MNQ") == mnq, "strategies harness: MNQ is served");
            ChartBridgeOrders.StrategyInline = true;
            ChartBridgeOrders.StrategyClock = () => clock;
            Restart();
            Config(false, false);
            ChartBridgeOrders.NewToken();
            string token = ChartBridgeOrders.SessionJson().Split('"')[3];
            ConcurrentDictionary<int, ChartBridgeClient> clients = (ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", PS).GetValue(null);
            page = new ChartBridgeClient(null, 41) { Origin = "http://localhost:8765" };
            page.Tap = s => { lock (sent) sent.Add(s); };
            v2page = new ChartBridgeClient(null, 42) { Origin = "http://localhost:8765" };
            v2page.Tap = s => { lock (sentV2) sentV2.Add(s); };
            clients[41] = page; clients[42] = v2page;
            ChartBridgeV3.OnClient(page, "{\"type\":\"client\",\"v\":3}");   // integration: the one v3 handshake (lane B2's)
            Msg("auth", "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
            ChartBridgeOrders.OnMessage(v2page, "auth", "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
            Check(page.Trader && v2page.Trader, "both pages signed in");
            Trade(25000);
            SwitchesOff();
            OrderTypes();
            Validation();
            Allocation();
            PartialFills();
            BreakevenThenTrail();
            RejectedMove();
            FlattenStopsMoves();
            Restarts();
            RestartFills();
            SavedBeforeSent();   // fix1 (F5)
            DoneRace();          // fix1
            Done();
            Check(!sentV2.Any(m => m.Contains("\"type\":\"managed\"")), "a v2 page never gets a managed message");
        }
        catch (Exception ex) { Check(false, "strategies harness threw: " + ex); }
        finally
        {
            ChartBridgeOrders.StrategyInline = false;
            ChartBridgeOrders.StrategyClock = null;
            ChartBridgeOrders.ManagedReadFault = null;
            ChartBridgeOrders.ResetConfig();
            if (namedWas != null)
            {
                Dictionary<string, Instrument> named = (Dictionary<string, Instrument>)typeof(ChartBridgeServer).GetField("Instruments", PS).GetValue(null);
                named.Clear(); foreach (KeyValuePair<string, Instrument> kv in namedWas) named[kv.Key] = kv.Value;
            }
        }
    }

    // ------------------------------------------------------------ both switches off: 0.3.8 exactly, nothing sent
    static void SwitchesOff()
    {
        Account a = NewAccount("SIM-S1");
        Msg("order", Ord("SIM-S1", "\"side\":\"buy\",\"kind\":\"stopLimit\",\"qty\":1,\"price\":25010"));
        Check(Rejected("kind must be market, limit or stop"), "orderTypes off: a stopLimit is refused as in 0.3.8");
        Msg("order", Ord("SIM-S1", "\"side\":\"buy\",\"kind\":\"mit\",\"qty\":1,\"price\":24990"));
        Check(Rejected("kind must be market, limit or stop"), "orderTypes off: an MIT is refused as in 0.3.8");
        Msg("order", Ord("SIM-S1", "\"side\":\"buy\",\"kind\":\"stopLimit\",\"qty\":1,\"price\":25010,\"limitOffset\":2"));
        Check(Rejected("unknown key \\\"limitOffset\\\""), "orderTypes off: limitOffset is an unknown key, as in 0.3.8");
        Msg("order", Ord("SIM-S1", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"strategy\":{\"name\":\"Scalp\",\"stop\":8}"));
        Check(Rejected("nested object"), "strategies off: an order with a strategy is refused as in 0.3.8");
        Order mine = new Order { Account = a, Instrument = mnq, OrderAction = OrderAction.Sell, OrderType = OrderType.StopLimit, Quantity = 1, StopPrice = 24990, LimitPrice = 24989, Name = "CB#0b0b0b0b stop f1 q1 p25000 k1", OrderState = OrderState.Working };
        a.Orders.Add(mine);
        Update(a, mine);
        Msg("change", "{\"type\":\"change\",\"id\":\"" + IdOf(mine) + "\",\"price\":24991}");
        Check(Rejected("stop-limit orders can only be moved in NinjaTrader"), "both off: a stop-limit leg is not moved, as in 0.3.8");
        Check(a.Calls.Count == 0, "switches off: nothing reached NinjaTrader (" + a.Calls.Count + ")");
        Check(!sent.Any(m => m.Contains("\"by\":\"strategy\"") || m.Contains("\"limitPrice\"")), "switches off: order messages have no v3 fields");
        mine.OrderState = OrderState.Cancelled; Update(a, mine);
    }

    // ------------------------------------------------------------ orderTypes = on
    static void OrderTypes()
    {
        Config(true, false);
        Account a = NewAccount("SIM-S2");
        Trade(25000);
        sent.Clear();
        Msg("order", Ord("SIM-S2", "\"side\":\"buy\",\"kind\":\"stopLimit\",\"qty\":1,\"price\":25010,\"limitOffset\":2"));
        Check(a.Calls.Count == 1 && Regex.IsMatch(a.Calls[0], "^submit CB#[0-9a-f]{8} atm s0 t0 sl Buy StopLimit 1 L25010.5 S25010 oco:$"), "buy stop-limit, offset 2 ticks: stop 25010, limit 25010.5: " + string.Join(" | ", a.Calls));
        Order sl = a.Orders[0];
        Update(a, sl);
        Check(sent.Any(m => m.Contains("\"kind\":\"stopLimit\"") && m.Contains("\"price\":25010,") && m.Contains("\"limitPrice\":25010.5")), "its order message: kind stopLimit with limitPrice");
        int n = a.Calls.Count;
        Msg("order", Ord("SIM-S2", "\"side\":\"buy\",\"kind\":\"stopLimit\",\"qty\":1,\"price\":25010,\"limitPrice\":25010.75,\"bracket\":{\"stop\":8,\"target\":16}"));
        Check(a.Calls.Count == n + 1 && Regex.IsMatch(a.Calls[n], "^submit CB#[0-9a-f]{8} atm s8 t16 sl Buy StopLimit 1 L25010.75 S25010 oco:$"), "with limitPrice and a bracket: " + a.Calls.Last());
        Order slb = a.Orders[1];
        n = a.Calls.Count;
        Trade(25011);
        Fill(a, slb, 1, 25010.5);
        Check(a.Calls.Count == n + 2 && a.Calls[n].Contains(" stop f1 q1 p25010.5 Sell StopMarket 1 L0 S25008.5 ") && a.Calls[n + 1].Contains(" target f1 q1 p25010.5 Sell Limit 1 L25014.5 "),
              "a stop-limit entry's bracket is ticks from its fill (v2's ATM rule): " + string.Join(" | ", After(a, n)));
        Trade(25000);
        // every refusal: nothing reaches NinjaTrader
        n = a.Calls.Count;
        string[][] refused = {
            new[] { "\"side\":\"buy\",\"kind\":\"stopLimit\",\"qty\":1,\"price\":25010", "exactly one of limitOffset" },
            new[] { "\"side\":\"buy\",\"kind\":\"stopLimit\",\"qty\":1,\"price\":25010,\"limitOffset\":1,\"limitPrice\":25011", "exactly one of limitOffset" },
            new[] { "\"side\":\"buy\",\"kind\":\"stopLimit\",\"qty\":1,\"price\":25010,\"limitOffset\":-1", "limitOffset must be a whole number of ticks, 0 or more" },
            new[] { "\"side\":\"buy\",\"kind\":\"stopLimit\",\"qty\":1,\"price\":25010,\"limitOffset\":1.5", "limitOffset must be a whole number" },
            new[] { "\"side\":\"buy\",\"kind\":\"stopLimit\",\"qty\":1,\"price\":25010,\"limitPrice\":25009.75", "at or above its stop" },
            new[] { "\"side\":\"sell\",\"kind\":\"stopLimit\",\"qty\":1,\"price\":24990,\"limitPrice\":24990.25", "at or below its stop" },
            new[] { "\"side\":\"buy\",\"kind\":\"stopLimit\",\"qty\":1,\"price\":25010,\"limitPrice\":25010.1", "tick grid" },
            new[] { "\"side\":\"buy\",\"kind\":\"stopLimit\",\"qty\":1,\"price\":24990,\"limitOffset\":2", "a buy stop must be above the last price" },
            new[] { "\"side\":\"buy\",\"kind\":\"stopLimit\",\"qty\":1,\"price\":25010.1,\"limitOffset\":2", "tick grid" },
            new[] { "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"limitOffset\":2", "go on a stopLimit order only" },
            new[] { "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"limitPrice\":25001", "go on a stopLimit order only" },
            new[] { "\"side\":\"buy\",\"kind\":\"stopLimit\",\"qty\":1,\"price\":25010,\"limitOfset\":2", "unknown key \\\"limitOfset\\\"" },
            new[] { "\"side\":\"buy\",\"kind\":\"mit\",\"qty\":1,\"price\":25000", "would trigger at once; use a market order" },
            new[] { "\"side\":\"buy\",\"kind\":\"mit\",\"qty\":1,\"price\":25001", "a buy MIT must be below" },
            new[] { "\"side\":\"sell\",\"kind\":\"mit\",\"qty\":1,\"price\":24999", "a sell MIT must be above" },
            new[] { "\"side\":\"buy\",\"kind\":\"mit\",\"qty\":1", "needs a plain price" },
            new[] { "\"side\":\"buy\",\"kind\":\"stopLimit\",\"qty\":7,\"price\":25010,\"limitOffset\":2", "over the MNQ cap of 6" },
        };
        foreach (string[] r in refused)
        {
            Msg("order", Ord("SIM-S2", r[0]));
            Check(Rejected(r[1]) && a.Calls.Count == n, "orderTypes on, refused (" + r[1] + "): " + Last());
        }
        ChartBridgeOrders.ReadConfig("maxBracketTicks", "4");
        Msg("order", Ord("SIM-S2", "\"side\":\"buy\",\"kind\":\"stopLimit\",\"qty\":1,\"price\":25010,\"limitOffset\":5"));
        Check(Rejected("limitOffset must be at most 4") && a.Calls.Count == n, "limitOffset over maxBracketTicks: refused");
        ChartBridgeOrders.MaxBracketTicks = 0;
        ChartBridgeOrders.ReadConfig("maxTicksAway", "20");
        Msg("order", Ord("SIM-S2", "\"side\":\"buy\",\"kind\":\"stopLimit\",\"qty\":1,\"price\":25004,\"limitPrice\":25006"));
        Check(Rejected("limitPrice is more than 20 ticks") && a.Calls.Count == n, "limitPrice past maxTicksAway: refused");
        Msg("order", Ord("SIM-S2", "\"side\":\"buy\",\"kind\":\"mit\",\"qty\":1,\"price\":24994.75"));
        Check(Rejected("more than 20 ticks") && a.Calls.Count == n, "MIT trigger past maxTicksAway: refused");
        ChartBridgeOrders.MaxTicksAway = 0;
        FieldInfo lf = typeof(ChartBridgeOrders).GetField("Last", PS);
        ((Dictionary<string, double[]>)lf.GetValue(null))["MNQ"] = new double[] { 25000, ChartBridgeTime.NowUtcMs() - 400000 };
        Msg("order", Ord("SIM-S2", "\"side\":\"buy\",\"kind\":\"mit\",\"qty\":1,\"price\":24990"));
        Check(Rejected("stale") && a.Calls.Count == n, "MIT on a stale last price: refused");
        Trade(25000);
        // the cap counts a working stop-limit and MIT like any order (1 stop-limit and the filled 1 so far)
        Msg("order", Ord("SIM-S2", "\"side\":\"buy\",\"kind\":\"mit\",\"qty\":3,\"price\":24990"));
        Check(a.Calls.Count == n + 1 && Regex.IsMatch(a.Calls[n], "^submit CB#[0-9a-f]{8} atm s0 t0 mit Buy MIT 3 L0 S24990 oco:$"), "buy MIT 3 at 24990: " + a.Calls.Last());
        Order mit = a.Orders.Last();
        SetPos(a, 1, 25010.5);
        Msg("order", Ord("SIM-S2", "\"side\":\"buy\",\"kind\":\"stopLimit\",\"qty\":2,\"price\":25010,\"limitOffset\":0"));
        Check(Rejected("could make the MNQ position") && a.Calls.Count == n + 1, "the cap counts the working stop-limit and MIT: " + Last());
        Update(a, mit);
        Check(sent.Any(m => m.Contains("\"kind\":\"mit\"") && m.Contains("\"price\":24990,")), "an MIT's order message: kind mit, its trigger as price");
        // moving: a stop-limit keeps its offset; an MIT moves its trigger; the gates apply
        n = a.Calls.Count;
        Msg("change", "{\"type\":\"change\",\"id\":\"" + IdOf(sl) + "\",\"price\":25012}");
        Check(a.Calls.Count == n + 1 && a.Calls[n] == "change " + sl.Name + " L25012.5 S25012 Q0", "stop-limit moved: its limit keeps the 2 ticks: " + a.Calls.Last());
        Msg("change", "{\"type\":\"change\",\"id\":\"" + IdOf(sl) + "\",\"price\":24999}");
        Check(Rejected("a buy stop must be above") && a.Calls.Count == n + 1, "stop-limit moved through the market: refused");
        Msg("change", "{\"type\":\"change\",\"id\":\"" + IdOf(mit) + "\",\"price\":24985}");
        Check(a.Calls.Count == n + 2 && a.Calls.Last() == "change " + mit.Name + " L0 S24985 Q0", "MIT moved: " + a.Calls.Last());
        Msg("change", "{\"type\":\"change\",\"id\":\"" + IdOf(mit) + "\",\"price\":25000}");
        Check(Rejected("trigger at once") && a.Calls.Count == n + 2, "MIT moved to the last price: refused");
        Order other = new Order { Account = a, Instrument = mnq, OrderAction = OrderAction.Sell, OrderType = OrderType.StopLimit, Quantity = 1, StopPrice = 24990, LimitPrice = 24989, Name = "my stop limit", OrderState = OrderState.Working };
        a.Orders.Add(other);
        Update(a, other);
        Msg("change", "{\"type\":\"change\",\"id\":\"" + IdOf(other) + "\",\"price\":24991}");
        Check(Rejected("only be moved in NinjaTrader") && a.Calls.Count == n + 2, "a stop-limit placed in NinjaTrader still moves only there");
        // plan works on a stop-limit or MIT entry (v2's planned distances)
        Msg("plan", "{\"type\":\"plan\",\"id\":\"" + IdOf(mit) + "\",\"stopTicks\":12}");
        Check(sent.Any(m => m.Contains("\"id\":\"" + IdOf(mit) + "\"") && m.Contains("\"planned\":{\"stopTicks\":12,\"targetTicks\":null}")) && a.Calls.Count == n + 2, "plan on an MIT entry: the planned stop, nothing sent");
        // strategies stay off: a strategy is still refused
        Msg("order", Ord("SIM-S2", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"strategy\":{\"name\":\"Scalp\",\"stop\":8}"));
        Check(Rejected("nested object") && a.Calls.Count == n + 2, "orderTypes on, strategies off: a strategy is refused");
        foreach (Order o in a.Orders) if (o.OrderState != OrderState.Filled) o.OrderState = OrderState.Cancelled;
        SetPos(a, 0, 0);
    }

    // ------------------------------------------------------------ order.strategy: every rule, refusals name the key
    const string Full = "\"name\":\"Scalp 3T\",\"stop\":16,\"stopLimit\":null,\"t1\":8,\"t1Share\":34,\"t2\":16,\"t2Share\":33,\"t3\":32,\"t3Share\":33,\"beAfter\":8,\"bePlus\":1,\"trailAfter\":12,\"trailBy\":8,\"trailStep\":2";

    static void Validation()
    {
        Config(false, true);
        Account a = NewAccount("SIM-S3");
        Trade(25000);
        string[][] bad = {
            new[] { "\"stop\":8", "name must be a string of 1 to 40 characters" },
            new[] { "\"name\":\"\",\"stop\":8", "name must be a string of 1 to 40" },
            new[] { "\"name\":\"" + new string('x', 41) + "\",\"stop\":8", "name must be a string of 1 to 40" },
            new[] { "\"name\":5,\"stop\":8", "name must be a string" },
            new[] { "\"name\":\"S\"", "stop is required" },
            new[] { "\"name\":\"S\",\"stop\":0", "stop must be a whole number of ticks, 1 or more" },
            new[] { "\"name\":\"S\",\"stop\":\"8\"", "stop must be a whole number" },
            new[] { "\"name\":\"S\",\"stop\":null", "stop must be a whole number" },
            new[] { "\"name\":\"S\",\"stop\":8.5", "stop must be a whole number" },
            new[] { "\"name\":\"S\",\"stop\":8,\"stopLimit\":-1", "stopLimit must be a whole number of ticks, 0 or more, or null" },
            new[] { "\"name\":\"S\",\"stop\":8,\"stopLimit\":true", "stopLimit must be" },
            new[] { "\"name\":\"S\",\"stop\":8,\"t2\":8,\"t2Share\":100", "t2 needs t1" },
            new[] { "\"name\":\"S\",\"stop\":8,\"t1\":8,\"t1Share\":50,\"t3\":8,\"t3Share\":50", "t3 needs t2" },
            new[] { "\"name\":\"S\",\"stop\":8,\"t1\":8", "t1Share is required with t1" },
            new[] { "\"name\":\"S\",\"stop\":8,\"t1Share\":100", "t1Share without t1" },
            new[] { "\"name\":\"S\",\"stop\":8,\"t1\":0,\"t1Share\":100", "t1 must be a whole number of ticks, 1 or more" },
            new[] { "\"name\":\"S\",\"stop\":8,\"t1\":8,\"t1Share\":0", "t1Share must be a whole percent from 1 to 100" },
            new[] { "\"name\":\"S\",\"stop\":8,\"t1\":8,\"t1Share\":101", "t1Share must be a whole percent from 1 to 100" },
            new[] { "\"name\":\"S\",\"stop\":8,\"t1\":8,\"t1Share\":60,\"t2\":16,\"t2Share\":30", "the target shares add up to 90; they must add up to 100" },
            new[] { "\"name\":\"S\",\"stop\":8,\"t1\":8,\"t1Share\":60,\"t2\":16,\"t2Share\":\"40\"", "t2Share must be a whole percent" },
            new[] { "\"name\":\"S\",\"stop\":8,\"beAfter\":8", "beAfter and bePlus go together" },
            new[] { "\"name\":\"S\",\"stop\":8,\"bePlus\":1", "beAfter and bePlus go together" },
            new[] { "\"name\":\"S\",\"stop\":8,\"beAfter\":0,\"bePlus\":0", "beAfter must be a whole number of ticks, 1 or more" },
            new[] { "\"name\":\"S\",\"stop\":8,\"beAfter\":4,\"bePlus\":4", "bePlus must be below beAfter" },
            new[] { "\"name\":\"S\",\"stop\":8,\"beAfter\":4,\"bePlus\":-1", "bePlus must be a whole number of ticks, 0 or more" },
            new[] { "\"name\":\"S\",\"stop\":8,\"trailAfter\":8,\"trailBy\":4", "trailAfter, trailBy and trailStep go together" },
            new[] { "\"name\":\"S\",\"stop\":8,\"trailAfter\":8,\"trailBy\":0,\"trailStep\":1", "trailBy must be a whole number of ticks, 1 or more" },
            new[] { "\"name\":\"S\",\"stop\":8,\"trailAfter\":8,\"trailBy\":4,\"trailStep\":0", "trailStep must be a whole number of ticks, 1 or more" },
            new[] { "\"name\":\"S\",\"stop\":8,\"trail\":8", "unknown key \\\"trail\\\" in strategy" },
            new[] { "\"name\":\"S\",\"stop\":8,\"stop\":9", "strategy has a key twice" },
        };
        foreach (string[] r in bad)
        {
            Msg("order", Ord("SIM-S3", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"strategy\":{" + r[0] + "}"));
            Check(Rejected(r[1]) && a.Calls.Count == 0, "strategy refused (" + r[1] + "): " + Last());
        }
        string[][] shape = {
            new[] { "\"strategy\":{\"name\":\"S\",\"stop\":8,\"t1\":{\"x\":1}}", "strategy must be a flat object" },
            new[] { "\"strategy\":{\"name\":\"S\",\"stop\":[8]}", "strategy must be a flat object" },
            new[] { "\"strategy\":null", "strategy must be a flat object" },
            new[] { "\"strategy\":\"Scalp\"", "strategy must be a flat object" },
            new[] { "\"strategy\":{\"name\":\"S\",\"stop\":8},\"bracket\":{\"stop\":8,\"target\":16}", "bracket and strategy on one order are refused" },
            new[] { "\"strategy\":{\"name\":\"S\",\"stop\":8},\"strategy\":{\"name\":\"S\",\"stop\":8}", "key twice" },
            new[] { "\"strategy\":{\"name\":\"S\",\"stop\":8},\"strategi\":1", "unknown key \\\"strategi\\\"" },
        };
        foreach (string[] r in shape)
        {
            Msg("order", Ord("SIM-S3", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1," + r[0]));
            Check(Rejected(r[1]) && a.Calls.Count == 0, "strategy refused (" + r[1] + "): " + Last());
        }
        Msg("plan", "{\"type\":\"plan\",\"id\":\"o1\",\"stopTicks\":8,\"strategy\":{\"name\":\"S\",\"stop\":8}}");
        Check(Last().Contains("\"type\":\"reject\"") && a.Calls.Count == 0, "a strategy on plan: refused");
        ChartBridgeOrders.ReadConfig("maxBracketTicks", "30");
        Msg("order", Ord("SIM-S3", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"strategy\":{" + Full + "}"));
        Check(Rejected("t3 must be at most 30 ticks (maxBracketTicks in config.txt)") && a.Calls.Count == 0, "a distance over maxBracketTicks: refused, naming the key");
        Msg("order", Ord("SIM-S3", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"strategy\":{\"name\":\"S\",\"stop\":8,\"beAfter\":31,\"bePlus\":1}"));
        Check(Rejected("beAfter must be at most 30 ticks") && a.Calls.Count == 0, "beAfter over maxBracketTicks: refused");
        ChartBridgeOrders.MaxBracketTicks = 0;
        SetPos(a, 2, 25000);
        Msg("order", Ord("SIM-S3", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":1,\"strategy\":{\"name\":\"S\",\"stop\":8}"));
        Check(Rejected("a strategy can only go on an order that opens or adds") && a.Calls.Count == 0, "a strategy on an order that reduces the position: refused");
        SetPos(a, 0, 0);
        Msg("order", Ord("SIM-S3", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":7,\"strategy\":{\"name\":\"S\",\"stop\":8}"));
        Check(Rejected("over the MNQ cap") && a.Calls.Count == 0, "a strategy order over the cap: refused (every v2 gate applies)");
        Msg("order", Ord("SIM-S3", "\"side\":\"buy\",\"kind\":\"stopLimit\",\"qty\":1,\"price\":25010,\"strategy\":{\"name\":\"S\",\"stop\":8}"));
        Check(Rejected("kind must be market, limit or stop") && a.Calls.Count == 0, "strategies on, orderTypes off: a stopLimit is still refused: " + Last());
        // accepted: the full strategy, as the fixture's; the entry is named sg (market) or atm sg (resting), with the stop ticks (fix1, F5)
        sent.Clear();
        Msg("order", Ord("SIM-S3", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"strategy\":{" + Full + "}"));
        Check(a.Calls.Count == 1 && Regex.IsMatch(a.Calls[0], "^submit CB#[0-9a-f]{8} atm sg s16 Buy Limit 1 L24990 S0 oco:$"), "a limit entry with the strategy: named atm sg s16 (fix1: the stop ticks in the name): " + string.Join(" | ", a.Calls));
        Order e = a.Orders[0];
        List<string> mg = Managed();
        Check(mg.Count == 1 && mg[0].Contains("\"state\":\"waiting\"") && mg[0].Contains("\"name\":\"Scalp 3T\"") && mg[0].Contains("\"strategy\":{" + Full + "}") && mg[0].Contains("\"pairs\":[]") && mg[0].Contains("\"id\":\"" + IdOf(e) + "\""),
              "the page gets managed, waiting, with the strategy as sent: " + (mg.Count > 0 ? mg[0] : "none"));
        Msg("plan", "{\"type\":\"plan\",\"id\":\"" + IdOf(e) + "\",\"stopTicks\":12}");
        Check(Rejected("a plan on an Order Strategy entry is refused") && a.Calls.Count == 1, "plan on a strategy entry: refused (lead's default)");
        Check(File.Exists(ManagedFile) && File.ReadAllLines(ManagedFile).Any(l => l.StartsWith(Tag(e) + "\t{" + Full + "}\t-\t")), "managed.txt has its line at placement");
        e.OrderState = OrderState.Cancelled; Update(a, e);
        Check(Managed().Last().Contains("\"state\":\"done\""), "the entry cancelled unfilled: managed done");
        Check(!File.ReadAllLines(ManagedFile).Any(l => l.StartsWith(Tag(e))), "and its line leaves managed.txt");
    }

    // ------------------------------------------------------------ the allocation rule (unit)
    static void Allocation()
    {
        object[][] table = {
            new object[] { 3, new[] { 33, 33, 34 }, new[] { 1, 1, 1 } },   // PROTOCOL's examples
            new object[] { 1, new[] { 50, 50 }, new[] { 0, 1 } },
            new object[] { 5, new[] { 50, 30, 20 }, new[] { 2, 2, 1 } },
            new object[] { 1, new[] { 34, 33, 33 }, new[] { 1, 0, 0 } },
            new object[] { 2, new[] { 34, 33, 33 }, new[] { 1, 0, 1 } },
            new object[] { 3, new[] { 50, 50 }, new[] { 1, 2 } },
            new object[] { 10, new[] { 33, 33, 34 }, new[] { 3, 3, 4 } },
            new object[] { 4, new[] { 25, 25, 50 }, new[] { 1, 1, 2 } },
            new object[] { 7, new[] { 100 }, new[] { 7 } },
            new object[] { 2, new[] { 1, 99 }, new[] { 0, 2 } },
            new object[] { 1, new[] { 98, 1, 1 }, new[] { 1, 0, 0 } },
        };
        foreach (object[] r in table)
        {
            int q = (int)r[0];
            int[] got = ChartBridgeOrders.Allocate(q, (int[])r[1]);
            Check(got.SequenceEqual((int[])r[2]), "allocation: " + q + " at " + string.Join("/", (int[])r[1]) + " gives " + string.Join("/", got));
        }
        Random rnd = new Random(7);
        bool ok = true;
        for (int i = 0; i < 2000 && ok; i++)
        {
            int n = rnd.Next(1, 4), q = rnd.Next(1, 40);
            int[] s = new int[n];
            int left = 100;
            for (int k = 0; k < n - 1; k++) { s[k] = rnd.Next(1, left - (n - 1 - k) + 1); left -= s[k]; }
            s[n - 1] = left;
            int[] got = ChartBridgeOrders.Allocate(q, s);
            ok = got.Sum() == q && got.All(x => x >= 0) && got.Select((x, k) => Math.Abs(x - q * s[k] / 100.0) < 1.0).All(b => b);
        }
        Check(ok, "allocation: 2,000 random cases add up to exactly q, each within one contract of its share");
    }

    // ------------------------------------------------------------ fills in increments: one pair per bucket, at each fill
    static void PartialFills()
    {
        Config(false, true);
        Account a = NewAccount("SIM-S4");
        Trade(25000);
        sent.Clear();
        Msg("order", Ord("SIM-S4", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":3,\"price\":24990,\"strategy\":{" + Full + "}"));
        Order e = a.Orders[0];
        string t = Tag(e);
        Fill(a, e, 1, 24990);
        List<string> legs = After(a, 1);
        Check(legs.Count == 2 && legs[0] == "submit CB#" + t + " stop f1 q1 p24990 k1 Sell StopMarket 1 L0 S24986 oco:cb-" + t + "-f1-1" &&
              legs[1] == "submit CB#" + t + " target f1 q1 p24990 k1 Sell Limit 1 L24992 S0 oco:cb-" + t + "-f1-1",
              "fill of 1 at 24990 (34/33/33): bucket 1 only, its stop 16 and target 8 ticks away as an OCO pair: " + string.Join(" | ", legs));
        Fill(a, e, 3, (24990 + 2 * 24991) / 3.0);
        legs = After(a, 3);
        Check(legs.Count == 4 && legs[0] == "submit CB#" + t + " stop f3 q1 p24991 k1 Sell StopMarket 1 L0 S24987 oco:cb-" + t + "-f3-1" &&
              legs[1] == "submit CB#" + t + " target f3 q1 p24991 k1 Sell Limit 1 L24993 S0 oco:cb-" + t + "-f3-1" &&
              legs[2] == "submit CB#" + t + " stop f3 q1 p24991 k3 Sell StopMarket 1 L0 S24987 oco:cb-" + t + "-f3-3" &&
              legs[3] == "submit CB#" + t + " target f3 q1 p24991 k3 Sell Limit 1 L24999 S0 oco:cb-" + t + "-f3-3",
              "next 2 at 24991: 1/0/1 (a tie to the later target; T2 dropped), each from that fill's price: " + string.Join(" | ", legs));
        Update(a, e);
        Check(a.Calls.Count == 7, "a repeated update places nothing more");
        string m = Managed().Last();
        Check(m.Contains("\"state\":\"active\"") && Regex.Matches(m, "\"bucket\":").Count == 3 && m.Contains("\"bucket\":3,\"qty\":1,\"fill\":24991,") && m.Contains("\"be\":false"), "managed: active, three pairs: " + m);
        Order k3stop = a.Orders[5];
        Update(a, k3stop);
        Check(sent.Any(x => x.Contains("\"id\":\"" + IdOf(k3stop) + "\"") && x.Contains("\"by\":\"strategy\",\"bucket\":3") && x.Contains("\"oco\":\"cb-" + t + "-f3-3\"")), "a leg's order message: by strategy, bucket 3");
        Check(File.ReadAllLines(ManagedFile).Any(l => l.StartsWith(t + "\t") && l.Contains("f1k1:24990") && l.Contains("f3k3:24991")), "managed.txt: the best price per pair");
        // the legs check and the missing-stop alarm read these legs as v2's (k is part of the leg name)
        SetPos(a, 3, 24990.67);
        int n = a.Calls.Count;
        ChartBridgeOrders.CheckLegs(clock); ChartBridgeOrders.CheckLegs(clock + 5000);
        Check(a.Calls.Count == n, "the legs check leaves pairs that cover the position exactly");
        SetPos(a, 2, 24990.67);
        ChartBridgeOrders.CheckLegs(clock + 6000); ChartBridgeOrders.CheckLegs(clock + 11000);
        Check(a.Calls.Count == n + 2 && a.Calls[n] == "cancel CB#" + t + " stop f3 q1 p24991 k3" && a.Calls[n + 1] == "cancel CB#" + t + " target f3 q1 p24991 k3",
              "a position smaller than the legs: the newest pair is cancelled, as v2: " + string.Join(" | ", After(a, n)));
        foreach (Order o in a.Orders) if (o.OrderState != OrderState.Filled) o.OrderState = OrderState.Cancelled;
        SetPos(a, 0, 0);

        // no targets: one stop for the whole increment, no OCO; a stop-limit stop; the stop already traded: exits per bucket
        Account b = NewAccount("SIM-S5");
        Msg("order", Ord("SIM-S5", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":2,\"strategy\":{\"name\":\"Stop only\",\"stop\":12,\"stopLimit\":2}"));
        Check(Regex.IsMatch(b.Calls[0], "^submit CB#[0-9a-f]{8} sg s12 Sell Market 2 "), "a market entry with a strategy: named sg s12: " + b.Calls[0]);
        Fill(b, b.Orders[0], 2, 25000);
        Check(b.Calls.Count == 2 && b.Calls[1] == "submit CB#" + Tag(b.Orders[0]) + " stop f2 q2 p25000 k1 Buy StopLimit 2 L25003.5 S25003 oco:", "no targets: one buy stop-limit for 2, 12 ticks above, its limit 2 beyond, no OCO: " + b.Calls.Last());
        b.Orders[1].OrderState = OrderState.Cancelled;
        Account x2 = NewAccount("SIM-S6");
        Msg("order", Ord("SIM-S6", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":3,\"price\":24990,\"strategy\":{\"name\":\"Two\",\"stop\":4,\"t1\":8,\"t1Share\":50,\"t2\":16,\"t2Share\":50}"));
        Trade(24988.5);   // fell through 24989 before the fill was reported
        sent.Clear();
        Fill(x2, x2.Orders[0], 3, 24990);
        legs = After(x2, 1);
        string tx = Tag(x2.Orders[0]);
        Check(legs.Count == 2 && legs[0] == "submit CB#" + tx + " exit f3 q1 p24990 k1 Sell Market 1 L0 S0 oco:" && legs[1] == "submit CB#" + tx + " exit f3 q2 p24990 k2 Sell Market 2 L0 S0 oco:",
              "the stop level already traded: a market exit per bucket (1/2), never a stop through the market: " + string.Join(" | ", legs));
        Check(Error("already passed the stop level"), "and an error says so");
        Trade(25000);
    }

    // ------------------------------------------------------------ breakeven, then trailing
    static Order StrategyLong(Account a, string strategy, double fill)
    {
        Msg("order", Ord(a.Name, "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"strategy\":{" + strategy + "}"));
        Order e = a.Orders.Last();
        Fill(a, e, 1, fill);
        SetPos(a, 1, fill);
        return e;
    }

    const string BeTrail = "\"name\":\"BE trail\",\"stop\":16,\"t1\":40,\"t1Share\":100,\"beAfter\":8,\"bePlus\":1,\"trailAfter\":12,\"trailBy\":8,\"trailStep\":2";

    static void BreakevenThenTrail()
    {
        Config(false, true);
        Account a = NewAccount("SIM-S7");
        Trade(25000);
        Order e = StrategyLong(a, BeTrail, 25000);
        Order stop = a.Orders[1];
        Check(a.Calls[1].Contains(" stop f1 q1 p25000 k1 Sell StopMarket 1 L0 S24996 ") && a.Calls[2].Contains(" target f1 q1 p25000 k1 Sell Limit 1 L25010 "), "long 1 at 25000: stop 24996, target 25010");
        int n = a.Calls.Count;
        Tick(1000); Trade(25001.75);
        Check(a.Calls.Count == n, "7 ticks in profit: no move");
        Tick(1000); Trade(25002);
        Check(a.Calls.Count == n + 1 && a.Calls[n] == "change " + stop.Name + " L0 S25000.25 Q0", "8 ticks in profit: the stop to breakeven plus 1 (25000.25), a change on the working stop: " + a.Calls.Last());
        Tick(100); Trade(25002.25);
        Check(a.Calls.Count == n + 1, "one move in flight: nothing more until NinjaTrader confirms");
        sent.Clear();
        Confirm(a, stop, 25000.25);
        Check(Managed().Any(m => m.Contains("\"stop\":25000.25") && m.Contains("\"be\":true") && m.Contains("\"trailing\":false")), "confirmed: managed says be true");
        Tick(100); Trade(25003);   // 12 ticks: the trail level 25001 is 3 ticks better than the stop, but within 500 ms of the last move
        Check(a.Calls.Count == n + 1, "at most one move per stop per 500 ms");
        Tick(450); Trade(25002.75);   // 650 ms after the move; the best is 25003: trail 25001
        Check(a.Calls.Count == n + 2 && a.Calls.Last() == "change " + stop.Name + " L0 S25001 Q0", "12 ticks in profit: the stop trails 8 ticks behind the best (25001): " + a.Calls.Last());
        Confirm(a, stop, 25001);
        Tick(600); Trade(25003.25);
        Check(a.Calls.Count == n + 2, "a new best 1 tick higher: the trail level is less than trailStep (2) better: no move");
        Tick(600); Trade(25003.5);
        Check(a.Calls.Count == n + 3 && a.Calls.Last() == "change " + stop.Name + " L0 S25001.5 Q0", "2 ticks better: moved to 25001.5: " + a.Calls.Last());
        Confirm(a, stop, 25001.5);
        Check(Managed().Last().Contains("\"trailing\":true"), "managed says trailing");
        // never at or through the last trade: the best jumps to 25006 while the last trade is back at 25004
        Tick(100); Trade(25006);   // within 500 ms: held
        Tick(600); Trade(25004);   // the trail level is 25004: at the last trade
        Check(a.Calls.Count == n + 3, "never to a price at or through the last trade (it waits for the next trade)");
        Tick(100); Trade(25004.25);
        Check(a.Calls.Count == n + 4 && a.Calls.Last() == "change " + stop.Name + " L0 S25004 Q0", "the next trade above it: moved to 25004: " + a.Calls.Last());
        Confirm(a, stop, 25004);
        Tick(600); Trade(25001);
        Tick(600); Trade(25003);
        Check(a.Calls.Count == n + 4, "price falls back: the stop never moves back");
        // a stop-limit stop keeps its offset when it moves
        Account s = NewAccount("SIM-S8");
        StrategyLong(s, "\"name\":\"SL\",\"stop\":8,\"stopLimit\":4,\"beAfter\":4,\"bePlus\":0", 25000);
        Order sl = s.Orders[1];
        Check(s.Calls[1].Contains(" Sell StopLimit 1 L24997 S24998 "), "a stop-limit stop: stop 24998, limit 24997: " + s.Calls[1]);
        int ms = s.Calls.Count;
        Tick(600); Trade(25001);
        Check(s.Calls.Count == ms + 1 && s.Calls.Last() == "change " + sl.Name + " L24999 S25000 Q0", "breakeven on a stop-limit: the stop to 25000, its limit 4 ticks below: " + s.Calls.Last());
        // a short: the stop moves down
        Account sh = NewAccount("SIM-S9");
        Msg("order", Ord("SIM-S9", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":1,\"strategy\":{\"name\":\"Short\",\"stop\":8,\"beAfter\":4,\"bePlus\":2}"));
        Fill(sh, sh.Orders[0], 1, 25001);
        SetPos(sh, -1, 25001);
        Order ss = sh.Orders[1];
        int q = sh.Calls.Count;
        Tick(600); Trade(25000);
        Check(sh.Calls.Count == q + 1 && sh.Calls.Last() == "change " + ss.Name + " L0 S25000.5 Q0", "a short at 25001, 4 ticks in profit: its buy stop down to fill minus 2 (25000.5): " + sh.Calls.Last());
        foreach (Account x in new[] { a, s, sh }) { foreach (Order o in x.Orders) if (o.OrderState != OrderState.Filled) o.OrderState = OrderState.Cancelled; SetPos(x, 0, 0); }
        Trade(25000);
    }

    // ------------------------------------------------------------ a stop move NinjaTrader rejects
    static void RejectedMove()
    {
        Account a = NewAccount("SIM-T1");
        Trade(25000);
        StrategyLong(a, BeTrail, 25000);
        Order stop = a.Orders[1];
        int n = a.Calls.Count;
        Tick(600); Trade(25002);
        Check(a.Calls.Count == n + 1 && a.Calls.Last().StartsWith("change ") && a.Calls.Last().Contains(" S25000.25 "), "breakeven move sent");
        sent.Clear();
        ChartBridgeOrders.OnOrderUpdate(a, new OrderEventArgs { Order = stop, Error = ErrorCode.UnableToChangeOrder });   // NinjaTrader: the change was not taken, the stop is where it was
        Check(WarnSaid("did not take the move of the strategy stop") && WarnSaid("the stop stays at 24,996") && WarnSaid("ChartBridge tries once more on the next move"),
              "fix1: a rejected move: the stop stays, and a warn says it is tried once more: " + string.Join(" | ", sent.Where(x => x.Contains("status"))));
        Check(stop.StopPrice == 24996, "the stop is where it was");
        Tick(600); Trade(25004);
        Check(a.Calls.Count == n + 2 && a.Calls.Last() == "change " + stop.Name + " L0 S25002 Q0", "fix1: the next eligible move tries once more (trailing now wins: 25002, tighter than 24,996, never looser): " + a.Calls.Last());
        sent.Clear();
        ChartBridgeOrders.OnOrderUpdate(a, new OrderEventArgs { Order = stop, Error = ErrorCode.UnableToChangeOrder });
        Check(WarnSaid("did not take the move of the strategy stop (bucket 1) to 25,002") && WarnSaid("refused twice") && WarnSaid("manage it by hand"),
              "fix1: refused a second time: halted, with a warn to manage it by hand: " + string.Join(" | ", sent.Where(x => x.Contains("status"))));
        Tick(600); Trade(25005); Tick(600); Trade(25006);
        Check(a.Calls.Count == n + 2 && stop.StopPrice == 24996, "after the second rejection that stop is not moved again (it stays at 24,996)");
        foreach (Order o in a.Orders) if (o.OrderState != OrderState.Filled) o.OrderState = OrderState.Cancelled;
        SetPos(a, 0, 0);
        Trade(25000);
    }

    // ------------------------------------------------------------ Flatten: no move races it
    static void FlattenStopsMoves()
    {
        Account a = NewAccount("SIM-T2");
        Trade(25000);
        StrategyLong(a, BeTrail, 25000);
        Order stop = a.Orders[1];
        int p = a.Calls.Count;
        ChartBridgeOrders.PauseStrategies(a, mnq, true);   // Merge's swap (lane B4) freezes the moves
        Tick(600); Trade(25002);
        Check(a.Calls.Count == p, "paused for a merge swap: no move");
        ChartBridgeOrders.PauseStrategies(a, mnq, false);
        a.Connection.Status = ConnectionStatus.ConnectionLost;
        Tick(600); Trade(25002.25);
        Check(a.Calls.Count == p, "the account not Connected: the move is not sent");
        a.Connection.Status = ConnectionStatus.Connected;
        Tick(600); Trade(25002.5);
        Check(a.Calls.Count == p + 1 && a.Calls.Last() == "change " + stop.Name + " L0 S25000.25 Q0", "Connected again: the next trade sends it: " + a.Calls.Last());
        Confirm(a, stop, 25000.25);
        Msg("flatten", "{\"type\":\"flatten\",\"account\":\"SIM-T2\",\"root\":\"MNQ\"}");
        Check(a.Calls.Last() == "flatten MNQ 12-26", "flatten sent as in v2");
        int n = a.Calls.Count;
        Tick(600); Trade(25004);
        Check(a.Calls.Count == n, "after Flatten: no breakeven or trailing move");
        foreach (Order o in a.Orders) if (o.OrderState != OrderState.Filled) o.OrderState = OrderState.Cancelled;
        SetPos(a, 0, 0);
        Trade(25000);
    }

    // ------------------------------------------------------------ the restart: managed.txt good, missing, mismatched, unreadable
    static Account Placed(string name, out Order stop)
    {
        Account a = NewAccount(name);
        Trade(25000);
        StrategyLong(a, BeTrail, 25000);
        stop = a.Orders[1];
        Tick(600); Trade(25002);
        Confirm(a, stop, 25000.25);   // at breakeven
        Tick(600); Trade(25002.5);    // best 25002.5, no move
        ChartBridgeOrders.SaveManagedNow();
        return a;
    }

    static void Restarts()
    {
        // good: resumed; the best is the larger of the saved one and the trades since the start
        Order stop;
        Account a = Placed("SIM-T3", out stop);
        string tag = Tag(a.Orders[0]);
        Check(File.ReadAllLines(ManagedFile).Any(l => l.StartsWith(tag + "\t") && l.Contains("f1k1:25002.5")), "managed.txt holds the best price before the restart");
        Restart();
        sent.Clear();
        Trade(25003);   // a trade since the start, before the recovery
        ChartBridgeOrders.CheckLegs(clock);
        List<string> mg = Managed();
        Check(mg.Count(m => m.Contains("\"state\":\"resumed\"")) == 1 && mg.Any(m => m.Contains("\"account\":\"SIM-T3\"") && m.Contains("\"state\":\"resumed\"") && m.Contains("\"text\":\"ChartBridge restarted; breakeven and trailing resumed\"") && m.Contains("\"best\":25003") && m.Contains("\"be\":true")),
              "managed.txt good: resumed, best 25003 (a trade since the start), be true: " + string.Join(" | ", mg));
        Check(!mg.Any(m => !m.Contains("\"account\":\"SIM-T3\"")), "finished strategy entries the names still list are recovered quietly (no message)");
        Check(!sent.Any(m => m.Contains("\"level\":\"error\"") && m.Contains("SIM-T3")), "no error for it");
        int n = a.Calls.Count;
        Tick(600); Trade(25003.25);
        Check(a.Calls.Count == n + 1 && a.Calls.Last() == "change " + stop.Name + " L0 S25001.25 Q0", "breakeven and trailing keep going after the restart (trail from 25003.25): " + a.Calls.Last());
        Confirm(a, stop, 25001.25);
        foreach (Order o in a.Orders) if (o.OrderState != OrderState.Filled) o.OrderState = OrderState.Cancelled;
        SetPos(a, 0, 0);

        // missing: every stop stays where it is, unmanaged, and an error says so
        Account b = Placed("SIM-T4", out stop);
        File.Delete(ManagedFile);
        Restart();
        sent.Clear();
        Trade(25002);
        ChartBridgeOrders.CheckLegs(clock);
        Check(Managed().Any(m => m.Contains("\"state\":\"unmanaged\"") && m.Contains("managed.txt has no line")), "managed.txt missing: managed unmanaged: " + string.Join(" | ", Managed()));
        Check(Error("MNQ SIM-T4: breakeven and trailing could not be resumed after the restart (managed.txt has no line for it); the stop stays at 25,000.25. Manage it by hand"),
              "and a status error names the stop: " + string.Join(" | ", sent.Where(x => x.Contains("error"))));
        n = b.Calls.Count;
        Tick(600); Trade(25006); Tick(600); Trade(25008);
        Check(b.Calls.Count == n, "unmanaged: the stop is never moved");
        foreach (Order o in b.Orders) if (o.OrderState != OrderState.Filled) o.OrderState = OrderState.Cancelled;
        SetPos(b, 0, 0);

        // mismatched: the line says another target distance than the legs show
        Account c = Placed("SIM-T5", out stop);
        string ctag = Tag(c.Orders[0]);
        string[] lines = File.ReadAllLines(ManagedFile);
        File.WriteAllLines(ManagedFile, lines.Select(l => l.StartsWith(ctag + "\t") ? l.Replace("\"t1\":40", "\"t1\":20") : l).ToArray());
        Restart();
        sent.Clear();
        ChartBridgeOrders.CheckLegs(clock);
        Check(Managed().Any(m => m.Contains("\"state\":\"unmanaged\"") && m.Contains("the strategy puts it at 25,005")) && Error("MNQ SIM-T5: breakeven and trailing could not be resumed") && Error("the stop stays at 25,000.25"),
              "legs that do not match the line: unmanaged, and said: " + string.Join(" | ", sent.Where(x => x.Contains("error"))));
        n = c.Calls.Count;
        Tick(600); Trade(25006);
        Check(c.Calls.Count == n, "mismatched: the stop is never moved");
        foreach (Order o in c.Orders) if (o.OrderState != OrderState.Filled) o.OrderState = OrderState.Cancelled;
        SetPos(c, 0, 0);

        // legs only (NinjaTrader restarted and no longer lists the filled entry): recovered from the leg names and the line
        Account d = Placed("SIM-T6", out stop);
        d.Orders.RemoveAt(0);
        Restart();
        sent.Clear();
        Trade(25002);
        ChartBridgeOrders.CheckLegs(clock);
        Check(Managed().Any(m => m.Contains("\"state\":\"resumed\"") && m.Contains("\"id\":null")), "the entry not listed: resumed from the legs' names (id null): " + string.Join(" | ", Managed()));
        n = d.Calls.Count;
        Tick(600); Trade(25003);
        Check(d.Calls.Count == n + 1 && d.Calls.Last() == "change " + stop.Name + " L0 S25001 Q0", "and trailing goes on: " + d.Calls.Last());
        Confirm(d, stop, 25001);
        // the target fills: its OCO stop is cancelled (re-linked from the names), the record is done and its line goes
        Order target = d.Orders[1];
        target.Filled = 1; target.OrderState = OrderState.Filled; Update(d, target);
        Check(d.Calls.Last() == "cancel " + stop.Name, "the pair re-linked after the restart: the target filling cancels its stop");
        stop.OrderState = OrderState.Cancelled; Update(d, stop);
        SetPos(d, 0, 0);
        sent.Clear();
        ChartBridgeOrders.CheckLegs(clock);
        Check(Managed().Any(m => m.Contains("\"state\":\"done\"")), "done once no leg works");
        Check(!File.ReadAllLines(ManagedFile).Any(l => l.StartsWith(Tag(stop) + "\t")), "its line leaves managed.txt");

        // unreadable: never rewritten that run, every stop left where it is
        Account f = Placed("SIM-T7", out stop);
        string before = File.ReadAllText(ManagedFile);
        ChartBridgeOrders.ManagedReadFault = () => "held by another program";
        ChartBridgeOrders.PlanReadRetryMs = 1;
        sent.Clear();
        Restart();
        ChartBridgeOrders.ManagedReadFault = null;
        Check(Error("managed.txt could not be read (held by another program)") && Error("Order Strategies are off for this run: new strategy entries are refused; fix the file and restart"),
              "managed.txt unreadable: an error at start, saying new strategy entries are refused (fix1, F5)");
        Account fx = NewAccount("SIM-U3");
        Msg("order", Ord("SIM-U3", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"strategy\":{\"name\":\"S\",\"stop\":8}"));
        Check(Rejected("Order Strategies are off for this run: managed.txt could not be read; fix the file and restart") && fx.Calls.Count == 0,
              "F5: managed.txt unreadable at the start: a NEW strategy entry is refused for the run, nothing sent: " + Last());
        Msg("order", Ord("SIM-U3", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Check(fx.Calls.Count == 1 && fx.Calls[0].Contains(" s8 t16 Buy Market 1 "), "an order with a plain bracket still goes (only Order Strategies are off): " + string.Join(" | ", fx.Calls));
        foreach (Order o in fx.Orders) o.OrderState = OrderState.Cancelled;
        ChartBridgeOrders.CheckLegs(clock);
        Check(Managed().Any(m => m.Contains("\"state\":\"unmanaged\"") && m.Contains("managed.txt could not be read")) && Error("MNQ SIM-T7: breakeven and trailing could not be resumed"), "unreadable: unmanaged and said");
        ChartBridgeOrders.SaveManagedNow();
        Check(File.ReadAllText(ManagedFile) == before, "an unreadable managed.txt is never rewritten that run");
        n = f.Calls.Count;
        Tick(600); Trade(25008);
        Check(f.Calls.Count == n, "unreadable: the stop is never moved");
        foreach (Order o in f.Orders) if (o.OrderState != OrderState.Filled) o.OrderState = OrderState.Cancelled;
        SetPos(f, 0, 0);
        ChartBridgeOrders.PlanReadRetryMs = 600;
        Restart();
    }

    // ------------------------------------------------------------ fills while ChartBridge was restarting
    static void RestartFills()
    {
        Config(false, true);
        Trade(25000);
        // a resting strategy entry part filled before the restart, the rest filled while it was stopped: the 2 s scan
        // legs what the settled position holds, from the names and managed.txt, at that increment's own price
        Account a = NewAccount("SIM-U1");
        Msg("order", Ord("SIM-U1", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":2,\"price\":24990,\"strategy\":{\"name\":\"Halves\",\"stop\":8,\"t1\":8,\"t1Share\":50,\"t2\":16,\"t2Share\":50}"));
        Order e = a.Orders[0];
        string t = Tag(e);
        Fill(a, e, 1, 24990);
        Check(a.Calls.Count == 3 && a.Calls[1].StartsWith("submit CB#" + t + " stop f1 q1 p24990 k2 "), "1 contract at 50/50: bucket 2 (a tie to the later target): " + a.Calls[1]);
        ChartBridgeOrders.SaveManagedNow();
        e.Filled = 2; e.AverageFillPrice = 24989.5; e.OrderState = OrderState.Filled;   // the second at 24989, while ChartBridge was stopped
        SetPos(a, 2, 24989.5);
        Restart();
        sent.Clear();
        Trade(24995);
        int n = a.Calls.Count;
        ChartBridgeOrders.CheckLegs(clock);
        Check(a.Calls.Count == n, "the gap is not acted on at once (an order event may still be on its way)");
        ChartBridgeOrders.CheckLegs(clock + 4500);
        List<string> legs = After(a, n);
        Check(legs.Count == 2 && legs[0] == "submit CB#" + t + " stop f2 q1 p24989 k2 Sell StopMarket 1 L0 S24987 oco:cb-" + t + "-f2-2" && legs[1] == "submit CB#" + t + " target f2 q1 p24989 k2 Sell Limit 1 L24993 S0 oco:cb-" + t + "-f2-2",
              "the fill from while it was stopped gets its pair at its own price (24989): " + string.Join(" | ", legs));
        Check(Managed().Any(m => m.Contains("\"account\":\"SIM-U1\"") && m.Contains("\"state\":\"resumed\"") && Regex.Matches(m, "\"bucket\":2").Count == 2), "resumed with both pairs: " + string.Join(" | ", Managed()));
        ChartBridgeOrders.CheckLegs(clock + 9000);
        Check(a.Calls.Count == n + 2, "nothing twice");
        foreach (Order o in a.Orders) if (o.OrderState != OrderState.Filled) o.OrderState = OrderState.Cancelled;
        SetPos(a, 0, 0);

        // Fix1 (F5): a resting strategy entry whose line is lost (a recompile before it was saved): its name carries the stop
        // ticks, so its fill still gets its protective stop (no target, never moved); said at recovery and at the fill
        Account b = NewAccount("SIM-U2");
        Msg("order", Ord("SIM-U2", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"strategy\":{\"name\":\"Lost\",\"stop\":8,\"t1\":16,\"t1Share\":100,\"beAfter\":4,\"bePlus\":0}"));
        Order le = b.Orders[0];
        Check(le.Name == "CB#" + Tag(le) + " atm sg s8", "the entry's name carries the stop ticks: " + le.Name);
        File.Delete(ManagedFile);
        Restart();
        sent.Clear();
        ChartBridgeOrders.CheckLegs(clock);
        Check(Error("MNQ SIM-U2: Order Strategy entry CB#" + Tag(le) + " could not be resumed after the restart (managed.txt has no line for it); if it fills, ChartBridge places its stop from the order's name (8 ticks from the fill)"),
              "a resting strategy entry with no line: said at recovery: " + string.Join(" | ", sent.Where(x => x.Contains("error"))));
        n = b.Calls.Count;
        sent.Clear();
        Fill(b, le, 1, 24990);
        SetPos(b, 1, 24990);
        Check(b.Calls.Count == n + 1 && b.Calls[n] == "submit CB#" + Tag(le) + " stop f1 q1 p24990 k1 Sell StopMarket 1 L0 S24988 oco:",
              "F5: its fill gets the protective stop from the order's name (8 ticks), no target: " + string.Join(" | ", After(b, n)));
        Check(Error("MNQ SIM-U2: Order Strategy entry CB#" + Tag(le) + " filled 1 and its strategy could not be read after the restart") && Error("placed its protective stop from the order's name, 8 ticks from the fill; NO TARGET"),
              "and a status error names the account and root: " + string.Join(" | ", sent.Where(x => x.Contains("error"))));
        int k = b.Calls.Count;
        Tick(600); Trade(24995); Tick(600); Trade(24996);
        Check(b.Calls.Count == k, "that stop is never moved (no breakeven from a guess)");
        foreach (Order o in b.Orders) if (o.OrderState != OrderState.Filled) o.OrderState = OrderState.Cancelled;
        SetPos(b, 0, 0);

        // a name from before fix1 ("atm sg", no stop ticks) and no line: never legs from a guess; NO STOP, naming the account and root
        Account c = NewAccount("SIM-U4");
        Order old = new Order { Account = c, Instrument = mnq, OrderAction = OrderAction.Buy, OrderType = OrderType.Limit, Quantity = 1, LimitPrice = 24990, Name = "CB#0a0b0c0d atm sg", OrderState = OrderState.Working };
        c.Orders.Add(old);
        sent.Clear();
        ChartBridgeOrders.CheckLegs(clock);
        Check(Error("MNQ SIM-U4: Order Strategy entry CB#0a0b0c0d could not be resumed after the restart (managed.txt has no line for it); if it fills it gets NO STOP"), "an old name with no line: said at recovery: " + string.Join(" | ", sent.Where(x => x.Contains("error"))));
        n = c.Calls.Count;
        sent.Clear();
        Fill(c, old, 1, 24990);
        Check(c.Calls.Count == n, "its fill gets no legs from a guess");
        Check(Error("MNQ SIM-U4: NO STOP: 1 contract(s) of Order Strategy entry CB#0a0b0c0d filled"), "and a status error naming the account and root says NO STOP");
        old.OrderState = OrderState.Filled;
        SetPos(c, 0, 0);
    }

    // Fix1 (F5): a strategy entry is accepted only once its managed.txt line is written (not later, off the order path); a write
    // that fails refuses it and nothing is sent.
    static void SavedBeforeSent()
    {
        Config(false, true);
        Trade(25000);
        Account a = NewAccount("SIM-U5");
        ChartBridgeOrders.StrategyInline = false;   // as in NinjaTrader: the page and the best price off the order path
        try
        {
            Msg("order", Ord("SIM-U5", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"strategy\":{\"name\":\"Saved\",\"stop\":8}"));
            Check(a.Calls.Count == 1 && File.Exists(ManagedFile) && File.ReadAllLines(ManagedFile).Any(l => l.StartsWith(Tag(a.Orders[0]) + "\t")),
                  "F5: the entry's managed.txt line is on disk by the time the order is sent (no async gap): " + string.Join(" | ", a.Calls));
        }
        finally { ChartBridgeOrders.StrategyInline = true; }
        ChartBridgeOrders.ManagedWriteFault = () => "the disk is full";
        int n = a.Calls.Count;
        try
        {
            Msg("order", Ord("SIM-U5", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"strategy\":{\"name\":\"Unsaved\",\"stop\":8}"));
            Check(Rejected("Order Strategy entry not sent: managed.txt could not be saved (the disk is full)") && a.Calls.Count == n,
                  "F5: managed.txt cannot be written: the strategy entry is refused, nothing sent: " + Last());
        }
        finally { ChartBridgeOrders.ManagedWriteFault = null; }
        ChartBridgeOrders.SaveManagedNow();
        Check(File.ReadAllLines(ManagedFile).Count(l => l.Contains("\"name\":\"Saved\"")) == 1 && !File.ReadAllText(ManagedFile).Contains("Unsaved"), "the refused entry left no record");
        foreach (Order o in a.Orders) o.OrderState = OrderState.Cancelled;
        ChartBridgeOrders.CheckLegs(clock);
    }

    // Fix1: the 2 s check calls a record done just as its entry's last fill comes (the fill counted as covered, its legs not yet
    // placed): the legs still go on, the record comes back, the page is told it is active again, and it is still managed.
    static void DoneRace()
    {
        Config(false, true);
        Trade(25000);
        Account a = NewAccount("SIM-U6");
        Msg("order", Ord("SIM-U6", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"strategy\":{\"name\":\"Race\",\"stop\":8,\"beAfter\":4,\"bePlus\":0}"));
        Order e = a.Orders[0];
        // the first half of the fill (KeepBracket): the entry filled and its contracts counted as covered
        System.Collections.IDictionary brackets = (System.Collections.IDictionary)typeof(ChartBridgeOrders).GetField("BracketOfEntry", PS).GetValue(null);
        object br = brackets[e];
        e.Filled = 1; e.AverageFillPrice = 24990; e.OrderState = OrderState.Filled;
        br.GetType().GetField("Covered", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance).SetValue(br, 1);
        SetPos(a, 1, 24990);
        sent.Clear();
        ChartBridgeOrders.CheckLegs(clock);   // the 2 s check, in between
        Check(Managed().Any(m => m.Contains("\"state\":\"done\"")), "the check calls it done (no leg works yet)");
        // the second half (PlaceLegs): the legs for that fill
        int n = a.Calls.Count;
        typeof(ChartBridgeOrders).GetMethod("PlaceStrategyLegs", PS).Invoke(null, new object[] { br, 1, 1, 24990.0, "MNQ SIM-U6" });
        Check(a.Calls.Count == n + 1 && a.Calls[n].StartsWith("submit CB#" + Tag(e) + " stop f1 q1 p24990 k1 Sell StopMarket 1 L0 S24988"), "the fill still gets its stop: " + string.Join(" | ", After(a, n)));
        Check(Managed().Last().Contains("\"state\":\"active\"") && Managed().Last().Contains("\"bucket\":1"), "the record is back and the page is told it is active: " + Managed().Last());
        Order stop = a.Orders[1];
        int k = a.Calls.Count;
        Tick(600); Trade(24992); Tick(600); Trade(24992.25);
        Check(a.Calls.Count == k + 1 && a.Calls.Last() == "change " + stop.Name + " L0 S24990 Q0", "and still managed: breakeven moves its stop: " + a.Calls.Last());
        foreach (Order o in a.Orders) if (o.OrderState != OrderState.Filled) o.OrderState = OrderState.Cancelled;
        SetPos(a, 0, 0);
        Trade(25000);
    }

    // ------------------------------------------------------------ done: the legs gone, the page told, the line removed
    static void Done()
    {
        Config(false, true);
        Account a = NewAccount("SIM-T8");
        Trade(25000);
        sent.Clear();
        Order e = StrategyLong(a, BeTrail, 25000);
        Order stop = a.Orders.First(o => o.Name.Contains(" stop ")), target = a.Orders.First(o => o.Name.Contains(" target "));
        ChartBridgeOrders.CheckLegs(clock);
        Check(!Managed().Any(m => m.Contains("\"account\":\"SIM-T8\"") && m.Contains("\"state\":\"done\"")), "not done while its legs work");
        stop.Filled = 1; stop.OrderState = OrderState.Filled; Update(a, stop);
        Check(a.Calls.Last() == "cancel " + target.Name, "the stop fills: its target is cancelled (v2's partner rule)");
        target.OrderState = OrderState.Cancelled; Update(a, target);
        SetPos(a, 0, 0);
        ChartBridgeOrders.CheckLegs(clock);
        Check(Managed().Count(m => m.Contains("\"account\":\"SIM-T8\"") && m.Contains("\"state\":\"done\"")) == 1, "done, said once");
        Check(!File.ReadAllLines(ManagedFile).Any(l => l.StartsWith(Tag(e) + "\t")), "its line leaves managed.txt");
        // the page that signs in later gets every live managed entry
        Order e2 = StrategyLong(a, BeTrail, 25000);
        ChartBridgeClient late = new ChartBridgeClient(null, 43) { Origin = "http://localhost:8765" };
        List<string> got = new List<string>();
        late.Tap = s => got.Add(s);
        ChartBridgeV3.OnClient(late, "{\"type\":\"client\",\"v\":3}");
        ChartBridgeOrders.OnMessage(late, "auth", "{\"type\":\"auth\",\"token\":\"" + ChartBridgeOrders.SessionJson().Split('"')[3] + "\"}");
        Check(got.Any(m => m.StartsWith("{\"type\":\"managed\"") && m.Contains("\"id\":\"" + IdOf(e2) + "\"") && m.Contains("\"state\":\"active\"")), "a v3 page signing in gets the live managed entries");
        foreach (Order o in a.Orders) if (o.OrderState != OrderState.Filled) o.OrderState = OrderState.Cancelled;
        SetPos(a, 0, 0);
    }
}
