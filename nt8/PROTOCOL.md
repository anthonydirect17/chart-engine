# ChartBridge protocol (v1 market data and fills, v2 orders, v3 accounts, strategies, copier and bot, 0.5.0 agents, 0.5.1 accounts, 0.5.8 prop groups, 0.6.0 group trading, 0.6.1 a group's Type and default hero, 0.6.3 the audit fixes, 0.6.4 the no-trade-record alarm and Merge on an off follower, 0.6.8 the minute book)

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
| `hello` | `version`, `now` (UTC ms), `instruments`: `[{root, name, tick, pointValue, settlement, settlementDate}]` (0.3.7: `settlement` the prior session's settlement for that contract, null when ChartBridge has no dated value for it; `settlementDate` the trading date it settles, `yyyy-MM-dd`), `accounts`: `[name]`, `trading` (0.3.0 and later: the `trading` object below, always with `enabled` false until the page signs in), `features` (0.3.5: `["liveFirst", "profile"]`, see Served window and session table; 0.3.7 adds `"settlement"`, `"htf"`, `"weekProfile"`), `pcClock` (0.5.6: this PC's clock against a time server, see Delay readout) | on connect |
| `history` | `root`, `name`, `barSeconds` (60), `sub` (0.3.3), `bars`: `[[t,o,h,l,c,v], ...]`, `done` (bool) | after `subscribe`, chunked. Since 0.3.3 the history is split: the chunks before the last minute (the last of them now says `done` false), then the last (forming) minute in its own message with `done` true, rebuilt from trades when it can be (see Backfill and live below) |
| `ticks` | `root`, `sub` (0.3.3), `ticks`: `[[t,p,v], ...]`, since 0.3.4 `[[t,p,v,s,sm], ...]` (side and method, see Trade side; the first three keep their places); 0.3.7 sends `[t,p,v]` again; since 0.3.8 a trade with a known Time and Sales category is `[t,p,v,null,null,q]` (see Time and Sales category), `done` (bool) | after `history`, the current session's trades, chunked |
| `ready` | `root`, `sub` (0.3.3), `filled` (0.6.8, minute and hour loads only: how many of the history's bars came from ChartBridge's minute book, 0 when none; see The minute book below), `minuteTimedOut`, `minuteFailed`, `standIn`, `tailTimedOut`, `historyFrom` (0.6.8, see The minute book) | history and tick backfill complete; live ticks follow (since 0.3.3 only those not already in the backfill; see Backfill and live below) |
| `profile` | `root`, `sub` (the load's; none when pushed after the session's backfill), `tick`, `bucketSeconds` (1800), `session` and `last`: `{from, whole, coveredFrom, rows: [[t, priceTicks, v], ...]}` or null (0.3.5, see Served window and session table) | right before `ready` when the subscribe asked for it; again, without `sub`, when the session's one backfill makes the table whole |
| `tick` | `root`, `t`, `u`, `rx` (UTC ms when the add-on received it), `p`, `v`, and since 0.3.4 `s`, `sm` (side and method, see Trade side), since 0.3.8 `q` (Time and Sales category, see there; absent when unknown) | every trade, live |
| `execs` | `list`: `[exec]` | on connect: executions NinjaTrader already has for today |
| `exec` | `account`, `name` (e.g. `MNQ 12-26`), `root`, `side` (`buy`/`sell`), `qty`, `p`, `t`, `u`, `id`, `order` | each new fill, live (see Fills below) |
| `pcClock` | the fields of hello's `pcClock` (0.5.6, see Delay readout): `checked`, then `offsetMs`, `rttMs`, `atUtcMs`, `server`, or `why`, `server` | to every page when a check of this PC's clock answers (every 5 minutes), when it changes to no answer, and when the PC clock steps by more than 250 ms; in the order lane. A page can get one before its `hello` (a page is told from the moment it connects); `hello` then carries the state as it is, and a check that ends while `hello` is built is sent again after it |
| `status` | `level` (`info`/`warn`/`error`), `text` | problems worth showing on the page; since 0.3.7 also a refused `htf` or `weekProfile` request (`warn`, "ChartBridge refused a htf message: why") |
| `historyLate` | `root`, `sub` (0.6.8) | once, when a load that went ready on stand-in history gets NinjaTrader's minute answer after all: the page subscribes again (see The minute book) |
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

## The minute book (0.6.8)

WORK, 2026-10-23 (page 1.38.0, ChartBridge 0.6.7): after a reload an NQ 1 min chart showed history to about 10:40, then nothing
until the live bar at 11:08 (a 5 min chart the same from about 10:25 to 11:05), and the League chart's MNQ 1 min sat on LOADING
for 50 s and more. NinjaTrader's 1-minute answer ended 28 to 40 minutes before now (likely only what it had on disk), the
20,000 last trades (`SeamTicksBack`) did not reach back to its last bar, so that bar went out as it was and the page filled
nothing between it and the first live trade. ChartBridge saw every one of those trades live and kept no minute bars.

