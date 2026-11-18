// ChartBridge 0.4.0 on Mono (inside check:orders): the bot channel (nt8/ChartBridgeBot.cs, PROTOCOL.md "Bot channel"). A MADE-UP
// bot only ("Demo Opening Fade"): its signals are written here by hand, nothing here is a real bot's rule or market data.
// Every refusal must never reach the stand-in accounts: an order on any account but the bot's chosen one in every mode (release 1,
// step 1.6b: the bot trades only the personal account picked on the chart page; OWN-1, a made-up live account, is that pick here,
// OWN-2 a second made-up live account, EVAL-A a made-up prop account and Sim101 a Sim account, both refused), shadow sends
// nothing, an unanswered proposal is never sent, an accepted one is placed from its own parameters through the gates, the rails
// (set on the Bot tab and fail closed: the size up to the hard ceiling only, trades, losing trades, the day's loss and profit
// stops; the kill switch, one trade at a time), the day stops (flatten, latch, Shadow), the heartbeat (unfilled entries cancelled,
// stops and targets kept, never a flatten), the secret (wrong or missing: refused; never printed), and the off line (404, every
// message refused).
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript.AddOns;

public static class BotHarness
{
    static Action<bool, string> Check;
    const BindingFlags PS = BindingFlags.NonPublic | BindingFlags.Static;
    static readonly List<string> page = new List<string>(), page2 = new List<string>(), botOut = new List<string>();
    static ChartBridgeClient pc, pc2, bc;
    static Account own, own2, eval, simA;
    // release 1 (1.6b): every rail set, as Anthony sets them on the Bot tab (made-up values)
    static readonly string[] RailsLines = { "# made-up", "# test", "size\t1", "maxTrades\t5", "maxLosses\t3", "dayLoss\t500", "dayProfit\t500", "root\tMNQ" };
    static string RailsMsg(int size, int trades, int losses, string dayLoss, string dayProfit, string root)
    {
        return "{\"type\":\"botRails\",\"cid\":\"r\",\"size\":" + size + ",\"maxTrades\":" + trades + ",\"maxLosses\":" + losses + ",\"dayLoss\":" + dayLoss + ",\"dayProfit\":" + dayProfit + ",\"root\":\"" + root + "\"}";
    }
    static void Pick(string name)   // the personal account as the chart page's Accounts tab saves it (personal-account.txt); null: no pick
    {
        string f = Path.Combine(home, "ChartBridge", "personal-account.txt");
        if (name == null) Gone(f); else File.WriteAllLines(f, new[] { "# made-up", "# test", "account\t" + name });
        ChartBridgeBranches.LoadPersonal();
    }
    static Instrument mnq, nq;
    static double clock = 1791380800000;
    static DateTime et = new DateTime(2026, 10, 7, 10, 0, 0);
    static string home, token;
    static int sigN;

