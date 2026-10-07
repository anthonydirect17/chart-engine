// ChartBridge accounts (protocol v3, ChartBridge 0.4.0). Part of the ChartBridge add-on; install it with the other files.
// See nt8/PROTOCOL.md, "Protocol v3 (ChartBridge 0.4.0)" and its "Accounts" section.
//
// This file never places, changes or cancels an order (no Submit, Change, Cancel or Flatten here). It holds:
//   - ChartBridgeSwitches: the v3 switches read from config.txt (accountChecks, orderTypes, strategies, merge,
//     cancelFromList, copier, bot), all OFF by default. It only records them; it never takes a key from another reader.
//   - which pages speak v3 (the page's "client" message, sent once right after hello);
//   - gate 2 with accountChecks = on: the page's per-account checkmark, which ChartBridge saves itself in accounts.txt
//     next to config.txt. First start (no accounts.txt) pre-checks tradeAccounts; afterwards only the checkmarks count.
//     trading = true stays the master switch above every checkmark (ChartBridgeOrders.AccountTradable checks it first);
//   - Gone: an account that is disconnected, disabled, or past its trailing drawdown for 10 s without a break loses its
//     checkmark at once (saved), is listed Gone, and the pages are told. Archive only after the page's confirm, and only
//     for a Gone account. History is kept (nothing is deleted); every change is one Output line and one accounts.log line;
//   - the "accounts" message: every watched account with its connection, checkmark, money, positions and the room to its
//     trailing drawdown and daily loss limit where NinjaTrader reports them (else null with a plain reason, never estimated);
//   - the exit side of gate 2 (flatten, cancel, moving a stop or target, cancel from the Working orders tab): a watched,
//     Connected account that is not Backtest or Playback and not archived; closing always works.
// With accountChecks off, gate 2 is tradeAccounts exactly as in 0.3.8: ChartBridgeOrders.cs asks this file nothing for
// v2 pages, no file is read or written, and no account goes Gone.
//
// What NinjaTrader 8 reports (checked against NinjaTrader's help guide, 2026-10-07):
//   - Account.Get(AccountItem, Currency) is documented; the documented AccountItem values include CashValue,
//     RealizedProfitLoss and UnrealizedProfitLoss (used for balance, realizedToday and unrealized).
//   - TrailingMaxDrawdown is NOT in the documented AccountItem list, but the Accounts tab's "Trailing max drawdown" column
//     is documented as "the remaining value of the trailing max drawdown", and NinjaTrader staff read it with
//     account.Get(AccountItem.TrailingMaxDrawdown, ...) "if your broker provides the information". It is read here by name
//     (so a NinjaTrader without it still compiles) as dollars left. Get answers 0 when nothing is reported, so a 0 is
//     taken as "not reported" until NinjaTrader has given a non-zero value for that account this run.
//   - The daily loss limit is documented only as a column showing "the percentage of the daily loss limit that has been
//     reached", not dollars left, so roomDailyLoss is always null with that reason (never converted or estimated).
//   - Disabled: Account.AccountStatusUpdate (documented, static) gives e.Account and e.Status; the Status values are not
//     documented. An account whose last status text is "Disabled" counts as disabled. Attached by reflection.
//   - sim: the account's Provider (read by reflection) is "Simulator". Unknown means false (not a Sim account), the safe side.
// Written in C# 5 syntax (NinjaTrader 8 compiles NinjaScript as C# 5).
#region Using declarations
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using System.Threading;
using NinjaTrader.Cbi;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    // ------------------------------------------------------------------ the v3 switches (PROTOCOL.md "v3 switches")
    public static class ChartBridgeSwitches
    {
        public static readonly string[] Names = { "accountChecks", "orderTypes", "strategies", "merge", "cancelFromList", "copier", "bot" };
        private static readonly bool[] Values = new bool[Names.Length];

        public static void Reset() { lock (Values) for (int i = 0; i < Values.Length; i++) Values[i] = false; }

        // Called by ChartBridgeConfig.Load for every key. on, true and 1 mean on (any case); anything else is off, and a value
        // that is not plainly off (off, false, 0) gets one Output line naming the key and the value.
        public static void Note(string key, string val)
        {
            int i = Array.IndexOf(Names, key);
            if (i < 0) return;
            string v = (val ?? "").Trim();
            bool on = v.Equals("on", StringComparison.OrdinalIgnoreCase) || v.Equals("true", StringComparison.OrdinalIgnoreCase) || v == "1";
            bool plainOff = v.Equals("off", StringComparison.OrdinalIgnoreCase) || v.Equals("false", StringComparison.OrdinalIgnoreCase) || v == "0";
            if (!on && !plainOff) ChartBridgeServer.Log("config.txt: " + key + " = " + v + " is not on, true or 1, so " + key + " is OFF");
            lock (Values) Values[i] = on;
        }

        public static bool Get(string name)
        {
            int i = Array.IndexOf(Names, name);
            if (i < 0) return false;
            lock (Values) return Values[i];
        }

        // {"accountChecks":false,...}: the trading message's "switches" for a v3 page.
        public static string Json()
        {
            StringBuilder b = new StringBuilder("{");
            lock (Values)
                for (int i = 0; i < Names.Length; i++) b.Append(i > 0 ? "," : "").Append(CbJson.Str(Names[i])).Append(':').Append(Values[i] ? "true" : "false");
            return b.Append('}').ToString();
        }
    }

    // ------------------------------------------------------------------ accounts, the checkmark and Gone
    public static class ChartBridgeAccounts
    {
        public const double GraceMs = 10000;   // "Gone ... for 10 s without a break (the grace)"
        public const int TickMs = 1000;        // the check and the money in "accounts": at most once a second
        public const string Header = "# ChartBridge accounts (written by ChartBridge; do not edit)";
        public const string ReadFailedText = "accounts.txt could not be read: trading is off for every account until it can";

        public static bool On { get { return ChartBridgeSwitches.Get("accountChecks"); } }
        public static bool CancelFromListOn { get { return ChartBridgeSwitches.Get("cancelFromList"); } }

        private static string FilePath { get { return Path.Combine(ChartBridgeConfig.Folder, "accounts.txt"); } }
        private static string LogPath { get { return Path.Combine(ChartBridgeConfig.Folder, "accounts.log"); } }

        // ---------------------------------------------------------- memory (Mem: never held during file I/O or a NinjaTrader call)
        private static readonly object Mem = new object();
        private static readonly object FileLock = new object();   // one write of accounts.txt or accounts.log at a time

        private class Rec { public string Name; public string State; public long ChangedMs; }   // State: trade, off or archived
        private class Live { public double BadSince = -1; public bool Gone; public string GoneWhy; public long GoneSince; }

        private static readonly Dictionary<string, Rec> Recs = new Dictionary<string, Rec>(StringComparer.OrdinalIgnoreCase);
        private static readonly Dictionary<string, Live> Lives = new Dictionary<string, Live>(StringComparer.OrdinalIgnoreCase);
        private static readonly Dictionary<string, string> StatusText = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);   // AccountStatusUpdate
        private static readonly HashSet<string> DrawdownSeen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);   // a non-zero trailing drawdown seen this run
        private static readonly List<string[]> PendingLog = new List<string[]>();   // accounts.log lines not written yet (Mem)
        private static bool loaded;          // accounts.txt read, or made on a first start, this run
        private static string readError;     // accounts.txt exists but could not be read: every checkmark off, never rewritten this run
        private static string startAlarm;    // said to each page as it signs in (a status error)
        private static bool dirty;           // memory differs from accounts.txt
        private static string saveError;     // the last save failed (an alarm was raised once)
        private static string lastAccountsJson;

        private static readonly ConditionalWeakTable<ChartBridgeClient, object> V3 = new ConditionalWeakTable<ChartBridgeClient, object>();
        private static Timer timer;
        private static int ticking;

        public static bool IsV3(ChartBridgeClient c) { object o; return c != null && V3.TryGetValue(c, out o); }

        // ---------------------------------------------------------- start and stop
        // ChartBridgeServer.Start, before the accounts are watched (their watch list reads the checkmarks). Reads accounts.txt
        // here; every write happens later on the timer's thread or a page's thread, never NinjaTrader's.
        public static void Start()
        {
            StartNow(ChartBridgeTime.NowUtcMs());
            WatchStatus();
            timer = new Timer(delegate { try { Tick(ChartBridgeTime.NowUtcMs()); } catch (Exception ex) { ChartBridgeServer.Log("accounts check error: " + ex.Message); } }, null, TickMs, TickMs);
        }

        public static void Stop()
        {
            try { if (timer != null) timer.Dispose(); } catch (Exception) { }
            timer = null;
            UnwatchStatus();
            Clear();
        }

        public static void Clear()
        {
            lock (Mem)
            {
                Recs.Clear(); Lives.Clear(); StatusText.Clear(); DrawdownSeen.Clear(); PendingLog.Clear();
                loaded = false; readError = null; startAlarm = null; dirty = false; saveError = null; lastAccountsJson = null;
            }
        }

        // Reads accounts.txt (accountChecks on only). Public for the harness, which runs it on its own thread.
        public static void StartNow(double now)
        {
            Clear();
            if (!On) return;
            string path = FilePath;
            if (!File.Exists(path)) { NoFile(now); return; }
            string[] lines = null;
            string err = null;
            for (int attempt = 0; attempt < 3 && lines == null; attempt++)
            {
                try { lines = File.ReadAllLines(path); err = null; }
                catch (Exception ex) { err = ex.Message; if (attempt < 2) Thread.Sleep(100); }
            }
            Dictionary<string, Rec> read = lines != null ? Parse(lines, out err) : null;
            lock (Mem)
            {
                loaded = true;
                if (read == null)
                {
                    // Contract: "A file that exists but cannot be read is never rewritten that run: every checkmark reads off".
                    readError = err ?? "unknown";
                    startAlarm = ReadFailedText;
                }
                else foreach (KeyValuePair<string, Rec> kv in read) Recs[kv.Key] = kv.Value;
            }
            if (read == null) Alarm(ReadFailedText + " (" + err + "); fix or delete the file, then recompile");
            else ChartBridgeServer.Log("accountChecks is on: the checkmarks in accounts.txt are gate 2 (" + read.Values.Count(r => r.State == "trade") + " checked); tradeAccounts in config.txt is not read for trading");
        }

        // No accounts.txt. A first start (no accounts.log either: ChartBridge never kept checkmarks here) pre-checks every
        // account named in tradeAccounts. If accounts.log is there, ChartBridge wrote accounts.txt before and it went missing:
        // nothing is checked (lead's default, the safe side) and the pages are told.
        private static void NoFile(double now)
        {
            bool before = File.Exists(LogPath);
            List<string> pre = before ? new List<string>() : ChartBridgeOrders.TradeAccounts.Where(n => !ChartBridgeOrders.IsNeverTradable(n)).ToList();
            lock (Mem)
            {
                loaded = true;
                foreach (string n in pre) Recs[n] = new Rec { Name = n, State = "trade", ChangedMs = (long)now };
                dirty = true;   // the timer writes the file (never NinjaTrader's thread)
                if (before) startAlarm = "accounts.txt is missing (ChartBridge made it before: accounts.log is there): no account is checked for trading; check them again on the Accounts tab";
            }
            if (before) { Alarm(startAlarm); NoteChange("(all)", "nothing checked", "accounts.txt was missing"); }
            else
            {
                ChartBridgeServer.Log("accountChecks is on, first start: the accounts in tradeAccounts come pre-checked (" + pre.Count + "); from now on only the checkmarks count and tradeAccounts is not read again");
                foreach (string n in pre) NoteChange(n, "checked", "first start: named in tradeAccounts");
            }
        }

        // The whole file or nothing: a header, then "<state>\t<changed UTC ms>\t<name>" lines. Anything else, a name twice, or a
        // Backtest or Playback account on a line: the file cannot be read (null, with why).
        private static Dictionary<string, Rec> Parse(string[] lines, out string why)
        {
            why = null;
            Dictionary<string, Rec> d = new Dictionary<string, Rec>(StringComparer.OrdinalIgnoreCase);
            if (lines.Length == 0 || lines[0].TrimEnd('\r') != Header) { why = "the first line is not ChartBridge's header"; return null; }
            for (int i = 1; i < lines.Length; i++)
            {
                string line = lines[i].TrimEnd('\r');
                if (line.Length == 0) continue;
                string[] p = line.Split('\t');
                long ms;
                if (p.Length != 3 || (p[0] != "trade" && p[0] != "off" && p[0] != "archived") || !long.TryParse(p[1], NumberStyles.None, CultureInfo.InvariantCulture, out ms) || p[2].Trim().Length == 0 || p[2] != p[2].Trim())
                { why = "line " + (i + 1) + " is not <state> <time> <name>"; return null; }
                if (ChartBridgeOrders.IsNeverTradable(p[2])) { why = "line " + (i + 1) + " names a Backtest or Playback account"; return null; }
                if (d.ContainsKey(p[2])) { why = "line " + (i + 1) + " names an account twice"; return null; }
                d[p[2]] = new Rec { Name = p[2], State = p[0], ChangedMs = ms };
            }
            return d;
        }

        // ---------------------------------------------------------- gate 2 (asked by ChartBridgeOrders.cs only when accountChecks is on)
        // The checkmark: on, accounts.txt read, not Gone. A Gone account's checkmark is already off (Gone turns it off); the
        // Gone test here is a second lock on the same door.
        public static bool Checked(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            lock (Mem)
            {
                if (!loaded || readError != null) return false;
                Rec r;
                Live l;
                if (!Recs.TryGetValue(name, out r) || r.State != "trade") return false;
                return !(Lives.TryGetValue(name, out l) && l.Gone);
            }
        }

        private static bool Archived(string name)
        {
            lock (Mem) { Rec r; return name != null && Recs.TryGetValue(name, out r) && r.State == "archived"; }
        }

        private static bool Gone(string name, out string why)
        {
            lock (Mem) { Live l; why = null; if (name == null || !Lives.TryGetValue(name, out l) || !l.Gone) return false; why = l.GoneWhy; return true; }
        }

        // Why an entry on this account is refused (gate 2 with the checkmark), for ChartBridgeOrders.FindAccount.
        public static string EntryRefusal(string name)
        {
            string label = string.IsNullOrEmpty(name) ? "(none)" : name, gw;
            if (string.IsNullOrEmpty(name) || ChartBridgeOrders.IsNeverTradable(name)) return "account " + label + " may not trade from the chart (never Backtest or Playback)";
            lock (Mem) { if (readError != null) return ReadFailedText; if (!loaded) return "ChartBridge is still reading accounts.txt; try again in a moment"; }
            if (Archived(name)) return "account " + name + " is archived";
            if (Gone(name, out gw)) return "account " + name + " is gone (" + gw + "): trading is off for it; check it again on the Accounts tab once it is back";
            return "account " + name + " is not checked for trading (the Accounts tab)";
        }

        // Exits (PROTOCOL.md "Gate 2 with the checkmark"): flatten, cancel, moving a ChartBridge stop or target, cancel from the
        // Working orders tab. A watched, Connected account that is not Backtest or Playback (and not archived: an archived account
        // is in no list). No checkmark needed: closing must always work.
        public static bool ExitAllowed(Account a, out string why)
        {
            why = null;
            string name = a != null ? a.Name : null;
            if (string.IsNullOrEmpty(name) || ChartBridgeOrders.IsNeverTradable(name)) { why = "account " + (name ?? "(none)") + " may not trade from the chart (never Backtest or Playback)"; return false; }
            if (Archived(name)) { why = "account " + name + " is archived"; return false; }
            if (!ChartBridgeConfig.AccountAllowed(name)) { why = "account " + name + " is not watched (accounts in config.txt)"; return false; }
            string status = StatusOf(a);
            if (status != "Connected") { why = "account " + name + " is not connected (" + status + ")"; return false; }
            if (!ChartBridgeServer.EnsureWatched(a)) { why = "ChartBridge is not listening to account " + name + " yet; try again in a few seconds"; return false; }
            return true;
        }

        // Flatten with accountChecks on: the exit side of gate 2. Returns the account, or null with why.
        public static Account FindForExit(string name, out string why)
        {
            Account found = null;
            if (!string.IsNullOrEmpty(name))
                lock (Account.All) foreach (Account a in Account.All) if (a.Name != null && a.Name.Equals(name, StringComparison.OrdinalIgnoreCase)) { found = a; break; }
            if (found == null) { why = "account " + (name ?? "(none)") + " is not connected in NinjaTrader"; return null; }
            return ExitAllowed(found, out why) ? found : null;
        }

        // cancel's optional "from": only "list" (the Working orders tab), and only with cancelFromList = on.
        public static string CancelFromRefusal(bool has, string from)
        {
            if (!has) return null;
            if (from != "list") return "from must be \"list\"";
            if (!CancelFromListOn) return "Cancel from the Working orders tab is off (cancelFromList in config.txt)";
            return null;
        }

        // The names gate 2 allows for entries, for the trading message (with accountChecks off: tradeAccounts, as in v2).
        public static List<string> CheckedNames()
        {
            List<string> names = new List<string>();
            lock (Mem) { if (!loaded || readError != null) return names; names.AddRange(Recs.Values.Where(r => r.State == "trade").Select(r => r.Name)); }
            return names.Where(Checked).OrderBy(n => n, StringComparer.OrdinalIgnoreCase).ToList();
        }

        // ---------------------------------------------------------- what a page sees (v3: every watched account; v2: v2's scope)
        // A watched, non-archived account: in the accounts list and in a v3 page's orders and positions.
        public static bool Listed(string name)
        {
            return !string.IsNullOrEmpty(name) && !ChartBridgeOrders.IsNeverTradable(name) && ChartBridgeConfig.AccountAllowed(name) && !Archived(name);
        }

        private static bool AnyV3Page()
        {
            foreach (ChartBridgeClient c in ChartBridgeServer.AllClients()) if (IsV3(c) && ChartBridgeOrders.OriginAllowed(c.Origin)) return true;
            return false;
        }

        private static bool AnyV3Trader()
        {
            foreach (ChartBridgeClient c in ChartBridgeServer.AllClients()) if (c.Trader && IsV3(c)) return true;
            return false;
        }

        // Does any signed-in page see this account's orders and positions? (v2: tradable accounts only, exactly as 0.3.8.)
        public static bool Seen(string name) { return ChartBridgeOrders.AccountTradable(name) || (Listed(name) && AnyV3Trader()); }

        // The accounts whose orders and positions a page gets after its sign-in.
        public static List<Account> ScopeFor(ChartBridgeClient c)
        {
            List<Account> all;
            lock (Account.All) all = Account.All.ToList();
            bool v3 = IsV3(c);
            return all.Where(a => v3 ? Listed(a.Name) : ChartBridgeOrders.AccountTradable(a.Name)).ToList();
        }

        // Gate 2 for entries right now (the "tradable" flag): the checkmark (or tradeAccounts) and the master switch, Connected.
        private static bool TradableNow(string name, string connection) { return ChartBridgeOrders.AccountTradable(name) && connection == "connected"; }

        private static string ConnectionOf(string name)
        {
            Account a = Find(name);
            return a == null ? "disconnected" : ConnectionText(a);
        }

        // An order message as a page should get it: a v3 page also gets "tradable".
        public static string ForPage(ChartBridgeClient c, string account, string orderJson)
        {
            if (!IsV3(c) || !orderJson.EndsWith("}", StringComparison.Ordinal)) return orderJson;
            return orderJson.Substring(0, orderJson.Length - 1) + ",\"tradable\":" + (TradableNow(account, ConnectionOf(account)) ? "true" : "false") + "}";
        }

        // A live order or position message: to every signed-in page that sees the account.
        public static void SendScoped(string account, string json, bool isOrder)
        {
            bool tradable = ChartBridgeOrders.AccountTradable(account), listed = Listed(account);
            string v3json = null;
            foreach (ChartBridgeClient c in ChartBridgeServer.AllClients())
            {
                if (!c.Trader) continue;
                if (IsV3(c)) { if (listed) c.Send(isOrder ? (v3json ?? (v3json = ForPage(c, account, json))) : json); }
                else if (tradable) c.Send(json);
            }
        }

        // The trading message for this page: a signed-in v3 page also gets the switches.
        public static string TradingFor(ChartBridgeClient c, string tradingJson)
        {
            if (!IsV3(c) || !c.Trader || !tradingJson.EndsWith("}", StringComparison.Ordinal)) return tradingJson;
            return tradingJson.Substring(0, tradingJson.Length - 1) + ",\"switches\":" + ChartBridgeSwitches.Json() + "}";
        }

        // After a page signs in: the accounts.txt alarm, if there is one.
        public static void SignedIn(ChartBridgeClient c)
        {
            string alarm;
            lock (Mem) alarm = startAlarm;
            if (alarm != null) c.Send(Status("error", alarm));
        }

        // ---------------------------------------------------------- messages from the page
        // client (no sign-in needed), accountTrade, accountArchive (gates 1, 4 and 7 first, then strict keys, then the switch).
        public static void OnMessage(ChartBridgeClient client, string type, string text)
        {
            string cid = null;
            try
            {
                if (type == "client") { OnClient(client, text); return; }
                string why = ChartBridgeOrders.Gate(client);
                Dictionary<string, string> m = null;
                string[] keys = type == "accountTrade" ? new[] { "type", "cid", "account", "on" } : new[] { "type", "cid", "account", "confirm" };
                if (why == null) m = Flat(text, type, keys, out why);
                if (m != null) cid = StrOf(m, "cid");
                if (why == null && m.ContainsKey("cid") && cid == null) why = "cid must be a plain string";
                if (why == null && !On) why = type + " is off (accountChecks in config.txt)";
                if (why == null) why = type == "accountTrade" ? AccountTrade(m) : AccountArchive(m);
                if (why != null) client.Send(Reject(cid, why));
            }
            catch (Exception ex)
            {
                ChartBridgeServer.Log("accounts error: " + ex.Message);
                client.Send(Reject(cid, "ChartBridge error: " + ex.Message));
            }
        }

        // {"type":"client","v":3}: this page speaks v3. Anything else is refused with a status warn (the page stays v2).
        private static void OnClient(ChartBridgeClient client, string text)
        {
            string why;
            Dictionary<string, string> m = Flat(text, "client", new[] { "type", "v" }, out why);
            if (why == null && (!m.ContainsKey("v") || m["v"] != "3")) why = "v must be 3";
            if (why != null) { client.Send(Status("warn", "ChartBridge refused a client message: " + why)); return; }
            if (!IsV3(client)) V3.Add(client, true);
            if (ChartBridgeOrders.OriginAllowed(client.Origin)) client.Send(AccountsJson(Snapshot(), ChartBridgeTime.NowUtcMs()));   // own page only, signed in or not
        }

        private static string AccountTrade(Dictionary<string, string> m)
        {
            string name = StrOf(m, "account"), on = m.ContainsKey("on") ? m["on"] : null;
            if (name == null) return "accountTrade needs account (a plain string)";
            if (on != "true" && on != "false") return "on must be true or false";
            double now = ChartBridgeTime.NowUtcMs();
            if (on == "false") return Uncheck(name, now);
            // On is refused for an account that is Gone, archived, not Connected, Backtest or Playback.
            if (ChartBridgeOrders.IsNeverTradable(name)) return name + " can never trade (Backtest and Playback)";
            lock (Mem) if (readError != null) return ReadFailedText + "; nothing was changed";
            Account a = Find(name);
            if (a == null && !Known(name)) return "no account " + name;
            if (a != null && !Listed(a.Name) && !Archived(a.Name)) return "account " + name + " is not watched (accounts in config.txt)";
            if (a != null) name = a.Name;
            string gw;
            if (Archived(name)) return name + " is archived; it comes back unchecked when it connects again";
            if (Gone(name, out gw)) return name + " is gone (" + gw + "); it can be checked again once it is back";
            string status = a != null ? StatusOf(a) : "not in NinjaTrader";
            if (status != "Connected") return name + " is not connected (" + status + ")";
            SetState(name, "trade", now);
            NoteChange(name, "checked", "by the page");
            AfterCheckmark();
            return null;
        }

        // Off is always accepted (signed in): nothing to change for an account that is unknown, archived, or already off.
        private static string Uncheck(string name, double now)
        {
            Rec r;
            bool change;
            lock (Mem) change = readError == null && Recs.TryGetValue(name, out r) && r.State == "trade";
            if (change)
            {
                lock (Mem) { name = Recs[name].Name; }
                SetState(name, "off", now);
                NoteChange(name, "unchecked", "by the page");
            }
            AfterCheckmark();
            return null;
        }

        private static string AccountArchive(Dictionary<string, string> m)
        {
            string name = StrOf(m, "account"), confirm = m.ContainsKey("confirm") ? m["confirm"] : null;
            if (name == null) return "accountArchive needs account (a plain string)";
            if (confirm != "true") return "Archive needs confirm: true (the page asks Anthony first)";
            lock (Mem) if (readError != null) return ReadFailedText + "; nothing was changed";
            Account a = Find(name);
            if (a != null) name = a.Name;
            else lock (Mem) { Rec r; if (Recs.TryGetValue(name, out r)) name = r.Name; }
            if (Archived(name)) return name + " is archived already";
            string gw;
            if (!Gone(name, out gw)) return (Known(name) || a != null ? name + " is not gone; only a gone account can be archived" : "no account " + name);
            double now = ChartBridgeTime.NowUtcMs();
            SetState(name, "archived", now);
            NoteChange(name, "archived", "by the page");
            AfterCheckmark();
            return null;
        }

        private static bool Known(string name) { lock (Mem) return Recs.ContainsKey(name) || Lives.ContainsKey(name); }

        private static void SetState(string name, string state, double now)
        {
            lock (Mem)
            {
                Rec r;
                if (!Recs.TryGetValue(name, out r)) Recs[name] = r = new Rec { Name = name };
                r.State = state; r.ChangedMs = (long)now; dirty = true;
            }
        }

        // After any checkmark change: saved, then every v3 own page gets accounts and every signed-in page gets trading again
        // (its accounts list is gate 2 now). On the page's thread or the timer's, never NinjaTrader's.
        private static void AfterCheckmark()
        {
            Save();
            FlushLog();
            SendAccounts(AccountsJson(Snapshot(), ChartBridgeTime.NowUtcMs()), true);
            foreach (ChartBridgeClient c in ChartBridgeServer.AllClients())
                if (c.Trader) c.Send(TradingFor(c, ChartBridgeOrders.TradingJson(true, null)));
        }

        // ---------------------------------------------------------- every second: Gone, the file, the accounts message
        public static void Tick(double now)
        {
            if (Interlocked.CompareExchange(ref ticking, 1, 0) != 0) return;
            try
            {
                List<Account> all = Snapshot();
                bool changed = false;
                bool track;
                lock (Mem) track = loaded && readError == null;
                if (On && track) changed = CheckGone(all, now);
                Save();
                FlushLog();
                if (changed) AfterCheckmark();
                else if (AnyV3Page()) SendAccounts(AccountsJson(all, now), false);   // money and positions: at most once a second
                else lock (Mem) lastAccountsJson = null;
            }
            finally { Interlocked.Exchange(ref ticking, 0); }
        }

        private static List<Account> Snapshot()
        {
            lock (Account.All) return Account.All.ToList();
        }

        private static Account Find(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            lock (Account.All) foreach (Account a in Account.All) if (a.Name != null && a.Name.Equals(name, StringComparison.OrdinalIgnoreCase)) return a;
            return null;
        }

        // Every account to list or watch for Gone: the watched accounts NinjaTrader has, and the ones accounts.txt knows
        // (an account whose connection is not up is not always in Account.All; it shows as disconnected).
        private static List<string> Names(List<Account> all, bool withArchived)
        {
            HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (Account a in all) if (a.Name != null && !ChartBridgeOrders.IsNeverTradable(a.Name) && ChartBridgeConfig.AccountAllowed(a.Name)) names.Add(a.Name);
            lock (Mem) foreach (Rec r in Recs.Values) if (withArchived || r.State != "archived") names.Add(r.Name);
            if (!withArchived) names.RemoveWhere(Archived);
            return names.OrderBy(n => n, StringComparer.OrdinalIgnoreCase).ToList();
        }

        // Gone (PROTOCOL.md "Gone"): disconnected, disabled, or past its drawdown limit for GraceMs without a break. At that
        // moment its checkmark goes off and is saved, the pages are told and the change is logged. When it comes back healthy
        // it is listed as active again with the checkmark still off. An archived account that comes back healthy returns as
        // active and unchecked. Returns true when a checkmark or a state changed.
        private static bool CheckGone(List<Account> all, double now)
        {
            bool changed = false;
            List<string> warn = new List<string>();
            List<string[]> notes = new List<string[]>();   // logged after Mem is released
            foreach (string listed in Names(all, true))
            {
                string name = listed;
                Account a = all.FirstOrDefault(x => x.Name != null && x.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
                string why = BadWhy(a);   // NinjaTrader calls, outside Mem
                lock (Mem)
                {
                    Live l;
                    if (!Lives.TryGetValue(name, out l)) Lives[name] = l = new Live();
                    Rec r;
                    if (!Recs.TryGetValue(name, out r)) { Recs[name] = r = new Rec { Name = name, State = "off", ChangedMs = (long)now }; dirty = true; }   // seen: kept in accounts.txt
                    if (r.State == "archived")
                    {
                        if (why == null && a != null) { r.State = "off"; r.ChangedMs = (long)now; dirty = true; l.Gone = false; l.GoneWhy = null; l.BadSince = -1; changed = true; notes.Add(new[] { name, "back from the archive", "connected again; unchecked" }); }
                        continue;
                    }
                    if (why == null)
                    {
                        l.BadSince = -1;
                        if (l.Gone) { l.Gone = false; l.GoneWhy = null; l.GoneSince = 0; changed = true; notes.Add(new[] { name, "active again", "healthy again; the checkmark stays off" }); }
                        continue;
                    }
                    if (l.Gone) continue;
                    if (l.BadSince < 0) { l.BadSince = now; continue; }   // the grace starts with the first bad reading
                    if (now - l.BadSince < GraceMs) continue;
                    l.Gone = true; l.GoneWhy = why; l.GoneSince = (long)now;
                    bool wasChecked = r.State == "trade";
                    r.State = "off"; r.ChangedMs = (long)now; dirty = true; changed = true;
                    notes.Add(new[] { name, "gone", why + " for " + (GraceMs / 1000).ToString(CultureInfo.InvariantCulture) + " s" + (wasChecked ? "; unchecked: trading is off for it" : "") });
                    warn.Add(name + " is gone (" + WhyWords(why) + " for " + (GraceMs / 1000).ToString(CultureInfo.InvariantCulture) + " s): trading is off for it");
                }
            }
            foreach (string[] n in notes) NoteChange(n[0], n[1], n[2]);
            foreach (string w in warn) Warn(w);
            return changed;
        }

        private static string WhyWords(string why)
        {
            if (why == "disabled") return "disabled in NinjaTrader";
            if (why == "drawdown") return "past its trailing drawdown";
            if (why == "dailyLoss") return "past its daily loss limit";
            return "disconnected";
        }

        // What makes an account Gone now, or null when it is healthy.
        private static string BadWhy(Account a)
        {
            if (a == null || ConnectionText(a) != "connected") return "disconnected";
            if (IsDisabled(a.Name)) return "disabled";
            string w;
            double? room = RoomDrawdown(a, out w);
            if (room.HasValue && room.Value <= 0) return "drawdown";
            return null;   // roomDailyLoss is never reported in dollars (see the top of this file), so it never makes an account Gone
        }

        // ---------------------------------------------------------- the accounts message
        public static string AccountsJson(List<Account> all, double now)
        {
            StringBuilder b = new StringBuilder("{\"type\":\"accounts\",\"list\":[");
            bool first = true;
            foreach (string name in Names(all, false))
            {
                Account a = all.FirstOrDefault(x => x.Name != null && x.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
                if (!first) b.Append(','); first = false;
                AccountJson(b, name, a);
            }
            b.Append("],\"archived\":[");
            List<Rec> archived;
            lock (Mem) archived = Recs.Values.Where(r => r.State == "archived").OrderBy(r => r.Name, StringComparer.OrdinalIgnoreCase).Select(r => new Rec { Name = r.Name, State = r.State, ChangedMs = r.ChangedMs }).ToList();
            for (int i = 0; i < archived.Count; i++)
                b.Append(i > 0 ? "," : "").Append("{\"name\":").Append(CbJson.Str(archived[i].Name)).Append(",\"at\":").Append(archived[i].ChangedMs.ToString(CultureInfo.InvariantCulture)).Append('}');
            return b.Append("]}").ToString();
        }

        private static void AccountJson(StringBuilder b, string name, Account a)
        {
            string connection = a == null ? "disconnected" : ConnectionText(a);
            bool trade = On ? Checked(name) : ChartBridgeOrders.TradeAccounts.Any(t => t.Equals(name, StringComparison.OrdinalIgnoreCase));
            string goneWhy;
            bool gone = Gone(name, out goneWhy);
            long goneSince;
            lock (Mem) { Live l; goneSince = Lives.TryGetValue(name, out l) && l.Gone ? l.GoneSince : 0; }
            bool up = connection == "connected";
            double? balance = up ? Item(a, AccountItem.CashValue) : null;
            double? realized = up ? Item(a, AccountItem.RealizedProfitLoss) : null;
            double? unrealized = up ? Item(a, AccountItem.UnrealizedProfitLoss) : null;
            double? pnl = realized.HasValue && unrealized.HasValue ? realized.Value + unrealized.Value : (double?)null;
            string ddWhy = "the account is not connected", dlWhy = "the account is not connected";
            double? room = up ? RoomDrawdown(a, out ddWhy) : null;
            if (up) dlWhy = "NinjaTrader reports the daily loss limit only as the share already used (its Accounts tab), not as dollars left; ChartBridge does not estimate it";
            b.Append("{\"name\":").Append(CbJson.Str(name))
             .Append(",\"sim\":").Append(a != null && IsSim(a) ? "true" : "false")
             .Append(",\"connection\":").Append(CbJson.Str(connection))
             .Append(",\"trade\":").Append(trade ? "true" : "false")
             .Append(",\"tradable\":").Append(!gone && TradableNow(name, connection) ? "true" : "false")
             .Append(",\"state\":").Append(gone ? "\"gone\"" : "\"active\"")
             .Append(",\"goneWhy\":").Append(gone ? CbJson.Str(goneWhy) : "null")
             .Append(",\"goneSince\":").Append(gone ? goneSince.ToString(CultureInfo.InvariantCulture) : "null")
             .Append(",\"balance\":").Append(Money(balance))
             .Append(",\"pnlToday\":").Append(Money(pnl))
             .Append(",\"realizedToday\":").Append(Money(realized))
             .Append(",\"unrealized\":").Append(Money(unrealized))
             .Append(",\"positions\":[").Append(a != null ? PositionsJson(a) : "").Append(']')
             .Append(",\"roomDrawdown\":").Append(Money(room))
             .Append(",\"roomDrawdownWhy\":").Append(room.HasValue ? "null" : CbJson.Str(ddWhy))
             .Append(",\"roomDailyLoss\":null")
             .Append(",\"roomDailyLossWhy\":").Append(CbJson.Str(dlWhy))
             .Append('}');
        }

        private static string Money(double? v) { return v.HasValue ? CbJson.Num(Math.Round(v.Value, 2)) : "null"; }

        private static string PositionsJson(Account a)
        {
            List<Position> positions;
            try { lock (a.Positions) positions = a.Positions.ToList(); } catch (Exception) { return ""; }
            List<string> items = new List<string>();
            foreach (Position p in positions)
            {
                string root = ChartBridgeServer.RootFor(p.Instrument);
                int signed = p.MarketPosition == MarketPosition.Long ? p.Quantity : p.MarketPosition == MarketPosition.Short ? -p.Quantity : 0;
                if (root == null || signed == 0) continue;
                items.Add("{\"root\":" + CbJson.Str(root) + ",\"name\":" + CbJson.Str(p.Instrument.FullName) + ",\"qty\":" + signed + ",\"avgPrice\":" + CbJson.Num(p.AveragePrice) + "}");
            }
            return string.Join(",", items);
        }

        // To every v3 page on ChartBridge's own origin, signed in or not. Unchanged text is not sent again unless forced.
        private static void SendAccounts(string json, bool force)
        {
            lock (Mem) { if (!force && json == lastAccountsJson) return; lastAccountsJson = json; }
            foreach (ChartBridgeClient c in ChartBridgeServer.AllClients())
                if (IsV3(c) && ChartBridgeOrders.OriginAllowed(c.Origin)) c.Send(json);
        }

        // ---------------------------------------------------------- what NinjaTrader reports (see the top of this file)
        private static readonly object TrailingItem = ItemNamed("TrailingMaxDrawdown");

        private static object ItemNamed(string name)
        {
            try { return Enum.IsDefined(typeof(AccountItem), name) ? Enum.Parse(typeof(AccountItem), name) : null; } catch (Exception) { return null; }
        }

        // One AccountItem value, or null when NinjaTrader gives none (an error, NaN).
        private static double? Item(Account a, AccountItem item)
        {
            if (a == null) return null;
            try
            {
                double v = a.Get(item, a.Denomination);
                return double.IsNaN(v) || double.IsInfinity(v) ? (double?)null : v;
            }
            catch (Exception) { return null; }
        }

        // Dollars left before the trailing drawdown, as NinjaTrader's "Trailing max drawdown" ("the remaining value"), or null
        // with why. Get answers 0 for an account whose connection reports none, so 0 counts only after a non-zero value for this
        // account this run (then 0 or below means the room is used up).
        public static double? RoomDrawdown(Account a, out string why)
        {
            why = null;
            if (TrailingItem == null) { why = "this NinjaTrader has no trailing drawdown value (no TrailingMaxDrawdown account item)"; return null; }
            double v;
            try { v = a.Get((AccountItem)TrailingItem, a.Denomination); }
            catch (Exception ex) { why = "NinjaTrader could not give the trailing drawdown (" + ex.Message + ")"; return null; }
            if (double.IsNaN(v) || double.IsInfinity(v)) { why = "NinjaTrader does not report a trailing drawdown for this account"; return null; }
            lock (Mem)
            {
                if (v != 0) DrawdownSeen.Add(a.Name);
                else if (!DrawdownSeen.Contains(a.Name)) { why = "NinjaTrader does not report a trailing drawdown for this account (it shows 0, as it does when none is set)"; return null; }
            }
            return v;
        }

        // NinjaTrader's simulator: the account's Provider is Simulator. Read by reflection; unknown is false (the safe side).
        public static bool IsSim(Account a)
        {
            try
            {
                PropertyInfo p = a.GetType().GetProperty("Provider", BindingFlags.Public | BindingFlags.Instance);
                object v = p != null ? p.GetValue(a, null) : null;
                return v != null && v.ToString() == "Simulator";
            }
            catch (Exception) { return false; }
        }

        private static string StatusOf(Account a)
        {
            try { return a.Connection == null ? "no connection" : a.Connection.Status.ToString(); } catch (Exception ex) { return "unknown: " + ex.Message; }
        }

        // connected, connecting, lost (NinjaTrader retrying) or disconnected.
        public static string ConnectionText(Account a)
        {
            string s = StatusOf(a);
            if (s == "Connected") return "connected";
            if (s == "Connecting") return "connecting";
            if (s == "ConnectionLost") return "lost";
            return "disconnected";
        }

        private static bool IsDisabled(string name)
        {
            lock (Mem) { string t; return name != null && StatusText.TryGetValue(name, out t) && string.Equals(t, "Disabled", StringComparison.OrdinalIgnoreCase); }
        }

        // Account.AccountStatusUpdate (static, documented): e.Account and e.Status, read by reflection so this compiles on every
        // NinjaTrader 8 release. Only the text is kept; the 1 s check decides.
        private static EventInfo statusEvent;
        private static Delegate statusHandler;

        private static void WatchStatus()
        {
            try
            {
                EventInfo ev = typeof(Account).GetEvent("AccountStatusUpdate", BindingFlags.Public | BindingFlags.Static);
                if (ev == null) { ChartBridgeServer.Log("account status events not found; a disabled account is not seen as Gone (only a disconnected one)"); return; }
                MethodInfo mi = typeof(ChartBridgeAccounts).GetMethod("OnAccountStatus", BindingFlags.NonPublic | BindingFlags.Static);
                Delegate d = Delegate.CreateDelegate(ev.EventHandlerType, mi);
                ev.AddEventHandler(null, d);
                statusEvent = ev; statusHandler = d;
            }
            catch (Exception ex) { ChartBridgeServer.Log("could not watch account status events (" + ex.Message + "); a disabled account is not seen as Gone"); }
        }

        private static void UnwatchStatus()
        {
            try { if (statusEvent != null && statusHandler != null) statusEvent.RemoveEventHandler(null, statusHandler); } catch (Exception) { }
            statusEvent = null; statusHandler = null;
        }

        private static void OnAccountStatus(object sender, EventArgs e)
        {
            try
            {
                PropertyInfo pa = e.GetType().GetProperty("Account"), ps = e.GetType().GetProperty("Status");
                Account a = pa != null ? pa.GetValue(e, null) as Account : null;
                object s = ps != null ? ps.GetValue(e, null) : null;
                if (a == null || a.Name == null || s == null) return;
                lock (Mem) StatusText[a.Name] = s.ToString();
            }
            catch (Exception) { }
        }

        // ---------------------------------------------------------- files (accounts.txt whole via a temp file; accounts.log appended)
        // Never on NinjaTrader's thread: the page's connection thread or the 1 s timer. A failed save keeps what is in memory in
        // force, raises one alarm, and is tried again every second.
        private static void Save()
        {
            lock (FileLock)
            {
                string text;
                lock (Mem)
                {
                    if (!loaded || readError != null || !dirty) return;   // a file that could not be read is never rewritten that run
                    StringBuilder b = new StringBuilder(Header).Append('\n');
                    foreach (Rec r in Recs.Values.OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase))
                        b.Append(r.State).Append('\t').Append(r.ChangedMs.ToString(CultureInfo.InvariantCulture)).Append('\t').Append(r.Name).Append('\n');
                    text = b.ToString();
                    dirty = false;
                }
                string err = null;
                try
                {
                    Directory.CreateDirectory(ChartBridgeConfig.Folder);
                    string tmp = FilePath + ".tmp";
                    File.WriteAllText(tmp, text);
                    if (File.Exists(FilePath)) File.Replace(tmp, FilePath, null); else File.Move(tmp, FilePath);
                }
                catch (Exception ex) { err = ex.Message; }
                bool alarm;
                lock (Mem)
                {
                    alarm = err != null && saveError == null;
                    if (err != null) dirty = true;
                    saveError = err;
                }
                if (alarm) Alarm("accounts.txt could not be saved (" + err + "): the checkmarks are in force now but may not survive a restart; ChartBridge tries again every second");
            }
        }

        // One Output line now, one accounts.log line when the log is next flushed (off NinjaTrader's thread).
        private static void NoteChange(string name, string what, string why)
        {
            ChartBridgeServer.Log("accounts: " + name + ": " + what + " (" + why + ")");
            string at = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
            lock (Mem) PendingLog.Add(new[] { at, name, what, why });
        }

        private static void FlushLog()
        {
            lock (FileLock)
            {
                List<string[]> lines;
                lock (Mem) { if (PendingLog.Count == 0) return; lines = PendingLog.ToList(); PendingLog.Clear(); }
                try
                {
                    Directory.CreateDirectory(ChartBridgeConfig.Folder);
                    File.AppendAllText(LogPath, string.Concat(lines.Select(l => string.Join("\t", l) + "\n")));
                }
                catch (Exception ex)
                {
                    ChartBridgeServer.Log("accounts.log could not be written (" + ex.Message + "); trying again");
                    lock (Mem) PendingLog.InsertRange(0, lines);
                }
            }
        }

        // ---------------------------------------------------------- strict messages (gate 8 as extended for v3)
        // One flat JSON object: plain keys, each once and each allowed; values a plain string (printable, at most 200
        // characters), true, false, null or a plain number; no escape, no nested object, no list. Returns key -> raw value.
        private static readonly System.Text.RegularExpressions.Regex Bare = new System.Text.RegularExpressions.Regex("^(?:true|false|null|-?(?:0|[1-9][0-9]{0,8})(?:\\.[0-9]{1,10})?)$");

        public static Dictionary<string, string> Flat(string text, string type, string[] allowed, out string why)
        {
            why = null;
            Dictionary<string, string> d = new Dictionary<string, string>(StringComparer.Ordinal);
            if (text == null) { why = "empty message"; return null; }
            if (text.IndexOf('\\') >= 0) { why = "message has an escape sequence; ChartBridge's page never sends one"; return null; }
            string t = text.Trim();
            if (t.Length < 2 || t[0] != '{' || t[t.Length - 1] != '}') { why = "message is not one JSON object"; return null; }
            int i = 1;
            while (true)
            {
                i = SkipWs(t, i);
                if (i == t.Length - 1 && d.Count == 0) break;   // {}
                if (t[i] != '"') { why = "message is not one flat JSON object"; return null; }
                int ke = t.IndexOf('"', i + 1);
                if (ke < 0) { why = "message is not one flat JSON object"; return null; }
                string key = t.Substring(i + 1, ke - i - 1);
                i = SkipWs(t, ke + 1);
                if (i >= t.Length || t[i] != ':') { why = "message is not one flat JSON object"; return null; }
                i = SkipWs(t, i + 1);
                if (i >= t.Length - 1) { why = "message is not one flat JSON object"; return null; }
                string raw;
                if (t[i] == '{' || t[i] == '[') { why = "message has an unexpected nested object or list"; return null; }
                if (t[i] == '"')
                {
                    int ve = t.IndexOf('"', i + 1);
                    if (ve < 0) { why = "message is not one flat JSON object"; return null; }
                    raw = t.Substring(i, ve - i + 1);
                    if (raw.Length - 2 > 200 || raw.Any(ch => ch < 0x20 || ch == 0x7f)) { why = "a string value must be plain text of at most 200 characters"; return null; }
                    i = ve + 1;
                }
                else
                {
                    int ve = i;
                    while (ve < t.Length - 1 && t[ve] != ',' && !char.IsWhiteSpace(t[ve])) ve++;
                    raw = t.Substring(i, ve - i);
                    if (!Bare.IsMatch(raw)) { why = "value of \"" + key + "\" is not a plain value"; return null; }
                    i = ve;
                }
                if (Array.IndexOf(allowed, key) < 0) { why = "unknown key \"" + key + "\" in " + type; return null; }
                if (d.ContainsKey(key)) { why = "message has a key twice"; return null; }
                d[key] = raw;
                i = SkipWs(t, i);
                if (i == t.Length - 1) break;
                if (t[i] != ',') { why = "message is not one flat JSON object"; return null; }
                i++;
            }
            if (!d.ContainsKey("type") || d["type"] != "\"" + type + "\"") { why = "type must be \"" + type + "\""; return null; }
            return d;
        }

        private static int SkipWs(string t, int i) { while (i < t.Length && char.IsWhiteSpace(t[i])) i++; return i; }

        // A plain string value, or null when absent or not a string.
        private static string StrOf(Dictionary<string, string> m, string key)
        {
            string raw;
            if (m == null || !m.TryGetValue(key, out raw) || raw.Length < 2 || raw[0] != '"') return null;
            return raw.Substring(1, raw.Length - 2);
        }

        // ---------------------------------------------------------- telling the pages
        private static string Reject(string cid, string reason)
        {
            return "{\"type\":\"reject\"" + (cid != null ? ",\"cid\":" + CbJson.Str(cid) : "") + ",\"reason\":" + CbJson.Str(reason) + "}";
        }

        private static string Status(string level, string text) { return "{\"type\":\"status\",\"level\":\"" + level + "\",\"text\":" + CbJson.Str(text) + "}"; }

        private static void Alarm(string text)
        {
            ChartBridgeServer.Log("ALERT: " + text);
            ChartBridgeServer.SendToTraders(Status("error", text));
        }

        private static void Warn(string text)
        {
            ChartBridgeServer.Log("NOTE: " + text);
            ChartBridgeServer.SendToTraders(Status("warn", text));
        }
    }
}
