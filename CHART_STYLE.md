# Anthony's chart style: the one chart for every project

**Anthony, 2026-09-29:** "that chart is so perfect, lock that in as our exact charting style for this and
all future projects." Then, after comparing engines: "Custom, and honestly I have to say, that is such a
fantastic chart. Thats what I want to actually trade on."

- **Source of truth:** this repo, `anthonydirect17/chart-engine`. The code wins over this page; copy
  values from `src/chart-engine.js`, do not re-derive them.
- **Engine:** the Custom Canvas 2D engine (decided 2026-09-29). Not Lightweight Charts.
- **Sits under** Anthony's `HOUSE_STYLE.md`. The design is Anthony's; do not "improve" it.
- **Engine version:** 1.6.0 (1.5.3 added the 1-hour Initial Balance lines and the Background choice; on the
  default ground every color below is unchanged. 1.6.0 is the live page's Indicators menu "E2" and chip strip; the
  chart itself draws exactly as in 1.5.3).

## Colors

Candle colors are Anthony's choice and can be changed in the chart's **Colors** panel (presets and
pickers, saved per browser). Defaults:

| Use | Value |
|---|---|
| Bull candle and volume | `#4B9CD3` Carolina blue (volume at 26% opacity) |
| Bear candle and volume | `#6D28D9` deep purple (volume at 26% opacity) |
| VWAP | `#B69CFF` (also in the Colors panel) |
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
- **A clearly light ground takes the page light** (Anthony): only at 9:1 or more against `#080B10` (greys from
  `#B0B0B0` up, the Light preset). The toolbar, Indicators menu, Colors button and panel, and status line then take
  their colors from `chromeColors(theme)`: the ground, raised surfaces 5% and 10% toward the
  house near-black, borders 12% and 24%, text at 7:1 and secondary text, accents (deep purple `#6D28D9` on a light
  purple tint), warn and info at 4.5:1, each on the darkest surface it sits on. On the default, dark and mid grounds
  the page keeps the dark house style.
- **The order bar never changes with the ground:** on every ground it is exactly the 1.5.2 bar (dark `#0F151D` bar,
  green Buy, red Sell, the amber Armed switch and tint), on the house ground `#080B10`.
- Saved per browser with the other colors (`live-colors-v1`, one field at a time, per storage prefix, so The
  Desk's embedded chart keeps its own).

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
  - Its own Indicators entry, **Initial balance** (chip "IB"; "IB 1h" in 1.5.3), per pane: on for the main pane
    (also for a main pane saved before 1.5.3), off for a new pane. It is independent of Levels.
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
- Switching timeframe keeps bar spacing and the live edge (or the time at the right edge).
- Live page, **Indicators menu "E2"** (1.6.0, as Anthony approved it in the design canvas): one per chart pane, a
  `.btn` showing shown/on-this-chart ("4/5"), opening a 460 px panel (never wider than the pane) on `#0B1016` with a
  `#2A3645` border, radius 12, the Colors panel's shadow, padding 8:
  - Title "Indicators" (600 13px) and "4 shown, 1 hidden" (mono 11px `#8392A5`); a search box (34 px, `#0F151D`, a
    `#3B2A6B` border) with a "/" key cap, focused on open. It matches names and short names (vwap; ib ibh ibl; pdh pdl
    onh onl levels; vol volume; fills); Enter acts on the first match.
  - "Recent": the last 5 used (mono 11px outlined buttons); a click adds, shows or hides.
  - "On this chart" (caps mono 10px): every indicator on the pane, a row each (36 px): a switch (32 by 18; on: the
    accent tint with a `#B69CFF` knob) that shows or hides and keeps everything, the swatch (12 by 3, grey when hidden),
    the name (13px), a pin (star, filled `#B69CFF` when pinned) for the chip strip, a gear opening the one settings panel
    open at a time (`#0F151D`, what the indicator does, read only; Fills holds "Show fills from", the account choice
    that sat in the toolbar before 1.6.0), and an x that takes it off the chart.
  - The groups, folded, one open at a time: Price (VWAP, Levels, Initial balance), Volume (Volume bars; Volume
    profile tagged "coming", not selectable), Trades (Fills); a dashed + adds one. Then "Coming: cumulative delta,
    time and sales".
  - "Hide all (n)", which becomes "Restore" and brings back the same mix (not everything).
  - Keys: "/" opens the menu of the pane under the mouse (not while typing in a box, not with Ctrl, Alt or Cmd; no
    other key of the chart or the order bar uses it), arrows move through the menu, Escape or a click outside closes it
    and Escape puts the focus back where it was.
  - **Chip strip** next to the button: pinned indicators only, one click shows or hides. A chip is 30 px tall, mono
    600 11px: shown = `#141C26` with a solid `#2A3645` border and its color line; hidden = no fill, a dashed border,
    grey text and a grey line. When the chips do not fit on the toolbar line (a narrow pane) each becomes one letter
    (V W L I F) over its line, so the strip never wraps.
  - Saved per pane (`live-indicators-v2`). The main pane starts with the five on, shown and pinned (a pane saved by
    1.4 to 1.5.3 keeps its choices: the ones that were off stay on its chart, hidden); a new pane starts with none on
    (Anthony, 2026-09-29).
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
- The legend's source line names both versions: "NinjaTrader via ChartBridge 0.3.2 · chart 1.6.0" (1.5.1).

## Honesty rules

- Anything not real is labelled on the chart (legend "sample data", SIM pill).
- Levels, VWAP, the Initial Balance and trade marks are computed from bars, never typed in. A level that cannot be
  computed exactly is not drawn (the IB says why on the status line).
