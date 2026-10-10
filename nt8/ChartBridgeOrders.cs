// ChartBridge orders (protocol v2, Step 2: trading from the chart). Part of the ChartBridge add-on;
// install both files together. See nt8/PROTOCOL.md, "Orders (protocol v2)".
//
// Every order path in ChartBridge lives in this file, behind these gates (all checked here, never only
// in the page):
//   1. off unless config.txt has "trading = true";
//   2. only accounts named in "tradeAccounts = ..." (exact names, no wildcard; never Backtest/Playback),
//      only while the account is Connected, and only once ChartBridge is listening to its order events;
//   3. size cap per root, "maxQty.MNQ = 5" (default 1), on the order and on the POSITION: the current
//      position plus working orders on the same side plus the new order may not exceed it (0.5.3: an agent's MNQ
//      entry takes the agents' shipped cap of 20 instead, whatever maxQty.MNQ says: AgentCap);
//   4. only ChartBridge's own page: WebSocket Origin must be http://localhost:<port>, and the page must
//      send the token it read from GET /session (new random token each start, no CORS headers);
//   5. prices on the tick grid, a last price no older than 300 seconds, stops on the right side of the
//      market (0.3.7: no distance limit unless config.txt sets maxTicksAway; maxBracketTicks likewise);
//   6. only the roots ChartBridge serves, on the contract it resolved; never a quote-only root (0.4.0, config.txt quoteRoots:
//      served for the Quote board only; one early check refuses every order action for them, and the lookups this file
//      uses, InstrumentFor and RootFor, never return one);
//   7. at most 10 order actions per second per connection;
//   8. strict messages: only the keys the protocol names (a misspelt "bracket" is refused, never
//      ignored), whole numbers must be plain JSON numbers, no duplicate keys, no nested objects other
//      than "bracket", which must be an object.
// Brackets: every fill increment of an entry gets its own OCO stop and target (GTC) for exactly that
// many contracts, at ticks from that increment's actual fill price (0.3.8, Anthony's ATM rule of 2026-10-01: a
// resting entry's stop and target travel with it; 0.3.7's planned prices are gone). The ticks are written into the
// entry's order name at placement; a resting (limit or stop) entry's can be changed before the fill (plan), and an
// order's name cannot, so the changes are kept in planned_brackets.txt: both survive a recompile. When a leg fills in part, its
// partner is resized; when the position goes flat, leftover ChartBridge legs are cancelled; a late entry
// fill after Flatten gets legs and an alarm. Every 2 seconds a check compares ChartBridge's legs with the
// position: legs on a flat or opposite position, or covering more contracts than the position, are
// cancelled or shrunk once that has held for 4 seconds on a connection that has been up for 30 seconds (a
// reconnect can show orders before positions). Bracket upkeep runs even if trading is switched off, so a
// position placed from the chart keeps its legs.
// A leg that is rejected or cannot be changed is logged and reported to the page as an error.
// Written in C# 5 syntax (NinjaTrader 8 compiles NinjaScript as C# 5).
#region Using declarations
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.IO;
using System.Threading;
using NinjaTrader.Cbi;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    public static partial class ChartBridgeOrders   // 0.4.0 B4: partial, Merge lives in ChartBridgeMerge.cs   // 0.4.0 copier: partial, so ChartBridgeCopier.cs can read the gates through its wrappers   // 0.4.0 B1: partial; ChartBridgeStrategies.cs is the rest (order types, Order Strategies)
    {
        public const int MaxActionsPerSecond = 10, DefaultMaxQty = 1;
        public const double MaxPriceAgeMs = 300000;

        // ---------------------------------------------------------- settings (from config.txt)
        public static bool Enabled;
        public static readonly List<string> TradeAccounts = new List<string>();
        public static readonly Dictionary<string, int> MaxQty = new Dictionary<string, int>();
        // 0.3.7 (Anthony, 2026-10-01): no distance limits unless config.txt sets them. 0 = no limit.
        //   maxTicksAway = 400     a limit or stop price at most this many ticks from the last price
        //   maxBracketTicks = 300  a bracket stop or target at most this many ticks from the entry (market: ticks;
        //                          limit or stop: from the entry's price to the planned stop or target)
        public static int MaxTicksAway, MaxBracketTicks;
        // Anthony, 2026-10-01: a mistyped limit means no limit, and every page is told (status warn) at config load and
        // whenever a page signs in, not only the Output window.
        private static readonly List<string> ConfigWarnings = new List<string>();

        public static void ResetConfig() { Enabled = false; TradeAccounts.Clear(); MaxQty.Clear(); MaxTicksAway = 0; MaxBracketTicks = 0; lock (ConfigWarnings) ConfigWarnings.Clear(); MergeResetConfig(); ResetV3Config(); }   // 0.4.0 B4: merge off   // 0.4.0 B1: orderTypes, strategies

        // Called by ChartBridgeConfig.Load for each key it does not know itself.
        public static bool ReadConfig(string key, string val)
        {
            int n;
            if (MergeReadConfig(key, val)) return true;   // 0.4.0 B4: merge = on (ChartBridgeMerge.cs)
            if (ReadV3Config(key, val)) return true;   // 0.4.0 B1: orderTypes, strategies (on by default; an off line turns one off)
            if (key == "trading") { Enabled = val.Equals("true", StringComparison.OrdinalIgnoreCase) || val == "1"; return true; }
            if (key == "tradeAccounts")
            {
                TradeAccounts.Clear();
                foreach (string s in val.Split(','))
                {
                    string name = s.Trim();
                    if (name.Length == 0 || name.Contains("*")) continue;          // exact names only
                    if (IsNeverTradable(name)) continue;
                    TradeAccounts.Add(name);
                }
                return true;
            }
            if (key.StartsWith("maxQty.") && int.TryParse(val, out n)) { MaxQty[key.Substring(7).Trim().ToUpperInvariant()] = Math.Max(0, Math.Min(1000, n)); return true; }
            if (key == "maxTicksAway" || key == "maxBracketTicks")
            {
                if (!int.TryParse(val, NumberStyles.None, CultureInfo.InvariantCulture, out n) || n < 1)
                {
                    string text = "config.txt: " + key + " = " + val + " is not a whole number of 1 or more; it is ignored, so there is NO " + key + " limit";
                    lock (ConfigWarnings) ConfigWarnings.Add(text);
                    Warn(text);   // the Output window and every signed-in page now; pages that sign in later get it in Auth
                    n = 0;
                }
                if (key == "maxTicksAway") MaxTicksAway = n; else MaxBracketTicks = n;
                return true;
            }
            return false;
        }

        public static bool IsNeverTradable(string name)
        {
            return name.StartsWith("Backtest", StringComparison.OrdinalIgnoreCase) || name.StartsWith("Playback", StringComparison.OrdinalIgnoreCase);
        }

        public static bool AccountTradable(string name)
        {
            if (!Enabled || string.IsNullOrEmpty(name) || IsNeverTradable(name)) return false;
            if (ChartBridgeAccounts.On) return ChartBridgeAccounts.Checked(name);   // 0.4.0 accounts: with accountChecks on, gate 2 is the page's checkmark (accounts.txt), not tradeAccounts
            foreach (string a in TradeAccounts) if (a.Equals(name, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        public static int CapFor(string root)
        {
            int n;
            return MaxQty.TryGetValue(root ?? "", out n) ? n : DefaultMaxQty;
        }

        // ---------------------------------------------------------- the session token (gate 4)
        private static string token = "";

        public static void NewToken()
        {
            byte[] b = new byte[24];
            using (RNGCryptoServiceProvider rng = new RNGCryptoServiceProvider()) rng.GetBytes(b);
            token = BitConverter.ToString(b).Replace("-", "").ToLowerInvariant();
        }

        // GET /session. Served same-origin with no CORS headers, so only ChartBridge's own page can read it.
        public static string SessionJson() { return "{\"token\":" + CbJson.Str(token) + ",\"trading\":" + (Enabled ? "true" : "false") + "}"; }

        public static bool OriginAllowed(string origin)
        {
            return origin != null && origin.Equals("http://localhost:" + ChartBridgeConfig.Port, StringComparison.Ordinal);
        }

        public static string TradingJson(bool authed, string reason)
        {
            StringBuilder b = new StringBuilder("{\"type\":\"trading\",\"enabled\":");
            bool on = Enabled && authed;
            b.Append(on ? "true" : "false");
            if (!on) b.Append(",\"reason\":").Append(CbJson.Str(reason ?? (Enabled ? "not signed in" : "trading is off in config.txt")));
            b.Append(",\"accounts\":[");
            if (on) b.Append(string.Join(",", (ChartBridgeAccounts.On ? ChartBridgeAccounts.CheckedNames() : TradeAccounts).Select(a => CbJson.Str(a))));   // 0.4.0 accounts: the checked accounts with accountChecks on
            b.Append("],\"maxQty\":{\"*\":").Append(DefaultMaxQty);
            foreach (KeyValuePair<string, int> kv in MaxQty) b.Append(',').Append(CbJson.Str(kv.Key)).Append(':').Append(kv.Value);
            b.Append('}');
            if (MaxTicksAway > 0) b.Append(",\"maxTicksAway\":").Append(MaxTicksAway);          // 0.3.7: only when config.txt sets them
            if (MaxBracketTicks > 0) b.Append(",\"maxBracketTicks\":").Append(MaxBracketTicks);
            b.Append('}');
            return b.ToString();
        }

        // ---------------------------------------------------------- last price per root (gate 5)
        private static readonly Dictionary<string, double[]> Last = new Dictionary<string, double[]>();   // root -> { price, time ms }
        public static void NoteLast(string root, double price)
        {
            lock (Last) Last[root] = new double[] { price, ChartBridgeTime.NowUtcMs() };
            if (StrategiesOn) StrategyTrade(root, price);   // 0.4.0 B1: breakeven and trailing (cheap; a move is sent off this thread)
        }

        // A last price no older than maxAgeMs. The market exit needs a tick this fresh, so a lagging price feed
        // cannot trigger a false exit.
        public const double FreshTickMs = 2000;

        private static bool FreshLast(string root, double maxAgeMs, out double p)
        {
            double[] v;
            p = 0;
            lock (Last) { if (!Last.TryGetValue(root, out v)) return false; }
            p = v[0];
            return ChartBridgeTime.NowUtcMs() - v[1] <= maxAgeMs;
        }

        private static string LastPrice(string root, out double p)
        {
            double[] v;
            p = 0;
            lock (Last) { if (!Last.TryGetValue(root, out v)) return "no last price yet for " + root + "; wait for a trade"; }
            p = v[0];
            double age = ChartBridgeTime.NowUtcMs() - v[1];
            if (age > MaxPriceAgeMs) return "the last " + root + " price is stale (" + Math.Round(age / 1000) + " seconds old); wait for a trade";
            return null;
        }

        // ---------------------------------------------------------- our ids, roles and brackets
        // Order ids handed to the page are ours ("o1", "o2", ...), so nothing depends on broker ids.
        private static readonly object Sync = new object();
        private static readonly Dictionary<Order, string> IdOf = new Dictionary<Order, string>();
        private static readonly Dictionary<string, Order> ById = new Dictionary<string, Order>();
        private static readonly Dictionary<Order, string> CidOf = new Dictionary<Order, string>();
        private static readonly Dictionary<Order, Bracket> BracketOfEntry = new Dictionary<Order, Bracket>();
        private static readonly Dictionary<Order, Pair> PairOfLeg = new Dictionary<Order, Pair>();
        private static readonly Dictionary<Order, double> LegBorn = new Dictionary<Order, double>();   // leg -> time submitted
        private static readonly HashSet<Order> Settled = new HashSet<Order>();   // entries done and covered: the scan skips them
        private static readonly HashSet<Order> Ours = new HashSet<Order>();      // orders ChartBridge submitted, until done
        private static readonly Dictionary<Order, int> SeenFilled = new Dictionary<Order, int>();   // fills already booked in Moves
        // 0.4.3: each order's filled count as it last came through OnOrderUpdate (NoteFill done), kept after the order is done
        // (SeenFilled is not), so the copier can tell a fill NinjaTrader already shows on the order from one both position
        // readings already include. Seeded when an account is first watched; cleared with the rest.
        private static readonly Dictionary<Order, int> NotedFilled = new Dictionary<Order, int>();
        private static readonly object PlaceLock = new object();   // one order check and submit at a time
        private static int nextId;

        // Order names carry the bracket, so it survives a recompile:
        //   entry "CB#1a2b3c4d s8 t16": a market entry, stop 8 and target 16 ticks from each fill (any number of
        //         digits since 0.3.7; before 0.3.7 limit and stop entries were named this way too)
        //   entry "CB#1a2b3c4d atm s8 t16": a limit or stop entry (0.3.8), its planned ticks at placement; changes
        //         live in planned_brackets.txt (see "planned brackets" below)
        //   entry "CB#1a2b3c4d plan s24980.25 t25010.5": a limit or stop entry placed by 0.3.7, with planned PRICES;
        //         converted once, at recovery, to the ticks they are from the entry's price (then an ATM entry)
        //   legs  "CB#1a2b3c4d stop f2 q2 p24990.25" and "CB#1a2b3c4d target f2 q2 p24990.25": the pair for the
        //         fill increment that brought the entry to 2 filled, for 2 contracts, filled at 24990.25
        //   exit  "CB#1a2b3c4d exit f2 q2 p24990.25": a market exit sent when the stop level had already traded
        private static readonly Regex EntryNameRx = new Regex("^CB#([0-9a-f]{8})(?: bot)? s([0-9]{1,9}) t([0-9]{1,9})$");   // 0.4.0 bot: "CB#1a2b3c4d bot s8 t16" too (ChartBridgeBot.cs), ticks from each fill, as a market entry
        private static readonly Regex RestingNameRx = new Regex("^CB#([0-9a-f]{8}) atm s([0-9]{1,9}) t([0-9]{1,9})(?: (?:sl|mit)){0,1}$");   // 0.4.0 B1: " sl" stop-limit, " mit" MIT
        private static readonly Regex PlanNameRx = new Regex("^CB#([0-9a-f]{8}) plan s([0-9]{1,9}(?:\\.[0-9]{1,8})?) t([0-9]{1,9}(?:\\.[0-9]{1,8})?)$");

        private static bool IsEntryName(string name) { return name != null && (EntryNameRx.IsMatch(name) || RestingNameRx.IsMatch(name) || PlanNameRx.IsMatch(name) || IsStrategyName(name) || ChartBridgeAgents.IsEntryName(name)); }   // 0.4.0 B1: "CB#1a2b3c4d sg"   // 0.5.0 agents: "CB#1a2b3c4d ag:manrae s8 t16"
        private static bool IsResting(Order o) { return o.OrderType == OrderType.Limit || o.OrderType == OrderType.StopMarket || o.OrderType == OrderType.StopLimit || o.OrderType == OrderType.MIT; }   // 0.4.0 B1: stop-limit and MIT entries rest too
        private static readonly Regex LegNameRx = new Regex("^CB#([0-9a-f]{8}) (stop|target|exit) f([0-9]{1,6}) q([0-9]{1,6}) p([0-9]{1,9}(?:\\.[0-9]{1,8})?)(?: k([1-3])){0,1}$");   // 0.4.0 B1: " k2", a strategy's target bucket

        private class Bracket
        {
            public Account Account;
            public Instrument Instrument;
            public string Tag;
            public bool EntryIsBuy, AfterFlatten;   // AfterFlatten: Flatten was sent; a later fill still gets legs, and an alarm
            public int StopTicks, TargetTicks;      // ticks from each fill (0 = none); a resting entry's change with plan (read and written under Sync)
            public bool Resting;                    // a limit or stop entry: its ticks can be changed (plan), and are kept in planned_brackets.txt
            public bool PlanLost;                   // recovered without its planned_brackets.txt record: the name's ticks, with an alarm
            public string Converted;                // 0.3.7 planned prices turned into ticks at recovery: what to tell the page
            public bool ValueEstimated;             // recovered: CoveredValue partly unknown (contracts handled with no legs before a
                                                    // recompile); the next increment's price comes from NinjaTrader's executions, never an estimate
            public bool ConvertedNoStop;            // a 0.3.7 entry whose planned stop was on the wrong side of its price at conversion: NO STOP
            public int CoveredNoStop;               // contracts handled this session without a stop (no planned stop): for the plan alarm
            public int Covered;               // entry contracts already handled (legs, exit, or closed an opposite position)
            public double CoveredValue;       // sum of fill price times contracts for Covered
        }

        private class Pair
        {
            public Bracket Bracket;
            public Order Stop, Target;
            public int Qty;
        }

        private static string IdFor(Order o)
        {
            lock (Sync)
            {
                string id;
                if (!IdOf.TryGetValue(o, out id))
                {
                    id = "o" + (++nextId).ToString(CultureInfo.InvariantCulture);
                    IdOf[o] = id; ById[id] = o;
                }
                return id;
            }
        }

        private static string RoleFor(Order o)
        {
            string name = o.Name ?? "";
            if (IsEntryName(name)) return "entry";
            Match m = LegNameRx.Match(name);
            return m.Success && m.Groups[2].Value != "exit" ? m.Groups[2].Value : MergedRole(name) ?? "other";   // 0.4.0 B4: merged legs
        }

        private static bool IsExit(Order o) { Match m = LegNameRx.Match(AgentLegName(o.Name)); return m.Success && m.Groups[2].Value == "exit"; }   // 0.5.0 agents: "CB#<tag> ag:<id> protect f.." is an exit

        // A ChartBridge stop or target (not an entry, not a market exit).
        private static bool IsChartBridgeLeg(Order o) { Match m = LegNameRx.Match(o.Name ?? ""); return (m.Success && m.Groups[2].Value != "exit") || IsMergedLeg(o); }   // 0.4.0 B4: merged legs

        public static void Clear()
        {
            lock (Sync) { IdOf.Clear(); ById.Clear(); CidOf.Clear(); BracketOfEntry.Clear(); PairOfLeg.Clear(); LegBorn.Clear(); Settled.Clear(); Ours.Clear(); SeenFilled.Clear(); NotedFilled.Clear(); UnnotedSince.Clear(); LateSaid.Clear(); ExecSeq.Clear(); PosSeq.Clear(); GapSince.Clear(); Managed.Clear(); Uncovered.Clear(); Alarmed.Clear(); FlatSince.Clear(); LostTargets.Clear(); OcoWeCancel.Clear(); FirstGone.Clear(); }
            lock (Moves) { Moves.Clear(); LastPos.Clear(); }
            lock (Last) Last.Clear();
            lock (Suspect) Suspect.Clear();
            lock (ConnectedSince) ConnectedSince.Clear();
            lock (PlanMemLock) { Plans.Clear(); LegacyPlans.Clear(); plansLoaded = false; plansReadFailed = false; writeWaiting = false; writeFailed = null; planGeneration++; }
            lock (Sync) { PlanDeferred.Clear(); PlanWaitSince.Clear(); }
            MergeClear();   // 0.4.0 B4
            ClearStrategies();   // 0.4.0 B1
        }

        // ---------------------------------------------------------- strict message reading (gate 8)
        // Any quoted text followed by a colon is a key, so "qty " or "stop-loss" cannot slip past as not-a-key.
        private static readonly Regex KeyRx = new Regex("\"([^\"\\\\]*)\"\\s*:");
        private static readonly Dictionary<string, string[]> Keys = new Dictionary<string, string[]>
        {
            { "order", new[] { "type", "cid", "account", "root", "side", "kind", "qty", "price", "bracket" } },
            { "change", new[] { "type", "cid", "id", "price" } },
            { "plan", new[] { "type", "cid", "id", "stopTicks", "targetTicks" } },
            { "cancel", new[] { "type", "cid", "id", "from" } },   // 0.4.0 accounts: "from": "list" (the Working orders tab), refused unless cancelFromList is on
            { "flatten", new[] { "type", "cid", "account", "root" } },
            { "merge", new[] { "type", "cid", "account", "root" } },   // 0.4.0 B4
        };
        private static readonly string[] BracketKeys = { "stop", "target" };
        private static readonly Regex BracketRx = new Regex("\"bracket\"\\s*:\\s*\\{([^{}]*)\\}");

        // Top-level text with the bracket object cut out, or null (with why) if the message is not flat JSON.
        private static string TopLevel(string type, string text, out string bracketBody, out string why)
        {
            bracketBody = null; why = null;
            if (text.IndexOf('\\') >= 0) { why = "message has an escape sequence; ChartBridge's page never sends one"; return null; }
            Match bm = BracketRx.Match(text);
            string top = text;
            if (bm.Success) { bracketBody = bm.Groups[1].Value; top = text.Remove(bm.Index, bm.Length); }
            if (top.Count(ch => ch == '{') != 1 || top.Count(ch => ch == '[') != 0) { why = "message has an unexpected nested object or list"; return null; }
            if (Has(top, "bracket")) { why = "bracket must be an object like {\"stop\":8,\"target\":16}"; return null; }
            // 0.3.7: a bracket object belongs on order only; on plan, change or cancel it is refused. On flatten it is
            // still ignored, so Flatten is never refused for anything new.
            if (bracketBody != null && type != "order" && type != "flatten") { why = "unknown key \"bracket\" in " + type; return null; }
            if (Duplicate(top) || (bracketBody != null && Duplicate(bracketBody))) { why = "message has a key twice"; return null; }
            string[] allowed;
            if (!Keys.TryGetValue(type, out allowed)) { why = "unknown message type " + type; return null; }
            allowed = WithV3Keys(type, allowed);   // 0.4.0 B1: limitOffset and limitPrice on order, with orderTypes on
            string odd = Unknown(top, allowed) ?? (bracketBody != null ? Unknown(bracketBody, BracketKeys) : null);
            if (odd != null) { why = "unknown key \"" + odd + "\" in " + type; return null; }
            return top;
        }

        private static string Unknown(string text, string[] allowed)
        {
            foreach (Match m in KeyRx.Matches(text)) if (Array.IndexOf(allowed, m.Groups[1].Value) < 0) return m.Groups[1].Value;
            return null;
        }

        private static bool Duplicate(string text)
        {
            HashSet<string> seen = new HashSet<string>();
            foreach (Match m in KeyRx.Matches(text)) if (!seen.Add(m.Groups[1].Value)) return true;
            return false;
        }

        private static bool Has(string text, string key) { return Regex.IsMatch(text, "\"" + key + "\"\\s*:"); }

        // A plain string value with no escapes, or null if absent or not a plain string.
        private static string Str(string text, string key)
        {
            Match m = Regex.Match(text, "\"" + key + "\"\\s*:\\s*\"([^\"\\\\]{0,200})\"");
            return m.Success ? m.Groups[1].Value : null;
        }

        // 1 = a plain whole number (up to 9 digits), 0 = absent, -1 = present but not a plain whole number.
        private static int Int(string text, string key, out int value)
        {
            value = 0;
            if (!Has(text, key)) return 0;
            Match m = Regex.Match(text, "\"" + key + "\"\\s*:\\s*(-?(?:0|[1-9][0-9]{0,8}))\\s*[,}]");
            if (!m.Success) return -1;
            value = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
            return 1;
        }

        // A plain decimal price (no exponent), as Int above.
        private static int Dec(string text, string key, out double value)
        {
            value = 0;
            if (!Has(text, key)) return 0;
            Match m = Regex.Match(text, "\"" + key + "\"\\s*:\\s*((?:0|[1-9][0-9]{0,8})(?:\\.[0-9]{1,10})?)\\s*[,}]");
            if (!m.Success) return -1;
            value = double.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
            return 1;
        }

        // ---------------------------------------------------------- messages from the page
        // type is auth, order, change, plan (0.3.7; ticks since 0.3.8), cancel or flatten. Anything that fails a gate becomes a reject.
        public static void OnMessage(ChartBridgeClient client, string type, string text)
        {
            string cid = Str(text, "cid"), id = Str(text, "id");
            try
            {
                if (type == "auth") { Auth(client, text); return; }
                string why = Gate(client);
                string strategyBody = null;   // 0.4.0 B1: the strategy object, cut out as the bracket is (strategies on only)
                if (why == null && type == "order" && StrategiesOn) why = CutStrategy(ref text, out strategyBody);
                string bracketBody = null, top = why == null ? TopLevel(type, text, out bracketBody, out why) : null;
                if (why == null) why = QuoteOnly(top, id);   // 0.4.0: a quote-only market: refused before any other order code runs
                if (why == null && type != "flatten" && type != "merge") why = MergeFreezeWhy(type, top, id);   // 0.4.0 B4: a Merge swap freezes its account and root
                if (why != null) { Reject(client, cid, id, why); return; }
                if (type == "order") why = PlaceOrder(top, bracketBody, cid, strategyBody);
                else if (type == "change") why = ChangeOrder(top, id);
                else if (type == "plan") why = PlanOrder(top, id);
                else if (type == "cancel") why = CancelOrder(top, id);   // 0.4.0 accounts: top for "from"
                else if (type == "flatten") why = Flatten(top);
                else if (type == "merge") why = MergeStart(client, top, cid);   // 0.4.0 B4
                if (why != null) Reject(client, cid, id, why);
            }
            catch (Exception ex)
            {
                ChartBridgeServer.Log("order error: " + ex.Message);
                Reject(client, cid, id, "ChartBridge error: " + ex.Message);
            }
        }

        // 0.4.0: the quote-only markets (config.txt quoteRoots; YM, RTY, GC, SI, CL, 6E, ZN, ZB by default) stream to the page for
        // the Quote board; every order action for them is refused, with a plain reason. The root is the message's own (order,
        // flatten) or, for change, plan and cancel, that of the order it names.
        private static string QuoteOnly(string top, string id)
        {
            string root = (Str(top, "root") ?? "").ToUpperInvariant();
            if (root.Length == 0 && !string.IsNullOrEmpty(id))
            {
                Order o;
                lock (Sync) ById.TryGetValue(id, out o);
                if (o != null && o.Instrument != null && o.Instrument.MasterInstrument != null) root = (o.Instrument.MasterInstrument.Name ?? "").ToUpperInvariant();
            }
            if (root.Length == 0 || !ChartBridgeConfig.QuoteOnly(root)) return null;
            return root + " is quote only: ChartBridge shows its prices on the Quote board and refuses every order for it (quoteRoots in config.txt)";
        }

        private static void Auth(ChartBridgeClient client, string text)
        {
            string given = Str(text, "token");
            string reason = null;
            if (!Enabled) reason = "trading is off in config.txt";
            else if (!OriginAllowed(client.Origin)) reason = "orders are only accepted from ChartBridge's own page";
            else if (string.IsNullOrEmpty(given) || token.Length == 0 || !SlowEquals(given, token)) reason = "session token does not match; reload the page";
            client.Trader = reason == null;
            client.Send(ChartBridgeAccounts.TradingFor(client, TradingJson(client.Trader, reason)));   // 0.4.0 accounts: a v3 page also gets the switches
            List<string> warnings;
            lock (ConfigWarnings) warnings = client.Trader ? ConfigWarnings.ToList() : new List<string>();   // only to a page that signed in
            foreach (string w in warnings) client.Send("{\"type\":\"status\",\"level\":\"warn\",\"text\":" + CbJson.Str(w) + "}");
            if (client.Trader)   // 0.4.0 accounts: a v3 page sees every watched account
            {
                Snapshot(client, delegate(SnapNotes notes)   // 0.5.1: what NinjaTrader's thread sends meanwhile is sent again after the list (Snapshot)
                {
                    string list = OrdersListJson(client, notes.SentWorking);
                    List<string> positions = PositionJsons(client);
                    Action hook = SnapshotHook;
                    if (hook != null) hook();
                    client.Send(list);
                    foreach (string p in positions) client.Send(p);
                });
                ChartBridgeAccounts.SignedIn(client);
            }
            if (client.Trader) MergeOnAuth(client);   // 0.4.0 B4: a Merge cut by a restart is told to each page that signs in
            if (client.Trader) ChartBridgeCopier.AfterAuth(client);   // 0.4.0 copier: a v3 page gets the copier's state
            ChartBridgeBot.AfterAuth(client);   // 0.4.0 bot: a signed-in v3 page gets the bot strip and its open proposals
            try { ChartBridgeAgents.AfterAuth(client); } catch (Exception ex) { ChartBridgeServer.Log("agents error: " + ex.Message); }   // 0.5.0 agents: every agent's strip, open proposals, last plans and notes
            SendManagedTo(client);   // 0.4.0 B1: every live managed entry, to a signed-in v3 page
        }

        private static bool SlowEquals(string a, string b)
        {
            if (a.Length != b.Length) return false;
            int diff = 0;
            for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }

        // Gates 1, 4 and 7 for every order action.
        internal static string Gate(ChartBridgeClient client)   // 0.4.0 accounts: internal, so accountTrade and accountArchive pass the same gates
        {
            if (!Enabled) return "trading is off in config.txt";
            if (!client.Trader || !OriginAllowed(client.Origin)) return "this connection may not trade; reload ChartBridge's page";
            double now = ChartBridgeTime.NowUtcMs();
            lock (client.Actions)
            {
                while (client.Actions.Count > 0 && now - client.Actions.Peek() > 1000) client.Actions.Dequeue();
                if (client.Actions.Count >= MaxActionsPerSecond) return "too many order actions (more than " + MaxActionsPerSecond + " a second)";
                client.Actions.Enqueue(now);
            }
            return null;
        }

        // Gate 2. Returns the account, or null with why.
        private static Account FindAccount(string name, out string why)
        {
            why = null;
            if (!AccountTradable(name)) { why = ChartBridgeAccounts.On ? ChartBridgeAccounts.EntryRefusal(name) : "account " + (name ?? "(none)") + " may not trade from the chart (tradeAccounts in config.txt)"; return null; }   // 0.4.0 accounts: the checkmark's reason
            Account found = null;
            lock (Account.All)
                foreach (Account a in Account.All) if (a.Name.Equals(name, StringComparison.OrdinalIgnoreCase)) { found = a; break; }
            if (found == null) { why = "account " + name + (ChartBridgeAccounts.On ? " is not connected in NinjaTrader" : " is in tradeAccounts but not connected in NinjaTrader"); return null; }   // 0.4.0 accounts: no tradeAccounts in the reason when the checkmark is gate 2
            string status = StatusOf(found);
            if (status != "Connected") { why = "account " + name + " is not connected (" + status + ")"; return null; }
            if (!ChartBridgeServer.EnsureWatched(found)) { why = "ChartBridge is not listening to account " + name + " yet; try again in a few seconds"; return null; }
            return found;
        }

        private static bool OnGrid(double price, double tick) { double k = price / tick; return Math.Abs(k - Math.Round(k)) < 1e-6; }

        // Gate 5 for a limit or stop price. isBuy is the order's side.
        private static string PriceProblem(string root, double tick, string kind, bool isBuy, double price)
        {
            if (!(price > 0) || !OnGrid(price, tick)) return "price " + CbJson.Num(price) + " is not on the " + CbJson.Num(tick) + " tick grid";
            double last;
            string stale = LastPrice(root, out last);
            if (stale != null) return stale;
            if (MaxTicksAway > 0 && Math.Abs(price - last) > MaxTicksAway * tick + 1e-9)
                return "price is more than " + MaxTicksAway + " ticks from the last price " + CbJson.Num(last) + " (maxTicksAway in config.txt)";
            if (kind == "mit") return MitSide(isBuy, price, last);   // 0.4.0 B1: an MIT, a buy below the last price, a sell above
            if (kind == "stopLimit") kind = "stop";                  // 0.4.0 B1: a stop-limit's trigger follows the stop's rules
            if (kind == "stop" && isBuy && !(price > last)) return "a buy stop must be above the last price " + CbJson.Num(last);
            if (kind == "stop" && !isBuy && !(price < last)) return "a sell stop must be below the last price " + CbJson.Num(last);
            // A limit through the market fills at once: that is a market order in disguise, usually a click
            // meant as a stop, so it is refused.
            if (kind == "limit" && isBuy && price > last) return "a buy limit above the last price " + CbJson.Num(last) + " would fill at once; use a buy stop or a market order";
            if (kind == "limit" && !isBuy && price < last) return "a sell limit below the last price " + CbJson.Num(last) + " would fill at once; use a sell stop or a market order";
            return null;
        }

        private static bool SameInstrument(Instrument a, Instrument b) { return a != null && b != null && (a == b || a.FullName == b.FullName); }

        private static int SignedPosition(Account account, Instrument inst)
        {
            List<Position> positions;
            lock (account.Positions) positions = account.Positions.ToList();
            foreach (Position p in positions)
                if (SameInstrument(p.Instrument, inst))
                    return p.MarketPosition == MarketPosition.Long ? p.Quantity : p.MarketPosition == MarketPosition.Short ? -p.Quantity : 0;
            return 0;
        }

        // ---------------------------------------------------------- fills not yet in the position
        // NinjaTrader usually reports a fill on the order before it updates Account.Positions. Until the
        // position update lands, those contracts are kept here (account|contract -> [signed qty, time]),
        // so the cap and the bracket never read a stale position as smaller than it is. Entries expire
        // after MoveTtlMs in case a position update never comes.
        public const double MoveTtlMs = 10000;
        private static readonly Dictionary<string, List<double[]>> Moves = new Dictionary<string, List<double[]>>();

        private static string PosKey(Account a, Instrument i) { return (a != null ? a.Name : "") + "|" + (i != null ? i.FullName : ""); }

        private static void NoteFill(Order o)
        {
            int had, delta = 0;
            lock (Sync)
            {
                SeenFilled.TryGetValue(o, out had);
                if (o.Filled > had) { delta = o.Filled - had; SeenFilled[o] = o.Filled; }
            }
            if (delta == 0 || o.Account == null) return;
            string key = PosKey(o.Account, o.Instrument);
            lock (Moves)
            {
                List<double[]> list;
                if (!Moves.TryGetValue(key, out list)) Moves[key] = list = new List<double[]>();
                list.Add(new double[] { IsBuy(o) ? delta : -delta, ChartBridgeTime.NowUtcMs(), ChartBridgeCopier.IsCopyEntry(o) ? 1 : 0 });   // 0.4.0 copier: minors (2), a copy entry's fill is marked (third value 1)
            }
        }

        // A position update explains a change of (new position - last position seen) contracts: it consumes
        // that many reported fills of the same sign, oldest first. What it cannot explain yet (the position
        // update arrived before the order update) stays as a credit that the fill, when reported, cancels.
        private static readonly Dictionary<string, int> LastPos = new Dictionary<string, int>();

        private static void Booked(Account a, Instrument i, int signedNow)
        {
            string key = PosKey(a, i);
            lock (Moves)
            {
                int last;
                bool known = LastPos.TryGetValue(key, out last);
                LastPos[key] = signedNow;
                List<double[]> list;
                if (!Moves.TryGetValue(key, out list)) Moves[key] = list = new List<double[]>();
                if (!known) { list.Clear(); return; }
                int delta = signedNow - last;
                for (int k = 0; k < list.Count && delta != 0; k++)
                {
                    double v = list[k][0];
                    if (v == 0 || Math.Sign(v) != Math.Sign(delta)) continue;
                    double take = Math.Sign(v) * Math.Min(Math.Abs(v), Math.Abs(delta));
                    list[k][0] = v - take;
                    delta -= (int)take;
                }
                list.RemoveAll(m => m[0] == 0);
                if (delta != 0) list.Add(new double[] { -delta, ChartBridgeTime.NowUtcMs() });   // explained later by the fill
            }
        }

        // 0.4.3: an account just watched: its orders' fills so far count as come through (they are in its position already).
        public static void SeedNoted(Account a)
        {
            if (a == null) return;
            List<Order> orders;
            lock (a.Orders) orders = a.Orders.ToList();
            lock (Sync) foreach (Order o in orders) if (!NotedFilled.ContainsKey(o)) NotedFilled[o] = o.Filled;
        }

        private static int EffectivePosition(Account a, Instrument i)
        {
            int moved = 0;
            double now = ChartBridgeTime.NowUtcMs();
            lock (Moves)
            {
                List<double[]> list;
                if (Moves.TryGetValue(PosKey(a, i), out list)) foreach (double[] m in list) if (now - m[1] <= MoveTtlMs) moved += (int)m[0];
            }
            return SignedPosition(a, i) + moved;
        }

        // An order that may still fill: anything not filled, cancelled or rejected (a cancel still pending
        // can lose the race and fill).
        private static bool MayFill(OrderState s) { return !IsDone(s); }

        // Contracts still to fill on every order that may still fill for this account and contract, by
        // side (any order, from the chart or not, bracket legs too, and ChartBridge's own orders even
        // before NinjaTrader lists them). Orders sharing an OCO id fill one at a time, so a group counts
        // once, at its largest.
        private static void PendingOrders(Account account, Instrument inst, out int buys, out int sells) { int lb, ls; PendingOrders(account, inst, out buys, out sells, out lb, out ls); }

        // 0.5.3 re-review: loneBuys and loneSells, the part of buys and sells in orders that are no bracket leg or merged set (no OCO
        // id, no group): a page exit already working counts there, an agent's stop and target do not.
        private static void PendingOrders(Account account, Instrument inst, out int buys, out int sells, out int loneBuys, out int loneSells)
        {
            buys = 0; sells = 0; loneBuys = 0; loneSells = 0;
            List<Order> orders;
            lock (account.Orders) orders = account.Orders.ToList();
            lock (Sync) foreach (Order o in Ours) if (o.Account == account && !orders.Contains(o)) orders.Add(o);
            Dictionary<string, int> groups = new Dictionary<string, int>();   // "b|oco" or "s|oco" -> largest left
            foreach (Order o in orders)
            {
                if (!SameInstrument(o.Instrument, inst) || !MayFill(o.OrderState)) continue;
                int left = Math.Max(0, o.Quantity - o.Filled), had;
                string grp = MergeUnitKey(o);   // 0.4.0 B4: the OCO id, or a merged set's group
                if (grp == null) { if (IsBuy(o)) { buys += left; loneBuys += left; } else { sells += left; loneSells += left; } continue; }
                string key = (IsBuy(o) ? "b|" : "s|") + grp;
                if (!groups.TryGetValue(key, out had) || left > had) groups[key] = left;
            }
            foreach (KeyValuePair<string, int> g in groups) { if (g.Key[0] == 'b') buys += g.Value; else sells += g.Value; }
        }

        private static bool IsBuy(Order o) { return o.OrderAction == OrderAction.Buy || o.OrderAction == OrderAction.BuyToCover; }

        private static bool isBuyOrder(string top) { return Str(top, "side") == "buy"; }

        private static string PlaceOrder(string top, string bracketBody, string cid, string strategyBody) { Order ignored; return PlaceOrder(top, bracketBody, cid, strategyBody, false, out ignored); }

        // 0.4.0 bot: a bot entry (ChartBridgeBot.cs builds the message from the bot's or the proposal's own parameters, always
        // Sim101 and the bot's root), through the same strict reading, quote-only check and gates as an order from the page.
        // Integration: never a strategy (no strategy object is cut out of a bot message, so a "strategy" key is refused as unknown).
        public static string PlaceBotEntry(string text, out Order placed)
        {
            placed = null;
            string bracketBody, why, top = TopLevel("order", text, out bracketBody, out why);
            if (why == null) why = QuoteOnly(top, null);
            return why ?? PlaceOrder(top, bracketBody, null, null, true, out placed);
        }

        // 0.4.0 bot: the bot's flatten (auto mode only, ChartBridgeBot.cs): v2 Flatten on the bot's account and root.
        public static string FlattenForBot(string root) { return Flatten("{\"account\":" + CbJson.Str(ChartBridgeBot.BotAccount) + ",\"root\":\"" + root + "\"}"); }

        // 0.4.0 minors (3): botAccount's check. Any position (either reading: listed, or a fill not yet in it), or any order that may
        // still fill (NinjaTrader's list and ChartBridge's own just sent), on root in any contract month, on this account.
        internal static bool BotHoldsOnRoot(Account a, string root)
        {
            if (a == null || string.IsNullOrEmpty(root)) return false;
            Func<Instrument, bool> onRoot = i => i != null && ((i.MasterInstrument != null && string.Equals(i.MasterInstrument.Name, root, StringComparison.OrdinalIgnoreCase)) || ChartBridgeServer.RootFor(i) == root);
            List<Position> positions;
            lock (a.Positions) positions = a.Positions.ToList();
            if (positions.Any(p => onRoot(p.Instrument) && p.MarketPosition != MarketPosition.Flat && p.Quantity != 0)) return true;
            List<Order> orders;
            lock (a.Orders) orders = a.Orders.ToList();
            lock (Sync) foreach (Order o in Ours) if (o.Account == a && !orders.Contains(o)) orders.Add(o);
            if (orders.Any(o => onRoot(o.Instrument) && MayFill(o.OrderState))) return true;
            double now = ChartBridgeTime.NowUtcMs();
            string prefix = a.Name + "|" + root + " ";
            lock (Moves)
                foreach (KeyValuePair<string, List<double[]>> kv in Moves)
                    if (kv.Key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && kv.Value.Where(m => now - m[1] <= MoveTtlMs).Sum(m => m[0]) != 0) return true;
            return false;
        }

        private static string PlaceOrder(string top, string bracketBody, string cid, string strategyBody, bool bot, out Order placed) { return PlaceOrder(top, bracketBody, cid, strategyBody, bot, null, out placed); }

        // agent (0.5.0 agents): the agent id when an agent places it (ChartBridgeAgents.cs, PlaceAgentEntry), else null.
        private static string PlaceOrder(string top, string bracketBody, string cid, string strategyBody, bool bot, string agent, out Order placed)
        {
            string planTag, why;
            lock (PlaceLock) why = PlaceOrderLocked(top, bracketBody, cid, strategyBody, bot, agent, out planTag, out placed);   // two pages or tabs cannot both pass the cap check
            if (planTag != null)
            {
                // The record is what a recompile reads. Its name holds the same ticks, so a failed write does not refuse the
                // order, but it is loud (0.3.8: on HOME the file stayed empty while an entry rested), and the 2 second check
                // writes it again until it succeeds.
                string err = WritePlans();
                if (err != null) PlanSaveAlarm("the planned stop and target of entry CB#" + planTag + " could not be saved (" + err + ")");
            }
            return why;
        }

        private static string PlaceOrderLocked(string top, string bracketBody, string cid, string strategyBody, bool bot, string agent, out string planTag, out Order placed)
        {
            planTag = null; placed = null;
            string accountName = Str(top, "account"), root = (Str(top, "root") ?? "").ToUpperInvariant();
            string side = Str(top, "side"), kind = Str(top, "kind"), why;
            Account account = FindAccount(accountName, out why);
            if (account == null) return why;
            Instrument inst = ChartBridgeServer.InstrumentFor(root);
            if (inst == null) return "instrument " + root + " is not served by ChartBridge";
            // 0.5.0 agents: the owner lock, here where every entry of the page, the bot and every agent passes (the copier's own
            // entries ask the same in its Eligible): an agent's (account, root) refuses every other source; an agent is refused
            // wherever anything else is held or working. Exits never come here.
            // A page MARKET order that only reduces (no bracket, no strategy, the other side of the position by both readings, at most
            // the smaller of them) is an exit: it passes. A resting page order there is refused (it would outlive the position).
            bool pageReduces = false;
            int rq;
            if (ChartBridgeAgents.Enabled && !bot && agent == null && kind == "market" && bracketBody == null && strategyBody == null && Int(top, "qty", out rq) == 1 && rq >= 1)
            {
                int pn = SignedPosition(account, inst), pe = EffectivePosition(account, inst), along = Str(top, "side") == "buy" ? -1 : 1;
                pageReduces = pn * along > 0 && pe * along > 0 && rq <= Math.Min(Math.Abs(pn), Math.Abs(pe));
            }
            string ownerWhy = pageReduces ? null : ChartBridgeAgents.EntryCheck(agent != null ? "agent:" + agent : bot ? "bot" : "page", account, root);
            if (ownerWhy != null) return ownerWhy;
            string exitOf = pageReduces ? ChartBridgeAgents.OwnerAgent(account.Name, root) : null;   // 0.5.3 review: a page exit from an agent's position
            if (side != "buy" && side != "sell") return "side must be buy or sell";
            if (kind != "market" && kind != "limit" && kind != "stop" && !(OrderTypesOn && NewKind(kind))) return "kind must be market, limit or stop";   // 0.4.0 B1: stopLimit, mit
            if (bot && (NewKind(kind) || strategyBody != null)) return "the bot places market, limit and stop entries with a plain stop and target only";   // 0.4.0 bot: (integration) never a new kind or an Order Strategy
            if (agent != null && ((kind != "limit" && kind != "stopLimit") || strategyBody != null || bracketBody == null)) return "an agent's entry is a limit or a stop-limit with a stop and a target";   // 0.5.0 agents: never market, stop or MIT, never a strategy
            int qty;
            if (Int(top, "qty", out qty) != 1 || qty < 1) return "qty must be a whole number of 1 or more";
            bool isBuy = side == "buy";
            // The position two ways: as NinjaTrader lists it, and with fills reported but not yet in it. Event
            // order differs between connections, so either can be the stale one: the cap takes the worse.
            int posNow = SignedPosition(account, inst), posEff = EffectivePosition(account, inst), pendBuy, pendSell;
            int cap = CapFor(root), pos = isBuyOrder(top) ? Math.Max(posNow, posEff) : Math.Min(posNow, posEff);
            string capWhy = "maxQty." + root + " in config.txt";   // 0.5.3 review: the words name the cap that applied
            if (bot) cap = Math.Min(cap, ChartBridgeBot.MaxQty);   // 0.4.0 bot: the 1 contract rail, on the order and the position (gate 3's own count)
            if (agent != null) cap = AgentEntryCap(agent, root, out capWhy);   // 0.5.0 agents: the agent's maxQty, never above the hard ceiling (minis 2, micros 20), on the order and the position; 0.5.3: MNQ never maxQty.MNQ
            // 0.5.3 review: a page exit from an agent's position skips the per-order qty check (pageReduces: at most the smaller
            // reading, never a flip or an add), and the position count is held to the agent's cap (AgentExitCap), never below the
            // page's: Anthony may sell 5 of an agent's 20 MNQ with config.txt's MNQ cap at 1. 0.5.3 re-review: held is read here
            // again (gate 3's own readings: a fill since the owner lock's reading cannot turn an exit into an entry).
            int held = isBuy ? (posNow < 0 && posEff < 0 ? Math.Min(-posNow, -posEff) : 0) : (posNow > 0 && posEff > 0 ? Math.Min(posNow, posEff) : 0);
            if (exitOf != null) { string ew; int ec = AgentExitCap(exitOf, root, held, out ew); if (ec > cap) { cap = ec; capWhy = ew; } }
            if (exitOf == null && qty > cap) return "qty " + qty + " is over the " + root + " cap of " + cap + " (" + capWhy + ")";
            int loneBuy, loneSell;
            PendingOrders(account, inst, out pendBuy, out pendSell, out loneBuy, out loneSell);
            // 0.5.3 re-review: an exit, with the page's exits still working on that side (orders that are no bracket leg), closes at
            // most the position: two quick sells of 5 on a long 5 never flip it. The agent's own stop and target are not counted
            // here (they shrink with the position), so the rest can be sold before they are shrunk.
            int loneSide = isBuy ? loneBuy : loneSell;
            if (exitOf != null && (long)loneSide + qty > held)
                return "this exit would close " + (loneSide + qty) + " " + root + " contracts (working exits " + loneSide + ", this order " + qty + ") of agent " + exitOf +
                       "'s position of " + held + ": an exit closes at most the position (use Flatten to close it all)";
            long worst = isBuy ? (long)pos + pendBuy + qty : (long)(-pos) + pendSell + qty;
            if (worst > cap)
                return "this order could make the " + root + " position " + worst + " contracts (position " + pos + ", working " +
                       (isBuy ? pendBuy : pendSell) + ", this order " + qty + "); the cap is " + cap + " (" + capWhy + ")";
            double tick = inst.MasterInstrument.TickSize, price = 0, limitPx = 0;
            if (kind != "market")
            {
                if (Dec(top, "price", out price) != 1) return "a " + kind + " order needs a plain price";
                string bad = PriceProblem(root, tick, kind, isBuy, price);
                if (bad != null) return bad;
            }
            else if (Has(top, "price")) return "a market order takes no price";
            string newKind = OrderTypesOn ? NewKindProblem(top, kind, root, tick, isBuy, price, out limitPx) : null;   // 0.4.0 B1: a stop-limit's limit
            if (newKind != null) return newKind;
            if (agent != null) { string agentWhy = ChartBridgeAgents.PlacingProblem(agent, kind, isBuy, price, limitPx, tick); if (agentWhy != null) return agentWhy; }   // 0.5.0 agents: its window, mode, kill and stop-limit band, here too
            int stopTicks = 0, targetTicks = 0;
            if (bracketBody != null)
            {
                if (Int("{" + bracketBody + "}", "stop", out stopTicks) != 1 || Int("{" + bracketBody + "}", "target", out targetTicks) != 1)
                    return "bracket needs both stop and target as whole numbers of ticks (0 for none)";
                if (stopTicks < 0 || targetTicks < 0) return "bracket ticks must be whole numbers of 0 or more";
                if (MaxBracketTicks > 0 && (stopTicks > MaxBracketTicks || targetTicks > MaxBracketTicks))
                    return "bracket ticks must be from 0 to " + MaxBracketTicks + " (maxBracketTicks in config.txt)";
            }
            StratParams strat = null;   // 0.4.0 B1: an Order Strategy (strategyBody is cut out only with strategies on)
            if (strategyBody != null)
            {
                string off = StrategiesRunRefusal();   // 0.4.0 fix1 (F5): managed.txt unreadable at the start (or not read yet): no new strategy entry
                if (off != null) return off;
                string bad = ParseStrategy(strategyBody, out strat);
                if (bad != null) return bad;
                stopTicks = strat.Stop + Math.Max(0, strat.StopLimit); targetTicks = strat.MaxTarget;   // for the leg-at-or-below-zero check
            }
            if (stopTicks > 0 || targetTicks > 0)
            {
                // A huge bracket could put a leg at or below zero: checked from the entry's price, or for a market order from
                // the last price when there is one.
                double from = price;
                if (kind == "market" && LastPrice(root, out from) != null) from = 0;
                if (from > 0 && !(isBuy ? from - stopTicks * tick > 0 : from - targetTicks * tick > 0))
                    return "the bracket would put a leg at or below zero from " + (kind == "market" ? "the last price " : "the entry price ") + CbJson.Num(from);
            }
            bool wantsLegs = stopTicks > 0 || targetTicks > 0;
            if (agent != null && (stopTicks < 1 || targetTicks < 1)) return "every agent entry needs a stop and a target";   // 0.5.0 agents
            // Refused only when both readings agree the order reduces the position (legs on a reducing order
            // could open a new position; one stale reading must not block a fresh entry).
            bool reduces = ((posNow > 0 && !isBuy) || (posNow < 0 && isBuy)) && ((posEff > 0 && !isBuy) || (posEff < 0 && isBuy));
            if (wantsLegs && reduces) return (strat != null ? "a strategy" : "a bracket") + " can only go on an order that opens or adds; this order reduces the position";
            string copierWhy = bot ? ChartBridgeCopier.BotEntryCheck(account) : ChartBridgeCopier.LeaderEntryCheck(account, stopTicks > 0);   // 0.4.0 copier: a leader entry needs a stop while armed (integration: a bot entry is never a leader entry, and never on the leader's account; a strategy's stop counts)
            if (copierWhy != null) return copierWhy;   // 0.4.0 copier:
            string tag = Guid.NewGuid().ToString("N").Substring(0, 8);
            // 0.3.8: a resting entry is named "atm": its ticks can change before the fill (plan), and travel with it when moved.
            string name = "CB#" + tag + (bot ? " bot" : kind == "market" ? "" : " atm") + (strat != null ? StrategyNamePart(strat) : " s" + stopTicks + " t" + targetTicks) + KindSuffix(kind);   // 0.4.0 bot: "bot" names a bot entry   // 0.4.0 B1: sg, sl, mit   // 0.4.0 fix1 (F5): "sg s20", the stop ticks in the name
            if (agent != null) name = "CB#" + tag + " ag:" + agent + " s" + stopTicks + " t" + targetTicks;   // 0.5.0 agents: "CB#1a2b3c4d ag:manrae s8 t16" (any kind; recovery reads it as a v2 entry)
            if (kind != "market" && strat == null) { SetPlan(tag, stopTicks, targetTicks); planTag = tag; }   // in memory now; PlaceOrder writes the file after PlaceLock
            OrderType type = OrderTypeOf(kind);   // 0.4.0 B1: also StopLimit and MIT
            Order order = account.CreateOrder(inst, isBuy ? OrderAction.Buy : OrderAction.Sell, type, OrderEntry.Manual, TimeInForce.Day, qty,
                kind == "limit" ? price : kind == "stopLimit" ? limitPx : 0, kind == "stop" || NewKind(kind) ? price : 0, "", name, NinjaTrader.Core.Globals.MaxDate, null);
            lock (Sync)
            {
                IdFor(order);
                Ours.Add(order);
                if (!string.IsNullOrEmpty(cid)) CidOf[order] = cid;
                if (strat != null) { BracketOfEntry[order] = new Bracket { Account = account, Instrument = inst, Tag = tag, EntryIsBuy = isBuy, StopTicks = strat.Stop }; NewManaged(tag, order, account, inst, isBuy, root, strat); }   // 0.4.0 B1
                else if (kind != "market")
                    BracketOfEntry[order] = new Bracket { Account = account, Instrument = inst, Tag = tag, EntryIsBuy = isBuy, Resting = true, StopTicks = stopTicks, TargetTicks = targetTicks };
                else if (stopTicks > 0 || targetTicks > 0)
                    BracketOfEntry[order] = new Bracket { Account = account, Instrument = inst, Tag = tag, EntryIsBuy = isBuy, StopTicks = stopTicks, TargetTicks = targetTicks };
            }
            if (strat != null) { string unsaved = SaveNewManaged(tag, order); if (unsaved != null) return unsaved; }   // 0.4.0 fix1 (F5): accepted only once its managed.txt line is written
            if (!bot) ChartBridgeCopier.LeaderEntryRegister(order, kind, price);   // 0.4.0 copier: the page's entries on the leader are copied (integration: a bot entry never is); review 2: registered before Submit, so a fill inside Submit is copied
            try { account.Submit(new[] { order }); }
            catch (Exception) { lock (Sync) Ours.Remove(order); if (!bot) ChartBridgeCopier.LeaderEntryDropped(order); throw; }   // 0.4.0 copier: review 2: never reached NinjaTrader, nothing copied; 0.4.3 review (4): never sent, so never "may still fill"
            placed = order;
            if (!bot) ChartBridgeCopier.LeaderEntrySent(order);   // 0.4.0 copier: orders mode places the followers' orders now (a rejected entry is dropped)
            ChartBridgeServer.Log((bot ? "bot " : agent != null ? "agent " + agent + " " : "") + "order sent: " + side + " " + qty + " " + root + " " + kind + (kind == "market" ? "" : " @ " + CbJson.Num(price)) +
                (strat != null ? " with strategy " + strat.Json : wantsLegs ? " with bracket stop " + stopTicks + " / target " + targetTicks + " ticks" : "") + " on " + account.Name);
            return null;
        }

        // A price in a planned_brackets.txt line kept from 0.3.7: 0 for none, else the price with no trailing zeros.
        private static string PriceText(double p) { return p > 0 ? p.ToString("0.########", CultureInfo.InvariantCulture) : "0"; }
        private static string TicksText(int t) { return t > 0 ? t.ToString(CultureInfo.InvariantCulture) : "none"; }

        private static string ChangeOrder(string top, string id)
        {
            Order o;
            lock (Sync) ById.TryGetValue(id ?? "", out o);
            if (o == null) return "no working order " + (id ?? "(none)");
            // 0.4.0 accounts: with accountChecks on, moving a ChartBridge stop or target is an exit (no checkmark needed, closing
            // always works); moving an entry, or an order placed elsewhere, is an entry action (the checkmark).
            string exitWhy = null;
            bool exit = ChartBridgeAccounts.On && IsChartBridgeLeg(o);
            if (o.Account == null || !(exit ? ChartBridgeAccounts.ExitAllowed(o.Account, out exitWhy) : AccountTradable(o.Account.Name))) return exitWhy ?? "that order's account may not trade from the chart";
            if (!IsWorking(o.OrderState)) return "that order is no longer working";
            double price;
            if (Dec(top, "price", out price) != 1) return "change needs a plain price";
            string root = ChartBridgeServer.RootFor(o.Instrument);
            if (root == null) return "instrument is not served by ChartBridge";
            if (MovesNewKind(o)) return MoveNewKind(o, root, price);   // 0.4.0 B1: a ChartBridge stop-limit (keeps its offset) or MIT
            if (o.OrderType == OrderType.StopLimit) return "stop-limit orders can only be moved in NinjaTrader";
            string kind = o.OrderType == OrderType.Limit ? "limit" : o.OrderType == OrderType.StopMarket ? "stop" : null;
            if (kind == null) return "only limit and stop orders can be moved";
            double tick = o.Instrument.MasterInstrument.TickSize;
            string bad = PriceProblem(root, tick, kind, IsBuy(o), price);
            if (bad != null) return bad;
            // 0.3.8 (Anthony's ATM rule): a resting entry's planned stop and target are ticks from its fill, so they travel with
            // it when it moves; a move is never refused for its bracket.
            if (kind == "limit") o.LimitPriceChanged = price; else o.StopPriceChanged = price;
            o.Account.Change(new[] { o });
            ChartBridgeServer.Log("order moved: " + (o.Name ?? "") + " to " + CbJson.Num(price) + " on " + o.Account.Name);
            return null;
        }

        // 0.3.8: set, change or remove the planned stop and target distances of a resting ChartBridge entry (limit or stop).
        //   {"type":"plan","id":"o5","stopTicks":12}            the stop 12 ticks from each fill still to come (the target kept)
        //   {"type":"plan","id":"o5","targetTicks":null}        no target
        // Each key is optional (absent = unchanged), at least one is needed; a whole number of 1 or more sets it (at most
        // maxBracketTicks when config.txt sets it), null removes it. The ticks are set in memory at once under Sync, together
        // with the check that no fill is waiting to be handled (the fill path holds Sync too), and used for every fill
        // increment ChartBridge has not yet placed legs for. Then saved to planned_brackets.txt, outside every lock; a failed
        // save still keeps the plan (the fill path uses what Anthony set), raises an alarm, and is tried again every 2
        // seconds. Legs already working for earlier fill increments are not touched: they move with change, as B/E does.
        private static readonly object PlanLock = new object();   // one plan change at a time
        // S1: resting entries whose bracket waits for planned_brackets.txt to be read (Sync), with who saw them first: true an
        // order event (a live fill: placed as its event would have, the moment the file is read), false the 2 s scan (a fill
        // from while ChartBridge was stopped: P8, left to the scan, which legs only what the listed position still holds).
        // And since when the scan has seen one with fills and no legs (an alarm after PlanReadAlarmMs).
        private static readonly Dictionary<Order, bool> PlanDeferred = new Dictionary<Order, bool>();
        private static readonly Dictionary<Order, double> PlanWaitSince = new Dictionary<Order, double>();
        public const double PlanReadAlarmMs = 3000;

        // 1 = a plain whole number of 1 or more (max set by maxBracketTicks), 0 = absent, 2 = null (remove), -1 = anything else.
        private static int TicksOf(string top, string key, out int v)
        {
            v = 0;
            if (!Has(top, key)) return 0;
            if (IsNull(top, key)) return 2;
            if (Int(top, key, out v) != 1 || v < 1) return -1;
            return 1;
        }

        private static string PlanOrder(string top, string id)
        {
            Order o;
            lock (Sync) ById.TryGetValue(id ?? "", out o);
            if (o == null) return "no working order " + (id ?? "(none)");
            if (o.Account == null || !AccountTradable(o.Account.Name)) return "that order's account may not trade from the chart";
            string root = ChartBridgeServer.RootFor(o.Instrument);
            if (root == null) return "instrument is not served by ChartBridge";
            if (!IsWorking(o.OrderState)) return "that order is no longer working";
            if (RoleFor(o) != "entry") return "only a ChartBridge entry has a planned stop and target; a working leg moves with change";
            if (IsStrategyName(o.Name)) return "a plan on an Order Strategy entry is refused: cancel it and place it again with the strategy you want";   // 0.4.0 B1 (lead's default)
            if (!IsResting(o)) return "only a resting limit or stop entry has a planned stop and target";
            int st, tt, hs = TicksOf(top, "stopTicks", out st), ht = TicksOf(top, "targetTicks", out tt);
            if (hs == 0 && ht == 0) return "plan needs stopTicks or targetTicks (a whole number of ticks to set it, null to remove it)";
            if (ChartBridgeAgents.IsEntryName(o.Name) && (hs == 2 || ht == 2 || hs < 0 || ht < 0)) return "an agent's entry always has a stop and a target";   // 0.5.0 agents (lead's default): new distances of 1 or more only
            if (hs < 0) return "stopTicks must be a whole number of 1 or more, or null to remove the stop";
            if (ht < 0) return "targetTicks must be a whole number of 1 or more, or null to remove the target";
            if (MaxBracketTicks > 0 && ((hs == 1 && st > MaxBracketTicks) || (ht == 1 && tt > MaxBracketTicks)))
                return (hs == 1 && st > MaxBracketTicks ? "stopTicks" : "targetTicks") + " must be at most " + MaxBracketTicks + " (maxBracketTicks in config.txt)";
            Bracket br = BracketFor(o);
            if (br == null && !PlansLoaded()) return "ChartBridge is still reading planned_brackets.txt (it just started); try again in a moment";
            if (br == null || !br.Resting) return "this entry has no planned stop and target to change";
            bool buy = IsBuy(o);
            string where = Where(o.Account, o.Instrument), saveErr;
            int newSt, newTt, noStop;
            lock (PlanLock)
            {
                if (!IsWorking(o.OrderState)) return "that order is no longer working";
                int oldSt, oldTt;
                lock (Sync) { oldSt = br.StopTicks; oldTt = br.TargetTicks; }
                newSt = hs == 1 ? st : hs == 2 ? 0 : oldSt;
                newTt = ht == 1 ? tt : ht == 2 ? 0 : oldTt;
                // Adding a stop or target to an entry that had none is a new bracket: refused on an order that would
                // reduce the position (by both readings), as at placement.
                if (oldSt == 0 && oldTt == 0 && (newSt > 0 || newTt > 0))
                {
                    int posNow = SignedPosition(o.Account, o.Instrument), posEff = EffectivePosition(o.Account, o.Instrument);
                    bool reduces = ((posNow > 0 && !buy) || (posNow < 0 && buy)) && ((posEff > 0 && !buy) || (posEff < 0 && buy));
                    if (reduces) return "a bracket can only go on an order that opens or adds; this order reduces the position";
                }
                // Set in memory together with the check that every fill NinjaTrader has reported is handled: the fill
                // path holds Sync while it takes an increment and while it reads the ticks for its legs.
                int waiting;
                lock (Sync)
                {
                    waiting = o.Filled - br.Covered;
                    if (waiting <= 0) { br.StopTicks = newSt; br.TargetTicks = newTt; br.PlanLost = false; if (newSt > 0) br.ConvertedNoStop = false; }
                    noStop = br.CoveredNoStop;
                }
                if (waiting > 0)
                {
                    // A fill got there first: those contracts get the plan as it was. Refused, so the page never
                    // believes they have the new distances.
                    if (!(oldSt > 0))
                        Alarm(where + ": " + waiting + " contract(s) of entry CB#" + br.Tag + " filled before the plan arrived and get NO STOP (the entry had no planned stop); a position may be open without a stop; add a stop in NinjaTrader or on the chart");
                    return waiting + " contract(s) filled before this plan arrived; they get the planned " + (oldSt > 0 || oldTt > 0 ? "stop " + TicksText(oldSt) + " / target " + TicksText(oldTt) + " ticks as it was" : "nothing (no stop, no target)") +
                           "; nothing changed: send the plan again for the contracts still to fill";
                }
                SetPlan(br.Tag, newSt, newTt);
            }
            ChartBridgeServer.Log("planned bracket set: " + (o.Name ?? "") + " stop " + TicksText(newSt) + " / target " + TicksText(newTt) + " ticks" +
                (o.Filled > 0 ? " (for the " + (o.Quantity - o.Filled) + " contract(s) still to fill)" : "") + " on " + o.Account.Name);
            if (noStop > 0 && newSt > 0)
                Alarm(where + ": " + noStop + " contract(s) of entry CB#" + br.Tag + " already filled with NO STOP; the planned stop of " + newSt + " ticks is for the contracts still to fill; add a stop for them");
            saveErr = WritePlans();   // outside every lock; the plan is already in force
            if (saveErr != null)
                PlanSaveAlarm(where + ": the planned stop and target of entry CB#" + br.Tag + " are set (stop " + TicksText(newSt) + " / target " + TicksText(newTt) +
                      " ticks) but could not be saved (" + saveErr + "); after a recompile or restart it would use the ticks it was placed with");
            if (Enabled && ChartBridgeAccounts.Seen(o.Account.Name)) ChartBridgeAccounts.SendScoped(o.Account, OrderJson(o, null), true, o);   // the page sees the new planned ticks (0.4.0 accounts: each page its scope)   // 0.4.0 review 2: o for a v3 page's "by"
            return null;
        }

        private static bool IsNull(string text, string key) { return Regex.IsMatch(text, "\"" + key + "\"\\s*:\\s*null\\s*[,}]"); }

        private static string CancelOrder(string top, string id)
        {
            // 0.4.0 accounts: "from": "list" (the Working orders tab) only with cancelFromList on; any other "from" is refused.
            string why = ChartBridgeAccounts.CancelFromRefusal(Has(top, "from"), Str(top, "from"));
            if (why != null) return why;
            // 0.4.0 accounts: a cancel from the list, or any cancel with accountChecks on, is an exit: a watched, Connected,
            // non-archived account, checkmark or not. Otherwise v2's tradeAccounts, exactly as before.
            bool exit = Has(top, "from") || ChartBridgeAccounts.On;
            Order o;
            lock (Sync) ById.TryGetValue(id ?? "", out o);
            if (o == null) return "no working order " + (id ?? "(none)");
            if (o.Account == null || !(exit ? ChartBridgeAccounts.ExitAllowed(o.Account, out why) : AccountTradable(o.Account.Name))) return why ?? "that order's account may not trade from the chart";
            if (ChartBridgeServer.RootFor(o.Instrument) == null) return "instrument is not served by ChartBridge";
            if (!IsWorking(o.OrderState)) return "that order is no longer working";
            o.Account.Cancel(new[] { o });     // OCO: the broker or NinjaTrader cancels the other leg
            ChartBridgeServer.Log("order cancel sent: " + (o.Name ?? "") + " on " + o.Account.Name);
            return null;
        }

        private static string Flatten(string top)
        {
            string accountName = Str(top, "account"), root = (Str(top, "root") ?? "").ToUpperInvariant(), why;
            Account account = ChartBridgeAccounts.On ? ChartBridgeAccounts.FindForExit(accountName, out why) : FindAccount(accountName, out why);   // 0.4.0 accounts: Flatten is an exit (no checkmark needed)
            if (account == null) return why;
            Instrument inst = ChartBridgeServer.InstrumentFor(root);
            if (inst == null) return "instrument " + root + " is not served by ChartBridge";
            lock (Sync)
                foreach (Bracket br in BracketOfEntry.Values)
                    if (br.Account == account && SameInstrument(br.Instrument, inst)) br.AfterFlatten = true;   // a late fill raises an alarm
            StopManaging(account, inst);   // 0.4.0 B1: no breakeven or trailing move races the flatten
            NoteWeCancelSafe(() => WorkingLegs(account, inst), "flatten");   // the flatten cancels these pairs: not a stop lost with its target
            // 0.4.0 fix1 (F1): a Merge swap on this account and root ends only here, once Flatten passed its gates, in one step with
            // the flatten call (MergeFlattenSend); a refused Flatten leaves the swap to go on or restore as before.
            MergeFlattenSend(account, inst, () => account.Flatten(new[] { inst }));   // cancels working orders for the instrument, then closes the position
            ChartBridgeServer.Log("flatten sent: " + root + " on " + account.Name);
            return null;
        }

        private static void Reject(ChartBridgeClient client, string cid, string id, string reason)
        {
            client.Send("{\"type\":\"reject\"" + (cid != null ? ",\"cid\":" + CbJson.Str(cid) : "") + (id != null ? ",\"id\":" + CbJson.Str(id) : "") + ",\"reason\":" + CbJson.Str(reason) + "}");
        }

        private static void Alarm(string text)
        {
            ChartBridgeServer.Log("ALERT: " + text);
            ChartBridgeServer.SendToTraders("{\"type\":\"status\",\"level\":\"error\",\"text\":" + CbJson.Str(text) + "}");
        }

        private static void Warn(string text)
        {
            ChartBridgeServer.Log("NOTE: " + text);
            ChartBridgeServer.SendToTraders("{\"type\":\"status\",\"level\":\"warn\",\"text\":" + CbJson.Str(text) + "}");
        }

        // ---------------------------------------------------------- events from NinjaTrader
        public static bool IsWorking(OrderState s)
        {
            return s == OrderState.Initialized || s == OrderState.Submitted || s == OrderState.Accepted || s == OrderState.TriggerPending ||
                   s == OrderState.Working || s == OrderState.ChangePending || s == OrderState.ChangeSubmitted || s == OrderState.PartFilled;
        }

        private static bool IsDone(OrderState s) { return s == OrderState.Filled || s == OrderState.Cancelled || s == OrderState.Rejected; }

        private static string StateText(OrderState s)
        {
            if (s == OrderState.Filled) return "filled";
            if (s == OrderState.PartFilled) return "partFilled";
            if (s == OrderState.Cancelled) return "cancelled";
            if (s == OrderState.Rejected) return "rejected";
            if (s == OrderState.CancelPending || s == OrderState.CancelSubmitted) return "cancelling";
            return "working";
        }

        private static string KindText(OrderType t)
        {
            if (t == OrderType.Market) return "market";
            if (t == OrderType.Limit) return "limit";
            if (t == OrderType.StopMarket) return "stop";
            if (t == OrderType.StopLimit) return "stopLimit";
            if (t == OrderType.MIT && OrderTypesOn) return "mit";   // 0.4.0 B1
            return "other";
        }

        private static string OrderJson(Order o, string text) { return OrderJson(o, text, null); }

        // role: null for the page's (RoleFor); an agent's order messages name its flat close and protective exit (0.5.0 agents).
        private static string OrderJson(Order o, string text, string role)
        {
            string id = IdFor(o), cid;
            lock (Sync) CidOf.TryGetValue(o, out cid);
            double px = o.OrderType == OrderType.Limit ? o.LimitPrice : (o.OrderType == OrderType.StopMarket || o.OrderType == OrderType.StopLimit) ? o.StopPrice : 0;
            if (o.OrderType == OrderType.MIT && OrderTypesOn) px = o.StopPrice;   // 0.4.0 B1: an MIT's trigger
            StringBuilder b = new StringBuilder("{\"type\":\"order\",\"id\":").Append(CbJson.Str(id));
            if (cid != null) b.Append(",\"cid\":").Append(CbJson.Str(cid));
            b.Append(",\"account\":").Append(CbJson.Str(o.Account != null ? o.Account.Name : ""))
             .Append(",\"root\":").Append(CbJson.Str(ChartBridgeServer.RootFor(o.Instrument) ?? ""))
             .Append(",\"name\":").Append(CbJson.Str(o.Instrument != null ? o.Instrument.FullName : ""))
             .Append(",\"side\":").Append(CbJson.Str(IsBuy(o) ? "buy" : "sell"))
             .Append(",\"kind\":").Append(CbJson.Str(KindText(o.OrderType)))
             .Append(",\"qty\":").Append(o.Quantity)
             .Append(",\"filled\":").Append(o.Filled)
             .Append(",\"price\":").Append(px > 0 ? CbJson.Num(px) : "null")
             .Append(",\"avgFill\":").Append(o.Filled > 0 ? CbJson.Num(o.AverageFillPrice) : "null")
             .Append(",\"state\":").Append(CbJson.Str(StateText(o.OrderState)))
             .Append(",\"role\":").Append(CbJson.Str(role ?? RoleFor(o)))
             .Append(",\"oco\":").Append(string.IsNullOrEmpty(o.Oco) ? "null" : CbJson.Str(o.Oco));
            if (!string.IsNullOrEmpty(text)) b.Append(",\"text\":").Append(CbJson.Str(text));
            // 0.3.8: a working resting entry's planned stop and target, ticks from its fill (null = none). Pages that do not
            // know the key ignore it.
            Bracket br = IsResting(o) && IsWorking(o.OrderState) && IsEntryName(o.Name) ? BracketFor(o) : null;
            if (br != null && br.Resting)
            {
                int st, tt;
                lock (Sync) { st = br.StopTicks; tt = br.TargetTicks; }
                b.Append(",\"planned\":{\"stopTicks\":").Append(st > 0 ? st.ToString(CultureInfo.InvariantCulture) : "null")
                 .Append(",\"targetTicks\":").Append(tt > 0 ? tt.ToString(CultureInfo.InvariantCulture) : "null").Append('}');
            }
            b.Append(V3OrderFields(o));   // 0.4.0 B1: a stop-limit's limitPrice; by "strategy" and bucket
            return b.Append('}').ToString();
        }

        // Every order update on a watched account: book any new fill, keep ChartBridge's brackets in step
        // (always, even with trading switched off, so a position placed from the chart keeps its legs),
        // then tell the pages (tradable accounts and served contracts only), then forget orders that are done.
        public static void OnOrderUpdate(Account account, OrderEventArgs e)
        {
            if (account == null || e.Order == null) return;
            Order o = e.Order;
            NoteFill(o);
            lock (Sync) NotedFilled[o] = o.Filled;   // 0.4.3: this fill count has come through (the copier's close waits for it)
            string root = ChartBridgeServer.RootFor(o.Instrument);
            string role = RoleFor(o);
            string where = Where(account, o.Instrument);
            try
            {
                if (role == "entry") KeepBracket(o);
                else if (role == "stop" || role == "target") KeepPartner(o, role, where);
            }
            catch (Exception ex) { Alarm(where + ": bracket error (" + ex.Message + "); check the position's stop in NinjaTrader"); }
            try { MergeOnOrderUpdate(account, o, e.Error); } catch (Exception ex) { Alarm(where + ": merge upkeep error (" + ex.Message + "); check the position's stop in NinjaTrader"); }   // 0.4.0 B4
            try { StrategyOrderUpdate(o, e); } catch (Exception ex) { Alarm(where + ": strategy error (" + ex.Message + "); check the stop in NinjaTrader"); }   // 0.4.0 B1
            if ((role == "stop" || role == "target") && (o.OrderState == OrderState.Cancelled || o.OrderState == OrderState.Rejected))
            {
                try { NoteLostPair(account, o); } catch (Exception ex) { ChartBridgeServer.Log("OCO check error: " + ex.Message); }
            }
            bool failed = o.OrderState == OrderState.Rejected || e.Error != ErrorCode.NoError;
            if ((o.OrderState == OrderState.Rejected || o.OrderState == OrderState.Cancelled) && IsExit(o) && o.Filled < o.Quantity)
                Alarm(where + ": the market EXIT was " + (o.OrderState == OrderState.Rejected ? "REJECTED" : "CANCELLED") + "; the position may have NO STOP and NO TARGET; act in NinjaTrader now");
            if (failed) ChartBridgeServer.Log("order problem: " + (o.Name ?? "") + " " + StateText(o.OrderState) + " (" + e.Error.ToString() + ") on " + account.Name);
            if (Enabled && root != null && ChartBridgeAccounts.Seen(account.Name))   // 0.4.0 accounts: v2 pages the tradable accounts (as before), v3 pages every watched one
                ChartBridgeAccounts.SendScoped(account, OrderJson(o, failed ? "NinjaTrader: " + e.Error.ToString() : null), true, o);   // 0.4.0 review 2: o for a v3 page's "by"
            try { if (ChartBridgeBot.Watching(o)) ChartBridgeBot.OnOrderUpdate(account, o, OrderJson(o, failed ? "NinjaTrader: " + e.Error.ToString() : null)); }   // 0.4.0 bot: the bot sees its own orders
            catch (Exception ex) { ChartBridgeServer.Log("bot order update error: " + ex.Message); }
            try { if (ChartBridgeAgents.AgentOf(o) != null) ChartBridgeAgents.OnOrderUpdate(account, o, AgentOrderJson(o, failed ? "NinjaTrader: " + e.Error.ToString() : null)); }   // 0.5.0 agents: each agent sees its own orders
            catch (Exception ex) { ChartBridgeServer.Log("agent order update error: " + ex.Message); }
            try { ChartBridgeAgents.OnAccountChange(account, o.Instrument, o); }   // 0.5.0 agents: agentState follows every order of an agent's account and roots
            catch (Exception ex) { ChartBridgeServer.Log("agent state error: " + ex.Message); }
            if (IsDone(o.OrderState)) Forget(o);   // after OrderJson, which would otherwise hand out a new id
            ChartBridgeCopier.OnOrderUpdate(account, o);   // 0.4.0 copier: follower fills get their stop; the leader's stop moves are followed
        }

        private static string Where(Account a, Instrument i)
        {
            return (ChartBridgeServer.RootFor(i) ?? (i != null ? i.FullName : "?")) + " " + (a != null ? a.Name : "?");
        }

        private static void DropId(Order o)
        {
            string id;
            if (IdOf.TryGetValue(o, out id)) { IdOf.Remove(o); ById.Remove(id); CidOf.Remove(o); }
        }

        // Called with the order done (filled, cancelled or rejected).
        private static void Forget(Order o)
        {
            lock (Sync)
            {
                Ours.Remove(o);
                SeenFilled.Remove(o);
                GapSince.Remove(o);
                LegBorn.Remove(o);
                Bracket br;
                if (BracketOfEntry.TryGetValue(o, out br) && br.Covered >= o.Filled)
                {
                    BracketOfEntry.Remove(o); Settled.Add(o);
                    if (br.Resting) ForgetPlanLater(br.Tag);   // done and covered: its planned ticks are no longer needed
                }
                Pair pair;
                if (PairOfLeg.TryGetValue(o, out pair))
                {
                    Order other = pair.Stop == o ? pair.Target : pair.Stop;
                    if (other == null || IsDone(other.OrderState))
                    {
                        PairOfLeg.Remove(o);
                        if (other != null) { PairOfLeg.Remove(other); DropId(other); }
                    }
                }
                if (!BracketOfEntry.ContainsKey(o) && !PairOfLeg.ContainsKey(o)) DropId(o);
            }
        }

        // Rebuild a bracket from the order names after a recompile or restart (the in-memory state is
        // gone): the entry's name gives the ticks; each leg's name gives its fill increment, so the
        // covered contracts and their prices come back exactly, and working pairs are re-linked. Reads the
        // account's orders, so it is called without holding Sync.
        private static Bracket Recover(Order entry, out List<Pair> pairs, out bool deferred)
        {
            if (IsStrategyName(entry.Name)) return RecoverStrategy(entry, out pairs, out deferred);   // 0.4.0 B1: legs by fill mark and bucket, managed.txt
            pairs = new List<Pair>();
            deferred = false;
            Match m = EntryNameRx.Match(entry.Name ?? ""), am = RestingNameRx.Match(entry.Name ?? ""), pm = PlanNameRx.Match(entry.Name ?? "");
            if (!m.Success) { Match gm = ChartBridgeAgents.EntryRx.Match(entry.Name ?? ""); if (gm.Success) m = Regex.Match(gm.Groups[1].Value + " " + gm.Groups[3].Value + " " + gm.Groups[4].Value, "^([0-9a-f]{8}) ([0-9]{1,9}) ([0-9]{1,9})$"); }   // 0.5.0 agents: "CB#<tag> ag:<id> s8 t16" is a v2 entry (tag, stop, target in groups 1 to 3, as EntryNameRx)
            if ((!m.Success && !am.Success && !pm.Success) || entry.Account == null) return null;
            Match named0 = m.Success ? m : am.Success ? am : pm;
            Bracket br = new Bracket { Account = entry.Account, Instrument = entry.Instrument, Tag = named0.Groups[1].Value, EntryIsBuy = IsBuy(entry), Resting = IsResting(entry) };
            if (!br.Resting)
            {
                // A market entry: ticks from each fill, in its name.
                if (!m.Success) return null;
                br.StopTicks = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture); br.TargetTicks = int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture);
                if (br.StopTicks == 0 && br.TargetTicks == 0) return null;
            }
            else
            {
                // A resting entry: its ticks as last set (planned_brackets.txt), else what its name says. Never a guess.
                if (!PlansLoaded()) { deferred = true; return null; }   // planned_brackets.txt not read yet (just started): wait
                PlanRecord rec;
                if (TryGetPlan(br.Tag, out rec)) { br.StopTicks = rec.Stop; br.TargetTicks = rec.Target; }
                else if (m.Success)
                {
                    // Placed by 0.3.6 (no line by design): its name's ticks, from each fill, as it was placed.
                    br.StopTicks = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture); br.TargetTicks = int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture);
                }
                else if (am.Success)
                {
                    // Placed by 0.3.8 and its line is missing: the ticks it was placed with, with an alarm (see Adopt).
                    br.StopTicks = int.Parse(am.Groups[2].Value, CultureInfo.InvariantCulture); br.TargetTicks = int.Parse(am.Groups[3].Value, CultureInfo.InvariantCulture);
                    br.PlanLost = true;
                }
                else
                {
                    // Placed by 0.3.7 with planned PRICES: turned once into the ticks they are from the entry's price now (what
                    // the chart shows around it), written as its line; from then on an ATM entry.
                    LegacyRecord lr;
                    double sp, tp;
                    bool fromFile = TryGetLegacy(br.Tag, out lr);
                    if (fromFile) { sp = lr.Stop; tp = lr.Target; }
                    else { sp = double.Parse(pm.Groups[2].Value, CultureInfo.InvariantCulture); tp = double.Parse(pm.Groups[3].Value, CultureInfo.InvariantCulture); }
                    double px = entry.OrderType == OrderType.Limit ? entry.LimitPrice : entry.StopPrice, tick = entry.Instrument.MasterInstrument.TickSize;
                    br.StopTicks = sp > 0 ? Math.Max(0, (int)Math.Round((br.EntryIsBuy ? px - sp : sp - px) / tick)) : 0;
                    br.TargetTicks = tp > 0 ? Math.Max(0, (int)Math.Round((br.EntryIsBuy ? tp - px : px - tp) / tick)) : 0;
                    ConvertLegacy(br.Tag, br.StopTicks, br.TargetTicks);
                    br.ConvertedNoStop = sp > 0 && br.StopTicks == 0;   // its stop was at or past the entry's price (the entry was moved): none now
                    br.Converted = "entry CB#" + br.Tag + " was placed by ChartBridge 0.3.7 with planned prices (stop " + PriceText(sp) + " / target " + PriceText(tp) +
                                   (fromFile ? "" : ", from its order name") + "); from now on its stop and target are " + TicksText(br.StopTicks) + " / " + TicksText(br.TargetTicks) +
                                   " ticks from its fill (the ATM rule), the distances they are from its price " + CbJson.Num(px) + " now; " +
                                   (br.ConvertedNoStop ? "its planned stop " + PriceText(sp) + " is not " + (br.EntryIsBuy ? "below" : "above") + " that price, so it has NO STOP: set one (plan, or in NinjaTrader) before it fills"
                                                       : "check them on the chart");
                }
            }
            List<Order> orders;
            lock (entry.Account.Orders) orders = entry.Account.Orders.ToList();
            lock (Sync) foreach (Order o in Ours) if (o.Account == entry.Account && !orders.Contains(o)) orders.Add(o);   // legs just sent, not listed yet
            Dictionary<int, Pair> byFill = new Dictionary<int, Pair>();
            foreach (Order leg in orders)
            {
                Match lm = LegNameRx.Match(AgentLegName(leg.Name));   // 0.5.0 agents: an agent's protective exit counts as an exit
                if (!lm.Success || lm.Groups[1].Value != br.Tag) continue;
                int f = int.Parse(lm.Groups[3].Value, CultureInfo.InvariantCulture), q = int.Parse(lm.Groups[4].Value, CultureInfo.InvariantCulture);
                double px = double.Parse(lm.Groups[5].Value, CultureInfo.InvariantCulture);
                Pair pair;
                if (!byFill.TryGetValue(f, out pair))
                {
                    byFill[f] = pair = new Pair { Bracket = br, Qty = q };
                    br.Covered = Math.Max(br.Covered, f);
                    br.CoveredValue += q * px;
                }
                if (lm.Groups[2].Value == "stop") pair.Stop = leg; else if (lm.Groups[2].Value == "target") pair.Target = leg;
            }
            // An increment that closed an opposite position got no legs, so Covered is the highest fill mark
            // seen; the value of the contracts in between is taken at the entry's average price.
            int named = byFill.Values.Sum(x => x.Qty);
            if (br.Covered > named)
            {
                // 0.3.8 review (P3, P13): the contracts in between are valued from NinjaTrader's executions of the entry; when
                // those cannot account for them, the value is marked unknown and the next increment's price is read from the
                // executions then, or it gets no legs (never legs from an estimate).
                double real = FillValue(FillsOf(entry), 0, br.Covered);
                if (!double.IsNaN(real)) br.CoveredValue = real;
                else { br.CoveredValue += (br.Covered - named) * entry.AverageFillPrice; br.ValueEstimated = true; }
            }
            foreach (Pair p in byFill.Values)
                if ((p.Stop != null && !IsDone(p.Stop.OrderState)) || (p.Target != null && !IsDone(p.Target.OrderState))) pairs.Add(p);
            // A missing record matters only while the planned ticks may still be used: the entry still works, or it
            // has fills without legs. (The record is removed once the entry is done and covered.)
            if (br.PlanLost && !IsWorking(entry.OrderState) && entry.Filled <= br.Covered) br.PlanLost = false;
            ChartBridgeServer.Log("bracket recovered from the order names " + entry.Name + " (" + br.Covered + " contracts already handled, " + pairs.Count + " working pair(s)" +
                (br.Resting ? "; planned stop " + TicksText(br.StopTicks) + " / target " + TicksText(br.TargetTicks) + " ticks" + (br.PlanLost ? " FROM THE ORDER NAME (planned_brackets.txt has no record)" : "") : "") + ")");
            return br;
        }

        // Each new fill increment of an entry gets its own OCO stop and target for exactly that many
        // contracts, priced from that increment's fill price. From an order event (the normal path) the
        // legs are always placed in full, with no reading of the position: event order differs between
        // connections, so a position read at fill time can be stale either way, and a withheld stop is the
        // worst outcome. Legs that turn out to exceed the settled position are trimmed by the legs check.
        // From the scan (fills no event reported: ChartBridge was reloading), a gap is acted on only once
        // it has lasted SettleMs, so the scan never races an event that is on its way; then the settled
        // position decides how many contracts still need legs.
        private static readonly Dictionary<Order, double[]> GapSince = new Dictionary<Order, double[]>();   // entry -> { filled, since }

        private static void KeepBracket(Order entry) { KeepBracket(entry, false, 0); }

        private static void KeepBracket(Order entry, bool fromScan, double now)
        {
            Bracket br;
            bool known;
            lock (Sync)
            {
                if (Settled.Contains(entry)) return;
                known = BracketOfEntry.TryGetValue(entry, out br);
            }
            if (!known)
            {
                List<Pair> pairs;
                bool lost = false, deferred;
                Bracket rec = Recover(entry, out pairs, out deferred);
                if (deferred)
                {
                    bool first;
                    lock (Sync) { first = !PlanDeferred.ContainsKey(entry); if (first) PlanDeferred[entry] = true; }   // an order event saw it first: placed as soon as the file has been read (LoadPlans)
                    if (first) ChartBridgeServer.Log("entry " + (entry.Name ?? "") + ": waiting for planned_brackets.txt to be read before its bracket is recovered");
                    return;
                }
                lock (Sync)
                {
                    if (!BracketOfEntry.TryGetValue(entry, out br))
                    {
                        if (rec == null) { if (IsDone(entry.OrderState)) Settled.Add(entry); return; }
                        br = rec;
                        lost = Adopt(entry, br, pairs);
                    }
                }
                if (lost) Announce(br);
            }
            if (br.Resting && NoPlan(br)) { CoverWithoutLegs(entry, br); return; }
            if (fromScan) { KeepBracketFromScan(entry, br, now); return; }
            bool est;
            lock (Sync) est = br.ValueEstimated;
            List<double[]> fills = est ? FillsOf(entry) : null;   // read before Sync (the account's own lock)
            int inc, filled;
            double incPrice;
            bool unknown = false, fromExec = false;
            lock (Sync)
            {
                filled = entry.Filled;
                if (filled <= br.Covered) { GapSince.Remove(entry); return; }
                GapSince.Remove(entry);
                inc = filled - br.Covered;
                double value = entry.AverageFillPrice * filled;
                incPrice = (value - br.CoveredValue) / inc;
                if (br.ValueEstimated)
                {
                    double real = RealIncPrice(fills, entry, br.Covered, filled);
                    if (double.IsNaN(real)) unknown = true; else { incPrice = real; fromExec = true; }
                    br.ValueEstimated = false;   // from here on CoveredValue is the average fill times the filled count: exact
                }
                br.Covered = filled;
                br.CoveredValue = value;
                if (unknown) { br.CoveredNoStop += inc; Manage(br.Account, br.Instrument); }   // watched by the missing-stop alarm
            }
            string where = Where(br.Account, br.Instrument);
            if (br.AfterFlatten)
                Alarm(where + ": an entry filled AFTER Flatten (" + inc + " contract(s)); a position may be open. It gets its stop and target now; check NinjaTrader");
            if (br.PlanLost) PlanLostAlarm(br, true);
            if (unknown) { PriceUnknownAlarm(br, inc, where); return; }
            if (br.ConvertedNoStop) ConvertedNoStopAlarm(br, inc);
            if (fromExec) ChartBridgeServer.Log("entry CB#" + br.Tag + ": the fill price of " + inc + " contract(s) after a recompile read from NinjaTrader's executions: " + CbJson.Num(incPrice));
            PlaceLegs(br, filled, inc, incPrice, where);
        }

        private static bool NoPlan(Bracket br) { lock (Sync) return br.StopTicks <= 0 && br.TargetTicks <= 0; }

        // 0.3.7 and later: a resting entry with no planned stop and no target fills: those contracts are handled (no legs), so a
        // stop or target planned later goes on the fill increments still to come only.
        private static void CoverWithoutLegs(Order entry, Bracket br)
        {
            int inc;
            lock (Sync)
            {
                int filled = entry.Filled;
                GapSince.Remove(entry);
                if (filled <= br.Covered) return;
                inc = filled - br.Covered;
                br.Covered = filled;
                br.CoveredValue = entry.AverageFillPrice * filled;
                br.ValueEstimated = false;   // exact from here (the average fill times the filled count)
                br.CoveredNoStop += inc;
            }
            string where = Where(br.Account, br.Instrument);
            if (br.ConvertedNoStop) ConvertedNoStopAlarm(br, inc);
            if (br.AfterFlatten)
                Alarm(where + ": an entry filled AFTER Flatten (" + inc + " contract(s)); a position may be open, and the entry had no planned stop or target; check NinjaTrader");
            ChartBridgeServer.Log("entry " + (entry.Name ?? "") + " filled " + inc + " contract(s) with no planned stop or target: no legs, on " + where);
        }

        // Called with Sync held: a recovered bracket becomes the entry's, its working pairs re-linked. True when the page must
        // be told (Announce): its planned ticks came from the order name (no planned_brackets.txt record), or a 0.3.7 entry's
        // prices were turned into ticks.
        private static bool Adopt(Order entry, Bracket br, List<Pair> pairs)
        {
            BracketOfEntry[entry] = br;
            foreach (Pair p in pairs)
            {
                if (p.Stop != null) { IdFor(p.Stop); PairOfLeg[p.Stop] = p; }
                if (p.Target != null) { IdFor(p.Target); PairOfLeg[p.Target] = p; }
            }
            return br.PlanLost || br.Converted != null;
        }

        private static void Announce(Bracket br)
        {
            if (br.PlanLost) PlanLostAlarm(br, false);
            if (br.Converted != null)
            {
                if (br.ConvertedNoStop) Alarm(Where(br.Account, br.Instrument) + ": " + br.Converted);   // 0.3.8 review (P10): NO STOP is an error
                else Warn(Where(br.Account, br.Instrument) + ": " + br.Converted);
            }
        }

        // 0.3.8 review (P10): a converted 0.3.7 entry that lost its stop fills: said again, as an error.
        private static void ConvertedNoStopAlarm(Bracket br, int qty)
        {
            Alarm(Where(br.Account, br.Instrument) + ": entry CB#" + br.Tag + " (placed by ChartBridge 0.3.7) filled " + qty + " contract(s) with NO STOP: its planned stop was on the wrong side of the entry when it was converted; set the stop in NinjaTrader now");
        }

        // 0.3.8 review (P3, P13): an entry's fills from NinjaTrader's executions on its account, oldest first ({quantity, price}
        // each): the executions whose Order is the entry, or that carry its OrderId. Reads the account's list under its own
        // lock; call without Sync. Null when the list cannot be read.
        private static List<double[]> FillsOf(Order entry)
        {
            if (entry == null || entry.Account == null) return null;
            List<Execution> list;
            try { lock (entry.Account.Executions) list = entry.Account.Executions.ToList(); }
            catch (Exception) { return null; }
            string id = entry.OrderId;
            List<KeyValuePair<int, Execution>> mine = new List<KeyValuePair<int, Execution>>();
            for (int i = 0; i < list.Count; i++)
            {
                Execution x = list[i];
                if (x != null && (object.ReferenceEquals(x.Order, entry) || (!string.IsNullOrEmpty(id) && x.OrderId == id))) mine.Add(new KeyValuePair<int, Execution>(i, x));
            }
            return mine.OrderBy(p => p.Value.Time).ThenBy(p => p.Key).Select(p => new double[] { p.Value.Quantity, p.Value.Price }).ToList();
        }

        // The value (price times contracts, summed) of the entry's filled contracts from+1 to `to`, from FillsOf; NaN when the
        // executions do not account for them all.
        private static double FillValue(List<double[]> fills, int from, int to)
        {
            if (fills == null || to <= from) return fills == null ? double.NaN : 0;
            double v = 0;
            int at = 0;
            foreach (double[] f in fills)
            {
                int q = (int)f[0];
                if (q <= 0 || !(f[1] > 0)) continue;
                int a = Math.Max(at, from), b = Math.Min(at + q, to);
                if (b > a) v += (b - a) * f[1];
                at += q;
            }
            return at >= to ? v : double.NaN;
        }

        // The real price of contracts before+1..filled when CoveredValue is not known (ValueEstimated): from the executions of
        // those contracts, or the average fill less the executions of the ones before; NaN when neither can be read.
        private static double RealIncPrice(List<double[]> fills, Order entry, int before, int filled)
        {
            double v = FillValue(fills, before, filled);
            if (double.IsNaN(v)) { double b = FillValue(fills, 0, before); if (!double.IsNaN(b)) v = entry.AverageFillPrice * filled - b; }
            return double.IsNaN(v) ? double.NaN : v / (filled - before);
        }

        private static void PriceUnknownAlarm(Bracket br, int qty, string where)
        {
            Alarm(where + ": NO STOP: " + qty + " contract(s) of entry CB#" + br.Tag + " filled while ChartBridge was restarting (or just after), and their fill price cannot be read " +
                  "from NinjaTrader's executions, so no stop or target was placed for them (never from an estimate); set the stop in NinjaTrader");
        }

        // The bracket of a ChartBridge entry, recovered from the names (and planned_brackets.txt) after a recompile
        // if needed; null for an entry with none, or one already done. Reads the account's orders: call without Sync.
        private static Bracket BracketFor(Order entry)
        {
            Bracket br;
            lock (Sync)
            {
                if (BracketOfEntry.TryGetValue(entry, out br)) return br;
                if (Settled.Contains(entry)) return null;
            }
            List<Pair> pairs;
            bool deferred;
            Bracket rec = Recover(entry, out pairs, out deferred);
            if (rec == null) return null;   // none, or planned_brackets.txt not read yet (callers check PlansLoaded)
            bool lost = false;
            lock (Sync)
            {
                if (!BracketOfEntry.TryGetValue(entry, out br)) { br = rec; lost = Adopt(entry, br, pairs); }
            }
            if (lost) Announce(br);
            return br;
        }

        private static void PlanLostAlarm(Bracket br, bool atFill)
        {
            int st, tt;
            lock (Sync) { st = br.StopTicks; tt = br.TargetTicks; }
            Alarm(Where(br.Account, br.Instrument) + ": the planned stop and target of entry CB#" + br.Tag + " could not be read (planned_brackets.txt has no record); " +
                  (atFill ? "its legs go at" : "it will use") + " the ticks it was placed with, stop " + TicksText(st) + " / target " + TicksText(tt) +
                  " ticks from the fill, which are out of date if they were changed after placement; check " + (atFill ? "the legs" : "them on the chart") + " now" +
                  (st > 0 ? "" : ". There is NO planned stop"));
        }

        // The scan path. A gap (filled contracts without legs) is acted on once the same gap has lasted
        // SettleMs (a new fill restarts the clock). Legs go on the contracts the listed position holds in
        // the entry's direction beyond what ChartBridge's other legs cover. On a steady connection the
        // rest of the gap is settled as "no legs needed"; on a connection that is not steady yet (a
        // reconnect can list orders before positions) only what was placed is marked covered, and the
        // rest is looked at again later.
        private static void KeepBracketFromScan(Order entry, Bracket br, double now)
        {
            int filled, before;
            lock (Sync)
            {
                filled = entry.Filled;
                before = br.Covered;
                if (filled <= before) { GapSince.Remove(entry); return; }
                double[] g;
                if (!GapSince.TryGetValue(entry, out g) || (int)g[0] != filled) { GapSince[entry] = new double[] { filled, now }; return; }
                if (now - g[1] < SettleMs) return;
            }
            bool steady = Steady(br.Account, now);
            int along = SignedPosition(br.Account, br.Instrument) * (br.EntryIsBuy ? 1 : -1);
            int covered = LegCover(br.Account, br.Instrument, !br.EntryIsBuy);
            int inc = filled - before, qty = Math.Min(inc, Math.Max(0, along - covered));
            int advance = steady ? inc : qty;
            if (advance == 0) return;   // not steady and nothing to place yet: look again later
            bool est;
            lock (Sync) est = br.ValueEstimated;
            List<double[]> fills = est ? FillsOf(entry) : null;
            double incPrice;
            bool unknown = false;
            lock (Sync)
            {
                if (br.Covered != before || entry.Filled != filled) return;   // an order event got there first
                incPrice = (entry.AverageFillPrice * filled - br.CoveredValue) / inc;
                double real = double.NaN;
                if (br.ValueEstimated) { real = RealIncPrice(fills, entry, before, filled); unknown = double.IsNaN(real); }
                br.Covered = before + advance;
                br.CoveredValue += advance * (unknown ? incPrice : br.ValueEstimated ? real : incPrice);
                if (!unknown && br.ValueEstimated) incPrice = real;
                if (br.Covered >= filled) { GapSince.Remove(entry); br.CoveredValue = entry.AverageFillPrice * filled; br.ValueEstimated = false; }
                if (unknown && qty > 0) { br.CoveredNoStop += qty; Manage(br.Account, br.Instrument); }
            }
            string where = Where(br.Account, br.Instrument);
            Warn(where + ": found " + inc + " filled contract(s) no order update reported (ChartBridge was reloading?); " +
                 (qty > 0 ? "placing legs for " + qty : "no legs needed") + " (position " + (along * (br.EntryIsBuy ? 1 : -1)) + ", covered by legs " + covered +
                 (steady ? "" : "; connection not steady yet, the rest is checked again") + ")");
            if (qty > 0 && br.PlanLost) PlanLostAlarm(br, true);
            if (qty > 0 && unknown) { PriceUnknownAlarm(br, qty, where); return; }
            if (qty > 0 && br.ConvertedNoStop) ConvertedNoStopAlarm(br, qty);
            if (qty > 0) PlaceLegs(br, before + qty, qty, incPrice, where);
        }

        // Contracts ChartBridge's working legs on one side would close (an OCO pair counts once), including
        // legs just sent that NinjaTrader does not list yet.
        private static int LegCover(Account account, Instrument inst, bool buySide)
        {
            List<Order> orders;
            lock (account.Orders) orders = account.Orders.ToList();
            lock (Sync) foreach (Order o in Ours) if (o.Account == account && !orders.Contains(o)) orders.Add(o);
            Dictionary<string, int> groups = new Dictionary<string, int>();
            int lone = 0;
            foreach (Order o in orders)
            {
                if (!SameInstrument(o.Instrument, inst) || !IsWorking(o.OrderState) || !IsChartBridgeLeg(o) || IsBuy(o) != buySide) continue;
                int left = Math.Max(0, o.Quantity - o.Filled), had;
                string grp = MergeUnitKey(o);   // 0.4.0 B4: the OCO id, or a merged set's group
                if (grp == null) { lone += left; continue; }
                if (!groups.TryGetValue(grp, out had) || left > had) groups[grp] = left;
            }
            return lone + groups.Values.Sum();
        }

        private static void PlaceLegs(Bracket br, int filled, int qty, double incPrice, string where)
        {
            if (PlaceStrategyLegs(br, filled, qty, incPrice, where)) return;   // 0.4.0 B1: an Order Strategy entry, one pair per target bucket
            double tick = br.Instrument.MasterInstrument.TickSize;
            OrderAction exit = br.EntryIsBuy ? OrderAction.Sell : OrderAction.Buy;
            string mark = " f" + filled.ToString(CultureInfo.InvariantCulture) + " q" + qty.ToString(CultureInfo.InvariantCulture) +
                          " p" + incPrice.ToString("0.########", CultureInfo.InvariantCulture);
            // 0.3.8 (Anthony's ATM rule): every entry's legs are ticks from this increment's actual fill price (a resting
            // entry's planned ticks as they are when the fill is handled), so on a gap or slippage the stop is always on the
            // right side of the fill.
            double sp, tp;
            bool hasStop, hasTarget;
            lock (Sync)
            {
                sp = Round(br.EntryIsBuy ? incPrice - br.StopTicks * tick : incPrice + br.StopTicks * tick, tick);
                tp = Round(br.EntryIsBuy ? incPrice + br.TargetTicks * tick : incPrice - br.TargetTicks * tick, tick);
                hasStop = br.StopTicks > 0;
                hasTarget = br.TargetTicks > 0;
                if (!hasStop) br.CoveredNoStop += qty;
            }
            if (!hasStop && !hasTarget) return;
            double now = ChartBridgeTime.NowUtcMs();
            // The stop level has already traded (a fast market, or a late event): a stop order there would be
            // rejected or fill at once, and a rejected leg can take its OCO partner with it. Exit now, as the
            // stop would have. The proof is a trade from the last 2 seconds at or through the stop level.
            string root = ChartBridgeServer.RootFor(br.Instrument);
            double last = 0;
            bool fresh = hasStop && root != null && FreshLast(root, FreshTickMs, out last);
            if (fresh && (br.EntryIsBuy ? sp >= last : sp <= last))
            {
                string agentOf = ChartBridgeAgents.AgentOfTag(br.Tag);   // 0.5.0 agents: an agent entry's exit is "CB#<tag> ag:<id> protect f<n>" (at most 43 characters)
                Order x = br.Account.CreateOrder(br.Instrument, exit, OrderType.Market, OrderEntry.Manual, TimeInForce.Day, qty, 0, 0, "",
                    agentOf != null ? "CB#" + br.Tag + " ag:" + agentOf + " protect f" + filled.ToString(CultureInfo.InvariantCulture) : "CB#" + br.Tag + " exit" + mark, NinjaTrader.Core.Globals.MaxDate, null);
                lock (Sync) { IdFor(x); Ours.Add(x); Manage(br.Account, br.Instrument); }
                br.Account.Submit(new[] { x });
                Alarm(where + ": price had already passed the stop level " + CbJson.Num(sp) + " (last " + CbJson.Num(last) + "); exited " + qty + " at market");
                CopierLeaderFill(br, filled, qty, incPrice, null, sp);   // 0.4.0 copier: an increment that exited at once is not copied
                return;
            }
            string oco = hasStop && hasTarget ? "cb-" + br.Tag + "-" + filled.ToString(CultureInfo.InvariantCulture) : "";
            Pair pair = new Pair { Bracket = br, Qty = qty };
            if (hasStop)
                pair.Stop = br.Account.CreateOrder(br.Instrument, exit, OrderType.StopMarket, OrderEntry.Manual, TimeInForce.Gtc, qty, 0, sp, oco,
                    "CB#" + br.Tag + " stop" + mark, NinjaTrader.Core.Globals.MaxDate, null);
            if (hasTarget)
                pair.Target = br.Account.CreateOrder(br.Instrument, exit, OrderType.Limit, OrderEntry.Manual, TimeInForce.Gtc, qty, tp, 0, oco,
                    "CB#" + br.Tag + " target" + mark, NinjaTrader.Core.Globals.MaxDate, null);
            List<Order> legs = new List<Order>();
            lock (Sync)
            {
                Manage(br.Account, br.Instrument);
                foreach (Order leg in new[] { pair.Stop, pair.Target })
                    if (leg != null) { IdFor(leg); PairOfLeg[leg] = pair; LegBorn[leg] = now; Ours.Add(leg); legs.Add(leg); }
            }
            br.Account.Submit(legs.ToArray());
            ChartBridgeServer.Log("bracket placed for " + qty + " on " + where + ": " +
                (pair.Stop != null ? "stop " + CbJson.Num(sp) : "no stop") + ", " + (pair.Target != null ? "target " + CbJson.Num(tp) : "no target"));
            CopierLeaderFill(br, filled, qty, incPrice, pair.Stop, sp);   // 0.4.0 copier: the leader's fill and its stop, to the followers
        }

        // A leg filled in part: shrink its partner to what is still open. A leg rejected: say so loudly.
        private static void KeepPartner(Order leg, string role, string where)
        {
            Pair pair;
            lock (Sync) PairOfLeg.TryGetValue(leg, out pair);
            if (leg.OrderState == OrderState.Rejected)
                Alarm(where + ": bracket " + role + " rejected; the position may have NO " + (role == "stop" ? "STOP" : "TARGET") +
                      " (and NinjaTrader may have cancelled its OCO partner too); check NinjaTrader now");
            if (pair == null || leg.Filled <= 0) return;
            Order partner = pair.Stop == leg ? pair.Target : pair.Stop;
            if (partner == null || !IsWorking(partner.OrderState)) return;
            int open = leg.Quantity - leg.Filled;
            if (open <= 0) { partner.Account.Cancel(new[] { partner }); return; }
            if (partner.Quantity - partner.Filled > open) { partner.QuantityChanged = open + partner.Filled; partner.Account.Change(new[] { partner }); }
        }

        private static double Round(double price, double tick) { return Math.Round(Math.Round(price / tick, MidpointRounding.AwayFromZero) * tick, 10); }

        public static void OnPositionUpdate(Account account, PositionEventArgs e)
        {
            if (account == null || e.Position == null) return;
            Instrument inst = e.Position.Instrument;
            Booked(account, inst, e.MarketPosition == MarketPosition.Long ? e.Quantity : e.MarketPosition == MarketPosition.Short ? -e.Quantity : 0);
            CopierSawPosition(account, inst);   // 0.4.3 third review: a late fill is booked once NinjaTrader's position updates after it
            MergeSawPosition(account, inst);   // 0.4.0 B4: the position is changing (Merge waits 2 s)
            string root = ChartBridgeServer.RootFor(inst);
            if (Enabled && root != null && ChartBridgeAccounts.Seen(account.Name))   // 0.4.0 accounts: each page its scope
                ChartBridgeAccounts.SendScoped(account, PositionJson(account.Name, root, e.MarketPosition, e.Quantity, e.AveragePrice), false, null, root);
            // Flat, and still flat now (a newer fill may already have opened a position whose legs must stay),
            // on a connection that has been steady (not a reconnect still loading positions).
            double now = ChartBridgeTime.NowUtcMs();
            if (e.MarketPosition == MarketPosition.Flat && SignedPosition(account, inst) == 0 && Steady(account, now))
                CancelLeftoverLegs(account, inst, Where(account, inst), now);
            ChartBridgeCopier.OnPositionUpdate(account, inst, e.MarketPosition == MarketPosition.Long ? e.Quantity : e.MarketPosition == MarketPosition.Short ? -e.Quantity : 0);   // 0.4.0 copier: the leader's exits
        }

        // Flat: any ChartBridge stop or target still working would open a new position if it filled. Legs
        // placed in the last YoungMs are left to the legs check (with its settle time): they may belong to
        // a new entry whose position change has not landed yet.
        public const double YoungMs = 3000;

        private static void CancelLeftoverLegs(Account account, Instrument inst, string where, double now)
        {
            List<Order> orders, leftover = new List<Order>();
            lock (account.Orders) orders = account.Orders.ToList();
            foreach (Order o in orders)
            {
                if (!SameInstrument(o.Instrument, inst) || !IsWorking(o.OrderState) || !IsChartBridgeLeg(o)) continue;
                double born;
                bool young;
                lock (Sync) young = LegBorn.TryGetValue(o, out born) && now - born < YoungMs;
                if (!young) leftover.Add(o);
            }
            if (leftover.Count == 0) return;
            NoteWeCancelSafe(() => leftover, "cancel");
            account.Cancel(leftover.ToArray());
            Warn("position flat on " + where + ": cancelled " + leftover.Count + " leftover bracket leg(s)");
        }

        // ---------------------------------------------------------- connection
        public const double SteadyMs = 30000;
        private static readonly Dictionary<Account, double> ConnectedSince = new Dictionary<Account, double>();

        private static string StatusOf(Account a)
        {
            try { return a.Connection == null ? "no connection" : a.Connection.Status.ToString(); } catch (Exception ex) { return "unknown: " + ex.Message; }
        }

        // True once the account has stayed Connected for SteadyMs. The legs check samples it every 2
        // seconds, and any connection status event (see WatchConnections) starts every clock again, so a
        // drop shorter than 2 seconds is not missed. While NinjaTrader reconnects it can show orders
        // before positions; nothing that cancels legs may act on that picture.
        private static bool Steady(Account a, double now)
        {
            bool up = StatusOf(a) == "Connected";
            lock (ConnectedSince)
            {
                double since;
                if (!up) { ConnectedSince.Remove(a); return false; }
                if (!ConnectedSince.TryGetValue(a, out since)) { ConnectedSince[a] = now; return false; }
                return now - since >= SteadyMs;
            }
        }

        // NinjaTrader's static Connection.ConnectionStatusUpdate event, attached by reflection so this file
        // compiles even if the event is named differently in some release (then the 2 second sampling is
        // all there is, and the Output window says so).
        private static EventInfo connEvent;
        private static Delegate connHandler;

        public static void WatchConnections()
        {
            try
            {
                EventInfo ev = typeof(Connection).GetEvent("ConnectionStatusUpdate", BindingFlags.Public | BindingFlags.Static);
                if (ev == null) { ChartBridgeServer.Log("connection status events not found; the legs check samples connections every 2 seconds only"); return; }
                MethodInfo mi = typeof(ChartBridgeOrders).GetMethod("OnConnectionStatus", BindingFlags.NonPublic | BindingFlags.Static);
                Delegate d = Delegate.CreateDelegate(ev.EventHandlerType, mi);
                ev.AddEventHandler(null, d);
                connEvent = ev; connHandler = d;
            }
            catch (Exception ex) { ChartBridgeServer.Log("could not watch connection status events (" + ex.Message + "); the legs check samples connections every 2 seconds only"); }
        }

        public static void UnwatchConnections()
        {
            try { if (connEvent != null && connHandler != null) connEvent.RemoveEventHandler(null, connHandler); } catch (Exception) { }
            connEvent = null; connHandler = null;
        }

        // A status change on a connection starts the 30 seconds again for the accounts on that connection. An
        // event where the connection status did not change (a price feed status change) is ignored. Read by
        // reflection, so a differently named property falls back to resetting every account (the safe side).
        private static void OnConnectionStatus(object sender, EventArgs e)
        {
            ChartBridgeCopier.ConnectionChanged();   // 0.4.0 copier: a mass disconnect is seen at once
            object conn = null, status = null, previous = null;
            try
            {
                PropertyInfo pc = e.GetType().GetProperty("Connection"), ps = e.GetType().GetProperty("Status"), pp = e.GetType().GetProperty("PreviousStatus");
                if (pc != null) conn = pc.GetValue(e, null);
                if (ps != null) status = ps.GetValue(e, null);
                if (pp != null) previous = pp.GetValue(e, null);
            }
            catch (Exception) { conn = null; }
            if (status != null && previous != null && status.Equals(previous)) return;
            lock (ConnectedSince)
            {
                List<Account> hit = conn == null ? new List<Account>() : ConnectedSince.Keys.Where(a => a.Connection == null || ReferenceEquals(a.Connection, conn)).ToList();
                if (hit.Count == 0) { ConnectedSince.Clear(); return; }   // no account matched (a new Connection object?): reset all
                foreach (Account a in hit) ConnectedSince.Remove(a);
            }
        }

        // ---------------------------------------------------------- entries that still need legs
        // An entry can fill while ChartBridge is not running (any NinjaScript compile reloads add-ons), and
        // a filled order sends no further updates. At start, and in every legs check, each ChartBridge entry
        // with fills is passed through KeepBracket, which places what is missing (from the order names) and
        // nothing twice.
        public static void Resume() { ScanEntries(ChartBridgeTime.NowUtcMs()); }   // planned_brackets.txt: StartPlans, before the accounts are watched

        // Placing legs only protects, so this needs a connected account, not a steady one.
        private static void ScanEntries(double now)
        {
            List<Account> accounts = new List<Account>();
            lock (Account.All) foreach (Account a in Account.All) if (!IsNeverTradable(a.Name ?? "")) accounts.Add(a);
            foreach (Account a in accounts)
            {
                if (StatusOf(a) != "Connected") continue;
                List<Order> orders;
                lock (a.Orders) orders = a.Orders.ToList();
                foreach (Order o in orders)
                {
                    if (o.Filled <= 0 || !IsEntryName(o.Name)) continue;
                    bool skip;
                    lock (Sync) skip = Settled.Contains(o);
                    if (skip) continue;
                    if (!PlansLoaded() && (IsResting(o) || IsStrategyName(o.Name)))   // 0.4.0 B1: a strategy entry waits for managed.txt too
                    {
                        // S1: planned_brackets.txt not read yet: its legs wait (never guessed); loud once it has lasted PlanReadAlarmMs.
                        bool known, alarm = false;
                        lock (Sync)
                        {
                            known = BracketOfEntry.ContainsKey(o);
                            if (!known)
                            {
                                if (!PlanDeferred.ContainsKey(o)) PlanDeferred[o] = false;   // the scan saw it first
                                double since;
                                if (!PlanWaitSince.TryGetValue(o, out since)) PlanWaitSince[o] = now;
                                else if (since >= 0 && now - since >= PlanReadAlarmMs) { alarm = true; PlanWaitSince[o] = -1; }   // -1: said once
                            }
                        }
                        if (alarm)
                            Alarm(Where(a, o.Instrument) + ": entry " + o.Name + " has " + o.Filled + " filled contract(s) and NO LEGS yet: planned_brackets.txt has not been read since ChartBridge started; check the stop in NinjaTrader now");
                        if (!known) continue;
                    }
                    try
                    {
                        KeepBracket(o, true, now);
                        Bracket br;
                        bool covered;
                        lock (Sync) covered = !BracketOfEntry.TryGetValue(o, out br) || br.Covered >= o.Filled;
                        if (IsDone(o.OrderState) && covered) Forget(o);
                    }
                    catch (Exception ex) { Alarm(Where(a, o.Instrument) + ": bracket error (" + ex.Message + "); check the position's stop in NinjaTrader"); }
                }
            }
        }

        // ---------------------------------------------------------- the legs check (every 2 seconds)
        // ChartBridge's legs must never be able to open or grow a position. Legs on a flat or opposite
        // position are cancelled; legs covering more contracts than the position are shrunk, newest
        // first. Only when the same position and legs have held for SettleMs, so an update still on its
        // way (a fill whose position change has not landed yet) never strips a live stop.
        public const double SettleMs = 4000;
        private static readonly Dictionary<string, KeyValuePair<string, double>> Suspect = new Dictionary<string, KeyValuePair<string, double>>();

        public static void CheckLegs() { CheckLegs(ChartBridgeTime.NowUtcMs()); }

        // ---------------------------------------------------------- the missing-stop alarm
        // Contracts ChartBridge has put legs on (account|contract). Also learned every check from any working
        // ChartBridge leg, so a reload does not forget them. Whatever the direction the position now has,
        // if it holds more contracts than ChartBridge's working stops on the closing side cover, steadily
        // for SettleMs, the page gets an error, once per situation, and again if it happens again later:
        // a stop rejected or cancelled by hand, contracts added without a bracket, or a leg that filled and
        // left a position of its own. A contract is forgotten only after it has been flat, with no
        // ChartBridge leg working, for SettleMs.
        private static readonly Dictionary<string, Tuple<Account, Instrument>> Managed = new Dictionary<string, Tuple<Account, Instrument>>();
        private static readonly Dictionary<string, KeyValuePair<string, double>> Uncovered = new Dictionary<string, KeyValuePair<string, double>>();
        private static readonly Dictionary<string, double> FlatSince = new Dictionary<string, double>();
        private static readonly HashSet<string> Alarmed = new HashSet<string>();

        // Called with Sync held.
        private static void Manage(Account a, Instrument i) { Managed[PosKey(a, i)] = new Tuple<Account, Instrument>(a, i); }

        // A stop and its OCO target gone together. When a ChartBridge stop is cancelled (by hand, or from the
        // chart) or rejected, NinjaTrader cancels its OCO target too, so the position is left with neither
        // (Sim101 test, 2026-09-29). The missing-stop alarm says so. Learned from order events while the
        // position is open, per account|contract, and forgotten when the position is flat; pairs ChartBridge
        // itself cancels (Flatten, a flat position, the legs check) never count. After a reload only pairs
        // lost since then are known; the alarm then has its plain text. The alarm also says which leg went
        // first: usually the stop (cancelled or rejected) takes the target with it, but a rejected target
        // takes the stop with it just the same.
        private class LostPair { public Order Target; public string FirstRole, FirstState; }
        private static readonly Dictionary<string, List<LostPair>> LostTargets = new Dictionary<string, List<LostPair>>();
        private static readonly Dictionary<string, string> OcoWeCancel = new Dictionary<string, string>();   // OCO id -> account|contract
        private static readonly Dictionary<string, string[]> FirstGone = new Dictionary<string, string[]>();   // OCO id -> { role, state, account|contract } of the first leg reported gone

        private static void NoteWeCancel(IEnumerable<Order> orders)
        {
            lock (Sync) foreach (Order o in orders) if (!string.IsNullOrEmpty(o.Oco)) OcoWeCancel[o.Oco] = PosKey(o.Account, o.Instrument);
        }

        public static Action BookkeepingFault;   // test hook: runs inside the bookkeeping below (unused in NinjaTrader)

        // The note taken just before a Flatten or a Cancel. It is bookkeeping for the alarm text only, so it may
        // never stop the order action that follows: any error is logged and the action goes out anyway.
        private static void NoteWeCancelSafe(Func<IEnumerable<Order>> orders, string action)
        {
            try
            {
                if (BookkeepingFault != null) BookkeepingFault();
                NoteWeCancel(orders());
            }
            catch (Exception ex) { ChartBridgeServer.Log("bookkeeping error before a " + action + " (" + ex.Message + "); the " + action + " is sent anyway"); }
        }

        // ChartBridge's working legs on a contract, including legs just sent that NinjaTrader does not list yet.
        private static List<Order> WorkingLegs(Account account, Instrument inst)
        {
            List<Order> orders;
            lock (account.Orders) orders = account.Orders.ToList();
            lock (Sync) foreach (Order o in Ours) if (o.Account == account && !orders.Contains(o)) orders.Add(o);
            return orders.Where(o => SameInstrument(o.Instrument, inst) && IsWorking(o.OrderState) && IsChartBridgeLeg(o)).ToList();
        }

        // Called with Sync held, when the position is flat.
        private static void ForgetLostPairs(string key)
        {
            LostTargets.Remove(key);
            foreach (string oco in OcoWeCancel.Where(kv => kv.Value == key).Select(kv => kv.Key).ToList()) OcoWeCancel.Remove(oco);
            foreach (string oco in FirstGone.Where(kv => kv.Value[2] == key).Select(kv => kv.Key).ToList()) FirstGone.Remove(oco);
        }

        private static bool Gone(Order o) { return o.OrderState == OrderState.Cancelled || o.OrderState == OrderState.Rejected; }

        private static void NoteLostPair(Account account, Order leg)
        {
            if (string.IsNullOrEmpty(leg.Oco) || leg.Instrument == null) return;
            if (SignedPosition(account, leg.Instrument) == 0) return;   // flat: nothing left unprotected
            string key = PosKey(account, leg.Instrument);
            Match own = LegNameRx.Match(leg.Name ?? "");
            lock (Sync)
                if (own.Success && !FirstGone.ContainsKey(leg.Oco))
                    FirstGone[leg.Oco] = new[] { own.Groups[2].Value, leg.OrderState == OrderState.Rejected ? "rejected" : "cancelled", key };
            List<Order> orders;
            lock (account.Orders) orders = account.Orders.ToList();
            lock (Sync) foreach (Order x in Ours) if (x.Account == account && !orders.Contains(x)) orders.Add(x);
            Order stop = null, target = null;
            foreach (Order x in orders)
            {
                if (x.Oco != leg.Oco || !SameInstrument(x.Instrument, leg.Instrument)) continue;
                Match m = LegNameRx.Match(x.Name ?? "");
                if (!m.Success) continue;
                if (m.Groups[2].Value == "stop") stop = x; else if (m.Groups[2].Value == "target") target = x;
            }
            if (stop == null || target == null || !Gone(stop) || !Gone(target) || target.Filled >= target.Quantity) return;
            lock (Sync)
            {
                if (OcoWeCancel.ContainsKey(leg.Oco)) return;
                Manage(account, leg.Instrument);   // watched by the missing-stop alarm, and forgotten when flat
                List<LostPair> lost;
                if (!LostTargets.TryGetValue(key, out lost)) LostTargets[key] = lost = new List<LostPair>();
                if (lost.Any(x => x.Target == target)) return;
                // An OCO partner is cancelled, never rejected: a lone rejected leg went first. Two cancelled legs:
                // the first one reported gone.
                string[] first;
                bool stopRej = stop.OrderState == OrderState.Rejected, targetRej = target.OrderState == OrderState.Rejected;
                if (stopRej != targetRej) first = new[] { stopRej ? "stop" : "target", "rejected" };
                else if (!FirstGone.TryGetValue(leg.Oco, out first)) first = new[] { "stop", stopRej ? "rejected" : "cancelled" };
                lost.Add(new LostPair { Target = target, FirstRole = first[0], FirstState = first[1] });
            }
        }

        private static void CheckStops(double now)
        {
            List<Account> accounts = new List<Account>();
            lock (Account.All) foreach (Account a in Account.All) if (!IsNeverTradable(a.Name ?? "")) accounts.Add(a);
            foreach (Account a in accounts)
            {
                if (!Steady(a, now)) continue;
                List<Order> orders;
                lock (a.Orders) orders = a.Orders.ToList();
                foreach (Order o in orders)
                    if (o.Instrument != null && IsWorking(o.OrderState) && IsChartBridgeLeg(o)) lock (Sync) Manage(a, o.Instrument);
            }
            List<Tuple<Account, Instrument>> managed;
            lock (Sync) managed = Managed.Values.ToList();
            foreach (Tuple<Account, Instrument> m in managed)
            {
                Account a = m.Item1;
                Instrument inst = m.Item2;
                string key = PosKey(a, inst);
                if (!Steady(a, now)) continue;
                int pos = SignedPosition(a, inst);
                List<Order> orders;
                lock (a.Orders) orders = a.Orders.ToList();
                bool legsWorking = false;
                LostPair lostTarget = null;
                int stops = 0, targets = 0;
                foreach (Order o in orders)
                {
                    if (!SameInstrument(o.Instrument, inst) || !IsWorking(o.OrderState)) continue;
                    string lr = RoleFor(o);   // 0.4.0 B4: "stop" or "target" for a ChartBridge leg, merged ones too
                    if (lr != "stop" && lr != "target") continue;
                    legsWorking = true;
                    if (lr == "stop" && pos != 0 && IsBuy(o) == (pos < 0)) stops += Math.Max(0, o.Quantity - o.Filled);
                    if (lr == "target" && pos != 0 && IsBuy(o) == (pos < 0)) targets += Math.Max(0, o.Quantity - o.Filled);
                }
                lock (Sync)
                {
                    if (pos == 0)
                    {
                        ForgetLostPairs(key);
                        Uncovered.Remove(key);
                        Alarmed.RemoveWhere(x => x.StartsWith(key + "|", StringComparison.Ordinal));
                        double since;
                        if (legsWorking) { FlatSince.Remove(key); continue; }
                        if (!FlatSince.TryGetValue(key, out since)) { FlatSince[key] = now; continue; }
                        if (now - since >= SettleMs) { Managed.Remove(key); FlatSince.Remove(key); }
                        continue;
                    }
                    FlatSince.Remove(key);
                    int along = Math.Abs(pos);
                    if (stops >= along) { Uncovered.Remove(key); Alarmed.RemoveWhere(x => x.StartsWith(key + "|", StringComparison.Ordinal)); continue; }
                    List<LostPair> lost;
                    if (targets < along && LostTargets.TryGetValue(key, out lost)) lostTarget = lost.LastOrDefault(x => IsBuy(x.Target) == (pos < 0));
                    string snap = pos + ":" + stops + (lostTarget != null ? ":" + targets + ":oco:" + lostTarget.FirstRole : "");
                    KeyValuePair<string, double> was;
                    if (!Uncovered.TryGetValue(key, out was) || was.Key != snap) { Uncovered[key] = new KeyValuePair<string, double>(snap, now); continue; }
                    if (now - was.Value < SettleMs || !Alarmed.Add(key + "|" + snap)) continue;
                }
                // The text up to "contract(s)" is unchanged from 0.3.0, so a search for the old alarm still finds it.
                string oco = "";
                if (lostTarget != null)
                {
                    oco = lostTarget.FirstRole == "target"
                        ? "; the target was " + lostTarget.FirstState + " and the stop was cancelled with it (OCO)"
                        : "; the target was cancelled too (OCO)";
                    oco += stops == 0 && targets == 0 ? ", so the position has no stop and no target" : ", so working targets cover " + targets + " contract(s)";
                }
                Alarm(Where(a, inst) + ": the position is " + pos + " but ChartBridge's working stops cover " + stops + " contract(s)" + oco + "; check NinjaTrader and add a stop");
            }
        }

        public static void CheckLegs(double now)
        {
            ScanEntries(now);
            try { CheckStops(now); } catch (Exception ex) { ChartBridgeServer.Log("stop check error: " + ex.Message); }
            try { KeepPlansSaved(); } catch (Exception ex) { ChartBridgeServer.Log("planned brackets check error: " + ex.Message); }   // 0.3.8
            try { MergeEvery2s(now); } catch (Exception ex) { ChartBridgeServer.Log("merge check error: " + ex.Message); }   // 0.4.0 B4
            try { KeepStrategies(now); } catch (Exception ex) { ChartBridgeServer.Log("strategies check error: " + ex.Message); }   // 0.4.0 B1
            List<Account> accounts = new List<Account>();
            lock (Account.All) foreach (Account a in Account.All) if (!IsNeverTradable(a.Name ?? "")) accounts.Add(a);
            HashSet<string> seen = new HashSet<string>();
            foreach (Account a in accounts)
            {
                if (!Steady(a, now)) continue;
                List<Order> orders;
                lock (a.Orders) orders = a.Orders.ToList();
                foreach (IGrouping<string, Order> g in orders.Where(o => IsWorking(o.OrderState) && IsChartBridgeLeg(o) && o.Instrument != null).GroupBy(o => o.Instrument.FullName))
                {
                    string key = a.Name + "|" + g.Key;
                    seen.Add(key);
                    try { CheckLegs(a, g.First().Instrument, g.ToList(), key, now); }
                    catch (Exception ex) { Alarm(g.Key + " " + a.Name + ": legs check failed (" + ex.Message + "); check the position's stop in NinjaTrader"); }
                }
            }
            lock (Suspect) foreach (string k in Suspect.Keys.Where(k => !seen.Contains(k)).ToList()) Suspect.Remove(k);
        }

        private class Unit { public bool Buy; public int Left; public List<Order> Legs = new List<Order>(); }

        private static void CheckLegs(Account account, Instrument inst, List<Order> legs, string key, double now)
        {
            int pos = SignedPosition(account, inst);
            // A unit is one OCO pair (or one lone leg): it closes at most its largest leg's contracts.
            List<Unit> units = new List<Unit>();
            Dictionary<string, Unit> byOco = new Dictionary<string, Unit>();
            foreach (Order o in legs)
            {
                Unit u;
                string grp = MergeUnitKey(o);   // 0.4.0 B4: the OCO id, or a merged set's group
                if (grp == null || !byOco.TryGetValue(grp, out u))
                {
                    u = new Unit { Buy = IsBuy(o) };
                    units.Add(u);
                    if (grp != null) byOco[grp] = u;
                }
                u.Legs.Add(o);
                u.Left = Math.Max(u.Left, o.Quantity - o.Filled);
            }
            List<Unit> wrong = units.Where(u => pos == 0 || u.Buy == (pos > 0)).ToList();   // a buy leg protects a short, a sell leg a long
            List<Unit> right = units.Where(u => !wrong.Contains(u)).ToList();
            int excess = right.Sum(u => u.Left) - Math.Abs(pos);
            if (wrong.Count == 0 && excess <= 0) { lock (Suspect) Suspect.Remove(key); return; }
            string snap = pos + ":" + string.Join(",", legs.Select(o => IdFor(o) + "=" + (o.Quantity - o.Filled)).OrderBy(x => x));
            lock (Suspect)
            {
                KeyValuePair<string, double> was;
                if (!Suspect.TryGetValue(key, out was) || was.Key != snap) { Suspect[key] = new KeyValuePair<string, double>(snap, now); return; }
                if (now - was.Value < SettleMs) return;
                Suspect.Remove(key);
            }
            List<Order> cancel = new List<Order>(), change = new List<Order>();
            foreach (Unit u in wrong) cancel.AddRange(u.Legs);
            for (int i = right.Count - 1; i >= 0 && excess > 0; i--)   // newest first
            {
                Unit u = right[i];
                if (u.Left <= excess) { cancel.AddRange(u.Legs); excess -= u.Left; continue; }
                int keep = u.Left - excess;
                if (!MergeShrinkUnit(u.Legs, keep, cancel, change))   // 0.4.0 B4: a merged set shrinks as a set
                foreach (Order o in u.Legs) if (o.Quantity - o.Filled > keep) { o.QuantityChanged = keep + o.Filled; change.Add(o); }
                excess = 0;
            }
            if (cancel.Count > 0) { NoteWeCancelSafe(() => cancel, "cancel"); account.Cancel(cancel.ToArray()); }
            if (change.Count > 0) account.Change(change.ToArray());
            Warn(inst.FullName + " " + account.Name + ": position is " + pos + "; ChartBridge cancelled " + cancel.Count + " and shrank " + change.Count +
                 " bracket leg(s) so they cannot open or add to a position");
        }

        // ---------------------------------------------------------- planned brackets that survive a recompile (0.3.7, 0.3.8)
        // A resting entry's planned stop and target ticks can change after placement, and an order's name cannot, so they
        // are kept in ChartBridge's folder, planned_brackets.txt, one line per entry: "<tag> ticks <stop> <target> <saved,
        // UTC ms>" (0 = none). A line from 0.3.7, "<tag> <stop price> <target price> <saved>", is kept (LegacyPlans) until its
        // entry is recovered and converted to ticks, or it is 7 days old. Written whole to a temp file and swapped in, so a
        // crash never leaves half a file. The records live in memory (under PlanMemLock, never held during file I/O); the
        // file is only a copy of them:
        //   read once at start (StartPlans, on a pool thread, called before the accounts are watched), tried again for a
        //   few seconds when it fails (an antivirus can hold the file); if it never reads, the file is not rewritten that
        //   run (it may hold lines memory lacks) and the pages are told;
        //   written after a placement or a plan change (on the page's connection thread, outside PlaceLock and PlanLock)
        //   and after an entry is done (on a pool thread); a write is tried a few times, and if it still fails the pages
        //   are told and it is tried again every 2 seconds (CheckLegs) until it works. 0.3.8: on HOME the file was empty
        //   while an entry rested (0.3.7 only logged a failed write, once); every 2 seconds each working resting entry is
        //   also checked to have its record, and given one if not.
        // NinjaTrader's thread (KeepBracket, Recover, OrderJson, BracketFor) only reads memory. Until the file has
        // been read, a resting entry's bracket is not recovered: its legs wait, and plan on it is refused; nothing is guessed.
        // Lines older than PlanKeepMs are dropped when the file is read: entries are Day orders.
        private class PlanRecord { public int Stop, Target; public double At; }
        private class LegacyRecord { public double Stop, Target, At; }
        private static readonly object PlanMemLock = new object();    // the records and the flags below; never held during file I/O
        private static readonly object PlanFileLock = new object();   // one writer at a time; each writes the latest records
        private static readonly Dictionary<string, PlanRecord> Plans = new Dictionary<string, PlanRecord>();
        private static readonly Dictionary<string, LegacyRecord> LegacyPlans = new Dictionary<string, LegacyRecord>();
        private static bool plansLoaded, plansReadFailed, writeWaiting;   // writeWaiting: a write asked for before the file was read; done right after the read
        private static string writeFailed;   // why the last write failed (null: it worked); CheckLegs tries again
        private static int writeRetrying;
        private static int planGeneration;   // a load from before a Clear() never lands in the next run
        public const double PlanKeepMs = 7 * 24 * 3600 * 1000.0;
        public static int PlanReadTries = 5, PlanReadRetryMs = 600, PlanWriteTries = 3, PlanWriteRetryMs = 150;
        private static readonly Regex PlanLineRx = new Regex("^([0-9a-f]{8}) ticks ([0-9]{1,9}) ([0-9]{1,9}) ([0-9]{1,15})$");
        private static readonly Regex LegacyLineRx = new Regex("^([0-9a-f]{8}) ([0-9]{1,9}(?:\\.[0-9]{1,8})?) ([0-9]{1,9}(?:\\.[0-9]{1,8})?) ([0-9]{1,15})$");

        private static string PlanFile { get { return Path.Combine(ChartBridgeConfig.Folder, "planned_brackets.txt"); } }

        private static bool PlansLoaded() { lock (PlanMemLock) return plansLoaded; }

        // At start, before the accounts are watched: the file is read on a pool thread, never NinjaTrader's.
        public static void StartPlans()
        {
            int gen;
            lock (PlanMemLock) gen = planGeneration;
            ThreadPool.QueueUserWorkItem(delegate { LoadPlans(gen); });
        }

        // The harness: read the file now, on the calling thread.
        public static void LoadPlansNow() { int gen; lock (PlanMemLock) gen = planGeneration; LoadPlans(gen); }

        public static Func<string> PlanReadFault;    // test hook: a non-null answer fails a read with that text (unused in NinjaTrader)
        public static Func<string> PlanWriteFault;   // test hook: a non-null answer fails a write attempt with that text (unused in NinjaTrader)

        private static void LoadPlans(int gen)
        {
            LoadManaged(gen);   // 0.4.0 B1: managed.txt, read here before planned_brackets.txt counts as read
            Dictionary<string, PlanRecord> read = new Dictionary<string, PlanRecord>();
            Dictionary<string, LegacyRecord> legacy = new Dictionary<string, LegacyRecord>();
            int bad = 0, old = 0;
            string failed = null;
            double now = ChartBridgeTime.NowUtcMs();
            for (int attempt = 1; attempt <= PlanReadTries; attempt++)
            {
                read.Clear(); legacy.Clear(); bad = 0; old = 0; failed = null;
                try
                {
                    string fault = PlanReadFault != null ? PlanReadFault() : null;
                    if (fault != null) throw new IOException(fault);
                    lock (PlanFileLock)
                        if (File.Exists(PlanFile))
                            foreach (string raw in File.ReadAllLines(PlanFile))
                            {
                                string line = raw.Trim();
                                if (line.Length == 0) continue;
                                Match m = PlanLineRx.Match(line), lm = m.Success ? m : LegacyLineRx.Match(line);
                                if (!lm.Success) { bad++; continue; }
                                double at = double.Parse(lm.Groups[4].Value, CultureInfo.InvariantCulture);
                                if (now - at > PlanKeepMs) { old++; continue; }
                                if (m.Success) read[m.Groups[1].Value] = new PlanRecord { Stop = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture), Target = int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture), At = at };
                                else legacy[lm.Groups[1].Value] = new LegacyRecord { Stop = double.Parse(lm.Groups[2].Value, CultureInfo.InvariantCulture), Target = double.Parse(lm.Groups[3].Value, CultureInfo.InvariantCulture), At = at };
                            }
                    break;
                }
                catch (Exception ex) { failed = ex.Message; }
                if (attempt < PlanReadTries) Thread.Sleep(PlanReadRetryMs);   // a pool thread: an antivirus scan holding the file passes
            }
            bool extra;
            lock (PlanMemLock)
            {
                if (gen != planGeneration || plansLoaded) return;
                if (failed != null) { read.Clear(); legacy.Clear(); plansReadFailed = true; }
                extra = writeWaiting || Plans.Keys.Any(k => !read.ContainsKey(k));   // a write asked for, or an entry placed, while the file was being read
                writeWaiting = false;
                foreach (KeyValuePair<string, PlanRecord> kv in read) if (!Plans.ContainsKey(kv.Key)) Plans[kv.Key] = kv.Value;   // a record set meanwhile wins
                foreach (KeyValuePair<string, LegacyRecord> kv in legacy) if (!Plans.ContainsKey(kv.Key)) LegacyPlans[kv.Key] = kv.Value;
                plansLoaded = true;
            }
            if (failed != null)
                Alarm("planned_brackets.txt could not be read (" + failed + ", " + PlanReadTries + " tries); resting entries placed before this start use the ticks in their order names, with an alarm each, and the file is not rewritten until ChartBridge starts again; check the planned stops on the chart");
            if (bad > 0) ChartBridgeServer.Log("skipped " + bad + " unreadable line(s) in planned_brackets.txt");
            if (failed == null && (old > 0 || extra))
            {
                string err = WritePlans();   // drop the old lines, add the new ones
                if (err != null) PlanSaveAlarm("planned_brackets.txt could not be updated after it was read (" + err + "); planned stops and targets set since the start may not survive a recompile or restart");
            }
            // S1: fills an order event saw while the file was being read get their legs now, as that event would have placed
            // them. P8: fills the 2 s scan found first (from while ChartBridge was stopped; the position may have been closed
            // by hand since) are left to the scan path, which legs only what the listed position still holds (on its next
            // pass, within 2 s, once the gap has lasted SettleMs).
            List<Order> waited;
            lock (Sync) { waited = PlanDeferred.Where(kv => kv.Value).Select(kv => kv.Key).ToList(); PlanDeferred.Clear(); PlanWaitSince.Clear(); }
            foreach (Order o in waited)
            {
                try { KeepBracket(o); }
                catch (Exception ex) { Alarm(Where(o.Account, o.Instrument) + ": bracket error (" + ex.Message + "); check the position's stop in NinjaTrader"); }
            }
        }

        // Writes the records as they are now, tried PlanWriteTries times. Never called with PlanMemLock, PlanLock, PlaceLock or
        // Sync held, nor on NinjaTrader's thread (it may sleep between tries). Null, or why not.
        private static string WritePlans()
        {
            string err = null;
            for (int attempt = 1; attempt <= PlanWriteTries; attempt++)
            {
                err = WritePlansOnce();
                if (err == null || err == NotReadYet || err == ReadFailedText) break;
                if (attempt < PlanWriteTries) Thread.Sleep(PlanWriteRetryMs * attempt);
            }
            if (err == NotReadYet) return null;   // queued: written right after the read
            lock (PlanMemLock) writeFailed = err;
            return err;
        }

        private const string NotReadYet = "not read yet", ReadFailedText = "planned_brackets.txt could not be read at start, so it is not rewritten this run";

        private static string WritePlansOnce()
        {
            lock (PlanFileLock)
            {
                List<string> lines;
                lock (PlanMemLock)
                {
                    if (!plansLoaded) { writeWaiting = true; return NotReadYet; }   // never overwrite the file before it has been read
                    if (plansReadFailed) return ReadFailedText;
                    lines = Plans.Select(kv => kv.Key + " ticks " + kv.Value.Stop.ToString(CultureInfo.InvariantCulture) + " " + kv.Value.Target.ToString(CultureInfo.InvariantCulture) + " " +
                                               ((long)kv.Value.At).ToString(CultureInfo.InvariantCulture)).ToList();
                    lines.AddRange(LegacyPlans.Select(kv => kv.Key + " " + PriceText(kv.Value.Stop) + " " + PriceText(kv.Value.Target) + " " + ((long)kv.Value.At).ToString(CultureInfo.InvariantCulture)));
                }
                try
                {
                    string fault = PlanWriteFault != null ? PlanWriteFault() : null;
                    if (fault != null) return fault;
                    Directory.CreateDirectory(ChartBridgeConfig.Folder);
                    string tmp = PlanFile + ".tmp";
                    File.WriteAllLines(tmp, lines.ToArray());
                    if (File.Exists(PlanFile)) File.Replace(tmp, PlanFile, null); else File.Move(tmp, PlanFile);
                    return null;
                }
                catch (Exception ex) { return ex.Message; }
            }
        }

        private static void PlanSaveAlarm(string text)
        {
            bool retry;
            lock (PlanMemLock) retry = !plansReadFailed;
            Alarm(text + (retry ? "; ChartBridge tries again every 2 seconds and says so when it is saved" : ""));
        }

        // Every 2 seconds (CheckLegs, off NinjaTrader's thread): each working resting entry has its record (one without is
        // given one, from the ticks in force), and a write that failed is tried again, on a pool thread.
        private static void KeepPlansSaved()
        {
            bool loaded, readFailed;
            lock (PlanMemLock) { loaded = plansLoaded; readFailed = plansReadFailed; }
            if (!loaded || readFailed) return;
            List<KeyValuePair<Order, Bracket>> resting;
            lock (Sync) resting = BracketOfEntry.Where(kv => kv.Value.Resting && IsWorking(kv.Key.OrderState)).ToList();
            List<string> missing = new List<string>();
            foreach (KeyValuePair<Order, Bracket> kv in resting)
            {
                int st, tt;
                lock (Sync) { st = kv.Value.StopTicks; tt = kv.Value.TargetTicks; }
                lock (PlanMemLock)
                    if (!Plans.ContainsKey(kv.Value.Tag)) { Plans[kv.Value.Tag] = new PlanRecord { Stop = st, Target = tt, At = ChartBridgeTime.NowUtcMs() }; LegacyPlans.Remove(kv.Value.Tag); missing.Add(kv.Value.Tag); }
            }
            if (missing.Count > 0) ChartBridgeServer.Log("planned_brackets.txt had no line for working entry CB#" + string.Join(", CB#", missing) + "; written now");
            string was;
            lock (PlanMemLock) was = writeFailed;
            if (was == null && missing.Count == 0) return;
            if (Interlocked.Exchange(ref writeRetrying, 1) == 1) return;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    string err = WritePlans();
                    if (err == null && was != null) Warn("planned_brackets.txt is saved again (it failed before: " + was + ")");
                }
                catch (Exception ex) { ChartBridgeServer.Log("planned_brackets.txt error: " + ex.Message); }
                finally { Interlocked.Exchange(ref writeRetrying, 0); }
            });
        }

        // In memory only (fast, any thread); the caller writes the file afterwards, outside its locks.
        private static void SetPlan(string tag, int stop, int target)
        {
            lock (PlanMemLock) { Plans[tag] = new PlanRecord { Stop = stop, Target = target, At = ChartBridgeTime.NowUtcMs() }; LegacyPlans.Remove(tag); }
        }

        // A 0.3.7 entry's prices turned into ticks at recovery (NinjaTrader's thread): memory now, the file on a pool thread.
        private static void ConvertLegacy(string tag, int stop, int target)
        {
            SetPlan(tag, stop, target);
            ThreadPool.QueueUserWorkItem(delegate
            {
                try { string err = WritePlans(); if (err != null) PlanSaveAlarm("the converted planned stop and target of entry CB#" + tag + " could not be saved (" + err + ")"); }
                catch (Exception ex) { ChartBridgeServer.Log("planned_brackets.txt error: " + ex.Message); }
            });
        }

        // Memory only: false (and no record) until the file has been read, or when there is no record.
        private static bool TryGetPlan(string tag, out PlanRecord rec)
        {
            lock (PlanMemLock) { rec = null; return plansLoaded && Plans.TryGetValue(tag, out rec); }
        }

        private static bool TryGetLegacy(string tag, out LegacyRecord rec)
        {
            lock (PlanMemLock) { rec = null; return plansLoaded && LegacyPlans.TryGetValue(tag, out rec); }
        }

        private static void ForgetPlanLater(string tag)
        {
            bool had;
            lock (PlanMemLock) { had = Plans.Remove(tag); had |= LegacyPlans.Remove(tag); }
            if (!had) return;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    string err = WritePlans();
                    if (err != null) ChartBridgeServer.Log("could not update planned_brackets.txt (" + err + "); the old line is dropped when the file is next read after 7 days");
                }
                catch (Exception ex) { ChartBridgeServer.Log("planned_brackets.txt error: " + ex.Message); }
            });
        }

        private static string PositionJson(string account, string root, MarketPosition mp, int qty, double avg)
        {
            int signed = mp == MarketPosition.Long ? qty : mp == MarketPosition.Short ? -qty : 0;
            return "{\"type\":\"position\",\"account\":" + CbJson.Str(account) + ",\"root\":" + CbJson.Str(root) +
                   ",\"qty\":" + signed + ",\"avgPrice\":" + (signed != 0 ? CbJson.Num(avg) : "null") + "}";
        }

        // 0.4.0 accounts: a v2 page gets the tradable accounts (as before), a v3 page every watched one (ChartBridgeAccounts.ScopeFor).
        private static string OrdersJson(ChartBridgeClient client) { return OrdersListJson(client, null); }

        private static string OrdersListJson(ChartBridgeClient client, HashSet<Order> listed)
        {
            List<string> items = new List<string>();
            foreach (Account a in ChartBridgeAccounts.ScopeFor(client))
            {
                List<Order> orders;
                lock (a.Orders) orders = a.Orders.ToList();
                foreach (Order o in orders)
                    if (IsWorking(o.OrderState) && ChartBridgeServer.RootFor(o.Instrument) != null)
                    {
                        items.Add(ChartBridgeAccounts.ForPage(client, a, OrderJson(o, null), o));   // 0.4.0 review 2: o for a v3 page's "by"
                        if (listed != null) lock (listed) listed.Add(o);   // 0.5.1: the snapshot sent it as working
                    }
            }
            return "{\"type\":\"orders\",\"list\":[" + string.Join(",", items) + "]}";
        }

        // 0.5.1 accounts: accounts that became listed (a first sighting, Show, back from the archive): a signed-in v3 page gets their
        // working orders and positions (it got none of their messages while they were not listed). Never a full "orders" list here:
        // a page replaces its orders on that message, and could lose another account's newer update. Each order goes as its own
        // "order" message (pages merge it); then their positions. Inside a Snapshot, like sign-in's list.
        public static Action SnapshotHook;   // test hook: runs between building a snapshot's messages and queuing them (unused in NinjaTrader)

        internal static void SendScopeAgain(ChartBridgeClient client, ICollection<string> accounts)
        {
            Snapshot(client, delegate(SnapNotes notes)
            {
                foreach (Account a in ChartBridgeAccounts.ScopeFor(client))
                {
                    if (!accounts.Contains(a.Name)) continue;
                    List<Order> orders;
                    lock (a.Orders) orders = a.Orders.ToList();
                    foreach (Order o in orders)
                    {
                        if (!IsWorking(o.OrderState) || ChartBridgeServer.RootFor(o.Instrument) == null) continue;
                        string msg = ChartBridgeAccounts.ForPage(client, a, OrderJson(o, null), o);
                        lock (notes.SentWorking) notes.SentWorking.Add(o);
                        Action hook = SnapshotHook;
                        if (hook != null) hook();
                        client.Send(msg);
                    }
                }
                foreach (string p in PositionJsons(client, accounts)) client.Send(p);
            });
        }

        // 0.5.1: the latest state lands last. A snapshot (orders and positions read on the page's or the timer's thread, then queued)
        // can be older than an order or position message NinjaTrader's thread queued for this page while it was built. Each open
        // snapshot has its own notes: NoteAndSend notes each such send in every snapshot open for that page (SnapLock is held only
        // to note or take: NinjaTrader's thread never waits for a build), and right after a snapshot is queued each order and
        // position noted in its notes is sent again, read fresh, marked "again": true (pages never flash or toast for it), then
        // again for anything noted meanwhile, until nothing new came in or MaxSnapshotRounds rounds were sent; the snapshot stays
        // open through its last round. An order that is done is sent again (the very message NinjaTrader's thread sent, as its id
        // is then forgotten) only if this snapshot had sent it as working; otherwise the page already has its final state. A
        // working order sent again keeps NinjaTrader's last error text.
        public const int MaxSnapshotRounds = 20;
        public static Action<int> SnapshotRoundHook;   // test hook: each round of a snapshot's re-sends, with its number (unused in NinjaTrader)

        public sealed class SnapNotes
        {
            public Dictionary<Order, string> Orders = new Dictionary<Order, string>();        // the order, and the last message sent for it (SnapLock)
            public Dictionary<string, string> Positions = new Dictionary<string, string>();   // "account|root", and the last message (SnapLock)
            public readonly HashSet<Order> SentWorking = new HashSet<Order>();               // what the snapshot itself sent as working (lock it)
        }

        internal static void NoteAndSend(ChartBridgeClient c, string account, string msg, bool isOrder, Order o, string root)
        {
            lock (c.SnapLock)
                foreach (SnapNotes n in c.SnapOpen)
                {
                    if (isOrder && o != null) n.Orders[o] = msg;
                    else if (!isOrder && root != null) n.Positions[account + "|" + root] = msg;
                }
            c.Send(msg);
        }

        // Is a snapshot open for this page now? (the harness)
        public static bool SnapshotOpen(ChartBridgeClient c) { lock (c.SnapLock) return c.SnapOpen.Count > 0; }

        internal static void Snapshot(ChartBridgeClient client, Action<SnapNotes> buildAndSend)
        {
            SnapNotes notes = new SnapNotes();
            lock (client.SnapLock) client.SnapOpen.Add(notes);
            try { buildAndSend(notes); }
            finally
            {
                for (int round = 0; ; round++)
                {
                    Dictionary<Order, string> orders;
                    Dictionary<string, string> positions;
                    lock (client.SnapLock)
                    {
                        orders = notes.Orders; positions = notes.Positions;
                        notes.Orders = new Dictionary<Order, string>(); notes.Positions = new Dictionary<string, string>();
                    }
                    bool last = (orders.Count == 0 && positions.Count == 0) || round >= MaxSnapshotRounds - 1;
                    Action<int> rh = SnapshotRoundHook;
                    if (rh != null && !(orders.Count == 0 && positions.Count == 0)) rh(round);
                    try { SendLatest(client, notes, orders, positions); }
                    catch (Exception ex) { ChartBridgeServer.Log("snapshot error: " + ex.Message); }
                    if (last) { lock (client.SnapLock) client.SnapOpen.Remove(notes); break; }   // closed after its last round's sends
                }
            }
        }

        private static string Again(string json) { return json.EndsWith("}", StringComparison.Ordinal) && !json.Contains(",\"again\":true") ? json.Substring(0, json.Length - 1) + ",\"again\":true}" : json; }

        private static void SendLatest(ChartBridgeClient client, SnapNotes notes, Dictionary<Order, string> orders, Dictionary<string, string> positions)
        {
            bool v3 = ChartBridgeV3.IsV3(client);
            foreach (KeyValuePair<Order, string> kv in orders)
            {
                Order o = kv.Key;
                Account a = o.Account;
                if (a == null || !(v3 ? ChartBridgeAccounts.Listed(a.Name) : AccountTradable(a.Name))) continue;
                if (IsDone(o.OrderState))
                {
                    bool sentWorking;
                    lock (notes.SentWorking) sentWorking = notes.SentWorking.Contains(o);
                    if (sentWorking) client.Send(Again(kv.Value));   // the snapshot showed it working: its final message goes last
                    continue;
                }
                string fresh = OrderJson(o, Str(kv.Value, "text"));   // NinjaTrader's last error text kept
                client.Send(Again(v3 ? ChartBridgeAccounts.ForPage(client, a, fresh, o) : fresh));
            }
            foreach (KeyValuePair<string, string> kv in positions)
            {
                int bar = kv.Key.LastIndexOf('|');
                string name = kv.Key.Substring(0, bar), root = kv.Key.Substring(bar + 1);
                if (!(v3 ? ChartBridgeAccounts.Listed(name) : AccountTradable(name))) continue;
                Account a = null;
                lock (Account.All) foreach (Account x in Account.All) if (x.Name == name) { a = x; break; }
                Position found = null;
                if (a != null) { List<Position> ps; lock (a.Positions) ps = a.Positions.ToList(); found = ps.FirstOrDefault(p => p != null && ChartBridgeServer.RootFor(p.Instrument) == root); }
                client.Send(found != null ? PositionJson(name, root, found.MarketPosition, found.Quantity, found.AveragePrice) : kv.Value);
            }
        }

        private static List<string> PositionJsons(ChartBridgeClient client) { return PositionJsons(client, null); }

        private static List<string> PositionJsons(ChartBridgeClient client, ICollection<string> only)
        {
            List<string> items = new List<string>();
            foreach (Account a in ChartBridgeAccounts.ScopeFor(client))
            {
                if (only != null && !only.Contains(a.Name)) continue;
                List<Position> positions;
                lock (a.Positions) positions = a.Positions.ToList();
                foreach (Position p in positions)
                {
                    string root = ChartBridgeServer.RootFor(p.Instrument);
                    if (root != null) items.Add(PositionJson(a.Name, root, p.MarketPosition, p.Quantity, p.AveragePrice));
                }
            }
            return items;
        }
    }
}