    static ConcurrentDictionary<int, ChartBridgeClient> Clients() { return (ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", PS).GetValue(null); }
    static Dictionary<string, Instrument> Named() { return (Dictionary<string, Instrument>)typeof(ChartBridgeServer).GetField("Instruments", PS).GetValue(null); }
    static string Last(List<string> l, string type) { lock (l) { for (int i = l.Count - 1; i >= 0; i--) if (l[i].StartsWith("{\"type\":\"" + type + "\"")) return l[i]; } return ""; }
    static int Count(List<string> l, string type) { lock (l) return l.Count(x => x.StartsWith("{\"type\":\"" + type + "\"")); }
    static List<string> Calls(Account a, int from) { return a.Calls.Skip(from).ToList(); }
    static bool Logged(string has) { lock (NinjaTrader.Code.Output.Lines) return NinjaTrader.Code.Output.Lines.Any(x => x.Contains(has)); }
    static string File_(string name) { try { return File.ReadAllText(Path.Combine(home, "ChartBridge", name)); } catch (Exception) { return ""; } }

    static void Page(string json) { lock (pc.Actions) pc.Actions.Clear(); ChartBridgeServer_OnClientMessage(pc, json); }
    static void ChartBridgeServer_OnClientMessage(ChartBridgeClient c, string json) { typeof(ChartBridgeServer).GetMethod("OnClientMessage", PS).Invoke(null, new object[] { c, json }); }
    static void Bot(string json) { clock += 150; ChartBridgeBot.OnBotMessage(bc, json); }   // the bot's own pace: well inside 10 a second
    static string PageReject() { return Last(page, "reject"); }
    static string BotReject() { return Last(botOut, "reject"); }

    static string Sig(string id, string rest) { return "{\"type\":\"signal\",\"id\":\"" + id + "\",\"action\":\"fired\"," + rest + ",\"reason\":\"Sample: price stalled at the made-up level twice\"}"; }
    static string NewId() { return "demo-" + (++sigN); }
    static string Market(string side) { return "\"side\":\"" + side + "\",\"kind\":\"market\",\"stopTicks\":8,\"targetTicks\":16"; }

    static Order Newest(Account a) { return a.Orders.Count > 0 ? a.Orders[a.Orders.Count - 1] : null; }
    static string Tag(Order o) { return Regex.Match(o.Name ?? "", "^CB#([0-9a-f]{8}) ").Groups[1].Value; }

    static void Update(Order o) { ChartBridgeOrders.OnOrderUpdate(o.Account, new OrderEventArgs { Order = o }); }
    static void Deliver(string account, Instrument inst, MarketPosition side, int qty, double price, string orderId)
    {
        typeof(ChartBridgeServer).GetMethod("Deliver", PS).Invoke(null, new object[] { account, inst, side, qty, price, DateTime.Now, "x" + Guid.NewGuid().ToString("N"), orderId, null });
    }
    // The entry fills (its order event: legs go on), then NinjaTrader's execution for it.
    static void FillEntry(Order o, double price)
    {
        o.OrderId = "NT" + Guid.NewGuid().ToString("N").Substring(0, 8);
        o.Filled = o.Quantity; o.AverageFillPrice = price; o.OrderState = OrderState.Filled;
        Update(o);
        Deliver(o.Account.Name, o.Instrument, o.OrderAction == OrderAction.Buy ? MarketPosition.Long : MarketPosition.Short, o.Quantity, price, o.OrderId);
    }
    // Release 1 (1.6b, review R12 finding 1): the entry fills part way (filled in all so far), then NinjaTrader's execution for qty.
    static void PartFill(Order o, int filled, int qty, double price)
    {
        if (o.OrderId == null) o.OrderId = "NT" + Guid.NewGuid().ToString("N").Substring(0, 8);
        o.Filled = filled; o.AverageFillPrice = price; o.OrderState = filled >= o.Quantity ? OrderState.Filled : OrderState.PartFilled;
        Update(o);
        Deliver(o.Account.Name, o.Instrument, o.OrderAction == OrderAction.Buy ? MarketPosition.Long : MarketPosition.Short, qty, price, o.OrderId);
    }
    // Review R12 round 3: an entry's stop and target done (the stop filled, the target cancelled), as while ChartBridge was down.
    static void LegsDone(Order entry)
    {
        foreach (Order o in own.Orders.ToList())
            if (o != entry && Tag(o) == Tag(entry) && ChartBridgeOrders.IsWorking(o.OrderState))
                o.OrderState = o.OrderType == OrderType.StopMarket ? OrderState.Filled : OrderState.Cancelled;
    }
    // An execution that is not the bot's entry (a leg, a flatten), qty the other way from a buy entry.
    static void Sold(int qty, double price) { Deliver(own.Name, mnq, MarketPosition.Short, qty, price, "X" + Guid.NewGuid().ToString("N").Substring(0, 6)); }
    // The position closes (a leg, or anything else): an execution the other way, then nothing left working or held.
    static void Exit(Order entry, double price)
    {
        Deliver(entry.Account.Name, entry.Instrument, entry.OrderAction == OrderAction.Buy ? MarketPosition.Short : MarketPosition.Long, entry.Quantity, price, "EXIT" + Guid.NewGuid().ToString("N").Substring(0, 6));
        Settle();
    }
    // Every order done and the fills booked, so the next trade starts flat (the stand-in has no broker to do it).
    static void Settle()
    {
        foreach (Order o in own.Orders.ToList()) if (ChartBridgeOrders.IsWorking(o.OrderState)) { o.OrderState = OrderState.Cancelled; Update(o); }
        own.Positions.Clear();
        FieldInfo moves = typeof(ChartBridgeOrders).GetField("Moves", PS);
        ((System.Collections.IDictionary)moves.GetValue(null)).Clear();
    }

    static Account NewAccount(string name, Provider p)
    {
        Account a = new Account { Name = name, Provider = p, Connection = new Connection { Status = ConnectionStatus.Connected } };
        Account.All.Add(a);
        return a;
    }

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        List<Account> accountsWas = Account.All.ToList();
        Dictionary<string, Instrument> namedWas = new Dictionary<string, Instrument>(Named());
        Dictionary<int, ChartBridgeClient> clientsWas = Clients().ToDictionary(kv => kv.Key, kv => kv.Value);
        string dirWas = NinjaTrader.Core.Globals.UserDataDir;
        int portWas = ChartBridgeConfig.Port;
        try
        {
            Setup();
            SwitchOff();
            Secret();
            Shadow();
            NeverAnotherAccount();
            Copilot();
            WithdrawDuringPlacement();   // review 2 finding 7
            Auto();
            Size();
            GroupRefusal();   // 0.5.8: one direction per group refuses a bot entry too
            Losses();
            FiveTrades();
            KillSwitch();
            Heartbeat();
            BotFlatten();
            Rails();
            FailClosed();    // release 1 (1.6b): a rail not set, 0, none or unreadable: no arming, no entry
            SizeCeiling();   // release 1 (1.6b): the Bot tab's size, the hard ceiling only (never config.txt's maxQty)
            DayStops();      // release 1 (1.6b): the day's loss and profit stops: flatten, latch, Shadow
            LateFill();      // review R12 finding 1: an entry's late fill after its trade closed is followed, and flattened again at a day stop
            ReArmRace();     // review R12 finding 2: a day stop reached while the page arms the bot: refused, never armed by itself
            OpenAtRestart(); // review R12 round 2: a bot trade open across a restart is followed again from NinjaTrader's position
            DayFile();       // R12 (the day file): a part exit, a reopen, an older build's line, a size changed unseen, a file that does not read
            ChosenAccount();
            NoneAndReset();   // 0.5.7: None (DECISION 2026-10-14e) and the 17:00 ET reset
            V2PageGetsNothing();
            Http();
            OffAgain();
        }
        finally
        {
            try { Pick(null); } catch (Exception) { }   // no personal pick left for the harnesses after this one
            ChartBridgeBot.Stop();
            ChartBridgeBot.ResetConfig();
            ChartBridgeBot.ClockMs = null; ChartBridgeBot.ClockEt = null; ChartBridgeBot.ModeArmChecked = null;
            ChartBridgeOrders.ResetConfig();
            Account.All.Clear(); Account.All.AddRange(accountsWas);
            Named().Clear(); foreach (KeyValuePair<string, Instrument> kv in namedWas) Named()[kv.Key] = kv.Value;
            Clients().Clear(); foreach (KeyValuePair<int, ChartBridgeClient> kv in clientsWas) Clients()[kv.Key] = kv.Value;
            NinjaTrader.Core.Globals.UserDataDir = dirWas;
            ChartBridgeConfig.Port = portWas;
        }
    }

    static void Setup()
    {
        home = Path.Combine(Path.GetTempPath(), "cb-bot-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(home, "ChartBridge"));
        // 0.5.7: no bot-account.txt is None (nothing trades); the sections before ChosenAccount trade OWN-1, chosen as Anthony would
        File.WriteAllLines(Path.Combine(home, "ChartBridge", "bot-account.txt"), new[] { "# made-up", "# test", "account\tOWN-1" });
        File.WriteAllLines(Path.Combine(home, "ChartBridge", "bot-rails.txt"), RailsLines);   // release 1 (1.6b): fail closed, so the sections before FailClosed run with every rail set
        NinjaTrader.Core.Globals.UserDataDir = home;
        ChartBridgeConfig.Port = 8765;
        ChartBridgeBot.ClockMs = () => clock;
        ChartBridgeBot.ClockEt = () => et;
        mnq = new Instrument { FullName = "MNQ 12-26", MasterInstrument = new MasterInstrument { Name = "MNQ", TickSize = 0.25, PointValue = 2 } };
        nq = new Instrument { FullName = "NQ 12-26", MasterInstrument = new MasterInstrument { Name = "NQ", TickSize = 0.25, PointValue = 20 } };
        Named().Clear(); Named()["MNQ"] = mnq; Named()["NQ"] = nq;
        Account.All.Clear();
        own = NewAccount("OWN-1", Provider.Rithmic);    // release 1 (1.6b): the made-up personal account (live): the bot's
        own2 = NewAccount("OWN-2", Provider.Rithmic);   // a second made-up live account, the personal pick in some cases
        eval = NewAccount("EVAL-A", Provider.Rithmic);  // a made-up evaluation account: prop, never the bot's
        simA = NewAccount("Sim101", Provider.Simulator); // NinjaTrader's simulator: refused for now (Sim later)
        Pick("OWN-1");
        ChartBridgeOrders.ResetConfig();
        ChartBridgeOrders.ReadConfig("trading", "true");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "OWN-1, OWN-2, EVAL-A, Sim101");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "3");   // the ticket's cap; release 1 (1.6b): never the bot's
        ChartBridgeOrders.NoteLast("MNQ", 25000); ChartBridgeOrders.NoteLast("NQ", 25000);
        ChartBridgeOrders.NewToken();
        token = ChartBridgeOrders.SessionJson().Split('"')[3];
        Clients().Clear();
        pc = new ChartBridgeClient(null, 501) { Origin = "http://localhost:8765" };
        pc.Tap = s => { lock (page) page.Add(s); };
        pc2 = new ChartBridgeClient(null, 502) { Origin = "http://localhost:8765" };
        pc2.Tap = s => { lock (page2) page2.Add(s); };
        Clients()[501] = pc; Clients()[502] = pc2;
        ChartBridgeServer_OnClientMessage(pc, "{\"type\":\"client\",\"v\":3}");
        Check(ChartBridgeV3.IsV3(pc), "client v3: the page speaks protocol v3");
        ChartBridgeServer_OnClientMessage(pc2, "{\"type\":\"client\",\"v\":2}");
        Check(!ChartBridgeV3.IsV3(pc2) && Last(page2, "status").Contains("ChartBridge refused a client message"), "client with v other than 3: refused with a status warn, still a v2 page");
        ChartBridgeServer_OnClientMessage(pc, "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
        ChartBridgeServer_OnClientMessage(pc2, "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
        Check(pc.Trader && pc2.Trader, "both pages signed in");
    }

    // ------------------------------------------------------------ on by default; the off line: /bot is 404, everything refused
    static void SwitchOff()
    {
        File.WriteAllLines(Path.Combine(home, "ChartBridge", "config.txt"), new[] { "trading = true" });
        ChartBridgeConfig.Load();
        Check(ChartBridgeBot.Enabled && ChartBridgeV3.SwitchesJson().Contains("\"bot\":true"), "bot is ON by default (no bot line in config.txt; Anthony 2026-10-07)");
        File.WriteAllLines(Path.Combine(home, "ChartBridge", "config.txt"), new[] { "trading = true", "bot = off" });
        ChartBridgeConfig.Load();
        Check(!ChartBridgeBot.Enabled && ChartBridgeV3.SwitchesJson().Contains("\"bot\":false"), "bot = off turns it off (trading.switches.bot says so)");
        OrdersHarness.AllOffLines();   // the other v3 off lines too: this harness runs with gate 2 as tradeAccounts
        ChartBridgeOrders.ReadConfig("tradeAccounts", "OWN-1, OWN-2, EVAL-A, Sim101"); ChartBridgeOrders.ReadConfig("maxQty.MNQ", "3");
        ChartBridgeBot.Start(false);
        Check(!File.Exists(Path.Combine(home, "ChartBridge", "bot-secret.txt")), "off: no bot-secret.txt is made");
        Check(ChartBridgeBot.UpgradeCheck(null, "anything", true) == 404, "off: an upgrade to /bot answers 404");
        int n = own.Calls.Count;
        foreach (string m in new[] { "{\"type\":\"botMode\",\"cid\":\"m1\",\"mode\":\"auto\"}", "{\"type\":\"botKill\",\"cid\":\"k1\",\"on\":false}",
                                     "{\"type\":\"botAnswer\",\"cid\":\"a1\",\"id\":\"x\",\"answer\":\"accept\",\"at\":1}", "{\"type\":\"botRails\",\"cid\":\"r1\",\"maxTrades\":5,\"maxLosses\":3,\"root\":\"MNQ\"}",
                                     "{\"type\":\"botSeen\",\"id\":\"x\",\"at\":1}" })
        {
            Page(m);
            Check(PageReject().Contains("The bot channel is off (bot = off in config.txt)"), "off: " + m.Substring(9, 12) + "... refused");
        }
        Check(own.Calls.Count == n && eval.Calls.Count == 0 && Count(page, "bot") == 0, "off: nothing sent to NinjaTrader, no bot message to the page");
        foreach (string[] kv in new[] { new[] { "bot = yes", "False" }, new[] { "bot = On", "True" }, new[] { "bot = 1", "True" }, new[] { "bot = off", "False" }, new[] { "# no bot line", "True" } })
        {
            File.WriteAllLines(Path.Combine(home, "ChartBridge", "config.txt"), new[] { kv[0], "botRoot = mnq" });
            ChartBridgeConfig.Load();
            Check(ChartBridgeBot.Enabled.ToString() == kv[1] && ChartBridgeBot.ConfigRoot == "MNQ", "config.txt: " + kv[0] + " is " + kv[1] + "; botRoot upper-cased");
        }
        Check(Logged("config.txt: bot = yes is not off or on, so bot is OFF"), "config.txt: a value that is neither off nor on is off, with one Output line");
        OrdersHarness.AllOffLines();
        ChartBridgeOrders.ReadConfig("trading", "true"); ChartBridgeOrders.ReadConfig("tradeAccounts", "OWN-1, OWN-2, EVAL-A, Sim101"); ChartBridgeOrders.ReadConfig("maxQty.MNQ", "3");
    }

    // ------------------------------------------------------------ the secret: made on this PC, never printed; wrong or missing: refused
    static void Secret()
    {
        ChartBridgeSwitches.Note("bot", "on");   // integration: ChartBridgeConfig.Load records every v3 switch in ChartBridgeSwitches
        ChartBridgeBot.Start(false);
        string[] lines = File.ReadAllLines(Path.Combine(home, "ChartBridge", "bot-secret.txt"));
        string secret = lines.Length == 3 ? lines[2] : "";
        Check(lines.Length == 3 && lines[0].StartsWith("#") && lines[1].StartsWith("#") && Regex.IsMatch(secret, "^[0-9a-f]{64}$"), "bot-secret.txt: two # lines, then 64 hex characters");
        bool printed;
        lock (NinjaTrader.Code.Output.Lines) printed = NinjaTrader.Code.Output.Lines.Any(x => x.Contains(secret));
        Check(!printed && !ChartBridgeBot.DiagJson().Contains(secret) && ChartBridgeBot.DiagJson().Contains("\"secretFile\":\"ok\""), "the secret is never in the Output window or /diag");
        Check(ChartBridgeBot.UpgradeCheck("http://localhost:8765", secret, true) == 403, "an Origin header (a browser page), even ChartBridge's own: 403");
        Check(ChartBridgeBot.UpgradeCheck("", secret, true) == 403, "an empty Origin header: 403");
        Check(ChartBridgeBot.UpgradeCheck(null, secret.Substring(1) + "0", true) == 403 && ChartBridgeBot.UpgradeCheck(null, null, true) == 403 && ChartBridgeBot.UpgradeCheck(null, secret.ToUpperInvariant(), true) == 403,
              "a wrong or missing secret: 403");
        Check(ChartBridgeBot.UpgradeCheck(null, secret, false) == 400, "the right secret on a request that is not an upgrade: 400");
        Check(ChartBridgeBot.UpgradeCheck(null, secret, true) == 101, "no Origin and the right secret: the upgrade goes ahead");
        ChartBridgeBot.Stop(); ChartBridgeBot.Start(false);
        Check(File.ReadAllLines(Path.Combine(home, "ChartBridge", "bot-secret.txt"))[2] == secret && ChartBridgeBot.UpgradeCheck(null, secret, true) == 101, "a restart keeps the secret");
        // a file that cannot be understood is never written over: every bot is refused until it is fixed or deleted
        File.WriteAllText(Path.Combine(home, "ChartBridge", "bot-secret.txt"), "# torn\nabc\n");
        ChartBridgeBot.Stop(); ChartBridgeBot.Start(false);
        Check(ChartBridgeBot.UpgradeCheck(null, secret, true) == 403 && ChartBridgeBot.UpgradeCheck(null, "abc", true) == 403 && File_("bot-secret.txt") == "# torn\nabc\n" &&
              ChartBridgeBot.DiagJson().Contains("\"secretFile\":\"unreadable\""), "a broken bot-secret.txt: every bot refused, the file left as it is");
        Gone(Path.Combine(home, "ChartBridge", "bot-secret.txt"));
        ChartBridgeBot.Stop(); ChartBridgeBot.Start(false);
        string fresh = File.ReadAllLines(Path.Combine(home, "ChartBridge", "bot-secret.txt"))[2];
        Check(fresh != secret && ChartBridgeBot.UpgradeCheck(null, secret, true) == 403 && ChartBridgeBot.UpgradeCheck(null, fresh, true) == 101, "deleted: a new secret at the next start, the old one refused");

        bc = new ChartBridgeClient(null, ChartBridgeBot.BotClientId);
        bc.Tap = s => { lock (botOut) botOut.Add(s); };
        Check(ChartBridgeBot.Attach(bc), "a bot attaches");
        Check(ChartBridgeBot.UpgradeCheck(null, fresh, true) == 409 && !ChartBridgeBot.Attach(new ChartBridgeClient(null, -2)), "a second bot: 409");
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("send botHello first"), "a signal before botHello: refused");
        Bot("{\"type\":\"botHello\",\"name\":\"Demo Opening Fade\"}");
        string w = Last(botOut, "welcome");
        Check(w.Contains("\"mode\":\"shadow\"") && w.Contains("\"account\":\"OWN-1\",\"sim\":false") && w.Contains("\"root\":\"MNQ\"") &&
              w.Contains("\"rails\":{\"maxQty\":1,\"size\":1,\"maxTrades\":5,\"maxLosses\":3,\"dayLoss\":500,\"dayProfit\":500}") && w.Contains("\"name\":\"MNQ 12-26\""),
              "botHello: welcome (shadow, OWN-1 with sim false, MNQ, every rail from the Bot tab): " + w);
        Check(Last(page, "bot").Contains("\"connected\":true") && Last(page, "bot").Contains("\"name\":\"Demo Opening Fade\""), "the page's strip: connected, the bot's name");
        ChartBridgeBot.OnTick("{\"type\":\"tick\",\"root\":\"MNQ\",\"p\":25000.25,\"v\":1}");
        Check(Last(botOut, "tick").Contains("25000.25"), "the bot reads the live trades");
        Bot("{\"type\":\"beat\",\"extra\":1}");
        Check(BotReject().Contains("unknown key \\\"extra\\\" in beat"), "strict bot messages: an unknown key is refused");
        Bot("{\"type\":\"botHello\",\"name\":\"x\",\"name\":\"y\"}");
        Check(BotReject().Contains("key twice"), "strict bot messages: a key twice is refused");
        Bot("{\"type\":\"signal\",\"id\":\"q\\u0041\"}");
        Check(BotReject().Contains("escape"), "strict bot messages: an escape is refused");
    }

    // ------------------------------------------------------------ shadow: shown and logged; nothing sent
    static void Shadow()
    {
        int n = own.Calls.Count;
        string id = NewId();
        Bot(Sig(id, "\"side\":\"sell\",\"kind\":\"limit\",\"price\":25001,\"stopTicks\":12,\"targetTicks\":24"));
        string s = Last(page, "botSignal");
        Check(s.Contains("\"id\":\"" + id + "\"") && s.Contains("\"result\":\"shadow\"") && s.Contains("\"price\":25001") && s.Contains("\"stopTicks\":12"), "shadow: the signal shown with result shadow: " + s);
        Check(own.Calls.Count == n && eval.Calls.Count == 0, "shadow: NOTHING sent to NinjaTrader");
        Check(Last(page, "bot").Contains("\"lastSignal\":{\"type\":\"botSignal\",\"id\":\"" + id + "\""), "the strip carries the last signal");
        Check(File_("bot.log").Contains(id) && File_("bot.log").Contains("shadow"), "shadow: the signal is logged in bot.log");
        Bot(Sig(id, Market("buy")));
        Check(BotReject().Contains("already used today"), "a signal id twice in a day: refused");
        Bot("{\"type\":\"signal\",\"id\":\"" + NewId() + "\",\"action\":\"skipped\",\"reason\":\"Sample: range too small\"}");
        Check(Last(page, "botSignal").Contains("\"result\":\"skipped\""), "a skipped signal: shown as skipped");
        Bot("{\"type\":\"signal\",\"id\":\"" + NewId() + "\",\"action\":\"skipped\",\"reason\":\"Sample\",\"stopTicks\":8}");
        Check(BotReject().Contains("a skipped signal carries only"), "a skipped signal with order fields: refused");
        Bot(Sig(NewId(), "\"side\":\"buy\",\"kind\":\"market\",\"targetTicks\":16"));
        Check(BotReject().Contains("every bot entry needs a stop"), "no stopTicks: refused (every bot entry needs a stop)");
        Bot(Sig(NewId(), "\"side\":\"buy\",\"kind\":\"market\",\"stopTicks\":0,\"targetTicks\":16"));
        Check(BotReject().Contains("every bot entry needs a stop"), "stopTicks 0: refused");
        Bot(Sig(NewId(), "\"side\":\"buy\",\"kind\":\"market\",\"price\":25000,\"stopTicks\":8,\"targetTicks\":16"));
        Check(BotReject().Contains("a market signal takes no price"), "a market signal with a price: refused");
        Bot(Sig(NewId(), "\"side\":\"buy\",\"kind\":\"limit\",\"price\":\"25000\",\"stopTicks\":8,\"targetTicks\":16"));
        Check(BotReject().Contains("needs a plain price"), "a price as a string: refused");
        Bot(Sig(NewId(), "\"side\":\"buy\",\"kind\":\"stopLimit\",\"price\":25000,\"stopTicks\":8,\"targetTicks\":16"));
        Check(BotReject().Contains("kind must be market, limit or stop"), "another kind: refused");
        Check(own.Calls.Count == n && eval.Calls.Count == 0, "none of these reached NinjaTrader");
    }

    // ------------------------------------------------------------ a bot can never name an account: refused in every mode
    static void NeverAnotherAccount()
    {
        int n = own.Calls.Count;
        foreach (string mode in new[] { "shadow", "copilot", "auto", "shadow" })
        {
            Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"" + mode + "\"}");
            Check(Last(page, "bot").Contains("\"mode\":\"" + mode + "\""), "mode " + mode + " set from the page");
            Bot("{\"type\":\"signal\",\"id\":\"" + NewId() + "\",\"action\":\"fired\",\"account\":\"EVAL-A\",\"side\":\"buy\",\"kind\":\"market\",\"stopTicks\":8,\"targetTicks\":16,\"reason\":\"Sample\"}");
            Check(BotReject().Contains("unknown key \\\"account\\\""), mode + ": a signal naming an account is refused");
            Bot("{\"type\":\"signal\",\"id\":\"" + NewId() + "\",\"action\":\"fired\",\"root\":\"NQ\",\"side\":\"buy\",\"kind\":\"market\",\"stopTicks\":8,\"targetTicks\":16,\"reason\":\"Sample\"}");
            Check(BotReject().Contains("unknown key \\\"root\\\""), mode + ": a signal naming a root is refused");
            Bot("{\"type\":\"signal\",\"id\":\"" + NewId() + "\",\"action\":\"fired\",\"qty\":5,\"side\":\"buy\",\"kind\":\"market\",\"stopTicks\":8,\"targetTicks\":16,\"reason\":\"Sample\"}");
            Check(BotReject().Contains("unknown key \\\"qty\\\""), mode + ": a signal with a qty is refused");
        }
        Check(own.Calls.Count == n && eval.Calls.Count == 0, "no order reached any account");
        // release 1 (1.6b): the personal account (live, sim false) arms; the same account read as NinjaTrader's simulator is refused
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Check(Last(page, "bot").Contains("\"mode\":\"auto\"") && Last(page, "bot").Contains("\"account\":\"OWN-1\",\"sim\":false") && Last(page, "bot").Contains("\"personal\":true"),
              "auto: allowed on the personal account (live, sim false), marked personal in the strip");
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
        own.Provider = Provider.Simulator;
        foreach (string mode in new[] { "copilot", "auto" })
        {
            Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"" + mode + "\"}");
            Check(PageReject().Contains(mode + " refused: OWN-1 is a Sim account: the bot trades the personal account only (Sim comes back once the WORK check") && Last(page, "bot").Contains("\"mode\":\"shadow\""),
                  "release 1 (1.6b): " + mode + " refused while the bot's account reads as NinjaTrader's simulator (Sim later): " + PageReject());
        }
        own.Provider = Provider.Rithmic;
        ChartBridgeOrders.ReadConfig("tradeAccounts", "EVAL-A");
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Check(PageReject().Contains("auto refused: OWN-1 may not trade from the chart"), "auto: refused when the bot's account is not tradable (gate 2)");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "OWN-1, OWN-2, EVAL-A, Sim101");
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
        Check(own.Calls.Count == n && eval.Calls.Count == 0, "still nothing sent");
    }

    // ------------------------------------------------------------ copilot: a proposal; only Anthony's accept places it
    static void Copilot()
    {
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"copilot\"}");
        int n = own.Calls.Count;
        string a = NewId();
        Bot(Sig(a, "\"side\":\"sell\",\"kind\":\"limit\",\"price\":25001,\"stopTicks\":12,\"targetTicks\":24"));
        string p = Last(page, "botProposal");
        Check(p.Contains("\"id\":\"" + a + "\"") && p.Contains("\"state\":\"open\"") && p.Contains("\"account\":\"OWN-1\"") && p.Contains("\"qty\":1") && p.Contains("\"reason\":\"Sample: price stalled") &&
              p.Contains("\"seenAt\":null") && Last(page, "botSignal").Contains("\"result\":\"proposed\""), "copilot: a proposal with its reason to the signed-in page: " + p);
        Page("{\"type\":\"botSeen\",\"id\":\"" + a + "\",\"at\":1791380820450}");
        Check(Last(page, "botProposal").Contains("\"seenAt\":1791380820450"), "botSeen: the moment it showed is recorded");
        Page("{\"type\":\"botSeen\",\"id\":\"" + a + "\",\"at\":1791380829999}");
        Check(!Last(page, "botProposal").Contains("1791380829999"), "botSeen: only the first moment counts");
        for (int i = 0; i < 15; i++) { clock += 4000; Bot("{\"type\":\"beat\"}"); ChartBridgeBot.Check(); }   // a minute unanswered (the bot beating): still never sent
        Check(own.Calls.Count == n, "an unanswered proposal is never sent, however long it waits");
        Bot("{\"type\":\"withdraw\",\"id\":\"" + a + "\",\"reason\":\"Sample: price left the level\"}");
        Check(Last(page, "botProposal").Contains("\"state\":\"not answered\"") && Last(botOut, "answer").Contains("\"answer\":\"not answered\""), "withdraw: the proposal expires as not answered");
        Check(File_("bot.log").Contains("proposal " + a + " not answered"), "logged \"not answered\"");
        Page("{\"type\":\"botAnswer\",\"cid\":\"c1\",\"id\":\"" + a + "\",\"answer\":\"accept\",\"at\":1791380830000}");
        Check(PageReject().Contains("is not answered; it can no longer be answered") && own.Calls.Count == n, "accepting an expired proposal: refused, nothing sent");

        string b = NewId();
        Bot(Sig(b, "\"side\":\"sell\",\"kind\":\"limit\",\"price\":25001,\"stopTicks\":12,\"targetTicks\":24"));
        Page("{\"type\":\"botAnswer\",\"cid\":\"c2\",\"id\":\"" + b + "\",\"answer\":\"accept\",\"at\":1791380831000,\"price\":24000}");
        Check(PageReject().Contains("unknown key \\\"price\\\"") && own.Calls.Count == n, "the page cannot change the order: an answer with a price is refused");
        Page("{\"type\":\"botAnswer\",\"cid\":\"c3\",\"id\":\"" + b + "\",\"answer\":\"accept\",\"at\":1791380831500}");
        List<string> sent = Calls(own, n);
        Check(sent.Count == 1 && Regex.IsMatch(sent[0], "^submit CB#[0-9a-f]{8} bot s12 t24 Sell Limit 1 L25001 S0"), "accept: placed from the proposal's own parameters, 1 contract, on OWN-1: " + string.Join(" | ", sent));
        Check(eval.Calls.Count == 0, "accept: nothing on any other account");
        string pb = Last(page, "botProposal");
        Check(pb.Contains("\"state\":\"accepted\"") && pb.Contains("\"answeredAt\":1791380831500") && Last(botOut, "answer").Contains("\"answer\":\"accepted\""), "accept: recorded with the moment he answered; the bot is told");
        Update(Newest(own));
        Check(Last(botOut, "order").Contains("\"side\":\"sell\"") && Last(botOut, "order").Contains("\"kind\":\"limit\"") && Last(botOut, "order").Contains("\"role\":\"entry\""), "the bot gets its own order's updates: " + Last(botOut, "order"));
        Page("{\"type\":\"botAnswer\",\"cid\":\"c4\",\"id\":\"" + b + "\",\"answer\":\"reject\",\"at\":1791380832000}");
        Check(PageReject().Contains("is accepted"), "a second answer: refused");
        Settle();

        string c = NewId();
        Bot(Sig(c, Market("buy")));
        Page("{\"type\":\"botAnswer\",\"cid\":\"c5\",\"id\":\"" + c + "\",\"answer\":\"reject\",\"at\":1791380833000}");
        Check(Last(page, "botProposal").Contains("\"state\":\"rejected\"") && Last(botOut, "answer").Contains("\"answer\":\"rejected\"") && Calls(own, n).Count == 1, "reject: recorded, nothing sent");
        string d = NewId();
        Bot(Sig(d, Market("buy")));
        int m = own.Calls.Count;
        AfterAuthSeesOpenProposal(d);
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
        Check(Last(page, "botProposal").Contains("\"id\":\"" + d + "\"") && Last(page, "botProposal").Contains("\"state\":\"not answered\"") && own.Calls.Count == m, "leaving copilot: an open proposal expires as not answered, never sent");
    }

    // ------------------------------------------------------------ review 2 finding 7: a withdraw that arrives while an accept is being placed
    static void WithdrawDuringPlacement()
    {
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"copilot\"}");
        int n = own.Calls.Count;
        string id = NewId();
        Bot(Sig(id, "\"side\":\"sell\",\"kind\":\"limit\",\"price\":25001,\"stopTicks\":12,\"targetTicks\":24"));
        // the bot's withdraw reaches ChartBridge while NinjaTrader takes the accepted entry (inside Submit)
        own.OnCall = (kind, o) => { if (kind == "submit" && (o.Name ?? "").Contains(" bot ")) { own.OnCall = null; Bot("{\"type\":\"withdraw\",\"id\":\"" + id + "\",\"reason\":\"Sample: price left the level\"}"); } };
        try { Page("{\"type\":\"botAnswer\",\"cid\":\"w1\",\"id\":\"" + id + "\",\"answer\":\"accept\",\"at\":1791380834000}"); }
        finally { own.OnCall = null; }
        List<string> c = Calls(own, n);
        Check(c.Count == 2 && Regex.IsMatch(c[0], "^submit CB#[0-9a-f]{8} bot s12 t24 Sell Limit 1 ") && c[1].StartsWith("cancel CB#" + Tag(Newest(own)) + " bot"),
              "review 2 finding 7: a withdraw during the accept's placement: the entry is cancelled as soon as it is placed (it had not filled): " + string.Join(" | ", c));
        Check(Last(page, "botProposal").Contains("\"state\":\"withdrawn\"") && File_("bot.log").Contains("withdrawn during placement"), "review 2 finding 7: the proposal ends withdrawn, logged \"withdrawn during placement\"");
        Settle();
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
    }

    static void AfterAuthSeesOpenProposal(string id)
    {
        List<string> fresh = new List<string>();
        ChartBridgeClient p3 = new ChartBridgeClient(null, 503) { Origin = "http://localhost:8765" };
        p3.Tap = s => fresh.Add(s);
        ChartBridgeServer_OnClientMessage(p3, "{\"type\":\"client\",\"v\":3}");
        ChartBridgeServer_OnClientMessage(p3, "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
        Check(fresh.Any(x => x.StartsWith("{\"type\":\"bot\"")) && fresh.Any(x => x.StartsWith("{\"type\":\"botProposal\"") && x.Contains(id) && x.Contains("\"state\":\"open\"")), "a page that signs in gets the strip and the open proposal");
    }

    // ------------------------------------------------------------ auto: on the bot's account (OWN-1 here), through the gates, one trade at a time
    static void Auto()
    {
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Check(Last(page, "bot").Contains("\"mode\":\"auto\"") && Last(botOut, "botState").Contains("\"mode\":\"auto\""), "auto: set from the page, the bot is told");
        int n = own.Calls.Count;
        string a = NewId();
        Bot(Sig(a, Market("buy")));
        List<string> sent = Calls(own, n);
        Check(sent.Count == 1 && Regex.IsMatch(sent[0], "^submit CB#[0-9a-f]{8} bot s8 t16 Buy Market 1 "), "auto: the signal placed by ChartBridge, 1 MNQ on OWN-1, named bot: " + string.Join(" | ", sent));
        Check(Last(page, "botSignal").Contains("\"result\":\"placed\"") && eval.Calls.Count == 0, "auto: shown as placed; nothing on another account");
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("already has a working entry") && Calls(own, n).Count == 1, "one trade at a time: a second entry while one works is refused");
        Bot("{\"type\":\"withdraw\",\"id\":\"" + a + "\",\"reason\":\"Sample: no longer valid\"}");
        Check(Calls(own, n).Count == 2 && Calls(own, n)[1].StartsWith("cancel CB#" + Tag(Newest(own)) + " bot"), "withdraw in auto: the unfilled entry is cancelled");
        Settle();
        Bot(Sig(NewId(), "\"side\":\"buy\",\"kind\":\"limit\",\"price\":25010,\"stopTicks\":8,\"targetTicks\":16"));
        Check(BotReject().Contains("would fill at once") && Last(page, "botSignal").Contains("refused: a buy limit above the last price"), "auto: v2 gate 5 still applies (a buy limit through the market is refused)");
        Bot(Sig(NewId(), "\"side\":\"buy\",\"kind\":\"limit\",\"price\":24999.1,\"stopTicks\":8,\"targetTicks\":16"));
        Check(BotReject().Contains("tick grid"), "auto: off the tick grid: refused");
        ChartBridgeOrders.ReadConfig("trading", "false");
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("trading is off"), "auto: trading off in config.txt (the master switch): refused");
        ChartBridgeOrders.ReadConfig("trading", "true");
        Check(Calls(own, n).Count == 2 && eval.Calls.Count == 0, "none of these reached NinjaTrader");
    }

    // ------------------------------------------------------------ 1 contract, whatever maxQty says
    static void Size()
    {
        int n = own.Calls.Count;
        own.Positions.Add(new Position { Instrument = mnq, MarketPosition = MarketPosition.Long, Quantity = 1, AveragePrice = 25000 });   // a manual OWN-1 position
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("the cap is 1") && own.Calls.Count == n, "1 contract: with OWN-1 already long 1, a bot buy is refused (maxQty.MNQ is 3)");
        Bot(Sig(NewId(), Market("sell")));
        Check(BotReject().Contains("reduces the position") && own.Calls.Count == n, "a bot entry never reduces a position (every entry has a stop)");
        own.Positions.Clear();
    }

    // ------------------------------------------------------------ 0.5.8: OWN-1 in a group that is short: the bot's buy is refused
    static void GroupRefusal()
    {
        string file = Path.Combine(home, "ChartBridge", "groups.txt");
        File.WriteAllText(file, ChartBridgeGroups.Header + "\n#\ngroup\tg1\tLucid\ton\t-\t2000\teod\t-\t50000\t-\nmember\tOWN-1\tg1\nmember\tEVAL-A\tg1\n");
        ChartBridgeGroups.StartNow();
        try
        {
            eval.Positions.Add(new Position { Instrument = mnq, MarketPosition = MarketPosition.Short, Quantity = 1, AveragePrice = 25000 });
            int n = own.Calls.Count;
            Bot(Sig(NewId(), Market("buy")));
            Check(BotReject().Contains("Group Lucid is short (EVAL-A -1 MNQ): a buy on OWN-1 would hedge the group") && own.Calls.Count == n, "0.5.8: the bot's buy while its account's group is short: refused, nothing sent: " + BotReject());
            Check(Last(page, "botSignal").Contains("refused: Group Lucid is short"), "0.5.8: the page sees it refused");
        }
        finally
        {
            eval.Positions.Clear();
            Gone(file);
            ChartBridgeGroups.StartNow();
        }
    }

    static Order AutoTrade(string side)
    {
        int n = own.Calls.Count;
        Bot(Sig(NewId(), Market(side)));
        if (own.Calls.Count == n) return null;
        return own.Orders.Last(o => o.Name != null && o.Name.Contains(" bot "));
    }

    // ------------------------------------------------------------ stand down after 3 losing trades; a new day starts over
    static void Losses()
    {
        for (int i = 1; i <= 3; i++)
        {
            Order e = AutoTrade("buy");
            Check(e != null, "losing trade " + i + ": placed");
            if (e == null) return;
            FillEntry(e, 25000);
            Check(Last(page, "bot").Contains("\"trades\":" + i) && Last(page, "bot").Contains("\"position\":{\"qty\":1,\"avgPrice\":25000}"), "trade " + i + " counted when it fills; the strip shows the position");
            Check(Last(botOut, "exec").Contains("\"order\":\"" + e.OrderId + "\""), "the bot gets its own fill");
            Exit(e, 24990);
            Check(Last(page, "bot").Contains("\"losses\":" + i) && Last(page, "bot").Contains("\"position\":{\"qty\":0,\"avgPrice\":null}"), "trade " + i + " closed with a loss");
        }
        Check(Last(page, "bot").Contains("\"pnlToday\":-60") && Last(page, "bot").Contains("\"standDown\":\"3 losing trades today"), "3 losing trades: the bot stands down (-60 dollars on Sim)");
        Check(Last(page, "status").Contains("Bot stands down"), "the page is told");
        int n = own.Calls.Count;
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("3 losing trades today") && own.Calls.Count == n, "after 3 losses: no new entry");
        Check(File_("bot-day.txt").Contains("session\t2026-10-07"), "bot-day.txt keeps the day");
        et = et.AddHours(8);   // 18:00 ET: a new trading day
        ChartBridgeBot.Check();
        Check(Last(page, "bot").Contains("\"trades\":0") && Last(page, "bot").Contains("\"losses\":0") && Last(page, "bot").Contains("\"standDown\":null"), "18:00 ET: trades and losses start over");
    }

    // ------------------------------------------------------------ at most 5 trades a day, kept across a restart
    static void FiveTrades()
    {
        for (int i = 1; i <= 5; i++)
        {
            Order e = AutoTrade(i % 2 == 0 ? "sell" : "buy");
            Check(e != null, "trade " + i + " of 5: placed");
            if (e == null) return;
            FillEntry(e, 25000);
            Exit(e, e.OrderAction == OrderAction.Buy ? 25002 : 24998);
        }
        Check(Last(page, "bot").Contains("\"trades\":5") && Last(page, "bot").Contains("\"losses\":0") && Last(page, "bot").Contains("\"pnlToday\":20"), "5 winning trades counted");
        int n = own.Calls.Count;
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("The bot has made 5 trades today (the limit).") && own.Calls.Count == n, "the 6th trade of the day: refused");
        // a restart (recompile) forgets nothing: bot-day.txt; the mode starts in shadow and the bot must say hello again
        ChartBridgeBot.Stop();
        ChartBridgeBot.Start(false);
        Check(ChartBridgeBot.StripJson().Contains("\"trades\":5") && ChartBridgeBot.StripJson().Contains("\"mode\":\"shadow\"") && ChartBridgeBot.StripJson().Contains("\"connected\":false"), "after a restart: still 5 trades today, back in shadow, no bot");
        Reconnect();
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("5 trades today") && own.Calls.Count == n, "after a restart: the 6th trade is still refused");
        et = et.AddDays(1);
        ChartBridgeBot.Check();
    }

    // 0.6.3 (review HIGH 1): the daily reset acts only on accounts Connected for a few seconds; the harness's are, unless a case says not
    // 0.6.3 (review MED 5): a file gone means no copy beside it either (a .bak or .tmp left would be used, or stand the agent down)
    static void Gone(string path) { File.Delete(path); File.Delete(path + ".bak"); File.Delete(path + ".tmp"); }
    static void SteadyAll() { Dictionary<Account, double> cs = (Dictionary<Account, double>)typeof(ChartBridgeOrders).GetField("ConnectedSince", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null); lock (cs) foreach (Account a in Account.All) if (a.Connection != null && a.Connection.Status == ConnectionStatus.Connected) cs[a] = 0; }
    static void Reconnect()
    {
        bc = new ChartBridgeClient(null, ChartBridgeBot.BotClientId);
        bc.Tap = s => { lock (botOut) botOut.Add(s); };
        ChartBridgeBot.Attach(bc);
        Bot("{\"type\":\"botHello\",\"name\":\"Demo Opening Fade\"}");
    }

    // ------------------------------------------------------------ the kill switch: as the heartbeat loss, and no bot order until off
    static void KillSwitch()
    {
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        int n = own.Calls.Count;
        Bot(Sig(NewId(), "\"side\":\"buy\",\"kind\":\"limit\",\"price\":24990,\"stopTicks\":8,\"targetTicks\":16"));
        Order e = Newest(own);
        Check(Calls(own, n).Count == 1 && e.Name.Contains(" bot "), "an unfilled bot entry works");
        Page("{\"type\":\"botKill\",\"cid\":\"k\",\"on\":true}");
        List<string> after = Calls(own, n + 1);
        Check(after.Count == 1 && after[0] == "cancel " + e.Name, "kill switch on: the unfilled entry is cancelled, nothing else: " + string.Join(" | ", after));
        Check(!after.Any(x => x.StartsWith("flatten")) && Last(page, "status").Contains("the kill switch is on") && Last(page, "bot").Contains("\"killed\":true"), "kill switch: never a flatten; the page is told");
        Settle();
        int m = own.Calls.Count;
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("the kill switch is on") && own.Calls.Count == m, "kill switch on: every bot order refused");
        // 0.6.3 (audit C5, Anthony's decision): saved; a restart keeps it until the page releases it
        string kf = Path.Combine(home, "ChartBridge", "bot-kill.txt");
        Check(File.Exists(kf) && File.ReadAllText(kf).Contains("killed\t"), "0.6.3 C5: the bot's kill switch is saved (bot-kill.txt)");
        ChartBridgeBot.Stop(); ChartBridgeBot.Start(false); Reconnect();
        Check(Last(botOut, "welcome").Contains("\"killed\":true") && Last(page, "bot").Contains("\"killed\":true") && Last(page, "bot").Contains("\"killedAt\":") && !Last(page, "bot").Contains("\"killedAt\":null"),
              "0.6.3 C5: after a restart the bot is still killed: its welcome and the page say so: " + Last(botOut, "welcome"));
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        m = own.Calls.Count;
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("the kill switch is on") && own.Calls.Count == m, "0.6.3 C5: still killed after the restart: every bot order refused");
        Page("{\"type\":\"botKill\",\"cid\":\"k\",\"on\":\"yes\"}");
        Check(PageReject().Contains("on must be true or false"), "botKill: on must be a bool");
        Page("{\"type\":\"botKill\",\"cid\":\"k\",\"on\":false}");
        Check(!File.Exists(kf), "0.6.3 C5: released on the page: bot-kill.txt is gone");
        ChartBridgeBot.Stop(); ChartBridgeBot.Start(false); Reconnect();
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Check(Last(botOut, "welcome").Contains("\"killed\":false"), "0.6.3 C5: released, then a restart: not killed");
        Order again = AutoTrade("buy");
        Check(again != null && Last(page, "bot").Contains("\"killed\":false"), "kill switch off: the bot may place again");
        Settle();
    }

    // ------------------------------------------------------------ heartbeat: 5 s of silence; entries cancelled, stops kept, no flatten
    static void Heartbeat()
    {
        // (1) an unfilled entry
        int n = own.Calls.Count;
        Order e = AutoTrade("buy");
        Check(e != null, "heartbeat: an entry works");
        clock += 4900;
        ChartBridgeBot.Check();
        Check(Calls(own, n + 1).Count == 0, "4.9 s of silence: nothing yet");
        Bot("{\"type\":\"beat\"}");
        clock += 4900;
        ChartBridgeBot.Check();
        Check(Calls(own, n + 1).Count == 0, "a beat resets the 5 s");
        clock += 200;
        ChartBridgeBot.Check();
        List<string> after = Calls(own, n + 1);
        Check(after.Count == 1 && after[0] == "cancel " + e.Name, "5 s of silence: the unfilled entry is cancelled: " + string.Join(" | ", after));
        Check(Last(page, "status").Contains("heartbeat lost") && Last(page, "bot").Contains("\"connected\":false") && ChartBridgeBot.DiagJson().Contains("\"heartbeatLost\":1"), "the page is told (status and strip), counted in /diag");
        Bot(Sig(NewId(), Market("buy")));
        Check(own.Calls.Count == n + 2, "a lost bot's messages do nothing");
        Settle();

        // (2) a bot position with its stop and target
        Reconnect();
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Order f = AutoTrade("buy");
        FillEntry(f, 25000);
        string tag = Tag(f);
        List<string> legs = own.Calls.Where(x => x.StartsWith("submit CB#" + tag + " stop") || x.StartsWith("submit CB#" + tag + " target")).ToList();
        Check(legs.Count == 2, "the bot's entry filled: its stop and target are placed per fill (v2): " + string.Join(" | ", legs));
        int m = own.Calls.Count;
        clock += 5100;
        ChartBridgeBot.Check();
        clock += 5100;
        ChartBridgeBot.Check();   // and no bot for another 5 s
        Check(Calls(own, m).Count == 0, "heartbeat lost with a position: nothing cancelled, nothing flattened; the stop and target stay: " + string.Join(" | ", Calls(own, m)));
        Check(Last(page, "status").Contains("any bot position keeps its stop and target"), "the page is told the position keeps its stop and target");
        Exit(f, 25002);
        Reconnect();
    }

    // ------------------------------------------------------------ the bot's own flatten: auto only
    static void BotFlatten()
    {
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        int n = own.Calls.Count;
        Bot("{\"type\":\"flatten\"}");
        Check(BotReject().Contains("no position") && own.Calls.Count == n, "flatten with no bot position: refused");
        Order e = AutoTrade("buy");
        FillEntry(e, 25000);
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
        int m = own.Calls.Count;
        Bot("{\"type\":\"flatten\"}");
        Check(BotReject().Contains("auto mode only") && own.Calls.Count == m, "flatten in shadow: refused");
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Bot("{\"type\":\"flatten\"}");
        Check(Calls(own, m).Contains("flatten MNQ 12-26") && eval.Calls.Count == 0, "flatten in auto: OWN-1's MNQ only");
        Exit(e, 25000);
    }

    // ------------------------------------------------------------ rails from the page (release 1, step 1.6b): every rail set on the Bot tab, saved, refused while exposed
    static string RailsFile() { return Path.Combine(home, "ChartBridge", "bot-rails.txt"); }
    static void Restart() { ChartBridgeBot.Stop(); ChartBridgeBot.Start(false); Reconnect(); }
    // R12 (the day file): bot-day.txt has this exact line
    static bool DayLine(string line) { return File_("bot-day.txt").Split('\n').Select(l => l.TrimEnd('\r')).Contains(line); }
    // R12 (the day file): the trade's open line as a ChartBridge before this build wrote it (three fields: no dollars, size or price)
    static void OldLine(Order e)
    {
        string f = Path.Combine(home, "ChartBridge", "bot-day.txt");
        string[] lines = File.ReadAllLines(f).Select(l => l.StartsWith("trade\t" + Tag(e) + "\topen\t") ? "trade\t" + Tag(e) + "\topen" : l).ToArray();
        File.WriteAllLines(f, lines);
    }

    static void Rails()
    {
        et = et.AddDays(1);   // a fresh day
        ChartBridgeBot.Check();
        Page(RailsMsg(1, 5, 3, "500", "500", "ES"));
        Check(PageReject().Contains("root must be MNQ or NQ"), "botRails: a root other than botRoot and its sibling refused");
        Page("{\"type\":\"botRails\",\"cid\":\"r\",\"maxTrades\":5,\"maxLosses\":3,\"root\":\"MNQ\"}");
        Check(PageReject().Contains("size must be a whole number from 1 to 20 for MNQ"), "botRails: every rail needed (no size: refused): " + PageReject());
        Page(RailsMsg(0, 5, 3, "500", "500", "MNQ"));
        Check(PageReject().Contains("size must be a whole number from 1 to 20 for MNQ"), "botRails: size 0 refused (never \"no limit\")");
        Page(RailsMsg(21, 5, 3, "500", "500", "MNQ"));
        Check(PageReject().Contains("size must be a whole number from 1 to 20 for MNQ (the hard ceiling: 2 minis or 20 micros, raised only by a new ChartBridge build)"), "botRails: 21 MNQ is above the hard ceiling: refused");
        Page(RailsMsg(3, 5, 3, "500", "500", "NQ"));
        Check(PageReject().Contains("size must be a whole number from 1 to 2 for NQ"), "botRails: 3 NQ is above the hard ceiling of 2: refused");
        Page(RailsMsg(1, 0, 3, "500", "500", "MNQ"));
        Check(PageReject().Contains("maxTrades must be a whole number from 1 to 100"), "botRails: maxTrades 0 refused");
        Page(RailsMsg(1, 101, 3, "500", "500", "MNQ"));
        Check(PageReject().Contains("maxTrades must be a whole number from 1 to 100"), "botRails: maxTrades above 100 refused");
        Page(RailsMsg(1, 5, 0, "500", "500", "MNQ"));
        Check(PageReject().Contains("maxLosses must be a whole number from 1 to 100"), "botRails: maxLosses 0 refused");
        Page(RailsMsg(1, 5, 3, "0", "500", "MNQ"));
        Check(PageReject().Contains("dayLoss must be dollars above 0"), "botRails: a day loss stop of 0 refused");
        Page(RailsMsg(1, 5, 3, "null", "500", "MNQ"));
        Check(PageReject().Contains("dayLoss must be dollars above 0"), "botRails: a day loss stop of null refused");
        Page(RailsMsg(1, 5, 3, "500", "12.345", "MNQ"));
        Check(PageReject().Contains("dayProfit must be dollars above 0") && PageReject().Contains("at most 2 decimals"), "botRails: a day profit stop with 3 decimals refused");
        Page(RailsMsg(1, 5, 3, "500", "\"500\"", "MNQ"));
        Check(PageReject().Contains("dayProfit must be dollars above 0"), "botRails: a day profit stop as a string refused");
        Order e = AutoTrade("buy");
        Page(RailsMsg(2, 8, 4, "250.5", "750", "NQ"));
        Check(e != null && PageReject().Contains("position or a working entry"), "botRails: refused while the bot has a working entry");
        Settle();
        Page(RailsMsg(2, 8, 4, "250.5", "750", "NQ"));
        string b = Last(page, "bot");
        Check(b.Contains("\"maxTrades\":8") && b.Contains("\"maxLosses\":4") && b.Contains("\"root\":\"NQ\"") && b.Contains("\"size\":2") && b.Contains("\"maxQty\":2") && b.Contains("\"hardCeiling\":2") &&
              b.Contains("\"dayLoss\":250.5") && b.Contains("\"dayProfit\":750") && b.Contains("\"railsMissing\":[]"),
              "botRails: set (above the old fixed 5 trades and 3 losses, now Anthony's to set) and reported in the strip: " + b);
        Check(Last(botOut, "welcome").Contains("\"root\":\"NQ\"") && Last(botOut, "welcome").Contains("\"rails\":{\"maxQty\":2,\"size\":2,\"maxTrades\":8,\"maxLosses\":4,\"dayLoss\":250.5,\"dayProfit\":750}"),
              "botRails: reported to the bot in welcome: " + Last(botOut, "welcome"));
        string f = File_("bot-rails.txt");
        Check(f.Contains("size\t2") && f.Contains("maxTrades\t8") && f.Contains("maxLosses\t4") && f.Contains("dayLoss\t250.5") && f.Contains("dayProfit\t750") && f.Contains("root\tNQ"), "botRails: saved in bot-rails.txt");
        Restart();
        Check(ChartBridgeBot.StripJson().Contains("\"maxTrades\":8") && ChartBridgeBot.StripJson().Contains("\"root\":\"NQ\"") && ChartBridgeBot.StripJson().Contains("\"size\":2") && ChartBridgeBot.StripJson().Contains("\"dayLoss\":250.5"),
              "botRails: kept across a restart");
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        int n = own.Calls.Count;
        Bot(Sig(NewId(), Market("buy")));
        Check(Calls(own, n).Count == 1 && Newest(own).Instrument == nq && Newest(own).Quantity == 2,
              "the bot now trades 2 NQ (its size; config.txt has no maxQty.NQ line, whose default of 1 caps the ticket only): " + string.Join(" | ", Calls(own, n)));
        Settle();
        // the ticket keeps config.txt's cap: 2 NQ from the page is refused (maxQty.NQ defaults to 1)
        Page("{\"type\":\"order\",\"cid\":\"t1\",\"account\":\"OWN-2\",\"root\":\"NQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":2}");
        Check(PageReject().Contains("qty 2 is over the NQ cap of 1 (maxQty.NQ in config.txt)") && own2.Calls.Count == 0, "release 1 (1.6b): the ticket's orders keep config.txt's cap (only the bot's left it): " + PageReject());
        File.WriteAllText(RailsFile(), "maxTrades\tlots\n");
        Restart();
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Check(PageReject().Contains("auto refused: bot-rails.txt has a line ChartBridge does not understand") && ChartBridgeBot.StripJson().Contains("\"standDown\":\"bot-rails.txt has a line"),
              "a bot-rails.txt that cannot be understood: no arming, the strip says why: " + PageReject());
        n = own.Calls.Count;
        Bot(Sig(NewId(), Market("buy")));
        Check(own.Calls.Count == n, "a bot-rails.txt that cannot be understood: nothing sent");
        Page(RailsMsg(1, 5, 3, "500", "500", "MNQ"));
        Check(Last(page, "bot").Contains("\"standDown\":null") && Last(page, "bot").Contains("\"root\":\"MNQ\""), "the page sets the rails again: the bot may trade");
    }

    // ------------------------------------------------------------ release 1 (1.6b): fail closed: a rail not set, 0, none or unreadable: no arming, no entry, each named
    static void FailClosed()
    {
        Settle();
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
        Gone(RailsFile());
        Restart();
        string st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"railsMissing\":[\"size\",\"maxTrades\",\"maxLosses\",\"dayLoss\",\"dayProfit\"]") && st.Contains("\"size\":null") && st.Contains("\"maxTrades\":null") && st.Contains("\"dayLoss\":null") &&
              st.Contains("\"standDown\":\"the bot's rails are not set: the size, the trades a day, the losing trades a day, the day's loss stop and the day's profit stop (set them on the Bot tab; until then the bot does not trade)\""),
              "no bot-rails.txt: nothing has a default; the strip names every rail not set: " + st);
        Check(Last(botOut, "welcome").Contains("\"rails\":{\"maxQty\":null,\"size\":null,\"maxTrades\":null,\"maxLosses\":null,\"dayLoss\":null,\"dayProfit\":null}"), "no bot-rails.txt: the bot's welcome says every rail is not set");
        foreach (string mode in new[] { "copilot", "auto" })
        {
            Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"" + mode + "\"}");
            Check(PageReject().Contains(mode + " refused: the bot's rails are not set: the size,") && Last(page, "bot").Contains("\"mode\":\"shadow\""), "fail closed: " + mode + " refused with no rails set: " + PageReject());
        }
        int n = own.Calls.Count;
        Bot(Sig(NewId(), Market("buy")));
        Check(own.Calls.Count == n && Last(page, "botSignal").Contains("\"result\":\"shadow\""), "fail closed: a signal stays in Shadow; nothing sent");
        // a bot-rails.txt from before 1.6b (maxTrades, maxLosses, root): read, with the size and both day stops not set
        File.WriteAllLines(RailsFile(), new[] { "# old", "# file", "maxTrades\t5", "maxLosses\t3", "root\tMNQ" });
        Restart();
        st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"railsMissing\":[\"size\",\"dayLoss\",\"dayProfit\"]") && st.Contains("\"maxTrades\":5") &&
              st.Contains("\"standDown\":\"the bot's rails are not set: the size, the day's loss stop and the day's profit stop (set them on the Bot tab"),
              "an older bot-rails.txt: the size and the day stops are named as not set: " + st);
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Check(PageReject().Contains("auto refused: the bot's rails are not set: the size, the day's loss stop and the day's profit stop"), "an older bot-rails.txt: auto refused");
        // 0, none, a blank or a size above the ceiling in the file: not understood (never "no limit"); the bot stands down
        foreach (string[] bad in new[] { new[] { "size\t0", "a line ChartBridge does not understand" }, new[] { "dayLoss\tnone", "a line ChartBridge does not understand" },
                                         new[] { "dayProfit\t", "a line ChartBridge does not understand" }, new[] { "size\t25", "names size 25, above the hard ceiling of 20 for MNQ" } })
        {
            List<string> lines = RailsLines.Where(x => !x.StartsWith(bad[0].Split('\t')[0] + "\t")).ToList();
            lines.Add(bad[0]);
            File.WriteAllLines(RailsFile(), lines.ToArray());
            Restart();
            st = ChartBridgeBot.StripJson();
            Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
            Check(st.Contains("\"standDown\":\"bot-rails.txt") && st.Contains(bad[1]) && PageReject().Contains("auto refused: bot-rails.txt") && Last(page, "bot").Contains("\"mode\":\"shadow\""),
                  "fail closed: bot-rails.txt with \"" + bad[0].Replace("\t", " ") + "\": the bot stands down, no arming: " + st);
        }
        Page(RailsMsg(1, 5, 3, "500", "500", "MNQ"));
        Check(ChartBridgeBot.StripJson().Contains("\"standDown\":null") && ChartBridgeBot.StripJson().Contains("\"railsMissing\":[]"), "every rail set on the page: the bot may be armed");
    }

    // ------------------------------------------------------------ release 1 (1.6b): the size is the Bot tab's, capped only by the hard ceiling
    static void SizeCeiling()
    {
        Settle();
        Page(RailsMsg(5, 5, 3, "500", "500", "MNQ"));   // config.txt's maxQty.MNQ is 3 here
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        int n = own.Calls.Count;
        Bot(Sig(NewId(), Market("buy")));
        List<string> sent = Calls(own, n);
        Check(sent.Count == 1 && Regex.IsMatch(sent[0], "^submit CB#[0-9a-f]{8} bot s8 t16 Buy Market 5 "), "size 5 MNQ: placed with 5 contracts, above config.txt's maxQty.MNQ of 3 (the ticket's cap only): " + string.Join(" | ", sent));
        Settle();
        Page("{\"type\":\"order\",\"cid\":\"t2\",\"account\":\"OWN-2\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":4}");
        Check(PageReject().Contains("qty 4 is over the MNQ cap of 3 (maxQty.MNQ in config.txt)") && own2.Calls.Count == 0, "the ticket: 4 MNQ still refused by config.txt's cap of 3");
        own.Positions.Add(new Position { Instrument = mnq, MarketPosition = MarketPosition.Long, Quantity = 1, AveragePrice = 25000 });   // a manual position on the personal account
        n = own.Calls.Count;
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("the cap is 5 (the bot's size on the Bot tab; the hard ceiling for MNQ is 20)") && own.Calls.Count == n,
              "gate 3 for the bot: a manual long 1 plus the bot's 5 is over its size: refused, the words name the Bot tab's size and the ceiling: " + BotReject());
        own.Positions.Clear();
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"copilot\"}");
        string pid = NewId();
        Bot(Sig(pid, Market("buy")));
        Check(Last(page, "botProposal").Contains("\"id\":\"" + pid + "\"") && Last(page, "botProposal").Contains("\"qty\":5"), "a copilot proposal carries the bot's size");
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
        Page(RailsMsg(1, 5, 3, "500", "500", "MNQ"));
        Check(Last(page, "bot").Contains("\"size\":1"), "size back to 1");
    }

    // ------------------------------------------------------------ release 1 (1.6b): the day's loss and profit stops: flatten at once, latch, Shadow
    static void DayStops()
    {
        Settle();
        et = et.AddDays(1); ChartBridgeBot.Check();   // a fresh day
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Page(RailsMsg(1, 5, 3, "30", "40", "MNQ"));   // made up: a $30 loss stop and a $40 profit stop ($2 a point on MNQ)
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Order a = AutoTrade("buy");
        FillEntry(a, 25000);
        Exit(a, 24990);   // -$20 realized
        ChartBridgeBot.Check();
        Check(ChartBridgeBot.StripJson().Contains("\"dayStop\":null") && ChartBridgeBot.StripJson().Contains("\"mode\":\"auto\""), "day stops: -$20 realized is not yet the $30 loss stop");
        Order b = AutoTrade("buy");
        FillEntry(b, 25000);
        ChartBridgeOrders.NoteLast("MNQ", 24997.5);   // open -$5: the day at -$25
        ChartBridgeBot.Check();
        Check(ChartBridgeBot.StripJson().Contains("\"dayStop\":null"), "day stops: realized -$20 plus open -$5 is -$25: not yet");
        Page("{\"type\":\"botKill\",\"cid\":\"k\",\"on\":true}");   // Anthony 2026-11-17 Q7: the day stop flattens even with the kill switch on
        int m = own.Calls.Count, s0 = page.Count;
        ChartBridgeOrders.NoteLast("MNQ", 24995);     // open -$10: the day at -$30, realized plus open
        ChartBridgeBot.Check();
        string st = ChartBridgeBot.StripJson();
        Check(Calls(own, m).Contains("flatten MNQ 12-26") && own2.Calls.Count == 0 && eval.Calls.Count == 0,
              "the day's loss stop reached on realized plus open: the bot's position on its account and root is flattened at once, the kill switch on: " + string.Join(" | ", Calls(own, m)));
        Check(st.Contains("\"mode\":\"shadow\"") && st.Contains("\"dayStop\":{\"kind\":\"loss\",\"day\":-30,") &&
              st.Contains("the day's loss stop ($30) was reached today (the day at -$30, realized plus open): the bot was flattened and set to Shadow; no bot entries until 18:00 ET, then Anthony arms it again"),
              "the day's loss stop: the mode drops to Shadow, the latch is in the strip: " + st);
        Check(page.Skip(s0).Any(x => x.Contains("\"level\":\"warn\"") && x.Contains("the day's loss stop ($30) was reached today") && x.Contains("mode auto to shadow") && x.Contains("is flattened")),
              "the pages are told (status warn): the stop, the mode and the flatten");
        Check(Last(botOut, "botState").Contains("\"mode\":\"shadow\"") && Last(botOut, "botState").Contains("\"dayStop\":\"loss\""), "the bot is told: Shadow, the loss stop");
        Check(File_("bot-day.txt").Contains("stop\tloss\t-30") && File_("bot.log").Contains("the day's loss stop ($30) was reached today"), "latched in bot-day.txt, logged in bot.log");
        Page("{\"type\":\"botKill\",\"cid\":\"k\",\"on\":false}");
        foreach (string mode in new[] { "copilot", "auto" })
        {
            Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"" + mode + "\"}");
            Check(PageReject().Contains(mode + " refused: the day's loss stop ($30) was reached today") && Last(page, "bot").Contains("\"mode\":\"shadow\""), "Anthony 2026-11-18 \"Drop to Shadow\": " + mode + " refused until 18:00 ET");
        }
        m = own.Calls.Count;
        Exit(b, 24995);
        ChartBridgeBot.Check();
        Check(Calls(own, m).Count == 0, "the trade closed after the flatten: nothing more sent");
        Restart();
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Check(PageReject().Contains("auto refused: the day's loss stop ($30) was reached today") && ChartBridgeBot.StripJson().Contains("\"kind\":\"loss\""), "the latch is kept across a restart (bot-day.txt)");
        // 18:00 ET: the latch ends with the day; the bot stays in Shadow until Anthony arms it
        et = et.AddDays(1); ChartBridgeBot.Check();
        st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"dayStop\":null") && st.Contains("\"mode\":\"shadow\"") && st.Contains("\"standDown\":null") && !File_("bot-day.txt").Contains("stop\t"),
              "a new trading day: the day stop's latch ends, the mode stays Shadow (never re-armed by itself): " + st);
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Check(Last(page, "bot").Contains("\"mode\":\"auto\""), "Anthony arms it again himself");
        // the profit side, at a close: +$40 realized, nothing held, so nothing to flatten
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Order c = AutoTrade("buy");
        FillEntry(c, 25000);
        m = own.Calls.Count;
        Exit(c, 25020);
        st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"mode\":\"shadow\"") && st.Contains("\"dayStop\":{\"kind\":\"profit\",\"day\":40,") && st.Contains("the day's profit stop ($40) was reached today (the day at $40, realized plus open)") &&
              !Calls(own, m).Any(x => x.StartsWith("flatten")),
              "the day's profit stop reached at a close: latched, Shadow, no flatten (the bot holds nothing): " + st);
        // copilot: an open proposal ends "not answered" at a day stop
        et = et.AddDays(1); ChartBridgeBot.Check();
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Order d = AutoTrade("buy");
        FillEntry(d, 25000);
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"copilot\"}");
        Bot(Sig(NewId(), Market("sell")));
        Check(BotReject().Contains("already has a position"), "copilot while the trade is open: a new proposal is refused at once (one trade at a time)");
        ChartBridgeOrders.NoteLast("MNQ", 25020);   // open +$40: the profit stop while the bot holds its trade
        m = own.Calls.Count;
        ChartBridgeBot.Check();
        Check(Calls(own, m).Contains("flatten MNQ 12-26") && ChartBridgeBot.StripJson().Contains("\"kind\":\"profit\"") && ChartBridgeBot.StripJson().Contains("\"mode\":\"shadow\""),
              "the day's profit stop on an open trade: flattened at once, from copilot to Shadow");
        Exit(d, 25020);
        Settle();
        et = et.AddDays(1); ChartBridgeBot.Check();
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Page(RailsMsg(1, 5, 3, "500", "500", "MNQ"));
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
    }

    // ------------------------------------------------------------ review R12 finding 1: an entry that fills after its trade closed
    static void LateFill()
    {
        Settle();
        et = et.AddDays(1); ChartBridgeBot.Check();   // a fresh day
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        // without a day stop: 1 of 2 fills, its stop leg closes it, then the other contract fills
        Page(RailsMsg(2, 5, 3, "500", "500", "MNQ"));
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Order a = AutoTrade("buy");
        Check(a != null && a.Quantity == 2, "late fill: a 2 contract bot entry (made up)");
        if (a == null) return;
        PartFill(a, 1, 1, 25000);
        Sold(1, 24996);   // its stop leg: -$8
        string st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"position\":{\"qty\":0,") && st.Contains("\"trades\":1,") && st.Contains("\"pnlToday\":-8,"), "late fill: the part filled trade closed by its stop leg (-$8): " + st);
        int s0 = page.Count;
        PartFill(a, 2, 1, 24996);   // the entry's other contract fills after the trade closed
        st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"position\":{\"qty\":1,") && st.Contains("\"trades\":1,"), "late fill: the trade is open again and followed (still one trade): " + st);
        Check(page.Skip(s0).Any(x => x.Contains("\"level\":\"warn\"") && x.Contains("trade " + Tag(a) + " is open again")), "late fill: the pages are told (status warn)");
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("already has a position"), "late fill: the reopened trade is the bot's one trade (a new entry refused)");
        Sold(1, 24992);   // -$8 more
        Settle();
        st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"position\":{\"qty\":0,") && st.Contains("\"trades\":1,") && st.Contains("\"losses\":1,") && st.Contains("\"pnlToday\":-16,") &&
              File_("bot-day.txt").Contains("trade\t" + Tag(a) + "\t-16"),
              "late fill: the late contract's dollars are added to the trade's (-$16, one losing trade, saved in bot-day.txt): " + st);

        // at a day stop (size 2, a $30 loss stop): 1 of 2 fills, the stop flattens it, then the other contract fills
        et = et.AddDays(1); ChartBridgeBot.Check();
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Page(RailsMsg(2, 5, 3, "30", "40", "MNQ"));
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Order b = AutoTrade("buy");
        Check(b != null && b.Quantity == 2, "day stop late fill: a 2 contract bot entry");
        if (b == null) return;
        PartFill(b, 1, 1, 25000);
        int m = own.Calls.Count;
        ChartBridgeOrders.NoteLast("MNQ", 24985);   // open -$30 on the 1 held
        ChartBridgeBot.Check();
        double t0 = clock;
        List<string> c = Calls(own, m);
        Check(c.Count(x => x == "flatten MNQ 12-26") == 1 && c.Any(x => x.StartsWith("cancel CB#" + Tag(b) + " bot")) && ChartBridgeBot.StripJson().Contains("\"kind\":\"loss\""),
              "day stop late fill: the loss stop cancels the entry's rest and flattens once: " + string.Join(" | ", c));
        Sold(1, 24985);   // the flatten closes the 1 held: the trade closes at -$30
        Check(ChartBridgeBot.StripJson().Contains("\"position\":{\"qty\":0,") && File_("bot-day.txt").Contains("trade\t" + Tag(b) + "\t-30"), "day stop late fill: flat at -$30 after the flatten");
        // the entry's cancel is lost (it is still working): its cancel is sent again after 5 s, never a flatten (the bot holds nothing)
        m = own.Calls.Count;
        for (int i = 0; i < 9; i++) { clock += 350; Bot("{\"type\":\"beat\"}"); ChartBridgeBot.Check(); }
        Check(Calls(own, m).Count == 0, "day stop late fill: nothing sent again before 5 s: " + string.Join(" | ", Calls(own, m)));
        clock = t0 + 4850; Bot("{\"type\":\"beat\"}"); ChartBridgeBot.Check();
        c = Calls(own, m);
        Check(c.Count == 1 && c[0].StartsWith("cancel CB#" + Tag(b) + " bot"), "day stop late fill: a bot entry still working while latched: its cancel sent again at 5 s, no flatten: " + string.Join(" | ", c));
        double t1 = clock;
        s0 = page.Count;
        PartFill(b, 2, 1, 24985);   // the entry's other contract fills before the cancel lands
        Check(ChartBridgeBot.StripJson().Contains("\"position\":{\"qty\":1,") && page.Skip(s0).Any(x => x.Contains("trade " + Tag(b) + " is open again")),
              "day stop late fill: the late contract is followed (NinjaTrader holds it, the strip says so)");
        // NinjaTrader holds the late contract (both readings), and the first flatten's market close is still on its way
        own.Positions.Clear(); own.Positions.Add(new Position { Instrument = mnq, MarketPosition = MarketPosition.Long, Quantity = 1, AveragePrice = 24985 });
        Order close = new Order { Account = own, Instrument = mnq, Name = "Close", OrderAction = OrderAction.Sell, OrderType = OrderType.Market, OrderState = OrderState.Working, Quantity = 1 };
        own.Orders.Add(close);
        m = own.Calls.Count;
        for (int i = 0; i < 9; i++) { clock += 350; Bot("{\"type\":\"beat\"}"); ChartBridgeBot.Check(); }
        Check(Calls(own, m).Count == 0, "day stop late fill: at most one try every 5 s: " + string.Join(" | ", Calls(own, m)));
        clock = t1 + 4850; Bot("{\"type\":\"beat\"}");   // 5 s since the last try
        ChartBridgeBot.Check();
        double t2 = clock;
        Check(Calls(own, m).Count == 0 && File_("bot.log").Contains("the day stop's flatten again waits: a market order on OWN-1 MNQ may still fill (Close)"),
              "review R12 round 2: a market close still working on the bot's account and root: no second flatten (it could close twice): " + string.Join(" | ", Calls(own, m)));
        close.OrderState = OrderState.Cancelled;   // that close was cancelled; NinjaTrader still holds the contract
        for (int i = 0; i < 9; i++) { clock += 350; Bot("{\"type\":\"beat\"}"); ChartBridgeBot.Check(); }
        Check(Calls(own, m).Count == 0, "review R12 round 2: the try was used: nothing again before the next 5 s");
        clock = t2 + 4850; Bot("{\"type\":\"beat\"}");   // the next 5 s: eight checks at once, as overlapping timer callbacks
        using (Barrier go = new Barrier(8))
        {
            Thread[] ts = Enumerable.Range(0, 8).Select(_ => new Thread(() => { go.SignalAndWait(); ChartBridgeBot.CheckDayStops(); })).ToArray();
            foreach (Thread t in ts) t.Start();
            foreach (Thread t in ts) t.Join();
        }
        c = Calls(own, m);
        Check(c.Count(x => x == "flatten MNQ 12-26") == 1 && clock - t2 <= 5000,
              "review R12 finding 1: the late contract is flattened again once the close is no longer on its way, at the next 5 s, once, however many checks overlap: " + string.Join(" | ", c));
        Check(File_("bot.log").Contains("the day stop's flatten sent again: the bot still held its trade on OWN-1 MNQ"), "logged: the flatten sent again");
        // NinjaTrader's position is flat by both readings, its execution not in yet: nothing is sent again
        double t3 = clock;
        own.Positions.Clear();
        ((System.Collections.IDictionary)typeof(ChartBridgeOrders).GetField("Moves", PS).GetValue(null)).Clear();
        m = own.Calls.Count;
        for (int i = 0; i < 9; i++) { clock += 350; Bot("{\"type\":\"beat\"}"); ChartBridgeBot.Check(); }
        clock = t3 + 4850; Bot("{\"type\":\"beat\"}"); ChartBridgeBot.Check();
        Check(Calls(own, m).Count == 0 && ChartBridgeBot.StripJson().Contains("\"position\":{\"qty\":1,") && File_("bot.log").Contains("the day stop's flatten again waits: NinjaTrader's MNQ position on OWN-1 is already flat (only its executions are late)"),
              "review R12 round 2: NinjaTrader flat by both readings, the execution late: no flatten again: " + string.Join(" | ", Calls(own, m)));
        Sold(1, 24980);   // the second flatten's execution: -$10 more
        Settle();
        st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"position\":{\"qty\":0,") && st.Contains("\"trades\":1,") && st.Contains("\"losses\":1,") && st.Contains("\"pnlToday\":-40,") && st.Contains("\"mode\":\"shadow\"") &&
              File_("bot-day.txt").Contains("trade\t" + Tag(b) + "\t-40") && File_("bot-day.txt").Contains("stop\tloss\t-30"),
              "day stop late fill: the trade counts -$40, still one losing trade; the latch stays: " + st);
        m = own.Calls.Count;
        for (int i = 0; i < 24; i++) { clock += 350; Bot("{\"type\":\"beat\"}"); ChartBridgeBot.Check(); }
        Check(Calls(own, m).Count == 0, "day stop late fill: flat, nothing working: nothing more sent: " + string.Join(" | ", Calls(own, m)));
        et = et.AddDays(1); ChartBridgeBot.Check();
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Page(RailsMsg(1, 5, 3, "500", "500", "MNQ"));
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
    }

    // ------------------------------------------------------------ review R12 finding 2: a day stop reached while the page arms the bot
    static void ReArmRace()
    {
        Settle();
        et = et.AddDays(1); ChartBridgeBot.Check();
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Page(RailsMsg(1, 5, 3, "30", "40", "MNQ"));
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Order a = AutoTrade("buy");
        Check(a != null, "re-arm race: a bot trade");
        if (a == null) return;
        FillEntry(a, 25000);
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
        ChartBridgeOrders.NoteLast("MNQ", 24985);   // open -$30: the timer's next check reaches the loss stop
        // the timer's check lands after SetMode's arm check and before it sets the mode
        ChartBridgeBot.ModeArmChecked = () => { ChartBridgeBot.ModeArmChecked = null; ChartBridgeBot.Check(); };
        try { Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}"); }
        finally { ChartBridgeBot.ModeArmChecked = null; }
        string st = ChartBridgeBot.StripJson();
        Check(PageReject().Contains("auto refused: the day's loss stop ($30) was reached today") && st.Contains("\"mode\":\"shadow\"") && st.Contains("\"kind\":\"loss\""),
              "review R12 finding 2: a day stop reached while the page arms the bot: refused, the mode stays Shadow: " + PageReject());
        Sold(1, 24985);
        Settle();
        et = et.AddDays(1); ChartBridgeBot.Check();   // 18:00 ET: the latch ends
        st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"dayStop\":null") && st.Contains("\"mode\":\"shadow\""), "review R12 finding 2: at 18:00 ET the bot is not armed by itself: " + st);
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Page(RailsMsg(1, 5, 3, "500", "500", "MNQ"));
    }

    // ------------------------------------------------------------ review R12 round 2: a bot trade open across a restart (or a recompile)
    static void OpenAtRestart()
    {
        Settle();
        et = et.AddDays(1); ChartBridgeBot.Check();
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Page(RailsMsg(1, 5, 3, "30", "40", "MNQ"));
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Order a = AutoTrade("buy");
        Check(a != null, "open at restart: a bot trade");
        if (a == null) return;
        FillEntry(a, 25000);
        own.Positions.Clear(); own.Positions.Add(new Position { Instrument = mnq, MarketPosition = MarketPosition.Long, Quantity = 1, AveragePrice = 25000 });
        Check(DayLine("trade\t" + Tag(a) + "\topen\t0\t1\t25000"),
              "open at restart: bot-day.txt says open, with its dollars closed so far (0), its size and its price (R12, the day file): " + File_("bot-day.txt"));
        Restart();
        string st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"position\":{\"qty\":1,\"avgPrice\":25000}") && st.Contains("\"standDown\":null") && File_("bot.log").Contains("trade " + Tag(a) + " (open in bot-day.txt) is followed again from its 1 open stop: 1 MNQ 12-26 at 25000 (its price in bot-day.txt) on OWN-1") &&
              !File_("bot.log").Contains("the rest is not the bot's"),
              "review R12 round 3: after a restart the open trade is followed again from its own stop leg, NinjaTrader's position matching: " + st);
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Check(Last(page, "bot").Contains("\"mode\":\"auto\""), "open at restart: followed again, so Anthony may arm it");
        int n0 = own.Calls.Count;
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("already has a position") && own.Calls.Count == n0, "open at restart: the restored trade is the bot's one trade (a new entry refused)");
        int m = own.Calls.Count;
        ChartBridgeOrders.NoteLast("MNQ", 24985);   // open -$30: its dollars reach the day stop again
        ChartBridgeBot.Check();
        Check(Calls(own, m).Contains("flatten MNQ 12-26") && ChartBridgeBot.StripJson().Contains("\"kind\":\"loss\""), "review R12 round 2: the restored trade's dollars reach the day stop, which flattens it");
        Sold(1, 24985);
        Settle();
        Check(File_("bot-day.txt").Contains("trade\t" + Tag(a) + "\t-30"), "open at restart: it closes at -$30 in bot-day.txt");
        // a latched day restarted with the trade still open: the latch flattens it once it is followed again
        et = et.AddDays(1); ChartBridgeBot.Check();
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Order b = AutoTrade("buy");
        Check(b != null, "open at restart, latched: a bot trade");
        if (b == null) return;
        FillEntry(b, 25000);
        File.AppendAllText(Path.Combine(home, "ChartBridge", "bot-day.txt"), "stop\tloss\t-30\n");   // made up: the latch saved, the flatten never landed
        own.Positions.Clear(); own.Positions.Add(new Position { Instrument = mnq, MarketPosition = MarketPosition.Long, Quantity = 1, AveragePrice = 25000 });
        m = own.Calls.Count;
        Restart();
        ChartBridgeBot.Check();
        Check(Calls(own, m).Count(x => x == "flatten MNQ 12-26") == 1 && ChartBridgeBot.StripJson().Contains("\"kind\":\"loss\""),
              "review R12 round 2: a latched day restarted with the bot's trade open: followed again and flattened: " + string.Join(" | ", Calls(own, m)));
        Sold(1, 25000);
        Settle();
        // review R12 round 3: the stop filled while ChartBridge was down (bot-day.txt still says open), the account is flat, the day was
        // latched; later Anthony opens his own MNQ by hand: never taken as the bot's, nothing flattened, the refusal stays until 18:00 ET
        et = et.AddDays(1); ChartBridgeBot.Check();
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Order c = AutoTrade("buy");
        Check(c != null, "open at restart, flat: a bot trade");
        if (c == null) return;
        FillEntry(c, 25000);
        LegsDone(c);   // its stop filled, its target cancelled, while ChartBridge was down
        own.Positions.Clear();
        File.AppendAllText(Path.Combine(home, "ChartBridge", "bot-day.txt"), "stop\tloss\t-30\n");   // made up: the day latched as well
        Restart();
        st = ChartBridgeBot.StripJson();
        string why = "bot trade " + Tag(c) + " was still open when ChartBridge started (bot-day.txt), and NinjaTrader shows no stop or target of it (CB#" + Tag(c) + ") with its MNQ position on OWN-1: copilot, auto and new bot entries are refused until it is followed again (or 18:00 ET)";
        Check(st.Contains("\"position\":{\"qty\":0,") && st.Contains("\"standDown\":\"" + why + "\""), "review R12 round 3: bot-day.txt open, NinjaTrader flat: the bot stands down, named: " + st);
        foreach (string mode in new[] { "copilot", "auto" })
        {
            Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"" + mode + "\"}");
            Check(PageReject().Contains(mode + " refused: " + why) && Last(page, "bot").Contains("\"mode\":\"shadow\""), "review R12 round 3: " + mode + " refused while the open trade is not followed: " + PageReject());
        }
        own.Positions.Add(new Position { Instrument = mnq, MarketPosition = MarketPosition.Long, Quantity = 1, AveragePrice = 25005 });   // Anthony's own, by hand
        int k = own.Calls.Count;
        for (int i = 0; i < 24; i++) { clock += 350; Bot("{\"type\":\"beat\"}"); ChartBridgeBot.Check(); }
        st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"position\":{\"qty\":0,") && st.Contains("\"standDown\":\"" + why + "\"") && Calls(own, k).Count == 0 && !File_("bot.log").Contains("trade " + Tag(c) + " (open in bot-day.txt) is followed again"),
              "review R12 round 3: a bare position with no stop or target of the bot's trade is never taken as the bot's: not followed, not flattened, still refused: " + string.Join(" | ", Calls(own, k)));
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Check(PageReject().Contains("auto refused: " + why), "review R12 round 3: still no arming");
        Settle();   // Anthony's own position closed
        et = et.AddDays(1); ChartBridgeBot.Check();   // 18:00 ET: the never-followed trade goes with the day
        st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"standDown\":null") && st.Contains("\"position\":{\"qty\":0,"), "review R12 round 3: at 18:00 ET the refusal ends with the day: " + st);
        // Anthony holds more by hand than the bot's leg covers: the bot follows its own size, at its own entry's fill (still listed)
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Order d = AutoTrade("buy");
        Check(d != null, "open at restart, larger: a bot trade");
        if (d == null) return;
        FillEntry(d, 25000);
        own.Positions.Clear(); own.Positions.Add(new Position { Instrument = mnq, MarketPosition = MarketPosition.Long, Quantity = 3, AveragePrice = 25010 });
        Restart();
        st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"position\":{\"qty\":1,\"avgPrice\":25000}") && st.Contains("\"standDown\":null") &&
              File_("bot.log").Contains("trade " + Tag(d) + " (open in bot-day.txt) is followed again from its 1 open stop: 1 MNQ 12-26 at 25000 (its price in bot-day.txt) on OWN-1; NinjaTrader holds 3 there, the rest is not the bot's"),
              "review R12 round 3: Anthony's position larger than the bot's leg: the bot follows 1 (its stop's size), not 3, at its own entry's 25000, not NinjaTrader's 25010: " + st);
        Sold(1, 25010);
        Settle();
        Check(File_("bot-day.txt").Contains("trade\t" + Tag(d) + "\t20"), "R12 round 3 follow-up: the restored trade closes on its own entry's price (+$20), not on Anthony's average (+$0)");
        // the same with the bot's entry no longer listed by NinjaTrader, from an older build's file: NinjaTrader's average, as before
        et = et.AddDays(1); ChartBridgeBot.Check();
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Order g = AutoTrade("buy");
        Check(g != null, "open at restart, no entry listed: a bot trade");
        if (g == null) return;
        FillEntry(g, 25000);
        own.Orders.Remove(g);
        own.Positions.Clear(); own.Positions.Add(new Position { Instrument = mnq, MarketPosition = MarketPosition.Long, Quantity = 3, AveragePrice = 25010 });
        OldLine(g);   // R12 (the day file): a file from an older build, with no price in it, is where these fallbacks still apply
        Restart();
        st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"position\":{\"qty\":1,\"avgPrice\":25010}") && st.Contains("\"standDown\":null") &&
              File_("bot.log").Contains("trade " + Tag(g) + " (open in bot-day.txt) is followed again from its 1 open stop: 1 MNQ 12-26 at 25010 (NinjaTrader's average) on OWN-1; NinjaTrader holds 3 there, the rest is not the bot's"),
              "R12 round 3 follow-up: the bot's entry not listed: followed at NinjaTrader's average, as before: " + st);
        Sold(1, 25010);
        Settle();
        // Anthony's own long on the bot's root; the bot's long closed by its stop while ChartBridge was down and its target's cancel is
        // still on its way: a leg being cancelled is no proof, so Anthony's long is never taken as the bot's
        foreach (OrderState cancelling in new[] { OrderState.CancelPending, OrderState.CancelSubmitted })
        {
            et = et.AddDays(1); ChartBridgeBot.Check();
            ChartBridgeOrders.NoteLast("MNQ", 25000);
            Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
            Order h = AutoTrade("buy");
            Check(h != null, "open at restart, " + cancelling + ": a bot trade");
            if (h == null) return;
            FillEntry(h, 25000);
            Order target = own.Orders.FirstOrDefault(o => o != h && Tag(o) == Tag(h) && o.OrderType == OrderType.Limit && ChartBridgeOrders.IsWorking(o.OrderState));
            Check(target != null, "open at restart, " + cancelling + ": the trade has a target");
            if (target == null) return;
            LegsDone(h);   // its stop filled
            target.OrderState = cancelling;   // its target's cancel not yet done
            own.Positions.Clear(); own.Positions.Add(new Position { Instrument = mnq, MarketPosition = MarketPosition.Long, Quantity = 1, AveragePrice = 25005 });   // Anthony's own, by hand
            int r = own.Calls.Count;
            Restart();
            for (int i = 0; i < 4; i++) { clock += 350; Bot("{\"type\":\"beat\"}"); ChartBridgeBot.Check(); }
            st = ChartBridgeBot.StripJson();
            Check(st.Contains("\"position\":{\"qty\":0,") && st.Contains("\"standDown\":\"bot trade " + Tag(h) + " was still open when ChartBridge started") &&
                  !File_("bot.log").Contains("trade " + Tag(h) + " (open in bot-day.txt) is followed again") && Calls(own, r).Count == 0,
                  "R12 round 3 follow-up: the only leg left is " + cancelling + ": Anthony's long is not taken as the bot's, nothing sent, still refused: " + st);
            Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
            Check(PageReject().Contains("auto refused: bot trade " + Tag(h) + " was still open"), "R12 round 3 follow-up: " + cancelling + ": no arming");
            target.OrderState = OrderState.Cancelled;
            Settle();
        }
        // NinjaTrader's position is on the other side from the bot's legs: refused
        et = et.AddDays(1); ChartBridgeBot.Check();
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Order e = AutoTrade("buy");
        Check(e != null, "open at restart, other side: a bot trade");
        if (e == null) return;
        FillEntry(e, 25000);
        own.Positions.Clear(); own.Positions.Add(new Position { Instrument = mnq, MarketPosition = MarketPosition.Short, Quantity = 1, AveragePrice = 25000 });
        Restart();
        ChartBridgeBot.Check();
        st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"position\":{\"qty\":0,") && st.Contains("\"standDown\":\"bot trade " + Tag(e) + " was still open when ChartBridge started"),
              "review R12 round 3: NinjaTrader short while the bot's stop protects a long: not followed, refused: " + st);
        Settle();
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
        et = et.AddDays(1); ChartBridgeBot.Check();
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Page(RailsMsg(1, 5, 3, "500", "500", "MNQ"));
    }

    // ------------------------------------------------------------ R12 (the day file): what bot-day.txt keeps of a trade open across a restart
    // The made-up trades below are MNQ ($2 a point, $0.50 a tick); the loss stops are made up.
    static List<Order> LegsOf(Order e) { return own.Orders.Where(o => o != e && Tag(o) == Tag(e) && ChartBridgeOrders.IsWorking(o.OrderState)).ToList(); }
    static void LegsTo(Order e, int qty) { foreach (Order o in LegsOf(e)) { o.Quantity = qty; o.Filled = 0; } }   // as NinjaTrader shows them after the legs check's change
    static void Held(int qty, double avg)
    {
        own.Positions.Clear();
        if (qty != 0) own.Positions.Add(new Position { Instrument = mnq, MarketPosition = qty > 0 ? MarketPosition.Long : MarketPosition.Short, Quantity = Math.Abs(qty), AveragePrice = avg });
    }
    static Order DayTrade(string what, int size, string loss)
    {
        Settle();
        et = et.AddDays(1); ChartBridgeBot.Check();
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Page(RailsMsg(size, 5, 3, loss, "500", "MNQ"));
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Order e = AutoTrade("buy");
        Check(e != null && e.Quantity == size, what + ": a bot trade of " + size + ": " + BotReject() + " / " + PageReject());
        return e != null && e.Quantity == size ? e : null;
    }
    // The loss stop: nothing a tick before `at`, then the flatten once at `at`, the day latched at `day`.
    static void LossStopAt(double notYet, double at, string day, string what)
    {
        int m = own.Calls.Count;
        ChartBridgeOrders.NoteLast("MNQ", notYet); ChartBridgeBot.Check();
        string st = ChartBridgeBot.StripJson();
        Check(Calls(own, m).Count == 0 && st.Contains("\"dayStop\":null"), what + ": nothing yet at " + notYet + ": " + string.Join(" | ", Calls(own, m)) + " / " + st);
        ChartBridgeOrders.NoteLast("MNQ", at); ChartBridgeBot.Check();
        st = ChartBridgeBot.StripJson();
        Check(Calls(own, m).Count(x => x == "flatten MNQ 12-26") == 1 && st.Contains("\"dayStop\":{\"kind\":\"loss\",\"day\":" + day + ","),
              what + ": the loss stop flattens at " + at + ", the true day at " + day + ": " + string.Join(" | ", Calls(own, m)) + " / " + st);
    }
    static void DayFile()
    {
        string f = Path.Combine(home, "ChartBridge", "bot-day.txt");
        // (2) Anthony sells 1 of the bot's 2 by hand (-$16), then a restart: the loss stop ($30) fires at the true day, at 24993 (-$16
        // closed, -$14 open), never at 24985 (-$46 in truth)
        Order a = DayTrade("part exit", 2, "30");
        if (a == null) return;
        FillEntry(a, 25000);
        Held(2, 25000);
        Sold(1, 24992);
        Held(1, 25000);
        Check(DayLine("trade\t" + Tag(a) + "\topen\t-16\t1\t25000"), "R12 (the day file): a part exit is saved at once: open, -$16 closed so far, 1 held at 25000: " + File_("bot-day.txt"));
        LegsTo(a, 1);
        Restart();
        string st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"position\":{\"qty\":1,\"avgPrice\":25000}") && st.Contains("\"standDown\":null") &&
              File_("bot.log").Contains("trade " + Tag(a) + " (open in bot-day.txt) is followed again from its 1 open stop: 1 MNQ 12-26 at 25000 (its price in bot-day.txt) on OWN-1, with -$16 already closed"),
              "R12 (the day file): a part exit, then a restart: the 1 left is followed again with the -$16 already closed: " + st);
        LossStopAt(24993.5, 24993, "-30", "part exit, then a restart");
        Sold(1, 24993);
        Settle();
        st = ChartBridgeBot.StripJson();
        Check(DayLine("trade\t" + Tag(a) + "\t-30") && st.Contains("\"trades\":1,") && st.Contains("\"losses\":1,") && st.Contains("\"pnlToday\":-30,"),
              "part exit, then a restart: the trade closes at its true -$30 (-$16 and -$14), one losing trade: " + st);

        // (3) a late entry fill reopens a closed trade (-$8 closed), then a restart: followed again, counted, and flattened by a latched day
        foreach (bool latched in new[] { false, true })
        {
            string what = latched ? "reopened, then a restart on a latched day" : "reopened, then a restart";
            Order b = DayTrade(what, 2, "30");
            if (b == null) return;
            PartFill(b, 1, 1, 25000);
            Held(1, 25000);
            Sold(1, 24996);   // its stop leg: -$8, the trade closes
            LegsDone(b);   // that stop filled, its target cancelled (as NinjaTrader lists them)
            Held(0, 0);
            Check(DayLine("trade\t" + Tag(b) + "\t-8"), what + ": closed at -$8 first");
            PartFill(b, 2, 1, 24996);   // the entry's other contract fills after the trade closed: reopened
            b.AverageFillPrice = 24998;   // NinjaTrader's average of both entry fills, not the reopened contract's price
            Held(1, 24996);
            Check(DayLine("trade\t" + Tag(b) + "\topen\t-8\t1\t24996"),
                  what + ": R12 (b): a reopened trade is saved open, with what it closed with (-$8), its size and its own price: " + File_("bot-day.txt"));
            Check(LegsOf(b).Count == 2, what + ": the late contract's stop and target are working: " + string.Join(" | ", own.Orders.Where(o => Tag(o) == Tag(b)).Select(o => o.Name + " " + o.OrderState + " q" + o.Quantity)));
            if (latched) File.AppendAllText(f, "stop\tloss\t-30\n");   // made up: the latch saved, the flatten never landed
            int m = own.Calls.Count;
            Restart();
            st = ChartBridgeBot.StripJson();
            Check(st.Contains("\"position\":{\"qty\":1,\"avgPrice\":24996}") &&
                  File_("bot.log").Contains("trade " + Tag(b) + " (open in bot-day.txt) is followed again from its 1 open stop: 1 MNQ 12-26 at 24996 (its price in bot-day.txt) on OWN-1, with -$8 already closed"),
                  what + ": followed again at its own 24996 (not the entry's 24998), with the -$8 it closed with: " + st);
            if (latched)
            {
                ChartBridgeBot.Check();
                st = ChartBridgeBot.StripJson();
                Check(Calls(own, m).Count(x => x == "flatten MNQ 12-26") == 1 && st.Contains("\"kind\":\"loss\"") && st.Contains("\"mode\":\"shadow\""),
                      what + ": the latched day flattens the reopened trade once it is followed again: " + string.Join(" | ", Calls(own, m)) + " / " + st);
                Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
                Check(PageReject().Contains("auto refused: the day's loss stop ($30) was reached today"), what + ": the latch stays across the restart");
                Sold(1, 24996);
                Settle();
                Check(DayLine("trade\t" + Tag(b) + "\t-8") && DayLine("stop\tloss\t-30"), what + ": closed at -$8 in all, still latched: " + File_("bot-day.txt"));
                continue;
            }
            Check(st.Contains("\"standDown\":null") && st.Contains("\"trades\":1,"), what + ": followed, so nothing is refused; still one trade: " + st);
            LossStopAt(24985.5, 24985, "-30", what);
            Sold(1, 24985);
            Settle();
            st = ChartBridgeBot.StripJson();
            Check(DayLine("trade\t" + Tag(b) + "\t-30") && st.Contains("\"trades\":1,") && st.Contains("\"losses\":1,") && st.Contains("\"pnlToday\":-30,"),
                  what + ": the trade closes at its true -$30 (-$8 and -$22), one losing trade: " + st);
        }

        // (4) a three field open line from an older build: 0 dollars closed (that build never kept them), still followed by its legs
        Order d = DayTrade("older build's line", 2, "30");
        if (d == null) return;
        FillEntry(d, 25000);
        Held(2, 25000);
        Sold(1, 24992);
        Held(1, 25000);
        LegsTo(d, 1);
        OldLine(d);
        Check(DayLine("trade\t" + Tag(d) + "\topen"), "older build's line: trade<TAB>tag<TAB>open");
        Restart();
        st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"position\":{\"qty\":1,\"avgPrice\":25000}") && st.Contains("\"standDown\":null") &&
              File_("bot.log").Contains("trade " + Tag(d) + " (open in bot-day.txt) is followed again from its 1 open stop: 1 MNQ 12-26 at 25000 (its entry's fill) on OWN-1\n") ||
              File_("bot.log").Contains("trade " + Tag(d) + " (open in bot-day.txt) is followed again from its 1 open stop: 1 MNQ 12-26 at 25000 (its entry's fill) on OWN-1\r\n"),
              "older build's line: read as 0 closed and followed by its legs at its entry's fill, as before: " + st);
        LossStopAt(24985.5, 24985, "-30", "older build's line (0 closed)");
        Sold(1, 24985);
        Settle();
        Check(DayLine("trade\t" + Tag(d) + "\t-30"), "older build's line: the part followed closes at -$30");

        // a size that changed while the trade was not followed (its stop filled 1 of 2 while ChartBridge was down): followed, its
        // known dollars count, but the rest cannot be told: no arming and no entry until 18:00 ET, kept across a restart
        Order u = DayTrade("size changed unseen", 2, "30");
        if (u == null) return;
        FillEntry(u, 25000);
        Held(2, 25000);
        Check(DayLine("trade\t" + Tag(u) + "\topen\t0\t2\t25000"), "size changed unseen: saved open at 2");
        Order stop = LegsOf(u).FirstOrDefault(o => o.OrderType == OrderType.StopMarket);
        Check(stop != null, "size changed unseen: its stop");
        if (stop == null) return;
        stop.Filled = 1;
        Held(1, 25000);
        Restart();
        st = ChartBridgeBot.StripJson();
        string why = "bot trade " + Tag(u) + " held 2 when it was saved (bot-day.txt) and 1 when it was followed again: the dollars of those contracts cannot be told, so copilot, auto and new bot entries are refused until 18:00 ET";
        Check(st.Contains("\"position\":{\"qty\":1,") && st.Contains("\"standDown\":\"" + why + "\"") && DayLine("untold\t" + Tag(u)),
              "R12 (the day file): a size changed while not followed: followed, refused and named, kept in bot-day.txt: " + st);
        foreach (string mode in new[] { "copilot", "auto" })
        {
            Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"" + mode + "\"}");
            Check(PageReject().Contains(mode + " refused: " + why) && Last(page, "bot").Contains("\"mode\":\"shadow\""), "size changed unseen: " + mode + " refused: " + PageReject());
        }
        Restart();
        st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"position\":{\"qty\":1,") && st.Contains("\"standDown\":\"bot trade " + Tag(u) + " changed size while ChartBridge was not following it (bot-day.txt): the dollars of those contracts cannot be told"),
              "size changed unseen: still refused after another restart: " + st);
        Sold(1, 24990);
        Settle();
        et = et.AddDays(1); ChartBridgeBot.Check();
        st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"standDown\":null") && !File_("bot-day.txt").Contains("untold"), "size changed unseen: the refusal ends at 18:00 ET: " + st);

        // the entry fills more while its open trade waits to be followed again (NinjaTrader has not listed the position yet)
        Order v = DayTrade("entry fill before it is followed again", 2, "500");
        if (v == null) return;
        PartFill(v, 1, 1, 25000);
        Check(DayLine("trade\t" + Tag(v) + "\topen\t0\t1\t25000"), "entry fill before followed: saved open at 1");
        Held(0, 0);
        Restart();
        Check(ChartBridgeBot.StripJson().Contains("\"standDown\":\"bot trade " + Tag(v) + " was still open when ChartBridge started"), "entry fill before followed: waiting");
        PartFill(v, 2, 1, 25004);
        Check(DayLine("untold\t" + Tag(v)) && DayLine("trade\t" + Tag(v) + "\topen\t0\t1\t25000") && File_("bot.log").Contains("Bot stands down: bot trade " + Tag(v) + "'s entry filled 1 more before it was followed again after a restart"),
              "R12 (the day file): an entry fill of a trade not followed again yet is never a fresh ledger: refused until 18:00 ET, kept: " + File_("bot-day.txt"));
        Held(2, 25002);
        LegsTo(v, 2);
        ChartBridgeBot.Check();
        st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"position\":{\"qty\":2,") && st.Contains("the dollars of those contracts cannot be told"), "entry fill before followed: followed at 2 once listed, still refused: " + st);
        Sold(2, 25002);
        Settle();

        // a trade carried past 18:00 ET: the contract it closed yesterday (+$100) is yesterday's, so today's loss stop reads today only
        Order r = DayTrade("carried past 18:00 ET", 2, "30");
        if (r == null) return;
        FillEntry(r, 25000);
        Held(2, 25000);
        Sold(1, 25050);
        Held(1, 25000);
        DateTime day = et.Hour >= 18 ? et.Date.AddDays(1) : et.Date;   // the trading day's date (it ends at 18:00 ET that day)
        et = day.AddHours(18).AddSeconds(1); ChartBridgeBot.Check();   // 18:00 ET: a new trading day
        Check(DayLine("trade\t" + Tag(r) + "\topen\t0\t1\t25000"), "carried past 18:00 ET: saved open, nothing closed today: " + File_("bot-day.txt"));
        LossStopAt(24985.5, 24985, "-30", "carried past 18:00 ET");
        Sold(1, 24985);
        Settle();
        Check(DayLine("trade\t" + Tag(r) + "\t-30"), "carried past 18:00 ET: today's part closes at -$30");
        et = day.AddDays(1).AddHours(10);

        // (5) a day file that does not read: the bot stands down, named; copilot and auto are refused; nothing is ever sent; the file
        // is never written over. Then a save cut off (no bot-day.txt, a copy of today's left): the same. A copy of another day: a new day.
        Settle();
        et = et.AddDays(1); ChartBridgeBot.Check();
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Page(RailsMsg(1, 5, 3, "500", "500", "MNQ"));
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
        string today = et.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), yesterday = et.AddDays(-1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        string[][] bad = {
            new[] { "session\t" + today, "trade\tabcdef12\topen\t-16\t1" },             // a line cut short
            new[] { "session\t" + today, "trade\tabcdef12\topen\t-16" },                // the reviewer's four fields: not this build's
            new[] { "session\t" + today, "trade\tabcdef12\topen\t-1x\t1\t25000" },      // a number that does not read
            new[] { "session\t" + today, "trade\tabcdef12\topen\t-16\t0\t25000" },      // size 0
            new[] { "session\t" + today, "trade\tabcdef12\topen\t-16\t1\t0" },          // no price
            new[] { "session\t" + today, "untold\txyz" },                              // a tag that is not one
            new[] { "trade\tabcdef12\t-16" },                                          // no session line
        };
        foreach (string[] lines in bad)
        {
            Gone(f);
            File.WriteAllLines(f, lines);
            string text = File_("bot-day.txt");
            Restart();
            string want = lines.Length == 1 ? "bot-day.txt has no session line" : "bot-day.txt has a line ChartBridge does not understand";
            want += ": no new bot entries this run (delete it to start the day over)";
            st = ChartBridgeBot.StripJson();
            Check(st.Contains("\"standDown\":\"" + want + "\""), "R12 (the day file): " + lines[lines.Length - 1].Replace("\t", " ") + ": the bot stands down, named: " + st);
            foreach (string mode in new[] { "copilot", "auto" })
            {
                Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"" + mode + "\"}");
                Check(PageReject().Contains(mode + " refused: " + want) && Last(page, "bot").Contains("\"mode\":\"shadow\""), "R12 (the day file): " + mode + " refused on a day that does not read: " + PageReject());
            }
            int n = own.Calls.Count;
            Bot(Sig(NewId(), Market("buy")));
            for (int i = 0; i < 4; i++) { clock += 350; Bot("{\"type\":\"beat\"}"); ChartBridgeBot.Check(); }
            Check(own.Calls.Count == n && File_("bot-day.txt") == text, "R12 (the day file): nothing sent, and the file is never written over");
        }
        foreach (string[] left in new[] { new[] { ".tmp" }, new[] { ".bak", ".tmp" } })
        {
            Gone(f);
            foreach (string ext in left) File.WriteAllLines(f + ext, new[] { "# made-up", "session\t" + today, "trade\tabcdef12\t-16" });
            Restart();
            string want = "bot-day.txt is missing and bot-day.txt" + left[0] + " (today's session) is there: a save may have been cut off: no new bot entries this run (delete " +
                          string.Join(" and ", left.Select(x => "bot-day.txt" + x)) + " to start the day over)";
            st = ChartBridgeBot.StripJson();
            Check(st.Contains("\"standDown\":\"" + want + "\"") && st.Contains("\"trades\":0,"), "R12 (the day file): a save cut off (" + string.Join(", ", left) + " left): never an empty day by accident, named: " + st);
            Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
            Check(PageReject().Contains("auto refused: " + want) && Last(page, "bot").Contains("\"mode\":\"shadow\""), "R12 (the day file): auto refused after a save cut off");
        }
        Gone(f);
        File.WriteAllLines(f + ".bak", new[] { "# made-up", "session\t" + yesterday, "trade\tabcdef12\t-16" });
        Restart();
        st = ChartBridgeBot.StripJson();
        Check(st.Contains("\"standDown\":null") && st.Contains("\"trades\":0,"), "R12 (the day file): a copy of an earlier day left: a new day: " + st);
        Gone(f);
        Restart();
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
        et = et.AddDays(1); ChartBridgeBot.Check();
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Page(RailsMsg(1, 5, 3, "500", "500", "MNQ"));
    }

    // ------------------------------------------------------------ a v2 page (no "client") gets no v3 message
    static void V2PageGetsNothing()
    {
        Check(Count(page2, "bot") == 0 && Count(page2, "botSignal") == 0 && Count(page2, "botProposal") == 0, "a v2 page (the 1.15 page) gets no bot message at all");
    }

    // ------------------------------------------------------------ the real request handler: /bot, /bot-library, /diag
    static void Http()
    {
        int port = 20000 + new Random().Next(9000);
        HttpListener l = new HttpListener();
        l.Prefixes.Add("http://*:" + port + "/");
        l.Start();
        MethodInfo handle = typeof(ChartBridgeServer).GetMethod("Handle", PS);
        Task serving = Task.Run(() =>
        {
            while (l.IsListening)
            {
                HttpListenerContext ctx;
                try { ctx = l.GetContext(); } catch (Exception) { break; }
                try { ((Task)handle.Invoke(null, new object[] { ctx, CancellationToken.None })).Wait(); } catch (Exception ex) { Console.WriteLine("handler threw: " + ex.Message); }
            }
        });
        ChartBridgeConfig.Port = port;
        try
        {
            string secret = File.ReadAllLines(Path.Combine(home, "ChartBridge", "bot-secret.txt"))[2];
            int s;
            Get(port, "/bot", null, null, out s);
            Check(s == 403, "GET /bot without the secret: 403 (" + s + ")");
            Get(port, "/bot", "http://localhost:" + port, secret, out s);
            Check(s == 403, "GET /bot with an Origin header: 403 (" + s + ")");
            Get(port, "/bot", null, secret, out s);
            Check(s == 400, "GET /bot with the secret but no upgrade (Mono has no server WebSocket): 400 (" + s + ")");
            Get(port, "/bot-library", null, null, out s);
            Check(s == 404, "/bot-library with no file: 404 (" + s + ")");
            string lib = "{\"version\":1,\"bots\":[{\"name\":\"Demo Opening Fade\",\"note\":\"made up\"}]}";
            File.WriteAllText(Path.Combine(home, "ChartBridge", "bot-library.json"), lib);
            string body = Get(port, "/bot-library", null, null, out s);
            Check(s == 200 && body == lib, "/bot-library: the file's bytes as JSON (" + s + ")");
            Get(port, "/bot-library", null, null, out s, "127.0.0.1:" + port);
            Check(s == 403, "/bot-library asked for by another name than localhost: 403 (" + s + ")");
            File.WriteAllText(Path.Combine(home, "ChartBridge", "bot-library.json"), "{\"bots\":[1,2,}");
            body = Get(port, "/bot-library", null, null, out s);
            Check(s == 500 && body.Contains("not valid JSON"), "/bot-library: a file that is not valid JSON is not served (" + s + ")");
            File.WriteAllText(Path.Combine(home, "ChartBridge", "bot-library.json"), "[\"" + new string('x', ChartBridgeBot.MaxLibraryBytes) + "\"]");
            body = Get(port, "/bot-library", null, null, out s);
            Check(s == 500 && body.Contains("over 2 MB"), "/bot-library: over 2 MB is not served (" + s + ")");
            Check(ChartBridgeBot.JsonValid("{\"a\":[1,2.5e3,-0.1,true,null,\"\\u00e9\"]}") && !ChartBridgeBot.JsonValid("{\"a\":01}") && !ChartBridgeBot.JsonValid("[1] x") && !ChartBridgeBot.JsonValid(""), "the JSON check");
            // 0.6.20 (C2): GET /roster, the Lab's roster files from the folder rosterFolder names (made-up files)
            Get(port, "/roster", null, null, out s);
            Check(s == 404, "/roster with no rosterFolder set: 404 (" + s + ")");
            string rf = Path.Combine(home, "made-up-botlab", "roster");
            ChartBridgeRoster.FolderSetting = rf;
            body = Get(port, "/roster", null, null, out s);
            Check(s == 500 && body.Contains("the roster folder named in config.txt is not there") && !body.Contains(rf), "/roster: the folder is not there: 500, and its path is never sent (" + s + ")");
            Directory.CreateDirectory(Path.Combine(rf, "sub"));
            string ro = "{\"format\": \"specrunner.roster/1\", \"bot\": \"alpha\", \"numbers\": {\"eval\": {\"profit_per_dollar\": 0.42}}}";
            string lu = "{\"format\":\"specrunner.lineup/1\",\"lineup\":\"morning\"}";
            File.WriteAllText(Path.Combine(rf, "alpha.json"), ro);
            File.WriteAllText(Path.Combine(rf, "morning.json"), "\ufeff" + lu + "\n");
            File.WriteAllText(Path.Combine(rf, "broken.json"), "{\"format\":\"specrunner.roster/1\",");
            File.WriteAllText(Path.Combine(rf, "other.json"), "{\"format\":\"something.else/1\"}");
            File.WriteAllText(Path.Combine(rf, "list.json"), "[\"specrunner.roster/1\"]");
            File.WriteAllText(Path.Combine(rf, "big.json"), "{\"format\":\"specrunner.roster/1\",\"x\":\"" + new string('x', ChartBridgeRoster.MaxFileBytes) + "\"}");
            File.WriteAllText(Path.Combine(rf, "bad name.json"), ro);
            File.WriteAllText(Path.Combine(rf, "notes.txt"), "not json, not served");
            File.WriteAllText(Path.Combine(rf, "sub", "deep.json"), ro);
            body = Get(port, "/roster", null, null, out s);
            // 0.6.21 (the review of 93, FIX 2): each served file carries its sha256 after the roster, the one a page names when it arms
            Func<string, string> shaOf = t => { using (System.Security.Cryptography.SHA256 h = System.Security.Cryptography.SHA256.Create()) return string.Concat(h.ComputeHash(File.ReadAllBytes(Path.Combine(rf, t))).Select(x => x.ToString("x2"))); };
            Check(s == 200 && body.StartsWith("{\"files\":[{\"name\":\"alpha.json\",\"ok\":true,\"roster\":" + ro + ",\"sha256\":\"" + shaOf("alpha.json") + "\"}") && body.EndsWith("],\"left\":0}") && ChartBridgeBot.JsonValid(body),
                  "/roster: a good file is served as it is, in name order, the answer valid JSON: " + body.Substring(0, Math.Min(200, body.Length)));
            Check(body.Contains("{\"name\":\"morning.json\",\"ok\":true,\"roster\":" + lu + ",\"sha256\":\"" + shaOf("morning.json") + "\"}"), "/roster: a lineup file too, its byte order mark and trailing line break taken off (its sha256 of the file as it is on disk)");
            Check(body.Contains("{\"name\":\"broken.json\",\"ok\":false,\"why\":\"not valid JSON\"}") && body.Contains("{\"name\":\"other.json\",\"ok\":false,\"why\":\"not a roster file") &&
                  body.Contains("{\"name\":\"list.json\",\"ok\":false,\"why\":\"not a roster file") && body.Contains("{\"name\":\"big.json\",\"ok\":false,\"why\":\"over 256 KB\"}") &&
                  body.Contains("{\"name\":\"bad name.json\",\"ok\":false,\"why\":\"not a plain name"),
                  "/roster: a file that is not valid JSON, not a roster file, too big or of an odd name is listed with why, never served");
            Check(!body.Contains("deep.json") && !body.Contains("notes.txt") && !body.Contains(rf), "/roster: nothing from a subfolder, nothing but .json, and never the folder's path");
            Get(port, "/roster", null, null, out s, "127.0.0.1:" + port);
            Check(s == 403, "/roster asked for by another name than localhost: 403 (" + s + ")");
            for (int i = 0; i < ChartBridgeRoster.MaxFiles + 3; i++) File.WriteAllText(Path.Combine(rf, "z" + i.ToString("000", CultureInfo.InvariantCulture) + ".json"), ro);
            body = Get(port, "/roster", null, null, out s);
            Check(s == 200 && Regex.Matches(body, "\\{\"name\":").Count == ChartBridgeRoster.MaxFiles && body.EndsWith("],\"left\":" + (7 + ChartBridgeRoster.MaxFiles + 3 - ChartBridgeRoster.MaxFiles) + "}"), "/roster: at most 200 files, and how many are left over is said: " + body.Substring(Math.Max(0, body.Length - 40)));
            // 0.6.21, the review of 91. D1: the format is the TOP-LEVEL key, wherever it stands; never a nested one, one in a list, or
            // the words inside a string
            foreach (string f in Directory.GetFiles(rf, "z*.json")) File.Delete(f);
            File.WriteAllText(Path.Combine(rf, "nested.json"), "{\"settings\":{\"format\":\"specrunner.roster/1\"},\"x\":1}");
            File.WriteAllText(Path.Combine(rf, "inlist.json"), "{\"a\":[{\"format\":\"specrunner.roster/1\"}],\"format\":\"other/1\"}");
            File.WriteAllText(Path.Combine(rf, "instring.json"), "{\"note\":\"\\\"format\\\":\\\"specrunner.roster/1\\\"\",\"format\":\"other/1\"}");
            File.WriteAllText(Path.Combine(rf, "later.json"), "{\"bot\":\"b\",\"t\":\"a\\\"b\",\"deep\":{\"format\":\"x\"},\"format\" : \"specrunner.lineup/1\"}");
            File.WriteAllBytes(Path.Combine(rf, "badutf.json"), new byte[] { 0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d });
            body = Get(port, "/roster", null, null, out s);
            Check(s == 200 && body.Contains("{\"name\":\"nested.json\",\"ok\":false,\"why\":\"not a roster file") && body.Contains("{\"name\":\"inlist.json\",\"ok\":false,\"why\":\"not a roster file") &&
                  body.Contains("{\"name\":\"instring.json\",\"ok\":false,\"why\":\"not a roster file"), "/roster (D1): the format text in a nested object, in a list or inside a string does not make a roster file");
            Check(body.Contains("{\"name\":\"later.json\",\"ok\":true,\"roster\":{\"bot\":\"b\""), "/roster (D1): the top-level format key is found wherever it stands in the object");
            Check(body.Contains("{\"name\":\"badutf.json\",\"ok\":false,\"why\":\"could not be read (DecoderFallbackException)\"}"), "/roster: bytes that are not UTF-8: not served, and only the error's type is said");
            Check(ChartBridgeRoster.TopLevelFormat("{\"format\":\"specrunner.roster/1\"}") == "specrunner.roster/1" && ChartBridgeRoster.TopLevelFormat(" { \"a\" : 1 , \"format\" : \"f\" } ") == "f" &&
                  ChartBridgeRoster.TopLevelFormat("{\"a\":{\"format\":\"f\"}}") == null && ChartBridgeRoster.TopLevelFormat("[\"format\",\"f\"]") == null && ChartBridgeRoster.TopLevelFormat("{\"format\":7}") == null &&
                  ChartBridgeRoster.TopLevelFormat("{\"x\":\"format\",\"y\":\"f\"}") == null && ChartBridgeRoster.TopLevelFormat("{\"a\":\"}\",\"format\":\"f\"}") == "f" && ChartBridgeRoster.TopLevelFormat("") == null,
                  "/roster (D1): the top-level format reader, case by case");
            // a file held open by another writer with no sharing: not served, the error's type only, never its path or message
            using (FileStream held = new FileStream(Path.Combine(rf, "alpha.json"), FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            {
                body = Get(port, "/roster", null, null, out s);
                Check(s == 200 && Regex.IsMatch(body, "\\{\"name\":\"alpha\\.json\",\"ok\":false,\"why\":\"could not be read \\([A-Za-z]+\\)\"\\}") && !body.Contains(rf), "/roster: a file that cannot be opened: listed with the error's type only: " + body.Substring(0, Math.Min(120, body.Length)));
            }
            // a file that is a link is never followed
            bool linked = false;
            try
            {
                System.Diagnostics.Process ln = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("ln", "-s \"" + Path.Combine(rf, "alpha.json") + "\" \"" + Path.Combine(rf, "linked.json") + "\"") { UseShellExecute = false });
                ln.WaitForExit(5000); linked = ln.ExitCode == 0;
            }
            catch (Exception) { }
            if (linked)
            {
                body = Get(port, "/roster", null, null, out s);
                Check(body.Contains("{\"name\":\"linked.json\",\"ok\":false,\"why\":\"a link: never followed\"}"), "/roster: a file that is a link is listed, never followed");
                Check(ChartBridgeRoster.PickProblem("linked.json") == "a link: never followed", "the pick: a link cannot be picked");
                File.Delete(Path.Combine(rf, "linked.json"));
            }
            // a method other than GET and HEAD
            Check(Send(port, "POST", "/roster") == 405 && Send(port, "PUT", "/roster") == 405 && Send(port, "DELETE", "/roster") == 405 && Send(port, "HEAD", "/roster") == 200, "/roster: POST, PUT and DELETE are refused (405); HEAD is answered");
            // D4: one cap for the whole answer (2 MB): what would pass it is listed with why, not served
            string fat = "{\"format\":\"specrunner.roster/1\",\"x\":\"" + new string('x', 250 * 1024) + "\"}";
            for (int i = 0; i < 12; i++) File.WriteAllText(Path.Combine(rf, "y" + i.ToString("00", CultureInfo.InvariantCulture) + ".json"), fat);
            body = Get(port, "/roster", null, null, out s);
            int servedFat = Regex.Matches(body, "\\{\"name\":\"y[0-9]+\\.json\",\"ok\":true").Count, cutFat = Regex.Matches(body, "\\{\"name\":\"y[0-9]+\\.json\",\"ok\":false,\"why\":\"not served: the answer would pass 2 MB").Count;
            Check(s == 200 && servedFat >= 7 && servedFat <= 8 && servedFat + cutFat == 12 && body.Length < ChartBridgeRoster.MaxAnswerBytes + 64 * 1024 && ChartBridgeBot.JsonValid(body),
                  "/roster (D4): twelve files of 250 KB: " + servedFat + " served, " + cutFat + " listed as over the 2 MB answer, the answer " + body.Length + " bytes");
            foreach (string f in Directory.GetFiles(rf, "y*.json")) File.Delete(f);
            // the pick's own question: may this name be picked?
            Check(ChartBridgeRoster.PickProblem("alpha.json") == null && ChartBridgeRoster.PickProblem("morning.json") == null, "the pick: a served bot file and a served lineup file can be picked");
            Check(ChartBridgeRoster.PickProblem("broken.json") == "not valid JSON" && ChartBridgeRoster.PickProblem("nested.json").StartsWith("not a roster file") && ChartBridgeRoster.PickProblem("missing.json") == "there is no such file in the roster folder" &&
                  ChartBridgeRoster.PickProblem("../alpha.json") == "not a plain name" && ChartBridgeRoster.PickProblem("sub/deep.json") == "not a plain name" && ChartBridgeRoster.PickProblem("ALPHA.json") == "there is no such file in the roster folder" &&
                  ChartBridgeRoster.PickProblem(null) == "not a plain name", "the pick: a file that is not served, not there, in a subfolder or of another spelling cannot be picked");
            // D3: on Windows a full path on a drive letter and nothing else
            Check(ChartBridgeRoster.DrivePath("C:\\Apps\\BotLab\\roster") && ChartBridgeRoster.DrivePath("d:/x") && !ChartBridgeRoster.DrivePath("C:roster") && !ChartBridgeRoster.DrivePath("\\roster") &&
                  !ChartBridgeRoster.DrivePath("\\\\server\\share\\roster") && !ChartBridgeRoster.DrivePath("//server/share") && !ChartBridgeRoster.DrivePath("relative\\roster") && !ChartBridgeRoster.DrivePath("/tmp/x") &&
                  !ChartBridgeRoster.DrivePath("1:\\x") && !ChartBridgeRoster.DrivePath("") && !ChartBridgeRoster.DrivePath(null), "/roster (D3): a drive-letter full path only: no path without a drive, no network share");
            ChartBridgeRoster.FolderSetting = "relative\\roster";
            body = Get(port, "/roster", null, null, out s);
            Check(s == 500 && body.Contains("not a full path on a drive letter"), "/roster: a rosterFolder that is not a full path is refused (" + s + ")");
            Check(ChartBridgeRoster.PickProblem("alpha.json").Contains("not a full path on a drive letter"), "the pick: nothing can be picked from a folder that is refused");
            ChartBridgeRoster.FolderSetting = "";
            Check(ChartBridgeRoster.PickProblem("alpha.json").StartsWith("no roster folder is set"), "the pick: nothing can be picked with no roster folder set");
            ChartBridgeAgents.ReadConfig("rosterFolder", "  " + rf + "  ");
            Check(ChartBridgeRoster.FolderSetting == rf, "config.txt: rosterFolder is read (trimmed)");
            ChartBridgeRoster.FolderSetting = "";
            try { Directory.Delete(Path.Combine(home, "made-up-botlab"), true); } catch (Exception) { }
            ChartBridgeBot.LibraryName = "../config.json";
            Check(ChartBridgeBot.LibraryPath() == null, "botLibrary: no path out of ChartBridge's folder");
            ChartBridgeBot.LibraryName = "bot-library.json";
            body = Get(port, "/diag", null, null, out s);
            Check(s == 200 && body.Contains("\"bot\":{\"enabled\":true") && !body.Contains(secret), "/diag: the bot block, never the secret");
            ChartBridgeSwitches.Note("bot", "off");
            Get(port, "/bot", null, secret, out s);
            int s2; Get(port, "/bot-library", null, null, out s2);
            body = Get(port, "/diag", null, null, out s);
            Check(s2 == 404 && !body.Contains("\"bot\":"), "switch off: /bot-library 404, no bot block in /diag");
            int s3; Get(port, "/bot", null, secret, out s3);
            Check(s3 == 404, "switch off: /bot answers 404 even with the secret (" + s3 + ")");
            ChartBridgeSwitches.Note("bot", "on");
        }
        finally { try { l.Stop(); l.Close(); } catch (Exception) { } }
    }

    // ------------------------------------------------------------ the bot's account: chosen on the page; release 1 (1.6b): the personal account only, every gate applies
    static string AccountMsg(string name) { return "{\"type\":\"botAccount\",\"cid\":\"ba\",\"account\":\"" + name + "\"}"; }
    static string AccountFile() { return Path.Combine(home, "ChartBridge", "bot-account.txt"); }

    static void ChosenAccount()
    {
        Settle();
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
        // 0.5.7 (DECISION 2026-10-14e): no bot-account.txt is None
        Gone(AccountFile());
        ChartBridgeBot.Stop(); ChartBridgeBot.Start(false); Reconnect();
        Check(ChartBridgeBot.BotAccount == "-" && !File.Exists(AccountFile()) && ChartBridgeBot.StripJson().Contains("\"account\":null,\"sim\":false") && Last(botOut, "welcome").Contains("\"account\":null"),
              "0.5.7: the bot's account is None until Anthony chooses one (no bot-account.txt): the page and the bot see account null");
        Check(ChartBridgeBot.StripJson().Contains("\"standDown\":\"the bot's account is None: no bot entries until an account is chosen on the Bot tab\"") && ChartBridgeBot.StripJson().Contains("\"personal\":false"), "0.5.7: None: the strip says why nothing trades");
        Page(AccountMsg("OWN-1"));
        Check(ChartBridgeBot.BotAccount == "OWN-1" && File_("bot-account.txt").Contains("account\tOWN-1") && File_("bot.log").Contains("account OWN-1 (LIVE), was -, set by the page"), "the personal account OWN-1 chosen from None");
        int ns = own.Calls.Count, n2 = own2.Calls.Count;
        Page(AccountMsg("NOPE-1"));
        Check(PageReject().Contains("NOPE-1 is not in NinjaTrader"), "botAccount: an account NinjaTrader does not have is refused");
        Account play = NewAccount("Playback101", Provider.Playback);
        Page(AccountMsg("Playback101"));
        Check(PageReject().Contains("Backtest or Playback account"), "botAccount: Playback refused");
        Account.All.Remove(play);
        Page("{\"type\":\"botAccount\",\"cid\":\"ba\",\"account\":\"EVAL-A\",\"mode\":\"auto\"}");
        Check(PageReject().Contains("unknown key \\\"mode\\\""), "botAccount: strict keys");
        Page("{\"type\":\"botAccount\",\"cid\":\"ba\",\"account\":\" EVAL-A\"}");
        Check(PageReject().Contains("account must be an account name"), "botAccount: a name with spaces around it is refused");

        // release 1 (1.6b, Anthony 2026-11-18 "Personal only, Sim later"): a prop account, a Sim account and no pick are refused
        Page(AccountMsg("EVAL-A"));
        Check(PageReject().Contains("EVAL-A is not the personal account: the bot trades the personal account only") && ChartBridgeBot.BotAccount == "OWN-1" && File_("bot-account.txt").Contains("account\tOWN-1"),
              "1.6b: a prop account (not the personal one) is refused; nothing changed: " + PageReject());
        Page(AccountMsg("Sim101"));
        Check(PageReject().Contains("Sim101 is a Sim account: the bot trades the personal account only (Sim comes back once the WORK check shows Lucid's accounts do not read as Simulator)") && ChartBridgeBot.BotAccount == "OWN-1",
              "1.6b: a Sim account is refused for now: " + PageReject());
        Pick("Sim101");   // a personal-account.txt naming a Sim account (the page never saves one): still refused
        Page(AccountMsg("Sim101"));
        Check(PageReject().Contains("Sim101 is a Sim account") && ChartBridgeBot.BotAccount == "OWN-1", "1.6b: a Sim account is refused even when the file names it the personal account");
        Pick("OWN-1");
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Pick(null);   // the pick taken away on the Accounts tab while the bot is armed
        int m0 = own.Calls.Count;
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("no personal account is picked (the chart page's Accounts tab): the bot trades the personal account only") && own.Calls.Count == m0,
              "1.6b: no personal account picked: every entry refused, nothing sent: " + BotReject());
        Check(ChartBridgeBot.StripJson().Contains("\"standDown\":\"no personal account is picked") && ChartBridgeBot.StripJson().Contains("\"personal\":false"), "1.6b: the strip says no personal account is picked");
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
        foreach (string mode in new[] { "copilot", "auto" })
        {
            Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"" + mode + "\"}");
            Check(PageReject().Contains(mode + " refused: no personal account is picked"), "1.6b: no pick: " + mode + " refused");
        }
        Page(AccountMsg("OWN-2"));
        Check(PageReject().Contains("no personal account is picked") && ChartBridgeBot.BotAccount == "OWN-1", "1.6b: no pick: botAccount refused");
        // the pick moves to OWN-2: OWN-1 is no longer the personal account
        Pick("OWN-2");
        Check(ChartBridgeBot.StripJson().Contains("\"standDown\":\"OWN-1 is not the personal account: the bot trades the personal account only (choose it on the Bot tab)\""), "1.6b: the pick moved: the bot's account OWN-1 is not personal: it stands down");
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"copilot\"}");
        Check(PageReject().Contains("copilot refused: OWN-1 is not the personal account"), "1.6b: and it cannot be armed there");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "OWN-1");
        Page(AccountMsg("OWN-2"));
        Check(PageReject().Contains("OWN-2 may not trade from the chart") && ChartBridgeBot.BotAccount == "OWN-1" && File_("bot-account.txt").Contains("account\tOWN-1"), "botAccount: an account that is not tradable (gate 2) is refused; nothing changed");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "OWN-1, OWN-2, EVAL-A, Sim101");
        own2.Connection.Status = ConnectionStatus.ConnectionLost;
        Page(AccountMsg("OWN-2"));
        Check(PageReject().Contains("OWN-2 is not connected") && ChartBridgeBot.BotAccount == "OWN-1", "botAccount: an account that is not connected is refused");
        own2.Connection.Status = ConnectionStatus.Connected;
        ChartBridgeOrders.ReadConfig("trading", "false");
        Page(AccountMsg("OWN-2"));
        Check(PageReject().Contains("trading is off") && ChartBridgeBot.BotAccount == "OWN-1", "botAccount: trading = true stays the master switch");
        ChartBridgeOrders.ReadConfig("trading", "true");

        // accepted: the personal account OWN-2 (live: NinjaTrader does not call it a simulator)
        Page(AccountMsg("OWN-2"));
        string b = Last(page, "bot");
        Check(ChartBridgeBot.BotAccount == "OWN-2" && b.Contains("\"account\":\"OWN-2\",\"sim\":false") && b.Contains("\"personal\":true"), "botAccount OWN-2 (the personal account): accepted; the page is told: " + b);
        Check(File_("bot-account.txt").Contains("account\tOWN-2") && File_("bot-account.txt").StartsWith("#") && !File.Exists(AccountFile() + ".tmp"), "bot-account.txt: written through a temp file, the account named");
        Check(Last(botOut, "welcome").Contains("\"account\":\"OWN-2\",\"sim\":false"), "the bot is told its account (welcome again), sim false");
        Check(File_("bot.log").Contains("account OWN-2 (LIVE), was OWN-1, set by the page"), "bot.log: the change, marked LIVE");
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Check(Last(page, "bot").Contains("\"mode\":\"auto\""), "auto on the personal account: allowed");
        string id = NewId();
        Bot(Sig(id, Market("buy")));
        List<string> sent2 = Calls(own2, n2);
        Check(sent2.Count == 1 && Regex.IsMatch(sent2[0], "^submit CB#[0-9a-f]{8} bot s8 t16 Buy Market 1 ") && own.Calls.Count == ns && eval.Calls.Count == 0,
              "auto: placed on the chosen personal account OWN-2; nothing on OWN-1 or EVAL-A: " + string.Join(" | ", sent2));
        Order entry = Newest(own2);
        Update(entry);
        Check(Last(botOut, "order").Contains("\"account\":\"OWN-2\""), "the bot gets its own order on its account");
        Pick("OWN-1");
        Page(AccountMsg("OWN-1"));
        Check(PageReject().Contains("the bot has a position or a working entry: choose its account when it is flat") && ChartBridgeBot.BotAccount == "OWN-2", "botAccount: refused while the bot has a working entry");
        Pick("OWN-2");
        Bot("{\"type\":\"withdraw\",\"id\":\"" + id + "\",\"reason\":\"Sample: no longer valid\"}");
        Check(Calls(own2, n2).Count == 2 && Calls(own2, n2)[1].StartsWith("cancel CB#" + Tag(entry) + " bot"), "withdraw: the entry on OWN-2 is cancelled");
        entry.OrderState = OrderState.Cancelled; Update(entry);
        // a fill on the chosen account is the bot's trade (the rails count it), and its position blocks a change of account
        Bot(Sig(NewId(), Market("sell")));
        Order e2 = own2.Orders.LastOrDefault(o => o.Name != null && o.Name.Contains(" bot ") && ChartBridgeOrders.IsWorking(o.OrderState));
        Check(e2 != null, "auto on OWN-2: a second entry placed");
        if (e2 != null)
        {
            int trades = int.Parse(Regex.Match(Last(page, "bot"), "\"trades\":(\\d+)").Groups[1].Value);
            e2.OrderId = "NT" + Guid.NewGuid().ToString("N").Substring(0, 8);
            e2.Filled = 1; e2.AverageFillPrice = 25000; e2.OrderState = OrderState.Filled; Update(e2);
            Deliver("OWN-2", mnq, MarketPosition.Short, 1, 25000, e2.OrderId);
            Check(Last(page, "bot").Contains("\"trades\":" + (trades + 1)) && Last(page, "bot").Contains("\"position\":{\"qty\":-1"), "a fill on the chosen account counts as the bot's trade (the rails hold)");
            Pick("OWN-1");
            Page(AccountMsg("OWN-1"));
            Check(PageReject().Contains("choose its account when it is flat"), "botAccount: refused while the bot has a position");
            Pick("OWN-2");
            Deliver("OWN-2", mnq, MarketPosition.Long, 1, 24999, "EXIT" + Guid.NewGuid().ToString("N").Substring(0, 6));
            foreach (Order o in own2.Orders.ToList()) if (ChartBridgeOrders.IsWorking(o.OrderState)) { o.OrderState = OrderState.Cancelled; Update(o); }
            own2.Positions.Clear();
            ((System.Collections.IDictionary)typeof(ChartBridgeOrders).GetField("Moves", PS).GetValue(null)).Clear();   // every fill booked (as NinjaTrader's position updates do)
        }
        // Minors (3): any position or working order on the bot's root, not only the bot's own, on the account chosen or on the
        // bot's account now, refuses the change, with a plain reason; nothing changes. (The pick moves to OWN-1 to try it.)
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
        Pick("OWN-1");
        Position handPos = new Position { Instrument = mnq, MarketPosition = MarketPosition.Long, Quantity = 1, AveragePrice = 25000 };
        own.Positions.Add(handPos);
        Page(AccountMsg("OWN-1"));
        Check(PageReject().Contains("OWN-1 holds a position or a working order on MNQ: choose the bot's account when both accounts are flat on MNQ") && ChartBridgeBot.BotAccount == "OWN-2",
              "minors (3): botAccount refused while the account chosen holds a position on the bot's root (not the bot's): " + PageReject());
        own.Positions.Remove(handPos);
        Order handOrder = new Order { Account = own, Instrument = mnq, OrderAction = OrderAction.Buy, OrderType = OrderType.Limit, Quantity = 1, LimitPrice = 24900, Name = "by hand", OrderState = OrderState.Working };
        own.Orders.Add(handOrder);
        Page(AccountMsg("OWN-1"));
        Check(PageReject().Contains("OWN-1 holds a position or a working order on MNQ") && ChartBridgeBot.BotAccount == "OWN-2",
              "minors (3): botAccount refused while the account chosen has a working order on the bot's root: " + PageReject());
        handOrder.OrderState = OrderState.Cancelled;
        Position ownPos2 = new Position { Instrument = mnq, MarketPosition = MarketPosition.Short, Quantity = 2, AveragePrice = 25000 };
        own2.Positions.Add(ownPos2);
        Page(AccountMsg("OWN-1"));
        Check(PageReject().Contains("the bot's account OWN-2 holds a position or a working order on MNQ: choose the bot's account when both accounts are flat on MNQ") && ChartBridgeBot.BotAccount == "OWN-2",
              "minors (3): botAccount refused while the bot's account now holds a position on its root (not the bot's): " + PageReject());
        own2.Positions.Remove(ownPos2);
        Check(!File_("bot-account.txt").Contains("account\tOWN-1"), "minors (3): nothing saved while refused");
        // copilot: the proposal carries the account and the mark; a change of account expires it (never sent)
        Pick("OWN-2");
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"copilot\"}");
        string pid = NewId();
        Bot(Sig(pid, Market("buy")));
        Check(Last(page, "botProposal").Contains("\"account\":\"OWN-2\",\"sim\":false") && Last(page, "botProposal").Contains("\"state\":\"open\""), "copilot: the proposal names the account, sim false");
        int before = own2.Calls.Count;
        Pick("OWN-1");
        Page(AccountMsg("OWN-1"));
        Check(ChartBridgeBot.BotAccount == "OWN-1" && Last(page, "botProposal").Contains("\"id\":\"" + pid + "\"") && Last(page, "botProposal").Contains("\"state\":\"not answered\"") && own2.Calls.Count == before,
              "the pick moved back to OWN-1, chosen: the open proposal for OWN-2 expires as not answered, nothing sent");
        // a restart keeps the account
        ChartBridgeBot.Stop(); ChartBridgeBot.Start(false);
        Check(ChartBridgeBot.BotAccount == "OWN-1", "a restart keeps the bot's account (bot-account.txt)");
        File.WriteAllText(AccountFile(), "# torn\naccount\tOWN-1\tx\n");
        ChartBridgeBot.Stop(); ChartBridgeBot.Start(false);
        Check(ChartBridgeBot.StripJson().Contains("\"standDown\":\"bot-account.txt has a line ChartBridge does not understand") && File_("bot-account.txt") == "# torn\naccount\tOWN-1\tx\n",
              "a bot-account.txt that cannot be read: the bot stands down, the file is left as it is");
        Page(AccountMsg("OWN-1"));
        Check(ChartBridgeBot.BotAccount == "OWN-1" && ChartBridgeBot.StripJson().Contains("\"standDown\":null") && File_("bot-account.txt").Contains("account\tOWN-1"), "choosing the account again clears it and rewrites the file");
        // re-attach the bot for the rest of the harness
        bc = new ChartBridgeClient(null, ChartBridgeBot.BotClientId);
        bc.Tap = s2 => { lock (botOut) botOut.Add(s2); };
        ChartBridgeBot.Attach(bc);
        Bot("{\"type\":\"botHello\",\"name\":\"Demo Opening Fade\"}");
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
    }

    // ------------------------------------------------------------ 0.5.7: None, and the daily reset in the 17:00 to 18:00 ET break
    static void NoneAndReset()
    {
        Settle();
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Page("{\"type\":\"botAccount\",\"cid\":\"ba\",\"account\":null}");
        string f = File_("bot-account.txt");
        Check(ChartBridgeBot.BotAccount == "-" && f.Contains("account\t-") && Last(page, "bot").Contains("\"account\":null") && Last(botOut, "welcome").Contains("\"account\":null"),
              "0.5.7: botAccount null is None: saved as account<TAB>-, the page and the bot told (account null)");
        // a ChartBridge before 0.5.7 reads the file as an account named "-" (its rule: account<TAB>a plain name): no break
        Check(f.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0 && !l.StartsWith("#")).All(l => Regex.IsMatch(l, "^account\t[^\t\\\\\"]+$")), "0.5.7: every line an older reader reads is account<TAB>a plain name");
        int n0 = own.Calls.Count;
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("the bot's account is None") && own.Calls.Count == n0, "0.5.7: None in auto: nothing sent");
        ChartBridgeBot.Stop(); ChartBridgeBot.Start(false); Reconnect();
        Check(ChartBridgeBot.BotAccount == "-" && ChartBridgeBot.StripJson().Contains("\"standDown\":\"the bot's account is None"), "0.5.7: a restart keeps None (account<TAB>-)");
        Page("{\"type\":\"botAccount\",\"cid\":\"ba\",\"account\":\"-\"}");
        Check(PageReject().Contains("account must be an account name, or null for None"), "0.5.7: \"-\" is never an account name from the page");
        // review of #47: None waits for PlaceGate (never between a placement's checks and its order)
        Page(AccountMsg("OWN-1"));
        object gate = typeof(ChartBridgeBot).GetField("PlaceGate", PS).GetValue(null);
        bool doneNone = false;
        System.Threading.Thread tn;
        lock (gate)
        {
            tn = new System.Threading.Thread(() => { ChartBridgeServer_OnClientMessage(pc, "{\"type\":\"botAccount\",\"cid\":\"bg\",\"account\":null}"); doneNone = true; });
            tn.Start();
            System.Threading.Thread.Sleep(300);
            Check(!doneNone && ChartBridgeBot.BotAccount == "OWN-1", "0.5.7 (review of #47): None from the page waits while a placement holds PlaceGate");
        }
        tn.Join(5000);
        Check(doneNone && ChartBridgeBot.BotAccount == "-", "0.5.7 (review of #47): and goes once it is free");
        Page(AccountMsg("OWN-1"));
        // None while the bot has a working entry: refused (choose it when flat)
        Page(AccountMsg("OWN-1"));
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Bot(Sig(NewId(), "\"side\":\"buy\",\"kind\":\"limit\",\"price\":24990,\"stopTicks\":8,\"targetTicks\":16"));
        Order working = Newest(own);
        Page("{\"type\":\"botAccount\",\"cid\":\"ba\",\"account\":null}");
        Check(working != null && PageReject().Contains("the bot has a position or a working entry: choose None when it is flat") && ChartBridgeBot.BotAccount == "OWN-1", "0.5.7: None refused while the bot has a working entry");

        // the reset: once per day in the 17:00 to 18:00 ET break; open (here a working entry) is skipped with a note
        FieldInfo etf = typeof(ChartBridgeTime).GetField("et", PS);   // Linux names New York's zone differently from Windows
        if (etf.GetValue(null) == null) etf.SetValue(null, TimeZoneInfo.FindSystemTimeZoneById("America/New_York"));
        ChartBridgeBranches.Forget();
        try { Gone(Path.Combine(home, "ChartBridge", "daily-reset.txt")); } catch (Exception) { }
        Func<DateTime> was = ChartBridgeBranches.ClockUtc;
        DateTime utc = new DateTime(2026, 7, 14, 20, 59, 0, DateTimeKind.Utc);   // 16:59 EDT
        ChartBridgeBranches.ClockUtc = () => utc;
        try
        {
            int s0 = page.Count;
            SteadyAll(); ChartBridgeBranches.Check();
            Check(ChartBridgeBot.BotAccount == "OWN-1" && !File.Exists(Path.Combine(home, "ChartBridge", "daily-reset.txt")), "0.5.7 reset: 16:59 New York (EDT): not yet");
            utc = new DateTime(2026, 7, 14, 21, 0, 0, DateTimeKind.Utc);   // 17:00 EDT
            SteadyAll(); ChartBridgeBranches.Check();
            Check(ChartBridgeBot.BotAccount == "OWN-1" && page.Skip(s0).Any(x => x.Contains("\"level\":\"warn\"") && x.Contains("Daily reset (17:00 ET): the bot stays on OWN-1: it has a position or a working order there")),
                  "0.5.7 reset: 17:00 EDT: the bot with a working entry is skipped, the pages get a note naming it");
            Check(File_("daily-reset.txt").Contains("day\t2026-07-14"), "0.5.7 reset: the day it ran is saved (daily-reset.txt)");
            int s1 = page.Count;
            ChartBridgeClient late = new ChartBridgeClient(null, 503) { Origin = "http://localhost:8765" };
            List<string> lateOut = new List<string>();
            late.Tap = x => { lock (lateOut) lateOut.Add(x); };
            ChartBridgeBranches.SignedIn(late);
            Check(lateOut.Any(x => x.Contains("the bot stays on OWN-1")), "0.5.7 reset: a page that signs in during that break gets the note too");
            working.OrderState = OrderState.Cancelled; Update(working);
            Settle();
            utc = new DateTime(2026, 7, 14, 21, 30, 0, DateTimeKind.Utc);   // 17:30 EDT, now flat: once per day, not again
            SteadyAll(); ChartBridgeBranches.Check();
            Check(ChartBridgeBot.BotAccount == "OWN-1" && page.Skip(s1).Count(x => x.Contains("Daily reset")) == 0, "0.5.7 reset: once per day: not again in the same break");
            // a restart in the break: the saved day holds
            ChartBridgeBranches.Forget();
            SteadyAll(); ChartBridgeBranches.Check();
            Check(ChartBridgeBot.BotAccount == "OWN-1", "0.5.7 reset: a restart in the same break does not run it again (daily-reset.txt)");
            // the next day, flat: None. Winter (EST): 21:30 UTC is 16:30 New York, not the break; 22:00 UTC is 17:00
            File.WriteAllText(Path.Combine(home, "ChartBridge", "daily-reset.txt"), "day\t2026-12-14\n");   // 0.6.3: the 14th's break was seen (else this is a missed break, caught up)
            ChartBridgeBranches.Forget();
            utc = new DateTime(2026, 12, 15, 21, 30, 0, DateTimeKind.Utc);
            SteadyAll(); ChartBridgeBranches.Check();
            Check(ChartBridgeBot.BotAccount == "OWN-1", "0.5.7 reset: 21:30 UTC in December is 16:30 EST: not the break (daylight saving)");
            int s2 = page.Count;
            utc = new DateTime(2026, 12, 15, 22, 0, 0, DateTimeKind.Utc);
            SteadyAll(); ChartBridgeBranches.Check();
            Check(ChartBridgeBot.BotAccount == "-" && File_("bot-account.txt").Contains("account\t-") && page.Skip(s2).Any(x => x.Contains("Daily reset (17:00 ET): the bot is on None now")) &&
                  File_("bot.log").Contains("account None (nothing trades), was OWN-1, by the daily reset (17:00 ET)"),
                  "0.5.7 reset: 17:00 EST, the bot flat with no working order: None, saved, the pages told");
            // 0.6.3: a bot on None is "account - (None)" in the Output window, never LIVE; its welcome says None (account null, sim false)
            ChartBridgeBot.Stop(); ChartBridgeBot.Start(false); Reconnect();
            Check(NinjaTrader.Code.Output.Lines.Any(x => x.Contains("/bot (account - (None), ")) && !NinjaTrader.Code.Output.Lines.Any(x => x.Contains("/bot (account - (LIVE)")) &&
                  Last(botOut, "welcome").Contains("\"account\":null,\"sim\":false"), "0.6.3: the bot on None starts as \"account - (None)\", not LIVE; its welcome names no account");
            Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
            utc = new DateTime(2026, 12, 15, 23, 0, 0, DateTimeKind.Utc);   // 18:00 EST: the break is over
            ChartBridgeBranches.Forget();
            try { Gone(Path.Combine(home, "ChartBridge", "daily-reset.txt")); } catch (Exception) { }
            Page(AccountMsg("OWN-1"));
            SteadyAll(); ChartBridgeBranches.Check();
            Check(ChartBridgeBot.BotAccount == "OWN-1", "0.5.7 reset: never outside the break (18:00 EST)");

            // 0.6.3 (audit C1): a break missed while ChartBridge was off is caught up on the next Check (and at start)
            string rf = Path.Combine(home, "ChartBridge", "daily-reset.txt");
            File.WriteAllText(rf, "day\t2026-12-14\n");
            ChartBridgeBranches.Forget();
            utc = new DateTime(2026, 12, 15, 21, 30, 0, DateTimeKind.Utc);   // 16:30 EST: the 17:00 of the 14th is the latest; done
            SteadyAll(); ChartBridgeBranches.Check();
            Check(ChartBridgeBot.BotAccount == "OWN-1" && File_("daily-reset.txt").Contains("day\t2026-12-14"), "0.6.3 C1: 16:30, the last reset is the latest 17:00 (the day before): nothing");
            int s3 = page.Count;
            utc = new DateTime(2026, 12, 16, 0, 0, 0, DateTimeKind.Utc);    // 19:00 EST on the 15th: the PC was off from 16:30, the break was missed
            SteadyAll(); ChartBridgeBranches.Check();
            Check(ChartBridgeBot.BotAccount == "-" && File_("daily-reset.txt").Contains("day\t2026-12-15") &&
                  page.Skip(s3).Any(x => x.Contains("Daily reset (17:00 ET, caught up now: ChartBridge was not running at 17:00 ET on 2026-12-15): the bot is on None now")),
                  "0.6.3 C1: the clock jumps from 16:30 to 19:00: the missed reset runs now, the bot is on None, the pages are told it was caught up");
            Page(AccountMsg("OWN-1"));
            ChartBridgeBranches.Forget();
            SteadyAll(); ChartBridgeBranches.Check();
            Check(ChartBridgeBot.BotAccount == "OWN-1", "0.6.3 C1: caught up once: a restart the same evening does not run it again, the account chosen after it stays");
            // a weekend: off from Friday 16:30 to Monday 09:00 (the latest 17:00 is Sunday's); the skip rule holds (a working entry)
            File.WriteAllText(rf, "day\t2026-12-17\n");
            ChartBridgeBranches.Forget();
            Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
            Bot(Sig(NewId(), "\"side\":\"buy\",\"kind\":\"limit\",\"price\":24990,\"stopTicks\":8,\"targetTicks\":16"));
            Order busy = Newest(own);
            int s4 = page.Count;
            utc = new DateTime(2026, 12, 21, 14, 0, 0, DateTimeKind.Utc);   // Monday 09:00 EST
            SteadyAll(); ChartBridgeBranches.Check();
            Check(busy != null && ChartBridgeBot.BotAccount == "OWN-1" && File_("daily-reset.txt").Contains("day\t2026-12-20") &&
                  page.Skip(s4).Any(x => x.Contains("\"level\":\"warn\"") && x.Contains("caught up now: ChartBridge was not running at 17:00 ET on 2026-12-20): the bot stays on OWN-1: it has a position or a working order there")),
                  "0.6.3 C1: a weekend off: caught up Monday morning, the bot with a working entry is skipped with the same note");
            List<string> lateOut2 = new List<string>();
            ChartBridgeClient late2 = new ChartBridgeClient(null, 504) { Origin = "http://localhost:8765" };
            late2.Tap = x => { lock (lateOut2) lateOut2.Add(x); };
            ChartBridgeBranches.SignedIn(late2);
            Check(lateOut2.Any(x => x.Contains("the bot stays on OWN-1")), "0.6.3 C1: a page that signs in after a caught-up reset gets the skipped note too");
            busy.OrderState = OrderState.Cancelled; Update(busy);
            Settle();
            // 0.6.3 (review round 2, LOW C and MED A): the bot's reset pending (OWN-1 not Connected): no new entries; a page choice ends it
            {
                File.WriteAllText(rf, "day\t2026-12-17\n");
                ChartBridgeBranches.Forget();
                own.Connection.Status = ConnectionStatus.ConnectionLost;
                ChartBridgeBranches.Check();
                own.Connection.Status = ConnectionStatus.Connected;
                Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");   // a bot message to the page
                Check(ChartBridgeBot.BotAccount == "OWN-1" && File_("daily-reset.txt").Contains("pending\tbot") && Last(page, "bot").Contains("waiting for the daily reset: OWN-1 was the bot's account"),
                      "0.6.3 LOW C: the bot's reset pending: it keeps OWN-1 and its status says it waits for the daily reset");
                Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
                int m0 = own.Calls.Count;
                Bot(Sig(NewId(), Market("buy")));
                Check(BotReject().Contains("waiting for the daily reset") && own.Calls.Count == m0, "0.6.3 LOW C: a bot signal is refused while it waits, nothing placed");
                Page(AccountMsg("OWN-1"));
                Check(!File_("daily-reset.txt").Contains("pending\tbot") && Last(page, "bot").Contains("\"standDown\":null"), "0.6.3 MED A: the bot's account chosen on the page: the pending reset is dropped: " + File_("daily-reset.txt").Replace("\n", " | ") + " || " + Last(page, "bot"));
                SteadyAll(); ChartBridgeBranches.Check();
                Check(ChartBridgeBot.BotAccount == "OWN-1", "0.6.3 MED A: and never undone by the next check");
                Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
            }
            // 0.6.3 (review MED 5): daily-reset.txt missing after a cut-off replace: its .bak gives the day (no reset run again)
            File.WriteAllText(rf + ".bak", "day\t2026-12-20\n"); File.Delete(rf);
            ChartBridgeBranches.Forget();
            SteadyAll(); ChartBridgeBranches.Check();
            Check(ChartBridgeBot.BotAccount == "OWN-1" && NinjaTrader.Code.Output.Lines.Any(x => x.Contains("daily-reset.txt is missing: daily-reset.txt.bak is used (2026-12-20)")), "0.6.3 MED 5: daily-reset.txt missing: its .bak gives the day, the reset is not run again");
            Gone(rf + ".bak");
            File.WriteAllText(rf, "day\t2027-01-05\n");   // a day ahead of now (the clock moved back): not due
            ChartBridgeBranches.Forget();
            SteadyAll(); ChartBridgeBranches.Check();
            Check(ChartBridgeBot.BotAccount == "OWN-1", "0.6.3 C1: a saved day ahead of now (the clock moved back) is not a missed break");
            try { Gone(rf); } catch (Exception) { }
            ChartBridgeBranches.Forget();
            SteadyAll(); ChartBridgeBranches.Check();
            Check(ChartBridgeBot.BotAccount == "OWN-1", "0.6.3 C1: no daily-reset.txt is not a missed break: it waits for the next break, as before");
        }
        finally { ChartBridgeBranches.ClockUtc = was; ChartBridgeBranches.Forget(); }
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
    }

    static string Get(int port, string path, string origin, string secret, out int status) { return Get(port, path, origin, secret, out status, null); }

    // the status of a request with another method (0.6.21: /roster takes GET and HEAD only)
    static int Send(int port, string method, string path)
    {
        HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + path);
        req.Proxy = null; req.Host = "localhost:" + port; req.Method = method; req.Timeout = 5000;
        if (method == "POST" || method == "PUT") req.ContentLength = 0;
        try { using (HttpWebResponse res = (HttpWebResponse)req.GetResponse()) return (int)res.StatusCode; }
        catch (WebException ex) { HttpWebResponse res = ex.Response as HttpWebResponse; return res != null ? (int)res.StatusCode : -1; }
    }

    static string Get(int port, string path, string origin, string secret, out int status, string host)
    {
        HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + path);
        req.Proxy = null;
        req.Host = host ?? "localhost:" + port;
        if (origin != null) req.Headers["Origin"] = origin;
        if (secret != null) req.Headers[ChartBridgeBot.SecretHeader] = secret;
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

    // ------------------------------------------------------------ the switch turned off again: 0.3.8 behaviour, nothing from the bot
    static void OffAgain()
    {
        int n = own.Calls.Count, ne = eval.Calls.Count;
        ChartBridgeBot.Stop();
        ChartBridgeSwitches.Note("bot", "off");   // the off line
        ChartBridgeBot.Start(false);
        Check(ChartBridgeBot.UpgradeCheck(null, "x", true) == 404 && !ChartBridgeBot.Attach(new ChartBridgeClient(null, -3)), "off again: /bot 404, no bot can attach");
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Check(PageReject().Contains("The bot channel is off"), "off again: page messages refused");
        ChartBridgeBot.OnBotMessage(bc, Sig(NewId(), Market("buy")));
        Check(own.Calls.Count == n && eval.Calls.Count == ne, "off again: nothing reaches NinjaTrader");
    }
}
