// ChartBridge orders (protocol v2, Step 2: trading from the chart). Part of the ChartBridge add-on;
// install both files together. See nt8/PROTOCOL.md, "Orders (protocol v2)".
//
// Every order path in ChartBridge lives in this file, behind these gates (all checked here, never only
// in the page):
//   1. off unless config.txt has "trading = true";
//   2. only accounts named in "tradeAccounts = ..." (exact names, no wildcard; never Backtest/Playback),
//      only while the account is Connected, and only once ChartBridge is listening to its order events;
//   3. size cap per root, "maxQty.MNQ = 5" (default 1), on the POSITION: the current position plus
//      working entries on the same side plus the new order may not exceed it;
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
            return origin != null && origin.Equals("http://localhost:" + ChartBridgeConfig.Port, StringComparison.OrdinalIgnoreCase);
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
        private static int nextId;

        // Order names carry the bracket, so it survives a recompile:
        //   entry  "CB#1a2b3c4d s8 t16"   legs "CB#1a2b3c4d stop" and "CB#1a2b3c4d target"
        private static readonly Regex EntryNameRx = new Regex("^CB#([0-9a-f]{8}) s([0-9]{1,3}) t([0-9]{1,3})$");
        private static readonly Regex LegNameRx = new Regex("^CB#([0-9a-f]{8}) (stop|target)$");

        private class Bracket
        {
            public Account Account;
            public Instrument Instrument;
            public string Tag;
            public bool EntryIsBuy, Dead;     // Dead: flattened; late fills get no legs
            public int StopTicks, TargetTicks;
            public int Covered;               // entry contracts already given legs
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
            return m.Success ? m.Groups[2].Value : "other";
        }

        private static bool IsChartBridgeLeg(Order o) { return LegNameRx.IsMatch(o.Name ?? ""); }

        public static void Clear()
        {
            lock (Sync) { IdOf.Clear(); ById.Clear(); CidOf.Clear(); BracketOfEntry.Clear(); PairOfLeg.Clear(); }
            lock (Last) Last.Clear();
            lock (Suspect) Suspect.Clear();
            lock (ConnectedSince) ConnectedSince.Clear();
        }

        // ---------------------------------------------------------- strict message reading (gate 8)
        private static readonly Regex KeyRx = new Regex("\"(\\w+)\"\\s*:");
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
            Match m = Regex.Match(text, "\"" + key + "\"\\s*:\\s*(-?[0-9]{1,9})\\s*[,}]");
            if (!m.Success) return -1;
            value = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
            return 1;
        }

        // A plain decimal price (no exponent), as Int above.
        private static int Dec(string text, string key, out double value)
        {
            value = 0;
            if (!Has(text, key)) return 0;
            Match m = Regex.Match(text, "\"" + key + "\"\\s*:\\s*([0-9]{1,9}(?:\\.[0-9]{1,10})?)\\s*[,}]");
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

        // Contracts still to fill on every working order for this account and contract, by side (any
        // order, from the chart or not, bracket legs too). Orders sharing an OCO id fill one at a time,
        // so a group counts once, at its largest.
        private static void PendingOrders(Account account, Instrument inst, out int buys, out int sells)
        {
            buys = 0; sells = 0;
            List<Order> orders;
            lock (account.Orders) orders = account.Orders.ToList();
            Dictionary<string, int> groups = new Dictionary<string, int>();   // "b|oco" or "s|oco" -> largest left
            foreach (Order o in orders)
            {
                if (!SameInstrument(o.Instrument, inst) || !IsWorking(o.OrderState)) continue;
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
            int cap = CapFor(root), pos = SignedPosition(account, inst), pendBuy, pendSell;
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
                if (Int("{" + bracketBody + "}", "stop", out stopTicks) == -1 || Int("{" + bracketBody + "}", "target", out targetTicks) == -1)
                    return "bracket stop and target must be whole numbers of ticks";
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
                    if (br.Account == account && SameInstrument(br.Instrument, inst)) br.Dead = true;   // late fills get no legs
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

        // Every order update on a watched account: keep ChartBridge's brackets in step (always, even with
        // trading switched off, so a position placed from the chart keeps its legs), then tell the pages
        // (tradable accounts and served contracts only), then forget orders that are done.
        public static void OnOrderUpdate(Account account, OrderEventArgs e)
        {
            if (account == null || e.Order == null) return;
            Order o = e.Order;
            string root = ChartBridgeServer.RootFor(o.Instrument);
            string role = RoleFor(o);
            string where = (root ?? (o.Instrument != null ? o.Instrument.FullName : "?")) + " " + account.Name;
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

        private static void Forget(Order o)
        {
            lock (Sync)
            {
                Bracket br;
                if (BracketOfEntry.TryGetValue(o, out br) && (br.Dead || br.Covered >= o.Filled)) BracketOfEntry.Remove(o);
                Pair pair;
                if (PairOfLeg.TryGetValue(o, out pair))
                {
                    Order other = pair.Stop == o ? pair.Target : pair.Stop;
                    if (other == null || IsDone(other.OrderState)) { PairOfLeg.Remove(o); if (other != null) PairOfLeg.Remove(other); }
                }
                string id;
                if (IdOf.TryGetValue(o, out id) && !BracketOfEntry.ContainsKey(o) && !PairOfLeg.ContainsKey(o)) { IdOf.Remove(o); ById.Remove(id); CidOf.Remove(o); }
            }
        }

        // Rebuild a bracket from the entry's name (after a recompile, the in-memory state is gone).
        private static Bracket Recover(Order entry)
        {
            Match m = EntryNameRx.Match(entry.Name ?? "");
            if (!m.Success || entry.Account == null) return null;
            Bracket br = new Bracket { Account = entry.Account, Instrument = entry.Instrument, Tag = m.Groups[1].Value, EntryIsBuy = IsBuy(entry),
                                       StopTicks = int.Parse(m.Groups[2].Value), TargetTicks = int.Parse(m.Groups[3].Value) };
            if (br.StopTicks == 0 && br.TargetTicks == 0) return null;
            // Each fill increment got one pair (or one lone leg). A pair's legs may differ in size after a
            // partial fill shrank one, so a pair counts at its larger leg.
            List<Order> orders;
            lock (entry.Account.Orders) orders = entry.Account.Orders.ToList();
            Dictionary<string, int> pairs = new Dictionary<string, int>();
            foreach (Order leg in orders)
            {
                Match lm = LegNameRx.Match(leg.Name ?? "");
                if (!lm.Success || lm.Groups[1].Value != br.Tag || leg.OrderState == OrderState.Rejected) continue;
                if (string.IsNullOrEmpty(leg.Oco)) { br.Covered += leg.Quantity; continue; }   // a lone leg (stop only or target only)
                int had;
                if (!pairs.TryGetValue(leg.Oco, out had) || leg.Quantity > had) pairs[leg.Oco] = leg.Quantity;
            }
            br.Covered += pairs.Values.Sum();
            br.CoveredValue = br.Covered * entry.AverageFillPrice;
            ChartBridgeServer.Log("bracket recovered from the order name " + entry.Name + " (" + br.Covered + " contracts already have legs)");
            return br;
        }

        // Each new fill increment of an entry gets its own OCO stop and target for exactly that many
        // contracts, priced from the average price of those contracts.
        private static void KeepBracket(Order entry)
        {
            Bracket br;
            int inc;
            double incPrice;
            string oco;
            lock (Sync)
            {
                if (!BracketOfEntry.TryGetValue(entry, out br))
                {
                    br = Recover(entry);
                    if (br == null) return;
                    BracketOfEntry[entry] = br;
                }
                int filled = entry.Filled;
                if (br.Dead || filled <= br.Covered) return;
                inc = filled - br.Covered;
                double value = entry.AverageFillPrice * filled;
                incPrice = (value - br.CoveredValue) / inc;
                br.Covered = filled;
                br.CoveredValue = value;
                oco = br.StopTicks > 0 && br.TargetTicks > 0 ? "cb-" + br.Tag + "-" + filled : "";
            }
            double tick = br.Instrument.MasterInstrument.TickSize;
            OrderAction exit = br.EntryIsBuy ? OrderAction.Sell : OrderAction.Buy;
            Pair pair = new Pair { Bracket = br, Qty = inc };
            if (br.StopTicks > 0)
            {
                double sp = Round(br.EntryIsBuy ? incPrice - br.StopTicks * tick : incPrice + br.StopTicks * tick, tick);
                pair.Stop = br.Account.CreateOrder(br.Instrument, exit, OrderType.StopMarket, OrderEntry.Manual, TimeInForce.Gtc, inc, 0, sp, oco,
                    "CB#" + br.Tag + " stop", NinjaTrader.Core.Globals.MaxDate, null);
            }
            if (br.TargetTicks > 0)
            {
                double tp = Round(br.EntryIsBuy ? incPrice + br.TargetTicks * tick : incPrice - br.TargetTicks * tick, tick);
                pair.Target = br.Account.CreateOrder(br.Instrument, exit, OrderType.Limit, OrderEntry.Manual, TimeInForce.Gtc, inc, tp, 0, oco,
                    "CB#" + br.Tag + " target", NinjaTrader.Core.Globals.MaxDate, null);
            }
            List<Order> legs = new List<Order>();
            lock (Sync)
            {
                if (pair.Stop != null) { IdFor(pair.Stop); PairOfLeg[pair.Stop] = pair; legs.Add(pair.Stop); }
                if (pair.Target != null) { IdFor(pair.Target); PairOfLeg[pair.Target] = pair; legs.Add(pair.Target); }
            }
            br.Account.Submit(legs.ToArray());
            ChartBridgeServer.Log("bracket placed for " + inc + " on " + br.Account.Name + ": " +
                (pair.Stop != null ? "stop " + CbJson.Num(pair.Stop.StopPrice) : "no stop") + ", " + (pair.Target != null ? "target " + CbJson.Num(pair.Target.LimitPrice) : "no target"));
        }

        // A leg filled in part: shrink its partner to what is still open. A leg rejected: say so loudly.
        private static void KeepPartner(Order leg, string role, string where)
        {
            Pair pair;
            lock (Sync) PairOfLeg.TryGetValue(leg, out pair);
            if (leg.OrderState == OrderState.Rejected)
                Alarm(where + ": bracket " + role + " rejected; the position may have NO " + (role == "stop" ? "STOP" : "TARGET"));
            if (pair == null || leg.Filled <= 0) return;
            Order partner = pair.Stop == leg ? pair.Target : pair.Stop;
            if (partner == null || !IsWorking(partner.OrderState)) return;
            int open = leg.Quantity - leg.Filled;
            if (open <= 0) { partner.Account.Cancel(new[] { partner }); return; }
            if (partner.Quantity - partner.Filled > open) { partner.QuantityChanged = open + partner.Filled; partner.Account.Change(new[] { partner }); }
        }

        private static double Round(double price, double tick) { return Math.Round(Math.Round(price / tick) * tick, 10); }

        public static void OnPositionUpdate(Account account, PositionEventArgs e)
        {
            if (account == null || e.Position == null) return;
            Instrument inst = e.Position.Instrument;
            string root = ChartBridgeServer.RootFor(inst);
            if (Enabled && AccountTradable(account.Name) && root != null)
                ChartBridgeServer.SendToTraders(PositionJson(account.Name, root, e.MarketPosition, e.Quantity, e.AveragePrice));
            // Flat, and still flat now (a newer fill may already have opened a position whose legs must stay),
            // on a connection that has been steady (not a reconnect still loading positions).
            if (e.MarketPosition == MarketPosition.Flat && SignedPosition(account, inst) == 0 && Steady(account, ChartBridgeTime.NowUtcMs()))
                CancelLeftoverLegs(account, inst, (root ?? (inst != null ? inst.FullName : "?")) + " " + account.Name);
        }

        // Flat: any ChartBridge stop or target still working would open a new position if it filled.
        private static void CancelLeftoverLegs(Account account, Instrument inst, string where)
        {
            List<Order> orders, leftover = new List<Order>();
            lock (account.Orders) orders = account.Orders.ToList();
            foreach (Order o in orders) if (SameInstrument(o.Instrument, inst) && IsWorking(o.OrderState) && IsChartBridgeLeg(o)) leftover.Add(o);
            if (leftover.Count == 0) return;
            account.Cancel(leftover.ToArray());
            ChartBridgeServer.Log("position flat on " + where + ": cancelled " + leftover.Count + " leftover bracket leg(s)");
        }

        // ---------------------------------------------------------- connection
        public const double SteadyMs = 30000;
        private static readonly Dictionary<Account, double> ConnectedSince = new Dictionary<Account, double>();

        private static string StatusOf(Account a)
        {
            try { return a.Connection == null ? "no connection" : a.Connection.Status.ToString(); } catch (Exception ex) { return "unknown: " + ex.Message; }
        }

        // True once the account has stayed Connected for SteadyMs (the legs check samples it every 2
        // seconds). While NinjaTrader reconnects it can show orders before positions; nothing that
        // cancels legs may act on that picture.
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
