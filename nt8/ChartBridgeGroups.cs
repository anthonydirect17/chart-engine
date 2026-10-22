// ChartBridge prop groups and real account state (ChartBridge 0.5.8; 0.6.1: each group's Type and default hero; 0.6.5: each member's
// own rules and the group's risk percent; 0.6.6: the firm's rules on an account in no group, firmMinimum, and the firm's limits on
// entries: FirmMaxWhy, MachineHold, the daily loss reached and riskAlert; 0.6.7: a member on the bench, memberBench, no hedging
// always on, a group's own fallback rules optional and never sizing a group entry). Part of the
// ChartBridge add-on; install it with the other files. See nt8/PROTOCOL.md, "Prop groups and account state (0.5.8)",
// "A group's Type and default hero (0.6.1)", "Each member's own rules and the risk percent (0.6.5)", "The firm's floor, Remove a
// follower and the firm's limits on entries (0.6.6)" and "The bench (0.6.7)".
//
// This file never places, changes or cancels an order itself (no Submit, Change, Cancel or Flatten here; Q-EXIT's cancel of an exit
// left behind goes through ChartBridgeOrders.GroupCancelLeftover). It holds:
//   - the groups (Anthony 2026-10-14): made, renamed and deleted on the page's Settings, an account's group picked on the
//     Accounts tab, all saved by ChartBridge in groups.txt next to config.txt (two # lines, then group, member and personal
//     lines). No groups.txt: no groups, every account personal with no limits, exactly as 0.5.7. A groups.txt that cannot be
//     read is never rewritten that run and refuses every new entry (exits always work), with an alarm, like accounts.txt;
//   - the one-direction check (G3 a): EntryCheck, asked under PlaceLock for every entry (PlaceOrderLocked and the copier's
//     Eligible) and by the agent's plan check 10b (advisory). The whole group, every market: while any member holds a long (a
//     position, or a working buy entry), no member may open a short, and the other way round. Exits never come here as
//     entries: an exit of the account's own position passes (no stop or target asked, no strategy, the other side of the
//     position by both readings, at most the position with the exits already working);
//   - the account's real numbers (item 5): with NinjaTrader's balance and P&L and the group's rules (G1: account size and
//     "floor stops at"), the floor, the room to it, the daily room (open P&L counted) and the target left, for the pages'
//     accounts message and the agent's accountState. account-marks.txt keeps each account's highs and its day start (G2: the
//     highs start from the "highest close so far" the page asks for when an account joins a group). Never estimated: a number
//     ChartBridge cannot give is null with the reason.
// Lock order: ChartBridgeOrders' GroupEntryLock, then PlaceLock, then SaveLock, then Mem. Mem only guards memory: never held during
// file I/O or a NinjaTrader call. 0.6.7 (review LOW 1): the group save with a risk percent and the bench move decide and change memory
// under GroupEntryLock and PlaceLock, then let them go and write groups.txt under SaveLock alone (ChangeAndSave), so an exit never
// waits on that write. AccountGroup still saves under PlaceLock, as before 0.6.7. Written in C# 5 syntax (NinjaTrader 8 compiles NinjaScript as C# 5).
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
    // ---------------------------------------------------------------- the groups' window into ChartBridgeOrders (read only)
    public static partial class ChartBridgeOrders
    {
        internal static object GroupPlaceLock { get { return PlaceLock; } }

        // One thing an account holds, for the one-direction check: a position (by either reading) or a working entry.
        internal sealed class GroupHolding
        {
            public string Account, Root, What, Kind;   // What: position or entry; Kind: the entry's order kind
            public int Side, Qty;                      // Side: +1 long, -1 short
        }

        // ChartBridge's own orders that are never entries: its legs and exits, the copier's close, merged legs, an agent's flat,
        // protect and stop placed again. (An order with an OCO id is never an entry either, below.)
        private static readonly Regex GroupNotEntryRx = new Regex("^CB#[0-9a-f]{8} (?:stop|target|exit|mstop|mtarget|copy out)(?: |$)");

        private static string MasterName(Instrument i) { return i == null ? "?" : i.MasterInstrument != null && !string.IsNullOrEmpty(i.MasterInstrument.Name) ? i.MasterInstrument.Name : (i.FullName ?? "?").Split(' ')[0]; }

        // Everything account a holds or has working as an entry, every instrument: positions by NinjaTrader's list and with the
        // fills not yet in it (both readings; one that differs in side counts too), and every order that may still fill on
        // NinjaTrader's list or just sent by ChartBridge (Ours), but its legs, exits, OCO parts, and an order on the other side
        // of that account's position (both readings) for no more than the position.
        internal static List<GroupHolding> GroupHoldings(Account a)
        {
            List<GroupHolding> list = new List<GroupHolding>();
            if (a == null) return list;
            Dictionary<string, int> listed = new Dictionary<string, int>(), moved = new Dictionary<string, int>();
            Dictionary<string, string> rootOf = new Dictionary<string, string>();
            List<Position> ps;
            lock (a.Positions) ps = a.Positions.ToList();
            foreach (Position p in ps)
            {
                if (p == null || p.Instrument == null || p.MarketPosition == MarketPosition.Flat || p.Quantity == 0) continue;
                string full = p.Instrument.FullName ?? "";
                int signed = p.MarketPosition == MarketPosition.Long ? p.Quantity : -p.Quantity, had;
                listed.TryGetValue(full, out had); listed[full] = had + signed;
                rootOf[full] = MasterName(p.Instrument);
            }
            double now = ChartBridgeTime.NowUtcMs();
            string prefix = (a.Name ?? "") + "|";
            lock (Moves)
                foreach (KeyValuePair<string, List<double[]>> kv in Moves)
                {
                    if (!kv.Key.StartsWith(prefix, StringComparison.Ordinal)) continue;
                    int m = (int)kv.Value.Where(x => now - x[1] <= MoveTtlMs).Sum(x => x[0]);
                    if (m == 0) continue;
                    string full = kv.Key.Substring(prefix.Length), had2;
                    int was;
                    moved.TryGetValue(full, out was); moved[full] = was + m;
                    if (!rootOf.TryGetValue(full, out had2)) rootOf[full] = full.Split(' ')[0];
                }
            foreach (string full in listed.Keys.Union(moved.Keys).ToList())
            {
                int l, mv;
                listed.TryGetValue(full, out l); moved.TryGetValue(full, out mv);
                int e = l + mv;
                if (l != 0) list.Add(new GroupHolding { Account = a.Name, Root = rootOf[full], What = "position", Side = Math.Sign(l), Qty = Math.Abs(l) });
                if (e != 0 && Math.Sign(e) != Math.Sign(l)) list.Add(new GroupHolding { Account = a.Name, Root = rootOf[full], What = "position", Side = Math.Sign(e), Qty = Math.Abs(e) });
            }
            List<Order> orders;
            lock (a.Orders) orders = a.Orders.ToList();
            lock (Sync) foreach (Order o in Ours) if (o.Account == a && !orders.Contains(o)) orders.Add(o);
            // Review of #48 (item 5): orders on the other side of a position are exits only up to the position, summed per contract
            // (two sells of 2 on a long 2: the second is an entry of 2); orders are taken in the list's order.
            Dictionary<string, int> exitLeft = new Dictionary<string, int>();
            // Re-review 2 of #48 (item 1): an OCO order is protective while a position is held (never counted); once both readings
            // of that contract are 0, OCO orders count, once per OCO id and side at the largest (only one of them can fill).
            Dictionary<string, GroupHolding> ocoFlat = new Dictionary<string, GroupHolding>();
            foreach (Order o in orders)
            {
                if (o == null || !MayFill(o.OrderState)) continue;
                string name = o.Name ?? "";
                if (GroupNotEntryRx.IsMatch(name) || AgentMarketRx.IsMatch(name) || IsMergedLeg(o)) continue;
                int left = Math.Max(0, o.Quantity - o.Filled);
                if (left == 0) continue;
                bool buy = IsBuy(o);
                string full = o.Instrument != null ? o.Instrument.FullName ?? "" : "";
                int l, mv;
                listed.TryGetValue(full, out l); moved.TryGetValue(full, out mv);
                if (!string.IsNullOrEmpty(o.Oco))
                {
                    if (l != 0 || l + mv != 0) continue;
                    string k = full + "|" + o.Oco + "|" + (buy ? "b" : "s");
                    GroupHolding was;
                    if (!ocoFlat.TryGetValue(k, out was) || left > was.Qty)
                        ocoFlat[k] = new GroupHolding { Account = a.Name, Root = MasterName(o.Instrument), What = "entry", Side = buy ? 1 : -1, Qty = left, Kind = GroupKindWord(o.OrderType) };
                    continue;
                }
                int e = l + mv, held = l > 0 && e > 0 ? Math.Min(l, e) : l < 0 && e < 0 ? -Math.Min(-l, -e) : 0;
                int entryQty = left;
                if (held != 0 && (buy ? held < 0 : held > 0))
                {
                    int room;
                    if (!exitLeft.TryGetValue(full, out room)) room = Math.Abs(held);
                    int asExit = Math.Min(room, left);
                    exitLeft[full] = room - asExit;
                    entryQty = left - asExit;   // the part past the position would open the other side
                }
                if (entryQty <= 0) continue;
                list.Add(new GroupHolding { Account = a.Name, Root = MasterName(o.Instrument), What = "entry", Side = buy ? 1 : -1, Qty = entryQty, Kind = GroupKindWord(o.OrderType) });
            }
            list.AddRange(ocoFlat.Values);
            return list;
        }

        // ---------------------------------------------------------- 0.6.5: trade the group from the ticket (Anthony 2026-10-19)
        // The ticket may pick a group in place of one account: one entry with its bracket stop goes to every member, each member sized
        // from the group's risk percent of its own max loss (its drawdown amount). No leader, no follower: the copier is untouched.
        // groupPreview answers each member's size, dollar risk and budget, or why it sits out; groupOrder carries the sizes Anthony saw
        // and confirmed: ChartBridge works them out again and refuses the whole entry if any changed (nothing is ever placed at a size
        // he did not see), then places each member's entry through PlaceOrder (every gate, the one-direction check, its own legs).
        public sealed class GroupSeat { public string Account, Out, Note; public int Size; public double Risk, Budget; }   // 0.6.6: Note, a member sized with a room unknown
        // micro contracts (10 to a mini equivalent in the max size, review 3); every other root is a mini
        public static readonly HashSet<string> MicroRoots = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "MNQ", "MES", "M2K", "MYM", "MGC", "MCL", "SIL", "MBT", "MET", "M6E" };
        private static string Usd(double v) { return "$" + v.ToString("#,0.##", CultureInfo.InvariantCulture); }

        // One member's contracts (pure, for the harness): floor(budget / (stopTicks x tickValue)), budget = riskPct of its drawdown;
        // never above maxLeft (its firm max less what it holds and has working, FirmMaxFor's combined rule; -1 none) nor the
        // maxQty cap less what it holds and has working on that side of this root; capped so ALL its open stop risk (openRisk: every
        // position at its working stops and every working entry at its own stop) plus this entry's stop fits its room to its floor and
        // (with a daily loss rule) its daily room. 0 always says why.
        // 0.6.6 (Anthony's ruling on the review: "size it anyway"): a room NOT known no longer sits the member out: that room's cap is
        // skipped and note says so ("room unknown: sized by risk only"); the open stop risk not known counts as 0 against a room that
        // IS known (its own stop still caps it there) and note says so. No confirm for that reason.
        public static int GroupSize(double riskPct, double drawdown, int stopTicks, double tickValue, int maxLeft, string maxWords, int cap, string capWords, int held,
                                    double? roomFloor, string floorWhy, bool hasDaily, double? roomDaily, string dailyWhy, double? openRisk, string openWhy, out double budget, out string why)
        {
            string note;
            return GroupSize(riskPct, drawdown, stopTicks, tickValue, maxLeft, maxWords, cap, capWords, held, roomFloor, floorWhy, hasDaily, roomDaily, dailyWhy, openRisk, openWhy, out budget, out why, out note);
        }
        public static int GroupSize(double riskPct, double drawdown, int stopTicks, double tickValue, int maxLeft, string maxWords, int cap, string capWords, int held,
                                    double? roomFloor, string floorWhy, bool hasDaily, double? roomDaily, string dailyWhy, double? openRisk, string openWhy, out double budget, out string why, out string note)
        {
            why = null; note = null;
            budget = Math.Round(riskPct * drawdown) / 100;
            double per = stopTicks * tickValue;
            bool floorKnown = roomFloor.HasValue, dailyKnown = !hasDaily || roomDaily.HasValue;
            if (!floorKnown || !dailyKnown) note = "room unknown: sized by risk only (" + (!floorKnown ? "its room to the floor: " + (floorWhy ?? "not known") : "its daily room: " + (dailyWhy ?? "not known")) + ")";
            else if (!openRisk.HasValue) note = "open stop risk unknown: its room caps this entry's own stop only (" + (openWhy ?? "not known") + ")";
            double open = openRisk.HasValue ? Math.Round(openRisk.Value * 100) / 100 : 0;
            string less = open > 0 ? " less its open stop risk " + Usd(open) : "";
            int n = (int)Math.Floor(budget / per + 1e-9);
            if (n < 1) { why = "its risk " + Usd(budget) + " (" + riskPct.ToString("0.##", CultureInfo.InvariantCulture) + "% of its max loss " + Usd(drawdown) + ") is less than one contract's stop (" + Usd(per) + " at " + stopTicks + " ticks)"; note = null; return 0; }
            held = Math.Max(0, held);
            if (maxLeft >= 0 && maxLeft < n) { n = maxLeft; if (n < 1) { why = "it is at its max size (" + maxWords + ")"; note = null; return 0; } }
            if (cap - held < n) { n = cap - held; if (n < 1) { why = "it is at the cap of " + cap + " (" + capWords + "; it holds or has working " + held + ")"; note = null; return 0; } }
            if (floorKnown)
            {
                int byFloor = (int)Math.Floor((roomFloor.Value - open) / per + 1e-9);
                if (byFloor < n) { n = byFloor; if (n < 1) { why = "its room to the floor " + Usd(roomFloor.Value) + less + " is less than one contract's stop (" + Usd(per) + ")"; note = null; return 0; } }
            }
            if (hasDaily && roomDaily.HasValue)
            {
                int byDay = (int)Math.Floor((roomDaily.Value - open) / per + 1e-9);
                if (byDay < n) { n = byDay; if (n < 1) { why = "its daily room " + Usd(roomDaily.Value) + less + " is less than one contract's stop (" + Usd(per) + ")"; note = null; return 0; } }
            }
            return n;
        }

        // Review 3: the mini equivalents of a root (10 micros = 1 mini).
        public static double MiniEquivalent(string root) { return MicroRoots.Contains(root ?? "") ? 0.1 : 1; }
        // 0.6.6 (Anthony 2026-10-20, his ruling on the review: "10 micros = 1 mini"): the firm's max contracts, the one limit that holds
        // every entry (his own, a group's and the machines'), one combined rule whatever the entry's instrument, so the order of the
        // trades never changes the answer: after the order, the account's total in mini equivalents (minis + micros / 10, held and
        // working, every instrument: usedMini, OpenStopRisk's count) is at most maxMinis when it is set, and its total in micro
        // equivalents (minis x 10 + micros) at most maxMicros when it is set. Both set: both hold (the tighter decides).
        // Unit: the cap that decides ("minis" or "micros"); Cap, Used (in that unit), Per: one contract of the root in that unit; Left:
        // the root's contracts still allowed (0 or more). Null when the rules set no max. A tie names the root's own kind.
        public sealed class FirmMax { public string Unit; public double Cap, Used, Per; public int Left; }
        public static FirmMax FirmMaxFor(ChartBridgeGroups.Rules r, string root, double usedMini)
        {
            if (r == null || (r.MaxMinis <= 0 && r.MaxMicros <= 0)) return null;
            bool micro = MicroRoots.Contains(root ?? "");
            FirmMax best = null;
            foreach (bool inMicros in micro ? new[] { true, false } : new[] { false, true })
            {
                int cap = inMicros ? r.MaxMicros : r.MaxMinis;
                if (cap <= 0) continue;
                double k = inMicros ? 10 : 1;
                FirmMax m = new FirmMax { Unit = inMicros ? "micros" : "minis", Cap = cap, Used = Math.Round(Math.Max(0, usedMini) * k, 6), Per = MiniEquivalent(root) * k };
                m.Left = Math.Max(0, (int)Math.Floor((m.Cap - m.Used) / m.Per + 1e-6));
                if (best == null || m.Left < best.Left) best = m;
            }
            return best;
        }
        private static string Qty(double v) { return v.ToString("0.#", CultureInfo.InvariantCulture); }

        // Answer 4 and review 1 and 5: what an account holds and has working, every instrument, both sides. risk: the loss if every
        // position is stopped at its working stops (each contract month from its own last price; the farthest stops first, up to the
        // position; 0 for a stop past the price in profit) plus every working entry (resting, or a market one not yet filled) at its own
        // stop (its bracket's, its planned or its strategy's ticks from its price) times its contracts. Null with why when a contract held
        // has no working stop, a contract month's price is not known, or an entry's stop is not known. usedMini: positions and working
        // entries, every instrument, in mini equivalents (review 3).
        internal static double? OpenStopRisk(Account a, out string why, out double usedMini)
        {
            why = null; usedMini = 0;
            double total = 0;
            List<Position> ps;
            lock (a.Positions) ps = a.Positions.ToList();
            List<Order> orders;
            lock (a.Orders) orders = a.Orders.ToList();
            lock (Sync) foreach (Order o in Ours) if (o.Account == a && !orders.Contains(o)) orders.Add(o);
            List<Instrument> insts = new List<Instrument>();
            foreach (Instrument i in ps.Where(p => p != null && p.Instrument != null && p.Quantity != 0 && p.MarketPosition != MarketPosition.Flat).Select(p => p.Instrument)
                     .Concat(orders.Where(o => o != null && o.Instrument != null && MayFill(o.OrderState)).Select(o => o.Instrument)))
                if (!insts.Any(x => SameInstrument(x, i))) insts.Add(i);
            string unknown = null;
            foreach (Instrument inst in insts)
            {
                if (inst.MasterInstrument == null) continue;
                int pn = SignedPosition(a, inst), pe = EffectivePosition(a, inst);
                string root = MasterName(inst);
                double pv = inst.MasterInstrument.PointValue, tick = inst.MasterInstrument.TickSize;
                int heldL = Math.Max(Math.Max(pn, pe), 0), heldS = Math.Max(Math.Max(-pn, -pe), 0);
                usedMini += (heldL + heldS) * MiniEquivalent(root);
                List<Order> on = orders.Where(o => o != null && MayFill(o.OrderState) && SameInstrument(o.Instrument, inst)).ToList();
                foreach (int dir in new[] { 1, -1 })
                {
                    int held = dir > 0 ? heldL : heldS;
                    if (held == 0) continue;
                    Instrument served = ChartBridgeServer.InstrumentFor(root);
                    double last;
                    if (served == null || !SameInstrument(served, inst) || LastPrice(root, out last) != null) { unknown = unknown ?? "no recent price for " + (inst.FullName ?? root) + " to measure its stops from"; continue; }
                    List<double[]> stops = on.Where(o => IsBuy(o) == (dir < 0) && (o.OrderType == OrderType.StopMarket || o.OrderType == OrderType.StopLimit))
                        .Select(o => new[] { Math.Max(0, (last - o.StopPrice) * dir), (double)Math.Max(0, o.Quantity - o.Filled) }).Where(x => x[1] > 0).OrderByDescending(x => x[0]).ToList();
                    int left = held;
                    foreach (double[] st in stops) { if (left <= 0) break; int q = Math.Min(left, (int)st[1]); total += q * st[0] * pv; left -= q; }
                    if (left > 0) unknown = unknown ?? "it holds " + held + " " + root + " with no working stop for " + left + " of them";
                }
                // the working entries: ChartBridge's legs, merged legs and an agent's flat or protect are never entries; an order on the
                // closing side of a position counts as its exit up to the position (its stop risk is the position's, above)
                int exitLeftBuy = heldS, exitLeftSell = heldL;
                List<Order> cand = on.Where(o => { string nm = o.Name ?? ""; return !GroupNotEntryRx.IsMatch(nm) && !AgentMarketRx.IsMatch(nm) && !IsMergedLeg(o) && Math.Max(0, o.Quantity - o.Filled) > 0; }).ToList();
                // re-review 1: an OCO set on the CLOSING side of a position (an ATM's or a typed stop and target) is one exit, up to the
                // position: each set takes the exit allowance once, at its largest; any OCO order on the adding side counts as an entry
                Dictionary<Order, int> rests = cand.ToDictionary(o => o, o => Math.Max(0, o.Quantity - o.Filled));
                foreach (IGrouping<string, Order> set in cand.Where(o => !string.IsNullOrEmpty(o.Oco) && (IsBuy(o) ? heldS : heldL) > 0).GroupBy(o => (IsBuy(o) ? "b|" : "s|") + o.Oco))
                {
                    bool sb = set.Key[0] == 'b';
                    int big = set.Max(o => rests[o]), x = Math.Min(sb ? exitLeftBuy : exitLeftSell, big);
                    if (sb) exitLeftBuy -= x; else exitLeftSell -= x;
                    foreach (Order o in set) rests[o] = Math.Max(0, rests[o] - x);
                }
                foreach (Order o in cand)
                {
                    int rest = rests[o];
                    if (rest == 0) continue;
                    bool buy = IsBuy(o);
                    if (string.IsNullOrEmpty(o.Oco))
                    {
                        if (buy) { int x = Math.Min(exitLeftBuy, rest); exitLeftBuy -= x; rest -= x; }
                        else { int x = Math.Min(exitLeftSell, rest); exitLeftSell -= x; rest -= x; }
                    }
                    if (rest == 0) continue;
                    usedMini += rest * MiniEquivalent(root);
                    Bracket br;
                    lock (Sync) BracketOfEntry.TryGetValue(o, out br);
                    int ticks = br == null ? 0 : br.RiskTicks > 0 ? br.RiskTicks : br.StopTicks;
                    if (ticks < 1) { unknown = unknown ?? "a working " + (buy ? "buy " : "sell ") + GroupKindWord(o.OrderType) + " " + rest + " " + root + " has no stop ChartBridge knows"; continue; }
                    total += rest * ticks * tick * pv;
                }
            }
            if (unknown != null) { why = unknown; return null; }
            return total;
        }

        // ---------------------------------------------------------- 0.6.6: the firm's limits on entries (Anthony 2026-10-20)
        // "Only absolutely critical things should stop an account from trading." Anthony is the final arbiter on his own orders.
        //   - His own entries (the page: one account, or each member of a group entry) have ONE check: the firm's max contracts, a
        //     fixed number typed in the account's rules (never stale). No max set: no check. No floor, daily room or no-stop check.
        //   - The entries no one types (the bot, an agent, a copier follower) are held back only on a KNOWN breach: the max
        //     contracts; this entry's stop risk plus the open stop risk past a known room to the floor or a known daily room (the
        //     group sizing's arithmetic); or the account's daily loss already reached today (no new entry for the rest of that
        //     trading day). A room or a risk not known lets the entry go. Each hold sends one riskAlert.
        // Only the part of an order that opens or adds is checked (opening); an exit never is, and nothing here flattens anything.

        // Anthony's own entry: the firm's max contracts, or null. opening: the contracts it opens or adds; closing: the position it
        // closes first (an order past flat), which no longer counts.
        internal static string FirmMaxWhy(Account a, string root, int opening, int closing)
        {
            if (a == null || opening < 1) return null;
            ChartBridgeGroups.Rules r = ChartBridgeGroups.RulesOf(a.Name);
            if (r == null || (r.MaxMinis <= 0 && r.MaxMicros <= 0)) return null;   // no max typed: no check
            string ignored;
            double used;
            OpenStopRisk(a, out ignored, out used);
            used = Math.Max(0, used - Math.Max(0, closing) * MiniEquivalent(root));
            FirmMax m = FirmMaxFor(r, root, used);
            if (m == null || opening <= m.Left) return null;
            return "over " + a.Name + "'s max of " + Qty(m.Cap) + " " + m.Unit + ": this entry of " + opening + " " + root + " would take it to " + Qty(m.Used + opening * m.Per) + " " + m.Unit +
                   " (it holds or has working " + Qty(m.Used) + ", every instrument). Nothing was sent" + (m.Left > 0 ? "; " + m.Left + " " + root + " at most" : "");
        }

        // The bot's, an agent's or a copier follower's entry (who: "the bot", "agent X", "the copier"): held back only on a known breach,
        // with one riskAlert (kind "held", or "skipped" for a follower). entryRisk: this entry's stop risk in dollars (null: not known).
        internal static string MachineHold(string who, string kind, Account a, string root, int opening, int closing, double? entryRisk)
        {
            if (a == null || opening < 1) return null;
            string why = MachineHoldWhy(a, root, opening, closing, entryRisk);
            if (why == null) return null;
            string text = (kind == "skipped" ? "Copier: " + a.Name + " skipped this copy: " : "Held: " + who + "'s entry on " + a.Name + ": ") + why;
            ChartBridgeGroups.RiskAlert(kind, a.Name, text);
            return why;
        }

        internal static string MachineHoldWhy(Account a, string root, int opening, int closing, double? entryRisk)
        {
            string max = FirmMaxWhy(a, root, opening, closing);
            if (max != null) return max;
            ChartBridgeGroups.Numbers n;
            try { n = ChartBridgeGroups.Read(a.Name, a, false); }
            catch (Exception ex) { ChartBridgeServer.Log("limits: the numbers of " + a.Name + " could not be read (" + ex.Message + "): not known, the entry goes"); return null; }
            if (ChartBridgeGroups.DailyReached(n))
                return a.Name + " reached its daily loss today: no new entry from the bot, an agent or the copier until the next trading day (18:00 ET)";
            if (!entryRisk.HasValue || !n.Balance.HasValue || n.Balance.Value <= 0) return null;   // a balance of 0: NinjaTrader has not given one yet, so no room is known
            string ignored;
            double used;
            double? open = OpenStopRisk(a, out ignored, out used);
            // the review: the open stop risk not known (never below 0) still holds an entry whose own stop risk alone is past a known room
            double openKnown = open.HasValue ? open.Value : 0;
            double total = Math.Round((openKnown + entryRisk.Value) * 100) / 100;
            string words = "its stop risk " + Usd(entryRisk.Value) + (openKnown > 0.004 ? " plus the open stop risk " + Usd(Math.Round(openKnown * 100) / 100) : !open.HasValue ? " alone (the open stop risk not known)" : "");
            if (n.RoomFloor.HasValue && total > n.RoomFloor.Value + 0.004) return words + " is more than " + a.Name + "'s room to the floor " + Usd(n.RoomFloor.Value);
            if (n.RoomDaily.HasValue && total > n.RoomDaily.Value + 0.004) return words + " is more than " + a.Name + "'s daily room " + Usd(n.RoomDaily.Value);
            return null;
        }

        // Review 1b: one group entry at a time, from its sizing to its last member's order; every page entry takes it too (PlaceOrder)
        internal static readonly object GroupEntryLock = new object();

        // Every member's size for one entry, in seat order (by name); null with err when the entry cannot go to the group at all.
        internal static List<GroupSeat> GroupPlan(string gid, string root, bool isBuy, int stopTicks, out string groupName, out double riskPct, out string err)
        {
            groupName = null; riskPct = 0; err = null;
            ChartBridgeGroups.RiskGroup g = ChartBridgeGroups.RiskGroupOf(gid, out err);
            if (g == null) return null;
            groupName = g.Name; riskPct = g.RiskPct;
            if (g.RiskPct <= 0) { err = "group " + g.Name + " has no risk percent: set Risk % of max loss in Settings, Account groups"; return null; }
            if (stopTicks < 1) { err = "a group entry needs a stop: each member is sized from its stop loss (set the bracket's stop)"; return null; }
            if (g.Members.Count == 0) { err = "group " + g.Name + " has no accounts"; return null; }
            Instrument inst = ChartBridgeServer.InstrumentFor(root);
            if (inst == null || inst.MasterInstrument == null) { err = "instrument " + root + " is not served by ChartBridge"; return null; }
            double tickValue = inst.MasterInstrument.TickSize * inst.MasterInstrument.PointValue;
            bool micro = MicroRoots.Contains(root);
            List<GroupSeat> seats = new List<GroupSeat>();
            foreach (string name in g.Members)
            {
                GroupSeat s = new GroupSeat { Account = name };
                seats.Add(s);
                // 0.6.7 (Anthony 2026-10-22): a member on the bench stays a member and sits out every new entry
                if (g.Benched.Contains(name)) { s.Out = BenchedOut; continue; }
                Account a = null;
                lock (Account.All) foreach (Account x in Account.All) if (x.Name != null && x.Name.Equals(name, StringComparison.OrdinalIgnoreCase)) { a = x; break; }
                string taken = GroupTakenWhy(name);
                if (taken != null) { s.Out = taken; continue; }
                if (a == null) { s.Out = "it is not in NinjaTrader now"; continue; }
                if (a.Connection == null || a.Connection.Status != ConnectionStatus.Connected) { s.Out = "it is not connected"; continue; }   // 0.6.6: no longer caught by its room not known
                ChartBridgeGroups.Numbers n = ChartBridgeGroups.Read(name, a, false);
                if (n.GroupId != g.Id) { s.Out = "it is not in group " + g.Name + " now"; continue; }
                // 0.6.7 (Anthony 2026-10-22: the group's fallback rules dropped): sized only from its own rules (its type on The Desk)
                if (n.R == null || !n.R.Own) { s.Out = NoTypeOut; continue; }
                int posNow = SignedPosition(a, inst), posEff = EffectivePosition(a, inst), pb, ps;
                PendingOrders(a, inst, out pb, out ps);
                int pos = isBuy ? Math.Max(posNow, posEff) : Math.Min(posNow, posEff), held = isBuy ? pos + pb : -pos + ps;
                string floorWhy, dailyWhy, openWhy, why;
                n.Why.TryGetValue("roomFloor", out floorWhy); n.Why.TryGetValue("roomDaily", out dailyWhy);
                double usedMini, budget;
                double? openRisk = OpenStopRisk(a, out openWhy, out usedMini);
                FirmMax fm = FirmMaxFor(n.R, root, usedMini);   // 0.6.6: the combined rule (10 micros = 1 mini), both caps
                int maxLeft = fm == null ? -1 : fm.Left;
                string maxWords = fm == null ? "" : (n.R.MaxMinis > 0 && n.R.MaxMicros > 0 ? n.R.MaxMinis + " minis / " + n.R.MaxMicros + " micros" : n.R.MaxMinis > 0 ? n.R.MaxMinis + " minis" : n.R.MaxMicros + " micros") + "; it holds or has working " + usedMini.ToString("0.#", CultureInfo.InvariantCulture) + " in mini equivalents, every instrument";
                string note;
                s.Size = GroupSize(riskPct, n.R.Drawdown, stopTicks, tickValue, maxLeft, maxWords, CapFor(root), "maxQty." + root + " in config.txt", held,
                                   n.RoomFloor, floorWhy, n.R.DailyLoss > 0, n.RoomDaily, dailyWhy, openRisk, openWhy, out budget, out why, out note);
                s.Budget = budget; s.Out = why; s.Note = s.Size > 0 ? note : null; s.Risk = Math.Round(s.Size * stopTicks * tickValue * 100) / 100;
            }
            return seats;
        }

        // 0.6.7: why a member sits out a group entry: on the bench; with no rules of its own (no type on The Desk)
        public const string BenchedOut = "benched: it sits out new entries (the Multi-Account panel)";
        public const string NoTypeOut = "it has no account type: set its type on The Desk and apply it (its Rules on the Accounts tab)";

        // never an account another lane trades (as a group trading seat): the copier's leader or a follower, the bot's, an agent's; review 4:
        // the page leaves the same accounts out of the group's Close, Flatten all, Cancel all, B/E and lines (the groups message's tradeOut)
        internal static string GroupTakenWhy(string name)
        {
            string taken = ChartBridgeAgents.CopierUses(name) ?? ChartBridgeAgents.AccountTakenWhy(name, "a group entry");
            string bot = ChartBridgeAgents.BotAccountForAgents();
            if (taken == null && bot != null && string.Equals(bot, name, StringComparison.OrdinalIgnoreCase)) taken = name + " is the bot's account";
            return taken;
        }

        // review 2: the sizes confirmed, each with its account ("SIM-A:4,SIM-B:0"), in seat order
        private static readonly Regex SizesRx = new Regex("^[^,:\"]{1,200}:(?:0|[1-9][0-9]{0,3})(?:,[^,:\"]{1,200}:(?:0|[1-9][0-9]{0,3})){0,99}$");
        private static string SeatsJson(List<GroupSeat> seats)
        {
            return "[" + string.Join(",", seats.Select(s => "{\"account\":" + CbJson.Str(s.Account) + ",\"size\":" + s.Size.ToString(CultureInfo.InvariantCulture) + ",\"risk\":" + CbJson.Num(s.Risk) +
                ",\"budget\":" + CbJson.Num(s.Budget) + ",\"out\":" + (s.Out == null ? "null" : CbJson.Str(s.Out)) + (s.Note != null ? ",\"note\":" + CbJson.Str(s.Note) : "") + "}")) + "]";
        }

        // groupPreview and groupOrder (the order connection's gates have passed in OnMessage).
        private static string GroupEntry(ChartBridgeClient client, string type, string top, string bracketBody, string cid, string strategyBody)
        {
            string gid = Str(top, "group"), root = (Str(top, "root") ?? "").ToUpperInvariant(), side = Str(top, "side"), kind = Str(top, "kind");
            if (gid == null) return type + " needs group (a group id)";
            if (side != "buy" && side != "sell") return "side must be buy or sell";
            if (kind != "market" && kind != "limit" && kind != "stop" && !(OrderTypesOn && NewKind(kind))) return "kind must be market, limit or stop";
            int stopTicks = 0, targetTicks = 0;
            if (strategyBody != null)
            {
                // Anthony 2026-10-19 (answer 2): an Order Strategy may go with a group entry: its stop distance sizes each member; its
                // targets, breakeven and trailing run on every member's own entry as on one account
                string off = StrategiesRunRefusal();
                if (off != null) return off;
                StratParams sp;
                string bad = ParseStrategy(strategyBody, out sp);
                if (bad != null) return bad;
                stopTicks = sp.Stop + Math.Max(0, sp.StopLimit);   // review 6: a stop-limit's ticks beyond the stop are risk too
            }
            else
            {
                if (bracketBody == null) return "a group entry needs a stop: each member is sized from its stop loss (set the bracket's stop)";
                if (Int("{" + bracketBody + "}", "stop", out stopTicks) != 1 || Int("{" + bracketBody + "}", "target", out targetTicks) != 1 || stopTicks < 0 || targetTicks < 0)
                    return "bracket needs both stop and target as whole numbers of ticks (0 for none)";
                if (MaxBracketTicks > 0 && (stopTicks > MaxBracketTicks || targetTicks > MaxBracketTicks))   // review 7: never a size PlaceOrder would refuse
                    return "bracket ticks must be from 0 to " + MaxBracketTicks + " (maxBracketTicks in config.txt)";
            }
            string answer, why;
            if (type == "groupOrder") { lock (GroupEntryLock) why = GroupPlaceLocked(top, bracketBody, cid, strategyBody, gid, root, side, kind, stopTicks, false, out answer); }
            else why = GroupPlaceLocked(top, bracketBody, cid, strategyBody, gid, root, side, kind, stopTicks, true, out answer);
            if (answer != null) client.Send(answer);   // re-review 3: sent once the lock is let go
            return why;
        }

        // review 1b: a groupOrder runs whole under GroupEntryLock (its sizing again, the check, every member's order); a preview never places
        private static string GroupPlaceLocked(string top, string bracketBody, string cid, string strategyBody, string gid, string root, string side, string kind, int stopTicks, bool preview, out string answer)
        {
            answer = null;
            string type = preview ? "groupPreview" : "groupOrder";
            string name, err;
            double risk;
            List<GroupSeat> seats = GroupPlan(gid, root, side == "buy", stopTicks, out name, out risk, out err);
            if (seats == null) return err;
            string head = "\"cid\":" + (cid == null ? "null" : CbJson.Str(cid)) + ",\"group\":" + CbJson.Str(gid) + ",\"name\":" + CbJson.Str(name) + ",\"root\":" + CbJson.Str(root) + ",\"side\":" + CbJson.Str(side) +
                          ",\"kind\":" + CbJson.Str(kind) + ",\"stopTicks\":" + stopTicks.ToString(CultureInfo.InvariantCulture) + ",\"riskPct\":" + CbJson.Num(risk);
            if (type == "groupPreview") { answer = "{\"type\":\"groupPreview\"," + head + ",\"members\":" + SeatsJson(seats) + "}"; return null; }
            string sizes = Str(top, "sizes");
            if (sizes == null || !SizesRx.IsMatch(sizes)) return "sizes must be the sizes confirmed with their accounts, in seat order (\"SIM-A:4,SIM-B:0\")";
            string[][] want = sizes.Split(',').Select(x => x.Split(':')).ToArray();
            if (want.Length != seats.Count || want.Where((w, i) => !string.Equals(w[0], seats[i].Account, StringComparison.OrdinalIgnoreCase)).Any())
                return "the group's accounts changed since the preview (" + string.Join(", ", seats.Select(x => x.Account)) + " now, " + string.Join(", ", want.Select(w => w[0])) + " confirmed): nothing was sent; look again and send";
            List<string> changed = new List<string>();
            for (int i = 0; i < seats.Count; i++) if (want[i][1] != seats[i].Size.ToString(CultureInfo.InvariantCulture)) changed.Add(seats[i].Account + " " + want[i][1] + " confirmed, " + seats[i].Size + " now");
            if (changed.Count > 0) return "the sizes changed since the preview (" + string.Join("; ", changed) + "): nothing was sent; look again and send";
            if (seats.All(s => s.Size < 1)) return "no account of group " + name + " can take this entry: " + string.Join("; ", seats.Select(s => s.Account + ": " + s.Out));
            string price = Has(top, "price") ? Regex.Match(top, "\"price\"\\s*:\\s*([0-9.]+)").Groups[1].Value : null;
            string lo = Has(top, "limitOffset") ? Regex.Match(top, "\"limitOffset\"\\s*:\\s*(-?[0-9.]+)").Groups[1].Value : null;
            for (int i = 0; i < seats.Count; i++)
            {
                GroupSeat s = seats[i];
                if (s.Size < 1) continue;
                string one = "{\"type\":\"order\",\"account\":" + CbJson.Str(s.Account) + ",\"root\":" + CbJson.Str(root) + ",\"side\":" + CbJson.Str(side) + ",\"kind\":" + CbJson.Str(kind) +
                             ",\"qty\":" + s.Size.ToString(CultureInfo.InvariantCulture) + (price != null ? ",\"price\":" + price : "") + (lo != null ? ",\"limitOffset\":" + lo : "") + "}";
                string why;
                try { why = MergeFreezeWhy("order", one, null) ?? PlaceOrder(one, bracketBody, cid != null ? cid + ":" + (i + 1) : null, strategyBody); }
                catch (Exception ex) { why = "ChartBridge error: " + ex.Message; }
                if (why != null) { s.Out = "refused: " + why; s.Size = 0; s.Risk = 0; }
            }
            int placed = seats.Count(s => s.Size > 0);
            ChartBridgeServer.Log("group entry on " + name + ": " + side + " " + root + " " + kind + (strategyBody != null ? " with a strategy" : "") + ", stop " + stopTicks + " ticks, risk " + risk.ToString("0.##", CultureInfo.InvariantCulture) + "%: " +
                string.Join("; ", seats.Select(s => s.Account + " " + (s.Size > 0 ? s.Size + " (" + Usd(s.Risk) + ")" : "out: " + s.Out))));
            answer = "{\"type\":\"groupPlaced\"," + head + ",\"placed\":" + placed.ToString(CultureInfo.InvariantCulture) + ",\"members\":" + SeatsJson(seats) + "}";
            return null;
        }

        private static string GroupKindWord(OrderType t)
        {
            return t == OrderType.Limit ? "limit" : t == OrderType.StopMarket ? "stop" : t == OrderType.StopLimit ? "stop limit" : t == OrderType.MIT ? "MIT" : "market";
        }

        // The order is on the other side of the account's position on this contract by both readings (an exit, or an exit too big).
        // Q-EXIT (b): the working orders that may be an exit left behind: working, no OCO id (an ATM's are the ATM's), not ChartBridge's
        // own legs (CheckLegs keeps those), on any instrument; with each, both readings of that account's position on its contract.
        internal sealed class GroupLeftCandidate { public Order O; public int Listed, Effective; }
        internal static List<GroupLeftCandidate> GroupLeftCandidates(Account a)
        {
            List<GroupLeftCandidate> list = new List<GroupLeftCandidate>();
            List<Order> orders;
            lock (a.Orders) orders = a.Orders.ToList();
            foreach (Order o in orders)
            {
                if (o == null || o.Instrument == null || !IsWorking(o.OrderState)) continue;   // OCO orders too (re-review 2: a typed OCO pair); an ATM's on a flat account are harmless to cancel
                string name = o.Name ?? "";
                if (GroupNotEntryRx.IsMatch(name) || AgentMarketRx.IsMatch(name) || IsMergedLeg(o)) continue;
                list.Add(new GroupLeftCandidate { O = o, Listed = SignedPosition(a, o.Instrument), Effective = EffectivePosition(a, o.Instrument) });
            }
            return list;
        }
        internal static bool GroupIsBuy(Order o) { return IsBuy(o); }
        // 0.6.7 (the bench): every order of the account that may still fill (NinjaTrader's list and ChartBridge's own just sent), its
        // legs, stops and targets included; and a fill on its way (moved, not yet in NinjaTrader's positions)
        internal static int GroupWorkingCount(Account a)
        {
            List<Order> orders;
            lock (a.Orders) orders = a.Orders.ToList();
            lock (Sync) foreach (Order o in Ours) if (o.Account == a && !orders.Contains(o)) orders.Add(o);
            return orders.Count(o => o != null && MayFill(o.OrderState));
        }
        internal static bool GroupMovesPending(Account a)
        {
            double now = ChartBridgeTime.NowUtcMs();
            string prefix = (a.Name ?? "") + "|";
            lock (Moves) return Moves.Any(kv => kv.Key.StartsWith(prefix, StringComparison.Ordinal) && (int)kv.Value.Where(x => now - x[1] <= MoveTtlMs).Sum(x => x[0]) != 0);
        }
        // the position on this contract both readings agree it is at least (0 when they differ in side)
        internal static int GroupHeld(Account a, Instrument inst) { int pn = SignedPosition(a, inst), pe = EffectivePosition(a, inst); return pn > 0 && pe > 0 ? Math.Min(pn, pe) : pn < 0 && pe < 0 ? Math.Min(-pn, -pe) : 0; }

        internal static bool GroupOpposite(Account a, Instrument inst, bool isBuy)
        {
            int pn = SignedPosition(a, inst), pe = EffectivePosition(a, inst);
            return isBuy ? pn < 0 && pe < 0 : pn > 0 && pe > 0;
        }

        // The account's own new order is an exit of its position on this contract: the other side by both readings, and its
        // contracts plus the exits already working on that side (orders that are no bracket leg) at most the position.
        internal static bool GroupExitOf(Account a, Instrument inst, bool isBuy, int qty)
        {
            if (a == null || inst == null || qty < 1) return false;
            int pn = SignedPosition(a, inst), pe = EffectivePosition(a, inst);
            int held = isBuy ? (pn < 0 && pe < 0 ? Math.Min(-pn, -pe) : 0) : (pn > 0 && pe > 0 ? Math.Min(pn, pe) : 0);
            if (held <= 0) return false;
            return (long)GroupExitsWorking(a, inst, isBuy) + qty <= held;
        }

        // Re-review of #48: the exits already working on that side, for the exit rule: only plain MARKET or LIMIT orders with no OCO
        // id that are not ChartBridge's own legs (a working sell market, a typed sell limit). Never a protective order: ChartBridge's
        // stops and targets (a lone stop has no OCO id), the agent's and the copier's legs, merged legs, or any stop, stop-limit or
        // MIT and any OCO order typed into NinjaTrader (an ATM's stop and target): those shrink with the position (the legs check,
        // CheckLegs; the copier's TrimStops) and must never make a true exit look too big.
        internal static int GroupExitsWorking(Account a, Instrument inst, bool isBuy)
        {
            List<Order> orders;
            lock (a.Orders) orders = a.Orders.ToList();
            lock (Sync) foreach (Order o in Ours) if (o.Account == a && !orders.Contains(o)) orders.Add(o);
            int n = 0;
            foreach (Order o in orders)
            {
                if (o == null || !MayFill(o.OrderState) || !SameInstrument(o.Instrument, inst) || IsBuy(o) != isBuy) continue;
                if (o.OrderType != OrderType.Market && o.OrderType != OrderType.Limit) continue;
                string name = o.Name ?? "";
                if (!string.IsNullOrEmpty(o.Oco) || GroupNotEntryRx.IsMatch(name) || AgentMarketRx.IsMatch(name) || IsMergedLeg(o)) continue;
                n += Math.Max(0, o.Quantity - o.Filled);
            }
            return n;
        }
    }

    // ---------------------------------------------------------------- the groups, the check and the account numbers
    public static class ChartBridgeGroups
    {
        public const string Header = "# ChartBridge account groups (written by ChartBridge; do not edit)";
        public const string Header2 = "# group<TAB>id<TAB>name<TAB>on|off<TAB>dailyLoss|-<TAB>drawdown|-<TAB>eod|intraday|static|-<TAB>target|-<TAB>size|-<TAB>lockAt|-<TAB>consistency|-<TAB>eval|funded|-<TAB>hero|-<TAB>riskPct|-, member<TAB>account<TAB>id[<TAB>benched], rules<TAB>account<TAB>size<TAB>dailyLoss|-<TAB>drawdown<TAB>eod|intraday|static<TAB>lockAt|-<TAB>target|-<TAB>consistency|-<TAB>maxMinis|-<TAB>maxMicros|-<TAB>typeId|-, personal<TAB>account<TAB>floor|-<TAB>daily|-";
        public const string MarksHeader = "# ChartBridge account marks (written by ChartBridge; do not edit)";
        public const string MarksHeader2 = "# mark<TAB>account<TAB>peakEod|-<TAB>peakIntraday|-<TAB>dayStartBalance|-<TAB>session<TAB>dayStartAt (UTC ms)|-<TAB>closeSeen|-<TAB>lastBalance|-<TAB>flat|open|-<TAB>eodMissed|-<TAB>intradayMissed|-";
        public static double GapMs = 10000;   // 0.6.3 (audit C2): no reading of a connected account for this long is a gap ChartBridge did not watch
        // 0.6.6 (Anthony's ruling on the review, "My single orders go"): his own single-account entries still go; group entries are refused.
        // Anthony's ruling of 2026-10-21: the bot, the agents and the copier are NOT blocked: they run on the last groups that read cleanly
        // (groups.txt.bak, or the copy a cut-off save left beside a missing groups.txt). With no clean copy at all there is nothing to run
        // on, so their entries wait. Either way the page shows the banner with a sound, never a dialog. ReadFailedNow() says which.
        public const string ReadFailedText = "groups.txt could not be read: group entries are refused until it can (your own single-account orders and every exit still go)";
        public const string MachinesWaitText = "; no copy of the groups read cleanly, so the bot's, the agents' and the copier's entries wait until it can";
        public const double MaxMoney = 100000000;
        public static double MarksWriteMs = 5000;  // account-marks.txt at most every 5 s while something changed (the harness sets 0)
        public const int NameMax = 30;

        private static string FilePath { get { return Path.Combine(ChartBridgeConfig.Folder, "groups.txt"); } }
        private static string MarksPath { get { return Path.Combine(ChartBridgeConfig.Folder, "account-marks.txt"); } }
        // 2026-10-21 (Anthony, "the last groups that read cleanly"; the review of b4bc612): groups.txt as it last read cleanly or was
        // last saved, written after every clean read and every save. The one copy the bot, the agents and the copier fall back on
        // while groups.txt cannot be read (never .bak, the copy before the latest save, nor .tmp).
        public static string GoodPath { get { return Path.Combine(ChartBridgeConfig.Folder, "groups.txt.good"); } }

        // Test hook: the UTC clock (unused in NinjaTrader).
        public static Func<DateTime> ClockUtc;
        private static DateTime NowUtc() { Func<DateTime> f = ClockUtc; return f != null ? f() : DateTime.UtcNow; }
        private static DateTime NowEt() { return TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(NowUtc(), DateTimeKind.Utc), ChartBridgeTime.Eastern); }
        // ChartBridge's session date (18:00 ET starts the next day's), as agentState.session.
        public static string SessionNow() { DateTime et = NowEt(); return (et.Hour >= 18 ? et.Date.AddDays(1) : et.Date).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture); }

        public sealed class Group
        {
            public string Id, Name, Type;
            public bool NoHedge;
            public double DailyLoss, Drawdown, Target, Size, LockAt;   // 0: none (DailyLoss, Target, LockAt)
            public double Consistency;   // CON (a), Anthony 2026-10-15: Lucid's consistency percent, 0 none; informational only
            // 0.6.1 (SPEC CE-1, Anthony 2026-10-15): the account type (eval, funded, or null: not set) and the default hero (a build
            // name, or null). Shown on the page only: ChartBridge checks their shape, never which hero trades the group.
            public string AccountType, Hero;
            // 0.6.5 (Anthony 2026-10-19): the group's risk percent, of each member's max loss (its drawdown amount): 0 off. Stored and
            // shown; a group entry from the ticket (groupPreview, groupOrder: GroupPlan) is sized from it; the copier, the agents and the bot never read it
            public double RiskPct;
            public string[] Extra = new string[0];                   // fields after riskPct, kept as read (a later ChartBridge's)
            public Group Clone() { Group g = (Group)MemberwiseClone(); g.Extra = (string[])Extra.Clone(); return g; }
            // 0.6.7 (Anthony 2026-10-22): a group made on the Multi-Account panel has no rules of its own (size, drawdown and type "-");
            // one saved before keeps the ones it has
            public bool HasRules { get { return Size > 0 && Drawdown > 0 && Type != null; } }
            // the group's own rules: the rules of every member that has none of its own (every member of a 0.6.4 or older file); 0.6.7:
            // they give such a member its floor and rooms only (never a group entry's size), and a group with none gives none
            public Rules Default() { return HasRules ? new Rules { Size = Size, DailyLoss = DailyLoss, Drawdown = Drawdown, Type = Type, LockAt = LockAt, Target = Target, Consistency = Consistency } : null; }
        }
        // 0.6.5 (Anthony 2026-10-19, PRIORITY): one member's rules. A member with a rules line has its own (a group may hold accounts of
        // different types and sizes); one without inherits the group's (Default), exactly as 0.6.4.
        public sealed class Rules
        {
            public double Size, DailyLoss, Drawdown, LockAt, Target, Consistency;   // 0: none (DailyLoss, LockAt, Target, Consistency)
            public string Type, TypeId;             // Type: eod, intraday, static; TypeId: The Desk's account type it came from, or null
            public int MaxMinis, MaxMicros;         // the firm's max size (0: none); 0.6.6: enforced on every entry (ChartBridgeOrders.FirmMaxFor)
            public bool Own;                        // from a rules line (else the group's)
            public string[] Extra = new string[0];  // fields after typeId, kept as read (a later ChartBridge's)
            public Rules Clone() { Rules r = (Rules)MemberwiseClone(); r.Extra = (string[])Extra.Clone(); return r; }
        }
        private sealed class State
        {
            public readonly Dictionary<string, Group> Groups = new Dictionary<string, Group>(StringComparer.Ordinal);
            public readonly Dictionary<string, string> Members = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);   // account -> group id
            public readonly Dictionary<string, double[]> Personal = new Dictionary<string, double[]>(StringComparer.OrdinalIgnoreCase);   // account -> {floor, daily}, 0 none
            public readonly Dictionary<string, Rules> Own = new Dictionary<string, Rules>(StringComparer.OrdinalIgnoreCase);   // 0.6.5: a member -> its own rules
            public readonly HashSet<string> Benched = new HashSet<string>(StringComparer.OrdinalIgnoreCase);   // 0.6.7: the members on the bench
            public int Next = 1;
            // 0.6.5: the rules of a member of group g: its own, else the group's
            public Rules RulesOf(string account, Group g) { Rules r; return account != null && Own.TryGetValue(account, out r) ? r.Clone() : g.Default(); }
            public State Clone()
            {
                State s = new State { Next = Next };
                foreach (KeyValuePair<string, Group> kv in Groups) s.Groups[kv.Key] = kv.Value.Clone();
                foreach (KeyValuePair<string, string> kv in Members) s.Members[kv.Key] = kv.Value;
                foreach (KeyValuePair<string, double[]> kv in Personal) s.Personal[kv.Key] = (double[])kv.Value.Clone();
                foreach (KeyValuePair<string, Rules> kv in Own) s.Own[kv.Key] = kv.Value.Clone();
                foreach (string b in Benched) s.Benched.Add(b);
                return s;
            }
        }
        private sealed class Mark
        {
            public string Name, Session;
            public double? PeakEod, PeakIntraday, DayStart, DayStartAt;   // DayStartAt: UTC ms of the day start's reading (review of #48)
            // 0.6.3 (audit C2): the trading day of the last close seen (or caught up), the balance and flat state of the last reading,
            // and the close (or day) a high may have been missed on: a missed one makes that trailing floor null until the account is
            // put in its group again with its highest close. Legacy: read from a 6 or 7 field line (0.6.2 or older), no gap check at
            // its first reading. Seen and LastAt: memory only (the first reading this run, the UTC ms of the last).
            public string CloseSeen, EodMissed, IntradayMissed;
            public double? LastBal;
            public bool LastFlat, Legacy, Seen;
            public double LastAt;
            public Mark Clone() { return (Mark)MemberwiseClone(); }
        }

        private static readonly object Mem = new object();
        private static readonly object SaveLock = new object();       // one change (and its groups.txt write) at a time
        private static readonly object MarksFileLock = new object();
        private static State state = new State();
        private static State onDisk = new State();   // 0.6.7 (review LOW 1): what groups.txt holds (the last save, or what was read at the start)
        private static bool loaded;
        private static string readError;      // groups.txt exists but could not be read: group entries refused, never rewritten this run
        // 2026-10-21 (Anthony): with readError set, the last good copy (its file name) that `state` holds for the bot, the agents and the
        // copier, or null when none read cleanly (their entries wait)
        private static string lastGoodFrom, lastGoodAt;   // lastGoodAt: "2026-10-21 08:14 ET", when groups.txt.good was written
        private static readonly Dictionary<string, Mark> Marks = new Dictionary<string, Mark>(StringComparer.OrdinalIgnoreCase);
        private static string marksError;     // account-marks.txt could not be read: not rewritten this run, no marks kept
        private static bool marksDirty;
        private static double marksWrittenMs = -1e18;
        private static bool marksSaveFailed;
        private static string lastGroupsJson;
        private static readonly Dictionary<string, string> LastSide = new Dictionary<string, string>(StringComparer.Ordinal);

        // ---------------------------------------------------------- start, stop
        public static void Clear()
        {
            lock (Mem)
            {
                ExitOf.Clear(); ExitHeld.Clear(); FlatSince.Clear(); LeftCancelled.Clear(); LeftLooked.Clear(); PosSide.Clear();
                state = onDisk = new State(); loaded = false; readError = null; lastGoodFrom = null; lastGoodAt = null; Marks.Clear(); marksError = null; marksDirty = false; marksWrittenMs = -1e18;
                marksSaveFailed = false; lastGroupsJson = null; LastSide.Clear();
            }
            ClearDailyHits();   // 0.6.6
        }

        // Reads groups.txt and account-marks.txt (ChartBridgeAccounts.StartNow, at ChartBridge's start; the harness on its thread).
        public static void StartNow()
        {
            Clear();
            Load();
        }

        // At the stop: the marks as they are (a high reached in the last seconds is not lost).
        public static void Stop()
        {
            try { SaveMarks(true); } catch (Exception ex) { ChartBridgeServer.Log("account-marks.txt: the last save at the stop failed (" + ex.Message + ")"); }
        }

        private static void EnsureLoaded()
        {
            bool l;
            lock (Mem) l = loaded;
            if (!l) Load();
        }

        private static void Load()
        {
            string err = null;
            State s = null, good = null;   // good: the last good copy the machines run on while groups.txt cannot be read (2026-10-21)
            string goodFrom = null;
            string[] lines = null;
            bool exists = File.Exists(FilePath);
            List<string> notes = new List<string>();
            if (!exists)
            {
                // 0.6.3 (review MED 5): no groups.txt but a copy beside it (a save cut off): never "no groups" on its own (every account
                // would trade with no limits): unreadable, as MED 3, and the alarm says what the copy holds
                foreach (string alt in ChartBridgeFiles.LeftOvers(FilePath))
                {
                    string[] b = ChartBridgeFiles.ReadAny(alt);
                    string berr;
                    State bs = b != null ? Parse(b, out berr) : null;
                    if (bs == null) continue;
                    exists = true;
                    err = "groups.txt is missing (a save cut off?) but " + Path.GetFileName(alt) + " is there and holds " + bs.Groups.Count + " group" + (bs.Groups.Count == 1 ? "" : "s") + (bs.Groups.Count > 0 ? " (" + string.Join(", ", bs.Groups.Values.Select(g => g.Name)) + ")" : "") + " with " + bs.Members.Count + " account" + (bs.Members.Count == 1 ? "" : "s") + " in them: to go back to it, copy " + Path.GetFileName(alt) + " to groups.txt; to start with no groups, delete it";
                    break;
                }
            }
            if (exists && err == null)
            {
                lines = ReadLines(FilePath, out err);
                if (lines != null) s = Parse(lines, out err);
                // 0.6.3 (review MED 3): never the last good copy on its own: the alarm says what it holds. 2026-10-21 (Anthony): the bot,
                // the agents and the copier run on it (a file that cannot be opened at all included); his page keeps the 0.6.6 rules
                if (s == null)
                {
                    string[] b = ChartBridgeFiles.ReadBackup(FilePath);
                    string berr;
                    State bs = b != null ? Parse(b, out berr) : null;
                    if (bs != null) err += "; its last good copy, groups.txt.bak, holds " + bs.Groups.Count + " group" + (bs.Groups.Count == 1 ? "" : "s") + (bs.Groups.Count > 0 ? " (" + string.Join(", ", bs.Groups.Values.Select(g => g.Name)) + ")" : "") + " with " + bs.Members.Count + " account" + (bs.Members.Count == 1 ? "" : "s") + " in them: to go back to it, copy groups.txt.bak over groups.txt";
                }
            }
            string goodAt = null;
            if (exists && s == null)
            {
                // the machines' copy: groups.txt.good only (written after every clean read and every save); none: they wait
                string gerr;
                string[] gl = File.Exists(GoodPath) ? Unseal(ReadLines(GoodPath, out gerr)) : null;   // a cut copy: none (they wait)
                State gs = gl != null ? Parse(gl, out gerr) : null;
                if (gs != null) { good = gs; goodFrom = "groups.txt.good"; goodAt = EtStamp(File.GetLastWriteTimeUtc(GoodPath)); }
            }
            else if (s != null) WriteGood(string.Concat(lines.Select(l => l + Environment.NewLine)));   // a clean read
            else if (!exists) WriteGood(Serialize(new State()));                                        // no groups.txt: no groups
            string merr = null;
            Dictionary<string, Mark> marks = null;
            bool marksLeft = false;
            if (File.Exists(MarksPath))
            {
                string[] ml = ReadLines(MarksPath, out merr);
                if (ml != null) marks = ParseMarks(ml, out merr);
                if (ml != null && marks == null)
                {
                    string[] b = ChartBridgeFiles.ReadBackup(MarksPath);
                    string berr;
                    Dictionary<string, Mark> bm = b != null ? ParseMarks(b, out berr) : null;
                    if (bm != null) { notes.Add(ChartBridgeFiles.BackupNote("account-marks.txt", merr)); marks = bm; merr = null; }
                }
            }
            else
            {
                // 0.6.3 (review MED 5): no file, but a copy left by a replace that was cut off: used, said so (the marks are written again)
                foreach (string alt in ChartBridgeFiles.LeftOvers(MarksPath))
                {
                    string berr;
                    string[] b = ChartBridgeFiles.ReadAny(alt);
                    Dictionary<string, Mark> bm = b != null ? ParseMarks(b, out berr) : null;
                    if (bm == null) continue;
                    notes.Add("account-marks.txt is missing (a save cut off?): ChartBridge uses " + Path.GetFileName(alt) + " and writes the file again");
                    marks = bm; marksLeft = true; break;
                }
            }
            lock (Mem)
            {
                if (loaded) return;   // another thread read them meanwhile
                loaded = true;
                if (!exists) state = new State();
                else if (s == null) { readError = err ?? "unknown"; state = good ?? new State(); lastGoodFrom = good != null ? goodFrom : null; lastGoodAt = good != null ? goodAt : null; }
                else state = s;
                onDisk = state;
                Marks.Clear();
                if (marks != null) foreach (KeyValuePair<string, Mark> kv in marks) Marks[kv.Key] = kv.Value;
                marksError = merr != null && marks == null ? merr : null;
                if (marksLeft) marksDirty = true;
            }
            if (exists && s == null) Alarm(ReadFailedNow() + " (" + err + "); fix or delete the file, then recompile");
            else if (exists) ChartBridgeServer.Log("groups: " + s.Groups.Count + " group" + (s.Groups.Count == 1 ? "" : "s") + ", " + s.Members.Count + " account" + (s.Members.Count == 1 ? "" : "s") + " in them (groups.txt)");
            foreach (string w in notes) ChartBridgeFiles.Note(w);
            if (merr != null && marks == null) ChartBridgeServer.Log("account-marks.txt could not be read (" + merr + "): it is not rewritten this run; the trailing floors and the computed P&L are not given until it can be read");
        }

        private static string[] ReadLines(string path, out string err)
        {
            err = null;
            for (int attempt = 0; attempt < 5; attempt++)   // review of b4bc612: a sharing lock (a backup, antivirus) gets 5 tries, 0.4 s in all
            {
                try
                {
                    Func<string, string> fault = ChartBridgeAccounts.ReadFault;
                    string why = fault != null ? fault(Path.GetFileName(path)) : null;
                    if (why != null) throw new IOException(why);
                    List<string> lines = new List<string>();
                    using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                    using (StreamReader r = new StreamReader(fs))
                    {
                        string l;
                        while ((l = r.ReadLine()) != null) lines.Add(l);
                    }
                    return lines.ToArray();
                }
                catch (Exception ex) { err = ex.Message; if (attempt < 4) Thread.Sleep(100); }
            }
            return null;
        }

        // ---------------------------------------------------------- groups.txt: the whole file or nothing
        private static readonly Regex IdRx = new Regex("^g[1-9][0-9]{0,8}$");
        private static readonly Regex MoneyRx = new Regex("^(?:0|[1-9][0-9]{0,8})(?:\\.[0-9]{1,2})?$");
        // 0.6.1: a hero's build name, 1 to 64 safe characters (letters, digits, dot, underscore, hyphen; a letter or digit first)
        public static readonly Regex HeroRx = new Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
        private static bool FileType(string t, out string v) { v = null; if (t == "-") return true; if (t == "eval" || t == "funded") { v = t; return true; } return false; }
        private static bool FileHero(string t, out string v) { v = null; if (t == "-") return true; if (t != null && HeroRx.IsMatch(t)) { v = t; return true; } return false; }

        private static bool FileMoney(string t, bool dashOk, out double v)
        {
            v = 0;
            if (dashOk && t == "-") return true;
            if (!MoneyRx.IsMatch(t ?? "")) return false;
            v = double.Parse(t, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture);
            return v > 0 && v <= MaxMoney;
        }

        private static bool FilePercent(string t, out double v)
        {
            v = 0;
            if (t == "-") return true;
            if (!Regex.IsMatch(t ?? "", "^(?:[1-9][0-9]?|100)(?:\\.[0-9]{1,2})?$")) return false;
            v = double.Parse(t, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture);
            return v > 0 && v <= 100;
        }

        private static string NameProblem(string name)
        {
            if (name == null) return "name must be a plain string";
            if (name.Length < 1 || name.Length > NameMax) return "a group name is 1 to " + NameMax + " characters";
            if (name != name.Trim()) return "a group name has no space at either end";
            if (name.Any(ch => ch < 0x20 || ch == 0x7f)) return "a group name is plain text (no tab)";
            return null;
        }

        private static State Parse(string[] lines, out string why)
        {
            why = null;
            State s = new State();
            if (lines.Length < 2 || lines[0].TrimEnd('\r') != Header || !lines[1].StartsWith("#", StringComparison.Ordinal)) { why = "the first two lines are not ChartBridge's"; return null; }
            List<string[]> members = new List<string[]>();
            int maxId = 0;
            for (int i = 2; i < lines.Length; i++)
            {
                string line = lines[i].TrimEnd('\r');
                if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal)) continue;
                string[] p = line.Split('\t');
                string at = "line " + (i + 1);
                if (p[0] == "group")
                {
                    Group g = new Group();
                    double dl, dd, tg, sz, lk;
                    // 0.6.7: a group with no rules of its own has "-" for its drawdown, its type and its size, and none of the other
                    // rules (a ChartBridge 0.6.6 or older reads such a line as no group line: the whole file unreadable, so it never
                    // sizes or floors anything from rules that are not there)
                    bool none = p.Length >= 10 && p[5] == "-" && p[6] == "-" && p[8] == "-";
                    if (p.Length < 10 || !IdRx.IsMatch(p[1]) || NameProblem(p[2]) != null || (p[3] != "on" && p[3] != "off") || !FileMoney(p[4], true, out dl) || !FileMoney(p[5], none, out dd) ||
                        (p[6] != "eod" && p[6] != "intraday" && p[6] != "static" && !none) || !FileMoney(p[7], true, out tg) || !FileMoney(p[8], none, out sz) || !FileMoney(p[9], true, out lk) ||
                        (none && (dl > 0 || tg > 0 || lk > 0)))
                    { why = at + " is not a group line"; return null; }
                    if (s.Groups.ContainsKey(p[1])) { why = at + " names group " + p[1] + " twice"; return null; }
                    if (s.Groups.Values.Any(x => string.Equals(x.Name, p[2], StringComparison.OrdinalIgnoreCase))) { why = at + " names a group name twice"; return null; }
                    // 0.6.7 (Anthony 2026-10-22, "Always on, no switch"): no hedging is on for every group; a line saved "off" reads as on
                    g.Id = p[1]; g.Name = p[2]; g.NoHedge = true; g.DailyLoss = dl; g.Drawdown = dd; g.Type = none ? null : p[6]; g.Target = tg; g.Size = sz; g.LockAt = lk;
                    double con = 0;
                    if (p.Length >= 11 && !FilePercent(p[10], out con)) { why = at + " is not a group line (consistency)"; return null; }
                    if (none && con > 0) { why = at + " is not a group line (consistency with no rules)"; return null; }
                    g.Consistency = con;
                    // 0.6.1: the type and the hero; a line written before them (10 or 11 fields) reads as not set and none
                    string at2 = null, hr = null;
                    if (p.Length >= 12 && !FileType(p[11], out at2)) { why = at + " is not a group line (type)"; return null; }
                    if (p.Length >= 13 && !FileHero(p[12], out hr)) { why = at + " is not a group line (hero)"; return null; }
                    g.AccountType = p.Length >= 12 ? at2 : null; g.Hero = p.Length >= 13 ? hr : null;
                    // 0.6.5: the risk percent; a line written before it (10 to 13 fields) reads as off
                    double rp = 0;
                    if (p.Length >= 14 && !FileRisk(p[13], out rp)) { why = at + " is not a group line (risk)"; return null; }
                    g.RiskPct = rp;
                    g.Extra = p.Skip(14).ToArray();
                    s.Groups[g.Id] = g;
                    maxId = Math.Max(maxId, int.Parse(g.Id.Substring(1), CultureInfo.InvariantCulture));
                }
                else if (p[0] == "member")
                {
                    // 0.6.7: a fourth field "benched" puts the member on the bench (written only for a benched member, so a file with no
                    // one benched is exactly what 0.6.6 wrote; a 0.6.6 or older reads a benched member's line as no member line)
                    if ((p.Length != 3 && !(p.Length == 4 && p[3] == "benched")) || p[1].Length == 0 || p[1] != p[1].Trim() || !IdRx.IsMatch(p[2]) || ChartBridgeOrders.IsNeverTradable(p[1])) { why = at + " is not a member line"; return null; }
                    if (s.Members.ContainsKey(p[1])) { why = at + " puts an account in two groups"; return null; }
                    s.Members[p[1]] = p[2];
                    if (p.Length == 4) s.Benched.Add(p[1]);
                    members.Add(new[] { p[1], p[2], at });
                }
                else if (p[0] == "rules")
                {
                    // 0.6.5: a member's own rules (the same checks as groupSave's); 0.6.6: or an account in no group's (the firm's rules)
                    Rules r;
                    string bad;
                    if (p.Length < 12 || p[1].Length == 0 || p[1] != p[1].Trim() || (r = FileRules(p, out bad)) == null) { why = at + " is not a rules line"; return null; }
                    if (s.Own.ContainsKey(p[1])) { why = at + " gives an account rules twice"; return null; }
                    s.Own[p[1]] = r;
                }
                else if (p[0] == "personal")
                {
                    double f, d;
                    if (p.Length != 4 || p[1].Length == 0 || p[1] != p[1].Trim() || !FileMoney(p[2], true, out f) || !FileMoney(p[3], true, out d)) { why = at + " is not a personal line"; return null; }
                    if (s.Personal.ContainsKey(p[1])) { why = at + " names an account twice"; return null; }
                    s.Personal[p[1]] = new[] { f, d };
                }
                else { why = at + " is not a group, member, rules or personal line"; return null; }
            }
            foreach (string[] m in members) if (!s.Groups.ContainsKey(m[1])) { why = m[2] + " puts an account in group " + m[1] + ", which is not there"; return null; }
            // 0.6.6: an account in no group may have its own (the firm's) rules (memberRules there, 0a9f315), written as a rules line; this
            // check refused that very file at the next start ("gives rules to an account in no group": every entry refused). Taken now.
            s.Next = maxId + 1;
            return s;
        }

        private static string MoneyText(double v) { return v > 0 ? v.ToString("0.##", CultureInfo.InvariantCulture) : "-"; }
        private static string PctText(double v) { return v > 0 ? v.ToString("0.##", CultureInfo.InvariantCulture) : "-"; }

        // 0.6.5: the risk percent (of each member's max loss): more than 0, at most 100, at most 2 decimals; - off
        private static readonly Regex RiskRx = new Regex("^(?:0|[1-9][0-9]?|100)(?:\\.[0-9]{1,2})?$");
        private static bool FileRisk(string t, out double v)
        {
            v = 0;
            if (t == "-") return true;
            if (!RiskRx.IsMatch(t ?? "")) return false;
            v = double.Parse(t, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture);
            return v > 0 && v <= 100;
        }
        // 0.6.5: a max size: a whole number of contracts, 1 to 1000 (The Desk's own cap); - none
        public const int MaxSizeMax = 1000;
        private static readonly Regex SizeRx = new Regex("^[1-9][0-9]{0,3}$");
        private static bool FileSize(string t, out int v) { v = 0; if (t == "-") return true; if (!SizeRx.IsMatch(t ?? "")) return false; v = int.Parse(t, CultureInfo.InvariantCulture); return v <= MaxSizeMax; }
        // 0.6.5: The Desk's account type id, as the page's checks (letters, digits, dot, underscore, hyphen; 1 to 120)
        public static readonly Regex TypeIdRx = new Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$");
        // The rules that make sense together (groupSave's checks): null when they do, else why.
        private static string RulesProblem(Rules r)
        {
            if (r.Type != "eod" && r.Type != "intraday" && r.Type != "static") return "drawdownType must be eod, intraday or static";
            if (r.Drawdown >= r.Size) return "the drawdown must be less than the account size";
            if (r.LockAt > 0 && r.Type == "static") return "floor stops at applies to a trailing drawdown only (end of day or intraday); 0 for none";
            if (r.LockAt > 0 && r.LockAt <= r.Size - r.Drawdown) return "floor stops at must be above the starting floor (" + (r.Size - r.Drawdown).ToString("0.##", CultureInfo.InvariantCulture) + ")";
            return null;
        }
        // A rules line: rules, account, size, dailyLoss|-, drawdown, type, lockAt|-, target|-, consistency|-, maxMinis|-, maxMicros|-, typeId|-.
        private static Rules FileRules(string[] p, out string why)
        {
            why = null;
            Rules r = new Rules { Own = true };
            double sz, dl, dd, lk, tg, con;
            int mm, mu;
            if (!FileMoney(p[2], false, out sz) || !FileMoney(p[3], true, out dl) || !FileMoney(p[4], false, out dd) || !FileMoney(p[6], true, out lk) || !FileMoney(p[7], true, out tg) ||
                !FilePercent(p[8], out con) || !FileSize(p[9], out mm) || !FileSize(p[10], out mu) || (p[11] != "-" && !TypeIdRx.IsMatch(p[11]))) { why = "a field"; return null; }
            r.Size = sz; r.DailyLoss = dl; r.Drawdown = dd; r.Type = p[5]; r.LockAt = lk; r.Target = tg; r.Consistency = con; r.MaxMinis = mm; r.MaxMicros = mu; r.TypeId = p[11] == "-" ? null : p[11];
            r.Extra = p.Skip(12).ToArray();
            if ((why = RulesProblem(r)) != null) return null;
            return r;
        }

        private static string Serialize(State s)
        {
            StringBuilder b = new StringBuilder(Header).Append('\n').Append(Header2).Append('\n');
            foreach (Group g in s.Groups.Values.OrderBy(x => int.Parse(x.Id.Substring(1), CultureInfo.InvariantCulture)))
            {
                b.Append("group\t").Append(g.Id).Append('\t').Append(g.Name).Append('\t').Append("on").Append('\t').Append(MoneyText(g.DailyLoss)).Append('\t')   // 0.6.7: always on
                 .Append(MoneyText(g.Drawdown)).Append('\t').Append(g.Type ?? "-").Append('\t').Append(MoneyText(g.Target)).Append('\t').Append(MoneyText(g.Size)).Append('\t').Append(MoneyText(g.LockAt))
                 .Append('\t').Append(g.Consistency > 0 ? g.Consistency.ToString("0.##", CultureInfo.InvariantCulture) : "-")
                 .Append('\t').Append(g.AccountType ?? "-").Append('\t').Append(g.Hero ?? "-");
                if (g.RiskPct > 0 || g.Extra.Length > 0) b.Append('\t').Append(PctText(g.RiskPct));   // 0.6.5: off and nothing after it: the line exactly as 0.6.4 wrote it
                foreach (string x in g.Extra) b.Append('\t').Append(x);
                b.Append('\n');
            }
            foreach (KeyValuePair<string, string> kv in s.Members.OrderBy(x => x.Key, StringComparer.OrdinalIgnoreCase))
                b.Append("member\t").Append(kv.Key).Append('\t').Append(kv.Value).Append(s.Benched.Contains(kv.Key) ? "\tbenched" : "").Append('\n');   // 0.6.7: the bench
            // 0.6.5: a member's own rules. A ChartBridge 0.6.4 or older does not know this line: it reads the whole file as unreadable
            // (every entry refused, an alarm, never rewritten), so it never trails a floor from the wrong rules
            foreach (KeyValuePair<string, Rules> kv in s.Own.OrderBy(x => x.Key, StringComparer.OrdinalIgnoreCase))
            {
                Rules r = kv.Value;
                b.Append("rules\t").Append(kv.Key).Append('\t').Append(MoneyText(r.Size)).Append('\t').Append(MoneyText(r.DailyLoss)).Append('\t').Append(MoneyText(r.Drawdown)).Append('\t').Append(r.Type)
                 .Append('\t').Append(MoneyText(r.LockAt)).Append('\t').Append(MoneyText(r.Target)).Append('\t').Append(PctText(r.Consistency))
                 .Append('\t').Append(r.MaxMinis > 0 ? r.MaxMinis.ToString(CultureInfo.InvariantCulture) : "-").Append('\t').Append(r.MaxMicros > 0 ? r.MaxMicros.ToString(CultureInfo.InvariantCulture) : "-").Append('\t').Append(r.TypeId ?? "-");
                foreach (string x in r.Extra) b.Append('\t').Append(x);
                b.Append('\n');
            }
            foreach (KeyValuePair<string, double[]> kv in s.Personal.OrderBy(x => x.Key, StringComparer.OrdinalIgnoreCase))
                b.Append("personal\t").Append(kv.Key).Append('\t').Append(MoneyText(kv.Value[0])).Append('\t').Append(MoneyText(kv.Value[1])).Append('\n');
            return b.ToString();
        }

        // The second review of 4406fcb (D): groups.txt.good ends with "# end <lines before it>", so a copy cut short (a crash, a power
        // cut) is no clean copy (the machines wait) instead of groups with members missing. groups.txt itself never has this line.
        public static string SealGood(string text)
        {
            string body = text.EndsWith("\n") ? text : text + Environment.NewLine;
            int n = body.Split('\n').Length - 1;
            return body + "# end " + n.ToString(CultureInfo.InvariantCulture) + Environment.NewLine;
        }
        private static string[] Unseal(string[] lines)
        {
            if (lines == null) return null;
            List<string> l = lines.Select(x => x.TrimEnd('\r')).ToList();
            while (l.Count > 0 && l[l.Count - 1].Length == 0) l.RemoveAt(l.Count - 1);
            if (l.Count == 0) return null;
            Match m = Regex.Match(l[l.Count - 1], "^# end ([0-9]{1,9})$");
            if (!m.Success || int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture) != l.Count - 1) return null;
            l.RemoveAt(l.Count - 1);
            return l.ToArray();
        }

        // groups.txt.good: as WriteWhole writes (a temp file written through and flushed to the disk, then swapped in), with no backup of
        // its own. A failure is logged and changes nothing else.
        private static void WriteGood(string text)
        {
            try
            {
                Directory.CreateDirectory(ChartBridgeConfig.Folder);
                string tmp = GoodPath + ".tmp";
                byte[] bytes = new UTF8Encoding(false).GetBytes(SealGood(text));
                using (FileStream fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
                {
                    fs.Write(bytes, 0, bytes.Length);
                    fs.Flush(true);
                }
                if (File.Exists(GoodPath)) File.Replace(tmp, GoodPath, null); else File.Move(tmp, GoodPath);
            }
            catch (Exception ex) { ChartBridgeServer.Log("groups.txt.good could not be written (" + ex.Message + "); the last one stays"); }
        }

        private static string EtStamp(DateTime utc)
        {
            try { return TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), ChartBridgeTime.Eastern).ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture) + " ET"; }
            catch (Exception) { return utc.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture) + " UTC"; }
        }

        // Whole, through a temp file; null when saved, else why.
        private static string WriteWhole(string path, string text)
        {
            try
            {
                Directory.CreateDirectory(ChartBridgeConfig.Folder);
                ChartBridgeFiles.WriteWhole(path, text);   // 0.6.3 (audit C3): write-through, flushed, the previous copy kept as .bak
                return null;
            }
            catch (Exception ex) { return ex.Message; }
        }

        // ---------------------------------------------------------- account-marks.txt
        private static Dictionary<string, Mark> ParseMarks(string[] lines, out string why)
        {
            why = null;
            Dictionary<string, Mark> d = new Dictionary<string, Mark>(StringComparer.OrdinalIgnoreCase);
            if (lines.Length < 1 || lines[0].TrimEnd('\r') != MarksHeader) { why = "the first line is not ChartBridge's"; return null; }
            for (int i = 1; i < lines.Length; i++)
            {
                string line = lines[i].TrimEnd('\r');
                if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal)) continue;
                string[] p = line.Split('\t');
                double pe, pi, ds;
 long at = 0;
                double lb = 0;
                const string DayRx = "^(?:-|[0-9]{4}-[0-9]{2}-[0-9]{2})$";
                if ((p.Length != 6 && p.Length != 7 && p.Length != 12) || (p.Length >= 7 && p[6] != "-" && !long.TryParse(p[6], NumberStyles.None, CultureInfo.InvariantCulture, out at)) || p[0] != "mark" || p[1].Length == 0 || !FileMoney(p[2], true, out pe) || !FileMoney(p[3], true, out pi) || !FileMoney(p[4], true, out ds) ||
                    !Regex.IsMatch(p[5], DayRx) || d.ContainsKey(p[1]) ||
                    (p.Length == 12 && (!Regex.IsMatch(p[7], DayRx) || !FileMoney(p[8], true, out lb) || (p[9] != "flat" && p[9] != "open" && p[9] != "-") || !Regex.IsMatch(p[10], DayRx) || !Regex.IsMatch(p[11], DayRx))))
                { why = "line " + (i + 1) + " is not a mark line"; return null; }
                Mark mk = new Mark { Name = p[1], PeakEod = pe > 0 ? pe : (double?)null, PeakIntraday = pi > 0 ? pi : (double?)null, DayStart = ds > 0 ? ds : (double?)null, Session = p[5] == "-" ? null : p[5], DayStartAt = at > 0 ? at : (double?)null };
                if (p.Length == 12) { mk.CloseSeen = Dash(p[7]); mk.LastBal = lb > 0 ? lb : (double?)null; mk.LastFlat = p[9] == "flat"; mk.EodMissed = Dash(p[10]); mk.IntradayMissed = Dash(p[11]); }
                else mk.Legacy = true;
                d[p[1]] = mk;
            }
            return d;
        }

        private static string Dash(string t) { return t == "-" ? null : t; }

        private static void SaveMarks(bool now)
        {
            lock (MarksFileLock)
            {
                string text;
                double t = ChartBridgeTime.NowUtcMs();
                lock (Mem)
                {
                    if (!loaded || marksError != null || !marksDirty) return;
                    if (!now && t - marksWrittenMs < MarksWriteMs) return;
                    StringBuilder b = new StringBuilder(MarksHeader).Append('\n').Append(MarksHeader2).Append('\n');
                    foreach (Mark m in Marks.Values.OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase))
                        b.Append("mark\t").Append(m.Name).Append('\t').Append(MoneyText(m.PeakEod ?? 0)).Append('\t').Append(MoneyText(m.PeakIntraday ?? 0)).Append('\t')
                         .Append(MoneyText(m.DayStart ?? 0)).Append('\t').Append(m.Session ?? "-").Append('\t').Append(m.DayStartAt.HasValue ? ((long)m.DayStartAt.Value).ToString(CultureInfo.InvariantCulture) : "-")
                         .Append('\t').Append(m.CloseSeen ?? "-").Append('\t').Append(MoneyText(m.LastBal ?? 0)).Append('\t').Append(m.LastBal.HasValue ? (m.LastFlat ? "flat" : "open") : "-")
                         .Append('\t').Append(m.EodMissed ?? "-").Append('\t').Append(m.IntradayMissed ?? "-").Append('\n');
                    text = b.ToString();
                    marksDirty = false; marksWrittenMs = t;
                }
                string err = WriteWhole(MarksPath, text);
                bool say;
                lock (Mem) { say = err != null && !marksSaveFailed; marksSaveFailed = err != null; if (err != null) marksDirty = true; }
                if (say) ChartBridgeServer.Log("account-marks.txt could not be saved (" + err + "); the highs are in force now and ChartBridge tries again");
            }
        }

        // An account's money now, as NinjaTrader gives it (null when it gives none).
        private static double? Item(Account a, AccountItem item)
        {
            if (a == null) return null;
            try { double v = a.Get(item, a.Denomination); return double.IsNaN(v) || double.IsInfinity(v) ? (double?)null : v; }
            catch (Exception) { return null; }
        }

        private static bool Up(Account a) { return a != null && ChartBridgeAccounts.ConnectionText(a) == "connected"; }

        // Every second (ChartBridgeAccounts.Tick): each connected account's day start (its first reading of a session, which also
        // raises an end-of-day high it has) and its intraday high; the marks saved; the groups message when it changed.
        public static void Tick(List<Account> all, double now)
        {
            EnsureLoaded();
            string session = SessionNow();
            DateTime etNow = NowEt();
            bool closeWindow = etNow.Hour == 17 || (etNow.Hour == 18 && etNow.Minute < 5);
            double nowMs = (NowUtc() - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
            List<string> notes = new List<string>();
            foreach (Account a in all)
            {
                if (a == null || a.Name == null || ChartBridgeOrders.IsNeverTradable(a.Name) || !Up(a) || !ChartBridgeAccounts.Listed(a.Name)) continue;
                double? bal = Item(a, AccountItem.CashValue), un = Item(a, AccountItem.UnrealizedProfitLoss);
                if (!bal.HasValue || bal.Value <= 0) continue;   // 0: NinjaTrader has not given a balance yet
                bool flat = IsFlat(a);
                lock (Mem)
                {
                    if (marksError != null) break;
                    Mark m;
                    if (!Marks.TryGetValue(a.Name, out m)) { Marks[a.Name] = m = new Mark { Name = a.Name, CloseSeen = LatestClose(etNow), Seen = true, LastAt = nowMs }; marksDirty = true; }
                    // 0.6.3 (audit C2): the first reading after a gap (this run's first, or none for GapMs): the closes and highs it did not see
                    double balR = Math.Round(bal.Value, 2);
                    if ((!m.Seen || nowMs - m.LastAt > GapMs) && !m.Legacy) { string note = AfterGap(m, balR, flat, un, etNow, closeWindow); if (note != null) notes.Add(note); }
                    if (m.Legacy && m.CloseSeen == null) m.CloseSeen = LatestClose(etNow);   // a 0.6.2 file: as 0.6.2 (it saw what it saw)
                    m.Seen = true; m.Legacy = false; m.LastAt = nowMs;
                    if (m.LastBal != balR || m.LastFlat != flat) { m.LastBal = balR; m.LastFlat = flat; marksDirty = true; }
                    if (m.Session != session)
                    {
                        m.Session = session; m.DayStart = Math.Round(bal.Value, 2); m.DayStartAt = nowMs; marksDirty = true;
                        // review of #48 (item 6): only a reading in the 17:00 to 18:05 ET window is a close; a late first reading
                        // (ChartBridge started at midday) never raises the end-of-day high
                        if (closeWindow && m.PeakEod.HasValue && bal.Value > m.PeakEod.Value) m.PeakEod = Math.Round(bal.Value, 2);
                        if (closeWindow) { string c = LatestClose(etNow); if (m.CloseSeen == null || string.CompareOrdinal(c, m.CloseSeen) > 0) m.CloseSeen = c; }
                    }
                    if (m.PeakIntraday.HasValue && un.HasValue && bal.Value + un.Value > m.PeakIntraday.Value + 0.004) { m.PeakIntraday = Math.Round(bal.Value + un.Value, 2); marksDirty = true; }
                }
            }
            SaveMarks(false);
            // 0.6.6: an account whose known daily room reached 0 or below is marked for the day, with one alert (DailyReached)
            foreach (Account a in all)
            {
                if (a == null || a.Name == null || ChartBridgeOrders.IsNeverTradable(a.Name) || !Up(a) || !ChartBridgeAccounts.Listed(a.Name)) continue;
                try { DailyReached(Read(a.Name, a, false)); }
                catch (Exception ex) { ChartBridgeServer.Log("groups: the daily loss check of " + a.Name + " failed (" + ex.Message + ")"); }
            }
            foreach (string w in notes) { ChartBridgeServer.Log("NOTE: " + w); ChartBridgeServer.SendToTraders("{\"type\":\"status\",\"level\":\"warn\",\"text\":" + CbJson.Str(w) + "}"); }
            try { Leftovers(); } catch (Exception ex) { ChartBridgeServer.Log("groups: leftover exits check error: " + ex.Message); }   // Q-EXIT (b)
            SendGroups(false);
        }

        // The 17:00 to 18:00 ET break (ChartBridgeBranches.Check, every 2 s in it): each end-of-day high a member has is raised to
        // its equity now (the market is shut, so this is the day's close).
        public static void EodMark()
        {
            EnsureLoaded();
            List<Account> all;
            lock (Account.All) all = Account.All.ToList();
            foreach (Account a in all)
            {
                if (a == null || a.Name == null || !Up(a)) continue;
                double? bal = Item(a, AccountItem.CashValue), un = Item(a, AccountItem.UnrealizedProfitLoss);
                if (!bal.HasValue || bal.Value <= 0 || !un.HasValue) continue;
                lock (Mem)
                {
                    Mark m;
                    if (marksError != null || !Marks.TryGetValue(a.Name, out m)) continue;
                    string c = SessionNow();   // 0.6.3 (audit C2): in the break, the day's close is seen
                    if (m.CloseSeen == null || string.CompareOrdinal(c, m.CloseSeen) > 0) { m.CloseSeen = c; marksDirty = true; }
                    if (!m.PeakEod.HasValue) continue;
                    double eq = Math.Round(bal.Value + un.Value, 2);
                    if (eq > m.PeakEod.Value + 0.004) { m.PeakEod = eq; marksDirty = true; ChartBridgeServer.Log("groups: " + a.Name + "'s end-of-day high is " + eq.ToString("0.00", CultureInfo.InvariantCulture)); }
                }
            }
            SaveMarks(true);   // only when a high rose or a close was first seen (marksDirty)
        }

        // 0.6.3 (audit C2): the trading day of the latest close at or before New York time et (17:00, or 13:00 or 13:15 on an NYSE
        // holiday or early close; a day with no Globex session has none).
        public static string LatestClose(DateTime et)
        {
            DateTime d = et.Date;
            for (int i = 0; i < 40; i++, d = d.AddDays(-1))
                if (ChartBridgeCme.SessionDay(d) && (d < et.Date || et.TimeOfDay >= ChartBridgeCme.SessionClose(d))) break;
            return d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        }

        private static bool IsFlat(Account a)
        {
            lock (a.Positions) return !a.Positions.Any(p => p.MarketPosition != MarketPosition.Flat && p.Quantity != 0);
        }

        // 0.6.3 (audit C2): the first reading after a gap ChartBridge did not watch. Nothing traded (flat at both ends, the balance
        // the same): every close it missed was that balance and no high was missed. Otherwise a missed close (an EOD group) or a
        // possible intraday high is recorded and that floor is null until the account is put in its group again with its highest
        // close; never a guess. In the close window this reading is the day's close. Under Mem; a note for the pages, or null.
        private static string AfterGap(Mark m, double bal, bool flat, double? un, DateTime etNow, bool closeWindow)
        {
            string c = LatestClose(etNow);
            bool covers = closeWindow && c == etNow.Date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            bool same = m.LastBal.HasValue && m.LastFlat && flat && Math.Abs(m.LastBal.Value - bal) < 0.005;
            string missed = null, seen = m.CloseSeen;
            DateTime d = DateTime.ParseExact(c, "yyyy-MM-dd", CultureInfo.InvariantCulture);
            for (int i = 0; i < 40; i++, d = d.AddDays(-1))
            {
                string ds = d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                if (seen != null && string.CompareOrdinal(ds, seen) <= 0) break;
                if (!ChartBridgeCme.SessionDay(d) || (covers && ds == c)) continue;
                missed = ds; break;   // the latest close missed
            }
            string note = null;
            // review LOW 8: the warning only for the drawdown type of the account's group (an EOD group never hears of intraday highs)
            string gid, type = null;
            Group grp;
            if (state.Members.TryGetValue(m.Name, out gid) && state.Groups.TryGetValue(gid, out grp)) { Rules mr = state.RulesOf(m.Name, grp); type = mr != null ? mr.Type : null; }   // 0.6.5: the member's own drawdown type; 0.6.7: none with no rules
            if (covers && m.PeakEod.HasValue && un.HasValue && bal + un.Value > m.PeakEod.Value + 0.004) m.PeakEod = Math.Round(bal + un.Value, 2);
            if (missed != null && m.PeakEod.HasValue)
            {
                if (same) { if (bal > m.PeakEod.Value + 0.004) m.PeakEod = bal; ChartBridgeServer.Log("groups: " + m.Name + ": ChartBridge was not running at the close of " + missed + "; nothing traded since its last reading, so its balance " + bal.ToString("0.00", CultureInfo.InvariantCulture) + " is taken as that close"); }
                else if (m.EodMissed == null || string.CompareOrdinal(missed, m.EodMissed) > 0)
                {
                    m.EodMissed = missed;
                    if (type == "eod") note = m.Name + ": ChartBridge was not running at the close of " + missed + " and the account traded or held a position meanwhile: its end-of-day floor and room are not known until it is put in its group again with the highest close from the firm's dashboard";
                }
            }
            if (!same && m.PeakIntraday.HasValue && m.IntradayMissed == null)
            {
                m.IntradayMissed = etNow.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                if (note == null && type == "intraday") note = m.Name + ": ChartBridge was not watching while the account held a position or traded: its intraday high may have been missed, so an intraday-trailing floor and room are not known until it is put in its group again with the highest balance from the firm's dashboard";
            }
            if (m.CloseSeen == null || string.CompareOrdinal(c, m.CloseSeen) > 0) m.CloseSeen = c;
            marksDirty = true;
            return note;
        }

        // ---------------------------------------------------------- Q-EXIT (b): exits left behind when a position goes flat
        // Anthony 2026-10-15: resting exits are always accepted; when an account in a group with No hedging on goes flat on an
        // instrument, the working orders there that were exits of the position just closed (placed while a position existed, on its
        // other side: the page's and orders typed into NinjaTrader; never ChartBridge's legs, which CheckLegs keeps, nor an ATM's)
        // would now open the other side: ChartBridge cancels them, logs each, and tells the pages. After a start ChartBridge cannot
        // know where an order came from: an order on a flat account against its group's side is cancelled once, the same way.
        private static readonly Dictionary<Order, int> ExitOf = new Dictionary<Order, int>();       // order -> the side of the position it exits
        private static readonly Dictionary<Order, int> ExitHeld = new Dictionary<Order, int>();     // order -> the largest position it was an exit of
        private static readonly Dictionary<string, double> FlatSince = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);   // account|contract -> first seen flat (ms)
        public static double LeftSettleMs = 150;   // re-review 3 and 4: flat by both readings this long before a reversal's rest or an after-start look is cancelled (the harness sets 0)
        private static double NowMs() { return (NowUtc() - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }
        private static readonly HashSet<Order> LeftCancelled = new HashSet<Order>();
        private static readonly HashSet<string> LeftLooked = new HashSet<string>(StringComparer.OrdinalIgnoreCase);   // accounts looked at (connected) since the start
        private static readonly Dictionary<string, int> PosSide = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);   // account|contract: the side of the last position seen
        private static readonly object LeftLock = new object();   // one pass at a time (the 1 s check and a position update)
        public static bool LeftoversInline;   // the harness: a position update runs the pass on its own thread

        // Re-review 2 (item 2): a position went flat: the pass at once, off NinjaTrader's thread (it may cancel).
        public static void PositionWentFlat()
        {
            if (LeftoversInline) { try { Leftovers(); } catch (Exception) { } return; }
            ThreadPool.QueueUserWorkItem(delegate
            {
                try { Leftovers(); Thread.Sleep((int)LeftSettleMs + 50); Leftovers(); }   // the first pass notes the flat; the second, once it settled, may cancel
                catch (Exception ex) { ChartBridgeServer.Log("groups: leftover exits check error: " + ex.Message); }
            });
        }

        // PlaceOrderLocked, as each order is made: on the other side of the account's position by both readings, it exits that position.
        public static void NoteNewOrder(Account a, Instrument inst, Order o, bool isBuy)
        {
            try { if (ChartBridgeOrders.GroupOpposite(a, inst, isBuy)) { int h = ChartBridgeOrders.GroupHeld(a, inst); lock (Mem) { ExitOf[o] = isBuy ? -1 : 1; ExitHeld[o] = h; } } }
            catch (Exception) { }
        }

        public static void Leftovers() { lock (LeftLock) LeftoversLocked(); }

        private static void LeftoversLocked()
        {
            List<KeyValuePair<string, List<string>>> groups = new List<KeyValuePair<string, List<string>>>();
            lock (Mem)
            {
                if (!loaded || readError != null) return;
                foreach (Group g in state.Groups.Values)
                    if (g.NoHedge) groups.Add(new KeyValuePair<string, List<string>>(g.Name, state.Members.Where(kv => kv.Value == g.Id).Select(kv => kv.Key).ToList()));
            }
            List<string[]> said = new List<string[]>();
            foreach (KeyValuePair<string, List<string>> grp in groups)
                foreach (string name in grp.Value)
                {
                    Account a = Find(name);
                    if (a == null || !Up(a)) continue;
                    List<ChartBridgeOrders.GroupLeftCandidate> cands;
                    try { cands = ChartBridgeOrders.GroupLeftCandidates(a); } catch (Exception) { continue; }
                    bool first;
                    lock (Mem) first = LeftLooked.Add(a.Name);   // re-review 2 (item 3): the after-start look, per account, once it is connected
                    string others = null;
                    foreach (ChartBridgeOrders.GroupLeftCandidate c in cands)
                    {
                        Order o = c.O;
                        bool buy = ChartBridgeOrders.GroupIsBuy(o);
                        string skey = a.Name + "|" + o.Instrument.FullName;
                        if (c.Listed != 0 && Math.Sign(c.Listed) == Math.Sign(c.Effective))
                        {
                            lock (Mem)
                            {
                                PosSide[skey] = Math.Sign(c.Listed);
                                FlatSince.Remove(skey);
                                if (Math.Sign(c.Listed) == (buy ? -1 : 1))
                                {
                                    ExitOf[o] = Math.Sign(c.Listed);   // an exit of the position held now
                                    int h, now = Math.Min(Math.Abs(c.Listed), Math.Abs(c.Effective));
                                    ExitHeld[o] = ExitHeld.TryGetValue(o, out h) ? Math.Max(h, now) : now;
                                }
                            }
                            continue;
                        }
                        if (c.Listed != 0 || c.Effective != 0) { lock (Mem) FlatSince.Remove(skey); continue; }   // not flat by both readings: nothing is cancelled
                        // re-review 3: flat and steady for LeftSettleMs first (a fill on its way never makes a live order look left behind)
                        double t0, tn = NowMs();
                        bool settled;
                        lock (Mem) { if (!FlatSince.TryGetValue(skey, out t0)) { FlatSince[skey] = t0 = tn; } settled = tn - t0 >= LeftSettleMs; }
                        int side, closed;
                        bool marked, done;
                        int heldWas;
                        lock (Mem) { marked = ExitOf.TryGetValue(o, out side); done = LeftCancelled.Contains(o); if (!PosSide.TryGetValue(skey, out closed)) closed = side; if (!ExitHeld.TryGetValue(o, out heldWas)) heldWas = 0; }
                        if (done) continue;
                        // re-review 4: a marked leftover with no fill of its own is cancelled at once (a typed stop may trigger within
                        // moments); the settle is only for a marked order with fills of its own (another part fill may follow) and for the
                        // unmarked after-start look
                        if (!settled && (!marked || o.Filled > 0)) continue;
                        // re-review 3 (coordinator, Anthony's intent): a marked order whose own fills took the position through flat is a
                        // reversal's entry, not a leftover: judged as the after-start look is (cancelled only when the group's other members
                        // hold its other side, or the group is mixed)
                        bool reversal = marked && o.Filled > 0 && heldWas > 0 && o.Filled >= heldWas;
                        string why = null;
                        if (reversal)
                        {
                            if (others == null) { List<string> rest = grp.Value.Where(x => !x.Equals(name, StringComparison.OrdinalIgnoreCase)).ToList(); others = SideOf(Holdings(rest)) ?? ""; }
                            if ((others == "long" && !buy) || (others == "short" && buy) || others == "mixed")
                                why = a.Name + " went through flat on " + MasterName(o) + ": cancelled the rest of the " + OrderWords(o) + " (" + grp.Key + " is " + (others == "mixed" ? "long and short" : others) + "), so it cannot open a " + (buy ? "long" : "short");
                        }
                        else if (marked) why = a.Name + " went flat on " + MasterName(o) + ": cancelled the " + OrderWords(o) + " left from the " + (closed > 0 ? "long" : "short") + ", so it cannot open a " + (buy ? "long" : "short");
                        else if (first)
                        {
                            if (others == null) { List<string> rest = grp.Value.Where(x => !x.Equals(name, StringComparison.OrdinalIgnoreCase)).ToList(); others = SideOf(Holdings(rest)) ?? ""; }
                            if ((others == "long" && !buy) || (others == "short" && buy) || others == "mixed")
                                why = a.Name + " is flat on " + MasterName(o) + ": cancelled the " + OrderWords(o) + " left from before ChartBridge started (" + grp.Key + " is " + (others == "mixed" ? "long and short" : others) + "), so it cannot open a " + (buy ? "long" : "short");
                        }
                        if (why == null) continue;
                        lock (Mem) LeftCancelled.Add(o);
                        string err = ChartBridgeOrders.GroupCancelLeftover(a, o);
                        said.Add(new[] { err == null ? "warn" : "error", err == null ? why : why.Replace(": cancelled the ", ": could not cancel the ") + " (" + err + "); cancel it in NinjaTrader" });
                    }
                }
            lock (Mem) foreach (Order o in ExitOf.Keys.Where(x => !ChartBridgeOrders.AgentMayFillState(x.OrderState)).ToList()) { ExitOf.Remove(o); ExitHeld.Remove(o); LeftCancelled.Remove(o); }
            foreach (string[] s in said) { ChartBridgeServer.Log((s[0] == "error" ? "ALERT: " : "NOTE: ") + s[1]); ChartBridgeServer.SendToTraders(StatusJson(s[0], s[1])); }
        }

        private static string MasterName(Order o) { return o.Instrument != null && o.Instrument.MasterInstrument != null ? o.Instrument.MasterInstrument.Name : o.Instrument != null ? o.Instrument.FullName : "?"; }
        private static string OrderWords(Order o)
        {
            string kind = o.OrderType == OrderType.Limit ? "limit" : o.OrderType == OrderType.StopMarket ? "stop" : o.OrderType == OrderType.StopLimit ? "stop limit" : o.OrderType == OrderType.MIT ? "MIT" : "market";
            return (ChartBridgeOrders.GroupIsBuy(o) ? "buy " : "sell ") + kind + " " + Math.Max(0, o.Quantity - o.Filled);
        }

        // ---------------------------------------------------------- the one-direction check (G3 a)
        // Null when this entry may go, else the refusal. Asked under PlaceLock (PlaceOrderLocked, the copier's Eligible); the agent's
        // plan check 10b asks it without (advisory). wantsLegs: a stop or a target asked with it; strategy: an Order Strategy.
        public static string EntryCheck(string source, Account a, string root, bool isBuy, int qty, bool wantsLegs, bool strategy)
        {
            if (a == null || a.Name == null) return null;
            // Review of #48 (items 1 and 2): a true exit of the account's own position passes first, whatever else holds (an
            // unreadable groups.txt included): no stop, target or strategy, the other side of its position by both readings, and
            // its contracts plus the exits already working on that side at most the position. Everything else is an entry.
            Instrument inst = root != null ? ChartBridgeServer.InstrumentFor(root) : null;
            bool exit = false, opposite = false;
            try
            {
                if (!wantsLegs && !strategy && inst != null) { exit = ChartBridgeOrders.GroupExitOf(a, inst, isBuy, qty); opposite = !exit && ChartBridgeOrders.GroupOpposite(a, inst, isBuy); }
            }
            catch (Exception) { exit = false; }
            if (exit) return null;
            EnsureLoaded();
            Group g;
            List<string> members;
            lock (Mem)
            {
                // 0.6.6 (Anthony's ruling): his own single-account entry goes (its group, and so one direction, cannot be known); every
                // other source stays refused. A group entry never reaches this (GroupPlan refuses it first, with a banner).
                // 2026-10-21 (Anthony): the bot's, the agents' and the copier's run on the last good copy (in `state`); with none, they wait
                if (readError != null && source == "page") return null;
                if (readError != null && lastGoodFrom == null) return ReadFailedNow();
                string id;
                if (!state.Members.TryGetValue(a.Name, out id) || !state.Groups.TryGetValue(id, out g)) return null;
                g = g.Clone();
                members = state.Members.Where(kv => kv.Value == id).Select(kv => kv.Key).ToList();
            }
            if (!g.NoHedge) return null;
            try
            {
                List<ChartBridgeOrders.GroupHolding> held = Holdings(members);
                bool longs = held.Any(h => h.Side > 0), shorts = held.Any(h => h.Side < 0);
                string tail = "; prop firms ban hedged accounts. Exits and flattens still work." + (opposite ? " With the exits already working this order could take " + a.Name + " past flat: use Flatten, or cancel the working exits first." : "");
                if (longs && shorts)
                    return "Group " + g.Name + " is long and short (" + HolderText(held) + "): no new entry on either side until it is one direction" + tail;
                if (isBuy && shorts) return "Group " + g.Name + " is short (" + HolderText(held) + "): a buy on " + a.Name + " would hedge the group" + tail;
                if (!isBuy && longs) return "Group " + g.Name + " is long (" + HolderText(held) + "): a sell on " + a.Name + " would hedge the group" + tail;
                return null;
            }
            catch (Exception ex) { return "ChartBridge could not read group " + g.Name + "'s positions and orders (" + ex.Message + "): the entry is refused"; }
        }

        private static List<ChartBridgeOrders.GroupHolding> Holdings(List<string> members)
        {
            List<ChartBridgeOrders.GroupHolding> held = new List<ChartBridgeOrders.GroupHolding>();
            foreach (string n in members.OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            {
                Account m = Find(n);
                if (m != null) held.AddRange(ChartBridgeOrders.GroupHoldings(m));
            }
            return held;
        }

        private static string HolderText(List<ChartBridgeOrders.GroupHolding> held)
        {
            List<string> parts = held.Select(h => h.What == "position"
                ? h.Account + " " + (h.Side > 0 ? "+" : "-") + h.Qty + " " + h.Root
                : h.Account + " " + (h.Side > 0 ? "buy " : "sell ") + h.Kind + " " + h.Qty + " " + h.Root + " working").Distinct().ToList();
            if (parts.Count > 6) return string.Join("; ", parts.Take(6)) + "; and " + (parts.Count - 6) + " more";
            return string.Join("; ", parts);
        }

        private static string SideOf(List<ChartBridgeOrders.GroupHolding> held)
        {
            bool longs = held.Any(h => h.Side > 0), shorts = held.Any(h => h.Side < 0);
            return longs && shorts ? "mixed" : longs ? "long" : shorts ? "short" : null;
        }

        private static Account Find(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            lock (Account.All) foreach (Account a in Account.All) if (a.Name != null && a.Name.Equals(name, StringComparison.OrdinalIgnoreCase)) return a;
            return null;
        }

        // ---------------------------------------------------------- the groups message
        private static string Num(double? v) { return v.HasValue ? CbJson.Num(Math.Round(v.Value, 2)) : "null"; }
        private static string None0(double v) { return v > 0 ? CbJson.Num(Math.Round(v, 2)) : "null"; }
        private static string Zero0(double v) { return v > 0 ? CbJson.Num(Math.Round(v, 2)) : "0"; }   // accountState.rules: 0 for none (Bot-Lab tells "no such rule" from "missing")

        public static string GroupsJson()
        {
            EnsureLoaded();
            List<Group> groups;
            Dictionary<string, List<string>> members = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            string err;
            HashSet<string> own, bench;
            lock (Mem)
            {
                err = readError;
                own = new HashSet<string>(state.Own.Keys, StringComparer.OrdinalIgnoreCase);
                bench = new HashSet<string>(state.Benched, StringComparer.OrdinalIgnoreCase);
                groups = state.Groups.Values.Select(x => x.Clone()).OrderBy(x => int.Parse(x.Id.Substring(1), CultureInfo.InvariantCulture)).ToList();
                foreach (Group g in groups) members[g.Id] = state.Members.Where(kv => kv.Value == g.Id).Select(kv => kv.Key).OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToList();
            }
            StringBuilder b = new StringBuilder("{\"type\":\"groups\",\"list\":[");
            List<string[]> sides = new List<string[]>();
            for (int i = 0; i < groups.Count; i++)
            {
                Group g = groups[i];
                List<ChartBridgeOrders.GroupHolding> held;
                try { held = Holdings(members[g.Id]); } catch (Exception) { held = new List<ChartBridgeOrders.GroupHolding>(); }
                string side = SideOf(held);
                sides.Add(new[] { g.Id, g.Name, side ?? "", g.NoHedge ? "on" : "off", HolderText(held) });
                if (i > 0) b.Append(',');
                b.Append("{\"id\":").Append(CbJson.Str(g.Id)).Append(",\"name\":").Append(CbJson.Str(g.Name)).Append(",\"noHedge\":").Append(g.NoHedge ? "true" : "false")
                 .Append(",\"dailyLoss\":").Append(None0(g.DailyLoss)).Append(",\"drawdown\":").Append(None0(g.Drawdown)).Append(",\"drawdownType\":").Append(g.Type == null ? "null" : CbJson.Str(g.Type))
                 .Append(",\"target\":").Append(None0(g.Target)).Append(",\"size\":").Append(None0(g.Size)).Append(",\"lockAt\":").Append(None0(g.LockAt))
                 .Append(",\"consistency\":").Append(None0(g.Consistency))
                 .Append(",\"accountType\":").Append(g.AccountType == null ? "null" : CbJson.Str(g.AccountType)).Append(",\"hero\":").Append(g.Hero == null ? "null" : CbJson.Str(g.Hero))
                 .Append(",\"members\":[").Append(string.Join(",", members[g.Id].Select(x => CbJson.Str(x)))).Append("]")
                 .Append(",\"side\":").Append(side == null ? "null" : CbJson.Str(side)).Append(",\"holders\":[");
                for (int k = 0; k < held.Count; k++)
                {
                    ChartBridgeOrders.GroupHolding h = held[k];
                    if (k > 0) b.Append(',');
                    b.Append("{\"account\":").Append(CbJson.Str(h.Account)).Append(",\"root\":").Append(CbJson.Str(h.Root)).Append(",\"side\":").Append(h.Side > 0 ? "\"long\"" : "\"short\"")
                     .Append(",\"what\":").Append(CbJson.Str(h.What)).Append(",\"qty\":").Append(h.Qty.ToString(CultureInfo.InvariantCulture)).Append('}');
                }
                b.Append("]");
                b.Append(",\"riskPct\":").Append(None0(g.RiskPct))   // 0.6.5: the risk percent of each member's max loss, null off
                 .Append(",\"ownRules\":[").Append(string.Join(",", members[g.Id].Where(x => own.Contains(x)).Select(x => CbJson.Str(x)))).Append("]")   // 0.6.5: the members with rules of their own
                 .Append(",\"tradeOut\":[").Append(string.Join(",", members[g.Id].Select(x => new[] { x, TradeOutWhy(x) }).Where(x => x[1] != null).Select(x => "{\"account\":" + CbJson.Str(x[0]) + ",\"why\":" + CbJson.Str(x[1]) + "}"))).Append("]")   // 0.6.5 (review 4): the members a group entry leaves out
                 .Append(",\"benched\":[").Append(string.Join(",", members[g.Id].Where(x => bench.Contains(x)).Select(x => CbJson.Str(x)))).Append("]}");   // 0.6.7: the members on the bench (members still)
            }
            b.Append("],\"error\":").Append(err == null ? "null" : CbJson.Str(ReadFailedNow() + " (" + err + ")")).Append('}');
            NoteSides(sides);
            return b.ToString();
        }

        // A group with No hedging on that turns long and short by itself (an order typed into NinjaTrader cannot be refused):
        // one status error to the pages when it turns mixed, one info when it is one direction again.
        private static void NoteSides(List<string[]> sides)
        {
            List<string> errors = new List<string>(), infos = new List<string>();
            lock (Mem)
            {
                HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (string[] s in sides)
                {
                    seen.Add(s[0]);
                    string was;
                    LastSide.TryGetValue(s[0], out was);
                    bool mixed = s[2] == "mixed" && s[3] == "on", wasMixed = was == "mixed";
                    if (mixed && !wasMixed) errors.Add("Group " + s[1] + " is now long and short (" + s[4] + "): no new entries on either side until it is one direction; close one side in NinjaTrader");
                    else if (!mixed && wasMixed) infos.Add("Group " + s[1] + " is one direction again" + (s[2].Length > 0 ? " (" + s[2] + ")" : " (flat)"));
                    LastSide[s[0]] = mixed ? "mixed" : s[2];
                }
                foreach (string k in LastSide.Keys.Where(k => !seen.Contains(k)).ToList()) LastSide.Remove(k);
            }
            foreach (string e in errors) Alarm(e);
            foreach (string i in infos) { ChartBridgeServer.Log("NOTE: " + i); ChartBridgeServer.SendToTraders(StatusJson("info", i)); }
        }

        private static string TradeOutWhy(string name) { try { return ChartBridgeOrders.GroupTakenWhy(name); } catch (Exception) { return null; } }

        // To every v3 page on ChartBridge's own origin, signed in or not (as accounts). Unchanged text is not sent again unless forced.
        public static void SendGroups(bool force)
        {
            bool any = false;
            foreach (ChartBridgeClient c in ChartBridgeServer.AllClients()) if (ChartBridgeV3.IsV3(c) && ChartBridgeOrders.OriginAllowed(c.Origin)) { any = true; break; }
            string json = GroupsJson();   // the side notes run whether or not a page is there
            if (!any) return;
            lock (Mem) { if (!force && json == lastGroupsJson) return; lastGroupsJson = json; }
            foreach (ChartBridgeClient c in ChartBridgeServer.AllClients())
                if (ChartBridgeV3.IsV3(c) && ChartBridgeOrders.OriginAllowed(c.Origin)) c.Send(json);
        }

        // A page that just said client v3: the groups now.
        public static void OnClient(ChartBridgeClient c)
        {
            if (ChartBridgeOrders.OriginAllowed(c.Origin)) c.Send(GroupsJson());
        }

        // A page that signs in: the groups.txt alarm, if there is one.
        public static void SignedIn(ChartBridgeClient c)
        {
            EnsureLoaded();
            string err;
            lock (Mem) err = readError;
            if (err != null) c.Send(StatusJson("error", ReadFailedNow() + " (" + err + ")"));
        }

        // ---------------------------------------------------------- the account numbers (item 5)
        public sealed class Numbers
        {
            public string Name, Kind, GroupId, GroupName, Side, Session;
            public Group G;
            public Rules R;      // 0.6.5: the member's rules (its own, or its group's); 0.6.6: an account in no group with its own rules too; else null
            public bool MySet;   // a personal line was ever saved (My floor or My daily, 0 included): rules are Anthony's, else null
            public double? MyFloor, MyDaily, Balance, Unrealized, Realized, Pnl, Floor, RoomFloor, RoomDaily, TargetLeft;
            public double? NtRoomFloor;   // 0.6.6: NinjaTrader's own trailing figure, shown beside the computed room (never in place of it)
            public readonly Dictionary<string, string> Src = new Dictionary<string, string>(), Why = new Dictionary<string, string>();
            public void Set(string key, double? v, string src, string why) { if (v.HasValue) Src[key] = src; else Why[key] = why ?? "not known"; }
        }
        public static readonly string[] NumberKeys = { "balance", "pnlToday", "realizedToday", "unrealized", "floor", "roomFloor", "roomDaily", "targetLeft" };

        // The numbers of one account (a: NinjaTrader's, null when it does not list it). withSide: the group's side too (NinjaTrader's
        // collections of every member are read).
        public static Numbers Read(string name, Account a, bool withSide)
        {
            EnsureLoaded();
            Numbers n = new Numbers { Name = name, Session = SessionNow() };
            Group g = null;
            double[] mine = null;
            Mark mark = null;
            string marksErr, groupsErr;
            List<string> members = null;
            lock (Mem)
            {
                groupsErr = readError != null && lastGoodFrom == null ? readError : null;   // 2026-10-21: the rooms from the last good copy when there is one
                marksErr = marksError;
                string id;
                if (name != null && state.Members.TryGetValue(name, out id) && state.Groups.TryGetValue(id, out g))
                {
                    n.R = state.RulesOf(name, g);   // 0.6.5
                    g = g.Clone();
                    if (withSide) members = state.Members.Where(kv => kv.Value == id).Select(kv => kv.Key).ToList();
                }
                else if (name != null) { Rules own; if (state.Own.TryGetValue(name, out own)) n.R = own.Clone(); }   // 0.6.6: the firm's rules on an account in no group
                if (name != null && state.Personal.TryGetValue(name, out mine)) mine = (double[])mine.Clone();
                Mark mk;
                if (name != null && Marks.TryGetValue(name, out mk)) mark = mk.Clone();
            }
            n.G = g;
            n.Kind = g != null ? "prop" : "personal";
            n.GroupId = g != null ? g.Id : null; n.GroupName = g != null ? g.Name : null;
            n.MyFloor = mine != null && mine[0] > 0 ? mine[0] : (double?)null;
            n.MyDaily = mine != null && mine[1] > 0 ? mine[1] : (double?)null;
            n.MySet = mine != null;
            if (members != null) { try { n.Side = SideOf(Holdings(members)); } catch (Exception) { n.Side = null; } }
            bool up = Up(a);
            string down = a == null ? "the account is not in NinjaTrader now" : "the account is not connected";
            n.Balance = up ? Item(a, AccountItem.CashValue) : null;
            n.Unrealized = up ? Item(a, AccountItem.UnrealizedProfitLoss) : null;
            double? ntReal = up ? Item(a, AccountItem.RealizedProfitLoss) : null;
            n.Set("balance", n.Balance, "ninjatrader", up ? "NinjaTrader gives no balance for this account" : down);
            n.Set("unrealized", n.Unrealized, "ninjatrader", up ? "NinjaTrader gives no open P&L for this account" : down);
            string realSrc = null, realWhy = null;
            if (n.Balance.HasValue && marksErr == null && mark != null && mark.DayStart.HasValue && mark.Session == n.Session)
            {
                double comp = n.Balance.Value - mark.DayStart.Value;
                // review of #48 (item 3): a day start read more than 2 minutes after the session's 18:00 ET start (ChartBridge started
                // mid-session) can miss losses before it: the smaller of it and NinjaTrader's realized, which only understates the room
                bool late = !mark.DayStartAt.HasValue || mark.DayStartAt.Value - SessionStartMs(n.Session) > LateDayStartMs;
                if (!late) { n.Realized = comp; realSrc = "computed"; }
                else if (ntReal.HasValue) { n.Realized = Math.Min(comp, ntReal.Value); realSrc = ntReal.Value < comp ? "ninjatrader" : "computed"; }
                else realWhy = "ChartBridge started mid-session (its first reading came after 18:02 ET) and NinjaTrader gives no realized P&L: today's P&L is not known";
            }
            else if (ntReal.HasValue) { n.Realized = ntReal; realSrc = "ninjatrader"; realWhy = null; }
            else realWhy = up ? "NinjaTrader gives no realized P&L for this account" : down;
            n.Set("realizedToday", n.Realized, realSrc, realWhy);
            n.Pnl = n.Realized.HasValue && n.Unrealized.HasValue ? n.Realized.Value + n.Unrealized.Value : (double?)null;
            n.Set("pnlToday", n.Pnl, realSrc, n.Realized.HasValue ? "NinjaTrader gives no open P&L for this account" : realWhy);
            double? equity = n.Balance.HasValue && n.Unrealized.HasValue ? n.Balance.Value + n.Unrealized.Value : (double?)null;
            string eqWhy = n.Balance.HasValue ? "NinjaTrader gives no open P&L for this account" : up ? "NinjaTrader gives no balance for this account" : down;
            string ntWhy;
            double? ntRoom = up ? ChartBridgeAccounts.RoomDrawdown(a, out ntWhy) : null;
            if (groupsErr != null)
            {
                string w = ReadFailedNow();
                n.Set("floor", null, null, w); n.Set("roomFloor", null, null, w); n.Set("roomDaily", null, null, w); n.Set("targetLeft", null, null, w);
                return n;
            }
            if (g != null && n.R == null)
            {
                // 0.6.7: a member with no rules of its own in a group with none (made on the Multi-Account panel): nothing to work from
                string w = n.Name + " has no rules of its own and group " + g.Name + " has none: set its account type on The Desk and apply it (its Rules on the Accounts tab)";
                n.Set("floor", null, null, w); SetRoomFloor(n, ntRoom, equity, w); n.Set("roomDaily", null, null, w); n.Set("targetLeft", null, null, w);
            }
            else if (g != null || n.R != null)
            {
                // 0.6.5: every number from the member's own rules (its own size, drawdown and type, lock, daily loss and target),
                // or its group's when it has none of its own (as 0.6.4); 0.6.6: an account in no group with its own rules too
                Rules r = n.R;
                string whose = g == null ? n.Name + "'s rules" : r.Own ? n.Name + "'s rules in " + g.Name : "group " + g.Name;
                string again = g != null ? "put it in " + g.Name + " again and give" : "give";
                string floorWhy = null;
                bool missedHigh = false;
                if (r.Type == "static") n.Floor = r.Size - r.Drawdown;
                else if (marksErr != null) floorWhy = "account-marks.txt could not be read (" + marksErr + ")";
                else
                {
                    double? peak = mark == null ? null : r.Type == "eod" ? mark.PeakEod : mark.PeakIntraday;
                    string gone = mark == null ? null : r.Type == "eod" ? mark.EodMissed : mark.IntradayMissed;
                    if (gone != null) { floorWhy = r.Type == "eod" ? "ChartBridge was not running at the close of " + gone + ": give the minimum balance from the firm's dashboard (the account's settings), or " + again + " the highest close"
                                                                  : "ChartBridge was not watching on " + gone + " while the account held a position or traded, so its intraday high may be missed: give the minimum balance from the firm's dashboard (the account's settings), or " + again + " the highest balance"; missedHigh = true; }
                    else if (!peak.HasValue) floorWhy = "no " + (r.Type == "eod" ? "end-of-day" : "intraday") + " high is known for this account: give the minimum balance from the firm's dashboard (the account's settings)";
                    else
                    {
                        double f = Math.Max(peak.Value, r.Size) - r.Drawdown;
                        if (r.LockAt > 0) f = Math.Min(f, r.LockAt);
                        n.Floor = f;
                    }
                }
                n.Set("floor", n.Floor, "computed", floorWhy);
                // 0.6.3 (audit C2): never a room from a high that may be too low; review LOW 8: NinjaTrader's own trailing figure when it gives one
                if (missedHigh && ntRoom.HasValue) { n.RoomFloor = ntRoom; n.NtRoomFloor = ntRoom; n.Set("roomFloor", ntRoom, "ninjatrader", null); }
                else if (missedHigh) n.Set("roomFloor", null, null, floorWhy);
                else SetRoomFloor(n, ntRoom, equity, n.Floor.HasValue ? eqWhy : floorWhy);
                if (r.DailyLoss > 0) { n.RoomDaily = n.Pnl.HasValue ? r.DailyLoss + n.Pnl.Value : (double?)null; n.Set("roomDaily", n.RoomDaily, "computed", n.Why.ContainsKey("pnlToday") ? n.Why["pnlToday"] : null); }
                else n.Set("roomDaily", null, null, whose + (r.Own ? " have" : " has") + " no daily loss limit");
                if (r.Target > 0) { n.TargetLeft = n.Balance.HasValue ? r.Size + r.Target - n.Balance.Value : (double?)null; n.Set("targetLeft", n.TargetLeft, "computed", up ? "NinjaTrader gives no balance for this account" : down); }
                else n.Set("targetLeft", null, null, whose + (r.Own ? " have" : " has") + " no profit target");
            }
            else
            {
                n.Floor = n.MyFloor;
                string floorWhy = "no group and no floor of its own (the Accounts tab)";
                n.Set("floor", n.Floor, "settings", floorWhy);
                SetRoomFloor(n, ntRoom, equity, n.Floor.HasValue ? eqWhy : floorWhy);
                if (n.MyDaily.HasValue) { n.RoomDaily = n.Pnl.HasValue ? n.MyDaily.Value + n.Pnl.Value : (double?)null; n.Set("roomDaily", n.RoomDaily, "computed", n.Why.ContainsKey("pnlToday") ? n.Why["pnlToday"] : null); }
                else n.Set("roomDaily", null, null, "no group and no daily limit of its own (the Accounts tab)");
                n.Set("targetLeft", null, null, "a personal account has no profit target");
            }
            return n;
        }

        public const double LateDayStartMs = 120000;   // review of #48: a day start read more than 2 minutes after 18:00 ET is late
        // 18:00 ET of the evening before a session date (the session's start), UTC ms.
        private static double SessionStartMs(string session)
        {
            DateTime d = DateTime.ParseExact(session, "yyyy-MM-dd", CultureInfo.InvariantCulture).AddDays(-1).AddHours(18);
            DateTime utc = TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(d, DateTimeKind.Unspecified), ChartBridgeTime.Eastern);
            return (utc - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }

        // 0.6.6 (Anthony 2026-10-20: "the floor and thus the % used for certain accounts is still wrong"): the room computed from
        // the firm's rules (the lock included) is the room; NinjaTrader's own trailing figure (the broker's, which never locks) is
        // used only when nothing is computed, and is always sent beside it (roomFloorNt) so the page can flag a difference.
        // Was (review of #48, item 4): the smaller of the two, so NinjaTrader's unlocked figure won over a locked floor.
        public const double FloorCheckDollars = 25;
        private static void SetRoomFloor(Numbers n, double? ntRoom, double? equity, string why)
        {
            double? comp = n.Floor.HasValue && equity.HasValue ? equity.Value - n.Floor.Value : (double?)null;
            n.NtRoomFloor = ntRoom;
            if (comp.HasValue) { n.RoomFloor = comp; n.Set("roomFloor", comp, "computed", null); }
            else if (ntRoom.HasValue) { n.RoomFloor = ntRoom; n.Set("roomFloor", n.RoomFloor, "ninjatrader", null); }
            else { n.RoomFloor = null; n.Set("roomFloor", null, null, why); }
        }

        private static double? Get(Numbers n, string key)
        {
            switch (key)
            {
                case "balance": return n.Balance;
                case "pnlToday": return n.Pnl;
                case "realizedToday": return n.Realized;
                case "unrealized": return n.Unrealized;
                case "floor": return n.Floor;
                case "roomFloor": return n.RoomFloor;
                case "roomDaily": return n.RoomDaily;
                default: return n.TargetLeft;
            }
        }

        private static void SrcWhy(StringBuilder b, Numbers n, string[] keys)
        {
            b.Append(",\"src\":{");
            bool first = true;
            foreach (string k in keys) { string s; if (!n.Src.TryGetValue(k, out s)) continue; b.Append(first ? "" : ",").Append(CbJson.Str(k)).Append(':').Append(CbJson.Str(s)); first = false; }
            b.Append("},\"why\":{");
            first = true;
            foreach (string k in keys) { string w; if (!n.Why.TryGetValue(k, out w)) continue; b.Append(first ? "" : ",").Append(CbJson.Str(k)).Append(':').Append(CbJson.Str(w)); first = false; }
            b.Append('}');
        }

        public static readonly string[] PageKeys = { "floor", "roomFloor", "roomDaily", "targetLeft" };

        // The fields the accounts message adds for one account (ChartBridgeAccounts.AccountJson): group, myFloor, myDailyLoss,
        // floor, roomFloor, roomDaily, targetLeft, src and why. pnlToday and the rest stay as they were.
        public static void AppendAccountFields(StringBuilder b, string name, Account a)
        {
            Numbers n;
            try { n = Read(name, a, false); }
            catch (Exception ex) { ChartBridgeServer.Log("groups: the numbers of " + name + " could not be read (" + ex.Message + ")"); return; }
            b.Append(",\"group\":").Append(n.GroupId == null ? "null" : CbJson.Str(n.GroupId))
             .Append(",\"myFloor\":").Append(Num(n.MyFloor)).Append(",\"myDailyLoss\":").Append(Num(n.MyDaily)).Append(",\"myLimitsSet\":").Append(n.MySet ? "true" : "false");
            foreach (string k in PageKeys) b.Append(",\"").Append(k).Append("\":").Append(Num(Get(n, k)));
            b.Append(",\"roomFloorNt\":").Append(Num(n.NtRoomFloor));
            string copy = FromCopy();   // 2026-10-21 (review of b4bc612): floors and rooms from groups.txt.good say so (the page shows it)
            if (copy != null) b.Append(",\"fromCopy\":").Append(CbJson.Str(copy));   // 0.6.6: NinjaTrader's own figure, beside the room (the page flags a difference)
            SrcWhy(b, n, PageKeys);
            b.Append(",\"rules\":");   // 0.6.5: a member's rules (own true: its own; false: its group's), null in no group; 0.6.6: an account in no group with its own rules
            if (n.R == null) b.Append("null"); else RulesJson(b, n.R, true);
        }

        // 0.6.5: a member's rules as the accounts message carries them (null for none, as the groups message)
        private static void RulesJson(StringBuilder b, Rules r, bool withOwn)
        {
            b.Append("{\"size\":").Append(None0(r.Size)).Append(",\"dailyLoss\":").Append(None0(r.DailyLoss)).Append(",\"drawdown\":").Append(None0(r.Drawdown))
             .Append(",\"drawdownType\":").Append(CbJson.Str(r.Type)).Append(",\"lockAt\":").Append(None0(r.LockAt)).Append(",\"target\":").Append(None0(r.Target))
             .Append(",\"consistency\":").Append(None0(r.Consistency)).Append(",\"maxMinis\":").Append(r.MaxMinis > 0 ? r.MaxMinis.ToString(CultureInfo.InvariantCulture) : "null")
             .Append(",\"maxMicros\":").Append(r.MaxMicros > 0 ? r.MaxMicros.ToString(CultureInfo.InvariantCulture) : "null").Append(",\"typeId\":").Append(r.TypeId == null ? "null" : CbJson.Str(r.TypeId));
            if (withOwn) b.Append(",\"own\":").Append(r.Own ? "true" : "false");
            b.Append('}');
        }

        // The agent's accountState (PROTOCOL.md): its account's numbers. key: the same text without "at" (sent again only when it
        // changed). account: the agent's account, ChartBridgeBranches.None for None.
        public static string AccountStateJson(string account, out string key)
        {
            StringBuilder b = new StringBuilder("{\"type\":\"accountState\"");
            if (account == null || ChartBridgeBranches.IsNone(account))
            {
                Numbers none = new Numbers { Kind = "none", Session = SessionNow() };
                foreach (string k in NumberKeys) none.Why[k] = "the agent's account is None";
                b.Append(",\"account\":null,\"sim\":false,\"kind\":\"none\",\"group\":null,\"groupId\":null,\"groupSide\":null,\"noHedge\":null,\"accountType\":null,\"rules\":null");   // 0.6.2: accountType null when not prop
                foreach (string k in NumberKeys) b.Append(",\"").Append(k).Append("\":null");
                SrcWhy(b, none, NumberKeys);
                b.Append(",\"session\":").Append(CbJson.Str(none.Session));
            }
            else
            {
                Account a = Find(account);
                Numbers n = Read(account, a, true);
                b.Append(",\"account\":").Append(CbJson.Str(a != null ? a.Name : account)).Append(",\"sim\":").Append(a != null && ChartBridgeAccounts.IsSim(a) ? "true" : "false")
                 .Append(",\"kind\":").Append(CbJson.Str(n.Kind)).Append(",\"group\":").Append(n.GroupName == null ? "null" : CbJson.Str(n.GroupName))
                 .Append(",\"groupId\":").Append(n.GroupId == null ? "null" : CbJson.Str(n.GroupId)).Append(",\"groupSide\":").Append(n.Side == null ? "null" : CbJson.Str(n.Side))
                 .Append(",\"noHedge\":").Append(n.G == null ? "null" : n.G.NoHedge ? "true" : "false")
                 .Append(",\"accountType\":").Append(n.G == null || n.G.AccountType == null ? "null" : CbJson.Str(n.G.AccountType))   // 0.6.2: the group's Type (eval, funded; null not set, or not prop)
                 .Append(",\"rules\":");
                if (n.G != null && n.R == null) b.Append("null");   // 0.6.7: a member with no rules (its group has none either)
                else if (n.G != null)   // 0.6.5: the member's own rules (or its group's), the same seven keys as before
                    b.Append("{\"dailyLoss\":").Append(Zero0(n.R.DailyLoss)).Append(",\"drawdown\":").Append(Zero0(n.R.Drawdown)).Append(",\"drawdownType\":").Append(CbJson.Str(n.R.Type))
                     .Append(",\"target\":").Append(Zero0(n.R.Target)).Append(",\"size\":").Append(Zero0(n.R.Size)).Append(",\"lockAt\":").Append(Zero0(n.R.LockAt))
                     .Append(",\"consistency\":").Append(Zero0(n.R.Consistency))   // CON (a): informational, 0 none
                     .Append(",\"maxMinis\":").Append(n.R.MaxMinis.ToString(CultureInfo.InvariantCulture)).Append(",\"maxMicros\":").Append(n.R.MaxMicros.ToString(CultureInfo.InvariantCulture)).Append('}');   // 0.6.5 (Anthony 2026-10-19): the member's max size, 0 none
                else if (!n.MySet) b.Append("null");   // no limits ever set by Anthony: the agent keeps its model numbers
                else b.Append("{\"floor\":").Append(Zero0(n.MyFloor ?? 0)).Append(",\"dailyLoss\":").Append(Zero0(n.MyDaily ?? 0)).Append('}');   // rules: 0 is none (the firm or the account has no such rule), never null
                foreach (string k in NumberKeys) b.Append(",\"").Append(k).Append("\":").Append(Num(Get(n, k)));
                SrcWhy(b, n, NumberKeys);
                b.Append(",\"session\":").Append(CbJson.Str(n.Session));
            }
            key = b.ToString() + "}";
            return b.Append(",\"at\":").Append(((long)ChartBridgeTime.NowUtcMs()).ToString(CultureInfo.InvariantCulture)).Append('}').ToString();
        }

        // ---------------------------------------------------------- messages from the page
        private static readonly Dictionary<string, string[]> Keys = new Dictionary<string, string[]>
        {
            { "groupSave", new[] { "type", "cid", "group", "name", "noHedge", "dailyLoss", "drawdown", "drawdownType", "target", "size", "lockAt", "consistency", "accountType", "hero", "riskPct" } },
            { "groupDelete", new[] { "type", "cid", "group" } },
            // 0.6.5: joining may carry the account's own rules (all of them, or none: the group's apply)
            { "accountGroup", new[] { "type", "cid", "account", "group", "highClose", "size", "dailyLoss", "drawdown", "drawdownType", "lockAt", "target", "consistency", "maxMinis", "maxMicros", "typeId" } },
            { "memberRules", new[] { "type", "cid", "account", "size", "dailyLoss", "drawdown", "drawdownType", "lockAt", "target", "consistency", "maxMinis", "maxMicros", "typeId" } },
            { "accountLimits", new[] { "type", "cid", "account", "floor", "dailyLoss" } },
            { "firmMinimum", new[] { "type", "cid", "account", "minBalance" } },   // 0.6.6: the firm's minimum balance seeds the floor
            { "memberBench", new[] { "type", "cid", "account", "benched" } },      // 0.6.7: a member to the bench or back
        };

        public static bool Handles(string type) { return type != null && Keys.ContainsKey(type); }

        public static void OnMessage(ChartBridgeClient client, string type, string text)
        {
            string cid = null;
            try
            {
                string why = ChartBridgeV3.Gate(client);
                Dictionary<string, string> m = null;
                if (why == null) m = ChartBridgeV3.Flat(text, type, Keys[type], out why);
                if (m != null) cid = ChartBridgeV3.Str(m, "cid");
                if (why == null && m.ContainsKey("cid") && cid == null) why = "cid must be a plain string";
                if (why == null)
                {
                    EnsureLoaded();
                    lock (Mem) if (readError != null) why = ReadFailedText + "; nothing was changed";
                }
                if (why == null) why = type == "groupSave" ? GroupSave(m) : type == "groupDelete" ? GroupDelete(m) : type == "accountGroup" ? AccountGroup(m) : type == "memberRules" ? MemberRules(m) : type == "firmMinimum" ? FirmMinimum(m) :
                                       type == "memberBench" ? MemberBench(m) : AccountLimits(m);
                if (why != null) client.Send(Reject(cid, why));
            }
            catch (Exception ex)
            {
                ChartBridgeServer.Log("groups error: " + ex.Message);
                client.Send(Reject(cid, "ChartBridge error: " + ex.Message));
            }
        }

        // A money field: a plain number of at most 2 decimals, from 0 (zeroOk) or above 0, at most 100,000,000.
        private static string Money(Dictionary<string, string> m, string key, bool zeroOk, out double v)
        {
            v = 0;
            string raw;
            if (!m.TryGetValue(key, out raw)) return key + " is needed";
            if (!MoneyRx.IsMatch(raw)) return key + " must be a plain number of dollars (at most 2 decimals)";
            v = double.Parse(raw, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture);
            if (v > MaxMoney) return key + " must be at most 100,000,000";
            if (!zeroOk && v <= 0) return key + " must be more than 0";
            return null;
        }

        // 0.6.5: a member's rules from a message (accountGroup, memberRules): the same fields and checks as groupSave's, with the max
        // size (whole contracts, 0 or absent none) and The Desk's type id (optional). r null and no error: the message has none.
        public static readonly string[] RuleKeys = { "size", "dailyLoss", "drawdown", "drawdownType", "lockAt", "target", "consistency", "maxMinis", "maxMicros", "typeId" };
        private static string RulesFrom(Dictionary<string, string> m, bool needed, out Rules r)
        {
            r = null;
            if (!RuleKeys.Any(k => m.ContainsKey(k))) return needed ? "size is needed" : null;
            string why, type = ChartBridgeV3.Str(m, "drawdownType");
            double sz, dl, dd, lk, tg, con = 0;
            if ((why = Money(m, "size", false, out sz)) != null || (why = Money(m, "dailyLoss", true, out dl)) != null || (why = Money(m, "drawdown", false, out dd)) != null) return why;
            if (!m.ContainsKey("drawdownType")) return "drawdownType is needed";
            if ((why = Money(m, "lockAt", true, out lk)) != null || (why = Money(m, "target", true, out tg)) != null) return why;
            if (m.ContainsKey("consistency") && m["consistency"] != "0" && !FilePercent(m["consistency"], out con)) return "consistency must be a percent from 0 (none) to 100, at most 2 decimals";
            int mm = 0, mu = 0;
            foreach (string k in new[] { "maxMinis", "maxMicros" })
            {
                if (!m.ContainsKey(k)) continue;
                int? v = ChartBridgeV3.Whole(m, k);
                if (!v.HasValue || v.Value < 0 || v.Value > MaxSizeMax) return k + " must be a whole number of contracts from 0 (none) to " + MaxSizeMax;
                if (k == "maxMinis") mm = v.Value; else mu = v.Value;
            }
            string tid = null;
            if (m.ContainsKey("typeId")) { tid = ChartBridgeV3.Str(m, "typeId"); if (tid == null || (tid != "-" && !TypeIdRx.IsMatch(tid))) return "typeId must be The Desk's account type id (1 to 120 letters, digits, dots, underscores or hyphens), or - (none)"; if (tid == "-") tid = null; }
            Rules x = new Rules { Own = true, Size = sz, DailyLoss = dl, Drawdown = dd, Type = type, LockAt = lk, Target = tg, Consistency = con, MaxMinis = mm, MaxMicros = mu, TypeId = tid };
            if ((why = RulesProblem(x)) != null) return why;
            r = x;
            return null;
        }

        private static string Save(State next)
        {
            string text = Serialize(next), err = WriteWhole(FilePath, text);
            if (err != null) return "groups.txt could not be saved (" + err + "); nothing was changed";
            WriteGood(text);   // 2026-10-21: the copy the machines fall back on is always the latest save
            lock (Mem) { state = next; onDisk = next; }
            return null;
        }

        // 0.6.7 (review LOW 1): a change whose decision needs the entry locks (a risk percent changed only while the group is flat, a
        // move to or from the bench only while the account is flat). With place true, the decision and the change in memory are made
        // under GroupEntryLock, PlaceLock and SaveLock; PlaceLock and GroupEntryLock are then let go and groups.txt (and its .good copy)
        // is written under SaveLock alone, so an exit (the page's, the copier's, an agent's) never waits on the disk. If the write
        // fails, memory goes back to what groups.txt holds (under all three again, taken in order) and the answer says nothing was
        // changed. With place false: SaveLock alone, the file first and then memory, as Save always did. decide gets a copy of the state
        // to change and answers null (save it), a refusal, or Unchanged (nothing to save).
        private static readonly string Unchanged = new string('=', 1);
        public static Action WriteForHarness;   // the harness only: runs just before ChangeAndSave's write (a slow disk, or a throw for a failed write)
        private static string ChangeAndSave(bool place, Func<State, string> decide)
        {
            bool e = false, p = false, sv = false;
            State next = null, disk = null;
            string err = null;
            try
            {
                if (place) { Monitor.Enter(ChartBridgeOrders.GroupEntryLock, ref e); Monitor.Enter(ChartBridgeOrders.GroupPlaceLock, ref p); }
                Monitor.Enter(SaveLock, ref sv);
                lock (Mem) { next = state.Clone(); disk = onDisk; }
                string why = decide(next);
                if (why != null) return why;
                if (!place) return Save(next);
                string text = Serialize(next);
                lock (Mem) state = next;
                Monitor.Exit(ChartBridgeOrders.GroupPlaceLock); p = false;
                Monitor.Exit(ChartBridgeOrders.GroupEntryLock); e = false;
                Action hook = WriteForHarness;
                if (hook != null) { try { hook(); } catch (Exception ex) { err = ex.Message; } }
                if (err == null) err = WriteWhole(FilePath, text);
                if (err == null)
                {
                    WriteGood(text);
                    lock (Mem) onDisk = next;
                    return null;
                }
            }
            finally
            {
                if (sv) Monitor.Exit(SaveLock);
                if (p) Monitor.Exit(ChartBridgeOrders.GroupPlaceLock);
                if (e) Monitor.Exit(ChartBridgeOrders.GroupEntryLock);
            }
            // the write failed: memory back to the file (a save after this one, if any, wrote its own state whole, so onDisk is the file)
            lock (ChartBridgeOrders.GroupEntryLock)
            lock (ChartBridgeOrders.GroupPlaceLock)
            lock (SaveLock)
            {
                bool later;
                lock (Mem) { later = !ReferenceEquals(onDisk, disk); state = onDisk; }
                return "groups.txt could not be saved (" + err + "); " + (later ? "a save after it wrote groups.txt with this change in it" : "nothing was changed");
            }
        }

        // 0.6.7 (Anthony 2026-10-22): the group's own rules are optional (the Multi-Account panel sends none: absent keeps what the group
        // has, a new group has none); noHedge optional and never false (always on); the risk percent changes only while the group is flat.
        static readonly string[] GroupRuleKeys = { "dailyLoss", "drawdown", "drawdownType", "target", "size", "lockAt", "consistency" };
        private static string GroupSave(Dictionary<string, string> m)
        {
            string id = ChartBridgeV3.Str(m, "group"), name = ChartBridgeV3.Str(m, "name"), type = ChartBridgeV3.Str(m, "drawdownType"), why;
            if (m.ContainsKey("group") && id == null) return "group must be a group id (a plain string), or left out for a new group";
            if ((why = NameProblem(name)) != null) return why;
            if (m.ContainsKey("noHedge"))
            {
                bool? noHedge = ChartBridgeV3.Bool(m, "noHedge");
                if (!noHedge.HasValue) return "noHedge must be true or false";
                if (!noHedge.Value) return "No hedging is always on for every group (ChartBridge 0.6.7): noHedge false is refused";
            }
            bool hasRules = GroupRuleKeys.Any(k => m.ContainsKey(k));
            double dl = 0, dd = 0, tg = 0, sz = 0, lk = 0, con = 0;
            if (hasRules)
            {
                if (type != "eod" && type != "intraday" && type != "static") return "drawdownType must be eod, intraday or static";
                if ((why = Money(m, "dailyLoss", true, out dl)) != null || (why = Money(m, "drawdown", false, out dd)) != null || (why = Money(m, "target", true, out tg)) != null ||
                    (why = Money(m, "size", false, out sz)) != null || (why = Money(m, "lockAt", true, out lk)) != null) return why;
                if (dd >= sz) return "the drawdown must be less than the account size";
                if (lk > 0 && type == "static") return "floor stops at applies to a trailing drawdown only (end of day or intraday); 0 for none";
                // CON (a): optional, 0 or absent none, else more than 0 and at most 100 (2 decimals)
                if (m.ContainsKey("consistency"))
                {
                    string raw = m["consistency"];
                    if (raw != "0" && !FilePercent(raw, out con)) return "consistency must be a percent from 0 (none) to 100, at most 2 decimals";
                }
                if (lk > 0 && lk <= sz - dd) return "floor stops at must be above the starting floor (" + (sz - dd).ToString("0.##", CultureInfo.InvariantCulture) + ")";
            }
            // 0.6.1: optional; absent keeps what the group has (a new group: not set and none), so an older page's save never drops them.
            // The message's own "type" is its kind, so the group's type travels as accountType. Shapes only: ChartBridge does not know heroes
            string atype = null, hero = null;
            bool hasType = m.ContainsKey("accountType"), hasHero = m.ContainsKey("hero");
            if (hasType && !FileType(ChartBridgeV3.Str(m, "accountType"), out atype)) return "accountType must be eval, funded or - (not set)";
            if (hasHero && !FileHero(ChartBridgeV3.Str(m, "hero"), out hero)) return "hero must be a build name of 1 to 64 letters, digits, dots, underscores or hyphens, or - (none)";
            // 0.6.5: optional; absent keeps the group's (a page before 1.33.0 never drops it); 0 off
            double risk = 0;
            bool hasRisk = m.ContainsKey("riskPct");
            if (hasRisk && m["riskPct"] != "0" && !FileRisk(m["riskPct"], out risk)) return "riskPct must be a percent of each member's max loss from 0 (off) to 100, at most 2 decimals";
            string said = null;
            // 0.6.7: a save with riskPct for a group decides under the entry locks (no group entry is sized while its risk percent
            // changes, and it changes only while the group is flat), then writes groups.txt after them (review LOW 1); a name, Type or
            // rules save, or a new group, takes SaveLock alone
            string res = ChangeAndSave(id != null && hasRisk, next =>
            {
                Group g;
                if (id != null) { if (!next.Groups.TryGetValue(id, out g)) return "no group " + id; }
                else g = new Group { Id = "g" + next.Next.ToString(CultureInfo.InvariantCulture) };
                if (next.Groups.Values.Any(x => x.Id != g.Id && string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase))) return "a group named " + name + " is there already";
                // 0.6.7 (Anthony 2026-10-22): the risk percent changes only while the group is flat (no position, no working entry)
                if (id != null && hasRisk && Math.Abs(risk - g.RiskPct) > 1e-9)
                {
                    List<ChartBridgeOrders.GroupHolding> held;
                    try { held = Holdings(next.Members.Where(kv => kv.Value == id).Select(kv => kv.Key).ToList()); }
                    catch (Exception ex) { return "ChartBridge could not read group " + g.Name + "'s positions and orders (" + ex.Message + "): the risk percent was not changed"; }
                    if (held.Count > 0) return "the risk percent changes only while group " + g.Name + " is flat: it holds " + HolderText(held) + "; nothing was changed";
                }
                string was = id != null ? g.Name : null;
                g.Name = name; g.NoHedge = true;
                if (hasRules) { g.DailyLoss = dl; g.Drawdown = dd; g.Type = type; g.Target = tg; g.Size = sz; g.LockAt = lk; g.Consistency = con; }
                if (hasType) g.AccountType = atype;
                if (hasHero) g.Hero = hero;
                if (hasRisk) g.RiskPct = risk;
                if (id == null) { next.Groups[g.Id] = g; next.Next++; }
                said = (id == null ? "group " + g.Id + " made: " : "group " + g.Id + " saved: ") + name + (was != null && was != name ? " (was " + was + ")" : "") + ", " + RulesWords(g);
                return null;
            });
            if (res != null) return res;
            ChartBridgeServer.Log("groups: " + said + " (by the page)");
            Changed();
            return null;
        }

        private static string RulesWords(Group g)
        {
            Func<double, string> d = v => "$" + v.ToString("#,0.##", CultureInfo.InvariantCulture);
            return (g.HasRules ? "size " + d(g.Size) + ", daily loss " + (g.DailyLoss > 0 ? d(g.DailyLoss) : "none") + ", drawdown " + d(g.Drawdown) + " " + g.Type +
                   (g.LockAt > 0 ? " (floor stops at " + d(g.LockAt) + ")" : "") + ", target " + (g.Target > 0 ? d(g.Target) : "none") + ", consistency " + (g.Consistency > 0 ? g.Consistency.ToString("0.##", CultureInfo.InvariantCulture) + "%" : "none") : "no rules of its own (each member's own)") + ", no hedging " + (g.NoHedge ? "on" : "off") +
                   ", type " + (g.AccountType ?? "not set") + ", hero " + (g.Hero ?? "none") + ", risk " + (g.RiskPct > 0 ? g.RiskPct.ToString("0.##", CultureInfo.InvariantCulture) + "% of each member's max loss" : "off");
        }
        private static string MemberWords(Rules r)
        {
            Func<double, string> d = v => "$" + v.ToString("#,0.##", CultureInfo.InvariantCulture);
            return "size " + d(r.Size) + ", daily loss " + (r.DailyLoss > 0 ? d(r.DailyLoss) : "none") + ", drawdown " + d(r.Drawdown) + " " + r.Type + (r.LockAt > 0 ? " (floor stops at " + d(r.LockAt) + ")" : "") +
                   ", target " + (r.Target > 0 ? d(r.Target) : "none") + ", consistency " + (r.Consistency > 0 ? r.Consistency.ToString("0.##", CultureInfo.InvariantCulture) + "%" : "none") +
                   ", max " + (r.MaxMinis > 0 ? r.MaxMinis.ToString(CultureInfo.InvariantCulture) : "-") + " minis / " + (r.MaxMicros > 0 ? r.MaxMicros.ToString(CultureInfo.InvariantCulture) : "-") + " micros" + (r.TypeId != null ? ", type " + r.TypeId : "");
        }

        private static string GroupDelete(Dictionary<string, string> m)
        {
            string id = ChartBridgeV3.Str(m, "group");
            if (id == null) return "groupDelete needs group (a plain string)";
            string name;
            List<string> left;
            lock (SaveLock)
            {
                State next;
                lock (Mem) next = state.Clone();
                Group g;
                if (!next.Groups.TryGetValue(id, out g)) return "no group " + id;
                name = g.Name;
                left = next.Members.Where(kv => kv.Value == id).Select(kv => kv.Key).ToList();
                next.Groups.Remove(id);
                foreach (string a in left) { next.Members.Remove(a); next.Own.Remove(a); next.Benched.Remove(a); }   // 0.6.5: its members' own rules go with it; 0.6.7: the bench too
                string err = Save(next);
                if (err != null) return err;
                try { ChartBridgeAgents.GroupDeleted(id); } catch (Exception ex) { ChartBridgeServer.Log("groups: the stand-downs of group " + id + " not dropped (" + ex.Message + ")"); }   // 0.6.2: under the save, before a later group could take the id
            }
            ForgetHighs(left);
            ChartBridgeServer.Log("groups: group " + id + " (" + name + ") deleted by the page" + (left.Count > 0 ? "; " + string.Join(", ", left) + " now in no group" : ""));
            Changed();
            return null;
        }

        private static void ForgetHighs(IEnumerable<string> accounts)
        {
            lock (Mem) foreach (string a in accounts) { Mark mk; if (Marks.TryGetValue(a, out mk) && (mk.PeakEod.HasValue || mk.PeakIntraday.HasValue || mk.EodMissed != null || mk.IntradayMissed != null)) { mk.PeakEod = null; mk.PeakIntraday = null; mk.EodMissed = null; mk.IntradayMissed = null; marksDirty = true; } }
            SaveMarks(true);
        }

        private static string AccountGroup(Dictionary<string, string> m)
        {
            string name = ChartBridgeV3.Str(m, "account"), id = ChartBridgeV3.Str(m, "group");
            if (name == null) return "accountGroup needs account (a plain string)";
            if (!m.ContainsKey("group") || (id == null && m["group"] != "null")) return "group must be a group id or null (None)";
            double high = 0;
            string why;
            if (m.ContainsKey("highClose"))
            {
                if (id == null) return "highClose goes with joining a group only";
                if ((why = Money(m, "highClose", false, out high)) != null) return why;
            }
            // 0.6.5: the account's own rules, all or none (none: the group's apply, as 0.6.4); with joining a group only
            Rules own;
            if (id == null && RuleKeys.Any(k => m.ContainsKey(k))) return "rules go with joining a group only";
            if ((why = RulesFrom(m, false, out own)) != null) return why;
            if (ChartBridgeOrders.IsNeverTradable(name)) return name + " is never in a group (Backtest and Playback)";
            Account a = Find(name);
            if (a == null && !ChartBridgeAccounts.Listed(name)) return "no account " + name;
            if (a != null) name = a.Name;
            // 0.6.0 (group trading): a group an agent trades takes no account that is the bot's, the copier's leader or a follower, or
            // another agent's (asked before the order lock: it reads the copier's and the bot's memory)
            if (id != null) { string taken = ChartBridgeAgents.JoinRefusal(name, id); if (taken != null) return taken; }
            string said;
            double seed = 0;
            lock (ChartBridgeOrders.GroupPlaceLock)   // no entry passes the check while the membership changes
            lock (SaveLock)
            {
                State next;
                lock (Mem) next = state.Clone();
                string cur;
                next.Members.TryGetValue(name, out cur);
                if (id == cur) return id == null ? null : name + " is in " + next.Groups[id].Name + " already";
                Group g = null;
                if (id != null && !next.Groups.TryGetValue(id, out g)) return "no group " + id;
                // 0.6.7: a group with no rules of its own takes an account only with its own (from its type on The Desk)
                if (g != null && own == null && !g.HasRules) return name + " has no account type: set its type on The Desk first (group " + g.Name + " takes each account's rules from its type)";
                // 0.6.0: again here, under the lock that saves the membership (PlaceLock, then SaveLock; memory only, no file read), so an
                // agent that chose this group, or a copier or bot change, since the first check cannot slip past it
                if (id != null) { string taken = ChartBridgeAgents.JoinRefusal(name, id, false); if (taken != null) return taken; }
                if (g != null && g.NoHedge)
                {
                    List<string> others = next.Members.Where(kv => kv.Value == id).Select(kv => kv.Key).ToList();
                    List<ChartBridgeOrders.GroupHolding> mine = a != null ? ChartBridgeOrders.GroupHoldings(a) : new List<ChartBridgeOrders.GroupHolding>();
                    List<ChartBridgeOrders.GroupHolding> theirs = Holdings(others);
                    string ms = SideOf(mine), ts = SideOf(theirs);
                    if (ms == "mixed") return name + " holds both sides (" + HolderText(mine) + "): it cannot join " + g.Name + " (No hedging) until it is one direction";
                    if (ms != null && ts != null && ms != ts) return name + " is " + ms + " (" + HolderText(mine) + ") and " + g.Name + " is " + ts + " (" + HolderText(theirs) + "): joining would hedge the group; prop firms ban hedged accounts";
                }
                if (id == null) next.Members.Remove(name); else next.Members[name] = id;
                next.Benched.Remove(name);   // 0.6.7: a new membership (or none) starts off the bench
                // 0.6.5: its own rules when the page sent them; none sent (a page before 1.33.0): the group's, so any it had go
                if (own != null) next.Own[name] = own; else next.Own.Remove(name);
                string err = Save(next);
                if (err != null) return err;
                if (g != null)
                {
                    double? bal = Up(a) ? Item(a, AccountItem.CashValue) : null;
                    seed = high > 0 ? high : Math.Max(own != null ? own.Size : g.Size, bal.HasValue && bal.Value > 0 ? bal.Value : 0);   // 0.6.5: its own account size
                }
                said = name + (g != null ? " joined " + g.Name + (own != null ? " with its own rules (" + MemberWords(own) + ")" : " with the group's rules") + " (its highs start at " + seed.ToString("0.00", CultureInfo.InvariantCulture) + (high > 0 ? ", the highest close given" : ", no highest close given: the larger of the account size and its balance") + ")" : " is in no group now") +
                       (cur != null && next.Groups.ContainsKey(cur) ? ", left " + next.Groups[cur].Name : "");
            }
            if (id != null)
            {
                bool flatNow = a == null || IsFlat(a);
                double? balNow = Up(a) ? Item(a, AccountItem.CashValue) : null;
                lock (Mem)
                {
                    if (marksError == null)
                    {
                        Mark mk;
                        if (!Marks.TryGetValue(name, out mk)) Marks[name] = mk = new Mark { Name = name };
                        mk.PeakEod = Math.Round(seed, 2); mk.PeakIntraday = Math.Round(seed, 2); marksDirty = true;
                        mk.EodMissed = null; mk.IntradayMissed = null; mk.CloseSeen = LatestClose(NowEt());   // 0.6.3: the highs given now are the ones known
                        mk.Seen = true; mk.Legacy = false; mk.LastAt = NowMs(); if (balNow.HasValue && balNow.Value > 0) { mk.LastBal = Math.Round(balNow.Value, 2); mk.LastFlat = flatNow; }
                    }
                }
                SaveMarks(true);
            }
            else ForgetHighs(new[] { name });
            ChartBridgeServer.Log("groups: " + said + " (by the page)");
            Changed();
            return null;
        }

        private static string AccountLimits(Dictionary<string, string> m)
        {
            string name = ChartBridgeV3.Str(m, "account"), why;
            if (name == null) return "accountLimits needs account (a plain string)";
            double floor, daily;
            if ((why = Money(m, "floor", true, out floor)) != null || (why = Money(m, "dailyLoss", true, out daily)) != null) return why;
            if (ChartBridgeOrders.IsNeverTradable(name)) return name + " has no limits (Backtest and Playback)";
            Account a = Find(name);
            if (a == null && !ChartBridgeAccounts.Listed(name)) return "no account " + name;
            if (a != null) name = a.Name;
            lock (SaveLock)
            {
                State next;
                lock (Mem) next = state.Clone();
                string gid;
                if (next.Members.TryGetValue(name, out gid)) return name + " is in group " + next.Groups[gid].Name + ": its group's rules apply (put it in None for limits of its own)";
                next.Personal[name] = new[] { floor, daily };   // 0 and 0 too: Anthony set "none", which is not "never set"
                string err = Save(next);
                if (err != null) return err;
            }
            ChartBridgeServer.Log("groups: " + name + "'s own limits: floor " + (floor > 0 ? floor.ToString("0.##", CultureInfo.InvariantCulture) : "none") + ", daily " + (daily > 0 ? daily.ToString("0.##", CultureInfo.InvariantCulture) : "none") + " (by the page)");
            Changed();
            return null;
        }

        // 0.6.5: a member's rules changed later (the Accounts tab's Rules). Its highs stay as they are (they are the account's, not the
        // rules'); a new size or drawdown applies to the floor from now on.
        private static string MemberRules(Dictionary<string, string> m)
        {
            string name = ChartBridgeV3.Str(m, "account"), why;
            if (name == null) return "memberRules needs account (a plain string)";
            Rules r;
            if ((why = RulesFrom(m, true, out r)) != null) return why;
            Account a = Find(name);
            if (a == null && !ChartBridgeAccounts.Listed(name)) return "no account " + name;
            if (a != null) name = a.Name;
            string gname;
            lock (SaveLock)
            {
                State next;
                lock (Mem) next = state.Clone();
                string gid;
                // 0.6.6: an account in no group may hold the firm's rules too (its floor then trails and locks as the firm's does)
                gname = next.Members.TryGetValue(name, out gid) ? next.Groups[gid].Name : null;
                next.Own[name] = r;
                string err = Save(next);
                if (err != null) return err;
            }
            ChartBridgeServer.Log("groups: " + name + "'s own rules" + (gname != null ? " in " + gname : " (in no group)") + ": " + MemberWords(r) + " (by the page)");
            Changed();
            return null;
        }

        // 0.6.6 (Anthony 2026-10-20: the floor "still wrong ... how do we square this, so it stops being an issue"): the minimum
        // balance the firm's dashboard shows seeds the account's highs, so the computed floor equals the firm's from now on:
        // high = minBalance + drawdown (the floor is then min(high - drawdown, lock) = minBalance, a locked floor included).
        // The account needs the firm's rules (a group's, or its own), with a trailing drawdown; a minimum below the starting
        // floor (size - drawdown) or above the lock is refused (the firm never shows one).
        private static string FirmMinimum(Dictionary<string, string> m)
        {
            string name = ChartBridgeV3.Str(m, "account"), why;
            if (name == null) return "firmMinimum needs account (a plain string)";
            double min;
            if ((why = Money(m, "minBalance", false, out min)) != null) return why;
            Account a = Find(name);
            if (a == null && !ChartBridgeAccounts.Listed(name)) return "no account " + name;
            if (a != null) name = a.Name;
            Rules r;
            lock (Mem)
            {
                if (marksError != null) return "account-marks.txt could not be read (" + marksError + "); nothing was changed";
                string gid; Group g;
                if (state.Members.TryGetValue(name, out gid) && state.Groups.TryGetValue(gid, out g)) r = state.RulesOf(name, g);
                else if (!state.Own.TryGetValue(name, out r)) r = null;
                if (r == null) return name + " has no firm rules yet: apply its account type first (the floor comes from its drawdown and lock)";
            }
            if (r.Type == "static") return name + "'s drawdown is static: its floor is fixed at " + (r.Size - r.Drawdown).ToString("0.00", CultureInfo.InvariantCulture) + ", nothing to give";
            if (min < r.Size - r.Drawdown - 0.004) return "the minimum balance " + min.ToString("0.00", CultureInfo.InvariantCulture) + " is below the starting floor (" + (r.Size - r.Drawdown).ToString("0.00", CultureInfo.InvariantCulture) + "): check the firm's dashboard";
            if (r.LockAt > 0 && min > r.LockAt + 0.004) return "the minimum balance " + min.ToString("0.00", CultureInfo.InvariantCulture) + " is above where the floor stops (" + r.LockAt.ToString("0.00", CultureInfo.InvariantCulture) + "): check the firm's dashboard or the account's type";
            double high = Math.Round(min + r.Drawdown, 2);
            bool flatNow = a == null || IsFlat(a);
            double? balNow = Up(a) ? Item(a, AccountItem.CashValue) : null;
            lock (Mem)
            {
                Mark mk;
                if (!Marks.TryGetValue(name, out mk)) Marks[name] = mk = new Mark { Name = name };
                mk.PeakEod = high; mk.PeakIntraday = high; marksDirty = true;
                mk.EodMissed = null; mk.IntradayMissed = null; mk.CloseSeen = LatestClose(NowEt());
                mk.Seen = true; mk.Legacy = false; mk.LastAt = NowMs(); if (balNow.HasValue && balNow.Value > 0) { mk.LastBal = Math.Round(balNow.Value, 2); mk.LastFlat = flatNow; }
            }
            SaveMarks(true);
            ChartBridgeServer.Log("groups: " + name + "'s floor set from the firm's minimum balance " + min.ToString("0.00", CultureInfo.InvariantCulture) + " (its high is now " + high.ToString("0.00", CultureInfo.InvariantCulture) + "; by the page)");
            Changed();
            return null;
        }

        // 0.6.7 (Anthony 2026-10-22: "the ability to quickly swap out accounts in and out of the group while flat"): a member to the
        // bench (benched true) or back (false). It stays a member either way (its rules, highs and firm are kept; nothing is asked
        // again); on the bench it sits out every new group entry (the page's ticket and hotkeys, an agent's group plan), while its exits,
        // stops, cancels and flattens go as always. Refused unless the account is flat (both readings, every instrument) with no
        // working order, so nothing it holds or has working changes side with the move.
        private static string MemberBench(Dictionary<string, string> m)
        {
            string name = ChartBridgeV3.Str(m, "account");
            if (name == null) return "memberBench needs account (a plain string)";
            bool? benched = ChartBridgeV3.Bool(m, "benched");
            if (!benched.HasValue) return "benched must be true (to the bench) or false (back to trade with the group)";
            Account a = Find(name);
            if (a != null) name = a.Name;
            string gname = null;
            // under GroupEntryLock (a group entry from the page is sized and placed whole, before or after the move) and PlaceLock (no
            // other entry passes meanwhile; an agent's seat is checked again under it): the flat check and the move in memory. groups.txt
            // is written after both are let go (review LOW 1), so an exit never waits on the disk
            string res = ChangeAndSave(true, next =>
            {
                string gid, why;
                if (!next.Members.TryGetValue(name, out gid) || !next.Groups.ContainsKey(gid)) return name + " is in no group: only a group's member goes to the bench";
                gname = next.Groups[gid].Name;
                if (next.Benched.Contains(name) == benched.Value) return Unchanged;   // already there: nothing to change
                if ((why = BenchBusyWhy(name, a)) != null) return why;
                if (benched.Value) next.Benched.Add(name); else next.Benched.Remove(name);
                return null;
            });
            if (ReferenceEquals(res, Unchanged)) return null;
            if (res != null) return res;
            ChartBridgeServer.Log("groups: " + name + (benched.Value ? " is on " + gname + "'s bench: it sits out new entries and keeps its rules" : " trades with " + gname + " again from the next entry") + " (by the page)");
            Changed();
            return null;
        }

        // 0.6.7: why an account may not move to or from the bench now (null: flat with no working order). Its positions by both
        // readings on every instrument and every order that may still fill (NinjaTrader's list and ChartBridge's own just sent).
        internal static string BenchBusyWhy(string name, Account a)
        {
            if (a == null) return name + " is not in NinjaTrader now: ChartBridge cannot see that it is flat, so it stays where it is";
            if (!Up(a)) return name + " is not connected: ChartBridge cannot see that it is flat, so it stays where it is";
            List<string> held = new List<string>();
            List<Position> ps;
            lock (a.Positions) ps = a.Positions.ToList();
            foreach (Position p in ps)
                if (p != null && p.Instrument != null && p.MarketPosition != MarketPosition.Flat && p.Quantity != 0)
                    held.Add((p.MarketPosition == MarketPosition.Long ? "+" : "-") + p.Quantity + " " + (p.Instrument.MasterInstrument != null ? p.Instrument.MasterInstrument.Name : p.Instrument.FullName));
            int working = ChartBridgeOrders.GroupWorkingCount(a);
            if (held.Count == 0 && working == 0 && ChartBridgeOrders.GroupMovesPending(a)) held.Add("a fill on its way");
            if (held.Count == 0 && working == 0) return null;
            string orders = working + " working order" + (working == 1 ? "" : "s");
            return name + (held.Count > 0 ? " is in a trade (" + string.Join(", ", held) + ")" + (working > 0 ? " with " + orders : "") : " has " + orders) + ": it moves once it is flat with no working orders";
        }

        // 0.6.7: the members of group id on the bench (empty when none, or no such group)
        public static HashSet<string> BenchedOf(string id)
        {
            EnsureLoaded();
            lock (Mem)
            {
                if (id == null || !state.Groups.ContainsKey(id)) return new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                return new HashSet<string>(state.Members.Where(kv => kv.Value == id && state.Benched.Contains(kv.Key)).Select(kv => kv.Key), StringComparer.OrdinalIgnoreCase);
            }
        }

        // After any change: the groups and the accounts to the pages at once, and each agent its accountState.
        private static void Changed()
        {
            SendGroups(true);
            try { ChartBridgeAccounts.SendAccountsNow(); } catch (Exception ex) { ChartBridgeServer.Log("groups: accounts not sent (" + ex.Message + ")"); }
            try { ChartBridgeAgents.AccountStatesChanged(); } catch (Exception ex) { ChartBridgeServer.Log("groups: accountState not sent (" + ex.Message + ")"); }
        }

        // For the harness and the PC: the group id of an account, or null.
        public static string GroupOf(string account) { EnsureLoaded(); lock (Mem) { string id; return account != null && state.Members.TryGetValue(account, out id) ? id : null; } }

        // 0.6.0 (group trading): a group's members in seat order (by name, ignoring case, as the groups message lists them), or null
        // when there is no such group (or groups.txt could not be read: no group is known then, so an agent on one trades nothing).
        public static List<string> MembersOf(string id)
        {
            if (string.IsNullOrEmpty(id)) return null;
            EnsureLoaded();
            lock (Mem)
            {
                if ((readError != null && lastGoodFrom == null) || !state.Groups.ContainsKey(id)) return null;   // 2026-10-21: the last good copy's seats
                return state.Members.Where(kv => kv.Value == id).Select(kv => kv.Key).OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToList();
            }
        }

        // 0.6.5: a group's name, risk percent and members in seat order (by name), or null with why (no such group, groups.txt unreadable).
        public sealed class RiskGroup { public string Id, Name; public double RiskPct; public List<string> Members; public HashSet<string> Benched; }   // 0.6.7: Benched
        public static RiskGroup RiskGroupOf(string id, out string why)
        {
            why = null;
            EnsureLoaded();
            lock (Mem)
            {
                if (readError != null) { why = ReadFailedText; return null; }
                Group g;
                if (id == null || !state.Groups.TryGetValue(id, out g)) { why = "no group " + id; return null; }
                List<string> ms = state.Members.Where(kv => kv.Value == id).Select(kv => kv.Key).OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToList();
                return new RiskGroup { Id = g.Id, Name = g.Name, RiskPct = g.RiskPct, Members = ms, Benched = new HashSet<string>(ms.Where(x => state.Benched.Contains(x)), StringComparer.OrdinalIgnoreCase) };
            }
        }

        // 0.6.2: a group's account Type ("eval", "funded"), or null when not set or there is no such group (the agent's welcome.group and
        // agentState.groupType; nothing in the order path reads it).
        public static string TypeOf(string id)
        {
            if (string.IsNullOrEmpty(id)) return null;
            EnsureLoaded();
            lock (Mem) { Group g; return state.Groups.TryGetValue(id, out g) ? g.AccountType : null; }
        }

        // 0.6.0: a group's name, or null when there is no such group.
        public static string NameOf(string id)
        {
            if (string.IsNullOrEmpty(id)) return null;
            EnsureLoaded();
            lock (Mem) { Group g; return state.Groups.TryGetValue(id, out g) ? g.Name : null; }
        }

        // 0.6.0: no group is known this run: groups.txt could not be read and (2026-10-21, Anthony) no last good copy read cleanly either.
        // With a last good copy the bot, the agents and the copier run on it, so this is false; FileUnreadable() is the file itself.
        public static bool Unreadable() { EnsureLoaded(); lock (Mem) return readError != null && lastGoodFrom == null; }
        // groups.txt itself could not be read (changes refused, the file never rewritten, page group entries refused).
        public static bool FileUnreadable() { EnsureLoaded(); lock (Mem) return readError != null; }
        // The groups.txt alarm's words: what the machines do (run on the last good copy, or wait).
        public static string ReadFailedNow()
        {
            string from, at;
            lock (Mem) { from = lastGoodFrom; at = lastGoodAt; }
            return ReadFailedText + (from != null ? "; the bot, the agents and the copier run on its last good copy (" + from + ", from the copy of " + (at ?? "an unknown time") + ")" : MachinesWaitText);
        }
        // The label of numbers worked out from the copy ("from the copy of 2026-10-21 08:14 ET"), or null when groups.txt read cleanly.
        public static string FromCopy()
        {
            lock (Mem) return readError != null && lastGoodFrom != null ? "from the copy of " + (lastGoodAt ?? "an unknown time") : null;
        }

        // ---------------------------------------------------------- telling the pages
        private static string Reject(string cid, string reason) { return "{\"type\":\"reject\"" + (cid != null ? ",\"cid\":" + CbJson.Str(cid) : "") + ",\"reason\":" + CbJson.Str(reason) + "}"; }
        // ---------------------------------------------------------- 0.6.6: the daily loss reached, and the risk alerts (Anthony 2026-10-20)
        // An account whose known daily room went to 0 or below in a trading day (account -> that day): no new entry from the bot, an
        // agent or the copier on it for the rest of that day, whatever its room does after (an open loss that comes back). Anthony's own
        // orders are never held by it, and nothing flattens the account: the firm does that at its own limit. One alert per account and
        // day. Memory only: after a restart a room still at or below 0 marks it again.
        private static readonly Dictionary<string, string> DailyHit = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public static bool DailyReached(Numbers n)
        {
            if (n == null || n.Name == null || n.Session == null) return false;
            bool fresh = false, hit;
            lock (DailyHit)
            {
                string day;
                hit = DailyHit.TryGetValue(n.Name, out day) && day == n.Session;
                // a balance of 0 is NinjaTrader not having given one yet (Tick's rule): never a loss reached
                if (!hit && n.RoomDaily.HasValue && n.RoomDaily.Value <= 0 && n.Balance.HasValue && n.Balance.Value > 0) { DailyHit[n.Name] = n.Session; hit = fresh = true; }
            }
            if (fresh)
            {
                double limit = n.R != null && n.R.DailyLoss > 0 ? n.R.DailyLoss : n.MyDaily ?? 0;
                RiskAlert("dailyLoss", n.Name, n.Name + " reached its daily loss" + (limit > 0 ? " limit of " + Usd(limit) : "") + " (daily room " + Usd(n.RoomDaily.Value) +
                          "): the bot, the agents and the copier send no new entry on it until the next trading day (18:00 ET). Your own orders are not held, and nothing was flattened.");
            }
            return hit;
        }
        public static void ClearDailyHits() { lock (DailyHit) DailyHit.Clear(); }

        // 0.6.6: the rules that hold for an account (a member's own, else its group's; an account in no group with its own), or null.
        // No clock read, so the page's entries ask it before anything else.
        public static Rules RulesOf(string name)
        {
            if (name == null) return null;
            EnsureLoaded();
            lock (Mem)
            {
                string id;
                Group g;
                if (state.Members.TryGetValue(name, out id) && state.Groups.TryGetValue(id, out g)) return state.RulesOf(name, g);
                Rules own;
                return state.Own.TryGetValue(name, out own) ? own.Clone() : null;
            }
        }

        // One alert (0.6.6): every page that trades shows it as a banner with a sound, never a dialog. kind: dailyLoss, held or skipped.
        public static void RiskAlert(string kind, string account, string text)
        {
            ChartBridgeServer.Log("ALERT: " + text);
            ChartBridgeServer.SendToTraders("{\"type\":\"riskAlert\",\"kind\":" + CbJson.Str(kind) + ",\"account\":" + CbJson.Str(account) + ",\"text\":" + CbJson.Str(text) + "}");
        }
        private static string Usd(double v) { return (v < 0 ? "-$" : "$") + Math.Abs(v).ToString("#,0.00", CultureInfo.InvariantCulture); }

        private static string StatusJson(string level, string text) { return "{\"type\":\"status\",\"level\":\"" + level + "\",\"text\":" + CbJson.Str(text) + "}"; }
        private static void Alarm(string text) { ChartBridgeServer.Log("ALERT: " + text); ChartBridgeServer.SendToTraders(StatusJson("error", text)); }
    }
}
