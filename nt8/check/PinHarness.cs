// The PIN on ChartBridge's own page (ChartBridgePin.cs, 0.3.2), run for real on Mono: hashing and pin.txt, set,
// unlock, change, a wrong PIN never blocking the right one, the unlock token across a ChartBridge restart, the
// forgotten-PIN recovery, the strict POST endpoints, and /session and the WebSocket gated. The server itself is
// started and stopped with ChartBridgeServer.Start and Stop on a spare port. Mono's HttpListener has no server
// WebSocket, so the WebSocket gate is checked through ChartBridgePin.WsUnlocked, the call the upgrade path makes
// (its place before the upgrade is pinned by test/nt8-source.test.js). Made-up PINs only.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using NinjaTrader.NinjaScript.AddOns;

public static class PinHarness
{
    static Action<bool, string> Check;
    static int port;
    // made-up PINs for the test only
    const string PinA = "8531", PinB = "0592", PinC = "7146";
    static readonly string[] Pins = { PinA, PinB, PinC };

    static string Own { get { return "http://localhost:" + port; } }

    public static void Run(Action<bool, string> check)
    {
        Check = check;
        string dir;
        do dir = Path.Combine(Path.GetTempPath(), "cb-pin-" + Guid.NewGuid().ToString("N")); while (Pins.Any(p => dir.Contains(p)));
        Directory.CreateDirectory(Path.Combine(dir, "ChartBridge"));
        string dirWas = NinjaTrader.Core.Globals.UserDataDir;
        int portWas = ChartBridgeConfig.Port;
        NinjaTrader.Core.Globals.UserDataDir = dir;
        Random rnd = new Random();
        do port = 20000 + rnd.Next(9000); while (Pins.Any(p => port.ToString().Contains(p)));
        ChartBridgeConfig.Port = port;
        lock (NinjaTrader.Code.Output.Lines) NinjaTrader.Code.Output.Lines.Clear();
        try { Hashing(); Server(); }
        finally
        {
            try { ChartBridgeServer.Stop(); } catch (Exception) { }
            ChartBridgePin.NewHashIterations = ChartBridgePin.DefaultIterations;
            ChartBridgeConfig.Port = portWas;
            NinjaTrader.Core.Globals.UserDataDir = dirWas;
        }
    }

    static string FileText() { return File.Exists(ChartBridgePin.PinFile) ? File.ReadAllText(ChartBridgePin.PinFile) : ""; }
    static string DataLine() { return FileText().Split('\n').Select(l => l.Trim()).First(l => l.Length > 0 && !l.StartsWith("#")); }

