// ChartBridge 0.4.0 cross-lane rules on Mono (inside check:orders). Each order lane (accounts, Merge, the copier, the bot,
// Order Strategies) has its own harness; this one checks the rules that only hold when the lanes run together, through the
// real code of every lane at once. Made-up accounts and prices only.
//   X1 one v3 handshake: the accounts lane's "client" message makes a page v3 for every lane (Merge, the copier), and the
//      trading message's switches say exactly what each lane obeys (one source of truth: ChartBridgeSwitches).
//   X2 Merge on the copier's leader: the swap's orders are leg changes, never a new entry to copy; the follower whose
//      leader stop the swap cancelled follows the merged stop's price, and a later move of that stop moves every follower.
//   X3 the copier skips a Gone follower through the accounts lane's own Gone (one rule).
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript.AddOns;

public static class IntegrationHarness
{
    static Action<bool, string> Check;
    const BindingFlags PS = BindingFlags.NonPublic | BindingFlags.Static;
    static readonly List<string> sent = new List<string>();
    static ChartBridgeClient page;
    static Instrument mnq;
    static Account lead, f1;
    static string token;

    static ConcurrentDictionary<int, ChartBridgeClient> Clients() { return (ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", PS).GetValue(null); }
    static Dictionary<string, Instrument> Named() { return (Dictionary<string, Instrument>)typeof(ChartBridgeServer).GetField("Instruments", PS).GetValue(null); }
    static void Msg(string type, string json)
    {
        lock (page.Actions) page.Actions.Clear();
        if (type == "client") ChartBridgeAccounts.OnMessage(page, type, json);
        else if (type.StartsWith("copier")) ChartBridgeCopier.OnMessage(page, type, json);
        else ChartBridgeOrders.OnMessage(page, type, json);
    }
    static string IdOf(Order o) { return (string)typeof(ChartBridgeOrders).GetMethod("IdFor", PS).Invoke(null, new object[] { o }); }
    static string Last() { lock (sent) return sent.Count > 0 ? sent[sent.Count - 1] : ""; }
    static bool Rejected(string has) { lock (sent) return sent.Any(m => m.Contains("\"type\":\"reject\"") && m.Contains(has)); }
    static void Update(Account a, Order o) { ChartBridgeOrders.OnOrderUpdate(a, new OrderEventArgs { Order = o }); }
    static bool IsLive(Order o) { return o.OrderState != OrderState.Filled && o.OrderState != OrderState.Cancelled && o.OrderState != OrderState.Rejected; }
    static int PosOf(Account a) { Position p = a.Positions.FirstOrDefault(x => x.Instrument == mnq); return p == null ? 0 : p.MarketPosition == MarketPosition.Long ? p.Quantity : -p.Quantity; }
    static void SetPos(Account a, int signed)
    {
        a.Positions.RemoveAll(p => p.Instrument == mnq);
        Position pos = new Position { Instrument = mnq, MarketPosition = signed > 0 ? MarketPosition.Long : signed < 0 ? MarketPosition.Short : MarketPosition.Flat, Quantity = Math.Abs(signed), AveragePrice = 25000 };
        if (signed != 0) a.Positions.Add(pos);
        ChartBridgeOrders.OnPositionUpdate(a, new PositionEventArgs { Position = pos, MarketPosition = pos.MarketPosition, Quantity = pos.Quantity, AveragePrice = 25000 });
    }
    static List<Order> LiveStops(Account a) { lock (a.Orders) return a.Orders.Where(o => o.Instrument == mnq && IsLive(o) && (o.OrderType == OrderType.StopMarket || o.OrderType == OrderType.StopLimit)).ToList(); }
    static int CopyEntries(Account a) { lock (a.Orders) return a.Orders.Count(o => Regex.IsMatch(o.Name ?? "", "^CB#[0-9a-f]{8} copy [0-9a-f]{8}$")); }

    static Account NewAccount(string name, Provider provider)
    {
        Account a = new Account { Name = name, Connection = new Connection { Status = ConnectionStatus.Connected }, Provider = provider };
        lock (Account.All) Account.All.Add(a);
        ((Dictionary<Account, double>)typeof(ChartBridgeOrders).GetField("ConnectedSince", PS).GetValue(null))[a] = 0;   // steady since long ago
        a.OnCall = (kind, o) => Broker(a, kind, o);
        return a;
    }

    // The stand-in broker: a change takes the new price and quantity, a cancel cancels the order and its OCO partners, a
    // submit is reported; each with NinjaTrader's order event (as MergeHarness's broker).
    static void Broker(Account a, string kind, Order o)
    {
        if (kind == "change")
        {
            if (o.QuantityChanged > 0) o.Quantity = o.QuantityChanged;
            if (o.StopPriceChanged > 0) o.StopPrice = o.StopPriceChanged;
            if (o.LimitPriceChanged > 0) o.LimitPrice = o.LimitPriceChanged;
            Update(a, o);
        }
        else if (kind == "cancel")
        {
            if (IsLive(o)) { o.OrderState = OrderState.Cancelled; Update(a, o); }
            if (!string.IsNullOrEmpty(o.Oco))
                foreach (Order p in a.Orders.ToList()) if (p != o && p.Oco == o.Oco && IsLive(p)) { p.OrderState = OrderState.Cancelled; Update(a, p); }
        }
        else if (kind == "submit") Update(a, o);
    }

    // A leader market entry from the page with a bracket (stop 8, target 16 ticks), filled at `fill`; then the follower's copy
    // fills at the same price and gets its stop.
    static void LeaderEntry(double fill)
    {
        ChartBridgeOrders.NoteLast("MNQ", fill);
        int n;
        lock (lead.Orders) n = lead.Orders.Count;
        Msg("order", "{\"type\":\"order\",\"cid\":\"e\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}}");
        Order e;
        lock (lead.Orders) e = lead.Orders.Skip(n).FirstOrDefault(o => Regex.IsMatch(o.Name ?? "", "^CB#[0-9a-f]{8} s8 t16$"));
        if (e == null) { Check(false, "X2: the leader entry was sent: " + Last()); return; }
        e.Filled = 1; e.AverageFillPrice = fill; e.OrderState = OrderState.Filled;
        Update(lead, e);
        SetPos(lead, PosOf(lead) + 1);
        Order copy;
        lock (f1.Orders) copy = f1.Orders.LastOrDefault(o => Regex.IsMatch(o.Name ?? "", "^CB#[0-9a-f]{8} copy [0-9a-f]{8}$") && IsLive(o));
        if (copy == null) { Check(false, "X2: the follower got a copy of the leader's fill"); return; }
        copy.Filled = copy.Quantity; copy.AverageFillPrice = fill; copy.OrderState = OrderState.Filled;
        Update(f1, copy);
        SetPos(f1, PosOf(f1) + copy.Quantity);
    }

    static string WaitFor(int from, string has, int ms)
    {
        Stopwatch sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < ms)
        {
            lock (sent) for (int i = from; i < sent.Count; i++) { if (sent[i].Contains(has)) return sent[i]; if (sent[i].Contains("\"type\":\"reject\"")) return sent[i]; }
            Thread.Sleep(5);
        }
        return "";
    }

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        List<Account> accountsWas;
        lock (Account.All) accountsWas = Account.All.ToList();
        Dictionary<string, Instrument> instWas = new Dictionary<string, Instrument>(Named());
        string dirWas = NinjaTrader.Core.Globals.UserDataDir;
        string home = Path.Combine(Path.GetTempPath(), "cb-int-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(home, "ChartBridge"));
        int[] timings = { ChartBridgeOrders.MergeConfirmMs, ChartBridgeOrders.MergeQuietMs, ChartBridgeOrders.MergePollMs };
        try
        {
            NinjaTrader.Core.Globals.UserDataDir = home;
            lock (Account.All) Account.All.Clear();
            ChartBridgeOrders.Clear();
            ChartBridgeOrders.LoadPlansNow();
            mnq = new Instrument { FullName = "MNQ 12-26", MasterInstrument = new MasterInstrument { Name = "MNQ", TickSize = 0.25, PointValue = 2 } };
            Named().Clear(); Named()["MNQ"] = mnq;
            lead = NewAccount("Sim101", Provider.Simulator);
            f1 = NewAccount("SIM-F1", Provider.Simulator);
            ChartBridgeOrders.ResetConfig();
            ChartBridgeSwitches.Reset();
            ChartBridgeOrders.ReadConfig("trading", "true");
            ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, SIM-F1");
            ChartBridgeOrders.ReadConfig("maxQty.MNQ", "10");
            ChartBridgeOrders.MergeConfirmMs = 400; ChartBridgeOrders.MergeQuietMs = 100; ChartBridgeOrders.MergePollMs = 5;
            ChartBridgeOrders.NewToken();
            token = ChartBridgeOrders.SessionJson().Split('"')[3];
            page = new ChartBridgeClient(null, 71) { Origin = "http://localhost:8765" };
            page.Tap = s => { lock (sent) sent.Add(s); };
            Clients()[71] = page;
            ChartBridgeCopier.HarnessManual = true;
            foreach (Account a in new[] { lead, f1 }) SetPos(a, 0);

            OneHandshake();
            MergeOnTheLeader();
            GoneIsOneRule();
        }
        catch (Exception ex) { Check(false, "integration harness threw: " + ex); }
        finally
        {
            ChartBridgeCopier.Stop();
            ChartBridgeCopier.HarnessManual = false;
            ChartBridgeOrders.MergeConfirmMs = timings[0]; ChartBridgeOrders.MergeQuietMs = timings[1]; ChartBridgeOrders.MergePollMs = timings[2];
            ChartBridgeClient gone;
            Clients().TryRemove(71, out gone);
            ChartBridgeSwitches.Reset();
            ChartBridgeOrders.ResetConfig();
            ChartBridgeOrders.Clear();
            lock (Account.All) { Account.All.Clear(); Account.All.AddRange(accountsWas); }
            Named().Clear(); foreach (KeyValuePair<string, Instrument> kv in instWas) Named()[kv.Key] = kv.Value;
            NinjaTrader.Core.Globals.UserDataDir = dirWas;
        }
    }

    // ------------------------------------------------------------ X1: one v3 handshake, one source of truth for the switches
    static void OneHandshake()
    {
        Msg("auth", "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
        Check(page.Trader && !ChartBridgeV3.IsV3(page) && !Last().Contains("\"switches\""), "X1: a page that never sent client is a v2 page: no switches in its trading message");
        Msg("client", "{\"type\":\"client\",\"v\":3}");
        Check(ChartBridgeV3.IsV3(page), "X1: the accounts lane's client message makes the page v3 (the one handshake)");
        ChartBridgeSwitches.Note("merge", "on");
        ChartBridgeSwitches.Note("copier", "on");
        lock (sent) sent.Clear();
        Msg("auth", "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
        string trading;
        lock (sent) trading = sent.FirstOrDefault(m => m.StartsWith("{\"type\":\"trading\"")) ?? "";
        Check(trading.Contains("\"merge\":true") && trading.Contains("\"copier\":true") && trading.Contains("\"accountChecks\":false") &&
              ChartBridgeOrders.MergeOn && ChartBridgeCopier.Enabled,
              "X1: trading.switches and what Merge and the copier obey are one value: " + trading);
        lock (sent) Check(sent.Any(m => m.StartsWith("{\"type\":\"copier\",\"enabled\":true")), "X1: after auth the v3 page gets the copier's state (the copier sees the same v3 page)");
        ChartBridgeSwitches.Note("merge", "off");
        lock (sent) sent.Clear();
        Msg("merge", "{\"type\":\"merge\",\"cid\":\"m0\",\"account\":\"Sim101\",\"root\":\"MNQ\"}");
        Check(Rejected("Merge is off in config.txt") && !ChartBridgeOrders.MergeOn, "X1: merge off in the switches: Merge refuses");
        ChartBridgeSwitches.Note("merge", "on");
    }

    // ------------------------------------------------------------ X2: Merge on the copier's leader
    static void MergeOnTheLeader()
    {
        ChartBridgeCopier.Start();
        lock (sent) sent.Clear();
        Msg("copierSet", "{\"type\":\"copierSet\",\"cid\":\"s\",\"leader\":\"Sim101\",\"mode\":\"executions\"}");
        Msg("copierFollower", "{\"type\":\"copierFollower\",\"cid\":\"f\",\"account\":\"SIM-F1\",\"on\":true,\"qty\":1,\"size\":\"micro\",\"lossLimit\":null}");
        Msg("copierRearm", "{\"type\":\"copierRearm\",\"cid\":\"r\"}");
        Check(!Rejected(""), "X2: the copier is set: leader Sim101, follower SIM-F1, armed: " + Last());

        LeaderEntry(25000);   // leader stop 24998
        LeaderEntry(25004);   // leader stop 25002
        List<Order> fstops = LiveStops(f1);
        Check(CopyEntries(f1) == 2 && fstops.Count == 2 && fstops.Any(o => o.StopPrice == 24998) && fstops.Any(o => o.StopPrice == 25002),
              "X2: two leader fills copied; the follower's stops sit at the leader's stops (24998, 25002): " + string.Join(", ", fstops.Select(o => o.StopPrice)));

        int copiesBefore = CopyEntries(f1), f1Calls = f1.Calls.Count;
        Thread.Sleep(ChartBridgeOrders.MergeQuietMs + 50);
        int from;
        lock (sent) from = sent.Count;
        Msg("merge", "{\"type\":\"merge\",\"cid\":\"m1\",\"account\":\"Sim101\",\"root\":\"MNQ\"}");
        string m = WaitFor(from, "\"type\":\"merge\",\"cid\":\"m1\"", 10000);
        Stopwatch sw = Stopwatch.StartNew();
        while (ChartBridgeOrders.MergeFrozen(lead, mnq) && sw.ElapsedMilliseconds < 5000) Thread.Sleep(5);
        Check(m.Contains("\"result\":\"merged\"") && m.Contains("\"stop\":{\"price\":24998,\"qty\":2}"), "X2: the leader's two pairs merge into one stop for 2 at 24998: " + m);
        Check(CopyEntries(f1) == copiesBefore && !f1.Calls.Skip(f1Calls).Any(c => c.StartsWith("submit ")),
              "X2: the swap's orders are leg changes: nothing new is copied to the follower (no entry, no new stop)");

        ChartBridgeCopier.Tick();   // the copier's every-second work: a follower stop whose leader stop the swap cancelled
        fstops = LiveStops(f1);
        Check(fstops.Count == 2 && fstops.All(o => o.StopPrice == 24998),
              "X2: the follower's stops follow the leader's merged stop: both at 24998: " + string.Join(", ", fstops.Select(o => o.StopPrice)));

        Order s = LiveStops(lead).Single();
        Msg("change", "{\"type\":\"change\",\"cid\":\"c\",\"id\":\"" + IdOf(s) + "\",\"price\":24999}");
        fstops = LiveStops(f1);
        Check(s.StopPrice == 24999 && fstops.Count == 2 && fstops.All(o => o.StopPrice == 24999),
              "X2: the merged stop moved to 24999: every follower stop moves to the same price: " + string.Join(", ", fstops.Select(o => o.StopPrice)) + " " + Last());

        lock (lead.Orders) foreach (Order o in lead.Orders) if (IsLive(o)) o.OrderState = OrderState.Cancelled;
        lock (f1.Orders) foreach (Order o in f1.Orders) if (IsLive(o)) o.OrderState = OrderState.Cancelled;
        SetPos(lead, 0); SetPos(f1, 0);
        ChartBridgeCopier.Tick();
    }

    // ------------------------------------------------------------ X3: Gone is one rule
    static void GoneIsOneRule()
    {
        Check(ChartBridgeCopier.IsGone(f1) == ChartBridgeAccounts.IsGone(f1) && !ChartBridgeCopier.IsGone(f1),
              "X3: the copier asks the accounts lane whether a follower is Gone (accountChecks off: nobody is Gone, as 0.3.8)");
    }
}
