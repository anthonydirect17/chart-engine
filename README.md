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
3. Open `http://localhost:8765/` in Chrome or Edge. The first time on each PC it asks Anthony to **set a
   4-digit PIN** (see [The PIN on ChartBridge's page](#the-pin-on-chartbridges-page)).

Live CME data is licensed for your own screen: never publish it (the GitHub Pages demo stays on sample
data).

On the page, the **Indicators** menu (1.6.0) adds, shows, hides and removes Volume bars, VWAP, Levels, Fills and the
**Initial balance** (today's 1-hour IB, 1.5.3) per chart pane, with a search box ("/" opens it), a Recent line, Hide
all and Restore, and a pin for each on the chip strip beside the button (one click shows or hides; at most 6). Hiding
Fills never hides the open trade (its entry fills, the position line, working orders, stop and target lines). One
**Account** picker, the order bar's (or, with no order bar, a compact one in the toolbar), chooses the account for
orders and whose fills are marked. **Range** bars are
built like NinjaTrader's (every finished bar exactly the range; see `docs/RANGE_BARS.md`), or from traded
prices only, picked next to the range size, which is kept per instrument. Every choice is remembered in
this browser as soon as it is made. The same chart can be mounted in another page (The Desk) with
`ChartLive.mount`, read only; see `live/EMBED.md`. `http://localhost:8765/diag` shows what ChartBridge
sees (accounts, fill counts, clock, The Desk queue, and since 0.3.3 where each load's backfill met the live
trades); see `nt8/PROTOCOL.md`.

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
| `allowOrigins` | none | Other web pages that may open the read-only WebSocket (ChartBridge 0.3.1), comma separated, each an exact `scheme://host[:port]`, no wildcard, e.g. `https://desk.golivepage.com, http://100.88.192.33:8800` for The Desk's Live trading page (add `http://localhost:8800` or `http://127.0.0.1:8800` too if The Desk is ever opened that way). One line: the last `allowOrigins` line wins. Non-ASCII host names in punycode. They can read, never trade. |

**This PC only** (ChartBridge 0.3.1). Windows' web server (HTTP.sys) listens on every network interface and
matches only the `Host` header, so the `localhost` address alone does not keep other devices out. ChartBridge
therefore refuses (403) every request that does not come from this PC, on every path, before anything else,
and takes a browser WebSocket only from its own page or an `allowOrigins` entry. A local program that sends no
`Origin` header (such as The Desk's server relay) is allowed. As a second layer, keep inbound port 8765 blocked
in the Windows firewall; in an admin PowerShell:

```
New-NetFirewallRule -DisplayName "ChartBridge 8765 block inbound" -Direction Inbound -Protocol TCP -LocalPort 8765 -Action Block
```

The firewall does not filter traffic within the PC, so the chart and The Desk on this PC keep working. After
installing 0.3.1, check once that a plain request and a WebSocket upgrade to the PC's Tailscale or LAN address
get 403 (the two `curl` lines are in "Network access" in `nt8/PROTOCOL.md`).

**Never forward anything to 8765**: no cloudflared ingress, `tailscale serve` or `funnel`, `netsh interface
portproxy`, `ssh -R` or local reverse proxy pointing at it. A forwarded client arrives as 127.0.0.1 and passes the
this-PC rule. The rules keep out other devices and web pages, not software running on this PC: any local program
can connect from 127.0.0.1 and send any `Origin`.

### The PIN on ChartBridge's page

ChartBridge 0.3.2 locks its own page (`http://localhost:8765/`) with a 4-digit PIN, so someone else at this PC
cannot open it and see or trade Anthony's accounts. It is a kid lock, not high security, and it never locks
Anthony out of a trade:

- **Setting it.** While no PIN is set, the page shows **Set a PIN** (enter four digits, then the same four
  again). Nothing streams and no order bar shows until then. Each PC has its own PIN, set on that PC.
- **Unlocking.** Each time the page opens (or is reloaded) it asks for the PIN, with a pad that works with
  the mouse, touch or the keyboard (digits, Backspace, Delete clears). A wrong PIN is simply refused:
  **there is no lockout**, nothing is counted and nothing waits, so the right PIN always works at once.
- **Staying unlocked.** Once unlocked, the page stays unlocked while it is open, including across a
  ChartBridge restart (a recompile with F5, or restarting NinjaTrader): the page reconnects on its own and
  signs in again without asking. The unlock lives only in the open page (never saved in the browser), so
  a reload asks again. Armed is still off after a reload or a dropped connection, as before.
- **Changing it.** The **PIN** button in the toolbar asks for the current PIN, then the new one twice.
  Pages already open stay unlocked.
- **Forgotten PIN.** Delete `pin.txt` in `Documents\NinjaTrader 8\ChartBridge\` on this PC (NinjaTrader
  may stay open; no recompile). The page then asks for a new PIN the next time it opens or reconnects. Only
  someone at this PC can do this. Pages that were open keep their current connection, but once they
  reconnect they ask for the new PIN like any other page.
- **First run.** On a fresh PC, whoever opens the page first sets the PIN: open it and set the PIN right
  after installing.
- **Revoking.** Deleting `pin.txt` also revokes every open page: each asks for the new PIN on its next
  reconnect.
- **A damaged or locked pin.txt** (a backup or antivirus holding it, a power cut mid-write) never counts as
  "no PIN": open pages keep working from the copy ChartBridge read earlier, nobody is offered "Set a PIN",
  and the page recovers by itself once the file reads again. If ChartBridge starts with it damaged, the page
  keeps its unlock and waits, with a note saying why; delete `pin.txt` if it stays that way.
- **What is stored.** `pin.txt` holds a salted PBKDF2-SHA256 hash of the PIN (50,000 iterations), never
  the PIN, plus a random key that lets ChartBridge recognise pages it has unlocked. ChartBridge never logs
  the PIN or any token; `/diag` shows only whether a PIN is set.
- **What it does not touch.** The Desk's Live tab (listed in `allowOrigins`, with its own PIN) and local
  programs such as The Desk's relay connect exactly as before, without ChartBridge's PIN. The chart mounted
  in The Desk (`ChartLive.mount`) never shows the PIN pad.

Details: "PIN" in `nt8/PROTOCOL.md`.

Without NinjaTrader, `npm run bridge` starts a fake bridge with sample data at `http://localhost:8765/live/`
(`npm run bridge -- --trading --trade-accounts=Sim101,DEMO-EVAL --max-qty=MNQ:5` to try order entry on
simulated fills; the flags are listed at the top of `test/fake-bridge.mjs`). The fake has the same PIN; it
asks for one to be set unless started with `--test-pin=<made-up PIN>`, and `--pin-file=<path>` keeps it
across fake restarts.

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
- **Account** (only `tradeAccounts`; Sim101 is chosen first), **Qty** (1 to that instrument's cap). The chart
  marks this account's fills (1.6.0). With trading off the picker lists every account ChartBridge knows and still
  switches the fills.
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
  drag (or let go outside the chart's plot) to put it back, and click the x to cancel it (a bracket leg takes its pair with it). The position
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
4. Only ChartBridge's own page: the WebSocket Origin must be `http://localhost:<port>` (pages listed in
   `allowOrigins` can read, never trade), and the page must
   sign in with the token from `GET /session` (a new one each start; 0.3.2: only for a page unlocked with
   the PIN). The page may not sit in another
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
| `layers` | all on | `{ volume, vwap, levels, trades, ib }`; a level with `layer: 'ib'` shows with `ib`, the rest with `levels` |
| `theme` | Carolina blue / deep purple | Any key of `ChartEngine.DEFAULT_THEME`. |
| `clock` | New York now | Returns the current time in bar-time seconds (drives the countdown). |
| `rightOffset`, `barSpacing` | `8`, `7` | Empty bars past the last bar; starting bar width in px. |
| `motion` | `{ zoom: 75, fit: 120, candle: 55, follow: 110, friction: 325 }` | Time constants in ms. These are the approved feel; change with care. |
| `unit` | `'pt'` | Suffix on trade result chips. Set `label` on a trade to override. |
| `pointValue` | `0` | Dollars per point, for the position line's open P&L (or pass it to `setPosition`). |

### Methods

`setBars(bars, { barSeconds })` · `update(bar)` · `setLevels(list)` · `getLevels()` · `setTrades(list)` ·
`setLayers(partial)` · `setTheme(partial)` · `getTheme()` · `colors()` · `setPaused(bool)` ·
`setBarSeconds(sec)` · `goLive()` · `reset()` · `isLive()` · `bars()` · `stats()` · `resize()` ·
`destroy()` · `on('legend', fn)` · `on('live', fn)` · `on('error', fn)`

Volume profile (1.6.0): `new ChartEngine.VolumeProfile({ tick, rowTicks, valueArea, rth })` counts
trades (`add(t, price, v)`) into rows with a POC and value area, per 18:00 ET session, or with `rth: true` only
9:30:00 up to 16:00:00 ET. `setProfile(profile | null)` hands one to the chart, drawn while the `vp` layer is on
(`setLayers({ vp: true })`, off by default) as bars from the right edge of the plot behind the candles; the chart
redraws on its own when the profile changes.

Orders (1.3.0): `setOrders(list)` · `setPosition({ qty, avgPrice } | null, { pointValue })` ·
`setOrderEditing(bool)` · `setOrderPreview(fn)` · `orderHandles()` · `priceToY(price)` · `yToPrice(y)` ·
`on('orderMove', { id, price })` · `on('orderCancel', { id })` · `on('orderPlace', { price })`. The chart only
asks; the page decides what to send. Order lines are display only until `setOrderEditing(true)`.

`on('legend')` fires with `{ bar, prev, index, forming, hovering }` whenever the bar under the
crosshair (or the forming bar) changes, so a page can draw its own OHLC legend.
`on('error')` (1.5.1) fires with `{ message, error }` when drawing a frame throws (the chart keeps running, and
each message is reported at most once per 5 s), and with `null` at the next clean frame.

### Helpers (`ChartEngine.util`)

`aggregate(bars, seconds)` rolls fine bars up; `foldLast(bars, seconds)` rebuilds just the newest one
for live updates; `addSessionVwap(bars, sessionStart)`; `sessionLevels(bars, opts)` gives prior-day
high/low/close, overnight high/low and the prior session's 70% value area; `levelLines(levels)` turns
those into styled lines; `initialBalance(data, opts)` (1.5.3) gives today's 1-hour Initial Balance (9:30 to
10:30 ET) from 1-minute bars or trades, with its state (`before`, `forming`, `locked`, or why there is none), and
`ibLines(ib)` turns it into lines; `rthDay(t)` and `nyseHolidays(year)` say which days have a regular session;
`profileRects(columns, view, emit)` lays out a volume profile's bars (1.6.0); plus
formatting and color helpers (`readableOn`, `legible`, `onGround`, `mix`, `buildTheme`).

## Colors

Defaults: bull `#4B9CD3` (Carolina blue), bear `#6D28D9` (deep purple), VWAP `#B69CFF`.
`mountThemePanel(chart, host)` adds a **Colors** button with presets and pickers; choices are saved in
that browser. Trade marks use the house trade colors on purpose: entries are green (long) or red
(short), results are green (profit) or red (loss). Text drawn in a candle color is lightened
automatically so it stays readable.

**Background (1.5.3):** the panel's Background presets (Dark, the default; Black; Blue-grey; Light) and a picker
for any color set `theme.bg`. On the default ground every color is the locked palette. On any other ground
`buildTheme` derives the grid, axes, text and tags from it and moves every colored mark (candles, VWAP, levels,
trade and order colors) just enough to read, once per change, never per frame, keeping bull and bear, buy and sell,
and the IB high and low apart on every ground (buy and sell keep their green and red, outlined where needed). `getTheme()` returns the colors as chosen; `colors()` the colors as
drawn, including `text2`, `legendBg` and `ground` for a page's own legend; `util.chromeColors(colors())` gives the CSS
colors for a page's toolbar on a light ground (null on dark ones), which the live page and the demo apply.

## Develop

```sh
npm test          # unit tests (Node 20+, no install needed)
npm i && npm run smoke   # drives the demo in Chromium, screenshots in test/out/
npm run smoke:live       # the live page against the fake bridge as ChartBridge 0.2 (read only)
npm run smoke:orders     # order entry against the fake bridge (protocol v2)
npm run smoke:settings   # saved choices survive a reload and a second chart tab
npm run smoke:embed      # ChartLive.mount in a plain host page: read only, reconnects, destroy, two panes
npm run smoke:pin        # the PIN on ChartBridge's page: set, unlock, reload, a restart mid-session, change, forgotten PIN
npm run smoke:perf       # Range 40 with 33 hours of sample ticks and a busy feed: the chart keeps drawing, no long frames
npm run smoke:ib         # Initial balance forming, locked, on every view and mounted; the Background presets, saved per prefix
node test/perf-live.mjs --view=range --et=01:30   # the full measurement (frames, ticks, GC, heap); --root=DIR for another checkout
```

Keep `CHART_STYLE.md` in step with the code, add a line to `CHANGELOG.md`, and bump the version in
`package.json` and `src/chart-engine.js` for every release.

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Manrae.
