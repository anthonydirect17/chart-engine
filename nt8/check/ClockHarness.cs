// 0.5.6: this PC's clock against a time server (ChartBridgeClock in ChartBridge.cs), run for real on Mono: the NTP time stamps,
// the SNTP four-timestamp formula and its sign, every answer that is no answer, a question to a time server of its own on
// 127.0.0.1 (one that answers, one that never does), what the pages and the Output window are told (once, not per check),
// the held answer through failed checks, the offset following a change of the PC clock, and timeServer = off.
// Nothing here sets a clock: the server below makes up its own time.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using NinjaTrader.NinjaScript.AddOns;

public static class ClockHarness
{
    static Action<bool, string> Check;
    static System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient> Clients()
    {
        return (System.Collections.Concurrent.ConcurrentDictionary<int, ChartBridgeClient>)typeof(ChartBridgeServer).GetField("Clients", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
    }
    static string Priv(string name) { return (string)typeof(ChartBridgeServer).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static, null, Type.EmptyTypes, null).Invoke(null, null); }
    static List<string> Said(int from) { lock (NinjaTrader.Code.Output.Lines) return NinjaTrader.Code.Output.Lines.Skip(from).ToList(); }
    static int Lines() { lock (NinjaTrader.Code.Output.Lines) return NinjaTrader.Code.Output.Lines.Count; }
    static double Num(string json, string key) { Match m = Regex.Match(json, "\"" + key + "\":(-?[0-9.]+)"); return m.Success ? double.Parse(m.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture) : double.NaN; }

