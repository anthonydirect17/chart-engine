# ChartBridge protocol (v1 market data and fills, v2 orders, v3 accounts, strategies, copier and bot)

ChartBridge is a NinjaTrader 8 add-on. It serves the live chart page at `http://localhost:8765/` and
talks to it over one WebSocket at `ws://localhost:8765/ws`. Everything stays on the local machine.
**Read only by default.** Nothing in v1 can place, change or cancel an order. Order entry (v2, ChartBridge
0.3.0 and later) is off unless `config.txt` has `trading = true`; see "Orders (protocol v2)" below.
ChartBridge's own page is locked with a 4-digit PIN since 0.3.2; see "PIN" below.
Since 0.4.0 (protocol v3) ChartBridge adds per-account trading checkmarks, more order types, Order Strategies, Merge,
quote-only markets, a Sim-only copier and a bot channel, each off until `config.txt` turns it on; see "Protocol v3
(ChartBridge 0.4.0)" at the end. v3 only adds: every rule before it stands.
Since 0.3.4 every trade, live and in the backfill, carries its side (buy or sell) and how it was found; see
"Trade side" below.
Since 0.3.8 a resting (limit or stop) entry's planned stop and target are DISTANCES IN TICKS from its actual fill,
travelling with the entry when it is moved, like a NinjaTrader ATM (Anthony, 2026-10-01; this replaces 0.3.7's planned
prices): a `plan` message sets them, and `planned` on its `order` messages reports them; no 200-tick limits unless
`config.txt` sets them (0.3.7); see "Planned stop and target on a resting entry (0.3.8)" below. Since 0.3.7 ChartBridge
also sends NinjaTrader's prior settlement, NinjaTrader's own 4h, 1D and 1W bars on
request, and the last 5 sessions' volume at price on request; see "Settlement, higher-timeframe bars and the weekly
profile (0.3.7)" below. A page that does not know these messages ignores them (the live page's message switch has no
default case, so an unknown type does nothing).

## Network access (0.3.1)

**This PC only.** Windows' web server under HttpListener (HTTP.sys) listens on every network interface and
matches only the `Host` header, so the prefix `http://localhost:8765/` does not by itself keep other devices
out: on the trading PC (2026-09-29) a request to the Wi-Fi or Tailscale address with a forged
`Host: localhost:8765` was answered, including `/diag`. So ChartBridge checks every request first, on
every path (page files, `/diag`, `/session`, `/ws`), before any routing: the source address must be loopback
(`127.0.0.0/8`, `::1`, or IPv4 loopback mapped into IPv6, `::ffff:127.0.0.1`). Anything else, including a
request whose address cannot be read, gets **403** with no body. A refusal is logged in the Output window once
an hour per address, and a refused WebSocket origin once an hour per origin. Addresses and origins each have
a budget of 1000 an hour, so a scan cannot flood the window; when one fills, a single line says further
refusals are not logged this hour (they are still refused and counted in `/diag`). ChartBridge does not change
HTTP.sys's system-wide listen list (other programs use it).

**Which web pages may read.** A browser always sends an `Origin` header with a WebSocket. The WebSocket at
`/ws` takes a browser only from ChartBridge's own page (`http://localhost:<port>`) or from an origin listed
in `config.txt`:

```
allowOrigins = https://desk.golivepage.com, http://100.88.192.33:8800
```

