// ChartBridge orders (protocol v2, Step 2: trading from the chart). Part of the ChartBridge add-on;
// install both files together. See nt8/PROTOCOL.md, "Orders (protocol v2)".
//
// Every order path in ChartBridge lives in this file, behind these gates (all checked here, never only
// in the page):
//   1. off unless config.txt has "trading = true";
//   2. only accounts named in "tradeAccounts = ..." (exact names, no wildcard; never Backtest/Playback);
//   3. size cap per root, "maxQty.MNQ = 5" (default 1);
//   4. only ChartBridge's own page: WebSocket Origin must be http://localhost:<port>, and the page must
//      send the token it read from GET /session (new random token each start, no CORS headers);
//   5. prices on the tick grid, within 200 ticks of the last price, stops on the right side;
//   6. only the roots ChartBridge serves, on the contract it resolved;
//   7. at most 10 order actions per second per connection.
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
        public const int MaxTicksAway = 200, MaxActionsPerSecond = 10, DefaultMaxQty = 1, MaxBracketTicks = 2000;

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
        private static readonly Dictionary<string, double> Last = new Dictionary<string, double>();
        public static void NoteLast(string root, double price) { lock (Last) Last[root] = price; }
        private static bool TryLast(string root, out double p) { lock (Last) return Last.TryGetValue(root, out p); }

        // ---------------------------------------------------------- our ids for orders
        // Order ids handed to the page are ours ("o1", "o2", ...), so nothing depends on broker ids.
        private static readonly object Sync = new object();
        private static readonly Dictionary<Order, string> IdOf = new Dictionary<Order, string>();
        private static readonly Dictionary<string, Order> ById = new Dictionary<string, Order>();
        private static readonly Dictionary<Order, string> RoleOf = new Dictionary<Order, string>();
        private static readonly Dictionary<Order, string> CidOf = new Dictionary<Order, string>();
        private static readonly Dictionary<Order, Bracket> BracketOfEntry = new Dictionary<Order, Bracket>();
        private static readonly Dictionary<Order, Bracket> BracketOfLeg = new Dictionary<Order, Bracket>();
        private static int nextId;

        private class Bracket
        {
            public Account Account;
            public Instrument Instrument;
            public bool EntryIsBuy;
            public int StopTicks, TargetTicks;
            public string Oco;
            public Order Stop, Target;
            public int Covered;          // entry contracts already covered by the legs
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

        public static void Clear()
        {
            lock (Sync) { IdOf.Clear(); ById.Clear(); RoleOf.Clear(); CidOf.Clear(); BracketOfEntry.Clear(); BracketOfLeg.Clear(); }
            lock (Last) Last.Clear();
        }

        // ---------------------------------------------------------- messages from the page
        private static readonly Regex StrRx = new Regex("\"(\\w+)\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        private static readonly Regex NumRx = new Regex("\"(\\w+)\"\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)");
        private static readonly Regex BracketRx = new Regex("\"bracket\"\\s*:\\s*\\{([^}]*)\\}");

        private static string Str(string text, string key)
        {
            foreach (Match m in StrRx.Matches(text)) if (m.Groups[1].Value == key) return m.Groups[2].Value.Replace("\\\"", "\"").Replace("\\\\", "\\");
            return null;
        }

        private static bool Num(string text, string key, out double value)
        {
            foreach (Match m in NumRx.Matches(text))
                if (m.Groups[1].Value == key) return double.TryParse(m.Groups[2].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out value);
            value = 0;
            return false;
        }

        // type is auth, order, change, cancel or flatten. Anything that fails a gate becomes a reject.
        public static void OnMessage(ChartBridgeClient client, string type, string text)
        {
            string cid = Str(text, "cid"), id = Str(text, "id");
            try
            {
                if (type == "auth") { Auth(client, text); return; }
                string why = Gate(client);
                if (why != null) { Reject(client, cid, id, why); return; }
                if (type == "order") why = PlaceOrder(client, text, cid);
                else if (type == "change") why = ChangeOrder(text, id);
                else if (type == "cancel") why = CancelOrder(id);
                else if (type == "flatten") why = Flatten(text);
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

        private static Account FindAccount(string name)
        {
            if (!AccountTradable(name)) return null;
            lock (Account.All)
                foreach (Account a in Account.All) if (a.Name.Equals(name, StringComparison.OrdinalIgnoreCase)) return a;
            return null;
        }

        private static bool OnGrid(double price, double tick) { double k = price / tick; return Math.Abs(k - Math.Round(k)) < 1e-6; }

        // Gate 5 for a limit or stop price. isBuy is the order's side.
        private static string PriceProblem(string root, double tick, string kind, bool isBuy, double price)
        {
            if (!(price > 0) || !OnGrid(price, tick)) return "price " + CbJson.Num(price) + " is not on the " + CbJson.Num(tick) + " tick grid";
            double last;
            if (!TryLast(root, out last)) return "no last price yet for " + root + "; wait for a trade";
            if (Math.Abs(price - last) > MaxTicksAway * tick + 1e-9) return "price is more than " + MaxTicksAway + " ticks from the last price " + CbJson.Num(last);
            if (kind == "stop" && isBuy && !(price > last)) return "a buy stop must be above the last price " + CbJson.Num(last);
            if (kind == "stop" && !isBuy && !(price < last)) return "a sell stop must be below the last price " + CbJson.Num(last);
            return null;
        }

        private static string PlaceOrder(ChartBridgeClient client, string text, string cid)
        {
            string accountName = Str(text, "account"), root = (Str(text, "root") ?? "").ToUpperInvariant();
            string side = Str(text, "side"), kind = Str(text, "kind");
            double q, price = 0;
            Account account = FindAccount(accountName);
            if (account == null) return "account " + (accountName ?? "(none)") + " may not trade from the chart (tradeAccounts in config.txt)";
            Instrument inst = ChartBridgeServer.InstrumentFor(root);
            if (inst == null) return "instrument " + root + " is not served by ChartBridge";
            if (side != "buy" && side != "sell") return "side must be buy or sell";
            if (kind != "market" && kind != "limit" && kind != "stop") return "kind must be market, limit or stop";
            if (!Num(text, "qty", out q) || q != Math.Floor(q) || q < 1) return "qty must be a whole number of 1 or more";
            int qty = (int)q, cap = CapFor(root);
            if (qty > cap) return "qty " + qty + " is over the " + root + " cap of " + cap + " (maxQty." + root + " in config.txt)";
            bool isBuy = side == "buy";
            double tick = inst.MasterInstrument.TickSize;
            if (kind != "market")
            {
                if (!Num(text, "price", out price)) return "a " + kind + " order needs a price";
                string bad = PriceProblem(root, tick, kind, isBuy, price);
                if (bad != null) return bad;
            }
            int stopTicks = 0, targetTicks = 0;
            Match bm = BracketRx.Match(text);
            if (bm.Success)
            {
                double s, t;
                if (Num(bm.Groups[1].Value, "stop", out s)) stopTicks = (int)s;
                if (Num(bm.Groups[1].Value, "target", out t)) targetTicks = (int)t;
                if (stopTicks < 0 || targetTicks < 0 || stopTicks > MaxBracketTicks || targetTicks > MaxBracketTicks || s != Math.Floor(s) || t != Math.Floor(t))
                    return "bracket ticks must be whole numbers from 0 to " + MaxBracketTicks;
            }
            OrderType type = kind == "market" ? OrderType.Market : kind == "limit" ? OrderType.Limit : OrderType.StopMarket;
            Order order = account.CreateOrder(inst, isBuy ? OrderAction.Buy : OrderAction.Sell, type, OrderEntry.Manual, TimeInForce.Day, qty,
                kind == "limit" ? price : 0, kind == "stop" ? price : 0, "", "ChartBridge entry", NinjaTrader.Core.Globals.MaxDate, null);
            lock (Sync)
            {
                string id = IdFor(order);
                RoleOf[order] = "entry";
                if (!string.IsNullOrEmpty(cid)) CidOf[order] = cid;
                if (stopTicks > 0 || targetTicks > 0)
                    BracketOfEntry[order] = new Bracket { Account = account, Instrument = inst, EntryIsBuy = isBuy, StopTicks = stopTicks, TargetTicks = targetTicks, Oco = "cb-" + Guid.NewGuid().ToString("N") };
            }
            account.Submit(new[] { order });
            ChartBridgeServer.Log("order sent: " + side + " " + qty + " " + root + " " + kind + (kind == "market" ? "" : " @ " + CbJson.Num(price)) + " on " + account.Name);
            return null;
        }

        private static string ChangeOrder(string text, string id)
        {
            Order o;
            lock (Sync) ById.TryGetValue(id ?? "", out o);
            if (o == null) return "no working order " + (id ?? "(none)");
            if (o.Account == null || !AccountTradable(o.Account.Name)) return "that order's account may not trade from the chart";
            if (!IsWorking(o.OrderState)) return "that order is no longer working";
            double price;
            if (!Num(text, "price", out price)) return "change needs a price";
            string root = ChartBridgeServer.RootFor(o.Instrument);
            if (root == null) return "instrument is not served by ChartBridge";
            bool isBuy = o.OrderAction == OrderAction.Buy || o.OrderAction == OrderAction.BuyToCover;
            string kind = o.OrderType == OrderType.Limit ? "limit" : (o.OrderType == OrderType.StopMarket || o.OrderType == OrderType.StopLimit) ? "stop" : null;
            if (kind == null) return "only limit and stop orders can be moved";
            string bad = PriceProblem(root, o.Instrument.MasterInstrument.TickSize, kind, isBuy, price);
            if (bad != null) return bad;
            if (kind == "limit") o.LimitPriceChanged = price; else o.StopPriceChanged = price;
            o.Account.Change(new[] { o });
            return null;
        }

        private static string CancelOrder(string id)
        {
            Order o;
            lock (Sync) ById.TryGetValue(id ?? "", out o);
            if (o == null) return "no working order " + (id ?? "(none)");
            if (o.Account == null || !AccountTradable(o.Account.Name)) return "that order's account may not trade from the chart";
            if (!IsWorking(o.OrderState)) return "that order is no longer working";
            o.Account.Cancel(new[] { o });     // OCO: the broker or NinjaTrader cancels the other leg
            return null;
        }

        private static string Flatten(string text)
        {
            string accountName = Str(text, "account"), root = (Str(text, "root") ?? "").ToUpperInvariant();
            Account account = FindAccount(accountName);
            if (account == null) return "account " + (accountName ?? "(none)") + " may not trade from the chart (tradeAccounts in config.txt)";
            Instrument inst = ChartBridgeServer.InstrumentFor(root);
            if (inst == null) return "instrument " + root + " is not served by ChartBridge";
            account.Flatten(new[] { inst });   // cancels working orders for the instrument, then closes the position
            ChartBridgeServer.Log("flatten sent: " + root + " on " + account.Name);
            return null;
        }

        private static void Reject(ChartBridgeClient client, string cid, string id, string reason)
        {
            client.Send("{\"type\":\"reject\"" + (cid != null ? ",\"cid\":" + CbJson.Str(cid) : "") + (id != null ? ",\"id\":" + CbJson.Str(id) : "") + ",\"reason\":" + CbJson.Str(reason) + "}");
        }

        // ---------------------------------------------------------- events from NinjaTrader
        public static bool IsWorking(OrderState s)
        {
            return s == OrderState.Initialized || s == OrderState.Submitted || s == OrderState.Accepted || s == OrderState.TriggerPending ||
                   s == OrderState.Working || s == OrderState.ChangePending || s == OrderState.ChangeSubmitted || s == OrderState.PartFilled;
        }

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
            string id = IdFor(o), role, cid;
            lock (Sync) { if (!RoleOf.TryGetValue(o, out role)) role = "other"; CidOf.TryGetValue(o, out cid); }
            bool isBuy = o.OrderAction == OrderAction.Buy || o.OrderAction == OrderAction.BuyToCover;
            double px = o.OrderType == OrderType.Limit ? o.LimitPrice : (o.OrderType == OrderType.StopMarket || o.OrderType == OrderType.StopLimit) ? o.StopPrice : 0;
            StringBuilder b = new StringBuilder("{\"type\":\"order\",\"id\":").Append(CbJson.Str(id));
            if (cid != null) b.Append(",\"cid\":").Append(CbJson.Str(cid));
            b.Append(",\"account\":").Append(CbJson.Str(o.Account != null ? o.Account.Name : ""))
             .Append(",\"root\":").Append(CbJson.Str(ChartBridgeServer.RootFor(o.Instrument) ?? ""))
             .Append(",\"name\":").Append(CbJson.Str(o.Instrument != null ? o.Instrument.FullName : ""))
             .Append(",\"side\":").Append(CbJson.Str(isBuy ? "buy" : "sell"))
             .Append(",\"kind\":").Append(CbJson.Str(KindText(o.OrderType)))
             .Append(",\"qty\":").Append(o.Quantity)
             .Append(",\"filled\":").Append(o.Filled)
             .Append(",\"price\":").Append(px > 0 ? CbJson.Num(px) : "null")
             .Append(",\"avgFill\":").Append(o.Filled > 0 ? CbJson.Num(o.AverageFillPrice) : "null")
             .Append(",\"state\":").Append(CbJson.Str(StateText(o.OrderState)))
             .Append(",\"role\":").Append(CbJson.Str(role))
             .Append(",\"oco\":").Append(string.IsNullOrEmpty(o.Oco) ? "null" : CbJson.Str(o.Oco));
            if (!string.IsNullOrEmpty(text)) b.Append(",\"text\":").Append(CbJson.Str(text));
            return b.Append('}').ToString();
        }

        // Every order update on a tradable account: keep brackets in step with fills, then tell the pages.
        public static void OnOrderUpdate(Account account, OrderEventArgs e)
        {
            if (!Enabled || account == null || !AccountTradable(account.Name) || e.Order == null) return;
            Order o = e.Order;
            try { KeepBracket(o); } catch (Exception ex) { ChartBridgeServer.Log("bracket error: " + ex.Message); }
            string text = o.OrderState == OrderState.Rejected ? "NinjaTrader rejected it (" + e.Error.ToString() + ")" : null;
            ChartBridgeServer.SendToTraders(OrderJson(o, text));
        }

        // After the entry fills (in part or in full), place the stop and target as an OCO pair for the
        // filled quantity; on later partial fills, resize both legs. Prices come from the first fill.
        private static void KeepBracket(Order entry)
        {
            Bracket br;
            lock (Sync) { if (!BracketOfEntry.TryGetValue(entry, out br)) return; }
            int filled = entry.Filled;
            if (filled <= br.Covered) return;
            double tick = br.Instrument.MasterInstrument.TickSize, basis = entry.AverageFillPrice;
            OrderAction exit = br.EntryIsBuy ? OrderAction.Sell : OrderAction.Buy;
            List<Order> submit = new List<Order>(), change = new List<Order>();
            lock (Sync)
            {
                if (br.Covered == 0)
                {
                    if (br.StopTicks > 0)
                    {
                        double sp = br.EntryIsBuy ? basis - br.StopTicks * tick : basis + br.StopTicks * tick;
                        br.Stop = br.Account.CreateOrder(br.Instrument, exit, OrderType.StopMarket, OrderEntry.Manual, TimeInForce.Day, filled, 0, Round(sp, tick),
                            br.StopTicks > 0 && br.TargetTicks > 0 ? br.Oco : "", "ChartBridge stop", NinjaTrader.Core.Globals.MaxDate, null);
                        IdFor(br.Stop); RoleOf[br.Stop] = "stop"; BracketOfLeg[br.Stop] = br; submit.Add(br.Stop);
                    }
                    if (br.TargetTicks > 0)
                    {
                        double tp = br.EntryIsBuy ? basis + br.TargetTicks * tick : basis - br.TargetTicks * tick;
                        br.Target = br.Account.CreateOrder(br.Instrument, exit, OrderType.Limit, OrderEntry.Manual, TimeInForce.Day, filled, Round(tp, tick), 0,
                            br.StopTicks > 0 && br.TargetTicks > 0 ? br.Oco : "", "ChartBridge target", NinjaTrader.Core.Globals.MaxDate, null);
                        IdFor(br.Target); RoleOf[br.Target] = "target"; BracketOfLeg[br.Target] = br; submit.Add(br.Target);
                    }
                }
                else
                {
                    if (br.Stop != null && IsWorking(br.Stop.OrderState)) { br.Stop.QuantityChanged = filled; change.Add(br.Stop); }
                    if (br.Target != null && IsWorking(br.Target.OrderState)) { br.Target.QuantityChanged = filled; change.Add(br.Target); }
                }
                br.Covered = filled;
            }
            if (submit.Count > 0) br.Account.Submit(submit.ToArray());
            if (change.Count > 0) br.Account.Change(change.ToArray());
        }

        private static double Round(double price, double tick) { return Math.Round(Math.Round(price / tick) * tick, 10); }

        public static void OnPositionUpdate(Account account, PositionEventArgs e)
        {
            if (!Enabled || account == null || !AccountTradable(account.Name) || e.Position == null) return;
            string root = ChartBridgeServer.RootFor(e.Position.Instrument);
            if (root == null) return;
            ChartBridgeServer.SendToTraders(PositionJson(account.Name, root, e.MarketPosition, e.Quantity, e.AveragePrice));
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
