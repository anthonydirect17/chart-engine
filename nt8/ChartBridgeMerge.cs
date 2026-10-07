// ChartBridge 0.4.0: Merge stops and targets (config.txt "merge = on"; OFF by default). Part of the ChartBridge add-on;
// install with ChartBridgeOrders.cs (this file is more of the same class, ChartBridgeOrders, so it uses the gates and
// helpers there and adds none of its own). The contract is nt8/PROTOCOL.md "Merge stops and targets (merge = on)".
//
// Anthony's decision (2026-10-07): a Merge joins the per-leg stops and targets of one account's position on one root into
// ONE stop and one target set for the full size at the FIRST leg's prices. Multi-target (a strategy) keeps the first leg's
// target prices, with the split resized to the whole position by the allocation rule; as those targets fill, the stop
// shrinks. A leg added after a merge gets its own bracket until Merge again. Never unprotected, never over-protected; the
// original brackets are put back on any failure. Refused while an entry works, while the position changes, or when the
// first leg's stop is already through the market.
//
// How it runs (each rule below names the contract line it implements):
//   MergeStart     the page's "merge" message: every refusal, then the freeze, then the swap on its own thread
//   MergeSwap      the fixed order: newest pair first, cancel it, wait, re-read, grow the stop, wait, re-read
//   MergeRestore   any failure: shrink first, then put each pair back at its own prices, newest last
//   MergeFallback  the restore failed: what no stop covers gets one stop at the first leg's stop price (no working stop is
//                  cancelled first, fix1), and a status error naming what covers what
//   MergeOnFlip    the position turned to the other side mid-swap: no restore, the old side's legs cancelled, a status error
//   MergeOnOrderUpdate   upkeep of a multi-target merged set (a target fills: the stop shrinks; the stop fills: targets go)
// Order calls (Submit, Change, Cancel) are made only in MergeAct (the swap, its restore and fallback, always under
// MergeSendLock with the Flatten check) and in MergeKeepSet (the upkeep). Written in C# 5 (NinjaTrader 8).
#region Using declarations
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using NinjaTrader.Cbi;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    public static partial class ChartBridgeOrders
    {
        // ---------------------------------------------------------- the switch (config.txt "merge"; PROTOCOL "v3 switches")
        // Integration (0.4.0): one source of truth for every v3 switch, ChartBridgeSwitches in ChartBridgeV3.cs. ChartBridgeConfig.Load
        // records "merge" there (on, true or 1 mean on, any case; anything else is off, with one Output line naming the value), so
        // the trading message's switches.merge and this switch can never disagree.
        public static bool MergeOn { get { return ChartBridgeV3.Merge; } }

        private static void MergeResetConfig() { ChartBridgeSwitches.Note("merge", "off"); }

        // The key is ChartBridgeSwitches' (read in ChartBridgeConfig.Load before this): taken here only so nothing else reads it.
        private static bool MergeReadConfig(string key, string val) { return key == "merge"; }

        // ---------------------------------------------------------- timings (public for the Mono harness only)
        public static int MergeConfirmMs = 3000;   // "Each step waits for NinjaTrader to confirm it (3 s at most)"
        public static int MergeQuietMs = 2000;     // "the position changed in the last 2 s": refused
        public static int MergePollMs = 20;        // how often a waiting step looks at the orders again
        public static double MergeRestartAlarmMs = 600000;   // a swap cut by a restart: told to each page that signs in for 10 min (lead's default)

        // ---------------------------------------------------------- leg names (PROTOCOL "Brackets", "Order Strategies", "Merge")
        //   v2 leg        "CB#1a2b3c4d stop f2 q2 p24990.25"         the pair of the fill increment that brought the entry to 2 filled
        //   strategy leg  "CB#1a2b3c4d stop f2 q1 p24990.25 k2"      the same, for target bucket k (lane B1 places these)
        //   merged stop   "CB#1a2b3c4d mstop q3 p24980.25"           one stop for the merged contracts at that price (no OCO)
        //   merged target "CB#1a2b3c4d mtarget q1 p25010.25 k2"      a merged target of bucket k at that price (no OCO)
        // In leg names p is the fill price; in merged names p is the order's own price.
        private const string MergePx = "([0-9]{1,9}(?:\\.[0-9]{1,8})?)";
        // Integration: a pair's leg is read with ChartBridgeOrders' own LegNameRx (lane B1's, the bucket is group 6), never a copy.
        private static readonly Regex MergedRx = new Regex("^CB#([0-9a-f]{8}) (mstop|mtarget) q([0-9]{1,6}) p" + MergePx + "(?: k([1-3]))?$");

        private class MergeLeg { public Order Order; public string Tag, Role; public int Fill, Bucket; public bool Merged; }

        private static MergeLeg MergeParse(Order o)
        {
            string name = o != null ? o.Name ?? "" : "";
            Match m = LegNameRx.Match(name);
            if (m.Success && m.Groups[2].Value != "exit")   // a stop or a target; a market exit is not a leg
                return new MergeLeg { Order = o, Tag = m.Groups[1].Value, Role = m.Groups[2].Value, Fill = int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture),
                                      Bucket = m.Groups[6].Success ? int.Parse(m.Groups[6].Value, CultureInfo.InvariantCulture) : 0 };
            m = MergedRx.Match(name);
            if (m.Success)
                return new MergeLeg { Order = o, Tag = m.Groups[1].Value, Role = m.Groups[2].Value == "mstop" ? "stop" : "target", Merged = true,
                                      Bucket = m.Groups[5].Success ? int.Parse(m.Groups[5].Value, CultureInfo.InvariantCulture) : 0 };
            return null;
        }

        // Hooks for the rest of ChartBridgeOrders: a merged stop is a ChartBridge stop and a merged target a ChartBridge target, so
        // the legs check, the missing-stop alarm, "never opens a position" and Flatten treat them as legs.
        private static bool IsMergedLeg(Order o) { return o != null && MergedRx.IsMatch(o.Name ?? ""); }

        private static string MergedRole(string name)
        {
            Match m = MergedRx.Match(name ?? "");
            return !m.Success ? null : m.Groups[2].Value == "mstop" ? "stop" : "target";
        }

        // The group an order closes with (gate 3's pending orders, the legs check, the scan's leg cover): its OCO id; for a merged
        // set, which has no OCO, one group per account, contract and tag, because ChartBridge keeps its targets within its stop.
        // Null for a lone order.
        private static string MergeUnitKey(Order o)
        {
            if (!string.IsNullOrEmpty(o.Oco)) return o.Oco;
            Match m = MergedRx.Match(o.Name ?? "");
            if (!m.Success) return null;
            return "merged|" + (o.Account != null ? o.Account.Name : "") + "|" + (o.Instrument != null ? o.Instrument.FullName : "") + "|" + m.Groups[1].Value;
        }

        // The legs check shrinks a group that covers more than the position. A merged set is shrunk as a set: its stop to `keep`,
        // and its targets, from the last bucket back, so they add up to `keep` at most (each target alone would not be enough:
        // three targets of `keep` each could open a position). False when the legs are not a merged set (the v2 rule applies).
        private static bool MergeShrinkUnit(List<Order> legs, int keep, List<Order> cancel, List<Order> change)
        {
            if (legs.Count == 0 || !legs.All(IsMergedLeg)) return false;
            int room = keep;
            foreach (Order o in legs.Where(x => MergedRole(x.Name) == "stop"))
                if (o.Quantity - o.Filled > keep) { o.QuantityChanged = keep + o.Filled; change.Add(o); }
            foreach (Order o in legs.Where(x => MergedRole(x.Name) == "target").OrderBy(x => MergeParse(x).Bucket))
            {
                int open = o.Quantity - o.Filled, now = Math.Min(open, room);
                room -= now;
                if (now <= 0) cancel.Add(o);
                else if (now < open) { o.QuantityChanged = now + o.Filled; change.Add(o); }
            }
            return true;
        }

        // ---------------------------------------------------------- the strategy's target shares (the allocation rule)
        // Integration: one rule and one source. The shares come from lane B1's own state (ChartBridgeOrders.StrategyShares: the
        // live record, or the managed.txt line read at the start), and the allocation is B1's Allocate (PROTOCOL "Allocation";
        // a bucket that is gone: the position over the buckets left, by their shares out of their sum, lead's default). Never
        // guessed: unknown shares refuse.
        private static int[] MergeSharesFor(string tag) { return StrategyShares(tag); }

        // ---------------------------------------------------------- what a merge works on
        // A unit is one pair (a fill increment's stop and target, per bucket for a strategy) or one merged set (its stop and targets).
        private class MergeUnit
        {
            public string Tag;
            public int Fill, Bucket, Age;      // Age: the earliest index of its orders in NinjaTrader's list (oldest first)
            public bool Merged;
            public Order Stop;
            public List<Order> Targets = new List<Order>();
            public int Qty;                    // the stop's open contracts
            public List<MergeSpec> Specs = new List<MergeSpec>();   // remembered for the restore (contract step 2)
            public Pair OldPair;               // its v2 pair record, if ChartBridgeOrders has one (the re-placed legs keep partner upkeep)
            public string Name() { return "CB#" + Tag + (Merged ? " merged set" : " f" + Fill + (Bucket > 0 ? " k" + Bucket : "")); }
        }

        // One order as it was, to place it again: its name, side, type, prices, contracts and whether it was OCO'd.
        private class MergeSpec { public string Name, Role; public OrderAction Action; public OrderType Type; public double Limit, Stop; public int Qty; public bool Oco; }

        private class MergeSwapState
        {
            public Account Account; public Instrument Instrument; public string Root, Key, Cid, Where;
            public ChartBridgeClient Client;
            public int Pos;                                    // signed position when the merge started
            public List<MergeUnit> Units;                      // oldest first
            public List<MergeUnit> First;                      // the first leg's unit(s)
            public MergeUnit Kept;                             // single target: the pair kept and grown; or a merged set kept
            public bool Multi;                                 // two or three targets on the first leg
            public double StopPx;                              // the first leg's stop price
            public Order Stop;                                 // S, the stop that grows
            public bool NewStop;                               // S was placed by this merge
            public Order KeptTarget;                           // single target: the kept target that grows with S
            public int KeptStopQty, KeptTargetQty;             // what they had before the merge
            public List<MergeUnit> Absorbed = new List<MergeUnit>();   // cancelled and grown into S, in that order
            public MergeUnit InFlight;                         // cancelled, not yet grown into S
            public List<MergeSpec> OldTargets = new List<MergeSpec>();   // a kept merged set's targets, cancelled to be resized
            public List<Order> Placed = new List<Order>();        // every order this merge placed (S, merged targets, pairs put back)
            public int[] TargetBuckets; public double[] TargetPrices; public int[] Shares;
            public volatile bool Aborted;                      // Flatten arrived, or ChartBridge stopped (set under MergeSendLock)
            public volatile bool FlattenSent;                  // fix1 (F1): Flatten passed its gates and was sent (the only Flatten abort)
            public volatile bool Stopped;                      // ChartBridge stopped (Clear): merge_swap.txt stays for the next start
            public volatile bool Restoring;                    // the restore or fallback runs: a fill no longer stops a step
            public volatile string Trouble;                    // a fill, an order error: the next check stops the swap
        }

        private static readonly object MergeLock = new object();       // the swaps, the counters, the fill times; never held while sending
        private static readonly object MergeSendLock = new object();   // a swap's order call and Flatten's abort, one at a time (never taken on NinjaTrader's thread)
        private static readonly Dictionary<string, MergeSwapState> MergeSwaps = new Dictionary<string, MergeSwapState>();   // account|contract
        private static readonly Dictionary<string, double> MergeChangedAt = new Dictionary<string, double>();   // account|contract -> last fill or position event
        private static readonly Dictionary<Order, int> MergeSeenFilled = new Dictionary<Order, int>();
        private static long mergeOk, mergeRestored, mergeFailed, mergeRefused;
        private static double mergeLastAt;
        private static readonly List<KeyValuePair<double, string>> MergeHeldAlarms = new List<KeyValuePair<double, string>>();
        private static bool mergeMarkerRead;
        private static int mergeOcoSeq;
        // Fix1: a restored pair's OCO id is unique across runs too (a restart starts the count again): the run's start, in
        // seconds, as hex ("cb-1a2b3c4d-2-r67012ab3-1").
        private static readonly string MergeRunId = ((long)(ChartBridgeTime.NowUtcMs() / 1000)).ToString("x", CultureInfo.InvariantCulture);
        private static readonly object MergeFileLock = new object();   // fix1: merge_swap.txt, one writer at a time (two swaps on two accounts)

        private static void MergeClear()
        {
            List<MergeSwapState> running;
            lock (MergeLock)
            {
                running = MergeSwaps.Values.ToList();
                MergeSwaps.Clear(); MergeChangedAt.Clear(); MergeSeenFilled.Clear(); MergeHeldAlarms.Clear(); MergeFirstSeen.Clear();
                mergeMarkerRead = false;
            }
            lock (MergeSendLock) foreach (MergeSwapState s in running) { s.Stopped = true; s.Aborted = true; }   // a running swap sends nothing more
        }

        public static string MergeDiagJson()
        {
            lock (MergeLock)
                return "{\"ok\":" + mergeOk + ",\"restored\":" + mergeRestored + ",\"failed\":" + mergeFailed + ",\"refused\":" + mergeRefused +
                       ",\"lastAtUtcMs\":" + (mergeLastAt > 0 ? CbJson.Num3(mergeLastAt) : "null") + ",\"running\":" + MergeSwaps.Count + "}";
        }

        // ---------------------------------------------------------- the freeze (contract step 1)
        // While a swap runs on an account and root, order, plan, change, cancel (lead's default: cancel too) and merge on it are
        // refused; breakeven and trailing pause (MergeFrozen, for the strategies code); Flatten is always accepted and ends it.
        // Integration: a swap running on any contract of this account (the copier will not take it as a follower meanwhile).
        internal static bool MergeRunningOn(Account a)
        {
            if (a == null) return false;
            lock (MergeLock) return MergeSwaps.Values.Any(s => s.Account == a);
        }

        public static bool MergeFrozen(Account a, Instrument i)
        {
            if (a == null || i == null) return false;
            lock (MergeLock) return MergeSwaps.ContainsKey(PosKey(a, i));
        }

        // Called by OnMessage after the gate, for order, plan, change and cancel. Null when not frozen.
        private static string MergeFreezeWhy(string type, string top, string id)
        {
            lock (MergeLock) if (MergeSwaps.Count == 0) return null;
            Account a = null; Instrument i = null;
            if (type == "order")
            {
                string name = Str(top, "account");
                lock (Account.All) foreach (Account x in Account.All) if (name != null && x.Name.Equals(name, StringComparison.OrdinalIgnoreCase)) { a = x; break; }
                i = ChartBridgeServer.InstrumentFor((Str(top, "root") ?? "").ToUpperInvariant());
            }
            else
            {
                Order o;
                lock (Sync) ById.TryGetValue(id ?? "", out o);
                if (o != null) { a = o.Account; i = o.Instrument; }
            }
            if (!MergeFrozen(a, i)) return null;
            return "a Merge is running on " + Where(a, i) + "; " + type + " is refused until it ends (Flatten is always accepted)";
        }

        // Flatten (always accepted): the swap on that account and root stops at once, before any further order call.
        // Fix1 (F1): called by Flatten itself, only after Flatten passed its gates (the account Connected, the root served), and
        // the flatten call is made under the same lock, so nothing the swap sends can follow it. A Flatten that is refused never
        // gets here: the swap goes on, or restores, exactly as without it, and its answer never says Flatten ended it. If the
        // flatten call itself throws, the swap is let go again (it restores; "Flatten could not be sent").
        private static void MergeFlattenSend(Account a, Instrument inst, Action flatten)
        {
            List<MergeSwapState> hit;
            lock (MergeLock) hit = MergeSwaps.Values.Where(s => s.Account == a && SameInstrument(s.Instrument, inst)).ToList();
            lock (MergeSendLock)
            {
                foreach (MergeSwapState s in hit) s.Aborted = true;   // after this, the swap sends nothing more
                try { flatten(); }
                catch (Exception ex)
                {
                    foreach (MergeSwapState s in hit) { if (s.Trouble == null) s.Trouble = "Flatten could not be sent (" + ex.Message + ")"; s.Aborted = false; }
                    throw;
                }
                foreach (MergeSwapState s in hit) s.FlattenSent = true;
            }
        }

        // ---------------------------------------------------------- events (hooks from OnOrderUpdate and OnPositionUpdate)
        private static void MergeSawPosition(Account a, Instrument i)
        {
            if (a == null || i == null) return;
            KeyValuePair<string, double> first;
            bool again;
            double now = ChartBridgeTime.NowUtcMs();
            lock (MergeLock)
            {
                MergeChangedAt[PosKey(a, i)] = now;
                again = MergeFirstSeen.TryGetValue(PosKey(a, i), out first) && now - first.Value <= MoveTtlMs;   // fix1: a merged target first seen with fills
                if (MergeFirstSeen.ContainsKey(PosKey(a, i)) && !again) MergeFirstSeen.Remove(PosKey(a, i));
            }
            if (again) MergeShrinkToHeld(a, i, first.Key);
        }

        // Every order event. A fill on the account and contract is "the position is changing" for 2 s; during a swap it stops the
        // swap ("a fill during the swap"), as does an error on an order the swap works on. Outside a swap, a merged set is kept.
        private static void MergeOnOrderUpdate(Account a, Order o, ErrorCode error)
        {
            if (a == null || o == null || o.Instrument == null) return;
            string key = PosKey(a, o.Instrument);
            int delta, had;
            bool known;
            MergeSwapState swap;
            lock (MergeLock)
            {
                // A fill is counted from the last event seen for the order. An order first seen with fills (after a restart) has an
                // unknown history: it counts as a change of the position, and the legs check (not a guess) trims its merged stop.
                known = MergeSeenFilled.TryGetValue(o, out had);
                delta = Math.Max(0, o.Filled - had);
                if (IsDone(o.OrderState)) MergeSeenFilled.Remove(o); else MergeSeenFilled[o] = o.Filled;
                if (delta > 0) MergeChangedAt[key] = ChartBridgeTime.NowUtcMs();
                MergeSwaps.TryGetValue(key, out swap);
            }
            if (swap != null)
            {
                if (delta > 0 && swap.Trouble == null) swap.Trouble = "a fill during the merge (" + (o.Name ?? "an order") + ")";
                else if ((error != ErrorCode.NoError || o.OrderState == OrderState.Rejected) && swap.Trouble == null && MergeSwapOrder(swap, o))
                    swap.Trouble = "NinjaTrader refused a step (" + (o.Name ?? "") + ": " + (error != ErrorCode.NoError ? error.ToString() : "rejected") + ")";
                return;   // the swap owns the orders on this account and contract until it ends
            }
            if (delta > 0 && known && IsMergedLeg(o)) MergeKeepSet(a, o, delta);
            else if (!known && o.Filled > 0 && MergedRole(o.Name) == "target") MergeKeepSetFirstSeen(a, o);   // fix1: after a restart
        }

        // Fix1: a merged target first seen with fills (after a restart its history is unknown, so a delta cannot be counted):
        // the merged stop shrinks to what NinjaTrader's position holds beyond the other ChartBridge stops, at once if the
        // position already shows the fill, else at the position update that follows (within MoveTtlMs). NinjaTrader's own
        // position only: the fills-in-transit reading can count a fill from before the restart twice. It never grows the stop
        // and never cancels it on this reading (flat, the other side, or nothing left is for the legs check, once settled).
        private static readonly Dictionary<string, KeyValuePair<string, double>> MergeFirstSeen = new Dictionary<string, KeyValuePair<string, double>>();   // account|contract -> tag, time

        private static void MergeKeepSetFirstSeen(Account a, Order target)
        {
            MergeLeg leg = MergeParse(target);
            if (leg == null || !leg.Merged) return;
            lock (MergeLock) MergeFirstSeen[PosKey(a, target.Instrument)] = new KeyValuePair<string, double>(leg.Tag, ChartBridgeTime.NowUtcMs());
            MergeShrinkToHeld(a, target.Instrument, leg.Tag);
        }

        private static void MergeShrinkToHeld(Account a, Instrument inst, string tag)
        {
            List<Order> working = MergeWorkingOrders(a, inst);
            Order s = working.FirstOrDefault(o => { MergeLeg l = MergeParse(o); return l != null && l.Merged && l.Tag == tag && l.Role == "stop" && IsWorking(o.OrderState); });
            if (s == null) return;
            bool closingBuy = IsBuy(s);
            int now = SignedPosition(a, inst);
            if (now == 0 || (now < 0) != closingBuy) return;
            int others = working.Where(o => o != s && IsBuy(o) == closingBuy && MayFill(o.OrderState) && MergeParse(o) != null && MergeParse(o).Role == "stop").Sum(o => Math.Max(0, o.Quantity - o.Filled));
            int asked = s.QuantityChanged > 0 ? Math.Min(s.Quantity, s.QuantityChanged) : s.Quantity;
            int open = asked - s.Filled, want = Math.Abs(now) - others;
            if (want <= 0 || want >= open) return;
            s.QuantityChanged = want + s.Filled;
            a.Change(new[] { s });
            ChartBridgeServer.Log("merge upkeep " + Where(a, inst) + ": a merged target first seen with fills (after a restart); the merged stop shrinks to " + want + " (the position " + Math.Abs(now) + ", other stops " + others + ")");
        }

        private static bool MergeSwapOrder(MergeSwapState s, Order o)
        {
            if (o == s.Stop || o == s.KeptTarget || s.Placed.Contains(o)) return true;
            foreach (MergeUnit u in s.Units) if (u.Stop == o || u.Targets.Contains(o)) return true;
            return MergeParse(o) != null;
        }

        // A merged set after the merge (PROTOCOL: "As a target fills, ChartBridge shrinks S to the position at once (change on its
        // quantity); when S fills, ChartBridge cancels the targets"). Runs even with trading off, like all bracket upkeep.
        private static void MergeKeepSet(Account a, Order filled, int delta)
        {
            MergeLeg leg = MergeParse(filled);
            if (leg == null || !leg.Merged) return;
            List<Order> set = MergeWorkingOrders(a, filled.Instrument).Where(o => { MergeLeg l = MergeParse(o); return l != null && l.Merged && l.Tag == leg.Tag; }).ToList();
            string where = Where(a, filled.Instrument);
            if (leg.Role == "target")
            {
                Order s = set.FirstOrDefault(o => MergedRole(o.Name) == "stop");
                if (s == null) return;
                // From the size last asked for when a shrink is not confirmed yet (two fills in a row), never from more.
                int asked = s.QuantityChanged > 0 ? Math.Min(s.Quantity, s.QuantityChanged) : s.Quantity;
                int open = asked - s.Filled - delta;
                if (open <= 0) a.Cancel(new[] { s });
                else { s.QuantityChanged = open + s.Filled; a.Change(new[] { s }); }
                ChartBridgeServer.Log("merge upkeep " + where + ": a merged target filled " + delta + "; the merged stop " + (open <= 0 ? "is cancelled" : "shrinks to " + open));
                return;
            }
            int stopOpen = Math.Max(0, filled.Quantity - filled.Filled), room = stopOpen;
            List<Order> cancel = new List<Order>(), change = new List<Order>();
            foreach (Order t in set.Where(o => MergedRole(o.Name) == "target").OrderBy(o => MergeParse(o).Bucket))
            {
                int open = t.Quantity - t.Filled, keep = Math.Min(open, room);
                room -= keep;
                if (keep <= 0) cancel.Add(t); else if (keep < open) { t.QuantityChanged = keep + t.Filled; change.Add(t); }
            }
            if (cancel.Count > 0) a.Cancel(cancel.ToArray());
            if (change.Count > 0) a.Change(change.ToArray());
            ChartBridgeServer.Log("merge upkeep " + where + ": the merged stop filled " + delta + "; cancelled " + cancel.Count + " and shrank " + change.Count + " merged target(s)");
        }

        // A restart in the middle of a swap (PROTOCOL: "caught by the legs check and the missing-stop alarm as in v2, with a status
        // error naming the account and root"): merge_swap.txt names the swaps running; it is read at the first legs check after a
        // start, and each one left is an error, to the pages now and to each page that signs in for the next 10 minutes.
        private static string MergeMarkerFile { get { return Path.Combine(ChartBridgeConfig.Folder, "merge_swap.txt"); } }

        private static void MergeEvery2s(double now)
        {
            bool read;
            lock (MergeLock) { read = mergeMarkerRead; mergeMarkerRead = true; }
            if (read) return;
            List<string> lines = new List<string>();
            try { lock (MergeFileLock) { if (File.Exists(MergeMarkerFile)) lines = File.ReadAllLines(MergeMarkerFile).Where(l => l.Trim().Length > 0).ToList(); File.Delete(MergeMarkerFile); } }
            catch (Exception ex) { ChartBridgeServer.Log("merge: merge_swap.txt could not be read (" + ex.Message + ")"); }
            foreach (string l in lines)
            {
                string[] f = l.Split('\t');
                if (f.Length < 2) continue;
                string text = f[1] + " " + f[0] + ": ChartBridge restarted in the middle of a Merge; the stops and targets may be part merged; check the position's stop in NinjaTrader";
                lock (MergeLock) MergeHeldAlarms.Add(new KeyValuePair<double, string>(now, text));
                Alarm(text);
            }
        }

        // Called by Auth for a page that signed in.
        private static void MergeOnAuth(ChartBridgeClient client)
        {
            List<string> texts;
            double now = ChartBridgeTime.NowUtcMs();
            lock (MergeLock) texts = MergeHeldAlarms.Where(kv => now - kv.Key < MergeRestartAlarmMs).Select(kv => kv.Value).ToList();
            foreach (string t in texts) client.Send("{\"type\":\"status\",\"level\":\"error\",\"text\":" + CbJson.Str(t) + "}");
        }

        // Fix1: read, changed and written whole under MergeFileLock (two swaps on two accounts never lose each other's line),
        // through a temp file swapped in (a crash never leaves half a file).
        private static void MergeMarker(MergeSwapState s, bool running)
        {
            try
            {
                lock (MergeFileLock)
                {
                    List<string> lines = File.Exists(MergeMarkerFile) ? File.ReadAllLines(MergeMarkerFile).ToList() : new List<string>();
                    string me = s.Account.Name + "\t" + s.Root;
                    lines.RemoveAll(l => l.StartsWith(me + "\t", StringComparison.Ordinal) || l == me);
                    if (running) lines.Add(me + "\t" + ((long)ChartBridgeTime.NowUtcMs()).ToString(CultureInfo.InvariantCulture));
                    Directory.CreateDirectory(ChartBridgeConfig.Folder);
                    if (lines.Count == 0) { if (File.Exists(MergeMarkerFile)) File.Delete(MergeMarkerFile); return; }
                    string tmp = MergeMarkerFile + ".tmp";
                    File.WriteAllLines(tmp, lines.ToArray());
                    if (File.Exists(MergeMarkerFile)) File.Replace(tmp, MergeMarkerFile, null); else File.Move(tmp, MergeMarkerFile);
                }
            }
            catch (Exception ex) { ChartBridgeServer.Log("merge: merge_swap.txt could not be written (" + ex.Message + ")"); }
        }

        // ---------------------------------------------------------- the page's "merge" message: the refusals, then the swap
        private static string MergeRefuse(string why) { lock (MergeLock) mergeRefused++; return why; }

        // Returns why it is refused (a reject; nothing reaches NinjaTrader), or null once the swap has started.
        private static string MergeStart(ChartBridgeClient client, string top, string cid)
        {
            if (!MergeOn) return MergeRefuse("Merge is off in config.txt (merge = on turns it on)");
            string why, accountName = Str(top, "account"), root = (Str(top, "root") ?? "").ToUpperInvariant();
            Account account = FindAccount(accountName, out why);                    // gate 2: allowed and Connected
            if (account == null) return MergeRefuse(why);
            why = ChartBridgeCopier.MergeRefusal(account);                           // integration (lead's default): never on a copier follower
            if (why != null) return MergeRefuse(why);
            Instrument inst = ChartBridgeServer.InstrumentFor(root);                 // gate 6: a root ChartBridge trades
            if (inst == null) return MergeRefuse("instrument " + root + " is not served by ChartBridge");
            MergeSwapState s = new MergeSwapState { Account = account, Instrument = inst, Root = root, Key = PosKey(account, inst), Cid = cid, Client = client, Where = Where(account, inst) };
            // Integration (lane B1): breakeven and trailing paused on this account and contract before the stop prices are read,
            // until the swap ends (PROTOCOL "Merge", step 1: "breakeven/trailing on it are ... paused for the swap").
            PauseStrategies(account, inst, true);
            why = MergePlan(s);
            if (why == null)
                lock (MergeLock)
                {
                    if (MergeSwaps.ContainsKey(s.Key)) why = "a Merge is already running on " + s.Where;
                    else MergeSwaps[s.Key] = s;                                         // the freeze (step 1)
                }
            if (why != null) { if (!MergeFrozen(account, inst)) PauseStrategies(account, inst, false); return MergeRefuse(why); }
            ChartBridgeServer.Log("merge started on " + s.Where + ": " + s.Units.Count + " pair(s), position " + s.Pos + ", stop " + MergeText(s.StopPx) +
                                  (s.Multi ? ", " + s.TargetBuckets.Length + " targets resized" : ""));
            Thread t = new Thread(() => MergeRun(s)) { IsBackground = true, Name = "ChartBridge merge" };
            t.Start();
            return null;
        }

        // Every refusal of the contract, in its order; on success fills in the plan (which pairs, which kept, the prices).
        private static string MergePlan(MergeSwapState s)
        {
            Account a = s.Account; Instrument i = s.Instrument;
            double now = ChartBridgeTime.NowUtcMs();
            lock (MergeLock) if (MergeSwaps.ContainsKey(s.Key)) return "a Merge is already running on " + s.Where;
            // "the position is flat"
            int posNow = SignedPosition(a, i), posEff = EffectivePosition(a, i);
            if (posNow == 0 && posEff == 0) return "Nothing to merge: " + a.Name + " is flat on " + s.Root + ".";
            // "the position changed in the last 2 s or the two position readings disagree (the position is changing)"
            double at;
            bool recent;
            lock (MergeLock) recent = MergeChangedAt.TryGetValue(s.Key, out at) && now - at < MergeQuietMs;
            if (posNow != posEff || recent) return "Merge is refused while the position is changing on " + s.Where + "; try again in a moment.";
            s.Pos = posNow;
            bool closingBuy = s.Pos < 0;
            // "an entry (any ChartBridge entry, or an order placed elsewhere on the opening side) is working or part filled"
            List<Order> working = MergeWorkingOrders(a, i);
            foreach (Order o in working)
            {
                MergeLeg l = MergeParse(o);
                bool cbOther = (o.Name ?? "").StartsWith("CB#", StringComparison.Ordinal) && l == null;   // a ChartBridge entry or market exit
                if (cbOther || (l == null && IsBuy(o) != closingBuy))
                    return "Merge is refused while an entry is working on " + a.Name + " " + s.Root + ".";
            }
            // "the account has not been Connected for 30 s without a break"
            if (!Steady(a, now)) return "Merge is refused: " + a.Name + " has not been connected for 30 seconds without a break; try again in a moment.";
            // the pairs, oldest first
            string why = MergeUnits(s, working);
            if (why != null) return why;
            // "there are fewer than two pairs"
            if (s.Units.Count < 2) return "Nothing to merge: the position has " + s.Units.Count + " stop and target pair(s).";
            // "the working ChartBridge stops do not cover exactly the position (let the legs check settle first)"
            int stops = s.Units.Sum(u => u.Qty);
            if (stops != Math.Abs(s.Pos))
                return "Merge is refused: the working stops cover " + stops + " of " + Math.Abs(s.Pos) + " contracts; let the legs check settle first.";
            why = MergeFirstLeg(s);
            if (why != null) return why;
            // "the first leg's stop is already through the market (a long's at or above the last trade, a short's at or below)"
            double last;
            string stale = LastPrice(s.Root, out last);
            if (stale != null) return "Merge is refused: " + stale;
            if (s.Pos > 0 ? s.StopPx >= last : s.StopPx <= last)
                return "Merge is refused: the first leg's stop " + MergeText(s.StopPx) + " is already through the market (last " + MergeText(last) + ").";
            return null;
        }

        // Every working order on the account and contract, NinjaTrader's list first (its order is the age), then ChartBridge's own
        // just sent and not listed yet.
        private static List<Order> MergeWorkingOrders(Account a, Instrument i)
        {
            List<Order> orders;
            lock (a.Orders) orders = a.Orders.ToList();
            lock (Sync) foreach (Order o in Ours) if (o.Account == a && !orders.Contains(o)) orders.Add(o);
            return orders.Where(o => SameInstrument(o.Instrument, i) && MayFill(o.OrderState)).ToList();
        }

        // Groups the working ChartBridge stops and targets into units: a pair per fill increment (and bucket), a merged set per tag.
        private static string MergeUnits(MergeSwapState s, List<Order> working)
        {
            bool closingBuy = s.Pos < 0;
            Dictionary<string, MergeUnit> byKey = new Dictionary<string, MergeUnit>();
            List<MergeUnit> units = new List<MergeUnit>();
            for (int n = 0; n < working.Count; n++)
            {
                Order o = working[n];
                MergeLeg l = MergeParse(o);
                if (l == null) continue;
                if (!IsWorking(o.OrderState)) return "Merge is refused: a stop or target on " + s.Where + " is being cancelled; let the legs check settle first.";
                if (IsBuy(o) != closingBuy) return "Merge is refused: a ChartBridge leg on " + s.Where + " is on the wrong side of the position; let the legs check settle first.";
                string key = l.Merged ? "m|" + l.Tag : "p|" + l.Tag + "|" + l.Fill + "|" + l.Bucket;
                MergeUnit u;
                if (!byKey.TryGetValue(key, out u)) { byKey[key] = u = new MergeUnit { Tag = l.Tag, Fill = l.Fill, Bucket = l.Bucket, Merged = l.Merged, Age = n }; units.Add(u); }
                if (l.Role == "stop")
                {
                    if (u.Stop != null) return "Merge is refused: " + u.Name() + " has two stops; check the orders in NinjaTrader.";
                    u.Stop = o;
                }
                else
                {
                    if (!l.Merged && u.Targets.Count > 0) return "Merge is refused: " + u.Name() + " has two targets; check the orders in NinjaTrader.";
                    u.Targets.Add(o);
                }
            }
            foreach (MergeUnit u in units)
            {
                if (u.Stop == null) return "Merge is refused: " + u.Name() + " has a target and no stop; let the legs check settle first.";
                u.Qty = u.Stop.Quantity - u.Stop.Filled;
                if (u.Targets.Sum(t => t.Quantity - t.Filled) > u.Qty)
                    return "Merge is refused: the targets of " + u.Name() + " are larger than its stop; let the legs check settle first.";
                u.Specs.Add(MergeSpecOf(u.Stop, "stop"));
                foreach (Order t in u.Targets) u.Specs.Add(MergeSpecOf(t, "target"));
                lock (Sync) PairOfLeg.TryGetValue(u.Stop, out u.OldPair);
            }
            s.Units = units.OrderBy(u => u.Age).ToList();
            return null;
        }

        private static MergeSpec MergeSpecOf(Order o, string role)
        {
            return new MergeSpec { Name = o.Name, Role = role, Action = o.OrderAction, Type = o.OrderType, Limit = o.LimitPrice, Stop = o.StopPrice,
                                   Qty = o.Quantity - o.Filled, Oco = !string.IsNullOrEmpty(o.Oco) };
        }

        // The first leg: the oldest fill increment's pair or pairs (all buckets of it), or a merged set from an earlier Merge. Decides
        // single target (keep and grow one pair) or two or three targets (a new stop, the targets resized by the allocation rule).
        private static string MergeFirstLeg(MergeSwapState s)
        {
            MergeUnit oldest = s.Units[0];
            s.First = oldest.Merged ? new List<MergeUnit> { oldest } : s.Units.Where(u => !u.Merged && u.Tag == oldest.Tag && u.Fill == oldest.Fill).ToList();
            List<double> stopPrices = s.First.Select(u => u.Stop.StopPrice).Distinct().ToList();
            if (stopPrices.Count != 1 || s.First.Select(u => u.Stop.OrderType).Distinct().Count() != 1)
                return "Merge is refused: the first leg's stops are at different prices (breakeven or trailing moved some); merge them by hand.";   // lead's default
            s.StopPx = stopPrices[0];
            List<Order> firstTargets = s.First.SelectMany(u => u.Targets).ToList();
            s.Multi = firstTargets.Count >= 2;
            if (!s.Multi)
            {
                // Single target (or none): the first pair is kept and grown (with a merged set first, its stop and its one target).
                s.Kept = s.First.FirstOrDefault(u => u.Targets.Count > 0) ?? s.First[0];
                s.Stop = s.Kept.Stop; s.KeptStopQty = s.Kept.Qty;
                s.KeptTarget = s.Kept.Targets.FirstOrDefault();
                s.KeptTargetQty = s.KeptTarget != null ? s.KeptTarget.Quantity - s.KeptTarget.Filled : 0;
                return null;
            }
            // Two or three targets: the strategy's shares, for the buckets the first leg has.
            List<KeyValuePair<int, double>> buckets = new List<KeyValuePair<int, double>>();
            foreach (Order t in firstTargets)
            {
                MergeLeg l = MergeParse(t);
                if (l.Bucket < 1 || buckets.Any(b => b.Key == l.Bucket)) return "Merge is refused: the first leg's targets are not one per bucket (k1 to k3); merge them by hand.";
                buckets.Add(new KeyValuePair<int, double>(l.Bucket, t.LimitPrice));
            }
            buckets = buckets.OrderBy(b => b.Key).ToList();
            int[] all = MergeSharesFor(oldest.Tag);
            if (all == null) return "Merge is refused: the target shares of strategy entry CB#" + oldest.Tag + " are not known (no line in managed.txt); nothing changed.";
            s.TargetBuckets = buckets.Select(b => b.Key).ToArray();
            s.TargetPrices = buckets.Select(b => b.Value).ToArray();
            s.Shares = s.TargetBuckets.Select(k => all[k - 1]).ToArray();
            if (s.Shares.Any(x => x <= 0)) return "Merge is refused: the target shares of strategy entry CB#" + oldest.Tag + " do not match its targets; nothing changed.";
            if (oldest.Merged) { s.Kept = oldest; s.Stop = oldest.Stop; s.KeptStopQty = oldest.Qty; }   // an earlier merged set: its stop is kept and grown
            return null;
        }

        // ---------------------------------------------------------- the swap (its own thread)
        private static void MergeRun(MergeSwapState s)
        {
            string result = "merged", text = null, why = null;
            MergeMarker(s, true);
            try
            {
                why = MergeSwap(s);
                if (why == null) why = MergeVerify(s);
                if (why == "Flatten" && !s.Aborted) why = s.Trouble ?? "Flatten could not be sent";   // fix1 (F1): the swap was let go again
                if (why == null) text = MergeDoneText(s);
                else if (s.Aborted) { result = "failed"; text = MergeAbortText(s); }
                else if (MergeFlipped(s)) { result = "failed"; text = MergeOnFlip(s); }   // fix1: never a restore that adds to the new position
                else
                {
                    ChartBridgeServer.Log("merge on " + s.Where + " stopped (" + why + "); putting the original brackets back");
                    string rwhy = MergeRestore(s);
                    if (rwhy == null) { result = "restored"; text = "The merge stopped (" + why + "); the original brackets are back"; }
                    else if (s.Aborted) { result = "failed"; text = MergeAbortText(s); }
                    else { result = "failed"; text = MergeFallback(s, why, rwhy); }
                }
            }
            catch (Exception ex)
            {
                ChartBridgeServer.Log("merge error on " + s.Where + ": " + ex);
                result = "failed";
                try { text = s.Aborted ? MergeAbortText(s) : MergeFallback(s, "ChartBridge error: " + ex.Message, "not tried"); }
                catch (Exception ex2) { text = "the merge failed (" + ex2.Message + ")"; Alarm(s.Where + ": the merge failed and ChartBridge could not check the stop; check the position's stop in NinjaTrader now"); }
            }
            finally
            {
                // Integration (lane B1; lead's default): the pairs breakeven and trailing followed are gone (merged, or placed again as
                // new orders), so they stop on this position; every stop stays where it is and the pages are told (managed, unmanaged).
                // Fix1 (F4): before the unfreeze (breakeven and trailing stay paused until then) and before the swap's line leaves
                // merge_swap.txt, so managed.txt already says "merged" when a restart can next read it.
                try { if (!s.Stopped) StrategiesMerged(s.Account, s.Instrument, s.Root + " " + s.Account.Name + ": Merge " + result + "; breakeven and trailing stopped for this position, every stop stays where it is (manage it by hand)"); }
                catch (Exception ex) { ChartBridgeServer.Log("merge: strategies could not be told (" + ex.Message + ")"); }
                lock (MergeLock) { if (!s.Stopped) { MergeSwaps.Remove(s.Key); MergeChangedAt[s.Key] = ChartBridgeTime.NowUtcMs(); } }   // unfreeze
                if (!s.Stopped) MergeMarker(s, false);   // ChartBridge stopped mid-swap: the next start says so
            }
            MergeFinish(s, result, text);
        }

        private static string MergeAbortText(MergeSwapState s)
        {
            if (s.Stopped) return "ChartBridge stopped during the merge; check the position's stop in NinjaTrader";
            return s.FlattenSent ? "Flatten ended the merge; Flatten cancels the working orders and closes the position"
                                 : "the merge was stopped; check the position's stop in NinjaTrader";
        }

        // Contract steps 2 to 4. Null when every step was confirmed, or why it stopped.
        private static string MergeSwap(MergeSwapState s)
        {
            // Step 3: every pair other than the one kept, newest first: cancel, wait, re-read; grow S, wait, re-read.
            List<MergeUnit> order = s.Units.Where(u => u != s.Kept).OrderByDescending(u => u.Age).ToList();
            foreach (MergeUnit u in order)
            {
                string why = MergeCheck(s);
                if (why != null) return why;
                s.InFlight = u;
                why = MergeCancelUnit(s, u);
                if (why != null) return why;
                why = MergeCheck(s);
                if (why != null) return why;
                // Grow S by this pair: never above the position (its contracts were just uncovered).
                int stops = MergeStopCover(s);
                if (stops + u.Qty > Math.Abs(s.Pos)) return "the working stops would cover more than the position";
                why = MergeGrowStop(s, u.Qty);
                if (why != null) return why;
                s.Absorbed.Add(u); s.InFlight = null;
                why = MergeCheck(s);
                if (why != null) return why;
                if (s.KeptTarget != null && !s.Multi)
                {
                    why = MergeResize(s, s.KeptTarget, s.KeptTargetQty + s.Absorbed.Sum(x => x.Qty));
                    if (why != null) return why;
                }
            }
            if (!s.Multi) return null;
            // Step 4 (a strategy): the merged targets last, their total equal to the position. A kept merged set's old targets
            // go first (they are resized), then the new ones at the first leg's target prices.
            if (s.Kept != null && s.Kept.Targets.Count > 0)
            {
                foreach (Order t in s.Kept.Targets) s.OldTargets.Add(MergeSpecOf(t, "target"));
                string why = MergeCancelOrders(s, s.Kept.Targets.Where(t => IsWorking(t.OrderState)).ToList());
                if (why != null) return why;
            }
            int[] qty = Allocate(Math.Abs(s.Pos), s.Shares);   // integration: B1's allocation rule
            List<Order> place = new List<Order>();
            for (int b = 0; b < qty.Length; b++)
            {
                if (qty[b] <= 0) continue;   // a target that gets 0 is dropped
                string name = "CB#" + s.Units[0].Tag + " mtarget q" + qty[b] + " p" + MergePrice(s.TargetPrices[b]) + " k" + s.TargetBuckets[b];
                place.Add(s.Account.CreateOrder(s.Instrument, MergeExitAction(s), OrderType.Limit, OrderEntry.Manual, TimeInForce.Gtc, qty[b], s.TargetPrices[b], 0, "", name, NinjaTrader.Core.Globals.MaxDate, null));
            }
            string w = MergeCheck(s);
            if (w != null) return w;
            return MergeSubmit(s, place, null);
        }

        // Re-read before each step: Flatten, a fill, an order error, the position (both readings) and the connection.
        private static string MergeCheck(MergeSwapState s)
        {
            if (s.Aborted) return "Flatten";
            if (s.Trouble != null) return s.Trouble;
            int posNow = SignedPosition(s.Account, s.Instrument), posEff = EffectivePosition(s.Account, s.Instrument);
            if (posNow != s.Pos || posEff != s.Pos) return "the position changed during the merge (" + s.Pos + " to " + posNow + ")";
            if (!Steady(s.Account, ChartBridgeTime.NowUtcMs())) return "the account's connection dropped (a reconnect)";
            if (MergeStopCover(s) > Math.Abs(s.Pos)) return "the working stops cover more than the position";
            return null;
        }

        // Contracts the ChartBridge stops on the closing side may still close (working, or a cancel not yet confirmed): the
        // number that must never be above the position.
        private static int MergeStopCover(MergeSwapState s)
        {
            bool closingBuy = s.Pos < 0;
            int n = 0;
            foreach (Order o in MergeWorkingOrders(s.Account, s.Instrument))
            {
                MergeLeg l = MergeParse(o);
                if (l != null && l.Role == "stop" && IsBuy(o) == closingBuy) n += Math.Max(0, o.Quantity - o.Filled);
            }
            return n;
        }

        private static OrderAction MergeExitAction(MergeSwapState s) { return s.Pos > 0 ? OrderAction.Sell : OrderAction.Buy; }

        // Cancel a pair (its stop and its target; lead's default: both are sent, so a pair whose OCO is slow is not left
        // half-cancelled) and wait until both are confirmed cancelled.
        private static string MergeCancelUnit(MergeSwapState s, MergeUnit u)
        {
            List<Order> legs = new List<Order> { u.Stop };
            legs.AddRange(u.Targets);
            return MergeCancelOrders(s, legs.Where(o => MayFill(o.OrderState)).ToList());
        }

        private static string MergeCancelOrders(MergeSwapState s, List<Order> orders)
        {
            if (orders.Count == 0) return null;
            int[] filledBefore = orders.Select(o => o.Filled).ToArray();
            string why = MergeAct(s, "cancel", orders, null);
            if (why != null) return why;
            ChartBridgeServer.Log("merge step on " + s.Where + ": cancel " + string.Join(", ", orders.Select(o => o.Name ?? "")));
            return MergeWait(s, () => orders.All(o => o.OrderState == OrderState.Cancelled),
                             () => orders.Where((o, n) => o.Filled > filledBefore[n]).Any() ? "a fill during the merge (" + (orders[0].Name ?? "") + ")" : null,
                             "the cancel of " + (orders[0].Name ?? ""));
        }

        // Grow S by qty: the kept stop's quantity (a change), or for a strategy the first time a new S is placed for qty.
        private static string MergeGrowStop(MergeSwapState s, int qty)
        {
            if (s.Stop != null && IsWorking(s.Stop.OrderState)) return MergeResize(s, s.Stop, s.Stop.Quantity - s.Stop.Filled + qty);
            if (s.Stop != null) return "the merged stop is no longer working";
            MergeUnit first = s.First[0];
            Order f = first.Stop;
            string name = "CB#" + first.Tag + " mstop q" + Math.Abs(s.Pos) + " p" + MergePrice(s.StopPx);
            Order stop = s.Account.CreateOrder(s.Instrument, MergeExitAction(s), f.OrderType, OrderEntry.Manual, TimeInForce.Gtc, qty,
                f.OrderType == OrderType.StopLimit ? f.LimitPrice : 0, s.StopPx, "", name, NinjaTrader.Core.Globals.MaxDate, null);   // a stop-limit keeps its offset
            s.Stop = stop; s.NewStop = true;
            return MergeSubmit(s, new List<Order> { stop }, null);
        }

        // Change an order to `open` contracts still to fill, and wait until NinjaTrader shows that quantity. 0 cancels it.
        private static string MergeResize(MergeSwapState s, Order o, int open)
        {
            if (o == null) return null;
            if (open <= 0) return MergeCancelOrders(s, MayFill(o.OrderState) ? new List<Order> { o } : new List<Order>());
            if (!IsWorking(o.OrderState)) return (o.Name ?? "an order") + " is no longer working";
            int want = open + o.Filled;
            if (o.Quantity == want && (o.QuantityChanged == 0 || o.QuantityChanged == want)) return null;   // no change asked that was not confirmed
            o.QuantityChanged = want;
            string why = MergeAct(s, "change", new List<Order> { o }, null);
            if (why != null) return why;
            ChartBridgeServer.Log("merge step on " + s.Where + ": " + (o.Name ?? "") + " to " + open + " contract(s)");
            return MergeWait(s, () => o.Quantity == want && MergeAccepted(o.OrderState), () => IsDone(o.OrderState) ? (o.Name ?? "an order") + " is " + StateText(o.OrderState) : null,
                             "the change of " + (o.Name ?? "") + " to " + open);
        }

        // Submit new orders, then wait until NinjaTrader has accepted every one (a market exit: or filled it).
        private static string MergeSubmit(MergeSwapState s, List<Order> orders, Pair pair)
        {
            if (orders.Count == 0) return null;
            string why = MergeAct(s, "submit", orders, pair);
            if (why != null) return why;
            ChartBridgeServer.Log("merge step on " + s.Where + ": placed " + string.Join(", ", orders.Select(o => (o.Name ?? "") + " for " + o.Quantity)));
            return MergeWait(s, () => orders.All(MergeConfirmed), () => orders.Any(o => o.OrderState == OrderState.Rejected) ? "NinjaTrader rejected " + orders.First(o => o.OrderState == OrderState.Rejected).Name : null,
                             "the order " + (orders[0].Name ?? ""));
        }

        private static bool MergeAccepted(OrderState st) { return st == OrderState.Accepted || st == OrderState.Working || st == OrderState.TriggerPending; }
        private static bool MergeConfirmed(Order o) { return MergeAccepted(o.OrderState) || (o.OrderType == OrderType.Market && (o.OrderState == OrderState.Filled || o.OrderState == OrderState.PartFilled)); }

        // The one place this file sends an order call during a swap: under MergeSendLock, and never after Flatten (Flatten sets
        // Aborted under the same lock, so nothing the swap sends can follow it). New orders are registered as ChartBridge legs
        // (like PlaceLegs': an id, Ours, their age, the missing-stop alarm, a pair's partner upkeep) only when they are sent.
        private static string MergeAct(MergeSwapState s, string kind, List<Order> orders, Pair pair)
        {
            lock (MergeSendLock)
            {
                if (s.Aborted) return "Flatten";
                if (kind == "cancel") { NoteWeCancelSafe(() => orders, "cancel"); s.Account.Cancel(orders.ToArray()); }
                else if (kind == "change") s.Account.Change(orders.ToArray());
                else
                {
                    double now = ChartBridgeTime.NowUtcMs();
                    lock (Sync)
                    {
                        Manage(s.Account, s.Instrument);
                        foreach (Order o in orders) { IdFor(o); Ours.Add(o); LegBorn[o] = now; if (pair != null) PairOfLeg[o] = pair; }
                    }
                    lock (MergeLock) foreach (Order o in orders) { s.Placed.Add(o); MergeSeenFilled[o] = 0; }
                    s.Account.Submit(orders.ToArray());
                }
            }
            return null;
        }

        // Wait up to MergeConfirmMs for NinjaTrader to confirm. Stops at once on Flatten or on an error event for the step.
        private static string MergeWait(MergeSwapState s, Func<bool> done, Func<string> failed, string what)
        {
            double start = ChartBridgeTime.NowUtcMs();
            while (true)
            {
                if (s.Aborted) return "Flatten";
                if (done()) return null;
                string bad = failed();
                if (bad != null) return bad;
                if (s.Trouble != null && !s.Restoring) return s.Trouble;
                if (ChartBridgeTime.NowUtcMs() - start > MergeConfirmMs) return "NinjaTrader did not confirm " + what + " within " + (MergeConfirmMs / 1000.0).ToString("0.#", CultureInfo.InvariantCulture) + " s";
                Thread.Sleep(MergePollMs);
            }
        }

        // Step 5: one working stop for exactly the position; targets not above it.
        private static string MergeVerify(MergeSwapState s)
        {
            string why = MergeCheck(s);
            if (why != null) return why;
            bool closingBuy = s.Pos < 0;
            List<Order> stops = new List<Order>(), targets = new List<Order>();
            foreach (Order o in MergeWorkingOrders(s.Account, s.Instrument))
            {
                MergeLeg l = MergeParse(o);
                if (l == null || IsBuy(o) != closingBuy) continue;
                if (l.Role == "stop") stops.Add(o); else targets.Add(o);
            }
            if (stops.Count != 1 || stops[0] != s.Stop || s.Stop.Quantity - s.Stop.Filled != Math.Abs(s.Pos)) return "the check after the merge did not find one stop for the whole position";
            if (targets.Sum(t => t.Quantity - t.Filled) > Math.Abs(s.Pos)) return "the check after the merge found targets above the position";
            return null;
        }

        // ---------------------------------------------------------- the restore (any failure)
        // "S shrinks back pair by pair (shrink first, then place that pair again at its original prices), newest last, with the
        // same checks." A pair is placed again only for what the position still needs, so the stops are never above it (after a
        // fill during the swap the position may be smaller). Null when the original brackets are back.
        private static string MergeRestore(MergeSwapState s)
        {
            if (s.Aborted) return "Flatten";
            s.Restoring = true;   // the restore is the answer to a fill; Flatten and each step's own result still count
            // The merged targets this swap placed go first.
            string why = MergeCancelOrders(s, s.Placed.Where(o => MergedRole(o.Name) == "target" && MayFill(o.OrderState)).ToList());
            if (why != null) return why;
            // S to what it should be with every pair still in it; a change that was not confirmed is sent again.
            why = MergeResizeS(s);
            if (why != null) return why;
            // A pair cancelled and not yet grown into S: back first.
            if (s.InFlight != null) { why = MergePlaceAgain(s, s.InFlight); if (why != null) return why; s.InFlight = null; }
            // Then the pairs in S, newest last: shrink S first, then place the pair.
            for (int n = s.Absorbed.Count - 1; n >= 0; n--)
            {
                MergeUnit u = s.Absorbed[n];
                s.Absorbed.RemoveAt(n);
                why = MergeResizeS(s);
                if (why != null) return why;
                why = MergePlaceAgain(s, u);
                if (why != null) return why;
            }
            // A kept merged set's old targets, at their own prices.
            if (s.OldTargets.Count > 0)
            {
                List<Order> place = s.OldTargets.Select(sp => MergeCreate(s, sp, sp.Qty, "")).ToList();
                why = MergeSubmit(s, place, null);
                if (why != null) return why;
            }
            // The same check: the stops cover exactly the position.
            if (s.Aborted) return "Flatten";
            int pos = Math.Abs(SignedPosition(s.Account, s.Instrument)), cover = MergeStopCover(s);
            if (cover != pos) return "after the restore the working stops cover " + cover + " of " + pos + " contracts";
            return null;
        }

        // S (and a kept target) to the contracts of the pairs still in it, never above what the position needs.
        private static string MergeResizeS(MergeSwapState s)
        {
            if (s.Stop == null) return null;
            int inS = s.KeptStopQty + s.Absorbed.Sum(u => u.Qty);
            int others = MergeStopCover(s) - (MayFill(s.Stop.OrderState) ? Math.Max(0, s.Stop.Quantity - s.Stop.Filled) : 0);
            int want = Math.Min(inS, Math.Max(0, Math.Abs(SignedPosition(s.Account, s.Instrument)) - others));
            if (!MayFill(s.Stop.OrderState)) return want > 0 ? "the merged stop is no longer working" : null;
            string why = MergeResize(s, s.Stop, want);
            if (why != null) return why;
            if (s.KeptTarget != null && !s.Multi && MayFill(s.KeptTarget.OrderState))
                return MergeResize(s, s.KeptTarget, Math.Min(want, s.KeptTargetQty + s.Absorbed.Sum(u => u.Qty)));
            return null;
        }

        // One pair (or merged set) again at its original prices and names, for at most what the position still needs.
        private static string MergePlaceAgain(MergeSwapState s, MergeUnit u)
        {
            if (s.Aborted) return "Flatten";
            if (MayFill(u.Stop.OrderState)) return null;   // its cancel never landed: it is still there
            if (MergeFlipped(s)) return "the position turned to the other side";   // fix1: the fallback then cancels the old side (MergeOnFlip)
            int pos = Math.Abs(SignedPosition(s.Account, s.Instrument)), qty = Math.Min(u.Qty, pos - MergeStopCover(s));
            if (qty <= 0) { ChartBridgeServer.Log("merge restore on " + s.Where + ": " + u.Name() + " not placed again; the position no longer needs it"); return null; }
            List<MergeSpec> specs = u.Specs.Where(sp => sp.Role == "stop" || !u.Merged).ToList();
            bool oco = specs.Count > 1 && specs.All(sp => sp.Oco);
            string ocoId = oco ? "cb-" + u.Tag + "-" + u.Fill + (u.Bucket > 0 ? "k" + u.Bucket : "") + "-r" + MergeRunId + "-" + Interlocked.Increment(ref mergeOcoSeq).ToString(CultureInfo.InvariantCulture) : "";
            List<Order> place = specs.Select(sp => MergeCreate(s, sp, Math.Min(qty, sp.Qty), ocoId)).ToList();
            Pair pair = null;
            if (!u.Merged)
            {
                pair = new Pair { Bracket = u.OldPair != null ? u.OldPair.Bracket : null, Qty = qty };
                pair.Stop = place.FirstOrDefault(o => MergeParse(o).Role == "stop");
                pair.Target = place.FirstOrDefault(o => MergeParse(o).Role == "target");
            }
            string why = MergeSubmit(s, place, pair);
            if (why != null) return why;
            if (u.Merged)
            {
                // A merged set's targets (only an earlier merge's set is ever cancelled whole): within its stop.
                int room = qty;
                List<Order> targets = new List<Order>();
                foreach (MergeSpec sp in u.Specs.Where(x => x.Role == "target")) { int q = Math.Min(sp.Qty, room); room -= q; if (q > 0) targets.Add(MergeCreate(s, sp, q, "")); }
                why = MergeSubmit(s, targets, null);
            }
            return why;
        }

        private static Order MergeCreate(MergeSwapState s, MergeSpec sp, int qty, string oco)
        {
            return s.Account.CreateOrder(s.Instrument, sp.Action, sp.Type, OrderEntry.Manual, TimeInForce.Gtc, qty, sp.Limit, sp.Stop, oco, sp.Name, NinjaTrader.Core.Globals.MaxDate, null);
        }

        // ---------------------------------------------------------- the restore failed
        // PROTOCOL "Merge": "If the restore itself fails, ChartBridge makes sure one working stop covers the whole position at the
        // first leg's stop price (the stop-already-traded rule applies), and raises a status error".
        // Fix1 (F3): never by cancelling a stop first. A working stop is never cancelled or moved here before something else covers
        // its contracts, and moving one into another would need a moment with two stops for the same contracts (over-protected)
        // or none (unprotected). So: every stop and target still working stays where it is (a pair keeps its OCO target); the
        // contracts no working stop covers get ONE stop at the first leg's stop price (the merged stop this merge placed grown,
        // when it has no OCO partner, or a new mstop), or a market exit when a trade from the last 2 s is at or through that
        // price; stops above the position (a fill during the swap) are trimmed, this merge's own stop first, a target before its
        // stop. A placement that is rejected or not confirmed leaves every existing stop in place. The status error names what
        // covers what. Flat: every ChartBridge leg there is cancelled (nothing to protect, and a stop could open a position).
        // The position turned to the other side: MergeOnFlip. Returns the text.
        private static string MergeFallback(MergeSwapState s, string why, string rwhy)
        {
            ChartBridgeServer.Log("merge restore on " + s.Where + " failed (" + rwhy + "); covering what no stop covers at " + MergeText(s.StopPx));
            s.Restoring = true;
            if (MergeFlipped(s)) return MergeOnFlip(s);
            string head = s.Where + ": the merge failed and the original brackets could not be put back";
            // This merge's own merged targets, and a target whose OCO stop is gone (a pair put back with its stop rejected): never
            // the OCO partner of a working stop, so cancelling them leaves every stop working.
            List<Order> all = MergeWorkingOrders(s.Account, s.Instrument);
            MergeCancelOrders(s, all.Where(o => MayFill(o.OrderState) && ((s.Placed.Contains(o) && MergedRole(o.Name) == "target") ||
                (MergeParse(o) != null && MergeParse(o).Role == "target" && !string.IsNullOrEmpty(o.Oco) && !all.Any(x => x != o && x.Oco == o.Oco && MayFill(x.OrderState)))) ).ToList());
            int pos = Math.Abs(SignedPosition(s.Account, s.Instrument));
            string text;
            if (pos == 0)
            {
                List<Order> legs = MergeWorkingOrders(s.Account, s.Instrument).Where(o => MergeParse(o) != null).ToList();
                string c = MergeCancelOrders(s, legs);
                text = head + "; the position is flat now, so ChartBridge cancelled its " + legs.Count + " stop and target order(s) there" +
                       (c != null ? " (not confirmed: " + c + ")" : "") + "; check NinjaTrader";
            }
            else
            {
                int cover = MergeStopCover(s);
                string did;
                if (cover > pos)
                {
                    string t = MergeTrim(s, cover - pos);
                    did = t == null ? "ChartBridge trimmed the stops to the position" : "the stops cover more than the position and could not be trimmed (" + t + ")";
                }
                else if (cover < pos) did = MergeCoverGap(s, pos - cover);
                else did = "nothing was cancelled; the stops still working cover the position";
                text = head + "; " + did + "; " + MergeCoverText(s) + "; check NinjaTrader";
            }
            Alarm(text);
            return text;
        }

        // The contracts no working stop covers (need): one stop at the first leg's stop price, confirmed, or a market exit when
        // the stop level has already traded. Never touches a working stop other than growing this merge's own merged stop.
        private static string MergeCoverGap(MergeSwapState s, int need)
        {
            double last;
            if (FreshLast(s.Root, FreshTickMs, out last) && (s.Pos > 0 ? s.StopPx >= last : s.StopPx <= last))
            {
                // The stop-already-traded rule (PROTOCOL "Brackets"): a trade from the last 2 s at or through the stop: exit at market.
                Order x = s.Account.CreateOrder(s.Instrument, MergeExitAction(s), OrderType.Market, OrderEntry.Manual, TimeInForce.Day, need, 0, 0, "",
                    "CB#" + s.First[0].Tag + " exit f" + s.First[0].Fill + " q" + need + " p" + MergePrice(s.StopPx), NinjaTrader.Core.Globals.MaxDate, null);
                string put = MergeSubmit(s, new List<Order> { x }, null);
                return "price had already passed the stop level " + MergeText(s.StopPx) + " (last " + MergeText(last) + "), so ChartBridge EXITED the " + need +
                       " contract(s) no stop covered at market" + (put != null ? ", and that did not go through (" + put + "): " + need + " contract(s) may have NO STOP; act in NinjaTrader now" : "");
            }
            Order keep = s.Stop != null && s.NewStop && IsWorking(s.Stop.OrderState) && string.IsNullOrEmpty(s.Stop.Oco) ? s.Stop : null;
            string why;
            if (keep != null) why = MergeResize(s, keep, keep.Quantity - keep.Filled + need);
            else
            {
                Order f = s.First[0].Stop;
                Order st = s.Account.CreateOrder(s.Instrument, MergeExitAction(s), f.OrderType, OrderEntry.Manual, TimeInForce.Gtc, need,
                    f.OrderType == OrderType.StopLimit ? f.LimitPrice : 0, s.StopPx, "", "CB#" + s.First[0].Tag + " mstop q" + need + " p" + MergePrice(s.StopPx), NinjaTrader.Core.Globals.MaxDate, null);
                why = MergeSubmit(s, new List<Order> { st }, null);
            }
            if (why == null) return "nothing working was cancelled, and ONE STOP at " + MergeText(s.StopPx) + " now covers the " + need + " contract(s) no stop covered";
            return "the stop for the " + need + " contract(s) no stop covered could not be placed (" + why + "), so every stop still working stays where it is and " +
                   need + " contract(s) may have NO STOP; act in NinjaTrader now";
        }

        // Stops above the position: trimmed by `excess` contracts, this merge's own stop first, then the newest; an OCO target
        // first goes down to its stop's new size (a target never above its stop), then the stop. Only ever less protection than
        // the position's excess, never a stop below what is held. Null, or why it stopped.
        private static string MergeTrim(MergeSwapState s, int excess)
        {
            bool closingBuy = s.Pos < 0;
            List<Order> stops = MergeWorkingOrders(s.Account, s.Instrument).Where(o => { MergeLeg l = MergeParse(o); return l != null && l.Role == "stop" && IsBuy(o) == closingBuy && IsWorking(o.OrderState); }).ToList();
            stops.Reverse();   // newest first (NinjaTrader's list is oldest first)
            if (s.Stop != null && stops.Remove(s.Stop)) stops.Insert(0, s.Stop);
            foreach (Order st in stops)
            {
                if (excess <= 0) break;
                int open = st.Quantity - st.Filled, now = open - Math.Min(open, excess);
                if (!string.IsNullOrEmpty(st.Oco))
                    foreach (Order t in MergeWorkingOrders(s.Account, s.Instrument).Where(o => o != st && o.Oco == st.Oco && IsWorking(o.OrderState)).ToList())
                        if (now > 0 && t.Quantity - t.Filled > now) { string w = MergeResize(s, t, now); if (w != null) return w; }
                string why = MergeResize(s, st, now);   // 0 cancels it (and its OCO target with it)
                if (why != null) return why;
                excess -= open - now;
            }
            return excess > 0 ? "no stop left to trim" : null;
        }

        // What covers what, for the status error: "the stops cover 3 of 3 contracts (2 at 24,998, 1 at 25,002); targets 1 at 25,004".
        private static string MergeCoverText(MergeSwapState s)
        {
            bool closingBuy = s.Pos < 0;
            int pos = Math.Abs(SignedPosition(s.Account, s.Instrument)), cover = 0;
            SortedDictionary<double, int> stops = new SortedDictionary<double, int>(), targets = new SortedDictionary<double, int>();
            foreach (Order o in MergeWorkingOrders(s.Account, s.Instrument))
            {
                MergeLeg l = MergeParse(o);
                if (l == null || IsBuy(o) != closingBuy || !MayFill(o.OrderState)) continue;
                int open = Math.Max(0, o.Quantity - o.Filled);
                SortedDictionary<double, int> into = l.Role == "stop" ? stops : targets;
                double px = l.Role == "stop" ? o.StopPrice : o.LimitPrice;
                int had;
                into.TryGetValue(px, out had);
                into[px] = had + open;
                if (l.Role == "stop") cover += open;
            }
            Func<SortedDictionary<double, int>, string> list = d => string.Join(", ", d.Select(kv => kv.Value + " at " + MergeText(kv.Key)));
            return "the working stops cover " + cover + " of " + pos + " contract(s)" + (stops.Count > 0 ? " (" + list(stops) + ")" : "") +
                   (cover < pos ? ": " + (pos - cover) + " contract(s) have NO STOP" : "") + (targets.Count > 0 ? "; targets " + list(targets) : "; NO TARGET");
        }

        // ---------------------------------------------------------- the position turned to the other side mid-swap
        // Fix1: a long that is now short (or the reverse). Nothing is put back: a stop or target of the old position is on the
        // side that adds to the new one. Every ChartBridge leg on the old closing side is cancelled (none covers anything held),
        // the new position's own legs stay, and a status error says what is left.
        private static bool MergeFlipped(MergeSwapState s)
        {
            int now = SignedPosition(s.Account, s.Instrument), eff = EffectivePosition(s.Account, s.Instrument);
            return (now != 0 && Math.Sign(now) != Math.Sign(s.Pos)) || (eff != 0 && Math.Sign(eff) != Math.Sign(s.Pos));
        }

        private static string MergeOnFlip(MergeSwapState s)
        {
            s.Restoring = true;
            bool oldClosingBuy = s.Pos < 0;
            int now = SignedPosition(s.Account, s.Instrument);
            List<Order> old = MergeWorkingOrders(s.Account, s.Instrument).Where(o => MergeParse(o) != null && IsBuy(o) == oldClosingBuy).ToList();
            string c = MergeCancelOrders(s, old);
            bool newClosingBuy = now < 0;
            int cover = MergeWorkingOrders(s.Account, s.Instrument).Where(o => { MergeLeg l = MergeParse(o); return l != null && l.Role == "stop" && IsBuy(o) == newClosingBuy && MayFill(o.OrderState); })
                                                               .Sum(o => Math.Max(0, o.Quantity - o.Filled));
            string text = s.Where + ": the position turned from " + s.Pos + " to " + now + " during the merge; nothing was put back (it would add to the new position); ChartBridge cancelled the " +
                          old.Count + " stop and target order(s) of the old position" + (c != null ? " (not confirmed: " + c + ")" : "") + "; its stops cover " + cover + " of the " +
                          Math.Abs(now) + " contract(s) held now" + (cover < Math.Abs(now) ? ": " + (Math.Abs(now) - cover) + " contract(s) have NO STOP; act in NinjaTrader now" : "; check NinjaTrader");
            Alarm(text);
            return text;
        }

        // ---------------------------------------------------------- the end: the page, the Output window, /diag
        private static string MergeDoneText(MergeSwapState s)
        {
            int size = Math.Abs(s.Pos);
            List<Order> tg = MergeResultTargets(s);
            return "Merged " + s.Units.Count + " pairs into one stop for " + size + " contract(s) at " + MergeText(s.StopPx) +
                   (tg.Count == 0 ? " and no target" : tg.Count == 1 ? " and one target at " + MergeText(tg[0].LimitPrice) : " and " + tg.Count + " targets");
        }

        private static List<Order> MergeResultTargets(MergeSwapState s)
        {
            if (!s.Multi) return s.KeptTarget != null && IsWorking(s.KeptTarget.OrderState) ? new List<Order> { s.KeptTarget } : new List<Order>();
            return s.Placed.Where(o => MergedRole(o.Name) == "target" && IsWorking(o.OrderState)).ToList();
        }

        private static void MergeFinish(MergeSwapState s, string result, string text)
        {
            lock (MergeLock)
            {
                if (result == "merged") mergeOk++; else if (result == "restored") mergeRestored++; else mergeFailed++;
                mergeLastAt = ChartBridgeTime.NowUtcMs();
            }
            StringBuilder b = new StringBuilder("{\"type\":\"merge\"");
            if (s.Cid != null) b.Append(",\"cid\":").Append(CbJson.Str(s.Cid));
            b.Append(",\"account\":").Append(CbJson.Str(s.Account.Name)).Append(",\"root\":").Append(CbJson.Str(s.Root)).Append(",\"result\":").Append(CbJson.Str(result));
            Order stop = result != "merged" ? null : MergeWorkingOrders(s.Account, s.Instrument).FirstOrDefault(o => { MergeLeg l = MergeParse(o); return l != null && l.Role == "stop" && IsWorking(o.OrderState); });
            // Fix1 (F3): after a failed merge several stops can be working (none is cancelled to make one); "stop" then gives the
            // first leg's stop price and the contracts the working stops at that price cover (lead's default; the text says the rest).
            int atPx = 0;
            if (result == "failed" && !s.Aborted)
                foreach (Order o in MergeWorkingOrders(s.Account, s.Instrument))
                {
                    MergeLeg l = MergeParse(o);
                    if (l != null && l.Role == "stop" && IsWorking(o.OrderState) && Math.Abs(o.StopPrice - s.StopPx) < 1e-9) atPx += Math.Max(0, o.Quantity - o.Filled);
                }
            if (result == "merged")
                b.Append(",\"stop\":{\"price\":").Append(CbJson.Num(stop != null ? stop.StopPrice : s.StopPx)).Append(",\"qty\":").Append(stop != null ? stop.Quantity - stop.Filled : 0).Append('}');
            else if (atPx > 0) b.Append(",\"stop\":{\"price\":").Append(CbJson.Num(s.StopPx)).Append(",\"qty\":").Append(atPx).Append('}');
            else b.Append(",\"stop\":null");
            b.Append(",\"targets\":[");
            if (result == "merged") b.Append(string.Join(",", MergeResultTargets(s).Select(t => "{\"price\":" + CbJson.Num(t.LimitPrice) + ",\"qty\":" + (t.Quantity - t.Filled) + "}")));
            b.Append("],\"pairsBefore\":").Append(s.Units.Count).Append(",\"text\":").Append(CbJson.Str(text ?? "")).Append('}');
            ChartBridgeServer.Log("merge " + result + " on " + s.Where + ": " + text);
            MergeSendToV3Pages(s.Client, b.ToString());
        }

        // The "merge" answer goes to every signed-in v3 page (PROTOCOL "Telling the page what is on": a v2 page gets no v3
        // message), through the one shared v3 helper (ChartBridgeV3.cs).
        private static void MergeSendToV3Pages(ChartBridgeClient asked, string json)
        {
            try { ChartBridgeV3.SendToV3Traders(json); } catch (Exception ex) { ChartBridgeServer.Log("merge: could not tell the pages (" + ex.Message + ")"); }
        }

        // Prices: "24980.25" in names and on the wire; "24,980.25" in text Anthony reads.
        private static string MergePrice(double p) { return p.ToString("0.########", CultureInfo.InvariantCulture); }
        private static string MergeText(double p) { return p.ToString("#,0.########", CultureInfo.InvariantCulture); }
    }
}
