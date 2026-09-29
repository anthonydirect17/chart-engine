# ChartBridge protocol v1

ChartBridge is a NinjaTrader 8 add-on. It serves the live chart page at `http://localhost:8765/` and
talks to it over one WebSocket at `ws://localhost:8765/ws`. Everything stays on the local machine.
**Read only:** nothing in this protocol can place, change or cancel an order.

All messages are JSON text. Times:

- `t`: exchange wall-clock seconds stored as if UTC (New York time for CME), fractional for ticks.
  This is the chart-engine convention.
- `u`: real UTC milliseconds since 1970 (used only for delay measurement).

Bars are stamped with their **start** time. NinjaTrader stamps bars at their close; the add-on converts.

## Server to page

| type | fields | when |
|---|---|---|
| `hello` | `version`, `now` (UTC ms), `instruments`: `[{root, name, tick, pointValue}]`, `accounts`: `[name]` | on connect |
| `history` | `root`, `name`, `barSeconds` (60), `bars`: `[[t,o,h,l,c,v], ...]`, `done` (bool) | after `subscribe`, chunked |
| `ticks` | `root`, `ticks`: `[[t,p,v], ...]`, `done` (bool) | after `history`, the current session's trades, chunked |
| `ready` | `root` | history and tick backfill complete; live ticks follow |
| `tick` | `root`, `t`, `u`, `rx` (UTC ms when the add-on received it), `p`, `v` | every trade, live |
| `execs` | `list`: `[exec]` | on connect: executions NinjaTrader already has for today |
| `exec` | `account`, `name` (e.g. `MNQ 12-26`), `root`, `side` (`buy`/`sell`), `qty`, `p`, `t`, `u`, `id`, `order` | each new fill, live (see Fills below) |
| `status` | `level` (`info`/`warn`/`error`), `text` | problems worth showing on the page |

## Page to server

| type | fields |
|---|---|
| `subscribe` | `root` (`MNQ`, `NQ`, `MES`, `ES`), `days` (1m history, default 5), `tickHours` (tick backfill cap, default 8) |
| `ping` | `c` (page clock, echoed back in a `pong` with the server clock `s`) |

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

JSON: `version`; `clockOffsetMs` (PC clock minus ChartBridge's clock, near 0 once the clock has
re-anchored; the clock is rechecked every 5 seconds and follows the PC clock when they differ by more
than 50 ms); `fillEventsDelivered` and `fillsFoundByPolling` (how many fills came each way this
session); `lastPollUtcMs`; `clients`; `desk` (`postFills`, `deskUrl`, `waiting`, `lastSendFailed`,
`lastError`, `setAside`, `rejectedByDesk`); and `accounts`: one row per watched account with `name`, `connection` (status),
`executions`, `orders`, `positions` (counts NinjaTrader holds) and `fillEvents`, `orderEvents`,
`positionEvents` (events seen). Account names are in this local page; never copy them into reports.

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
3. **Size caps.** `maxQty.MNQ = 5` style lines, per instrument root; default **1** for any root
   without a line. An order or a change above the cap is refused.
4. **This page only.** Order messages are accepted only on a WebSocket whose `Origin` header is
   ChartBridge's own page (`http://localhost:<port>`), and only after the page sends the session
   token it read from `GET /session` (served same-origin, no CORS headers, a new random token each
   time ChartBridge starts). Other web pages in the browser, and The Desk, stay read only.
5. **Price and tick checks.** Limit and stop prices must be on the instrument's tick grid and within
   200 ticks of the last price; stop orders must be on the right side of the market (a buy stop above,
   a sell stop below). Refused otherwise.
6. **Instruments.** Only the roots ChartBridge serves (`roots`), on the contract it resolved.
7. **Rate limit.** At most 10 order actions per second per connection; more are refused.

A refusal never reaches NinjaTrader; it comes back as `reject` with a plain reason.

### Page to server

| type | fields | notes |
|---|---|---|
| `auth` | `token` | once per connection, after `hello`. Answer: `trading` (below). |
| `order` | `cid` (page id, string), `account`, `root`, `side` (`buy`/`sell`), `kind` (`market`/`limit`/`stop`), `qty`, `price` (limit/stop only), `bracket` (optional: `{ "stop": ticks, "target": ticks }`, either may be 0 for none) | a bracket is placed as an OCO pair after the entry fills, for the filled quantity, and follows partial fills |
| `change` | `id` (NinjaTrader order id), `price` | move a working limit or stop, or a bracket leg (drag on the chart) |
| `cancel` | `id` | cancel one working order (cancelling one bracket leg cancels its pair) |
| `flatten` | `account`, `root` | cancel every working order for that account and instrument, then close the position at market |

### Server to page

| type | fields | when |
|---|---|---|
| `trading` | `enabled` (bool), `reason` (when not enabled), `accounts` (allowed names), `maxQty` (`{root: n}`, including the default under `"*"`) | answer to `auth`; also in `hello` with `enabled` false until `auth` succeeds |
| `orders` | `list`: `[order]` | after `auth`, every working order on the allowed accounts |
| `order` | `id`, `cid` (when placed from this page), `account`, `root`, `name`, `side`, `kind`, `qty`, `filled`, `price` (limit or stop price, or null), `avgFill` (or null), `state` (`working`, `partFilled`, `filled`, `cancelled`, `rejected`), `role` (`entry`, `stop`, `target`, or `other` for orders placed elsewhere), `oco` (or null), `text` (NinjaTrader's error text when rejected) | every order change, live |
| `position` | `account`, `root`, `qty` (signed: long positive, short negative), `avgPrice` | after `auth` and on every change |
| `reject` | `cid` or `id`, `reason` | a refusal by ChartBridge's gates |

Orders placed in NinjaTrader itself (or anywhere else) on an allowed account also show on the chart,
with `role` `other`, and can be moved or cancelled from the chart.
