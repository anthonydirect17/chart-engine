// ChartBridge orders (protocol v2, Step 2: trading from the chart). Part of the ChartBridge add-on;
// install both files together. See nt8/PROTOCOL.md, "Orders (protocol v2)".
//
// Every order path in ChartBridge lives in this file, behind these gates (all checked here, never only
// in the page):
//   1. off unless config.txt has "trading = true";
//   2. only accounts named in "tradeAccounts = ..." (exact names, no wildcard; never Backtest/Playback),
//      only while the account is Connected, and only once ChartBridge is listening to its order events;
//   3. size cap per root, "maxQty.MNQ = 5" (default 1), on the order and on the POSITION: the current
//      position plus working orders on the same side plus the new order may not exceed it;
//   4. only ChartBridge's own page: WebSocket Origin must be http://localhost:<port>, and the page must
//      send the token it read from GET /session (new random token each start, no CORS headers);
//   5. prices on the tick grid, within 200 ticks of a last price no older than 300 seconds, stops on
//      the right side of the market;
//   6. only the roots ChartBridge serves, on the contract it resolved;
//   7. at most 10 order actions per second per connection;
//   8. strict messages: only the keys the protocol names (a misspelt "bracket" is refused, never
//      ignored), whole numbers must be plain JSON numbers, no duplicate keys, no nested objects other
//      than "bracket", which must be an object.
// Brackets: every fill increment of an entry gets its own OCO stop and target (GTC) for exactly that
// many contracts. The bracket spec is written into the entry's order name, so it survives a
// recompile. When a leg fills in part, its partner is resized; when the position goes flat, leftover
// ChartBridge legs are cancelled; after Flatten, late entry fills get no new legs. Every 2 seconds a
// check compares ChartBridge's legs with the position: legs on a flat or opposite position, or covering
// more contracts than the position, are cancelled or shrunk once that has held for 4 seconds on a
// connection that has been up for 30 seconds (a reconnect can show orders before positions). Bracket
// upkeep runs even if trading is switched off, so a position placed from the chart keeps its legs.
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
using NinjaTrader.Cbi;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    public static class ChartBridgeOrders
    {
        public const int MaxTicksAway = 200, MaxActionsPerSecond = 10, DefaultMaxQty = 1, MaxBracketTicks = 200;
        public const double MaxPriceAgeMs = 300000;

        // ---------------------------------------------------------- settings (from config.txt)
        public static bool Enabled;
        public static readonly List<string> TradeAccounts = new List<string>();
        public static readonly Dictionary<string, int> MaxQty = new Dictionary<string, int>();

        public static void ResetConfig() { Enabled = false; TradeAccounts.Clear(); MaxQty.Clear(); }

        // Called by ChartBridgeConfig.Load for each key it does not know itself.
        public static bool ReadConfig(string key, string val)
        {
            int n;
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
            return false;
        }

        public static bool IsNeverTradable(string name)
        {
            return name.StartsWith("Backtest", StringComparison.OrdinalIgnoreCase) || name.StartsWith("Playback", StringComparison.OrdinalIgnoreCase);
        }

        public static bool AccountTradable(string name)
        {
            if (!Enabled || string.IsNullOrEmpty(name) || IsNeverTradable(name)) return false;
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
            if (on) b.Append(string.Join(",", TradeAccounts.Select(a => CbJson.Str(a))));
            b.Append("],\"maxQty\":{\"*\":").Append(DefaultMaxQty);
            foreach (KeyValuePair<string, int> kv in MaxQty) b.Append(',').Append(CbJson.Str(kv.Key)).Append(':').Append(kv.Value);
            b.Append("}}");
            return b.ToString();
        }

        // ---------------------------------------------------------- last price per root (gate 5)
        private static readonly Dictionary<string, double[]> Last = new Dictionary<string, double[]>();   // root -> { price, time ms }
        public static void NoteLast(string root, double price) { lock (Last) Last[root] = new double[] { price, ChartBridgeTime.NowUtcMs() }; }

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
        private static readonly object PlaceLock = new object();   // one order check and submit at a time
        private static int nextId;

        // Order names carry the bracket, so it survives a recompile:
        //   entry "CB#1a2b3c4d s8 t16"
        //   legs  "CB#1a2b3c4d stop f2 q2 p24990.25" and "CB#1a2b3c4d target f2 q2 p24990.25": the pair for the
        //         fill increment that brought the entry to 2 filled, for 2 contracts, filled at 24990.25
        //   exit  "CB#1a2b3c4d exit f2 q2 p24990.25": a market exit sent when the stop level had already traded
        private static readonly Regex EntryNameRx = new Regex("^CB#([0-9a-f]{8}) s([0-9]{1,3}) t([0-9]{1,3})$");
        private static readonly Regex LegNameRx = new Regex("^CB#([0-9a-f]{8}) (stop|target|exit) f([0-9]{1,6}) q([0-9]{1,6}) p([0-9]{1,9}(?:\\.[0-9]{1,8})?)$");

        private class Bracket
        {
            public Account Account;
            public Instrument Instrument;
            public string Tag;
            public bool EntryIsBuy, AfterFlatten;   // AfterFlatten: Flatten was sent; a later fill still gets legs, and an alarm
            public int StopTicks, TargetTicks;
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
            if (EntryNameRx.IsMatch(name)) return "entry";
            Match m = LegNameRx.Match(name);
            return m.Success && m.Groups[2].Value != "exit" ? m.Groups[2].Value : "other";
        }

        // A ChartBridge stop or target (not an entry, not a market exit).
        private static bool IsChartBridgeLeg(Order o) { Match m = LegNameRx.Match(o.Name ?? ""); return m.Success && m.Groups[2].Value != "exit"; }

        public static void Clear()
        {
            lock (Sync) { IdOf.Clear(); ById.Clear(); CidOf.Clear(); BracketOfEntry.Clear(); PairOfLeg.Clear(); LegBorn.Clear(); Settled.Clear(); Ours.Clear(); SeenFilled.Clear(); }
            lock (Moves) Moves.Clear();
            lock (Last) Last.Clear();
            lock (Suspect) Suspect.Clear();
            lock (ConnectedSince) ConnectedSince.Clear();
        }

        // ---------------------------------------------------------- strict message reading (gate 8)
        // Any quoted text followed by a colon is a key, so "qty " or "stop-loss" cannot slip past as not-a-key.
        private static readonly Regex KeyRx = new Regex("\"([^\"\\\\]*)\"\\s*:");
        private static readonly Dictionary<string, string[]> Keys = new Dictionary<string, string[]>
        {
            { "order", new[] { "type", "cid", "account", "root", "side", "kind", "qty", "price", "bracket" } },
            { "change", new[] { "type", "cid", "id", "price" } },
            { "cancel", new[] { "type", "cid", "id" } },
            { "flatten", new[] { "type", "cid", "account", "root" } },
        };
        private static readonly string[] BracketKeys = { "stop", "target" };
        private static readonly Regex BracketRx = new Regex("\"bracket\"\\s*:\\s*\\{([^{}]*)\\}");

        // Top-level text with the bracket object cut out, or null (with why) if the message is not flat JSON.
        private static string TopLevel(string type, string text, out string bracketBody, out string why)
        {
            bracketBody = null; why = null;
            Match bm = BracketRx.Match(text);
            string top = text;
            if (bm.Success) { bracketBody = bm.Groups[1].Value; top = text.Remove(bm.Index, bm.Length); }
            if (top.Count(ch => ch == '{') != 1 || top.Count(ch => ch == '[') != 0) { why = "message has an unexpected nested object or list"; return null; }
            if (Has(top, "bracket")) { why = "bracket must be an object like {\"stop\":8,\"target\":16}"; return null; }
            if (Duplicate(top) || (bracketBody != null && Duplicate(bracketBody))) { why = "message has a key twice"; return null; }
            string[] allowed;
            if (!Keys.TryGetValue(type, out allowed)) { why = "unknown message type " + type; return null; }
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
        // type is auth, order, change, cancel or flatten. Anything that fails a gate becomes a reject.
        public static void OnMessage(ChartBridgeClient client, string type, string text)
        {
            string cid = Str(text, "cid"), id = Str(text, "id");
            try
            {
                if (type == "auth") { Auth(client, text); return; }
                string why = Gate(client);
                string bracketBody = null, top = why == null ? TopLevel(type, text, out bracketBody, out why) : null;
                if (why != null) { Reject(client, cid, id, why); return; }
                if (type == "order") why = PlaceOrder(top, bracketBody, cid);
                else if (type == "change") why = ChangeOrder(top, id);
                else if (type == "cancel") why = CancelOrder(id);
                else if (type == "flatten") why = Flatten(top);
                if (why != null) Reject(client, cid, id, why);
            }
            catch (Exception ex)
            {
                ChartBridgeServer.Log("order error: " + ex.Message);
                Reject(client, cid, id, "ChartBridge error: " + ex.Message);
            }
        }

        private static void Auth(ChartBridgeClient client, string text)
        {
            string given = Str(text, "token");
            string reason = null;
            if (!Enabled) reason = "trading is off in config.txt";
            else if (!OriginAllowed(client.Origin)) reason = "orders are only accepted from ChartBridge's own page";
            else if (string.IsNullOrEmpty(given) || token.Length == 0 || !SlowEquals(given, token)) reason = "session token does not match; reload the page";
            client.Trader = reason == null;
            client.Send(TradingJson(client.Trader, reason));
            if (client.Trader) { client.Send(OrdersJson()); foreach (string p in PositionJsons()) client.Send(p); }
        }

        private static bool SlowEquals(string a, string b)
        {
            if (a.Length != b.Length) return false;
            int diff = 0;
            for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }

        // Gates 1, 4 and 7 for every order action.
        private static string Gate(ChartBridgeClient client)
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
            if (!AccountTradable(name)) { why = "account " + (name ?? "(none)") + " may not trade from the chart (tradeAccounts in config.txt)"; return null; }
            Account found = null;
            lock (Account.All)
                foreach (Account a in Account.All) if (a.Name.Equals(name, StringComparison.OrdinalIgnoreCase)) { found = a; break; }
            if (found == null) { why = "account " + name + " is in tradeAccounts but not connected in NinjaTrader"; return null; }
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
            if (Math.Abs(price - last) > MaxTicksAway * tick + 1e-9) return "price is more than " + MaxTicksAway + " ticks from the last price " + CbJson.Num(last);
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
                list.Add(new double[] { IsBuy(o) ? delta : -delta, ChartBridgeTime.NowUtcMs() });
            }
        }

        private static void Booked(Account a, Instrument i) { lock (Moves) Moves.Remove(PosKey(a, i)); }

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
        private static void PendingOrders(Account account, Instrument inst, out int buys, out int sells)
        {
            buys = 0; sells = 0;
            List<Order> orders;
            lock (account.Orders) orders = account.Orders.ToList();
            lock (Sync) foreach (Order o in Ours) if (o.Account == account && !orders.Contains(o)) orders.Add(o);
            Dictionary<string, int> groups = new Dictionary<string, int>();   // "b|oco" or "s|oco" -> largest left
            foreach (Order o in orders)
            {
                if (!SameInstrument(o.Instrument, inst) || !MayFill(o.OrderState)) continue;
                int left = Math.Max(0, o.Quantity - o.Filled), had;
                if (string.IsNullOrEmpty(o.Oco)) { if (IsBuy(o)) buys += left; else sells += left; continue; }
                string key = (IsBuy(o) ? "b|" : "s|") + o.Oco;
                if (!groups.TryGetValue(key, out had) || left > had) groups[key] = left;
            }
            foreach (KeyValuePair<string, int> g in groups) { if (g.Key[0] == 'b') buys += g.Value; else sells += g.Value; }
        }

        private static bool IsBuy(Order o) { return o.OrderAction == OrderAction.Buy || o.OrderAction == OrderAction.BuyToCover; }

        private static string PlaceOrder(string top, string bracketBody, string cid)
        {
            lock (PlaceLock) return PlaceOrderLocked(top, bracketBody, cid);   // two pages or tabs cannot both pass the cap check
        }

        private static string PlaceOrderLocked(string top, string bracketBody, string cid)
        {
            string accountName = Str(top, "account"), root = (Str(top, "root") ?? "").ToUpperInvariant();
            string side = Str(top, "side"), kind = Str(top, "kind"), why;
            Account account = FindAccount(accountName, out why);
            if (account == null) return why;
            Instrument inst = ChartBridgeServer.InstrumentFor(root);
            if (inst == null) return "instrument " + root + " is not served by ChartBridge";
            if (side != "buy" && side != "sell") return "side must be buy or sell";
            if (kind != "market" && kind != "limit" && kind != "stop") return "kind must be market, limit or stop";
            int qty;
            if (Int(top, "qty", out qty) != 1 || qty < 1) return "qty must be a whole number of 1 or more";
            bool isBuy = side == "buy";
            int cap = CapFor(root), pos = EffectivePosition(account, inst), pendBuy, pendSell;
            if (qty > cap) return "qty " + qty + " is over the " + root + " cap of " + cap + " (maxQty." + root + " in config.txt)";
            PendingOrders(account, inst, out pendBuy, out pendSell);
            long worst = isBuy ? (long)pos + pendBuy + qty : (long)(-pos) + pendSell + qty;
            if (worst > cap)
                return "this order could make the " + root + " position " + worst + " contracts (position " + pos + ", working " +
                       (isBuy ? pendBuy : pendSell) + ", this order " + qty + "); the cap is " + cap + " (maxQty." + root + " in config.txt)";
            double tick = inst.MasterInstrument.TickSize, price = 0;
            if (kind != "market")
            {
                if (Dec(top, "price", out price) != 1) return "a " + kind + " order needs a plain price";
                string bad = PriceProblem(root, tick, kind, isBuy, price);
                if (bad != null) return bad;
            }
            else if (Has(top, "price")) return "a market order takes no price";
            int stopTicks = 0, targetTicks = 0;
            if (bracketBody != null)
            {
                if (Int("{" + bracketBody + "}", "stop", out stopTicks) != 1 || Int("{" + bracketBody + "}", "target", out targetTicks) != 1)
                    return "bracket needs both stop and target as whole numbers of ticks (0 for none)";
                if (stopTicks < 0 || targetTicks < 0 || stopTicks > MaxBracketTicks || targetTicks > MaxBracketTicks)
                    return "bracket ticks must be from 0 to " + MaxBracketTicks;
                bool reduces = (pos > 0 && !isBuy) || (pos < 0 && isBuy);
                if ((stopTicks > 0 || targetTicks > 0) && reduces) return "a bracket can only go on an order that opens or adds; this order reduces the position";
            }
            string tag = Guid.NewGuid().ToString("N").Substring(0, 8);
            string name = "CB#" + tag + " s" + stopTicks + " t" + targetTicks;
            OrderType type = kind == "market" ? OrderType.Market : kind == "limit" ? OrderType.Limit : OrderType.StopMarket;
            Order order = account.CreateOrder(inst, isBuy ? OrderAction.Buy : OrderAction.Sell, type, OrderEntry.Manual, TimeInForce.Day, qty,
                kind == "limit" ? price : 0, kind == "stop" ? price : 0, "", name, NinjaTrader.Core.Globals.MaxDate, null);
            lock (Sync)
            {
                IdFor(order);
                Ours.Add(order);
                if (!string.IsNullOrEmpty(cid)) CidOf[order] = cid;
                if (stopTicks > 0 || targetTicks > 0)
                    BracketOfEntry[order] = new Bracket { Account = account, Instrument = inst, Tag = tag, EntryIsBuy = isBuy, StopTicks = stopTicks, TargetTicks = targetTicks };
            }
            account.Submit(new[] { order });
            ChartBridgeServer.Log("order sent: " + side + " " + qty + " " + root + " " + kind + (kind == "market" ? "" : " @ " + CbJson.Num(price)) +
                (stopTicks > 0 || targetTicks > 0 ? " with bracket stop " + stopTicks + " / target " + targetTicks + " ticks" : "") + " on " + account.Name);
            return null;
        }

        private static string ChangeOrder(string top, string id)
        {
            Order o;
            lock (Sync) ById.TryGetValue(id ?? "", out o);
            if (o == null) return "no working order " + (id ?? "(none)");
            if (o.Account == null || !AccountTradable(o.Account.Name)) return "that order's account may not trade from the chart";
            if (!IsWorking(o.OrderState)) return "that order is no longer working";
            double price;
            if (Dec(top, "price", out price) != 1) return "change needs a plain price";
            string root = ChartBridgeServer.RootFor(o.Instrument);
            if (root == null) return "instrument is not served by ChartBridge";
            if (o.OrderType == OrderType.StopLimit) return "stop-limit orders can only be moved in NinjaTrader";
            string kind = o.OrderType == OrderType.Limit ? "limit" : o.OrderType == OrderType.StopMarket ? "stop" : null;
            if (kind == null) return "only limit and stop orders can be moved";
            string bad = PriceProblem(root, o.Instrument.MasterInstrument.TickSize, kind, IsBuy(o), price);
            if (bad != null) return bad;
            if (kind == "limit") o.LimitPriceChanged = price; else o.StopPriceChanged = price;
            o.Account.Change(new[] { o });
            ChartBridgeServer.Log("order moved: " + (o.Name ?? "") + " to " + CbJson.Num(price) + " on " + o.Account.Name);
            return null;
        }

        private static string CancelOrder(string id)
        {
            Order o;
            lock (Sync) ById.TryGetValue(id ?? "", out o);
            if (o == null) return "no working order " + (id ?? "(none)");
            if (o.Account == null || !AccountTradable(o.Account.Name)) return "that order's account may not trade from the chart";
            if (ChartBridgeServer.RootFor(o.Instrument) == null) return "instrument is not served by ChartBridge";
            if (!IsWorking(o.OrderState)) return "that order is no longer working";
            o.Account.Cancel(new[] { o });     // OCO: the broker or NinjaTrader cancels the other leg
            ChartBridgeServer.Log("order cancel sent: " + (o.Name ?? "") + " on " + o.Account.Name);
            return null;
        }

        private static string Flatten(string top)
        {
            string accountName = Str(top, "account"), root = (Str(top, "root") ?? "").ToUpperInvariant(), why;
            Account account = FindAccount(accountName, out why);
            if (account == null) return why;
            Instrument inst = ChartBridgeServer.InstrumentFor(root);
            if (inst == null) return "instrument " + root + " is not served by ChartBridge";
            lock (Sync)
                foreach (Bracket br in BracketOfEntry.Values)
                    if (br.Account == account && SameInstrument(br.Instrument, inst)) br.AfterFlatten = true;   // a late fill raises an alarm
            account.Flatten(new[] { inst });   // cancels working orders for the instrument, then closes the position
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
            return "other";
        }

        private static string OrderJson(Order o, string text)
        {
            string id = IdFor(o), cid;
            lock (Sync) CidOf.TryGetValue(o, out cid);
            double px = o.OrderType == OrderType.Limit ? o.LimitPrice : (o.OrderType == OrderType.StopMarket || o.OrderType == OrderType.StopLimit) ? o.StopPrice : 0;
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
             .Append(",\"role\":").Append(CbJson.Str(RoleFor(o)))
             .Append(",\"oco\":").Append(string.IsNullOrEmpty(o.Oco) ? "null" : CbJson.Str(o.Oco));
            if (!string.IsNullOrEmpty(text)) b.Append(",\"text\":").Append(CbJson.Str(text));
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
            string root = ChartBridgeServer.RootFor(o.Instrument);
            string role = RoleFor(o);
            string where = Where(account, o.Instrument);
            try
            {
                if (role == "entry") KeepBracket(o);
                else if (role == "stop" || role == "target") KeepPartner(o, role, where);
            }
            catch (Exception ex) { Alarm(where + ": bracket error (" + ex.Message + "); check the position's stop in NinjaTrader"); }
            bool failed = o.OrderState == OrderState.Rejected || e.Error != ErrorCode.NoError;
            if (failed) ChartBridgeServer.Log("order problem: " + (o.Name ?? "") + " " + StateText(o.OrderState) + " (" + e.Error.ToString() + ") on " + account.Name);
            if (Enabled && AccountTradable(account.Name) && root != null)
                ChartBridgeServer.SendToTraders(OrderJson(o, failed ? "NinjaTrader: " + e.Error.ToString() : null));
            if (IsDone(o.OrderState)) Forget(o);   // after OrderJson, which would otherwise hand out a new id
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
                LegBorn.Remove(o);
                Bracket br;
                if (BracketOfEntry.TryGetValue(o, out br) && br.Covered >= o.Filled) { BracketOfEntry.Remove(o); Settled.Add(o); }
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
        private static Bracket Recover(Order entry, out List<Pair> pairs)
        {
            pairs = new List<Pair>();
            Match m = EntryNameRx.Match(entry.Name ?? "");
            if (!m.Success || entry.Account == null) return null;
            Bracket br = new Bracket { Account = entry.Account, Instrument = entry.Instrument, Tag = m.Groups[1].Value, EntryIsBuy = IsBuy(entry),
                                       StopTicks = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture), TargetTicks = int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture) };
            if (br.StopTicks == 0 && br.TargetTicks == 0) return null;
            List<Order> orders;
            lock (entry.Account.Orders) orders = entry.Account.Orders.ToList();
            Dictionary<int, Pair> byFill = new Dictionary<int, Pair>();
            foreach (Order leg in orders)
            {
                Match lm = LegNameRx.Match(leg.Name ?? "");
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
            if (br.Covered > named) br.CoveredValue += (br.Covered - named) * entry.AverageFillPrice;
            foreach (Pair p in byFill.Values)
                if ((p.Stop != null && !IsDone(p.Stop.OrderState)) || (p.Target != null && !IsDone(p.Target.OrderState))) pairs.Add(p);
            ChartBridgeServer.Log("bracket recovered from the order names " + entry.Name + " (" + br.Covered + " contracts already handled, " + pairs.Count + " working pair(s))");
            return br;
        }

        // Each new fill increment of an entry gets its own OCO stop and target for exactly the contracts
        // that opened or added in the entry's direction, priced from that increment's fill price.
        private static void KeepBracket(Order entry)
        {
            Bracket br;
            bool known;
            lock (Sync) known = BracketOfEntry.TryGetValue(entry, out br);
            if (!known)
            {
                List<Pair> pairs;
                Bracket rec = Recover(entry, out pairs);
                lock (Sync)
                {
                    if (!BracketOfEntry.TryGetValue(entry, out br))
                    {
                        if (rec == null) { if (IsDone(entry.OrderState)) Settled.Add(entry); return; }
                        br = rec;
                        BracketOfEntry[entry] = br;
                        foreach (Pair p in pairs)
                        {
                            if (p.Stop != null) { IdFor(p.Stop); PairOfLeg[p.Stop] = p; }
                            if (p.Target != null) { IdFor(p.Target); PairOfLeg[p.Target] = p; }
                        }
                    }
                }
            }
            int inc, filled;
            double incPrice;
            lock (Sync)
            {
                filled = entry.Filled;
                if (filled <= br.Covered) return;
                inc = filled - br.Covered;
                double value = entry.AverageFillPrice * filled;
                incPrice = (value - br.CoveredValue) / inc;
                br.Covered = filled;
                br.CoveredValue = value;
            }
            string where = Where(br.Account, br.Instrument);
            if (br.AfterFlatten)
                Alarm(where + ": an entry filled AFTER Flatten (" + inc + " contract(s)); a position may be open. It gets its stop and target now; check NinjaTrader");
            // Legs only for contracts the position holds in the entry's direction that ChartBridge's legs do not
            // already cover: contracts of this fill that closed an opposite position, or that other legs already
            // protect, get none (extra legs could open a new position).
            int along = EffectivePosition(br.Account, br.Instrument) * (br.EntryIsBuy ? 1 : -1);
            int covered = LegCover(br.Account, br.Instrument, !br.EntryIsBuy);
            int qty = Math.Min(inc, Math.Max(0, along - covered));
            if (qty < inc)
                Warn(where + ": " + (inc - qty) + " of " + inc + " filled contract(s) got no bracket legs (position " + (along * (br.EntryIsBuy ? 1 : -1)) +
                     ", already covered by legs " + covered + ")");
            if (qty > 0) PlaceLegs(br, filled, qty, incPrice, where);
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
                if (string.IsNullOrEmpty(o.Oco)) { lone += left; continue; }
                if (!groups.TryGetValue(o.Oco, out had) || left > had) groups[o.Oco] = left;
            }
            return lone + groups.Values.Sum();
        }

        private static void PlaceLegs(Bracket br, int filled, int qty, double incPrice, string where)
        {
            double tick = br.Instrument.MasterInstrument.TickSize;
            OrderAction exit = br.EntryIsBuy ? OrderAction.Sell : OrderAction.Buy;
            string mark = " f" + filled.ToString(CultureInfo.InvariantCulture) + " q" + qty.ToString(CultureInfo.InvariantCulture) +
                          " p" + incPrice.ToString("0.########", CultureInfo.InvariantCulture);
            double sp = Round(br.EntryIsBuy ? incPrice - br.StopTicks * tick : incPrice + br.StopTicks * tick, tick);
            double tp = Round(br.EntryIsBuy ? incPrice + br.TargetTicks * tick : incPrice - br.TargetTicks * tick, tick);
            double now = ChartBridgeTime.NowUtcMs();
            // The stop level has already traded (a fast market, or a late event): a stop order there would be
            // rejected or fill at once, and a rejected leg can take its OCO partner with it. Exit now, as the
            // stop would have.
            string root = ChartBridgeServer.RootFor(br.Instrument);
            double last;
            if (br.StopTicks > 0 && root != null && LastPrice(root, out last) == null && (br.EntryIsBuy ? sp >= last : sp <= last))
            {
                Order x = br.Account.CreateOrder(br.Instrument, exit, OrderType.Market, OrderEntry.Manual, TimeInForce.Day, qty, 0, 0, "",
                    "CB#" + br.Tag + " exit" + mark, NinjaTrader.Core.Globals.MaxDate, null);
                lock (Sync) { IdFor(x); Ours.Add(x); }
                br.Account.Submit(new[] { x });
                Alarm(where + ": price had already passed the stop level " + CbJson.Num(sp) + " (last " + CbJson.Num(last) + "); exited " + qty + " at market");
                return;
            }
            string oco = br.StopTicks > 0 && br.TargetTicks > 0 ? "cb-" + br.Tag + "-" + filled.ToString(CultureInfo.InvariantCulture) : "";
            Pair pair = new Pair { Bracket = br, Qty = qty };
            if (br.StopTicks > 0)
                pair.Stop = br.Account.CreateOrder(br.Instrument, exit, OrderType.StopMarket, OrderEntry.Manual, TimeInForce.Gtc, qty, 0, sp, oco,
                    "CB#" + br.Tag + " stop" + mark, NinjaTrader.Core.Globals.MaxDate, null);
            if (br.TargetTicks > 0)
                pair.Target = br.Account.CreateOrder(br.Instrument, exit, OrderType.Limit, OrderEntry.Manual, TimeInForce.Gtc, qty, tp, 0, oco,
                    "CB#" + br.Tag + " target" + mark, NinjaTrader.Core.Globals.MaxDate, null);
            List<Order> legs = new List<Order>();
            lock (Sync)
            {
                foreach (Order leg in new[] { pair.Stop, pair.Target })
                    if (leg != null) { IdFor(leg); PairOfLeg[leg] = pair; LegBorn[leg] = now; Ours.Add(leg); legs.Add(leg); }
            }
            br.Account.Submit(legs.ToArray());
            ChartBridgeServer.Log("bracket placed for " + qty + " on " + where + ": " +
                (pair.Stop != null ? "stop " + CbJson.Num(sp) : "no stop") + ", " + (pair.Target != null ? "target " + CbJson.Num(tp) : "no target"));
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
            Booked(account, inst);   // the position now reflects the fills reported so far
            string root = ChartBridgeServer.RootFor(inst);
            if (Enabled && AccountTradable(account.Name) && root != null)
                ChartBridgeServer.SendToTraders(PositionJson(account.Name, root, e.MarketPosition, e.Quantity, e.AveragePrice));
            // Flat, and still flat now (a newer fill may already have opened a position whose legs must stay),
            // on a connection that has been steady (not a reconnect still loading positions).
            double now = ChartBridgeTime.NowUtcMs();
            if (e.MarketPosition == MarketPosition.Flat && SignedPosition(account, inst) == 0 && Steady(account, now))
                CancelLeftoverLegs(account, inst, Where(account, inst), now);
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

        private static void OnConnectionStatus(object sender, EventArgs e)
        {
            lock (ConnectedSince) ConnectedSince.Clear();   // any change on any connection: every account waits SteadyMs again
        }

        // ---------------------------------------------------------- entries that still need legs
        // An entry can fill while ChartBridge is not running (any NinjaScript compile reloads add-ons), and
        // a filled order sends no further updates. At start, and in every legs check, each ChartBridge entry
        // with fills is passed through KeepBracket, which places what is missing (from the order names) and
        // nothing twice.
        public static void Resume() { ScanEntries(false, ChartBridgeTime.NowUtcMs()); }

        private static void ScanEntries(bool steadyOnly, double now)
        {
            List<Account> accounts = new List<Account>();
            lock (Account.All) foreach (Account a in Account.All) if (!IsNeverTradable(a.Name ?? "")) accounts.Add(a);
            foreach (Account a in accounts)
            {
                if (steadyOnly ? !Steady(a, now) : StatusOf(a) != "Connected") continue;
                List<Order> orders;
                lock (a.Orders) orders = a.Orders.ToList();
                foreach (Order o in orders)
                {
                    if (o.Filled <= 0 || !EntryNameRx.IsMatch(o.Name ?? "")) continue;
                    bool skip;
                    lock (Sync) skip = Settled.Contains(o);
                    if (skip) continue;
                    try { KeepBracket(o); if (IsDone(o.OrderState)) Forget(o); }
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

        public static void CheckLegs(double now)
        {
            ScanEntries(true, now);
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
                if (string.IsNullOrEmpty(o.Oco) || !byOco.TryGetValue(o.Oco, out u))
                {
                    u = new Unit { Buy = IsBuy(o) };
                    units.Add(u);
                    if (!string.IsNullOrEmpty(o.Oco)) byOco[o.Oco] = u;
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
                foreach (Order o in u.Legs) if (o.Quantity - o.Filled > keep) { o.QuantityChanged = keep + o.Filled; change.Add(o); }
                excess = 0;
            }
            if (cancel.Count > 0) account.Cancel(cancel.ToArray());
            if (change.Count > 0) account.Change(change.ToArray());
            Warn(inst.FullName + " " + account.Name + ": position is " + pos + "; ChartBridge cancelled " + cancel.Count + " and shrank " + change.Count +
                 " bracket leg(s) so they cannot open or add to a position");
        }

        private static string PositionJson(string account, string root, MarketPosition mp, int qty, double avg)
        {
            int signed = mp == MarketPosition.Long ? qty : mp == MarketPosition.Short ? -qty : 0;
            return "{\"type\":\"position\",\"account\":" + CbJson.Str(account) + ",\"root\":" + CbJson.Str(root) +
                   ",\"qty\":" + signed + ",\"avgPrice\":" + (signed != 0 ? CbJson.Num(avg) : "null") + "}";
        }

        private static List<Account> TradableAccounts()
        {
            List<Account> list = new List<Account>();
            lock (Account.All) foreach (Account a in Account.All) if (AccountTradable(a.Name)) list.Add(a);
            return list;
        }

        private static string OrdersJson()
        {
            List<string> items = new List<string>();
            foreach (Account a in TradableAccounts())
            {
                List<Order> orders;
                lock (a.Orders) orders = a.Orders.ToList();
                foreach (Order o in orders)
                    if (IsWorking(o.OrderState) && ChartBridgeServer.RootFor(o.Instrument) != null) items.Add(OrderJson(o, null));
            }
            return "{\"type\":\"orders\",\"list\":[" + string.Join(",", items) + "]}";
        }

        private static List<string> PositionJsons()
        {
            List<string> items = new List<string>();
            foreach (Account a in TradableAccounts())
            {
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
