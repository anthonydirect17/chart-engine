// ChartBridge 0.4.0 on Mono (inside check:orders): the quote-only markets (every order action for them refused before any
// other order code, never reaching the stand-in account; the traded roots unchanged), each market's front month by its own
// roll for a few dates and from NinjaTrader's rollover list, the per-root settlement time, the hello fields, the tape
// counters (never throwing, and a fault in them never stopping a trade, its send or the order code's last price), the
// once-a-minute error lines and /diag "health". Made-up accounts and prices; nothing here is market data.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript.AddOns;

public static class MarketsHarness
{
    static Action<bool, string> Check;
    const BindingFlags PS = BindingFlags.NonPublic | BindingFlags.Static;
    static object Priv(string name, params object[] args) { return typeof(ChartBridgeServer).GetMethod(name, PS).Invoke(null, args); }
    static object Field(string name) { return typeof(ChartBridgeServer).GetField(name, PS).GetValue(null); }
    static Dictionary<string, Instrument> Named() { return (Dictionary<string, Instrument>)Field("Instruments"); }
    static ConcurrentDictionary<int, ChartBridgeClient> Clients() { return (ConcurrentDictionary<int, ChartBridgeClient>)Field("Clients"); }
    static bool Logged(string has) { lock (NinjaTrader.Code.Output.Lines) return NinjaTrader.Code.Output.Lines.Any(x => x.Contains(has)); }
    static int LoggedCount(string has) { lock (NinjaTrader.Code.Output.Lines) return NinjaTrader.Code.Output.Lines.Count(x => x.Contains(has)); }
    static Instrument Inst(string name, string root, double tick, double pv) { return new Instrument { FullName = name, MasterInstrument = new MasterInstrument { Name = root, TickSize = tick, PointValue = pv, TradingHours = new TradingHours { Name = "stand-in" } } }; }

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        Dictionary<string, Instrument> was = new Dictionary<string, Instrument>(Named());
        string[] quoteWas = ChartBridgeConfig.QuoteRoots, rootsWas = ChartBridgeConfig.Roots;
        try
        {
            FrontMonths();
            RolloverList();
            QuoteOnlyOrders();
            SettlementTimes();
            Tape();
            TapeNeverStopsATrade();
            LogLimit();
            SendThread();
            Health();
            ConfigKey();
        }
        catch (Exception ex) { Check(false, "markets harness threw: " + ex); }
        finally
        {
            ChartBridgeTape.ThrowForHarness = false;
            ChartBridgeConfig.QuoteRoots = quoteWas; ChartBridgeConfig.Roots = rootsWas;
            ChartBridgeOrders.ResetConfig();
            Named().Clear(); foreach (KeyValuePair<string, Instrument> kv in was) Named()[kv.Key] = kv.Value;
        }
    }

    // ------------------------------------------------------------ each market's own roll (the fallback table)
    static void FrontMonths()
    {
        Func<string, int, int, int, string> F = (root, y, m, d) => ChartBridgeMarkets.FrontMonth(root, new DateTime(y, m, d));
        // CL: monthly, the last trade three business days before the 25th of the month before (Oct 2026: the 25th is a Sunday,
        // so from Friday the 23rd: Oct 20 for the November contract), rolled 8 days before: Oct 12
        Check(F("CL", 2026, 10, 7) == "11-26" && F("CL", 2026, 10, 11) == "11-26" && F("CL", 2026, 10, 12) == "12-26", "CL rolls monthly, 8 days before its last trade (Nov 26 to Dec 26 on 2026-10-12): " + F("CL", 2026, 10, 11) + " " + F("CL", 2026, 10, 12));
        // the January 2027 contract: Dec 25 2026 is Christmas (a Friday), so from Thursday the 24th: Dec 21, rolled Dec 13
        Check(F("CL", 2026, 12, 12) == "01-27" && F("CL", 2026, 12, 13) == "02-27", "CL around Christmas: Jan 27 until 2026-12-13, then Feb 27: " + F("CL", 2026, 12, 12) + " " + F("CL", 2026, 12, 13));
        // GC: Feb, Apr, Jun, Aug, Oct, Dec, rolled 8 days before first notice (the last business day of the month before)
        Check(F("GC", 2026, 10, 7) == "12-26" && F("GC", 2026, 11, 21) == "12-26" && F("GC", 2026, 11, 22) == "02-27", "GC skips the inactive months and rolls before first notice (Dec 26 to Feb 27 on 2026-11-22): " + F("GC", 2026, 11, 22));
        Check(F("SI", 2026, 10, 7) == "12-26" && F("SI", 2027, 1, 5) == "03-27" && F("SI", 2027, 2, 18) == "05-27", "SI: Mar, May, Jul, Sep, Dec: " + F("SI", 2027, 1, 5) + " " + F("SI", 2027, 2, 18));
        Check(F("ZN", 2026, 11, 21) == "12-26" && F("ZN", 2026, 11, 22) == "03-27" && F("ZB", 2026, 11, 22) == "03-27", "ZN and ZB: quarterly, rolled before first notice (2026-11-22): " + F("ZN", 2026, 11, 22));
        // 6E: the last trade two business days before the third Wednesday (Dec 16 2026: Monday Dec 14), rolled Dec 6
        Check(F("6E", 2026, 12, 5) == "12-26" && F("6E", 2026, 12, 6) == "03-27", "6E: rolled 8 days before its last trade (2026-12-06): " + F("6E", 2026, 12, 6));
        // YM and RTY: the equity index rule, exactly as the traded roots
        Check(F("YM", 2026, 12, 9) == "12-26" && F("YM", 2026, 12, 10) == "03-27" && F("RTY", 2026, 12, 10) == ChartBridgeServer.FrontMonth(new DateTime(2026, 12, 10)), "YM and RTY roll as ES (2026-12-10)");
        bool same = true;
        for (DateTime d = new DateTime(2026, 1, 1); d < new DateTime(2028, 1, 1); d = d.AddDays(1))
            foreach (string r in new[] { "MNQ", "NQ", "MES", "ES" }) if (ChartBridgeMarkets.FrontMonth(r, d) != ChartBridgeServer.FrontMonth(d)) same = false;
        Check(same, "MNQ, NQ, MES, ES: every day of 2026 and 2027 gives the same contract as before 0.4.0 (the order path's contract is unchanged)");
        Check(ChartBridgeMarkets.FormatOf("ZN") == "32nds" && ChartBridgeMarkets.FormatOf("ZB") == "32nds" && ChartBridgeMarkets.FormatOf("CL") == "decimal" && ChartBridgeMarkets.FormatOf("MNQ") == "decimal", "price format: ZN and ZB in 32nds, the rest decimal");
    }

    // ------------------------------------------------------------ NinjaTrader's own rollover list first, when it covers today
    static void RolloverList()
    {
        DateTime now = new DateTime(2026, 10, 10);
        MasterInstrument m = new MasterInstrument { Name = "CL", TickSize = 0.01, RolloverCollection = new List<Rollover> {
            new Rollover { ContractMonth = new DateTime(2026, 11, 1), Date = new DateTime(2026, 9, 14) },
            new Rollover { ContractMonth = new DateTime(2026, 12, 1), Date = new DateTime(2026, 10, 9) },
            new Rollover { ContractMonth = new DateTime(2027, 1, 1), Date = new DateTime(2026, 11, 12) } } };
        Check(ChartBridgeMarkets.NtFrontMonth(m, now) == "12-26", "NinjaTrader's rollover list: the latest rollover on or before today (Dec 26 from 2026-10-09)");
        MasterInstrument old = new MasterInstrument { Name = "CL", RolloverCollection = new List<Rollover> { new Rollover { ContractMonth = new DateTime(2026, 8, 1), Date = new DateTime(2026, 7, 14) } } };
        Check(ChartBridgeMarkets.NtFrontMonth(old, now) == null, "a rollover list that ends before today is not used (out of date)");
        Check(ChartBridgeMarkets.NtFrontMonth(new MasterInstrument { Name = "CL" }, now) == null && ChartBridgeMarkets.NtFrontMonth(new object(), now) == null && ChartBridgeMarkets.NtFrontMonth(null, now) == null,
              "no rollover list (or a NinjaTrader without one): null, the table's rule is used");
        Dictionary<string, Instrument> made = new Dictionary<string, Instrument>();
        Func<string, Instrument> get = name => { Instrument i; if (!made.TryGetValue(name, out i)) { i = new Instrument { FullName = name, MasterInstrument = m }; made[name] = i; } return i; };
        string nm, how;
        Instrument cl = ChartBridgeMarkets.Resolve("CL", now, get, out nm, out how);
        Check(cl != null && cl.FullName == "CL 12-26" && how.Contains("NinjaTrader's rollover list (12-26; the roll rule says 11-26)"), "CL resolved from NinjaTrader's list over the table's rule: " + nm + " (" + how + ")");
        ChartBridgeConfig.ContractOverride["CL"] = "CL 03-27";
        try
        {
            cl = ChartBridgeMarkets.Resolve("CL", now, get, out nm, out how);
            Check(cl != null && cl.FullName == "CL 03-27" && how == "contract.CL in config.txt", "contract.CL in config.txt still wins over both");
        }
        finally { ChartBridgeConfig.ContractOverride.Remove("CL"); }
        Instrument none = ChartBridgeMarkets.Resolve("GC", now, n => null, out nm, out how);
        Check(none == null && nm == "GC 12-26", "an instrument NinjaTrader does not have: null (said in the Output window at start)");
        // through the server: the traded roots first, then the quote-only ones; a root in both is quote only
        Named().Clear();
        ChartBridgeConfig.QuoteRoots = new[] { "CL", "ZN", "MNQ" };
        ChartBridgeServer.ResolveQuoteRoots(now, get);
        Check(Named().ContainsKey("CL") && Named()["CL"].FullName == "CL 12-26" && Named().ContainsKey("ZN") && Logged("CL -> CL 12-26 (quote only, orders refused;"), "ResolveQuoteRoots: each quote-only root served, said in the Output window");
        Check(ChartBridgeConfig.QuoteOnly("MNQ") && ChartBridgeConfig.QuoteOnly("cl") && !ChartBridgeConfig.QuoteOnly("NQ") && !ChartBridgeConfig.QuoteOnly(null), "QuoteOnly: by root, any case; a root in quoteRoots is quote only even if it is in roots");
        ChartBridgeConfig.QuoteRoots = ChartBridgeMarkets.DefaultQuoteRoots();
    }

    // ------------------------------------------------------------ every order action for a quote-only root is refused
    static void QuoteOnlyOrders()
    {
        List<string> sent = new List<string>();
        Instrument mnq = Inst("MNQ 12-26", "MNQ", 0.25, 2), cl = Inst("CL 11-26", "CL", 0.01, 1000), zn = Inst("ZN 12-26", "ZN", 0.015625, 1000);
        Named().Clear(); Named()["MNQ"] = mnq; Named()["CL"] = cl; Named()["ZN"] = zn;
        ChartBridgeConfig.QuoteRoots = ChartBridgeMarkets.DefaultQuoteRoots();
        Check(ChartBridgeServer.InstrumentFor("CL") == null && ChartBridgeServer.ServedInstrumentFor("CL") == cl && ChartBridgeServer.RootFor(cl) == null && ChartBridgeServer.RootFor(mnq) == "MNQ" && ChartBridgeServer.InstrumentFor("MNQ") == mnq,
              "the order code's lookups never return a quote-only root or contract; the data side's does");
        string hello = (string)Priv("HelloJson");
        Check(hello.Contains("{\"root\":\"CL\",\"name\":\"CL 11-26\",\"tick\":0.01,\"pointValue\":1000,\"quoteOnly\":true,\"priceFormat\":\"decimal\",\"settlement\":") &&
              hello.Contains("\"root\":\"ZN\",\"name\":\"ZN 12-26\",\"tick\":0.015625,\"pointValue\":1000,\"quoteOnly\":true,\"priceFormat\":\"32nds\"") &&
              hello.Contains("\"root\":\"MNQ\",\"name\":\"MNQ 12-26\",\"tick\":0.25,\"pointValue\":2,\"quoteOnly\":false,\"priceFormat\":\"decimal\",\"settlement\":"),
              "hello: every instrument says quoteOnly and priceFormat, before its settlement fields: " + hello.Substring(0, Math.Min(400, hello.Length)));

        Account acc = new Account { Name = "EVAL-Q", Connection = new Connection { Status = ConnectionStatus.Connected } };
        Account.All.Add(acc);
        ((Dictionary<Account, double>)typeof(ChartBridgeOrders).GetField("ConnectedSince", PS).GetValue(null))[acc] = 0;
        try
        {
            ChartBridgeOrders.ResetConfig();
            ChartBridgeOrders.ReadConfig("trading", "true");
            ChartBridgeOrders.ReadConfig("tradeAccounts", "EVAL-Q");
            ChartBridgeOrders.ReadConfig("maxQty.CL", "5");
            ChartBridgeOrders.NewToken();
            string token = ChartBridgeOrders.SessionJson().Split('"')[3];
            ChartBridgeClient c = new ChartBridgeClient(null, 9401);
            c.Tap = s => { lock (sent) sent.Add(s); };
            c.Origin = "http://localhost:8765";
            Action<string, string> msg = (type, json) => { lock (c.Actions) c.Actions.Clear(); ChartBridgeOrders.OnMessage(c, type, json); };
            Func<string, bool> rejected = has => { string m; lock (sent) m = sent.Count > 0 ? sent[sent.Count - 1] : ""; return m.Contains("\"type\":\"reject\"") && m.Contains(has); };
            msg("auth", "{\"type\":\"auth\",\"token\":\"" + token + "\"}");
            Check(c.Trader, "signed in for orders");
            ChartBridgeOrders.NoteLast("CL", 61.5); ChartBridgeOrders.NoteLast("ZN", 112.5); ChartBridgeOrders.NoteLast("MNQ", 25000);
            const string why = "is quote only: ChartBridge shows its prices on the Quote board and refuses every order for it";
            msg("order", "{\"type\":\"order\",\"cid\":\"q1\",\"account\":\"EVAL-Q\",\"root\":\"CL\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1}");
            Check(rejected("CL " + why) && rejected("\"cid\":\"q1\"") && acc.Calls.Count == 0, "a CL market order is refused, quote only, nothing reaches NinjaTrader");
            msg("order", "{\"type\":\"order\",\"cid\":\"q2\",\"account\":\"EVAL-Q\",\"root\":\"zn\",\"side\":\"sell\",\"kind\":\"limit\",\"qty\":1,\"price\":112.53125,\"bracket\":{\"stop\":8,\"target\":16}}");
            Check(rejected("ZN " + why) && acc.Calls.Count == 0, "a ZN limit with a bracket (root in lower case) is refused the same way");
            msg("flatten", "{\"type\":\"flatten\",\"account\":\"EVAL-Q\",\"root\":\"CL\"}");
            Check(rejected("CL " + why) && acc.Calls.Count == 0, "Flatten for CL from the chart is refused (it never reaches account.Flatten)");
            // an order on CL placed in NinjaTrader itself: change, plan and cancel by its id are refused too
            Order ntOrder = new Order { Account = acc, Instrument = cl, OrderAction = OrderAction.Buy, OrderType = OrderType.Limit, Quantity = 1, LimitPrice = 61, Name = "manual", OrderState = OrderState.Working };
            acc.Orders.Add(ntOrder);
            string id = (string)typeof(ChartBridgeOrders).GetMethod("IdFor", PS).Invoke(null, new object[] { ntOrder });
            msg("change", "{\"type\":\"change\",\"id\":\"" + id + "\",\"price\":61.2}");
            Check(rejected("CL " + why) && rejected("\"id\":\"" + id + "\""), "changing a CL order (placed in NinjaTrader) from the chart is refused");
            msg("cancel", "{\"type\":\"cancel\",\"id\":\"" + id + "\"}");
            Check(rejected("CL " + why), "cancelling it from the chart is refused");
            msg("plan", "{\"type\":\"plan\",\"id\":\"" + id + "\",\"stopTicks\":10}");
            Check(rejected("CL " + why) && acc.Calls.Count == 0, "planning on it is refused; nothing reached NinjaTrader for any of them");
            string orders = (string)typeof(ChartBridgeOrders).GetMethod("OrdersJson", PS).Invoke(null, null);
            Check(!orders.Contains("\"name\":\"manual\""), "the CL order is not listed to the page as a chart order (RootFor is null for it)");
            // not over-protected: a traded root still goes
            msg("order", "{\"type\":\"order\",\"cid\":\"q3\",\"account\":\"EVAL-Q\",\"root\":\"MNQ\",\"side\":\"buy\",\"kind\":\"market\",\"qty\":1}");
            Check(acc.Calls.Count == 1 && acc.Calls[0].StartsWith("submit CB#") && acc.Calls[0].Contains("Buy Market 1"), "an MNQ market order still goes to NinjaTrader: " + string.Join(" | ", acc.Calls));
            // quoteRoots emptied: CL is then not served for orders at all unless it is in roots (here it is only in Instruments as a stand-in)
            ChartBridgeConfig.QuoteRoots = new string[0];
            Check(ChartBridgeServer.InstrumentFor("CL") == cl, "with quoteRoots empty, a served CL would be a traded root (roots decides, as before 0.4.0)");
            ChartBridgeConfig.QuoteRoots = ChartBridgeMarkets.DefaultQuoteRoots();
        }
        finally
        {
            ChartBridgeOrders.ResetConfig();
            Account.All.Remove(acc);
            HashSet<Account> watched = (HashSet<Account>)Field("Watched");
            lock (watched) watched.Remove(acc);
        }
    }

    // ------------------------------------------------------------ a quote-only market's settlement time
    static void SettlementTimes()
    {
        TimeZoneInfo ny = TimeZoneInfo.FindSystemTimeZoneById("America/New_York");
        typeof(ChartBridgeTime).GetField("et", PS).SetValue(null, ny);
        Func<int, int, int, int, int, DateTime> Et = (y, mo, d, h, mi) => DateTime.SpecifyKind(TimeZoneInfo.ConvertTimeFromUtc(TimeZoneInfo.ConvertTimeToUtc(new DateTime(y, mo, d, h, mi, 0), ny), NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo), DateTimeKind.Unspecified);
        bool prov;
        DateTime stamp = Et(2026, 10, 6, 14, 45), now = Et(2026, 10, 6, 14, 50);
        DateTime? cl = ChartBridgeServer.SettlementDay(stamp, now, out prov, "CL"), idx = ChartBridgeServer.SettlementDay(stamp, now, out prov, null), mnq = ChartBridgeServer.SettlementDay(stamp, now, out prov, "MNQ");
        Check(cl == new DateTime(2026, 10, 6) && idx == new DateTime(2026, 10, 5) && mnq == idx, "a value stamped 14:45 ET: CL's own settlement (14:30) for that day; for MNQ the equity index rule (16:00), the day before, as before");
        Check(ChartBridgeMarkets.EarliestSettlement("GC", new DateTime(2026, 10, 6)) == new TimeSpan(13, 30, 0) && ChartBridgeMarkets.EarliestSettlement("ZN", new DateTime(2026, 10, 6)) == new TimeSpan(15, 0, 0) &&
              ChartBridgeMarkets.EarliestSettlement("CL", new DateTime(2026, 11, 27)) == new TimeSpan(12, 0, 0) && ChartBridgeMarkets.EarliestSettlement("ES", new DateTime(2026, 10, 6)) == new TimeSpan(16, 0, 0),
              "settlement times: GC 13:30, ZN 15:00, 12:00 on an early close for all, ES 16:00 as before");
    }

    // ------------------------------------------------------------ tape counters: right, and never throwing
    static void Tape()
    {
        ChartBridgeTape.Reset();
        double day = (new DateTime(2026, 10, 6) - new DateTime(1970, 1, 1)).TotalSeconds;   // bar-time seconds of 2026-10-06 00:00 ET
        double et0 = day + 9.5 * 3600, u0 = 1.79e12;                                          // 09:30 ET, a made-up UTC ms
        // 1,000 prints: every other one in the same millisecond as the one before; the others 10 ms later; one tick up or down
        // in turn, every tenth two ticks; each 5 ms after its own time when ChartBridge gets it
        double u = u0;
        for (int i = 0; i < 1000; i++)
        {
            if (i > 0 && i % 2 == 0) u += 10;
            double p = 100 + (i % 2 == 0 ? 0 : (i % 10 == 9 ? 0.5 : 0.25));
            ChartBridgeTape.OnPrint("TST", 0.25, u, u + 5, et0 + (u - u0) / 1000, p);
        }
        TapeRoot t = ChartBridgeTape.Of("TST");
        int k = (int)((9.5 * 3600 + 6 * 3600) / 900);   // 09:30 is slot 62 of the session from 18:00
        TapeSession s = t.Cur;
        Check(s.Prints[k] == 1000 && s.Pairs[k] == 999, "tape: 1,000 prints in the 09:30 slot, 999 pairs: " + s.Prints[k]);
        Check(s.SameU[k] == 500 && s.SameRx[k] == 500, "tape: half arrive in the same millisecond as the print before (by u and by rx): " + s.SameU[k] + " " + s.SameRx[k]);
        Check(s.J1[k] + s.J2[k] + s.J0[k] + s.J3[k] == 999 && s.J2[k] == 199 && s.J1[k] == 800 && s.J0[k] == 0, "tape: steps of 1 and 2 ticks counted: " + s.J1[k] + " " + s.J2[k]);
        Check(s.GapMax[k] == 10 && s.Peak[k] > 0, "tape: the longest gap 10 ms; a busiest second counted");
        string json = ChartBridgeTape.DiagJson();
        Check(json.Contains("\"TST\":{\"late\":0,\"session\":{\"from\":\"2026-10-05 18:00\",\"slots\":[{\"at\":\"09:30\",\"prints\":1000") && json.Contains("\"sameMsU\":0.501") && json.Contains("\"gapMs\":{\"p50\":1,\"p95\":11.314,\"max\":10}") && json.Contains("\"delayMs\":{\"p50\":5.657,\"p95\":5.657,\"below0\":0}"),
              "tape in /diag: the slot, its shares and its median, p95 and longest gap (bucket upper edges): " + json.Substring(0, Math.Min(600, json.Length)));
        // anything odd: no exception, nothing out of range
        bool threw = false;
        try
        {
            ChartBridgeTape.OnPrint("TST", 0.25, double.NaN, double.NaN, double.NaN, double.NaN);
            ChartBridgeTape.OnPrint("TST", 0.25, u - 1e9, u + 1e12, et0 - 3600 * 30, 100);          // a print of an earlier session: not counted
            ChartBridgeTape.OnPrint("TST", 0, u, u - 50, et0 + 1, -5);                              // no tick, a negative price, rx before u
            ChartBridgeTape.OnPrint("TST", 0.25, u, u, et0 + 7.9 * 3600, double.PositiveInfinity);   // 17:24 ET, the break slots
            ChartBridgeTape.OnPrint("TST", 0.25, u, u, et0 + 1e12, 1e300);                           // far future: a new session, clamped slot
            ChartBridgeTape.OnPrint("ZERO", 0, 0, 0, 0, 0);
            ChartBridgeTape.OnPrint("ZERO", double.NaN, double.MaxValue, double.MinValue, double.MaxValue, double.MaxValue);
            ChartBridgeTape.OnPrint(null, 0.25, u, u, et0, 100);
            ChartBridgeTape.DiagJson();
        }
        catch (Exception ex) { threw = true; Check(false, "tape threw: " + ex); }
        Check(!threw && t.Late == 1 && t.Sessions == 2 && t.Last.Prints[k] == 1001 && t.Last.NegDelay[k] == 1, "tape: NaN, an earlier session, a negative delay, the break, a far-off time: no exception; the last session kept apart, its odd print counted (" + t.Late + " late, " + t.Sessions + " sessions)");
        // no allocation per print: a million prints, the heap about where it was
        ChartBridgeTape.Reset();
        for (int i = 0; i < 1000; i++) ChartBridgeTape.OnPrint("TST", 0.25, u0 + i, u0 + i + 3, et0 + i / 1000.0, 100 + (i % 4) * 0.25);
        long before = GC.GetTotalMemory(true);
        for (int i = 0; i < 1000000; i++) ChartBridgeTape.OnPrint("TST", 0.25, u0 + i, u0 + i + 3, et0 + i / 1000.0, 100 + (i % 4) * 0.25);
        long grew = GC.GetTotalMemory(false) - before;
        Check(grew < 256 * 1024, "tape: a million prints made no garbage to speak of (" + grew + " bytes)");
        ChartBridgeTape.Reset();
    }

    // A fault in the tape counters never stops a trade, its send to the page, or the order code's last price.
    static void TapeNeverStopsATrade()
    {
        Instrument mnq = Inst("MNQ 12-26", "MNQ", 0.25, 2);
        Named().Clear(); Named()["MNQ"] = mnq;
        bool bfWas = ChartBridgeServer.BackfillOn;
        ChartBridgeServer.BackfillOn = false;
        List<string> got = new List<string>();
        ChartBridgeClient c = new ChartBridgeClient(null, 9402);
        c.Tap = s => { lock (got) got.Add(s); };
        c.Root = "MNQ"; c.Ready = true;
        Clients()[c.Id] = c;
        ChartBridgeTape.ThrowForHarness = true;
        long before = ChartBridgeTape.FailedCount;
        try
        {
            DateTime now = DateTime.Now;
            for (int i = 0; i < 50; i++)
                Priv("OnMarketData", null, new MarketDataEventArgs { Instrument = mnq, MarketDataType = MarketDataType.Last, Price = 25000.25 + i * 0.25, Volume = 1, Time = now.AddMilliseconds(i) });
            double[] last; ((Dictionary<string, double[]>)typeof(ChartBridgeOrders).GetField("Last", PS).GetValue(null)).TryGetValue("MNQ", out last);
            int ticks; lock (got) ticks = got.Count(x => x.StartsWith("{\"type\":\"tick\",\"root\":\"MNQ\""));
            Check(ticks == 50 && last != null && last[0] == 25000.25 + 49 * 0.25, "a throwing tape counter: every trade still went to the page (" + ticks + ") and the order code has the last price");
            Check(ChartBridgeTape.FailedCount - before == 50 && LoggedCount("tape counter error: tape test fault") == 1 && CbLogLimit.Count("tick error") == 0,
                  "its 50 faults are counted, said once in the Output window, and are not tick errors");
        }
        finally
        {
            ChartBridgeTape.ThrowForHarness = false;
            ChartBridgeClient g; Clients().TryRemove(c.Id, out g); c.Close();
            ChartBridgeServer.BackfillOn = bfWas;
            ChartBridgeServer.ResetBooks(DateTime.MinValue);
            ChartBridgeTape.Reset();
        }
    }

    // ------------------------------------------------------------ the tick, tick send and history error lines: once a minute
    static void LogLimit()
    {
        for (int i = 0; i < 1000; i++) CbLogLimit.Error("harness error", new InvalidOperationException("the same fault " + i));
        Check(LoggedCount("harness error: the same fault") == 1 && CbLogLimit.Count("harness error") == 1000 && CbLogLimit.DiagJson().Contains("\"harness error\":1000"),
              "1,000 faults of one kind: one Output line, all counted in /diag");
    }

    // ------------------------------------------------------------ item 1: each page's send loop on its own thread
    // A stand-in socket: records which thread each send ran on; the page "closes" (a Close frame) after closeMs; hang: no
    // send ever completes (a page that stopped reading).
    class ThreadSocket : System.Net.WebSockets.WebSocket
    {
        public readonly List<string> Got = new List<string>(); public readonly List<bool> Pool = new List<bool>(); public readonly List<int> Thread_ = new List<int>();
        public int CloseMs; public bool Hang; public volatile bool Aborted;
        public override System.Net.WebSockets.WebSocketCloseStatus? CloseStatus { get { return null; } }
        public override string CloseStatusDescription { get { return null; } }
        public override System.Net.WebSockets.WebSocketState State { get { return Aborted ? System.Net.WebSockets.WebSocketState.Aborted : System.Net.WebSockets.WebSocketState.Open; } }
        public override string SubProtocol { get { return null; } }
        public override void Abort() { Aborted = true; }
        public override System.Threading.Tasks.Task CloseAsync(System.Net.WebSockets.WebSocketCloseStatus st, string d, CancellationToken c) { return System.Threading.Tasks.Task.FromResult(0); }
        public override System.Threading.Tasks.Task CloseOutputAsync(System.Net.WebSockets.WebSocketCloseStatus st, string d, CancellationToken c) { return System.Threading.Tasks.Task.FromResult(0); }
        public override void Dispose() { }
        public override System.Threading.Tasks.Task<System.Net.WebSockets.WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> b, CancellationToken c)
        {
            return System.Threading.Tasks.Task.Delay(CloseMs).ContinueWith(t => new System.Net.WebSockets.WebSocketReceiveResult(0, System.Net.WebSockets.WebSocketMessageType.Close, true));
        }
        public override System.Threading.Tasks.Task SendAsync(ArraySegment<byte> b, System.Net.WebSockets.WebSocketMessageType t, bool end, CancellationToken c)
        {
            lock (Got) { Got.Add(System.Text.Encoding.UTF8.GetString(b.Array, b.Offset, b.Count)); Pool.Add(Thread.CurrentThread.IsThreadPoolThread); Thread_.Add(Thread.CurrentThread.ManagedThreadId); }
            return Hang ? new System.Threading.Tasks.TaskCompletionSource<int>().Task : System.Threading.Tasks.Task.FromResult(0);
        }
    }

    static void SendThread()
    {
        string pagesBefore = ChartBridgeHealth.PagesJson();
        ThreadSocket ws = new ThreadSocket { CloseMs = 400 };
        System.Threading.Tasks.Task run = (System.Threading.Tasks.Task)Priv("RunClient", ws, CancellationToken.None, null);
        bool ended = run.Wait(5000);
        List<string> got; List<bool> pool; List<int> ids;
        lock (ws.Got) { got = ws.Got.ToList(); pool = ws.Pool.ToList(); ids = ws.Thread_.ToList(); }
        Check(ended && got.Count >= 2 && got[0].StartsWith("{\"type\":\"hello\"") && got.Any(x => x.StartsWith("{\"type\":\"execs\"")) && pool.All(x => !x) && ids.Distinct().Count() == 1,
              "a page's sends (hello, execs) run on its own thread, never a thread-pool thread (" + got.Count + " sends, pool " + string.Join(",", pool) + ")");
        Check(ChartBridgeHealth.ThreadsJson().Contains("\"pageSendThreads\":0") && ChartBridgeHealth.PagesJson() != pagesBefore, "the send thread ended with the page; connects and closes counted: " + ChartBridgeHealth.PagesJson());
        // a page that stopped reading: its send never completes; once the page closes, the thread stops waiting within a second
        ThreadSocket hung = new ThreadSocket { CloseMs = 200, Hang = true };
        System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
        run = (System.Threading.Tasks.Task)Priv("RunClient", hung, CancellationToken.None, null);
        ended = run.Wait(5000);
        Check(ended && sw.Elapsed.TotalMilliseconds < 2500 && ChartBridgeHealth.ThreadsJson().Contains("\"pageSendThreads\":0"),
              "a page whose send never completes: after it closes, its send thread ends within a second (" + sw.Elapsed.TotalMilliseconds.ToString("0") + " ms), none left waiting");
    }

    static void Health()
    {
        string h = (string)Priv("HealthJson");
        Check(h.StartsWith("{\"memory\":{\"seenFills\":") && h.Contains("\"threads\":{\"poolWorkersFree\":") && h.Contains("\"pages\":{\"connects\":") && h.Contains("\"errors\":{"), "/diag health: memory, threads, pages and errors: " + h.Substring(0, Math.Min(300, h.Length)));
        CbHist x = new CbHist(0.01);
        for (int i = 1; i <= 1000; i++) x.Add(i / 100.0);   // 0.01 to 10 ms
        string j = x.Json();
        Check(j.StartsWith("{\"n\":1000,\"p50\":5.12,\"p95\":10.24,\"max\":10}"), "send times: median and p95 as bucket upper edges, the longest exact: " + j);
        Check(new CbHist(1).Json() == "{\"n\":0,\"p50\":null,\"p95\":null,\"max\":null}", "no sends yet: nulls");
    }

    // ------------------------------------------------------------ config.txt quoteRoots
    static void ConfigKey()
    {
        string dirWas = NinjaTrader.Core.Globals.UserDataDir;
        string dir = Path.Combine(Path.GetTempPath(), "cb-markets-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(dir, "ChartBridge"));
        NinjaTrader.Core.Globals.UserDataDir = dir;
        try
        {
            File.WriteAllText(Path.Combine(dir, "ChartBridge", "config.txt"), "quoteRoots = cl, 6e , ZN\n");
            ChartBridgeConfig.Load();
            Check(string.Join(",", ChartBridgeConfig.QuoteRoots) == "CL,6E,ZN" && string.Join(",", ChartBridgeConfig.Roots) == "MNQ,NQ,MES,ES", "quoteRoots from config.txt (upper case); roots stays MNQ, NQ, MES, ES");
            File.WriteAllText(Path.Combine(dir, "ChartBridge", "config.txt"), "quoteRoots =\n");
            ChartBridgeConfig.Load();
            Check(ChartBridgeConfig.QuoteRoots.Length == 0, "quoteRoots = (nothing): no quote-only markets");
            ChartBridgeConfig.QuoteRoots = ChartBridgeMarkets.DefaultQuoteRoots();
            Check(string.Join(",", ChartBridgeConfig.QuoteRoots) == "YM,RTY,GC,SI,CL,6E,ZN,ZB", "the default: YM, RTY, GC, SI, CL, 6E, ZN, ZB");
        }
        finally { NinjaTrader.Core.Globals.UserDataDir = dirWas; ChartBridgeOrders.ResetConfig(); try { Directory.Delete(dir, true); } catch (Exception) { } }
    }
}
