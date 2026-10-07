// ChartBridge 0.4.0 Merge stops and targets on Mono (inside check:orders; nt8/PROTOCOL.md "Merge stops and targets"). The real
// ChartBridgeOrders code (ChartBridgeOrders.cs and ChartBridgeMerge.cs) against the stand-in account, with a stand-in broker
// (Account.OnCall) that confirms each change and cancel the way NinjaTrader would, or holds or rejects one on purpose. Every
// scenario: the switch off (refused, nothing sent), 2 and 3 legs with one target, a strategy's 3 targets at 50/30/20 resized,
// each refusal, a step not confirmed (restore), a fill during the swap (restore), a restore that fails (one stop for the whole
// position), merged targets filling (the stop shrinks), Flatten during the swap, the freeze, the legs check and the alarm on a
// merged set, and a restart in the middle of a swap. While a merge runs, after EVERY simulated broker step, the working stops
// may never cover more contracts than the position. Made-up accounts and prices only.
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

public static class MergeHarness
{
    static Action<bool, string> Check;
    const BindingFlags PS = BindingFlags.NonPublic | BindingFlags.Static;
    static readonly List<string> sent = new List<string>();
    static ChartBridgeClient c;
    static Instrument mnq;
    static readonly Regex StopName = new Regex("^CB#[0-9a-f]{8} (stop f[0-9]+|mstop) ");

    // The stand-in broker. Hold: leave a call unanswered (NinjaTrader never confirms it); Reject: answer a submit with a
    // rejection. After: a scenario's own step once a call is answered. watching: check the stop rule after every step.
    static Func<string, Order, bool> Hold, Reject;
    static Action<string, Order> After;
    static volatile bool watching;
    static int stepsChecked, overProtected;
    // Fix1 (F3): the fewest contracts the working stops covered after any simulated step of a merge, while a position was held.
    static int minCover = int.MaxValue;
    static string minCoverAt = "";
    static string overText = "";

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        Dictionary<string, Instrument> named = (Dictionary<string, Instrument>)typeof(ChartBridgeServer).GetField("Instruments", PS).GetValue(null);
        ConcurrentDictionary<int, ChartBridgeClient> clients = (ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", PS).GetValue(null);
        Instrument had;
        bool hadMnq = named.TryGetValue("MNQ", out had);
        int[] timings = { ChartBridgeOrders.MergeConfirmMs, ChartBridgeOrders.MergeQuietMs, ChartBridgeOrders.MergePollMs };
        try
        {
            mnq = new Instrument { FullName = "MNQ 12-26", MasterInstrument = new MasterInstrument { Name = "MNQ", TickSize = 0.25, PointValue = 2 } };
            named["MNQ"] = mnq;
            ChartBridgeOrders.ResetConfig();
            ChartBridgeOrders.ReadConfig("trading", "true");
            ChartBridgeOrders.ReadConfig("tradeAccounts", "EVAL-A, EVAL-B, EVAL-C, EVAL-D, EVAL-E, EVAL-F, EVAL-G, EVAL-H, EVAL-J, EVAL-K, EVAL-L, EVAL-N, EVAL-P, EVAL-Q, EVAL-R, EVAL-S, EVAL-T, EVAL-U, EVAL-V, EVAL-W");
            ChartBridgeOrders.ReadConfig("maxQty.MNQ", "20");
            ChartBridgeOrders.MergeConfirmMs = 400; ChartBridgeOrders.MergeQuietMs = 100; ChartBridgeOrders.MergePollMs = 5;
            ChartBridgeOrders.NewToken();
            c = new ChartBridgeClient(null, 41) { Origin = "http://localhost:8765" };
            c.Tap = s => { lock (sent) sent.Add(s); };
            clients[41] = c;
            ChartBridgeV3.OnClient(c, "{\"type\":\"client\",\"v\":3}");   // integration: the page speaks v3 (the merge answer goes to v3 pages)
            Msg("auth", "{\"type\":\"auth\",\"token\":\"" + ChartBridgeOrders.SessionJson().Split('"')[3] + "\"}");
            Check(c.Trader, "merge harness: signed in");

            Off();
            ConfigKey();
            TwoLegs();
            ThreeLegsAndShort();
            ThreeTargets();
            Refusals();
            NotConfirmed();
            FillDuringSwap();
            RestoreFails();
            CancelLandsLate();       // fix4 (G1)
            CancelLandsInRestore();  // fix4 (G1)
            FallbackRejected();      // fix1 (F3)
            FlattenDuringSwap();
            FlattenRefusedMidSwap(); // fix1 (F1)
            FlippedMidSwap();        // fix1
            MergedTargetAfterRestart();   // fix1
            Restarted();
            Check(stepsChecked > 40 && overProtected == 0, "merge: after every simulated step of every merge the working stops never covered more than the position (" +
                  stepsChecked + " steps checked)" + overText);
        }
        catch (Exception ex) { Check(false, "merge harness threw: " + ex); }
        finally
        {
            watching = false;
            ChartBridgeOrders.MergeConfirmMs = timings[0]; ChartBridgeOrders.MergeQuietMs = timings[1]; ChartBridgeOrders.MergePollMs = timings[2];
            ChartBridgeClient gone;
            clients.TryRemove(41, out gone);
            ChartBridgeOrders.ResetConfig();
            if (hadMnq) named["MNQ"] = had; else named.Remove("MNQ");
        }
    }

    // ------------------------------------------------------------ helpers
    static void Msg(string type, string json) { lock (c.Actions) c.Actions.Clear(); ChartBridgeOrders.OnMessage(c, type, json); }
    static string Last() { lock (sent) return sent.Count > 0 ? sent[sent.Count - 1] : ""; }
    static bool Rejected(string has) { string m = Last(); return m.Contains("\"type\":\"reject\"") && m.Contains(has); }
    static bool Sent(string has) { lock (sent) return sent.Any(m => m.Contains(has)); }
    static void Update(Account a, Order o) { ChartBridgeOrders.OnOrderUpdate(a, new OrderEventArgs { Order = o }); }
    static void Update(Account a, Order o, ErrorCode e) { ChartBridgeOrders.OnOrderUpdate(a, new OrderEventArgs { Order = o, Error = e }); }
    static string MergeMsg(Account a, string cid) { return "{\"type\":\"merge\",\"cid\":\"" + cid + "\",\"account\":\"" + a.Name + "\",\"root\":\"MNQ\"}"; }
    static bool IsLive(Order o) { return o.OrderState != OrderState.Filled && o.OrderState != OrderState.Cancelled && o.OrderState != OrderState.Rejected; }
    static List<Order> Live(Account a) { lock (a.Orders) return a.Orders.Where(o => o.Instrument == mnq && IsLive(o)).ToList(); }
    static List<Order> LiveStops(Account a) { return Live(a).Where(o => StopName.IsMatch(o.Name ?? "")).ToList(); }
    static int StopCover(Account a) { return LiveStops(a).Sum(o => o.Quantity - o.Filled); }
    static int Pos(Account a) { Position p = a.Positions.FirstOrDefault(x => x.Instrument == mnq); return p == null ? 0 : p.MarketPosition == MarketPosition.Long ? p.Quantity : -p.Quantity; }
    static Order Named(Account a, string start) { lock (a.Orders) return a.Orders.LastOrDefault(o => (o.Name ?? "").StartsWith(start)); }
    static List<string> CallsFrom(Account a, int n) { lock (a.Calls) return a.Calls.Skip(n).ToList(); }
    static string Diag() { return ChartBridgeOrders.MergeDiagJson(); }

