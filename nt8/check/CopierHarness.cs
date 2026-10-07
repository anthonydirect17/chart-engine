// ChartBridge 0.4.0 copier engine on Mono (inside check:orders): Anthony's Sim test list run against the real
// ChartBridgeOrders.cs and ChartBridgeCopier.cs with stand-in accounts. The leader stops first; a follower stops first; both
// at once; a scale-out; a connection drop; a mass disconnect and Re-arm; a real (not Sim) follower refused; a follower at
// its position limit skipped; the daily loss option; the switch off (nothing copied, every copier message refused); orders
// mode and the sweep; the stop already traded; copier.txt and copier.log; /diag; a restart. Made-up accounts (Sim101 as the
// leader, SIM-F1 to SIM-F4, EVAL-A as a real account) and made-up prices; nothing here is market data.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript.AddOns;

public static class CopierHarness
{
    static Action<bool, string> Check;
    const BindingFlags PS = BindingFlags.NonPublic | BindingFlags.Static;
    static readonly List<string> sent = new List<string>(), v2sent = new List<string>();
    static ChartBridgeClient page, v2;
    static Instrument mnq, nq, mes, es;
    static Account lead, f1, f2, f3, f4, evalA;
    static string token;

    static System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient> Clients() { return (System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", PS).GetValue(null); }
    static Dictionary<string, Instrument> Named() { return (Dictionary<string, Instrument>)typeof(ChartBridgeServer).GetField("Instruments", PS).GetValue(null); }
    static bool Logged(string has) { lock (NinjaTrader.Code.Output.Lines) return NinjaTrader.Code.Output.Lines.Any(x => x.Contains(has)); }
    static string Last() { return sent.Count > 0 ? sent[sent.Count - 1] : ""; }
    static bool Rejected(string has) { return sent.Any(m => m.Contains("\"type\":\"reject\"") && m.Contains(has)); }
    static bool EventSaid(string action, string account, string has) { return sent.Any(m => m.StartsWith("{\"type\":\"copierEvent\"") && m.Contains("\"action\":\"" + action + "\"") && (account == null || m.Contains("\"account\":\"" + account + "\"")) && (has == null || m.Contains(has))); }
    static string State() { return sent.LastOrDefault(m => m.StartsWith("{\"type\":\"copier\",")) ?? ""; }
    static void Msg(string type, string json) { lock (page.Actions) page.Actions.Clear(); if (type == "client") ChartBridgeAccounts.OnMessage(page, type, json);   /* integration: the one v3 handshake (B2) */ else if (type.StartsWith("copier")) ChartBridgeCopier.OnMessage(page, type, json); else ChartBridgeOrders.OnMessage(page, type, json); }
    static void Update(Account a, Order o) { ChartBridgeOrders.OnOrderUpdate(a, new OrderEventArgs { Order = o }); }
    static void Fill(Account a, Order o, int filled, double avg) { o.Filled = filled; o.AverageFillPrice = avg; o.OrderState = filled >= o.Quantity ? OrderState.Filled : OrderState.PartFilled; Update(a, o); }
    static void Pos(Account a, Instrument inst, int signed)
    {
        a.Positions.RemoveAll(p => p.Instrument == inst);
        if (signed != 0) a.Positions.Add(new Position { Instrument = inst, MarketPosition = signed > 0 ? MarketPosition.Long : MarketPosition.Short, Quantity = Math.Abs(signed), AveragePrice = 25000 });
        ChartBridgeOrders.OnPositionUpdate(a, new PositionEventArgs { Position = new Position { Instrument = inst }, MarketPosition = signed > 0 ? MarketPosition.Long : signed < 0 ? MarketPosition.Short : MarketPosition.Flat, Quantity = Math.Abs(signed), AveragePrice = 25000 });
    }
    static List<string> After(Account a, int n) { return a.Calls.Skip(n).ToList(); }
    static Order LastOrder(Account a, string has) { return a.Orders.LastOrDefault(o => (o.Name ?? "").Contains(has)); }
    static Order LeaderStop() { return lead.Orders.LastOrDefault(o => Regex.IsMatch(o.Name ?? "", "^CB#[0-9a-f]{8} stop ") && ChartBridgeOrders.IsWorking(o.OrderState)); }
    static string Leader(string rest) { return "{\"type\":\"order\",\"cid\":\"L\",\"account\":\"Sim101\",\"root\":\"MNQ\"," + rest + "}"; }
    static string Follower(string account, string on, string qty, string size, string loss) { return "{\"type\":\"copierFollower\",\"cid\":\"f\",\"account\":\"" + account + "\",\"on\":" + on + ",\"qty\":" + qty + ",\"size\":\"" + size + "\",\"lossLimit\":" + loss + "}"; }
    static double Now() { return ChartBridgeTime.NowUtcMs(); }

    static Account NewAccount(string name, Provider provider)
    {
        Account a = new Account { Name = name, Connection = new Connection { Status = ConnectionStatus.Connected }, Provider = provider };
        Account.All.Add(a);
        ((Dictionary<Account, double>)typeof(ChartBridgeOrders).GetField("ConnectedSince", PS).GetValue(null))[a] = 0;   // steady
        return a;
    }

    // NinjaTrader confirms every cancel the copier sent to a since call n (each cancelled order's event, in order).
    static void ConfirmCancels(Account a, int n)
    {
        foreach (string c in After(a, n).Where(x => x.StartsWith("cancel ")).ToList())
        {
            string name = c.Substring(7);
            foreach (Order o in a.Orders.Where(o => o.Name == name && ChartBridgeOrders.IsWorking(o.OrderState)).ToList()) { o.OrderState = OrderState.Cancelled; Update(a, o); }
        }
    }
    // 0.4.3: the copier's close of a follower: NinjaTrader confirms the cancels since call n, then exactly one close was sent, of what.
    static bool ClosedAfterConfirm(Account a, int n, string sideAndQty) { ConfirmCancels(a, n); List<string> c = Closes(a, n); return c.Count == 1 && c[0].Contains(sideAndQty) && !After(a, n).Any(x => x.StartsWith("flatten")); }
    static List<string> Closes(Account a, int n) { return After(a, n).Where(x => x.StartsWith("submit ") && x.Contains(" copy out ")).ToList(); }

    static void Done(Account a) { foreach (Order o in a.Orders) if (o.OrderState != OrderState.Filled) o.OrderState = OrderState.Cancelled; }

    // Positions closed by hand here have no closing fill: every fill counts as booked (as NinjaTrader's position updates do).
    static void Booked() { ((System.Collections.IDictionary)typeof(ChartBridgeOrders).GetField("Moves", PS).GetValue(null)).Clear(); }

    // Every account flat and every order done, as after a trade; then a tick so the copier forgets the copies.
    static void Reset()
    {
        foreach (Account a in new[] { lead, f1, f2, f3, f4 }) { Done(a); foreach (Instrument i in new[] { mnq, nq }) Pos(a, i, 0); }
        Booked();
        ChartBridgeCopier.Tick(Now());
    }

    // A leader market entry of qty with an 8 tick stop and a 16 tick target, filled at 25000.
    static Order LeaderEntry(int qty)
    {
        ChartBridgeOrders.NoteLast("MNQ", 25000); ChartBridgeOrders.NoteLast("NQ", 25000);
        Msg("order", Leader("\"side\":\"buy\",\"kind\":\"market\",\"qty\":" + qty + ",\"bracket\":{\"stop\":8,\"target\":16}"));
        Order e = lead.Orders.Last();
        Fill(lead, e, qty, 25000);
        Pos(lead, mnq, qty);
        return e;
    }

    // Each follower's copier entry filled at price, and its position updated.
    static void FollowerFill(Account a, Instrument inst, double price)
    {
        Order o = a.Orders.LastOrDefault(x => Regex.IsMatch(x.Name ?? "", "^CB#[0-9a-f]{8} copy [0-9a-f]{8}$") && ChartBridgeOrders.IsWorking(x.OrderState));
        if (o == null) { Check(false, a.Name + ": a copier entry to fill"); return; }
        Fill(a, o, o.Quantity, price);
        Pos(a, inst, (ChartBridgeOrders.CopierIsBuy(o) ? 1 : -1) * o.Quantity + a.Positions.Where(p => p.Instrument == inst).Sum(p => p.MarketPosition == MarketPosition.Long ? p.Quantity : -p.Quantity));
    }

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        List<Account> accountsWas = Account.All.ToList();
        Dictionary<string, Instrument> instWas = new Dictionary<string, Instrument>(Named());
        string dirWas = NinjaTrader.Core.Globals.UserDataDir;
        string home = Path.Combine(Path.GetTempPath(), "cb-copier-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(home, "ChartBridge"));
        try
        {
            NinjaTrader.Core.Globals.UserDataDir = home;
            Account.All.Clear();
            ChartBridgeOrders.Clear();
            ChartBridgeOrders.LoadPlansNow();
            mnq = new Instrument { FullName = "MNQ 12-26", MasterInstrument = new MasterInstrument { Name = "MNQ", TickSize = 0.25, PointValue = 2 } };
            nq = new Instrument { FullName = "NQ 12-26", MasterInstrument = new MasterInstrument { Name = "NQ", TickSize = 0.25, PointValue = 20 } };
            mes = new Instrument { FullName = "MES 12-26", MasterInstrument = new MasterInstrument { Name = "MES", TickSize = 0.25, PointValue = 5 } };
            es = new Instrument { FullName = "ES 12-26", MasterInstrument = new MasterInstrument { Name = "ES", TickSize = 0.25, PointValue = 50 } };
            Named().Clear(); Named()["MNQ"] = mnq; Named()["NQ"] = nq; Named()["MES"] = mes; Named()["ES"] = es;
            lead = NewAccount("Sim101", Provider.Simulator);
            f1 = NewAccount("SIM-F1", Provider.Simulator); f2 = NewAccount("SIM-F2", Provider.Simulator);
            f3 = NewAccount("SIM-F3", Provider.Simulator); f4 = NewAccount("SIM-F4", Provider.Simulator);
            evalA = NewAccount("EVAL-A", Provider.Rithmic);
            ChartBridgeOrders.ResetConfig();
            ChartBridgeOrders.ReadConfig("trading", "true");
            ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, SIM-F1, SIM-F2, SIM-F3, SIM-F4, EVAL-A");
            ChartBridgeOrders.ReadConfig("maxQty.MNQ", "10");
            ChartBridgeOrders.ReadConfig("maxQty.NQ", "3");
            ChartBridgeOrders.NewToken();
            token = ChartBridgeOrders.SessionJson().Split('"')[3];
            page = new ChartBridgeClient(null, 91) { Origin = "http://localhost:8765" };
            page.Tap = s => { lock (sent) sent.Add(s); };
            v2 = new ChartBridgeClient(null, 92) { Origin = "http://localhost:8765" };
            v2.Tap = s => { lock (v2sent) v2sent.Add(s); };
            Clients()[91] = page; Clients()[92] = v2;   // integration: the shared v3 send goes to ChartBridge's own list of pages
            ChartBridgeCopier.HarnessManual = true;
            foreach (Account a in Account.All) foreach (Instrument i in new[] { mnq, nq }) Pos(a, i, 0);   // positions known from the start

            SwitchOff();
            SwitchOnAndSettings();
            LeaderStopsFirst();
            FollowerStopsFirst();
            BothAtOnce();
            WorkShortOne();    // 0.4.3: WORK 2026-10-07, a follower's own stop filled while NinjaTrader's Flatten closed it: short 1
            CloseNotOut();     // 0.4.3 review: a close that does not go out is retried; nothing new copied meanwhile; a fill never noted
            SecondReview();    // 0.4.3 second review: owed until flat, a late closing fill, the other side, a refused order
            FixedQuantity();   // 0.4.3: Anthony 2026-10-07, a fixed quantity per leader entry
            ScaleOut();
            ScaleOutSmallFollower();   // 0.4.3: Anthony 2026-10-07, the same share with no minimum cut
            StopAlreadyTraded();
            ShortsAndContracts();
            RealFollowerAllowed();
            PositionLimit();
            DailyLoss();
            ConnectionDrop();
            MassDisconnect();
            OrdersModeAndSweep();
            NoLeader();   // 0.4.3: "leader": null (the page's "none")
            DiagAndPages();
            Review2();   // review 2 (0.4.0): late fills, the scale-out share, stops in step, the sweep, a copy recovered without its leader
            FilesAndRestart();
            RecoveredWithoutLeader();   // review 2 finding 6
            CopierThread();
        }
        catch (Exception ex) { Check(false, "copier harness threw: " + ex); }
        finally
        {
            ChartBridgeCopier.HarnessQueued = null;
            ChartBridgeCopier.Stop();
            ChartBridgeClient gone; Clients().TryRemove(91, out gone); Clients().TryRemove(92, out gone);
            ChartBridgeCopier.HarnessManual = false;
            ChartBridgeCopier.ResetConfig();
            ChartBridgeCopier.ReadFault = null; ChartBridgeCopier.WriteFault = null;
            ChartBridgeOrders.ResetConfig();
            ChartBridgeOrders.Clear();
            Account.All.Clear(); Account.All.AddRange(accountsWas);
            Named().Clear(); foreach (KeyValuePair<string, Instrument> kv in instWas) Named()[kv.Key] = kv.Value;
            NinjaTrader.Core.Globals.UserDataDir = dirWas;
        }
    }

    // ------------------------------------------------------------ the switch off: exactly 0.3.8 (nothing copied, messages refused)
    static void SwitchOff()
    {
        ChartBridgeCopier.ResetConfig();
        ChartBridgeSwitches.Note("copier", "off");   // integration: ChartBridgeConfig.Load records every v3 switch in ChartBridgeSwitches
        Check(!ChartBridgeCopier.Enabled && !ChartBridgeV3.Copier && ChartBridgeCopier.ReadConfig("copier", "on") && !ChartBridgeCopier.Enabled,
              "copier = off: off (one source of truth: ChartBridgeSwitches; the copier's own key reader only takes the key)");
        ChartBridgeSwitches.Note("copier", "yes please");
        Check(!ChartBridgeCopier.Enabled && Logged("copier = yes please is not off or on, so copier is OFF"), "copier = neither off nor on: off, with one Output line naming the value");
        ChartBridgeSwitches.Reset();   // what ChartBridgeConfig.Load starts from
        ChartBridgeCopier.ResetConfig();
        Check(ChartBridgeCopier.Enabled && ChartBridgeV3.SwitchesJson().Contains("\"copier\":true"), "copier is ON by default (Anthony 2026-10-07: no switches)");
        OrdersHarness.AllOffLines();   // the off line: 0.3.8 exactly, below
        Check(!ChartBridgeCopier.Enabled, "copier = off: off");
        ChartBridgeCopier.Start();
        Msg("client", "{\"type\":\"client\",\"v\":3}");
        Msg("auth", "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
        Check(page.Trader && State().Contains("\"enabled\":false"), "switch off: a v3 page is told the copier is off after auth");
        foreach (string m in new[] { "{\"type\":\"copierGet\",\"cid\":\"g\"}", "{\"type\":\"copierSet\",\"cid\":\"s\",\"leader\":\"Sim101\"}", Follower("SIM-F1", "true", "3", "micro", "null"), "{\"type\":\"copierRearm\",\"cid\":\"r\"}" })
        {
            sent.Clear();
            Msg(Regex.Match(m, "\"type\":\"(\\w+)\"").Groups[1].Value, m);
            Check(Rejected("The copier is off (copier = off in config.txt)."), "switch off: refused: " + m);
        }
        Check(!File.Exists(Path.Combine(NinjaTrader.Core.Globals.UserDataDir, "ChartBridge", "copier.txt")), "switch off: no copier.txt written");
        int n1 = f1.Calls.Count;
        sent.Clear();
        Msg("order", Leader("\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(!Rejected("needs a stop") && lead.Calls.Count > 0 && lead.Calls.Last().Contains("Buy Market 1"), "switch off: a leader entry with no stop is sent as in 0.3.8");
        Fill(lead, lead.Orders.Last(), 1, 25000);
        Pos(lead, mnq, 1);
        Pos(lead, mnq, 0);
        Booked();
        ChartBridgeCopier.Tick(Now());
        Check(f1.Calls.Count == n1 && f2.Calls.Count == 0 && !sent.Any(m => m.Contains("copierEvent")), "switch off: nothing copied, no copier message");
        ChartBridgeCopier.Stop();
        Done(lead);
    }

    // ------------------------------------------------------------ on: stood down at start, the settings, strict messages, Re-arm
    static void SwitchOnAndSettings()
    {
        ChartBridgeSwitches.Note("copier", "on");
        Check(ChartBridgeCopier.Enabled && ChartBridgeV3.SwitchesJson().Contains("\"copier\":true"), "copier = on: on (trading.switches.copier says the same)");
        ChartBridgeCopier.Start();
        Msg("client", "{\"type\":\"client\",\"v\":3}");
        sent.Clear();
        Msg("copierGet", "{\"type\":\"copierGet\",\"cid\":\"g\"}");
        Check(Last().StartsWith("{\"type\":\"copier\",\"enabled\":true,\"simOnly\":false,\"armed\":false,\"standDownWhy\":\"ChartBridge started: check the accounts and press Re-arm\""), "on: the copier starts stood down: " + Last());
        sent.Clear(); Msg("copierRearm", "{\"type\":\"copierRearm\"}");
        Check(Rejected("No leader is set."), "Re-arm with no leader: refused");
        ChartBridgeClient other = new ChartBridgeClient(null, 93) { Origin = "http://localhost:8765" };
        List<string> otherSent = new List<string>();
        other.Tap = s => otherSent.Add(s);
        ChartBridgeOrders.OnMessage(other, "auth", "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
        ChartBridgeCopier.OnMessage(other, "copierGet", "{\"type\":\"copierGet\"}");
        Check(otherSent.Any(m => m.Contains("\"type\":\"reject\"") && m.Contains("protocol v3")), "a page that never sent client v3: copier messages refused");
        ChartBridgeClient evil = new ChartBridgeClient(null, 94) { Origin = "https://evil.example" };
        List<string> evilSent = new List<string>();
        evil.Tap = s => evilSent.Add(s);
        ChartBridgeAccounts.OnMessage(evil, "client", "{\"type\":\"client\",\"v\":3}");
        ChartBridgeCopier.OnMessage(evil, "copierSet", "{\"type\":\"copierSet\",\"leader\":\"Sim101\"}");
        Check(evilSent.Any(m => m.Contains("may not trade")), "another origin: copier messages refused (gate 4)");
        sent.Clear(); Msg("client", "{\"type\":\"client\",\"v\":2}");
        Check(Last().Contains("\"level\":\"warn\"") && Last().Contains("v must be 3"), "client v 2: a status warn");

        sent.Clear();
        Msg("copierSet", "{\"type\":\"copierSet\",\"cid\":\"s\"}"); Check(Rejected("copierSet needs leader or mode."), "copierSet with neither: refused");
        Msg("copierSet", "{\"type\":\"copierSet\",\"leader\":\"Sim101\",\"leaderr\":\"x\"}"); Check(Rejected("unknown key \\\"leaderr\\\""), "copierSet unknown key: refused");
        Msg("copierSet", "{\"type\":\"copierSet\",\"leader\":\"Sim101\",\"leader\":\"SIM-F1\"}"); Check(Rejected("key twice"), "copierSet key twice: refused");
        Msg("copierSet", "{\"type\":\"copierSet\",\"mode\":\"fast\"}"); Check(Rejected("mode must be executions or orders."), "copierSet bad mode: refused");
        Msg("copierSet", "{\"type\":\"copierSet\",\"leader\":\"NOPE\"}"); Check(Rejected("No account NOPE."), "copierSet unknown account: refused");
        Msg("copierSet", "{\"type\":\"copierSet\",\"leader\":\"Sim\\u0031\"}"); Check(Rejected("escape"), "copierSet with an escape: refused");
        sent.Clear();
        Msg("copierSet", "{\"type\":\"copierSet\",\"cid\":\"s\",\"leader\":\"Sim101\",\"mode\":\"executions\"}");
        Check(!Rejected("") && State().Contains("\"leader\":{\"account\":\"Sim101\",\"connection\":\"connected\""), "copierSet leader Sim101: set and told: " + State());

        sent.Clear();
        Msg("copierFollower", Follower("EVAL-A", "false", "1", "micro", "null"));
        Check(!Rejected("") && State().Contains("{\"account\":\"EVAL-A\",\"sim\":false,\"on\":false"),
              "a real account as a follower: accepted (Anthony 2026-10-07: no Sim lock), shown with sim false: " + State());
        Msg("copierFollower", "{\"type\":\"copierFollower\",\"account\":\"SIM-F1\",\"on\":true,\"qty\":3,\"size\":\"micro\"}"); Check(Rejected("copierFollower needs lossLimit."), "copierFollower missing a key: refused");
        Msg("copierFollower", Follower("SIM-F1", "true", "10", "micro", "null")); Check(Rejected("qty must be a whole number from 1 to 9."), "qty 10: refused");
        Msg("copierFollower", Follower("SIM-F1", "true", "\"3\"", "micro", "null")); Check(Rejected("qty must be a whole number from 1 to 9."), "qty as a string: refused");
        Msg("copierFollower", Follower("SIM-F1", "\"true\"", "3", "micro", "null")); Check(Rejected("on must be true or false."), "on as a string: refused");
        Msg("copierFollower", Follower("SIM-F1", "true", "3", "big", "null")); Check(Rejected("size must be micro or mini."), "bad size: refused");
        Msg("copierFollower", Follower("SIM-F1", "true", "3", "micro", "0")); Check(Rejected("lossLimit must be whole dollars of 1 or more, or null for off."), "lossLimit 0: refused");
        Msg("copierFollower", Follower("SIM-F1", "true", "3", "micro", "12.5")); Check(Rejected("lossLimit must be whole dollars"), "lossLimit with cents: refused");
        Msg("copierFollower", Follower("Sim101", "true", "3", "micro", "null")); Check(Rejected("Sim101 is the leader; it cannot be a follower."), "the leader as a follower: refused");
        sent.Clear();
        Msg("copierFollower", Follower("SIM-F1", "true", "3", "micro", "null"));
        Msg("copierFollower", Follower("SIM-F2", "true", "1", "mini", "500"));
        Msg("copierFollower", Follower("SIM-F3", "true", "1", "micro", "null"));
        Msg("copierFollower", Follower("SIM-F4", "false", "1", "micro", "null"));
        Check(!Rejected("") && State().Contains("{\"account\":\"SIM-F1\",\"sim\":true,\"on\":true,\"qty\":3,\"size\":\"micro\",\"root\":\"MNQ\"") &&
              State().Contains("{\"account\":\"SIM-F2\",\"sim\":true,\"on\":true,\"qty\":1,\"size\":\"mini\",\"root\":\"NQ\"") && State().Contains("\"lossLimit\":500"), "followers saved and told: " + State());
        Msg("copierSet", "{\"type\":\"copierSet\",\"leader\":\"SIM-F1\"}"); Check(Rejected("SIM-F1 is a follower; the leader cannot be one."), "a follower as the leader: refused");
        string file = File.ReadAllText(Path.Combine(NinjaTrader.Core.Globals.UserDataDir, "ChartBridge", "copier.txt"));
        Check(file.StartsWith("# ChartBridge copier (written by ChartBridge; do not edit)") && file.Contains("leader\tSim101") && file.Contains("mode\texecutions") &&
              file.Contains("follower\tSIM-F1\ton\t3\tmicro\t0") && file.Contains("follower\tSIM-F2\ton\t1\tmini\t500") && file.Contains("follower\tEVAL-A\toff\t1\tmicro\t0"), "copier.txt: leader, mode, one line per follower (the real account too)");

        // stood down: the leader's entries are not copied, and need no stop
        int n1 = f1.Calls.Count;
        sent.Clear();
        Msg("order", Leader("\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Fill(lead, lead.Orders.Last(), 1, 25000);
        Check(!Rejected("needs a stop") && f1.Calls.Count == n1, "stood down: a leader entry is not copied (and needs no stop)");
        Done(lead); Pos(lead, mnq, 1); Pos(lead, mnq, 0); Booked();
        ChartBridgeCopier.Tick(Now());

        sent.Clear();
        Msg("copierRearm", "{\"type\":\"copierRearm\",\"cid\":\"r\"}");
        Check(!Rejected("") && EventSaid("rearm", null, "Re-armed by the page") && State().Contains("\"armed\":true,\"standDownWhy\":null"), "Re-arm: armed");
        sent.Clear();
        Msg("order", Leader("\"side\":\"buy\",\"kind\":\"market\",\"qty\":1"));
        Check(Rejected("The copier needs a stop on every leader entry."), "armed with a follower on: a leader entry with no stop is refused");
        Msg("order", Leader("\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":0,\"target\":16}"));
        Check(Rejected("The copier needs a stop on every leader entry."), "armed: a leader entry with a target only is refused too");
    }

    // ------------------------------------------------------------ the leader stops first
    static void LeaderStopsFirst()
    {
        int a1 = f1.Calls.Count, a2 = f2.Calls.Count, a3 = f3.Calls.Count, a4 = f4.Calls.Count;
        sent.Clear();
        LeaderEntry(1);
        List<string> c1 = After(f1, a1), c2 = After(f2, a2), c3 = After(f3, a3);
        Check(c1.Count == 1 && Regex.IsMatch(c1[0], "^submit CB#[0-9a-f]{8} copy [0-9a-f]{8} Buy Market 3 "), "executions: SIM-F1 (3 micro) gets a market buy of 3 MNQ on the leader's fill: " + string.Join(" | ", c1));
        Check(c2.Count == 1 && c2[0].Contains("Buy Market 1") && f2.Orders.Last().Instrument == nq, "executions: SIM-F2 (1 mini) gets 1 NQ");
        Check(c3.Count == 1 && c3[0].Contains("Buy Market 1") && f3.Orders.Last().Instrument == mnq, "executions: SIM-F3 (1 micro) gets 1 MNQ");
        Check(After(f4, a4).Count == 0, "a follower that is off gets nothing");
        Check(EventSaid("enter", "SIM-F1", "\"leaderMs\":") && !EventSaid("enter", "SIM-F1", "\"leaderMs\":null"), "the enter decision carries leaderMs");
        Order ls = LeaderStop();
        Check(ls != null && ls.StopPrice == 24998, "the leader's stop is at 24998");
        FollowerFill(f1, mnq, 25000.5); FollowerFill(f2, nq, 25000); FollowerFill(f3, mnq, 24999.75);
        string s1 = After(f1, a1).Last();
        Check(Regex.IsMatch(s1, "^submit CB#[0-9a-f]{8} stop f3 q3 p25000.5 Sell StopMarket 3 L0 S24998 oco:$"), "SIM-F1's fill gets its own stop at the leader's stop price 24998 at once: " + s1);
        Check(After(f2, a2).Last().Contains("Sell StopMarket 1 L0 S24998") && After(f3, a3).Last().Contains("Sell StopMarket 1 L0 S24998"), "SIM-F2 and SIM-F3: stops at 24998 too");
        Check(EventSaid("stop", "SIM-F1", "\"slippageTicks\":2") && EventSaid("stop", "SIM-F3", "\"slippageTicks\":-1") && EventSaid("stop", "SIM-F1", "\"fillMs\":"), "slippage per follower in ticks, worse positive (2, -1), with fillMs");
        Check(State().Contains("\"slippageTicks\":2") && State().Contains("\"position\":{\"qty\":3"), "the copier message shows slippage and the follower's position");
        Check(f1.Orders.Last().OrderType == OrderType.StopMarket && f1.Orders.Last().Oco == "", "the follower's stop is a lone stop order at the broker");

        // the leader's stop moves (a drag, breakeven): each follower stop moves to the same price
        int m1 = f1.Calls.Count, m2 = f2.Calls.Count;
        ls.StopPrice = 24999.5; Update(lead, ls);
        Check(After(f1, m1).Count == 1 && After(f1, m1)[0].Contains("S24999.5") && After(f1, m1)[0].StartsWith("change ") && After(f2, m2).Any(x => x.Contains("S24999.5")), "the leader's stop moved to 24999.5: the followers' stops move to the same price");
        foreach (Account a in new[] { f1, f2, f3 }) { Order s = a.Orders.Last(); s.StopPrice = 24999.5; Update(a, s); }
        int m3 = f1.Calls.Count;
        Update(lead, ls);
        Check(f1.Calls.Count == m3, "the same leader stop price again: nothing sent");

        // the leader's stop fills: the leader is flat: every follower is closed (0.4.3: its working orders cancelled first, then,
        // once NinjaTrader confirms, what it still holds at market; never NinjaTrader's Flatten)
        int b1 = f1.Calls.Count, b2 = f2.Calls.Count, b3 = f3.Calls.Count;
        Fill(lead, ls, 1, 24999.5);
        Pos(lead, mnq, 0);
        Func<Account, int, bool> oneCancel = (a, n) => After(a, n).Count == 1 && Regex.IsMatch(After(a, n)[0], "^cancel CB#[0-9a-f]{8} stop ");
        Check(oneCancel(f1, b1) && oneCancel(f2, b2) && oneCancel(f3, b3),
              "the leader stops first: each follower's own copier stop is cancelled first; nothing is closed before NinjaTrader confirms: " + string.Join(" | ", After(f1, b1)));
        ConfirmCancels(f1, b1); ConfirmCancels(f2, b2); ConfirmCancels(f3, b3);
        Check(Closes(f1, b1).Count == 1 && Closes(f1, b1)[0].Contains("Sell Market 3 ") && Closes(f2, b2).Count == 1 && Closes(f2, b2)[0].Contains("Sell Market 1 ") && f2.Orders.Last().Instrument == nq &&
              Closes(f3, b3).Count == 1 && Closes(f3, b3)[0].Contains("Sell Market 1 "), "...then each closes what it holds at market on its own contract (3 MNQ, 1 NQ, 1 MNQ), never an order sized from the leader");
        Check(EventSaid("flatten", "SIM-F1", "the leader is flat") && EventSaid("flatten", "SIM-F1", "closed the 3 it still held"), "flatten logged, with what it closed");
        Reset();
    }

    // ------------------------------------------------------------ a follower stops first
    static void FollowerStopsFirst()
    {
        int a1 = f1.Calls.Count;
        LeaderEntry(1);
        FollowerFill(f1, mnq, 25000); FollowerFill(f2, nq, 25000); FollowerFill(f3, mnq, 25000);
        Order s1 = f1.Orders.Last();
        Fill(f1, s1, 3, 24998);
        Pos(f1, mnq, 0);
        int b1 = f1.Calls.Count, b2 = f2.Calls.Count;
        Fill(lead, LeaderStop(), 1, 24998);
        Pos(lead, mnq, 0);
        Check(After(f1, b1).Count == 0, "a follower stops first: the leader's exit sends it nothing (a flat follower gets nothing)");
        Check(After(f2, b2).Count == 1 && After(f2, b2)[0].StartsWith("cancel "), "...while a follower still in has its stop cancelled first");
        ConfirmCancels(f2, b2);
        Check(Closes(f2, b2).Count == 1 && Closes(f2, b2)[0].Contains("Sell Market 1 "), "...and is then closed (1 NQ)");
        Reset();
    }

    // ------------------------------------------------------------ both at once
    static void BothAtOnce()
    {
        LeaderEntry(1);
        FollowerFill(f1, mnq, 25000); FollowerFill(f2, nq, 25000); FollowerFill(f3, mnq, 25000);
        // the leader's flat position lands while SIM-F1's own stop fill is still on its way
        int b1 = f1.Calls.Count;
        Fill(lead, LeaderStop(), 1, 24998);
        Pos(lead, mnq, 0);
        Order s1 = f1.Orders.Last(o => o.OrderType == OrderType.StopMarket);
        Fill(f1, s1, 3, 24998);
        Pos(f1, mnq, 0);
        List<string> c1 = After(f1, b1);
        Check(c1.Count == 1 && c1[0].StartsWith("cancel ") && Closes(f1, b1).Count == 0, "both at once: SIM-F1's stop is cancelled first; its own stop fill lands; the close reads both positions again and sends nothing (0.4.3: never NinjaTrader's Flatten, never an order sized from the leader): " + string.Join(" | ", c1));
        ChartBridgeCopier.Tick(Now()); ChartBridgeCopier.Tick(Now() + 5000);
        Check(f1.Calls.Count == b1 + 1, "both at once: nothing more is sent to the flat follower (no second close, no sweep of a done stop)");
        Reset();
    }

    // ------------------------------------------------------------ 0.4.3: WORK 2026-10-07 15:01 ET, short 1
    // The follower's stop sits at the leader's stop price, so both fill in the same instant. On WORK, NinjaTrader showed the
    // follower's stop filled a moment before its order event, the copier read the position (still the old one) and NinjaTrader's
    // Flatten closed 5 into what was by then a 4 lot: short 1. The copier never uses Flatten now; it closes only once every fill
    // there has come through, from both readings.
    static void WorkShortOne()
    {
        LeaderEntry(1);
        FollowerFill(f1, mnq, 25000); FollowerFill(f2, nq, 25000); FollowerFill(f3, mnq, 25000);
        Order s1 = f1.Orders.Last(o => o.OrderType == OrderType.StopMarket && ChartBridgeOrders.IsWorking(o.OrderState));
        Order s3 = f3.Orders.Last(o => o.OrderType == OrderType.StopMarket && ChartBridgeOrders.IsWorking(o.OrderState));
        int b1 = f1.Calls.Count, b2 = f2.Calls.Count, b3 = f3.Calls.Count;
        // SIM-F1's own stop (3) fills: NinjaTrader shows it on the order, its event and position update are still on their way
        s1.Filled = 3; s1.AverageFillPrice = 24998; s1.OrderState = OrderState.Filled;
        // SIM-F3's stop fills 1 of 1 too, same moment; SIM-F2's does not (it is still working when the leader is flat)
        s3.Filled = 1; s3.AverageFillPrice = 24998; s3.OrderState = OrderState.Filled;
        Fill(lead, LeaderStop(), 1, 24998);
        Pos(lead, mnq, 0);
        ChartBridgeCopier.Tick(Now());
        Check(!After(f1, b1).Concat(After(f2, b2)).Concat(After(f3, b3)).Any(x => x.StartsWith("flatten")), "0.4.3: never NinjaTrader's Flatten on a follower: " + string.Join(" | ", After(f1, b1).Concat(After(f2, b2))));
        Check(Closes(f1, b1).Count == 0 && Closes(f3, b3).Count == 0, "0.4.3: nothing is closed while a stop fill there has not come through its order event: " + string.Join(" | ", After(f1, b1)));
        Check(After(f2, b2).Count(x => x.StartsWith("cancel ")) == 1 && Closes(f2, b2).Count == 0, "0.4.3: SIM-F2: its working stop is cancelled first; the close waits for NinjaTrader to confirm: " + string.Join(" | ", After(f2, b2)));
        // the stop events arrive; their position updates are still on their way (the readings disagree: 3 and 0)
        Update(f1, s1); Update(f3, s3);
        Check(Closes(f1, b1).Count == 0 && Closes(f3, b3).Count == 0, "0.4.3: the fills have come through but the position updates have not: still nothing sent: " + string.Join(" | ", After(f1, b1)));
        Pos(f1, mnq, 0); Pos(f3, mnq, 0);
        Check(Closes(f1, b1).Count == 0 && Closes(f3, b3).Count == 0, "0.4.3: SIM-F1 and SIM-F3: their own stops took everything; the close reads both positions again and sends nothing (WORK: Flatten sold 5 into a 4 lot): " + string.Join(" | ", After(f1, b1)));
        Check(EventSaid("flatten", "SIM-F1", "flat now") && EventSaid("flatten", "SIM-F1", "nothing sent") && !Logged("opposite sides"), "0.4.3: logged: flat now (by one reading, its position update still on its way), nothing sent, no alarm");
        ConfirmCancels(f2, b2);
        List<string> c2 = Closes(f2, b2);
        Check(c2.Count == 1 && c2[0].Contains("Sell Market 1 "), "0.4.3: SIM-F2: once its stop cancel is confirmed, it closes the 1 it holds at market: " + string.Join(" | ", After(f2, b2)));
        Check(EventSaid("flatten", "SIM-F2", "closed the 1 it still held"), "0.4.3: the close is logged with its size");
        ChartBridgeCopier.Tick(Now()); ChartBridgeCopier.Tick(Now() + 5000);
        Check(Closes(f1, b1).Count == 0 && Closes(f2, b2).Count == 1, "0.4.3: nothing more afterwards");
        Reset();

        // a part of the stop: 2 of SIM-F1's 3 fill in the same instant; the close takes only the 1 left
        LeaderEntry(1);
        FollowerFill(f1, mnq, 25000); FollowerFill(f2, nq, 25000); FollowerFill(f3, mnq, 25000);
        s1 = f1.Orders.Last(o => o.OrderType == OrderType.StopMarket && ChartBridgeOrders.IsWorking(o.OrderState));
        b1 = f1.Calls.Count;
        s1.Filled = 2; s1.AverageFillPrice = 24998; s1.OrderState = OrderState.PartFilled;   // still working: the copier cancels the rest
        Fill(lead, LeaderStop(), 1, 24998);
        Pos(lead, mnq, 0);
        Check(Closes(f1, b1).Count == 0 && After(f1, b1).Any(x => x.StartsWith("cancel ")), "0.4.3: a part-filled stop is cancelled first, nothing closed yet");
        s1.OrderState = OrderState.Cancelled; Update(f1, s1);   // the cancel lands; the event carries the 2 filled
        Check(Closes(f1, b1).Count == 0, "0.4.3: its position update (3 to 1) is still on its way: nothing yet");
        Pos(f1, mnq, 1);
        List<string> c1 = Closes(f1, b1);
        Check(c1.Count == 1 && c1[0].Contains("Sell Market 1 "), "0.4.3: then it closes the 1 left, never the 3 the old position showed: " + string.Join(" | ", After(f1, b1)));
        Reset();
    }

    // ------------------------------------------------------------ 0.4.3 review: when a close does not go out
    static void CloseNotOut()
    {
        // (1) a scale-out to zero (SIM-F3, Qty 1; the leader 3 to 1, a third of 1 rounds to 0) whose stop cancel NinjaTrader
        // confirms only after the 3 s limit: the close is retried while the leader still holds, never left without its stop
        // and without a close
        LeaderEntry(3);
        FollowerFill(f1, mnq, 25000); FollowerFill(f2, nq, 25000); FollowerFill(f3, mnq, 25000);
        int b3 = f3.Calls.Count;
        Fill(lead, lead.Orders.Last(o => Regex.IsMatch(o.Name ?? "", " target ")), 2, 25004);
        Pos(lead, mnq, 1);
        Check(After(f3, b3).Count == 1 && After(f3, b3)[0].StartsWith("cancel "), "review (1): the leader scales out 3 to 1: SIM-F3 (1) closes, its stop cancelled first");
        double t = Now();
        ChartBridgeCopier.Tick(t + ChartBridgeCopier.ReduceConfirmMs + 100);
        Check(Closes(f3, b3).Count == 0 && Logged("could not close this follower"), "review (1): not confirmed in 3 s: nothing sent, an alarm");
        ConfirmCancels(f3, b3);   // the cancel lands late
        for (int k = 1; k <= 6; k++) ChartBridgeCopier.Tick(t + ChartBridgeCopier.ReduceConfirmMs + 100 + k * 2000);
        Check(Closes(f3, b3).Count == 1 && Closes(f3, b3)[0].Contains("Sell Market 1 ") && EventSaid("flatten", "SIM-F3", "its close is not done (not sent, or not filled in full); tried again"),
              "review (1): the owed close is tried again and closes the 1, while the leader still holds 1: " + string.Join(" | ", After(f3, b3)));
        Reset();

        // (2) a leader entry while a follower's close is still waiting: that follower is skipped (never a new copy into a close)
        LeaderEntry(1);
        FollowerFill(f1, mnq, 25000); FollowerFill(f2, nq, 25000); FollowerFill(f3, mnq, 25000);
        int b1 = f1.Calls.Count;
        Fill(lead, LeaderStop(), 1, 24998);
        Pos(lead, mnq, 0);
        sent.Clear();
        LeaderEntry(1);   // the leader enters again before NinjaTrader confirms SIM-F1's stop cancel
        Check(!After(f1, b1).Any(x => x.Contains(" copy ") && !x.Contains(" copy out ")) && EventSaid("skip", "SIM-F1", "still being closed"), "review (2): a new leader entry during SIM-F1's close: skipped (closing), nothing copied: " + string.Join(" | ", After(f1, b1)));
        ConfirmCancels(f1, b1);
        Check(Closes(f1, b1).Count == 1 && Closes(f1, b1)[0].Contains("Sell Market 3 "), "review (2): then the close takes its 3: " + string.Join(" | ", After(f1, b1)));
        Reset();

        // (3) an order NinjaTrader lists filled whose order event never came: after 10 s it no longer blocks the close
        LeaderEntry(1);
        FollowerFill(f1, mnq, 25000); FollowerFill(f2, nq, 25000); FollowerFill(f3, mnq, 25000);
        Order ghost = new Order { Name = "old fill", Instrument = mnq, Account = f3, OrderAction = OrderAction.Buy, OrderType = OrderType.Market, Quantity = 1, Filled = 1, OrderState = OrderState.Filled };
        f3.Orders.Add(ghost);
        b3 = f3.Calls.Count;
        Fill(lead, LeaderStop(), 1, 24998);
        Pos(lead, mnq, 0);
        ConfirmCancels(f3, b3);
        Check(Closes(f3, b3).Count == 0, "review (3): a fill never come through: the close waits");
        t = Now();
        for (int k = 1; k <= 20; k++)
        {
            ChartBridgeCopier.Tick(t + k * 1000); ConfirmCancels(f3, b3);
            Order close = f3.Orders.LastOrDefault(o => (o.Name ?? "").EndsWith(" copy out") && ChartBridgeOrders.IsWorking(o.OrderState));
            if (close != null) { Fill(f3, close, close.Quantity, 24997.75); Pos(f3, mnq, 0); }   // the close fills at market
        }
        Check(Closes(f3, b3).Count == 1 && Closes(f3, b3)[0].Contains("Sell Market 1 ") && Logged("never came through its order event"),
              "review (3): after 10 s it counts as come through (alarmed); the close goes out once, for what NinjaTrader's position shows: " + string.Join(" | ", After(f3, b3)));
        f3.Orders.Remove(ghost);
        Reset();

        // (5) after a restart: a follower holding a copied position with no working stop and no record: said loudly, once
        ChartBridgeCopier.Stop();
        Order cent = new Order { Account = f1, Instrument = mnq, OrderAction = OrderAction.Buy, OrderType = OrderType.Market, Quantity = 1, Filled = 1, AverageFillPrice = 25000, Name = "CB#eeee5555 copy ffff6666", OrderState = OrderState.Filled };
        f1.Orders.Add(cent);
        ChartBridgeOrders.SeedNoted(f1);
        Pos(f1, mnq, 1); Booked();
        ChartBridgeCopier.Start();
        Msg("client", "{\"type\":\"client\",\"v\":3}");
        sent.Clear();
        ChartBridgeCopier.Tick(Now()); ChartBridgeCopier.Tick(Now() + 1000);
        Check(sent.Count(m => m.Contains("\"level\":\"error\"") && m.Contains("SIM-F1: it holds 1 with a copier entry filled there and NO working stop")) == 1, "review (5): a copied position with no stop and no record after a restart: one alarm");
        Pos(f1, mnq, 0); Booked();
        f1.Orders.Remove(cent);
        Msg("copierSet", "{\"type\":\"copierSet\",\"leader\":\"Sim101\"}");
        Msg("copierRearm", "{\"type\":\"copierRearm\",\"cid\":\"r\"}");
        ChartBridgeCopier.Tick(Now());
    }

    // ------------------------------------------------------------ 0.4.3 second review of the close
    static void SecondReview()
    {
        // (1) a close sent and rejected: still owed (not cleared when sent); a new leader entry skips that follower; the close is
        // tried again whatever the leader does; while a close may still fill, no second one goes out
        LeaderEntry(1);
        FollowerFill(f1, mnq, 25000); FollowerFill(f2, nq, 25000); FollowerFill(f3, mnq, 25000);
        int b1 = f1.Calls.Count;
        Fill(lead, LeaderStop(), 1, 24998);
        Pos(lead, mnq, 0);
        ConfirmCancels(f1, b1);
        Order x1 = f1.Orders.LastOrDefault(o => (o.Name ?? "").EndsWith(" copy out"));
        Check(Closes(f1, b1).Count == 1 && x1 != null && x1.Quantity == 3, "second review (1): SIM-F1's close of 3 goes out: " + string.Join(" | ", After(f1, b1)));
        if (x1 == null) { Reset(); return; }
        x1.OrderState = OrderState.Rejected; Update(f1, x1);
        sent.Clear();
        LeaderEntry(1);   // the leader goes in again
        Check(!After(f1, b1).Any(c => Regex.IsMatch(c, " copy [0-9a-f]{8} ")) && EventSaid("skip", "SIM-F1", "still being closed"), "second review (1): close rejected: SIM-F1 is still owed its close: the new leader entry skips it: " + string.Join(" | ", After(f1, b1)));
        double t = Now();
        for (int k = 1; k <= 6; k++) { ChartBridgeCopier.Tick(t + k * 1000); ConfirmCancels(f1, b1); }
        Check(Closes(f1, b1).Count == 2 && Closes(f1, b1)[1].Contains("Sell Market 3 ") && EventSaid("flatten", "SIM-F1", "its close is not done"),
              "second review (1): the rejected close is tried again (the leader is long again; owed closes do not wait for it): " + string.Join(" | ", After(f1, b1)));
        for (int k = 7; k <= 16; k++) { ChartBridgeCopier.Tick(t + k * 1000); ConfirmCancels(f1, b1); }
        Check(Closes(f1, b1).Count == 2, "second review (1): while that close may still fill, no other close is started: " + string.Join(" | ", After(f1, b1)));
        Reset();

        // (3) a closing fill whose order event never comes (and is not in NinjaTrader's position): past 10 s it no longer blocks,
        // but the close takes it off: SIM-F1 shows 3, sold 1 unseen: the close is 2, never 3 (3 would cross zero), and an alarm
        LeaderEntry(1);
        FollowerFill(f1, mnq, 25000); FollowerFill(f2, nq, 25000); FollowerFill(f3, mnq, 25000);
        Order unseen = new Order { Name = "unseen sell", Instrument = mnq, Account = f1, OrderAction = OrderAction.Sell, OrderType = OrderType.Market, Quantity = 1, Filled = 1, OrderState = OrderState.Filled };
        f1.Orders.Add(unseen);
        b1 = f1.Calls.Count;
        Fill(lead, LeaderStop(), 1, 24998);
        Pos(lead, mnq, 0);
        ConfirmCancels(f1, b1);
        Check(Closes(f1, b1).Count == 0, "second review (3): a fill not through its event: the close waits");
        t = Now();
        for (int k = 1; k <= 24; k++)
        {
            ChartBridgeCopier.Tick(t + k * 1000); ConfirmCancels(f1, b1);
            Order close = f1.Orders.LastOrDefault(o => (o.Name ?? "").EndsWith(" copy out") && ChartBridgeOrders.IsWorking(o.OrderState));
            if (close != null) { Fill(f1, close, close.Quantity, 24997.75); Pos(f1, mnq, 3 - close.Quantity); }
        }
        Check(Closes(f1, b1).Count == 1 && Closes(f1, b1)[0].Contains("Sell Market 2 ") && Logged("the copier closes 2 of the 3 this follower shows"),
              "second review (3): past 10 s: the close is 2 of the 3 shown (the unseen 1 taken off; never 3), and an alarm: " + string.Join(" | ", After(f1, b1)));
        Check(!Closes(f1, b1).Any(c => c.Contains("Sell Market 3 ")) && EventSaid("flatten", "SIM-F1", "less 1 filled on an order whose event never came"), "second review (3): what still shows (the unseen 1) is never sold again");
        f1.Orders.Remove(unseen);
        Reset();

        // (4) owed while it holds the other side (a hand reversal after its stops were cancelled): left to the user after 10 s,
        // said once; clearing the leader is not blocked by an owed close (only by one running, 3 s at most)
        LeaderEntry(1);
        FollowerFill(f1, mnq, 25000); FollowerFill(f2, nq, 25000); FollowerFill(f3, mnq, 25000);
        b1 = f1.Calls.Count;
        Fill(lead, LeaderStop(), 1, 24998);
        Pos(lead, mnq, 0);
        t = Now();
        ChartBridgeCopier.Tick(t + ChartBridgeCopier.ReduceConfirmMs + 100);   // its cancel never confirmed: not closed, owed
        Check(Closes(f1, b1).Count == 0, "second review (4): the cancel not confirmed: nothing sent, owed");
        ConfirmCancels(f1, b1);
        Pos(f1, mnq, -2); Booked();   // sold 5 by hand: short 2
        sent.Clear();
        Msg("copierSet", "{\"type\":\"copierSet\",\"cid\":\"n\",\"leader\":null}");
        Check(!Rejected("still being closed") && State().Contains("\"leader\":null"), "second review (4): the leader can be cleared while a close is owed (not running)");
        for (int k = 1; k <= 16; k++) ChartBridgeCopier.Tick(t + k * 1000);
        Check(sent.Count(m => m.Contains("\"level\":\"error\"") && m.Contains("it now holds 2 on the other side")) == 1 && Closes(f1, b1).Count == 0,
              "second review (4): owed but short 2: one alarm, left to the user, nothing sent: " + string.Join(" | ", After(f1, b1)));
        Reset();
        Msg("copierSet", "{\"type\":\"copierSet\",\"cid\":\"n\",\"leader\":\"Sim101\"}");
        Msg("copierRearm", "{\"type\":\"copierRearm\",\"cid\":\"r\"}");
        Check(State().Contains("\"armed\":true"), "second review (4): the leader set again and Re-armed");

        // (6) NinjaTrader refuses one follower's close (Submit throws): the other closes in the same pass still go out, and the
        // refused one is tried again
        LeaderEntry(1);
        FollowerFill(f1, mnq, 25000); FollowerFill(f2, nq, 25000); FollowerFill(f3, mnq, 25000);
        b1 = f1.Calls.Count; int b2 = f2.Calls.Count, b3 = f3.Calls.Count;
        f1.OnCall = (kind, o) => { if (kind == "submit" && (o.Name ?? "").EndsWith(" copy out")) { o.OrderState = OrderState.Rejected; throw new InvalidOperationException("test refusal"); } };
        Fill(lead, LeaderStop(), 1, 24998);
        Pos(lead, mnq, 0);
        foreach (Account a in new[] { f1, f2, f3 })   // every cancel confirmed at once (no order events), so one pass sends all three
        {
            int n = a == f1 ? b1 : a == f2 ? b2 : b3;
            foreach (string c in After(a, n).Where(q => q.StartsWith("cancel ")).ToList())
                foreach (Order o in a.Orders.Where(o => o.Name == c.Substring(7)).ToList()) o.OrderState = OrderState.Cancelled;
        }
        t = Now();
        ChartBridgeCopier.Tick(t + 100);
        Check(Closes(f2, b2).Count == 1 && Closes(f3, b3).Count == 1 && Logged("NinjaTrader refused the copier's close (test refusal); it tries again"),
              "second review (6): SIM-F1's close refused: SIM-F2's and SIM-F3's still go out in the same pass, and an alarm: " + string.Join(" | ", After(f2, b2).Concat(After(f3, b3))));
        f1.OnCall = null;
        for (int k = 1; k <= 6; k++) { ChartBridgeCopier.Tick(t + 100 + k * 1000); ConfirmCancels(f1, b1); }
        Check(Closes(f1, b1).Count == 2 && Closes(f1, b1)[1].Contains("Sell Market 3 "), "second review (6): then SIM-F1's close is tried again and goes out: " + string.Join(" | ", After(f1, b1)));
        Reset();
    }

    // ------------------------------------------------------------ 0.4.3: a fixed quantity per leader entry (Anthony 2026-10-07)
    static void FixedQuantity()
    {
        int a1 = f1.Calls.Count, a2 = f2.Calls.Count;
        sent.Clear();
        // the leader buys 5, filled in two parts (1, then 4): SIM-F1 (qty 3) gets 3, once; SIM-F2 (qty 1 mini) gets 1 NQ, once
        ChartBridgeOrders.NoteLast("MNQ", 25000); ChartBridgeOrders.NoteLast("NQ", 25000);
        Msg("order", Leader("\"side\":\"buy\",\"kind\":\"market\",\"qty\":5,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order e = lead.Orders.Last();
        Fill(lead, e, 1, 25000);
        Pos(lead, mnq, 1);
        Fill(lead, e, 5, 25000.25);
        Pos(lead, mnq, 5);
        List<string> c1 = After(f1, a1).Where(x => x.Contains(" copy ")).ToList(), c2 = After(f2, a2).Where(x => x.Contains(" copy ")).ToList();
        Check(c1.Count == 1 && c1[0].Contains("Buy Market 3 "), "0.4.3: the leader buys 5 in two fills: SIM-F1 (qty 3) gets exactly 3, once (WORK: a qty 1 follower took 5): " + string.Join(" | ", c1));
        Check(c2.Count == 1 && c2[0].Contains("Buy Market 1 "), "0.4.3: SIM-F2 (qty 1 mini) gets exactly 1 NQ, once: " + string.Join(" | ", c2));
        Check(!EventSaid("skip", "SIM-F1", null) && !EventSaid("skip", "SIM-F2", null), "0.4.3: and nothing about the second fill (no copy sized from it, so no cap skip either)");
        FollowerFill(f1, mnq, 25000); FollowerFill(f2, nq, 25000); FollowerFill(f3, mnq, 25000);
        // an add: a second leader entry copies each follower's quantity again (Anthony: "add its Qty again")
        int d1 = f1.Calls.Count;
        Msg("order", Leader("\"side\":\"buy\",\"kind\":\"market\",\"qty\":2,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order e2 = lead.Orders.Last(o => (o.Name ?? "").Contains(" s8 t16") && ChartBridgeOrders.IsWorking(o.OrderState));
        Fill(lead, e2, 2, 25001);
        Pos(lead, mnq, 7);
        List<string> d = After(f1, d1).Where(x => x.Contains(" copy ")).ToList();
        Check(d.Count == 1 && d[0].Contains("Buy Market 3 "), "0.4.3: the leader adds 2: SIM-F1 adds its 3 again: " + string.Join(" | ", d));
        FollowerFill(f1, mnq, 25001); FollowerFill(f2, nq, 25001); FollowerFill(f3, mnq, 25001);
        Check(f1.Positions.Single(p => p.Instrument == mnq).Quantity == 6, "0.4.3: SIM-F1 holds 6 (3 per leader entry)");
        Reset();
    }

    // ------------------------------------------------------------ 0.4.3: no leader (WORK 2026-10-07: the page's "none" could not be set)
    static void NoLeader()
    {
        bool wasArmed = State().Contains("\"armed\":true");
        sent.Clear();
        Msg("copierSet", "{\"type\":\"copierSet\",\"cid\":\"n\",\"leader\":null}");
        Check(!Rejected("") && State().Contains("\"armed\":false,\"standDownWhy\":\"No leader is set.\"") && State().Contains("\"leader\":null"), "0.4.3: leader null: no leader, the copier stands down: " + State());
        Check(!File.ReadAllText(Path.Combine(NinjaTrader.Core.Globals.UserDataDir, "ChartBridge", "copier.txt")).Contains("leader\t"), "0.4.3: copier.txt keeps no leader line");
        int b1 = f1.Calls.Count;
        LeaderEntry(1);
        Check(f1.Calls.Count == b1, "0.4.3: no leader: Sim101's entry is not copied");
        Reset();
        sent.Clear();
        Msg("copierSet", "{\"type\":\"copierSet\",\"cid\":\"n\",\"leader\":\"\"}");
        Check(Rejected("leader must be an account name, or null for none."), "0.4.3: an empty leader name is refused (null is none)");
        Msg("copierSet", "{\"type\":\"copierSet\",\"cid\":\"n\",\"leader\":\"Sim101\"}");
        if (wasArmed) Msg("copierRearm", "{\"type\":\"copierRearm\",\"cid\":\"r\"}");
        Check(State().Contains("\"leader\":{\"account\":\"Sim101\"") && (!wasArmed || State().Contains("\"armed\":true")), "0.4.3: the leader set again (and Re-armed as before)");
    }

    // ------------------------------------------------------------ a scale-out: the stops shrink first, then the reduce
    static void ScaleOut()
    {
        // 0.4.3: a fixed quantity per follower: SIM-F1 6, SIM-F2 2 (mini), SIM-F3 2 for this test (the sizes 0.4.2's tests had
        // from 2 leader contracts), set back at the end
        Msg("copierFollower", Follower("SIM-F1", "true", "6", "micro", "null")); Msg("copierFollower", Follower("SIM-F2", "true", "2", "mini", "500")); Msg("copierFollower", Follower("SIM-F3", "true", "2", "micro", "null"));
        LeaderEntry(2);
        FollowerFill(f1, mnq, 25000); FollowerFill(f2, nq, 25000); FollowerFill(f3, mnq, 25000);
        Check(f1.Positions.Single().Quantity == 6 && f2.Positions.Single().Quantity == 2, "scale-out: the followers hold 6 MNQ and 2 NQ");
        Order s1 = f1.Orders.Last(o => o.OrderType == OrderType.StopMarket), s2 = f2.Orders.Last(o => o.OrderType == OrderType.StopMarket), s3 = f3.Orders.Last(o => o.OrderType == OrderType.StopMarket);
        int b1 = f1.Calls.Count, b2 = f2.Calls.Count, b3 = f3.Calls.Count;
        Order target = lead.Orders.Last(o => Regex.IsMatch(o.Name ?? "", " target "));
        Fill(lead, target, 1, 25004);
        Pos(lead, mnq, 1);
        Check(After(f1, b1).SequenceEqual(new[] { "change " + s1.Name + " L0 S0 Q3" }), "scale-out 2 to 1: SIM-F1's stop shrinks to 3 first, and no reduce is sent before NinjaTrader confirms: " + string.Join(" | ", After(f1, b1)));
        s1.Quantity = 3; Update(f1, s1);
        List<string> c1 = After(f1, b1);
        Check(c1.Count == 2 && Regex.IsMatch(c1[1], "^submit CB#[0-9a-f]{8} copy out Sell Market 3 "), "...then the reduce: sell 3 (the same share, half of 6)");
        Check(EventSaid("reduce", "SIM-F1", "reduced by 3 to 3"), "reduce logged");
        s2.Quantity = 1; Update(f2, s2);
        Check(After(f2, b2).Count == 2 && After(f2, b2)[1].Contains("Sell Market 1"), "SIM-F2 (2 NQ): stop to 1, then sell 1");
        // SIM-F3: NinjaTrader never confirms its stop change: no reduce at all (never crosses zero), and an alarm
        ChartBridgeCopier.Tick(Now() + ChartBridgeCopier.ReduceConfirmMs + 100);
        Check(After(f3, b3).Count == 1 && After(f3, b3)[0].Contains(" Q1") && Logged("could not reduce this follower"), "a stop change not confirmed in 3 s: no reduce sent, and an alarm");
        Pos(f1, mnq, 3); Pos(f2, nq, 1);
        Fill(f1, f1.Orders.Last(), 3, 25003.75);
        // the leader's flat: everything left is closed (its stop cancelled first, then the 3 it holds)
        int d1 = f1.Calls.Count;
        Fill(lead, LeaderStop(), 1, 24998);
        Pos(lead, mnq, 0);
        Check(After(f1, d1).Count == 1 && After(f1, d1)[0] == "cancel " + s1.Name, "after the scale-out, the leader flat: its stop is cancelled first: " + string.Join(" | ", After(f1, d1)));
        ConfirmCancels(f1, d1);
        Check(Closes(f1, d1).Count == 1 && Closes(f1, d1)[0].Contains("Sell Market 3 "), "...then the 3 left are closed: " + string.Join(" | ", After(f1, d1)));
        Reset();

        // a follower whose own stop already took part is not reduced twice (the share is of what the copier gave it)
        LeaderEntry(2);
        FollowerFill(f1, mnq, 25000);
        Order f1stop = f1.Orders.Last(o => o.OrderType == OrderType.StopMarket);
        f1stop.Quantity = 6; Fill(f1, f1stop, 3, 24998); Pos(f1, mnq, 3);
        int e1 = f1.Calls.Count;
        Fill(lead, lead.Orders.Last(o => Regex.IsMatch(o.Name ?? "", " target ")), 1, 25004);
        Pos(lead, mnq, 1);
        Check(After(f1, e1).Count == 0, "scale-out after the follower's own stop took 3 of 6: it already holds the target 3; nothing sent");
        Reset();
        Msg("copierFollower", Follower("SIM-F1", "true", "3", "micro", "null")); Msg("copierFollower", Follower("SIM-F2", "true", "1", "mini", "500")); Msg("copierFollower", Follower("SIM-F3", "true", "1", "micro", "null"));
    }

    // ------------------------------------------------------------ 0.4.3: a small fixed follower keeps the same share, no minimum cut
    // Anthony 2026-10-07: the leader 5 scaling out one at a time: SIM-F1 (Qty 3) holds 3, 2, 2, 1, 1, then 0 with the leader;
    // SIM-F2 and SIM-F3 (Qty 1) ride until the leader is flat. 0.4.2's "at least 1" had SIM-F1 flat with the leader at 2.
    static void ScaleOutSmallFollower()
    {
        LeaderEntry(5);
        FollowerFill(f1, mnq, 25000); FollowerFill(f2, nq, 25000); FollowerFill(f3, mnq, 25000);
        Check(f1.Positions.Single().Quantity == 3 && f3.Positions.Single().Quantity == 1, "small follower: SIM-F1 holds 3 and SIM-F3 1 under a leader of 5");
        Order target = lead.Orders.Last(o => Regex.IsMatch(o.Name ?? "", " target "));
        int[] want = { 2, 2, 1, 1 };
        int held = 3;
        for (int k = 1; k <= 4; k++)
        {
            int b1 = f1.Calls.Count, b2 = f2.Calls.Count, b3 = f3.Calls.Count;
            Fill(lead, target, k, 25004);
            Pos(lead, mnq, 5 - k);
            string step = "the leader " + (6 - k) + " to " + (5 - k) + ": ";
            Check(After(f2, b2).Count == 0 && After(f3, b3).Count == 0, "small follower: " + step + "SIM-F2 and SIM-F3 keep their 1, nothing sent: " + string.Join(" | ", After(f3, b3)));
            if (want[k - 1] == held)
            {
                Check(After(f1, b1).Count == 0 && Logged("keeps its " + held), "small follower: " + step + "SIM-F1 keeps its " + held + ", nothing sent: " + string.Join(" | ", After(f1, b1)));
                continue;
            }
            Order s1 = f1.Orders.Last(o => o.OrderType == OrderType.StopMarket && ChartBridgeOrders.IsWorking(o.OrderState));
            Check(After(f1, b1).SequenceEqual(new[] { "change " + s1.Name + " L0 S0 Q" + want[k - 1] }), "small follower: " + step + "SIM-F1's stop shrinks to " + want[k - 1] + " first: " + string.Join(" | ", After(f1, b1)));
            s1.Quantity = want[k - 1]; Update(f1, s1);
            List<string> c1 = Closes(f1, b1);
            Check(c1.Count == 1 && c1[0].Contains("Sell Market " + (held - want[k - 1]) + " "), "small follower: " + step + "then SIM-F1 sells " + (held - want[k - 1]) + " to " + want[k - 1] + ": " + string.Join(" | ", After(f1, b1)));
            Order red = f1.Orders.Last(o => (o.Name ?? "").EndsWith(" copy out"));
            Pos(f1, mnq, want[k - 1]);
            Fill(f1, red, red.Quantity, 25004);
            held = want[k - 1];
        }
        int d1 = f1.Calls.Count, d2 = f2.Calls.Count, d3 = f3.Calls.Count;
        Fill(lead, target, 5, 25004);
        Pos(lead, mnq, 0);
        ConfirmCancels(f1, d1); ConfirmCancels(f2, d2); ConfirmCancels(f3, d3);
        Check(Closes(f1, d1).Count == 1 && Closes(f1, d1)[0].Contains("Sell Market 1 ") && Closes(f2, d2).Count == 1 && Closes(f2, d2)[0].Contains("Sell Market 1 ") && Closes(f3, d3).Count == 1 && Closes(f3, d3)[0].Contains("Sell Market 1 "),
              "small follower: the leader flat: each follower closes its last 1: " + string.Join(" | ", After(f1, d1).Concat(After(f3, d3))));
        Reset();
    }

    // ------------------------------------------------------------ the stop level already traded on the follower's contract
    static void StopAlreadyTraded()
    {
        LeaderEntry(1);
        int b1 = f1.Calls.Count;
        ChartBridgeOrders.NoteLast("MNQ", 24997.75);   // a trade at or through the stop level, just now
        FollowerFill(f1, mnq, 24998.5);
        List<string> c1 = After(f1, b1);
        Check(c1.Count == 1 && Regex.IsMatch(c1[0], "^submit CB#[0-9a-f]{8} exit f3 q3 p24998.5 Sell Market 3 "), "the stop level had already traded: a market exit instead of a stop through the market: " + string.Join(" | ", c1));
        Check(Logged("price had already passed the leader's stop level 24998"), "...with an alarm");
        Reset();
    }

    // ------------------------------------------------------------ a short; the leader on NQ; the leader turning to the other side
    static void ShortsAndContracts()
    {
        ChartBridgeOrders.NoteLast("MNQ", 25000); ChartBridgeOrders.NoteLast("NQ", 25000);
        int b1 = f1.Calls.Count;
        Msg("order", Leader("\"side\":\"sell\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Fill(lead, lead.Orders.Last(), 1, 25000); Pos(lead, mnq, -1);
        Check(After(f1, b1).Count == 1 && After(f1, b1)[0].Contains("Sell Market 3"), "a leader short: SIM-F1 sells 3 at market");
        FollowerFill(f1, mnq, 24999.5);
        Check(After(f1, b1).Last().Contains("Buy StopMarket 3 L0 S25002") && EventSaid("stop", "SIM-F1", "\"slippageTicks\":2"), "the short's stop: a buy stop at the leader's 25002; selling lower is 2 ticks worse");
        int x1 = f1.Calls.Count;
        Fill(lead, LeaderStop(), 1, 25002); Pos(lead, mnq, 0);
        Check(ClosedAfterConfirm(f1, x1, "Buy Market 3 "), "the short's exit is copied: its stop cancelled, then the 3 bought back: " + string.Join(" | ", After(f1, x1)));
        Reset();

        // the leader on NQ: SIM-F1 (micro) trades MNQ, SIM-F2 (mini) NQ; the exit maps back
        Msg("copierFollower", Follower("SIM-F2", "true", "1", "mini", "null"));
        int c1 = f1.Calls.Count, c2 = f2.Calls.Count;
        Msg("order", "{\"type\":\"order\",\"cid\":\"L\",\"account\":\"Sim101\",\"root\":\"NQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}}");
        Fill(lead, lead.Orders.Last(), 1, 25000); Pos(lead, nq, 1);
        Check(After(f1, c1).Count == 1 && f1.Orders.Last().Instrument == mnq && After(f1, c1)[0].Contains("Buy Market 3"), "the leader on NQ: SIM-F1 (micro) buys 3 MNQ");
        Check(After(f2, c2).Count == 1 && f2.Orders.Last().Instrument == nq, "the leader on NQ: SIM-F2 (mini) buys 1 NQ");
        ChartBridgeCopier.Tick(Now());   // positions reach the page within the second
        Check(State().Contains("{\"account\":\"SIM-F1\",\"sim\":true,\"on\":true,\"qty\":3,\"size\":\"micro\",\"root\":\"MNQ\"") && State().Contains("\"position\":{\"root\":\"NQ\",\"qty\":1"), "the copier message, within a second: the leader's NQ position, the follower's MNQ");
        FollowerFill(f1, mnq, 25000); FollowerFill(f2, nq, 25000);
        // the leader turns to the other side in one go (an order placed elsewhere): every copy on the old side closes, none opens
        int d1 = f1.Calls.Count, d2 = f2.Calls.Count;
        Pos(lead, nq, -1);
        Check(ClosedAfterConfirm(f1, d1, "Sell Market 3 ") && ClosedAfterConfirm(f2, d2, "Sell Market 1 ") && EventSaid("flatten", "SIM-F1", "the leader turned to the other side") && !After(f1, d1).Concat(After(f2, d2)).Any(x => x.Contains(" copy ") && !x.Contains(" copy out ")),
              "the leader turned short: the followers' longs close, nothing opposite is opened: " + string.Join(" | ", After(f1, d1)));
        Reset();
        Msg("copierFollower", Follower("SIM-F2", "true", "1", "mini", "500"));
    }

    // ------------------------------------------------------------ a real follower (Anthony 2026-10-07: no Sim lock; every gate still applies)
    static void RealFollowerAllowed()
    {
        f3.Provider = Provider.Rithmic;   // a real (broker) account as a follower
        int b3 = f3.Calls.Count;
        sent.Clear();
        Order e = LeaderEntry(1);
        Check(After(f3, b3).Count == 1 && After(f3, b3)[0].Contains("Buy Market 1") && EventSaid("enter", "SIM-F3", null) && !EventSaid("refused", "SIM-F3", null),
              "a real follower: copied like any follower (" + string.Join(" | ", After(f3, b3)) + ")");
        FollowerFill(f3, mnq, 25000.25);
        Check(f3.Orders.Any(o => o.OrderType == OrderType.StopMarket && ChartBridgeOrders.IsWorking(o.OrderState) && Math.Abs(o.StopPrice - 24998) < 1e-9),
              "a real follower: its stop at the leader's stop price, as any follower");
        ChartBridgeCopier.Tick(Now());
        Check(State().Contains("{\"account\":\"SIM-F3\",\"sim\":false") && !State().Contains("not a Sim account"), "the copier message marks it not Sim (the page shows LIVE); nothing says refused");
        int x3 = f3.Calls.Count;
        Pos(lead, mnq, 0); Booked();
        Check(ClosedAfterConfirm(f3, x3, "Sell Market 1 "), "a real follower: the leader flat means it is closed like any follower (never an opposite order): " + string.Join(" | ", After(f3, x3)));
        Reset();
        // the gates still apply: unchecked (not in tradeAccounts), it is skipped and nothing is sent
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, SIM-F1, SIM-F2, SIM-F4, EVAL-A");
        b3 = f3.Calls.Count;
        sent.Clear();
        LeaderEntry(1);
        Check(After(f3, b3).Count == 0 && EventSaid("skip", "SIM-F3", "may not trade"), "a real follower that is not tradable (gate 2): skipped, nothing sent");
        Reset();
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, SIM-F1, SIM-F2, SIM-F3, SIM-F4, EVAL-A");
        f3.Provider = Provider.Simulator;
        Reset();
    }

    // ------------------------------------------------------------ a follower at its position limit: skipped (never partly) and highlighted
    static void PositionLimit()
    {
        int b1 = f1.Calls.Count, b2 = f2.Calls.Count, b3 = f3.Calls.Count;
        sent.Clear();
        // 0.4.3: fixed quantities: SIM-F1 holds 8 MNQ already (+3 = 11, over the cap of 10); SIM-F2 is set to 4 NQ (over the cap of 3)
        Pos(f1, mnq, 8);
        Msg("copierFollower", Follower("SIM-F2", "true", "4", "mini", "500"));
        LeaderEntry(4);
        Check(After(f1, b1).Count == 0 && EventSaid("skip", "SIM-F1", "could make the MNQ position 11 contracts; the cap is 10"), "SIM-F1 at its position limit: skipped, nothing sent (never part of it)");
        Check(After(f2, b2).Count == 0 && EventSaid("skip", "SIM-F2", "NQ cap of 3"), "SIM-F2 at its limit: skipped");
        Check(After(f3, b3).Count == 1 && After(f3, b3)[0].Contains("Buy Market 1 "), "SIM-F3 within its limit: copied (its fixed 1, whatever the leader's 4)");
        Msg("copierFollower", Follower("SIM-F2", "true", "1", "mini", "500"));
        Check(Regex.IsMatch(State(), "\"account\":\"SIM-F1\"[^}]*\\}[^}]*\"skipped\":\"position limit\""), "the page sees SIM-F1 highlighted: skipped position limit");
        Reset();
        // a position already held counts in the limit too
        Pos(f1, mnq, 8);
        int c1 = f1.Calls.Count;
        LeaderEntry(1);
        Check(f1.Calls.Count == c1 && EventSaid("skip", "SIM-F1", "could make the MNQ position 11"), "the position plus the copy over the cap: skipped");
        Reset();
        LeaderEntry(1);
        Check(f1.Calls.Count == c1 + 1 && !Regex.IsMatch(State(), "\"account\":\"SIM-F1\"[^}]*\\}[^}]*\"skipped\":\"position limit\""), "the next entry within the limit clears the highlight");
        Reset();
    }

    // ------------------------------------------------------------ the follower daily loss limit (an option, off by default; flat dollars, no buffer)
    static void DailyLoss()
    {
        f2.Items[AccountItem.RealizedProfitLoss] = -300; f2.Items[AccountItem.UnrealizedProfitLoss] = -199;
        int b2 = f2.Calls.Count;
        LeaderEntry(1);
        Check(f2.Calls.Count == b2 + 1, "SIM-F2 at -499 with a 500 limit: still copied (no buffer)");
        Reset();
        f2.Items[AccountItem.UnrealizedProfitLoss] = -200;
        f1.Items[AccountItem.RealizedProfitLoss] = -5000;
        int c1 = f1.Calls.Count, c2 = f2.Calls.Count;
        sent.Clear();
        LeaderEntry(1);
        Check(f2.Calls.Count == c2 && EventSaid("skip", "SIM-F2", "daily loss limit of 500 (P&L today -500)"), "SIM-F2 at -500 (read from NinjaTrader): skipped for new entries");
        Check(f1.Calls.Count == c1 + 1, "SIM-F1 with no loss limit (the default) at -5000: copied");
        Check(State().Contains("\"pnlToday\":-500") && State().Contains("\"skipped\":\"loss limit\""), "the page sees P&L today and the loss limit skip");
        // its open position keeps its stop, and the leader's exits are still copied to it
        Reset();
        f2.Items.Clear();
        int d2 = f2.Calls.Count;
        LeaderEntry(1);
        Check(f2.Calls.Count == d2 && EventSaid("skip", "SIM-F2", "skipped until 18:00 ET"), "back above the limit in the same session: still skipped until 18:00 ET");
        Reset();
        Func<Account, double?> was = ChartBridgeCopier.PnlToday;
        ChartBridgeCopier.PnlToday = a => null;
        Msg("copierFollower", Follower("SIM-F3", "true", "1", "micro", "250"));
        int e3 = f3.Calls.Count;
        LeaderEntry(1);
        Check(f3.Calls.Count == e3 && EventSaid("skip", "SIM-F3", "does not report its P&L"), "a loss limit with no P&L reading: skipped (never guessed)");
        ChartBridgeCopier.PnlToday = was;
        Msg("copierFollower", Follower("SIM-F3", "true", "1", "micro", "null"));
        Msg("copierFollower", Follower("SIM-F2", "false", "1", "mini", "500"));
        Reset();
    }

    // ------------------------------------------------------------ a connection drop
    static void ConnectionDrop()
    {
        ChartBridgeCopier.Tick(Now());
        f3.Connection.Status = ConnectionStatus.ConnectionLost;
        ChartBridgeCopier.Tick(Now());
        int b3 = f3.Calls.Count, b1 = f1.Calls.Count;
        sent.Clear();
        LeaderEntry(1);
        Check(After(f3, b3).Count == 0 && EventSaid("skip", "SIM-F3", "not connected (ConnectionLost)") && f1.Calls.Count == b1 + 1, "one follower disconnected: skipped; the others copied; no stand down");
        Check(State().Contains("\"armed\":true"), "...the copier stays armed");
        f3.Connection.Status = ConnectionStatus.Connected;
        FollowerFill(f1, mnq, 25000);
        // SIM-F1 drops while it holds a copy; the leader exits meanwhile
        f1.Connection.Status = ConnectionStatus.ConnectionLost;
        int c1 = f1.Calls.Count;
        Fill(lead, LeaderStop(), 1, 24998);
        Pos(lead, mnq, 0);
        Check(f1.Calls.Count == c1 && EventSaid("skip", "SIM-F1", "keeps its stop at the broker"), "the leader exits while SIM-F1 is down: nothing can be sent; it keeps its stop");
        f1.Connection.Status = ConnectionStatus.Connected;
        double t = Now();
        ChartBridgeCopier.Tick(t);
        Check(f1.Calls.Count == c1, "back: not flattened at once (the leader must stay flat for 4 s)");
        ChartBridgeCopier.Tick(t + ChartBridgeOrders.SettleMs + 100);
        Check(After(f1, c1).Count == 1 && After(f1, c1)[0].StartsWith("cancel ") && EventSaid("flatten", "SIM-F1", "its close is not done (not sent, or not filled in full); tried again"), "back, 4 s later: the close owed since the leader's exit is tried again, its stop cancelled first (0.4.3 review: owed closes are retried): " + string.Join(" | ", After(f1, c1)));
        Check(ClosedAfterConfirm(f1, c1, "Sell Market 3 "), "...then the 3 it holds are closed");
        Reset();
        ChartBridgeCopier.Tick(Now());
    }

    // ------------------------------------------------------------ a mass disconnect and Re-arm
    static void MassDisconnect()
    {
        Msg("copierFollower", Follower("SIM-F4", "true", "1", "micro", "null"));
        ChartBridgeCopier.Tick(Now());
        LeaderEntry(1);
        FollowerFill(f1, mnq, 25000);
        sent.Clear();
        f2.Connection.Status = ConnectionStatus.ConnectionLost; ChartBridgeCopier.ConnectionChanged();
        f3.Connection.Status = ConnectionStatus.Disconnected; ChartBridgeCopier.ConnectionChanged();
        Check(State().Contains("\"armed\":true") || State() == "", "two followers down: still armed");
        f4.Connection.Status = ConnectionStatus.ConnectionLost; ChartBridgeCopier.ConnectionChanged();
        Check(EventSaid("standDown", null, "3 followers left Connected within 10 s: the copier stands down until Re-arm") && State().Contains("\"armed\":false,\"standDownWhy\":\"3 followers left Connected within 10 s\""),
              "3 followers left Connected within 10 s: the copier stands down");
        sent.Clear(); Msg("copierRearm", "{\"type\":\"copierRearm\",\"cid\":\"r\"}");
        Check(Rejected("3 followers are not connected."), "Re-arm refused while 3 followers are not connected");
        // stood down: SIM-F1 still holds a copier position: its stop follows, and the leader's exit is copied
        Order ls = LeaderStop();
        int b1 = f1.Calls.Count;
        ls.StopPrice = 24999; Update(lead, ls);
        Check(After(f1, b1).Any(x => x.StartsWith("change ") && x.Contains("S24999")), "stood down: SIM-F1's stop still follows the leader's");
        Fill(lead, ls, 1, 24999);
        Pos(lead, mnq, 0);
        Check(After(f1, b1).Last().StartsWith("cancel ") && ClosedAfterConfirm(f1, b1, "Sell Market 3 "), "stood down: the leader's exit is still copied to a connected follower holding a copier position: " + string.Join(" | ", After(f1, b1)));
        Reset();
        int c1 = f1.Calls.Count;
        sent.Clear();
        LeaderEntry(1);
        Check(f1.Calls.Count == c1 && EventSaid("skip", null, "stood down"), "stood down: a new leader entry is not copied");
        Reset();
        foreach (Account a in new[] { f2, f3, f4 }) a.Connection.Status = ConnectionStatus.Connected;
        ChartBridgeCopier.Tick(Now());
        sent.Clear(); Msg("copierRearm", "{\"type\":\"copierRearm\",\"cid\":\"r\"}");
        Check(!Rejected("") && State().Contains("\"armed\":true"), "all back: Re-arm accepted");
        // the leader leaving Connected alone stands it down too
        lead.Connection.Status = ConnectionStatus.ConnectionLost; ChartBridgeCopier.ConnectionChanged();
        Check(State().Contains("\"standDownWhy\":\"the leader Sim101 left Connected\""), "the leader left Connected: stands down");
        sent.Clear(); Msg("copierRearm", "{\"type\":\"copierRearm\"}");
        Check(Rejected("The leader Sim101 is not connected."), "Re-arm refused while the leader is not connected");
        lead.Connection.Status = ConnectionStatus.Connected;
        ChartBridgeCopier.Tick(Now());
        Msg("copierRearm", "{\"type\":\"copierRearm\"}");
        Msg("copierFollower", Follower("SIM-F4", "false", "1", "micro", "null"));
        Check(State().Contains("\"armed\":true"), "Re-armed");
    }

    // ------------------------------------------------------------ orders mode, and the sweep
    static void OrdersModeAndSweep()
    {
        sent.Clear();
        Msg("copierSet", "{\"type\":\"copierSet\",\"mode\":\"orders\"}");
        Check(!Rejected("") && State().Contains("\"mode\":\"orders\""), "mode orders: set");
        ChartBridgeOrders.NoteLast("MNQ", 25000); ChartBridgeOrders.NoteLast("NQ", 25000);
        int b1 = f1.Calls.Count, b3 = f3.Calls.Count;
        Msg("order", Leader("\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order le = lead.Orders.Last();
        Check(After(f1, b1).Count == 1 && Regex.IsMatch(After(f1, b1)[0], "^submit CB#[0-9a-f]{8} copy [0-9a-f]{8} Buy Limit 3 L24990 S0 "), "orders mode: SIM-F1 gets a real limit order for 3 at the leader's price");
        Check(After(f3, b3).Count == 1 && After(f3, b3)[0].Contains("Buy Limit 1 L24990"), "orders mode: SIM-F3 gets 1");
        Msg("copierSet", "{\"type\":\"copierSet\",\"mode\":\"executions\"}");
        Check(Rejected("The copier cannot change while the leader Sim101 has a working entry."), "copierSet refused while the leader has a working entry");
        Order fo1 = f1.Orders.Last();
        le.LimitPrice = 24992; Update(lead, le);
        Check(After(f1, b1).Count == 2 && After(f1, b1)[1].StartsWith("change " + fo1.Name + " L24992"), "the leader's entry moved: the follower's order moves with it");
        // the sweep never takes an orders-mode entry while the leader's entry still works
        ChartBridgeCopier.Tick(Now() + 5000);
        Check(After(f1, b1).Count == 2, "the sweep leaves an orders-mode entry alone while the leader's entry is working");
        le.OrderState = OrderState.Cancelled; Update(lead, le);
        Check(After(f1, b1).Count == 3 && After(f1, b1)[2] == "cancel " + fo1.Name && EventSaid("sweep", "SIM-F1", "cancelled with the leader's entry"), "the leader's entry cancelled: the follower's is cancelled");
        fo1.OrderState = OrderState.Cancelled; Done(f3);
        ChartBridgeCopier.Tick(Now());

        // a follower fills before the leader: its stop goes at the leader's planned stop (24990 - 8 ticks), then follows the leader's
        int c1 = f1.Calls.Count;
        Msg("order", Leader("\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":16}"));
        le = lead.Orders.Last();
        FollowerFill(f1, mnq, 24990);
        Check(After(f1, c1).Last().Contains("Sell StopMarket 3 L0 S24988"), "orders mode: a follower filled first gets its stop at the leader's planned stop price 24988: " + After(f1, c1).Last());
        Order fstop = f1.Orders.Last();
        Fill(lead, le, 1, 24989.75);   // the leader fills a tick better: its stop goes at 24987.75
        Pos(lead, mnq, 1);
        Check(After(f1, c1).Last().StartsWith("change " + fstop.Name) && After(f1, c1).Last().Contains("S24987.75"), "...and moves to the leader's actual stop once the leader fills");
        // SIM-F3's order is still working, the leader has filled, SIM-F3 is flat: the sweep cancels it once it is 3 s old
        Order fo3 = f3.Orders.Last();
        int d3 = f3.Calls.Count;
        ConnectedSince()[f3] = 0;   // SIM-F3 (down in ConnectionDrop) has been back for 30 s: a steady connection
        ChartBridgeCopier.Tick(Now());
        Check(f3.Calls.Count == d3, "the sweep waits 3 s after an order is sent");
        ChartBridgeCopier.Tick(Now() + ChartBridgeOrders.YoungMs + 100);
        Check(f3.Calls.Count == d3, "the sweep: one flat reading is not enough (review 2: the flat reading is confirmed twice)");
        ChartBridgeCopier.Tick(Now() + ChartBridgeOrders.YoungMs + 1200);
        Check(After(f3, d3).SequenceEqual(new[] { "cancel " + fo3.Name }) && EventSaid("sweep", "SIM-F3", "left on a flat follower"), "the sweep: a copier order on a flat follower is cancelled (flat twice, a steady connection)");
        fo3.OrderState = OrderState.Cancelled;
        int z1 = f1.Calls.Count;
        Fill(lead, LeaderStop(), 1, 24987.75);
        Pos(lead, mnq, 0);
        Check(ClosedAfterConfirm(f1, z1, "Sell Market 3 "), "orders mode: the leader's exit is copied the same way: " + string.Join(" | ", After(f1, z1)));
        Reset();
        Msg("copierSet", "{\"type\":\"copierSet\",\"mode\":\"executions\"}");
        Check(State().Contains("\"mode\":\"executions\""), "back to executions mode");
    }

    // ------------------------------------------------------------ /diag and which pages get copier messages
    static void DiagAndPages()
    {
        ChartBridgeOrders.OnMessage(v2, "auth", "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
        v2sent.Clear();
        LeaderEntry(1);
        FollowerFill(f1, mnq, 25000);
        Check(v2.Trader && !v2sent.Any(m => m.Contains("\"type\":\"copier")), "a signed-in v2 page (never sent client v3) gets no copier message");
        Check(ChartBridgeClient.OrderLane("{\"type\":\"copier\",\"enabled\":true}") && ChartBridgeClient.OrderLane("{\"type\":\"copierEvent\",\"at\":1}"), "copier and copierEvent go in the order lane");
        string diag = ChartBridgeCopier.DiagJson();
        Check(Regex.IsMatch(diag, "\"decisions\":[1-9]") && diag.Contains("\"skipped\":") && diag.Contains("\"standDowns\":2") && Regex.IsMatch(diag, "\"leaderMsMedian\":[0-9]"), "/diag copier: decisions, skipped, standDowns, median leaderMs: " + diag);
        Check(!diag.Contains("SIM-") && !diag.Contains("Sim101") && !diag.Contains("EVAL"), "/diag copier never names an account");
        MethodInfo onClient = typeof(ChartBridgeServer).GetMethod("OnClientMessage", PS);
        sent.Clear();
        onClient.Invoke(null, new object[] { page, "{\"type\":\"copierGet\",\"cid\":\"d\"}" });
        Check(Last().StartsWith("{\"type\":\"copier\","), "ChartBridge's message dispatch hands copier messages to the copier");
        Reset();
    }

    // ------------------------------------------------------------ review 2: never cross zero, only the copier's own share, stops in step
    // The reviewer's scratch cases (rev2), made permanent, and the rest of review 2's list. SIM-F1 copies 1 micro per leader
    // contract here and SIM-F3 is off; both are set back at the end.
    static Order CopyEntry(Account a) { return a.Orders.LastOrDefault(x => Regex.IsMatch(x.Name ?? "", "^CB#[0-9a-f]{8} copy [0-9a-f]{8}$") && ChartBridgeOrders.IsWorking(x.OrderState)); }
    static Order CopierStop(Account a) { return a.Orders.LastOrDefault(o => Regex.IsMatch(o.Name ?? "", "^CB#[0-9a-f]{8} stop f") && ChartBridgeOrders.IsWorking(o.OrderState)); }
    static int SellStops(Account a, Instrument inst) { return a.Orders.Where(o => o.Instrument == inst && ChartBridgeOrders.IsWorking(o.OrderState) && o.OrderType == OrderType.StopMarket && o.OrderAction == OrderAction.Sell).Sum(o => o.Quantity - o.Filled); }
    static bool SendsExitOrStop(List<string> calls) { return calls.Any(x => Regex.IsMatch(x, "^submit CB#[0-9a-f]{8} (exit|stop|copy out)")); }
    static Dictionary<Account, double> ConnectedSince() { return (Dictionary<Account, double>)typeof(ChartBridgeOrders).GetField("ConnectedSince", PS).GetValue(null); }
    static Order OwnStop(Account a, Instrument inst, int qty, double price)
    {
        Order own = new Order { Account = a, Instrument = inst, OrderAction = OrderAction.Sell, OrderType = OrderType.StopMarket, Quantity = qty, StopPrice = price, Name = "own stop", OrderState = OrderState.Working };
        a.Orders.Add(own);
        return own;
    }

    static void Review2()
    {
        Msg("copierFollower", Follower("SIM-F1", "true", "1", "micro", "null"));
        Msg("copierFollower", Follower("SIM-F3", "false", "1", "micro", "null"));
        LateFillAfterFlatten(true);
        LateFillAfterFlatten(false);
        LateFillThatShows();
        ReduceOnlyTheCopierShare();
        ScaleOutToZeroKeepsOwn();
        StopSizedToWhatIsHeld();
        FillDuringFlatten();     // review 3 A
        CancelPendingCovers();   // review 3 A
        StopResync();
        SweepNeedsSteadyFlatTwice();
        FlatOutsideCancelsAtOnce();   // minors (1)
        ExpiredFillHoldsTrim();       // minors (2)
        Msg("copierFollower", Follower("SIM-F1", "true", "3", "micro", "null"));
        Msg("copierFollower", Follower("SIM-F3", "true", "1", "micro", "null"));
    }

    // Two leader entries of 1 (0.4.3: a fixed quantity; the second, an add, copies SIM-F1's 1 again); SIM-F1's first copy fills
    // and gets its stop; its second copy's fill is still on its way when the leader's stops fill. The copier's close cancels
    // everything working there first (its stop and the second copy) and waits. Returns the second copy (null: setup failed).
    static Order TwoIncrementsThenLeaderFlat()
    {
        ChartBridgeOrders.NoteLast("MNQ", 25000); ChartBridgeOrders.NoteLast("NQ", 25000);
        Msg("order", Leader("\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order e = lead.Orders.Last();
        Fill(lead, e, 1, 25000); Pos(lead, mnq, 1);
        Order fe1 = CopyEntry(f1);
        if (fe1 == null) { Check(false, "review 2: SIM-F1 got the first copy"); return null; }
        Fill(f1, fe1, 1, 25000); Pos(f1, mnq, 1);
        Msg("order", Leader("\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order e2 = lead.Orders.Last(o => (o.Name ?? "").Contains(" s8 t16") && ChartBridgeOrders.IsWorking(o.OrderState));
        Fill(lead, e2, 1, 25000); Pos(lead, mnq, 2);
        Order fe2 = CopyEntry(f1);
        Check(fe2 != null && fe2 != fe1, "review 2: SIM-F1 has a second copy entry working (its fill on its way)");
        int b = f1.Calls.Count;
        foreach (Order s in lead.Orders.Where(o => (o.Name ?? "").Contains(" stop ") && ChartBridgeOrders.IsWorking(o.OrderState)).ToList()) Fill(lead, s, s.Quantity, 24998);
        Pos(lead, mnq, 0);
        List<string> c = After(f1, b);
        Check(c.Count == 2 && c.All(x => x.StartsWith("cancel ")) && c.Contains("cancel " + fe2.Name) && Closes(f1, b).Count == 0,
              "review 2 (0.4.3): the leader is flat: SIM-F1's stop and its working second copy are cancelled first; nothing is closed yet: " + string.Join(" | ", c));
        // NinjaTrader confirms the stop's cancel; the second copy's fill is still on its way (its cancel loses the race)
        foreach (Order o in f1.Orders.Where(o => ChartBridgeOrders.IsWorking(o.OrderState) && o != fe2).ToList()) { o.OrderState = OrderState.Cancelled; Update(f1, o); }
        Check(Closes(f1, b).Count == 0, "review 2 (0.4.3): no close while the second copy may still fill");
        return fe2;
    }

    // Finding 1: a late follower fill after the copier already flattened it sends nothing (no market exit, no lone stop).
    static void LateFillAfterFlatten(bool levelTraded)
    {
        Order fe2 = TwoIncrementsThenLeaderFlat();
        if (fe2 == null) { Reset(); return; }
        ChartBridgeOrders.NoteLast("MNQ", levelTraded ? 24997 : 24999);
        int b = f1.Calls.Count;
        sent.Clear();
        Fill(f1, fe2, 1, 25000);   // the second copy's fill arrives late (its cancel lost the race)
        ChartBridgeCopier.Tick(Now());
        List<string> late = After(f1, b);
        Check(late.Count == 0, "review 2 finding 1 (" + (levelTraded ? "stop level traded" : "stop level not traded") + "): a late fill on a follower being closed gets no stop and no exit of its own; nothing is sent while its position update is on its way: " + string.Join(" | ", late));
        Check(Logged("arrived after the copier had flattened this follower"), "review 2 finding 1: the late fill is logged");
        Pos(f1, mnq, 2);   // its position update lands: both readings agree on 2
        ChartBridgeCopier.Tick(Now());
        List<string> c = Closes(f1, b);
        Check(c.Count == 1 && c[0].Contains("Sell Market 2 ") && !After(f1, b).Any(x => x.Contains(" stop ") || x.Contains(" exit ")), "0.4.3: then the close takes all it holds, the late contract too (2), and nothing else: " + string.Join(" | ", After(f1, b)));
        Reset();
    }

    // Finding 1: the late contract does show in the follower's position (the leader flat): "flatten this follower", only what is held.
    static void LateFillThatShows()
    {
        Order fe2 = TwoIncrementsThenLeaderFlat();
        if (fe2 == null) { Reset(); return; }
        Pos(f1, mnq, 2);   // the late contract reaches the position before its order event
        ChartBridgeOrders.NoteLast("MNQ", 24999);
        int b = f1.Calls.Count;
        Check(Closes(f1, b).Count == 0, "0.4.3: the position shows it, but its fill has not come through: nothing closed yet");
        Fill(f1, fe2, 1, 25000);
        List<string> c = Closes(f1, b);
        Check(c.Count == 1 && c[0].Contains("Sell Market 2 ") && !After(f1, b).Any(x => x.Contains(" stop ") || x.Contains(" exit ") || x.StartsWith("flatten")),
              "review 2 finding 1: a late fill that shows in the position, the leader flat: closed with what it holds (2), never a stop or an exit sized from the fill: " + string.Join(" | ", After(f1, b)));
        Reset();
    }

    // Finding 2: SIM-F1 holds 1 of its own (its own stop) plus 2 copied; the leader goes 2 to 1: the copier sells 1 (its own share),
    // its stop shrinks first, and SIM-F1's sell stops never exceed its position.
    static void ReduceOnlyTheCopierShare()
    {
        Msg("copierFollower", Follower("SIM-F1", "true", "2", "micro", "null"));   // 0.4.3: its fixed 2 for this test
        Pos(f1, mnq, 1); Booked();
        Order own = OwnStop(f1, mnq, 1, 24990);
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Msg("order", Leader("\"side\":\"buy\",\"kind\":\"market\",\"qty\":2,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order e = lead.Orders.Last();
        Fill(lead, e, 2, 25000); Pos(lead, mnq, 2);
        Order fe = CopyEntry(f1);
        Check(fe != null && fe.Quantity == 2, "review 2 finding 2: SIM-F1 (holding 1 of its own) gets a copy of 2");
        if (fe == null) { Reset(); return; }
        Fill(f1, fe, 2, 25000); Pos(f1, mnq, 3);
        Order cs = CopierStop(f1);
        Check(cs != null && cs.Quantity == 2 && cs.StopPrice == 24998, "review 2 finding 2: its copier stop covers the 2 copied, at the leader's 24998");
        if (cs == null) { Reset(); return; }
        Booked();
        int b = f1.Calls.Count;
        Order target = lead.Orders.Last(o => Regex.IsMatch(o.Name ?? "", " target "));
        Fill(lead, target, 1, 25004); Pos(lead, mnq, 1);
        List<string> first = After(f1, b);
        Check(first.Count == 1 && first[0].StartsWith("change " + cs.Name) && first[0].EndsWith(" Q1"), "review 2 finding 2: the copier stop shrinks to 1 first, nothing else yet: " + string.Join(" | ", first));
        cs.Quantity = 1; Update(f1, cs);   // NinjaTrader confirms
        List<string> c = After(f1, b);
        Order reduce = f1.Orders.LastOrDefault(o => (o.Name ?? "").EndsWith(" copy out"));
        Check(reduce != null && reduce.Quantity == 1 && c.Count == 2 && Regex.IsMatch(c[1], "^submit CB#[0-9a-f]{8} copy out Sell Market 1 "), "review 2 finding 2: the scale-out sells 1, the copier's own share (never SIM-F1's own contract): " + string.Join(" | ", c));
        int left = 3 - (reduce != null ? reduce.Quantity : 0);
        Check(SellStops(f1, mnq) <= left && own.Quantity == 1 && ChartBridgeOrders.IsWorking(own.OrderState) && !c.Any(x => x.Contains("own stop")),
              "review 2 finding 2: SIM-F1's sell stops (" + SellStops(f1, mnq) + ") never exceed its position (" + left + "); its own stop is never touched");
        Reset();
        Msg("copierFollower", Follower("SIM-F1", "true", "1", "micro", "null"));
    }

    // Finding 2: the copier's whole share closes on a scale-out while SIM-F1 also holds its own contract: a reduce of the share
    // (its copier stop cancelled first), never NinjaTrader's Flatten (which would close SIM-F1's own contract too).
    static void ScaleOutToZeroKeepsOwn()
    {
        Pos(f1, mnq, 1); Booked();
        Order own = OwnStop(f1, mnq, 1, 24990);
        // 0.4.3: a fixed quantity: the leader buys 3, SIM-F1 (qty 1) gets its 1; the leader's 3 to 1 takes it to 0 (a third of
        // 1 rounds to 0)
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Msg("order", Leader("\"side\":\"buy\",\"kind\":\"market\",\"qty\":3,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order e = lead.Orders.Last();
        Fill(lead, e, 3, 25000); Pos(lead, mnq, 3);
        Order fe = CopyEntry(f1);
        if (fe == null || fe.Quantity != 1) { Check(false, "review 2 finding 2: SIM-F1 got a copy of 1"); Reset(); return; }
        Fill(f1, fe, 1, 25000); Pos(f1, mnq, 2);
        Order cs = CopierStop(f1);
        Booked();
        int b = f1.Calls.Count;
        Order target = lead.Orders.First(o => Regex.IsMatch(o.Name ?? "", " target ") && ChartBridgeOrders.IsWorking(o.OrderState));
        Fill(lead, target, 2, 25004); Pos(lead, mnq, 1);
        Check(cs != null && After(f1, b).SequenceEqual(new[] { "cancel " + cs.Name }), "review 2 finding 2: the copier's whole share closes: its copier stop is cancelled first, no Flatten: " + string.Join(" | ", After(f1, b)));
        if (cs != null) { cs.OrderState = OrderState.Cancelled; Update(f1, cs); }
        List<string> c = After(f1, b);
        Check(c.Count == 2 && Regex.IsMatch(c[1], "^submit CB#[0-9a-f]{8} copy out Sell Market 1 ") && !c.Contains("flatten MNQ 12-26") && ChartBridgeOrders.IsWorking(own.OrderState),
              "review 2 finding 2: then a reduce of 1 (the copier's share); SIM-F1's own contract and its own stop stay: " + string.Join(" | ", c));
        Reset();
    }

    // Finding 1 and review 3 B: a follower's stop goes at once, in the same event as its fill, sized to the fill capped by the
    // larger reading on that side minus the copier's stops; shrunk to what it holds once both readings agree; nothing when it
    // holds the other side.
    static void StopSizedToWhatIsHeld()
    {
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Msg("order", Leader("\"side\":\"buy\",\"kind\":\"market\",\"qty\":2,\"bracket\":{\"stop\":8,\"target\":16}"));
        Fill(lead, lead.Orders.Last(), 2, 25000); Pos(lead, mnq, 2);
        Order fe = CopyEntry(f1);
        if (fe == null) { Check(false, "review 2: SIM-F1 got a copy of 2"); Reset(); return; }
        int b = f1.Calls.Count;
        Fill(f1, fe, 2, 25000);   // the fill's order event; its position update has not landed
        List<string> c = After(f1, b);
        Check(c.Count == 1 && Regex.IsMatch(c[0], "^submit CB#[0-9a-f]{8} stop f2 q2 p25000 Sell StopMarket 2 L0 S24998 "), "review 3 B: the stop is at the broker within the same event as the fill (sized from the larger reading, 2): " + string.Join(" | ", c));
        Order fs = CopierStop(f1);
        Pos(f1, mnq, 1);   // the position shows 1: the other was closed in NinjaTrader at once
        Check(After(f1, b).Count == 1, "review 3 B: while the readings differ (1 and 2) the stop is left as it is");
        Booked();
        ChartBridgeCopier.Tick(Now());
        c = After(f1, b);
        Check(fs != null && c.Count == 2 && c[1].StartsWith("change " + fs.Name) && c[1].EndsWith(" Q1") && EventSaid("stop", "SIM-F1", "shrunk to what it holds, 1"),
              "review 3 B: once both readings agree on 1, the copier stop shrinks to 1 (never above the position): " + string.Join(" | ", c));
        if (fs != null) { fs.Quantity = 1; Update(f1, fs); }
        ChartBridgeCopier.Tick(Now());
        Check(After(f1, b).Count == 2 && SellStops(f1, mnq) <= 1, "review 3 B: shrunk once; the stops stay within the position");
        Reset();

        // a hand edit in NinjaTrader makes the two readings disagree: the stop still goes at once
        LeaderEntry(1);
        fe = CopyEntry(f1);
        if (fe == null) { Check(false, "review 2: SIM-F1 got a copy of 1"); Reset(); return; }
        Pos(f1, mnq, 2);   // SIM-F1 bought 2 by hand; that fill's order event has not come
        b = f1.Calls.Count;
        Fill(f1, fe, 1, 25000);
        bool differ = ChartBridgeOrders.CopierListed(f1, mnq) != ChartBridgeOrders.CopierEffective(f1, mnq);
        c = After(f1, b);
        Check(differ && c.Count == 1 && Regex.IsMatch(c[0], "^submit CB#[0-9a-f]{8} stop f1 q1 p25000 Sell StopMarket 1 L0 S24998 "), "review 3 B: readings that disagree (a hand edit) do not delay the stop: " + string.Join(" | ", c));
        Reset();

        // the other way: SIM-F1 is short when its copy's fill is reported: nothing is sent
        LeaderEntry(1);
        fe = CopyEntry(f1);
        if (fe == null) { Check(false, "review 2: SIM-F1 got a copy of 1"); Reset(); return; }
        b = f1.Calls.Count;
        Pos(f1, mnq, -1); Booked();
        Fill(f1, fe, 1, 25000);
        ChartBridgeCopier.Tick(Now());
        Check(After(f1, b).Count == 0 && Logged("holds the other side"), "review 2 finding 1: a follower holding the other side gets no stop and no exit from a copy's fill: " + string.Join(" | ", After(f1, b)));
        Reset();
    }

    // 0.4.3: two leader entries of 1 (an add copies SIM-F1's 1 again): SIM-F1's first copy filled (with its stop), its second
    // copy working. False (with a failed check) when the setup failed.
    static bool TwoEntries(out Order fe1, out Order fe2, string what)
    {
        fe2 = null;
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Msg("order", Leader("\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Fill(lead, lead.Orders.Last(), 1, 25000); Pos(lead, mnq, 1);
        fe1 = CopyEntry(f1);
        if (fe1 == null) { Check(false, what + ": SIM-F1 got the first copy"); return false; }
        Fill(f1, fe1, 1, 25000); Pos(f1, mnq, 1);
        Msg("order", Leader("\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order e2 = lead.Orders.Last(o => (o.Name ?? "").Contains(" s8 t16") && ChartBridgeOrders.IsWorking(o.OrderState));
        Fill(lead, e2, 1, 25000); Pos(lead, mnq, 2);
        fe2 = CopyEntry(f1);
        if (fe2 == null || fe2 == fe1) { Check(false, what + ": SIM-F1 got the second copy (the leader's add)"); return false; }
        return true;
    }

    // Review 3 A: a fill event handled while the copier's Flatten runs (recorded before it, protected after it) is late: no stop
    // after NinjaTrader's Flatten.
    static void FillDuringFlatten()
    {
        Order fe1, fe2;
        if (!TwoEntries(out fe1, out fe2, "review 3 A")) { Reset(); return; }
        ChartBridgeCopier.HarnessQueued = new List<Action>();   // the copier thread is busy: work waits, in order
        foreach (Order s in lead.Orders.Where(o => (o.Name ?? "").Contains(" stop ") && ChartBridgeOrders.IsWorking(o.OrderState)).ToList()) Fill(lead, s, s.Quantity, 24998);
        Pos(lead, mnq, 0);                 // queued: the leader's exit, which flattens SIM-F1
        Fill(f1, fe2, 1, 25000);           // SIM-F1's second fill is handled now: queued after the exit
        int b = f1.Calls.Count;
        ChartBridgeCopier.HarnessRunQueued();   // the close starts, then that fill's protection
        List<string> c = After(f1, b);
        Check(c.Count > 0 && c[0].StartsWith("cancel ") && !c.Any(x => x.StartsWith("flatten")) && !SendsExitOrStop(c) && Logged("flattened while its fill was being handled"),
              "review 3 A: a fill handled while the close started is late: no stop or exit of its own (0.4.3: the close takes it): " + string.Join(" | ", c));
        ConfirmCancels(f1, b); Pos(f1, mnq, 2);
        ChartBridgeCopier.Tick(Now());
        Check(Closes(f1, b).Count == 1 && Closes(f1, b)[0].Contains("Sell Market 2 "), "0.4.3: the close then sells the 2 it holds: " + string.Join(" | ", After(f1, b)));
        Reset();
    }

    // Review 3 A: a copier stop whose cancel is still pending counts as cover (it may still fill).
    static void CancelPendingCovers()
    {
        LeaderEntry(1);
        FollowerFill(f1, mnq, 25000);
        Order s1 = CopierStop(f1);
        if (s1 == null) { Check(false, "review 3 A: SIM-F1 has its copier stop"); Reset(); return; }
        s1.OrderState = OrderState.CancelPending;   // its cancel was sent; NinjaTrader has not confirmed
        Pos(f1, mnq, 0); Booked();                  // its contract closed in NinjaTrader
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        Msg("order", Leader("\"side\":\"buy\",\"kind\":\"market\",\"qty\":2,\"bracket\":{\"stop\":8,\"target\":16}"));
        Order e = lead.Orders.Last();
        Fill(lead, e, 2, 25000); Pos(lead, mnq, 3);
        Order fe = CopyEntry(f1);
        if (fe == null) { Check(false, "review 3 A: SIM-F1 got a copy of 2"); Reset(); return; }
        int b = f1.Calls.Count;
        Fill(f1, fe, 2, 25000);
        List<string> c = After(f1, b);
        Check(c.Count == 1 && Regex.IsMatch(c[0], " Sell StopMarket 1 L0 S24998 "), "review 3 A: SIM-F1 holds 2 with a copier stop for 1 still being cancelled: the new stop is for 1 (the pending one counts): " + string.Join(" | ", c));
        Reset();
    }

    // Finding 4: the follower stop records the price it was placed at; a leader stop event re-syncs a follower stop whose price differs.
    static void StopResync()
    {
        LeaderEntry(1);
        Order ls = LeaderStop();
        if (ls == null) { Check(false, "review 2: the leader has a stop"); Reset(); return; }
        ls.StopPrice = 24999; ls.OrderState = OrderState.Unknown;   // NinjaTrader is moving the leader's stop: no event yet
        FollowerFill(f1, mnq, 25000);
        Order fs = CopierStop(f1);
        Check(fs != null && fs.StopPrice == 24998, "review 2 finding 4: SIM-F1's stop went at the leader's last known stop 24998");
        int b = f1.Calls.Count;
        ls.OrderState = OrderState.Working; Update(lead, ls);   // the leader's stop event: 24999
        Check(fs != null && After(f1, b).Any(x => x.StartsWith("change " + fs.Name) && x.Contains(" S24999 ")), "review 2 finding 4: the leader's stop event re-syncs SIM-F1's stop to 24999 (it differs from the price it was placed at): " + string.Join(" | ", After(f1, b)));
        Reset();
    }

    // Finding 5: the sweep cancels only on a follower connection that has been steady (v2's flat cleanup rule), flat twice.
    static void SweepNeedsSteadyFlatTwice()
    {
        LeaderEntry(1);
        FollowerFill(f1, mnq, 25000);
        Order fs = CopierStop(f1);
        if (fs == null) { Check(false, "review 2: SIM-F1 has its copier stop"); Reset(); return; }
        Pos(f1, mnq, 0); Booked();   // SIM-F1 closed in NinjaTrader: its copier stop is left on a flat follower
        ConnectedSince()[f1] = Now();   // its connection only just came back
        int b = f1.Calls.Count;
        double t = Now() + ChartBridgeOrders.YoungMs + 100;
        ChartBridgeCopier.Tick(t); ChartBridgeCopier.Tick(t + 1100);
        Check(After(f1, b).Count == 0, "review 2 finding 5: the sweep does not act on a connection that is not steady yet");
        ConnectedSince()[f1] = 0;   // steady
        ChartBridgeCopier.Tick(t + 2200);
        Check(After(f1, b).Count == 0, "review 2 finding 5: one flat reading on a steady connection: not yet");
        ChartBridgeCopier.Tick(t + 3300);
        Check(After(f1, b).SequenceEqual(new[] { "cancel " + fs.Name }), "review 2 finding 5: flat twice on a steady connection: the copier stop is cancelled: " + string.Join(" | ", After(f1, b)));
        Reset();
    }

    // Minors (1): a copy's fill, then the follower flattened OUTSIDE ChartBridge (by hand, or a prop firm's liquidation) while its
    // copier stop is still young: once both readings agree it is flat on a steady connection, the copier stop is cancelled at
    // once (not 3 to 5 s later by the sweep), and logged. Not on a connection that is not steady (the sweep's, later).
    static void FlatOutsideCancelsAtOnce()
    {
        foreach (bool steady in new[] { false, true })
        {
            LeaderEntry(1);
            Order fe = CopyEntry(f1);
            if (fe == null) { Check(false, "minors (1): SIM-F1 got a copy of 1"); Reset(); return; }
            Fill(f1, fe, 1, 25000); Pos(f1, mnq, 1);
            Order fs = CopierStop(f1);
            if (!steady) ConnectedSince()[f1] = Now();
            int b = f1.Calls.Count;
            sent.Clear();
            Order liq = new Order { Account = f1, Instrument = mnq, OrderAction = OrderAction.Sell, OrderType = OrderType.Market, Quantity = 1, Name = "Close", OrderState = OrderState.Working };
            f1.Orders.Add(liq);
            Fill(f1, liq, 1, 24999); Pos(f1, mnq, 0);   // the liquidation's fill, then the position: flat by both readings
            List<string> c = After(f1, b);
            if (steady)
                Check(fs != null && c.SequenceEqual(new[] { "cancel " + fs.Name }) && EventSaid("sweep", "SIM-F1", "flat by both readings (closed outside ChartBridge): its copier stops and exits cancelled at once"),
                      "minors (1): flattened outside ChartBridge on a steady connection: the young copier stop is cancelled at once, and logged: " + string.Join(" | ", c));
            else
                Check(c.Count == 0, "minors (1): a connection that is not steady: nothing at once (the sweep's, later): " + string.Join(" | ", c));
            ConnectedSince()[f1] = 0;
            Reset();
        }
    }

    // Minors (2): a copy's fill whose position update lags past 10 s (NinjaTrader's) expires from the second reading. The copier
    // stops are never shrunk below the larger reading while a copy fill is unbooked; an expired one raises a status warn and
    // holds the trim until a fresh position update arrives.
    static void ExpiredFillHoldsTrim()
    {
        Order fe1, fe2;
        if (!TwoEntries(out fe1, out fe2, "minors (2)")) { Reset(); return; }
        int b = f1.Calls.Count;
        Fill(f1, fe2, 1, 25000);   // its position update does not come
        Check(SellStops(f1, mnq) == 2, "minors (2): set up: two copier stops for the two fills (" + SellStops(f1, mnq) + ")");
        var moves = (Dictionary<string, List<double[]>>)typeof(ChartBridgeOrders).GetField("Moves", PS).GetValue(null);
        lock (moves) foreach (List<double[]> l in moves.Values) foreach (double[] m in l) m[1] -= ChartBridgeOrders.MoveTtlMs + 1000;   // 11 s ago
        sent.Clear();
        ChartBridgeCopier.Tick(Now());
        ChartBridgeCopier.Tick(Now() + 1000);
        List<string> c = After(f1, b);
        Check(c.Count == 1 && c[0].StartsWith("submit ") && SellStops(f1, mnq) == 2, "minors (2): an expired unbooked copy fill: the copier stops are not shrunk below what it really holds: " + string.Join(" | ", c));
        Check(sent.Count(m => m.StartsWith("{\"type\":\"status\"") && m.Contains("\"level\":\"warn\"") && m.Contains("MNQ SIM-F1: a copied fill's position update has not come in 10 s")) == 1,
              "minors (2): and a status warn, once");
        Pos(f1, mnq, 2);   // the fresh position update
        ChartBridgeCopier.Tick(Now() + 2000);
        Check(After(f1, b).Count == 1 && SellStops(f1, mnq) == 2, "minors (2): the fresh position update books it: the stops stay at what it holds: " + string.Join(" | ", After(f1, b)));
        Reset();
    }

    // Finding 6: after a restart, a copy whose leader entry is gone; and a recovered stop re-synced to the leader's stop.
    static void RecoveredWithoutLeader()
    {
        Order fent = new Order { Account = f1, Instrument = mnq, OrderAction = OrderAction.Buy, OrderType = OrderType.Market, Quantity = 1, Filled = 1, AverageFillPrice = 25000, Name = "CB#aaaa1111 copy bbbb2222", OrderState = OrderState.Filled };
        Order fstop = new Order { Account = f1, Instrument = mnq, OrderAction = OrderAction.Sell, OrderType = OrderType.StopMarket, Quantity = 1, StopPrice = 24990, Name = "CB#aaaa1111 stop f1 q1 p25000", OrderState = OrderState.Working };
        f1.Orders.Add(fent); f1.Orders.Add(fstop);
        ChartBridgeOrders.SeedNoted(f1);   // 0.4.3: as when ChartBridge starts watching the account: fills from before are in its position
        Pos(f1, mnq, 1); Pos(lead, nq, 1); Booked();   // the leader holds NQ, the same market
        ChartBridgeCopier.Start();
        Msg("client", "{\"type\":\"client\",\"v\":3}");
        sent.Clear();
        double t = Now();
        ChartBridgeCopier.Tick(t);
        const string said = "SIM-F1: copied position recovered without its leader; only its own stop protects it";
        Check(EventSaid("recovered", "SIM-F1", said) && sent.Any(m => m.StartsWith("{\"type\":\"status\"") && m.Contains("\"level\":\"warn\"") && m.Contains(said)),
              "review 2 finding 6: a copy recovered without its leader: the page is told plainly (copierEvent and a status warn)");
        int b = f1.Calls.Count;
        ChartBridgeCopier.Tick(t + 1000); ChartBridgeCopier.Tick(t + 1000 + ChartBridgeOrders.SettleMs + 100);
        Check(f1.Calls.Count == b, "review 2 finding 6: while the leader holds NQ (the same root family) it is not flattened");
        Pos(lead, nq, 0); Booked();
        double t2 = t + 2 * ChartBridgeOrders.SettleMs;
        ChartBridgeCopier.Tick(t2); ChartBridgeCopier.Tick(t2 + ChartBridgeOrders.SettleMs + 100);
        Check(After(f1, b).SequenceEqual(new[] { "cancel " + fstop.Name }) && EventSaid("flatten", "SIM-F1", "the leader has been flat"),
              "review 2 finding 6: in the missed-exit check by root: the leader flat on MNQ and NQ for 4 s: closed (the zero rule), its stop cancelled first: " + string.Join(" | ", After(f1, b)));
        Check(ClosedAfterConfirm(f1, b, "Sell Market 1 "), "review 2 finding 6: ...then the 1 it holds is sold");
        fstop.OrderState = OrderState.Cancelled;
        Pos(f1, mnq, 0); Booked();
        ChartBridgeCopier.Stop();

        // a recovered follower stop whose leader stop is at another price follows it at once
        Order lent = new Order { Account = lead, Instrument = mnq, OrderAction = OrderAction.Buy, OrderType = OrderType.Market, Quantity = 1, Filled = 1, AverageFillPrice = 25000, Name = "CB#dddd4444 s8 t16", OrderState = OrderState.Filled };
        Order lstop = new Order { Account = lead, Instrument = mnq, OrderAction = OrderAction.Sell, OrderType = OrderType.StopMarket, Quantity = 1, StopPrice = 24995, Name = "CB#dddd4444 stop f1 q1 p25000", OrderState = OrderState.Working };
        lead.Orders.Add(lent); lead.Orders.Add(lstop);
        Order fent2 = new Order { Account = f1, Instrument = mnq, OrderAction = OrderAction.Buy, OrderType = OrderType.Market, Quantity = 1, Filled = 1, AverageFillPrice = 25000, Name = "CB#cccc3333 copy dddd4444", OrderState = OrderState.Filled };
        Order fstop2 = new Order { Account = f1, Instrument = mnq, OrderAction = OrderAction.Sell, OrderType = OrderType.StopMarket, Quantity = 1, StopPrice = 24990, Name = "CB#cccc3333 stop f1 q1 p25000", OrderState = OrderState.Working };
        f1.Orders.Add(fent2); f1.Orders.Add(fstop2);
        ChartBridgeOrders.SeedNoted(f1); ChartBridgeOrders.SeedNoted(lead);   // 0.4.3: as when ChartBridge starts watching the accounts
        Pos(lead, mnq, 1); Pos(f1, mnq, 1); Booked();
        ChartBridgeCopier.Start();
        Msg("client", "{\"type\":\"client\",\"v\":3}");
        int c = f1.Calls.Count;
        ChartBridgeCopier.Tick(Now());
        Check(After(f1, c).Any(x => x.StartsWith("change " + fstop2.Name) && x.Contains(" S24995 ")), "review 2 finding 6: a recovered follower stop re-syncs to the leader's current stop price (24990 to 24995): " + string.Join(" | ", After(f1, c)));
        lstop.OrderState = OrderState.Cancelled; fstop2.OrderState = OrderState.Cancelled;
        Pos(lead, mnq, 0); Pos(f1, mnq, 0); Booked();
        ChartBridgeCopier.Stop();
    }

    // ------------------------------------------------------------ copier.txt, copier.log, a restart
    static void FilesAndRestart()
    {
        // a copy left open across a restart: its follower stop is taken back and follows the leader's again
        Order le = LeaderEntry(1);
        FollowerFill(f1, mnq, 25000);
        Order fstop = f1.Orders.Last();
        ChartBridgeCopier.Stop();
        string log = File.ReadAllText(Path.Combine(NinjaTrader.Core.Globals.UserDataDir, "ChartBridge", "copier.log"));
        Check(log.Split('\n').Any(l => l.Contains("\tSIM-F1\tenter\tMNQ\t3\t") && Regex.IsMatch(l, "\tenter\tMNQ\t3\t-\t-\t[0-9.]+\t-\t")), "copier.log: one line per decision, with leaderMs");
        Check(log.Contains("\tstandDown\t") && log.Contains("\tSIM-F1\tstop\tMNQ\t3\t24998\t0\t"), "copier.log: stop (price, slippage) and stand-down lines");
        ChartBridgeCopier.Start();
        Msg("client", "{\"type\":\"client\",\"v\":3}");
        sent.Clear(); Msg("copierGet", "{\"type\":\"copierGet\"}");
        Check(State().Contains("\"armed\":false,\"standDownWhy\":\"ChartBridge started: check the accounts and press Re-arm\"") && State().Contains("\"leader\":{\"account\":\"Sim101\"") &&
              State().Contains("{\"account\":\"SIM-F1\",\"sim\":true,\"on\":true,\"qty\":3"), "after a restart: settings read back from copier.txt, stood down");
        ChartBridgeCopier.Tick(Now());
        Check(Logged("copier recovered SIM-F1 MNQ: a copier stop at 24998 taken back after a restart; it follows the leader's stop"), "after a restart: the follower's working copier stop is taken back");
        int b1 = f1.Calls.Count;
        Order ls = LeaderStop();
        ls.StopPrice = 24999; Update(lead, ls);
        Check(After(f1, b1).Any(x => x == "change " + fstop.Name + " L0 S0 Q0" || (x.StartsWith("change " + fstop.Name) && x.Contains("S24999"))), "after a restart: it follows the leader's stop again (stood down or not)");
        Fill(lead, ls, 1, 24999); Pos(lead, mnq, 0);
        Check(ClosedAfterConfirm(f1, b1, "Sell Market 3 "), "after a restart: the leader's exit is copied to it (its stop cancelled, then the 3 sold): " + string.Join(" | ", After(f1, b1)));
        Reset();
        // a working copier entry from before the restart is cancelled (it could not be linked to the leader's, and would get no stop)
        Order stale = new Order { Account = f3, Instrument = mnq, OrderAction = OrderAction.Buy, OrderType = OrderType.Limit, Quantity = 1, LimitPrice = 24900, Name = "CB#0badc0de copy 12345678", OrderState = OrderState.Working };
        f3.Orders.Add(stale);
        int c3 = f3.Calls.Count;
        ChartBridgeCopier.Tick(Now());
        Check(After(f3, c3).SequenceEqual(new[] { "cancel CB#0badc0de copy 12345678" }), "after a restart: a working copier entry from before is cancelled");
        stale.OrderState = OrderState.Cancelled;
        ChartBridgeCopier.Stop();

        // copier.txt that cannot be read: nothing is kept, the file is never rewritten, settings refused, Re-arm refused
        string path = Path.Combine(NinjaTrader.Core.Globals.UserDataDir, "ChartBridge", "copier.txt");
        string before = File.ReadAllText(path);
        ChartBridgeCopier.ReadFault = () => "locked by an antivirus";
        ChartBridgeCopier.Start();
        Msg("client", "{\"type\":\"client\",\"v\":3}");
        sent.Clear();
        Msg("copierSet", "{\"type\":\"copierSet\",\"leader\":\"Sim101\"}");
        Msg("copierRearm", "{\"type\":\"copierRearm\"}");
        Check(Rejected("copier.txt could not be read at start") && Logged("copier.txt could not be read (locked by an antivirus)") && File.ReadAllText(path) == before && ChartBridgeCopier.DiagJson().Contains("\"settingsReadFailed\":true"),
              "copier.txt unreadable: settings refused, never rewritten, stood down, /diag says so");
        ChartBridgeCopier.ReadFault = null;
        ChartBridgeCopier.Stop();

        // a failed save: in force, loud, saved again on the next tick
        ChartBridgeCopier.Start();
        Msg("client", "{\"type\":\"client\",\"v\":3}");
        ChartBridgeCopier.WriteFault = () => "disk full";
        Msg("copierFollower", Follower("SIM-F4", "true", "2", "micro", "null"));
        Check(Logged("copier.txt could not be saved (disk full)") && State().Contains("{\"account\":\"SIM-F4\",\"sim\":true,\"on\":true,\"qty\":2"), "a failed save: the setting is in force, with an alarm");
        ChartBridgeCopier.WriteFault = null;
        ChartBridgeCopier.Tick(Now());
        Check(File.ReadAllText(path).Contains("follower\tSIM-F4\ton\t2\tmicro\t0") && Logged("copier.txt is saved now"), "saved again on the next tick");
        Msg("copierFollower", Follower("SIM-F4", "false", "1", "micro", "null"));
        ChartBridgeCopier.Stop();
    }

    // ------------------------------------------------------------ the real copier thread and timer (as in NinjaTrader)
    static void CopierThread()
    {
        ChartBridgeCopier.HarnessManual = false;
        ChartBridgeCopier.Start();
        Msg("client", "{\"type\":\"client\",\"v\":3}");
        Msg("copierRearm", "{\"type\":\"copierRearm\"}");
        int b1 = f1.Calls.Count;
        LeaderEntry(1);
        Check(ChartBridgeCopier.WaitIdle(5000) && After(f1, b1).Count == 1 && After(f1, b1)[0].Contains("Buy Market 3"), "on the copier thread: the leader's fill is copied");
        FollowerFill(f1, mnq, 25000);
        Check(ChartBridgeCopier.WaitIdle(5000) && After(f1, b1).Count == 2 && After(f1, b1)[1].Contains("Sell StopMarket 3 L0 S24998"), "on the copier thread: the follower's stop follows its fill");
        int x1 = f1.Calls.Count;
        Fill(lead, LeaderStop(), 1, 24998); Pos(lead, mnq, 0);
        Check(ChartBridgeCopier.WaitIdle(5000) && f1.Calls.Last().StartsWith("cancel "), "on the copier thread: the leader's exit is copied (its stop cancelled first)");
        ConfirmCancels(f1, x1);
        Check(ChartBridgeCopier.WaitIdle(5000) && Closes(f1, x1).Count == 1 && Closes(f1, x1)[0].Contains("Sell Market 3 "), "on the copier thread: ...then the 3 sold: " + string.Join(" | ", After(f1, x1)));
        foreach (Account a in new[] { lead, f1, f2, f3, f4 }) { Done(a); foreach (Instrument i in new[] { mnq, nq }) Pos(a, i, 0); }
        ChartBridgeCopier.Stop();
        Check(ChartBridgeCopier.WaitIdle(1000), "stop: the copier thread ends");
    }
}