    // ------------------------------------------------------------ hashing and pin.txt, without the server
    static void Hashing()
    {
        Check(ChartBridgePin.DefaultIterations >= 600000 && ChartBridgePin.NewHashIterations == ChartBridgePin.DefaultIterations, "PIN: PBKDF2 iterations default to " + ChartBridgePin.DefaultIterations);
        Check(ChartBridgePin.ValidPin("0000") && ChartBridgePin.ValidPin(PinA), "PIN: four ASCII digits are a PIN");
        Check(!ChartBridgePin.ValidPin("853") && !ChartBridgePin.ValidPin("85310") && !ChartBridgePin.ValidPin("85a1") && !ChartBridgePin.ValidPin(" 853")
              && !ChartBridgePin.ValidPin("٨٥٣١") && !ChartBridgePin.ValidPin("") && !ChartBridgePin.ValidPin(null), "PIN: 3 or 5 digits, letters, spaces, other scripts' digits, empty and null are not");
        Check(!ChartBridgePin.IsSet && ChartBridgePin.DiagJson() == "{\"set\":false}", "PIN: none set in a fresh folder; /diag part says so");

        Stopwatch sw = Stopwatch.StartNew();
        ChartBridgePin.Result r = ChartBridgePin.Set(PinA);
        long setMs = sw.ElapsedMilliseconds;
        Check(r.Ok && r.Status == 200 && Regex.IsMatch(r.Token, "^v1\\.[0-9a-f]{32}\\.[0-9a-f]{64}$"), "PIN set: a token comes back (" + setMs + " ms at the default iterations on Mono)");
        string text = FileText(), line = DataLine();
        string[] f = line.Split(' ');
        Check(f.Length == 6 && f[0] == "v1" && f[1] == "pbkdf2-sha256" && f[2] == ChartBridgePin.DefaultIterations.ToString() && f[3].Length == 32 && f[4].Length == 64 && f[5].Length == 64,
              "pin.txt: v1 pbkdf2-sha256, the iteration count, a 16-byte salt, a 32-byte hash and a 32-byte secret: " + (f.Length > 3 ? f[0] + " " + f[1] + " " + f[2] : line));
        string rest = text.Replace(f[3], "").Replace(f[4], "").Replace(f[5], "");
        Check(!Pins.Any(p => rest.Contains(p)), "pin.txt never holds the PIN");
        Check(text.Contains("Delete this file"), "pin.txt says how to recover a forgotten PIN");
        byte[] salt = Hex(f[3]), want;
        using (Rfc2898DeriveBytes k = new Rfc2898DeriveBytes(Encoding.ASCII.GetBytes(PinA), salt, ChartBridgePin.DefaultIterations, HashAlgorithmName.SHA256)) want = k.GetBytes(32);
        Check(ToHex(want) == f[4], "pin.txt: the hash is PBKDF2-HMAC-SHA256(PIN, salt, " + ChartBridgePin.DefaultIterations + ")");
        Check(ChartBridgePin.Unlock(PinA).Ok && ChartBridgePin.Unlock(PinB).Status == 403, "unlock: the right PIN opens, a wrong one is refused (default iterations)");

        // a second set on the same PC is refused; a new salt every time
        Check(ChartBridgePin.Set(PinB).Status == 409 && DataLine() == line, "set: refused (409) once a PIN is set, and pin.txt is untouched");
        File.Delete(ChartBridgePin.PinFile);
        ChartBridgePin.NewHashIterations = 1000;          // the rest runs at a low count, only to keep the harness quick
        ChartBridgePin.Set(PinA);
        Check(DataLine().Split(' ')[3] != f[3], "set: a new random salt each time");
        Check(ChartBridgePin.Unlock(PinA).Ok, "unlock: a file written at another iteration count checks with its own count");

        // pin.txt that cannot be read counts as no PIN (a new one can be set over it); a too-low count is not accepted
        File.WriteAllText(ChartBridgePin.PinFile, "garbage\n");
        Check(!ChartBridgePin.IsSet && ChartBridgePin.Unlock(PinA).Status == 409 && ChartBridgePin.Set(PinC).Ok && ChartBridgePin.Unlock(PinC).Ok, "an unreadable pin.txt counts as no PIN; setting one replaces it");
        string[] g = DataLine().Split(' ');
        File.WriteAllText(ChartBridgePin.PinFile, "v1 pbkdf2-sha256 10 " + g[3] + " " + g[4] + " " + g[5] + "\n");
        Check(!ChartBridgePin.IsSet, "pin.txt with fewer than " + ChartBridgePin.MinIterations + " iterations is not accepted");
        File.Delete(ChartBridgePin.PinFile);

        // strict body parsing
        Check(ChartBridgePin.ParseFlat("{\"pin\":\"8531\"}", new[] { "pin" }) != null && ChartBridgePin.ParseFlat(" { \"newPin\" : \"1\" , \"pin\":\"2\" } ", new[] { "pin", "newPin" }) != null
              && ChartBridgePin.ParseFlat("{}", new string[0]) != null, "strict parse: the named keys, any order, whitespace allowed");
        string[] bad = { "", "{", "{\"pin\":\"8531\"", "{\"pin\":8531}", "{\"pin\":\"8531\",\"pin\":\"8531\"}", "{\"pin\":\"8531\",\"x\":\"1\"}", "{\"pin\":null}",
                         "{\"pin\":{\"a\":\"1\"}}", "{\"pin\":[\"8531\"]}", "{\"pin\":\"85\\u0033\"}", "{\"pin\":\"8531\"} x", "{\"pin\":\"8531\",}", "[\"8531\"]", "{'pin':'8531'}", "{\"pin\":\"123456789\"}", "{\"PIN\":\"8531\"}" };
        List<string> passed = bad.Where(b => ChartBridgePin.ParseFlat(b, new[] { "pin" }) != null).ToList();
        Check(passed.Count == 0, "strict parse: " + bad.Length + " malformed bodies refused" + (passed.Count > 0 ? "; passed: " + string.Join(" | ", passed) : ""));
        Check(ChartBridgePin.ParseFlat("{\"pin\":\"8531\"}", new[] { "pin", "newPin" }) == null, "strict parse: a missing key refused");
    }

