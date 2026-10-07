// ChartBridge 0.4.0 cross-lane rules on Mono (inside check:orders). Each order lane (accounts, Merge, the copier, the bot,
// Order Strategies) has its own harness; this one checks the rules that only hold when the lanes run together, through the
// real code of every lane at once. Made-up accounts and prices only.
//   X1 one v3 handshake: the accounts lane's "client" message makes a page v3 for every lane (Merge, the copier), and the
//      trading message's switches say exactly what each lane obeys (one source of truth: ChartBridgeSwitches).
//   X2 Merge on the copier's leader: the swap's orders are leg changes, never a new entry to copy; the follower whose
//      leader stop the swap cancelled follows the merged stop's price, and a later move of that stop moves every follower.
//   X3 the copier skips a Gone follower through the accounts lane's own Gone (one rule).
//   X4 the bot and the copier: a bot order is never copied (only the page's entries on the leader are), and with the copier on
//      the bot never trades the leader's account (lead's default: every exit on the leader is copied, so a bot position mixed
//      into the leader's would shrink or flatten the followers).
//   X5 a page that signs in first and sends client after still gets each lane's v3 state (the one handshake tells the lanes).
//   X6 Merge and Order Strategies: Merge reads B1's own legs (B1's LegNameRx), its shares from B1's state and B1's allocation
//      rule; breakeven and trailing are paused through the swap; after it the merged position is no longer managed (lead's
//      default), every stop stays where it is and managed says so.
//   X7 the copier and Order Strategies: a strategy entry's stop counts for the copier's stop rule, each fill increment is
//      copied once with its full quantity, and breakeven moves the followers' stops to the leader's new stop price.
//   X8 the bot and the new lanes: a bot order never carries an Order Strategy and never uses the new order kinds.
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
    static Account lead, f1, other;
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
    // Positions closed by hand here have no closing fill: every fill counts as booked (as CopierHarness).
    static void Booked() { ((System.Collections.IDictionary)typeof(ChartBridgeOrders).GetField("Moves", PS).GetValue(null)).Clear(); }
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
    static Func<string, Order, bool> Hold;   // a call NinjaTrader leaves unanswered (X6)

    static void Broker(Account a, string kind, Order o)
    {
        Func<string, Order, bool> hold = Hold;
        if (hold != null && hold(kind, o)) { if (kind == "submit") o.OrderState = OrderState.Submitted; return; }
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
            FieldInfo et = typeof(ChartBridgeTime).GetField("et", PS);   // Linux names New York's zone differently from Windows (as PinHarness)
            if (et.GetValue(null) == null) et.SetValue(null, TimeZoneInfo.FindSystemTimeZoneById("America/New_York"));
            lock (Account.All) Account.All.Clear();
            ChartBridgeOrders.Clear();
            ChartBridgeOrders.LoadPlansNow();
            mnq = new Instrument { FullName = "MNQ 12-26", MasterInstrument = new MasterInstrument { Name = "MNQ", TickSize = 0.25, PointValue = 2 } };
            Named().Clear(); Named()["MNQ"] = mnq;
            lead = NewAccount("Sim101", Provider.Simulator);
            f1 = NewAccount("SIM-F1", Provider.Simulator);
            other = NewAccount("SIM-L", Provider.Simulator);
            ChartBridgeOrders.ResetConfig();
            ChartBridgeSwitches.Reset();
            ChartBridgeOrders.ReadConfig("trading", "true");
            ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, SIM-F1, SIM-L");
            ChartBridgeOrders.ReadConfig("maxQty.MNQ", "10");
            ChartBridgeOrders.MergeConfirmMs = 400; ChartBridgeOrders.MergeQuietMs = 100; ChartBridgeOrders.MergePollMs = 5;
            ChartBridgeOrders.NewToken();
            token = ChartBridgeOrders.SessionJson().Split('"')[3];
            page = new ChartBridgeClient(null, 71) { Origin = "http://localhost:8765" };
            page.Tap = s => { lock (sent) sent.Add(s); };
            Clients()[71] = page;
            ChartBridgeCopier.HarnessManual = true;
            foreach (Account a in new[] { lead, f1, other }) SetPos(a, 0);

            OneHandshake();
            MergeOnTheLeader();
            GoneIsOneRule();
            BotNeverCopied();
            LateHandshake();
            ChartBridgeOrders.StrategyInline = true;   // breakeven and trailing moves on this thread (as StrategiesHarness)
            ChartBridgeOrders.StrategyClock = () => clock;
            ChartBridgeSwitches.Note("strategies", "on");
            StrategyOnTheLeader();
            MergeStrategyLegs();
            BotNoStrategy();
        }
        catch (Exception ex) { Check(false, "integration harness threw: " + ex); }
        finally
        {
            Hold = null;
            ChartBridgeOrders.StrategyInline = false;
            ChartBridgeOrders.StrategyClock = null;
            ChartBridgeCopier.Stop();
            ChartBridgeBot.Stop();
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
        Booked();
        ChartBridgeCopier.Tick();
    }

    // ------------------------------------------------------------ X3: Gone is one rule
    static void GoneIsOneRule()
    {
        Check(ChartBridgeCopier.IsGone(f1) == ChartBridgeAccounts.IsGone(f1) && !ChartBridgeCopier.IsGone(f1),
              "X3: the copier asks the accounts lane whether a follower is Gone (accountChecks off: nobody is Gone, as 0.3.8)");
    }

    // ------------------------------------------------------------ X4: the bot and the copier
    static string BotEntry() { return "{\"type\":\"order\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}}"; }

    static void BotNeverCopied()
    {
        // the copier on, its leader Sim101 (the bot's account), armed with SIM-F1 on (set in X2)
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        int leadCalls = lead.Calls.Count, fCalls = f1.Calls.Count;
        Order placed;
        string why = ChartBridgeOrders.PlaceBotEntry(BotEntry(), out placed);
        Check(why != null && why.Contains("Sim101 is the copier's leader") && placed == null && lead.Calls.Count == leadCalls && f1.Calls.Count == fCalls,
              "X4: copier on with Sim101 as its leader: a bot entry is refused before anything is sent: " + why);

        // the leader moved to another account: the bot's entry on Sim101 goes, and nothing of it is ever copied
        lock (sent) sent.Clear();
        Msg("copierSet", "{\"type\":\"copierSet\",\"cid\":\"s2\",\"leader\":\"SIM-L\"}");
        Msg("copierRearm", "{\"type\":\"copierRearm\",\"cid\":\"r2\"}");
        Check(!Rejected(""), "X4: the copier's leader is now SIM-L, armed: " + Last());
        why = ChartBridgeOrders.PlaceBotEntry(BotEntry(), out placed);
        Check(why == null && placed != null && Regex.IsMatch(placed.Name ?? "", "^CB#[0-9a-f]{8} bot s8 t16$"), "X4: a bot entry on Sim101 (not the leader) is placed: " + (why ?? placed.Name));
        if (placed == null) return;
        placed.Filled = 1; placed.AverageFillPrice = 25000; placed.OrderState = OrderState.Filled;
        Update(lead, placed);
        SetPos(lead, 1);
        ChartBridgeCopier.Tick();
        Check(f1.Calls.Count == fCalls && CopyEntries(f1) == 2, "X4: the bot's fill is never copied (no copier order on the follower)");
        lock (lead.Orders) foreach (Order o in lead.Orders) if (IsLive(o)) o.OrderState = OrderState.Cancelled;
        SetPos(lead, 0);
        Booked();
        Msg("copierSet", "{\"type\":\"copierSet\",\"cid\":\"s3\",\"leader\":\"Sim101\"}");
    }

    // ------------------------------------------------------------ X5: client after auth
    static void LateHandshake()
    {
        ChartBridgeSwitches.Note("bot", "on");
        ChartBridgeBot.Start(false);
        List<string> got = new List<string>();
        ChartBridgeClient late = new ChartBridgeClient(null, 72) { Origin = "http://localhost:8765" };
        late.Tap = s => { lock (got) got.Add(s); };
        Clients()[72] = late;
        try
        {
            ChartBridgeOrders.OnMessage(late, "auth", "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
            bool before;
            lock (got) before = got.Any(m => m.StartsWith("{\"type\":\"bot\"") || m.StartsWith("{\"type\":\"copier\""));
            ChartBridgeAccounts.OnMessage(late, "client", "{\"type\":\"client\",\"v\":3}");
            bool bot, copier;
            lock (got) { bot = got.Any(m => m.StartsWith("{\"type\":\"bot\"")); copier = got.Any(m => m.StartsWith("{\"type\":\"copier\",")); }
            Check(late.Trader && !before && bot && copier, "X5: signed in as a v2 page (no bot or copier message), then client v3: the bot strip and the copier's state arrive");
        }
        finally { ChartBridgeClient gone; Clients().TryRemove(72, out gone); ChartBridgeBot.Stop(); ChartBridgeSwitches.Note("bot", "off"); }
    }

    // ------------------------------------------------------------ Order Strategies with the other lanes
    static double clock = 50000000;
    static void Trade(double price) { clock += 1000; ChartBridgeOrders.NoteLast("MNQ", price); }
    static string StratOrder(string account, int qty, string strategy) { return "{\"type\":\"order\",\"cid\":\"g\",\"account\":\"" + account + "\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":" + qty + ",\"strategy\":{" + strategy + "}}"; }
    static Order StrategyEntry(Account a, int qty, double fill, string strategy)
    {
        Trade(fill);
        int n;
        lock (a.Orders) n = a.Orders.Count;
        Msg("order", StratOrder(a.Name, qty, strategy));
        Order e;
        lock (a.Orders) e = a.Orders.Skip(n).FirstOrDefault(o => Regex.IsMatch(o.Name ?? "", "^CB#[0-9a-f]{8} sg$"));
        if (e == null) { Check(false, "a strategy entry was sent on " + a.Name + ": " + Last()); return null; }
        e.Filled = qty; e.AverageFillPrice = fill; e.OrderState = OrderState.Filled;
        Update(a, e);
        SetPos(a, PosOf(a) + qty);
        return e;
    }
    static void Clean(params Account[] accounts)
    {
        foreach (Account a in accounts) { lock (a.Orders) foreach (Order o in a.Orders) if (IsLive(o)) o.OrderState = OrderState.Cancelled; SetPos(a, 0); }
        Booked();
        ChartBridgeCopier.Tick();
    }
    static List<string> ManagedSaid(Order entry) { string id = IdOf(entry); lock (sent) return sent.Where(m => m.StartsWith("{\"type\":\"managed\"") && m.Contains("\"id\":\"" + id + "\"")).ToList(); }

    // X7: the copier's leader trades an Order Strategy with breakeven
    static void StrategyOnTheLeader()
    {
        lock (sent) sent.Clear();
        Msg("copierRearm", "{\"type\":\"copierRearm\",\"cid\":\"r3\"}");
        int copies = CopyEntries(f1), fCalls = f1.Calls.Count;
        Order e = StrategyEntry(lead, 2, 25000, "\"name\":\"Two\",\"stop\":8,\"t1\":8,\"t2\":16,\"t1Share\":50,\"t2Share\":50,\"beAfter\":4,\"bePlus\":1");
        if (e == null) return;
        List<Order> lstops = LiveStops(lead);
        Check(lstops.Count == 2 && lstops.All(o => o.StopPrice == 24998 && Regex.IsMatch(o.Name, " k[12]$")), "X7: a strategy entry on the leader (the copier armed): its stop counts for the copier's stop rule; one pair per bucket, stops at 24998");
        List<Order> newCopies;
        lock (f1.Orders) newCopies = f1.Orders.Where(o => Regex.IsMatch(o.Name ?? "", "^CB#[0-9a-f]{8} copy [0-9a-f]{8}$")).Skip(copies).ToList();
        Check(newCopies.Count == 1 && newCopies[0].Quantity == 2, "X7: the fill increment of 2 is copied once with its full quantity (not once per bucket): " + string.Join(" | ", newCopies.Select(o => o.Name + " x" + o.Quantity)));
        if (newCopies.Count != 1) return;
        Order copy = newCopies[0];
        copy.Filled = 2; copy.AverageFillPrice = 25000; copy.OrderState = OrderState.Filled;
        Update(f1, copy);
        SetPos(f1, PosOf(f1) + 2);
        List<Order> fstops = LiveStops(f1);
        Check(fstops.Count == 1 && fstops[0].StopPrice == 24998 && fstops[0].Quantity == 2, "X7: the follower's stop for 2 at the leader's stop price 24998");
        Trade(25001);   // 4 ticks in profit: breakeven plus 1 tick
        lstops = LiveStops(lead);
        fstops = LiveStops(f1);
        Check(lstops.Count == 2 && lstops.All(o => o.StopPrice == 25000.25) && fstops.Count == 1 && fstops[0].StopPrice == 25000.25,
              "X7: breakeven moves the leader's stops to 25000.25 and the follower's stop to the same price: leader " + string.Join(", ", lstops.Select(o => o.StopPrice)) + ", follower " + string.Join(", ", fstops.Select(o => o.StopPrice)));
        Clean(lead, f1);
    }

    // X6: Merge on an account's Order Strategy legs
    const string NoBe = "\"name\":\"Halves\",\"stop\":8,\"t1\":8,\"t2\":16,\"t1Share\":50,\"t2Share\":50,\"beAfter\":20,\"bePlus\":1";

    static string RunMerge(Account a, string cid)
    {
        Thread.Sleep(ChartBridgeOrders.MergeQuietMs + 50);
        int from;
        lock (sent) from = sent.Count;
        Msg("merge", "{\"type\":\"merge\",\"cid\":\"" + cid + "\",\"account\":\"" + a.Name + "\",\"root\":\"MNQ\"}");
        return WaitFor(from, "\"type\":\"merge\",\"cid\":\"" + cid + "\"", 10000);
    }

    static void MergeStrategyLegs()
    {
        Account m = NewAccount("SIM-M", Provider.Simulator);
        SetPos(m, 0);
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, SIM-F1, SIM-L, SIM-M");
        Order e1 = StrategyEntry(m, 2, 25000, NoBe), e2 = StrategyEntry(m, 2, 25002, NoBe);
        if (e1 == null || e2 == null) return;
        Check(LiveStops(m).Count == 4, "X6: two strategy entries of 2, one pair per bucket each: 4 stops");
        lock (sent) sent.Clear();
        int calls = m.Calls.Count;
        string r = RunMerge(m, "mg1");
        Stopwatch sw = Stopwatch.StartNew();
        while (ChartBridgeOrders.MergeFrozen(m, mnq) && sw.ElapsedMilliseconds < 5000) Thread.Sleep(5);
        List<Order> stops = LiveStops(m);
        List<Order> targets;
        lock (m.Orders) targets = m.Orders.Where(o => IsLive(o) && o.OrderType == OrderType.Limit).ToList();
        Check(r.Contains("\"result\":\"merged\"") && r.Contains("\"stop\":{\"price\":24998,\"qty\":4}") && r.Contains("\"targets\":[{\"price\":25002,\"qty\":2},{\"price\":25004,\"qty\":2}]"),
              "X6: Merge reads B1's legs (k1, k2), B1's shares (50/50) and B1's allocation: one stop for 4 at 24998, targets 2 and 2 at the first leg's prices: " + r);
        Check(stops.Count == 1 && stops[0].Name.StartsWith("CB#" + Regex.Match(e1.Name, "^CB#([0-9a-f]{8})").Groups[1].Value + " mstop q4 p24998") && targets.Count == 2,
              "X6: the merged set as B4 names it: " + string.Join(" | ", stops.Concat(targets).Select(o => o.Name)));
        List<string> said1 = ManagedSaid(e1), said2 = ManagedSaid(e2);
        Check(said1.Any(x => x.Contains("\"state\":\"unmanaged\"") && x.Contains("Merge merged")) && said2.Any(x => x.Contains("\"state\":\"unmanaged\"")),
              "X6: after the merge both entries are no longer managed, and managed says why: " + (said1.LastOrDefault() ?? "(none)"));
        int before = m.Calls.Count;
        Trade(25006); Trade(25010); Trade(25014);   // 40+ ticks in profit: breakeven would have moved a managed stop
        Check(m.Calls.Count == before && stops[0].StopPrice == 24998, "X6: no breakeven or trailing move on the merged stop afterwards; it stays at 24998");
        Clean(m);

        // the pause: a swap that NinjaTrader does not confirm, with a breakeven trade in the middle; then the restore
        Order e3 = StrategyEntry(m, 2, 25000, "\"name\":\"Halves\",\"stop\":8,\"t1\":8,\"t2\":16,\"t1Share\":50,\"t2Share\":50,\"beAfter\":4,\"bePlus\":1");
        Order e4 = StrategyEntry(m, 2, 25000.5, "\"name\":\"Halves\",\"stop\":8,\"t1\":8,\"t2\":16,\"t1Share\":50,\"t2Share\":50,\"beAfter\":4,\"bePlus\":1");
        if (e3 == null || e4 == null) return;
        Trade(25000.75);   // under breakeven for both
        Hold = (kind, o) => kind == "cancel";   // NinjaTrader confirms no cancel: the swap's first step times out
        int callsBefore = m.Calls.Count;
        Thread.Sleep(ChartBridgeOrders.MergeQuietMs + 50);
        int from;
        lock (sent) from = sent.Count;
        Msg("merge", "{\"type\":\"merge\",\"cid\":\"mg2\",\"account\":\"SIM-M\",\"root\":\"MNQ\"}");
        Thread.Sleep(50);
        bool frozen = ChartBridgeOrders.MergeFrozen(m, mnq);
        Trade(25003);   // 12 ticks over e3's fill: breakeven is due, but the swap holds it
        List<string> during = m.Calls.Skip(callsBefore).ToList();
        string r2 = WaitFor(from, "\"type\":\"merge\",\"cid\":\"mg2\"", 10000);
        sw = Stopwatch.StartNew();
        while (ChartBridgeOrders.MergeFrozen(m, mnq) && sw.ElapsedMilliseconds < 5000) Thread.Sleep(5);
        Hold = null;
        Check(frozen && !during.Any(c => c.StartsWith("change ") && c.Contains(" S25000.25 ")), "X6: breakeven is paused while the swap runs (no move to 25000.25 during it): " + string.Join(" | ", during.Where(c => c.StartsWith("change "))));
        Check(r2.Contains("\"result\":\"restored\"") || r2.Contains("\"result\":\"failed\""), "X6: the swap that was not confirmed ends restored (or failed): " + r2);
        int after = m.Calls.Count;
        Trade(25004); Trade(25006);
        Check(m.Calls.Skip(after).All(c => !c.StartsWith("change ")) && ManagedSaid(e3).Any(x => x.Contains("\"state\":\"unmanaged\"")),
              "X6: after a restore too, the position is no longer managed (its pairs are new orders): no move, and managed says so");
        Clean(m);
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, SIM-F1, SIM-L");
    }

    // X8: the bot never uses an Order Strategy or a new kind
    static void BotNoStrategy()
    {
        ChartBridgeSwitches.Note("orderTypes", "on");
        try
        {
            Trade(25000);
            int n = lead.Calls.Count;
            Order placed;
            string why1 = ChartBridgeOrders.PlaceBotEntry("{\"type\":\"order\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"strategy\":{\"name\":\"X\",\"stop\":8}}", out placed);
            string why2 = ChartBridgeOrders.PlaceBotEntry("{\"type\":\"order\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"mit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":16}}", out placed);
            Check(why1 != null && why2 != null && why2.Contains("the bot places market, limit and stop entries") && lead.Calls.Count == n,
                  "X8: with strategies and orderTypes on, a bot order with a strategy or an MIT is refused, nothing sent: " + why1 + " / " + why2);
        }
        finally { ChartBridgeSwitches.Note("orderTypes", "off"); }
    }
}
