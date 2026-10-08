// ChartBridge 0.5.0 on Mono (inside check:orders): the agent channel (nt8/ChartBridgeAgents.cs, PROTOCOL.md "Agent channel").
// MADE-UP agents only ("manrae" stands in for the first agent's id; "demob" is a second, made-up one): every plan here is written
// by hand, nothing is a real agent's rule, notebook or market data; prices are made up. Made-up accounts: Sim101 and SIM-B,
// SIM-C, SIM-D (NinjaTrader's simulator), EVAL-A (a made-up evaluation account, LIVE to NinjaTrader).
// Every refusal must never reach a stand-in account. Covered: the files and the secret, the upgrade's answers, hello, the strict
// parser, checks 1 to 12 of a plan in order, shadow, copilot and auto, proposals (accept, reject, withdraw, expiry, accept with
// under 5 s left), the expiry and window timers (part fill too), the heartbeat, the flat time with the agent gone, the rule set
// and the hard ceiling, files that cannot be read, account exclusivity both ways, the owner lock against the page, the bot, the
// copier and another agent, two agents at once, the day roll, recovery by name, fills to The Desk with "by", subscribe and
// ticks, and the page's sign-in replay.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript.AddOns;

public static class AgentHarness
{
    static Action<bool, string> Check;
    const BindingFlags PS = BindingFlags.NonPublic | BindingFlags.Static;
    static readonly List<string> page = new List<string>(), agentOut = new List<string>(), demobOut = new List<string>();
    static ChartBridgeClient pc, ac, dc;
    static Account sim, eval, simb, simc, simd;
    static Instrument mnq, nq;
    static double clock = 1791467200000;              // made-up UTC ms; the agent channel's clock (ChartBridgeAgents.ClockMs)
    static DateTime et = new DateTime(2026, 10, 8, 10, 0, 0);   // New York time for the agent channel (ChartBridgeAgents.ClockEt)
    static string home, token;
    static int idN;
    static string shadowId;   // a plan id used today (Shadow)

