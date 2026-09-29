# Embedding the live chart (ChartLive.mount)

The live chart page (`live/index.html`, served by ChartBridge at `http://localhost:8765/`) and a host page such
as The Desk run the same code. The standalone page boots itself; a host page calls `ChartLive.mount`. Every
change to the standalone chart therefore shows up in the host as soon as the host vendors the new files.

## Files to vendor, in load order

Copy these five files from one chart-engine commit (all from the same version), and load them in this order:

| # | File in chart-engine | How the host loads it | Defines |
|---|---|---|---|
| 1 | `live/live.css` | `<link rel="stylesheet">` | styles, all scoped under `.chart-live` |
| 2 | `src/chart-engine.js` | `<script>` or `<script defer>` | `window.ChartEngine` |
| 3 | `live/bar-builder.js` | `<script>` or `<script defer>` | `window.BarBuilder` |
| 4 | `live/order-ticket.js` | `<script>` or `<script defer>` | `window.OrderTicket` (needed even read only: `live.js` reads it at load) |
| 5 | `live/live.js` | `<script>` or `<script defer>`, **without** `data-mount` | `window.LivePrefs`, `window.ChartLive` |

No bundler, no build step. Scripts 2 to 5 must run in this order (plain `defer` scripts keep document order),
and `ChartLive.mount` must run after script 5, for example from the host's own deferred or module script.
Leave out `data-mount="page"`: that attribute is how `live/index.html` boots the standalone page into `body`.

Record the chart-engine commit and version (`ChartEngine.VERSION`) in the host's `VENDORED.txt`.

Optional: the IBM Plex fonts the chart uses (IBM Plex Sans, Sans Condensed and Mono, from Google Fonts in
`live/index.html`). Without them the chart falls back to system fonts.

If the host sets a Content Security Policy: `connect-src` must allow the WebSocket URLs it passes (for
example `ws://localhost:8765` and its own relay), and `style-src` must allow inline styles (the engine adds one
`<style>` element and the chart uses a few `style` attributes).

## Mount

```js
const pane = ChartLive.mount(document.getElementById('live-pane'), {
  wsUrl: () => pickUrl(),          // required; a string, or a function returning a string or a promise of one
  trading: false,                  // the default: read only
  paneId: 'main',                  // this chart's indicator choices
  storagePrefix: 'desk:',          // this host's own settings
  onStatus: s => showState(s.state),
});
// later, when the section closes or the pane is removed:
pane.destroy();
```

The container needs a height: the chart fills it (`.chart-live` is `height: 100%`) and the chart area keeps a
minimum of 360 px. Several charts can be mounted in one page, each in its own container.

`mount` returns `{ destroy(), chart, element, paneId }`: `chart` is the chart-engine instance (for reading,
such as `chart.bars()`), `element` the `.chart-live` element it created in the container.

| Option | Default | What it does |
|---|---|---|
| `wsUrl` | none, required | ChartBridge's WebSocket URL. A **function** is called again for **every** connect and reconnect, so it can hand out a fresh single-use relay ticket each time (`/api/live/ws?ticket=...`), or choose between `ws://localhost:8765/ws` and the relay. It may return a promise; a thrown error or a rejected promise counts as a failed connect and is retried. The query string is never shown on screen. |
| `trading` | `false` | Read only, see below. `true` is what the standalone page uses; ChartBridge only accepts orders from its own page, so a host gains nothing by setting it. |
| `paneId` | `'main'` | Key for this chart's indicator choices (Volume, VWAP, Levels, Fills). `'main'` starts with all four on, any other id with none on (Anthony's rule for new panes). Give every pane its own id. |
| `storagePrefix` | `'embed:'` | Put in front of every storage key, see below. |
| `onStatus` | none | Called with `{ state, paneId, root, attempt }` on every connection change. `state` is `'connecting'`, `'loading'` (subscribed, history coming), `'live'` or `'offline'`; `attempt` counts failed connects since the last good one. |
| `brand` | `false` | Show The Desk logo and "Live chart" at the start of the toolbar (the standalone page shows it). |

Reconnecting works as on the standalone page: after a drop it tries again after 0.5 s, then 1 s, 1.5 s and so
on up to every 5 s. Before the first connection the chart shows "Waiting for ChartBridge"; after a drop it shows
"Lost ChartBridge" from the third failed try in a row. Each try calls `wsUrl` again.

`destroy()` saves anything typed and not yet saved (a range size, as on page close), closes the WebSocket
(no reconnect follows), clears every timer, removes the chart's listeners on `document` and `window` and the
Colors panel, and removes the chart's element. Calling it twice is harmless. Mounting again afterwards,
in the same container or another, works.

## Read-only guarantee (trading: false)

- The chart never requests `GET /session` and never sends `auth`.
- Only `subscribe` and `ping` messages ever leave it: `send` drops every other type, whatever calls it.
  Messages about trading from ChartBridge (`trading`, `orders`, `order`, `position`, `reject`) are ignored.
- There is no order bar, no Armed switch and no ARMED pill in the page at all, no Shift+click order preview or
  placing, and no draggable order lines (order editing is never turned on in the chart).
- On top of that, ChartBridge itself refuses orders from any page but its own (the WebSocket Origin must be
  `http://localhost:<port>`, and trading needs the session token only that page can read).

`npm run smoke:embed` checks all of this against the fake bridge with trading offered.

## Storage prefix rule

Every storage key the chart uses is `storagePrefix + <the standalone page's key>`, in this browser's
`localStorage` for the host's origin. The standalone page uses no prefix:

| Standalone key | What it holds | Shared by |
|---|---|---|
| `live-settings-v2` | instrument, bars, glide, range mode | all charts with this prefix |
| `live-range-v2` | range size per instrument | all charts with this prefix |
| `live-indicators-v1` | `{ <paneId>: { volume, vwap, levels, fills } }` | one entry per `paneId` |
| `live-bracket-v1` | bracket ticks per instrument (trading only) | all charts with this prefix |
| `live-fill-account-v1` | whose fills are marked | all charts with this prefix |
| `live-drawings-v1-<ROOT>` | drawings per instrument | all charts with this prefix |
| `live-colors-v1` | candle and VWAP colors (Colors panel) | all charts with this prefix |

So with `storagePrefix: 'desk:'` The Desk's chart keeps `desk:live-settings-v2` and so on, and never reads or
writes the standalone page's keys even when both run on the same origin. With no `storagePrefix` a mounted
chart uses `'embed:'` (`ChartLive.EMBED_PREFIX`). Passing `''` on purpose shares the standalone page's
settings. The 1.3 keys (`live-settings-v1`, `live-range-v1`) are only carried over for the empty prefix.

Choices shared by all charts with one prefix (instrument, bars and the rest in the table) are each read when a
chart mounts and written one field at a time when changed, so two panes never undo each other while they run;
after a reload both start from the last change either made. Only indicators are kept per pane today.
