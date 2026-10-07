// ChartBridge 0.4.0 (protocol v3): stop-limit and MIT entries (orderTypes = on) and Order Strategies (strategies = on).
// Part of the ChartBridge add-on; install with ChartBridgeOrders.cs. See nt8/PROTOCOL.md, "Protocol v3", "Order types" and
// "Order Strategies".
//
// This file is the rest of the ChartBridgeOrders class (a partial class), so every v2 gate and the per-fill bracket
// machinery are the same code: the order goes through PlaceOrderLocked (gates 1 to 8, the cap on the position, the tick
// grid, the side of the market, the rate limit, strict keys), and each fill increment goes through KeepBracket and the
// stop-already-traded check, the legs check, the missing-stop alarm, "never opens a position" and Flatten as in v2. What
// lives here:
//   - the two switches (config.txt orderTypes and strategies, off by default; off is 0.3.8 exactly: the hooks in
//     ChartBridgeOrders.cs do nothing while a switch is off);
//   - the price rules of a stop-limit and an MIT (PROTOCOL "Order types");
//   - order.strategy: its strict reading and every rule of its table, refusals naming the key;
//   - the allocation rule (largest remainder, a tie to the later target, a 0-contract target dropped);
//   - per fill increment, one stop and target OCO pair per target bucket, named "... k<bucket>";
//   - breakeven and trailing on ChartBridge's live trades: never loosens, never at or through the last trade, at most one
//     move per stop per 500 ms, a change on the working stop; a rejected move leaves the stop and raises an error;
//   - managed.txt (what a restart needs) and the restart: resumed, or every stop left where it is and said so;
//   - the managed message, to signed-in v3 pages (the one v3 handshake and send, ChartBridgeV3.cs);
//   - for Merge (lane B4): the target shares of an entry and what happens to its management after a swap;
//   - for the copier (lane B5): each fill increment of a strategy entry reaches CopierLeaderFill once, with its stop.
// Written in C# 5 syntax (NinjaTrader 8 compiles NinjaScript as C# 5).
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
        // ---------------------------------------------------------- switches (config.txt, off by default)
        // PROTOCOL "v3 switches": on, true and 1 mean on (any case); anything else is off, with one Output line.
        // Integration (0.4.0): one source of truth for every v3 switch, ChartBridgeSwitches in ChartBridgeV3.cs. ChartBridgeConfig.Load
        // records orderTypes and strategies there (on, true and 1 mean on, any case; anything else is off, with one Output line
        // naming the value), so trading.switches and this file can never disagree.
        public static bool OrderTypesOn { get { return ChartBridgeV3.OrderTypes; } }
        public static bool StrategiesOn { get { return ChartBridgeV3.Strategies; } }

        private static void ResetV3Config() { ChartBridgeSwitches.Note("orderTypes", "off"); ChartBridgeSwitches.Note("strategies", "off"); }

        // Called first by ReadConfig: the keys are ChartBridgeSwitches' (read in ChartBridgeConfig.Load before this); taken here only.
        private static bool ReadV3Config(string key, string val) { return key == "orderTypes" || key == "strategies"; }

        // ---------------------------------------------------------- order types (PROTOCOL "Order types")
        // Strict keys: limitOffset and limitPrice exist only while orderTypes is on (off: unknown keys, refused as in 0.3.8).
        private static string[] WithV3Keys(string type, string[] allowed)
        {
            if (type == "order" && OrderTypesOn) return allowed.Concat(new[] { "limitOffset", "limitPrice" }).ToArray();
            return allowed;
        }

        private static bool NewKind(string kind) { return kind == "stopLimit" || kind == "mit"; }

        // The name's last word for a resting entry of a new kind: "CB#1a2b3c4d atm s8 t16 sl", "... mit".
        private static string KindSuffix(string kind) { return kind == "stopLimit" ? " sl" : kind == "mit" ? " mit" : ""; }

        private static OrderType OrderTypeOf(string kind)
        {
            if (kind == "market") return OrderType.Market;
            if (kind == "limit") return OrderType.Limit;
            if (kind == "stopLimit") return OrderType.StopLimit;
            if (kind == "mit") return OrderType.MIT;
            return OrderType.StopMarket;
        }

        // Gate 5 for an MIT trigger (PROTOCOL table): a buy below the last price, a sell above. At the last price it would
        // trigger at once: refused, use market.
        private static string MitSide(bool isBuy, double price, double last)
        {
            if (Math.Abs(price - last) < 1e-9) return "an MIT at the last price " + CbJson.Num(last) + " would trigger at once; use a market order";
            if (isBuy && !(price < last)) return "a buy MIT must be below the last price " + CbJson.Num(last);
            if (!isBuy && !(price > last)) return "a sell MIT must be above the last price " + CbJson.Num(last);
            return null;
        }

        // A new kind's extra keys, after gate 5 passed on the price. limitOffset and limitPrice go on a stopLimit only, exactly
        // one of them; the limit at or beyond the stop on the side that fills (a buy's at or above its stop, a sell's at or below).
        private static string NewKindProblem(string top, string kind, string root, double tick, bool isBuy, double stop, out double limit)
        {
            limit = 0;
            bool hasOff = Has(top, "limitOffset"), hasPx = Has(top, "limitPrice");
            if (kind != "stopLimit") return hasOff || hasPx ? "limitOffset and limitPrice go on a stopLimit order only" : null;
            if (hasOff == hasPx) return "a stopLimit order needs exactly one of limitOffset (whole ticks, 0 or more) or limitPrice";
            if (hasOff)
            {
                int off;
                if (Int(top, "limitOffset", out off) != 1 || off < 0) return "limitOffset must be a whole number of ticks, 0 or more";
                if (MaxBracketTicks > 0 && off > MaxBracketTicks) return "limitOffset must be at most " + MaxBracketTicks + " ticks (maxBracketTicks in config.txt)";
                limit = Round(isBuy ? stop + off * tick : stop - off * tick, tick);
                if (!(limit > 0)) return "limitOffset would put the limit at or below zero";
                return null;
            }
            if (Dec(top, "limitPrice", out limit) != 1) return "limitPrice must be a plain price";
            if (!(limit > 0) || !OnGrid(limit, tick)) return "limitPrice " + CbJson.Num(limit) + " is not on the " + CbJson.Num(tick) + " tick grid";
            double last;
            string stale = LastPrice(root, out last);
            if (stale != null) return stale;
            if (MaxTicksAway > 0 && Math.Abs(limit - last) > MaxTicksAway * tick + 1e-9)
                return "limitPrice is more than " + MaxTicksAway + " ticks from the last price " + CbJson.Num(last) + " (maxTicksAway in config.txt)";
            if (isBuy && limit < stop - 1e-9) return "a buy stop-limit's limit must be at or above its stop " + CbJson.Num(stop);
            if (!isBuy && limit > stop + 1e-9) return "a sell stop-limit's limit must be at or below its stop " + CbJson.Num(stop);
            return null;
        }

        // change on a ChartBridge stop-limit (an entry, or a strategy's stop leg) or a ChartBridge MIT entry. With both switches
        // off (and for orders placed elsewhere) v2's ChangeOrder rules stand: "stop-limit orders can only be moved in NinjaTrader".
        private static bool MovesNewKind(Order o)
        {
            if (o == null || !(o.Name ?? "").StartsWith("CB#", StringComparison.Ordinal)) return false;   // fix1: an order with no name is not ChartBridge's
            if (o.OrderType == OrderType.StopLimit) return (OrderTypesOn && IsEntryName(o.Name)) || (StrategiesOn && IsStrategyLeg(o.Name));
            return o.OrderType == OrderType.MIT && OrderTypesOn && IsEntryName(o.Name);
        }

        // A stop-limit moves its stop to price and keeps its limit the same number of ticks away; an MIT moves its trigger.
        // Gate 5 as for any move: the stop's side for a stop-limit (its limit too must pass maxTicksAway), the MIT's side.
        private static string MoveNewKind(Order o, string root, double price)
        {
            double tick = o.Instrument.MasterInstrument.TickSize;
            if (o.OrderType == OrderType.MIT)
            {
                string badMit = PriceProblem(root, tick, "mit", IsBuy(o), price);
                if (badMit != null) return badMit;
                o.StopPriceChanged = price;
                o.Account.Change(new[] { o });
                ChartBridgeServer.Log("order moved: " + o.Name + " to " + CbJson.Num(price) + " on " + o.Account.Name);
                return null;
            }
            string bad = PriceProblem(root, tick, "stop", IsBuy(o), price);
            if (bad != null) return bad;
            double limit = Round(o.LimitPrice + (price - o.StopPrice), tick), last;
            if (!(limit > 0)) return "the limit would be at or below zero";
            if (MaxTicksAway > 0 && LastPrice(root, out last) == null && Math.Abs(limit - last) > MaxTicksAway * tick + 1e-9)
                return "the limit would be more than " + MaxTicksAway + " ticks from the last price " + CbJson.Num(last) + " (maxTicksAway in config.txt)";
            o.StopPriceChanged = price;
            o.LimitPriceChanged = limit;
            o.Account.Change(new[] { o });
            ChartBridgeServer.Log("order moved: " + o.Name + " stop to " + CbJson.Num(price) + ", limit to " + CbJson.Num(limit) + " on " + o.Account.Name);
            return null;
        }

        // The order message's v3 fields: a stop-limit's limitPrice; by "strategy" and the leg's bucket.
        private static string V3OrderFields(Order o)
        {
            StringBuilder b = new StringBuilder();
            if (o.OrderType == OrderType.StopLimit && (OrderTypesOn || StrategiesOn)) b.Append(",\"limitPrice\":").Append(o.LimitPrice > 0 ? CbJson.Num(o.LimitPrice) : "null");
            string name = o.Name ?? "";
            if (!StrategiesOn) return b.ToString();   // switched off: the 0.3.8 order message
            if (IsStrategyName(name)) b.Append(",\"by\":\"strategy\"");
            else
            {
                Match m = LegNameRx.Match(name);
                if (m.Success && m.Groups[6].Success) b.Append(",\"by\":\"strategy\",\"bucket\":").Append(m.Groups[6].Value);
            }
            return b.ToString();
        }

        // ---------------------------------------------------------- Order Strategies: names
        //   entry "CB#1a2b3c4d sg s20" (market), "CB#1a2b3c4d atm sg s20" (resting), "... sg s20 sl" / "... sg s20 mit" (a stop-limit
        //         or MIT entry). Fix1 (F5): "s20" is the strategy's stop in ticks, so a fill whose strategy record is lost (managed.txt)
        //         still gets its protective stop from the order's own name. 0.4.0 before fix1 named it "sg" alone (still read).
        //         The longest name, "CB#1a2b3c4d atm sg s999999999 mit", is 33 characters, under v2's longest entry name
        //         ("CB#1a2b3c4d atm s999999999 t999999999 sl", 40).
        //   legs  "CB#1a2b3c4d stop f2 q1 p24990.25 k2", "CB#1a2b3c4d target f2 q1 p24990.25 k2" (LegNameRx, group 6 the bucket)
        //   exit  "CB#1a2b3c4d exit f2 q1 p24990.25 k2" (the stop had already traded)
        private static readonly Regex StrategyNameRx = new Regex("^CB#([0-9a-f]{8})( atm)? sg(?: s([1-9][0-9]{0,8}))?(?: (?:sl|mit)){0,1}$");   // fix1 (F5): " s20", the stop ticks
        private static readonly Regex TagRx = new Regex("^CB#([0-9a-f]{8}) ");

        private static bool IsStrategyName(string name) { return name != null && StrategyNameRx.IsMatch(name); }

        // Fix1 (F5): the name part of a strategy entry: " sg s20" (the stop ticks; the kind's " sl" or " mit" follows).
        private static string StrategyNamePart(StratParams s) { return " sg s" + s.Stop.ToString(CultureInfo.InvariantCulture); }

        // Fix1 (F5): the stop ticks a strategy entry's name carries, or 0 (a name from before fix1, or not a strategy entry).
        private static int NamedStopTicks(string name)
        {
            Match m = StrategyNameRx.Match(name ?? "");
            int t;
            return m.Success && m.Groups[3].Success && int.TryParse(m.Groups[3].Value, NumberStyles.None, CultureInfo.InvariantCulture, out t) ? t : 0;
        }

        private static bool IsStrategyLeg(string name) { Match m = LegNameRx.Match(name ?? ""); return m.Success && m.Groups[6].Success; }

        // ---------------------------------------------------------- Order Strategies: the strategy sent with the entry
        private class StratParams
        {
            public string Name;
            public int Stop, StopLimit = -1;          // StopLimit -1: a stop-market; 0 or more: a stop-limit that many ticks beyond
            public int[] T = new int[0], Share = new int[0];
            public int BeAfter, BePlus;               // BeAfter 0: no breakeven
            public int TrailAfter, TrailBy, TrailStep; // TrailAfter 0: no trailing
            public string Json;                       // the flat object, as sent (keys in the protocol's order)
            public int MaxTarget { get { return T.Length == 0 ? 0 : T.Max(); } }
        }

        private static readonly string[] StrategyKeys = { "name", "stop", "stopLimit", "t1", "t2", "t3", "t1Share", "t2Share", "t3Share", "beAfter", "bePlus", "trailAfter", "trailBy", "trailStep" };
        private static readonly Regex StrategyRx = new Regex("\"strategy\"\\s*:\\s*\\{([^{}\\[\\]]*)\\}");

        // OnMessage, for an order with strategies on: the strategy object is cut out of the message (as TopLevel cuts the
        // bracket), so the rest is checked by gate 8 as before. Strict: a flat object, once, and never with a bracket.
        private static string CutStrategy(ref string text, out string body)
        {
            body = null;
            if (text.IndexOf('\\') >= 0 || !Has(text, "strategy")) return null;   // TopLevel refuses the escape; no strategy: v2's path
            if (Has(text, "bracket")) return "bracket and strategy on one order are refused: send one of them";
            Match m = StrategyRx.Match(text);
            if (!m.Success) return "strategy must be a flat object like {\"name\":\"Scalp\",\"stop\":16,\"t1\":8,\"t1Share\":100}";
            string rest = text.Remove(m.Index, m.Length);
            if (Has(rest, "strategy")) return "message has a key twice";
            body = m.Groups[1].Value;
            text = rest;
            return null;
        }

        // 1 = a plain whole number, 2 = null, 0 = absent, -1 = anything else.
        private static int WholeOrNull(string body, string key, out int v)
        {
            v = 0;
            if (!Has(body, key)) return 0;
            if (IsNull(body, key)) return 2;
            return Int(body, key, out v) == 1 ? 1 : -1;
        }

        // A whole number at least min, or null with why (naming the key). Absent: present = false.
        private static string Ticks(string body, string key, int min, bool required, out int v, out bool present)
        {
            int h = WholeOrNull(body, key, out v);
            present = h != 0;
            if (h == 0) return required ? key + " is required (a whole number of ticks, " + min + " or more)" : null;
            if (h != 1 || v < min) return key + " must be a whole number of ticks, " + min + " or more";
            if (MaxBracketTicks > 0 && v > MaxBracketTicks) return key + " must be at most " + MaxBracketTicks + " ticks (maxBracketTicks in config.txt)";
            return null;
        }

        // Every rule of PROTOCOL "Order Strategies", the table. Null, or why (naming the key).
        private static string ParseStrategy(string body, out StratParams s)
        {
            s = null;
            if (body.IndexOf('{') >= 0 || body.IndexOf('[') >= 0) return "strategy must be a flat object (no object or list inside)";
            if (Duplicate("{" + body + "}")) return "strategy has a key twice";
            string odd = Unknown("{" + body + "}", StrategyKeys);
            if (odd != null) return "unknown key \"" + odd + "\" in strategy";
            StratParams r = new StratParams();
            string t = "{" + body + "}";
            // name: 1 to 40 printable characters; for the log and the page, never in an order name
            r.Name = Str(t, "name");
            if (r.Name == null || r.Name.Length < 1 || r.Name.Length > 40 || r.Name.Any(ch => ch < 0x20)) return "name must be a string of 1 to 40 characters";
            bool p;
            int v;
            // stop: required, 1 or more; the stop always sits at the broker
            string why = Ticks(t, "stop", 1, true, out r.Stop, out p);
            if (why != null) return why + (p ? "" : ": the stop always sits at the broker");
            // stopLimit: null or absent a stop-market; a number, 0 or more, a stop-limit that far beyond the stop
            int h = WholeOrNull(t, "stopLimit", out v);
            if (h == 1)
            {
                if (v < 0) return "stopLimit must be a whole number of ticks, 0 or more, or null";
                if (MaxBracketTicks > 0 && v > MaxBracketTicks) return "stopLimit must be at most " + MaxBracketTicks + " ticks (maxBracketTicks in config.txt)";
                r.StopLimit = v;
            }
            else if (h == -1) return "stopLimit must be a whole number of ticks, 0 or more, or null";
            // t1..t3 in order (t2 needs t1, t3 needs t2), each with its share; the shares add up to exactly 100
            List<int> ts = new List<int>(), shares = new List<int>();
            for (int k = 1; k <= 3; k++)
            {
                int tk, sk;
                bool hasT, hasS;
                why = Ticks(t, "t" + k, 1, false, out tk, out hasT);
                if (why != null) return why;
                int hs = WholeOrNull(t, "t" + k + "Share", out sk);
                hasS = hs != 0;
                if (hasT && ts.Count != k - 1) return "t" + k + " needs t" + (k - 1) + " (targets go in order)";
                if (hasT && !hasS) return "t" + k + "Share is required with t" + k + " (a whole percent from 1 to 100)";
                if (!hasT && hasS) return "t" + k + "Share without t" + k + " is refused";
                if (!hasT) continue;
                if (hs != 1 || sk < 1 || sk > 100) return "t" + k + "Share must be a whole percent from 1 to 100";
                ts.Add(tk); shares.Add(sk);
            }
            if (ts.Count > 0 && shares.Sum() != 100) return "the target shares add up to " + shares.Sum() + "; they must add up to 100";
            r.T = ts.ToArray(); r.Share = shares.ToArray();
            // breakeven: both or neither; beAfter 1 or more, bePlus 0 or more and below beAfter
            bool hasA, hasP;
            why = Ticks(t, "beAfter", 1, false, out r.BeAfter, out hasA);
            if (why != null) return why;
            why = Ticks(t, "bePlus", 0, false, out r.BePlus, out hasP);
            if (why != null) return why;
            if (hasA != hasP) return "beAfter and bePlus go together (both or neither)";
            if (hasA && r.BePlus >= r.BeAfter) return "bePlus must be below beAfter";
            // trailing: all three or none, each 1 or more
            bool ha, hb, hc;
            why = Ticks(t, "trailAfter", 1, false, out r.TrailAfter, out ha);
            if (why != null) return why;
            why = Ticks(t, "trailBy", 1, false, out r.TrailBy, out hb);
            if (why != null) return why;
            why = Ticks(t, "trailStep", 1, false, out r.TrailStep, out hc);
            if (why != null) return why;
            if (!(ha == hb && hb == hc)) return "trailAfter, trailBy and trailStep go together (all three or none)";
            r.Json = StrategyJson(r);
            s = r;
            return null;
        }

        private static string StrategyJson(StratParams s)
        {
            StringBuilder b = new StringBuilder("{\"name\":").Append(CbJson.Str(s.Name)).Append(",\"stop\":").Append(s.Stop)
                .Append(",\"stopLimit\":").Append(s.StopLimit >= 0 ? s.StopLimit.ToString(CultureInfo.InvariantCulture) : "null");
            for (int k = 0; k < s.T.Length; k++) b.Append(",\"t").Append(k + 1).Append("\":").Append(s.T[k]).Append(",\"t").Append(k + 1).Append("Share\":").Append(s.Share[k]);
            if (s.BeAfter > 0) b.Append(",\"beAfter\":").Append(s.BeAfter).Append(",\"bePlus\":").Append(s.BePlus);
            if (s.TrailAfter > 0) b.Append(",\"trailAfter\":").Append(s.TrailAfter).Append(",\"trailBy\":").Append(s.TrailBy).Append(",\"trailStep\":").Append(s.TrailStep);
            return b.Append('}').ToString();
        }

        // ---------------------------------------------------------- the allocation rule (one rule, here and in Merge)
        // q contracts over shares s1..sn (percent, adding up to 100): each target gets floor(q * s / 100); the contracts left
        // over go one each to the targets with the largest remainders, a tie to the later target. The total is exactly q.
        // A target that gets 0 is dropped for that increment (the caller skips it).
        // 3 at 33/33/34: 1/1/1. 1 at 50/50: 0/1. 5 at 50/30/20: 2/2/1.
        // Integration: Merge (lane B4) uses this same rule. Its one addition (lead's default): when a bucket of the first leg is
        // gone, the position is allocated over the buckets left, by their shares out of their sum; so the divisor is the sum of
        // the shares given (100 for a whole strategy, so nothing changes here), and a bucket with no share never gets a contract.
        public static int[] Allocate(int q, int[] shares)
        {
            int n = shares.Length, total = 0;
            for (int i = 0; i < n; i++) total += Math.Max(0, shares[i]);
            int[] got = new int[n];
            long[] rem = new long[n];
            if (total <= 0 || q <= 0) return got;
            int sum = 0;
            for (int i = 0; i < n; i++)
            {
                long p = (long)q * Math.Max(0, shares[i]);
                got[i] = (int)(p / total);
                rem[i] = shares[i] > 0 ? p % total : -1;   // no share: never a remainder contract
                sum += got[i];
            }
            for (int left = q - sum; left > 0; left--)
            {
                int best = -1;
                for (int i = 0; i < n; i++) if (rem[i] >= 0 && (best < 0 || rem[i] >= rem[best])) best = i;   // >=: a tie goes to the later target
                if (best < 0) break;   // never: fewer contracts are left over than buckets with a share
                got[best]++;
                rem[best] = -1;        // at most one extra each
            }
            return got;
        }

        // ---------------------------------------------------------- managed entries
        private class MPair
        {
            public int K, F, Qty;                 // bucket, fill mark (the entry's filled count after the increment), contracts
            public double Fill, Best;             // the increment's fill price, the best price since
            public Order Stop, Target;
            public bool Be, Trailing, Halted;     // Halted: a second move was rejected; the stop stays and is not moved again
            public int Rejects;                   // fix1: moves NinjaTrader rejected (the first is tried once more on the next eligible move)
            public double LastMoveMs = double.MinValue, Pending, PendingAt;   // Pending: the level a move was sent to (0: none)
        }

        private class MEntry
        {
            public string Tag, Root, State = "waiting", Text;
            public Account Account;
            public Instrument Instrument;
            public bool Buy, NoMoves;             // NoMoves: unmanaged (a restart could not resume), or Flatten was sent
            public StratParams S;                    // null: its parameters could not be read after a restart
            public Order Entry;
            public readonly List<MPair> Pairs = new List<MPair>();
            public bool Announced;                // the done message went out
            public bool Quiet;                    // recovered with nothing working and nothing to wait for: not told to the page
            public bool Paused;                   // PauseStrategies (Merge's swap freezes breakeven and trailing on its account and root)
            public bool Merged;                   // fix1 (F4): a Merge swap ran on its position; saved in managed.txt ("merged"), so a restart never resumes it
            public int NameStop;                  // fix1 (F5): the stop ticks the entry's name carries (recovery when S is lost), 0 for none
        }

        // StratLock guards the records and managed.txt's memory. It is a leaf: nothing else is locked and nothing is sent
        // while it is held, so NinjaTrader's market data thread (StrategyTrade) never waits on the order code.
        private static readonly object StratLock = new object();
        private static readonly Dictionary<string, MEntry> ManagedByTag = new Dictionary<string, MEntry>();
        private static readonly Dictionary<string, double[]> SinceStart = new Dictionary<string, double[]>();   // root -> { high, low } of the trades since the start
        private static volatile int managedCount;
        public const double MoveGapMs = 500, MoveConfirmMs = 5000;
        public static Func<double> StrategyClock;     // test hook: the clock for the move rules (unused in NinjaTrader)
        public static bool StrategyInline;            // test hook: moves and managed.txt writes on the calling thread (unused in NinjaTrader)

        private static double SNow() { Func<double> c = StrategyClock; return c != null ? c() : ChartBridgeTime.NowUtcMs(); }

        private static MEntry ManagedOf(string tag) { lock (StratLock) { MEntry m; return tag != null && ManagedByTag.TryGetValue(tag, out m) ? m : null; } }

        private static string TagOf(string name) { Match m = TagRx.Match(name ?? ""); return m.Success ? m.Groups[1].Value : null; }

        // Placement (PlaceOrderLocked, Sync held): the record, waiting for the fill. Fix1 (F5): managed.txt is written and the page
        // told by SaveNewManaged, after Sync and before the entry is sent.
        private static void NewManaged(string tag, Order entry, Account account, Instrument inst, bool buy, string root, StratParams s)
        {
            MEntry m = new MEntry { Tag = tag, Entry = entry, Account = account, Instrument = inst, Buy = buy, Root = root, S = s, NameStop = s.Stop };
            lock (StratLock) { ManagedByTag[tag] = m; managedCount = ManagedByTag.Count; saveDirty = true; }
        }

        // Fix1 (F5): a new strategy entry, before anything else about it is checked: refused for the whole run when managed.txt
        // could not be read at the start (its lines may be lost on the next write, and a fill would have no record), and until
        // it has been read (the first moments after a start). Null, or the plain reason.
        private static string StrategiesRunRefusal()
        {
            if (!PlansLoaded()) return "Order Strategies wait for managed.txt to be read (the first moments after a start); try again in a moment";
            bool failed;
            lock (StratLock) failed = managedReadFailed;
            return failed ? "Order Strategies are off for this run: managed.txt could not be read; fix the file and restart" : null;
        }

        // Fix1 (F5): PlaceOrderLocked (PlaceLock held, Sync not), before the entry is sent: its managed.txt line is written now,
        // whole through the temp file, so the entry is accepted only once its record would survive a restart. A write that
        // fails (after its few tries) refuses the entry: the record and the order's registration are undone, nothing is sent.
        private static string SaveNewManaged(string tag, Order order)
        {
            MEntry m = ManagedOf(tag);
            if (m == null) return "ChartBridge lost the strategy record before it was saved; nothing was sent";
            string err = WriteManaged();
            if (err != null)
            {
                lock (Sync) { Ours.Remove(order); BracketOfEntry.Remove(order); CidOf.Remove(order); DropId(order); }
                lock (StratLock) { ManagedByTag.Remove(tag); managedCount = ManagedByTag.Count; saveDirty = true; }
                ChartBridgeServer.Log("strategy entry CB#" + tag + " not sent: managed.txt could not be saved (" + err + ")");
                return "Order Strategy entry not sent: managed.txt could not be saved (" + err + "), so its strategy would not survive a restart; check ChartBridge's folder and try again";
            }
            // The page hears of it from a pool thread (PlaceLock is held here).
            if (StrategyInline) ManagedChanged(m, false);
            else ThreadPool.QueueUserWorkItem(delegate { try { ManagedChanged(m, false); } catch (Exception ex) { ChartBridgeServer.Log("managed error: " + ex.Message); } });
            return null;
        }

        // For Merge (lane B4): breakeven and trailing paused on an account and contract while a swap runs, and resumed after.
        internal static void PauseStrategies(Account account, Instrument inst, bool paused)
        {
            lock (StratLock)
                foreach (MEntry m in ManagedByTag.Values)
                    if (m.Account == account && SameInstrument(m.Instrument, inst)) m.Paused = paused;
        }

        // For Merge (lane B4, integration): the target shares of a strategy entry, { t1Share, t2Share, t3Share } (0 for none),
        // from this file's own state: the live record, or the managed.txt line read at the start and not yet recovered. Null
        // when they are not known or cannot be read (Merge then refuses: never guessed).
        internal static int[] StrategyShares(string tag)
        {
            StratParams s = null;
            string json = null;
            lock (StratLock)
            {
                MEntry m;
                ManagedLine line;
                if (tag != null && ManagedByTag.TryGetValue(tag, out m) && m.S != null) s = m.S;
                else if (tag != null && ManagedLines.TryGetValue(tag, out line)) json = line.Json;
            }
            if (s == null && json != null && json.Length >= 2 && ParseStrategy(json.Substring(1, json.Length - 2), out s) != null) s = null;
            if (s == null) return null;
            int[] shares = new int[3];
            for (int k = 0; k < s.T.Length && k < 3; k++) shares[k] = s.Share[k];
            return shares;
        }

        // For Merge (lane B4, integration; lead's default): after a swap that changed the brackets of an account and contract
        // (merged, restored or failed), breakeven and trailing stop for every managed entry there: the pairs they followed are
        // gone (cancelled, or placed again as new orders), and PROTOCOL "Merge" gives a merged stop no breakeven or trailing.
        // Every stop stays where it is, and the pages are told (managed, state unmanaged, with the reason).
        // Fix1 (F4): "no breakeven or trailing after a merge" is saved, not only kept in memory: each entry is marked merged and
        // managed.txt is written whole (through its temp file) here, on the merge's own thread, before the swap's line leaves
        // merge_swap.txt; a restart then recovers it as unmanaged ("merged"), and nothing moves its stop again.
        internal static void StrategiesMerged(Account account, Instrument inst, string text)
        {
            List<MEntry> hit = new List<MEntry>();
            lock (StratLock)
                foreach (MEntry m in ManagedByTag.Values)
                    if (m.Account == account && SameInstrument(m.Instrument, inst) && m.State != "done")
                    {
                        m.NoMoves = true; m.Paused = false; m.Merged = true;
                        if (m.State != "waiting") { m.State = "unmanaged"; m.Text = text; m.Quiet = false; }
                        hit.Add(m);
                    }
            if (hit.Count > 0)
            {
                lock (StratLock) saveDirty = true;
                WriteManagedLogged();   // durable now (a failed write is loud and tried again every 2 s, as every managed.txt write)
            }
            foreach (MEntry m in hit) ManagedChanged(m, false);
        }

        // Integration: the one v3 handshake (ChartBridgeV3.TellLanes) for a page that signed in before its client message.
        internal static void SendManagedAfterClient(ChartBridgeClient client) { SendManagedTo(client); }

        // Flatten on an account and contract: breakeven and trailing stop there (its cancels would otherwise race a move).
        private static void StopManaging(Account account, Instrument inst)
        {
            lock (StratLock)
                foreach (MEntry m in ManagedByTag.Values)
                    if (m.Account == account && SameInstrument(m.Instrument, inst)) m.NoMoves = true;
        }

        // ---------------------------------------------------------- per fill increment: one pair per target bucket
        // Called first by PlaceLegs (the v2 path: from an order event, the full increment; from the scan, what the settled
        // position holds). True when the entry is an Order Strategy entry (handled here).
        private static bool PlaceStrategyLegs(Bracket br, int filled, int qty, double incPrice, string where)
        {
            MEntry m = ManagedOf(br.Tag) ?? ReviveDone(br.Tag, where);   // fix1: the 2 s check may have just called it done (a race)
            if (m == null) return false;
            StratParams s = m.S;
            if (s == null && m.NameStop > 0)
            {
                // Fix1 (F5): its parameters were lost in a restart, and the entry's own name carries the stop ticks: the protective
                // stop (a stop-market, the strategy's distance from this increment's fill), no target, never moved. Said loudly.
                s = new StratParams { Name = "stop from the order name", Stop = m.NameStop, StopLimit = -1 };
                Alarm(where + ": Order Strategy entry CB#" + br.Tag + " filled " + qty + " and its strategy could not be read after the restart (" + (m.Text ?? "managed.txt") +
                      "); ChartBridge placed its protective stop from the order's name, " + m.NameStop + " ticks from the fill; NO TARGET, no breakeven or trailing; manage it by hand");
            }
            if (s == null)
            {
                // Its parameters were lost in a restart: never legs from a guess. Watched by the missing-stop alarm.
                lock (Sync) { br.CoveredNoStop += qty; Manage(br.Account, br.Instrument); }
                lock (StratLock) m.Quiet = false;
                Alarm(where + ": NO STOP: " + qty + " contract(s) of Order Strategy entry CB#" + br.Tag + " filled, and its strategy could not be read after the restart (" +
                      (m.Text ?? "managed.txt") + "), so no stop or target was placed (never a guess); set the stop in NinjaTrader");
                ManagedChanged(m, false);
                return true;
            }
            double tick = br.Instrument.MasterInstrument.TickSize;
            string px = incPrice.ToString("0.########", CultureInfo.InvariantCulture);
            double fill = double.Parse(px, CultureInfo.InvariantCulture);   // the price as the leg names carry it (what a restart reads)
            OrderAction exit = br.EntryIsBuy ? OrderAction.Sell : OrderAction.Buy;
            int[] counts = s.T.Length == 0 ? new[] { qty } : Allocate(qty, s.Share);
            // Every bucket's stop is the same level: from this increment's own fill (v2's ATM rule), a stop-limit's limit beyond it.
            double sp = Round(br.EntryIsBuy ? incPrice - s.Stop * tick : incPrice + s.Stop * tick, tick);
            double lp = s.StopLimit >= 0 ? Round(br.EntryIsBuy ? sp - s.StopLimit * tick : sp + s.StopLimit * tick, tick) : 0;
            string root = ChartBridgeServer.RootFor(br.Instrument);
            double last = 0, now = ChartBridgeTime.NowUtcMs();
            // v2's stop-already-traded rule, per pair: a trade from the last 2 seconds at or through the stop level proves it;
            // a market exit then, never a stop through the market.
            bool through = root != null && FreshLast(root, FreshTickMs, out last) && (br.EntryIsBuy ? sp >= last : sp <= last);
            List<Order> send = new List<Order>();
            List<MPair> made = new List<MPair>();
            List<string> placed = new List<string>();
            int exited = 0;
            for (int i = 0; i < counts.Length; i++)
            {
                int c = counts[i], k = i + 1;
                if (c <= 0) continue;   // a target that gets 0 is dropped for this increment
                string mark = " f" + filled.ToString(CultureInfo.InvariantCulture) + " q" + c.ToString(CultureInfo.InvariantCulture) +
                              " p" + px + " k" + k.ToString(CultureInfo.InvariantCulture);
                if (through)
                {
                    Order x = br.Account.CreateOrder(br.Instrument, exit, OrderType.Market, OrderEntry.Manual, TimeInForce.Day, c, 0, 0, "",
                        "CB#" + br.Tag + " exit" + mark, NinjaTrader.Core.Globals.MaxDate, null);
                    lock (Sync) { IdFor(x); Ours.Add(x); Manage(br.Account, br.Instrument); }
                    send.Add(x);
                    exited += c;
                    continue;
                }
                bool hasTarget = s.T.Length > 0;
                double tp = hasTarget ? Round(br.EntryIsBuy ? incPrice + s.T[i] * tick : incPrice - s.T[i] * tick, tick) : 0;
                string oco = hasTarget ? "cb-" + br.Tag + "-f" + filled.ToString(CultureInfo.InvariantCulture) + "-" + k.ToString(CultureInfo.InvariantCulture) : "";
                Pair pair = new Pair { Bracket = br, Qty = c };
                pair.Stop = br.Account.CreateOrder(br.Instrument, exit, s.StopLimit >= 0 ? OrderType.StopLimit : OrderType.StopMarket, OrderEntry.Manual, TimeInForce.Gtc, c,
                    s.StopLimit >= 0 ? lp : 0, sp, oco, "CB#" + br.Tag + " stop" + mark, NinjaTrader.Core.Globals.MaxDate, null);
                if (hasTarget)
                    pair.Target = br.Account.CreateOrder(br.Instrument, exit, OrderType.Limit, OrderEntry.Manual, TimeInForce.Gtc, c, tp, 0, oco,
                        "CB#" + br.Tag + " target" + mark, NinjaTrader.Core.Globals.MaxDate, null);
                lock (Sync)
                {
                    Manage(br.Account, br.Instrument);
                    foreach (Order leg in new[] { pair.Stop, pair.Target })
                        if (leg != null) { IdFor(leg); PairOfLeg[leg] = pair; LegBorn[leg] = now; Ours.Add(leg); send.Add(leg); }
                }
                made.Add(new MPair { K = k, F = filled, Qty = c, Fill = fill, Best = fill, Stop = pair.Stop, Target = pair.Target });
                placed.Add("k" + k + " " + c + (hasTarget ? " target " + CbJson.Num(tp) : ""));
            }
            bool revived;
            lock (StratLock)
            {
                m.Pairs.AddRange(made);
                m.Quiet = false;
                if (m.State == "waiting") m.State = m.NoMoves ? "unmanaged" : "active";
                revived = ReviveLocked(m);   // fix1: called done between the lookup and here: back, with these pairs
            }
            if (revived) ChartBridgeServer.Log("strategy entry CB#" + m.Tag + " on " + where + ": its record was called done as this fill came; kept with its new legs");
            br.Account.Submit(send.ToArray());
            // 0.4.0 copier (integration): the leader's fill increment, once, with its full quantity and the stop that lives longest
            // (the last bucket's: the earlier buckets' stops go with their targets); every bucket's stop is at the same level and
            // breakeven and trailing move them together, so the followers' stops follow it. Exited at once: null, not copied.
            Order copierStop = exited > 0 || made.Count == 0 ? null : made[made.Count - 1].Stop;
            CopierLeaderFill(br, filled, qty, incPrice, copierStop, sp);
            if (exited > 0) Alarm(where + ": price had already passed the stop level " + CbJson.Num(sp) + " (last " + CbJson.Num(last) + "); exited " + exited + " at market");
            else ChartBridgeServer.Log("strategy \"" + s.Name + "\" legs placed for " + qty + " on " + where + ": stop " + CbJson.Num(sp) + (s.StopLimit >= 0 ? " (limit " + CbJson.Num(lp) + ")" : "") + "; " + string.Join(", ", placed));
            ManagedChanged(m, true);
            return true;
        }

        // ---------------------------------------------------------- breakeven and trailing
        // NoteLast (NinjaTrader's market data thread), for every trade while strategies is on. Cheap: the high and low since
        // the start, and with no managed entry nothing else. A move that is due is sent off this thread.
        private static void StrategyTrade(string root, double price)
        {
            if (root == null || !(price > 0)) return;
            List<KeyValuePair<MPair, double>> due = null;
            List<MEntry> touched = null;
            double now = SNow();
            lock (StratLock)
            {
                double[] hl;
                if (!SinceStart.TryGetValue(root, out hl)) SinceStart[root] = new double[] { price, price };
                else { if (price > hl[0]) hl[0] = price; if (price < hl[1]) hl[1] = price; }
                if (managedCount == 0) return;
                foreach (MEntry m in ManagedByTag.Values)
                {
                    if (m.Root != root || m.S == null || m.Pairs.Count == 0) continue;
                    bool moved = false;
                    foreach (MPair p in m.Pairs)
                    {
                        if (m.Buy ? price > p.Best : price < p.Best) { p.Best = price; moved = true; }
                        if (m.NoMoves || m.Paused || !Enabled || !StrategiesOn) continue;
                        double level;
                        if (MoveDue(m, p, price, now, out level))
                        {
                            p.Pending = level; p.PendingAt = now; p.LastMoveMs = now;
                            if (due == null) due = new List<KeyValuePair<MPair, double>>();
                            due.Add(new KeyValuePair<MPair, double>(p, level));
                        }
                    }
                    if (moved) { if (touched == null) touched = new List<MEntry>(); touched.Add(m); }
                }
            }
            if (touched != null) SaveManagedSoon(false);   // the best price: at most once a second
            if (due == null) return;
            if (StrategyInline) SendMoves(due);
            else ThreadPool.QueueUserWorkItem(delegate { SendMoves(due); });
        }

        // StratLock held. The level the pair's stop should go to now, or false. PROTOCOL "Breakeven and trailing":
        //   breakeven: once the best price since the fill is beAfter ticks in profit, the stop to fill plus bePlus, once;
        //   trailing: once trailAfter ticks in profit, best minus trailBy, sent only when at least trailStep better than the stop;
        //   with both, the better level wins; never loosens; never at or through the last trade (it waits for the next one);
        //   at most one move per stop per MoveGapMs; one move in flight per stop.
        private static bool MoveDue(MEntry m, MPair p, double last, double now, out double level)
        {
            level = 0;
            Order stop = p.Stop;
            if (p.Halted || stop == null || p.Pending != 0 || now - p.LastMoveMs < MoveGapMs) return false;
            OrderState st = stop.OrderState;
            if (!IsWorking(st) || st == OrderState.ChangePending || st == OrderState.ChangeSubmitted || st == OrderState.PartFilled) return false;   // a change already on its way
            double tick = m.Instrument.MasterInstrument.TickSize, stopNow = stop.StopPrice;
            if (!(stopNow > 0)) return false;
            StratParams s = m.S;
            double profit = Math.Round((m.Buy ? p.Best - p.Fill : p.Fill - p.Best) / tick, 6);
            bool have = false;
            if (s.BeAfter > 0 && !p.Be && profit >= s.BeAfter)
            {
                double be = Snap(m.Buy ? p.Fill + s.BePlus * tick : p.Fill - s.BePlus * tick, tick, m.Buy);
                if (Tighter(m.Buy, be, stopNow)) { level = be; have = true; }
                else p.Be = true;   // the stop is already at or past breakeven
            }
            if (s.TrailAfter > 0 && profit >= s.TrailAfter)
            {
                p.Trailing = true;
                double tr = Snap(m.Buy ? p.Best - s.TrailBy * tick : p.Best + s.TrailBy * tick, tick, m.Buy);
                bool step = (m.Buy ? tr - stopNow : stopNow - tr) >= s.TrailStep * tick - 1e-9;
                if (step && Tighter(m.Buy, tr, stopNow) && (!have || Tighter(m.Buy, tr, level))) { level = tr; have = true; }
            }
            if (!have) return false;
            if (m.Buy ? !(level < last - 1e-9) : !(level > last + 1e-9)) return false;   // at or through the last trade: wait
            return Tighter(m.Buy, level, stopNow);   // never loosens
        }

        // A long's stop (a sell stop) is tighter when higher; a short's when lower.
        private static bool Tighter(bool buy, double a, double b) { return buy ? a > b + 1e-9 : a < b - 1e-9; }

        // To the tick grid, on the loose side (a long's stop down, a short's up), never past the level the rule names.
        private static double Snap(double price, double tick, bool buy)
        {
            double k = price / tick;
            return Math.Round((buy ? Math.Floor(k + 1e-6) : Math.Ceiling(k - 1e-6)) * tick, 10);
        }

        // Off NinjaTrader's thread: each move is a change on the working stop at the broker (a stop-limit keeps its offset).
        private static void SendMoves(List<KeyValuePair<MPair, double>> due)
        {
            foreach (KeyValuePair<MPair, double> d in due)
            {
                Order stop = d.Key.Stop;
                try
                {
                    // The account must still be Connected (a change into a dropped connection would only be rejected); the
                    // move is let go, never halted, and a later trade tries again.
                    if (stop.Account == null || StatusOf(stop.Account) != "Connected" || !IsWorking(stop.OrderState))
                    {
                        lock (StratLock) d.Key.Pending = 0;
                        continue;
                    }
                    if (stop.OrderType == OrderType.StopLimit) stop.LimitPriceChanged = Round(stop.LimitPrice + (d.Value - stop.StopPrice), stop.Instrument.MasterInstrument.TickSize);
                    stop.StopPriceChanged = d.Value;
                    stop.Account.Change(new[] { stop });
                    ChartBridgeServer.Log("strategy stop move sent: " + stop.Name + " from " + CbJson.Num(stop.StopPrice) + " to " + CbJson.Num(d.Value) + " on " + stop.Account.Name);
                }
                catch (Exception ex) { MoveFailed(stop, d.Value, "the change could not be sent: " + ex.Message); }
            }
        }

        // A move NinjaTrader rejected (or that could not be sent): the stop stays where it was. Fix1 (lead's direction): the first
        // rejection is tried once more, on the next eligible move (the same rules: never loosens, never at or through the last
        // trade, 500 ms apart), with a status warn; a second rejection halts moves for that stop (it stays where it is) with a
        // status warn saying to manage it by hand.
        private static void MoveFailed(Order stop, double to, string why)
        {
            MEntry m = null;
            MPair hit = null;
            bool halted = false;
            lock (StratLock)
                foreach (MEntry x in ManagedByTag.Values)
                    foreach (MPair p in x.Pairs)
                        if (p.Stop == stop) { m = x; hit = p; p.Pending = 0; p.Rejects++; p.Halted = p.Rejects >= 2; halted = p.Halted; }
            if (m == null) return;
            string head = Where(m.Account, m.Instrument) + ": NinjaTrader did not take the move of the strategy stop (bucket " + hit.K + ") to " + Price(to) + " (" + why + "); the stop stays at " + Price(stop.StopPrice);
            if (halted) Warn(head + ". It was refused twice, so breakeven and trailing stop for it: manage it by hand");
            else Warn(head + ". ChartBridge tries once more on the next move");
            ManagedChanged(m, false);
        }

        private static string Price(double p) { return p.ToString("#,0.########", CultureInfo.InvariantCulture); }

        // Every order update on a watched account (OnOrderUpdate, after v2's upkeep): a move confirmed or rejected; a leg or
        // the entry done.
        private static void StrategyOrderUpdate(Order o, OrderEventArgs e)
        {
            MEntry m = ManagedOf(TagOf(o.Name));
            if (m == null) return;
            bool failed = false, changed = false;
            double pendingTo = 0;
            lock (StratLock)
            {
                foreach (MPair p in m.Pairs)
                {
                    if (p.Stop == o && p.Pending != 0)
                    {
                        if (e.Error != ErrorCode.NoError || o.OrderState == OrderState.Rejected) { failed = true; pendingTo = p.Pending; }
                        else if (Math.Abs(o.StopPrice - p.Pending) < 1e-9 && IsWorking(o.OrderState) && o.OrderState != OrderState.ChangePending && o.OrderState != OrderState.ChangeSubmitted)
                        {
                            p.Pending = 0;
                            NoteFlags(m, p);
                            changed = true;
                        }
                        else if (IsDone(o.OrderState)) p.Pending = 0;   // filled or cancelled meanwhile: nothing to move
                    }
                    if (p.Stop == o || p.Target == o) changed = true;
                }
                if (o == m.Entry) changed = true;
            }
            if (failed) { MoveFailed(o, pendingTo, "NinjaTrader: " + (e.Error != ErrorCode.NoError ? e.Error.ToString() : "rejected")); return; }
            // An entry cancelled or rejected with no fill is done at once; the rest waits for the 2 s check (CheckDone).
            if (o == m.Entry && o.Filled == 0 && IsDone(o.OrderState)) { CheckDone(m); SaveManagedSoon(true); return; }
            if (changed) ManagedChanged(m, false);
        }

        // StratLock held: the flags the page shows, from where the stop is now.
        private static void NoteFlags(MEntry m, MPair p)
        {
            StratParams s = m.S;
            if (s == null || p.Stop == null) return;
            double tick = m.Instrument.MasterInstrument.TickSize, stop = p.Stop.StopPrice;
            if (s.BeAfter > 0)
            {
                double be = Snap(m.Buy ? p.Fill + s.BePlus * tick : p.Fill - s.BePlus * tick, tick, m.Buy);
                if (!Tighter(m.Buy, be, stop)) p.Be = true;
            }
            if (s.TrailAfter > 0 && Math.Round((m.Buy ? p.Best - p.Fill : p.Fill - p.Best) / tick, 6) >= s.TrailAfter) p.Trailing = true;
        }

        // ---------------------------------------------------------- the managed message
        private static string ManagedJson(MEntry m)
        {
            string state, text, name, json, side;
            bool buy;
            List<object[]> rows = new List<object[]>();   // { k, qty, fill, stop order, target order, be, trailing }
            double best = double.NaN;
            Order entry;
            lock (StratLock)
            {
                state = m.State; text = m.Text; buy = m.Buy; entry = m.Entry;
                name = m.S != null ? m.S.Name : null; json = m.S != null ? m.S.Json : null;
                foreach (MPair p in m.Pairs)
                {
                    rows.Add(new object[] { p.K, p.Qty, p.Fill, p.Stop, p.Target, p.Be, p.Trailing });
                    if (double.IsNaN(best) || (buy ? p.Best > best : p.Best < best)) best = p.Best;
                }
            }
            side = buy ? "buy" : "sell";
            StringBuilder b = new StringBuilder("{\"type\":\"managed\",\"id\":").Append(entry != null ? CbJson.Str(IdFor(entry)) : "null")
                .Append(",\"account\":").Append(CbJson.Str(m.Account != null ? m.Account.Name : ""))
                .Append(",\"root\":").Append(CbJson.Str(m.Root ?? ""))
                .Append(",\"side\":").Append(CbJson.Str(side))
                .Append(",\"name\":").Append(CbJson.Str(name))
                .Append(",\"strategy\":").Append(json ?? "null")
                .Append(",\"state\":").Append(CbJson.Str(state))
                .Append(",\"pairs\":[");
            bool first = true;
            foreach (object[] r in rows)
            {
                Order stop = (Order)r[3], target = (Order)r[4];
                bool stopOn = stop != null && IsWorking(stop.OrderState), targetOn = target != null && IsWorking(target.OrderState);
                if (!stopOn && !targetOn) continue;   // a pair that is done is not listed
                int qty = stopOn ? stop.Quantity - stop.Filled : target.Quantity - target.Filled;
                if (!first) b.Append(',');
                first = false;
                b.Append("{\"bucket\":").Append((int)r[0]).Append(",\"qty\":").Append(qty).Append(",\"fill\":").Append(CbJson.Num((double)r[2]))
                 .Append(",\"stopId\":").Append(stopOn ? CbJson.Str(IdFor(stop)) : "null").Append(",\"stop\":").Append(stopOn ? CbJson.Num(stop.StopPrice) : "null")
                 .Append(",\"targetId\":").Append(targetOn ? CbJson.Str(IdFor(target)) : "null").Append(",\"target\":").Append(targetOn ? CbJson.Num(target.LimitPrice) : "null")
                 .Append(",\"be\":").Append((bool)r[5] ? "true" : "false").Append(",\"trailing\":").Append((bool)r[6] ? "true" : "false").Append('}');
            }
            b.Append("],\"best\":").Append(double.IsNaN(best) ? "null" : CbJson.Num(best)).Append(",\"text\":").Append(CbJson.Str(text)).Append('}');
            return b.ToString();
        }

        // Tell the v3 pages (as v2 tells the pages of a tradable account), and save managed.txt when asked.
        private static void ManagedChanged(MEntry m, bool save)
        {
            if (save) SaveManagedSoon(true);
            bool quiet;
            lock (StratLock) quiet = m.Quiet;
            if (quiet) return;
            if (Enabled && m.Account != null && ChartBridgeAccounts.Seen(m.Account.Name)) ChartBridgeV3.SendToV3Traders(ManagedJson(m));   // integration: the shared v3 send; a v3 page sees every watched account
        }

        // After auth: every live managed entry, to a signed-in v3 page.
        private static void SendManagedTo(ChartBridgeClient client)
        {
            if (!client.Trader || !ChartBridgeV3.IsV3(client)) return;   // integration: the one v3 handshake
            List<MEntry> all;
            lock (StratLock) all = ManagedByTag.Values.ToList();
            foreach (MEntry m in all) if (!m.Quiet && m.Account != null && ChartBridgeAccounts.Seen(m.Account.Name)) client.Send(ManagedJson(m));
        }

        // ---------------------------------------------------------- the restart: recover by names and managed.txt
        // Recover (ChartBridgeOrders.cs) hands a strategy entry here. Like Recover, from the order names: the covered contracts
        // and their prices, the working pairs (one per fill mark and bucket). The strategy from managed.txt (RecoverManaged).
        private static Bracket RecoverStrategy(Order entry, out List<Pair> pairs, out bool deferred)
        {
            pairs = new List<Pair>();
            deferred = false;
            string tag = TagOf(entry.Name);
            if (tag == null || entry.Account == null) return null;
            if (!PlansLoaded()) { deferred = true; return null; }   // managed.txt is read with planned_brackets.txt, at start
            Bracket br = new Bracket { Account = entry.Account, Instrument = entry.Instrument, Tag = tag, EntryIsBuy = IsBuy(entry) };
            List<RLeg> legs = LegsOf(entry.Account, tag);
            Dictionary<string, Pair> byKey = new Dictionary<string, Pair>();
            int named = 0;
            foreach (RLeg l in legs)
            {
                string key = l.F + "|" + l.K;
                Pair pair;
                if (!byKey.TryGetValue(key, out pair))
                {
                    byKey[key] = pair = new Pair { Bracket = br, Qty = l.Q };
                    br.Covered = Math.Max(br.Covered, l.F);
                    br.CoveredValue += l.Q * l.P;
                    named += l.Q;
                }
                if (l.Role == "stop") pair.Stop = l.Order; else if (l.Role == "target") pair.Target = l.Order;
            }
            if (br.Covered > named)
            {
                double real = FillValue(FillsOf(entry), 0, br.Covered);   // as v2: from NinjaTrader's executions, never an estimate
                if (!double.IsNaN(real)) br.CoveredValue = real;
                else { br.CoveredValue += (br.Covered - named) * entry.AverageFillPrice; br.ValueEstimated = true; }
            }
            foreach (Pair p in byKey.Values)
                if ((p.Stop != null && !IsDone(p.Stop.OrderState)) || (p.Target != null && !IsDone(p.Target.OrderState))) pairs.Add(p);
            MEntry m = RecoverManaged(tag, entry, entry.Account, entry.Instrument, IsBuy(entry), legs);
            br.StopTicks = m.S != null ? m.S.Stop : 1;   // never "no plan": the fill path always comes to PlaceStrategyLegs
            ChartBridgeServer.Log("strategy entry recovered from the order names " + entry.Name + " (" + br.Covered + " contracts already handled, " + pairs.Count + " working pair(s))");
            return br;
        }

        private class RLeg { public Order Order; public string Role; public int F, Q, K; public double P; }

        // A tag's legs on the account (listed, and just sent), from their names.
        private static List<RLeg> LegsOf(Account a, string tag)
        {
            List<Order> orders;
            lock (a.Orders) orders = a.Orders.ToList();
            lock (Sync) foreach (Order o in Ours) if (o.Account == a && !orders.Contains(o)) orders.Add(o);
            List<RLeg> legs = new List<RLeg>();
            foreach (Order o in orders)
            {
                Match lm = LegNameRx.Match(o.Name ?? "");
                if (!lm.Success || lm.Groups[1].Value != tag) continue;
                legs.Add(new RLeg { Order = o, Role = lm.Groups[2].Value, F = int.Parse(lm.Groups[3].Value, CultureInfo.InvariantCulture),
                                    Q = int.Parse(lm.Groups[4].Value, CultureInfo.InvariantCulture), P = double.Parse(lm.Groups[5].Value, CultureInfo.InvariantCulture),
                                    K = lm.Groups[6].Success ? int.Parse(lm.Groups[6].Value, CultureInfo.InvariantCulture) : 0 });
            }
            return legs;
        }

        // Once per tag: the record, from managed.txt and the legs. Resumed when the line is read and the legs match it (the
        // best price is the larger of the saved one and the trades since the start); else unmanaged: every stop stays where
        // it is, is never moved again, and the pages are told (managed state unmanaged and a status error).
        private static MEntry RecoverManaged(string tag, Order entry, Account account, Instrument inst, bool buy, List<RLeg> legs)
        {
            lock (StratLock)
            {
                MEntry had;
                if (ManagedByTag.TryGetValue(tag, out had)) { if (had.Entry == null && entry != null) had.Entry = entry; return had; }
            }
            ManagedLine line;
            bool readFailed, have;
            lock (StratLock) { readFailed = managedReadFailed; have = ManagedLines.TryGetValue(tag, out line); }
            StratParams s = null;
            string why = null;
            if (readFailed) why = "managed.txt could not be read";
            else if (!have) why = "managed.txt has no line for it";
            else
            {
                string bad = line.Json.Length >= 2 ? ParseStrategy(line.Json.Substring(1, line.Json.Length - 2), out s) : "empty";
                if (bad != null) { s = null; why = "its line in managed.txt could not be read (" + bad + ")"; }
            }
            bool merged = why == null && line != null && line.Merged;   // fix1 (F4): a Merge ran on it: never resumed
            if (merged) why = MergedRestartText;
            double tick = inst.MasterInstrument.TickSize;
            if (why == null) why = LegsMismatch(s, buy, legs, tick);
            if (why == null && !StrategiesOn) why = "Order Strategies are off in config.txt (strategies)";
            if (why == null && !Enabled) why = "trading is off in config.txt";
            MEntry m = new MEntry { Tag = tag, Entry = entry, Account = account, Instrument = inst, Buy = buy, Root = ChartBridgeServer.RootFor(inst), S = s, NoMoves = why != null, Merged = merged,
                                    NameStop = entry != null ? NamedStopTicks(entry.Name) : 0 };   // fix1 (F5): the stop ticks from the name
            double[] hl;
            lock (StratLock) { if (m.Root == null || !SinceStart.TryGetValue(m.Root, out hl)) hl = null; }
            foreach (RLeg l in legs)
            {
                if (l.Role == "exit" || l.Order == null || !IsWorking(l.Order.OrderState)) continue;
                MPair p = m.Pairs.FirstOrDefault(x => x.F == l.F && x.K == l.K);
                if (p == null)
                {
                    double saved;
                    if (line == null || !line.Best.TryGetValue("f" + l.F + "k" + l.K, out saved)) saved = l.P;
                    if (hl != null) saved = buy ? Math.Max(saved, hl[0]) : Math.Min(saved, hl[1]);
                    m.Pairs.Add(p = new MPair { K = l.K, F = l.F, Qty = l.Q, Fill = l.P, Best = saved });
                }
                if (l.Role == "stop") p.Stop = l.Order; else p.Target = l.Order;
            }
            foreach (MPair p in m.Pairs) NoteFlags(m, p);
            // Kept even with nothing working: a fill from while ChartBridge was stopped still comes to PlaceStrategyLegs; the
            // 2 second check says done once every fill is handled and no leg works.
            bool open = m.Pairs.Count > 0, waiting = entry != null && IsWorking(entry.OrderState) && entry.Filled == 0;
            m.Quiet = !open && !(entry != null && IsWorking(entry.OrderState));   // a finished entry the names still list: no message unless it fills more
            if (why != null) m.State = "unmanaged";
            else m.State = waiting ? "waiting" : "resumed";
            m.Text = why == null ? (m.State == "resumed" ? "ChartBridge restarted; breakeven and trailing resumed" : null) : why;
            lock (StratLock)
            {
                MEntry had;
                if (ManagedByTag.TryGetValue(tag, out had)) { if (had.Entry == null && entry != null) had.Entry = entry; return had; }   // another thread got there first
                ManagedByTag[tag] = m; managedCount = ManagedByTag.Count;
            }
            string where = Where(account, inst);
            if (!open && !waiting && (entry == null || !IsWorking(entry.OrderState)))
                ChartBridgeServer.Log("strategy entry CB#" + tag + " on " + where + " recovered with no working leg" + (why != null ? " (" + why + ")" : ""));
            else if (why == null) ChartBridgeServer.Log("strategy entry CB#" + tag + " on " + where + ": " + (m.State == "resumed" ? "breakeven and trailing resumed after the restart (" + m.Pairs.Count + " pair(s))" : "waiting for its fill, recovered after the restart"));
            else if (merged) ChartBridgeServer.Log("strategy entry CB#" + tag + " on " + where + ": " + MergedRestartText);   // fix1 (F4): expected, not an alarm
            else if (open)
            {
                List<string> stops = m.Pairs.Where(p => p.Stop != null).Select(p => Price(p.Stop.StopPrice)).Distinct().ToList();
                Alarm(where + ": breakeven and trailing could not be resumed after the restart (" + why + "); " +
                      (stops.Count == 0 ? "there is NO working stop" : stops.Count == 1 ? "the stop stays at " + stops[0] : "the stops stay at " + string.Join(", ", stops)) + ". Manage it by hand");
            }
            else if (s == null && m.NameStop > 0)
                Alarm(where + ": Order Strategy entry CB#" + tag + " could not be resumed after the restart (" + why + "); if it fills, ChartBridge places its stop from the order's name (" +
                      m.NameStop + " ticks from the fill) with NO TARGET and no breakeven or trailing: cancel it and place it again to keep the strategy");   // fix1 (F5)
            else if (s == null)
                Alarm(where + ": Order Strategy entry CB#" + tag + " could not be resumed after the restart (" + why + "); if it fills it gets NO STOP: cancel it and place it again");
            else
                Alarm(where + ": Order Strategy entry CB#" + tag + ": breakeven and trailing could not be resumed after the restart (" + why + "); its fills still get their stop and targets; manage the stop by hand");
            ManagedChanged(m, false);
            return m;
        }

        // The legs must be the strategy's: the closing side, a bucket the strategy has, a target only with targets and at the
        // strategy's distance from its fill, the stop type the strategy says, a working stop on every working pair. Null or why.
        private static string LegsMismatch(StratParams s, bool buy, List<RLeg> legs, double tick)
        {
            int buckets = Math.Max(1, s.T.Length);
            HashSet<string> stops = new HashSet<string>(), targets = new HashSet<string>();
            foreach (RLeg l in legs)
            {
                if (l.Order == null || !IsWorking(l.Order.OrderState) || l.Role == "exit") continue;
                if (IsBuy(l.Order) == buy) return "a leg is on the entry's side";
                if (l.K < 1 || l.K > buckets) return "leg bucket k" + l.K + " is not in the strategy";
                string key = l.F + "|" + l.K;
                if (l.Role == "stop")
                {
                    stops.Add(key);
                    if ((s.StopLimit >= 0) != (l.Order.OrderType == OrderType.StopLimit)) return "the stop of bucket " + l.K + " is not the strategy's stop type";
                }
                else
                {
                    targets.Add(key);
                    if (s.T.Length == 0) return "a target leg, and the strategy has no target";
                    double want = Round(buy ? l.P + s.T[l.K - 1] * tick : l.P - s.T[l.K - 1] * tick, tick);
                    if (Math.Abs(l.Order.LimitPrice - want) > 1e-9) return "the target of bucket " + l.K + " is at " + Price(l.Order.LimitPrice) + " and the strategy puts it at " + Price(want);
                }
            }
            foreach (string t in targets) if (!stops.Contains(t)) return "a pair has a working target and no working stop";
            return null;
        }

        // ---------------------------------------------------------- every 2 seconds (CheckLegs, off NinjaTrader's thread)
        // Strategy legs whose entry is not listed (NinjaTrader restarted) are recovered from their names; a working strategy
        // entry not yet known too; a move not confirmed in MoveConfirmMs is let go; a record that is done says so and its line
        // goes; managed.txt is saved when it has changed.
        private static void KeepStrategies(double now)
        {
            if (!PlansLoaded()) return;
            List<Account> accounts = new List<Account>();
            lock (Account.All) foreach (Account a in Account.All) if (!IsNeverTradable(a.Name ?? "")) accounts.Add(a);
            foreach (Account a in accounts)
            {
                if (StatusOf(a) != "Connected") continue;
                List<Order> orders;
                lock (a.Orders) orders = a.Orders.ToList();
                foreach (Order o in orders)
                {
                    string name = o.Name ?? "";
                    bool entry = IsStrategyName(name), leg = !entry && IsStrategyLeg(name);
                    if ((!entry && !leg) || !IsWorking(o.OrderState)) continue;
                    string tag = TagOf(name);
                    if (ManagedOf(tag) != null) continue;
                    try
                    {
                        if (entry) { BracketFor(o); continue; }
                        Order known = orders.FirstOrDefault(x => IsStrategyName(x.Name) && TagOf(x.Name) == tag);
                        if (known != null) { BracketFor(known); continue; }
                        RecoverLegsOnly(a, o.Instrument, tag, !IsBuy(o));
                    }
                    catch (Exception ex) { Alarm(Where(a, o.Instrument) + ": strategy recovery error (" + ex.Message + "); check the stop in NinjaTrader"); }
                }
            }
            List<MEntry> all;
            List<Order> unconfirmed = new List<Order>();
            double sNow = SNow();
            lock (StratLock)
            {
                all = ManagedByTag.Values.ToList();
                foreach (MEntry m in all)
                    foreach (MPair p in m.Pairs)
                        if (p.Pending != 0 && sNow - p.PendingAt > MoveConfirmMs) { p.Pending = 0; NoteFlags(m, p); if (p.Stop != null) unconfirmed.Add(p.Stop); }
            }
            foreach (Order o in unconfirmed) ChartBridgeServer.Log("strategy stop move not confirmed in " + (MoveConfirmMs / 1000) + " s: " + o.Name + " is at " + CbJson.Num(o.StopPrice));
            foreach (MEntry m in all) CheckDone(m);
            lock (StratLock) foreach (string k in RecentlyDone.Where(kv => ChartBridgeTime.NowUtcMs() - kv.Value.Key > RecentlyDoneMs).Select(kv => kv.Key).ToList()) RecentlyDone.Remove(k);   // fix1
            bool dirty;
            lock (StratLock) dirty = saveDirty || saveFailed != null;
            if (dirty) WriteManagedLogged();
        }

        // The legs of a strategy whose entry NinjaTrader no longer lists: the record from the names, the pairs re-linked so a
        // partner still follows.
        private static void RecoverLegsOnly(Account a, Instrument inst, string tag, bool buy)
        {
            List<RLeg> legs = LegsOf(a, tag);
            Dictionary<string, Pair> byKey = new Dictionary<string, Pair>();
            foreach (RLeg l in legs)
            {
                if (l.Role == "exit" || !IsWorking(l.Order.OrderState)) continue;
                Pair pair;
                string key = l.F + "|" + l.K;
                if (!byKey.TryGetValue(key, out pair)) byKey[key] = pair = new Pair { Qty = l.Q };
                if (l.Role == "stop") pair.Stop = l.Order; else pair.Target = l.Order;
            }
            lock (Sync)
                foreach (Pair p in byKey.Values)
                {
                    if (p.Stop != null && !PairOfLeg.ContainsKey(p.Stop)) { IdFor(p.Stop); PairOfLeg[p.Stop] = p; }
                    if (p.Target != null && !PairOfLeg.ContainsKey(p.Target)) { IdFor(p.Target); PairOfLeg[p.Target] = p; }
                }
            RecoverManaged(tag, null, a, inst, buy, legs);
        }

        // Fix1: CheckDone (the 2 s check) and PlaceStrategyLegs (a fill, NinjaTrader's thread) can cross: the entry's last fill is
        // counted as covered just before its legs are placed, and the check can call the record done in between. A record called
        // done in the last minute is kept here, and a fill that finds it gone or done brings it back (state from before, the page
        // told again, its line written again), so its legs and management are never silently dropped.
        private static readonly Dictionary<string, KeyValuePair<double, MEntry>> RecentlyDone = new Dictionary<string, KeyValuePair<double, MEntry>>();
        public const double RecentlyDoneMs = 60000;

        private static MEntry ReviveDone(string tag, string where)
        {
            MEntry m = null;
            lock (StratLock)
            {
                KeyValuePair<double, MEntry> kv;
                if (tag != null && RecentlyDone.TryGetValue(tag, out kv)) { m = kv.Value; ReviveLocked(m); }
            }
            if (m != null) ChartBridgeServer.Log("strategy entry CB#" + tag + " on " + where + ": a fill came as its record was called done; the record is back");
            return m;
        }

        // StratLock held. True when the record had been called done (it is back in ManagedByTag, not announced).
        private static bool ReviveLocked(MEntry m)
        {
            RecentlyDone.Remove(m.Tag);
            if (!m.Announced && ManagedByTag.ContainsKey(m.Tag)) return false;
            m.Announced = false;
            if (m.State == "done") m.State = m.NoMoves ? "unmanaged" : "active";
            ManagedByTag[m.Tag] = m;
            managedCount = ManagedByTag.Count;
            saveDirty = true;
            return true;
        }

        // Done: the entry is done (or not listed) with every fill handled, and no leg works. The page is told once; the line goes.
        private static void CheckDone(MEntry m)
        {
            Order entry;
            bool anyWorking;
            lock (StratLock)
            {
                entry = m.Entry;
                anyWorking = m.Pairs.Any(p => (p.Stop != null && IsWorking(p.Stop.OrderState)) || (p.Target != null && IsWorking(p.Target.OrderState)));
            }
            if (anyWorking) return;
            if (entry != null)
            {
                if (IsWorking(entry.OrderState)) return;
                Bracket br;
                bool uncovered;
                lock (Sync) uncovered = BracketOfEntry.TryGetValue(entry, out br) && br.Covered < entry.Filled;
                if (uncovered) return;   // fills still to get legs
            }
            bool quiet;
            lock (StratLock)
            {
                if (m.Announced) return;
                m.Announced = true;
                quiet = m.Quiet;
                m.State = "done";
                ManagedByTag.Remove(m.Tag);
                ManagedLines.Remove(m.Tag);
                RecentlyDone[m.Tag] = new KeyValuePair<double, MEntry>(ChartBridgeTime.NowUtcMs(), m);   // fix1: a fill racing this check revives it
                managedCount = ManagedByTag.Count;
                saveDirty = true;
            }
            if (!quiet && Enabled && m.Account != null && ChartBridgeAccounts.Seen(m.Account.Name)) ChartBridgeV3.SendToV3Traders(ManagedJson(m));   // integration: the shared v3 send
        }

        // ---------------------------------------------------------- managed.txt
        // One line per managed entry: "<tag>\t<strategy as the flat JSON object sent>\t<best price per pair>\t<saved UTC ms>",
        // the best prices as "f2k1:24995.25,f2k2:24995.25" ("-" for none). Written whole through a temp file, off NinjaTrader's
        // thread (at placement, at each fill, at most once a second as the best price moves, and every 2 s while it has
        // changed or a write failed). Read once at start with planned_brackets.txt (LoadPlans, a pool thread). A file that
        // exists but cannot be read is never rewritten that run. Lines older than 7 days are dropped when read.
        private class ManagedLine { public string Json; public Dictionary<string, double> Best = new Dictionary<string, double>(); public double At; public bool Merged; }
        // Fix1 (F4): a fifth field "merged" marks an entry a Merge swap ran on (a line without it is read as before).
        private const string MergedRestartText = "merged before the restart: breakeven and trailing stay off for this position, every stop stays where it is (manage it by hand)";
        private static readonly Dictionary<string, ManagedLine> ManagedLines = new Dictionary<string, ManagedLine>();   // lines read and not yet recovered
        private static bool managedReadFailed, saveDirty;
        private static string saveFailed;
        private static double lastSaveMs;
        private static int saveQueued;
        private static readonly object ManagedFileLock = new object();
        public static Func<string> ManagedReadFault, ManagedWriteFault;   // test hooks (unused in NinjaTrader)
        private static readonly Regex ManagedLineRx = new Regex("^([0-9a-f]{8})\t(\\{[^\t]*\\})\t([^\t]*)\t([0-9]{1,15})(\tmerged)?$");   // fix1 (F4): optional "merged"

        private static string ManagedFile { get { return Path.Combine(ChartBridgeConfig.Folder, "managed.txt"); } }

        private static void ClearStrategies()
        {
            lock (StratLock) { ManagedByTag.Clear(); ManagedLines.Clear(); SinceStart.Clear(); RecentlyDone.Clear(); managedCount = 0; managedReadFailed = false; saveDirty = false; saveFailed = null; lastSaveMs = 0; }
        }

        // LoadPlans (a pool thread, at start, before plansLoaded is set): read the lines into memory.
        private static void LoadManaged(int gen)
        {
            Dictionary<string, ManagedLine> read = new Dictionary<string, ManagedLine>();
            string failed = null;
            int bad = 0;
            double now = ChartBridgeTime.NowUtcMs();
            for (int attempt = 1; attempt <= PlanReadTries; attempt++)
            {
                read.Clear(); bad = 0; failed = null;
                try
                {
                    string fault = ManagedReadFault != null ? ManagedReadFault() : null;
                    if (fault != null) throw new IOException(fault);
                    lock (ManagedFileLock)
                        if (File.Exists(ManagedFile))
                            foreach (string raw in File.ReadAllLines(ManagedFile))
                            {
                                string text = raw.TrimEnd('\r', '\n');
                                if (text.Trim().Length == 0) continue;
                                Match m = ManagedLineRx.Match(text);
                                if (!m.Success) { bad++; continue; }
                                double at = double.Parse(m.Groups[4].Value, CultureInfo.InvariantCulture);
                                if (now - at > PlanKeepMs) continue;
                                ManagedLine line = new ManagedLine { Json = m.Groups[2].Value, At = at, Merged = m.Groups[5].Success };
                                if (m.Groups[3].Value != "-")
                                    foreach (string part in m.Groups[3].Value.Split(','))
                                    {
                                        string[] kv = part.Split(':');
                                        double px;
                                        if (kv.Length == 2 && Regex.IsMatch(kv[0], "^f[0-9]{1,6}k[1-3]$") && double.TryParse(kv[1], NumberStyles.Float, CultureInfo.InvariantCulture, out px)) line.Best[kv[0]] = px;
                                    }
                                read[m.Groups[1].Value] = line;
                            }
                    break;
                }
                catch (Exception ex) { failed = ex.Message; }
                if (attempt < PlanReadTries) Thread.Sleep(PlanReadRetryMs);
            }
            int cur;
            lock (PlanMemLock) cur = planGeneration;
            if (cur != gen) return;   // a load from before a Clear() never lands in the next run
            lock (StratLock)
            {
                managedReadFailed = failed != null;
                foreach (KeyValuePair<string, ManagedLine> kv in read) if (!ManagedLines.ContainsKey(kv.Key)) ManagedLines[kv.Key] = kv.Value;
            }
            if (failed != null)
                Alarm("managed.txt could not be read (" + failed + "); Order Strategy positions from before this start keep their stops where they are (no breakeven or trailing); manage them by hand. " +
                      "Order Strategies are off for this run: new strategy entries are refused; fix the file and restart");   // fix1 (F5)
            if (bad > 0) ChartBridgeServer.Log("skipped " + bad + " unreadable line(s) in managed.txt");
        }

        // Ask for a save: now (placement, a fill), or as the best price moves (at most once a second; the 2 s check does
        // the rest). Always off NinjaTrader's thread.
        private static void SaveManagedSoon(bool now)
        {
            bool go;
            lock (StratLock) { saveDirty = true; go = now || ChartBridgeTime.NowUtcMs() - lastSaveMs >= 1000; }
            if (!go) return;
            if (StrategyInline) { WriteManagedLogged(); return; }
            if (Interlocked.CompareExchange(ref saveQueued, 1, 0) != 0) return;   // one queued write takes the latest state
            ThreadPool.QueueUserWorkItem(delegate
            {
                try { Interlocked.Exchange(ref saveQueued, 0); WriteManagedLogged(); }
                catch (Exception ex) { ChartBridgeServer.Log("managed.txt error: " + ex.Message); }
            });
        }

        // The harness: write managed.txt now, on the calling thread.
        public static void SaveManagedNow() { WriteManagedLogged(); }

        private static void WriteManagedLogged()
        {
            string was, err = WriteManaged();
            lock (StratLock) { was = saveFailed; saveFailed = err; }
            if (err != null && was == null)
                Alarm("managed.txt could not be saved (" + err + "); breakeven and trailing may not survive a restart; ChartBridge tries again every 2 seconds and says so when it is saved");
            else if (err == null && was != null) Warn("managed.txt is saved again (it failed before: " + was + ")");
        }

        // Writes the records (and lines read but not yet recovered) as they are now, tried a few times. Null, or why not.
        private static string WriteManaged()
        {
            string err = null;
            for (int attempt = 1; attempt <= PlanWriteTries; attempt++)
            {
                err = WriteManagedOnce();
                if (err == null || err == ManagedNotRead) break;
                if (attempt < PlanWriteTries) Thread.Sleep(PlanWriteRetryMs * attempt);
            }
            return err == ManagedNotRead ? null : err;
        }

        private const string ManagedNotRead = "managed.txt not read yet";

        private static string WriteManagedOnce()
        {
            lock (ManagedFileLock)
            {
                List<string> lines = new List<string>();
                if (!PlansLoaded()) return ManagedNotRead;   // never overwrite the file before it has been read
                lock (StratLock)
                {
                    if (managedReadFailed) { saveDirty = false; return ManagedNotRead; }   // could not be read at start: never rewritten this run (said at start)
                    double now = ChartBridgeTime.NowUtcMs();
                    foreach (MEntry m in ManagedByTag.Values)
                    {
                        if (m.S == null) continue;
                        string best = string.Join(",", m.Pairs.Select(p => "f" + p.F + "k" + p.K + ":" + p.Best.ToString("R", CultureInfo.InvariantCulture)));
                        lines.Add(m.Tag + "\t" + m.S.Json + "\t" + (best.Length > 0 ? best : "-") + "\t" + ((long)now).ToString(CultureInfo.InvariantCulture) + (m.Merged ? "\tmerged" : ""));
                    }
                    foreach (KeyValuePair<string, ManagedLine> kv in ManagedLines)
                        if (!ManagedByTag.ContainsKey(kv.Key))
                        {
                            string best = string.Join(",", kv.Value.Best.Select(b => b.Key + ":" + b.Value.ToString("R", CultureInfo.InvariantCulture)));
                            lines.Add(kv.Key + "\t" + kv.Value.Json + "\t" + (best.Length > 0 ? best : "-") + "\t" + ((long)kv.Value.At).ToString(CultureInfo.InvariantCulture) + (kv.Value.Merged ? "\tmerged" : ""));
                        }
                    saveDirty = false;
                    lastSaveMs = now;
                }
                try
                {
                    string fault = ManagedWriteFault != null ? ManagedWriteFault() : null;
                    if (fault != null) throw new IOException(fault);
                    Directory.CreateDirectory(ChartBridgeConfig.Folder);
                    string tmp = ManagedFile + ".tmp";
                    File.WriteAllLines(tmp, lines.ToArray());
                    if (File.Exists(ManagedFile)) File.Replace(tmp, ManagedFile, null); else File.Move(tmp, ManagedFile);
                    return null;
                }
                catch (Exception ex) { lock (StratLock) saveDirty = true; return ex.Message; }
            }
        }
    }
}
