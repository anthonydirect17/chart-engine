// ChartBridge 0.4.0 accounts on Mono (inside check:orders): the per-account checkmark as gate 2 (accountChecks = on), the
// first-start pre-check from tradeAccounts, accounts.txt missing or unreadable (nothing checked, never rewritten), the 10 s
// grace before Gone, Gone holding entries for that account only and never clearing its checkmark (0.4.2), NinjaTrader's
// trailing drawdown never making an account Gone (0.4.2), Archive only with confirm and only when Gone, the
// money and room fields (null with a reason where NinjaTrader reports nothing), exits that always work, cancel from the
// Working orders tab (refused while cancelFromList is off), a v3 page's wider view, and every switch off = 0.3.8.
// Made-up accounts only (EVAL-A, FUNDED-B, Sim101, Playback101); nothing reaches a broker.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript.AddOns;

public static class AccountsHarness
{
    static Action<bool, string> Check;
    const BindingFlags PS = BindingFlags.NonPublic | BindingFlags.Static;
    static readonly List<string> sent = new List<string>();     // the v3 page (signed in)
    static readonly List<string> sentV2 = new List<string>();   // a 1.15 page (no client message), signed in
    static ChartBridgeClient page, old;
    static Account evalA, fundedB, sim, play;
    static Instrument mnq;
    static string folder, token;

    static ConcurrentDictionary<int, ChartBridgeClient> Clients() { return (ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", PS).GetValue(null); }
    static Dictionary<string, Instrument> Named() { return (Dictionary<string, Instrument>)typeof(ChartBridgeServer).GetField("Instruments", PS).GetValue(null); }
    static string IdOf(Order o) { return (string)typeof(ChartBridgeOrders).GetMethod("IdFor", PS).Invoke(null, new object[] { o }); }
    static void AccountsCall(string name) { typeof(ChartBridgeAccounts).GetMethod(name, PS).Invoke(null, null); }

    // A message as it arrives on the WebSocket: through ChartBridge.cs's own dispatch.
    static void Send(ChartBridgeClient c, string json)
    {
        lock (c.Actions) c.Actions.Clear();
        string type = System.Text.RegularExpressions.Regex.Match(json, "\"type\"\\s*:\\s*\"([^\"]*)\"").Groups[1].Value;
        typeof(ChartBridgeServer).GetMethod("OnClientMessage", PS).Invoke(null, new object[] { c, json });
        if (type.Length == 0) throw new Exception("no type");
    }
    static string Last(List<string> l) { return l.Count > 0 ? l[l.Count - 1] : ""; }
    static bool Rejected(string has) { string m = Last(sent); return m.Contains("\"type\":\"reject\"") && m.Contains(has); }
    static bool Any(List<string> l, string a, string b) { return l.Any(x => x.Contains(a) && x.Contains(b)); }
    static string File_(string name) { string p = Path.Combine(folder, name); return File.Exists(p) ? File.ReadAllText(p) : null; }
    static string Accounts() { return Last(sent.Where(x => x.StartsWith("{\"type\":\"accounts\"")).ToList()); }
    static string Entry(string accountsJson, string name)
    {
        int i = accountsJson.IndexOf("{\"name\":\"" + name + "\",\"sim\"");
        if (i < 0) return "";
        int depth = 0;
        for (int j = i; j < accountsJson.Length; j++) { if (accountsJson[j] == '{') depth++; else if (accountsJson[j] == '}' && --depth == 0) return accountsJson.Substring(i, j - i + 1); }
        return "";
    }
    static string Order(string account, string rest) { return "{\"type\":\"order\",\"cid\":\"a\",\"account\":\"" + account + "\",\"root\":\"MNQ\"," + rest + "}"; }
    static string Trade(string account, string on) { return "{\"type\":\"accountTrade\",\"cid\":\"t\",\"account\":\"" + account + "\",\"on\":" + on + "}"; }
    static Account NewAccount(string name, Provider p) { Account a = new Account { Name = name, Provider = p, Connection = new Connection { Status = ConnectionStatus.Connected } }; Account.All.Add(a); return a; }
    static Order Working(Account a, OrderAction action, OrderType type, double limit, double stop, string name)
    {
        Order o = new Order { Account = a, Instrument = mnq, OrderAction = action, OrderType = type, Quantity = 1, LimitPrice = limit, StopPrice = stop, Name = name, OrderState = OrderState.Working };
        a.Orders.Add(o);
        return o;
    }
    static void Restart() { ChartBridgeAccounts.StartNow(ChartBridgeTime.NowUtcMs()); }
    static void SignIn(ChartBridgeClient c) { c.Trader = false; Send(c, "{\"type\":\"auth\",\"token\":\"" + token + "\"}"); }

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
            V3Plumbing();
            SwitchOff();
            FirstStart();
            Checkmarks();
            Exits();
            StrictAndRefusals();
            Persisted();
            NotYetConnected();
            Scope();
            GraceAndGone();
            Archive();
            Disabled();
            Money();
            CancelFromList();
            Unreadable();
            Missing();
            FollowNinjaTrader();
        }
        catch (Exception ex) { Check(false, "accounts harness threw: " + ex); }
        finally
        {
            try { AccountsCall("UnwatchStatus"); } catch (Exception) { }
            OrdersHarness.AllOffLines();
            ChartBridgeAccounts.Clear();
            ChartBridgeOrders.ResetConfig();
            Account.All.Clear(); Account.All.AddRange(allWas);
            Named().Clear(); foreach (KeyValuePair<string, Instrument> kv in namedWas) Named()[kv.Key] = kv.Value;
            Clients().Clear(); foreach (KeyValuePair<int, ChartBridgeClient> kv in clientsWas) Clients()[kv.Key] = kv.Value;
            NinjaTrader.Core.Globals.UserDataDir = dirWas;
        }
    }

    static void Setup()
    {
        string home = Path.Combine(Path.GetTempPath(), "cb-accounts-" + Guid.NewGuid().ToString("N"));
        folder = Path.Combine(home, "ChartBridge");
        Directory.CreateDirectory(folder);
        NinjaTrader.Core.Globals.UserDataDir = home;
        Account.All.Clear();
        evalA = NewAccount("EVAL-A", Provider.Rithmic);
        fundedB = NewAccount("FUNDED-B", Provider.Tradovate);
        sim = NewAccount("Sim101", Provider.Simulator);
        play = NewAccount("Playback101", Provider.Playback);
        mnq = new Instrument { FullName = "MNQ 12-26", MasterInstrument = new MasterInstrument { Name = "MNQ", TickSize = 0.25, PointValue = 2 } };
        Named().Clear(); Named()["MNQ"] = mnq;
        ChartBridgeOrders.ResetConfig();
        ChartBridgeOrders.ReadConfig("trading", "true");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, EVAL-A");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "3");
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        ChartBridgeOrders.NewToken();
        token = ChartBridgeOrders.SessionJson().Split('"')[3];
        Clients().Clear();
        page = new ChartBridgeClient(null, 41); page.Origin = "http://localhost:8765"; page.Tap = s => sent.Add(s);
        old = new ChartBridgeClient(null, 42); old.Origin = "http://localhost:8765"; old.Tap = s => sentV2.Add(s);
        Clients()[41] = page; Clients()[42] = old;
        AccountsCall("WatchStatus");
    }

