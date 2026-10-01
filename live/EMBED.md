# Embedding the live chart (ChartLive.mount)

The single chart page (`live/single.html`, served by ChartBridge at `http://localhost:8765/single.html`), the
workspace (`live/index.html`, ChartBridge's main page at `http://localhost:8765/`, a host of its own) and a host page such
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
Leave out `data-mount="page"`: that attribute is how `live/single.html` boots the standalone page into `body`.

Record the chart-engine commit and version (`ChartEngine.VERSION`) in the host's `VENDORED.txt`.

Optional: the IBM Plex fonts the chart uses (IBM Plex Sans, Sans Condensed and Mono, from Google Fonts in
`live/single.html`). Without them the chart falls back to system fonts.

If the host sets a Content Security Policy: `connect-src` must allow the WebSocket URLs it passes (for
example `ws://localhost:8765` and its own relay), and `style-src` must allow inline styles (the engine adds one
`<style>` element and the chart uses a few `style` attributes).

## Mount

```js
const pane = ChartLive.mount(document.getElementById('live-pane'), {
  wsUrl: () => pickUrl(),          // required; a string, or a function returning a string or a promise of one
  paneId: 'main',                  // this chart's indicator choices
  storagePrefix: 'desk:',          // this host's own settings
  onStatus: s => showState(s.state),
});
// later, when the section closes or the pane is removed:
pane.destroy();
```

The container needs a height: the chart fills it (`.chart-live` is `height: 100%`) and the chart area keeps a
minimum of 360 px. Several charts can be mounted in one page, each in its own container.

Keys (1.6.0): each mounted chart listens on `document` (bubbling) for **"/"**, which opens its Indicators menu when
the focus is inside that chart, or, with nothing focused (the page body), when the mouse is over it (or it is the
only chart on the page). It never acts while any element outside the chart has the focus (a host dialog, button or
field), nor while a text box, select or editable element has it, nor with Ctrl, Alt or Cmd. It also skips a key
already marked handled (`preventDefault`), but only a host listener that runs before the chart's (capture phase, or
added on `document` earlier) can do that; one on `window` runs after. The menu stays inside the chart's own width,
so a narrow pane in a host that clips its panes still shows all of it. Read-only mounts can show, hide, add, remove
and pin indicators like the standalone page (nothing is sent to ChartBridge for it).

Account (1.6.0): a mounted chart has no order bar, so a compact **Account** picker sits in its toolbar; the chart
marks that account's fills only (there is no "All accounts" any more). It lists the accounts ChartBridge names in
`hello` and any with fills, those with fills first, and remembers the choice per prefix (`live-account-v1`). A
mounted chart still follows a pick made by another chart or tab with its prefix (1.6.1 changes this only on the
trading page, where each tab keeps its own order account).

`mount` returns `{ destroy(), chart, element, paneId, setIndicatorOption(id, key, value), indicatorOptions(id) }`:
`chart` is the chart-engine instance (for reading, such as `chart.bars()`), `element` the `.chart-live` element it
created in the container. `setIndicatorOption` sets an indicator's own option on this pane and saves it (1.6.0). There
are two:

| Call | What it does |
|---|---|
| `pane.setIndicatorOption('vp', 'session', 'rth')` | the volume profile's hours: `'rth'` for RTH 9:30 to 16:00 ET, `'full'` for the whole session from 18:00 ET (the default) |
| `pane.setIndicatorOption('delta', 'show', 'bar')` | the cumulative delta pane (1.7.0): `'bar'` for each bar's own buys minus sells around zero, `'cum'` for candles of the running cumulative from 18:00 ET (the default) |

It returns false (and never throws) for an option or value that does not exist, including inherited names such as
`toString`. `indicatorOptions('vp')` and `indicatorOptions('delta')` read them back (`{ session: 'full' }`,
`{ show: 'cum' }`). The gear panels in the Indicators menu have the same switches (Hours: Session or RTH; Show:
Cumulative or Bar delta).

Cumulative delta (1.7.0): a pane under the chart with market buys minus market sells, on for `paneId` `'main'` and off
for any other pane until added from its Indicators menu. The side of each trade comes from ChartBridge 0.3.4 (every
trade carries `s`); with ChartBridge 0.3.3 or older the pane draws nothing and says "Delta needs ChartBridge 0.3.4 on
this PC". A relay must pass the `s` and `sm` fields of `tick` messages and the fourth and fifth places of each `ticks`
trade through unchanged. The pane starts at about 20% of the chart's height; the line above it can be dragged (or
focused with Tab and moved with the up and down arrow keys, Page Up, Page Down, Home and End), and its height is saved
per pane (`live-pane-heights-v1`). The divider is an element inside the chart; nothing new listens on `document` or
`window`.

The volume profile keeps the last session until the next session's first trade (legend "(Fri)"; RTH through the
weekday night until the next 9:30), for the ticks the chart has (1.6.1): it asks for no more tick history than 1.6.0,
so after a weekend load it shows what the view's ticks hold, with a quiet note. The Desk's relay clamps `tickHours` to
`THEDESK_LIVE_RELAY_TICK_HOURS` (default 8) as before.

