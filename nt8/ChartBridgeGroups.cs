// ChartBridge prop groups and real account state (ChartBridge 0.5.8). Part of the ChartBridge add-on; install it with the
// other files. See nt8/PROTOCOL.md, "Prop groups and account state (0.5.8)".
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
// Lock order: ChartBridgeOrders' PlaceLock, then SaveLock, then Mem. Mem only guards memory: never held during file I/O or a
// NinjaTrader call. Written in C# 5 syntax (NinjaTrader 8 compiles NinjaScript as C# 5).
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
        public const string Header2 = "# group<TAB>id<TAB>name<TAB>on|off<TAB>dailyLoss|-<TAB>drawdown<TAB>eod|intraday|static<TAB>target|-<TAB>size<TAB>lockAt|-<TAB>consistency|-, member<TAB>account<TAB>id, personal<TAB>account<TAB>floor|-<TAB>daily|-";
        public const string MarksHeader = "# ChartBridge account marks (written by ChartBridge; do not edit)";
        public const string MarksHeader2 = "# mark<TAB>account<TAB>peakEod|-<TAB>peakIntraday|-<TAB>dayStartBalance|-<TAB>session<TAB>dayStartAt (UTC ms)|-";
        public const string ReadFailedText = "groups.txt could not be read: every new entry is refused until it can (exits always work)";
        public const double MaxMoney = 100000000;
        public static double MarksWriteMs = 5000;  // account-marks.txt at most every 5 s while something changed (the harness sets 0)
        public const int NameMax = 30;

        private static string FilePath { get { return Path.Combine(ChartBridgeConfig.Folder, "groups.txt"); } }
        private static string MarksPath { get { return Path.Combine(ChartBridgeConfig.Folder, "account-marks.txt"); } }

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
            public string[] Extra = new string[0];                   // fields after lockAt, kept as read (a later ChartBridge's)
            public Group Clone() { Group g = (Group)MemberwiseClone(); g.Extra = (string[])Extra.Clone(); return g; }
        }
        private sealed class State
        {
            public readonly Dictionary<string, Group> Groups = new Dictionary<string, Group>(StringComparer.Ordinal);
            public readonly Dictionary<string, string> Members = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);   // account -> group id
            public readonly Dictionary<string, double[]> Personal = new Dictionary<string, double[]>(StringComparer.OrdinalIgnoreCase);   // account -> {floor, daily}, 0 none
            public int Next = 1;
            public State Clone()
            {
                State s = new State { Next = Next };
                foreach (KeyValuePair<string, Group> kv in Groups) s.Groups[kv.Key] = kv.Value.Clone();
                foreach (KeyValuePair<string, string> kv in Members) s.Members[kv.Key] = kv.Value;
                foreach (KeyValuePair<string, double[]> kv in Personal) s.Personal[kv.Key] = (double[])kv.Value.Clone();
                return s;
            }
        }
        private sealed class Mark
        {
            public string Name, Session;
            public double? PeakEod, PeakIntraday, DayStart, DayStartAt;   // DayStartAt: UTC ms of the day start's reading (review of #48)
            public Mark Clone() { return (Mark)MemberwiseClone(); }
        }

        private static readonly object Mem = new object();
        private static readonly object SaveLock = new object();       // one change (and its groups.txt write) at a time
        private static readonly object MarksFileLock = new object();
        private static State state = new State();
        private static bool loaded;
        private static string readError;      // groups.txt exists but could not be read: every entry refused, never rewritten this run
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
                state = new State(); loaded = false; readError = null; Marks.Clear(); marksError = null; marksDirty = false; marksWrittenMs = -1e18;
                marksSaveFailed = false; lastGroupsJson = null; LastSide.Clear();
            }
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
            State s = null;
            string[] lines = null;
            bool exists = File.Exists(FilePath);
            if (exists)
            {
                lines = ReadLines(FilePath, out err);
                if (lines != null) s = Parse(lines, out err);
            }
            string merr = null;
            Dictionary<string, Mark> marks = null;
            if (File.Exists(MarksPath))
            {
                string[] ml = ReadLines(MarksPath, out merr);
                if (ml != null) marks = ParseMarks(ml, out merr);
            }
            lock (Mem)
            {
                if (loaded) return;   // another thread read them meanwhile
                loaded = true;
                if (!exists) state = new State();
                else if (s == null) { readError = err ?? "unknown"; state = new State(); }
                else state = s;
                Marks.Clear();
                if (marks != null) foreach (KeyValuePair<string, Mark> kv in marks) Marks[kv.Key] = kv.Value;
                marksError = merr != null && marks == null ? merr : null;
            }
            if (exists && s == null) Alarm(ReadFailedText + " (" + err + "); fix or delete the file, then recompile");
            else if (exists) ChartBridgeServer.Log("groups: " + s.Groups.Count + " group" + (s.Groups.Count == 1 ? "" : "s") + ", " + s.Members.Count + " account" + (s.Members.Count == 1 ? "" : "s") + " in them (groups.txt)");
            if (merr != null && marks == null) ChartBridgeServer.Log("account-marks.txt could not be read (" + merr + "): it is not rewritten this run; the trailing floors and the computed P&L are not given until it can be read");
        }

        private static string[] ReadLines(string path, out string err)
        {
            err = null;
            for (int attempt = 0; attempt < 3; attempt++)
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
                catch (Exception ex) { err = ex.Message; if (attempt < 2) Thread.Sleep(100); }
            }
            return null;
        }

        // ---------------------------------------------------------- groups.txt: the whole file or nothing
        private static readonly Regex IdRx = new Regex("^g[1-9][0-9]{0,8}$");
        private static readonly Regex MoneyRx = new Regex("^(?:0|[1-9][0-9]{0,8})(?:\\.[0-9]{1,2})?$");

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
                    if (p.Length < 10 || !IdRx.IsMatch(p[1]) || NameProblem(p[2]) != null || (p[3] != "on" && p[3] != "off") || !FileMoney(p[4], true, out dl) || !FileMoney(p[5], false, out dd) ||
                        (p[6] != "eod" && p[6] != "intraday" && p[6] != "static") || !FileMoney(p[7], true, out tg) || !FileMoney(p[8], false, out sz) || !FileMoney(p[9], true, out lk))
                    { why = at + " is not a group line"; return null; }
                    if (s.Groups.ContainsKey(p[1])) { why = at + " names group " + p[1] + " twice"; return null; }
                    if (s.Groups.Values.Any(x => string.Equals(x.Name, p[2], StringComparison.OrdinalIgnoreCase))) { why = at + " names a group name twice"; return null; }
                    g.Id = p[1]; g.Name = p[2]; g.NoHedge = p[3] == "on"; g.DailyLoss = dl; g.Drawdown = dd; g.Type = p[6]; g.Target = tg; g.Size = sz; g.LockAt = lk;
                    double con = 0;
                    if (p.Length >= 11 && !FilePercent(p[10], out con)) { why = at + " is not a group line (consistency)"; return null; }
                    g.Consistency = con;
                    g.Extra = p.Skip(11).ToArray();   // a group line of 10 fields (no consistency) reads as none
                    s.Groups[g.Id] = g;
                    maxId = Math.Max(maxId, int.Parse(g.Id.Substring(1), CultureInfo.InvariantCulture));
                }
                else if (p[0] == "member")
                {
                    if (p.Length != 3 || p[1].Length == 0 || p[1] != p[1].Trim() || !IdRx.IsMatch(p[2]) || ChartBridgeOrders.IsNeverTradable(p[1])) { why = at + " is not a member line"; return null; }
                    if (s.Members.ContainsKey(p[1])) { why = at + " puts an account in two groups"; return null; }
                    s.Members[p[1]] = p[2];
                    members.Add(new[] { p[1], p[2], at });
                }
                else if (p[0] == "personal")
                {
                    double f, d;
                    if (p.Length != 4 || p[1].Length == 0 || p[1] != p[1].Trim() || !FileMoney(p[2], true, out f) || !FileMoney(p[3], true, out d)) { why = at + " is not a personal line"; return null; }
                    if (s.Personal.ContainsKey(p[1])) { why = at + " names an account twice"; return null; }
                    s.Personal[p[1]] = new[] { f, d };
                }
                else { why = at + " is not a group, member or personal line"; return null; }
            }
            foreach (string[] m in members) if (!s.Groups.ContainsKey(m[1])) { why = m[2] + " puts an account in group " + m[1] + ", which is not there"; return null; }
            s.Next = maxId + 1;
            return s;
        }

        private static string MoneyText(double v) { return v > 0 ? v.ToString("0.##", CultureInfo.InvariantCulture) : "-"; }

        private static string Serialize(State s)
        {
            StringBuilder b = new StringBuilder(Header).Append('\n').Append(Header2).Append('\n');
            foreach (Group g in s.Groups.Values.OrderBy(x => int.Parse(x.Id.Substring(1), CultureInfo.InvariantCulture)))
            {
                b.Append("group\t").Append(g.Id).Append('\t').Append(g.Name).Append('\t').Append(g.NoHedge ? "on" : "off").Append('\t').Append(MoneyText(g.DailyLoss)).Append('\t')
                 .Append(MoneyText(g.Drawdown)).Append('\t').Append(g.Type).Append('\t').Append(MoneyText(g.Target)).Append('\t').Append(MoneyText(g.Size)).Append('\t').Append(MoneyText(g.LockAt))
                 .Append('\t').Append(g.Consistency > 0 ? g.Consistency.ToString("0.##", CultureInfo.InvariantCulture) : "-");
                foreach (string x in g.Extra) b.Append('\t').Append(x);
                b.Append('\n');
            }
            foreach (KeyValuePair<string, string> kv in s.Members.OrderBy(x => x.Key, StringComparer.OrdinalIgnoreCase)) b.Append("member\t").Append(kv.Key).Append('\t').Append(kv.Value).Append('\n');
            foreach (KeyValuePair<string, double[]> kv in s.Personal.OrderBy(x => x.Key, StringComparer.OrdinalIgnoreCase))
                b.Append("personal\t").Append(kv.Key).Append('\t').Append(MoneyText(kv.Value[0])).Append('\t').Append(MoneyText(kv.Value[1])).Append('\n');
            return b.ToString();
        }

        // Whole, through a temp file; null when saved, else why.
        private static string WriteWhole(string path, string text)
        {
            try
            {
                Directory.CreateDirectory(ChartBridgeConfig.Folder);
                string tmp = path + ".tmp";
                File.WriteAllText(tmp, text);
                if (File.Exists(path)) File.Replace(tmp, path, null); else File.Move(tmp, path);
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
                if ((p.Length != 6 && p.Length != 7) || (p.Length == 7 && p[6] != "-" && !long.TryParse(p[6], NumberStyles.None, CultureInfo.InvariantCulture, out at)) || p[0] != "mark" || p[1].Length == 0 || !FileMoney(p[2], true, out pe) || !FileMoney(p[3], true, out pi) || !FileMoney(p[4], true, out ds) ||
                    !Regex.IsMatch(p[5], "^(?:-|[0-9]{4}-[0-9]{2}-[0-9]{2})$") || d.ContainsKey(p[1]))
                { why = "line " + (i + 1) + " is not a mark line"; return null; }
                d[p[1]] = new Mark { Name = p[1], PeakEod = pe > 0 ? pe : (double?)null, PeakIntraday = pi > 0 ? pi : (double?)null, DayStart = ds > 0 ? ds : (double?)null, Session = p[5] == "-" ? null : p[5], DayStartAt = at > 0 ? at : (double?)null };
            }
            return d;
        }

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
                         .Append(MoneyText(m.DayStart ?? 0)).Append('\t').Append(m.Session ?? "-").Append('\t').Append(m.DayStartAt.HasValue ? ((long)m.DayStartAt.Value).ToString(CultureInfo.InvariantCulture) : "-").Append('\n');
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
            foreach (Account a in all)
            {
                if (a == null || a.Name == null || ChartBridgeOrders.IsNeverTradable(a.Name) || !Up(a) || !ChartBridgeAccounts.Listed(a.Name)) continue;
                double? bal = Item(a, AccountItem.CashValue), un = Item(a, AccountItem.UnrealizedProfitLoss);
                if (!bal.HasValue || bal.Value <= 0) continue;   // 0: NinjaTrader has not given a balance yet
                lock (Mem)
                {
                    if (marksError != null) break;
                    Mark m;
                    if (!Marks.TryGetValue(a.Name, out m)) { Marks[a.Name] = m = new Mark { Name = a.Name }; marksDirty = true; }
                    if (m.Session != session)
                    {
                        m.Session = session; m.DayStart = Math.Round(bal.Value, 2); m.DayStartAt = nowMs; marksDirty = true;
                        // review of #48 (item 6): only a reading in the 17:00 to 18:05 ET window is a close; a late first reading
                        // (ChartBridge started at midday) never raises the end-of-day high
                        if (closeWindow && m.PeakEod.HasValue && bal.Value > m.PeakEod.Value) m.PeakEod = Math.Round(bal.Value, 2);
                    }
                    if (m.PeakIntraday.HasValue && un.HasValue && bal.Value + un.Value > m.PeakIntraday.Value + 0.004) { m.PeakIntraday = Math.Round(bal.Value + un.Value, 2); marksDirty = true; }
                }
            }
            SaveMarks(false);
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
                    if (marksError != null || !Marks.TryGetValue(a.Name, out m) || !m.PeakEod.HasValue) continue;
                    double eq = Math.Round(bal.Value + un.Value, 2);
                    if (eq > m.PeakEod.Value + 0.004) { m.PeakEod = eq; marksDirty = true; ChartBridgeServer.Log("groups: " + a.Name + "'s end-of-day high is " + eq.ToString("0.00", CultureInfo.InvariantCulture)); }
                }
            }
            SaveMarks(true);   // only when a high rose (marksDirty)
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
                if (readError != null) return ReadFailedText;
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
            lock (Mem)
            {
                err = readError;
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
                 .Append(",\"dailyLoss\":").Append(None0(g.DailyLoss)).Append(",\"drawdown\":").Append(None0(g.Drawdown)).Append(",\"drawdownType\":").Append(CbJson.Str(g.Type))
                 .Append(",\"target\":").Append(None0(g.Target)).Append(",\"size\":").Append(None0(g.Size)).Append(",\"lockAt\":").Append(None0(g.LockAt))
                 .Append(",\"consistency\":").Append(None0(g.Consistency))
                 .Append(",\"members\":[").Append(string.Join(",", members[g.Id].Select(x => CbJson.Str(x)))).Append("]")
                 .Append(",\"side\":").Append(side == null ? "null" : CbJson.Str(side)).Append(",\"holders\":[");
                for (int k = 0; k < held.Count; k++)
                {
                    ChartBridgeOrders.GroupHolding h = held[k];
                    if (k > 0) b.Append(',');
                    b.Append("{\"account\":").Append(CbJson.Str(h.Account)).Append(",\"root\":").Append(CbJson.Str(h.Root)).Append(",\"side\":").Append(h.Side > 0 ? "\"long\"" : "\"short\"")
                     .Append(",\"what\":").Append(CbJson.Str(h.What)).Append(",\"qty\":").Append(h.Qty.ToString(CultureInfo.InvariantCulture)).Append('}');
                }
                b.Append("]}");
            }
            b.Append("],\"error\":").Append(err == null ? "null" : CbJson.Str(ReadFailedText + " (" + err + ")")).Append('}');
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
            if (err != null) c.Send(StatusJson("error", ReadFailedText + " (" + err + ")"));
        }

        // ---------------------------------------------------------- the account numbers (item 5)
        public sealed class Numbers
        {
            public string Name, Kind, GroupId, GroupName, Side, Session;
            public Group G;
            public bool MySet;   // a personal line was ever saved (My floor or My daily, 0 included): rules are Anthony's, else null
            public double? MyFloor, MyDaily, Balance, Unrealized, Realized, Pnl, Floor, RoomFloor, RoomDaily, TargetLeft;
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
                groupsErr = readError; marksErr = marksError;
                string id;
                if (name != null && state.Members.TryGetValue(name, out id) && state.Groups.TryGetValue(id, out g))
                {
                    g = g.Clone();
                    if (withSide) members = state.Members.Where(kv => kv.Value == id).Select(kv => kv.Key).ToList();
                }
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
                string w = ReadFailedText;
                n.Set("floor", null, null, w); n.Set("roomFloor", null, null, w); n.Set("roomDaily", null, null, w); n.Set("targetLeft", null, null, w);
                return n;
            }
            if (g != null)
            {
                string floorWhy = null;
                if (g.Type == "static") n.Floor = g.Size - g.Drawdown;
                else if (marksErr != null) floorWhy = "account-marks.txt could not be read (" + marksErr + ")";
                else
                {
                    double? peak = mark == null ? null : g.Type == "eod" ? mark.PeakEod : mark.PeakIntraday;
                    if (!peak.HasValue) floorWhy = "no " + (g.Type == "eod" ? "end-of-day" : "intraday") + " high is known for this account: put it in " + g.Name + " again and give its highest close";
                    else
                    {
                        double f = Math.Max(peak.Value, g.Size) - g.Drawdown;
                        if (g.LockAt > 0) f = Math.Min(f, g.LockAt);
                        n.Floor = f;
                    }
                }
                n.Set("floor", n.Floor, "computed", floorWhy);
                SetRoomFloor(n, ntRoom, equity, n.Floor.HasValue ? eqWhy : floorWhy);
                if (g.DailyLoss > 0) { n.RoomDaily = n.Pnl.HasValue ? g.DailyLoss + n.Pnl.Value : (double?)null; n.Set("roomDaily", n.RoomDaily, "computed", n.Why.ContainsKey("pnlToday") ? n.Why["pnlToday"] : null); }
                else n.Set("roomDaily", null, null, "group " + g.Name + " has no daily loss limit");
                if (g.Target > 0) { n.TargetLeft = n.Balance.HasValue ? g.Size + g.Target - n.Balance.Value : (double?)null; n.Set("targetLeft", n.TargetLeft, "computed", up ? "NinjaTrader gives no balance for this account" : down); }
                else n.Set("targetLeft", null, null, "group " + g.Name + " has no profit target");
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

        // Review of #48 (item 4): with NinjaTrader's trailing drawdown and the computed room both known, the smaller (src says which).
        private static void SetRoomFloor(Numbers n, double? ntRoom, double? equity, string why)
        {
            double? comp = n.Floor.HasValue && equity.HasValue ? equity.Value - n.Floor.Value : (double?)null;
            if (ntRoom.HasValue && comp.HasValue) { n.RoomFloor = Math.Min(ntRoom.Value, comp.Value); n.Set("roomFloor", n.RoomFloor, ntRoom.Value < comp.Value ? "ninjatrader" : "computed", null); }
            else if (ntRoom.HasValue) { n.RoomFloor = ntRoom; n.Set("roomFloor", n.RoomFloor, "ninjatrader", null); }
            else { n.RoomFloor = comp; n.Set("roomFloor", comp, "computed", why); }
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
            SrcWhy(b, n, PageKeys);
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
                b.Append(",\"account\":null,\"sim\":false,\"kind\":\"none\",\"group\":null,\"groupId\":null,\"groupSide\":null,\"noHedge\":null,\"rules\":null");
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
                 .Append(",\"noHedge\":").Append(n.G == null ? "null" : n.G.NoHedge ? "true" : "false").Append(",\"rules\":");
                if (n.G != null)
                    b.Append("{\"dailyLoss\":").Append(Zero0(n.G.DailyLoss)).Append(",\"drawdown\":").Append(Zero0(n.G.Drawdown)).Append(",\"drawdownType\":").Append(CbJson.Str(n.G.Type))
                     .Append(",\"target\":").Append(Zero0(n.G.Target)).Append(",\"size\":").Append(Zero0(n.G.Size)).Append(",\"lockAt\":").Append(Zero0(n.G.LockAt))
                     .Append(",\"consistency\":").Append(Zero0(n.G.Consistency)).Append('}');   // CON (a): informational, 0 none
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
            { "groupSave", new[] { "type", "cid", "group", "name", "noHedge", "dailyLoss", "drawdown", "drawdownType", "target", "size", "lockAt", "consistency" } },
            { "groupDelete", new[] { "type", "cid", "group" } },
            { "accountGroup", new[] { "type", "cid", "account", "group", "highClose" } },
            { "accountLimits", new[] { "type", "cid", "account", "floor", "dailyLoss" } },
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
                if (why == null) why = type == "groupSave" ? GroupSave(m) : type == "groupDelete" ? GroupDelete(m) : type == "accountGroup" ? AccountGroup(m) : AccountLimits(m);
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

        private static string Save(State next)
        {
            string err = WriteWhole(FilePath, Serialize(next));
            if (err != null) return "groups.txt could not be saved (" + err + "); nothing was changed";
            lock (Mem) state = next;
            return null;
        }

        private static string GroupSave(Dictionary<string, string> m)
        {
            string id = ChartBridgeV3.Str(m, "group"), name = ChartBridgeV3.Str(m, "name"), type = ChartBridgeV3.Str(m, "drawdownType"), why;
            if (m.ContainsKey("group") && id == null) return "group must be a group id (a plain string), or left out for a new group";
            if ((why = NameProblem(name)) != null) return why;
            bool? noHedge = ChartBridgeV3.Bool(m, "noHedge");
            if (!noHedge.HasValue) return "noHedge must be true or false";
            if (type != "eod" && type != "intraday" && type != "static") return "drawdownType must be eod, intraday or static";
            double dl, dd, tg, sz, lk;
            if ((why = Money(m, "dailyLoss", true, out dl)) != null || (why = Money(m, "drawdown", false, out dd)) != null || (why = Money(m, "target", true, out tg)) != null ||
                (why = Money(m, "size", false, out sz)) != null || (why = Money(m, "lockAt", true, out lk)) != null) return why;
            if (dd >= sz) return "the drawdown must be less than the account size";
            if (lk > 0 && type == "static") return "floor stops at applies to a trailing drawdown only (end of day or intraday); 0 for none";
            double con = 0;   // CON (a): optional, 0 or absent none, else more than 0 and at most 100 (2 decimals)
            if (m.ContainsKey("consistency"))
            {
                string raw = m["consistency"];
                if (raw != "0" && !FilePercent(raw, out con)) return "consistency must be a percent from 0 (none) to 100, at most 2 decimals";
            }
            if (lk > 0 && lk <= sz - dd) return "floor stops at must be above the starting floor (" + (sz - dd).ToString("0.##", CultureInfo.InvariantCulture) + ")";
            string said;
            lock (SaveLock)
            {
                State next;
                lock (Mem) next = state.Clone();
                Group g;
                if (id != null) { if (!next.Groups.TryGetValue(id, out g)) return "no group " + id; }
                else g = new Group { Id = "g" + next.Next.ToString(CultureInfo.InvariantCulture) };
                if (next.Groups.Values.Any(x => x.Id != g.Id && string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase))) return "a group named " + name + " is there already";
                string was = id != null ? g.Name : null;
                g.Name = name; g.NoHedge = noHedge.Value; g.DailyLoss = dl; g.Drawdown = dd; g.Type = type; g.Target = tg; g.Size = sz; g.LockAt = lk; g.Consistency = con;
                if (id == null) { next.Groups[g.Id] = g; next.Next++; }
                string err = Save(next);
                if (err != null) return err;
                said = (id == null ? "group " + g.Id + " made: " : "group " + g.Id + " saved: ") + name + (was != null && was != name ? " (was " + was + ")" : "") + ", " + RulesWords(g);
            }
            ChartBridgeServer.Log("groups: " + said + " (by the page)");
            Changed();
            return null;
        }

        private static string RulesWords(Group g)
        {
            Func<double, string> d = v => "$" + v.ToString("#,0.##", CultureInfo.InvariantCulture);
            return "size " + d(g.Size) + ", daily loss " + (g.DailyLoss > 0 ? d(g.DailyLoss) : "none") + ", drawdown " + d(g.Drawdown) + " " + g.Type +
                   (g.LockAt > 0 ? " (floor stops at " + d(g.LockAt) + ")" : "") + ", target " + (g.Target > 0 ? d(g.Target) : "none") + ", consistency " + (g.Consistency > 0 ? g.Consistency.ToString("0.##", CultureInfo.InvariantCulture) + "%" : "none") + ", no hedging " + (g.NoHedge ? "on" : "off");
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
                foreach (string a in left) next.Members.Remove(a);
                string err = Save(next);
                if (err != null) return err;
            }
            ForgetHighs(left);
            ChartBridgeServer.Log("groups: group " + id + " (" + name + ") deleted by the page" + (left.Count > 0 ? "; " + string.Join(", ", left) + " now in no group" : ""));
            Changed();
            return null;
        }

        private static void ForgetHighs(IEnumerable<string> accounts)
        {
            lock (Mem) foreach (string a in accounts) { Mark mk; if (Marks.TryGetValue(a, out mk) && (mk.PeakEod.HasValue || mk.PeakIntraday.HasValue)) { mk.PeakEod = null; mk.PeakIntraday = null; marksDirty = true; } }
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
                string err = Save(next);
                if (err != null) return err;
                if (g != null)
                {
                    double? bal = Up(a) ? Item(a, AccountItem.CashValue) : null;
                    seed = high > 0 ? high : Math.Max(g.Size, bal.HasValue && bal.Value > 0 ? bal.Value : 0);
                }
                said = name + (g != null ? " joined " + g.Name + " (its highs start at " + seed.ToString("0.00", CultureInfo.InvariantCulture) + (high > 0 ? ", the highest close given" : ", no highest close given: the larger of the account size and its balance") + ")" : " is in no group now") +
                       (cur != null && next.Groups.ContainsKey(cur) ? ", left " + next.Groups[cur].Name : "");
            }
            if (id != null)
            {
                lock (Mem)
                {
                    if (marksError == null)
                    {
                        Mark mk;
                        if (!Marks.TryGetValue(name, out mk)) Marks[name] = mk = new Mark { Name = name };
                        mk.PeakEod = Math.Round(seed, 2); mk.PeakIntraday = Math.Round(seed, 2); marksDirty = true;
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
                if (readError != null || !state.Groups.ContainsKey(id)) return null;
                return state.Members.Where(kv => kv.Value == id).Select(kv => kv.Key).OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToList();
            }
        }

        // 0.6.0: a group's name, or null when there is no such group.
        public static string NameOf(string id)
        {
            if (string.IsNullOrEmpty(id)) return null;
            EnsureLoaded();
            lock (Mem) { Group g; return state.Groups.TryGetValue(id, out g) ? g.Name : null; }
        }

        // 0.6.0: groups.txt could not be read (no group is known this run).
        public static bool Unreadable() { EnsureLoaded(); lock (Mem) return readError != null; }

        // ---------------------------------------------------------- telling the pages
        private static string Reject(string cid, string reason) { return "{\"type\":\"reject\"" + (cid != null ? ",\"cid\":" + CbJson.Str(cid) : "") + ",\"reason\":" + CbJson.Str(reason) + "}"; }
        private static string StatusJson(string level, string text) { return "{\"type\":\"status\",\"level\":\"" + level + "\",\"text\":" + CbJson.Str(text) + "}"; }
        private static void Alarm(string text) { ChartBridgeServer.Log("ALERT: " + text); ChartBridgeServer.SendToTraders(StatusJson("error", text)); }
    }
}