    // ------------------------------------------------------------ the real server on a spare port
    static void Server()
    {
        NinjaTrader.Cbi.Account.All.Clear();               // the order harness's stand-in accounts are done with
        // Linux names New York's zone differently from Windows; hand ChartBridge the zone it would find there
        typeof(ChartBridgeTime).GetField("et", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)
            .SetValue(null, TimeZoneInfo.FindSystemTimeZoneById("America/New_York"));
        Check(ChartBridgeServer.Start(), "server: ChartBridge starts on port " + port);
        if (!WaitUp()) { Check(false, "server: not answering"); return; }
        ChartBridgeConfig.AllowOrigins = ChartBridgeAccess.ParseOrigins("https://desk.golivepage.com");

        // status and set
        Check(Post("/pin/status", "{}").Is(200, "{\"set\":false,\"unlocked\":false}"), "POST /pin/status with no PIN: set false");
        Check(Get("/session").Status == 403, "GET /session with no PIN set: refused");
        Check(!ChartBridgePin.WsUnlocked(Own, null), "WebSocket from the own page with no PIN set: refused");

        // strict endpoint checks, all before anything is set
        Check(Get("/pin/set").Status == 405 && Get("/pin/status").Status == 405, "PIN endpoints: GET is 405 (POST only)");
        Check(Post("/pin/set", "{\"pin\":\"" + PinA + "\"}", "https://desk.golivepage.com").Status == 403, "PIN endpoints: a listed allowOrigins page (The Desk) is refused");
        Check(Post("/pin/set", "{\"pin\":\"" + PinA + "\"}", "https://evil.example").Status == 403, "PIN endpoints: another page is refused");
        Check(Post("/pin/set", "{\"pin\":\"" + PinA + "\"}", "").Status == 403 && Post("/pin/set", "{\"pin\":\"" + PinA + "\"}", null).Status == 403, "PIN endpoints: an empty or missing Origin is refused");
        Check(Post("/pin/set", "{\"pin\":\"" + PinA + "\"}", "http://LOCALHOST:" + port).Status == 403 && Post("/pin/set", "{\"pin\":\"" + PinA + "\"}", "http://127.0.0.1:" + port).Status == 403,
              "PIN endpoints: the exact Origin orders use (no case folding, not 127.0.0.1)");
        Reply rebound = Post("/pin/set", "{\"pin\":\"" + PinA + "\"}", Own, "application/json", "evil.example");
        Check((rebound.Status == 400 || rebound.Status == 403) && !ChartBridgePin.IsSet, "PIN endpoints: a Host other than localhost:<port> is refused (" + rebound.Status + ": the listener's localhost prefix, then ChartBridge's own check)");
        Check(Post("/pin/set", "{\"pin\":\"" + PinA + "\"}", Own, "text/plain").Status == 415 && Post("/pin/set", "{\"pin\":\"" + PinA + "\"}", Own, "application/jsonp").Status == 415, "PIN endpoints: JSON content type only");
        Check(Post("/pin/set", "{\"pin\":\"" + PinA + "\"" + new string(' ', 300) + "}").Status == 413, "PIN endpoints: a body over 256 bytes is refused (413)");
        Check(Post("/pin/set", "{\"pin\":" + PinA + "}").Status == 400 && Post("/pin/set", "{\"pin\":\"" + PinA + "\",\"extra\":\"1\"}").Status == 400
              && Post("/pin/set", "{\"pin\":\"85310\"}").Status == 400 && Post("/pin/set", "{\"pin\":\"٨٥٣١\"}").Status == 400, "PIN endpoints: a number, an extra key, 5 digits, other scripts' digits: 400");
        Check(Post("/pin/unlock", "{\"pin\":\"" + PinA + "\"}").Status == 409, "unlock with no PIN set: 409");
        Check(Post("/pin/nothing", "{}").Status == 404, "an unknown PIN endpoint: 404");
        Check(!ChartBridgePin.IsSet, "nothing above set a PIN");

        Reply set = Post("/pin/set", "{\"pin\":\"" + PinA + "\"}");
        string t1 = set.Token;
        Check(set.Status == 200 && t1 != null, "POST /pin/set: 200 and an unlock token");
        Check(set.Headers["Cache-Control"] == "no-store" && set.Headers["X-Frame-Options"] == "DENY" && set.Headers["Access-Control-Allow-Origin"] == null, "PIN answers: no-store, no framing, no CORS");
        Check(Post("/pin/set", "{\"pin\":\"" + PinB + "\"}").Status == 409, "a second set: 409, the PIN is not replaced");
        Check(Post("/pin/status", "{}").Is(200, "{\"set\":true,\"unlocked\":false}") && Post("/pin/status", "{}", Own, "application/json", null, t1).Is(200, "{\"set\":true,\"unlocked\":true}"),
              "POST /pin/status: set; unlocked only with the token");

        // /session and the WebSocket need the unlock
        Check(Get("/session").Status == 403 && Get("/session", "v1.00.00").Status == 403, "GET /session without the unlock token (or a malformed one): 403");
        string tampered = t1.Substring(0, t1.Length - 1) + (t1.EndsWith("0") ? "1" : "0");
        Check(Get("/session", tampered).Status == 403, "GET /session with a tampered token: 403");
        Reply sess = Get("/session", t1);
        string orderToken1 = Regex.Match(sess.Body, "\"token\":\"([0-9a-f]+)\"").Groups[1].Value;
        Check(sess.Status == 200 && orderToken1.Length == 48, "GET /session with the unlock token: 200 and the order token");
        Reply reboundSession = Get("/session", t1, "evil.example");
        Check((reboundSession.Status == 400 || reboundSession.Status == 403) && !reboundSession.Body.Contains("token"), "GET /session: the Host check still applies with a token (" + reboundSession.Status + ")");
        Check(!ChartBridgePin.WsUnlocked(Own, null) && !ChartBridgePin.WsUnlocked(Own, "") && !ChartBridgePin.WsUnlocked(Own, tampered), "WebSocket from the own page: refused without a valid token");
        Check(!ChartBridgePin.WsUnlocked("HTTP://LOCALHOST:" + port, null) && !ChartBridgePin.WsUnlocked(" " + Own + " ", null), "WebSocket: no spelling of the own origin skips the PIN");
        Check(ChartBridgePin.WsUnlocked(Own, t1), "WebSocket from the own page with the token: allowed");
        Check(ChartBridgePin.WsUnlocked("https://desk.golivepage.com", null) && ChartBridgePin.WsUnlocked(null, null), "WebSocket from The Desk (allowOrigins) or a local program (no Origin): no PIN needed, as in 0.3.1");
        ChartBridgeConfig.AllowOrigins = ChartBridgeAccess.ParseOrigins(Own + ", https://desk.golivepage.com");
        Check(!ChartBridgePin.WsUnlocked(Own, null), "WebSocket: listing the own page in allowOrigins does not skip the PIN");

        // a wrong PIN never blocks the right one: 20 wrong in a row, then the right one at once
        string before = FileText();
        int wrong403 = 0;
        for (int i = 0; i < 20; i++)
        {
            Reply w = Post("/pin/unlock", "{\"pin\":\"" + (i % 2 == 0 ? PinB : PinC) + "\"}");
            if (w.Status == 403 && w.Body.Contains("wrong PIN") && w.Token == null) wrong403++;
        }
        Check(wrong403 == 20, "20 wrong PINs in a row: each refused with 403 \"wrong PIN\" (" + wrong403 + ")");
        Stopwatch sw = Stopwatch.StartNew();
        Reply right = Post("/pin/unlock", "{\"pin\":\"" + PinA + "\"}");
        Check(right.Status == 200 && right.Token != null && ChartBridgePin.WsUnlocked(Own, right.Token), "then the right PIN unlocks at once (" + sw.ElapsedMilliseconds + " ms), nothing blocked");
        Check(FileText() == before, "wrong PINs change nothing on disk (nothing counted)");
        Check(ChartBridgePin.Unlock(PinB).Status == 403 && ChartBridgePin.Unlock(PinA).Ok, "and again: wrong, then right, straight after");

        // restart (F5 in NinjaTrader): the page's in-memory token still works, and gets a new order token
        ChartBridgeServer.Stop();
        Check(ChartBridgeServer.Start() && WaitUp(), "restart: ChartBridge stopped and started again");
        Reply sess2 = Get("/session", t1);
        string orderToken2 = Regex.Match(sess2.Body, "\"token\":\"([0-9a-f]+)\"").Groups[1].Value;
        Check(sess2.Status == 200 && orderToken2.Length == 48 && orderToken2 != orderToken1, "restart: the token from before signs the page in again (a new order token)");
        Check(ChartBridgePin.WsUnlocked(Own, t1) && Post("/pin/status", "{}", Own, "application/json", null, t1).Is(200, "{\"set\":true,\"unlocked\":true}"),
              "restart: the WebSocket takes the token from before; status says unlocked");

        // change: needs the current PIN; open pages stay unlocked
        Check(Post("/pin/change", "{\"pin\":\"" + PinB + "\",\"newPin\":\"" + PinC + "\"}").Status == 403 && ChartBridgePin.Unlock(PinA).Ok, "change with a wrong current PIN: 403, the PIN is unchanged");
        Check(Post("/pin/change", "{\"newPin\":\"" + PinC + "\"}").Status == 400, "change without the current PIN: 400");
        Reply ch = Post("/pin/change", "{\"pin\":\"" + PinA + "\",\"newPin\":\"" + PinB + "\"}");
        Check(ch.Status == 200 && ch.Token != null, "change with the current PIN: 200 and a token");
        Check(ChartBridgePin.Unlock(PinA).Status == 403 && ChartBridgePin.Unlock(PinB).Ok, "after the change: the old PIN is refused, the new one opens");
        Check(ChartBridgePin.WsUnlocked(Own, t1) && Get("/session", t1).Status == 200, "after the change: a page unlocked before stays unlocked");

        // /diag says only whether a PIN is set
        string diag = Get("/diag").Body;
        string[] parts = DataLine().Split(' ');
        Check(diag.Contains("\"pin\":{\"set\":true}") && !diag.Contains(parts[3]) && !diag.Contains(parts[4]) && !diag.Contains(parts[5]) && !diag.Contains(t1) && !diag.Contains(orderToken2),
              "/diag: \"pin\":{\"set\":true} and nothing else about the PIN");

        // forgotten PIN: delete pin.txt while ChartBridge runs
        File.Delete(ChartBridgePin.PinFile);
        Check(Post("/pin/status", "{}", Own, "application/json", null, t1).Is(200, "{\"set\":false,\"unlocked\":false}") && Get("/diag").Body.Contains("\"pin\":{\"set\":false}"),
              "forgotten PIN: with pin.txt deleted (ChartBridge running), status says no PIN set");
        Check(!ChartBridgePin.WsUnlocked(Own, t1) && Get("/session", t1).Status == 403, "forgotten PIN: tokens from before no longer open the stream or /session");
        Reply again = Post("/pin/set", "{\"pin\":\"" + PinC + "\"}");
        Check(again.Status == 200 && ChartBridgePin.WsUnlocked(Own, again.Token) && !ChartBridgePin.WsUnlocked(Own, t1), "forgotten PIN: a new PIN can be set; it has a new secret, the old token stays dead");

        // nothing logged the PIN, the hash, the secret or a token
        List<string> lines;
        lock (NinjaTrader.Code.Output.Lines) lines = NinjaTrader.Code.Output.Lines.ToList();
        string[] parts2 = DataLine().Split(' ');
        string[] secrets = Pins.Concat(new[] { t1, right.Token, ch.Token, again.Token, orderToken1, orderToken2, parts[3], parts[4], parts[5], parts2[3], parts2[4], parts2[5] }).ToArray();
        List<string> leaks = lines.Where(l => secrets.Any(s => l.Contains(s))).ToList();
        Check(lines.Count > 0 && leaks.Count == 0, "Output window: " + lines.Count + " lines, none with a PIN, the hash, the secret or a token" + (leaks.Count > 0 ? ": " + string.Join(" | ", leaks) : ""));
        Check(lines.Any(l => l.Contains("a PIN was set")) && lines.Any(l => l.Contains("PIN for ChartBridge's page was changed")), "Output window: set and change are noted (without values)");
    }

