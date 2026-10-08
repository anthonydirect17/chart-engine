// ChartBridge protocol v3 plumbing (ChartBridge 0.4.0), shared by every v3 feature. Part of the ChartBridge add-on.
// See nt8/PROTOCOL.md, "Protocol v3": "v3 switches", "Telling the page what is on" and "Strict messages in v3".
//
//   - ChartBridgeSwitches: the v3 switches (accountChecks, orderTypes, strategies, merge, cancelFromList, copier, bot), all ON
//     by default (Anthony 2026-10-07: no switches, no Sim locks). A config.txt line such as "merge = off" turns one off; nothing
//     needs turning on. It only records them; it never takes a key from another reader. trading = true stays the master switch.
//   - ChartBridgeV3: the helpers the v3 lanes call.
//       IsV3(client)      the page sent {"type":"client","v":3}; a connection that never did is a v2 page and gets no v3 message
//       AccountChecks, OrderTypes, Strategies, Merge, CancelFromList, Copier, Bot   each switch (true unless config.txt turns it off)
//       SwitchesJson()    {"accountChecks":false,...}: the "switches" of a v3 page's trading message (ChartBridgeAccounts.TradingFor)
//       Gate(client)      gates 1, 4 and 7 for a v3 action: trading on, the signed-in own page, and one of the 10 actions a second
//       Flat(text, type, keys, out why)   gate 8 as extended for v3, for a flat message (one level, no list, no escape)
//       Str, Bool, Whole  read a value Flat returned (null when absent or of another kind)
//       SendToV3Traders(json)   to every signed-in v3 page
// This file never places, changes or cancels an order. Written in C# 5 syntax (NinjaTrader 8 compiles NinjaScript as C# 5).
#region Using declarations
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text;
using NinjaTrader.Cbi;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    // ------------------------------------------------------------------ the v3 switches (PROTOCOL.md "v3 switches")
    // Anthony 2026-10-07: no switches, no Sim locks. Every v3 feature is ON as soon as ChartBridge 0.4.0 is installed; each key
    // stays only as an optional OFF line in config.txt ("merge = off"). trading = true stays the master switch above them all,
    // and nothing here ever changes it.
    public static class ChartBridgeSwitches
    {
        public static readonly string[] Names = { "accountChecks", "orderTypes", "strategies", "merge", "cancelFromList", "copier", "bot" };
        private static readonly bool[] Values = Names.Select(n => true).ToArray();   // the default: on

        // Every switch back to its default, on (ChartBridgeConfig.Load, before config.txt is read). The one place the switches'
        // default is set: no lane's ResetConfig touches a switch.
        public static void Reset() { lock (Values) for (int i = 0; i < Values.Length; i++) Values[i] = true; }

        // Called by ChartBridgeConfig.Load for every key. off, false and 0 turn the switch off (any case); on, true and 1 leave
        // it on. Any other value is read as OFF (only an off line has a reason to be there; lead's default), with one Output
        // line naming the key and the value.
        public static void Note(string key, string val)
        {
            int i = Array.IndexOf(Names, key);
            if (i < 0) return;
            string v = (val ?? "").Trim();
            bool on = v.Equals("on", StringComparison.OrdinalIgnoreCase) || v.Equals("true", StringComparison.OrdinalIgnoreCase) || v == "1";
            bool plainOff = v.Equals("off", StringComparison.OrdinalIgnoreCase) || v.Equals("false", StringComparison.OrdinalIgnoreCase) || v == "0";
            if (!on && !plainOff) ChartBridgeServer.Log("config.txt: " + key + " = " + v + " is not off or on, so " + key + " is OFF (" + key + " is on by default; the line is only needed to turn it off)");
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

    // ------------------------------------------------------------------ v3 pages and v3 messages
    public static class ChartBridgeV3
    {
        private static readonly ConditionalWeakTable<ChartBridgeClient, object> Pages = new ConditionalWeakTable<ChartBridgeClient, object>();

        public static bool IsV3(ChartBridgeClient c) { object o; return c != null && Pages.TryGetValue(c, out o); }

        // Review 2 finding 9: who placed an order, for a v3 page's order message only (ChartBridgeAccounts.ForPage), so a v2
        // page's order message stays exactly 0.3.8's: ,"by":"bot" for a bot order (its entry, named "CB#<tag> bot ...", or a leg
        // of one the bot channel follows), ,"by":"copier" for an order the copier placed on a follower; "" otherwise (an order
        // that already says "by", a strategy's, keeps it).
        private static readonly System.Text.RegularExpressions.Regex BotNameRx = new System.Text.RegularExpressions.Regex("^CB#[0-9a-f]{8} bot ");
        public static string OrderBy(Order o)
        {
            if (o == null) return "";
            try
            {
                string agent = ChartBridgeAgents.AgentOf(o);   // 0.5.0 agents: ,"by":"agent:<id>" for an agent's entry, its legs and its flat close
                if (agent != null) return ",\"by\":" + CbJson.Str("agent:" + agent);
                if (BotNameRx.IsMatch(o.Name ?? "") || ChartBridgeBot.Watching(o)) return ",\"by\":\"bot\"";
                if (ChartBridgeCopier.IsCopierOrder(o)) return ",\"by\":\"copier\"";
            }
            catch (Exception ex) { ChartBridgeServer.Log("order by error: " + ex.Message); }
            return "";
        }

        // 0.5.0 (fills to The Desk, contract section 8): who placed an order, when ChartBridge knows: "agent:<id>", "bot" or "copier";
        // null otherwise (the page's own orders, orders placed in NinjaTrader, an order not found).
        public static string SourceOf(Order o)
        {
            if (o == null) return null;
            string agent = ChartBridgeAgents.AgentOf(o);
            if (agent != null) return "agent:" + agent;
            if (BotNameRx.IsMatch(o.Name ?? "") || ChartBridgeBot.Watching(o)) return "bot";
            if (ChartBridgeCopier.IsCopierOrder(o)) return "copier";
            return null;
        }

        public static bool AccountChecks { get { return ChartBridgeSwitches.Get("accountChecks"); } }
        public static bool OrderTypes { get { return ChartBridgeSwitches.Get("orderTypes"); } }
        public static bool Strategies { get { return ChartBridgeSwitches.Get("strategies"); } }
        public static bool Merge { get { return ChartBridgeSwitches.Get("merge"); } }
        public static bool CancelFromList { get { return ChartBridgeSwitches.Get("cancelFromList"); } }
        public static bool Copier { get { return ChartBridgeSwitches.Get("copier"); } }
        public static bool Bot { get { return ChartBridgeSwitches.Get("bot"); } }
        public static string SwitchesJson() { return ChartBridgeSwitches.Json(); }

        // {"type":"client","v":3}: this connection is a v3 page. Anything else gets a status warn and the page stays v2.
        // Not a v3 action: no sign-in and no rate count. True when the page is (now) v3.
        public static bool OnClient(ChartBridgeClient client, string text)
        {
            string why;
            Dictionary<string, string> m = Flat(text, "client", new[] { "type", "v" }, out why);
            if (why == null && Whole(m, "v") != 3) why = "v must be 3";
            if (why != null) { client.Send("{\"type\":\"status\",\"level\":\"warn\",\"text\":" + CbJson.Str("ChartBridge refused a client message: " + why) + "}"); return false; }
            if (!IsV3(client)) { try { Pages.Add(client, true); } catch (ArgumentException) { } }   // two client messages at once: already v3
            return true;
        }

        // Gates 1, 4 and 7 for every v3 action (Strict messages in v3: "Rate", "Sign-in"): null when it may go on.
        public static string Gate(ChartBridgeClient client) { return ChartBridgeOrders.Gate(client); }

        // Integration: the one v3 handshake tells every lane that keeps v3 state for a signed-in page (each checks the page is
        // signed in and v3, and its own switch, so a v2 page or a page not signed in gets nothing).
        public static void TellLanes(ChartBridgeClient client)
        {
            try { ChartBridgeCopier.AfterAuth(client); } catch (Exception ex) { ChartBridgeServer.Log("copier error: " + ex.Message); }
            try { ChartBridgeBot.AfterAuth(client); } catch (Exception ex) { ChartBridgeServer.Log("bot error: " + ex.Message); }
            try { ChartBridgeAgents.AfterAuth(client); } catch (Exception ex) { ChartBridgeServer.Log("agents error: " + ex.Message); }   // 0.5.0 agents
            try { ChartBridgeOrders.SendManagedAfterClient(client); } catch (Exception ex) { ChartBridgeServer.Log("managed error: " + ex.Message); }
        }

        public static void SendToV3Traders(string json)
        {
            foreach (ChartBridgeClient c in ChartBridgeServer.AllClients()) if (c.Trader && IsV3(c)) c.Send(json);
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
        public static string Str(Dictionary<string, string> m, string key)
        {
            string raw;
            if (m == null || !m.TryGetValue(key, out raw) || raw.Length < 2 || raw[0] != '"') return null;
            return raw.Substring(1, raw.Length - 2);
        }

        // true or false, or null when absent or not a bool.
        public static bool? Bool(Dictionary<string, string> m, string key)
        {
            string raw;
            if (m == null || !m.TryGetValue(key, out raw)) return null;
            return raw == "true" ? true : raw == "false" ? (bool?)false : null;
        }

        // A plain whole number (gate 8: no quotes, decimals, exponent or leading zero, at most 9 digits), or null.
        public static int? Whole(Dictionary<string, string> m, string key)
        {
            string raw;
            int v;
            if (m == null || !m.TryGetValue(key, out raw) || !System.Text.RegularExpressions.Regex.IsMatch(raw, "^-?(?:0|[1-9][0-9]{0,8})$")) return null;
            return int.TryParse(raw, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out v) ? v : (int?)null;
        }
    }
}