    static Account NewAccount(string name)
    {
        Account a = new Account { Name = name, Connection = new Connection { Status = ConnectionStatus.Connected } };
        lock (Account.All) Account.All.Add(a);
        ((Dictionary<Account, double>)typeof(ChartBridgeOrders).GetField("ConnectedSince", PS).GetValue(null))[a] = 0;   // steady since long ago
        a.OnCall = (kind, o) => Broker(a, kind, o);
        return a;
    }

    // The broker: a change takes the new quantity, a cancel cancels the order and its OCO partners, a submit is reported, each
    // with NinjaTrader's order event. Then, while a merge runs, the stop rule is checked.
    static void Broker(Account a, string kind, Order o)
    {
        Func<string, Order, bool> hold = Hold, reject = Reject;
        if (hold != null && hold(kind, o)) { if (kind == "submit") o.OrderState = OrderState.Submitted; }
        else if (kind == "submit" && reject != null && reject(kind, o)) { o.OrderState = OrderState.Rejected; Update(a, o, ErrorCode.OrderRejected); }
        else if (kind == "change") { if (o.QuantityChanged > 0) o.Quantity = o.QuantityChanged; Update(a, o); }
        else if (kind == "cancel")
        {
            if (IsLive(o)) { o.OrderState = OrderState.Cancelled; Update(a, o); }
            if (!string.IsNullOrEmpty(o.Oco))
                foreach (Order p in a.Orders.ToList()) if (p != o && p.Oco == o.Oco && IsLive(p)) { p.OrderState = OrderState.Cancelled; Update(a, p); }
        }
        else if (kind == "submit") Update(a, o);
        if (watching)
        {
            Interlocked.Increment(ref stepsChecked);
            int pos = Math.Abs(Pos(a)), cover = StopCover(a);
            if (cover > pos) { Interlocked.Increment(ref overProtected); overText += "; " + a.Name + " after " + kind + " " + o.Name + ": stops " + cover + " > position " + pos; }
            if (pos > 0 && cover < minCover) { minCover = cover; minCoverAt = a.Name + " after " + kind + " " + o.Name + ": stops " + cover + " of " + pos; }
        }
        Action<string, Order> after = After;
        if (after != null) after(kind, o);
    }

    static void SetPos(Account a, int signed)
    {
        a.Positions.RemoveAll(p => p.Instrument == mnq);
        Position pos = new Position { Instrument = mnq, MarketPosition = signed > 0 ? MarketPosition.Long : signed < 0 ? MarketPosition.Short : MarketPosition.Flat, Quantity = Math.Abs(signed), AveragePrice = 25000 };
        if (signed != 0) a.Positions.Add(pos);
        ChartBridgeOrders.OnPositionUpdate(a, new PositionEventArgs { Position = pos, MarketPosition = pos.MarketPosition, Quantity = pos.Quantity, AveragePrice = 25000 });
    }

    // A market entry from the chart with a bracket (stop 8, target 16 ticks), filled at `fill`: ChartBridge places its pair.
    static Order Entry(Account a, bool buy, int qty, double fill)
    {
        ChartBridgeOrders.NoteLast("MNQ", fill);
        int n;
        lock (a.Orders) n = a.Orders.Count;
        Msg("order", "{\"type\":\"order\",\"cid\":\"e\",\"account\":\"" + a.Name + "\",\"root\":\"MNQ\",\"side\":\"" + (buy ? "buy" : "sell") + "\",\"kind\":\"market\",\"qty\":" + qty + ",\"bracket\":{\"stop\":8,\"target\":16}}");
        Order e;
        lock (a.Orders) e = a.Orders.Skip(n).First(o => Regex.IsMatch(o.Name ?? "", "^CB#[0-9a-f]{8} s8 t16$"));
        e.Filled = qty; e.AverageFillPrice = fill; e.OrderState = OrderState.Filled;
        Update(a, e);
        SetPos(a, Pos(a) + (buy ? qty : -qty));
        return e;
    }

    // A strategy's legs as lane B1 names them: one OCO pair per target bucket, for one fill increment.
    static void StrategyLegs(Account a, string tag, int f, double fill, int[] q, int stopTicks, int[] targetTicks)
    {
        for (int k = 0; k < q.Length; k++)
        {
            if (q[k] <= 0) continue;
            string mark = " f" + f + " q" + q[k] + " p" + fill + " k" + (k + 1), oco = "cb-" + tag + "-" + f + "-k" + (k + 1);
            lock (a.Orders)
            {
                a.Orders.Add(new Order { Account = a, Instrument = mnq, OrderAction = OrderAction.Sell, OrderType = OrderType.StopMarket, Quantity = q[k], StopPrice = fill - stopTicks * 0.25, Oco = oco, Name = "CB#" + tag + " stop" + mark, OrderState = OrderState.Working });
                a.Orders.Add(new Order { Account = a, Instrument = mnq, OrderAction = OrderAction.Sell, OrderType = OrderType.Limit, Quantity = q[k], LimitPrice = fill + targetTicks[k] * 0.25, Oco = oco, Name = "CB#" + tag + " target" + mark, OrderState = OrderState.Working });
            }
        }
    }

    static void Managed(string tag, int s1, int s2, int s3)
    {
        string line = tag + "\t{\"name\":\"Scale out\",\"stop\":8,\"t1\":4,\"t2\":8,\"t3\":16,\"t1Share\":" + s1 + ",\"t2Share\":" + s2 + ",\"t3Share\":" + s3 + "}\t25000\t" + (long)ChartBridgeTime.NowUtcMs() + "\n";
        File.AppendAllText(Path.Combine(ChartBridgeConfig.Folder, "managed.txt"), line);
        ChartBridgeOrders.LoadPlansNow();   // integration: the shares come from lane B1's state (managed.txt as read at a start)
    }

    // Send merge and wait for its answer (or a reject). Returns the merge message, or "" when it was refused.
    static string DoMerge(Account a, string cid) { return DoMerge(a, cid, true); }

    static string DoMerge(Account a, string cid, bool watch)
    {
        Thread.Sleep(ChartBridgeOrders.MergeQuietMs + 50);   // past the 2 s (here 0.1 s) after the last position change
        int before;
        lock (sent) before = sent.Count;
        watching = watch;
        Msg("merge", MergeMsg(a, cid));
        string got = WaitFor(before, "\"type\":\"merge\",\"cid\":\"" + cid + "\"", 10000);
        Stopwatch sw = Stopwatch.StartNew();
        while (ChartBridgeOrders.MergeFrozen(a, mnq) && sw.ElapsedMilliseconds < 5000) Thread.Sleep(5);
        watching = false;
        return got;
    }

