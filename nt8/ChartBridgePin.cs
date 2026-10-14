// ChartBridge PIN (0.3.2): a 4-digit lock on ChartBridge's own page. Part of the ChartBridge add-on; install
// it with the other add-on files listed in nt8\install-files.json (nt8\install.ps1 copies them all). See nt8/PROTOCOL.md, "PIN".
//
// A kid lock, not high security: it keeps someone else at this PC from opening http://localhost:8765/ and
// seeing or trading Anthony's accounts. Rules (Anthony, 2026-09-29):
//   - Anthony sets the PIN on this PC, from ChartBridge's page, once ("Set a PIN" shows while none is set).
//   - Only a salted PBKDF2-SHA256 hash is stored, in Documents\NinjaTrader 8\ChartBridge\pin.txt.
//   - NO lockout, ever: a wrong PIN is simply refused. Nothing is counted, nothing is delayed or blocked,
//     so a trade can always be managed.
//   - Once unlocked, a page stays unlocked while it is open, across ChartBridge restarts (F5): the page holds
//     an unlock token in memory (never in storage). The token is an HMAC-SHA256 of a random nonce, keyed by a
//     random secret kept in pin.txt next to the hash, so a restarted ChartBridge checks it from the file with
//     no state of its own. Changing the PIN keeps the secret (open pages stay unlocked); deleting pin.txt
//     (the forgotten-PIN recovery, fine while NinjaTrader runs) drops the secret with it, and a new PIN gets
//     a new secret, so tokens from before no longer work.
//   - What it gates: the WebSocket from ChartBridge's own page origin (?unlock=<token>) and GET /session
//     (header X-ChartBridge-Unlock). Origins listed in allowOrigins (The Desk, which has its own PIN) and
//     connections with no Origin (local programs such as The Desk's relay) are not affected.
//   - The PIN endpoints are POST only, from ChartBridge's own page only (the exact Origin check orders use),
//     Host localhost:<port>, JSON bodies of at most 256 bytes with only the keys named, 4 ASCII digits.
//   - Never logged: the PIN, the hash, the secret or a token. /diag says only whether a PIN is set.
// Written in C# 5 syntax (NinjaTrader 8 compiles NinjaScript as C# 5); .NET Framework 4.8 (Rfc2898DeriveBytes
// with HashAlgorithmName needs 4.7.2 or later).
#region Using declarations
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    public static class ChartBridgePin
    {
        public const string FileName = "pin.txt";
        public const string Header = "X-ChartBridge-Unlock";           // the page's unlock token on GET /session and the PIN endpoints
        // PBKDF2-HMAC-SHA256. 50,000 keeps an unlock well under a second on .NET Framework's managed loop (review S1:
        // about 0.2 s on Mono, 3 s at 600,000). No count protects 10,000 possible PINs offline, and the secret in the
        // same file makes offline cracking moot; the count only slows guessing at the pad, which is the threat here.
        public const int DefaultIterations = 50000;
        public const int MinIterations = 1000, MaxIterations = 1000000;   // a hand-edited count cannot make an unlock take a minute
        public const int MaxBodyBytes = 256;
        private const int SaltBytes = 16, HashBytes = 32, SecretBytes = 32, NonceBytes = 16;
        private const string TokenLabel = "chartbridge-unlock|v1|";
        private static readonly Regex TokenRx = new Regex("^v1\\.[0-9a-f]{32}\\.[0-9a-f]{64}\\z");
        private static readonly Regex HexRx = new Regex("^[0-9a-f]+\\z");
        private static readonly object FileLock = new object();

        // Iterations for a hash written from now on; pin.txt records its own count, so a file written with an
        // older count (0.3.2 before review: 600,000) still checks, and moves to this count on its next Change. Only the Mono harness lowers it (to run its many checks quickly).
        public static int NewHashIterations = DefaultIterations;

        public static string PinFile { get { return Path.Combine(ChartBridgeConfig.Folder, FileName); } }

        private class Stored { public int Iterations; public byte[] Salt, Hash, Secret; }

        // ---------------------------------------------------------- pin.txt
        // # comment lines, then: v1 pbkdf2-sha256 <iterations> <salt hex> <hash hex> <secret hex>
        // Three states, read once per request (review B1):
        //   Missing: no pin.txt. No PIN is set; "Set a PIN" is offered. The copy in memory is dropped, so deleting
        //            the file (the forgotten-PIN recovery) takes effect at once.
        //   Ok:      read and parsed. It becomes the last good copy.
        //   Broken:  pin.txt exists but cannot be read or parsed (held open by a backup or antivirus, an online-only
        //            cloud placeholder, a torn write). A PIN IS set: nothing may offer "Set a PIN" or overwrite the
        //            file. Tokens and unlocks are checked against the last good copy, so open pages keep working;
        //            with no good copy (ChartBridge started with a broken file) the PIN answers 503 until the file
        //            reads again or is deleted.
        public enum FileState { Missing, Ok, Broken }
        private class PinState { public FileState State; public string Problem; public Stored Rec; }
        private static volatile Stored lastGood;   // the last record read Ok (or written); used only while the file is Broken

        private static PinState Load()
        {
            string file = PinFile;
            if (!File.Exists(file)) { lastGood = null; return new PinState { State = FileState.Missing }; }
            string text;
            try
            {
                // ReadWrite | Delete sharing: never in the way of a File.Replace from a Change (review N3)
                using (FileStream fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (StreamReader r = new StreamReader(fs, Encoding.ASCII)) text = r.ReadToEnd();
            }
            catch (FileNotFoundException) { lastGood = null; return new PinState { State = FileState.Missing }; }
            catch (DirectoryNotFoundException) { lastGood = null; return new PinState { State = FileState.Missing }; }
            catch (Exception ex) { return Broken("cannot be read (" + ex.GetType().Name + ")"); }
            Stored parsed = Parse(text);
            if (parsed == null) return Broken("cannot be understood (damaged or incomplete)");
            lastGood = parsed;
            return new PinState { State = FileState.Ok, Rec = parsed };
        }

        private static double brokenLoggedMs = double.NegativeInfinity;

        private static PinState Broken(string problem)
        {
            Stored good = lastGood;
            double now = ChartBridgeTime.NowUtcMs();
            if (now - brokenLoggedMs >= 600000)   // one Output line per 10 minutes at most
            {
                brokenLoggedMs = now;
                ChartBridgeServer.Log("pin.txt " + problem + (good != null ? "; the PIN keeps working from the copy read earlier" : "; the PIN answers 503 until it reads again (delete pin.txt to set a new PIN)"));
            }
            return new PinState { State = FileState.Broken, Rec = good, Problem = problem };
        }

        private static Stored Parse(string text)
        {
            foreach (string raw in (text ?? "").Split('\n'))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line.StartsWith("#")) continue;
                string[] f = line.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                if (f.Length != 6 || f[0] != "v1" || f[1] != "pbkdf2-sha256") return null;
                int it;
                if (!int.TryParse(f[2], NumberStyles.None, CultureInfo.InvariantCulture, out it) || it < MinIterations || it > MaxIterations) return null;
                Stored s = new Stored { Iterations = it, Salt = FromHex(f[3]), Hash = FromHex(f[4]), Secret = FromHex(f[5]) };
                if (s.Salt == null || s.Salt.Length != SaltBytes || s.Hash == null || s.Hash.Length != HashBytes || s.Secret == null || s.Secret.Length != SecretBytes) return null;
                return s;
            }
            return null;
        }

        // Write to a temp file, flushed to disk, then swap it in, so a crash or power cut never leaves half a file.
        private static void Write(Stored s)
        {
            Directory.CreateDirectory(ChartBridgeConfig.Folder);
            string file = PinFile, tmp = file + ".tmp";
            string text =
                "# ChartBridge PIN: a salted PBKDF2-SHA256 hash of the PIN (never the PIN itself) and the key that keeps open pages unlocked.\r\n" +
                "# Forgot the PIN? Delete this file (NinjaTrader may stay open); ChartBridge's page then asks for a new PIN.\r\n" +
                "v1 pbkdf2-sha256 " + s.Iterations.ToString(CultureInfo.InvariantCulture) + " " + ToHex(s.Salt) + " " + ToHex(s.Hash) + " " + ToHex(s.Secret) + "\r\n";
            byte[] bytes = Encoding.ASCII.GetBytes(text);
            using (FileStream fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                fs.Write(bytes, 0, bytes.Length);
                fs.Flush(true);
            }
            if (File.Exists(file)) File.Replace(tmp, file, null); else File.Move(tmp, file);
            lastGood = s;
        }

        // A PIN is set unless pin.txt is missing (a broken file still means a PIN is set).
        public static bool IsSet { get { return Load().State != FileState.Missing; } }
        public static FileState FileStatus { get { return Load().State; } }

        private static Result Unreadable(PinState st)
        {
            return Fail(503, "pin.txt " + st.Problem + "; ChartBridge keeps trying. If it stays like this, delete pin.txt in ChartBridge's folder to set a new PIN");
        }

        // ---------------------------------------------------------- the PIN
        // Exactly four ASCII digits (not other scripts' digits, no spaces).
        public static bool ValidPin(string pin)
        {
            if (pin == null || pin.Length != 4) return false;
            foreach (char ch in pin) if (ch < '0' || ch > '9') return false;
            return true;
        }

        private static byte[] Derive(string pin, byte[] salt, int iterations)
        {
            using (Rfc2898DeriveBytes kdf = new Rfc2898DeriveBytes(Encoding.ASCII.GetBytes(pin), salt, iterations, HashAlgorithmName.SHA256))
                return kdf.GetBytes(HashBytes);
        }

        private static byte[] RandomBytes(int n)
        {
            byte[] b = new byte[n];
            using (RNGCryptoServiceProvider rng = new RNGCryptoServiceProvider()) rng.GetBytes(b);
            return b;
        }

        private static bool Matches(Stored s, string pin)
        {
            return s != null && ValidPin(pin) && SlowEquals(Derive(pin, s.Salt, s.Iterations), s.Hash);
        }

        // The outcome of a set, unlock or change: a token on success, else an HTTP status and a reason for the page.
        public class Result
        {
            public string Token;
            public int Status;
            public string Reason;
            public bool Ok { get { return Token != null; } }
        }
        private static Result Fail(int status, string reason) { return new Result { Status = status, Reason = reason }; }
        private static Result Done(string token) { return new Result { Token = token, Status = 200 }; }

        // Set a PIN when none is set. A new secret with it, so tokens from an earlier PIN file stay dead.
        public static Result Set(string pin)
        {
            if (!ValidPin(pin)) return Fail(400, "the PIN must be 4 digits");
            lock (FileLock)
            {
                PinState st = Load();
                if (st.State == FileState.Broken && st.Rec == null) return Unreadable(st);        // never written over: it may hold Anthony's PIN
                if (st.State != FileState.Missing) return Fail(409, "a PIN is already set on this PC; unlock with it, or change it once unlocked");
                byte[] salt = RandomBytes(SaltBytes);
                Stored s = new Stored { Iterations = NewHashIterations, Salt = salt, Hash = Derive(pin, salt, NewHashIterations), Secret = RandomBytes(SecretBytes) };
                try { Write(s); }
                catch (Exception ex) { ChartBridgeServer.Log("could not save the PIN file: " + ex.Message); return Fail(500, "ChartBridge could not save the PIN (see the NinjaScript Output window)"); }
                ChartBridgeServer.Log("a PIN was set for ChartBridge's page on this PC");
                return Done(MakeToken(s.Secret));
            }
        }

        // Unlock: the right PIN gets a token. A wrong one is refused, and that is all: no count, no delay, no lockout.
        public static Result Unlock(string pin)
        {
            if (!ValidPin(pin)) return Fail(400, "the PIN must be 4 digits");
            PinState st = Load();
            if (st.State == FileState.Missing) return Fail(409, "no PIN is set on this PC yet");
            if (st.Rec == null) return Unreadable(st);
            if (!Matches(st.Rec, pin)) return Fail(403, "wrong PIN");
            return Done(MakeToken(st.Rec.Secret));
        }

        // Change: needs the current PIN. The secret stays, so every page already open stays unlocked.
        public static Result Change(string pin, string newPin)
        {
            if (!ValidPin(pin) || !ValidPin(newPin)) return Fail(400, "each PIN must be 4 digits");
            lock (FileLock)
            {
                PinState st = Load();
                if (st.State == FileState.Missing) return Fail(409, "no PIN is set on this PC yet");
                if (st.State == FileState.Broken) return Unreadable(st);                         // only over a file that reads
                Stored s = st.Rec;
                if (!Matches(s, pin)) return Fail(403, "wrong PIN");
                byte[] salt = RandomBytes(SaltBytes);
                Stored n = new Stored { Iterations = NewHashIterations, Salt = salt, Hash = Derive(newPin, salt, NewHashIterations), Secret = s.Secret };
                try { Write(n); }
                catch (Exception ex) { ChartBridgeServer.Log("could not save the PIN file: " + ex.Message); return Fail(500, "ChartBridge could not save the PIN (see the NinjaScript Output window)"); }
                ChartBridgeServer.Log("the PIN for ChartBridge's page was changed");
                return Done(MakeToken(n.Secret));
            }
        }

        // ---------------------------------------------------------- the unlock token
        // v1.<nonce hex>.<HMAC-SHA256(secret, "chartbridge-unlock|v1|" + nonce hex) hex>. No expiry: a page stays
        // unlocked while it is open. It is only as good as the secret in pin.txt, which only this PC can read.
        private static string MakeToken(byte[] secret)
        {
            string nonce = ToHex(RandomBytes(NonceBytes));
            return "v1." + nonce + "." + ToHex(Mac(secret, nonce));
        }

        private static byte[] Mac(byte[] secret, string nonce)
        {
            using (HMACSHA256 h = new HMACSHA256(secret)) return h.ComputeHash(Encoding.ASCII.GetBytes(TokenLabel + nonce));
        }

        public static bool TokenValid(string token) { return TokenValid(token, null); }

        private static bool TokenValid(string token, PinState st)
        {
            if (token == null || !TokenRx.IsMatch(token)) return false;
            Stored s = (st ?? Load()).Rec;
            if (s == null) return false;
            string[] parts = token.Split('.');
            return SlowEquals(Mac(s.Secret, parts[1]), FromHex(parts[2]));
        }

        // Only ChartBridge's own page needs the PIN; compared the way the WebSocket origin rule compares it
        // (trimmed, lower-cased), so no spelling of the own origin gets past, whatever allowOrigins says.
        public static bool IsOwnOrigin(string origin)
        {
            return origin != null && origin.Trim().ToLowerInvariant() == ChartBridgeAccess.OwnOrigin;
        }

        // The WebSocket, after the address and Origin checks and before the upgrade: ChartBridge's own page must
        // bring a valid unlock token (?unlock=); allowOrigins pages and local programs (no Origin) keep 0.3.1's rules.
        public static bool WsUnlocked(string origin, string unlock)
        {
            if (!IsOwnOrigin(origin)) return true;
            return TokenValid(unlock);
        }

        // ---------------------------------------------------------- HTTP: POST /pin/status, /pin/set, /pin/unlock, /pin/change
        public static void Serve(HttpListenerContext ctx, string path)
        {
            HttpListenerRequest req = ctx.Request;
            if (req.HttpMethod != "POST") { ctx.Response.AddHeader("Allow", "POST"); Reply(ctx, 405, Reason("POST only")); return; }
            if (req.Headers["Host"] != "localhost:" + ChartBridgeConfig.Port) { Reply(ctx, 403, Reason("ask by the name localhost")); return; }
            if (!ChartBridgeOrders.OriginAllowed(req.Headers["Origin"])) { Reply(ctx, 403, Reason("only ChartBridge's own page")); return; }
            string type = (req.ContentType ?? "").Trim().ToLowerInvariant();
            if (type != "application/json" && !type.StartsWith("application/json;")) { Reply(ctx, 415, Reason("JSON only")); return; }
            string body = ReadBody(req);
            if (body == null) { Reply(ctx, 413, Reason("body too large")); return; }

            if (path == "/pin/status")
            {
                if (ParseFlat(body, new string[0]) == null) { Reply(ctx, 400, Reason("malformed request")); return; }
                PinState st = Load();                                        // one read for the whole answer
                if (st.State == FileState.Broken && st.Rec == null) { Reply(ctx, 503, Reason(Unreadable(st).Reason)); return; }
                bool set = st.State != FileState.Missing;
                bool unlocked = set && TokenValid(req.Headers[Header], st);
                Reply(ctx, 200, "{\"set\":" + (set ? "true" : "false") + ",\"unlocked\":" + (unlocked ? "true" : "false") + "}");
                return;
            }
            Dictionary<string, string> f;
            Result r;
            if (path == "/pin/set")
            {
                f = ParseFlat(body, new string[] { "pin" });
                r = f == null ? Fail(400, "malformed request") : Set(f["pin"]);
            }
            else if (path == "/pin/unlock")
            {
                f = ParseFlat(body, new string[] { "pin" });
                r = f == null ? Fail(400, "malformed request") : Unlock(f["pin"]);
            }
            else if (path == "/pin/change")
            {
                f = ParseFlat(body, new string[] { "pin", "newPin" });
                r = f == null ? Fail(400, "malformed request") : Change(f["pin"], f["newPin"]);
            }
            else { Reply(ctx, 404, Reason("not found")); return; }
            Reply(ctx, r.Status, r.Ok ? "{\"ok\":true,\"token\":" + CbJson.Str(r.Token) + "}" : Reason(r.Reason));
        }

        private static string Reason(string text) { return "{\"ok\":false,\"reason\":" + CbJson.Str(text) + "}"; }

        private static void Reply(HttpListenerContext ctx, int status, string json)
        {
            ChartBridgeServer.ServeText(ctx, status, json, "application/json");
        }

        // At most MaxBodyBytes, printable ASCII and plain whitespace only; null when over the limit or otherwise
        // unreadable (then the caller answers 413; anything else odd fails the strict parse as 400).
        private static string ReadBody(HttpListenerRequest req)
        {
            if (req.ContentLength64 > MaxBodyBytes) return null;
            byte[] buf = new byte[MaxBodyBytes + 1];
            int n = 0;
            try
            {
                Stream s = req.InputStream;
                int got;
                while (n < buf.Length && (got = s.Read(buf, n, buf.Length - n)) > 0) n += got;
            }
            catch (Exception) { return null; }
            if (n > MaxBodyBytes) return null;
            StringBuilder b = new StringBuilder(n);
            for (int i = 0; i < n; i++)
            {
                byte c = buf[i];
                if ((c < 0x20 && c != 0x09 && c != 0x0a && c != 0x0d) || c > 0x7e) return "\u0001";   // fails the parse
                b.Append((char)c);
            }
            return b.ToString();
        }

        // Strict: one flat JSON object whose keys are exactly `keys` (each once, any order), every value a string
        // of ASCII digits (at most 8, no escapes). Anything else (another key, a number, null, a nested object,
        // a duplicate, trailing text) is null. The digit count is checked afterwards (ValidPin).
        public static Dictionary<string, string> ParseFlat(string body, string[] keys)
        {
            if (body == null) return null;
            Dictionary<string, string> d = new Dictionary<string, string>();
            int i = 0, n = body.Length;
            SkipWs(body, ref i);
            if (i >= n || body[i] != '{') return null;
            i++;
            SkipWs(body, ref i);
            if (i < n && body[i] == '}') i++;
            else
            {
                for (;;)
                {
                    string key = QuotedRun(body, ref i, false);
                    if (key == null) return null;
                    SkipWs(body, ref i);
                    if (i >= n || body[i] != ':') return null;
                    i++;
                    SkipWs(body, ref i);
                    string val = QuotedRun(body, ref i, true);
                    if (val == null || d.ContainsKey(key) || Array.IndexOf(keys, key) < 0) return null;
                    d[key] = val;
                    SkipWs(body, ref i);
                    if (i < n && body[i] == ',') { i++; SkipWs(body, ref i); continue; }
                    if (i < n && body[i] == '}') { i++; break; }
                    return null;
                }
            }
            SkipWs(body, ref i);
            if (i != n || d.Count != keys.Length) return null;
            return d;
        }

        private static void SkipWs(string s, ref int i) { while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++; }

        // "..." made of ASCII letters (a key, at most 16) or ASCII digits (a value, at most 8); no escapes.
        private static string QuotedRun(string s, ref int i, bool digits)
        {
            if (i >= s.Length || s[i] != '"') return null;
            int start = ++i, max = digits ? 8 : 16;
            while (i < s.Length && s[i] != '"')
            {
                char c = s[i];
                bool ok = digits ? (c >= '0' && c <= '9') : ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
                if (!ok || i - start >= max) return null;
                i++;
            }
            if (i >= s.Length) return null;
            string run = s.Substring(start, i - start);
            i++;
            return !digits && run.Length == 0 ? null : run;
        }

        // For /diag: whether a PIN is set, nothing else.
        public static string DiagJson() { return "{\"set\":" + (IsSet ? "true" : "false") + "}"; }

        // ---------------------------------------------------------- helpers
        private static bool SlowEquals(byte[] a, byte[] b)
        {
            if (a == null || b == null || a.Length != b.Length) return false;
            int diff = 0;
            for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }

        private static string ToHex(byte[] b) { return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant(); }

        private static byte[] FromHex(string s)
        {
            if (s == null || s.Length % 2 != 0 || !HexRx.IsMatch(s)) return null;
            byte[] b = new byte[s.Length / 2];
            for (int i = 0; i < b.Length; i++) b[i] = byte.Parse(s.Substring(i * 2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            return b;
        }
    }
}