    static ChartBridgeAgent M { get { return ChartBridgeAgents.Get("manrae"); } }
    static ChartBridgeAgent D { get { return ChartBridgeAgents.Get("demob"); } }
    static ConcurrentDictionary<int, ChartBridgeClient> Clients() { return (ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", PS).GetValue(null); }
    static Dictionary<string, Instrument> Named() { return (Dictionary<string, Instrument>)typeof(ChartBridgeServer).GetField("Instruments", PS).GetValue(null); }
    static string Last(List<string> l, string type) { lock (l) { for (int i = l.Count - 1; i >= 0; i--) if (l[i].StartsWith("{\"type\":\"" + type + "\"")) return l[i]; } return ""; }
    static int Count(List<string> l, string type) { lock (l) return l.Count(x => x.StartsWith("{\"type\":\"" + type + "\"")); }
    static bool Any(List<string> l, int from, string has) { lock (l) return l.Skip(from).Any(x => x.Contains(has)); }
    static int N(List<string> l) { lock (l) return l.Count; }
    static bool Logged(string has) { lock (NinjaTrader.Code.Output.Lines) return NinjaTrader.Code.Output.Lines.Any(x => x.Contains(has)); }
    static string Dir { get { return Path.Combine(home, "ChartBridge"); } }
    static string FileText(string name) { try { return File.ReadAllText(Path.Combine(Dir, name)); } catch (Exception) { return ""; } }

    static void OnClient(ChartBridgeClient c, string json) { typeof(ChartBridgeServer).GetMethod("OnClientMessage", PS).Invoke(null, new object[] { c, json }); }
    static void P(string json) { lock (pc.Actions) pc.Actions.Clear(); OnClient(pc, json); }
    static string PageReject() { return Last(page, "reject"); }
    static void A(string json) { clock += 150; M.OnMessage(ac, json); }       // the agent's own pace: well inside 10 a second
    static void B(string json) { clock += 150; D.OnMessage(dc, json); }
    static string AgentReject() { return Last(agentOut, "reject"); }
    static string Answer() { return Last(agentOut, "answer"); }
    static void Tick() { ChartBridgeAgents.Check(); }
    // Time passes with manrae beating (its heartbeat kept); Silent: nobody sends anything.
    static void Advance(double ms)
    {
        while (ms > 0) { double step = Math.Min(1000, ms); clock += step; ms -= step; if (ac != null) M.OnMessage(ac, "{\"type\":\"beat\"}"); Tick(); }
    }
    static void Silent(double ms) { clock += ms; Tick(); }
    static string NewId() { return "plan-" + (++idN); }

    // A made-up plan. risk null: the right riskDollars for the plan (stopTicks x tick x point value x qty).
    static string Plan(string id, string root, string side, string kind, string price, int qty, int stop, int target, int expire, string extra = null, string risk = null, string conf = "0.6")
    {
        double pv = root == "NQ" ? 20 : 2;
        string r = risk ?? (stop * 0.25 * pv * qty).ToString("0.##", CultureInfo.InvariantCulture);
        return "{\"type\":\"plan\",\"id\":\"" + id + "\",\"root\":\"" + root + "\",\"side\":\"" + side + "\",\"kind\":\"" + kind + "\",\"price\":" + price + (extra ?? "") +
               ",\"qty\":" + qty + ",\"stopTicks\":" + stop + ",\"targetTicks\":" + target + ",\"expireSec\":" + expire + ",\"riskDollars\":" + r +
               ",\"setup\":\"Sample fade\",\"reason\":\"Sample: price held the made-up level twice\",\"confidence\":" + conf + "}";
    }
    static string Good(string id) { return Plan(id, "MNQ", "buy", "limit", "24999", 1, 8, 16, 600); }

    static Order Entry(Account a) { lock (a.Orders) return a.Orders.LastOrDefault(o => ChartBridgeAgents.IsEntryName(o.Name)); }
    static bool IsLive(Order o) { return o.OrderState != OrderState.Filled && o.OrderState != OrderState.Cancelled && o.OrderState != OrderState.Rejected; }
    static List<Order> Live(Account a) { lock (a.Orders) return a.Orders.Where(IsLive).ToList(); }
    static string Tag(Order o) { return Regex.Match(o.Name ?? "", "^CB#([0-9a-f]{8}) ").Groups[1].Value; }
    static List<Order> Legs(Account a, Order entry) { string t = Tag(entry); lock (a.Orders) return a.Orders.Where(o => o != entry && Regex.IsMatch(o.Name ?? "", "^CB#" + t + " (stop|target) ")).ToList(); }
    static void Update(Order o) { ChartBridgeOrders.OnOrderUpdate(o.Account, new OrderEventArgs { Order = o }); }
    static void Deliver(string account, Instrument inst, MarketPosition side, int qty, double price, string orderId)
    {
        typeof(ChartBridgeServer).GetMethod("Deliver", PS).Invoke(null, new object[] { account, inst, side, qty, price, DateTime.Now, "x" + Guid.NewGuid().ToString("N"), orderId, null });
    }
    static int PosOf(Account a, Instrument i) { Position p = a.Positions.FirstOrDefault(x => x.Instrument == i); return p == null ? 0 : p.MarketPosition == MarketPosition.Long ? p.Quantity : -p.Quantity; }
    static void SetPos(Account a, Instrument i, int signed)
    {
        a.Positions.RemoveAll(p => p.Instrument == i);
        Position pos = new Position { Instrument = i, MarketPosition = signed > 0 ? MarketPosition.Long : signed < 0 ? MarketPosition.Short : MarketPosition.Flat, Quantity = Math.Abs(signed), AveragePrice = 25000 };
        if (signed != 0) a.Positions.Add(pos);
        ChartBridgeOrders.OnPositionUpdate(a, new PositionEventArgs { Position = pos, MarketPosition = pos.MarketPosition, Quantity = pos.Quantity, AveragePrice = 25000 });
    }
    // An entry fills (its order event: legs go on), then NinjaTrader's execution and the position.
    static void Fill(Order o, int filled, double price)
    {
        if (o.OrderId == null) o.OrderId = "NT" + Guid.NewGuid().ToString("N").Substring(0, 8);
        int inc = filled - o.Filled;
        o.Filled = filled; o.AverageFillPrice = price; o.OrderState = filled >= o.Quantity ? OrderState.Filled : OrderState.PartFilled;
        Update(o);
        bool buy = o.OrderAction == OrderAction.Buy;
        Deliver(o.Account.Name, o.Instrument, buy ? MarketPosition.Long : MarketPosition.Short, inc, price, o.OrderId);
        SetPos(o.Account, o.Instrument, PosOf(o.Account, o.Instrument) + (buy ? inc : -inc));
    }
    // The position closes at `price` (a leg, or anything): an execution the other way, then nothing left working.
    static void Close(Account a, Instrument i, double price)
    {
        int pos = PosOf(a, i);
        if (pos != 0) Deliver(a.Name, i, pos > 0 ? MarketPosition.Short : MarketPosition.Long, Math.Abs(pos), price, "EXIT" + Guid.NewGuid().ToString("N").Substring(0, 6));
        Settle(a);
    }
    static void Settle(Account a)
    {
        foreach (Order o in Live(a)) { o.OrderState = OrderState.Cancelled; Update(o); }
        foreach (Instrument i in new[] { mnq, nq }) if (PosOf(a, i) != 0) SetPos(a, i, 0);
        ((System.Collections.IDictionary)typeof(ChartBridgeOrders).GetField("Moves", PS).GetValue(null)).Clear();
        Tick();
    }
    static void SettleAll() { foreach (Account a in new[] { sim, eval, simb, simc, simd }) Settle(a); }

    // The stand-in broker: a cancel cancels (with its order event); everything else waits for the harness.
    static Func<string, Order, bool> Hold;
    static void Broker(string kind, Order o)
    {
        Func<string, Order, bool> h = Hold;
        if (h != null && h(kind, o)) return;
        if (kind == "cancel" && IsLive(o)) { o.OrderState = OrderState.Cancelled; Update(o); }
        else if (kind == "submit") Update(o);
    }

    static Account NewAccount(string name, Provider p)
    {
        Account a = new Account { Name = name, Provider = p, Connection = new Connection { Status = ConnectionStatus.Connected } };
        a.OnCall = Broker;
        Account.All.Add(a);
        ((Dictionary<Account, double>)typeof(ChartBridgeOrders).GetField("ConnectedSince", PS).GetValue(null))[a] = 0;   // steady since long ago
        return a;
    }

    static void Mode(string agent, string mode)
    {
        P("{\"type\":\"agentMode\",\"cid\":\"m\",\"agent\":\"" + agent + "\",\"mode\":\"" + mode + "\"}");
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
            Off();
            Files();
            Hello();
            Strict();
            Shadow();
            ChecksInOrder();
            Auto();
            Copilot();
            Expiry();
            Window();
            Heartbeat();
            FlatTime();
            RulesAndCeiling();
            FilesUnreadable();
            Exclusivity();
            OwnerLockBotAndAgent();
            TwoAgents();
            DayRoll();
            FillsBy();
            SubscribeAndTicks();
            Replay();
            Recovery();
            OwnerLockCopier();
        }
        catch (Exception ex) { Check(false, "agent harness threw: " + ex); }
        finally
        {
            Hold = null;
            ChartBridgeAgents.Stop();
            ChartBridgeAgents.ResetConfig();
            ChartBridgeAgents.ClockMs = null; ChartBridgeAgents.ClockEt = null;
            ChartBridgeCopier.Stop(); ChartBridgeCopier.HarnessManual = false;
            ChartBridgeBot.Stop(); ChartBridgeBot.ResetConfig();
            OrdersHarness.AllOffLines();
            ChartBridgeOrders.ResetConfig();
            ChartBridgeOrders.Clear();
            Account.All.Clear(); Account.All.AddRange(accountsWas);
            Named().Clear(); foreach (KeyValuePair<string, Instrument> kv in namedWas) Named()[kv.Key] = kv.Value;
            Clients().Clear(); foreach (KeyValuePair<int, ChartBridgeClient> kv in clientsWas) Clients()[kv.Key] = kv.Value;
            NinjaTrader.Core.Globals.UserDataDir = dirWas;
            ChartBridgeConfig.Port = portWas;
        }
    }

    static void Config(params string[] extra)
    {
        List<string> lines = new List<string> { "trading = true" };
        lines.AddRange(extra);
        File.WriteAllLines(Path.Combine(Dir, "config.txt"), lines.ToArray());
        ChartBridgeConfig.Load();
        OrdersHarness.AllOffLines();
        ChartBridgeSwitches.Note("orderTypes", "on");   // stop-limit entries
        ChartBridgeOrders.ReadConfig("trading", "true");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, EVAL-A, SIM-B, SIM-C, SIM-D");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "30");   // above the hard ceiling, so the agent's own limits are what refuse
        ChartBridgeOrders.ReadConfig("maxQty.NQ", "5");
    }

    static void Last2() { ChartBridgeOrders.NoteLast("MNQ", 25000); ChartBridgeOrders.NoteLast("NQ", 25000); }

    static void Setup()
    {
        home = Path.Combine(Path.GetTempPath(), "cb-agents-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Dir);
        NinjaTrader.Core.Globals.UserDataDir = home;
        ChartBridgeConfig.Port = 8765;
        FieldInfo etf = typeof(ChartBridgeTime).GetField("et", PS);   // Linux names New York's zone differently from Windows (as PinHarness)
        if (etf.GetValue(null) == null) etf.SetValue(null, TimeZoneInfo.FindSystemTimeZoneById("America/New_York"));
        ChartBridgeAgents.ClockMs = () => clock;
        ChartBridgeAgents.ClockEt = () => et;
        Account.All.Clear();
        ChartBridgeOrders.Clear();
        ChartBridgeOrders.LoadPlansNow();
        mnq = new Instrument { FullName = "MNQ 12-26", MasterInstrument = new MasterInstrument { Name = "MNQ", TickSize = 0.25, PointValue = 2 } };
        nq = new Instrument { FullName = "NQ 12-26", MasterInstrument = new MasterInstrument { Name = "NQ", TickSize = 0.25, PointValue = 20 } };
        Named().Clear(); Named()["MNQ"] = mnq; Named()["NQ"] = nq;
        sim = NewAccount("Sim101", Provider.Simulator);
        eval = NewAccount("EVAL-A", Provider.Rithmic);   // made up: a LIVE account to NinjaTrader
        simb = NewAccount("SIM-B", Provider.Simulator);
        simc = NewAccount("SIM-C", Provider.Simulator);
        simd = NewAccount("SIM-D", Provider.Simulator);
        Config();
        Last2();
        ChartBridgeOrders.NewToken();
        token = ChartBridgeOrders.SessionJson().Split('"')[3];
        Clients().Clear();
        pc = new ChartBridgeClient(null, 601) { Origin = "http://localhost:8765" };
        pc.Tap = s => { lock (page) page.Add(s); };
        Clients()[601] = pc;
        OnClient(pc, "{\"type\":\"client\",\"v\":3}");
        OnClient(pc, "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
        Check(pc.Trader && ChartBridgeV3.IsV3(pc), "setup: a signed-in v3 page");
    }

    // ------------------------------------------------------------ off: no agents line: /agent is 404, every agent message refused
    static void Off()
    {
        ChartBridgeAgents.Start(false);
        Check(!ChartBridgeAgents.Enabled && ChartBridgeAgents.UpgradeCheck("manrae", null, "x", true) == 404, "off (no agents line): an upgrade to /agent/manrae answers 404");
        P("{\"type\":\"agentMode\",\"cid\":\"m1\",\"agent\":\"manrae\",\"mode\":\"auto\"}");
        Check(PageReject().Contains("The agent channel is off (no agents in config.txt)."), "off: agentMode refused: " + PageReject());
        Check(!File.Exists(Path.Combine(Dir, "agent-manrae-secret.txt")) && Count(page, "agent") == 0, "off: no secret file, no agent message to the page");
        Config("agents = Manrae, 9lives, abcdefghijklm, ok1, ok1");
        Check(string.Join(",", ChartBridgeAgents.Ids()) == "ok1", "config.txt: ids are a-z and 0-9, 1 to 12, starting with a letter; twice is once: " + string.Join(",", ChartBridgeAgents.Ids()));
        Check(Logged("config.txt: agents: \"Manrae\" is not an agent id"), "config.txt: a bad id is left out with an Output line");
        Config("agents =");
        Check(ChartBridgeAgents.Ids().Count == 0, "config.txt: agents = (empty): the channel is off");
    }

    // ------------------------------------------------------------ files, the secret and the upgrade's answers
    static void Files()
    {
        File.WriteAllLines(Path.Combine(Dir, "agent-demob-account.txt"), new[] { "# made-up", "# test", "account\tSIM-B" });
        Config("agents = manrae, demob");
        ChartBridgeAgents.Start(false);
        Check(ChartBridgeAgents.Enabled && ChartBridgeAgents.All().Length == 2 && M != null && D != null && M != D, "two agents, one object each");
        string[] lines = File.ReadAllLines(Path.Combine(Dir, "agent-manrae-secret.txt"));
        string secret = lines.Length == 3 ? lines[2] : "", secret2 = File.ReadAllLines(Path.Combine(Dir, "agent-demob-secret.txt"))[2];
        Check(lines.Length == 3 && lines[0].StartsWith("#") && lines[1].StartsWith("#") && Regex.IsMatch(secret, "^[0-9a-f]{64}$") && secret != secret2, "agent-<id>-secret.txt: two # lines then 64 hex characters, one per agent");
        bool printed;
        lock (NinjaTrader.Code.Output.Lines) printed = NinjaTrader.Code.Output.Lines.Any(x => x.Contains(secret) || x.Contains(secret2));
        Check(!printed && !ChartBridgeAgents.DiagJson().Contains(secret) && ChartBridgeAgents.DiagJson().Contains("\"secretFile\":\"ok\""), "the secret is never in the Output window or /diag");
        Check(ChartBridgeAgents.UpgradeCheck("nobody", null, secret, true) == 404, "an id not in agents: 404");
        Check(ChartBridgeAgents.UpgradeCheck("manrae", "http://localhost:8765", secret, true) == 403 && ChartBridgeAgents.UpgradeCheck("manrae", "", secret, true) == 403, "any Origin header: 403");
        Check(ChartBridgeAgents.UpgradeCheck("manrae", null, secret2, true) == 403 && ChartBridgeAgents.UpgradeCheck("manrae", null, null, true) == 403 && ChartBridgeAgents.UpgradeCheck("manrae", null, secret.ToUpperInvariant(), true) == 403,
              "a wrong secret (another agent's too) or none: 403");
        Check(ChartBridgeAgents.UpgradeCheck("manrae", null, secret, false) == 400, "the right secret on a request that is not an upgrade: 400");
        Check(ChartBridgeAgents.UpgradeCheck("manrae", null, secret, true) == 101, "no Origin and the right secret: the upgrade goes ahead");
        ChartBridgeAgents.Stop(); ChartBridgeAgents.Start(false);
        Check(File.ReadAllLines(Path.Combine(Dir, "agent-manrae-secret.txt"))[2] == secret, "a restart keeps the secret");
        File.WriteAllText(Path.Combine(Dir, "agent-manrae-secret.txt"), "# torn\nabc\n");
        ChartBridgeAgents.Stop(); ChartBridgeAgents.Start(false);
        Check(ChartBridgeAgents.UpgradeCheck("manrae", null, secret, true) == 403 && FileText("agent-manrae-secret.txt") == "# torn\nabc\n" && M.DiagJson().Contains("\"secretFile\":\"unreadable\"") &&
              ChartBridgeAgents.UpgradeCheck("demob", null, secret2, true) == 101, "a broken secret file: every connection for that id refused, the file left as it is; the other agent unaffected");
        File.Delete(Path.Combine(Dir, "agent-manrae-secret.txt"));
        ChartBridgeAgents.Stop(); ChartBridgeAgents.Start(false);
        string fresh = File.ReadAllLines(Path.Combine(Dir, "agent-manrae-secret.txt"))[2];
        Check(fresh != secret && ChartBridgeAgents.UpgradeCheck("manrae", null, secret, true) == 403 && ChartBridgeAgents.UpgradeCheck("manrae", null, fresh, true) == 101, "deleted: a new secret at the next start, the old one refused");
        Check(M.Account == "Sim101" && D.Account == "SIM-B", "no account file: Sim101; demob's file: SIM-B");
        Check(Logged("agent channel ON for manrae: it may connect at ws://localhost:8765/agent/manrae"), "the Output window says where each agent connects");

        ac = new ChartBridgeClient(null, -100);
        ac.Tap = s => { lock (agentOut) agentOut.Add(s); };
        Check(M.Attach(ac), "manrae attaches");
        Check(ChartBridgeAgents.UpgradeCheck("manrae", null, fresh, true) == 409 && !M.Attach(new ChartBridgeClient(null, -199)), "a second connection for manrae: 409");
        Check(ChartBridgeAgents.UpgradeCheck("demob", null, secret2, true) == 101, "ids are independent: demob may connect while manrae is");
    }

    // ------------------------------------------------------------ agentHello first; welcome, then agentState
    static void Hello()
    {
        A(Good(NewId()));
        Check(AgentReject().Contains("send agentHello first"), "a plan before agentHello: refused");
        A("{\"type\":\"beat\"}");
        Check(AgentReject().Contains("send agentHello first"), "a beat before agentHello: refused too (anything earlier)");
        A("{\"type\":\"agentHello\",\"name\":\"Manrae\"}");
        Check(AgentReject().Contains("build of 1 to 40"), "agentHello needs a build");
        int n = N(agentOut);
        A("{\"type\":\"agentHello\",\"name\":\"Manrae\",\"build\":\"sample-build-1\"}");
        List<string> got;
        lock (agentOut) got = agentOut.Skip(n).ToList();
        string w = got.Count > 0 ? got[0] : "";
        Check(w.StartsWith("{\"type\":\"welcome\"") && got.Count > 1 && got[1].StartsWith("{\"type\":\"agentState\""), "agentHello: welcome, then agentState");
        Check(w.Contains("\"version\":\"0.5.0\"") && w.Contains("\"agent\":\"manrae\"") && w.Contains("\"mode\":\"shadow\"") && w.Contains("\"account\":\"Sim101\",\"sim\":true") &&
              w.Contains("\"rules\":{\"roots\":[\"NQ\",\"MNQ\"],\"maxQty\":{\"NQ\":2,\"MNQ\":20},\"entryFrom\":\"09:45\",\"entryUntil\":\"15:00\",\"flatAt\":\"15:55\",\"maxExpireSec\":1800,\"maxTrades\":null,\"maxLosses\":null}") &&
              w.Contains("{\"root\":\"MNQ\",\"name\":\"MNQ 12-26\",\"tick\":0.25,\"pointValue\":2}") && w.Contains("{\"root\":\"NQ\",\"name\":\"NQ 12-26\",\"tick\":0.25,\"pointValue\":20}"),
              "welcome: version, agent, shadow, Sim101 (sim), the default rules, its roots' instruments: " + w);
        string st = Last(agentOut, "agentState");
        Check(st == "{\"type\":\"agentState\",\"mode\":\"shadow\",\"killed\":false,\"standDown\":null,\"trades\":0,\"losses\":0,\"pnlToday\":0,\"owns\":false}", "agentState: " + st);
        string strip = Last(page, "agent");
        Check(strip.Contains("\"agent\":\"manrae\",\"name\":\"Manrae\",\"build\":\"sample-build-1\",\"enabled\":true,\"connected\":true,\"mode\":\"shadow\"") && strip.Contains("\"lastPlan\":null"), "the page's strip: " + strip);
        ChartBridgeAgents.OnTick("MNQ", "{\"type\":\"tick\",\"root\":\"MNQ\",\"p\":25000.25,\"v\":1}");
        Check(Last(agentOut, "tick").Contains("25000.25"), "the agent reads every live trade");
    }

    // ------------------------------------------------------------ the strict parser (gate 8) and note.text's 1,000
    static void Strict()
    {
        A("{\"type\":\"beat\",\"extra\":1}");
        Check(AgentReject().Contains("unknown key \\\"extra\\\" in beat"), "an unknown key is refused");
        A("{\"type\":\"beat\",\"type\":\"beat\"}");
        Check(AgentReject().Contains("key twice"), "a key twice is refused");
        A("{\"type\":\"note\",\"kind\":\"look\",\"text\":\"a\\u0041\"}");
        Check(AgentReject().Contains("escape"), "an escape is refused");
        A("{\"type\":\"note\",\"kind\":\"look\",\"text\":{\"a\":1}}");
        Check(AgentReject().Contains("nested"), "a nested object is refused");
        A("{\"type\":\"skip\",\"id\":\"s1\",\"reason\":\"" + new string('r', 201) + "\"}");
        Check(AgentReject().Contains("reason is longer than 200 characters"), "a string over 200 characters is refused");
        int n = Count(page, "agentNote");
        A("{\"type\":\"note\",\"kind\":\"thinking\",\"text\":\"" + new string('t', 1000) + "\"}");
        Check(Count(page, "agentNote") == n + 1 && Last(page, "agentNote").Contains("\"kind\":\"thinking\""), "note.text may be 1,000 characters (the one exception)");
        A("{\"type\":\"note\",\"kind\":\"thinking\",\"text\":\"" + new string('t', 1001) + "\"}");
        Check(AgentReject().Contains("plain string of at most 1000 characters") && Count(page, "agentNote") == n + 1, "note.text over 1,000 is refused");
        A("{\"type\":\"note\",\"kind\":\"gossip\",\"text\":\"x\"}");
        Check(AgentReject().Contains("note kind must be"), "a note's kind is one of five");
        A("{\"type\":\"plan\",\"id\":\"q1\",\"root\":\"MNQ\",\"price\":-1}");
        Check(AgentReject().Contains("not a plain value") && Last(page, "agentPlan").Contains("\"result\":\"refused: price is not a plain value"), "a plan that does not parse: reject, and the page sees it refused");
        // the rate: 10 a second, beats not counted
        int calls = sim.Calls.Count;
        for (int i = 0; i < 11; i++) M.OnMessage(ac, "{\"type\":\"note\",\"kind\":\"status\",\"text\":\"n" + i + "\"}");
        Check(AgentReject().Contains("too many agent messages"), "more than 10 messages a second: refused");
        for (int i = 0; i < 5; i++) M.OnMessage(ac, "{\"type\":\"beat\"}");
        clock += 1100;
        Check(sim.Calls.Count == calls, "nothing of it reached NinjaTrader");
    }

    // ------------------------------------------------------------ shadow: logged and shown, nothing placed, no answer
    static void Shadow()
    {
        int calls = sim.Calls.Count, answers = Count(agentOut, "answer");
        string id = NewId();
        shadowId = id;
        A(Good(id));
        string ap = Last(page, "agentPlan");
        Check(sim.Calls.Count == calls && Count(agentOut, "answer") == answers, "shadow: nothing placed, no answer to the agent");
        Check(ap.Contains("\"id\":\"" + id + "\"") && ap.Contains("\"action\":\"plan\"") && ap.Contains("\"result\":\"shadow\"") && ap.Contains("\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"limit\",\"price\":24999,\"limitPrice\":null,\"qty\":1,\"stopTicks\":8,\"targetTicks\":16,\"expireSec\":600,\"riskDollars\":4,\"setup\":\"Sample fade\""),
              "shadow: agentPlan with every field and result shadow: " + ap);
        Check(FileText("agent-manrae.log").Contains("plan " + id + " buy 1 MNQ limit @ 24999") && FileText("agent-manrae.log").Contains(": shadow"), "shadow: one log line in agent-manrae.log");
        Check(Last(page, "agent").Contains("\"lastPlan\":{\"type\":\"agentPlan\""), "the strip carries the last plan");
        A("{\"type\":\"skip\",\"id\":\"sk1\",\"setup\":\"Sample fade\",\"reason\":\"spread too wide (made up)\"}");
        Check(Last(page, "agentPlan").Contains("\"action\":\"skip\"") && Last(page, "agentPlan").Contains("\"result\":\"skipped\""), "skip: logged and shown");
    }

    // ------------------------------------------------------------ checks 1 to 11, each refusal in order; nothing sent
    static void ChecksInOrder()
    {
        Mode("manrae", "auto");
        Check(M.DiagJson().Contains("\"mode\":\"auto\"") && Last(agentOut, "welcome").Contains("\"mode\":\"auto\""), "auto: set from the page; the agent gets welcome again");
        int calls = sim.Calls.Count;
        Action<string, string, string> refuse = (plan, has, label) =>
        {
            Last2();
            A(plan);
            string r = AgentReject(), ap = Last(page, "agentPlan");
            Check(r.Contains(has) && ap.Contains("\"result\":\"refused: ") && ap.Contains(has.Replace("\"", "\\\"")) && sim.Calls.Count == calls, label + ": " + r);
        };
        // 1. strict, id new today
        refuse(Good(NewId()).Replace(",\"confidence\":0.6", ""), "confidence must be a number from 0 to 1", "check 1: a missing field");
        refuse(Good(NewId()).Replace("\"confidence\":0.6", "\"confidence\":1.5"), "confidence must be a number from 0 to 1", "check 1: confidence above 1");
        refuse(Good(shadowId), "plan id " + shadowId + " was already used today", "check 1: an id used today (a shadow plan's)");
        // 2. killed, stood down, the account
        P("{\"type\":\"agentKill\",\"cid\":\"k\",\"agent\":\"manrae\",\"on\":true}");
        refuse(Plan(NewId(), "ES", "buy", "market", "24999", 0, 0, 0, 1), "the kill switch is on", "check 2 before 3 and 4: killed");
        P("{\"type\":\"agentKill\",\"cid\":\"k\",\"agent\":\"manrae\",\"on\":false}");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "EVAL-A, SIM-B, SIM-C, SIM-D");
        refuse(Good(NewId()), "Sim101 may not trade from the chart (tradeAccounts in config.txt): the agent needs it tradable", "check 2: the account not tradable now");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, EVAL-A, SIM-B, SIM-C, SIM-D");
        sim.Connection.Status = ConnectionStatus.ConnectionLost;
        refuse(Good(NewId()), "Sim101 is not connected", "check 2: not Connected");
        sim.Connection.Status = ConnectionStatus.Connected;
        // 3. root and kind
        refuse(Plan(NewId(), "ES", "buy", "limit", "24999", 0, 0, 0, 1), "ES is not one of agent manrae's roots", "check 3 before 4: a root not in roots");
        refuse(Plan(NewId(), "MNQ", "buy", "market", "24999", 1, 8, 16, 600), "an agent's entry is a limit or a stop-limit (market refused)", "check 3: market");
        refuse(Plan(NewId(), "MNQ", "buy", "stop", "25001", 1, 8, 16, 600), "an agent's entry is a limit or a stop-limit (stop refused)", "check 3: stop");
        refuse(Plan(NewId(), "MNQ", "buy", "mit", "24999", 1, 8, 16, 600), "(mit refused)", "check 3: mit");
        refuse(Plan(NewId(), "MNQ", "buy", "stopLimit", "25001", 1, 8, 16, 600), "a stopLimit plan needs a limitPrice", "check 3: stopLimit without limitPrice");
        refuse(Plan(NewId(), "MNQ", "buy", "limit", "24999", 1, 8, 16, 600, ",\"limitPrice\":24999"), "limitPrice goes on a stopLimit plan only", "check 3: limitPrice on a limit");
        // 4. size, stop, target
        refuse(Plan(NewId(), "MNQ", "buy", "limit", "24999", 0, 0, 16, 1), "qty must be a whole number from 1 to 20", "check 4 before 5 and 6: qty 0");
        refuse(Plan(NewId(), "NQ", "buy", "limit", "24999", 3, 8, 16, 600), "qty must be a whole number from 1 to 2 (agent manrae's maxQty for NQ)", "check 4: NQ 3 (ceiling 2)");
        refuse(Plan(NewId(), "MNQ", "buy", "limit", "24999", 21, 8, 16, 600), "qty must be a whole number from 1 to 20", "check 4: MNQ 21 (ceiling 20)");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "3");
        refuse(Plan(NewId(), "MNQ", "buy", "limit", "24999", 4, 8, 16, 600), "qty 4 is over the MNQ cap of 3 (maxQty.MNQ in config.txt)", "check 4: config.txt's gate 3 cap still holds");
        ChartBridgeOrders.ReadConfig("maxQty.MNQ", "30");
        refuse(Plan(NewId(), "MNQ", "buy", "limit", "24999", 1, 0, 16, 600), "every agent entry needs a stop and a target", "check 4: no stop");
        refuse(Plan(NewId(), "MNQ", "buy", "limit", "24999", 1, 8, 0, 600), "every agent entry needs a stop and a target", "check 4: no target");
        // 5. risk
        refuse(Plan(NewId(), "MNQ", "buy", "limit", "24999", 2, 8, 16, 1, null, "4"), "riskDollars 4 is not stopTicks x tick x point value x qty (8.00)", "check 5 before 6: the risk does not add up");
        refuse(Plan(NewId(), "NQ", "buy", "limit", "24999", 1, 8, 16, 600, null, "40.02"), "riskDollars 40.02 is not", "check 5: off by more than a cent");
        // 6. expiry
        refuse(Plan(NewId(), "MNQ", "buy", "limit", "24999", 1, 8, 16, 59), "expireSec must be from 60 to 1800", "check 6: 59 s");
        refuse(Plan(NewId(), "MNQ", "buy", "limit", "24999", 1, 8, 16, 1801), "expireSec must be from 60 to 1800", "check 6: 1801 s");
        // 7. window
        et = new DateTime(2026, 10, 8, 9, 44, 59);
        refuse(Plan(NewId(), "MNQ", "buy", "limit", "24999.1", 1, 8, 16, 600), "outside agent manrae's entry window (09:45 to 15:00 New York time)", "check 7 before 11: 09:44:59");
        et = new DateTime(2026, 10, 8, 15, 0, 0);
        refuse(Good(NewId()), "outside agent manrae's entry window", "check 7: 15:00 is not included");
        et = new DateTime(2026, 10, 8, 10, 0, 0);
        // 8. one at a time: a working entry (placed below in Auto) and a proposal are covered there; here a position of its own
        // 10. the owner lock: anything else held or working on its account and root
        SetPos(sim, mnq, 1);
        refuse(Good(NewId()), "Sim101 MNQ has a position or a working order that is not agent manrae's", "check 10: a position placed by someone else");
        SetPos(sim, mnq, 0);
        ((System.Collections.IDictionary)typeof(ChartBridgeOrders).GetField("Moves", PS).GetValue(null)).Clear();
        Order other = sim.CreateOrder(nq, OrderAction.Buy, OrderType.Limit, OrderEntry.Manual, TimeInForce.Day, 1, 24000, 0, "", "", NinjaTrader.Core.Globals.MaxDate, null);
        other.OrderState = OrderState.Working; lock (sim.Orders) sim.Orders.Add(other);
        calls = sim.Calls.Count;
        refuse(Plan(NewId(), "NQ", "buy", "limit", "24999", 1, 8, 16, 600), "Sim101 NQ has a position or a working order that is not agent manrae's", "check 10: an order placed in NinjaTrader");
        other.OrderState = OrderState.Cancelled;
        // 11. price
        refuse(Plan(NewId(), "MNQ", "buy", "limit", "24999.1", 1, 8, 16, 600), "is not on the 0.25 tick grid", "check 11: off the grid");
        refuse(Plan(NewId(), "MNQ", "buy", "limit", "25000.25", 1, 8, 16, 600), "a buy limit above the last price 25000 would fill at once", "check 11: a buy limit above the last trade");
        refuse(Plan(NewId(), "MNQ", "sell", "limit", "24999.75", 1, 8, 16, 600), "a sell limit below the last price 25000", "check 11: a sell limit below the last trade");
        refuse(Plan(NewId(), "MNQ", "buy", "stopLimit", "24999", 1, 8, 16, 600, ",\"limitPrice\":25000"), "a buy stop must be above the last price 25000", "check 11: a buy stop-limit's price at or below the last trade");
        refuse(Plan(NewId(), "MNQ", "buy", "stopLimit", "25001", 1, 8, 16, 600, ",\"limitPrice\":25006.25"), "a buy stop-limit's limitPrice must be from its price up to 20 ticks above it", "check 11: limit 21 ticks above");
        refuse(Plan(NewId(), "MNQ", "buy", "stopLimit", "25001", 1, 8, 16, 600, ",\"limitPrice\":25000.75"), "from its price up to 20 ticks above it", "check 11: a buy's limit below its price");
        refuse(Plan(NewId(), "MNQ", "sell", "stopLimit", "24999", 1, 8, 16, 600, ",\"limitPrice\":24993.75"), "a sell stop-limit's limitPrice must be from its price down to 20 ticks below it", "check 11: a sell's limit 21 ticks below");
        ((Dictionary<string, double[]>)typeof(ChartBridgeOrders).GetField("Last", PS).GetValue(null))["NQ"] = new double[] { 25000, ChartBridgeTime.NowUtcMs() - 301000 };
        A(Plan(NewId(), "NQ", "buy", "limit", "24999", 1, 8, 16, 600));
        Check(AgentReject().Contains("the last NQ price is stale"), "check 11: a last trade over 300 s old: " + AgentReject());
        Last2();
        // the orderTypes off line refuses a stop-limit plainly at check 3
        ChartBridgeSwitches.Note("orderTypes", "off");
        refuse(Plan(NewId(), "MNQ", "buy", "stopLimit", "25001", 1, 8, 16, 600, ",\"limitPrice\":25001"), "stop-limit entries are off (orderTypes = off in config.txt)", "check 3: stop-limit with orderTypes off");
        ChartBridgeSwitches.Note("orderTypes", "on");
        Check(sim.Calls.Count == calls && simb.Calls.Count == 0 && eval.Calls.Count == 0, "no refused plan reached NinjaTrader, on any account");
        Check(M.DiagJson().Contains("\"refused\":") && FileText("agent-manrae.log").Contains("refused: check") == false && FileText("agent-manrae.log").Contains(": refused: "), "each refusal is one log line");
    }

    // ------------------------------------------------------------ auto: placed from the plan, named, Day, legs GTC, by agent
    static Order PlacedNow(string id, string plan)
    {
        Last2();
        int n;
        lock (sim.Orders) n = sim.Orders.Count;
        A(plan);
        Order o;
        lock (sim.Orders) o = sim.Orders.Skip(n).FirstOrDefault(x => ChartBridgeAgents.IsEntryName(x.Name));
        return o;
    }

    static void Auto()
    {
        string id = NewId();
        Order e = PlacedNow(id, Good(id));
        Check(e != null && Regex.IsMatch(e.Name, "^CB#[0-9a-f]{8} ag:manrae s8 t16$") && e.TimeInForce == TimeInForce.Day && e.OrderType == OrderType.Limit && e.LimitPrice == 24999 && e.Quantity == 1 && e.OrderAction == OrderAction.Buy,
              "auto: the entry is placed from the plan: a Day limit named CB#<tag> ag:manrae s8 t16: " + (e != null ? e.Name : "none"));
        if (e == null) return;
        Check(Answer().Contains("\"id\":\"" + id + "\",\"answer\":\"placed\"") && Last(page, "agentPlan").Contains("\"result\":\"placed\""), "auto: answer placed; agentPlan placed");
        Check(Last(page, "order").Contains("\"by\":\"agent:manrae\"") && Last(agentOut, "order").Contains("\"role\":\"entry\"") && !Last(agentOut, "order").Contains("\"by\""), "a v3 page sees by agent:manrae; the agent gets its own order message (as the page's)");
        string oid = (string)typeof(ChartBridgeOrders).GetMethod("IdFor", PS).Invoke(null, new object[] { e });
        Check(Answer().Contains("as order " + oid), "the placed answer names the order id the agent's order messages carry: " + Answer());
        Check(Last(agentOut, "agentState").Contains("\"owns\":true") && Last(page, "agent").Contains("\"owns\":true"), "a working entry: the agent owns Sim101 MNQ (agentState and the strip)");
        // 8. one at a time: a working entry
        A(Plan(NewId(), "NQ", "buy", "limit", "24999", 1, 8, 16, 600));
        Check(AgentReject().Contains("one at a time: agent manrae already has a working entry"), "check 8: a working entry refuses the next plan");
        // the owner lock against the page: an entry on Sim101 MNQ is refused; exits always pass
        int calls = sim.Calls.Count;
        P("{\"type\":\"order\",\"cid\":\"p1\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}}");
        Check(PageReject().Contains("Sim101 MNQ belongs to agent manrae until it is flat") && sim.Calls.Count == calls, "owner lock: the page's entry on the agent's account and root is refused: " + PageReject());
        P("{\"type\":\"order\",\"cid\":\"p2\",\"account\":\"Sim101\",\"root\":\"NQ\",\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":16}}");
        Order pageNq;
        lock (sim.Orders) pageNq = sim.Orders.LastOrDefault(o => o.Instrument == nq && IsLive(o));
        Check(pageNq != null && !Last(page, "reject").Contains("p2"), "owner lock: per (account, root): the page may still enter NQ on Sim101");
        if (pageNq != null) { pageNq.OrderState = OrderState.Cancelled; Update(pageNq); }
        string entryId = (string)typeof(ChartBridgeOrders).GetMethod("IdFor", PS).Invoke(null, new object[] { e });
        P("{\"type\":\"plan\",\"cid\":\"pl\",\"id\":\"" + entryId + "\",\"stopTicks\":null}");
        Check(PageReject().Contains("an agent's entry keeps the stop and target ChartBridge placed it with"), "a page plan never removes a working agent entry's stop (lead's default): " + PageReject());
        // the fill: legs at the fill price, OCO, GTC; a trade; the position in the strip
        Fill(e, 1, 24999);
        List<Order> legs = Legs(sim, e);
        Order stop = legs.FirstOrDefault(o => o.OrderType == OrderType.StopMarket), target = legs.FirstOrDefault(o => o.OrderType == OrderType.Limit);
        Check(stop != null && target != null && stop.StopPrice == 24997 && target.LimitPrice == 25003 && stop.TimeInForce == TimeInForce.Gtc && target.TimeInForce == TimeInForce.Gtc && stop.Oco == target.Oco && !string.IsNullOrEmpty(stop.Oco),
              "the fill: a stop 8 and a target 16 ticks from it, OCO, GTC (v2's bracket)");
        Check(Last(agentOut, "exec") != "" && Last(page, "agent").Contains("\"position\":{\"root\":\"MNQ\",\"qty\":1,\"avgPrice\":24999}") && Last(page, "agent").Contains("\"trades\":1"),
              "the agent gets its exec; the strip: its position and one trade: " + Last(page, "agent"));
        P("{\"type\":\"order\",\"cid\":\"p3\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1}");
        Check(PageReject().Contains("\"cid\":\"p3\"") && PageReject().Contains("belongs to agent manrae until it is flat"), "owner lock: while it holds a position, an add is refused");
        P("{\"type\":\"order\",\"cid\":\"p5\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"sell\",\"kind\":\"market\",\"qty\":2}");
        Check(PageReject().Contains("\"cid\":\"p5\"") && PageReject().Contains("belongs to agent manrae"), "owner lock: a sell of 2 against a long 1 would cross zero: not an exit, refused");
        P("{\"type\":\"order\",\"cid\":\"p6\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"sell\",\"kind\":\"limit\",\"qty\":1,\"price\":25002,\"bracket\":{\"stop\":8,\"target\":16}}");
        Check(PageReject().Contains("\"cid\":\"p6\"") && PageReject().Contains("belongs to agent manrae"), "owner lock: a reducing order with a bracket is not an exit: refused");
        int before = sim.Calls.Count;
        P("{\"type\":\"order\",\"cid\":\"p7\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"sell\",\"kind\":\"limit\",\"qty\":1,\"price\":25002}");
        Order reduce;
        lock (sim.Orders) reduce = sim.Orders.LastOrDefault(o => o.Instrument == mnq && IsLive(o) && o.OrderType == OrderType.Limit && o.OrderAction == OrderAction.Sell && o.Name != null && Regex.IsMatch(o.Name, "^CB#[0-9a-f]{8} atm s0 t0$"));
        Check(sim.Calls.Count == before + 1 && reduce != null, "owner lock: a page order that only reduces the agent's position passes as an exit");
        if (reduce != null) { reduce.OrderState = OrderState.Cancelled; Update(reduce); }
        A(Good(NewId()));
        Check(AgentReject().Contains("one at a time: agent manrae already has a position"), "check 8: its own position refuses the next plan");
        string stopId = (string)typeof(ChartBridgeOrders).GetMethod("IdFor", PS).Invoke(null, new object[] { stop });
        calls = sim.Calls.Count;
        P("{\"type\":\"change\",\"cid\":\"c1\",\"id\":\"" + stopId + "\",\"price\":24998}");
        Check(sim.Calls.Count == calls + 1 && sim.Calls.Last().StartsWith("change CB#") && !Last(page, "reject").Contains("c1"), "exits pass: Anthony moves the agent's stop");
        P("{\"type\":\"flatten\",\"cid\":\"f1\",\"account\":\"Sim101\",\"root\":\"MNQ\"}");
        Check(sim.Calls.Last() == "flatten MNQ 12-26", "exits pass: Anthony's Flatten on the agent's account and root");
        // the trade closes at the target: realized dollars, the lock clears once flat by both readings
        Close(sim, mnq, 25003);
        string strip = Last(page, "agent");
        Check(strip.Contains("\"position\":null") && strip.Contains("\"pnlToday\":8") && strip.Contains("\"losses\":0") && strip.Contains("\"owns\":false"), "closed: 8 dollars, flat, the lock cleared: " + strip);
        Check(FileText("agent-manrae-day.txt").Contains("trade\t" + Tag(e) + "\t8"), "agent-manrae-day.txt keeps the trade");
        P("{\"type\":\"order\",\"cid\":\"p4\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":16}}");
        Order pageMnq;
        lock (sim.Orders) pageMnq = sim.Orders.LastOrDefault(o => o.Instrument == mnq && IsLive(o) && !ChartBridgeAgents.IsEntryName(o.Name));
        Check(pageMnq != null, "flat again: the page may enter Sim101 MNQ");
        A(Good(NewId()));
        Check(AgentReject().Contains("Sim101 MNQ has a position or a working order that is not agent manrae's"), "owner lock: the page's working entry refuses the agent (owned by anyone else)");
        Settle(sim);
        // a stop-limit entry: its limit, the name without a kind suffix
        id = NewId();
        e = PlacedNow(id, Plan(id, "MNQ", "sell", "stopLimit", "24999", 2, 10, 20, 300, ",\"limitPrice\":24998"));
        Check(e != null && e.OrderType == OrderType.StopLimit && e.StopPrice == 24999 && e.LimitPrice == 24998 && e.Quantity == 2 && Regex.IsMatch(e.Name, "^CB#[0-9a-f]{8} ag:manrae s10 t20$"),
              "a sell stop-limit, its limit 4 ticks below, qty 2: " + (e != null ? e.Name : AgentReject()));
        A("{\"type\":\"withdraw\",\"id\":\"" + id + "\",\"reason\":\"the setup broke (made up)\"}");
        Check(e != null && e.OrderState == OrderState.Cancelled && Answer().Contains("\"answer\":\"withdrawn\""), "withdraw: its unfilled entry cancelled, answer withdrawn");
        A("{\"type\":\"withdraw\",\"id\":\"" + id + "\",\"reason\":\"again\"}");
        Check(AgentReject().Contains("nothing to withdraw"), "withdraw twice: nothing to withdraw");
        Settle(sim);
    }

    // ------------------------------------------------------------ copilot: proposals open until the plan's own expiry
    static string Proposal() { return Last(page, "agentProposal"); }

    static void Copilot()
    {
        Mode("manrae", "copilot");
        int calls = sim.Calls.Count;
        string id = NewId();
        Last2();
        double at = clock + 150;
        A(Good(id));
        string pr = Proposal();
        Check(sim.Calls.Count == calls && Answer().Contains("\"answer\":\"proposed\"") && pr.Contains("\"state\":\"open\"") && pr.Contains("\"account\":\"Sim101\",\"sim\":true") &&
              pr.Contains("\"expiresAt\":" + (at + 600000).ToString("0", CultureInfo.InvariantCulture)) && Last(page, "agentPlan").Contains("\"result\":\"proposed\""),
              "copilot: a proposal (answer proposed), open until the plan's expiry, nothing placed: " + pr);
        A(Plan(NewId(), "NQ", "buy", "limit", "24999", 1, 8, 16, 600));
        Check(AgentReject().Contains("one at a time: agent manrae already has an open proposal"), "check 8: an open proposal refuses the next plan");
        P("{\"type\":\"agentSeen\",\"agent\":\"manrae\",\"id\":\"" + id + "\",\"at\":1791467200123}");
        Check(Proposal().Contains("\"seenAt\":1791467200123"), "agentSeen: recorded");
        P("{\"type\":\"agentAnswer\",\"cid\":\"a1\",\"agent\":\"manrae\",\"id\":\"" + id + "\",\"answer\":\"reject\",\"at\":1791467200200}");
        Check(Proposal().Contains("\"state\":\"rejected\"") && Answer().Contains("\"answer\":\"rejected\"") && sim.Calls.Count == calls, "reject: nothing placed, answer rejected");
        P("{\"type\":\"agentAnswer\",\"cid\":\"a2\",\"agent\":\"manrae\",\"id\":\"" + id + "\",\"answer\":\"accept\",\"at\":1791467200300}");
        Check(PageReject().Contains("is rejected; it can no longer be answered"), "an answered proposal cannot be answered again");
        // accept: placed from the proposal's own parameters, the time left
        id = NewId();
        Last2();
        A(Good(id));
        P("{\"type\":\"agentAnswer\",\"cid\":\"a3\",\"agent\":\"manrae\",\"id\":\"" + id + "\",\"answer\":\"accept\",\"at\":1791467200400,\"price\":1}");
        Check(PageReject().Contains("unknown key \\\"price\\\" in agentAnswer"), "agentAnswer takes no order field");
        P("{\"type\":\"agentAnswer\",\"cid\":\"a3\",\"agent\":\"manrae\",\"id\":\"" + id + "\",\"answer\":\"accept\",\"at\":1791467200400}");
        Order e = Entry(sim);
        Check(e != null && IsLive(e) && e.LimitPrice == 24999 && Proposal().Contains("\"state\":\"accepted\"") && Any(agentOut, 0, "\"id\":\"" + id + "\",\"answer\":\"accepted\"") && Answer().Contains("\"answer\":\"placed\""),
              "accept: placed from the proposal's parameters; answers accepted, then placed");
        A("{\"type\":\"withdraw\",\"id\":\"" + id + "\",\"reason\":\"changed its mind (made up)\"}");
        Check(e != null && e.OrderState == OrderState.Cancelled && Proposal().Contains("\"state\":\"withdrawn\"") && Answer().Contains("\"answer\":\"withdrawn\""), "withdraw after accept: the unfilled entry cancelled, state withdrawn");
        Settle(sim);
        // withdraw an open proposal
        id = NewId();
        A(Good(id));
        A("{\"type\":\"withdraw\",\"id\":\"" + id + "\",\"reason\":\"no longer valid (made up)\"}");
        Check(Proposal().Contains("\"state\":\"withdrawn\"") && Answer().Contains("\"answer\":\"withdrawn\""), "withdraw an open proposal: withdrawn");
        // expiry: an unanswered proposal ends at its plan's expiry, never placed
        id = NewId();
        calls = sim.Calls.Count;
        A(Plan(id, "MNQ", "buy", "limit", "24999", 1, 8, 16, 60));
        Advance(59000);
        Check(Proposal().Contains("\"state\":\"open\""), "still open before its expiry");
        A("{\"type\":\"beat\"}");
        Advance(1200);
        Check(Proposal().Contains("\"state\":\"expired\"") && Answer().Contains("\"answer\":\"expired\"") && sim.Calls.Count == calls, "at its expiry: expired, never placed");
        // accept with under 5 s left: refused as expired
        id = NewId();
        A(Plan(id, "MNQ", "buy", "limit", "24999", 1, 8, 16, 60));
        clock += 56000;
        A("{\"type\":\"beat\"}");
        P("{\"type\":\"agentAnswer\",\"cid\":\"a4\",\"agent\":\"manrae\",\"id\":\"" + id + "\",\"answer\":\"accept\",\"at\":1791467200500}");
        Check(PageReject().Contains("expired (under 5 s left): nothing placed") && Proposal().Contains("\"state\":\"expired\"") && Answer().Contains("\"answer\":\"expired\"") && sim.Calls.Count == calls,
              "accept with under 5 s left: refused as expired, nothing placed");
        // an accept that a check refuses at that moment: rejected, answer refused
        id = NewId();
        Last2();
        A(Good(id));
        SetPos(sim, mnq, -1);
        P("{\"type\":\"agentAnswer\",\"cid\":\"a5\",\"agent\":\"manrae\",\"id\":\"" + id + "\",\"answer\":\"accept\",\"at\":1791467200600}");
        Check(PageReject().Contains("accepted, but refused: Sim101 MNQ has a position") && Proposal().Contains("\"state\":\"rejected\"") && Answer().Contains("\"answer\":\"refused\"") && sim.Calls.Count == calls,
              "every check runs again at the accept: a position placed meanwhile refuses it");
        Settle(sim);
        // leaving copilot: open proposals not answered
        id = NewId();
        A(Good(id));
        Mode("manrae", "shadow");
        Check(Proposal().Contains("\"state\":\"not answered\"") && Answer().Contains("\"answer\":\"not answered\""), "leaving copilot: the open proposal is not answered");
        Mode("manrae", "auto");
    }

    // ------------------------------------------------------------ the expiry timer: ChartBridge's own clock, part fill too
    static void Expiry()
    {
        string id = NewId();
        Order e = PlacedNow(id, Plan(id, "MNQ", "buy", "limit", "24999", 2, 8, 16, 120));
        Check(e != null && FileText("agent-manrae-day.txt").Contains("entry\t" + Tag(e) + "\t"), "the entry's expiry is in agent-manrae-day.txt (a restart keeps the timer)");
        if (e == null) return;
        Fill(e, 1, 24999);
        Advance(119000);
        Check(IsLive(e), "part filled, before its expiry: still working");
        Advance(1500);
        Check(e.OrderState == OrderState.Cancelled && Legs(sim, e).Count(IsLive) == 2 && Answer().Contains("\"answer\":\"expired\"") && Answer().Contains("the 1 filled keep their stop and target"),
              "at its expiry the rest is cancelled; the filled one keeps its stop and target: " + Answer());
        Close(sim, mnq, 24997);
        Check(Last(page, "agent").Contains("\"losses\":1"), "closed at the stop: a losing trade");
    }

    // ------------------------------------------------------------ the window: entries and proposals end at entryUntil
    static void Window()
    {
        string id = NewId();
        Order e = PlacedNow(id, Plan(id, "MNQ", "buy", "limit", "24999", 1, 8, 16, 1800));
        Mode("manrae", "shadow"); Mode("manrae", "auto");   // leaving auto cancels it (lead's default): placed again below
        Check(e != null && e.OrderState == OrderState.Cancelled && Answer().Contains("the mode changed to shadow"), "leaving auto cancels the unfilled entry");
        et = new DateTime(2026, 10, 8, 14, 59, 0);
        id = NewId();
        e = PlacedNow(id, Plan(id, "MNQ", "buy", "limit", "24999", 1, 8, 16, 1800));
        Check(e != null && IsLive(e), "placed at 14:59 for 30 minutes");
        et = new DateTime(2026, 10, 8, 15, 0, 0);
        Advance(500);
        Check(e != null && e.OrderState == OrderState.Cancelled && Answer().Contains("outside the entry window (09:45 to 15:00)"), "at entryUntil ChartBridge cancels it, whatever its expiry: " + Answer());
        Mode("manrae", "copilot");
        et = new DateTime(2026, 10, 8, 14, 59, 0);
        id = NewId();
        A(Good(id));
        et = new DateTime(2026, 10, 8, 15, 0, 0);
        Advance(500);
        Check(Proposal().Contains("\"state\":\"expired\"") && Answer().Contains("the entry window closed at 15:00"), "at entryUntil an open proposal expires");
        Mode("manrae", "auto");
        et = new DateTime(2026, 10, 8, 10, 0, 0);
        Settle(sim);
    }

    // ------------------------------------------------------------ the heartbeat: 5 s of silence, a disconnect, no agent after a start
    static void Heartbeat()
    {
        string id = NewId();
        Order e = PlacedNow(id, Good(id));
        Fill(e, 1, 24999);
        string id2 = NewId();
        // a second entry is refused (one at a time); use a fresh trade instead: close and place again
        Close(sim, mnq, 24999);
        e = PlacedNow(id2, Good(id2));
        Check(e != null && IsLive(e), "a working entry before the silence");
        Silent(4000);
        Check(IsLive(e) && M.DiagJson().Contains("\"connected\":true"), "4 s of silence: nothing yet");
        Silent(1500);
        Check(e.OrderState == OrderState.Cancelled && M.DiagJson().Contains("\"connected\":false") && M.DiagJson().Contains("\"heartbeatLost\":1") &&
              Last(page, "status").Contains("Agent manrae: no message from agent manrae for 5 s (heartbeat lost): 1 unfilled entry cancelled"),
              "5 s of silence: the socket closed, the unfilled entry cancelled, the pages warned: " + Last(page, "status"));
        // reconnect; a position's stop and target are kept when it goes again
        ac = new ChartBridgeClient(null, -100);
        ac.Tap = s => { lock (agentOut) agentOut.Add(s); };
        Check(M.Attach(ac), "it reconnects");
        A("{\"type\":\"agentHello\",\"name\":\"Manrae\",\"build\":\"sample-build-1\"}");
        Check(Last(agentOut, "welcome").Contains("\"mode\":\"auto\""), "the mode is kept across a heartbeat loss (only a ChartBridge start puts it in shadow)");
        id = NewId();
        e = PlacedNow(id, Good(id));
        Fill(e, 1, 24999);
        Silent(5600);
        Check(Legs(sim, e).Count(IsLive) == 2 && PosOf(sim, mnq) == 1 && !sim.Calls.Any(c => c.Contains(" flat ")), "heartbeat lost with a position: its stop and target stay, nothing closed");
        Check(Last(page, "agent").Contains("\"owns\":true"), "and it still owns Sim101 MNQ");
    }

    // ------------------------------------------------------------ the flat time: ChartBridge flattens, the agent gone
    static void FlatTime()
    {
        // manrae is gone (Heartbeat), long 1 MNQ with its stop and target working
        Order e = Entry(sim);
        int calls = sim.Calls.Count, statuses = Count(page, "status");
        et = new DateTime(2026, 10, 8, 15, 54, 59);
        Advance(500);
        Check(sim.Calls.Count == calls, "15:54:59: nothing yet");
        et = new DateTime(2026, 10, 8, 15, 55, 0);
        Hold = (kind, o) => kind == "cancel";   // NinjaTrader has not confirmed the cancels yet
        Advance(500);
        List<string> sent = sim.Calls.Skip(calls).ToList();
        Check(sent.Count(c => c.StartsWith("cancel CB#")) == 2 && !sent.Any(c => c.StartsWith("submit")) && Any(page, statuses, "manrae flattened at 15:55 by its rules"),
              "15:55: every working order of the agent cancelled first, nothing else sent; status info to the pages: " + string.Join(" | ", sent));
        Advance(500);
        Check(!sim.Calls.Skip(calls).Any(c => c.StartsWith("submit")), "the close waits until NinjaTrader confirms the cancels");
        Hold = null;
        foreach (Order o in Legs(sim, e)) if (IsLive(o)) { o.OrderState = OrderState.Cancelled; Update(o); }
        Advance(500);
        Order close;
        lock (sim.Orders) close = sim.Orders.LastOrDefault(o => Regex.IsMatch(o.Name ?? "", "^CB#[0-9a-f]{8} ag:manrae flat$"));
        Check(close != null && close.OrderType == OrderType.Market && close.OrderAction == OrderAction.Sell && close.Quantity == 1, "then the position is closed at market, its size, named ag:manrae flat");
        if (close == null) return;
        Check(ChartBridgeV3.OrderBy(close) == ",\"by\":\"agent:manrae\"" && Last(page, "order").Contains("ag:manrae") == false && page.Any(x => x.StartsWith("{\"type\":\"order\"") && x.Contains("\"kind\":\"market\"") && x.Contains("\"by\":\"agent:manrae\"")),
              "the close says by agent:manrae on a v3 page");
        Advance(500);
        Check(sim.Calls.Count(c => c.Contains(" ag:manrae flat ")) == 1, "one close only while it works");
        Advance(10000);
        Check(Any(page, statuses, "Agent manrae: NOT FLAT") && Last(page, "status").Contains("\"level\":\"error\""), "not flat 10 s later: a status error to the pages");
        int errs = page.Count(x => x.Contains("NOT FLAT"));
        Advance(5000);
        Check(page.Count(x => x.Contains("NOT FLAT")) == errs, "not again within 10 s");
        Advance(5500);
        Check(page.Count(x => x.Contains("NOT FLAT")) == errs + 1, "again every 10 s until flat");
        close.OrderId = "NTF" + Guid.NewGuid().ToString("N").Substring(0, 6);
        close.Filled = 1; close.AverageFillPrice = 25001; close.OrderState = OrderState.Filled;
        Update(close);
        Deliver("Sim101", mnq, MarketPosition.Short, 1, 25001, close.OrderId);
        SetPos(sim, mnq, 0);
        ((System.Collections.IDictionary)typeof(ChartBridgeOrders).GetField("Moves", PS).GetValue(null)).Clear();
        Advance(500);
        errs = page.Count(x => x.Contains("NOT FLAT"));
        Advance(11000);
        Check(page.Count(x => x.Contains("NOT FLAT")) == errs && M.DiagJson().Contains("\"flattenedAt\":\"20") && Last(page, "agent").Contains("\"position\":null") && Last(page, "agent").Contains("\"owns\":false"),
              "flat: the errors stop; /diag flattenedAt; the strip flat");
        Check(FileText("agent-manrae.log").Contains("agent manrae flatten: sell 1 MNQ at market on Sim101"), "agent-manrae.log has the flatten");
        // the agent's own flatten: auto only, not killed
        et = new DateTime(2026, 10, 8, 10, 0, 0);
        ac = new ChartBridgeClient(null, -100);
        ac.Tap = s => { lock (agentOut) agentOut.Add(s); };
        M.Attach(ac);
        A("{\"type\":\"agentHello\",\"name\":\"Manrae\",\"build\":\"sample-build-1\"}");
        A("{\"type\":\"flatten\"}");
        Check(AgentReject().Contains("agent manrae has nothing to flatten"), "flatten with nothing held: refused");
        Mode("manrae", "copilot");
        A("{\"type\":\"flatten\"}");
        Check(AgentReject().Contains("flatten is for auto mode only"), "flatten in copilot: refused");
        Mode("manrae", "auto");
        Settle(sim);
    }

    // ------------------------------------------------------------ the rule set from the page; the hard ceiling
    static string Rules(string roots, string qty, string from, string until, string flat, int exp, int trades, int losses)
    {
        return "{\"type\":\"agentRules\",\"cid\":\"r\",\"agent\":\"manrae\",\"roots\":\"" + roots + "\"" + qty + ",\"entryFrom\":\"" + from + "\",\"entryUntil\":\"" + until + "\",\"flatAt\":\"" + flat +
               "\",\"maxExpireSec\":" + exp + ",\"maxTrades\":" + trades + ",\"maxLosses\":" + losses + "}";
    }

    static void RulesAndCeiling()
    {
        string file = Path.Combine(Dir, "agent-manrae-rules.txt");
        P(Rules("NQ,MNQ", ",\"maxQtyNQ\":3,\"maxQtyMNQ\":20", "09:45", "15:00", "15:55", 1800, 0, 0));
        Check(PageReject().Contains("maxQty for NQ must be from 1 to 2 (the hard ceiling)") && !File.Exists(file), "agentRules: maxQtyNQ 3 is over the hard ceiling: refused");
        P(Rules("NQ,MNQ", ",\"maxQtyNQ\":2,\"maxQtyMNQ\":21", "09:45", "15:00", "15:55", 1800, 0, 0));
        Check(PageReject().Contains("maxQty for MNQ must be from 1 to 20 (the hard ceiling)"), "agentRules: maxQtyMNQ 21: refused");
        P(Rules("MNQ", ",\"maxQtyMNQ\":5,\"maxQtyNQ\":2", "09:45", "15:00", "15:55", 1800, 0, 0));
        Check(PageReject().Contains("maxQtyNQ is for a root not in roots: send 0 or leave it out"), "agentRules: a size for a root not chosen is refused");
        P(Rules("MNQ", ",\"maxQtyMNQ\":0", "09:45", "15:00", "15:55", 1800, 0, 0));
        Check(PageReject().Contains("maxQty for MNQ must be from 1 to 20"), "agentRules: 0 for a chosen root is refused");
        P(Rules("YM", ",\"maxQtyNQ\":2", "09:45", "15:00", "15:55", 1800, 0, 0));
        Check(PageReject().Contains("YM is not a root an agent may trade"), "agentRules: a root with no ceiling: refused");
        foreach (string[] bad in new[] { new[] { "09:29", "15:00", "15:55", "entryFrom must be 09:30 or later" }, new[] { "15:00", "15:00", "15:55", "entryFrom must be before entryUntil" },
                                         new[] { "09:45", "15:00", "15:00", "flatAt must be after entryUntil" }, new[] { "09:45", "15:00", "16:00", "flatAt must be 15:59 at the latest" },
                                         new[] { "09:45", "15:00", "9:55", "HH:MM" } })
        {
            P(Rules("MNQ", ",\"maxQtyMNQ\":5", bad[0], bad[1], bad[2], 1800, 0, 0));
            Check(PageReject().Contains(bad[3]), "agentRules: " + bad[3]);
        }
        P(Rules("MNQ", ",\"maxQtyMNQ\":5", "09:45", "15:00", "15:55", 59, 0, 0));
        Check(PageReject().Contains("maxExpireSec must be from 60 to 1800"), "agentRules: maxExpireSec 59");
        P(Rules("MNQ", ",\"maxQtyMNQ\":5", "09:45", "15:00", "15:55", 1800, 51, 0));
        Check(PageReject().Contains("maxTrades must be none or 1 to 50"), "agentRules: maxTrades 51");
        P(Rules("MNQ", ",\"maxQtyMNQ\":5", "09:45", "15:00", "15:55", 1800, 0, 21));
        Check(PageReject().Contains("maxLosses must be none or 1 to 20"), "agentRules: maxLosses 21");
        int welcomes = Count(agentOut, "welcome");
        P(Rules("MNQ", ",\"maxQtyMNQ\":5", "10:00", "14:00", "15:30", 900, 3, 2));
        Check(Count(agentOut, "welcome") == welcomes + 1 && Last(agentOut, "welcome").Contains("\"rules\":{\"roots\":[\"MNQ\"],\"maxQty\":{\"MNQ\":5},\"entryFrom\":\"10:00\",\"entryUntil\":\"14:00\",\"flatAt\":\"15:30\",\"maxExpireSec\":900,\"maxTrades\":3,\"maxLosses\":2}"),
              "saved: the agent gets welcome again with the new rules: " + Last(agentOut, "welcome"));
        string text = FileText("agent-manrae-rules.txt");
        Check(text.StartsWith("#") && text.Contains("roots\tMNQ") && text.Contains("maxQty.MNQ\t5") && text.Contains("entryFrom\t10:00") && text.Contains("maxTrades\t3") && text.Contains("maxLosses\t2"), "agent-manrae-rules.txt written: " + text);
        Last2();
        A(Plan(NewId(), "MNQ", "buy", "limit", "24999", 6, 8, 16, 600));
        Check(AgentReject().Contains("qty must be a whole number from 1 to 5"), "the new maxQty holds");
        A(Plan(NewId(), "NQ", "buy", "limit", "24999", 1, 8, 16, 600));
        Check(AgentReject().Contains("NQ is not one of agent manrae's roots (MNQ)"), "the new roots hold");
        A(Plan(NewId(), "MNQ", "buy", "limit", "24999", 1, 8, 16, 901));
        Check(AgentReject().Contains("expireSec must be from 60 to 900"), "the new maxExpireSec holds");
        // maxTrades and maxLosses (check 9): manrae has 3 trades and 1 loss today already
        A(Good(NewId()));
        Check(Regex.IsMatch(AgentReject(), "agent manrae has made [3-9] trades today \\(maxTrades 3\\)"), "check 9: maxTrades reached: " + AgentReject());
        P(Rules("MNQ", ",\"maxQtyMNQ\":5,\"maxQtyNQ\":0", "09:45", "15:00", "15:55", 1800, 0, 1));
        A(Good(NewId()));
        Check(AgentReject().Contains("losing trades today (maxLosses 1)") && Last(page, "agent").Contains("\"standDown\":\"1 losing trades today (maxLosses 1)"), "check 9: maxLosses reached: stands down: " + AgentReject());
        // the hard ceiling is in the order path too: PlaceAgentEntry never sends more than the ceiling, whatever comes in
        P(Rules("NQ,MNQ", "", "09:45", "15:00", "15:55", 1800, 0, 0));
        Check(Last(agentOut, "welcome").Contains("\"maxQty\":{\"NQ\":2,\"MNQ\":20}"), "agentRules: a size left out for a chosen root is its hard ceiling");
        Order placed;
        int calls = sim.Calls.Count;
        string why = ChartBridgeOrders.PlaceAgentEntry("manrae", "{\"type\":\"order\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"limit\",\"qty\":21,\"price\":24999,\"bracket\":{\"stop\":8,\"target\":16}}", out placed);
        Check(why != null && why.Contains("qty 21 is over the MNQ cap of 20") && placed == null && sim.Calls.Count == calls, "the order path's own cap for an agent: the hard ceiling (20 MNQ): " + why);
        why = ChartBridgeOrders.PlaceAgentEntry("manrae", "{\"type\":\"order\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}}", out placed);
        Check(why != null && why.Contains("an agent's entry is a limit or a stop-limit with a stop and a target") && sim.Calls.Count == calls, "the order path refuses an agent market entry by itself");
        why = ChartBridgeOrders.PlaceAgentEntry("manrae", "{\"type\":\"order\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24999,\"bracket\":{\"stop\":0,\"target\":16}}", out placed);
        Check(why != null && why.Contains("every agent entry needs a stop and a target") && sim.Calls.Count == calls, "the order path refuses an agent entry with no stop by itself");
        why = ChartBridgeOrders.PlaceAgentEntry("manrae", "{\"type\":\"order\",\"account\":\"EVAL-A\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24999,\"bracket\":{\"stop\":8,\"target\":16}}", out placed);
        Check(why != null && why.Contains("agent manrae trades its own account Sim101 only") && eval.Calls.Count == 0, "the order path refuses an agent entry on another account by itself");
        Check(ChartBridgeAgents.HardCeiling("NQ") == 2 && ChartBridgeAgents.HardCeiling("ES") == 2 && ChartBridgeAgents.HardCeiling("MNQ") == 20 && ChartBridgeAgents.HardCeiling("MES") == 20 && ChartBridgeAgents.HardCeiling("YM") == 0,
              "the hard ceiling: minis 2, micros 20, nothing else");
        // a rules file over the ceiling cannot be understood: stands down, never written over
        File.WriteAllLines(file, new[] { "# made-up", "# test", "roots\tMNQ", "maxQty.MNQ\t25" });
    }

    // ------------------------------------------------------------ files that cannot be read: stand down, never written over
    static void Restart()
    {
        ChartBridgeAgents.Stop();
        ChartBridgeAgents.Start(false);
        ac = new ChartBridgeClient(null, -100);
        ac.Tap = s => { lock (agentOut) agentOut.Add(s); };
        M.Attach(ac);
        A("{\"type\":\"agentHello\",\"name\":\"Manrae\",\"build\":\"sample-build-1\"}");
    }

    static void FilesUnreadable()
    {
        string rules = Path.Combine(Dir, "agent-manrae-rules.txt");
        string before = FileText("agent-manrae-rules.txt");
        Restart();
        Check(Last(agentOut, "welcome").Contains("\"mode\":\"shadow\""), "every start puts the agent in shadow (auto never survives a restart)");
        Check(Last(agentOut, "agentState").Contains("\"standDown\":\"agent-manrae-rules.txt: maxQty for MNQ must be from 1 to 20 (the hard ceiling): no new entries"), "a rules file over the ceiling: stands down: " + Last(agentOut, "agentState"));
        Mode("manrae", "auto");
        Last2();
        A(Good(NewId()));
        Check(AgentReject().Contains("agent-manrae-rules.txt") && FileText("agent-manrae-rules.txt") == before, "check 2: a plan refused; the file is never written over");
        File.WriteAllText(rules, "# made-up\n# test\nroots\tMNQ\nwhatever\tthing\n");
        Restart();
        Check(Last(agentOut, "agentState").Contains("agent-manrae-rules.txt has a line ChartBridge does not understand"), "a line it does not know: stands down");
        P(Rules("NQ,MNQ", ",\"maxQtyNQ\":2,\"maxQtyMNQ\":20", "09:45", "15:00", "15:55", 1800, 0, 0));
        Check(Last(agentOut, "agentState").Contains("\"standDown\":null") && FileText("agent-manrae-rules.txt").Contains("maxQty.NQ\t2"), "the page sets the rules: written, the agent stands up");
        File.Delete(rules);
        // the account file
        string acct = Path.Combine(Dir, "agent-manrae-account.txt");
        File.WriteAllText(acct, "# made-up\n# test\naccount\tSim101\naccount\tSIM-D\n");
        Restart();
        Check(Last(agentOut, "agentState").Contains("agent-manrae-account.txt has a line ChartBridge does not understand"), "an account file it cannot understand: stands down");
        Mode("manrae", "auto");
        A(Good(NewId()));
        Check(AgentReject().Contains("agent-manrae-account.txt") && FileText("agent-manrae-account.txt") == "# made-up\n# test\naccount\tSim101\naccount\tSIM-D\n", "a plan refused; the account file never written over");
        File.Delete(acct);
        // the day file
        string day = Path.Combine(Dir, "agent-manrae-day.txt");
        string dayWas = FileText("agent-manrae-day.txt");
        File.WriteAllText(day, "# torn\nnonsense\n");
        Restart();
        Mode("manrae", "auto");
        A(Good(NewId()));
        Check(AgentReject().Contains("agent-manrae-day.txt has a line ChartBridge does not understand") && FileText("agent-manrae-day.txt") == "# torn\nnonsense\n", "a day file it cannot read: stands down this run, never written over");
        File.WriteAllText(day, dayWas);
        Restart();
        Mode("manrae", "auto");
        Check(Last(agentOut, "agentState").Contains("\"trades\":") && !Last(agentOut, "agentState").Contains("\"trades\":0"), "a restart remembers today's trades (agent-manrae-day.txt)");
        A(Good("plan-2"));
        Check(AgentReject().Contains("plan id plan-2 was already used today"), "a restart remembers today's plan ids");
    }

    // ------------------------------------------------------------ account exclusivity, every direction
    static string AccountMsg(string agent, string account) { return "{\"type\":\"agentAccount\",\"cid\":\"ac\",\"agent\":\"" + agent + "\",\"account\":\"" + account + "\"}"; }

    static void Exclusivity()
    {
        // another agent's account
        P(AccountMsg("manrae", "SIM-B"));
        Check(PageReject().Contains("SIM-B is agent demob's account: each agent has its own"), "agentAccount: another agent's account refused");
        // not tradable now
        P(AccountMsg("manrae", "SIM-X"));
        Check(PageReject().Contains("SIM-X is not in NinjaTrader"), "agentAccount: an account NinjaTrader does not have");
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, SIM-B, SIM-C, SIM-D");
        P(AccountMsg("manrae", "EVAL-A"));
        Check(PageReject().Contains("EVAL-A may not trade from the chart"), "agentAccount: an account not tradable now: " + PageReject());
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, EVAL-A, SIM-B, SIM-C, SIM-D");
        // the new account holds something on its roots
        SetPos(simd, mnq, 1);
        P(AccountMsg("manrae", "SIM-D"));
        Check(PageReject().Contains("SIM-D holds a position or a working order on MNQ"), "agentAccount: the new account holds a position on its roots");
        Settle(simd);
        // the old account holds something
        SetPos(sim, nq, 1);
        P(AccountMsg("manrae", "SIM-D"));
        Check(PageReject().Contains("agent manrae's account Sim101 holds a position or a working order on NQ"), "agentAccount: the old account holds a position on its roots");
        Settle(sim);
        // while it has a proposal
        Mode("manrae", "copilot");
        Last2();
        string id = NewId();
        A(Good(id));
        P(AccountMsg("manrae", "SIM-D"));
        Check(PageReject().Contains("agent manrae has a position, a working entry or a proposal: choose its account when it is flat"), "agentAccount: refused while a proposal is open");
        A("{\"type\":\"withdraw\",\"id\":\"" + id + "\",\"reason\":\"made up\"}");
        Mode("manrae", "auto");
        // EVAL-A, a LIVE account: accepted; welcome says so
        P(AccountMsg("manrae", "EVAL-A"));
        Check(M.Account == "EVAL-A" && Last(agentOut, "welcome").Contains("\"account\":\"EVAL-A\",\"sim\":false") && FileText("agent-manrae-account.txt").Contains("account\tEVAL-A"),
              "agentAccount EVAL-A (LIVE): saved in agent-manrae-account.txt, welcome again with sim false");
        Check(FileText("agent-manrae.log").Contains("account EVAL-A (LIVE), was Sim101, set by the page"), "logged with LIVE");
        // the bot: refuses an agent's account; an agent refuses the bot's
        ChartBridgeSwitches.Note("bot", "on");
        ChartBridgeBot.Start(false);
        P("{\"type\":\"botAccount\",\"cid\":\"b1\",\"account\":\"EVAL-A\"}");
        Check(PageReject().Contains("EVAL-A is agent manrae's account: the bot does not trade it"), "botAccount: an agent's account is refused: " + PageReject());
        P(AccountMsg("manrae", "Sim101"));
        Check(PageReject().Contains("Sim101 is the bot's account: an agent never trades it"), "agentAccount: the bot's account is refused");
        // a clash from files (both on Sim101 by default): the agent stands down, the bot is left as it was
        File.WriteAllLines(Path.Combine(Dir, "agent-manrae-account.txt"), new[] { "# made-up", "# test", "account\tSim101" });
        Restart();
        Check(Last(agentOut, "agentState").Contains("\"standDown\":\"Sim101 is also the bot's account: choose an account for agent manrae on the Agent tab"), "an agent on the bot's account (both Sim101 by default) stands down, in plain words: " + Last(agentOut, "agentState"));
        Mode("manrae", "auto");
        Check(PageReject().Contains("auto refused: Sim101 is also the bot's account"), "auto refused while it clashes");
        ChartBridgeBot.Stop(); ChartBridgeSwitches.Note("bot", "off");
        // the copier: refuses an agent's account as leader or follower (turning one off is allowed); an agent refuses its accounts
        ChartBridgeSwitches.Note("copier", "on");
        ChartBridgeCopier.HarnessManual = true;
        ChartBridgeCopier.Start();
        P("{\"type\":\"copierSet\",\"cid\":\"c1\",\"leader\":\"Sim101\",\"mode\":\"executions\"}");
        Check(PageReject().Contains("Sim101 is agent manrae's account: the copier does not trade it"), "copierSet: an agent's account as the leader is refused: " + PageReject());
        P("{\"type\":\"copierFollower\",\"cid\":\"c2\",\"account\":\"SIM-B\",\"on\":true,\"qty\":1,\"size\":\"micro\",\"lossLimit\":null}");
        Check(PageReject().Contains("SIM-B is agent demob's account: the copier does not trade it"), "copierFollower on: an agent's account is refused");
        P("{\"type\":\"copierFollower\",\"cid\":\"c3\",\"account\":\"SIM-B\",\"on\":false,\"qty\":1,\"size\":\"micro\",\"lossLimit\":null}");
        Check(PageReject().Contains("SIM-B is agent demob's account: the copier does not trade it") && D.AccountConflict() == null, "copierFollower off for an agent's account not listed: refused too (it would list it)");
        P("{\"type\":\"copierSet\",\"cid\":\"c4\",\"leader\":\"EVAL-A\",\"mode\":\"executions\"}");
        P("{\"type\":\"copierFollower\",\"cid\":\"c5\",\"account\":\"SIM-C\",\"on\":true,\"qty\":1,\"size\":\"micro\",\"lossLimit\":null}");
        P("{\"type\":\"copierFollower\",\"cid\":\"c6\",\"account\":\"SIM-D\",\"on\":false,\"qty\":1,\"size\":\"micro\",\"lossLimit\":null}");
        P(AccountMsg("manrae", "EVAL-A"));
        Check(PageReject().Contains("EVAL-A is the copier's leader: an agent never trades it"), "agentAccount: the copier's leader is refused");
        P(AccountMsg("manrae", "SIM-C"));
        Check(PageReject().Contains("SIM-C is a copier follower: an agent never trades it"), "agentAccount: a follower that is on is refused");
        P(AccountMsg("manrae", "SIM-D"));
        Check(PageReject().Contains("SIM-D is a copier follower: an agent never trades it"), "agentAccount: a follower that is off is refused too");
        P(AccountMsg("manrae", "SIM-B"));
        Check(PageReject().Contains("SIM-B is agent demob's account"), "agentAccount: demob's account refused");
        // demob takes a free account; manrae moves to SIM-B? no: back to Sim101 (the bot is off now)
        P(AccountMsg("manrae", "Sim101"));
        Mode("manrae", "auto");
        Check(M.Account == "Sim101" && Last(agentOut, "agentState").Contains("\"standDown\":null") && Last(agentOut, "agentState").Contains("\"mode\":\"auto\""), "with the bot off, Sim101 is manrae's: it stands up");
    }

    // ------------------------------------------------------------ the owner lock against the bot and another agent (one choke point)
    static void OwnerLockBotAndAgent()
    {
        Mode("manrae", "auto");
        string id = NewId();
        Order e = PlacedNow(id, Good(id));
        Fill(e, 1, 24999);
        Check(ChartBridgeAgents.OwnerAgent("Sim101", "MNQ") == "manrae", "manrae owns Sim101 MNQ");
        // the bot on Sim101 (a clash from files): its entry there is refused at PlaceOrderLocked
        ChartBridgeSwitches.Note("bot", "on");
        ChartBridgeBot.Start(false);
        Order placed;
        int calls = sim.Calls.Count;
        string why = ChartBridgeOrders.PlaceBotEntry("{\"type\":\"order\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}}", out placed);
        Check(why != null && why.Contains("Sim101 MNQ belongs to agent manrae until it is flat") && placed == null && sim.Calls.Count == calls, "owner lock: a bot entry on the agent's pair is refused: " + why);
        ChartBridgeBot.Stop(); ChartBridgeSwitches.Note("bot", "off");
        // another agent: demob is refused on manrae's pair (its own account only, and the lock)
        why = ChartBridgeAgents.EntryCheck("agent:demob", sim, "MNQ");
        Check(why != null && why.Contains("agent demob trades its own account SIM-B only"), "another agent never enters on manrae's account: " + why);
        why = ChartBridgeOrders.PlaceAgentEntry("demob", "{\"type\":\"order\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24999,\"bracket\":{\"stop\":8,\"target\":16}}", out placed);
        Check(why != null && placed == null && sim.Calls.Count == calls, "and its order path refuses it: " + why);
        why = ChartBridgeAgents.EntryCheck("page", sim, "MNQ");
        Check(why != null && why.Contains("belongs to agent manrae"), "EntryCheck for the page: refused");
        Check(ChartBridgeAgents.EntryCheck("page", sim, "NQ") == null && ChartBridgeAgents.EntryCheck("bot", simb, "MNQ") == null, "other roots and accounts are free");
        Close(sim, mnq, 24999);
        Check(ChartBridgeAgents.OwnerAgent("Sim101", "MNQ") == null, "flat by both readings, no entry: no owner");
    }

    // ------------------------------------------------------------ two agents at once, separate state
    static void TwoAgents()
    {
        dc = new ChartBridgeClient(null, -101);
        dc.Tap = s => { lock (demobOut) demobOut.Add(s); };
        Check(D.Attach(dc), "demob attaches while manrae is connected");
        B("{\"type\":\"agentHello\",\"name\":\"Demo B\",\"build\":\"sample-b\"}");
        Check(Last(demobOut, "welcome").Contains("\"agent\":\"demob\"") && Last(demobOut, "welcome").Contains("\"account\":\"SIM-B\""), "demob's welcome: its id, its account");
        P("{\"type\":\"agentMode\",\"cid\":\"d\",\"agent\":\"demob\",\"mode\":\"auto\"}");
        Check(D.DiagJson().Contains("\"mode\":\"auto\"") && M.DiagJson().Contains("\"mode\":\"auto\""), "modes are per agent");
        Mode("manrae", "shadow");
        Check(D.DiagJson().Contains("\"mode\":\"auto\"") && M.DiagJson().Contains("\"mode\":\"shadow\""), "changing manrae's mode leaves demob's");
        Last2();
        int calls = simb.Calls.Count, mcalls = sim.Calls.Count;
        B(Good("plan-1"));
        Order e = Entry(simb);
        Check(e != null && Regex.IsMatch(e.Name, "^CB#[0-9a-f]{8} ag:demob s8 t16$") && simb.Calls.Count == calls + 1 && sim.Calls.Count == mcalls, "demob places on its own account SIM-B (a plan id manrae used is new for demob)");
        A(Good(NewId()));
        Check(sim.Calls.Count == mcalls && Last(page, "agentPlan").Contains("\"agent\":\"manrae\"") && Last(page, "agentPlan").Contains("\"result\":\"shadow\""), "manrae in shadow places nothing at the same moment");
        Check(ChartBridgeAgents.OwnerAgent("SIM-B", "MNQ") == "demob" && ChartBridgeAgents.OwnerAgent("Sim101", "MNQ") == null, "each owns only its own pair");
        Check(Last(demobOut, "agentState").Contains("\"owns\":true") && !Any(agentOut, N(agentOut) - 3, "ag:demob"), "demob's orders go to demob only");
        // demob goes silent; manrae keeps beating
        for (int i = 0; i < 4; i++) { clock += 1500; M.OnMessage(ac, "{\"type\":\"beat\"}"); Tick(); }
        Check(D.DiagJson().Contains("\"connected\":false") && M.DiagJson().Contains("\"connected\":true") && e.OrderState == OrderState.Cancelled, "demob's heartbeat is its own: it is lost (entry cancelled), manrae is not");
        int pl = Count(page, "agentNote");
        A("{\"type\":\"note\",\"kind\":\"lesson\",\"text\":\"Sample lesson (made up)\"}");
        Check(Last(page, "agentNote").Contains("\"agent\":\"manrae\"") && Count(page, "agentNote") == pl + 1, "notes carry their agent");
        Check(ChartBridgeAgents.DiagJson().StartsWith("{\"manrae\":{\"connected\":true") && ChartBridgeAgents.DiagJson().Contains("\"demob\":{\"connected\":false"), "/diag agents: per id: " + ChartBridgeAgents.DiagJson());
        Mode("manrae", "auto");
        Settle(simb);
    }

    // ------------------------------------------------------------ the day: 18:00 ET
    static void DayRoll()
    {
        string s = Last(page, "agent");
        Check(!s.Contains("\"trades\":0"), "trades today before 18:00");
        et = new DateTime(2026, 10, 8, 17, 59, 59);
        Advance(500);
        Check(!Last(page, "agent").Contains("\"trades\":0,"), "17:59:59: still today");
        et = new DateTime(2026, 10, 8, 18, 0, 0);
        Advance(500);
        Check(Last(page, "agent").Contains("\"trades\":0,\"losses\":0") && Last(page, "agent").Contains("\"pnlToday\":0"), "18:00 ET: trades, losses and P&L start over");
        Check(FileText("agent-manrae-day.txt").Contains("session\t2026-10-09"), "the day file says the new session");
        et = new DateTime(2026, 10, 9, 10, 0, 0);
        Last2();
        A(Good("plan-2"));
        Check(Answer().Contains("\"id\":\"plan-2\",\"answer\":\"placed\"") && Entry(sim) != null && IsLive(Entry(sim)), "a plan id from yesterday is new today");
        Settle(sim);
    }

    // ------------------------------------------------------------ fills to The Desk carry "by" when ChartBridge knows the source
    static string DeskFill(string account, Instrument inst, string orderId)
    {
        return (string)typeof(ChartBridgeServer).GetMethod("DeskFillJson", PS).Invoke(null, new object[] { account, inst, MarketPosition.Long, 1, 25000.0, DateTime.Now, "E1", orderId });
    }

    static void FillsBy()
    {
        Last2();
        string id = NewId();
        Order e = PlacedNow(id, Good(id));
        Fill(e, 1, 24999);
        Order stop = Legs(sim, e).First(o => o.OrderType == OrderType.StopMarket);
        stop.OrderId = "NTS" + Guid.NewGuid().ToString("N").Substring(0, 6);
        string d1 = DeskFill("Sim101", mnq, e.OrderId), d2 = DeskFill("Sim101", mnq, stop.OrderId);
        Check(d1.EndsWith(",\"order_id\":\"" + e.OrderId + "\",\"by\":\"agent:manrae\"}") && d2.EndsWith(",\"by\":\"agent:manrae\"}"), "a fill of an agent's entry and of its stop: by agent:manrae: " + d1);
        Order pageOrder = sim.CreateOrder(nq, OrderAction.Buy, OrderType.Market, OrderEntry.Manual, TimeInForce.Day, 1, 0, 0, "", "CB#12345678 s8 t16", NinjaTrader.Core.Globals.MaxDate, null);
        pageOrder.OrderId = "NTP1"; lock (sim.Orders) sim.Orders.Add(pageOrder);
        Order botOrder = sim.CreateOrder(nq, OrderAction.Buy, OrderType.Market, OrderEntry.Manual, TimeInForce.Day, 1, 0, 0, "", "CB#22345678 bot s8 t16", NinjaTrader.Core.Globals.MaxDate, null);
        botOrder.OrderId = "NTB1"; lock (sim.Orders) sim.Orders.Add(botOrder);
        Order copyOrder = simc.CreateOrder(mnq, OrderAction.Buy, OrderType.Market, OrderEntry.Manual, TimeInForce.Day, 1, 0, 0, "", "CB#32345678 copy 12345678", NinjaTrader.Core.Globals.MaxDate, null);
        copyOrder.OrderId = "NTC1"; lock (simc.Orders) simc.Orders.Add(copyOrder);
        string dp = DeskFill("Sim101", nq, "NTP1"), dn = DeskFill("Sim101", nq, "NOPE");
        Check(dp == "{\"source\":\"nt8\",\"account\":\"Sim101\",\"instrument\":\"NQ 12-26\",\"root\":\"NQ\",\"side\":\"buy\",\"qty\":1,\"price\":25000,\"time_utc_ms\":" + dp.Split(new[] { "\"time_utc_ms\":" }, StringSplitOptions.None)[1].Split(',')[0] + ",\"exec_id\":\"E1\",\"order_id\":\"NTP1\"}" && !dn.Contains("\"by\""),
              "the page's fill and an unknown order: no by, the rest exactly as before: " + dp);
        Check(DeskFill("Sim101", nq, "NTB1").EndsWith(",\"by\":\"bot\"}") && DeskFill("SIM-C", mnq, "NTC1").EndsWith(",\"by\":\"copier\"}"), "a bot fill: by bot; a copier fill: by copier");
        Check(!Last(page, "exec").Contains("\"by\""), "the page's exec message is unchanged (no by)");
        pageOrder.OrderState = OrderState.Cancelled; botOrder.OrderState = OrderState.Cancelled; copyOrder.OrderState = OrderState.Cancelled;
        Close(sim, mnq, 24999);
    }

    // ------------------------------------------------------------ subscribe: answered as a page's; ticks
    static void SubscribeAndTicks()
    {
        int made;
        lock (NinjaTrader.Data.BarsRequest.Made) made = NinjaTrader.Data.BarsRequest.Made.Count;
        A("{\"type\":\"subscribe\",\"root\":\"MNQ\",\"days\":1,\"tickHours\":0}");
        int now;
        lock (NinjaTrader.Data.BarsRequest.Made) now = NinjaTrader.Data.BarsRequest.Made.Count;
        Check(now > made && ac.Root == "MNQ" && !ac.Ready && ChartBridgeAgents.Subscribed().Contains(ac), "subscribe: a page's load starts for the agent (history, ticks, ready)");
        int ticks = Count(agentOut, "tick");
        ChartBridgeAgents.OnTick("MNQ", "{\"type\":\"tick\",\"root\":\"MNQ\",\"p\":25001,\"v\":1}");
        ChartBridgeAgents.OnTick("NQ", "{\"type\":\"tick\",\"root\":\"NQ\",\"p\":25001,\"v\":1}");
        Check(Count(agentOut, "tick") == ticks + 1 && Last(agentOut, "tick").Contains("\"root\":\"NQ\""), "its subscribed root's trades come through the seam (as a page's); every other root's straight");
        A("{\"type\":\"subscribe\",\"root\":\"ZZ\"}");
        Check(AgentReject().Contains("ZZ is not served by ChartBridge"), "subscribe to a root not served: refused");
        A("{\"type\":\"subscribe\",\"root\":\"MNQ\",\"days\":\"5\"}");
        Check(AgentReject().Contains("whole numbers"), "subscribe: strict values");
        ac.Root = null;
    }

    // ------------------------------------------------------------ a page that signs in later: strips, open proposals, notes, plans
    static void Replay()
    {
        for (int i = 0; i < 205; i++) A("{\"type\":\"note\",\"kind\":\"look\",\"text\":\"look " + i + "\"}");
        for (int i = 0; i < 55; i++) A("{\"type\":\"skip\",\"id\":\"k" + i + "\",\"reason\":\"made up\"}");
        clock += 1100;
        Mode("manrae", "copilot");
        string id = NewId();
        Last2();
        A(Good(id));
        List<string> got = new List<string>();
        ChartBridgeClient late = new ChartBridgeClient(null, 602) { Origin = "http://localhost:8765" };
        late.Tap = s => { lock (got) got.Add(s); };
        Clients()[602] = late;
        OnClient(late, "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
        Check(!got.Any(x => x.StartsWith("{\"type\":\"agent")), "a v2 page (no client message) gets no agent message");
        OnClient(late, "{\"type\":\"client\",\"v\":3}");
        int notes = got.Count(x => x.StartsWith("{\"type\":\"agentNote\"")), plans = got.Count(x => x.StartsWith("{\"type\":\"agentPlan\""));
        Check(got.Any(x => x.StartsWith("{\"type\":\"agent\",\"agent\":\"manrae\"")) && got.Any(x => x.StartsWith("{\"type\":\"agent\",\"agent\":\"demob\"")), "sign-in: every agent's strip");
        Check(got.Any(x => x.StartsWith("{\"type\":\"agentProposal\"") && x.Contains("\"id\":\"" + id + "\"") && x.Contains("\"state\":\"open\"")), "sign-in: the open proposals");
        Check(notes >= 200 && got.Count(x => x.StartsWith("{\"type\":\"agentNote\"") && x.Contains("\"agent\":\"manrae\"")) == 200 && got.Any(x => x.Contains("\"look 204\"")) && !got.Any(x => x.Contains("\"look 4\"")),
              "sign-in: the last 200 notes of each agent (" + notes + ")");
        Check(got.Count(x => x.StartsWith("{\"type\":\"agentPlan\"") && x.Contains("\"agent\":\"manrae\"")) == 50, "sign-in: the last 50 plans of each agent (" + plans + ")");
        ChartBridgeClient gone;
        Clients().TryRemove(602, out gone);
        // the page's gates for agent messages
        ChartBridgeClient v2 = new ChartBridgeClient(null, 603) { Origin = "http://localhost:8765" };
        List<string> v2got = new List<string>();
        v2.Tap = s => { lock (v2got) v2got.Add(s); };
        OnClient(v2, "{\"type\":\"agentKill\",\"cid\":\"x\",\"agent\":\"manrae\",\"on\":true}");
        Check(Last(v2got, "reject").Contains("this connection may not trade"), "agent page messages need the signed-in own page");
        OnClient(v2, "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
        OnClient(v2, "{\"type\":\"agentKill\",\"cid\":\"x\",\"agent\":\"manrae\",\"on\":true}");
        Check(Last(v2got, "reject").Contains("agent messages are protocol v3"), "and a v3 page");
        P("{\"type\":\"agentKill\",\"cid\":\"x\",\"agent\":\"nobody\",\"on\":true}");
        Check(PageReject().Contains("there is no agent nobody"), "an unknown agent: refused");
        P("{\"type\":\"agentNope\",\"cid\":\"x\",\"agent\":\"manrae\"}");
        Check(PageReject().Contains("unknown message type agentNope"), "an unknown agent message: refused");
        P("{\"type\":\"agentKill\",\"cid\":\"x\",\"agent\":\"manrae\",\"on\":true,\"extra\":1}");
        Check(PageReject().Contains("unknown key \\\"extra\\\" in agentKill"), "strict keys from the page");
        for (int i = 0; i < 11; i++) OnClient(pc, "{\"type\":\"agentMode\",\"cid\":\"r" + i + "\",\"agent\":\"manrae\",\"mode\":\"copilot\"}");
        Check(PageReject().Contains("too many order actions"), "gate 7: 10 a second from the page");
        lock (pc.Actions) pc.Actions.Clear();
        A("{\"type\":\"withdraw\",\"id\":\"" + id + "\",\"reason\":\"made up\"}");
        Mode("manrae", "auto");
    }

    // ------------------------------------------------------------ recovery by name after a restart; the expiry survives
    static void Recovery()
    {
        Last2();
        string id = NewId();
        Order e = PlacedNow(id, Plan(id, "MNQ", "buy", "limit", "24999", 1, 8, 16, 600));
        if (e == null) { Check(false, "recovery: an entry was placed: " + AgentReject()); return; }
        // ChartBridge restarts (a recompile): every memory goes; the names and the files stay
        ChartBridgeOrders.Clear();
        ChartBridgeOrders.LoadPlansNow();
        Restart();
        Check(ChartBridgeAgents.AgentOf(e) == "manrae", "after a restart the entry is known as manrae's by its name");
        Mode("manrae", "auto");
        Advance(500);
        Check(IsLive(e), "its expiry came back from agent-manrae-day.txt: it keeps working");
        Fill(e, 1, 24999);
        List<Order> legs = Legs(sim, e);
        Check(legs.Count == 2 && legs.Any(o => o.StopPrice == 24997) && legs.Any(o => o.LimitPrice == 25003) && ChartBridgeV3.OrderBy(legs[0]).Contains("agent:manrae"),
              "a fill after the restart: its legs from the name's ticks (a v2 entry), by agent:manrae");
        Check(Last(page, "agent").Contains("\"owns\":true") && Last(page, "agent").Contains("\"position\":{\"root\":\"MNQ\""), "the trade is followed after the restart");
        Close(sim, mnq, 25003);
        // an entry whose expiry is not known after a restart is cancelled at once
        id = NewId();
        e = PlacedNow(id, Good(id));
        string day = Path.Combine(Dir, "agent-manrae-day.txt");
        File.WriteAllLines(day, File.ReadAllLines(day).Where(l => !l.StartsWith("entry\t")).ToArray());
        Restart();
        Advance(500);
        Check(e != null && e.OrderState == OrderState.Cancelled && Logged("its expiry is not known (ChartBridge restarted)"), "an entry with no expiry record after a restart: cancelled at once");
        // no agent connected for 5 s after a start: its unfilled entries are cancelled
        Mode("manrae", "auto");
        id = NewId();
        e = PlacedNow(id, Good(id));
        ChartBridgeAgents.Stop(); ChartBridgeAgents.Start(false);
        Advance(4000);
        Check(e != null && IsLive(e), "4 s after a start with no agent: still working");
        Advance(1500);
        Check(e != null && e.OrderState == OrderState.Cancelled, "5 s after a start with no agent connected: its unfilled entry is cancelled");
        // a resting agent entry recovered by its name alone (planned_brackets.txt gone)
        Restart();
        Mode("manrae", "auto");
        id = NewId();
        e = PlacedNow(id, Plan(id, "MNQ", "buy", "limit", "24999", 1, 6, 12, 600));
        ChartBridgeOrders.Clear();
        File.Delete(Path.Combine(Dir, "planned_brackets.txt"));
        ChartBridgeOrders.LoadPlansNow();
        Fill(e, 1, 24999);
        legs = Legs(sim, e);
        Check(legs.Count == 2 && legs.Any(o => o.StopPrice == 24997.5) && legs.Any(o => o.LimitPrice == 25002), "no planned_brackets.txt line: the name's ticks (s6 t12), never a guess");
        Close(sim, mnq, 25002);
    }

    // ------------------------------------------------------------ the owner lock against the copier (its Eligible asks the same)
    static void OwnerLockCopier()
    {
        // the copier on (Exclusivity): leader EVAL-A, SIM-C a follower that is on; SIM-D a follower turned on as a control
        P("{\"type\":\"copierFollower\",\"cid\":\"c7\",\"account\":\"SIM-D\",\"on\":true,\"qty\":1,\"size\":\"micro\",\"lossLimit\":null}");
        P("{\"type\":\"copierRearm\",\"cid\":\"c8\"}");
        // demob is made to name SIM-C (a file edit; the page would refuse it): it clashes and stands down, yet it holds a position
        // there from before (its day file's open trade and SIM-C's position): it owns SIM-C MNQ
        File.WriteAllLines(Path.Combine(Dir, "agent-demob-account.txt"), new[] { "# made-up", "# test", "account\tSIM-C" });
        File.WriteAllLines(Path.Combine(Dir, "agent-demob-day.txt"), new[] { "# made-up", "# test", "session\t2026-10-09", "trade\tabcdef12\topen" });
        SetPos(simc, mnq, 1);
        Restart();
        Check(ChartBridgeAgents.OwnerAgent("SIM-C", "MNQ") == "demob" && D.AccountConflict() != null, "demob owns SIM-C MNQ (an open trade and a position) and stands down (SIM-C is a follower)");
        int cCalls = simc.Calls.Count, dCalls = simd.Calls.Count;
        Last2();
        P("{\"type\":\"order\",\"cid\":\"L1\",\"account\":\"EVAL-A\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}}");
        Order lead;
        lock (eval.Orders) lead = eval.Orders.LastOrDefault(o => IsLive(o) && Regex.IsMatch(o.Name ?? "", "^CB#[0-9a-f]{8} s8 t16$"));
        Check(lead != null, "the leader's entry from the page: " + PageReject());
        if (lead == null) return;
        lead.OrderId = "NTL1"; lead.Filled = 1; lead.AverageFillPrice = 25000; lead.OrderState = OrderState.Filled;
        Update(lead);
        SetPos(eval, mnq, 1);
        Check(simc.Calls.Count == cCalls && !simc.Calls.Any(c => c.Contains(" copy ")), "owner lock: the copier sends nothing to SIM-C, which agent demob owns");
        Check(simd.Calls.Skip(dCalls).Any(c => c.Contains(" copy ")), "the control follower SIM-D got its copy (the copier ran)");
        Check(Logged("belongs to agent demob until it is flat"), "the copier's skip says why");
        Check(ChartBridgeAgents.EntryCheck("copier", simc, "MNQ").Contains("belongs to agent demob"), "EntryCheck for the copier: refused");
        Settle(eval); Settle(simc); Settle(simd);
    }
}
