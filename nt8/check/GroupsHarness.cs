// ChartBridge 0.5.8 prop groups and real account state on Mono (inside check:orders): groups.txt and account-marks.txt, the
// migration (no file: 0.5.7 exactly), an unreadable file, groupSave, groupDelete, accountGroup (highClose), accountLimits,
// the one-direction check (positions by either reading, working entries, ChartBridge's own just sent, legs and exits that are
// no entries, the exit of an account's own position, a mixed group, No hedging off, every market), two entries on opposite
// sides at once, and the numbers (floor, room, daily room, target left) for eod, intraday, static and personal, with the highs
// and the day start. Made-up accounts (SIM-A to SIM-D) and made-up money; nothing here is real.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript.AddOns;

public static class GroupsHarness
{
    static Action<bool, string> Check;
    const BindingFlags PS = BindingFlags.NonPublic | BindingFlags.Static;
    static readonly List<string> sent = new List<string>();
    static ChartBridgeClient page;
    static Instrument mnq, nq;
    static Account simA, simB, simC, simD;
    static string folder, token;

    static System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient> Clients() { return (System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", PS).GetValue(null); }
    static Dictionary<string, Instrument> Named() { return (Dictionary<string, Instrument>)typeof(ChartBridgeServer).GetField("Instruments", PS).GetValue(null); }
    static string Last(string type) { lock (sent) return sent.LastOrDefault(m => m.StartsWith("{\"type\":\"" + type + "\"")) ?? ""; }
    static bool Any(string has) { lock (sent) return sent.Any(m => m.Contains(has)); }
    static string Rejection() { lock (sent) return sent.LastOrDefault(m => m.StartsWith("{\"type\":\"reject\"")) ?? ""; }
    static void Clear() { lock (sent) sent.Clear(); }
    static void G(string type, string json) { lock (page.Actions) page.Actions.Clear(); ChartBridgeGroups.OnMessage(page, type, json); }
    static void O(string json) { lock (page.Actions) page.Actions.Clear(); ChartBridgeOrders.OnMessage(page, "order", json); }
    static string Order(string account, string root, string rest) { return "{\"type\":\"order\",\"cid\":\"g\",\"account\":\"" + account + "\",\"root\":\"" + root + "\"," + rest + "}"; }
    static string Save(string extra, string name, string noHedge, string dl, string dd, string type, string tg, string size, string lockAt)
    {
        return "{\"type\":\"groupSave\",\"cid\":\"s\"" + extra + ",\"name\":\"" + name + "\",\"noHedge\":" + noHedge + ",\"dailyLoss\":" + dl + ",\"drawdown\":" + dd + ",\"drawdownType\":\"" + type +
               "\",\"target\":" + tg + ",\"size\":" + size + ",\"lockAt\":" + lockAt + "}";
    }
    static string Join(string account, string group, string high) { return "{\"type\":\"accountGroup\",\"cid\":\"j\",\"account\":\"" + account + "\",\"group\":" + group + (high != null ? ",\"highClose\":" + high : "") + "}"; }
    static string FileText() { string p = Path.Combine(folder, "groups.txt"); return File.Exists(p) ? File.ReadAllText(p) : ""; }
    static string MarksText() { string p = Path.Combine(folder, "account-marks.txt"); return File.Exists(p) ? File.ReadAllText(p) : ""; }
    static int Submits(Account a) { return a.Calls.Count(c => c.StartsWith("submit ")); }
    static string Entry(string accountsJson, string name) { Match m = Regex.Match(accountsJson, "\\{\"name\":\"" + Regex.Escape(name) + "\".*?\"why\":\\{[^}]*\\}"); return m.Success ? m.Value : ""; }
    static string AccountsNow() { return ChartBridgeAccounts.AccountsJson(Account.All.ToList(), ChartBridgeTime.NowUtcMs()); }

    static Account NewAccount(string name)
    {
        Account a = new Account { Name = name, Connection = new Connection { Status = ConnectionStatus.Connected }, Provider = Provider.Simulator };
        Account.All.Add(a);
        ((Dictionary<Account, double>)typeof(ChartBridgeOrders).GetField("ConnectedSince", PS).GetValue(null))[a] = 0;
        ChartBridgeAccounts.SeenConnected(a);
        return a;
    }
    static void Pos(Account a, Instrument inst, int signed)
    {
        a.Positions.RemoveAll(p => p.Instrument == inst);
        if (signed != 0) a.Positions.Add(new Position { Instrument = inst, MarketPosition = signed > 0 ? MarketPosition.Long : MarketPosition.Short, Quantity = Math.Abs(signed), AveragePrice = 25000 });
    }
    static Order Manual(Account a, Instrument inst, OrderAction act, OrderType type, int qty, string oco, string name)
    {
        Order o = new Order { Account = a, Instrument = inst, OrderAction = act, OrderType = type, Quantity = qty, LimitPrice = 24990, StopPrice = 24980, Oco = oco, Name = name, OrderState = OrderState.Working };
        a.Orders.Add(o);
        return o;
    }
    static void Flat()
    {
        foreach (Account a in new[] { simA, simB, simC, simD })
        {
            foreach (Order o in a.Orders) if (o.OrderState != OrderState.Filled) o.OrderState = OrderState.Cancelled;
            a.Positions.Clear();
        }
        ((System.Collections.IDictionary)typeof(ChartBridgeOrders).GetField("Moves", PS).GetValue(null)).Clear();
        ((HashSet<Order>)typeof(ChartBridgeOrders).GetField("Ours", PS).GetValue(null)).Clear();
    }
    static void Money(Account a, double bal, double un, double real)
    {
        a.Items[AccountItem.CashValue] = bal; a.Items[AccountItem.UnrealizedProfitLoss] = un; a.Items[AccountItem.RealizedProfitLoss] = real;
    }
    static void Tick() { List<Account> all = Account.All.ToList(); foreach (Account a in all) ChartBridgeAccounts.SeenConnected(a); ChartBridgeGroups.Tick(all, ChartBridgeTime.NowUtcMs()); }
    static void ClockEt(int y, int mo, int d, int h, int mi)
    {
        DateTime et = new DateTime(y, mo, d, h, mi, 0, DateTimeKind.Unspecified);
        DateTime utc = TimeZoneInfo.ConvertTimeToUtc(et, ChartBridgeTime.Eastern);
        ChartBridgeGroups.ClockUtc = () => utc;
        ChartBridgeBranches.ClockUtc = () => utc;
    }
    static string State(string account) { string key; return ChartBridgeGroups.AccountStateJson(account, out key); }

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        string dirWas = NinjaTrader.Core.Globals.UserDataDir;
        List<Account> allWas = Account.All.ToList();
        Dictionary<string, Instrument> namedWas = new Dictionary<string, Instrument>(Named());
        Dictionary<int, ChartBridgeClient> clientsWas = Clients().ToDictionary(kv => kv.Key, kv => kv.Value);
        try
        {
            Setup();
            Migration();
            Saving();
            Joining();
            OneDirection();
            Exits();
            Entries();
            Mixed();
            NoHedgeOff();
            Race();
            Limits();
            Numbers();
            Highs();
            AgentState();
            Deleting();
            Unreadable();
            ReviewFixes();   // the order-path review of #48, items 1 to 6
        }
        catch (Exception ex) { Check(false, "groups harness threw: " + ex); }
        finally
        {
            try { ChartBridgeAgents.Stop(); ChartBridgeAgents.ResetConfig(); } catch (Exception) { }
            ChartBridgeGroups.ClockUtc = null; ChartBridgeBranches.ClockUtc = null; ChartBridgeAccounts.ReadFault = null; ChartBridgeGroups.MarksWriteMs = 5000;
            OrdersHarness.AllOffLines();
            ChartBridgeAccounts.Clear();
            ChartBridgeOrders.ResetConfig();
            Flat();
            Account.All.Clear(); Account.All.AddRange(allWas);
            Named().Clear(); foreach (KeyValuePair<string, Instrument> kv in namedWas) Named()[kv.Key] = kv.Value;
            Clients().Clear(); foreach (KeyValuePair<int, ChartBridgeClient> kv in clientsWas) Clients()[kv.Key] = kv.Value;
            NinjaTrader.Core.Globals.UserDataDir = dirWas;
        }
    }

    static void Setup()
    {
        string home = Path.Combine(Path.GetTempPath(), "cb-groups-" + Guid.NewGuid().ToString("N"));
        folder = Path.Combine(home, "ChartBridge");
        Directory.CreateDirectory(folder);
        NinjaTrader.Core.Globals.UserDataDir = home;
        FieldInfo etf = typeof(ChartBridgeTime).GetField("et", PS);   // Linux names New York's zone differently from Windows (as PinHarness)
        if (etf.GetValue(null) == null) etf.SetValue(null, TimeZoneInfo.FindSystemTimeZoneById("America/New_York"));
        ChartBridgeGroups.MarksWriteMs = 0;   // every change written at once here
        OrdersHarness.AllOffLines();   // accountChecks off: tradeAccounts is gate 2 (the check is the same either way)
        Account.All.Clear();
        ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
        ClockEt(2026, 10, 14, 10, 0);
        simA = NewAccount("SIM-A"); simB = NewAccount("SIM-B"); simC = NewAccount("SIM-C"); simD = NewAccount("SIM-D");
        mnq = new Instrument { FullName = "MNQ 12-26", MasterInstrument = new MasterInstrument { Name = "MNQ", TickSize = 0.25, PointValue = 2 } };
        nq = new Instrument { FullName = "NQ 12-26", MasterInstrument = new MasterInstrument { Name = "NQ", TickSize = 0.25, PointValue = 20 } };
        Named().Clear(); Named()["MNQ"] = mnq; Named()["NQ"] = nq;
        ChartBridgeOrders.ResetConfig();
        ChartBridgeOrders.ReadConfig("trading", "true");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "SIM-A, SIM-B, SIM-C, SIM-D");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "9");
        ChartBridgeOrders.ReadConfig("maxQty.NQ", "9");
        ChartBridgeOrders.NoteLast("MNQ", 25000); ChartBridgeOrders.NoteLast("NQ", 25000);
        ChartBridgeOrders.NewToken();
        token = ChartBridgeOrders.SessionJson().Split('"')[3];
        Clients().Clear();
        page = new ChartBridgeClient(null, 61); page.Origin = "http://localhost:8765"; page.Tap = s => { lock (sent) sent.Add(s); };
        Clients()[61] = page;
        ChartBridgeOrders.OnMessage(page, "auth", "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
        ChartBridgeAccounts.OnMessage(page, "client", "{\"type\":\"client\",\"v\":3}");
        Check(page.Trader && ChartBridgeV3.IsV3(page), "groups: a signed-in v3 page");
    }

