# Anthony's chart style: the one chart for every project

**Anthony, 2026-09-29:** "that chart is so perfect, lock that in as our exact charting style for this and
all future projects." Then, after comparing engines: "Custom, and honestly I have to say, that is such a
fantastic chart. Thats what I want to actually trade on."

- **Source of truth:** this repo, `anthonydirect17/chart-engine`. The code wins over this page; copy
  values from `src/chart-engine.js`, do not re-derive them.
- **Engine:** the Custom Canvas 2D engine (decided 2026-09-29). Not Lightweight Charts.
- **Sits under** Anthony's `HOUSE_STYLE.md`. The design is Anthony's; do not "improve" it.
- **Engine version:** 1.12.1 (1.5.3 added the 1-hour Initial Balance lines and the Background choice; on the
  default ground every color below is unchanged. 1.6.0 is the live page's Indicators menu "E2" and chip strip; the
  chart itself draws exactly as in 1.5.3. 1.7.0 adds the cumulative delta pane below the chart; with it off the chart
  draws exactly as in 1.6.0. 1.9.0 adds color presets and indicator colors in the gears; with the default colors the
  chart draws exactly as in 1.7.0. 1.12.1 adds the chart signals and their tokens `--sig-bull`, `--sig-bull-line`,
  `--sig-bear`, `--sig-bear-line`; with them off the chart draws exactly as in 1.12.0). Page and engine 1.14.0 (the
  display round, Anthony's list of 2026-10-01): the live pages draw no grid lines by default, keep 80 px of room right of
  the last bar at any zoom, keep every order on the price scale and no longer size it by the VWAP; everything else draws
  as in 1.13.0. Page and engine 1.15.0 (the workspace only; `/single.html` draws exactly as 1.14.0): the Zone drawing, the
  corner readout, compact order labels and spaced day labels on a host's charts (engine options `compactLabels`,
  `toolOrders`, `spacedDays`, all off by default), 4h, 1D and 1W charts; no new colors.

## Colors

Candle colors are Anthony's choice and can be changed in the chart's **Colors** panel (presets and
pickers, saved per browser); the indicators' colors in their gears (1.9.0). Defaults:

