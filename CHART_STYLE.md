# Anthony's chart style: the one chart for every project

**Anthony, 2026-09-29:** "that chart is so perfect, lock that in as our exact charting style for this and
all future projects." Then, after comparing engines: "Custom, and honestly I have to say, that is such a
fantastic chart. Thats what I want to actually trade on."

- **Source of truth:** this repo, `anthonydirect17/chart-engine`. The code wins over this page; copy
  values from `src/chart-engine.js`, do not re-derive them.
- **Engine:** the Custom Canvas 2D engine (decided 2026-09-29). Not Lightweight Charts.
- **Sits under** Anthony's `HOUSE_STYLE.md`. The design is Anthony's; do not "improve" it.
- **Engine version:** 1.9.0 (1.5.3 added the 1-hour Initial Balance lines and the Background choice; on the
  default ground every color below is unchanged. 1.6.0 is the live page's Indicators menu "E2" and chip strip; the
  chart itself draws exactly as in 1.5.3. 1.7.0 adds the cumulative delta pane below the chart; with it off the chart
  draws exactly as in 1.6.0. 1.9.0 adds color presets and indicator colors in the gears; with the default colors the
  chart draws exactly as in 1.7.0).

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
| Armed (live page only) | `#E0B45A` amber outline on the order bar and chart, ARMED pill |
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
  (4.5:1). Before 1.9.0 the bar never changed with the ground (review 2, B1); Anthony asked for it to follow. Only
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
  Levels (prior day, overnight, value area, prior close), Initial balance (high, low), Volume profile (point of
  control). The volume bars and the delta pane keep the candle colors; fills keep the house trade-side colors (no
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
- Right offset: 8 empty bars past the last bar. Default bar spacing 7 px; zoom range 0.6 to 48 px.
- Legend top-left over the chart, on `rgba(8,11,16,0.78)`, radius 8: symbol, timeframe, status pill;
  then time, O H L C, change and percent, volume; then VWAP and the trade under the cursor. It shows
  the bar under the crosshair, or the forming bar when the pointer is away. On phones it drops its
  secondary text and third row.

## Drawing

- **Candles:** body 72% of bar spacing, wick 1 device pixel, both snapped to device pixels. Below
  about 2.5 px spacing bodies collapse to the wick.
- **Grid:** price lines about every 52 px on 1 / 2 / 2.5 / 5 times a power of ten, in whole ticks.
  Time labels at least 84 px apart on round times; daily bars get month labels and dates.
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
  - Its own Indicators entry, **Initial balance** (chip "IB"; "IB 1h" in 1.5.3; its status notes read "Initial
    balance not shown: ..."), per pane: on for the main pane
    (also for a main pane saved before 1.5.3), off for a new pane. It is independent of Levels.
- **Volume profile (1.6.0; Anthony's ruling 2026-09-29):** the session's traded volume per price,
  1-tick rows, as horizontal bars from the right edge of the plot, in front of the grid and behind the volume bars,
  levels, VWAP and candles. The largest row (the POC) is 25% of the plot width (`VP_WIDTH`), the rest in proportion.
  Opaque fills: rows outside the value area `#141C26`, the 70% value area a step stronger `#212C3B`, the POC row in
  the value-level gold `#E0B45A`. On another ground the two row colors are mixed from the ground toward the ink
  (7% and 14%) and the POC moves until it reads at 3:1 on the value-area rows. Each row is its price span tall
  (price minus half a tick to plus half a tick) in whole device pixels, with a 1 px gap once rows are 4 px or taller;
  rows thinner than a pixel share it, the bar as long as the largest of them and the POC winning, so it always
  shows; the POC bar is at least 2 CSS px tall, centred on its row. Off by default on every pane; the Indicators menu adds it (Volume group), and its gear panel holds a Session (from 18:00 ET) or RTH (9:30:00 up to 16:00:00 ET, 13:00 on NYSE early-close days, none on
  weekends and NYSE holidays) choice. The last session's profile stays until the next session's first trade (1.6.1,
  Anthony's rulings 2026-09-30): the full session over weekends and NYSE holidays (on weekday evenings it moves at
  18:00 as before), RTH also through the weekday night until the next 9:30; for the ticks the page has (no more
  tick history is loaded for it); the IB keeps its own rule. Candles over the rows
  read lower than on the bare ground (default: bear 1.99:1 over the value area, 2.42:1 over the other rows); their
  floor there is open for Anthony. The legend adds "POC 26,150.50 · VA 26,101.50 to 26,289.50 (Fri)", the POC price
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
  `#8392A5` line at its first counted bar. With ChartBridge 0.3.3 or older only the title and "Delta needs ChartBridge
  0.3.4 on this PC" (500 12px Condensed, centered) are drawn. Legend: "Delta +12,345" (bull color above zero, bear
  below), "Bar delta +123" in bar mode, "Delta since 18:37:16.6 +1,234" for a later start ("Delta since 18:37:16.6, missed 32 s +1,234" after a gap), and "· 37 unknown" (the unknown
  side volume of the session, dim) when there is any. On by default on the main pane, without a chip (pin it from the
  menu for one); its own Indicators entry "Cumulative delta" (chip DELTA, letter D) in the Volume group.
- **VWAP:** 1.5 px line at 90% opacity, restarting each session.
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
- **Position (1.3.0):** a 1.5 px `#F2F6FA` line at 60% at the average price, a label "LONG 2  +3.50 pt
  +$14.00" (side word in the side color, P&L in the result color; points per contract, dollars for the
  position) and an outlined tag on the price axis.
- **Last price:** dotted line in the forming bar's color; filled tag with price and countdown to bar
  close. Each tick flashes the tag white (38%, fading over about 160 ms) and pulses a ring from the
  live dot (500 ms).
- **Crosshair:** dashed 4/4, snaps to the bar center, with price and date/time tags.

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

- Drag to pan and throw. Wheel or pinch zooms at the pointer; a sideways trackpad swipe pans.
- While following the live edge, zoom keeps the live edge in place. Panning away shows "Jump to live";
  End or the button returns.
- Drag the price axis to stretch price (auto-fit off; chart drag then pans price too). Double-click
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
  - The groups, folded, one open at a time: Price (VWAP, Levels, Initial balance), Volume (Volume bars, Volume
    profile, Cumulative delta), Trades (Fills); a dashed + adds one. Then "Coming: time and sales".
  - "Hide all (n)", which becomes "Restore" and brings back the same mix (not everything). Fills are included.
  - **The live trade always stays** (Anthony): hiding Fills (switch, chip or Hide all) hides past fills and trade
    marks, never the open trade: its entry fills stay marked, and the position line and label, working orders and
    stop and target lines are not indicators at all.
  - Keys: "/" opens the menu of this chart when the focus is inside it, or with nothing focused, of the chart under
    the mouse (not while typing in a box, not while anything outside the chart has the focus, not with Ctrl, Alt or
    Cmd; no other key of the chart or the order bar uses it); arrows move through the menu; Escape or a click outside
    closes it and Escape puts the focus back where it was.
  - The panel opens below the order bar when there is one (the Armed switch, the account and the position readout
    stay in view) and its list scrolls inside when the space is short.
  - **Chip strip** next to the button: pinned indicators only, at most 6 (Anthony): an added indicator gets a chip
    while there is room; pinning onto a full strip is refused with a note in the menu. One click shows or hides. A chip
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
  order bar (a mounted chart, or ChartBridge 0.2) a compact picker (600 12px mono) sits in the toolbar after the
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

## Honesty rules

- Anything not real is labelled on the chart (legend "sample data", SIM pill).
- Levels, VWAP, the Initial Balance and trade marks are computed from bars, never typed in. A level that cannot be
  computed exactly is not drawn (the IB says why on the status line).
- Served window (1.8.0): range bars are drawn only from the first bar proven to be NinjaTrader's own; before it the chart
  is empty and the status line says "Range bars start where they are proven to match NinjaTrader's" in the quiet grey.
  Range and seconds bars carry no VWAP while ChartBridge's session table is still building (legend "VWAP -"), and the
  profile's note reads "Volume profile building, from 10:45 ET" until it is whole.
