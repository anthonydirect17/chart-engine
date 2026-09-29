# Changelog

## 1.5.0 (2026-09-29): the live chart as a mountable piece (ChartLive.mount), for The Desk

Page and engine only; nt8/ is unchanged except that `nt8\install.ps1` now also copies `live/live.css`. Run
`nt8\install.ps1` again after pulling (no NinjaTrader recompile).
- **ChartLive.mount(container, options)**: the same live chart code runs in a host page such as The Desk's
  Live trading section, returning `{ destroy(), chart, element, paneId }`. Options: `wsUrl` (a string, or a
  function asked again for every connect and reconnect, so a relay can hand out a fresh single-use ticket),
  `paneId`, `storagePrefix`, `onStatus`, `brand`. See `live/EMBED.md` for the files to vendor, in load order.
- **Always read only when mounted** (review N1: a `trading` option is ignored; only the standalone page, booted
  with `data-mount="page"`, can trade): no `GET /session`, no `auth`, only `subscribe` and `ping` ever sent (anything
  else is dropped), no order bar, Armed switch, Shift+click orders or draggable order lines.
- **Nothing global**: each chart keeps to its own element (class `chart-live`, element ids prefixed per mount);
  its listeners on document and window, timers and WebSocket go with `destroy()`. Mount, destroy and mount
  again all work, and several charts can run in one page with their own indicators (`paneId`).
- **Settings apart**: every storage key gets the `storagePrefix` in front (default `embed:`), so an embedded
  chart and the standalone page on one origin never share settings.
- **The standalone page is unchanged**: it now builds itself with the same code (`<script src="live.js"
  data-mount="page">`), with the ids it always had. Its styles moved to `live/live.css`, scoped under
  `.chart-live`; computed styles and layout of every page element match 1.4.1 at 1440, 900 and 400 px, with
  trading on and off. The Armed border sits on the chart root instead of `body`.
- `live/EMBED.md`: a host connecting straight to `ws://localhost:8765` needs its origin in ChartBridge's
  `allowOrigins`; smoke:embed runs the host on its own origin, refused when not listed, live when listed (S3).
- `live/EMBED.md` lists what the chart sends for a relay: `subscribe` with `days` 5 and `tickHours` 0, 8 or, for
  Range bars, 9 to 33 (never over 48); a relay that clamps `tickHours` gets the partial-session note (review S2).
- **Drawings per pane** (review S1): a pane other than `main` keeps its lines under
  `live-drawings-v1-<paneId>-<ROOT>`, so two panes on one instrument no longer overwrite each other; the main
  pane (and the standalone page) keeps `live-drawings-v1-<ROOT>`.
- **Order drag safety** (review N4, also on 1.4.2): an order drag let go outside the plot (over the toolbar, an
  axis, off the chart) or at a price not on screen is cancelled; the line goes back and nothing is sent. Before,
  it sent a move to an extrapolated price Anthony never saw. Engine unit test and an orders smoke case.
- Engine: `mountThemePanel` returns `destroy()` (removes the Colors panel and its document listener), and saves
  only the colors a change sets, on a fresh read, so two charts sharing the key no longer undo each other.