Each entry is an exact `scheme://host[:port]` (http or https), compared lower-cased; a default port (`:80`,
`:443`) and a trailing slash are dropped, because a browser's `Origin` has neither. No wildcards; an entry with
a path, a `*` or `null` is skipped with a line in the Output window. A host name with non-ASCII letters must be
written in punycode (`xn--...`), as the browser sends it; otherwise it is skipped. Put every origin on one line: if
`config.txt` has several `allowOrigins` lines, **the last one wins**. The line above covers The Desk as it runs
now; if The Desk is ever opened at `http://localhost:8800` or `http://127.0.0.1:8800`, add that origin too, or its
Live trading page is refused (403) and cannot read from ChartBridge. Any other origin, `Origin: null` (sandboxed
frames, `file://` pages) and an empty `Origin` get **403** before the WebSocket opens. A connection with **no**
`Origin` header is not a browser (a local program such as The Desk's server relay) and is allowed: the address
check already limits it to this PC. Without this, any web site open in the browser could connect to
`ws://localhost:8765/ws` and read account names, fills and CME ticks.

**Trading stays stricter.** An `allowOrigins` page can read the stream but can never sign in or trade: orders
need ChartBridge's own page (gate 4 below, unchanged).

**Never forward anything to 8765.** Do not point any local proxy, tunnel or port forward at port 8765: no
cloudflared ingress, no `tailscale serve` or `tailscale funnel`, no `netsh interface portproxy`, no `ssh -R`, no
local reverse proxy. A forwarded client reaches ChartBridge from the forwarding program on this PC, so it
arrives as 127.0.0.1, and the loopback rule cannot tell it from a local one. Through such a forward, a remote
client could read `/session`, send ChartBridge's own Origin and, with `trading = true`, trade.

**The rules are about other machines and web pages, not local software.** Any program running on this PC can
connect from 127.0.0.1 and send any `Origin` header it likes (including ChartBridge's own), so neither the
loopback rule nor the Origin list is a guard against local software. The Origin list stops web pages open in
a browser (a browser always sends the true Origin); the loopback rule stops other devices. Keep untrusted
programs off the trading PC.

**Second layer.** A Windows firewall rule blocking inbound TCP 8765 is still recommended (admin PowerShell:
`New-NetFirewallRule -DisplayName "ChartBridge 8765 block inbound" -Direction Inbound -Protocol TCP -LocalPort 8765 -Action Block`).
The firewall does not filter traffic within the PC. Safety does not rest on it.

**One-time check on the trading PC** (after installing 0.3.1; from another device, or from the PC itself to its
own Tailscale or LAN address, which is not loopback). Both must print `HTTP/1.1 403` and no body; with the
firewall rule on, a request from another device may simply time out instead, which is also fine:

```
curl -i -H "Host: localhost:8765" http://<tailscale or LAN ip>:8765/diag
curl -i -H "Host: localhost:8765" -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" http://<tailscale or LAN ip>:8765/ws
```

The second one matters most: the WebSocket upgrade cannot be run in the Linux test harness (Mono has no server
WebSocket), so there the order of the checks is only guarded in the source.

`/diag` shows the rules in force under `network`: `loopbackOnly` (true), `allowOrigins` (ChartBridge's own page
first, then the listed ones; not secret), `refusedNotThisPc` and `refusedOrigin` (refusals since the start).

## PIN (0.3.2)

ChartBridge's own page is locked with a 4-digit PIN. Rules (Anthony, 2026-09-29): a kid lock, not high
security; Anthony sets the PIN on each PC; **no lockout, ever** (a wrong PIN is refused, nothing is counted,
delayed or blocked, so a trade can always be managed); and nothing may send an open page back to the PIN
while a trade could be open.

**What it gates.** Only ChartBridge's own page (`Origin` `http://localhost:<port>`, compared trimmed and
lower-cased like the WebSocket origin rule, whatever `allowOrigins` says):

- the WebSocket: the page connects to `/ws?unlock=<token>`; without a valid token the upgrade gets **403**
  before it happens, so no `hello`, fills or ticks are sent. The check sits after the address and Origin
  checks and before the upgrade;
- `GET /session` (the order sign-in token): it needs the header `X-ChartBridge-Unlock: <token>` as well as the
  `Host` check, or it gets **403**.

Origins listed in `allowOrigins` (The Desk's Live tab, which has its own PIN) and connections with no `Origin`
(local programs such as The Desk's relay) keep the 0.3.1 rules and never need ChartBridge's PIN. Every order
gate below is unchanged (Armed off after a reload, own page only, caps and the rest). The page files
themselves are served as before, so the page can show the pad.

**Storage.** `Documents\NinjaTrader 8\ChartBridge\pin.txt`, one data line after two `#` comment lines:

```
v1 pbkdf2-sha256 <iterations> <salt, 16 bytes hex> <hash, 32 bytes hex> <secret, 32 bytes hex>
```

The hash is PBKDF2-HMAC-SHA256 of the PIN's four ASCII digits (`Rfc2898DeriveBytes` with
`HashAlgorithmName.SHA256`, .NET Framework 4.7.2 and later) at 50,000 iterations for a new PIN, which keeps an
unlock well under a second on .NET Framework's managed loop. No count protects 10,000 possible PINs against
someone who can read the file, and the secret in the same file makes that moot; the count only slows guessing at
the pad. The file records its own count (1,000 to 1,000,000 accepted), so a file written at 600,000 by the first
0.3.2 build still works and moves to 50,000 on its next Change. The secret is random and signs unlock tokens.
The file is written to a temp file, flushed to disk, and swapped in; it is read once per request, sharing
read, write and delete so it never gets in the way of a swap.

**Three states** (review B1): pin.txt is

- **missing**: no PIN is set, and "Set a PIN" is offered. Deleting the file takes effect at once.
- **ok**: read and parsed. ChartBridge keeps this last good copy in memory.
- **broken**: it exists but cannot be read or understood (held open by a backup or antivirus, an online-only
  cloud placeholder, a torn or empty file). A PIN is still set: nothing offers "Set a PIN" and nothing writes
  over the file. Tokens and unlocks are checked against the last good copy, so open pages keep working. With no
  good copy (ChartBridge started with a damaged file), the PIN endpoints answer **503** with the reason, the page
  keeps its unlock and waits, and it recovers by itself once the file reads again. If it stays broken, delete
  it to set a new PIN. The Output window says so at most once every 10 minutes.

**The unlock token and a restart (F5).** A successful set, unlock or change answers a token:
`v1.<nonce, 16 random bytes hex>.<HMAC-SHA256(secret, "chartbridge-unlock|v1|" + nonce) hex>`. It has no expiry
(a page stays unlocked while it is open). ChartBridge keeps no list of tokens: it checks one by recomputing
the HMAC with the secret from `pin.txt` (constant-time compare). So a restarted ChartBridge (a recompile, or
NinjaTrader restarted) accepts a token issued before the restart, because the secret survived on disk. The page
holds its token in memory only (never localStorage, sessionStorage, a cookie or the URL bar). When ChartBridge
goes away, the page keeps retrying as always; on every reconnect it first asks `POST /pin/status` with its token
and then opens `/ws?unlock=<token>` and signs in again with a fresh `GET /session`. It shows the PIN pad again
only when ChartBridge **answers** that the token no longer holds (`set` false, or `unlocked` false); a status
call that fails (ChartBridge down or restarting) keeps the unlock. A reload starts a new page, so it asks for
the PIN again (and Armed is off, as always).

- **Change** keeps the secret: every page already unlocked stays unlocked.
- **Forgotten PIN**: delete `pin.txt` (NinjaTrader may keep running, no recompile). ChartBridge answers
  "no PIN set", and the page shows **Set a PIN** the next time it opens or reconnects. The secret goes with
  the file and a new PIN gets a new one, so tokens from before stop working. A connection already open is not
  cut; it asks for the new PIN on its next reconnect. Only someone at this PC can delete the file.
- Anyone who can read `pin.txt` could make a token: that is anyone at this PC, which the PIN is not meant to
  stop anyway (a kid lock). The secret never leaves the file.

**Endpoints** (all `POST`, from ChartBridge's own page only: the exact `Origin` check orders use, no case
folding; `Host` must be `localhost:<port>`; loopback only, like every request; `Content-Type:
application/json`; a body of at most 256 bytes; one flat JSON object with exactly the keys named, each a
string of four ASCII digits; anything else is refused. No CORS headers; `Cache-Control: no-store`.)

| path | body | answer |
|---|---|---|
| `/pin/status` | `{}` (and the `X-ChartBridge-Unlock` header, when the page has a token) | `200 {"set": bool, "unlocked": bool}`; `503` while pin.txt is broken with no good copy |
| `/pin/set` | `{"pin":"dddd"}` | `200 {"ok":true,"token":"..."}`; `409` when a PIN is already set; `503` while pin.txt is broken with no good copy |
| `/pin/unlock` | `{"pin":"dddd"}` | `200 {"ok":true,"token":"..."}`; `403 {"ok":false,"reason":"wrong PIN"}`; `409` when none is set |
| `/pin/change` | `{"pin":"<current>","newPin":"dddd"}` | `200 {"ok":true,"token":"..."}`; `403` when the current PIN is wrong; `409` when none is set; `503` while pin.txt is broken (it is only written over a file that reads) |

Other answers: `405` (not POST), `403` (another origin or host), `415` (not JSON), `413` (over 256 bytes),
`400` (anything malformed), `404` (another `/pin/` path). ChartBridge 0.3.1 and older answer `404` to
`/pin/status`; the page then goes on without a PIN, as before, and checks again on every reconnect, so an
upgrade under an open page asks for the PIN then.

**The page** asks for the PIN again only when ChartBridge answers `set` false or `unlocked` false. It keeps its
token while the pad shows and asks again every 2 seconds, so the pad closes by itself if the unlock holds again.
Any other answer (a 500 or 503, or no answer) keeps the unlock. A `GET /session` that is refused is retried
after a status check 2 seconds later; if the unlock is gone, the page drops the connection and the reconnect
shows the pad.

**First run and revoking.** On a fresh PC, whoever opens the page first sets the PIN, so Anthony should open it
and set the PIN right after installing. Deleting pin.txt revokes every page: each one asks for the new PIN on its
next reconnect.

**Never logged**: the PIN, the hash, the secret or any token (the Output window notes only that a PIN was set
or changed; the refusal log takes the path without its query). `/diag` shows `"pin": {"set": true|false}` and
nothing else about the PIN.

## Messages

All messages are JSON text. Times:

- `t`: exchange wall-clock seconds stored as if UTC (New York time for CME), fractional for ticks.
  This is the chart-engine convention.
- `u`: real UTC milliseconds since 1970 (used only for delay measurement).

Bars are stamped with their **start** time. NinjaTrader stamps bars at their close; the add-on converts.

## Server to page

| type | fields | when |
|---|---|---|
| `hello` | `version`, `now` (UTC ms), `instruments`: `[{root, name, tick, pointValue, settlement, settlementDate}]` (0.3.7: `settlement` the prior session's settlement for that contract, null when ChartBridge has no dated value for it; `settlementDate` the trading date it settles, `yyyy-MM-dd`), `accounts`: `[name]`, `trading` (0.3.0 and later: the `trading` object below, always with `enabled` false until the page signs in), `features` (0.3.5: `["liveFirst", "profile"]`, see Served window and session table; 0.3.7 adds `"settlement"`, `"htf"`, `"weekProfile"`) | on connect |
| `history` | `root`, `name`, `barSeconds` (60), `sub` (0.3.3), `bars`: `[[t,o,h,l,c,v], ...]`, `done` (bool) | after `subscribe`, chunked. Since 0.3.3 the history is split: the chunks before the last minute (the last of them now says `done` false), then the last (forming) minute in its own message with `done` true, rebuilt from trades when it can be (see Backfill and live below) |
| `ticks` | `root`, `sub` (0.3.3), `ticks`: `[[t,p,v], ...]`, since 0.3.4 `[[t,p,v,s,sm], ...]` (side and method, see Trade side; the first three keep their places); 0.3.7 sends `[t,p,v]` again; since 0.3.8 a trade with a known Time and Sales category is `[t,p,v,null,null,q]` (see Time and Sales category), `done` (bool) | after `history`, the current session's trades, chunked |
| `ready` | `root`, `sub` (0.3.3) | history and tick backfill complete; live ticks follow (since 0.3.3 only those not already in the backfill; see Backfill and live below) |
| `profile` | `root`, `sub` (the load's; none when pushed after the session's backfill), `tick`, `bucketSeconds` (1800), `session` and `last`: `{from, whole, coveredFrom, rows: [[t, priceTicks, v], ...]}` or null (0.3.5, see Served window and session table) | right before `ready` when the subscribe asked for it; again, without `sub`, when the session's one backfill makes the table whole |
| `tick` | `root`, `t`, `u`, `rx` (UTC ms when the add-on received it), `p`, `v`, and since 0.3.4 `s`, `sm` (side and method, see Trade side), since 0.3.8 `q` (Time and Sales category, see there; absent when unknown) | every trade, live |
| `execs` | `list`: `[exec]` | on connect: executions NinjaTrader already has for today |
| `exec` | `account`, `name` (e.g. `MNQ 12-26`), `root`, `side` (`buy`/`sell`), `qty`, `p`, `t`, `u`, `id`, `order` | each new fill, live (see Fills below) |
| `status` | `level` (`info`/`warn`/`error`), `text` | problems worth showing on the page; since 0.3.7 also a refused `htf` or `weekProfile` request (`warn`, "ChartBridge refused a htf message: why") |
| `settlement` | `root`, `p` (null when none is known), `date` (the trading date it settles, `yyyy-MM-dd`) (0.3.7) | when the prior settlement changes: a value for that date comes in, or a new session starts at 18:00 ET and the day before becomes the prior |
| `htf` | `root`, `tf` (`4h`, `1D`, `1W`), `id` (the request's, or null), `name` (the contract, or null with an error), `bars`: `[[t,o,h,l,c,v], ...]` oldest first, the last one forming, `error` (null, or why there are no bars) (0.3.7) | the answer to an `htf` request |
| `htfBar` | `root`, `tf`, `bars`: one or two `[t,o,h,l,c,v]` (0.3.7) | while a page has asked for that root and timeframe, at most once a second when its forming bar changed: the forming bar, after the closed bar's final values when a new bar began |
| `weekProfile` | `root`, `id` (or null), `tick`, `sessions`: `[{date, from, whole, coveredFrom, drop, rows: [[priceTicks, v], ...]}` or `{date, missing}]` oldest first, `rows` (the sessions present, added up), `error` (null, or why there is nothing) (0.3.7) | the answer to a `weekProfile` request |

## Page to server

| type | fields |
|---|---|
| `subscribe` | `root` (`MNQ`, `NQ`, `MES`, `ES`), `days` (1m history, default 5), `tickHours` (tick backfill cap, default 8), `sub` (0.3.3, optional: a whole number of up to 15 digits, echoed as a plain number without leading zeros on that load's `history`, `ticks` and `ready`; without it ChartBridge numbers the page's subscribes 1, 2, 3, ...), `liveFirst` (sent by chart 1.8.0; ChartBridge 0.3.5 gives every subscribe with `tickHours` above 0 the served window, with or without it), `profile` (0.3.5: send the `profile` message) |
| `ping` | `c` (page clock, echoed back in a `pong` with the server clock `s`) |
| `htf` | `root`, `tf` (`4h`, `1D` or `1W`), `id` (optional) (0.3.7, strict: see below) |
| `weekProfile` | `root`, `id` (optional) (0.3.7, strict: see below) |

## Backfill and live: one seam (0.3.3)

(0.3.7: the by-date tick backfill this section was written for is removed; since 0.3.5 every tick chart gets the served
window instead. The seam rule itself is unchanged and is what joins the served window, the session backfill and a minute
chart's last trades to the live trades. The parts below about the tick request asking past now and its retry ending now
describe 0.3.3 to 0.3.6; the session backfill still asks 60 minutes past now.)

A subscribe starts holding that instrument's live trades, then asks NinjaTrader for the minute history and,
when that is back, for the tick backfill. The two streams overlap: a trade that happened just before the tick
request was answered can be both in the backfill and held live. Before 0.3.3 ChartBridge sent both, and trades
carry no id, so the page counted such a trade twice (range bars, the forming minute, VWAP, volume). ChartBridge
now decides the seam by one rule before it sends `ready`:

- **T** is the time of the last backfill trade. Both sides are compared on NinjaTrader's own times for the
  trades (the backfill's bar times and each live trade's time, in NinjaTrader's time zone), never the PC clock.
- A held trade **before T** is in the backfill already: it is not sent.
- **At exactly T**, as many held trades are not sent as the backfill has at T with the same price and volume
  (a multiset match: two real trades can share price, size and time).
  - At **whole-second** resolution only trades already held when NinjaTrader answered the tick request may match
    (ChartBridge counts them in the answer's callback, right after copying the answer, under the same lock the
    live trades are held with: `heldAtAnswer`). There "at T" is a whole second, and a trade held after the
    answer, later in that second, is a real trade the backfill cannot have: it is always sent.
  - At **millisecond** resolution every held trade may match. That is exact whatever order NinjaTrader delivers
    in: a real trade that nobody held in the same millisecond as T is negligible.
- The rest go out after `ready`, in the order they arrived; then live trades go straight out.

The whole-second gate assumes NinjaTrader hands a live trade to ChartBridge before, not after, it is in a tick
answer. Two `/diag` counters show whether that holds:

- `olderAfterAnswer`: trades held after the answer whose time is before T. When the order holds this cannot
  happen (short of out-of-order time stamps), at either resolution: any value above 0 means NinjaTrader delivers
  some live trades after they are already in its answer.
- `droppedAfterAnswer`: trades held after the answer that matched a backfill trade at T. At millisecond
  resolution (where they are dropped) it should be 0 on nearly every load if the order holds. At whole seconds
  (where they are sent) it is normal: real trades later in T's second often share price and size.

**Time resolution.** Times are compared at the coarser step of the two sides: millisecond when both carry
milliseconds (NinjaTrader 8 keeps them on tick data from most connections), whole seconds when a side's trades
near the seam (the backfill's last 64, the first 64 held) all sit on whole seconds and there are at least 20 of
them. A backfill shorter than 20 trades counts as whole seconds when every trade in it does (it was read whole;
a millisecond backfill of a few trades all landing on .000 by chance is the accepted risk). Fewer than 20 held
trades never make it whole seconds. In whole seconds "at T" is the whole second: a trade held before the answer
but after NinjaTrader took its snapshot, later in that second, with the same price and size as a backfill trade
in it, is taken for a duplicate. That needs the callback to lag the snapshot inside the trade's second, so it is
rare (the review's simulation: about 1% of fast loads, 0.01 trades a load). `/diag` shows the resolution in force
(`resolutionMs`).

**The tick request asks past now.** NinjaTrader's help for BarsRequest says: "When using the DateTime fromLocal
and toLocal parameters, the dates are converted to local daily timestamps (12:00 AM) and return a BarsRequest
representing full trading days." So the time of day should not cut the backfill at all; it holds what NinjaTrader
has when it answers. In case a connection does cut at the time, the request ends 60 minutes past the PC's
"now" (`TickToMarginMinutes`), so the backfill still reaches past the moment the hold began even with the PC
clock behind the data's clock. No trade exists in the future, so this can only add. If a request ending in the
future is refused, or comes back with no trades at all, it is asked once more ending now (0.3.2's request);
`/diag` shows it (`tickRetriedEndingNow`).

**The forming minute.** The minute history's last bar was still forming when NinjaTrader answered, so it can hold
trades that are also held live, and misses later ones. ChartBridge sends it last, rebuilt from the same trades
the held ones are matched against, so minute bars and trades meet at the same seam. Time bars are stamped at
their close, so a trade at exactly hh:mm:00.000 belongs to the bar that ends then: the rebuild takes trades
strictly after the forming minute's start (believed to be NinjaTrader's rule; a live check, recipe below). With a tick
backfill (seconds and range charts) those are the backfill's trades. Without one (`tickHours` 0: minute and hour
charts) ChartBridge asks NinjaTrader for the last 20,000 trades (`SeamTicksBack`, a BarsRequest by count), uses
them only for this, and does not send them to the page. NinjaTrader's bar is kept, and on minute charts every
held trade is released as in 0.3.2, when the trades do not reach back to the minute's start, when none fall in
it, or when the rebuilt minute has less volume than NinjaTrader's (the trades lag the minute data).
`/diag` shows both volumes (`ntTailVolume`, `rebuiltTailVolume`). They cannot settle the boundary rule on their
own: the rebuilt minute also has the trades after NinjaTrader's answer, so it is usually larger either way.

**Live check of the minute boundary (a recipe).** On the trading PC, in a busy session:

1. Pick a closed minute M (start S, end E = S + 60 s) with a trade stamped exactly at S (hh:mm:00.000) or at E.
   To see the trades with their sub-second times, export the contract's Tick data for today (Tools > Historical
   Data, Export; NinjaTrader 8 writes tick times with a 7-digit fraction of a second) and find the lines at S and E.
2. Add up the trade volumes in (S, E], that is after S up to and including E, and in [S, E), that is from S up
   to but not including E.
3. Compare with NinjaTrader's volume on the 1-minute bar stamped E (bars are stamped at their close).
   - It equals the (S, E] sum: end-inclusive, the rule ChartBridge follows. Nothing to change.
   - It equals the [S, E) sum: start-inclusive. Then `ChartBridgeSeam.TailFromTicks` must take trades at or
     after the start (`>=` in place of `>`, and floor in place of the end-inclusive bucket), and the two harness
     tests that pin the boundary change with it.
   - Neither: the minute and tick data disagree; write down both sums and NinjaTrader's volume.
4. Repeat for two or three minutes; one trade exactly on the boundary is enough to tell, when its volume differs
   from the sums' other trades.

**The page builds minute bars start-inclusive** (`live/bar-builder.js` floors the time, and the page feeds ticks at
or after the current minute's start). If NinjaTrader is end-inclusive, the page (on seconds and range charts,
where it rebuilds the forming minute itself) counts a trade at exactly that start in NinjaTrader's previous bar and
again in its own. This is unchanged since 0.3.2, only on that exact millisecond, and a page-side follow-up (feed
ticks strictly after the cutoff and bucket end-inclusive), not in ChartBridge.

**Minute charts wait for that request.** `ready` now comes after the 20,000-trade answer. ChartBridge's own work
on it (copy, rebuild, match against 3,000 held trades) takes about 1 ms in the Mono harness; the time NinjaTrader
takes to answer (it may load a day of ticks the first time) can only be measured on the trading PC: `loadMs` in
`/diag`.

**A newer subscribe wins.** Once the page subscribes again (for example for more tick hours), ChartBridge sends
nothing more of the older load: every `history` and `ticks` chunk and `ready` is checked first. A chunk already
queued or on the wire before the new subscribe arrived still reaches the page. So `history`, `ticks` and `ready`
carry `sub`, the page's subscribe id (or ChartBridge's count), and a page that sends `sub` can drop anything with
another id. The live page does not send it yet (a follow-up in `live/`).

**What is still open.**

- A gap is still possible if NinjaTrader's history lags its live data (the provider's history server a few
  seconds behind): trades after the backfill's end that arrived before the hold began are in neither stream.
  The rule cannot recover them; `/diag` shows whether the streams overlapped (`overlapMs`).
- The whole-second case above, and the order assumption behind `heldAtAnswer` (whole seconds only; watch
  `olderAfterAnswer`).
- The minute boundary rule is believed, not yet checked on a live PC.
- Until the page uses `sub`, a stale chunk already queued when the page resubscribed can still mix in.
- Pre-existing: each page has an outbox of 5,000 messages; a page that does not keep up is closed. The held
  trades are released into it in one burst, so a very long load in a very busy market could reach that bound.
  Fixed in 0.3.4: the release is one outbox entry (see Trade side).

The page needs no change to work with 0.3.3: it takes history, ticks and live trades as before, and ignores `sub`.

## Trade side (0.3.4)

For cumulative delta every trade carries its side: a market buy (the aggressor lifted the ask) or a market sell
(the aggressor hit the bid). Delta is buy volume minus sell volume.

| field | values |
|---|---|
| `s` | `1` buy, `-1` sell, `0` unknown |
| `sm` | how it was found: `0` none (unknown), `1` the exchange's aggressor flag, `2` bid/ask, `3` tick rule |

On a live `tick` they are two more fields; in `ticks` each trade is `[t, p, v, s, sm]`, the first three unchanged
in place, so a page that reads only `t, p, v` (the live page up to chart 1.5.3) works as before. A trade from an
older ChartBridge has neither: treat it as unknown.

**The rule** (Anthony, 2026-09-29), in order:

1. The exchange's aggressor flag (`sm` 1). NinjaTrader 8 gives an add-on none (MarketDataEventArgs has Ask, Bid,
   Instrument, IsReset, MarketDataType, Price, Time and Volume only), so code 1 is reserved and not sent today.
2. The prevailing quote (`sm` 2): at or above the ask a buy, at or below the bid a sell. The quote needs both sides,
   above zero, bid below ask; a crossed or locked quote is not used.
3. The tick rule (`sm` 3), for a trade between bid and ask or with no usable quote: above the previous trade's price
   a buy, below it a sell, at the same price the previous trade's side (Lee-Ready). Anthony kept this over
   NinjaTrader's rule for between-quote trades (the previous trade's side whatever the price), 2026-09-30.
4. No usable quote and no previous trade (or an unchanged price after an unknown one): `s` 0, `sm` 0.

**The session** (Anthony, 2026-09-30): nothing carries across the 17:00 to 18:00 ET break (or a weekend). At 18:00
New York time (daylight saving included, the page's session start too) the tick rule starts over: the first trade of
a session between the quotes, or with no usable quote, is `s` 0. This holds live, in the backfill (`sessionStarts` in
`/diag` counts the boundaries it crossed) and for the held trades released after a load's seam.

Prices are compared on a 0.000001 grid (float noise is the same price).

**The prevailing quote, live and in the backfill alike**, is the last bid and the last ask stamped **strictly
before** the trade, on NinjaTrader's own times for them. The tie rule: a quote stamped at the trade's own time is not
used, because a trade and the quote change it causes (the ask it lifted moving up, the bid stepping up to the traded
price) share one timestamp, and taking that later quote calls a buy a sell. A quote stamped after the trade is never
used. A quote with no update for over 60 seconds before the trade (`QuoteMaxAge`: a hole in the data, a disconnect) is
stale: the tick rule, counted (`staleQuotes`). Both paths follow one rule, so a reload gives the same sides as the live
chart did **when NinjaTrader's live and historical times have the same resolution** (a harness case checks it). They
may not: the backfill compares at the coarser of its trades' and quotes' resolution (whole seconds, say, or the 4 ms
grid reported for NinjaTrader's historical data), while live uses the live stamps as they come. Then a quote and a
trade inside one step are a tie in the backfill (the older quote is used) but ordered live, and the two can differ
on such trades; `/diag` shows both resolutions.

**Live.** ChartBridge keeps the recent Bid and Ask updates with NinjaTrader's time for each (the last 256 a side,
plus, of the older ones, the latest stamped and the latest stamped before that, so a burst at one time still leaves
the quote from before it), and reads the quote as of each trade's time, not by arrival: NinjaTrader can deliver a
trade's own quote updates before the trade (the review's case, and a forum report of updates stamped .413 delivered
before a trade stamped .412). One edge is left (review 2 N3): more than 256 updates stamped after a trade, in two or
more distinct later stamps, delivered before that trade, push out the quote from before it; the trade then has no
quote (the tick rule, or side 0), and `quoteAfterTrade` counts it. The tick rule uses the previous live trade of that
instrument. Quotes are followed from the moment ChartBridge starts, so the first trades after a start can go by the
tick rule. The held trades of a load are tagged when they arrive, like any live trade.

## Time and Sales category (0.3.8)

Each trade can carry where it printed against the prevailing quote, as NinjaTrader's Time and Sales colours it:

| `q` | the trade printed |
|---|---|
| `2` | above the ask |
| `1` | at the ask |
| `0` | between the bid and the ask |
| `-1` | at the bid |
| `-2` | below the bid |
| absent or `null` | unknown: no usable quote |

It is read from the very quote the side uses (Trade side, `sm` 2): the last bid and ask stamped strictly before the
trade on NinjaTrader's times, both above zero, bid below ask (a locked or crossed quote is not used), no update for
over 60 seconds is stale, and none after a reset. Prices are compared on the same 0.000001 grid. `q` and `s` are
separate: a trade between the quote is `q` 0 with its side from the tick rule (`sm` 3). No NinjaTrader request is
added for it: the live Bid and Ask updates ChartBridge already follows are the only source.

**Live.** A `tick` ends `..., "s": 1, "sm": 2, "q": 1}`; with no usable quote there is no `q` field at all.

**History.** A trade in a `ticks` list is `[t, p, v]` when its category is unknown and `[t, p, v, null, null, q]`
when it is known. Only trades ChartBridge saw live, with a usable quote, and keeps in the served window (see Served
window and session table) have it: the trades of NinjaTrader's own tick answer, the session table and the files have
no stored quote, so they stay `[t, p, v]`, unknown, never guessed. The side places stay `null` as in 0.3.7, so a page
that reads `s` and `sm` from places 4 and 5 sees no side, exactly as for `[t, p, v]`.

**Older pages** ignore it: chart 1.12.0 reads places 1 to 5 of a trade (`null` there is "no side") and only the
fields it knows of a `tick`. `/diag` counts the live trades by category (`sides.<root>.live.q`).

**Resets and bad prices.** NinjaTrader's help describes `IsReset` as "a UI reset is needed after a manual disconnect",
meant for its market data columns. A market data event with `IsReset` is never a trade here, whatever its type and
price: ChartBridge only forgets the live quote, sends nothing, and logs the first one (with its type and price) once.
A Last event with a price of 0 or below is ignored too (review 3 N5: that would also drop a real trade at 0 or below,
such as a calendar spread, should such an instrument ever be added to `roots`); neither reaches the order code's last
price (review 2 S2: a reset of type Last at price 0 used to, which for 2 s would make a long bracket's stop look
already passed). An automatic
reconnect probably raises no reset, and connection status events are not watched here (that would touch the server's
start and stop): after an outage over 60 s the old quote is stale; after a shorter one it can stand until the first new
Bid and Ask updates.

**Backfill** (0.3.4 to 0.3.6; removed in 0.3.7). The Bid and Ask history that sided the by-date tick backfill (`quoteHours`,
0.3.4.1: off by default after it froze NinjaTrader on the trading PC) went with that load: since 0.3.5 the served window's
trades are `[t, p, v]` (no side) and the delta pane counts live trades from the page's open, so nothing asked for it any
more. A `quoteHours` line in `config.txt` is now only noted once in the Output window ("no longer used") and does nothing.
The backfill's side join (`ClassifyBackfill`, `QuoteSeries`, `ContinueTickRule`, `BackfillSides`) is removed with it; the
rules above now apply to live trades only.

**Two send lanes to the page, and when a page is closed** (review 2 S1). The page's WebSocket carries market data and
order traffic, and a load's release (`ready` and the held trades after it, one outbox entry) can take seconds to
drain at the page's pace. So ChartBridge sends in two lanes:

- **Order lane:** `hello`, `trading`, `orders`, `order`, `position`, `reject`, `exec`, `execs`, `status`, `pong`.
  Checked before every message ChartBridge sends, so such a message goes out at the next message boundary (one
  market data message at most is in flight), ahead of market data queued before it.
- **Data lane:** `history`, `ticks`, `ready`, `tick`, and any other type: first in, first out, as before.

The guarantee: order within each lane is kept, and a data message never goes out ahead of an order-lane message sent
before it. An order-lane message can go out ahead of data sent before it. That is safe for the page: order, position,
trading, reject and fill messages stand on their own (fills carry their own time, and the page already takes them
before any history on connect, and order messages before `ready` after signing in); the page places orders only after
`ready`, so a reply to one of its orders always follows the `ready` it saw; `status` is a line of text. Harness (the
review's shape, a page taking 20 or 200 us a message): an order reply sent during a 20,000-trade release arrives in
under 1 ms (0.3.3 and the first 0.3.4 round: 0.45 s and 4.1 s, when the page was not closed first).

**A page more than 5 s behind is reconnected** (review 3; Anthony: "just a reset"). ChartBridge closes a page's
connection when the oldest market data waiting for it has waited more than 5 seconds; the page then reconnects on its
own (without asking for the PIN again, as after any drop), signs in again and reloads, so it shows live data again and
Armed is off. The Output window says so once, with the lag: "Client N is not keeping up: 5.0 s behind; closing it (the
page reconnects and reloads)." A close always ends the connection itself (the socket is aborted), so the page sees it
and reconnects, whenever it lands (review 4 B2: a close between two sends used to leave the page connected, silent and
Armed).

How the wait is counted (review 4 B1): each waiting entry's time since it was queued, minus the time ChartBridge spent
meanwhile sending the page's own bulk data: a load's `history` and `ticks` chunks, and the held trades released after
`ready`. Those go out back to back at the page's pace and none of them is late; after a lag close at 3,000 trades a
second the reload holds the load's seconds times the rate (about 90,000 trades for a 30 s load), and counting that
release as lag would close the page again on every reload. A live backlog still ages during every other send, and only
bulk sends that have finished are credited, so a page frozen in the middle of one still ages. **The price of that
credit** (review 5 S1): right after a load, the live trades queued behind the release are as late as the release is
long, and that is not counted, so the chart can run behind by up to the length of the release plus 5 s before the rule
acts, not 5 s, while trading stays enabled. Review 5 measured, at 3,000 trades a second: healthy pages 4.4 to 14.3 s
behind right after a load, never closed; a page slower than the market closed only 37.6 s after `ready`; with repeated
loads a slow page reached 17.2 s behind before its close. What shrinks the release is sending recent ticks first (the
next step, branch live-first); this branch changes no page code. Order lane messages do not count (they go out first
anyway). Also closed, as before: 5,000 entries waiting while the message being sent has been stuck for over 2 seconds
(a page that stopped reading), and over 5,000 order-lane messages waiting. The age is checked when something is queued
for the page (and while a load waits to queue its next chunk), so a page with nothing new waiting is not closed; order
replies stuck behind a stuck send with no market data waiting are closed only by the 5,000-entry rule (review 4 N3).
Harness (Mono; times vary run to run):

- a page taking 1 ms a message (1,000 a second) against 3,000 trades a second is closed after about 7 s, 5.0 s behind,
  also right after a load; one taking 0.4 ms (2,500 a second) after about 15 to 28 s (it falls behind by about 0.2 s a
  second), 5.0 s behind (0.3.3 closed both at 5,000 entries, about 1.7 s behind; the second 0.3.4 round let them fall
  about 17 s behind);
- the reload at 3,000 trades a second in review 4's model (230 chunks at 3.5 ms, a 250 ms page freeze on `ready`), with
  90,000 or 130,000 held trades released at 42 or 84 us a message and 3,000 live trades a second behind: never closed,
  everything delivered, the oldest live wait 0.7 to 2.0 s (the third round closed three of these four 5.2 to 5.4 s after
  `ready`, and would have again on every reload);
- a 48 hour load (130 chunks), then a release and live trades: not closed at 3.5 ms or 50 ms a chunk.

Memory. A 20,000-trade `ticks` chunk is about 1.1 to 1.3 MB as a .NET string (600 KB on the wire). Since review 4
(S1) a load makes and queues its chunks at most three ahead of the page (`BulkWindow`): the loading thread waits for
room before making the next one, so a loading page holds about 4 MB of chunks, not the whole load (before: a 48 hour
backfill about 166 MB, Anthony's Range 40 over 28 hours, 4.6 million trades, about 295 MB per loading page, several
pages reloading together about 0.9 GB). Harness, a 600,000-trade load through the real subscribe, four runs: at 3.5 ms
a chunk (Chromium's measured pace) about one chunk ever waited either way (making a chunk takes longer on Mono) and
"ready" reached the page after 2.7 to 5.0 s either way; at 300 ms a chunk (a page slower than ChartBridge makes the
chunks) the old way had 17 to 23 of the 30 chunks waiting at once (18 to 25 MB), the window 3 (3 MB), and "ready" came
after 9.3 to 9.8 s either way: the window does not slow a load. Market data
(review 3 measured 350 bytes a queued trade): at most about 5 s waits per page, about 15,000 trades or 5 MB at 3,000
trades a second. The held trades of a loading page (in `Pending`) are about 350 bytes each: 90,000 are about 31 MB for
the seconds of the load. An entry is not a message: the release after `ready` and each chunk count as one. There is no
limit on the number of pages (each open tab, The Desk's relay, each embed is one).

A Send that races a page's Close (a tab closing while NinjaTrader sends an order update to every page) drops the
message quietly instead of throwing out of the loop that sends it to the other pages (review 3 S2). A send that fails
closes the page and ends its connection, so it reconnects instead of staying connected and silent (review 3 N1, review 4
B2). A load's own warnings
("Minute history failed", "Tick history failed", "No instrument") go in the data lane, after that load's history, as in
0.3.3 (review 3 N3). `pong` goes in the order lane, so it measures the round trip to ChartBridge and not the market data
waiting in front of it (review 3 N4).

**The seam is unchanged.** The side takes no part in matching held live trades against the backfill (price, volume
and time, as in 0.3.3). A trade in both keeps the backfill's side. The released trades' tick rule then continues from
the backfill's copy of the seam trade, not from its dropped live twin (whose side can differ): tick-rule trades among
them are worked out again (starting over at 18:00 ET), and the live stream continues from the last of them. The live
tagger is one per instrument, shared by every page (review 2 N4): a second page's load moves the tick-rule continuation
that a page already live on that instrument sees, toward what a reload would give. Only the side of an unchanged or
between-quote trade can change, and only at that moment.

**Differences from NinjaTrader's own Order Flow Cumulative Delta** (its help page): in Bid Ask mode a trade between
bid and ask gets the previous trade's side (here: the tick rule, Anthony's choice; they differ only on between-quote
trades that changed price, counted in `/diag` `betweenQuotes`), and historically it uses the bid and ask NinjaTrader
stamps on each trade, not separate Bid and Ask series. NinjaTrader's help says the historical Bid/Ask series "would not
be equivalent to the bid/ask at a specific time a trade went off", and that with no bid/ask tied to the trades it
fills the stamps in as Bid = Last and Ask = Bid + 1 tick. So `/diag` also reads the stamps on the last 2,000 backfill
trades (see below) to show whether they are real on this connection; switching the backfill to them is a later
decision (they are NinjaTrader's arrival-order quote, so they could share the reorder the tie rule avoids).

**Live checks** (the trading PC): compare a minute's delta with NinjaTrader's Order Flow Cumulative Delta (Bid Ask,
Bar period) where available; read `/diag` `sides` for `liveTieChanged`, `quoteAfterTrade`, `tieChanged`,
`eventQuoteDiffers`, the stamps, the two resolutions, and the quote rows and load time.

**Still open.** How often a trade's own quote update comes first on Tradovate: `liveTieChanged` counts the trades the
other tie rule would call differently, `quoteAfterTrade` the ones whose latest update was stamped after them. The tie
rule is exact when the stamps are fine-grained; with coarse stamps (whole seconds, or the 4 ms grid reported for
NinjaTrader's historical data) excluding the trade's own step uses an older quote, which the model in the review shows
can be wrong more often, so the two resolutions in `/diag` matter. Real bid/ask tick counts and memory on Tradovate are
unknown until the live PC reads `bidTicks`, `bidRowsKept` and `quoteCopyMs`.

## Served window and session table (0.3.5)

Anthony's rules (2026-09-30, after the WORK session where each Range load pulled 16 to 17 hours of trades and NinjaTrader
showed 8 to 11 s "high latency" stalls): the Range chart only needs the last 2 hours when it opens, and its bars then stay
all day; the volume profile must be exact from 18:00 ET; the one-time load of the session runs at NinjaTrader start, one
instrument at a time; once loaded, switching charts and instruments never loads again; nothing about trades or range bars is
kept past the session.

**What goes to NinjaTrader one at a time.** The served windows (Range and seconds charts) and the session backfills go
through one gate: one of them out at a time, windows first (a window's second ask ahead of any backfill). A backfill starts
only with nothing else out: no window, no other backfill, and no minute chart's last-trades request. A minute chart's
last-trades request (20,000 trades by count, for its forming minute) is the one 0.3.3 and 0.3.4 already made: it does not go
through the gate, so it can go out beside a window or another minute chart's, as before; it is only skipped (the forming
minute stays as NinjaTrader sent it) while a backfill is out or a request is stuck (below). The minute history of each load
(a small by-date request of 1-minute bars) is not gated either.

**One unanswered request.** A window or a backfill NinjaTrader does not answer in time (a window 120 s, a backfill 5 min) is
given up for the pages waiting on it, but it stays outstanding at NinjaTrader. Until NinjaTrader answers it (the late answer
is dropped at once, not copied) or restarts (or the add-on is recompiled), ChartBridge asks for no tick history: no window,
no backfill, no minute chart's last-trades request. Meanwhile nothing waits on it: a Range or seconds load, queued or new,
gets the served window from ChartBridge's memory when there is one (with its gap, if a feed drop left one), else goes live
at once with no trades and "Tick history failed: NinjaTrader has not answered an earlier tick request (the request) yet;
tick history is not asked for until it does or NinjaTrader restarts", and its live trades are not held for a request that
will not be made. A queued backfill (a first ask, or a retry after one failure) waits and says so (the page: "loading this
session waits for NinjaTrader, which has not answered an earlier tick request"), not "building"; once NinjaTrader answers,
its state is back ("queued", or for a retry "failed once (...), asked again in 60 s") and it runs as usual. An answer that
claimed its request at the time limit has 30 s more to finish its copy; past that it counts as unanswered (one Output line)
until the copy ends. Minute charts load as usual.
Orders and Flatten are never affected. `/diag` `gate.stuck` names the request, `stuckSinceUtcMs` says since when, and a
waiting backfill's `state` starts "waiting:". Only the request that made the gate stuck frees it. Stopping ChartBridge (a
compile, or closing NinjaTrader) clears the stuck request and marks the gate stopped until the next start: no tick request
goes to NinjaTrader after it (nothing is queued, no worker starts, no minute chart's last trades, no second ask), an answer
that comes later is dropped uncopied, and any backfill retry still to come is cancelled with its timer. The gate's worker
has its own thread; Stop waits for it at most 250 ms, and a worker still inside a NinjaTrader call then ends when that call
returns, sending nothing more (one Output line says so). 0.3.7 (review lf7 N1 to N3): a request that will never go out
because ChartBridge stopped (a load answered after the stop) answers the pages waiting on it ("ChartBridge stopped before
the request went out"), and a start clears what such a load left behind, so a start in the same process never leaves an
instrument waiting on a dead request; a timeout handled after the stop reset the gate never marks it stuck again; and the
worker checks for a stop, under the gate's lock, right before it sends a request it has taken, so a stop in that gap
sends nothing. What is left is the few instructions from that check to NinjaTrader's call: a request sent in them has its
answer dropped uncopied.

**The served window.** Every subscribe with `tickHours` above 0 (a Range or seconds chart, with or without `liveFirst`: a 1.6.x
page or The Desk's relay gets it too; 0.3.5 never runs 0.3.4's by-date tick load) gets the last `rangeHours` of trades
(config, default 2, 1 to 8) in its `ticks`. ChartBridge asks NinjaTrader **by count** (`BarsRequest(instrument, barsBack)`),
sized from the live trade rate (1.5 times `rangeHours` of it, 20,000 to 2,000,000; 200,000 before a rate is known), and asks
once more with three times the count when the answer is full and still starts after `rangeHours` back: two asks at most. One
request per instrument at a time: loads that come while it is out (a second page, a reload, a view switch, a resubscribe)
wait for the same answer. The answer is kept whatever load is current: cut at `rangeHours`, joined to the live trades since
the ask by the 0.3.3 seam, it is the instrument's served window, kept in ChartBridge's memory and extended by every live
trade. Every later load of that instrument gets its trades from there, from the same first trade, and NinjaTrader is not
asked again. It is dropped at the next session (the first trade after 18:00 ET) and after the session ends (a Friday window
does not wait in memory for Sunday, so a weekend Range load asks NinjaTrader again, for a small window). After a feed drop
(below) it is kept with its gap, and asked again at a load at most once in 10 minutes per instrument. When a window fails (an error, or no answer in time), the
loads waiting go live with no trades ("Tick history failed", charts start from live trades), and no load asks again for 60
s. When its live trades cannot be joined to it (a feed drop while it was out), or more than 500,000 live trades come while it
is out, its loads go live the same way at once, nothing more is held for it, and the next load may ask again. Its trades are `[t, p, v]` (no side: the delta pane counts live trades from the
page's open). A late-day reload sends the whole window: from the first window's start (say 6:30) to now.

**The session table.** ChartBridge keeps, per instrument, the volume at each price of the current session (from 18:00 ET),
per half hour of New York time (9:30, 13:00 and 16:00 are half hour edges, so RTH, and an NYSE early close, are whole rows),
fed by every live trade (OnMarketData Last) under the instrument's lock. A trade more than 2 minutes off the clock
never opens a session (NinjaTrader can replay the last trade when market data starts; a PC clock that far off the feed
opens none, `/diag` `staleTrades`). The table is whole when ChartBridge was listening before the session started and the
feed was up from before it, however late the first trade comes. When ChartBridge was running but the feed was down at the
start (a drop not back by 18:00), the table counts from its first live trade and says the feed was down; no backfill. When
ChartBridge started after 18:00 (NinjaTrader started, or the add-on recompiled, mid-session) it holds the live trades from
its first one (`coveredFrom`), and for an instrument in `profileRoots` (config, default `MNQ, NQ, ES, MES`) ONE backfill of
the session is run: only then, never at a later 18:00. The backfills start once the feed has been up for a minute (from the
first live trade after market data started) and no page is loading, through the gate, one instrument at a time in
`profileRoots` order (MNQ, NQ, ES, MES, whatever order their first trades came in), once per session, never for a page load,
and not while the market is closed (0.3.7, review lf7 N4: "closed" also knows the CME holidays, by the page's own rules in
`src/chart-engine.js`, `cmeClosed`: no session on New Year's Day, Good Friday and Christmas as the NYSE observes them, the
13:00 ET halt on the other NYSE holidays and 13:15 on an NYSE early close, until 18:00; the same rule decides whether a feed
drop missed trades). It asks NinjaTrader for the session so far **by
date**, from its 18:00 start. NinjaTrader's help says a by-date request covers whole trading days from 12:00 AM, so the answer
also holds the hours before 18:00 (back to midnight the day before); NinjaTrader loads them and ChartBridge copies them, then
leaves them out. On NinjaTrader's callback thread only that copy is done (timed: `callbackMs` in `/diag`); the rest runs on a
worker. On an error, an empty answer, or an answer that ends before the live trades began, it is asked once more after 60 s,
then given up with a note (the profile then says "since"). The live trades since the table began are joined to its answer by
the 0.3.3 seam (at most 500,000 of them are kept for it; past that, or when it fails or times out, none are kept). When it is
in, the table is whole and every live page of that instrument that asked for `profile` gets a new `profile` (no `sub`), in
order with its live trades. Instruments not in `profileRoots` get no backfill: their profile counts from the first live trade.
At 18:00 ET (the first trade of the next session) a new table starts; the finished one is kept as `last` and written to one
small file per instrument (`profile-MNQ.txt` in ChartBridge's folder: the session's start, whether whole, and its rows; not
used when more than 4 days old), for the weekend's "last session" profile and a later weekly profile. Nothing else about
trades is written to disk.

**A feed drop.** When a data connection's price feed goes from Connected to anything else (NinjaTrader's
`Connection.ConnectionStatusUpdate`; any connection's, so one that feeds nothing charted here counts too), or a market data
reset arrives, while the market is open, every table it touches is marked not whole for the rest of the session (`drop` in
the message: the time and why), its served window is kept with the gap (asked again at a load at most once in 10 minutes),
and live pages get the profile again. A later backfill does not make it whole. A drop while the market is closed (a
weekend, the 17:00 to 18:00 break) misses no trade and marks nothing; the page also shows the drop only when it fell inside
the trading its profile counts (RTH for an RTH profile). Range and seconds views keep their VWAP after a drop (the table's
sums plus the page's trades) and say what it misses.

**The `profile` message.** Sent right before `ready` to a subscribe with `profile: true` (any view): `session` is the table
exactly up to the last trade the page has (the held live trades released after `ready` are taken off, the page adds them
as it gets them), so the page's profile is the rows plus every trade after them, equal to one built from every trade of
the session. Rows are `[t, priceTicks, v]`: `t` the half hour's start in bar-time seconds (New York wall clock), the price
in ticks of `tick`, the volume. `from` is the session's start, `whole` whether every trade of it is in, `coveredFrom` from
when it is (the start when whole), `backfill` the backfill's state (`none`, `wanted`, `queued`, `asked`, `failed once ...`,
`asked again`, `done`, `failed: ...`, `timed out ...`, `abandoned ...`, `skipped ...`, `none (not in profileRoots)`), `drop`
null or `{at, why}`. `last` is the finished session's table, or null. The table is copied under the instrument's lock and the
message is formatted with no lock held (the page's live trades are held meanwhile and released after it).

**For a page.** With ChartBridge 0.3.5 the chart draws Range bars only from the first bar proven to be NinjaTrader's own
(docs/RANGE_BARS.md, Served window), and starts the session VWAP of range and seconds bars from the table (its price
times volume and volume, less the trades the page holds). The profile note says "building, from HH:MM ET" while the backfill
is to come, "since HH:MM ET" when there is none, and "missing trades" after a feed drop. Old pages (no `liveFirst` or
`profile`) get the served window and no profile message: their own profile counts the window, with their existing note. The
Desk's relay passes no `features` and drops `profile`: its Live tab works as a 1.6.x page until the relay passes both and
The Desk vendors chart 1.8.0.

`/diag` (0.3.5) adds `books`, per instrument: `table` (`session`, `whole`, `trades`, `volume`, `rows`, `drop`, `lateTrades`,
`staleTrades`, `maxGapSec`: the longest time between two live trades this session), `last` (`whole`, `volume`, `rows`),
`backfill` (`state`, `asks`, `askedAtUtcMs`, `ms` from the ask to the table being whole, `callbackMs` on NinjaTrader's
callback thread, `trades` in the answer, `releasedLive`, `liveHeld`, `first`, `last`), `window` (the served window: `from`,
`trades`, `served`), `windowAsk` (`asking`, `waiting`, `asks`, `failures`, `lastError`, `callbackMs`) and `tradesPerHour`;
then `gate` (`now`: the request out, `windowsQueued`, `backfillsQueued`, `barsQueued` (0.3.6: a daily bars request waiting to go, 0 or 1), `htfQueued` (0.3.7: higher-timeframe requests waiting to go), `minuteTailsOut`, `stuck`: the request given up and still unanswered, or null, `stuckSinceUtcMs`, `feedDown`, `firstTradeUtcMs`), `profileRoots`,
and `backfillTotalMs` (the backfills' times added up). `windows` lists the last 20 window loads: `client`, `root`, `sub`,
`atUtcMs`, `fromCache`, `askedByCount` (the counts asked, "shared" for a load that waited on another's request), `trades`,
`from`, `timeToLiveMs`, `error`.

## Settlement, higher-timeframe bars and the weekly profile (0.3.7)

Three additions for the page (Anthony's chart items: the day % change by the instrument, the 4h, 1D and 1W charts, the
weekly profile on a click). **The chart never waits**: none of them delays a chart's own load or the live trades, and every
NinjaTrader history request among them goes through the gate, last.

**Strict page requests.** `htf` and `weekProfile` are one flat JSON object with only the keys listed (each once, in any
order). A value is a plain string (printable ASCII, no backslash, at most 32 characters) or, for `id`, a whole number of 1 to
15 digits (no sign, no leading zero), echoed as written. Anything else (another key, a key twice, a nested object or list,
`true`, `false`, `null`, a fraction, an escape, text after the object) is refused: the page gets a `status` (`warn`,
"ChartBridge refused a htf message: unknown key extra") and nothing is asked of NinjaTrader. A root ChartBridge does not
serve is answered with an `error` and no bars.

### Prior settlement

- **What it is:** the settlement of the session before the current trading session. Sessions run 18:00 to 17:00 ET and
  are named by the date they end on (the CME rules above: weekends and CME holidays have none). The current session is the
  one begun last: in the 17:00 to 18:00 break, a weekend or a holiday it is still the one that just ended. So on Tuesday
  the prior is Monday's until Tuesday 18:00; from Sunday 18:00 to Monday 17:00 (and to 18:00) it is Friday's; across Good
  Friday it is Thursday's from Sunday 18:00.
- **Where the values come from:** NinjaTrader's own settlement for the served contract. NinjaTrader 8's `MarketData` object
  (the one ChartBridge already subscribes to for trades) holds a snapshot of each market data type, `MarketData.Settlement`
  among them (a `MarketDataEventArgs`; NinjaTrader's help, MarketData: "Snapshot data is provided right on subscription"),
  and its `Update` event delivers `MarketDataType.Settlement` events. ChartBridge reads the snapshot when it subscribes and
  takes every Settlement event after that. Only a price above 0 counts; a reset event is never one; `LastClose` (the prior
  session's close) is never used.
- **Each value is dated** with the trading date it settles, from NinjaTrader's time on it: a date-only stamp (00:00) is that
  date, once that date's settlement time (below) has passed (before it, the day has not settled: not used). A timed stamp
  (0.3.8, Anthony's ruling) belongs to the session whose settlement time it comes after: stamped after a session day's
  settlement time (16:00 ET, or 12:00 ET on an NYSE holiday or early close, when CME halts early) and before the next
  session day's settlement time, it is that day's. So 16:15 Monday, 20:43 Monday evening and 10:00 Tuesday are all Monday's;
  a Saturday, a Sunday evening or Monday 15:00 are Friday's; Good Friday (no session) is Thursday's. This dates the
  snapshot NinjaTrader gives at subscription, which carries the time it was read (HOME, 2026-10-01: a first start at
  20:43 ET read that day's settlement stamped 20:43; 0.3.7 left it undated). **Equal to the day before's** (Anthony
  and the coordinator, 0.3.8): NinjaTrader can still hold the day before's value after the settlement time, so a value
  equal to the stored value of the day before is never used, whatever its stamp (two equal settlements in a row are
  rare, and a blank is safer than a wrong change); one Output line says why, and ChartBridge waits for a value that
  differs. A value that differs is used at once, from the settlement time on. With no value stored for the day before:
  stamped from the session's close (17:00 ET; 13:00 or 13:15 on a holiday or early close) it is the day's (HOME's
  first evening); stamped between the settlement time and the close it waits. A value that came before
  `settlements.txt` was read, with nothing stored to compare yet, is held and judged once it is read. Settlement
  updates are handled one at a time, in the order NinjaTrader sent them. A day with no Globex session, or a value
  that cannot be placed, is not used (one Output line says so; `/diag` shows it with `day` null), and with no other dated
  value the prior is null rather than a wrong one.
- **Today's settlement after the afternoon close** (in from about 16:15 ET) is kept and shown in `/diag`, but the prior
  stays the day before's until the next session starts at 18:00 ET; then today's becomes the prior and every page gets a
  `settlement` message. ChartBridge checks every second, so the roll reaches pages within a second of 18:00.
- **To pages:** in `hello`, per instrument, `settlement` (or null) and `settlementDate`; and
  `{"type":"settlement","root":"MNQ","p":21456.25,"date":"2026-09-28"}` to every page whenever the prior changes (`p` null
  when ChartBridge has no value for that date). Each new dated value is noted in the Output window with NinjaTrader's stamp.
  `/diag` `settlements`: per root, `prior` (`date`, `p`), `byDate` (the dated values kept), `last` (the latest value
  NinjaTrader gave: `p`, `ntTime`, `day` or null, `from` `snapshot` or `update`, `receivedUtcMs`).
- **Restarts:** the last two dated values per root are kept in `settlements.txt` in ChartBridge's folder (`ROOT yyyy-MM-dd
  price CONTRACT`, replaced through a temp file, written off NinjaTrader's thread, one write at a time), read at the start off
  NinjaTrader's thread (pages connected meanwhile get a `settlement` message once it is read), so a restart in the evening
  still knows the prior (and, before 18:00, the day before's). A line for another contract than the one served now (the
  contract before a roll) is ignored, so a restart on the roll day never gives the old contract's settlement as the new
  one's prior; the prior is then null until NinjaTrader gives the new contract's own value. Pages are told in order, one
  check at a time. A page always ends with the right value: right after its `hello`, any root whose prior changed while
  the hello was being built (the file read just after a start, or a new value) gets a `settlement` message to that page,
  after the hello. Lines for roots not configured now are kept in the file. If the file cannot be read at the start, it
  is not rewritten from memory that run (said in the Output window); the priors from it are not known until a
  settlement comes in.
- **Live check:** whether Tradovate's feed gives a Settlement value, and the time NinjaTrader stamps on it (the snapshot
  at subscription especially), is to be seen on the trading PC: the Output lines and `/diag` `settlements.last`.

### Higher-timeframe bars (4h, 1D, 1W)

- **The request:** `{"type":"htf","root":"MNQ","tf":"4h","id":7}` (`tf` `4h`, `1D` or `1W`; `id` optional).
- **NinjaTrader's own bars:** `BarsRequest(instrument, 300)` by count (`HtfBarsBack`), `BarsPeriod` Minute 240, Day 1 or
  Week 1 (Last), the instrument's trading hours (the chart's template), NinjaTrader's merge setting (as its own charts).
- **Through the gate, last:** queued behind windows and backfills and sent only when no window or backfill is out or
  queued, no minute chart's last trades are out and no page is loading (as the daily bars, which go after it). So it never
  starts beside a chart load; a chart load that comes while it is out waits behind it (one small request). A request
  NinjaTrader does not answer in 15 s (`HtfTimeoutMs`, Anthony 2026-10-01) is given up and **frees the gate** (as the daily
  bars: the chart never waits); its pages get the plain reason and when it can be asked again ("NinjaTrader did not answer
  within 15 s; it can be asked again in 60 s (from 2026-10-01 10:15:02.123 ET)"), its late answer is dropped uncopied, and
  that root and timeframe is asked again no sooner than 60 s later. A request still queued after 120 s (the chart's requests
  kept going first) is taken back ("not asked: the chart's own requests kept NinjaTrader busy for 120 s; it can be asked
  again in 60 s (from ...)"). While the gate is stuck on an unanswered window or backfill, a
  request is answered at once with the reason. After a failure the same root and timeframe is not asked again for 60 s.
- **The answer:** `{"type":"htf","root","tf","id","name","bars":[[t,o,h,l,c,v],...],"error":null}`, oldest first, the last
  bar forming, prices and volume as NinjaTrader has them. `t` is the bar's start in bar-time seconds (New York wall clock),
  as every bar here: a 4h bar is one of 18:00, 22:00, 02:00, 06:00, 10:00 and 14:00 ET, from the session's 18:00 open (the
  last one runs to the 17:00 close; NinjaTrader stamps them at their close); a 1D bar's `t` is its trading day at 00:00 (the
  date the session ends on: Sunday 18:00 belongs to Monday); a 1W bar's `t` is the Monday of its week at 00:00. NinjaTrader
  with no bars answers `bars: []` and `error` says so; nothing is made up.
- **Kept, one per root and timeframe:** a second page or a reload is answered from ChartBridge's memory, with nothing asked
  of NinjaTrader. Asked again only at a request on a later trading day (from 18:00 ET), after a feed drop while the market
  was open, or after a failure (the bars in memory are sent meanwhile, when there are any). Dropped at a stop.
- **The forming bar, live:** every live trade ChartBridge already gets (no NinjaTrader request per trade) goes into the
  forming bar of each kept series of its root (high, low, close, volume; a new bar when its start is later). Trades that
  come while NinjaTrader's answer is being copied are kept and added after it. A page that has a root and timeframe's bars
  (its `htf` answer had them) gets `{"type":"htfBar","root","tf","bars":[...]}` at most once a second while it changes: the
  forming bar, after the closed bar's final values when a new bar began. At most 12 series per page.
- **A page asking again and again** (review B2 S2): while a request is out a page waits on it once (its latest `id` is
  answered); an answer is formatted once, with no lock held, from a copy taken in microseconds (the closed bars' text is
  kept between answers, only the forming bar is new), so live trades never wait on it.
- **Accepted edges:** the forming bar's volume can differ from NinjaTrader's by trades in the moment NinjaTrader took its
  answer (milliseconds), until the series is asked again the next trading day. NinjaTrader's 240-minute bars are believed to
  start at the session's 18:00 ET open with its US index futures template; a live check compares the `htf` answer with a
  NinjaTrader 240-minute chart. Bars that would share a start are merged rather than sent twice.

### Weekly volume profile, on request

- **The request:** `{"type":"weekProfile","root":"MNQ","id":3}` (`id` optional).
- **From the session tables only, never a NinjaTrader request:** the last 5 finished sessions (days with a Globex session,
  by the CME rules above, whose 17:00 ET close has passed; the session running now is the page's own `profile`). Each finished
  table is kept in memory and written to `profile-<ROOT>-<yyyy-MM-dd>.txt` (its trading day) in ChartBridge's folder, kept 14
  days, so a restart still has the earlier sessions; the file also records a feed drop. Files are read and the answer made
  off NinjaTrader's thread. One answer per page is in progress at a time: requests meanwhile are folded per root (each root
  asked meanwhile is answered once more, with its latest `id`, in the order the roots were first asked; at most 16 roots
  wait), so a request for another root is never lost. The answer is kept per root while the same tables answer it, so a repeat copies nothing; finished tables
  never change and are read with no lock (only a just-finished current table is copied under the book's lock).
- **The answer:** `{"type":"weekProfile","root","id","tick","sessions":[...],"rows":[[priceTicks,v],...],"error":null}`.
  `sessions`, oldest first, each `{date, from, whole, coveredFrom, drop, rows}` (as in `profile`: `from` the 18:00 start,
  `whole` whether every trade of it is in, `coveredFrom` from when it is, `drop` null or `{at, why}`; `rows` the volume at
  each price in ticks of `tick`, the whole session), or `{date, missing}` when ChartBridge has no table for it ("no table:
  ChartBridge was not running for this session, or its file is gone"). `rows` adds up the sessions present.

`/diag`: `settlements`, `htf` and `books.gate.htfQueued` (see Diagnostics).

## Delay readout

For each live tick the page shows two numbers:

- **feed**: `rx - u`, how long the tick took from the exchange timestamp to NinjaTrader (includes
  Tradovate and the PC clock offset from the exchange);
- **local**: page receive time minus `rx`, the add-on to chart hop on this PC.

## Fills (0.2.0)

ChartBridge learns about a fill two ways: the account's `ExecutionUpdate` event, and a poll of every
watched account's `Executions` every 2 seconds. Each execution is sent once, keyed by account and
execution id, whichever way sees it first. (Added after the HOME test on 2026-09-29, where no fill
reached ChartBridge; the poll is the fallback, and `/diag` shows which way fills arrive.) A page can
still receive the same `id` twice after a reconnect (in `execs` and later in `exec`); key fills by
`account` and `id`.

Order and position events are counted for `/diag` only. ChartBridge never acts on them.

## Diagnostics: `GET /diag` (this PC only)

JSON: `version`; `network` (0.3.1: see Network access); `pin` (0.3.2: `{"set": bool}`, see PIN); `clockOffsetMs` (PC clock minus ChartBridge's clock, near 0 once the clock has
re-anchored; the clock is rechecked every 5 seconds and follows the PC clock when they differ by more
than 50 ms); `fillEventsDelivered` and `fillsFoundByPolling` (how many fills came each way this
session); `lastPollUtcMs`; `clients`; `desk` (`postFills`, `deskUrl`, `waiting`, `lastSendFailed`,
`lastError`, `setAside`, `rejectedByDesk`); `bars` (0.3.6, see Daily bars to The Desk: `enabled`, `state` (`off`, `starting: ...`, `idle`,
`asking NinjaTrader: <session contract>`, `waiting for the gate: <why>`, `waiting: regular trading hours ...`, `waiting:
NinjaTrader has no price connection`, `stopped`), `waitingForGate` (why the gate is not idle for a bars request, or null),
`roots`, `lastSent` (the latest session The Desk took, per contract), `waiting` (messages queued in `pending_bars.jsonl`),
`setAside` (since this start), `gaveUp` (sessions not asked again until the next start), `lastRequest`, `lastError`); `pages` (0.3.4, one entry per connected page: `id`, `root`, `ready`, `queued`
(entries waiting in its data lane), `orderLaneQueued`, `oldestDataMs` (how long the oldest waiting market data has
waited, as the 5 s rule counts it)); `seams` (0.3.3, the last 20 subscribes, oldest first; see Backfill and live):
`client`, `root`, `sub`, `tickHours`, `atUtcMs`, `loadMs` (subscribe to `ready`), `matched` (false: nothing to match the held
trades against, all released), `backfillTicks`, `lastBackfillTick`, `firstHeldTick` and `firstReleasedTick` (New York
time, `yyyy-MM-dd HH:mm:ss.fff`, or null), `overlapMs` (`lastBackfillTick` minus `firstHeldTick`: 0 or more means the
streams overlapped, so nothing fell between them; below 0, no held trade was at or before the backfill's end: a quiet
moment, or a gap of up to that long), `held`, `heldAtAnswer` (held when NinjaTrader answered the tick request; null when
nothing was matched), `droppedAsDuplicate` (= `droppedOlder` + `droppedSameTime`), `droppedAfterAnswer` (held after the
answer, matching at T: dropped at millisecond resolution, sent at whole seconds), `olderAfterAnswer` (held after the
answer yet older than T, dropped: above 0 means NinjaTrader delivers some live trades after its answer has them),
`released`,
`resolutionMs` (the time step both sides were compared at: 1, 1000, or 0.0001 for NinjaTrader's 100 ns; 0.3.7: `tickToAheadMin`
and `tickRetriedEndingNow` went with the by-date tick load), `minuteTailRebuilt` (minute bars rebuilt from
trades; 0 when NinjaTrader's was kept, -1 when there was none), `ntTailVolume` and `rebuiltTailVolume` (that minute's volume,
NinjaTrader's and rebuilt from trades; null when not compared); and `accounts`: one row per watched account with `name`, `connection` (status),
`executions`, `orders`, `positions` (counts NinjaTrader holds) and `fillEvents`, `orderEvents`,
`positionEvents` (events seen). Account names are in this local page; never copy them into reports.
`sides` (0.3.4, see Trade side): one entry per instrument with `live` (null before its first quote or trade:
`trades`, `aggressor`, `bidAsk`, `tickRule`, `none` counts since the start, `liveTieChanged` (trades the other tie rule,
a quote at the trade's own time counts, would call differently), `quoteAfterTrade` (trades whose latest-arrived
update was stamped after them), `staleQuotes`, the latest `bid` and `ask`, `bidUpdates`, `askUpdates`, `quoteResets`,
and `eventQuoteSame`, `eventQuoteDiffers`, `eventQuoteNone`: whether the Last event's own Bid and Ask equal the latest
updates). (0.3.7: `lastLoad` and `quotesOutstanding`, the by-date backfill's sides and its Bid and Ask requests, are gone
with it.) `settlements` (0.3.7): per root, `p`, `ntTime` (New York time of NinjaTrader's stamp on it), `receivedUtcMs`, `from`
(`snapshot` at subscription, or `update`), `changes`. `htf` (0.3.7): per root and timeframe (`"MNQ 4h"`), `bars` kept, `asking`,
`waiting` (pages waiting for the answer), `day` (the trading day of the answer), `stale` (a feed drop since), `asks`, `served`,
`askedAtUtcMs`, `answerMs`, `callbackMs` (on NinjaTrader's callback thread), `lastError`.

## Fills to The Desk (0.2.0, off by default)

With `postFills = true` in `config.txt`, every fill is also sent to The Desk's `POST /api/fills`
(`deskUrl`, default `http://localhost:8800`) in The Desk's fill shape, with `source` `nt8`. Fills
wait in `pending_fills.jsonl` next to `config.txt` until The Desk accepts them, so a restart or The
Desk being closed loses nothing; The Desk ignores duplicates. A request gives up after 10 seconds; a fill
The Desk refuses as malformed is set aside in `rejected_fills.jsonl` so it never blocks the queue. Fills from every watched account are
sent: The Desk's Accounts menu decides which accounts count. ChartBridge sends no commission (NinjaTrader's
figure is its own commission template, not what was charged).

## Daily bars to The Desk (0.3.6, off by default)

Contract v1 (2026-09-30, approved by Anthony), shared with The Desk's `POST /api/bars`. With `bars = on` in
`config.txt` (`barsRoots`, default `NQ, MNQ, ES, MES`; `pc`, default the Windows computer name), ChartBridge
sends each session's 1-minute bars to The Desk (`nt8/ChartBridgeBars.cs`).

- **Session:** 18:00 New York time (the previous calendar day) to 17:00; its date is the New York date it ends
  on, so the Sunday 18:00 open belongs to Monday. Daylight saving comes from the time zone (it changes on a
  Sunday at 2 AM, when the market is shut, so a session is always 23 hours). Early closes are ordinary
  sessions that end sooner; full holidays of the trading hours template (`TradingHours.Holidays`) are skipped.
- **Which contracts:** per root, the contract the chart uses for that session: `contract.<ROOT>` if set, else
  the front month by the chart's roll rule (8 days before the third-Friday expiry) on the session date. Plus
  any other contract of that root with fills in that session (from the watched accounts' executions;
  NinjaTrader keeps the current session's only, so after a restart older sessions get the front month only).
- **The request:** `BarsRequest(instrument, from, to)`, 1 minute, `MarketDataType.Last`, the instrument's trading
  hours (as the chart), `MergePolicy.DoNotMerge` (that contract's own prices). NinjaTrader turns from and to
  into whole trading days, so ChartBridge asks from the day before the session's open to the day after its
  close (never past now), in NinjaTrader's time zone, and keeps the minutes that opened at or after the
  session's open and closed by its close and by now. No partial bars.
- **Stamps:** NinjaTrader stamps a bar at its close, in the time zone set under Tools > Options > General. Each
  bar is sent as `[t, o, h, l, c, v]` with `t` its open: the stamp converted to UTC, less 60 s, in Unix
  milliseconds. Sorted by `t`, one per minute; prices and volume exactly as NinjaTrader has them.
- **When:** from 17:05 New York time for the session that just closed, if a price feed is connected; and from
  2 minutes after ChartBridge starts, any of the last 5 sessions not taken by The Desk yet (the catch-up). What
  is due is looked at once a minute on ChartBridge's bars thread (background, below normal priority). In regular
  trading hours (09:30 to 16:15 New York time, weekdays) nothing is asked, except that start's catch-up until it
  has been through every session once.
- **Through the gate, last of all** (0.3.5's one-at-a-time gate, see Served window and session table): a bars
  request is queued only when the gate is idle: not stopped, not stuck, nothing out, nothing queued, no minute
  chart's last trades out, no page loading, and no session backfill still to come (queued, waiting for its start,
  or failed once and due again). The gate sends it only while no backfill is queued, no last trades are out and no
  page is loading. So it never goes beside a window or a backfill, and a window or backfill asked while it is out
  waits behind it (one contract's minutes: about a second). When the gate is not idle nothing is queued and the
  pass ends (`/diag` `bars.waitingForGate` says why); the next minute looks again, so nothing piles up. A request
  queued but not sent within 60 s is taken back. In the gate it is the job `bars <session> <contract>` (`/diag`
  `books.gate.now`, `barsQueued`); one NinjaTrader does not answer in 60 s is given up and, unlike a window or a backfill (X1), **frees the
  gate** (Anthony: the chart never waits on bars). Windows and backfills then go as usual, so one may go while
  NinjaTrader is still working on that bars request (an accepted risk). Its late answer is dropped, not copied, and
  never frees or changes another request's stuck state (only `gateStuckJob`'s own answer does). Requests are
  2 s apart. A failure (no answer, an error, an empty answer, an unknown instrument) is logged once and tried again
  after 15 minutes, 3 times in all, then not until the next start.
- **Stop** (F5, closing NinjaTrader): `Stop()` stops the bars before the gate. Nothing more is asked of NinjaTrader
  or posted to The Desk: the worker leaves any wait at once, a post in flight is aborted (the message stays
  queued), an answer that comes later is not copied or queued. `Stop()` runs on NinjaTrader's thread, so it waits
  250 ms for the worker at most, as for the gate's worker.
- **Message:** `{"v":1,"source":"chartbridge","bridge":"0.3.8","pc":"HOME","contract":"MNQ 12-26","root":"MNQ",
  "tick":0.25,"session":"2026-09-30","tf":"1m","stamp":"open","bars":[[t,o,h,l,c,v],...],"complete":true}`,
  one per contract per session. Market data and the PC name only.
- **Queue:** each message is written to `pending_bars.jsonl` (next to `pending_fills.jsonl`, replaced
  atomically) before it is sent, then posted to `deskUrl` + `/api/bars`, one per request, oldest first, with
  a 10 second limit and nothing added (The Desk guards it as it guards `POST /api/fills`, and refuses it
  through the public tunnel). Anything but an answer retries every 10 seconds; 400 or 422 (malformed) sets it
  aside in `rejected_bars.jsonl` with The Desk's reason in the Output window, and it is not asked for again
  (0.3.7, review bars1 N1: not after a restart either; such sessions are kept in `refused_bars.txt`, `yyyy-MM-dd contract`,
  40 days). Sessions The Desk took are kept in `sent_bars.txt` (`yyyy-MM-dd contract`, 40 days)
  so the catch-up skips them. The Desk stores by (contract, t), so a message sent twice stores once. A message in
  `pending_bars.jsonl` for a session older than 40 days is dropped when the queue is read (one Output line), so the
  queue never outlives the record. The three files are read on the bars thread when it starts, never on NinjaTrader's
  thread (0.3.7, review bars1 N7).

## Orders (protocol v2, Step 2: trading from the chart)

Decided by Anthony on 2026-09-29: market buy/sell, limit and stop by clicking a price, brackets
(stop and target as an OCO pair), flatten and cancel all; one click while an **Armed** switch is on
(the switch is off after every page load); accounts Sim101 plus Anthony's Lucid evals, named by Anthony
in `config.txt`. Orders go through NinjaTrader's own order system (`Account.Submit` and friends), so
the broker and the prop firm see NinjaTrader orders.

### Safety gates (all enforced in ChartBridge, never only in the page)

1. **Off by default.** Nothing below works unless `config.txt` has `trading = true`.
2. **Account allow-list.** `tradeAccounts = Sim101, <eval names>` in `config.txt`. An order for any
   other account is refused. Backtest and Playback accounts are never allowed. There is no wildcard.
   The account must also be **Connected** in NinjaTrader, and ChartBridge must be listening to its
   order events (it starts listening on the first order if it was not yet).
3. **Size caps on the order and the position.** `maxQty.MNQ = 5` style lines, per instrument root;
   default **1** for any root without a line. No single order may exceed the cap, and the cap limits what
   the position could become: the current position (read two ways, as NinjaTrader lists it and with fills
   it has reported that are not in the position yet, taking the worse, since event order differs between
   connections; a position update consumes only the fills its change explains), plus every order on the same side that may still fill (working, part filled,
   or with a cancel still pending; orders placed in NinjaTrader and bracket legs too; ChartBridge's own
   orders from the moment they are sent; orders that share an OCO id count once, at the largest), plus
   the new order. One order is checked and sent at a time, across all pages. Selling out of a long, or
   buying back a short, is always within the cap.
4. **This page only.** Order messages are accepted only on a WebSocket whose `Origin` header is
   ChartBridge's own page (`http://localhost:<port>`), and only after the page sends the session
   token it read from `GET /session` (served same-origin, no CORS headers, a new random token each
   time ChartBridge starts; `/session` answers only when asked for as `localhost:<port>`, and like every
   path only to this PC). Other web pages, including those in `allowOrigins`, and The Desk, stay read only. Every page
   ChartBridge serves carries `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors
   'none'`, so no other site can show it in a frame and trick a click.
5. **Price and tick checks.** Limit and stop prices must be on the instrument's tick grid (and, only
   when `config.txt` sets `maxTicksAway`, within that many ticks of the last price; before 0.3.7 always
   within 200), and that last price must be under 300 seconds old; stop orders must be
   on the right side of the market (a buy stop above, a sell stop below), and so must limits (a buy
   limit at or below the last price, a sell limit at or above: a limit through the market would fill at
   once, which is a market order in disguise). The same checks apply when an order is moved. Refused
   otherwise.
6. **Instruments.** Only the roots ChartBridge serves (`roots`), on the contract it resolved. An order
   on any other contract is never sent to the page and cannot be moved or cancelled from it.
7. **Rate limit.** At most 10 order actions per second per connection; more are refused.
8. **Strict messages.** Only the keys in the table below; anything else (a misspelt `bracket`, a key with
   a space or a dash) is refused, never ignored. `qty` and bracket ticks must be plain JSON whole numbers
   (no quotes, no decimals, no exponent, no leading zero, at most 9 digits), and so must `plan`'s
   `stopTicks` and `targetTicks` (0.3.8; or `null`); `price` a plain decimal. A
   message with any backslash escape is refused. No key may appear twice. No list
   and no nested object except `bracket`, which must be an object (`"bracket": null` is refused).
   A WebSocket message over 64 KB closes the connection.

A refusal never reaches NinjaTrader; it comes back as `reject` with a plain reason.

### Brackets

A bracket is `{ "stop": ticks, "target": ticks }`, each a whole number of 0 or more (0 means none;
both 0 means no bracket; at most `maxBracketTicks` when `config.txt` sets it; before 0.3.7 at most
200). It may only go on an order that opens or adds to a position; on an order that would reduce the
position (by both position readings) it is refused. The ticks are always from each fill's actual price
(0.3.8, Anthony's ATM rule; 0.3.7 anchored a limit or stop entry's bracket to prices, which 0.3.8 drops). On a
resting (limit or stop) entry they can be changed before the fill: see "Planned stop and target on a resting
entry (0.3.8)" below.

- **Placed per fill.** Each time the entry fills (all at once, or in parts), that increment gets its
  own stop and target for exactly that many contracts, priced from that increment's fill price (the
  entry's planned ticks as they are when the fill is handled), as an OCO pair (`oco` = `cb-<tag>-<filled so far>`). Legs are **GTC**. With only a stop or only a target,
  the lone leg has no OCO id. Legs from an order event are always placed in full, without reading the
  position at fill time (event order differs between connections, so that reading can be stale, and a
  withheld stop is the worst outcome). If a fill turns out to have closed an opposite position (for
  example a bracketed sell limit that fills after Anthony went long elsewhere), the legs check below
  removes the legs from the wrong side once the position has settled.
- **Stop level already passed.** If the stop price has already traded when the fill is reported (a
  fast market, a late event), and ChartBridge has a trade price from the last 2 seconds to prove it,
  ChartBridge sends a market exit for that increment instead of a stop through the market (which a
  broker rejects, and a rejected leg can take its OCO partner with it), and raises a `status` `error`.
  A rejected market exit raises a `status` `error` too ("the position may have NO STOP").
- **Named for recovery.** The entry's order name carries the bracket as placed (`CB#1a2b3c4d s8 t16` for a
  market entry, any number of digits; `CB#1a2b3c4d atm s8 t16` for a limit or stop entry, 0.3.8; 0.3.6 named
  every entry `s8 t16`, 0.3.7 named a resting one `plan s24980.25 t25010.5` with prices), and each
  leg's name carries its fill increment: `CB#1a2b3c4d stop f2 q2 p24990.25` (the pair for the fill that
  brought the entry to 2 filled, 2 contracts, filled at 24990.25); a market exit is
  `CB#1a2b3c4d exit f2 q2 p24990.25`. After a recompile or restart of ChartBridge the bracket is rebuilt
  from these names (covered contracts, their prices, and the working pairs), so later fills still get
  legs at their own price and earlier ones do not get a second set.
- **Nothing missed while stopped.** Any NinjaScript compile reloads the add-on, and an entry that fills
  meanwhile sends no further update. Every 2 seconds (and at start) every ChartBridge entry with fills
  is checked; a fill without legs that has stayed that way for 4 seconds (so an order event still on its
  way is never raced) gets legs for the contracts the settled position holds in the entry's direction
  beyond what ChartBridge's other legs cover, with a `status` `warn`. Never twice.
- **A stop that goes missing is loud.** For any contract ChartBridge has put legs on (remembered across
  reloads from the working legs), whatever direction the position now has, if the working ChartBridge
  stops on the closing side cover fewer contracts than the position holds for 4 seconds (a stop rejected
  or cancelled by hand, contracts added without a bracket, or a leg that filled and left a position of
  its own), the page gets a `status` `error`, once per situation and again if it happens on a later trade.
  When the stop was cancelled or rejected and NinjaTrader's OCO cancelled its target too (0.3.1, from the
  Sim101 test), the text says so: "... working stops cover 0 contract(s); the target was cancelled too (OCO),
  so the position has no stop and no target; check NinjaTrader and add a stop". When the target went first (a
  rejected target, or a target cancelled by hand, whose OCO then cancelled the stop), it says "the target was
  rejected (or cancelled) and the stop was cancelled with it (OCO)" instead. A lone rejected leg is taken as the
  one that went first (an OCO partner is cancelled, never rejected); otherwise the first leg reported gone. The
  start of the text is unchanged. Pairs ChartBridge cancels itself (Flatten, a flat position, the legs check) are not called lost;
  after a reload only pairs lost since then are known.
  A market exit that is rejected or cancelled raises an error too.
- **Reconnects.** The scan never decides "no legs needed" while the account's connection is not steady
  (a reconnect can list orders before positions); it places what the listed position shows and looks
  again later.
- **Partner follows.** When one leg fills in part, its partner is shrunk to what is still open; when
  one fills in full, its partner is cancelled.
- **Never opens a position.** When the position goes flat (and is still flat when checked, on a
  connection that has been up for 30 seconds), ChartBridge's working legs on that contract that are more
  than 3 seconds old are cancelled, with a `status` `warn` (younger legs may belong to a new entry whose
  position change has not landed yet; the legs check handles them). Every 2 seconds a check compares
  ChartBridge's legs with the position: legs on a flat or opposite position are cancelled, and legs
  covering more contracts than the position are shrunk, newest first. It acts only when the same
  position and legs have held for 4 seconds and the account has been Connected for 30 seconds without a
  break (a reconnect can show orders before positions; a NinjaTrader connection status change starts
  the 30 seconds again for the accounts on that connection, so a drop between two samples is not
  missed, while a price-feed-only status event changes nothing), and says so with a `status` `warn`. Orders not named `CB#` are never touched by it.
- **A late fill after Flatten is protected.** If an entry fills after `flatten` (its cancel lost the
  race), it still gets its stop and target, and a `status` `error` says a position may be open.
- **Upkeep never stops.** Bracket upkeep runs even if `trading` is switched off, so a position placed
  from the chart keeps its legs.
- **Problems are loud.** A leg that NinjaTrader rejects raises a `status` `error` ("the position may have
  NO STOP") and is logged in NinjaTrader's Output window.

Stop-limit orders are shown but can only be moved in NinjaTrader.

### Planned stop and target on a resting entry (0.3.8)

Decided by Anthony on 2026-10-01 at HOME, after trying 0.3.7 ("it should not be the planned target, it should be the
current target"): like a NinjaTrader ATM, a resting (limit or stop) entry's stop and target are **distances in ticks
from its actual fill**, and they **travel with the entry** when it is moved. This replaces 0.3.7's planned prices
(`stopPrice`/`targetPrice` on `order`, a price `plan`, the wrong-side and move-past refusals), which no page used.
A market entry is unchanged: ticks from its fill.

- **At placement.** `order` takes `bracket: {"stop": ticks, "target": ticks}` as always (0 = none), and nothing else
  for it (`stopPrice` and `targetPrice` are gone: unknown keys, refused).
- **Moving the entry** (`change` on it) moves nothing else and is never refused for its bracket: the distances go with
  it. Anthony's workflow: place the limit lower than he means to, drag it to its spot (stop and target follow), and drag
  the planned stop and target lines where he wants them (each drag sends a `plan` with the new distance).
- **At the fill.** Every fill increment's legs go at that increment's fill price minus the stop ticks and plus the
  target ticks (a sell the other way), with the planned ticks as they are when the fill is handled. On a gap or
  slippage the legs are from the actual fill, so the stop is always on the right side of it; the market exit is
  only for a trade from the last 2 seconds at or through the stop level (see Brackets). After a recompile, contracts
  handled with no legs before it (no name records their price) make the next increment's price unknown from the
  names: it is read from NinjaTrader's executions of the entry (`Account.Executions`, the ones whose `Order` is the
  entry or that carry its `OrderId`). When they cannot give it, NO legs are placed from an estimate: a `status`
  `error` says "NO STOP: N contract(s) ... filled while ChartBridge was restarting ...; set the stop in NinjaTrader",
  and the missing-stop alarm watches the position. The stop-already-traded check only ever runs on a real price.
- **Changing the plan** (`plan`, below) before or between fills: set, change or remove the stop or target distance.
  A distance is a whole number of 1 or more (at most `maxBracketTicks` when `config.txt` sets it); `null` removes it.
  Adding a stop or target to an entry that had none is a new bracket: refused on an order that would reduce the
  position (by both readings), as at placement. After a part fill, a `plan` applies to the fill increments still to
  come only; legs already working are not touched (move them with `change` on the leg, as B/E does). If contracts of
  the entry already filled with no stop and the plan adds one, a `status` `error` says those contracts have no stop.
  After a recompile, contracts that were handled with no legs after the last pair ChartBridge can read from the order
  names are not known, so the next fill gets legs for them too (more protection; the legs check trims legs beyond
  the position). A fully filled, cancelled or rejected entry, a market entry, a leg, and an order placed elsewhere
  are refused.
- **A plan racing a fill.** The new distances are set in memory at once, together with a check that every fill
  NinjaTrader has reported for the entry has been handled (under the lock the fill path holds while it takes an
  increment and reads the distances for its legs), before anything is written to a file. A fill handled after that
  gets the new distances. If NinjaTrader has reported a fill ChartBridge has not handled yet, the plan is refused:
  "1 contract(s) filled before this plan arrived; they get the planned stop 8 / target 16 ticks as it was; nothing
  changed: send the plan again for the contracts still to fill"; when the entry had no planned stop, a `status`
  `error` says those contracts get NO STOP.
- **Told to the page.** Every `order` message for a working limit or stop entry ChartBridge placed carries
  `"planned": {"stopTicks": 8 or null, "targetTicks": 16 or null}` (null = none). Pages that do not know the key
  ignore it. After a `plan` the entry's `order` message is sent again; a refusal is a `reject`.
- **Survives a recompile or a restart.** An order's name cannot be changed after it is sent, so the name carries the
  ticks it was placed with (`atm s8 t16`) and the edits live in `planned_brackets.txt` in ChartBridge's folder, one
  line per entry, `<tag> ticks <stopTicks> <targetTicks> <saved UTC ms>` (0 = none), written whole to a temp file and
  swapped in. The records live in memory under a small lock never held during file I/O; the file is a copy. It is
  read once at start on a pool thread, started before ChartBridge watches the accounts (a read that fails, as when
  an antivirus holds the file, is tried again for a few seconds; if it still fails the file is never rewritten that
  run and the pages get a `status` `error`); written after a placement and after a `plan` on the page's connection
  thread, outside every lock, tried again a few times when it fails, and again every 2 seconds until it succeeds, with
  a `status` `error` while it does not; a line is removed (on a pool thread) once its entry is done and every fill has
  legs. Every 2 seconds ChartBridge also checks that each working resting entry with a bracket has its line, and
  writes it if not. NinjaTrader's thread only reads memory. Until the file has been read (the first moments after a
  start), a resting entry's bracket is not recovered: a fill's legs wait. A fill an order event reported meanwhile gets
  its legs the moment the file has been read (the full increment, as its event would have). A fill the 2 second check
  found first (one from while ChartBridge was stopped, whose position may have been closed by hand since) is left to
  that check, which legs only what the listed position still holds (never a flat account); if the file is still not
  read about 3 s after the check first sees such a fill, every signed-in page gets a `status` `error` naming the entry
  with NO LEGS. `plan` and `change` on such an entry are refused meanwhile ("ChartBridge is still reading
  planned_brackets.txt"); nothing is guessed. A `plan` whose save fails still applies (the fills use what Anthony set)
  and raises a `status` `error` that it may not survive a recompile. Lines older than 7 days are dropped when the file
  is read (entries are Day orders).
- **Missing record.** If a recovered 0.3.8 resting entry (`atm`) still working (or with fills that have no legs) has no
  line in `planned_brackets.txt`, ChartBridge never guesses: it uses the ticks in the entry's name (as placed) and
  raises a `status` `error` at recovery and again at the fill, naming them and saying they may be out of date (and
  "There is NO planned stop" when the name has none). A `plan` sent then saves a new record and ends the alarm.
- **Entries placed before 0.3.8 and still resting after the upgrade.** A 0.3.6 entry (`s8 t16`) is already ticks from
  the fill: it is recovered as it is, and a `plan` on it is accepted (its line is then written). A 0.3.7 entry
  (`plan s<price> t<price>`, its planned prices from its 0.3.7 line in `planned_brackets.txt`, else from its name) is
  converted once, at recovery, to the distances it shows now: stop and target ticks from the entry's current price
  (rounded to the tick; a price on the wrong side of the entry, or none, is no stop or no target). The converted
  ticks are written as its line, and the pages get a `status` `warn` naming them; when its planned stop was on the
  wrong side (the entry was moved past it), a `status` `error` saying it has NO STOP, and the same error again when
  it fills, until a `plan` gives it a stop. From then on it is an ATM entry.
  0.3.7 price lines for entries ChartBridge has not seen yet are kept in the file until their entry is converted or
  they are 7 days old.

| type | fields (no others are accepted) | notes |
|---|---|---|
| `plan` | `cid` (optional), `id` (the entry's ChartBridge id), `stopTicks` and/or `targetTicks` (a whole number of 1 or more to set the distance, `null` to remove it; a key left out is unchanged; at least one) | counted in the 10 actions a second; the same trading, sign-in, account and contract gates as `change`; never reaches NinjaTrader |

A `bracket` object is accepted on `order` only: on `plan`, `change` or `cancel` it is refused ("unknown key
"bracket""). On `flatten` it is ignored, as before 0.3.7, so Flatten is never refused for anything new.

Examples: `{"type":"order","cid":"c7","account":"Sim101","root":"MNQ","side":"buy","kind":"limit","qty":2,"price":24990,"bracket":{"stop":8,"target":16}}`,
`{"type":"plan","cid":"c8","id":"o5","stopTicks":12}` (drag the planned stop line to 12 ticks from the entry),
`{"type":"plan","cid":"c9","id":"o5","targetTicks":null}` (remove the target). The `order` message for that entry:
`{"type":"order","id":"o5",...,"role":"entry","oco":null,"planned":{"stopTicks":12,"targetTicks":null}}`.

**Optional distance limits** (`config.txt`; absent means no limit; a value that is not a whole number of 1 or
more is ignored, so there is no limit, with a line in the Output window and a `status` `warn` to every signed-in
page at config load and to each page as it signs in successfully (never to one whose sign-in failed), Anthony 2026-10-01; for the page build: show it): `maxTicksAway = 400` (a limit or stop price, placed or moved,
at most 400 ticks from the last price) and `maxBracketTicks = 300` (bracket ticks, and a `plan`'s `stopTicks` and
`targetTicks`, at most 300). When set, the `trading` message names them
(`"maxTicksAway": 400`, `"maxBracketTicks": 300`).

### Signing in

1. `GET /session` (same origin, no CORS headers) answers `{"token": "<48 hex characters>", "trading": true|false}`.
   The token is new each time ChartBridge starts. Since 0.3.2 it also needs the page's PIN unlock in the
   `X-ChartBridge-Unlock` header (see PIN), or it answers 403.
2. After `hello`, the page sends `{"type":"auth","token":"..."}` on the WebSocket and gets a `trading`
   message back; when `enabled` is true, `orders` and one `position` per open position follow.
3. A page that is shown inside a frame should not sign in (ChartBridge's headers already stop other
   sites from framing it).

### Page to server

| type | fields (no others are accepted) | notes |
|---|---|---|
| `auth` | `token` | once per connection, after `hello`. Answer: `trading` (below). |
| `order` | `cid` (page id, string, optional), `account`, `root`, `side` (`buy`/`sell`), `kind` (`market`/`limit`/`stop`), `qty`, `price` (limit/stop only; a market order with a price is refused), `bracket` (optional, see Brackets) | |
| `plan` | `cid` (optional), `id`, `stopTicks`, `targetTicks` | 0.3.8: set, change or remove a resting entry's planned stop and target distances (see above) |
| `change` | `cid` (optional), `id` (ChartBridge order id, `o1`, `o2`, ...), `price` | move a working limit or stop, or a bracket leg (drag on the chart) |
| `cancel` | `cid` (optional), `id` | cancel one working order (cancelling one leg of an OCO pair cancels its partner) |
| `flatten` | `cid` (optional), `account`, `root` | cancel every working order for that account and instrument, then close the position at market |

String values must be plain (no backslash escapes, at most 200 characters).

### Server to page

| type | fields | when |
|---|---|---|
| `trading` | `enabled` (bool), `reason` (when not enabled), `accounts` (allowed names), `maxQty` (`{root: n}`, including the default under `"*"`), `maxTicksAway` and `maxBracketTicks` (0.3.7, only when `config.txt` sets them) | answer to `auth`; also in `hello` with `enabled` false until `auth` succeeds |
| `orders` | `list`: `[order]` | after `auth`, every working order on the allowed accounts |
| `order` | `id` (ChartBridge's id, stable while the order lives), `cid` (when placed from this page), `account`, `root`, `name`, `side`, `kind` (`market`, `limit`, `stop`, `stopLimit`, `other`), `qty`, `filled`, `price` (limit or stop price, or null), `avgFill` (or null), `state` (`working`, `partFilled`, `filled`, `cancelled`, `cancelling`, `rejected`), `role` (`entry`, `stop`, `target`, or `other` for orders placed elsewhere), `oco` (or null), `text` (NinjaTrader's error when rejected or failed), `planned` (0.3.8: on a working limit or stop entry ChartBridge placed, `{"stopTicks": n or null, "targetTicks": n or null}`) | every order change, live; and again after a `plan` |
| `position` | `account`, `root`, `qty` (signed: long positive, short negative), `avgPrice` (or null when flat) | after `auth` and on every change |
| `reject` | `cid` or `id` (whichever the message had), `reason` | a refusal by ChartBridge's gates |
| `status` | `level` `error` (a bracket leg rejected or a bracket error: check the stop now) or `warn` (the legs check cancelled or shrank legs), `text` | bracket problems, to signed-in pages |

Orders placed in NinjaTrader itself (or anywhere else) on an allowed account also show on the chart,
with `role` `other`, and can be moved or cancelled from the chart.

## 0.4.0 hardening and markets

### Quote-only markets

`config.txt` `quoteRoots` (default `YM, RTY, GC, SI, CL, 6E, ZN, ZB`; `quoteRoots =` for none) names markets ChartBridge
serves for the Quote board only. The traded roots stay `roots` (default `MNQ, NQ, MES, ES`); a root in both lists is
quote only. A quote-only market streams like the others (`hello`, `subscribe`, `history`, `tick`, `profile`, `htf`,
`weekProfile`, the prior settlement), and every order action for it is refused:

- `order` and `flatten` naming it, and `change`, `plan` and `cancel` naming an order on it (placed in NinjaTrader),
  get `reject` with the reason `<ROOT> is quote only: ChartBridge shows its prices on the Quote board and refuses every
  order for it (quoteRoots in config.txt)`. One check, right after the gate and the strict message check, before any
  other order code. Nothing reaches NinjaTrader.
- The order code's lookups (`InstrumentFor`, `RootFor`) never return a quote-only root or contract, so its orders and
  positions are not listed to the page as chart orders, as for any root ChartBridge does not trade.

Each `hello` instrument carries two more fields, after `pointValue` and before `settlement`:

| field | value |
|---|---|
| `quoteOnly` | `true` for a quote-only market (orders refused), `false` for a traded root |
| `priceFormat` | `"decimal"`, or `"32nds"` for ZN and ZB: the page writes 104.109375 as `104'035` (104 and 3.5/32) |

`tick` is NinjaTrader's tick size (MasterInstrument.TickSize); a table in `ChartBridgeTape.cs` is used only when
NinjaTrader gives none (YM 1, RTY 0.1, GC 0.1, SI 0.005, CL 0.01, 6E 0.00005, ZN 1/64, ZB 1/32).

Front month, per market (New York dates; `contract.<ROOT>` in `config.txt` still wins):

1. NinjaTrader's own rollover list (Tools > Instruments > Rollovers, MasterInstrument.RolloverCollection): the contract
   month of the latest rollover on or before today, used only when the list also holds a later one (else out of date).
2. Else the table's rule, the roll 8 calendar days before a key date: YM and RTY as the equity index roots (the third
   Friday, quarterly); 6E quarterly, its last trade two business days before the third Wednesday; CL every month, its
   last trade three business days before the 25th of the month before (counted from the business day before the 25th
   when the 25th is not one); GC (Feb, Apr, Jun, Aug, Oct, Dec), SI (Mar, May, Jul, Sep, Dec), ZN and ZB (quarterly),
   their first notice day, the last business day of the month before. Business days: Monday to Friday, not an NYSE holiday.

The traded roots keep their rule exactly (checked for every day of 2026 and 2027). How each root was resolved is in the
Output window at start and in `/diag` `markets`.

Prior settlement: as in 0.3.7, with each market's own settlement time in place of 16:00 ET when it is earlier (CL 14:30,
GC 13:30, SI 13:25, ZN, ZB and 6E 15:00; 12:00 on an NYSE holiday or early close for all). The snapshot read at
subscription now goes through the same one queue as the updates, in order, off NinjaTrader's thread.

### Fills after a recompile

The fills already delivered (`Seen`, keyed by account and execution id) are kept in memory only. After F5 the session's
executions go to The Desk once more. The Desk stores each `(source, account, exec_id)` once and counts a repeat as a
duplicate (not a rejection, so no Output line), and `pending_fills.jsonl` drops an identical line. Keeping `Seen` in a
file would instead skip fills that never reached The Desk before the F5 (for example with `postFills` turned on in that
same F5), so it stays in memory.

### `/diag` additions

| key | what |
|---|---|
| `health.memory` | sizes of what grows: `seenFills`, `books`, `pastSessions`, `profileRows`, `windowTrades`, `liveTradesHeld`, `sideTaggers`, `htfSeries`, `weekProfiles`, `settlementRoots`, `seamsKept`, `windowsKept`; `lastSweepUtcMs` (the 10 s sweep), `windowsDroppedAfterSession`, `lastWindowDropUtcMs`; `heapBytes`, `gcGen0`, `gcGen1`, `gcGen2` |
| `health.threads` | thread-pool headroom: `poolWorkersFree`, `poolWorkersMin`, `poolWorkersMax`, `poolWorkersBusy`, `poolIoFree`, `poolIoMin`, `poolIoMax`; `processThreads`; `pageSendThreads` (one per open page) |
| `health.pages` | `connects`, `closes`, `notKeepingUp` (pages closed for being behind), `sendErrors`, `lastConnectUtcMs`, `lastNotKeepingUpUtcMs`, `sendMs` (every send since the start) |
| `health.errors` | each rate-limited error kind (`tick error`, `tick send error`, `history error`, `tape counter error`) and how many came; the Output window says each at most once a minute, with the count since its last line |
| `pages[].sendMs` | that page's sends: `n`, `p50`, `p95`, `max` in ms |
| `markets` | per served root: `contract`, `quoteOnly`, `tick`, `tableTick`, `priceFormat`, `settlesBy`, `resolvedBy` |
| `tape` | `failed` (faults in the counters, never a lost trade), and per root `late` (prints of an earlier session) with `session` and `last`: `from` (18:00 ET) and `slots`, one per 15 minutes with prints: `at`, `prints`, `perSec`, `peakPerSec`, `gapMs` (`p50`, `p95`, `max`, by NinjaTrader's time on the prints), `sameMsU` and `sameMsRx` (share of prints in the same millisecond as the one before, by NinjaTrader's time and by arrival), `jumpTicks` (share of steps of `0`, `1`, `2`, `3+` ticks), `delayMs` (`p50`, `p95` of arrival minus NinjaTrader's time; `below0` counted apart) |

Medians and p95 are read from fixed log buckets, each about 41 percent wider than the last: the value given is the
bucket's upper edge ("at most"). Nothing is sorted and nothing is made per trade; `max` is exact.

### Send loop

Each page's send loop runs on its own thread (as the tick request worker does), so a page never holds a thread-pool
thread while it waits for its next message. Order is unchanged: before every data entry, and between the held trades
released after `ready`, the order lane is sent first.

## Protocol v3 (ChartBridge 0.4.0)

Decided by Anthony for the pre-cruise build (2026-10-07). v3 **only adds**: every v2 rule above (the eight safety gates,
brackets per fill increment, the legs check, the missing-stop alarm, recovery by order names, Flatten never refused for
anything new) stays exactly as written, and applies to everything below unless a line here says otherwise. Every new
order feature, the copier and the bot channel ship **switched off**; `trading = true` stays the master switch above all of
them; nothing in ChartBridge ever turns `trading` or a switch on by itself. Where Anthony's brief left a detail open, the
safest simple choice is written and marked **(lead's default)**.

Examples of every new message, both directions, are in `test/fixtures/protocol-v3.json`; the fake bridge
(`test/fake-bridge.mjs --v3`) answers them with simulated state.

### v3 switches (`config.txt`, all off by default)

| key | off (default) | on |
|---|---|---|
| `accountChecks` | gate 2 is `tradeAccounts`, as in v2 | gate 2 is the page's per-account checkmark (see Accounts) |
| `orderTypes` | `kind` is `market`, `limit`, `stop` | also `stopLimit` and `mit` |
| `strategies` | an `order` with `strategy` is refused | Order Strategies (stop, up to 3 targets, breakeven, trailing) |
| `merge` | `merge` is refused | Merge stops and targets |
| `cancelFromList` | a `cancel` with `from: "list"` is refused | cancel from the page's Working orders tab |
| `copier` | every `copier*` message is refused; nothing is copied | the copier engine (Sim followers only) |
| `bot` | `/bot` answers 404; every `bot*` page message is refused | the bot channel |
| `botRoot` | `MNQ` | the one root the bot trades (a micro or a mini of a served root) |

`on`, `true` and `1` mean on (any case); anything else is off, with one Output line naming the key and the value. The
switches are read at start like every key (recompile or restart NinjaTrader after a change).

### Telling the page what is on

- `hello.features` adds `"v3"` (this ChartBridge speaks v3). Quote-only markets are told per instrument (`quoteOnly`). Features are
  not secret: every page that may read gets them.
- **`client`** (page to server, new, the first v3 message): `{"type":"client","v":3}`, sent once right after `hello`. A
  connection that never sends it is a v2 page and gets **no** v3 message at all (the 1.15 page keeps working on 0.4.0
  unchanged; The Desk's relay sends nothing). `v` is a whole number; anything but 3 is refused with a `status` `warn`.
- `trading` (answer to `auth`) adds `switches`: `{"accountChecks":false,"orderTypes":false,"strategies":false,"merge":false,
  "cancelFromList":false,"copier":false,"bot":false}`, each the `config.txt` value, sent to a v3 page only. The page shows a
  feature's controls only when its switch is true; ChartBridge refuses its messages either way when it is false.

### Strict messages in v3 (gate 8, extended)

Every v3 page message (and every bot message) follows gate 8 as written, with these additions and nothing looser:

- **Keys:** only those in the tables below; another key, a key twice or a misspelt key is refused, never ignored.
- **Values:** a string is plain (printable, no backslash escape, at most 200 characters); a whole number follows gate 8's
  rule (no quotes, no decimals, no exponent, no leading zero, at most 9 digits); a price is a plain decimal; `true` and
  `false` only for keys marked *bool*; `null` only where a table says so.
- **Nesting:** no list anywhere from the page. The only nested objects are v2's `bracket` and v3's `strategy`, both on
  `order` only, both flat inside (no object or list in them). `bracket` and `strategy` on one order is refused.
- **Rate:** every v3 action (`accountTrade`, `accountArchive`, `merge`, `copier*`, `bot*` except `botSeen`) counts in gate 7's
  10 actions a second per connection.
- **Sign-in:** every v3 action needs the signed-in own page (gates 1 and 4), except `client`. A refusal is a `reject`
  (`cid` or `id`, `reason`), never sent to NinjaTrader.

### Accounts

Accounts are picked up automatically: every account the `accounts` watch list in `config.txt` matches (default all, never
Backtest or Playback). Nothing new to configure.

**The checkmark (with `accountChecks = on`).** Trading is switched on per account by a checkmark on the page's Accounts tab.
ChartBridge saves the checkmarks itself in `accounts.txt` next to `config.txt` (Anthony never edits a file): a first line
`# ChartBridge accounts (written by ChartBridge; do not edit)`, then one line per account,
`<state>\t<changed UTC ms>\t<account name>` with `<state>` `trade`, `off` or `archived`; written whole to a temp file and
swapped in, off NinjaTrader's thread, read once at start before the accounts are watched. **First start** (no
`accounts.txt`): every account named in `tradeAccounts` comes pre-checked and the file is written; after that only the
checkmarks count and `tradeAccounts` is not read again (one Output line says so). A file that exists but cannot be read is
never rewritten that run: every checkmark reads **off** and the pages get a `status` `error` ("accounts.txt could not be
read: trading is off for every account until it can"). `trading = true` stays the PC master switch above every checkmark.
Backtest and Playback accounts can never be checked. With `accountChecks` off, gate 2 is v2's `tradeAccounts` and the
checkmark messages are refused; the Accounts tab still shows the list read only.

**Gate 2 with the checkmark** (lead's default): an **entry** (an `order` that opens or adds, a `plan` that adds a stop or
target to an entry that had none, a `strategy`, a copier entry on a follower, a bot entry) needs the account's checkmark, a
Connected account and not Gone. **Exits** (`flatten`, `cancel`, `change` of a stop or target leg, the copier's exits, bracket
upkeep) need only a watched, Connected account that is not Backtest or Playback: closing must always work, so unchecking an
account, or its going Gone, never strands a position. `change` on an entry is an entry action.

**Gone.** An account is **Gone** when, for 10 s without a break (the grace): its connection is not Connected
(`connection` below), or NinjaTrader reports it disabled, or it is past its drawdown limit (`roomDrawdown` or
`roomDailyLoss` 0 or below, where NinjaTrader reports them). At that moment its checkmark goes **off** and is saved, the
pages get `accounts` and a `status` `warn` ("EVAL-A is gone (disconnected for 10 s): trading is off for it"), and the change
is logged. Bracket upkeep and the missing-stop alarm keep running for it. When it comes back healthy it is listed as
active again with the checkmark still **off**: Anthony checks it again (lead's default).

**Archive.** Only Anthony, on the page, after confirming (`accountArchive` with `confirm: true`), and only for a Gone account.
An archived account leaves every list (`accounts`, the copier, the Working orders tab); its history stays (fills, logs,
The Desk). If it connects again it comes back as active and unchecked (lead's default), logged.

**Every change is logged**: one line in the Output window and one appended to `accounts.log` (next to `config.txt`;
`<UTC ISO time>\t<account>\t<what>\t<why>`, e.g. `checked by the page`, `gone: disconnected`, `archived by the page`).
Account names appear only in these local files and the local page, never in `/diag` exports or reports.

| page to server | fields (no others) | notes |
|---|---|---|
| `accountTrade` | `cid` (optional), `account`, `on` (*bool*) | set the checkmark. On is refused for an account that is Gone, archived, not Connected, Backtest or Playback, or with `accountChecks` off; off is always accepted (signed in). After any checkmark change every signed-in page gets `accounts` and `trading` again (its `accounts` list is gate 2 now) |
| `accountArchive` | `cid` (optional), `account`, `confirm` (*bool*, must be `true`) | refused unless the account is Gone |

| server to page | fields | when |
|---|---|---|
| `accounts` | `list`: `[account]` (every watched account not archived, by name), `archived`: `[{name, at}]` (UTC ms) | to a v3 page from ChartBridge's own origin, signed in or not, right after its `client`; again on every change: at once for a connection, checkmark or Gone change; at most once a second for money and position changes |

An `account` is `{name, sim, connection, trade, tradable, state, goneWhy, goneSince, balance, pnlToday, realizedToday,
unrealized, positions, roomDrawdown, roomDrawdownWhy, roomDailyLoss, roomDailyLossWhy}`:

- `sim`: true when the account is on NinjaTrader's own simulator (Sim101 and sim accounts made in NinjaTrader), false for
  any broker account, an evaluation or funded account included (a prop firm's "simulated" account is real to
  NinjaTrader). The copier and the bot lean on this.
- `connection`: `connected`, `connecting`, `lost` (connection lost, NinjaTrader retrying), `disconnected`.
- `trade`: the checkmark (with `accountChecks` off: in `tradeAccounts`). `tradable`: what gate 2 says now (checkmark, the
  master switch, Connected, not Gone).
- `state`: `active` or `gone`; `goneWhy` (`disconnected`, `disabled`, `drawdown`, `dailyLoss`, or null), `goneSince` (UTC ms
  or null).
- Money in the account's currency as NinjaTrader reports it, numbers or null: `balance` (cash value), `realizedToday`,
  `unrealized`, `pnlToday` (the two added).
- `positions`: `[{root, name, qty, avgPrice}]` on served roots (signed `qty`), empty when flat.
- `roomDrawdown` and `roomDailyLoss`: dollars left before the trailing drawdown and the daily loss limit, where NinjaTrader
  reports them for this account (its risk values for that connection); else null, and `roomDrawdownWhy` /
  `roomDailyLossWhy` says why in plain words ("NinjaTrader does not report a trailing drawdown for this account"). Never
  estimated.

**Positions and working orders across all accounts.** For a v3 page, `orders`, `order` and `position` cover every
watched, non-archived account on the served contracts (gate 6 unchanged), not only the tradable ones. Each `order` adds
`tradable` (*bool*, the account's gate 2 for entries) and, when a v3 feature placed it, `by` (`strategy`, `merge`,
`copier`, `bot`) and `bucket` (a strategy target bucket, 1 to 3). A v2 page keeps v2's scope.

**Cancel from the Working orders tab** (`cancelFromList = on`): `cancel` takes an optional `from` (`"list"`). With it, any
working order on a watched, Connected, non-archived account on a served contract may be cancelled (checkmark or not; it
is an exit action), one order per message, with the v2 OCO rule (a leg takes its partner). With the switch off, a `cancel`
with `from: "list"` is refused ("Cancel from the Working orders tab is off (cancelFromList in config.txt)"). A `cancel`
without `from` is v2's.

### Order types (`orderTypes = on`)

`order.kind` adds `stopLimit` and `mit`. Every existing gate applies to each: tick grid, `maxTicksAway`, the 300 s stale
price, the caps (a working stop-limit or MIT counts in gate 3 like any order), the rate limit, strict keys.

| kind | `price` | also | side of the market (refused otherwise) |
|---|---|---|---|
| `market` | none | | |
| `limit` | the limit | | buy at or below last, sell at or above (v2) |
| `stop` | the stop (stop market) | | buy above last, sell below (v2) |
| `stopLimit` | the stop (trigger) | exactly one of `limitOffset` (whole ticks, 0 or more: the limit is the stop plus that many ticks for a buy, minus for a sell) or `limitPrice` (a price on the grid) | the stop as `stop`; the limit at or beyond the stop on the side that fills (a buy's limit at or above its stop, a sell's at or below) |
| `mit` | the trigger | | buy below last, sell above (at the last price it would trigger at once: refused, use market) |

`limitOffset`, when `maxBracketTicks` is set, is at most that; `limitPrice` passes gate 5's `maxTicksAway`. `limitOffset`
and `limitPrice` on any other kind are refused.

- **Moving** (`change`): a ChartBridge stop-limit moves its stop to `price` and keeps its limit the same number of ticks
  away (the offset it had); an MIT moves its trigger. v2's "stop-limit orders can only be moved in NinjaTrader" still holds
  for stop-limits placed elsewhere.
- **Brackets and strategies** go on any entry kind. A stop-limit or MIT entry is a resting entry: v2's planned distances
  (`atm`, `plan`) apply to its bracket exactly as to a limit or stop entry.
- **Names**: `CB#1a2b3c4d atm s8 t16 sl` (stop-limit), `... mit` (MIT); the offset is read from the working order itself.
- **Order messages**: `kind` is now `market`, `limit`, `stop`, `stopLimit`, `mit` or `other`; a stop-limit adds `limitPrice`.

### Order Strategies (`strategies = on`)

Like a NinjaTrader ATM strategy, run in ChartBridge. The strategies themselves are stored by the page in The Desk (shared
by every PC, see Shared settings); ChartBridge keeps none: it receives the parameters with each entry and keeps only
what the open position needs.

**Sent with the entry**: `order` takes `strategy` (in place of `bracket`), one flat object:

| key | value | rule |
|---|---|---|
| `name` | string, 1 to 40 characters | for the log and the page; not in the order name |
| `stop` | whole ticks, 1 or more | required: the stop always sits at the broker |
| `stopLimit` | whole ticks, 0 or more, or `null` | null or absent: a stop-market; a number: a stop-limit that far beyond the stop |
| `t1`, `t2`, `t3` | whole ticks, 1 or more | target distances from the fill; none, one, two or three (in order: `t2` needs `t1`, `t3` needs `t2`) |
| `t1Share`, `t2Share`, `t3Share` | whole percent, 1 to 100 | one per target given, none otherwise; they add up to exactly 100 |
| `beAfter`, `bePlus` | whole ticks; `beAfter` 1 or more, `bePlus` 0 or more and below `beAfter` | both or neither: after `beAfter` ticks of profit, the stop goes to entry plus `bePlus` |
| `trailAfter`, `trailBy`, `trailStep` | whole ticks, each 1 or more | all three or none: once `trailAfter` ticks in profit, the stop trails `trailBy` ticks behind the best price, moving only in steps of `trailStep` ticks or more |

Every distance is at most `maxBracketTicks` when it is set. A strategy is refused on an order that would reduce the
position (as a bracket). Refusals name the key ("t2Share must be a whole percent from 1 to 100").

**Allocation** (one rule, used here and by Merge): `q` contracts over shares `s1..sn` (percent): each target gets
`floor(q * s / 100)`; the contracts left over go one each to the targets with the largest remainders, a tie to the later
target; the total is exactly `q`, never more than the position; a target that gets 0 is dropped for that increment.
Example: 3 contracts at 33/33/34 give 1/1/1; 1 contract at 50/50 gives 0/1 (T1 dropped); 5 at 50/30/20 give 2/2/1 (2.5 and 1.5 tie on the remainder, the later target wins).

**Per fill increment** (v2's design): each increment of `q` contracts is allocated over the targets, and each target
bucket `k` gets its own stop and target as an OCO pair for exactly its contracts, at that increment's own fill price
(stop `stop` ticks away, target `tk` ticks away). With no targets, one stop for `q`. Legs are GTC; the stop-already-traded
market exit, the legs check, the missing-stop alarm, "never opens a position" and Flatten all work per pair as in v2.
Names: entry `CB#1a2b3c4d sg` (market) or `CB#1a2b3c4d atm sg` (resting), legs as v2 plus the bucket:
`CB#1a2b3c4d stop f2 q1 p24990.25 k2`, `CB#1a2b3c4d target f2 q1 p24990.25 k2`.

**Breakeven and trailing**, on ChartBridge's live trades for the root, per pair from that pair's own fill price: once the
best price since the fill is `beAfter` ticks in profit, the pair's stop moves to fill plus `bePlus` (a sell the other way),
once. Once it is `trailAfter` ticks in profit, the stop's level is best minus `trailBy` ticks, sent only when that is at
least `trailStep` ticks better than the stop now. With both, the better level wins. A stop **never moves back** (never
loosens), never to a price at or through the last trade (it waits for the next trade), at most one move per stop per
500 ms (lead's default), always with `change` on the working stop at the broker (a stop-limit keeps its offset). A move
NinjaTrader rejects leaves the stop where it was and raises a `status` `error`.

**Saved for a restart**: `managed.txt` next to `config.txt`, one line per managed entry, `<tag>\t<strategy as the flat
JSON object sent>\t<best price per pair>\t<saved UTC ms>`, written whole through a temp file off NinjaTrader's thread (at
placement, at each fill, and at most once a second as the best price moves); a line goes when its entry is done and its
legs are gone. **On a restart (F5, a crash)** with a managed position open, ChartBridge recovers the legs from their
names as in v2 and the parameters from `managed.txt`, takes the best price as the larger of the saved one and the trades
since the start, and keeps breakeven and trailing going: the pages get `managed` with `state` `resumed`. If it cannot
(the line or the file is missing or unreadable, or the legs do not match it), it **leaves every stop where it is**, does not
move them again, and says so: `managed` with `state` `unmanaged` and a `status` `error` ("MNQ EVAL-A: breakeven and
trailing could not be resumed after the restart; the stop stays at 24,980.25. Manage it by hand").

| server to page | fields | when |
|---|---|---|
| `managed` | `id` (the entry's order id), `account`, `root`, `side`, `name` (the strategy's), `strategy` (the flat object as sent), `state` (`waiting` entry not filled, `active`, `resumed`, `unmanaged`, `done`), `pairs`: `[{bucket, qty, fill, stopId, stop, targetId, target, be (*bool*, moved to breakeven), trailing (*bool*)}]`, `best` (price or null), `text` (null, or why) | to signed-in v3 pages after `auth` (every live managed entry), on every change |

A `plan` on a strategy entry is refused in 0.4.0 (lead's default: cancel and place it again).

### Merge stops and targets (`merge = on`)

A Merge action (a page button and a hotkey) joins the per-leg stops and targets of one account's position on one root into
**one stop and one target set for the full size at the FIRST leg's prices** (the oldest fill increment's working pair or
pairs). A leg added after a merge gets its own bracket as usual, until Merge again.

**Refused** (a `reject`, nothing sent to NinjaTrader) when: `merge` is off; the account or root fails a gate; the position
is flat; there are fewer than two pairs; an entry (any ChartBridge entry, or an order placed elsewhere on the opening
side) is working or part filled on that account and root; the position changed in the last 2 s or the two position
readings disagree (the position is changing); the working ChartBridge stops do not cover exactly the position (let the
legs check settle first); the account has not been Connected for 30 s without a break; or the first leg's stop is already
through the market (a long's at or above the last trade, a short's at or below).

**The result.** One stop order `S` for the whole position at the first leg's stop price.
- With one target (or none) on the first leg: the first pair is kept and grown: `S` is its stop, `T` its target, still an
  OCO pair (NinjaTrader keeps them in step).
- With two or three targets on the first leg (a strategy): `S` is a new stop with no OCO, and the targets are new orders at
  the first leg's target prices, the whole position allocated over the strategy's shares by the allocation rule above
  (remainder by largest remainder, a tie to the last target, a 0-contract target dropped). As a target fills, ChartBridge
  shrinks `S` to the position at once (`change` on its quantity); when `S` fills, ChartBridge cancels the targets.
  Names: `CB#1a2b3c4d mstop q3 p24980.25`, `CB#1a2b3c4d mtarget q1 p25010.25 k2`.

**The swap, in a fixed order.** Each step waits for NinjaTrader to confirm it (3 s at most) and re-reads the position and
the working stop quantity before the next:

1. Freeze the account and root: `order`, `plan`, `change`, `merge` and breakeven/trailing on it are refused or paused for the
   swap; Flatten is always accepted and ends the swap at once.
2. Remember every pair (ids, prices, quantities) for the restore.
3. For each pair other than the one kept, **newest first**: cancel the pair (its stop; the OCO takes its target) and wait
   until both are confirmed cancelled; then grow `S` by that pair's quantity (a `change` on the kept stop, or for a
   strategy the first time a new `S` is placed for that quantity), then the kept target likewise. So the working stop
   quantity is **never above the position** (never over-protected); a working stop is there throughout, and the pair's
   contracts are covered again by `S` within one confirmation (lead's default: cancel first, then grow; the brief
   moment between them is the accepted cost of never over-protecting).
4. For a strategy, place the merged targets last (their total equals the position).
5. Check: one working stop for exactly the position, targets not above it.

**Any failure** (a step rejected, not confirmed in 3 s, a fill during the swap, a reconnect) stops the swap and **restores
the original brackets**: `S` shrinks back pair by pair (shrink first, then place that pair again at its original prices),
newest last, with the same checks. The page gets `merge` with `result` `restored` and the reason in plain words. If the
restore itself fails, ChartBridge makes sure one working stop covers the whole position at the first leg's stop price
(the stop-already-traded rule applies), and raises a `status` `error` ("MNQ EVAL-A: the merge failed and the original
brackets could not be put back; ONE STOP at 24,980.25 covers 3 contracts; NO TARGET; check NinjaTrader"), `result`
`failed`. A restart in the middle of a swap is caught by the legs check and the missing-stop alarm as in v2, with a
`status` `error` naming the account and root. Every merge is logged (Output window) and counted in `/diag` `merges`.

| page to server | fields (no others) |
|---|---|
| `merge` | `cid` (optional), `account`, `root` |

| server to page | fields | when |
|---|---|---|
| `merge` | `cid` (when the page sent one), `account`, `root`, `result` (`merged`, `restored`, `failed`), `stop` (`{price, qty}` or null), `targets` (`[{price, qty}]`), `pairsBefore`, `text` | once per accepted merge, when it ends |

### Quote-only markets (`quoteRoots`)

Built and documented in "0.4.0 hardening and markets" above, which is the contract: `quoteRoots` (default `YM, RTY, GC,
SI, CL, 6E, ZN, ZB`, `quoteRoots =` for none), the early refusal of every order action naming one, each market's own
front-month roll, and the `hello` instrument fields `quoteOnly` and `priceFormat` (`"decimal"`, or `"32nds"` for ZN and
ZB; the page shows half 32nds when the tick is 1/64, so ZN `104.109375` is `104'035` and ZB `118.46875` is `118'15`).
Copier and bot orders on a quote-only root are refused by the same check. Prices on the wire stay plain decimals.

### Copier engine (`copier = on`)

**Sim only.** Every follower must be an account with `sim` true (NinjaTrader's simulator). A real account as a follower is
refused at `copierFollower` and, should one ever be listed (the file edited, an account that changed), refused again
before every order and logged ("copier: EVAL-A is not a Sim account; nothing copied to it"). The unlock for real accounts is
a separate step Anthony takes later; 0.4.0 has no key for it (lead's default). The leader and every follower also need gate
2 for entries (the checkmark, or `tradeAccounts`), and every gate applies to each follower order on its own account (caps
on the follower's root, the rate of the copier itself is not counted against the page).

**The leader** is one account, and only entries placed **from ChartBridge's own page** on it are copied (not entries placed
in NinjaTrader, the phone or the bot). **Exits on the leader are always copied, whatever caused them**: a stop or target at
the broker, the phone, NinjaTrader, Flatten. While the copier is armed with a follower on, a leader entry with no stop
(no bracket stop, no strategy) is refused ("the copier needs a stop on every leader entry") (lead's default).

**Followers**, saved per account: `on`, `qty` (1 to 9, contracts per leader contract), `size` (`micro` or `mini`: the
leader's NQ or MNQ maps to MNQ or NQ, ES or MES to MES or ES). So a leader at 1 NQ with a follower at 3 `micro` gives that
follower 3 MNQ.

- **Executions mode** (`mode` `executions`): on each leader fill increment, every follower gets a **market** order for
  `qty` per leader contract filled; followers always enter (no price check). Slippage per follower (its fill minus the
  leader's, in ticks of the follower's root, signed so worse is positive) is logged and shown. The moment it fills, the
  follower gets its own protective stop at the broker at the **same price** as the leader's stop for that increment (the
  stop-already-traded rule applies: a market exit). When the leader's stop moves (a drag, breakeven, trailing, a merge),
  each follower stop mapped to it moves to the same price.
- **Orders mode** (`mode` `orders`): every leader entry order is placed for each follower as a real order (same kind and
  prices, its own quantity); moved and cancelled with the leader's; on its fill the follower gets its stop as above.
- **Never cross zero.** A follower exit is always "flatten this account" on that root (its own stop and targets cancelled
  first, then the rest closed at market), never an opposite order sized from the leader. A leader scale-out (a partial
  exit) reduces each follower by the same share, rounded to the nearest contract, at least 1, capped at what it holds; the
  leader flat means every follower flat. A flat follower gets nothing.
- **The sweep**: every second, any working order the copier placed on a follower with no position on that root is
  cancelled, unless it is an orders-mode entry whose leader entry is still working.
- **Skipped** (never partly): a follower at its position limit (gate 3 on its root) is skipped for that entry and
  highlighted (`skipped` "position limit"); also a follower not Connected, Gone, unchecked, or past its loss limit.
- **Follower daily loss limit** (an option, off by default): a flat dollar amount per follower (`lossLimit`), no buffer.
  When its `pnlToday` is at or below minus the limit, it is skipped for new entries until the next session (18:00 ET);
  its open position keeps its stop and the leader's exits are still copied to it (lead's default: nothing is flattened by
  the limit). No profit goal.
- **Mass disconnect** (lead's default: 3 or more followers, or the leader, leaving Connected within 10 s): the copier
  **stands down**: nothing new is copied until Anthony presses Re-arm (`copierRearm`). While stood down, exits on the
  leader are still copied to connected followers that hold a copier position, and their stops still follow (closing always
  works). After every ChartBridge start the copier starts stood down (lead's default: a restart is a reason to look).
- **Every copy decision is logged with its timing**: `copier.log` next to `config.txt` and the `copierEvent` message
  (`leaderMs` from the leader's event to the follower's order sent, `fillMs` to its fill).
- **Saved** in `copier.txt` next to `config.txt` (leader, mode, one line per follower), written by ChartBridge only.

| page to server | fields (no others) | notes |
|---|---|---|
| `copierGet` | `cid` (optional) | answer: `copier` |
| `copierSet` | `cid` (optional), `leader` (an account name), `mode` (`executions` or `orders`) | at least one of the two; refused while the leader has a position or working entry |
| `copierFollower` | `cid` (optional), `account`, `on` (*bool*), `qty` (1 to 9), `size` (`micro` or `mini`), `lossLimit` (whole dollars, 1 or more, or `null` for off) | all keys required; saved at once; the leader cannot be a follower |
| `copierRearm` | `cid` (optional) | refused while the leader is not Connected or 3 or more followers are not |

| server to page | fields | when |
|---|---|---|
| `copier` | `enabled` (the switch), `simOnly` (true), `armed` (*bool*), `standDownWhy` (null or plain words), `leader` (`{account, connection, position}` or null), `mode`, `followers`: `[{account, sim, on, qty, size, root, position, lastAction, lastAt, slippageTicks, skipped, lossLimit, pnlToday, connection}]` | after `auth` and `copierGet`, and on every change |
| `copierEvent` | `at` (UTC ms), `account`, `action` (`enter`, `stop`, `move`, `reduce`, `flatten`, `skip`, `sweep`, `standDown`, `rearm`, `refused`), `root`, `qty`, `price`, `slippageTicks`, `leaderMs`, `fillMs`, `text` | each copy decision |

### Bot channel (`bot = on`)

A local bot program on the trading PC (a rule program, never AI; the bot in this repository's tests is made up)
connects on its own WebSocket path **`ws://localhost:<port>/bot`** with its own permission level. **AI is never in the
order path**: every bot order is placed by ChartBridge from the bot's parameters, inside ChartBridge's rails.

**Its secret.** With `bot = on`, ChartBridge makes `bot-secret.txt` next to `config.txt` on first start (two `#` comment
lines, then 64 hex characters of random bytes); the bot reads it from that file. The upgrade to `/bot` needs: a loopback
address (as every request), **no** `Origin` header (any `Origin`, so any browser page, gets 403), and the header
`X-ChartBridge-Bot: <secret>` (constant-time compare; wrong or missing: 403). One bot connection at a time: a second gets 409.
The secret is never printed in the Output window, `/diag` or any log; deleting the file makes a new one at the next start.

**Modes** (set from the page, `botMode`; every ChartBridge start begins in `shadow`, auto never survives a restart, lead's
default):

- `shadow`: the bot's signals are shown and logged; no orders.
- `copilot`: a fired signal becomes a **proposal** to every signed-in v3 page, with its reason. Anthony accepts or rejects
  with one key (see Shared settings); the page sends `botSeen` the moment it shows it and `botAnswer` with
  the moment he answered; both times are recorded. On accept, **ChartBridge places the order from the proposal's
  parameters** (never from the page's, never anything else). An unanswered proposal is **never sent**: it expires when the
  bot withdraws it (`withdraw`: its entry is no longer valid) and is logged as "not answered". Accepted orders go to
  Sim101 only in 0.4.0 (lead's default).
- `auto`: ChartBridge places the bot's fired signals itself, **on Sim101 only** (exact name and `sim` true; anything else
  refused), locked there by ChartBridge whatever the bot sends.

**Rails** (enforced in ChartBridge, whatever the bot sends; reset at 18:00 ET): at most **1 contract**, on `botRoot` only
(default MNQ); at most **5 trades a day** (an entry that filled, even partly, is a trade); **stand down after 3 losing
trades** (a closed bot trade with realized P&L below 0; no new entries until the next session); no dollar limit on Sim; every
bot entry needs a stop (`stopTicks` 1 or more, lead's default); the **kill switch** on the page (`botKill`); all v2 gates
(trading, Sim101's gate 2, caps, grid, side of market, rate) on top. **Heartbeat**: any bot message counts; 5 s of silence
and ChartBridge cancels the bot's unfilled entries, keeps any bot position's stop and target, marks the bot lost and tells
the page (`bot` and a `status` `warn`). The kill switch does the same and refuses every bot order until it is released.
**ChartBridge never flattens the bot's position by itself**; Flatten on the page works as always.

Bot orders are named `CB#1a2b3c4d bot s8 t16` and their legs as v2, so the legs check, the missing-stop alarm and restart
recovery cover them.

| bot to server | fields (no others) | notes |
|---|---|---|
| `botHello` | `name` (1 to 40 characters) | first message; answer `welcome` |
| `beat` | none | at least every 2 s when nothing else is sent |
| `signal` | `id` (1 to 40 characters, unique today), `action` (`fired` or `skipped`), `side`, `kind` (`market`, `limit`, `stop`), `price` (limit or stop only), `stopTicks`, `targetTicks` (whole ticks, or `null` for none), `reason` (1 to 200 characters) | `skipped` carries only `id`, `action`, `reason` (and optionally `side`); by mode: logged, proposed, or placed |
| `withdraw` | `id`, `reason` | the entry is no longer valid: a proposal expires ("not answered"), an unfilled auto entry is cancelled |
| `flatten` | none | auto mode only: close the bot's position on Sim101 (cancel its legs, then market) |

| server to bot | fields | when |
|---|---|---|
| `welcome` | `version`, `mode`, `account` (`Sim101`), `root`, `rails` (`{maxQty, maxTrades, maxLosses}`), `instruments` (as `hello`) | answer to `botHello` |
| `tick` | as the page's `tick` | every live trade on every served root |
| `order`, `position`, `exec` | as the page's, for the bot's own orders and position only | on every change |
| `botState` | `mode`, `killed`, `standDown` (null or why), `trades`, `losses` | on every change |
| `answer` | `id`, `answer` (`accepted`, `rejected`, `not answered`, `refused`), `text` | the end of each proposal |
| `reject` | `id`, `reason` | a signal or action refused by a rail or a gate |

| page to server | fields (no others) | notes |
|---|---|---|
| `botMode` | `cid` (optional), `mode` (`shadow`, `copilot`, `auto`) | `auto` refused unless Sim101 is tradable |
| `botKill` | `cid` (optional), `on` (*bool*) | on: as the heartbeat loss, and no bot order until off |
| `botSeen` | `id`, `at` (page UTC ms, whole number) | the moment the proposal showed; not rate counted |
| `botAnswer` | `cid` (optional), `id`, `answer` (`accept` or `reject`), `at` (page UTC ms) | an expired or already answered proposal is refused |

| server to page | fields | when |
|---|---|---|
| `bot` | `enabled`, `connected`, `name`, `mode`, `account`, `root`, `position` (`{qty, avgPrice}`), `pnlToday`, `trades`, `maxTrades`, `losses`, `maxLosses`, `killed`, `standDown`, `lastBeatMs` (ms since the last bot message), `lastSignal` (the last `botSignal` or null) | after `auth`, on every change, and once a second while the bot is connected |
| `botSignal` | `id`, `at`, `action`, `side`, `kind`, `price`, `stopTicks`, `targetTicks`, `reason`, `result` (`shadow`, `proposed`, `placed`, `refused: <why>`, `skipped`) | each signal |
| `botProposal` | `id`, `at`, `account`, `root`, `side`, `kind`, `price`, `qty` (1), `stopTicks`, `targetTicks`, `reason`, `state` (`open`, `accepted`, `rejected`, `withdrawn`, `not answered`), `seenAt`, `answeredAt` | when proposed and at each change |

### Tape timing and new `/diag` counters

The tape counters and the hardening counters are built and documented in "0.4.0 hardening and markets" above (`/diag`
`tape`, `health.memory`, `health.threads`, `health.pages`, `health.errors`, `pages[].sendMs`, `markets`). They are always
on: they never touch the order path and cost no allocation per trade. With a v3 switch on, `/diag` adds its own block:
`merges` (`ok`, `restored`, `failed`, `refused`, `lastAtUtcMs`), `copier` (`decisions`, `skipped`, `standDowns`, median
`leaderMs`), `bot` (`signals`, `proposals`, `answered`, `notAnswered`, `placed`, `refused`, `heartbeatLost`).

**The page's receipt-to-frame readout** (page side, nothing on the wire): per chart, the time from a `tick` message's
arrival to the end of the frame that drew it, median and p95 over the last 60 s, shown beside the delay readout.

### Shared settings: Order Strategies and hotkeys

Order Strategies and the trading hotkeys are saved **once** and shared by every PC through The Desk, like the chart colour
presets (`GET`/`PUT /api/chart-presets`, a whole document with a `rev`, `409` on a stale `rev`). ChartBridge stores
neither: the page sends a strategy's parameters with each entry.

#### Desk endpoints used by the page

The Desk's side is lane D2's contract (`DESK_SETTINGS_CONTRACT.md`, draft v1, 2026-10-07; final text in TheDesk
`docs/API.md`). The page uses, with the same guard and CORS as `/api/chart-presets` (this PC and the Tailscale range
only, never through the tunnel; CORS for `http://localhost:8765` and `http://127.0.0.1:8765`, `GET` and `PUT`):

| endpoint | document | used for |
|---|---|---|
| `GET`, `PUT /api/chart-strategies` | `{rev, strategies: [{id, name, stop: {ticks, type, limitOffsetTicks}, targets: [{ticks, sharePct}], breakeven: {afterTicks, plusTicks} or null, trail: {startTicks, byTicks, stepTicks} or null, hotkey}]}` | the Order Strategies, at most 24 |
| `GET`, `PUT /api/chart-hotkeys` | `{rev, keys: {buy, sell, be, close, flattenAll, merge, maximize}, modifiers: {limit, stop}}` | the trading hotkeys (Merge's key is `merge`) |
| `GET /api/chart-accounts` | `{accounts: [{account, firm, archived, daily_loss_limit, trailing_drawdown, account_size, source}]}` | read only: a prop limit Anthony typed on The Desk, shown only where ChartBridge's `roomDrawdown` or `roomDailyLoss` is null |

**From The Desk's strategy to `order.strategy`** (the page converts; ChartBridge takes only the flat form):

| The Desk | `order.strategy` |
|---|---|
| `name` | `name` (`id` and `hotkey` stay on the page) |
| `stop.ticks` | `stop` |
| `stop.type` `"market"` / `"limit"` with `limitOffsetTicks` | `stopLimit` `null` / `limitOffsetTicks` |
| `targets[0..2].ticks`, `.sharePct` | `t1`..`t3`, `t1Share`..`t3Share` |
| `breakeven.afterTicks`, `.plusTicks` | `beAfter`, `bePlus` (both left out for `null`) |
| `trail.startTicks`, `.byTicks`, `.stepTicks` | `trailAfter`, `trailBy`, `trailStep` (all left out for `null`) |

Copilot's one-key accept and reject are not keys in D2's draft hotkeys document yet (an open item for the lead); until
they are, the page shows Accept and Reject buttons and `botAnswer` is the same either way.

The Desk checks its own rules on save; ChartBridge checks `order.strategy` again on every order (it never trusts the
store).

#### The page's side (chart 1.16.0, the order ticket lane)

Built in the workspace (`live/index.html`; the rules in `live/order-strategies.js`, the order path in `live/trade.js`).
Each choice below that the brief left open is marked **(lead's default)**.

- **v3 page.** The workspace's order connection sends `client` v3 right after a `hello` that names `"v3"`, before it signs
  in. The single chart page (`single.html`) stays a v2 page (lead's default). A control shows only while its switch is
  true: the Strategy picker on the ticket and Settings > Order Strategies (`strategies`), the Merge button and key
  (`merge`), the entry-type modifiers (`orderTypes`), Accept and Reject keys (`bot`). With every switch off the page is
  the 1.15 page: no new control, The Desk never asked, an order is the 1.15 order.
- **The Desk's address** is a box in Settings, kept per browser (`live-desk-url-v1`), `http://localhost:8800` until one is
  typed (ChartBridge's `deskUrl` default; ChartBridge does not tell the page its `deskUrl`) (lead's default).
- **When the hotkeys live in The Desk** (lead's default): while any of `strategies`, `orderTypes`, `merge` or `bot` is on
  (they need the shared keys). With all four off they stay this browser's, as in 1.15. On The Desk's first answer in a
  browser: when The Desk has none yet (rev 0) and the browser has keys, they are saved there; otherwise The Desk's keys are
  used and a note names the browser's keys they replaced. The Desk's keys are written to the browser's own keys
  (`live-hotkeys-v1`, `live-ws-keys-v1`), so the 1.15 handlers use them; the single chart page then shows them read only
  (`live-desk-sync-v1`). A key The Desk has that this browser keeps for itself (`hotkeyRefused`) is shown with why it does
  nothing here.
- **The hotkeys document** has nine keys: The Desk's seven plus `accept` and `reject` (the copilot's one-key answers, no
  default key) (lead's default; The Desk lane adds them). The page sends a cancelable `chart-copilot-key` DOM event
  (`detail.answer` `accept` or `reject`) for the bot channel's page part to answer; nothing handles it: a note says so.
- **The Desk not reachable:** the last copy read (`live-desk-cache-v1`) is used and shown read only, with a plain note; a
  key pressed, a modifier picked or a strategy saved is refused and says it was not saved (nothing is queued or guessed).
  A `409` reads the document again and says another PC saved first; a strategy's edit stays in its form to save again.
  Read again on Settings, on the Strategies screen, on window focus (15 s apart) and every 60 s.
- **A strategy's key picks it** as the ticket's active strategy (Anthony's brief: "chosen from a dropdown on the ticket and
  by its hotkey"); it never places an order (lead's default; the entry-type modifiers apply to the Buy and Sell keys and to
  clicks). The active strategy is kept per browser (`live-strategy-v1`), the same in each of its windows; one deleted on
  The Desk puts the ticket back on its bracket, with a note.
- **Sending a strategy:** Shift+click, Buy MKT, Sell MKT and their keys send the active strategy (`toWire`) in place of
  the bracket, checked first by ChartBridge's own rules (`checkWire`, `maxBracketTicks` included); never on an order that
  reduces the position (said in the note, as for a bracket). A strategy always has its stop, so NO STOP never asks for it.
  The Strategies screen also refuses a name with `"` or `\` (gate 8 would refuse the order).
- **Entry types** (lead's default): the Limit modifier held places a limit on the better side of the market and a
  stop-limit on the other; the Stop modifier a stop-market on the worse side and an MIT on the better (an MIT at the last
  price is refused: use the market button). With the Buy or Sell key, at the price under the mouse on a chart of the
  ticket's instrument (nothing is sent off a chart). On a click only a modifier beyond the click's own Shift or Ctrl counts
  (in practice Alt). Shift+click alone and a key alone are as before. A stop-limit entry is sent with `limitOffset` 0
  (its limit at its stop: it never fills worse than the stop price).
- **Merge** needs Armed, a position and two or more stops working (as B/E); its result (`merged`, `restored`, `failed`)
  and each managed strategy's state (`resumed`, `NOT MANAGED` with ChartBridge's text) are shown under the position on the
  ticket until the position is flat or a newer one comes. No motion on any of it.

### Order lane

The v3 server-to-page messages `accounts`, `managed`, `merge`, `copier`, `copierEvent`, `bot`, `botSignal` and `botProposal`
go in the order lane (see "Two send lanes"), so a proposal or a copier event never waits behind market data.