    // ------------------------------------------------------------ no groups.txt: no groups, every account personal, 0.5.7 exactly
    static void Migration()
    {
        Check(!File.Exists(Path.Combine(folder, "groups.txt")) && Last("groups") == "{\"type\":\"groups\",\"list\":[],\"error\":null}", "no groups.txt: the page gets an empty list and no error (" + Last("groups") + ")");
        Check(ChartBridgeGroups.EntryCheck("page", simA, "MNQ", false, 1, false, false) == null, "no groups: nothing is checked");
        Pos(simA, mnq, 2);
        int b = Submits(simB);
        O(Order("SIM-B", "MNQ", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":1"));
        Check(Submits(simB) == b + 1, "no groups: a sell on one account while another is long goes, as in 0.5.7");
        string e = Entry(AccountsNow(), "SIM-A");
        Check(e.Contains("\"group\":null,\"myFloor\":null,\"myDailyLoss\":null,\"floor\":null") && e.Contains("\"why\":{\"floor\":\"no group and no floor of its own (the Accounts tab)\""), "accounts: group null, personal, no floor, with why: " + e);
        Check(!File.Exists(Path.Combine(folder, "groups.txt")), "nothing is written while nothing changes");
        Flat();
    }

    // ------------------------------------------------------------ groupSave: every refusal, then two groups
    static void Saving()
    {
        string[][] bad = {
            new[] { Save("", "", "true", "1000", "2000", "eod", "3000", "50000", "0"), "1 to 30 characters" },
            new[] { Save("", "A123456789012345678901234567890", "true", "1000", "2000", "eod", "3000", "50000", "0"), "1 to 30 characters" },
            new[] { Save("", " Lucid", "true", "1000", "2000", "eod", "3000", "50000", "0"), "no space at either end" },
            new[] { Save("", "Lucid", "1", "1000", "2000", "eod", "3000", "50000", "0"), "noHedge must be true or false" },
            new[] { Save("", "Lucid", "true", "1000", "2000", "daily", "3000", "50000", "0"), "drawdownType must be eod, intraday or static" },
            new[] { Save("", "Lucid", "true", "1000", "0", "eod", "3000", "50000", "0"), "drawdown must be more than 0" },
            new[] { Save("", "Lucid", "true", "1000", "50000", "eod", "3000", "50000", "0"), "less than the account size" },
            new[] { Save("", "Lucid", "true", "1000.555", "2000", "eod", "3000", "50000", "0"), "at most 2 decimals" },
            new[] { Save("", "Lucid", "true", "-5", "2000", "eod", "3000", "50000", "0"), "at most 2 decimals" },
            new[] { Save("", "Lucid", "true", "1000", "2000", "static", "3000", "50000", "50100"), "trailing drawdown only" },
            new[] { Save("", "Lucid", "true", "1000", "2000", "eod", "3000", "50000", "48000"), "above the starting floor (48000)" },
            new[] { Save(",\"group\":\"g9\"", "Lucid", "true", "1000", "2000", "eod", "3000", "50000", "0"), "no group g9" },
            new[] { "{\"type\":\"groupSave\",\"cid\":\"s\",\"name\":\"Lucid\",\"noHedge\":true,\"drawdown\":2000,\"drawdownType\":\"eod\",\"target\":0,\"size\":50000,\"lockAt\":0}", "dailyLoss is needed" },
            new[] { Save(",\"color\":\"red\"", "Lucid", "true", "1000", "2000", "eod", "3000", "50000", "0"), "unknown key \\\"color\\\"" },
        };
        foreach (string[] x in bad)
        {
            Clear(); G("groupSave", x[0]);
            Check(Rejection().Contains(x[1]) && (x[1].StartsWith("unknown key") || Rejection().Contains("\"cid\":\"s\"")) && !File.Exists(Path.Combine(folder, "groups.txt")), "groupSave refused: " + x[1] + " (" + Rejection() + ")");
        }
        Clear(); G("groupSave", Save("", "Lucid", "true", "1000", "2000", "eod", "3000", "50000", "50100"));
        Check(Rejection() == "" && Last("groups").Contains("{\"id\":\"g1\",\"name\":\"Lucid\",\"noHedge\":true,\"dailyLoss\":1000,\"drawdown\":2000,\"drawdownType\":\"eod\",\"target\":3000,\"size\":50000,\"lockAt\":50100,\"members\":[],\"side\":null,\"holders\":[]}"),
              "groupSave: g1 made, the page told at once: " + Last("groups"));
        string[] lines = FileText().Split('\n');
        Check(lines[0] == ChartBridgeGroups.Header && lines[1].StartsWith("# ") && lines[2] == "group\tg1\tLucid\ton\t1000\t2000\teod\t3000\t50000\t50100", "groups.txt: two # lines, then the group line: " + FileText().Replace("\t", "<TAB>"));
        Clear(); G("groupSave", Save("", "LUCID", "true", "0", "2500", "intraday", "0", "50000", "0"));
        Check(Rejection().Contains("a group named LUCID is there already"), "a name twice (any case): refused");
        Clear(); G("groupSave", Save("", "Apex", "true", "0", "2500", "static", "0", "50000", "0"));
        Check(Rejection() == "" && FileText().Contains("group\tg2\tApex\ton\t-\t2500\tstatic\t-\t50000\t-"), "g2 made, none written as -: " + FileText().Replace("\t", "<TAB>"));
        Check(Logged("groups: group g2 made: Apex"), "the Output window says what changed");
    }