    // ------------------------------------------------------------ HTTP helpers (no proxy, forged Host allowed)
    class Reply
    {
        public int Status; public string Body = ""; public WebHeaderCollection Headers = new WebHeaderCollection();
        public string Token { get { Match m = Regex.Match(Body, "\"token\":\"(v1\\.[0-9a-f.]+)\""); return m.Success ? m.Groups[1].Value : null; } }
        public bool Is(int status, string body) { return Status == status && Body == body; }
    }

    static bool WaitUp()
    {
        for (int i = 0; i < 50; i++) { if (Get("/diag").Status == 200) return true; System.Threading.Thread.Sleep(100); }
        return false;
    }

    static Reply Get(string path) { return Send("GET", path, null, null, null, null, null); }
    static Reply Get(string path, string unlock) { return Send("GET", path, null, null, null, null, unlock); }
    static Reply Get(string path, string unlock, string host) { return Send("GET", path, null, null, null, host, unlock); }
    static Reply Post(string path, string body) { return Send("POST", path, body, Own, "application/json", null, null); }
    static Reply Post(string path, string body, string origin) { return Send("POST", path, body, origin, "application/json", null, null); }
    static Reply Post(string path, string body, string origin, string type) { return Send("POST", path, body, origin, type, null, null); }
    static Reply Post(string path, string body, string origin, string type, string host) { return Send("POST", path, body, origin, type, host, null); }
    static Reply Post(string path, string body, string origin, string type, string host, string unlock) { return Send("POST", path, body, origin, type, host, unlock); }

