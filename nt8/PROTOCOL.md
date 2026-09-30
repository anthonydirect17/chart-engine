# ChartBridge protocol (v1 market data and fills, v2 orders)

ChartBridge is a NinjaTrader 8 add-on. It serves the live chart page at `http://localhost:8765/` and
talks to it over one WebSocket at `ws://localhost:8765/ws`. Everything stays on the local machine.
**Read only by default.** Nothing in v1 can place, change or cancel an order. Order entry (v2, ChartBridge
0.3.0 and later) is off unless `config.txt` has `trading = true`; see "Orders (protocol v2)" below.
ChartBridge's own page is locked with a 4-digit PIN since 0.3.2; see "PIN" below.
Since 0.3.4 every trade, live and in the backfill, carries its side (buy or sell) and how it was found; see
"Trade side" below.

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
| `hello` | `version`, `now` (UTC ms), `instruments`: `[{root, name, tick, pointValue}]`, `accounts`: `[name]`, `trading` (0.3.0 and later: the `trading` object below, always with `enabled` false until the page signs in) | on connect |
| `history` | `root`, `name`, `barSeconds` (60), `sub` (0.3.3), `bars`: `[[t,o,h,l,c,v], ...]`, `done` (bool) | after `subscribe`, chunked. Since 0.3.3 the history is split: the chunks before the last minute (the last of them now says `done` false), then the last (forming) minute in its own message with `done` true, rebuilt from trades when it can be (see Backfill and live below) |
| `ticks` | `root`, `sub` (0.3.3), `ticks`: `[[t,p,v], ...]`, since 0.3.4 `[[t,p,v,s,sm], ...]` (side and method, see Trade side; the first three keep their places), `done` (bool) | after `history`, the current session's trades, chunked |
| `ready` | `root`, `sub` (0.3.3) | history and tick backfill complete; live ticks follow (since 0.3.3 only those not already in the backfill; see Backfill and live below) |
| `tick` | `root`, `t`, `u`, `rx` (UTC ms when the add-on received it), `p`, `v`, and since 0.3.4 `s`, `sm` (side and method, see Trade side) | every trade, live |
| `execs` | `list`: `[exec]` | on connect: executions NinjaTrader already has for today |
| `exec` | `account`, `name` (e.g. `MNQ 12-26`), `root`, `side` (`buy`/`sell`), `qty`, `p`, `t`, `u`, `id`, `order` | each new fill, live (see Fills below) |
| `status` | `level` (`info`/`warn`/`error`), `text` | problems worth showing on the page |

## Page to server

| type | fields |
|---|---|
| `subscribe` | `root` (`MNQ`, `NQ`, `MES`, `ES`), `days` (1m history, default 5), `tickHours` (tick backfill cap, default 8), `sub` (0.3.3, optional: a whole number of up to 15 digits, echoed as a plain number without leading zeros on that load's `history`, `ticks` and `ready`; without it ChartBridge numbers the page's subscribes 1, 2, 3, ...) |
| `ping` | `c` (page clock, echoed back in a `pong` with the server clock `s`) |

## Backfill and live: one seam (0.3.3)

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

**Backfill** (tick charts, `tickHours` above 0).

**0.3.4.1: no Bid or Ask history by default.** On the trading PC the Bid and Ask requests of 0.3.4 (8 hours of each on a
range chart, on every load and every reload) did not answer within 2.5 s and NinjaTrader froze several times a minute.
Delta is used while trading, so the past does not need it. `quoteHours` in `config.txt` (0, 1 or 2; default 0; anything
else is 0, with a line in the Output window) sets how many hours of Bid and Ask a tick chart asks for:

- `quoteHours = 0` (default): no Bid or Ask request at all. The backfill goes out as soon as the trades are in (no quote
  wait), every backfill trade by the tick rule (`sm` 3, or 0 for the first of a session), so a page can tell them from
  measured sides (`sm` 2). Live trades keep their side from the live quote (`sm` 2 at or outside the quote), as before.
  `/diag` `sides.<root>.lastLoad` has `quoteHours: 0` and the note `quotes not requested (quoteHours 0)`.
- `quoteHours = 1` or `2`: the last 1 or 2 hours of Bid and Ask (at most the trades' own window), for a measured test.
  NinjaTrader's help says a BarsRequest by date is widened to whole trading days, so NinjaTrader may still load the
  day's Bid and Ask; ChartBridge only keeps the last 1 or 2 hours. Measure it on the PC before leaving it on.
- NinjaTrader's help documents no way to cancel a BarsRequest once asked (`Request()`, and `Dispose()` when done). So a
  reload never asks again while an earlier Bid or Ask request for the same instrument is still unanswered: that load's
  trades go by the tick rule and the `note` says why; `/diag` `sides.<root>.quotesOutstanding` counts them. A request
  that never answers keeps that instrument's quotes off until NinjaTrader restarts.

With `quoteHours` 1 or 2, with the trades ChartBridge asks NinjaTrader for the historical Bid ticks and Ask ticks (three
requests at once; the backfill goes out when all three are back, in any order; a quote request ending in the future that
is refused or empty is asked once more ending now, like the trades).

- The quote window is the last `quoteHours` hours, at most the trades' window (a range view can ask up to 48). Trades
  before it go by the tick rule (`beforeQuotes`, and the `note` says the window is `quoteHours`).
- Only time and price are kept, and only the rows that can change the answer: of a run of rows at one price (size
  changes) the first, plus one every 5 seconds, each with the time of the last row it stands for (`Seen`), so a
  quote's age, and so the 60 s stale test, is exactly what every row gives (review 2 N1; a harness case checks 12,000
  trades on 200 made-up histories around the 60 s edge). A load that already went out or was replaced is not copied at
  all.