    static bool Logged(string has) { lock (NinjaTrader.Code.Output.Lines) return NinjaTrader.Code.Output.Lines.Any(x => x.Contains(has)); }

    // ------------------------------------------------------------ accountGroup and the highest close (G2 b)
    static void Joining()
    {
        Money(simA, 50800, 0, 0); Money(simB, 49500, 0, 0); Money(simC, 50200, 0, 0);
        Clear(); G("accountGroup", Join("SIM-A", "\"g1\"", "51000"));
        Check(Rejection() == "" && ChartBridgeGroups.GroupOf("SIM-A") == "g1" && FileText().Contains("member\tSIM-A\tg1"), "SIM-A joins Lucid (g1)");
        Check(MarksText().Contains("mark\tSIM-A\t51000\t51000\t"), "its highs start at the highest close given: " + MarksText().Replace("\t", "<TAB>"));
        Check(Entry(Last("accounts"), "SIM-A").Contains("\"group\":\"g1\""), "the accounts message at once: SIM-A in g1");
        Clear(); G("accountGroup", Join("SIM-B", "\"g1\"", null));
        Check(MarksText().Contains("mark\tSIM-B\t50000\t50000\t"), "SIM-B joins without a highest close: the larger of the size (50000) and its balance (49500)");
        Clear(); G("accountGroup", Join("SIM-C", "\"g1\"", null));
        Check(MarksText().Contains("mark\tSIM-C\t50200\t50200\t"), "SIM-C: its balance (50200) is larger than the size");
        Clear(); G("accountGroup", Join("SIM-C", "\"g1\"", "52000"));
        Check(Rejection().Contains("SIM-C is in Lucid already"), "joining the group it is in: refused");
        Clear(); G("accountGroup", Join("SIM-D", "null", "52000"));
        Check(Rejection().Contains("highClose goes with joining a group only"), "highClose with None: refused");
        Clear(); G("accountGroup", Join("SIM-D", "\"g7\"", null));
        Check(Rejection().Contains("no group g7"), "an unknown group: refused");
        Clear(); G("accountGroup", Join("NOBODY", "\"g1\"", null));
        Check(Rejection().Contains("no account NOBODY"), "an unknown account: refused");
        Clear(); G("accountGroup", Join("Playback101", "\"g1\"", null));
        Check(Rejection().Contains("Backtest and Playback"), "Playback: never in a group");
        Clear(); G("groupSave", Save(",\"group\":\"g1\"", "Lucid Flex", "true", "1000", "2000", "eod", "3000", "50000", "50100"));
        Check(Rejection() == "" && FileText().Contains("group\tg1\tLucid Flex\t") && FileText().Contains("member\tSIM-A\tg1") && FileText().Contains("member\tSIM-C\tg1"), "rename: the id stays, every member stays");
    }

