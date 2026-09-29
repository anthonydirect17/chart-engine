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

### Methods

`setBars(bars, { barSeconds })` · `update(bar)` · `setLevels(list)` · `setTrades(list)` ·
`setLayers(partial)` · `setTheme(partial)` · `getTheme()` · `colors()` · `setPaused(bool)` ·
`setBarSeconds(sec)` · `goLive()` · `reset()` · `isLive()` · `bars()` · `stats()` · `resize()` ·
`destroy()` · `on('legend', fn)` · `on('live', fn)`

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
```

Keep `CHART_STYLE.md` in step with the code, add a line to `CHANGELOG.md`, and bump the version in
`package.json` and `src/chart-engine.js` for every release.
