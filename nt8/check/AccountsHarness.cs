// ChartBridge 0.4.0 accounts on Mono (inside check:orders): the per-account checkmark as gate 2 (accountChecks = on), the
// first-start pre-check from tradeAccounts, accounts.txt missing or unreadable (nothing checked, never rewritten), the 10 s
// grace before Gone, Gone turning trading off for that account only, Archive only with confirm and only when Gone, the
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
        List<string> allowWas = ChartBridgeConfig.AccountAllow;
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
        }
        catch (Exception ex) { Check(false, "accounts harness threw: " + ex); }
        finally
        {
            try { AccountsCall("UnwatchStatus"); } catch (Exception) { }
            OrdersHarness.AllOffLines();
            ChartBridgeAccounts.Clear();
            ChartBridgeOrders.ResetConfig();
            ChartBridgeConfig.AccountAllow = allowWas;
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
        ChartBridgeConfig.AccountAllow = new List<string>();
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
            foreach (string f in new[] { "accounts.txt", "accounts.log" }) File.Delete(Path.Combine(folder, f));   // the rest starts from a first start
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
        ChartBridgeConfig.AccountAllow = new List<string> { "Sim101", "FUNDED-B" };
        Send(page, "{\"type\":\"flatten\",\"account\":\"EVAL-A\",\"root\":\"MNQ\"}");
        Check(Rejected("not watched") && evalA.Calls.Count == calls + 3, "exits only on a watched account");
        ChartBridgeConfig.AccountAllow = new List<string>();
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
    static void NotYetConnected()
    {
        Check(ChartBridgeAccounts.Checked("EVAL-A") && ChartBridgeAccounts.Checked("FUNDED-B"), "EVAL-A and FUNDED-B checked before the restart");
        evalA.Connection.Status = ConnectionStatus.Disconnected;
        Account.All.Remove(fundedB);   // its connection not up yet: NinjaTrader does not list it
        Restart();
        double t = ChartBridgeTime.NowUtcMs() + 50000;
        ChartBridgeAccounts.Tick(t);
        ChartBridgeAccounts.Tick(t + 30000);
        ChartBridgeAccounts.Tick(t + 60000);
        Check(ChartBridgeAccounts.Checked("EVAL-A") && ChartBridgeAccounts.Checked("FUNDED-B"), "restart, not connected for 60 s: the saved checkmarks stay (never connected this run, not Gone)");
        string acc = ChartBridgeAccounts.AccountsJson(Account.All.ToList(), 0), e = Entry(acc, "EVAL-A");
        Check(e.Contains("\"connection\":\"disconnected\"") && e.Contains("\"notConnectedYet\":true") && e.Contains("\"state\":\"active\"") && e.Contains("\"trade\":true") && e.Contains("\"tradable\":false") && e.Contains("the account is not connected yet"), "not connected yet: listed so, checked, not tradable");
        Check(Entry(acc, "FUNDED-B").Contains("\"notConnectedYet\":true"), "an account NinjaTrader does not list yet: not connected yet too");
        int calls = evalA.Calls.Count;
        Send(page, Order("EVAL-A", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("EVAL-A is not connected (Disconnected)") && evalA.Calls.Count == calls, "not connected yet: an order is refused by the normal gate");
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
        Check(!ChartBridgeAccounts.Checked("FUNDED-B") && ChartBridgeAccounts.Checked("EVAL-A") && Entry(ChartBridgeAccounts.AccountsJson(Account.All.ToList(), 0), "FUNDED-B").Contains("\"goneWhy\":\"disconnected\""), "connected, then dropped for 10 s: Gone, the checkmark lost (that account only)");
        fundedB.Connection.Status = ConnectionStatus.Connected;
        ChartBridgeAccounts.Tick(t + 73000);
        Send(page, Trade("FUNDED-B", "true"));
        // disabled at first sight, never connected: Gone after the grace all the same
        sim.Connection.Status = ConnectionStatus.Disconnected;
        Restart();
        Account.FireStatus(sim, AccountStatus.Disabled);
        ChartBridgeAccounts.Tick(t + 80000);
        ChartBridgeAccounts.Tick(t + 90000);
        Check(!ChartBridgeAccounts.Checked("Sim101") && ChartBridgeAccounts.Checked("EVAL-A"), "disabled at first sight (never connected): Gone after the grace");
        Account.FireStatus(sim, AccountStatus.Enabled);
        sim.Connection.Status = ConnectionStatus.Connected;
        ChartBridgeAccounts.Tick(t + 91000);
        Send(page, Trade("Sim101", "true"));
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
        Check(!ChartBridgeAccounts.Checked("EVAL-A"), "lost for 10 s without a break: Gone, the checkmark off");
        Check(ChartBridgeAccounts.Checked("FUNDED-B") && ChartBridgeAccounts.Checked("Sim101"), "Gone turns trading off for that account only");
        Check(System.Text.RegularExpressions.Regex.IsMatch(File_("accounts.txt"), "\noff\t[0-9]+\tEVAL-A\n"), "Gone: the checkmark off is saved");
        Check((File_("accounts.log") ?? "").Contains("\tEVAL-A\tgone\tdisconnected for 10 s; unchecked: trading is off for it\n"), "Gone: logged");
        Check(sent.Any(x => x.Contains("\"level\":\"warn\"") && x.Contains("EVAL-A is gone (disconnected for 10 s): trading is off for it")) && sentV2.Any(x => x.Contains("EVAL-A is gone")), "Gone: a status warn to the signed-in pages");
        string e = Entry(Accounts(), "EVAL-A");
        Check(e.Contains("\"connection\":\"lost\"") && e.Contains("\"trade\":false") && e.Contains("\"tradable\":false") && e.Contains("\"state\":\"gone\"") && e.Contains("\"goneWhy\":\"disconnected\"") && !e.Contains("\"goneSince\":null"), "Gone: listed as gone, why and since");
        Check(sent.Any(x => x.StartsWith("{\"type\":\"trading\"") && !x.Contains("EVAL-A")), "Gone: trading sent again without EVAL-A");
        int calls = evalA.Calls.Count;
        Send(page, Order("EVAL-A", "\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("EVAL-A is gone (disconnected)") && evalA.Calls.Count == calls, "Gone: entry refused");
        evalA.Connection.Status = ConnectionStatus.Connected;
        Send(page, Trade("EVAL-A", "true"));
        Check(Rejected("EVAL-A is gone") && !ChartBridgeAccounts.Checked("EVAL-A"), "Gone: accountTrade on refused until it is back");
        ChartBridgeAccounts.Tick(t + 21500);
        e = Entry(Accounts(), "EVAL-A");
        Check(e.Contains("\"state\":\"active\"") && e.Contains("\"trade\":false") && !ChartBridgeAccounts.Checked("EVAL-A"), "back: active again, the checkmark still off");
        Check((File_("accounts.log") ?? "").Contains("\tEVAL-A\tactive again\t"), "back: logged");
        Send(page, Trade("EVAL-A", "true"));
        Check(ChartBridgeAccounts.Checked("EVAL-A"), "back: Anthony checks it again");
        // an account that NinjaTrader no longer lists (its connection is off) goes Gone too
        Account.All.Remove(evalA);
        ChartBridgeAccounts.Tick(t + 30000);
        ChartBridgeAccounts.Tick(t + 40001);
        Check(!ChartBridgeAccounts.Checked("EVAL-A") && Entry(Accounts(), "EVAL-A").Contains("\"connection\":\"disconnected\"") && Entry(Accounts(), "EVAL-A").Contains("\"balance\":null"), "an account missing from NinjaTrader: Gone (disconnected), money null");
    }

    // ------------------------------------------------------------ Archive: only with confirm, only when Gone
    static void Archive()
    {
        Send(page, "{\"type\":\"accountArchive\",\"account\":\"EVAL-A\"}");
        Check(Rejected("Archive needs confirm: true"), "archive without confirm: refused");
        Send(page, "{\"type\":\"accountArchive\",\"account\":\"EVAL-A\",\"confirm\":false}");
        Check(Rejected("Archive needs confirm: true") && !File_("accounts.txt").Contains("archived"), "archive with confirm false: refused");
        Send(page, "{\"type\":\"accountArchive\",\"account\":\"FUNDED-B\",\"confirm\":true}");
        Check(Rejected("FUNDED-B is not gone; only a gone account can be archived"), "archive of an active account: refused");
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
        string e = Entry(Accounts(), "EVAL-A");
        Check(e.Contains("\"state\":\"active\"") && e.Contains("\"trade\":false") && !ChartBridgeAccounts.Checked("EVAL-A") && File_("accounts.log").Contains("\tEVAL-A\tback from the archive\t"), "archived and connected again: back as active, unchecked, logged");
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
        Check(Entry(Accounts(), "FUNDED-B").Contains("\"state\":\"active\""), "enabled again: active, unchecked");
        Send(page, Trade("FUNDED-B", "true"));
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
        Check(!ChartBridgeAccounts.Checked("Sim101") && Entry(Accounts(), "Sim101").Contains("\"goneWhy\":\"drawdown\""), "past the trailing drawdown for 10 s: Gone (drawdown)");
        Check(ChartBridgeAccounts.Checked("EVAL-A") && ChartBridgeAccounts.Checked("FUNDED-B"), "drawdown: the other accounts keep their checkmark");
        sim.Items[AccountItem.TrailingMaxDrawdown] = 500;
        ChartBridgeAccounts.Tick(t + 11000);
        Send(page, Trade("Sim101", "true"));
        Check(ChartBridgeAccounts.Checked("Sim101"), "room again: back, and checked again by the page");
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
}