    // ------------------------------------------------------------ the shared v3 plumbing (ChartBridgeV3.cs): a v2 page gets nothing new
    static void V3Plumbing()
    {
        ChartBridgeSwitches.Reset();   // the default, what ChartBridgeConfig.Load starts from
        Check(ChartBridgeV3.AccountChecks && ChartBridgeV3.OrderTypes && ChartBridgeV3.Strategies && ChartBridgeV3.Merge && ChartBridgeV3.CancelFromList && ChartBridgeV3.Copier && ChartBridgeV3.Bot,
              "v3: every switch ON by default (Anthony 2026-10-07: no switches)");
        Check(ChartBridgeSwitches.Json() == "{\"accountChecks\":true,\"orderTypes\":true,\"strategies\":true,\"merge\":true,\"cancelFromList\":true,\"copier\":true,\"bot\":true}", "v3: trading.switches reports every switch true by default");
        string cfgDir = Path.Combine(Path.GetTempPath(), "cb-switches-" + Guid.NewGuid().ToString("N")), homeWas = NinjaTrader.Core.Globals.UserDataDir;
        Directory.CreateDirectory(Path.Combine(cfgDir, "ChartBridge"));
        NinjaTrader.Core.Globals.UserDataDir = cfgDir;
        try
        {
            File.WriteAllLines(Path.Combine(cfgDir, "ChartBridge", "config.txt"), new[] { "trading = true", "tradeAccounts = Sim101" });
            ChartBridgeConfig.Load();
            Check(ChartBridgeSwitches.Names.All(ChartBridgeSwitches.Get) && ChartBridgeOrders.Enabled, "config.txt with no v3 line: every v3 feature on; trading = true unchanged");
            Check(ChartBridgeConfig.OldAccounts == null, "0.5.1: no accounts line: none read");
            // 0.5.1: the accounts watch list is retired as a filter (read once by ChartBridgeAccounts for the conversion)
            File.WriteAllLines(Path.Combine(cfgDir, "ChartBridge", "config.txt"), new[] { "accounts = Sim101, FUNDED*", "trading = true", "tradeAccounts = Sim101" });
            ChartBridgeConfig.Load();
            Check(ChartBridgeConfig.OldAccounts.SequenceEqual(new[] { "Sim101", "FUNDED*" }) && ChartBridgeConfig.OnOldAccounts("FUNDED-B") && ChartBridgeConfig.OnOldAccounts("sim101") && !ChartBridgeConfig.OnOldAccounts("EVAL-A"), "0.5.1: the old accounts line is kept for the one-time conversion, matched as 0.5.0 did (exact, or a prefix before *)");
            Check(ChartBridgeConfig.AccountAllowed("EVAL-A") && ChartBridgeConfig.AccountAllowed("TEST-EVAL-1") && ChartBridgeConfig.AccountAllowed("Sim101"), "0.5.1: accounts = no longer filters by name (EVAL-A, a new TEST-EVAL-1 allowed)");
            Check(!ChartBridgeConfig.AccountAllowed("Playback101") && !ChartBridgeConfig.AccountAllowed("Backtest") && !ChartBridgeConfig.AccountAllowed(""), "0.5.1: never Backtest or Playback");
            Check(ChartBridgeOrders.Enabled && ChartBridgeOrders.TradeAccounts.SequenceEqual(new[] { "Sim101" }), "0.5.1: the other lines are read as before");
            File.WriteAllLines(Path.Combine(cfgDir, "ChartBridge", "config.txt"), new[] { "trading = true", "merge = off", "copier = OFF", "bot = 0" });
            ChartBridgeConfig.Load();
            Check(!ChartBridgeV3.Merge && !ChartBridgeV3.Copier && !ChartBridgeV3.Bot && ChartBridgeV3.AccountChecks && ChartBridgeV3.OrderTypes && ChartBridgeV3.Strategies && ChartBridgeV3.CancelFromList,
                  "config.txt: merge = off, copier = OFF and bot = 0 turn just those off; the rest stay on");
            Check(ChartBridgeSwitches.Json().Contains("\"merge\":false") && ChartBridgeSwitches.Json().Contains("\"copier\":false") && ChartBridgeSwitches.Json().Contains("\"strategies\":true"), "trading.switches reports the real values");
            File.WriteAllLines(Path.Combine(cfgDir, "ChartBridge", "config.txt"), new[] { "trading = false" });
            ChartBridgeConfig.Load();
            Check(!ChartBridgeOrders.Enabled && ChartBridgeSwitches.Names.All(ChartBridgeSwitches.Get), "trading = false stays the master switch; the v3 switches never change it");
            File.Delete(Path.Combine(cfgDir, "ChartBridge", "config.txt"));
            ChartBridgeConfig.Load();
            Check(!ChartBridgeOrders.Enabled, "no config.txt: trading is off as before (its default never changed)");
        }
        finally { NinjaTrader.Core.Globals.UserDataDir = homeWas; try { Directory.Delete(cfgDir, true); } catch (Exception) { } Setup(); }
        OrdersHarness.AllOffLines();
        Restart();
        ChartBridgeClient p3 = new ChartBridgeClient(null, 46); p3.Origin = "http://localhost:8765"; List<string> g3 = new List<string>(); p3.Tap = x => g3.Add(x);
        ChartBridgeClient p2 = new ChartBridgeClient(null, 47); p2.Origin = "http://localhost:8765"; List<string> g2 = new List<string>(); p2.Tap = x => g2.Add(x);
        Clients()[46] = p3; Clients()[47] = p2;
        try
        {
            Check(!ChartBridgeV3.IsV3(p3) && !ChartBridgeV3.IsV3(p2) && !ChartBridgeV3.IsV3(null), "v3: no page is v3 before its client message");
            Check(!ChartBridgeV3.AccountChecks && !ChartBridgeV3.OrderTypes && !ChartBridgeV3.Strategies && !ChartBridgeV3.Merge && !ChartBridgeV3.CancelFromList && !ChartBridgeV3.Copier && !ChartBridgeV3.Bot, "v3: every off line read: every switch off");
            Send(p3, "{\"type\":\"client\",\"v\":3}");
            Check(ChartBridgeV3.IsV3(p3) && !ChartBridgeV3.IsV3(p2), "v3: the client message marks that page only");
            SignIn(p3); SignIn(p2);
            string t2 = g2.First(x => x.StartsWith("{\"type\":\"trading\""));
            Check(t2 == ChartBridgeOrders.TradingJson(true, null) && !t2.Contains("switches"), "v2 page: the trading message is exactly v2's (no switches)");
            Check(g3.Any(x => x.StartsWith("{\"type\":\"trading\"") && x.Contains(",\"switches\":{\"accountChecks\":false,\"orderTypes\":false,\"strategies\":false,\"merge\":false,\"cancelFromList\":false,\"copier\":false,\"bot\":false}}")), "v3 page: trading carries the seven switches");
            ChartBridgeSwitches.Note("orderTypes", "ON"); ChartBridgeSwitches.Note("bot", "1"); ChartBridgeSwitches.Note("merge", "yes");
            Check(ChartBridgeV3.OrderTypes && ChartBridgeV3.Bot && !ChartBridgeV3.Merge && NinjaTrader.Code.Output.Lines.Any(x => x.Contains("config.txt: merge = yes is not off or on, so merge is OFF")), "switches: ON and 1 are on; a value that is neither off nor on is off, with an Output line");
            g3.Clear(); SignIn(p3);
            Check(g3.Any(x => x.StartsWith("{\"type\":\"trading\"") && x.Contains("\"orderTypes\":true") && x.Contains("\"bot\":true") && x.Contains("\"merge\":false")), "v3 page: the switches are config.txt's values");
            OrdersHarness.AllOffLines();
            Check(!g2.Any(x => x.StartsWith("{\"type\":\"accounts\"")) && !g2.Any(x => x.Contains("\"tradable\"")) && !g2.Any(x => x.Contains("switches")), "v2 page: no accounts, no tradable, no switches");
            Check(ChartBridgeV3.Flat("{\"type\":\"x\",\"a\":1}", "x", new[] { "type", "a" }, out why0) != null && why0 == null, "Flat: a flat message is read");
            Dictionary<string, string> m = ChartBridgeV3.Flat("{ \"type\" : \"x\" , \"n\" : 12 , \"b\" : true , \"s\" : \"hi\" , \"z\" : null }", "x", new[] { "type", "n", "b", "s", "z" }, out why0);
            Check(m != null && ChartBridgeV3.Whole(m, "n") == 12 && ChartBridgeV3.Bool(m, "b") == true && ChartBridgeV3.Str(m, "s") == "hi" && ChartBridgeV3.Str(m, "z") == null && ChartBridgeV3.Whole(m, "s") == null && ChartBridgeV3.Bool(m, "n") == null, "Flat: whole number, bool, string and null read by kind");
            string[] bad = { "{\"type\":\"x\",\"n\":012}", "{\"type\":\"x\",\"n\":1e3}", "{\"type\":\"y\"}", "{\"type\":\"x\",}", "{\"type\":\"x\"} {}", "[{\"type\":\"x\"}]", "{\"type\":\"x\",\"n\":\"" + new string('a', 201) + "\"}", "{\"type\":\"x\",\"n\":tru}" };
            foreach (string b in bad) { string w; Check(ChartBridgeV3.Flat(b, "x", new[] { "type", "n" }, out w) == null && w != null, "Flat refuses " + (b.Length > 40 ? b.Substring(0, 40) + "..." : b) + " (" + w + ")"); }
            // the rate: v3 actions count in gate 7's 10 a second per connection
            ChartBridgeSwitches.Note("accountChecks", "on");
            Restart();
            lock (p3.Actions) p3.Actions.Clear();
            for (int i = 0; i < 11; i++) typeof(ChartBridgeServer).GetMethod("OnClientMessage", PS).Invoke(null, new object[] { p3, "{\"type\":\"accountTrade\",\"account\":\"FUNDED-B\",\"on\":false}" });
            Check(Last(g3).Contains("too many order actions"), "v3 actions count in the 10 a second");
            OrdersHarness.AllOffLines();
        }
        finally
        {
            ChartBridgeClient gone; Clients().TryRemove(46, out gone); Clients().TryRemove(47, out gone);
            OrdersHarness.AllOffLines(); ChartBridgeAccounts.Clear();
            foreach (string f in new[] { "accounts.txt", "accounts.log", "accounts-detail.txt" }) File.Delete(Path.Combine(folder, f));   // the rest starts from a first start
        }
    }
    static string why0;

