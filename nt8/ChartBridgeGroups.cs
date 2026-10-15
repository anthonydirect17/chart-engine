// ChartBridge prop groups and real account state (ChartBridge 0.5.8). Part of the ChartBridge add-on; install it with the
// other files. See nt8/PROTOCOL.md, "Prop groups and account state (0.5.8)".
//
// This file never places, changes or cancels an order (no Submit, Change, Cancel or Flatten here). It holds:
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
            foreach (Order o in orders)
            {
                if (o == null || !MayFill(o.OrderState)) continue;
                string name = o.Name ?? "";
                if (!string.IsNullOrEmpty(o.Oco) || GroupNotEntryRx.IsMatch(name) || AgentMarketRx.IsMatch(name) || IsMergedLeg(o)) continue;
                int left = Math.Max(0, o.Quantity - o.Filled);
                if (left == 0) continue;
                bool buy = IsBuy(o);
                string full = o.Instrument != null ? o.Instrument.FullName ?? "" : "";
                int l, mv;
                listed.TryGetValue(full, out l); moved.TryGetValue(full, out mv);
                int e = l + mv, held = l > 0 && e > 0 ? Math.Min(l, e) : l < 0 && e < 0 ? -Math.Min(-l, -e) : 0;
                if (held != 0 && (buy ? held < 0 : held > 0) && left <= Math.Abs(held)) continue;   // an exit of that position
                list.Add(new GroupHolding { Account = a.Name, Root = MasterName(o.Instrument), What = "entry", Side = buy ? 1 : -1, Qty = left, Kind = GroupKindWord(o.OrderType) });
            }
            return list;
        }

        private static string GroupKindWord(OrderType t)
        {
            return t == OrderType.Limit ? "limit" : t == OrderType.StopMarket ? "stop" : t == OrderType.StopLimit ? "stop limit" : t == OrderType.MIT ? "MIT" : "market";
        }

        // The account's own new order is an exit of its position on this contract: the other side by both readings, and its
        // contracts plus the exits already working on that side (orders that are no bracket leg) at most the position.
        internal static bool GroupExitOf(Account a, Instrument inst, bool isBuy, int qty)
        {
            if (a == null || inst == null || qty < 1) return false;
            int pn = SignedPosition(a, inst), pe = EffectivePosition(a, inst);
            int held = isBuy ? (pn < 0 && pe < 0 ? Math.Min(-pn, -pe) : 0) : (pn > 0 && pe > 0 ? Math.Min(pn, pe) : 0);
            if (held <= 0) return false;
            int b, s, lb, ls;
            PendingOrders(a, inst, out b, out s, out lb, out ls);
            return (long)(isBuy ? lb : ls) + qty <= held;
        }
    }

    // ---------------------------------------------------------------- the groups, the check and the account numbers
    public static class ChartBridgeGroups
    {
        public const string Header = "# ChartBridge account groups (written by ChartBridge; do not edit)";
        public const string Header2 = "# group<TAB>id<TAB>name<TAB>on|off<TAB>dailyLoss|-<TAB>drawdown<TAB>eod|intraday|static<TAB>target|-<TAB>size<TAB>lockAt|-, member<TAB>account<TAB>id, personal<TAB>account<TAB>floor|-<TAB>daily|-";
        public const string MarksHeader = "# ChartBridge account marks (written by ChartBridge; do not edit)";
        public const string MarksHeader2 = "# mark<TAB>account<TAB>peakEod|-<TAB>peakIntraday|-<TAB>dayStartBalance|-<TAB>session";
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
            public double? PeakEod, PeakIntraday, DayStart;
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
                    g.Extra = p.Skip(10).ToArray();
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
                 .Append(MoneyText(g.Drawdown)).Append('\t').Append(g.Type).Append('\t').Append(MoneyText(g.Target)).Append('\t').Append(MoneyText(g.Size)).Append('\t').Append(MoneyText(g.LockAt));
                foreach (string x in g.Extra) b.Append('\t').Append(x);
                b.Append('\n');
            }
            foreach (KeyValuePair<string, string> kv in s.Members.OrderBy(x => x.Key, StringComparer.OrdinalIgnoreCase)) b.Append("member\t").Append(kv.Key).Append('\t').Append(kv.Value).Append('\n');
            foreach (KeyValuePair<string, double[]> kv in s.Personal.OrderBy(x => x.Key, StringComparer.OrdinalIgnoreCase))
                if (kv.Value[0] > 0 || kv.Value[1] > 0) b.Append("personal\t").Append(kv.Key).Append('\t').Append(MoneyText(kv.Value[0])).Append('\t').Append(MoneyText(kv.Value[1])).Append('\n');
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
                if (p.Length != 6 || p[0] != "mark" || p[1].Length == 0 || !FileMoney(p[2], true, out pe) || !FileMoney(p[3], true, out pi) || !FileMoney(p[4], true, out ds) ||
                    !Regex.IsMatch(p[5], "^(?:-|[0-9]{4}-[0-9]{2}-[0-9]{2})$") || d.ContainsKey(p[1]))
                { why = "line " + (i + 1) + " is not a mark line"; return null; }
                d[p[1]] = new Mark { Name = p[1], PeakEod = pe > 0 ? pe : (double?)null, PeakIntraday = pi > 0 ? pi : (double?)null, DayStart = ds > 0 ? ds : (double?)null, Session = p[5] == "-" ? null : p[5] };
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
                         .Append(MoneyText(m.DayStart ?? 0)).Append('\t').Append(m.Session ?? "-").Append('\n');
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
                        m.Session = session; m.DayStart = Math.Round(bal.Value, 2); marksDirty = true;
                        if (m.PeakEod.HasValue && bal.Value > m.PeakEod.Value) m.PeakEod = Math.Round(bal.Value, 2);
                    }
                    if (m.PeakIntraday.HasValue && un.HasValue && bal.Value + un.Value > m.PeakIntraday.Value + 0.004) { m.PeakIntraday = Math.Round(bal.Value + un.Value, 2); marksDirty = true; }
                }
            }
            SaveMarks(false);
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

        // ---------------------------------------------------------- the one-direction check (G3 a)
        // Null when this entry may go, else the refusal. Asked under PlaceLock (PlaceOrderLocked, the copier's Eligible); the agent's
        // plan check 10b asks it without (advisory). wantsLegs: a stop or a target asked with it; strategy: an Order Strategy.
        public static string EntryCheck(string source, Account a, string root, bool isBuy, int qty, bool wantsLegs, bool strategy)
        {
            if (a == null || a.Name == null) return null;
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
                Instrument inst = root != null ? ChartBridgeServer.InstrumentFor(root) : null;
                if (!wantsLegs && !strategy && inst != null && ChartBridgeOrders.GroupExitOf(a, inst, isBuy, qty)) return null;   // an exit of its own position
                List<ChartBridgeOrders.GroupHolding> held = Holdings(members);
                bool longs = held.Any(h => h.Side > 0), shorts = held.Any(h => h.Side < 0);
                string tail = "; prop firms ban hedged accounts. Exits and flattens still work.";
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
            if (members != null) { try { n.Side = SideOf(Holdings(members)); } catch (Exception) { n.Side = null; } }
            bool up = Up(a);
            string down = a == null ? "the account is not in NinjaTrader now" : "the account is not connected";
            n.Balance = up ? Item(a, AccountItem.CashValue) : null;
            n.Unrealized = up ? Item(a, AccountItem.UnrealizedProfitLoss) : null;
            double? ntReal = up ? Item(a, AccountItem.RealizedProfitLoss) : null;
            n.Set("balance", n.Balance, "ninjatrader", up ? "NinjaTrader gives no balance for this account" : down);
            n.Set("unrealized", n.Unrealized, "ninjatrader", up ? "NinjaTrader gives no open P&L for this account" : down);
            string realSrc = null, realWhy;
            if (n.Balance.HasValue && marksErr == null && mark != null && mark.DayStart.HasValue && mark.Session == n.Session) { n.Realized = n.Balance.Value - mark.DayStart.Value; realSrc = "computed"; realWhy = null; }
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
                if (ntRoom.HasValue) { n.RoomFloor = ntRoom; n.Set("roomFloor", n.RoomFloor, "ninjatrader", null); }
                else { n.RoomFloor = n.Floor.HasValue && equity.HasValue ? equity.Value - n.Floor.Value : (double?)null; n.Set("roomFloor", n.RoomFloor, "computed", n.Floor.HasValue ? eqWhy : floorWhy); }
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
                if (ntRoom.HasValue) { n.RoomFloor = ntRoom; n.Set("roomFloor", n.RoomFloor, "ninjatrader", null); }
                else { n.RoomFloor = n.Floor.HasValue && equity.HasValue ? equity.Value - n.Floor.Value : (double?)null; n.Set("roomFloor", n.RoomFloor, "computed", n.Floor.HasValue ? eqWhy : floorWhy); }
                if (n.MyDaily.HasValue) { n.RoomDaily = n.Pnl.HasValue ? n.MyDaily.Value + n.Pnl.Value : (double?)null; n.Set("roomDaily", n.RoomDaily, "computed", n.Why.ContainsKey("pnlToday") ? n.Why["pnlToday"] : null); }
                else n.Set("roomDaily", null, null, "no group and no daily limit of its own (the Accounts tab)");
                n.Set("targetLeft", null, null, "a personal account has no profit target");
            }
            return n;
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
             .Append(",\"myFloor\":").Append(Num(n.MyFloor)).Append(",\"myDailyLoss\":").Append(Num(n.MyDaily));
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
                    b.Append("{\"dailyLoss\":").Append(None0(n.G.DailyLoss)).Append(",\"drawdown\":").Append(None0(n.G.Drawdown)).Append(",\"drawdownType\":").Append(CbJson.Str(n.G.Type))
                     .Append(",\"target\":").Append(None0(n.G.Target)).Append(",\"size\":").Append(None0(n.G.Size)).Append(",\"lockAt\":").Append(None0(n.G.LockAt)).Append('}');
                else b.Append("{\"floor\":").Append(Num(n.MyFloor)).Append(",\"dailyLoss\":").Append(Num(n.MyDaily)).Append('}');
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
            { "groupSave", new[] { "type", "cid", "group", "name", "noHedge", "dailyLoss", "drawdown", "drawdownType", "target", "size", "lockAt" } },
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
                g.Name = name; g.NoHedge = noHedge.Value; g.DailyLoss = dl; g.Drawdown = dd; g.Type = type; g.Target = tg; g.Size = sz; g.LockAt = lk;
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
                   (g.LockAt > 0 ? " (floor stops at " + d(g.LockAt) + ")" : "") + ", target " + (g.Target > 0 ? d(g.Target) : "none") + ", no hedging " + (g.NoHedge ? "on" : "off");
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
                if (floor > 0 || daily > 0) next.Personal[name] = new[] { floor, daily }; else next.Personal.Remove(name);
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

        // ---------------------------------------------------------- telling the pages
        private static string Reject(string cid, string reason) { return "{\"type\":\"reject\"" + (cid != null ? ",\"cid\":" + CbJson.Str(cid) : "") + ",\"reason\":" + CbJson.Str(reason) + "}"; }
        private static string StatusJson(string level, string text) { return "{\"type\":\"status\",\"level\":\"" + level + "\",\"text\":" + CbJson.Str(text) + "}"; }
        private static void Alarm(string text) { ChartBridgeServer.Log("ALERT: " + text); ChartBridgeServer.SendToTraders(StatusJson("error", text)); }
    }
}