| Option | Default | What it does |
|---|---|---|
| `wsUrl` | none, required | ChartBridge's WebSocket URL. A **function** is called again for **every** connect and reconnect, so it can hand out a fresh single-use relay ticket each time (`/api/live/ws?ticket=...`), or choose between `ws://localhost:8765/ws` and the relay. It may return a promise; a thrown error or a rejected promise counts as a failed connect and is retried. The query string is never shown on screen. |
| `paneId` | `'main'` | Key for this chart's indicators (Volume bars, VWAP, Levels, Initial balance, Volume profile, Cumulative delta, Fills: on the chart, shown, pinned; and their options), the delta pane's height and drawings. `'main'` starts with the five on and pinned and the cumulative delta pane on without a chip (the volume profile off), any other id with none on (Anthony's rule for new panes). Give every pane its own id. |
| `storagePrefix` | `'embed:'` | Put in front of every storage key, see below. |
| `onStatus` | none | Called with `{ state, paneId, root, attempt }` on every connection change. `state` is `'connecting'`, `'loading'` (subscribed, history coming), `'live'` or `'offline'`; `attempt` counts failed connects since the last good one. |
| `brand` | `false` | Show The Desk logo and "Live chart" at the start of the toolbar (the standalone page shows it). |
| `presetStore` | this browser's storage | Where the Colors panel's named presets live (1.9.0): `{ list(), save(group, name, colors, ind), rename(group, id, name), remove(group, id), shared }` (`ind`: a chart preset's linked indicator preset id), each call returning a promise, as `LivePrefs.localPresetStore` in `live/live.js` describes. |
| `feed` | none | A `ChartFeed` hub (`live/feed.js`, `ChartFeed.create({ wsUrl })`): the chart takes its data from the hub's one connection per instrument instead of opening its own WebSocket, so several charts (and tapes) of one instrument share one connection and one subscribe. `wsUrl` is then not needed. Added for the workspace (E2a). |
| `view` | none | `{ root, tf, range }`: the chart's own instrument, bars (`s15` to `h1`, `range`) and range size in ticks. The chart starts on them and never saves them under the prefix; the host keeps them (`onView`). Without it the chart reads and saves them under the prefix as before. |
| `onView` | none | Called with `{ root, tf, range }` whenever the chart's instrument, bars or range size change (from its toolbar or `setView`). |
| `toolbar` | `true` | `false`: the chart's toolbar is not shown. The host shows its own header with the chart's Indicators button (the returned `indicators` element, moved into an element with the class `chart-live` so `live.css` styles it) and calls `setView`, `chart.setTool`, `chart.clearDrawings`, `chart.reset`. |
| `onColors` | none | Called after this chart's Colors panel or an indicator gear changed a color, so a host can call `refreshColors()` on its other charts. |

With these options the returned object also has `setView({ root, tf, range })` (any of the three), `view()`,
`refreshSettings()` (Glide and Range style read again from storage, for a host whose Settings change them),
`refreshColors()` (the chart and indicator colors read again from storage), and the elements `indicators` (the
Indicators button and its menu) and `colors` (the Colors button and panel) for a host to place. None of it changes a
chart mounted without them.

Reconnecting works as on the standalone page: after a drop it tries again after 0.5 s, then 1 s, 1.5 s and so
on up to every 5 s. Before the first connection the chart shows "Waiting for ChartBridge"; after a drop it shows
"Lost ChartBridge" from the third failed try in a row. Each try calls `wsUrl` again.

`destroy()` saves anything typed and not yet saved (a range size, as on page close), closes the WebSocket
(no reconnect follows), clears every timer, removes the chart's listeners on `document` and `window` and the
Colors panel, and removes the chart's element. Calling it twice is harmless. Mounting again afterwards,
in the same container or another, works.

## Connecting straight to ChartBridge: allowOrigins

ChartBridge 0.3.1 and newer accept a browser WebSocket only from their own page or from an origin listed in
`allowOrigins` in `Documents\NinjaTrader 8\ChartBridge\config.txt`. A host page that connects straight to
`ws://localhost:8765/ws` (The Desk on the trading PC) must have its own origin there, exactly as the browser sends
it (`scheme://host[:port]`, no wildcard, the last `allowOrigins` line wins), for example:

```
allowOrigins = https://desk.golivepage.com, http://100.88.192.33:8800, http://localhost:8800
```

Otherwise ChartBridge answers 403, the chart stays on CONNECTING and "Waiting for ChartBridge", and `onStatus`
reports `offline` after every try. A relay that connects from a server program sends no `Origin` header and
needs no entry. Listed origins can read, never trade (see nt8/PROTOCOL.md, Network access).

ChartBridge 0.3.2 locks its own page with a PIN (nt8/PROTOCOL.md, PIN). That lock is for ChartBridge's own
origin only: a host listed in `allowOrigins` and a relay with no `Origin` connect exactly as before, and a
mounted chart never loads `pin.js`, never shows the PIN pad and never asks `/pin/` anything. Do not vendor
`live/pin.js` or `live/pin.css`; they belong to the standalone page.

## What the chart sends (for a relay)

A read-only chart sends only these messages (nt8/PROTOCOL.md), so a relay in between only has to pass them on:

| Message | Fields and bounds |
|---|---|
| `subscribe` | `root`: `MNQ`, `NQ`, `MES` or `ES`. `days`: always `5` (1-minute history). `tickHours`: `0` for 1m bars and longer, `8` for 15s and 30s, and for Range bars the hours back to a session start, today `9` to `33` depending on the time of day (the chart never asks for more than `48`, ChartBridge's own cap). Sent on connect and on every instrument change, and when a new view needs more tick history. |
| `ping` | `c` (the page clock). Allowed, but the chart does not send it today. |

To ChartBridge 0.3.5 or later, whose `hello` lists `liveFirst` and `profile` in `features` (1.8.0), the `subscribe` also
carries `sub` (the chart's subscribe id), `profile: true`, and on seconds and range views `liveFirst: true` with
`tickHours` 2 (the served window, nt8/PROTOCOL.md). A relay that passes `hello` without `features` (The Desk's does) never
sees them: the chart subscribes as before, and ChartBridge 0.3.5 answers its tick subscribes with the served window (the
last 2 hours) all the same. For the exact session profile in The Desk, the relay needs to pass `features` in `hello` and
the `profile` message to the page, and The Desk to vendor chart 1.8.0.

A relay may clamp `tickHours` to a lower cap instead of refusing the subscribe. The chart then works as with a PC
that has little tick history: Range bars start where the ticks start, and the status line says "Range bars start
at <time> ET: NinjaTrader sent less tick history than asked, so bars until the next 18:00 session may differ from
NinjaTrader's." The delta pane (1.7.0) counts only trades whose side was measured (live trades, and backfill trades in
ChartBridge's quote window), so a capped backfill changes it only when that window reaches past the cap; it labels a
session counted from later than 18:00 with the start ("since 18:05 ET"). A relay that refuses the subscribe leaves the chart on LOADING (no `history` or `ready` arrives).

## Read-only guarantee

A chart made with `ChartLive.mount` is always read only: there is no option to turn trading on (a `trading`
option is ignored). Only the standalone page, booted by `live/single.html` with `data-mount="page"`, can trade (the
workspace's charts are read only until its order ticket, E2b).

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
| `live-indicators-v2` | `{ <paneId>: { ind: { <id>: { on, shown, pin } }, recent, restore } }` (1.6.0; carried over once from `live-indicators-v1`, left in place) | one entry per `paneId` |
| `live-indicator-options-v1` | `{ <paneId>: { vp: { session: 'full' \| 'rth' }, delta: { show: 'cum' \| 'bar' } } }` (1.6.0; `delta` 1.7.0) | one entry per `paneId` |
| `live-pane-heights-v1` | `{ <paneId>: { delta: 0.2 } }` the delta pane's share of the chart height, 0.08 to 0.6 (1.7.0) | one entry per `paneId` |
| `live-bracket-v1` | bracket ticks per instrument (trading only) | all charts with this prefix |
| `live-account-v1` | the account picked, whose fills are marked (1.6.0; the 1.5 `live-fill-account-v1` is read once when it is missing, its "All accounts" meaning none picked) | all charts with this prefix |
| `live-drawings-v1-<ROOT>` | drawings per instrument on pane `main` | pane `main` |
| `live-drawings-v1-<paneId>-<ROOT>` | drawings per instrument on any other pane | that pane |
| `live-colors-v1` | candle and background colors (Colors panel), saved one color at a time (and the VWAP before 1.9.0) | all charts with this prefix |
| `live-indicator-colors-v1` | `{ vwap, prior, overnight, value, close, ibHigh, ibLow, vpPoc }` the indicator colors set in their gears (1.9.0; the VWAP of `live-colors-v1` is read while this key is missing) | all charts with this prefix |
| `live-color-presets-v1` | `{ chart: [{ id, name, colors }], indicator: [...] }` the named presets (1.9.0), unless `presetStore` is passed | all charts with this prefix |

So with `storagePrefix: 'desk:'` The Desk's chart keeps `desk:live-settings-v2` and so on, and never reads or
writes the standalone page's keys even when both run on the same origin. With no `storagePrefix` a mounted
chart uses `'embed:'` (`ChartLive.EMBED_PREFIX`). Passing `''` on purpose shares the standalone page's
settings. The 1.3 keys (`live-settings-v1`, `live-range-v1`) are only carried over for the empty prefix.

Choices shared by all charts with one prefix (instrument, bars and the rest in the table) are each read when a
chart mounts and written one field at a time when changed, so two panes never undo each other while they run;
after a reload both start from the last change either made. Indicators and drawings are kept per pane, so two
panes on one instrument each keep their own lines.
