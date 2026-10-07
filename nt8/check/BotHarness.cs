// ChartBridge 0.4.0 on Mono (inside check:orders): the bot channel (nt8/ChartBridgeBot.cs, PROTOCOL.md "Bot channel"). A MADE-UP
// bot only ("Demo Opening Fade"): its signals are written here by hand, nothing here is a real bot's rule or market data.
// Every refusal must never reach the stand-in accounts: a non-Sim101 order in every mode, shadow sends nothing, an unanswered
// proposal is never sent, an accepted one is placed from its own parameters through the gates, the rails (1 contract, 5 trades,
// 3 losing trades, the kill switch, one trade at a time), the heartbeat (unfilled entries cancelled, stops and targets kept, never
// a flatten), the secret (wrong or missing: refused; never printed), and the switch off (404, every message refused).
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
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
    static Account sim, eval;
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
    // The position closes (a leg, or anything else): an execution the other way, then nothing left working or held.
    static void Exit(Order entry, double price)
    {
        Deliver(entry.Account.Name, entry.Instrument, entry.OrderAction == OrderAction.Buy ? MarketPosition.Short : MarketPosition.Long, entry.Quantity, price, "EXIT" + Guid.NewGuid().ToString("N").Substring(0, 6));
        Settle();
    }
    // Every order done and the fills booked, so the next trade starts flat (the stand-in has no broker to do it).
    static void Settle()
    {
        foreach (Order o in sim.Orders.ToList()) if (ChartBridgeOrders.IsWorking(o.OrderState)) { o.OrderState = OrderState.Cancelled; Update(o); }
        sim.Positions.Clear();
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
            Losses();
            FiveTrades();
            KillSwitch();
            Heartbeat();
            BotFlatten();
            Rails();
            V2PageGetsNothing();
            Http();
            OffAgain();
        }
        finally
        {
            ChartBridgeBot.Stop();
            ChartBridgeBot.ResetConfig();
            ChartBridgeBot.ClockMs = null; ChartBridgeBot.ClockEt = null;
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
        NinjaTrader.Core.Globals.UserDataDir = home;
        ChartBridgeConfig.Port = 8765;
        ChartBridgeBot.ClockMs = () => clock;
        ChartBridgeBot.ClockEt = () => et;
        mnq = new Instrument { FullName = "MNQ 12-26", MasterInstrument = new MasterInstrument { Name = "MNQ", TickSize = 0.25, PointValue = 2 } };
        nq = new Instrument { FullName = "NQ 12-26", MasterInstrument = new MasterInstrument { Name = "NQ", TickSize = 0.25, PointValue = 20 } };
        Named().Clear(); Named()["MNQ"] = mnq; Named()["NQ"] = nq;
        Account.All.Clear();
        sim = NewAccount("Sim101", Provider.Simulator);
        eval = NewAccount("EVAL-A", Provider.Rithmic);   // a made-up evaluation account: never the bot's
        ChartBridgeOrders.ResetConfig();
        ChartBridgeOrders.ReadConfig("trading", "true");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, EVAL-A");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "3");   // the bot's 1 contract holds even with a larger cap
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

    // ------------------------------------------------------------ the switch off (the default): /bot is 404, everything refused
    static void SwitchOff()
    {
        File.WriteAllLines(Path.Combine(home, "ChartBridge", "config.txt"), new[] { "trading = true" });
        ChartBridgeConfig.Load();
        Check(!ChartBridgeBot.Enabled, "bot is off by default (no bot line in config.txt)");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, EVAL-A"); ChartBridgeOrders.ReadConfig("maxQty.MNQ", "3");
        ChartBridgeBot.Start(false);
        Check(!File.Exists(Path.Combine(home, "ChartBridge", "bot-secret.txt")), "off: no bot-secret.txt is made");
        Check(ChartBridgeBot.UpgradeCheck(null, "anything", true) == 404, "off: an upgrade to /bot answers 404");
        int n = sim.Calls.Count;
        foreach (string m in new[] { "{\"type\":\"botMode\",\"cid\":\"m1\",\"mode\":\"auto\"}", "{\"type\":\"botKill\",\"cid\":\"k1\",\"on\":false}",
                                     "{\"type\":\"botAnswer\",\"cid\":\"a1\",\"id\":\"x\",\"answer\":\"accept\",\"at\":1}", "{\"type\":\"botRails\",\"cid\":\"r1\",\"maxTrades\":5,\"maxLosses\":3,\"root\":\"MNQ\"}",
                                     "{\"type\":\"botSeen\",\"id\":\"x\",\"at\":1}" })
        {
            Page(m);
            Check(PageReject().Contains("The bot channel is off (bot in config.txt)"), "off: " + m.Substring(9, 12) + "... refused");
        }
        Check(sim.Calls.Count == n && eval.Calls.Count == 0 && Count(page, "bot") == 0, "off: nothing sent to NinjaTrader, no bot message to the page");
        foreach (string[] kv in new[] { new[] { "bot = yes", "False" }, new[] { "bot = On", "True" }, new[] { "bot = 1", "True" }, new[] { "bot = off", "False" } })
        {
            File.WriteAllLines(Path.Combine(home, "ChartBridge", "config.txt"), new[] { kv[0], "botRoot = mnq" });
            ChartBridgeConfig.Load();
            Check(ChartBridgeBot.Enabled.ToString() == kv[1] && ChartBridgeBot.ConfigRoot == "MNQ", "config.txt: " + kv[0] + " is " + kv[1] + "; botRoot upper-cased");
        }
        Check(Logged("config.txt: bot = yes is not on, true or 1, so bot is OFF"), "config.txt: a value that is not on, true or 1 is off, with one Output line");
        ChartBridgeOrders.ReadConfig("trading", "true"); ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, EVAL-A"); ChartBridgeOrders.ReadConfig("maxQty.MNQ", "3");
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
        File.Delete(Path.Combine(home, "ChartBridge", "bot-secret.txt"));
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
        Check(w.Contains("\"mode\":\"shadow\"") && w.Contains("\"account\":\"Sim101\"") && w.Contains("\"root\":\"MNQ\"") && w.Contains("\"rails\":{\"maxQty\":1,\"maxTrades\":5,\"maxLosses\":3}") && w.Contains("\"name\":\"MNQ 12-26\""),
              "botHello: welcome (shadow, Sim101, MNQ, the rails): " + w);
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
        int n = sim.Calls.Count;
        string id = NewId();
        Bot(Sig(id, "\"side\":\"sell\",\"kind\":\"limit\",\"price\":25001,\"stopTicks\":12,\"targetTicks\":24"));
        string s = Last(page, "botSignal");
        Check(s.Contains("\"id\":\"" + id + "\"") && s.Contains("\"result\":\"shadow\"") && s.Contains("\"price\":25001") && s.Contains("\"stopTicks\":12"), "shadow: the signal shown with result shadow: " + s);
        Check(sim.Calls.Count == n && eval.Calls.Count == 0, "shadow: NOTHING sent to NinjaTrader");
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
        Check(sim.Calls.Count == n && eval.Calls.Count == 0, "none of these reached NinjaTrader");
    }

    // ------------------------------------------------------------ a bot can never name an account: refused in every mode
    static void NeverAnotherAccount()
    {
        int n = sim.Calls.Count;
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
        Check(sim.Calls.Count == n && eval.Calls.Count == 0, "no order reached any account");
        // auto locked to Sim101 as NinjaTrader's simulator: a Sim101 that is not one is refused, in auto and on accept
        sim.Provider = Provider.Rithmic;
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Check(PageReject().Contains("auto refused: Sim101 is not NinjaTrader's simulator"), "auto: refused when Sim101 is not NinjaTrader's simulator");
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"copilot\"}");
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("Sim101 is not NinjaTrader's simulator") && Last(page, "botSignal").Contains("refused: Sim101 is not"), "copilot: no proposal when Sim101 is not the simulator");
        sim.Provider = Provider.Simulator;
        ChartBridgeOrders.ReadConfig("tradeAccounts", "EVAL-A");
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Check(PageReject().Contains("auto refused: Sim101 may not trade from the chart"), "auto: refused when Sim101 is not tradable (gate 2)");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, EVAL-A");
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
        Check(sim.Calls.Count == n && eval.Calls.Count == 0, "still nothing sent");
    }

    // ------------------------------------------------------------ copilot: a proposal; only Anthony's accept places it
    static void Copilot()
    {
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"copilot\"}");
        int n = sim.Calls.Count;
        string a = NewId();
        Bot(Sig(a, "\"side\":\"sell\",\"kind\":\"limit\",\"price\":25001,\"stopTicks\":12,\"targetTicks\":24"));
        string p = Last(page, "botProposal");
        Check(p.Contains("\"id\":\"" + a + "\"") && p.Contains("\"state\":\"open\"") && p.Contains("\"account\":\"Sim101\"") && p.Contains("\"qty\":1") && p.Contains("\"reason\":\"Sample: price stalled") &&
              p.Contains("\"seenAt\":null") && Last(page, "botSignal").Contains("\"result\":\"proposed\""), "copilot: a proposal with its reason to the signed-in page: " + p);
        Page("{\"type\":\"botSeen\",\"id\":\"" + a + "\",\"at\":1791380820450}");
        Check(Last(page, "botProposal").Contains("\"seenAt\":1791380820450"), "botSeen: the moment it showed is recorded");
        Page("{\"type\":\"botSeen\",\"id\":\"" + a + "\",\"at\":1791380829999}");
        Check(!Last(page, "botProposal").Contains("1791380829999"), "botSeen: only the first moment counts");
        for (int i = 0; i < 15; i++) { clock += 4000; Bot("{\"type\":\"beat\"}"); ChartBridgeBot.Check(); }   // a minute unanswered (the bot beating): still never sent
        Check(sim.Calls.Count == n, "an unanswered proposal is never sent, however long it waits");
        Bot("{\"type\":\"withdraw\",\"id\":\"" + a + "\",\"reason\":\"Sample: price left the level\"}");
        Check(Last(page, "botProposal").Contains("\"state\":\"not answered\"") && Last(botOut, "answer").Contains("\"answer\":\"not answered\""), "withdraw: the proposal expires as not answered");
        Check(File_("bot.log").Contains("proposal " + a + " not answered"), "logged \"not answered\"");
        Page("{\"type\":\"botAnswer\",\"cid\":\"c1\",\"id\":\"" + a + "\",\"answer\":\"accept\",\"at\":1791380830000}");
        Check(PageReject().Contains("is not answered; it can no longer be answered") && sim.Calls.Count == n, "accepting an expired proposal: refused, nothing sent");

        string b = NewId();
        Bot(Sig(b, "\"side\":\"sell\",\"kind\":\"limit\",\"price\":25001,\"stopTicks\":12,\"targetTicks\":24"));
        Page("{\"type\":\"botAnswer\",\"cid\":\"c2\",\"id\":\"" + b + "\",\"answer\":\"accept\",\"at\":1791380831000,\"price\":24000}");
        Check(PageReject().Contains("unknown key \\\"price\\\"") && sim.Calls.Count == n, "the page cannot change the order: an answer with a price is refused");
        Page("{\"type\":\"botAnswer\",\"cid\":\"c3\",\"id\":\"" + b + "\",\"answer\":\"accept\",\"at\":1791380831500}");
        List<string> sent = Calls(sim, n);
        Check(sent.Count == 1 && Regex.IsMatch(sent[0], "^submit CB#[0-9a-f]{8} bot s12 t24 Sell Limit 1 L25001 S0"), "accept: placed from the proposal's own parameters, 1 contract, on Sim101: " + string.Join(" | ", sent));
        Check(eval.Calls.Count == 0, "accept: nothing on any other account");
        string pb = Last(page, "botProposal");
        Check(pb.Contains("\"state\":\"accepted\"") && pb.Contains("\"answeredAt\":1791380831500") && Last(botOut, "answer").Contains("\"answer\":\"accepted\""), "accept: recorded with the moment he answered; the bot is told");
        Update(Newest(sim));
        Check(Last(botOut, "order").Contains("\"side\":\"sell\"") && Last(botOut, "order").Contains("\"kind\":\"limit\"") && Last(botOut, "order").Contains("\"role\":\"entry\""), "the bot gets its own order's updates: " + Last(botOut, "order"));
        Page("{\"type\":\"botAnswer\",\"cid\":\"c4\",\"id\":\"" + b + "\",\"answer\":\"reject\",\"at\":1791380832000}");
        Check(PageReject().Contains("is accepted"), "a second answer: refused");
        Settle();

        string c = NewId();
        Bot(Sig(c, Market("buy")));
        Page("{\"type\":\"botAnswer\",\"cid\":\"c5\",\"id\":\"" + c + "\",\"answer\":\"reject\",\"at\":1791380833000}");
        Check(Last(page, "botProposal").Contains("\"state\":\"rejected\"") && Last(botOut, "answer").Contains("\"answer\":\"rejected\"") && Calls(sim, n).Count == 1, "reject: recorded, nothing sent");
        string d = NewId();
        Bot(Sig(d, Market("buy")));
        int m = sim.Calls.Count;
        AfterAuthSeesOpenProposal(d);
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
        Check(Last(page, "botProposal").Contains("\"id\":\"" + d + "\"") && Last(page, "botProposal").Contains("\"state\":\"not answered\"") && sim.Calls.Count == m, "leaving copilot: an open proposal expires as not answered, never sent");
    }

    // ------------------------------------------------------------ review 2 finding 7: a withdraw that arrives while an accept is being placed
    static void WithdrawDuringPlacement()
    {
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"copilot\"}");
        int n = sim.Calls.Count;
        string id = NewId();
        Bot(Sig(id, "\"side\":\"sell\",\"kind\":\"limit\",\"price\":25001,\"stopTicks\":12,\"targetTicks\":24"));
        // the bot's withdraw reaches ChartBridge while NinjaTrader takes the accepted entry (inside Submit)
        sim.OnCall = (kind, o) => { if (kind == "submit" && (o.Name ?? "").Contains(" bot ")) { sim.OnCall = null; Bot("{\"type\":\"withdraw\",\"id\":\"" + id + "\",\"reason\":\"Sample: price left the level\"}"); } };
        try { Page("{\"type\":\"botAnswer\",\"cid\":\"w1\",\"id\":\"" + id + "\",\"answer\":\"accept\",\"at\":1791380834000}"); }
        finally { sim.OnCall = null; }
        List<string> c = Calls(sim, n);
        Check(c.Count == 2 && Regex.IsMatch(c[0], "^submit CB#[0-9a-f]{8} bot s12 t24 Sell Limit 1 ") && c[1].StartsWith("cancel CB#" + Tag(Newest(sim)) + " bot"),
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

    // ------------------------------------------------------------ auto: Sim101 only, through the gates, one trade at a time
    static void Auto()
    {
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Check(Last(page, "bot").Contains("\"mode\":\"auto\"") && Last(botOut, "botState").Contains("\"mode\":\"auto\""), "auto: set from the page, the bot is told");
        int n = sim.Calls.Count;
        string a = NewId();
        Bot(Sig(a, Market("buy")));
        List<string> sent = Calls(sim, n);
        Check(sent.Count == 1 && Regex.IsMatch(sent[0], "^submit CB#[0-9a-f]{8} bot s8 t16 Buy Market 1 "), "auto: the signal placed by ChartBridge, 1 MNQ on Sim101, named bot: " + string.Join(" | ", sent));
        Check(Last(page, "botSignal").Contains("\"result\":\"placed\"") && eval.Calls.Count == 0, "auto: shown as placed; nothing on another account");
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("already has a working entry") && Calls(sim, n).Count == 1, "one trade at a time: a second entry while one works is refused");
        Bot("{\"type\":\"withdraw\",\"id\":\"" + a + "\",\"reason\":\"Sample: no longer valid\"}");
        Check(Calls(sim, n).Count == 2 && Calls(sim, n)[1].StartsWith("cancel CB#" + Tag(Newest(sim)) + " bot"), "withdraw in auto: the unfilled entry is cancelled");
        Settle();
        Bot(Sig(NewId(), "\"side\":\"buy\",\"kind\":\"limit\",\"price\":25010,\"stopTicks\":8,\"targetTicks\":16"));
        Check(BotReject().Contains("would fill at once") && Last(page, "botSignal").Contains("refused: a buy limit above the last price"), "auto: v2 gate 5 still applies (a buy limit through the market is refused)");
        Bot(Sig(NewId(), "\"side\":\"buy\",\"kind\":\"limit\",\"price\":24999.1,\"stopTicks\":8,\"targetTicks\":16"));
        Check(BotReject().Contains("tick grid"), "auto: off the tick grid: refused");
        ChartBridgeOrders.ReadConfig("trading", "false");
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("trading is off"), "auto: trading off in config.txt (the master switch): refused");
        ChartBridgeOrders.ReadConfig("trading", "true");
        Check(Calls(sim, n).Count == 2 && eval.Calls.Count == 0, "none of these reached NinjaTrader");
    }

    // ------------------------------------------------------------ 1 contract, whatever maxQty says
    static void Size()
    {
        int n = sim.Calls.Count;
        sim.Positions.Add(new Position { Instrument = mnq, MarketPosition = MarketPosition.Long, Quantity = 1, AveragePrice = 25000 });   // a manual Sim101 position
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("the cap is 1") && sim.Calls.Count == n, "1 contract: with Sim101 already long 1, a bot buy is refused (maxQty.MNQ is 3)");
        Bot(Sig(NewId(), Market("sell")));
        Check(BotReject().Contains("reduces the position") && sim.Calls.Count == n, "a bot entry never reduces a position (every entry has a stop)");
        sim.Positions.Clear();
    }

    static Order AutoTrade(string side)
    {
        int n = sim.Calls.Count;
        Bot(Sig(NewId(), Market(side)));
        if (sim.Calls.Count == n) return null;
        return sim.Orders.Last(o => o.Name != null && o.Name.Contains(" bot "));
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
        int n = sim.Calls.Count;
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("3 losing trades today") && sim.Calls.Count == n, "after 3 losses: no new entry");
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
        int n = sim.Calls.Count;
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("The bot has made 5 trades today (the limit).") && sim.Calls.Count == n, "the 6th trade of the day: refused");
        // a restart (recompile) forgets nothing: bot-day.txt; the mode starts in shadow and the bot must say hello again
        ChartBridgeBot.Stop();
        ChartBridgeBot.Start(false);
        Check(ChartBridgeBot.StripJson().Contains("\"trades\":5") && ChartBridgeBot.StripJson().Contains("\"mode\":\"shadow\"") && ChartBridgeBot.StripJson().Contains("\"connected\":false"), "after a restart: still 5 trades today, back in shadow, no bot");
        Reconnect();
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("5 trades today") && sim.Calls.Count == n, "after a restart: the 6th trade is still refused");
        et = et.AddDays(1);
        ChartBridgeBot.Check();
    }

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
        int n = sim.Calls.Count;
        Bot(Sig(NewId(), "\"side\":\"buy\",\"kind\":\"limit\",\"price\":24990,\"stopTicks\":8,\"targetTicks\":16"));
        Order e = Newest(sim);
        Check(Calls(sim, n).Count == 1 && e.Name.Contains(" bot "), "an unfilled bot entry works");
        Page("{\"type\":\"botKill\",\"cid\":\"k\",\"on\":true}");
        List<string> after = Calls(sim, n + 1);
        Check(after.Count == 1 && after[0] == "cancel " + e.Name, "kill switch on: the unfilled entry is cancelled, nothing else: " + string.Join(" | ", after));
        Check(!after.Any(x => x.StartsWith("flatten")) && Last(page, "status").Contains("the kill switch is on") && Last(page, "bot").Contains("\"killed\":true"), "kill switch: never a flatten; the page is told");
        Settle();
        int m = sim.Calls.Count;
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("the kill switch is on") && sim.Calls.Count == m, "kill switch on: every bot order refused");
        Page("{\"type\":\"botKill\",\"cid\":\"k\",\"on\":\"yes\"}");
        Check(PageReject().Contains("on must be true or false"), "botKill: on must be a bool");
        Page("{\"type\":\"botKill\",\"cid\":\"k\",\"on\":false}");
        Order again = AutoTrade("buy");
        Check(again != null && Last(page, "bot").Contains("\"killed\":false"), "kill switch off: the bot may place again");
        Settle();
    }

    // ------------------------------------------------------------ heartbeat: 5 s of silence; entries cancelled, stops kept, no flatten
    static void Heartbeat()
    {
        // (1) an unfilled entry
        int n = sim.Calls.Count;
        Order e = AutoTrade("buy");
        Check(e != null, "heartbeat: an entry works");
        clock += 4900;
        ChartBridgeBot.Check();
        Check(Calls(sim, n + 1).Count == 0, "4.9 s of silence: nothing yet");
        Bot("{\"type\":\"beat\"}");
        clock += 4900;
        ChartBridgeBot.Check();
        Check(Calls(sim, n + 1).Count == 0, "a beat resets the 5 s");
        clock += 200;
        ChartBridgeBot.Check();
        List<string> after = Calls(sim, n + 1);
        Check(after.Count == 1 && after[0] == "cancel " + e.Name, "5 s of silence: the unfilled entry is cancelled: " + string.Join(" | ", after));
        Check(Last(page, "status").Contains("heartbeat lost") && Last(page, "bot").Contains("\"connected\":false") && ChartBridgeBot.DiagJson().Contains("\"heartbeatLost\":1"), "the page is told (status and strip), counted in /diag");
        Bot(Sig(NewId(), Market("buy")));
        Check(sim.Calls.Count == n + 2, "a lost bot's messages do nothing");
        Settle();

        // (2) a bot position with its stop and target
        Reconnect();
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Order f = AutoTrade("buy");
        FillEntry(f, 25000);
        string tag = Tag(f);
        List<string> legs = sim.Calls.Where(x => x.StartsWith("submit CB#" + tag + " stop") || x.StartsWith("submit CB#" + tag + " target")).ToList();
        Check(legs.Count == 2, "the bot's entry filled: its stop and target are placed per fill (v2): " + string.Join(" | ", legs));
        int m = sim.Calls.Count;
        clock += 5100;
        ChartBridgeBot.Check();
        clock += 5100;
        ChartBridgeBot.Check();   // and no bot for another 5 s
        Check(Calls(sim, m).Count == 0, "heartbeat lost with a position: nothing cancelled, nothing flattened; the stop and target stay: " + string.Join(" | ", Calls(sim, m)));
        Check(Last(page, "status").Contains("any bot position keeps its stop and target"), "the page is told the position keeps its stop and target");
        Exit(f, 25002);
        Reconnect();
    }

    // ------------------------------------------------------------ the bot's own flatten: auto only
    static void BotFlatten()
    {
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        int n = sim.Calls.Count;
        Bot("{\"type\":\"flatten\"}");
        Check(BotReject().Contains("no position") && sim.Calls.Count == n, "flatten with no bot position: refused");
        Order e = AutoTrade("buy");
        FillEntry(e, 25000);
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"shadow\"}");
        int m = sim.Calls.Count;
        Bot("{\"type\":\"flatten\"}");
        Check(BotReject().Contains("auto mode only") && sim.Calls.Count == m, "flatten in shadow: refused");
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Bot("{\"type\":\"flatten\"}");
        Check(Calls(sim, m).Contains("flatten MNQ 12-26") && eval.Calls.Count == 0, "flatten in auto: Sim101's MNQ only");
        Exit(e, 25000);
    }

    // ------------------------------------------------------------ rails from the page (lead's default): tighten only, saved, refused while exposed
    static void Rails()
    {
        et = et.AddDays(1);   // a fresh day, so the lower trade limit below is not already used up
        ChartBridgeBot.Check();
        Page("{\"type\":\"botRails\",\"cid\":\"r\",\"maxTrades\":6,\"maxLosses\":3,\"root\":\"MNQ\"}");
        Check(PageReject().Contains("maxTrades must be a whole number from 1 to 5"), "botRails: more than 5 trades refused");
        Page("{\"type\":\"botRails\",\"cid\":\"r\",\"maxTrades\":5,\"maxLosses\":4,\"root\":\"MNQ\"}");
        Check(PageReject().Contains("maxLosses must be a whole number from 1 to 3"), "botRails: more than 3 losses refused");
        Page("{\"type\":\"botRails\",\"cid\":\"r\",\"maxTrades\":5,\"maxLosses\":3,\"root\":\"ES\"}");
        Check(PageReject().Contains("root must be MNQ or NQ"), "botRails: a root other than botRoot and its sibling refused");
        Page("{\"type\":\"botRails\",\"cid\":\"r\",\"maxTrades\":5,\"maxLosses\":3}");
        Check(PageReject().Contains("root must be"), "botRails: every key needed");
        Order e = AutoTrade("buy");
        Page("{\"type\":\"botRails\",\"cid\":\"r\",\"maxTrades\":2,\"maxLosses\":1,\"root\":\"NQ\"}");
        Check(PageReject().Contains("position or a working entry"), "botRails: refused while the bot has a working entry");
        Settle();
        Page("{\"type\":\"botRails\",\"cid\":\"r\",\"maxTrades\":2,\"maxLosses\":1,\"root\":\"NQ\"}");
        Check(Last(page, "bot").Contains("\"maxTrades\":2") && Last(page, "bot").Contains("\"maxLosses\":1") && Last(page, "bot").Contains("\"root\":\"NQ\""), "botRails: set and reported in the strip");
        Check(Last(botOut, "welcome").Contains("\"root\":\"NQ\"") && Last(botOut, "welcome").Contains("\"maxTrades\":2,\"maxLosses\":1"), "botRails: reported to the bot in welcome");
        Check(File_("bot-rails.txt").Contains("maxTrades\t2") && File_("bot-rails.txt").Contains("root\tNQ"), "botRails: saved in bot-rails.txt");
        ChartBridgeBot.Stop(); ChartBridgeBot.Start(false); Reconnect();
        Check(ChartBridgeBot.StripJson().Contains("\"maxTrades\":2") && ChartBridgeBot.StripJson().Contains("\"root\":\"NQ\""), "botRails: kept across a restart");
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        int n = sim.Calls.Count;
        Bot(Sig(NewId(), Market("buy")));
        Check(Calls(sim, n).Count == 1 && Newest(sim).Instrument == nq && Newest(sim).Quantity == 1, "the bot now trades 1 NQ (the mini of its market)");
        Settle();
        File.WriteAllText(Path.Combine(home, "ChartBridge", "bot-rails.txt"), "maxTrades\tlots\n");
        ChartBridgeBot.Stop(); ChartBridgeBot.Start(false); Reconnect();
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        n = sim.Calls.Count;
        Bot(Sig(NewId(), Market("buy")));
        Check(BotReject().Contains("bot-rails.txt") && sim.Calls.Count == n, "a bot-rails.txt that cannot be understood: no new bot entries");
        Page("{\"type\":\"botRails\",\"cid\":\"r\",\"maxTrades\":5,\"maxLosses\":3,\"root\":\"MNQ\"}");
        Check(Last(page, "bot").Contains("\"standDown\":null") && Last(page, "bot").Contains("\"root\":\"MNQ\""), "the page sets the rails again: the bot may trade");
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

    static string Get(int port, string path, string origin, string secret, out int status) { return Get(port, path, origin, secret, out status, null); }

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
        int n = sim.Calls.Count;
        ChartBridgeBot.Stop();
        ChartBridgeBot.ResetConfig();
        ChartBridgeBot.Start(false);
        Check(ChartBridgeBot.UpgradeCheck(null, "x", true) == 404 && !ChartBridgeBot.Attach(new ChartBridgeClient(null, -3)), "off again: /bot 404, no bot can attach");
        Page("{\"type\":\"botMode\",\"cid\":\"m\",\"mode\":\"auto\"}");
        Check(PageReject().Contains("The bot channel is off"), "off again: page messages refused");
        ChartBridgeBot.OnBotMessage(bc, Sig(NewId(), Market("buy")));
        Check(sim.Calls.Count == n && eval.Calls.Count == 0, "off again: nothing reaches NinjaTrader");
    }
}