**What ChartBridge keeps.** Per instrument (`RootBook.Minutes`, `MinuteBook`), 1-minute bars `[close, o, h, l, c, v]` built
from every live trade in OnMarketData, under the book's lock, before the trade goes to the pages. Stamped as NinjaTrader stamps
its minute bars and as `TailFromTicks` rebuilds them: at the bar's close, end-inclusive (a trade at exactly hh:mm:00.000 is in
the bar that ends then; the boundary rule's live check, above, covers this too). No side volume: the history bars carry none.
`from` (a minute close): every trade after it is in the book. It is set at the first trade after ChartBridge starts or after a
reset, to the close of that trade's minute or of NinjaTrader's clock's minute, whichever is later (NinjaTrader can replay an old
last trade when market data starts; the clock keeps it from claiming the time before). Trades at or before `from` are not kept.
Reset (empty, `from` unknown until the next trade) on a feed drop while the market is open (a connection's price feed leaving
Connected, or a market data reset: the same events as the volume profile's drop); a new contract only comes with a start, which
makes new books. At most
3,000 bars (about two sessions); past that the oldest 120 go at once and `from` moves up to the last of them. Per trade: a
division, a compare and a few stores, no allocation (the harness: a million trades in about 11 ms on Mono). Nothing about it
is written to disk.

**The seam.** A subscribe takes the book's lock, then the page's Pending lock (the order OnMarketData takes them in; MarkReady
and ServeFromCache take them in the same order, and nothing takes Pending and then a book's lock), clears the held trades and,
for a minute or hour load (`tickHours` 0), copies the minute book in the same moment. A trade is added to the book and held for
the page under the same book lock, so every trade before the copy is in it and every trade after it is held: none is in both,
none in neither. The book stands in only with a bar after `from` (the review of 0.6.8: in the book's first minute, right after a
start or a feed drop, `from` is the close of the minute still forming, and NinjaTrader's bar stamped there could hold trades that
are also held for the page; with a bar after `from`, every NinjaTrader bar kept closes before the copy's last trade). When
NinjaTrader's minute answer comes:

- the book reaches back to NinjaTrader's last bar (`from` at or before that bar's close): NinjaTrader's bars are kept up to
  `from`, the book's bars follow (the first is the first minute the book has whole), and no last-trades request is made (the
  book has the forming minute up to the copy). Then `ready` with `filled` (the book's bars sent) and every held trade, none
  dropped (none can be in the book). A closed minute after `from` that NinjaTrader has more volume for than the book (the book
  missed trades there: a drop no event told of) moves the cut past it: NinjaTrader's bars up to it, the book's after.
  NinjaTrader's last bar and the book's last are never compared (both may be partial). `/diag` counts them (`bookShortMinutes`).
- an empty answer, or an error: the book's bars alone (`ready`: `standIn` true, and `minuteFailed` true for an error). Not for
  an agent: after an error an agent gets exactly what 0.6.7 sent (no history bar, then `ready` with `minuteFailed` true).
- the book does not reach back (ChartBridge started, or the feed came back, after NinjaTrader's last bar), has not started, or
  has no bar after `from` yet:
  0.6.7's path (the last trades, the forming minute rebuilt when they reach back to it, with the fix below). ChartBridge does
  not fill half a hole: the minutes before `from` are not its to give.

**A hole is recorded, never shown** (Anthony 2026-10-23: "I dont need a notice"). When the last bar a load sends ends more than
2 minutes of open market before `ready` (the 17:00 to 18:00 break, a weekend and the CME holidays are not a hole:
`ChartBridgeCme.Closed`), ChartBridge writes it, in bar start times, New York time ("No bars from 10:41 to 11:08 ET:
NinjaTrader's minute history ends at 10:40"; the day is named, "Sun 18:00", when the hole crosses midnight), to the seam's `hole`
in `/diag`, `historyNotes` and `history.log`. Nothing about it goes to the page.

**Tick charts** (`tickHours` above 0, the served window; Anthony 2026-10-23, the same release). The book is copied for every
load. NinjaTrader's minute answer is joined to it the same way (up to `from`, then the book's bars), and the last of those
minutes is then rebuilt from the served window's trades as before (it reaches back to it: the window holds the last
`rangeHours`), so a minute answer that ends early leaves no hole when the book reaches back to it. The rebuild follows the same
rule as minute charts (below): the minutes after a short last minute are kept. The minute history's time limit and the
no-re-ask rule (below) apply to tick charts too; a tick chart whose minute history does not come in time starts from
NinjaTrader's kept answers and the book, its last minute rebuilt from its trades (before 0.6.8 it waited for NinjaTrader with no
limit). The served window's own request keeps its 120 s limit and its rules (Served window and session table).

**0.6.7's path, one fix.** When the last trades do not hold NinjaTrader's last minute in full (their rebuilt volume for it is
under NinjaTrader's), 0.6.7 kept NinjaTrader's bar and threw away every minute rebuilt after it too, so the chart had no bar
from that minute to the live one (tick charts the same, from the served window's trades). 0.6.8 keeps NinjaTrader's bar for that
minute and sends the minutes the same trades hold after it; on minute charts the held trades are matched against those trades
(`/diag` `tailKeptAfter`: the minutes kept).

**NinjaTrader's answers kept.** ChartBridge keeps each instrument's minute answers in memory, joined (the kept bars before the
new answer's first, the new answer, the kept bars after its last; at most 90,000 bars; never on disk), a late answer too (it is
not sent to the load it was asked for, which went on without it). A load that uses them takes only its own days (from its
minute request's start) and only the minutes that close before the minute of the copy's last trade. The kept answers' last bar
is never served when it was still forming when its answer came (NinjaTrader's clock then is kept with it), and a staler answer
merged in never leaves its forming bar inside the kept bars as if closed (the later answer's bar of that minute is kept).

**A fresh kept answer is the answer** (re-review B). When NinjaTrader's kept answers were added to within `OverdueReaskMs` (120 s),
reach back to a load's minute request start, and the load's book reaches back to them, they are that load's answer, joined to
the book as a fresh answer is, and NinjaTrader is not asked (`/diag` seam `fromKept`; a history note). So a reload right after a
load, or after `historyLate`, does not ask NinjaTrader again and does not wait on it. Not for an agent: it always asks.

**Time limits.** A load's minute history request and its last-trades request each wait at most 20 s (`MinuteTimeoutMs`,
`TailTimeoutMs`; each claimed once, the answer or the limit, by compare-and-swap; `ready` goes once per load). Nothing about a
time limit goes to the page (Anthony 2026-10-23: "I dont need a notice"): each is a history note (below), and `ready` says it.

- the minute history: given up only when there is history to stand in for it: NinjaTrader's kept answers, or the minute book
  with a bar (the review of 0.6.8). The load then starts from the kept answers joined to the book as a fresh answer would be (the
  kept bars alone when the book does not reach back to them; the book alone when nothing is kept); a tick chart the same, then
  its trades. When the book does not reach back to the kept answers (or has no bar yet), the kept bars from the load's start go
  out with their last minute rebuilt from the last trades and the held trades matched against them, as 0.6.7 does with an answer.
  With nothing to stand in (a cold start: no trade since ChartBridge started, nothing kept) the load is not given up: it waits
  for NinjaTrader as in 0.6.7 (the page says it waits), the instrument is marked overdue at the first limit, and the load looks
  again every `MinuteRecheckMs` (3 s) until the answer comes or something can stand in.
- when NinjaTrader's answer comes after its load went ready on stand-in history, and that load is still the page's, ChartBridge
  sends the page `{"type": "historyLate", "root", "sub"}` once; chart 1.38.1 subscribes again (the bars it shows stay until the
  new load is in), and the new load takes the answer just kept (above), asking nothing. At most once a page and instrument in
  `HistoryLateGapMs` (5 minutes): a later one is a history note only, so a NinjaTrader just over the limit cannot reload the
  charts again and again. An older page ignores the message.
- the last trades: the forming minute stays as NinjaTrader sent it.
- **an agent's subscribe** (the agent channel; agents place real orders) has no time limits and never gets stand-in history: it
  waits for NinjaTrader's full answer as in 0.6.7.

No retry storm: while a given-up request of an instrument is unanswered (for at most `OverdueReaskMs`, 120 s), its loads whose
days NinjaTrader's kept answers cover do not ask again (they go ready on them at once), and the last trades are not asked; any
other load asks (third review: a 30-day 1 hour chart after a 5-day 1 min load is not served the 5 days). Any answer to the
instrument's minute requests, late or in time, frees it (the mark goes); a late answer is kept, not sent (a history note). A given-up last-trades
request still counts in `minuteTailsOut` until it is answered (no session backfill starts meanwhile, as before). A time limit
or a late answer after ChartBridge stopped does nothing.

**`ready`, for a program reading it** (0.6.8, documented for the agents): `filled` (minute and hour loads), `minuteTimedOut`
(true: NinjaTrader's minute answer did not come in time), `minuteFailed` (true: NinjaTrader answered the minute request with an
error), `standIn` (true: the history is not NinjaTrader's answer to this load or a fresh kept one: the book, or older kept answers;
never for an agent), `tailTimedOut` (the last trades were given up: the last minute is NinjaTrader's as sent), `historyFrom` (the
first history bar's start, bar-time seconds, or null with no bar). NinjaTrader's full answer: all three of `minuteTimedOut`,
`minuteFailed` and `standIn` false.

**The page** (chart 1.38.1, no recompile needed, works with ChartBridge 0.6.2 and later): a load LOADING for more than 10 s, with
nothing from ChartBridge for 3 s, says "Waiting for NinjaTrader's NQ history (N s)" on its status line. It shows no hole notice
and no time-limit warning; on `historyLate` it subscribes again.

`/diag` (0.6.8): each `seams` entry adds `minuteLastBar` (NinjaTrader's last minute bar, its close stamp, New York time),
`bookFrom` (the copy's `from`, or null), `bookFilled` (the book's bars sent; -1 when the book was not used), `bookShortMinutes`,
`minuteTimedOut`, `tailTimedOut`, `hole` (the hole recorded, or null; never sent to the page), `tailKeptAfter`, `standIn` (went
ready on stand-in history), `agent`, `minuteFailed` and `fromKept` (the fresh kept answer was the answer); `books.<root>.minutes` is `{from, bars,
trades, lateTrades, resets, resetWhy, minuteOverdue, tailOverdue}`. `historyNotes` (the last 50) and `history.log` in
ChartBridge's folder (next to copier.log and bot.log; past 512 KB it moves to history.log.1, one old file kept): each history
note with UTC and New York time and the instrument: "Minute history failed", "last trades for the forming minute not loaded",
"tick window failed", a request given up or answered late, and a history that ends early ("history ends early: No bars from
..."), the record of a hole (NinjaTrader's Output window loses them).

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
more. A `quoteHours` line in `config.txt` does nothing; 0.5.5 says so as for any key it does not read ("config.txt:
quoteHours is not a ChartBridge setting; the line does nothing").
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

### This PC's clock against a time server (0.5.6)

A PC clock that runs ahead reads as late data: `rx` is stamped by this PC's clock (2026-10-12, the laptop showed "feed 2435
ms", and 122 ms after a Windows time sync). So ChartBridge 0.5.6 asks a time server what time it is every 5 minutes (the first
3 s after a start) and tells the pages how far this PC's clock is off. It only measures: it never sets the clock and never
changes a setting of Windows or NinjaTrader.

- **The check** (`ChartBridgeClock` in `ChartBridge.cs`): SNTP (RFC 4330), one 48-byte UDP question to port 123 of
  `config.txt`'s `timeServer` (default `time.windows.com`, the server Windows time sync uses; `timeServer = off`: no check)
  and its answer, on a background thread of its own (never NinjaTrader's or the thread pool's; the name lookup is synchronous
  on it, so a slow lookup only delays that check). The answer gets 2 s. A fault in a check is said in the Output window and
  never ends the thread; the next check comes at its time. The times are ChartBridge's clock (`ChartBridgeTime.NowUtcMs`, the one `rx` is stamped with): t0 the question
  sent, t1 the server's receipt, t2 its answer, t3 the answer received; offset = ((t1 - t0) + (t2 - t3)) / 2 (the server's
  time minus this PC's: negative when the PC runs ahead), round trip = (t3 - t0) - (t2 - t1). An answer that is not a
  server's (mode 4), that turns the question down (stratum 0, a kiss code), whose server says its own clock is not set (leap
  3), that does not echo the question's time, or whose times do not add up, is no answer.
- **`pcClock`**, in `hello` and as the `pcClock` message: `{"checked":true,"offsetMs":-2310.4,"rttMs":38.2,"atUtcMs":...,
  "server":"time.windows.com"}` or `{"checked":false,"why":"no answer from time.windows.com (no answer within 2 s: offline,
  or UDP port 123 blocked)","server":"time.windows.com"}` (`why` is also `not checked yet` before the first answer, and `the
  time check is off in config.txt (timeServer = off)` with `server` null). With no answer the last answer is kept for 30
  minutes, then the state is not checked; nothing else changes. When ChartBridge's clock follows a step of the PC clock
  (`ChartBridgeTime`, more than 50 ms), the offset held moves with it at once; a step over 250 ms is checked again at once.
- **The page** (chart 1.24.0): with `checked` true the feed delay shows split, `feed 2435 ms = clock +2310 ms, real 125 ms`
  (the clock's part is `-offsetMs`, the PC ahead positive; the real delay `rx - u + offsetMs`; each part rounded first so they
  add up), "PC clock off by 2.3 s" from 0.5 s off, and the feed's amber (from 1 s) and red (from 3 s) only for the real delay.
  With `checked` false the feed shows as before and its tooltip says why the clock was not checked; with no `pcClock` (a
  ChartBridge before 0.5.6) exactly as before.
- **Output window**: a line when the first check answers or not, when that changes, and when the clock goes 500 ms off or
  back; never one per check.
- **`/diag` `pcClock`**: the same fields plus `checks`, `fails`, `lastError`, `lastTryUtcMs`, `everyMs`, `timeoutMs`,
  `warnMs`. (`clockOffsetMs` is another thing: ChartBridge's own clock against this PC's.)

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
than 50 ms); `pcClock` (0.5.6: this PC's clock against a time server, see Delay readout); `fillEventsDelivered` and `fillsFoundByPolling` (how many fills came each way this
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
(`deskUrl`, default `http://localhost:8800`) in The Desk's fill shape, with `source` `nt8`. (0.5.0: plus `by`, exactly `agent:<id>`, `bot` or
`copier`, when ChartBridge knows who placed the fill's order; no `by` key otherwise. See "Agent channel".) Fills
wait in `pending_fills.jsonl` next to `config.txt` until The Desk accepts them, so a restart or The
Desk being closed loses nothing; The Desk ignores duplicates. A request gives up after 10 seconds; a fill
The Desk refuses as malformed is set aside in `rejected_fills.jsonl` so it never blocks the queue. Fills from every watched account are
sent: The Desk's Accounts menu decides which accounts count. ChartBridge sends no commission (NinjaTrader's
figure is its own commission template, not what was charged).
0.6.9: a fill of a group entry's order (its entry or a leg) adds `decision_id` ("d" and 12 hex characters) after `order_id` and
`by`; every other fill is byte for byte as before. See "The decision id of a group entry (0.6.9)".

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

### 1 second bars to The Desk (0.6.9, contract v2)

Anthony 2026-10-24 (Phase 2 of his stats suite, approved): the tick-level detail of the market around his trades, as 1 second
bars with buy and sell volume, so The Desk's Exits, slippage and order flow are exact. With `bars = on` they go with the 1-minute
bars; `bars1s = off` in `config.txt` turns only them off; `bars1sRoots` (default `NQ, MNQ`) names their roots, and only a root that
is also in `barsRoots` is sent (`nt8/ChartBridgeBars.cs`).

- **Which sessions and contracts:** the 1-minute bars' own rule: each full CME session (18:00 to 17:00 New York, its date the
  day it ends on), the front month the chart uses plus any other contract of that root with fills in that session, the last 5
  sessions not taken yet at the start (the catch-up) and each session from 17:05 New York. Never a session that has not closed.
- **The request:** `BarsRequest(instrument, from, to)`, 1 tick, `MarketDataType.Last`, the instrument's trading hours,
  `MergePolicy.DoNotMerge`, from the session's open itself (18:00 New York, in NinjaTrader's time zone; Sunday 11-01 build: until
  then it asked from 12:00 AM of the open's date, and NinjaTrader answered with the whole session before as well) to the session's
  close (never past now). Through the 0.3.5 gate as a bars job (`1s <session>
  <contract>` in `/diag` `books.gate`), so the same rules hold: queued only when the gate is idle (no window, backfill, last trades
  or page load out or to come), never beside a chart load, and a request NinjaTrader does not answer frees the gate at its limit
  (180 s here; its late answer is dropped). **Only from 16:15 to 18:00 New York on a weekday, and on the weekend while the market is
  shut** (all Saturday, and Sunday before the 18:00 open): never premarket, in regular hours or in the evening session, so a Range or
  tick chart load is never held behind a session's trades while Anthony may be watching (the coordinator's ruling, 2026-10-24). The
  start's catch-up waits for the next window too (stricter than the 1-minute bars, whose start catch-up may run at any time). The
  edges: 16:14 no, 16:15 yes, 17:59 yes, 18:00 no; Sunday 17:59 yes, Sunday 18:00 no. **A new request starts only by 17:50**
  (the window's end less 10 minutes; Saturday all day), so one that runs long is not out when the evening session opens; the clock is
  read again after the pass's 1-minute requests and right before each 1 second request (review of #71). Sends may go on to 18:00.
  At most one 1 second request a pass (once a minute), after the pass's 1-minute requests. A failure is tried again after 15 minutes, 3 times, then not until the next
  start.
- **The rows, on NinjaTrader's thread in one pass** (no copy of the trades is kept): each trade of the session (UTC `[open,
  close)`; the hours before the open in the answer are left out) goes into the row of its UTC second. One row per second that had a
  trade; a second with no trade has no row (gaps stay gaps). NinjaTrader's time is turned into UTC with its time zone setting
  (once an hour of its clock).
- **The side of each trade** (the live rule, `ChartBridgeSides.Classify`): the bid and ask NinjaTrader stored with that trade on the
  1 tick series (`Bars.GetBid(i)`, `Bars.GetAsk(i)`) when they make a usable quote (both above zero, bid below ask): at or above
  the ask a buy, at or below the bid a sell (`bidAsk`); else the tick rule (`tickRule`: above the last trade a buy, below a sell,
  the same price the last side); the session's first trade with no usable quote has no side (`none`). The tick rule starts over at
  the session's open. If NinjaTrader keeps no bid and ask with its historical trades (they read 0, or equal), every side is by the
  tick rule and the message says so.
- **Row:** `[t, o, h, l, c, v, bv, sv]`: `t` the second's open (Unix ms UTC, a multiple of 1000), prices as NinjaTrader has them,
  `v` the volume of every trade in that second, `bv` of the trades called buys, `sv` of the trades called sells. `v - bv - sv` is
  the volume with no side.
- **Message (contract v2, tf `1s`)**, one session of one contract split into parts of at most 1,500 rows (the 1-minute message's
  own row limit; about 90 KB, at most about 100 KB), about 55 parts for a busy NQ session:

  ```json
  {"v":2,"source":"chartbridge","bridge":"0.6.9","pc":"HOME","contract":"MNQ 12-26","root":"MNQ","tick":0.25,
   "session":"2026-09-30","tf":"1s","stamp":"open","cols":["t","o","h","l","c","v","bv","sv"],
   "sides":{"method":"mixed","bidAsk":412000,"tickRule":88000,"none":1},
   "set":"a1b2c3d4e5f6","part":1,"parts":54,"setRows":80123,"setTrades":500001,"setVolume":1234567,
   "first":1790719200000,"last":1790801999000,
   "bars":[[1790719200000,25000,25000.25,24999.75,25000.25,6,5,1]],"complete":true}
  ```

  `sides.method`: `bidAsk` (every side from the stored quote), `tickRule` (none), `mixed`, or `none` (no side at all); the three
  counts are trades. `set`: 12 hex characters, one id for the parts made together from one answer. `part` (1 to `parts`), `parts`,
  and the set's totals (`setRows`, `setTrades`, `setVolume`, `first` and `last` second) are the same in every part of a set.
  `complete` is always true (a set is always a whole session). Market data and the PC name only.
- **Queue:** a set is written whole, before anything is sent, to `bars1s/<session>_<contract>.jsonl` next to `config.txt` (a temp
  file swapped in), one part a line; `bars1s/<same>.sent` gets one line per part The Desk took, so the big file is never written
  again. Parts go to `deskUrl` + `/api/bars-1s`, one a request, in order, oldest session first, 10 seconds each, only in the same
  window (16:15 to 18:00 New York on weekdays, the weekend while shut). A set done is noted in `sent_bars1s.txt` (`yyyy-MM-dd contract`, 40 days) and its files deleted. `400`, `413` or
  `422` sets the part aside in `rejected_bars1s.jsonl`, drops the whole set and notes the session in `refused_bars1s.txt` (40 days:
  not asked for again). `404` (a Desk without `POST /api/bars-1s`, today's) keeps every set on disk and offers it again every 30
  minutes (said once in the Output window). Anything else is tried again after a minute. After a restart a set goes on from the
  first part not taken. A waiting set for a session older than 10 days is dropped when the queue is read (the catch-up never asks
  that far back), so `bars1s/` stays small (about 4 to 5 MB a set).
- **Why its own path:** today's Desk refuses anything but `v` 1 and `tf` `1m` on `POST /api/bars` with `400`, which would set every
  set aside for good; a new path answers `404` until The Desk has the store, and nothing is lost meanwhile. The message is the
  1-minute message's shape with `v` 2, `tf` `1s`, `cols`, the two volume columns and the part fields.
- **`/diag` `bars.oneSecond`:** `on`, `state`, `roots`, `lastSent` (per contract), `waitingSets`, `waitingParts`, `setAside`,
  `deskHasNo1s`, `gaveUp`, `lastBuild` (trades, seconds, messages, the trades of the answer outside the session that were left out,
  the request's from and to in NinjaTrader's time, the sides' method and counts, the time on NinjaTrader's thread) and `error`.
  Trades in NinjaTrader's answer outside the session are left out by time and counted in `lastBuild` ("N trades outside the
  session left out"). Since the request starts at the open (Sunday 11-01 build) that count should be small; a large one shows
  NinjaTrader still gave the day before (harmless: nothing is counted twice). `lastSent` lists each contract The Desk took a whole
  set of, MNQ as well as NQ.
- **The 1-minute bars are unchanged:** the same requests, messages and queue as 0.3.7 to 0.6.8, byte for byte (harness: the same
  session with the 1 second bars off and on gives the same 1-minute message).

### The NQ tick file to The Desk (Sunday 11-01 build)

Anthony's decisions of 2026-10-29: one NQ tick file per session is the only market data kept, and everything is built from it (1
second bars, 1 minute bars, the evening profile tape, the master day); MNQ trades take their bars from NQ's ticks (no MNQ tick
file). This release adds; it retires nothing (the 1-minute request, the evening profile export and the 1 second pull stay).
`nt8/ChartBridgeTicks.cs`. On with `bars = on`; `tickFile = off` in `config.txt` turns only it off; `tickFileMaxMB` (default 2048,
at least 16) bounds the `ticks/` folder next to `config.txt`.

- **Live capture.** Every NQ trade ChartBridge receives (`OnMarketData`, after the pages, the tape counters and the forming bars
  took it, in its own `try`) goes on a bounded queue (200,000 trades): one counter and one enqueue, no lock the order lane or the
  chart feed holds, no file, no clock. A full queue **drops the trade and counts it** (`droppedQueue`); it never waits. A thread of
  its own (`ChartBridge tick file`, below normal priority) writes the queue every 250 ms to `ticks/<session>_<contract>.raw`, one
  line a trade, `u,p,v,s,m`: `u` NinjaTrader's time of the trade in UTC ms, `p` price, `v` volume, `s` side (1 buy, -1 sell, 0 none,
  the live side rule), `m` the side's method (0 none, 2 bidAsk, 3 tickRule). The session is the CME session the trade's New York
  time is in (18:00 to 17:00, dated the day it ends); a trade in the 17:00 to 18:00 break is left out and counted (`outside`). Over
  `tickFileMaxMB` a batch is dropped and counted (`droppedDisk`). `<same>.state` starts `run <12 hex>`, `tick <size>`, `contract`,
  `session`. No request goes to NinjaTrader for the capture, at any hour.
- **Chunks** (point 3: The Desk builds 1 second bars from them as they land). A second thread (`ChartBridge tick chunks`, below
  normal) cuts each raw file every 3 minutes, from the last cut to the last whole line, into chunks of at most 20,000 trades, and
  notes each cut (`cut <seq> <from byte> <to byte> <trades> <lost> <gaps> <bidAsk> <tickRule> <none> .`) in `<same>.state`, so a
  chunk sent again is read from the same bytes and is the same message. It posts the chunks not taken yet, oldest first, to
  `deskUrl` + `/api/ticks/chunk` (10 s each, never through a proxy), and notes `sent <seq>`. `400`, `413` or `422`: `aside <seq>`
  (its trades stay in the raw file; the final pull covers them). `404` (a Desk without the route): every chunk waits, offered again
  every 30 minutes. Anything else: tried again in 10 seconds. A restart carries on (same run, the next seq). There is never more
  than one cutter or writer: a cut is made only by the sender of the current start and under one lock that the start takes before
  it reads the files again, so a sender of an earlier start still running can never write the same `cut <seq>` with other bytes.

  ```json
  {"v":1,"source":"chartbridge","bridge":"0.6.9","pc":"WORK","root":"NQ","contract":"NQ 12-26","tick":0.25,
   "session":"2026-10-30","run":"a1b2c3d4e5f6","seq":12,"count":1834,"volume":2301,
   "first":1793397600123,"last":1793397779950,"lost":0,"gaps":0,
   "sides":{"bidAsk":1700,"tickRule":130,"none":4},"cols":["u","p","v","s"],"ticks":[[1793397600123,25000.25,1,1]]}
  ```

  `lost`: trades dropped (queue or disk) since the chunk before; `gaps`: feed drops while the market was open since the chunk
  before. Both go to the session they fall in (the dropped trade's time, the feed drop's time) and to **every** file of that
  session (the roll week has two contracts), each at its own next cut: a cut with nothing to cut (the feed still down) takes
  nothing up, so the drop goes on the first chunk after the feed is back. The first chunk of a file after ChartBridge starts says
  `gaps` 1 or more (its counters start at zero, but a restart may have missed trades), unless this run made the file and started
  before its session opened. The Desk does not vouch from the last trade before a chunk with `lost` or `gaps` to the first trade
  after it. The Desk keys a chunk by contract, session, `pc`, `run` and `seq` and ignores one sent again.
- **The final file** (point 4). On the bars worker, after the pass's 1-minute and 1 second bars and only when the 1 second bars
  asked nothing that pass, only in the 1 second bars' window (a request starts 16:15 to 17:50 New York on weekdays, on Saturday, and
  Sunday before 17:50; never in trading hours), for each session with a raw file that has closed and is not done: one
  `BarsRequest` through the 0.3.5 gate (1 tick, Last, the instrument's trading hours, `DoNotMerge`, 180 s), from the session's
  open to its close (NinjaTrader's time). The answer is read once on NinjaTrader's thread (sides by the bid and ask stored with each
  trade, else the tick rule). **The check**, second by second (UTC): `exact` every second has the same trades and volume live and
  in history; `filled` history has more in some seconds (the live capture missed them: a disconnect, a late start), never fewer;
  `failed` live has a trade or volume in a second history lacks, or history has none. The history is the master when the check
  passes. The day is written whole to `ticks/<same>.day.jsonl` (parts of at most 20,000 trades) and sent to `deskUrl` +
  `/api/ticks/day` in the same window as the 1 second bars' sends; progress in `<same>.day.sent`; `400`, `413` or `422` sets the day
  aside (`.day.jsonl.refused`). A failed day is sent too, marked `failed`, so The Desk shows it. Done days: `ticks/tickdays.txt`
  (`<session contract>`, check, stored, packed): never pulled again. A failure is tried again after 15 minutes, 3 times, then not
  until the next start.

  ```json
  {"v":1,"source":"chartbridge","bridge":"0.6.9","pc":"WORK","root":"NQ","contract":"NQ 12-26","tick":0.25,
   "session":"2026-10-30","set":"0a1b2c3d4e5f","part":1,"parts":48,"setTicks":951234,"setVolume":1203456,
   "first":1793397600001,"last":1793480399990,
   "check":{"status":"filled","liveTicks":950001,"liveVolume":1202001,"histTicks":951234,"histVolume":1203456,
            "secondsLiveMissed":3,"ticksLiveMissed":1233,"secondsHistShort":0,"ticksHistShort":0,"liveLost":0,"liveGaps":1,
            "detail":[{"t":1793420000000,"live":0,"hist":12}]},
   "sides":{"method":"mixed","bidAsk":800000,"tickRule":151234,"none":0},
   "cols":["u","p","v","s"],"ticks":[[1793397600001,25000.25,1,1]],"complete":true}
  ```
- **Deletion.** The raw file and its state are deleted only when the check passed and The Desk's answer to the day's last part says
  `"stored":true` and `"packed":true`. The packed format is Anthony's open question, so The Desk answers `"packed":false` and the
  raw is kept; a failed day keeps its raw until Anthony rules. `/diag` `tickFile.rawOld` lists raw files older than 7 days.
- **Which PC sends** (Anthony 2026-10-28: automatic, WORK wins): every PC with the tick file on captures and sends what it receives
  under its `pc` name (`config.txt` `pc`, else the Windows computer name). The Desk keeps WORK's and flags the other; it knows WORK
  only by the name `WORK`.
- **`/diag` `tickFile`:** `on`, `capturing`, `queue`, `queueMax`, `droppedQueue`, `droppedDisk`, `outside`, `written`,
  `feedDrops`, `diskMB`, `maxMB`, `files` (per session and contract: `bytes`, `chunks`, `sent`, `aside`, `ageDays`), `lastSent`
  (per contract: the session and seq of the latest chunk taken), `days` (per session and contract: `check`, `stored`, `packed`),
  `rawOld`, `rawOldNote`, `dayState`, `lastDay`, `deskHasNoTicks`, `lastError`.

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
   default **1** for any root without a line (ChartBridge 0.5.3: an agent's entry on MNQ takes the agents' own 20 instead, whatever the line says; below). No single order may exceed the cap, and the cap limits what
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
9. **The firm's limits (0.6.6).** On the part of an entry that opens or adds (never an exit, a close or a flatten): the page's
   entries only past the account's firm max contracts; the bot's, an agent's and a copier follower's only on a known breach.
   See "The firm's limits on entries (0.6.6)" below.

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
| `orders` | `list`: `[order]`, `positions` (0.5.7: how many `position` messages follow this list) | after `auth`, every working order on the allowed accounts |
| `order` | `id` (ChartBridge's id, stable while the order lives), `cid` (when placed from this page), `account`, `root`, `name`, `side`, `kind` (`market`, `limit`, `stop`, `stopLimit`, `other`), `qty`, `filled`, `price` (limit or stop price, or null), `avgFill` (or null), `state` (`working`, `partFilled`, `filled`, `cancelled`, `cancelling`, `rejected`), `role` (`entry`, `stop`, `target`, or `other` for orders placed elsewhere), `oco` (or null), `text` (NinjaTrader's error when rejected or failed), `planned` (0.3.8: on a working limit or stop entry ChartBridge placed, `{"stopTicks": n or null, "targetTicks": n or null}`) | every order change, live; and again after a `plan` |
| `position` | `account`, `root`, `qty` (signed: long positive, short negative), `avgPrice` (or null when flat) | after `auth` and on every change |
| `reject` | `cid` or `id` (whichever the message had), `reason` | a refusal by ChartBridge's gates |
| `status` | `level` `error` (a bracket leg rejected or a bracket error: check the stop now) or `warn` (the legs check cancelled or shrank legs), `text` | bracket problems, to signed-in pages |
| `riskAlert` | `kind` (`dailyLoss`, `held` or `skipped`), `account`, `text` (0.6.6) | to signed-in pages, in the order lane: an account reached its daily loss, or the bot's, an agent's or a copier follower's entry was held back by the firm's limits (see "The firm's limits on entries (0.6.6)") |

Orders placed in NinjaTrader itself (or anywhere else) on an allowed account also show on the chart,
with `role` `other`, and can be moved or cancelled from the chart.

**Who placed it (0.4.0, review 2).** On a v3 page (protocol v3, after `client`), `order` and each item of `orders` also
carry `by` when the bot or the copier placed the order: `"by": "bot"` for a bot entry (named `CB#<tag> bot ...`) or a leg
of one the bot channel follows, `"by": "copier"` for any order the copier placed on a follower (its entry, stop, exit or
reduce). An order that already says `by` (a strategy's) keeps it; the page's own orders and orders placed in NinjaTrader
carry none. A v2 page never gets `by` for these: its `order` message stays byte for byte 0.3.8's. 0.5.0: `"by": "agent:<id>"`
for an agent's entry (named `CB#<tag> ag:<id> s8 t16`), its legs and its flat close. 0.5.7: those also carry `"planId"`, the
`id` of the plan the entry was placed for, when ChartBridge knows it (see the agent channel's Placing).

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
order feature, the copier and the bot channel are **on as soon as ChartBridge 0.4.0 is installed** (Anthony 2026-10-07: no
switches, no Sim locks; see the next section); `trading = true` stays the master switch above all of them, its default and
its reading unchanged; nothing in ChartBridge ever turns `trading` or a switch on or off by itself. Where Anthony's brief
left a detail open, the safest simple choice is written and marked **(lead's default)**.

### Anthony 2026-10-07: no switches, no Sim locks

Anthony's decision on the morning of 2026-10-07, which overrides every "switched off" and "Sim only" line of the first 0.4.0
build below: "I do not want another arbitrary block, we have to go in and change before being able to use on live accounts.
I am capable of only testing on sim until we clear our tests. I dont need a guardrail like that." On the bot's auto mode: "as
long as it's clear that we have a sim account chosen, I do not need the lock or guardrail."

- **No switches.** `accountChecks`, `orderTypes`, `strategies`, `merge`, `cancelFromList`, `copier` and `bot` are on with no
  line in `config.txt`. Each key stays only as an optional off line (`merge = off`), so nothing ever needs turning on.
  `trading.switches` reports the real values. `trading = true` is unchanged: off unless `config.txt` says so, as before.
- **The copier has no Sim lock.** A real account may be a follower. Every other copier rule stays (never cross zero, the
  follower's stop at the leader's stop price, the mass disconnect and Re-arm, the sweep, the skips), and every account gate
  applies to each follower (trading on, its checkmark or `tradeAccounts`, Connected, not Gone, the caps). The `copier`
  message's `simOnly` is `false`; each follower still carries `sim`, and the page marks it SIM or LIVE.
- **The bot trades the account Anthony chooses**, Sim or live (`botAccount`, below; None until he chooses one, 0.5.7: see "None and the daily reset"). Auto mode
  and accepted copilot proposals go to that account through every gate (its checkmark or `tradeAccounts`, Connected, the caps).
  `bot`, `welcome` and `botProposal` say `account` and `sim`, and the page shows SIM or LIVE plainly next to the mode, in the
  strip, the pop-out and on every proposal. The rails are unchanged (1 contract, micro or mini, 5 trades, 3 losing trades, the
  kill switch, the heartbeat never flattens). One account is never both the bot's account and a copier follower (both
  directions refused, in plain words).
- **With every off line written** ChartBridge 0.4.0 is 0.3.8 exactly, as before (the Mono harness's base checks run that way).

Examples of every new message, both directions, are in `test/fixtures/protocol-v3.json`; the fake bridge
(`test/fake-bridge.mjs --v3`) answers them with simulated state.

### v3 switches (`config.txt`, all ON by default: Anthony 2026-10-07)

| key | `key = off` | on (the default) |
|---|---|---|
| `accountChecks` | gate 2 is `tradeAccounts`, as in v2 | gate 2 is the page's per-account checkmark (see Accounts) |
| `orderTypes` | `kind` is `market`, `limit`, `stop` | also `stopLimit` and `mit` |
| `strategies` | an `order` with `strategy` is refused | Order Strategies (stop, up to 3 targets, breakeven, trailing) |
| `merge` | `merge` is refused | Merge stops and targets |
| `cancelFromList` | a `cancel` with `from: "list"` is refused | cancel from the page's Working orders tab |
| `copier` | every `copier*` message is refused; nothing is copied | the copier engine (Sim or real followers, every account gate) |
| `bot` | `/bot` answers 404; every `bot*` page message is refused | the bot channel, on the account chosen with `botAccount` |
| `botRoot` | | the one root the bot trades (a micro or a mini of a served root); default `MNQ` |

No line means on. `off`, `false` and `0` (any case) turn a switch off; `on`, `true` and `1` leave it on; any other value is
read as off, with one Output line naming the key and the value (only an off line has a reason to be there; lead's default).
The switches are read at start like every key (recompile or restart NinjaTrader after a change). The default is set in one
place, `ChartBridgeSwitches.Reset` in `ChartBridgeConfig.Load`; no lane's `ResetConfig` touches a switch.

### Telling the page what is on

- `hello.features` adds `"v3"` (this ChartBridge speaks v3). Quote-only markets are told per instrument (`quoteOnly`). Features are
  not secret: every page that may read gets them.
- **`client`** (page to server, new, the first v3 message): `{"type":"client","v":3}`, sent once right after `hello`. A
  connection that never sends it is a v2 page and gets **no** v3 message at all (the 1.15 page keeps working on 0.4.0
  unchanged; The Desk's relay sends nothing). `v` is a whole number; anything but 3 is refused with a `status` `warn`.
- `trading` (answer to `auth`) adds `switches`: `{"accountChecks":true,"orderTypes":true,"strategies":true,"merge":true,
  "cancelFromList":true,"copier":true,"bot":true}` with no off line, each the real value, sent to a v3 page only. The page
  shows a feature's controls only when its switch is true; ChartBridge refuses its messages either way when it is false.

### Strict messages in v3 (gate 8, extended)

Every v3 page message (and every bot message) follows gate 8 as written, with these additions and nothing looser:

- **Keys:** only those in the tables below; another key, a key twice or a misspelt key is refused, never ignored.
- **Values:** a string is plain (printable, no backslash escape, at most 200 characters); a whole number follows gate 8's
  rule (no quotes, no decimals, no exponent, no leading zero, at most 9 digits); a price is a plain decimal; `true` and
  `false` only for keys marked *bool*; `null` only where a table says so.
- **Nesting:** no list anywhere from the page. The only nested objects are v2's `bracket` and v3's `strategy`, both on
  `order` only, both flat inside (no object or list in them). `bracket` and `strategy` on one order is refused.
- **Rate:** every v3 action (`accountTrade`, `accountArchive`, `accountUnarchive` (0.5.1), `merge`, `copier*`, `bot*` except `botSeen`) counts in gate 7's
  10 actions a second per connection.
- **Sign-in:** every v3 action needs the signed-in own page (gates 1 and 4), except `client`. A refusal is a `reject`
  (`cid` or `id`, `reason`), never sent to NinjaTrader.

### Accounts

**Which accounts (0.5.1).** The accounts follow NinjaTrader's connected accounts, with nothing to configure. An account is
watched (its fills go to The Desk) and listed once NinjaTrader has shown it Connected in this NinjaTrader session (since
NinjaTrader's process started, so a recompile keeps it); a new one appears by itself within seconds (the 1 s check, the
10 s watch) with its checkmark **off**. Accounts NinjaTrader only remembers (no connection, or not connected this session)
are never watched, listed or written to `accounts.txt`. One seen connected that then drops stays listed Gone (below) for the
rest of the session; after NinjaTrader restarts it is listed again only when it connects. Never Backtest or Playback. Until
0.5.0 an `accounts` watch list in `config.txt` chose the accounts; since 0.5.1 it is read once and then ignored (below).

**The checkmark (with `accountChecks` on, the default).** Trading is switched on per account by a checkmark on the page's Accounts tab.
ChartBridge saves the checkmarks itself in `accounts.txt` next to `config.txt` (Anthony never edits a file): a first line
`# ChartBridge accounts (written by ChartBridge; do not edit)`, then one line per account,
`<state>\t<changed UTC ms>\t<account name>` with `<state>` `trade`, `off` or `archived`; written whole to a temp file and
swapped in, off NinjaTrader's thread, read once at start before the accounts are watched. Exactly three fields: 0.5.0's
(and 0.4.x's) reader refuses the whole file for any other line, a 4th field or a comment included, so 0.5.1 adds nothing to
it. **`accounts-detail.txt`** (0.5.1, next to it, same writing rules): a first line
`# ChartBridge account details (written by ChartBridge; do not edit)`, then `connected\t<UTC ms>\t<account name>\t<session>`
(the last time ChartBridge saw it Connected, and which NinjaTrader session saw it: the process id and start ticks, as
`<id>-<ticks>`; the 4th field is left out when they cannot be read; saved at most once an hour per account, and at once the
first time a session sees it). A line it does not understand is skipped (such as `converted\t<UTC ms>`, which 0.5.1 and
0.5.2 wrote for the `accounts` line's conversion, below; 0.5.5 drops it at the next save). Read with three tries, as `accounts.txt`; a file that still cannot be read is **never rewritten that
run** (one Output line) and only means an account counts as seen this session once it connects again. ChartBridge's stop
saves both files and flushes `accounts.log` (on the thread that stops it, NinjaTrader's at an F5): it waits at most 200 ms for
a save already under way and otherwise skips its own with an Output line (the next start reads both files again; at most the
last second's connected times and log lines are lost). **Pruning** (0.5.1): a plain `off` record not seen Connected for 30 days (by
`accounts-detail.txt`, else its changed time) is forgotten at the hourly check, logged `forgotten`; a `trade` or `archived`
record never is. **First start** (no
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
(`connection` below), or NinjaTrader reports it disabled. At that moment the pages get `accounts` and a `status` `warn`
("EVAL-A is gone (disconnected for 10 s): entries wait until it is back; its checkmark is kept"), and the change is logged.
Entries to it are refused while it is Gone (and it leaves `trading`'s account list); bracket upkeep and the missing-stop
alarm keep running for it. **ChartBridge never clears a checkmark** (0.4.2, Anthony 2026-10-07: "I will manage the
checkmarks on accounts ... I know when they blow, or pass to funded"): Gone keeps it, saved as it was. When the account comes
back healthy it is listed as active again, trades at once with its checkmark, is back in `trading`, and the pages get a
`status` `info` ("EVAL-A is back (connected): its checkmark is kept, entries are taken again"). NinjaTrader's trailing
drawdown (`roomDrawdown`) **never** makes an account Gone (0.4.2: NinjaTrader's figure drifts once a prop account passes
its drawdown lock); it is shown, never acted on. Until 0.4.1 Gone cleared the checkmark and `roomDrawdown` at 0 or below
made an account Gone.

**Hide (archive) and Show (0.5.1).** Only Anthony, on the page, after confirming (`accountArchive` with `confirm: true`).
Accepted for any account, Gone or not, that is flat with no working orders (as NinjaTrader shows it now, or as ChartBridge
last saw it this session when NinjaTrader does not list it) and is not the bot's account (`botAccount`; none when the bot is
on None, 0.5.7), a copier leader or follower (`copier.txt`, the copier on or off), or an agent's chosen account
(`agent-<id>-account.txt`); otherwise refused with the plain reason ("EVAL-A has a position or working orders: only a flat
account can be hidden (exits always work)", "Sim101 is the bot's account (the Bot tab): it cannot be hidden"). A file that
cannot be read counts against it (ChartBridge cannot tell). An archived account leaves every list (`accounts`, the copier,
the Working orders tab); its history stays (fills, logs, The Desk). It stays archived, connected and healthy or not, until
Anthony shows it (`accountUnarchive`): then it is active and **unchecked**. **Exits are never stranded**: an archived
account NinjaTrader shows with a position or working orders is listed again at once, unchecked, with a `status` `warn`.
Hide is also how Anthony removes a connected account he does not want listed (a dead evaluation). Until 0.5.0 only a Gone
account could be archived, and it came back on its own when it connected again.

**The old `accounts` line (0.5.1 and 0.5.2, once; removed in 0.5.5).** 0.5.5 converts nothing: an `accounts` line is a key
it does not read, said once per load in the Output window ("config.txt: accounts is not a ChartBridge setting; the line
does nothing"), and it can go. As built in 0.5.1 and 0.5.2: the first 0.5.1 run that finds `accounts = ...` in `config.txt` converts it. It is
the first run when there is no `accounts-detail.txt` yet (any 0.5.1 run writes one, so its mere existence means "done") and
`accounts.log` has no `converted` line; if `accounts.log` cannot be read (three tries) nothing is converted (ChartBridge
cannot tell), said in the Output window. The conversion covers the **first 5 minutes** after ChartBridge starts: every account
seen Connected in that time that the line does not name (exact, or a prefix before `*`, as before) and that is not checked
is hidden once, logged `hidden: not on the old accounts list`, and the signed-in pages get a `status` `info` ("EVAL-B was
hidden: it is not on the old accounts list in config.txt. Show it from the Hidden list on the Account tab if you want it").
One that Hide would refuse stays listed, logged `not hidden` with why; one refused only because a file could not be read or
understood is tried again each second until the 5 minutes end (then logged `not hidden`). The accounts it names keep their
checkmarks exactly. Each account is looked at once, so a Show stays. After the 5 minutes (`(all)` `conversion done` in the
log) an account that connects is listed as usual, unchecked; from the next run the line is ignored, one Output line says
so, and it can go. With `accountChecks` off nothing is converted (there is no archive), the line is ignored, and the marker
is written (an `accounts-detail.txt` with only `converted`, the one file written with `accountChecks` off, and only when
there is none) so a later run with it on never converts.

**Every change is logged**: one line in the Output window and one appended to `accounts.log` (next to `config.txt`;
`<UTC ISO time>\t<account>\t<what>\t<why>`, e.g. `checked by the page`, `gone: disconnected`, `archived by the page`, and
0.5.1's `shown`, `hidden`, `not hidden`, `forgotten`, and `(all)` `converted` and `conversion done`).
Account names appear only in these local files and the local page, never in `/diag` exports or reports.

| page to server | fields (no others) | notes |
|---|---|---|
| `accountTrade` | `cid` (optional), `account`, `on` (*bool*) | set the checkmark. On is refused for an account that is Gone, archived, not Connected, Backtest or Playback, or with `accountChecks` off; off is always accepted (signed in). After any checkmark change every signed-in page gets `accounts` and `trading` again (its `accounts` list is gate 2 now) |
| `accountArchive` | `cid` (optional), `account`, `confirm` (*bool*, must be `true`) | Hide. 0.5.1: refused unless the account is flat with no working orders and is not the bot's, a copier leader or follower, or an agent's (until 0.5.0: unless it was Gone) |
| `accountUnarchive` | `cid` (optional), `account` | Show (0.5.1). Refused for an account that is not archived ("EVAL-A is not archived") or unknown; with `accountChecks` off, refused like the others |

| server to page | fields | when |
|---|---|---|
| `accounts` | `list`: `[account]` (every watched account not archived, by name: 0.5.1, seen Connected this session), `archived`: `[{name, at}]` (UTC ms; every archived account `accounts.txt` keeps, for Show) | to a v3 page from ChartBridge's own origin, signed in or not, right after its `client`; again on every change: at once for a connection, checkmark or Gone change; at most once a second for money and position changes |

An `account` is `{name, sim, connection, trade, tradable, state, goneWhy, goneSince, balance, pnlToday, realizedToday,
unrealized, positions, roomDrawdown, roomDrawdownWhy, roomDailyLoss, roomDailyLossWhy, canHide, hideWhy}`:

- `sim`: true when the account is on NinjaTrader's own simulator (Sim101 and sim accounts made in NinjaTrader), false for
  any broker account, an evaluation or funded account included (a prop firm's "simulated" account is real to
  NinjaTrader). The copier and the bot lean on this.
- `connection`: `connected`, `connecting`, `lost` (connection lost, NinjaTrader retrying), `disconnected`.
- `trade`: the checkmark, kept while Gone (0.4.2) (with `accountChecks` off: in `tradeAccounts`). `tradable`: what gate 2 says now (checkmark, the
  master switch, Connected, not Gone).
- `state`: `active` or `gone`; `goneWhy` (`disconnected`, `disabled`, or null; 0.4.1 could also send `drawdown`), `goneSince` (UTC ms
  or null).
- Money in the account's currency as NinjaTrader reports it, numbers or null: `balance` (cash value), `realizedToday`,
  `unrealized`, `pnlToday` (the two added).
- `positions`: `[{root, name, qty, avgPrice}]` on served roots (signed `qty`), empty when flat.
- `roomDrawdown` and `roomDailyLoss`: dollars left before the trailing drawdown and the daily loss limit, where NinjaTrader
  reports them for this account (its risk values for that connection); else null, and `roomDrawdownWhy` /
  `roomDailyLossWhy` says why in plain words ("NinjaTrader does not report a trailing drawdown for this account"). Never
  estimated.
- `canHide` (0.5.1): `accountArchive` would be accepted now; else false and `hideWhy` says why in the refusal's words (null
  when it may be hidden). The page shows Hide only where `canHide` is true.

**Positions and working orders across all accounts.** For a v3 page, `orders`, `order` and `position` cover every
watched, non-archived account on the served contracts (gate 6 unchanged), not only the tradable ones. Each `order` adds
`tradable` (*bool*, the account's gate 2 for entries) and, when a v3 feature placed it, `by` (`strategy`, `merge`,
`copier`, `bot`) and `bucket` (a strategy target bucket, 1 to 3). A v2 page keeps v2's scope.

**Cancel from the Working orders tab** (`cancelFromList = on`): `cancel` takes an optional `from` (`"list"`). With it, any
working order on a watched, Connected, non-archived account on a served contract may be cancelled (checkmark or not; it
is an exit action), one order per message, with the v2 OCO rule (a leg takes its partner). With the switch off, a `cancel`
with `from: "list"` is refused ("Cancel from the Working orders tab is off (cancelFromList = off in config.txt)"). A `cancel`
without `from` is v2's.

#### Accounts as built (ChartBridge 0.4.0, 0.5.1, `nt8/ChartBridgeAccounts.cs`)

**The shared v3 plumbing** is in `nt8/ChartBridgeV3.cs`, for every v3 feature: the switch table (`ChartBridgeSwitches`, read
from `config.txt` without taking any key from another reader) and `ChartBridgeV3`: `IsV3(client)` (the page sent `client`),
`AccountChecks`, `OrderTypes`, `Strategies`, `Merge`, `CancelFromList`, `Copier`, `Bot`, `SwitchesJson()`, `Gate(client)`
(gates 1, 4 and 7: a v3 action counts in the 10 a second), `Flat(text, type, keys, out why)` (gate 8 as extended for v3, for a
flat message; `strategy`'s nested object is the strategies lane's), `Str`, `Bool`, `Whole`, and `SendToV3Traders(json)`. A
`client` with anything but `{"type":"client","v":3}` gets a `status` `warn` and the page stays v2. A v2 page's `trading`
message is byte for byte v2's.

Where the contract above left a detail open, the build chose the safe simple option, marked **(lead's default)**:

- **`accounts.txt` missing after ChartBridge made it** (lead's default): a first start is "no `accounts.txt` and no
  `accounts.log`". When `accounts.log` is there, the checkmark file went missing: **no account is checked**, `tradeAccounts`
  is not used, the pages get a `status` `error` ("accounts.txt is missing ...: no account is checked for trading; check them
  again on the Accounts tab") at sign-in, and a new file is written with every account off.
- **A file that cannot be read** includes one that reads but is wrong: no header line, a line that is not
  `<state>\t<ms>\t<name>`, an unknown state, a name twice, or a Backtest or Playback account. The whole file is refused (never
  half read), every checkmark is off, the file is never rewritten that run, `accountTrade` on and `accountArchive` are refused,
  and every page gets the `status` `error` as it signs in. Windows line ends are fine.
- **Writes**: `accounts.txt` and `accounts.log` are written on the 1 s check's thread or the page's connection thread, never
  NinjaTrader's (the first start's file is written by the first check, about a second after start). A failed save keeps the
  checkmarks in force, raises one `status` `error`, and is tried again every second.
- **`plan`** on an entry is an entry action (the checkmark), like `change` on an entry. **`change` on an order placed elsewhere**
  (`role` `other`) is an entry action too (lead's default); moving a ChartBridge stop or target is an exit.
- **With `accountChecks` on, every `cancel` is an exit** (watched, Connected, not archived, not Backtest or Playback), with or
  without `from`. With it off, a `cancel` without `from` is v2's (`tradeAccounts`), and a `cancel` with `from: "list"` (when
  `cancelFromList` is on) is an exit. Exits never need the checkmark, but always need a Connected account.
- **With `accountChecks` off** there is no Gone and no file at all (0.3.8 exactly): `state` is always `active`, `trade` is
  "in `tradeAccounts`", and `accountTrade` / `accountArchive` are refused ("accountTrade is off (accountChecks = off in config.txt)").
  The `accounts` list still goes to a v3 page, read only.
- **Gone only after a first connect** (lead's default, 2026-10-07: Anthony signs the prop accounts in by hand after
  NinjaTrader opens). 0.5.1: an account not Connected yet this NinjaTrader session is not listed at all; it keeps its saved
  checkmark in `accounts.txt`, every order to it is refused by the normal gates (it is not Connected), and once it connects it
  is listed and trades at once with its checkmark. Then a drop (disconnected or disabled, for the grace) makes it Gone.
  `"notConnectedYet"` (an added field in each `account` from 0.4.0 to 0.5.2, always false since 0.5.1; no page read it) is
  gone in 0.5.5.
- **Seen this session** (0.5.1): Connected at a 1 s check, a 10 s watch, a page's sign-in or an `accounts` message in this
  ChartBridge run, or a `connected` line in `accounts-detail.txt` from this NinjaTrader process (same process id and start;
  so a recompile keeps a Gone account listed, even if the clock was set back). A line without the session field, or a
  NinjaTrader whose process cannot be read, falls back to the time: at or after NinjaTrader's process start (ChartBridge's
  start when that cannot be read). A page's orders and positions (`orders`, `order`, `position`) cover the same accounts.
- **Gone**: sampled once a second; the 10 s grace starts at the first bad reading and any healthy reading starts it again. An
  account seen this session that NinjaTrader no longer lists is listed `disconnected` and goes Gone. 0.5.1: an archived account
  stays archived when it comes back healthy (until 0.5.0 it came back on its own); one NinjaTrader shows with a position or
  working orders comes back `active` and unchecked at once.
- **Hide's "flat"** (0.5.1, lead's default): no position on any instrument and no order that is not filled, cancelled or
  rejected (served roots or not); an account whose positions or orders cannot be read counts as not flat. An account
  NinjaTrader does not list is judged by the last check that saw it this session.
- **`accountTrade` with `on: false`** is accepted for any name (signed in); it changes nothing for an account that is unknown,
  archived or already off. `on: true` for an archived account is refused ("... is archived (hidden); Show it first"). `on: true` for a name NinjaTrader and `accounts.txt` do not know is refused ("no account ...").
- **Every account ChartBridge lists is written to `accounts.txt`** (as `off` until checked), so an account that later
  disappears can still be listed Gone and archived. 0.5.1: only accounts seen Connected are listed, so only those are written
  (and the tradeAccounts names of a first start).
- **The conversion of the old `accounts` line** (0.5.1 and 0.5.2; removed in 0.5.5; lead's defaults and the review's rulings): a checked account is kept
  even when the line does not name it (0.5.0 always watched the accounts the chart may trade); an account Hide would refuse
  is not hidden; it covers the first 5 minutes after the start only; the marker is written when the conversion starts, so a
  recompile ends it. A first run that could not read `accounts.log` still writes `accounts-detail.txt`, so the line is never
  converted after that (the safe side: nothing is hidden by guess).
- **Every state change checks first** (0.5.1): a checkmark, Hide, Show and the conversion change an account only if it is
  still in the state they found, checked under the lock, so a change made in between (a Hide while a check is on its way, a
  checkmark while the conversion looks) is never overwritten.
- **Whose accounts** (0.5.1, for Hide and the conversion): the bot's (on: its memory; off: `bot-account.txt`; none when
  there is none or it says None, 0.5.7), the copier's leader and followers (on: its memory; off: `copier.txt`), an agent's chosen account (the agent
  channel's memory and every `agent-<id>-account.txt`). Read once per check from copies kept by each file's time stamp (the
  folder's for the list of agent files), each file opened so its owner may replace or delete it meanwhile. A file that cannot
  be read or understood refuses Hide for every account and is read again next time.
- **Newly listed accounts reach the pages** (0.5.1): an account that becomes listed (its first sighting, Show, or back from
  the archive with a position or working orders) makes every signed-in v3 page get that account's working orders, one
  `order` message each (pages merge them), and its `position` messages (it got none of its messages while it was not
  listed). Never a full `orders` list there: pages replace theirs on it. Sign-in still sends the full list.
- **The latest state lands last** (0.5.1, Anthony approved 2026-10-08). A snapshot (the `orders` list and `position` messages at
  sign-in, or a newly listed account's `order` and `position` messages) is read on the page's or the timer's thread and then
  queued, so it can be older than an `order` or `position` message NinjaTrader's thread queued for that page while it was
  built (until 0.5.0 a stop cancelled meanwhile could come back as a ghost on the page, or a stop placed meanwhile vanish).
  Each open snapshot has its own notes: every order and position message NinjaTrader's thread sends that page while it is
  open is noted in each snapshot open for the page (two can be open at once, for example a sign-in's list and the 1 s check's
  newly listed accounts after a recompile). Right after a snapshot is queued each order and position in its notes is sent
  again, read fresh, and again for anything noted meanwhile, until nothing new came in or 20 rounds were sent; the snapshot
  stays open through its last round's sends. A working order sent again keeps NinjaTrader's last error text. An order that is
  done is sent again (the very message NinjaTrader's thread sent, since its id is forgotten after it) only if the snapshot
  itself had sent it as working; otherwise the page already has its final state. Every `order` message sent again carries
  `"again": true`, and the pages never flash or toast for it (chart 1.16.0 `orderEvent`), so a fill or a rejection is said
  once. NinjaTrader's thread never waits on a snapshot: the per-page lock is held only to note a send or take the notes,
  never while a list is built. ChartBridge watches an account
  (its fills, orders and positions) from the 1 s check that first sees it Connected, and still on demand before an order.
- **`trading`'s accounts list** (0.5.1): the checked accounts seen Connected this session only.
- **`/diag`**: nothing added (account names stay out of new diagnostics).

**What NinjaTrader 8 reports, and what the fields use** (help guide, checked 2026-10-07; never estimated):

| field | from | notes |
|---|---|---|
| `balance` | `Account.Get(AccountItem.CashValue)` | documented |
| `realizedToday` | `AccountItem.RealizedProfitLoss` | documented ("Realized PnL"); NinjaTrader's own reset per connection, not checked to be the trading day on every connection |
| `unrealized` | `AccountItem.UnrealizedProfitLoss` | documented |
| `pnlToday` | the two added | null if either is null |
| `roomDrawdown` | `AccountItem.TrailingMaxDrawdown`, read by name | not in the documented `AccountItem` list; the Accounts tab column "Trailing max drawdown" is documented as "the remaining value of the trailing max drawdown", and NinjaTrader staff read it with `Get` "if your broker provides the information". `Get` answers 0 when nothing is reported, so 0 counts only after a non-zero value for that account this run; until then null, "NinjaTrader does not report a trailing drawdown for this account (it shows 0, as it does when none is set)". A NinjaTrader without the item: null with why |
| `roomDailyLoss` | always null | NinjaTrader documents its "Daily loss limit" column as "the percentage of the daily loss limit that has been reached", not dollars left; the why says so. The page may show a limit typed on The Desk (`/api/chart-accounts`) |
| `sim` | the account's `Provider` is `Simulator` (reflection) | unknown is `false`, the safe side for the copier and the bot |
| disabled | `Account.AccountStatusUpdate` (documented static event; `e.Status` values are not documented) | a last status text of `Disabled` counts; a status from before ChartBridge started is not seen until it changes. **Known limit** (since 0.4.0): after a recompile (F5) the status text is lost, so an account NinjaTrader disabled before it, still Connected and checked, is not Gone and ChartBridge does not refuse its entries (the broker still does). NinjaTrader documents no account property to read the status again; its Accounts tab shows it. Uncheck such an account by hand |

Money is rounded to cents. Every money and room field is null while the account is not Connected (why: "the account is not
connected").

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
Names: entry `CB#1a2b3c4d sg s20` (market) or `CB#1a2b3c4d atm sg s20` (resting; `s20` is the strategy's stop in ticks, so
recovery never depends on `managed.txt` alone; see the fix1 notes below), legs as v2 plus the bucket:
`CB#1a2b3c4d stop f2 q1 p24990.25 k2`, `CB#1a2b3c4d target f2 q1 p24990.25 k2`.

**Breakeven and trailing**, on ChartBridge's live trades for the root, per pair from that pair's own fill price: once the
best price since the fill is `beAfter` ticks in profit, the pair's stop moves to fill plus `bePlus` (a sell the other way),
once. Once it is `trailAfter` ticks in profit, the stop's level is best minus `trailBy` ticks, sent only when that is at
least `trailStep` ticks better than the stop now. With both, the better level wins. A stop **never moves back** (never
loosens), never to a price at or through the last trade (it waits for the next trade), at most one move per stop per
500 ms (lead's default), always with `change` on the working stop at the broker (a stop-limit keeps its offset). A move
NinjaTrader rejects leaves the stop where it was and raises a `status` `warn`; it is tried once more on the next eligible
move, and a second rejection halts moves for that stop (fix1).

**Saved for a restart**: `managed.txt` next to `config.txt`, one line per managed entry, `<tag>\t<strategy as the flat
JSON object sent>\t<best price per pair>\t<saved UTC ms>` (and `\tmerged` once a Merge ran on it, fix1), written whole through a temp file off NinjaTrader's thread (at
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

### Order types and Order Strategies: build notes (0.4.0, lane B1)

Built in `nt8/ChartBridgeStrategies.cs` (the rest of the `ChartBridgeOrders` class, so every v2 gate and the per-fill
bracket code are the same code). Checked by `nt8/check/StrategiesHarness.cs` inside `npm run check:orders`. Where the
contract left a detail open:

- **A v3 page.** Lane B2 owns `hello.features` `"v3"`, the `client` handshake and `trading.switches`; this lane uses B2's
  helper (`ChartBridgeV3.IsV3`, `ChartBridgeV3.SendToV3Traders`). `managed` goes to signed-in v3 pages only, in the order
  lane (`"managed"` is in `OrderLaneTypes`). `OrderTypesOn` and `StrategiesOn` read the one shared switch store, the same
  values `trading.switches` sends.
- **Switched off is 0.3.8 exactly:** `kind` `stopLimit` or `mit` is "kind must be market, limit or stop", `limitOffset` and
  `limitPrice` are unknown keys, an order with `strategy` is refused as a nested object, a stop-limit moves only in
  NinjaTrader, order messages carry no `limitPrice`, `by` or `bucket`, and an MIT placed elsewhere is `kind` `other`.
  (lead's default)
- **Names:** a stop-limit or MIT strategy entry is `CB#1a2b3c4d atm sg sl` / `CB#1a2b3c4d atm sg mit`. A strategy with no
  target has one stop per increment named `k1`, no OCO id. A bucket's OCO id is `cb-<tag>-f<filled>-<bucket>`
  (`cb-1a2b3c4d-f3-2`). A stop already traded gets one market exit per bucket, `CB#1a2b3c4d exit f3 q1 p24990.25 k2`,
  and one `status` `error`. (lead's default)
- **A ChartBridge stop-limit moved by the page** (an entry, or a strategy's stop leg) passes gate 5 as a stop, and its new
  limit (the same offset) passes `maxTicksAway`. (lead's default)
- **Moves:** a stop level is put on the tick grid on the loose side (a long's stop down, a short's up), so it is never
  past the level the rule names. Breakeven and trailing move only while `trading` and `strategies` are on. A move is
  confirmed when NinjaTrader reports the stop working at the new price; one not confirmed in 5 s is let go (the stop's
  real price counts, and a later trade may move it again). A move NinjaTrader rejects leaves the stop where it is,
  with a `status` `warn`, and is tried once more on the next eligible move; a second rejection and that stop is **not moved
  again** (no new try every 500 ms into a rejection; Anthony manages it by hand). (fix1; before fix1 the first rejection
  halted it, with a `status` `error`) Flatten stops breakeven and trailing on that account and root at once, so no move races its
  cancels. (lead's default)
- **`managed`:** `pairs` lists working pairs only; `best` is the best price over them; `id` is null when NinjaTrader no
  longer lists the entry (after a NinjaTrader restart the legs are recovered from their names alone). (lead's default)
- **`managed.txt` best prices:** `f2k1:24995.25,f2k3:24995.25` per pair (fill mark and bucket), `-` for none. Lines older
  than 7 days are dropped when the file is read. A file that cannot be read is never rewritten that run (one `status`
  `error` at start). (lead's default)
- **Restart, unmanaged also when:** `strategies` or `trading` is off at the restart; a working leg is on the entry's side,
  in a bucket the strategy does not have, a target with a strategy that has none, a target not at the strategy's distance
  from its fill, a stop of the other type (stop-market or stop-limit), or a pair with a working target and no working
  stop. The text names the reason. A strategy entry still resting whose line is lost cannot get legs from a guess: the
  error says it gets NO STOP if it fills (cancel it and place it again), and a fill then raises the NO STOP error and
  the missing-stop alarm watches it. A finished strategy entry the names still list is recovered quietly (no message).
  (lead's default)
- **For Merge (lane B4):** `ChartBridgeOrders.Allocate(q, shares)` is the allocation rule; strategy legs match
  `LegNameRx` with the bucket in group 6.

#### Order Strategies: fix1 (review findings F4, F5 and the minors)

- **The stop ticks in the entry's name (F5).** `CB#1a2b3c4d sg s20`, `CB#1a2b3c4d atm sg s20`, `... sg s20 sl`, `... sg s20
  mit`. The longest is `CB#1a2b3c4d atm sg s999999999 mit`, 33 characters, under v2's longest entry name (`CB#1a2b3c4d atm
  s999999999 t999999999 sl`, 40); the name carries only the stop (one number), not the targets or the stop-limit offset. A
  fill whose strategy cannot be read after a restart (its line lost) gets its protective stop from the name: a stop-market at
  that many ticks from the increment's fill (more certain to fill than a stop-limit), named as a bucket 1 leg, no target, never
  moved, and a `status` `error` naming the account and root. A name from before fix1 (`sg` alone) and no line: as before, no
  legs from a guess, the NO STOP error naming the account and root, and the missing-stop alarm.
- **managed.txt unreadable at the start (F5).** Every new strategy entry is refused for that run: "Order Strategies are off for
  this run: managed.txt could not be read; fix the file and restart"; the start's `status` `error` says so too. Until the file
  has been read (the first moments after a start), a new strategy entry is refused with "try again in a moment". Plain
  brackets still work.
- **No write gap (F5).** A strategy entry is sent only once its `managed.txt` line is written (whole, through the temp file,
  with the usual few tries), on the order path after the order's registration and before `Submit`. A write that still fails
  refuses the entry ("Order Strategy entry not sent: managed.txt could not be saved (...)"); its record and registration are
  undone and nothing is sent. The page's `managed` message follows the write.
- **Merged (F4).** The line's fifth field `merged` (see Merge as built); a line without it reads as before.
- **The 2 s check and a fill (minor).** The check can call a record done just as the entry's last fill is counted as covered
  and before its legs are placed. A record called done in the last minute is kept aside; a fill that finds it gone or done
  brings it back (the page is told it is active again, its line is written again), so legs and management are never silently
  dropped.
- **A rejected move (minor; replaces "not moved again" above).** The first move NinjaTrader rejects leaves the stop where it
  is with a `status` `warn` ("ChartBridge tries once more on the next move"); the next eligible move (same rules: never
  loosens, never at or through the last trade, 500 ms apart) is tried once. A second rejection halts moves for that stop,
  with a `status` `warn` to manage it by hand.
- **A ChartBridge order with no name** is never treated as a stop-limit or MIT to move (a null check).

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
restore itself fails, ChartBridge makes sure working stops cover the whole position, never by cancelling a working stop
first: what still works stays, and the contracts no stop covers get one stop at the first leg's stop price (the
stop-already-traded rule applies). It raises a `status` `error` naming what covers what ("MNQ EVAL-A: the merge failed and
the original brackets could not be put back; nothing working was cancelled, and ONE STOP at 24,980.25 now covers the 1
contract(s) no stop covered; the working stops cover 3 of 3 contract(s) (2 at 24,980.25, 1 at 24,984.25); targets ...;
check NinjaTrader"), `result` `failed` (fix1, F3; see the as built notes). A restart in the middle of a swap is caught by the legs check and the missing-stop alarm as in v2, with a
`status` `error` naming the account and root. Every merge is logged (Output window) and counted in `/diag` `merges`.

| page to server | fields (no others) |
|---|---|
| `merge` | `cid` (optional), `account`, `root` |

| server to page | fields | when |
|---|---|---|
| `merge` | `cid` (when the page sent one), `account`, `root`, `result` (`merged`, `restored`, `failed`), `stop` (`{price, qty}` or null), `targets` (`[{price, qty}]`), `pairsBefore`, `text` | once per accepted merge, when it ends |

#### Merge as built (0.4.0, `ChartBridgeMerge.cs`; lead's defaults)

Where the text above leaves a detail open, the build does this. Each is **(lead's default)**.

- **Oldest.** Pairs are ordered by NinjaTrader's order list for the account (the order they were placed). The first leg is the
  oldest pair's fill increment (every bucket of it), or a merged set from an earlier Merge.
- **More refusals.** A pair with a target and no stop, two stops in one pair, targets larger than their stop, a leg on the
  wrong side, or a leg being cancelled: refused ("let the legs check settle first"). First-leg stops at different prices
  (breakeven or trailing moved some): refused. An entry is any working order on the opening side, or any `CB#` order that
  is not a stop or target (an entry or a market exit). "Through the market" needs a last price under 300 s old (gate 5).
  A fill on the account and root counts as a position change for the 2 s, and so does the end of a merge.
- **The freeze** also refuses `cancel` on that account and root.
- **Cancelling a pair** sends the cancel to both legs (the OCO would take the target; sending both means a slow OCO never
  leaves half a pair).
- **One target, kept pair.** The first-leg pair that has the target is kept and grown; any other first-leg pair is merged into
  it like the rest. A merged set from an earlier strategy Merge is kept the same way: its stop grows, and its targets are
  cancelled and placed again for the whole position by the allocation rule.
- **The shares** for a strategy come from the strategies code's own state (`ChartBridgeOrders.StrategyShares`: the live
  record, or the entry's `managed.txt` line as read at the start); unknown shares refuse ("never guessed"). The allocation is
  the strategies code's `Allocate` (one rule). If a bucket of the first leg is gone (its target filled, or the rule dropped it),
  the position is allocated over the buckets that are left, by their shares out of their sum.
- **Names.** `mstop q<n>` carries the whole position at placement; names never change after that.
- **Restore.** A pair is placed again with its own name and prices and a new OCO id (`...-r<run>-<n>`, fix1: `<run>` is the
  run's start in seconds as hex, so an id is never used twice across restarts), and only for what the
  position still needs (after a fill during the swap the position can be smaller), so the stops are never above it. A change
  NinjaTrader never confirmed is sent again with the size it should have.
- **Fallback (fix1, F3).** Never a working stop cancelled before a replacement covering the same contracts is confirmed
  working, and never two stops for the same contracts. So the fallback does not join the stops into one: every stop and target
  still working stays where it is (a pair keeps its OCO target); this merge's own merged targets, and a target whose OCO stop is
  gone (a pair put back with its stop rejected), are cancelled (neither is a working stop's partner). Then, by what the working
  stops cover against the position: fewer contracts: ONE STOP for the contracts no stop covers at the first leg's stop price
  (the merged stop this merge placed grown, when it has no OCO partner, else a new `mstop`), confirmed; a market `exit` for
  them instead when a trade from the last 2 s is at or through that price. More: trimmed, this merge's own stop first, then the
  newest, an OCO target first down to its stop's new size. Exactly: nothing is sent. A placement that is rejected or not
  confirmed leaves every stop in place, and the error says how many contracts have NO STOP. Flat: every ChartBridge leg there is
  cancelled. The `status` `error` and the `merge` text name what covers what (the stops by price, the targets by price);
  `merge` `stop` gives the first leg's stop price and the contracts the stops at that price cover (lead's default).
- **A cancel not confirmed (fix4, G1).** A stop the swap asked NinjaTrader to cancel, and that is not yet cancelled or filled,
  never counts as protecting the position (it still counts toward "never over-protected"). When the restore needs that pair
  back, it waits (3 s at most) for every leg asked to cancel to reach a final state, then places the pair again for what the
  position still needs. If the cancel is still pending, nothing is placed for it (a cancel that fails would leave two stops),
  the answer is `failed` (never `restored`), and the `status` `error` names the stop whose cancel is not confirmed. The pair is
  then watched for 10 minutes: when its cancel lands (stop cancelled), the stops are checked again at once and the pair is
  placed again at its own prices for what the position still needs, never over it, with a `status` message saying so (an
  `error` if the stops still do not cover the position). A Flatten since then, or another Merge running, drops it. `restored`
  is answered only when the stops, none of them waiting on a cancel, cover exactly the position.
- **A late placement and Merge (minors, 4).** While a late cancel's pair is being placed again on an account and root, `merge`
  there is refused: "a restore is finishing: try Merge again in a moment". The check is made with the freeze, under the same
  lock, so a Merge and a late placement never run together on one account and root. The placement counts the stops and sends
  the pair under MergeSendLock, the lock every swap's order call and Flatten's abort take, so no other order call of a swap
  and no Flatten comes between the count and the send; the wait for NinjaTrader's confirmation comes after that lock, so a
  Flatten is never held up by it. The restore inside a swap counts and sends the same way.
- **A flip during a swap (fix1).** If the position turns to the other side (a long that is now short), nothing is put back (a
  stop or target of the old position is on the side that adds to the new one): every ChartBridge leg of the old position is
  cancelled, the new position's own legs stay, and a `status` `error` says how many contracts held now have no stop. `result`
  `failed`.
- **Flatten during a swap** ends it with no restore: `merge` `result` `failed`, text "Flatten ended the merge; ...", no status
  error (Flatten closes the position). Counted under `failed`. Fix1 (F1): the swap ends only inside Flatten, once Flatten passed
  its own gates (the account Connected and allowed, the root served), and in one step with the flatten call, under the swap's
  send lock, so nothing the swap sends can follow it. A Flatten that is refused (a reject) leaves the swap alone: it goes on, or
  restores, exactly as without it, and its answer never mentions Flatten. If the flatten call itself throws, the swap is let go
  again and restores. The bot's Flatten goes through the same Flatten; the copier's own "flatten this follower" (0.4.3: its
  cancel-confirm-close, never NinjaTrader's Flatten) is in `ChartBridgeCopier.cs` and does not end a swap.
- **The answer** (`merge`) goes to the page that sent the merge, until a v3 `client` flag exists to send it to every v3 page.
- **After a multi-target merge** (upkeep, even with trading off): a merged target fill shrinks the merged stop by those contracts
  (from the size last asked for, so two fills in a row never leave it larger); a part fill of the merged stop trims the targets
  from the last bucket back. Gate 3, the scan's leg cover and the legs check count a merged set as one group (like an OCO pair),
  and the legs check shrinks it as a set.
- **After a restart, a merged target's fill (fix1).** ChartBridge never saw the merged set's earlier events, so a target first
  seen with fills cannot count a delta. The merged stop then shrinks to what NinjaTrader's position holds beyond the other
  ChartBridge stops, at once when the position already shows the fill, else at the position update that follows (within
  10 s). NinjaTrader's own position only (the fills in transit reading can count a fill from before the restart twice); it
  never grows the stop and never cancels it on this reading (flat, the other side or nothing left is for the legs check).
- **A restart mid-swap.** `merge_swap.txt` (next to `config.txt`) lists running swaps; one left at the first legs check after a
  start is a `status` `error` naming the account and root, also sent to each page that signs in for the next 10 minutes.
- **Config.** A `merge` value other than on/true/1/off/false/0 is off, with one Output line. `/diag` `merges` also has `running`.
- **`merge_swap.txt` (fix1)** is read, changed and written whole under one lock (two swaps on two accounts never lose each
  other's line), through a temp file swapped in.
- **Merged is saved (fix1, F4).** When a swap ends (merged, restored or failed), every managed entry on that account and root
  is marked merged and `managed.txt` is written whole (temp file) on the merge's thread, before the swap unfreezes (breakeven
  and trailing stay paused until then) and before its line leaves `merge_swap.txt`. After a restart such an entry is
  recovered as `unmanaged` ("merged before the restart: breakeven and trailing stay off for this position, every stop stays
  where it is"); no status error, since that is expected. Its shares stay in the line, so a later Merge can still use them.

### Quote-only markets (`quoteRoots`)

Built and documented in "0.4.0 hardening and markets" above, which is the contract: `quoteRoots` (default `YM, RTY, GC,
SI, CL, 6E, ZN, ZB`, `quoteRoots =` for none), the early refusal of every order action naming one, each market's own
front-month roll, and the `hello` instrument fields `quoteOnly` and `priceFormat` (`"decimal"`, or `"32nds"` for ZN and
ZB; the page shows half 32nds when the tick is 1/64, so ZN `104.109375` is `104'035` and ZB `118.46875` is `118'15`).
Copier and bot orders on a quote-only root are refused by the same check. Prices on the wire stay plain decimals.

### Copier engine (`copier`, on by default)

**Sim or real followers (Anthony 2026-10-07: no Sim lock).** A follower may be any watched account, Sim or real. The leader
and every follower need gate 2 for entries (the checkmark, or `tradeAccounts`), and every gate applies to each follower order
on its own account (trading on, Connected, not Gone, caps on the follower's root; the rate of the copier itself is not
counted against the page). Each follower carries `sim` (NinjaTrader's simulator or not), and the page marks it SIM or LIVE.
The bot's account is never a follower that is on (see the review 2 notes below).

**The leader** is one account, and only entries placed **from ChartBridge's own page** on it are copied (not entries placed
in NinjaTrader, the phone or the bot). **Exits on the leader are always copied, whatever caused them**: a stop or target at
the broker, the phone, NinjaTrader, Flatten. While the copier is armed with a follower on, a leader entry with no stop
(no bracket stop, no strategy) is refused ("the copier needs a stop on every leader entry") (lead's default).

**Followers**, saved per account: `on`, `qty` (1 to 9: a **fixed quantity**, 0.4.3), `size` (`micro` or `mini`: the
leader's NQ or MNQ maps to MNQ or NQ, ES or MES to MES or ES). So a follower at 3 `micro` gets 3 MNQ for each leader entry,
whether the leader buys 1 NQ or 5 MNQ. (0.4.0 to 0.4.2 copied `qty` per leader contract, the multiplier Anthony had moved
away from in August; on WORK 2026-10-07 a qty 1 follower took 5. Anthony 2026-10-07: fixed; an add on the leader copies the
follower's `qty` again; a scale-out reduces it by the same share.)

- **Executions mode** (`mode` `executions`): on the first fill of each leader entry (from flat, or an add), every follower
  gets a **market** order for its `qty`, once; a later fill of the same entry copies nothing more. Followers always enter
  (no price check). Slippage per follower (its fill minus the
  leader's, in ticks of the follower's root, signed so worse is positive) is logged and shown. The moment it fills, the
  follower gets its own protective stop at the broker at the **same price** as the leader's stop for that increment (the
  stop-already-traded rule applies: a market exit). When the leader's stop moves (a drag, breakeven, trailing, a merge),
  each follower stop mapped to it moves to the same price.
- **Orders mode** (`mode` `orders`): every leader entry order is placed for each follower as a real order (same kind and
  prices, its fixed `qty`); moved and cancelled with the leader's; on its fill the follower gets its stop as above.
- **Never cross zero.** A follower exit is always "close this account" on that root, never an opposite order sized from
  the leader, and **never NinjaTrader's Flatten** (0.4.3: on WORK 2026-10-07 the follower's own stop, at the leader's stop
  price, sold 1 of 5 in the same instant as Flatten closed the 5 it still showed: short 1). Every order on that contract that
  may still fill is cancelled first; once NinjaTrader confirms each one cancelled or filled, every fill there has come
  through ChartBridge's order events (so both position readings can include it), and both readings agree, what it still
  holds is closed at market. Not confirmed within 3 s: nothing is sent, a `status` `error`, and the close is owed: it is tried
  again every 4 s, whatever the leader does, until it goes out or the follower is flat (its stops are already cancelled), and
  no new copy goes to that follower contract meanwhile (skipped "closing"); readings still apart at 3 s: the smaller is closed
  (never more than either shows). The close stays owed until the follower is flat by both readings with every fill there
  through (a close rejected, cancelled or part filled is tried again; while one may still fill, no other starts). What may
  still fill and the fills not yet through are read before the position and again after; anything new sends nothing. A
  fill NinjaTrader shows whose order event never comes stops blocking after 10 s (one `status` `error`), but its contracts
  are taken off any close or reduce there until its event comes, or its executions are all in and a position update came after them (never more
  than the position less that fill); every follower's orders are looked at each second. A close that neither fills nor ends
  in 10 s: one `status` `error`, it is cancelled, and the close goes again once NinjaTrader confirms. Owed while
  it holds the other side for 10 s: one `status` `error`, and it is left to the user. A copier order NinjaTrader refuses is
  an `error`; the rest of the copier's work goes on, and an owed close is tried again. After a restart, a follower holding a position with a filled copier entry there, no working stop on its
  closing side and no copier record gets one `status` `error`. (0.4.3, from the independent review.) A leader scale-out (a partial
  exit) leaves each follower the same share of what the copier gave it, rounded to the nearest contract (half up), with no
  minimum cut (0.4.3, Anthony 2026-10-07: a Qty 3 follower under a leader of 5 holds 3, 2, 2, 1, 1 as the leader scales out
  one at a time, and a Qty 1 follower keeps its 1 until the leader is flat); the leader flat means every follower flat. A flat follower gets nothing.
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
  0.6.3 (audit C9, Anthony's decision): **the leader** counts as gone only once it has not been Connected for about 10 s
  (`LeaderDownMs`), so a blip is not a stand-down ("the leader <name> left Connected (not Connected for 10 s): it re-arms by
  itself once the leader is Connected again and every follower matches its position", a `status` `warn` and a `copierEvent`
  `standDown`). Stood down by the leader, the copier **re-arms by itself** once the leader is Connected (and steady) again and
  every follower that is on holds the leader's side on each market (NQ with MNQ, ES with MES; flat where the leader is flat):
  a `status` `info` and a `copierEvent` `rearm` "Re-armed by itself: ...". If a follower does not match (or is not
  Connected) it says so once ("the leader <name> is Connected again but <follower> is long on MNQ where the leader is flat:
  the copier stays stood down until they match or you press Re-arm") and stays stood down, as before, re-arming by itself only
  once they match. Followers (3 or more within 10 s) stand it down as before, until Re-arm.
- **Every copy decision is logged with its timing**: `copier.log` next to `config.txt` and the `copierEvent` message
  (`leaderMs` from the leader's event to the follower's order sent, `fillMs` to its fill).
- **Saved** in `copier.txt` next to `config.txt` (leader, mode, one line per follower), written by ChartBridge only.

| page to server | fields (no others) | notes |
|---|---|---|
| `copierGet` | `cid` (optional) | answer: `copier` |
| `copierSet` | `cid` (optional), `leader` (an account name, or `null` for none, 0.4.3), `mode` (`executions` or `orders`) | at least one of the two; refused while the leader has a position or working entry. `null`: no leader, the copier stands down ("No leader is set.") and copies nothing until a leader is set and Re-arm is pressed |
| `copierFollower` | `cid` (optional), `account`, `on` (*bool*), `qty` (1 to 9), `size` (`micro` or `mini`), `lossLimit` (whole dollars, 1 or more, or `null` for off) | all keys required; saved at once; the leader cannot be a follower |
| `copierRearm` | `cid` (optional) | refused while the leader is not Connected or 3 or more followers are not |

| server to page | fields | when |
|---|---|---|
| `copier` | `enabled` (the switch), `simOnly` (`false` since Anthony's 2026-10-07 decision; kept for older pages), `armed` (*bool*), `standDownWhy` (null or plain words), `leader` (`{account, connection, position}` or null), `mode`, `followers`: `[{account, sim, on, qty, size, root, position, lastAction, lastAt, slippageTicks, skipped, lossLimit, pnlToday, connection}]` | after `auth` and `copierGet`, and on every change |
| `copierEvent` | `at` (UTC ms), `account`, `action` (`enter`, `stop`, `move`, `reduce`, `flatten`, `skip`, `sweep`, `standDown`, `rearm`, `refused`, `recovered`), `root`, `qty`, `price`, `slippageTicks`, `leaderMs`, `fillMs`, `text` | each copy decision |

#### Copier engine: as built (0.4.0, `nt8/ChartBridgeCopier.cs`)

Built to the rules above. Where they left a detail open, the choice below was made and is marked **(lead's default)**.
The Mono harness `nt8/check/CopierHarness.cs` (inside `npm run check:orders`) runs Anthony's Sim test list against it.

- **Switch.** On by default; `copier = off` (or `false`, `0`) turns it off. Off: every `copier*` message is
  refused ("The copier is off (copier = off in config.txt).") and every hook returns at once, so ChartBridge behaves as 0.3.8.
  `trading = true` stays above it; the copier never changes either switch.
- **v3 pages only.** Copier messages need a v3 page (`ChartBridgeV3.IsV3`, after lane B2's `client` handshake). Such a page gets `copier` after `auth`, with
  `enabled: false` when the switch is off. `copier` is sent again on every decision and within a second of a position change.
- **Sim** is read from NinjaTrader: the account's `Provider` (`Account.Provider`, else `Account.Connection.Options.Provider`)
  reads exactly `Simulator`; anything else, or nothing readable, is not Sim; Backtest and Playback never. Since Anthony's
  2026-10-07 decision it only marks a follower (`sim` in `copier`; the page's SIM or LIVE): it refuses nothing. Every
  follower entry passes `Eligible` (the account gates) and every exit `ExitAllowed` (Connected, watched).
- **Which leader entries.** Only an entry sent from the page on the leader while the copier is armed with a follower on,
  and (executions mode) still armed when it fills (lead's default). A leader fill with no stop at the broker (its plan
  removed the stop, or its stop level had traded and it exited at once) is not copied.
- **Names.** Follower entry `CB#<tag> copy <leader entry tag>` (Day), reduce `CB#<tag> copy out`, follower stop
  `CB#<tag> stop f<n> q<n> p<fill>` (a lone GTC stop, no target, no OCO), stop-already-traded exit `CB#<tag> exit ...`.
  The stop is named as a ChartBridge leg, so v2's legs check, missing-stop alarm and flat cleanup watch it too (lead's
  default). A follower gets no target: the leader's target fill is an exit and is copied as a reduce or a flatten.
- **Order and lock.** Follower orders are checked and sent one at a time on one copier thread, under the same lock as the
  page's orders (gate 3 cannot be raced). NinjaTrader's event thread only records and queues. A follower order counts in
  gate 3 from the moment it is sent.
- **Skips** (`skipped` on the page): `position limit`, `not connected`, `not checked for trading`, `gone`, `loss limit`,
  `opposite position` (never cross zero), `no contract` (the micro or mini is not served), `busy` (the follower already
  holds a copy of the leader's other contract on that one; lead's default), `bot account` (the bot's account). In orders
  mode also `price` (the leader's price fails gate 5 on the follower's contract) and `kind` (only market, limit and stop are
  copied; lead's default). The next entry the follower takes clears it. (`not a Sim account` went with the Sim lock, 2026-10-07.)
- **Loss limit.** P&L today is realized plus unrealized as NinjaTrader reports it (`Account.Get`, US dollars). With a limit
  set and no reading, the follower is skipped (never guessed). Once at or past the limit it stays skipped until the next
  18:00 ET session, even if its P&L comes back (lead's default).
- **Exits.** The leader's exits are read from its position updates (NinjaTrader's own position), acting only on a leader
  connection that has been Connected for 30 s (v2's steady rule; lead's default). Flat, or turned to the other side in one
  update: every follower copy on the old side is closed on its contract (the close above, 0.4.3). A scale-out: the share is taken of
  the contracts the copier gave that follower, rounded half away from zero, no minimum cut (0.4.3), so a follower whose own stop already
  took some is not reduced twice (lead's default). The follower's stops are shrunk to the new size first (stops whose leader
  stop is gone first, then the newest), and the market reduce, sized from the follower's position read again, is sent only
  once NinjaTrader shows the stops shrunk or cancelled; not confirmed within 3 s: no reduce at all, and a `status` `error`.
- **A missed exit** (the follower, or the leader's connection, was down when the leader exited): a follower holding a copier
  position while the leader has been flat on that contract for 4 s (both readings, a steady leader connection, no page entry
  working there) is flattened (lead's default; the exit rule).
- **Orders mode.** A follower filled before the leader gets its stop where the leader's planned stop goes if the leader
  fills at its price; for a market leader entry it waits for the leader's stop up to 2 s, then uses the leader's planned
  distance from its own fill, or is flattened when the leader has none. Once the leader fills, those stops follow the leader's
  actual stop. A leader move the follower's contract refuses (gate 5) cancels that follower's order (lead's default).
- **Stops follow** the leader stop of the same fill increment. When that leader stop goes away while the leader still holds
  (a merge), a follower stop follows the leader's working stop if all of them are at one price, else stays where it is
  (lead's default). A move NinjaTrader rejects leaves the stop where it was.
- **The sweep** leaves an order alone for 3 s after it was sent (its fill or position update may be on its way), and acts only
  when the follower is flat by both readings (lead's default).
- **Mass disconnect** counts every listed follower, on or off, as does Re-arm (lead's default).
- **copierSet** is refused while the current or the new leader has a position or a working entry. The leader cannot be
  Backtest or Playback.
- **A restart.** A follower's working copier stop is taken back from the names (its entry's name gives the leader entry's
  tag) and follows that leader entry's working stop at the same price, if any; a working copier entry from before is
  cancelled, since it can no longer be linked to the leader's and its fill would get no stop (lead's default). Every start
  is stood down.
- **copier.txt** cannot be read: no leader or followers that run, never rewritten, settings and Re-arm refused, `/diag`
  says so. A failed save keeps the setting in force, raises a `status` `error` and is tried again every second.
- **copier.log**, next to `config.txt`, one tab-separated line per decision, appended every second off NinjaTrader's thread:
  `<UTC ISO time> <account or -> <action> <root or -> <qty> <price> <slippageTicks> <leaderMs> <fillMs> <text>`. The
  Output window gets the same line. A follower's fill is logged with its stop (`stop`: price, slippage, `fillMs`).
- **`/diag` `copier`** (only with the switch on): `armed`, `followers`, `followersOn`, `decisions`, `skipped`, `standDowns`,
  `leaderMsMedian` (of the last 200), `openCopies`, `settingsReadFailed`, `settingsSaveFailed`. No account names.

**Review 2 fixes (as built).** Anthony's rules: the copier never crosses zero; no copier exit can open or add a position the
other way; a follower's stop sits at the same price as the leader's and moves when it moves; when in doubt, refuse. Each
fix has a check in `nt8/check/CopierHarness.cs` ("review 2 ...") or `IntegrationHarness.cs` (X9 to X11).

- **A late fill after the copier flattened a follower** (finding 1). When the copier flattens a follower, every copier
  entry there that could still fill is marked. A fill of a marked entry (its order event late) is never protected as a new
  position: no market exit, no lone stop. If the leader is flat (both readings) it is "flatten this follower": the copier's
  own working orders there are cancelled first, then the close (above) takes what it holds, only when it holds something
  by both readings (a close already under way takes it; 0.4.3); when it holds nothing, nothing else is sent and the missed
  exit check (4 s) closes it if a position shows later. If the leader is not flat, what it holds gets a stop sized as below.
  Always a `status` `error` and a log line. Fills that waited for a stop on that follower get none once it is closed.
- **Every protective stop or exit is sized to what the follower holds** (finding 1, changed by review 3): it goes AT ONCE,
  on the fill's own event, sized to the fill capped by the LARGER of the follower's two position readings on the copy's side
  (the fill's position update is usually still on its way) minus the copier's stops and exits that may still fill there.
  Nothing is sent when that is 0, when it is flat, or when it holds the other side (a `status` `error` says so). A late fill
  whose leader is not flat is sized from the smaller reading. There is no wait. Once both readings agree, the copier's stops
  there are shrunk to what it holds (newest first; never while a reduce runs; flat or the other way is left to the sweep),
  so they never stay above the position. This also covers the orders mode stop that waited for the leader's (CheckWaits).
- **Flat by both readings: at once** (minors, 1). When a follower's position update says flat, both readings agree it is flat,
  and its connection is steady (30 s), the copier's stops and exits on that contract are cancelled at once, young or not, and
  logged (`copierEvent` `sweep`: "flat by both readings (closed outside ChartBridge)"). This covers a follower flattened
  outside ChartBridge (by hand, or a prop firm's liquidation) while a copy's fill was in flight; the sweep (3 to 5 s) is
  no longer needed for that. Its copier entries are left to the sweep (an orders mode entry may be waiting for the leader's).
- **A position update that lags** (minors, 2). The copier's stops are never shrunk below the larger reading while a copy's
  fill there is not yet in the position (the readings must agree, so both are the larger). NinjaTrader's second reading
  forgets a fill after 10 s; a copy fill still not booked then holds the trim on that contract, with one `status` `warn`
  ("a copied fill's position update has not come in 10 s; its copier stops are not shrunk until NinjaTrader updates the
  position"), until a fresh position update arrives for it. Fills are marked as copy fills when NinjaTrader reports them.
- **A fill handled while the copier's close runs** (review 3): each follower contract keeps a count of the copier's
  closes, raised before the close's cancels are sent. A fill is recorded with the count of its moment; if the count moved
  before its stop is placed, the fill is late (as above), so no stop or exit is sent after the close starts. A copier stop or
  exit whose cancel is still pending counts as cover (it may still fill), for the stop size and for the reduce.
- **A scale-out reduces only the copier's own share** (finding 2): the share is of the contracts the copier gave that
  follower, and the reduce is never more than the copier still holds there above its new size, and never so much that the
  stops left working on that side (the copier's, shrunk first, and the follower's own) would exceed the position. A
  follower's own contracts and its own stops are never touched. When the copier's whole share closes while the follower
  also holds its own contracts, it is a reduce of the share (its copier stops cancelled first), not a close of everything.
  A copier with no share there sends nothing. After a restart the share is what the recovered copier stops cover.
- **The bot's account and the copier** (finding 3; since 2026-10-07 the bot's account is the one Anthony chose, Sim101 by
  default): while the bot is on, the bot's account cannot be turned on as a copier follower ("Sim101 is the bot's account: it
  cannot be a copier follower while the bot trades it (choose another account for the bot on the Bot tab first)."); one
  already listed is skipped before every copy (`skipped` `bot account`); the bot refuses entries while its account is a
  follower that is on ("Sim101 is a copier follower: the bot does not trade while the copier copies to its account (turn
  that follower off on the page)."); and `botAccount` refuses an account that is a follower that is on, or the leader. Both refusals are logged. Turning that follower off is always allowed.
- **Stop prices in step** (finding 4): each follower stop records the price the copier placed it at or last moved it to.
  Every leader stop event re-syncs any follower stop mapped to it whose recorded price differs, not only when the leader's
  price changed; a follower stop placed while the leader's stop was already elsewhere follows it at once.
- **The sweep** (finding 5) cancels a copier order on a flat follower only on a connection that has been steady 30 s (v2's
  flat cleanup rule) and after two flat readings in a row (two sweeps, a second apart), besides the 3 s young order rule.
- **A copy recovered without its leader** (finding 6): after a restart, a recovered copier stop whose leader entry is not
  listed is told plainly (`copierEvent` `recovered` and a `status` `warn`: "SIM-F1: copied position recovered without its
  leader; only its own stop protects it", with the follower's name). It is in the missed exit check by root: the leader flat
  on every contract of that market (NQ and MNQ, or ES and MES; both readings, no other month, no ChartBridge entry working)
  for 4 s flattens it (the zero rule). A recovered follower stop whose leader stop is found (at the same price, or all that
  entry's stops at one price) is re-synced to the leader's current stop price at once.
- **Registered before Submit** (finding 8): the page's leader entry is registered for copying before it is sent, so a fill
  NinjaTrader reports inside Submit is copied; it is dropped when Submit throws or NinjaTrader rejects it at once (orders
  mode then places no follower order for it).
- **`by`** (finding 9): copier orders carry `"by": "copier"` on v3 pages only (see "Who placed it" under Orders).

### Bot channel (`bot`, on by default)

A local bot program on the trading PC (a rule program, never AI; the bot in this repository's tests is made up)
connects on its own WebSocket path **`ws://localhost:<port>/bot`** with its own permission level. **AI is never in the
order path**: every bot order is placed by ChartBridge from the bot's parameters, inside ChartBridge's rails.

**Its secret.** With `bot = on`, ChartBridge makes `bot-secret.txt` next to `config.txt` on first start (two `#` comment
lines, then 64 hex characters of random bytes); the bot reads it from that file. The upgrade to `/bot` needs: a loopback
address (as every request), **no** `Origin` header (any `Origin`, so any browser page, gets 403), and the header
`X-ChartBridge-Bot: <secret>` (constant-time compare; wrong or missing: 403). One bot connection at a time: a second gets 409.
The secret is never printed in the Output window, `/diag` or any log; deleting the file makes a new one at the next start.

**Modes** (set from the page, `botMode`; every ChartBridge start begins in `shadow`, auto never survives a restart, lead's
default). 0.6.3 (audit C5, Anthony's decision): the bot's kill switch survives a restart: `botKill` on writes `bot-kill.txt`
(as the agents' `agent-<id>-kill.txt`), off removes it, the bot's `welcome` carries `"killed"`, and the page's `bot` message
carries `killedAt` (UTC ms, or null):

- `shadow`: the bot's signals are shown and logged; no orders.
- `copilot`: a fired signal becomes a **proposal** to every signed-in v3 page, with its reason. Anthony accepts or rejects
  with one key (see Shared settings); the page sends `botSeen` the moment it shows it and `botAnswer` with
  the moment he answered; both times are recorded. On accept, **ChartBridge places the order from the proposal's
  parameters** (never from the page's, never anything else). An unanswered proposal is **never sent**: it expires when the
  bot withdraws it (`withdraw`: its entry is no longer valid) and is logged as "not answered". Accepted orders go to the
  bot's account (below), and only if it is still the account the proposal named.
- `auto`: ChartBridge places the bot's fired signals itself, **on the bot's account** (below), whatever the bot sends.

**The bot's account (Anthony 2026-10-07: no Sim lock).** The bot trades the one account Anthony chooses on the page
(`botAccount`), Sim or live; None (nothing trades) until he chooses one (0.5.7; until 0.5.6 Sim101). The bot itself never names an account. ChartBridge saves the
choice in `bot-account.txt` next to `config.txt` (two `#` lines, then `account<TAB><name>`, written whole through a temp file;
no file: None; None is saved as `account<TAB>-`, 0.5.7). A file that cannot be understood is never written over and stands the bot down (no new entries) until the
page chooses the account again or the file is deleted. `botAccount` is refused, in plain words, unless the account is in
NinjaTrader under that exact name, never Backtest or Playback, and passes the account gates now (trading on, its checkmark or
`tradeAccounts`, Connected); while the copier uses it (a follower that is on, or the leader); while the bot has a position
or a working entry ("the bot has a position or a working entry: choose its account when it is flat"); and (minors, 3) while
the account chosen, or the bot's account now, holds any position or any working order on the bot's root, the bot's or not,
any contract month, by either position reading ("EVAL-A holds a position or a working order on MNQ: choose the bot's account
when both accounts are flat on MNQ", or "the bot's account Sim101 holds ..."). A change expires the
open proposals as `not answered` (they were for the old account), is logged with SIM or LIVE, and the bot gets `welcome`
again. `bot`, `welcome` and `botProposal` carry `account` and `sim` (NinjaTrader's simulator or not: the page's SIM or LIVE
mark; unknown is `false`, shown LIVE).

**Rails** (enforced in ChartBridge, whatever the bot sends; reset at 18:00 ET): at most **1 contract**, on `botRoot` only
(default MNQ); at most **5 trades a day** (an entry that filled, even partly, is a trade); **stand down after 3 losing
trades** (a closed bot trade with realized P&L below 0; no new entries until the next session); no dollar limit on Sim; every
bot entry needs a stop (`stopTicks` 1 or more, lead's default); the **kill switch** on the page (`botKill`); all v2 gates
(trading, the bot account's gate 2, caps, grid, side of market, rate) on top. **Heartbeat**: any bot message counts; 5 s of silence
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
| `flatten` | none | auto mode only: close the bot's position on its account (cancel its legs, then market) |

| server to bot | fields | when |
|---|---|---|
| `welcome` | `version`, `mode`, `account` (the bot's account), `sim` (*bool*), `root`, `rails` (`{maxQty, maxTrades, maxLosses}`), `instruments` (as `hello`) | answer to `botHello` |
| `tick` | as the page's `tick` | every live trade on every served root |
| `order`, `position`, `exec` | as the page's, for the bot's own orders and position only | on every change |
| `botState` | `mode`, `killed`, `standDown` (null or why), `trades`, `losses` | on every change |
| `answer` | `id`, `answer` (`accepted`, `rejected`, `not answered`, `refused`), `text` | the end of each proposal |
| `reject` | `id`, `reason` | a signal or action refused by a rail or a gate |

| page to server | fields (no others) | notes |
|---|---|---|
| `botMode` | `cid` (optional), `mode` (`shadow`, `copilot`, `auto`) | `auto` refused unless the bot's account is tradable (its checkmark or `tradeAccounts`, Connected) |
| `botKill` | `cid` (optional), `on` (*bool*) | on: as the heartbeat loss, and no bot order until off |
| `botSeen` | `id`, `at` (page UTC ms, whole number) | the moment the proposal showed; not rate counted |
| `botAnswer` | `cid` (optional), `id`, `answer` (`accept` or `reject`), `at` (page UTC ms) | an expired or already answered proposal is refused |
| `botAccount` | `cid` (optional), `account` (0.5.7: `null` is None) | the bot's account (Anthony 2026-10-07); refused as above; saved in `bot-account.txt` |

| server to page | fields | when |
|---|---|---|
| `bot` | `enabled`, `connected`, `name`, `mode`, `account`, `sim` (*bool*), `root`, `position` (`{qty, avgPrice}`), `pnlToday`, `trades`, `maxTrades`, `losses`, `maxLosses`, `killed`, `standDown`, `lastBeatMs` (ms since the last bot message), `lastSignal` (the last `botSignal` or null) | after `auth`, on every change, and once a second while the bot is connected |
| `botSignal` | `id`, `at`, `action`, `side`, `kind`, `price`, `stopTicks`, `targetTicks`, `reason`, `result` (`shadow`, `proposed`, `placed`, `refused: <why>`, `skipped`) | each signal |
| `botProposal` | `id`, `at`, `account`, `sim` (*bool*), `root`, `side`, `kind`, `price`, `qty` (1), `stopTicks`, `targetTicks`, `reason`, `state` (`open`, `accepted`, `rejected`, `withdrawn`, `not answered`), `seenAt`, `answeredAt` | when proposed and at each change |

#### Bot channel as built (ChartBridge 0.4.0, `nt8/ChartBridgeBot.cs`)

Built exactly to the section above. Where it left a detail open, the safest simple choice is written here and marked
**(lead's default)**. Tests: `nt8/check/BotHarness.cs` (Mono, inside `npm run check:orders`) and `test/fake-bot.test.js` with
the made-up bot client `test/fake-bot.mjs` (no real bot's rules anywhere in this repository).

- **`config.txt`**: `bot` (on by default since 2026-10-07; `bot = off` turns it off),
  `botRoot` (default `MNQ`), `botLibrary` (default `bot-library.json`, see below) (lead's default).
- **The upgrade to `/bot`** answers, in this order: **404** while `bot` is off (any request to `/bot` or `/bot-library`);
  **403** for any `Origin` header (even an empty one or ChartBridge's own); **403** for a missing or wrong
  `X-ChartBridge-Bot`; **400** for a request that is not a WebSocket upgrade; **409** while a bot is connected. The address
  check (loopback only) runs first, as for every request. A `bot-secret.txt` that exists but cannot be read (not exactly one
  line of 64 hex characters after the `#` lines) is never written over: every bot is refused until it is fixed or deleted
  (lead's default). `/diag` says only `"secretFile": "ok" | "missing" | "unreadable"`.
- **The bot's first message is `botHello`**; anything else before it is refused (`reject`, nothing done). `connected` in
  `bot` is true once it said hello. A bot message over 64 KB closes its connection. At most 10 bot messages a second
  (`beat` not counted). `reject` to the bot carries `id` null when the refused message had none.
- **`signal`**: `stopTicks` (1 or more) and `targetTicks` (1 or more, or `null`) are both required on `fired`; the bot never
  names an account, a root or a quantity (unknown keys, refused in every mode). An `id` used once today is refused.
- **One trade at a time, 1 contract** (lead's default): a new bot entry is refused while a bot entry is working or a bot trade
  is open, and gate 3's cap for a bot entry is 1 whatever `maxQty` says, counted with the bot account's position and its working
  orders on that root as gate 3 always does (so a manual position there blocks a bot entry on the same side, and a bot entry
  never reduces a position: it always carries a stop, and v2 refuses a bracket on a reducing order).
- **A bot trade** (lead's default) opens with the first fill of a bot entry (counted as a trade then, even if part filled) and
  closes when the bot account's position on the bot's root, followed from every execution on it since that fill, is flat again,
  whatever closed it (its stop or target, the page's Flatten, an order in NinjaTrader). Its realized dollars are those
  executions' cash flow times the point value; below 0 is a losing trade. `pnlToday` is the sum of today's closed bot trades.
- **`bot-day.txt`** next to `config.txt` (lead's default) keeps the trading day's trades so a restart forgets nothing:
  `session<TAB>yyyy-MM-dd`, then `trade<TAB><entry tag><TAB>open` or `<realized dollars>`, written whole through a temp
  file. Executions replayed after a restart re-open a trade still open and never count one twice. A file that cannot be read
  is never written over and stands the bot down (no new entries) for that run. At 18:00 ET trades, losses and signal ids
  start over (a trade still open goes on into the new day).
- **Heartbeat lost** (5 s with no bot message): ChartBridge closes the bot's connection (it reconnects and says hello again),
  cancels its unfilled entries (only `bot` entries: never a stop, a target or another order), and every open proposal expires
  as `not answered` (the bot can no longer withdraw it; lead's default). The mode is kept. Pages get `bot` and a `status`
  `warn`; `/diag` counts `heartbeatLost`. The same when the bot disconnects, and whenever no bot has been connected for 5 s
  (after a restart a bot entry left working at the broker is cancelled then) (lead's default). Never a flatten.
- **Modes**: leaving `copilot` expires the open proposals as `not answered`; leaving `auto` cancels the bot's unfilled
  entries (lead's default). `auto` needs the bot's account to be tradable (gate 2: its checkmark or `tradeAccounts`) and
  Connected; since 2026-10-07 it need not be NinjaTrader's simulator (shown LIVE when it is not). The kill switch on also expires
  open proposals and refuses the bot's own `flatten` (the page's Flatten works as always).
- **Proposals**: `botAnswer` takes no order field (a `price` or anything else is an unknown key, refused). An accepted
  proposal that a rail or a gate refuses at that moment ends `rejected`, the bot gets `answer` `refused` with the reason and
  the page a `reject` naming it. A `withdraw` after an accept cancels the entry if it has not filled (`state` `withdrawn`).
- **Bot orders** are named `CB#1a2b3c4d bot s8 t16` for every kind (a resting one too); recovery reads them as v2 entries
  (ticks from each fill). The bot gets `order`, `exec` and `position` for its own orders and its account's position on its root;
  `tick` for every live trade on every served root.
- **`botRails`** (page to server, lead's default; Anthony: the rails can be changed in the Bot tab): `{type, cid (optional),
  maxTrades, maxLosses, root}`, all but `cid` required: `maxTrades` 1 to 5, `maxLosses` 1 to 3 (tighten only: never above the
  defaults; the quantity stays 1), `root` `botRoot` or its micro/mini sibling (MNQ and NQ, MES and ES), served and not quote
  only. Refused while the bot has a position or a working entry, and with `bot` off. Saved in `bot-rails.txt` next to
  `config.txt` (`maxTrades<TAB>n`, `maxLosses<TAB>n`, `root<TAB>ROOT` after two `#` lines, through a temp file); a file that
  cannot be understood stands the bot down until the page sets the rails again or it is deleted. Reported in `bot`
  (`maxTrades`, `maxLosses`, `root`, and `maxQty` 1) and in `welcome`, which is sent to the bot again after a change.
- **`GET /bot-library`** (lead's default): the bytes of the file `botLibrary` names (a plain file name in ChartBridge's folder,
  next to `config.txt`, or a full path; a `.json` file either way), read fresh on every request, as `application/json`,
  `Cache-Control: no-store`, no CORS headers. **404** while `bot` is off or the file is missing; **403** unless asked for as
  `Host: localhost:<port>` (as `/session`); **405** for a method other than GET or HEAD; **500** with
  `{"error": "..."}` when it is over 2 MB or is not valid JSON. Loopback only, as every request; never through Tailscale or the
  tunnel. ChartBridge checks only that it is JSON; the page lane owns its schema (`docs/BOT_LIBRARY.md`).
- **`client`**: lane B2 owns the v3 handshake (`ChartBridgeV3`; anything but `v` 3 gets a `status` `warn`). `bot`,
  `botSignal` and `botProposal` go to signed-in v3 pages only, in the order lane (with `welcome`, `botState` and `answer` to
  the bot). A v3 page that signs in gets `bot` and every open proposal.
- **`/diag` `bot`** (only with the switch on): `enabled`, `connected`, `mode`, `killed`, `trades`, `losses`, `signals`,
  `proposals`, `answered`, `notAnswered`, `placed`, `refused`, `heartbeatLost`, `secretFile`.
- **`bot.log`** next to `config.txt`: one line per signal, proposal outcome (`not answered` included), placement, trade and
  mode change, `<UTC ISO time><TAB><what>`. Never the secret.
- **Review 2: a `withdraw` while an accept is being placed** (finding 7): it is noted, and the entry is cancelled as soon as
  it is placed if it has not filled (`state` `withdrawn`, the bot's `answer` says so, `bot.log` "withdrawn during
  placement"). If it had already filled, nothing is cancelled (its stop and target stay) and the log says so.
- **Review 2: the bot's account as a copier follower** (finding 3): the bot refuses entries while its account is a copier
  follower that is on, the copier refuses the bot's account as a follower while the bot is on, and `botAccount` refuses a
  follower that is on or the leader (see the copier's review 2 notes).
- **Review 2: `by`** (finding 9): bot orders carry `"by": "bot"` on v3 pages only (see "Who placed it" under Orders).

### The order lanes together (0.4.0 integration)

The five order lanes (accounts, Order types and Order Strategies, Merge, the copier, the bot channel) run as one ChartBridge.
Where two lanes meet, these rules hold; each is a check in `nt8/check/IntegrationHarness.cs` (inside `check:orders`).

- **One v3 handshake, one v3 send, one switch store.** `client` goes to `ChartBridgeAccounts` only, which marks the page with
  `ChartBridgeV3.OnClient`; every lane asks `ChartBridgeV3.IsV3` and sends with `ChartBridgeV3.SendToV3Traders`. A page that
  signed in before its `client` message gets each lane's v3 state then (`copier`, `bot`, `managed`). Every v3 switch is read
  once from `config.txt` into `ChartBridgeSwitches`; `trading.switches` and each lane read that same value.
- **A bot order is never copied.** Only entries from ChartBridge's own page reach the copier's leader logic. With the copier on,
  the bot is refused on the copier's leader account ("Sim101 is the copier's leader: the bot does not trade the leader's
  account while the copier is on") **(lead's default)**: every exit on the leader is copied, so a bot position mixed into
  the leader's would shrink or flatten the followers.
- **A bot order is plain.** No Order Strategy and no `stopLimit` or `mit`, whatever the switches **(lead's default)**.
- **Merge on the copier's leader** is a leg change, never a new entry: nothing is copied by the swap, and a follower stop whose
  leader stop the swap cancelled follows the merged stop's price (within a second), then every later move of it.
- **Merge and Order Strategies.** Merge reads the strategy legs with the same name rule (`LegNameRx`, bucket `k`), the shares
  from the strategy's own record and the one allocation rule. Breakeven and trailing are paused on the account and root from
  before the stop prices are read until the swap ends. After a swap that ran (`merged`, `restored` or `failed`), the managed
  entries on that account and root are no longer managed: every stop stays where it is, nothing moves it again, and `managed`
  says so (`state` `unmanaged`, with the reason) **(lead's default: the pairs they followed are gone, and the contract gives a
  merged stop no breakeven or trailing)**.
- **The copier and Merge never act on one account (lead's default).** The copier closes, shrinks and moves a follower's
  orders on its own (its "flatten this follower" goes to NinjaTrader directly and would not end a swap). So while the copier
  is on, Merge is refused on a follower that is on ("SIM-G is a copier follower: Merge is refused on it while the copier is
  on (the copier manages its orders)"), and on a follower that is off while the copier still has something of its own there
  (a copied position, a copier entry, stop or close that may fill, a reduce or a wait: "SIM-G is a copier follower (off) that
  still holds a copier position or orders: Merge is refused on it until the copier's part there is flat and done (the copier
  manages those orders)"). 0.6.4 (WORK 2026-10-19: the page lists every account as a follower row, so before 0.6.4 Merge was
  refused on every account while the copier was on): an off follower with nothing of the copier there merges as any account.
  An account with a Merge running cannot become a follower until the swap ends. The copier's leader may merge (above).
- **The copier and Order Strategies.** A strategy entry's stop counts for the copier's stop rule. Each fill increment is copied
  once, for its whole quantity; the followers' stops follow the stop of the increment's last bucket (all of an increment's
  stops are at one level and move together), so breakeven and trailing move the followers' stops to the leader's new price.
#### The bot channel as built, and the page's side (chart 1.16.0)

What ChartBridge 0.4.0 built (`ChartBridgeBot.cs`, lane B3) where the tables above leave a detail open, and what the Bot
tab (`live/bot.js`, lane C4) does with it. The page follows the C#; `test/fake-v3.mjs` does the same.

- **`botRails`** (page to server): `cid` (optional), `maxTrades`, `maxLosses`, `root` (no others; the three required).
  `maxTrades` a whole number from 1 to 5 and `maxLosses` from 1 to 3 (ChartBridge's own limits: the page may lower the
  rails and put them back up to these, never above), `root` botRoot or its micro or mini sibling (MNQ and NQ, MES and ES).
  Refused while the bot has a position or a working entry ("the bot has a position or a working entry: change its rails
  when it is flat"), with the bot switch off, and like every `bot*` page message without the signed-in own page or over
  gate 7's rate. ChartBridge saves them in `bot-rails.txt` next to `config.txt`, so a restart and a new trading day keep
  them (there is no 18:00 reset of the rails; trades and losses start over at 18:00 ET); a file it cannot read stands the
  bot down until it is fixed or deleted. `bot` (`maxTrades`, `maxLosses`, `root`, and `maxQty` 1) and `welcome` carry the
  rails in force. The Bot tab offers exactly these (Change the rails), only while the bot is flat.
- **The bot's orders on the page.** ChartBridge names them `CB#1a2b3c4d bot s8 t16`, legs as v2, and (review 2) a v3 page's
  `order` message carries `by: "bot"` for a bot entry and the legs the bot channel follows (`by: "copier"` for the copier's
  follower orders). The Bot tab takes as the bot's only the orders marked `by: "bot"` (its lines, its working entry, stop and
  target). A fill (`exec`) carries no `by`, and its `order` is NinjaTrader's id, not the page's, so the page claims a fill for
  the bot only against the contracts its marked orders are seen to fill (account, root, side and quantity, at the
  increment's price when known; `BotCore.botFillLedger`) (lead's default). Anthony's own orders on the bot's account and root are
  his, not the bot's. `test/fake-v3.mjs` sends `by` as the C# does.
- **`welcome.instruments`** is the bot's own root only: `{root, name, tick, pointValue, quoteOnly}`.
- **`GET /bot-library`** (lead's default): the frozen Bot-Lab builds for the Bot tab's Library, one local JSON file
  (`botLibrary` in `config.txt`, default `bot-library.json`) served as it is (`Content-Type: application/json`,
  `Cache-Control: no-store`). This PC only, as every request; the page sends the PIN unlock header (`X-ChartBridge-Unlock`)
  as for `GET /session`. No file, or the bot switch off: `404` (the page says "No frozen builds on this PC"). ChartBridge
  never reads anything from the file and never sends it anywhere: it carries no order, rule program or secret. The file's
  shape is `docs/BOT_LIBRARY.md`; a made-up example is `test/fixtures/bot-library.json`.
- **Copilot's one-key Accept and Reject**: The Desk's hotkeys document's `accept` and `reject` (no default key), set in
  the workspace's Settings with the other trading keys. The workspace's hotkey handler fires a cancelable
  `chart-copilot-key` DOM event (`detail.answer` `accept` or `reject`); the Bot tab is its one handler (the oldest open
  proposal). The buttons always work, and `botAnswer` is the same either way; `bot.html` has the buttons only.
- **The bot's account on the page** (Anthony 2026-10-07): the Bot tab shows the account from `bot` (`account`, `sim`) plainly,
  with a SIM or LIVE mark (LIVE in the house red of the Armed warning, never animated) next to the mode, in the strip, in the
  pop-out (`bot.html`) and on every copilot proposal (the proposal's own `account` and `sim`). The bot panel's Change account
  lists the accounts the v3 `accounts` message says are tradable now (`BotCore.accountChoices`), each marked; choosing a LIVE
  one asks once in the page ("The bot will trade LIVE account X. Continue?"), never a browser `confirm()`, then sends
  `botAccount` (`BotCore.botAccountChange`). ChartBridge's refusal is shown under the button. The mode button reads Auto (not
  "Sim auto"). The Copier tab marks every follower SIM or LIVE and offers real accounts too.

### Agent channel (`agents`, 0.5.0)

Contract v1 of 2026-10-08 (written by the lead for the four builders: ChartBridge, the page's Agent tab, The Desk and the
agent runner). AI trading agents (the first is "Manrae"; any number may follow, each with its own rules) trade through
ChartBridge inside per-agent rules that ChartBridge enforces. Built in `nt8/ChartBridgeAgents.cs`.

Rulings this rests on (Anthony):

- 2026-10-08: rules are per agent or bot inside ChartBridge, never blanket; universal: the owner lock, long or short only.
- 2026-10-08: Manrae's size ceiling is 2 NQ or 20 MNQ; no other caps (Lucid enforces its own limits).
- 2026-10-08 (late): "the first (of many) agents": the channel serves any number of agents, each with its own rules.
- 2026-10-08 (late, four answers): (1) an agent's account is chosen like the bot's: on the page, Sim101 until chosen, a LIVE
  account asks once in the page; each agent has its own account: never the bot's, never a copier leader or follower, never
  another agent's. (2) At the flat time ChartBridge flattens the agent's position itself, even with the agent program gone (a
  deliberate exception to the bot channel's "ChartBridge never flattens"). (3) Owner lock: while an agent has a position or a
  working entry on its account and root, new entries from anyone else are refused; Anthony's Flatten, cancels and stop or
  target moves always work. (4) A copilot proposal stays open until the plan's own entry expiry (not a fixed TTL).
- Standing: AI is never in the order path. ChartBridge places every agent order itself, from the plan's parameters, inside
  the agent's rules, whatever the agent sends. Entries are limit or stop-limit only, always with a stop and a target.

**Agents and their files.** `config.txt`: `agents = manrae` (a comma list of ids; absent or empty: the channel is off and
`/agent/...` answers 404). An id is 1 to 12 characters, `a-z` and `0-9`, starting with a letter. Per id, next to `config.txt`:
`agent-<id>-secret.txt` (two `#` lines, then 64 hex characters, made by ChartBridge on first start, as `bot-secret.txt`),
`agent-<id>-account.txt` (two `#` lines, then `account<TAB><name>`; no file: None, saved as `account<TAB>-`, 0.5.7; until 0.5.6 Sim101), `agent-<id>-rules.txt` (two `#`
lines, then `key<TAB>value` lines; no file: the defaults), `agent-<id>-day.txt` (`session<TAB>yyyy-MM-dd`, then one line per
trade, as `bot-day.txt`), `agent-<id>.log` (`<UTC ISO time><TAB><what>`: plans, proposals, placements, refusals, trades, mode
changes). Files are written whole through a temp file. A file that exists but cannot be understood is never written over and
stands that agent down (no new entries) until the page fixes it or the file is deleted; a secret file that cannot be read
refuses every connection for that id. The secret is never printed (Output window, `/diag`, logs, pages).

**Files and power cuts (0.6.3, audit C3).** Every state file ChartBridge writes whole (the agents' rules, account and day,
`agent-standdowns.txt`, `groups.txt`, `account-marks.txt`, `daily-reset.txt`, `accounts.txt`, the bot's rails, account and day,
`copier.txt`, `managed.txt`, `planned_brackets.txt`, the merge marker) goes to a temp file opened write-through and flushed to
the disk (`Flush(true)`) before it replaces the file, and the copy it replaces is kept as `<file>.bak`. An append to a day file
is written through and flushed the same way. So a power cut leaves the old file or the new one, never a file of zeros. A file
that reads but is not understood falls back to its `.bak` on its own only for ChartBridge's own records, `daily-reset.txt` and
`account-marks.txt` (logged and a `status` `warn` to the pages: "<file> could not be read (<why>): ChartBridge uses its last good
copy (<file>.bak) ...", also to every page that signs in later that run). Review MED 3: the files that hold Anthony's choices
(an agent's account and rules, `agent-standdowns.txt`, `groups.txt`) never take their `.bak` on their own: the agent stands down
or the file is unreadable exactly as in 0.6.2 (no new entries; exits always work), and when the `.bak` is understood the alarm
to the pages says what it holds and how to use it ("agent-<id>-account.txt has a line ChartBridge does not understand (its
last good copy, agent-<id>-account.txt.bak, names account <name>: choose it again on the Agent tab, or copy
agent-<id>-account.txt.bak over agent-<id>-account.txt and restart ChartBridge)"; the rules name their roots, window and
limits; the stand-downs name each build and group; groups.txt names its groups and how many accounts, "to go back to it, copy
groups.txt.bak over groups.txt"). Choosing the account or setting the rules again on the Agent tab is the page's way back.
Review MED 5: a replace cut off between its steps can leave **no file with a copy beside it** (`<file>.bak`, or the
`<file>.tmp` that was about to replace it). `daily-reset.txt` and `account-marks.txt` then use that copy on their own, said so
("account-marks.txt is missing (a save cut off?): ChartBridge uses account-marks.txt.bak and writes the file again"). An
agent's day file uses it only when it is today's session (MED 2), said so, and is written again. For the files of Anthony's
choices a missing file with an understood copy is not "no file": the agent stands down (or groups.txt is unreadable) with the
alarm "<file> is missing (a save cut off?) but <copy> is there and <what it holds>: <how to use it>, or copy <copy> to <file>
and restart ChartBridge; to start with no file, delete <file>.bak (and <file>.tmp) and restart ChartBridge; choosing on the
Agent tab clears this too (it writes <file> again)" (review round 2, LOW E; the stand-downs have no Agent tab choice).
**A day file** (`agent-<id>-day.txt`) with lines it cannot read (NULs, a half line, a line it does not know) or no session
line keeps every line that reads, and fills what it lacks from its `.bak` (review MED 2: only a `.bak` of the same session,
the file's own, or today's when the file's session line is the damaged one; a copy of another session is ignored): today's trades, losses and plan ids are never
reset. The agent stands down for this run only ("agent-<id>-day.txt has N lines ChartBridge could not read (a power cut?): the
trades, losses and plan ids from the lines that read ... are kept and the file is written again from them: no new entries for
agent <id> this run: check today's trades in NinjaTrader (the next start goes on with these counts)", an alarm to the pages);
the file as it was is kept as `agent-<id>-day.txt.unreadable` and the day file is written again at once from what was kept, so
the next start reads it whole (review LOW 11: the damaged file is moved out of the way first, so it never becomes the new `.bak`
and the good `.bak` is kept). The alarm no longer says to delete it.
**A file held open (0.6.3, audit C4).** An agent's rules, account or day file, or `agent-standdowns.txt`, that exists but
cannot be opened at the start (an IOException: Defender, a backup tool or OneDrive holding it while NinjaTrader starts) is
"not read yet": no new entries meanwhile ("<file> could not be read yet (<why>): no new entries for agent <id> until it is read
(ChartBridge tries again; exits always work)"; for the stand-downs, every agent entry on an account in a prop group, as when it
cannot be read, and a raise made meanwhile is kept and saved once it reads). It is read again on every 500 ms check; after a
minute the pages get the alarm ("... could not be read for a minute ... ChartBridge keeps trying ...") and it is tried every 5 s
from then. Review LOW 6: a day file read after a wait keeps what was booked in memory meanwhile (a trade that ended, a plan id,
a loss stand-down of that session) and saves it, as the stand-downs keep a raise. Review LOW 7: the account file read after a wait can change the agent's
account only from the None it had while unread; once Anthony chooses an account on the page meanwhile, the wait ends and the
file is not read again: his choice stands, and if the file then names another account the pages get an alarm (ChartBridge never
switches it on its own). Once a read succeeds the stand-down is gone by itself (logged, and a `status` `info` to the pages if the alarm went).
A file that reads but is not understood is not retried (above).

**Connection.** `ws://localhost:<port>/agent/<id>`. Loopback only (as every request), **no** `Origin` header (any `Origin`:
403), header `X-ChartBridge-Agent: <secret>` (constant-time compare; wrong or missing: 403), 400 for a non-upgrade, 404 for an
id not in `agents`, 409 while that id is connected. Ids are independent: two agents connect at once. The first message is
`agentHello`; anything earlier gets `reject` "send agentHello first". The answer is `welcome`, then `agentState`, then a
snapshot (contract additions, 2026-10-08): one `position` for each root in `welcome.instruments` on its account (a flat one
included) and one `order` for each working order of the agent's own on those roots (entries, stops and targets), ending with
`{"type":"snapshot","roots":[...]}` (the same roots), after every `agentHello`. `welcome.instruments` lists only the roots
ChartBridge serves at that moment (NinjaTrader connected, the contract found). A runner without a complete snapshot is "not
ready" (no plans; it reconnects after 30 s), which is not a stand-down. Every start
of ChartBridge puts every agent in `shadow`; `auto` never survives a restart. 0.6.3 (audit C5, Anthony's decision): **the kill
switch does survive a restart.** `agentKill` on writes `agent-<id>-kill.txt` (two `#` lines, then `killed<TAB><UTC ms>`), one
per agent; `agentKill` off removes it (a release whose file cannot be removed is refused: "agent-<id>-kill.txt could not be
removed (...): the kill switch stays on"). Only the page's kill message writes or removes it. At every start a file that is
there (even one that does not read, or one held open: it is read again on every check, as the agents' files, review of C5)
is the kill switch on: the Output window says "agent <id>: its kill switch is still on (on
since <time> UTC; kept through the restart) ...", `welcome` carries `"killed": true`, `agentState` carries `killed` true, and the page's `agent`
rows carry `killed` and `killedAt` (UTC ms, null when not known or not killed), and the Board and the agent's desk show "kill
switch on since <time>" until Anthony releases it. A kill that cannot be saved still holds in memory and the pages get a
`status` `warn` that a restart would release it. Going back to 0.6.2 (review LOW 10): 0.6.2 ignores the kill files, so a kill
released while 0.6.2 runs is still in the file and comes back on when 0.6.3 starts (release it on the page then). Heartbeat: any message counts; `beat` at least
every 2 s when idle. 5 s of silence (or a disconnect, or no connection for 5 s after a start): ChartBridge closes the socket,
cancels that agent's unfilled entries, expires its open proposals as `not answered`, keeps any position's stop and target and
warns the pages. The flat time still runs. Limits: 10 messages a second (`beat` not counted), 64 KB a message. Strict parser
(gate 8): one flat JSON object, no nesting, no unknown or duplicate keys, plain strings (no backslash, no control characters)
of at most 200 characters, except `note.text` (at most 1,000). The runner cleans model text before sending (quotes to `'`,
newlines to ` / `, backslashes and control characters dropped, cut to length).

**The rule set** (per agent; set on the page; the agent can never change it):

| key | Manrae's default | allowed values |
|---|---|---|
| `roots` | `NQ,MNQ` | traded, served, not quote-only roots |
| `maxQty.<ROOT>` | `NQ 2`, `MNQ 20` | 1 to the hard ceiling: minis (NQ, ES) 2, micros (MNQ, MES) 20. The ceiling is a ChartBridge constant (`ChartBridgeAgents.HardCeiling`): raising it is a code change and a review |
| `entryFrom` / `entryUntil` | `09:45` / `15:00` | New York time, `HH:MM`, in session order (0.5.2): the session runs from 18:00 to 17:00, so `entryFrom` may be any time from 18:00 and `entryFrom` comes before `entryUntil` in the session (18:00 to 15:25 runs across midnight; 15:30 to 09:00 goes the wrong way round and is refused). Until 0.5.1: from 09:30, on one calendar day |
| `flatAt` | `15:55` | after `entryUntil` in session order, at most 15:59 |
| `maxExpireSec` | `1800` | 60 to 1800 |
| `maxTrades` | none | none, or 1 to 50 a day |
| `maxLosses` | none | none, or 1 to 20 losing trades a day (stand down) |

Fixed for every agent: limit or stop-limit entries only; a stop and a target on every entry; one position and one entry
(working or proposed) at a time; long or short (NinjaTrader accounts net); the owner lock. While the agent has a position, a
working entry or an open proposal, `agentRules` from the page may change only the window (`entryFrom`, `entryUntil`,
`flatAt`; 0.5.4, Anthony 2026-10-10: "I do not want to be locked out of changing the time ... during live trading"); a change
of any other rule then is refused ("only its window (entries from, until, flat at) can change now; change its other rules when
it is flat"). The new window rules at once: a flat time already passed, or a start after now, puts the agent in its flat hours
and its position is flattened by its rules; an entry or a proposal outside it ends as at the window's end. While its
`agent-<id>-rules.txt` cannot be read (the rules in force are then placeholder defaults), nothing changes while it is exposed,
not even the window. A change is saved, logged and sent to the agent in a new `welcome`.

| agent to ChartBridge | fields (no others) | notes |
|---|---|---|
| `agentHello` | `name` (1 to 40), `build` (1 to 40) | first message |
| `beat` | none | |
| `subscribe` | `root`, `days`, `tickHours`, `sub` (as the page's) | answered as for a page: `history`, `ticks`, `ready`, then live `tick` for that root (the agent gets live `tick` for every served root anyway) |
| `plan` | `id` (1 to 40, unique per agent per trading day), `root`, `side` (`buy`/`sell`), `kind` (`limit`/`stopLimit`), `price`, `limitPrice` (stopLimit only, and then required), `qty`, `stopTicks`, `targetTicks`, `expireSec`, `riskDollars`, `setup` (1 to 40), `reason` (1 to 200), `confidence` (0 to 1); 0.6.0: `seatsRev` and `sizes` ("Group trading (0.6.0)") | one entry plan; checked, then by mode: logged, proposed or placed |
| `skip` | `id`, `setup` (optional), `reason` | a decision not to trade; logged and shown |
| `withdraw` | `id`, `reason` | expires an open proposal, cancels an unfilled entry |
| `note` | `kind` (`look`, `thinking`, `lesson`, `notebook`, `status`), `text` (1 to 1,000) | display only, never the order path; the last 200 per agent are kept for pages that sign in later |
| `flatten` | `account` (optional, 0.6.0: one seat; without it, every seat) | auto only, not while killed: cancel the agent's orders on its account and root, then market out |

| ChartBridge to the agent | fields | when |
|---|---|---|
| `welcome` | `version`, `agent`, `mode`, `account`, `sim`, `rules` (`{roots: [..], maxQty: {ROOT: n}, entryFrom, entryUntil, flatAt, maxExpireSec, maxTrades, maxLosses, maxBracketTicks, maxTicksAway}`, null for none; `maxQty` per root is the cap really enforced: the smallest of the agent's rule, the hard ceiling and `config.txt`'s gate 3 cap for that root, its default of 1 included (0.5.3: for MNQ always the agents' own 20, never `maxQty.MNQ`); `maxBracketTicks` and `maxTicksAway` are `config.txt`'s, null when not set), `instruments` (`[{root, name, tick, pointValue}]` of its roots ChartBridge serves now) | after `agentHello`; again after any rules, account or mode change, and whenever an enforced cap changes |
| `agentState` | `mode`, `killed`, `standDown` (null or why), `trades`, `losses`, `pnlToday`, `owns`, `session` (`yyyy-MM-dd`, ChartBridge's 18:00 ET session date; compare counters only within one session) | after `agentHello`, and again whenever any field changes (`owns` recomputed on every order and position change of its account and roots) |
| `accountState` | the agent's account in real numbers: `account`, `sim`, `kind`, `group`, `groupId`, `groupSide`, `noHedge`, `rules`, `balance`, `pnlToday`, `realizedToday`, `unrealized`, `floor`, `roomFloor`, `roomDaily`, `targetLeft`, `src`, `why`, `session`, `at` (0.5.8: "Prop groups and account state") | after the snapshot on every `agentHello`; again when any field but `at` changes, and at once on an account, group or rules change |
| `tick`, `history`, `ticks`, `ready` | as the page's | |
| `order`, `exec`, `position` | as the page's: `order` for its own orders, `position` for its account on its roots, `exec` for its own fills and, while it owns a pair, for every fill on its account and that root, its own or not (Anthony's Flatten or a close made in NinjaTrader arrives as `role` `other`, `cbId` null when the order is not ChartBridge's). `order` adds `orderName` (NinjaTrader's own order name: `CB#<tag> ag:<id> s<n> t<n>` for an entry; its legs are v2's, `CB#<tag> stop f<n> q<n> p<price>` and `CB#<tag> target f<n> q<n> p<price>`, no `ag:`, matched by the entry's tag; `CB#<tag> ag:<id> flat`; `CB#<tag> ag:<id> protect f<n>`; `CB#<tag> ag:<id> stop p<price>` for its stop placed again over a shut market; `name` stays the instrument), and `order.role` is `flat` for its flat-time close, `protect` for its protective exit and `stop` for the stop placed again (0.5.7: never `planId`, which is the page's). `exec` adds `cbId` (ChartBridge's order id, `o12`, or null when the order is not ChartBridge's) and `role` (`entry`, `stop`, `target`, `flat`, `protect` only for the agent's own orders: `ag:<id>` in the name, or legs carrying its entry's tag; `other` for every other order, a page's included) | |
| `snapshot` | `roots` (the roots of `welcome.instruments`) | the last message of the snapshot after `agentHello` |
| `answer` | `id`, `answer` (`proposed`, `accepted`, `rejected`, `not answered`, `placed`, `expired`, `withdrawn`, `refused`), `text` | each step of a plan's life |
| `reject` | `id` (or null), `reason` | any refused message, rule or gate |

**Checks on `plan`, in this order, in every mode** (the first that fails: `reject` to the agent, `agentPlan` with `result`
`refused: <why>` to the pages, one log line):

1. Strict message; `id` new today for this agent.
2. Not killed, not stood down, the account file and rules file readable, the account tradable now (gate 2, Connected). 0.6.2: and no stand-down of its build on its group, `agent-standdowns.txt` readable, and a league seat's account Sim ("Group stand-downs and league seats (0.6.2)").
3. `root` in `roots`; `kind` `limit` or `stopLimit` (`market`, `stop`, `mit` refused).
4. `qty` a whole number from 1 to `maxQty.<root>`; `stopTicks` and `targetTicks` whole numbers of 1 or more.
5. `riskDollars` equals `stopTicks` x tick x point value x `qty` within $0.01.
6. `expireSec` from 60 to `maxExpireSec`.
7. The market open (0.5.2: not the 17:00 to 18:00 break, Friday 17:00 to Sunday 18:00, a CME holiday, or after the halt on an
   NYSE holiday (13:00) or early close (13:15), as `ChartBridgeCme.Closed`; refused as "the market is closed now ...") and the
   New York time now from `entryFrom` up to (not including) `entryUntil`, in session time: minutes since the 18:00 open, so
   18:00 is 0, midnight 360 and 17:00 1380 (refused as "outside agent <id>'s entry window (18:00 to 15:25 New York time)").
8. One at a time: no position for this agent, no working agent entry, no open proposal.
9. `maxTrades`, `maxLosses` when set.
10. The owner lock.
11. Price (v2 gate 5): on the tick grid; last trade under 300 s old. LIMIT: a buy at or below the last trade, a sell at or
    above. STOP-LIMIT: a buy's `price` above the last trade and `limitPrice` from `price` up to 20 ticks above it; a sell's
    `price` below the last trade and `limitPrice` from `price` down to 20 ticks below it.
12. Then by mode. `shadow`: logged and shown, nothing placed, no `answer` (the pages get `agentPlan` with `result` `shadow`).
    `copilot`: a proposal (`answer` `proposed`). `auto`: placed (`answer` `placed`).

**Placing** (auto, or an accepted proposal): every check runs again at that moment (a refusal ends the proposal `rejected`
with `answer` `refused`). The entry is named `CB#<tag> ag:<id> s<stopTicks> t<targetTicks>`, `TimeInForce.Day`; its stop and
target are v2's bracket from each fill's own price (OCO, GTC), named as v2's legs with the entry's tag (`CB#<tag> stop ...`,
`CB#<tag> target ...`), so the legs check, the missing-stop alarm and restart recovery cover it, and a runner knows its legs by
the tag from the entry's `order` message even before the entry's `exec`. The orders ChartBridge places for the agent are named
with `ag:<id>`: the flat-time close `CB#<tag> ag:<id> flat`, the protective exit `CB#<tag> ag:<id> protect f<n>`. v3 pages see
`by: "agent:<id>"` on its orders and legs. 0.5.7 (DECISION 2026-10-14d, phase 2): and `planId`, the plan's `id`, on its
entry, its legs and its flat close (each carries the entry's tag; the stop placed again over a shut market too), from the
entry's first `order` message on, so the page takes R from that plan's own `riskDollars`; no plan known (an entry ChartBridge
did not place for a plan, a day file from before 0.5.7): no `planId`, and the page matches the plan by root, side, kind,
size, price and ticks as before. Kept across a restart in the day file (`#tagplan<TAB><tag><TAB><id>`).

**Expiry.** A plan's entry lives `expireSec` from the moment ChartBridge received the plan. A proposal stays open until then
(ruling 4); accepted later, the entry works only the time left (under 5 s left: refused as `expired`). ChartBridge's own timer
cancels an unfilled entry at expiry (`answer` `expired`) and at `entryUntil`, whatever the agent does. A part-filled entry's
rest is cancelled the same way; the filled part keeps its legs.

**Window and flat time** (working with the agent gone). At `entryUntil`: the agent's unfilled entries are cancelled and its
open proposals expire. At `flatAt` (ruling 2): every working order of the agent on its account and roots is cancelled (entries
and legs), then its position is closed at market; logged, and the pages told (`status` `info` "<id> flattened at 15:55 by its
rules"). Not flat 10 s later: `status` `error` to the pages, every 10 s until flat. ChartBridge's protective market exits and
this flatten are the only market orders on an agent's behalf: "never market" is about entries. The day file and the counters
start over at 18:00 ET (as the bot's).

**The owner lock** (ruling 3). For each (account, root) ChartBridge knows an owner: the source of the working entries and the
position (`page`, which includes orders placed in NinjaTrader itself, `bot`, `copier`, `agent:<id>`). The owner is set by the
first entry that works or fills on a flat (account, root) with no working entry, and clears when the position is flat by both
readings and no entry works there. Built (the lead's scope, the ruling's question): while the owner is an agent, every new
entry from another source is refused (from the page: "<account> <root> belongs to agent <id>: use Flatten, or move its stop or
target"; from the bot, the copier or another agent: "<account> <root> belongs to agent <id> until it is flat"); an agent's entry
is refused while the owner is anyone else. Exits always pass: Flatten, cancel, moving or cancelling a stop or target, the legs
check, the protective exit, and a page market order that only reduces (see as built). Between `page`, `bot` and `copier` the lock changes nothing yet (a separate decision for Anthony).
`agentState.owns` and the page's `agent` strip show it.

**Accounts** (ruling 1). `agentAccount` is refused, in plain words, for the bot's account, the copier's leader or any follower
(on or off), another agent's account, an account not tradable now, while this agent has a position, a working entry or a
proposal, and while the old or the new account holds any position or working order on the agent's roots (as `botAccount`).
Conversely the bot, the copier and other agents refuse an agent's account. A LIVE account asks once in the page (never
`confirm()`).

| page to ChartBridge (signed-in v3 pages, gate 7's rate) | fields (no others) |
|---|---|
| `agentMode` | `cid` (optional), `agent`, `mode` (`auto` needs the account tradable; the page asks a second click within 4 s for Auto and to release Kill; Kill itself takes one click, as for the bot (Anthony, 2026-10-08)) |
| `agentKill` | `cid` (optional), `agent`, `on` (*bool*) |
| `agentSeen` | `agent`, `id`, `at` |
| `agentAnswer` | `cid` (optional), `agent`, `id`, `answer` (`accept`/`reject`), `at` |
| `agentAccount` | `cid` (optional), `agent`, `account` (0.5.7: `null` is None) or (0.6.0) `group` (a group id: every member a seat; never both), `keepMode` (optional, 0.5.2: `shadow`, `copilot` or `auto`, the mode the page's question named; a 1.18.1 page sends it only to ChartBridge 0.5.2 or later, because 0.5.1 refuses a key it does not know), `league` (optional, 0.6.2: true makes the one account a league seat, Sim only) |
| `agentRules` | `cid` (optional), `agent`, `roots`, `maxQtyNQ`, `maxQtyMNQ`, `maxQtyES`, `maxQtyMES` (each optional), `entryFrom`, `entryUntil`, `flatAt`, `maxExpireSec`, `maxTrades` (0 = none), `maxLosses` (0 = none) |

| ChartBridge to page | fields | when |
|---|---|---|
| `agent` | `agent`, `name`, `build`, `enabled`, `connected`, `mode`, `account`, `sim`, `rules`, `position` (`{root, qty, avgPrice}` or null), `pnlToday`, `trades`, `losses`, `killed`, `standDown`, `owns`, `lastBeatMs`, `lastPlan` | after `auth`/`client`, on every change, once a second while connected |
| `agentPlan` | `agent`, `id`, `at`, `action` (`plan`/`skip`), the plan's fields, `result` (`shadow`, `proposed`, `placed`, `refused: <why>`, `skipped`) | each plan or skip |
| `agentProposal` | `agent`, `id`, `at`, `account`, `sim`, the plan's fields, `expiresAt` (UTC ms), `state` (`open`, `accepted`, `rejected`, `withdrawn`, `not answered`, `expired`), `seenAt`, `answeredAt` | when proposed and at each change |
| `agentNote` | `agent`, `at`, `kind`, `text` | each note |

A v3 page that signs in gets every agent's `agent`, its open proposals, its last 200 notes and its last 50 plans. `/diag`
`agents` (only with the channel on): per id `connected`, `mode`, `killed`, `plans`, `proposals`, `placed`, `refused`,
`heartbeatLost`, `flattenedAt`, `secretFile`. 0.6.2: and `league` (true for a league seat, false otherwise; the welcome's own flag, never an account name). These messages ride the order lane (never behind market data).

**Fills to The Desk.** ChartBridge's fills to The Desk (`POST /api/fills`, `postFills = true`) add `by` when ChartBridge knows
the source: exactly `agent:<id>`, `bot` or `copier`; no `by` key at all otherwise (The Desk refuses any other value, an empty
string included). Every other byte of the fill is as before. The agent runner's day record (`POST /api/agents/day`) is the
runner's and The Desk's (contract section 8), not ChartBridge's.

#### Agent channel as built (ChartBridge 0.5.0, `nt8/ChartBridgeAgents.cs`)

One `ChartBridgeAgent` object per id (`ChartBridgeAgents.Get(id)`), never one static slot. Tests: `nt8/check/AgentHarness.cs`
(Mono, inside `npm run check:orders`), `IntegrationHarness.cs` X13, `test/nt8-agents.test.js` (source guards) and
`test/fake-agent.test.js` with the made-up client `test/fake-agent.mjs` (no real agent's logic anywhere in this repository).
Where the contract left a detail open, the safest simple choice was taken and is marked **(lead's default)**:

- **Ids** (lead's default): an id that breaks the rule is left out with one Output line; a repeated id counts once.
- **The upgrade's order** (lead's default): 404 for an unknown id (or the channel off) first, then 403 for any `Origin`, 403 for
  a wrong or missing secret, 400 for a non-upgrade, 409 while connected; the address check (loopback) runs before all of it.
- **agentHello first** (lead's default): before it nothing is read, a `beat` included; it is never shown to the pages or logged
  as a plan. A socket that sends nothing, or never says hello, is closed after 5 s and frees its id. A second `agentHello`
  gets `welcome` and `agentState` again (name and build updated).
- **Strict parser** (lead's default): key names at most 40 characters; numbers plain (no sign, no exponent, no leading zero, at
  most 15 digits and 10 decimals). **The rate is counted first**: every message but `beat` (notes, subscribe, malformed and
  refused ones included) counts toward the 10 a second before anything else is done with it; one over the rate does nothing
  but answer `reject` (at most one such `reject` a second).
- **subscribe** (lead's default): `root` required; `days`, `tickHours` and `sub` whole numbers, the page's defaults when left
  out and clamped as the page's (1 to 60, 0 to 48). The subscribed root's trades reach the agent through the seam (held during
  its load, as a page's); every other root's straight. An agent's load counts as a page loading for the one-at-a-time gate.
- **Check 1** (lead's default): every field present and of its kind (`side` too); `limitPrice` is checked with the kind (check
  3). **Every plan id seen today is used, refused or not.** A refusal for an id already used goes to the pages as its own
  `agentPlan` and never replaces the plan that id first named (sign-in replay, `lastPlan`). Each new id is appended to the day
  file as one `plan` line (the file is written whole only at the roll and when a trade, an entry or the stand-down changes).
  Refused plans reach the pages at most once a second per agent: the next one shown says "(and N more refused plans in the
  second before, not shown)"; every one is still logged and answered to the agent. When no plan follows, the timer shows the
  latest one held back, with the count of the rest, within about a second (reviewer B). The append and the whole write of the
  day file share one lock, so an appended id is never lost; a write that meets a sharing violation (a virus scanner, a backup)
  is tried 3 times 25 ms apart, then logged.
- **Check 2** (lead's default): also trading on (gate 1), the account listed by NinjaTrader (an account it no longer lists is
  refused), Connected, not Gone, and the account not clashing (below).
- **Check 3** (lead's default): `root` is compared upper-cased, and must be served and not quote only; a `stopLimit` plan is
  refused plainly while `orderTypes = off`.
- **Check 4** (lead's default): `config.txt`'s gate 3 cap (`maxQty.<ROOT>`) and `maxBracketTicks` still hold for agents: the
  smallest of the agent's `maxQty`, the hard ceiling and the cap.
- **The agents' MNQ cap** (ChartBridge 0.5.3, Anthony 2026-10-10): the cap of 20 ships with ChartBridge, so any PC can run an
  agent at its full plan (20 MNQ) with nothing set by hand. Gate 3's config cap for an agent's MNQ entry is always 20
  (`ChartBridgeAgents.ShippedConfigCap`, through `ChartBridgeOrders.AgentCap`): `config.txt`'s `maxQty.MNQ` is never read
  for agents. The agent's MNQ entry is capped by the smallest of its own rule (Agent tab, default 20), the hard ceiling (20)
  and that 20. The page's, the bot's and the copier's MNQ caps are as before: the `maxQty.MNQ` line, or 1 with no line.
  Every other root for agents is as before too (`config.txt`'s cap, 1 with no line). With agents on and a `maxQty.MNQ`
  line, ChartBridge says once at start in the Output window that the line caps the page, the bot and the copier only.
  ChartBridge never writes `config.txt`; nor do the installer and the updater.
- **A page exit from an agent's position** (0.5.3 review): a page market order that only reduces an agent's position (the
  owner lock's exit: no bracket, no strategy, the other side, at most the smaller reading) skips gate 3's per-order qty
  check, and gate 3's position count (position plus working orders on that side plus this order) is held to that agent's
  cap (`ChartBridgeOrders.AgentExitCap`: its rule, the hard ceiling, MNQ 20; or the position when that is larger), never
  below the page's own cap. So with no `maxQty.MNQ` line the page may sell 5 of an agent's 20 MNQ in one order. Re-review:
  the exit plus the page's exits still working on that side (orders that are no bracket leg or merged set) may close at most
  the position, read again at gate 3 (both readings on the other side, else 0), so two quick exits never flip it: "this exit
  would close <n> <ROOT> contracts (working exits <w>, this order <q>) of agent <id>'s position of <held>: an exit closes at
  most the position (use Flatten to close it all)". More than the position, or an add, is no exit: the owner lock
  refuses it (never trimmed to the position).
- **The words of a size refusal** (0.5.3 review): gate 3 and plan check 4 name the cap that applied
  (`ChartBridgeAgents.CapWords`): `agent <id>'s maxQty for <ROOT>` when the agent's rule is below the hard ceiling, else
  `the hard ceiling of <n> for <ROOT>`; `maxQty.<ROOT> in config.txt` only for a root with no shipped cap whose line is
  lower (never MNQ for an agent); an exit's count says `an exit from agent <id>'s position: ...`.
- **Check 7** (lead's default): New York time of day, any day (a closed market's stale last trade refuses at check 11).
- **Check 8** (lead's default): "a position" is the agent's open trade or any pair it still owns.
- **Check 10** (lead's default): an agent enters only where its account and root hold no position by either reading (any
  contract month) and no order that may fill, its own leftover legs included.
- **Answers** (lead's default): `placed` carries the ChartBridge order id in its text ("placed on Sim101 as order o12"); an
  accept sends `accepted`, then `placed`. A cancel ChartBridge makes (expiry, the window, the heartbeat, the kill switch,
  leaving auto) answers `expired` with the reason; a proposal ended by the kill switch, a mode change or the heartbeat is
  `not answered`; NinjaTrader rejecting the entry answers `refused`.
- **The window** (lead's default; 0.5.2 in session time, Anthony's rulings 2026-10-08): outside `entryFrom` to `entryUntil`, in
  session order from the 18:00 open, or while the market is closed, no agent entry works (before `entryFrom` too) and an open
  proposal expires. With 18:00 to 15:25 an entry placed at 23:30 lives on past midnight; one still working at 15:25 is
  cancelled. The day's counters, stand-down and plan ids still start over at 18:00, the start of the session. After a restart an entry whose expiry is not on record is cancelled at once; the expiries and the
  plan ids are kept in the day file (`plan<TAB><id>`, `entry<TAB><tag><TAB><expiry UTC ms>`). An `entry` line whose order
  NinjaTrader no longer lists is dropped when the day file is read and at the roll.
- **Every start is shadow, and shadow cancels** (review A-S7): every agent starts in `shadow`, and the backstop below cancels any
  agent entry still working from before the restart at the first pass, whatever its expiry.
- **The backstop** (review A-S2): every pass (500 ms) cancels any working agent entry while that agent is killed, in `shadow` or
  stood down, or outside its window, however it came to be working. The page's `agentKill`, `agentMode`, `agentAccount` and
  `agentRules` wait for the agent's placing gate, so none of them lands between a plan's checks and its order; the order goes
  to the account the checks validated.
- **A cancel not confirmed** (review A-S1): an agent entry's cancel is sent again every 3 s while NinjaTrader still lists the
  order as working (each send in its own try; a send that throws is logged and tried again); from the second try the pages
  get a `status` warning ("the cancel of its entry ... was not confirmed in 3 s ... check NinjaTrader"). After 10 tries (about
  30 s) a `status` error ("still not confirmed after 10 tries ... cancel it in NinjaTrader now") and one try every 30 s from
  then. Nothing is sent while the account is not Connected; the tries go on when it is (review A4). After 30 minutes the tries
  stop with a final `status` error ("never confirmed in 30 minutes ... cancel it in NinjaTrader now"; review A C5).
- **The order path checks again** (review A-N4, defense in depth): `PlaceOrderLocked` refuses an agent entry outside its window,
  while killed, in shadow or stood down, and a stop-limit whose limit is more than 20 ticks from its stop, whatever called it.
- **Modes** (lead's default, as the bot): leaving `copilot` ends open proposals `not answered`; leaving `auto` cancels the
  unfilled entries; the mode survives a heartbeat loss (only a start resets it); `auto` needs the account tradable and not
  clashing.
- **Kill** (lead's default): on, with one click: the unfilled entries cancelled and the proposals `not answered`; the agent's
  own `flatten` refused; the flat time still runs. Off needs the page's confirm (the page's side).
- **The flatten** (lead's default): per root the agent owns (or has orders working on), from `flatAt` until the next
  `entryFrom` in session order (0.5.2), and whenever the market is closed (the break, the weekend, a holiday or a halt). With
  `entryFrom` 09:45 a position held overnight is flattened by its rules ("held a position outside its trading hours"); with
  `entryFrom` 18:00 a position held from 22:00 across midnight is inside the session and is NOT flattened until `flatAt`. Over
  a closed market (0.5.2 review: the calendar's closures and halts too, see "The market shut") the job sends nothing and
  closes the position at the next open. A position whose trade record began in an earlier session (0.5.2 review: a restart
  after 18:00 with a flatten that did not finish) is flattened at once, whatever the window says ("held a position from an
  earlier session (its 15:55 flatten did not finish): flattened by its rules"); the closed-market rule still applies. 0.6.3
  (audit C10): a flatten at the flat time that starts more than a minute after `flatAt` names the real time: "<id> flattened at
  16:40 by its rules (its 15:55 flat time passed while ChartBridge was not running or not watching)"; within the minute it says
  "<id> flattened at 15:55 by its rules", as before. The
  roll keeps such a record as `carried<TAB><tag>` in the day file (a dropped stale record too, at a start), so a roll while
  running followed by a restart still flattens it (the 0.5.2 re-review). Only that position counts: the agent's open trade
  whose tag is carried, or (no trade record yet, after a start) a position under its own legs of a carried tag; a trade of
  this session is never flattened because a carried line is still there. The line goes when the agent is flat on its roots,
  on the next pass or at once when a plan's check 8 finds it flat. ChartBridge 0.5.1 does not know the line and treats the
  day file as unreadable; it never rewrites a day file it cannot read, so it takes no entries for that agent on every run
  until the file is deleted or 0.5.2 is back. It looks at the served contract and at any other contract month its own open trade holds (review A5: the trade
  follows its executions in any month of its roots). If the account is missing from NinjaTrader's list the job is kept, the
  pages get the NOT FLAT error every 10 s ("account not listed by NinjaTrader"), and the job goes on when the account is back,
  after 18:00 included (review A-S6).
- **The flatten asks again** (review A1): when the account is back, when the position is not what the job started with (its
  sign or size), and before every close, the job asks again whether the pair is still the agent's (a sign the other way than at
  the start is never the agent's). Not the agent's: the job ends with a `status` warning ("<account> <root> is no longer agent
  <id>'s: ChartBridge did not close it") and nothing is closed. A close never exceeds what the agent's own trade holds (its
  ledger quantity), even when the account holds more; with no trade followed (after a restart, before the executions are read
  again), the contracts its stop legs covered when the job started (lead's default). A pair the job owns stays the agent's until
  flat, so cancelling its own legs never hands it away.
- **The market shut** (review A2, lead's default; NinjaTrader's trading hours are not read): 17:00 to 18:00 New York time
  Monday to Thursday, and Friday 17:00 to Sunday 18:00; 0.5.2 review: also whenever `ChartBridgeCme.Closed` says closed (a CME
  holiday, the halt at 13:00 on an NYSE holiday, the 13:15 early close), the calendar check 7 uses. While shut the flatten
  sends nothing at all (no cancel, no close: its stop and target stay, even with trades still printing) and the NOT FLAT error
  repeats every 60 s; it goes on at the open.
- **The market trading in fact** (review A C1, D3): before the flatten cancels any leg of a position it owns, the root must have
  traded in the last 5 s (an early close, a holiday or a halt). Otherwise its stop and target stay, NOT FLAT says "market not
  trading: the stop and target stay" every 10 s, and it tries again each pass. Only the cancel step waits for it: once its
  cancels were sent, the market close goes whatever the feed shows. A close that ends unfilled in open hours (rejected,
  cancelled) puts the stop back at once (as below), the error says so, and the next try waits 30 s with that stop in place.
  0.6.3 (audit C7, Anthony's decision): no trade because NinjaTrader's **data feed is down** (a drop of the data connection
  seen, no trade or Connected since; the same state as `/diag` `gate.feedDown`) is not a halt: with the account Connected and
  the market open by the calendar (not shut, above) the flatten goes anyway, and the pages get one alarm naming it ("Agent
  <id>: flattening <root> on <account> (<why>) with NinjaTrader's data feed down: no trade seen for 5 s because the data
  connection is lost, the account is Connected and the market is open by the calendar, so the close goes without a fresh
  price; check the fill in NinjaTrader"). Review LOW 9: no trade at all since ChartBridge started listening, 5 s or more after
  that start, counts as the feed down too (a start with no data ever). With the feed down and the account not Connected nothing can go: NOT FLAT says "no
  trade seen for 5 s: NinjaTrader's data feed is down and <account> is not Connected, so ChartBridge cannot close it now; act
  in NinjaTrader now". The feed up and no trade is a real halt: as before. Review MED 4: only the job the agent's rules start
  at its flat time (from `flatAt`, not an earlier session's position, not outside its hours, not the agent's own `flatten`) goes
  with the feed down; every other flatten waits for a trade as in 0.6.2, and its NOT FLAT says "NinjaTrader's data feed is down
  (not the flat time, so it waits for a trade) ...".
  A stop placed again is cancelled only once the market trades again (review E2): with no fresh trade the stop stays and NOT
  FLAT says "market not trading: its stop placed again at <price> stays". When the shut hours arrive after its legs were
  already cancelled (the close not filled), the job places the stop again (lead's default: a position is never left without a
  stop over a closed market): a stop market, GTC, `CB#<tag> ag:<id> stop p<price>` (role `stop`), at the agent's own stop price
  (the one nearest the market when the job started), for what it holds (never more than its trade), once per shut spell. If
  that price is already through the last trade it is not placed, and the NOT FLAT text says so; the text always says which.
  It is never placed while the flatten's own market close still works (that close may fill at the open; review D2): the text
  says so. At the open the job cancels it with the rest and closes. That stop counts as the agent's protective leg (review D1):
  with a position it would close (a sell stop under a long, a buy stop over a short) the pair stays the agent's, also after a
  restart; a flatten of a pair the agent does not own never cancels it while the account holds a position there, and cancels
  it once the pair is flat (lead's default: flat, it could only open a position). A position whose only working orders are the
  agent's own stop or legs, with no trade followed after the executions were read again (a restart lost the record), raises
  the lost-trade error every 60 s ("agent <id> holds <n> on <account> <root> with no trade record (<why>); only its own stop
  protects it: ChartBridge keeps that stop and closes the position at its flat time; check NinjaTrader"). 0.6.4 (WORK
  2026-10-19, a false alarm on a fresh fill): NinjaTrader shows an entry filled, the position moved and its legs working
  before the execution event that opens the trade record comes through, so the error goes only once that state has held on
  every pass for 5 s (`OrphanConfirmMs`) with no fill NinjaTrader shows ahead of its event; any pass with a record, a flat pair
  or anything else working starts the 5 s over. `<n>` is what the account holds by the effective reading (it counts a fill not
  yet in NinjaTrader's position; the listed reading when that is 0), so a fresh fill never reads "holds 0". `<why>` is
  "ChartBridge restarted" only when the position was already there when this run of ChartBridge began watching the account
  (and has not been flat since), else "opened while ChartBridge was running". The error ends once a trade record follows on
  that pair (the poll found the execution) or the pair is flat by both readings, and if it was sent the pages get one `info`
  line ("agent <id>: the no-trade-record error on <account> <root> is cleared: ChartBridge follows its trade <tag> there now",
  or "...: the pair is flat"). While the agent's own flatten runs there it is held as in 0.5.7. A leg counts for the owner only
  when it would close the position the account holds.
- **The close cap counts each close** (review A C2): with no trade followed, every close's fill comes off the stop legs' count;
  when the agent's part is closed and the account still holds more, the job ends with a warning ("agent <id>'s <n> closed; the
  rest (<m>) is not agent <id>'s: ChartBridge did not close it"). Every
  order that may fill on that contract of its account is cancelled (again every 3 s until NinjaTrader confirms each); then,
  under the order lock, with both position readings agreeing and every fill through, what it holds is closed at market as
  `CB#<tag> ag:<id> flat` (readings apart 3 s: the smaller, never more than either shows; a close that ends unfilled is sent
  again 3 s later). On a pair the agent does not own only its own orders are cancelled and no position is ever closed. The
  `info` and the `error` go to every signed-in page (v2 pages too). The agent's own `flatten` (auto) is the same job.
- **The owner, as built** (lead's default): an agent owns (account, root) while its entry may fill there, while its trade is
  open there (followed from the executions, as the bot's), while its own stop or target works there with a position by either
  reading (also after a restart, by name), and from its first entry until the pair is flat by both readings with nothing of the
  agent working and no fill NinjaTrader shows ahead of its event (review A-N1). That last lock is checked and cleared every pass.
  An open trade record counts only in its own session and only while its entry or legs are listed or the executions follow it;
  otherwise it is dropped with a log line (reviews A-S4, B-S2), so a record can never make the agent own a position it did not
  place. Records are checked only once the session's executions were read through without an error after the account's watch
  began (NinjaTrader's execution replay, reviewer B; a read that fails marks nothing, and the next poll that goes through does,
  review A C5), never on a fixed timer. A record dropped while the account holds a position on the agent's
  roots raises a `status` error every 60 s until that pair is flat ("agent <id> had an open trade on <account> <root> and its
  legs are gone; ChartBridge no longer treats the position as the agent's: flatten or protect it by hand"; review A3).
  Ownership is not restored: Anthony decides. The pages have no acknowledge message, so the error ends only when the pair is
  flat (lead's default). 0.5.7: while a flatten job of that agent that owns the pair runs on that root (its own cancels take
  the legs away) the lost-trade error is held, never dropped: logged, not sent and not repeated, for 30 s at most (then it is
  raised and repeats every 60 s as before, the job still running); once no job runs there it is raised (then every 60 s) if
  the pair is still not flat, and forgotten if it is. A job that does not own the pair (it never says NOT FLAT) holds nothing. The same happens to the trade being followed when both readings of its contract show a position on
  the other side (it ended where ChartBridge could not see it, and the account holds someone else's): the pair is not the
  agent's at once (the owner lock and the flatten), and once that has held for 3 s with no fill NinjaTrader shows ahead of its
  event the trade is ended with its realized part booked (what its fills closed, at the average of its opening fills; review
  A C4), then the error above. A trade never crosses zero (review D5): a fill on the other side bigger than the trade closes
  the trade at that fill's own price, and the rest is not the agent's, so a booked result always comes from its actual
  executions. A late execution of the same entry (a lost event the poll finds) nets against that rest: the closed trade's
  result and contracts grow by the matched part, and only a true net opens a trade again (review E1). An open trade whose pair
  is flat by both readings, with nothing of the agent working there and no fill NinjaTrader shows ahead of its event, for 5 s,
  is ended and booked from its executions; when those do not net to zero the pages get a warning ("its own executions leave
  <n> open: some were not seen; check NinjaTrader's fills"). 0.6.3 (audit C8): none of these (the trade ended on a flat pair,
  the trade dropped against the other side, the owner lock released when flat) happens while the account is not Connected
  (lost, reconnecting, or a resync emptying its positions and orders): what it shows then is not what it holds. Once it is
  Connected again the account must stay Connected for 3 s before they are looked at, and the 5 s (or 3 s) grace starts then. An unowned pair's flatten only ever cancels the agent's own entry and legs (review A-N2). The check is in `PlaceOrderLocked`
  right after the account and the instrument are found (the page, Order Strategies, the bot and every agent) and in the
  copier's `Eligible` (a skip labelled `agent`).
- **A page order that only reduces** the agent's position passes the owner lock as an exit (lead's default, review A-S5): a
  MARKET order only, no bracket, no strategy, the other side of the position by both readings, at most the smaller of them. A
  resting page limit, stop or MIT on the agent's pair is refused ("<account> <root> belongs to agent <id>: use Flatten, or move
  its stop or target"): it could outlive the position and open one with no stop.
- **A part-filled entry** (review A-S3): if the first part's trade closes (its target or stop) and the rest of the entry then
  fills, the rest is its own trade (`<tag>-2`, then `-3`), counted in `trades`, `losses`, `pnlToday` and `maxLosses`; the day
  file keeps which contracts each trade covered (`span<TAB><key><TAB><from><TAB><to>`), so a restart gives the same trades.
- **Page edits of an agent's entry** (lead's default): `plan` may set new distances of 1 or more, never remove the stop or the
  target (null or 0: "an agent's entry always has a stop and a target"); `change` of its price is allowed (gate 5); legs,
  Flatten and cancel always.
- **Only a chosen account is the agent's** (lead's default). An account chosen on the page (written to
  `agent-<id>-account.txt`) is the agent's, and it is the only one `botAccount`, `copierSet`, `copierFollower` and other agents
  refuse (`copierFollower` with `on: false` too, unless the account is already listed: it would list it). An agent with no
  account file is on None (0.5.7; until 0.5.6 its unchosen default Sim101) and claims no account against anybody; it trades
  nothing until an account is chosen.
- **Account clashes** (lead's default): the bot's account and the copier's leader and followers count whether or not the bot
  and copier switches are on (read from `bot-account.txt` and `copier.txt` when off; a file that cannot be understood counts
  as a clash). Both files are read on ChartBridge's timer (when their time stamp changes), never on a NinjaTrader event
  thread; a `copier.txt` or `bot-account.txt` that cannot be read keeps the last good copy for one pass and counts as a clash
  from the second; with no good copy yet (the first read at a start) it counts as a clash at once (reviewer B). A clash stands the AGENT down in plain words ("Sim101 is also the bot's account: choose an account for agent
  manrae on the Agent tab"); the bot and the copier are left as they were. The moment the bot or the copier is set to the
  account an agent sits on, its plans are refused at check 2, its unfilled entries are cancelled and its open proposals
  expire; an open position keeps its stop and target and the flat time still applies. Between agents: a chosen account is
  each agent's own. 0.5.7: an agent on None clashes with nobody (None is nobody's account).
- **agentAccount** (0.5.2, Anthony 2026-10-08, and its review): a change KEEPS the agent's mode only when the message carries
  `keepMode` and it equals the agent's mode now; otherwise the agent goes to `shadow`, as until 0.5.1: no `keepMode` (a page
  before 1.18.1, whose question said the agent goes to Shadow) or another mode (another page changed it after the question was
  shown). `keepMode` that is not `shadow`, `copilot` or `auto` is refused and nothing changes. The page asks once before a LIVE
  account, naming the mode ("Agent manrae will trade LIVE account EVAL-A in Auto. Continue?"), sends that mode as `keepMode`,
  and not confirmed nothing is sent; to a ChartBridge before 0.5.2 (by the hello's `version`) it sends no `keepMode` and its
  question says Shadow. Unchanged: never the bot's account, a copier leader or follower, or another agent's; the owner lock; no
  change while the agent has a position, a working entry or a proposal. The agent gets `welcome` again (with its mode); logged
  with SIM or LIVE and the mode ("mode auto kept", or "mode shadow (was auto: the page did not say which mode it showed)",
  "mode shadow (was copilot: the page's question named auto)").
- **agentRules** (lead's default): roots from NQ, MNQ, ES and MES only (a root needs a hard ceiling); a `maxQty<ROOT>` left out
  for a chosen root is its hard ceiling; for a root not chosen only 0 is accepted. In the rules file a key left out keeps its
  default and a root without a `maxQty` line gets its ceiling. A rules change never lifts a loss stand-down for that day; the
  18:00 ET roll resets trades, losses, the stand-down and plan ids, and drops ended proposals (at most 50 ended ones are kept
  between rolls). The loss stand-down is kept in the day file (`standDown<TAB><why>`), so a restart keeps it; so are the
  trades of an earlier session not yet flat (`carried<TAB><tag>`, 0.5.2), and (0.5.7) the plan of each entry of today's trades,
  its working entries and those carried over (`#tagplan<TAB><tag><TAB><plan id>`): it starts with `#` so a ChartBridge before
  0.5.7 reads it as a comment (any other line it does not know stands the agent down); a malformed one is skipped.
- **A start with a position** (review A-N5): 5 s after a start, an agent that owns a pair (its open trade, or its legs with a
  position) gets a `status` `error` to the pages ("holds a position or orders ... since ChartBridge started ... check
  NinjaTrader"); outside its trading hours it is flattened by its rules at once. A rules file that cannot be read gives the
  default times and makes the flatten look at all four roots an agent may trade (NQ, MNQ, ES, MES).
- **The `rules` object** (lead's default): `roots` a list of strings, `maxQty` an object, times as `"HH:MM"`, `maxTrades` and
  `maxLosses` null for none.
- **Page messages** (lead's default): signed-in v3 pages only; every one counts in gate 7, `agentSeen` included.
  `agentPlan` for a skip carries every plan key (null where a skip has none). The sign-in replay counts skips among the last
  50 plans.
- **What the agent gets** (lead's default): `order` as a v2 page gets it (no `by`, no `tradable`), `exec` only for its own
  orders, `position` for its account on its roots. Warnings of the heartbeat and the kill switch go to v3 pages (as the bot's).
- **Section 10 as built** (lead's defaults): `agentState` is computed again on every order event of the agent's account (on its
  roots), every position event there and every timer pass, and sent only when it differs from the last one sent (always after
  `agentHello`); one at a time, so an older state never follows a newer one. Its `session` is the session of the agent's
  counters (the day file's, rolled at 18:00 ET). `exec.cbId` is the id the agent's order messages carried for that order
  (kept by the agent object, because ChartBridge forgets a done order's id); null for an order whose name is not ChartBridge's.
  The protective exit is `CB#<tag> ag:<id> protect f<n>` (at most 43 characters, review A C5), `n` the entry's filled count it
  exited: a restart reads it as v2's exit up to that count and values those contracts from NinjaTrader's executions of the
  entry, so they never get legs again. A runner should match the prefix `CB#<tag> ag:<id> protect` or use `role`. Every fill
  on a pair the agent owns reaches it, ownership read before the fill is booked; a fill of the page's order there carries the
  id the pages saw (kept as its order event passes). `agentState` is built with no lock of the agent's held and a sequence
  number taken first; its lock only compares and sends, so it never holds a lock across NinjaTrader's collection locks (review
  A C3). `agentState` waits for a `welcomeSent` flag, cleared at every hello and set only after its welcome is queued, so no
  `agentState` reaches the agent before its welcome (review D4); `helloed` is set at the hello as before, so a second hello
  never looks like no hello to the silent-socket check and ticks keep flowing (review E3). `welcome` is checked every pass against the caps enforced and sent again when they changed. The snapshot
  sends only the agent's orders on the snapshot's roots. `orderName` is the order's name as NinjaTrader holds it (null if it has
  none). The pages' messages are unchanged (no `orderName`; their `role` stays `other` for the flat close and the protective
  exit).
- **Fills `by`** (lead's default): the execution's own order is used; only without one is the order looked up by its id on its
  account. Legs and the flat close are known by their entry's tag (learned at placement, from every order event, and by a scan
  of the accounts every 2 s).
- **Robustness** (review nits): a connection's end always closes its socket (the agent's cleanup runs in `finally`); an
  exception in an agent's message loop is logged with its type and message; the page sign-in hook runs in its own `try`; with
  the channel off the tick loop and the page's reduce check do no agent work at all.
- **Recovery** (lead's default): an agent entry is a v2 entry: its `planned_brackets.txt` line if there is one, else the ticks
  in its name. `/diag` `flattenedAt` is the UTC time of the last flatten that ended flat.

**Plain words on two risks** (as built, for Anthony):

- **The flatten removes the stop first.** At the flat time (and on the agent's own `flatten`) ChartBridge cancels the agent's
  working orders on that contract, its stop and target included, and only then closes the position at market, so the stop
  never fills beside the close and turns the account the other way. For that moment the position has no stop. If the account
  disconnects then, nothing is sent until it is back, and every signed-in page gets the NOT FLAT error every 10 s until the
  position is flat: act in NinjaTrader.
- **Nothing flattens an agent whose id is removed from `config.txt`.** The flat time, the expiry timers and the heartbeat run
  only for the ids in `agents`. Take an id out (and restart) while that agent holds a position or a working entry, and
  ChartBridge no longer watches it: its stop and target stay at the broker as v2 legs, but nothing closes it at its flat time.
  Flatten it first, or flatten it by hand.

What only NinjaTrader can show: the `/agent/<id>` upgrade through `HttpListener` (the Mono harness drives the agent object
directly), NinjaTrader's own order and execution event order, `TimeInForce.Day` at the broker, whether order names are kept
whole (an entry up to 49 characters, `CB#<tag> ag:<12 characters> s<n> t<n>`; a protective exit up to 43), and the
instruments' real trading hours (the shut hours are fixed; an early close is caught by the market-trading check).

### None and the daily reset (0.5.7, DECISION 2026-10-14e)

Every branch that trades offers None, and None means nothing trades: the order ticket, the bot (`botAccount`), each agent
(`agentAccount`) and the copier's leader (`copierSet` with `"leader": null`, as since 0.4.3; followers have no None of their
own). On None every new entry is refused with a plain reason ("the bot's account is None: no bot entries until an account is
chosen on the Bot tab"; "agent <id>'s account is None: no new entries until an account is chosen on the Agent tab", check 2,
also the strip's and `agentState`'s `standDown`); exits, flattens and the management of anything already open are never
blocked. `bot`, `welcome`, the `agent` strip and the agent's `welcome` carry `"account": null` (and `sim` false) on None.
`botAccount` and `agentAccount` take `"account": null` for None, refused only while that branch has a position, a working
entry (or, for an agent, a proposal, and any position or working order on its account, a trade it lost included: "agent <id>'s
account <name> has a position or a working order: choose None when it is flat"); `"-"` is never an account name from the page. No
`bot-account.txt` or `agent-<id>-account.txt` is None (until 0.5.6 Sim101); None is saved as `account<TAB>-`, which a
ChartBridge before 0.5.7 reads as an account NinjaTrader does not have, so it refuses every entry there too and nothing
breaks. None is nobody's account: no clash with the bot, the copier or another agent.

The order ticket (chart 1.25.0): its picker offers None first; with None nothing is sent ("No account (None): nothing was
sent. Pick an account to trade.") and Armed does not come on. `LivePrefs.orderAccount` has no Sim101 fallback: a last pick
ChartBridge does not allow now gives None with the note naming it. On None the ticket's Flatten all sends nothing either (pick
an account). 0.5.7: the sign-in `orders` list carries
`positions`, how many `position` messages follow it, so a page knows when its snapshot of orders and positions is whole.

**The daily reset.** Once per day in the 17:00 to 18:00 ET break (New York time, daylight saving included), ChartBridge puts
every branch it holds that is flat with no working order on its account (no position on any contract, no order that may still
fill) on None: the bot, each agent, and the copier's leader (the copier then stands down, "No leader is set."). The bot and
the copier are reset whether or not their switch is on (off: in `bot-account.txt`, and `copier.txt` loses only its `leader`
line), so a branch turned on later never starts the day on yesterday's account. A branch with a position or a working order is skipped and the pages get a `status`
`warn` naming it ("Daily reset (17:00 ET): the bot stays on <account>: it has a position or a working order there ..."), also
sent to a page that signs in during that break; the ones put on None get one `status` `info`. It runs on ChartBridge's 2 s
poll timer, without a page. The New York date it ran is kept in `daily-reset.txt` next to `config.txt` (two `#` lines, then
`day<TAB>yyyy-MM-dd`), so a restart in the same break does not run it again and a branch chosen again after the reset stays.
0.6.3 (audit C1): **a missed break is caught up.** At start (once every branch is loaded) and on every 2 s check, when the day
in `daily-reset.txt` is older than the New York date of the latest 17:00 ET at or before now (the page's `resetDay` rule), the
break was missed (ChartBridge or the PC was off from before 17:00 to after 18:00, or over a weekend) and the reset runs then,
with the same Idle and skip rules; its notes read "Daily reset (17:00 ET, caught up now: ChartBridge was not running at 17:00
ET on <date>): ...", and a page that signs in before the next 17:00 gets the skipped notes too. No `daily-reset.txt` (or one
that does not read) is not a missed break: the reset waits for the next break, as before. A day ahead of now (the clock moved
back) is not due.
0.6.3 (review HIGH 1): **a branch whose account is not known yet is never put on None**, in the break or caught up: its account
not listed by NinjaTrader, not Connected, or Connected for less than 30 s (review round 2, MED B: `SteadyMs`, ChartBridge's own
rule while NinjaTrader reconnects, as positions can arrive after Connected). It keeps its
account, the pages get one `status` `warn` ("<branch> stays on <account> for now: <why>, so its positions and orders are not
known; its reset runs once they are"), and it stays pending: `daily-reset.txt` gets a `pending<TAB><key>` line (`bot`,
`agent:<id>`, `copier`) after the day line (and `missed<TAB>yyyy-MM-dd` for a caught-up run, so a retry after a restart still
says it was caught up; review round 2, LOW D), and every 2 s check tries that branch again (only that one, so a branch chosen again
after its reset stays), also after a restart, until it is known; then the usual Idle and skip rules apply and the line goes.
Review round 2 (MED A): **Anthony's choice always wins over a pending reset**: when the page sets a pending branch's account
(`agentAccount` with an account, a group, a league seat or None, `botAccount`, `copierSet` with `leader`), its pending line goes
and `daily-reset.txt` is written again; a retry already running leaves alone a branch that is no longer pending (checked under
the same lock the page's choice takes). Review round 2 (LOW C): **while a branch's reset is pending it takes no new entries**
(the 17:00 rule, enforced in the short window after a reconnect): an agent's plan is refused at check 2 and a bot signal is
refused, both with "waiting for the daily reset: <account> was <branch>'s account before the 17:00 ET reset and is not known
yet ...", which is also the status (`agentState` and the strip's `standDown`, `bot.standDown`); the copier copies no new leader
entry. Exits, legs and flattens are never affected, and a working entry is not cancelled for it. A ChartBridge before 0.6.3
reads only the day line.
`ChartBridgeBranches.KeepThroughReset` is the one place an exception would go (Anthony is still deciding whether a branch
running a hero on Sim101 is left alone); for now there is none. The ticket's account is each page's own, so the page applies
the same rule to it (`LivePrefs.ticketReset`, every 5 s in the window with the ticket, and only once that connection's
sign-in snapshot of orders and positions is whole, never on a timer): a pick made before the latest 17:00 ET
(`live-account-at-v1`, the time of the last pick) goes to None when that account is flat with no working order, else it is
kept with a note naming it; either way once.

### Prop groups and account state (0.5.8)

Anthony's decisions of 2026-10-14 (items 4 and 5, with G1, G2, G3 and F-ALL) and 2026-10-15 (Q-EXIT b, CON a). Built in
`nt8/ChartBridgeGroups.cs` (it never places or changes an order; the one cancel, Q-EXIT's below, goes through
`ChartBridgeOrders.GroupCancelLeftover`) and the page's Settings and Accounts tab (`live/groups.js`, `live/accounts.js`).

- **Groups** are made, renamed and deleted on the page (Settings, Account groups); each account picks its group from a
  dropdown on the Accounts tab. ChartBridge saves everything; nobody edits a file. A new account arrives in no group (None).
  An account in no group is a **personal** account: it may have "my floor" and "my daily limit" of its own.
- **One direction per group** (G3 a, zero tolerance: prop firms ban hedged accounts): the whole group, every market. While any
  member is long anything (a position, or a working buy entry), no member may open a short in any market, and the other way
  round. Refused for every source: an agent, the bot, a copier follower and Anthony's own order ticket. Exits, flattens, stops
  and targets are never blocked. Each group has a **No hedging** switch, on by default; off, its members are not checked.
- **The firm's rules** sit on the group: account size (G1, the starting balance), daily loss limit (or none), drawdown size,
  drawdown type (`eod`: trails the end-of-day high; `intraday`: trails the intraday high; `static`), "floor stops at" (G1, the
  Lucid-style lock: once a trailing floor reaches it, it stops rising; none allowed), profit target (or none).
- **Real account state**: with NinjaTrader's live balance and P&L and these rules, ChartBridge works out per account the
  floor, the room to the floor, the daily room (open P&L counted) and the target left, and sends them to the pages
  (`accounts`) and to each agent (`accountState`). A number ChartBridge cannot give is null with the reason; it is never
  estimated. Bots are not in scope.
- **G2 (b)**: when an account is put into a group, the page asks once for its "highest close so far" (from the firm's
  dashboard; optional, prefilled with the larger of the account size and its balance now); ChartBridge starts both trailing
  highs from it.

**Files** (next to `config.txt`; written whole through a temp file, off NinjaTrader's thread; Anthony never edits them).
`groups.txt`: two `#` lines, then one line per group, member and personal account:

    group<TAB><id><TAB><name><TAB>on|off<TAB><dailyLoss>|-<TAB><drawdown><TAB>eod|intraday|static<TAB><target>|-<TAB><size><TAB><lockAt>|-<TAB><consistency>|-<TAB>eval|funded|-<TAB><hero>|-
    member<TAB><account><TAB><id>
    personal<TAB><account><TAB><floor>|-<TAB><daily>|-        (a saved line stays with - and -: set to none, not never set)

`on|off` is the No hedging switch; `-` is none. Money is dollars with at most 2 decimals, a `.` for the point. Ids are `g1`,
`g2`, ... in the order made (the next is one above the highest in the file), so a rename never touches membership; a deleted
group's members go to None with it, so no line ever points at a group that is gone. A `group` line may carry more fields after
`lockAt` (a later ChartBridge's); they are kept as read. `consistency` (CON a, 2026-10-15) is Lucid's consistency rule, no single day over that percent of the profit (1 to 100, at most 2
decimals; `-` none); a group line of 10 fields (written before it) reads as none. 0.6.1: then the group's Type (`eval`,
`funded`, or `-` not set) and its default hero (a build name, 1 to 64 letters, digits, dots, underscores or hyphens, a letter or
digit first; `-` none); a line of 10 or 11 fields (written before them) reads as not set and none. A ChartBridge 0.5.8 or 0.6.0
keeps them as read: it keeps every field after the ones it knows and writes them back on each save (checked in its source:
`g.Extra = p.Skip(11)` and the save loop over `Extra`). Anything else (a line ChartBridge does not know, a group id twice, a
member of a group that is not there, an account twice, a name twice) makes the file unreadable: it is **never rewritten that
run**, every entry on every account is refused ("groups.txt could not be read: every new entry is refused until it can (exits
always work)"), every page gets that `status` `error` as it signs in, and the page's group changes are refused. No `groups.txt`
(every PC before 0.5.8): no groups, every account personal with no limits, ChartBridge behaves exactly as 0.5.7.
`account-marks.txt`: two `#` lines, then

    mark<TAB><account><TAB><peakEod>|-<TAB><peakIntraday>|-<TAB><dayStartBalance>|-<TAB><session><TAB><dayStartAt>|-<TAB><closeSeen>|-<TAB><lastBalance>|-<TAB>flat|open|-<TAB><eodMissed>|-<TAB><intradayMissed>|-

per account seen connected this NinjaTrader session. `peakEod`, the highest end-of-day equity (balance plus open P&L): raised
in the 17:00 to 18:00 ET break by the same 2 s check that runs the daily reset (whether or not the reset ran a branch), and by
each session's first reading (`dayStartBalance`, the close before it) only when that reading falls in the 17:00 to 18:05 ET
window (review of #48: a ChartBridge started at midday never takes a midday balance for a close). `dayStartAt` is the UTC ms of
that reading. `peakIntraday`, the highest equity seen, raised by the
1 s accounts check. The highs are kept only for an account in a group: joining sets both (G2), leaving or a deleted group
clears them. `dayStartBalance`, the balance at the first reading of each session (`session`, `yyyy-MM-dd`, ChartBridge's
18:00 ET session date, as `agentState.session`). Written at most every 5 s while something changed, and at the stop. A file
that cannot be read is not rewritten that run: the trailing floors are null with that reason (a static floor still works) and
`realizedToday` and `pnlToday` fall back to NinjaTrader's. A balance of 0 is taken as NinjaTrader not having given one yet (no
day start, no high from it). ChartBridge 0.5.7 and older never read either file, so going back is safe (they behave as before).
0.6.3 (audit C2): each `mark` line has five more fields, `closeSeen|-` (the trading day of the last close seen: in the 17:00
to 18:00 ET break, a session's first reading in the 17:00 to 18:05 ET window, or caught up), `lastBalance|-` and `flat|open|-`
(the last reading: its balance and whether the account had no position), `eodMissed|-` and `intradayMissed|-` (the close, or
the day, a high may have been missed on). **A close or a high ChartBridge did not see never overstates the room.** At the first
reading after a gap ChartBridge did not watch (its first reading of the account this run, or none for 10 s, a PC asleep or the
account not connected): when the account was flat at both ends and the balance is the same, nothing traded, so every close it
missed was that balance (the end-of-day high is raised to it, if higher) and no high was missed. Otherwise a missed close (the
latest trading day whose close, 17:00 or the halt of an NYSE holiday or early close, fell after `closeSeen`) is kept as
`eodMissed`, and any such gap (a position open at either end, or the balance changed) as `intradayMissed`; the pages get a
`status` `warn` naming the account, only for its group's drawdown type (review LOW 8: an EOD group's account never hears of
intraday highs). For a group of that drawdown type `floor` is then null, and so is `roomFloor` unless NinjaTrader reports its
own trailing room (then that figure, `src` `ninjatrader`; review LOW 8), with the reason
("ChartBridge was not running at the close of <date>: put the account in <group> again and give the highest close from the
firm's dashboard", or the intraday one), in `accounts` and in every agent's `accountState`, until the account is put in its
group again (leave, then join with `highClose`), which clears both. A reading in the close window is that day's close. A line
of 6 or 7 fields (0.6.2 and older) reads as it did, with no gap check at its first reading, and is written back with 12; a
ChartBridge 0.5.8 to 0.6.2 reads a 12 field line as not a mark line, so after going back (review LOW 10) its trailing floors
and its computed `realizedToday` and `pnlToday` are not given, with that reason (never a guess), and it never rewrites the file:
that lasts until `account-marks.txt` is deleted.

**The numbers** (per account; `equity` = balance + unrealized):

| field | value | `src` |
|---|---|---|
| `balance` | NinjaTrader's `CashValue` | `ninjatrader` |
| `unrealized` | NinjaTrader's `UnrealizedProfitLoss` | `ninjatrader` |
| `realizedToday` | `balance - dayStartBalance`; without a day start, NinjaTrader's `RealizedProfitLoss` (it does not always start over at 18:00 ET). Review of #48: a day start read more than 2 minutes after the session's 18:00 ET start (ChartBridge started mid-session) takes the smaller of the two, which can only understate the room; with no NinjaTrader figure then, null ("ChartBridge started mid-session ...") and so is `roomDaily` | `computed` / `ninjatrader` (whichever is smaller) |
| `pnlToday` | `realizedToday + unrealized` (open P&L counted) | `computed` / `ninjatrader` |
| `floor` | group `eod`: `max(peakEod, size) - drawdown`; `intraday`: `max(peakIntraday, size) - drawdown`; both never above `lockAt` when it is set; `static`: `size - drawdown`. Personal: "my floor" | `computed` / `settings` |
| `roomFloor` | `equity - floor`, and NinjaTrader's trailing drawdown left when it reports one (`TrailingMaxDrawdown`, as `roomDrawdown`): with both, the smaller (review of #48) | `computed` / `ninjatrader` (whichever is smaller) |
| `roomDaily` | `dailyLoss + pnlToday` (group), `myDailyLoss + pnlToday` (personal) | `computed` |
| `targetLeft` | `size + target - balance` (group with a target) | `computed` |

At or below 0, a room is used up. ChartBridge never acts on these numbers itself (the agent's runner does: Bot-Lab's size gate
and safety flatten); the page shows them. A ChartBridge started in the middle of a session takes its first reading as that
session's start (losses before it are not in `pnlToday`).

**Page to ChartBridge** (signed-in v3 pages, gates 1, 4, 7 and 8 as every v3 action; `reject` with `cid` when refused; no
config switch):

| message | fields (no others) | notes |
|---|---|---|
| `groupSave` | `cid` (optional), `group` (optional: the id to change; absent makes a new group), `name` (1 to 30 characters, no tab, unique ignoring case), `noHedge` (bool), `dailyLoss` (0 for none), `drawdown` (more than 0), `drawdownType` (`eod`, `intraday`, `static`), `target` (0 for none), `size` (more than 0, more than `drawdown`), `lockAt` (0 for none; `eod` and `intraday` only, above `size - drawdown`), `consistency` (optional, 0 or absent for none, else a percent above 0 and at most 100), `accountType` (0.6.1, optional: `eval`, `funded` or `-` for not set; absent keeps the group's), `hero` (0.6.1, optional: a build name of 1 to 64 safe characters, or `-` for none; absent keeps the group's) | every field every time (but `accountType` and `hero`): Rename and the No hedging switch send the whole group. Money: plain numbers, at most 2 decimals, at most 100,000,000 |
| `groupDelete` | `cid` (optional), `group` | its members go to None (personal, their own limits kept) |
| `accountGroup` | `cid` (optional), `account`, `group` (an id, or `null` for None), `highClose` (optional, more than 0: G2 b, joining a group only) | refused when the move would leave the target group mixed (the account holds the other side, or the group is mixed already, with No hedging on). Joining: both trailing highs start at `highClose`, or without it at the larger of the account size and the balance now (the page always asks, prefilled so) |
| `accountLimits` | `cid` (optional), `account`, `floor` (0 for none), `dailyLoss` (0 for none) | personal accounts only: refused for an account in a group ("its group's rules apply") |

**ChartBridge to page** (to every v3 page on ChartBridge's own origin, signed in or not, as `accounts`):

- `groups`: `{"type":"groups","list":[...],"error":null}` after `client`, after every group change, and when a group's side or
  holders change (the 1 s check). Each group: `id`, `name`, `noHedge`, `dailyLoss` (null for none), `drawdown`,
  `drawdownType`, `target` (null for none), `size`, `lockAt` (null for none), `consistency` (null for none), `accountType` (0.6.1: `eval`, `funded`, or null for not set), `hero` (0.6.1: the default hero's build name, or null), `members` (account names), `side` (`long`,
  `short`, `mixed`, or null when the group holds nothing), `holders` (`[{account, root, side, what, qty}]`: `what`
  `position` or `entry`, `root` the instrument's master name, `side` `long` or `short`, `qty` the contracts held or left to
  fill). `error`: null, or why `groups.txt` cannot be read (then `list` is empty and every entry is refused).
- `accounts`: each entry gains `group` (its group id or null), `myFloor`, `myDailyLoss` (a personal account's own limits,
  null for none), `myLimitsSet` (true once My floor or My daily was saved, 0 included; the tab says "not set" otherwise), `floor`,
  `roomFloor`, `roomDaily`, `targetLeft`, and `src` and `why` for those four (as `accountState`
  below). Everything else stays exactly as it was (`pnlToday` is still NinjaTrader's realized plus unrealized; the day's P&L
  from the day start is in `accountState` and in `roomDaily`), so a 1.25 page works.
- A noHedge group that turns mixed by itself (an order typed into NinjaTrader cannot be refused): one `status` `error` to every
  signed-in page ("Group <name> is now long and short (...): no new entries on either side until it is one direction; close one
  side in NinjaTrader") when it turns mixed, and one `status` `info` when it is one direction again.

**ChartBridge to the agent: `accountState`** (the agent channel, `ws://localhost:<port>/agent/<id>`):

| field | value |
|---|---|
| `account` | the agent's account now (null on None); a runner ignores an `accountState` for another account than its `welcome`'s |
| `sim` | as `welcome.sim` |
| `kind` | `prop` (in a group), `personal` (in no group), `none` (the agent is on None) |
| `group` | the group's name, null when not `prop` |
| `groupId` | the group's id, null when not `prop` |
| `groupSide` | the group's side now (`long`, `short`, `mixed`, or null when flat or not `prop`); while it is `long` the agent's sells are refused, and so on |
| `noHedge` | the group's switch (null when not `prop`) |
| `accountType` | 0.6.2: the group's Type from `groups.txt` (`eval`, `funded`, or null when not set), so a hero on one account inside a prop group knows it; always present, null when not `prop`. Informational: nothing in the order path reads it |
| `rules` | `prop`: `{dailyLoss, drawdown, drawdownType, target, size, lockAt, consistency}`: `size` the account size, `lockAt` "floor stops at" (G1), `consistency` the consistency percent (CON a: informational, no gate or flatten in ChartBridge uses it; personal rules never have it); `personal`: `{floor, dailyLoss}` (the account's own limits, once Anthony has saved My floor or My daily, 0 included), or **null when
no limits were ever set by Anthony: the agent keeps its model numbers** (NinjaTrader's trailing drawdown is still sent as
`roomFloor`, `src` `ninjatrader`); `none`: null. Inside `rules` **0 means none**, said explicitly (the firm has no daily limit, no target, no lock; the account has no floor or daily limit of its own), never null: a rule is never "missing". Only the eight numbers below may be null, each with its `why` |
| `balance`, `pnlToday`, `realizedToday`, `unrealized`, `floor`, `roomFloor`, `roomDaily`, `targetLeft` | dollars (2 decimals) or null, as the table above |
| `src` | for each of those eight numbers that is not null: `ninjatrader`, `computed` or `settings` |
| `why` | for each of those eight numbers that is null: the reason in plain words ("the account is not connected", "the group has no daily loss limit", "account-marks.txt could not be read", "no group and no floor of its own", ...) |
| `session` | ChartBridge's 18:00 ET session date, `yyyy-MM-dd` |
| `at` | UTC ms when it was read |

Sent after the snapshot (right after the `snapshot` message) on every `agentHello`; then from the agent's 1 s pass whenever
any field but `at` changed; and at once on any account, group or rules change (`agentAccount`, `groupSave`, `groupDelete`,
`accountGroup`, `accountLimits`). A ChartBridge before 0.5.8 never sends it: the runner keeps its model's numbers and says so.

**Exits left behind (Q-EXIT b, Anthony 2026-10-15).** Resting exits are always accepted. When an account in a group with No
hedging on goes flat on an instrument (both readings 0), ChartBridge cancels the working orders there that were exits of the
position just closed: orders placed while a position existed, on its other side (the page's, and orders typed into NinjaTrader,
seen by the 1 s check and at once on the position update to flat), never ChartBridge's own legs (the legs check keeps those);
OCO orders too (a typed OCO pair; an ATM's legs on a flat account are cancelled by the ATM anyway). Only
such orders, which would now open a position, are cancelled, each logged with a `status` `warn` to the pages ("SIM-A went flat on
MNQ: cancelled the sell limit 2 left from the long, so it cannot open a short"). Nothing is cancelled while the account still
holds a position there (a part-filled exit keeps working until then). After a start ChartBridge cannot know where an order came
from: on its first look at each account (once that account is connected), an order on a flat account on the other side of its
group's side is cancelled once, the same way. The note names the position just closed and the side the order would open.
Re-review 3 and 4: a leftover with no fill of its own is cancelled at once; a marked order with fills of its own and the after-start
look wait until the contract has been flat by both readings for 150 ms. A marked order whose own fills
took the position through flat (a resting reversal, e.g. a sell limit 4 on a long 2 filled 2) is the reversal's entry, not a
leftover: its rest is cancelled only when the group's other members hold the side it would open against, or the group is mixed ("...
left from before ChartBridge started (Lucid is long) ..."). An entry placed on a flat account later is the group check's.

**The one-direction check** (`ChartBridgeGroups.EntryCheck(source, account, root, isBuy, qty, wantsLegs, strategy)`, null or
the refusal). It runs under `PlaceLock` for every entry that passes `PlaceOrderLocked` (the page's ticket and chart clicks,
the bot, every agent, Order Strategies), just before the order is made, and in the copier's `Eligible` (a `group` skip on that
follower; the copier holds the same lock); the agent's plan check 10b asks it too (advisory: the binding check is the one under
`PlaceLock`). Nothing else places an entry. It counts, over every member of the account's group and every instrument:

- positions, by either reading (NinjaTrader's list, and fills reported but not yet in it), each a long or a short;
- working entries: every order that may still fill on NinjaTrader's list, and ChartBridge's own just sent (between `Submit`
  and NinjaTrader's list), except ChartBridge's legs and exits (`CB#<tag> stop|target|exit ...`, merged legs, an agent's
  `flat`, `protect` and stop placed again), any order with an OCO id, and orders on the other side of that account's position
  on that instrument up to the position, summed (review of #48: two sells of 2 on a long 2, the second is an entry of 2).
  OCO orders (re-review 2 of #48): while that account holds a position on the contract they are protective and never counted;
  once both readings are 0 they count, once per OCO id and side at the largest order (only one of a pair can fill), so a typed OCO
  pair left after flat, or a breakout pair typed on a flat account, shows the side it would open.

The account's own new order is exempt when it is an exit: no stop or target asked, no Order Strategy, the other side of its
position on that instrument by both readings, and its contracts plus the exits already working on that side no more than the
position. The exits already working are only plain market or limit orders with no OCO id that are not ChartBridge's legs (re-review
of #48): ChartBridge's stops and targets (a lone stop has no OCO id), the agent's and the copier's legs, merged legs, and any
stop, stop-limit, MIT or OCO order typed into NinjaTrader (an ATM's stop and target) never count, since they shrink with the
position (the legs check, the copier's trim); a typed stop left behind once the position is flat counts as an entry. Review of
#48: this exit rule is asked first, for every order (a page market exit too, which until then skipped the
whole check), and before anything else, so an unreadable `groups.txt` refuses entries only, never an exit; an order on the other
side that is too big with the exits already working is refused as an entry, the refusal saying to use Flatten (always allowed)
or cancel the working exits. Otherwise: a buy is refused while the group holds a short anywhere, a sell while it holds a long, and both while it
is mixed. The refusal names the group and the holders, as NinjaTrader names the accounts (made-up names here):
"Group Lucid is long (SIM-A +2 MNQ; SIM-B buy limit 1 NQ working): a sell on SIM-C would hedge the group; prop firms ban hedged
accounts. Exits and flattens still work." Two entries on opposite sides at the same moment: one passes, the other is refused
(one lock). `noHedge` off: not checked. Lock order: `PlaceLock`, then the groups' own lock, which only copies the membership
and is never held across a NinjaTrader collection. An unreadable `groups.txt` refuses every entry here.

### Group trading (0.6.0)

Phase 4 piece 1 (Anthony's decisions of 2026-10-15, Q1 b, Q2 a, Q3 a): one agent (a hero) trades a whole prop group from the
Agent tab. Separate from the copier: the copier stays exactly as it is (the bot's and discretionary trades). One brain: the runner
makes one set of model calls per decision and sends one plan; ChartBridge places it on every account of the group that can take
it (AI is never in the order path). Built in `nt8/ChartBridgeAgents.cs` (`ChartBridgeAgent.Seat`). Made-up names below.

**Seats.** Each account an agent trades is a seat: its one account (exactly as before), or every member of the group it trades,
in the group's order (by name, as the `groups` message lists them). ChartBridge keeps per seat everything it followed for the one
account: the open trade and its ledger (tag, root, contract, quantity, cash, average), the roots it owns until flat (the owner
lock, per (account, root) as before), the flatten jobs, the lost-trade errors (per (seat, root), with the 0.5.7 hold). A seat is
never a copier leader or follower, never the bot's, never another agent's: the copier and the bot never touch one.

**Choosing a group.** `agentAccount` may carry `group` (the group id) in place of `account` (never both). It is refused while the
agent has a position, a working entry or a proposal; while any member, or any seat it trades now, holds a position or a working
order on its roots; when the group has no account; and when a member is the bot's account, the copier's leader or a follower (on or
off), another agent's account, Backtest or Playback, or not in NinjaTrader. A member that is not tradable or not connected now is
taken: it sits out each trade until it is. `agent-<id>-account.txt` saves `group<TAB><id>`; a ChartBridge before 0.6.0 does not
understand that line and stands the agent down (safe). The page's picker is one list: None first, then each group ("Group Lucid:
SIM-A, SIM-B, SIM-C"), then single accounts; a group with a member that cannot be taken is shown with the reason, not offered.

**Membership.** An account joining a group an agent trades is refused (`accountGroup`, checked again under the lock that saves the membership) when it is the bot's, the copier's leader or a
follower, or another agent's. Any change of the seats (an account joins or leaves, the agent's account or group changes) puts
`seatsRev` up and sends a fresh `welcome` and `accountState`; a joined account is a seat from the next plan. A seat that leaves the
group, or every seat when its group is deleted (the agent then goes to None, saved), while it holds the agent's trade stays the
agent's (owned, protected, flattened at flatAt) until flat, and takes no new entry; it is dropped once flat with nothing working.

| message | 0.6.0 adds |
|---|---|
| `welcome` | `group` (`{id, name}` or null), `seats` (the member accounts in seat order; null for one account), `seatsRev` (an integer, up on every change of the seats). For a group `account` is null and `sim` is true only when every seat is Sim |
| `plan` | `seatsRev` (the one it was sized for) and `sizes`: a plain string of whole numbers in seat order, "5,3,4"; 0 means that seat sits this trade out (the runner found no room for 1 contract). `qty` stays and equals the first size that is not 0; `riskDollars` is stopTicks x tick x point value x the sum of the sizes. Without `sizes` (one account) the plan is exactly as before; a plan with `sizes` for one account is refused |
| `flatten` | optional `account`: that seat only; without it, every seat (one message for the whole group: the 10 a second limit) |
| `answer` | optional `account`: one `placed` or `refused` answer per seat (a seat that sits out: `refused`, "not in this trade: <why>"), then the plan-level answer without `account` (`placed` when at least one seat was placed, naming each seat); an `expired` answer per seat whose entry is cancelled, and `refused` for a seat whose entry NinjaTrader rejects |
| `agentState` | for a group, `seats`: `[{account, owns, position, pnlToday, trades, out}]` (`position` `{root, qty, avgPrice}` or null; `out` the "not in this trade" reason of the last plan placed, or null). `owns` is any seat. `trades` and `losses` count per plan (below) |
| `accountState` | one per seat it follows (each keyed by its `account`), in seat order after the snapshot; a seat that left the group while it holds the agent's trade keeps getting its own until flat |
| snapshot | one `position` per (seat, root) and the working orders of every seat; `order`, `exec` and `position` already carry `account` |
| `agent` (pages) | for a group `group`, `seatsRev` and `seats` (as `agentState`'s, with `sim`, `seat` (false: it left the group), `lastPlan`, `size` and `risk` of the last plan on it, and `lastPnl`: its trade's dollars once closed) |
| `agentPlan`, `agentProposal` (pages) | `sizes`, `seatsRev` and (once checked) `seats`: `[{account, size, risk, out, placed}]`; a group's proposal has `account` null and `group` |

**Checks on a group's plan** (the contract's checks 1 to 11, in order, in every mode, and again at the moment of placing under
the agent's gate): plan-level as for one account, with these in check 2: `groups.txt` readable, the group has accounts, `sizes`
and `seatsRev` present, a plan with another `seatsRev` refused whole ("the group changed; size again"), one size per seat, `qty`
the first size that is not 0, no clash on any seat (a clash stands the whole agent down, as for one account). Check 4 holds every
size to the same caps (ChartBridge never resizes); check 5 is the sum. Check 8 (one at a time) counts every seat: one position and
one entry at a time for the whole group. Check 9 counts per plan (Q3 a). Per seat (Q1 b): its size 0, not tradable or not
connected (check 2's account rule), a position or order that is not the agent's (the owner lock, check 10), and the one-direction
check (10b) make that seat sit the trade out; the plan is placed on the others, and refused only when no seat can take it ("no seat
of group Lucid can take this plan: SIM-A: ...; SIM-B: ...").

**Placing.** Under the agent's gate, after every check passed again: seat by seat, in seat order, through
`ChartBridgeOrders.PlaceAgentEntry` with that seat's account and size (every v2 gate, the owner lock and the one-direction check
under `PlaceLock` for each seat; `PlaceLock` is never held across seats, because `PlaceOrder` writes the plans file after it lets
the lock go), each in its own try, all with the plan's id. A seat the order path refuses, or whose entry NinjaTrader rejects at once,
is refused there; the others go on. The order path asks the agent at the last moment for each seat (`PlacingProblem`, under `PlaceLock`): once its socket has dropped, no further seat is placed ("agent <id> is not connected"), and the drop cancels any seat's entry already placed. Each seat's entry is its own (its own tag, legs from each of its fills, its own ledger).

**Counting (Q3 a).** maxTrades and maxLosses count one per plan: a group plan's seat trades (tags with a `#seat` line) are one
trade; it is a loss when their sum is below 0, once every one of them has closed. Every other trade counts by itself, as before.
`pnlToday` is the sum of every seat.

**Timers and stops.** Kill, the heartbeat lost, no connection for 5 s, leaving Auto, a withdraw, the plan's expiry and the window
cancel unfilled entries on every seat. flatAt (and a position outside its hours) runs per (seat, root): each seat's job closes at
most its own trade there (the per-seat close cap). TradeLost per (seat, root), with the 0.5.7 hold. The 17:00 reset puts the agent on
None only when no seat is exposed and every member is idle; otherwise it stays, and the note names the accounts holding something.
One direction per group and exits never blocked (0.5.8) are unchanged: no hedging inside a prop group, ever.

**Restart.** The day file adds `#seat<TAB><tag><TAB><account>` for each group seat's entry tag still of today (its trade, its
working entry, a trade carried over); a ChartBridge before 0.6.0 reads it as a comment. A restart restores the seat to tag mapping,
and a seat that holds something of the agent's (one that left the group too) is followed again.

### A group's Type and default hero (0.6.1)

SPEC CE-1, Phase 4 pieces 3 and 2 (DECISION 2026-10-15k). ChartBridge stores two fields per group and checks their shapes only; it
does not know heroes or tiers, and nothing in the order path reads them (no new trading restriction).

- **Fields.** `groups.txt` gains the Type and the default hero after `consistency` (above). `groupSave` takes them as `accountType`
  and `hero` (the message's own `type` is its kind, so the group's Type travels as `accountType` on the wire); both optional, absent
  keeps what the group has (a new group: not set and none), so a page before 1.28.0 (the No hedging switch, Rename) never drops
  them. `-` clears. Refused, with nothing saved: `accountType must be eval, funded or - (not set)`; `hero must be a build name of 1
  to 64 letters, digits, dots, underscores or hyphens, or - (none)`. The `groups` message carries both (null for not set and none).
  A type or hero in `groups.txt` that ChartBridge cannot read makes the file unreadable, as every other field.
- **The page (1.28.0).** Settings, Account groups: the rules dialog's Type (Evals, Funded, Not set) and Hero on duty (None, then
  every hero the PC helper lists, each with its tier and, when its tier does not fit the Type, a warning; he can pick any). The
  Agent tab's build picker, for an agent on a group, preselects the group's default hero (after a build he picked, or the one he
  runs) and lists every hero with its fit warning. Tier fit, shown only, never enforced: Not ready fits nothing ("Not ready: gym and
  Sim only"); Acceptable fits Evals ("Acceptable: evals only; funded only when no Good or better hero is on duty"; guidance "at most 3
  evals at once"); Good, Great and Exceptional fit both; no tier: "tier unknown"; no Type: no fit warning ("type not set").
- **The PC helper's `GET /status` `builds` rows** (Bot-Lab fills these later; all optional): `hero` (name or null), `tier` (`Not
  ready`, `Acceptable`, `Good`, `Great`, `Exceptional`, or absent), `edge`, `examEdge`, `liveEdge` (R), `liveN`, `standingAt`,
  `standingNote`. Absent: "tier unknown (no rating on this PC yet)"; the helper not answering: "tier unknown (the PC helper is not
  answering)".
- **The heroes-on-duty board** (the Agent tab's Board): one row per agent slot that is on (the helper says so, or it is connected)
  or has an account or a group: hero name and build, tier chip, the group and the accounts it leads (or the one account), mode,
  position (a group's summed per root over its seats), today's R (this page's record of his fills, from each plan's own risk), the
  room (the tightest seat's daily room and floor room, ChartBridge's own `accounts` numbers, as `accountState`), and its own Kill
  (`agentKill` on, one click). KILL ALL AGENTS sends `agentKill` on to every agent not killed, in one click. A NO HERO row per group
  no agent trades, with Assign hero: a free slot is an agent id on None and Off (the helper says it is not on); the page sends the
  existing `agentAccount` `{agent, group, keepMode: "shadow"}` (a LIVE member asked once in the page), waits up to 10 s for the
  `agent` message naming the group, then the helper's existing `POST /on` with the group's default hero in Shadow (no default hero
  the helper has: he picks one). No free slot: "add an agent id to config.txt (agents = ...)"; ChartBridge never writes config.txt.
  Every start is Shadow; Auto stays one click and Confirm on his desk.

### Group stand-downs and league seats (0.6.2)

SPEC CE-2, Phase 4 pieces 5 and 4 (DECISIONS 2026-10-15i, 15j, 15k and 16m). Built in `nt8/ChartBridgeAgents.cs`. ChartBridge does not
rate heroes: the runner decides a stand-down (edge watch, a tier drop, below Acceptable, a blow streak) and raises it; ChartBridge holds
it and gates entries; only Anthony clears it, on the Board. Made-up names below.

**The file.** `agent-standdowns.txt` next to `config.txt`, written only by ChartBridge, whole through a temp file: two `#` lines, then
one line per stand-down:

    standDown<TAB><build><TAB><group id><TAB><UTC ms><TAB><kind><TAB><why>

`build` is the agent's `agentHello` build exactly (1 to 40 characters); `kind` 1 to 40, `why` 1 to 200 (plain strings: no tab, quote,
backslash or control character, nothing a reader would trim). One line per build and group. It is read once at the start (when the
agent channel is on) and survives restarts and the 18:00 roll (nothing rolls it). A line whose group is not in `groups.txt` is dropped at
the start (only when `groups.txt` exists and reads: with no `groups.txt` every line is kept and the file is not rewritten). A group deleted on the page (`groupDelete`) drops its lines at once, in memory and the file,
under the groups' own save, so a group made later never inherits one. A file that cannot be understood (a line it does not know, a build
and group twice) or read is **never written over that run**. Anthony's ruling (2026-10-16): while it cannot be read, an agent entry is
refused only on an account in a prop group (any group in `groups.txt`): "agent-standdowns.txt has a line ChartBridge does not
understand: every new agent entry on an account in a prop group is refused until it can be read (accounts in no group keep trading;
exits always work); fix or delete the file, then recompile (SIM-E is in group Lucid)". An account in no group (a Sim league seat, a
personal account) keeps trading, and exits always go. With `groups.txt` unreadable too (membership unknown), every account that is not
Sim is refused ("... groups.txt cannot be read either, so EVAL-A (not Sim) is refused ...") and a Sim account is allowed by this rule
(`groups.txt`'s own rule still refuses every entry while it cannot be read). Checked at plan check 2 (an agent on a group: the whole
plan; on one account: by that account) and per seat under `PlaceLock` (`ChartBridgeAgents.BrokenRefusal`). The pages get the alarm at
the start and `agentStandDowns.error`; a raise then holds in memory only and a clear is refused. A raise that
cannot be written holds in memory (the gate holds at once) with an alarm that a restart would lose it; a clear that cannot be written is
refused and the stand-down stays.

**What it gates: entries only.** While build B stands down on group G, no new entry from an agent whose build is B goes on any seat in G:

- plan check 2 (after the files, before any other check): an agent on G refuses the whole plan; an agent on one account that is a member
  of G refuses it (its one seat); refused as "build B stands down on group Lucid (edge watch: ...): no new entries from it on that group
  until Anthony clears it on the Agent tab's Board (exits always work)";
- again per seat under `PlaceLock` (`ChartBridgeAgents.PlacingProblem(id, account, ...)` from `PlaceOrderLocked`): the seat's own group
  and the group the agent trades, read at that moment, so a stand-down raised mid fan-out stops the seats not yet placed;
- the backstop and `agentState.standDown` / the strip's `standDown` carry the words, so every pass cancels a stood-down agent's
  unfilled entries.

Raising it cancels that build's unfilled entries on that group (answers `expired`) and expires its open proposals (`expired`, "agent
<id> stands down: ..."). Positions keep their stop and target. Never gated: exits, Flatten, the agent's own `flatten`, the protective
exit, the legs, flatAt, the stop placed again over a shut market, cancels. Another build on the same group, and the same build on an
account in no group or in another group, trade as before. A league seat (no group) is never stood down by a group's line, nor by the unreadable file (only a
not-Sim account while `groups.txt` cannot be read either).

| direction | message | notes |
|---|---|---|
| agent to ChartBridge | `standDown` `{group, kind, why}` (no other keys) | raise only: there is no clear from the agent. The group must be in `groups.txt` (lead's default: any group, not only the one it trades; while `groups.txt` cannot be read it is taken, since a stand-down only refuses). Raised again while in force: kept as first raised, logged once per build and group. A raise for a group in `groups.txt` is always taken; only while `groups.txt` cannot be read (a group ChartBridge cannot find) is a raise refused once 200 stand-downs are in force, logged, with one alarm per build and group. Refused with `reject` |
| agent to ChartBridge | `agentHello` (0.6.2) | the build must read back the same (1 to 40 characters, no space at either end, so a build cut at 40 on the space before its stamp is refused), and it is one build per connection: a second hello with another build is refused and logged (reconnect to run another build) |
| ChartBridge to the agent | `welcome.group` (0.6.2) | `{id, name, accountType}`: `accountType` the group's Type from `groups.txt` (`eval`, `funded`, or null when not set); `group` stays null for one account. Order path untouched |
| ChartBridge to the agent | `agentState.groupType` (0.6.2) | the same value (null for one account or None), so a Type changed in Settings reaches the runner within a pass, without a reconnect |
| ChartBridge to the agent | `agentState.groupStandDown` | `{group, kind, why, at}` for the group it is on now (its group, or its one account's group), or null |
| page to ChartBridge | `agentStandDownClear` `{cid, build, group}` (no `agent` key) | signed-in v3 pages only (the agent messages' gates), counted in gate 7. Logged "stand-down of build B on group Lucid (g1) cleared on the page (it was ...)" in the Output window and each agent of that build's log; a `status` `info` to the pages. A clear holds until the runner's next re-rating raises it again |
| ChartBridge to page | `agent.standDowns` | `[{group, why, kind, at}]`: every stand-down of the agent's build (its last hello's) |
| ChartBridge to page | `agentStandDowns` | `{list: [{build, group, name, why, kind, at}], error}`: every stand-down in force (so a hero not connected is seen too), after sign-in and on every change; `error` why the file cannot be read, or null |

**League seats.** `agentAccount` gains `league` (optional bool): `{agent, account, league: true}` makes the agent a league seat on that one
account. Refused: with `group` ("a league seat is one Sim account, never a group"), with `account: null` ("a league seat needs its Sim
account ..."), and on an account that is not NinjaTrader's simulator ("agent <id> is a league seat: Sim accounts only (EVAL-A is not
NinjaTrader's simulator)"); the provider is read fresh from NinjaTrader each time and an unknown provider is no Sim. The same account
with `league` absent or false is a plain seat again. Saved as `league<TAB><account>` in `agent-<id>-account.txt`; a ChartBridge before
0.6.2 does not understand the line and stands the agent down (as the group line). A league seat's entries are refused whenever its
account is not Sim, read fresh at plan check 2 and again per placement under `PlaceLock` ("agent <id> is a league seat: Sim accounts
only"), so a provider changed after the start is caught. `welcome` and `agent` carry `league` (true or false). A league seat starts in
Shadow like every agent, and the 17:00 reset puts it on None (league off) like every agent. No other new trading restriction.

**The page (1.29.0).** The Board shows each stand-down as an amber row under its hero (the hero, the group, the kind and why, since when
in New York time, "No new trades from this hero on Lucid until you clear it; exits, stops and targets always work") with **Clear
stand-down** (one click, `agentStandDownClear`); a stand-down of a hero no row shows gets its own amber row; the unreadable file's
error leads the board. A league seat's row shows PROVING n of 100 (n the PC helper's `liveN` for its build; "PROVING (live trades not
reported)" without it) and "league seat (Sim only)". The Agent tab's account picker lists a league seat on every tradable account after
the single accounts: Sim offered ("League seat: SIM-A (SIM)"), a LIVE one listed with the reason and never offered.

### Each member's own rules and the risk percent (0.6.5)

Anthony's ask of 2026-10-19 (PRIORITY, "build it into the current build"): trade accounts of different types and sizes in one group
(a 150K Flex eval, a 50K Flex eval and a 25K Daily intraday eval, more 50K evals joining). Before 0.6.5 a group had one rule set, so
two of three floors had the wrong numbers. Built in `nt8/ChartBridgeGroups.cs`, the page's Accounts tab and Settings (`live/accounts.js`,
`live/groups.js`, chart 1.33.0). Made-up names and money below.

- **What the member holds, what the group holds.** Each member account carries its own rules: account size, daily loss (or none),
  drawdown amount and type (`eod`, `intraday`, `static`), floor stops at (or none), profit target (or none), consistency (or none),
  max size in minis and in micros (or none), and The Desk's account type id it came from (or none). The group holds what is shared:
  name, Type (Evals, Funded), hero on duty, No hedging, and the risk percent. The group's own rules stay: they are the rules of a
  member with none of its own (every member of a 0.6.4 or older file), and the Settings dialog still edits them.
- **Numbers per member.** Floor, room, daily room and target left (the table in 0.5.8) come from the member's own rules: its floor
  trails from its own highest close (`eod`) or highest balance (`intraday`) in `account-marks.txt`, stops at its own lock, never
  below its own size less its drawdown; room is equity less its floor; daily room is its own daily loss plus today's P&L. A
  member with no daily loss or target of its own gets `why` "SIM-A's rules in Lucid have no daily loss limit" (a member on the
  group's rules: "group Lucid has no daily loss limit", as before). The missed-close warning (0.6.3) follows the member's own
  drawdown type. `accountState.rules` carries the member's own numbers (the seven keys as before, then `maxMinis` and `maxMicros`, 0 none).
  ChartBridge holds every member's rules in `groups.txt`, so all of it works while The Desk is down.
- **Max size** caps a group entry from the ticket (below); the copier, agent group trading and the single account gates are unchanged.
  (0.6.6: the max now holds every entry, each kind against its own number: "The firm's limits on entries (0.6.6)".)
- **The risk percent** (`riskPct`, Anthony: of each account's max loss, its drawdown amount: 10% is $200 on a 50K with a $2,000 max
  loss, $450 on a 150K with $4,500) sizes a group entry from the ticket (below). The copier, the agents and the bot never read it.

**Trade the group (Anthony 2026-10-19).** On the page's order connection (the order gates, counted as order actions):

| message | fields (no others) | answer |
|---|---|---|
| `groupPreview` | `cid`, `group`, `root`, `side`, `kind` (as `order`), `price` (not market), `limitOffset` (stopLimit), `bracket` `{stop, target}` with `stop` at least 1 | `groupPreview` `{cid, group, name, root, side, kind, stopTicks, riskPct, members: [{account, size, risk, budget, out}]}` in seat order (by name); nothing is placed |
| `groupOrder` | the same and `sizes` (the accounts with the sizes confirmed, in seat order: "SIM-A:4,SIM-B:2,SIM-C:1,SIM-D:2"; review of d7c8e50: any other account, order or size refuses the whole entry) | refused whole when the members or any size changed since ("the sizes changed since the preview (SIM-A 5 confirmed, 4 now): nothing was sent; look again and send"); else each member with a size gets its own `order` (its account, that qty, the bracket) through the order path, then `groupPlaced` `{..., placed, members}` with `out` "refused: <why>" for a member the order path refused |

A `strategy` object (an Order Strategy, as on `order`; never with `bracket`) may go in place of the bracket: its `stop` sizes each
member, and each member's entry is its own managed strategy entry. Each member: budget = riskPct x its drawdown / 100; contracts =
floor(budget / (stopTicks x tick x point value)). The room caps count all its open stop risk on that side first (Anthony's answer 4):
for every position it holds on that side, each working stop (stop or stop-limit on the other side, the farthest first, up to the
position) times its distance from the last price (0 past the price in profit) times the point value; a contract held with no working
stop, or no recent price, makes it not known ("its open stop risk is not known (it holds 4 NQ with no working stop for 4 of them)"),
and it sits out. A group's order lines on the page are moved by one `change` per member to the same price, each checked as on one
account.

Review of d7c8e50 (the coordinator's decisions): the open stop risk is every position on BOTH sides at its working stops (each
contract month from its own last price: another month with no price makes it not known) plus every working entry (resting, or a
market one not yet filled; single or group) at its own stop (its bracket's, its planned or its strategy's stop and stop-limit ticks)
times its contracts; an entry whose stop ChartBridge does not know makes it not known. The max size counts every instrument in mini
equivalents (10 micros are 1 mini): held plus working plus the new entry against `maxMinis`, or `maxMicros / 10` when only micros
are set (0.6.6: micros against `maxMicros` where the firm gives one, minis against `maxMinis`; was the smaller of the two in mini
equivalents when both were set). A strategy entry is sized from its stop plus a stop-limit's ticks. The bracket cap (`maxBracketTicks`) is applied at the
preview. One lock (`GroupEntryLock`) holds a `groupOrder` from its sizing to its last member's order, and every page entry takes
it before `PlaceLock`, so two windows never both pass the room check. The `groups` message adds `tradeOut` per group
(`[{account, why}]`, the members a group entry leaves out: the copier's leader or a follower, the bot's account, an agent's); the
page's group Close, Flatten all, Cancel all, B/E and lines leave them out and say so. It sits out with
its reason when its room to the floor, or its daily room under a daily loss rule, is not known; when it is the copier's leader or a
follower, the bot's account or an agent's; when it rounds to 0. Never above its max size (MaxMinis, or MaxMicros for MNQ, MES and the
other micros) nor `maxQty.<root>` less what it holds and has working on that side (an add is sized the same way); the stop loss
within its room to the floor and its daily room. Refused: no `bracket` or a stop of 0 ("a group entry needs a stop: each member is
sized from its stop loss (set the bracket's stop)"), the group's risk off ("group Lucid has no risk percent: set Risk % of max loss in
Settings, Account groups"), no member able to take it. `accountState.rules` adds `maxMinis` and `maxMicros` (0 none). A ChartBridge
before 0.6.5 knows neither message (the page lists no group in the ticket then).

**groups.txt.** A `group` line may carry a 14th field, `riskPct|-` (more than 0, at most 100, at most 2 decimals; `-` off), written
only when the risk is on or a later ChartBridge's fields follow it, so a group with risk off is written exactly as 0.6.4 writes it.
One line per member with rules of its own, after the member lines:

    rules<TAB><account><TAB><size><TAB><dailyLoss>|-<TAB><drawdown><TAB>eod|intraday|static<TAB><lockAt>|-<TAB><target>|-<TAB><consistency>|-<TAB><maxMinis>|-<TAB><maxMicros>|-<TAB><typeId>|-

Checked as `groupSave` checks (the drawdown below the size, a lock only on a trailing drawdown and above the starting floor), max size
whole contracts 1 to 1000; fields after `typeId` are kept as read. A rules line ChartBridge cannot read, or an account given rules
twice, makes the file unreadable (0.6.5 also refused a rules line for an account in no group; 0.6.6 writes and reads those: its own
firm rules) (the 0.5.8 rule: every entry refused, never rewritten that run).
**Migration:** a member with no rules line inherits the group's rules, so a 0.6.4 file loads, gives the same numbers and is written back
line for line as 0.6.4 writes it (only the second `#` line, the format note, names the new line). **Going back:** a ChartBridge 0.5.8 to 0.6.4 knows group, member and personal lines only, so a file with a rules line
reads as unreadable there (every entry refused with its alarm, the file never rewritten): it never trails a floor from the wrong
rules. Before going back, put each member with rules of its own in None and in its group again from a 1.32.0 page (it joins on the
group's rules, so its rules line goes).
A group with risk on and no rules line reads in 0.6.1 to 0.6.4 as before (the 14th field kept as read).

| message | 0.6.5 adds |
|---|---|
| `groupSave` | `riskPct` (optional: 0 off, else above 0 and at most 100, at most 2 decimals; absent keeps the group's, so a page before 1.33.0 never drops it). Refused: "riskPct must be a percent of each member's max loss from 0 (off) to 100, at most 2 decimals" |
| `accountGroup` | the member's own rules, all or none, joining a group only: `size`, `dailyLoss`, `drawdown`, `drawdownType`, `lockAt`, `target` (all needed once any is there), `consistency`, `maxMinis`, `maxMicros` (whole, 0 or absent none), `typeId` (The Desk's type id, or `-`). None sent (a page before 1.33.0): the group's rules apply, and any rules the account had go. The seed of both highs without `highClose`: the larger of its own size and its balance. Refused with `groupSave`'s words, and "rules go with joining a group only" |
| `memberRules` (new) | `cid` (optional), `account`, and the same rule keys (size, dailyLoss, drawdown, drawdownType, lockAt, target needed): a member's rules changed later. Its highs stay as they are. Refused for an account in no group ("SIM-C is in no group: its own rules are for a member of a group (My floor and My daily are for an account in no group)"); 0.6.6 takes it there (below) |
| `groups` | each group gains, after `holders`, `riskPct` (null off) and `ownRules` (the members with rules of their own). A page tells a 0.6.5 ChartBridge by `riskPct` being there |
| `accounts` | each entry gains `rules`: a member's rules `{size, dailyLoss, drawdown, drawdownType, lockAt, target, consistency, maxMinis, maxMicros, typeId, own}` (null for none; `own` false: its group's), null in no group |

Leaving a group (None), and a deleted group, drop the member's rules line; joining the group it is in already is refused and keeps them.

**The page (1.33.0).** Anthony (2026-10-19): "I shouldnt have to manually assign the account types ... so its all automatic". Picking a
group on the Accounts tab takes the account's rules from its type on The Desk (GET /api/chart-accounts `accountType`, GET
/api/account-types; each number set on the account itself on The Desk, its `source` `account`, wins over the type's) and shows one
compact row: the rules taken, the risk dollars, and the "highest close so far" (EOD) or "highest balance so far (intraday)" question,
prefilled from The Desk's seed floor plus the drawdown when The Desk sends one (`seed_floor`, with `seed_date` and `seed_balance`, per
prop account), else as before. Put in sends `accountGroup` with the rules; Edit rules opens the full form. Only an account with no type
on The Desk (or The Desk not reachable, or a type missing a size, drawdown or drawdown type) gets the full form, prefilled with the
group's rules and the reason. A member's Limits cell shows its floor and Rules (the same form, sent as `memberRules`). Settings: the
group's row says how many members have rules of their own and the risk with each member's dollars; the rules dialog has Risk % of max
loss. With a ChartBridge 0.5.8 to 0.6.4 (no `riskPct` in `groups`) the page joins exactly as 1.32.0 did and sends no new key.

### The firm's floor, Remove a follower and the firm's limits on entries (0.6.6)

Chart 1.34.0 and ChartBridge 0.6.6 (Anthony's work requests and decisions of 2026-10-20). Built in `nt8/ChartBridgeGroups.cs`,
`nt8/ChartBridgeOrders.cs`, `nt8/ChartBridgeCopier.cs` and the page (`live/accounts.js`, `live/trade.js`, `live/workspace.js`).
A page tells a 0.6.6 ChartBridge by `hello`'s `version`. Made-up names and money below.

**The floor from the firm's rules (Anthony: "the floor and thus the % used for certain accounts is still wrong").**

- `memberRules` is taken for an account in **no group** too: those are its own firm rules (its type's), kept as a `rules` line in
  `groups.txt` (read at the start since the fix in 0.6.6; the first 0.6.6 build refused that file at the next start), so its floor
  trails and locks as the firm's does. The `accounts` entry's `rules` then carries them (`own` true) while `group` stays null.
- The room to the floor computed from the rules (the lock included) is the room. NinjaTrader's own trailing figure (the broker's,
  which never locks) is used only when nothing is computed, and is always sent beside it: the `accounts` entry gains `roomFloorNt`
  (null when NinjaTrader gives none), and `src.roomFloor` says which one `roomFloor` is (`computed` or `ninjatrader`). Before 0.6.6 the
  smaller of the two won, so the unlocked figure could win.

| message | fields (no others) | answer |
|---|---|---|
| `firmMinimum` (new) | `cid` (optional), `account`, `minBalance` (dollars, more than 0, at most 2 decimals): the minimum balance the firm's dashboard shows | both highs of the account (end of day and intraday) set to `minBalance` plus its drawdown, so the computed floor equals the firm's from then on; the missed-close marks cleared; `groups` and `accounts` sent at once. Refused: no rules yet ("SIM-D has no firm rules yet: apply its account type first (the floor comes from its drawdown and lock)"), a static drawdown (its floor is fixed), below the starting floor (size less drawdown), above the lock, `account-marks.txt` unreadable, an account ChartBridge does not list |

**The page (1.35.0): Update floors from The Desk.** No new message: the Accounts tab reads every prop account's floor from The
Desk (`GET /api/chart-floors`), shows them, and on Anthony's one confirm sends the existing `firmMinimum` above for each account
ChartBridge lists with firm rules and a trailing drawdown, 150 ms apart; ChartBridge checks each as above. A `firmMinimum` not
refused within 3 seconds is kept in the page's browser, and for that account the page no longer flags NinjaTrader's own room to
the floor (`roomFloorNt`, which never locks); it stays in the Room's hover.

**Remove a follower row (WORK 2026-10-20).** An off follower row left from the October copier tests kept its account out of every
group entry (a follower, on or off, is never a group's or an agent's seat).

| message | fields (no others) | answer |
|---|---|---|
| `copierFollowerRemove` (new, copier lane, `copier` switch) | `cid` (optional), `account` | the row is gone from `copier.txt` and the `copier` state is sent; the account is its own again. Refused: not a follower ("SIM-F1 is not a copier follower."), on ("turn it off first, then remove it"), the copier still holds a position or orders there ("it can be removed once the copier's part there is flat and done"), `copier.txt` unreadable at the start |

The `copier` state gains `canRemove: true` (after `simOnly`): the page shows Remove only then (an older ChartBridge knows no such
message).

**The firm's limits on entries (Anthony 2026-10-20: "Only absolutely critical things should stop an account from trading").**
Anthony is the final arbiter on his own orders. No pop-up or "send anyway?" before an entry, and no order is ever blocked because
data is missing (The Desk down, a close not seen). Only the part of an order that opens or adds is checked (an order past flat: what
it opens; the position it closes no longer counts); exits, closes, flattens and stop or target moves never are. The review: the
position it closes is the LARGER of ChartBridge's two readings (NinjaTrader's list, and with fills reported but not in it yet), so an
order that reduces by either reading is never checked.

- **The firm's max contracts** (`maxMinis`, `maxMicros` in the account's rules, a fixed number typed in, never stale; none set: no
  check). One combined rule whatever the entry's instrument (Anthony's ruling on the review: "10 micros = 1 mini"): after the order,
  the account's total in mini equivalents (minis + micros / 10, held and working, every instrument) at most `maxMinis` when it is
  set, and its total in micro equivalents (minis x 10 + micros) at most `maxMicros` when it is set; the order of the trades never
  changes the answer (a 2 minis / 40 micros account holding 15 MNQ may not buy 1 NQ, and holding 1 NQ may buy 10 MNQ, not 15). The
  same rule caps a group member's size. Words:
  "over SIM-B's max of 4 minis: this entry of 5 NQ would take it to 5 minis (it holds or has working 0, every instrument). Nothing
  was sent; 4 NQ at most".
- **Anthony's own entries** (the page, one account; also each member's entry of a group entry, already sized within it): that one
  check, refused as a `reject` with those words (the ticket's note). No floor, daily room or no-stop check is added; the copier's
  "a leader entry needs a stop while armed" (0.4.0) and the page's first-order NO STOP question (1.13.0) are unchanged.
- **The bot, an agent and a copier follower** (no one at the keyboard): one shared check (`MachineHold`) in front of each entry
  (the order path for the bot's and every agent's, each seat of an agent's group plan on its own; the copier's `Eligible` for each
  follower's copy) holds it back only on a KNOWN breach: the max contracts; this entry's stop risk (its contracts x its stop ticks x
  the tick value; a copy's: its distance to the leader's stop) plus the account's open stop risk (the group sizing's: every position
  at its working stops and every working entry at its own stop) more than a known room to the floor or a known daily room ("its stop
  risk $2,000 is more than SIM-B's room to the floor $1,500"); or the account's daily loss already reached that trading day. A room, the
  entry's own stop risk or a balance not known (null; a balance of 0 is NinjaTrader not having given one yet) lets the entry go. The
  open stop risk not known counts as 0 (it is never below 0): the entry's own stop risk alone past a known room still holds it ("its
  stop risk $2,000 alone (the open stop risk not known) is more than ..."). A follower skips that
  one copy (`copierEvent` skip, label `limit`); the leader and the other followers trade as normal. Each hold sends one `riskAlert`
  (`held`, or `skipped` for a copy): "Held: the bot's entry on SIM-B: ..." or "Copier: SIM-F1 skipped this copy: ...".
- **The daily loss reached.** Each second ChartBridge reads every listed, connected account's numbers; one whose known daily room is
  0 or below (with a balance given) is marked for the rest of that trading day (18:00 ET to 18:00 ET), with one `riskAlert`
  (`dailyLoss`): "SIM-C reached its daily loss limit of $500.00 (daily room -$100.00): the bot, the agents and the copier send no new
  entry on it until the next trading day (18:00 ET). Your own orders are not held, and nothing was flattened." The mark holds even
  if the room comes back that day (an open loss recovering); it is memory only, so after a restart a room still at or below 0 marks
  it again.
- **Nothing ever flattens an account on its own.** The firm does that at its daily loss limit. (An agent's flat time is the agent's
  own rule and unchanged.)
- **A group member whose room or open stop risk is not known** (Anthony's ruling on the review: "size it anyway"): it no longer sits
  out. A room not known: that room's cap is skipped (its risk percent, its firm max and `maxQty` still cap it); the open stop risk not
  known: a room that IS known caps this entry's own stop. `groupPreview` and `groupPlaced` members gain `note` (only when it is so):
  "room unknown: sized by risk only (its room to the floor: ...)" or "open stop risk unknown: its room caps this entry's own stop only
  (...)". A member that is not connected sits out ("it is not connected"; 0.6.5 said its room was not known). The page shows the note
  quietly on the ticket and never asks a confirm for it.
- **groups.txt that cannot be read** (Anthony's rulings: "My single orders go", and of 2026-10-21: never block the bot, the agents
  or the copier; "the last groups that read cleanly"): his own single-account entries go (its group, and so the one-direction check,
  cannot be known then); group entries from the page and every change are refused (the page's banner says why) and the file is never
  rewritten. ChartBridge writes `groups.txt.good`, the file exactly as it last read cleanly or was last saved, after every clean read
  and every save (written through to the disk and swapped in, as groups.txt is), with an end line `# end <lines before it>`: a
  copy cut short (its end line missing or its count wrong) is no clean copy, so the machines wait. While groups.txt cannot be read (a file that cannot be opened after 5 tries 0.1 s apart included, or missing with a
  copy left beside it), the bot, the agents and the copier run on `groups.txt.good` only: never `groups.txt.bak` (the copy before the
  latest save, one change behind) nor `.tmp`. Their one-direction check, an agent's seats and the firm's rules and rooms come from
  it. With no `groups.txt.good` there is nothing to run on, so their entries wait. Every exit goes, as before. The Q-EXIT pass that
  cancels an exit left behind in a group (`Leftovers`) stays off while groups.txt cannot be read, even when the machines run on the
  copy. Either way the alarm is a `status` `error` to every signed-in page, which shows it as its banner with the alert sound, never
  a dialog. Its text: "groups.txt could not be read: group entries are refused until it can (your own single-account orders and
  every exit still go)", then "; the bot, the agents and the copier run on its last good copy (groups.txt.good, from the copy of
  2026-10-21 08:14 ET)" (the time `groups.txt.good` was written, New York time) or "; no copy of the groups read cleanly, so the
  bot's, the agents' and the copier's entries wait until it can", then why. While the machines run on the copy, each entry of the
  accounts message gains `fromCopy` ("from the copy of 2026-10-21 08:14 ET"): its floor and rooms were worked out from it, and the
  page says so beside them.
- **The accounts message** entries gain `unserved` (last): the contracts the account holds or has working orders in that ChartBridge
  does not serve, by name (`["YM 12-26"]`, empty for none), which no flatten from the page can reach.
- **Going back to 0.6.5 after 0.6.6.** 0.6.6 writes the firm's rules of an account in no group as a `rules` line in `groups.txt`;
  ChartBridge 0.6.5 (and the first 0.6.6 build) refuses such a line, so the whole file reads as unreadable there (every entry refused,
  never rewritten). Before going back, take those accounts' rules off (put each in a group and in None again from the page, which drops
  its rules line) or remove those lines from a copy of the file.

**The page (chart 1.34.0).**

- `riskAlert` shows in the banner the page uses for ChartBridge's errors (red for `dailyLoss`, amber for `held` and `skipped`), with
  a short sound, once per window (both of a window's connections bring it), never a dialog; the Account page's log keeps it too.
- **Flatten every account** (Anthony, approved 2026-10-20): its own button in the top bar beside Flatten all, one confirm listing each
  account and what it holds. It sends a `flatten` for every account ChartBridge lists with a position or a working order (the
  copier's leader and followers, the bot's and the agents' accounts included; the window's v3 connection lists them all), whatever
  the ticket shows, with Armed off, paced within the 10 order actions a second as Flatten all (a flatten refused for the rate goes
  again once). ChartBridge checks each as any `flatten` (an exit). Flatten all on None still sends nothing. No new message. Holdings in
  a contract ChartBridge does not serve (`unserved`, and any order or position on a root it does not serve) are named, never sent: "Not
  covered (not served by ChartBridge): FUNDED-C YM 12-26", in the confirm and the note after it (Flatten all says its own account's).
  With no v3 connection the confirm says it covers the trade accounts only.
- The ChartBridge banners float over the top of the grid under the top bar (the review): a banner that opened between pointing at an
  order and dragging it used to push every panel down by its height.
- The ticket shows the account's room for a single account where ChartBridge's numbers give it ("Room $900.00 daily · $1,700.00 to
  floor · entry $40.00 at stop": the daily room, the room to the floor and this entry's risk at its stop), display only.

### The bench (0.6.7)

Anthony 2026-10-22: "I would like to have the ability to quickly swap out accounts in and out of the group while flat ... when I
click and drag a chip into the group, it trades with, when its on the bench, it sits out." Page 1.37.0's Multi-Account panel.

- **A member on the bench stays a member.** Its rules (its own, from its type on The Desk), its highs, its floor and rooms and its
  place in the group's one-direction check are kept; nothing is asked again when it comes back. It **sits out every new group
  entry**: `groupPreview` and `groupOrder` (the page's ticket and its hotkeys) give it size 0 with `out` "benched: it sits out new
  entries (the Multi-Account panel)" (a `sizes` list that gives it more is refused whole, as any changed size); an agent trading the
  group keeps it as a seat in seat order, `welcome` gains `benched` (the benched seats, in seat order; absent when none), a change of
  the bench puts `seatsRev` up, and a plan's seat on the bench sits out with `out` "benched" whatever size it was sent (checked again
  under `PlaceLock` for each seat, so a bench raised mid fan-out stops it there). The bot and the copier never trade a group seat.
- **Exits are never blocked by the bench:** a benched account's own exits, stops, targets, changes, cancels and flattens go exactly as
  before (the bench is read only by the group-entry paths above, never by the one-direction check, an order's checks or a flatten),
  and Flatten group and Flatten all on the page still cover it (a benched account that holds a position, typed into NinjaTrader,
  should not happen; it is flattened all the same).
- **`memberBench`** (page to ChartBridge, the v3 connection, signed in): `{type, cid?, account, benched}`, `benched` true to the bench,
  false back. Refused (a `reject` with its `cid`) unless the account is a member of a group, and **flat by both readings on every
  instrument with no order that may still fill** (its legs, stops and targets included): "SIM-B is in a trade (+2 NQ): it moves once
  it is flat with no working orders", "SIM-A has 1 working order: it moves once it is flat with no working orders"; an account not
  in NinjaTrader or not connected stays where it is (ChartBridge cannot see that it is flat). Already there: nothing changes. Every
  groups change (`groupSave`, `groupDelete`, `accountGroup`, `memberRules`, `firmMinimum`, `memberBench`, `accountLimits`) runs one
  at a time behind the groups' change gate, taken before any other lock, so a second change waits there holding nothing an exit
  needs (review L1). The flat check and the move in memory are made under the group entry lock and `PlaceLock`, so no group entry is
  sized and placed across the move; `PlaceLock` is then let go and `groups.txt` (and the sealed copy) is written with the group entry
  lock and the save lock still held, so a page market exit, a copier exit copy, an agent's close or stop and a flatten placed
  meanwhile (`PlaceLock` only) never wait on the disk (review LOW 1), and no page group entry is sized from a change not yet saved
  (review L2). A page stop or limit order placed on its own counts as an entry (it takes the group entry lock), so it can wait for a
  groups change in progress (normally milliseconds). A write that
  fails: under `PlaceLock` again, if the account (or, for a risk percent, the group) is still flat with no working order, memory goes
  back to what the file holds ("groups.txt could not be saved (...); nothing was changed"); if something was placed on the change
  meanwhile (an agent's group entry takes `PlaceLock` alone), the change stays in memory, the alarm goes up (again at each sign in
  until a save) and the answer is "changed, but groups.txt could not be saved (...): SIM-A is in a trade (+1 NQ) since the change, so
  it stays in effect; it will be saved with the next change". It still comes as a `reject` with its `cid` (an older page shows it as
  refused); page 1.37.0 shows a reason starting "changed, but" as done with a warning. The groups' tick (every second) writes such a
  kept change again, only when no groups change is on and under the save lock alone, until it is in the file (so a restart does not
  read the older file), then sends an `info` status: "groups: groups.txt saved: the change kept in memory after the failed write is
  in the file now". The pages and agents are told either way. `groupSave` with `riskPct`
  for a group and `accountGroup` work the same way (the account's holdings decide for `accountGroup`); a save without `riskPct`
  takes the save lock alone. Joining a group (or leaving it, or the group deleted) takes an account off the bench.
- **The `groups` message** gains `benched` per group: the members on the bench (members still, in `members` too).
- **`groups.txt`:** a benched member's line is `member<TAB>account<TAB>id<TAB>benched` (written only for a benched member, so a file
  with no one benched is exactly what 0.6.6 wrote); `groups.txt.good` is the same text, sealed. **An older ChartBridge (0.6.6 or
  before) reading a file with a benched member refuses it safely:** its reader takes a member line of exactly 3 fields
  (`ChartBridgeGroups.Parse`: `if (p.Length != 3 || ...) { why = at + " is not a member line"; return null; }`), so the whole file is
  unreadable for it: group entries refused, nothing rewritten, the alarm; and since the sealed copy carries the flag too, the bot,
  the agents and the copier find no clean copy and their entries wait; Anthony's own single-account orders and every exit still go.
- **No hedging is always on** (Anthony 2026-10-22, "Always on, no switch"): every group is one direction; a line saved `off` reads
  as on and is written `on`; `groupSave` with `noHedge` false is refused ("No hedging is always on for every group (ChartBridge
  0.6.7): noHedge false is refused"); `noHedge` is optional (true is taken, as an older page sends it).
- **A group's own rules are optional and size no member** (Anthony 2026-10-22: the group's fallback rules dropped; each account's
  rules come from its type on The Desk): `groupSave` may leave out every rule key (`dailyLoss`, `drawdown`, `drawdownType`,
  `target`, `size`, `lockAt`, `consistency`; all or none), absent keeps what the group has, and a new group has none: its line
  carries `-` for the drawdown, the drawdown type and the size (`group<TAB>g2<TAB>Apex<TAB>on<TAB>-<TAB>-<TAB>-<TAB>-<TAB>-<TAB>-<TAB>-
  <TAB>funded<TAB>-<TAB>4`; a 0.6.6 reader refuses that line too: `FileMoney(p[5], false, ...)`). The `groups` message sends their
  rules as null. A group entry sizes only a member with **rules of its own**; one with none sits out: "it has no account type: set
  its type on The Desk and apply it (its Rules on the Accounts tab)". A group's stored rules still give such a member (a 0.6.4 or
  older join) its floor and rooms (the checks that protect the account), never a size. A group with no rules takes a joining account
  only with its own rules (`accountGroup` with the rule keys): "SIM-C has no account type: set its type on The Desk first (group Apex
  takes each account's rules from its type)". A member with no rules in a group with none has no floor or rooms, with that reason.
- **The risk percent changes only while the group is flat** (no position and no working entry on any member): "the risk percent
  changes only while group Lucid is flat: it holds SIM-A +1 NQ; nothing was changed".
- Hero on duty stays in the file as it was (`hero`); the page no longer sets it.

### The stop record to The Desk (0.6.6)

Anthony 2026-10-21: the stop record, measured, never guessed (`nt8/ChartBridgeStops.cs`). ChartBridge's order event for every
watched account (after the order path, in its own `try`) looks at each stop order (stop market or stop limit, whoever placed it:
the page, NinjaTrader's chart or ATM, the bot, an agent, the copier). Each time NinjaTrader's state, the stop price, the quantity
or the filled count changes, it queues one event for The Desk's `POST /api/stop-events` (TheDesk `docs/API.md`, "Trade record"):
`source`, `account`, `instrument`, `root`, `order_id` (NinjaTrader's id as first seen, kept for the order's life), `order_name`,
`side`, `kind` (`stop` or `stopLimit`), `nt_state` (NinjaTrader's state name), `state` (the page's word), `stop_price`,
`limit_price` (a stop limit's, else null), `qty`, `filled`, `oco`, `role` (`entry`, `stop`, `target` or `other`), `by` (when
known, as on fills) and `at_ms` (ChartBridge's clock when it saw it). An update that changes none of those sends nothing; a stop
with no price yet (0) sends nothing. So The Desk has the stop price, contracts and time at send, every modify (new price and
time) and how it ended; the fill and the exit are the fills it already has.

- **On:** `postStops = true` in `config.txt`, or, with no `postStops` line, whenever `postFills = true` (the stop record goes where
  the fills go). `postStops = false` turns it off with fills on.
- **The values are the event's** (`OrderEventArgs`: its state, stop and limit price, quantity and fills), never the order's live
  fields. A final event repeated (NinjaTrader sends some twice) is not a new event. A stop whose instrument has no master instrument
  yet is skipped (one Output line).
- **Queue:** the order event only adds to the queue in memory; nothing is written or sent on NinjaTrader's event thread. Every
  10 seconds the account timer saves `pending_stops.jsonl` next to `config.txt` (replaced atomically) when it changed, then sends the
  oldest batch (10 seconds a request); ChartBridge's stop saves it too, after it stops watching the accounts. The file is written
  outside the queue's lock, so the order event never waits on it. A hard NinjaTrader crash or a power cut can lose up to the last
  10 seconds of stop events (those not saved yet). At most 20,000 events wait: past that the oldest are dropped,
  counted in `/diag` and said once. A batch The Desk calls malformed (400 or 422) is sent one at a time and a single bad event is set
  aside in `rejected_stops.jsonl`. A 404 (a Desk without `POST /api/stop-events`) means The Desk has no stop record: nothing more is
  queued or sent until ChartBridge starts again (said once, the waiting events stay in the file). The Desk stores an event once, so
  a resend is safe.
- **`/diag` `stops`:** `on`, `deskHasNoStopRecord`, `dropped`, `waiting`, `seen`, `queued`, `sent`, `lastSendFailed`, `lastError`,
  `setAside`, `rejectedByDesk`.
- **Order ids:** NinjaTrader's id as first seen. An order with no id yet gets `cb<number>` from a counter that starts again at each
  ChartBridge start, so after an NT8 restart two orders can share a `cb` id (rare; a per-start nonce is for the next release).
- Nothing here places, changes or cancels an order, and nothing the pages get changes.

### The order record to The Desk (0.6.9)

Anthony 2026-10-24 (Phase 2 of his stats suite, approved): every order he sends (market, limit, stop, target) with its price when
sent (`nt8/ChartBridgeOrderRecord.cs`). ChartBridge's order event for every watched account, after the order path and after the stop
record, in its own `try`, looks at every order, whatever its type and whoever placed it (the page, NinjaTrader's chart or ATM, the
bot, an agent, the copier). Each time NinjaTrader's state, the limit price, the stop price, the quantity or the filled count changes,
it queues one event for The Desk's `POST /api/order-events`. An update that changes none of them sends nothing (a final event
NinjaTrader repeats included).

- **A new path, beside the stop record.** `POST /api/stop-events` is unchanged (`ChartBridgeStops.cs` is the 0.6.6 file, byte for
  byte): the same stop events, the same shape, the same queue, so a Desk installed today keeps working. The order record is its own
  path because today's Desk checks `kind` (`stop` or `stopLimit`) and the stop event's exact keys on `POST /api/stop-events`, so
  market and limit orders and the new fields there would be refused. The stop events and the order events of one stop are the same
  changes seen once each way; The Desk may keep using the stop record until it reads the order record.
- **On:** `postOrders = true` in `config.txt`, or, with no `postOrders` line, whenever `postFills = true` (as the stop record).
  `postOrders = false` turns it off with fills on.
- **The event (v 1)**, The Desk's shape:

  | Field | Notes |
  |---|---|
  | `v` | 1 (this contract's version) |
  | `source` | `nt8` |
  | `account`, `instrument`, `root` | as for fills (`instrument` NinjaTrader's contract name, `root` its master instrument) |
  | `order_id` | NinjaTrader's order id as ChartBridge first saw it, kept for the order's life; an order with no id yet gets `cb<start>-<n>`, `<start>` 6 hex characters new at each ChartBridge start (so two starts never share one) |
  | `nt_order_id` | NinjaTrader's order id at this event (text, 64), or null when it has none yet. On some connections the id is empty or temporary at `Initialized` and `Submitted` and changes later; the fills carry the final one, so The Desk matches fills by `nt_order_id` and groups an order's events by `order_id` (review of #71) |
  | `order_name`, `oco` | NinjaTrader's (a `CB#...` name for ChartBridge's own orders), or null |
  | `side` | `buy` (Buy, BuyToCover) or `sell` |
  | `kind` | `market`, `limit`, `stop` (stop market), `stopLimit`, `mit` or `other` |
  | `nt_state`, `state` | NinjaTrader's state name, and ChartBridge's page word (`working`, `partFilled`, `filled`, `cancelling`, `cancelled`, `rejected`) |
  | `limit_price`, `stop_price` | the event's own prices, each null when NinjaTrader gives none (0): a market order both null, a limit its limit, a stop its stop, a stop limit both, an MIT its trigger in `stop_price` |
  | `qty`, `filled` | the event's quantity and filled count (`filled` at most `qty`) |
  | `avg_fill_price` | NinjaTrader's average fill price of the order once something filled, else null |
  | `role` | `entry`, `stop`, `target` or `other` (as on the stop record; an order placed in NinjaTrader is `other`) |
  | `by` | `bot`, `copier` or `agent:<id>` when ChartBridge knows who placed it (as on fills), else null (the page's own orders and orders placed in NinjaTrader) |
  | `decision_id` | the group entry's decision id for its member orders and their legs (below), else null |
  | `change` | what changed: `new` (the first event ChartBridge saw of the order), or a comma list of `state`, `price`, `qty`, `filled` |
  | `quote` | at `new` and at every change that includes `price`: `{"bid", "ask", "last", "why"}`, the bid, ask and last trade price ChartBridge knew at that moment for that exact contract, each null when not known, and `why` (null when all three are known) saying which is not and why: ChartBridge has no live data for that contract (another month, a root it does not serve), none seen yet since the start or a feed reset, or older than 60 s (stale). From the live data ChartBridge already follows: no request, nothing estimated. On every other event `quote` is null |
  | `nt_time_ms` | NinjaTrader's time of the event (UTC ms), null when it gives none |
  | `start`, `seq` | this ChartBridge start's 6 hex characters, and the event's number in it (1, 2, ...), so The Desk can order a start's events |
  | `at_ms` | when ChartBridge saw it (its clock, UTC ms) |

  Example (a market entry at submission):
  `{"v":1,"source":"nt8","account":"SIM-R","instrument":"MNQ 12-26","root":"MNQ","order_id":"m1","order_name":"CB#0a1b2c3d s20 t40","oco":null,"side":"buy","kind":"market","nt_state":"Initialized","state":"working","limit_price":null,"stop_price":null,"qty":2,"filled":0,"avg_fill_price":null,"role":"entry","by":null,"decision_id":null,"change":"new","quote":{"bid":24999.75,"ask":25000,"last":25000,"why":null},"nt_time_ms":1792590300000,"start":"bae5f9","seq":1,"at_ms":1792590300000}`
- **Recording only, never in an order's way:** the order event only reads the event's values and adds a small snapshot to a queue in
  memory (and, at `new` and at a price change, reads the quote under three short locks); no file, no network and no JSON on
  NinjaTrader's event thread. Harness: 20,000 order events, about 5 microseconds each on Mono. Every 10 seconds the account timer
  makes the events, saves `pending_orders.jsonl` next to `config.txt` when it changed (new events appended; the file replaced
  atomically only after events left the queue, so a Desk answering 404 for days never makes it rewrite the whole file), then sends the oldest
  batch (at most 500, 10 seconds a request). ChartBridge's stop saves it too, after it stops watching the accounts. A hard crash or a
  power cut can lose up to the last 10 seconds of events (an event cut short by one is skipped when read). At most 20,000 events wait:
  past that the oldest are dropped (on the timer; the event thread only drops its own oldest snapshot past 20,000), counted in `/diag`
  and said once. What ChartBridge remembers per order (to tell a change from a repeat): the last 20,000 ended orders, the oldest
  forgotten one at a time, and an order with no end for 7 days is forgotten.
- **The Desk's answers:** `2xx` takes the batch (the answer's `rejected` list is logged, as for stops), and the next batch may be twice
  as big (up to 500). `400`, `413` or `422`: the batch is halved until the bad event goes alone, then set aside in
  `rejected_orders.jsonl`. `404` (a Desk without `POST /api/order-events`, today's): every
  event stays (memory and file) and is offered again every 5 minutes (said once), so nothing is lost before The Desk's side ships.
  Anything else: tried again on the next 10 seconds. The Desk stores an event once (`start`, `seq` and `order_id` name it), so a resend
  is safe.
- **`/diag` `orderRecord`:** `on`, `deskHasNoOrderRecord`, `dropped`, `waiting`, `seen`, `queued`, `sent`, `observeMeanUs` (the event
  thread's mean cost), `lastSendFailed`, `lastError`, `setAside`, `rejectedByDesk`, `start`, `decisions` (`made`, `ordersNoted`,
  `kept`).
- Nothing here places, changes or cancels an order, and nothing the pages get changes.

### The decision id of a group entry (0.6.9)

Anthony 2026-10-24: a group entry (one entry sent to several accounts by the page's group ticket, `groupOrder`) counts once as a
decision. Each `groupOrder` that places at least one member makes one decision id, `d` and 12 hex characters. ChartBridgeGroups sets
it, on the placing thread only, around each member's own placing (`PlaceOrder`, unchanged); the member's entry order takes it when it
is created (`ChartBridgeGroups.NoteNewOrder`, before `Submit`), and every leg of that entry (its stop, target and strategy legs, which
share the entry's `CB#` tag) carries it too. Another account's order placed meanwhile (a copier follower) and any later order do not.

- **Fills to The Desk:** a fill of such an order (its entry or a leg) adds `"decision_id":"d..."` after `order_id` (and `by`). Every
  other fill is byte for byte as before (no key).
- **The order record:** `decision_id` on every event of those orders; null otherwise.
- **Single-account entries have none** (no `decision_id` on their fills, null in the order record): The Desk counts such an entry as
  its own decision. Agent, bot and copier entries have none either (the agents' group plans are not the page's group ticket).
- **Kept across a restart:** `decisions.txt` next to `config.txt` (`tag<TAB>decision<TAB>UTC ms`, written by ChartBridge on the 10 s
  account timer, whether or not the order record is on, and at its stop, 5 days), so an exit after an NT8 restart still carries its entry's decision.
- **The orders sent are unchanged:** the entry, its size, name, price, bracket and every message to the page are byte for byte the same
  with the id as without it (harness: the same group entry to 3 made-up accounts with the id off, which is 0.6.8's path, and on). The
  Output window's group entry line ends with `(decision d...)`.

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
| `POST`, `GET /api/trade-tags` (chart 1.34.0) | `{tags: [{id, account, root, phase, dim, value, trade_open_ms, at_ms}]}`; CORS `GET, POST` | the Trade tags panel's records (append-only; TheDesk `docs/API.md` "Trade record") |

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

### The page's Account page (chart 1.16.0)

How the chart page uses the messages above for its Account page (`live/accounts.js`, a workspace panel) and the Quote
board. Page side only; nothing here changes what ChartBridge sends or accepts.

- **The window's v3 connection** (see "The page's v3 connection" below). Its actions are exactly `accountTrade`,
  `accountArchive` (`confirm: true`, sent only after the page's own confirm in the panel), `accountUnarchive` (ChartBridge
  0.5.1: Show), `copierSet`, `copierFollower`
  (every key) and `copierRearm` on the v3 connection, and `cancel` with `from: "list"` on the order ticket's connection
  (every order action goes there); each control shows only when its switch in `trading.switches` is `true` (a missing or
  non-boolean switch is off). Hide and Show show only with `accountChecks` on, as ChartBridge refuses them with it off
  (lead's default). ChartBridge 0.5.1: Hide (an in-page confirm, "Hide EVAL-B? It leaves every list until you Show it; its
  history stays.") is on each account whose `canHide` is true, Gone or active (a Gone account from a ChartBridge without
  `canHide` keeps it, as 0.5.0 allowed); the Hidden list (`archived`) has a Show button per account when the accounts carry
  `canHide` (0.5.1 and later). With an older ChartBridge nothing new is opened and the panel says it needs 0.4.0.
- **Limits** (lead's default; never estimated). Daily loss: the room is `roomDailyLoss`, else The Desk's `daily_loss_limit`
  less today's loss (`pnlToday` below 0); the limit is The Desk's, else the room plus today's loss. Trailing drawdown: the
  room is `roomDrawdown` only (The Desk has no high-water mark); the limit is The Desk's `trailing_drawdown`. Used is
  (limit - room) / limit. The closer is the one with less room in dollars; its percent gives the level: amber from 70
  percent, red from 90; when the closer's limit is unknown the other's percent is used; a room at or below 0 is red. Every
  chart in the window shows the warning for the ticket's account (all its charts show that account's orders).
- **The Desk** (lead's default). Its address is the page's one source for it, `/diag` `desk.deskUrl` (see below);
  `GET /api/chart-accounts` is read at start and every minute. Net on Today's trades needs a commission per contract per
  side: the page reads an optional `commission` (`{"MNQ": 0.62, ...}`, the rate The Desk itself uses, its firm default
  when the account has none) on each row; until The Desk sends it, net shows `n/a` and says why (an open item for The
  Desk). A row of Today's trades opens The Desk's Review of that session, `#/futures/review/<date>` (the page has no
  Desk trade id).
- **Quote board.** After NQ and ES, every instrument `hello` marks `quoteOnly: true`, in the order YM, RTY, GC, SI, CL,
  6E, ZN, ZB (any other after, by name); `priceFormat` `"32nds"` is shown in NinjaTrader's form (the half 32nd as a third
  digit when the tick is under 1/32). No order control is ever offered for them.

#### The page's side (chart 1.16.0, the order ticket lane)

Built in the workspace (`live/index.html`; the rules in `live/order-strategies.js`, the order path in `live/trade.js`).
Each choice below that the brief left open is marked **(lead's default)**.

- **v3 page.** The ticket's switches, `managed` and the Merge result come from the window's v3 connection (see "The page's
  v3 connection" below); the ticket's own connection stays a v2 page and sends every order action, a strategy's `order`
  and `merge` included. (The single chart page, `single.html`, had no v3 connection; it is gone since chart 1.22.0.) A control shows only while its switch is
  true: the Strategy picker on the ticket and Settings > Order Strategies (`strategies`), the Merge button and key
  (`merge`), the entry-type modifiers (`orderTypes`), Accept and Reject keys (`bot`). With every switch off the page is
  the 1.15 page: no new control, The Desk never asked, an order is the 1.15 order.
- **The Desk's address** is ChartBridge's `deskUrl` (see "The page's v3 connection" below), shown in Settings.
- **When the hotkeys live in The Desk** (lead's default): while any of `strategies`, `orderTypes`, `merge` or `bot` is on
  (they need the shared keys). With all four off they stay this browser's, as in 1.15. On The Desk's first answer in a
  browser: when The Desk has none yet (rev 0) and the browser has keys, they are saved there; otherwise The Desk's keys are
  used and a note names the browser's keys they replaced. The Desk's keys are written to the browser's own keys
  (`live-hotkeys-v1`, `live-ws-keys-v1`), so the 1.15 handlers use them. (Until chart 1.22.0 the single chart page then
  showed them read only, told by `live-desk-sync-v1`; the page and the key are gone.) A key The Desk has that this browser keeps for itself (`hotkeyRefused`) is shown with why it does
  nothing here.
- **The hotkeys document** has nine keys: The Desk's seven plus `accept` and `reject` (the copilot's one-key answers, no
  default key) (lead's default; The Desk lane adds them). The page sends a cancelable `chart-copilot-key` DOM event
  (`detail.answer` `accept` or `reject`); the Bot tab answers it (the oldest open proposal); with none open a note says so.
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

### The page's v3 connection (chart 1.16.0)

The page integration's one rule for the Account page, the order ticket's 0.4.0 parts and the Bot tab (lead's rule: with
every switch off, the ticket and every order surface behave as chart 1.15.0 with ChartBridge 0.3.8, and the page keeps
working with ChartBridge 0.3.8; COMPAT `minChartBridge` stays 0.3.2):

- **The ticket's connection stays a v2 page**, exactly as in 0.3.8: it never sends `client`, so ChartBridge 0.4.0 gives
  it v2's scope (the tradable accounts' orders and positions), no `tradable` key, no `switches` and no v3 message. It
  carries **every order action**: `order` (with a bracket, or a `strategy`, or a `stopLimit` or `mit` kind), `change`,
  `plan`, `cancel` (the Account page's `from: "list"` too), `flatten` and `merge`: one order path, one rate count, one
  refusal path. ChartBridge 0.4.0 takes each of them on any signed-in own page; the switch decides
  (`ChartBridgeOrders.Gate` is gates 1, 4 and 7; `strategy` is read only with `strategies` on, `merge` is refused with
  `merge` off, `from` with `cancelFromList` off; nothing there asks whether the page sent `client`).
- **One v3 connection per window** (`live/accounts.js` `createFeed`), opened only when the ticket connection's `hello`
  lists `"v3"`: `client` v3 right after its own `hello`, then `auth`. It is shared: the Account page (`accounts`, the
  copier, the account and copier actions), the ticket (`trading.switches`, `managed`, the `merge` result: ChartBridge
  sends those to v3 pages only) and the Bot tab (`bot`, `botSignal`, `botProposal`, Sim101's orders and fills, and
  `botMode`, `botKill`, `botSeen`, `botAnswer`, `botRails`) each read it through `listen` and send through `post`. Its
  `status` errors and warnings (not the bot's) are shown as the ticket's, once when both connections carry the same text.
  `bot.html` (the Bot window) has no ticket and opens its own one.
- **Why not the ticket's connection as v3** (lane C3's first cut): a v3 page gets every watched account's orders and
  positions, `tradable` on each order and the v3 messages, so the ticket's connection would no longer be the 0.3.8 one
  with every switch off. **Why not one per part** (lanes C2 and C4): two connections reading `bot`, `trading` and the
  orders, and two code paths for the same message.
- **The Desk's address** has one source: ChartBridge's `deskUrl` in `config.txt` (where ChartBridge sends the fills),
  read from `/diag` `desk.deskUrl` once per page load (`AccountsPage.deskBase`; `http://localhost:8800` when `/diag` has
  none). The Account page's limits, the shared hotkeys and Order Strategies, and the copilot keys all use it; nothing is
  kept per browser (`live-desk-url-v1` is gone). Settings shows it.
- **With ChartBridge 0.3.8** (no `"v3"`): no v3 connection, no `client`, no new control, no request to The Desk or
  `/bot-library`; the ticket's connection sends what 1.15.0 sends (`smoke:v038` compares it with the 1.15.0 page).

### Order lane

The v3 server-to-page messages `accounts`, `managed`, `merge`, `copier`, `copierEvent`, `bot`, `botSignal`, `botProposal`
and (0.5.0) `agent`, `agentPlan`, `agentProposal`, `agentNote` and `agentState` go in the order lane (see "Two send lanes"), so a proposal or a copier event never waits behind market data.