    static Reply Send(string method, string path, string body, string origin, string type, string host, string unlock)
    {
        Reply r = new Reply();
        HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + path);
        req.Proxy = null;
        req.Method = method;
        req.Host = host ?? "localhost:" + port;
        req.Timeout = 10000;
        req.KeepAlive = false;
        if (origin != null) req.Headers["Origin"] = origin;
        if (unlock != null) req.Headers[ChartBridgePin.Header] = unlock;
        try
        {
            if (body != null)
            {
                byte[] bytes = Encoding.UTF8.GetBytes(body);
                if (type != null) req.ContentType = type;
                req.ContentLength = bytes.Length;
                using (Stream s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
            }
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
            using (StreamReader rd = new StreamReader(res.GetResponseStream())) { r.Status = (int)res.StatusCode; r.Headers = res.Headers; r.Body = rd.ReadToEnd(); }
        }
        catch (WebException ex)
        {
            HttpWebResponse res = ex.Response as HttpWebResponse;
            r.Status = res != null ? (int)res.StatusCode : -1;
            if (res != null) { r.Headers = res.Headers; using (StreamReader rd = new StreamReader(res.GetResponseStream())) r.Body = rd.ReadToEnd(); }
            else r.Body = ex.Message;
        }
        return r;
    }

    static byte[] Hex(string s) { byte[] b = new byte[s.Length / 2]; for (int i = 0; i < b.Length; i++) b[i] = Convert.ToByte(s.Substring(i * 2, 2), 16); return b; }
    static string ToHex(byte[] b) { return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant(); }
}