    static string WaitFor(int from, string has, int ms)
    {
        Stopwatch sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < ms)
        {
            lock (sent)
            {
                for (int i = from; i < sent.Count; i++)
                {
                    if (sent[i].Contains(has)) return sent[i];
                    if (sent[i].Contains("\"type\":\"reject\"") && sent[i].Contains("\"cid\":\"") && has.Contains("\"type\":\"merge\"") && sent[i].Contains(has.Substring(has.IndexOf("\"cid\"")))) return "";
                }
            }
            Thread.Sleep(5);
        }
        return "";
    }

    static void WaitCall(Account a, string has, int ms)
    {
        Stopwatch sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < ms)
        {
            // the stand-in account adds its calls on the swap's thread with no lock: read a copy, and look again if it moved
            try { if (a.Calls.ToArray().Any(x => x != null && x.Contains(has))) return; } catch (Exception) { }
            Thread.Sleep(2);
        }
    }

    // ------------------------------------------------------------ the switch
    static void Off()
    {
        ChartBridgeSwitches.Reset();   // what ChartBridgeConfig.Load starts from
        Check(ChartBridgeOrders.MergeOn, "merge is ON by default (Anthony 2026-10-07: no switches)");
        OrdersHarness.AllOffLines();
        ChartBridgeSwitches.Note("merge", "off");
        Account a = NewAccount("EVAL-A");
        Entry(a, true, 1, 25000); Entry(a, true, 1, 25004);
        int calls = a.Calls.Count;
        Thread.Sleep(150);
        Msg("merge", MergeMsg(a, "off"));
        Check(Rejected("Merge is off in config.txt (merge = off") && a.Calls.Count == calls, "merge = off: refused, nothing sent to NinjaTrader: " + Last());
        Check(!ChartBridgeOrders.MergeOn, "merge = off turns it off");
        Done(a);
    }

    static void ConfigKey()
    {
        ChartBridgeSwitches.Note("merge", "yes");   // integration: ChartBridgeConfig.Load records every v3 switch in ChartBridgeSwitches
        Check(!ChartBridgeOrders.MergeOn && Logged("merge = yes is not off or on, so merge is OFF"), "merge = yes: off, with one Output line naming the value");
        ChartBridgeSwitches.Note("merge", "ON");
        Check(ChartBridgeOrders.MergeOn, "merge = ON: on (any case)");
        ChartBridgeSwitches.Note("merge", "1");
        Check(ChartBridgeOrders.MergeOn && ChartBridgeV3.Merge && ChartBridgeV3.SwitchesJson().Contains("\"merge\":true"), "merge = 1: on (one source of truth: trading.switches.merge says the same)");
        Check(ChartBridgeOrders.ReadConfig("merge", "on"), "the merge key is taken (no other reader sees it)");
        Check(Diag().Contains("\"ok\":0") && Diag().Contains("\"refused\":1"), "/diag merges: nothing merged yet, the refusal while off counted: " + Diag());
    }

    static bool Logged(string has) { lock (NinjaTrader.Code.Output.Lines) return NinjaTrader.Code.Output.Lines.Any(x => x.Contains(has)); }

    // A scenario's account is finished: everything on it marked done so later legs checks leave it alone.
    static void Done(Account a)
    {
        lock (a.Orders) foreach (Order o in a.Orders) if (IsLive(o)) o.OrderState = OrderState.Cancelled;
        a.Positions.Clear();
    }

    // ------------------------------------------------------------ one target: 2 legs, then 3 legs, then a short
    static void TwoLegs()
    {
        Account a = NewAccount("EVAL-B");
        Entry(a, true, 1, 25000); Entry(a, true, 1, 25004);
        Order s1 = Named(a, "CB#"), stop1 = a.Orders.First(o => (o.Name ?? "").Contains(" stop f1 q1 p25000")), target1 = a.Orders.First(o => (o.Name ?? "").Contains(" target f1 q1 p25000"));
        Order stop2 = a.Orders.First(o => (o.Name ?? "").Contains(" stop f1 q1 p25004")), target2 = a.Orders.First(o => (o.Name ?? "").Contains(" target f1 q1 p25004"));
        // Integration: a signed-in v2 page (never sent "client") gets no "merge" message; the v3 page that asked does.
        ConcurrentDictionary<int, ChartBridgeClient> clients = (ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", PS).GetValue(null);
        List<string> v2sent = new List<string>();
        ChartBridgeClient v2 = new ChartBridgeClient(null, 42) { Origin = "http://localhost:8765" };
        v2.Tap = s => { lock (v2sent) v2sent.Add(s); };
        clients[42] = v2;
        ChartBridgeOrders.OnMessage(v2, "auth", "{\"type\":\"auth\",\"token\":\"" + ChartBridgeOrders.SessionJson().Split('"')[3] + "\"}");
        int n = a.Calls.Count;
        string m = DoMerge(a, "m2");
        List<string> calls = CallsFrom(a, n);
        ChartBridgeClient gone;
        clients.TryRemove(42, out gone);
        Check(v2.Trader && !ChartBridgeV3.IsV3(v2) && m.Contains("\"result\":\"merged\"") && !v2sent.Any(x => x.StartsWith("{\"type\":\"merge\"")),
              "integration: the merge answer goes through the shared v3 send: the v3 page gets it, a signed-in v2 page does not");
        Check(m.Contains("\"result\":\"merged\"") && m.Contains("\"stop\":{\"price\":24998,\"qty\":2}") && m.Contains("\"targets\":[{\"price\":25004,\"qty\":2}]") && m.Contains("\"pairsBefore\":2"),
              "2 legs, one target: one stop and one target for 2 at the FIRST leg's prices: " + m);
        Check(m.Contains("Merged 2 pairs into one stop for 2 contract(s) at 24,998 and one target at 25,004"), "the text Anthony reads: " + m);
        Check(calls.Count == 4 && calls[0] == "cancel " + stop2.Name && calls[1] == "cancel " + target2.Name && calls[2].StartsWith("change " + stop1.Name) && calls[2].EndsWith(" Q2") &&
              calls[3].StartsWith("change " + target1.Name) && calls[3].EndsWith(" Q2"),
              "the fixed order: cancel the newer pair, then grow the first pair's stop, then its target: " + string.Join(" | ", calls));
        Check(stop1.Quantity == 2 && target1.Quantity == 2 && stop1.Oco == target1.Oco && LiveStops(a).Count == 1 && StopCover(a) == 2,
              "the first pair is kept and grown, still an OCO pair; one working stop for the whole position");
        Check(Diag().Contains("\"ok\":1") && Logged("merge merged on MNQ EVAL-B: Merged 2 pairs"), "logged in the Output window and counted in /diag merges: " + Diag());
        // A leg added after the merge gets its own bracket, until Merge again.
        Entry(a, true, 1, 25008);
        Check(Live(a).Count(o => (o.Name ?? "").Contains(" stop f1 q1 p25008")) == 1 && StopCover(a) == 3, "a leg added after the merge gets its own bracket");
        string again = DoMerge(a, "m2b");
        Check(again.Contains("\"result\":\"merged\"") && again.Contains("\"stop\":{\"price\":24998,\"qty\":3}") && stop1.Quantity == 3 && LiveStops(a).Count == 1,
              "Merge again: the new leg joins the first leg's stop: " + again);
        Done(a);
    }

    static void ThreeLegsAndShort()
    {
        Account a = NewAccount("EVAL-C");
        Entry(a, true, 1, 25000); Entry(a, true, 2, 25004); Entry(a, true, 1, 25008);
        Order stop1 = a.Orders.First(o => (o.Name ?? "").Contains(" stop f1 q1 p25000"));
        string tag2 = a.Orders.First(o => (o.Name ?? "").Contains(" stop f2 q2 p25004")).Name, tag3 = a.Orders.First(o => (o.Name ?? "").Contains(" stop f1 q1 p25008")).Name;
        int n = a.Calls.Count;
        string m = DoMerge(a, "m3");
        List<string> calls = CallsFrom(a, n);
        int c3 = calls.IndexOf("cancel " + tag3), g2 = calls.FindIndex(x => x.StartsWith("change " + stop1.Name) && x.EndsWith(" Q2")),
            c2 = calls.IndexOf("cancel " + tag2), g4 = calls.FindIndex(x => x.StartsWith("change " + stop1.Name) && x.EndsWith(" Q4"));
        Check(m.Contains("\"result\":\"merged\"") && m.Contains("\"stop\":{\"price\":24998,\"qty\":4}") && m.Contains("\"pairsBefore\":3"), "3 legs, one target: merged into one stop for 4: " + m);
        Check(c3 >= 0 && c3 < g2 && g2 < c2 && c2 < g4, "newest first: cancel the newest pair, grow, then the next: " + string.Join(" | ", calls));
        Check(LiveStops(a).Count == 1 && StopCover(a) == 4 && Live(a).Count == 2, "one stop and one target left");
        Done(a);

        Account s = NewAccount("EVAL-K");
        Entry(s, false, 1, 25000); Entry(s, false, 1, 24996);
        string sm = DoMerge(s, "ms");
        Check(sm.Contains("\"result\":\"merged\"") && sm.Contains("\"stop\":{\"price\":25002,\"qty\":2}") && sm.Contains("\"targets\":[{\"price\":24996,\"qty\":2}]") && Pos(s) == -2,
              "a short: the first leg's buy stop above and target below, for 2: " + sm);
        Done(s);
    }

    // ------------------------------------------------------------ a strategy's three targets, 50/30/20, resized; then they fill
    static void ThreeTargets()
    {
        Account a = NewAccount("EVAL-D");
        // First increment: 3 filled at 25000, 50/30/20 gives 1/1/1; second: 2 at 25002, 1/1/0 (T3 dropped). Stop 8, targets 4/8/16.
        StrategyLegs(a, "5a5a5a5a", 3, 25000, new[] { 1, 1, 1 }, 8, new[] { 4, 8, 16 });
        StrategyLegs(a, "6b6b6b6b", 2, 25002, new[] { 1, 1, 0 }, 8, new[] { 4, 8, 16 });
        Managed("5a5a5a5a", 50, 30, 20); Managed("6b6b6b6b", 50, 30, 20);
        SetPos(a, 5);
        ChartBridgeOrders.NoteLast("MNQ", 25001);
        List<Order> old = Live(a);
        int n = a.Calls.Count;
        string m = DoMerge(a, "mt");
        Order S = Named(a, "CB#5a5a5a5a mstop");
        Order t1 = Named(a, "CB#5a5a5a5a mtarget q2 p25001 k1"), t2 = Named(a, "CB#5a5a5a5a mtarget q2 p25002 k2"), t3 = Named(a, "CB#5a5a5a5a mtarget q1 p25004 k3");
        Check(m.Contains("\"result\":\"merged\"") && m.Contains("\"stop\":{\"price\":24998,\"qty\":5}") &&
              m.Contains("\"targets\":[{\"price\":25001,\"qty\":2},{\"price\":25002,\"qty\":2},{\"price\":25004,\"qty\":1}]") && m.Contains("\"pairsBefore\":5"),
              "3 targets at 50/30/20: one stop for 5 at the first leg's stop, targets at the first leg's prices resized 2/2/1 (the allocation rule): " + m);
        Check(S != null && S.Name == "CB#5a5a5a5a mstop q5 p24998" && S.Quantity == 5 && string.IsNullOrEmpty(S.Oco) && t1 != null && t2 != null && t3 != null && string.IsNullOrEmpty(t1.Oco),
              "names: mstop q5 p24998 (no OCO) and mtarget q.. p.. k1..k3: " + string.Join(" | ", Live(a).Select(o => o.Name + " x" + o.Quantity)));
        Check(old.All(o => o.OrderState == OrderState.Cancelled) && LiveStops(a).Count == 1 && Live(a).Count == 4, "every old pair is cancelled; one stop and three targets work");
        List<string> calls = CallsFrom(a, n);
        Check(calls.FindIndex(x => x.Contains("mtarget")) > calls.FindLastIndex(x => x.StartsWith("cancel ")), "the merged targets are placed last: " + string.Join(" | ", calls));
        Check(ChartBridgeOrders.Allocate(3, new[] { 33, 33, 34 }).SequenceEqual(new[] { 1, 1, 1 }) && ChartBridgeOrders.Allocate(1, new[] { 50, 50 }).SequenceEqual(new[] { 0, 1 }) &&
              ChartBridgeOrders.Allocate(5, new[] { 50, 30, 20 }).SequenceEqual(new[] { 2, 2, 1 }) && ChartBridgeOrders.Allocate(3, new[] { 30, 20 }).SequenceEqual(new[] { 2, 1 }),
              "the allocation rule's three examples from the contract (one rule: B1's Allocate), and the buckets left by their shares out of their sum");

        // The legs check and the missing-stop alarm see the merged set as ChartBridge's stop and targets: nothing trimmed, no alarm.
        int k = a.Calls.Count;
        double now = ChartBridgeTime.NowUtcMs();
        ChartBridgeOrders.CheckLegs(now); ChartBridgeOrders.CheckLegs(now + 4100); ChartBridgeOrders.CheckLegs(now + 8200);
        Check(a.Calls.Count == k && !Sent("EVAL-D: the position is 5 but ChartBridge's working stops cover"), "the legs check leaves the merged stop and targets alone (one group), and the missing-stop alarm counts the merged stop");

        // Targets fill: the stop shrinks to the position at once; the stop fills: the targets are cancelled.
        int n1 = a.Calls.Count;
        Hold = (kind, o) => kind == "change";   // NinjaTrader has not confirmed this shrink yet when the next fill comes
        t1.Filled = 2; t1.OrderState = OrderState.Filled; SetPos(a, 3); Update(a, t1);
        Hold = null;
        Check(CallsFrom(a, n1).Count == 1 && CallsFrom(a, n1)[0] == "change " + S.Name + " L0 S0 Q3", "T1 fills 2: the merged stop is shrunk to 3 at once: " + string.Join(" | ", CallsFrom(a, n1)));
        watching = true;
        t2.Filled = 1; t2.OrderState = OrderState.PartFilled; SetPos(a, 2); Update(a, t2);
        Check(S.Quantity == 2, "T2 fills 1 of 2 before that shrink is confirmed: the merged stop goes to 2 (from the 3 asked, never from the 5 still shown): " + S.Quantity);
        S.Filled = 2; S.OrderState = OrderState.Filled; Update(a, S); SetPos(a, 0);
        Check(t2.OrderState == OrderState.Cancelled && t3.OrderState == OrderState.Cancelled, "the merged stop fills: the targets left are cancelled");
        watching = false;
        Done(a);
    }

    // ------------------------------------------------------------ every refusal: a reject, nothing sent
    static void Refusals()
    {
        Func<Account, string, string, bool> refused = (a, cid, has) =>
        {
            int calls = a.Calls.Count;
            Thread.Sleep(ChartBridgeOrders.MergeQuietMs + 50);
            Msg("merge", MergeMsg(a, cid));
            bool ok = Rejected(has) && a.Calls.Count == calls && !ChartBridgeOrders.MergeFrozen(a, mnq);
            Check(ok, "refused (" + has + "), nothing sent: " + Last());
            return ok;
        };
        string refusedBefore = Regex.Match(Diag(), "\"refused\":([0-9]+)").Groups[1].Value;

        Account flat = NewAccount("EVAL-E");
        refused(flat, "r1", "Nothing to merge: EVAL-E is flat on MNQ.");

        Account one = NewAccount("EVAL-L");
        Entry(one, true, 1, 25000);
        refused(one, "r2", "Nothing to merge: the position has 1 stop and target pair(s).");

        Account e = NewAccount("EVAL-N");
        Entry(e, true, 1, 25000); Entry(e, true, 1, 25004);
        Msg("order", "{\"type\":\"order\",\"cid\":\"lim\",\"account\":\"EVAL-N\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"limit\",\"qty\":1,\"price\":24990,\"bracket\":{\"stop\":8,\"target\":16}}");
        Order limit = Named(e, "CB#");
        refused(e, "r3", "Merge is refused while an entry is working on EVAL-N MNQ.");
        limit.OrderState = OrderState.Cancelled;
        Order elsewhere = new Order { Account = e, Instrument = mnq, OrderAction = OrderAction.Buy, OrderType = OrderType.Limit, Quantity = 1, LimitPrice = 24990, Name = "placed in NinjaTrader", OrderState = OrderState.Working };
        lock (e.Orders) e.Orders.Add(elsewhere);
        refused(e, "r4", "Merge is refused while an entry is working on EVAL-N MNQ.");
        elsewhere.OrderState = OrderState.Cancelled;
        // the position changed in the last 2 s
        ChartBridgeOrders.MergeQuietMs = 2000;
        SetPos(e, 2);
        int calls0 = e.Calls.Count;
        Msg("merge", MergeMsg(e, "r5"));
        Check(Rejected("Merge is refused while the position is changing on MNQ EVAL-N") && e.Calls.Count == calls0, "the position changed in the last 2 s: refused: " + Last());
        ChartBridgeOrders.MergeQuietMs = 100;
        // the two position readings disagree (a fill NinjaTrader reported that is not in the position yet)
        Order manual = new Order { Account = e, Instrument = mnq, OrderAction = OrderAction.Buy, OrderType = OrderType.Market, Quantity = 1, Name = "placed in NinjaTrader", OrderState = OrderState.Working };
        lock (e.Orders) e.Orders.Add(manual);
        manual.Filled = 1; manual.AverageFillPrice = 25004; manual.OrderState = OrderState.Filled; Update(e, manual);
        refused(e, "r6", "Merge is refused while the position is changing on MNQ EVAL-N");
        SetPos(e, 3);   // now listed: 3 contracts, stops for 2
        refused(e, "r7", "Merge is refused: the working stops cover 2 of 3 contracts; let the legs check settle first.");
        // A clean account for the rest (a position cut back without a fill would leave a reading that disagrees for 10 s).
        Entry(one, true, 1, 25004);
        // not Connected for 30 s without a break
        ((Dictionary<Account, double>)typeof(ChartBridgeOrders).GetField("ConnectedSince", PS).GetValue(null))[one] = ChartBridgeTime.NowUtcMs();
        refused(one, "r8", "has not been connected for 30 seconds without a break");
        ((Dictionary<Account, double>)typeof(ChartBridgeOrders).GetField("ConnectedSince", PS).GetValue(null))[one] = 0;
        // the first leg's stop is already through the market (a long's at or above the last trade)
        ChartBridgeOrders.NoteLast("MNQ", 24998);
        refused(one, "r9", "Merge is refused: the first leg's stop 24,998 is already through the market (last 24,998).");
        ((Dictionary<string, double[]>)typeof(ChartBridgeOrders).GetField("Last", PS).GetValue(null))["MNQ"] = new double[] { 25004, ChartBridgeTime.NowUtcMs() - 400000 };
        refused(one, "r10", "Merge is refused: the last MNQ price is stale");
        ChartBridgeOrders.NoteLast("MNQ", 25004);
        // gates: an account the chart may not trade, a quote-only market, a misspelt key
        Account other = NewAccount("OTHER-M");
        Msg("merge", "{\"type\":\"merge\",\"cid\":\"r11\",\"account\":\"OTHER-M\",\"root\":\"MNQ\"}");
        Check(Rejected("account OTHER-M may not trade from the chart") && other.Calls.Count == 0, "an account not in tradeAccounts: refused: " + Last());
        Msg("merge", "{\"type\":\"merge\",\"cid\":\"r12\",\"account\":\"EVAL-N\",\"root\":\"YM\"}");
        Check(Rejected("YM is quote only"), "a quote-only market: refused: " + Last());
        Msg("merge", "{\"type\":\"merge\",\"cid\":\"r13\",\"account\":\"EVAL-N\",\"root\":\"MNQ\",\"all\":true}");
        Check(Rejected("unknown key \\\"all\\\" in merge"), "strict keys: a key the contract does not name is refused: " + Last());
        // a strategy whose target shares are not known (no managed.txt line): never guessed
        Account u = NewAccount("EVAL-P");
        StrategyLegs(u, "7c7c7c7c", 2, 25000, new[] { 1, 1 }, 8, new[] { 4, 8 });
        StrategyLegs(u, "8d8d8d8d", 1, 25002, new[] { 0, 1 }, 8, new[] { 4, 8 });
        SetPos(u, 3);
        refused(u, "r14", "the target shares of strategy entry CB#7c7c7c7c are not known");
        string refusedAfter = Regex.Match(Diag(), "\"refused\":([0-9]+)").Groups[1].Value;
        Check(int.Parse(refusedAfter) - int.Parse(refusedBefore) >= 12, "/diag merges counts the refusals: " + refusedBefore + " to " + refusedAfter);
        Done(flat); Done(one); Done(e); Done(u);
    }

    // ------------------------------------------------------------ a step not confirmed: the original brackets come back
    static void NotConfirmed()
    {
        Account a = NewAccount("EVAL-F");
        Entry(a, true, 1, 25000); Entry(a, true, 2, 25004); Entry(a, true, 1, 25008);
        Order stop1 = a.Orders.First(o => (o.Name ?? "").Contains(" stop f1 q1 p25000"));
        List<string> before = Live(a).Select(o => o.Name + " x" + o.Quantity).OrderBy(x => x).ToList();
        int changes = 0;
        Hold = (kind, o) => kind == "change" && ++changes == 1;   // NinjaTrader never confirms the first stop change
        string m = DoMerge(a, "nc");
        Hold = null;
        List<string> after = Live(a).Select(o => o.Name + " x" + o.Quantity).OrderBy(x => x).ToList();
        Check(m.Contains("\"result\":\"restored\"") && m.Contains("\"stop\":null") && m.Contains("NinjaTrader did not confirm the change of " + stop1.Name + " to 2 within 0.4 s") && m.Contains("the original brackets are back"),
              "a step not confirmed in time: restored, with the reason in plain words: " + m);
        Check(before.SequenceEqual(after) && StopCover(a) == 4 && stop1.Quantity == 1, "every pair is back at its own prices and size: " + string.Join(" | ", after));
        Order again = Live(a).First(o => (o.Name ?? "").Contains(" stop f1 q1 p25008"));
        Order againT = Live(a).First(o => (o.Name ?? "").Contains(" target f1 q1 p25008"));
        Check(!string.IsNullOrEmpty(again.Oco) && again.Oco == againT.Oco && Regex.IsMatch(again.Oco, "^cb-[0-9a-f]{8}-1-r[0-9a-f]{8}-[0-9]+$"), "the pair placed again is an OCO pair (a new OCO id, unique per run: the run's start in it): " + again.Oco);
        Check(Diag().Contains("\"restored\":1"), "/diag merges counts it: " + Diag());
        Done(a);
    }

    // ------------------------------------------------------------ a fill during the swap: restored to what the position needs
    static void FillDuringSwap()
    {
        Account a = NewAccount("EVAL-G");
        Entry(a, true, 1, 25000); Entry(a, true, 1, 25004); Entry(a, true, 1, 25008);
        Order target2 = a.Orders.First(o => (o.Name ?? "").Contains(" target f1 q1 p25004"));
        int cancels = 0;
        After = (kind, o) =>
        {
            if (kind != "cancel" || ++cancels != 1) return;
            // while the newest pair is being cancelled, the market fills the middle pair's target (its OCO stop goes with it)
            After = null;
            target2.Filled = 1; target2.OrderState = OrderState.Filled; Update(a, target2);
            SetPos(a, 2);
        };
        string m = DoMerge(a, "fd");
        After = null;
        Check(m.Contains("\"result\":\"restored\"") && m.Contains("a fill during the merge"), "a fill during the swap: the swap stops and restores: " + m);
        Check(StopCover(a) == 2 && Pos(a) == 2 && LiveStops(a).All(o => o.Quantity == 1), "the stops cover exactly the position that is left: " + string.Join(" | ", Live(a).Select(o => o.Name + " x" + o.Quantity)));
        Done(a);
    }

    // ------------------------------------------------------------ the restore fails: ONE STOP for the whole position, and an error
    static void RestoreFails()
    {
        Account a = NewAccount("EVAL-H");
        Entry(a, true, 1, 25000); Entry(a, true, 1, 25004); Entry(a, true, 1, 25008);
        int changes = 0, submits = 0;
        Hold = (kind, o) => kind == "change" && ++changes == 1;
        Reject = (kind, o) => kind == "submit" && (o.Name ?? "").Contains(" stop f1 q1 p25008") && ++submits == 1;   // putting the pair back is rejected
        Order s1 = Named(a, "CB#"); s1 = a.Orders.First(o => (o.Name ?? "").Contains(" stop f1 q1 p25000")); Order s2 = a.Orders.First(o => (o.Name ?? "").Contains(" stop f1 q1 p25004"));
        minCover = int.MaxValue; minCoverAt = "";
        string m = DoMerge(a, "rf");
        Hold = null; Reject = null;
        // Fix1 (F3): the fallback never cancels a working stop before something covers its contracts. The two pairs still working
        // stay (each with its OCO target); the one contract no stop covered gets ONE STOP at the first leg's stop price.
        Check(minCover > 0 && minCover >= 2, "F3: the restore fails with a one-target merge: the stop cover never fell to 0 at any step (lowest " + minCover + ", " + minCoverAt + ")");
        Check(m.Contains("\"result\":\"failed\"") && m.Contains("\"stop\":{\"price\":24998,\"qty\":2}"), "the restore fails: result failed; stop: the first leg's price and what the stops there cover: " + m);
        Check(m.Contains("MNQ EVAL-H: the merge failed and the original brackets could not be put back; nothing working was cancelled, and ONE STOP at 24,998 now covers the 1 contract(s) no stop covered; the working stops cover 3 of 3 contract(s) (2 at 24,998, 1 at 25,002); targets 1 at 25,004, 1 at 25,008; check NinjaTrader"),
              "with a text naming what covers what: " + m);
        Check(Sent("\"level\":\"error\",\"text\":\"MNQ EVAL-H: the merge failed and the original brackets could not be put back; nothing working was cancelled"),
              "and a status error to the pages");
        Order ms = Named(a, "CB#" + s1.Name.Substring(3, 8) + " mstop q1 p24998");
        Check(StopCover(a) == 3 && IsLive(s1) && IsLive(s2) && ms != null && IsLive(ms) && ms.Quantity == 1 && string.IsNullOrEmpty(ms.Oco) && s1.Quantity == 1,
              "the original stops still work, and one new stop (no OCO) covers the rest: " + string.Join(" | ", Live(a).Select(o => o.Name + " x" + o.Quantity)));
        Check(Diag().Contains("\"failed\":1"), "/diag merges counts it: " + Diag());
        Done(a);
    }

    // Fix1 (F3): the restore fails AND the fallback's own stop is rejected: every stop still working stays, and the status error
    // says what covers what and how many contracts have no stop.
    static void FallbackRejected()
    {
        Account a = NewAccount("EVAL-R");
        Entry(a, true, 1, 25000); Entry(a, true, 1, 25004); Entry(a, true, 1, 25008);
        int changes = 0, submits = 0;
        Hold = (kind, o) => kind == "change" && ++changes == 1;
        Reject = (kind, o) => kind == "submit" && (((o.Name ?? "").Contains(" stop f1 q1 p25008") && ++submits == 1) || (o.Name ?? "").Contains(" mstop "));
        Order s1 = a.Orders.First(o => (o.Name ?? "").Contains(" stop f1 q1 p25000")), s2 = a.Orders.First(o => (o.Name ?? "").Contains(" stop f1 q1 p25004"));
        int n = a.Calls.Count;
        minCover = int.MaxValue;
        string m = DoMerge(a, "fr");
        Hold = null; Reject = null;
        List<string> calls = CallsFrom(a, n);
        Check(m.Contains("\"result\":\"failed\"") && IsLive(s1) && IsLive(s2) && s1.Quantity == 1 && s2.Quantity == 1 && StopCover(a) == 2,
              "F3: the fallback's stop is rejected: the original stops still work, untouched: " + string.Join(" | ", Live(a).Select(o => o.Name + " x" + o.Quantity)));
        Check(!calls.Any(x => x == "cancel " + s1.Name || x == "cancel " + s2.Name), "no working stop was ever cancelled: " + string.Join(" | ", calls));
        Check(minCover >= 2, "the stop cover never fell below the two pairs still working (lowest " + minCover + ")");
        Check(m.Contains("could not be placed (NinjaTrader rejected CB#") && m.Contains("every stop still working stays where it is and 1 contract(s) may have NO STOP; act in NinjaTrader now") &&
              m.Contains("the working stops cover 2 of 3 contract(s) (1 at 24,998, 1 at 25,002): 1 contract(s) have NO STOP"),
              "and the text says what covers what: " + m);
        Check(Sent("\"level\":\"error\",\"text\":\"MNQ EVAL-R: the merge failed"), "a status error");
        Done(a);
    }

    // ------------------------------------------------------------ Flatten during the swap: accepted, ends the swap at once; the freeze
    static void FlattenDuringSwap()
    {
        Account a = NewAccount("EVAL-J");
        Account b = NewAccount("EVAL-Q");
        Entry(b, true, 1, 25000);
        Entry(a, true, 1, 25000); Entry(a, true, 1, 25004); Entry(a, true, 1, 25008);
        Order stop1 = a.Orders.First(o => (o.Name ?? "").Contains(" stop f1 q1 p25000"));
        Hold = (kind, o) => kind == "change";   // the stop change waits
        Thread.Sleep(ChartBridgeOrders.MergeQuietMs + 50);
        int before;
        lock (sent) before = sent.Count;
        ChartBridgeOrders.MergeConfirmMs = 3000;
        watching = true;
        Msg("merge", MergeMsg(a, "ff"));
        WaitCall(a, "change " + stop1.Name, 3000);
        Check(ChartBridgeOrders.MergeFrozen(a, mnq), "a swap is running: the account and root are frozen");
        // the freeze: order, change, plan, cancel and merge on it are refused; another account is not frozen
        Msg("order", "{\"type\":\"order\",\"cid\":\"fz1\",\"account\":\"EVAL-J\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1}");
        Check(Rejected("a Merge is running on MNQ EVAL-J; order is refused until it ends"), "frozen: order refused: " + Last());
        string id = (string)typeof(ChartBridgeOrders).GetMethod("IdFor", PS).Invoke(null, new object[] { stop1 });
        Msg("change", "{\"type\":\"change\",\"cid\":\"fz2\",\"id\":\"" + id + "\",\"price\":24997}");
        Check(Rejected("change is refused until it ends"), "frozen: change refused: " + Last());
        Msg("cancel", "{\"type\":\"cancel\",\"cid\":\"fz3\",\"id\":\"" + id + "\"}");
        Check(Rejected("cancel is refused until it ends"), "frozen: cancel refused: " + Last());
        Msg("merge", MergeMsg(a, "fz4"));
        Check(Rejected("a Merge is already running on MNQ EVAL-J"), "frozen: a second merge refused: " + Last());
        Msg("order", "{\"type\":\"order\",\"cid\":\"fz5\",\"account\":\"EVAL-Q\",\"root\":\"MNQ\",\"side\":\"sell\",\"kind\":\"market\",\"qty\":1}");
        Check(!Last().Contains("a Merge is running"), "another account is not frozen: " + Last());
        int n = a.Calls.Count;
        Msg("flatten", "{\"type\":\"flatten\",\"cid\":\"fl\",\"account\":\"EVAL-J\",\"root\":\"MNQ\"}");
        string m = WaitFor(before, "\"type\":\"merge\",\"cid\":\"ff\"", 5000);
        watching = false;
        Hold = null;
        ChartBridgeOrders.MergeConfirmMs = 400;
        List<string> calls = CallsFrom(a, n);
        Check(calls.Count >= 1 && calls[0] == "flatten MNQ 12-26" && calls.Count == 1, "Flatten is accepted at once, and the swap sends nothing after it: " + string.Join(" | ", calls));
        Check(m.Contains("\"result\":\"failed\"") && m.Contains("Flatten ended the merge") && m.Contains("\"stop\":null"), "the merge answer says Flatten ended it: " + m);
        Check(!ChartBridgeOrders.MergeFrozen(a, mnq), "the freeze ends");
        Done(a); Done(b);
    }

    // Fix1 (F1): a Flatten that is REFUSED (here the account's connection drops while a step waits) does not end the swap: it goes
    // on to its own check, finds the reconnect, and restores; the merge answer never says Flatten ended it, and the stops cover
    // the position at the end.
    static void FlattenRefusedMidSwap()
    {
        Account a = NewAccount("EVAL-S");
        Entry(a, true, 1, 25000); Entry(a, true, 1, 25004); Entry(a, true, 1, 25008);
        Order stop1 = a.Orders.First(o => (o.Name ?? "").Contains(" stop f1 q1 p25000"));
        List<string> before = Live(a).Select(o => o.Name + " x" + o.Quantity).OrderBy(x => x).ToList();
        int changes = 0;
        Hold = (kind, o) => kind == "change" && ++changes == 1;   // the grow of S is not confirmed yet (a slow broker)
        Thread.Sleep(ChartBridgeOrders.MergeQuietMs + 50);
        int from;
        lock (sent) from = sent.Count;
        ChartBridgeOrders.MergeConfirmMs = 1500;
        watching = true;
        Msg("merge", MergeMsg(a, "fr1"));
        WaitCall(a, "change " + stop1.Name, 3000);
        a.Connection.Status = ConnectionStatus.ConnectionLost;   // the connection drops; Anthony hits Flatten
        int n = a.Calls.Count;
        Msg("flatten", "{\"type\":\"flatten\",\"cid\":\"fl1\",\"account\":\"EVAL-S\",\"root\":\"MNQ\"}");
        string flat = Last();
        Check(flat.Contains("\"type\":\"reject\"") && flat.Contains("not connected") && !CallsFrom(a, n).Any(x => x.StartsWith("flatten")), "F1: Flatten refused (not connected), nothing flattened: " + flat);
        Check(ChartBridgeOrders.MergeFrozen(a, mnq), "the refused Flatten did not end the swap");
        a.Connection.Status = ConnectionStatus.Connected;
        string m = WaitFor(from, "\"type\":\"merge\",\"cid\":\"fr1\"", 8000);
        Stopwatch sw = Stopwatch.StartNew();
        while (ChartBridgeOrders.MergeFrozen(a, mnq) && sw.ElapsedMilliseconds < 5000) Thread.Sleep(5);
        watching = false;
        Hold = null;
        ChartBridgeOrders.MergeConfirmMs = 400;
        List<string> after = Live(a).Select(o => o.Name + " x" + o.Quantity).OrderBy(x => x).ToList();
        Check(m.Contains("\"result\":\"restored\"") && !m.Contains("Flatten"), "the swap went on and restored; the answer says nothing about Flatten: " + m);
        Check(StopCover(a) == Pos(a) && Pos(a) == 3 && before.SequenceEqual(after), "every pair is back; the stops cover the position: " + string.Join(" | ", after));
        Done(a);
    }

    // Fix1: the position turns to the other side during the swap (long 3, then short 1). Nothing is put back (a sell stop of the
    // long would add to the short); every leg of the old position is cancelled, and a status error says the short has no stop.
    static void FlippedMidSwap()
    {
        Account a = NewAccount("EVAL-T");
        Entry(a, true, 1, 25000); Entry(a, true, 1, 25004); Entry(a, true, 1, 25008);
        int cancels = 0;
        After = (kind, o) =>
        {
            if (kind != "cancel" || ++cancels != 1) return;
            After = null;
            SetPos(a, -1);   // a sell of 4 elsewhere: long 3 is now short 1
        };
        int n = a.Calls.Count;
        string m = DoMerge(a, "fp", false);   // not watched: the old long's stops are on the short's adding side until cancelled
        After = null;
        List<string> calls = CallsFrom(a, n);
        Check(m.Contains("\"result\":\"failed\"") && m.Contains("the position turned from 3 to -1 during the merge; nothing was put back (it would add to the new position)") &&
              m.Contains("1 contract(s) have NO STOP"), "a flip mid-swap: no restore, and the text says so: " + m);
        Check(!calls.Any(x => x.StartsWith("submit ")) && Live(a).Count == 0, "nothing placed, every leg of the old long cancelled: " + string.Join(" | ", calls));
        Check(Sent("\"level\":\"error\",\"text\":\"MNQ EVAL-T: the position turned from 3 to -1"), "a status error naming the account and root");
        Done(a);
    }

    // Fix1: after a restart (ChartBridge has never seen the merged set's events), a merged target's fill shrinks the merged stop
    // at once, from the position read both ways, not only at the legs check.
    static void MergedTargetAfterRestart()
    {
        Account a = NewAccount("EVAL-U");
        Order S, t1, t2;
        lock (a.Orders)
        {
            S = new Order { Account = a, Instrument = mnq, OrderAction = OrderAction.Sell, OrderType = OrderType.StopMarket, Quantity = 3, StopPrice = 24998, Name = "CB#7c7c7c7c mstop q3 p24998", OrderState = OrderState.Working };
            t1 = new Order { Account = a, Instrument = mnq, OrderAction = OrderAction.Sell, OrderType = OrderType.Limit, Quantity = 2, LimitPrice = 25001, Name = "CB#7c7c7c7c mtarget q2 p25001 k1", OrderState = OrderState.Working };
            t2 = new Order { Account = a, Instrument = mnq, OrderAction = OrderAction.Sell, OrderType = OrderType.Limit, Quantity = 1, LimitPrice = 25004, Name = "CB#7c7c7c7c mtarget q1 p25004 k2", OrderState = OrderState.Working };
            a.Orders.Add(S); a.Orders.Add(t1); a.Orders.Add(t2);
        }
        SetPos(a, 3);
        Update(a, t2);   // an event with no fill (NinjaTrader reports it working): from here on its fills are counted
        int n = a.Calls.Count;
        t1.Filled = 2; t1.OrderState = OrderState.Filled; Update(a, t1);   // the first event ChartBridge sees for it; the position not updated yet
        Check(CallsFrom(a, n).Count == 0, "a merged target first seen with fills after a restart, NinjaTrader's position not updated yet: nothing guessed");
        SetPos(a, 1);   // NinjaTrader's position update follows
        Check(CallsFrom(a, n).Count == 1 && CallsFrom(a, n)[0] == "change " + S.Name + " L0 S0 Q1" && S.Quantity == 1,
              "the position update: the merged stop shrinks to the position at once (not only at the legs check): " + string.Join(" | ", CallsFrom(a, n)));
        n = a.Calls.Count;
        t2.Filled = 1; t2.OrderState = OrderState.Filled; Update(a, t2);
        Check(CallsFrom(a, n).Count == 1 && CallsFrom(a, n)[0] == "cancel " + S.Name, "the next fill of a target seen before (a counted delta) cancels the stop: " + string.Join(" | ", CallsFrom(a, n)));
        Done(a);
    }

    // Fix4 (G1): a pair's cancel is not confirmed in time, so the swap restores; the stop it asked to cancel may still go, so it
    // never counts as protecting: the restore waits for it (bounded), and when it is still pending the answer is NOT `restored`
    // but `failed` with a status error naming it. When the cancel then lands, the stops are checked again at once and the pair
    // is placed again (never over the position).
    static void CancelLandsLate()
    {
        Account a = NewAccount("EVAL-V");
        Entry(a, true, 1, 25000); Entry(a, true, 1, 25004); Entry(a, true, 1, 25008);
        Order st3 = a.Orders.First(o => (o.Name ?? "").Contains(" stop f1 q1 p25008")), tg3 = a.Orders.First(o => (o.Name ?? "").Contains(" target f1 q1 p25008"));
        Hold = (kind, o) => kind == "cancel" && (o == st3 || o == tg3);   // NinjaTrader does not confirm that pair's cancel (yet)
        string m = DoMerge(a, "cl");
        Hold = null;
        Check(!m.Contains("\"result\":\"restored\"") && m.Contains("\"result\":\"failed\"") && m.Contains("is not confirmed") && m.Contains("ChartBridge places that pair again"),
              "G1: a cancel still pending: the answer is not `restored` (the stop may still go), and it says so: " + m);
        Check(Sent("\"level\":\"error\",\"text\":\"MNQ EVAL-V: the merge failed"), "and a status error");
        Check(StopCover(a) == 3 && IsLive(st3), "meanwhile nothing is placed for it (never over-protected if the cancel fails): " + string.Join(" | ", Live(a).Select(o => o.Name + " x" + o.Quantity + " " + o.OrderState)));
        int from;
        lock (sent) from = sent.Count;
        // the cancel lands now, after the merge ended
        st3.OrderState = OrderState.Cancelled; Update(a, st3);
        tg3.OrderState = OrderState.Cancelled; Update(a, tg3);
        string said = WaitFor(from, "the cancel of CB#", 3000);
        Stopwatch sw = Stopwatch.StartNew();
        while (StopCover(a) < 3 && sw.ElapsedMilliseconds < 3000) Thread.Sleep(5);
        Order again = Live(a).FirstOrDefault(o => (o.Name ?? "").Contains(" stop f1 q1 p25008")), againT = Live(a).FirstOrDefault(o => (o.Name ?? "").Contains(" target f1 q1 p25008"));
        Check(StopCover(a) == 3 && Pos(a) == 3 && again != null && again != st3 && again.StopPrice == 25006 && againT != null && again.Oco == againT.Oco && !string.IsNullOrEmpty(again.Oco),
              "G1: the late cancel lands: checked again at once, the pair placed again at its own prices, the stops cover the position: " + string.Join(" | ", Live(a).Select(o => o.Name + " x" + o.Quantity)));
        Check(said.Contains("landed late, after the merge ended; ChartBridge placed the pair again; the working stops cover 3 of 3"), "and the pages are told: " + said);
        Done(a);
    }

    // Fix4 (G1): the cancel lands while the restore waits for it: the pair is placed again and the answer is `restored`, with the
    // stops confirmed to cover the position.
    static void CancelLandsInRestore()
    {
        Account a = NewAccount("EVAL-W");
        Entry(a, true, 1, 25000); Entry(a, true, 1, 25004); Entry(a, true, 1, 25008);
        Order st3 = a.Orders.First(o => (o.Name ?? "").Contains(" stop f1 q1 p25008")), tg3 = a.Orders.First(o => (o.Name ?? "").Contains(" target f1 q1 p25008"));
        ChartBridgeOrders.MergeConfirmMs = 1000;
        Hold = (kind, o) => kind == "cancel" && (o == st3 || o == tg3);
        After = (kind, o) =>
        {
            if (kind != "cancel" || o != st3) return;
            After = null;
            new Thread(() => { Thread.Sleep(1500); st3.OrderState = OrderState.Cancelled; Update(a, st3); tg3.OrderState = OrderState.Cancelled; Update(a, tg3); }) { IsBackground = true }.Start();
        };
        string m = DoMerge(a, "cr");
        Hold = null; After = null;
        ChartBridgeOrders.MergeConfirmMs = 400;
        Order again = Live(a).FirstOrDefault(o => (o.Name ?? "").Contains(" stop f1 q1 p25008"));
        Check(m.Contains("\"result\":\"restored\"") && StopCover(a) == 3 && again != null && again != st3,
              "G1: the cancel lands while the restore waits (bounded): the pair is placed again and only then `restored`: " + m + " / " + string.Join(" | ", Live(a).Select(o => o.Name + " x" + o.Quantity)));
        Done(a);
    }

    // ------------------------------------------------------------ a restart in the middle of a swap
    static void Restarted()
    {
        File.WriteAllText(Path.Combine(ChartBridgeConfig.Folder, "merge_swap.txt"), "EVAL-A\tMNQ\t1791380000000\n");
        typeof(ChartBridgeOrders).GetField("mergeMarkerRead", PS).SetValue(null, false);
        int before;
        lock (sent) before = sent.Count;
        ChartBridgeOrders.CheckLegs();
        Check(WaitFor(before, "MNQ EVAL-A: ChartBridge restarted in the middle of a Merge", 1000).Contains("\"level\":\"error\""), "a restart in the middle of a swap: a status error naming the account and root");
        Check(!File.Exists(Path.Combine(ChartBridgeConfig.Folder, "merge_swap.txt")), "said once at the start");
        lock (sent) before = sent.Count;
        Msg("auth", "{\"type\":\"auth\",\"token\":\"" + ChartBridgeOrders.SessionJson().Split('"')[3] + "\"}");
        Check(WaitFor(before, "restarted in the middle of a Merge", 1000).Length > 0, "and to a page that signs in afterwards");
    }
}