- Tests: `npm run smoke:embed` (a plain host page with one and two panes against the fake bridge); the fake
  bridge gets `--tickets` (single-use WebSocket tickets, like The Desk's relay) and, with `--test-controls`,
  `/test/drop` and `/test/received`; a unit test checks `install.ps1` copies every local stylesheet.

## 1.4.2 (2026-09-29): ChartBridge 0.3.1, network hardening

ChartBridge (nt8/) only; the page and the engine are unchanged apart from the version. Run `nt8\install.ps1`
and recompile in NinjaTrader.
- **This PC only.** A read-only check on the trading PC found that HTTP.sys listens on every interface and
  matches only the `Host` header: a request to the Wi-Fi or Tailscale address with a forged `Host: localhost`
  was answered. Every request, on every path (page files, `/diag`, `/session`, `/ws`), is now checked first,
  before any routing: it must come from a loopback address (`127.x`, `::1`, `::ffff:127.x`), or it gets 403.
  Refusals are logged once an hour per address. A firewall rule blocking inbound 8765 is still recommended as
  a second layer (README, PROTOCOL.md "Network access").
- **WebSocket origin allow-list.** A browser may open the read-only WebSocket only from ChartBridge's own page
  or an origin in the new `config.txt` line `allowOrigins` (exact `scheme://host[:port]`, lower-cased, no
  wildcard; The Desk's Live trading page goes there). No `Origin` header (a local program) is allowed;
  `null` is refused. Trading still needs ChartBridge's own page. `/diag` shows the rules under `network`.
- **Missing-stop alarm** (from the Sim101 test): when the stop's OCO target was cancelled too, the alarm says
  "... the target was cancelled too (OCO), so the position has no stop and no target" (or, when the target went
  first, "the target was rejected and the stop was cancelled with it (OCO)"). The start of the text is unchanged.
- Tests: the Mono harness unit-tests the address check (IPv4, IPv6, mapped IPv4, LAN, Tailscale, none) and
  the origin check (own page, listed, unlisted, null, missing), runs the real request handler behind a
  listener on every interface with plain GETs (a forged `Host: localhost` from another address is 403 on every
  path), and covers the OCO alarm. Mono's HttpListener has no server WebSocket, so the upgrade itself is not run
  there: a source guard pins the address check (and the Origin check) before the upgrade, and a one-time curl on
  the trading PC checks it for real (PROTOCOL.md, Network access). The fake bridge follows the same origin rule
  (`--allow-origins`).

## 1.4.1 (2026-09-29): fixes from the review of 1.4.0

Page only again; nt8/ unchanged. Run `nt8\install.ps1` to copy the page files.
- **Range box** (S1): the chart rebuilds only when the size is committed (Enter, the arrows, leaving the box),
  never on a half-typed number, so a slow "1" on the way to "12" no longer rebuilds at 1 tick (1.3 s on a 2M tick
  backfill). A whole number typed is still saved for a reload; an invalid one ("450") drops that and keeps the
  committed size; a reload mid-typing saves the box with the same clamp as Enter (450 becomes 400).
- **Two tabs** (S2): indicators are saved one indicator per pane, and brackets one stop or target per root, at a
  time, so a tab loaded earlier no longer undoes another tab's change.
- **New panes start with no indicators on** (Anthony's decision). The main pane keeps today's set.
- **Range bar times** (N1): the trade's own bar keeps the trade's time and phantom bars sit in the gap since the
  previous trade, so a fill on a jump trade lands on the bar holding its price, and bar times no longer run ahead
  of the trades (only same-instant trades step on, by 10 microseconds a bar).
- **Leg summary** (N3): stops or targets over the position show in the warning color with the reason (a fill would
  reverse it); orders ChartBridge reports as kind "other" (MIT, LIT) are not counted and the summary says how many.
- **Range backfill** (N4, N5): after the tick cap trims, switching to Range reloads only if this session's start is
  no longer covered; when NinjaTrader sends less tick history than asked, the status line says the first session
  is partial.
- `docs/RANGE_BARS.md`: Break at EOD is on in Anthony's charts (confirmed by Anthony); NinjaTrader stamps a bar
  with its close time, the page with its open time (N2).
- Tests: the settings smoke covers "450", a slow "12" and a reload mid-typing; two-tab indicator and bracket
  tests; a fill on a jump trade; bar time bounds; over-coverage and not-counted orders (unit and orders smoke);
  the tick trim and partial history helpers; the live smoke checks the partial note with 2 hours of history
  (fake bridge `--tick-hours-max`).

## 1.4.0 (2026-09-29): quick wins on the live page (Phase A: B1, B2, indicator menu, leg summary)

Page and engine only; ChartBridge (nt8/) is unchanged, so no NinjaTrader recompile. After pulling, run
`nt8\install.ps1` again to copy the page files.
- **B1, the range size did not stick** (NQ set to 40 ticks, back to 20 after a reload). Two causes, both
  reproduced by the new `npm run smoke:settings` on 1.3.1: a size typed and not committed (no Enter, no click
  elsewhere) was never saved, since the page saved only on the input's change event; and every save wrote the
  tab's whole copy of the sizes back, so a second chart tab saving its own size put NQ back to 20. Now each
  choice is saved one field at a time (read fresh, change one field, write), as it is typed (whole numbers only,
  350 ms after the last key) and at once on Enter or leaving the box, and anything still waiting is saved when
  the page is hidden or closed. This covers the instrument, bars, range size (per instrument), range mode, glide,
  indicators (per pane) and bracket ticks (per instrument). New keys `live-settings-v2`, `live-range-v2`,
  `live-indicators-v1`; the 1.3 keys are read once, so earlier choices carry over. All storage access is in
  try/catch.
- **B2, range bars like NinjaTrader's.** From NinjaTrader's own `@RangeBarsType.cs`: a finished bar is exactly
  the range and closes on its high or low (even a price that did not trade), the next bar opens one tick
  further on, a jump of more than one range is filled with phantom bars (exactly the range, no volume), and a
  new session starts a new bar at its first trade. This is the default; the 1.3 behaviour stays as **Traded
  prices only** in a select next to the range size. Range bars now start from a session's first trade (the tick
  backfill reaches back to this session's start, or also the previous one while this one is under 8 hours old,
  at most 33 hours), so a reload gives the same bars; backfill and live use the same code. Sources, dates and
  open points: `docs/RANGE_BARS.md`.
- **Indicator menu.** The row of indicator chips is now one **Indicators** menu with checkboxes, per chart pane
  (state keyed by pane id, `main` today). The first run shows the same indicators as before. Keyboard: Enter
  opens it with focus on the first box, Space toggles, Escape or a click outside closes it. Fits at 400 px.
- **Leg summary** (trading on only): next to the position, "stops cover 2 of 2, targets cover 2 of 2", from the
  working orders the page already has, in the error color when stops cover less than the position. Orders sent
  are unchanged.
- Engine: version 1.4.0; no drawing or motion change. Nothing added per frame.
- Tests: `test/prefs.test.js` (storage, carry-over, a throwing storage, every page script is on the
  `install.ps1` list), range bar known answers for both modes (multi-range jumps, a session boundary, live
  equals a rebuild, the same bars from two backfill windows), `legSummary`; the live smoke drives the menu and
  checks every finished NinjaTrader range bar on the page is exactly the range; the orders smoke fills a 2-lot
  in two pieces. Fake bridge: `--tick-gaps` for tick history with price jumps.

## 1.3.1 (2026-09-29): fill marks that add up

From a report on the trading PC: a 3-lot trade whose target filled as three 1-lot executions drew as
"▲3" and one "▼1", because the three sell marks sat on top of each other.
- Engine 1.3.1: fills on the same bar, side and price (to the tick) draw as one mark with the summed
  quantity, so that trade reads ▲3 and ▼3. Fills on one bar at different prices keep their own marks, and
  their labels stack apart (sells up from the price, buys down) so each quantity reads. Triangle tips stay
  at the fill prices. Merging is for drawing only; `setMarkers` keeps every execution. The merged marks
  are rebuilt only when the fills, the bars or the tick change. Helpers `groupFills` and `stackFillLabels`.
  Nothing else in the look or the motion changed.
- Tests: `test/fill-marks.test.js`.

## 1.3.0 (2026-09-29): trading from the chart, the chart side (Step 2)

Order entry on the live page through ChartBridge protocol v2 (`nt8/PROTOCOL.md`, "Orders"). Everything is
checked by ChartBridge; the page adds its own checks on top. With ChartBridge 0.2 the page is read only,
exactly as before.
- Engine 1.3.0: `setOrders` (order lines with a label, a close x and a price-axis tag; green buy, red sell,
  stops dashed), `setPosition` (average price line with open P&L in points and dollars, `pointValue`),
  `setOrderEditing`, `setOrderPreview`, events `orderMove` (drag a label or tag, tick-snapped, Escape
  reverts), `orderCancel` (the x) and `orderPlace` (Shift+click without moving), plus `orderHandles`,
  `priceToY`, `yToPrice` and the helpers `orderLabel`, `openPnl`, `fmtMoney`, `fmtSigned`. Nothing else in
  the look or the motion changed.
- Live page: signs in with the token from `GET /session`; an order bar with the **Armed** switch (off after
  every load; off again when the account or instrument changes or the connection or trading is lost),
  account (only `trading.accounts`), qty (1 to the root's `maxQty`), Buy / Sell MKT, Shift+click side,
  bracket stop / target ticks per root (remembered in this browser), Flatten and Cancel all; working orders,
  the position and fills on the chart; order messages and refusals in the status line; ChartBridge errors
  stay on screen. No bracket on an order that reduces the position. No trading inside a frame. A repeat
  click on the same action within 0.4 s is ignored. No order hotkeys.
- Fake bridge: protocol v2 with the same gates as ChartBridge and a small matching engine
  (`test/fake-orders.mjs`, the reference behaviour), `--trading`, `--trade-accounts`, `--max-qty`, `--v1`,
  `--test-controls`, `--allow-frames`.
- Tests: gates, matching, brackets, flatten, Origin and token (`test/fake-bridge.test.js`), the page helpers
  (`test/order-ticket.test.js`), and `npm run smoke:orders` in Chromium at 1440 and 400 px.
  `npm run smoke:live` now runs against the fake as ChartBridge 0.2.

## 1.2.2 (2026-09-29): ChartBridge 0.2.1

From an overnight code review of 0.2.0. Checked by running the real queue code under Mono against a
running The Desk, a malformed fill, a server that never answers, and a closed port.
- Sending fills to The Desk: a request now gives up after 10 seconds (before, one hung request stopped
  all posting with no error). A batch The Desk calls malformed is retried one fill at a time and the
  bad fill is set aside in `rejected_fills.jsonl`, so nothing blocks the queue. Fills The Desk could not
  store are logged. The queue file is replaced atomically, reloads cleanly (no duplicates, skips a line
  cut short by a crash), and never holds the same fill twice.
- A failed start disposes its timers and account subscriptions.
- Clock: logging happens outside the clock lock, and only for steps over 250 ms.
- `/diag` desk block adds `setAside` and `rejectedByDesk`.

## 1.2.1 (2026-09-29)

- Level tags on the price axis no longer hide under the last-price tag: levels at or above the last
  price stack upward from it, the rest stack downward. Seen on The Desk's Today chart, where the VAH
  tag sat under the live price. Engine version is now 1.2.1 (it had stayed at 1.1.0 through 1.2.0).

## 1.2.0 (2026-09-29): ChartBridge 0.2.0

From the second HOME run (H2b), where the chart ran LIVE but no fill reached ChartBridge.
- Fills now arrive two ways: the account's fill event, and a poll of every watched account every
  2 seconds. Each fill is delivered once. `GET /diag` shows the counts per account and which way fills
  came in, so the next test says exactly where fills stop if they still do.
- Fills to The Desk (`postFills = true`, off by default): every fill is sent to The Desk's
  `POST /api/fills`, queued on disk until The Desk accepts it. The Desk's Accounts menu decides which
  accounts count.
- The clock follows the PC clock: it is rechecked every 5 seconds and re-anchored when off by more than
  50 ms. (H2b: the PC was 0.57 s off; after Windows time sync the bridge kept the old offset until a
  restart.)
- Live page: an account dropdown next to Fills picks whose fills are marked (remembered per browser).
- New source guards for all of the above. The chart engine itself is unchanged (still 1.1.0 inside).

## 1.1.1 (2026-09-29): ChartBridge 0.1.1

First real run on the HOME PC (NinjaTrader 8, Tradovate): LIVE on MNQ, NQ, MES and ES, 1 ms local delay.
Fixes from that run:
- ChartBridge did not compile: fill events read the instrument from `e.Execution.Instrument`
  (`ExecutionEventArgs` has no `Instrument`). The compile-check stand-ins now match the real API.
- ChartBridge deadlocked each connection: the send loop ran inline and blocked on its empty queue before
  the first message. It now runs on its own task.
- `accounts =` allow-list in `config.txt`; Backtest and Playback accounts are always skipped.
- The live page fetches ticks only for 15s, 30s and range bars, so minute and hour charts load from the
  1-minute history alone (the first run pulled about 1.7 million ticks and took 19.5 s).
- New source guards (`test/nt8-source.test.js`): read only (no order calls), no inline send loop,
  localhost-only server, C# 5 syntax.

## 1.1.0 (2026-09-29)

Live trading chart, step 1 (watch only), fed by NinjaTrader 8.

- **ChartBridge** (`nt8/ChartBridge.cs`): a NinjaTrader 8 add-on that serves the live page at
  `http://localhost:8765/` and streams, over one local WebSocket, 1-minute history, the session's
  ticks, live trades with exchange timestamps, and your fills (read only). Front month for MNQ, NQ,
  MES and ES is computed from the CME roll rule, with overrides in `config.txt`. Written in C# 5 syntax
  and compile-checked against stand-in types (`npm run check:nt8`). Protocol: `nt8/PROTOCOL.md`.
- **Live page** (`live/`): instrument switcher; 15s, 30s, 1m, 5m, 15m, 1h and range bars with a size
  per instrument; prior-day, overnight and value-area levels; session VWAP; your fills on the chart;
  a delay readout (exchange to NinjaTrader, and NinjaTrader to the chart); glide Smooth / Fast / Off;
  trend lines and price lines saved per instrument; reconnects on its own.
- Engine: `setMotion`, `setPriceFormat`, `setCountdown`, `setMarkers`, drawing tools
  (`setTool('trend' | 'hline')`, `setDrawings`, `getDrawings`, `on('drawings')`, Delete and Escape keys),
  and time labels that work for irregular bars such as range bars.
- `test/fake-bridge.mjs` speaks the same protocol with sample data, so the page is testable without
  NinjaTrader; `npm run smoke:live` drives it in Chromium.

## 1.0.0 (2026-09-29)

First release, extracted from the Chart lab prototype (v0) that Anthony approved on 2026-09-29
("that is such a fantastic chart. Thats what I want to actually trade on").

- The Custom engine from Chart lab, now a reusable module with a public API (`create`, `setBars`,
  `update`, `setLevels`, `setTrades`, `setLayers`, `setTheme`, events). Motion, layout and drawing
  are unchanged from the approved lab.
- Candles default to Carolina blue (bull) and deep purple (bear), per Anthony.
- New Colors panel (`mountThemePanel`): presets, bull / bear / VWAP pickers, saved per browser.
- Trade marks now use the house trade colors: entry by side (green long, red short), connector and
  chip by result (green profit, red loss), so they never depend on the candle colors.
- Text in candle colors (legend change, tags) is lightened or flipped automatically to stay readable.
- Sessions and regular hours are configurable, including 24/7 markets; daily bars get month and date
  labels, for the crypto mid-term charts.
- Lightweight Charts and the engine switch are gone; the lab comparison is decided.
- Unit tests (Node) and a Chromium smoke test.