| Use | Value |
|---|---|
| Bull candle and volume | `#4B9CD3` Carolina blue (volume at 26% opacity) |
| Bear candle and volume | `#6D28D9` deep purple (volume at 26% opacity) |
| VWAP | `#B69CFF` (its color in the VWAP gear, 1.9.0) |
| Trade entry | `#3DDC97` long, `#FF7A7A` short (house trade-side colors) |
| Trade result line and chip | `#3DDC97` profit, `#FF7A7A` loss |
| Trade exit, live dot | `#F2F6FA` |
| Working orders (1.3.0) | `#3DDC97` buy, `#FF7A7A` sell (house trade-side colors) |
| Position line and tag | `#F2F6FA`; open P&L text `#3DDC97` profit, `#FF7A7A` loss |
| Armed (live page and ticket) | 1.13.0: the house crimson `#9F1239` switch and ARMED pill with the logo's light ink `#FFE4EA` (6.7:1), the order bar or ticket outline in the crimson word color `#E0445E` (4.5:1 on the bar); the chart's outline the workspace accent `#7B5CFF` with a soft glow on both pages; amber `#E0B45A` before |
| Chart ground | `#080B10` |
| Regular-hours ground (bars under 1 hour) | `#0B1016` |
| Grid hairlines | `rgba(42,54,69,0.30)` |
| Axis borders | `#18212C` |
| Session divider, tag borders | `#2A3645` |
| Crosshair lines | `#5B6B80` |
| Axis text | `#8392A5`; day and month labels `#E6EDF5` |
| Crosshair tags | fill `#141C26`, border `#2A3645`, text `#F2F6FA` |
| Overnight high/low | `#7FB2FF` |
| Prior-day high/low | `#9AA8B8` |
| Prior close | `#8392A5` |
| Value area high/low | `#E0B45A` |
| Initial Balance high (1.5.3) | `#F7C6EC` bright orchid (Anthony: the high brighter than the low; 1.59:1 from the low) |
| Initial Balance low (1.5.3) | `#E58BD2` orchid, the base (the one level hue nothing else on the chart uses) |
| Signals, bullish (G1c) | `--sig-bull` `#38DCE8` a softer cyan; outline `--sig-bull-line` `#9CF1F7` (Anthony's NinjaTrader cyan, toned) |
| Signals, bearish (G1c) | `--sig-bear` `#F3D84A` a warm yellow; outline `--sig-bear-line` `#FFEC8F` (his NinjaTrader yellow, toned) |
| Time and Sales, above the ask (1.14.0) | `--tape-above` `#9CF5CB`, the brighter green (14.9:1 on the tape's panel `#0B0F15`) |
| Time and Sales, at the ask (1.14.0) | `--tape-ask` `#3DDC97`, the house buy green (10.9:1) |
| Time and Sales, between (1.14.0) | `--tape-mid` `#9AA8B8`, the quiet grey (7.9:1) |
| Time and Sales, at the bid (1.14.0) | `--tape-bid` `#FF5C7A`, the tape's sell red (6.5:1) |
| Time and Sales, below the bid (1.14.0) | `--tape-below` `#FFA3B4`, the brighter red (10.2:1) |
| Time and Sales, a big trade's lift (1.14.0) | `--tape-big-lift` `#FFFFFF`: a big trade's price and size are its color mixed 30% toward it |

Presets: Carolina / purple (default), Mint / coral (`#4FD1A5` / `#F0717A`, the Chart lab v0 look),
House green / red (`#3DDC97` / `#FF7A7A`). Text drawn in a candle color is lightened until it reads
at 4.5:1 on the ground; the last-price tag picks dark or white text for its fill.

**Background (1.5.3, Anthony's request).** The Colors panel has a Background section: presets Dark `#080B10`
(the default, the look above), Black `#000000`, Blue-grey `#1B2433` and Light `#F5F7FA`, and a picker for any
color. On the default ground nothing changes. On any other ground the theme is rebuilt once per change (never per
frame) from the engine's helpers (`buildTheme`, `readableOn`, `legible`):
- Neutrals are mixed from the ground toward an ink (`#F2F6FA` on a dark ground, `#080B10` on a light one, picked
  by `readableOn`): RTH ground 2.5%, grid 6%, axis borders 9%, divider and tag borders 20%, crosshair 40%, axis
  text 57%, day labels 95%, crosshair tag fill 7%, tag text, exit dot and live dot the ink.
- Each is then pushed further toward white or black until it reaches its floor: text 4.5:1, day labels and tag
  text 7:1, crosshair and lines (VWAP, drawings) 3:1, candle bodies 2.5:1 (the default bear purple reads 2.77:1 on
  the default ground), divider 1.4:1, grid 1.12:1. Colored marks (candles, VWAP, levels and their names, trade
  sides, results) keep their hue and move only as far as needed; the colors as chosen are kept, so going back to
  the default ground gives them back unchanged.
- A colored mark moves toward white or black, whichever reaches its floor with the smaller change, so it keeps as
  much hue as it can (`markOnGround`).
- Buy and sell (long and short) keep their colors on every ground: `#3DDC97` and `#FF7A7A` as chosen, never moved.
  Where one does not read on the ground, marks and lines (fill and entry triangles, order lines) get an outline that
  reads 3:1 and text (fill quantity, order labels, the position's side word, stop tags, the legend's last fill) a
  3 px halo that reads 4.5:1, in `#080B10` or `#F2F6FA`, whichever stands out more from the ground. On the default
  ground no outline or halo is drawn.
- Other pairs a trader must tell apart stay apart on every ground (`pairOnGround`): bull and bear, profit and loss,
  and the IB high and low (the high always the brighter: 1.5:1 on every preset, 1.25:1 at the least). Apart means 1.25:1 between them
  or an RGB distance of 60 (the defaults: buy and sell 219, bull and bear 121). If moving each on its own would bring
  them together, the one farther from the ground is pushed further; if that cannot part them (a ground near
  mid-grey, where nothing keeps its hue at 4.5:1), the lighter goes toward white and the darker toward black, each
  reading at least 3.5:1 (the floor itself where the ground allows). On `#767676`: bull light blue, bear dark
  purple, IBH white, IBL black.
- On such a ground the other levels can come out the same color; their dash patterns and names tell them apart.
- The live page's legend sits on the chart and follows it (`legendBg` is the ground at 78%, names in the tag text
  color, secondary text `text2`).
- **The page chrome matches every ground** (Anthony: 1.5.3 a light one, 1.9.0 "the top bar matches every ground").
  On the default ground the page keeps the house style exactly. On any other ground the toolbar, the order bar, the
  Indicators menu, the Colors button and panel, and the status line take their colors from `chromeColors(theme)`:
  - a dark ground: the house dark chrome lifted by the same steps over it (bar `#0F151D` is the house ground plus
    7, 10, 13 in red, green, blue; Black gives bar `#070A0D`, Blue-grey `#222E40`), the house text where it reads;
  - a light ground: raised surfaces 5% and 10% toward the house near-black, borders 12% and 24%, accents deep purple
    `#6D28D9` on a light purple tint (the 1.5.3 light chrome, unchanged on grounds that had it);
  - a mid ground, where black or white text reads under 9:1 on it: the chrome's ground is the chart's lightened or
    darkened just enough for 9:1 (`#808080` gives `#AAAAAA`), so Buy and Sell keep their colors apart;
  - text at 7:1 and secondary text, accents, warn and info at 4.5:1, each on the surface it sits on that reads worst
    (the ground, the raised surfaces, the Armed bar's amber tint).
- **The order bar follows the page chrome (1.9.0, Anthony: "white chart, white top bar").** On the default ground it
  is exactly the 1.5.2 bar (dark `#0F151D` bar, green Buy, red Sell, the amber Armed switch and tint, on `#080B10`).
  On any other ground it takes the chrome's colors: its ground is the chrome's, the bar the raised surface, Buy and
  Sell keep an 8% tint (16% on hover) of the house `#3DDC97` and `#FF7A7A`, their text the same hue moved until it
  reads 4.5:1 on the hover tint over the bar and over the Armed bar, Armed the amber `--warn` with ground-colored text
  (4.5:1). 1.13.0: Armed is the house crimson instead (below); its outline is `--crimson-word`, which `chromeColors`
  moves to 4.5:1 on every ground as before. Before 1.9.0 the bar never changed with the ground (review 2, B1); Anthony asked for it to follow. Only
  colors change: every control, its place and what it does stay as they were.
- **Dimmed controls (1.9.0, review R2):** Buy, Sell, Flatten and Cancel all fade to 0.45 while disarmed, and every
  control to 0.4 while trading is off, on the house bar. On any other ground `chromeColors` raises those opacities
  (`--obar-off`, `--obar-disabled`) in 0.05 steps until each dimmed control reads at least as well as on the house
  bar (disarmed Buy 2.85:1, Sell 2.28:1, Flatten and Cancel all 4.01:1; trading off Buy 2.51:1, as measured in the
  page). Worked out once per change of the ground, never per frame.
- **Order bar essentials (1.10.0, Anthony).** In order: Armed, Account, **Qty** (a select 1 to 9 in the select style,
  mono 12px; the choices over the root's cap disabled, never hidden, and "max 5" in the `.ounit` grey beside it), Buy
  MKT, Sell MKT, **Bracket** (a preset select, mono 12px: Custom, 1:1, 1:1.5, 1:2, a "Saved" group, Save current...,
  and Delete for the saved preset picked; Save current... swaps the select for a name box with Save and x), the stop
  and target boxes, a **t / pt** toggle in the segmented style), then Flatten, **B/E** (a `.btn` like Flatten, dimmed
  with it while disarmed, disabled with no position or no ChartBridge stop) and Cancel all. The Shift+click Buy / Sell
  toggle and the "stop / target ticks" text are gone. No new colors. One line at 1440 and 1920 px; it wraps below about
  1280 as before. On a phone (720 px and less) the Armed switch keeps the width of its armed text, so arming never
  rewraps the bar.
- Saved per browser with the other colors (`live-colors-v1`, one field at a time, per storage prefix, so The
  Desk's embedded chart keeps its own).

**Presets and indicator colors (1.9.0, Anthony: "Bar colors and chart color should be a preset. Indicator colors
should have their own preset group, so I can set colors for indicators on a white chart vs a dark chart").**
- The Colors panel holds Bull, Bear and the Background (VWAP moved to its gear), then two preset groups: **Chart
  presets** (bull, bear and the background) and **Indicator presets** (every indicator color). Each lists its presets
  (a swatch and the name; the one matching the colors in use is shown pressed), a pencil to rename, an x to delete
  (a second click confirms, Escape keeps it), and a name box with Save (Replace when the name is taken, any case).
- Indicator colors are set in each indicator's gear, a picker and a hex box each, and Default colors: VWAP (line),
  Levels (prior day, overnight, value area, prior close, and since 1.14.0 the IB high and low), Volume profile (rows,
  value area rows and point of control, 1.14.0). The volume bars and the delta pane keep the candle colors; fills keep the house trade-side colors (no
  colors of their own, Anthony). On a ground other than the default they move to read exactly as the house colors do.
- The IB high stays the brighter with any colors (Anthony): on the default ground the chosen IB colors are drawn as
  chosen while the high is the brighter by 1.25:1; when it is not (a high picked darker than its low, or the same),
  the pair is drawn as on the other grounds, and if even that leaves the high the darker, the high moves toward white
  and the low toward black until it is (`ibPair`).
- A chart preset can remember one indicator preset (Anthony: "link the groups"). The chart group's save row has
  **Indicator colors: None / <each indicator preset>**, set at first to the indicator preset that holds the indicator
  colors in use, else None; the chart preset keeps that preset's id, and picking it applies both. A save never makes
  or changes an indicator preset, and a re-save sets the link only as the select says. If that indicator preset is
  deleted later, the chart preset still works, without it and without a message.
- The colors in use stay per browser (`live-colors-v1`, `live-indicator-colors-v1`); the presets go through one small
  store interface (`LivePrefs.localPresetStore`: this browser today, a store shared by every PC once one is chosen).

## Type

IBM Plex Mono for every number on the chart (axis labels 400 11px, tags and legend numbers 500 11px,
countdown 400 10px). IBM Plex Sans Condensed 600 10px for level names. Legend text IBM Plex Sans 12px.

## Layout

- Price axis on the right, 78 px wide. Time axis at the bottom, 26 px tall.
- Candles use the plot from 8% below the top to 20% above the bottom with volume on (8% when off).
- Volume sits in the bottom 16% of the plot, scaled to the largest bar in view.
- Right offset: 8 empty bars past the last bar (the engine's default). The live pages (1.14.0, Anthony: price was
  jammed against the scale): **room right** of 80 px, the same on screen at every zoom (8 bars shrank to a few px zoomed
  out); None, 40, 80 or 160 px in Settings; Jump to live and End keep it. 1.15.0 (Anthony's review): the workspace offers 80,
  120 and 160 px, **120** until one is picked (a value saved before is kept; `/single.html` keeps its 1.14.0 choices).
  Default bar spacing 7 px; zoom range 0.6 to 48 px.
- **The price scale** fits the candles in view, eased with the 120 ms re-fit. 1.14.0 (Anthony, from WORK: on the smaller
  panels the high ran under the legend): the top keeps the legend's height and 8 px free (8% when that is more, 45% of
  the plot at most). 1.14.0: it also takes in every working
  order, the position's stop and target legs and the planned stop and target lines ("zoom to brackets", Anthony: on HOME
  the stop sat off the chart), and no longer the VWAP (one far from price squashed the candles). 1.16.0 (Anthony): it also
  takes in the large-order bubbles in view (only those, at their drawn radius), so no bubble crosses the top of the plot.
- Legend top-left over the chart, on `rgba(8,11,16,0.78)`, radius 8: symbol, timeframe, status pill;
  then time, O H L C, change and percent, volume; then VWAP and the trade under the cursor. It shows
  the bar under the crosshair, or the forming bar when the pointer is away. On phones it drops its
  secondary text and third row. 1.14.0 readouts, 400 12px mono in the secondary text color: after the status pill
  "Bar 0:23" (time left in the bar; Range bars "Bar ▲3 ▼5t", the ticks left up and down) and "ATR(14) 12.50"
  (NinjaTrader's ATR of the chart's own closed bars); after the bar's change "+0.42% vs settle" in the bull or bear text
  color (the last price against the prior settlement from ChartBridge 0.3.7; blank, never estimated, with none). Once a
  second, on the second.
- **Corner readout (1.15.0, the workspace, Anthony's item 9):** the bar countdown and the ATR leave the header text and live in
  one quiet readout at the plot's bottom right, 6 px in: "Bar 0:23 · ATR(14) 12.50" (Range "Bar ▲3 ▼5t", 4h/1D/1W to the bar's
  real close) in 500 10px mono, the secondary text color on the legend ground, radius 4, 16 px tall; moved up past any order
  label and the VWAP's marker (never on the price axis, the padlock or Jump to live, which sit in the axis column); on a plot
  too narrow for it the short form "0:23 · ATR 12.50". Shown on small panels and with the header text off. The workspace's
  headers no longer show the change from the settlement (the Quote board has it). 1.16.0: the bubble under the mouse comes
  first, "Buy 142 · Bar 0:23 · ATR(14) 12.50" (short form "Buy 142 · 0:23 · ATR 12.50"), set when the bubble changes.
- **No text inside a mounted chart (1.16.0, Anthony):** the workspace's charts (and a host's) have no legend and no **Aa**
  toggle; the single chart page keeps its legend as above. A small badge, in the panel header (or the chart's top left
  corner when a host does not place it), 9px pills: **ARMED · account** in the ARMED pill's colors while the chart takes
  orders, and the connection only when it is not LIVE (CONNECTING, LOADING, OFFLINE in the loss color).
- **Stale feed (1.16.0):** no trade for 10 s in RTH (09:30 to 16:00 ET) or 60 s outside it, while the line is live and CME
  Globex open: a 2 px amber edge (`--warn` at 75%) inside the chart's border, over the candles and taking no room, and
  "Feed stale 12 s" in the badge in amber (on the single chart page the LIVE pill reads "STALE 12 s"). Gone with the next
  trade.

## Drawing

- **Candles:** body 72% of bar spacing, wick 1 device pixel, both snapped to device pixels. Below
  about 2.5 px spacing bodies collapse to the wick.
- **Grid:** price lines about every 52 px on 1 / 2 / 2.5 / 5 times a power of ten, in whole ticks.
  Time labels at least 84 px apart on round times; daily bars get month labels and dates. 1.14.0 (Anthony): the grid
  lines are **off by default** on the live pages (Settings, Grid lines); the axis labels, session dividers and RTH
  shading stay.
- **Sessions:** CME sessions start at 18:00 ET; each start gets a dashed divider and a bold day label.
  Times show in exchange time. Regular hours (9:30 to 16:00) get the lighter ground on bars under
  1 hour. 24/7 markets set the session start to midnight and switch the shading off.
- **Levels:** full-width lines at 70% opacity (prior-day and overnight dashed 6/4, value area 3/4,
  prior close dotted 2/3). Name at the right edge of the plot; names within 12 px merge ("VAL · PDL") into one
  string in the first (highest) level's color.
  Each level gets an outlined tag on the price axis; tags push apart and grid labels hide under them.
  Tags never sit under the last-price tag: levels at or above the last price stack upward from it, the
  rest stack downward (since 1.2.1).
- **Initial Balance (1.5.3):** today's high and low of the first hour of regular trading, 9:30:00 up to (not
  including) 10:30:00 New York time, named "IBH" and "IBL", in the level style above (70%, name at the right edge,
  outlined tag) but drawn from the 9:30 bar to the right edge, not across the whole plot (Anthony). The high in the
  brighter orchid. While forming, long dashes 12/5 (no other level uses them), moving with each new high or low.
  From 10:30:00 (by the clock, within half a second, trade or no trade) solid for the rest of the trading day,
  until the 18:00 session start. Before 9:30 nothing is drawn for today.
  - **Data rule:** always the 1-minute bars (the live page's `D.m1`), whatever the view. Every view holds them
    (NinjaTrader's 1-minute history, then bars built from the live trades), both window edges are whole minutes so
    a 1-minute bar never straddles 9:30 or 10:30, and a 1-minute bar's high and low are exactly those of the trades
    inside it. So a trade at 10:29:59.999 counts and one at 10:30:00.000 does not, and the values are the same on
    1m, 15s, 30s, 5m, 15m, 1h and Range bars, live or after a reload, and in `ChartLive.mount`. The bars on screen
    are never used: a 15-minute, 1-hour or Range bar can straddle 10:30 and carry later prices. The engine's
    `initialBalance` also takes trades, and refuses ('inexact') any bars that straddle an edge.
  - **Shown only when exact:** the 1-minute bars must hold a bar from today's session (from 18:00) ending at or
    before 9:30, and every minute from 9:30 to the one in progress (to 10:29 once locked). Otherwise nothing is
    drawn and the status line says why in the quiet grey (the history does not reach back before 9:30, or minutes
    are missing). This also covers data that stopped: while ChartBridge is unreachable the minutes since the drop
    are missing, so the IB goes until the reconnect reloads the history. No trades in the hour: nothing, with a
    note. Weekends and NYSE full-day holidays (New Year's, MLK, Presidents', Good Friday, Memorial, Juneteenth,
    Independence, Labor, Thanksgiving, Christmas, with the NYSE's observed-day rules) have no regular session:
    nothing, even though Globex trades; a holiday gets a note naming the day, a weekend none. Early-close days have
    an IB. Not detectable from bars: a minute that has a bar but lost some trades.
  - Part of **Levels** since 1.14.0 (Anthony): IBH and IBL are two of the Levels gear's toggles (its own entry and
    "IB" chip retired; its status notes still read "Initial balance not shown: ..."). A pane saved before keeps what
    it showed (`LivePrefs.migrateIb`).
- **Levels' lines, each its own toggle (1.14.0, Anthony):** the Levels gear lists PDH, PDL, Prior close, ONH, ONL,
  PD VAH, PD VAL, PD POC, IBH and IBL as a row of small toggles (`.ind-tog`, 24 px, 600 11px mono, styled as the chips: on = solid border on `--s3`,
  off = dashed in the quiet grey), all on
  by default, saved per chart. The prior day's value area reads **PD VAH** / **PD VAL**, and its point of control
  **PD POC** is drawn in the value-area gold with a dash-dot 8/3/2/3 (`PD_POC_DASH`, no other level uses it).
- **Volume profile (1.6.0; Anthony's ruling 2026-09-29):** the session's traded volume per price,
  1-tick rows, as horizontal bars from the right edge of the plot, in front of the grid and behind the volume bars,
  levels, VWAP and candles. The largest row (the POC) is 25% of the plot width (`VP_WIDTH`), the rest in proportion.
  Opaque fills (each editable in the profile's gear since 1.14.0, `--vp-row`, `--vp-value`): rows
  outside the value area `#19212C` (brighter in 1.14.0), the 70% value area a step stronger `#212C3B` (capped at 1.13.0's,
  Anthony: a bear candle over it keeps 1.99:1), the POC row in
  the value-level gold `#E0B45A`. On another ground the two row colors are mixed from the ground toward the ink
  (7.5% and 14%) and the POC moves until it reads at 3:1 on the value-area rows. Each row is its price span tall
  (price minus half a tick to plus half a tick) in whole device pixels, with a 1 px gap once rows are 4 px or taller;
  rows thinner than a pixel share it, the bar as long as the largest of them and the POC winning, so it always
  shows; the POC bar is at least 2 CSS px tall, centred on its row. Off by default on every pane; the Indicators menu adds it (Volume group), and its gear panel holds a Session (from 18:00 ET) or RTH (9:30:00 up to 16:00:00 ET, 13:00 on NYSE early-close days, none on
  weekends and NYSE holidays) choice. The last session's profile stays until the next session's first trade (1.6.1,
  Anthony's rulings 2026-09-30): the full session over weekends and NYSE holidays (on weekday evenings it moves at
  18:00 as before), RTH also through the weekday night until the next 9:30; for the ticks the page has (no more
  tick history is loaded for it); the IB keeps its own rule. Candles over the rows
  read lower than on the bare ground (default: bear 1.99:1 over the value area, 2.28:1 over the other
  rows since 1.14.0, 2.42 before); their floor there is open for Anthony.
  - **Developing POC, VAH and VAL (1.14.0):** toggles dPOC, dVAH, dVAL in the profile's gear, on by default. Solid
    lines across the plot at 85% (the prior day's levels are dashed): the POC 1.5 px in `vpPocText`, the value area's
    edges 1 px in the secondary text color, each named at the profile's left edge (600 10px Condensed, right aligned,
    2 px above its line). From the profile's per-version columns: never walked per frame or per tick. The legend adds "POC 26,150.50 · VA 26,101.50 to 26,289.50 (Fri)", the POC price
  in the gold and the session's day in the quiet grey.
- **Cumulative delta pane (1.7.0; Anthony's rulings 2026-09-30):** market buys minus market sells (contracts), each
  trade's side from ChartBridge 0.3.4 (the page never works one out), in a pane **below** the plot, on the plot's own
  bars (every bar type: seconds, minutes, hours, range), so it shares the x axis, scrolling, zoom and the crosshair (the
  pointer over either draws the bar's line through both, the time tag and the legend follow it). Candles of the running
  cumulative: open = the value at the bar's start (the previous bar's close in the session, 0 at 18:00 ET), high, low,
  close = its extremes and last value in the bar, in the candle colors (bull `#4B9CD3` when close >= open, bear
  `#6D28D9`), bodies and wicks as the price candles. The gear's **Show** option: Cumulative (default) or Bar delta, each
  bar's own buys minus sells as a bar from a zero line (bull color at or above zero). It starts at 0 again at 18:00 ET.
  Layout: the plot, a 4 px band (a 1 px `#18212C` line on each side), the pane, then the time axis; the pane starts at
  20% of the chart height (plot plus pane plus band) and the band is the divider: drag it, or Tab to it and use the
  arrow keys (2%), Page Up and Down (10%), Home and End; a 2 px `#B69CFF` line at 55% inside the 4 px band on hover,
  drag and focus. Its grab area is 10 px tall from the plot's bottom edge down (the band and the pane's top 6 px) and
  stops at the price axis, so it covers neither the price plot nor its axis. "Jump to live" sits 12 px above the pane
  while it is shown. Kept between 8% and 60%, and never under 48 px for the pane or 120 px for the plot. Inside the pane: the RTH shading, time
  grid and session dividers as in the plot, value grid lines in the grid color, the zero line in the divider color, a
  title at the top left on the legend ground ("CUMULATIVE DELTA" 600 10px Condensed caps in the axis text color, the
  value in 500 11px mono, then "since 10:04 ET (page opened)" in 500 10px Condensed when the session counts from later than 18:00: the first counted
  bar's exact start, HH:MM on the minute, else HH:MM:SS, and tenths when not on the second; ", missed 32 s" after it
  when the count missed a second or more of the session, a reconnect or a reload, 1.7.0 round 6);
  on its axis round values (400 11px mono, "+10,000", "-5,000", "0") and the newest bar's value in a tag in the candle
  color, the pointer's value in the crosshair tag. The value scale fits the candles in view (12% free at the top and
  bottom), eased like the price scale. Numbers with thousands separators and a sign. Bars with no delta (before the page
  has every trade, or with no trade) stay blank; a session that counts from later than 18:00 gets a dashed
  `#8392A5` line at its first counted bar. (A note from the page, drawn alone with the title in 500 12px Condensed,
  centered, was the page's "Delta needs ChartBridge 0.3.4 on this PC" until chart 1.20.0; the page sets none now.) Legend: "Delta +12,345" (bull color above zero, bear
  below), "Bar delta +123" in bar mode, "Delta since 18:37:16.6 +1,234" for a later start ("Delta since 18:37:16.6, missed 32 s +1,234" after a gap), and "· 37 unknown" (the unknown
  side volume of the session, dim) when there is any. On by default on the main pane, without a chip (pin it from the
  menu for one); its own Indicators entry "Cumulative delta" (chip DELTA, letter D) in the Volume group.
- **Chart signals (G1c; Anthony's rulings 2026-10-01).** Three, from the trades ChartBridge sides (an unknown side is
  left out), counted from the page's opening only (Anthony uses them strictly live), each in its gear and saved like the
  other indicator settings. Colors: Anthony's NinjaTrader cyan and yellow toned to the house palette (not `#00FFFF` and
  `#FFFF00`): `--sig-bull` `#38DCE8` and `--sig-bear` `#F3D84A`, each with a slightly brighter outline shade
  (`--sig-bull-line` `#9CF1F7`, `--sig-bear-line` `#FFEC8F`). The cyan is 11.8:1 on the ground and clearly apart from the
  Carolina bull candle (1.8:1 lighter and greener, an RGB distance of 70); the yellow is lemon beside the value-area gold. Set in the
  Absorption bars gear (an indicator preset keeps them; a preset saved before G1c takes the defaults). On another ground
  they move as candle bodies (2.5:1) and the outlines as lines (3:1), keeping their hue (Light: bodies `#2AA5AE` and `#AA9734`,
  outlines `#5E9194` and `#998E56`).
  - **Absorption bars** (Anthony's AbsorptionTradeCombo, Signals group, no chip and never counted toward the strip): a
    large trade (a single print, or same side prints at one price within the aggregation window added up, from the
    large-print floor), a volume spike (the bar's volume at least the multiplier times the average of the lookback bars
    before it) and a rejection close (close ratio in the top or bottom rejection zone) on one bar, the large trade's side
    matching (the latest large print in the bar gives the side). Painted at the close only: the whole candle in the signal
    color with a crisp 1 device pixel inner outline around the body in its brighter shade. While a bar forms with the three
    holding, a 1 px outline in the outline shade one pixel clear of its body; it goes when they stop holding, and the bar
    is painted at its close only if they hold then (Anthony; NinjaTrader paints mid-bar and never un-paints). No line, no
    label. Settings per instrument and chart type (Range 40, 1 minute, ...; the file's defaults for each: LookbackPeriod 20,
    VolumeMultiplier 1.8, RejectionZone 0.35, AggregationWindowMs 500), inside the file's ranges.
  - **Large-order bubbles** (Volume group, chip BB / B): same side prints within 100 ms of the first added up, from the
    floor, a circle centred on the trade price (volume weighted, on the tick) and its bar (1.14.0: a bar change closes a
    group, so a bubble is always placed on the bar its prints traded in). 1.14.0 (Anthony, from WORK:
    "bubble size must show the order size"): the area follows the size against the floor, radius = 4.8 px x sqrt(size /
    floor): 4.8 px at the floor, 6.8 at twice it, 9.6 at four times, 15.2 at ten times, 27 px at most (about 32 times);
    before, the fourth root put every print near the floor at the same small size. Zoomed in past the default 7 px spacing every radius grows with the square root of the spacing, at most 1.6
    times. Filled in the side's candle color as it reads on the ground (`upText` buys, `downText` sells) at 32%, a crisp
    1.25 px ring in the same color at 92% with a 1 px hairline of the ground just outside it, so it stays clear on a candle
    of its own color. Drawn over the candles but see-through (a range bar's body spans nearly the whole bar, so behind it a
    bubble would be hidden), the larger first. 1.14.0: no numbers on the chart; with the mouse over one (the topmost under
    the pointer, 3 px of slop, tested on mouse moves only) the legend's top line says "Bubble Buy 142 @ 31,120.25
    08:44:05.3" in 500 12px mono, in the side's text color (1.16.0: on a workspace chart, "Buy 142" in the corner readout,
    and the whole line in the Data Box). Floors RTH (09:30 to 16:15 ET) / overnight: NQ 50 / 25, ES 100 / 50, MNQ 100 / 50, MES 100 / 50, the same
    numbers as the workspace's Time and Sales (one key, `live-tape-floors-v1`), editable in the gear and in the
    workspace's Settings; Auto (per instrument) uses the session's top 1% of group sizes once 200 groups have traded.
  - **Divergence arrows** (Anthony's DeltaDivergenceSignal v1.0, the delta pane's gear: Show divergences, off by
    default, with SwingLookback 5, MinBarsBetweenSwings 3, MinDivergencePct 0.10): in the delta pane only, on the pane's
    own cumulative delta, at bar close. An 11 by 11 px arrow 4 px below a bullish swing's delta candle and above a bearish
    one: solid in the signal color once the swing is confirmed; hollow (a 1.25 px outline in the outline shade on the
    ground) from the close of the bar that beats the previous swing with the delta not following, gone if a later bar
    takes its high (low) first.
- **VWAP:** 1.5 px line at 90% opacity, restarting each session. 1.14.0: off the price scale (it no longer sizes it), a
  marker at the plot's top or bottom right edge, 16 px tall, radius 3, on the legend ground: a small triangle pointing
  to it and "VWAP 25,512.25" in 500 10px mono, both in the VWAP color. Its gear's **Hours** (1.14.0, per chart):
  **Full session** from 18:00 ET (the default) or **RTH only** from 09:30 ET, from the 1-minute bars' typical prices,
  none drawn outside 09:30 to 16:00 ET (the legend "VWAP -").
- **Trades:** entry triangle pointing the trade's way, exit dot, dashed line and chip ("+8.75 pt") in
  the result color. Chips step down so they never overlap.
- **Fills (1.3.1):** a triangle in the side color with its tip at the fill price (buy up, sell down),
  quantity beside it in 10 px mono (buys below the price, sells above). Fills on one bar, side and price
  merge into one mark with the summed quantity; labels on one bar that would overlap step away from the
  price by 10 px, keeping price order.
- **Orders (1.3.0):** a 1 px line across the plot in the side color (buy green, sell red): limits and
  targets solid, stops dashed 6/4. A label at the right end of the plot ("BUY LMT 2", bracket legs "SELL TGT
  2" / "SELL STP 2", the quantity still to fill) on the ground at 92% with a side-colored border (dashed for
  stops), plus a close x while order editing is on. Labels that would overlap step left. The price-axis tag
  is filled in the side color for limits and outlined (dashed) for stops, and stacks with the level tags.
  An order moved and waiting for its answer draws at 55%. Labels draw above the last price line and live dot.
- **Compact labels (1.15.0, a host's charts: the workspace; Anthony from his two-monitor setup, images/67.webp):** the same
  colors, borders and dashes, the text 500 10px mono in a 14 px box with 4 px padding, right-aligned where the full label
  would end: "TGT 1", "STP 1" (a leg's side is its color), "BUY LMT 1", planned "SL -12t" / "TP +24t", the position "L1
  +4.50 +$90" (side letter and size, points, whole dollars). The full label (the 1.14.0 one) while the mouse is over it, and
  while it has "+SL" / "+TP" cells. The hit areas, the stacking and the x (its 18 px cell) are the full label's, so nothing
  that was clickable shrank.
- **Planned stop and target (1.13.0, ChartBridge 0.3.8):** a resting entry's planned legs draw as its legs would (the
  leg's side color), but clearly planned: the line finely dashed 2/4 at 70% (40% while a move waits for its answer),
  the label "SL plan -12t" / "TP plan +24t" (ticks from the fill, from the line's live distance while dragged) with a
  dashed border, the price tag outlined. They hang off the entry: while the entry is dragged they move with it. While
  order editing is on, an entry missing one shows "+SL" / "+TP" cells in its label, before the x, in the label's type.
- **Position (1.3.0):** a 1.5 px `#F2F6FA` line at 60% at the average price, a label "LONG 2  +3.50 pt
  +$14.00" (side word in the side color, P&L in the result color; points per contract, dollars for the
  position) and an outlined tag on the price axis.
- **Last price:** dotted line in the forming bar's color; filled tag with price and countdown to bar
  close. Each tick flashes the tag white (38%, fading over about 160 ms) and pulses a ring from the
  live dot (500 ms).
- **Crosshair:** dashed 4/4, snaps to the bar center, with price and date/time tags.
- **Zone (1.15.0, Anthony):** a box between two prices (on the tick) and two times: the drawing color at 10% (16% while
  selected or being drawn) with a crisp 1 device pixel edge at 85%, above the grid and the profile, behind the volume bars,
  levels and candles; its four corners get the drawings' handles when selected. A corner resizes it, an edge moves it (the
  inside only once it is selected, so a pan over a big zone stays a pan); Delete removes it; saved with the chart's drawings.
- **Day labels (1.15.0, a host's charts):** a session's day label closer than 70 px to the last one drawn keeps its divider
  and leaves out its text (4h and 1h bars no longer print days over each other).

## Motion (the feel Anthony approved)

| Motion | Time constant |
|---|---|
| Wheel zoom, eased, anchored under the pointer | 75 ms |
| Price axis re-fitting as the view changes | 120 ms |
| Forming candle growing toward each tick (close, high, low) | 55 ms |
| Scroll by one bar when a new bar opens while following | 110 ms |
| Throw after a drag (friction) | 325 ms |

- Dragging pans 1:1 with no smoothing. Letting go while moving throws the chart (pointer moved in the
  last 60 ms, faster than 0.2 px/ms).
- Frames draw only when something changes. Target 60 fps and under 1 ms a frame.
- `prefers-reduced-motion`: no easing, no throw, no pulse.

## Interaction

- **Settings and hotkeys (1.11.0, Anthony).** A `Settings` `.btn` with a caret after Colors, on the trading page only,
  opening a 400 px panel in the Indicators panel's style (`#0B1016`, a `#2A3645` border, radius 12, the same shadow;
  right-aligned under the button, left-aligned when that would leave the screen): the title "Settings" (600 13px), a
  "HOTKEYS" caption (caps mono 10px), and a row per action (Buy MKT, Sell MKT, B/E, Close, Flatten all): the name
  (13px), a 150 px read-only key box (mono 600 12px on the ground, a `#B69CFF` border while it takes keys, "None" when
  empty) and a Clear `.btn`; under a row a one-line note (11px: "Saved." in grey, a refusal in amber, blocked storage
  in red). A grey 11px foot says what the keys do. After a pick in an order bar select or the t / pt toggle, and on Enter in a
  bracket box, the focus leaves the control so the hotkeys work at once. Flatten (button and hotkeys) works with Armed
  off, so it does not dim while disarmed (Buy, Sell, B/E and Cancel all still do). Escape (outside a key box) or a click outside closes it. No new
  colors; the order bar does not change.
- **The single chart page's cleanup (1.14.0, Anthony: "the 1m format with everything on one line").** One toolbar line
  at 1366, 1920 and 2560 px: the instruments, Bars and the range size, Indicators and its chips (the workspace's 2-letter
  chips, VO VW LV FL, 30 px tall; up to ten pinned, those that do not fit behind a **+N** chip that opens a small
  list of them), a **⋯** `.btn` opening a small menu (Trend line, Price line,
  Clear drawings, Reset view; 500 13px, the accent tint on hover and while a tool is on), Colors, Settings. Settings
  gain a "CHART" section above the hotkeys: Glide, Range style, Grid lines (Off / On), Room right (None, 40, 80, 160 px), ATR period (a 64 px number box, 2 to 100, 14 by default; review D2),
  each a 32 px row of its name (13px) and the toolbar's control;
  then Change PIN and the versions (400 11px mono, the
  quiet grey). A host's chart with its own toolbar keeps the 1.13.0 toolbar.
- Drag to pan and throw. Wheel or pinch zooms at the pointer; a sideways trackpad swipe pans.
- While following the live edge, zoom keeps the live edge in place. Panning away shows "Jump to live": since 1.14.0 a
  small icon (24 x 22 px, radius 6, `#B69CFF` on `#1A1230` with a `#3B2A6B` border, a play-to-end glyph, tooltip "Jump
  to live (End)") at the top of the price scale, moved down only to stay clear of the tags there; the axis prices under
  it are not drawn. End or the icon returns.
- **Price scale lock (1.14.0, review D2):** a 24 x 20 px padlock centred in the corner under the price axis (beside the
  time axis; nothing else is drawn there): unlocked, an open padlock in the quiet grey `#7F8C9C`, the text color and a
  `#2A3645` border on hover; locked, a closed padlock in `#B69CFF` on `#1A1230` with a `#3B2A6B` border. Saved per chart.
- Drag the price axis to stretch price (auto-fit off; chart drag then pans price too). 1.14.0: while following live, a
  new trade that takes the forming bar within 12 px of the header or the bottom brings the auto-fit back (eased), and
  so does going back to live. Double-click
  the price axis or press A for auto-fit. Drag the time axis to zoom. Double-click the chart to reset.
- Keys: left/right pan with a glide, + and - zoom, End live, A auto-fit. The chart is focusable.
- Orders (only while order editing is on, which the live page ties to Armed): drag an order's label or
  price tag to move it, snapped to the tick, with its tag following; Escape during the drag puts it back, and
  so does letting go anywhere but inside the plot at a price on screen (nothing is sent);
  the x cancels. Order labels take the pointer before drawings (not while a drawing tool is active).
  Shift+click without moving places an order at the snapped price (the page picks side and kind); hold
  Shift to see a dotted preview line and label. A plain click, a drag or a Shift+drag never places one.
  Live page (1.10.0): the mouse button picks the side, so the order bar has no Buy / Sell toggle. Shift + left click
  buys; Shift + right click and Ctrl + left click sell (the page handles those two, while Armed, with no drawing tool,
  never on an order's label or tag; such a press does not pan or pick a drawing). Ctrl and Shift together send nothing.
  The preview shows the buy and names the sell ("click · right click: SELL STP"). No browser menu over the plot.
- Switching timeframe keeps bar spacing and the live edge (or the time at the right edge).
- **The drawing ring (1.15.0, the workspace, Anthony):** a middle-click (no modifier) on a chart's plot opens four 32 px round
  tools 40 px around the pointer, on the menus' ground and border (`#0F141C`, `#3B2A6B`, the accent tint and `#7B5CFF` border
  on hover): Trend line (top), Price line (right), Clear this chart (bottom), Zone (left), and a 6 px accent dot at the
  centre. Moved in to stay inside the plot; fixed, never scrolling. A tool arms on that chart, draws one drawing and goes
  off; Escape takes back the ring, an armed tool or a drawing half made; a click outside closes it; the focus goes back to
  the page. The middle button never places, moves or cancels an order, and its press is kept from the browser over the
  charts (no auto-scroll). While a tool is armed a Shift or Ctrl click is an order click as with none. The small menu (⋯)
  keeps Reset view and says "Drawing tools: middle-click the chart".
- Live page, **Indicators menu "E2"** (1.6.0, as Anthony approved it in the design canvas): one per chart pane, a
  `.btn` showing shown/on-this-chart ("4/5"), opening a 460 px panel (never wider than the pane) on `#0B1016` with a
  `#2A3645` border, radius 12, the Colors panel's shadow, padding 8:
  - Title "Indicators" (600 13px) and "4 shown, 1 hidden" (mono 11px `#8392A5`); a search box (34 px, `#0F151D`, a
    `#3B2A6B` border) with a "/" key cap, focused on open. It matches names and short names (vwap; ib ibh ibl; pdh pdl
    onh onl levels; vol volume; fills); Enter adds or shows the first match, never hides it. Groups folded and the
    search empty on every open.
  - "Recent": the last 5 used (mono 11px outlined buttons); a click adds, shows or hides.
  - "On this chart" (caps mono 10px): every indicator on the pane, a row each (36 px): a switch (32 by 18; on: the
    accent tint with a `#B69CFF` knob) that shows or hides and keeps everything, the swatch (12 by 3, grey when hidden),
    the name (13px), a pin (star, filled `#B69CFF` when pinned) for the chip strip, a gear opening the one settings panel
    open at a time (`#0F151D`, what the indicator does, read only, and its real options: the Volume profile's Hours,
    Session or RTH, and the Cumulative delta's Show, Cumulative or Bar delta, in the toolbar's segmented style at 11 px), and an x that takes it off the chart. Pins only on
    these rows; group rows have the + and the gear.
  - The groups, folded, one open at a time: Price (VWAP, Levels), Volume (Volume bars, Volume
    profile, Cumulative delta, Large-order bubbles), Trades (Fills), Signals (Absorption bars, G1c); a dashed + adds one.
    Then "Coming: time and sales".
  - "Hide all (n)", which becomes "Restore" and brings back the same mix (not everything). Fills are included.
  - **The live trade always stays** (Anthony): hiding Fills (switch, chip or Hide all) hides past fills and trade
    marks, never the open trade: its entry fills stay marked, and the position line and label, working orders and
    stop and target lines are not indicators at all.
  - Keys: "/" opens the menu of this chart when the focus is inside it, or with nothing focused, of the chart under
    the mouse (not while typing in a box, not while anything outside the chart has the focus, not with Ctrl, Alt or
    Cmd; no other key of the chart or the order bar uses it); arrows move through the menu; Escape or a click outside
    closes it and Escape puts the focus back where it was.
  - The panel opens below the order bar when there is one (the Armed switch, the account and the position readout
    stay in view) and its list scrolls inside when the space is short. 1.14.0 (no scrolling, ever): placed where it
    fits whole (below the order bar, else below its button, else as high as it must), and an open gear's settings sit in
    a 300 px column beside the list (its title the indicator's name, 600 13px), so it grows sideways; only a menu taller
    than the window scrolls its list.
  - **Chip strip** next to the button: pinned indicators only, at most 10 since 1.14.0 (6 before; Anthony): an added
    indicator gets a chip while there is room; pinning onto a full strip is refused with a note in the menu. Since
    1.14.0 (Anthony) a click opens the indicator's settings in a popover dropped 6 px below the chip (flipped up or left
    near an edge, fixed, never scrolling): the gear's card as in the menu (300 px, padding 12, radius 12, the menu's
    ground, border and shadow) with a header line of the on/off switch, the name (600 13px) and On / Off (500 11px mono,
    quiet). Off hides the indicator and keeps the chip (dashed); unpinning stays in the menu. A click outside, Escape or
    the chip again closes it and the focus leaves it, so the hotkeys work at once (the workspace's KEYS reads OFF while
    it is open). A chip behind "+N" opens it from "+N". A chip
    is 30 px tall, mono 600 11px: shown = `#141C26` with a solid `#2A3645` border and its color line; hidden = no fill,
    a dashed border, grey text and a grey line. The strip always keeps room for six one-letter chips, and shows the
    names only when that adds no toolbar line; otherwise each chip is one letter (V W L I D F) over its line. So it never
    wraps and pinning or unpinning never moves the order bar or the chart.
  - Saved per pane (`live-indicators-v2`). The main pane starts with the five on, shown and pinned (chips V W L I F),
    and the cumulative delta on and shown without a chip (1.7.0; a pane saved by 1.4 to 1.5.3 keeps its choices: the
    ones that were off stay on its chart, hidden; a main pane saved before 1.7.0 gets the delta on with no chip, hidden
    with the rest and in the Restore mix when it was saved after Hide all); a new pane starts with none on (Anthony,
    2026-09-29).
- **Account** (1.6.0, Anthony: one picker for both). On a trading page the order bar's Account picker (600 13px
  mono in the head text color, 34 px tall, at least 150 px wide) is the only account control: orders go to it and the
  chart marks its fills only. With trading off it still works (the fills follow it; no order can be sent). With no
  order bar (a mounted chart) a compact picker (600 12px mono) sits in the toolbar after the
  instruments. No "All accounts"; no colors per account. Saved in `live-account-v1` (the 1.5 fills choice is read once).
- PIN pad (live page, 1.5.2, ChartBridge 0.3.2; `live/pin.css`): a centered card on `#0B1016` with a `#2A3645`
  border, radius 12 and the Colors panel's shadow, over the `#080B10` ground (at 90% with a light blur over the
  chart for Change PIN). The logo and wordmark as in the toolbar, a 600 18px title, four 14 px dots (filled
  `#B69CFF`), a 3 by 4 pad of 56 px keys (500 20px IBM Plex Mono digits; Clear in 600 11px Condensed caps;
  a delete icon). A refused PIN reads in the warn amber `#E0B45A` with a 300 ms shake (none with reduced motion).
  Keyboard: digits, Backspace, Delete clears, Escape clears (or closes Change PIN).
- Range bars (live page, 1.4.0) are built like NinjaTrader's by default: every finished bar is exactly the range,
  the next opens one tick on, and a jump is filled with phantom bars (no volume). "Traded prices only" keeps the
  older way. See `docs/RANGE_BARS.md`.
  The select that picks between them has a visible **Range style** label (the toolbar's `.glabel` style, like
  "Bars"), 1.5.1.
- The legend's source line names both versions: "NinjaTrader via ChartBridge 0.3.4 · chart 1.7.0" (1.5.1).

## The workspace (1.12.0)

- **Top bar**, 40 px: TRADING SCREEN, the connection, the New York clock, one status line for the window (worst feed
  and local delay, frame rate), notes, then on the right **KEYS ON / KEYS OFF** (mono 11 px in a 1 px box: ON in the
  buy green, OFF muted), **Flatten all** (the sell red on its dark ground, semibold; dimmed only while not connected or
  not signed in, never for Armed), Colors, Layout, + Add panel, Settings. 1.14.0: the connection's tooltip says
  "chart 1.14.0 · ChartBridge 0.3.8", as does the foot of Settings.
- **No scrolling, ever (1.14.0, Anthony).** Colors in two columns (560 px: the colors, then the preset groups), Settings
  in two columns (800 px: the charts and hotkeys, then large prints, the PIN, the layout and the versions); popovers
  open under their button when they fit, else moved up until they do. Time and Sales rows are the only scroll.
- **Resize from any edge or corner (1.14.0, Anthony):** 7 px bands on the edges (3 px of them in the gap) and 14 px
  corners; nothing shows until the pointer is on one, then a 2 px accent `#7B5CFF` line on that edge (an L at a corner);
  the bottom right corner keeps its grip lines. Snapped to whole cells; an overlap is refused. Moving stays on the header.
- **Time and Sales (1.14.0, NinjaTrader style):** each row's price and size in its category's color (ChartBridge 0.3.8's
  `q`, the `--tape-*` tokens above; set in the tape's gear, Default colors), by side when there is no `q` (buy `#3DDC97`,
  sell `#FF5C7A`, unknown in the text color). A big trade (the bubbles' floors, one setting): 700, its color mixed 30%
  toward white, on its color at 24% over the panel, with a 3 px bar of it at the left edge; its time in the secondary text.
- **Under the top bar**, only while there is one: ChartBridge's order errors (sell red border and ground) and what was
  not sent (warn amber), each with Dismiss.
- **Chart panels**: the slim 28 px header, the compact chart. A chart live for orders (the ticket's instrument while
  Armed) has a purple outline on its stage, the workspace accent `#7B5CFF` (Anthony), with a soft static glow (a
  1 px ring and an 8 px shadow at 45%); no new color, no animation. 1.13.0: the Armed switch and the ticket's outline
  are deep red (the house crimson, Anthony); the chart borders stay purple with the glow, and the single chart page's
  chart takes the same purple glow (`--armed-ring`), only its order bar deep red.
- **Short header (1.14.0, Anthony):** a chart panel under 700 px wide or 400 px tall shows its header text as one quiet
  line (17 px: the name, bars, last price and change, the indicators' values); the bar's open, high, low, volume, the
  readouts and a hovered bubble come on a second line only while the crosshair is over the chart (the price scale does
  not move for it). A bigger panel shows the full header; `/single.html` always does.
- **Header text toggle (1.14.0):** **Aa** (`.lg-tog`, the header's 22 px button style, pressed = on) next to
  Indicators in each panel header and on `/single.html`. Off: no header text at all, not even on hover, nor the hovered
  bubble's; the price scale takes the room back with the 120 ms re-fit. Saved per chart (`live-legend-v1`).
- **The NO STOP question (1.13.0)** takes no room and is never modal, so nothing resizes or scrolls: on the single
  chart page a strip over the top centre of the chart (the ChartBridge alert's shape, the loss red border and title,
  a shadow); in the workspace a strip over the top bar from the left up to KEYS, one line, the text cut short with
  the whole of it in the tooltip (the `.ws-alert` shape). Cancel then Send, Send in the loss red; Cancel has the
  focus. It covers no order control (the order bar, KEYS, Flatten all, the ticket). The protection line's gap ("NO STOP on 1") is
  the loss red of the NO STOP tag.
- **The order ticket**: the order bar's own controls and colors (live.css) in a column, 6 px gaps, 28 px controls:
  instrument and account; Armed (the crimson switch, the ticket outlined in `--crimson-word` while Armed, 1.13.0); Qty with "max N" and the
  bracket preset; Bracket, stop, target and t / pt; Buy MKT and Sell MKT, half each; B/E, Close and Cancel all, a
  third each; then the position and P&L, the stop and target cover, the last fill (buy green, sell red), "Also open"
  lines in warn amber each with its Close, the account note, the Cancel all line and the notes line (11 px; warn and
  loss colors). It fits a 2 x 3 panel at 1366x768 without scrolling; a shorter panel scrolls inside. The placeholder
  in another window says "Ticket is in the other window" with Move the ticket here; with no ticket anywhere "No window
  has the ticket" with Use the ticket here.

- **4h, 1D and 1W (1.15.0, ChartBridge 0.3.7):** NinjaTrader's own bars (`htf`, the forming one by `htfBar` and the live
  trades' close, high and low), on their own row of the bars picker ("Needs ChartBridge 0.3.7 or newer", dashed, with an
  older one). No RTH shading or delta pane on them; VWAP (the session's, from the 1-minute bars) and levels on 4h; on 1D and
  1W no VWAP, levels or profile, and the chart's note says so. Daily labels as for daily bars.
- **History (1.15.0):** a 1 hour chart loads 30 days of 1-minute history, a 15 minute chart 10, the rest 5.
- **Account panel (1.15.0, Anthony's consolidated form):** a 28 px header (Account and the ticket's account in 500 11px mono),
  a summary strip of four (Open, Realized, Day in 600 14px mono in the buy green or sell red, Trades), tabs (600 11px,
  the selected one with a 2 px accent underline and a count badge), the rows (12px mono, a hairline `#121922` between, the
  only scroll), a quiet foot. Positions with a Close (the sell red border), Orders with an x, Fills with each flat-to-flat
  trade's P&L on the fill that went flat ("open", or "n/a" for a trade begun before today); its x cancels an order of any
  instrument (Armed). On a narrow panel (under 360 px)
  the summary goes two by two and each pair of columns stacks in one cell, so nothing is cut at 1366 px.
- **Quote board (1.15.0):** NQ and ES (1.16.0, Anthony 2026-10-05: the MNQ and MES rows went; display only): last, change and % from the prior settlement (buy green or sell red; blank
  without one), the session's high and low, in the same rows; under 400 px the change and %, and the high and low,
  stack; a 2 x 1 board shows the last, change and % (at 1366 px the last and %), the rest in the row's tooltip.
- **Text panels never cost the charts (Anthony's ruling for 1.15.0):** the Quote board's and the Account panel's figures
  are written at most 4 times a second, in one animation frame, only the cells that changed; a trade only notes the price.

## Honesty rules

- Anything not real is labelled on the chart (legend "sample data", SIM pill).
- Levels, VWAP, the Initial Balance and trade marks are computed from bars, never typed in. A level that cannot be
  computed exactly is not drawn (the IB says why on the status line).
- Served window (1.8.0): range bars are drawn only from the first bar proven to be NinjaTrader's own; before it the chart
  is empty and the status line says "Range bars start where they are proven to match NinjaTrader's" in the quiet grey.
  Range and seconds bars carry no VWAP while ChartBridge's session table is still building (legend "VWAP -"), and the
  profile's note reads "Volume profile building, from 10:45 ET" until it is whole.
