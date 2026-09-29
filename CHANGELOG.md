# Changelog

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