    // ------------------------------------------------------------ every switch off: 0.3.8 exactly
    static void SwitchOff()
    {
        OrdersHarness.AllOffLines();
        Restart();
        sent.Clear();
        Send(page, "{\"type\":\"client\",\"v\":3}");
        Check(ChartBridgeV3.IsV3(page) && Accounts().Length > 0, "off: a v3 page still gets the accounts list (read only) right after client");
        Check(Entry(Accounts(), "EVAL-A").Contains("\"trade\":true") && Entry(Accounts(), "FUNDED-B").Contains("\"trade\":false"), "off: trade is tradeAccounts");
        Check(!Accounts().Contains("Playback101"), "off: Playback is never listed");
        SignIn(page); SignIn(old);
        string tr = sent.First(x => x.StartsWith("{\"type\":\"trading\""));
        Check(tr.Contains("\"switches\":{\"accountChecks\":false,\"orderTypes\":false,\"strategies\":false,\"merge\":false,\"cancelFromList\":false,\"copier\":false,\"bot\":false}"), "off: a v3 page's trading message carries every switch, all false");
        Check(!sentV2.Any(x => x.Contains("switches")) && sentV2.Any(x => x.StartsWith("{\"type\":\"trading\"") && x.Contains("\"accounts\":[\"Sim101\",\"EVAL-A\"]")), "off: a 1.15 page gets v2's trading message (no switches, tradeAccounts)");
        int calls = fundedB.Calls.Count;
        Send(page, Order("FUNDED-B", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("may not trade from the chart (tradeAccounts in config.txt)") && fundedB.Calls.Count == calls, "off: an account not in tradeAccounts is refused with v2's reason, nothing sent");
        Send(page, Order("EVAL-A", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(evalA.Calls.Count == 1 && evalA.Calls[0].StartsWith("submit"), "off: an account in tradeAccounts trades as before");
        Account.All.Remove(evalA);
        Send(page, Order("EVAL-A", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("account EVAL-A is in tradeAccounts but not connected in NinjaTrader"), "off: a tradeAccounts name NinjaTrader does not list: v2's reason, unchanged");
        Account.All.Add(evalA);
        Send(page, Trade("FUNDED-B", "true"));
        Check(Rejected("accountTrade is off (accountChecks = off in config.txt)"), "off: accountTrade refused");
        Send(page, "{\"type\":\"accountArchive\",\"account\":\"FUNDED-B\",\"confirm\":true}");
        Check(Rejected("accountArchive is off (accountChecks = off in config.txt)"), "off: accountArchive refused");
        Send(page, "{\"type\":\"flatten\",\"account\":\"FUNDED-B\",\"root\":\"MNQ\"}");
        Check(Rejected("tradeAccounts in config.txt") && fundedB.Calls.Count == calls, "off: Flatten on an account outside tradeAccounts is refused (v2)");
        ChartBridgeAccounts.Tick(ChartBridgeTime.NowUtcMs());
        Check(File_("accounts.txt") == null && File_("accounts.log") == null, "off: no accounts.txt and no accounts.log are written");
        Check(ChartBridgeOrders.AccountTradable("EVAL-A") && !ChartBridgeOrders.AccountTradable("FUNDED-B"), "off: gate 2 is tradeAccounts");
        // a 1.15 page sees the tradable accounts' orders only; a v3 page every watched account's, with tradable
        Order other = Working(fundedB, OrderAction.Buy, OrderType.Limit, 24990, 0, "my limit");
        sent.Clear(); sentV2.Clear();
        ChartBridgeOrders.OnOrderUpdate(fundedB, new OrderEventArgs { Order = other });
        Check(sent.Count == 1 && sent[0].Contains("\"account\":\"FUNDED-B\"") && sent[0].EndsWith(",\"tradable\":false}") && sentV2.Count == 0, "off: an order on FUNDED-B reaches the v3 page (tradable false), not the 1.15 page");
        Order mine = Working(evalA, OrderAction.Buy, OrderType.Limit, 24985, 0, "my other limit");
        sent.Clear(); sentV2.Clear();
        ChartBridgeOrders.OnOrderUpdate(evalA, new OrderEventArgs { Order = mine });
        Check(sent.Count == 1 && sent[0].EndsWith(",\"tradable\":true}") && sentV2.Count == 1 && !sentV2[0].Contains("tradable"), "off: an order on EVAL-A reaches both pages (the 1.15 page unchanged)");
        sent.Clear(); sentV2.Clear();
        ChartBridgeOrders.OnPositionUpdate(fundedB, new PositionEventArgs { Position = new Position { Instrument = mnq }, MarketPosition = MarketPosition.Long, Quantity = 1, AveragePrice = 25000 });
        Check(sent.Count == 1 && sent[0].Contains("\"type\":\"position\"") && sentV2.Count == 0, "off: a position on FUNDED-B reaches only the v3 page");
        Check(sentV2.Count == 0, "off: the 1.15 page gets no v3 message");
        evalA.Orders.Clear(); fundedB.Orders.Clear(); evalA.Calls.Clear();
    }

    // ------------------------------------------------------------ first start: tradeAccounts pre-checked, the file written
    static void FirstStart()
    {
        ChartBridgeSwitches.Note("accountChecks", "on");
        Check(ChartBridgeAccounts.On, "accountChecks = on is read");
        Restart();
        Check(ChartBridgeAccounts.Checked("EVAL-A") && ChartBridgeAccounts.Checked("Sim101") && !ChartBridgeAccounts.Checked("FUNDED-B"), "first start: the tradeAccounts accounts come pre-checked, the others not");
        Check(File_("accounts.txt") == null, "first start: nothing written at start (NinjaTrader's thread)");
        ChartBridgeAccounts.Tick(ChartBridgeTime.NowUtcMs());
        string f = File_("accounts.txt") ?? "";
        Check(f.StartsWith(ChartBridgeAccounts.Header + "\n") && f.Contains("trade\t") && f.Contains("\tEVAL-A\n") && f.Contains("\tSim101\n") && f.Contains("off\t") && f.Contains("\tFUNDED-B\n"), "first start: accounts.txt written whole (header, trade EVAL-A and Sim101, off FUNDED-B)");
        Check(!File.Exists(Path.Combine(folder, "accounts.txt.tmp")), "the temp file is swapped in");
        Check((File_("accounts.log") ?? "").Contains("\tEVAL-A\tchecked\tfirst start: named in tradeAccounts\n"), "first start: logged in accounts.log");
        Check(NinjaTrader.Code.Output.Lines.Any(x => x.Contains("first start") && x.Contains("tradeAccounts is not read again")), "first start: one Output line says tradeAccounts is not read again");
    }

    // ------------------------------------------------------------ the checkmark gates entries
    static void Checkmarks()
    {
        sent.Clear(); sentV2.Clear();
        SignIn(page); SignIn(old);
        Check(sent.Any(x => x.StartsWith("{\"type\":\"trading\"") && x.Contains("\"accounts\":[\"EVAL-A\",\"Sim101\"]") && x.Contains("\"accountChecks\":true")), "on: trading lists the checked accounts, accountChecks true");
        int calls = fundedB.Calls.Count;
        Send(page, Order("FUNDED-B", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("account FUNDED-B is not checked for trading (the Accounts tab)") && fundedB.Calls.Count == calls, "unchecked: entry refused, nothing sent");
        sent.Clear(); sentV2.Clear();
        Send(page, Trade("FUNDED-B", "true"));
        Check(!sent.Any(x => x.Contains("\"type\":\"reject\"")), "accountTrade on: accepted");
        Check(ChartBridgeAccounts.Checked("FUNDED-B") && (File_("accounts.txt") ?? "").Contains("trade\t") && System.Text.RegularExpressions.Regex.IsMatch(File_("accounts.txt"), "\ntrade\t[0-9]+\tFUNDED-B\n"), "accountTrade on: saved in accounts.txt");
        Check(sent.Any(x => x.StartsWith("{\"type\":\"accounts\"") && Entry(x, "FUNDED-B").Contains("\"trade\":true") && Entry(x, "FUNDED-B").Contains("\"tradable\":true")), "accountTrade on: the v3 page gets accounts at once");
        Check(sent.Any(x => x.StartsWith("{\"type\":\"trading\"") && x.Contains("\"FUNDED-B\"")) && sentV2.Any(x => x.StartsWith("{\"type\":\"trading\"") && x.Contains("\"FUNDED-B\"") && !x.Contains("switches")), "accountTrade on: every signed-in page gets trading again (gate 2's list)");
        Check(!sentV2.Any(x => x.StartsWith("{\"type\":\"accounts\"")), "the 1.15 page never gets accounts");
        Check((File_("accounts.log") ?? "").Contains("\tFUNDED-B\tchecked\tby the page\n"), "accountTrade on: logged");
        Send(page, Order("FUNDED-B", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(fundedB.Calls.Count == calls + 1 && fundedB.Calls.Last().StartsWith("submit"), "checked: entry sent");
        Send(page, Trade("EVAL-A", "false"));
        Check(!ChartBridgeAccounts.Checked("EVAL-A") && (File_("accounts.log") ?? "").Contains("\tEVAL-A\tunchecked\tby the page\n"), "accountTrade off: unchecked, saved, logged");
        calls = evalA.Calls.Count;
        Send(page, Order("EVAL-A", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("not checked for trading") && evalA.Calls.Count == calls, "after unchecking: entry refused");
        Send(page, Trade("EVAL-A", "false"));
        Check(!Rejected(""), "off again: always accepted");
        // trading = true stays the master switch above every checkmark
        ChartBridgeOrders.Enabled = false;
        calls = fundedB.Calls.Count;
        Send(page, Order("FUNDED-B", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("trading is off in config.txt") && fundedB.Calls.Count == calls, "trading off: a checked account is refused too");
        Send(page, Trade("EVAL-A", "true"));
        Check(Rejected("trading is off in config.txt") && !ChartBridgeAccounts.Checked("EVAL-A"), "trading off: accountTrade refused");
        Check(!ChartBridgeOrders.AccountTradable("FUNDED-B"), "trading off: gate 2 says no for every account");
        ChartBridgeOrders.Enabled = true;
        Send(page, Trade("Playback101", "true"));
        Check(Rejected("Playback101 can never trade"), "Playback can never be checked");
        Send(page, Trade("NOPE-1", "true"));
        Check(Rejected("no account NOPE-1"), "an unknown account cannot be checked");
    }

    // ------------------------------------------------------------ exits need no checkmark (closing always works)
    static void Exits()
    {
        Check(!ChartBridgeAccounts.Checked("EVAL-A"), "EVAL-A unchecked for the exit checks");
        Order entry = Working(evalA, OrderAction.Buy, OrderType.Limit, 24990, 0, "CB#0a0b0c0d atm s8 t16");
        Order leg = Working(evalA, OrderAction.Sell, OrderType.StopMarket, 0, 24980, "CB#0a0b0c0d stop f1 q1 p24990");
        Order mine = Working(evalA, OrderAction.Sell, OrderType.Limit, 25010, 0, "placed in NinjaTrader");
        string ide = IdOf(entry), idl = IdOf(leg), idm = IdOf(mine);
        int calls = evalA.Calls.Count;
        Send(page, "{\"type\":\"change\",\"id\":\"" + idl + "\",\"price\":24985}");
        Check(evalA.Calls.Count == calls + 1 && evalA.Calls.Last().StartsWith("change CB#0a0b0c0d stop"), "unchecked: moving a ChartBridge stop is an exit, allowed");
        Send(page, "{\"type\":\"change\",\"id\":\"" + ide + "\",\"price\":24985}");
        Check(Rejected("may not trade") && evalA.Calls.Count == calls + 1, "unchecked: moving an entry is an entry action, refused");
        Send(page, "{\"type\":\"change\",\"id\":\"" + idm + "\",\"price\":25005}");
        Check(Rejected("may not trade") && evalA.Calls.Count == calls + 1, "unchecked: moving an order placed elsewhere is refused (lead's default)");
        Send(page, "{\"type\":\"plan\",\"id\":\"" + ide + "\",\"stopTicks\":12}");
        Check(Rejected("may not trade"), "unchecked: plan is refused");
        Send(page, "{\"type\":\"cancel\",\"id\":\"" + ide + "\"}");
        Check(evalA.Calls.Count == calls + 2 && evalA.Calls.Last() == "cancel CB#0a0b0c0d atm s8 t16", "unchecked: cancel is an exit, allowed");
        Send(page, "{\"type\":\"flatten\",\"account\":\"EVAL-A\",\"root\":\"MNQ\"}");
        Check(evalA.Calls.Count == calls + 3 && evalA.Calls.Last() == "flatten MNQ 12-26", "unchecked: Flatten is an exit, allowed");
        evalA.Connection.Status = ConnectionStatus.ConnectionLost;
        Send(page, "{\"type\":\"flatten\",\"account\":\"EVAL-A\",\"root\":\"MNQ\"}");
        Check(Rejected("EVAL-A is not connected (ConnectionLost)") && evalA.Calls.Count == calls + 3, "an exit still needs a Connected account");
        evalA.Connection.Status = ConnectionStatus.Connected;
        Send(page, "{\"type\":\"flatten\",\"account\":\"Playback101\",\"root\":\"MNQ\"}");
        Check(Rejected("never Backtest or Playback") && play.Calls.Count == 0, "exits never on Playback");
        evalA.Orders.Clear();
    }

    // ------------------------------------------------------------ strict messages, sign-in, the client message
    static void StrictAndRefusals()
    {
        Send(page, "{\"type\":\"accountTrade\",\"account\":\"EVAL-A\",\"on\":\"true\"}");
        Check(Rejected("on must be true or false") && !ChartBridgeAccounts.Checked("EVAL-A"), "on as a string: refused");
        Send(page, "{\"type\":\"accountTrade\",\"account\":\"EVAL-A\",\"on\":1}");
        Check(Rejected("on must be true or false"), "on as a number: refused");
        Send(page, "{\"type\":\"accountTrade\",\"account\":\"EVAL-A\",\"on\":true,\"force\":true}");
        Check(Rejected("unknown key \\\"force\\\" in accountTrade"), "unknown key: refused");
        Send(page, "{\"type\":\"accountTrade\",\"account\":\"EVAL-A\",\"on\":false,\"on\":true}");
        Check(Rejected("key twice") && !ChartBridgeAccounts.Checked("EVAL-A"), "a key twice: refused");
        Send(page, "{\"type\":\"accountTrade\",\"account\":{\"name\":\"EVAL-A\"},\"on\":true}");
        Check(Rejected("nested"), "nested object: refused");
        Send(page, "{\"type\":\"accountTrade\",\"account\":[\"EVAL-A\"],\"on\":true}");
        Check(Rejected("nested"), "list: refused");
        Send(page, "{\"type\":\"accountTrade\",\"account\":\"EVAL\\u002dA\",\"on\":true}");
        Check(Rejected("escape"), "escape sequence: refused");
        Send(page, "{\"type\":\"accountTrade\",\"on\":true}");
        Check(Rejected("needs account"), "no account: refused");
        Send(page, "{\"type\":\"accountTrade\",\"cid\":7,\"account\":\"EVAL-A\",\"on\":true}");
        Check(Rejected("cid must be a plain string"), "cid not a string: refused");
        ChartBridgeClient stranger = new ChartBridgeClient(null, 43); stranger.Origin = "http://localhost:8765"; List<string> got = new List<string>(); stranger.Tap = s => got.Add(s);
        Send(stranger, "{\"type\":\"client\",\"v\":3}");
        Send(stranger, Trade("EVAL-A", "true"));
        Check(Last(got).Contains("\"type\":\"reject\"") && Last(got).Contains("may not trade") && !ChartBridgeAccounts.Checked("EVAL-A"), "not signed in: accountTrade refused");
        Check(got.Any(x => x.StartsWith("{\"type\":\"accounts\"")), "own page, not signed in: still gets accounts after client");
        ChartBridgeClient desk = new ChartBridgeClient(null, 44); desk.Origin = "http://localhost:8800"; List<string> gotDesk = new List<string>(); desk.Tap = s => gotDesk.Add(s);
        Send(desk, "{\"type\":\"client\",\"v\":3}");
        Check(!gotDesk.Any(x => x.StartsWith("{\"type\":\"accounts\"")), "another origin never gets accounts");
        ChartBridgeClient v2 = new ChartBridgeClient(null, 45); v2.Origin = "http://localhost:8765"; List<string> gotV2 = new List<string>(); v2.Tap = s => gotV2.Add(s);
        Send(v2, "{\"type\":\"client\",\"v\":2}");
        Check(!ChartBridgeV3.IsV3(v2) && Last(gotV2).Contains("\"level\":\"warn\"") && Last(gotV2).Contains("v must be 3"), "client with v 2: a status warn, the page stays v2");
        Send(v2, "{\"type\":\"client\",\"v\":3,\"x\":1}");
        Check(!ChartBridgeV3.IsV3(v2) && Last(gotV2).Contains("unknown key"), "client with another key: refused");
        Send(v2, "{\"type\":\"client\",\"v\":\"3\"}");
        Check(!ChartBridgeV3.IsV3(v2), "client with v as a string: refused");
    }

    // ------------------------------------------------------------ a restart reads the checkmarks; tradeAccounts is not read again
    static void Persisted()
    {
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, EVAL-A, FUNDED-B");
        Restart();
        Check(!ChartBridgeAccounts.Checked("EVAL-A") && ChartBridgeAccounts.Checked("FUNDED-B") && ChartBridgeAccounts.Checked("Sim101"), "restart: the saved checkmarks count, tradeAccounts does not (EVAL-A stays unchecked)");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, EVAL-A");
        Send(page, Trade("EVAL-A", "true"));
        Check(ChartBridgeAccounts.Checked("EVAL-A"), "EVAL-A checked again");
    }

    // ------------------------------------------------------------ lead's default: an account signed in by hand after a restart keeps its checkmark
    // 0.5.1: a new NinjaTrader session (SessionStartMs after every saved connected time): not listed until it connects
    static void NewSession(double at) { Restart(); ChartBridgeAccounts.SessionStartMs = at; }
    static void NotYetConnected()
    {
        Check(ChartBridgeAccounts.Checked("EVAL-A") && ChartBridgeAccounts.Checked("FUNDED-B"), "EVAL-A and FUNDED-B checked before the restart");
        evalA.Connection.Status = ConnectionStatus.Disconnected;
        Account.All.Remove(fundedB);   // its connection not up yet: NinjaTrader does not list it
        double t = ChartBridgeTime.NowUtcMs() + 10050000;
        NewSession(t - 1000);
        ChartBridgeAccounts.Tick(t);
        ChartBridgeAccounts.Tick(t + 30000);
        ChartBridgeAccounts.Tick(t + 60000);
        Check(ChartBridgeAccounts.Checked("EVAL-A") && ChartBridgeAccounts.Checked("FUNDED-B"), "restart, not connected for 60 s: the saved checkmarks stay (never connected this run, not Gone)");
        string acc = ChartBridgeAccounts.AccountsJson(Account.All.ToList(), 0);
        Check(Entry(acc, "EVAL-A") == "" && Entry(acc, "FUNDED-B") == "" && Entry(acc, "Sim101") != "", "0.5.1: a new session: an account not connected yet (in NinjaTrader or not) is not listed; accounts.txt keeps its checkmark");
        int calls = evalA.Calls.Count;
        Send(page, Order("EVAL-A", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("EVAL-A is not connected") && evalA.Calls.Count == calls, "not connected yet: an order is refused by the normal gate");
        int callsB = fundedB.Calls.Count;
        Send(page, Order("FUNDED-B", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("account FUNDED-B is not connected in NinjaTrader") && !Rejected("tradeAccounts") && fundedB.Calls.Count == callsB, "not listed yet: refused, the reason names no tradeAccounts (accountChecks on)");
        // Anthony signs in by hand: it trades at once, with the saved checkmark
        evalA.Connection.Status = ConnectionStatus.Connected;
        Account.All.Add(fundedB);
        ChartBridgeAccounts.Tick(t + 61000);
        Send(page, Order("EVAL-A", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(evalA.Calls.Count == calls + 1 && evalA.Calls.Last().StartsWith("submit"), "connected after 60 s: trades with its saved checkmark");
        Check(Entry(ChartBridgeAccounts.AccountsJson(Account.All.ToList(), 0), "EVAL-A").Contains("\"notConnectedYet\":false"), "connected: no longer not connected yet");
        // then it drops: that counts now
        fundedB.Connection.Status = ConnectionStatus.ConnectionLost;
        ChartBridgeAccounts.Tick(t + 62000);
        ChartBridgeAccounts.Tick(t + 72000);
        Check(!ChartBridgeAccounts.Checked("FUNDED-B") && ChartBridgeAccounts.Checked("EVAL-A") && Entry(ChartBridgeAccounts.AccountsJson(Account.All.ToList(), 0), "FUNDED-B").Contains("\"goneWhy\":\"disconnected\"") && Entry(ChartBridgeAccounts.AccountsJson(Account.All.ToList(), 0), "FUNDED-B").Contains("\"trade\":true"), "connected, then dropped for 10 s: Gone, entries wait, the checkmark kept (that account only)");
        fundedB.Connection.Status = ConnectionStatus.Connected;
        ChartBridgeAccounts.Tick(t + 73000);
        Check(ChartBridgeAccounts.Checked("FUNDED-B"), "connected again: trades with its kept checkmark, nothing to tick (0.4.2)");
        // disabled at first sight, never connected: Gone after the grace all the same
        sim.Connection.Status = ConnectionStatus.Disconnected;
        NewSession(t + 79000);
        Account.FireStatus(sim, AccountStatus.Disabled);
        ChartBridgeAccounts.Tick(t + 80000);
        ChartBridgeAccounts.Tick(t + 90000);
        Check(Entry(Accounts(), "Sim101") == "" && ChartBridgeAccounts.Checked("EVAL-A"), "0.5.1: disabled and never connected this session: not listed (no Gone row)");
        sim.Connection.Status = ConnectionStatus.Connected;
        ChartBridgeAccounts.Tick(t + 90500);
        sim.Connection.Status = ConnectionStatus.Disconnected;
        ChartBridgeAccounts.Tick(t + 90600);
        ChartBridgeAccounts.Tick(t + 100700);
        Check(!ChartBridgeAccounts.Checked("Sim101") && Entry(Accounts(), "Sim101").Contains("\"state\":\"gone\""), "connected once, then disabled for the grace: Gone");
        Account.FireStatus(sim, AccountStatus.Enabled);
        sim.Connection.Status = ConnectionStatus.Connected;
        ChartBridgeAccounts.Tick(t + 101000);
        Check(ChartBridgeAccounts.Checked("Sim101"), "enabled and connected again: its kept checkmark trades (0.4.2)");
        Check(ChartBridgeAccounts.Checked("Sim101") && ChartBridgeAccounts.Checked("EVAL-A") && ChartBridgeAccounts.Checked("FUNDED-B"), "all three checked again");
    }

    // ------------------------------------------------------------ a v3 page sees every watched account at sign-in
    static void Scope()
    {
        Send(page, Trade("FUNDED-B", "false"));
        Order other = Working(fundedB, OrderAction.Buy, OrderType.Limit, 24990, 0, "my limit");
        fundedB.Positions.Add(new Position { Instrument = mnq, MarketPosition = MarketPosition.Long, Quantity = 2, AveragePrice = 24995.25 });
        sent.Clear(); sentV2.Clear();
        SignIn(page); SignIn(old);
        string orders = sent.First(x => x.StartsWith("{\"type\":\"orders\""));
        Check(orders.Contains("\"account\":\"FUNDED-B\"") && orders.Contains("\"tradable\":false"), "v3 sign-in: orders include the unchecked FUNDED-B, tradable false");
        Check(sent.Any(x => x.StartsWith("{\"type\":\"position\"") && x.Contains("FUNDED-B")), "v3 sign-in: FUNDED-B's position too");
        string ordersV2 = sentV2.First(x => x.StartsWith("{\"type\":\"orders\""));
        Check(!ordersV2.Contains("FUNDED-B") && !sentV2.Any(x => x.StartsWith("{\"type\":\"position\"") && x.Contains("FUNDED-B")), "1.15 sign-in: only the tradable accounts (v2 scope)");
        string acc = ChartBridgeAccounts.AccountsJson(Account.All.ToList(), ChartBridgeTime.NowUtcMs());
        Check(Entry(acc, "FUNDED-B").Contains("\"positions\":[{\"root\":\"MNQ\",\"name\":\"MNQ 12-26\",\"qty\":2,\"avgPrice\":24995.25}]"), "accounts: positions on served roots, signed");
        fundedB.Orders.Clear(); fundedB.Positions.Clear();
        Send(page, Trade("FUNDED-B", "true"));
    }

    // ------------------------------------------------------------ the 10 s grace, then Gone for that account only
    static void GraceAndGone()
    {
        double t = ChartBridgeTime.NowUtcMs() + 100000;
        Check(ChartBridgeAccounts.Checked("EVAL-A") && ChartBridgeAccounts.Checked("FUNDED-B") && ChartBridgeAccounts.Checked("Sim101"), "all three checked before the grace checks");
        ChartBridgeAccounts.Tick(t - 1000);   // seen Connected this run: from now on a drop counts
        evalA.Connection.Status = ConnectionStatus.ConnectionLost;
        ChartBridgeAccounts.Tick(t);
        ChartBridgeAccounts.Tick(t + 9000);
        Check(ChartBridgeAccounts.Checked("EVAL-A"), "lost for 9 s: still checked (the grace)");
        evalA.Connection.Status = ConnectionStatus.Connected;
        ChartBridgeAccounts.Tick(t + 9500);
        evalA.Connection.Status = ConnectionStatus.ConnectionLost;
        ChartBridgeAccounts.Tick(t + 10500);
        ChartBridgeAccounts.Tick(t + 19000);
        Check(ChartBridgeAccounts.Checked("EVAL-A"), "a break in the bad time starts the grace again");
        sent.Clear(); sentV2.Clear();
        ChartBridgeAccounts.Tick(t + 20500);
        Check(!ChartBridgeAccounts.Checked("EVAL-A"), "lost for 10 s without a break: Gone, entries wait");
        Check(ChartBridgeAccounts.Checked("FUNDED-B") && ChartBridgeAccounts.Checked("Sim101"), "Gone holds entries for that account only");
        Check(System.Text.RegularExpressions.Regex.IsMatch(File_("accounts.txt"), "\ntrade\t[0-9]+\tEVAL-A\n"), "Gone: the checkmark is kept in accounts.txt (0.4.2: ChartBridge never clears one)");
        Check((File_("accounts.log") ?? "").Contains("\tEVAL-A\tgone\tdisconnected for 10 s; the checkmark is kept: entries wait until it is back\n"), "Gone: logged");
        Check(sent.Any(x => x.Contains("\"level\":\"warn\"") && x.Contains("EVAL-A is gone (disconnected for 10 s): entries wait until it is back; its checkmark is kept")) && sentV2.Any(x => x.Contains("EVAL-A is gone")), "Gone: a status warn to the signed-in pages");
        string e = Entry(Accounts(), "EVAL-A");
        Check(e.Contains("\"connection\":\"lost\"") && e.Contains("\"trade\":true") && e.Contains("\"tradable\":false") && e.Contains("\"state\":\"gone\"") && e.Contains("\"goneWhy\":\"disconnected\"") && !e.Contains("\"goneSince\":null"), "Gone: listed as gone, why and since, the checkmark kept, not tradable");
        Check(sent.Any(x => x.StartsWith("{\"type\":\"trading\"") && !x.Contains("EVAL-A")), "Gone: trading sent again without EVAL-A (the ticket offers it again when it is back)");
        int calls = evalA.Calls.Count;
        Send(page, Order("EVAL-A", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("EVAL-A is gone (disconnected): entries wait until it is back (its checkmark is kept)") && evalA.Calls.Count == calls, "Gone: entry refused");
        evalA.Connection.Status = ConnectionStatus.Connected;
        sent.Clear();
        ChartBridgeAccounts.Tick(t + 21500);
        e = Entry(Accounts(), "EVAL-A");
        Check(e.Contains("\"state\":\"active\"") && e.Contains("\"trade\":true") && ChartBridgeAccounts.Checked("EVAL-A"), "back: active again and trading with its kept checkmark, nothing to tick");
        Check((File_("accounts.log") ?? "").Contains("\tEVAL-A\tactive again\thealthy again; checked: entries are taken again\n"), "back: logged");
        Check(sent.Any(x => x.Contains("\"level\":\"info\"") && x.Contains("EVAL-A is back (connected): its checkmark is kept, entries are taken again")), "back: an info status to the signed-in pages");
        Check(sent.Any(x => x.StartsWith("{\"type\":\"trading\"") && x.Contains("EVAL-A")), "back: trading sent again with EVAL-A (the ticket offers it again)");
        Send(page, Order("EVAL-A", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(evalA.Calls.Count == calls + 1 && evalA.Calls.Last().StartsWith("submit"), "back: an entry goes through");
        // unchecked by Anthony, then Gone and back: it stays unchecked (ChartBridge never changes a checkmark either way)
        Send(page, Trade("EVAL-A", "false"));
        evalA.Connection.Status = ConnectionStatus.ConnectionLost;
        ChartBridgeAccounts.Tick(t + 22000);
        ChartBridgeAccounts.Tick(t + 32000);
        Check(Entry(Accounts(), "EVAL-A").Contains("\"state\":\"gone\"") && Entry(Accounts(), "EVAL-A").Contains("\"trade\":false"), "unchecked, then Gone: still unchecked");
        Send(page, Trade("EVAL-A", "true"));
        Check(Rejected("EVAL-A is gone") && !ChartBridgeAccounts.Checked("EVAL-A"), "Gone: accountTrade on refused until it is back");
        evalA.Connection.Status = ConnectionStatus.Connected;
        sent.Clear();
        ChartBridgeAccounts.Tick(t + 33000);
        Check(Entry(Accounts(), "EVAL-A").Contains("\"state\":\"active\"") && !ChartBridgeAccounts.Checked("EVAL-A") && sent.Any(x => x.Contains("EVAL-A is back (connected): it is not checked for trading")), "back unchecked: stays unchecked, said so");
        Send(page, Trade("EVAL-A", "true"));
        Check(ChartBridgeAccounts.Checked("EVAL-A"), "Anthony checks it again");
        evalA.Orders.Clear();
        ChartBridgeAccounts.Tick(t + 34000);   // 0.5.1: last seen flat
        // an account that NinjaTrader no longer lists (its connection is off) goes Gone too
        Account.All.Remove(evalA);
        ChartBridgeAccounts.Tick(t + 40000);
        ChartBridgeAccounts.Tick(t + 50001);
        Check(!ChartBridgeAccounts.Checked("EVAL-A") && Entry(Accounts(), "EVAL-A").Contains("\"connection\":\"disconnected\"") && Entry(Accounts(), "EVAL-A").Contains("\"state\":\"gone\"") && Entry(Accounts(), "EVAL-A").Contains("\"balance\":null"), "an account missing from NinjaTrader: Gone (disconnected), money null");
    }

    // ------------------------------------------------------------ Archive: only with confirm, only when Gone
    static void Archive()
    {
        Send(page, "{\"type\":\"accountArchive\",\"account\":\"EVAL-A\"}");
        Check(Rejected("Archive needs confirm: true"), "archive without confirm: refused");
        Send(page, "{\"type\":\"accountArchive\",\"account\":\"EVAL-A\",\"confirm\":false}");
        Check(Rejected("Archive needs confirm: true") && !File_("accounts.txt").Contains("archived"), "archive with confirm false: refused");
        Order w = Working(fundedB, OrderAction.Buy, OrderType.Limit, 24990, 0, "my limit");
        Send(page, "{\"type\":\"accountArchive\",\"account\":\"FUNDED-B\",\"confirm\":true}");
        Check(Rejected("FUNDED-B has a position or working orders: only a flat account can be hidden (exits always work)"), "0.5.1: Hide of an account with a working order: refused, plain reason");
        fundedB.Orders.Remove(w);
        Send(page, "{\"type\":\"accountArchive\",\"account\":\"Sim101\",\"confirm\":true}");
        Check(Rejected("Sim101 is the bot's account (the Bot tab): it cannot be hidden") && !File_("accounts.txt").Contains("archived"), "0.5.1: Hide of the bot's account (Sim101 when bot-account.txt names none): refused");
        sent.Clear();
        Send(page, "{\"type\":\"accountArchive\",\"cid\":\"z\",\"account\":\"EVAL-A\",\"confirm\":true}");
        Check(!sent.Any(x => x.Contains("\"type\":\"reject\"")), "archive of a Gone account with confirm: accepted");
        string acc = Accounts();
        Check(Entry(acc, "EVAL-A") == "" && acc.Contains("\"archived\":[{\"name\":\"EVAL-A\",\"at\":"), "archived: out of the list, in archived");
        Check(System.Text.RegularExpressions.Regex.IsMatch(File_("accounts.txt"), "\narchived\t[0-9]+\tEVAL-A\n") && File_("accounts.log").Contains("\tEVAL-A\tarchived\tby the page\n"), "archived: saved and logged (history kept: the log is only appended)");
        Send(page, Trade("EVAL-A", "true"));
        Check(Rejected("EVAL-A is archived"), "archived: cannot be checked");
        Send(page, "{\"type\":\"accountArchive\",\"account\":\"EVAL-A\",\"confirm\":true}");
        Check(Rejected("archived already"), "archive twice: refused");
        Account.All.Add(evalA);
        evalA.Connection.Status = ConnectionStatus.Connected;
        ChartBridgeAccounts.Tick(ChartBridgeTime.NowUtcMs() + 200000);
        ChartBridgeAccounts.Tick(ChartBridgeTime.NowUtcMs() + 230000);
        Check(Entry(Accounts(), "EVAL-A") == "" && !ChartBridgeAccounts.Checked("EVAL-A") && !File_("accounts.log").Contains("\tEVAL-A\tback from the archive\t"), "0.5.1: hidden on the page, then in NinjaTrader and healthy: stays archived until Show");
        Send(page, "{\"type\":\"accountUnarchive\",\"cid\":\"u\",\"account\":\"EVAL-A\"}");
        string e = Entry(Accounts(), "EVAL-A");
        Check(!Rejected("") && e.Contains("\"state\":\"active\"") && e.Contains("\"trade\":false") && !ChartBridgeAccounts.Checked("EVAL-A") && File_("accounts.log").Contains("\tEVAL-A\tshown\tby the page; unchecked\n"), "0.5.1: Show: back as active, unchecked, logged");
        Send(page, Trade("EVAL-A", "true"));
    }

    // ------------------------------------------------------------ disabled (NinjaTrader's account status event)
    static void Disabled()
    {
        double t = ChartBridgeTime.NowUtcMs() + 300000;
        Account.FireStatus(fundedB, AccountStatus.Disabled);
        ChartBridgeAccounts.Tick(t);
        ChartBridgeAccounts.Tick(t + 10000);
        Check(!ChartBridgeAccounts.Checked("FUNDED-B") && Entry(Accounts(), "FUNDED-B").Contains("\"goneWhy\":\"disabled\""), "disabled for 10 s: Gone (disabled)");
        Check(ChartBridgeAccounts.Checked("EVAL-A") && ChartBridgeAccounts.Checked("Sim101"), "disabled: the other accounts keep their checkmark");
        Account.FireStatus(fundedB, AccountStatus.Enabled);
        ChartBridgeAccounts.Tick(t + 11000);
        Check(Entry(Accounts(), "FUNDED-B").Contains("\"state\":\"active\"") && ChartBridgeAccounts.Checked("FUNDED-B"), "enabled again: active, trading with its kept checkmark (0.4.2)");
    }

    // ------------------------------------------------------------ money and the room fields: as NinjaTrader reports them, else null with why
    static void Money()
    {
        sim.Items[AccountItem.CashValue] = 100000; sim.Items[AccountItem.RealizedProfitLoss] = 120.5; sim.Items[AccountItem.UnrealizedProfitLoss] = -20.25;
        string e = Entry(ChartBridgeAccounts.AccountsJson(Account.All.ToList(), ChartBridgeTime.NowUtcMs()), "Sim101");
        Check(e.Contains("\"sim\":true") && e.Contains("\"balance\":100000") && e.Contains("\"realizedToday\":120.5") && e.Contains("\"unrealized\":-20.25") && e.Contains("\"pnlToday\":100.25"), "money: cash value, realized, unrealized and their sum");
        Check(e.Contains("\"roomDrawdown\":null") && e.Contains("\"roomDrawdownWhy\":\"NinjaTrader does not report a trailing drawdown for this account (it shows 0, as it does when none is set)\""), "trailing drawdown 0 and never reported: null with why");
        Check(e.Contains("\"roomDailyLoss\":null") && e.Contains("NinjaTrader reports the daily loss limit only as the share already used"), "daily loss: always null, with why (NinjaTrader reports a percentage)");
        Check(Entry(ChartBridgeAccounts.AccountsJson(Account.All.ToList(), 0), "EVAL-A").Contains("\"sim\":false"), "an evaluation account is not sim");
        sim.Items[AccountItem.TrailingMaxDrawdown] = 1740.5;
        e = Entry(ChartBridgeAccounts.AccountsJson(Account.All.ToList(), 0), "Sim101");
        Check(e.Contains("\"roomDrawdown\":1740.5") && e.Contains("\"roomDrawdownWhy\":null"), "trailing drawdown reported: the dollars left");
        sim.Items[AccountItem.TrailingMaxDrawdown] = 0;
        e = Entry(ChartBridgeAccounts.AccountsJson(Account.All.ToList(), 0), "Sim101");
        Check(e.Contains("\"roomDrawdown\":0"), "0 after a reported value: 0 (the room is used up)");
        double t = ChartBridgeTime.NowUtcMs() + 400000;
        ChartBridgeAccounts.Tick(t);
        ChartBridgeAccounts.Tick(t + 10000);
        ChartBridgeAccounts.Tick(t + 60000);
        e = Entry(Accounts(), "Sim101");
        Check(ChartBridgeAccounts.Checked("Sim101") && e.Contains("\"state\":\"active\"") && e.Contains("\"tradable\":true") && e.Contains("\"roomDrawdown\":0"), "NinjaTrader's trailing drawdown at 0 for a minute: shown, never Gone, the checkmark kept (0.4.2)");
        sim.Items[AccountItem.TrailingMaxDrawdown] = -250;
        ChartBridgeAccounts.Tick(t + 61000);
        ChartBridgeAccounts.Tick(t + 80000);
        Check(ChartBridgeAccounts.Checked("Sim101") && Entry(Accounts(), "Sim101").Contains("\"roomDrawdown\":-250"), "below 0: shown as NinjaTrader gives it, never Gone (0.4.2)");
        sim.Items[AccountItem.TrailingMaxDrawdown] = 500;
        ChartBridgeAccounts.Tick(t + 81000);
        Check(ChartBridgeAccounts.Checked("Sim101"), "room again: nothing changed");
        sim.GetThrows = new InvalidOperationException("stand-in");
        e = Entry(ChartBridgeAccounts.AccountsJson(Account.All.ToList(), 0), "Sim101");
        Check(e.Contains("\"balance\":null") && e.Contains("\"roomDrawdown\":null") && e.Contains("could not give the trailing drawdown (stand-in)"), "NinjaTrader throws: null, never a guess");
        sim.GetThrows = null;
        sim.Items.Clear();
        Check(!e.Contains("NaN"), "no NaN on the wire");
    }

    // ------------------------------------------------------------ cancel from the Working orders tab
    static void CancelFromList()
    {
        Send(page, Trade("FUNDED-B", "false"));
        Order o = Working(fundedB, OrderAction.Buy, OrderType.Limit, 24990, 0, "my limit");
        string id = IdOf(o);
        int calls = fundedB.Calls.Count;
        Send(page, "{\"type\":\"cancel\",\"id\":\"" + id + "\",\"from\":\"list\"}");
        Check(Rejected("Cancel from the Working orders tab is off (cancelFromList = off in config.txt)") && fundedB.Calls.Count == calls, "cancelFromList off: refused, nothing sent");
        ChartBridgeSwitches.Note("cancelFromList", "on");
        Send(page, "{\"type\":\"cancel\",\"id\":\"" + id + "\",\"from\":\"tab\"}");
        Check(Rejected("from must be \\\"list\\\"") && fundedB.Calls.Count == calls, "from other than list: refused");
        Send(page, "{\"type\":\"cancel\",\"id\":\"" + id + "\",\"from\":null}");
        Check(Rejected("from must be \\\"list\\\"") && fundedB.Calls.Count == calls, "from null: refused");
        Send(page, "{\"type\":\"cancel\",\"id\":\"" + id + "\",\"from\":\"list\"}");
        Check(fundedB.Calls.Count == calls + 1 && fundedB.Calls.Last() == "cancel my limit", "cancelFromList on: an unchecked account's order is cancelled (an exit)");
        fundedB.Connection.Status = ConnectionStatus.Disconnected;
        Send(page, "{\"type\":\"cancel\",\"id\":\"" + id + "\",\"from\":\"list\"}");
        Check(Rejected("not connected") && fundedB.Calls.Count == calls + 1, "cancel from the list needs a Connected account");
        fundedB.Connection.Status = ConnectionStatus.Connected;
        // with accountChecks off, cancel from the list still works on a watched account; a plain cancel is v2's
        ChartBridgeSwitches.Note("accountChecks", "off");
        Send(page, "{\"type\":\"cancel\",\"id\":\"" + id + "\"}");
        Check(Rejected("may not trade") && fundedB.Calls.Count == calls + 1, "accountChecks off: a plain cancel on an account outside tradeAccounts is v2's refusal");
        Send(page, "{\"type\":\"cancel\",\"id\":\"" + id + "\",\"from\":\"list\"}");
        Check(fundedB.Calls.Count == calls + 2, "accountChecks off, cancelFromList on: cancel from the list works");
        ChartBridgeSwitches.Note("cancelFromList", "off");
        ChartBridgeSwitches.Note("accountChecks", "on");
        fundedB.Orders.Clear();
    }

    // ------------------------------------------------------------ accounts.txt that cannot be read: nothing checked, never rewritten
    static void Unreadable()
    {
        string path = Path.Combine(folder, "accounts.txt");
        string bad = ChartBridgeAccounts.Header + "\ntrade\tnot-a-time\tEVAL-A\n";
        File.WriteAllText(path, bad);
        Restart();
        Check(!ChartBridgeAccounts.Checked("EVAL-A") && !ChartBridgeAccounts.Checked("Sim101") && !ChartBridgeAccounts.Checked("FUNDED-B"), "unreadable accounts.txt: every checkmark off");
        sent.Clear();
        SignIn(page);
        Check(sent.Any(x => x.Contains("\"level\":\"error\"") && x.Contains(ChartBridgeAccounts.ReadFailedText)), "unreadable: a status error at sign-in");
        Send(page, Order("Sim101", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected(ChartBridgeAccounts.ReadFailedText), "unreadable: entries refused with the reason");
        Send(page, Trade("Sim101", "true"));
        Check(Rejected("could not be read") && !ChartBridgeAccounts.Checked("Sim101"), "unreadable: accountTrade on refused");
        ChartBridgeAccounts.Tick(ChartBridgeTime.NowUtcMs());
        Check(File.ReadAllText(path) == bad, "unreadable: the file is never rewritten that run");
        File.WriteAllText(path, "trade\t1\tSim101\n");
        Restart();
        Check(!ChartBridgeAccounts.Checked("Sim101"), "no header: unreadable, nothing checked");
        File.WriteAllText(path, ChartBridgeAccounts.Header + "\ntrade\t1\tSim101\ntrade\t2\tSim101\n");
        Restart();
        Check(!ChartBridgeAccounts.Checked("Sim101"), "a name twice: unreadable, nothing checked");
        File.WriteAllText(path, ChartBridgeAccounts.Header + "\ntrade\t1\tPlayback101\n");
        Restart();
        Check(!ChartBridgeAccounts.Checked("Playback101") && !ChartBridgeAccounts.Checked("Sim101"), "a Playback line: unreadable, nothing checked");
        File.WriteAllText(path, ChartBridgeAccounts.Header + "\r\ntrade\t1\tSim101\r\n");
        Restart();
        Check(ChartBridgeAccounts.Checked("Sim101") && !ChartBridgeAccounts.Checked("EVAL-A"), "Windows line ends: read");
    }

    // ------------------------------------------------------------ accounts.txt gone after ChartBridge made it: nothing checked (lead's default)
    static void Missing()
    {
        File.Delete(Path.Combine(folder, "accounts.txt"));
        Check(File.Exists(Path.Combine(folder, "accounts.log")), "accounts.log is there from earlier");
        Restart();
        Check(!ChartBridgeAccounts.Checked("EVAL-A") && !ChartBridgeAccounts.Checked("Sim101"), "missing accounts.txt (ChartBridge made it before): nothing checked, tradeAccounts not used");
        sent.Clear();
        SignIn(page);
        Check(sent.Any(x => x.Contains("\"level\":\"error\"") && x.Contains("accounts.txt is missing")), "missing: a status error at sign-in");
        ChartBridgeAccounts.Tick(ChartBridgeTime.NowUtcMs());
        string f = File_("accounts.txt") ?? "";
        Check(f.StartsWith(ChartBridgeAccounts.Header) && !f.Contains("trade\t"), "missing: a new accounts.txt with nothing checked");
        Send(page, Trade("Sim101", "true"));
        Check(ChartBridgeAccounts.Checked("Sim101"), "missing: Anthony checks them again");
    }

    // ------------------------------------------------------------ 0.5.1: connected accounts only; Hide and Show; pruning; the one-time conversion
    static Account NewOn(string name, ConnectionStatus st) { Account a = new Account { Name = name, Provider = Provider.Rithmic, Connection = new Connection { Status = st } }; Account.All.Add(a); return a; }
    static string Log_() { return File_("accounts.log") ?? ""; }
    static bool ArchivedNow(string name) { return Accounts().Contains("{\"name\":\"" + name + "\",\"at\":"); }
    static string Hide(string name) { return "{\"type\":\"accountArchive\",\"cid\":\"h\",\"account\":\"" + name + "\",\"confirm\":true}"; }
    static string Show(string name) { return "{\"type\":\"accountUnarchive\",\"cid\":\"s\",\"account\":\"" + name + "\"}"; }
    static bool InFile(string name) { return System.Text.RegularExpressions.Regex.IsMatch(File_("accounts.txt") ?? "", "\n[a-z]+\t[0-9]+\t" + System.Text.RegularExpressions.Regex.Escape(name) + "\n"); }
    static void WatchNow() { typeof(ChartBridgeServer).GetMethod("WatchAccounts", PS).Invoke(null, null); }
    static bool Watching(string name) { return NinjaTrader.Code.Output.Lines.Any(x => x.EndsWith("watching fills on account " + name)); }

    static void FollowNinjaTrader()
    {
        OrdersHarness.AllOffLines();
        ChartBridgeSwitches.Note("accountChecks", "on");
        Restart();
        double t = ChartBridgeTime.NowUtcMs() + 20000000;
        // 90 accounts NinjaTrader remembers with no connection, or never connected: never watched, listed or written
        List<Account> old = new List<Account>();
        for (int i = 1; i <= 90; i++) { Account a = new Account { Name = "OLD-EVAL-" + i.ToString("00"), Provider = Provider.Rithmic, Connection = i % 3 == 0 ? new Connection { Status = ConnectionStatus.Disconnected } : null }; Account.All.Add(a); old.Add(a); }
        Account e1 = NewOn("TEST-EVAL-1", ConnectionStatus.Disconnected);
        ChartBridgeAccounts.Tick(t);
        WatchNow();
        string acc = Accounts();
        Check(!acc.Contains("OLD-EVAL-") && !acc.Contains("TEST-EVAL-1") && !InFile("OLD-EVAL-01") && !InFile("OLD-EVAL-03") && !InFile("TEST-EVAL-1"), "0.5.1: 90 accounts in Account.All with no connection or never connected: not listed, not written to accounts.txt");
        Check(!NinjaTrader.Code.Output.Lines.Any(x => x.Contains("watching fills on account OLD-EVAL-")) && !Watching("TEST-EVAL-1"), "0.5.1: and never watched (no fills)");
        Check(Entry(acc, "Sim101") != "" && Entry(acc, "EVAL-A") != "", "the connected accounts are listed");
        // one connects later: listed at the next check, its checkmark off; watched by the 10 s timer
        e1.Connection.Status = ConnectionStatus.Connected;
        sent.Clear();
        ChartBridgeAccounts.Tick(t + 1000);
        string en = Entry(Accounts(), "TEST-EVAL-1");
        Check(en.Contains("\"state\":\"active\"") && en.Contains("\"trade\":false") && !ChartBridgeAccounts.Checked("TEST-EVAL-1") && System.Text.RegularExpressions.Regex.IsMatch(File_("accounts.txt"), "\noff\t[0-9]+\tTEST-EVAL-1\n"), "0.5.1: an account that connects appears at the next check with its checkmark off, kept in accounts.txt as off");
        Check(en.Contains("\"canHide\":true") && en.Contains("\"hideWhy\":null"), "0.5.1: a flat account: canHide true");
        WatchNow();
        Check(Watching("TEST-EVAL-1"), "0.5.1: the 10 s watch picks it up (its fills go to The Desk)");
        Check((File_("accounts-detail.txt") ?? "").StartsWith(ChartBridgeAccounts.DetailHeader + "\n") && File_("accounts-detail.txt").Contains("\nconnected\t" + ((long)(t + 1000)).ToString() + "\tTEST-EVAL-1\n"), "0.5.1: accounts-detail.txt keeps when it was last seen connected");
        Check(File_("accounts.txt").Split('\n').Skip(1).Where(x => x.Length > 0).All(x => x.Split('\t').Length == 3), "0.5.1: accounts.txt keeps 0.5.0's exact 3-field lines (0.5.0 refuses the whole file for a 4th field)");
        // seen connected, then dropped: Gone in this session, still listed (exits and positions never stranded)
        Send(page, Trade("TEST-EVAL-1", "true"));
        e1.Connection.Status = ConnectionStatus.Disconnected;
        ChartBridgeAccounts.Tick(t + 2000);
        ChartBridgeAccounts.Tick(t + 12000);
        Account.All.Remove(e1);
        ChartBridgeAccounts.Tick(t + 13000);
        en = Entry(Accounts(), "TEST-EVAL-1");
        Check(en.Contains("\"state\":\"gone\"") && en.Contains("\"trade\":true") && !ChartBridgeAccounts.Checked("TEST-EVAL-1"), "0.5.1: seen connected, then dropped (and gone from NinjaTrader's list): listed Gone this session, its checkmark kept");
        // an F5 in the same NinjaTrader session: still listed (accounts-detail.txt says it was seen since NinjaTrader started)
        Restart();
        ChartBridgeAccounts.Tick(t + 14000);
        Check(Entry(Accounts(), "TEST-EVAL-1") != "", "0.5.1: a recompile in the same NinjaTrader session: still listed");
        // the next NinjaTrader session: remembered (accounts.txt keeps its checkmark) but not listed until it connects
        double t2 = t + 10100000;
        NewSession(t2 - 1000);
        ChartBridgeAccounts.Tick(t2);
        Check(Entry(Accounts(), "TEST-EVAL-1") == "" && System.Text.RegularExpressions.Regex.IsMatch(File_("accounts.txt"), "\ntrade\t[0-9]+\tTEST-EVAL-1\n"), "0.5.1: after a restart a remembered account that is not connected is not listed; accounts.txt keeps its checkmark");
        Account.All.Add(e1); e1.Connection.Status = ConnectionStatus.Connected;
        ChartBridgeAccounts.Tick(t2 + 1000);
        Check(ChartBridgeAccounts.Checked("TEST-EVAL-1") && Entry(Accounts(), "TEST-EVAL-1").Contains("\"trade\":true"), "0.5.1: it connects: listed again and trades with its kept checkmark");
        Send(page, Trade("TEST-EVAL-1", "false"));

        // pruning: off records not seen connected for 30 days; never trade or archived
        double day = 24 * 3600000.0, t3 = t2 + 100 * day;
        string txt = File_("accounts.txt");
        txt += "off\t" + ((long)(t3 - 31 * day)).ToString() + "\tOLD-OFF-1\n" + "trade\t" + ((long)(t3 - 400 * day)).ToString() + "\tOLD-TRADE-1\n" + "archived\t" + ((long)(t3 - 400 * day)).ToString() + "\tOLD-ARCH-1\n"
             + "off\t" + ((long)(t3 - 29 * day)).ToString() + "\tRECENT-OFF-1\n" + "off\t" + ((long)(t3 - 90 * day)).ToString() + "\tOLD-OFF-2\n";
        File.WriteAllText(Path.Combine(folder, "accounts.txt"), txt);
        File.AppendAllText(Path.Combine(folder, "accounts-detail.txt"), "connected\t" + ((long)(t3 - 5 * day)).ToString() + "\tOLD-OFF-2\n");
        NewSession(t3 - 1000);
        ChartBridgeAccounts.Tick(t3);
        Check(!InFile("OLD-OFF-1") && Log_().Contains("\tOLD-OFF-1\tforgotten\toff and not seen connected for 30 days\n"), "0.5.1: an off record not seen connected for 30 days is forgotten, logged");
        Check(InFile("OLD-TRADE-1") && InFile("OLD-ARCH-1"), "0.5.1: a trade or archived record is never forgotten, however old");
        Check(InFile("RECENT-OFF-1") && InFile("OLD-OFF-2"), "0.5.1: an off record seen in the last 30 days stays (by its time in accounts.txt, or accounts-detail.txt's last connected time)");
        Check(InFile("TEST-EVAL-1") && InFile("Sim101"), "0.5.1: the connected accounts stay");
        Check(ArchivedNow("OLD-ARCH-1"), "the archived list still offers OLD-ARCH-1 (Show)");
        ChartBridgeAccounts.Tick(t3 + 1000);
        Check(InFile("RECENT-OFF-1"), "pruning runs once an hour, not every second");
        double t4 = t3 + 3 * day;   // RECENT-OFF-1 is 32 days old now
        ChartBridgeAccounts.Tick(t4);
        Check(!InFile("RECENT-OFF-1") && InFile("OLD-TRADE-1"), "0.5.1: the hourly check forgets it once 30 days have passed");

        // Hide and Show
        Account e2 = NewOn("TEST-EVAL-2", ConnectionStatus.Connected), e3 = NewOn("TEST-EVAL-3", ConnectionStatus.Connected);
        double t5 = t4 + 1000;
        e2.Positions.Add(new Position { Instrument = mnq, MarketPosition = MarketPosition.Long, Quantity = 1, AveragePrice = 25000 });
        ChartBridgeAccounts.Tick(t5);
        Check(Entry(Accounts(), "TEST-EVAL-2").Contains("\"canHide\":false") && Entry(Accounts(), "TEST-EVAL-2").Contains("TEST-EVAL-2 has a position or working orders"), "0.5.1: with a position: canHide false, with why");
        Send(page, Hide("TEST-EVAL-2"));
        Check(Rejected("TEST-EVAL-2 has a position or working orders: only a flat account can be hidden (exits always work)") && !ArchivedNow("TEST-EVAL-2"), "0.5.1: Hide refused with a position");
        e2.Positions.Clear();
        Order wo = Working(e2, OrderAction.Buy, OrderType.Limit, 24990, 0, "placed in NinjaTrader");
        Send(page, Hide("TEST-EVAL-2"));
        Check(Rejected("TEST-EVAL-2 has a position or working orders") && !ArchivedNow("TEST-EVAL-2"), "0.5.1: Hide refused with a working order");
        wo.OrderState = OrderState.Cancelled;
        string botFile = Path.Combine(folder, "bot-account.txt"), cop = Path.Combine(folder, "copier.txt"), agent = Path.Combine(folder, "agent-a1-account.txt");
        File.WriteAllLines(botFile, new[] { "# ChartBridge bot account", "# written by ChartBridge", "account\tTEST-EVAL-2" });
        Send(page, Hide("TEST-EVAL-2"));
        Check(Rejected("TEST-EVAL-2 is the bot's account (the Bot tab): it cannot be hidden"), "0.5.1: Hide of the bot's account: refused");
        File.Delete(botFile);
        File.WriteAllLines(cop, new[] { "leader\tTEST-EVAL-2" });
        Send(page, Hide("TEST-EVAL-2"));
        Check(Rejected("TEST-EVAL-2 is the copier's leader: it cannot be hidden"), "0.5.1: Hide of the copier's leader: refused");
        File.WriteAllLines(cop, new[] { "leader\tSim101", "follower\tTEST-EVAL-2\ton\t1\tmicro\t" });
        Send(page, Hide("TEST-EVAL-2"));
        Check(Rejected("TEST-EVAL-2 is a copier follower: it cannot be hidden"), "0.5.1: Hide of a copier follower: refused");
        File.Delete(cop);
        File.WriteAllLines(agent, new[] { "# ChartBridge account for agent a1", "account\tTEST-EVAL-2" });
        Send(page, Hide("TEST-EVAL-2"));
        Check(Rejected("TEST-EVAL-2 is agent a1's account (the Agent tab): it cannot be hidden"), "0.5.1: Hide of an agent's account (agent-<id>-account.txt): refused");
        File.Delete(agent);
        Send(page, Trade("TEST-EVAL-2", "true"));
        sent.Clear();
        Send(page, Hide("TEST-EVAL-2"));
        Check(!sent.Any(x => x.Contains("\"type\":\"reject\"")) && ArchivedNow("TEST-EVAL-2") && Entry(Accounts(), "TEST-EVAL-2") == "" && Log_().Contains("\tTEST-EVAL-2\tarchived\tby the page\n"), "0.5.1: Hide of a flat, active, connected account: accepted, out of the list, logged");
        Check(!ChartBridgeOrders.AccountTradable("TEST-EVAL-2"), "0.5.1: hidden: no entries");
        for (int i = 1; i <= 30; i++) ChartBridgeAccounts.Tick(t5 + i * 1000);
        Check(ArchivedNow("TEST-EVAL-2") && Entry(Accounts(), "TEST-EVAL-2") == "", "0.5.1: hidden, connected and healthy for 30 s: stays archived");
        e2.Positions.Add(new Position { Instrument = mnq, MarketPosition = MarketPosition.Short, Quantity = 1, AveragePrice = 25000 });
        sent.Clear();
        ChartBridgeAccounts.Tick(t5 + 31000);
        en = Entry(Accounts(), "TEST-EVAL-2");
        Check(en.Contains("\"state\":\"active\"") && en.Contains("\"trade\":false") && sent.Any(x => x.Contains("\"level\":\"warn\"") && x.Contains("TEST-EVAL-2 was archived, but NinjaTrader shows a position or working orders on it")), "0.5.1: a hidden account NinjaTrader shows with a position: listed again at once, unchecked, warned (archiving never strands an exit)");
        string why;
        Check(ChartBridgeAccounts.FindForExit("TEST-EVAL-2", out why) != null, "0.5.1: its exits work again");
        e2.Positions.Clear();
        ChartBridgeAccounts.Tick(t5 + 32000);
        Send(page, Show("TEST-EVAL-2"));
        Check(Rejected("TEST-EVAL-2 is not archived"), "0.5.1: Show of an account not archived: refused");
        Send(page, Show("NO-SUCH-1"));
        Check(Rejected("no account NO-SUCH-1"), "0.5.1: Show of an unknown account: refused");
        Send(page, "{\"type\":\"accountUnarchive\",\"account\":\"TEST-EVAL-2\",\"confirm\":true}");
        Check(Rejected("unknown key"), "0.5.1: Show with any other key: refused (strict)");
        Send(page, "{\"type\":\"accountUnarchive\",\"account\":7}");
        Check(Rejected("accountUnarchive needs account"), "0.5.1: Show needs account as a plain string");
        Send(page, Hide("TEST-EVAL-2"));
        ChartBridgeClient anon = new ChartBridgeClient(null, 48); anon.Origin = "http://localhost:8765"; List<string> ga = new List<string>(); anon.Tap = x => ga.Add(x);
        Clients()[48] = anon;
        Send(anon, Show("TEST-EVAL-2"));
        Check(ga.Any(x => x.Contains("\"type\":\"reject\"")) && ArchivedNow("TEST-EVAL-2"), "0.5.1: Show needs a signed-in page");
        ChartBridgeClient gone; Clients().TryRemove(48, out gone);
        Send(page, Show("TEST-EVAL-2"));
        en = Entry(Accounts(), "TEST-EVAL-2");
        Check(!ArchivedNow("TEST-EVAL-2") && en.Contains("\"state\":\"active\"") && en.Contains("\"trade\":false") && !ChartBridgeAccounts.Checked("TEST-EVAL-2") && Log_().Contains("\tTEST-EVAL-2\tshown\tby the page; unchecked\n"), "0.5.1: Show: active and unchecked, logged");
        // Hide of a Gone account that NinjaTrader no longer lists: by what ChartBridge last saw
        Account.All.Remove(e3);
        sent.Clear();
        Send(page, Hide("TEST-EVAL-3"));
        Check(!sent.Any(x => x.Contains("\"type\":\"reject\"")) && ArchivedNow("TEST-EVAL-3"), "0.5.1: Hide of an account NinjaTrader no longer lists, last seen flat: accepted");
        Send(page, Show("TEST-EVAL-3"));
        Account.All.Add(e3);
        e3.Positions.Add(new Position { Instrument = mnq, MarketPosition = MarketPosition.Long, Quantity = 1, AveragePrice = 25000 });
        ChartBridgeAccounts.Tick(t5 + 33000);
        Account.All.Remove(e3);
        Send(page, Hide("TEST-EVAL-3"));
        Check(Rejected("TEST-EVAL-3 was last seen with a position or working orders: only a flat account can be hidden"), "0.5.1: Hide of an account NinjaTrader no longer lists, last seen with a position: refused");
        Account.All.Add(e3); e3.Positions.Clear();
        ChartBridgeAccounts.Tick(t5 + 34000);

        // the one-time conversion of the old accounts line
        ChartBridgeConfig.OldAccounts = new List<string> { "Sim101", "FUNDED*", "TEST-EVAL-1" };
        Account e4 = NewOn("TEST-EVAL-4", ConnectionStatus.Connected);
        e3.Positions.Add(new Position { Instrument = mnq, MarketPosition = MarketPosition.Long, Quantity = 1, AveragePrice = 25000 });
        Send(page, Trade("TEST-EVAL-1", "true"));
        Send(page, Trade("EVAL-A", "true"));   // checked, not on the old line
        bool evalWas = ChartBridgeAccounts.Checked("EVAL-A"), fundedWas = ChartBridgeAccounts.Checked("FUNDED-B");
        int said = NinjaTrader.Code.Output.Lines.Count;
        Restart();
        double t6 = t5 + 40000;
        ChartBridgeAccounts.Tick(t6);
        List<string> outLines = NinjaTrader.Code.Output.Lines.Skip(said).ToList();
        Check(outLines.Count(x => x.Contains("config.txt: the accounts line is read once now (ChartBridge 0.5.1)")) == 1, "0.5.1: the first run with the accounts line: one Output line says it is read once now");
        Check(ArchivedNow("TEST-EVAL-2") && ArchivedNow("TEST-EVAL-4") && Log_().Contains("\tTEST-EVAL-2\thidden\tnot on the old accounts list\n") && Log_().Contains("\tTEST-EVAL-4\thidden\tnot on the old accounts list\n"), "0.5.1: conversion: connected accounts the old line does not name are hidden, logged");
        Check(!ArchivedNow("Sim101") && !ArchivedNow("FUNDED-B") && !ArchivedNow("TEST-EVAL-1") && ChartBridgeAccounts.Checked("TEST-EVAL-1") && ChartBridgeAccounts.Checked("EVAL-A") == evalWas && ChartBridgeAccounts.Checked("FUNDED-B") == fundedWas, "0.5.1: conversion: the accounts it names keep their checkmarks exactly");
        Check(evalWas && !ArchivedNow("EVAL-A"), "0.5.1: conversion: a checked account is kept (0.5.0 always watched the accounts the chart may trade)");
        Check(!ArchivedNow("TEST-EVAL-3") && Log_().Contains("\tTEST-EVAL-3\tnot hidden\tnot on the old accounts list, but TEST-EVAL-3 has a position or working orders"), "0.5.1: conversion: one with a position is not hidden (logged why)");
        Check(!old.Any(a => InFile(a.Name)), "0.5.1: conversion: the never-connected accounts are untouched");
        Check((File_("accounts-detail.txt") ?? "").Contains("\nconverted\t"), "0.5.1: the conversion is marked in accounts-detail.txt");
        Send(page, Show("TEST-EVAL-2"));
        Account e5 = NewOn("TEST-EVAL-5", ConnectionStatus.Connected);
        ChartBridgeAccounts.Tick(t6 + 1000);
        Check(!ArchivedNow("TEST-EVAL-2") && ArchivedNow("TEST-EVAL-5"), "0.5.1: conversion: each account is looked at once (a Show stays); one connecting later in that run is hidden too");
        said = NinjaTrader.Code.Output.Lines.Count;
        Restart();
        Account e6 = NewOn("TEST-EVAL-6", ConnectionStatus.Connected);
        ChartBridgeAccounts.Tick(t6 + 2000);
        outLines = NinjaTrader.Code.Output.Lines.Skip(said).ToList();
        Check(!ArchivedNow("TEST-EVAL-6") && Entry(Accounts(), "TEST-EVAL-6").Contains("\"trade\":false") && outLines.Count(x => x.Contains("config.txt: the accounts line is ignored since ChartBridge 0.5.1")) == 1, "0.5.1: the next run: the line is ignored (one Output line), a new account appears by itself");
        File.Delete(Path.Combine(folder, "accounts-detail.txt"));
        Restart();
        Account e7 = NewOn("TEST-EVAL-7", ConnectionStatus.Connected);
        ChartBridgeAccounts.Tick(t6 + 3000);
        Check(!ArchivedNow("TEST-EVAL-7"), "0.5.1: accounts-detail.txt lost: accounts.log's converted line keeps the conversion from running twice");
        ChartBridgeConfig.OldAccounts = null;

        // a 0.5.0 accounts.txt (3 fields) with no accounts-detail.txt loads; a detail file with lines it does not know is fine
        Send(page, Trade("TEST-EVAL-1", "true"));
        File.Delete(Path.Combine(folder, "accounts-detail.txt"));
        Restart();
        Check(ChartBridgeAccounts.Checked("TEST-EVAL-1") && ChartBridgeAccounts.Checked("Sim101"), "0.5.1: a 0.5.0 accounts.txt (3 fields) with no accounts-detail.txt loads as before");
        File.WriteAllText(Path.Combine(folder, "accounts-detail.txt"), ChartBridgeAccounts.DetailHeader + "\nsomething\tnew\tTEST-EVAL-1\nbroken line\nconnected\tnot-a-time\tTEST-EVAL-1\n");
        Restart();
        ChartBridgeAccounts.Tick(t6 + 4000);
        Check(ChartBridgeAccounts.Checked("TEST-EVAL-1") && Entry(Accounts(), "TEST-EVAL-1") != "", "0.5.1: accounts-detail.txt with lines ChartBridge does not know: skipped, the checkmarks load");
        e3.Positions.Clear();
        foreach (Account a in old.Concat(new[] { e1, e2, e3, e4, e5, e6, e7 })) Account.All.Remove(a);
    }
}