    // An SNTP answer as a server sends it: mode 4, stratum 2, the question's transmit time echoed, t1 and t2 its own.
    static byte[] Answer(byte[] req, double t1, double t2)
    {
        byte[] res = new byte[48];
        res[0] = 0x24; res[1] = 2;   // leap 0, version 4, mode 4 (server); stratum 2
        Array.Copy(req, 40, res, 24, 8);
        ChartBridgeClock.WriteStamp(res, 32, t1);
        ChartBridgeClock.WriteStamp(res, 40, t2);
        return res;
    }
    static byte[] Question(double t0) { byte[] q = new byte[48]; q[0] = 0x23; ChartBridgeClock.WriteStamp(q, 40, t0); return q; }

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        string serverWas = ChartBridgeClock.Server; int portWas = ChartBridgeClock.Port;
        // 0.6.2: only this harness's own pages while it runs (an earlier harness's page, restored with its queue never drained, could
        // be closed for lag by the status this harness sends, and its Output line would be counted with the clock's own)
        Dictionary<int, ChartBridgeClient> clientsWas = Clients().ToDictionary(kv => kv.Key, kv => kv.Value);
        Clients().Clear();
        try { Stamps(); Formula(); NoAnswers(); Told(); Asked(); }
        finally
        {
            ChartBridgeClock.FaultForHarness = null; ChartBridgeClock.Stop(); ChartBridgeClock.Server = serverWas; ChartBridgeClock.Port = portWas; ChartBridgeClock.Reset();
            Clients().Clear(); foreach (KeyValuePair<int, ChartBridgeClient> kv in clientsWas) Clients()[kv.Key] = kv.Value;
        }
    }

    static void Stamps()
    {
        double[] at = { 1791993600123.456, 1700000000000, 2085978496000 + 5000.25 };   // 2026-10-14, 2023, and just after the 2036 NTP era turns
        foreach (double ms in at)
        {
            byte[] b = new byte[8];
            ChartBridgeClock.WriteStamp(b, 0, ms);
            Check(Math.Abs(ChartBridgeClock.StampMs(b, 0) - ms) < 0.001, "NTP time stamp round trip " + ms + ": " + ChartBridgeClock.StampMs(b, 0));
        }
        byte[] y1900 = new byte[8]; ChartBridgeClock.WriteStamp(y1900, 0, 1791993600000);
        Check(y1900[0] >= 0x80, "2026 is in NTP era 0 (top bit set)");
        Check(double.IsNaN(ChartBridgeClock.StampMs(new byte[8], 0)), "a zero NTP time is no time");
    }

    static void Formula()
    {
        // 2026-10-12: the laptop's clock 2310 ms ahead; 20 ms each way, 1 ms inside the server
        double t0 = 1791993600000, t1 = t0 - 2310 + 20, t2 = t1 + 1, t3 = t0 + 41;
        byte[] q = Question(t0);
        double off, rtt; string err;
        bool ok = ChartBridgeClock.Offset(q, Answer(q, t1, t2), 48, t0, t3, out off, out rtt, out err);
        Check(ok && Math.Abs(off + 2310) < 0.01 && Math.Abs(rtt - 40) < 0.01, "PC clock 2310 ms ahead: offset (server minus PC) -2310, round trip 40: " + off + ", " + rtt + ", " + err);
        // behind by 1500, a lopsided path (60 ms out, 10 back): the formula's error is half the difference, 25 ms
        t1 = t0 + 1500 + 60; t2 = t1 + 2; t3 = t0 + 72;
        ok = ChartBridgeClock.Offset(q, Answer(q, t1, t2), 48, t0, t3, out off, out rtt, out err);
        Check(ok && Math.Abs(off - 1525) < 0.01 && Math.Abs(rtt - 70) < 0.01, "PC clock 1500 ms behind: offset +1525 (a lopsided path: half the difference), round trip 70: " + off + ", " + rtt);
        // the right clock: offset 0
        ok = ChartBridgeClock.Offset(q, Answer(q, t0 + 15, t0 + 16), 48, t0, t0 + 31, out off, out rtt, out err);
        Check(ok && Math.Abs(off) < 0.01 && Math.Abs(rtt - 30) < 0.01, "the right clock: offset 0: " + off);
    }

    static void NoAnswers()
    {
        double t0 = 1791993600000, off, rtt; string err;
        byte[] q = Question(t0), good = Answer(q, t0 + 10, t0 + 11);
        Check(!ChartBridgeClock.Offset(q, good, 47, t0, t0 + 20, out off, out rtt, out err) && err.Contains("short"), "a short answer is none: " + err);
        byte[] client = (byte[])good.Clone(); client[0] = 0x23;
        Check(!ChartBridgeClock.Offset(q, client, 48, t0, t0 + 20, out off, out rtt, out err) && err.Contains("mode 3"), "not a server's answer: " + err);
        byte[] kiss = (byte[])good.Clone(); kiss[1] = 0; kiss[12] = (byte)'R'; kiss[13] = (byte)'A'; kiss[14] = (byte)'T'; kiss[15] = (byte)'E';
        Check(!ChartBridgeClock.Offset(q, kiss, 48, t0, t0 + 20, out off, out rtt, out err) && err.Contains("RATE"), "the server turned it down (kiss code): " + err);
        byte[] unset = (byte[])good.Clone(); unset[0] = 0xE4;
        Check(!ChartBridgeClock.Offset(q, unset, 48, t0, t0 + 20, out off, out rtt, out err) && err.Contains("not set"), "the server's own clock is not set (leap 3): " + err);
        byte[] other = Answer(Question(t0 - 1000), t0 + 10, t0 + 11);
        Check(!ChartBridgeClock.Offset(q, other, 48, t0, t0 + 20, out off, out rtt, out err) && err.Contains("not to this question"), "an answer to another question: " + err);
        byte[] blank = (byte[])good.Clone(); for (int i = 32; i < 48; i++) blank[i] = 0;
        Check(!ChartBridgeClock.Offset(q, blank, 48, t0, t0 + 20, out off, out rtt, out err) && err.Contains("no times"), "an answer with no times: " + err);
        Check(!ChartBridgeClock.Offset(q, Answer(q, t0 + 10, t0 + 11), 48, t0, t0 + 9000, out off, out rtt, out err) && err.Contains("do not add up"), "a round trip longer than the wait: " + err);
    }

    static ChartBridgeClient Page(int id, List<string> got)
    {
        ChartBridgeClient c = new ChartBridgeClient(null, id);
        c.Tap = s => { if (s.StartsWith("{\"type\":\"pcClock\"")) lock (got) got.Add(s); };
        Clients()[id] = c;
        return c;
    }
    static void Drop(ChartBridgeClient c) { ChartBridgeClient g; Clients().TryRemove(c.Id, out g); c.Close(); }

    static void Told()
    {
        List<string> got = new List<string>();
        ChartBridgeClient page = Page(9701, got);
        try
        {
            ChartBridgeClock.Server = "time.windows.com";
            ChartBridgeClock.Reset();
            Check(ChartBridgeClock.Json() == "{\"checked\":false,\"why\":\"not checked yet\",\"server\":\"time.windows.com\"}", "before the first check: not checked yet: " + ChartBridgeClock.Json());
            string hello = Priv("HelloJson");
            Check(hello.Contains(",\"pcClock\":{\"checked\":false,\"why\":\"not checked yet\""), "hello carries pcClock: " + hello.Substring(Math.Max(0, hello.IndexOf("pcClock") - 2)));
            string diag = Priv("DiagJson");
            Check(diag.Contains("\"clockOffsetMs\":") && diag.Contains("\"pcClock\":{\"checked\":false") && diag.Contains("\"checks\":0") && diag.Contains("\"everyMs\":300000") && diag.Contains("\"warnMs\":500"),
                  "/diag: pcClock beside clockOffsetMs (ChartBridge's own clock), with its counters");

            double now = 1791993600000;
            int from = Lines();
            ChartBridgeClock.Note("time.windows.com", false, 0, 0, "no answer within 2 s: offline, or UDP port 123 blocked", now);
            ChartBridgeClock.Note("time.windows.com", false, 0, 0, "no answer within 2 s: offline, or UDP port 123 blocked", now + 300000);
            string j = ChartBridgeClock.Json();
            Check(j.StartsWith("{\"checked\":false,\"why\":\"no answer from time.windows.com (no answer within 2 s: offline, or UDP port 123 blocked)\""), "no answer: not checked, with why: " + j);
            List<string> said = Said(from);
            Check(said.Count(x => x.Contains("time check: no answer from time.windows.com")) == 1 && said.Count == 1, "no answer: one Output line for two checks: " + string.Join(" | ", said));
            Check(got.Count == 1 && got[0].StartsWith("{\"type\":\"pcClock\",\"checked\":false,\"why\":\"no answer"), "the pages are told once (the same why again: nothing sent): " + string.Join(" | ", got));

            from = Lines(); got.Clear();
            ChartBridgeClock.Note("time.windows.com", true, -2310.4, 38.2, null, now + 600000);
            j = ChartBridgeClock.Json();
            Check(j == "{\"checked\":true,\"offsetMs\":-2310.4,\"rttMs\":38.2,\"atUtcMs\":1791994200000,\"server\":\"time.windows.com\"}", "an answer: offset, round trip, when and who: " + j);
            said = Said(from);
            Check(said.Count == 2 && said[0].Contains("time check: this PC's clock is 2310 ms ahead of time.windows.com (round trip 38 ms), answering again. ChartBridge only measures; it never sets the clock.")
                  && said[1].Contains("this PC's clock is off by 2.3 s"), "an answer after none: said, and the clock past 500 ms said: " + string.Join(" | ", said));
            Check(got.Count == 1 && got[0] == "{\"type\":\"pcClock\"," + j.Substring(1), "the pages get the answer: " + string.Join(" | ", got));

            from = Lines(); got.Clear();
            ChartBridgeClock.Note("time.windows.com", true, -2298, 40, null, now + 900000);
            Check(Said(from).Count == 0 && got.Count == 1 && Num(got[0], "offsetMs") == -2298, "the next answer: sent to the pages, nothing said in the Output window");

            // the PC clock set right by Windows (back 2300 ms): the held offset follows at once, before the next answer
            ChartBridgeClock.PcClockChanged(-2300);
            Check(Math.Abs(Num(ChartBridgeClock.Json(), "offsetMs") - 2) < 0.001, "the PC clock moved back 2300 ms: the held offset follows (-2298 to +2): " + ChartBridgeClock.Json());
            from = Lines(); got.Clear();
            ChartBridgeClock.Note("time.windows.com", true, 3, 35, null, now + 910000);
            said = Said(from);
            Check(said.Count == 1 && said[0].Contains("this PC's clock is within 500 ms of time.windows.com again"), "back under 500 ms: said once: " + string.Join(" | ", said));

            // no answer for a while: the last answer is kept for 30 minutes, then not checked
            from = Lines(); got.Clear();
            ChartBridgeClock.Note("time.windows.com", false, 0, 0, "network error: NetworkUnreachable", now + 910000 + 300000);
            Check(ChartBridgeClock.Json().StartsWith("{\"checked\":true,\"offsetMs\":3,") && got.Count == 0, "no answer 5 minutes after one: the answer is kept, nothing sent");
            Check(Said(from).Count(x => x.Contains("no answer from time.windows.com (network error: NetworkUnreachable); the last answer is kept for up to 30 minutes")) == 1, "and said once");
            ChartBridgeClock.Note("time.windows.com", false, 0, 0, "network error: NetworkUnreachable", now + 910000 + ChartBridgeClock.KeepMs + 1);
            Check(ChartBridgeClock.Json().StartsWith("{\"checked\":false,\"why\":\"no answer from time.windows.com (network error: NetworkUnreachable)\"") && got.Count == 1, "over 30 minutes without one: not checked, the pages told");
            Check(Said(from).Count == 1, "still one line");
            diag = Priv("DiagJson");
            Check(diag.Contains("\"checks\":7") && diag.Contains("\"fails\":4") && diag.Contains("\"lastError\":\"network error: NetworkUnreachable\""), "/diag counts the checks and the failures");

            // timeServer = off: no check, the reason given, no thread
            Check(ChartBridgeClock.ReadConfig("timeServer", "off") && ChartBridgeClock.Off, "config.txt timeServer = off");
            from = Lines();
            ChartBridgeClock.Start();
            Check(ChartBridgeClock.Json() == "{\"checked\":false,\"why\":\"the time check is off in config.txt (timeServer = off)\",\"server\":null}", "off: not checked, why: " + ChartBridgeClock.Json());
            Check(Said(from).Count(x => x.Contains("time check: off")) == 1, "off: said once at start");
            Check(!ChartBridgeClock.ReadConfig("timeServers", "x") && ChartBridgeClock.ReadConfig("timeServer", "pool.ntp.org") && ChartBridgeClock.Server == "pool.ntp.org", "timeServer names the server; another key is not its");
            ChartBridgeClock.ResetConfig();
            Check(ChartBridgeClock.Server == "time.windows.com", "the default: time.windows.com (the server Windows time sync uses)");
        }
        finally { Drop(page); }
    }

    // A time server of its own on 127.0.0.1: answers with its clock `ahead` ms off ChartBridge's, or never.
    static UdpClient Serve(double ahead, bool answer)
    {
        UdpClient u = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
        Thread t = new Thread(() =>
        {
            try
            {
                while (true)
                {
                    IPEndPoint from = new IPEndPoint(IPAddress.Any, 0);
                    byte[] q = u.Receive(ref from);
                    if (!answer || q.Length < 48) continue;
                    double t1 = ChartBridgeTime.NowUtcMs() + ahead;
                    byte[] res = Answer(q, t1, t1 + 0.5);
                    u.Send(res, res.Length, from);
                }
            }
            catch (Exception) { }   // closed
        });
        t.IsBackground = true; t.Start();
        return u;
    }

    static void Asked()
    {
        double off, rtt; string err;
        UdpClient fast = Serve(1234, true), mute = Serve(0, false);
        try
        {
            int fastPort = ((IPEndPoint)fast.Client.LocalEndPoint).Port, mutePort = ((IPEndPoint)mute.Client.LocalEndPoint).Port;
            bool ok = ChartBridgeClock.Ask("127.0.0.1", fastPort, out off, out rtt, out err);
            Check(ok && Math.Abs(off - 1234) < 50 && rtt >= 0 && rtt < 50, "a time server 1234 ms ahead of this PC: offset +1234: " + off + " (round trip " + rtt + ", " + err + ")");
            ok = ChartBridgeClock.Ask("localhost", fastPort, out off, out rtt, out err);
            Check(ok && Math.Abs(off - 1234) < 50, "asked by name: " + off + ", " + err);
            Stopwatch sw = Stopwatch.StartNew();
            ok = ChartBridgeClock.Ask("127.0.0.1", mutePort, out off, out rtt, out err);
            long waited = sw.ElapsedMilliseconds;
            Check(!ok && err.StartsWith("no answer within 2 s") && waited >= 1800 && waited < 3500, "a server that never answers: no answer after 2 s (" + waited + " ms): " + err);
            Check(!ChartBridgeClock.Ask("no-such-host.invalid", fastPort, out off, out rtt, out err) && err != null, "a name that does not resolve: no answer: " + err);

            // the whole loop on its own thread: started, it asks 3 s later, tells the pages and says it once
            List<string> got = new List<string>();
            ChartBridgeClient page = Page(9702, got);
            try
            {
                ChartBridgeClock.Server = "127.0.0.1"; ChartBridgeClock.Port = fastPort;
                int from = Lines();
                ChartBridgeClock.Start();
                bool came = false;
                for (int i = 0; i < 160 && !came; i++) { Thread.Sleep(50); lock (got) came = got.Count > 0; }
                string first; lock (got) first = got.Count > 0 ? got[0] : "";
                Check(came && first.StartsWith("{\"type\":\"pcClock\",\"checked\":true,") && Math.Abs(Num(first, "offsetMs") - 1234) < 50 && first.Contains("\"server\":\"127.0.0.1\""), "started: the first check after 3 s, sent to the pages: " + first);
                List<string> said = Said(from);
                Check(said.Count(x => x.Contains("time check: this PC's clock is") && x.Contains("ms behind 127.0.0.1")) == 1 && said.Count(x => x.Contains("this PC's clock is off by 1.2 s")) == 1, "said once, with the clock off by 1.2 s: " + string.Join(" | ", said));
                // a change of the PC clock over 250 ms: checked again at once (not 5 minutes later)
                lock (got) got.Clear();
                ChartBridgeClock.PcClockChanged(400);
                came = false;
                for (int i = 0; i < 60 && !came; i++) { Thread.Sleep(50); lock (got) came = got.Count >= 2; }
                lock (got) Check(came && Math.Abs(Num(got[0], "offsetMs") - 834) < 50 && Math.Abs(Num(got[1], "offsetMs") - 1234) < 50, "the PC clock changed by 400 ms: the corrected offset sent, then a fresh answer at once: " + string.Join(" | ", got));
                // a step that throws (a fault anywhere in the check) does not end the loop: said, and the next wake checks again
                int thrown = 0;
                ChartBridgeClock.FaultForHarness = () => { if (Interlocked.Increment(ref thrown) == 1) throw new InvalidOperationException("made-up fault"); };
                from = Lines();
                lock (got) got.Clear();
                ChartBridgeClock.PcClockChanged(400);
                bool saidFault = false;
                for (int i = 0; i < 60 && !saidFault; i++) { Thread.Sleep(50); saidFault = Said(from).Any(x => x.Contains("time check error (InvalidOperationException: made-up fault); checked again in 5 minutes")); }
                Check(saidFault && thrown == 1, "a fault in the check: said in the Output window, not thrown out of the thread");
                lock (got) got.Clear();
                ChartBridgeClock.PcClockChanged(400);
                came = false;
                for (int i = 0; i < 60 && !came; i++) { Thread.Sleep(50); lock (got) came = got.Any(m => Math.Abs(Num(m, "offsetMs") - 1234) < 50); }
                Check(came && thrown == 2, "the loop goes on after it: the next wake checks again (" + thrown + " steps)");
                Check(Regex.IsMatch(Priv("DiagJson"), "\"faults\":1,"), "/diag counts the fault");
                ChartBridgeClock.FaultForHarness = null;
                ChartBridgeClock.Stop();
                lock (got) got.Clear();
                ChartBridgeClock.PcClockChanged(400);
                Thread.Sleep(300);
                lock (got) Check(got.Count == 0, "stopped: no more checks");
            }
            finally { Drop(page); }
        }
        finally { fast.Close(); mute.Close(); }
    }
}
