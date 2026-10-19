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
    // 0.6.3 (audit C3): a file broken on purpose, with no last good copy (.bak) to fall back to (the backup cases are their own)
    // 0.6.3 (review MED 5): a file gone means no copy beside it either (a .bak or .tmp left would be used, or stand the agent down)
    static void Gone(string path) { File.Delete(path); File.Delete(path + ".bak"); File.Delete(path + ".tmp"); }
    static void Corrupt(string path, string text) { try { Gone(path + ".bak"); } catch (Exception) { } File.WriteAllText(path, text); }
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

    // 0.6.3 (audit C2): the PC off at the close, or asleep while a position was open
    static void Restart() { ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs()); foreach (Account a in Account.All) ChartBridgeAccounts.SeenConnected(a); }
    static void MissedCloses()
    {
        Flat();
        ChartBridgeGroups.GapMs = 1e12;   // the harness clock jumps: watched unless a case says otherwise (a restart is always a gap)
        Clear(); G("groupSave", Save(",\"group\":\"g1\"", "Lucid Flex", "true", "1000", "2000", "eod", "3000", "50000", "0"));
        ClockEt(2026, 10, 20, 9, 0);
        Money(simC, 51000, 0, 0);
        Clear(); G("accountGroup", Join("SIM-C", "\"g1\"", "51000"));
        Check(Rejection() == "" && ChartBridgeGroups.GroupOf("SIM-C") == "g1", "C2 setup: SIM-C in an EOD group, highest close 51000");
        ClockEt(2026, 10, 20, 16, 30); Money(simC, 51200, 0, 0); Tick();
        Check(MarksText().Contains("mark\tSIM-C\t51000\t51200\t") && MarksText().Contains("\t2026-10-19\t51200\tflat\t-\t-\n"), "0.6.3 C2: the last close seen, the last balance and flat are saved (account-marks.txt): " + MarksText().Replace("\t", "<TAB>"));
        // the laptop off from 16:30 to 19:00, nothing traded: the balance is that close
        ClockEt(2026, 10, 20, 19, 0); Restart(); Tick();
        string e = Entry(AccountsNow(), "SIM-C");
        Check(e.Contains("\"floor\":49200,") && MarksText().Contains("mark\tSIM-C\t51200\t") && MarksText().Contains("\t2026-10-20\t51200\tflat\t-\t-\n"),
              "0.6.3 C2: off over the close, nothing traded: the first reading (51200) is taken as the close, floor 49200: " + e);
        // off over the close and the account traded (a target filled at the broker): floor and room null with the reason, never a guess
        ClockEt(2026, 10, 21, 16, 30); Tick();
        ClockEt(2026, 10, 21, 19, 0); Restart(); Money(simC, 51800, 0, 0); Clear(); Tick();
        e = Entry(AccountsNow(), "SIM-C");
        Check(e.Contains("\"floor\":null,\"roomFloor\":null,") && e.Contains("ChartBridge was not running at the close of 2026-10-21: put the account in Lucid Flex again and give the highest close from the firm's dashboard") &&
              Any("SIM-C: ChartBridge was not running at the close of 2026-10-21"), "0.6.3 C2: off over the close and it traded: floor and roomFloor null with the reason, the pages told: " + e);
        Check(State("SIM-C").Contains("\"roomFloor\":null") && State("SIM-C").Contains("not running at the close of 2026-10-21"), "0.6.3 C2: the agents' accountState too: " + State("SIM-C"));
        Check(!Any("its intraday high may have been missed"), "0.6.3 LOW 8: an EOD group's account never gets the intraday-high warning");
        simC.Items[AccountItem.TrailingMaxDrawdown] = 700;   // NinjaTrader reports the firm's own trailing room
        e = Entry(AccountsNow(), "SIM-C");
        Check(e.Contains("\"floor\":null,\"roomFloor\":700,") && e.Contains("\"roomFloor\":\"ninjatrader\""), "0.6.3 LOW 8: the floor not known, but NinjaTrader's own trailing room (700) is given, src ninjatrader: " + e);
        simC.Items.Remove(AccountItem.TrailingMaxDrawdown);
        Restart(); Tick();
        Check(Entry(AccountsNow(), "SIM-C").Contains("\"floor\":null,") && MarksText().Contains("\tflat\t2026-10-21\t2026-10-21\n"), "0.6.3 C2: the missed close survives a restart (account-marks.txt)");
        G("accountGroup", Join("SIM-C", "null", null)); Clear(); G("accountGroup", Join("SIM-C", "\"g1\"", "52000"));
        Check(Entry(AccountsNow(), "SIM-C").Contains("\"floor\":50000,") && MarksText().Contains("\t51800\tflat\t-\t-\n"), "0.6.3 C2: put in the group again with the highest close (52000): floor 50000, the missed close cleared");
        // a weekend off with nothing traded: every close missed was that balance
        ClockEt(2026, 10, 23, 16, 30); Tick();
        ClockEt(2026, 10, 26, 8, 0); Restart(); Tick();
        Check(Entry(AccountsNow(), "SIM-C").Contains("\"floor\":50000,") && MarksText().Contains("\t2026-10-23\t51800\tflat\t-\t-\n"), "0.6.3 C2: Friday 16:30 to Monday 08:00, nothing traded: no close missed, floor stays 50000");
        // asleep over the close with a position open (no restart: a gap in the 1 s readings), the same balance: not known
        ChartBridgeGroups.GapMs = 10000;
        Pos(simC, mnq, 1);
        ClockEt(2026, 10, 26, 16, 30); Money(simC, 51800, 150, 0); Tick();
        ClockEt(2026, 10, 26, 19, 0); Clear(); Tick();
        e = Entry(AccountsNow(), "SIM-C");
        Check(e.Contains("\"floor\":null,\"roomFloor\":null,") && e.Contains("not running at the close of 2026-10-26"), "0.6.3 C2: asleep over the close holding a position: floor and room null: " + e);
        Pos(simC, mnq, 0); Money(simC, 51800, 0, 0);
        G("accountGroup", Join("SIM-C", "null", null)); Clear(); G("accountGroup", Join("SIM-C", "\"g1\"", "52000"));
        ChartBridgeGroups.GapMs = 1e12;
        // started in the break after a missed close the day before: this reading is today's close, the one before is missed
        ClockEt(2026, 10, 27, 16, 0); Tick();
        ClockEt(2026, 10, 27, 17, 20); Restart(); Money(simC, 52300, 0, 0); Tick();
        e = Entry(AccountsNow(), "SIM-C");
        Check(e.Contains("\"floor\":50300,") && MarksText().Contains("mark\tSIM-C\t52300\t"), "0.6.3 C2: restarted at 17:20 ET: the reading is the day's close (52300), nothing before it missed: floor 50300: " + e);
        // intraday: off while a position was open
        Clear(); G("groupSave", Save(",\"group\":\"g1\"", "Lucid Flex", "true", "1000", "2000", "intraday", "3000", "50000", "0"));
        G("accountGroup", Join("SIM-C", "null", null)); Clear(); G("accountGroup", Join("SIM-C", "\"g1\"", "52300"));
        ChartBridgeGroups.GapMs = 10000;
        ClockEt(2026, 10, 28, 10, 0); Tick();
        Check(Entry(AccountsNow(), "SIM-C").Contains("\"floor\":50300,"), "0.6.3 C2 intraday: floor 50300 while watched");
        ClockEt(2026, 10, 28, 10, 30); Tick();
        Check(Entry(AccountsNow(), "SIM-C").Contains("\"floor\":50300,"), "0.6.3 C2 intraday: a gap while flat with nothing traded misses no high");
        Pos(simC, mnq, 1); Money(simC, 52300, 40, 0); Tick();
        ClockEt(2026, 10, 28, 11, 0); Money(simC, 52300, -20, 0); Clear(); Tick();
        e = Entry(AccountsNow(), "SIM-C");
        Check(e.Contains("\"floor\":null,\"roomFloor\":null,") && e.Contains("its intraday high may be missed: put it in Lucid Flex again and give the highest balance from the firm's dashboard") && Any("its intraday high may have been missed"),
              "0.6.3 C2 intraday: 30 minutes unwatched holding a position: floor and room null with the reason: " + e);
        Pos(simC, mnq, 0); Money(simC, 52300, 0, 0);
        G("accountGroup", Join("SIM-C", "null", null)); Clear(); G("accountGroup", Join("SIM-C", "\"g1\"", "52500"));
        Check(Entry(AccountsNow(), "SIM-C").Contains("\"floor\":50500,"), "0.6.3 C2 intraday: put in the group again with its highest balance: known again");
        // a 0.6.2 file (7 fields): read as before, no gap check at its first reading
        string mp = Path.Combine(folder, "account-marks.txt");
        File.WriteAllText(mp, ChartBridgeGroups.MarksHeader + "\n" + "# old\n" + "mark\tSIM-C\t52500\t52500\t52300\t2026-10-28\t-\n");
        ClockEt(2026, 10, 28, 19, 0); Restart(); Money(simC, 52900, 0, 0); Tick();
        Check(Entry(AccountsNow(), "SIM-C").Contains("\"floor\":50900,") && MarksText().Contains("mark\tSIM-C\t52500\t52900\t52900\t2026-10-29\t") && MarksText().Contains("\t2026-10-28\t52900\tflat\t-\t-\n"),
              "0.6.3 C2: a 0.6.2 account-marks.txt (7 fields) reads as 0.6.2 did and is written with the new fields: " + MarksText().Replace("\t", "<TAB>"));
        Clear(); G("accountGroup", Join("SIM-C", "null", null));
        Clear(); G("groupSave", Save(",\"group\":\"g1\"", "Lucid Flex", "true", "1000", "2000", "eod", "3000", "50000", "0"));
        ChartBridgeGroups.GapMs = 10000;
        Flat();
    }

    static void Backups()
    {
        string p = Path.Combine(folder, "groups.txt"), mp = Path.Combine(folder, "account-marks.txt");
        string was = File.ReadAllText(p), mwas = File.ReadAllText(mp);
        Clear(); G("groupSave", Save(",\"group\":\"g1\"", "Lucid Flex", "true", "1000", "2000", "eod", "3000", "50000", "0"));   // a save: the copy before it is groups.txt.bak
        Check(File.Exists(p + ".bak") && File.Exists(mp + ".bak"), "0.6.3 C3: groups.txt and account-marks.txt keep the copy each save replaces (.bak)");
        File.WriteAllText(p, new string('\0', 48));
        File.WriteAllText(mp, "mark\thalf");
        Clear(); ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
        foreach (Account a in Account.All) ChartBridgeAccounts.SeenConnected(a);
        string gj = ChartBridgeGroups.GroupsJson();
        Check(gj.Contains("\"error\":\"groups.txt could not be read") && Any("its last good copy, groups.txt.bak, holds ") && Any("to go back to it, copy groups.txt.bak over groups.txt"),
              "0.6.3 MED 3: a groups.txt of zeros: unreadable as in 0.6.2 (every entry refused), never the .bak on its own; the alarm says what the copy holds and how to go back: " + gj);
        Check(Any("account-marks.txt could not be read (the first line is not ChartBridge's): ChartBridge uses its last good copy (account-marks.txt.bak)") && !Entry(AccountsNow(), "SIM-A").Contains("account-marks.txt could not be read"),
              "0.6.3 C3: a torn account-marks.txt: its last good copy is read (kept automatic)");
        List<string> late = new List<string>();
        ChartBridgeClient lc = new ChartBridgeClient(null, 777) { Origin = "http://localhost:8765" };
        lc.Tap = x => { lock (late) late.Add(x); };
        ChartBridgeAccounts.SignedIn(lc);
        Check(late.Any(x => x.Contains("account-marks.txt could not be read") && x.Contains("last good copy")) && late.Any(x => x.Contains("groups.txt could not be read")), "0.6.3 C3: a page that signs in later gets the notes too");
        // 0.6.3 (review MED 5): the files missing after a cut-off replace, a copy beside each
        File.WriteAllText(p + ".bak", was); File.Delete(p);
        File.WriteAllText(mp + ".bak", mwas); File.Delete(mp);
        Clear(); ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
        foreach (Account a in Account.All) ChartBridgeAccounts.SeenConnected(a);
        gj = ChartBridgeGroups.GroupsJson();
        Check(gj.Contains("\"error\":\"groups.txt could not be read") && gj.Contains("(groups.txt is missing (a save cut off?) but groups.txt.bak is there and holds ") && !File.Exists(p),
              "0.6.3 MED 5: groups.txt missing with its .bak: unreadable with the alarm (never no groups on its own), not written: " + gj);
        Check(Any("account-marks.txt is missing (a save cut off?): ChartBridge uses account-marks.txt.bak and writes the file again"), "0.6.3 MED 5: account-marks.txt missing: its .bak used automatically");
        File.WriteAllText(p, was); File.WriteAllText(mp, mwas);
        Clear(); ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
        foreach (Account a in Account.All) ChartBridgeAccounts.SeenConnected(a);
        ChartBridgeFiles.ClearNotes();
    }

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
            LeftoverExits(); // Q-EXIT (b), Anthony 2026-10-15: an exit left behind when a position goes flat is cancelled
            Consistency();   // CON (a), Anthony 2026-10-15: the group's consistency percent, informational
            TypeAndHero();   // 0.6.1 (SPEC CE-1): each group's Type and default hero, shapes only
            AccountTypeInState();   // 0.6.2: accountState.accountType
            StandDowns();    // 0.6.2 (SPEC CE-2): a deleted group's stand-downs go with it; agent-standdowns.txt gates agent entries only
            MissedCloses();  // 0.6.3 (audit C2): a close or an intraday high ChartBridge did not see never overstates the room
            Backups();       // 0.6.3 (audit C3): groups.txt and account-marks.txt fall back to their last good copy
            MemberRules();   // 0.6.5 (Anthony 2026-10-19, PRIORITY): each member's own rules, the old file, the risk percent
            GroupEntries();  // 0.6.5 (Anthony 2026-10-19): trade the group from the ticket, each member sized from the risk percent
        }
        catch (Exception ex) { Check(false, "groups harness threw: " + ex); }
        finally
        {
            try { ChartBridgeAgents.Stop(); ChartBridgeAgents.ResetConfig(); } catch (Exception) { }
            ChartBridgeGroups.ClockUtc = null; ChartBridgeBranches.ClockUtc = null; ChartBridgeAccounts.ReadFault = null; ChartBridgeGroups.MarksWriteMs = 5000; ChartBridgeGroups.LeftSettleMs = 150;
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
        ChartBridgeGroups.LeftSettleMs = 0;   // flat counts as settled at once here (the settle has a check of its own)
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
        Check(e.Contains("\"group\":null,\"myFloor\":null,\"myDailyLoss\":null,\"myLimitsSet\":false,\"floor\":null") && e.Contains("\"why\":{\"floor\":\"no group and no floor of its own (the Accounts tab)\""), "accounts: group null, personal, no floor, with why: " + e);
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
        Check(Rejection() == "" && Last("groups").Contains("{\"id\":\"g1\",\"name\":\"Lucid\",\"noHedge\":true,\"dailyLoss\":1000,\"drawdown\":2000,\"drawdownType\":\"eod\",\"target\":3000,\"size\":50000,\"lockAt\":50100,\"consistency\":null,\"accountType\":null,\"hero\":null,\"members\":[],\"side\":null,\"holders\":[],\"riskPct\":null,\"ownRules\":[]}"),
              "groupSave: g1 made, the page told at once: " + Last("groups"));
        string[] lines = FileText().Split('\n');
        Check(lines[0] == ChartBridgeGroups.Header && lines[1].StartsWith("# ") && lines[2] == "group\tg1\tLucid\ton\t1000\t2000\teod\t3000\t50000\t50100\t-\t-\t-",   // 0.6.1: then type and hero, - for not set and none
              "groups.txt: two # lines, then the group line: " + FileText().Replace("\t", "<TAB>"));
        Clear(); G("groupSave", Save("", "LUCID", "true", "0", "2500", "intraday", "0", "50000", "0"));
        Check(Rejection().Contains("a group named LUCID is there already"), "a name twice (any case): refused");
        Clear(); G("groupSave", Save("", "Apex", "true", "0", "2500", "static", "0", "50000", "0"));
        Check(Rejection() == "" && FileText().Contains("group\tg2\tApex\ton\t-\t2500\tstatic\t-\t50000\t-\t-"), "g2 made, none written as -: " + FileText().Replace("\t", "<TAB>"));
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
        Check(FileText().Contains("personal\tSIM-D\t-\t-"), "both 0: the line stays as none and none (set by Anthony, not never set)");
        Check(State("SIM-D").Contains("\"kind\":\"personal\",\"group\":null,\"groupId\":null,\"groupSide\":null,\"noHedge\":null,\"accountType\":null,\"rules\":{\"floor\":0,\"dailyLoss\":0}"), "set to none: rules {floor 0, dailyLoss 0}");
        Account simE = NewAccount("SIM-E");   // in no group, no limits ever set
        try
        {
            Check(State("SIM-E").Contains("\"kind\":\"personal\",\"group\":null,\"groupId\":null,\"groupSide\":null,\"noHedge\":null,\"accountType\":null,\"rules\":null,") && Entry(AccountsNow(), "SIM-E").Contains("\"myLimitsSet\":false"), "never set: rules null (the agent keeps its model numbers); the accounts entry says not set");
            Check(Entry(AccountsNow(), "SIM-D").Contains("\"myLimitsSet\":true"), "set to none: myLimitsSet true");
            simE.Items[AccountItem.TrailingMaxDrawdown] = 812.5;
            Check(State("SIM-E").Contains("\"roomFloor\":812.5,") && State("SIM-E").Contains("\"roomFloor\":\"ninjatrader\""), "never set: NinjaTrader's trailing drawdown is still sent as roomFloor (src ninjatrader)");
        }
        finally { Account.All.Remove(simE); }
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
        Corrupt(mp, "not ours\n");
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
        Check(none.StartsWith("{\"type\":\"accountState\",\"account\":null,\"sim\":false,\"kind\":\"none\",\"group\":null,\"groupId\":null,\"groupSide\":null,\"noHedge\":null,\"accountType\":null,\"rules\":null,\"balance\":null,") &&
              none.Contains("\"src\":{},\"why\":{\"balance\":\"the agent's account is None\"") && Regex.IsMatch(none, ",\"session\":\"[0-9-]{10}\",\"at\":[0-9]+\\}$"), "None: kind none, every number null with why: " + none);
        Flat();
        Pos(simA, mnq, 1);
        string st = State("SIM-A"), key;
        ChartBridgeGroups.AccountStateJson("SIM-A", out key);
        Check(st.Contains("\"account\":\"SIM-A\",\"sim\":true,\"kind\":\"prop\",\"group\":\"Lucid Flex\",\"groupId\":\"g1\",\"groupSide\":\"long\",\"noHedge\":true,\"accountType\":null,\"rules\":{\"dailyLoss\":1000,\"drawdown\":2000,\"drawdownType\":\"eod\",\"target\":3000,\"size\":50000,\"lockAt\":0,\"consistency\":0,\"maxMinis\":0,\"maxMicros\":0}"),
              "prop: the group, its side and its rules (size and lockAt; 0 for none): " + st);
        Check(!key.Contains("\"at\":") && st.StartsWith(key.Substring(0, key.Length - 1)), "the key is the same text without at");
        string p = State("SIM-C");
        Check(p.Contains("\"kind\":\"personal\",\"group\":null,\"groupId\":null,\"groupSide\":null,\"noHedge\":null,\"accountType\":null,\"rules\":{\"floor\":48000,\"dailyLoss\":0}"), "personal: its own floor, no daily limit (0: none, said explicitly): " + p);
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
        // re-review: protective orders never make a true exit look too big
        Pos(simA, mnq, 2); Pos(simC, mnq, 1);
        Manual(simA, mnq, OrderAction.Sell, OrderType.StopMarket, 2, "", "CB#1a2b3c4d stop f2 q2 p24980");   // a bracket with a stop and no target: no OCO id
        int e0 = Submits(simA);
        Clear(); O(Order("SIM-A", "MNQ", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":1"));
        Check(Submits(simA) == e0 + 1 && Rejection() == "", "re-review: long 2 with a lone ChartBridge stop leg: Sell Mkt 1 goes: " + Rejection());
        simA.Orders.Last().OrderState = OrderState.Filled;
        Clear(); O(Order("SIM-A", "MNQ", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":2"));
        Check(Submits(simA) == e0 + 2 && Rejection() == "", "re-review: long 2 with a lone ChartBridge stop leg: Sell Mkt 2 goes: " + Rejection());
        Flat();
        Pos(simA, mnq, 2); Pos(simC, mnq, 1);
        Manual(simA, mnq, OrderAction.Sell, OrderType.StopMarket, 2, "", "typed stop");                       // typed into NinjaTrader, no OCO id
        Manual(simA, mnq, OrderAction.Sell, OrderType.Limit, 2, "atm1", "Target1");                          // an ATM's target (OCO)
        e0 = Submits(simA);
        Clear(); O(Order("SIM-A", "MNQ", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":2"));
        Check(Submits(simA) == e0 + 1 && Rejection() == "", "re-review: long 2 with a typed stop (no OCO) and an ATM target: Sell Mkt 2 goes: " + Rejection());
        Clear(); O(Order("SIM-A", "MNQ", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":2"));
        Check(Submits(simA) == e0 + 1 && Rejection().Contains("use Flatten"), "re-review: the double Sell Mkt 2 is still refused");
        simA.Orders.Last().OrderState = OrderState.Cancelled;
        Clear(); O(Order("SIM-A", "MNQ", "\"side\":\"sell\",\"kind\":\"market\",\"qty\":3"));
        Check(Submits(simA) == e0 + 1 && Rejection().Contains("Group Review is long"), "re-review: a reversal Sell Mkt 3 is still refused");
        Clear(); ChartBridgeOrders.OnMessage(page, "flatten", "{\"type\":\"flatten\",\"cid\":\"f\",\"account\":\"SIM-A\",\"root\":\"MNQ\"}");
        Check(Rejection() == "" && simA.Calls.Skip(0).Any(x => x.StartsWith("flatten MNQ")), "re-review: Flatten goes");
        // a typed stop left behind once the position is flat counts as an entry for the group (fix 5)
        Pos(simA, mnq, 0);
        Check(ChartBridgeGroups.GroupsJson().Contains("{\"account\":\"SIM-A\",\"root\":\"MNQ\",\"side\":\"short\",\"what\":\"entry\",\"qty\":2}"), "re-review: a typed stop left after flat is a sell entry of 2 for the group (it could open a short)");
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
        Corrupt(file, "broken\n");
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

    // ------------------------------------------------------------ Q-EXIT (b) (Anthony 2026-10-15): exits left behind are cancelled when flat
    static bool Cancelled(Account a, Order o) { return a.Calls.Contains("cancel " + o.Name); }
    static void LeftoverExits()
    {
        Flat(); Tick();   // the first pass since the start ran with nothing to look at
        Check(ChartBridgeGroups.GroupOf("SIM-A") == "g1" && ChartBridgeGroups.GroupOf("SIM-C") == "g1", "Q-EXIT: SIM-A and SIM-C in Review (No hedging on)");
        // the reviewer's repro: long 2, a lone stop leg 2, a resting Sell Lmt 2 accepted; the stop fills
        Pos(simA, mnq, 2); Pos(simC, mnq, 1);
        Order leg = Manual(simA, mnq, OrderAction.Sell, OrderType.StopMarket, 2, "", "CB#1a2b3c4d stop f2 q2 p24980");
        int a0 = Submits(simA);
        Clear(); O(Order("SIM-A", "MNQ", "\"side\":\"sell\",\"kind\":\"limit\",\"qty\":2,\"price\":25010"));
        Order lim = simA.Orders.Last();
        Check(Submits(simA) == a0 + 1 && Rejection() == "", "Q-EXIT: the resting Sell Lmt 2 beside the stop is accepted (exits are never blocked)");
        Tick();
        Check(!Cancelled(simA, lim), "Q-EXIT: while SIM-A is long, nothing is cancelled");
        leg.OrderState = OrderState.Filled; Pos(simA, mnq, 0);
        Clear(); Tick();
        Check(Cancelled(simA, lim) && !Cancelled(simA, leg) && Any("SIM-A went flat on MNQ: cancelled the sell limit 2 left from the long, so it cannot open a short"), "Q-EXIT: the stop fills, SIM-A is flat: the sell limit 2 left behind is cancelled, the pages told");
        Clear(); Tick();
        Check(!Any("went flat"), "Q-EXIT: once");
        // an exit typed into NinjaTrader, likewise
        Flat(); Pos(simA, mnq, 2); Pos(simC, mnq, 1);
        Order typed = Manual(simA, mnq, OrderAction.Sell, OrderType.Limit, 2, "", "typed exit");
        Tick();
        Pos(simA, mnq, 0); Clear(); Tick();
        Check(Cancelled(simA, typed) && Any("cancelled the sell limit 2 left from the long"), "Q-EXIT: a limit exit typed into NinjaTrader, left after flat: cancelled");
        // partial fills: a part filled while the position is still held stays; the rest goes once flat
        Flat(); Pos(simA, mnq, 2); Pos(simC, mnq, 1);
        Order part = Manual(simA, mnq, OrderAction.Sell, OrderType.Limit, 2, "", "typed part");
        Tick();
        part.Filled = 1; part.OrderState = OrderState.PartFilled; Pos(simA, mnq, 1); Tick();
        Check(!Cancelled(simA, part), "Q-EXIT: part filled, SIM-A still long 1: nothing cancelled");
        Pos(simA, mnq, 0); Clear(); Tick();
        Check(Cancelled(simA, part) && Any("cancelled the sell limit 1 left from the long"), "Q-EXIT: flat by its stop: the rest (1) is cancelled");
        // an entry placed on a flat account afterwards is not this rule's: the group check judges it
        Flat(); Pos(simC, mnq, 1); Tick();
        Order later = Manual(simA, mnq, OrderAction.Sell, OrderType.Limit, 1, "", "typed later");
        Clear(); Tick();
        Check(!Cancelled(simA, later) && ChartBridgeGroups.GroupsJson().Contains("\"side\":\"mixed\""), "Q-EXIT: a sell limit placed on the flat account later is not cancelled by this (the group shows mixed)");
        Clear(); O(Order("SIM-A", "MNQ", "\"side\":\"sell\",\"kind\":\"limit\",\"qty\":1,\"price\":25010"));
        Check(Rejection().Contains("Group Review is long and short"), "Q-EXIT: a new sell entry on the flat account is judged by the group check");
        // an account in no group, and No hedging off: untouched
        Flat(); Pos(simD, mnq, 2);
        Order nog = Manual(simD, mnq, OrderAction.Sell, OrderType.Limit, 2, "", "typed d");
        Tick(); Pos(simD, mnq, 0); Tick();
        Check(!Cancelled(simD, nog), "Q-EXIT: an account in no group: untouched");
        Flat();
        G("groupSave", Save(",\"group\":\"g1\"", "Review", "false", "0", "2000", "eod", "0", "50000", "0"));
        Pos(simA, mnq, 2); Pos(simC, mnq, 1);
        Order off = Manual(simA, mnq, OrderAction.Sell, OrderType.Limit, 2, "", "typed off");
        Tick(); Pos(simA, mnq, 0); Tick();
        Check(!Cancelled(simA, off), "Q-EXIT: No hedging off: untouched");
        G("groupSave", Save(",\"group\":\"g1\"", "Review", "true", "0", "2000", "eod", "0", "50000", "0"));
        // after a start: an order on a flat account against its group's side is cancelled once, the same way
        Flat(); Pos(simC, mnq, 1);
        Order before = Manual(simA, mnq, OrderAction.Sell, OrderType.Limit, 1, "", "typed before");
        ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
        foreach (Account a in Account.All) ChartBridgeAccounts.SeenConnected(a);
        Clear(); Tick();
        Check(Cancelled(simA, before) && Any("SIM-A is flat on MNQ: cancelled the sell limit 1 left from before ChartBridge started (Review is long), so it cannot open a short"), "Q-EXIT: after a start, the leftover against the group's side: cancelled once, with the note");
        Order after = Manual(simA, mnq, OrderAction.Sell, OrderType.Limit, 1, "", "typed after");
        Clear(); Tick();
        Check(!Cancelled(simA, after), "Q-EXIT: only on the first look after the start");
        Flat();
        // re-review 2, item 1: a typed OCO pair (sell stop 2 and sell limit 2, not ChartBridge's) left after flat: counted once, cancelled
        Pos(simA, mnq, 2); Pos(simC, mnq, 1);
        Order ocoStop = Manual(simA, mnq, OrderAction.Sell, OrderType.StopMarket, 2, "pair1", "typed oco stop");
        Order ocoLim = Manual(simA, mnq, OrderAction.Sell, OrderType.Limit, 2, "pair1", "typed oco limit");
        Tick();
        Check(ChartBridgeGroups.GroupsJson().Contains("\"side\":\"long\""), "re-review 2: while SIM-A is long, its OCO pair is protective (not counted)");
        Pos(simA, mnq, 0);
        string gj2 = ChartBridgeGroups.GroupsJson();
        Check(gj2.Contains("\"side\":\"mixed\"") && gj2.Contains("{\"account\":\"SIM-A\",\"root\":\"MNQ\",\"side\":\"short\",\"what\":\"entry\",\"qty\":2}") && !gj2.Contains("\"qty\":4"), "re-review 2: flat: the OCO pair counts once, at its largest (a sell entry of 2): " + gj2);
        Clear(); Tick();
        Check(Cancelled(simA, ocoStop) && Cancelled(simA, ocoLim), "re-review 2: and both legs of the typed OCO pair are cancelled");
        Flat();
        // item 2: a position update to flat runs the pass at once (no 1 s check)
        ChartBridgeGroups.LeftoversInline = true;
        try
        {
            Pos(simA, mnq, 2); Pos(simC, mnq, 1);
            Order ev = Manual(simA, mnq, OrderAction.Sell, OrderType.Limit, 2, "", "typed ev");
            Tick();
            Pos(simA, mnq, 0);
            ChartBridgeOrders.OnPositionUpdate(simA, new PositionEventArgs { Position = new Position { Instrument = mnq }, MarketPosition = MarketPosition.Flat, Quantity = 0, AveragePrice = 0 });
            Check(Cancelled(simA, ev), "re-review 2: the position update to flat cancels it at once");
        }
        finally { ChartBridgeGroups.LeftoversInline = false; }
        Flat();
        // item 4: a marked exit that became an add to a short is named from the short just closed and its own side
        Pos(simA, mnq, 2); Pos(simC, mnq, 1);
        Order flip = Manual(simA, mnq, OrderAction.Sell, OrderType.Limit, 1, "", "typed flip");
        Tick();
        Pos(simA, mnq, -1); Tick();
        Pos(simA, mnq, 0); Clear(); Tick();
        Check(Cancelled(simA, flip) && Any("SIM-A went flat on MNQ: cancelled the sell limit 1 left from the short, so it cannot open a short"), "re-review 2: the note names the short just closed and the order's own side");
        Flat();
        // re-review 3: a resting reversal typed into NinjaTrader that fills through flat keeps its rest when alone
        Pos(simA, mnq, 2);
        Order rev = Manual(simA, mnq, OrderAction.Sell, OrderType.Limit, 4, "", "typed reversal");
        Tick();
        rev.Filled = 2; rev.OrderState = OrderState.PartFilled; Pos(simA, mnq, 0);
        Clear(); Tick();
        Check(!Cancelled(simA, rev), "re-review 3: SIM-A the only holder: the reversal's rest (2) is not cut at flat");
        Flat();
        Pos(simA, mnq, 2); Pos(simC, mnq, 1);
        Order rev2 = Manual(simA, mnq, OrderAction.Sell, OrderType.Limit, 4, "", "typed reversal 2");
        Tick();
        rev2.Filled = 2; rev2.OrderState = OrderState.PartFilled; Pos(simA, mnq, 0);
        Clear(); Tick();
        Check(Cancelled(simA, rev2) && Any("SIM-A went through flat on MNQ: cancelled the rest of the sell limit 2 (Review is long), so it cannot open a short"), "re-review 3: with SIM-C long 1 the reversal's rest would hedge: cancelled, with the note");
        Flat();
        // re-review 3: the settle: flat but not yet steady, nothing is cancelled
        ChartBridgeGroups.LeftSettleMs = 150;
        try
        {
            Pos(simA, mnq, 2); Pos(simC, mnq, 1);
            Order zero = Manual(simA, mnq, OrderAction.Sell, OrderType.StopMarket, 2, "", "typed stop below");
            Order st = Manual(simA, mnq, OrderAction.Sell, OrderType.Limit, 4, "", "typed settle");
            ClockEt(2026, 10, 14, 10, 0); Tick();
            st.Filled = 2; st.OrderState = OrderState.PartFilled; Pos(simA, mnq, 0); Tick();
            Check(Cancelled(simA, zero), "re-review 4: a leftover with no fill of its own is cancelled at once, no settle");
            Check(!Cancelled(simA, st), "re-review 3: a reversal's rest waits for the settle (150 ms): nothing cancelled yet");
            DateTime steadyAt = ChartBridgeGroups.ClockUtc().AddMilliseconds(400);
            ChartBridgeGroups.ClockUtc = () => steadyAt;
            Tick();
            Check(Cancelled(simA, st), "re-review 3: flat and steady, SIM-C long: the reversal's rest is cancelled");
        }
        finally { ChartBridgeGroups.LeftSettleMs = 0; ClockEt(2026, 10, 14, 10, 0); }
        Flat();
        // item 3: after a start, an account not connected at the first pass is looked at once it connects
        Pos(simC, mnq, 1);
        Order late = Manual(simA, mnq, OrderAction.Sell, OrderType.Limit, 1, "", "typed late");
        simA.Connection.Status = ConnectionStatus.Disconnected;
        ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
        foreach (Account a in Account.All) ChartBridgeAccounts.SeenConnected(a);
        Tick();
        Check(!Cancelled(simA, late), "re-review 2: SIM-A not connected at the first pass: nothing yet");
        simA.Connection.Status = ConnectionStatus.Connected;
        Clear(); Tick();
        Check(Cancelled(simA, late) && Any("left from before ChartBridge started"), "re-review 2: once it connects, its after-start look runs");
        Flat();
    }

    // ------------------------------------------------------------ CON (a) (Anthony 2026-10-15): the consistency percent, informational
    static void Consistency()
    {
        Clear(); G("groupSave", Save(",\"group\":\"g1\"", "Review", "true", "0", "2000", "eod", "0", "50000", "0").Replace("}", ",\"consistency\":101}"));
        Check(Rejection().Contains("consistency must be a percent from 0 (none) to 100"), "CON: 101 percent refused");
        Clear(); G("groupSave", Save(",\"group\":\"g1\"", "Review", "true", "0", "2000", "eod", "0", "50000", "0").Replace("}", ",\"consistency\":40}"));
        Check(Rejection() == "" && FileText().Contains("group\tg1\tReview\ton\t-\t2000\teod\t-\t50000\t-\t40\t-\t-\n"), "CON: saved as the 11th field: " + FileText().Replace("\t", "<TAB>"));
        Check(Last("groups").Contains("\"lockAt\":null,\"consistency\":40,"), "CON: in the groups message");
        Check(State("SIM-A").Contains("\"lockAt\":0,\"consistency\":40,\"maxMinis\":0,\"maxMicros\":0}"), "CON: in accountState.rules (0 none): " + State("SIM-A"));
        G("accountLimits", "{\"type\":\"accountLimits\",\"cid\":\"l\",\"account\":\"SIM-D\",\"floor\":45000,\"dailyLoss\":0}");
        Check(State("SIM-D").Contains("\"rules\":{\"floor\":45000,\"dailyLoss\":0}") && !State("SIM-D").Contains("consistency"), "CON: personal rules never have it: " + State("SIM-D"));
        // a 0.5.8 group line written before consistency (10 fields) reads as none
        string p = Path.Combine(folder, "groups.txt");
        File.WriteAllText(p, ChartBridgeGroups.Header + "\n#\ngroup\tg1\tOld\ton\t-\t2000\teod\t-\t50000\t-\nmember\tSIM-A\tg1\n");
        ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
        Check(ChartBridgeGroups.GroupsJson().Contains("\"name\":\"Old\"") && ChartBridgeGroups.GroupsJson().Contains("\"consistency\":null"), "CON: a group line with 10 fields reads, consistency none");
        Clear(); G("groupSave", Save(",\"group\":\"g1\"", "Old", "true", "0", "2000", "eod", "0", "50000", "0"));
        Check(FileText().Contains("group\tg1\tOld\ton\t-\t2000\teod\t-\t50000\t-\t-\t-\t-\n"), "CON: groupSave without it: none (0.6.1: then type and hero, not set and none)");
    }

    // ------------------------------------------------------------ 0.6.1 (SPEC CE-1, Anthony 2026-10-15): a group's Type and default hero
    // Shown on the page only: ChartBridge checks the shapes (eval, funded or -; a build name of 1 to 64 safe characters or -) and
    // saves them as the 12th and 13th fields; it never knows which hero trades a group. Absent in a groupSave: kept as they are.
    static void TypeAndHero()
    {
        string p = Path.Combine(folder, "groups.txt");
        File.WriteAllText(p, ChartBridgeGroups.Header + "\n#\ngroup\tg1\tLucid\ton\t1000\t2000\teod\t3000\t50000\t-\t-\nmember\tSIM-A\tg1\n");   // 11 fields: written by 0.6.0
        ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
        string j0 = ChartBridgeGroups.GroupsJson();
        Check(j0.Contains("\"consistency\":null,\"accountType\":null,\"hero\":null,\"members\":[\"SIM-A\"]"), "TH: a 0.6.0 line (11 fields) reads as type not set and no hero: " + j0);
        string save = Save(",\"group\":\"g1\"", "Lucid", "true", "1000", "2000", "eod", "3000", "50000", "0");
        Clear(); G("groupSave", save.Replace("}", ",\"accountType\":\"funded\",\"hero\":\"sample-build-1\"}"));
        Check(Rejection() == "" && FileText().Contains("group\tg1\tLucid\ton\t1000\t2000\teod\t3000\t50000\t-\t-\tfunded\tsample-build-1\n"), "TH: saved as the 12th and 13th fields: " + FileText().Replace("\t", "<TAB>"));
        Check(Last("groups").Contains("\"consistency\":null,\"accountType\":\"funded\",\"hero\":\"sample-build-1\",\"members\":[\"SIM-A\"]"), "TH: in the groups message: " + Last("groups"));
        Check(Logged("type funded, hero sample-build-1"), "TH: the Output window says them");
        ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
        Check(ChartBridgeGroups.GroupsJson().Contains("\"accountType\":\"funded\",\"hero\":\"sample-build-1\""), "TH: round trip: read back after a start");
        Clear(); G("groupSave", save);
        Check(Rejection() == "" && FileText().Contains("\t-\t-\tfunded\tsample-build-1\n"), "TH: a save without them (an older page's, the No hedging switch) keeps them");
        Clear(); G("groupSave", save.Replace("}", ",\"accountType\":\"eval\"}"));
        Check(Rejection() == "" && FileText().Contains("\teval\tsample-build-1\n"), "TH: the type alone changes, the hero stays");
        string[][] bad = {
            new[] { ",\"accountType\":\"evals\"", "accountType must be eval, funded or - (not set)" },
            new[] { ",\"accountType\":1", "accountType must be eval, funded or - (not set)" },
            new[] { ",\"accountType\":null", "accountType must be eval, funded or - (not set)" },
            new[] { ",\"hero\":\"\"", "hero must be a build name" },
            new[] { ",\"hero\":\"two words\"", "hero must be a build name" },
            new[] { ",\"hero\":\"-lead\"", "hero must be a build name" },
            new[] { ",\"hero\":\"" + new string('a', 65) + "\"", "hero must be a build name" },
            new[] { ",\"hero\":\"a/b\"", "hero must be a build name" },
            new[] { ",\"hero\":7", "hero must be a build name" },
        };
        string before = FileText();
        foreach (string[] x in bad)
        {
            Clear(); G("groupSave", save.Replace("}", x[0] + "}"));
            Check(Rejection().Contains(x[1]) && Rejection().Contains("\"cid\":\"s\"") && FileText() == before, "TH: refused (" + x[0].Substring(1) + "): " + x[1] + ", nothing saved");
        }
        Clear(); G("groupSave", save.Replace("}", ",\"hero\":\"" + new string('b', 64) + "\"}"));
        Check(Rejection() == "" && FileText().Contains("\t" + new string('b', 64) + "\n"), "TH: a build name of 64 characters is taken");
        Clear(); G("groupSave", save.Replace("}", ",\"accountType\":\"-\",\"hero\":\"-\"}"));
        Check(Rejection() == "" && FileText().Contains("\t50000\t-\t-\t-\t-\n") && Last("groups").Contains("\"accountType\":null,\"hero\":null"), "TH: - and - clear them: not set and none");
        Clear(); G("groupSave", Save("", "Apex", "true", "0", "2500", "static", "0", "50000", "0").Replace("}", ",\"accountType\":\"eval\",\"hero\":\"sample.build_2\"}"));
        Check(Rejection() == "" && FileText().Contains("group\tg2\tApex\ton\t-\t2500\tstatic\t-\t50000\t-\t-\teval\tsample.build_2\n"), "TH: a new group with both: " + FileText().Replace("\t", "<TAB>"));
        Clear(); G("groupSave", Save("", "Topstep", "true", "0", "2000", "eod", "0", "50000", "0"));
        Check(Rejection() == "" && FileText().Contains("group\tg3\tTopstep\ton\t-\t2000\teod\t-\t50000\t-\t-\t-\t-\n"), "TH: a new group without them: not set and none");
        // a later ChartBridge's fields after the risk percent (0.6.5: the 14th field) are kept as read
        File.WriteAllText(p, ChartBridgeGroups.Header + "\n#\ngroup\tg1\tLucid\ton\t1000\t2000\teod\t3000\t50000\t-\t-\tfunded\tsample-build-1\t-\tlater\tmore\nmember\tSIM-A\tg1\n");
        ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
        Clear(); G("groupSave", save);
        Check(Rejection() == "" && FileText().Contains("\tfunded\tsample-build-1\t-\tlater\tmore\n"), "TH: fields after the risk percent (a later ChartBridge's) are kept: " + FileText().Replace("\t", "<TAB>"));
        // a type or hero ChartBridge cannot read makes the file unreadable (never rewritten), as every other field
        foreach (string broken in new[] { "\tfunded\tsample-build-1", "\tlive\t-", "\teval\ttwo words" })
        {
            string text = ChartBridgeGroups.Header + "\n#\ngroup\tg1\tLucid\ton\t1000\t2000\teod\t3000\t50000\t-\t-" + (broken == "\tfunded\tsample-build-1" ? "\tfunded\tsample build" : broken) + "\n";
            Corrupt(p, text);
            Clear(); ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
            Check(ChartBridgeGroups.GroupsJson().Contains("\"list\":[],\"error\":\"groups.txt could not be read") && ChartBridgeGroups.GroupsJson().Contains("is not a group line ("), "TH: a bad type or hero (" + text.Split('\n')[2].Replace("\t", " ") + "): unreadable, with why: " + ChartBridgeGroups.GroupsJson());
            Clear(); G("groupSave", save);
            Check(File.ReadAllText(p) == text, "TH: unreadable: never rewritten");
        }
        File.WriteAllText(p, ChartBridgeGroups.Header + "\n#\ngroup\tg1\tLucid\ton\t1000\t2000\teod\t3000\t50000\t-\t-\tfunded\tsample-build-1\nmember\tSIM-A\tg1\n");
        ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
        Flat();
        Check(ChartBridgeGroups.EntryCheck("page", simA, "MNQ", true, 1, true, false) == null && ChartBridgeGroups.GroupOf("SIM-A") == "g1", "TH: a type and a hero change nothing in the order path (an entry on a member passes as before)");
    }

    // ------------------------------------------------------------ an unreadable groups.txt: every entry refused, never rewritten
    static void Unreadable()
    {
        string p = Path.Combine(folder, "groups.txt"), was = File.ReadAllText(p);
        string[] broken = { "no header\n", ChartBridgeGroups.Header + "\n#\nmember\tSIM-A\tg5\n", ChartBridgeGroups.Header + "\n#\ngroup\tg1\tA\ton\t-\t2000\teod\t-\t50000\t-\ngroup\tg1\tB\ton\t-\t2000\teod\t-\t50000\t-\n", ChartBridgeGroups.Header + "\n#\nhero\tg1\n" };
        foreach (string text in broken)
        {
            Corrupt(p, text);
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
        Gone(p); Gone(Path.Combine(folder, "account-marks.txt"));
        ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs());
        Check(ChartBridgeGroups.GroupsJson() == "{\"type\":\"groups\",\"list\":[],\"error\":null}", "both files gone: no groups (0.5.7's behaviour)");
    }

    // ------------------------------------------------------------ 0.6.2: accountState.accountType (the group's Type, for a hero on one account)
    static void AccountTypeInState()
    {
        Flat();
        Clear(); G("groupSave", Save("", "Type Group", "true", "1000", "2000", "eod", "0", "50000", "0"));
        Match gm = Regex.Match(FileText(), "group\t(g[0-9]+)\tType Group\t");
        Check(gm.Success, "AT: a made-up group");
        if (!gm.Success) return;
        string gid = gm.Groups[1].Value;
        try
        {
            Clear(); G("accountGroup", Join("SIM-D", "\"" + gid + "\"", "50000"));
            Check(Rejection() == "" && State("SIM-D").Contains("\"kind\":\"prop\",\"group\":\"Type Group\",\"groupId\":\"" + gid + "\",\"groupSide\":null,\"noHedge\":true,\"accountType\":null,\"rules\":{"),
                  "AT: a prop account whose group has no Type: accountType null: " + State("SIM-D"));
            Func<string, string> typed = t => Save(",\"group\":\"" + gid + "\"", "Type Group", "true", "1000", "2000", "eod", "0", "50000", "0").TrimEnd('}') + ",\"accountType\":\"" + t + "\"}";
            Clear(); G("groupSave", typed("eval"));
            Check(Rejection() == "" && State("SIM-D").Contains("\"noHedge\":true,\"accountType\":\"eval\",\"rules\":{"), "AT: a prop account in an eval group: accountType eval");
            Clear(); G("groupSave", typed("funded"));
            Check(State("SIM-D").Contains("\"accountType\":\"funded\""), "AT: funded");
            Clear(); G("groupSave", typed("-"));
            Check(State("SIM-D").Contains("\"noHedge\":true,\"accountType\":null,\"rules\":{"), "AT: the Type cleared: null");
            Clear(); G("accountGroup", Join("SIM-D", "null", null));
            Check(State("SIM-D").Contains("\"kind\":\"personal\",\"group\":null,\"groupId\":null,\"groupSide\":null,\"noHedge\":null,\"accountType\":null,"), "AT: a personal account: accountType null (always present)");
            Check(State(ChartBridgeBranches.None).Contains("\"noHedge\":null,\"accountType\":null,\"rules\":null"), "AT: None: accountType null");
        }
        finally { Clear(); G("groupDelete", "{\"type\":\"groupDelete\",\"cid\":\"d\",\"group\":\"" + gid + "\"}"); }
    }

    // ------------------------------------------------------------ 0.6.2: stand-downs and groups (agent-standdowns.txt)
    static void StandDowns()
    {
        string sd = Path.Combine(folder, "agent-standdowns.txt");
        Clear(); G("groupSave", Save("", "Stand Group", "true", "0", "2000", "eod", "0", "50000", "0"));
        Match gm = Regex.Match(FileText(), "group\t(g[0-9]+)\tStand Group\t");
        Check(gm.Success, "SD: a made-up group to stand a hero down on");
        if (!gm.Success) return;
        string gid = gm.Groups[1].Value;
        try
        {
            File.WriteAllText(sd, "# made-up\n# test\nstandDown\tsample-build-1\t" + gid + "\t1791467200000\tedge watch\tmade-up: below the exam mean\nstandDown\tsample-build-2\t" + gid + "\t1791467200001\tblow streak\tmade-up: three blows\n");
            ChartBridgeAgents.ReadConfig("agents", "sdx");
            ChartBridgeAgents.Start(false);
            Check(ChartBridgeAgents.StandDownsOf(null).Count == 2 && (ChartBridgeAgents.StandDownRefusal("sample-build-1", gid) ?? "").Contains("build sample-build-1 stands down on group Stand Group (edge watch: made-up: below the exam mean)") &&
                  ChartBridgeAgents.StandDownRefusal("sample-build-1", null) == null && ChartBridgeAgents.StandDownRefusal("sample-build-3", gid) == null, "SD: read at the start; only that build on that group is refused");
            int d = Submits(simD);
            Clear(); O(Order("SIM-D", "MNQ", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
            Check(Submits(simD) == d + 1, "SD: a page order is never gated by a stand-down (agent entries only): " + Rejection());
            Flat();
            Clear(); G("groupDelete", "{\"type\":\"groupDelete\",\"cid\":\"d\",\"group\":\"" + gid + "\"}");
            Check(Rejection() == "" && ChartBridgeAgents.StandDownsOf(null).Count == 0 && !File.ReadAllText(sd).Contains("standDown\t") && Any("{\"type\":\"agentStandDowns\",\"list\":[],\"error\":null}"),
                  "SD: the group deleted: both its stand-downs dropped at once (memory, the file, the pages)");
            // unreadable: every agent entry refused (any group or none); the page's own orders and exits are not touched
            Corrupt(sd, "# made-up\n# test\nstandDown\tbad line\n");
            ChartBridgeAgents.Start(false);
            string why = ChartBridgeAgents.StandDownsBroken();
            Check(why != null && why.Contains("agent-standdowns.txt has a line ChartBridge does not understand: every new agent entry on an account in a prop group is refused") && ChartBridgeAgents.BrokenRefusal("SIM-D") == null,
                  "SD: unreadable: an account in no group is not refused by it (Anthony 2026-10-16): " + why);
            d = Submits(simD);
            Clear(); O(Order("SIM-D", "MNQ", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
            Check(Submits(simD) == d + 1, "SD: unreadable: a page order still goes (the file gates agent entries only)");
            Flat();
            // 0.6.3 (review MED 3): with a good .bak it is still unreadable (never the copy on its own); the alarm says what the copy holds
            File.WriteAllText(sd + ".bak", "# made-up\n# test\nstandDown\tsample-build-1\t" + gid + "\t1791467200000\tedge watch\tmade-up: below the exam mean\n");
            ChartBridgeAgents.Start(false);
            why = ChartBridgeAgents.StandDownsBroken();
            Check(why != null && why.Contains("(its last good copy, agent-standdowns.txt.bak, holds 1 stand-down (build sample-build-1 on group ") && why.Contains("to use it, copy agent-standdowns.txt.bak over agent-standdowns.txt and restart ChartBridge)") &&
                  ChartBridgeAgents.StandDownsOf(null).Count == 0, "0.6.3 MED 3: agent-standdowns.txt unreadable with a good .bak: refused as unreadable, the alarm names the copy: " + why);
            try { Gone(sd + ".bak"); } catch (Exception) { }
        }
        finally
        {
            ChartBridgeAgents.Stop(); ChartBridgeAgents.ResetConfig();
            try { Gone(sd); } catch (Exception) { }
            Clear(); G("groupDelete", "{\"type\":\"groupDelete\",\"cid\":\"d\",\"group\":\"" + gid + "\"}");
        }
    }
    // ------------------------------------------------------------ 0.6.5 (Anthony 2026-10-19, PRIORITY): mixed accounts in one group
    static string JoinRules(string account, string group, string high, string rules) { return "{\"type\":\"accountGroup\",\"cid\":\"j\",\"account\":\"" + account + "\",\"group\":" + group + (high != null ? ",\"highClose\":" + high : "") + rules + "}"; }
    static string R(string size, string dl, string dd, string type, string lk, string tg, string extra) { return ",\"size\":" + size + ",\"dailyLoss\":" + dl + ",\"drawdown\":" + dd + ",\"drawdownType\":\"" + type + "\",\"lockAt\":" + lk + ",\"target\":" + tg + extra; }
    static string MR(string account, string rules) { return "{\"type\":\"memberRules\",\"cid\":\"r\",\"account\":\"" + account + "\"" + rules + "}"; }
    static void MemberRules()
    {
        Flat();
        ChartBridgeGroups.GapMs = 1e12;
        ClockEt(2026, 10, 20, 10, 0);
        string p = Path.Combine(folder, "groups.txt"), mp = Path.Combine(folder, "account-marks.txt");
        Gone(p); Gone(mp);
        // migration: a file as 0.6.4 wrote it (13 fields, no rules lines) loads and behaves exactly as before
        string old = ChartBridgeGroups.Header + "\n# group...\ngroup\tg1\tLucid\ton\t1000\t2000\teod\t3000\t50000\t50100\t-\teval\t-\nmember\tSIM-A\tg1\nmember\tSIM-B\tg1\n";
        File.WriteAllText(p, old);
        Restart();
        Money(simA, 50500, 0, 0); Money(simB, 50000, 0, 0);
        Clear(); G("accountGroup", Join("SIM-A", "null", null)); G("accountGroup", Join("SIM-A", "\"g1\"", "51000"));
        string e = Entry(AccountsNow(), "SIM-A"), full = AccountsNow();
        Check(e.Contains("\"floor\":49000,\"roomFloor\":1500,") && full.Contains("\"rules\":{\"size\":50000,\"dailyLoss\":1000,\"drawdown\":2000,\"drawdownType\":\"eod\",\"lockAt\":50100,\"target\":3000,\"consistency\":null,\"maxMinis\":null,\"maxMicros\":null,\"typeId\":null,\"own\":false}"),
              "0.6.5 migration: a 0.6.4 file's member inherits the group's rules (floor 51000-2000, rules own false): " + e);
        Check(FileText() == old.Replace("# group...", ChartBridgeGroups.Header2) || FileText().Replace(ChartBridgeGroups.Header2, "# group...") == old, "0.6.5 migration: saved again, the file is byte for byte what 0.6.4 writes (no rules line, 13 fields): " + FileText().Replace("\t", "<TAB>"));
        Check(State("SIM-A").Contains("\"rules\":{\"dailyLoss\":1000,\"drawdown\":2000,\"drawdownType\":\"eod\",\"target\":3000,\"size\":50000,\"lockAt\":50100,\"consistency\":0,\"maxMinis\":0,\"maxMicros\":0}"), "0.6.5 migration: accountState's rules as before: " + State("SIM-A"));
        Check(ChartBridgeGroups.GroupsJson().Contains("\"riskPct\":null,\"ownRules\":[]}"), "0.6.5 migration: risk off, no member with rules of its own");
        // the refusals: all or none, with joining only, the same checks as groupSave's
        string[][] bad = {
            new[] { JoinRules("SIM-C", "\"g1\"", null, ",\"size\":150000"), "dailyLoss is needed" },
            new[] { JoinRules("SIM-C", "\"g1\"", null, ",\"size\":150000,\"dailyLoss\":0,\"drawdown\":4500,\"lockAt\":0,\"target\":0"), "drawdownType is needed" },
            new[] { JoinRules("SIM-C", "\"g1\"", null, R("150000", "0", "150000", "eod", "0", "0", "")), "less than the account size" },
            new[] { JoinRules("SIM-C", "\"g1\"", null, R("150000", "0", "4500", "static", "150100", "0", "")), "trailing drawdown only" },
            new[] { JoinRules("SIM-C", "\"g1\"", null, R("150000", "0", "4500", "eod", "145000", "0", "")), "above the starting floor (145500)" },
            new[] { JoinRules("SIM-C", "\"g1\"", null, R("150000", "0", "4500", "daily", "0", "0", "")), "drawdownType must be eod, intraday or static" },
            new[] { JoinRules("SIM-C", "\"g1\"", null, R("150000", "0", "4500", "eod", "0", "0", ",\"maxMinis\":1001")), "maxMinis must be a whole number of contracts from 0 (none) to 1000" },
            new[] { JoinRules("SIM-C", "\"g1\"", null, R("150000", "0", "4500", "eod", "0", "0", ",\"maxMicros\":2.5")), "maxMicros must be a whole number" },
            new[] { JoinRules("SIM-C", "\"g1\"", null, R("150000", "0", "4500", "eod", "0", "0", ",\"typeId\":\"two words\"")), "typeId must be The Desk's account type id" },
            new[] { JoinRules("SIM-C", "\"g1\"", null, R("150000", "0", "4500", "eod", "0", "0", ",\"consistency\":101")), "consistency must be a percent" },
            new[] { JoinRules("SIM-C", "null", null, R("150000", "0", "4500", "eod", "0", "0", "")), "rules go with joining a group only" },
            new[] { MR("SIM-C", R("150000", "0", "4500", "eod", "0", "0", "")), "SIM-C is in no group" },
            new[] { MR("SIM-A", ""), "size is needed" },
            new[] { MR("SIM-A", R("150000", "0", "4500", "eod", "0", "0", ",\"color\":1")), "unknown key" },
        };
        string before = FileText();
        foreach (string[] x in bad)
        {
            Clear(); G(x[0].Contains("memberRules") ? "memberRules" : "accountGroup", x[0]);
            Check(Rejection().Contains(x[1]) && FileText() == before && ChartBridgeGroups.GroupOf("SIM-C") == null, "0.6.5 refused (" + x[1] + "), nothing saved: " + Rejection());
        }
        // Anthony's three Lucid accounts in one group: a 150K Flex eval, a 50K Flex eval, a 25K Daily intraday eval (made-up money)
        Money(simA, 150500, 0, 0); Money(simB, 50500, 0, 0); Money(simC, 25000, 0, 0);
        Clear(); G("accountGroup", Join("SIM-A", "null", null)); G("accountGroup", Join("SIM-B", "null", null));
        Clear(); G("accountGroup", JoinRules("SIM-A", "\"g1\"", "151000", R("150000", "0", "4500", "eod", "150100", "9000", ",\"consistency\":50,\"maxMinis\":10,\"maxMicros\":100,\"typeId\":\"lucid-flex-150k-eval\"")));
        Clear(); G("accountGroup", JoinRules("SIM-B", "\"g1\"", "51000", R("50000", "0", "2000", "eod", "50100", "3000", ",\"consistency\":50,\"maxMinis\":4,\"maxMicros\":40,\"typeId\":\"lucid-flex-50k-eval\"")));
        Clear(); G("accountGroup", JoinRules("SIM-C", "\"g1\"", null, R("25000", "500", "1000", "intraday", "25100", "1250", ",\"maxMinis\":2,\"maxMicros\":20,\"typeId\":\"lucid-daily-25k-eval\"")));
        Check(Rejection() == "" && ChartBridgeGroups.GroupOf("SIM-C") == "g1" && Logged("SIM-C joined Lucid with its own rules (size $25,000, daily loss $500, drawdown $1,000 intraday (floor stops at $25,100), target $1,250, consistency none, max 2 minis / 20 micros, type lucid-daily-25k-eval)"),
              "0.6.5: three accounts of three types join one group, each with its own rules, logged");
        Check(FileText().Contains("rules\tSIM-A\t150000\t-\t4500\teod\t150100\t9000\t50\t10\t100\tlucid-flex-150k-eval\n") && FileText().Contains("rules\tSIM-B\t50000\t-\t2000\teod\t50100\t3000\t50\t4\t40\tlucid-flex-50k-eval\n") &&
              FileText().Contains("rules\tSIM-C\t25000\t500\t1000\tintraday\t25100\t1250\t-\t2\t20\tlucid-daily-25k-eval\n"), "0.6.5: one rules line per member in groups.txt: " + FileText().Replace("\t", "<TAB>"));
        Check(MarksText().Contains("mark\tSIM-C\t25000\t25000\t"), "0.6.5: no highest close given: the larger of its OWN size (25000) and its balance, not the group's 50000: " + MarksText().Replace("\t", "<TAB>"));
        string a = Entry(AccountsNow(), "SIM-A"), b = Entry(AccountsNow(), "SIM-B"), c = Entry(AccountsNow(), "SIM-C");
        Check(a.Contains("\"floor\":146500,\"roomFloor\":4000,\"roomDaily\":null,\"targetLeft\":8500"), "0.6.5 mixed: SIM-A (150K, eod 4500): floor 151000-4500 = 146500, room 4000, no daily loss, target 159000-150500: " + a);
        Check(a.Contains("\"roomDaily\":\"SIM-A's rules in Lucid have no daily loss limit\""), "0.6.5 mixed: the why names the member's own rules: " + a);
        Check(b.Contains("\"floor\":49000,\"roomFloor\":1500,\"roomDaily\":null,\"targetLeft\":2500"), "0.6.5 mixed: SIM-B (50K, eod 2000): floor 49000, its own target: " + b);
        Check(c.Contains("\"floor\":24000,\"roomFloor\":1000,\"roomDaily\":500,\"targetLeft\":1250"), "0.6.5 mixed: SIM-C (25K, intraday 1000, daily 500): floor 24000, daily room 500: " + c);
        Check(AccountsNow().Contains("\"rules\":{\"size\":25000,\"dailyLoss\":500,\"drawdown\":1000,\"drawdownType\":\"intraday\",\"lockAt\":25100,\"target\":1250,\"consistency\":null,\"maxMinis\":2,\"maxMicros\":20,\"typeId\":\"lucid-daily-25k-eval\",\"own\":true}"), "0.6.5: the accounts message carries each member's rules (own true)");
        Check(ChartBridgeGroups.GroupsJson().Contains("\"riskPct\":null,\"ownRules\":[\"SIM-A\",\"SIM-B\",\"SIM-C\"]}"), "0.6.5: the groups message names the members with rules of their own");
        Check(State("SIM-A").Contains("\"rules\":{\"dailyLoss\":0,\"drawdown\":4500,\"drawdownType\":\"eod\",\"target\":9000,\"size\":150000,\"lockAt\":150100,\"consistency\":50,\"maxMinis\":10,\"maxMicros\":100}") &&
              State("SIM-C").Contains("\"rules\":{\"dailyLoss\":500,\"drawdown\":1000,\"drawdownType\":\"intraday\",\"target\":1250,\"size\":25000,\"lockAt\":25100,\"consistency\":0,\"maxMinis\":2,\"maxMicros\":20}"), "0.6.5: each agent's accountState carries its member's own rules (the same seven keys): " + State("SIM-A"));
        // each floor trails from its own high and stops at its own lock
        Money(simC, 25000, 700, 200); Tick();
        Check(Entry(AccountsNow(), "SIM-C").Contains("\"floor\":24700,"), "0.6.5 intraday: SIM-C's high follows its equity (25700): floor 24700");
        Money(simC, 25000, 1200, 200); Tick();
        Check(Entry(AccountsNow(), "SIM-C").Contains("\"floor\":25100,"), "0.6.5 intraday: 26200-1000 = 25200 stops at its own lock 25100");
        Money(simC, 25000, -300, 200); Tick();
        e = Entry(AccountsNow(), "SIM-C");
        Check(e.Contains("\"floor\":25100,\"roomFloor\":-400,") , "0.6.5 intraday: equity down, the floor stays at its lock (room 24700-25100): " + e);
        Check(Entry(AccountsNow(), "SIM-A").Contains("\"floor\":146500,") && Entry(AccountsNow(), "SIM-B").Contains("\"floor\":49000,"), "0.6.5: SIM-C's intraday high moves only SIM-C's floor (the eod members do not trail intraday)");
        ClockEt(2026, 10, 20, 17, 10);
        Money(simA, 156000, 0, 0); Money(simB, 52000, 0, 0);
        ChartBridgeGroups.EodMark();
        a = Entry(AccountsNow(), "SIM-A"); b = Entry(AccountsNow(), "SIM-B");
        Check(a.Contains("\"floor\":150100,") && b.Contains("\"floor\":50000,"), "0.6.5 eod: at the close SIM-A 156000-4500 = 151500 stops at its lock 150100; SIM-B 52000-2000 = 50000 (below its lock 50100): " + a + " | " + b);
        Money(simB, 53000, 0, 0); ChartBridgeGroups.EodMark();
        Check(Entry(AccountsNow(), "SIM-B").Contains("\"floor\":50100,"), "0.6.5 eod: SIM-B 53000-2000 = 51000 stops at its own lock 50100");
        ClockEt(2026, 10, 21, 10, 0);
        // a restart reads the rules lines back
        string f1 = FileText();
        Restart(); Tick();
        Check(Entry(AccountsNow(), "SIM-A").Contains("\"floor\":150100,") && Entry(AccountsNow(), "SIM-C").Contains("\"floor\":25100,") && AccountsNow().Contains("\"typeId\":\"lucid-flex-150k-eval\",\"own\":true"), "0.6.5: after a restart, every member's own rules and floor as before");
        Clear(); G("groupSave", Save(",\"group\":\"g1\"", "Lucid", "true", "1000", "2000", "eod", "3000", "50000", "50100").Replace("}", ",\"accountType\":\"eval\"}"));
        Check(FileText() == f1, "0.6.5: a group save with the same values writes the same file (the members' rules untouched)");
        // a member's rules edited later: its highs stay, the new rules apply from now
        Clear(); G("memberRules", MR("SIM-B", R("50000", "1000", "2500", "eod", "0", "3000", ",\"maxMinis\":4,\"maxMicros\":40")));
        b = Entry(AccountsNow(), "SIM-B");
        Check(Rejection() == "" && b.Contains("\"floor\":50500,") && FileText().Contains("rules\tSIM-B\t50000\t1000\t2500\teod\t-\t3000\t-\t4\t40\t-\n") && MarksText().Contains("mark\tSIM-B\t53000\t"),
              "0.6.5 memberRules: SIM-B's drawdown 2500 and no lock: floor 53000-2500 = 50500, its high kept: " + b);
        Check(Logged("SIM-B's own rules in Lucid: size $50,000, daily loss $1,000, drawdown $2,500 eod"), "0.6.5 memberRules: logged");
        Check(Entry(AccountsNow(), "SIM-A").Contains("\"floor\":150100,"), "0.6.5 memberRules: the other members unchanged");
        // the group's rules change: a member with its own keeps them
        Clear(); G("groupSave", Save(",\"group\":\"g1\"", "Lucid", "true", "500", "3000", "static", "0", "60000", "0"));
        Check(Entry(AccountsNow(), "SIM-A").Contains("\"floor\":150100,") && Entry(AccountsNow(), "SIM-C").Contains("\"floor\":25100,"), "0.6.5: the group's own rules changed: members with their own keep them");
        // leaving drops its rules; joining again without rules (a page before 1.33.0): the group's rules, as 0.6.4
        Clear(); G("accountGroup", Join("SIM-C", "null", null));
        Check(!FileText().Contains("rules\tSIM-C") && AccountsNow().Contains("\"rules\":null"), "0.6.5: leaving the group drops its rules line");
        Clear(); G("accountGroup", Join("SIM-C", "\"g1\"", null));
        c = Entry(AccountsNow(), "SIM-C");
        Check(!FileText().Contains("rules\tSIM-C") && c.Contains("\"floor\":57000,") && Logged("SIM-C joined Lucid with the group's rules"), "0.6.5: joined with no rules: the group's (static 60000-3000): " + c);
        Clear(); G("accountGroup", Join("SIM-A", "\"g1\"", null));
        Check(Rejection().Contains("SIM-A is in Lucid already") && FileText().Contains("rules\tSIM-A\t"), "0.6.5: joining the group it is in again: refused, its rules kept");
        // the risk percent: stored and shown, nothing in the order path reads it
        Clear(); G("groupSave", Save(",\"group\":\"g1\"", "Lucid", "true", "500", "3000", "static", "0", "60000", "0").Replace("}", ",\"riskPct\":101}"));
        Check(Rejection().Contains("riskPct must be a percent of each member's max loss from 0 (off) to 100"), "0.6.5 risk: above 100 refused");
        Clear(); G("groupSave", Save(",\"group\":\"g1\"", "Lucid", "true", "500", "3000", "static", "0", "60000", "0").Replace("}", ",\"riskPct\":10}"));
        Check(Rejection() == "" && FileText().Contains("\teval\t-\t10\n") && ChartBridgeGroups.GroupsJson().Contains("\"riskPct\":10,\"ownRules\":[\"SIM-A\",\"SIM-B\"]}") && Logged("risk 10% of each member's max loss"), "0.6.5 risk: 10 saved as the 14th field, in the groups message: " + FileText().Replace("\t", "<TAB>"));
        Clear(); G("groupSave", Save(",\"group\":\"g1\"", "Lucid", "true", "500", "3000", "static", "0", "60000", "0"));
        Check(FileText().Contains("\teval\t-\t10\n"), "0.6.5 risk: a save without it (a page before 1.33.0) keeps it");
        Flat();
        Check(ChartBridgeGroups.EntryCheck("page", simA, "MNQ", true, 1, true, false) == null, "0.6.5 risk: nothing in the order path reads it (an entry on a member passes as before)");
        Clear(); G("groupSave", Save(",\"group\":\"g1\"", "Lucid", "true", "500", "3000", "static", "0", "60000", "0").Replace("}", ",\"riskPct\":0}"));
        Check(FileText().Contains("\teval\t-\n") && ChartBridgeGroups.GroupsJson().Contains("\"riskPct\":null"), "0.6.5 risk: 0 is off, and the line is 13 fields again (as 0.6.4 writes it)");
        // a rules line ChartBridge cannot read, or for an account in no group: the whole file unreadable, never rewritten
        foreach (string[] broken in new[] {
            new[] { "rules\tSIM-D\t50000\t-\t2000\teod\t-\t-\t-\t-\t-\t-\n", "gives rules to an account in no group" },
            new[] { "rules\tSIM-A\t50000\t-\t50000\teod\t-\t-\t-\t-\t-\t-\n", "is not a rules line" },
            new[] { "rules\tSIM-A\t50000\t-\t2000\tdaily\t-\t-\t-\t-\t-\t-\n", "is not a rules line" },
            new[] { "rules\tSIM-A\t50000\t-\t2000\teod\t-\t-\t-\t-\t-\n", "is not a rules line" },
            new[] { "rules\tSIM-A\t50000\t-\t2000\teod\t-\t-\t-\t-\t-\t-\nrules\tSIM-A\t50000\t-\t2000\teod\t-\t-\t-\t-\t-\t-\n", "gives an account rules twice" } })
        {
            string text = ChartBridgeGroups.Header + "\n#\ngroup\tg1\tLucid\ton\t1000\t2000\teod\t3000\t50000\t-\t-\t-\t-\nmember\tSIM-A\tg1\n" + broken[0];
            Corrupt(p, text);
            Clear(); Restart();
            Check(ChartBridgeGroups.GroupsJson().Contains("\"list\":[],\"error\":\"groups.txt could not be read") && ChartBridgeGroups.GroupsJson().Contains(broken[1]) &&
                  ChartBridgeGroups.EntryCheck("page", simA, "MNQ", true, 1, true, false) == ChartBridgeGroups.ReadFailedText && Entry(AccountsNow(), "SIM-A").Contains("\"floor\":null,"), "0.6.5: " + broken[1] + ": unreadable, every entry refused, no floor: " + ChartBridgeGroups.GroupsJson());
            Clear(); G("memberRules", MR("SIM-A", R("50000", "0", "2000", "eod", "0", "0", "")));
            Check(File.ReadAllText(p) == text, "0.6.5: unreadable: never rewritten");
        }
        // a ChartBridge before 0.6.5 never misreads the new file: it knows group, member and personal lines only, so a rules line makes
        // it read the whole file as unreadable (every entry refused, an alarm, never rewritten): the same as any line it does not know
        Corrupt(p, ChartBridgeGroups.Header + "\n#\ngroup\tg1\tLucid\ton\t1000\t2000\teod\t3000\t50000\t-\t-\t-\t-\nmember\tSIM-A\tg1\nweird\tline\n");
        Restart();
        Check(ChartBridgeGroups.GroupsJson().Contains("is not a group, member, rules or personal line"), "0.6.5: a line ChartBridge does not know: unreadable, as in every version");
        // deleting the group drops its members' rules
        File.WriteAllText(p, f1); Restart();
        Clear(); G("groupDelete", "{\"type\":\"groupDelete\",\"cid\":\"d\",\"group\":\"g1\"}");
        Check(Rejection() == "" && !FileText().Contains("rules\t"), "0.6.5: groupDelete drops its members' rules lines");
        ChartBridgeGroups.GapMs = 10000;
        ClockEt(2026, 10, 14, 10, 0);
    }

    // ------------------------------------------------------------ 0.6.5 (Anthony 2026-10-19): trade the group from the ticket
    static void GP(string type, string json) { lock (page.Actions) page.Actions.Clear(); ChartBridgeOrders.OnMessage(page, type, json); }
    static string GE(string type, string side, string kind, string bracket, string extra) { return "{\"type\":\"" + type + "\",\"cid\":\"ge\",\"group\":\"g1\",\"root\":\"NQ\",\"side\":\"" + side + "\",\"kind\":\"" + kind + "\"" + (bracket != null ? ",\"bracket\":" + bracket : "") + extra + "}"; }
    static string Seat(string json, string account) { Match m = Regex.Match(json, "\\{\"account\":\"" + Regex.Escape(account) + "\",\"size\":[0-9]+,\"risk\":[0-9.]+,\"budget\":[0-9.]+,\"out\":(?:null|\"[^\"]*\")\\}"); return m.Success ? m.Value : "(none) " + json; }
    static void GroupEntries()
    {
        Flat();
        ChartBridgeGroups.GapMs = 1e12;
        Func<int> All = () => Submits(simA) + Submits(simB) + Submits(simC) + Submits(simD);
        int s0 = All(), a0 = Submits(simA), b0 = Submits(simB), c0 = Submits(simC), d0 = Submits(simD);
        string p = Path.Combine(folder, "groups.txt"), mp = Path.Combine(folder, "account-marks.txt");
        Gone(p); Gone(mp);
        File.WriteAllText(p, ChartBridgeGroups.Header + "\n#\ngroup\tg1\tLucid\ton\t-\t2000\teod\t3000\t50000\t-\t-\teval\t-\t10\n");
        ClockEt(2026, 10, 20, 9, 0); Restart();
        foreach (Account a in new[] { simA, simB, simC, simD }) a.Connection.Status = ConnectionStatus.Connected;
        ClockEt(2026, 10, 19, 18, 1);
        Money(simA, 150500, 0, 0); Money(simB, 50500, 0, 0); Money(simC, 25000, 0, 0); Money(simD, 50000, 0, 0);
        Clear(); G("accountGroup", JoinRules("SIM-A", "\"g1\"", "151000", R("150000", "0", "4500", "eod", "150100", "9000", ",\"maxMinis\":10,\"maxMicros\":100")));
        G("accountGroup", JoinRules("SIM-B", "\"g1\"", "51000", R("50000", "0", "2000", "eod", "50100", "3000", ",\"maxMinis\":4,\"maxMicros\":40")));
        G("accountGroup", JoinRules("SIM-C", "\"g1\"", null, R("25000", "500", "1000", "intraday", "25100", "1250", ",\"maxMinis\":2,\"maxMicros\":20")));
        G("accountGroup", Join("SIM-D", "\"g1\"", null));
        Tick();   // the session's day start at 18:01 ET (on time: the computed P&L counts)
        ClockEt(2026, 10, 20, 10, 0); Tick();
        Check(Rejection() == "" && ChartBridgeGroups.GroupOf("SIM-D") == "g1", "GE setup: Lucid (risk 10%) with SIM-A 150K, SIM-B 50K, SIM-C 25K intraday (each its own rules) and SIM-D (the group's rules)");
        // the preview: NQ, a 20 tick stop: $100 a contract
        Clear(); GP("groupPreview", GE("groupPreview", "buy", "market", "{\"stop\":20,\"target\":40}", ""));
        string pv = Last("groupPreview");
        Check(pv.StartsWith("{\"type\":\"groupPreview\",\"cid\":\"ge\",\"group\":\"g1\",\"name\":\"Lucid\",\"root\":\"NQ\",\"side\":\"buy\",\"kind\":\"market\",\"stopTicks\":20,\"riskPct\":10,\"members\":["), "GE preview: the group, the stop and the risk: " + pv);
        Check(Seat(pv, "SIM-A") == "{\"account\":\"SIM-A\",\"size\":4,\"risk\":400,\"budget\":450,\"out\":null}" && Seat(pv, "SIM-B") == "{\"account\":\"SIM-B\",\"size\":2,\"risk\":200,\"budget\":200,\"out\":null}" &&
              Seat(pv, "SIM-C") == "{\"account\":\"SIM-C\",\"size\":1,\"risk\":100,\"budget\":100,\"out\":null}" && Seat(pv, "SIM-D") == "{\"account\":\"SIM-D\",\"size\":2,\"risk\":200,\"budget\":200,\"out\":null}",
              "GE sizes: 10% of each max loss ($450, $200, $100, $200) / $100 a contract = 4, 2, 1, 2 (SIM-D on the group's $2,000): " + pv);
        Check(All() == s0, "GE preview: nothing is placed");
        // the guards: the cap (maxQty.NQ 9) and the max size (SIM-C 2 minis) at a 4 tick stop ($20 a contract)
        Clear(); GP("groupPreview", GE("groupPreview", "buy", "market", "{\"stop\":4,\"target\":8}", ""));
        pv = Last("groupPreview");
        Check(Seat(pv, "SIM-A").Contains("\"size\":9,\"risk\":180,") && Seat(pv, "SIM-C").Contains("\"size\":2,\"risk\":40,") && Seat(pv, "SIM-B").Contains("\"size\":4,"),
              "GE guards: SIM-A 450/20 = 22, its max 10 minis, then the cap of 9 (maxQty.NQ, the hard ceiling); SIM-C 5, its max 2 minis; SIM-B 10, its max 4: " + pv);
        // rounds to 0: a 50 tick stop ($250 a contract) is more than SIM-B's $200
        Clear(); GP("groupPreview", GE("groupPreview", "buy", "market", "{\"stop\":50,\"target\":0}", ""));
        pv = Last("groupPreview");
        Check(Seat(pv, "SIM-B") == "{\"account\":\"SIM-B\",\"size\":0,\"risk\":0,\"budget\":200,\"out\":\"its risk $200 (10% of its max loss $2,000) is less than one contract's stop ($250 at 50 ticks)\"}" && Seat(pv, "SIM-A").Contains("\"size\":1,"),
              "GE rounds to 0: SIM-B sits out and says why; SIM-A 450/250 = 1: " + pv);
        // the room caps: SIM-B's room to its floor 150 (equity 49150, floor 49000), SIM-C's daily room 80 (lost 420 of 500)
        Money(simB, 49150, 0, 0); Money(simC, 24580, 0, 0); Tick();
        Clear(); GP("groupPreview", GE("groupPreview", "buy", "market", "{\"stop\":20,\"target\":40}", ""));
        pv = Last("groupPreview");
        Check(Seat(pv, "SIM-B").Contains("\"size\":1,\"risk\":100,") , "GE room cap: SIM-B $200 would be 2, its room to the floor $150 holds it to 1: " + Seat(pv, "SIM-B"));
        Check(Seat(pv, "SIM-C").Contains("\"size\":0,") && Seat(pv, "SIM-C").Contains("its daily room $80 is less than one contract's stop ($100)"), "GE daily room: SIM-C sits out, its daily room $80: " + Seat(pv, "SIM-C"));
        // a room not known: SIM-D not connected
        simD.Connection.Status = ConnectionStatus.Disconnected;
        Clear(); GP("groupPreview", GE("groupPreview", "buy", "market", "{\"stop\":20,\"target\":40}", ""));
        pv = Last("groupPreview");
        Check(Seat(pv, "SIM-D").Contains("\"size\":0,") && Seat(pv, "SIM-D").Contains("its room to the floor is not known (the account is not connected)"), "GE room not known: SIM-D sits out and says why: " + Seat(pv, "SIM-D"));
        simD.Connection.Status = ConnectionStatus.Connected;
        Money(simB, 50500, 0, 0); Money(simC, 25000, 0, 0); Tick();
        // refusals: no stop, no bracket, risk off, a bad sizes list
        foreach (string[] x in new[] {
            new[] { GE("groupPreview", "buy", "market", "{\"stop\":0,\"target\":40}", ""), "a group entry needs a stop: each member is sized from its stop loss (set the bracket's stop)" },
            new[] { GE("groupPreview", "buy", "market", null, ""), "a group entry needs a stop" },
            new[] { GE("groupOrder", "buy", "market", null, ",\"sizes\":\"4,2,1,2\""), "a group entry needs a stop" },
            new[] { GE("groupPreview", "buy", "market", "{\"stop\":20,\"target\":40}", ",\"qty\":3"), "unknown key \\\"qty\\\"" },
            new[] { GE("groupOrder", "buy", "market", "{\"stop\":20,\"target\":40}", ",\"sizes\":\"4,2\""), "the group's accounts changed since the preview (4 now, 2 confirmed)" },
            new[] { GE("groupOrder", "buy", "market", "{\"stop\":20,\"target\":40}", ",\"sizes\":\"5,2,1,2\""), "the sizes changed since the preview (SIM-A 5 confirmed, 4 now): nothing was sent" },
            new[] { GE("groupOrder", "buy", "market", "{\"stop\":20,\"target\":40}", ",\"sizes\":\"four\""), "sizes must be the sizes confirmed" } })
        {
            Clear(); GP(x[0].Contains("groupOrder") ? "groupOrder" : "groupPreview", x[0]);
            Check(Rejection().Contains(x[1]) && All() == s0, "GE refused, nothing placed: " + x[1] + " (" + Rejection() + ")");
        }
        // the entry: the sizes confirmed, one entry with its bracket on each member
        Clear(); GP("groupOrder", GE("groupOrder", "buy", "market", "{\"stop\":20,\"target\":40}", ",\"sizes\":\"4,2,1,2\""));
        string gp = Last("groupPlaced");
        Func<Account, Order> last = a => a.Orders.LastOrDefault();
        Check(Rejection() == "" && gp.Contains("\"placed\":4,") && Submits(simA) == a0 + 1 && Submits(simB) == b0 + 1 && Submits(simC) == c0 + 1 && Submits(simD) == d0 + 1 &&
              last(simA).Quantity == 4 && last(simB).Quantity == 2 && last(simC).Quantity == 1 && last(simD).Quantity == 2 && last(simA).Name.EndsWith(" s20 t40") && last(simA).OrderType == OrderType.Market && last(simA).Instrument == nq,
              "GE placed: NQ market 4, 2, 1, 2, each with its own bracket (s20 t40): " + gp);
        Check(Logged("group entry on Lucid: buy NQ market, stop 20 ticks, risk 10%: SIM-A 4 ($400); SIM-B 2 ($200); SIM-C 1 ($100); SIM-D 2 ($200)"), "GE: the Output window says each member's size and risk");
        s0 = All();
        // an add: sized the same way from the add's own stop, what each holds counted against its max size and the cap
        Flat();
        Pos(simA, nq, 4); Pos(simB, nq, 2);
        Clear(); GP("groupPreview", GE("groupPreview", "buy", "limit", "{\"stop\":4,\"target\":8}", ",\"price\":24990"));
        pv = Last("groupPreview");
        Check(Seat(pv, "SIM-A").Contains("\"size\":5,") && Seat(pv, "SIM-B").Contains("\"size\":2,"), "GE add: SIM-A long 4: its max 10 less 4 = 6, the cap 9 less 4 = 5; SIM-B long 2: its max 4 less 2 = 2: " + pv);
        Pos(simB, nq, 4);
        Clear(); GP("groupPreview", GE("groupPreview", "buy", "limit", "{\"stop\":4,\"target\":8}", ",\"price\":24990"));
        Check(Seat(Last("groupPreview"), "SIM-B").Contains("it is at its max size (4 minis; it holds or has working 4)"), "GE add: SIM-B at its max size sits out: " + Seat(Last("groupPreview"), "SIM-B"));
        // a member another lane trades sits out: the copier's leader
        Flat();
        // the group's risk off: refused whole
        Clear(); G("groupSave", Save(",\"group\":\"g1\"", "Lucid", "true", "0", "2000", "eod", "3000", "50000", "0").Replace("}", ",\"riskPct\":0}"));
        Clear(); GP("groupPreview", GE("groupPreview", "buy", "market", "{\"stop\":20,\"target\":40}", ""));
        Check(Rejection().Contains("group Lucid has no risk percent: set Risk % of max loss in Settings, Account groups"), "GE: risk off, refused: " + Rejection());
        // the one-direction check holds per member: SIM-A long, a sell group entry is refused on every member
        Clear(); G("groupSave", Save(",\"group\":\"g1\"", "Lucid", "true", "0", "2000", "eod", "3000", "50000", "0").Replace("}", ",\"riskPct\":10}"));
        Pos(simA, nq, 1);
        Clear(); GP("groupPreview", GE("groupPreview", "sell", "market", "{\"stop\":20,\"target\":40}", ""));
        string sizes = string.Join(",", new[] { "SIM-A", "SIM-B", "SIM-C", "SIM-D" }.Select(n => Regex.Match(Seat(Last("groupPreview"), n), "\"size\":([0-9]+)").Groups[1].Value));
        Clear(); GP("groupOrder", GE("groupOrder", "sell", "market", "{\"stop\":20,\"target\":40}", ",\"sizes\":\"" + sizes + "\""));
        gp = Last("groupPlaced");
        Check(All() == s0 && gp.Contains("refused: Group Lucid is long") , "GE: a sell while the group is long: every member refused by the one-direction check, said per member: " + gp);
        Flat();
        ChartBridgeGroups.GapMs = 10000;
        ClockEt(2026, 10, 14, 10, 0);
    }

}
