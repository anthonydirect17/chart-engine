# Anthony's chart style: the one chart for every project

**Anthony, 2026-09-29:** "that chart is so perfect, lock that in as our exact charting style for this and
all future projects." Then, after comparing engines: "Custom, and honestly I have to say, that is such a
fantastic chart. Thats what I want to actually trade on."

- **Source of truth:** this repo, `anthonydirect17/chart-engine`. The code wins over this page; copy
  values from `src/chart-engine.js`, do not re-derive them.
- **Engine:** the Custom Canvas 2D engine (decided 2026-09-29). Not Lightweight Charts.
- **Sits under** Anthony's `HOUSE_STYLE.md`. The design is Anthony's; do not "improve" it.

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

Presets: Carolina / purple (default), Mint / coral (`#4FD1A5` / `#F0717A`, the Chart lab v0 look),
House green / red (`#3DDC97` / `#FF7A7A`). Text drawn in a candle color is lightened until it reads
at 4.5:1 on the ground; the last-price tag picks dark or white text for its fill.

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
  prior close dotted 2/3). Name at the right edge of the plot; names within 12 px merge ("VAL · PDL").
  Each level gets an outlined tag on the price axis; tags push apart and grid labels hide under them.
  Tags never sit under the last-price tag: levels at or above the last price stack upward from it, the
  rest stack downward (since 1.2.1).
- **VWAP:** 1.5 px line at 90% opacity, restarting each session.
- **Trades:** entry triangle pointing the trade's way, exit dot, dashed line and chip ("+8.75 pt") in
  the result color. Chips step down so they never overlap.
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
- Switching timeframe keeps bar spacing and the live edge (or the time at the right edge).

## Honesty rules

- Anything not real is labelled on the chart (legend "sample data", SIM pill).
- Levels, VWAP and trade marks are computed from bars, never typed in.