- Each trade then takes the last bid and ask stamped strictly before it (the rule above), compared at the coarser
  resolution of the trades and the quotes (1 ms, or whole seconds, as the seam judges it), so at whole seconds "the
  same time" is the same second.
- A trade goes by the tick rule instead when the quote history does not cover it: no bid or no ask before it
  (`beforeQuotes`), more than 5 seconds after the end of the shorter of the two histories (`afterQuotes`), or a quote
  over 60 seconds old (`staleQuotes`, a hole in the middle). No quote history at all (or only one side): every
  backfill trade by the tick rule, said in `/diag` (`note`) and in the Output window.
- The live trades stay held until the backfill goes out, so the quotes get at most 2.5 seconds after the trades are in
  (`QuoteWaitMs`). They are asked at the same time as the trades, so a quote history NinjaTrader already has comes
  back with them or soon after; a slow first download costs that load's sides (the tick rule, `quotesTimedOut`), not a
  longer frozen chart. A late answer is ignored. When the trade request failed there is nothing to classify and no
  wait at all.
- Minute and hour charts get no tick backfill and ask for no quotes.

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
`lastError`, `setAside`, `rejectedByDesk`); `pages` (0.3.4, one entry per connected page: `id`, `root`, `ready`, `queued`
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
`resolutionMs` (the time step both sides were compared at: 1, 1000, or 0.0001 for NinjaTrader's 100 ns), `tickToAheadMin`
(60, 0 after a retry, null with no tick backfill), `tickRetriedEndingNow`, `minuteTailRebuilt` (minute bars rebuilt from
trades; 0 when NinjaTrader's was kept, -1 when there was none), `ntTailVolume` and `rebuiltTailVolume` (that minute's volume,
NinjaTrader's and rebuilt from trades; null when not compared); and `accounts`: one row per watched account with `name`, `connection` (status),
`executions`, `orders`, `positions` (counts NinjaTrader holds) and `fillEvents`, `orderEvents`,
`positionEvents` (events seen). Account names are in this local page; never copy them into reports.
`sides` (0.3.4, see Trade side): one entry per instrument with `live` (null before its first quote or trade:
`trades`, `aggressor`, `bidAsk`, `tickRule`, `none` counts since the start, `liveTieChanged` (trades the other tie rule,
a quote at the trade's own time counts, would call differently), `quoteAfterTrade` (trades whose latest-arrived
update was stamped after them), `staleQuotes`, the latest `bid` and `ask`, `bidUpdates`, `askUpdates`, `quoteResets`,
and `eventQuoteSame`, `eventQuoteDiffers`, `eventQuoteNone`: whether the Last event's own Bid and Ask equal the latest
updates) and `lastLoad` (null before the first tick chart load: `sub`, `atUtcMs`, `trades`, the four counts, `note`
(in words when some trades could not use the quote history, else null), `bidTicks` and `askTicks` (rows NinjaTrader
sent inside the quote window), `bidRowsKept` and `askRowsKept` (after dropping size-only rows), `quoteHours` (the
`config.txt` setting, 0.3.4.1), `quoteWindowHours` (the hours this load asked for; 0 when none),
`quoteCopyMs` (ChartBridge's time copying and thinning them), `bidRequest` and `askRequest` (`ok`, `empty`, the error,
no answer in time, or not requested and why), `quotesRetriedEndingNow`, `quotesTimedOut`, `quotesLoadMs` (subscribe to the later quote
answer), `firstTrade`, `lastTrade`, `firstBid`, `lastBid`, `firstAsk`, `lastAsk` (New York time), `quotedTrades`,
`beforeQuotes`, `afterQuotes`, `staleQuotes`, `betweenQuotes` (quoted but between bid and ask: tick rule),
`crossedQuotes`, `tieChanged` (trades the other tie rule would call differently, every trade counted), `sessionStarts`
(18:00 ET boundaries inside the backfill, where the tick rule started over),
`tradeResolutionMs`, `quoteResolutionMs`, `comparedAtMs`, and `stamps`: NinjaTrader's own bid and ask on the last 2,000
backfill trades, `usable`, `likeFillIn` (Bid = Last and Ask = Last + 1 tick; equal to `usable` means filled in, not
real), `missing`, and for usable stamps that put the trade at the bid or ask, `agree` and `disagree` with the side
ChartBridge gave it, whatever its method), and (0.3.4.1) `quotesOutstanding`: Bid and Ask requests for that instrument
NinjaTrader has not answered yet.

## Fills to The Desk (0.2.0, off by default)

With `postFills = true` in `config.txt`, every fill is also sent to The Desk's `POST /api/fills`
(`deskUrl`, default `http://localhost:8800`) in The Desk's fill shape, with `source` `nt8`. Fills
wait in `pending_fills.jsonl` next to `config.txt` until The Desk accepts them, so a restart or The
Desk being closed loses nothing; The Desk ignores duplicates. A request gives up after 10 seconds; a fill
The Desk refuses as malformed is set aside in `rejected_fills.jsonl` so it never blocks the queue. Fills from every watched account are
sent: The Desk's Accounts menu decides which accounts count. ChartBridge sends no commission (NinjaTrader's
figure is its own commission template, not what was charged).

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
5. **Price and tick checks.** Limit and stop prices must be on the instrument's tick grid and within
   200 ticks of the last price, and that last price must be under 300 seconds old; stop orders must be
   on the right side of the market (a buy stop above, a sell stop below), and so must limits (a buy
   limit at or below the last price, a sell limit at or above: a limit through the market would fill at
   once, which is a market order in disguise). The same checks apply when an order is moved. Refused
   otherwise.
6. **Instruments.** Only the roots ChartBridge serves (`roots`), on the contract it resolved. An order
   on any other contract is never sent to the page and cannot be moved or cancelled from it.
7. **Rate limit.** At most 10 order actions per second per connection; more are refused.
8. **Strict messages.** Only the keys in the table below; anything else (a misspelt `bracket`, a key with
   a space or a dash) is refused, never ignored. `qty` and bracket ticks must be plain JSON whole numbers
   (no quotes, no decimals, no exponent, no leading zero, at most 9 digits); `price` a plain decimal. A
   message with any backslash escape is refused. No key may appear twice. No list
   and no nested object except `bracket`, which must be an object (`"bracket": null` is refused).
   A WebSocket message over 64 KB closes the connection.

A refusal never reaches NinjaTrader; it comes back as `reject` with a plain reason.

### Brackets

A bracket is `{ "stop": ticks, "target": ticks }`, each a whole number from 0 to 200 (0 means none;
both 0 means no bracket). It may only go on an order that opens or adds to a position; on an order
that would reduce the position (by both position readings) it is refused.

- **Placed per fill.** Each time the entry fills (all at once, or in parts), that increment gets its
  own stop and target for exactly that many contracts, priced from that increment's fill price, as an
  OCO pair (`oco` = `cb-<tag>-<filled so far>`). Legs are **GTC**. With only a stop or only a target,
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
- **Named for recovery.** The entry's order name carries the bracket (`CB#1a2b3c4d s8 t16`), and each
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
| `change` | `cid` (optional), `id` (ChartBridge order id, `o1`, `o2`, ...), `price` | move a working limit or stop, or a bracket leg (drag on the chart) |
| `cancel` | `cid` (optional), `id` | cancel one working order (cancelling one leg of an OCO pair cancels its partner) |
| `flatten` | `cid` (optional), `account`, `root` | cancel every working order for that account and instrument, then close the position at market |

String values must be plain (no backslash escapes, at most 200 characters).

### Server to page

| type | fields | when |
|---|---|---|
| `trading` | `enabled` (bool), `reason` (when not enabled), `accounts` (allowed names), `maxQty` (`{root: n}`, including the default under `"*"`) | answer to `auth`; also in `hello` with `enabled` false until `auth` succeeds |
| `orders` | `list`: `[order]` | after `auth`, every working order on the allowed accounts |
| `order` | `id` (ChartBridge's id, stable while the order lives), `cid` (when placed from this page), `account`, `root`, `name`, `side`, `kind` (`market`, `limit`, `stop`, `stopLimit`, `other`), `qty`, `filled`, `price` (limit or stop price, or null), `avgFill` (or null), `state` (`working`, `partFilled`, `filled`, `cancelled`, `cancelling`, `rejected`), `role` (`entry`, `stop`, `target`, or `other` for orders placed elsewhere), `oco` (or null), `text` (NinjaTrader's error when rejected or failed) | every order change, live |
| `position` | `account`, `root`, `qty` (signed: long positive, short negative), `avgPrice` (or null when flat) | after `auth` and on every change |
| `reject` | `cid` or `id` (whichever the message had), `reason` | a refusal by ChartBridge's gates |
| `status` | `level` `error` (a bracket leg rejected or a bracket error: check the stop now) or `warn` (the legs check cancelled or shrank legs), `text` | bracket problems, to signed-in pages |

Orders placed in NinjaTrader itself (or anywhere else) on an allowed account also show on the chart,
with `role` `other`, and can be moved or cancelled from the chart.
