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
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, SIM-S1, SIM-S2, SIM-S3, SIM-S4, SIM-S5, SIM-S6, SIM-S7, SIM-S8, SIM-S9, SIM-T1, SIM-T2, SIM-T3, SIM-T4, SIM-T5, SIM-T6, SIM-T7, SIM-T8, SIM-U1, SIM-U2, SIM-U3, SIM-U4, SIM-U5, SIM-U6, SIM-U7, SIM-B1, SIM-B2, SIM-B3, SIM-B4, SIM-B5, SIM-B6, SIM-B7, SIM-K1, SIM-K2, SIM-K3, SIM-K4, SIM-R1, SIM-R2, SIM-R3, SIM-R4, SIM-R5, SIM-R6, SIM-R7, SIM-R8, SIM-R9, SIM-R10, SIM-R11");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "6");
        ChartBridgeSwitches.Note("orderTypes", orderTypes ? "on" : "off");   // integration: ChartBridgeConfig.Load records every v3 switch in ChartBridgeSwitches
        ChartBridgeSwitches.Note("strategies", strategies ? "On" : "off");
    }

    static TimeZoneInfo zoneWas;
    public static void Run(Action<bool, string> check)
    {
        Check = check;
        zoneWas = NinjaTrader.Core.GeneralOptionsClass.Zone;   // NtClock sets New York; Run's finally puts this back
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
            PlacingNotRestart(); // 0.6.10
            BarTrail();          // next build (after the restarts: its entries stay managed)
            TrailReview();       // review of PR #75: the session across a restart and a feed drop, the kind held, a flat position
            FillSessions();      // 1.42: the session from the execution's own time; the session field only for a bar trail
            Done();
            Check(!sentV2.Any(m => m.Contains("\"type\":\"managed\"")), "a v2 page never gets a managed message");
        }
        catch (Exception ex) { Check(false, "strategies harness threw: " + ex); }
        finally
        {
            ChartBridgeServer.ClockForHarness = null;
            NinjaTrader.Core.GeneralOptionsClass.Zone = zoneWas;   // 1.42: as it was before this harness (as GapHarness), not null
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
            // next build: the bar trail
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrail\":2", "barTrail and barTrailOffset go together" },
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrailOffset\":1", "barTrail and barTrailOffset go together" },
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrail\":0,\"barTrailOffset\":1", "barTrail must be a whole number of bars from 1 to 50" },
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrail\":51,\"barTrailOffset\":1", "barTrail must be a whole number of bars from 1 to 50" },
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrail\":\"2\",\"barTrailOffset\":1", "barTrail must be a whole number of bars" },
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrail\":2.5,\"barTrailOffset\":1", "barTrail must be a whole number of bars" },
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrail\":2,\"barTrailOffset\":-1", "barTrailOffset must be a whole number of ticks from 0 to 100" },
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrail\":2,\"barTrailOffset\":101", "barTrailOffset must be a whole number of ticks from 0 to 100" },
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrail\":2,\"barTrailOffset\":null", "barTrailOffset must be a whole number of ticks" },
            new[] { "\"name\":\"S\",\"stop\":8,\"trailAfter\":8,\"trailBy\":4,\"trailStep\":1,\"barTrail\":2,\"barTrailOffset\":1", "barTrail and trailAfter are refused together: one trail per strategy" },
            // Anthony 2026-11-01: any bar kind and an optional start
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrailType\":\"range\",\"barTrailSize\":40", "barTrailType, barTrailSize and barTrailStart need barTrail" },
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrailStart\":8", "barTrailType, barTrailSize and barTrailStart need barTrail" },
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrail\":2,\"barTrailOffset\":1,\"barTrailType\":\"hour\",\"barTrailSize\":1", "barTrailType must be \\\"minute\\\" or \\\"range\\\"" },
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrail\":2,\"barTrailOffset\":1,\"barTrailType\":5,\"barTrailSize\":1", "barTrailType must be" },
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrail\":2,\"barTrailOffset\":1,\"barTrailType\":\"range\"", "barTrailType and barTrailSize go together (both or neither)" },
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrail\":2,\"barTrailOffset\":1,\"barTrailSize\":40", "barTrailType and barTrailSize go together (both or neither)" },
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrail\":2,\"barTrailOffset\":1,\"barTrailType\":\"range\",\"barTrailSize\":\"40\"", "barTrailSize must be a whole number" },
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrail\":2,\"barTrailOffset\":1,\"barTrailType\":\"minute\",\"barTrailSize\":7", "barTrailSize for minute bars must be 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 or 60" },
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrail\":2,\"barTrailOffset\":1,\"barTrailType\":\"range\",\"barTrailSize\":0", "barTrailSize for range bars must be a whole number of ticks from 1 to 400" },
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrail\":2,\"barTrailOffset\":1,\"barTrailType\":\"range\",\"barTrailSize\":401", "barTrailSize for range bars must be a whole number of ticks from 1 to 400" },
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrail\":2,\"barTrailOffset\":1,\"barTrailStart\":-1", "barTrailStart must be a whole number of ticks from 0 to 2000" },
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrail\":2,\"barTrailOffset\":1,\"barTrailStart\":2001", "barTrailStart must be a whole number of ticks from 0 to 2000" },
            new[] { "\"name\":\"S\",\"stop\":8,\"barTrail\":2,\"barTrailOffset\":1,\"barTrailStart\":null", "barTrailStart must be a whole number of ticks from 0 to 2000" },
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

    // ------------------------------------------------------------ the bar trail (next build)
    // A trade's New York wall time (made up): 30 October 2026, h:m:s, as ChartBridgeTime.EtSeconds gives it (the chart's convention).
    static double Et(int d, int h, int m, double sec) { return EtN(10, d, h, m, sec); }
    static double EtN(int mo, int d, int h, int m, double sec) { return (new DateTime(2026, mo, d, h, m, 0) - new DateTime(1970, 1, 1)).TotalSeconds + sec; }
    // The simulated NinjaTrader clock (New York time, NinjaTrader set to New York) follows the trades from the bar trail on: the
    // session an entry fills in and the session at a restart are read from it (review HIGH 1), and a feed drop's time (HIGH 2).
    static DateTime simNt = new DateTime(2026, 10, 30, 10, 0, 0);
    static void NtClock()
    {
        NinjaTrader.Core.GeneralOptionsClass.Zone = ChartBridgeTime.Eastern;
        ChartBridgeServer.ClockForHarness = () => simNt;
    }
    static void At(double et) { simNt = new DateTime(1970, 1, 1).AddSeconds(et); }
    static void TradeAt(int h, int m, int sec, double price) { At(Et(30, h, m, sec)); ChartBridgeOrders.NoteLast("MNQ", price, Et(30, h, m, sec)); }
    static void TradeAtN(int mo, int d, int h, int m, double sec, double price) { At(EtN(mo, d, h, m, sec)); ChartBridgeOrders.NoteLast("MNQ", price, EtN(mo, d, h, m, sec)); }
    const string BarTrailS = "\"name\":\"Bar trail\",\"stop\":16,\"t1\":40,\"t1Share\":100,\"barTrail\":2,\"barTrailOffset\":1";

    static void BarTrail()
    {
        Config(false, true);
        NtClock();
        ChartBridgeOrders.BarTrailFeedDropped(null);   // start clean: no bar before this case
        Account a = NewAccount("SIM-B1");
        TradeAt(10, 0, 30, 25000);                      // the first bar seen (to 10:01) is partial: never used
        Tick(1000); TradeAt(10, 1, 10, 25000.5);        // bar B (to 10:02) begins; the partial one is not counted
        Check(ChartBridgeOrders.BarTrailBars("MNQ") == 0, "the first bar after a start is seen only in part: not used");
        Tick(1000); TradeAt(10, 1, 40, 24999.5);        // bar B: high 25000.5, low 24999.5
        sent.Clear();
        Order e = StrategyLong(a, BarTrailS, 25000);
        Order stop = a.Orders[1];
        Check(a.Calls[1].Contains(" Sell StopMarket 1 L0 S24996 "), "long 1 at 25000 with a 2 bar trail: stop 24996: " + a.Calls[1]);
        Check(Managed().Any(m => m.Contains("\"barTrail\":2,\"barTrailOffset\":1,\"barTrailType\":\"minute\",\"barTrailSize\":1}")), "backward compatible: a strategy with no bar kind (the first build's) is 1 minute bars, and the managed message says so");
        Check(Managed().Last(m => m.Contains("\"account\":\"SIM-B1\"")).Contains("\"barTrail\":{\"state\":\"building\",\"text\":\"waiting for 2 whole 1 minute bars\"}"),
              "the bar trail's state on the chart: waiting for 2 whole bars: " + Managed().Last(m => m.Contains("\"account\":\"SIM-B1\"")));
        int n = a.Calls.Count;
        Tick(1000); TradeAt(10, 2, 5, 25001);           // closes B: one whole bar, the trail needs two
        Check(ChartBridgeOrders.BarTrailBars("MNQ") == 1 && a.Calls.Count == n, "one completed bar of two: no move");
        Tick(1000); TradeAt(10, 2, 30, 25000.75);       // bar C: high 25001, low 25000.75
        Check(a.Calls.Count == n, "inside a bar: no move");
        Tick(1000); TradeAt(10, 3, 1, 25002);           // closes C: the lowest low of B and C is 24999.5, less 1 tick: 24999.25
        Check(a.Calls.Count == n + 1 && a.Calls.Last() == "change " + stop.Name + " L0 S24999.25 Q0", "the bar close: the stop to the lowest low of the last 2 bars less 1 tick (24999.25): " + a.Calls.Last());
        sent.Clear();
        Confirm(a, stop, 24999.25);
        Check(Managed().Any(m => m.Contains("\"stop\":24999.25") && m.Contains("\"trailing\":true") && m.Contains("\"barTrail\":{\"state\":\"on\",\"text\":null}")), "confirmed: managed says trailing, the bar trail on");
        Tick(1000); TradeAt(10, 3, 30, 25005);          // bar D: high 25005
        Tick(1000); TradeAt(10, 4, 0, 25002);           // 10:04:00 exactly is still bar D (end-inclusive): its low 25002
        Check(a.Calls.Count == n + 1, "a new high inside the bar: no move until the bar closes");
        Tick(1000); TradeAt(10, 4, 10, 25004.5);        // closes D: lows C 25000.75, D 25002: 25000.5
        Check(a.Calls.Count == n + 2 && a.Calls.Last() == "change " + stop.Name + " L0 S25000.5 Q0", "the next close: 25000.5 (the lowest low of C and D less 1 tick): " + a.Calls.Last());
        Confirm(a, stop, 25000.5);
        Tick(1000); TradeAt(10, 4, 40, 25000.75);       // bar E: low 25000.75
        Tick(1000); TradeAt(10, 5, 2, 25003);           // closes E: lows D 25002, E 25000.75: 25000.5, the stop already there
        Check(a.Calls.Count == n + 2, "a level no tighter than the stop: no move (never loosens)");
        // a level a bar close set but could not send yet (at or through the last trade) is dropped by a feed drop
        Tick(1000); TradeAt(10, 5, 30, 25004);          // bar E2 (from 10:05:02): 25003 .. 25004
        Tick(1000); TradeAt(10, 6, 1, 25005);           // closes E2: lows E 25000.75, E2 25003: 25000.5, the stop already there
        Tick(1000); TradeAt(10, 6, 30, 25005.5);        // bar E3: 25005 .. 25005.5
        Tick(1000); TradeAt(10, 7, 1, 25002.5);         // closes E3: lows E2 25003, E3 25005: 25002.75, above this trade: it waits
        Check(a.Calls.Count == n + 2, "a level at or through the last trade waits (25002.75 over 25002.5)");
        // a feed drop: the bars before it are forgotten, no bar is forming, and the waiting level is dropped
        ChartBridgeOrders.BarTrailFeedDropped("MNQ");
        Check(ChartBridgeOrders.BarTrailBars("MNQ") == 0, "a feed drop forgets the bars");
        // review HIGH: the feed is back at 10:08:20, a later minute than the bar forming at the drop, part way into it (10:08:00 to
        // 10:08:20 missed): that bar is partial, never whole
        Tick(1000); TradeAt(10, 8, 20, 25009);          // the first trade after the drop: a partial bar (its low may be too high)
        Check(a.Calls.Count == n + 2, "after a feed drop the waiting level is not sent (it came from bars before the drop)");
        Tick(1000); TradeAt(10, 8, 45, 25009.5);
        Tick(1000); TradeAt(10, 9, 5, 25008);           // closes the partial bar: never counted
        Check(ChartBridgeOrders.BarTrailBars("MNQ") == 0 && a.Calls.Count == n + 2, "review HIGH: the first bar after a feed drop, joined part way into its minute, is never a whole bar");
        Tick(1000); TradeAt(10, 9, 40, 25008.5);        // bar F (from 10:09:05): 25008 .. 25008.5
        Tick(1000); TradeAt(10, 10, 5, 25009);           // closes F: one whole bar of two
        Check(ChartBridgeOrders.BarTrailBars("MNQ") == 1 && a.Calls.Count == n + 2, "after the drop: one whole bar, no move yet (with the partial bar counted it would have moved here)");
        // never at or through the last trade: G closes with a trade at 25007.5, below the level G's close sets (25007.75)
        Tick(1000); TradeAt(10, 10, 30, 25008.5);        // bar G: 25009 .. 25008.5
        Tick(1000); TradeAt(10, 11, 1, 25007.5);        // closes G: lows F 25008, G 25008.5: 25007.75, above this trade (25007.5)
        Check(a.Calls.Count == n + 2, "a bar level at or through the last trade: it waits for the next trade");
        Tick(1000); TradeAt(10, 11, 20, 25008);         // above it now: sent (the level set at the close, not a new one)
        Check(a.Calls.Count == n + 3 && a.Calls.Last() == "change " + stop.Name + " L0 S25007.75 Q0", "the next trade above it: moved to 25007.75 (from whole bars after the drop): " + a.Calls.Last());
        Confirm(a, stop, 25007.75);
        // a trade with no time (the old path) never builds or closes a bar
        int bars = ChartBridgeOrders.BarTrailBars("MNQ");
        Tick(1000); Trade(25012);
        Check(ChartBridgeOrders.BarTrailBars("MNQ") == bars && a.Calls.Count == n + 3, "a trade with no time: no bar and no move");
        SetPos(a, 0, 0);

        // a short: the highest high of the last 2 bars plus the offset, on the loose side of the grid
        Account b = NewAccount("SIM-B2");
        Msg("order", Ord(b.Name, "\"side\":\"sell\",\"kind\":\"market\",\"qty\":1,\"strategy\":{\"name\":\"Bar short\",\"stop\":16,\"t1\":40,\"t1Share\":100,\"barTrail\":2,\"barTrailOffset\":2}"));
        Order se = b.Orders.Last();
        Fill(b, se, 1, 25010); SetPos(b, -1, 25010);
        Order sstop = b.Orders[1];
        Check(b.Calls[1].Contains(" Buy StopMarket 1 L0 S25014 "), "short 1 at 25010: stop 25014: " + b.Calls[1]);
        int ns = b.Calls.Count;
        Tick(1000); TradeAt(10, 11, 50, 25009);         // bar H (to 10:12): 25007.5 .. 25009 (25007.5 at 10:11:01 began it)
        Tick(1000); TradeAt(10, 12, 30, 25008.25);      // closes H; bar I begins
        Tick(1000); TradeAt(10, 12, 50, 25007);         // bar I: 25007 .. 25008.25
        Tick(1000); TradeAt(10, 13, 5, 25006);          // closes I: highs H 25009, I 25008.25: 25009 plus 2 ticks 25009.5
        Check(b.Calls.Count == ns + 1 && b.Calls.Last() == "change " + sstop.Name + " L0 S25009.5 Q0", "a short: the stop to the highest high of the last 2 bars plus 2 ticks (25009.5): " + b.Calls.Last());
        Confirm(b, sstop, 25009.5);
        SetPos(b, 0, 0);

        // the bar trail with breakeven: the tighter level wins, and it still never loosens
        Account c = NewAccount("SIM-B3");
        Order ce = StrategyLong(c, "\"name\":\"BE bars\",\"stop\":16,\"t1\":40,\"t1Share\":100,\"beAfter\":4,\"bePlus\":2,\"barTrail\":1,\"barTrailOffset\":0", 25006);
        Order cstop = c.Orders[1];
        int nc = c.Calls.Count;
        Tick(1000); TradeAt(10, 13, 40, 25007.25);      // 5 ticks in profit: breakeven plus 2 (25006.5)
        Check(c.Calls.Count == nc + 1 && c.Calls.Last() == "change " + cstop.Name + " L0 S25006.5 Q0", "breakeven first (25006.5): " + c.Calls.Last());
        Confirm(c, cstop, 25006.5);
        Tick(1000); TradeAt(10, 14, 5, 25008);          // closes J (25006 .. 25007.25): its low 25006 is looser than the stop
        Check(c.Calls.Count == nc + 1, "a bar level below breakeven: no move (never loosens)");
        Tick(1000); TradeAt(10, 14, 30, 25009);
        Tick(1000); TradeAt(10, 15, 2, 25009.5);        // closes K (25008 .. 25009): 25008
        Check(c.Calls.Count == nc + 2 && c.Calls.Last() == "change " + cstop.Name + " L0 S25008 Q0", "then the bar trail, once it is tighter (25008): " + c.Calls.Last());
        Confirm(c, cstop, 25008);
        SetPos(c, 0, 0);
        BarKinds();
    }

    // ------------------------------------------------------------ any bar kind and the start (Anthony 2026-11-01)
    static Order Entry(Account a, bool buy, string strategy, double fill)
    {
        Msg("order", Ord(a.Name, "\"side\":\"" + (buy ? "buy" : "sell") + "\",\"kind\":\"market\",\"qty\":1,\"strategy\":{" + strategy + "}"));
        Order e = a.Orders.Last();
        Fill(a, e, 1, fill); SetPos(a, buy ? 1 : -1, fill);
        return e;
    }
    static void TradeAtD(int d, int h, int m, double sec, double price) { TradeAtN(10, d, h, m, sec, price); }

    static void BarKinds()
    {
        // 5 minute bars: their own bars beside the 1 minute ones, end-inclusive at the 5 minute edge, the first one partial
        Account a = NewAccount("SIM-B4");
        Entry(a, true, "\"name\":\"M5\",\"stop\":16,\"t1\":80,\"t1Share\":100,\"barTrail\":1,\"barTrailOffset\":0,\"barTrailType\":\"minute\",\"barTrailSize\":5", 25010);
        Order stop = a.Orders[1];
        Check(Managed().Any(m => m.Contains("\"barTrailType\":\"minute\",\"barTrailSize\":5")), "a 5 minute bar trail: taken, the managed message says minute 5");
        int n = a.Calls.Count;
        Tick(1000); TradeAt(10, 21, 0, 25011);          // the 5 minute bars start here: the bar to 10:25 is partial
        Tick(1000); TradeAt(10, 24, 30, 25012);
        Tick(1000); TradeAt(10, 25, 0, 25013);          // 10:25:00 is still that bar (end-inclusive)
        Tick(1000); TradeAt(10, 25, 1, 25013.5);        // closes it: partial, never used; the bar to 10:30 begins
        Check(ChartBridgeOrders.BarTrailBars("MNQ", "minute", 5) == 0 && a.Calls.Count == n, "5 minute bars: the first one, joined part way, is never used");
        Tick(1000); TradeAt(10, 27, 0, 25012.25);
        Tick(1000); TradeAt(10, 29, 0, 25014);
        Tick(1000); TradeAt(10, 30, 0, 25013);          // still the bar to 10:30
        Check(ChartBridgeOrders.BarTrailBars("MNQ", "minute", 5) == 0 && ChartBridgeOrders.BarTrailBars("MNQ") >= 3 && a.Calls.Count == n, "5 minute bars: 1 minute bars closed meanwhile, the 5 minute bar has not: no move");
        Tick(1000); TradeAt(10, 30, 1, 25014.5);        // closes the bar to 10:30: low 25012.25
        Check(ChartBridgeOrders.BarTrailBars("MNQ", "minute", 5) == 1 && a.Calls.Count == n + 1 && a.Calls.Last() == "change " + stop.Name + " L0 S25012.25 Q0",
              "5 minute bars: at the 10:30 close the stop goes to that bar's low (25012.25): " + a.Calls.Last());
        Confirm(a, stop, 25012.25);
        SetPos(a, 0, 0);

        // Range 4 (MNQ 1 point), NinjaTrader's rules: unproven bars never used, the sync by a swing of more than the range each way,
        // a bar finished at exactly the range, the next one tick on, phantom bars through a gap. Anthony 2026-11-01: the trail uses
        // only prices that traded: a bar's traded high and low (not NinjaTrader's drawn edges), and phantom bars (no trade in them)
        // are left out. A short with a 1 bar trail, so the last completed bar alone sets the level.
        Account b = NewAccount("SIM-B5");
        Entry(b, false, "\"name\":\"R4\",\"stop\":16,\"t1\":80,\"t1Share\":100,\"barTrail\":1,\"barTrailOffset\":0,\"barTrailType\":\"range\",\"barTrailSize\":4", 25021);
        Order sstop = b.Orders[1];
        Check(b.Calls[1].Contains(" Buy StopMarket 1 L0 S25025 "), "short 1 at 25021 with a range 4 bar trail: stop 25025: " + b.Calls[1]);
        Check(ChartBridgeOrders.BarTrailKinds("MNQ") == 3, "the range 4 kind is made at placement (beside 1 and 5 minute): " + ChartBridgeOrders.BarTrailKinds("MNQ"));
        int nb = b.Calls.Count;
        Tick(1000); TradeAt(11, 0, 1, 25020);           // the range bars start here (open 25020), not proven NinjaTrader's yet
        Check(Managed().Last(m => m.Contains("\"account\":\"SIM-B5\"")).Contains("\"barTrail\":{\"state\":\"notProven\",\"text\":\"not proven yet:"),
              "range bars ChartBridge has not seen from the session open: managed says not proven yet: " + Managed().Last(m => m.Contains("\"account\":\"SIM-B5\"")));
        Tick(1000); TradeAt(11, 0, 2, 25020.5);
        Tick(1000); TradeAt(11, 0, 3, 25021.25);        // past low + range (25021): that bar finished at 25021, the next opens a tick on
        Tick(1000); TradeAt(11, 0, 4, 25022.5);         // past 25021.25 + range: finished at 25022.25, the next opens at 25022.5
        Check(ChartBridgeOrders.BarTrailBars("MNQ", "range", 4) == 0 && b.Calls.Count == nb, "range: bars before the sync point are never used (" + ChartBridgeOrders.BarTrailBars("MNQ", "range", 4) + ")");
        Tick(1000); TradeAt(11, 0, 5, 25021);           // a rise of more than the range from the low, then a fall of more than it below the high: synced
        Check(ChartBridgeOrders.BarTrailBars("MNQ", "range", 4) == 0, "range: the bar finished on the sync trade is not proven either");
        Check(Managed().Last(m => m.Contains("\"account\":\"SIM-B5\"")).Contains("\"barTrail\":{\"state\":\"building\""), "proven by the swing: managed says it waits for a whole bar");
        Tick(1000); TradeAt(11, 0, 6, 25020);           // finishes the first proven bar: drawn 25021.25 .. 25020.25 (exactly the range), only 25021 traded in it
        List<double[]> done = ChartBridgeOrders.BarTrailDone("MNQ", "range", 4);
        Check(done.Count == 1 && done[0][0] == 25021 && done[0][1] == 25021,
              "range: the first proven bar, as traded (25021 .. 25021, not NinjaTrader's drawn 25021.25 .. 25020.25, neither of which traded): " + string.Join(" ", done.Select(x => x[0] + "/" + x[1]).ToArray()));
        Check(b.Calls.Count == nb + 1 && b.Calls.Last() == "change " + sstop.Name + " L0 S25021 Q0", "range: the short's stop to that bar's traded high (25021), a price that traded: " + b.Calls.Last());
        Confirm(b, sstop, 25021);
        Check(Managed().Last(m => m.Contains("\"account\":\"SIM-B5\"")).Contains("\"barTrail\":{\"state\":\"on\""), "the bars are ready: managed says on");
        Tick(1000); TradeAt(11, 0, 7, 25017.5);         // a gap down through more than the range: the bar finished (25020 traded), a phantom bar
                                                         // 25018.75 .. 25017.75 (no trade in it), then the trade's bar
        done = ChartBridgeOrders.BarTrailDone("MNQ", "range", 4);
        Check(done.Count == 2 && done[1][0] == 25020 && done[1][1] == 25020 && ChartBridgeOrders.BarTrailPhantoms("MNQ", "range", 4) == 1,
              "THE PHANTOM RULE: the phantom bar NinjaTrader draws in the gap had no trade: left out; the last completed bar is the one that traded (25020): " + string.Join(" ", done.Select(x => x[0] + "/" + x[1]).ToArray()));
        Check(b.Calls.Count == nb + 2 && b.Calls.Last() == "change " + sstop.Name + " L0 S25020 Q0",
              "the short's stop to 25020, the last bar that traded (counted, the phantom bar would have put it at 25018.75, a price that never traded): " + b.Calls.Last());
        Confirm(b, sstop, 25020);
        Tick(1000); TradeAt(11, 0, 8, 25018);           // inside the forming bar: no bar closes, no move
        Check(b.Calls.Count == nb + 2, "range: inside the forming bar nothing moves");
        // a gap up through several ranges in one trade: every bar it makes but the last is a phantom bar
        long ph = ChartBridgeOrders.BarTrailPhantoms("MNQ", "range", 4);
        Tick(1000); TradeAt(11, 0, 9, 25022.75);        // from the bar 25017.5 .. 25018: finished at 25018.5, phantom 25018.75 .. 25019.75,
                                                         // 25020 .. 25021, 25021.25 .. 25022.25, then 25022.5 holding the trade
        done = ChartBridgeOrders.BarTrailDone("MNQ", "range", 4);
        Check(ChartBridgeOrders.BarTrailPhantoms("MNQ", "range", 4) == ph + 3 && done.Count == 3 && done[2][0] == 25018 && done[2][1] == 25017.5,
              "a jump of several ranges: 3 phantom bars left out, the finished bar kept as traded (25018 .. 25017.5): " + string.Join(" ", done.Select(x => x[0] + "/" + x[1]).ToArray()));
        Check(b.Calls.Count == nb + 2, "a level through the last trade (a short at 25018 under 25022.75) is never sent");
        // a feed drop: every kind starts over; range bars are not proven again until a swing or the next session's open
        ChartBridgeOrders.BarTrailFeedDropped("MNQ");
        Check(ChartBridgeOrders.BarTrailBars("MNQ", "range", 4) == 0 && ChartBridgeOrders.BarTrailBars("MNQ", "minute", 5) == 0, "a feed drop: every bar kind starts over");
        Check(Managed().Last(m => m.Contains("\"account\":\"SIM-B5\"")).Contains("\"barTrail\":{\"state\":\"notProven\""), "after a feed drop, range bars are not proven yet again, and managed says so");
        Tick(1000); TradeAt(16, 58, 0, 25022);          // after the drop: a bar not proven
        Tick(1000); TradeAt(16, 58, 30, 25020.75);      // breaks down: the unproven bar is not used
        Check(ChartBridgeOrders.BarTrailBars("MNQ", "range", 4) == 0 && b.Calls.Count == nb + 2, "range after a drop: bars not proven are never used");

        // Anthony 2026-11-01, every trade closes by the end of the day: the bar trail ends at the session close. The short is still
        // open at 18:00 (it should not be): the new session's first trade starts every kind over and ends its bar trail
        Tick(1000); TradeAt(18, 0, 1, 25016);           // the 18:00 session's first trade: a new bar at its price, proven (Break at EOD)
        Check(Managed().Last(m => m.Contains("\"account\":\"SIM-B5\"")).Contains("\"barTrail\":{\"state\":\"ended\",\"text\":\"ended at the session close"),
              "the session closed with the short open: managed says its bar trail ended: " + Managed().Last(m => m.Contains("\"account\":\"SIM-B5\"")));
        Tick(1000); TradeAt(18, 0, 2, 25017.25);        // past 25016 + range: the first proven bar of the new session (only 25016 traded)
        done = ChartBridgeOrders.BarTrailDone("MNQ", "range", 4);
        Check(done.Count == 1 && done[0][0] == 25016 && done[0][1] == 25016, "range: the session's first trade starts a proven bar at its price, nothing kept from the session before: " + string.Join(" ", done.Select(x => x[0] + "/" + x[1]).ToArray()));
        Tick(1000); TradeAt(18, 0, 3, 25016);           // closes 25017.25 .. 25017.25: a 1 bar trail would set 25017.25, below the stop and over this trade
        Check(b.Calls.Count == nb + 2 && sstop.StopPrice == 25020, "ended at the session close: a bar of the new session never moves the stop (it stays at 25020)");
        Check(ChartBridgeOrders.BarTrailBars("MNQ") == 0, "the 1 minute bars start over at the session open too (nothing carried past the close)");
        SetPos(b, 0, 0);
        Tick(1000); TradeAt(18, 1, 1, 25016.25);        // closes the 18:00 to 18:01 minute: whole, as the session's first bar (ChartBridge saw the open)
        Check(ChartBridgeOrders.BarTrailBars("MNQ") == 1, "the session's first 1 minute bar is whole when ChartBridge saw the session open");

        // the start: a long with barTrailStart 8 ticks; a bar close while the open profit (its best since the fill) is under 8 sets no level
        Account c = NewAccount("SIM-B6");
        Tick(1000); TradeAt(18, 10, 0, 25030);          // the market at the fill (a stop already passed would exit at market)
        Entry(c, true, "\"name\":\"Start L\",\"stop\":16,\"t1\":80,\"t1Share\":100,\"barTrail\":1,\"barTrailOffset\":0,\"barTrailType\":\"minute\",\"barTrailSize\":1,\"barTrailStart\":8", 25030);
        Order cstop = c.Orders[1];
        Check(Managed().Any(m => m.Contains("\"barTrailSize\":1,\"barTrailStart\":8}")), "the start: the managed message carries barTrailStart 8");
        int nc = c.Calls.Count;
        Tick(1000); TradeAt(18, 20, 10, 25030.5);
        Tick(1000); TradeAt(18, 21, 5, 25031);          // closes the bar to 18:21 (low 25030.5 or lower) with the open profit 2 ticks
        Tick(1000); TradeAt(18, 21, 20, 25031.25);
        Check(c.Calls.Count == nc, "the start (long): under 8 ticks of open profit at the close, no level, no move");
        Tick(1000); TradeAt(18, 21, 40, 25032.5);       // best 25032.5: 10 ticks
        Tick(1000); TradeAt(18, 22, 5, 25032.25);       // closes the bar to 18:22 (25031 .. 25032.5): started, its low 25031
        Check(c.Calls.Count == nc + 1 && c.Calls.Last() == "change " + cstop.Name + " L0 S25031 Q0", "the start (long): once the open profit reached 8 ticks, at the next close the stop to that bar's low (25031): " + c.Calls.Last());
        Confirm(c, cstop, 25031);
        SetPos(c, 0, 0);
        Account d = NewAccount("SIM-B7");
        Entry(d, false, "\"name\":\"Start S\",\"stop\":16,\"t1\":80,\"t1Share\":100,\"barTrail\":1,\"barTrailOffset\":0,\"barTrailType\":\"minute\",\"barTrailSize\":1,\"barTrailStart\":8", 25040);
        Order dstop = d.Orders[1];
        int nd = d.Calls.Count;
        Tick(1000); TradeAt(18, 30, 10, 25039.5);
        Tick(1000); TradeAt(18, 31, 5, 25039.25);       // closes the bar to 18:31 with the open profit 2 ticks
        Check(d.Calls.Count == nd, "the start (short): under 8 ticks, no move");
        Tick(1000); TradeAt(18, 31, 30, 25037.5);       // best 25037.5: 10 ticks
        Tick(1000); TradeAt(18, 32, 5, 25037.75);       // closes the bar to 18:32 (25039.25 .. 25037.5): started, its high 25039.25
        Check(d.Calls.Count == nd + 1 && d.Calls.Last() == "change " + dstop.Name + " L0 S25039.25 Q0", "the start (short): at the next close the stop to that bar's high (25039.25): " + d.Calls.Last());
        Confirm(d, dstop, 25039.25);
        SetPos(d, 0, 0);
        BarKindRoom();
    }

    // ------------------------------------------------------------ the 17th bar kind (Anthony 2026-11-01: never silently doing nothing)
    // ChartBridge builds at most 16 bar kinds a market at once. A kind no live entry uses gives its place to a new one; an entry that
    // would need a 17th kind in use at once is refused at placement, with the reason, and nothing reaches the account.
    static void BarKindRoom()
    {
        Config(false, true);
        List<Order> resting = new List<Order>();
        Account[] accts = { NewAccount("SIM-K1"), NewAccount("SIM-K2"), NewAccount("SIM-K3"), NewAccount("SIM-K4") };
        Tick(1000); TradeAt(19, 0, 0, 25050);
        int inUse = ChartBridgeOrders.BarTrailKinds("MNQ");
        Check(inUse == 3, "before: 1 minute, 5 minute and range 4 bars held: " + inUse);
        // resting buy limits far under the market (never filled here), each on its own range size: 13 more kinds make 16; then the
        // 5 minute and range 4 kinds, whose entries' bar trails ended at the session close, give their places to range 23 and 24
        for (int i = 0; i < 15; i++)
        {
            Account a = accts[i / 4];
            sent.Clear();
            Msg("order", Ord(a.Name, "\"side\":\"buy\",\"kind\":\"limit\",\"price\":25000,\"qty\":1,\"strategy\":{\"name\":\"K" + i + "\",\"stop\":16,\"t1\":40,\"t1Share\":100,\"barTrail\":1,\"barTrailOffset\":0,\"barTrailType\":\"range\",\"barTrailSize\":" + (10 + i) + "}"));
            Check(!Rejected("") && ChartBridgeOrders.BarTrailKinds("MNQ") == Math.Min(16, 4 + i), "a bar trail on range " + (10 + i) + " is taken (" + ChartBridgeOrders.BarTrailKinds("MNQ") + " kinds held): " + Last());
            resting.Add(a.Orders.Last());
        }
        Check(ChartBridgeOrders.BarTrailBars("MNQ", "minute", 5) == 0 && ChartBridgeOrders.BarTrailDone("MNQ", "range", 4).Count == 0 && ChartBridgeOrders.BarTrailKinds("MNQ") == 16,
              "kinds no live entry uses (5 minute, range 4) gave their places; 16 held, every one in use");
        // every kind is in use now: the 17th is refused, plainly, and nothing reaches the account
        Account k4 = accts[3];
        int calls = k4.Calls.Count;
        sent.Clear();
        Msg("order", Ord(k4.Name, "\"side\":\"buy\",\"kind\":\"limit\",\"price\":25000,\"qty\":1,\"strategy\":{\"name\":\"K17\",\"stop\":16,\"t1\":40,\"t1Share\":100,\"barTrail\":1,\"barTrailOffset\":0,\"barTrailType\":\"minute\",\"barTrailSize\":15}"));
        Check(Rejected("the bar trail on 15 minute bars cannot run: ChartBridge builds at most 16 bar kinds on MNQ at once and open strategy entries use them all") && k4.Calls.Count == calls,
              "the 17th kind in use at once is refused plainly, nothing sent: " + Last());
        // a kind already held is no new kind: taken
        sent.Clear();
        Msg("order", Ord(k4.Name, "\"side\":\"buy\",\"kind\":\"limit\",\"price\":25000,\"qty\":1,\"strategy\":{\"name\":\"K10b\",\"stop\":16,\"t1\":40,\"t1Share\":100,\"barTrail\":1,\"barTrailOffset\":0,\"barTrailType\":\"range\",\"barTrailSize\":10}"));
        Check(!Rejected(""), "a kind already held (range 10) is taken: " + Last());
        resting.Add(k4.Orders.Last());
        // one entry done (its resting entry cancelled): its kind gives its place, and the 15 minute bar trail is taken
        Order r = resting[12];   // range 22's only entry
        r.OrderState = OrderState.Cancelled; Update(accts[3], r);
        ChartBridgeOrders.CheckLegs(clock);
        sent.Clear();
        Msg("order", Ord(k4.Name, "\"side\":\"buy\",\"kind\":\"limit\",\"price\":25000,\"qty\":1,\"strategy\":{\"name\":\"K17\",\"stop\":16,\"t1\":40,\"t1Share\":100,\"barTrail\":1,\"barTrailOffset\":0,\"barTrailType\":\"minute\",\"barTrailSize\":15}"));
        Check(!Rejected("") && ChartBridgeOrders.BarTrailKinds("MNQ") == 16 && ChartBridgeOrders.BarTrailBars("MNQ", "range", 22) == 0,
              "once range 22 is no longer used, the 15 minute kind takes its place: " + Last());
        resting.Add(k4.Orders.Last());
        foreach (Account a in accts) foreach (Order o in a.Orders) if (o.OrderState != OrderState.Filled && o.OrderState != OrderState.Cancelled) { o.OrderState = OrderState.Cancelled; Update(a, o); }
        ChartBridgeOrders.CheckLegs(clock);
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

    // 0.6.10: NinjaTrader reports a new order the moment it is created, before ChartBridge registers its strategy (WORK's log).
    // That report is not a restart: no "could not be resumed" alarm, the page never sees it unmanaged, and the entry is managed
    // as usual. After a real restart the same entry, its line lost, is still recovered and still said.
    static void PlacingNotRestart()
    {
        Config(false, true);
        Trade(25000);
        Account a = NewAccount("SIM-U7");
        int reported = 0;
        a.OnCreate = o => { reported++; Update(a, o); };   // as NinjaTrader: OrderUpdate, Initialized, inside CreateOrder
        sent.Clear();
        Msg("order", Ord("SIM-U7", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"strategy\":{\"name\":\"Fresh\",\"stop\":8,\"t1\":16,\"t1Share\":100,\"beAfter\":4,\"bePlus\":0}"));
        Check(reported == 1 && a.Calls.Count == 1 && a.Orders.Count == 1, "the new entry is reported at creation and sent: " + string.Join(" | ", a.Calls));
        Order e = a.Orders[0];
        string t = Tag(e);
        Check(!sent.Any(m => m.Contains("could not be resumed")) && !Error("CB#" + t), "no restart alarm for an entry being placed: " + string.Join(" | ", sent.Where(x => x.Contains("error"))));
        Check(!Managed().Any(m => m.Contains("\"state\":\"unmanaged\"")), "the page never sees it unmanaged: " + string.Join(" | ", Managed()));
        Check(Managed().Any(m => m.Contains("\"account\":\"SIM-U7\"") && m.Contains("\"state\":\"waiting\"")), "it waits for its fill, managed: " + string.Join(" | ", Managed()));
        Check(ChartBridgeOrders.PlacingCount == 0, "the Placing mark ends with the placement");
        Check(File.ReadAllLines(ManagedFile).Any(l => l.StartsWith(t + "\t")), "its managed.txt line is written");
        int n = a.Calls.Count;
        Fill(a, e, 1, 24990);
        SetPos(a, 1, 24990);
        List<string> legs = After(a, n);
        Check(legs.Count == 2 && legs[0].StartsWith("submit CB#" + t + " stop f1 q1 p24990 k1 Sell StopMarket 1 L0 S24988") && legs[1].StartsWith("submit CB#" + t + " target f1 q1 p24990 k1 Sell Limit 1 L24994"),
              "its fill gets the strategy's stop and target: " + string.Join(" | ", legs));
        Order stop = a.Orders.First(o => o.Name.Contains(" stop "));
        int k = a.Calls.Count;
        Tick(600); Trade(24992); Tick(600); Trade(24992.25);
        Check(a.Calls.Count == k + 1 && a.Calls.Last() == "change " + stop.Name + " L0 S24990 Q0", "and breakeven moves its stop (managed, not unmanaged): " + a.Calls.Last());
        Confirm(a, stop, 24990);
        foreach (Order o in a.Orders) if (o.OrderState != OrderState.Filled) o.OrderState = OrderState.Cancelled;
        SetPos(a, 0, 0);
        ChartBridgeOrders.CheckLegs(clock);

        // a refused placement (managed.txt cannot be written) also ends its mark, with no alarm
        ChartBridgeOrders.ManagedWriteFault = () => "the disk is full";
        sent.Clear();
        n = a.Calls.Count;
        try { Msg("order", Ord("SIM-U7", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"strategy\":{\"name\":\"Refused\",\"stop\":8}")); }
        finally { ChartBridgeOrders.ManagedWriteFault = null; }
        Check(Rejected("managed.txt could not be saved") && a.Calls.Count == n && ChartBridgeOrders.PlacingCount == 0 && !sent.Any(m => m.Contains("could not be resumed")),
              "a refused strategy entry: no alarm, nothing sent, the mark ended: " + Last());

        // a real restart: an entry left from before it, its line lost, is still recovered and still said (the mark is memory only)
        Msg("order", Ord("SIM-U7", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24985,\"strategy\":{\"name\":\"Orphan\",\"stop\":8}"));
        Order orphan = a.Orders.Last();
        a.OnCreate = null;
        File.Delete(ManagedFile);
        Restart();
        sent.Clear();
        ChartBridgeOrders.CheckLegs(clock);
        Check(Error("MNQ SIM-U7: Order Strategy entry CB#" + Tag(orphan) + " could not be resumed after the restart (managed.txt has no line for it)"),
              "after a real restart a genuinely orphaned strategy entry is still recovered and said: " + string.Join(" | ", sent.Where(x => x.Contains("error"))));
        orphan.OrderState = OrderState.Cancelled; Update(a, orphan);
        ChartBridgeOrders.CheckLegs(clock);
    }

    // ------------------------------------------------------------ review of PR #75 (1.41.0, ChartBridge 0.6.11)
    // Made-up accounts and prices. HIGH 1: a restart must never let a trade from an earlier session keep its bar trail (the session
    // it filled in is saved in managed.txt; without it, the safe side). HIGH 2: a feed down across the 18:00 open (also a drop while
    // the market is closed) must never make the first minute bar whole or range bars proven. LOW 3: a bar kind made for a placement
    // is held until the placement ends. LOW 4: never a stop move while the account's position is flat.
    const string Bar1 = "\"name\":\"R1m\",\"stop\":16,\"t1\":40,\"t1Share\":100,\"barTrail\":1,\"barTrailOffset\":0";
    static string LastManaged(Account a) { return Managed().LastOrDefault(m => m.Contains("\"account\":\"" + a.Name + "\"")) ?? ""; }
    static string LineOf(Order e) { return File.ReadAllLines(ManagedFile).FirstOrDefault(l => l.StartsWith(Tag(e) + "\t")) ?? ""; }
    static void Close(Account a)
    {
        SetPos(a, 0, 0);
        foreach (Order o in a.Orders) if (o.OrderState != OrderState.Filled && o.OrderState != OrderState.Cancelled) { o.OrderState = OrderState.Cancelled; Update(a, o); }
        ChartBridgeOrders.CheckLegs(clock);
    }

    static void TrailReview()
    {
        Config(false, true);
        NtClock();

        // HIGH 1, the reviewer's repro: an entry filled 10-29 15:00 with a bar trail, ChartBridge restarted, trades 10-30 from 10:00
        ChartBridgeOrders.BarTrailFeedDropped(null);
        Account a = NewAccount("SIM-R1");
        TradeAtD(29, 15, 0, 0, 25000);
        Msg("order", Ord(a.Name, "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"strategy\":{" + BarTrailS + "}"));
        Order e = a.Orders.Last(); Fill(a, e, 1, 25000); SetPos(a, 1, 25000);
        ChartBridgeOrders.SaveManagedNow();
        long s29 = ChartBridgeOrders.SessionDay(Et(29, 15, 0, 0));
        Check(LineOf(e).EndsWith("\tsession:" + s29), "HIGH 1: managed.txt saves the session the entry filled in (session:" + s29 + "): " + LineOf(e));
        Restart();
        Tick(1000); TradeAtD(30, 10, 0, 30, 25000);       // the session of 10-30 (after 18:00 on 10-29)
        ChartBridgeOrders.CheckLegs(clock);
        Check(Managed().Any(m => m.Contains("SIM-R1") && m.Contains("\"state\":\"resumed\"")), "HIGH 1: after the restart breakeven and the tick trail resume as before: " + LastManaged(a));
        Check(LastManaged(a).Contains("\"barTrail\":{\"state\":\"ended\""), "HIGH 1: its bar trail is recovered ended (filled in an earlier session): " + LastManaged(a));
        int n = a.Calls.Count;
        Tick(1000); TradeAtD(30, 10, 1, 10, 25001);
        Tick(1000); TradeAtD(30, 10, 2, 10, 25002);
        Tick(1000); TradeAtD(30, 10, 3, 10, 25003);
        Tick(1000); TradeAtD(30, 10, 4, 10, 25004);
        Check(a.Calls.Count == n, "HIGH 1 (repro R1): a bar trail entry from the 10-29 session never moves its stop in the 10-30 session after a restart: " + string.Join(" ; ", a.Calls.Skip(n).ToArray()));
        ChartBridgeOrders.SaveManagedNow();
        Check(LineOf(e).EndsWith("\tsession:" + s29 + "\tbarEnded"), "HIGH 1: managed.txt then says barEnded too: " + LineOf(e));
        Close(a);

        // HIGH 2, the reviewer's repro: the feed is down across the 18:00 open; it comes back at 18:20:30, part way into a minute
        Account b = NewAccount("SIM-R2");
        Tick(1000); TradeAtD(30, 16, 58, 0, 25010);
        StrategyLong(b, "\"name\":\"R1m\",\"stop\":16,\"t1\":40,\"t1Share\":100,\"barTrail\":1,\"barTrailOffset\":0", 25010);
        ChartBridgeOrders.BarTrailFeedDropped(null);
        Close(b);
        Account c = NewAccount("SIM-R3");
        Tick(1000); TradeAtD(30, 18, 20, 30, 25020);    // the first trade after the feed is back (18:00 to 18:20:30 missed)
        StrategyLong(c, Bar1, 25020);
        Order cstop = c.Orders[1];
        int nc = c.Calls.Count;
        Tick(1000); TradeAtD(30, 18, 20, 50, 25021);
        Tick(1000); TradeAtD(30, 18, 21, 5, 25022);     // closes the 18:20 to 18:21 bar, seen only from 18:20:30
        Check(c.Calls.Count == nc && ChartBridgeOrders.BarTrailBars("MNQ") == 0,
              "HIGH 2 (repro R2): the bar joined at 18:20:30 (feed back after the open) is partial and never moves the stop: bars " + ChartBridgeOrders.BarTrailBars("MNQ") + "; " + string.Join(" ; ", c.Calls.Skip(nc).ToArray()));
        Tick(1000); TradeAtD(30, 18, 21, 40, 25023);
        Tick(1000); TradeAtD(30, 18, 22, 5, 25024);     // closes the first whole bar (25022 .. 25023)
        Check(c.Calls.Count == nc + 1 && c.Calls.Last() == "change " + cstop.Name + " L0 S25022 Q0", "HIGH 2: the next whole bar trails as usual (25022): " + c.Calls.Last());
        Confirm(c, cstop, 25022);
        Close(c);

        // HIGH 1: a restart in the same session resumes the bar trail (its first bar after the start partial)
        Restart();
        Account r4 = NewAccount("SIM-R4");
        TradeAtN(11, 2, 10, 0, 0, 25100);
        Order e4 = StrategyLong(r4, Bar1, 25100);
        Order stop4 = r4.Orders[1];
        ChartBridgeOrders.SaveManagedNow();
        Check(LineOf(e4).EndsWith("\tsession:" + ChartBridgeOrders.SessionDay(EtN(11, 2, 10, 0, 0))), "HIGH 1: the session saved: " + LineOf(e4));
        Restart();
        Tick(1000); TradeAtN(11, 2, 10, 0, 30, 25101);
        ChartBridgeOrders.CheckLegs(clock);
        Check(LastManaged(r4).Contains("\"state\":\"resumed\"") && LastManaged(r4).Contains("\"barTrail\":{\"state\":\"building\""), "HIGH 1: a restart in the same session: resumed, the bar trail building again: " + LastManaged(r4));
        int n4 = r4.Calls.Count;
        Tick(1000); TradeAtN(11, 2, 10, 1, 10, 25102);  // closes the partial bar (after the start)
        Tick(1000); TradeAtN(11, 2, 10, 1, 40, 25102.5);
        Tick(1000); TradeAtN(11, 2, 10, 2, 10, 25103);  // closes 25102 .. 25102.5
        Check(r4.Calls.Count == n4 + 1 && r4.Calls.Last() == "change " + stop4.Name + " L0 S25102 Q0", "HIGH 1: a same-session restart still trails (25102): " + r4.Calls.Last());
        Confirm(r4, stop4, 25102);
        Close(r4);

        // HIGH 1: ChartBridge restarted before the close of the entry's session (17:30), the next session's first trade ends it
        Account r5 = NewAccount("SIM-R5");
        Tick(1000); TradeAtN(11, 2, 15, 0, 0, 25200);
        Order e5 = StrategyLong(r5, Bar1, 25200);
        ChartBridgeOrders.SaveManagedNow();
        At(EtN(11, 2, 17, 30, 0));
        Restart();
        ChartBridgeOrders.CheckLegs(clock);
        Check(LastManaged(r5).Contains("\"state\":\"resumed\"") && !LastManaged(r5).Contains("\"state\":\"ended\""), "HIGH 1: restarted at 17:30 in its own session: resumed, not ended yet: " + LastManaged(r5));
        int n5 = r5.Calls.Count;
        Tick(1000); TradeAtN(11, 2, 18, 0, 5, 25201);   // the first trade this run is the next session's
        Check(LastManaged(r5).Contains("\"barTrail\":{\"state\":\"ended\""), "HIGH 1: the first trade seen after the restart is a later session: the bar trail ended: " + LastManaged(r5));
        Tick(1000); TradeAtN(11, 2, 18, 1, 10, 25202);
        Tick(1000); TradeAtN(11, 2, 18, 1, 40, 25203);
        Tick(1000); TradeAtN(11, 2, 18, 2, 10, 25204);
        Tick(1000); TradeAtN(11, 2, 18, 3, 10, 25205);
        Check(r5.Calls.Count == n5, "HIGH 1: restarted before the close, its stop never moves in the next session: " + string.Join(" ; ", r5.Calls.Skip(n5).ToArray()));
        Check(LineOf(e5).Contains("\tbarEnded"), "HIGH 1: saved as barEnded at once: " + LineOf(e5));
        Close(r5);

        // HIGH 1: a line from before the session field (old managed.txt): a filled bar trail entry is recovered with its bar trail
        // ended, even in the same session (the safe side)
        Account r6 = NewAccount("SIM-R6");
        Tick(1000); TradeAtN(11, 3, 10, 0, 0, 25300);
        Order e6 = StrategyLong(r6, Bar1, 25300);
        ChartBridgeOrders.SaveManagedNow();
        File.WriteAllLines(ManagedFile, File.ReadAllLines(ManagedFile).Select(l => Regex.Replace(l, "\tsession:[0-9]+", "")).ToArray());
        Check(!LineOf(e6).Contains("session:"), "an old line: " + LineOf(e6));
        Restart();
        Tick(1000); TradeAtN(11, 3, 10, 0, 30, 25301);
        ChartBridgeOrders.CheckLegs(clock);
        Check(LastManaged(r6).Contains("\"state\":\"resumed\"") && LastManaged(r6).Contains("\"barTrail\":{\"state\":\"ended\""), "HIGH 1: an old line with no session: resumed, the bar trail ended: " + LastManaged(r6));
        int n6 = r6.Calls.Count;
        Tick(1000); TradeAtN(11, 3, 10, 1, 10, 25302);
        Tick(1000); TradeAtN(11, 3, 10, 2, 10, 25303);
        Tick(1000); TradeAtN(11, 3, 10, 3, 10, 25304);
        Check(r6.Calls.Count == n6, "HIGH 1: an old line with no session never moves the stop by the bar trail: " + string.Join(" ; ", r6.Calls.Skip(n6).ToArray()));
        Close(r6);

        // HIGH 2: ChartBridge started after 18:00: the first trade it sees is not the open; the first minute bar is partial, range
        // bars are not proven
        Restart();
        Account r7 = NewAccount("SIM-R7");
        Tick(1000); TradeAtN(11, 3, 18, 20, 30, 25400);
        StrategyLong(r7, Bar1, 25400);
        Account r8 = NewAccount("SIM-R8");
        Entry(r8, true, "\"name\":\"R4\",\"stop\":16,\"t1\":80,\"t1Share\":100,\"barTrail\":1,\"barTrailOffset\":0,\"barTrailType\":\"range\",\"barTrailSize\":4", 25400);
        int n7 = r7.Calls.Count;
        Tick(1000); TradeAtN(11, 3, 18, 20, 50, 25401);
        Tick(1000); TradeAtN(11, 3, 18, 21, 5, 25402);
        Check(r7.Calls.Count == n7 && ChartBridgeOrders.BarTrailBars("MNQ") == 0, "HIGH 2: started at 18:20: the first minute bar is partial, no move");
        Check(LastManaged(r8).Contains("\"barTrail\":{\"state\":\"notProven\""), "HIGH 2: started at 18:20: range bars not proven: " + LastManaged(r8));
        Close(r7); Close(r8);

        // HIGH 2: a feed drop while the market is closed (17:30, the break) is marked too: the open is not taken as seen
        Tick(1000); TradeAtN(11, 4, 16, 59, 0, 25500);
        At(EtN(11, 4, 17, 30, 0));
        typeof(ChartBridgeServer).GetMethod("FeedDropped", PS).Invoke(null, new object[] { null, "a test drop in the break" });
        typeof(ChartBridgeServer).GetField("feedDown", PS).SetValue(null, 0);
        Account r9 = NewAccount("SIM-R9");
        Tick(1000); TradeAtN(11, 4, 18, 0, 1, 25500);
        StrategyLong(r9, Bar1, 25500);
        Order stop9 = r9.Orders[1];
        int n9 = r9.Calls.Count;
        Tick(1000); TradeAtN(11, 4, 18, 0, 30, 25501);
        Tick(1000); TradeAtN(11, 4, 18, 1, 5, 25502);   // closes 18:00 to 18:01: whole only if the open was seen
        Check(r9.Calls.Count == n9 && ChartBridgeOrders.BarTrailBars("MNQ") == 0, "HIGH 2: a drop in the break: the first bar of the session is partial, no move: " + string.Join(" ; ", r9.Calls.Skip(n9).ToArray()));
        Tick(1000); TradeAtN(11, 4, 18, 1, 40, 25502.5);
        Tick(1000); TradeAtN(11, 4, 18, 2, 5, 25503);   // the first whole bar: 25502 .. 25502.5
        Check(r9.Calls.Count == n9 + 1 && r9.Calls.Last() == "change " + stop9.Name + " L0 S25502 Q0", "HIGH 2: then whole bars trail as usual (25502): " + r9.Calls.Last());
        Confirm(r9, stop9, 25502);
        Close(r9);

        // LOW 4: never a stop move while the position is flat (the tick trail and breakeven, and the bar trail)
        Account r10 = NewAccount("SIM-R10");
        Tick(1000); TradeAtN(11, 4, 18, 2, 20, 25600);
        StrategyLong(r10, BeTrail, 25600);
        Order stop10 = r10.Orders[1];
        SetPos(r10, 0, 0);                               // flat (closed outside ChartBridge), the stop still working
        int n10 = r10.Calls.Count;
        Tick(1000); TradeAtN(11, 4, 18, 2, 30, 25602);  // 8 ticks: breakeven due
        Tick(1000); TradeAtN(11, 4, 18, 2, 40, 25603);  // 12 ticks: the trail due
        Check(r10.Calls.Count == n10, "LOW 4: breakeven and the tick trail never move a stop while the position is flat: " + string.Join(" ; ", r10.Calls.Skip(n10).ToArray()));
        SetPos(r10, 1, 25600);
        Tick(1000); TradeAtN(11, 4, 18, 2, 50, 25603);
        Check(r10.Calls.Count == n10 + 1 && r10.Calls.Last().StartsWith("change " + stop10.Name + " L0 S"), "LOW 4: with the position open again it moves: " + r10.Calls.Last());
        Confirm(r10, stop10, double.Parse(Regex.Match(r10.Calls.Last(), " S([0-9.]+) ").Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture));
        Close(r10);
        Account r11 = NewAccount("SIM-R11");
        Tick(1000); TradeAtN(11, 4, 18, 3, 10, 25610);
        StrategyLong(r11, Bar1, 25610);
        Order stop11 = r11.Orders[1];
        SetPos(r11, 0, 0);
        int n11 = r11.Calls.Count;
        Tick(1000); TradeAtN(11, 4, 18, 3, 40, 25611);
        Tick(1000); TradeAtN(11, 4, 18, 4, 5, 25612);   // closes 25610 .. 25611: the level 25610
        Check(r11.Calls.Count == n11, "LOW 4: the bar trail never moves a stop while the position is flat: " + string.Join(" ; ", r11.Calls.Skip(n11).ToArray()));
        SetPos(r11, 1, 25610);
        Tick(1000); TradeAtN(11, 4, 18, 4, 20, 25612);
        Check(r11.Calls.Count == n11 + 1 && r11.Calls.Last() == "change " + stop11.Name + " L0 S25610 Q0", "LOW 4: open again: the bar level is sent (25610): " + r11.Calls.Last());
        Confirm(r11, stop11, 25610);
        Close(r11);

        // LOW 3: a bar kind made for a placement under way is held until the placement ends: with every other place held by
        // placements under way, a 17th kind is refused (never evicting a held one), and once they end it is taken
        MethodInfo place = typeof(ChartBridgeOrders).GetMethod("BarTrailPlaceProblem", PS), parse = typeof(ChartBridgeOrders).GetMethod("ParseStrategy", PS);
        Func<int, object> range = sz =>
        {
            object[] args = { "\"name\":\"K\",\"stop\":16,\"barTrail\":1,\"barTrailOffset\":0,\"barTrailType\":\"range\",\"barTrailSize\":" + sz, null };
            string bad = (string)parse.Invoke(null, args);
            if (bad != null || args[1] == null) throw new Exception("LOW 3: the strategy for range " + sz + " was refused: " + bad);
            return args[1];
        };
        int size = 41;
        for (int guard = 0; guard < 40 && ChartBridgeOrders.BarTrailKinds("MNQ") < ChartBridgeOrders.BarKindsMax; guard++) Check(place.Invoke(null, new object[] { "MNQ", range(size++), 0.25 }) == null, "LOW 3 setup: a kind made");
        Check(ChartBridgeOrders.BarTrailKinds("MNQ") == ChartBridgeOrders.BarKindsMax, "LOW 3 setup: 16 kinds on MNQ");
        ChartBridgeOrders.BarKindsPlaced();              // those placements ended (their entries never came): every kind but 1 minute is spare
        int first = size;
        for (int i = 0; i < ChartBridgeOrders.BarKindsMax - 1; i++) Check(place.Invoke(null, new object[] { "MNQ", range(size++), 0.25 }) == null, "LOW 3 setup: a new kind takes a spare place");
        string why17 = (string)place.Invoke(null, new object[] { "MNQ", range(size), 0.25 });
        Check(why17 != null && why17.Contains("cannot run"), "LOW 3: kinds held by placements under way are never given away: the next one is refused: " + why17);
        bool allHeld = true;
        for (int k = first; k < size; k++) allHeld &= (bool)typeof(ChartBridgeOrders).GetMethod("BarKindUsed", PS).Invoke(null, new object[] { "MNQ", "range", k });
        Check(allHeld, "LOW 3: every kind made for a placement under way counts as in use until it ends");
        ChartBridgeOrders.BarKindsPlaced();
        Check((string)place.Invoke(null, new object[] { "MNQ", range(size), 0.25 }) == null, "LOW 3: once the placements end, a new kind takes a spare place");
        ChartBridgeOrders.BarKindsPlaced();
    }

    // ------------------------------------------------------------ 1.42: the session an entry filled in, from its execution
    static DateTime NtAt(double et) { return new DateTime(1970, 1, 1).AddSeconds(et); }   // NinjaTrader's time (the harness sets New York)
    static Execution ListExec(Account a, Order e, double et, string id)
    {
        Execution x = new Execution { Order = e, OrderId = e.OrderId, Instrument = mnq, MarketPosition = MarketPosition.Long, Quantity = 1, Price = 25700, Time = NtAt(et), ExecutionId = id };
        lock (a.Executions) a.Executions.Add(x);
        return x;
    }
    static Order Placed(Account a, string strategy) { Msg("order", Ord(a.Name, "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"strategy\":{" + strategy + "}")); return a.Orders.Last(); }

    static void FillSessions()
    {
        Config(false, true);
        ChartBridgeOrders.ReadConfig("tradeAccounts", "SIM-W1, SIM-W2, SIM-W3, SIM-W4, SIM-W5");
        NtClock();
        // the 11-05 session's last trades, the feed up (a drop marked before is cleared by a trade of the same session 10 s later)
        Tick(1000); TradeAtN(11, 5, 16, 58, 0, 25700);
        Tick(1000); TradeAtN(11, 5, 16, 59, 0, 25700);
        long before = ChartBridgeOrders.SessionDay(EtN(11, 5, 16, 59, 0)), next = ChartBridgeOrders.SessionDay(EtN(11, 5, 18, 0, 0.2));
        At(EtN(11, 5, 18, 0, 0.25));   // the PC clock in the new session; no trade of it seen yet (the latest trade's session is 11-05's)

        // a. a fill at 18:00:00.2 whose execution NinjaTrader lists before the session's first trade: the new session, its trail kept
        Account w1 = NewAccount("SIM-W1");
        Order e1 = Placed(w1, Bar1);
        ListExec(w1, e1, EtN(11, 5, 18, 0, 0.2), "XW1");
        Fill(w1, e1, 1, 25700); SetPos(w1, 1, 25700);
        Order stop1 = w1.Orders[1];
        // a. a fill at 17:59:59 (the session before): its trail still ends at the open
        Account w2 = NewAccount("SIM-W2");
        Order e2 = Placed(w2, Bar1);
        ListExec(w2, e2, EtN(11, 5, 17, 59, 59), "XW2");
        Fill(w2, e2, 1, 25700); SetPos(w2, 1, 25700);
        // a. a fill at 18:00:00.3 reported before NinjaTrader lists its execution (the clock's and the latest trade's: the session
        // before), then its execution comes (ChartBridge's ExecutionUpdate handler) before the first trade: the new session
        Account w3 = NewAccount("SIM-W3");
        Order e3 = Placed(w3, Bar1);
        Fill(w3, e3, 1, 25700); SetPos(w3, 1, 25700);
        Order stop3 = w3.Orders[1];
        Execution x3 = ListExec(w3, e3, EtN(11, 5, 18, 0, 0.3), "XW3");
        typeof(ChartBridgeServer).GetMethod("OnExecutionUpdate", PS).Invoke(null, new object[] { w3, new ExecutionEventArgs { Execution = x3, ExecutionId = x3.ExecutionId, OrderId = x3.OrderId, Time = x3.Time, Price = x3.Price, Quantity = 1, MarketPosition = MarketPosition.Long } });
        ChartBridgeOrders.SaveManagedNow();
        Check(LineOf(e1).EndsWith("\tsession:" + next) && LineOf(e3).EndsWith("\tsession:" + next) && LineOf(e2).EndsWith("\tsession:" + before),
              "1.42: the session saved is the execution's own (18:00:00.2 and 18:00:00.3: " + next + "; 17:59:59: " + before + "): " + LineOf(e1) + " | " + LineOf(e3) + " | " + LineOf(e2));
        int n1 = w1.Calls.Count, n2 = w2.Calls.Count, n3 = w3.Calls.Count;
        Tick(1000); TradeAtN(11, 5, 18, 0, 0.5, 25700);   // the session's first trade (the open seen)
        Check(!LastManaged(w1).Contains("\"state\":\"ended\"") && !LastManaged(w3).Contains("\"state\":\"ended\""),
              "1.42: an entry filled at 18:00:00.2 (or 18:00:00.3, its execution after its fill) before the session's first trade keeps its bar trail: " + LastManaged(w1) + " | " + LastManaged(w3));
        Check(LastManaged(w2).Contains("\"barTrail\":{\"state\":\"ended\""), "1.42: an entry filled at 17:59:59 still ends at the open: " + LastManaged(w2));
        Tick(1000); TradeAtN(11, 5, 18, 0, 30, 25701);
        Tick(1000); TradeAtN(11, 5, 18, 1, 5, 25702);     // closes 18:00 to 18:01 (whole: the open was seen), low 25700
        Check(w1.Calls.Count == n1 + 1 && w1.Calls.Last() == "change " + stop1.Name + " L0 S25700 Q0", "1.42: the 18:00:00.2 entry trails on the session's first bar (25700): " + string.Join(" ; ", w1.Calls.Skip(n1).ToArray()));
        Check(w3.Calls.Count == n3 + 1 && w3.Calls.Last() == "change " + stop3.Name + " L0 S25700 Q0", "1.42: so does the one whose execution came after its fill: " + string.Join(" ; ", w3.Calls.Skip(n3).ToArray()));
        Check(w2.Calls.Count == n2, "1.42: the 17:59:59 entry's stop never moves in the new session: " + string.Join(" ; ", w2.Calls.Skip(n2).ToArray()));
        Confirm(w1, stop1, 25700); Confirm(w3, stop3, 25700);
        // a. an execution of the session before (17:59:59.5) whose fill is handled after the new session's first trade: ended at once
        Account w4 = NewAccount("SIM-W4");
        Order e4 = Placed(w4, Bar1);
        ListExec(w4, e4, EtN(11, 5, 17, 59, 59.5), "XW4");
        Fill(w4, e4, 1, 25702); SetPos(w4, 1, 25702);
        Check(LastManaged(w4).Contains("\"barTrail\":{\"state\":\"ended\""), "1.42: filled in the session before, handled after the open: its bar trail ended at once: " + LastManaged(w4));

        // b. the session field only for a bar trail: an entry without one has none (a rollback to 0.6.10 reads its line as before)
        Account w5 = NewAccount("SIM-W5");
        Order e5 = Placed(w5, BeTrail);
        ListExec(w5, e5, EtN(11, 5, 18, 1, 10), "XW5");
        Fill(w5, e5, 1, 25702); SetPos(w5, 1, 25702);
        ChartBridgeOrders.SaveManagedNow();
        Check(!LineOf(e5).Contains("session:") && !LineOf(e5).Contains("barEnded") && LineOf(e5).Length > 0, "1.42: an entry with no bar trail: no session field in managed.txt: " + LineOf(e5));
        Check(LineOf(e1).EndsWith("\tsession:" + next) && LineOf(e4).EndsWith("\tsession:" + before + "\tbarEnded"), "1.42: a bar trail entry keeps its session field (and barEnded): " + LineOf(e1) + " | " + LineOf(e4));
        // a line written by 0.6.11 for an entry with no bar trail carries a session: rewritten without it (read but not recovered yet)
        File.WriteAllLines(ManagedFile, File.ReadAllLines(ManagedFile).Select(l => l.StartsWith(Tag(e5) + "\t") ? l + "\tsession:" + next : l).ToArray());
        Restart();
        ChartBridgeOrders.SaveManagedNow();
        Check(!LineOf(e5).Contains("session:") && LineOf(e1).EndsWith("\tsession:" + next), "1.42: after a restart, a line without a bar trail loses a session field 0.6.11 wrote; a bar trail line keeps it: " + LineOf(e5) + " | " + LineOf(e1));
        Tick(1000); TradeAtN(11, 5, 18, 1, 40, 25703);
        ChartBridgeOrders.CheckLegs(clock);
        Check(LastManaged(w5).Contains("\"state\":\"resumed\"") && !LastManaged(w5).Contains("\"barTrail\":{"), "1.42: the entry with no bar trail resumes after the restart with no session field: " + LastManaged(w5));
        Check(LastManaged(w1).Contains("\"state\":\"resumed\"") && !LastManaged(w1).Contains("\"state\":\"ended\""), "1.42: the bar trail entry with its session saved resumes, its bar trail not ended: " + LastManaged(w1));
        Check(LastManaged(w4).Contains("\"barTrail\":{\"state\":\"ended\""), "1.42: the ended one stays ended: " + LastManaged(w4));
        // (a bar trail entry whose line has no session is recovered ended: TrailReview's "an old line with no session", SIM-R6)
        Close(w1); Close(w2); Close(w3); Close(w4); Close(w5);
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
