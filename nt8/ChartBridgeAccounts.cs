// ChartBridge accounts (protocol v3, ChartBridge 0.4.0). Part of the ChartBridge add-on; install it with the other files.
// See nt8/PROTOCOL.md, "Protocol v3 (ChartBridge 0.4.0)" and its "Accounts" section.
//
// This file never places, changes or cancels an order (no Submit, Change, Cancel or Flatten here). It holds:
//   (the v3 switches, which pages speak v3, and v3's strict messages are in ChartBridgeV3.cs, shared by every v3 lane);
//   - gate 2 with accountChecks on (the default since Anthony's 2026-10-07 decision): the page's per-account checkmark, which ChartBridge saves itself in accounts.txt
//     next to config.txt. First start (no accounts.txt) pre-checks tradeAccounts; afterwards only the checkmarks count.
//     trading = true stays the master switch above every checkmark (ChartBridgeOrders.AccountTradable checks it first);
//   - Gone: an account that is disconnected (after it was connected) or disabled for 10 s without a break is listed Gone and
//     the pages are told; entries wait until it is back. ChartBridge never clears a checkmark (Anthony, 2026-10-07: "I will
//     manage the checkmarks"; 0.4.2): Gone keeps it, and NinjaTrader's trailing drawdown never makes an account Gone (it is
//     shown in the Room column only). History is kept (nothing is deleted); every change is one Output line and one
//     accounts.log line;
//   - 0.5.1, connected accounts only: an account is watched and listed once it has been seen Connected in this NinjaTrader
//     session (since NinjaTrader's process started, so an F5 keeps it); one that never connected this session is never
//     watched, listed or written. A new one starts unchecked. Once seen, a drop leaves it listed Gone as before. Hide
//     (accountArchive with the page's confirm) for any flat account that is not the bot's, a copier leader or follower, or
//     an agent's; it stays archived until Show (accountUnarchive), which brings it back unchecked. An archived account that
//     NinjaTrader shows with a position or working orders is listed again at once (unchecked), so archiving never strands
//     an exit. Plain off records not seen Connected for 30 days are forgotten (trade and archived never are). The retired
//     "accounts =" line is read once (the first 0.5.1 run): every account seen Connected in the first 5 minutes that it does
//     not name, and that is not checked, is hidden. An account that becomes listed reaches signed-in pages at once (its
//     orders and positions), and is watched from the 1 s check that first sees it Connected. The last time each account was seen Connected and the conversion marker are in
//     accounts-detail.txt, a file of its own: accounts.txt keeps the exact 0.5.0 format, because 0.5.0's reader (and
//     0.4.x's) refuses the whole file for any line that is not <state> <time> <name>, a 4th field or a comment included;
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
using System.Text;
using System.Threading;
using NinjaTrader.Cbi;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    // ------------------------------------------------------------------ accounts, the checkmark and Gone
    public static class ChartBridgeAccounts
    {
        public const double GraceMs = 10000;   // "Gone ... for 10 s without a break (the grace)"
        public const int TickMs = 1000;        // the check and the money in "accounts": at most once a second
        public const string Header = "# ChartBridge accounts (written by ChartBridge; do not edit)";
        public const string ReadFailedText = "accounts.txt could not be read: trading is off for every account until it can";
        public const double PruneMs = 30.0 * 24 * 3600 * 1000;   // 0.5.1: a plain off record not seen Connected for 30 days is forgotten
        public const double PruneEveryMs = 3600000;               // checked once an hour (and at the first check)
        public const double SeenWriteMs = 3600000;                // the last-connected time is saved at most once an hour per account
        public const double ConvertWindowMs = 300000;             // 0.5.1: the accounts line's conversion covers the first 5 minutes after the start
        public const string DetailHeader = "# ChartBridge account details (written by ChartBridge; do not edit)";

        public static bool On { get { return ChartBridgeV3.AccountChecks; } }
        public static bool CancelFromListOn { get { return ChartBridgeV3.CancelFromList; } }

        private static string FilePath { get { return Path.Combine(ChartBridgeConfig.Folder, "accounts.txt"); } }
        private static string LogPath { get { return Path.Combine(ChartBridgeConfig.Folder, "accounts.log"); } }
        private static string DetailPath { get { return Path.Combine(ChartBridgeConfig.Folder, "accounts-detail.txt"); } }

        // ---------------------------------------------------------- memory (Mem: never held during file I/O or a NinjaTrader call)
        private static readonly object Mem = new object();
        private static readonly object FileLock = new object();   // one write of accounts.txt or accounts.log at a time

        private class Rec { public string Name; public string State; public long ChangedMs; }   // State: trade, off or archived
        private class Live
        {
            public double BadSince = -1; public bool Gone; public string GoneWhy; public long GoneSince;
            public bool Busy;   // 0.5.1: last seen with a position or working orders (for Hide while NinjaTrader does not list it)
        }

        private static readonly Dictionary<string, Rec> Recs = new Dictionary<string, Rec>(StringComparer.OrdinalIgnoreCase);
        private static readonly Dictionary<string, Live> Lives = new Dictionary<string, Live>(StringComparer.OrdinalIgnoreCase);
        // 0.5.1 (accounts-detail.txt): when each account was last seen Connected (UTC ms), and when the accounts line was converted.
        private static readonly Dictionary<string, double> ConnectedAt = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        private static readonly Dictionary<string, string> ConnectedSession = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);   // the NinjaTrader session that saw it
        private static readonly HashSet<string> Converted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);   // looked at by this run's conversion
        private static readonly Dictionary<string, string> ConvertUnsure = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);   // a file could not be read: tried again
        private static bool detailDirty;     // memory differs from accounts-detail.txt
        private static bool detailSaveFailed;   // the last save of accounts-detail.txt failed (said once)
        private static bool detailReadError; // accounts-detail.txt exists but could not be read: never rewritten this run
        private static bool offMarkPending;  // accountChecks off with an accounts line: the conversion marker is written once (never converted later)
        private static double convertedMs = -1;   // the accounts line was converted then (-1: never)
        private static bool converting;      // this run hides the accounts the old accounts line does not name, until convertUntilMs
        private static double convertUntilMs;
        private static double lastPruneMs = -1;
        // 0.5.1: this NinjaTrader session: its process id and start (SessionId) and the start in UTC ms (SessionStartMs, used when
        // the id cannot be read or a saved time has none). An account saved as seen Connected by this session counts as seen after
        // an F5. Public for the harness, which sets them to stand for a new session.
        public static double SessionStartMs;
        public static string SessionId;
        private static readonly object ListedLock = new object();
        private static readonly HashSet<string> ListedBefore = new HashSet<string>(StringComparer.OrdinalIgnoreCase);   // listed at the last look (TellNewlyListed)
        private static readonly Dictionary<string, string> StatusText = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);   // AccountStatusUpdate
        private static readonly HashSet<string> DrawdownSeen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);   // a non-zero trailing drawdown seen this run
        private static readonly HashSet<string> EverConnected = new HashSet<string>(StringComparer.OrdinalIgnoreCase);  // seen Connected this run (lead's default: only these can go Gone by disconnecting)
        private static readonly List<string[]> PendingLog = new List<string[]>();   // accounts.log lines not written yet (Mem)
        private static bool loaded;          // accounts.txt read, or made on a first start, this run
        private static string readError;     // accounts.txt exists but could not be read: every checkmark off, never rewritten this run
        private static string startAlarm;    // said to each page as it signs in (a status error)
        private static bool dirty;           // memory differs from accounts.txt
        private static string saveError;     // the last save failed (an alarm was raised once)
        private static string lastAccountsJson;

        private static Timer timer;
        private static int ticking;

        private static bool IsV3(ChartBridgeClient c) { return ChartBridgeV3.IsV3(c); }

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
            FinalSave();   // 0.5.1: what is in memory (a first connected time, a log line) is not lost at a stop
            Clear();
        }

        public const int StopSaveWaitMs = 200;

        // 0.5.1: the last save at a stop, on the thread that stops ChartBridge (NinjaTrader's at an F5), so it waits at most
        // StopSaveWaitMs for a save already under way; if that one does not finish in time this save is skipped with an Output
        // line (the next start reads both files again; at most the last second's connected times and log lines are lost).
        private static void FinalSave()
        {
            bool got = false;
            try
            {
                got = Monitor.TryEnter(FileLock, StopSaveWaitMs);
                if (!got) { ChartBridgeServer.Log("accounts: a save was under way at the stop; the last save is skipped (the next start reads the files again)"); return; }
                Save();
                FlushLog();
            }
            catch (Exception ex) { ChartBridgeServer.Log("accounts: the last save at the stop failed (" + ex.Message + ")"); }
            finally { if (got) Monitor.Exit(FileLock); }
        }

        public static void Clear()
        {
            lock (Mem)
            {
                Recs.Clear(); Lives.Clear(); ConnectedAt.Clear(); ConnectedSession.Clear(); Converted.Clear(); ConvertUnsure.Clear(); StatusText.Clear(); DrawdownSeen.Clear(); EverConnected.Clear(); PendingLog.Clear();
                loaded = false; readError = null; startAlarm = null; dirty = false; detailDirty = false; detailSaveFailed = false; detailReadError = false; offMarkPending = false; saveError = null; lastAccountsJson = null;
                convertedMs = -1; converting = false; convertUntilMs = 0; lastPruneMs = -1;
            }
            lock (ListedLock) ListedBefore.Clear();
        }

        // Reads accounts.txt (accountChecks on only). Public for the harness, which runs it on its own thread.
        public static void StartNow(double now)
        {
            Clear();
            SessionStartMs = SessionStart(now);
            SessionId = ProcessSession();
            if (!On) { OldAccountsNote(now, false); return; }
            string path = FilePath;
            if (!File.Exists(path)) { NoFile(now); AfterRead(now); return; }
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
            AfterRead(now);
        }

        // 0.5.1: accounts-detail.txt and the old accounts line, once accounts.txt is read (or made on a first start).
        private static void AfterRead(double now)
        {
            bool ok;
            lock (Mem) ok = loaded && readError == null;
            if (ok) LoadDetails();
            OldAccountsNote(now, ok);
        }

        // NinjaTrader's process start (this NinjaTrader session), UTC ms; now when it cannot be read.
        private static double SessionStart(double now)
        {
            try
            {
                DateTime st = System.Diagnostics.Process.GetCurrentProcess().StartTime.ToUniversalTime();
                double ms = (st - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                return ms > 0 && ms <= now ? ms : now;
            }
            catch (Exception) { return now; }
        }

        // This NinjaTrader process: its id and start ticks, or null when they cannot be read (then times decide).
        private static string ProcessSession()
        {
            try
            {
                System.Diagnostics.Process p = System.Diagnostics.Process.GetCurrentProcess();
                return p.Id.ToString(CultureInfo.InvariantCulture) + "-" + p.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
            }
            catch (Exception) { return null; }
        }

        // 0.5.1, the retired accounts line in config.txt. The first run with it converts it: no accounts-detail.txt yet (any
        // 0.5.1 run writes one) and no "converted" line in accounts.log. Every account seen Connected in the first ConvertWindowMs
        // after the start that it does not name and that is not checked is hidden once (Convert). If either file cannot be read,
        // nothing is converted (ChartBridge cannot tell). With accountChecks off the line is ignored and the marker is written,
        // so a later run never converts it. Afterwards it is ignored, said once at start.
        private static void OldAccountsNote(double now, bool canConvert)
        {
            if (ChartBridgeConfig.OldAccounts == null) return;
            string why = null;
            bool detailThere;
            try { detailThere = File.Exists(DetailPath); } catch (Exception) { detailThere = true; }
            if (!On) why = "accountChecks is off";
            else if (!canConvert) why = "accounts.txt could not be read";
            else if (detailThere) why = "";
            else
            {
                string log = LogConverted();
                if (log == "yes") why = "";
                else if (log != "no") why = "accounts.log could not be read (" + log + "), so ChartBridge cannot tell whether it was converted before";
            }
            if (why != null)
            {
                if (!On) lock (Mem) offMarkPending = true;
                ChartBridgeServer.Log("config.txt: the accounts line is ignored since ChartBridge 0.5.1" + (why.Length > 0 ? " (" + why + ")" : "") + ": the Account tab lists the accounts connected in NinjaTrader (Hide on the Account tab removes one); the line can go");
                return;
            }
            lock (Mem) { converting = true; convertedMs = now; convertUntilMs = now + ConvertWindowMs; detailDirty = true; }
            ChartBridgeServer.Log("config.txt: the accounts line is read once now (ChartBridge 0.5.1): for the next 5 minutes an account that connects, is not on it and is not checked is hidden (Show on the Account tab brings it back); after that the line is ignored and can go");
            NoteChange("(all)", "converted", "the accounts line in config.txt: connected accounts it does not name are hidden for 5 minutes");
        }

        // "yes" when accounts.log has the conversion's line, "no" when it does not (or there is no log), else why it cannot be read.
        private static string LogConverted()
        {
            string err = null;
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    if (!File.Exists(LogPath)) return "no";
                    foreach (string l in ReadShared(LogPath)) if (l.Contains("\t(all)\tconverted\t")) return "yes";
                    return "no";
                }
                catch (Exception ex) { err = ex.Message; if (attempt < 2) Thread.Sleep(100); }
            }
            return err ?? "unknown";
        }

        // A whole text file, opened so that ChartBridge or another lane may replace or delete it meanwhile (File.Replace).
        public static Func<string, string> ReadFault;   // test hook: a non-null answer for a file name fails its read (unused in NinjaTrader)

        private static string[] ReadShared(string path)
        {
            Func<string, string> fault = ReadFault;
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

        // 0.5.1: accounts-detail.txt, a header, then "connected\t<UTC ms>\t<account name>[\t<session>]" (when it was last seen
        // Connected, and by which NinjaTrader session: its process id and start) and "converted\t<UTC ms>" (the accounts line was
        // converted) lines. A line ChartBridge does not understand is skipped. A file that cannot be read (three tries, as
        // accounts.txt) is never rewritten that run: accounts are listed as they connect, and an off record's age is taken from
        // accounts.txt's changed time.
        private static void LoadDetails()
        {
            string path = DetailPath;
            if (!File.Exists(path)) return;
            string[] lines = null;
            string err = null;
            for (int attempt = 0; attempt < 3 && lines == null; attempt++)
            {
                try { lines = ReadShared(path); err = null; }
                catch (Exception ex) { err = ex.Message; if (attempt < 2) Thread.Sleep(100); }
            }
            if (lines == null)
            {
                lock (Mem) detailReadError = true;
                ChartBridgeServer.Log("accounts-detail.txt could not be read (" + err + "): it is not rewritten this run; accounts are listed as they connect");
                return;
            }
            lock (Mem)
            {
                if (lines.Length == 0 || lines[0].TrimEnd('\r') != DetailHeader) { detailDirty = true; return; }
                for (int i = 1; i < lines.Length; i++)
                {
                    string[] p = lines[i].TrimEnd('\r').Split('\t');
                    double ms;
                    if (p.Length < 2 || !double.TryParse(p[1], NumberStyles.None, CultureInfo.InvariantCulture, out ms)) continue;
                    if (p[0] == "converted" && p.Length == 2) convertedMs = ms;
                    else if (p[0] == "connected" && (p.Length == 3 || p.Length == 4) && p[2].Trim().Length > 0 && !ChartBridgeOrders.IsNeverTradable(p[2]))
                    {
                        ConnectedAt[p[2]] = ms;
                        if (p.Length == 4 && p[3].Length > 0) ConnectedSession[p[2]] = p[3]; else ConnectedSession.Remove(p[2]);
                    }
                }
            }
        }

        // 0.5.1: seen Connected in this NinjaTrader session: this run, or by accounts-detail.txt (the same NinjaTrader process when
        // the saved line says which, else a time at or after NinjaTrader's start).
        private static bool SeenThisSession(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            lock (Mem)
            {
                if (EverConnected.Contains(name)) return true;
                double ms;
                if (!ConnectedAt.TryGetValue(name, out ms)) return false;
                string sid;
                if (SessionId != null && ConnectedSession.TryGetValue(name, out sid)) return sid == SessionId;
                return ms >= SessionStartMs;
            }
        }

        // 0.5.1: an account Connected now is marked seen (and its time kept, saved at most once an hour); then whether it has been
        // seen this session. For ChartBridgeServer.WatchAccounts (the fills) and the lists. Never Backtest or Playback.
        public static bool SeenConnected(Account a)
        {
            if (a == null || string.IsNullOrEmpty(a.Name) || ChartBridgeOrders.IsNeverTradable(a.Name)) return false;
            if (ConnectionText(a) == "connected") MarkSeen(a.Name, ChartBridgeTime.NowUtcMs());
            return SeenThisSession(a.Name);
        }

        // Returns true the first time this run (the 1 s check then starts watching it).
        private static bool MarkSeen(string name, double now)
        {
            lock (Mem)
            {
                bool first = EverConnected.Add(name);
                if (!On || !loaded || readError != null) return first;
                double was;
                string sid;
                bool had = ConnectedAt.TryGetValue(name, out was), hasSid = ConnectedSession.TryGetValue(name, out sid);
                bool same = had && (SessionId != null ? hasSid && sid == SessionId : was >= SessionStartMs);
                if (same && now <= was) return first;
                ConnectedAt[name] = had ? Math.Max(was, now) : now;   // a clock set back never moves it back
                if (SessionId != null) ConnectedSession[name] = SessionId; else ConnectedSession.Remove(name);
                if (!same || now - was >= SeenWriteMs) detailDirty = true;
                return first;
            }
        }

        // ---------------------------------------------------------- gate 2 (asked by ChartBridgeOrders.cs only when accountChecks is on)
        // Gate 2 for entries: the checkmark on, accounts.txt read, and not Gone. Gone keeps the checkmark (0.4.2), so a Gone
        // account takes no entry until it is back; then it trades again with its checkmark.
        // The saved checkmark alone (accounts.txt), Gone or not: the "trade" field (0.4.2).
        private static bool SavedChecked(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            lock (Mem) { Rec r; return loaded && readError == null && Recs.TryGetValue(name, out r) && r.State == "trade"; }
        }

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

        // Integration: Gone for the copier (ChartBridgeCopier.IsGone skips a Gone follower); false with accountChecks off (no
        // account goes Gone then, as 0.3.8).
        public static bool IsGone(Account a) { string why; return a != null && Gone(a.Name, out why); }

        // Why an entry on this account is refused (gate 2 with the checkmark), for ChartBridgeOrders.FindAccount.
        public static string EntryRefusal(string name)
        {
            string label = string.IsNullOrEmpty(name) ? "(none)" : name, gw;
            if (string.IsNullOrEmpty(name) || ChartBridgeOrders.IsNeverTradable(name)) return "account " + label + " may not trade from the chart (never Backtest or Playback)";
            lock (Mem) { if (readError != null) return ReadFailedText; if (!loaded) return "ChartBridge is still reading accounts.txt; try again in a moment"; }
            if (Archived(name)) return "account " + name + " is archived";
            if (Gone(name, out gw)) return "account " + name + " is gone (" + gw + "): entries wait until it is back (its checkmark is kept)";
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
            if (!CancelFromListOn) return "Cancel from the Working orders tab is off (cancelFromList = off in config.txt)";
            return null;
        }

        // The names gate 2 allows for entries, for the trading message (with accountChecks off: tradeAccounts, as in v2).
        public static List<string> CheckedNames()
        {
            List<string> names = new List<string>();
            lock (Mem) { if (!loaded || readError != null) return names; names.AddRange(Recs.Values.Where(r => r.State == "trade").Select(r => r.Name)); }
            return names.Where(n => Checked(n) && SeenThisSession(n)).OrderBy(n => n, StringComparer.OrdinalIgnoreCase).ToList();   // 0.5.1: connected this session
        }

        // ---------------------------------------------------------- what a page sees (v3: every watched account; v2: v2's scope)
        // A watched, non-archived account: in the accounts list and in a v3 page's orders and positions. 0.5.1: seen Connected this
        // NinjaTrader session (memory only: NinjaTrader's thread may ask).
        public static bool Listed(string name)
        {
            return !string.IsNullOrEmpty(name) && !ChartBridgeOrders.IsNeverTradable(name) && !Archived(name) && SeenThisSession(name);
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
            foreach (Account a in all) SeenConnected(a);   // 0.5.1: one that connected since the last check counts now (the page's thread)
            return all.Where(a => v3 ? Listed(a.Name) : ChartBridgeOrders.AccountTradable(a.Name)).ToList();
        }

        // Gate 2 for entries right now (the "tradable" flag): the checkmark (or tradeAccounts) and the master switch, Connected.
        private static bool TradableNow(string name, string connection) { return ChartBridgeOrders.AccountTradable(name) && connection == "connected"; }

        // An order message as a page should get it: a v3 page also gets "tradable" (gate 2 for entries now, Gone included) and
        // (review 2 finding 9) "by" for a bot or copier order (ChartBridgeV3.OrderBy; o null: none).
        public static string ForPage(ChartBridgeClient c, Account a, string orderJson, Order o = null)
        {
            if (!IsV3(c) || a == null || !orderJson.EndsWith("}", StringComparison.Ordinal)) return orderJson;
            string gw, by = orderJson.Contains(",\"by\":") ? "" : ChartBridgeV3.OrderBy(o);
            bool tradable = !Gone(a.Name, out gw) && TradableNow(a.Name, ConnectionText(a));
            return orderJson.Substring(0, orderJson.Length - 1) + by + ",\"tradable\":" + (tradable ? "true" : "false") + "}";
        }

        // A live order or position message: to every signed-in page that sees the account (NinjaTrader's thread: no lookups).
        public static void SendScoped(Account a, string json, bool isOrder, Order o = null)
        {
            string account = a.Name;
            bool tradable = ChartBridgeOrders.AccountTradable(account), listed = Listed(account);
            string v3json = null;
            foreach (ChartBridgeClient c in ChartBridgeServer.AllClients())
            {
                if (!c.Trader) continue;
                if (IsV3(c)) { if (listed) c.Send(isOrder ? (v3json ?? (v3json = ForPage(c, a, json, o))) : json); }
                else if (tradable) c.Send(json);
            }
        }

        // The trading message for this page: a signed-in v3 page also gets the switches.
        public static string TradingFor(ChartBridgeClient c, string tradingJson)
        {
            if (!IsV3(c) || !c.Trader || !tradingJson.EndsWith("}", StringComparison.Ordinal)) return tradingJson;
            return tradingJson.Substring(0, tradingJson.Length - 1) + ",\"switches\":" + ChartBridgeV3.SwitchesJson() + "}";
        }

        // After a page signs in: the accounts.txt alarm, if there is one.
        public static void SignedIn(ChartBridgeClient c)
        {
            string alarm;
            lock (Mem) alarm = startAlarm;
            if (alarm != null) c.Send(Status("error", alarm));
        }

        // ---------------------------------------------------------- messages from the page
        // client (no sign-in needed), accountTrade, accountArchive (Hide), accountUnarchive (Show, 0.5.1) (gates 1, 4 and 7 first,
        // then strict keys, then the switch).
        public static void OnMessage(ChartBridgeClient client, string type, string text)
        {
            string cid = null;
            try
            {
                if (type == "client") { OnClient(client, text); return; }
                string why = ChartBridgeV3.Gate(client);
                Dictionary<string, string> m = null;
                string[] keys = type == "accountTrade" ? new[] { "type", "cid", "account", "on" } : type == "accountUnarchive" ? new[] { "type", "cid", "account" } : new[] { "type", "cid", "account", "confirm" };
                if (why == null) m = ChartBridgeV3.Flat(text, type, keys, out why);
                if (m != null) cid = ChartBridgeV3.Str(m, "cid");
                if (why == null && m.ContainsKey("cid") && cid == null) why = "cid must be a plain string";
                if (why == null && !On) why = type + " is off (accountChecks = off in config.txt)";
                if (why == null) why = type == "accountTrade" ? AccountTrade(m) : type == "accountUnarchive" ? AccountUnarchive(m) : AccountArchive(m);
                if (why != null) client.Send(Reject(cid, why));
            }
            catch (Exception ex)
            {
                ChartBridgeServer.Log("accounts error: " + ex.Message);
                client.Send(Reject(cid, "ChartBridge error: " + ex.Message));
            }
        }

        // {"type":"client","v":3} (ChartBridgeV3.OnClient marks the page); then the accounts list, to ChartBridge's own page only.
        private static void OnClient(ChartBridgeClient client, string text)
        {
            if (!ChartBridgeV3.OnClient(client, text)) return;
            if (ChartBridgeOrders.OriginAllowed(client.Origin)) client.Send(AccountsJson(Snapshot(), ChartBridgeTime.NowUtcMs()));   // signed in or not
            ChartBridgeV3.TellLanes(client);   // integration: a page that signed in before its client message gets each lane's v3 state now
        }

        private static string AccountTrade(Dictionary<string, string> m)
        {
            string name = ChartBridgeV3.Str(m, "account"), on = m.ContainsKey("on") ? m["on"] : null;
            if (name == null) return "accountTrade needs account (a plain string)";
            if (on != "true" && on != "false") return "on must be true or false";
            double now = ChartBridgeTime.NowUtcMs();
            if (on == "false") return Uncheck(name, now);
            // On is refused for an account that is Gone, archived, not Connected, Backtest or Playback (a Gone account keeps
            // whatever checkmark it had; 0.4.2).
            if (ChartBridgeOrders.IsNeverTradable(name)) return name + " can never trade (Backtest and Playback)";
            lock (Mem) if (readError != null) return ReadFailedText + "; nothing was changed";
            Account a = Find(name);
            if (a == null && !Known(name)) return "no account " + name;
            if (a != null) name = a.Name;
            string gw;
            if (Archived(name)) return name + " is archived (hidden); Show it first, it comes back unchecked";
            if (Gone(name, out gw)) return name + " is gone (" + gw + "); it can be checked once it is back";
            string status = a != null ? StatusOf(a) : "not in NinjaTrader";
            if (status != "Connected") return name + " is not connected (" + status + ")";
            if (!SetStateIf(name, "trade", now, st => st != "archived")) return name + " is archived (hidden); Show it first, it comes back unchecked";   // hidden meanwhile
            NoteChange(name, "checked", "by the page");
            AfterCheckmark();
            return null;
        }

        // Off is always accepted (signed in): nothing to change for an account that is unknown, archived, or already off.
        private static string Uncheck(string name, double now)
        {
            Rec r;
            bool ok;
            lock (Mem) { ok = readError == null; if (Recs.TryGetValue(name, out r)) name = r.Name; }
            if (ok && SetStateIf(name, "off", now, st => st == "trade")) NoteChange(name, "unchecked", "by the page");
            AfterCheckmark();
            return null;
        }

        // Hide (0.5.1): accepted for any account, Gone or not, that is flat with no working orders (as NinjaTrader shows it now, or
        // as ChartBridge last saw it when NinjaTrader does not list it) and is not the bot's, a copier leader or follower, or an
        // agent's. A hidden account stays archived, in NinjaTrader and healthy or not, until Show (accountUnarchive).
        private static string AccountArchive(Dictionary<string, string> m)
        {
            string name = ChartBridgeV3.Str(m, "account"), confirm = m.ContainsKey("confirm") ? m["confirm"] : null;
            if (name == null) return "accountArchive needs account (a plain string)";
            if (confirm != "true") return "Archive needs confirm: true (the page asks Anthony first)";
            lock (Mem) if (readError != null) return ReadFailedText + "; nothing was changed";
            if (ChartBridgeOrders.IsNeverTradable(name)) return name + " is never listed (Backtest and Playback)";
            Account a = Find(name);
            if (a != null) name = a.Name;
            else lock (Mem) { Rec r; if (Recs.TryGetValue(name, out r)) name = r.Name; }
            if (Archived(name)) return name + " is archived already";
            if (a == null && !Known(name)) return "no account " + name;
            bool unsure;
            string why = HideRefusal(name, a, ReadClaims(), out unsure);
            if (why != null) return why;
            double now = ChartBridgeTime.NowUtcMs();
            if (!SetStateIf(name, "archived", now, st => st != "archived")) return name + " is archived already";
            NoteChange(name, "archived", "by the page");
            AfterCheckmark();
            return null;
        }

        // Show (0.5.1): an archived account back, active and unchecked. It is listed once it has been seen Connected this session.
        private static string AccountUnarchive(Dictionary<string, string> m)
        {
            string name = ChartBridgeV3.Str(m, "account");
            if (name == null) return "accountUnarchive needs account (a plain string)";
            lock (Mem) if (readError != null) return ReadFailedText + "; nothing was changed";
            Account a = Find(name);
            lock (Mem) { Rec r; if (Recs.TryGetValue(name, out r)) name = r.Name; else if (a != null) name = a.Name; }
            if (!Archived(name)) return Known(name) || a != null ? name + " is not archived" : "no account " + name;
            double now = ChartBridgeTime.NowUtcMs();
            if (!SetStateIf(name, "off", now, st => st == "archived")) return name + " is not archived";
            lock (Mem)
            {
                Live l;
                if (Lives.TryGetValue(name, out l)) { l.Gone = false; l.GoneWhy = null; l.GoneSince = 0; l.BadSince = -1; }
            }
            NoteChange(name, "shown", "by the page; unchecked");
            AfterCheckmark();
            return null;
        }

        // Why this account may not be hidden now, or null. unsure: a file could not be read (it may be fine a moment later).
        private static string HideRefusal(string name, Account a, Claims claims, out bool unsure)
        {
            unsure = false;
            if (a != null ? Busy(a) : LastSeen(name) == "busy")
                return name + (a != null ? " has" : " was last seen with") + " a position or working orders: only a flat account can be hidden (exits always work)";
            string claim = claims.Why(name, out unsure);
            return claim != null ? claim + ": it cannot be hidden" : null;
        }

        private static string LastSeen(string name) { lock (Mem) { Live l; return Lives.TryGetValue(name, out l) && l.Busy ? "busy" : null; } }

        // A position on any instrument or any order not filled, cancelled or rejected. Unreadable: busy (the safe side).
        private static bool Busy(Account a)
        {
            try
            {
                List<Position> ps;
                lock (a.Positions) ps = a.Positions.ToList();
                foreach (Position p in ps) if (p != null && p.MarketPosition != MarketPosition.Flat && p.Quantity != 0) return true;
                List<Order> os;
                lock (a.Orders) os = a.Orders.ToList();
                foreach (Order o in os) if (o != null && o.OrderState != OrderState.Filled && o.OrderState != OrderState.Cancelled && o.OrderState != OrderState.Rejected) return true;
                return false;
            }
            catch (Exception) { return true; }
        }

        // Whose accounts are taken, for Hide and the conversion: the bot's (on: its memory; off: bot-account.txt, Sim101 when
        // there is none), a copier leader or follower (on: its memory; off: copier.txt), an agent's chosen account (the agent
        // channel's memory, and every agent-<id>-account.txt, on or off). Read once per check (a page action reads its own) from
        // copies kept by each file's time stamp; a file is opened so its owner can replace it meanwhile. A file that cannot be
        // read or understood counts against every account (ChartBridge cannot tell) and is read again next time.
        private sealed class Claims
        {
            public string Bot, BotError, CopierError, AgentError;
            public bool CopierOn;
            public readonly HashSet<string> Leader = new HashSet<string>(StringComparer.OrdinalIgnoreCase), Followers = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            public readonly Dictionary<string, string> Agent = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);   // account to agent id

            public string Why(string name, out bool unsure)
            {
                unsure = true;
                if (BotError != null) return BotError + ", so ChartBridge cannot tell whether " + name + " is the bot's account";
                unsure = false;
                if (Bot != null && Bot.Equals(name, StringComparison.OrdinalIgnoreCase)) return name + " is the bot's account (the Bot tab)";
                if (CopierOn)
                {
                    string r = ChartBridgeCopier.AgentAccountRefusal(name);   // the copier's memory
                    if (r != null) { unsure = r.StartsWith("copier.txt could not be read", StringComparison.Ordinal); return r; }
                }
                else
                {
                    if (CopierError != null) { unsure = true; return CopierError + ", so ChartBridge cannot tell whether " + name + " is the copier's"; }
                    if (Leader.Contains(name)) return name + " is the copier's leader";
                    if (Followers.Contains(name)) return name + " is a copier follower";
                }
                string id = ChartBridgeAgents.AgentOfAccount(name);
                if (id != null || Agent.TryGetValue(name, out id)) return name + " is agent " + id + "'s account (the Agent tab)";
                if (AgentError != null) { unsure = true; return AgentError + ", so ChartBridge cannot tell whether " + name + " is an agent's account"; }
                return null;
            }
        }

        private sealed class FileCopy { public DateTime Stamp; public long Length; public string[] Lines; }
        private static readonly object CopyLock = new object();
        private static readonly Dictionary<string, FileCopy> Copies = new Dictionary<string, FileCopy>(StringComparer.OrdinalIgnoreCase);
        private static DateTime agentDirStamp = DateTime.MinValue;
        private static string[] agentFiles;

        // A file's lines, read again only when its time stamp or length changed; null when there is no file. Throws when it
        // cannot be read (nothing kept: read again next time).
        private static string[] Cached(string path)
        {
            FileInfo fi = new FileInfo(path);
            if (!fi.Exists) { lock (CopyLock) Copies.Remove(path); return null; }
            DateTime stamp = fi.LastWriteTimeUtc;
            long length = fi.Length;
            lock (CopyLock) { FileCopy c; if (Copies.TryGetValue(path, out c) && c.Stamp == stamp && c.Length == length) return c.Lines; }
            string[] lines = ReadShared(path);
            lock (CopyLock) Copies[path] = new FileCopy { Stamp = stamp, Length = length, Lines = lines };
            return lines;
        }

        // "account<TAB>name" after # lines (bot-account.txt and agent-<id>-account.txt), or null when not understood.
        private static string AccountLine(string[] lines)
        {
            string found = null;
            foreach (string raw in lines)
            {
                string line = raw.Trim();
                if (line.Length == 0 || line.StartsWith("#")) continue;
                string[] p = line.Split('\t');
                if (found == null && p.Length == 2 && p[0] == "account" && p[1].Length > 0) found = p[1];
                else return null;
            }
            return found;
        }

        private static Claims ReadClaims()
        {
            Claims c = new Claims();
            string folder = ChartBridgeConfig.Folder;
            if (ChartBridgeBot.Enabled) c.Bot = ChartBridgeBot.BotAccount;
            else
            {
                try
                {
                    string[] lines = Cached(Path.Combine(folder, "bot-account.txt"));
                    c.Bot = lines == null ? ChartBridgeBot.DefaultAccount : AccountLine(lines);
                    if (c.Bot == null) c.BotError = "bot-account.txt cannot be understood";
                }
                catch (Exception ex) { c.BotError = "bot-account.txt could not be read (" + ex.Message + ")"; }
            }
            c.CopierOn = ChartBridgeCopier.Enabled;
            if (!c.CopierOn)
            {
                try
                {
                    string[] lines = Cached(Path.Combine(folder, "copier.txt"));
                    if (lines != null)
                        foreach (string raw in lines)
                        {
                            string[] p = raw.Split('\t');
                            if (p.Length == 2 && p[0] == "leader" && p[1].Length > 0) c.Leader.Add(p[1]);
                            else if (p.Length == 6 && p[0] == "follower" && p[1].Length > 0) c.Followers.Add(p[1]);
                        }
                }
                catch (Exception ex) { c.CopierError = "copier.txt could not be read (" + ex.Message + ")"; }
            }
            try
            {
                string[] files = null;
                if (Directory.Exists(folder))
                {
                    DateTime ds = Directory.GetLastWriteTimeUtc(folder);
                    lock (CopyLock) { if (agentFiles != null && ds == agentDirStamp) files = agentFiles; }
                    if (files == null)
                    {
                        files = Directory.GetFiles(folder, "agent-*-account.txt");
                        lock (CopyLock) { agentFiles = files; agentDirStamp = ds; }
                    }
                }
                foreach (string f in files ?? new string[0])
                {
                    string file = Path.GetFileName(f), id = file.Substring(6, file.Length - 6 - "-account.txt".Length);
                    string[] lines;
                    try { lines = Cached(f); }
                    catch (Exception ex) { c.AgentError = file + " could not be read (" + ex.Message + ")"; continue; }
                    if (lines == null) continue;   // deleted since the listing
                    string acct = AccountLine(lines);
                    if (acct == null) { c.AgentError = file + " cannot be understood"; continue; }
                    if (!c.Agent.ContainsKey(acct)) c.Agent[acct] = id;
                }
            }
            catch (Exception ex) { c.AgentError = "the agent account files could not be listed (" + ex.Message + ")"; }
            return c;
        }

        private static bool Known(string name) { lock (Mem) return Recs.ContainsKey(name) || Lives.ContainsKey(name); }

        // 0.5.1: the state changes only if it still is what the caller expects (checked under the lock), so a change made by
        // another thread in between is never overwritten. A new record for an account with a connected time saves that too.
        private static bool SetStateIf(string name, string state, double now, Func<string, bool> expected)
        {
            lock (Mem)
            {
                Rec r;
                bool had = Recs.TryGetValue(name, out r);
                if (!expected(had ? r.State : null)) return false;
                if (!had) { Recs[name] = r = new Rec { Name = name }; if (ConnectedAt.ContainsKey(name)) detailDirty = true; }
                r.State = state; r.ChangedMs = (long)now; dirty = true;
                return true;
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
            TellNewlyListed();
        }

        // 0.5.1: an account that became listed (its first sighting, Show, or back from the archive) since the last look: every
        // signed-in v3 page gets that account's working orders (one order message each, never a full list: see SendScopeAgain)
        // and its positions (it got none while the account was not listed).
        private static void TellNewlyListed()
        {
            List<Account> all = Snapshot();
            HashSet<string> fresh = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            lock (ListedLock)
            {
                HashSet<string> now = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (Account a in all) if (Listed(a.Name)) now.Add(a.Name);
                foreach (string n in now) if (!ListedBefore.Contains(n)) fresh.Add(n);
                ListedBefore.Clear(); ListedBefore.UnionWith(now);
            }
            if (fresh.Count == 0) return;
            foreach (ChartBridgeClient c in ChartBridgeServer.AllClients())
                if (c.Trader && IsV3(c)) ChartBridgeOrders.SendScopeAgain(c, fresh);
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
                foreach (Account a in all)   // 0.5.1: seen Connected; watched (fills, order and position events) from its first sighting
                    if (a.Name != null && !ChartBridgeOrders.IsNeverTradable(a.Name) && ConnectionText(a) == "connected")
                    {
                        MarkSeen(a.Name, now);
                        if (!ChartBridgeServer.IsWatched(a)) ChartBridgeServer.EnsureWatched(a);
                    }
                lock (Mem) track = loaded && readError == null;
                if (On && track) changed = Convert(all, now) | Prune(now) | CheckGone(all, now);
                Save();
                FlushLog();
                if (changed) AfterCheckmark();
                else
                {
                    if (AnyV3Page()) SendAccounts(AccountsJson(all, now), false);   // money and positions: at most once a second
                    else lock (Mem) lastAccountsJson = null;
                    TellNewlyListed();
                }
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

        // Every account to list or watch for Gone: 0.5.1, those seen Connected this NinjaTrader session, whether NinjaTrader lists
        // them now or not (an account whose connection is not up is not always in Account.All; it shows as disconnected).
        // Accounts NinjaTrader remembers but never connected this session are never listed, nor written to accounts.txt.
        private static List<string> Names(List<Account> all, bool withArchived)
        {
            HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (Account a in all) if (a.Name != null && !ChartBridgeOrders.IsNeverTradable(a.Name) && SeenThisSession(a.Name)) names.Add(a.Name);
            lock (Mem) foreach (Rec r in Recs.Values) if ((withArchived || r.State != "archived") && SeenThisSession(r.Name)) names.Add(r.Name);
            if (!withArchived) names.RemoveWhere(Archived);
            return names.OrderBy(n => n, StringComparer.OrdinalIgnoreCase).ToList();
        }

        // 0.5.1, the one-time conversion of the old accounts line (OldAccountsNote): until convertUntilMs, each account seen
        // Connected is looked at once; one the line does not name, that is not checked and not archived, is hidden ("hidden:
        // not on the old accounts list", and an info status to the signed-in pages) unless Hide would refuse it (then logged
        // why). One refused only because a file could not be read is tried again each second until the window ends. Returns true
        // when one was hidden.
        private static bool Convert(List<Account> all, double now)
        {
            List<Account> look = new List<Account>();
            List<KeyValuePair<string, string>> unsureLeft = null;
            lock (Mem)
            {
                if (!converting) return false;
                if (now > convertUntilMs)
                {
                    converting = false;
                    unsureLeft = ConvertUnsure.ToList();
                    ConvertUnsure.Clear();
                }
                else
                    foreach (Account a in all)
                    {
                        if (a.Name == null || ChartBridgeOrders.IsNeverTradable(a.Name) || !EverConnected.Contains(a.Name) || Converted.Contains(a.Name)) continue;
                        Rec r;
                        if (ChartBridgeConfig.OnOldAccounts(a.Name) || (Recs.TryGetValue(a.Name, out r) && r.State != "off")) { Converted.Add(a.Name); ConvertUnsure.Remove(a.Name); continue; }   // named, checked or archived already: kept exactly
                        look.Add(a);
                    }
            }
            if (unsureLeft != null)
            {
                foreach (KeyValuePair<string, string> u in unsureLeft) NoteChange(u.Key, "not hidden", "not on the old accounts list, but " + u.Value);
                NoteChange("(all)", "conversion done", "5 minutes after the start: an account that connects from now on is listed as usual");
                return false;
            }
            if (look.Count == 0) return false;
            Claims claims = ReadClaims();   // reads files: outside Mem
            bool changed = false;
            foreach (Account a in look)
            {
                bool unsure;
                string why = HideRefusal(a.Name, a, claims, out unsure);
                if (why != null && unsure) { lock (Mem) ConvertUnsure[a.Name] = why; continue; }   // tried again next second
                lock (Mem) { Converted.Add(a.Name); ConvertUnsure.Remove(a.Name); }
                if (why != null) { NoteChange(a.Name, "not hidden", "not on the old accounts list, but " + why); continue; }
                if (!SetStateIf(a.Name, "archived", now, st => st == null || st == "off")) continue;   // checked or hidden meanwhile
                NoteChange(a.Name, "hidden", "not on the old accounts list");
                Info(a.Name + " was hidden: it is not on the old accounts list in config.txt. Show it from the Hidden list on the Account tab if you want it");
                changed = true;
            }
            return changed;
        }

        // 0.5.1: a plain off record not seen Connected for PruneMs (by accounts-detail.txt, else its changed time in accounts.txt)
        // is forgotten, logged. Never a trade or archived record, never one seen this session. Once an hour.
        private static bool Prune(double now)
        {
            List<string> gone = new List<string>();
            lock (Mem)
            {
                if (lastPruneMs >= 0 && now - lastPruneMs < PruneEveryMs) return false;
                lastPruneMs = now;
                foreach (Rec r in Recs.Values)
                {
                    if (r.State != "off" || EverConnected.Contains(r.Name)) continue;
                    double at;
                    double last = Math.Max(r.ChangedMs, ConnectedAt.TryGetValue(r.Name, out at) ? at : 0);
                    if (last >= SessionStartMs || now - last < PruneMs) continue;
                    gone.Add(r.Name);
                }
                foreach (string n in gone) { Recs.Remove(n); Lives.Remove(n); ConnectedAt.Remove(n); }
                if (gone.Count > 0) { dirty = true; detailDirty = true; }
            }
            foreach (string n in gone) NoteChange(n, "forgotten", "off and not seen connected for 30 days");
            return gone.Count > 0;
        }

        // Gone (PROTOCOL.md "Gone"): disconnected (after it was connected) or disabled for GraceMs without a break. At that
        // moment the pages are told and the change is logged; its checkmark is kept (0.4.2: ChartBridge never clears one) and
        // entries wait. When it comes back healthy it is listed as active again and trades with its checkmark. 0.5.1: only
        // accounts seen Connected this session (Names); an archived one stays archived until Show, except that one NinjaTrader
        // shows with a position or working orders is listed again at once, unchecked (exits need a listed account). Returns
        // true when a state changed.
        private static bool CheckGone(List<Account> all, double now)
        {
            bool changed = false;
            List<string> warn = new List<string>(), back = new List<string>();
            List<string[]> notes = new List<string[]>();   // logged after Mem is released
            foreach (string listed in Names(all, true))
            {
                string name = listed;
                Account a = all.FirstOrDefault(x => x.Name != null && x.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
                string why = BadWhy(name, a);   // NinjaTrader calls, outside Mem
                bool upNow = a != null && ConnectionText(a) == "connected", busy = a != null && Busy(a);
                lock (Mem)
                {
                    Live l;
                    if (!Lives.TryGetValue(name, out l)) Lives[name] = l = new Live();
                    Rec r;
                    if (!Recs.TryGetValue(name, out r)) { Recs[name] = r = new Rec { Name = name, State = "off", ChangedMs = (long)now }; dirty = true; if (ConnectedAt.ContainsKey(name)) detailDirty = true; }   // seen Connected: kept in accounts.txt, unchecked; its connected time saved with it
                    if (a != null) l.Busy = busy;
                    if (r.State == "archived")
                    {
                        if (busy)
                        {
                            r.State = "off"; r.ChangedMs = (long)now; dirty = true; l.Gone = false; l.GoneWhy = null; l.BadSince = -1; changed = true;
                            notes.Add(new[] { name, "back from the archive", "NinjaTrader shows a position or working orders on it; unchecked" });
                            warn.Add(name + " was archived, but NinjaTrader shows a position or working orders on it: it is listed again (unchecked) so its exits work");
                        }
                        continue;
                    }
                    if (why == null)
                    {
                        l.BadSince = -1;
                        if (l.Gone)
                        {
                            l.Gone = false; l.GoneWhy = null; l.GoneSince = 0; changed = true;
                            bool on = r.State == "trade";
                            notes.Add(new[] { name, "active again", on ? "healthy again; checked: entries are taken again" : "healthy again; not checked for trading" });
                            back.Add(name + " is back (" + (upNow ? "connected" : "healthy") + "): " + (on ? "its checkmark is kept, entries are taken again" : "it is not checked for trading"));
                        }
                        continue;
                    }
                    if (l.Gone) continue;
                    if (l.BadSince < 0) { l.BadSince = now; continue; }   // the grace starts with the first bad reading
                    if (now - l.BadSince < GraceMs) continue;
                    l.Gone = true; l.GoneWhy = why; l.GoneSince = (long)now; changed = true;   // the checkmark is not touched (0.4.2)
                    bool wasChecked = r.State == "trade";
                    notes.Add(new[] { name, "gone", why + " for " + (GraceMs / 1000).ToString(CultureInfo.InvariantCulture) + " s" + (wasChecked ? "; the checkmark is kept: entries wait until it is back" : "") });
                    warn.Add(name + " is gone (" + WhyWords(why) + " for " + (GraceMs / 1000).ToString(CultureInfo.InvariantCulture) + " s): entries wait until it is back" + (wasChecked ? "; its checkmark is kept" : ""));
                }
            }
            foreach (string[] n in notes) NoteChange(n[0], n[1], n[2]);
            foreach (string w in warn) Warn(w);
            foreach (string x in back) Info(x);
            return changed;
        }

        private static string WhyWords(string why)
        {
            if (why == "disabled") return "disabled in NinjaTrader";
            return "disconnected";
        }

        // What makes an account Gone now, or null when it is healthy.
        // Lead's default (2026-10-07): Anthony signs the prop accounts in by hand after NinjaTrader opens, so an account that has
        // not been Connected yet is never Gone for being disconnected: it keeps its saved checkmark and every order to it is
        // refused by the normal gates (not Connected) until it connects. 0.5.1: it is not listed at all until it has been seen
        // Connected this NinjaTrader session (Names). Once it has been Connected, a drop counts, and so does disabled, after the
        // grace. NinjaTrader's trailing
        // drawdown never makes an account Gone (0.4.2, Anthony: its figure drifts once a prop account passes the drawdown
        // lock; the Room column shows it, ChartBridge never acts on it).
        private static string BadWhy(string name, Account a)
        {
            bool up = a != null && ConnectionText(a) == "connected";
            if (up) lock (Mem) EverConnected.Add(name);
            if (IsDisabled(name)) return "disabled";
            if (!up) return WasConnected(name) ? "disconnected" : null;
            return null;
        }

        // ---------------------------------------------------------- the accounts message
        public static string AccountsJson(List<Account> all, double now)
        {
            foreach (Account a in all) SeenConnected(a);   // 0.5.1: one Connected now counts at once (never NinjaTrader's thread here)
            StringBuilder b = new StringBuilder("{\"type\":\"accounts\",\"list\":[");
            bool first = true;
            Claims claims = On ? ReadClaims() : null;   // 0.5.1: once per message (cached copies)
            foreach (string name in Names(all, false))
            {
                Account a = all.FirstOrDefault(x => x.Name != null && x.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
                if (!first) b.Append(','); first = false;
                AccountJson(b, name, a, claims);
            }
            b.Append("],\"archived\":[");
            List<Rec> archived;
            lock (Mem) archived = Recs.Values.Where(r => r.State == "archived").OrderBy(r => r.Name, StringComparer.OrdinalIgnoreCase).Select(r => new Rec { Name = r.Name, State = r.State, ChangedMs = r.ChangedMs }).ToList();
            for (int i = 0; i < archived.Count; i++)
                b.Append(i > 0 ? "," : "").Append("{\"name\":").Append(CbJson.Str(archived[i].Name)).Append(",\"at\":").Append(archived[i].ChangedMs.ToString(CultureInfo.InvariantCulture)).Append('}');
            return b.Append("]}").ToString();
        }

        private static void AccountJson(StringBuilder b, string name, Account a, Claims claims)
        {
            string connection = a == null ? "disconnected" : ConnectionText(a);
            bool trade = On ? SavedChecked(name) : ChartBridgeOrders.TradeAccounts.Any(t => t.Equals(name, StringComparison.OrdinalIgnoreCase));
            string goneWhy;
            bool gone = Gone(name, out goneWhy);
            long goneSince;
            lock (Mem) { Live l; goneSince = Lives.TryGetValue(name, out l) && l.Gone ? l.GoneSince : 0; }
            bool up = connection == "connected";
            double? balance = up ? Item(a, AccountItem.CashValue) : null;
            double? realized = up ? Item(a, AccountItem.RealizedProfitLoss) : null;
            double? unrealized = up ? Item(a, AccountItem.UnrealizedProfitLoss) : null;
            double? pnl = realized.HasValue && unrealized.HasValue ? realized.Value + unrealized.Value : (double?)null;
            bool yet = WasConnected(name);
            string ddWhy = yet ? "the account is not connected" : "the account is not connected yet", dlWhy = ddWhy;
            double? room = up ? RoomDrawdown(a, out ddWhy) : null;
            if (up) dlWhy = "NinjaTrader reports the daily loss limit only as the share already used (its Accounts tab), not as dollars left; ChartBridge does not estimate it";
            string hideWhy;   // 0.5.1: Hide on the page (accountArchive), null when it would be accepted now
            lock (Mem) hideWhy = !On ? "accountChecks is off" : readError != null ? ReadFailedText : null;
            bool unsure;
            if (hideWhy == null) hideWhy = HideRefusal(name, a, claims, out unsure);
            b.Append("{\"name\":").Append(CbJson.Str(name))
             .Append(",\"sim\":").Append(a != null && IsSim(a) ? "true" : "false")
             .Append(",\"connection\":").Append(CbJson.Str(connection))
             .Append(",\"notConnectedYet\":").Append(!up && !yet ? "true" : "false")   // 0.5.1: always false (only accounts seen Connected this session are listed); kept for older pages
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
             .Append(",\"canHide\":").Append(hideWhy == null ? "true" : "false")
             .Append(",\"hideWhy\":").Append(hideWhy == null ? "null" : CbJson.Str(hideWhy))
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

        private static bool WasConnected(string name) { return SeenThisSession(name); }   // 0.5.1: seen Connected this NinjaTrader session

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
                SaveDetails();
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

        // 0.5.1: accounts-detail.txt, whole via a temp file (under FileLock). A failed save is tried again every second; nothing
        // else depends on it this run (memory is in force).
        private static void SaveDetails()
        {
            string text;
            bool markOnly = false;
            lock (Mem)
            {
                if (offMarkPending && !On)
                {
                    // accountChecks off with an accounts line: only the conversion marker, and only into a file that is not there yet
                    offMarkPending = false;
                    markOnly = true;
                    text = DetailHeader + "\nconverted\t" + ((long)ChartBridgeTime.NowUtcMs()).ToString(CultureInfo.InvariantCulture) + "\n";
                }
                else
                {
                    if (!loaded || readError != null || detailReadError || !detailDirty) return;   // a file that could not be read is never rewritten that run
                    StringBuilder b = new StringBuilder(DetailHeader).Append('\n');
                    if (convertedMs >= 0) b.Append("converted\t").Append(((long)convertedMs).ToString(CultureInfo.InvariantCulture)).Append('\n');
                    foreach (KeyValuePair<string, double> kv in ConnectedAt.OrderBy(x => x.Key, StringComparer.OrdinalIgnoreCase))
                    {
                        if (!Recs.ContainsKey(kv.Key)) continue;
                        string sid;
                        b.Append("connected\t").Append(((long)kv.Value).ToString(CultureInfo.InvariantCulture)).Append('\t').Append(kv.Key);
                        if (ConnectedSession.TryGetValue(kv.Key, out sid)) b.Append('\t').Append(sid);
                        b.Append('\n');
                    }
                    text = b.ToString();
                    detailDirty = false;
                }
            }
            if (markOnly && File.Exists(DetailPath)) return;
            try
            {
                Directory.CreateDirectory(ChartBridgeConfig.Folder);
                string tmp = DetailPath + ".tmp";
                File.WriteAllText(tmp, text);
                if (File.Exists(DetailPath)) File.Replace(tmp, DetailPath, null); else File.Move(tmp, DetailPath);
            }
            catch (Exception ex)
            {
                bool first;
                lock (Mem) { first = !detailSaveFailed; detailSaveFailed = true; detailDirty = true; }
                if (first) ChartBridgeServer.Log("accounts-detail.txt could not be saved (" + ex.Message + "); trying again every second");
                return;
            }
            lock (Mem) detailSaveFailed = false;
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

        private static void Info(string text)
        {
            ChartBridgeServer.Log("NOTE: " + text);
            ChartBridgeServer.SendToTraders(Status("info", text));
        }
    }
}