    // ------------------------------------------------------------ one direction for the whole group, every market (G3 a)
    static void OneDirection()
    {
        Flat();
        Pos(simA, mnq, 2);   // Lucid Flex is long
        int c = Submits(simC);
        Clear(); O(Order("SIM-C", "MNQ", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":1"));
        string r = Rejection();
        Check(Submits(simC) == c && r.Contains("Group Lucid Flex is long (SIM-A +2 MNQ): a sell on SIM-C would hedge the group; prop firms ban hedged accounts. Exits and flattens still work."), "the ticket's sell on another member while the group is long: refused, naming the group and the holder: " + r);
        Clear(); O(Order("SIM-B", "NQ", "\"side\":\"sell\",\"kind\":\"limit\",\"qty\":1,\"price\":25010"));
        Check(Rejection().Contains("is long (SIM-A +2 MNQ): a sell on SIM-B"), "every market: a sell on NQ is refused too");
        int b = Submits(simB);
        Clear(); O(Order("SIM-B", "NQ", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":16}"));
        Check(Submits(simB) == b + 1 && Rejection() == "", "the same side passes (a buy on NQ)");
        int d = Submits(simD);
        Clear(); O(Order("SIM-D", "MNQ", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":1"));
        Check(Submits(simD) == d + 1, "an account in no group is never checked");
        Clear(); O(Order("SIM-C", "MNQ", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejection().Contains("SIM-A +2 MNQ; SIM-B buy limit 1 NQ working"), "the refusal names the working entry too: " + Rejection());
        // fills not yet in the position count (either reading)
        Flat();
        ((Dictionary<string, List<double[]>>)typeof(ChartBridgeOrders).GetField("Moves", PS).GetValue(null))["SIM-B|MNQ 12-26"] = new List<double[]> { new double[] { -1, ChartBridgeTime.NowUtcMs() } };
        Check((ChartBridgeGroups.EntryCheck("page", simA, "MNQ", true, 1, true, false) ?? "").Contains("is short (SIM-B -1 MNQ)"), "a fill not yet in the position counts (the other reading)");
        Flat();
        // ChartBridge's own just sent, before NinjaTrader lists it
        Order o = new Order { Account = simB, Instrument = mnq, OrderAction = OrderAction.SellShort, OrderType = OrderType.Limit, Quantity = 2, LimitPrice = 25010, Name = "CB#0badf00d atm s8 t16", OrderState = OrderState.Initialized };
        ((HashSet<Order>)typeof(ChartBridgeOrders).GetField("Ours", PS).GetValue(null)).Add(o);
        Check((ChartBridgeGroups.EntryCheck("page", simA, "MNQ", true, 1, true, false) ?? "").Contains("SIM-B sell limit 2 MNQ working"), "an entry just sent (Ours, not listed yet) counts");
        Flat();
        Check(ChartBridgeGroups.EntryCheck("page", simA, "MNQ", false, 1, true, false) == null, "flat group: both sides are free");
    }

    // ------------------------------------------------------------ exits never blocked
    static void Exits()
    {
        Flat();
        Pos(simA, mnq, 2);
        int a = Submits(simA);
        Clear(); O(Order("SIM-A", "MNQ", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":1"));
        Check(Submits(simA) == a + 1 && Rejection() == "", "the long account's own sell of 1 of 2: an exit, it goes");
        Order working = simA.Orders.Last();
        working.OrderState = OrderState.Working;   // still working (no fill yet)
        Clear(); O(Order("SIM-A", "MNQ", "\"side\":\"sell\",\"kind\":\"limit\",\"qty\":1,\"price\":25010"));
        Check(Submits(simA) == a + 2 && Rejection() == "", "a resting exit for the rest (1 working, 1 more = the position): it goes");
        Clear(); O(Order("SIM-A", "MNQ", "\"side\":\"sell\",\"kind\":\"limit\",\"qty\":1,\"price\":25010"));
        Check(Submits(simA) == a + 2 && Rejection().Contains("is long"), "a third sell would flip the account short past the exits working: refused");
        Flat();
        Pos(simA, mnq, 2);
        Clear(); O(Order("SIM-A", "MNQ", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":3"));
        Check(Rejection().Contains("is long (SIM-A +2 MNQ): a sell on SIM-A"), "selling 3 of a long 2 (a flip): refused");
        Check((ChartBridgeGroups.EntryCheck("page", simA, "MNQ", false, 1, true, false) ?? "").Contains("is long"), "a sell asking for a stop and a target is an entry, not an exit");
        Check(ChartBridgeGroups.EntryCheck("page", simA, "MNQ", false, 2, false, false) == null, "the whole position: an exit");
        // Flatten, cancel and a stop's move never pass the check
        Clear(); ChartBridgeOrders.OnMessage(page, "flatten", "{\"type\":\"flatten\",\"cid\":\"f\",\"account\":\"SIM-A\",\"root\":\"MNQ\"}");
        Check(simA.Calls.Any(x => x.StartsWith("flatten MNQ")) && Rejection() == "", "Flatten on the group's account: it goes");
        Flat();
    }

    // ------------------------------------------------------------ working orders that are no entries
    static void Entries()
    {
        Flat();
        Pos(simA, mnq, 2);
        Manual(simA, mnq, OrderAction.Sell, OrderType.StopMarket, 2, "oco1", "CB#1a2b3c4d stop f1 q2 p24980");
        Manual(simA, mnq, OrderAction.Sell, OrderType.Limit, 2, "oco1", "CB#1a2b3c4d target f1 q2 p25040");
        Manual(simA, mnq, OrderAction.Sell, OrderType.Limit, 1, "", "Close");   // NinjaTrader's own exit, at most the position
        string g = ChartBridgeGroups.GroupsJson();
        Check(g.Contains("\"side\":\"long\",\"holders\":[{\"account\":\"SIM-A\",\"root\":\"MNQ\",\"side\":\"long\",\"what\":\"position\",\"qty\":2}]"), "legs, OCO parts and an exit of the position are no entries: only the long counts: " + g);
        Manual(simB, nq, OrderAction.Sell, OrderType.Limit, 1, "", "CB#22222222 ag:manrae flat");
        Manual(simB, nq, OrderAction.Sell, OrderType.StopMarket, 1, "", "CB#22222222 mstop q1 p24900");
        Check(!ChartBridgeGroups.GroupsJson().Contains("\"account\":\"SIM-B\""), "an agent's flat close and a merged stop are no entries either");
        Manual(simB, nq, OrderAction.Sell, OrderType.Limit, 1, "", "typed in NinjaTrader");
        Check(ChartBridgeGroups.GroupsJson().Contains("\"side\":\"mixed\""), "a plain sell limit with no position is an entry: the group is mixed");
        Flat();
    }

    // ------------------------------------------------------------ a mixed group (orders typed into NinjaTrader cannot be refused)
    static void Mixed()
    {
        Flat();
        Tick();
        Pos(simA, mnq, 1); Pos(simB, nq, -1);
        Clear(); Tick();
        Check(Any("\"level\":\"error\"") && Any("Group Lucid Flex is now long and short (SIM-A +1 MNQ; SIM-B -1 NQ): no new entries on either side"), "turning mixed: one status error to the pages");
        Check(Last("groups").Contains("\"side\":\"mixed\""), "the groups message says mixed");
        Clear(); Tick();
        Check(!Any("is now long and short"), "said once, not every second");
        Check((ChartBridgeGroups.EntryCheck("page", simC, "MNQ", true, 1, true, false) ?? "").Contains("is long and short") && (ChartBridgeGroups.EntryCheck("page", simC, "MNQ", false, 1, true, false) ?? "").Contains("no new entry on either side"), "mixed: both sides refused");
        Check(ChartBridgeGroups.EntryCheck("page", simB, "NQ", true, 1, false, false) == null, "mixed: an exit still goes");
        Pos(simB, nq, 0);
        Clear(); Tick();
        Check(Any("Group Lucid Flex is one direction again (long)"), "one direction again: one info");
        Flat();
    }

    // ------------------------------------------------------------ No hedging off: not checked
    static void NoHedgeOff()
    {
        Flat();
        Pos(simA, mnq, 2);
        Clear(); G("groupSave", Save(",\"group\":\"g1\"", "Lucid Flex", "false", "1000", "2000", "eod", "3000", "50000", "50100"));
        Check(FileText().Contains("group\tg1\tLucid Flex\toff\t"), "the switch off is saved");
        Check(ChartBridgeGroups.EntryCheck("page", simC, "MNQ", false, 1, true, false) == null, "No hedging off: a sell while the group is long goes");
        Clear(); G("groupSave", Save(",\"group\":\"g1\"", "Lucid Flex", "true", "1000", "2000", "eod", "3000", "50000", "50100"));
        Check(ChartBridgeGroups.EntryCheck("page", simC, "MNQ", false, 1, true, false) != null, "back on: refused again");
        Flat();
    }

    // ------------------------------------------------------------ two entries on opposite sides at the same moment: exactly one
    static void Race()
    {
        int ok = 0, both = 0, none = 0;
        for (int run = 0; run < 25; run++)
        {
            Flat();
            int a0 = Submits(simA), b0 = Submits(simB);
            Barrier bar = new Barrier(2);
            ChartBridgeClient p2 = new ChartBridgeClient(null, 62); p2.Origin = "http://localhost:8765"; p2.Tap = s => { };
            Clients()[62] = p2;
            ChartBridgeOrders.OnMessage(p2, "auth", "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
            Thread t1 = new Thread(() => { bar.SignalAndWait(); ChartBridgeOrders.OnMessage(page, "order", Order("SIM-A", "MNQ", "\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990")); });
            Thread t2 = new Thread(() => { bar.SignalAndWait(); ChartBridgeOrders.OnMessage(p2, "order", Order("SIM-B", "NQ", "\"side\":\"sell\",\"kind\":\"limit\",\"qty\":1,\"price\":25010")); });
            lock (page.Actions) page.Actions.Clear();
            t1.Start(); t2.Start(); t1.Join(); t2.Join();
            int n = (Submits(simA) - a0) + (Submits(simB) - b0);
            if (n == 1) ok++; else if (n == 2) both++; else none++;
            Clients().TryRemove(62, out p2);
        }
        Check(ok == 25 && both == 0 && none == 0, "two pages enter opposite sides at the same moment, 25 times: exactly one passes each time (" + ok + " one, " + both + " both, " + none + " none)");
        Flat();
    }

    // ------------------------------------------------------------ accountLimits, and accountGroup refused when it would mix
    static void Limits()
    {
        Flat();
        Clear(); G("accountLimits", "{\"type\":\"accountLimits\",\"cid\":\"l\",\"account\":\"SIM-A\",\"floor\":45000,\"dailyLoss\":500}");
        Check(Rejection().Contains("SIM-A is in group Lucid Flex: its group's rules apply"), "accountLimits for a group's account: refused");
        Clear(); G("accountLimits", "{\"type\":\"accountLimits\",\"cid\":\"l\",\"account\":\"SIM-D\",\"floor\":45000,\"dailyLoss\":500.5}");
        Check(Rejection() == "" && FileText().Contains("personal\tSIM-D\t45000\t500.5"), "a personal account's own floor and daily limit: saved");
        Check(Entry(Last("accounts"), "SIM-D").Contains("\"myFloor\":45000,\"myDailyLoss\":500.5"), "and sent at once");
        Clear(); G("accountLimits", "{\"type\":\"accountLimits\",\"cid\":\"l\",\"account\":\"SIM-D\",\"floor\":0,\"dailyLoss\":0}");
        Check(!FileText().Contains("personal\tSIM-D"), "both 0: no line");
        Clear(); G("accountLimits", "{\"type\":\"accountLimits\",\"cid\":\"l\",\"account\":\"SIM-D\",\"floor\":45000,\"dailyLoss\":500}");
        // joining would mix
        Pos(simA, mnq, 1); Pos(simD, nq, -1);
        Clear(); G("accountGroup", Join("SIM-D", "\"g1\"", null));
        Check(Rejection().Contains("SIM-D is short (SIM-D -1 NQ) and Lucid Flex is long (SIM-A +1 MNQ): joining would hedge the group") && ChartBridgeGroups.GroupOf("SIM-D") == null, "accountGroup refused when the move would mix the group");
        Clear(); G("accountGroup", Join("SIM-D", "\"g2\"", null));
        Check(Rejection() == "" && ChartBridgeGroups.GroupOf("SIM-D") == "g2", "into Apex (flat): it goes");
        Clear(); G("accountGroup", Join("SIM-D", "null", null));
        Check(Rejection() == "" && ChartBridgeGroups.GroupOf("SIM-D") == null && FileText().Contains("personal\tSIM-D\t45000\t500"), "back to None: its own limits are still there");
        Flat();
    }

    // ------------------------------------------------------------ the numbers: static, eod with the lock, intraday, personal
    static void Numbers()
    {
        Flat();
        // static (Apex, g2): size 50000, drawdown 2500, no daily, no target
        Clear(); G("groupSave", Save(",\"group\":\"g2\"", "Apex", "true", "1000", "2500", "static", "3000", "50000", "0"));
        Clear(); G("accountGroup", Join("SIM-D", "\"g2\"", null));
        ClockEt(2026, 10, 13, 18, 1);
        Money(simD, 49000, 0, 0); Tick();   // the day starts at 49000, read at 18:01 ET (on time: the computed P&L counts)
        ClockEt(2026, 10, 14, 10, 0);
        Money(simD, 48500, -100, -999);    // lost 500 since, 100 open
        string e = Entry(AccountsNow(), "SIM-D");
        Check(e.Contains("\"group\":\"g2\"") && e.Contains("\"floor\":47500,\"roomFloor\":900,\"roomDaily\":400,\"targetLeft\":4500") && e.Contains("\"src\":{\"floor\":\"computed\",\"roomFloor\":\"computed\",\"roomDaily\":\"computed\",\"targetLeft\":\"computed\"}"),
              "static: floor 50000-2500, room 48400-47500, daily 1000-600 (open P&L counted), target 53000-48500: " + e);
        Check(e.Contains("\"pnlToday\":-999") || e.Contains("\"pnlToday\":-1099"), "the accounts message keeps pnlToday as NinjaTrader's (1.25 pages)");
        string st = State("SIM-D");
        Check(st.Contains("\"realizedToday\":-500,\"unrealized\":-100") && st.Contains("\"pnlToday\":-600") && st.Contains("\"realizedToday\":\"computed\""), "accountState: realized from the day start (not NinjaTrader's -999), pnlToday with the open P&L: " + st);
        // eod (g1) with the lock: SIM-A, highest close 51000 -> floor 49000
        Money(simA, 50500, 200, 0);
        e = Entry(AccountsNow(), "SIM-A");
        Check(e.Contains("\"floor\":49000,\"roomFloor\":1700,\"roomDaily\":") && e.Contains("\"targetLeft\":2500"), "eod: floor 51000-2000, room 50700-49000: " + e);
        Clear(); G("accountGroup", Join("SIM-A", "null", null));
        Clear(); G("accountGroup", Join("SIM-A", "\"g1\"", "53000"));
        e = Entry(AccountsNow(), "SIM-A");
        Check(e.Contains("\"floor\":50100,"), "eod: 53000-2000 = 51000 stops at 50100 (floor stops at): " + e);
        // intraday
        Clear(); G("groupSave", Save(",\"group\":\"g1\"", "Lucid Flex", "true", "1000", "2000", "intraday", "3000", "50000", "0"));
        Clear(); G("accountGroup", Join("SIM-B", "null", null));
        Clear(); G("accountGroup", Join("SIM-B", "\"g1\"", "50000"));
        Money(simB, 50000, 800, 0); Tick();
        Check(Entry(AccountsNow(), "SIM-B").Contains("\"floor\":48800,\"roomFloor\":2000,"), "intraday: the high follows equity (50800), floor 48800");
        Money(simB, 50000, -300, 0); Tick();
        Check(Entry(AccountsNow(), "SIM-B").Contains("\"floor\":48800,\"roomFloor\":900,"), "intraday: equity down, the floor stays (room 49700-48800)");
        // NinjaTrader's trailing drawdown wins when it reports one
        simB.Items[AccountItem.TrailingMaxDrawdown] = 1234.5;
        e = Entry(AccountsNow(), "SIM-B");
        Check(e.Contains("\"roomFloor\":900,") && e.Contains("\"roomFloor\":\"computed\""), "review item 4: NinjaTrader's 1234.50 and the computed 900 both known: the smaller (computed): " + e);
        simB.Items[AccountItem.TrailingMaxDrawdown] = 700;
        e = Entry(AccountsNow(), "SIM-B");
        Check(e.Contains("\"roomFloor\":700,") && e.Contains("\"roomFloor\":\"ninjatrader\""), "review item 4: NinjaTrader's 700 is smaller: its figure, src ninjatrader: " + e);
        simB.Items.Remove(AccountItem.TrailingMaxDrawdown);
        // personal: SIM-C leaves the group, its own floor
        Clear(); G("accountGroup", Join("SIM-C", "null", null));
        Clear(); G("accountLimits", "{\"type\":\"accountLimits\",\"cid\":\"l\",\"account\":\"SIM-C\",\"floor\":48000,\"dailyLoss\":0}");
        Money(simC, 50200, 0, 0);
        e = Entry(AccountsNow(), "SIM-C");
        Check(e.Contains("\"floor\":48000,\"roomFloor\":2200,\"roomDaily\":null,\"targetLeft\":null") && e.Contains("\"floor\":\"settings\"") && e.Contains("\"roomDaily\":\"no group and no daily limit of its own (the Accounts tab)\"") && e.Contains("\"targetLeft\":\"a personal account has no profit target\""),
              "personal: my floor (settings), no daily limit, no target, each with why: " + e);
        simC.Connection.Status = ConnectionStatus.Disconnected;
        e = Entry(AccountsNow(), "SIM-C");
        Check(e.Contains("\"roomFloor\":null") && e.Contains("\"roomFloor\":\"the account is not connected\""), "not connected: the room is null with why");
        simC.Connection.Status = ConnectionStatus.Connected;
    }

    // ------------------------------------------------------------ the highs and the day start (account-marks.txt)
    static void Highs()
    {
        // SIM-A in g1 (intraday now, highs 53000 from the join); back to eod for the end-of-day high
        Clear(); G("groupSave", Save(",\"group\":\"g1\"", "Lucid Flex", "true", "1000", "2000", "eod", "3000", "50000", "0"));
        ClockEt(2026, 10, 14, 17, 10);
        Money(simA, 53400, 100, 0);
        ChartBridgeGroups.EodMark();   // what ChartBridgeBranches.Check runs every 2 s in the break (nt8-source.test.js checks the call)
        Check(MarksText().Contains("mark\tSIM-A\t53500\t"), "17:10 ET: the end-of-day high rises to the close (53500): " + MarksText().Replace("\t", "<TAB>"));
        Check(Entry(AccountsNow(), "SIM-A").Contains("\"floor\":51500,"), "eod floor from the new high");
        ClockEt(2026, 10, 14, 18, 1);   // the next session
        Money(simA, 53600, 0, 0);
        Tick();
        Check(MarksText().Contains("mark\tSIM-A\t53600\t") && MarksText().Contains("\t53600\t2026-10-15"), "18:01 ET: the session's first reading is its day start and raises the end-of-day high: " + MarksText().Replace("\t", "<TAB>"));
        Money(simA, 53300, -50, 0);
        Check(State("SIM-A").Contains("\"realizedToday\":-300,\"unrealized\":-50") && State("SIM-A").Contains("\"session\":\"2026-10-15\""), "the new session's P&L from its own start");
        // a restart keeps the marks
        ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
        foreach (Account a in Account.All) ChartBridgeAccounts.SeenConnected(a);
        Check(Entry(AccountsNow(), "SIM-A").Contains("\"floor\":51600,") && State("SIM-A").Contains("\"realizedToday\":-300"), "after a restart: the same highs and day start (account-marks.txt)");
        // an unreadable marks file: trailing floors null with why, a static one still works
        string mp = Path.Combine(folder, "account-marks.txt"), was = File.ReadAllText(mp);
        File.WriteAllText(mp, "not ours\n");
        ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
        foreach (Account a in Account.All) ChartBridgeAccounts.SeenConnected(a);
        Tick();
        string e = Entry(AccountsNow(), "SIM-A");
        Check(e.Contains("\"floor\":null") && e.Contains("account-marks.txt could not be read"), "marks unreadable: the eod floor is null with why: " + e);
        Check(Entry(AccountsNow(), "SIM-D").Contains("\"floor\":47500,"), "a static floor still works");
        Check(File.ReadAllText(mp) == "not ours\n", "an unreadable account-marks.txt is never rewritten that run");
        File.WriteAllText(mp, was);
        ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
        foreach (Account a in Account.All) ChartBridgeAccounts.SeenConnected(a);
        ClockEt(2026, 10, 14, 10, 0);
    }

    // ------------------------------------------------------------ accountState (the agent's view)
    static void AgentState()
    {
        string none = State(ChartBridgeBranches.None);
        Check(none.StartsWith("{\"type\":\"accountState\",\"account\":null,\"sim\":false,\"kind\":\"none\",\"group\":null,\"groupId\":null,\"groupSide\":null,\"noHedge\":null,\"rules\":null,\"balance\":null,") &&
              none.Contains("\"src\":{},\"why\":{\"balance\":\"the agent's account is None\"") && Regex.IsMatch(none, ",\"session\":\"[0-9-]{10}\",\"at\":[0-9]+\\}$"), "None: kind none, every number null with why: " + none);
        Flat();
        Pos(simA, mnq, 1);
        string st = State("SIM-A"), key;
        ChartBridgeGroups.AccountStateJson("SIM-A", out key);
        Check(st.Contains("\"account\":\"SIM-A\",\"sim\":true,\"kind\":\"prop\",\"group\":\"Lucid Flex\",\"groupId\":\"g1\",\"groupSide\":\"long\",\"noHedge\":true,\"rules\":{\"dailyLoss\":1000,\"drawdown\":2000,\"drawdownType\":\"eod\",\"target\":3000,\"size\":50000,\"lockAt\":0}"),
              "prop: the group, its side and its rules (size and lockAt; 0 for none): " + st);
        Check(!key.Contains("\"at\":") && st.StartsWith(key.Substring(0, key.Length - 1)), "the key is the same text without at");
        string p = State("SIM-C");
        Check(p.Contains("\"kind\":\"personal\",\"group\":null,\"groupId\":null,\"groupSide\":null,\"noHedge\":null,\"rules\":{\"floor\":48000,\"dailyLoss\":0}"), "personal: its own floor, no daily limit (0: none, said explicitly): " + p);
        Flat();
    }

    // ------------------------------------------------------------ groupDelete: its members go to None
    static void Deleting()
    {
        Clear(); G("groupDelete", "{\"type\":\"groupDelete\",\"cid\":\"d\",\"group\":\"g9\"}");
        Check(Rejection().Contains("no group g9"), "deleting a group that is not there: refused");
        Clear(); G("groupDelete", "{\"type\":\"groupDelete\",\"cid\":\"d\",\"group\":\"g1\"}");
        Check(Rejection() == "" && ChartBridgeGroups.GroupOf("SIM-A") == null && !FileText().Contains("\tg1\t") && !FileText().Contains("member\tSIM-A"), "Lucid Flex deleted: its members are in no group");
        Check(!Last("groups").Contains("Lucid Flex") && Entry(Last("accounts"), "SIM-A").Contains("\"group\":null"), "the pages told at once");
        Clear(); G("groupSave", Save("", "Topstep", "true", "0", "2000", "eod", "0", "50000", "0"));
        Check(FileText().Contains("group\tg3\tTopstep"), "a new group takes the next id (g3)");
    }

    // ------------------------------------------------------------ the order-path review of #48 (each check fails on a889b8f)
    static void ReviewFixes()
    {
        Flat();
        ChartBridgeGroups.ClockUtc = null; ClockEt(2026, 10, 14, 10, 0);
        Clear(); G("groupSave", Save("", "Review", "true", "0", "2000", "eod", "0", "50000", "0"));
        Money(simA, 50000, 0, 0); Money(simC, 50000, 0, 0);
        G("accountGroup", Join("SIM-A", "\"g1\"", null)); G("accountGroup", Join("SIM-C", "\"g1\"", null));
        Check(ChartBridgeGroups.GroupOf("SIM-A") == "g1" && ChartBridgeGroups.GroupOf("SIM-C") == "g1", "review: SIM-A and SIM-C in Review");
        // item 1: with agents on, a page market sell of 2 on a long 2 is pageReduces; a second while the first works would flip SIM-A short
        ChartBridgeAgents.ReadConfig("agents", "rv");
        ChartBridgeAgents.Start(false);
        try
        {
            Check(ChartBridgeAgents.Enabled, "review item 1: the agent channel is on (pageReduces in play)");
            Pos(simA, mnq, 2); Pos(simC, mnq, 1);
            int a0 = Submits(simA);
            Clear(); O(Order("SIM-A", "MNQ", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":2"));
            Check(Submits(simA) == a0 + 1 && Rejection() == "", "review item 1: the first market sell of the whole long 2: a true exit, it goes");
            Clear(); O(Order("SIM-A", "MNQ", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":2"));
            Check(Submits(simA) == a0 + 1 && Rejection().Contains("Group Review is long") && Rejection().Contains("could take SIM-A past flat: use Flatten"),
                  "review item 1: a second sell of 2 while the first works (it would leave SIM-A short 2 beside SIM-C long): refused, saying to use Flatten: " + Rejection());
            simA.Orders.Last().OrderState = OrderState.Cancelled;
            Clear(); O(Order("SIM-A", "MNQ", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":2"));
            Check(Submits(simA) == a0 + 2 && Rejection() == "", "review item 1: once the first is cancelled, the exit goes again (a true exit is never refused)");
        }
        finally { ChartBridgeAgents.Stop(); ChartBridgeAgents.ResetConfig(); }
        Flat();
        // item 5: two sells of 2 on a long 2: the second is an entry of 2 (the group is long and short)
        Pos(simA, mnq, 2);
        Manual(simA, mnq, OrderAction.Sell, OrderType.Limit, 2, "", "typed 1");
        Manual(simA, mnq, OrderAction.Sell, OrderType.Limit, 2, "", "typed 2");
        string gj = ChartBridgeGroups.GroupsJson();
        Check(gj.Contains("\"side\":\"mixed\"") && gj.Contains("{\"account\":\"SIM-A\",\"root\":\"MNQ\",\"side\":\"short\",\"what\":\"entry\",\"qty\":2}"), "review item 5: opposite orders summed: past the position they are an entry (mixed): " + gj);
        Flat();
        Pos(simA, mnq, 2);
        Manual(simA, mnq, OrderAction.Sell, OrderType.Limit, 1, "", "typed 1");
        Manual(simA, mnq, OrderAction.Sell, OrderType.Limit, 2, "", "typed 2");
        gj = ChartBridgeGroups.GroupsJson();
        Check(gj.Contains("\"side\":\"short\",\"what\":\"entry\",\"qty\":1}"), "review item 5: 1 + 2 sells on a long 2: 1 contract past it counts");
        Flat();
        // item 2: an unreadable groups.txt refuses entries but never an exit
        string file = Path.Combine(folder, "groups.txt"), was = File.ReadAllText(file);
        File.WriteAllText(file, "broken\n");
        ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
        foreach (Account a in Account.All) ChartBridgeAccounts.SeenConnected(a);
        Pos(simD, mnq, 1);
        int d0 = Submits(simD);
        Clear(); O(Order("SIM-D", "MNQ", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":1"));
        Check(Submits(simD) == d0 + 1 && Rejection() == "", "review item 2: groups.txt unreadable: the sell of SIM-D's long 1 (an exit) goes");
        Clear(); O(Order("SIM-D", "MNQ", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Submits(simD) == d0 + 1 && Rejection().Contains("groups.txt could not be read"), "review item 2: an entry is still refused");
        File.WriteAllText(file, was);
        ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
        foreach (Account a in Account.All) ChartBridgeAccounts.SeenConnected(a);
        Flat();
        // item 6: a late first reading (10:00 ET) never raises the end-of-day high; item 3: a late day start takes the smaller P&L
        Clear(); G("accountGroup", Join("SIM-B", "\"g1\"", "50000"));
        Money(simB, 52000, 0, -400);
        ClockEt(2026, 10, 16, 10, 0); Tick();
        Check(MarksText().Contains("mark\tSIM-B\t50000\t"), "review item 6: a first reading at 10:00 ET (52000) does not raise the end-of-day high (50000): " + MarksText().Replace("\t", "<TAB>"));
        Money(simB, 51900, -50, -400);
        string st = State("SIM-B");
        Check(st.Contains("\"pnlToday\":-450,\"realizedToday\":-400,") && st.Contains("\"realizedToday\":\"ninjatrader\"") && st.Contains("\"pnlToday\":\"ninjatrader\""),
              "review item 3: a day start read mid-session: the smaller of the computed (-100) and NinjaTrader's (-400): " + st);
        simB.Items[AccountItem.RealizedProfitLoss] = double.NaN;
        st = State("SIM-B");
        Check(st.Contains("\"pnlToday\":null") && st.Contains("\"roomDaily\":null") && st.Contains("started mid-session"), "review item 3: no NinjaTrader realized to compare: today's P&L and the daily room null, with why: " + st);
        simB.Items[AccountItem.RealizedProfitLoss] = 0;
        ClockEt(2026, 10, 16, 18, 1); Money(simB, 52000, 0, 0); Tick();
        Money(simB, 51900, 0, -999);
        st = State("SIM-B");
        Check(st.Contains("\"realizedToday\":-100,") && st.Contains("\"realizedToday\":\"computed\"") && MarksText().Contains("mark\tSIM-B\t52000\t"), "review items 3 and 6: read at 18:01 ET: on time, the computed P&L, and the close raises the end-of-day high: " + st);
        ClockEt(2026, 10, 14, 10, 0);
        Flat();
    }

    // ------------------------------------------------------------ an unreadable groups.txt: every entry refused, never rewritten
    static void Unreadable()
    {
        string p = Path.Combine(folder, "groups.txt"), was = File.ReadAllText(p);
        string[] broken = { "no header\n", ChartBridgeGroups.Header + "\n#\nmember\tSIM-A\tg5\n", ChartBridgeGroups.Header + "\n#\ngroup\tg1\tA\ton\t-\t2000\teod\t-\t50000\t-\ngroup\tg1\tB\ton\t-\t2000\teod\t-\t50000\t-\n", ChartBridgeGroups.Header + "\n#\nhero\tg1\n" };
        foreach (string text in broken)
        {
            File.WriteAllText(p, text);
            Clear();
            ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
            foreach (Account a in Account.All) ChartBridgeAccounts.SeenConnected(a);
            Check(Any("groups.txt could not be read: every new entry is refused until it can (exits always work)"), "unreadable (" + text.Split('\n').Last(l => l.Length > 0).Replace("\t", " ") + "): the pages get the alarm");
            int d = Submits(simD);
            Clear(); O(Order("SIM-D", "MNQ", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
            Check(Submits(simD) == d && Rejection().Contains("groups.txt could not be read"), "unreadable: every entry refused, any account");
            Clear(); G("groupSave", Save("", "New", "true", "0", "2000", "eod", "0", "50000", "0"));
            Check(Rejection().Contains("groups.txt could not be read") && File.ReadAllText(p) == text, "unreadable: changes refused, the file never rewritten");
            Check(ChartBridgeGroups.GroupsJson().Contains("\"list\":[],\"error\":\"groups.txt could not be read"), "the groups message says why");
            Pos(simD, mnq, 1);
            Clear(); ChartBridgeOrders.OnMessage(page, "flatten", "{\"type\":\"flatten\",\"cid\":\"f\",\"account\":\"SIM-D\",\"root\":\"MNQ\"}");
            Check(Rejection() == "" && simD.Calls.Any(x => x.StartsWith("flatten MNQ")), "unreadable: Flatten still works");
            Flat();
        }
        File.WriteAllText(p, was);
        ChartBridgeAccounts.ReadFault = f => f == "groups.txt" ? "locked by another program" : null;
        ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
        Check(ChartBridgeGroups.EntryCheck("page", simD, "MNQ", true, 1, true, false) == ChartBridgeGroups.ReadFailedText, "a file that cannot be opened (three tries): every entry refused");
        ChartBridgeAccounts.ReadFault = null;
        ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
        Check(ChartBridgeGroups.EntryCheck("page", simD, "MNQ", true, 1, true, false) == null && ChartBridgeGroups.GroupOf("SIM-B") == null && FileText() == was, "readable again after a start: as saved");
        File.Delete(p); File.Delete(Path.Combine(folder, "account-marks.txt"));
        ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
        Check(ChartBridgeGroups.GroupsJson() == "{\"type\":\"groups\",\"list\":[],\"error\":null}", "both files gone: no groups (0.5.7's behaviour)");
    }
}
