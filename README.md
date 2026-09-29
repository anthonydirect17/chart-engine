# chart-engine

Anthony's trading chart. A Canvas 2D candlestick engine built to feel as smooth as OpenMarket:

- wheel and pinch zoom that eases in and stays anchored under the pointer;
- a price axis that re-fits smoothly instead of snapping;
- a live candle that grows toward each tick, with a flashing price tag and a bar-close countdown;
- throw-to-pan, live-edge following and a "Jump to live" button;
- levels, session VWAP, trade marks and volume;
- a Colors panel so the candles can be any colors you like.

It has no dependencies, draws only when something changes, and runs at 60 fps in about half a
millisecond a frame. It is the chart for the trading app and the standard for every chart in every
project (see [CHART_STYLE.md](CHART_STYLE.md)).

**Live demo:** https://anthonydirect17.github.io/chart-engine/ (sample MNQ data and a simulated feed;
not market data). It updates on every push to `main`. To run it offline, open `index.html` in a browser.

## Live trading chart (NinjaTrader 8)

`live/` is the chart fed by real market data through **ChartBridge**, a NinjaTrader 8 add-on in `nt8/`.
It is **read only** unless trading is turned on in ChartBridge (see [Trading from the chart](#trading-from-the-chart)).
With ChartBridge 0.2 or older it is always read only, exactly as before.

1. From this folder on the Windows PC: `powershell -ExecutionPolicy Bypass -File nt8\install.ps1`
2. NinjaTrader > New > NinjaScript Editor > compile (F5). Check New > NinjaScript Output for
   `ChartBridge: serving http://localhost:8765/`.
3. Open `http://localhost:8765/` in Chrome or Edge.

Live CME data is licensed for your own screen: never publish it (the GitHub Pages demo stays on sample
data).

On the page, the **Indicators** menu turns Volume, VWAP, Levels and Fills on and off, and the **account
dropdown** next to it picks whose fills are marked on the chart (All accounts, or one). **Range** bars are
built like NinjaTrader's (every finished bar exactly the range; see `docs/RANGE_BARS.md`), or from traded
prices only, picked next to the range size, which is kept per instrument. Every choice is remembered in
this browser as soon as it is made. `http://localhost:8765/diag` shows what ChartBridge
sees (accounts, fill counts, clock, The Desk queue); see `nt8/PROTOCOL.md`.

Settings live in `Documents\NinjaTrader 8\ChartBridge\config.txt` (optional, one `key = value` per
line; recompile or restart NinjaTrader after a change):

| Key | Default | What it does |
|---|---|---|
| `port` | `8765` | Web port (this PC only). |
| `roots` | `MNQ, NQ, MES, ES` | Instruments offered. |
| `contract.MNQ` | front month by the CME roll rule | Force a contract, e.g. `MNQ 12-26`. |
| `days`, `tickHours` | `5`, `8` | 1-minute history days; tick backfill cap for seconds and range bars. |
| `accounts` | every account except Backtest and Playback | Allow-list of accounts to watch, e.g. `Sim101, EVAL*` (`*` matches a prefix). |
| `postFills` | `false` | `true` also sends every fill to The Desk (see `nt8/PROTOCOL.md`). |
| `deskUrl` | `http://localhost:8800` | Where The Desk runs. |
| `trading` | `false` | `true` turns on order entry from the chart (see below). |
| `tradeAccounts` | none | Accounts the chart may trade, e.g. `Sim101, <eval name>`. Exact names, no wildcard; Backtest and Playback never. |
| `maxQty.MNQ` | `1` | Position cap per instrument root, one line per root (`maxQty.NQ = 1`, ...). |

Without NinjaTrader, `npm run bridge` starts a fake bridge with sample data at `http://localhost:8765/live/`
(`npm run bridge -- --trading --trade-accounts=Sim101,DEMO-EVAL --max-qty=MNQ:5` to try order entry on
simulated fills; the flags are listed at the top of `test/fake-bridge.mjs`).

## Trading from the chart

Decided by Anthony on 2026-09-29: market buy and sell, limit and stop by clicking a price, brackets (stop
and target in ticks, per instrument, placed as an OCO pair), Flatten and Cancel all, **one click while
Armed is on**. Orders go through NinjaTrader's own order system (ChartBridge 0.3 and later, protocol v2 in
`nt8/PROTOCOL.md`), so the broker and the prop firm see NinjaTrader orders. Lucid's written OK on custom
front ends was requested and had not arrived when this was written; adding the evals to `tradeAccounts` is
Anthony's call once it does.

**Turn it on** in `Documents\NinjaTrader 8\ChartBridge\config.txt`, then recompile or restart NinjaTrader:

```
trading = true
tradeAccounts = Sim101
maxQty.MNQ = 2
maxQty.MES = 2
```

Only the accounts named in `tradeAccounts` show in the order bar. Use `Sim101` first.

**The order bar** (above the chart, only with ChartBridge 0.3 or later):

- **Armed** switch. Off after every page load, and it turns itself off when the account or instrument
  changes, the connection drops or ChartBridge turns trading off. While it is on, the bar and the chart are
  outlined in amber, the legend shows ARMED and the tab title starts with ARMED. **Nothing trades while it
  is off**, and nothing asks for confirmation while it is on: one click sends the order.
- **Account** (only `tradeAccounts`; Sim101 is chosen first), **Qty** (1 to that instrument's cap).
- **Buy MKT / Sell MKT**.
- **Shift+click** a price on the chart to place a limit or stop at that price. The side is the bar's
  Buy / Sell choice; the kind follows from where you click: a better price than the last trade is a limit
  (buy below, sell above), a worse one is a stop (buy above, sell below). Hold Shift over the chart to see
  what one click would place. A plain click, a drag or a Shift+drag never places anything.
- **Bracket**: stop and target in ticks from each fill, remembered per instrument in this browser (0 means
  none). The bracket goes on orders that open or add to a position, never on one that reduces it.
- **Flatten** cancels every working order on the chosen account and instrument, then closes the position at
  market. **Cancel all** cancels the working orders and leaves the position; while a position is open it
  keeps every order on the closing side (the position's stop and target, from the chart or NinjaTrader)
  and says how many it kept. Cancel those one by one with their x, or use Flatten.
- Working orders show as lines with a label and a price tag (green buy, red sell; stops dashed, limits and
  targets solid). While Armed, drag a label (or its price tag) to move the order, press Escape during the
  drag to put it back, and click the x to cancel it (a bracket leg takes its pair with it). The position
  shows as a light line at the average price with open P&L in points and dollars.
- Confirmations and refusals show in the status line; a refusal is in red with ChartBridge's reason. An
  error from ChartBridge (for example a bracket leg NinjaTrader rejected) stays on screen until dismissed.
- No keyboard shortcuts place or change orders (only Escape, which cancels a drag in progress), and the
  order buttons act on a mouse or touch click only: Enter or Space on a focused button sends nothing.
- A limit on the wrong side of the market (a buy limit above the last price) is refused, since it would
  fill at once; a Shift+click above the market while buying places a stop, below it a limit.

**Safety gates** (all enforced in ChartBridge; the page only adds its own checks on top):

1. Off unless `trading = true`.
2. Only the accounts in `tradeAccounts`; never Backtest or Playback; no wildcard.
3. `maxQty.<ROOT>` caps the position (default 1): the position plus working orders on the same side plus
   the new order may not exceed it. Orders that reduce the position are always allowed.
4. Only ChartBridge's own page: the WebSocket Origin must be `http://localhost:<port>`, and the page must
   sign in with the token from `GET /session` (a new one each start). The page may not sit in another
   page's frame; it also refuses to arm or trade inside one.
5. Limit and stop prices on the tick grid, within 200 ticks of the last price, stops on the right side of
   the market, and refused when the last trade is more than 300 seconds old.
6. Only the instruments ChartBridge serves.
7. At most 10 order actions per second per page.

The page is tested against a fake bridge that follows the same rules (`test/fake-orders.mjs`, the
reference for ChartBridge's behaviour) with `npm test` and `npm run smoke:orders`.

## Use it

```html
<div id="chart" style="position:relative;height:600px"></div>
<script src="src/chart-engine.js"></script>
<script>
  const chart = ChartEngine.create(document.getElementById('chart'), {
    barSeconds: 60,          // 1-minute bars
    precision: 2, tick: 0.25,
  });
  chart.setBars(bars);       // [{ t, o, h, l, c, v, vw }]
  chart.setLevels(ChartEngine.util.levelLines(ChartEngine.util.sessionLevels(oneMinuteBars)));
  chart.setTrades([{ tIn, tOut, pIn, pOut, dir: 1 }]);
  onTick(bar => chart.update(bar));        // same t updates the forming bar, a newer t adds one
  ChartEngine.mountThemePanel(chart, document.getElementById('toolbar'));
</script>
```

### Time

Bar times (`t`) are **exchange wall-clock seconds stored as if they were UTC**. For CME futures
that is New York time: 10:31 ET on Sep 29, 2026 is `Date.UTC(2026, 8, 29, 10, 31) / 1000`.
`util.zoneSeconds(unixSeconds, 'America/New_York')` converts real timestamps, and the default
`clock` does this for you. Nothing else needs time-zone math.

### Options (`create(container, options)`)

| Option | Default | What it does |
|---|---|---|
| `barSeconds` | `60` | Bar length. Intraday and daily (`86400`) both work. |
| `precision`, `tick` | `2`, `0.25` | Price decimals and the minimum price step. |
| `session` | `{ start: 64800, rthStart: 34200, rthEnd: 57600 }` | Session start (18:00, the evening before) and regular hours for shading. Use `start: 0, rthStart: null` for 24/7 markets. |
| `layers` | all on | `{ volume, vwap, levels, trades }` |
| `theme` | Carolina blue / deep purple | Any key of `ChartEngine.DEFAULT_THEME`. |
| `clock` | New York now | Returns the current time in bar-time seconds (drives the countdown). |
| `rightOffset`, `barSpacing` | `8`, `7` | Empty bars past the last bar; starting bar width in px. |
| `motion` | `{ zoom: 75, fit: 120, candle: 55, follow: 110, friction: 325 }` | Time constants in ms. These are the approved feel; change with care. |
| `unit` | `'pt'` | Suffix on trade result chips. Set `label` on a trade to override. |
| `pointValue` | `0` | Dollars per point, for the position line's open P&L (or pass it to `setPosition`). |

### Methods

`setBars(bars, { barSeconds })` · `update(bar)` · `setLevels(list)` · `setTrades(list)` ·
`setLayers(partial)` · `setTheme(partial)` · `getTheme()` · `colors()` · `setPaused(bool)` ·
`setBarSeconds(sec)` · `goLive()` · `reset()` · `isLive()` · `bars()` · `stats()` · `resize()` ·
`destroy()` · `on('legend', fn)` · `on('live', fn)`

Orders (1.3.0): `setOrders(list)` · `setPosition({ qty, avgPrice } | null, { pointValue })` ·
`setOrderEditing(bool)` · `setOrderPreview(fn)` · `orderHandles()` · `priceToY(price)` · `yToPrice(y)` ·
`on('orderMove', { id, price })` · `on('orderCancel', { id })` · `on('orderPlace', { price })`. The chart only
asks; the page decides what to send. Order lines are display only until `setOrderEditing(true)`.

`on('legend')` fires with `{ bar, prev, index, forming, hovering }` whenever the bar under the
crosshair (or the forming bar) changes, so a page can draw its own OHLC legend.

### Helpers (`ChartEngine.util`)

`aggregate(bars, seconds)` rolls fine bars up; `foldLast(bars, seconds)` rebuilds just the newest one
for live updates; `addSessionVwap(bars, sessionStart)`; `sessionLevels(bars, opts)` gives prior-day
high/low/close, overnight high/low and the prior session's 70% value area; `levelLines(levels)` turns
those into styled lines; plus formatting and color helpers.

## Colors

Defaults: bull `#4B9CD3` (Carolina blue), bear `#6D28D9` (deep purple), VWAP `#B69CFF`.
`mountThemePanel(chart, host)` adds a **Colors** button with presets and pickers; choices are saved in
that browser. Trade marks use the house trade colors on purpose: entries are green (long) or red
(short), results are green (profit) or red (loss). Text drawn in a candle color is lightened
automatically so it stays readable.

## Develop

```sh
npm test          # unit tests (Node 20+, no install needed)
npm i && npm run smoke   # drives the demo in Chromium, screenshots in test/out/
npm run smoke:live       # the live page against the fake bridge as ChartBridge 0.2 (read only)
npm run smoke:orders     # order entry against the fake bridge (protocol v2)
npm run smoke:settings   # saved choices survive a reload and a second chart tab
```

Keep `CHART_STYLE.md` in step with the code, add a line to `CHANGELOG.md`, and bump the version in
`package.json` and `src/chart-engine.js` for every release.

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Manrae.
