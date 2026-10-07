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
//   X7 the copier and Order Strategies: a strategy entry's stop counts for the copier's stop rule, the entry is copied once
//      with each follower's fixed quantity (0.4.3), and breakeven moves the followers' stops to the leader's new stop price.
//   X8 the bot and the new lanes: a bot order never carries an Order Strategy and never uses the new order kinds.
//   X9-X11 the review fixes (fix1: a merged entry after a restart; fix2: Sim101 never both the bot's account and a follower).
//   X12 the copier and Merge never act on one account (lead's default): Merge is refused on a copier follower while the copier
//      is on, and an account with a Merge running cannot become a follower until the swap ends.
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
    static bool Logged(string has) { lock (NinjaTrader.Code.Output.Lines) return NinjaTrader.Code.Output.Lines.Any(x => x.Contains(has)); }
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
            OrdersHarness.AllOffLines();
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
            SyncFillCopied();   // X9: review 2 finding 8
            LateHandshake();
            ChartBridgeOrders.StrategyInline = true;   // breakeven and trailing moves on this thread (as StrategiesHarness)
            ChartBridgeOrders.StrategyClock = () => clock;
            ChartBridgeSwitches.Note("strategies", "on");
            StrategyOnTheLeader();
            MergeStrategyLegs();
            BotNoStrategy();
            MergedThenRestart();   // fix1 (F4); it restarts ChartBridge's memory (the copier's is its own)
            Sim101NeverAFollowerWithTheBot();
            MergeNeverOnAFollower();   // X12 (last: SIM-G stays listed as a follower)   // X10, X11: review 2 findings 3 and 9 (last: Sim101 stays listed as a follower)
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
            OrdersHarness.AllOffLines();
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
        lock (a.Orders) e = a.Orders.Skip(n).FirstOrDefault(o => Regex.IsMatch(o.Name ?? "", "^CB#[0-9a-f]{8} sg s[0-9]+$"));   // fix1 (F5): the stop ticks in the name
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
        Check(newCopies.Count == 1 && newCopies[0].Quantity == 1, "X7: the leader's strategy entry of 2 is copied once with SIM-F1's fixed quantity, 1 (0.4.3; never once per bucket): " + string.Join(" | ", newCopies.Select(o => o.Name + " x" + o.Quantity)));
        if (newCopies.Count != 1) return;
        Order copy = newCopies[0];
        copy.Filled = 1; copy.AverageFillPrice = 25000; copy.OrderState = OrderState.Filled;
        Update(f1, copy);
        SetPos(f1, PosOf(f1) + 1);
        List<Order> fstops = LiveStops(f1);
        Check(fstops.Count == 1 && fstops[0].StopPrice == 24998 && fstops[0].Quantity == 1, "X7: the follower's stop for its 1 at the leader's stop price 24998");
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

    // X9 (fix1, F4): after a Merge, breakeven and trailing never move the merged stop again, also after a restart (F5, a
    // recompile): managed.txt says "merged", so the entry is recovered as unmanaged. A price move after the restart: no change sent.
    static void MergedThenRestart()
    {
        ChartBridgeSwitches.Note("merge", "on");
        Account z = NewAccount("SIM-Z", Provider.Simulator);
        SetPos(z, 0);
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, SIM-F1, SIM-L, SIM-Z");
        const string One = "\"name\":\"One\",\"stop\":8,\"t1\":40,\"t1Share\":100,\"beAfter\":4,\"bePlus\":0";
        Order e1 = StrategyEntry(z, 1, 25000, One), e2 = StrategyEntry(z, 1, 25000, One);
        if (e1 == null || e2 == null) return;
        string r = RunMerge(z, "mg9");
        Stopwatch sw = Stopwatch.StartNew();
        while (ChartBridgeOrders.MergeFrozen(z, mnq) && sw.ElapsedMilliseconds < 5000) Thread.Sleep(5);
        Order kept = LiveStops(z).FirstOrDefault();
        Check(r.Contains("\"result\":\"merged\"") && kept != null && kept.Quantity == 2 && kept.StopPrice == 24998, "X9: one target: the first pair kept and grown to 2 at 24998: " + r);
        string tag1 = Regex.Match(e1.Name, "^CB#([0-9a-f]{8})").Groups[1].Value;
        string file = Path.Combine(ChartBridgeConfig.Folder, "managed.txt");
        Check(File.Exists(file) && File.ReadAllLines(file).Any(l => l.StartsWith(tag1 + "\t") && l.EndsWith("\tmerged")), "X9: managed.txt marks the merged entry (written whole when the swap ended)");
        int n = z.Calls.Count;
        Trade(25001.5); Trade(25001.75);
        Check(z.Calls.Count == n, "X9: the same run: breakeven does not move the merged stop");
        // ChartBridge restarts: memory gone, managed.txt read again
        ChartBridgeOrders.Clear();
        ChartBridgeOrders.LoadPlansNow();
        foreach (Account a in new[] { lead, f1, other, z }) ((Dictionary<Account, double>)typeof(ChartBridgeOrders).GetField("ConnectedSince", PS).GetValue(null))[a] = 0;
        lock (sent) sent.Clear();
        ChartBridgeOrders.CheckLegs(ChartBridgeTime.NowUtcMs());
        List<string> said;
        lock (sent) said = sent.Where(m => m.StartsWith("{\"type\":\"managed\"") && m.Contains("\"account\":\"SIM-Z\"")).ToList();
        Check(said.Any(m => m.Contains("\"state\":\"unmanaged\"") && m.Contains("merged before the restart")) && !said.Any(m => m.Contains("\"state\":\"resumed\"")),
              "X9: after the restart the merged entry resumes as unmanaged, and managed says it was merged: " + string.Join(" | ", said));
        n = z.Calls.Count;
        Trade(25001.5); Trade(25001.75); Trade(25004);
        Check(z.Calls.Count == n && kept.StopPrice == 24998, "X9: merge, restart, a price move: no change sent; the merged stop stays at 24998: " + string.Join(" | ", z.Calls.Skip(n)));
        Clean(z);
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

    // ------------------------------------------------------------ X9 (review 2 finding 8): the leader entry is registered before Submit
    static void SyncFillCopied()
    {
        lock (sent) sent.Clear();
        Msg("copierRearm", "{\"type\":\"copierRearm\",\"cid\":\"r9\"}");
        ChartBridgeOrders.NoteLast("MNQ", 25000);
        int copies = CopyEntries(f1);
        // NinjaTrader fills the leader's market entry inside Submit (its order event before Submit returns)
        lead.OnCall = (kind, o) =>
        {
            Broker(lead, kind, o);
            if (kind == "submit" && Regex.IsMatch(o.Name ?? "", "^CB#[0-9a-f]{8} s8 t16$")) { o.Filled = o.Quantity; o.AverageFillPrice = 25000; o.OrderState = OrderState.Filled; Update(lead, o); }
        };
        try { Msg("order", "{\"type\":\"order\",\"cid\":\"e\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}}"); }
        finally { lead.OnCall = (kind, o) => Broker(lead, kind, o); }
        SetPos(lead, 1);
        Check(CopyEntries(f1) == copies + 1, "X9 (review 2 finding 8): a leader entry that fills inside Submit is copied (registered before Submit): " + Last());
        Clean(lead, f1);

        // orders mode: a leader entry NinjaTrader rejects inside Submit is dropped; no follower order is placed for it
        Msg("copierSet", "{\"type\":\"copierSet\",\"cid\":\"s9\",\"mode\":\"orders\"}");
        copies = CopyEntries(f1);
        lead.OnCall = (kind, o) =>
        {
            if (kind == "submit" && Regex.IsMatch(o.Name ?? "", "^CB#[0-9a-f]{8} atm s8 t16$")) { o.OrderState = OrderState.Rejected; Update(lead, o); return; }
            Broker(lead, kind, o);
        };
        try { Msg("order", "{\"type\":\"order\",\"cid\":\"e2\",\"account\":\"Sim101\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":16}}"); }
        finally { lead.OnCall = (kind, o) => Broker(lead, kind, o); }
        Check(CopyEntries(f1) == copies, "X9 (review 2 finding 8): orders mode: a leader entry rejected inside Submit is dropped; no follower order is placed for it");
        Clean(lead, f1);
        Msg("copierSet", "{\"type\":\"copierSet\",\"cid\":\"s10\",\"mode\":\"executions\"}");
        Check(!Rejected(""), "X9: back to executions mode: " + Last());
    }

    // ------------------------------------------------------------ X10 (review 2 finding 3): Sim101, the bot's account, is never a copier follower while the bot is on
    // X11 (review 2 finding 9): bot and copier orders are marked "by" on a v3 page only.
    static void Sim101NeverAFollowerWithTheBot()
    {
        List<string> v2got = new List<string>();
        ChartBridgeClient v2 = new ChartBridgeClient(null, 73) { Origin = "http://localhost:8765" };
        v2.Tap = s => { lock (v2got) v2got.Add(s); };
        Clients()[73] = v2;
        try
        {
            ChartBridgeOrders.OnMessage(v2, "auth", "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
            lock (sent) sent.Clear();
            Msg("copierSet", "{\"type\":\"copierSet\",\"cid\":\"s11\",\"leader\":\"SIM-L\"}");
            Check(!Rejected(""), "X10: the copier's leader is SIM-L: " + Last());
            ChartBridgeSwitches.Note("bot", "on");
            int leadCalls = lead.Calls.Count;
            Msg("copierFollower", "{\"type\":\"copierFollower\",\"cid\":\"f9\",\"account\":\"Sim101\",\"on\":true,\"qty\":1,\"size\":\"micro\",\"lossLimit\":null}");
            Check(Rejected("Sim101 is the bot's account: it cannot be a copier follower while the bot trades it (choose another account for the bot on the Bot tab first).") && Logged("copier refused Sim101"),
                  "X10 (review 2 finding 3): bot on: Sim101 as a copier follower is refused, in plain words, and logged: " + Last());

            // the other way: Sim101 listed as a follower while the bot was off; with the bot on, the bot refuses entries
            ChartBridgeSwitches.Note("bot", "off");
            lock (sent) sent.Clear();
            Msg("copierFollower", "{\"type\":\"copierFollower\",\"cid\":\"f10\",\"account\":\"Sim101\",\"on\":true,\"qty\":1,\"size\":\"micro\",\"lossLimit\":null}");
            Check(!Rejected(""), "X10: bot off: Sim101 may be a follower: " + Last());
            ChartBridgeSwitches.Note("bot", "on");
            ChartBridgeOrders.NoteLast("MNQ", 25000);
            Order placed;
            string why = ChartBridgeOrders.PlaceBotEntry(BotEntry(), out placed);
            Check(why == "Sim101 is a copier follower: the bot does not trade while the copier copies to its account (turn that follower off on the page)." && placed == null && lead.Calls.Count == leadCalls && Logged("bot entry refused: Sim101 is a copier follower"),
                  "X10 (review 2 finding 3): Sim101 is a copier follower: a bot entry is refused, in plain words, nothing sent, logged: " + why);
            // Anthony 2026-10-07 (the bot trades the account he chooses): the bot's account can never become a follower that is on,
            // nor the copier's leader: botAccount refuses both, in plain words
            lock (sent) sent.Clear();
            ChartBridgeBot.OnPageMessage(page, "botAccount", "{\"type\":\"botAccount\",\"cid\":\"ba1\",\"account\":\"SIM-F1\"}");
            Check(Rejected("SIM-F1 is a copier follower: the bot does not trade while the copier copies to its account") && ChartBridgeBot.BotAccount == "Sim101",
                  "X10: botAccount: a copier follower that is on cannot become the bot's account: " + Last());
            lock (sent) sent.Clear();
            ChartBridgeBot.OnPageMessage(page, "botAccount", "{\"type\":\"botAccount\",\"cid\":\"ba2\",\"account\":\"SIM-L\"}");
            Check(Rejected("SIM-L is the copier's leader: the bot cannot trade the leader's account while the copier is on") && ChartBridgeBot.BotAccount == "Sim101",
                  "X10: botAccount: the copier's leader cannot become the bot's account: " + Last());

            // and the copier copies nothing to Sim101 while the bot is on
            Msg("copierRearm", "{\"type\":\"copierRearm\",\"cid\":\"r10\"}");
            lock (sent) sent.Clear();
            int fCopies = CopyEntries(f1);
            Msg("order", "{\"type\":\"order\",\"cid\":\"e3\",\"account\":\"SIM-L\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1,\"bracket\":{\"stop\":8,\"target\":16}}");
            Order le;
            lock (other.Orders) le = other.Orders.Last();
            string leId = IdOf(le);   // before the fill (a done order's id is forgotten)
            le.Filled = 1; le.AverageFillPrice = 25000; le.OrderState = OrderState.Filled;
            Update(other, le);
            SetPos(other, 1);
            bool skipped;
            lock (sent) skipped = sent.Any(m => m.Contains("\"type\":\"copierEvent\"") && m.Contains("\"account\":\"Sim101\"") && m.Contains("Sim101 is the bot's account"));
            Check(lead.Calls.Count == leadCalls && skipped && CopyEntries(f1) == fCopies + 1, "X10 (review 2 finding 3): bot on: the copier skips Sim101 (nothing copied to it) while SIM-F1 is copied");

            // X11: a copier order: "by":"copier" on the v3 page, no "by" on the v2 page (the 0.3.8 order message)
            Order copy;
            lock (f1.Orders) copy = f1.Orders.Last(o => Regex.IsMatch(o.Name ?? "", "^CB#[0-9a-f]{8} copy [0-9a-f]{8}$"));
            string copyId = IdOf(copy);
            List<string> v3copy, v2copy, v3page;
            lock (sent) { v3copy = sent.Where(m => m.StartsWith("{\"type\":\"order\"") && m.Contains("\"id\":\"" + copyId + "\"")).ToList(); v3page = sent.Where(m => m.StartsWith("{\"type\":\"order\"") && m.Contains("\"id\":\"" + leId + "\"")).ToList(); }
            lock (v2got) v2copy = v2got.Where(m => m.StartsWith("{\"type\":\"order\"") && m.Contains("\"id\":\"" + copyId + "\"")).ToList();
            Check(v3copy.Count > 0 && v3copy.All(m => m.Contains(",\"by\":\"copier\"")) && v2copy.Count > 0 && v2copy.All(m => !m.Contains("\"by\"")),
                  "X11 (review 2 finding 9): a copier order: \"by\":\"copier\" to a v3 page, no \"by\" to a v2 page: " + (v3copy.FirstOrDefault() ?? "(none)") + " / " + (v2copy.FirstOrDefault() ?? "(none)"));
            Check(v3page.Count > 0 && v3page.All(m => !m.Contains("\"by\"")), "X11: the page's own order carries no \"by\"");
            Clean(other, f1, lead);

            // X11: a bot order: "by":"bot" on the v3 page, no "by" on the v2 page
            Msg("copierFollower", "{\"type\":\"copierFollower\",\"cid\":\"f11\",\"account\":\"Sim101\",\"on\":false,\"qty\":1,\"size\":\"micro\",\"lossLimit\":null}");
            Check(!Rejected(""), "X10: turning the Sim101 follower off is always allowed: " + Last());
            lock (sent) sent.Clear();
            lock (v2got) v2got.Clear();
            why = ChartBridgeOrders.PlaceBotEntry(BotEntry(), out placed);
            Check(why == null && placed != null, "X10: the Sim101 follower off: a bot entry goes: " + why);
            if (placed != null)
            {
                string id = IdOf(placed);
                List<string> v3bot, v2bot;
                lock (sent) v3bot = sent.Where(m => m.StartsWith("{\"type\":\"order\"") && m.Contains("\"id\":\"" + id + "\"")).ToList();
                lock (v2got) v2bot = v2got.Where(m => m.StartsWith("{\"type\":\"order\"") && m.Contains("\"id\":\"" + id + "\"")).ToList();
                Check(v3bot.Count > 0 && v3bot.All(m => m.Contains(",\"by\":\"bot\"")) && v2bot.Count > 0 && v2bot.All(m => !m.Contains("\"by\"")),
                      "X11 (review 2 finding 9): a bot order: \"by\":\"bot\" to a v3 page, no \"by\" to a v2 page: " + (v3bot.FirstOrDefault() ?? "(none)") + " / " + (v2bot.FirstOrDefault() ?? "(none)"));
                List<string> snap = new List<string>();
                ChartBridgeClient v3b = new ChartBridgeClient(null, 74) { Origin = "http://localhost:8765" };
                v3b.Tap = s => { lock (snap) snap.Add(s); };
                Clients()[74] = v3b;
                ChartBridgeAccounts.OnMessage(v3b, "client", "{\"type\":\"client\",\"v\":3}");
                ChartBridgeOrders.OnMessage(v3b, "auth", "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
                ChartBridgeClient gone74; Clients().TryRemove(74, out gone74);
                bool inSnap;
                lock (snap) inSnap = snap.Any(m => m.StartsWith("{\"type\":\"orders\"") && m.Contains("\"id\":\"" + id + "\"") && m.Contains(",\"by\":\"bot\""));
                Check(inSnap, "X11: the orders list a v3 page gets after its sign-in marks the bot order too");
            }
            Clean(lead);
        }
        finally
        {
            ChartBridgeSwitches.Note("bot", "off");
            ChartBridgeClient gone; Clients().TryRemove(73, out gone);
        }
    }

    // ------------------------------------------------------------ X12: the copier and Merge never act on one account
    // (lead's default, fixer 1's finding: the copier's "flatten this follower" goes to NinjaTrader directly and would not end a swap)
    static void MergeNeverOnAFollower()
    {
        ChartBridgeSwitches.Note("merge", "on");
        ChartBridgeSwitches.Note("copier", "on");
        Account g = NewAccount("SIM-G", Provider.Simulator), h = NewAccount("SIM-H", Provider.Simulator);
        SetPos(g, 0); SetPos(h, 0);
        ChartBridgeOrders.ReadConfig("tradeAccounts", "Sim101, SIM-F1, SIM-L, SIM-G, SIM-H");
        const string Two = "\"name\":\"One\",\"stop\":8,\"t1\":40,\"t1Share\":100";
        // one way: a follower (on, then off) cannot be merged while the copier is on
        lock (sent) sent.Clear();
        Msg("copierFollower", "{\"type\":\"copierFollower\",\"cid\":\"fg\",\"account\":\"SIM-G\",\"on\":true,\"qty\":1,\"size\":\"micro\",\"lossLimit\":null}");
        Check(!Rejected(""), "X12: SIM-G is a copier follower: " + Last());
        Order g1 = StrategyEntry(g, 1, 25000, Two), g2 = StrategyEntry(g, 1, 25000, Two);
        int gCalls = g.Calls.Count;
        string r = RunMerge(g, "mx1");
        Check(r.Contains("\"type\":\"reject\"") && r.Contains("SIM-G is a copier follower: Merge is refused on it while the copier is on") && g.Calls.Count == gCalls,
              "X12: Merge on a copier follower is refused in plain words, nothing sent: " + r);
        Msg("copierFollower", "{\"type\":\"copierFollower\",\"cid\":\"fg2\",\"account\":\"SIM-G\",\"on\":false,\"qty\":1,\"size\":\"micro\",\"lossLimit\":null}");
        r = RunMerge(g, "mx2");
        Check(r.Contains("is a copier follower") && g.Calls.Count == gCalls, "X12: a follower that is off is still listed (it may hold a copier position): refused too");
        ChartBridgeSwitches.Note("copier", "off");
        r = RunMerge(g, "mx3");
        Stopwatch sw = Stopwatch.StartNew();
        while (ChartBridgeOrders.MergeFrozen(g, mnq) && sw.ElapsedMilliseconds < 5000) Thread.Sleep(5);
        Check(r.Contains("\"result\":\"merged\""), "X12: the copier off: the same account merges: " + r);
        ChartBridgeSwitches.Note("copier", "on");
        Clean(g);

        // the other way: an account with a Merge running cannot become a follower until the swap ends
        Order h1 = StrategyEntry(h, 1, 25000, Two), h2 = StrategyEntry(h, 1, 25000, Two);
        if (h1 == null || h2 == null) return;
        Hold = (kind, o) => kind == "cancel";
        Thread.Sleep(ChartBridgeOrders.MergeQuietMs + 50);
        int from;
        lock (sent) from = sent.Count;
        Msg("merge", "{\"type\":\"merge\",\"cid\":\"mx4\",\"account\":\"SIM-H\",\"root\":\"MNQ\"}");
        Thread.Sleep(30);
        bool running = ChartBridgeOrders.MergeFrozen(h, mnq);
        lock (sent) sent.Clear();
        Msg("copierFollower", "{\"type\":\"copierFollower\",\"cid\":\"fh\",\"account\":\"SIM-H\",\"on\":true,\"qty\":1,\"size\":\"micro\",\"lossLimit\":null}");
        Check(running && Rejected("SIM-H has a Merge running: it can become a copier follower once the merge has ended."), "X12: a Merge running on SIM-H: copierFollower on for it is refused: " + Last());
        sw = Stopwatch.StartNew();
        while (ChartBridgeOrders.MergeFrozen(h, mnq) && sw.ElapsedMilliseconds < 5000) Thread.Sleep(5);
        Hold = null;
        lock (sent) sent.Clear();
        Msg("copierFollower", "{\"type\":\"copierFollower\",\"cid\":\"fh2\",\"account\":\"SIM-H\",\"on\":true,\"qty\":1,\"size\":\"micro\",\"lossLimit\":null}");
        Check(!Rejected(""), "X12: once the swap has ended it can be a follower: " + Last());
        Msg("copierFollower", "{\"type\":\"copierFollower\",\"cid\":\"fh3\",\"account\":\"SIM-H\",\"on\":false,\"qty\":1,\"size\":\"micro\",\"lossLimit\":null}");
        Clean(h);
    }
}
